// The referral student picker: narrow, search, pick.
//
// THE RULE THIS ENCODES, confirmed with the owner 2026-09-04: every enrolled
// student in the school stays reachable. A referral is written for what
// somebody did, and most of what gets referred happens in a corridor or the
// yard between an adult and a child who share no timetable. The period filter
// is a SHORTCUT, never a restriction.
//
// Award Cash is the exact opposite -- there the teacher's roster IS the
// boundary. The two must not be "made consistent", and the assertions below
// exist so a later reader who notices the difference finds out it is deliberate
// before changing it.
//
// Run: npm test

import { readFileSync } from "node:fs";

const rosterSrc = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
new Function(rosterSrc)();

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

// ---- A DOM small enough to reason about, real enough to drive the function --
function el(tag) {
  return {
    tag, value: "", textContent: "", _html: "",
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = v;
      this.options = [...v.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
        .map((m) => ({ value: m[1], label: m[2] }));
    },
    options: [], selectedIndex: 0,
  };
}

function harness({ students, roster, scope = "", search = "" }) {
  const nodes = {
    referralStudentSelect: el("select"),
    referralStudentScope: el("select"),
    referralStudentSearch: el("input"),
    referralStudentHint: el("p"),
  };
  nodes.referralStudentScope.value = scope;
  nodes.referralStudentSearch.value = search;
  // selectedIndex mirrors whether the chosen value survived the rebuild.
  Object.defineProperty(nodes.referralStudentScope, "selectedIndex", {
    get() { return this.options.findIndex((o) => o.value === this.value); },
    set() {},
  });

  const src = script.slice(
    script.indexOf("        function populateReferralStudentDropdown() {"),
    script.indexOf("        /**\n         * Student History, admin and PBIS only"),
  );

  const fn = new Function(
    "document", "enrolledStudents", "activeTeacherRoster", "window",
    "sisRosterState", "isPreviewingTeacher", "loadTeacherRosterFromSIS",
    "referralRosterFetchTried",
    src + "\n; return populateReferralStudentDropdown;",
  )(
    { getElementById: (id) => nodes[id] || null },
    () => students,
    () => roster,
    { WildcatRoster: globalThis.WildcatRoster },
    "ready",
    () => false,
    () => ({ then: () => {} }),
    true,
  );

  fn();
  return {
    nodes,
    listed: nodes.referralStudentSelect.options.filter((o) => o.value !== ""),
    scopeOptions: nodes.referralStudentScope.options,
    hint: nodes.referralStudentHint.textContent,
  };
}

const student = (n, first, last, grade = "9") => ({
  id: "L" + n, studentNumber: String(n), firstName: first, lastName: last,
  grade, enrolled: true,
});

// Five in the teacher's classes, three who are not.
const SCHOOL = [
  student(1, "Ana", "Alvarez"), student(2, "Ben", "Brooks"),
  student(3, "Cruz", "Castillo"), student(4, "Dee", "Diaz"),
  student(5, "Eli", "Escobar"), student(6, "Fay", "Flores"),
  student(7, "Gil", "Guzman"), student(8, "Hana", "Herrera"),
];
const ROSTER = {
  sections: [
    { sectionId: "P1", period: "1", courseName: "Chemistry A",
      students: [1, 2, 3].map((n) => ({ studentNumber: String(n) })) },
    { sectionId: "P3", period: "3", courseName: "Biology B",
      students: [4, 5].map((n) => ({ studentNumber: String(n) })) },
  ],
};

console.log("\nEvery student in the school is reachable by default");
{
  const r = harness({ students: SCHOOL, roster: ROSTER });
  check("with no filter, all eight are listed -- not just the teacher's five",
    r.listed.length === 8);
  check("including a child the teacher does not teach",
    r.listed.some((o) => o.label.startsWith("Herrera")));
  check("the hint says so out loud",
    /Any student in the school can be referred/.test(r.hint));
  check("All students is the default scope", r.nodes.referralStudentScope.value === "");
}

console.log("\nThe period filter narrows, and is offered alongside everyone");
{
  const r = harness({ students: SCHOOL, roster: ROSTER });
  const vals = r.scopeOptions.map((o) => o.value);
  check("All students is first, so it is the fallback", vals[0] === "");
  check("My students is offered", vals.includes("__mine"));
  check("and each class period", vals.includes("P1") && vals.includes("P3"));
  check("the counts are on the labels",
    /All students \(8\)/.test(r.scopeOptions[0].label) &&
    r.scopeOptions.some((o) => /My students \(5\)/.test(o.label)));

  const one = harness({ students: SCHOOL, roster: ROSTER, scope: "P1" });
  check("choosing period 1 lists that class", one.listed.length === 3);
  check("the right three",
    one.listed.map((o) => o.label.split(",")[0]).sort().join(",") === "Alvarez,Brooks,Castillo");

  const mine = harness({ students: SCHOOL, roster: ROSTER, scope: "__mine" });
  check("My students lists all five across both classes", mine.listed.length === 5);
  check("and excludes the three the teacher does not teach",
    !mine.listed.some((o) => /Flores|Guzman|Herrera/.test(o.label)));
}

