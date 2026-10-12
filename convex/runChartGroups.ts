/**
 * THE ATTENDANCE RUN CHARTS BY STUDENT GROUP (owner's decisions, 2026-10-11).
 *
 * Every rule that decides who is in a group, who may see it, and what may be
 * served without identifying a child lives here. PURE -- no database, no
 * network -- so each one is run by a test (attendance-group-run-chart.test.mjs).
 * The nightly build (attendanceRunChart.ts) uses the first half; the query
 * (attendanceGroupRunChart.ts) the second.
 *
 * WHAT IS CHARTED: the weekly whole-day attendance rate, exactly as on Trends
 * (1 - whole days out / student-days enrolled), per group. Nothing else: no
 * daily points, no monthly counts, no band split (academics.ts:26-31 -- a
 * group crossed with a grade band makes cells under 10 that subtraction
 * recovers).
 *
 * THE GROUPS, AND WHO SEES THEM (owner, 2026-10-11):
 *   gender     Female, Male            admin, superadmin, PBIS, and the
 *                                      Attendance Watch grant (gender ONLY)
 *   race       Black or African American   admin and superadmin ONLY
 *   el         Current English Learner / Not       admin, superadmin, PBIS
 *   ela        EO, RFEP, IFEP, and EL (the same rows as Current English Learner)
 *
 *   NEVER: Hispanic or Latino. It is about nine in ten students here, so its
 *   line is the whole school's, and drawn beside Black and the whole school it
 *   would hand back the five students in the smallest groups.
 *
 * MEASURED BEFORE BUILDING (count-only probes against PowerSchool, 2026-10-12,
 * typical students enrolled on a school day, this year / last year):
 *   Female 297 / 212, Male 315 / 227, outside F/M 0 in every month of both
 *   years (leavers included); Black 47 / 66; Current EL 115 / 92 by the status
 *   on each date; Not EL 496 / 348; EO 268 / 193; RFEP 197 / 137; IFEP 28 / 19.
 *   studentrace: 1,666 rows, readable; one lookup per non-Hispanic student
 *   who sat a class (54 this year, 83 last). s_ca_stu_ela_c: 2,133 rows,
 *   readable, every current student's rows dated, and the newest status agrees
 *   with today's S_CA_STU_X for 607 of 607 current students -- so English
 *   Learner lines are drawn from the status ON EACH DATE, not today's status
 *   applied backwards.
 */
import { reportedCategories, classifyEthnicity } from "./raceRollup";
import { fullDaysAt } from "./absenceDayRules";
import { GROUP_NONE } from "./runChartDays";

// ===========================================================================
// 1. WHO IS IN WHICH GROUP ON A DATE (the nightly build)
// ===========================================================================

/** The stored groups of each axis. GROUP_NONE is added to each by the build. */
export const GROUP_AXES: Record<string, string[]> = {
  gender: ["F", "M"],
  race: ["black"],
  el: ["el", "notel"],
  ela: ["EO", "RFEP", "IFEP"],
};
export const AXES = Object.keys(GROUP_AXES);

export const BLACK_LABEL = "Black or African American";

/** PowerSchool's STUDENTS.GENDER: F or M, and anything else in no group. Never rounded to one of the two. */
export function genderGroup(raw: unknown): string {
  const g = String(raw ?? "").trim().toUpperCase();
  return g === "F" || g === "M" ? g : GROUP_NONE;
}

/** The California rule, reused (raceRollup.ts): Hispanic wins; a non-Hispanic student coded 600 is Black. */
export function raceGroup(fedEthnicity: unknown, raceCodes: string[] | null | undefined): string {
  const rep = reportedCategories({ fedEthnicity: fedEthnicity as any, raceCodes: raceCodes ?? [] });
  return rep.categories.includes(BLACK_LABEL) ? "black" : GROUP_NONE;
}

/** Does this student need their race codes looked up? Only when Hispanic does not already decide it. */
export function needsRaceLookup(fedEthnicity: unknown): boolean {
  return classifyEthnicity(fedEthnicity) !== "hispanic";
}

export type ElaHistoryRow = { status: unknown; start: unknown };

