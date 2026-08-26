// Discipline analytics.
//
// The assertions that matter most are the ones about NOT saying something.
// A count of referrals by race with no enrolment denominator reads as a rate
// and is a confident wrong answer about children; a ratio computed over four
// students is noise that can also identify them. Both are refused here rather
// than rendered.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");
new Function(src)();
const D = globalThis.WildcatDiscipline;

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

const ref = (over = {}) => Object.assign({
  id: "REF1", studentId: "S1", status: "open",
  submittedAt: "2026-08-19T09:00:00.000Z", behavior: "Defiance",
}, over);

console.log("\nWhat gets captured on a referral");
{
  const snap = D.snapshotDemographics({ grade: "9", school: "High School", gender: "F" });
  check("grade is captured", snap.grade === "9");
  check("school is captured", snap.school === "High School");
  check("gender is captured as sex", snap.sex === "F");

  // A gap must never become a category. "Unknown" in a chart is a group.
  // THE GUARANTEE. Copying race onto a referral would write it into the app
  // blob, which is saved to Firestore and loaded into every staff browser.
  const withRestricted = D.snapshotDemographics({
    grade: "9", race: "Group A", iep: "Yes", gender: "F",
  });
  check("race is NEVER snapshotted onto a referral", !("race" in withRestricted));
  check("nor IEP status", !("iep" in withRestricted));
  check("but the unrestricted fields still are",
    withRestricted.grade === "9" && withRestricted.sex === "F");

  const sparse = D.snapshotDemographics({ grade: "9" });
  check("a missing field is ABSENT, not stored as 'Unknown'",
    !("race" in sparse) && !("sex" in sparse) && !("iep" in sparse));
  check("an empty string is treated as missing",
    !("grade" in D.snapshotDemographics({ grade: "   " })));
  check("a null student does not throw", typeof D.snapshotDemographics(null) === "object");
}

console.log("\nThe snapshot is read in preference to the live record");
{
  // A referral records an incident on a date. Grade changes every year, so
  // reading it live in September would relabel last spring's referrals.
  const r = ref({ studentGrade: "10", demographics: { grade: "9" } });
  check("the grade AT FILING wins over the current one", D.valueOf(r, "grade") === "9");
  check("a legacy referral still resolves from studentGrade",
    D.valueOf(ref({ studentGrade: "11" }), "grade") === "11");
  check("an absent dimension is null, not empty string",
    D.valueOf(ref(), "race") === null);
}

console.log("\nAvailability is measured from the data, never hardcoded");
{
  const rows = [ref({ demographics: { grade: "9" } }), ref({ demographics: { grade: "10" } })];
  const grade = D.availability(rows, "grade");
  check("grade reads as available", grade.available === true);
  check("with full coverage", grade.coverage === 1);

  const race = D.availability(rows, "race");
  check("race reads as unavailable", race.available === false);
  check("and is flagged restricted", race.restricted === true);
  // Race is no longer derived from referral snapshots at all: it is served by
  // the server so no child's race reaches this browser. The message has to say
  // which of the two reasons applies, because they need different responses.
  check("its message names both reasons it could be empty",
    /sync has not loaded/.test(race.unblock) && /role is not admin/.test(race.unblock));

  const iep = D.availability(rows, "iep");
  check("IEP says the source is unconfirmed, not that it was denied",
    /registrar/.test(iep.unblock));

  // Sex is manifest field 9, fieldClass "Standard": already granted in
  // plugin.xml and already selected by the roster query. It was never an
  // approval question, only a sync gap, and the sync now carries it.
  check("sex is NOT described as restricted", D.DIMENSIONS.sex.restricted === false);
  check("its unblock points at a sync run, not an approval",
    /twice-daily sync has not run/.test(D.DIMENSIONS.sex.unblock) &&
    !/approval/.test(D.DIMENSIONS.sex.unblock.replace('not an approval', '')));
  check("and it warns that older referrals stay empty",
    /keep whatever was recorded at the time/.test(D.DIMENSIONS.sex.unblock));

  const partial = D.availability([ref({ demographics: { grade: "9" } }), ref()], "grade");
  check("partial coverage is reported as a fraction, not rounded to available",
    partial.coverage === 0.5 && partial.covered === 1);
}

