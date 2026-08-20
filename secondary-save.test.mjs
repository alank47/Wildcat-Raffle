// The `secondary` document save.
//
// WHAT THIS DOCUMENT LOST, AND HOW.
//
// `secondary` was written with a whole-document setDoc of whatever the saving
// tab held in memory — the same last-write-wins bug that used to eat
// referrals, left live for everything else sharing the document: detentions,
// hall passes, prevention groups.
//
// Two things were worse than stale. `cashReceipts` was READ from this document
// on load and written only to localStorage, and localStorage is never
// consulted when Firebase loads successfully, so every purchase receipt in the
// school came back empty on every page load. `detentionIdCounter` had the same
// shape of bug in reverse: saved to localStorage, never read back, so it reset
// to 1 each load and new detentions were handed ids that already existed.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-merge.js", import.meta.url), "utf8");
new Function(src)();
const M = globalThis.WildcatMerge;
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const DET_STAMPS = ["updatedAt", "completedAt", "assignedAt"];
const RCPT_STAMPS = ["updatedAt", "cancelledAt", "fulfilledAt", "purchasedAt"];

const det = (id, over = {}) => Object.assign(
  { id, studentName: "A Student", status: "active", daysServed: 0,
    assignedAt: "2026-08-20T08:00:00.000Z" }, over);
const rcpt = (id, over = {}) => Object.assign(
  { id, rewardName: "Snack", totalCost: 5, fulfilled: false,
    purchasedAt: "2026-08-20T08:00:00.000Z" }, over);

console.log("\nA stale tab can no longer destroy another teacher's detention");
{
  // Teacher A assigned detention_2. Teacher B's tab predates it.
  const stored = [det("detention_1"), det("detention_2")];
  const staleLocal = [det("detention_1")];
  const merged = M.mergeById(stored, staleLocal, { stampFields: DET_STAMPS });

  check("the detention this tab never saw survives the save",
    merged.some((d) => d.id === "detention_2"));
  check("and nothing is duplicated", merged.length === 2);

  const report = M.mergeReport(stored, staleLocal, merged);
  check("the save can name what a whole-document write would have destroyed",
    report.wouldHaveLost.includes("detention_2"));
}

console.log("\nAttendance marked on one device is not undone by another");
{
  // A marks a day served; B holds the pre-mark copy and saves.
  const marked = det("detention_1", {
    daysServed: 1, updatedAt: "2026-08-20T15:00:00.000Z",
  });
  const stale = det("detention_1", { daysServed: 0 });

  check("the newer copy wins regardless of which side it is on",
    M.mergeById([marked], [stale], { stampFields: DET_STAMPS })[0].daysServed === 1 &&
    M.mergeById([stale], [marked], { stampFields: DET_STAMPS })[0].daysServed === 1);

  // The stamp is what makes that work, so the app must actually write it.
  check("markDetentionDay stamps the record it changed",
    /detention\.updatedAt = new Date\(\)\.toISOString\(\)/.test(script));
}

console.log("\nReceipts reach Firestore at all, which is new");
{
  check("cashReceipts is written to the secondary document",
    /cashReceipts: \[cashReceipts,/.test(script));
  // The regression that hid for the whole feature's life: written to
  // localStorage, read from Firestore, so always empty on load.
  check("and it is no longer localStorage-only",
    /mergedSecondary\.cashReceipts/.test(script));

  const stored = [rcpt("WC-AAA111"), rcpt("WC-BBB222")];
  const merged = M.mergeById(stored, [rcpt("WC-AAA111")], { stampFields: RCPT_STAMPS });
  check("a receipt raised on another device is not dropped", merged.length === 2);

  // Fulfilment must not be reverted by a tab that loaded before it happened.
  const done = rcpt("WC-AAA111", { fulfilled: true, fulfilledAt: "2026-08-20T16:00:00.000Z" });
  check("a fulfilled receipt beats an older unfulfilled copy",
    M.mergeById([done], [rcpt("WC-AAA111")], { stampFields: RCPT_STAMPS })[0].fulfilled === true);
}

console.log("\nDetention ids cannot be reissued");
{
  check("the counter is written to the secondary document",
    /detentionIdCounter: Math\.max\(/.test(script));
  check("and read back from Firebase on load, not only from localStorage",
    /Number\(secondaryData\.detentionIdCounter\) \|\| 1\)/.test(script));

  // The rule: only ever upward, so a stale tab cannot hand out a used id.
  const next = (localCounter, storedCounter) =>
    Math.max(Number(localCounter) || 1, Number(storedCounter) || 1);
  check("a stale tab adopts the higher stored counter", next(2, 9) === 9);
  check("a tab that has issued ids this session does not go backwards",
    next(12, 4) === 12);
  check("a missing stored counter does not reset anything", next(7, undefined) === 7);
  check("a missing local counter falls back to 1, not 0 or NaN",
    next(undefined, undefined) === 1);
}

console.log("\nThe transaction does not mutate this tab until it commits");
{
  // The lesson from the referral fix: Firestore RETRIES the callback, so a
  // callback that assigns app state leaves the tab claiming rows that were
  // never written when the transaction ultimately fails.
  const body = script.slice(
    script.indexOf("// TRANSACTION 3: the secondary document."),
    script.indexOf("❌ secondary save failed:"));
  check("the merged result is applied after the transaction resolves",
    /if \(mergedSecondary\) \{[\s\S]*?detentions = mergedSecondary\.detentions/.test(body));
  check("the assignment sits outside the runTransaction callback",
    body.indexOf("detentions = mergedSecondary.detentions") >
    body.indexOf("transaction.set(ref, out);"));
  check("a failure is reported rather than swallowed",
    /catch \(secErr\)/.test(script));
}

console.log("\nLists with no id keep their previous behaviour, deliberately");
{
  // loginHistory and the raffle arrays carry no id, so they cannot be merged
  // by one. Saying so out loud stops this reading as an oversight.
  const body = script.slice(
    script.indexOf("// TRANSACTION 3: the secondary document."),
    script.indexOf("❌ secondary save failed:"));
  check("they are written whole", /weeklyWinners,\s*\n\s*bigRaffleWinners,/.test(body));
  check("and the reason is recorded", /No ids on these four/.test(body));
}

console.log("\nReferrals carry their own student number");
{
  // Resolving through the live roster works only while the student is
  // enrolled; a withdrawn student drops off it and their referrals become
  // permanently unmatchable in the race breakdown.
  check("the referral snapshots studentNumber at filing time",
    /studentNumber: \(student\.studentNumber \|\| ''\)/.test(script));
  check("and the lookup prefers it over a roster search",
    /if \(r && r\.studentNumber\) return String\(r\.studentNumber\);/.test(script));
}

console.log("\nDiscipline history is visible to the people who run discipline");
{
  check("admins and PBIS see a student's referral count, not just superadmin",
    /\['admin', 'superadmin', 'pbis'\]\.indexOf\(currentUser\.role\)/.test(script));
  check("the old superadmin-only gate is gone",
    !/role === 'superadmin' && studentReferrals\.length > 0/.test(script));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
