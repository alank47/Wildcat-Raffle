import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { requireStaff, requireIdentity, requireAdmin } from "./identity";
import { canViewStudent } from "./accessRules";
import { studentSisView, staffAttendanceView } from "./views";
import { readBehaviorForStudent } from "./psBehavior";
import {
  attendancePanel,
  cashPanel,
  emailPanel,
  splitSchedule,
  staffNumberKey,
  textOrNull,
} from "./studentProfileRules";

/**
 * Drill-down on one student: who they are, what they earned, what the SIS knows
 * about them, and what none of us know about them.
 *
 * Access follows Grilled.md: classroom teachers see their OWN roster only,
 * administrators see wider scope. "Wider" is deliberately expressed as a role
 * check rather than "everything", so the day the brief enumerates a narrower
 * admin scope there is one place to put it.
 *
 * The roster relationship is derived from psRoster, which is SIS truth, rather
 * than from anything a teacher can edit about themselves.
 *
 * EVERY PANEL THAT CAN BE EMPTY RETURNS A REASON, in the
 * `{ available: false, reason }` shape passCard.ts uses. This screen is read
 * standing over a desk with the student watching, which is exactly the wrong
 * place to show a zero that means "we were never told". studentProfileRules.ts
 * owns those decisions and studentProfileRules.test.mjs asserts them.
 *
 * RESTRICTED DEMOGRAPHICS ARE NOT HERE and are not one edit away from being
 * here. Federal ethnicity, federal race, IEP, 504 and English Learner are
 * denied to every role by restrictedPolicy.ts, are not in psRoster or
 * psAttendance at all, and the three allowlists this file returns through
 * cannot express them.
 */
export const get = query({
  args: { studentNumber: v.string() },
  handler: async (ctx, { studentNumber }) => {
    const teacher = await requireStaff(ctx);

    // The CLASSIFIED identity, not a literal and not the teacher record. This is
    // the value that makes the behavior audience gate a real check: an earlier
    // draft of this wiring passed the string "staff", which made the gate return
    // allowed unconditionally while a test certified that students were denied.
    // requireStaff has already thrown for anyone who is not staff, so this costs
    // one extra classify() and buys a gate that cannot be decorated.
    const id = await requireIdentity(ctx);

    // A blank argument is refused BEFORE it reaches an index.
    // `withIndex("by_studentNumber", q => q.eq("studentNumber", ""))` is not a
    // no-op: it is a real bucket that returns whatever an upstream import wrote
    // with an empty number. Trimmed first, so " " is treated as the missing
    // argument it is rather than looked up as a space.
    const asked = textOrNull(studentNumber);
    if (!asked) {
      throw new ConvexError(
        "No student number was given, so no student was looked up. An empty " +
          "number is a real index bucket in Convex and would return whichever " +
          "records an import wrote without one.",
      );
    }

    const student = await ctx.db
      .query("students")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", asked))
      .unique();

    if (!student) throw new ConvexError(`No student with number ${asked}.`);

    // Every roster row for this student, used both for the access decision and
    // for the schedule itself. One read, two purposes.
    const rows = await ctx.db
      .query("psRoster")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", asked))
      .collect();

    const verdict = canViewStudent(
      { email: teacher.email, role: teacher.role },
      rows.map((r) => ({ teacherEmail: r.teacherEmail })),
    );
    if (!verdict.allowed) throw new ConvexError(verdict.reason);

    // The key for the per-student SIS tables, taken from the RECORD rather than
    // from the argument.
    //
    // In practice this cannot fail for a caller that reached here: the student
    // was found BY that number through by_studentNumber, so it is present. It is
    // still a checked key rather than a `!` for the reason sisEmailKey gives in
    // studentPortalRules.ts: the thing being prevented is an indexed read on an
    // OPTIONAL column, and "the caller proves it upstream" is exactly the kind
    // of invariant that survives until someone adds a second way to resolve a
    // student, by email or by legacy id, and does not notice these three reads.
    // It also gives the panels below one uniform way to say "no key, no query".
    const key = staffNumberKey(student);
    const number = key.ok ? key.value : asked;

    // .first(), not .unique(). putAttendance upserts one row per student number,
    // so a second row is a data fault, and .unique() answers a data fault by
    // throwing a PLAIN Error, which Convex REDACTS to "Server Error" in
    // production. That would take the whole drill-down down, every panel, over a
    // duplicate attendance row. views_app.ts makes the same call for the same
    // reason.
    const attendanceRow = key.ok
      ? await ctx.db
          .query("psAttendance")
          .withIndex("by_studentNumber", (q) => q.eq("studentNumber", number))
          .first()
      : null;

    // The schedule, through the tested allowlist, split so Promise Time can be
    // shown as its own card. Promise Time is the school's advisory period and is
    // the section a teacher actually goes looking for, so it does not get to be
    // row four of seven.
    const schedule = splitSchedule(key, rows.map(studentSisView));

    return {
      identity: {
        studentNumber: student.studentNumber ?? student.legacyId ?? null,
        firstName: student.firstName,
        lastName: student.lastName,
        grade: textOrNull(student.grade),
        school: student.school ?? null,
        // An envelope rather than a bare string. A blank line where an address
        // goes reads as a broken page; "not synced yet, the office can check
        // Student Profile > Email" is a fact somebody can act on.
        email: emailPanel(student),
        // The cafeteria / meal number behind the meal card's barcode. Shown here
        // so the office can see and, through setMealPin below, correct it.
        mealPin: textOrNull(student.mealPin),
        archivedAt: student.archivedAt ?? null,
      },

      // Earned value, read only in this view. Nothing here is editable through
      // a drill-down; awarding and deducting are their own audited actions.
      //
      // The ticket counts are REQUIRED columns and are arithmetic the app
      // performs, so they are numbers. The cash figures were `?? 0` here and are
      // not any more: they are optional columns holding SPENDABLE money, and an
      // unrecorded student showed a balance indistinguishable from one they had
      // earned and spent. See the `cash` panel below, which is what the UI
      // reads.
      earned: {
        pbisTickets: student.pbisTickets,
        attendanceTickets: student.attendanceTickets,
        academicTickets: student.academicTickets,
        totalTickets:
          student.pbisTickets + student.attendanceTickets + student.academicTickets,
        weeksQualified: student.weeksQualified ?? null,
        bigRaffleQualified: student.bigRaffleQualified,
      },

      /** Spendable money, so it is a panel with a reason and never a zero. */
      cash: cashPanel(student),

      // SIS data, through an allowlist. psRoster deliberately holds no
      // restricted field (federal ethnicity, federal race, IEP, 504, English
      // Learner), so a drill-down cannot surface one even by accident.
      //
      // The `{ count, rows, lastSyncedAt }` convention is kept: `schedule.classes`
      // carries count and rows, and lastSyncedAt sits beside it.
      sis: {
        scheduleCount: rows.length,
        schedule: schedule.classes,
        promiseTime: schedule.promiseTime,
        lastSyncedAt: rows[0]?.syncedAt ?? null,
      },

      // Days absent and tardy. THREE states, not two: no key, no row, and real
      // numbers. "No attendance data" is not "no absences", and the two are
      // indistinguishable on screen unless the difference is carried here.
      attendance: attendancePanel(
        key,
        attendanceRow ? staffAttendanceView(attendanceRow) : null,
      ),

      // SIS behavior. Staff only, and only after canViewStudent above has
      // already said this caller may look at this child. behaviorAudienceFor
      // inside readBehaviorForStudent owns the staff-yes/students-no decision;
      // there is deliberately no second copy of it in this file.
      //
      // Three distinct states: "denied", "unknown" (no sync has ever covered a
      // window, which is the state TODAY because psBehaviorLog is not declared
      // in schema.ts yet) and "covered". Only the third may be rendered as a
      // number. A student with no behavior record must not read as a clean one.
      behavior: await readBehaviorForStudent(ctx, id, number),

      viewedAs: { role: teacher.role, scope: verdict.scope },
    };
  },
});

