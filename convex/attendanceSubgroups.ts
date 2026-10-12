import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff } from "./identity";
import { reportedCategories, HISPANIC_LABEL } from "./raceRollup";

/**
 * CHRONIC ABSENTEEISM BY SUBGROUP.
 *
 * Asked for on 2026-09-22: Hispanic/Latino, African American, English
 * Learners, socioeconomically disadvantaged. This is the equity report every
 * state dashboard carries, and it is the one legitimate use of protected
 * characteristics in this app: it describes how the SCHOOL is doing by group,
 * and never says anything about a named child.
 *
 * SUPPRESSION HAPPENS HERE, NOT IN THE BROWSER, and that is the whole design
 * rather than a preference. This app's convention is counts on the server and
 * display rules in the browser -- but a small cell is not a display rule, it
 * is the privacy guarantee. disciplineAggregates.ts says it plainly: for
 * "aggregate only" to be a property rather than a claim, a cell small enough
 * to identify a child must never leave the server. Westbrook has 2 Pacific
 * Islander students and 3 Asian students; "50% of Pacific Islander students
 * are chronically absent" is a sentence about one specific child.
 *
 * WHAT THE SCHOOL-WIDE NUMBER DOES TO THIS SCREEN. Measured the same day:
 * 52.4% of all 618 students are chronically absent. So the subgroup rows are
 * not a way to find a smaller group to work with -- every row is roughly half
 * the students in it. The baseline is therefore returned alongside every row
 * and the screen leads with it, because a 55% subgroup rate reads as alarming
 * until you see that the school's own rate is 52%.
 *
 * SOCIOECONOMIC STATUS IS ABSENT AND SAYS SO. `students.lunchstatus` answers
 * HTTP 403 -- the field exists in PowerSchool and the plugin does not request
 * it -- and it was never in the 19-field manifest, so no probe had ever tried.
 * Returning a silent gap would read as "no disparity"; the response carries an
 * explicit `unavailable` entry naming the field and the fix.
 */

/** Below this many ENROLLED students a rate is noise and may identify. */
const SMALL_GROUP = 10;

/**
 * The chronic line: 10% of days in session.
 *
 * MUST MATCH WildcatRoster.ATTENDANCE_TIERS, which Attendance Watch uses, and
 * a test asserts they agree. Two thresholds would let one child be chronic on
 * the ranking and fine on this breakdown, which is the same reason Early
 * Warning reads its denominator off this screen rather than keeping its own.
 */
const CHRONIC = 0.10;
const SEVERE = 0.20;

/** Same three roles as the attendance ranking and the discipline breakdowns. */
const SUBGROUP_ROLES = ["admin", "superadmin", "pbis"];

/**
 * THE ROLES THAT SKIP THE RESIDUAL TEST (2026-10-11), and keep every row they
 * saw before it existed. Admins and superadmins are approved for an
 * individual's race (docs/field-sourcing-approval.md, 2026-08-19), and
 * discipline already exempts them the same way (suppressSmallCells). Anyone
 * else the gate lets in -- today that is the PBIS team -- goes through
 * withholdResiduals, is divided by the server's own day count (THE DAY
 * COUNT) and is counted over measured students only. Listed this way round
 * so a role added to SUBGROUP_ROLES later is tested by default, not exempt
 * by default.
 */
const SEES_EVERY_GROUP = ["admin", "superadmin"];


/** Reporting order: the groups the question named first, then the rest. */
const RACE_ORDER = [
  HISPANIC_LABEL,
  "Black or African American",
  "White",
  "Asian",
  "Native Hawaiian or Other Pacific Islander",
  "American Indian or Alaska Native",
];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Fewer measured students than this and a gap from the average is noise. */
const FRAGILE_GROUP = 60;

const ELA_LABELS: Record<string, string> = {
  EL: "English Learner",
  EO: "English Only",
  RFEP: "Reclassified fluent (RFEP)",
  IFEP: "Initially fluent (IFEP)",
  TBD: "Assessment pending",
};

/**
 * NAMED, NOT OMITTED. A group missing from an equity breakdown reads as a
 * group with no disparity, which is the most misleading way for data to be
 * absent. Each entry says what is missing, why, and what would fix it.
 */
