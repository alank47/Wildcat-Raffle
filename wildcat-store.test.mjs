// Rules for the Wildcat Cash rewards store.
//
// Every assertion below is about somebody's money, so these are asserted
// against the real file rather than a restatement of it: the source is loaded
// and executed, and the exported object is exercised directly.
//
// Several cases pin bugs that were live before this file existed:
//
//   - a reward redemption built its own transaction and pushed it into an
//     array nothing persisted, so the balance dropped with no ledger row to
//     explain it, and a later "recalculate balances" would have refunded every
//     redemption ever made.
//   - resetAllStudentCash zeroed the balance and THEN recorded
//     `amount: -student.wildcatCashBalance`, so every reset transaction
//     claimed that zero dollars moved.
//   - rewards were a hardcoded array that was never saved, so an edited price
//     lived until the next page load.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-store.js", import.meta.url), "utf8");
new Function(src)();
const S = globalThis.WildcatStore;

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

const NOW = Date.parse("2026-09-08T15:00:00.000Z");
const ACTOR = { id: "T001", name: "Sarah R", username: "sarahr", role: "teacher" };
const seq = (() => { let i = 0; const vals = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]; return () => vals[i++ % vals.length]; })();

function student(over = {}) {
  return Object.assign(
    { id: "STU001", firstName: "Ada", lastName: "L", grade: "10", wildcatCashBalance: 5000 },
    over,
  );
}
function reward(over = {}) {
  return S.normalizeReward(Object.assign({ id: "reward1", name: "Homework Pass", cost: 1000 }, over), NOW, ACTOR);
}

console.log("\nReward validation");
check("a reward needs a name", S.validateReward({ name: "", cost: 100 }).ok === false);
check("a reward needs a positive cost", S.validateReward({ name: "X", cost: 0 }).ok === false);
check("a negative cost is refused", S.validateReward({ name: "X", cost: -5 }).ok === false);
check("a fractional cost is refused", S.validateReward({ name: "X", cost: 10.5 }).ok === false);
check("a valid reward passes", S.validateReward({ name: "X", cost: 100 }).ok === true);
check("every bad field is reported at once",
  S.validateReward({ name: "", cost: -1 }).errors.length === 2);
check("blank stock means unlimited, and is allowed",
  S.validateReward({ name: "X", cost: 1, stock: null }).ok === true);
check("fractional stock is refused",
  S.validateReward({ name: "X", cost: 1, stock: 2.5 }).ok === false);

console.log("\nEditing a reward");
{
  const r = reward();
  const edited = S.applyRewardEdit(r, { cost: 1200, name: "Homework Pass (new)" }, NOW, ACTOR);
  check("the edit returns a new object", edited !== r);
  check("the original is untouched", r.cost === 1000);
  check("the new cost is applied", edited.cost === 1200);
  check("who edited it is recorded", edited.updatedBy === "Sarah R");
  check("when it was edited is recorded", typeof edited.updatedAt === "string");
  check("unspecified fields survive the edit", edited.category === "General");
  check("stock can be cleared back to unlimited",
    S.applyRewardEdit(r, { stock: null }, NOW, ACTOR).stock === null);
  check("stock of 0 is kept as 0, not treated as unlimited",
    S.applyRewardEdit(r, { stock: 0 }, NOW, ACTOR).stock === 0);
}

console.log("\nRetiring, never deleting");
{
  const retired = S.retireReward(reward(), NOW, ACTOR);
  check("a retired reward is unavailable", retired.available === false);
  check("retirement is stamped", typeof retired.retiredAt === "string" && retired.retiredBy === "Sarah R");
  check("a retired reward cannot be purchased", S.isRewardPurchasable(retired) === false);
  check("the id survives so old receipts still resolve", retired.id === "reward1");
}

console.log("\nWhat may be purchased");
check("a normal purchase is allowed",
  S.canPurchase({ student: student(), reward: reward(), quantity: 1 }).allowed === true);
check("insufficient funds is refused",
  S.canPurchase({ student: student({ wildcatCashBalance: 100 }), reward: reward() }).allowed === false);
check("and the refusal says how much short, not just 'no'",
  /Short by \$900/.test(S.canPurchase({ student: student({ wildcatCashBalance: 100 }), reward: reward() }).reason));
check("an unavailable reward is refused",
  S.canPurchase({ student: student(), reward: reward({ available: false }) }).allowed === false);
