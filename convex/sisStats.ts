import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * Load attendance and grade statistics from the SIS.
 *
 * Both are full replacements per sync run rather than merges. A student who
 * drops a section must lose that section's grade row, and a merge cannot
 * express a deletion. Attendance is one row per student per term, so it is
 * upserted by student number.
 *
 * NOTHING HERE TOUCHES EARNED VALUE. These write their own tables; the
 * students table with its balances is not referenced.
 */
export const putAttendance = internalMutation({
  args: {
    syncedAt: v.string(),
    rows: v.array(
      v.object({
        studentNumber: v.string(),
        daysAbsentTerm: v.optional(v.number()),
        daysAbsentYtd: v.optional(v.number()),
        daysTardyTerm: v.optional(v.number()),
        attendanceRowsYtd: v.optional(v.number()),
        termFirstDay: v.optional(v.string()),
        termLastDay: v.optional(v.string()),
        termId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { rows, syncedAt }) => {
    const existing = await ctx.db.query("psAttendance").collect();
    const byNumber = new Map(existing.map((r) => [r.studentNumber, r]));
    let created = 0, updated = 0;
    for (const r of rows) {
      const prior = byNumber.get(r.studentNumber);
      if (prior) { await ctx.db.patch(prior._id, { ...r, syncedAt }); updated++; }
      else { await ctx.db.insert("psAttendance", { ...r, syncedAt }); created++; }
    }
    return { created, updated, received: rows.length };
  },
});

export const replaceGrades = internalMutation({
  args: {
    syncedAt: v.string(),
    clearFirst: v.optional(v.boolean()),
    rows: v.array(
      v.object({
        studentNumber: v.string(),
        sectionId: v.optional(v.string()),
        courseNumber: v.optional(v.string()),
        courseName: v.optional(v.string()),
        currentGrade: v.optional(v.string()),
        currentPercent: v.optional(v.number()),
        gradeSource: v.optional(v.string()),
        lastGradeUpdate: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { rows, syncedAt, clearFirst }) => {
    let deleted = 0;
    if (clearFirst) {
      // take(), not collect(). Convex allows 4,096 reads per execution and
      // collect() reads every row, so this broke the moment the COURSES join
      // fix grew psGrades from 3,805 rows to 5,812. Same failure as
      // psSync.clearRoster and found the same way: the sync threw, and because
      // a run is recorded only on success, nothing was written down.
      //
      // The caller passes clearFirst on the first chunk only and keeps calling
      // until `remaining` is "none", so a table larger than one batch still
      // clears completely.
      const old = await ctx.db.query("psGrades").take(2000);
      for (const r of old) { await ctx.db.delete(r._id); deleted++; }
      const more = await ctx.db.query("psGrades").take(1);
      if (more.length > 0) {
        // Deliberately does NOT insert on a pass that did not finish clearing.
        // Inserting now would mix this term's rows with last term's leftovers,
        // and the result reads as real data rather than as an error.
        return { inserted: 0, deleted, remaining: "some" };
      }
    }
    for (const r of rows) await ctx.db.insert("psGrades", { ...r, syncedAt });
    return { inserted: rows.length, deleted, remaining: "none" };
  },
});

/** Coverage report. Counts only, never a value. */
export const stats = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roster = await ctx.db.query("psRoster").collect();
    const att = await ctx.db.query("psAttendance").collect();
    const grades = await ctx.db.query("psGrades").collect();
    const students = await ctx.db.query("students").collect();
    return {
      rosterRows: roster.length,
      rosterStudents: new Set(roster.map((r) => r.studentNumber)).size,
      rosterSections: new Set(roster.map((r) => r.sectionId)).size,
      rosterTeachers: new Set(roster.map((r) => r.teacherEmail).filter(Boolean)).size,
      attendanceRows: att.length,
      gradeRows: grades.length,
      // A grade row with no percent is a known gap, not a zero. Counted so the
      // gap is visible rather than rendered as 0%.
      gradeRowsMissingPercent: grades.filter((g) => g.currentPercent === undefined).length,
      appStudents: students.length,
      lastSyncedAt: roster[0]?.syncedAt ?? null,
    };
  },
});

/**
 * Read only. Answers one question before anybody deletes anything:
 * is the students table double counting the same children?
 *
 * WHY THIS EXISTS. sisSync matches an incoming roster row to an existing
 * student by `studentNumber ?? legacyId`. A student imported from the old CSV
 * carries a legacyId like "STU001" and NO studentNumber. The SIS sends
 * studentNumber "11414". Those keys do not match, so the sync inserts a
 * SECOND row for a child who is already there: the legacy row keeps the
 * balance, and the new SIS row starts at zero.
 *
 * That matters enormously for what to do next. If the money is sitting on the
 * legacy rows, then "delete everything that came from the CSV" deletes the
 * Wildcat Cash with it. The duplicates have to be MERGED, not dropped.
 *
 * Returns counts and money only. Set sampleNames to see a handful of the
 * suspected pairs; it is off by default so a routine run prints no names.
 */
export const duplicateAudit = internalQuery({
  args: { sampleNames: v.optional(v.boolean()) },
  handler: async (ctx, { sampleNames }) => {
    const students = await ctx.db.query("students").collect();

    const norm = (s: { firstName?: string; lastName?: string; grade?: string }) =>
      `${(s.firstName ?? "").trim().toLowerCase()}|${(s.lastName ?? "").trim().toLowerCase()}|${(s.grade ?? "").trim()}`;

    const money = (s: { wildcatCashBalance?: number }) => s.wildcatCashBalance ?? 0;

    const sisMatched = students.filter((s) => !!s.studentNumber);
    const legacyOnly = students.filter((s) => !s.studentNumber);
    const archived = students.filter((s) => !!s.archivedAt);

    // Same person, more than one row.
    const byIdentity = new Map<string, typeof students>();
    for (const s of students) {
      const k = norm(s);
      if (!byIdentity.has(k)) byIdentity.set(k, []);
      byIdentity.get(k)!.push(s);
    }
    const dupeGroups = [...byIdentity.entries()].filter(([, rows]) => rows.length > 1);

    // The decisive number: money held on rows the SIS has never matched.
    const strandedMoney = legacyOnly.reduce((n, s) => n + money(s), 0);

    return {
      totalStudents: students.length,
      archived: archived.length,
      active: students.length - archived.length,

      sisMatched: sisMatched.length,
      legacyOnly: legacyOnly.length,

      duplicateIdentities: dupeGroups.length,
      rowsInvolvedInDuplicates: dupeGroups.reduce((n, [, rows]) => n + rows.length, 0),
      // A duplicate pair where one side holds money and the other does not is
      // the signature of the legacyId / studentNumber mismatch above.
      duplicatesWhereOnlyOneSideHasMoney: dupeGroups.filter(([, rows]) => {
        const withMoney = rows.filter((r) => money(r) > 0).length;
        return withMoney > 0 && withMoney < rows.length;
      }).length,

      totalBalance: students.reduce((n, s) => n + money(s), 0),
      balanceOnSisMatched: sisMatched.reduce((n, s) => n + money(s), 0),
      balanceOnLegacyOnly: strandedMoney,

      sampleDuplicates: sampleNames
        ? dupeGroups.slice(0, 10).map(([k, rows]) => ({
            identity: k,
            rows: rows.map((r) => ({
              legacyId: r.legacyId ?? null,
              studentNumber: r.studentNumber ?? null,
              balance: money(r),
              archivedAt: r.archivedAt ?? null,
            })),
          }))
        : undefined,
    };
  },
});

/**
 * Load restricted demographics into psRestricted.
 *
 * SEPARATE FROM EVERY OTHER SYNC WRITE, on purpose. These are the fields the
 * brief names restricted, and keeping them out of the students table means a
 * view that forgets to check policy cannot accidentally return them: they are
 * not on the row it is reading.
 *
 * Full replace, like grades. A student who is corrected in PowerSchool from
 * two race codes to one must LOSE the extra, and a merge cannot express a
 * deletion. Getting this wrong makes the app permanently more certain about a
 * child's race than the SIS is.
 *
 * Race codes are one to many and are stored as an array, never collapsed. A
 * multi-race student is multi-race; flattening them to "Two or more" is a
 * reporting decision this school has not made.
 */
export const replaceRestricted = internalMutation({
  args: {
    syncedAt: v.string(),
    rows: v.array(
      v.object({
        studentNumber: v.string(),
        fedEthnicity: v.optional(v.string()),
        elaStatus: v.optional(v.string()),
        raceCodes: v.optional(v.array(v.string())),
      }),
    ),
    clearFirst: v.optional(v.boolean()),
  },
  handler: async (ctx, { syncedAt, rows, clearFirst }) => {
    let cleared = 0;
    if (clearFirst) {
      const existing = await ctx.db.query("psRestricted").collect();
      for (const row of existing) {
        await ctx.db.delete(row._id);
        cleared++;
      }
    }

    let written = 0;
    for (const row of rows) {
      if (!row.studentNumber) continue;
      await ctx.db.insert("psRestricted", {
        studentNumber: row.studentNumber,
        fedEthnicity: row.fedEthnicity,
        elaStatus: row.elaStatus,
        raceCodes: row.raceCodes,
        syncedAt,
      });
      written++;
    }
    return { cleared, written };
  },
});
