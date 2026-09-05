// Who can drill into which student.
//
// Grilled.md: teachers see their OWN roster only; admins see wider scope.
// Getting this wrong means a teacher can pull up any child in the school,
// which in a system holding SIS data is the failure that matters most.
import { readFileSync } from "node:fs";
import { canViewStudent } from "./accessRules.ts";

let pass = 0, fail = 0;
const check = (l, c, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${l}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? `  (${d})` : ""}`); }
};

const TEACHER = { email: "sarahr@lapromisefund.org", role: "teacher" };
const OTHER   = { email: "sergior@lapromisefund.org", role: "teacher" };
const AIDE    = { email: "leoc@lapromisefund.org", role: "campusaide" };
const ADMIN   = { email: "leahr@lapromisefund.org", role: "admin" };
const SUPER   = { email: "alank@lapromisefund.org", role: "superadmin" };

const ON_SARAHS_ROSTER = [
  { teacherEmail: "sarahr@lapromisefund.org" },
  { teacherEmail: "amberc@lapromisefund.org" },
];
const NOT_HERS = [{ teacherEmail: "amberc@lapromisefund.org" }];

console.log("\nTeachers: own roster only");
check("teacher CAN view a student they teach", canViewStudent(TEACHER, ON_SARAHS_ROSTER).allowed === true);
check("scope is reported as own-roster", canViewStudent(TEACHER, ON_SARAHS_ROSTER).scope === "own-roster");
check("teacher CANNOT view a student they do not teach", canViewStudent(OTHER, NOT_HERS).allowed === false);
check("teacher CANNOT view a student with no roster rows at all", canViewStudent(TEACHER, []).allowed === false);
console.log("\nCampus aides: whole campus, but not admins");
// Decided 2026-08-14. An aide covers hallways, lunch and the yard, so the
// student in front of them is whoever it is. They are the teacher of record
// for nobody, so a roster-scoped rule refused them every student on the site.
// The pre-Convex app already showed them all students with a grade filter;
// this keeps that rather than granting anything new.
check("a campus aide CAN view a student they do not teach",
  canViewStudent(AIDE, NOT_HERS).allowed === true);
check("a campus aide can view a student with no roster rows at all",
  canViewStudent(AIDE, []).allowed === true);

// The point of the original assertion, preserved. Aides reach students, but
// they must never be indistinguishable from an admin: the scope is what
// studentDetail records in its viewedAs audit trail, and admin powers hang off
// requireAdmin, which tests the role directly and never consults this file.
check("a campus aide is still NOT an admin: scope is campus, not admin",
  canViewStudent(AIDE, NOT_HERS).scope === "campus");
check("and an admin is still reported as admin",
  canViewStudent(ADMIN, NOT_HERS).scope === "admin");
check("an aide with no identity is refused like anyone else",
  canViewStudent({ email: "", role: "campusaide" }, NOT_HERS).allowed === false);

// An unknown role must not inherit the aide's reach by accident.
check("an unrecognised role is still refused",
  canViewStudent({ email: "x@lapromisefund.org", role: "volunteer" }, NOT_HERS).allowed === false);

console.log("\nAdmins: wider scope");
check("admin can view a student they do not teach", canViewStudent(ADMIN, NOT_HERS).allowed === true);
check("superadmin likewise", canViewStudent(SUPER, NOT_HERS).allowed === true);
check("admin scope is labelled", canViewStudent(ADMIN, NOT_HERS).scope === "admin");

console.log("\nMatching is normalized, and cannot be spoofed");
check("directory casing still matches (the Entra bug)",
  canViewStudent({ email: "SarahR@LaPromiseFund.org", role: "teacher" }, ON_SARAHS_ROSTER).allowed === true);
check("whitespace still matches",
  canViewStudent({ email: "  sarahr@lapromisefund.org  ", role: "teacher" }, ON_SARAHS_ROSTER).allowed === true);
check("roster-side casing also normalized",
  canViewStudent(TEACHER, [{ teacherEmail: "SARAHR@LAPROMISEFUND.ORG" }]).allowed === true);
check("an empty identity is refused", canViewStudent({ email: "", role: "admin" }, []).allowed === false);
check("a substring of a real address does not match",
  canViewStudent({ email: "arahr@lapromisefund.org", role: "teacher" }, ON_SARAHS_ROSTER).allowed === false);
check("an unknown role gets no privileges",
  canViewStudent({ email: "x@lapromisefund.org", role: "principal" }, NOT_HERS).allowed === false);

console.log("\nA refusal does not leak");
{
  const r = canViewStudent(OTHER, NOT_HERS);
  check("refusal names no other teacher", !r.reason.includes("amberc"));
  check("refusal does not confirm or deny the student exists", !/exists|not found|no student/i.test(r.reason));
}


// ---------------------------------------------------------------------------
// teachers.sections is not writable from a browser.
//
// It was, and one stale profile failed EVERY appData:save. Browsers holding the
// CSV-era shape sent sections as an array of objects; the schema says
// v.array(v.string()); a Convex mutation is transactional, so the whole write
// -- students, teachers and settings together -- aborted:
//
//   Failed to insert or update a document in table "teachers"
//   Path: .sections[0]  Validator: v.string()
//
// The field is dead: nothing in the PowerSchool path writes it, every row
// carries [], and a teacher's classes come from psRoster.
// ---------------------------------------------------------------------------
{
  const shape = readFileSync(new URL("./appDataShape.ts", import.meta.url), "utf8");
  const writable = /export const TEACHER_WRITABLE = \[([^\]]*)\]/.exec(shape);
  check("TEACHER_WRITABLE is declared", Boolean(writable));
  check("a browser cannot write teachers.sections", !/"sections"/.test(writable[1]));
  check("name and ticketsAwarded stay writable",
    /"name"/.test(writable[1]) && /"ticketsAwarded"/.test(writable[1]));
  check("email and role are still refused",
    !/"email"/.test(writable[1]) && !/"role"/.test(writable[1]));
  check("and psEmail, which only an admin mutation may set",
    !/"psEmail"/.test(writable[1]));
  check("the reason is recorded where the field was removed",
    /Path: \.sections\[0\]/.test(shape));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
