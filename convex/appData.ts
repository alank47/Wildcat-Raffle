import { query, mutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff } from "./identity";
import {
  toAppStudent,
  toAppTeacher,
  planSave,
  STUDENT_WRITABLE,
  TEACHER_WRITABLE,
} from "./appDataShape";

/**
 * The app's data layer. Two functions, replacing one Firestore document.
 *
 * script.js used to read and write `raffle_data/main`, a single document
 * holding students, teachers and twenty settings fields. `load` returns that
 * same shape and `save` accepts it, so the 19,981 lines of app code in
 * between do not change: only the transport does.
 *
 * WHY THIS IS SAFER THAN WHAT IT REPLACES
 *
 * 1. The browser cannot reach a table. It calls these two functions, and both
 *    authenticate first. The Firestore database is world readable and world
 *    writable to anyone holding the project id, which ships in the page source.
 * 2. Writes are per field. The Firestore save replaced the entire document, so
 *    a stale tab overwrote everything it did not know about. That cost 38 staff
 *    emails on 2026-08-11. See mergeIncoming in appDataShape.ts.
 * 3. The whole handler is one transaction. runTransaction was hand-rolling
 *    what Convex does by construction.
 *
 * The browser NEVER creates a student. The SIS owns the roster, so an incoming
 * student the database has not seen is ignored rather than inserted. That is
 * the difference between a typo in a spreadsheet import and 200 phantom
 * children with balances.
 */

/** Where the app's non entity settings live. See the note on SETTINGS_KEY. */
const SETTINGS_KEY = "liveSettings";

/**
 * The twenty odd fields that rode along in the Firestore document beside the
 * two entity arrays: currentWeek, cycleDuration, pbisSubcategories and the
 * rest. They are a singleton blob, so they live in one appState row.
 *
 * appState already existed for the legacy mirror and has exactly the right
 * shape (key, value, timestamp), so this reuses it under its own key rather
 * than adding a second near-identical table. Its timestamp column is named
 * `mirroredAt` for historical reasons; for this key it means "last written".
 */

export const load = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);

    const [studentRows, teacherRows, settingsRow, rosterRows] = await Promise.all([
      ctx.db.query("students").collect(),
      ctx.db.query("teachers").collect(),
      ctx.db
        .query("appState")
        .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
        .unique(),
      ctx.db.query("psRoster").collect(),
    ]);

    // WHO IS ACTUALLY ENROLLED RIGHT NOW.
    //
    // The students table holds 734 people and the current term's roster holds
    // 646. The other 88 are prior year students who have not been deleted,
    // deliberately: a student who transferred out still has a balance, and a
    // roster gap is not proof a person ceased to exist.
    //
    // psRoster is replaced wholesale on every sync and only ever contains the
    // term being synced, so membership in it IS current enrolment. That is a
    // better test than archivedAt, which is only written when a sync runs with
    // archiveMissing enabled and is currently set on nobody.
    const enrolledNumbers = new Set(rosterRows.map((r) => r.studentNumber));

    // Every student is still RETURNED, each flagged. Filtering here would hide
    // a departed student's balance from the only UI that can see it. The app
    // decides what to display, and the students table shows the enrolled.
    return {
      students: studentRows.map((row) => ({
        ...toAppStudent(row),
        enrolled: Boolean(row.studentNumber && enrolledNumbers.has(row.studentNumber)),
      })),
      teachers: teacherRows.map(toAppTeacher),
      settings: (settingsRow?.value as Record<string, unknown>) ?? {},
      counts: {
        students: studentRows.length,
        teachers: teacherRows.length,
        archivedStudents: studentRows.filter((s) => s.archivedAt).length,
      },
      serverTime: new Date().toISOString(),
    };
  },
});

/**
 * What `load` WOULD return, as counts and totals only.
 *
 * internalQuery, so it is unreachable from a browser and needs the deploy key.
 * It exists because verifying `load` any other way means temporarily removing
 * its auth gate, and a gate that gets commented out to test it is a gate that
 * eventually ships commented out.
 *
 * Returns no names, no emails and no student numbers: only shapes and sums, so
 * it is safe to paste into a terminal, a commit message or a runbook.
 */
