/**
 * Deriving a student's four cash counters from their transaction history.
 *
 * WHY THIS EXISTS. `recordCashTransaction` only ever MOVES a counter
 * (`student.wildcatCashBalance += amount`), and `recalculateCashBalance` --
 * the one function that derives a counter from history -- has exactly one
 * caller, inside the test-data seeder, gated on CASH_TEST_PREFIX. So for a
 * real student nothing has ever recomputed a counter from history, and a
 * counter that drifts can never come back on its own.
 *
 * Measured on production 2026-09-17: of 509 students with cash history, 220
 * held a stored balance that disagreed with their own transactions. 219 were
 * stored BELOW their history, $48,000 between them, and 26 read $0 while
 * holding awards. convex/studentStore.ts reads `wildcatCashBalance` directly,
 * so that is the number a child is shown and the number the Buy button
 * compares a price against.
 *
 * WHY NOT JUST COPY recalculateCashBalance. Because it predates both the
 * reversal and the refund, and buckets each of them by SIGN. Three students
 * prove it, and all three are ones the naive sum gets wrong:
 *
 *   - Breonny Vazquez has a reversal of a $100 award. By sign that is a
 *     negative row, so the naive sum reports `deducted` $300 and `earned`
 *     $100. cashReversalRules.plannedCounterDelta says a reversal UN-COUNTS
 *     the original: `earned` $0, `deducted` $200 -- which is exactly what her
 *     stored record already holds. The naive recompute would have corrupted a
 *     correct record.
 *
 *   - Francisco Antonio-Pascual has a refund of a cancelled purchase. It is
 *     written `kind: 'award'`, so the naive sum counts it as EARNED and
 *     credits him with money he never earned. legacyPurge's own repair states
 *     the rule: "THE COUNTERS ARE UN-COUNTED, NOT COUNTER-AWARDED: balance up,
 *     `spent` back down, `earned` untouched."
 *
 *   - Nadia Almendares-Castaneda has a $1,000 refund whose CHARGE is not in
 *     the ledger: the purchase predates the 14 September history cutoff and
 *     was pruned, and her receipt WC-XPSGVE is not in studentPurchases either.
 *     Her `balanceAfter` trail shows the school's own system agreeing -- it
 *     runs 400, then 1400 across the refund, then 500 on the very next row.
 *     Crediting a refund whose charge no longer exists hands back money that
 *     was never taken, so the row is excluded and reported rather than summed.
 *
 * With those three rules the derivation reproduces all three stored records
 * EXACTLY, which is the check that earns the right to overwrite the other 219.
 *
 * Pure functions, no Convex: convex/cashRecount.test.mjs lifts them from this
 * file and runs them against the shapes above.
 */

/** The four counters, in the order every report prints them. */
export const RECOUNT_COUNTERS = [
  "wildcatCashBalance",
  "wildcatCashEarned",
  "wildcatCashSpent",
  "wildcatCashDeducted",
] as const;

/**
 * The receipt a refund or a charge names, e.g. "WC-A68031".
 *
 * Read out of `notes` because that is the only place it appears on a ledger
 * row: a purchase writes "Reward purchase WC-A68031", and the refund that
 * un-does it writes "Cancelled receipt WC-A68031".
 */
export function receiptCodeOf(notes: unknown): string | null {
  const m = String(notes === null || notes === undefined ? "" : notes).match(/\b(WC-[A-Z0-9]+)\b/);
  return m ? m[1] : null;
}

/**
 * The receipts that actually have a CHARGE in this history.
 *
 * Per student, which is correct because a receipt belongs to one student: the
 * charge and the refund that un-does it are always on the same record.
 */
export function chargedReceipts(rows: readonly any[]): string[] {
  const out: string[] = [];
  (rows || []).forEach((r) => {
    if (String(r && r.kind ? r.kind : "") !== "redeem") return;
    const code = receiptCodeOf(r && r.notes);
    if (code && out.indexOf(code) < 0) out.push(code);
  });
  return out;
}

/**
 * One student's four counters, derived from their transaction rows.
 *
 * `reversalDeltas` maps a reversal row's own id to the `counterDelta` that
 * cashReversals recorded when it was written -- the authoritative statement of
 * which counter the reversal un-counted, rather than a guess from the sign.
 *
 * The cumulative counters are floored at zero. That is not tidiness:
 * leaderboardRules.ts treats a negative `wildcatCashEarned` as UNKNOWN and
 * drops the child off the cash leaderboard their whole year group can see.
 * `wildcatCashBalance` is deliberately NOT floored -- a balance is allowed to
 * be negative and stay visible, which is the owner's explicit call.
 */
