// Launch configuration: Wildcat Cash and Discipline, and the student pickers
// in both actually work.
//
// Westbrook opens 2026-09-09 running those two modes. Everything else is built
// and working and is simply not what the school is starting with.
//
// The half that matters more than the menu: a mode a teacher can OPEN but
// whose student list is empty or wrong is worse than a mode they cannot reach.
// Award Cash scopes to the teacher's SIS roster; the referral form deliberately
// does not, because most of what gets referred happens in a corridor. Both are
// asserted here, together, so nobody "fixes" one into the other.
//
// Run: npm test

import { readFileSync } from "node:fs";

const rosterSrc = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
new Function(rosterSrc)();
const R = globalThis.WildcatRoster;

const modesSrc = readFileSync(new URL("./wildcat-modes.js", import.meta.url), "utf8");
new Function(modesSrc)();
const M = globalThis.WildcatModes;

const discSrc = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");
new Function(discSrc)();
const D = globalThis.WildcatDiscipline;

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const code = script.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const bodyOf = (n) => {
  const i = code.indexOf(`function ${n}(`);
  return i < 0 ? "" : code.slice(i, code.indexOf("\n        }", i));
};

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const STAFF = ["teacher", "campusaide", "pbis"];

console.log("\n1. Staff see two modes and only two");
{
  for (const role of STAFF) {
    const modes = M.modesFor(role);
    check(`${role}: exactly Cash and Discipline`, modes.join(",") === "cash,discipline");
    check(`${role}: no Raffle in the switcher`, !modes.includes("raffle"));
    check(`${role}: no Claw Pass in the switcher`, !modes.includes("hallpass"));
  }
  check("admins keep all four, because they are testing",
    M.modesFor("admin").length === 4 && M.modesFor("superadmin").length === 4);
}

console.log("\n2. A teacher already parked in Raffle is moved, without touching their browser");
{
  // Everyone who used the app before launch has a saved mode. getSavedTeacherMode
  // filters a stored value through the same rule, so a stale 'raffle' is
  // discarded and the launch default is written over it on the next sign-in.
  check("raffle is not restorable for a teacher", M.canUseMode("teacher", "raffle") === false);
  check("so the stored value is discarded and the default used",
    M.defaultModeFor("teacher") === "cash");
  check("the app filters the stored mode rather than trusting it",
    /if \(!modeAllowed\(val\)\)/.test(code));
}

console.log("\n3. WILDCAT CASH: the picker scopes to the teacher's own classes");
{
  const sec = (id, nums) => ({
    sectionId: id, period: id, courseName: "Course " + id,
    students: nums.map((n) => ({ studentNumber: String(n) })),
  });
  const roster = { sections: [sec("A", [1, 2, 3]), sec("B", [4, 5])] };
  const school = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
    id: "L" + n, studentNumber: String(n), firstName: "S" + n, lastName: "T", enrolled: true,
  }));

  const mine = R.scopeStudents({ students: school, role: "teacher", roster, sectionId: null });
  check("a teacher sees their own students, not the school",
    mine.students.length === 5 && school.length === 7);

  const one = R.scopeStudents({ students: school, role: "teacher", roster, sectionId: "A" });
  check("choosing a class narrows to that class", one.students.length === 3);
  check("to the right children",
    one.students.map((s) => s.studentNumber).join(",") === "1,2,3");
  check("the dropdown lists a section per class",
    R.sectionsFrom(roster).length === 2);
  check("each with a label and a count",
    R.sectionsFrom(roster).every((s) => s.label && Array.isArray(s.students)));

  const aide = R.scopeStudents({ students: school, role: "campusaide", roster: null, sectionId: null });
  check("a campus aide still sees every student", aide.students.length === 7);

  const body = bodyOf("updateCashTable");
  check("Award Cash scopes through the shared helper",
    /WildcatRoster\.scopeStudents\(\{/.test(body));
  check("and starts from enrolled students only",
    /enrolledStudents\(\)/.test(body));
  const filt = bodyOf("updateCashPeriodFilter");
  check("its dropdown is built from the live SIS roster",
    /sectionsFrom\(activeTeacherRoster\(\)\)/.test(filt));
}

console.log("\n4. DISCIPLINE: the picker is the whole school, enrolled only");
{
  // NOT scoped, on purpose. A referral is written for what somebody did, and
  // most of it happens between adults and children who share no timetable.
  const body = bodyOf("populateReferralStudentDropdown");
  check("the referral form lists enrolled students",
    /enrolledStudents\(\)/.test(body));
  check("and does NOT build from the raw array, which carries leavers",
    !/\[\.\.\.students\]/.test(body));
  check("it is deliberately not scoped to the teacher's roster",
    !/scopeStudents/.test(body));

  const hist = bodyOf("populateHistoryStudentDropdown");
  check("Student History is enrolled-only too", /enrolledStudents\(\)/.test(hist));
  check("and no longer offers students who have left",
    !/\[\.\.\.students\]/.test(hist));

  // enrolledStudents is the one definition of who is still here.
  check("enrolled means enrolled !== false, in one place",
    /function enrolledStudents\(\)\s*\{\s*return students\.filter\(s => s\.enrolled !== false\);/.test(code));
}

console.log("\n5. Discipline still shows a teacher only what they may see");
{
  // Unchanged by the launch decision, and asserted so opening the mode to
  // everyone does not quietly widen what is inside it.
  check("a teacher gets submit and their own referrals",
    D.disciplineTabsFor("teacher").join(",") === "submit,review,closed");
  check("a campus aide the same", D.disciplineTabsFor("campusaide").join(",") === "submit,review,closed");
  check("PBIS sees everything inside Discipline",
    D.disciplineTabsFor("pbis").includes("analytics"));
  check("and so does an admin", D.disciplineTabsFor("admin").includes("detention"));
  check("a teacher gets no analytics", !D.disciplineTabsFor("teacher").includes("analytics"));
  check("and no student history", !D.disciplineTabsFor("teacher").includes("history"));
}

console.log("\n6. Nothing lands somebody in a mode they cannot open");
{
  check("the sign-in path asks the rules",
    /switchSystemMode\(getSavedTeacherMode\(\) \|\| allowedModeOrDefault\(\)\)/.test(code));
  check("so does the resumed-session path",
    (code.match(/switchSystemMode\(getSavedTeacherMode\(\) \|\| allowedModeOrDefault\(\)\)/g) || []).length >= 2);
  check("the sidebar default asks the rules",
    /selectMode\(allowedModeOrDefault\(\)\)/.test(code));
  check("no branch forces Raffle any more",
    !/localStorage\.setItem\('systemMode', 'raffle'\)/.test(code));
  check("and the old per-role mode copies are gone",
    !/Force raffle mode for teachers and campus aides/.test(script));

  // Every mode a role can be sent to must be one it may open.
  for (const role of [...STAFF, "admin", "superadmin", "registrar"]) {
    check(`${role} is never defaulted somewhere it cannot go`,
      M.canUseMode(role, M.defaultModeFor(role)));
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