check("a retired reward is refused",
  S.canPurchase({ student: student(), reward: S.retireReward(reward(), NOW, ACTOR) }).allowed === false);
check("out of stock is refused",
  S.canPurchase({ student: student(), reward: reward({ stock: 0 }) }).allowed === false);
check("quantity above stock is refused",
  S.canPurchase({ student: student(), reward: reward({ stock: 1 }), quantity: 2 }).allowed === false);
check("unlimited stock (null) is not mistaken for zero",
  S.canPurchase({ student: student(), reward: reward({ stock: null }), quantity: 3 }).allowed === true);
check("zero quantity is refused",
  S.canPurchase({ student: student(), reward: reward(), quantity: 0 }).allowed === false);
check("fractional quantity is refused",
  S.canPurchase({ student: student(), reward: reward(), quantity: 1.5 }).allowed === false);
check("exact balance is enough",
  S.canPurchase({ student: student({ wildcatCashBalance: 1000 }), reward: reward() }).allowed === true);
check("a missing student is refused rather than throwing",
  S.canPurchase({ student: null, reward: reward() }).allowed === false);

console.log("\nBuilding a purchase");
{
  const st = student();
  const rw = reward();
  const res = S.buildPurchase({ student: st, reward: rw, quantity: 2, actor: ACTOR, now: NOW, rand: seq });

  check("it succeeds", res.ok === true);
  check("total is unit cost times quantity", res.receipt.totalCost === 2000);
  check("the receipt carries a readable code", /^WC-[2-9A-HJ-NP-Z]{6}$/.test(res.receipt.id));
  check("the code avoids ambiguous glyphs", !/[O0I1]/.test(res.receipt.id.slice(3)));
  check("it starts as issued", res.receipt.status === "issued");

  // THE BUG THIS REPLACES: money moved without a ledger row.
  check("it returns a transaction REQUEST rather than moving money itself",
    res.transactionRequest && res.transactionRequest.amount === -2000);
  check("the request is kind 'redeem', so recalculation counts it as spent",
    res.transactionRequest.kind === "redeem");
  check("the request names the receipt, so ledger and receipt can be matched",
    res.transactionRequest.notes.includes(res.receipt.id));
  check("nothing was mutated on the student", st.wildcatCashBalance === 5000);

  check("the reward name is SNAPSHOTTED onto the receipt", res.receipt.rewardName === "Homework Pass");
  check("the unit cost is snapshotted too", res.receipt.unitCost === 1000);
  check("stockAfter is reported for unlimited as null", res.stockAfter === null);
  check("who rang it up is recorded", res.receipt.purchasedBy.name === "Sarah R");
  check("the channel defaults to staff", res.receipt.channel === "staff");
  check("a student self-serve purchase is marked as such",
    S.buildPurchase({ student: st, reward: rw, actor: ACTOR, now: NOW, channel: "student", rand: seq })
      .receipt.channel === "student");
  check("school is derived from grade", res.receipt.school === "High School");
  check("a grade 7 student is middle school",
    S.buildPurchase({ student: student({ grade: "7" }), reward: rw, actor: ACTOR, now: NOW, rand: seq })
      .receipt.school === "Middle School");

  const refused = S.buildPurchase({ student: student({ wildcatCashBalance: 0 }), reward: rw, actor: ACTOR, now: NOW });
  check("a refused purchase builds nothing", refused.ok === false && !refused.receipt);
}

console.log("\nA repriced reward does not rewrite history");
{
  const rw = reward();
  const bought = S.buildPurchase({ student: student(), reward: rw, actor: ACTOR, now: NOW, rand: seq });
  const repriced = S.applyRewardEdit(rw, { cost: 9999, name: "Homework Pass DELUXE" }, NOW, ACTOR);
  check("the receipt still shows what was actually paid", bought.receipt.totalCost === 1000);
  check("and the name it was bought under", bought.receipt.rewardName === "Homework Pass");
  check("even though the reward has since changed", repriced.cost === 9999);
}

console.log("\nFulfillment");
{
  const r = S.buildPurchase({ student: student(), reward: reward(), actor: ACTOR, now: NOW, rand: seq }).receipt;
  check("an issued receipt can be fulfilled", S.canFulfill(r).allowed === true);

  const done = S.applyFulfill(r, NOW, { name: "Front Office" });
  check("fulfilling sets the status", done.status === "fulfilled");
  check("and records who and when", done.fulfilledBy === "Front Office" && typeof done.fulfilledAt === "string");
  check("the original object is not mutated", r.status === "issued");

  check("a fulfilled receipt cannot be fulfilled twice", S.canFulfill(done).allowed === false);
  check("and the refusal says when it was already done",
    S.canFulfill(done).reason.includes(done.fulfilledAt));
  check("a fulfilled receipt cannot then be cancelled", S.canCancel(done).allowed === false);
}

