/**
 * Who may look at which student. Pure, so the boundary is testable.
 *
 * From Grilled.md: "Classroom teachers (own roster only) and school
 * administrators (explicitly enumerated wider scope, never 'everything')."
 *
 * The roster relationship comes from psRoster, which is SIS truth, not from
 * anything a teacher can edit about themselves. That matters: if the check
 * read a `sections` array on the teacher record, a teacher who could edit
 * their own profile could grant themselves the whole school.
 */

export type Viewer = { email: string; role: string; gradeScope?: string | null };
export type RosterRef = { teacherEmail?: string; gradeLevel?: string | null };

export type Verdict =
  | { allowed: true; scope: "admin" | "campus" | "own-roster" | "middle-school" }
  | { allowed: false; reason: string };

/**
 * A GRADE SCOPE: every student in a fixed set of grades, ON TOP OF a
 * teacher's own roster. Asked for 2026-09-29: "Can we get Eric Pichler access
 * to all Middle School students? 6th, 7th and 8th?"
 *
 * A FIXED KEY, NEVER A LIST OF GRADES. A list typed into a record is one typo
 * ("6-12") from the whole school. A key names a set defined here, in code.
 *
 * ONLY FOR TEACHERS. Admins, campus aides and PBIS already see everyone; a
 * scope on any of them means nothing and is ignored.
 *
 * The student's grade comes ONLY from their current PowerSchool roster rows
 * (psRoster.gradeLevel), never from students.grade: that value outlives a
 * student leaving (measured: 88 prior-year records still carry a grade), and
 * a departed eighth grader must not become visible because of it.
 *
 * Kept in step with roleChangeRules.ts GRADE_SCOPE_KEYS (the admin-side
 * validator) by convex/gradeScope.test.mjs. Pure modules here import nothing,
 * so the two lists are pinned by a test rather than shared by an import.
 */
export const GRADE_SCOPES: Record<string, { grades: readonly string[]; label: string }> = {
  middle: { grades: ["6", "7", "8"], label: "Middle School (grades 6-8)" },
};

/** The scope in force for a staff record, or null. Teachers only. */
export function activeGradeScope(
  row: { role?: unknown; gradeScope?: unknown } | null | undefined,
): string | null {
  if (!row || row.role !== "teacher") return null;
  const key = typeof row.gradeScope === "string" ? row.gradeScope : "";
  return Object.prototype.hasOwnProperty.call(GRADE_SCOPES, key) ? key : null;
}

/** Exact match on the grade as PowerSchool writes it. No parsing, no ranges. */
export function gradeInScope(key: string, grade: unknown): boolean {
  const scope = Object.prototype.hasOwnProperty.call(GRADE_SCOPES, key) ? GRADE_SCOPES[key] : null;
  if (!scope) return false;
  return scope.grades.includes(String(grade ?? "").trim());
}

/**
 * Every roster row in scope, and at least one row. FAIL CLOSED: a student
 * with no rows has left, and rows that disagree about the grade are a data
 * fault nobody should be granted through.
 */
export function studentInScope(key: string, gradeLevels: unknown[]): boolean {
  return Array.isArray(gradeLevels) && gradeLevels.length > 0 &&
    gradeLevels.every((g) => gradeInScope(key, g));
}

const ADMIN_ROLES = ["admin", "superadmin"];

/**
 * Roles whose work is the whole campus rather than a class list.
 *
 * A campus aide covers hallways, lunch and the yard, where the student in
 * front of them is whoever it is. They are not the teacher of record for
 * anyone, so the roster test below matches nothing for them and, before this
 * existed, they were refused every student on the site. The old pre-Convex app
 * showed them all students with a grade filter, so this preserves what aides
 * already had rather than granting something new.
 *
 * Kept as its own list, and its own scope value, precisely so this is not done
 * by adding "campusaide" to ADMIN_ROLES. Aides are not admins: admin powers
 * (staff invites, settings, week rollover) hang off requireAdmin in
 * identity.ts, which tests the role directly and does not consult this file.
 * Restricted fields stay denied to them by ALLOWED_BY_ROLE in
 * restrictedPolicy.ts, which is empty for every role including this one.
 */
// pbis joins campusaide here: a PBIS reviewer reads referrals across the
// school, so scoping them to a teaching roster they do not have scopes them
// to nothing. It grants NO admin power: that hangs off requireAdmin in
// identity.ts, which tests the role directly and does not consult this file.
const CAMPUS_WIDE_ROLES = ["campusaide", "pbis"];

export function canViewStudent(viewer: Viewer, rosterRows: RosterRef[]): Verdict {
  const email = String(viewer.email ?? "").trim().toLowerCase();
  if (!email) return { allowed: false, reason: "No identity." };

  if (ADMIN_ROLES.includes(viewer.role)) {
    return { allowed: true, scope: "admin" };
  }

  // Reported as "campus", never as "admin", so studentDetail's viewedAs audit
  // trail distinguishes an aide looking at a student from an admin doing it.
  if (CAMPUS_WIDE_ROLES.includes(viewer.role)) {
    return { allowed: true, scope: "campus" };
  }

  const teaches = rosterRows.some(
    (r) => String(r.teacherEmail ?? "").trim().toLowerCase() === email,
  );
  if (teaches) return { allowed: true, scope: "own-roster" };

  // A teacher with a grade scope: every student whose PowerSchool rows are all
  // in those grades. After own-roster, so a teacher's own class still reports
  // as own-roster; never "campus" or "admin", so the audit trail says what it
  // was.
  const key = activeGradeScope({ role: viewer.role, gradeScope: viewer.gradeScope });
  if (key && studentInScope(key, rosterRows.map((r) => r.gradeLevel))) {
    return { allowed: true, scope: "middle-school" };
  }

  // Deliberately does not say whether the student exists or which teacher does
  // have them. A refusal should not become a directory lookup.
  return {
    allowed: false,
    reason: "That student is not on your roster.",
  };
}
