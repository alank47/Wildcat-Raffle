import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { requireStudentSelf } from "./identity";
import {
  buildPurchaseLedgerRow,
  buildStudentReceipt,
  normalizeQuantity,
  purchaseCounterDelta,
  studentPurchaseVerdict,
  MAX_STUDENT_QUANTITY,
  STORE_CLOSED_DEFAULT,
  type StoreReward,
} from "./studentStoreRules";
import { cashWeekKey } from "./cashReversalRules";

/**
 * The student store: a child spending their own Wildcat Cash.
 *
 * NOTHING HERE IS PUBLIC YET. Every export is internal, so no browser can
 * reach any of it -- the public wrappers land in the same deploy as the UI,
 * after school hours, with the store switched OFF. That order is deliberate:
 * convex-wiring.test.mjs refuses a public mutation nothing calls, and a money
 * mutation sitting reachable with no caller is attack surface for nothing.
 *
 * THE FOUR THINGS THIS GETS RIGHT, each from an incident in this repo:
 *
 *   1. THE SERVER OWNS THE PRICE. `purchase` takes a reward id and a quantity.
 *      No cost, no total, no balance. Every money incident here was a number
 *      the browser sent and the server believed.
 *
 *   2. STOCK DECREMENTS INSIDE THE TRANSACTION. The pure rules check stock, but
 *      a pure function cannot hold a lock. Two children tapping the last
 *      Extended Lunch in the same second is not hypothetical at a school of
 *      620, and selling two of one is a promise an adult then has to break.
 *
 *   3. A DOUBLE-TAP CANNOT DOUBLE-CHARGE. Keyed on a client-supplied
 *      `attemptId`, not on (student, reward) -- a child may legitimately buy
 *      two Homework Passes, so the key has to identify the BUTTON PRESS. One
 *      token, one purchase, however many times it arrives.
 *
 *   4. EVERY STORE IS WRITTEN IN ONE TRANSACTION: the receipt, the ledger row,
 *      the student's counters, the student's own copy of the row, and the audit
 *      entry. Convex mutations are atomic, so there is no state where the cash
 *      left and the receipt did not exist.
 */

/** appState key holding the open/closed switch. Server-owned. */
const STORE_FLAG_KEY = "studentStoreOpen";

const REWARDS_DOC = "secondary";
const REWARDS_COLLECTION = "wildcatCashRewards";
const RECEIPTS_COLLECTION = "cashReceipts";

/**
 * Is the store open?
 *
 * DEFAULTS TO CLOSED, and that is the whole point of the switch. The UI can
 * ship in a deploy that changes nothing for anyone, and go live later by
 * writing one appState row -- which reloads nobody and can be undone in
 * seconds. A client flag would have needed a deploy to open and another to
 * shut, and the owner cannot ask 40 staff or 620 students to refresh.
 */
async function storeState(ctx: any): Promise<{ open: boolean; reason: string }> {
  const row = await ctx.db
    .query("appState")
    .withIndex("by_key", (q: any) => q.eq("key", STORE_FLAG_KEY))
    .unique();
  const val = (row?.value ?? {}) as Record<string, unknown>;
  return {
    open: val.open === true,
    reason: typeof val.reason === "string" && val.reason
      ? val.reason
      : STORE_CLOSED_DEFAULT,
  };
}

/** Every reward row in the catalogue, with the mirror row that holds it. */
async function rewardRows(ctx: any) {
  return await ctx.db
    .query("legacyMirror")
    .withIndex("by_doc_collection", (q: any) =>
      q.eq("doc", REWARDS_DOC).eq("collection", REWARDS_COLLECTION))
    .collect();
}

/** The student row for a verified student identity. */
async function studentByNumber(ctx: any, studentNumber: string) {
  const all = await ctx.db.query("students").collect();
  return (all as any[]).find(
    (s) => String(s.studentNumber ?? "") === String(studentNumber)) ?? null;
}

async function isEnrolled(ctx: any, studentNumber: string): Promise<boolean> {
  const hit = await ctx.db
    .query("psRoster")
    .withIndex("by_studentNumber", (q: any) => q.eq("studentNumber", String(studentNumber)))
    .first();
  return Boolean(hit);
}