/**
 * A student's English Learner status ON A DATE, from S_CA_STU_ELA_C: the row
 * with the latest start date on or before it. Null -- in no group -- when no
 * row has started yet, when the status is blank, or when two rows start the
 * same day with different statuses (which one held is unknowable). A row with
 * no start date cannot be placed in time and is not used.
 */
export function elaStatusAsOf(history: ElaHistoryRow[] | null | undefined, date: string): string | null {
  let bestStart = "";
  let statuses = new Set<string>();
  for (const h of history ?? []) {
    const start = String(h?.start ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || start > date) continue;
    const s = String(h?.status ?? "").trim().toUpperCase();
    if (start > bestStart) { bestStart = start; statuses = new Set([s]); }
    else if (start === bestStart) statuses.add(s);
  }
  if (statuses.size !== 1) return null;
  const s = [...statuses][0];
  return s || null;
}

/** Current English Learner yes/no. A recorded status other than EL (EO, RFEP, IFEP, TBD) is "not"; no status is neither. */
export function elGroup(status: string | null): string {
  if (!status) return GROUP_NONE;
  return status === "EL" ? "el" : "notel";
}

/**
 * The four-way classification. An EL student is in NO row of this axis: the
 * classification's "EL" line is the Current English Learner rows, never
 * stored twice. Pending (TBD), anything else, or no status: no group.
 */
export function elaGroup(status: string | null): string | null {
  if (status === "EL") return null;
  if (status === "EO" || status === "RFEP" || status === "IFEP") return status;
  return GROUP_NONE;
}

export type Demographics = {
  gender?: unknown;
  fedEthnicity?: unknown;
  raceCodes?: string[] | null;
  elaHistory?: ElaHistoryRow[] | null;
};

/** One student's [axis, group] pairs on a date, for the axes being built. */
export function groupPairs(d: Demographics | undefined, date: string, axes: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (axes.includes("gender")) out.push(["gender", genderGroup(d?.gender)]);
  if (axes.includes("race")) out.push(["race", raceGroup(d?.fedEthnicity, d?.raceCodes)]);
  if (axes.includes("el") || axes.includes("ela")) {
    const status = elaStatusAsOf(d?.elaHistory, date);
    if (axes.includes("el")) out.push(["el", elGroup(status)]);
    const e = elaGroup(status);
    if (axes.includes("ela") && e !== null) out.push(["ela", e]);
  }
  return out;
}

// ===========================================================================
// 2. WHO MAY SEE WHICH GROUP (the query)
// ===========================================================================

/**
 * A DIRECT ROLE LIST, never accessRules.canReadInsights: that rule also lets
 * the per-person Attendance Watch grant in, and the grant's holder may see
 * gender and nothing else. Race is admin and superadmin only -- they are
 * approved for an individual's race (docs/field-sourcing-approval.md,
 * 2026-08-19); PBIS gets no race line at all (owner, 2026-10-11).
 */
export const GROUP_CHART_ROLES = ["admin", "superadmin", "pbis"];
export const RACE_LINE_ROLES = ["admin", "superadmin"];
export type GroupType = "gender" | "race" | "el" | "ela";

export function groupTypesFor(staff: { role?: unknown; attendanceWatch?: unknown } | null | undefined): GroupType[] {
  if (!staff) return [];
  const role = String(staff.role ?? "");
  if (RACE_LINE_ROLES.includes(role)) return ["gender", "race", "el", "ela"];
  if (GROUP_CHART_ROLES.includes(role)) return ["gender", "el", "ela"];
  // THE GRANT: a real boolean true, as accessRules.canReadInsights reads it,
  // and GENDER ONLY. "true" or 1 is no grant.
  if (staff.attendanceWatch === true) return ["gender"];
  return [];
}

export const TYPE_LABELS: Record<GroupType, string> = {
  gender: "Gender",
  race: "Race or ethnicity",
  el: "English Learner",
  ela: "Language classification",
};

/**
 * Each line a person can ask for: the stored rows it reads (`row`, axis:group)
 * and the cells of its family it covers. The classification's EL reads the
 * Current English Learner rows: one series, two places on the menu.
 */
