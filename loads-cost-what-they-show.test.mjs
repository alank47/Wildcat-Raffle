// A load reads what the screen shows, and nothing reloads the world.
// Run: npm test
//
// From the Convex dashboard on 2026-09-09: Database I/O at 37 of the 50 GB
// a month the plan includes, with eight days left, and function calls at
// 269K of 25M. One teacher page load walked 145 documents and read about
// 46 MB, almost all of it the six raffle ticket-history documents and the
// legacy audit months, neither of which Cash mode shows. The staleness
// guard then repeated that whole load before any save from a tab that had
// not itself saved in three minutes, and the idle refresh repeated it from
// every quiet tab in the school.
//
// This file pins the four changes: audit months only when the table fails,
// ticket histories only when Raffle mode opens (and unwritable until then),
// no reload from the staleness guard, and an idle refresh that reads the
// roster instead of everything.
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const code = script.replace(/^\s*\/\/.*$/gm, "");
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };
const between = (a, b, from = 0) => {
  const s = code.indexOf(a, from);
  const e = code.indexOf(b, s + a.length);
  return s >= 0 && e > s ? code.slice(s, e) : "";
};

console.log("\nA load fetches the four documents Cash and Discipline use");
{
  check("the cash-mode set is named", /const LEGACY_CASH_MODE_DOCS = \['main', 'secondary', 'referrals', 'schedules'\];/.test(code));
  check("the six ticket-history documents are named as a set",
    /const TICKET_HISTORY_DOCS = \[\s*'ticket_history', 'ticket_history_ms', 'ticket_history_hs',\s*'ticket_history_hs_910', 'ticket_history_hs_1112', 'ticket_history_unknown'\s*\];/.test(code));
  check("the load fetches the cash-mode set, the histories only when wanted, and the cash weeks",
    /loadLegacyDocsFromConvex\(\s*LEGACY_CASH_MODE_DOCS\s*\.concat\(_ticketHistoriesWanted \? TICKET_HISTORY_DOCS : \[\]\)\s*\.concat\(_cashWeekKeys\.map\(wk => `cash_tx_\$\{wk\}`\)\)\);/.test(code));
  check("LEGACY_FIXED_DOCS is no longer what a load fetches", !/loadLegacyDocsFromConvex\(\s*LEGACY_FIXED_DOCS/.test(code));
  check("snapshots read the document map lazily, so a later fetch is seen",
    /const snapOf = \(name\) => \(\{\s*exists: \(\) => Boolean\(_legacy\[name\]\),\s*data: \(\) => _legacy\[name\] \|\| \{\}\s*\}\);/.test(code));
}

console.log("\nThe legacy audit months are read only when the table cannot be");
{
  const fallback = between("table read failed, falling back to documents", "monthlyAuditSnaps.forEach");
  check("the fetch sits inside the table read's catch", /loadLegacyDocsFromConvex\(\s*monthKeys\.map\(auditDocName\)\.concat\(\['audit_log'\]\)\)/.test(fallback));
  check("and lands in the same map the snapshots read", /Object\.assign\(_legacy, fallback\.docs \|\| \{\}\)/.test(fallback));
  check("a failed fallback is reported, not thrown", /document fallback failed too/.test(fallback));
}

console.log("\nThe raffle ticket histories load when Raffle mode opens, and not before");
{
  check("a session starts without them", /let _ticketHistoriesWanted = false;/.test(code));
  check("until then they are unread, so no save can write over them",
    /if \(!_ticketHistoriesWanted\) TICKET_HISTORY_DOCS\.forEach\(d => unreadLegacyDocs\.add\(d\)\);/.test(code));
  const fn = between("async function loadTicketHistoriesOnDemand()", "THE AUDIT LOG AND THE ACTIVITY PANELS ARE LIVE");
  check("the on-demand loader exists and runs once", /if \(_ticketHistoriesWanted\) return;\s*_ticketHistoriesWanted = true;/.test(fn));
  check("it fetches exactly that set", /loadLegacyDocsFromConvex\(TICKET_HISTORY_DOCS\)/.test(fn));
  check("documents that arrived become writable again; failures stay unread",
    /\(result\.failed \|\| \[\]\)\.forEach\(d => unreadLegacyDocs\.add\(d\)\);\s*TICKET_HISTORY_DOCS\.forEach\(d => \{ if \(docs\[d\]\) unreadLegacyDocs\.delete\(d\); \}\);/.test(fn));
  check("histories are unioned by entryId with what the tab already holds", /if \(!byId\.has\(id\)\) byId\.set\(id, \{ \.\.\.e, entryId: id \}\);/.test(fn));
  check("opening Raffle mode triggers it", /if \(mode === 'raffle'\) \{\s*loadTicketHistoriesOnDemand\(\)/.test(code));
  check("so does the raffle tab", /if \(tabName === 'raffle'\) \{\s*loadTicketHistoriesOnDemand\(\)/.test(code));
  const writer = between("async function commitHistoryDoc(docName, localHistoriesForThisDoc) {", "const tombstonedIds = new Set(localTombstones");
  check("the history writer does nothing in a session that never loaded them",
    /if \(!_ticketHistoriesWanted\) return \{ mergedHistories: \{\}, skipped: 'raffle history not loaded this session' \};/.test(writer));
}

console.log("\nThe staleness guard no longer reloads the world before a save");
{
  const save = between("async function saveData()", "return saveSucceeded;");
  check("a server that is ahead is logged, not reloaded",
    /if \(serverTs > localTs \+ STALENESS_THRESHOLD_MS\) \{\s*console\.log\('\[save\] the server has newer saves than this tab; merging on the server, not reloading'\);\s*\}/.test(save));
  check("the week and cycle rollback guards still reload, and only they do",
    (save.match(/await reloadPreservingUnsavedWork\(\)/g) || []).length === 2 && /would roll currentWeek backwards/.test(save) && /would roll currentCycle backwards/.test(save));
  check("no retry machinery is left", !/_staleSaveRetry/.test(code));
}

console.log("\nThe idle refresh reads the roster, not everything");
{
  const idle = between("Auto-refreshing data in background", "Background data sync complete");
  check("it refreshes the roster through appData:load", /await refreshRosterFromConvex\('idle refresh', \{ redraw: false \}\);/.test(idle));
  check("and not through a full loadData()", !/await loadData\(\)/.test(idle));
  check("this tab's unconfirmed cash is put back on top",
    /const pendingCash = snapshotPendingCashDeltas\(\);[\s\S]{0,300}reapplyPendingCashDeltas\(pendingCash\);/.test(idle));
  check("the audit and cash panels are pulled by the live path", /pullLiveActivity\('idle'\)/.test(idle));
  const refresh = between("async function refreshRosterFromConvex(reason, opts)", "rosterSource = 'convex';");
  check("the roster refresh takes an opts argument", refresh.length > 0);
  check("and honours redraw: false, so an idle tab is not navigated",
    /if \(!\(opts && opts\.redraw === false\)\) \{[\s\S]{0,400}switchTab\(named \? named\[1\] : 'tickets'\);/.test(code));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