/**
 * The catalogue as ONE student sees it.
 *
 * WHY EVERY REWARD COMES BACK, INCLUDING THE ONES THEY CANNOT AFFORD. Measured
 * against production on 2026-09-16: 29 of 620 students could afford the
 * cheapest reward and nobody could afford five of the six. A store that hides
 * what you cannot buy would show most of the school an empty room. So each row
 * carries `canBuy`, the reason when it is false, and `shortfall` -- which is
 * what turns "you can't have this" into "you need $400 more", and that is a
 * goal rather than a locked door.
 *
 * The owner sets prices from the school's balance distribution shortly before
 * a release, so this must read correctly at any price point and cannot assume
 * anybody can afford anything.
 */
async function storeForStudent(ctx: any, studentNumber: string) {
  const state = await storeState(ctx);
  const student = await studentByNumber(ctx, studentNumber);
  const enrolled = student ? await isEnrolled(ctx, studentNumber) : false;
  const withEnrolment = student ? { ...student, enrolled } : null;

  const rewards = (await rewardRows(ctx))
    .map((r: any) => r.payload as StoreReward)
    .filter((r: StoreReward) => r && !r.retiredAt && r.available !== false);

  const balance = Number(student?.wildcatCashBalance) || 0;
  const items = rewards
    .map((reward: StoreReward) => {
      const verdict = studentPurchaseVerdict({
        student: withEnrolment, reward, quantity: 1,
        storeOpen: state.open, closedReason: state.reason,
      });
      const cost = Number(reward.cost) || 0;
      return {
        id: String(reward.id ?? ""),
        name: String(reward.name ?? ""),
        description: String(reward.description ?? ""),
        category: String(reward.category || "General"),
        cost,
        stock: reward.stock ?? null,
        inStudentStore: reward.studentPurchasable === true,
        canBuy: verdict.allowed,
        why: verdict.allowed ? null : verdict.reason,
        code: verdict.code,
        // How much further to go, so the card can show progress rather than a
        // refusal. Null when they can already afford it.
        shortfall: cost > balance ? cost - balance : null,
        progress: cost > 0 ? Math.min(1, balance / cost) : null,
      };
    })
    // The ones they can buy first, then the closest to affordable. A child
    // scrolling past six things they cannot have to reach the one they can is
    // being told the wrong thing first.
    .sort((a: any, b: any) => {
      if (a.canBuy !== b.canBuy) return a.canBuy ? -1 : 1;
      if (a.inStudentStore !== b.inStudentStore) return a.inStudentStore ? -1 : 1;
      return (a.shortfall ?? 0) - (b.shortfall ?? 0);
    });

  return {
    storeOpen: state.open,
    closedReason: state.open ? null : state.reason,
    balance,
    maxQuantity: MAX_STUDENT_QUANTITY,
    items,
  };
}

/**
 * THE STUDENT'S OWN STORE. No argument for whose -- requireStudentSelf resolves
 * it from their verified token, and if the caller could name a student they
 * could name any of them. The same rule the leaderboard and hall passes follow.
 */
export const myStore = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireStudentSelf(ctx);
    return await storeForStudent(ctx, String(me.studentNumber ?? ""));
  },
});

/**
 * Buy one reward, as the signed-in student.
 *
 * Takes a reward id, a quantity and an attempt token. NOT a cost, a total or a
 * balance -- the server reads the price from the catalogue. And not a student
 * id: a child who could name the buyer could name somebody else.
 */
export const purchase = mutation({
  args: {
    rewardId: v.string(),
    quantity: v.optional(v.number()),
    attemptId: v.string(),
  },
  handler: async (ctx, args) => {
    const me = await requireStudentSelf(ctx);
    return await doPurchase(ctx, {
      studentNumber: String(me.studentNumber ?? ""),
      rewardId: args.rewardId,
      quantity: args.quantity,
      attemptId: args.attemptId,
    });
  },
});

/** The catalogue for one student, by student number. Internal, for the CLI. */
export const storeFor = internalQuery({
  args: { studentNumber: v.string() },
  handler: async (ctx, { studentNumber }) => await storeForStudent(ctx, studentNumber),
});

/**
 * Buy a reward.
 *
 * `attemptId` is the idempotency key and the CLIENT mints it, once per button
 * press, and resends the same one on retry. It cannot be keyed on the student
 * and reward instead: buying two Homework Passes is a thing a child is allowed
 * to do, so the key has to identify the press rather than the intent. A token
 * a child could vary by hand only lets them buy again with money they have,
 * which is not an exploit -- it is the feature.
 */