export const loadSelfCheck = internalQuery({
  args: {},
  handler: async (ctx) => {
    const [studentRows, teacherRows, settingsRow] = await Promise.all([
      ctx.db.query("students").collect(),
      ctx.db.query("teachers").collect(),
      ctx.db
        .query("appState")
        .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
        .unique(),
    ]);

    const students = studentRows.map(toAppStudent);
    const teachers = teacherRows.map(toAppTeacher);
    const rosterRows = await ctx.db.query("psRoster").collect();
    const enrolledSet = new Set(rosterRows.map((r) => r.studentNumber));
    const enrolledCount = studentRows.filter(
      (r) => r.studentNumber && enrolledSet.has(r.studentNumber),
    ).length;
    const sum = (key: string) =>
      students.reduce((total, s) => total + (Number(s[key]) || 0), 0);

    return {
      students: students.length,
      studentsWithAnId: students.filter((s) => s.id).length,
      studentsWithAName: students.filter((s) => String(s.name).trim()).length,
      studentsWithEmail: students.filter((s) => s.email).length,
      archivedStudents: students.filter((s) => s.archivedAt).length,
      enrolledNow: enrolledCount,
      notEnrolled: students.length - enrolledCount,

      teachers: teachers.length,
      teachersWithEmail: teachers.filter((t) => t.email).length,
      teachersWithAnId: teachers.filter((t) => t.id).length,

      // The number that must never move without somebody meaning it to.
      wildcatCashBalance: sum("wildcatCashBalance"),
      cashBalance: sum("cashBalance"),
      pbisTickets: sum("pbisTickets"),

      settingsKeys: settingsRow ? Object.keys(settingsRow.value ?? {}).length : 0,
    };
  },
});

export const save = mutation({
  args: {
    students: v.optional(v.array(v.any())),
    teachers: v.optional(v.array(v.any())),
    settings: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await requireStaff(ctx);

    // The plan is computed by a pure function that is unit tested against
    // hostile payloads (unknown ids, renamed children, nulled balances). This
    // handler only applies it, so the dangerous decisions are not made behind
    // an auth gate that a test cannot reach.
    let studentsChanged = 0;
    let skipped: string[] = [];
    if (args.students?.length) {
      const rows = await ctx.db.query("students").collect();
      const plan = planSave(rows, args.students, STUDENT_WRITABLE, (r) => [
        r.legacyId,
        r.studentNumber,
      ]);
      for (const { rowId, patch } of plan.patches) {
        await ctx.db.patch(rowId as any, patch);
        studentsChanged++;
      }
      skipped = plan.skipped;
    }

    let teachersChanged = 0;
    if (args.teachers?.length) {
      const rows = await ctx.db.query("teachers").collect();
      const plan = planSave(rows, args.teachers, TEACHER_WRITABLE, (r) => [
        r.legacyId,
        String(r._id),
      ]);
      for (const { rowId, patch } of plan.patches) {
        await ctx.db.patch(rowId as any, patch);
        teachersChanged++;
      }
    }

    let settingsChanged = false;
    if (args.settings !== undefined && args.settings !== null) {
      const row = await ctx.db
        .query("appState")
        .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
        .unique();
      const now = new Date().toISOString();
      if (row) {
        if (JSON.stringify(row.value) !== JSON.stringify(args.settings)) {
          await ctx.db.patch(row._id, { value: args.settings, mirroredAt: now });
          settingsChanged = true;
        }
      } else {
        await ctx.db.insert("appState", {
          key: SETTINGS_KEY,
          value: args.settings,
          mirroredAt: now,
        });
        settingsChanged = true;
      }
    }

    return {
      studentsChanged,
      teachersChanged,
      settingsChanged,
      // Named rather than counted. A silent skip is how a save appears to work
      // while quietly doing nothing, and the caller needs to be able to tell
      // "nothing changed" from "I did not recognise any of these students".
      skippedUnknownStudents: skipped.length,
      skippedSample: skipped.slice(0, 5),
    };
  },
});
