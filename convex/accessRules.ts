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

export type Viewer = { email: string; role: string };
export type RosterRef = { teacherEmail?: string };

export type Verdict =
  | { allowed: true; scope: "admin" | "campus" | "own-roster" }
  | { allowed: false; reason: string };

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
const CAMPUS_WIDE_ROLES = ["campusaide"];

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

  // Deliberately does not say whether the student exists or which teacher does
  // have them. A refusal should not become a directory lookup.
  return {
    allowed: false,
    reason: "That student is not on your roster.",
  };
}
