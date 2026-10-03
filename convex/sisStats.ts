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
/**
 * ABSENCE BY PERIOD. One row per student per section for the term.
 *
 * Replaced wholesale, like psGrades and psSectionPoints: a student who drops a
 * section must LOSE that section's row, and a merge cannot express a deletion.
 *
 * The validator lists every field the table declares. A field in the schema
 * and missing here is rejected at the boundary with an ArgumentValidationError
 * and the WHOLE sync fails, which is how a grades change once took the roster
 * down with it.
 *
 * NUMBERS STAY UNDEFINED WHEN ABSENT, never coerced to 0. `attendanceRows` of
 * 0 is a real and important value -- it means nobody ever took attendance in
 * that section, which 1,631 of 5,563 measured rows are -- and it must not be
 * confused with the field being missing.
 */
export const replaceAttendanceBySection = internalMutation({
  args: {
    syncedAt: v.string(),
    clearFirst: v.optional(v.boolean()),
    rows: v.array(
      v.object({
        studentNumber: v.string(),
        sectionId: v.optional(v.string()),
        sectionNumber: v.optional(v.string()),
        sectionExpression: v.optional(v.string()),
        courseNumber: v.optional(v.string()),
        courseName: v.optional(v.string()),
        teacherId: v.optional(v.string()),
        daysAbsent: v.optional(v.number()),
        daysTardy: v.optional(v.number()),
        attendanceRows: v.optional(v.number()),
        lastAbsenceDate: v.optional(v.string()),
        termFirstDay: v.optional(v.string()),
        termLastDay: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { rows, syncedAt, clearFirst }) => {
    let deleted = 0;
    if (clearFirst) {
      // take(), not collect(): a collect() over a table past the 4,096-read
      // limit throws, and a sync that throws records nothing. The measured
      // table is ~5,563 rows, so this needs three passes.
      const old = await ctx.db.query("psAttendanceBySection").take(2000);
      for (const r of old) { await ctx.db.delete(r._id); deleted++; }
      const more = await ctx.db.query("psAttendanceBySection").take(1);
      if (more.length) return { deleted, written: 0, moreToClear: true };
    }
    for (const r of rows) await ctx.db.insert("psAttendanceBySection", { ...r, syncedAt });
    return { deleted, written: rows.length, moreToClear: false };
  },
});

/**
 * Per-student per-date block counts. Replaced wholesale, like every other SIS
 * table: a date whose attendance was corrected must lose its old row, and a
 * merge cannot express that.
 *
 * The validator lists every field the table declares -- a field in the schema
 * and missing here is rejected at the boundary and fails the WHOLE sync.
 */
export const replaceAttendanceDays = internalMutation({
  args: {
    syncedAt: v.string(),
    clearFirst: v.optional(v.boolean()),
    rows: v.array(
      v.object({
        studentNumber: v.string(),
        date: v.string(),
        blocksThatDay: v.number(),
        absentBlocks: v.number(),
        presentBlocks: v.number(),
        unrecordedBlocks: v.number(),
        absentSlots: v.optional(v.array(v.string())),
      }),
    ),
  },
  handler: async (ctx, { rows, syncedAt, clearFirst }) => {
    let deleted = 0;
    if (clearFirst) {
      // take(), not collect(): past 4,096 reads a collect() throws, and a sync
      // that throws records nothing.
      const old = await ctx.db.query("psAttendanceDays").take(2000);
      for (const r of old) { await ctx.db.delete(r._id); deleted++; }
      const more = await ctx.db.query("psAttendanceDays").take(1);
      if (more.length) return { deleted, written: 0, moreToClear: true };
    }
    for (const r of rows) await ctx.db.insert("psAttendanceDays", { ...r, syncedAt });
    return { deleted, written: rows.length, moreToClear: false };
  },
});

/**
 * Per-student full/partial absence totals. Replaced wholesale with the per-date
 * rows they are derived from, so the two can never disagree.
 */
export const replaceAbsenceTotals = internalMutation({
  args: {
    syncedAt: v.string(),
    clearFirst: v.optional(v.boolean()),
    rows: v.array(
      v.object({
        studentNumber: v.string(),
        absentDays: v.number(),
        fullDaysStrict: v.number(),
        misrecordDaysByGap: v.array(v.number()),
        partialDays: v.number(),
        assumedPresentDays: v.number(),
      }),
    ),
  },
  handler: async (ctx, { rows, syncedAt, clearFirst }) => {
    let deleted = 0;
    if (clearFirst) {
      const old = await ctx.db.query("psAbsenceTotals").take(2000);
      for (const r of old) { await ctx.db.delete(r._id); deleted++; }
      const more = await ctx.db.query("psAbsenceTotals").take(1);
      if (more.length) return { deleted, written: 0, moreToClear: true };
    }
    for (const r of rows) await ctx.db.insert("psAbsenceTotals", { ...r, syncedAt });
    return { deleted, written: rows.length, moreToClear: false };
  },
});

/** Per-DAY absence totals, replaced wholesale with the rows they derive from. */
export const replaceAbsenceDayTotals = internalMutation({
  args: {
    syncedAt: v.string(),
    clearFirst: v.optional(v.boolean()),
    rows: v.array(
      v.object({
        date: v.string(),
        studentsAbsent: v.number(),
        fullDaysStrict: v.number(),
        misrecordDaysByGap: v.array(v.number()),
        partialDays: v.number(),
      }),
    ),
  },
  handler: async (ctx, { rows, syncedAt, clearFirst }) => {
    let deleted = 0;
    if (clearFirst) {
      const old = await ctx.db.query("psAbsenceDayTotals").take(2000);
      for (const r of old) { await ctx.db.delete(r._id); deleted++; }
      const more = await ctx.db.query("psAbsenceDayTotals").take(1);
      if (more.length) return { deleted, written: 0, moreToClear: true };
    }
    for (const r of rows) await ctx.db.insert("psAbsenceDayTotals", { ...r, syncedAt });
    return { deleted, written: rows.length, moreToClear: false };
  },
});

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

/**
 * Replace the per-student attendance marks rollup.
 *
 * SAME PAGED CLEAR AS ITS NEIGHBOURS. A delete-everything-then-write in one
 * mutation is the shape that broke clearRoster: the clear alone exceeds the
 * document limit once the table is a school year old. The caller loops on
 * `moreToClear` until it comes back false, then writes in batches.
 */
export const replaceAttendanceMarks = internalMutation({
  args: {
    syncedAt: v.string(),
    clearFirst: v.optional(v.boolean()),
    rows: v.array(
      v.object({
        studentNumber: v.string(),
        firstName: v.optional(v.string()),
        lastName: v.optional(v.string()),
        gradeLevel: v.optional(v.string()),
        entryDate: v.optional(v.string()),
        absentDates: v.array(v.string()),
        excusedAbsentDates: v.array(v.string()),
        tardyDates: v.array(v.string()),
        excusedTardyDates: v.array(v.string()),
        // 2026-10-01, for excused tardies. Declared here as well as in the
        // schema, or the rebuild's writes are refused AFTER its clear has
        // emptied the table, and the perfect attendance list goes blank.
        unexcusedAbsentDates: v.optional(v.array(v.string())),
        unexcusedTardyDates: v.optional(v.array(v.string())),
      }),
    ),
  },
  handler: async (ctx, { rows, syncedAt, clearFirst }) => {
    let deleted = 0;
    if (clearFirst) {
      const old = await ctx.db.query("psAttendanceMarks").take(2000);
      for (const r of old) { await ctx.db.delete(r._id); deleted++; }
      const more = await ctx.db.query("psAttendanceMarks").take(1);
      if (more.length) return { deleted, written: 0, moreToClear: true };
    }
    for (const r of rows) await ctx.db.insert("psAttendanceMarks", { ...r, syncedAt });
    return { deleted, written: rows.length, moreToClear: false };
  },
});

// ---------------------------------------------------------------------------
// THE ATTENDANCE REBUILD'S OWN RECORD (2026-10-02).
//
// attendanceDays:rebuild rewrites every attendance screen twice a day, and
// until now a refusal left no trace: somebody had to notice a screen had not
// moved. One appState row, "attendanceRebuild", now holds the run in progress,
// the write lock, the last run, the last good run, the last twenty, the last
// dry run and comparison, and the month-piece switch. appState is read by key,
// so writing it reloads nothing else -- unlike syncRuns, which every open
// student portal watches. Nothing in it names a student.
// ---------------------------------------------------------------------------
const REBUILD_KEY = "attendanceRebuild";
/** No action outlives Convex's 10-minute limit, so a run or lock older than this is dead. */
const REBUILD_DEAD_AFTER_MS = 10 * 60 * 1000;
const REBUILD_RECENT = 20;

async function rebuildState(ctx: any): Promise<{ row: any; value: Record<string, any> }> {
  const row = await ctx.db
    .query("appState")
    .withIndex("by_key", (q: any) => q.eq("key", REBUILD_KEY))
    .unique();
  return { row, value: { ...((row?.value as Record<string, any>) ?? {}) } };
}
async function saveRebuildState(ctx: any, row: any, value: Record<string, any>): Promise<void> {
  const at = new Date().toISOString();
  if (row) await ctx.db.patch(row._id, { value, mirroredAt: at });
  else await ctx.db.insert("appState", { key: REBUILD_KEY, value, mirroredAt: at });
}
/** The list of recent runs keeps the headline numbers, not the per-piece detail. */
function compactRun(r: Record<string, any>): Record<string, any> {
  const { windowDetail, compare, ...rest } = r || {};
  return rest;
}
/**
 * What the attendance screens held when the audit entry was written, in
 * words (review, 2026-10-02). A run that failed while writing, or that Convex
 * stopped while writing, can leave tables short, and a later refusal that
 * writes nothing does not mend them -- so "showing the data from" is only said
 * when no run since the last good one may have written part-way. A run stopped
 * while READING cleared nothing and is not damage. The browser's verdict says
 * the same, of now (WildcatRoster.rebuildHealthVerdict).
 *
 * IN THE PAST TENSE (review, 2026-10-03, round 4). The entry stays in the feed
 * after a later good run has made the screens current, and its "still show"
 * then contradicted a card that said so.
 */
function screensThen(value: Record<string, any>): string {
  let damage: Record<string, any> | null = null;
  for (const r of Array.isArray(value.recent) ? value.recent : []) {
    if (!r || r.ok === true) break;
    if (r.stage === "write") damage = r;
  }
  if (damage) {
    return `Some attendance screens may have been incomplete since ${laTime(damage.finishedAt ?? damage.startedAt)}, when a `
      + `rebuild ${damage.code === "abandoned" ? "was stopped while writing" : "failed while writing"}.`;
  }
  // No good run on record is not "no data": the record began with this
  // build, and the tables still hold the last rebuild from before it.
  return value.lastOk?.finishedAt
    ? `Attendance screens were left showing the data from ${laTime(value.lastOk.finishedAt)}.`
    : "Attendance screens were left showing the last rebuild from before this record began (no good run recorded since).";
}
/**
 * A time as the school reads it, "Oct 2, 6:32 AM" (review, 2026-10-03). The
 * audit entry's reason is shown as written in the dashboard feed, and a raw
 * "2026-10-02T13:32:00.000Z" there is seven hours off to anyone who reads it
 * as a clock. Same words as the card's own verdict (WildcatRoster.rebuildHealthVerdict).
 */
function laTime(iso: unknown): string {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "an unknown time";
  return new Date(t).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/**
 * THE AUDIT ENTRY for a run that was itself the retry and did not complete
 * either, like the cash drift check: one refusal heals itself fifteen minutes
 * later and is not news. Two in a row mean the screens are standing still
 * until somebody acts, and the audit log is where that will be found. Written
 * by finishAttendanceRebuild for a retry that refused or failed, and by
 * noteAttendanceRebuildStart for a retry Convex stopped -- which never
 * reaches its own finish (review, 2026-10-03).
 *
 * SAID AS WHAT HAPPENED, AT THE RETRY'S OWN TIME (review, 2026-10-03, round
 * 4). A stopped retry is found by the NEXT run's start, hours later, and the
 * entry is stamped then: "are not being refreshed" sat in the feed beside a
 * card that said current a minute later. So: the past tense, and when the
 * retry started, in the school's time.
 */
async function auditRetryDidNotComplete(ctx: any, value: Record<string, any>, rec: Record<string, any>): Promise<void> {
  const at = new Date().toISOString();
  const retried = laTime(rec.startedAt);
  const entryId = `a_attrebuild_${at.replace(/[^0-9]/g, "")}`;
  await ctx.db.insert("appAuditLog", {
    entryId,
    timestamp: at,
    payload: {
      action: "attendance_rebuild_refused",
      entryId, timestamp: at,
      // "All students", not "": an entry with no name renders as
      // "Student #" + studentId, the trap the cash drift entry notes.
      studentId: "all", studentName: "All students",
      category: "Attendance",
      teacher: "System (attendance rebuild)",
      teacherName: "System (attendance rebuild)",
      teacherId: "",
      details: `The attendance rebuild did not complete twice in a row (the scheduled run and its retry of ${retried}). `
        + `${screensThen(value)} `
        + `Reason: ${String(rec.reason || rec.code || "unknown")}`,
      // THE WHAT AND THE WHY GO IN `reason` (review, 2026-10-02): it is the
      // field the dashboard feed renders, and nothing renders `details`.
      // Only admins see the entry there (script.js dashFeedEntriesFor).
      reason: `The attendance rebuild and its retry of ${retried} did not complete `
        + `(${String(rec.code || "unknown")}). ${screensThen(value)}`,
    },
  });
}

/**
 * The runs still going, by run id (review, 2026-10-02). It used to be ONE
 * marker, and a second run starting inside ten minutes -- a booked retry
 * overlapping a manual run -- replaced it; when that second run was refused
 * 'lock-held' its finish cleared the marker, so the run actually writing went
 * unwatched: had it died mid-write, nothing would ever have said so. Now each
 * run adds its own entry and its finish removes only that one. `running` is
 * null when there are none; a single marker (the old shape) is read as one.
 */
function liveRuns(value: Record<string, any>): Record<string, any> {
  const r = value.running;
  if (!r || typeof r !== "object") return {};
  if (typeof r.runId === "string") return { [r.runId]: r };
  return { ...r };
}
function abandonedRun(prev: Record<string, any>, stage: "read" | "write"): Record<string, any> {
  return {
    runId: prev.runId, trigger: prev.retryOf ? "retry" : prev.trigger ?? "scheduled/manual", retryOf: prev.retryOf ?? null,
    startedAt: prev.startedAt, finishedAt: null, ok: false, code: "abandoned", stage,
    reason: "This run never finished: Convex stopped it (the 10-minute limit, a deploy or a crash), "
      + (stage === "write"
        ? "while it was writing, so some attendance screens may be incomplete until the next good run."
        : "while it was still reading, before anything was cleared; the previous tables are untouched."),
  };
}

/**
 * A run has started. A MARKER, NOT A LOCK: it never stops a run. It answers
 * two things the run needs -- whether the month-piece switch is on, and, for
 * a retry, whether the run it was booked for already finished ok -- and it is
 * where a run that never finished is noticed: Convex killed it (the time
 * limit, a deploy, a crash), so it is written into the record as abandoned.
 *
 * AT THE STAGE IT DIED IN (review, 2026-10-02). It used to be filed at stage
 * 'unknown' and counted as damage, so a run stopped while still reading --
 * which had cleared nothing -- told admins the screens "may be incomplete".
 * A run that held the write lock was writing; any other was reading.
 */
export const noteAttendanceRebuildStart = internalMutation({
  args: { runId: v.string(), startedAt: v.string(), retryOf: v.optional(v.string()) },
  handler: async (ctx, { runId, startedAt, retryOf }) => {
    const { row, value } = await rebuildState(ctx);
    const monthPieces = value.monthPieces === true;
    if (retryOf && value.lastOk && value.lastOk.runId === retryOf) {
      return { originalOk: true, monthPieces };
    }
    const now = Date.now();
    const dead = (at: unknown) => now - Date.parse(String(at)) > REBUILD_DEAD_AFTER_MS;
    const live = liveRuns(value);
    const filed: Record<string, any>[] = [];
    for (const prev of Object.values(live)) {
      if (!prev || prev.runId === runId || !dead(prev.startedAt)) continue;
      const wrote = !!value.writing && value.writing.runId === prev.runId;
      filed.push(abandonedRun(prev, wrote ? "write" : "read"));
      delete live[prev.runId];
      if (wrote) value.writing = null;
    }
    // A WRITE LOCK WITH NOBODY BEHIND IT: a run that claimed it, never
    // finished, and is no longer in `running`. It was writing.
    const w = value.writing;
    if (w && w.runId !== runId && !live[w.runId] && dead(w.startedAt)) {
      filed.push(abandonedRun({ runId: w.runId, startedAt: w.startedAt, trigger: "unknown" }, "write"));
      value.writing = null;
    }
    if (filed.length) {
      filed.sort((a, b) => (String(a.startedAt) < String(b.startedAt) ? -1 : 1));
      value.last = filed[filed.length - 1];
      value.recent = [...filed.reverse(), ...(Array.isArray(value.recent) ? value.recent : [])].slice(0, REBUILD_RECENT);
    }
    live[runId] = { runId, startedAt, retryOf: retryOf ?? null };
    value.running = live;
    await saveRebuildState(ctx, row, value);
    // A RETRY CONVEX STOPPED IS THE SECOND FAILURE IN A ROW TOO (review,
    // 2026-10-03). It never reaches finishAttendanceRebuild, so this is the
    // one place it is seen: the same audit entry, once, for the latest.
    const stoppedRetry = filed.find((r) => r.trigger === "retry");
    if (stoppedRetry) await auditRetryDidNotComplete(ctx, value, stoppedRetry);
    return { originalOk: false, monthPieces };
  },
});

/**
 * The last question before a run clears anything: may it?
 *
 * THE WRITE LOCK. Two runs clearing and refilling the same four tables at
 * once would interleave into nonsense. A lock is held from the claim until
 * its run finishes, and dies with its run: ten minutes after the holder
 * STARTED, since no action can be alive after that.
 *
 * THE SHRINK GUARD. A year that suddenly reads under half of what the last
 * good run read is far likelier a broken read than half the school's
 * attendance disappearing. Refused, with the way through written in the
 * reason, for the day it really is a mass deletion.
 */
export const claimAttendanceRebuildWrite = internalMutation({
  args: {
    runId: v.string(), startedAt: v.string(), yearid: v.string(), yearCount: v.number(),
    acceptShrink: v.optional(v.boolean()),
  },
  handler: async (ctx, { runId, startedAt, yearid, yearCount, acceptShrink }) => {
    const { row, value } = await rebuildState(ctx);
    const w = value.writing;
    if (w && w.runId !== runId && Date.now() - Date.parse(String(w.startedAt)) < REBUILD_DEAD_AFTER_MS) {
      return {
        ok: false, code: "lock-held", heldBy: String(w.runId),
        reason: `Another rebuild (${w.runId}, started ${laTime(w.startedAt)}) is writing these tables right now, `
          + `so this one stopped rather than clear them under it.`,
      };
    }
    const lastOk = value.lastOk;
    const before = Number(lastOk?.attendanceRows) || 0;
    if (acceptShrink !== true && lastOk && String(lastOk.yearid) === String(yearid) && before > 0
        && yearCount < 0.5 * before) {
      return {
        ok: false, code: "shrink",
        reason: `PowerSchool now gives ${yearCount} attendance rows for this year, under half of the `
          + `${before} the last good rebuild read (${laTime(lastOk.finishedAt)}). That looks like a broken read, `
          + `not a real change, so the tables were kept. If rows really were removed in PowerSchool, run `
          + `attendanceDays:rebuild once by hand with { "acceptShrink": true }.`,
      };
    }
    value.writing = { runId, startedAt, claimedAt: new Date().toISOString() };
    await saveRebuildState(ctx, row, value);
    return { ok: true };
  },
});

/**
 * A run has finished, however it finished. Releases its marker and its lock,
 * and files the record: a real run becomes `last` (and `lastOk` when it was
 * ok) and joins `recent`; a dry run is filed apart, and a comparison apart
 * again, so a later measuring run cannot wipe the comparison that proved the
 * switch.
 *
 * AN AUDIT ENTRY ONLY WHEN THE RETRY HAS FAILED TOO, like the cash drift
 * check: one refusal heals itself fifteen minutes later and is not news. Two
 * in a row mean the screens are standing still until somebody acts, and the
 * audit log is where that will be found.
 */
export const finishAttendanceRebuild = internalMutation({
  args: { runId: v.string(), record: v.any() },
  handler: async (ctx, { runId, record }) => {
    const { row, value } = await rebuildState(ctx);
    const rec: Record<string, any> = record && typeof record === "object" ? record : {};
    if (rec.dryRun === true) {
      value.lastDryRun = compactRun(rec);
      if (rec.compare) value.lastCompare = { runId, finishedAt: rec.finishedAt ?? null, ...rec.compare };
      await saveRebuildState(ctx, row, value);
      return { recorded: "dryRun" };
    }
    // Only this run's own entry: another run may still be going.
    const live = liveRuns(value);
    delete live[runId];
    value.running = Object.keys(live).length ? live : null;
    if (value.writing && value.writing.runId === runId) value.writing = null;
    // A 'lock-held' refusal is not news about the data (review, 2026-10-02):
    // another run was writing, and that run's own record says how it went. As
    // `last` it could land just after the holder's ok and leave a false alarm
    // until the next cron, so it is kept in `recent` only, and never audited.
    const lockHeld = rec.ok !== true && rec.code === "lock-held";
    if (!lockHeld) value.last = rec;
    if (rec.ok === true) value.lastOk = rec;
    value.recent = [compactRun(rec), ...(Array.isArray(value.recent) ? value.recent : [])].slice(0, REBUILD_RECENT);
    await saveRebuildState(ctx, row, value);

    if (rec.ok !== true && rec.trigger === "retry" && !lockHeld) {
      await auditRetryDidNotComplete(ctx, value, rec);
    }
    return { recorded: rec.ok === true ? "ok" : "not ok" };
  },
});

/**
 * THE SWITCH: read the year in month pieces (true) or in one read (false).
 * Absent means OFF. Turned on once the dry-run comparison has come back
 * identical on production, from the command line:
 *   npx convex run --prod sisStats:setAttendanceMonthPieces '{"on":true}'
 * and off again the same way, with no deploy.
 */
export const setAttendanceMonthPieces = internalMutation({
  args: { on: v.boolean() },
  handler: async (ctx, { on }) => {
    const { row, value } = await rebuildState(ctx);
    value.monthPieces = on;
    value.monthPiecesChangedAt = new Date().toISOString();
    await saveRebuildState(ctx, row, value);
    return { monthPieces: on, changedAt: value.monthPiecesChangedAt };
  },
});
