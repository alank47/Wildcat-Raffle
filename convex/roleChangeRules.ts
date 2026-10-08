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


// ---------------------------------------------------------------------------
// GRADE SCOPE: which EXTRA students a teacher may see (2026-09-29, "Can we get
// Eric Pichler access to all Middle School students?"). Set only by an admin,
// through staffInvites:setStaffGradeScope. The access side lives in
// accessRules.ts (GRADE_SCOPES); this list is kept in step with it by
// convex/gradeScope.test.mjs.
// ---------------------------------------------------------------------------

/** The scopes an admin may grant. Anything else is refused, not coerced. */
export const GRADE_SCOPE_KEYS = ["middle"] as const;

export type GradeScopeRequest = {
  actorEmail: string;
  actorRole: string;
  targetEmail: string;
  targetRole: string;
  /** The scope the target has now, or null. */
  current: string | null;
  /** What was asked for: a key, or null / "" to clear. */
  requested: unknown;
};

export type GradeScopeVerdict =
  | { ok: true; scope: string | null }
  | { ok: false; reason: string };

export function gradeScopeVerdict(req: GradeScopeRequest): GradeScopeVerdict {
  if (!canChangeRoles(req.actorRole)) {
    return { ok: false, reason: "Only administrators can change which students a staff member can see." };
  }
  const actor = norm(req.actorEmail);
  const target = norm(req.targetEmail);
  if (!target) return { ok: false, reason: "No staff member named." };
  if (actor && actor === target) {
    return { ok: false, reason: "You cannot change your own student access. Ask another administrator." };
  }
  const raw = req.requested === null || req.requested === undefined ? "" : norm(req.requested);
  const scope = raw === "" ? null : raw;
  if (scope !== null && !(GRADE_SCOPE_KEYS as readonly string[]).includes(scope)) {
    return { ok: false, reason: `"${String(req.requested)}" is not a student access setting.` };
  }
  if (scope !== null && norm(req.targetRole) !== "teacher") {
    return { ok: false, reason: "Campus aides, PBIS and admins already see every student." };
  }
  if ((req.current ?? null) === scope) {
    return { ok: false, reason: "Nothing to change: that is already their student access." };
  }
  return { ok: true, scope };
}

/**
 * The patch for a ROLE write. A role change CLEARS the grade scope, so a
 * teacher who was given Middle School access, promoted, and later set back to
 * teacher does not quietly get it back. Every place that writes `role` goes
 * through this.
 */
export function roleWritePatch(
  row: { role?: unknown; gradeScope?: unknown } | null | undefined,
  newRole: string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { role: newRole };
  if (row && row.gradeScope && norm(row.role) !== norm(newRole)) {
    patch.gradeScope = undefined;
    patch.gradeScopeSetBy = undefined;
    patch.gradeScopeSetAt = undefined;
  }
  // Attendance Watch access is cleared by a role change for the same reason.
  if (row && (row as any).attendanceWatch && norm(row.role) !== norm(newRole)) {
    patch.attendanceWatch = undefined;
    patch.attendanceWatchSetBy = undefined;
    patch.attendanceWatchSetAt = undefined;
  }
  // And so is the Reflection Room list grant (2026-10-08): a supervisor
  // given the list, promoted, and later set back must not quietly keep it.
  if (row && (row as any).reflectionList && norm(row.role) !== norm(newRole)) {
    patch.reflectionList = undefined;
    patch.reflectionListSetBy = undefined;
    patch.reflectionListSetAt = undefined;
    patch.reflectionListUntil = undefined;
  }
  return patch;
}

// ---------------------------------------------------------------------------
// ATTENDANCE WATCH ACCESS (2026-09-30, "Attendance Watch and Early Warning for
// Avalos"): read access to Attendance Watch and Early Warning for one staff
// member whose role does not include it. Admin only; never your own record;
// pointless (refused) for admin, superadmin and PBIS, who already have it.
// ---------------------------------------------------------------------------

export type AttendanceWatchRequest = {
  actorEmail: string;
  actorRole: string;
  targetEmail: string;
  targetRole: string;
  current: boolean;
  requested: unknown;
};

