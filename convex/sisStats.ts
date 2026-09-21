import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * Has a student's attendance actually moved since the row we hold?
 *
 * Pure, and exported so a test exercises THIS rather than a restatement of it.
 *
 * ALL THREE FIGURES, and in BOTH DIRECTIONS. Absences year-to-date, absences
 * this term and tardies this term each matter on their own -- a child who is
 * present but always late never appears in an absence count, which is why
 * Attendance Watch already keeps tardies as a separate axis. And a DECREASE is
 * a change: PowerSchool corrects an absence sometimes, and a correction is a
 * real event on a child's record rather than noise to suppress.
 *
 * ABSENT AND ZERO COMPARE EQUAL, deliberately. A field PowerSchool stops
 * sending must not read as "changed to nothing" and append a row every sync
 * forever.
 */
export function attendanceMoved(
  prior: Record<string, any> | null | undefined,
  next: Record<string, any>,
): boolean {
  if (!prior) return false;
  const n = (x: unknown) => Number(x) || 0;
  return (
    n(prior.daysAbsentYtd) !== n(next.daysAbsentYtd) ||
    n(prior.daysAbsentTerm) !== n(next.daysAbsentTerm) ||
    n(prior.daysTardyTerm) !== n(next.daysTardyTerm)
  );
}

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
    const observedOn = String(syncedAt).slice(0, 10);
    let created = 0, updated = 0, appended = 0;
    for (const r of rows) {
      const prior = byNumber.get(r.studentNumber);

      // HISTORY, APPENDED BEFORE THE OVERWRITE.
      //
      // This row is about to be replaced, and until now that is all that ever
      // happened: the figure moved and the previous one was gone. So a child
      // with three absences could not be told apart from a child with three
      // absences last week, which is the difference an early-warning system is
      // made of. psAttendanceHistory in schema.ts has the full account.
      //
      // ZERO EXTRA READS: `prior` is already in hand from the collect above,
      // so the comparison is free and only a genuine change writes a row.
      // A DECREASE COUNTS AS A CHANGE -- PowerSchool corrects an absence
      // sometimes, and a correction is a real event on a child's record.
      if (prior && attendanceMoved(prior, r)) {
        await ctx.db.insert("psAttendanceHistory", {
          studentNumber: r.studentNumber,
          observedOn,
          daysAbsentYtd: r.daysAbsentYtd,
          daysAbsentTerm: r.daysAbsentTerm,
          daysTardyTerm: r.daysTardyTerm,
          termFirstDay: r.termFirstDay,
          termId: r.termId,
          syncedAt,
        });
        appended++;
      }

      if (prior) { await ctx.db.patch(prior._id, { ...r, syncedAt }); updated++; }
      else {
        await ctx.db.insert("psAttendance", { ...r, syncedAt });
        // A STUDENT THE APP HAS NEVER SEEN gets their starting point recorded
        // now, so their series has a first point rather than beginning at
        // whatever their second observation happens to be.
        await ctx.db.insert("psAttendanceHistory", {
          studentNumber: r.studentNumber,
          observedOn,
          daysAbsentYtd: r.daysAbsentYtd,
          daysAbsentTerm: r.daysAbsentTerm,
          daysTardyTerm: r.daysTardyTerm,
          termFirstDay: r.termFirstDay,
          termId: r.termId,
          syncedAt,
          baseline: true,
        });
        appended++;
        created++;
      }
    }
    return { created, updated, received: rows.length, historyAppended: appended };
  },
});

/**
 * Give every student already on file a starting point, once.
 *
 * WHY A SEPARATE ONE-OFF. putAttendance appends only when a figure MOVES,
 * which is right for every sync after the first -- but on the first sync after
 * this shipped, every one of the 679 students already had a psAttendance row,
 * so an unchanged student would have got no row at all and their series would
 * begin at whatever their next absence happened to be. This writes the "as of
 * today, here is where everybody stands" point that the change-appends hang
 * off.
 *
 * PAGED, and SKIPS ANYONE WHO ALREADY HAS HISTORY, so running it twice is
 * harmless and running it later cannot overwrite a real series with a flat
 * baseline. Call until `remaining` is 0.
 */
