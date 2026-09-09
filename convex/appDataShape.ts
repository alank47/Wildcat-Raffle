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

/**
 * Same reasoning for staff. Email and role are NOT writable from a browser.
 *
 * `sections` WAS here and has been removed. It is the legacy CSV field: nothing
 * in the PowerSchool path has ever written it, every staff row carries `[]`,
 * and nothing reads it -- a teacher's classes come from psRoster through
 * views_app:teacherRoster, and accessRules refuses to read this field on
 * purpose, because a teacher who can edit their own profile could otherwise
 * grant themselves the whole school.
 *
 * It was not merely dead. Browsers still holding the CSV-era shape sent
 * sections as an array of OBJECTS, the schema says v.array(v.string()), and a
 * Convex mutation is transactional -- so one stale profile failed the entire
 * appData:save, taking students and settings down with it:
 *
 *   Failed to insert or update a document in table "teachers"
 *   Path: .sections[0]
 *   Value: {courseName: "Multimedia Production 1B", period: "P4", ...}
 *   Validator: v.string()
 *
 * Removing it from the allowlist stops the browser sending it at all. Values
 * already stored are left exactly as they are; nothing reads them.
 */
export const TEACHER_WRITABLE = ["name", "ticketsAwarded"] as const;

function pick(source: Record<string, any>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = source?.[key];
  return out;
}

/**
 * THE CASH COUNTERS ARE INCREMENTED, NOT OVERWRITTEN.
 *
 * A balance is computed in the browser: award ten dollars, the tab adds ten
 * to the number it loaded and sends the sum. Two tabs that loaded the same
 * child at 100 and each award ten both send 110, and the second to land
 * erases the first: the ledger shows two awards and the balance shows one.
 * Until 2026-09-09 the only protection was the staleness guard, a three
 * minute window that forty teachers cross all day.
 *
 * So a record may carry `cashDelta`: for each counter, how much THIS tab
 * changed it since the value it last confirmed with the server. The server
 * adds the delta to what it holds. Both tabs above send +10, and the child
 * ends at 120, which is what happened. A record without cashDelta (an older
 * client) is merged as before, absolute values and all.
 */
export const CASH_COUNTERS = [
  "wildcatCashBalance",
  "wildcatCashEarned",
  "wildcatCashSpent",
  "wildcatCashDeducted",
] as const;

/** The usable deltas on a record: finite, non-zero numbers only. Null when none was sent. */
export function cashDeltaOf(record: Record<string, any>): Record<string, number> | null {
  const d = record?.cashDelta;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const out: Record<string, number> = {};
  for (const field of CASH_COUNTERS) {
    const v = Number((d as Record<string, unknown>)[field]);
    if (Number.isFinite(v) && v !== 0) out[field] = v;
  }
  return out;
}

/**
 * The patch for one record. Counters go by delta when the record carries one
 * (their absolute values are then ignored, because they describe the tab's
 * view and not the server's); everything else goes through mergeIncoming
 * exactly as before.
 */
export function planPatch(
  row: Record<string, any>,
  record: Record<string, any>,
  writable: readonly string[],
): Record<string, unknown> {
  const fields = pick(record, writable);
  const delta = cashDeltaOf(record);
  if (delta === null) return mergeIncoming(row, fields);
  const counters = new Set<string>(CASH_COUNTERS);
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) if (!counters.has(key)) rest[key] = value;
  const patch = mergeIncoming(row, rest);
  for (const [field, d] of Object.entries(delta)) {
    patch[field] = (Number(row[field]) || 0) + d;
  }
  return patch;
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
    const patch = planPatch(row, record, writable);
    if (Object.keys(patch).length > 0) patches.push({ key, rowId: row._id, patch });
  }
  return { patches, skipped };
}
