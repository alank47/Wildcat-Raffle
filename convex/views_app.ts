import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff, requireStudentSelf, requireAdmin } from "./identity";
import { restrictedFor } from "./restrictedPolicy";
import { sisNumberKey, sisEmailKey, gradeCell } from "./studentPortalRules";
import { teacherRosterEmail } from "./rosterEmail";
import { studentView } from "./views";

/**
 * The three reads the app actually needs.
 *
 *   teacherRoster   staff  -> their own sections and the students in them
 *   myStudentView   student -> their own points, cash and grades
 *   (drill-down lives in studentDetail.ts)
 *
 * Every one is an allowlist. Restricted fields are absent from these tables
 * entirely AND stripped by policy, so there are two independent reasons a
 * teacher cannot see a student's IEP status here.
 *
 * "Not available" is expressed as null, never as 0. The brief, Phase 6 point 3:
 * a student with no gradebook percent must not appear to have 0%.
 */

/** How many cash movements a student's own card carries. */
const RECENT_CASH = 15;

/**
 * The address to look this person's SECTIONS up under, with the database
 * lookup the pure rule needs.
 *
 * The decision itself is teacherRosterEmail in rosterEmail.ts, tested there
 * against the cases that matter. This adds only the one question it cannot
 * answer on its own: does any staff record sign in as that address?
 *
 * ASKED ON EVERY READ, deliberately. setPowerSchoolEmail refuses a claimed
 * address at write time too, but an address that is unclaimed the day it is
 * set can be claimed later -- a new hire, an old account re-enabled -- and a
 * write-time check cannot see that coming. Checked here, the patch stops
 * working the moment the address belongs to somebody, which is the moment it
 * would otherwise start handing out their roster.
 */
async function rosterEmailFor(
  ctx: { db: any },
  teacher: { email: string; psEmail?: string },
): Promise<{ email: string; via: string | null; refused: boolean }> {
  const alt = (teacher.psEmail ?? "").trim().toLowerCase();

  const owner = alt && alt !== teacher.email
    ? await ctx.db
        .query("teachers")
        .withIndex("by_email", (q: any) => q.eq("email", alt))
        .first()
    : null;

  const decision = teacherRosterEmail(teacher, Boolean(owner));
  if (decision.refused) {
    console.warn(
      `[roster] refusing psEmail ${alt} for ${teacher.email}: that address belongs to a staff record.`,
    );
  }
  return decision;
}

/** Staff: my sections, my students, with their totals. */
export const teacherRoster = query({
  args: {},
  handler: async (ctx) => {
    const teacher = await requireStaff(ctx);
    const policy = restrictedFor(teacher.role);

    const lookup = await rosterEmailFor(ctx, teacher);

    const rows = await ctx.db
      .query("psRoster")
      .withIndex("by_teacherEmail", (q) => q.eq("teacherEmail", lookup.email))
      .collect();

    // One lookup per distinct student, not per enrollment row.
    const numbers = [...new Set(rows.map((r) => r.studentNumber))];
    const students = new Map<string, any>();
    for (const num of numbers) {
      const s = await ctx.db
        .query("students")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", num))
        .unique();
      if (s) students.set(num, s);
    }

    const sections = new Map<string, any>();
    for (const r of rows) {
      const key = r.sectionId ?? `${r.courseNumber}-${r.sectionNumber}`;
      if (!sections.has(key)) {
        sections.set(key, {
          sectionId: key,
          courseName: r.courseName ?? null,
          courseNumber: r.courseNumber ?? null,
          period: r.period ?? r.sectionExpression ?? null,
          term: r.termAbbreviation ?? null,
          students: [],
        });
      }
      const s = students.get(r.studentNumber);
      sections.get(key).students.push({
        studentNumber: r.studentNumber,
        firstName: r.firstName,
        lastName: r.lastName,
        gradeLevel: r.gradeLevel ?? null,
        // Totals so a teacher can see who is close to qualifying.
        totalTickets: s
          ? s.pbisTickets + s.attendanceTickets + s.academicTickets
          : null,
        wildcatCashBalance: s?.wildcatCashBalance ?? null,
        // null, not 0: no record is not the same as no tickets.
        hasAppRecord: Boolean(s),
      });
    }

    return {
      teacher: { name: teacher.name, role: teacher.role },
      sectionCount: sections.size,
      studentCount: numbers.length,
      sections: [...sections.values()],
      // Named so a substitution is never silent. No screen renders these yet;
      // the app logs them, and they are what a console or the Convex logs are
      // read for when somebody asks why a teacher has the classes they have.
      // Do not remove them to tidy up -- the whole risk in psEmail is a roster
      // arriving from an address nobody knew about.
      rosterEmail: lookup.email,
      rosterVia: lookup.via,
      rosterViaRefused: lookup.refused,
      restricted: {
        // Told plainly rather than silently omitted, so a teacher knows data
        // exists and is withheld rather than assuming it is missing.
        visibleToYou: policy.allowed,
        withheld: policy.denied,
      },
    };
  },
});