export const seedAttendanceHistory = internalMutation({
  args: { limit: v.optional(v.number()), apply: v.optional(v.boolean()) },
  handler: async (ctx, { limit, apply }) => {
    const take = Math.min(Math.max(1, Number(limit) || 200), 400);
    const rows = await ctx.db.query("psAttendance").take(1000);
    let seeded = 0, alreadyHad = 0, looked = 0;
    for (const r of rows) {
      if (seeded >= take) break;
      looked++;
      const has = await ctx.db
        .query("psAttendanceHistory")
        .withIndex("by_student", (q) => q.eq("studentNumber", r.studentNumber))
        .first();
      if (has) { alreadyHad++; continue; }
      if (apply === true) {
        await ctx.db.insert("psAttendanceHistory", {
          studentNumber: r.studentNumber,
          observedOn: String(r.syncedAt).slice(0, 10),
          daysAbsentYtd: r.daysAbsentYtd,
          daysAbsentTerm: r.daysAbsentTerm,
          daysTardyTerm: r.daysTardyTerm,
          termFirstDay: r.termFirstDay,
          termId: r.termId,
          syncedAt: r.syncedAt,
          baseline: true,
        });
      }
      seeded++;
    }
    // NO SILENT CAP. take(1000) is a read-limit guard, not a claim about the
    // table; if psAttendance ever outgrows it the rows past 1000 would never
    // be seeded and `remaining` would still reach 0. Say so out loud instead.
    const truncated = rows.length >= 1000;
    return {
      applied: apply === true,
      onFile: rows.length, looked, alreadyHad, truncated,
      seeded, remaining: Math.max(0, rows.length - alreadyHad - (apply === true ? seeded : 0)),
      note: truncated
        ? "PARTIAL: psAttendance has at least 1000 rows and only the first 1000 are visible here. Seed the rest another way."
        : apply === true ? "Seeded. Call again until remaining is 0." : "Dry run. Pass apply: true.",
    };
  },
});

/**
 * Is the attendance series still growing?
 *
 * WHY THIS EXISTS. The whole value of psAttendanceHistory is in the appends,
 * and a sync that quietly stopped appending would look exactly like a calm
 * fortnight: no error, no gap anyone would notice, just a series that stops.
 * By the time an early-warning indicator read flat it would be months of
 * trajectory gone, and it cannot be backfilled. So this answers, cheaply,
 * "when was the last time this table learned anything".
 *
 * NO collect() ANYWHERE, ON PURPOSE. This table grows all year. An unbounded
 * read is the exact failure that broke clearRoster and the grade sync once
 * psGrades passed Convex's 4,096 reads, and both were invisible because a run
 * is only recorded on success. This walks the by_observedOn index newest-first,
 * stops as soon as it has the days asked for, and says when it hit its cap.
 */
