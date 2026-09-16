/**
 * Whether one Wildcat Cash transaction may be reversed, and what a reversal
 * does to the four counters. Pure: no ctx, no clock, no database.
 *
 * WHY A REVERSAL EXISTS AT ALL. Until now a teacher who deducted $500 from the
 * wrong child had exactly one recourse: award $500 back. That records a second,
 * fictional POSITIVE behaviour on the child's record, inflates "Most Common
 * Behavior", inflates that teacher's positive count, and is indistinguishable
 * from a real award in every report the school has. The correction was worse
 * than the mistake, and permanent.
 *
 * THE SHAPE, AND WHY IT IS NOT A DELETE. Nothing is removed. A reversal is a
 * NEW ledger row that names the row it cancels (`reversesTxnId`) and carries a
 * copy of it, so the pair explains itself to a parent asking in March without
 * anyone joining two tables. This app is a school discipline record; a
 * deduction is an adult taking money off a child for a behaviour, and erasing
 * that is not tidying, it is losing the truth.
 *
 * THREE RULES THIS FILE ENFORCES, each from a real incident:
 *
 *   1. `type` STAYS THE SIGN. recordCashTransaction writes
 *      `type: amount >= 0 ? 'positive' : 'negative'`, and cash-audit.test.mjs
 *      pins that expression with the warning "re-check the ten other panels
 *      that read it" -- I counted eleven. A reversal that invented
 *      `type: 'reversal'` would render red "Negative -$500" on a row handing
 *      $500 BACK, and vanish from the Positive/Negative filter. The semantics
 *      live in `kind` and `reversesTxnId`, never in `type`.
 *
 *   2. IT UN-COUNTS, IT DOES NOT COUNTER-AWARD. Reversing a $500 deduction
 *      moves the balance +500 and `wildcatCashDeducted` -500. It does not add
 *      500 to `wildcatCashEarned`. That single difference is the whole point:
 *      the award-it-back workaround inflates earnings, and this does not.
 *
 *   3. IT CANNOT MINT MONEY. Balances were zeroed school-wide on 2026-09-14 and
 *      a server-owned history cutoff prunes anything older on every write path.
 *      Reversing a transaction from before that boundary would hand back money
 *      the balance no longer contains. Refused, by arithmetic on the timestamp
 *      rather than by judgement about which rows look old.
 *
 * The cumulative counters are also never driven negative -- see
 * `negativeCounterRefusals`. That is not tidiness either:
 * leaderboardRules.ts:78 `earnedOf` treats a negative `wildcatCashEarned` as
 * UNKNOWN, so one bad reversal would silently drop a child off the cash
 * leaderboard their whole year group can see.
 */

/** The four counters a cash movement can touch. Mirrors CASH_COUNTERS. */
export const COUNTERS = [
  "wildcatCashBalance",
  "wildcatCashEarned",
  "wildcatCashSpent",
  "wildcatCashDeducted",
] as const;

/**
 * The counters that only ever go UP in normal use, and must never be pushed
 * below zero by a reversal. `wildcatCashBalance` is deliberately absent: a
 * balance is allowed to be negative and stay visible, which is the owner's
 * explicit call -- hiding an overdrawn child is worse than showing one.
 */
export const CUMULATIVE_COUNTERS = [
  "wildcatCashEarned",
  "wildcatCashSpent",
  "wildcatCashDeducted",
] as const;

/** How far before the cutoff a row may be dated and still be reversible. */
export const CUTOFF_SLACK_MS = 60 * 60 * 1000;

export type CashRow = {
  id?: string;
  timestamp?: string;
  studentId?: string;
  studentName?: string;
  amount?: number;
  kind?: string;
  type?: string;
  behaviorId?: string;
  behaviorName?: string;
  notes?: string;
  teacherId?: string;
  teacherName?: string;
  reversesTxnId?: string;
};