const UNAVAILABLE_GROUPS = [
  {
    group: "Socioeconomically disadvantaged",
    reason:
      "PowerSchool has the meal-eligibility field but the Wildcat Hub plugin does not request it, "
      + "so it answers HTTP 403. It was never in the original 19-field manifest, so it had never been tried.",
    fix: "Add Students.LunchStatus to powerschool/plugin-v2.xml, bump the version, and have the SIS "
      + "administrator re-install the plugin. In California the state definition also counts parent "
      + "education level and foster, homeless or migrant status, which live in separate fields.",
  },
  {
    group: "Students with disabilities (IEP) and 504",
    reason:
      "The source is unconfirmed. docs/access-gap.md records manifest 12 and 13 as UNKNOWN: the data "
      + "could be in the SIS core, a state extension, a local custom field, SEIS, or Special Programs.",
    fix: "The registrar and SIS administrator have to say where it lives before a plugin can ask for it.",
  },
];

type Cell = {
  axis: string; group: string;
  enrolled: number; withAttendance: number; chronic: number; severe: number;
  /** Which students (positions in psRestricted) are in it. Never sent; the residual test reads it. */
  members: number[];
};

// ===========================================================================
// THE RESIDUAL TEST (owner's decision, 2026-10-11)
// ===========================================================================
//
// THE LEAK IT CLOSES. Every figure on this screen is a COUNT of students --
// enrolled, measured, chronic, severe -- and counts add up. Hiding a group of
// fewer than ten does not hide it if the reader can subtract it back out.
// Measured on production 2026-10-11: 607 enrolled, 555 Hispanic, 47 Black.
// Hispanic wins the race question (raceRollup.ts), so those two rows never
// share a student, and the whole school minus both is the other 5 students:
// their chronic and severe counts, to the student. The ten-student floor
// exists to stop exactly that.
//
// HIDING THE WHOLE-SCHOOL FIGURE WOULD NOT FIX IT. "Current English Learner"
// and "Not currently an English Learner" between them hold every student, so
// the reader can rebuild the total from those two rows and subtract anyway.
//
// SO THE QUESTION IS ASKED OF THE ANSWER AS A WHOLE: can any sum or difference
// of the figures it holds -- rows and the whole school -- describe more than
// zero and fewer than ten students (twenty since the review: STEADY_FLOOR,
// below)? If so, the smallest row whose going closes
// it is withheld -- or, when no single row does, one whole group type for
// that answer -- and the question is asked again.
//
//   1. Each group type on its own first (race, English Learner yes/no,
//      classification): its residual -- students in none of its shown rows --
//      must be 0 or STEADY_FLOOR+. MULTI-RACE STUDENTS ERR TOWARD
//      WITHHOLDING: a non-Hispanic student with two race codes is in two race
//      rows, so subtracting both takes them out twice. If 1 to 19 students
//      sit in two or more shown rows of one type, that alone withholds a row.
//   2. Then every type together. The English Learner yes/no rows are the
//      classification's EL row and everyone else, so a row withheld from one
//      type can come straight back through another. Two types can also nearly
//      coincide; their difference is then a handful of students.
//
// HOW "ANY SUM OR DIFFERENCE" IS CHECKED, without trying them all. Put the
// students into cells: everyone in exactly the same shown rows is one cell. A
// sum or difference of rows can only ever count whole cells. A combination
// that counts nothing in any cell of STEADY_FLOOR or more students, and
// something in the small ones, exists exactly when the shown rows -- read
// only across the big cells -- are linearly dependent in a way they are not
// across every cell. Matrix rank answers that exactly, on whole numbers
// (rankOf). Only the small cells are ever searched, and only in sets of fewer
// than STEADY_FLOOR students.
//
// ADMINS ARE NOT PUT THROUGH THIS (SEES_EVERY_GROUP). For them the answer is
// byte-for-byte what it was before this test existed.
//
// THE TEST ASKS FOR 20, NOT 10 (review, 2026-10-11): STEADY_FLOOR. It runs on
// one answer at a time and remembers nothing, and the roster moves between
// copies. Asking for 10 made a row flip the moment a pool crossed 10, and two
// answers either side of the flip subtract: Westbrook's 5 plus 5 new students
// put the Black row back on the next copy, and the first answer's whole
// school minus Hispanic, minus the second answer's Black row, was the first
// answer's 5 again, chronic and severe to the student. With 20, a row only
// changes sides where a pool crosses 20, so the pool the other answer hands
// back holds 10 or more unless 10 or more students moved in one step. Rows of
// 10 to 19 are withheld from these readers the same way, because a group
// crossing the display floor of 10 is the same flip ("Assessment pending"
// rises with new enrolees and falls as they are assessed).
//
// CHOSEN OVER the two other ways the review offered: keeping each year's
// withheld rows and only ever adding to them (state a query cannot write,
// and it does nothing for a row that is shown first and withheld later), and
// giving these readers race only as Hispanic / not Hispanic (stable, but only
// for race). WHAT IT CANNOT CLOSE, said so it is not mistaken for closed: live
// counts move, and a reader who keeps two answers sees each change between
// them in the rows it belongs to. One new enrolee between two copies shows in
// the rows that student is in. Only a frozen roster would stop that, and the
// screen would then describe last month's school.