export const attendanceHistoryHealth = internalQuery({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => {
    const want = Math.min(Math.max(1, Number(days) || 14), 60);
    const SCAN_CAP = 3000;
    const byDay = new Map<string, { rows: number; changes: number; baselines: number }>();
    const students = new Set<string>();
    let scanned = 0, capped = false;
    for await (const doc of ctx.db.query("psAttendanceHistory").withIndex("by_observedOn").order("desc")) {
      const day = String(doc.observedOn || "");
      if (!byDay.has(day) && byDay.size >= want) break;
      if (scanned >= SCAN_CAP) { capped = true; break; }
      scanned++;
      const bucket = byDay.get(day) || { rows: 0, changes: 0, baselines: 0 };
      bucket.rows++;
      if (doc.baseline === true) bucket.baselines++; else bucket.changes++;
      byDay.set(day, bucket);
      students.add(String(doc.studentNumber || ""));
    }
    const dayList = [...byDay.entries()]
      .map(([observedOn, b]) => ({ observedOn, ...b }))
      .sort((a, b) => (a.observedOn < b.observedOn ? 1 : -1));
    return {
      newestDay: dayList.length ? dayList[0].observedOn : null,
      oldestDayScanned: dayList.length ? dayList[dayList.length - 1].observedOn : null,
      daysWithData: dayList.length,
      studentsSeen: students.size,
      // Baselines are the one-off starting points; CHANGES are the signal.
      // A run of days with 0 changes means either a calm school or a sync that
      // has stopped appending, and those are worth telling apart by hand.
      changesScanned: dayList.reduce((n, d) => n + d.changes, 0),
      baselinesScanned: dayList.reduce((n, d) => n + d.baselines, 0),
      days: dayList,
      scanned, capped,
      note: capped
        ? `PARTIAL: stopped at ${SCAN_CAP} rows, so the oldest day shown may be incomplete.`
        : "Complete for the days shown.",
    };
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

/**
 * Replace every missing-work row. Same batched-clear contract as replaceGrades.
 *
 * WHOLESALE REPLACE, NOT AN UPSERT, and the reason matters more here than for
 * grades: a row must DISAPPEAR the moment a teacher clears the missing flag. An
 * append or an upsert-by-key leaves a student staring at work they handed in
 * last week, which is the one failure that would make them stop trusting the
 * card entirely.
 */
export const replaceMissingWork = internalMutation({
  args: {
    syncedAt: v.string(),
    clearFirst: v.optional(v.boolean()),
    rows: v.array(
      v.object({
        studentNumber: v.string(),
        assignmentSectionId: v.string(),
        assignmentName: v.optional(v.string()),
        dueDate: v.optional(v.string()),
        pointsPossible: v.optional(v.number()),
        sectionId: v.optional(v.string()),
        courseName: v.optional(v.string()),
        categoryName: v.optional(v.string()),
        isLate: v.optional(v.boolean()),
        // KEEP IN STEP WITH THE SCHEMA. A field added to psMissingWork in
        // schema.ts but not here is rejected at the boundary with
        // ArgumentValidationError and the WHOLE sync fails -- which is what
        // happened on 2026-09-05 when these two were added. The schema being
        // permissive does not make the mutation permissive.
        scorePoints: v.optional(v.number()),
        totalPointValue: v.optional(v.number()),
        isMissing: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, { rows, syncedAt, clearFirst }) => {
    let deleted = 0;
    if (clearFirst) {
      // take(), not collect(), for the reason written out in replaceGrades: a
      // collect() over a table that outgrows the 4,096-read limit throws, and a
      // sync that throws records nothing.
      const old = await ctx.db.query("psMissingWork").take(2000);
      for (const r of old) { await ctx.db.delete(r._id); deleted++; }
      const more = await ctx.db.query("psMissingWork").take(1);
      if (more.length > 0) {
        // Does not insert on a pass that did not finish clearing: mixing this
        // sync's rows with the last one's would show work that is no longer
        // missing, and it would look like real data rather than an error.
        return { inserted: 0, deleted, remaining: "some" };
      }
    }
    for (const r of rows) await ctx.db.insert("psMissingWork", { ...r, syncedAt });
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
    const restricted = await ctx.db.query("psRestricted").collect();
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
      // Demographics. COUNTS ONLY: this is an operational check that the load
      // ran, and it must not become a way to read the data it is counting.
      restrictedStudents: restricted.length,
      restrictedWithRace: restricted.filter((r) => (r.raceCodes ?? []).length > 0).length,
      restrictedWithEthnicity: restricted.filter((r) => r.fedEthnicity).length,
      // Distinct code values with counts. AGGREGATE ONLY, and it exists to
      // answer one operational question: which codes does this instance
      // actually use. PowerSchool RACECD values are district configurable, so
      // guessing the labels would put a wrong race name on a chart.
      raceCodeCounts: restricted.reduce((acc: Record<string, number>, r) => {
        for (const c of r.raceCodes ?? []) acc[c] = (acc[c] ?? 0) + 1;
        return acc;
      }, {}),
      ethnicityCounts: restricted.reduce((acc: Record<string, number>, r) => {
        if (r.fedEthnicity) acc[r.fedEthnicity] = (acc[r.fedEthnicity] ?? 0) + 1;
        return acc;
      }, {}),
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

/**
 * Which race codes this instance actually uses, and how many students carry
 * each. COUNTS ONLY, no student rows.
 *
 * Exists because the codes are school configured. PowerSchool ships federal
 * categories but an instance can define its own, so mapping a code to a label
 * by assuming the federal set is how a chart ends up confidently mislabelling
 * a group of children. Measure, then map.
 */
export const raceCodesInUse = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("psRestricted").collect();
    const codes: Record<string, number> = {};
    const ethnicities: Record<string, number> = {};
    for (const r of rows) {
      for (const c of r.raceCodes ?? []) codes[c] = (codes[c] ?? 0) + 1;
      if (r.fedEthnicity) ethnicities[r.fedEthnicity] = (ethnicities[r.fedEthnicity] ?? 0) + 1;
    }
    return {
      students: rows.length,
      raceCodes: Object.entries(codes)
        .map(([code, students]) => ({ code, students }))
        .sort((a, b) => b.students - a.students),
      ethnicityValues: Object.entries(ethnicities)
        .map(([value, students]) => ({ value, students }))
        .sort((a, b) => b.students - a.students),
      studentsWithMultipleCodes: rows.filter((r) => (r.raceCodes ?? []).length > 1).length,
    };
  },
});

/**
 * Replace the section point totals.
 *
 * Same shape as replaceMissingWork, and the same trap: the args validator here
 * must carry every field the schema does. A field in one and not the other is
 * rejected at the boundary and the WHOLE sync fails, which is how 2026-09-05
 * lost a sync to two new columns.
 */
export const replaceSectionPoints = internalMutation({
  args: {
    syncedAt: v.string(),
    clearFirst: v.optional(v.boolean()),
    rows: v.array(
      v.object({
        studentNumber: v.string(),
        sectionId: v.string(),
        courseName: v.optional(v.string()),
        pointsEarned: v.number(),
        pointsPossible: v.number(),
      }),
    ),
  },
  handler: async (ctx, { rows, syncedAt, clearFirst }) => {
    let deleted = 0;
    if (clearFirst) {
      // take(), not collect(): a collect() over a table past the 4,096-read
      // limit throws, and a sync that throws records nothing.
      const old = await ctx.db.query("psSectionPoints").take(2000);
      for (const r of old) { await ctx.db.delete(r._id); deleted++; }
      const more = await ctx.db.query("psSectionPoints").take(1);
      if (more.length) return { deleted, written: 0, moreToClear: true };
    }
    for (const r of rows) await ctx.db.insert("psSectionPoints", { ...r, syncedAt });
    return { deleted, written: rows.length, moreToClear: false };
  },
});
