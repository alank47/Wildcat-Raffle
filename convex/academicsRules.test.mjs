// Academics: what a mark means, and when a cell may be reported.
//
// The suppression here is NOT discipline's, and the two differences were found
// by review rather than by writing the obvious thing:
//
//   - disciplineAggregates.ts suppresses on the DENOMINATOR, which was right
//     when the whole school had six referrals. Academic failure is dense --
//     976 D and F marks -- so a small NUMERATOR has to be withheld too, or a
//     cell reads "2 of 20", which is a sentence about two identifiable
//     children.
//   - its second axis counted EVENTS. Counting graded ROWS here can never
//     bind, because ten students carry about seventy rows. It counts STUDENTS.
//
// The measured shape this is built for, all 5,562 rows: Hispanic or Latino 566
// students / 395 failing; Black or African American 47 / 34; then four groups
// holding 7, 4, 3 and 2 children who must never appear.
//
// Run: npm test

import {
  markOf, cellOf, wilson95, intervalsSeparate, SMALL_GROUP, MIN_CELL_COUNT,
  courseCell, collapseDepth, coverageEnvelope, restOfSchoolRate, rankScore,
  aboveSchoolRate, depthBucket, COURSE_MIN_FAIL, RANKABLE_N,
} from "./academicsRules.ts";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\n-- what a mark is --");
{
  check("A is a grade and not failing", markOf("A").kind === "grade" && !markOf("A").failing);
  check("D is failing", markOf("D").failing === true);
  check("F is failing", markOf("F").failing === true);
  check("C is not", markOf("C").failing === false);
  // Pass-fail courses have no D or F to give.
  check("P is pass-fail, not failing", markOf("P").kind === "passfail" && !markOf("P").failing);
  check("NP is pass-fail AND failing", markOf("NP").kind === "passfail" && markOf("NP").failing);

  // "--" IS NOT A ZERO. It is a teacher who has not marked yet.
  check('"--" is a placeholder, not a grade', markOf("--").kind === "placeholder");
  check('"--" is not failing', markOf("--").failing === undefined);
  check("an empty value is nothing at all", markOf("").kind === "none");
  check("null is nothing at all", markOf(null).kind === "none");
  check("a number is not a mark", markOf(87).kind === "none");

  check("A+ reads as A", markOf("A+").letter === "A");
  check("D- reads as D and still fails", markOf("D-").letter === "D" && markOf("D-").failing);
  check("lowercase works", markOf("f").failing === true);
  check("whitespace is trimmed", markOf("  B  ").letter === "B");
  check("an unknown letter is refused, not guessed", markOf("Z").kind === "none");
}

console.log("\n-- a group too small to report --");
{
  // The four real groups at this school holding 7, 4, 3 and 2 children.
  const c = cellOf({ label: "White", students: 7, studentsWithMarks: 7, failingStudents: 2 });
  check("it is withheld for privacy", c.withheld === "privacy");
  check("the student count is NOT returned", c.students === null);
  check("nor the failing count", c.failingStudents === null);
  check("nor the rate", c.rate === null);
  check("but the label survives, so the row is visibly there", c.label === "White");
  check("and the reason says which rule refused it", /fewer than 10 students/.test(c.reason));
  check("a group of exactly 10 is not withheld for privacy",
    cellOf({ label: "x", students: 10, studentsWithMarks: 10, failingStudents: 10 }).withheld === null);
}

console.log("\n-- a group big enough, but too few failing --");
{
  // THE RULE DISCIPLINE DID NOT NEED. 2 of 20 names two children.
  const c = cellOf({ label: "Group", students: 20, studentsWithMarks: 20, failingStudents: 2 });
  check("it is withheld", c.withheld === "too-few-failing");
  check("the GROUP SIZE is shown -- that is not sensitive", c.students === 20);
  check("but the failing count is not", c.failingStudents === null);
  check("nor the rate", c.rate === null);
  check("and the reason explains the distinction", /names the children in it/.test(c.reason));
  check("9 failing is still withheld",
    cellOf({ label: "x", students: 50, studentsWithMarks: 50, failingStudents: 9 }).withheld === "too-few-failing");
  check("10 failing reports", cellOf({ label: "x", students: 50, studentsWithMarks: 50, failingStudents: 10 }).withheld === null);
}

