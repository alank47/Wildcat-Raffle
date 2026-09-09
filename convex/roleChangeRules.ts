/**
 * Who may change whose role, and to what.
 *
 * PURE, AND SEPARATE FROM THE MUTATION, for the same reason every other rule
 * in this folder is: the dangerous decisions are the ones a test must be able
 * to reach without an auth gate in the way. The mutation reads the database
 * and applies what this returns; it decides nothing itself.
 *
 * ROLE IS NOT AN ORDINARY FIELD. appDataShape's TEACHER_WRITABLE is
 * ["name", "ticketsAwarded"] on purpose -- the whole-app save carries the
 * teachers array from a browser, and a role that could ride along in it would
 * mean any tab could promote anybody. So role changes get their own narrow,
 * admin-gated mutation instead, and the allowlist stays as it is.
 */

/** Every role the app understands. Anything else is refused, not coerced. */
export const ASSIGNABLE_ROLES = [
  "teacher",
  "campusaide",
  "pbis",
  "admin",
  "superadmin",
] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** Roles that may change anyone's role at all. */
const ROLE_CHANGERS = ["admin", "superadmin"];

/**
 * PBIS IS DELIBERATELY NOT A ROLE-CHANGER.
 *
 * The request was "if a new teacher joins PBIS I'd like to switch their
 * permissions to PBIS". Admin covers that. Letting PBIS itself hand out roles
 * means any PBIS member can make themselves superadmin, which is not a
 * permission anyone asked to grant and not one that would be noticed. It is a
 * one-line change here if the school decides otherwise.
 */
export function canChangeRoles(role: string): boolean {
  return ROLE_CHANGERS.includes(String(role || "").trim().toLowerCase());
}

export type RoleChangeRequest = {
  actorEmail: string;
  actorRole: string;
  targetEmail: string;
  targetRole: string;
  newRole: string;
  /** How many superadmins exist right now, including the target. */
  superadminCount: number;
};

export type RoleChangeVerdict =
  | { ok: true; newRole: AssignableRole }
  | { ok: false; reason: string };

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

export function roleChangeVerdict(req: RoleChangeRequest): RoleChangeVerdict {
  const actorRole = norm(req.actorRole);
  const newRole = norm(req.newRole);
  const targetRole = norm(req.targetRole);
  const actor = norm(req.actorEmail);
  const target = norm(req.targetEmail);

  if (!canChangeRoles(actorRole)) {
    return { ok: false, reason: "Only administrators can change staff access levels." };
  }

  if (!target) return { ok: false, reason: "No staff member was named." };

  if (!(ASSIGNABLE_ROLES as readonly string[]).includes(newRole)) {
    return {
      ok: false,
      reason: `"${req.newRole}" is not a role. Choose one of: ${ASSIGNABLE_ROLES.join(", ")}.`,
    };
  }

  // NOBODY CHANGES THEIR OWN ROLE.
  //
  // Two different accidents, one rule. A superadmin demoting themselves locks
  // the school out of its own admin screens with no way back in from the app.
  // And "I only meant to fix my own access" is how a self-promotion gets
  // explained afterwards -- an admin raising themselves to superadmin should
  // be a thing another person did, so it appears in someone else's name.
  if (actor && actor === target) {
    return {
      ok: false,
      reason: "You cannot change your own access level. Ask another administrator.",
    };
  }

  // SUPERADMIN IS GRANTED BY SUPERADMINS ONLY, in both directions.
  //
  // An admin who could mint a superadmin could mint one and then be promoted
  // by it, which is the same as being able to promote themselves. An admin who
  // could demote a superadmin could remove the only person able to undo it.
  if (newRole === "superadmin" && actorRole !== "superadmin") {
    return { ok: false, reason: "Only a super admin can grant super admin." };
  }
  if (targetRole === "superadmin" && actorRole !== "superadmin") {
    return { ok: false, reason: "Only a super admin can change another super admin." };
  }

  // THE LAST SUPERADMIN STAYS. Demoting them leaves an app nobody can
  // administer, and the only route back is a developer with CLI access.
  if (targetRole === "superadmin" && newRole !== "superadmin" && req.superadminCount <= 1) {
    return {
      ok: false,
      reason:
        "This is the only super admin. Promote someone else first, or the school " +
        "would be left with no one who can restore access.",
    };
  }

  if (targetRole === newRole) {
    return { ok: false, reason: `They are already ${newRole}.` };
  }

  return { ok: true, newRole: newRole as AssignableRole };
}
