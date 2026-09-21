import { internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { countsForStudent, recencyCutoff } from "./earlyWarning";

/**
 * MEASURE THE SCHOOL BEFORE DRAWING A LINE THROUGH IT.
 *
 * This exists because of a specific failure. A per-grade academics screen was
 * built on a flat "failing" threshold, and when it was finally measured the
 * list named 66% of the school -- which is a roster, not a queue, and cannot
 * be worked. The feature was dropped. Any tier boundary in an early warning
 * indicator has the same failure mode: a threshold that sounds severe
 * ("chronically absent", "failing a class") can easily describe the median
 * child at this school, and a list everyone is on tells a Behavior
 * Interventionist nothing.
 *
 * So this returns DISTRIBUTIONS, and nothing else. No names, no student
 * numbers, no rows -- only counts per bucket and a cross-tabulation, so that
 * thresholds can be chosen against the real shape of the data and re-checked
 * later when the shape moves. It is an internalQuery: CLI only, no client
 * caller, nothing to expose.
 *
 * PAGED BY STUDENT NUMBER, and a student is never split across pages. The
 * three per-student reads use by_studentNumber indexes, so a page of 120
 * students costs roughly 3,000 reads against Convex's limit of 4,096 --
 * psGrades alone is ~5,800 rows and collect() on it is the exact failure that
 * broke clearRoster and the grade sync. Call with `after` set to the returned
 * `last` until `done` is true.
 */

/** Below 60% is the failing line PowerSchool's own letter grades use. */
const FAIL_AT = 60;
const NEAR_AT = 70;

const ATT_TIERS: Array<{ key: string; min: number }> = [
  { key: "severe", min: 0.20 },
  { key: "chronic", min: 0.10 },
  { key: "at-risk", min: 0.05 },
  { key: "ok", min: 0 },
];

function attTier(rate: number | null): string {
  if (rate === null || !isFinite(rate)) return "none";
  for (const t of ATT_TIERS) if (rate >= t.min) return t.key;
  return "ok";
}

const bucketFail = (n: number) => (n === 0 ? "f0" : n === 1 ? "f1" : n === 2 ? "f2" : "f3+");
const bucketMiss = (n: number) => (n === 0 ? "m0" : n <= 2 ? "m1-2" : n <= 5 ? "m3-5" : "m6+");

function bump(h: Record<string, number>, k: string | number) {
  const key = String(k);
  h[key] = (h[key] || 0) + 1;
}

export const profile = internalQuery({
  args: {
    schoolDays: v.number(),
    after: v.optional(v.string()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, { schoolDays, after, pageSize }) => {
    const days = Number(schoolDays) > 0 ? Number(schoolDays) : 0;
    const take = Math.min(Math.max(1, Number(pageSize) || 120), 200);

    const atts = await ctx.db
      .query("psAttendance")
      .withIndex("by_studentNumber", (q) => (after ? q.gt("studentNumber", after) : q))
      .take(take);

    // Histograms, so any percentile can be worked out afterwards without
    // holding a single student's figures.
    const absDays: Record<string, number> = {};
    const tardyDays: Record<string, number> = {};
    const failCount: Record<string, number> = {};
    const nearCount: Record<string, number> = {};
    const gradedCount: Record<string, number> = {};
    const missCount: Record<string, number> = {};
    const lowestPct: Record<string, number> = {};
    const attRatePct: Record<string, number> = {};
    // The joint shape: tier x failing x missing. Every candidate rule can be
    // counted from this offline, which is the point -- no re-querying to try
    // a different line.
    const cross: Record<string, number> = {};

    let students = 0;
    let noGrades = 0, noAttendanceFigure = 0, noMissingRows = 0;
    let syncedAtMax = "";
    const syncDays: Record<string, number> = {};
    let last = after || "";

    for (const a of atts) {
      students++;
      last = a.studentNumber;
      if (String(a.syncedAt || "") > syncedAtMax) syncedAtMax = String(a.syncedAt || "");
      bump(syncDays, String(a.syncedAt || "").slice(0, 10));

      const abs = typeof a.daysAbsentYtd === "number" && isFinite(a.daysAbsentYtd) ? a.daysAbsentYtd : null;
      const tardy = typeof a.daysTardyTerm === "number" && isFinite(a.daysTardyTerm) ? a.daysTardyTerm : null;
      if (abs === null) noAttendanceFigure++;
      if (abs !== null) bump(absDays, Math.round(abs));
      if (tardy !== null) bump(tardyDays, Math.round(tardy));

      // ABSENCE IS NOT ZERO, and a missing rate is not perfect attendance.
      const rate = abs !== null && days > 0 ? abs / days : null;
      const tier = attTier(rate);
      if (rate !== null) bump(attRatePct, Math.min(100, Math.round(rate * 100)));

      const grades = await ctx.db
        .query("psGrades")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", a.studentNumber))
        .take(40);
      // A null percent is a GAP, not a zero. Counting it as 0% would invent a
      // failing grade for a child whose teacher has not posted one.
      const pcts = grades
        .map((g) => (typeof g.currentPercent === "number" && isFinite(g.currentPercent) ? g.currentPercent : null))
        .filter((p): p is number => p !== null);
      const fails = pcts.filter((p) => p < FAIL_AT).length;
      const nears = pcts.filter((p) => p >= FAIL_AT && p < NEAR_AT).length;
      bump(gradedCount, pcts.length);
      if (pcts.length === 0) noGrades++;
      else bump(lowestPct, Math.max(0, Math.min(100, Math.round(Math.min(...pcts)))));
      bump(failCount, fails);
      bump(nearCount, nears);

      const missing = await ctx.db
        .query("psMissingWork")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", a.studentNumber))
        .take(200);
      // isMissing absent reads as TRUE: rows written by plugin 1.3.x carry no
      // such column and every one of those was teacher-flagged by definition.
      const flagged = missing.filter((m) => m.isMissing !== false).length;
      if (missing.length === 0) noMissingRows++;
      bump(missCount, flagged);

      bump(cross, `${tier}|${bucketFail(fails)}|${bucketMiss(flagged)}`);
    }

    return {
      schoolDays: days,
      students,
      done: atts.length < take,
      last,
      // Coverage gaps, reported rather than rendered as good news.
      noGrades, noAttendanceFigure, noMissingRows,
      syncedAtMax, syncDays,
      absDays, tardyDays, attRatePct,
      failCount, nearCount, gradedCount, lowestPct, missCount,
      cross,
      basis: { failAt: FAIL_AT, nearAt: NEAR_AT, tiers: ATT_TIERS.map((t) => `${t.key}>=${t.min}`) },
    };
  },
});

/**
 * IS A ZERO PERCENT A FAILING CHILD, OR AN UNGRADED SECTION?
 *
 * The first calibration run said the MEDIAN student's worst course is 0%, and
 * that 78% of the school has a course below 60. Either this school is in an
 * emergency nobody has mentioned, or a large share of those zeros are sections
 * where nothing has been graded yet -- and the difference decides whether a
 * course-performance axis means anything at all. Putting a child on a failing
 * list for a class that has not started grading would be a wrong claim about
 * them, made at scale.
 *
 * psSectionPoints is the interlock: it carries pointsEarned and pointsPossible
 * per student per section. pointsPossible = 0 means the gradebook holds nothing
 * to be graded on, so a 0% there is an ARTEFACT. Where points do exist, a low
 * percent is real.
 *
 * Paged the same way and returns counts only.
 */
export const gradeReality = internalQuery({
  args: { after: v.optional(v.string()), pageSize: v.optional(v.number()) },
  handler: async (ctx, { after, pageSize }) => {
    const take = Math.min(Math.max(1, Number(pageSize) || 120), 200);
    const atts = await ctx.db
      .query("psAttendance")
      .withIndex("by_studentNumber", (q) => (after ? q.gt("studentNumber", after) : q))
      .take(take);

    const pctHist: Record<string, number> = {};
    let rows = 0, nullPct = 0, zeroPct = 0, lowPct = 0;
    // A grade row's verdict once psSectionPoints is consulted.
    const verdict: Record<string, number> = {};
    let studentsWithRealFail = 0, studentsWithArtefactOnly = 0;
    let students = 0, last = after || "";

    for (const a of atts) {
      students++; last = a.studentNumber;
      const grades = await ctx.db
        .query("psGrades")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", a.studentNumber))
        .take(40);
      const points = await ctx.db
        .query("psSectionPoints")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", a.studentNumber))
        .take(40);
      const possibleBySection = new Map<string, number>();
      for (const p of points) possibleBySection.set(String(p.sectionId), Number(p.pointsPossible) || 0);

      let realFail = 0, artefact = 0;
      for (const g of grades) {
        rows++;
        const p = typeof g.currentPercent === "number" && isFinite(g.currentPercent) ? g.currentPercent : null;
        if (p === null) { nullPct++; verdict["nullPercent"] = (verdict["nullPercent"] || 0) + 1; continue; }
        const bucket = Math.max(0, Math.min(100, Math.round(p / 5) * 5));
        pctHist[String(bucket)] = (pctHist[String(bucket)] || 0) + 1;
        if (p === 0) zeroPct++;
        if (p >= 60) { verdict["passing"] = (verdict["passing"] || 0) + 1; continue; }
        lowPct++;
        const possible = possibleBySection.get(String(g.sectionId || ""));
        if (possible === undefined) {
          verdict["belowButNoPointsRow"] = (verdict["belowButNoPointsRow"] || 0) + 1;
          artefact++;
        } else if (possible <= 0) {
          verdict["belowButNothingGradedYet"] = (verdict["belowButNothingGradedYet"] || 0) + 1;
          artefact++;
        } else {
          verdict["belowAndReallyGraded"] = (verdict["belowAndReallyGraded"] || 0) + 1;
          realFail++;
        }
      }
      if (realFail > 0) studentsWithRealFail++;
      else if (artefact > 0) studentsWithArtefactOnly++;
    }

    return {
      students, done: atts.length < take, last,
      gradeRows: rows, nullPct, zeroPct, belowSixty: lowPct,
      verdict,
      studentsWithRealFail, studentsWithArtefactOnly,
      pctHist,
    };
  },
});

/**
 * HOW MUCH CORROBORATION ACTUALLY EXISTS.
 *
 * gradeReality found 645 below-60 rows with no psSectionPoints row and called
 * them unverifiable. That verdict is only meaningful if psSectionPoints is
 * POPULATED -- and plugin 1.4.1, which serves section_points, was never
 * installed (it answered HTTP 404 on two checks). An empty interlock proves
 * nothing about a child's grade, so this counts the table before anything is
 * concluded from its silence.
 *
 * It also tests the corroboration that DOES exist today: psMissingWork carries
 * sectionId, so a 0% in a section where a teacher has flagged missing work is
 * a student genuinely behind, while a 0% in a section with no flagged work at
 * all is far more likely to be a gradebook nobody has filled in.
 */
export const corroboration = internalQuery({
  args: { after: v.optional(v.string()), pageSize: v.optional(v.number()) },
  handler: async (ctx, { after, pageSize }) => {
    const take = Math.min(Math.max(1, Number(pageSize) || 120), 200);
    const atts = await ctx.db
      .query("psAttendance")
      .withIndex("by_studentNumber", (q) => (after ? q.gt("studentNumber", after) : q))
      .take(take);

    let students = 0, last = after || "";
    let pointsRows = 0, gradeRows = 0, missingRows = 0;
    let studentsWithAnyPointsRow = 0, studentsWithAnyMissing = 0;
    // For each below-60 grade row, is there flagged missing work in the SAME
    // section? That is the corroboration available without plugin 1.4.1.
    const zero: Record<string, number> = {};
    const low: Record<string, number> = {};

    for (const a of atts) {
      students++; last = a.studentNumber;
      const grades = await ctx.db.query("psGrades")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", a.studentNumber)).take(40);
      const points = await ctx.db.query("psSectionPoints")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", a.studentNumber)).take(40);
      const missing = await ctx.db.query("psMissingWork")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", a.studentNumber)).take(200);
      gradeRows += grades.length; pointsRows += points.length; missingRows += missing.length;
      if (points.length) studentsWithAnyPointsRow++;
      if (missing.length) studentsWithAnyMissing++;

      const missBySection = new Map<string, number>();
      for (const m of missing) {
        if (m.isMissing === false) continue;
        const k = String(m.sectionId || m.assignmentSectionId || "");
        missBySection.set(k, (missBySection.get(k) || 0) + 1);
      }
      for (const g of grades) {
        const p = typeof g.currentPercent === "number" && isFinite(g.currentPercent) ? g.currentPercent : null;
        if (p === null || p >= 60) continue;
        const k = String(g.sectionId || "");
        const flagged = missBySection.get(k) || 0;
        const bucket = flagged === 0 ? "noFlaggedWorkInThatSection" : flagged <= 2 ? "flagged1-2" : "flagged3+";
        if (p === 0) zero[bucket] = (zero[bucket] || 0) + 1;
        else low[bucket] = (low[bucket] || 0) + 1;
      }
    }
    return {
      students, done: atts.length < take, last,
      gradeRows, pointsRows, missingRows,
      studentsWithAnyPointsRow, studentsWithAnyMissing,
      zeroPercentRows: zero, lowButNotZeroRows: low,
    };
  },
});

/**
 * THE CALIBRATION THAT COUNTS, with the artefact removed and recency added.
 *
 * TWO CORRECTIONS the first run forced:
 *
 * 1. AN EXACT 0% IS NOT A FAILING STUDENT. 721 grade rows sit at exactly zero
 *    and 709 of them -- 98% -- have no teacher-flagged missing work anywhere in
 *    that section. A child genuinely scoring nothing in a real class would have
 *    work flagged against them; an empty gradebook looks exactly like this.
 *    Counting those as failures put 78% of the school on a failing list, which
 *    is the same way the earlier per-grade academics feature died. So a zero
 *    counts ONLY where that section has flagged missing work, and otherwise it
 *    is reported as ungraded. Low-but-not-zero grades are kept: 341 of 659 have
 *    flagged work behind them, so that part of the signal is real.
 *
 * 2. LEVELS DO NOT DISCRIMINATE HERE, SO RECENCY MUST. Half the school is
 *    chronically absent and half has a genuinely failing course, so a threshold
 *    on a level names a roster. psMissingWork carries dueDate, which means a
 *    single snapshot still contains time: work owed in the last fortnight is a
 *    child coming apart now, and the same count spread since August is not.
 *    This measures both so the difference can be seen before it is relied on.
 */
export const calibrate = internalQuery({
  args: {
    schoolDays: v.number(),
    today: v.string(),          // "YYYY-MM-DD"; passed in, never clock-read
    recentDays: v.optional(v.number()),
    after: v.optional(v.string()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, { schoolDays, today, recentDays, after, pageSize }) => {
    const days = Number(schoolDays) > 0 ? Number(schoolDays) : 0;
    const take = Math.min(Math.max(1, Number(pageSize) || 120), 200);
    const window = Math.min(Math.max(1, Number(recentDays) || 14), 120);
    const cutoffMs = Date.parse(today + "T00:00:00Z") - window * 86400000;
    const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);

    const atts = await ctx.db
      .query("psAttendance")
      .withIndex("by_studentNumber", (q) => (after ? q.gt("studentNumber", after) : q))
      .take(take);

    const realFail: Record<string, number> = {};
    const ungradedCourses: Record<string, number> = {};
    const missRecent: Record<string, number> = {};
    const missOlder: Record<string, number> = {};
    const missUndated: Record<string, number> = {};
    const cross: Record<string, number> = {};
    const dueDates: Record<string, number> = {};
    let students = 0, last = after || "";

    const attT = (rate: number | null) => attTier(rate);
    const bF = (n: number) => (n === 0 ? "f0" : n === 1 ? "f1" : n === 2 ? "f2" : "f3+");
    const bR = (n: number) => (n === 0 ? "r0" : n <= 2 ? "r1-2" : n <= 5 ? "r3-5" : "r6+");

    for (const a of atts) {
      students++; last = a.studentNumber;
      const abs = typeof a.daysAbsentYtd === "number" && isFinite(a.daysAbsentYtd) ? a.daysAbsentYtd : null;
      const rate = abs !== null && days > 0 ? abs / days : null;

      const grades = await ctx.db.query("psGrades")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", a.studentNumber)).take(40);
      const missing = await ctx.db.query("psMissingWork")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", a.studentNumber)).take(200);

      const flaggedBySection = new Map<string, number>();
      let recent = 0, older = 0, undated = 0;
      for (const m of missing) {
        if (m.isMissing === false) continue;
        const k = String(m.sectionId || m.assignmentSectionId || "");
        flaggedBySection.set(k, (flaggedBySection.get(k) || 0) + 1);
        const due = String(m.dueDate || "").slice(0, 10);
        if (!due) undated++;
        else {
          dueDates[due] = (dueDates[due] || 0) + 1;
          if (due >= cutoff) recent++; else older++;
        }
      }

      let fails = 0, ungraded = 0;
      for (const g of grades) {
        const p = typeof g.currentPercent === "number" && isFinite(g.currentPercent) ? g.currentPercent : null;
        if (p === null) { ungraded++; continue; }
        if (p >= 60) continue;
        if (p === 0 && !(flaggedBySection.get(String(g.sectionId || "")) || 0)) { ungraded++; continue; }
        fails++;
      }

      realFail[String(fails)] = (realFail[String(fails)] || 0) + 1;
      ungradedCourses[String(ungraded)] = (ungradedCourses[String(ungraded)] || 0) + 1;
      missRecent[String(recent)] = (missRecent[String(recent)] || 0) + 1;
      missOlder[String(older)] = (missOlder[String(older)] || 0) + 1;
      missUndated[String(undated)] = (missUndated[String(undated)] || 0) + 1;
      const k = `${attT(rate)}|${bF(fails)}|${bR(recent)}`;
      cross[k] = (cross[k] || 0) + 1;
    }

    return {
      students, done: atts.length < take, last,
      schoolDays: days, recentWindowDays: window, cutoff,
      realFail, ungradedCourses, missRecent, missOlder, missUndated, dueDates, cross,
    };
  },
});

/**
 * WHAT BEHAVIOUR DATA ACTUALLY EXISTS -- the "B" of ABC, which is the axis
 * most likely to be assumed rather than checked.
 *
 * The PowerSchool behaviour feed in psBehavior.ts is fully built and NOT LIVE:
 * psBehaviorLog is not declared in schema.ts, no cron calls replaceWindow, and
 * sisAction/psSync never mention it. So the district's 16,987 log entries are
 * not in this database at all. That leaves only what the app itself holds, and
 * this counts it rather than guessing: referral rows, uniform violations, and
 * the app's own negative cash movements.
 *
 * COUNTS ONLY, and no student is named. The referral payloads are opaque by
 * design, so this reports the shape of the mirror rather than reading inside
 * a child's record.
 */
export const behaviourAvailability = internalQuery({
  args: {},
  handler: async (ctx) => {
    const behaviourCoverage = await ctx.db
      .query("appState").withIndex("by_key", (q) => q.eq("key", "psBehaviorCoverage")).unique();
    const behaviourTypes = await ctx.db
      .query("appState").withIndex("by_key", (q) => q.eq("key", "psBehaviorTypes")).unique();

    // REFERRALS LIVE IN legacyMirror, not in the `referrals` table -- doc
    // "referrals", collection "behaviorReferrals", written by legacyData.ts.
    // The `referrals` table is a separate, currently empty destination, and
    // reading the wrong one is how "there is no behaviour data" gets said
    // about a school that has been filing referrals since launch.
    const refSlices = await ctx.db
      .query("legacyMirror").withIndex("by_doc", (q) => q.eq("doc", "referrals")).take(50);
    const refShape = refSlices.map((d) => {
      const p: any = d.payload;
      return {
        collection: d.collection, key: d.key ?? null, mirroredAt: d.mirroredAt,
        kind: Array.isArray(p) ? "array" : typeof p,
        length: Array.isArray(p) ? p.length : undefined,
        sampleKeys: Array.isArray(p) && p.length && p[0] && typeof p[0] === "object"
          ? Object.keys(p[0]).slice(0, 14) : undefined,
      };
    });
    const refTable = await ctx.db.query("referrals").take(5);

    const uniform = await ctx.db.query("uniformViolations").take(2000);
    const live = uniform.filter((u) => !u.voidedAt);
    const uniformByStudent: Record<string, number> = {};
    for (const u of live) {
      const k = String((u as any).studentNumber || (u as any).studentId || "");
      if (k) uniformByStudent[k] = (uniformByStudent[k] || 0) + 1;
    }
    const uniformCounts: Record<string, number> = {};
    for (const n of Object.values(uniformByStudent)) {
      const b = n >= 3 ? "3+" : String(n);
      uniformCounts[b] = (uniformCounts[b] || 0) + 1;
    }

    // The app's own negative behaviour, as a COUNTER not a history read: the
    // `deducted` field on students is the cumulative total a student has had
    // taken, which exists without touching the cash ledger at all.
    const students = await ctx.db.query("students").take(1000);
    const deducted: Record<string, number> = {};
    let withAnyDeduction = 0;
    for (const s of students) {
      const d = Number((s as any).wildcatCashDeducted) || 0;
      if (d > 0) withAnyDeduction++;
      const b = d <= 0 ? "0" : d <= 100 ? "1-100" : d <= 300 ? "101-300" : d <= 600 ? "301-600" : "600+";
      deducted[b] = (deducted[b] || 0) + 1;
    }

    return {
      powerSchoolBehaviour: {
        coverageRecordExists: Boolean(behaviourCoverage),
        typeVocabularyExists: Boolean(behaviourTypes),
        verdict: behaviourCoverage
          ? "a window was pulled at some point"
          : "NOT LIVE -- no coverage record, so every student's behaviour status is 'unknown', never 0",
      },
      referrals: {
        mirrorSlices: refSlices.length, separateTableRows: refTable.length,
        shape: refShape.slice(0, 8),
      },
      uniformViolations: {
        rowsRead: uniform.length, live: live.length,
        studentsWithAny: Object.keys(uniformByStudent).length,
        perStudentCounts: uniformCounts,
      },
      appDeductions: { studentsRead: students.length, withAnyDeduction, buckets: deducted },
    };
  },
});

/**
 * HOW MANY REFERRALS ARE THERE, AND CAN THEY BE COUNTED PER STUDENT?
 *
 * The referral mirror is four opaque payload objects. Whether a behaviour axis
 * is possible at all turns on two questions this answers: how many referrals
 * the school has actually filed, and whether a referral carries something that
 * joins to a student.
 *
 * FIELD NAMES ONLY, NEVER VALUES. A referral names a child and describes what
 * they did; disciplineAggregates.ts is explicit that these payloads stay
 * opaque. This reports the key vocabulary and counts, and the per-student
 * distribution as buckets, so the shape can be judged without reading a single
 * incident.
 */
export const referralShape = internalQuery({
  args: {},
  handler: async (ctx) => {
    const slices = await ctx.db
      .query("legacyMirror").withIndex("by_doc", (q) => q.eq("doc", "referrals")).take(200);
    // ONE ROW PER REFERRAL: legacyData.ts inserts { doc, collection, key, payload }
    // with key = the referral's own id, so the row count IS the referral count.
    const fields = new Set<string>();
    const dates: string[] = [];
    let withStudentJoin = 0;
    for (const s of slices) {
      const p: any = s.payload;
      if (!p || typeof p !== "object") continue;
      for (const k of Object.keys(p)) fields.add(k);
      const join = ["studentNumber", "studentId", "student_id"].find((k) => p[k]);
      if (join) withStudentJoin++;
      const dk = ["date", "timestamp", "createdAt", "at", "dateFiled"].find((k) => p[k]);
      if (dk) dates.push(String(p[dk]).slice(0, 10));
    }
    dates.sort();
    return {
      referralRows: slices.length,
      collections: [...new Set(slices.map((s) => s.collection))],
      keyed: slices.filter((s) => s.key).length,
      withStudentJoin,
      dateSpan: dates.length ? { first: dates[0], last: dates[dates.length - 1], n: dates.length } : null,
      mirroredAtSpan: slices.length
        ? { first: slices.map((s) => s.mirroredAt).sort()[0], last: slices.map((s) => s.mirroredAt).sort().slice(-1)[0] }
        : null,
      // FIELD NAMES ONLY. A referral names a child and describes what they did.
      fieldNames: [...fields].sort(),
    };
  },
});

/**
 * THE ROWS THE TIER BOUNDARIES WERE CHOSEN FROM.
 *
 * scripts/calibrate-early-warning.mjs pages through this, lifts the REAL
 * riskRanking out of wildcat-discipline.js, and prints the score histogram
 * over the whole school. That is how actAt and watchAt were set, and it is how
 * they get re-checked when the school's shape moves -- which it will, because
 * every rate here is measured against school days elapsed and that denominator
 * grows every morning.
 *
 * It calls countsForStudent from earlyWarning.ts rather than recounting, so
 * the calibration cannot drift from what the screen shows. It carries the two
 * attendance figures as well, because the score needs all three axes together
 * and Attendance Watch's query returns them separately to the browser.
 *
 * internalQuery: CLI only. It returns student numbers, which the screen's own
 * query deliberately does not need to, so this must never gain a caller in the
 * browser.
 */
export const calibrationRows = internalQuery({
  args: {
    today: v.string(),
    recentDays: v.optional(v.number()),
    after: v.optional(v.string()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, { today, recentDays, after, pageSize }) => {
    const take = Math.min(Math.max(1, Number(pageSize) || 200), 250);
    const window = Math.min(Math.max(1, Number(recentDays) || 14), 120);
    const cutoff = recencyCutoff(today, window);

    // gt("") on the first page too, for the reason earlyWarning.ts states: an
    // empty studentNumber sorts first and would otherwise hand back a cursor
    // that cannot advance.
    const anchors = await ctx.db
      .query("psAttendance")
      .withIndex("by_studentNumber", (q) => q.gt("studentNumber", after || ""))
      .take(take + 1);
    const done = anchors.length <= take;
    const page = done ? anchors : anchors.slice(0, take);

    const rows: Array<Record<string, any>> = [];
    for (const a of page) {
      const got = await countsForStudent(ctx, a, cutoff);
      if (!got) continue;
      const row = got.row;
      // dayCount's rule, applied here so the calibration sees exactly what the
      // browser sees: a missing or negative figure is null, never 0.
      const n = (x: unknown) =>
        typeof x === "number" && isFinite(x) && x >= 0 ? x : null;
      rows.push({ ...row, daysAbsent: n(a.daysAbsentYtd), daysTardy: n(a.daysTardyTerm) });
    }
    return {
      rows, done, cutoff, recentDays: window,
      last: page.length ? String(page[page.length - 1].studentNumber || "") : (after || ""),
    };
  },
});
