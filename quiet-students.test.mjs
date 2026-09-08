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

console.log("\nThe threshold is the school's average, not the teacher's own");
{
  // THE CORRECTION, 2026-09-07. Measuring a teacher's students against that
  // teacher's own average self-calibrates, and self-calibration rewards doing
  // nothing: a teacher who awards nobody has an average of zero, so no student
  // is below it and the panel falls silent for exactly the person who most
  // needs it.
  const students = [S(1), S(2), S(3), S(4), S(5)];
  const interactions = { "1": { positive: 1, negative: 0 } };

  const own = R.quietStudents({ students, interactions });
  const school = R.quietStudents({ students, interactions, average: 2.0 });

  check("against their own average, the awarded student is not flagged",
    own.quietCount === 0);
  check("against the school's, they are", school.quietCount === 1);
  check("the passed-in average is the one used", school.average === 2.0);
  check("and the group's own is still reported, so both can be shown",
    Math.abs(school.groupAverage - 0.2) < 1e-9);

  // Falling back matters: a school-wide view IS the whole group, and passing
  // its own mean back in would be circular.
  const noArg = R.quietStudents({
    students: [S(1), S(2)],
    interactions: { "1": { positive: 1, negative: 0 }, "2": { positive: 9, negative: 0 } },
  });
  check("with no average given it falls back to the group's own", noArg.average === 5);

  for (const bad of [-1, NaN, Infinity, "3", null]) {
    const r = R.quietStudents({ students: [S(1)], interactions: {}, average: bad });
    check(`a nonsense average (${JSON.stringify(bad)}) falls back rather than flagging wrongly`,
      r.average === 0);
  }
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
  // Bounded by the function's OWN body, not by a character window. The window
  // version broke the moment the averages were computed above the scoping,
  // which is the third time today a distance-based assertion has failed for a
  // reason unrelated to the code under test.
  const quietFn = (() => {
    const i = app.indexOf("function wcRenderQuietStudents(");
    return app.slice(i, app.indexOf("\n        }", app.indexOf("wc-quiet-more", i)));
  })();
  check("and scopes to the teacher's own classes through scopeStudents",
    /scopeStudents\(\{/.test(quietFn));
  check("using the same roster helper Award Cash uses, so the two agree",
    /roster: activeTeacherRoster\(\)/.test(quietFn));
  check("never-awarded is worded as such, not as a low score",
    /never awarded/.test(app));
  check("the window is stated in the copy, not left implicit",
    /QUIET_WINDOW_DAYS/.test(app) && /last ' \+ QUIET_WINDOW_DAYS \+ ' days/.test(app));
  check("an empty list is a good outcome, and says so",
    /Nothing to flag\. That is the goal\./.test(app));
  check("the subtitle says these children are doing nothing wrong",
    /doing nothing wrong/.test(app));
}


console.log("\nThe teacher comparison uses a denominator that is fair");
{
  const app = readFileSync(new URL("./script.js", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  // Comparing a teacher's own awards-per-student against the ALL-ADULTS
  // awards-per-student would tell every teacher they are behind, because the
  // second aggregates every colleague's awards to the same child. The
  // comparison is per member of staff; the student threshold is per student.
  check("the student threshold is interactions per student",
    /schoolAverage = schoolStudents\.length[\s\S]{0,120}moves\.length \/ schoolStudents\.length/.test(app));
  check("the teacher comparison is per member of staff, counting everyone",
    /staffCounts = \(Array\.isArray\(teachers\)[\s\S]{0,120}awardsByActor\[t\.id\] \|\| 0\)/.test(app));
  check("and the two are not confused with each other",
    /Same\s*\n?\s*\/\/ words, different denominators/.test(
      readFileSync(new URL("./script.js", import.meta.url), "utf8")));

  check("the teacher's own count is their own awards", /awardsByActor\[currentUser\.id\]/.test(app));
  // It WAS gated on !seesAll, which hid it from the one person most likely to
  // look: a superadmin who also teaches seven sections. An admin who awards is
  // still an adult with a daily practice.
  check("the goal is shown to everyone, admins included",
    !/!seesAll && currentUser/.test(app));
  check("and it is its own panel, not a strip inside the student list",
    /id="dashGoalPanel"/.test(readFileSync(new URL("./index.html", import.meta.url), "utf8")) &&
    /function wcRenderDailyGoal\(/.test(app));
  // The old amber/green strip is gone with the refactor. The goal panel is now
  // the thing that reads as encouragement rather than rebuke: it shows the
  // colleague median beside your own figure without ever colouring you red.
  check("the goal panel shows your figure beside the typical colleague's",
    /typical colleague/.test(app));
  check("and nothing on it is coloured as a failure",
    !/is-behind/.test(app));

  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  check("behind is amber, not red -- something to act on, not a failure",
    /\.wc-quiet-compare\.is-behind \{[^}]*--wc-amber-deep/.test(css));
  check("no other teacher is ever named", !/awardsByActor\[[^\]]*\]\s*\+[\s\S]{0,80}name/.test(app));
}


console.log("\nThe median, and a goal derived from it");
{
  check("median of an odd list is the middle", R.median([1, 2, 3]) === 2);
  check("median of an even list is the midpoint", R.median([1, 2, 3, 4]) === 2.5);
  check("median of nothing is zero, not NaN", R.median([]) === 0);
  check("it ignores values that are not numbers",
    R.median([1, "x", 3, null, undefined, NaN]) === 2);
  check("and does not mutate the caller's array", (() => {
    const a = [3, 1, 2]; R.median(a); return a.join(",") === "3,1,2"; })());

  // THE REASON FOR THE MEDIAN. One very active colleague drags a mean far
  // above what anybody typical does, and a target nobody typical reaches
  // reads as noise within a week.
  const counts = [0, 0, 1, 1, 2, 2, 3, 300];
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  check("one heavy awarder moves the mean but not the median",
    mean > 38 && R.median(counts) === 1.5);

  // Goal.
  check("before launch, with nobody awarding, the goal is 1 rather than 0",
    R.dailyGoal([0, 0, 0, 0], 30) === 1);
  check("a goal of zero is never produced", R.dailyGoal([], 30) >= 1);
  check("it rounds up, so it is never below what the typical person does",
    R.dailyGoal([60, 69, 70, 90], 30) === 3);
  check("it rises with the school's own practice",
    R.dailyGoal([300, 300, 300], 30) > R.dailyGoal([30, 30, 30], 30));
  check("a bad window falls back rather than dividing by zero",
    R.dailyGoal([30, 30], 0) >= 1 && isFinite(R.dailyGoal([30, 30], 0)));
}

console.log("\nThe goal and the comparison are on screen");
{
  const app = readFileSync(new URL("./script.js", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

  check("the comparison uses the median, not the mean",
    /R\.median\(staffCounts\)/.test(app) && !/staffAverage/.test(app));
  check("colleagues who awarded nothing are counted, so the bar is honest",
    /teachers : \[\]\)\s*\n?\s*\.map\(t => awardsByActor\[t\.id\] \|\| 0\)/.test(app));
  check("the goal comes from the same counts", /R\.dailyGoal\(staffCounts/.test(app));
  check("progress is today's awards, not the window's", /todayStart/.test(app));
  check("the bar is capped so it cannot overflow", /Math\.min\(today, goal\)/.test(app));
  check("a reached goal says so", /manage on a normal day/.test(app));
  check("the panel carries the reached state, not an inner card",
    /panel\.classList\.toggle\('is-hit', hit\)/.test(app));
  // "and 586 more" is a number, not a fact anybody can act on.
  check("the footer says which few are shown rather than how many are left",
    /Showing the '\s*\+\s*rows\.length/.test(app));
  check("and the track stays visible when it is",
    /\.wc-goal-panel\.is-hit \.wc-goal-fill/.test(css));
  check("reached turns the bar green",
    /\.wc-goal-panel\.is-hit \.wc-goal-fill \{[^}]*--wc-green-deep/.test(css));
  check("a long student name truncates instead of pushing the badge out",
    /\.wc-quiet-name \{[^}]*text-overflow: ellipsis/.test(css));
  check("and the footer lines up with the rows above it",
    /\.wc-quiet-more \{[^}]*padding: 0 11px/.test(css));
  check("the fill animates, and not for anyone who asked it not to",
    /prefers-reduced-motion[\s\S]{0,140}\.wc-goal-fill \{ transition: none/.test(css));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
