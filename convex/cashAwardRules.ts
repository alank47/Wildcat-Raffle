/**
 * THE RULES FOR A CASH AWARD MADE AS A SERVER COMMAND. Pure, so every one of
 * them is testable without a database, the same split as cashReversalRules and
 * studentStoreRules.
 *
 * WHY AN AWARD BECAME A COMMAND, 2026-09-23. Until today a Wildcat Cash award
 * was three separate writes a browser made seconds apart: the balance (as a
 * delta the tab worked out itself), the ledger row, and the audit entry. On
 * that one afternoon a stale tab put 76 repaired students back at their old
 * balances within five minutes, and another paid 27 students' repayments
 * twice. The owner's standard, in his words: "A stale tab should never dictate
 * the information 40+ users see."
 *
 * A command fixes the class rather than the instance. The browser says WHAT
 * happened -- award this child $100 for Be Present, receipt txn_... -- and the
 * server moves the money from its OWN numbers, writes the ledger row, the
 * child's copy of it and the audit entry, and records the receipt, all in one
 * transaction. A tab's view of the balance never enters into it.
 *
 * ONE RECEIPT, EVERY STORE. The receipt is the id the browser already mints for
 * the ledger row. The command registers it in `students.cashApplied` -- the
 * same list appData:save checks -- so when the browser's ordinary save sends
 * the same movement a second later, it is recognised and nothing moves twice.
 * The ledger row carries that id, and the audit entry's id is derived from it,
 * so every re-send anywhere is a duplicate the store already refuses. There is
 * therefore no "fallback" to get wrong: the old path always runs, the command
 * runs beside it, and whichever reaches the server first is the one that
 * counts.
 */

import { cashMovementEffect, MAX_CASH_DELTA } from "./appDataShape";

/** The appState row holding the on/off switch. Absent means OFF. */
export const CASH_AWARD_SWITCH_KEY = "cashAwardCommand";

/**
 * Most awards in one call. The bulk screen shows one page of a class; this is
 * comfortably above a page and far below Convex's per-mutation limits, even
 * though every student row patched carries its whole history array.
 */
export const CASH_AWARD_MAX_BATCH = 60;

/**
 * How far ahead of the server clock an award's own timestamp may sit.
 *
 * The timestamp is the browser's, deliberately: it is the one already on the
 * ledger row in the tab's outbox, and it decides which weekly document the row
 * lands in. A laptop clock a few minutes fast is normal; one claiming an award
 * made tomorrow is not.
 */
export const CASH_AWARD_FUTURE_SKEW_MS = 15 * 60 * 1000;

/** The same slack the history cutoff is enforced with everywhere else. */
export const CASH_AWARD_CUTOFF_SLACK_MS = 60 * 60 * 1000;

/**
 * How old an award may be when its command arrives.
 *
 * A command is sent the moment the award is made and never retried from an
 * outbox -- the ordinary save is what carries an award across an outage -- so
 * a real one is seconds old, plus however far the laptop's clock is behind.
 * Anything older is refused, and the ordinary save delivers it as it always
 * has; nothing is lost by the refusal.
 */
export const CASH_AWARD_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * How far the receipt's own timestamp may sit from the award's.
 *
 * recordCashTransaction mints both from one clock within the same few lines,
 * so they agree to the millisecond in practice. Two minutes is slack, not a
 * tolerance anything real needs.
 */
export const CASH_AWARD_ID_SKEW_MS = 2 * 60 * 1000;

/**
 * The shape recordCashTransaction mints: txn_<13-digit ms>_<base36>.
 *
 * THE SHAPE ALONE PROTECTS NOTHING, and this comment used to claim it did.
 * Every real ledger id matches it and every staff member can see them. What
 * stops a caller naming an existing row's id for a different child is the
 * pair of checks in validateAward below -- the id's embedded time must agree
 * with the award's, and the award must be fresh -- together with the command
 * refusing a receipt its week's ledger already holds for another student.
 */
export const TXN_ID_RE = /^txn_\d{13}_[a-z0-9]{1,12}$/;

/** The milliseconds recordCashTransaction embedded in a receipt. */
export function txnIdMs(txnId: string): number {
  const m = /^txn_(\d{13})_/.exec(String(txnId ?? ""));
  return m ? Number(m[1]) : NaN;
}

