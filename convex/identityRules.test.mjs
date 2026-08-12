// Tests for the identity rules that decide staff vs student vs refused.
// Run: npm test
//
// These import the REAL module, not a copy. An earlier version of this logic
// matched the Entra issuer by prefix (startsWith "https://login.microsoftonline.com/"),
// which passed every test here except the cross-tenant one at the bottom. Anyone
// can create a Microsoft tenant and mint an address that looks like staff, so a
// prefix match accepted attackers. That case is why this file exists.

import { classify, normalizeEmail, emailDomain } from "./identityRules.ts";

const OPTS = {
  staffDomain: "lapromisefund.org",
  staffIssuer: "https://login.microsoftonline.com/tenant-abc-123/v2.0",
};
const MS = OPTS.staffIssuer;
const GOOGLE = "https://accounts.google.com";

/** [issuer, email, expected kind or null if it must be refused, label] */
const CASES = [
  [MS, "Teacher.Name@LAPROMISEFUND.ORG", "staff", "Entra mixed-case claim"],
  [MS, "teacher@lapromisefund.org", "staff", "normal staff"],
  [MS, "  Teacher@Lapromisefund.org  ", "staff", "staff, whitespace + case"],
  [GOOGLE, "kid@westbrookacademy.org", "student", "normal student"],
  // Westbrook students are on TWO domains. Students who came up through Russell
  // Westbrook Why Not? Middle School keep an @rwwnms.org address and are just as
  // enrolled. A single domain constant refused every one of them, which is why
  // both are asserted here rather than only the one somebody thought of first.
  [GOOGLE, "magat10856@rwwnms.org", "student", "student on the middle school domain"],
  [GOOGLE, "  MAGAT10856@RWWNMS.org ", "student", "second domain, whitespace + case"],
  // Widening to a list must not have widened it to a suffix match.
  [GOOGLE, "kid@rwwnms.org.evil.test", null, "second domain as a suffix is refused"],
  [GOOGLE, "kid@notrwwnms.org", null, "second domain as a substring is refused"],
  [MS, "magat10856@rwwnms.org", null, "second student domain via Microsoft"],
  [GOOGLE, "  Kid@WestbrookAcademy.org ", "student", "student, whitespace + case"],

  // Privilege escalation, both directions. Checking domain or provider alone
  // lets one of these through.
  [MS, "kid@westbrookacademy.org", null, "student domain via Microsoft"],
  [GOOGLE, "teacher@lapromisefund.org", null, "staff domain via Google"],

  // Google's issuer is shared by every Google account in existence, so the
  // issuer alone proves nothing about school membership.
  [GOOGLE, "anyone@gmail.com", null, "any Google account on earth"],

  // endsWith would accept both of these.
  [GOOGLE, "a@b.westbrookacademy.org.evil.com", null, "suffix spoof, subdomain"],
  [GOOGLE, "kid@westbrookacademy.org.evil.com", null, "suffix spoof, direct"],

  [GOOGLE, "nope", null, "malformed address"],
  [GOOGLE, "", null, "empty address"],
  [GOOGLE, undefined, null, "missing email claim"],
  [GOOGLE, null, null, "null email claim"],
  ["https://evil.example.com/", "x@lapromisefund.org", null, "untrusted issuer"],

  // The one that a prefix match got wrong.
  [
    "https://login.microsoftonline.com/ATTACKER-TENANT/v2.0",
    "attacker@lapromisefund.org",
    null,
    "cross-tenant: staff-looking address minted in another Microsoft tenant",
  ],
];

let pass = 0;
let fail = 0;

function check(label, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
}

console.log("\nIdentity classification");
for (const [issuer, email, want, label] of CASES) {
  let got = null;
  try {
    got = classify(issuer, email, OPTS).kind;
  } catch {
    got = null;
  }
  check(label, got === want, `got ${got}, want ${want}`);
}

console.log("\nEmail normalization");
check("trims and lowercases", normalizeEmail("  A@B.COM ") === "a@b.com");
check("undefined becomes empty", normalizeEmail(undefined) === "");
check("domain extracted", emailDomain("a@b.com") === "b.com");
check(
  "domain uses LAST @, so a@b@c.com is c.com",
  emailDomain("a@b@c.com") === "c.com",
);
check("no @ means no domain", emailDomain("nope") === "");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
