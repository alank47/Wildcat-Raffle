// Middle School access for a teacher: every student in grades 6-8, on top of
// their own classes.
//
// Asked 2026-09-29: "Can we get Eric Pichler access to all Middle School
// students? 6th, 7th and 8th?" The owner chose a Middle School-only setting
// over making him PBIS (which is the whole school).
//
// What matters most here is what it must NOT do: grant grade 9-12, grant a
// student who has left, apply to any role but teacher, or be set by anyone but
// an admin.
//
// Run: npm test
import {
  canViewStudent, activeGradeScope, gradeInScope, studentInScope, GRADE_SCOPES,
} from "./accessRules.ts";
import { gradeScopeVerdict, roleWritePatch, GRADE_SCOPE_KEYS } from "./roleChangeRules.ts";

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  (" + d + ")" : ""}`); }
};

console.log("\nThe scope is exactly grades 6, 7 and 8");
{
  check("middle is 6, 7, 8 and nothing else",
    JSON.stringify(GRADE_SCOPES.middle.grades) === JSON.stringify(["6", "7", "8"]));
  check("grades 6, 7, 8 are in", ["6", "7", "8"].every((g) => gradeInScope("middle", g)));
  check("grades 9 to 12 never are", ["9", "10", "11", "12"].every((g) => !gradeInScope("middle", g)));
  // A string comparison would put "10" below "8". This never compares.
  check("\"10\" is not treated as less than \"8\"", !gradeInScope("middle", "10"));
  check("odd spellings are refused, not guessed at",
    ["07", "6th", "", null, undefined, "K", "6-8"].every((g) => !gradeInScope("middle", g)));
  check("a number 7 and \" 7 \" both read as grade 7", gradeInScope("middle", 7) && gradeInScope("middle", " 7 "));
  check("an unknown scope key grants nothing", !gradeInScope("high", "10") && !gradeInScope("", "7"));
  check("the admin-side list matches the access-side list",
    JSON.stringify([...GRADE_SCOPE_KEYS].sort()) === JSON.stringify(Object.keys(GRADE_SCOPES).sort()));
}

console.log("\nFail closed on the student's rows");
{
  check("no roster rows (the student has left) is refused", !studentInScope("middle", []));
  check("rows that disagree (8 and 9) are refused", !studentInScope("middle", ["8", "9"]));
  check("every row in 6-8 is allowed", studentInScope("middle", ["7", "7", "7"]));
  check("a blank grade on any row is refused", !studentInScope("middle", ["7", ""]));
}

console.log("\nOnly teachers carry it");
{
  check("teacher + middle is middle", activeGradeScope({ role: "teacher", gradeScope: "middle" }) === "middle");
  check("campus aide, PBIS, admin, superadmin: ignored",
    ["campusaide", "pbis", "admin", "superadmin"].every((r) => activeGradeScope({ role: r, gradeScope: "middle" }) === null));
  check("an unknown stored value is ignored",
    ["high", "6-12", "all", "", null, 7].every((v) => activeGradeScope({ role: "teacher", gradeScope: v }) === null));
  check("no row, no scope", activeGradeScope(null) === null);
}

console.log("\nWho may view whom");
{
  const ERIC = { email: "ericp@lapromisefund.org", role: "teacher", gradeScope: "middle" };
  const SARAH = { email: "sarahr@lapromisefund.org", role: "teacher" };
  const row = (g, t = "someone@lapromisefund.org") => ({ teacherEmail: t, gradeLevel: g });
  for (const g of ["6", "7", "8"]) {
    const v = canViewStudent(ERIC, [row(g), row(g)]);
    check(`Eric CAN view a grade ${g} student he does not teach`, v.allowed && v.scope === "middle-school");
  }
  for (const g of ["9", "10", "11", "12"]) {
    check(`Eric CANNOT view a grade ${g} student`, canViewStudent(ERIC, [row(g)]).allowed === false);
  }
  check("Eric CANNOT view a student with no roster rows (left the school)", canViewStudent(ERIC, []).allowed === false);
  check("Eric CANNOT view a student whose grade is blank", canViewStudent(ERIC, [row("")]).allowed === false);
  check("his own class still reports as own-roster",
    canViewStudent(ERIC, [row("7", "ericp@lapromisefund.org")]).scope === "own-roster");
  check("an ordinary teacher with no scope is still refused a grade 7 student",
    canViewStudent(SARAH, [row("7")]).allowed === false);
  check("a campus aide with a stray scope still reports campus, not middle-school",
    canViewStudent({ email: "a@x", role: "campusaide", gradeScope: "middle" }, [row("7")]).scope === "campus");
  check("an unknown role with a scope gets nothing",
    canViewStudent({ email: "a@x", role: "janitor", gradeScope: "middle" }, [row("7")]).allowed === false);
  const v = canViewStudent(ERIC, [row("7")]);
  check("the scope is never reported as admin or campus", v.scope !== "admin" && v.scope !== "campus");
}

console.log("\nWho may set it");
{
  const base = { actorEmail: "leahr@lapromisefund.org", actorRole: "admin",
                 targetEmail: "ericp@lapromisefund.org", targetRole: "teacher", current: null };
  check("an admin may give a teacher Middle School access",
    gradeScopeVerdict({ ...base, requested: "middle" }).ok === true);
  check("a superadmin may too", gradeScopeVerdict({ ...base, actorRole: "superadmin", requested: "middle" }).ok);
  for (const r of ["teacher", "campusaide", "pbis"]) {
    check(`a ${r} may not`, gradeScopeVerdict({ ...base, actorRole: r, requested: "middle" }).ok === false);
  }
  check("nobody may set their own",
    gradeScopeVerdict({ ...base, actorEmail: "ericp@lapromisefund.org", requested: "middle" }).ok === false);
  check("an unknown value is refused, not coerced",
    ["high", "6-12", "all", "Middle School"].every((q) => gradeScopeVerdict({ ...base, requested: q }).ok === false));
  check("case and spaces are forgiven", gradeScopeVerdict({ ...base, requested: " Middle " }).ok === true);
  check("a non-teacher cannot be given it (they already see everyone)",
    gradeScopeVerdict({ ...base, targetRole: "pbis", requested: "middle" }).ok === false);
  check("but a stray one can always be cleared",
    gradeScopeVerdict({ ...base, targetRole: "pbis", current: "middle", requested: null }).ok === true);
  check("clearing with an empty string works too",
    gradeScopeVerdict({ ...base, current: "middle", requested: "" }).scope === null);
  check("asking for what they already have is a no-op, refused",
    gradeScopeVerdict({ ...base, current: "middle", requested: "middle" }).ok === false);
  check("no target named is refused", gradeScopeVerdict({ ...base, targetEmail: "", requested: "middle" }).ok === false);
}

console.log("\nA role change clears it");
{
  const p1 = roleWritePatch({ role: "teacher", gradeScope: "middle" }, "pbis");
  check("teacher -> pbis clears the scope", "gradeScope" in p1 && p1.gradeScope === undefined && p1.role === "pbis");
  const p2 = roleWritePatch({ role: "teacher", gradeScope: "middle" }, "teacher");
  check("the same role keeps it", !("gradeScope" in p2) && p2.role === "teacher");
  const p3 = roleWritePatch({ role: "teacher" }, "admin");
  check("no scope, nothing extra written", JSON.stringify(p3) === JSON.stringify({ role: "admin" }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