console.log("\nSex is labelled for a reader, never rewritten");
{
  check("M displays as Male", D.displayValue('sex', 'M') === 'Male');
  check("F displays as Female", D.displayValue('sex', 'F') === 'Female');
  check("lowercase from the SIS still resolves", D.displayValue('sex', 'f') === 'Female');
  // The one that matters: a district recording something else must not be
  // bucketed into M/F, and must not be relabelled at all.
  check("an unexpected value passes through UNCHANGED",
    D.displayValue('sex', 'X') === 'X' && D.displayValue('sex', 'Non-binary') === 'Non-binary');
  check("other dimensions are never relabelled",
    D.displayValue('grade', 'M') === 'M' && D.displayValue('school', 'F') === 'F');
  check("blank stays blank rather than becoming a category",
    D.displayValue('sex', '') === '' && D.displayValue('sex', null) === '');

  // The snapshot still records what the SIS holds, not the label.
  check("the referral stores the raw SIS value, not the display label",
    D.snapshotDemographics({ gender: 'M' }).sex === 'M');
  check("and reads it from either field name",
    D.snapshotDemographics({ sex: 'F' }).sex === 'F');
}

console.log("\nBackfilling sex is safe; backfilling grade is not");
{
  const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
  const block = script.slice(script.indexOf("SEX IS RESOLVED FROM THE ROSTER"),
                             script.indexOf("el.innerHTML = dims.map"));
  check("only sex is resolved from the live roster",
    /demographics: Object\.assign\(\{\}, r\.demographics \|\| \{\}, \{ sex: sex \}\)/.test(block));
  check("grade is explicitly NOT backfilled the same way",
    /GRADE IS DELIBERATELY NOT\n\s*\/\/ BACKFILLED THIS WAY/.test(block));
  check("an existing snapshot is never overwritten",
    /if \(already\) return r;/.test(block));
  check("and the referral itself is not mutated",
    /Object\.assign\(\{\}, r, \{/.test(block));
  check("how many were resolved is surfaced to the reader",
    /filed before sex was\n\s*synced from PowerSchool/.test(script));
}

console.log("\nRates, not counts");
{
  // 60 of 100 referrals to a group that is 60% of the school is PROPORTIONATE.
  //
  // Counts scaled x10 from the original 6/4 when MIN_REFERRALS_FOR_INDEX
  // arrived: an index is no longer computed from a handful of referrals, and
  // the ratios these assertions check are unchanged by the scaling.
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(ref({ studentId: "A" + i, demographics: { race: "GroupA" } }));
  for (let i = 0; i < 40; i++) rows.push(ref({ studentId: "B" + i, demographics: { race: "GroupB" } }));

  const noDenominator = D.breakdownBy(rows, "race");
  check("without enrolment there is NO index", noDenominator.rows.every((r) => r.index === null));
  check("and the caller is told the denominator is missing",
    noDenominator.hasDenominator === false);
  check("counts are still reported", noDenominator.rows[0].count === 60);

  const withDenominator = D.breakdownBy(rows, "race", { GroupA: 600, GroupB: 400 });
  const a = withDenominator.rows.find((r) => r.value === "GroupA");
  const b = withDenominator.rows.find((r) => r.value === "GroupB");
  check("a proportionate group scores 1.0, not 'the biggest bar'", Math.abs(a.index - 1) < 1e-9);
  check("so does the smaller group", Math.abs(b.index - 1) < 1e-9);
  check("share of enrolment is reported alongside", Math.abs(a.shareOfEnrollment - 0.6) < 1e-9);

  // Now a genuinely disproportionate case.
  const skewed = [];
  for (let i = 0; i < 80; i++) skewed.push(ref({ studentId: "C" + i, demographics: { race: "GroupA" } }));
  for (let i = 0; i < 20; i++) skewed.push(ref({ studentId: "D" + i, demographics: { race: "GroupB" } }));
  const s = D.breakdownBy(skewed, "race", { GroupA: 400, GroupB: 600 });
  const sa = s.rows.find((r) => r.value === "GroupA");
  check("a group referred at twice its enrolment share scores 2.0",
    Math.abs(sa.index - 2) < 1e-9);
}

console.log("\nA ratio is not computed from a handful of referrals");
{
  // THE REPORTED CASE. Six referrals, one to a group that is 7% of the school.
  // That produced 2.38, and zero referrals produces 0.00, with nothing in
  // between: the group cannot score near 1.0 no matter what is true.
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(ref({ studentId: "H" + i, demographics: { race: "Hispanic" } }));
  rows.push(ref({ studentId: "B1", demographics: { race: "Black" } }));

  const out = D.breakdownBy(rows, "race", { Hispanic: 560, Black: 44 });
  const black = out.rows.find((r) => r.value === "Black");
  const hisp = out.rows.find((r) => r.value === "Hispanic");

  check("a group with one referral gets NO index", black.index === null);
  check("and says why, distinctly from privacy suppression",
    black.tooFewReferrals === true && black.suppressed === false);
  check("its count is still reported, because that is a fact", black.count === 1);
  check("so is its share of referrals",
    Math.abs(black.shareOfReferrals - 1 / 6) < 1e-9);
  check("so is its enrolment share, which is what makes the count readable",
    Math.abs(black.shareOfEnrollment - 44 / 604) < 1e-9);

  // The majority group is equally uncomputable at this volume, even though
  // its 0.93 looked reassuringly precise.
  check("the majority group is ALSO withheld at five referrals",
    hisp.index === null && hisp.tooFewReferrals === true);

  check("the threshold is reported so the UI can explain itself",
    out.minReferralsForIndex === D.MIN_REFERRALS_FOR_INDEX);

  // At the threshold the index appears, and is correct.
  const many = [];
  for (let i = 0; i < 10; i++) many.push(ref({ studentId: "B" + i, demographics: { race: "Black" } }));
  for (let i = 0; i < 90; i++) many.push(ref({ studentId: "H" + i, demographics: { race: "Hispanic" } }));
  const big = D.breakdownBy(many, "race", { Black: 100, Hispanic: 900 });
  const b2 = big.rows.find((r) => r.value === "Black");
  check("at exactly the threshold the index appears", b2.tooFewReferrals === false);
  check("and it is proportionate, not inflated", Math.abs(b2.index - 1) < 1e-9);

  // A group over the threshold that IS disproportionate still says so.
  const skew = [];
  for (let i = 0; i < 30; i++) skew.push(ref({ studentId: "B" + i, demographics: { race: "Black" } }));
  for (let i = 0; i < 70; i++) skew.push(ref({ studentId: "H" + i, demographics: { race: "Hispanic" } }));
  const s2 = D.breakdownBy(skew, "race", { Black: 100, Hispanic: 900 });
  check("real disproportionality is NOT hidden by the new rule",
    Math.abs(s2.rows.find((r) => r.value === "Black").index - 3) < 1e-9);
}

console.log("\nSmall groups are suppressed, not published");
{
  const rows = [ref({ demographics: { race: "Tiny" } })];
  // Big needs enough referrals to clear MIN_REFERRALS_FOR_INDEX, or "not
  // suppressed" would pass for the wrong reason and stop testing suppression.
  for (let i = 0; i < 12; i++) rows.push(ref({ studentId: "S" + i, demographics: { race: "Big" } }));
  const out = D.breakdownBy(rows, "race", { Tiny: 4, Big: 900 });
  const tiny = out.rows.find((r) => r.value === "Tiny");
  check("a group below the threshold is marked suppressed", tiny.suppressed === true);
  check("and gets NO index, because it would be noise and could identify",
    tiny.index === null);
  check("but its count is still there, so it is not hidden entirely", tiny.count === 1);
  check("the threshold is reported so the UI can explain itself",
    out.smallGroupThreshold === D.SMALL_GROUP);

  const big = out.rows.find((r) => r.value === "Big");
  check("a large group is not suppressed", big.suppressed === false && big.index !== null);
  // Both flags can be true here, and that is fine: this module runs in the
  // browser, which already holds every referral, so nothing is leaked by
  // saying so. The SERVER deliberately reports tooFewReferrals as false for a
  // suppressed group, because there the flag would be a second fact about a
  // group too small to describe — asserted in convex/raceRollup.test.mjs.
  check("suppression and too-few are independent flags",
    tiny.suppressed === true && tiny.tooFewReferrals === true);
}

console.log("\nMissing values are counted, never bucketed");
{
  const rows = [ref({ demographics: { grade: "9" } }), ref(), ref()];
  const out = D.breakdownBy(rows, "grade");
  check("referrals with no value are counted as missing", out.missing === 2);
  check("and do NOT appear as a category", out.rows.every((r) => r.value !== "Unknown"));
  check("shares are computed over what was counted, not the total",
    Math.abs(out.rows[0].shareOfReferrals - 1) < 1e-9);
}

console.log("\nBehaviours");
{
  const rows = [
    ref({ behavior: "Defiance", studentId: "S1" }),
    ref({ behavior: "Defiance", studentId: "S1" }),
    ref({ behavior: "Defiance", studentId: "S2" }),
    ref({ behavior: "Tardiness", studentId: "S3" }),
    ref({ behavior: "", studentId: "S4" }),
  ];
  const out = D.behaviorBreakdown(rows);
  check("most referred behaviour is first", out[0].behavior === "Defiance");
  check("counted correctly", out[0].count === 3);
  check("unique students distinguishes 3 incidents from 3 children",
    out[0].uniqueStudents === 2);
  check("a blank behaviour is labelled, not dropped",
    out.some((b) => b.behavior === "Unspecified"));
  check("shares sum to 1", Math.abs(out.reduce((n, b) => n + b.share, 0) - 1) < 1e-9);
}

console.log("\nTrends include quiet periods");
{
  const rows = [
    ref({ submittedAt: "2026-08-03T09:00:00Z" }),
    // nothing in the week of the 10th
    ref({ submittedAt: "2026-08-17T09:00:00Z" }),
    ref({ submittedAt: "2026-08-19T09:00:00Z" }),
  ];
  const weekly = D.trend(rows, "week");
  check("three weeks are spanned, including the empty one", weekly.points.length === 3);
  check("the quiet week is present with a zero, not omitted",
    weekly.points.some((p) => p.count === 0));
  check("the busy week counts both", weekly.points.some((p) => p.count === 2));
  check("points are oldest first",
    weekly.points[0].key < weekly.points[weekly.points.length - 1].key);

  const monthly = D.trend(
    [ref({ submittedAt: "2026-06-01T09:00:00Z" }), ref({ submittedAt: "2026-08-01T09:00:00Z" })],
    "month");
  check("monthly spans the gap month too", monthly.points.length === 3);
  check("empty trend does not throw", D.trend([], "week").points.length === 0);
  check("an unparseable date is skipped rather than crashing",
    D.trend([ref({ submittedAt: "nonsense" })], "week").points.length === 0);
}

console.log("\nHeadline summary");
{
  const rows = [
    ref({ studentId: "S1", status: "open" }),
    ref({ studentId: "S1", status: "closed" }),
    ref({ studentId: "S2", status: "open" }),
  ];
  const s = D.summary(rows, Date.parse("2026-08-19T12:00:00Z"));
  check("totals", s.total === 3 && s.open === 2 && s.closed === 1);
  check("unique students, not referral count", s.uniqueStudents === 2);
  // 12 referrals from 3 students is a different problem from 12 students.
  check("repeat students are surfaced", s.repeatStudents === 1);
  check("this week is counted from the given clock", s.thisWeek === 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