/**
 * ADMIN ONLY: another member of staff's roster, for teacher view.
 *
 * WHY THIS DUPLICATES teacherRoster INSTEAD OF SHARING A HELPER.
 *
 * teacherRoster answers from the CALLER'S token and takes no arguments, which
 * is correct: any teacher may run it and none of them may name someone else.
 * That is also why teacher view could not show a teacher's own students — the
 * question has no way to say who it is about.
 *
 * The obvious move is to extract a shared body and have both call it. That
 * body is the query every teacher's Award Cash depends on, and this was added
 * three weeks before launch. A bug introduced while refactoring it would break
 * the roster for fifty staff on the day, to save forty duplicated lines. When
 * there is time to verify the extraction properly, do it then; not now.
 *
 * requireAdmin, NOT requireStaff with a role check. Get this wrong and any
 * teacher can read any other teacher's roster.
 *
 * NO NEW EXPOSURE. Admins are already campus-wide and see every student. The
 * shape returned is identical to teacherRoster's, which is an allowlist with
 * no restricted field in it, and the policy block below is computed for the
 * ADMIN doing the looking rather than for the teacher being looked at: this is
 * an admin reading, and saying otherwise would misreport who saw what.
 */
export const teacherRosterFor = query({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const admin = await requireAdmin(ctx);
    const policy = restrictedFor(admin.role);

    const target = String(email ?? "").trim().toLowerCase();
    if (!target) {
      return {
        teacher: { name: null, role: null },
        sectionCount: 0, studentCount: 0, sections: [],
        restricted: { visibleToYou: policy.allowed, withheld: policy.denied },
        viewedBy: { role: admin.role },
        reason: "No email given for the staff member to look at.",
      };
    }

    const staffRow = await ctx.db
      .query("teachers")
      .withIndex("by_email", (q) => q.eq("email", target))
      .unique();

    // The same psEmail rule teacherRoster uses, so teacher view previews what
    // that teacher actually gets rather than an empty screen they do not have.
    const lookupFor = staffRow
      ? await rosterEmailFor(ctx, staffRow)
      : { email: target, via: null, refused: false };

    const rows = await ctx.db
      .query("psRoster")
      .withIndex("by_teacherEmail", (q) => q.eq("teacherEmail", lookupFor.email))
      .collect();

    const numbers = [...new Set(rows.map((r) => r.studentNumber))];
    const students = new Map<string, any>();
    for (const num of numbers) {
      const s = await ctx.db
        .query("students")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", num))
        .unique();
      if (s) students.set(num, s);
    }

    const sections = new Map<string, any>();
    for (const r of rows) {
      const key = r.sectionId ?? `${r.courseNumber}-${r.sectionNumber}`;
      if (!sections.has(key)) {
        sections.set(key, {
          sectionId: key,
          courseName: r.courseName ?? null,
          courseNumber: r.courseNumber ?? null,
          period: r.period ?? r.sectionExpression ?? null,
          term: r.termAbbreviation ?? null,
          students: [],
        });
      }
      const s = students.get(r.studentNumber);
      sections.get(key).students.push({
        studentNumber: r.studentNumber,
        firstName: r.firstName,
        lastName: r.lastName,
        gradeLevel: r.gradeLevel ?? null,
        totalTickets: s
          ? s.pbisTickets + s.attendanceTickets + s.academicTickets
          : null,
        wildcatCashBalance: s?.wildcatCashBalance ?? null,
        hasAppRecord: Boolean(s),
      });
    }

    return {
      teacher: { name: staffRow?.name ?? null, role: staffRow?.role ?? null },
      sectionCount: sections.size,
      studentCount: numbers.length,
      sections: [...sections.values()],
      restricted: { visibleToYou: policy.allowed, withheld: policy.denied },
      // Recorded so the browser can label the view honestly: an admin looked,
      // and the server answered as an admin.
      viewedBy: { role: admin.role },
      // A staff member with no roster rows is not an error. It is the usual
      // reason a teacher reports empty class periods, and it is the answer
      // teacher view exists to give.
      reason: rows.length === 0
        ? "No PowerSchool roster rows for this address. Either they teach no sections this term, or their PowerSchool teacher_email does not match this address."
        : null,
    };
  },
});

