// Discipline analytics.
//
// The assertions that matter most are the ones about NOT saying something.
// A count of referrals by race with no enrolment denominator reads as a rate
// and is a confident wrong answer about children; a ratio computed over four
// students is noise that can also identify them. Both are refused here rather
// than rendered.
//
// Run: npm test

// The school's calendar is Los Angeles. Set before anything reads a clock; the
// calendar checks below also switch zones on purpose to prove that nothing in
// the trend or the "today" helpers depends on the zone the browser is in.
process.env.TZ = "America/Los_Angeles";

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
  // Fixtures carry `date`, the incident day the teacher entered, because that
  // is what a trend now counts. submittedAt stays on them, deliberately on
  // other days, so a trend that slid back to filing time would miscount.
  const rows = [
    ref({ date: "2026-08-03", submittedAt: "2026-08-04T16:00:00Z" }),
    // nothing in the week of the 10th
    ref({ date: "2026-08-17", submittedAt: "2026-08-18T16:00:00Z" }),
    ref({ date: "2026-08-19", submittedAt: "2026-08-20T16:00:00Z" }),
  ];
  const weekly = D.trend(rows, "week");
  check("three weeks are spanned, including the empty one", weekly.points.length === 3);
  check("the quiet week is present with a zero, not omitted",
    weekly.points.some((p) => p.count === 0));
  check("the busy week counts both", weekly.points.some((p) => p.count === 2));
  check("points are oldest first",
    weekly.points[0].key < weekly.points[weekly.points.length - 1].key);

  const monthly = D.trend(
    [ref({ date: "2026-06-01", submittedAt: "2026-06-01T16:00:00Z" }),
     ref({ date: "2026-08-01", submittedAt: "2026-08-03T16:00:00Z" })],
    "month");
  check("monthly spans the gap month too", monthly.points.length === 3);
  check("empty trend does not throw", D.trend([], "week").points.length === 0);
  check("an unparseable date is skipped rather than crashing",
    D.trend([ref({ date: "nonsense", submittedAt: "nonsense" })], "week").points.length === 0);
}

// A synthetic school term shaped like production on 2026-10-07: 18 referrals,
// two of them filed the Monday after a Friday incident. No real names, ids or
// descriptions; only the days matter.
const TERM = (() => {
  const out = [];
  const add = (date, filed, n) => { for (let i = 0; i < n; i++) out.push(ref({ id: `T${out.length}`, date, submittedAt: filed })); };
  add("2026-09-15", "2026-09-15T17:00:00Z", 4);   // week of Sep 14
  add("2026-09-23", "2026-09-23T17:00:00Z", 3);   // week of Sep 21
  add("2026-09-30", "2026-09-30T17:00:00Z", 3);   // week of Sep 28
  add("2026-10-02", "2026-10-05T16:30:00Z", 2);   // Friday incidents, filed Monday
  add("2026-10-05", "2026-10-05T15:10:00Z", 2);   // Monday, the case weekKey got wrong
  add("2026-10-06", "2026-10-07T01:30:00Z", 4);   // after 5pm: UTC is already the 7th
  return out;
})();
const counts = (t) => t.points.map((p) => p.count).join(",");
const labels = (t) => t.points.map((p) => p.label).join(" | ");

console.log("\nTrends count the day of the incident, in the school's calendar");
{
  const t = D.trend(TERM, "week", "2026-10-07");
  check("weeks are labelled 'Week of <Monday>', never '2026-W40'",
    labels(t) === "Week of Sep 14 | Week of Sep 21 | Week of Sep 28 | Week of Oct 5", labels(t));
  check("the key is the Monday as a calendar day", t.points[3].key === "2026-10-05");
  check("counted by incident: Sep 14:4, Sep 21:3, Sep 28:5, Oct 5:6", counts(t) === "4,3,5,6", counts(t));

  // The same rows with no usable incident date fall back to the Los Angeles
  // day they were filed: the old split. Different numbers on purpose.
  const byFiling = D.trend(TERM.map((r) => Object.assign({}, r, { date: "" })), "week", "2026-10-07");
  check("filing time gives a different split (4,3,3,8): the two Friday incidents move",
    counts(byFiling) === "4,3,3,8", counts(byFiling));

  const monday = D.trend([ref({ date: "2026-10-05", submittedAt: "2026-10-05T15:00:00Z" })], "week");
  check("a Monday incident is in its own week, not the one before",
    monday.points.length === 1 && monday.points[0].label === "Week of Oct 5");
  const sunday = D.trend([ref({ date: "2026-10-11", submittedAt: "2026-10-11T18:00:00Z" })], "week");
  check("a Sunday belongs to the week that began on the Monday before it",
    sunday.points[0].key === "2026-10-05");

  const m = D.trend([
    ref({ date: "2026-08-31", submittedAt: "2026-08-31T17:00:00Z" }),
    ref({ date: "2026-09-15", submittedAt: "2026-09-15T17:00:00Z" }),
    ref({ date: "2026-10-02", submittedAt: "2026-10-02T17:00:00Z" }),
  ], "month");
  check("a trend starting on the 31st still has September (the setMonth overflow)",
    m.points.map((p) => p.key).join(",") === "2026-08,2026-09,2026-10" && counts(m) === "1,1,1",
    m.points.map((p) => p.key).join(","));
  check("months are labelled in words", labels(m) === "August 2026 | September 2026 | October 2026", labels(m));

  const tz = process.env.TZ;
  const inZone = (zone) => { process.env.TZ = zone; try { return JSON.stringify(D.trend(TERM, "week", "2026-10-07")); } finally { process.env.TZ = tz; } };
  const la = JSON.stringify(t);
  check("the same answer in Tokyo, London and UTC: the browser's zone moves nothing",
    inZone("Asia/Tokyo") === la && inZone("Europe/London") === la && inZone("UTC") === la);
}

