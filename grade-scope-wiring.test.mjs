// Middle School access, end to end: the pieces convex/gradeScope.test.mjs
// cannot see because they are joins, not rules.
//
// Asked 2026-09-29: "Can we get Eric Pichler access to all Middle School
// students? 6th, 7th and 8th?"
//
// The rule (accessRules.canViewStudent) is only as good as what reaches it. A
// rule that is right, handed no grade, refuses everyone; a rule handed the
// scope from a request argument lets anyone claim it. So this pins:
//   - the server hands the rule the scope from the VERIFIED staff row and the
//     grade from CURRENT PowerSchool rows;
//   - every write of `role` goes through roleWritePatch, so a role change
//     clears the scope;
//   - the scope is not browser-writable;
//   - the browser's lists show exactly the numbers the server sent.
//
// Run: npm test

import { readFileSync, readdirSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const src = read("./wildcat-roster.js");
new Function(src)();
const R = globalThis.WildcatRoster;

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  (" + d + ")" : ""}`); }
};

// ---------------------------------------------------------------------------
console.log("\nThe browser shows exactly the students the server named");
// ---------------------------------------------------------------------------
{
  const students = [
    { studentNumber: "1001", name: "A (grade 7, Eric's own class)" },
    { studentNumber: "2001", name: "B (grade 6)" },
    { studentNumber: "2002", name: "C (grade 8)" },
    { studentNumber: "3001", name: "D (grade 10)" },
    { studentNumber: "3002", name: "E (grade 12)" },
  ];
  const block = { key: "middle", label: "Middle School (grades 6-8)", grades: ["6", "7", "8"],
                  studentNumbers: ["1001", "2001", "2002", "9999"], studentCount: 4 };
  const withClass = { sections: [{ sectionId: "S1", period: "3", students: [{ studentNumber: "1001" }] }],
                      gradeScope: block };
  const noClass = { sections: [], gradeScope: block };

  const r1 = R.scopeStudents({ students, role: "teacher", roster: noClass });
  const nums1 = r1.students.map((s) => s.studentNumber).sort().join(",");
  check("no classes + Middle School: sees the Middle School students", nums1 === "1001,2001,2002", nums1);
  check("... and is labelled as the grade scope, not the whole school", r1.scope === "grade-scope");
  check("... the high schoolers are not in it",
    !r1.students.some((s) => s.studentNumber === "3001" || s.studentNumber === "3002"));

  const r2 = R.scopeStudents({ students, role: "teacher", roster: withClass });
  check("own class + Middle School: no one is listed twice",
    r2.students.length === new Set(r2.students.map((s) => s.studentNumber)).size && r2.students.length === 3);
  check("the label says both",
    R.scopeLabel(r2, withClass, null) === "My classes + Middle School (grades 6-8)", R.scopeLabel(r2, withClass, null));
  check("with no classes, the label is just the Middle School",
    R.scopeLabel(r1, noClass, null) === "Middle School (grades 6-8)");

  const r3 = R.scopeStudents({ students, role: "teacher", roster: withClass, sectionId: "S1" });
  check("picking a period still narrows to that period",
    r3.scope === "section" && r3.students.length === 1 && r3.students[0].studentNumber === "1001");

  const plain = { sections: [{ sectionId: "S1", period: "3", students: [{ studentNumber: "1001" }] }] };
  const r4 = R.scopeStudents({ students, role: "teacher", roster: plain });
  check("an ordinary teacher is unchanged: own class only, scope my-roster",
    r4.scope === "my-roster" && r4.students.length === 1);
  const r5 = R.scopeStudents({ students, role: "teacher", roster: { sections: [] } });
  check("an ordinary teacher with no classes still sees nobody", r5.scope === "none" && r5.students.length === 0);

  for (const bad of [
    { studentNumbers: "1001,2001", label: "x" },
    { studentNumbers: ["2001"] },
    { studentNumbers: ["2001"], label: "" },
    "middle", true, [],
  ]) {
    const r = R.scopeStudents({ students, role: "teacher", roster: { sections: [], gradeScope: bad } });
    check(`a malformed block (${JSON.stringify(bad)}) grants nobody`, r.students.length === 0 && r.scope === "none");
  }

  const empty = R.scopeStudents({ students, role: "teacher",
    roster: { sections: [], gradeScope: { ...block, studentNumbers: [], studentCount: 0 } } });
  check("an empty block says PowerSchool lists nobody, rather than a blank table",
    empty.students.length === 0 && /no students in Middle School/.test(empty.reason || ""), empty.reason);
}

