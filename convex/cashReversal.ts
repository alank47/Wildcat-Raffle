import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin, requireStaff } from "./identity";
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
    // NO `key`. loadDoc decides a collection's shape with
  // `slice.some(r => typeof r.key === "string")` and builds the map from keyed
  // rows ONLY -- so one keyed row in an unkeyed collection makes every other
  // row vanish from what the client loads. mergeSlice's own comment says it:
  // "Mixing the two loses rows silently."
  //
  // Inserting with a key here put 1,485 cash rows and 4 receipts behind a
  // two-entry map on 2026-09-16. Staff tabs loaded a near-empty ledger,
  // distributeCashTransactions rebuilt all 620 student histories from it, and
  // the arrays fell to single digits -- which I diagnosed twice and guarded
  // twice without ever asking why the ledger was short. The Receipts screen
  // then threw outright: an array had become an object.
  await ctx.db.insert("legacyMirror", {
    doc: "cash_tx_" + reversalWeek,
    collection: "transactions",
    payload: reversalRow,
    mirroredAt: nowIso,
  });

  // 3. THE STUDENT'S OWN COPY OF THE ROW, because a child reads that one.
  //
  // views_app.ts `myStudentView` builds the wallet's recent-activity card from
  // `student.wildcatCashTransactions` -- the stored array, server-side. The
  // client rebuilds that array from the ledger on every load
  // (distributeCashTransactions, script.js:29346), but the SERVER never does,
  // so without this the reversal would not reach a child's phone until some
  // staff tab happened to load and save. Until then their wallet would show
  // the cancelled award, with a balance that no longer matched it.
  //
  // Appended, not replaced: the array is whole-value and this is inside the
  // same transaction as everything else.
  const storedHistory = Array.isArray(student.wildcatCashTransactions)
    ? student.wildcatCashTransactions
    : [];
  const alreadyThere = storedHistory.some((r: any) => String(r?.id ?? "") === reversalId);

  // 4. The counters, by delta. Read-modify-write inside this transaction, so
  //    it composes with appData:save's delta protocol rather than fighting it:
  //    a concurrent save states its own movement and the two add up.
  const patch: Record<string, any> = {};
  for (const [field, d] of Object.entries(delta)) {
    const base = Number(student[field]);
    patch[field] = (Number.isFinite(base) ? base : 0) + d;
  }
  if (!alreadyThere) patch.wildcatCashTransactions = [...storedHistory, reversalRow];
  await ctx.db.patch(student._id, patch);

  // 5. The audit entry, in the live table. Two actions exist so that
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
      // `ticketCount`, NOT `amount`, AND THAT IS NOT A TYPO.
      //
      // WildcatCashAudit.describe() reads the money off `e.ticketCount`
      // (wildcat-cashaudit.js:105) because that is the field addToAuditLog
      // writes (script.js:7816) -- the name is a fossil from the raffle, where
      // every audit entry counted tickets. Writing `amount` instead left
      // describe() with null, `signed` null, and an em dash on all four cash
      // audit surfaces: the Cash Audit Log's Amount column, the per-student
      // history dialog, the Accounts card's Recent Activity, and the dashboard
      // feed. A row reading "Reversed (taken back)" that declines to say by how
      // much, directly under a totals strip that does say -- which is exactly
      // the parent question this feature exists to be able to answer.
      //
      // Both are written: `amount` because it is the honest name and new
      // readers will reach for it, `ticketCount` because eleven existing ones
      // already do.
      ticketCount: Math.abs(Number(original.amount)),
      amount: Math.abs(Number(original.amount)),
      // Without this the Audit Log's Category cell renders "n/a".
      category: "Wildcat Cash",
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
 * Reverse a transaction. ADMINS ONLY.
 *
 * Not the teacher who made the movement, in this first increment. A teacher who
 * taps the wrong name needs it gone in seconds and that case is real -- but a
 * teacher quietly withdrawing a deduction after a parent complains is also
 * real, and the owner should see how reversals get used before 59 people have
 * the button. Widening it later is a rule in cashReversalRules.ts plus a
 * duration, not a rewrite.
 */
export const reverse = mutation({
  args: {
    originalTxnId: v.string(),
    reason: v.string(),
    weekHint: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    return await doReverse(ctx, args, {
      name: String(admin.name ?? "Unknown"),
      id: String(admin.legacyId ?? admin._id ?? ""),
      email: String(admin.email ?? ""),
    });
  },
});

