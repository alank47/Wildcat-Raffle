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
  | { allowed: true; scope: "admin" | "own-roster" }
  | { allowed: false; reason: string };

const ADMIN_ROLES = ["admin", "superadmin"];

export function canViewStudent(viewer: Viewer, rosterRows: RosterRef[]): Verdict {
  const email = String(viewer.email ?? "").trim().toLowerCase();
  if (!email) return { allowed: false, reason: "No identity." };

  if (ADMIN_ROLES.includes(viewer.role)) {
    return { allowed: true, scope: "admin" };
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