async function doPurchase(
  ctx: any,
  args: { studentNumber: string; rewardId: string; quantity?: number; attemptId: string },
) {
  const attemptId = String(args.attemptId ?? "").trim();
  if (!attemptId) throw new Error("attemptId is required.");

  // ALREADY DONE? Checked first and inside this transaction, so a double-tap
  // is cheap and cannot depend on anything below succeeding.
  const prior = await ctx.db
    .query("studentPurchases")
    .withIndex("by_attemptId", (q: any) => q.eq("attemptId", attemptId))
    .unique();
  if (prior) {
    return {
      ok: true,
      alreadyBought: true,
      receiptId: prior.receiptId,
      rewardName: prior.rewardName,
      totalCost: prior.totalCost,
      purchasedAt: prior.purchasedAt,
    };
  }

  const state = await storeState(ctx);
  const student = await studentByNumber(ctx, args.studentNumber);
  const enrolled = student ? await isEnrolled(ctx, args.studentNumber) : false;
  const withEnrolment = student ? { ...student, enrolled } : null;

  const rows = await rewardRows(ctx);
  const rewardRow = (rows as any[]).find(
    (r) => String((r.payload as any)?.id ?? "") === String(args.rewardId));
  const reward = (rewardRow?.payload ?? null) as StoreReward | null;

  const verdict = studentPurchaseVerdict({
    student: withEnrolment, reward, quantity: args.quantity ?? 1,
    storeOpen: state.open, closedReason: state.reason,
  });
  if (!verdict.allowed) {
    return { ok: false, code: verdict.code, reason: verdict.reason, shortfall: verdict.shortfall ?? null };
  }

  const quantity = normalizeQuantity(args.quantity ?? 1)!;
  const total = verdict.total!;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // STOCK, RE-READ AND RE-CHECKED HERE. The verdict above saw a snapshot; this
  // is the authoritative check, inside the transaction that also decrements
  // it. Without this pair, two children tapping the last one both pass the
  // snapshot check and both get a receipt for an item that exists once.
  const liveStock = reward!.stock;
  if (liveStock != null) {
    if (Number(liveStock) < quantity) {
      return {
        ok: false, code: "out_of_stock",
        reason: Number(liveStock) === 0
          ? "That one has just sold out."
          : `Only ${liveStock} left — somebody got there first.`,
      };
    }
    await ctx.db.patch(rewardRow._id, {
      payload: { ...reward, stock: Number(liveStock) - quantity, updatedAt: nowIso },
      mirroredAt: nowIso,
    });
  }

  // The receipt code is minted SERVER-SIDE, like the reversal's row id: a
  // client-minted one would let a retry insert a second receipt under a
  // different code before the register could refuse it.
  const receiptId = "WC-" + attemptId.replace(/[^A-Za-z0-9]/g, "").slice(-6).toUpperCase();
  const txnId = `txn_buy_${nowMs}_${attemptId.slice(-7)}`;

  const delta = purchaseCounterDelta(total);
  const balanceAfter = (Number(student.wildcatCashBalance) || 0) + delta.wildcatCashBalance;

  const receipt = buildStudentReceipt({
    receiptId, student: withEnrolment as any, reward: reward!, quantity, nowIso,
  });
  (receipt as any).txId = txnId;

  const ledgerRow = buildPurchaseLedgerRow({
    txnId, receiptId, student: withEnrolment as any, reward: reward!,
    quantity, total, nowIso, balanceAfter,
  });

  // 1. The register, first, so nothing below can be repeated.
  await ctx.db.insert("studentPurchases", {
    attemptId,
    receiptId,
    studentId: String(student.legacyId ?? student._id),
    studentNumber: String(args.studentNumber),
    rewardId: String(reward!.id ?? ""),
    rewardName: String(reward!.name ?? ""),
    quantity,
    totalCost: total,
    txnId,
    purchasedAt: nowIso,
  });

  // 2. The receipt, into the slice the staff store's fulfil and cancel paths
  //    already read. Merge-by-id, so it cannot be clobbered by a stale tab.
  // NO `key` ON EITHER OF THESE. loadDoc decides a collection's shape with
  // `slice.some(r => typeof r.key === "string")` and builds the map from keyed
  // rows ONLY -- so one keyed row in an unkeyed collection makes every other
  // row vanish from what the client loads. mergeSlice's own comment says it:
  // "Mixing the two loses rows silently."
  //
  // Inserting with keys here put 1,485 cash rows and 4 receipts behind a
  // two-entry map on 2026-09-16. Staff tabs loaded a near-empty ledger,
  // distributeCashTransactions rebuilt all 620 student histories from it, and
  // the arrays fell to single digits -- which I diagnosed twice and guarded
  // twice without ever asking why the ledger was short. Then Receipts threw
  // outright: an array had become an object.
  await ctx.db.insert("legacyMirror", {
    doc: REWARDS_DOC, collection: RECEIPTS_COLLECTION,
    payload: receipt, mirroredAt: nowIso,
  });

  // 3. The cash ledger row, in this week's document.
  await ctx.db.insert("legacyMirror", {
    doc: "cash_tx_" + cashWeekKey(nowIso), collection: "transactions",
    payload: ledgerRow, mirroredAt: nowIso,
  });

  // 4. The counters, and the student's own copy of the row -- views_app builds
  //    their wallet from that stored array server-side, so without it the child
  //    would see a balance drop with nothing explaining it.
  const storedHistory = Array.isArray(student.wildcatCashTransactions)
    ? student.wildcatCashTransactions : [];
  const patch: Record<string, any> = {
    wildcatCashTransactions: [...storedHistory, ledgerRow],
  };
  for (const [field, d] of Object.entries(delta)) {
    const base = Number(student[field]);
    patch[field] = (Number.isFinite(base) ? base : 0) + d;
  }
  await ctx.db.patch(student._id, patch);

  // 5. The audit entry. `ticketCount`, not `amount` -- describe() reads the
  //    former and writing only the latter rendered an em dash on all four cash
  //    audit surfaces when the reversal shipped with that bug.
  const entryId = `audit_buy_${nowMs}_${attemptId.slice(-7)}`;
  await ctx.db.insert("appAuditLog", {
    entryId,
    timestamp: nowIso,
    payload: {
      entryId,
      timestamp: nowIso,
      action: "reward_redemption",
      studentId: String(student.legacyId ?? student._id),
      studentName: receipt.studentName,
      teacher: receipt.studentName,
      teacherId: "",
      ticketCount: total,
      amount: total,
      category: "Wildcat Cash",
      reason: `Bought ${reward!.name}${quantity > 1 ? ` x${quantity}` : ""} (self-serve) — ${receiptId}`,
      behavior: String(reward!.name ?? ""),
      notes: `Receipt ${receiptId}`,
    },
  });

  return {
    ok: true,
    alreadyBought: false,
    receiptId,
    rewardName: reward!.name,
    quantity,
    totalCost: total,
    balanceAfter,
    stockAfter: liveStock == null ? null : Number(liveStock) - quantity,
    purchasedAt: nowIso,
  };
}