/**
 * The residual test's floor, for readers outside SEES_EVERY_GROUP: no sum or
 * difference of what they hold may describe 1 to 19 students. Ten above the
 * display floor so that a step of fewer than ten students cannot flip a row
 * and hand back a pool under SMALL_GROUP (see above).
 */
const STEADY_FLOOR = SMALL_GROUP + 10;

/** Anything with members, so the test can run on rows of any kind. */
type Pooled = { axis: string; group: string; enrolled: number; members: number[] };

/**
 * A ceiling on the arithmetic for one answer. Westbrook's groups need a few
 * dozen rank checks; this is far above that. Reaching it means the groups
 * overlap in ways nobody has measured, and THEN EVERY ROW IS WITHHELD rather
 * than shipping an answer the test did not finish checking.
 */
const RESIDUAL_WORK_LIMIT = 2_000_000;
const OUT_OF_WORK = new Error("residual test: work limit reached");

/**
 * The rank of the 0/1 matrix `m`, reading only the columns in `cols`.
 *
 * WHOLE NUMBERS, NOT FLOATING POINT. Fraction-free (Bareiss) elimination
 * keeps every entry an exact integer -- each one is a determinant of the
 * matrix -- so the division is always exact and a rank is never misjudged
 * by a rounding error. BigInt because those determinants can outgrow 2^53
 * on a large enough matrix.
 */
export function rankOf(m: number[][], cols: number[], work?: { left: number }): number {
  const a = m.map((row) => cols.map((c) => BigInt(row[c] ? 1 : 0)));
  const height = a.length, width = cols.length;
  if (work) {
    work.left -= height * width * Math.max(1, Math.min(height, width));
    if (work.left < 0) throw OUT_OF_WORK;
  }
  let rank = 0;
  let prev = BigInt(1);
  for (let c = 0; c < width && rank < height; c++) {
    let p = rank;
    while (p < height && a[p][c] === BigInt(0)) p++;
    if (p === height) continue;
    if (p !== rank) { const t = a[p]; a[p] = a[rank]; a[rank] = t; }
    const pivot = a[rank][c];
    for (let r = rank + 1; r < height; r++) {
      const f = a[r][c];
      for (let k = c + 1; k < width; k++) a[r][k] = (a[r][k] * pivot - f * a[rank][k]) / prev;
      a[r][c] = BigInt(0);
    }
    prev = pivot;
    rank++;
  }
  return rank;
}

/**
 * Could someone holding these rows and the whole-school total work out a
 * figure for more than zero and fewer than STEADY_FLOOR students?
 *
 * `everyone` is the number of students in the whole-school figure; members
 * are positions 0..everyone-1.
 */
