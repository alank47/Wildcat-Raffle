// The Rewards Store's "Recent Redemptions" box shows every sale.
//
// Found 2026-09-30, the morning after the Power-Up Pass sale: the box read
// each student's wildcatCashRewardsRedeemed, which only an OFFICE sale writes.
// studentStore.ts (the student store) never has, so the box showed none of
// the 25 passes students bought and looked as though they had not gone
// through, while "What sells" beside it, reading the receipts, showed all 25.
// The owner: "fix the redemptions box".
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-store.js", import.meta.url), "utf8");
new Function(src)();
const S = globalThis.WildcatStore;
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  (" + d + ")" : ""}`); }
};

const receipt = (id, at, extra = {}) => ({
  id, studentId: "s" + id, studentName: "Student " + id, rewardId: "r1", rewardName: "Power-Up Pass (HS)",
  quantity: 1, totalCost: 1500, purchasedAt: at, status: "issued", channel: "student", ...extra,
});

console.log("\nStudent-store sales appear");
{
  const receipts = [
    receipt("A", "2026-09-29T15:25:28.135Z"),
    receipt("B", "2026-09-29T22:21:49.317Z"),
    receipt("C", "2026-09-29T17:16:59.000Z", { rewardName: "Power-Up Pass (MS)" }),
  ];
  const out = S.recentRedemptions(receipts, [], 20);
  check("every student-store receipt is listed", out.length === 3);
  check("newest first", out.map((r) => r.id).join(",") === "B,C,A", out.map((r) => r.id).join(","));
  check("says it was the student store", out.every((r) => r.by === "Student store"));
  check("shows what was paid", out.every((r) => r.cost === 1500));
  check("even though no student record carries it", S.recentRedemptions(receipts, [{ firstName: "x", wildcatCashRewardsRedeemed: [] }]).length === 3);
}

console.log("\nOffice sales and older data");
{
  const office = receipt("D", "2026-09-10T18:00:00Z", { channel: "staff", purchasedBy: { name: "Leah R" } });
  const students = [
    // The same office sale, also on the student's own list: shown ONCE.
    { firstName: "Ana", lastName: "Diaz", wildcatCashRewardsRedeemed: [
      { receiptId: "D", rewardName: "Power-Up Pass (HS)", cost: 1500, timestamp: "2026-09-10T18:00:00Z", redeemedBy: "Leah R" },
      // From before receipts existed: no receipt carries it, so it still shows.
      { rewardName: "Homework Pass", cost: 200, timestamp: "2026-08-20T17:00:00Z", redeemedBy: "Mr. K" },
    ] },
  ];
  const out = S.recentRedemptions([office], students, 20);
  check("an office sale on both lists is shown once", out.filter((r) => r.id === "D").length === 1);
  check("it names who sold it", out.find((r) => r.id === "D").by === "Leah R");
  check("an older sale with no receipt still appears", out.some((r) => r.rewardName === "Homework Pass" && r.studentName === "Ana Diaz"));
}

console.log("\nCancelled, limits and junk");
{
  const out = S.recentRedemptions([receipt("E", "2026-09-29T16:00:00Z", { status: "cancelled", refundTxId: "txn_r1" })], [], 20);
  check("a cancelled sale stays, marked cancelled", out.length === 1 && out[0].cancelled === true);
  check("... and refunded when a refund was recorded", out[0].refunded === true);
  // Review finding 2026-09-30: a cancel does not always refund (before a
  // reset, undated, no matching student, or a refund withdrawn later).
  const noRefund = S.recentRedemptions([receipt("F", "2026-09-29T16:00:00Z", { status: "cancelled", refundTxId: null })], [], 20);
  check("a cancel with no refund recorded is NOT called refunded", noRefund[0].cancelled === true && noRefund[0].refunded === false);
  check("an issued sale is neither", S.recentRedemptions([receipt("G", "2026-09-29T16:00:00Z")], [], 20)[0].refunded === false);
  const many = Array.from({ length: 30 }, (_, i) => receipt("M" + i, new Date(Date.UTC(2026, 8, 29, 15, i)).toISOString()));
  check("at most 20 by default", S.recentRedemptions(many, []).length === 20);
  check("the newest 20", S.recentRedemptions(many, [], 20)[0].id === "M29");
  check("junk does not throw", S.recentRedemptions([null, {}, { id: "" }], [null, {}], 20).length === 0);
  check("a receipt with no date sorts last rather than breaking the order",
    S.recentRedemptions([receipt("N", ""), receipt("O", "2026-09-29T16:00:00Z")], [], 20)[0].id === "O");
}

console.log("\nThe screen uses it");
{
  const fn = script.slice(script.indexOf("function updateRedemptionHistory()"), script.indexOf("// Update Student Accounts"));
  check("the box reads the receipts through recentRedemptions",
    /WildcatStore\.recentRedemptions\(cashReceipts, students, 20\)/.test(fn));
  const code = fn.replace(/^\s*\/\/.*$/gm, "");
  check("it no longer reads wildcatCashRewardsRedeemed itself", !/wildcatCashRewardsRedeemed/.test(code));
  check("the screen says NOT refunded unless a refund was recorded",
    /redemption\.refunded \? ' <strong>\(cancelled, refunded\)<\/strong>' : ' <strong>\(cancelled, NOT refunded\)<\/strong>'/.test(fn));
  check("the cost is struck through only when refunded", /redemption\.refunded \? ' text-decoration: line-through;'/.test(fn));
  check("names are escaped (a student name is data, not HTML)",
    /escapeHtml\(redemption\.studentName\)/.test(fn) && /escapeHtml\(what\)/.test(fn));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