/**
 * Correct a student's meal (cafeteria) number, the value behind the meal card
 * barcode. Admin only: this is identity data the office owns, not something a
 * class teacher edits from a drill-down. An empty value clears it. Stored as
 * typed (the ID cards print a bare 4-digit number), length-bounded only, so a
 * transposed digit is the office's to catch rather than the app's to reformat.
 */
export const setMealPin = mutation({
  args: { studentNumber: v.string(), mealPin: v.string() },
  handler: async (ctx, { studentNumber, mealPin }) => {
    await requireAdmin(ctx);
    const asked = textOrNull(studentNumber);
    if (!asked) throw new ConvexError("No student number was given.");
    const student = await ctx.db
      .query("students")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", asked))
      .unique();
    if (!student) throw new ConvexError(`No student with number ${asked}.`);
    const clean = String(mealPin ?? "").trim();
    if (clean.length > 24) {
      throw new ConvexError("That is too long to be a meal number. Check the digits and try again.");
    }
    await ctx.db.patch(student._id, { mealPin: clean || undefined });
    return { ok: true, studentNumber: asked, mealPin: clean || null };
  },
});

/**
 * THIS CHILD'S OWN DAILY PASS CAP, set from Student Snapshot.
 *
 * It used to be written into the browser's roster array and saved to the old
 * Firestore document, where the only thing that ever read it was the deleted
 * kiosk. A teacher could set "2 passes a day", see it saved, and watch the
 * child take eight. It lives on the student record now and canRequest enforces
 * it on both the student's own request and a teacher-opened pass.
 *
 * null CLEARS it (back to the school-wide cap only). 0 is a real value meaning
 * no passes at all, so the two cannot be the same argument.
 */
export const setPassLimit = mutation({
  args: { studentNumber: v.string(), limit: v.union(v.number(), v.null()) },
  handler: async (ctx, { studentNumber, limit }) => {
    const staff = await requireStaff(ctx);
    // KEYED ON THE NUMBER, not on a Convex id: the teacher portal's roster is
    // loaded through appData and carries the student NUMBER, not the row id,
    // so an id argument could only ever be filled in by guessing.
    const key = String(studentNumber ?? "").trim();
    const matches = await ctx.db
      .query("students")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", key))
      .take(2);
    if (matches.length === 0) throw new ConvexError(`No student has the number ${key}.`);
    if (matches.length > 1) {
      throw new ConvexError(
        `More than one student record has the number ${key}, so the limit was not set. ` +
          `Fix the duplicate first.`,
      );
    }
    const student = matches[0];
    const studentId = student._id;
    if (limit !== null) {
      if (!Number.isFinite(limit) || limit < 0 || limit > 50 || Math.floor(limit) !== limit) {
        throw new ConvexError("A daily limit is a whole number from 0 to 50, or blank to clear it.");
      }
    }
    await ctx.db.patch(studentId, {
      dailyPassLimit: limit === null ? undefined : limit,
    });
    return {
      ok: true,
      studentNumber: student.studentNumber ?? null,
      limit: limit,
      setBy: staff.email,
    };
  },
});
