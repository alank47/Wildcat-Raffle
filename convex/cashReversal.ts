import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { MAX_CASH_DELTA } from "./appDataShape";
import {
  buildReversalRow,
  cashWeekKey,
  plannedCounterDelta,
  reversalAuditAction,
  reversalVerdict,
  weekKeysBetween,
  type CashRow,
} from "./cashReversalRules";

/**
 * Reversing one Wildcat Cash transaction.
 *
 * THE MUTATION TAKES NO AMOUNT. `{ originalTxnId, reason }` and nothing else:
 * the server reads the original row and derives the money from it. Every money
 * incident in this app's history was a number the browser supplied and the
 * server trusted -- the $4,901,850 resurrection on 2026-09-13 was a stale tab
 * re-sending its own view of 336 balances. An argument that does not exist
 * cannot be forged, replayed with a different value, or fat-fingered.
 *
 * EVERYTHING HAPPENS IN ONE CONVEX TRANSACTION: the register row, the ledger
 * row, the counter movement and the audit entry. A reversal that moved the
 * money but failed to record itself would be repeatable; one that recorded
 * itself but failed to move the money would be a lie. Convex mutations are
 * atomic, so neither is reachable.
 *
 * WHY THERE IS NO CLIENT HALF YET. This file reloads nobody: deploying a
 * Convex function does not touch index.html, so it cannot arm the self-update
 * on 40 staff tabs mid-lesson. The button, the per-student panel and the
 * read-side changes that stop a reversal being double-counted ship separately,
 * after school hours. Until then this is reachable from the Convex dashboard
 * and the CLI, which is enough to fix a real mis-deduction today.
 */

/** How many students to scan when nothing narrows the search. */
const MAX_WEEK_DOCS = 14;

async function historyCutoffMs(ctx: any): Promise<number | null> {
  const row = await ctx.db
    .query("appState")
    .withIndex("by_key", (q: any) => q.eq("key", "historyCutoff"))
    .unique();
  const iso = (row?.value as Record<string, unknown> | undefined)?.iso;
  const parsed = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Find one transaction in the ledger, and the week document holding it.
 *
 * legacyMirror is indexed by document name only -- there is no index on
 * `payload.id` -- so this reads candidate week documents and scans them. The
 * candidates are bounded by the history cutoff, because a transaction older
 * than that is refused anyway: today that is one document. `weekHint` skips
 * even that when the caller already knows, and is never trusted -- a wrong
 * hint costs one extra document read, not a wrong answer.
 */
async function findLedgerRow(
  ctx: any,
  txnId: string,
  cutoffMs: number | null,
  nowMs: number,
  weekHint?: string | null,
): Promise<{ row: CashRow; weekKey: string; docId: any } | null> {
  const weeks: string[] = [];
  if (weekHint) weeks.push(String(weekHint));
  const from = cutoffMs === null ? nowMs - 60 * 86400000 : cutoffMs;
  for (const w of weekKeysBetween(from, nowMs, MAX_WEEK_DOCS)) {
    if (!weeks.includes(w)) weeks.push(w);
  }

  for (const week of weeks) {
    const doc = "cash_tx_" + week;
    const rows = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc_collection", (q: any) =>
        q.eq("doc", doc).eq("collection", "transactions"))
      .collect();
    for (const r of rows as any[]) {
      if (String(r.payload?.id ?? "") === txnId) {
        return { row: r.payload as CashRow, weekKey: week, docId: r._id };
      }
    }
  }
  return null;
}

/** The student row this transaction belongs to, by the app-facing id. */
async function findStudent(ctx: any, studentId: string) {
  const all = await ctx.db.query("students").collect();
  return (all as any[]).find(
    (s) => String(s.legacyId ?? s._id) === studentId || String(s._id) === studentId,
  ) ?? null;
}

async function existingReversal(ctx: any, txnId: string) {
  return await ctx.db
    .query("cashReversals")
    .withIndex("by_originalTxnId", (q: any) => q.eq("originalTxnId", txnId))
    .unique();
}

/**
 * The shared body, so the public admin mutation and the internal CLI variant
 * cannot drift. The only difference between them is who is allowed to call.
 */
