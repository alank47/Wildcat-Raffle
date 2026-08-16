// Tests for the identity rules that decide staff vs student vs refused.
// Run: npm test
//
// These import the REAL module, not a copy. An earlier version of this logic
// matched the Entra issuer by prefix (startsWith "https://login.microsoftonline.com/"),
// which passed every test here except the cross-tenant one at the bottom. Anyone
// can create a Microsoft tenant and mint an address that looks like staff, so a
// prefix match accepted attackers. That case is why this file exists.

import {
  classify,
  normalizeEmail,
  emailDomain,
  studentRecordVerdict,
} from "./identityRules.ts";

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
  // Widening to a list must not have widened it to a suffix match.
  [GOOGLE, "kid@rwwnms.org.evil.test", null, "second domain as a suffix is refused"],
  [GOOGLE, "kid@notrwwnms.org", null, "second domain as a substring is refused"],
  // The RWWN middle and high school domains are RETIRED (user, 2026-08-12).
  // 9 PowerSchool records still carry one. A stale SIS record is not a second
  // valid identity, so both are refused.
  [GOOGLE, "magat10856@rwwnms.org", null, "retired middle school domain is refused"],
  [GOOGLE, "kescobar11306@rwwnhs.org", null, "retired high school domain is refused"],
  // And a real typo in a real PowerSchool record: student 11895 carries
  // ep11895@westrbookacademy.org. It is REFUSED, because nobody owns that
  // domain, but the refusal has to explain itself or the next person debugs
  // the auth layer instead of fixing the SIS.
  [GOOGLE, "ep11895@westrbookacademy.org", null, "transposition typo domain is refused"],
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

// The typo refusal must name the intended domain. A generic "Not a student
// account" sends somebody to debug sign in for an address that is simply
// misspelled in PowerSchool.
console.log("\nTypo domains explain themselves");
{
  let message = "";
  try {
    classify(GOOGLE, "ep11895@westrbookacademy.org", OPTS);
  } catch (e) {
    message = String(e?.data ?? e?.message ?? e);
  }
  check("the refusal names the offending domain", message.includes("westrbookacademy.org"), message);
  check("and names the domain to use instead", message.includes("westbrookacademy.org"), message);
  check("and points at PowerSchool, not at the app", /PowerSchool/i.test(message), message);
}

{
  let retired = "";
  try { classify(GOOGLE, "magat10856@rwwnms.org", OPTS); } catch (e) { retired = String(e?.data ?? e?.message ?? e); }
  check("a retired domain says it is retired", /retired/i.test(retired), retired);
  check("and still names where to fix it", /PowerSchool/i.test(retired), retired);
}

// A VALID TOKEN IS NOT ENROLMENT.
//
// sisSync.ts:92 archives a student who falls off the PowerSchool roster and
// keeps the row, the balance and the email, correctly: a transfer still has
// money and a roster gap is not proof a person ceased to exist. Nothing read
// that flag at the door, so a withdrawn student with a working Google account
// kept full access, and the student portal turned that from reading their own
// card into WRITING hall pass and tap records. Somebody who left in October
// could open a pass in November and appear on a teacher's live board as a child
// currently out of the building.
console.log("\nAn archived student cannot act");
{
  check("a current student may act", studentRecordVerdict({}).ok);
  check("an explicitly un-archived student may act", studentRecordVerdict({ archivedAt: undefined }).ok);
  check("a null archivedAt is not archived", studentRecordVerdict({ archivedAt: null }).ok);

  const archived = studentRecordVerdict({ archivedAt: "2026-08-01T00:00:00.000Z" });
  check("an archived student is refused", !archived.ok);

  // The wording is the requirement, not a nicety. archivedAt is set by a sync,
  // and a sync against a partial roster archives students who never left. The
  // person reading this is a real child standing at a door.
  check(
    "the refusal says what is wrong, in terms a student understands",
    /roster/i.test(archived.reason),
    archived.reason,
  );
  check(
    "it promises their earned value is not gone",
    /tickets|cash/i.test(archived.reason) && /not been deleted|still on your record/i.test(archived.reason),
    archived.reason,
  );
  check(
    "it names exactly who fixes it",
    /office/i.test(archived.reason),
    archived.reason,
  );
  check(
    "it is not a generic error",
    !/^(not authorized|forbidden|error|server error)/i.test(archived.reason.trim()),
    archived.reason,
  );
  check("and it is long enough to actually explain itself", archived.reason.length > 80);

  // Any truthy archivedAt archives. A sync could write any timestamp format.
  check(
    "any archive timestamp counts, whatever its format",
    ["2026-01-01", "2026-08-01T00:00:00Z", "some-marker"].every(
      (v) => !studentRecordVerdict({ archivedAt: v }).ok,
    ),
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