export function exposesSmallPool(rows: Pooled[], everyone: number, work?: { left: number }): boolean {
  // 1. DOUBLE COUNTING INSIDE ONE TYPE -- multi-race students -- errs toward
  // withholding: 1 to 19 students in two or more shown rows of one type is a
  // pool, whatever the rank test below would say about it.
  const timesIn = new Map<string, Map<number, number>>();
  for (const r of rows) {
    let seen = timesIn.get(r.axis);
    if (!seen) { seen = new Map(); timesIn.set(r.axis, seen); }
    for (const i of r.members) seen.set(i, (seen.get(i) ?? 0) + 1);
  }
  for (const seen of timesIn.values()) {
    let twice = 0;
    for (const n of seen.values()) if (n >= 2) twice++;
    if (twice > 0 && twice < STEADY_FLOOR) return true;
  }

  // 2. THE CELLS: students in exactly the same shown rows.
  const inRows = new Map<number, number[]>();
  rows.forEach((r, j) => {
    for (const i of r.members) {
      let list = inRows.get(i);
      if (!list) { list = []; inRows.set(i, list); }
      if (list[list.length - 1] !== j) list.push(j);
    }
  });
  const cells = new Map<string, { size: number; rows: number[] }>();
  const nowhere = everyone - inRows.size;
  if (nowhere > 0) cells.set("", { size: nowhere, rows: [] });
  for (const list of inRows.values()) {
    const key = list.join(",");
    const c = cells.get(key);
    if (c) c.size++;
    else cells.set(key, { size: 1, rows: list });
  }
  const cellList = [...cells.values()];

  // One line per figure the reader holds -- the whole school first, then each
  // row -- and one column per cell: 1 where that figure counts that cell.
  const m: number[][] = [cellList.map(() => 1)];
  rows.forEach((_, j) => m.push(cellList.map((c) => (c.rows.includes(j) ? 1 : 0))));

  const all = cellList.map((_, k) => k);
  const full = rankOf(m, all, work);
  const big = all.filter((k) => cellList[k].size >= STEADY_FLOOR);
  const bigRank = rankOf(m, big, work);
  // Every combination that cancels on all the big cells cancels everywhere:
  // whatever the reader works out, it includes STEADY_FLOOR or more students.
  if (bigRank === full) return false;

  // Small cells some such combination can rest on. The others never matter.
  const live = all.filter((k) => cellList[k].size < STEADY_FLOOR && rankOf(m, [...big, k], work) > bigRank);

  // Every largest set of live cells under STEADY_FLOOR students. A combination
  // that counts nothing outside the set exists exactly when dropping the set's
  // columns loses rank. A smaller set inside it would lose rank too, so only
  // the largest sets need asking.
  const pick: number[] = [];
  const search = (from: number, used: number): boolean => {
    if (from === live.length) {
      const fits = live.some((k) => !pick.includes(k) && used + cellList[k].size < STEADY_FLOOR);
      if (fits || !pick.length) return false;
      const rest = all.filter((k) => !pick.includes(k));
      return rankOf(m, rest, work) < full;
    }
    const k = live[from];
    if (used + cellList[k].size < STEADY_FLOOR) {
      pick.push(k);
      const hit = search(from + 1, used + cellList[k].size);
      pick.pop();
      if (hit) return true;
    }
    return search(from + 1, used);
  };
  return search(0, 0);
}

/** Smallest first, then by name, so the same data always withholds the same row. */
const bySize = (a: Pooled, b: Pooled) =>
  a.enrolled - b.enrolled || a.axis.localeCompare(b.axis) || a.group.localeCompare(b.group);

/**
 * The rows a reader outside SEES_EVERY_GROUP may have, and a count of the rest
 * by type. A withheld row leaves as a number and a sentence: never its name,
 * never its figures.
 */
export function withholdResiduals<C extends Pooled>(cells: C[], everyone: number) {
  const work = { left: RESIDUAL_WORK_LIMIT };
  let shown = cells.slice();
  const held: C[] = [];
  let ranOut = false;

  // What to withhold when `scope` has a gap, in the order the owner allowed:
  //   a. the smallest single row whose going closes every gap;
  //   b. failing that, one whole type for this answer, fewest rows first --
  //      two types that nearly coincide need one of them gone entirely, and
  //      half of each would lose more;
  //   c. failing that, the smallest row, and the loop asks again.
  const settle = (scope: C[]): C[] => {
    const order = scope.slice().sort(bySize);
    const closes = (gone: C[]) => !exposesSmallPool(scope.filter((x) => !gone.includes(x)), everyone, work);
    const one = order.find((c) => closes([c]));
    if (one) return [one];
    const types = [...new Set(order.map((c) => c.axis))]
      .map((axis) => order.filter((c) => c.axis === axis))
      .sort((a, b) => a.length - b.length
        || a.reduce((n, c) => n + c.enrolled, 0) - b.reduce((n, c) => n + c.enrolled, 0)
        || a[0].axis.localeCompare(b[0].axis));
    return types.find((t) => closes(t)) ?? [order[0]];
  };
  const drop = (gone: C[]) => {
    shown = shown.filter((x) => !gone.includes(x));
    held.push(...gone);
  };

  try {
    // 1. Each type on its own: the residual test as the owner put it.
    for (const axis of [...new Set(cells.map((c) => c.axis))]) {
      for (;;) {
        const mine = shown.filter((c) => c.axis === axis);
        if (!mine.length || !exposesSmallPool(mine, everyone, work)) break;
        drop(settle(mine));
      }
    }
    // 2. Every type together.
    while (shown.length && exposesSmallPool(shown, everyone, work)) drop(settle(shown));
  } catch (e) {
    if (e !== OUT_OF_WORK) throw e;
    ranOut = true;
    held.push(...shown);
    shown = [];
  }

  const perAxis = new Map<string, number>();
  for (const c of held) perAxis.set(c.axis, (perAxis.get(c.axis) ?? 0) + 1);
  const withheld = [...perAxis.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([axis, groups]) => ({ axis, groups, reason: withheldReason(groups, ranOut) }));
  return { shown, withheldGroups: held.length, withheld };
}

