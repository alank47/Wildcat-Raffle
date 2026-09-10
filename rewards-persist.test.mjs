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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