/**
 * Behaviour ids that belong to other flows and must never arrive as an award:
 * the reset, the store, its refunds and reversals all write their own rows
 * through their own guarded paths.
 */
const RESERVED_BEHAVIOR = /^(system_reset|reward:|reward-refund:|reversal:)/;

/** The audit entry id for an award, derived so both paths agree on it. */
export function cashAwardAuditId(txnId: string): string {
  return "a_" + String(txnId);
}

/**
 * THE NOTE RULE, mirrored from WildcatRoster.cashNoteVerdict.
 *
 * The browser checks it before any money moves; the server checks it again
 * because a rule only a browser enforces is a rule anyone with devtools can
 * skip. Three letters or digits, so punctuation cannot pad a note to length.
 */
export const CASH_NOTE_MIN = 3;
export function cashNoteVerdict(note: unknown): { ok: true; note: string } | { ok: false; reason: string } {
  const text = note === null || note === undefined ? "" : String(note).trim();
  if (!text) return { ok: false, reason: "Add a note saying what the student did." };
  const meaningful = text.replace(/[^a-z0-9]/gi, "");
  if (meaningful.length < CASH_NOTE_MIN) {
    return { ok: false, reason: "That note is too short. Say what the student did, in a few words." };
  }
  return { ok: true, note: text };
}

export type AwardInput = {
  studentId: string;
  txnId: string;
  at: string;
  amount: number;
  kind: string;
  behaviorId: string;
  behaviorName: string;
  notes: string;
};

export type Refusal = { ok: false; code: string; reason: string };

/**
 * Everything that can be decided about one award without the database.
 *
 * AMOUNTS COME FROM THE BROWSER, and that is a known limit rather than an
 * oversight: the behaviour catalogue lives only in the client and prices are
 * deliberately variable, so the server cannot look a price up. What it can do
 * is bound it -- a whole number, the right sign for its kind, and inside the
 * same cap every other cash path uses.
 */
export function validateAward(
  a: Partial<AwardInput> | null | undefined,
  opts: { nowMs: number; cutoffMs: number | null },
): { ok: true; award: AwardInput } | Refusal {
  const r = a ?? {};
  const txnId = String(r.txnId ?? "");
  if (!TXN_ID_RE.test(txnId)) return { ok: false, code: "bad_id", reason: "The receipt id is not one this app mints." };

  const studentId = String(r.studentId ?? "").trim();
  if (!studentId) return { ok: false, code: "no_student", reason: "No student was named." };

  const kind = String(r.kind ?? "");
  if (kind !== "award" && kind !== "deduct") {
    return { ok: false, code: "bad_kind", reason: "Only awards and deductions travel this way." };
  }

  const amount = Number(r.amount);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount === 0) {
    return { ok: false, code: "bad_amount", reason: "The amount must be a whole, non-zero number." };
  }
  if ((kind === "award" && amount < 0) || (kind === "deduct" && amount > 0)) {
    return { ok: false, code: "sign_mismatch", reason: "An award adds money and a deduction takes it." };
  }
  if (Math.abs(amount) > MAX_CASH_DELTA) {
    return { ok: false, code: "too_large", reason: `No single movement may exceed $${MAX_CASH_DELTA}.` };
  }

  const behaviorId = String(r.behaviorId ?? "");
  if (RESERVED_BEHAVIOR.test(behaviorId)) {
    return { ok: false, code: "reserved_behavior", reason: "That behaviour belongs to another part of the app." };
  }

  const note = cashNoteVerdict(r.notes);
  if (!note.ok) return { ok: false, code: "note_required", reason: note.reason };

  const at = String(r.at ?? "");
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs) || !/^\d{4}-\d{2}-\d{2}T/.test(at)) {
    return { ok: false, code: "bad_time", reason: "The award has no usable timestamp." };
  }
  if (atMs > opts.nowMs + CASH_AWARD_FUTURE_SKEW_MS) {
    return { ok: false, code: "future", reason: "The award is dated in the future." };
  }
  // The cutoff before the age, so an award from before a reset is reported
  // as exactly that rather than merely as old.
  if (opts.cutoffMs !== null && Number.isFinite(opts.cutoffMs) && atMs < opts.cutoffMs - CASH_AWARD_CUTOFF_SLACK_MS) {
    return { ok: false, code: "before_cutoff", reason: "The award is dated before the cash history was reset." };
  }
  if (atMs < opts.nowMs - CASH_AWARD_MAX_AGE_MS) {
    return { ok: false, code: "stale", reason: "The award is too old to arrive as a command; the ordinary save delivers it." };
  }
  if (!(Math.abs(txnIdMs(txnId) - atMs) <= CASH_AWARD_ID_SKEW_MS)) {
    return { ok: false, code: "id_mismatch", reason: "The receipt was not minted with this award." };
  }

  return {
    ok: true,
    award: {
      studentId, txnId, at, amount, kind,
      behaviorId, behaviorName: String(r.behaviorName ?? ""), notes: note.note,
    },
  };
}

