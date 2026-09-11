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
// Ends at the Seniors tab, not at switchSystemMode. That tab was added between
// the two on 2026-09-11 and handles student numbers BY DESIGN -- it is the one
// tab in Academics approved to name a child. Its own gate is asserted in
// senior-academics.test.mjs; sweeping it in here made an assertion written for
// the aggregate cards fail on the wrong subject.
const renderer = script.slice(
  script.indexOf("function renderAcademicsCourses"),
  script.indexOf("// ---- Academics: two tabs, two rules"),
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
  check("and the slice stops before the named-student tab",
    !/openSeniorDetail|renderSeniorAcademics/.test(renderer));
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
    /cohortExcluded/.test(renderer) &&
    /would be a fact about those students/.test(renderer));
}

console.log("\n-- the ranking is not the rate, and that is the point --");
{
  // Ranking by raw rate hands the top of the list to the smallest courses.
  check("the sort key is the interval's lower bound", /export function rankScore/.test(rules));
  check("and it is Wilson, not a normal approximation", /wilson95\(failing, graded\)/.test(rules));
  // The comparator moved into a named byScore when the class/support split
  // landed, because two lists now share it.
  check("the query sorts by it, not by rate",
    /const byScore = \(a: any, b: any\) =>\s*\n\s*\(b\.score \?\? -1\) - \(a\.score \?\? -1\)/.test(courseFn));
  // The floor alone is NOT enough: it is not monotone in n at the extremes, so
  // a course where 10 of 10 fail scores 72.2% and would outrank Common Core
  // Math 8A's 62.9% over 147 students.
  check("and a course too small to rank is listed instead of ranked",
    /export const RANKABLE_N/.test(rules) && /not put in an order it has not earned/.test(html));
  check("the reason it cannot rank on the floor alone is written down",
    /not monotone in n at the extremes/.test(rules));
  check("the screen says the order is not the percentage",
    /The order is not the percentage order/.test(html.replace(/\s+/g, " ")));
  check("a course is only called worse than the school when its range clears it",
    /export function aboveSchoolRate/.test(rules) && /ci\[0\] > comparatorRate/.test(rules));
  // The first version compared a course to a mean it was inside, which drags
  // the target toward the course. Math 8A is 147 of 4,091 graded rows: 23.9%
  // with it, 22.1% without.
  check("and the comparator leaves the course out of its own baseline",
    /export function restOfSchoolRate/.test(rules) && /restOfSchoolRate\(schoolFailing, schoolGraded/.test(courseFn));
  check("a course behind on its gradebook is never badged at all",
    /NEVER BADGE A COURSE THE COVERAGE GATE HAS NOT CLEARED/.test(courseFn));
  // Both clauses matched within a single string literal. "a clearly ' +
  // 'higher share" spans a concatenation, and asserting across one is a test
  // about where a line happened to wrap rather than about the copy.
  check("and the footer says the comparison excludes the course's own students",
    /higher share of students than the rest of the school/.test(renderer) &&
    /its own students are taken out/.test(renderer));
}

console.log("\n-- an intervention block is not a class --");
{
  // MEASURED ON THE LIVE CATALOGUE 2026-09-11. Nineteen of the seventy-three
  // courses are support or advisory, twelve with twenty or more graded
  // students -- a quarter of the rankable list. Promise Time 9A at 50% and
  // Power Up 8A at 41% sat above most real academic classes, and the reason is
  // selection rather than teaching: students are placed in Power Up BECAUSE
  // they were already failing something. Ranking it beside Algebra 1A answers
  // a question about who was enrolled.
  check("the predicate lives with the classifier, not in the query",
    /export function isSupportBlock/.test(subject) &&
    /SUPPORT_SUBJECT: Subject = "Support & Advisory"/.test(subject));
  check("and records why the rates are not comparable",
    /NOT COMPARABLE TO A CLASS/.test(subject.replace(/\s+/g, " ")));
  check("the query splits them into two lists",
    /rankable\.filter\(\(c\) => !c\.support\)\.sort\(byScore\)/.test(courseFn) &&
    /rankable\.filter\(\(c\) => c\.support\)\.sort\(byScore\)/.test(courseFn));
  check("both are ranked by the same rule", /const byScore = /.test(courseFn));

  // Being above the school rate is what PUTS a student in one of these, so the
  // badge would be true, uninformative, and read as a finding.
  check("a support block is never badged as worse than the school",
    /!c\.support && coverageOk/.test(courseFn));
  check("and the footer says why they are left out of that comparison",
    /being above the school rate is what puts a student in one/.test(renderer));

  check("they are shown rather than hidden",
    /id="acadCoursesSupport"/.test(html) && /d\.support/.test(renderer));
  // Asserted on DOM ORDER, not on source order: the renderer's empty-state
  // branch assigns supportEl.innerHTML before the populated one, so comparing
  // string positions in the source measured the wrong thing.
  check("under a heading that states the caveat", /NOT comparable to/.test(renderer));
  check("and the heading sits above the rows in the markup",
    html.indexOf('id="acadSupportHead"') < html.indexOf('id="acadCoursesSupport"'));
  check("and the tally counts them as their own group",
    /support and advisory blocks, listed separately/.test(renderer));
  // The five groups must still partition the catalogue, or the tally lies.
  check("the split leaves the accounting complete",
    /line\(d\.coursesTotal/.test(renderer) && /line\(d\.support\.length/.test(renderer) &&
    /line\(d\.notRanked\.length/.test(renderer) && /line\(d\.withheldCourses/.test(renderer) &&
    /line\(d\.cohortExcluded/.test(renderer));
}

console.log("\n-- a course list is not a teacher list --");
{
  // At a school of 618 students, naming a course names a colleague. The number
  // cannot carry that caveat, so the copy has to.
  check("the screen says so in the card itself",
    /<strong>classes, not teachers<\/strong>/.test(html));
  check("and says what the data cannot separate",
    /who is placed in it, what it has to cover/.test(html.replace(/\s+/g, " ")));
  check("the server refuses to go down to section level",
    /It does not split by section/.test(server));
  // Rank INTEGERS were removed deliberately: the top two courses overlap
  // across most of their ranges, and a printed "1" claims a resolution the
  // intervals do not support.
  check("no rank integers are printed", !/wc-acad-rank/.test(renderer) && !/wc-acad-rank/.test(css));
  // Whitespace-tolerant: the sentence wraps in index.html, and asserting it on
  // one line is a test about line length rather than about copy.
  // Shown with the concrete example rather than described in the abstract: a
  // reader who sees 55% above 53% and no explanation files a bug.
  check("the card warns that a higher percentage can sit below a lower one",
    /a 55% can sit below a 53%/.test(html.replace(/\s+/g, " ")));
  // The range chip appears on dozens of rows across three cards and used to be
  // explained nowhere.
  check("and explains the range chip once, in words",
    /means the true figure sits/.test(html.replace(/\s+/g, " ")));
}

console.log("\n-- subject is a guess and never pretends otherwise --");
{
  check("the hint says it is guessed", /We guess the subject from the class name/.test(renderer));
  check("and names why: PowerSchool has not granted the field",
    /has not given us that field/.test(renderer));
  // The old wording claimed "catalogue order". The code sorts by how many
  // classes each subject holds, so that was a claim a reader could catch out --
  // and being caught out is how a warning stops being believed.
  check("and describes the real sort order, not an invented one",
    /ordered by how many classes/.test(renderer) &&
    /b\.courses - a\.courses/.test(courseFn));
  check("an unreadable name is admitted, not filed somewhere plausible",
    /Not categorised/.test(subject) && /unclassified/.test(renderer));
  check("coverage is reported in two units, not one",
    /weightedFraction/.test(courseFn) && /weightedFraction/.test(renderer));
  check("because one big unnamed course outweighs five small ones",
    /distorts a rollup\s*\n?\s*\* more than five/.test(subject));
  check("the counting unit is stated on the card",
    /counts grades, not students/.test(renderer));
  // A rollup over a catalogue half of which we could not read is a statement
  // about the guesser.
  check("the whole rollup is refused below 80% of the gradebook",
    /rollupOk = \(naming\.weightedFraction \?\? 0\) >= 0\.8/.test(courseFn) &&
    /say more about our guessing/.test(renderer));
  check("one unnamed course that could swing a subject suppresses it",
    /SINGLE-COURSE SENSITIVITY/.test(courseFn) && /swing > 0\.05/.test(courseFn));
  check("subjects are ordered by catalogue size, never by rate",
    /never by rate/i.test(courseFn) && /ranking of departments/.test(renderer));
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
    /if the student is not passing it/.test(renderer) &&
    /wider net than the class list below/.test(renderer));
  // ...and WHY the two cards disagree, so the mismatch does not read as a bug.
  check("and the reason the two cards differ is given",
    /a pass-fail class has no D to give/.test(renderer));
}

console.log("\n-- every class is accounted for, and the total adds up --");
{
  // THE BUG THIS FIXES IS ARITHMETIC. The old footer named the ranked, the
  // too-small and the protected -- 37 + 14 + 6 = 57 of 73 -- and never
  // mentioned the 16 listed-but-not-ranked at all. Anyone who added it up
  // found a hole, and the owner effectively did: he pasted that paragraph
  // back and asked what it meant.
  check("there is a tally, and it is in the courses card",
    /id="acadCourseTally"/.test(html) &&
    html.indexOf('id="acadCourseTally"') < html.indexOf('id="acadCourses"'));
  check("it is built from the same four numbers the lists are built from",
    /line\(d\.coursesTotal/.test(renderer) &&
    /line\(d\.courses\.length/.test(renderer) &&
    /line\(d\.notRanked\.length/.test(renderer) &&
    /line\(d\.withheldCourses/.test(renderer) &&
    /line\(d\.cohortExcluded/.test(renderer));
  // The four parts are what the server splits the catalogue into, so they add
  // up by construction rather than by a number somebody typed.
  check("and the server's four buckets partition the catalogue",
    /coursesTotal: byCourse\.size/.test(courseFn) &&
    /const notRanked = built\.filter/.test(courseFn) &&
    /const withheldCourses = built\.filter/.test(courseFn) &&
    /cohortExcluded = byCourse\.size - rated\.length/.test(courseFn));
  check("the total is set apart from its parts", /is-total/.test(renderer) &&
    /\.wc-acad-tally-row\.is-total/.test(css));
  check("the counts are tabular so the column reads as a sum",
    /\.wc-acad-tally-n \{[^}]*tabular-nums/.test(css));

  // The footer no longer OPENS by reciting the catalogue split -- "37 of 73
  // courses are ranked" is the tally's job now, and saying it twice was most of
  // what made that paragraph unreadable. It still names 14 and 6, but as the
  // subjects of the sentences that give their reasons ("The 14 classes too
  // small to show are held back because..."), which is what ties a tally line
  // to its justification rather than restating it.
  const footer = renderer.slice(renderer.indexOf("cFoot.textContent"));
  check("the footer no longer recites the catalogue total",
    !/coursesTotal/.test(footer));
  check("but each held-back group still carries its reason",
    /held back because a/.test(footer) && /shares the same protected label/.test(footer));
}

console.log("\n-- the footers can actually break into paragraphs --");
{
  // These footers answer several questions and are set with textContent, so a
  // blank line is the only paragraph break available to them. Without pre-line
  // the newlines collapse and the footer is one breathless wall again.
  check("footers preserve the line breaks written into them",
    /\.wc-acad-foot \{[^}]*white-space: pre-line/.test(css));
  check("and the long footers actually use them",
    /\\n\\n/.test(renderer));
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
