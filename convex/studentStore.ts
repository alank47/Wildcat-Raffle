import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireAdmin, requireStaff, requireStudentSelf } from "./identity";
import {
  buildPurchaseLedgerRow,
  buildStudentReceipt,
  effectiveStoreState,
  normalizeQuantity,
  ownedUnits,
  purchaseCounterDelta,
  purchaseMessageOf,
  rewardCampus,
  rewardLimit,
  studentCampus,
  studentPurchaseVerdict,
  MAX_STUDENT_QUANTITY,
  TESTERS_TTL_MS,
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
async function storeRow(ctx: any) {
  return await ctx.db
    .query("appState")
    .withIndex("by_key", (q: any) => q.eq("key", STORE_FLAG_KEY))
    .unique();
}

async function storeState(ctx: any, student?: any): Promise<{
  open: boolean; reason: string; testing: boolean; look: "scene" | "plain"; opensSoon: boolean;
}> {
  const row = await storeRow(ctx);
  const nowMs = Date.now();
  const s = effectiveStoreState(row?.value as Record<string, unknown> | undefined, nowMs,
    student ? String(student.studentNumber ?? "") : null);
  return {
    open: s.open, reason: s.reason, testing: s.testing, look: storeLookOf(row?.value),
    // Shut, with an opening still ahead: "Opens Soon" is true. Shut after a
    // sale, or shut with no plan, it is not -- the shelf just says Closed.
    opensSoon: !s.open && !!s.opensAt && Date.parse(s.opensAt) > nowMs,
  };
}

/**
 * Whether the store is open and how it looks, for the portal's cheap 15-second
 * poll. EXPORTED FOR views_app:myDataVersion, which every open portal already
 * asks four times a minute: riding that call lets a student who opened the
 * page at 6:40 see the store open at 6:45 (or an admin's switch to the plain
 * list) without reloading, at no extra request.
 */
export async function storeSignal(ctx: any, student?: any): Promise<{ open: boolean; look: "scene" | "plain" }> {
  const st = await storeState(ctx, student);
  return { open: st.open, look: st.look };
}

/**
 * HOW THE STORE LOOKS TO A STUDENT: the Wildcat Digital Store scene (the
 * clerk behind the counter, stock on the shelves) or the plain list panel.
 * Only the look -- buying, the campus lock and the limit are the same code
 * either way. Absent means the scene, which the owner chose for the first
 * sale (2026-09-28: "Yes, build it for Tuesday"); "plain" is the one-click
 * way back if it looks wrong on the day.
 */
function storeLookOf(value: unknown): "scene" | "plain" {
  const v = (value ?? {}) as Record<string, unknown>;
  return v.look === "plain" ? "plain" : "scene";
}


/** Every reward row in the catalogue, with the mirror row that holds it. */
async function rewardRows(ctx: any) {
  return await ctx.db
    .query("legacyMirror")
    .withIndex("by_doc_collection", (q: any) =>
      q.eq("doc", REWARDS_DOC).eq("collection", REWARDS_COLLECTION))
    .collect();
}

/**
 * The student row for a student number, BY ITS INDEX. Only the CLI paths
 * need this: a signed-in student's row comes straight from requireStudentSelf.
 *
 * This used to read all 763 student rows and .find() one, on every purchase
 * and every store load. Besides the cost, it put the whole students table in
 * every purchase's read set, so any award to any child anywhere made a
 * concurrent purchase retry.
 */
async function studentByNumber(ctx: any, studentNumber: string) {
  const num = String(studentNumber ?? "").trim();
  if (!num) return null;
  return await ctx.db
    .query("students")
    .withIndex("by_studentNumber", (q: any) => q.eq("studentNumber", num))
    .first();
}

/** Every receipt payload. Small: one row per purchase, ever, this year. */
async function receiptPayloads(ctx: any): Promise<Array<Record<string, any>>> {
  const rows = await ctx.db
    .query("legacyMirror")
    .withIndex("by_doc_collection", (q: any) =>
      q.eq("doc", REWARDS_DOC).eq("collection", RECEIPTS_COLLECTION))
    .collect();
  return (rows as any[]).map((r) => r.payload).filter((p) => p && typeof p === "object");
}

/** The id the rest of the app knows a student by. See buildStudentReceipt. */
function appIdOf(student: any): string {
  return String(student?.legacyId ?? student?._id ?? "");
}

// No O/0/I/1, the same alphabet as the staff store's codes: a child reads this
// off a screen and an adult types it back in.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * A receipt code nobody else holds.
 *
 * NOT DERIVED FROM THE ATTEMPT TOKEN any more. That token is chosen by the
 * browser, so the code it produced was one a child could choose -- including
 * one that already belonged to somebody else, and receipts merge BY THIS ID,
 * so a copy would have hidden the original from the desk. Six characters from
 * 32 is a billion codes, and the set it is checked against is every receipt
 * there is.
 */
function mintReceiptCode(taken: Set<string>): string {
  for (let attempt = 0; attempt < 25; attempt++) {
    let out = "";
    for (let i = 0; i < 6; i++) {
      out += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    }
    const code = "WC-" + out;
    if (!taken.has(code)) return code;
  }
  throw new Error("Could not mint a unique receipt code.");
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
async function storeForStudent(ctx: any, student: any) {
  const state = await storeState(ctx, student);
  const studentNumber = String(student?.studentNumber ?? "");
  const enrolled = student && studentNumber ? await isEnrolled(ctx, studentNumber) : false;
  const withEnrolment = student ? { ...student, enrolled } : null;
  const myCampus = studentCampus(student?.grade);
  const appId = appIdOf(student);
  const receipts = student ? await receiptPayloads(ctx) : [];
  const mine = appId ? receipts.filter((r) => String(r.studentId ?? "") === appId) : [];

  const allRewards = (await rewardRows(ctx)).map((r: any) => r.payload as StoreReward);
  // Every reward by id, retired ones included, so a purchase can still show
  // the message its item carries after the item has left the store.
  const rewardById = new Map<string, StoreReward>(
    allRewards.filter(Boolean).map((r: StoreReward) => [String(r.id ?? ""), r] as [string, StoreReward]));
  const rewards = allRewards
    .filter((r: StoreReward) => r && !r.retiredAt && r.available !== false)
    // THE OTHER CAMPUS'S ITEMS ARE NOT SHOWN AT ALL. The owner's words: "Middle
    // school should only be able to buy Middle school." A card a child can see
    // and never buy is a question for a teacher, times 300. A reward whose
    // campus field is not a campus is hidden too: the purchase would refuse it
    // anyway, and a broken card is worse than a missing one. A child whose
    // grade reads as neither campus still sees campus items, with the reason
    // they cannot buy them, because "ask in the office" is the right answer.
    .filter((r: StoreReward) => {
      const c = rewardCampus(r);
      if (c === null) return false;
      // An admin can let the other campus SEE it (showOtherCampus). They still
      // cannot buy it: the purchase refuses with "only for High School
      // students", and that is what their card says instead of a Buy button.
      return c === "all" || myCampus === null || c === myCampus || r.showOtherCampus === true;
    });

  const balance = Number(student?.wildcatCashBalance) || 0;
  const items = rewards
    .map((reward: StoreReward) => {
      const rewardId = String(reward.id ?? "");
      const owned = ownedUnits(receipts, appId, rewardId);
      const verdict = studentPurchaseVerdict({
        student: withEnrolment, reward, quantity: 1,
        storeOpen: state.open, closedReason: state.reason,
        alreadyOwned: owned,
      });
      const cost = Number(reward.cost) || 0;
      const limit = rewardLimit(reward);
      return {
        id: rewardId,
        name: String(reward.name ?? ""),
        description: String(reward.description ?? ""),
        category: String(reward.category || "General"),
        cost,
        stock: reward.stock ?? null,
        inStudentStore: reward.studentPurchasable === true,
        campus: rewardCampus(reward),
        limitPerStudent: typeof limit === "number" ? limit : null,
        owned,
        // THE OTHER CAMPUS'S ITEM, shown because an admin let them see it.
        // Named here so the portal and the sort do not have to infer it
        // from a refusal code that earlier refusals can mask.
        otherCampus: rewardCampus(reward) !== "all" && myCampus !== null && rewardCampus(reward) !== myCampus,
        // Their own receipt codes for this reward, newest first, so the card
        // can say "you bought this, show WC-XXXXXX" long after the dialog that
        // announced it has gone. The code is what they take to the office.
        myReceipts: mine
          .filter((r) => String(r.rewardId ?? "") === rewardId && r.status !== "cancelled")
          .sort((a, b) => String(b.purchasedAt ?? "").localeCompare(String(a.purchasedAt ?? "")))
          .map((r) => ({ id: String(r.id ?? ""), status: String(r.status ?? "issued") })),
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
      // The other campus's item last, always: it can never be theirs, and a
      // tie on price would otherwise put it above their own pass.
      if (a.otherCampus !== b.otherCampus) return a.otherCampus ? 1 : -1;
      if (a.inStudentStore !== b.inStudentStore) return a.inStudentStore ? -1 : 1;
      return (a.shortfall ?? 0) - (b.shortfall ?? 0);
    });

  return {
    storeOpen: state.open,
    look: state.look,
    opensSoon: state.opensSoon,
    // True only for a dry-run tester seeing a store that is shut to everyone
    // else, so their screen can say so rather than look like the real sale.
    testing: state.testing,
    closedReason: state.open ? null : state.reason,
    balance,
    maxQuantity: MAX_STUDENT_QUANTITY,
    items,
    // EVERYTHING THEY HOLD, from the receipts rather than from the catalogue
    // above -- which drops a reward the moment it is retired, paused or taken
    // out of the student store, and is not drawn at all once the store closes.
    // The code is what they take to the office, and the sale closing is
    // exactly when they need it.
    myPurchases: mine
      .filter((r) => r.status !== "cancelled")
      .sort((a, b) => String(b.purchasedAt ?? "").localeCompare(String(a.purchasedAt ?? "")))
      .slice(0, 20)
      .map((r) => ({
        id: String(r.id ?? ""),
        rewardName: String(r.rewardName ?? ""),
        quantity: Number(r.quantity) > 1 ? Number(r.quantity) : 1,
        status: String(r.status ?? "issued"),
        purchasedAt: r.purchasedAt ?? null,
        // The item's CURRENT message, not a copy taken at purchase: if the
        // pickup moves to Thursday, every buyer should read Thursday.
        message: purchaseMessageOf(rewardById.get(String(r.rewardId ?? ""))),
      })),
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
    return await storeForStudent(ctx, me);
  },
});

/**
 * Buy one reward, as the signed-in student.
 *
 * Takes a reward id, a quantity and an attempt token. NOT a cost, a total or a
 * balance -- the server reads the price from the catalogue. And not a student
 * id: a child who could name the buyer could name somebody else.
 *
 * `seenPrice` is the one number the browser may send, and it can only REFUSE.
 * It is compared with the catalogue's cost and never used to charge: if an
 * admin repriced the item after the card loaded, the child is told the new
 * price instead of being charged it.
 */
export const purchase = mutation({
  args: {
    rewardId: v.string(),
    quantity: v.optional(v.number()),
    attemptId: v.string(),
    seenPrice: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const me = await requireStudentSelf(ctx);
    return await doPurchase(ctx, {
      student: me,
      rewardId: args.rewardId,
      quantity: args.quantity,
      attemptId: args.attemptId,
      seenPrice: args.seenPrice,
    });
  },
});

/** The catalogue for one student, by student number. Internal, for the CLI. */
export const storeFor = internalQuery({
  args: { studentNumber: v.string() },
  handler: async (ctx, { studentNumber }) =>
    await storeForStudent(ctx, await studentByNumber(ctx, studentNumber)),
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
  args: {
    student: any;
    rewardId: string;
    quantity?: number;
    attemptId: string;
    seenPrice?: number;
  },
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
    // THE SAME PRESS, BY THE SAME CHILD. A token is kept for a retry after a
    // dropped connection, and on a shared machine the next child to sign in
    // could send the last child's -- which must not hand them somebody else's
    // receipt as "you already bought this".
    if (String(prior.studentId ?? "") !== appIdOf(args.student)) {
      return { ok: false, code: "attempt_mismatch",
               reason: "That did not go through. Nothing was charged. Press Buy again." };
    }
    const priorReward = ((await rewardRows(ctx)) as any[])
      .map((r) => r.payload as StoreReward)
      .find((r) => String(r?.id ?? "") === String(prior.rewardId ?? ""));
    return {
      ok: true,
      alreadyBought: true,
      receiptId: prior.receiptId,
      rewardName: prior.rewardName,
      totalCost: prior.totalCost,
      purchasedAt: prior.purchasedAt,
      purchaseMessage: purchaseMessageOf(priorReward),
    };
  }

  const student = args.student ?? null;
  const state = await storeState(ctx, student);
  const studentNumber = String(student?.studentNumber ?? "");
  const enrolled = student && studentNumber ? await isEnrolled(ctx, studentNumber) : false;
  const withEnrolment = student ? { ...student, enrolled } : null;

  const rows = await rewardRows(ctx);
  const rewardRow = (rows as any[]).find(
    (r) => String((r.payload as any)?.id ?? "") === String(args.rewardId));
  const reward = (rewardRow?.payload ?? null) as StoreReward | null;

  // EVERY RECEIPT, read inside this transaction: what the child already holds
  // (the one-per-student rule), and which codes are taken. Reading it here
  // rather than trusting the register means a pass an adult bought for them
  // at the office counts too, and two tabs racing each other are serialised
  // by the database -- the second one sees the first one's receipt.
  const receipts = student ? await receiptPayloads(ctx) : [];
  const owned = student && reward
    ? ownedUnits(receipts, appIdOf(student), String(reward.id ?? ""))
    : 0;

  const verdict = studentPurchaseVerdict({
    student: withEnrolment, reward, quantity: args.quantity ?? 1,
    storeOpen: state.open, closedReason: state.reason,
    alreadyOwned: owned,
    seenPrice: args.seenPrice,
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
    // NOT updatedAt. That stamp is what legacyData:mergeSlice compares to
    // decide whether an admin's edit is newer than the stored row, and a
    // purchase every few seconds kept it ahead of every edit made during the
    // sale: a price change, a pause or a retire landed as "Reward updated" and
    // was silently thrown away (review, 2026-09-28). The count is protected
    // from stale tabs by keepServerStock instead, and staff tabs still pick up
    // the new number because a tie in WildcatMerge keeps the server's copy.
    await ctx.db.patch(rewardRow._id, {
      payload: { ...reward, stock: Number(liveStock) - quantity, stockMovedAt: nowIso },
      mirroredAt: nowIso,
    });
  }

  // The receipt code is minted SERVER-SIDE, like the reversal's row id: a
  // client-minted one would let a retry insert a second receipt under a
  // different code before the register could refuse it. See mintReceiptCode
  // for why it is no longer derived from the attempt token.
  const receiptId = mintReceiptCode(new Set(receipts.map((r) => String(r.id ?? ""))));
  const txnId = `txn_buy_${nowMs}_${attemptId.slice(-7)}`;

  const delta = purchaseCounterDelta(total);
  const balanceAfter = (Number(student.wildcatCashBalance) || 0) + delta.wildcatCashBalance;

  // The app-facing id, the way toAppStudent computes it. Passed explicitly
  // because the raw row has no `id` field and reading one wrote "".
  const studentAppId = String(student.legacyId ?? student._id);
  const receipt = buildStudentReceipt({
    receiptId, student: withEnrolment as any, studentAppId,
    reward: reward!, quantity, nowIso,
  });
  (receipt as any).txId = txnId;

  const ledgerRow = buildPurchaseLedgerRow({
    txnId, receiptId, student: withEnrolment as any, studentAppId,
    reward: reward!, quantity, total, nowIso, balanceAfter,
  });

  // 1. The register, first, so nothing below can be repeated.
  await ctx.db.insert("studentPurchases", {
    attemptId,
    receiptId,
    studentId: String(student.legacyId ?? student._id),
    studentNumber,
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
    // What the admin wants every buyer told. Shown in the receipt dialog.
    purchaseMessage: purchaseMessageOf(reward),
  };
}

/** Buy, by student number. Internal: for the CLI and the dry run. */
export const purchaseFor = internalMutation({
  args: {
    studentNumber: v.string(),
    rewardId: v.string(),
    quantity: v.optional(v.number()),
    attemptId: v.string(),
    seenPrice: v.optional(v.number()),
  },
  handler: async (ctx, args) => await doPurchase(ctx, {
    student: await studentByNumber(ctx, args.studentNumber),
    rewardId: args.rewardId,
    quantity: args.quantity,
    attemptId: args.attemptId,
    seenPrice: args.seenPrice,
  }),
});

/**
 * OPENING AND CLOSING, NOW OR ON A TIMER.
 *
 * The first real sale (2026-09-29) opens before 7am and runs one day. Nobody
 * should have to be awake at 6:45 to flip a switch, and nobody should have to
 * remember to shut it -- so a schedule is stored with the switch and the
 * scheduler flips it at the time.
 *
 * THE TOKEN. Every change writes a fresh one, and a scheduled flip only acts
 * if the token it was given is still the current one. So an admin who presses
 * "Close now" at 9am, or re-schedules, is not overruled at noon by a job that
 * was queued for the old plan.
 *
 * The closing time is ALSO read from the clock by every purchase (see
 * effectiveStoreState), so a late-running job cannot sell past the close.
 */
type StoreChange = {
  action: "open" | "close" | "schedule" | "testers" | "look";
  /** For action "look": the scene or the plain list. */
  look?: string | null;
  /** Student numbers who may buy while the store is closed, for a dry run. */
  testers?: string[] | null;
  reason?: string | null;
  endedReason?: string | null;
  opensAt?: string | null;
  closesAt?: string | null;
};

function isoOrNull(raw: unknown, label: string): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  // A TIME ZONE IS REQUIRED. "2026-09-29T06:45" means 6:45 to a person in Los
  // Angeles and 11:45pm the night before to this server, which runs in UTC.
  // The screen always sends a full ISO stamp; this refuses the CLI typo.
  if (!/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(String(raw).trim())) {
    throw new Error(`${label} needs a time zone, e.g. 2026-09-29T13:45:00Z or 2026-09-29T06:45:00-07:00.`);
  }
  const t = Date.parse(String(raw));
  if (!Number.isFinite(t)) throw new Error(`${label} is not a date and time: ${String(raw)}`);
  return new Date(t).toISOString();
}

/**
 * THE DRY-RUN LIST: student numbers who may buy while the store is shut to
 * everybody else. Without it a rehearsal meant opening the real store to all
 * 620 students (review, 2026-09-28). Capped, because it is for a handful of
 * testers, not a second store.
 */
function cleanTesters(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const x of list) {
    const n = String(x ?? "").trim();
    if (/^\d{3,10}$/.test(n) && !out.includes(n)) out.push(n);
  }
  if (out.length > 10) throw new Error("A dry run is for a handful of testers: 10 at most.");
  return out;
}

function cleanText(raw: unknown): string | null {
  const t = String(raw ?? "").trim().slice(0, 200);
  return t || null;
}

async function applyStoreChange(ctx: any, change: StoreChange, by: string | null) {
  const row = await storeRow(ctx);
  const prev = ((row?.value ?? {}) as Record<string, unknown>);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const token = `store_${nowMs}_${Math.random().toString(36).slice(2, 10)}`;

  const next: Record<string, unknown> = {
    open: prev.open === true,
    reason: typeof prev.reason === "string" ? prev.reason : null,
    endedReason: typeof prev.endedReason === "string" ? prev.endedReason : null,
    opensAt: typeof prev.opensAt === "string" ? prev.opensAt : null,
    closesAt: typeof prev.closesAt === "string" ? prev.closesAt : null,
    testers: Array.isArray(prev.testers) ? prev.testers : [],
    testersUntil: typeof prev.testersUntil === "string" ? prev.testersUntil : null,
    // CARRIED, or "Open now" / "Close now" / a schedule would quietly put the
    // shop back after an admin chose the plain list (review, 2026-09-28).
    look: storeLookOf(prev),
  };
  if (change.reason !== undefined) next.reason = cleanText(change.reason);
  if (change.endedReason !== undefined) next.endedReason = cleanText(change.endedReason);

  // A closing time already behind us is dropped, or "Open now" the morning
  // after a sale would open a store that effectiveStoreState then reads as
  // closed -- a button that silently does nothing.
  const closeStillAhead = (iso: unknown) =>
    typeof iso === "string" && Date.parse(iso) > nowMs ? iso : null;

  if (change.action === "look") {
    // Only the look changes: open/closed, the schedule, its token and the
    // testers all stay exactly as they are.
    if (change.look !== "scene" && change.look !== "plain") throw new Error("The look is 'scene' or 'plain'.");
    const value: Record<string, unknown> = { ...prev, look: change.look, changedAt: nowIso, changedBy: by };
    if (row) await ctx.db.patch(row._id, { value, mirroredAt: nowIso });
    else await ctx.db.insert("appState", { key: STORE_FLAG_KEY, value: { open: false, ...value }, mirroredAt: nowIso });
    return statusOf(value);
  }
  if (change.action === "testers") {
    // Only the dry-run list changes. Open/closed and any schedule stay as
    // they are, and so does the token, so queued jobs still run.
    next.testers = cleanTesters(change.testers);
    const testersUntil = (next.testers as string[]).length
      ? new Date(nowMs + TESTERS_TTL_MS).toISOString() : null;
    const value: Record<string, unknown> = { ...prev, testers: next.testers, testersUntil,
      changedAt: nowIso, changedBy: by };
    if (row) await ctx.db.patch(row._id, { value, mirroredAt: nowIso });
    else await ctx.db.insert("appState", { key: STORE_FLAG_KEY, value: { open: false, ...value }, mirroredAt: nowIso });
    // THE LAPSE IS WRITTEN, not only read from the clock. A query that saw
    // "open" for a tester stays cached until something it read changes; the
    // write at testersUntil is that change, so the tester's screen settles
    // on "closed" instead of disagreeing with itself every poll.
    if (testersUntil) {
      await ctx.scheduler.runAt(Date.parse(testersUntil),
        internal.studentStore.lapseStoreTesters, { testersUntil });
    }
    return statusOf(value);
  }
  if (change.action === "open") {
    next.open = true;
    next.opensAt = null;
    // Open to everyone: a testers list has nothing left to do.
    next.testers = [];
    next.testersUntil = null;
    if (change.closesAt !== undefined) {
      const explicit = isoOrNull(change.closesAt, "Closes at");
      if (explicit && Date.parse(explicit) <= nowMs) throw new Error("The closing time has already passed.");
      next.closesAt = explicit;
    } else {
      next.closesAt = closeStillAhead(next.closesAt);
    }
  } else if (change.action === "close") {
    next.open = false;
    next.opensAt = null;
    next.closesAt = null;
    // "Close now" means NOBODY buys, dry-run testers included -- the confirm
    // says so, and an emergency close must not leave ten back doors open.
    next.testers = [];
    next.testersUntil = null;
  } else {
    const opensAt = isoOrNull(change.opensAt, "Opens at");
    const closesAt = isoOrNull(change.closesAt, "Closes at");
    if (!opensAt && !closesAt) throw new Error("A schedule needs an opening time, a closing time, or both.");
    if (closesAt && Date.parse(closesAt) <= nowMs) throw new Error("The closing time has already passed.");
    if (opensAt && closesAt && Date.parse(closesAt) <= Date.parse(opensAt)) {
      throw new Error("The store has to open before it closes.");
    }
    if (opensAt) {
      // An opening time already here opens it now; one ahead shuts it until then.
      next.open = Date.parse(opensAt) <= nowMs;
      next.opensAt = Date.parse(opensAt) <= nowMs ? null : opensAt;
    }
    // A closing time SENT AS BLANK clears it (the screen always sends both
    // boxes, so an emptied box means "no closing time"); one not sent at all,
    // as from the CLI, keeps whatever was there.
    next.closesAt = change.closesAt !== undefined ? closesAt : closeStillAhead(next.closesAt);
  }

  // CHECKED AFTER MERGING, not only on what this call sent: an opening kept
  // from an earlier schedule and a closing time sent now must still be in the
  // right order, or the close runs first and the opening then opens a store
  // with no closing time at all.
  if (typeof next.opensAt === "string" && typeof next.closesAt === "string" &&
      Date.parse(next.closesAt as string) <= Date.parse(next.opensAt as string)) {
    throw new Error("The store has to open before it closes.");
  }

  const value: Record<string, unknown> = { ...next, token, changedAt: nowIso, changedBy: by };
  if (row) await ctx.db.patch(row._id, { value, mirroredAt: nowIso });
  else await ctx.db.insert("appState", { key: STORE_FLAG_KEY, value, mirroredAt: nowIso });

  if (typeof value.opensAt === "string") {
    await ctx.scheduler.runAt(Date.parse(value.opensAt as string),
      internal.studentStore.runStoreSchedule, { token, action: "open" });
  }
  if (typeof value.closesAt === "string") {
    await ctx.scheduler.runAt(Date.parse(value.closesAt as string),
      internal.studentStore.runStoreSchedule, { token, action: "close" });
  }
  return statusOf(value);
}

/** What an admin needs to see about the switch. */
function statusOf(value: Record<string, unknown> | null | undefined) {
  const v = (value ?? {}) as Record<string, unknown>;
  const eff = effectiveStoreState(v, Date.now());
  return {
    open: eff.open,
    reason: typeof v.reason === "string" ? v.reason : null,
    endedReason: typeof v.endedReason === "string" ? v.endedReason : null,
    shownWhileClosed: eff.open ? null : eff.reason,
    opensAt: eff.opensAt,
    closesAt: eff.closesAt,
    changedAt: typeof v.changedAt === "string" ? v.changedAt : null,
    changedBy: typeof v.changedBy === "string" ? v.changedBy : null,
    testers: Array.isArray(v.testers) ? (v.testers as unknown[]).map(String) : [],
    testersUntil: typeof v.testersUntil === "string" ? v.testersUntil : null,
    look: storeLookOf(v),
  };
}

/** The scheduled flip. Does nothing if the plan changed since it was queued. */
export const runStoreSchedule = internalMutation({
  args: { token: v.string(), action: v.union(v.literal("open"), v.literal("close")) },
  handler: async (ctx, { token, action }) => {
    const row = await storeRow(ctx);
    const prev = (row?.value ?? {}) as Record<string, unknown>;
    if (!row || prev.token !== token) return { skipped: true, reason: "superseded" };
    // An opening only opens a store that is still WAITING to open. If the
    // schedule's close already ran (or someone opened it by hand), the
    // opening is spent -- running it would reopen a finished sale.
    if (action === "open" && typeof prev.opensAt !== "string") {
      return { skipped: true, reason: "no pending opening" };
    }
    const nowIso = new Date().toISOString();
    const value: Record<string, unknown> = action === "open"
      ? { ...prev, open: true, opensAt: null }
      : {
          ...prev, open: false, opensAt: null, closesAt: null, testers: [], testersUntil: null,
          // After a sale ends, the message is the "has ended" one when the
          // admin wrote it, not the "opens Tuesday" one from before it began.
          reason: typeof prev.endedReason === "string" && prev.endedReason
            ? prev.endedReason : null,
        };
    value.changedAt = nowIso;
    value.changedBy = action === "open" ? "schedule (opened)" : "schedule (closed)";
    await ctx.db.patch(row._id, { value, mirroredAt: nowIso });
    return { skipped: false, action };
  },
});

/**
 * Open or close the student store now. CLI. Kept with its old arguments so the
 * runbook commands that already use it still work.
 */
export const setStoreOpen = internalMutation({
  args: { open: v.boolean(), reason: v.optional(v.string()), closesAt: v.optional(v.string()) },
  handler: async (ctx, { open, reason, closesAt }) =>
    await applyStoreChange(ctx, {
      action: open ? "open" : "close",
      reason: reason ?? undefined,
      closesAt: closesAt ?? undefined,
    }, "CLI"),
});

/** Open and/or close on a timer. CLI. Times are ISO, e.g. 2026-09-29T13:45:00Z. */
export const scheduleStore = internalMutation({
  args: {
    opensAt: v.optional(v.string()),
    closesAt: v.optional(v.string()),
    reason: v.optional(v.string()),
    endedReason: v.optional(v.string()),
  },
  handler: async (ctx, args) =>
    await applyStoreChange(ctx, { action: "schedule", ...args }, "CLI"),
});

/** Clears the dry-run list when it lapses, unless it was re-set since. */
export const lapseStoreTesters = internalMutation({
  args: { testersUntil: v.string() },
  handler: async (ctx, { testersUntil }) => {
    const row = await storeRow(ctx);
    const prev = (row?.value ?? {}) as Record<string, unknown>;
    if (!row || prev.testersUntil !== testersUntil) return { skipped: true };
    const nowIso = new Date().toISOString();
    await ctx.db.patch(row._id, {
      value: { ...prev, testers: [], testersUntil: null, changedAt: nowIso, changedBy: "schedule (testers lapsed)" },
      mirroredAt: nowIso,
    });
    return { skipped: false };
  },
});

/** The store's look: "scene" (the Wildcat Digital Store) or "plain". CLI. */
export const setStoreLook = internalMutation({
  args: { look: v.union(v.literal("scene"), v.literal("plain")) },
  handler: async (ctx, { look }) => await applyStoreChange(ctx, { action: "look", look }, "CLI"),
});

/** The dry-run list. CLI. Pass [] to clear it. */
export const setStoreTesters = internalMutation({
  args: { testers: v.array(v.string()) },
  handler: async (ctx, { testers }) =>
    await applyStoreChange(ctx, { action: "testers", testers }, "CLI"),
});

/** Whether the store is open, and why not. Read-only. CLI. */
export const storeOpenState = internalQuery({
  args: {},
  handler: async (ctx) => statusOf((await storeRow(ctx))?.value),
});

/**
 * THE SWITCH ON THE REWARDS STORE SCREEN. Staff may see it; only an admin may
 * change it -- the same line requireAdmin draws for every action that changes
 * what other people can do.
 */
export const storeStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    return statusOf((await storeRow(ctx))?.value);
  },
});

export const setStore = mutation({
  args: {
    // "change", not "action": the app's audit vocabulary is written as
    // `action: '...'`, and this is a switch position, not an audit entry.
    change: v.union(v.literal("open"), v.literal("close"), v.literal("schedule"), v.literal("testers"), v.literal("look")),
    testers: v.optional(v.union(v.array(v.string()), v.null())),
    look: v.optional(v.union(v.literal("scene"), v.literal("plain"))),
    reason: v.optional(v.union(v.string(), v.null())),
    endedReason: v.optional(v.union(v.string(), v.null())),
    opensAt: v.optional(v.union(v.string(), v.null())),
    closesAt: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const by = String((admin as any).name ?? (admin as any).email ?? "admin");
    const { change, ...rest } = args;
    return await applyStoreChange(ctx, { action: change, ...rest }, by);
  },
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