console.log("\nThe range runs to this week only when today is given");
{
  const early = [ref({ date: "2026-09-15", submittedAt: "2026-09-15T17:00:00Z" })];
  const without = D.trend(early, "week");
  check("without today it stops at the last incident (the old tests rely on this)",
    without.points.length === 1 && without.points[0].key === "2026-09-14");
  const withToday = D.trend(early, "week", "2026-10-07");
  check("with today it runs to the current week, quiet weeks as zeros",
    withToday.points.length === 4 && counts(withToday) === "1,0,0,0", counts(withToday));
  check("and the current week is marked as in progress, not quiet",
    withToday.points[3]?.current === true && withToday.points[3]?.key === "2026-10-05" &&
    withToday.points.slice(0, 3).every((p) => p.current === false));
  const monthToday = D.trend(early, "month", "2026-10-07");
  check("monthly runs to the current month too", monthToday.points.map((p) => p.key).join(",") === "2026-09,2026-10");

  const future = D.trend([ref({ date: "2026-09-15" }), ref({ date: "2026-12-01" })], "week", "2026-10-07");
  check("an incident dated after today is not drawn as a future bar",
    future.points[future.points.length - 1].key === "2026-10-05");
  check("but it is counted, so the screen can say so", future.later === 1 && future.earlier === 0);

  const typo = D.trend([ref({ date: "0202-09-15" }), ref({ date: "2026-10-06" })], "week", "2026-10-07");
  check("a mistyped year cannot stretch the chart past its cap",
    typo.points.length === D.MAX_TREND_PERIODS);
  check("the recent end is the part kept", typo.points[typo.points.length - 1].key === "2026-10-05" &&
    typo.points[typo.points.length - 1].count === 1);
  check("and what fell off the front is counted, not dropped silently", typo.earlier === 1);

  const span = D.trend([ref({ date: "2025-12-30" }), ref({ date: "2026-01-06" })], "week");
  check("a week in another year than the chart's says its year",
    labels(span) === "Week of Dec 29, 2025 | Week of Jan 5", labels(span));
}

console.log("\nToday is the school's day, not UTC's");
{
  check("11:30pm in Los Angeles is still the 7th, though UTC is on the 8th",
    D.schoolToday(new Date("2026-10-07T23:30:00-07:00")) === "2026-10-07");
  check("6:30pm likewise (the after-school referral)",
    D.schoolToday(new Date("2026-10-07T18:30:00-07:00")) === "2026-10-07");
  check("in winter time too (4:30pm PST is 00:30 UTC the next day)",
    D.schoolToday(new Date("2026-12-01T16:30:00-08:00")) === "2026-12-01");
  check("just after midnight is the new day",
    D.schoolToday(new Date("2026-10-08T00:05:00-07:00")) === "2026-10-08");
  check("the clock reads Los Angeles wall time, 24-hour",
    D.schoolClock(new Date("2026-10-07T18:30:00-07:00")) === "18:30" &&
    D.schoolClock(new Date("2026-10-08T00:05:00-07:00")) === "00:05");
  check("a timestamp that is not one gives no day", D.schoolDayOf("nonsense") === null && D.schoolDayOf("") === null);

  const tz = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  const tokyo = D.schoolToday(new Date("2026-10-07T23:30:00-07:00"));
  const tokyoClock = D.schoolClock(new Date("2026-10-07T18:30:00-07:00"));
  process.env.TZ = tz;
  check("a device set to Tokyo still gets the Los Angeles day and clock",
    tokyo === "2026-10-07" && tokyoClock === "18:30", `${tokyo} ${tokyoClock}`);

  check("a real calendar day parses", JSON.stringify(D.calendarDay("2026-10-05")) === '{"y":2026,"m":10,"d":5}');
  check("30 February is not a day", D.calendarDay("2026-02-30") === null);
  check("nor is a US-style date", D.calendarDay("10/05/2026") === null);
  check("days step across a month end without a zone", D.addDays("2026-09-30", 1) === "2026-10-01");
  check("and across the autumn clock change", D.addDays("2026-10-31", 2) === "2026-11-02");
  check("'Oct 5, 2026' for a calendar day", D.dayLabel("2026-10-05") === "Oct 5, 2026" && D.dayLabel("x") === "");
}

