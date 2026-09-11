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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