console.log("\nCancelling refunds forward, never by editing history");
{
  const st = student();
  const built = S.buildPurchase({ student: st, reward: reward(), actor: ACTOR, now: NOW, rand: seq });
  const res = S.buildCancel({ receipt: built.receipt, student: st, reason: "Out of stock", actor: ACTOR, now: NOW });

  check("cancelling an issued receipt is allowed", res.ok === true);
  check("status becomes cancelled", res.receipt.status === "cancelled");
  check("the reason is kept", res.receipt.cancelReason === "Out of stock");
  check("a refund is issued as a NEW transaction", res.transactionRequest.amount === 1000);
  check("the refund is positive, returning money", res.transactionRequest.amount > 0);
  check("the refund names the receipt it reverses",
    res.transactionRequest.notes.includes(built.receipt.id));
  check("the original receipt object is untouched", built.receipt.status === "issued");

  const noRefund = S.buildCancel({ receipt: built.receipt, student: st, refund: false, actor: ACTOR, now: NOW });
  check("cancelling without a refund produces no transaction", noRefund.transactionRequest === null);
  check("but still cancels", noRefund.receipt.status === "cancelled");

  check("a cancelled receipt cannot be cancelled again", S.canCancel(res.receipt).allowed === false);
  check("a cancelled receipt cannot be fulfilled", S.canFulfill(res.receipt).allowed === false);
}

console.log("\nA refund across a balance reset is refused, and the cancellation is not");
{
  // THE INCIDENT, in the owner's words: "I made that refund by cancelling a
  // receipt from a test. The refund should not have been processed to her."
  // WC-XPSGVE was a $1,000 Homework Pass bought 2026-09-10. Every balance in
  // the school was cleared on 2026-09-13, so the $1,000 was no longer deducted
  // from anybody, and cancelling on 2026-09-14 refunded it anyway. Nothing
  // here looked at the date. cashReversalRules had this rule all along; it had
  // only ever been applied to the reversal path, not to this one.
  const CUTOFF = Date.parse("2026-09-14T15:30:00Z");
  const st = student();
  const receiptAt = (iso) => Object.assign(
    S.buildPurchase({ student: st, reward: reward(), actor: ACTOR, now: NOW, rand: seq }).receipt,
    { purchasedAt: iso });

  const before = receiptAt("2026-09-10T17:59:09.984Z");
  const v = S.cancelRefundVerdict(before, CUTOFF);
  check("a purchase from before the reset may not be refunded", v.allowed === false);
  check("and the refusal is coded, not just prose", v.code === "before_reset");
  check("the reason explains it would invent money", /never taken/.test(v.reason));

  const res = S.buildCancel({
    receipt: before, student: st, reason: "Test only",
    actor: ACTOR, now: NOW, historyCutoffMs: CUTOFF,
  });
  check("the receipt is STILL cancelled", res.ok === true && res.receipt.status === "cancelled");
  check("but no refund transaction is built", res.transactionRequest === null);
  check("and refunded is false, so no screen can claim otherwise", res.refunded === false);
  check("the caller is told why, for the toast", res.refundRefused && res.refundRefused.code === "before_reset");

  // Without the guard this is exactly what used to happen.
  const unguarded = S.buildCancel({
    receipt: before, student: st, reason: "Test only", actor: ACTOR, now: NOW,
  });
  check("with no cutoff passed it still refunds, so this test has teeth",
    unguarded.transactionRequest !== null && unguarded.transactionRequest.amount === 1000);
  check("and no cutoff is treated as permission, matching cashReversalRules",
    S.cancelRefundVerdict(before, null).allowed === true);

  const after = receiptAt("2026-09-16T18:00:00.000Z");
  check("a purchase from after the reset refunds normally",
    S.cancelRefundVerdict(after, CUTOFF).allowed === true);
  const okRes = S.buildCancel({
    receipt: after, student: st, reason: "Out of stock",
    actor: ACTOR, now: NOW, historyCutoffMs: CUTOFF,
  });
  check("and its refund is built", okRes.transactionRequest.amount === 1000);
  check("with nothing refused", okRes.refundRefused === null);

  // The slack exists because a Chromebook with a slightly wrong clock must not
  // cost a student a refund they are actually owed.
  check("a purchase inside the one-hour slack still refunds",
    S.cancelRefundVerdict(receiptAt(new Date(CUTOFF - 1800000).toISOString()), CUTOFF).allowed === true);
  check("and one outside it does not",
    S.cancelRefundVerdict(receiptAt(new Date(CUTOFF - 7200000).toISOString()), CUTOFF).allowed === false);

  // An undated receipt cannot be PROVED to be on the safe side. Refunding
  // wrongly invents money, so the cautious answer here is no.
  const undated = receiptAt(null);
  check("an undated receipt may not be refunded",
    S.cancelRefundVerdict(undated, CUTOFF).allowed === false);
  check("and says so as 'undated' rather than guessing a reason",
    S.cancelRefundVerdict(undated, CUTOFF).code === "undated");

  const free = Object.assign(receiptAt("2026-09-16T18:00:00.000Z"), { totalCost: 0 });
  check("a receipt recording no cost has nothing to refund",
    S.cancelRefundVerdict(free, CUTOFF).code === "nothing_to_refund");

  const notAsked = S.buildCancel({
    receipt: after, student: st, refund: false, actor: ACTOR, now: NOW, historyCutoffMs: CUTOFF,
  });
  check("asking for no refund is not reported as a refusal", notAsked.refundRefused === null);
  check("and still produces no transaction", notAsked.transactionRequest === null);
}