console.log("\nThe incident day");
{
  check("the date the teacher entered wins over when it was filed",
    D.incidentDay(ref({ date: "2026-10-02", submittedAt: "2026-10-05T16:30:00Z" })) === "2026-10-02");
  check("with no usable date, the Los Angeles day it was filed (02:00 UTC is the evening before)",
    D.incidentDay(ref({ date: "", submittedAt: "2026-10-06T02:00:00Z" })) === "2026-10-05");
  check("and nothing at all is null, not a guess",
    D.incidentDay({ date: "", submittedAt: "" }) === null && D.incidentDay(null) === null);
}

console.log("\nHow a referral was closed, in words");
{
  check("action_taken reads 'Action taken'", D.resolutionLabel("action_taken") === "Action taken");
  check("no_action reads 'No action required'", D.resolutionLabel("no_action") === "No action required");
  check("blank reads 'Not recorded', never a guess", D.resolutionLabel("") === "Not recorded" &&
    D.resolutionLabel(undefined) === "Not recorded");
  check("an unknown code is not printed raw", D.resolutionLabel("escalated_x") === "Not recorded");
  check("nor does an inherited name leak through", D.resolutionLabel("toString") === "Not recorded");
  check("stray whitespace is forgiven", D.resolutionLabel(" no_action ") === "No action required");
}

console.log("\nParent notified comes from the closing actions");
{
  const N = D.PARENT_NOTIFIED_ACTION, C = D.PARENT_CONFERENCE_ACTION;
  check("open is blank, even with the action ticked",
    D.parentNotified(ref({ status: "open", closingActions: [N] })) === "");
  check("closed with the notification ticked is Yes",
    D.parentNotified(ref({ status: "closed", closingActions: ["Other", N] })) === "Yes");
  check("closed with the parent conference ticked is Yes",
    D.parentNotified(ref({ status: "closed", closingActions: [C] })) === "Yes");
  check("closed with neither is No",
    D.parentNotified(ref({ status: "closed", closingActions: ["Isolated and de-escalated the situation"] })) === "No");
  check("closed with no actions at all is No",
    D.parentNotified(ref({ status: "closed" })) === "No");
  check("a legacy row that recorded it the old way stays Yes",
    D.parentNotified(ref({ status: "closed", parentNotified: true })) === "Yes");

  const tally = D.closingActionCounts([
    ref({ status: "closed", closingActions: [N, C] }),
    ref({ status: "closed", closingActions: [N, N] }),
    ref({ status: "closed", closingActions: ["B action", "A action"] }),
    ref({ status: "closed" }),
  ]);
  check("closing actions are counted once per referral, most first",
    tally[0].action === N && tally[0].count === 2);
  check("ties are alphabetical, so the table does not reshuffle",
    tally.slice(1).map((x) => x.action).join("|") === `A action|B action|${C}`);

  // DRIFT GUARD. Closing actions are stored as their labels, so the two
  // strings above must be EXACTLY what the close modal saves.
  const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
  const m = /const REFERRAL_CLOSING_ACTIONS = \[([\s\S]*?)\];/.exec(script);
  const stored = m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : [];
  check("script.js still offers the parent notification, character for character", stored.includes(N));
  check("and the parent conference", stored.includes(C));
}

console.log("\nTEETH: the checks above catch the bugs they describe");
{
  const load = (from, to) => {
    if (src.split(from).length !== 2) throw new Error("teeth anchor not found exactly once: " + from);
    const sb = {};
    new Function("globalThis", src.replace(from, to)).call(sb, sb);
    return sb.WildcatDiscipline;
  };
  const byFiling = load("if (calendarDay(r.date)) return trimmed(r.date);", "");
  check("TEETH: a trend that counts filing time fails the incident split",
    counts(byFiling.trend(TERM, "week", "2026-10-07")) !== "4,3,5,6");

  const utcToday = load("timeZone: SCHOOL_TZ, year: 'numeric'", "year: 'numeric'");
  const tz = process.env.TZ;
  process.env.TZ = "UTC";
  const wrong = utcToday.schoolToday(new Date("2026-10-07T23:30:00-07:00"));
  process.env.TZ = tz;
  check("TEETH: a 'today' that is not pinned to Los Angeles fails on a UTC device", wrong !== "2026-10-07");

  const oldExport = load("if (r.status !== 'closed') return '';", "return r.parentNotified ? 'Yes' : 'No';");
  check("TEETH: the old r.parentNotified read fails the closed-with-notification case",
    oldExport.parentNotified(ref({ status: "closed", closingActions: [D.PARENT_NOTIFIED_ACTION] })) !== "Yes");
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
