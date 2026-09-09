// The staleness guard must not eat a teacher's referral.
//
// THE INCIDENT, 2026-09-08, from Laura Baltazar's console:
//
//   🛑 SAVE BLOCKED: local data is stale.
//      Server: 2026-09-08T23:37:21.776Z
//      Local:  2026-09-08T23:31:37.978Z
//      Reloading from Firebase before save...
//
// saveData refused the save because somebody else had saved while she was
// typing, called loadData(), and loadData ASSIGNS behaviorReferrals from the
// server copy. Her referral existed only in that array. It was destroyed
// before it was ever written, and she was shown a success toast, because the
// blocked path returned undefined and every caller tests `ok === false`.
//
// Two separate faults, both fixed here, both asserted:
//   1. a forced reload discarded unsaved work instead of rebasing it
//   2. a blocked save reported itself as a successful one
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const disc = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");
new Function(disc)();
const D = globalThis.WildcatDiscipline;

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const start = script.indexOf("async function saveData()");
const end = script.indexOf("\n        function ", start + 10);
const save = script.slice(start, end > start ? end : start + 60000);

console.log("\n-- the function was located --");
{
  check("saveData found and bounded", start !== -1 && save.length > 5000);
}

console.log("\n-- NO BLOCKED PATH RETURNS undefined --");
{
  // `ok === false` is the contract every caller uses. undefined is not false,
  // so a bare `return` here is a save that never happened being reported as
  // one that did. That is what put a green toast on Laura's screen.
  const bare = [...save.matchAll(/\n\s*return;/g)];
  check("no bare `return;` survives in saveData", bare.length === 0);
  check("the busy-syncing path returns false",
    /if \(isSyncing\) \{[\s\S]{0,400}return false;/.test(save));
  // 2026-09-09: the staleness path no longer reloads or refuses. The server
  // merges (cash union, referral newer-wins, counters as deltas), so a save
  // from a tab behind the server is applied, not blocked.
  check("the staleness path neither reloads nor refuses",
    /if \(serverTs > localTs \+ STALENESS_THRESHOLD_MS\) \{\s*console\.log\('\[save\] the server has newer saves than this tab; merging on the server, not reloading'\);\s*\}/.test(save));
  check("the cycle guard returns false",
    /outdated cycle number[\s\S]{0,300}return false;/.test(save));
  check("the week guard returns false",
    /outdated week number[\s\S]{0,300}return false;/.test(save));
}

console.log("\n-- a forced reload REBASES, it does not discard --");
{
  check("the destructive bare loadData() is gone from the guards",
    !/isSyncing = false;\s*\n\s*(\/\/[^\n]*\n\s*)*await loadData\(\);/.test(save));
  check("the two rollback guards reload through the preserving path, and only they do",
    (save.match(/await reloadPreservingUnsavedWork\(\)/g) || []).length === 2);

  const fn = script.slice(script.indexOf("async function reloadPreservingUnsavedWork"),
                          script.indexOf("async function saveData()"));
  check("it snapshots the referrals BEFORE reloading",
    fn.indexOf("behaviorReferrals.slice()") < fn.indexOf("await loadData()"));
  check("and merges them back AFTER", fn.indexOf("mergeReferrals") > fn.indexOf("await loadData()"));
  check("using the tested union rule, not an assignment",
    /D\.mergeReferrals\(pendingReferrals, behaviorReferrals\)/.test(fn));
  check("the table is redrawn so the referral is visibly still there",
    /updateReferralReviewTable/.test(fn));
  check("it survives WildcatDiscipline being absent rather than throwing",
    /typeof D\.mergeReferrals === 'function'/.test(fn));
}

console.log("\n-- the rebase actually preserves the referral --");
{
  // The real merge, executed on the shape of the incident: a tab holding one
  // unsaved referral, reloading a server copy that has never seen it.
  const hers = { id: "REF-LAURA", studentName: "A Student", updatedAt: "2026-09-08T23:35" };
  const serverAfterReload = [
    { id: "REF11", updatedAt: "2026-09-01" },
    { id: "REF-260908-MEENDXM", updatedAt: "2026-09-08T23:20" },
  ];
  const pending = [ ...serverAfterReload, hers ];
  const merged = D.mergeReferrals(pending, serverAfterReload);
  check("her unsaved referral survives the reload",
    merged.referrals.some((r) => r.id === "REF-LAURA"));
  check("and the server's referrals are all still there",
    serverAfterReload.every((s) => merged.referrals.some((r) => r.id === s.id)));
  check("nothing is duplicated",
    merged.referrals.length === new Set(merged.referrals.map((r) => r.id)).size);
}

console.log("\n-- no retry, because there is nothing to retry --");
{
  // The reload-and-retry was a second full load per blocked save. With no
  // reload there is no retry, and the flag that bounded it is gone with it.
  check("the retry flag is gone", !/_staleSaveRetry/.test(script));
  check("and so is the give-up message", !/still stale after one retry/.test(save));
  check("the staleness path no longer tells the teacher to re-do their work",
    !/out of date and has been refreshed from the cloud/.test(save));
}

console.log("\n-- the threshold --");
{
  check("the threshold is 3 minutes, not 1", /STALENESS_THRESHOLD_MS = 180000/.test(save));
  check("the comparison is still made, and logged, so a tab behind the server can be seen in its console",
    /serverTs > localTs \+ STALENESS_THRESHOLD_MS/.test(save));
  check("the week guard still refuses to roll a week backwards",
    /would roll currentWeek backwards/.test(save));
  check("the cycle guard still refuses to roll a cycle backwards",
    /would roll currentCycle backwards/.test(save));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