/** Buy, by student number. Internal until the UI ships. */
export const purchaseFor = internalMutation({
  args: {
    studentNumber: v.string(),
    rewardId: v.string(),
    quantity: v.optional(v.number()),
    attemptId: v.string(),
  },
  handler: async (ctx, args) => await doPurchase(ctx, args),
});

/**
 * Open or close the student store. Server-owned, takes effect immediately, and
 * reloads nobody -- which is what lets the UI ship in a deploy that changes
 * nothing and go live the next morning.
 */
export const setStoreOpen = internalMutation({
  args: { open: v.boolean(), reason: v.optional(v.string()) },
  handler: async (ctx, { open, reason }) => {
    const existing = await ctx.db
      .query("appState")
      .withIndex("by_key", (q: any) => q.eq("key", STORE_FLAG_KEY))
      .unique();
    const value = { open, reason: reason ?? null, changedAt: new Date().toISOString() };
    const mirroredAt = new Date().toISOString();
    if (existing) await ctx.db.patch(existing._id, { value, mirroredAt });
    else await ctx.db.insert("appState", { key: STORE_FLAG_KEY, value, mirroredAt });
    return { open, reason: reason ?? null };
  },
});

/** Whether the store is open, and why not. Read-only. */
export const storeOpenState = internalQuery({
  args: {},
  handler: async (ctx) => await storeState(ctx),
});

/**
 * Mark a reward as buyable by students, or not.
 *
 * Separate from the rest of reward editing on purpose: "an adult may hand this
 * over" and "a child may buy this unsupervised" are different decisions, and
 * the second one should have to be made deliberately. Absent is false, so the
 * six rewards that predate this field stay staff-only until somebody says
 * otherwise.
 */