export type Series = {
  id: string; type: GroupType; family: "gender" | "race" | "el"; label: string;
  row: string; cells: string[]; sameAs?: string;
};
export const SERIES: Series[] = [
  { id: "gender:F", type: "gender", family: "gender", label: "Female", row: "gender:F", cells: ["F"] },
  { id: "gender:M", type: "gender", family: "gender", label: "Male", row: "gender:M", cells: ["M"] },
  { id: "race:black", type: "race", family: "race", label: BLACK_LABEL, row: "race:black", cells: ["black"] },
  { id: "el:el", type: "el", family: "el", label: "Current English Learner", row: "el:el", cells: ["EL"] },
  { id: "el:notel", type: "el", family: "el", label: "Not currently an English Learner", row: "el:notel", cells: ["EO", "RFEP", "IFEP", "TBD"] },
  { id: "ela:EO", type: "ela", family: "el", label: "English Only", row: "ela:EO", cells: ["EO"] },
  { id: "ela:RFEP", type: "ela", family: "el", label: "Reclassified fluent (RFEP)", row: "ela:RFEP", cells: ["RFEP"] },
  { id: "ela:IFEP", type: "ela", family: "el", label: "Initially fluent (IFEP)", row: "ela:IFEP", cells: ["IFEP"] },
  { id: "ela:EL", type: "ela", family: "el", label: "English Learner", row: "el:el", cells: ["EL"], sameAs: "el:el" },
];

/** The axes each family's rows come from, and the one whose rows add up to the whole school. */
export const FAMILY_AXES: Record<string, string[]> = { gender: ["gender"], race: ["race"], el: ["el", "ela"] };
const WHOLE_AXIS: Record<string, string> = { gender: "gender", race: "race", el: "el" };

/** Groups the owner will not chart, said on screen with the reason (never with a number). */
export const NEVER_CHARTED = [
  {
    type: "race" as GroupType, group: "Hispanic or Latino",
    reason: "About nine in ten students here are Hispanic or Latino, so its line would be the whole school's. "
      + "Drawn beside the others it would also give away the few students in the smallest groups, so it is not charted.",
  },
];

// ===========================================================================
// 3. THE FLOORS (owner, 2026-10-11)
// ===========================================================================

/** A group is offered only when its TYPICAL day this year has this many students (drops IFEP at 28). */
export const CHART_FLOOR = 30;
/** And a week is drawn only when EVERY school day in it has this many (and passes the residual test). */
export const DAY_FLOOR = 10;
/** Under this a group is offered but "small": never coloured, and its signals are "worth a look". */
export const SMALL_CHART_GROUP = 60;
/** Group sizes leave rounded to the nearest 5, and nothing else about membership leaves at all. */
export const SIZE_ROUND = 5;
/** A period with fewer school days than this is never served: a one-day period is a daily rate. */
export const MIN_PERIOD_DAYS = 2;
export const MAX_PERIOD_WEEKS = 4;
export const MAX_PERIODS = 120;

export function roundSize(n: number): number {
  return Math.round(n / SIZE_ROUND) * SIZE_ROUND;
}

