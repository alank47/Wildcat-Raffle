import { query, mutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
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

    const [studentRows, teacherRows, settingsRow, rosterRows, cutoffRow] = await Promise.all([
      ctx.db.query("students").collect(),
      ctx.db.query("teachers").collect(),
      ctx.db
        .query("appState")
        .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
        .unique(),
      ctx.db.query("psRoster").collect(),
      ctx.db
        .query("appState")
        .withIndex("by_key", (q) => q.eq("key", "historyCutoff"))
        .unique(),
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
      // THE SAME CUTOFF THE SAVE ENFORCES, HANDED TO THE CLIENT TO READ WITH.
      //
      // `save` refuses history rows dated before this, which keeps the database
      // clean. It does not clean a BROWSER. The load-time merge in script.js
      // overlays the local copy of `wildcatCashTransactions` on top of the
      // server's, so a tab whose localStorage predates a history clear
      // resurrects those rows into its own ledger on every boot and shows them
      // in analytics -- indefinitely, because the reload that was supposed to
      // fix it re-reads the same localStorage first. The client applies this
      // number with the same rule and the same hour of slack, so both ends
      // agree about what counts as history.
      historyCutoff: (cutoffRow?.value as Record<string, unknown> | undefined)?.iso ?? null,
    };
  },
});

/**
 * The two numbers the stale-tab watchdog compares against, and nothing else.
 *
 * WHAT IT GUARDS. A teacher leaves the Hub open on Friday. Another teacher ends
 * the week. The first tab still holds last week's `currentWeek`, and its next
 * save writes that stale number back over the new one. The watchdog in
 * script.js polls this every minute and reloads the tab when the server has
 * moved ahead.
 *
 * WHY IT IS ITS OWN QUERY AND NOT `load`. It runs once a minute in every open
 * tab, forever. `load` reads every student, every teacher and the whole roster
 * to answer it, which is a few hundred kilobytes to compare two integers. This
 * reads one settings row.
 *
 * WHY IT RETURNS NULLS RATHER THAN ZEROS. A fresh deployment has no settings
 * row. Zero would read as "the server is on week 0", which is behind every tab
 * and therefore silent; null says "no answer" and the caller does nothing. The
 * watchdog only ever acts on the server being AHEAD, so an absent answer must
 * never look like a low one.
 */
