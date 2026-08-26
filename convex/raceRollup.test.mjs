// Federal reporting categories: ethnicity first, then race.
//
// THE BUG THIS FILE EXISTS TO STOP COMING BACK.
//
// The first race chart mapped raceCodes and ignored fedEthnicity. In
// California that reports a predominantly Hispanic school as White, because
// Hispanic students still answer the race question and very commonly answer
// it 700. The school's admin caught it on sight; the app could not have.
//
// Run: npm test

import { readFileSync } from "node:fs";
import {
  reportedCategories, classifyEthnicity, raceLabel, HISPANIC_LABEL,
} from "./raceRollup.ts";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\nEthnicity is asked first, and it wins");
{
  // THE REGRESSION. A Hispanic student whose race code is 700.
  const r = reportedCategories({ fedEthnicity: "1", raceCodes: ["700"] });
  check("a Hispanic student with code 700 reports as Hispanic",
    r.categories.length === 1 && r.categories[0] === HISPANIC_LABEL);
  check("and is NOT reported as White", !r.categories.includes("White"));
  check("the basis says ethnicity decided it", r.basis === "ethnicity");

  // The whole-school version of the same thing.
  const school = [
    { fedEthnicity: "1", raceCodes: ["700"] },
    { fedEthnicity: "1", raceCodes: ["700"] },
    { fedEthnicity: "1", raceCodes: ["800"] },
    { fedEthnicity: "1", raceCodes: [] },
  ].map(reportedCategories);
  check("a school of Hispanic students yields NO White category",
    school.every((s) => !s.categories.includes("White")));
  check("every one of them is counted, not dropped",
    school.every((s) => s.categories[0] === HISPANIC_LABEL));

  // Even with a race code in a different category.
  const black = reportedCategories({ fedEthnicity: "1", raceCodes: ["600"] });
  check("ethnicity wins over 600 as well", black.categories[0] === HISPANIC_LABEL);
  check("but the race labels are still computed for verification",
    black.raceLabels.includes("Black or African American"));
}

console.log("\nA non-Hispanic student is categorised by race");
{
  const w = reportedCategories({ fedEthnicity: "0", raceCodes: ["700"] });
  check("code 700 with ethnicity 'no' IS White", w.categories[0] === "White");
  check("basis says race decided it", w.basis === "race");

  const multi = reportedCategories({ fedEthnicity: "0", raceCodes: ["600", "700"] });
  check("two categories count under BOTH, not 'Two or more'",
    multi.categories.length === 2 &&
    multi.categories.includes("White") &&
    multi.categories.includes("Black or African American"));

  const dedup = reportedCategories({ fedEthnicity: "0", raceCodes: ["203", "207"] });
  check("two Asian subcodes collapse to ONE Asian, not two",
    dedup.categories.length === 1 && dedup.categories[0] === "Asian");
}

console.log("\nUnknown ethnicity is never silently treated as 'not Hispanic'");
{
  const u = reportedCategories({ raceCodes: ["700"] });
  check("a missing ethnicity reads as unknown", u.ethnicity === "unknown");
  check("an unrecognised ethnicity value also reads as unknown",
    reportedCategories({ fedEthnicity: "??", raceCodes: ["700"] }).ethnicity === "unknown");
  // It still falls through to race, because there is nothing else to do, but
  // the caller can SEE that it did and count how often.
  check("it falls through to race so the student is not lost",
    u.categories[0] === "White" && u.basis === "race");
  check("a student with neither answer reports nothing at all",
    reportedCategories({}).basis === "none" &&
    reportedCategories({}).categories.length === 0);
}