/** One student's reversible cash, for the panel. Staff-gated, read-only. */
export const reversibleForStudent = query({
  args: { studentId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireStaff(ctx);
    return await listReversible(ctx, args.studentId, args.limit);
  },
});

/**
 * THE CLI VARIANTS BELOW STAY. They were the only way in before the button
 * existed and they are how a reversal gets done from the dashboard when the
 * front end is broken -- which, on a launch week, is a state worth being able
 * to work from.
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
  handler: async (ctx, { studentId, limit }) => await listReversible(ctx, studentId, limit),
});

/** The shared listing body, so the public and internal views cannot drift. */
async function listReversible(ctx: any, studentId: string, limit?: number) {
  {
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
  }
}

/**
 * Repair reversal audit entries written before the ticketCount fix.
 *
 * Tonight's first real reversal went out with the money in `amount` only, so
 * every cash audit surface rendered an em dash for it. This copies it into
 * `ticketCount` and adds the missing `category`. Idempotent: an entry that
 * already has a finite ticketCount is left alone.
 */
export const repairReversalAuditAmounts = internalMutation({
  args: { apply: v.optional(v.boolean()) },
  handler: async (ctx, { apply }) => {
    const rows = await ctx.db.query("appAuditLog").collect();
    const doomed = (rows as any[]).filter((r) => {
      const a = String(r.payload?.action ?? "");
      if (a !== "cash_reversal_credit" && a !== "cash_reversal_debit") return false;
      return !Number.isFinite(Number(r.payload?.ticketCount));
    });
    if (apply === true) {
      for (const r of doomed) {
        await ctx.db.patch(r._id, {
          payload: {
            ...r.payload,
            ticketCount: Math.abs(Number(r.payload?.amount) || 0),
            category: r.payload?.category ?? "Wildcat Cash",
          },
        });
      }
    }
    return {
      applied: apply === true,
      repaired: doomed.length,
      entries: doomed.map((r) => ({
        entryId: r.entryId,
        action: r.payload?.action,
        amount: r.payload?.amount ?? null,
        student: r.payload?.studentName ?? null,
      })),
      note: apply === true ? "Patched." : "Dry run. Pass apply: true.",
    };
  },
});

/**
 * Put reversal rows onto the student records that predate the fix.
 *
 * The first real reversal (2026-09-15) wrote the ledger, the register, the
 * counters and the audit entry, but not `student.wildcatCashTransactions` --
 * and views_app.ts builds a CHILD'S wallet from that stored array. So their
 * phone showed the cancelled award with a balance that no longer matched it.
 * Idempotent: a row already present by id is left alone.
 */
export const repairStudentReversalRows = internalMutation({
  args: { apply: v.optional(v.boolean()) },
  handler: async (ctx, { apply }) => {
    const registers = await ctx.db.query("cashReversals").collect();
    const mirror = await ctx.db.query("legacyMirror").withIndex("by_doc").collect();
    const ledgerById = new Map<string, any>();
    for (const r of (mirror as any[]).filter((x) => String(x.doc ?? "").startsWith("cash_tx_"))) {
      const id = String((r.payload as any)?.id ?? "");
      if (id) ledgerById.set(id, r.payload);
    }

    const students = await ctx.db.query("students").collect();
    const fixes: any[] = [];
    for (const reg of registers as any[]) {
      const row = ledgerById.get(String(reg.reversalTxnId));
      if (!row) continue;
      const student = (students as any[]).find(
        (st) => String(st.legacyId ?? st._id) === String(reg.studentId));
      if (!student) continue;
      const arr = Array.isArray(student.wildcatCashTransactions)
        ? student.wildcatCashTransactions : [];
      if (arr.some((t: any) => String(t?.id ?? "") === String(reg.reversalTxnId))) continue;
      fixes.push({
        id: student._id,
        name: `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim(),
        reversalTxnId: reg.reversalTxnId,
        next: [...arr, row],
      });
    }

    if (apply === true) {
      for (const f of fixes) {
        await ctx.db.patch(f.id, { wildcatCashTransactions: f.next });
      }
    }
    return {
      applied: apply === true,
      reversalsOnRecord: registers.length,
      studentsMissingTheRow: fixes.length,
      students: fixes.map((f) => ({ name: f.name, reversalTxnId: f.reversalTxnId, rowsAfter: f.next.length })),
      note: apply === true ? "Patched." : "Dry run. Pass apply: true.",
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
