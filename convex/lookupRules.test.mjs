// "Does this person have an account?" -- and the answer has to be right.
//
// THE BUG THIS FILE EXISTS FOR. Eric Pichler was given an account, and
// searching "ericp@" reported him as absent from the hub while showing him in
// the Microsoft directory. The staff branch matched a NAME; the student branch
// matched a name OR an identifier. They had drifted apart, inline, unnoticed.
//
// The direction of the failure is what makes it worth a test: an oversight
// that answers "this person has no account" invites somebody to create a
// second one.
//
// Run: npm test

import { matchesStaff, matchesStudent } from "./lookupRules.ts";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const ERIC = { name: "Eric Pichler", email: "ericp@lapromisefund.org" };
const CHRISTINE = { name: "Christine Pichler", email: "christinep@lapromisefund.org" };
const ARIANA = { name: "Ariana Nieves", email: "arianan@lapromisefund.org" };

console.log("\n-- staff are found by email, which is the half that was missing --");
{
  check("the bare local part", matchesStaff("ericp", ERIC));
  check("the local part with an @", matchesStaff("ericp@", ERIC));
  check("the whole address", matchesStaff("ericp@lapromisefund.org", ERIC));
  check("and still by name", matchesStaff("eric pichler", ERIC));
  check("and by surname alone", matchesStaff("pichler", ERIC));
  check("case does not matter", matchesStaff("ERICP@", ERIC));
  check("nor does surrounding whitespace", matchesStaff("  ericp  ", ERIC));
}

console.log("-- and not found when they should not be --");
{
  check("a different person's address does not match", !matchesStaff("arianan@", ERIC));
  check("a surname does match both Pichlers",
    matchesStaff("pichler", ERIC) && matchesStaff("pichler", CHRISTINE));
  check("but a full name separates them",
    matchesStaff("eric pichler", ERIC) && !matchesStaff("eric pichler", CHRISTINE));
  // An email SUBSTRING matches, deliberately: it is what makes "pichler" find
  // both Pichlers and "ericp" find ericp@. The whole-local-part rule is an
  // extra way in, not a restriction on that.
  check("an email substring matches, which is the point",
    matchesStaff("christine", { name: "Someone Else", email: "christinep@lapromisefund.org" }));
  check("so a search can be broad on purpose",
    matchesStaff("lapromisefund", ERIC) && matchesStaff("lapromisefund", CHRISTINE));
  check("an empty query matches nobody", !matchesStaff("", ERIC) && !matchesStaff("   ", ERIC));
  check("a record with no email is still matched by name",
    matchesStaff("ariana", { name: "Ariana Nieves" }));
  check("a record with no name is still matched by email",
    matchesStaff("arianan@", { email: "arianan@lapromisefund.org" }));
  check("an empty record matches nothing", !matchesStaff("anything", {}));
}

console.log("-- the student branch keeps the behaviour it already had --");
{
  const s = { firstName: "Jordan", lastName: "Martinez", studentNumber: "S104822",
              email: "jordanm@westbrookacademy.org" };
  check("full name", matchesStudent("jordan martinez", s));
  check("reversed, the way a list shows it", matchesStudent("martinez, jordan", s));
  check("surname alone", matchesStudent("martinez", s));
  check("student number", matchesStudent("s104822", s));
  check("and email, which staff now also do", matchesStudent("jordanm@", s));
  check("a different student does not match", !matchesStudent("smith", s));
  check("an empty query matches nobody", !matchesStudent("", s));
  check("a partial record does not crash", matchesStudent("jordan", { firstName: "Jordan" }));
}

console.log("-- the two predicates answer the same question the same way --");
{
  // The drift is the bug. Anything that identifies a person should work on
  // either, so neither branch can quietly become the narrow one again.
  const staff = { name: "Ariana Nieves", email: "arianan@lapromisefund.org" };
  const student = { firstName: "Ariana", lastName: "Nieves", email: "arianan@westbrookacademy.org" };
  check("a surname works on both", matchesStaff("nieves", staff) && matchesStudent("nieves", student));
  check("a full name works on both",
    matchesStaff("ariana nieves", staff) && matchesStudent("ariana nieves", student));
  check("an email local part works on both",
    matchesStaff("arianan", staff) && matchesStudent("arianan", student));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