/** Said in words, for the screen. The count is the only number in it. */
function withheldReason(groups: number, ranOut: boolean): string {
  const one = groups === 1;
  const lead = `${groups} more group${one ? "" : "s"} of ${SMALL_GROUP} or more students ${one ? "is" : "are"} not shown at your access level`;
  if (ranOut) {
    return `${lead}: the check that no figure here can be narrowed to fewer than ${SMALL_GROUP} students `
      + `could not finish, so nothing is shown that it did not clear. Administrators see ${one ? "it" : "them"}.`;
  }
  return `${lead}: added to or taken away from the figures shown here, now or once a few students join or leave, `
    + `${one ? "its" : "their"} figures could give the figures for fewer than ${SMALL_GROUP} students, which can `
    + `identify them. Administrators see ${one ? "it" : "them"}.`;
}

/**
 * What a tab that has not said it can show a withheld group (no `withheldOk`)
 * is told when the answer withholds one. That is every tab still running a
 * screen from before 10/11: it draws only the rows it is sent, says a missing
 * group is one "smaller" than 10, and drops a type's heading when every row
 * of it is withheld -- so the 47-student Black row would read as a group under
 * 10. Nobody is asked to do anything: the tab updates itself.
 */
export const WITHHELD_NEEDS_UPDATE = "Some student groups are now held back at your access level, and this screen "
  + "cannot yet say which types or why. It shows them once the Hub updates itself.";

// ===========================================================================
// THE DAY COUNT, WORKED OUT HERE FOR EVERY READER THE RESIDUAL TEST RUNS ON
// (review, 2026-10-11)
// ===========================================================================
//
// THE LEAK IT CLOSES. Who is chronic depends on the divisor, and the divisor
// was whatever the caller sent. Asked at 10a-1 days and again at 10a+9, every
// row's chronic count moved by exactly its students with `a` absences; PBIS
// holds each student's absences by name (Attendance Watch), so a student
// whose count was unique in the school had their ethnicity and English
// Learner status read straight off the rows. No residual test can see that:
// it is the same rows, divided twice.
//
// SO A TESTED READER'S DIVISOR IS THE SERVER'S, whatever the tab sends, and
// the answer's `schoolDays` says which count was used. Admins keep the
// argument, as before.
//
// THE SAME COUNT AS EVERY TAB'S, so the screens still agree on who is
// chronic: WildcatRoster.schoolCalendar (wildcat-roster.js), ported for the
// one figure it returns -- the days before today with a row, the weekdays a
// late copy has not vouched for, and today once the year totals hold it --
// read from the same two tables (psAbsenceDayTotals as dailyAbsenceSeries
// sends it, and psAttendance's newest stamp, which is schoolAttendance's
// lastSyncedAt) at the server's own clock in Los Angeles. A test runs both
// on the same tables and clocks, and they must agree. Convex may hand back an
// answer worked out a little earlier until one of those tables is written;
// the count does not move at midnight (yesterday leaves "today" and joins the
// days before it), and today joins with the totals' noon copy, which is a
// write, so such an answer still holds the right count.

/** MUST MATCH CALENDAR_SEEN_HOUR in wildcat-roster.js: a copy stamped at or after this hour (Los Angeles) has seen that day. */
const CALENDAR_SEEN_HOUR = 10;
/** MUST MATCH dailyAbsenceSeries' CAP (attendanceList.ts): past it the count is unknown, never a slice. */
const DAY_TABLE_CAP = 400;

