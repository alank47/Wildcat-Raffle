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
        `Not shown: fewer than ${SMALL_GROUP} students in this group. ` +
        `A figure over a group that small can point to a child.`,
    };
  }

  if (input.failingStudents < MIN_CELL_COUNT) {
    return {
      ...base,
      students: input.students,
      withheld: "too-few-failing",
      reason:
        `Not shown: fewer than ${MIN_CELL_COUNT} students in this group have a D or F. ` +
        `The group size is on screen; the count is not, because a number that small ` +
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

/**
 * The buckets for "how many courses is this student failing?".
 *
 * NOT COSMETIC CUT POINTS. Each boundary is a different response by the school,
 * which is the only justification a bucket has:
 *
 *   1        one bad class. Credit recovery, a conversation with one teacher.
 *   2        a pattern worth a counsellor looking at the schedule.
 *   3-4      more than half a timetable. This is rarely about the courses.
 *   5+       failing essentially everything. At this point the academic record
 *            is a symptom, and the response is attendance, health, housing or
 *            home -- not tutoring.
 *
 * THE WHOLE POINT OF THE SPLIT is that "200 students are failing something" is
 * two completely different schools depending on whether it is 200 students with
 * one class each or 60 students with four each, and the shipped count cannot
 * tell them apart.
 */
export const DEPTH_BUCKETS: ReadonlyArray<{ label: string; min: number; max: number | null }> = [
  { label: "1 course", min: 1, max: 1 },
  { label: "2 courses", min: 2, max: 2 },
  { label: "3 to 4 courses", min: 3, max: 4 },
  { label: "5 or more", min: 5, max: null },
];

/** Which bucket a count of failed courses falls in, or null for none. */
export function depthBucket(failedCourses: number): string | null {
  if (!Number.isFinite(failedCourses) || failedCourses < 1) return null;
  for (const b of DEPTH_BUCKETS) {
    if (failedCourses >= b.min && (b.max === null || failedCourses <= b.max)) return b.label;
  }
  return null;
}

/**
 * WHERE A COURSE RANKS, WHICH IS NOT ITS RATE.
 *
 * Ranking by raw rate hands the top of the list to the smallest courses. At
 * n=10 and a school rate of 24%, an ordinary course clears 60% by chance often
 * enough to appear alarming, and a principal reading the top of a list does not
 * apply a variance correction in their head.
 *
 * So the sort key is the LOWER BOUND of the 95% Wilson interval: the worst rate
 * the evidence can nearly rule out being below. A big course with a high rate
 * has a high floor. A tiny course with a high rate has a floor near zero and
 * sinks, which is the correct answer -- not "this course is fine" but "this
 * course has not shown anything yet".
 *
 * Measured on the four real courses at this school, 2026-09-10:
 *
 *   Common Core Math 8A   104/147  70.7%  floor 62.9%   <- ranks first
 *   Government             29/41   70.7%  floor 55.5%   <- same rate, lower floor
 *   Algebra 1A             65/106  61.3%  floor 51.8%
 *   US History 8A          78/146  53.4%  floor 45.3%
 *
 * Government and Common Core Math 8A have the SAME rate to one decimal place
 * and the ranking still separates them, by the only thing that differs: how
 * much is known.
 */
export function rankScore(failing: number, graded: number): number | null {
  const ci = wilson95(failing, graded);
  return ci ? ci[0] : null;
}

/**
 * Is this course's rate distinguishable from the REST of the school?
 *
 * A ranked list invites the reader to treat the top as exceptional. Most of a
 * list is not. This returns true only when the course's interval sits entirely
 * above the comparator -- the courses where "worse than the school" is
 * something the data actually supports.
 *
 * THE COMPARATOR MUST EXCLUDE THE COURSE ITSELF, and the first version of this
 * function did not. A course's own rows are inside the school-wide rate, which
 * drags the target toward the course and makes a large, genuinely divergent
 * course look less exceptional than it is. Common Core Math 8A is 147 of 4,091
 * graded rows: including it puts the school at 23.9%, excluding it puts the
 * rest of the school at 22.1%. Use restOfSchoolRate below to build the
 * comparator, and never pass a rate the course contributed to.
 */
export function aboveSchoolRate(failing: number, graded: number, comparatorRate: number): boolean {
  const ci = wilson95(failing, graded);
  if (!ci || !Number.isFinite(comparatorRate)) return false;
  return ci[0] > comparatorRate;
}

/** The school's D/F rate with one course's own rows taken back out. */
export function restOfSchoolRate(
  schoolFailing: number, schoolGraded: number, courseFailing: number, courseGraded: number,
): number | null {
  const g = schoolGraded - courseGraded;
  const f = schoolFailing - courseFailing;
  if (!(g > 0) || f < 0) return null;
  return f / g;
}

/**
 * Below this many students failing, a COURSE cell shows no rate.
 *
 * NOT THE SAME NUMBER AS MIN_CELL_COUNT, and the difference is the point.
 *
 * A numerator floor censors on the outcome being displayed, and at 10 it
 * censors in exactly one direction: every course with fewer than ten failures
 * disappears, which is every course that is doing WELL. What survives to the
 * screen is then a list of the school's worst courses with the reassuring cases
 * deleted, and a reader has no baseline left to judge any of them against.
 *
 * On a race cell that censoring protects the group the rule exists for. On a
 * course cell it protects nobody: a course roster is not a protected class, and
 * the identifiable party is the TEACHER -- for whom the harm grows with the
 * count, not shrinks. "3 of 28 have a D" costs a teacher nothing; "104 of 147"
 * is the sentence that follows them. A floor built to hide small numerators is
 * pointed at the wrong tail.
 *
 * What remains is a narrow, real student risk: "2 of 20 in this class have a D"
 * plus a roster names a pair of children. Three is enough to answer that.
 */
export const COURSE_MIN_FAIL = 3;

/**
 * Below this many graded students, a course is listed but never RANKED.
 *
 * The Wilson floor does most of the work of keeping small courses off the top,
 * but it is not monotone in n at the extremes and cannot do it alone: a course
 * where 10 of 10 students fail has a floor of 72.2%, which outranks Common Core
 * Math 8A's 62.9% over 147 students. At twenty, a course that fails everybody
 * has a floor of 83.9% and DESERVES the top of the list -- that is a finding,
 * not a coin landing badly ten times.
 */
export const RANKABLE_N = 20;

/**
 * ONE COURSE'S CELL. Not cellOf: the floors are different, and the reason they
 * are different is written on COURSE_MIN_FAIL above.
 *
 * The privacy floor is checked against GRADED STUDENTS, not enrolments. The
 * first version checked enrolments while computing the rate over graded rows,
 * so a course with 12 enrolled and 4 graded cleared the floor and then printed
 * a rate over four children.
 *
 * At one or two failures the RATE IS SUPPRESSED ALONG WITH THE COUNT, which is
 * not optional: rate multiplied by the denominator recovers the count exactly,
 * so a screen showing "7% of 28" has not hidden "2 of 28", it has spelled it
 * out in a way that takes one division to read.
 */
export function courseCell(input: {
  label: string;
  graded: number;
  failing: number;
  rows: number;
  markedRows: number;
}): Cell & { rankable: boolean } {
  const coverage = input.rows > 0 ? input.markedRows / input.rows : null;
  const base = {
    label: input.label,
    students: null as number | null,
    studentsWithMarks: null as number | null,
    failingStudents: null as number | null,
    rate: null as number | null,
    coverage,
    withheld: null as null | "privacy" | "too-few-failing",
    reason: null as string | null,
    rankable: false,
  };

  if (input.graded < SMALL_GROUP) {
    return {
      ...base,
      withheld: "privacy",
      reason:
        `Not shown: fewer than ${SMALL_GROUP} students in this class have a grade ` +
        `yet. A figure over a group that small can point to a child.`,
    };
  }

  if (input.failing > 0 && input.failing < COURSE_MIN_FAIL) {
    return {
      ...base,
      students: input.graded,
      studentsWithMarks: input.graded,
      withheld: "too-few-failing",
      reason:
        `Not shown: fewer than ${COURSE_MIN_FAIL} students here have a D or F. The ` +
        `percentage is not shown either \u2014 with the class size on screen, a ` +
        `percentage hands the count straight back.`,
    };
  }

  return {
    ...base,
    students: input.graded,
    studentsWithMarks: input.graded,
    failingStudents: input.failing,
    rate: input.failing / input.graded,
    rankable: input.graded >= RANKABLE_N,
  };
}

/**
 * HOW WRONG A RATE COULD BE BECAUSE OF WHAT IS NOT POSTED YET.
 *
 * Missing marks are NOT missing at random and cannot be assumed to be: a
 * teacher who posts failures first to trigger an intervention and a teacher who
 * posts the easy A's first produce opposite biases, and nothing in this data
 * says which is happening. So the honest move is to bound it rather than model
 * it -- every unposted mark is a pass in the best case and a fail in the worst.
 *
 * This is the fairness rule on this screen, not a statistical nicety. Without
 * it the teacher who has posted everything looks worse than the one who has
 * posted nothing, and the screen quietly teaches the staff that entering grades
 * is punished.
 */
export function coverageEnvelope(
  failing: number, graded: number, enrolments: number,
): { best: number; worst: number; width: number } | null {
  if (!(enrolments > 0) || graded > enrolments || failing > graded) return null;
  const best = failing / enrolments;
  const worst = (failing + (enrolments - graded)) / enrolments;
  return { best, worst, width: worst - best };
}

/**
 * Fold thin bands together until every published one clears the floor.
 *
 * THE BUG THIS FIXES IS SUBTRACTION. The four bands partition the students who
 * are failing anything, and that total is published beside them. Nulling one
 * band and printing the other three does not hide it -- it is the total minus
 * three numbers, which is one line of arithmetic. Publishing a total and three
 * of four parts is publishing four parts.
 *
 * So a thin band is MERGED into its neighbour rather than blanked, and the
 * label widens to say so: a "5 or more" holding six students becomes part of
 * "3 or more". The partition stays complete, every printed band clears the
 * floor, and nothing is recoverable because nothing was removed.
 */
export function collapseDepth(
  counts: ReadonlyArray<{ min: number; max: number | null; students: number }>,
): Array<{ label: string; min: number; max: number | null; students: number; merged: boolean }> {
  const label = (min: number, max: number | null): string => {
    if (max === null) return `${min} or more`;
    if (min === max) return min === 1 ? "1 class" : `${min} classes`;
    return `${min} to ${max} classes`;
  };
  let bands = counts.map((c) => ({ ...c, merged: false }));

  // Merge toward the middle: the outer bands are the thin ones in practice,
  // and folding 5+ into 3-4 reads naturally where folding 1 into 2 does not.
  while (bands.length > 1) {
    let i = bands.findIndex((b) => b.students > 0 && b.students < SMALL_GROUP);
    if (i === -1) break;
    const j = i === bands.length - 1 ? i - 1 : i + 1;
    const lo = Math.min(i, j), hi = Math.max(i, j);
    const a = bands[lo], b = bands[hi];
    bands = [
      ...bands.slice(0, lo),
      {
        min: a.min,
        max: b.max === null || a.max === null ? null : Math.max(a.max, b.max),
        students: a.students + b.students,
        merged: true,
      },
      ...bands.slice(hi + 1),
    ];
  }

  return bands.map((b) => ({ ...b, label: label(b.min, b.max) }));
}