console.log("\nSearch finds a student the teacher does not teach");
{
  // The corridor case, which is the whole reason this is not roster-scoped.
  const r = harness({ students: SCHOOL, roster: ROSTER, search: "herrera" });
  check("searching a non-roster surname finds them", r.listed.length === 1);
  check("and it is the right child", /Herrera, Hana/.test(r.listed[0].label));

  check("search matches first name too",
    harness({ students: SCHOOL, roster: ROSTER, search: "gil" }).listed.length === 1);
  check("and 'last, first' order, which is how the list reads",
    harness({ students: SCHOOL, roster: ROSTER, search: "flores, fay" }).listed.length === 1);
  check("and the student id a teacher reads off a screen",
    harness({ students: SCHOOL, roster: ROSTER, search: "L7" }).listed.length === 1);
  check("case does not matter",
    harness({ students: SCHOOL, roster: ROSTER, search: "HERRERA" }).listed.length === 1);

  const none = harness({ students: SCHOOL, roster: ROSTER, search: "zzzz" });
  check("no match says so rather than showing an empty box",
    none.listed.length === 0 && /No student matches/.test(none.hint));
}

console.log("\nThe two filters combine");
{
  const r = harness({ students: SCHOOL, roster: ROSTER, scope: "P1", search: "brooks" });
  check("period 1 plus a search narrows to one", r.listed.length === 1);
  const miss = harness({ students: SCHOOL, roster: ROSTER, scope: "P1", search: "herrera" });
  check("a search outside the chosen period finds nobody, which is honest",
    miss.listed.length === 0);
}

console.log("\nA teacher with no SIS roster can still refer anybody");
{
  // The seven teachers with no PowerSchool sections. Scoping this list would
  // have left them unable to file a referral at all.
  const r = harness({ students: SCHOOL, roster: null });
  check("all eight students are listed", r.listed.length === 8);
  check("and no period filter is offered, because there are no periods",
    r.scopeOptions.length === 1 && r.scopeOptions[0].value === "");
}

console.log("\nLeavers are not offered");
{
  const withLeaver = [...SCHOOL, { ...student(9, "Iris", "Ibarra"), enrolled: false }];
  // enrolledStudents() is the caller's job; assert the wiring in source.
  const body = script.slice(
    script.indexOf("        function populateReferralStudentDropdown() {"),
    script.indexOf("        /**\n         * Student History, admin and PBIS only"));
  check("the picker builds from enrolledStudents()", /enrolledStudents\(\)/.test(body));
  check("and not from the raw students array", !/\[\.\.\.students\]/.test(body));
  const r = harness({ students: withLeaver.filter((s) => s.enrolled !== false), roster: ROSTER });
  check("so a child who left is absent", !r.listed.some((o) => /Ibarra/.test(o.label)));
}

console.log("\nA choice already made survives typing");
{
  const nodes = harness({ students: SCHOOL, roster: ROSTER });
  check("the selection starts empty", nodes.nodes.referralStudentSelect.value === "");
  // Behaviour is asserted in source: the rebuild restores a still-present value.
  const body = script.slice(
    script.indexOf("        function populateReferralStudentDropdown() {"),
    script.indexOf("        /**\n         * Student History, admin and PBIS only"));
  check("the rebuild reads the chosen value first", /const chosen = select\.value;/.test(body));
  check("and puts it back when the student is still listed",
    /if \(chosen && sorted\.some\([\s\S]{0,80}\)\) \{\s*select\.value = chosen;/.test(body));
}

console.log("\nThe form reset clears the filters too");
{
  check("scope and search are cleared with the rest of the form",
    /'referralStudentSelect','referralStudentScope','referralStudentSearch'/.test(script));
  check("and the list is repainted afterwards, not left filtered",
    /if \(el\) el\.value = '';\s*\}\);\s*populateReferralStudentDropdown\(\);/.test(script));
}

console.log("\nThis is NOT Award Cash, and must not become it");
{
  const cash = script.slice(script.indexOf("function updateCashTable("));
  check("Award Cash still scopes to the roster as its boundary",
    /WildcatRoster\.scopeStudents\(\{/.test(cash.slice(0, 3000)));
  const body = script.slice(
    script.indexOf("        function populateReferralStudentDropdown() {"),
    script.indexOf("        /**\n         * Student History, admin and PBIS only"));
  check("the referral picker deliberately does not use scopeStudents",
    !/scopeStudents/.test(body));
  // Including the doc comment above it: that is where a reader lands before
  // deciding the two screens ought to match.
  const documented = script.slice(
    script.indexOf("         * The student picker on the referral form"),
    script.indexOf("        /**\n         * Student History, admin and PBIS only"));
  check("and the reason is written down where someone would change it",
    /commonest referral impossible to file/.test(documented));
  check("naming the seven teachers it would strand",
    /no PowerSchool sections/.test(documented));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
