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

const ROLES = ["teacher", "campusaide", "admin", "superadmin"];

console.log("\nDefault deny, every role");
for (const role of ROLES) {
  const d = restrictedFor(role);
  check(`${role} sees NO restricted field`, d.fullyDenied === true, `allowed: ${d.allowed}`);
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
  for (const role of ROLES) {
    const out = redactRestricted(row, role);
    const leaked = RESTRICTED_FIELDS.filter((f) => f in out);
    check(`${role} response carries none of them`, leaked.length === 0, `leaked ${leaked}`);
    check(`${role} still gets the non-restricted fields`,
      out.firstName === "Ana" && out.studentNumber === "11414");
  }
  const json = JSON.stringify(redactRestricted(row, "admin"));
  check("no restricted VALUE survives in the serialized response",
    !/"H"|"EL"|\["W"/.test(json), json);
}

console.log("\nWidening has to be deliberate");
check("no role has been granted anything yet",
  Object.values(ALLOWED_BY_ROLE).every((v) => v.length === 0));
check("every role that exists in the app has an explicit entry",
  ROLES.every((r) => r in ALLOWED_BY_ROLE));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
