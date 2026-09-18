/**
 * The rules behind the Uniform Violations log. Pure functions, no Convex, no
 * clock of their own -- every one of them takes the time it needs as an
 * argument, so a test can pin a date instead of waiting for one.
 *
 * WHAT LIVES HERE versus in wildcat-discipline.js: this file holds the rules
 * the SERVER must enforce, because a browser cannot be trusted with them --
 * who may log a violation, what a valid school day is, and whether a second
 * sighting of the same child on the same day is a second record. The TIERS --
 * how many violations make a repeat offender -- live in wildcat-discipline.js
 * instead, because they are a display rule the school will argue about and
 * they must be changeable without a deploy.
 *
 * That split is the one attendanceList.ts already draws in its own words: the
 * server returns numbers, the browser ranks them.
 */

/**
 * Who may LOG a violation.
 *
 * The owner's decision, 2026-09-18: the Behavior Interventionists hold the
 * `pbis` role, so this needs no new role and changes nothing about the settled
 * discipline access split.
 *
 * WHY NOT A NEW "interventionist" ROLE, which was the obvious-looking answer:
 * a role string appears in roughly twenty places here, five of them server-side
 * unions where a miss means the role cannot be written at all, one
 * (accessRules.ts) where a miss means the holder sees no students, and eight
 * tests that pin role arrays as exact strings. `pbis` already carries all four
 * properties this needs and none it does not -- the whole school's discipline
 * record, every student on both client and server, Discipline mode at launch,
 * and zero admin power.
 *
 * `teacher` and `campusaide` are deliberately absent. A whole-school log of
 * which children were out of uniform is a discipline record about children a
 * classroom teacher has no business reading, for the same reason the
 * attendance ranking and the referral history exclude them.
 */
export const UNIFORM_LOG_ROLES = ["admin", "superadmin", "pbis"] as const;

/** Who may READ the log and the repeat list. The same set, for now. */
export const UNIFORM_READ_ROLES = ["admin", "superadmin", "pbis"] as const;

/** The refusal an interventionist should see, naming the fix an admin applies. */
export const UNIFORM_ACCESS_REASON =
  "Uniform Violations is limited to administrators and the PBIS team. " +
  "Ask an administrator to set your access level to PBIS Team.";

export function mayLogUniform(role: unknown): boolean {
  return (UNIFORM_LOG_ROLES as readonly string[]).includes(String(role ?? ""));
}

export function mayReadUniform(role: unknown): boolean {
  return (UNIFORM_READ_ROLES as readonly string[]).includes(String(role ?? ""));
}

/**
 * How far back a count may reach in one call.
 *
 * Not a business rule -- the window the school cares about is a setting the
 * owner edits. This is a ceiling so a stale or mistyped client cannot ask the
 * server to scan a year of daily logs at a door.
 */
export const MAX_WINDOW_DAYS = 400;

/** How far a client's idea of "today" may differ from the server's, in days. */
export const DAY_SLACK = 1;

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** A "YYYY-MM-DD" day as a UTC-midnight epoch, or null if it is not one. */
export function dayToEpoch(day: unknown): number | null {
  const s = String(day ?? "");
  if (!DAY_RE.test(s)) return null;
  const t = Date.parse(s + "T00:00:00Z");
  if (!Number.isFinite(t)) return null;
  // Round-tripped, so "2026-02-31" is refused rather than silently becoming
  // the 3rd of March the way Date.parse would have it.
  return new Date(t).toISOString().slice(0, 10) === s ? t : null;
}

/** N days before `day`, as a day key. Null if `day` is not a day. */
export function dayMinus(day: unknown, days: number): string | null {
  const t = dayToEpoch(day);
  if (t === null || !Number.isFinite(days)) return null;
  return new Date(t - Math.round(days) * 86400000).toISOString().slice(0, 10);
}

/**
 * Is the day the client says it is standing in one the server will accept?
 *
 * WHY THE CLIENT SENDS THE DAY AT ALL, rather than the server deciding. A
 * server-side `new Date().toISOString().slice(0, 10)` is a UTC date, and UTC
 * rolls over at 5pm Pacific. A morning door routine would be fine; an
 * after-school sweep or an evening correction would be filed against tomorrow,
 * and "date of violation" is a required column on a record about a child.
 *
 * WHY IT IS CLAMPED RATHER THAN TRUSTED. The day is an argument, so it is
 * caller-chosen, and a wrong clock or a curious user should not be able to
 * write a violation into last term or next year. One day of slack either side
 * of the server's own UTC date covers every real timezone offset and nothing
 * else.
 */
export function dayVerdict(
  day: unknown,
  serverNowIso: unknown,
): { ok: boolean; day: string | null; reason: string | null } {
  const t = dayToEpoch(day);
  if (t === null) {
    return { ok: false, day: null, reason: `"${String(day ?? "")}" is not a YYYY-MM-DD day.` };
  }
  const nowMs = Date.parse(String(serverNowIso ?? ""));
  if (!Number.isFinite(nowMs)) {
    return { ok: false, day: null, reason: "The server could not read its own clock." };
  }
  const serverDay = new Date(nowMs).toISOString().slice(0, 10);
  const serverT = dayToEpoch(serverDay);
  if (serverT === null) {
    return { ok: false, day: null, reason: "The server could not read its own clock." };
  }
  const driftDays = Math.abs(t - serverT) / 86400000;
  if (driftDays > DAY_SLACK) {
    return {
      ok: false,
      day: null,
      reason:
        `${String(day)} is ${Math.round(driftDays)} days from the server's date ` +
        `(${serverDay}). A violation can only be logged for today.`,
    };
  }
  return { ok: true, day: String(day), reason: null };
}

/** The earliest day a count may reach, given a requested start and today. */
export function windowStart(sinceDay: unknown, today: unknown): string | null {
  const floor = dayMinus(today, MAX_WINDOW_DAYS);
  const asked = dayToEpoch(sinceDay);
  if (asked === null) return floor;
  const floorT = dayToEpoch(floor);
  if (floorT === null) return null;
  return asked < floorT ? floor : String(sinceDay);
}

/**
 * What to do about a second sighting of the same child on the same day.
 *
 * The owner's decision, 2026-09-18: one violation per student per day. A
 * second tap does not create a second row -- it offers to correct the one
 * that is already there.
 *
 * WHY THAT IS THE RIGHT UNIT, and not just the tidy one. The daily number on
 * screen has to mean something a person can act on. One row per sighting makes
 * it "times someone was stopped today", which at a door with two adults
 * diverges fast from "students out of uniform today" -- and it is the second
 * that the repeat-offender count, and any conversation with a family, is
 * about. markDetentionDay already refuses a second same-day entry for the same
 * reason.
 *
 * It is also what makes the one-tap write safe on a busy morning: two adults
 * at two doors cannot double-count the same child, and neither can one adult
 * who forgets they already did it.
 *
 * A VOIDED ROW IS NOT A DUPLICATE. Undoing a mistake must leave the child
 * loggable again, or an interventionist would be stuck for the rest of the day.
 */
export function duplicateVerdict(
  existing: { voidedAt?: string | null; loanerProvided?: boolean; at?: string } | null | undefined,
): { duplicate: boolean; canAddLoaner: boolean; reason: string | null } {
  if (!existing) return { duplicate: false, canAddLoaner: false, reason: null };
  if (existing.voidedAt) return { duplicate: false, canAddLoaner: false, reason: null };
  return {
    duplicate: true,
    canAddLoaner: existing.loanerProvided !== true,
    reason: "Already logged today",
  };
}
