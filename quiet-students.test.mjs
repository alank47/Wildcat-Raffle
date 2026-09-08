// The students nobody is awarding.
//
// The school's problem, in their words: quiet, well-behaved children do not
// earn as many points. They are never a problem, so they are never the reason
// an adult opens the app. The school already had a definition -- below the
// average number of teacher interactions, but above the 5:1 positivity ratio.
//
// MEASURED AGAINST PRODUCTION FIRST, 2026-09-07, and the strict definition
// returned NOBODY: 64 movements across 754 students over 30 days, an average of
// 0.085, so "below average" was exactly "has zero" -- and a student with zero
// interactions has no positivity ratio to be above. The rule reports those
// separately for that reason. At launch volume the second group fills out.
//
// The edge cases here are where a feature like this does harm: calling a child
// "0% positive" when nothing has been recorded, or putting a child who is
// genuinely struggling on a list of children who are doing nothing wrong.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
new Function(src)();
const R = globalThis.WildcatRoster;

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const S = (id, last) => ({ id: String(id), firstName: "S" + id, lastName: last || "X", grade: "9" });
const ids = (rows) => rows.map((r) => r.student.id);

console.log("\nThe two groups are kept apart");
{
  const res = R.quietStudents({
    students: [S(1), S(2), S(3), S(4)],
    interactions: {
      "2": { positive: 1, negative: 0 },      // quiet and positive
      "3": { positive: 9, negative: 1 },      // busy
      "4": { positive: 1, negative: 3 },      // struggling, not quiet-and-good
    },
  });
  check("a student with no interactions is 'never', not 'quiet'",
    ids(res.never).join(",") === "1" && !ids(res.quiet).includes("1"));
  check("a quiet, positive student is flagged", ids(res.quiet).includes("2"));
  check("a busy student is not flagged", !ids(res.quiet).concat(ids(res.never)).includes("3"));

  // The one that would do harm: a child with more corrections than praise is
  // not "doing nothing wrong", and putting them on this list would tell a
  // teacher the opposite of the truth.
  check("a student who is mostly corrected is NOT on a list of well-behaved children",
    !ids(res.quiet).includes("4"));
}

console.log("\nNo interactions is no ratio, never a zero score");
{
  const res = R.quietStudents({ students: [S(1)], interactions: {} });
  check("positivity is null, not 0", res.never[0].positivity === null);
  check("and the count is a real zero", res.never[0].total === 0);
}

console.log("\n83% is 5 to 1, the same number as the gauge and the tips");
{
  check("the floor is 5/6", Math.abs(R.POSITIVITY_FLOOR - 5 / 6) < 1e-9);

  // Exactly at the ratio must qualify: 5 positives to 1 correction IS the
  // target, not a near miss.
  const at = R.quietStudents({
    students: [S(1), S(2), S(3)],
    interactions: { "1": { positive: 5, negative: 1 }, "2": { positive: 30, negative: 0 },
                    "3": { positive: 4, negative: 1 } },
  });
  check("5 positives to 1 correction qualifies", ids(at.quiet).includes("1"));
  check("4 to 1 does not", !ids(at.quiet).includes("3"));
}

console.log("\nThe average is over the students passed in");
{
  // A teacher's question is "who in MY class am I missing", so an average over
  // the whole school would flag their entire roster or none of it.
  const res = R.quietStudents({
    students: [S(1), S(2)],
    interactions: { "1": { positive: 1, negative: 0 }, "2": { positive: 9, negative: 0 } },
  });
  check("the average is of this group, not a constant", res.average === 5);
  check("and only the below-average one is flagged", ids(res.quiet).join(",") === "1");
}

console.log("\nLeast noticed first, and the list is capped");
{
  const students = [], interactions = {};
  for (let i = 1; i <= 30; i++) {
    students.push(S(i));
    if (i > 3) interactions[String(i)] = { positive: 20, negative: 0 };
  }
  const res = R.quietStudents({ students, interactions, limit: 2 });
  check("the never-awarded come out first", ids(res.never).join(",") === "1,2,3".slice(0, 3));
  check("the list is capped at the limit", res.never.length === 2);
  check("but the full count is still reported", res.neverCount === 3);
  check("and the number considered is the whole roster", res.considered === 30);
}

console.log("\nIt is safe on the shapes a real roster produces");
{
  check("no students at all returns empty rather than dividing by zero",
    R.quietStudents({ students: [], interactions: {} }).never.length === 0);
  check("a missing interactions map is treated as no interactions",
    R.quietStudents({ students: [S(1)] }).never.length === 1);
  check("no arguments does not throw", (() => {
    try { R.quietStudents(); return true; } catch (e) { return false; } })());
}

console.log("\nThe screen says the two groups differently");
{
  const app = readFileSync(new URL("./script.js", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("it renders through the shared rule", /WildcatRoster\.quietStudents|R\.quietStudents/.test(app));
  check("and scopes to the teacher's own classes through scopeStudents",
    /wcRenderQuietStudents[\s\S]{0,900}scopeStudents\(\{/.test(app));
  check("never-awarded is worded as such, not as a low score",
    /never awarded/.test(app));
  check("the window is stated in the copy, not left implicit",
    /QUIET_WINDOW_DAYS/.test(app) && /last ' \+ QUIET_WINDOW_DAYS \+ ' days/.test(app));
  check("an empty list is a good outcome, and says so",
    /Nothing to flag\. That is the goal\./.test(app));
  check("the subtitle says these children are doing nothing wrong",
    /doing nothing wrong/.test(app));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