console.log("\nPopularity reporting");
{
  const mk = (rewardId, rewardName, qty, cost, status, studentId) => ({
    rewardId, rewardName, rewardCategory: "General",
    quantity: qty, totalCost: cost, status, studentId,
  });
  const receipts = [
    mk("r1", "Homework Pass", 1, 1000, "fulfilled", "s1"),
    mk("r1", "Homework Pass", 1, 1000, "issued", "s2"),
    mk("r1", "Homework Pass", 1, 1000, "cancelled", "s3"),
    mk("r2", "Dress Down", 5, 7500, "fulfilled", "s4"),
    mk("r3", "Extra Recess", 1, 750, "issued", "s1"),
  ];
  const ranked = S.rewardPopularity(receipts);

  check("cancelled purchases are excluded by default",
    ranked.find((r) => r.rewardId === "r1").purchases === 2);
  check("they can be included on request",
    S.rewardPopularity(receipts, { includeCancelled: true })
      .find((r) => r.rewardId === "r1").purchases === 3);
  check("ranking is by UNITS moved, not purchase count",
    ranked[0].rewardId === "r2");
  check("units are summed, not counted", ranked[0].units === 5);
  check("revenue is summed", ranked[0].revenue === 7500);
  check("outstanding vs fulfilled is broken out",
    ranked.find((r) => r.rewardId === "r1").outstanding === 1);
  check("unique students are counted, not purchases",
    ranked.find((r) => r.rewardId === "r1").uniqueStudents === 2);
  check("the internal student set is not leaked in the result",
    ranked[0].students === undefined);
}

console.log("\nFulfillment desk summary");
{
  const receipts = [
    { status: "issued", totalCost: 1000 },
    { status: "issued", totalCost: 500 },
    { status: "fulfilled", totalCost: 2000 },
    { status: "cancelled", totalCost: 750 },
  ];
  const sum = S.receiptSummary(receipts);
  check("counts every state", sum.total === 4 && sum.issued === 2 && sum.fulfilled === 1 && sum.cancelled === 1);
  check("outstanding value is only what is still owed as items", sum.outstandingValue === 1500);
  check("cancelled money is not counted as spent", sum.spentValue === 3500);
}

console.log("\nLooking a receipt up at the desk");
{
  const receipts = [{ id: "WC-ABC234" }, { id: "WC-XYZ789" }];
  check("found by exact code", S.findReceipt(receipts, "WC-ABC234").id === "WC-ABC234");
  check("case insensitive, because it is typed off a screen",
    S.findReceipt(receipts, "wc-abc234").id === "WC-ABC234");
  check("whitespace tolerated", S.findReceipt(receipts, "  WC-ABC234 ").id === "WC-ABC234");
  check("an unknown code returns null rather than the first row",
    S.findReceipt(receipts, "WC-NOPE22") === null);
  check("an empty query matches nothing", S.findReceipt(receipts, "") === null);
}

