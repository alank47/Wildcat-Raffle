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

/**
 * An axis whose stored rows are CURRENT for a month: built, and not skipped
 * by a build since. A skipped axis keeps its rows from the build before (a
 * failed race read does not blank the Black line), but those rows lack every
 * day added since -- so until a build of that axis succeeds, the month is
 * not complete and the nightly mend rebuilds it (review, 2026-10-12: the
 * month's last rebuilds are nights 1-7 of the next month, and a read failing
 * on all of them used to leave its new days missing from that axis for good).
 */
export function currentAxes(m: { built: Array<{ axis: string; syncedAt: string }>; skipped: Array<{ axis: string; at: string }> }): string[] {
  return m.built.filter((b) => !m.skipped.some((s) => s.axis === b.axis && s.at >= b.syncedAt)).map((b) => b.axis);
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

/**
 * A group is offered only when its TYPICAL day this year has this many
 * students (drops IFEP at 28) -- and so is every pool the lines offered and
 * the whole school subtract to (linesForYear, section 5).
 */
export const CHART_FLOOR = 30;
/** And a week is drawn only when EVERY school day in it has this many (and passes the residual test). */
export const DAY_FLOOR = 10;
/** Under this a group is offered but "small": never coloured, and its signals are "worth a look". */
export const SMALL_CHART_GROUP = 60;
/** Group sizes leave rounded to the nearest 5, and nothing else about membership leaves at all. */
export const SIZE_ROUND = 5;
/**
 * A WEEK with fewer school days than this is withheld in EVERY period that
 * contains it, the way a small week is: served inside a merged period, it
 * would come back as that period less the week after it, asked for alone --
 * a daily rate (review, 2026-10-12).
 */
export const MIN_WEEK_DAYS = 2;
export const MAX_PERIOD_WEEKS = 4;
export const MAX_PERIODS = 120;

export function roundSize(n: number): number {
  return Math.round(n / SIZE_ROUND) * SIZE_ROUND;
}

/** "YYYY-MM-DD" in Los Angeles for an instant (an ISO string or ms), or null. */
export function laDayOf(at: unknown): string | null {
  const ms = typeof at === "number" ? at : Date.parse(String(at ?? ""));
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ms));
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
// 5. THE LINES A YEAR MAY SHOW: THE FLOOR OF 30 APPLIES TO WHAT CAN BE
//    WORKED OUT, NOT ONLY TO WHAT IS DRAWN (review, 2026-10-12)
// ===========================================================================
//
// THE LEAK. IFEP (28 on a typical day) is not charted. But Current English
// Learner, Not EL, English Only and RFEP, beside the whole school on Trends,
// subtract to the IFEP students plus the few pending assessment -- on most
// days of this year, exactly the IFEP students. A shift in that pool, set
// against the named absence lists, says which children are IFEP. The per-day
// test above only guards pools of 1 to 9; this one holds every pool to the
// owner's floor.
//
// THE RULE, on a TYPICAL day of the year (each cell's median over the school
// days whose rows add up):
//   - every line has at least CHART_FLOOR students, and
//   - no sum or difference of the lines and the whole school describes 1 to
//     CHART_FLOOR - 1 students.
// When that fails, lines go one at a time: the smallest line whose going
// settles it on its own, else the smallest. Decided on the year's medians,
// never on a day, so which line goes says nothing about any day. Each year
// is decided on its own figures, so last year's weeks are held to last
// year's sizes.

/** Each row's typical size over a year: the median of its members over the days it was built. */
export function typicalRows(rows: StoredGroupDay[]): Map<string, number> {
  const per = new Map<string, number[]>();
  for (const r of rows) {
    const k = r.axis + ":" + r.group;
    if (!per.has(k)) per.set(k, []);
    per.get(k)!.push(r.members);
  }
  return new Map([...per].map(([k, xs]) => [k, median(xs) ?? 0]));
}

/** Each cell of a family on a typical day: the median of its size over the days whose rows add up. Null with none. */
export function typicalCells(family: string, rows: StoredGroupDay[]): Map<string, number> | null {
  const byDate = new Map<string, Map<string, { members: number }>>();
  for (const r of rows) {
    if (!(FAMILY_AXES[family] ?? []).includes(r.axis)) continue;
    if (!byDate.has(r.date)) byDate.set(r.date, new Map());
    byDate.get(r.date)!.set(r.axis + ":" + r.group, r);
  }
  const per = new Map<string, number[]>();
  for (const day of byDate.values()) {
    const cells = familyCells(family, day);
    if (!cells) continue;
    for (const [k, n] of cells) {
      if (!per.has(k)) per.set(k, []);
      per.get(k)!.push(n);
    }
  }
  if (!per.size) return null;
  return new Map([...per].map(([k, xs]) => [k, median(xs) ?? 0]));
}

/**
 * The lines of one family a year may show, from `candidates` (stored rows a
 * reader may see). `under`: a line under CHART_FLOOR on a typical day of the
 * year; `pool`: a line withheld so that no pool under CHART_FLOOR can be
 * worked out. A candidate with no rows that year is kept (its days are "no
 * data", never "small").
 */