/** The Los Angeles calendar day and hour of an instant, or null. As wildcat-roster.js laDayHour. */
function laDayHour(ms: number): { day: string; hour: number } | null {
  if (!Number.isFinite(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hour = Number(get("hour"));
    return { day: get("year") + "-" + get("month") + "-" + get("day"), hour: hour === 24 ? 0 : hour };
  } catch {
    return null;
  }
}

/** "YYYY-MM-DD" when it is a real calendar day, else null. Calendar days are UTC, never instants. */
function realDay(iso: string): string | null {
  const s = String(iso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}
const shiftDay = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const weekday = (iso: string) => { const w = new Date(iso + "T00:00:00Z").getUTCDay(); return w !== 0 && w !== 6; };

/**
 * School days so far, as WildcatRoster.schoolCalendar counts them for a tab
 * whose clock reads `nowMs`. `raw` is psAbsenceDayTotals as read (first row
 * first); `totalsAt` is the newest psAttendance stamp. Null days, with the
 * reason, wherever the tab's count would be unknown.
 */
export function schoolDaysSoFar(raw: Array<{ date?: unknown; syncedAt?: unknown }>, totalsAt: string | null,
  nowMs: number): { days: number | null; reason: string } {
  const unknown = (reason: string) => ({ days: null, reason });
  const now = laDayHour(nowMs);
  if (!now) return unknown("Today's date could not be read.");
  const today = now.day;
  if (raw.length > DAY_TABLE_CAP) {
    return unknown("The school-day table is longer than this reads, so it cannot be counted. Tell an administrator.");
  }
  // What dailyAbsenceSeries sends a tab asking with today's date.
  const usable = raw.map((r) => String(r.date || "").slice(0, 10)).filter((d) => d.length === 10 && d <= today).sort();
  const seen = new Set<string>();
  for (const d of usable) { const x = realDay(d); if (x) seen.add(x); }
  const dates = [...seen].sort();
  const onFile = usable.length;
  const la = laDayHour(Date.parse(raw.length ? String(raw[0].syncedAt ?? "") : ""));
  if (!onFile && !la) {
    return unknown("No school days are on file right now: the twice-daily copy from PowerSchool is part-way "
      + "through, or school has not started.");
  }
  if (!la) return unknown("The school days carry no copy time, so nothing can vouch for them.");
  const yesterday = shiftDay(today, -1);
  let confirmed = la.hour >= CALENDAR_SEEN_HOUR ? la.day : shiftDay(la.day, -1);
  if (confirmed > yesterday) confirmed = yesterday;
  if (!onFile) return { days: 0, reason: "" };
  const first = realDay(usable[0]) || (dates.length >= onFile ? dates[0] : null);
  if (!first) return unknown("The first school day could not be read.");

  const before = Math.max(0, onFile - dates.filter((d) => d >= today).length);
  let estimated = 0;
  for (let d = shiftDay(confirmed, 1), n = 0; d <= yesterday && n < 400; d = shiftDay(d, 1), n++) {
    if (weekday(d) && !seen.has(d) && d >= first) estimated++;
  }
  const totals = laDayHour(Date.parse(String(totalsAt || "")));
  const rebuildSawToday = la.day === today && la.hour >= CALENDAR_SEEN_HOUR;
  const todayCounted = !!totals && totals.day === today && totals.hour >= CALENDAR_SEEN_HOUR && today >= first
    && (seen.has(today) || (!rebuildSawToday && weekday(today)));
  const days = before + estimated + (todayCounted ? 1 : 0);
  const countedTo = todayCounted ? today : yesterday;
  let weekdays = 0;
  for (let d = first, n = 0; d <= countedTo && n < 800; d = shiftDay(d, 1), n++) if (weekday(d)) weekdays++;
  if (weekdays >= 10 && days < weekdays * 0.5) {
    return unknown(`Far fewer school days are on file (${days}) than weekdays since the first one (${weekdays}), `
      + "so the count cannot be trusted. Tell an administrator.");
  }
  return { days, reason: "" };
}

export const chronicBySubgroup = query({
  args: {
    /**
     * Days in session: the tab's count, the one every attendance tab divides by.
     *
     * AN ADMIN'S ANSWER DIVIDES BY IT, as it always has. Everyone the
     * residual test runs on is divided by the server's own count instead
     * (THE DAY COUNT, above): a divisor the reader picks is a threshold the
     * reader moves.
     */
    schoolDays: v.number(),
    /**
     * Sent by the screen from 2026-10-11 on, which says under each type how
     * many groups are withheld and why. A screen from before never sends it,
     * and is told in words instead (WITHHELD_NEEDS_UPDATE).
     */
    withheldOk: v.optional(v.boolean()),
  },
  handler: async (ctx, { schoolDays, withheldOk }) => {
    const staff = await requireStaff(ctx);
    // THE ROLES ONLY, NOT the per-person Attendance Watch grant (review
    // finding, 2026-09-30). This breakdown is by federal race/ethnicity
    // rollup, and docs/field-sourcing-approval.md records who may see a race
    // aggregate: admin, superadmin, pbis. Extending it to a grant holder is
    // the owner's decision, not a side effect.
    if (!SUBGROUP_ROLES.includes(staff.role)) {
      return {
        allowed: false,
        reason:
          "Attendance breakdowns by student group are limited to administrators and the PBIS team. " +
          "Ask an administrator to set your access level to PBIS Team.",
        rows: [], baseline: null, unavailable: [], suppressedGroups: 0,
      };
    }

    // EVERYONE OUTSIDE SEES_EVERY_GROUP -- today the PBIS team -- gets the
    // residual test, the server's day count, and measured students only.
    const tested = !SEES_EVERY_GROUP.includes(staff.role);

    const att = await ctx.db.query("psAttendance").take(2000);
    let days = Math.max(0, Math.round(Number(schoolDays) || 0));
    if (tested) {
      // THE SERVER'S COUNT, never the tab's (THE DAY COUNT, above). The
      // totals' stamp is schoolAttendance's lastSyncedAt, worked out the
      // same way.
      let totalsAt: string | null = null;
      for (const a of att) {
        const s = typeof a.syncedAt === "string" ? a.syncedAt : null;
        if (s && (!totalsAt || s > totalsAt)) totalsAt = s;
      }
      const counted = schoolDaysSoFar(await ctx.db.query("psAbsenceDayTotals").take(DAY_TABLE_CAP + 1), totalsAt,
        Date.now());
      if (counted.days === null) {
        return {
          allowed: true, notYet: true,
          reason: "Student groups need the number of school days so far, and it cannot be counted right now. "
            + counted.reason,
          rows: [], baseline: null, unavailable: [], suppressedGroups: 0,
        };
      }
      days = counted.days;
    }
    if (!days) {
      return {
        allowed: true, notYet: true,
        reason: "No school days counted yet, so no rate can be worked out. Check the start date.",
        rows: [], baseline: null, unavailable: [], suppressedGroups: 0,
      };
    }

    const restricted = await ctx.db.query("psRestricted").take(2000);
    if (!restricted.length) {
      return {
        allowed: true, notYet: true,
        reason:
          "Student group data has not been loaded. PowerSchool grants it and the query works; " +
          "the sync has not populated psRestricted.",
        rows: [], baseline: null, unavailable: [], suppressedGroups: 0,
      };
    }

    const absentOf = new Map<string, number>();
    for (const a of att) {
      const n = String(a.studentNumber || "");
      const d = Number(a.daysAbsentYtd);
      if (n && Number.isFinite(d)) absentOf.set(n, d);
    }

    // THE STUDENTS THE ANSWER COUNTS. For a tested reader, only those with an
    // attendance row (review, 2026-10-11). Every row carries two counts,
    // enrolled and measured, so their difference is a second figure per row
    // that the residual test never saw: with 1 to 9 students not yet measured
    // in the school, each row said how many of them it held -- and Attendance
    // Watch names them on its "no attendance on file" line, so a new
    // enrolee's ethnicity and English Learner status were read off the rows.
    // Left out, they are in no figure at all, and the floor and the residual
    // test are applied to measured students, which is what every rate on
    // this screen describes anyway. Nothing drawn changes: the screen shows
    // measured students and never `enrolled`. Admins count everyone, as before.
    const students = tested ? restricted.filter((r) => absentOf.has(String(r.studentNumber || ""))) : restricted;

    const cells = new Map<string, Cell>();
    const bump = (axis: string, group: string, absent: number | undefined, who: number) => {
      const key = axis + "|" + group;
      let c = cells.get(key);
      if (!c) { c = { axis, group, enrolled: 0, withAttendance: 0, chronic: 0, severe: 0, members: [] }; cells.set(key, c); }
      c.enrolled++;
      c.members.push(who);
      // ABSENCE IS NOT ZERO. A student with no attendance row has not been
      // measured, and counting them as present would dilute every rate on
      // this screen with children nobody has data for.
      if (absent === undefined) return;
      c.withAttendance++;
      const rate = absent / days;
      if (rate >= CHRONIC) c.chronic++;
      if (rate >= SEVERE) c.severe++;
    };

    let unknownEthnicity = 0, unclassified = 0;
    const unmappedCodes = new Set<string>();

    for (const [who, r] of students.entries()) {
      const absent = absentOf.get(String(r.studentNumber || ""));

      // The California rule, reused rather than restated: Hispanic ethnicity
      // wins and race codes are not reported separately for those students.
      // Ignoring it reported this predominantly Hispanic school as White.
      const rep = reportedCategories({ fedEthnicity: r.fedEthnicity, raceCodes: r.raceCodes });
      for (const code of rep.unmapped) unmappedCodes.add(code);
      if (rep.ethnicity === "unknown") unknownEthnicity++;
      if (!rep.categories.length) unclassified++;
      for (const cat of rep.categories) bump("race", cat, absent, who);

      const ela = String(r.elaStatus || "").trim().toUpperCase();
      // The grouping a school acts on first: currently an EL, or not.
      bump("el", ela === "EL" ? "Current English Learner" : "Not currently an English Learner", absent, who);
      // ...and the full four-way status, because RFEP is the interesting one.
      bump("ela", ELA_LABELS[ela] ?? (ela ? ela : "Not recorded"), absent, who);
    }

    // The baseline every row is read against.
    let allEnrolled = 0, allMeasured = 0, allChronic = 0, allSevere = 0;
    for (const r of students) {
      allEnrolled++;
      const absent = absentOf.get(String(r.studentNumber || ""));
      if (absent === undefined) continue;
      allMeasured++;
      const rate = absent / days;
      if (rate >= CHRONIC) allChronic++;
      if (rate >= SEVERE) allSevere++;
    }
    const baseline = {
      group: "Every student", enrolled: allEnrolled, withAttendance: allMeasured,
      chronic: allChronic, severe: allSevere,
      chronicPct: allMeasured ? round1((allChronic / allMeasured) * 100) : null,
      severePct: allMeasured ? round1((allSevere / allMeasured) * 100) : null,
    };

    const all = [...cells.values()];
    // THE SUPPRESSED ROWS NEVER BECOME ROWS. Only their number crosses.
    const kept = all.filter((c) => c.enrolled >= SMALL_GROUP);
    const suppressed = all.length - kept.length;

    // THE RESIDUAL TEST, for everyone outside SEES_EVERY_GROUP (2026-10-11).
    // A withheld row is a row of ten or more that subtraction would turn
    // into a figure for fewer than ten, or could once a few students join or
    // leave (STEADY_FLOOR); only how many, per type, leaves here.
    const residual = tested ? withholdResiduals(kept, students.length) : null;
    const shownCells = residual ? residual.shown : kept;

    // A TAB FROM BEFORE 10/11 is told in words when a group is withheld
    // (WITHHELD_NEEDS_UPDATE): it would draw the withheld row as a group under
    // ten. An answer that withholds nothing still reaches it as it always did.
    if (residual && residual.withheldGroups > 0 && withheldOk !== true) {
      return {
        allowed: true, notYet: true, reason: WITHHELD_NEEDS_UPDATE,
        rows: [], baseline: null, unavailable: [], suppressedGroups: 0,
      };
    }

    const rows = shownCells.map((c) => {
      const pct = c.withAttendance ? round1((c.chronic / c.withAttendance) * 100) : null;
      return {
        axis: c.axis, group: c.group,
        enrolled: c.enrolled, withAttendance: c.withAttendance,
        chronic: c.chronic, severe: c.severe,
        chronicPct: pct,
        severePct: c.withAttendance ? round1((c.severe / c.withAttendance) * 100) : null,
        /** Points above or below the school's own rate. The only comparison worth making. */
        vsSchool: pct !== null && baseline.chronicPct !== null ? round1(pct - baseline.chronicPct) : null,
        /**
         * TOO FEW TO READ A DIFFERENCE INTO, even though the group is large
         * enough to report. Black or African American is 47 students: one
         * child moving changes the rate by two points, so a three-point gap
         * from the school average is not a finding. Reported so the screen can
         * say so rather than inviting the reader to over-read it.
         */
        fragile: c.withAttendance < FRAGILE_GROUP,
      };
    }).sort((a, b) => {
      if (a.axis !== b.axis) return a.axis.localeCompare(b.axis);
      if (a.axis === "race") {
        const ia = RACE_ORDER.indexOf(a.group), ib = RACE_ORDER.indexOf(b.group);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      }
      return b.enrolled - a.enrolled;
    });

    return {
      allowed: true,
      schoolDays: days,
      chronicAt: CHRONIC, severeAt: SEVERE,
      baseline,
      rows,
      suppressedGroups: suppressed,
      smallGroupFloor: SMALL_GROUP,
      fragileFloor: FRAGILE_GROUP,
      /** Students whose ethnicity question was never answered. A sync gap, not a fact. */
      unknownEthnicity,
      unclassified,
      unmappedRaceCodes: [...unmappedCodes],
      /** Groups the school asked for that this app cannot answer, and why. */
      unavailable: UNAVAILABLE_GROUPS,
      lastSyncedAt: restricted.reduce(
        (a: string | null, r) => (!a || String(r.syncedAt) > a ? String(r.syncedAt) : a), null),
      // LAST, AND ONLY FOR READERS THE TEST RAN ON, so an admin's answer is
      // the same bytes as before. A tab opened before 10/11 reads none of
      // this; it only ever gets here when nothing is withheld (see above).
      ...(residual ? { withheldGroups: residual.withheldGroups, withheld: residual.withheld } : {}),
    };
  },
});
