// The PBIS role: what it can reach, and what it must never reach.
//
// The distinction this pins is the one the app owner drew on 2026-08-19:
// counts by race, never a child's race. Those are different permissions and
// only the first was granted. Several assertions below exist to stop the
// second arriving by accident later.
//
// Run: npm test

import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
const policy = read("restrictedPolicy.ts");
const access = read("accessRules.ts");
const identity = read("identity.ts");
const schema = read("schema.ts");
const aggregates = read("disciplineAggregates.ts");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\nThe role exists everywhere a role is declared");
check("schema accepts pbis", /v\.literal\("pbis"\)/.test(schema));
check("staff invites accept pbis", /v\.literal\("pbis"\)/.test(read("staffInvites.ts")));
check("seed accepts pbis", /v\.literal\("pbis"\)/.test(read("seed.ts")));

console.log("\nPBIS is NOT an admin");
// The whole reason for the role. Admin unlocks the cash reset, the year
// rollover, staff invites and role changes; PBIS must reach none of it.
check("requireAdmin tests admin and superadmin only",
  /role !== "admin" && \w*\.?role !== "superadmin"/.test(identity.replace(/teacher\./g, "")));
check("requireAdmin does not mention pbis", !/pbis/.test(identity));
check("pbis is not in ADMIN_ROLES",
  /const ADMIN_ROLES = \["admin", "superadmin"\]/.test(access));

console.log("\nPBIS sees students, because a reviewer reads across the school");
check("pbis is campus-wide alongside campusaide",
  /CAMPUS_WIDE_ROLES = \["campusaide", "pbis"\]/.test(access));

console.log("\nBut PBIS CANNOT see an individual child's protected data");
// This is the line that must not move. Aggregates are served separately.
check("pbis is listed in ALLOWED_BY_ROLE", /pbis: \[\]/.test(policy));
check("and its allowlist is EMPTY", /pbis: \[\],/.test(policy));
// admin and superadmin WERE widened on 2026-08-19, for verifying the
// aggregate. The assertion that matters is that the widening stopped there.
check("teacher has no restricted field", /teacher: \[\],/.test(policy));
check("campusaide has no restricted field", /campusaide: \[\],/.test(policy));
check("pbis has no restricted field", /pbis: \[\],/.test(policy));
check("admin was widened to race and ethnicity ONLY",
  /admin: \["fedEthnicity", "raceCodes"\]/.test(policy));
check("and not to IEP, 504 or English Learner",
  !/admin: \[[^\]]*(iepStatus|section504|elaStatus)/.test(policy));
check("the reason is recorded next to it",
  /only the first was/.test(policy) && /WIDENED 2026-08-19/.test(policy));

console.log("\nThe aggregate never returns a student");
check("it is a query, not a table read the caller can shape",
  /export const byRace = query\(/.test(aggregates));
check("only admin, superadmin and pbis may call it",
  /AGGREGATE_ROLES = \["admin", "superadmin", "pbis"\]/.test(aggregates));
check("a caller without the role is refused, not given empty rows silently",
  /allowed: false/.test(aggregates) && /Ask an administrator to set your access level/.test(aggregates));

console.log("\nSuppression happens on the server, not in the browser");
// Browser-side suppression is cosmetic: the network response still carries
// the raw cell. For "aggregate only" to be a property, it must never be sent.
check("a suppressed group returns null for count",
  /count: suppressed \? null : count/.test(aggregates));
check("and null for enrolment", /enrolled: suppressed \? null : enrolled/.test(aggregates));
check("and null for both shares",
  /shareOfReferrals: suppressed \? null/.test(aggregates) &&
  /shareOfEnrollment: suppressed \? null/.test(aggregates));
check("and null for the index", /index:\s*\n?\s*suppressed/.test(aggregates));
check("the threshold is 10 enrolled", /const SMALL_GROUP = 10;/.test(aggregates));
check("how many groups were withheld is reported, so totals reconcile",
  /groupsWithheld: withheld/.test(aggregates));

console.log("\nMulti-race students are not collapsed");
check("a student with several codes counts under each",
  /for \(const code of codes\) referralsBy\[code\]/.test(aggregates));
// The decision moved into raceRollup.ts when ethnicity was added, so the
// guarantee is asserted where it is actually made. raceRollup.test.mjs proves
// the behaviour; this pins that the rule stays written down next to it.
check("and the reason is recorded",
  /never collapsed into "Two or more races"/.test(read("raceRollup.ts")));
check("the aggregate says so too, where a reader of that file will see it",
  /never collapsed into "Two or more races"/.test(aggregates));

console.log("\nEthnicity is asked before race, or the chart is wrong");
// The bug that made this necessary: reading raceCodes alone reports a
// predominantly Hispanic school as White, because Hispanic students still
// answer the race question and commonly answer it 700.
check("the aggregate categorises through raceRollup, not its own mapper",
  /reportedCategories/.test(aggregates) && !/function raceLabel/.test(aggregates));

console.log("\nIndividual race stays out of PBIS's reach");
// raceVerification returns a named child's race. It is the one thing PBIS was
// explicitly not given, so it must never be gated on the aggregate role list.
check("verification is gated on requireAdmin",
  /raceVerification[\s\S]*?requireAdmin\(ctx\)/.test(aggregates));
check("and pbis is not named anywhere near it",
  !/raceVerification[\s\S]*?"pbis"/.test(aggregates));

console.log("\nMissing data is reported, not hidden");
check("referrals with no race record are counted as unmatched",
  /unmatched: unmatched/.test(aggregates) || /unmatched,/.test(aggregates));
check("an unloaded psRestricted says so rather than returning zeros",
  /loaded: false/.test(aggregates));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
