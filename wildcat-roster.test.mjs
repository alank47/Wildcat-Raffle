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

console.log("\nWestbrook block classification");
{
  // Promise Time really does come back from PowerSchool sitting in periods 1
  // and 10. Classifying on that number is what jumbled the list and made two
  // different things both call themselves "Period 1".
  const c = (period, courseName) => R.classifySection({ period, courseName });

  check("a core class is core", c("3", "Biology").kind === "core");
  check("and is labelled with its period and course",
    c("3", "Biology").label === "Period 3 - Biology");
  check("periods 1 through 6 are core",
    [1,2,3,4,5,6].every((n) => c(String(n), "Math").kind === "core"));

  check("Promise Time in period 1 is NOT a core class",
    c("1", "Promise Time").kind === "promise");
  check("and is named for what it is, not the slot it sits in",
    c("1", "Promise Time").label === "Promise Time");
  check("Promise Time in period 10 classifies the same way",
    c("10", "Promise Time").kind === "promise");
  check("Promise Time PM is its own block, not the morning one",
    c("10", "Promise Time PM").kind === "promise-pm");

  check("Power Up is its own thing", c("4", "Power Up").kind === "powerup");
  check("and keeps its own name", c("4", "Power Up").label === "Power Up");
  check("spelling variations still match", c("4", "POWERUP").kind === "powerup");

  check("a period above 6 that is not a named block is not core",
    c("10", "Study Hall").kind === "other");
  check("and shows its course name rather than a wrong period",
    c("10", "Study Hall").label === "Study Hall");

  check("a period value like P3 still reads as 3", R.periodNumber("P3") === 3);
  check("Period 3 reads as 3", R.periodNumber("Period 3") === 3);
  check("a non-numeric period is null", R.periodNumber("Advisory") === null);
}

console.log("\nOrdering: core 1-6 first, then the named blocks");
{
  const ordered = R.sectionsFrom({
    sections: [
      { sectionId: "pu",  period: "4",  courseName: "Power Up" },
      { sectionId: "p5",  period: "5",  courseName: "History" },
      { sectionId: "pt",  period: "1",  courseName: "Promise Time" },
      { sectionId: "p1",  period: "1",  courseName: "Algebra" },
      { sectionId: "odd", period: "10", courseName: "Study Hall" },
      { sectionId: "ptp", period: "10", courseName: "Promise Time PM" },
      { sectionId: "p3",  period: "3",  courseName: "Biology" },
    ],
  });
  check("core periods come first, in numeric order",
    ordered.slice(0, 3).map((s) => s.sectionId).join() === "p1,p3,p5");
  check("then Promise Time", ordered[3].sectionId === "pt");
  check("then Power Up", ordered[4].sectionId === "pu");
  check("then Promise Time PM", ordered[5].sectionId === "ptp");
  check("and the unrecognised block last, never dropped", ordered[6].sectionId === "odd");
  check("nothing is lost in the sort", ordered.length === 7);
  check("each section carries its display label", ordered[0].label === "Period 1 - Algebra");
  check("sectionsFrom on a null roster returns empty rather than throwing",
    R.sectionsFrom(null).length === 0);
}


console.log("\nA chosen section wins for every role");
{
  // THE BUG THIS REPLACES: the see-everything check ran BEFORE the section
  // check, so an admin picking a period was handed the whole school.
  for (const role of ["admin", "superadmin", "campusaide"]) {
    const picked = R.scopeStudents({ students: ALL, role, roster: ROSTER, sectionId: "sec-P1" });
    check(`${role} picking a period gets THAT period, not everyone`,
      picked.students.length === 2);
    check(`${role} scope is reported as section`, picked.scope === "section");
  }
  const all = R.scopeStudents({ students: ALL, role: "admin", roster: ROSTER });
  check("an admin with no period chosen still sees everyone", all.students.length === 5);
}

console.log("\nLabels a teacher can read");
check("all-students scope", R.scopeLabel({ scope: "all" }) === "All students");
check("no-roster scope", R.scopeLabel({ scope: "none" }) === "No roster");
check("a named period",
  R.scopeLabel({ scope: "section" }, ROSTER, "sec-P3") === "Period 3 - Biology");
check("my whole roster", R.scopeLabel({ scope: "my-roster" }, ROSTER) === "My students");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
