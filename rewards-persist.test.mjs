// The Rewards Store has to actually save.
//
// THE BUG, verified 2026-09-10 with the owner watching. wildcatCashRewards was
// touched in exactly four places in script.js: a hardcoded list of five defaults
// (:1325), a read inside loadDataLocal (:2673) which runs ONLY when the Convex
// load throws, a write into the localStorage blob (:4103) in the success branch
// only, and a lookup at purchase time. It was never sent to any server.
//
// So on every healthy load the app started from those five defaults. An admin's
// edits died on reload, and reward.stock reset to full -- while the RECEIPT and
// the CASH DEBIT for the purchase persisted, because those ride the secondary
// document. Sell an item, keep the receipt, forget the item.
//
// The fix puts the catalogue in secondaryLists, beside cashReceipts, where
// mergeSlice unions rows by id. Two things had to be stamped for that to work at
// all, and both would have half-worked silently.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const storeSrc = readFileSync(new URL("./wildcat-store.js", import.meta.url), "utf8");
const legacy = readFileSync(new URL("./convex/legacyData.ts", import.meta.url), "utf8");
new Function(storeSrc)();
const S = globalThis.WildcatStore;

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\n-- the catalogue is saved, in the list that merges by id --");
{
  const lists = script.slice(script.indexOf("const secondaryLists = {"),
                             script.indexOf("};", script.indexOf("const secondaryLists = {")));
  check("wildcatCashRewards is in secondaryLists", /wildcatCashRewards,/.test(lists));
  check("beside cashReceipts, its sibling", /cashReceipts,/.test(lists));
  // Merged by id, not replaced wholesale: two admins editing different rewards
  // must both survive.
  check("secondaryLists is written with mergeLegacySlice on 'id'",
    /mergeLegacySlice\('secondary', key, value, 'id'\)/.test(script));
  check("the merged result is adopted back onto the global",
    /wildcatCashRewards = mergedSecondary\.wildcatCashRewards;/.test(script));
}

console.log("\n-- and restored on load --");
{
  check("the loader reads the server's catalogue",
    /const serverRewards = secondaryData\.wildcatCashRewards;/.test(script));
  check("it is normalised on the way in", /WildcatStore\.normalizeReward\(r, Date\.now\(\), \{\}\)/.test(script));
  // A school that has never saved a catalogue is not a school with no rewards.
  check("an absent server list leaves the defaults in place to be seeded",
    /Array\.isArray\(serverRewards\) && serverRewards\.length/.test(script));
  // But once the server has one it must win, or a retired reward comes back.
  check("a present server list wins outright, no merge with the defaults",
    !/serverRewards\.concat|\.\.\.serverRewards, \.\.\.wildcatCashRewards/.test(script));
}

console.log("\n-- the two stamps, without which this half-works silently --");
{
  // touchedAt is what decides which copy of a row wins a merge.
  const fields = legacy.slice(legacy.indexOf("function touchedAt"), legacy.indexOf("function touchedAt") + 400);
  check("touchedAt reads updatedAt and the three closing fields",
    /"updatedAt", "loopClosedAt", "closedAt", "submittedAt"/.test(fields));
  check("and NOT retiredAt", !/retiredAt/.test(fields));

  const now = 5000;
  const base = S.normalizeReward({ id: "r1", name: "Hoodie", cost: 100 }, 1000, {});

  // Retiring set only retiredAt, which touchedAt does not read -- so the
  // retirement tied with the stored copy at zero and LOST. The reward came back.
  const retired = S.retireReward(base, now, { name: "Admin" });
  check("retireReward sets retiredAt", retired.retiredAt === new Date(now).toISOString());
  check("retireReward ALSO sets updatedAt, so the retirement wins the merge",
    retired.updatedAt === new Date(now).toISOString());

  check("applyRewardEdit still stamps updatedAt",
    S.applyRewardEdit(base, { cost: 120 }, 7000, {}).updatedAt === new Date(7000).toISOString());

  // A stock decrement is a change to a stored row like any other.
  const stockBlock = script.slice(script.indexOf("if (built.stockAfter !== null)"),
                                  script.indexOf("if (built.stockAfter !== null)") + 900);
  check("a stock decrement stamps updatedAt too", /reward\.updatedAt = new Date\(\)\.toISOString\(\);/.test(stockBlock));
  check("and still leaves unlimited stock as null", /built\.stockAfter !== null/.test(stockBlock));
}