export function attendanceWatchVerdict(req: AttendanceWatchRequest):
  { ok: true; on: boolean } | { ok: false; reason: string } {
  if (!canChangeRoles(req.actorRole)) {
    return { ok: false, reason: "Only administrators can change who sees Attendance Watch." };
  }
  const actor = norm(req.actorEmail);
  const target = norm(req.targetEmail);
  if (!target) return { ok: false, reason: "No staff member named." };
  if (actor && actor === target) {
    return { ok: false, reason: "You cannot change your own access. Ask another administrator." };
  }
  if (typeof req.requested !== "boolean") {
    return { ok: false, reason: "Attendance Watch access is on or off." };
  }
  const on = req.requested;
  const already = ["admin", "superadmin", "pbis"].includes(norm(req.targetRole));
  if (on && already) {
    return { ok: false, reason: "Admins and the PBIS team already see Attendance Watch and Early Warning." };
  }
  if (req.current === on) {
    return { ok: false, reason: on ? "They already have Attendance Watch access." : "They do not have Attendance Watch access." };
  }
  return { ok: true, on };
}

// ---------------------------------------------------------------------------
// THE REFLECTION ROOM LIST, FOR ONE PERSON (2026-10-08, build spec 4.6): the
// room's supervisor or an aide who prints the list and takes the room's
// attendance, without the PBIS role's whole discipline record. Copied step for
// step from Attendance Watch above, plus an END DATE: admin only; never your
// own record; pointless (refused) for admin, superadmin and PBIS, who already
// have the list; and a grant ends -- by default at the end of the term, so the
// January term switch is a natural time to give it again or let it go.
// ---------------------------------------------------------------------------

export type ReflectionListRequest = {
  actorEmail: string;
  actorRole: string;
  targetEmail: string;
  targetRole: string;
  /** What they hold now. */
  current: { on: boolean; until: string | null };
  /** On or off. */
  requested: unknown;
  /** "YYYY-MM-DD"; null = no end date (said out loud); absent = the default. */
  until: unknown;
  /** The school day today, "YYYY-MM-DD". */
  today: string;
  /** The current term's last day, if known: the default end date. */
  defaultUntil: string | null;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A grant may end at most about a school year and a bit away. */
export const REFLECTION_GRANT_MAX_DAYS = 400;

export function reflectionListVerdict(req: ReflectionListRequest):
  { ok: true; on: boolean; until: string | null } | { ok: false; reason: string } {
  if (!canChangeRoles(req.actorRole)) {
    return { ok: false, reason: "Only administrators can change who sees the Reflection Room list." };
  }
  const actor = norm(req.actorEmail);
  const target = norm(req.targetEmail);
  if (!target) return { ok: false, reason: "No staff member named." };
  if (actor && actor === target) {
    return { ok: false, reason: "You cannot change your own access. Ask another administrator." };
  }
  if (typeof req.requested !== "boolean") {
    return { ok: false, reason: "Reflection Room list access is on or off." };
  }
  if (!req.requested) {
    if (!req.current.on) return { ok: false, reason: "They do not have Reflection Room list access." };
    return { ok: true, on: false, until: null };
  }
  if (["admin", "superadmin", "pbis"].includes(norm(req.targetRole))) {
    return { ok: false, reason: "Admins and the PBIS team already see the Reflection Room list." };
  }
  const today = String(req.today ?? "");
  if (!DAY.test(today)) return { ok: false, reason: "The server could not tell what day it is." };
  let until: string | null;
  if (req.until === null) {
    until = null;
  } else if (req.until === undefined || req.until === "") {
    const d = req.defaultUntil;
    if (!d || !DAY.test(d) || d < today) {
      return { ok: false, reason: "The end of this term is not known yet, so give an end date (YYYY-MM-DD)." };
    }
    until = d;
  } else {
    const u = String(req.until);
    if (!DAY.test(u) || Number.isNaN(Date.parse(u + "T00:00:00Z")) || new Date(u + "T00:00:00Z").toISOString().slice(0, 10) !== u) {
      return { ok: false, reason: `"${u}" is not a date. Give the last day as YYYY-MM-DD.` };
    }
    if (u < today) return { ok: false, reason: `${u} has already passed: the access would never start.` };
    const far = new Date(Date.parse(today + "T00:00:00Z") + REFLECTION_GRANT_MAX_DAYS * 86400000).toISOString().slice(0, 10);
    if (u > far) return { ok: false, reason: `Give an end date within ${REFLECTION_GRANT_MAX_DAYS} days (by ${far}).` };
    until = u;
  }
  if (req.current.on && (req.current.until ?? null) === until) {
    return { ok: false, reason: until ? `They already have it, until ${until}.` : "They already have it, with no end date." };
  }
  return { ok: true, on: true, until };
}
