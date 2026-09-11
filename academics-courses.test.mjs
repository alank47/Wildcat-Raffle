// Metrics 1 and 3: which courses fail the most students, and how deep it goes.
//
// Asked for on 2026-09-10, after the first cut of Academics Mode shipped with
// three of the twelve metrics and the owner asked what was missing. The honest
// answer was that four were buildable and I had been conservative; these are
// two of them.
//
// The assertions that matter here are, again, the ones about what does NOT
// reach the screen -- and this screen has a refusal the race card does not
// need: a course whose ROSTER is a protected group. A special-education or
// English-learner section is an aggregate in name only.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const server = readFileSync(new URL("./convex/academics.ts", import.meta.url), "utf8");
const rules = readFileSync(new URL("./convex/academicsRules.ts", import.meta.url), "utf8");
const subject = readFileSync(new URL("./convex/courseSubject.ts", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

// The renderer for these cards, isolated the same way academics-mode.test.mjs
// isolates the race one -- so a match here is about THIS code and not about
// something that happens to be elsewhere in a 30,000-line file.
const renderer = script.slice(
  script.indexOf("function renderAcademicsCourses"),
  script.indexOf("function switchSystemMode"),
);

// The query, isolated to its own function body rather than matched with a
// distance window. A "within 600 characters of" assertion passes or fails on
// how long a comment is, which is not a property anybody intends to test.
const courseFn = server.slice(
  server.indexOf("export const courseFailure = query("),
);

console.log("\n-- the same gate as the rest of academics --");
{
  check("the renderer was located", renderer.length > 1000);
  check("the query is in the file the gate tests already read",
    /export const courseFailure = query\(/.test(server));
  check("the query body was isolated", courseFn.length > 2000);
  check("it requires staff identity", /await requireStaff\(ctx\)/.test(courseFn));
  check("and refuses anyone outside admin/superadmin",
    /!ACADEMICS_ROLES\.includes\(staff\.role\)/.test(courseFn));
  check("it takes no arguments", /^export const courseFailure = query\(\{\s*args: \{\},/.test(courseFn));
  check("the browser never sees a student number", !/studentNumber/.test(renderer));
  check("nor computes suppression itself", !/SMALL_GROUP|MIN_CELL_COUNT/.test(renderer));
}

console.log("\n-- a course whose roster IS a protected group is not rated --");
{
  // This is the refusal the race card does not need. A rate over a course
  // whose roster is the school's special-education or English-learner cohort
  // is not an aggregate: it is that cohort's outcome wearing a course label.
  check("the predicate exists and covers all three cohorts",
    /export function isUnratedCohort/.test(subject) &&
    /isSpecialEducation\(courseName\)/.test(subject) &&
    /isEnglishLearnerProgram\(courseName\)/.test(subject) &&
    /isHeritageLanguageSection\(courseName\)/.test(subject));
  check("the query uses it to drop courses from the ranking",
    /filter\(\(c\) => !c\.unrated\)/.test(courseFn));
  check("English-learner status is refused by name, not by analogy",
    /NOT approved/.test(subject) && /field-sourcing-approval/.test(subject));
  check("those students still count in the school-wide totals",
    /still count in every school-wide figure/.test(server) ||
    /NOT dropped from the school-wide totals/.test(subject));
  check("and the screen says how many courses were left out",
    /cohortExcluded/.test(renderer) && /would be the disclosure/.test(renderer));
}

console.log("\n-- the ranking is not the rate, and that is the point --");
{
  // Ranking by raw rate hands the top of the list to the smallest courses.
  check("the sort key is the interval's lower bound", /export function rankScore/.test(rules));
  check("and it is Wilson, not a normal approximation", /wilson95\(failing, graded\)/.test(rules));
  check("the query sorts by it, not by rate",
    /\.sort\(\(a, b\) => \(b\.score \?\? -1\) - \(a\.score \?\? -1\)/.test(courseFn));
  // The floor alone is NOT enough: it is not monotone in n at the extremes, so
  // a course where 10 of 10 fail scores 72.2% and would outrank Common Core
  // Math 8A's 62.9% over 147 students.
  check("and a course too small to rank is listed instead of ranked",
    /export const RANKABLE_N/.test(rules) && /not put in an order it has not earned/.test(html));
  check("the reason it cannot rank on the floor alone is written down",
    /not monotone in n at the extremes/.test(rules));
  check("the screen says the order is not the percentage",
    /Ordered by how much the evidence supports, not by the raw percentage/.test(html));
  check("a course is only called worse than the school when its range clears it",
    /export function aboveSchoolRate/.test(rules) && /ci\[0\] > comparatorRate/.test(rules));
  // The first version compared a course to a mean it was inside, which drags
  // the target toward the course. Math 8A is 147 of 4,091 graded rows: 23.9%
  // with it, 22.1% without.
  check("and the comparator leaves the course out of its own baseline",
    /export function restOfSchoolRate/.test(rules) && /restOfSchoolRate\(schoolFailing, schoolGraded/.test(courseFn));
  check("a course behind on its gradebook is never badged at all",
    /NEVER BADGE A COURSE THE COVERAGE GATE HAS NOT CLEARED/.test(courseFn));
  check("and the footer says the comparison excludes the course's own students",
    /sit clearly above the rest/.test(renderer) &&
    /own students taken back out/.test(renderer));
}

console.log("\n-- a course list is not a teacher list --");
{
  // At a school of 618 students, naming a course names a colleague. The number
  // cannot carry that caveat, so the copy has to.
  check("the screen says so in the card itself",
    /This is a list of\s*\n?\s*<strong>courses<\/strong>, not of teachers/.test(html));
  check("and says what the data cannot separate",
    /who is placed in it, what it is required to cover/.test(html));
  check("the server refuses to go down to section level",
    /It does not split by section/.test(server));
  // Rank INTEGERS were removed deliberately: the top two courses overlap
  // across most of their ranges, and a printed "1" claims a resolution the
  // intervals do not support.
  check("no rank integers are printed", !/wc-acad-rank/.test(renderer) && !/wc-acad-rank/.test(css));
  // Whitespace-tolerant: the sentence wraps in index.html, and asserting it on
  // one line is a test about line length rather than about copy.
  check("the card warns that a higher percentage can sit below a lower one",
    /higher percentage can sit below a lower one/.test(html.replace(/\s+/g, " ")));
}

console.log("\n-- subject is a guess and never pretends otherwise --");
{
  check("the hint says it is guessed", /Subject is GUESSED from the course name/.test(renderer));
  check("and names why: PowerSchool has not granted the field",
    /has not granted us the field/.test(renderer));
  check("an unreadable name is admitted, not filed somewhere plausible",
    /Not categorised/.test(subject) && /unclassified/.test(renderer));
  check("coverage is reported in two units, not one",
    /weightedFraction/.test(courseFn) && /weightedFraction/.test(renderer));
  check("because one big unnamed course outweighs five small ones",
    /distorts a rollup\s*\n?\s*\* more than five/.test(subject));
  check("the counting unit is stated on the card",
    /share of posted grades, not of students/.test(renderer));
  // A rollup over a catalogue half of which we could not read is a statement
  // about the guesser.
  check("the whole rollup is refused below 80% of the gradebook",
    /rollupOk = \(naming\.weightedFraction \?\? 0\) >= 0\.8/.test(courseFn) &&
    /says more about the guessing/.test(renderer));
  check("one unnamed course that could swing a subject suppresses it",
    /SINGLE-COURSE SENSITIVITY/.test(courseFn) && /swing > 0\.05/.test(courseFn));
  check("subjects are ordered by catalogue size, never by rate",
    /never by rate/i.test(courseFn) && /never as\s*\n?\s*'a ranking of departments|ranking of departments/.test(renderer));
  check("privacy floors are checked against distinct students, not rows",
    /DISTINCT STUDENTS, which is what the privacy floors/.test(courseFn) &&
    /withMarks: Set<string>/.test(courseFn));
}

console.log("\n-- how deep, which is a different question from how many --");
{
  check("the buckets are a rule, not a magic number in the query",
    /export const DEPTH_BUCKETS/.test(rules) && /export function depthBucket/.test(rules));
  check("each boundary names what the school would do differently",
    /Credit recovery/.test(rules) && /attendance, health, housing or/.test(rules));
  check("a student repeating a course counts once", /A Set, not a counter/.test(courseFn));
  // THE BUG THIS FIXES IS SUBTRACTION. The bands partition the students who
  // are failing anything, and that total is published beside them, so nulling
  // one band and printing the other three does not hide it.
  check("a thin band is merged, not nulled", /export function collapseDepth/.test(rules));
  check("and the file says why blanking would not have worked",
    /THE BUG THIS FIXES IS SUBTRACTION/.test(rules) &&
    /Publishing a total and three\s*\n?\s*\* of four parts is publishing four parts/.test(rules));
  check("the query uses it", /collapseDepth\(raw\)/.test(courseFn));
  check("and the screen says when a band was widened",
    /b\.merged/.test(renderer) && /widened, because a narrower band held too few/.test(renderer));
  check("the footer carries the sentence the card exists for",
    /are not the same problem/.test(renderer));
  // The course rate excludes NP (a pass/fail course has no D to give); the
  // depth count includes it (for a student, "not passed" is the same fact).
  // Both are right and they will not reconcile, so they are labelled apart.
  check("the wider net of the depth count is named, not left to be discovered",
    /counting any course NOT PASSED/.test(renderer) &&
    /wider net than the D\/F rate/.test(renderer));
}

console.log("\n-- wired into the app --");
{
  check("the query is reachable from the browser",
    /convexQuery\('academics:courseFailure'/.test(script));
  check("both queries are fetched together, not one after the other",
    /Promise\.all\(\[[\s\S]{0,200}academics:raceBreakdown[\s\S]{0,200}academics:courseFailure/.test(script));
  check("a failure in one card does not blank the other",
    /let _acadCourses = null;/.test(script) && /keeps its own blast radius/.test(script));

  const ids = [...renderer.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  check("the renderer reads at least six elements", ids.length >= 6);
  [...new Set(ids)].forEach((id) => check(`#${id} exists in index.html`, html.includes(`id="${id}"`)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
