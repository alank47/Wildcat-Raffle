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
 * withholdResiduals. Listed this way round so a role added to SUBGROUP_ROLES
 * later is tested by default, not exempt by default.
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
// zero and fewer than ten students? If so, the smallest row whose going closes
// it is withheld -- or, when no single row does, one whole group type for
// that answer -- and the question is asked again.
//
//   1. Each group type on its own first (race, English Learner yes/no,
//      classification): its residual -- students in none of its shown rows --
//      must be 0 or 10+. MULTI-RACE STUDENTS ERR TOWARD WITHHOLDING: a
//      non-Hispanic student with two race codes is in two race rows, so
//      subtracting both takes them out twice. If 1 to 9 students sit in two
//      or more shown rows of one type, that alone withholds a row.
//   2. Then every type together. The English Learner yes/no rows are the
//      classification's EL row and everyone else, so a row withheld from one
//      type can come straight back through another. Two types can also nearly
//      coincide; their difference is then a handful of students.
//
// HOW "ANY SUM OR DIFFERENCE" IS CHECKED, without trying them all. Put the
// students into cells: everyone in exactly the same shown rows is one cell. A
// sum or difference of rows can only ever count whole cells. A combination
// that counts nothing in any cell of ten or more students, and something in
// the small ones, exists exactly when the shown rows -- read only across the
// big cells -- are linearly dependent in a way they are not across every
// cell. Matrix rank answers that exactly, on whole numbers (rankOf). Only the
// small cells are ever searched, and only in sets of fewer than ten students.
//
// ADMINS ARE NOT PUT THROUGH THIS (SEES_EVERY_GROUP). For them the answer is
// byte-for-byte what it was before this test existed.

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
 * figure for more than zero and fewer than SMALL_GROUP students?
 *
 * `everyone` is the number of students in the whole-school figure; members
 * are positions 0..everyone-1.
 */
export function exposesSmallPool(rows: Pooled[], everyone: number, work?: { left: number }): boolean {
  // 1. DOUBLE COUNTING INSIDE ONE TYPE -- multi-race students -- errs toward
  // withholding: 1 to 9 students in two or more shown rows of one type is a
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
    if (twice > 0 && twice < SMALL_GROUP) return true;
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
  const big = all.filter((k) => cellList[k].size >= SMALL_GROUP);
  const bigRank = rankOf(m, big, work);
  // Every combination that cancels on all the big cells cancels everywhere:
  // whatever the reader works out, it includes ten or more students.
  if (bigRank === full) return false;

  // Small cells some such combination can rest on. The others never matter.
  const live = all.filter((k) => cellList[k].size < SMALL_GROUP && rankOf(m, [...big, k], work) > bigRank);

  // Every largest set of live cells under SMALL_GROUP students. A combination
  // that counts nothing outside the set exists exactly when dropping the set's
  // columns loses rank. A smaller set inside it would lose rank too, so only
  // the largest sets need asking.
  const pick: number[] = [];
  const search = (from: number, used: number): boolean => {
    if (from === live.length) {
      const fits = live.some((k) => !pick.includes(k) && used + cellList[k].size < SMALL_GROUP);
      if (fits || !pick.length) return false;
      const rest = all.filter((k) => !pick.includes(k));
      return rankOf(m, rest, work) < full;
    }
    const k = live[from];
    if (used + cellList[k].size < SMALL_GROUP) {
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
  return `${lead}: added to or taken away from the figures shown here, ${one ? "its" : "their"} figures would give `
    + `the figures for fewer than ${SMALL_GROUP} students, which can identify them. `
    + `Administrators see ${one ? "it" : "them"}.`;
}

export const chronicBySubgroup = query({
  args: {
    /**
     * Days in session, from the same two fields Attendance Watch uses.
     *
     * AN ARGUMENT, NOT A SERVER CONSTANT, so the two screens cannot disagree
     * about who is chronic. The browser owns that number because a person
     * corrects it for holidays there.
     */
    schoolDays: v.number(),
  },
  handler: async (ctx, { schoolDays }) => {
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

    const days = Math.max(0, Math.round(Number(schoolDays) || 0));
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

    const att = await ctx.db.query("psAttendance").take(2000);
    const absentOf = new Map<string, number>();
    for (const a of att) {
      const n = String(a.studentNumber || "");
      const d = Number(a.daysAbsentYtd);
      if (n && Number.isFinite(d)) absentOf.set(n, d);
    }

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

    for (const [who, r] of restricted.entries()) {
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
    for (const r of restricted) {
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
    // into a figure for fewer than ten; only how many, per type, leaves here.
    const residual = SEES_EVERY_GROUP.includes(staff.role) ? null : withholdResiduals(kept, restricted.length);
    const shownCells = residual ? residual.shown : kept;

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
      // the same bytes as before and a tab opened before 10/11 -- which reads
      // none of this -- still draws every row it is sent.
      ...(residual ? { withheldGroups: residual.withheldGroups, withheld: residual.withheld } : {}),
    };
  },
});