export function median(xs: number[]): number | null {
  const s = xs.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ===========================================================================
// 4. THE RESIDUAL TEST, ONE DAY AT A TIME
// ===========================================================================
//
// THE LEAK. Rates add up the way counts do, roughly: the whole school (on
// Trends) minus the lines shown here can be a handful of students, and their
// weekly rate is a fact about them. So on EVERY day of a period, nothing a
// reader holds -- the whole school and the lines of a family -- may add or
// subtract down to 1 to 9 students. Read from the builder's own count of each
// family's members in no stored group (the "none" rows, written in the same
// mutation as the group rows), never from two tables written apart.
//
// FAMILIES AND CELLS. A family is the set of lines that can be subtracted
// from each other: gender; race; and English Learner with the classification,
// which share a line. Its CELLS are the finest pieces those lines cut the
// school into on a day -- gender: F, M, neither; race: Black, not; English
// Learner: EL, EO, RFEP, IFEP, pending or other (TBD), no status on the date.
// Every line is a set of cells, so "can some sum or difference isolate 1 to 9
// students?" is a question about cells, answered exactly by matrix rank (the
// same method as attendanceSubgroups.exposesSmallPool, at this floor).
//
// WHAT IS WITHHELD. On a day that fails, the SMALLEST line shown (by its
// typical size this year, a fixed order) goes, and the day is asked again. A
// line is served for a period only if it went on NO day of it. Decided day by
// day, so a week withheld is withheld in every period that contains it, and
// fewer lines than a day allows are always safe too (a subset of a safe set
// spans less).

/** The cells of one family on one day, from its stored rows; null when a row is missing or they do not add up. */
export function familyCells(family: string, rows: Map<string, { members: number }>): Map<string, number> | null {
  const m = (k: string) => {
    const r = rows.get(k);
    return r && Number.isFinite(r.members) && r.members >= 0 ? r.members : null;
  };
  const need = (keys: string[]) => keys.map(m);
  if (family === "gender") {
    const [f, mm, none] = need(["gender:F", "gender:M", "gender:" + GROUP_NONE]);
    if (f === null || mm === null || none === null) return null;
    return new Map([["F", f], ["M", mm], ["none", none]]);
  }
  if (family === "race") {
    const [b, none] = need(["race:black", "race:" + GROUP_NONE]);
    if (b === null || none === null) return null;
    return new Map([["black", b], ["none", none]]);
  }
  if (family === "el") {
    const [el, notel, elNone, eo, rfep, ifep, elaNone] =
      need(["el:el", "el:notel", "el:" + GROUP_NONE, "ela:EO", "ela:RFEP", "ela:IFEP", "ela:" + GROUP_NONE]);
    if ([el, notel, elNone, eo, rfep, ifep, elaNone].some((x) => x === null)) return null;
    // Pending or other = the classification's "no group" less the students
    // with no status at all (who are in both "no group" rows).
    const tbd = elaNone! - elNone!;
    if (tbd < 0 || notel !== eo! + rfep! + ifep! + tbd) return null;
    return new Map([["EL", el!], ["EO", eo!], ["RFEP", rfep!], ["IFEP", ifep!], ["TBD", tbd], ["NOREC", elNone!]]);
  }
  return null;
}

/** Rank of a 0/1 matrix over the chosen columns: exact (fraction-free, BigInt), as attendanceSubgroups.rankOf. */
function rank(m: number[][], cols: number[]): number {
  const a = m.map((row) => cols.map((c) => BigInt(row[c] ? 1 : 0)));
  const height = a.length, width = cols.length;
  let r = 0;
  let prev = BigInt(1);
  for (let c = 0; c < width && r < height; c++) {
    let p = r;
    while (p < height && a[p][c] === BigInt(0)) p++;
    if (p === height) continue;
    if (p !== r) { const t = a[p]; a[p] = a[r]; a[r] = t; }
    const pivot = a[r][c];
    for (let i = r + 1; i < height; i++) {
      const f = a[i][c];
      for (let k = c + 1; k < width; k++) a[i][k] = (a[i][k] * pivot - f * a[r][k]) / prev;
      a[i][c] = BigInt(0);
    }
    prev = pivot;
    r++;
  }
  return r;
}

/**
 * Could the whole school and these lines, added and subtracted, describe more
 * than zero and fewer than `floor` students? `cells` are the family's cell
 * sizes on the day; each line is the list of cells it covers.
 */
export function exposesSmall(cells: Map<string, number>, lines: string[][], floor = DAY_FLOOR): boolean {
  const keys = [...cells.keys()].filter((k) => (cells.get(k) ?? 0) > 0);
  if (!keys.length) return false;
  const size = keys.map((k) => cells.get(k)!);
  const m: number[][] = [keys.map(() => 1)];                // the whole school
  for (const l of lines) m.push(keys.map((k) => (l.includes(k) ? 1 : 0)));
  const all = keys.map((_, i) => i);
  const full = rank(m, all);
  const big = all.filter((i) => size[i] >= floor);
  const bigRank = rank(m, big);
  if (bigRank === full) return false;
  const live = all.filter((i) => size[i] < floor && rank(m, [...big, i]) > bigRank);
  const pick: number[] = [];
  const search = (from: number, used: number): boolean => {
    if (from === live.length) {
      if (!pick.length || live.some((i) => !pick.includes(i) && used + size[i] < floor)) return false;
      return rank(m, all.filter((i) => !pick.includes(i))) < full;
    }
    const i = live[from];
    if (used + size[i] < floor) {
      pick.push(i);
      const hit = search(from + 1, used + size[i]);
      pick.pop();
      if (hit) return true;
    }
    return search(from + 1, used);
  };
  return search(0, 0);
}

/**
 * The rows withheld on one day for one family. `offered` are the rows of the
 * lines this reader may see that pass the CHART_FLOOR; `order` is them,
 * smallest first (fixed for the answer). Everything not offered is withheld
 * already and counts as part of the pool.
 */
export function withheldOnDay(family: string, rows: Map<string, { members: number }>, offered: string[],
  order: string[]): { removed: Set<string>; noData: boolean } {
  const cells = familyCells(family, rows);
  const removed = new Set<string>();
  if (!cells) return { removed: new Set(offered), noData: true };
  for (const r of offered) {
    const n = rows.get(r)?.members ?? 0;
    if (!(n >= DAY_FLOOR)) removed.add(r);                   // the per-day floor
  }
  const cellsOf = (row: string) => (SERIES.find((s) => s.row === row)?.cells ?? []);
  for (;;) {
    const shown = offered.filter((r) => !removed.has(r));
    if (!shown.length || !exposesSmall(cells, shown.map(cellsOf))) break;
    const next = order.find((r) => shown.includes(r));
    if (!next) break;
    removed.add(next);
  }
  return { removed, noData: false };
}

// ===========================================================================
// 5. THE PERIODS A SCREEN ASKS FOR
// ===========================================================================

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function addDaysIso(iso: string, n: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}
function isMonday(iso: string): boolean {
  if (!ISO.test(iso)) return false;
  const d = new Date(iso + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso && d.getUTCDay() === 1;
}

/**
 * A period is 1 to MAX_PERIOD_WEEKS whole Monday-to-Friday weeks, named by
 * their Mondays -- the browser's week groups (runWeekGroups), which can merge
 * a short week into the next school week across a break, so the weeks need
 * not be consecutive. No Monday may appear twice in one call: two periods
 * sharing a week subtract to the rest. Whether a period's days fall in one
 * school year is checked against the days themselves (evaluate below).
 */
export function checkPeriods(raw: unknown): { ok: true; periods: string[][] } | { ok: false; reason: string } {
  if (!Array.isArray(raw) || !raw.length) return { ok: false, reason: "No periods were asked for." };
  if (raw.length > MAX_PERIODS) return { ok: false, reason: `At most ${MAX_PERIODS} periods can be asked for at once.` };
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || !p.length) return { ok: false, reason: "A period must name at least one week." };
    if (p.length > MAX_PERIOD_WEEKS) return { ok: false, reason: `A period is at most ${MAX_PERIOD_WEEKS} weeks.` };
    for (const w of p) {
      if (typeof w !== "string" || !isMonday(w)) return { ok: false, reason: "Each week is named by its Monday (YYYY-MM-DD)." };
      if (seen.has(w)) return { ok: false, reason: "A week can only be in one period." };
      seen.add(w);
    }
    out.push(p.slice().sort());
  }
  return { ok: true, periods: out };
}