export function linesForYear(family: string, yearRows: StoredGroupDay[], candidates: string[]):
  { kept: string[]; under: string[]; pool: string[] } {
  const typical = typicalRows(yearRows);
  const under = candidates.filter((r) => typical.has(r) && typical.get(r)! < CHART_FLOOR);
  let live = candidates.filter((r) => !under.includes(r));
  const cells = typicalCells(family, yearRows);
  const cellsOf = (row: string) => (SERIES.find((s) => s.row === row)?.cells ?? []);
  const exposes = (lines: string[]) => !!cells && lines.length > 0 && exposesSmall(cells, lines.map(cellsOf), CHART_FLOOR);
  const pool: string[] = [];
  while (exposes(live)) {
    const bySize = live.slice().sort((a, b) => ((typical.get(a) ?? 0) - (typical.get(b) ?? 0)) || (a < b ? -1 : a > b ? 1 : 0));
    const one = bySize.find((r) => !exposes(live.filter((x) => x !== r))) ?? bySize[0];
    live = live.filter((x) => x !== one);
    pool.push(one);
  }
  return { kept: live, under, pool };
}

// ===========================================================================
// 6. THE PERIODS A SCREEN ASKS FOR
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
export type VsRest = { yearid: number; periods: number; points: number; withinChance: boolean | null };

/**
 * THE SMALLEST THING SERVED IS ONE FINISHED WEEK OF AT LEAST MIN_WEEK_DAYS
 * SCHOOL DAYS, held on the server for every week -- never per call (review,
 * 2026-10-12). Checking only the period in front of it, the server served
 * the week in progress each morning with one more day in it, and a short
 * week inside a merged period: two answers subtracted to one day's rate,
 * and from a group of ~115 that was the EXACT number of its members out
 * that day. So a period is withheld when any week in it:
 *
 *   "open"      is not over: its Friday is today or later in Los Angeles,
 *               or one of its weekdays was not yet covered by its month's
 *               Trends build (a month built tonight covers up to
 *               yesterday). Then no later build can add a day to it.
 *   "few-days"  has fewer than MIN_WEEK_DAYS school days.
 *   "no-data"   has a school day with no group rows (or rows that do not
 *               add up), or group rows on a day Trends does not have: the
 *               two must hold the SAME days, or the week could gain one.
 *   "small"     holds a day where the line failed the per-day floor or the
 *               residual test, or the line is not shown that year
 *               (linesForYear). One code for these, so the answer does not
 *               say which pool was small.
 *
 * Decided week by week, so a week withheld is withheld in every period
 * containing it, and two periods can only ever differ by whole served weeks.
 *
 *   trendsDays    every Trends school day (attendanceRunDays) of the months
 *                 the periods touch, with its year
 *   builtThrough  per "YYYY-MM": the last day that month's Trends build
 *                 covered; a month with no Trends rows falls back to
 *                 `newestBuilt`, the last day the newest build covered
 *   rows          the family's stored rows in range
 *   offeredByYear per school year: the family's rows this reader may see
 *                 that year (linesForYear); `order` them, smallest first
 *   newestYear    the gap to the rest of the school is averaged over THIS
 *                 year's served weeks only -- the year the rules read
 *   spread        the school's between-student variance of the monthly
 *                 whole-day rate (rateSpread), for the chance band
 */