/**
 * The ISO-week document key a cash row belongs to.
 *
 * A CHARACTER-FOR-CHARACTER MIRROR of cashWeekKey in script.js (~29090),
 * including its quirks: it parses only the date portion by regex, so a row
 * with a malformed timestamp lands in 'unknown' rather than throwing, and it
 * uses the ISO-8601 week-numbering year, so 1 January can belong to the
 * previous year's W52. There is no bundler in this project -- index.html loads
 * plain <script> tags -- so the client function cannot be imported here and
 * this is a deliberate duplicate. cashReversal.test.mjs pins the two against
 * each other on a table of dates, because the day they disagree is the day a
 * reversal is written into a week document nothing reads.
 */
export function cashWeekKey(ts: unknown): string {
  const s = String(ts ?? "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "unknown";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}_W${String(week).padStart(2, "0")}`;
}

/**
 * Every week key from `fromMs` to `toMs` inclusive, oldest first.
 *
 * WHY THE SEARCH IS BOUNDED BY THE CUTOFF. legacyMirror is indexed by document
 * name only -- there is no index on `payload.id` -- so finding one transaction
 * means reading a week document and scanning it. Scanning every week of the
 * year would blow Convex's 4,096-document read limit by spring. But a
 * transaction older than the history cutoff is refused anyway, so the weeks
 * worth searching are exactly the weeks since the cutoff. Today that is one.
 * The cap exists so that a school which never resets degrades into a clear
 * error rather than a failed execution.
 */
export function weekKeysBetween(fromMs: number, toMs: number, cap = 14): string[] {
  const out: string[] = [];
  const DAY = 86400000;
  for (let t = fromMs; t <= toMs; t += 7 * DAY) {
    const k = cashWeekKey(new Date(t).toISOString());
    if (k !== "unknown" && !out.includes(k)) out.push(k);
    if (out.length >= cap) break;
  }
  // The end of the range falls in a week the 7-day stride steps over whenever
  // the span is not a whole number of weeks, so the last week is added here
  // rather than by widening the loop -- widening it can also step PAST the
  // range and pick up a week that holds nothing.
  const last = cashWeekKey(new Date(toMs).toISOString());
  if (last !== "unknown" && !out.includes(last) && out.length < cap) out.push(last);
  return out;
}

/**
 * The counter movement that un-counts one transaction.
 *
 * Read the three cases as "undo what recordCashTransaction did":
 *   an award      (+100, kind 'award')  -> balance -100, earned   -100
 *   a deduction   (-500, kind 'deduct') -> balance +500, deducted -500
 *   a redemption  (-200, kind 'redeem') -> balance +200, spent    -200
 *
 * The kind decides which cumulative counter, NOT the sign -- because the
 * writer stamps `spent` from `kind === 'redeem'` and the other two from the
 * sign, so a redemption and a deduction are both negative and must un-count
 * differently. Reading the sign here is the same mistake that put Maria Agaton
 * Colin in a red intervention table for a purchase.
 */
export function plannedCounterDelta(original: CashRow): Record<string, number> {
  const amount = Number(original?.amount);
  if (!Number.isFinite(amount) || amount === 0) return {};
  const kind = String(original?.kind ?? (amount >= 0 ? "award" : "deduct"));

  const delta: Record<string, number> = { wildcatCashBalance: -amount };
  if (kind === "redeem") delta.wildcatCashSpent = -Math.abs(amount);
  else if (amount > 0) delta.wildcatCashEarned = -amount;
  else delta.wildcatCashDeducted = -Math.abs(amount);
  return delta;
}

/**
 * Which cumulative counters this delta would drive below zero, given the
 * student's current values. Empty is the good answer.
 */
export function negativeCounterRefusals(
  delta: Record<string, number>,
  counters: Record<string, unknown>,
): string[] {
  const bad: string[] = [];
  for (const f of CUMULATIVE_COUNTERS) {
    const d = delta[f];
    if (d === undefined || d >= 0) continue;
    const now = Number(counters?.[f]);
    const base = Number.isFinite(now) ? now : 0;
    if (base + d < 0) bad.push(f);
  }
  return bad;
}

export type Verdict = { allowed: boolean; code: string; reason: string };

const OK: Verdict = { allowed: true, code: "ok", reason: "" };

/**
 * May this transaction be reversed?
 *
 * ORDER MATTERS, and it is ordered by what the person needs to hear. "Already
 * reversed" comes before every complaint about the row itself, because that is
 * the double-tap case and it is not an error. A caller seeing
 * `already_reversed` should report success, not failure -- see the mutation.
 */
export function reversalVerdict(opts: {
  original: CashRow | null | undefined;
  existingReversal?: { reversalTxnId?: string } | null;
  historyCutoffMs?: number | null;
  counters?: Record<string, unknown>;
  maxDelta?: number;
}): Verdict {
  const { original, existingReversal, historyCutoffMs, counters, maxDelta } = opts;

  if (existingReversal) {
    return {
      allowed: false,
      code: "already_reversed",
      reason: "This transaction has already been reversed.",
    };
  }
  if (!original) {
    return {
      allowed: false,
      code: "not_found",
      reason:
        "That transaction could not be found in the cash ledger. It may be older " +
        "than the current history, or it may never have reached the server.",
    };
  }

  const amount = Number(original.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    return {
      allowed: false,
      code: "no_amount",
      reason: "That transaction has no usable amount, so there is nothing to reverse.",
    };
  }

  // A REVERSAL IS NOT REVERSIBLE. Undoing an undo is a second, opposite
  // movement dressed up as a correction, and it makes the audit trail a
  // puzzle. If the reversal was itself a mistake, the original action is
  // performed again, by a human, with a note -- and reads as what it is.
  if (String(original.kind) === "reversal" || original.reversesTxnId) {
    return {
      allowed: false,
      code: "is_a_reversal",
      reason:
        "That row is itself a reversal. To put the money back, award or deduct it " +
        "again so the record shows a fresh decision rather than an undo of an undo.",
    };
  }

  // A STORE PURCHASE IS CANCELLED, NOT REVERSED. The receipt is the thing that
  // matters -- whether the child was handed the item -- and WildcatStore's
  // cancel path already moves the receipt to 'cancelled' AND issues the refund.
  // Reversing the cash row alone would take the money back while leaving an
  // open receipt the child can still collect against.
  if (String(original.kind) === "redeem") {
    return {
      allowed: false,
      code: "use_store_cancel",
      reason:
        "That is a store purchase. Cancel the receipt in the Store instead, which " +
        "refunds the cash and closes the receipt together.",
    };
  }
  if (String(original.behaviorId ?? "").startsWith("reward-refund:")) {
    return {
      allowed: false,
      code: "is_a_refund",
      reason:
        "That row is a store refund. Reversing it would take back money a " +
        "cancelled receipt already returned.",
    };
  }

  // THE RESET BOUNDARY. Everything before the cutoff was cleared from the
  // balances; handing it back would create money from nothing.
  if (typeof historyCutoffMs === "number" && Number.isFinite(historyCutoffMs)) {
    const t = Date.parse(String(original.timestamp ?? ""));
    if (Number.isFinite(t) && t < historyCutoffMs - CUTOFF_SLACK_MS) {
      return {
        allowed: false,
        code: "before_reset",
        reason:
          "That transaction is from before the last balance reset, so its money is " +
          "no longer in any balance. Reversing it would add money that was never there.",
      };
    }
    // An UNDATED row cannot be proved to be on the safe side of the boundary,
    // and unlike pruning -- where keeping an undated row is the cautious
    // choice -- here the cautious choice is to refuse. Pruning wrongly loses a
    // record; reversing wrongly moves money.
    if (!Number.isFinite(t)) {
      return {
        allowed: false,
        code: "undated",
        reason:
          "That transaction has no usable date, so it cannot be placed against the " +
          "last balance reset. It has to be corrected by hand.",
      };
    }
  }

  const cap = typeof maxDelta === "number" ? maxDelta : Infinity;
  if (Math.abs(amount) > cap) {
    return {
      allowed: false,
      code: "too_large",
      reason:
        `That transaction is $${Math.abs(amount)}, above the $${cap} limit for a ` +
        "single automatic movement. It has to be corrected by hand.",
    };
  }

  if (counters) {
    const bad = negativeCounterRefusals(plannedCounterDelta(original), counters);
    if (bad.length) {
      return {
        allowed: false,
        code: "counter_underflow",
        reason:
          "Reversing this would push " + bad.join(" and ") + " below zero, which " +
          "means the stored totals disagree with the history. Worth a look before " +
          "moving any money.",
      };
    }
  }

  return OK;
}

/**
 * The reversal ledger row.
 *
 * SELF-DESCRIBING ON PURPOSE. The nine `reverses*` fields are a snapshot of
 * the original, and they are worth their ~150 bytes because the alternative is
 * a join: `distributeCashTransactions` (script.js:29346) rebuilds every
 * student's transaction array from the ledger on each load, so nothing written
 * onto the ORIGINAL row would survive -- the original cannot be annotated, and
 * a reader holding only this row has to be able to explain it.
 *
 * `id` is minted by the CALLER (the mutation), never by the browser. A
 * client-minted id lets a double-tap insert a second row into the week
 * document under a different id, and unionCashRows dedupes by id, so it would
 * have no way to notice.
 */
export function buildReversalRow(opts: {
  original: CashRow;
  reversalId: string;
  actorName: string;
  actorId: string;
  reason: string;
  nowIso: string;
  studentName?: string;
  studentGrade?: string;
}): Record<string, unknown> {
  const { original, reversalId, actorName, actorId, reason, nowIso } = opts;
  const amount = -Number(original.amount);

  return {
    id: reversalId,
    timestamp: nowIso,
    studentId: String(original.studentId ?? ""),
    studentName: opts.studentName ?? original.studentName ?? "",
    studentGrade: opts.studentGrade ?? "",

    // The person who pressed Reverse, not the person who made the original
    // movement. Both are on the row; conflating them would credit a mistake to
    // whoever fixed it.
    teacherId: actorId,
    teacherName: actorName,

    kind: "reversal",
    // RULE 1. The sign, exactly as recordCashTransaction computes it. Eleven
    // panels read this field.
    type: amount >= 0 ? "positive" : "negative",

    amount,
    behaviorId: "reversal:" + String(original.id ?? ""),
    behaviorName: "Reversed: " + String(original.behaviorName || original.kind || "cash"),
    notes: reason,

    reversesTxnId: String(original.id ?? ""),
    reversesTimestamp: String(original.timestamp ?? ""),
    reversesAmount: Number(original.amount),
    reversesKind: String(original.kind ?? ""),
    reversesBehaviorId: String(original.behaviorId ?? ""),
    reversesBehaviorName: String(original.behaviorName ?? ""),
    reversesTeacherId: String(original.teacherId ?? ""),
    reversesTeacherName: String(original.teacherName ?? ""),
    reversesNotes: String(original.notes ?? ""),
  };
}

/**
 * The audit action for a reversal, chosen from the ORIGINAL's sign.
 *
 * TWO ACTIONS AND NOT ONE, which looks like duplication and is not.
 * wildcat-cashaudit.js holds a static per-action `sign` map and computes
 * `signed = meta.sign * Math.abs(amount)`. A single `cash_reversal` action
 * would need `sign: 0` and would render every reversal as "+$0" -- the file's
 * own comment warns "null, never 0" about exactly this. Two actions need no
 * change to describe() at all.
 *
 * Both must also be registered in CASH_ACTIONS, LABELS and FEED_ACTION_CATS:
 * dashboard-feed.test.mjs asserts every action string the app writes appears in
 * that registry, so an unregistered one fails the suite rather than quietly
 * rendering as "Unknown".
 */
export function reversalAuditAction(original: CashRow): string {
  return Number(original?.amount) < 0 ? "cash_reversal_credit" : "cash_reversal_debit";
}
