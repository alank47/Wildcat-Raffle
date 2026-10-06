import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin, requireStaff } from "./identity";
import { MAX_CASH_DELTA } from "./appDataShape";
import {
  buildReversalRow,
  cashWeekKey,
  ledgerSearchWeeks,
  plannedCounterDelta,
  readWeeksWithinBudget,
  reversalAuditAction,
  reversalVerdict,
  weekKeysNewestFirst,
  weekOfTxnId,
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

/**
 * WHAT THESE READS COST, AND THE LIMIT THEY ARE KEPT UNDER (2026-10-05).
 *
 * Convex stops one execution at 16 MiB of data read, 32,000 documents
 * scanned, 4,096 index ranges (db.get / db.query calls) or 8,192 array
 * elements. For this file the byte limit is the one that binds: legacyMirror
 * has no index on `payload.id` or `payload.studentId`, so every ledger read is
 * a whole week document (~1.3 MiB, ~2,200 rows a school week), and every
 * student row carries its whole cash-history copy. Measured that day, the
 * Reverse button and the reversible list read every week since 9/14 PLUS the
 * whole students table: about 7.4 of 16 MiB, growing ~2.1 MiB a school week,
 * so both would have started failing about the first week of November.
 *
 * Now: the student is one indexed read, a reversal reads at most three weeks
 * (usually one), and the list reads newest weeks first inside a byte budget
 * and says when it stopped short. The structural fix -- an index on the
 * ledger rows themselves -- is the next step, proven separately.
 */

/** The reversible list may span at most this many week documents, newest first. */
const MAX_WEEK_DOCS = 14;

/**
 * What the reversible list may read of the ledger, in estimated bytes (JSON
 * of each whole row, which measured within 1% of Convex's own count for
 * ledger rows on 2026-10-05). 12 of 16 MiB leaves room for the student row,
 * the register lookups and the +/-20% the estimate may be off by.
 */
const LIST_BYTE_BUDGET = 12 * 1048576;

/**
 * The largest a row is assumed to be when working out how many rows one read
 * may ask for. Measured: average 588 bytes, largest 1,056.
 */
const ROW_BYTES_CEILING = 1200;

/** What one reversal's search may read before it gives up and says so. */
const SEARCH_BYTE_BUDGET = 8 * 1048576;

/** The size of a row as Convex will roughly count it. */
function approxRowBytes(r: unknown): number {
  try { return JSON.stringify(r).length; } catch { return ROW_BYTES_CEILING; }
}

async function historyCutoffMs(ctx: any): Promise<number | null> {
  const row = await ctx.db
    .query("appState")
    .withIndex("by_key", (q: any) => q.eq("key", "historyCutoff"))
    .unique();
  const iso = (row?.value as Record<string, unknown> | undefined)?.iso;
  const parsed = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

type LedgerSearch =
  | { kind: "found"; row: CashRow; weekKey: string; docId: any }
  | { kind: "duplicate"; weeks: string[] }
  | { kind: "index_miss"; weeksSearched: string[]; idHasNoTime: boolean };

/**
 * Find one transaction in the ledger, and the week document holding it.
 *
 * legacyMirror is indexed by document name only -- there is no index on
 * `payload.id` -- so this reads candidate week documents and scans them. THE
 * CANDIDATES ARE BOUNDED, at most three (see ledgerSearchWeeks): the caller's
 * weekHint, the week the id's own milliseconds point at, and a neighbour only
 * when those milliseconds sit within an hour of a week boundary. Measured on
 * 2026-10-05, the id's week is the row's week for all 6,866 ids that carry a
 * time, so a reversal now reads ONE week where it read every week since the
 * cutoff, and the newest transactions are no longer the most expensive.
 *
 * A MISS IS SAID, NOT SEARCHED FOR. There is deliberately no "then scan every
 * week" fallback: that scan is the read that hits Convex's 16 MiB limit, and
 * a mistyped id or an id with no time in it (the 88 `txn_rb_` rows put back
 * by a repair script) would walk straight into it. Those come back as
 * `index_miss`, logged, and are reversed with their week as `weekHint`.
 *
 * TWO ROWS WITH ONE ID ARE REFUSED (`duplicate`). unique() would throw, and
 * first() would reverse one copy and leave the other standing -- the money
 * moves once while the ledger still shows the original. There were none on
 * 2026-10-05, inside or across weeks. EVERY PLANNED WEEK IS READ BEFORE
 * DECIDING (at most three, normally one), so a second copy in any of them is
 * seen: stopping at the first hit let a weekHint naming another week reverse
 * a copy filed there -- another child's counters -- without ever reading the
 * id's own week. A copy filed in a week outside the plan is still outside a
 * bounded search; the ledger index (the next step) is what will see that.
 */
async function findLedgerRow(
  ctx: any,
  txnId: string,
  weekHint?: string | null,
): Promise<LedgerSearch> {
  const plan = ledgerSearchWeeks(txnId, weekHint);
  const searched: string[] = [];
  let bytes = 0;
  let hit: { row: any; weekKey: string } | null = null;
  const copyWeeks: string[] = [];
  for (const week of plan.weeks) {
    if (bytes > SEARCH_BYTE_BUDGET) break;
    const rows = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc_collection", (q: any) =>
        q.eq("doc", "cash_tx_" + week).eq("collection", "transactions"))
      .collect();
    searched.push(week);
    for (const r of rows as any[]) {
      bytes += approxRowBytes(r);
      if (String(r.payload?.id ?? "") !== txnId) continue;
      copyWeeks.push(week);
      if (!hit) hit = { row: r, weekKey: week };
    }
  }
  if (copyWeeks.length > 1) return { kind: "duplicate", weeks: [...new Set(copyWeeks)] };
  if (hit) return { kind: "found", row: hit.row.payload as CashRow, weekKey: hit.weekKey, docId: hit.row._id };
  const idHasNoTime = plan.guessed === null;
  // A LOG LINE, so a miss is visible in the Convex logs without anyone having
  // been told about it. The id is not personal data; nothing else is printed.
  console.warn(
    `[cashReversal] index_miss: ${txnId} is not in ` +
    (searched.length ? searched.join(", ") : "any week") +
    (idHasNoTime ? " (its id carries no time" + (plan.hint ? "" : " and no weekHint was given") + ")" : ""));
  return { kind: "index_miss", weeksSearched: searched, idHasNoTime };
}

/**
 * The student row a ledger studentId names, BY INDEX (2026-10-05).
 *
 * This used to collect() every student row and .find() one. Every student row
 * carries its whole cash-history copy, so that one line read 3.2 MiB (Convex's
 * own count, 2026-10-05) -- nearly half of the reversal path's bytes -- and
 * grew ~0.86 MiB every school week.
 *
 * THE SAME CHILD THE SCAN FOUND, NOT A WIDER NET. The scan matched
 * `legacyId ?? _id` or `_id`; this is by_legacyId, then the `_id` form through
 * normalizeId + get. The by_studentNumber fallback cashAward and cashRecount
 * use is deliberately NOT added: the scan never matched on studentNumber, and
 * a fallback that changes nothing today (all 763 have legacyId equal to their
 * studentNumber, none duplicated) is exactly the kind that goes unnoticed on
 * the day it starts to matter.
 *
 * TWO STUDENTS WITH ONE legacyId are `ambiguous`, never resolved: the scan
 * took whichever came first in table order, and for money that is a coin toss.
 */
async function findStudent(
  ctx: any,
  studentId: string,
): Promise<{ student: any | null; ambiguous: boolean }> {
  if (!studentId) return { student: null, ambiguous: false };
  const byLegacy = await ctx.db
    .query("students")
    .withIndex("by_legacyId", (q: any) => q.eq("legacyId", studentId))
    .take(2);
  if (byLegacy.length > 1) return { student: null, ambiguous: true };
  if (byLegacy.length === 1) return { student: byLegacy[0], ambiguous: false };
  const id = ctx.db.normalizeId("students", studentId);
  const byId = id ? await ctx.db.get(id) : null;
  return { student: byId ?? null, ambiguous: false };
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
  const search = already ? null : await findLedgerRow(ctx, txnId, args.weekHint);

  // Both refusals sit exactly where "not found" always did: after the
  // already-reversed check, which must stay first because it is the
  // double-tap's quiet success, and before anything moves.
  if (search?.kind === "duplicate") {
    return {
      ok: false,
      code: "duplicate_txn_id",
      reason:
        `Two rows in the ${search.weeks.join(" and ")} ledger carry this transaction's id, so reversing ` +
        "one would leave the other standing. Nothing was changed; it has to be looked at by hand.",
    };
  }
  if (search?.kind === "index_miss") {
    return {
      ok: false,
      code: "index_miss",
      weeksSearched: search.weeksSearched,
      reason: search.idHasNoTime
        ? "This transaction's id carries no date (it was put back by a repair), so the server " +
          "cannot tell which week holds it. A developer can reverse it with its week " +
          "(cashReversal:reverseAsAdmin with weekHint, shown on each row of the reversible list)."
        : "That transaction is not in the cash ledger for the week its id points to (" +
          search.weeksSearched.join(", ") + "). It may never have reached the server, " +
          "or the id may be mistyped.",
    };
  }
  const found = search?.kind === "found" ? search : null;

  const lookup = found ? await findStudent(ctx, String(found.row.studentId ?? "")) : null;
  const student = lookup?.student ?? null;

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
  if (!student && lookup?.ambiguous) {
    return {
      ok: false,
      code: "student_ambiguous",
      reason:
        "Two student records carry the id this transaction names, so there is no way to " +
        "know whose counters to move. Nothing was changed; worth checking the roster.",
    };
  }
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

/**
 * The shared listing body, so the public and internal views cannot drift.
 *
 * NEWEST WEEKS FIRST, INSIDE A BYTE BUDGET (2026-10-05). It reads the weeks
 * since the cutoff newest first, at most fourteen, and stops before a week
 * that would carry it past LIST_BYTE_BUDGET. Today that is every week (about
 * 3.9 MiB); the budget is what turns the day the ledger outgrows one read
 * into a shorter list that SAYS it is shorter, instead of an error.
 *
 * `ledgerRows` KEEPS ITS MEANING: every row this student has since the
 * cutoff. The panel prints it as the true total (script.js, "THE TRUE TOTAL,
 * not the page size") because a capped count was once shown as a child's
 * whole ledger. So when the read did not cover every week since the cutoff,
 * `ledgerRows` is never the bare short count: it is the words "at least N"
 * (a string), `complete` is false and `more` is true. The live panel prints
 * it as-is -- "at least 812 ledger rows" -- and, because a string is never
 * `> rows.length`, never adds "showing the newest". (It was null until
 * 2026-10-05's review, which the panel printed as "null ledger rows".)
 * `ledgerRowsRead` stays the plain number for anything that wants one.
 *
 * A ROW THE SERVER WILL REFUSE IS NOT OFFERED. Every reason `reverse` would
 * refuse a row that this list can see is checked here too, so the Reverse
 * button never appears on a row it will always fail: the verdict, two ledger
 * rows carrying one id (any week this read), a student id that names no
 * student or two, and an id the button cannot find (see `hintless` below).
 */
async function listReversible(ctx: any, studentId: string, limit?: number) {
  {
    const nowMs = Date.now();
    const cutoff = await historyCutoffMs(ctx);
    const { student, ambiguous } = await findStudent(ctx, studentId);

    const from = cutoff === null ? nowMs - 60 * 86400000 : cutoff;
    const weeks = weekKeysNewestFirst(from, nowMs, MAX_WEEK_DOCS);
    // Fourteen weeks back from now may stop short of the cutoff's week; from
    // then on the oldest weeks are outside the list, and it says so. (A cutoff
    // set in the future leaves nothing before it to miss.)
    const reachesCutoff = from > nowMs ||
      weeks.includes(cashWeekKey(new Date(from).toISOString()));
    const idCopies = new Map<string, number>();
    const read = await readWeeksWithinBudget<any>({
      weeks,
      read: (week, maxRows) => ctx.db
        .query("legacyMirror")
        .withIndex("by_doc_collection", (q: any) =>
          q.eq("doc", "cash_tx_" + week).eq("collection", "transactions"))
        .take(maxRows),
      sizeOf: approxRowBytes,
      keep: (r) => {
        // Every row of every week read is counted by id, this child's or not:
        // `reverse` refuses an id two rows carry, whoever they belong to.
        const id = String(r.payload?.id ?? "");
        if (id) idCopies.set(id, (idCopies.get(id) ?? 0) + 1);
        return String(r.payload?.studentId ?? "") === studentId;
      },
      byteBudget: LIST_BYTE_BUDGET,
      rowBytesCeiling: ROW_BYTES_CEILING,
    });
    const complete = read.stoppedAt === null && reachesCutoff;
    if (!complete) {
      console.warn(
        `[cashReversal] reversible list incomplete: read ${read.weeksRead.length} of ` +
        `${weeks.length} weeks (${(read.bytes / 1048576).toFixed(1)} MiB)` +
        (read.stoppedAt ? `, stopped before ${read.stoppedAt}` : "") +
        (reachesCutoff ? "" : ", window ends before the cutoff week"));
    }
    const rows: Array<{ row: CashRow; weekKey: string }> = read.rows.map(
      ({ row, week }) => ({ row: row.payload as CashRow, weekKey: week }));

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
      // A ROW THE BUTTON CANNOT FIND IS NOT OFFERED. The live panel sends
      // `reverse` the id alone, so the search reads only the weeks the id
      // itself points at (ledgerSearchWeeks with no hint). An id with no time
      // in it (a `txn_rb_` row a repair put back) points nowhere, and an id
      // whose time names another week points at the wrong place -- either
      // way its Reverse button would always fail. Greyed with the reason
      // instead, and the week a developer needs is in the words.
      const hintless = !ledgerSearchWeeks(row.id).weeks.includes(weekKey);
      const id = String(row.id ?? "");
      const blocked: { code: string; why: string } | null = !verdict.allowed ? null
        : (idCopies.get(id) ?? 0) > 1
          ? { code: "duplicate_txn_id",
              why: "Two ledger rows carry this transaction's id, so reversing one would leave the " +
                   "other standing. It has to be looked at by hand." }
        : !student
          ? (ambiguous
              ? { code: "student_ambiguous",
                  why: "Two student records carry this id, so there is no way to know whose " +
                       "counters to move. Worth checking the roster." }
              : { code: "student_not_found",
                  why: "No student record carries this id, so there are no counters to move." })
        : hintless
          ? { code: "needs_week_hint",
              why: (weekOfTxnId(row.id) === null
                ? "Put back by a repair, so its id carries no date the Reverse button can use. "
                : "Its id points at a different week from the one it is filed in, so the Reverse button cannot find it. ") +
                `A developer can reverse it (week ${weekKey}).` }
        : null;
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
        canReverse: verdict.allowed && !blocked,
        why: blocked ? blocked.why : verdict.allowed ? null : verdict.reason,
        code: blocked ? blocked.code : verdict.code,
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
    // AN INCOMPLETE LIST WITH NOTHING IN IT IS NOT "NO CASH MOVEMENTS". Once
    // the byte budget leaves the oldest weeks out, a child whose only rows sit
    // in those weeks gets nothing back, and the live panel (script.js
    // showStudentCashReversal) prints "No cash movements on the ledger for
    // this student" over a ledger that has some. One greyed row says what was
    // not read instead. amount null renders as a dash; canReverse false means
    // no button. It is not counted in `returned` or `ledgerRowsRead`.
    const returned = out.length;
    if (!complete && out.length === 0) {
      const oldest = read.weeksRead.length ? read.weeksRead[read.weeksRead.length - 1] : null;
      out.push({
        txnId: "",
        weekKey: oldest ?? "",
        timestamp: null,
        amount: null as unknown as number,
        kind: null,
        behaviorName: "Older weeks not shown",
        notes: null,
        teacherName: null,
        reversesTxnId: null,
        canReverse: false,
        why: `This list only reads the newest ${read.weeksRead.length} week(s)` +
          (oldest ? `, back to week ${oldest}` : "") +
          ". This student's movements are older than that. A developer can look them up and reverse one.",
        code: "older_weeks_not_read",
        reversal: null,
      });
    }
    return {
      studentId,
      studentName: student
        ? `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim()
        : null,
      balance: student?.wildcatCashBalance ?? null,
      // The TRUE total, or "at least N" in words. See the note above the function.
      ledgerRows: complete ? rows.length : `at least ${rows.length}`,
      returned,
      complete,
      more: !complete || rows.length > out.length,
      // What was read, for a person or a later client: a lower bound when
      // `complete` is false.
      ledgerRowsRead: rows.length,
      weeksRead: read.weeksRead.length,
      oldestWeekRead: read.weeksRead.length ? read.weeksRead[read.weeksRead.length - 1] : null,
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
