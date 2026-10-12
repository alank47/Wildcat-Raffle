"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { token, readTable } from "./attendanceDays";
import { buildRunDays, seatedStudents, type BuildInput, type DayBand, type MonthBand, type DayGroup } from "./runChartDays";
import {
  AXES, GROUP_AXES, CHART_FLOOR, groupPairs, needsRaceLookup, median, roundSize,
  type Demographics, type ElaHistoryRow,
} from "./runChartGroups";

/**
 * FETCH ONE MONTH FROM POWERSCHOOL, TURN IT INTO DAILY TOTALS, SAVE IT.
 *
 * WHY STRAIGHT FROM POWERSCHOOL rather than from the tables the twice-daily
 * sync fills: those hold only students enrolled TODAY and only this year. The
 * run chart needs the students who have since left (their enrolled days belong
 * in the weeks they were here -- 67 left between 12 Aug and 23 Sep) and last
 * year (for a baseline with the holiday dips in it). Both are reachable
 * through the same table endpoint with no plugin change, measured by
 * attendanceProbe:runChartHistoryProbe on 2026-09-23.
 *
 * ONE MONTH PER CALL, so no call runs long: last year is ~103,000 period
 * records, and a month is about a tenth of that.
 *
 * ONLY COMPLETED DAYS: nothing after yesterday in Los Angeles is read. The
 * nightly run is at 03:15 PT, when yesterday's registers are finished.
 *
 * READS ONLY from PowerSchool; writes only the run chart's own tables.
 *
 * THE GROUP ROWS (2026-10-12) are built AFTER the band rows are written, from
 * demographic reads of their own, each in its own try: a permissions change
 * on a demographic field, or a paged-out read, skips that group for the
 * month with the reason recorded, and never stops the whole-school and band
 * rows that Trends, the Attendance Watch grant and Cash Analytics read.
 * `groupsOnly` builds a month and writes ONLY its group rows -- how last
 * year's group rows are filled without rewriting last year's band rows.
 */
function laToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}
function dayBefore(iso: string): string {
  return new Date(Date.parse(iso + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
}
function lastOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

async function yearRange(host: string, tok: string, schoolid: string, yearid: number) {
  const t = await readTable(host, tok, "terms", `schoolid==${schoolid};yearid==${yearid}`, "id,firstday,lastday,isyearrec");
  const yr = t.rows.find((r: any) => String(r.isyearrec) === "1") ?? t.rows[0];
  if (!yr) return null;
  return { first: String(yr.firstday ?? "").slice(0, 10), last: String(yr.lastday ?? "").slice(0, 10) };
}

/** How long after a year's last day its months may still be rebuilt: late corrections. */
const CLOSE_AFTER_DAYS = 3;
function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}

/** Race codes are looked up one student at a time; past this many in a build, race is skipped for the month, never half-built. */
const RACE_LOOKUP_CAP = 300;
/** Moved-away students' demographic records, looked up by id like their band records (LOOKUP_CAP below). */
const DEMOGRAPHIC_LOOKUP_CAP = 400;

type GroupBuild = {
  axes: string[];
  skipped: Array<{ axis: string; reason: string }>;
  groupDays: DayGroup[];
  reads: Record<string, number>;
};

const why = (e: unknown) => String((e as any)?.message ?? e).slice(0, 200);

/**
 * THE DEMOGRAPHIC READS AND THE GROUP ROWS for one month, after the band
 * build. Three reads, each its own try, each skipping only what needs it:
 *   - students' gender, ethnicity and dcid (every group needs it: none built
 *     without it), plus the moved-away students by id;
 *   - race codes by id, only for students who sat a class this year and are
 *     not already Hispanic, capped and counted;
 *   - the English Learner HISTORY (S_CA_STU_ELA_C, ~2,100 rows district-wide),
 *     so a student's status on each date is used, never today's applied back.
 * The band rows of the second build must equal the first build's exactly, or
 * nothing about groups is kept: the two loops are the same loop.
 */
async function buildGroups(host: string, tok: string, schoolid: string, input: BuildInput, missing: string[],
  bands: { days: DayBand[]; months: MonthBand[] }): Promise<GroupBuild> {
  const reads: Record<string, number> = { students: 0, movedAwayLookups: 0, raceLookups: 0, elaHistoryRows: 0 };
  const skipAll = (reason: string): GroupBuild => ({ axes: [], skipped: AXES.map((axis) => ({ axis, reason })), groupDays: [], reads });
  const seated = seatedStudents(input.cc);
  const demo = new Map<string, Demographics & { dcid?: string }>();
  try {
    const r = await readTable(host, tok, "students", `schoolid==${schoolid}`, "id,dcid,gender,fedethnicity");
    if (r.pagedOut) throw new Error(`students paged out at ${r.pages} pages`);
    const keep = (row: any) => {
      const sid = String(row.id ?? "");
      if (sid) demo.set(sid, { gender: row.gender, fedEthnicity: row.fedethnicity, dcid: String(row.dcid ?? "") });
    };
    r.rows.forEach(keep);
    reads.students = r.rows.length;
    const away = missing.filter((sid) => seated.has(sid) && !demo.has(sid));
    if (away.length > DEMOGRAPHIC_LOOKUP_CAP) throw new Error(`${away.length} moved-away students is more than ${DEMOGRAPHIC_LOOKUP_CAP}`);
    for (const sid of away) {
      const one = await readTable(host, tok, "students", `id==${sid}`, "id,dcid,gender,fedethnicity");
      one.rows.forEach(keep);
      reads.movedAwayLookups++;
    }
  } catch (e) {
    return skipAll("The students' gender and ethnicity could not be read: " + why(e));
  }

  const skipped: Array<{ axis: string; reason: string }> = [];
  let axes = AXES.slice();
  const drop = (unit: string[], reason: string) => {
    axes = axes.filter((x) => !unit.includes(x));
    for (const axis of unit) skipped.push({ axis, reason });
  };

  // RACE CODES, per id, only where Hispanic does not already decide it.
  try {
    const need = [...seated].filter((sid) => needsRaceLookup(demo.get(sid)?.fedEthnicity));
    if (need.length > RACE_LOOKUP_CAP) throw new Error(`${need.length} lookups is more than the cap of ${RACE_LOOKUP_CAP}`);
    for (const sid of need) {
      const r = await readTable(host, tok, "studentrace", `studentid==${sid}`, "studentid,racecd");
      reads.raceLookups++;
      const d = demo.get(sid) ?? {};
      d.raceCodes = r.rows.map((x: any) => String(x.racecd ?? "")).filter(Boolean);
      demo.set(sid, d);
    }
  } catch (e) {
    drop(["race"], "Race codes could not be read: " + why(e));
  }

  // THE ENGLISH LEARNER HISTORY, whole: one read, filtered here by dcid.
  try {
    const r = await readTable(host, tok, "s_ca_stu_ela_c", "studentsdcid=gt=0", "studentsdcid,elastatus,elastatusstartdate");
    if (r.pagedOut) throw new Error(`the history paged out at ${r.pages} pages`);
    if (!r.rows.length) throw new Error("the history came back empty");
    reads.elaHistoryRows = r.rows.length;
    const byDcid = new Map<string, ElaHistoryRow[]>();
    for (const h of r.rows) {
      const k = String(h.studentsdcid ?? "");
      if (!byDcid.has(k)) byDcid.set(k, []);
      byDcid.get(k)!.push({ status: h.elastatus, start: h.elastatusstartdate });
    }
    for (const d of demo.values()) if (d.dcid) d.elaHistory = byDcid.get(d.dcid) ?? [];
  } catch (e) {
    drop(["el", "ela"], "The English Learner history could not be read: " + why(e));
  }

  if (!axes.length) return { axes, skipped, groupDays: [], reads };
  const groupAxes = Object.fromEntries(axes.map((x) => [x, GROUP_AXES[x]]));
  const built = buildRunDays({ ...input, groups: { axes: groupAxes, of: (sid, date) => groupPairs(demo.get(sid), date, axes) } });
  if (JSON.stringify(built.days) !== JSON.stringify(bands.days) || JSON.stringify(built.months) !== JSON.stringify(bands.months)) {
    return skipAll("The group build's whole-school rows differed from the band build's; nothing about groups was kept.");
  }
  return { axes, skipped, groupDays: built.groupDays ?? [], reads };
}

/** The whole school per school day, from the band rows: what every axis must add up to. */
function wholeOf(days: DayBand[]) {
  const by = new Map<string, { date: string; members: number; absentDays: number }>();
  for (const d of days) {
    const w = by.get(d.date) ?? { date: d.date, members: 0, absentDays: 0 };
    w.members += d.members;
    w.absentDays += d.absentDays;
    by.set(d.date, w);
  }
  return [...by.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * COUNTS ONLY, AND NO SMALL GROUP'S FIGURE: what was built, whether each
 * axis adds up to the whole school every day, each group's typical day
 * rounded to 5 (or "under 30"), and on how many days an axis's no-group pool
 * was 1 to 9 -- a number of days, never of students.
 */
function groupSummary(g: GroupBuild, whole: Array<{ date: string; members: number; absentDays: number }>) {
  const addsUp: Record<string, boolean> = {};
  const typical: Record<string, number | string> = {};
  const smallPoolDays: Record<string, number> = {};
  const at = (d: string, axis: string, group: string) => g.groupDays.find((r) => r.date === d && r.axis === axis && r.group === group);
  for (const axis of g.axes) {
    addsUp[axis] = whole.every((w) => {
      const rows = g.groupDays.filter((r) => r.date === w.date && r.axis === axis);
      if (axis === "ela") { const el = at(w.date, "el", "el"); if (el) rows.push(el); }
      return rows.reduce((n, r) => n + r.members, 0) === w.members && rows.reduce((n, r) => n + r.absentDays, 0) === w.absentDays;
    });
    for (const group of GROUP_AXES[axis]) {
      const t = median(whole.map((w) => at(w.date, axis, group)?.members ?? 0)) ?? 0;
      typical[axis + ":" + group] = t >= CHART_FLOOR ? roundSize(t) : `under ${CHART_FLOOR}`;
    }
    smallPoolDays[axis] = whole.filter((w) => { const n = at(w.date, axis, "none")?.members ?? 0; return n > 0 && n < 10; }).length;
  }
  // The race lookups are one per non-Hispanic student, so their exact number
  // less the Black line's size would be the smallest groups: said to the
  // nearest 10.
  const reads = { ...g.reads, raceLookups: Math.round((g.reads.raceLookups ?? 0) / 10) * 10 };
  return { built: g.axes, skipped: g.skipped, reads, addsUp, typical, smallPoolDays };
}

export const buildMonth = internalAction({
  args: {
    yearid: v.number(), month: v.string(), dryRun: v.optional(v.boolean()), onlyWhileOpen: v.optional(v.boolean()),
    groupsOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, { yearid, month, dryRun, onlyWhileOpen, groupsOnly }): Promise<Record<string, any>> => {
    const host = process.env.PS_HOST, id = process.env.PS_CLIENT_ID;
    const secret = process.env.PS_CLIENT_SECRET, schoolid = process.env.PS_SCHOOL_ID;
    const currentYear = Number(process.env.PS_YEAR_ID);
    if (!host || !id || !secret || !schoolid || !Number.isFinite(currentYear)) {
      return { ok: false, reason: "PowerSchool settings are not all present." };
    }
    if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, reason: "month must be YYYY-MM" };
    const tok = await token(host, id, secret);
    const range = await yearRange(host, tok, schoolid, yearid);
    if (!range) return { ok: false, reason: `No year term for yearid ${yearid}.` };

    const yesterday = dayBefore(laToday());
    // A FINISHED YEAR IS LEFT ALONE by the nightly run. Once PowerSchool's
    // end-of-year run promotes everyone, a rebuild of June would file the
    // outgoing 8th graders under 9-12 with grades marked as recorded. A few
    // days' grace catches late corrections; after that, rebuild by hand.
    if (onlyWhileOpen && yesterday > addDays(range.last, CLOSE_AFTER_DAYS)) {
      return { ok: true, skipped: true, reason: `The ${yearid} year ended ${range.last}; its months are no longer rebuilt nightly.` };
    }
    let from = month + "-01";
    let to = lastOfMonth(month);
    if (from < range.first) from = range.first;
    if (to > range.last) to = range.last;
    if (to > yesterday) to = yesterday;
    if (from > to) return { ok: true, skipped: true, reason: "No completed school days in that month.", from, to };

    const codes = await readTable(host, tok, "attendance_code", `schoolid==${schoolid};yearid==${yearid}`,
      "id,presence_status_cd");
    const absentCodeIds = new Set(codes.rows.filter((c: any) => String(c.presence_status_cd) === "Absent").map((c: any) => String(c.id)));
    if (!absentCodeIds.size) return { ok: false, reason: `No Absent codes readable for yearid ${yearid}.` };

    // Schedules for the year, INCLUDING DROPPED classes (PowerSchool negates
    // the termid of a drop), with the dates the student sat in each.
    const base = yearid * 100;
    const ccLive = await readTable(host, tok, "cc", `schoolid==${schoolid};termid=ge=${base};termid=le=${base + 99}`,
      "id,studentid,expression,dateenrolled,dateleft");
    const ccDropped = await readTable(host, tok, "cc", `schoolid==${schoolid};termid=ge=${-(base + 99)};termid=le=${-base}`,
      "id,studentid,expression,dateenrolled,dateleft");
    // EVERY STATUS, and NO NAMES OR NUMBERS: the internal id, grade and exit are all this needs.
    const studs = await readTable(host, tok, "students", `schoolid==${schoolid}`, "id,grade_level,enroll_status,entrydate");
    // STUDENTS WHO HAVE SINCE MOVED TO ANOTHER SCHOOL. Their record now sits
    // under the new school, so the search above misses them, while their
    // classes HERE are still on record. Measured 2025-10: 36 such students,
    // enrolled every day and in no band until looked up by id.
    const known = new Set(studs.rows.map((r: any) => String(r.id)));
    const missing = [...new Set([...ccLive.rows, ...ccDropped.rows].map((r: any) => String(r.studentid ?? "")))]
      .filter((x) => x && !known.has(x));
    const LOOKUP_CAP = 400;
    let lookedUp = 0, lookupFailed = 0;
    for (const sid of missing.slice(0, LOOKUP_CAP)) {
      try {
        const r = await readTable(host, tok, "students", `id==${sid}`, "id,grade_level,enroll_status,entrydate");
        studs.rows.push(...r.rows);
        lookedUp += r.rows.length;
      } catch { lookupFailed++; }
    }
    const att = await readTable(host, tok, "attendance", `schoolid==${schoolid};att_date=ge=${from};att_date=le=${to}`,
      "studentid,att_date,attendance_codeid,ccid");
    for (const [name, r] of [["cc", ccLive], ["cc (dropped)", ccDropped], ["students", studs], ["attendance", att]] as const) {
      if (r.pagedOut) {
        return { ok: false, reason: `${name} paged out at ${r.pages} pages; a truncated read would under-count, so nothing was written.` };
      }
    }

    const input: BuildInput = {
      attendance: att.rows, cc: [...ccLive.rows, ...ccDropped.rows], students: studs.rows,
      absentCodeIds, from, to, isCurrentYear: yearid === currentYear, yearLastDay: range.last,
    };
    const built = buildRunDays(input);
    // AN EMPTY READ NEVER REPLACES A MONTH. A school month always has school
    // days; none at all means PowerSchool answered with nothing (an outage, a
    // permissions change), and writing that would wipe the month.
    if (!built.schoolDays.length) {
      return { ok: false, reason: `PowerSchool returned no attendance for ${from} to ${to}; nothing was written.` };
    }
    // REFUSE RATHER THAN WRITE NONSENSE, the rebuild's own guard: if most
    // records cannot be placed in a period, the slot map is broken.
    if (built.diagnostics.recordsConsidered && built.diagnostics.unmappedShare > 0.15) {
      return { ok: false, reason: `${Math.round(built.diagnostics.unmappedShare * 100)}% of records could not be placed in a period; nothing was written.`,
               diagnostics: built.diagnostics };
    }
    const summary = {
      ok: true, yearid, month, from, to, schoolDays: built.schoolDays.length,
      dayRows: built.days.length, monthRows: built.months.length, diagnostics: built.diagnostics,
      reads: { cc: ccLive.rows.length + ccDropped.rows.length, students: studs.rows.length, attendance: att.rows.length },
      movedAway: { missing: missing.length, lookedUp, lookupFailed, capped: missing.length > LOOKUP_CAP },
    };
    const whole = wholeOf(built.days);
    if (dryRun) {
      let groups: Record<string, any>;
      try { groups = groupSummary(await buildGroups(host, tok, schoolid, input, missing, built), whole); }
      catch (e) { groups = { built: [], error: "The group rows could not be built: " + why(e) }; }
      return { ...summary, dryRun: true, sample: built.days.slice(0, 4), months: built.months, groups };
    }
    const syncedAt = new Date().toISOString();
    // THE BAND ROWS FIRST, exactly as before the group charts existed -- and
    // not at all on a groupsOnly build.
    if (!groupsOnly) {
      await ctx.runMutation(internal.attendanceRunChartData.replaceMonth, {
        yearid, month, gradeEstimated: yearid !== currentYear, syncedAt,
        days: built.days, months: built.months,
      });
    }
    // THEN THE GROUPS, whose failure is recorded and goes no further.
    let groups: Record<string, any>;
    try {
      const g = await buildGroups(host, tok, schoolid, input, missing, built);
      await ctx.runMutation(internal.attendanceGroupRunChart.replaceGroupMonth, {
        yearid, month, syncedAt, axes: g.axes, schoolDays: built.schoolDays, whole,
        days: g.groupDays, skipped: g.skipped,
      });
      groups = groupSummary(g, whole);
    } catch (e) {
      groups = { built: [], error: "The group rows were not written: " + why(e) };
    }
    return { ...summary, ...(groupsOnly ? { groupsOnly: true } : {}), groups };
  },
});

/**
 * THE BACKFILL: every month of a year, one call each, spaced out so
 * PowerSchool is never asked for more than one month at a time. Run it in the
 * evening, and SAY WHICH ROWS (2026-10-12):
 *
 *   npx convex run attendanceRunChart:backfillYear '{"yearid":35,"groupsOnly":true}'
 *     builds the group rows and leaves the band rows exactly as they are --
 *     how last year's group lines are filled;
 *   ... '{"yearid":35,"rewriteBands":true}'
 *     rebuilds the band rows too: what Trends, the Attendance Watch grant and
 *     Cash Analytics read. A closed year's band rows are rebuilt from records
 *     PowerSchool has since promoted, so this is a deliberate act, never a
 *     default.
 */
export const backfillYear = internalAction({
  args: {
    yearid: v.number(), spacingSeconds: v.optional(v.number()),
    groupsOnly: v.optional(v.boolean()), rewriteBands: v.optional(v.boolean()),
  },
  handler: async (ctx, { yearid, spacingSeconds, groupsOnly, rewriteBands }): Promise<Record<string, any>> => {
    if (groupsOnly === rewriteBands || (groupsOnly !== true && rewriteBands !== true)) {
      return { ok: false, reason: "Say which rows: groupsOnly: true builds the group rows and leaves the band rows alone; "
        + "rewriteBands: true rebuilds the band rows (and groups) too. Not both, not neither." };
    }
    const host = process.env.PS_HOST, id = process.env.PS_CLIENT_ID;
    const secret = process.env.PS_CLIENT_SECRET, schoolid = process.env.PS_SCHOOL_ID;
    if (!host || !id || !secret || !schoolid) return { ok: false, reason: "PowerSchool settings missing." };
    const tok = await token(host, id, secret);
    const range = await yearRange(host, tok, schoolid, yearid);
    if (!range) return { ok: false, reason: `No year term for yearid ${yearid}.` };
    const months: string[] = [];
    for (let m = range.first.slice(0, 7); m <= range.last.slice(0, 7);) {
      months.push(m);
      const [y, mm] = m.split("-").map(Number);
      m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
    }
    const gap = Math.max(30, Number(spacingSeconds) || 120);
    for (let i = 0; i < months.length; i++) {
      await ctx.scheduler.runAfter(i * gap * 1000, internal.attendanceRunChart.buildMonth,
        { yearid, month: months[i], ...(groupsOnly ? { groupsOnly: true } : {}) });
    }
    return { ok: true, yearid, range, scheduled: months, spacingSeconds: gap, groupsOnly: groupsOnly === true };
  },
});

/**
 * NIGHTLY, for the current year: this month to yesterday, and during the first
 * week of a month the month just ended too (late corrections).
 *
 * IT ALSO MENDS GAPS. Any earlier month of this year with no rows at all -- a
 * build that failed, or a year that began before this chart existed -- is
 * built too, up to three a night, so a missing month repairs itself rather
 * than sitting as a silent hole in the chart. Months that exist are left as
 * built; run buildMonth by hand to refresh one.
 */
export const refreshCurrent = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, any>> => {
    const yearid = Number(process.env.PS_YEAR_ID);
    if (!Number.isFinite(yearid)) return { ok: false, reason: "PS_YEAR_ID missing." };
    const today = laToday();
    const prevOf = (mo: string) => {
      const [y, m] = mo.split("-").map(Number);
      return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    };
    const months = [today.slice(0, 7)];
    if (Number(today.slice(8, 10)) <= 7) months.unshift(prevOf(today.slice(0, 7)));
    const have: string[] = await ctx.runQuery(internal.attendanceRunChartData.monthsPresent, { yearid });
    const present = new Set(have);
    const first = have.length ? have.slice().sort()[0] : null;
    const mend: string[] = [];
    // Walk back from last month to the earliest stored month (or ten months,
    // a school year), collecting the gaps.
    for (let mo = prevOf(today.slice(0, 7)), k = 0; k < 10 && (!first || mo >= first); mo = prevOf(mo), k++) {
      if (!present.has(mo) && !months.includes(mo)) mend.push(mo);
    }
    const all = [...months, ...mend.slice(0, 3)];
    for (let i = 0; i < all.length; i++) {
      await ctx.scheduler.runAfter(i * 60000, internal.attendanceRunChart.buildMonth,
        { yearid, month: all[i], onlyWhileOpen: true });
    }
    // GROUP MONTHS TO MEND (2026-10-12): a month of this year whose band rows
    // exist but whose group rows lack an axis -- a read skipped that night, or
    // a month built before the group charts existed -- is rebuilt for its
    // GROUPS ONLY, two a night, after the months above. Its band rows are left
    // exactly as they are.
    let groupMend: string[] = [];
    try {
      const groupHave: Array<{ month: string; built: string[] }> =
        await ctx.runQuery(internal.attendanceGroupRunChart.groupMonthsStatus, { yearid });
      const complete = new Set(groupHave.filter((m) => AXES.every((x) => m.built.includes(x))).map((m) => m.month));
      groupMend = have.filter((mo) => !complete.has(mo) && !all.includes(mo)).sort().slice(0, 2);
      for (let i = 0; i < groupMend.length; i++) {
        await ctx.scheduler.runAfter((all.length + i) * 60000, internal.attendanceRunChart.buildMonth,
          { yearid, month: groupMend[i], onlyWhileOpen: true, groupsOnly: true });
      }
    } catch (e) {
      return { ok: true, yearid, months: all, mended: mend.slice(0, 3), groupMended: [], groupMendError: why(e) };
    }
    return { ok: true, yearid, months: all, mended: mend.slice(0, 3), groupMended: groupMend };
  },
});