export function evaluatePeriods(args: {
  series: Series; periods: string[][]; trendsDays: Map<string, number>;
  builtThrough: Map<string, string>; newestBuilt: string | null; today: string;
  rows: StoredGroupDay[]; offeredByYear: Map<number, string[]>; order: string[]; misrecordAt: unknown;
  newestYear: number; spread: number | null;
}): { ok: true; periods: PeriodAnswer[]; vsRest: VsRest | null } | { ok: false; reason: string } {
  const { series, periods, trendsDays, builtThrough, newestBuilt, today, rows, offeredByYear, order, misrecordAt } = args;
  const byDate = new Map<string, Map<string, StoredGroupDay>>();
  for (const r of rows) {
    if (!FAMILY_AXES[series.family].includes(r.axis)) continue;
    if (!byDate.has(r.date)) byDate.set(r.date, new Map());
    byDate.get(r.date)!.set(r.axis + ":" + r.group, r);
  }
  const yearOf = (date: string) => trendsDays.get(date);
  const dayVerdict = new Map<string, { removed: Set<string>; noData: boolean }>();
  const verdict = (date: string) => {
    let v = dayVerdict.get(date);
    if (!v) {
      const offered = offeredByYear.get(yearOf(date)!) ?? [];
      v = withheldOnDay(series.family, byDate.get(date) ?? new Map(), offered, order.filter((r) => offered.includes(r)));
      dayVerdict.set(date, v);
    }
    return v;
  };
  const covered = (date: string) => {
    const through = builtThrough.get(date.slice(0, 7)) ?? newestBuilt;
    return !!through && through >= date;
  };
  const wholeAxis = WHOLE_AXIS[series.family];
  const answers: PeriodAnswer[] = [];
  const newest = { gaps: [] as number[], md: 0, restMd: 0, days: 0 };
  for (const weeks of periods) {
    const dates: string[] = [];
    const years = new Set<number>();
    let open = false, fewDays = false, mismatch = false;
    for (const w of weeks) {
      if (addDaysIso(w, 4) >= today) open = true;
      let inWeek = 0;
      for (let i = 0; i < 5; i++) {
        const d = addDaysIso(w, i);
        if (!covered(d)) open = true;
        const y = yearOf(d);
        if (y === undefined) { if (byDate.has(d)) mismatch = true; continue; }
        dates.push(d);
        years.add(y);
        inWeek++;
      }
      if (inWeek < MIN_WEEK_DAYS) fewDays = true;
    }
    if (years.size > 1) return { ok: false, reason: "A period cannot cross from one school year into the next." };
    const key = weeks[0];
    const no = (withheld: string): PeriodAnswer => ({ key, value: null, rest: null, withheld });
    if (open) { answers.push(no("open")); continue; }
    if (fewDays) { answers.push(no("few-days")); continue; }
    const year = [...years][0];
    if (!(offeredByYear.get(year) ?? []).includes(series.row)) { answers.push(no("small")); continue; }
    let noData = mismatch, small = false;
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
    if (value !== null && rest !== null && year === args.newestYear) {
      // The unrounded gap, so the average is not an average of roundings.
      newest.gaps.push(((1 - full / md) - (1 - restFull / restMd)) * 100);
      newest.md += md;
      newest.restMd += restMd;
      newest.days += dates.length;
    }
  }
  const k = newest.gaps.length;
  return {
    ok: true, periods: answers,
    vsRest: !k ? null : {
      yearid: args.newestYear, periods: k,
      points: Math.round((newest.gaps.reduce((a, b) => a + b, 0) / k) * 10) / 10,
      withinChance: gapWithinChance(newest.gaps, newest.md / newest.days, newest.restMd / newest.days, args.spread),
    },
  };
}

// ===========================================================================
// 7. IS A SMALL GROUP'S GAP WITHIN CHANCE FOR A GROUP THIS SIZE?
// ===========================================================================
//
// THE OLD TEST WAS WRONG BY SIX TIMES (review, 2026-10-12). It asked whether
// the average weekly gap was more than two standard errors of the group's
// own weekly gaps. That leaves out the biggest source of chance: WHO happens
// to be in a group of 47. Chronically absent students stay chronically
// absent, so a group that drew two of them sits below the rest of the school
// every week -- a steady gap with nothing behind it but the draw. On groups
// of 47 drawn at random (no true difference at all), it said "more than its
// weeks usually vary" about 30% of the time where 5% was meant.
//
// THE BAND NOW has both parts, as a variance of the average gap in points:
//   who is in the group:   spread x (1/n + 1/rest), the two-sample variance
//                          of a random split of the school into n and rest
//                          students (spread: the variance across students
//                          of their monthly whole-day rate, from the build)
//   how its weeks wobble:  the variance of the weekly gaps / their number
// and its critical value is Student's t on the degrees of freedom of that
// sum (Welch-Satterthwaite): about 2 when who-is-in-it dominates, larger
// when a few noisy weeks do. A calibration test draws random groups and
// holds the false alarm rate near or under 5%.

/** Two-sided 5% points of Student's t for 1 to 30 degrees of freedom; 2 past 30. */
const T95 = [12.71, 4.3, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.2, 2.18, 2.16, 2.14, 2.13,
  2.12, 2.11, 2.1, 2.09, 2.09, 2.08, 2.07, 2.07, 2.06, 2.06, 2.06, 2.05, 2.05, 2.05, 2.04];
export function tCrit95(df: number): number {
  if (!(df >= 1)) return T95[0];
  if (df > 30) return 2;
  return T95[Math.floor(df) - 1];
}

/**
 * Is an average gap of these weekly gaps (points) within what chance gives a
 * group of about `n` students against `rest` others? Null when it cannot be
 * said: fewer than 3 weeks, or no spread built yet.
 */
export function gapWithinChance(gaps: number[], n: number, rest: number, spread: number | null): boolean | null {
  const k = gaps.length;
  if (k < 3 || !(n > 0) || !(rest > 0) || spread === null || !(spread >= 0)) return null;
  const mean = gaps.reduce((a, b) => a + b, 0) / k;
  const who = spread * 10000 * (1 / n + 1 / rest);
  const weeks = gaps.reduce((a, g) => a + (g - mean) * (g - mean), 0) / (k - 1) / k;
  const total = who + weeks;
  if (!(total > 0)) return mean === 0;
  const df = weeks > 0 ? (total * total) / ((weeks * weeks) / (k - 1)) : Infinity;
  return Math.abs(mean) <= tCrit95(df) * Math.sqrt(total);
}