console.log("\n-- the two groups this school can actually report --");
{
  const hisp = cellOf({ label: "Hispanic or Latino", students: 566, studentsWithMarks: 566, failingStudents: 395 });
  const black = cellOf({ label: "Black or African American", students: 47, studentsWithMarks: 47, failingStudents: 34 });
  check("Hispanic or Latino reports", hisp.withheld === null);
  check("with the measured rate", Math.round(hisp.rate * 1000) / 10 === 69.8);
  check("Black or African American reports", black.withheld === null);
  check("with the measured rate", Math.round(black.rate * 1000) / 10 === 72.3);

  // THE FINDING. They look different and they are not.
  check("the two do NOT differ once the interval is allowed for", intervalsSeparate(hisp, black) === false);
}

console.log("\n-- the interval is the point, not decoration --");
{
  const wide = wilson95(34, 47);
  const narrow = wilson95(395, 566);
  check("47 students give a wide interval", (wide[1] - wide[0]) > 0.20);
  check("566 students give a narrow one", (narrow[1] - narrow[0]) < 0.10);
  check("the small group's interval is more than twice as wide",
    (wide[1] - wide[0]) > 2 * (narrow[1] - narrow[0]));

  // A real gap must still be detectable, or the guard is useless.
  const a = cellOf({ label: "a", students: 200, studentsWithMarks: 200, failingStudents: 40 });
  const b = cellOf({ label: "b", students: 200, studentsWithMarks: 200, failingStudents: 120 });
  check("a genuinely large gap IS reported as separate", intervalsSeparate(a, b) === true);

  check("bounds stay inside 0 and 1", wilson95(0, 5)[0] >= 0 && wilson95(5, 5)[1] <= 1);
  check("no successes is still an interval", wilson95(0, 30) !== null);
  check("nonsense is refused", wilson95(5, 0) === null && wilson95(10, 5) === null);
}

console.log("\n-- coverage is never suppressed --");
{
  // It is a fact about the gradebook, not about children.
  const c = cellOf({ label: "tiny", students: 3, studentsWithMarks: 3, failingStudents: 3, rows: 27, markedRows: 20 });
  check("a withheld cell still reports coverage", c.withheld === "privacy" && c.coverage !== null);
  check("and the figure is right", Math.round(c.coverage * 100) === 74);
  check("no rows means no coverage claim, not zero coverage",
    cellOf({ label: "x", students: 50, studentsWithMarks: 50, failingStudents: 20 }).coverage === null);
}

console.log("\n-- the constants are stated, not buried --");
{
  check("the privacy floor matches discipline's", SMALL_GROUP === 10);
  check("the numerator floor is stated", MIN_CELL_COUNT === 10);
}

console.log("\n-- a course cell is not a race cell, and the floors differ --");
{
  // The privacy floor is checked against GRADED students, not enrolments. The
  // first version checked enrolments while computing the rate over graded
  // rows, so a course with 12 enrolled and 4 graded cleared the floor and then
  // printed a rate over four children.
  const thin = courseCell({ label: "X", graded: 4, failing: 3, rows: 12, markedRows: 4 });
  check("a course with 12 enrolled but 4 graded is withheld", thin.withheld === "privacy");
  check("and reports nothing about those four", thin.rate === null && thin.failingStudents === null);
  check("coverage survives suppression, because it is about teachers not children",
    Math.round(thin.coverage * 100) === 33);

  // A numerator floor of 10 would delete every course that is doing WELL,
  // leaving a list of the worst with the reassuring cases removed.
  check("the course numerator floor is three, not ten", COURSE_MIN_FAIL === 3);
  const two = courseCell({ label: "X", graded: 28, failing: 2, rows: 30, markedRows: 28 });
  check("two failures withholds the count", two.failingStudents === null);
  // rate x n recovers the count exactly, so showing "7% of 28" would spell out
  // "2 of 28" rather than hide it.
  check("AND the rate, because a rate over a known size gives the count back",
    two.rate === null);
  check("it says so rather than just blanking", /gives the count back/.test(two.reason));
  check("the class size is still shown", two.students === 28);

  const none = courseCell({ label: "X", graded: 30, failing: 0, rows: 30, markedRows: 30 });
  check("zero failures is published, because it names nobody",
    none.withheld === null && none.rate === 0 && none.failingStudents === 0);

  const real = courseCell({ label: "CC Math 8A", graded: 147, failing: 104, rows: 152, markedRows: 150 });
  check("a real course reports in full", real.withheld === null && real.failingStudents === 104);
  check("and is rankable at 147 graded", real.rankable === true);
  const small = courseCell({ label: "X", graded: 15, failing: 9, rows: 15, markedRows: 15 });
  check("a 15-student course reports but is not rankable",
    small.withheld === null && small.rankable === false);
  check("the rankable threshold is stated", RANKABLE_N === 20);
}

