/**
 * Academics: what a mark means, and when a cell may be reported.
 *
 * Pure and dependency-free so a plain-node test reaches it, for the same
 * reason views.ts, leaderboardRules.ts and accessRules.ts are.
 *
 * THIS FILE EXISTS BECAUSE THE SUPPRESSION RULES FOR GRADES ARE NOT THE ONES
 * FOR DISCIPLINE, and reusing disciplineAggregates.ts wholesale would have
 * been wrong in two specific ways found by review:
 *
 *   - Discipline suppresses on the DENOMINATOR, because referrals were scarce:
 *     six in the whole school. A group of 20 students with 2 referrals was
 *     safe to print. Academic failure is DENSE -- 976 D and F marks -- so a
 *     small NUMERATOR has to be withheld too, or a cell reads "2 of 20", which
 *     is a sentence about two identifiable children.
 *
 *   - Discipline's second axis counted EVENTS. Counting graded ROWS here can
 *     never bind: ten students carry about seventy grade rows, so the axis
 *     would be satisfied everywhere the first axis already allowed. It counts
 *     STUDENTS instead, the same unit as the privacy floor.
 *
 * And a third axis discipline does not need at all: COVERAGE. Attendance and
 * referrals are complete. Grades are not -- 22% of enrolments carry no mark
 * four weeks in -- so every rate here is over what teachers have posted, and
 * the screen has to say so.
 */

/** Below this many students in a cell, a rate is noise and may identify. */
export const SMALL_GROUP = 10;

/**
 * Below this many students IN THE NUMERATOR, the count is withheld too.
 *
 * The rule discipline did not need. "2 of 20 failing" names a pair of children
 * to anyone who knows the group, and at this school the groups are small
 * enough that somebody does.
 */
export const MIN_CELL_COUNT = 10;

/** A mark, as the app understands it. */
export type Mark =
  | { kind: "grade"; letter: string; failing: boolean }
  | { kind: "passfail"; letter: string; failing: boolean }
  | { kind: "placeholder" }     // "--", a teacher has not marked it
  | { kind: "none" };           // no row value at all

/**
 * WHAT COUNTS AS A MARK, AND WHAT COUNTS AS FAILING.
 *
 * Four populations, and they reconcile: of 5,562 enrolment rows, 4,091 carry
 * an A-F letter, 214 carry P or NP, 316 carry the literal "--", and 941 carry
 * nothing at all. Every rate in this mode must name which of those four its
 * denominator is, because the D/F rate is 23.9% over A-F rows and 17.5% over
 * all rows, and that 6.4-point swing is decided by nothing but the choice.
 *
 * "--" IS NOT A GRADE AND NOT A ZERO. It is a teacher who has not marked yet,
 * which is the same fact as an absent row wearing different clothes. Folding
 * it into "no grade" would be defensible; folding it into F would be a lie
 * about a child.
 *
 * NP IS FAILING, P IS NOT, and neither belongs in a D/F rate: a pass-fail
 * course has no D or F to give, so including its rows in the denominator
 * dilutes the rate with enrolments that could never have contributed to it.
 */
export function markOf(raw: unknown): Mark {
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!s) return { kind: "none" };
  if (s === "--" || s === "-") return { kind: "placeholder" };
  if (s === "P") return { kind: "passfail", letter: "P", failing: false };
  if (s === "NP") return { kind: "passfail", letter: "NP", failing: true };
  if (["A", "B", "C", "D", "F"].includes(s)) {
    return { kind: "grade", letter: s, failing: s === "D" || s === "F" };
  }
  // A+ / B- and the like: the letter is the first character.
  const head = s.charAt(0);
  if (["A", "B", "C", "D", "F"].includes(head)) {
    return { kind: "grade", letter: head, failing: head === "D" || head === "F" };
  }
  return { kind: "none" };
}

export type CellInput = {
  label: string;
  /** Students in the group, however few. */
  students: number;
  /** Students in the group with at least one A-F mark posted. */
  studentsWithMarks: number;
  /** Students in the group carrying at least one D, F or NP. */
  failingStudents: number;
  /** Enrolment rows for the group, and how many carry any mark. */
  rows?: number;
  markedRows?: number;
};

export type Cell = {
  label: string;
  students: number | null;
  studentsWithMarks: number | null;
  failingStudents: number | null;
  rate: number | null;
  coverage: number | null;
  withheld: null | "privacy" | "too-few-failing";
  reason: string | null;
};

/**
 * One reportable cell, or a refusal that says which rule refused it.
 *
 * A SUPPRESSED CELL REPORTS NOTHING THAT COULD LOCATE A CHILD, following
 * disciplineAggregates.ts: not the count, not the denominator, not the rate.
 * Only that it exists and is withheld, so a reader can see the row is there
 * and know why it is empty.
 *
 * COVERAGE IS NEVER SUPPRESSED. It is a fact about how much of the gradebook
 * is filled in, not a fact about children, so no privacy rule touches it -- and
 * it is the number that stops every other number being over-read.
 */
export function cellOf(input: CellInput): Cell {
  const coverage =
    typeof input.rows === "number" && input.rows > 0 && typeof input.markedRows === "number"
      ? input.markedRows / input.rows
      : null;

  const base: Cell = {
    label: input.label,
    students: null,
    studentsWithMarks: null,
    failingStudents: null,
    rate: null,
    coverage,
    withheld: null,
    reason: null,
  };

  if (input.students < SMALL_GROUP) {
    return {
      ...base,
      withheld: "privacy",
      reason:
        `Withheld: fewer than ${SMALL_GROUP} students in this group. ` +
        `A figure over a group that small can identify a child.`,
    };
  }

  if (input.failingStudents < MIN_CELL_COUNT) {
    return {
      ...base,
      students: input.students,
      withheld: "too-few-failing",
      reason:
        `Withheld: fewer than ${MIN_CELL_COUNT} students in this group have a D or F. ` +
        `The group size is shown; the count is not, because a number that small ` +
        `names the children in it.`,
    };
  }

  return {
    ...base,
    students: input.students,
    studentsWithMarks: input.studentsWithMarks,
    failingStudents: input.failingStudents,
    rate: input.studentsWithMarks > 0 ? input.failingStudents / input.studentsWithMarks : null,
  };
}

/**
 * The 95% Wilson interval, as a fraction pair, or null when there is nothing
 * to bound.
 *
 * NOT DECORATION. A group of 47 students produces an interval 25 points wide,
 * and the difference between "no gap" and "no gap this study could see" is the
 * whole of what a reader should take away. The normal approximation is wrong at
 * these counts; Wilson is not.
 */
export function wilson95(successes: number, n: number): [number, number] | null {
  if (!Number.isFinite(successes) || !Number.isFinite(n) || n <= 0) return null;
  if (successes < 0 || successes > n) return null;
  const z = 1.959964;
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

/**
 * Do two cells differ, allowing for how few children are in them?
 *
 * Returns false when the intervals overlap -- which is the honest answer far
 * more often than a school dashboard implies. The 566-student group and the
 * 47-student group differ by 2.5 points and this returns false for them, which
 * is the finding.
 */
export function intervalsSeparate(a: Cell, b: Cell): boolean {
  if (a.failingStudents === null || a.studentsWithMarks === null) return false;
  if (b.failingStudents === null || b.studentsWithMarks === null) return false;
  const ia = wilson95(a.failingStudents, a.studentsWithMarks);
  const ib = wilson95(b.failingStudents, b.studentsWithMarks);
  if (!ia || !ib) return false;
  return ia[1] < ib[0] || ib[1] < ia[0];
}