console.log("\n-- what must NOT have changed --");
{
  // The settings row is a whole-value replace; putting the catalogue there
  // would let the last tab to save win the lot.
  check("the catalogue did NOT go into the settings blob",
    !/settings: \{[\s\S]{0,900}wildcatCashRewards/.test(script));
  // No Convex change at all: mergeLegacySlice is generic over (doc, collection).
  const convexRewards = readFileSync(new URL("./convex/legacyData.ts", import.meta.url), "utf8");
  check("legacyData needed no reward-specific code", !/wildcatCashRewards/.test(convexRewards));
  check("the hardcoded defaults are still there as the seed",
    /let wildcatCashRewards = \[/.test(script) && /Homework Pass/.test(script));
  // BOTH localStorage branches carry it. The error-fallback blob is the one
  // moment loadDataLocal actually reads the cache back, so omitting it there
  // made the recovery copy the single one guaranteed not to hold the rewards.
  // Found by an independent check after the first version of this fix shipped.
  const fallback = script.slice(script.indexOf("// Fall back to localStorage only"),
                                script.indexOf("}));", script.indexOf("// Fall back to localStorage only")));
  check("the error-fallback localStorage blob was located", fallback.length > 200);
  check("and it carries the catalogue too", /wildcatCashRewards,/.test(fallback));
  const success = script.slice(script.indexOf("// Also save to localStorage"),
                               script.indexOf("}));", script.indexOf("// Also save to localStorage")));
  check("as does the success branch", /wildcatCashRewards,/.test(success));
}

console.log("\n-- the union really is a union --");
{
  // mergeSlice must not delete a stored row merely because this tab did not
  // send it -- otherwise one stale tab wipes the catalogue.
  const merge = legacy.slice(legacy.indexOf("export const mergeSlice"));
  check("survivors are computed from keptStored", /const survivors = new Set\(keptStored\.map/.test(merge));
  check("every existing row is kept unless it is a duplicate already in storage",
    /if \(seen\.has\(token\)\) continue;\s*\/\/ a duplicate ALREADY in storage/.test(merge));
  check("the stored copy wins unless the incoming one was touched later",
    /touchedAt\(r\.payload\) > touchedAt\(stored\.payload\)/.test(merge));
}

console.log("\n-- a receipt that changes state has to survive the trip --");
{
  // THE SAME BUG, A SECOND TIME, in the row right next to the catalogue.
  // applyFulfill set status/fulfilledAt/fulfilledBy and buildCancel set
  // status/cancelledAt/cancelledBy. touchedAt reads NEITHER fulfilledAt nor
  // cancelledAt, so the changed row scored 0, tied with the stored copy at 0,
  // `incoming > stored` was false, and the server kept the old status. The
  // loader's union then takes the server's copy for any id it already holds,
  // so the change was gone with no error: the desk was told to hand over an
  // item it had already handed over.
  //
  // VERIFIED AGAINST PRODUCTION 2026-09-12, and the timing is the point. All
  // six fulfilments in the audit log happened 2026-08-18 to 2026-08-25;
  // cashReceipts only started going through mergeSlice on 2026-08-31. So the
  // bug was live and had never once fired, with exactly one receipt
  // outstanding (WC-XPSGVE, bought 2026-09-10) waiting to be the first.
  const fields = legacy.slice(legacy.indexOf("function touchedAt"), legacy.indexOf("function touchedAt") + 400);
  check("touchedAt does not read fulfilledAt", !/fulfilledAt/.test(fields));
  check("nor cancelledAt", !/cancelledAt/.test(fields));

  // Receipts ride the same by-id merge the catalogue does, which is what makes
  // the stamp load-bearing rather than decorative.
  check("cashReceipts is in the by-id secondary list",
    /const secondaryLists = \{[\s\S]{0,400}cashReceipts,/.test(script));

  // A balance, or canPurchase refuses and there is no receipt to test.
  const student = { id: "s1", firstName: "Kay", lastName: "L", grade: "8", wildcatCashBalance: 100 };
  const reward = { id: "r1", name: "Homework Pass", cost: 5, category: "General", stock: null, available: true };
  const built = S.buildPurchase({
    student, reward, quantity: 1, actor: { name: "Desk" }, now: 1000, channel: "staff",
  });
  check("a purchase can be built", !!(built && built.ok), built && built.reason);
  const issued = built.receipt;
  check("a new receipt is issued", issued.status === "issued");
  // Null, not a stamp: an insert has nothing to beat, and a value here would
  // let a stale tab's untouched copy outrank a real later change.
  check("a new receipt carries updatedAt as null", issued.updatedAt === null);

  const done = S.applyFulfill(issued, 5000, { name: "Desk" });
  check("applyFulfill marks it fulfilled", done.status === "fulfilled");
  check("applyFulfill sets fulfilledAt", done.fulfilledAt === new Date(5000).toISOString());
  check("applyFulfill ALSO sets updatedAt, so the fulfilment wins the merge",
    done.updatedAt === new Date(5000).toISOString());
  check("the original is not mutated", issued.status === "issued" && issued.updatedAt === null);

  const cancelled = S.buildCancel({
    receipt: issued, student, reason: "Out of stock", refund: true,
    actor: { name: "Desk" }, now: 6000,
  });
  check("a cancel can be built", cancelled.ok, cancelled.reason);
  check("buildCancel marks it cancelled", cancelled.receipt.status === "cancelled");
  check("buildCancel sets cancelledAt", cancelled.receipt.cancelledAt === new Date(6000).toISOString());
  check("buildCancel ALSO sets updatedAt", cancelled.receipt.updatedAt === new Date(6000).toISOString());
  // Why cancelling was the worse of the two: the refund is its own ledger row
  // with its own id, so it INSERTS and sticks regardless of what happens to
  // the receipt. A cancellation that did not persist left the student refunded
  // and the receipt still open to collect against.
  check("cancelling still raises a separate refund transaction",
    !!cancelled.transactionRequest && cancelled.transactionRequest.amount === issued.totalCost);
  check("and the refund is forward-facing, not an edit of the charge",
    cancelled.transactionRequest.amount > 0);

  // The actual merge decision, run for real rather than asserted about.
  const touchedAt = (payload) => {
    let best = 0;
    for (const f of ["updatedAt", "loopClosedAt", "closedAt", "submittedAt"]) {
      const t = Date.parse(payload[f]);
      if (Number.isFinite(t) && t > best) best = t;
    }
    return best;
  };
  check("BEFORE: an unstamped fulfilment tied with the stored copy and lost",
    !(0 > touchedAt(issued)));
  check("AFTER: the fulfilment outscores the stored issued copy",
    touchedAt(done) > touchedAt(issued));
  check("AFTER: the cancellation does too", touchedAt(cancelled.receipt) > touchedAt(issued));
  // And a receipt already stored WITHOUT a stamp -- all four in production --
  // still loses to a fulfilment, which is what makes this fix retroactive.
  check("an already-stored unstamped receipt loses to a new fulfilment",
    touchedAt(done) > touchedAt({ ...issued, updatedAt: undefined }));

  // A stale tab holding the issued copy must not undo a fulfilment that landed.
  check("a stale untouched copy cannot beat a stamped fulfilment",
    !(touchedAt(issued) > touchedAt(done)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