/**
 * Student: my points, my cash, my grades, my schedule. Only ever my own.
 *
 * ONE student boundary for the whole app. This used to re-implement
 * requireStudentSelf inline (classify the identity, look the row up by email,
 * throw its own message). Two copies of a security boundary is how they drift:
 * the day a rule is added to the real one, an archived student, a second
 * student domain, a disabled account, this copy keeps the old behaviour and
 * nothing fails, because both still return a student.
 *
 * WHAT IS MISSING IS RETURNED AS MISSING, WITH THE REASON, the same shape
 * passCard.mine uses. A blank grades panel is indistinguishable from a broken
 * one; a panel that says the student number is not on the account yet is a fact
 * the office can act on, and it is the honest answer rather than a query nobody
 * should run. See studentPortalRules.ts for why an empty join key is refused
 * instead of looked up.
 */
/**
 * A version string for everything a student's dashboard shows.
 *
 * WHAT IT IS FOR. The portal already polls for the hall pass, because that is
 * the card a student stands at a doorway holding. Nothing watched the rest, so
 * a sync could land at 06:00 and a Chromebook left open since yesterday would
 * still be showing yesterday's grades until somebody pressed reload. This is
 * what the poll compares to notice.
 *
 * ONE ROW, DELIBERATELY. It reads the newest sync run and nothing else, so it
 * costs the same whether a student has three classes or nine, and it is the
 * same answer for every student in the school. Building it from the student's
 * own rows would mean reading their whole gradebook every fifteen seconds to
 * find out it had not changed.
 *
 * The trade that buys: a sync refreshes EVERY open dashboard, including ones
 * whose own data did not change. That is the right way round. A student seeing
 * a screen redraw with the same numbers has lost nothing; a student reading a
 * grade that moved two hours ago has.
 *
 * requireStudentSelf, like every other query in this file. A version string is
 * not sensitive, but an unauthenticated endpoint is a door, and this one would
 * be a door that reports when the school's data changes.
 */
export const myDataVersion = query({
  args: {},
  handler: async (ctx) => {
    await requireStudentSelf(ctx);
    const latest = await ctx.db.query("syncRuns").withIndex("by_at").order("desc").first();
    return {
      // null, not "", when no sync has ever run. The client treats an absent
      // version as "nothing to compare" and does not reload, which is right:
      // reloading on every poll because there is no answer is worse than not
      // reloading at all.
      syncedAt: latest?.at ?? null,
    };
  },
});

