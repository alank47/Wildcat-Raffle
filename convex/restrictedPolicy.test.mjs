// Who can see restricted student data.
//
// The brief calls Phase 5 "the phase that decides whether we ship" and says to
// test the negative cases, not the happy path. These are the negative cases.
//
// Default is deny for EVERY role including admins, because nobody has yet named
// what decision federal race or ethnicity informs in a teacher-facing
// dashboard, and the brief says to descope absent an answer.
import { RESTRICTED_FIELDS, ALLOWED_BY_ROLE, restrictedFor, redactRestricted }
  from "./restrictedPolicy.ts";

let pass = 0, fail = 0;
const check = (l, c, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${l}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? `  (${d})` : ""}`); }
};

const ROLES = ["teacher", "campusaide", "pbis", "admin", "superadmin"];

// Widened 2026-08-19 by the app owner, recorded in
// docs/field-sourcing-approval.md, so an administrator can verify that the
// discipline aggregate counts correctly. Everyone else stays fully denied,
// and the gap between PBIS and admin is the design, not an oversight.
const DENIED_ROLES = ["teacher", "campusaide", "pbis"];
const VERIFIER_ROLES = ["admin", "superadmin"];
const VERIFIER_FIELDS = ["fedEthnicity", "raceCodes"];

console.log("\nDefault deny still holds for everyone who was not widened");
for (const role of DENIED_ROLES) {
  const d = restrictedFor(role);
  check(`${role} sees NO restricted field`, d.fullyDenied === true, `allowed: ${d.allowed}`);
}

console.log("\nThe widening reaches exactly two roles and exactly two fields");
for (const role of VERIFIER_ROLES) {
  const d = restrictedFor(role);
  check(`${role} sees race and ethnicity`,
    VERIFIER_FIELDS.every((f) => d.allowed.includes(f)), `allowed: ${d.allowed}`);
  // The line that matters most: verification does not become everything.
  check(`${role} still CANNOT see IEP, 504 or English Learner`,
    ["iepStatus", "section504", "elaStatus"].every((f) => d.denied.includes(f)),
    `allowed: ${d.allowed}`);
  check(`${role} is not fullyDenied any more`, d.fullyDenied === false);
}
check("an unknown role is denied too, not defaulted open",
  restrictedFor("principal").fullyDenied === true);
check("an empty role string is denied", restrictedFor("").fullyDenied === true);

console.log("\nThe restricted set matches the brief");
for (const [n, f] of [[7,"fedEthnicity"],[8,"raceCodes"],[12,"iepStatus"],[13,"section504"],[14,"elaStatus"]]) {
  check(`manifest ${n} (${f}) is restricted`, RESTRICTED_FIELDS.includes(f));
}
check("exactly five restricted fields, no drift", RESTRICTED_FIELDS.length === 5);

console.log("\nRedaction actually removes the values");
{
  const row = {
    studentNumber: "11414", firstName: "Ana", grade: "9",
    fedEthnicity: "H", raceCodes: ["W", "A"], iepStatus: "Y",
    section504: "Y", elaStatus: "EL",
  };
  for (const role of DENIED_ROLES) {
    const out = redactRestricted(row, role);
    const leaked = RESTRICTED_FIELDS.filter((f) => f in out);
    check(`${role} response carries none of them`, leaked.length === 0, `leaked ${leaked}`);
    check(`${role} still gets the non-restricted fields`,
      out.firstName === "Ana" && out.studentNumber === "11414");
  }
  const teacherJson = JSON.stringify(redactRestricted(row, "teacher"));
  check("no restricted VALUE survives for a denied role",
    !/"H"|"EL"|\["W"|"Y"/.test(teacherJson), teacherJson);

  for (const role of VERIFIER_ROLES) {
    const out = redactRestricted(row, role);
    check(`${role} receives race and ethnicity`,
      out.fedEthnicity === "H" && Array.isArray(out.raceCodes));
    // Widening two fields must not quietly pass the other three through.
    check(`${role} still receives NOTHING about IEP, 504 or EL`,
      !("iepStatus" in out) && !("section504" in out) && !("elaStatus" in out),
      JSON.stringify(out));
    check(`${role} response carries no EL value`,
      !/"EL"/.test(JSON.stringify(out)));
  }
}

console.log("\nWidening has to be deliberate");
check("only admin and superadmin hold anything",
  Object.entries(ALLOWED_BY_ROLE)
    .filter(([, v]) => v.length > 0)
    .map(([k]) => k).sort().join() === "admin,superadmin");
check("and only race and ethnicity, never the other three",
  Object.values(ALLOWED_BY_ROLE).flat()
    .every((f) => VERIFIER_FIELDS.includes(f)));
check("every role that exists in the app has an explicit entry",
  ROLES.every((r) => r in ALLOWED_BY_ROLE));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