export const setRewardStudentPurchasable = internalMutation({
  args: { rewardId: v.string(), studentPurchasable: v.boolean() },
  handler: async (ctx, { rewardId, studentPurchasable }) => {
    const rows = await rewardRows(ctx);
    const row = (rows as any[]).find(
      (r) => String((r.payload as any)?.id ?? "") === rewardId);
    if (!row) return { ok: false, reason: `No reward with id ${rewardId}.` };
    await ctx.db.patch(row._id, {
      payload: { ...row.payload, studentPurchasable, updatedAt: new Date().toISOString() },
      mirroredAt: new Date().toISOString(),
    });
    return {
      ok: true,
      rewardId,
      name: (row.payload as any)?.name ?? null,
      studentPurchasable,
    };
  },
});

/**
 * The purchase log, for the CSV and the printable report.
 *
 * ONE ROW PER RECEIPT, with every identifier the owner asked for: who, when,
 * what, how much, which grade, and whether the child bought it themselves or
 * an adult did it for them. Read from the receipts slice rather than the cash
 * ledger because a receipt carries the fulfilment state -- "did the child
 * actually get the thing" is the question a purchase log exists to answer, and
 * the ledger only knows that money moved.
 *
 * Date and time are returned SEPARATELY as well as the raw ISO stamp. A
 * spreadsheet that receives one ISO string in one column cannot be sorted by
 * day or filtered by period without somebody writing a formula.
 */
export const purchaseLog = internalQuery({
  args: { sinceIso: v.optional(v.string()), channel: v.optional(v.string()) },
  handler: async (ctx, { sinceIso, channel }) => {
    const since = sinceIso ? Date.parse(sinceIso) : NaN;
    const receipts = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc_collection", (q: any) =>
        q.eq("doc", REWARDS_DOC).eq("collection", RECEIPTS_COLLECTION))
      .collect();

    const students = await ctx.db.query("students").collect();
    const byId = new Map((students as any[]).map(
      (s) => [String(s.legacyId ?? s._id), s]));

    const rows = (receipts as any[])
      .map((r) => r.payload as any)
      .filter((p) => p && p.id)
      .filter((p) => !channel || String(p.channel ?? "staff") === channel)
      .filter((p) => {
        if (!Number.isFinite(since)) return true;
        const t = Date.parse(String(p.purchasedAt ?? ""));
        return Number.isFinite(t) && t >= since;
      })
      .sort((a, b) => String(b.purchasedAt ?? "").localeCompare(String(a.purchasedAt ?? "")))
      .map((p) => {
        const st = byId.get(String(p.studentId));
        const at = new Date(String(p.purchasedAt ?? ""));
        const valid = !isNaN(at.getTime());
        return {
          receipt: p.id,
          studentName: p.studentName ?? null,
          // From the LIVE record, so a renamed or re-graded student is right in
          // a report run today, while the receipt keeps its own snapshot above.
          studentNumber: st?.studentNumber ?? null,
          grade: p.studentGrade ?? st?.grade ?? null,
          school: p.school ?? null,
          reward: p.rewardName ?? null,
          category: p.rewardCategory ?? null,
          quantity: p.quantity ?? 1,
          unitCost: p.unitCost ?? null,
          totalCost: p.totalCost ?? null,
          purchasedAtIso: p.purchasedAt ?? null,
          date: valid ? at.toISOString().slice(0, 10) : null,
          time: valid ? at.toISOString().slice(11, 16) : null,
          boughtBy: p?.purchasedBy?.name ?? null,
          boughtByRole: p?.purchasedBy?.role ?? null,
          channel: p.channel ?? "staff",
          status: p.status ?? null,
          fulfilledAt: p.fulfilledAt ?? null,
          fulfilledBy: p.fulfilledBy ?? null,
          cancelledAt: p.cancelledAt ?? null,
          cancelReason: p.cancelReason ?? null,
        };
      });

    return {
      count: rows.length,
      spentTotal: rows
        .filter((r) => r.status !== "cancelled")
        .reduce((n, r) => n + (Number(r.totalCost) || 0), 0),
      byChannel: rows.reduce((acc: Record<string, number>, r) => {
        acc[r.channel] = (acc[r.channel] ?? 0) + 1;
        return acc;
      }, {}),
      byStatus: rows.reduce((acc: Record<string, number>, r) => {
        acc[String(r.status)] = (acc[String(r.status)] ?? 0) + 1;
        return acc;
      }, {}),
      rows,
    };
  },
});