export const myStudentView = query({
  args: {},
  handler: async (ctx) => {
    const student = await requireStudentSelf(ctx);

    const number = sisNumberKey(student);
    const email = sisEmailKey(student);

    // FAIL CLOSED. No key, no query. eq("studentNumber", "") is a real bucket
    // lookup that returns whichever rows carry an empty number, which is a
    // different child's grades rendered as this child's.
    const gradeRows = number.ok
      ? await ctx.db
          .query("psGrades")
          .withIndex("by_studentNumber", (q) => q.eq("studentNumber", number.value))
          .collect()
      : [];

    const missingWork = number.ok
      ? await ctx.db
          .query("psMissingWork")
          .withIndex("by_studentNumber", (q) => q.eq("studentNumber", number.value))
          .collect()
      : [];

    // .first(), not .unique(). putAttendance upserts one row per student number,
    // so a second row is a data fault, and .unique() answers a data fault by
    // throwing a PLAIN Error, which Convex redacts to "Server Error" in
    // production. That would take the student's whole portal down, every panel,
    // over a duplicate attendance row. Showing one row is wrong in a way a human
    // can see; showing nothing at all is not.
    const attendance = number.ok
      ? await ctx.db
          .query("psAttendance")
          .withIndex("by_studentNumber", (q) => q.eq("studentNumber", number.value))
          .first()
      : null;

    // THE SCHEDULE JOINS ON EMAIL, not on the student number.
    //
    // me:get reads psRoster through by_studentEmail, because the address is what
    // the verified token actually proves; this read used to use by_studentNumber.
    // Two keys for one sign-in means one student can have two different
    // schedules, and whichever screen they opened decided which one was true.
    // Worse, the number key is derived from the app's own record rather than
    // from the token, so a wrong number in `students` shows a real, complete,
    // entirely wrong timetable, with another child's teachers on it.
    const rosterRows = email.ok
      ? await ctx.db
          .query("psRoster")
          .withIndex("by_studentEmail", (q) => q.eq("studentEmail", email.value))
          .collect()
      : [];

    return {
      name: `${student.firstName} ${student.lastName}`.trim(),
      grade: student.grade ?? null,

      points: {
        pbis: student.pbisTickets,
        attendance: student.attendanceTickets,
        academic: student.academicTickets,
        total:
          student.pbisTickets + student.attendanceTickets + student.academicTickets,
        // null, never 0. All four of these are OPTIONAL in schema.ts, and this
        // file's own header says absence is expressed as null because "a student
        // with no gradebook percent must not appear to have 0%". The same
        // sentence is far more serious about money: wildcatCashBalance is
        // SPENDABLE, and a field dropped by a sync or a partial write would show
        // a child a balance of $0 that is indistinguishable from having spent it.
        // The teacherRoster view four functions up already gets this right.
        weeksQualified: student.weeksQualified ?? null,
        bigRaffleEntries: student.bigRaffleQualified.length,
      },

      wildcatCash: {
        balance: student.wildcatCashBalance ?? null,
        earned: student.wildcatCashEarned ?? null,
        spent: student.wildcatCashSpent ?? null,

        /**
         * The last few movements, so a balance is explainable.
         *
         * A number with no history is one a child cannot question. "It says
         * $30 and I thought I had $40" has no answer without this, and the
         * answer is usually a deduction they did not know about.
         *
         * FIELD BY FIELD, NOT THE STORED ROW. A transaction carries
         * teacherId, teacherUsername, studentGrade and school, none of which
         * belong in a student's own view. teacherName stays, because "who
         * gave me this" is the first thing they will ask and hiding it helps
         * nobody.
         *
         * Newest first, capped: this is a card on a phone, not a ledger.
         */
        recent: (student.wildcatCashTransactions ?? [])
          .slice(-RECENT_CASH)
          .reverse()
          .map((t: any) => ({
            at: t?.timestamp ?? null,
            kind: t?.kind ?? null,
            amount: typeof t?.amount === "number" ? t.amount : null,
            // What it was for. behaviorName is the award reason; notes is what
            // the adult typed. Both are shown, because "Being Responsible" and
            // "helped a new student find C wing" say different things.
            reason: t?.behaviorName || null,
            note: t?.notes || null,
            by: t?.teacherName || null,
            balanceAfter: typeof t?.balanceAfter === "number" ? t.balanceAfter : null,
          })),
      },

      grades: {
        available: number.ok,
        reason: number.reason,
        // gradeCell, not an inline map. The inline version tested
        // `currentGrade !== undefined`, which passes for "" and rendered an
        // empty string as a grade. See studentPortalRules.gradeCell.
        // sectionId rides ALONGSIDE gradeCell rather than inside it. gradeCell
        // is a pure rule with its own tests about what counts as a posted
        // grade; a section id is routing, not grading, and widening it to carry
        // one would make those tests answer a question they were not asked.
        courses: gradeRows.map((r) => ({ ...gradeCell(r), sectionId: r.sectionId ?? null })),
        // Missing work, grouped by the section it belongs to, so a course row
        // can open its own list without the client re-grouping and without
        // shipping another student's rows to reach this one.
        //
        // `available` is its own flag, separate from grades.available. The two
        // fail independently: a student can have grades and no missing-work
        // sync, and a course with an empty list has genuinely nothing missing.
        // Collapsing them would make "nothing missing" and "we did not look"
        // render identically, which is the failure this file exists to avoid.
        missingWork: {
          available: number.ok && missingWork.length >= 0,
          bySection: missingWork.reduce((acc, m) => {
            const key = m.sectionId ?? "__nosection__";
            (acc[key] ??= []).push({
              assignmentSectionId: m.assignmentSectionId,
              name: m.assignmentName ?? null,
              dueDate: m.dueDate ?? null,
              // null, never 0. A section can score by something other than
              // points, and "worth 0" tells a student it does not matter.
              pointsPossible: m.pointsPossible ?? null,
              courseName: m.courseName ?? null,
              categoryName: m.categoryName ?? null,
              isLate: m.isLate ?? false,
            });
            return acc;
          }, {} as Record<string, unknown[]>),
          total: missingWork.length,
        },
      },

      attendance: {
        // Three states, not two. `available: false` is "we cannot look this up",
        // `available: true` with nulls is "looked up, nothing on file". Collapsing
        // them into one empty panel is how a student concludes they have no
        // absences when the truth is that nobody knows.
        available: number.ok,
        reason: number.reason,
        daysAbsentTerm: attendance?.daysAbsentTerm ?? null,
        daysAbsentYtd: attendance?.daysAbsentYtd ?? null,
        daysTardyTerm: attendance?.daysTardyTerm ?? null,
      },

      schedule: {
        available: email.ok,
        reason: email.reason,
        // The tested allowlist from views.ts, not a second hand-rolled map. It
        // drops the state student number, both email addresses and every
        // restricted column, and views.test.mjs asserts that against a row
        // carrying all of them.
        classes: rosterRows.map(studentView),
      },

      // Brief Phase 6 point 2: every screen shows where the data came from and when.
      dataAsOf: rosterRows[0]?.syncedAt ?? attendance?.syncedAt ?? null,
    };
  },
});
