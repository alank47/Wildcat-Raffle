// Can a signed in student find their own classes?
//
// The bug this file pins down shipped silently and stayed invisible for days:
// psRoster rows were written with no student email, me:get looked them up BY
// student email, and so every student's schedule was empty. Nothing errored.
// The pass card still rendered, because identity and balances come from a
// different table, and an empty schedule looks exactly like a student who has
// not been scheduled yet.
//
// The cases that matter are the ones where a WRONG address would be worse than
// none: a retired domain, a misspelling, a suffix that only looks like ours.
// Keying a roster row to any of those points a child's schedule at an address
// no token will ever carry.
import { primaryEmailByStudentNumber } from "./identityRules.ts";
import { attachStudentEmail, teacherRosterEmail } from "./rosterEmail.ts";

let pass = 0, fail = 0;
const check = (l, c, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${l}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? `  (${d})` : ""}`); }
};

console.log("\nprimaryEmailByStudentNumber\n");

{
  const m = primaryEmailByStudentNumber([
    { studentNumber: "11414", email: "ar11414@westbrookacademy.org", isPrimary: "1" },
  ]);
  check("a plain student address maps", m.get("11414") === "ar11414@westbrookacademy.org");
}

{
  // The query orders primary first. First seen wins, the same rule
  // setStudentEmails uses, so both tables agree on which address is the key.
  const m = primaryEmailByStudentNumber([
    { studentNumber: "11414", email: "primary@westbrookacademy.org", isPrimary: "1" },
    { studentNumber: "11414", email: "second@westbrookacademy.org", isPrimary: "0" },
  ]);
  check(
    "a student with two addresses resolves to the first",
    m.get("11414") === "primary@westbrookacademy.org",
    m.get("11414"),
  );
}

{
  const m = primaryEmailByStudentNumber([
    { studentNumber: "11414", email: "AR11414@WestbrookAcademy.ORG" },
  ]);
  check(
    "directory casing is normalized, or the index lookup misses",
    m.get("11414") === "ar11414@westbrookacademy.org",
    m.get("11414"),
  );
}

{
  // 8 real records carry this. It is a retired school domain.
  const m = primaryEmailByStudentNumber([
    { studentNumber: "10001", email: "kid@rwwnms.org" },
    { studentNumber: "10002", email: "kid@rwwnhs.org" },
  ]);
  check("retired rwwnms.org is refused", !m.has("10001"));
  check("retired rwwnhs.org is refused", !m.has("10002"));
}

{
  // Student 11895 really carries this: "westrbook" is a transposition.
  const m = primaryEmailByStudentNumber([
    { studentNumber: "11895", email: "ep11895@westrbookacademy.org" },
  ]);
  check("a misspelled domain is refused, not stored", !m.has("11895"));
}

{
  // endsWith would accept this. Exact equality is the whole point.
  const m = primaryEmailByStudentNumber([
    { studentNumber: "666", email: "attacker@evil.westbrookacademy.org.evil.com" },
    { studentNumber: "667", email: "attacker@notwestbrookacademy.org" },
  ]);
  check("a suffix that merely contains our domain is refused", !m.has("666"));
  check("a domain that merely ends with our name is refused", !m.has("667"));
}

{
  const m = primaryEmailByStudentNumber([
    { studentNumber: "", email: "nobody@westbrookacademy.org" },
    { studentNumber: "   ", email: "nobody2@westbrookacademy.org" },
    { studentNumber: "11414", email: "" },
    { studentNumber: "11415", email: "not-an-address" },
  ]);
  check("a blank student number is not a key", m.size === 0, `size ${m.size}`);
}

{
  const m = primaryEmailByStudentNumber([
    { studentNumber: " 11414 ", email: "ar11414@westbrookacademy.org" },
  ]);
  check("a padded student number is trimmed to the join key", m.get("11414") !== undefined);
}

console.log("\nattachStudentEmail\n");

const ROSTER = [
  { studentNumber: "11414", courseName: "Algebra I", sectionId: "1" },
  { studentNumber: "11414", courseName: "Biology", sectionId: "2" },
  { studentNumber: "12217", courseName: "Promise Time 9A", sectionId: "3" },
  { studentNumber: "99999", courseName: "Chemistry", sectionId: "4" },
];

{
  const m = primaryEmailByStudentNumber([
    { studentNumber: "11414", email: "ar11414@westbrookacademy.org" },
    { studentNumber: "12217", email: "lb12345@westbrookacademy.org" },
  ]);
  const out = attachStudentEmail(ROSTER, m);

  check(
    "every section for one student carries the same address",
    out[0].studentEmail === "ar11414@westbrookacademy.org" &&
      out[1].studentEmail === "ar11414@westbrookacademy.org",
  );
  check(
    "a second student gets their own address",
    out[2].studentEmail === "lb12345@westbrookacademy.org",
  );
  check(
    "a student with no address on file stays undefined, not empty string",
    out[3].studentEmail === undefined,
    JSON.stringify(out[3].studentEmail),
  );
  check(
    "the course fields survive the stamp",
    out[2].courseName === "Promise Time 9A" && out[2].sectionId === "3",
  );
  check(
    "the caller's rows are not mutated",
    ROSTER[0].studentEmail === undefined,
  );
  check("no rows are dropped", out.length === ROSTER.length);
}

{
  // The state before this fix: an empty map must not invent keys.
  const out = attachStudentEmail(ROSTER, new Map());
  check(
    "an empty map leaves every row unkeyed rather than blank keyed",
    out.every((r) => r.studentEmail === undefined),
  );
}


// ---------------------------------------------------------------------------
// A TEACHER whose sections are filed under an older address.
//
// Jazmin Kent married. Entra issued jazmina@, the app's staff record followed
// it and sign-in works; PowerSchool still files her sections under jazmink@.
// psRoster.teacherEmail matched nothing, so she opened the app to no classes
// and every student in the school listed instead -- there was no section to
// narrow by, so the absence looked like access.
//
// The danger in fixing it is the obvious one: an address that points at
// somebody ELSE hands one teacher another teacher's roster. These are the
// cases where that could happen.
// ---------------------------------------------------------------------------
console.log("\nA teacher's sections under an older address");
{
  const jazmin = { email: "jazmina@lapromisefund.org", psEmail: "jazmink@lapromisefund.org" };

  const ok = teacherRosterEmail(jazmin, false);
  check("an unclaimed old address is used for the lookup",
    ok.email === "jazmink@lapromisefund.org");
  check("and is reported, so the screen can say where the classes came from",
    ok.via === "jazmink@lapromisefund.org");
  check("nothing was refused", ok.refused === false);

  // THE ONE THAT MATTERS. The address is now somebody's sign-in identity.
  const taken = teacherRosterEmail(jazmin, true);
  check("an address that belongs to a staff record is REFUSED",
    taken.email === "jazmina@lapromisefund.org");
  check("and reported as refused rather than failing quietly",
    taken.refused === true);
  check("with no via, because no substitution happened", taken.via === null);
}

{
  // No patch at all: the overwhelming majority of staff.
  const plain = teacherRosterEmail({ email: "alexr@lapromisefund.org" }, false);
  check("a teacher with no psEmail looks up their own address",
    plain.email === "alexr@lapromisefund.org");
  check("and is not marked as coming via anything", plain.via === null);
  check("and is not marked refused either", plain.refused === false);

  for (const empty of ["", "   ", null, undefined]) {
    const r = teacherRosterEmail({ email: "alexr@lapromisefund.org", psEmail: empty }, false);
    check(`an empty psEmail (${JSON.stringify(empty)}) is simply no patch`,
      r.email === "alexr@lapromisefund.org" && r.via === null && r.refused === false);
  }
}

{
  // Set to the person's OWN address. Harmless, but it must not report a
  // substitution that did not happen -- the screen would say the classes came
  // from somewhere else when they came from the usual place.
  const same = teacherRosterEmail(
    { email: "sonh@lapromisefund.org", psEmail: "SonH@LaPromiseFund.org" }, false);
  check("a psEmail equal to the sign-in address, in any case, is not a substitution",
    same.email === "sonh@lapromisefund.org" && same.via === null);

  const spaced = teacherRosterEmail(
    { email: "sonh@lapromisefund.org", psEmail: "  OLDNAME@lapromisefund.org  " }, false);
  check("case and stray whitespace do not stop a real patch working",
    spaced.email === "oldname@lapromisefund.org" && spaced.via === "oldname@lapromisefund.org");
}

{
  // IT IS NOT AN IDENTITY. Whatever this returns is used for ONE thing: which
  // teacherEmail to look sections up under. If it ever starts being returned
  // as who somebody IS, this assertion is the tripwire.
  const r = teacherRosterEmail(
    { email: "jazmina@lapromisefund.org", psEmail: "jazmink@lapromisefund.org" }, false);
  check("the sign-in address is never replaced on the record itself",
    !("identity" in r) && !("role" in r) && !("name" in r));
  check("the result says only which address, whether via, and whether refused",
    Object.keys(r).sort().join(",") === "email,refused,via");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
