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

console.log("\nWestbrook slots: the expression is a SLOT, not a period name");
{
  const c = (period, courseName) => R.classifySection({ period, courseName });

  // THE BUG THIS PINS. Every period read one too high because the expression
  // slot was used as the period number, and Promise Time occupies slot 1.
  check("slot 2 is the timetable's Period 1", c("2(A-E)", "Newscasting A").period === 1);
  check("and is labelled Period 1", c("2(A-E)", "Newscasting A").label === "Period 1 - Newscasting A");
  check("slot 3 is Period 2", c("3(A-E)", "Multimedia Production 3A").period === 2);
  check("slot 4 is Period 3", c("4(A-E)", "Multimedia Production 2A").period === 3);
  check("slot 5 is Period 4", c("5(A-E)", "Multimedia Production 1A").period === 4);
  check("slot 6 is Period 5", c("6(A-E)", "Anything").period === 5);
  check("slot 7 is Period 6", c("7(A-E)", "Anything").period === 6);
  check("no core slot maps to its own number", ![2,3,4,5,6,7].some(n => c(n + "(A-E)", "X").period === n));

  check("slot 1 is Promise Time, not Period 1", c("1(A-E)", "Promise Time 12A").kind === "promise");
  check("slot 8 is Power Up, not a period", c("8(A-E)", "Power Up 11A").kind === "powerup");
  check("slot 10 is Promise Time PM", c("10(A-E)", "Promise Time 12A").kind === "promise-pm");
  check("a named block reports no timetable period", c("8(A-E)", "Power Up 11A").period === null);

  // Both Promise Time rows carry the SAME course name in the real data, so
  // only the slot can tell them apart.
  check("AM and PM Promise Time are distinguished despite identical course names",
    c("1(A-E)", "Promise Time 12A").label !== c("10(A-E)", "Promise Time 12A").label);

  check("the expression's day letters are ignored", R.periodNumber("2(A-E)") === 2);
  check("a bare number still parses", R.periodNumber("2") === 2);
  check("slot 10 is not read as 1", R.periodNumber("10(A-E)") === 10);

  // Slot 9 was never observed. It must not be invented as a period.
  check("an unmapped slot is not called a period", c("9(A-E)", "Mystery Block").kind === "other");
  check("and shows its course name", c("9(A-E)", "Mystery Block").label === "Mystery Block");
  check("an unmapped slot with a known block name still resolves by name",
    c("9(A-E)", "Nutrition Break").kind === "nutrition");
}

console.log("\nOrdering, against the real roster");
{
  const real = [
    ["8(A-E)",  "Power Up 11A"],
    ["1(A-E)",  "Promise Time 12A"],
    ["2(A-E)",  "Newscasting A"],
    ["5(A-E)",  "Multimedia Production 1A"],
    ["4(A-E)",  "Multimedia Production 2A"],
    ["3(A-E)",  "Multimedia Production 3A"],
    ["10(A-E)", "Promise Time 12A"],
  ];
  const ordered = R.sectionsFrom({
    sections: real.map(([period, courseName], i) => ({ sectionId: "s" + i, period, courseName, students: [] })),
  });
  check("core periods come first, in timetable order",
    ordered.slice(0, 4).map((s) => s.period).join() === "1,2,3,4");
  check("Period 1 is Newscasting", ordered[0].label === "Period 1 - Newscasting A");
  check("then Promise Time AM", ordered[4].kind === "promise");
  check("then Power Up", ordered[5].kind === "powerup");
  check("then Promise Time PM", ordered[6].kind === "promise-pm");
  check("nothing is lost", ordered.length === 7);
  check("the raw slot is carried through for debugging", ordered[0].slot === 2);
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
  R.scopeLabel({ scope: "section" }, ROSTER, "sec-P3") === "Period 2 - Biology");
check("my whole roster", R.scopeLabel({ scope: "my-roster" }, ROSTER) === "My students");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