export type StoredGroupDay = {
  yearid: number; date: string; axis: string; group: string; members: number;
  absentDays: number; fullDaysStrict: number; misrecordDaysByGap: number[]; partialDays: number;
};

/** A rate to one decimal, as runWeeklyRate rounds it, or null with no student-days. */
export function rateOf(memberDays: number, fullDays: number): number | null {
  return memberDays ? Math.round((1 - fullDays / memberDays) * 1000) / 10 : null;
}

export type PeriodAnswer = { key: string; value: number | null; rest: number | null; withheld: string | null };

/**
 * The served rates for one line over the periods asked for.
 *
 *   trendsDays  the school days on Trends (attendanceRunDays) in range, with
 *               their year: a period covers exactly those, so its days are
 *               always a subset of the whole-school axis.
 *   rows        the family's stored rows in range.
 *   offered     the family's rows this reader may see at the CHART_FLOOR;
 *               `order` the same, smallest first.
 *
 * Withheld codes: "few-days" (under MIN_PERIOD_DAYS), "no-data" (a school day
 * with no group rows), "small" (on some day the line was under DAY_FLOOR, or
 * the residual test took it). One code for the last two, so the answer does
 * not say which pool was small.
 */
export function evaluatePeriods(args: {
  series: Series; periods: string[][]; trendsDays: Map<string, number>;
  rows: StoredGroupDay[]; offered: string[]; order: string[]; misrecordAt: unknown;
}): { ok: true; periods: PeriodAnswer[]; vsRest: { yearid: number; periods: number; points: number } | null }
  | { ok: false; reason: string } {
  const { series, periods, trendsDays, rows, offered, order, misrecordAt } = args;
  const byDate = new Map<string, Map<string, StoredGroupDay>>();
  for (const r of rows) {
    if (!FAMILY_AXES[series.family].includes(r.axis)) continue;
    if (!byDate.has(r.date)) byDate.set(r.date, new Map());
    byDate.get(r.date)!.set(r.axis + ":" + r.group, r);
  }
  const dayVerdict = new Map<string, { removed: Set<string>; noData: boolean }>();
  const verdict = (date: string) => {
    let v = dayVerdict.get(date);
    if (!v) { v = withheldOnDay(series.family, byDate.get(date) ?? new Map(), offered, order); dayVerdict.set(date, v); }
    return v;
  };
  const wholeAxis = WHOLE_AXIS[series.family];
  const answers: PeriodAnswer[] = [];
  const gaps = new Map<number, number[]>();
  for (const weeks of periods) {
    const dates: string[] = [];
    const years = new Set<number>();
    for (const w of weeks) {
      for (let i = 0; i < 5; i++) {
        const d = addDaysIso(w, i);
        const y = trendsDays.get(d);
        if (y === undefined) continue;
        dates.push(d);
        years.add(y);
      }
    }
    if (years.size > 1) return { ok: false, reason: "A period cannot cross from one school year into the next." };
    const key = weeks[0];
    const no = (withheld: string): PeriodAnswer => ({ key, value: null, rest: null, withheld });
    if (dates.length < MIN_PERIOD_DAYS) { answers.push(no("few-days")); continue; }
    if (!offered.includes(series.row)) { answers.push(no("small")); continue; }
    let noData = false, small = false;
    for (const d of dates) {
      const v = verdict(d);
      if (v.noData) noData = true;
      else if (v.removed.has(series.row)) small = true;
    }
    if (noData) { answers.push(no("no-data")); continue; }
    if (small) { answers.push(no("small")); continue; }
    let md = 0, full = 0, wholeMd = 0, wholeFull = 0;
    for (const d of dates) {
      const day = byDate.get(d)!;
      const g = day.get(series.row)!;
      md += g.members;
      full += fullDaysAt(g, misrecordAt);
      for (const [k, r] of day) {
        if (!k.startsWith(wholeAxis + ":")) continue;
        wholeMd += r.members;
        wholeFull += fullDaysAt(r, misrecordAt);
      }
    }
    const restMd = wholeMd - md, restFull = wholeFull - full;
    const value = rateOf(md, full);
    const rest = restMd > 0 ? rateOf(restMd, restFull) : null;
    answers.push({ key, value, rest, withheld: value === null ? "no-data" : null });
    if (value !== null && rest !== null) {
      const y = [...years][0];
      if (!gaps.has(y)) gaps.set(y, []);
      // The unrounded gap, so the average is not an average of roundings.
      gaps.get(y)!.push(((1 - full / md) - (1 - restFull / restMd)) * 100);
    }
  }
  const newest = gaps.size ? Math.max(...gaps.keys()) : null;
  const g = newest === null ? [] : gaps.get(newest)!;
  return {
    ok: true, periods: answers,
    vsRest: newest === null ? null : {
      yearid: newest, periods: g.length,
      points: Math.round((g.reduce((a, b) => a + b, 0) / g.length) * 10) / 10,
    },
  };
}