export function deriveCounters(
  rows: readonly any[],
  reversalDeltas?: Record<string, any> | null,
): { counters: Record<string, number>; excluded: any[]; rowsUsed: number } {
  const deltas = reversalDeltas || {};
  const charged = chargedReceipts(rows);
  const excluded: any[] = [];
  let balance = 0;
  let earned = 0;
  let spent = 0;
  let deducted = 0;
  let used = 0;

  (rows || []).forEach((r) => {
    const id = String(r && r.id ? r.id : "");
    // NOT Number(raw): Number(null) and Number("") are both 0, so an amount
    // that could not be read would be silently counted as no money at all --
    // which is the exact failure this whole repair exists to undo.
    const raw = r ? r.amount : undefined;
    const amount = (raw === null || raw === undefined || raw === "") ? NaN : Number(raw);
    if (!Number.isFinite(amount)) {
      excluded.push({ id, amount: raw === undefined ? null : raw, why: "the amount is not a number" });
      return;
    }
    const kind = String(r && r.kind ? r.kind : "");
    const behaviorId = String(r && r.behaviorId ? r.behaviorId : "");

    // A reversal un-counts the original. Never bucketed by its own sign.
    if (kind === "reversal") {
      const d = deltas[id];
      if (d && typeof d === "object") {
        balance += Number(d.wildcatCashBalance) || 0;
        earned += Number(d.wildcatCashEarned) || 0;
        spent += Number(d.wildcatCashSpent) || 0;
        deducted += Number(d.wildcatCashDeducted) || 0;
      } else {
        // No recorded delta. The reversal's amount is the negation of the
        // original, so its sign still says which counter to un-count.
        balance += amount;
        if (amount < 0) earned -= Math.abs(amount);
        else deducted -= Math.abs(amount);
      }
      used++;
      return;
    }

    // A refund puts `spent` back down; it does not inflate `earned`. And a
    // refund whose charge is not here is not a refund of anything.
    if (behaviorId.indexOf("reward-refund:") === 0) {
      const code = receiptCodeOf(r && r.notes);
      if (!code || charged.indexOf(code) < 0) {
        excluded.push({
          id, amount, receipt: code,
          why: "a refund whose charge is not in this history: crediting it would " +
               "hand back money that was never taken",
        });
        return;
      }
      balance += amount;
      spent -= Math.abs(amount);
      used++;
      return;
    }

    balance += amount;
    if (kind === "redeem") spent += Math.abs(amount);
    else if (amount > 0) earned += amount;
    else deducted += Math.abs(amount);
    used++;
  });

  return {
    counters: {
      wildcatCashBalance: balance,
      wildcatCashEarned: Math.max(0, earned),
      wildcatCashSpent: Math.max(0, spent),
      wildcatCashDeducted: Math.max(0, deducted),
    },
    excluded,
    rowsUsed: used,
  };
}

/**
 * What to do about one student, given what is stored and what was derived.
 *
 * REFUSES TO REDUCE A BALANCE unless asked in so many words. A repair that
 * can only ever pay a child what the ledger says they earned is one that can
 * be run without a decision about any individual; the moment it can also take
 * money off a child it needs a human to have looked at that child. There is
 * one such student in the 2026-09-17 measurement and her case is genuinely
 * arguable, so `includeDecreases` is a separate, explicit choice.
 *
 * `maxChange` is a blast radius, not a business rule: the largest real
 * correction measured is $1,200, so a five-figure one means the derivation is
 * wrong, not that a child is owed a fortune. It is held back and reported.
 */
export function recountVerdict(
  stored: Record<string, any>,
  derived: Record<string, number>,
  opts?: { includeDecreases?: boolean; maxChange?: number },
): { action: string; why?: string; patch: Record<string, number>; changes: any[] } {
  const includeDecreases = Boolean(opts && opts.includeDecreases === true);
  const cap = Number(opts && opts.maxChange) > 0 ? Number(opts!.maxChange) : 50000;
  const patch: Record<string, number> = {};
  const changes: any[] = [];

  ["wildcatCashBalance", "wildcatCashEarned", "wildcatCashSpent", "wildcatCashDeducted"].forEach((f) => {
    const now = Number(derived ? derived[f] : NaN);
    if (!Number.isFinite(now)) return;
    const was = Number(stored ? stored[f] : 0) || 0;
    if (Math.abs(now - was) < 0.005) return;
    patch[f] = now;
    changes.push({ field: f, was, now, delta: now - was });
  });

  if (!changes.length) return { action: "already correct", patch: {}, changes: [] };

  let biggest = 0;
  changes.forEach((c) => { if (Math.abs(c.delta) > biggest) biggest = Math.abs(c.delta); });
  if (biggest > cap) {
    return {
      action: "held back", patch: {}, changes,
      why: "a change of $" + biggest + " is beyond the $" + cap + " safety cap",
    };
  }

  let balanceDelta = 0;
  changes.forEach((c) => { if (c.field === "wildcatCashBalance") balanceDelta = c.delta; });
  if (balanceDelta < 0 && !includeDecreases) {
    return {
      action: "held back", patch: {}, changes,
      why: "this would REDUCE the balance by $" + Math.abs(balanceDelta) +
           "; pass includeDecreases to allow it",
    };
  }

  return { action: "repair", patch, changes };
}