console.log("\nThe ethnicity flag is read the way PowerSchool actually writes it");
{
  ["1", "Y", "yes", "H", "true", "Hispanic", "Hispanic or Latino"].forEach((v) =>
    check(`'${v}' reads as Hispanic`, classifyEthnicity(v) === "hispanic"));
  ["0", "N", "no", "false", "Not Hispanic", "non-hispanic"].forEach((v) =>
    check(`'${v}' reads as not Hispanic`, classifyEthnicity(v) === "not"));
  check("blank is unknown, not 'not'", classifyEthnicity("") === "unknown");
  check("null is unknown, not 'not'", classifyEthnicity(null) === "unknown");
  check("whitespace is unknown", classifyEthnicity("   ") === "unknown");
  // The dangerous one: anything unrecognised must not default to "not".
  check("an unexpected value is unknown, NOT 'not'",
    classifyEthnicity("2") === "unknown" && classifyEthnicity("Latino") === "unknown");
}

console.log("\nAn unrecognised race code is flagged, never guessed");
{
  const r = reportedCategories({ fedEthnicity: "0", raceCodes: ["800"] });
  check("code 800 gets no category", r.categories.length === 0);
  check("and is reported as unmapped so it is visible", r.unmapped.includes("800"));
  check("basis is none, not race", r.basis === "none");
  check("raceLabel flags it rather than naming it", raceLabel("800").mapped === false);
  check("a mapped code is flagged mapped", raceLabel("600").mapped === true);

  const mixed = reportedCategories({ fedEthnicity: "0", raceCodes: ["600", "800"] });
  check("a good code alongside a bad one still counts",
    mixed.categories.includes("Black or African American"));
  check("and the bad one is still surfaced", mixed.unmapped.includes("800"));
}

console.log("\nThe category set matches federal reporting");
{
  check("100 is American Indian or Alaska Native",
    raceLabel("100").label === "American Indian or Alaska Native");
  check("400 stays Filipino, which CALPADS reports separately",
    raceLabel("400").label === "Filipino");
  check("3xx is Native Hawaiian or Other Pacific Islander",
    raceLabel("301").label === "Native Hawaiian or Other Pacific Islander");
  check("2xx rolls up to Asian rather than naming a national origin",
    raceLabel("203").label === "Asian" && raceLabel("207").label === "Asian");
}

console.log("\nThe aggregate query uses the rollup, and verification is admin-only");
{
  const agg = readFileSync(new URL("./disciplineAggregates.ts", import.meta.url), "utf8");
  check("byRace builds categories from reportedCategories",
    /reportedCategories/.test(agg));
  // The regression guard: a local mapper here is how the bug happened.
  check("it does NOT define its own race mapping any more",
    !/function raceLabel/.test(agg));
  check("it reports how many students have an unknown ethnicity",
    /unknownEthnicity/.test(agg));

  check("raceVerification requires an admin, not a role array",
    /raceVerification[\s\S]*?requireAdmin\(ctx\)/.test(agg));
  check("PBIS cannot reach it: it is not gated on AGGREGATE_ROLES",
    !/raceVerification[\s\S]*?AGGREGATE_ROLES/.test(agg));
  check("byRace still returns rows without any student identifier",
    !/studentNumber:\s*num,[\s\S]{0,200}count:/.test(agg));

  // The server serves the race index, so the minimum-referral rule has to
  // live here too. Enforcing it only in the browser would leave the real
  // number in the network response for anyone who looked.
  check("an index is withheld below the minimum referral count",
    /const MIN_REFERRALS_FOR_INDEX = 10;/.test(agg) &&
    /suppressed \|\| tooFewReferrals \|\| !shareOfEnrollment/.test(agg));
  check("that is reported separately from privacy suppression",
    /tooFewReferrals: suppressed \? false : tooFewReferrals/.test(agg));
  check("and the threshold is returned so the UI can name it",
    /minReferralsForIndex: MIN_REFERRALS_FOR_INDEX/.test(agg));
  // Counts and shares are facts; only the ratio is an inference.
  check("counts and shares are still returned at low volume",
    /count: suppressed \? null : count/.test(agg) &&
    !/count: tooFewReferrals/.test(agg));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
