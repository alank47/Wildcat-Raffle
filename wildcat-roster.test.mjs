// Whose students does a teacher see.
//
// The case that matters most is the one the old code got backwards: a teacher
// whose record carried no sections fell through to seeing EVERY student,
// because the filter only applied when sections existed. Absent data read as
// unrestricted. Several assertions below exist to keep that from returning.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
new Function(src)();
const R = globalThis.WildcatRoster;

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

// App-side students carry BOTH id and studentNumber. id may still be a legacy
// CSV value, which is why nothing here joins on it.
const S = (num, over = {}) => Object.assign(
  { id: "STU" + num, studentNumber: String(num), firstName: "A", lastName: "B", grade: "10" },
  over,
);
const ALL = [S(101), S(102), S(103), S(104), S(105)];

const ROSTER = {
  sections: [
    { sectionId: "sec-P3", period: "P3", courseName: "Biology",
      students: [{ studentNumber: "103" }, { studentNumber: "104" }] },
    { sectionId: "sec-P1", period: "P1", courseName: "Algebra",
      students: [{ studentNumber: "101" }, { studentNumber: "102" }] },
  ],
};

console.log("\nRoles that see everyone");
for (const role of ["admin", "superadmin", "campusaide"]) {
  check(`${role} sees every student`,
    R.scopeStudents({ students: ALL, role, roster: null }).students.length === 5);
  check(`${role} is labelled as scope 'all'`,
    R.scopeStudents({ students: ALL, role, roster: null }).scope === "all");
}
check("a teacher is NOT one of them", R.seesEveryStudent("teacher") === false);
check("an unknown role is NOT one of them", R.seesEveryStudent("volunteer") === false);

console.log("\nA teacher with no SIS roster sees NOBODY");
// THE BUG THIS REPLACES. The old filter only applied when sections existed,
// so a teacher with none saw the whole school.
{
  const none = R.scopeStudents({ students: ALL, role: "teacher", roster: null });
  check("no roster means no students, not all students", none.students.length === 0);
  check("scope says none", none.scope === "none");
  check("and it explains what to do about it", /matches the one you sign in with/.test(none.reason));

  const empty = R.scopeStudents({ students: ALL, role: "teacher", roster: { sections: [] } });
  check("an empty sections array is the same as no roster", empty.students.length === 0);
}

console.log("\nA teacher sees their own students");
{
  const mine = R.scopeStudents({ students: ALL, role: "teacher", roster: ROSTER });
  check("all four of their students across both sections", mine.students.length === 4);
  check("and not the student nobody teaches",
    mine.students.every((s) => s.studentNumber !== "105"));
  check("scope is my-roster", mine.scope === "my-roster");
  check("no reason is given when there are results", mine.reason === null);
}

console.log("\nFiltering to one period");
{
  const p1 = R.scopeStudents({ students: ALL, role: "teacher", roster: ROSTER, sectionId: "sec-P1" });
  check("only that section's students", p1.students.length === 2);
  check("the right two", p1.students.map((s) => s.studentNumber).sort().join() === "101,102");
  check("scope is section", p1.scope === "section");

  const missing = R.scopeStudents({ students: ALL, role: "teacher", roster: ROSTER, sectionId: "sec-NOPE" });
  check("an unknown section yields nobody rather than everybody", missing.students.length === 0);
}

console.log("\nThe join is studentNumber, never id");
{
  // A student whose app id is a legacy CSV value still matches on number.
  const legacy = [Object.assign(S(101), { id: "OLD-CSV-7" })];
  check("a legacy id still matches by student number",
    R.scopeStudents({ students: legacy, role: "teacher", roster: ROSTER, sectionId: "sec-P1" })
      .students.length === 1);

  // A student with no number cannot be matched, and must not slip through.
  const numberless = [{ id: "101", firstName: "A", lastName: "B" }];
  check("a student with no studentNumber is not matched by id collision",
    R.scopeStudents({ students: numberless, role: "teacher", roster: ROSTER })
      .students.length === 0);
}

console.log("\nEmpty results explain themselves differently");
{
  const noAppRecords = R.scopeStudents({ students: [], role: "teacher", roster: ROSTER });
  check("roster exists but no app records says so",
    /no records in the app yet/.test(noAppRecords.reason));

  const emptySection = R.scopeStudents({
    students: ALL, role: "teacher",
    roster: { sections: [{ sectionId: "sec-X", period: "P2", courseName: "Art", students: [] }] },
    sectionId: "sec-X",
  });
  check("an empty class says the class is empty",
    /no students in the SIS/.test(emptySection.reason));
}

console.log("\nSections come back in bell order");
{
  const ordered = R.sectionsFrom({
    sections: [
      { sectionId: "d", period: "P5" }, { sectionId: "a", period: "A1" },
      { sectionId: "c", period: "HPU" }, { sectionId: "b", period: "P1" },
      { sectionId: "z", period: "WEIRD" },
    ],
  });
  check("bell order, not alphabetical",
    ordered.map((s) => s.sectionId).join() === "a,b,c,d,z");
  check("an unrecognised period sorts last rather than vanishing",
    ordered[ordered.length - 1].sectionId === "z");
  check("sectionsFrom on a null roster returns empty rather than throwing",
    R.sectionsFrom(null).length === 0);
}

console.log("\nLabels a teacher can read");
check("all-students scope", R.scopeLabel({ scope: "all" }) === "All students");
check("no-roster scope", R.scopeLabel({ scope: "none" }) === "No roster");
check("a named period",
  R.scopeLabel({ scope: "section" }, ROSTER, "sec-P3") === "Period P3 — Biology");
check("my whole roster", R.scopeLabel({ scope: "my-roster" }, ROSTER) === "My students");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