console.log("\n-- ranking, and the case the floor alone gets wrong --");
{
  // Same rate to one decimal place; the floor separates them by the only thing
  // that differs, which is how much is known.
  check("a 147-student course outranks a 41-student one at the same rate",
    rankScore(104, 147) > rankScore(29, 41));
  check("and a ten-student course at 60% sinks below both",
    rankScore(6, 10) < rankScore(78, 146));
  // THE CASE THE GATE EXISTS FOR. The floor is not monotone in n at the
  // extremes: ten out of ten scores higher than 104 out of 147.
  check("but a 10-of-10 course would outrank the worst real course",
    rankScore(10, 10) > rankScore(104, 147));
  check("which is why n>=20 is a separate gate, not a consequence of the floor",
    courseCell({ label: "X", graded: 10, failing: 10, rows: 10, markedRows: 10 }).rankable === false);
  check("at twenty, failing everybody IS a finding and ranks",
    courseCell({ label: "X", graded: 20, failing: 20, rows: 20, markedRows: 20 }).rankable === true);
}

console.log("\n-- a course is not compared to a mean it is inside --");
{
  const rest = restOfSchoolRate(976, 4091, 104, 147);
  check("the school without Math 8A is 22.1%, not 23.9%",
    Math.round(rest * 1000) / 10 === 22.1);
  check("dropping the course lowers the bar it has to clear", rest < 976 / 4091);
  check("a course that is the whole school has no comparator",
    restOfSchoolRate(976, 4091, 976, 4091) === null);
  check("Math 8A clears the rest-of-school rate", aboveSchoolRate(104, 147, rest));
  check("an ordinary course does not", !aboveSchoolRate(7, 30, rest));
}

console.log("\n-- what is not posted bounds what is --");
{
  // Missing marks are not missing at random and the mechanisms run both ways,
  // so bound it rather than model it.
  const e = coverageEnvelope(11, 44, 130);
  check("best case treats every unposted mark as a pass",
    Math.round(e.best * 100) === 8);
  check("worst case treats every one as a fail",
    Math.round(e.worst * 100) === 75);
  check("and the width is the reason the point estimate cannot be read alone",
    e.width > 0.15);
  const tight = coverageEnvelope(104, 147, 152);
  check("a nearly-complete gradebook has a narrow envelope", tight.width < 0.05);
  check("nonsense is refused rather than guessed", coverageEnvelope(5, 10, 4) === null);
}

console.log("\n-- thin bands are merged, because blanking one leaks it --");
{
  // The bands partition the students failing anything, and that total is
  // published beside them. Nulling one and printing the other three is one
  // subtraction away from publishing all four.
  const out = collapseDepth([
    { min: 1, max: 1, students: 186 },
    { min: 2, max: 2, students: 118 },
    { min: 3, max: 4, students: 97 },
    { min: 5, max: null, students: 6 },
  ]);
  check("the thin top band is folded into its neighbour", out.length === 3);
  check("and the surviving band carries both counts",
    out[2].students === 103 && out[2].merged === true);
  check("the label widens to say so", out[2].label === "3 or more");
  check("the partition still adds up",
    out.reduce((a, b) => a + b.students, 0) === 186 + 118 + 97 + 6);
  check("untouched bands are not marked as merged", out[0].merged === false);

  const fine = collapseDepth([
    { min: 1, max: 1, students: 186 },
    { min: 2, max: 2, students: 118 },
  ]);
  check("nothing is merged when nothing is thin",
    fine.length === 2 && fine.every((b) => !b.merged));

  // Two thin bands in a row still resolve rather than looping.
  const both = collapseDepth([
    { min: 1, max: 1, students: 200 },
    { min: 2, max: 2, students: 4 },
    { min: 3, max: 4, students: 5 },
    { min: 5, max: null, students: 3 },
  ]);
  check("consecutive thin bands collapse until every printed one clears the floor",
    both.every((b) => b.students === 0 || b.students >= SMALL_GROUP));
  check("and the total is still preserved",
    both.reduce((a, b) => a + b.students, 0) === 212);
}

console.log("\n-- the depth buckets are a rule, not a magic number --");
{
  check("one course is its own band", depthBucket(1) === "1 course");
  check("three and four share one", depthBucket(3) === depthBucket(4));
  check("five and nine share the top", depthBucket(5) === depthBucket(9));
  check("zero is not a band at all", depthBucket(0) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
