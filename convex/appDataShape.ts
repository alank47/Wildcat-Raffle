/**
 * Pure shape and merge rules for the Convex cutover. No ctx, no database, no
 * I/O, so it can be tested directly rather than through a mirror of itself.
 *
 * Split from appData.ts for the same reason identityRules.ts is split from
 * identity.ts: a test that reimplements the logic it is testing can drift from
 * the real thing and still pass, which is worse than no test.
 */

/**
 * Absence means "the caller does not know about this field", NOT "set it to
 * empty".
 *
 * Only undefined, null and a blank string qualify. Three things that look
 * empty are deliberately NOT absence:
 *
 *   0            a spent-down balance is a real balance. Treating it as
 *                absence would make an account impossible to zero out.
 *   []           a student can lose their last raffle qualification.
 *   false        a real boolean.
 *
 * Getting this boundary wrong in either direction is a data loss bug. Too
 * wide and a stale tab blanks real values, which is what happened to 38 staff
 * emails. Too narrow and a deliberate reset silently does nothing.
 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** Structural equality, so an unchanged array or transaction list is not rewritten. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export type AppStudent = Record<string, unknown> & { id: string; name: string };
export type AppTeacher = Record<string, unknown> & { id: string; name: string };

/**
 * A Convex student row in the shape script.js already expects.
 *
 * The app keys students by `id`, which in the Firestore era was the legacy
 * document id. SIS students have never had one, so they fall back to the
 * student number, which is the SIS key and is stable.
 *
 * Ticket counts default to 0 because the app does arithmetic on them and
 * undefined would produce NaN in a total a teacher reads. Balances do NOT
 * default: undefined there means "this student has no cash record", which is
 * different from "this student has zero", and the UI renders them differently.
 */
export function toAppStudent(row: Record<string, any>): AppStudent {
  return {
    id: String(row.legacyId ?? row.studentNumber ?? row._id ?? ""),
    studentNumber: row.studentNumber,
    name: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim(),
    firstName: row.firstName,
    lastName: row.lastName,
    grade: row.grade,
    // Read by wildcat-discipline's snapshotDemographics as `sex`, which
    // already falls back through `s.sex || s.gender`.
    gender: row.gender,
    school: row.school,
    email: row.email,

    pbisTickets: row.pbisTickets ?? 0,
    attendanceTickets: row.attendanceTickets ?? 0,
    academicTickets: row.academicTickets ?? 0,
    bigRaffleQualified: row.bigRaffleQualified ?? [],
    weeksQualified: row.weeksQualified,

    wildcatCashBalance: row.wildcatCashBalance,
    wildcatCashEarned: row.wildcatCashEarned,
    wildcatCashSpent: row.wildcatCashSpent,
    wildcatCashDeducted: row.wildcatCashDeducted,
    wildcatCashRewardsRedeemed: row.wildcatCashRewardsRedeemed,
    wildcatCashTransactions: row.wildcatCashTransactions,
    cashBalance: row.cashBalance,
    cashTransactions: row.cashTransactions,

    archivedAt: row.archivedAt,
  };
}

/**
 * A Convex teacher row in the app's shape.
 *
 * There is no `username` field on this table and there will not be one: the
 * legacy username and cleartext password pair is what the migration exists to
 * delete. Identity is the Entra email.
 */
export function toAppTeacher(row: Record<string, any>): AppTeacher {
  return {
    id: String(row.legacyId ?? row._id ?? ""),
    name: row.name,
    email: row.email,
    role: row.role,
    ticketsAwarded: row.ticketsAwarded ?? 0,
    sections: row.sections,
  };
}

/**
 * The patch to apply, containing ONLY fields that actually changed.
 *
 * Two rules, in order:
 *   1. An absent incoming value never overwrites a value that is present.
 *   2. An unchanged value is not written at all.
 *
 * Rule 1 is the anti-clobber rule. Rule 2 keeps the audit trail honest: a save
 * that changes nothing should produce no writes, so "1 student changed" in a
 * sync summary means one student actually changed.
 */
export function mergeIncoming(
  existing: Record<string, any>,
  incoming: Record<string, any>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (isAbsent(value)) continue; // never write an absence, in either direction
    if (same(existing[key], value)) continue;
    patch[key] = value;
  }
  return patch;
}

/**
 * The fields a BROWSER may write on a student.
 *
 * An allowlist, because a denylist fails open: the day somebody adds a field,
 * a denylist silently permits the browser to write it. Identity and enrollment
 * are absent on purpose. Those belong to the SIS, and a teacher's browser has
 * no business renaming a child or changing their grade level.
 */
export const STUDENT_WRITABLE = [
  "pbisTickets",
  "attendanceTickets",
  "academicTickets",
  "bigRaffleQualified",
  "weeksQualified",
  "wildcatCashBalance",
  "wildcatCashEarned",
  "wildcatCashSpent",
  "wildcatCashDeducted",
  "wildcatCashRewardsRedeemed",
  "wildcatCashTransactions",
  "cashBalance",
  "cashTransactions",
] as const;

/** Same reasoning for staff. Email and role are NOT writable from a browser. */
export const TEACHER_WRITABLE = ["name", "ticketsAwarded", "sections"] as const;

function pick(source: Record<string, any>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = source?.[key];
  return out;
}

export type PlannedPatch = { key: string; rowId: unknown; patch: Record<string, unknown> };
export type SavePlan = { patches: PlannedPatch[]; skipped: string[] };

/**
 * Decide what a save WOULD write, without writing anything.
 *
 * Pulled out of the mutation so the dangerous path is unit testable. Proving
 * the mutation refuses a hostile payload otherwise means removing its auth
 * gate to call it, and a gate that gets commented out to test it is a gate
 * that eventually ships commented out.
 *
 * `matchKeys` maps every key a row can be addressed by (legacy id and student
 * number) to that row. An incoming record matching nothing is SKIPPED, never
 * inserted: the SIS owns the roster, and inserting on a key miss is how a typo
 * becomes a phantom child with a balance.
 */
export function planSave(
  rows: Array<Record<string, any>>,
  incoming: Array<Record<string, any>>,
  writable: readonly string[],
  keysOf: (row: Record<string, any>) => string[],
): SavePlan {
  const byKey = new Map<string, Record<string, any>>();
  for (const row of rows) {
    for (const key of keysOf(row)) if (key) byKey.set(key, row);
  }

  const patches: PlannedPatch[] = [];
  const skipped: string[] = [];
  for (const record of incoming ?? []) {
    const key = String(record?.id ?? record?.studentNumber ?? "");
    const row = key ? byKey.get(key) : undefined;
    if (!row) {
      if (key) skipped.push(key);
      continue;
    }
    const patch = mergeIncoming(row, pick(record, writable));
    if (Object.keys(patch).length > 0) patches.push({ key, rowId: row._id, patch });
  }
  return { patches, skipped };
}
