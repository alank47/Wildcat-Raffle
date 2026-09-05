// Picking a class period actually shows that class.
//
// THE BUG. Award Tickets read `currentUser.sections` and matched with
// `section.students.includes(s.id)`. Both halves were wrong and each hid the
// other: currentUser.sections is the legacy CSV field that nothing in the
// PowerSchool path has ever written (every staff row in Convex carries
// `sections: []`), so the branch was unreachable and every period showed all
// 615 students; and had it been reached, it compared an app id against the
// SIS section's student OBJECTS.
//
// It stayed invisible because the DROPDOWN was empty too. With nothing to
// select, nobody could see that selecting did nothing. Fixing the dropdown for
// one teacher is what exposed it -- for everybody.
//
// Award Cash had already been moved onto the SIS. Award Tickets had not. So
// the assertions below check both screens, together: a half-migration that
// leaves two screens disagreeing about what a class is, is the actual defect.
//
// Run: npm test

import { readFileSync } from "node:fs";

const rosterSrc = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
new Function(rosterSrc)();
const R = globalThis.WildcatRoster;

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const code = script.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const bodyOf = (name) => {
  const i = code.indexOf(`function ${name}(`);
  return i < 0 ? "" : code.slice(i, code.indexOf("\n        }", i));
};

// ---------------------------------------------------------------------------
// Fixtures shaped like production: psRoster sections carrying student OBJECTS
// keyed by studentNumber, and an app student array keyed by a legacy id that
// is deliberately DIFFERENT from the student number. That difference is the
// whole reason the old `.includes(s.id)` could never match.
// ---------------------------------------------------------------------------
const roster = (sections) => ({ sections });
const sec = (id, period, name, nums) => ({
  sectionId: id, period, courseName: name,
  students: nums.map((n) => ({ studentNumber: String(n), firstName: "S" + n, lastName: "T" })),
});
const appStudents = (nums) =>
  nums.map((n) => ({ id: "LEGACY" + n, studentNumber: String(n), firstName: "S" + n, lastName: "T", grade: "9" }));

const SCHOOL = appStudents([101, 102, 103, 104, 105, 106]);

console.log("\nA teacher who picks a period gets that period");
{
  const jazmin = roster([
    sec("6011", "1(A-E)", "Promise Time 9A", [101, 102]),
    sec("5991", "3(A-E)", "Chemistry A", [103, 104, 105]),
  ]);

  const all = R.scopeStudents({ students: SCHOOL, role: "teacher", roster: jazmin, sectionId: null });
  check("with no period chosen she sees her own students, not the school",
    all.students.length === 5);
  check("and specifically not all six", all.students.length !== SCHOOL.length);

  const one = R.scopeStudents({ students: SCHOOL, role: "teacher", roster: jazmin, sectionId: "5991" });
  check("picking period 3 narrows to that class", one.students.length === 3);
  check("to exactly the right children",
    one.students.map((s) => s.studentNumber).sort().join(",") === "103,104,105");
  check("the header can name the class", R.scopeLabel(one, jazmin, "5991").length > 0);

  const other = R.scopeStudents({ students: SCHOOL, role: "teacher", roster: jazmin, sectionId: "6011" });
  check("a different period gives a different class", other.students.length === 2);
  check("and the two do not overlap",
    !other.students.some((s) => one.students.includes(s)));
}

console.log("\nThe join is on studentNumber, never on the app id");
{
  // The old code did section.students.includes(s.id). These ids exist and are
  // wrong, which is what made the failure silent rather than loud.
  const r = roster([sec("A", "1", "Maths", [101, 102])]);
  const out = R.scopeStudents({ students: SCHOOL, role: "teacher", roster: r, sectionId: "A" });
  check("students are found even though app id != student number",
    out.students.length === 2 && out.students[0].id === "LEGACY101");

  const noNumbers = SCHOOL.map(({ studentNumber, ...rest }) => rest);
  const blind = R.scopeStudents({ students: noNumbers, role: "teacher", roster: r, sectionId: "A" });
  check("a student with no studentNumber cannot be matched into a class",
    blind.students.length === 0);
  check("and that emptiness explains itself rather than being blank",
    Boolean(blind.reason));
}

console.log("\nNo roster means nobody, not everybody");
{
  // THE FAILURE DIRECTION THAT MATTERS. The old branch only applied a filter
  // when sections existed, so a teacher with none fell through to the entire
  // school: absent data read as unrestricted access.
  const none = R.scopeStudents({ students: SCHOOL, role: "teacher", roster: null, sectionId: null });
  check("a teacher with no SIS roster sees no students", none.students.length === 0);
  check("and is told to check the email match rather than shown the school",
    /PowerSchool address/i.test(none.reason || ""));

  const empty = R.scopeStudents({ students: SCHOOL, role: "teacher", roster: roster([]), sectionId: null });
  check("an empty roster is the same answer", empty.students.length === 0);
}

console.log("\nThe roles that see everyone still do");
{
  for (const role of ["admin", "superadmin", "campusaide", "pbis"]) {
    const out = R.scopeStudents({ students: SCHOOL, role, roster: null, sectionId: null });
    check(`${role} still sees the whole school with no roster`, out.students.length === 6);
  }
  // A chosen section wins for every role, including the ones that see all.
  const r = roster([sec("A", "1", "Maths", [101, 102])]);
  const admin = R.scopeStudents({ students: SCHOOL, role: "admin", roster: r, sectionId: "A" });
  check("an admin who picks a period gets that period, not the school",
    admin.students.length === 2);
}

console.log("\nEvery rostered teacher, not just the one who reported it");
{
  // Modelled on the production shape verified 2026-09-04: 34 teachers, 1 to 9
  // sections each, and every SIS student number joining to an app record.
  let worstEmpty = 0, checked = 0;
  for (let t = 0; t < 34; t++) {
    const secs = [];
    const base = 200 + t * 50;
    const count = 1 + (t % 9);
    for (let i = 0; i < count; i++) {
      secs.push(sec(`S${t}_${i}`, String(i + 1), `Course ${i}`, [base + i * 3, base + i * 3 + 1]));
    }
    const rr = roster(secs);
    const app = appStudents(secs.flatMap((s) => s.students.map((x) => Number(x.studentNumber))));
    for (const s of secs) {
      const out = R.scopeStudents({ students: app, role: "teacher", roster: rr, sectionId: s.sectionId });
      checked++;
      if (out.students.length !== 2) worstEmpty++;
    }
  }
  check(`every section of every simulated teacher scopes correctly (${checked} sections)`,
    worstEmpty === 0);
}

console.log("\nBoth award screens ask the same question");
{
  // The defect was a half-migration: the dropdown and Award Cash moved to the
  // SIS, Award Tickets did not. Two screens disagreeing about what a class is
  // is the thing to prevent, so they are asserted together.
  for (const fn of ["updateTicketsTable", "updateCashTable"]) {
    const body = bodyOf(fn);
    check(`${fn} scopes through WildcatRoster.scopeStudents`,
      /WildcatRoster\.scopeStudents\(\{/.test(body));
    check(`${fn} passes the live SIS roster`, /roster:\s*activeTeacherRoster\(\)/.test(body));
    check(`${fn} passes the chosen section`, /sectionId:\s*\w+\s*\|\|\s*null/.test(body));
    check(`${fn} does not read the dead currentUser.sections field`,
      !/currentUser\.sections/.test(body));
    check(`${fn} does not match a section by app id`,
      !/section\.students\.includes\(s\.id\)/.test(body));
  }
  check("nothing anywhere still filters a table by currentUser.sections",
    !/\.sections\.find\(s => s\.sectionId ===/.test(code));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