console.log("\nSchool year boundaries");
// LOCAL dates, because schoolYearOf reads local months on purpose: a school
// year boundary is a calendar fact about where the school is. Date.parse on a
// bare "2027-07-01" is UTC midnight, which is still 30 June in Los Angeles,
// and asserting on that would have pinned the wrong behaviour.
const localNoon = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).getTime();
check("September is the start of a new year", S.schoolYearOf(localNoon(2026, 9, 9)) === "2026-2027");
check("the following March is the SAME school year", S.schoolYearOf(localNoon(2027, 3, 1)) === "2026-2027");
check("June is still the year that started last autumn", S.schoolYearOf(localNoon(2027, 6, 30)) === "2026-2027");
check("July rolls over", S.schoolYearOf(localNoon(2027, 7, 1)) === "2027-2028");
check("the last evening of June does not roll early",
  S.schoolYearOf(new Date(2027, 5, 30, 23, 59).getTime()) === "2026-2027");

console.log("\nYear end rollover");
{
  const students = [
    { id: "A", studentNumber: "101", firstName: "Ada", lastName: "L", grade: "10",
      wildcatCashBalance: 1240, wildcatCashEarned: 2000, wildcatCashSpent: 600, wildcatCashDeducted: 160 },
    { id: "B", studentNumber: "102", firstName: "Grace", lastName: "H", grade: "9",
      wildcatCashBalance: 0, wildcatCashEarned: 500, wildcatCashSpent: 500, wildcatCashDeducted: 0 },
    { id: "C", studentNumber: "103", firstName: "Alan", lastName: "T", grade: "11" },
  ];
  const transactions = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];
  const receipts = [
    { status: "issued" }, { status: "issued" },
    { status: "fulfilled" }, { status: "cancelled" },
  ];

  const roll = S.buildYearEndRollover({
    students, transactions, receipts,
    actor: { name: "Alan K" }, now: localNoon(2026, 9, 9),
    backupRef: "backups/2026-09-09_cash",
  });

  check("the school year is derived", roll.summary.schoolYear === "2026-2027");
  check("who closed it is recorded", roll.summary.closedBy === "Alan K");
  check("the backup it belongs to is referenced", roll.summary.backupRef === "backups/2026-09-09_cash");

  check("every student gets a closing record, including those on zero",
    roll.summary.closingBalances.length === 3);
  check("a student with no cash fields at all is still recorded",
    roll.summary.closingBalances.find((c) => c.studentId === "C").balance === 0);
  check("closing balances carry the student number for later lookup",
    roll.summary.closingBalances[0].studentNumber === "101");

  check("total balance is summed", roll.counts.totalBalance === 1240);
  check("students WITH a balance are counted separately from all students",
    roll.counts.studentsWithBalance === 1 && roll.counts.students === 3);
  check("earned, spent and deducted are summed",
    roll.counts.totalEarned === 2500 && roll.counts.totalSpent === 1100 && roll.counts.totalDeducted === 160);
  check("the ledger size is reported", roll.counts.transactions === 3);

  // A receipt is a promise of an item. Somebody should see how many are
  // outstanding BEFORE agreeing to close the year.
  check("outstanding receipts are counted, not silently dropped",
    roll.counts.receiptsOutstanding === 2);
  check("fulfilled and cancelled are counted separately",
    roll.counts.receiptsFulfilled === 1 && roll.counts.receiptsCancelled === 1);

  check("every student is patched to zero", roll.studentPatches.length === 3);
  check("the patch zeroes the balance", roll.studentPatches[0].wildcatCashBalance === 0);
  check("and the derived counters, so none contradicts a zero balance",
    roll.studentPatches[0].wildcatCashEarned === 0 &&
    roll.studentPatches[0].wildcatCashSpent === 0 &&
    roll.studentPatches[0].wildcatCashDeducted === 0);
  check("and clears the per-student transaction view",
    Array.isArray(roll.studentPatches[0].wildcatCashTransactions) &&
    roll.studentPatches[0].wildcatCashTransactions.length === 0);

  // Computing what WOULD happen must not be destructive.
  check("nothing was mutated by asking", students[0].wildcatCashBalance === 1240);
  check("the transaction list was not touched", transactions.length === 3);

  const empty = S.buildYearEndRollover({ students: [], transactions: [], receipts: [], now: localNoon(2026, 9, 9) });
  check("an empty school does not throw", empty.counts.students === 0);
  check("and reports a zero total rather than NaN", empty.counts.totalBalance === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