// ---------------------------------------------------------------------------
console.log("\nThe server hands the rule the right inputs");
// ---------------------------------------------------------------------------
{
  const detail = read("./convex/studentDetail.ts");
  const call = detail.slice(detail.indexOf("canViewStudent("), detail.indexOf("canViewStudent(") + 400);
  check("the profile gate passes the scope from the verified staff row",
    /gradeScope:\s*\(teacher as any\)\.gradeScope/.test(call));
  check("... and the grade from the student's PowerSchool rows",
    /gradeLevel:\s*r\.gradeLevel/.test(call));
  check("... and never from students.grade", !/\.grade\b(?!Level|Scope)/.test(call));

  const blockSrc = read("./convex/gradeScopeRead.ts");
  check("the roster block reads PowerSchool by grade, one index lookup per grade",
    /withIndex\("by_gradeLevel"/.test(blockSrc) && /for \(const grade of scope\.grades\)/.test(blockSrc));
  check("the roster block is decided by activeGradeScope (teachers only)",
    /const key = activeGradeScope\(row\);\s*if \(!key\) return null;/.test(blockSrc));
  check("the roster block never reads the students table", !/query\("students"\)/.test(blockSrc));

  const views = read("./convex/views_app.ts");
  const tr = views.slice(views.indexOf("export const teacherRoster ="), views.indexOf("export const teacherRosterFor"));
  check("teacherRoster sends the block for the signed-in teacher's own row",
    /gradeScope: await readGradeScopeBlock\(ctx, teacher\)/.test(tr));
  const trf = views.slice(views.indexOf("export const teacherRosterFor"), views.indexOf("export const teacherRosterFor") + 6000);
  check("teacherRosterFor (the admin's teacher view) sends the named teacher's block",
    /gradeScope: staffRow \? await readGradeScopeBlock\(ctx, staffRow\) : null/.test(trf));
}

// ---------------------------------------------------------------------------
console.log("\nOnly an admin can set it, and a role change clears it");
// ---------------------------------------------------------------------------
{
  const shape = read("./convex/appDataShape.ts");
  check("gradeScope is NOT browser-writable (TEACHER_WRITABLE is unchanged)",
    /export const TEACHER_WRITABLE = \["name", "ticketsAwarded"\] as const;/.test(shape));

  const invites = read("./convex/staffInvites.ts");
  const apply = invites.slice(invites.indexOf("async function applyGradeScope"), invites.indexOf("export const setStaffGradeScope ="));
  check("the setter runs gradeScopeVerdict before it writes",
    apply.indexOf("gradeScopeVerdict(") > 0 && apply.indexOf("gradeScopeVerdict(") < apply.indexOf("ctx.db.patch("));
  check("... and throws on a refusal", /if \(!verdict\.ok\) throw new ConvexError\(verdict\.reason\)/.test(apply));
  check("... and writes it down in the audit log", /ctx\.db\.insert\("appAuditLog"/.test(apply) && /"Changed student access"/.test(apply));
  const pub = invites.slice(invites.indexOf("export const setStaffGradeScope ="), invites.indexOf("export const setStaffGradeScopeFromCli"));
  check("the public setter identifies the caller from their sign-in", /await requireStaff\(ctx\)/.test(pub));
  check("the public setter takes no role or actor argument",
    /args: \{ email: v\.string\(\), scope: v\.union\(v\.string\(\), v\.null\(\)\) \}/.test(pub));

  // Every `patch(..., { role ... })` anywhere in convex/ would skip the clear.
  const convexFiles = readdirSync(new URL("./convex/", import.meta.url)).filter((f) => f.endsWith(".ts"));
  const bare = [];
  for (const f of convexFiles) {
    const text = read("./convex/" + f);
    const re = /\.patch\([^)]*\{\s*role\s*[:,}]/g;
    let m;
    while ((m = re.exec(text))) bare.push(`${f}:${text.slice(0, m.index).split("\n").length}`);
  }
  check("no role write in convex/ bypasses roleWritePatch", bare.length === 0, bare.join(", "));
  const uses = convexFiles.reduce((n, f) => n + (read("./convex/" + f).match(/roleWritePatch\(/g) || []).length, 0);
  check("roleWritePatch is used by each role writer (4 call sites + its definition)", uses >= 5, String(uses));

  const setRole = invites.slice(invites.indexOf("export const setStaffRole ="), invites.indexOf("function accessWords"));
  check("a role change that cleared the scope says so in the audit line",
    /Middle School access removed/.test(setRole) && /gradeScopeCleared: scopeCleared/.test(setRole));

  const schema = read("./convex/schema.ts");
  check("the stored value can only be \"middle\"", /gradeScope: v\.optional\(v\.literal\("middle"\)\)/.test(schema));
}

// ---------------------------------------------------------------------------
console.log("\nThe staff screen");
// ---------------------------------------------------------------------------
{
  const script = read("./script.js");
  const html = read("./index.html");
  check("the edit dialog has the Student access control",
    /<select id="editTeacherGradeScope"/.test(html) && /<option value="middle">/.test(html));

  const save = script.slice(script.indexOf("async function saveTeacherEdit()"), script.indexOf("async function deleteTeacher"));
  check("Save calls the admin-only mutation, not saveData, for the scope",
    /convexMutation\('staffInvites:setStaffGradeScope'/.test(save));
  check("... shows the server's answer, not the dropdown's",
    /teacher\.gradeScope = scopeResult\.scope \|\| null/.test(save));
  check("... skips it when the role change failed", /if \(!roleError && wantedScope !== undefined/.test(save));
  check("... keeps the dialog open and says so when it fails",
    /if \(scopeError\) \{[\s\S]{0,400}return;/.test(save));

  // Review finding 2026-09-29: a failed role change put the Role select back
  // in code (no onchange), leaving Student access greyed out for the role that
  // failed; a second Save then skipped the scope it still showed.
  const roleErr = save.slice(save.indexOf("if (roleError) {"), save.indexOf("closeEditTeacherModal();"));
  check("a failed role change re-syncs the Student access control to the server's value",
    /\.value = previousRole;[\s\S]{0,600}scopeSel\.value = teacher\.gradeScope[\s\S]{0,120}syncGradeScopeControl\(\);/.test(roleErr));

  const sync = script.slice(script.indexOf("function syncGradeScopeControl()"), script.indexOf("function closeEditTeacherModal()"));
  check("the control is greyed out unless the role is Teacher and the user is an admin",
    /sel\.disabled = !teacherRole \|\| !admin/.test(sync));

  const my = script.slice(script.indexOf("const all = (typeof enrolledStudents === 'function')"),
    script.indexOf("const all = (typeof enrolledStudents === 'function')") + 900);
  check("the dashboard's student count uses the same filter as the lists",
    /gradeBlockOf\(activeTeacherRoster\(\)\)[\s\S]{0,200}scopeStudents\(/.test(my));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