/** High School from grade 9, the rule recordCashTransaction uses. */
export function schoolOf(grade: unknown): string {
  return parseInt(String(grade ?? ""), 10) >= 9 ? "High School" : "Middle School";
}

/**
 * The ledger row, field for field what recordCashTransaction writes.
 *
 * Every reader of the ledger was written against that shape: My Activity
 * filters on teacherId, the dashboard skips a row without `type`, the recount
 * buckets on kind and sign, and the child's wallet reads it from the stored
 * array. A row that differed in any of those would quietly vanish from one of
 * them. `balanceAfter` is the one field that is better here than in the
 * browser: it is the server's number rather than a tab's view of it.
 */
export function buildLedgerRow(input: {
  award: AwardInput;
  student: { firstName?: unknown; lastName?: unknown; grade?: unknown };
  appStudentId: string;
  actor: { id: string; name: string };
  balanceAfter: number;
}): Record<string, unknown> {
  const { award, student, actor } = input;
  return {
    id: award.txnId,
    timestamp: award.at,
    studentId: input.appStudentId,
    studentName: `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim(),
    studentGrade: String(student.grade ?? ""),
    school: schoolOf(student.grade),
    teacherId: actor.id,
    teacherUsername: "",
    teacherName: actor.name || "Unknown",
    kind: award.kind,
    type: award.amount >= 0 ? "positive" : "negative",
    behaviorId: award.behaviorId,
    behaviorName: award.behaviorName,
    amount: award.amount,
    notes: award.notes,
    balanceAfter: input.balanceAfter,
  };
}

/**
 * The audit entry, in the shape addToAuditLog writes.
 *
 * `ticketCount` carries the money because that is the field eleven readers
 * already take it from (see cashReversal.ts); `amount` beside it is the honest
 * name. `txId` is new, and it is the link these entries never had: until now an
 * audit entry and its ledger row could only be matched by guessing on the
 * student, the second and the amount.
 */
export function buildAuditPayload(input: {
  award: AwardInput;
  entryId: string;
  appStudentId: string;
  studentName: string;
  actor: { id: string; name: string };
  week: number | null;
  cycle: number | null;
}): Record<string, unknown> {
  const { award } = input;
  const reason = award.behaviorName + (award.notes ? ", " + award.notes : "");
  const payload: Record<string, unknown> = {
    entryId: input.entryId,
    timestamp: award.at,
    teacher: input.actor.name,
    teacherId: input.actor.id,
    action: award.amount >= 0 ? "cash_award" : "cash_deduct",
    studentId: input.appStudentId,
    studentName: input.studentName || "Unknown",
    category: "Wildcat Cash",
    ticketCount: Math.abs(award.amount),
    amount: Math.abs(award.amount),
    reason,
    behavior: award.behaviorName,
    notes: award.notes,
    txId: award.txnId,
  };
  // Week and cycle are the browser's, as display metadata only. Reading them
  // from liveSettings here would put every award in conflict with every save,
  // because that row is rewritten by nearly all of them.
  if (input.week !== null) payload.week = input.week;
  if (input.cycle !== null) payload.cycle = input.cycle;
  return payload;
}

/** A small positive integer, or null. Anything else is not trusted. */
export function smallInt(v: unknown, max: number): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

/** Re-exported so the command and its tests share one rule with appData:save. */
export { cashMovementEffect };