export const freshness = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);

    const settingsRow = await ctx.db
      .query("appState")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .unique();

    const settings = (settingsRow?.value as Record<string, unknown>) ?? {};
    const cycle = settings.currentCycle as { cycleNumber?: unknown } | undefined;

    const num = (x: unknown) => (typeof x === "number" ? x : null);

    return {
      currentWeek: num(settings.currentWeek),
      cycleNumber: num(cycle?.cycleNumber),
      // The save path's staleness check reads this: a tab whose last save is
      // far behind the server's has been open across somebody else's save and
      // must reload before writing, or it overwrites their work with its own
      // stale copy of everything. Null for the same reason as the two above —
      // "no answer" must never compare as "older than every tab".
      lastSaveTimestamp: num(settings.lastSaveTimestamp),
      // The two id counters, so a save can take the max against what the server
      // actually holds rather than against what this tab loaded. They only ever
      // go up; a tab that has been open since before somebody else issued a
      // detention id must not hand that id out a second time.
      referralIdCounter: num(settings.referralIdCounter),
      detentionIdCounter: num(settings.detentionIdCounter),
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

/**
 * What a save WOULD do, against the real rows, writing nothing.
 *
 * internalQuery, so it needs the deploy key and cannot be reached from a
 * browser. It exists because the shadow write failing is SILENT by design: the
 * Firestore transaction has already committed, so the browser logs and moves
 * on, and the only symptom is a drift number hours later.
 *
 * Pass a student key and a value and it reports whether planSave would find the
 * row and what it would patch. That turns "the write did not land" into either
 * "the row was never matched" or "the patch was empty".
 */
export const savePlanDryRun = internalQuery({
  args: {
    key: v.string(),
    pbisTickets: v.optional(v.number()),
    // THE CASH RULE, ASKABLE AGAINST PRODUCTION WITHOUT WRITING TO IT.
    //
    // Added 2026-09-13. A browser may MOVE a cash counter by a stated delta
    // and may never SET one, and a delta may not drive one below zero. Both
    // rules live in planPatch, which this query already calls through
    // planSave -- so passing the shape a stale tab sends answers "would that
    // land" from the deployed code rather than from reading it.
    //
    // `balance` is the absolute value a stale tab would send. `delta` is what a
    // current tab sends. Send balance alone to reproduce the 2026-09-13
    // incident; send a large negative delta to reproduce its inverted form.
    balance: v.optional(v.number()),
    delta: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("students").collect();
    const record: Record<string, unknown> = {
      id: args.key,
      pbisTickets: args.pbisTickets ?? 99,
    };
    if (args.balance !== undefined) record.wildcatCashBalance = args.balance;
    if (args.delta !== undefined) record.cashDelta = { wildcatCashBalance: args.delta };
    const incoming = [record];
    const plan = planSave(rows, incoming, STUDENT_WRITABLE, (r) => [r.legacyId, r.studentNumber]);

    const matched = rows.find(
      (r) => r.legacyId === args.key || r.studentNumber === args.key,
    );
    return {
      totalRows: rows.length,
      rowMatched: Boolean(matched),
      storedBalance: matched ? (matched as any).wildcatCashBalance ?? null : null,
      // The whole point: what the patch WOULD set, if anything. Absent means
      // the server refused to touch the balance.
      wouldSetBalance: plan.patches.length && "wildcatCashBalance" in plan.patches[0].patch
        ? (plan.patches[0].patch as any).wildcatCashBalance
        : "(refused - balance left alone)",
      cashCountersIgnored: plan.countersIgnored,
      matchedBy: matched
        ? matched.legacyId === args.key
          ? "legacyId"
          : "studentNumber"
        : null,
      currentPbis: matched?.pbisTickets ?? null,
      patches: plan.patches.length,
      patch: plan.patches[0]?.patch ?? null,
      skipped: plan.skipped,
      // How many rows even HAVE each key, which is the thing that silently
      // breaks matching after a migration.
      rowsWithLegacyId: rows.filter((r) => r.legacyId).length,
      rowsWithStudentNumber: rows.filter((r) => r.studentNumber).length,
    };
  },
});

/**
 * READ ONLY THE ROWS A SAVE IS ABOUT.
 *
 * This used to collect() the whole students table, 734 rows, before planning
 * a save that patches a handful of them. A Convex mutation is a serializable
 * transaction: if any row it READ was written by a mutation that committed
 * first, it is thrown away and retried. Reading every student made every
 * teacher's save conflict with every other teacher's save by construction,
 * not by chance. With forty tabs saving on a launch morning they queued behind
 * one another and retried into exactly the "slow, or never landed" that was
 * reported on 2026-09-08.
 *
 * Looking each incoming record up by its key reads only the rows this save can
 * touch, so two teachers awarding different students no longer conflict at
 * all, and two awarding the same student conflict on that one row. planSave is
 * unchanged: it is handed the rows that were found and still decides, field by
 * field, what to write. A key that finds nothing is reported as skipped, as
 * before; the browser never creates a student.
 */
async function lookupStudents(ctx: MutationCtx, incoming: Array<Record<string, any>>) {
  const found = new Map<string, Record<string, any>>();
  for (const record of incoming ?? []) {
    const key = String(record?.id ?? record?.studentNumber ?? "");
    if (!key) continue;
    let row = await ctx.db
      .query("students")
      .withIndex("by_legacyId", (q) => q.eq("legacyId", key))
      .first();
    if (!row) {
      row = await ctx.db
        .query("students")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", key))
        .first();
    }
    if (row && !found.has(String(row._id))) found.set(String(row._id), row);
  }
  return [...found.values()];
}

/** Same rule for staff: the record's id is a row id or a Firestore-era T-number. */
async function lookupTeachers(ctx: MutationCtx, incoming: Array<Record<string, any>>) {
  const found = new Map<string, Record<string, any>>();
  for (const record of incoming ?? []) {
    const key = String(record?.id ?? "");
    if (!key) continue;
    let row: Record<string, any> | null = null;
    const asId = ctx.db.normalizeId("teachers", key);
    if (asId) row = await ctx.db.get(asId);
    if (!row) {
      row = await ctx.db
        .query("teachers")
        .withIndex("by_legacyId", (q) => q.eq("legacyId", key))
        .first();
    }
    if (row && !found.has(String(row._id))) found.set(String(row._id), row);
  }
  return [...found.values()];
}

export const save = mutation({
  args: {
    students: v.optional(v.array(v.any())),
    teachers: v.optional(v.array(v.any())),
    settings: v.optional(v.any()),
    // WHICH BUILD IS ASKING. Added 2026-09-13 so the server can refuse a save
    // from a client too old to state its cash deltas.
    //
    // AND DECLARED, which is the whole bug this comment exists for: the client
    // began sending it and this validator did not list it. Convex rejects a
    // mutation carrying an argument its validator does not declare, so for the
    // life of that deploy EVERY save failed at the boundary -- cash awards,
    // referrals, settings, all of it -- with the teacher seeing "NOT saved
    // yet" and the queue retrying forever. Shipped at v=20260913i and caught
    // hours later by a pre-launch review, not by the test suite.
    //
    // null is accepted because the client sends `APP_VERSION || null`, and a
    // tab that cannot read its own version tag must still be able to save.
    clientVersion: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    await requireStaff(ctx);

    // The plan is computed by a pure function that is unit tested against
    // hostile payloads (unknown ids, renamed children, nulled balances). This
    // handler only applies it, so the dangerous decisions are not made behind
    // an auth gate that a test cannot reach.
    let studentsChanged = 0;
    let skipped: string[] = [];
    let countersIgnored: string[] = [];
    if (args.students?.length) {
      const rows = await lookupStudents(ctx, args.students);
      // THE SERVER'S HISTORY CUTOFF, read here and passed down.
      //
      // legacyData:mergeSlice enforces the same cutoff for the cash_tx_*
      // ledger and the referrals. The per-student wildcatCashTransactions
      // arrays arrive through THIS mutation instead, which the first version
      // of the guard did not cover -- so 330 pre-launch rows were back on 348
      // students within hours of it being armed, and reconcileCashLedger feeds
      // them into the ledger the analytics counts.
      //
      // Owned by the server, never sent by the client: a stale client having
      // no say is the whole point.
      const cutoffRow = await ctx.db
        .query("appState")
        .withIndex("by_key", (q) => q.eq("key", "historyCutoff"))
        .unique();
      const cutoffIso = (cutoffRow?.value as Record<string, unknown> | undefined)?.iso;
      const parsed = typeof cutoffIso === "string" ? Date.parse(cutoffIso) : NaN;
      const historyCutoff = Number.isFinite(parsed) ? parsed : null;

      const plan = planSave(rows, args.students, STUDENT_WRITABLE, (r) => [
        r.legacyId,
        r.studentNumber,
      ], historyCutoff);
      for (const { rowId, patch } of plan.patches) {
        await ctx.db.patch(rowId as any, patch);
        studentsChanged++;
      }
      skipped = plan.skipped;
      countersIgnored = plan.countersIgnored;
    }

    let teachersChanged = 0;
    if (args.teachers?.length) {
      const rows = await lookupTeachers(ctx, args.teachers);
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
      // COUNTERS THE SERVER REFUSED TO SET, named for the same reason
      // skippedUnknownStudents is counted rather than swallowed.
      //
      // A browser may move a cash counter by a delta and may never set one.
      // Where it tried to set one, or tried to move one below zero, the
      // counter was left alone and the student is named here. The client logs
      // it loudly: a save that quietly drops a teacher's award is worse than
      // the resurrection this rule exists to prevent, because the
      // resurrection was at least visible in the totals.
      cashCountersIgnored: countersIgnored.length,
      cashCountersIgnoredSample: countersIgnored.slice(0, 5),
    };
  },
});