async function doReverse(
  ctx: any,
  args: { originalTxnId: string; reason: string; weekHint?: string | null },
  actor: { name: string; id: string; email: string },
) {
  const txnId = String(args.originalTxnId ?? "").trim();
  if (!txnId) throw new Error("originalTxnId is required.");
  const reason = String(args.reason ?? "").trim();

  // A REASON IS MANDATORY, for the same argument cashNoteVerdict already makes
  // about deductions: a money movement on a child's record with no stated
  // cause is not auditable six months later, and "no reason given" in a field
  // is worse than a refusal now.
  if (reason.length < 3) {
    return {
      ok: false,
      code: "reason_required",
      reason: "Say why this is being reversed. It goes on the record.",
    };
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cutoff = await historyCutoffMs(ctx);

  const already = await existingReversal(ctx, txnId);
  const found = already
    ? null
    : await findLedgerRow(ctx, txnId, cutoff, nowMs, args.weekHint);

  const student = found ? await findStudent(ctx, String(found.row.studentId ?? "")) : null;

  const verdict = reversalVerdict({
    original: found?.row ?? null,
    existingReversal: already,
    historyCutoffMs: cutoff,
    counters: student ?? undefined,
    maxDelta: MAX_CASH_DELTA,
  });

  // ALREADY REVERSED IS A QUIET SUCCESS, NOT AN ERROR. This is the double-tap
  // and the dropped-connection retry, and both mean "the thing you wanted is
  // true". Throwing would push a caller into retrying, which is the one thing
  // that must not happen to money.
  if (verdict.code === "already_reversed") {
    return {
      ok: true,
      alreadyReversed: true,
      reversalTxnId: already?.reversalTxnId ?? null,
      reversedBy: already?.reversedBy ?? null,
      reversedAt: already?.reversedAt ?? null,
      reason: already?.reason ?? null,
    };
  }
  if (!verdict.allowed) {
    return { ok: false, code: verdict.code, reason: verdict.reason };
  }

  const original = found!.row;
  if (!student) {
    return {
      ok: false,
      code: "student_not_found",
      reason:
        "That transaction names a student who is not in the roster, so its counters " +
        "cannot be moved. Worth checking before anything else.",
    };
  }

  const delta = plannedCounterDelta(original);
  // The id is minted HERE. A browser-minted id would let a double-tap insert a
  // second row into the week document under a different id -- unionCashRows
  // dedupes by id, so it would have no way to notice -- before the unique
  // register read could refuse it.
  const reversalId = `txn_rev_${nowMs}_${txnId.slice(-8)}`;

  const reversalRow = buildReversalRow({
    original,
    reversalId,
    actorName: actor.name,
    actorId: actor.id,
    reason,
    nowIso,
    studentName: `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim(),
    studentGrade: String(student.grade ?? ""),
  });

  // 1. The register. Written FIRST so that if anything below throws, the whole
  //    transaction rolls back together and no partial state exists.
  await ctx.db.insert("cashReversals", {
    originalTxnId: txnId,
    reversalTxnId: reversalId,
    studentId: String(original.studentId ?? ""),
    weekKey: found!.weekKey,
    amount: -Number(original.amount),
    counterDelta: delta,
    reversedBy: actor.name,
    reversedByEmail: actor.email,
    reason,
    reversedAt: nowIso,
  });

  // 2. The ledger row, into the week the REVERSAL happened in -- not the
  //    original's week. A reversal is an event today; filing it under last
  //    week's document would make "what happened this week" wrong in both.
  const reversalWeek = cashWeekKey(nowIso);
  await ctx.db.insert("legacyMirror", {
    doc: "cash_tx_" + reversalWeek,
    collection: "transactions",
    key: reversalId,
    payload: reversalRow,
    mirroredAt: nowIso,
  });

  // 3. The counters, by delta. Read-modify-write inside this transaction, so
  //    it composes with appData:save's delta protocol rather than fighting it:
  //    a concurrent save states its own movement and the two add up.
  const patch: Record<string, number> = {};
  for (const [field, d] of Object.entries(delta)) {
    const base = Number(student[field]);
    patch[field] = (Number.isFinite(base) ? base : 0) + d;
  }
  await ctx.db.patch(student._id, patch);

  // 4. The audit entry, in the live table. Two actions exist so that
  //    wildcat-cashaudit.js's static per-action sign map renders the money with
  //    the right sign; see reversalAuditAction.
  const action = reversalAuditAction(original);
  const entryId = `audit_rev_${nowMs}_${txnId.slice(-8)}`;
  await ctx.db.insert("appAuditLog", {
    entryId,
    timestamp: nowIso,
    payload: {
      entryId,
      timestamp: nowIso,
      action,
      studentId: String(original.studentId ?? ""),
      studentName: reversalRow.studentName,
      teacher: actor.name,
      teacherId: actor.id,
      amount: Math.abs(Number(original.amount)),
      reason: `Reversed ${original.behaviorName || original.kind || "cash"}: ${reason}`,
      behavior: "Reversed: " + String(original.behaviorName || original.kind || "cash"),
      notes: reason,
    },
  });

  return {
    ok: true,
    alreadyReversed: false,
    reversalTxnId: reversalId,
    studentName: reversalRow.studentName,
    originalAmount: Number(original.amount),
    reversalAmount: -Number(original.amount),
    counterDelta: delta,
    balanceAfter: patch.wildcatCashBalance ?? null,
    auditAction: action,
    ledgerWeek: reversalWeek,
  };
}

/**
 * NO PUBLIC ENTRY POINT YET, DELIBERATELY.
 *
 * The admin-gated `reverse` mutation the button will call is not exported here
 * because nothing calls it yet, and convex-wiring.test.mjs is right to refuse
 * that: a public mutation that moves money and has no caller is attack surface
 * with no purpose, and its CLI_ONLY escape hatch exists so dead functions
 * cannot hide in it. It lands in the same deploy as the button: a `mutation`
 * named `reverse`, taking `originalTxnId` and `reason` only, whose handler
 * awaits requireAdmin(ctx) and hands the result to doReverse below as the
 * actor. ADMINS ONLY in that first increment. Not the teacher who made the
 * movement: a teacher who taps the wrong name needs it gone in seconds and
 * that case is real, but a teacher quietly withdrawing a deduction after a
 * parent complains is also real, and the owner should see how reversals get
 * used before 59 people have the button. Widening it later is a rule in
 * cashReversalRules.ts plus a duration, not a rewrite.
 */

/**
 * Reverse a transaction from the CLI or the Convex dashboard, which is how a
 * mistake reported today gets fixed before the button exists.
 *
 * `actorName` is required and recorded, so the row still says which human
 * asked for it rather than crediting the software. Internal, so no browser can
 * reach it at all.
 */
export const reverseAsAdmin = internalMutation({
  args: {
    originalTxnId: v.string(),
    reason: v.string(),
    actorName: v.string(),
    actorEmail: v.optional(v.string()),
    weekHint: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    return await doReverse(ctx, args, {
      name: args.actorName,
      id: "",
      email: String(args.actorEmail ?? ""),
    });
  },
});

/**
 * One student's reversible cash, newest first. Read-only.
 *
 * READS THE LEDGER, NOT THE STUDENT'S ARRAY. `distributeCashTransactions`
 * (script.js:29346) rebuilds that array from whatever ledger the saving tab
 * held, so it is a cache that lags -- measured on 2026-09-15 at 461 rows
 * against the ledger's 710. A Reverse button driven by the lagging copy would
 * silently not offer the rows it had lost.
 *
 * Each row carries its verdict, so the UI can show WHY something cannot be
 * reversed instead of hiding it. A greyed row reading "cancel this in the
 * Store instead" answers the question; a missing row invites a second attempt
 * at the workaround this feature exists to replace.
 */
export const reversibleFor = internalQuery({
  args: { studentId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { studentId, limit }) => {
    const nowMs = Date.now();
    const cutoff = await historyCutoffMs(ctx);
    const student = await findStudent(ctx, studentId);

    const from = cutoff === null ? nowMs - 60 * 86400000 : cutoff;
    const rows: Array<{ row: CashRow; weekKey: string }> = [];
    for (const week of weekKeysBetween(from, nowMs, MAX_WEEK_DOCS)) {
      const mirrored = await ctx.db
        .query("legacyMirror")
        .withIndex("by_doc_collection", (q: any) =>
          q.eq("doc", "cash_tx_" + week).eq("collection", "transactions"))
        .collect();
      for (const r of mirrored as any[]) {
        if (String(r.payload?.studentId ?? "") === studentId) {
          rows.push({ row: r.payload as CashRow, weekKey: week });
        }
      }
    }

    rows.sort((a, b) =>
      String(b.row.timestamp ?? "").localeCompare(String(a.row.timestamp ?? "")));
    const page = rows.slice(0, Math.max(1, Math.min(limit ?? 50, 200)));

    const out = [];
    for (const { row, weekKey } of page) {
      const already = await existingReversal(ctx, String(row.id ?? ""));
      const verdict = reversalVerdict({
        original: row,
        existingReversal: already,
        historyCutoffMs: cutoff,
        counters: student ?? undefined,
        maxDelta: MAX_CASH_DELTA,
      });
      out.push({
        txnId: String(row.id ?? ""),
        weekKey,
        timestamp: row.timestamp ?? null,
        amount: Number(row.amount),
        kind: row.kind ?? null,
        behaviorName: row.behaviorName ?? null,
        notes: row.notes ?? null,
        teacherName: row.teacherName ?? null,
        reversesTxnId: row.reversesTxnId ?? null,
        canReverse: verdict.allowed,
        why: verdict.allowed ? null : verdict.reason,
        code: verdict.code,
        reversal: already
          ? {
              at: already.reversedAt,
              by: already.reversedBy,
              reason: already.reason,
              txnId: already.reversalTxnId,
            }
          : null,
      });
    }
    return {
      studentId,
      studentName: student
        ? `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim()
        : null,
      balance: student?.wildcatCashBalance ?? null,
      ledgerRows: rows.length,
      returned: out.length,
      transactions: out,
    };
  },
});

/** Every reversal on record, newest first. Read-only, for the report. */
export const allReversals = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("cashReversals").collect();
    rows.sort((a, b) => String(b.reversedAt).localeCompare(String(a.reversedAt)));
    return {
      count: rows.length,
      reversals: rows.map((r) => ({
        at: r.reversedAt,
        by: r.reversedBy,
        student: r.studentId,
        amount: r.amount,
        reason: r.reason,
        original: r.originalTxnId,
        reversal: r.reversalTxnId,
        counterDelta: r.counterDelta,
      })),
    };
  },
});
