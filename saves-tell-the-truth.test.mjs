// A save tells the truth, sends only what changed, and the screens are live.
// Run: npm test
//
// 2026-09-08, the evening before launch with forty staff. Three reports in a
// row of awards and referrals that "showed on my screen but not on the
// server", and an audit log that never moved. The mechanisms were all in the
// code, all deterministic:
//
//   - saveData returned true when every Convex write had thrown and only
//     localStorage was written, and returned false to a queue that treated
//     any resolved value as success, so refused work was never retried.
//   - the three cash award paths showed a green toast before the save, and
//     two of them called saveData() directly, which dropped the save after
//     100ms if another was in flight.
//   - every save sent 734 students (360KB) and the whole cash week, which the
//     server then REPLACED, deleting a colleague's award.
//   - the audit log and every activity panel were refilled only by a full
//     loadData(), which an active teacher never triggered.
//
// This file pins the shape of each fix in script.js. The pure pieces have
// their own tests: wildcat-savequeue.test.mjs (false re-arms the queue) and
// convex/cashSliceUnion.test.mjs, convex/saveReadSet.test.mjs (the server).
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const code = script.replace(/^\s*\/\/.*$/gm, "");
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };
const fn = (name) => {
  const start = code.indexOf(`async function ${name}(`);
  if (start < 0) return "";
  return code.slice(start, start + 15000);
};

const saveStart = code.indexOf("async function saveData()");
const save = code.slice(saveStart, code.indexOf("return saveSucceeded;", saveStart) + 40);

console.log("\nThe return value is true only when everything reached the server");
{
  check("failures are collected by name", /const writesFailed = \[\];/.test(save));
  check("the students write is one of them", /writesFailed\.push\('students'\)/.test(save));
  check("referrals too", /writesFailed\.push\('referrals'\)/.test(save));
  check("the audit log too", /auditSaveSucceeded = false;\s*writesFailed\.push\('audit'\)/.test(save));
  check("each cash and schedule write too", /writesFailed\.push\(writeNames\[i\]\)/.test(save));
  check("and the localStorage fallback path is a failure, not a success",
    /writesFailed\.push\('convex'\);[\s\S]{0,120}console\.error\('❌ Firebase save error:'/.test(save));
  check("success is the absence of failures", /saveSucceeded = writesFailed\.length === 0;/.test(save));
  check("the old unconditional true is gone", !/^\s*saveSucceeded = true;/m.test(save));
  check("a preview-mode save is still refused with false",
    /Exit teacher view to make changes\.'\);[\s\S]{0,300}return false;/.test(save));
  check("a save in flight is waited for, up to twenty seconds",
    /for \(let waited = 0; isSyncing && waited < 20000; waited \+= 100\)/.test(save));
  check("and still refused honestly after that", /if \(isSyncing\) \{[\s\S]{0,400}return false;/.test(save));
}

console.log("\nOne freshness read per save, not three");
{
  check("the peek is memoised inside the save", /const peekOnceInSave = \(\) =>/.test(save));
  check("the counters read it", /const serverCounters = \(await peekOnceInSave\(\)\)\.data\(\)/.test(save));
  check("the staleness guard reads it", /const mainPeek = await peekOnceInSave\(\);/.test(save));
  check("the week and cycle guards read it", /const weekPeek = await peekOnceInSave\(\);/.test(save));
  check("nothing in saveData calls peekServerState directly any more",
    (save.match(/await peekServerState\(\)/g) || []).length === 0);
}

console.log("\nOnly what changed goes on the wire");
{
  check("students are fingerprinted per id", /const _studentSaveFingerprint = new Map\(\);/.test(code));
  check("a save sends only students whose shape differs",
    /const changedStudents = studentsForConvex\.filter\(st =>\s*st && JSON\.stringify\(st\) !== _studentSaveFingerprint\.get\(String\(st\.id\)\)\);/.test(save));
  // The second half was /convexMutation\('appData:save', \{\s*students: …/ and
  // broke on 2026-09-13 when a `clientVersion` field was added ahead of
  // `students`. The property is which LIST is sent, not which key is first.
  check("and that, with each one's cash delta attached, is what appData:save receives",
    /const studentsToSend = changedStudents\.map\(st => \{\s*const base = _studentCashBase\.get\(String\(st\.id\)\);\s*return base \? Object\.assign\(\{\}, st, \{ cashDelta: cashDeltaBetween\(st, base\) \}\) : st;/.test(save)
    && /students: studentsToSend,/.test(save));
  // AND THE BUILD IS NAMED. A save that cannot say which build sent it is a
  // save the server cannot refuse, which is how a four-day-stale tab put
  // $4,901,850 back on 2026-09-13.
  check("the save says which build is asking", /clientVersion: \(typeof APP_VERSION/.test(save));
  check("the fingerprint is recorded only after the server answered",
    /\}, session\.idToken\);\s*changedStudents\.forEach\(st =>\s*_studentSaveFingerprint\.set/.test(save));
  check("a load forgets every fingerprint", /auditIdsOnServer = new Set\(\);\s*_studentSaveFingerprint\.clear\(\);/.test(code));
  check("cash rows the server confirmed are tracked", /let cashIdsOnServer = new Set\(\);/.test(code));
  check("filled from the weekly documents at load",
    /cashIdsOnServer = new Set\(cashTransactions\.map\(t => t && t\.id\)\.filter\(Boolean\)\);/.test(code));
  check("a save skips confirmed rows and rows with no id",
    /if \(!t \|\| !t\.id \|\| cashIdsOnServer\.has\(t\.id\)\) return;/.test(save));
  check("cash goes through the union, by id, never the replace",
    /mergeLegacySlice\(`cash_tx_\$\{wk\}`, 'transactions', txs, 'id'\)/.test(save) && !/saveLegacySlice\(`cash_tx_/.test(save));
  check("and rows are confirmed only after the write resolves",
    /\.then\(r => \{\s*txs\.forEach\(t => cashIdsOnServer\.add\(t\.id\)\);/.test(save));
  check("and the outbox is pruned in the same callback, never before it",
    /\.then\(r => \{\s*txs\.forEach\(t => cashIdsOnServer\.add\(t\.id\)\);\s*pruneCashOutbox\(cashIdsOnServer\);\s*return r;/.test(save));
  check("a failed audit table read offers only entries minted here, not the whole log",
    /if \(tableUnread && !auditIdsMintedHere\.has\(id\)\) return false;/.test(save));
  check("the outbox is pruned to what the server confirmed, not wiped",
    /pruneAuditOutbox\(auditIdsOnServer\)/.test(save) && /function pruneAuditOutbox\(confirmedIds\)/.test(code));
}

console.log("\nThe toast follows the save, on every award path");
{
  for (const [name, reason] of [["awardCashToSelected", "Cash award"], ["confirmAddCash", "Cash award"], ["confirmRemoveCash", "Cash adjustment"]]) {
    const body = fn(name);
    const saveAt = body.indexOf(`await requestSave('${reason}')`);
    const okAt = body.indexOf("showToast(`✅");
    check(`${name} awaits the queue`, saveAt > 0);
    check(`${name} claims success only after it`, okAt > saveAt);
    // Was `if (ok === false)`. That treated null (nothing dirty) and
    // undefined (coalesced) as success and ticked an unsaved award.
    check(`${name} says NOT saved unless the outbox is empty`,
      /if \(!allCashOnServer\(ok\)\) \{[\s\S]{0,200}NOT saved yet/.test(body));
    check(`${name} no longer accepts a merely non-false result`,
      !/if \(ok === false\) \{[\s\S]{0,200}NOT saved yet/.test(body));
    check(`${name} marks the work unsaved until confirmed`, /markCashUnsaved\(unsavedKey/.test(body));
    check(`${name} no longer calls saveData() directly`, !/await saveData\(\)/.test(body));
  }
  const tickets = fn("awardTicketsToSelected");
  check("tickets keep the result", /const ticketSaveOk = await requestSave\('Ticket award'\)/.test(tickets));
  check("and the confetti toast is conditional on it", /if \(ticketSaveOk !== false\) showSuccessToast/.test(tickets));
  check("a successful save clears the referrals that were unsaved when it began",
    /unsavedAtStart\.referrals\.forEach\(id => _unsavedReferrals\.delete\(id\)\);/.test(save));
  // Cash is NOT cleared on "no write threw": a pass with nothing dirty throws
  // nothing and sends nothing, and that cleared the bar on 2026-09-17 while an
  // award was still only in the tab.
  check("but clears cash only when the outbox confirms it",
    /if \(readCashOutbox\(\)\.length === 0\) \{\s*unsavedAtStart\.cash\.forEach\(id => _unsavedCash\.delete\(id\)\);/.test(save));
  check("the retry button always makes a real save, since a quiet queue used to read as saved",
    /ok === null \|\| ok === undefined\) ok = await requestSave/.test(code) &&
    /\[\.\.\._unsavedCash\.keys\(\)\]\.forEach\(id => _unsavedCash\.delete\(id\)\);/.test(code));
  check("the self-update will not reload over unsaved work",
    /if \(_unsavedReferrals\.size \|\| _unsavedCash\.size\) return true;/.test(code));
}

console.log("\nCash counters travel as deltas, so two tabs awarding the same child add up");
{
  // The pure pieces are lifted out of the shipped script.js and run.
  const lift = (name) => {
    const start = code.indexOf(`function ${name}(`);
    const end = code.indexOf("\n        }\n", start) + 11;
    return code.slice(start, end);
  };
  const fields = "const CASH_COUNTER_FIELDS = ['wildcatCashBalance', 'wildcatCashEarned', 'wildcatCashSpent', 'wildcatCashDeducted'];";
  const H = new Function(fields + lift("cashCountersOf") + lift("cashDeltaBetween") + lift("serverCashCounters") +
    "\nreturn { cashCountersOf, cashDeltaBetween, serverCashCounters };")();
  const base = H.cashCountersOf({ wildcatCashBalance: 100, wildcatCashEarned: 100 });
  check("the base carries all four counters, zero when absent",
    base.wildcatCashBalance === 100 && base.wildcatCashSpent === 0 && base.wildcatCashDeducted === 0);
  const d = H.cashDeltaBetween({ wildcatCashBalance: 90, wildcatCashEarned: 100, wildcatCashDeducted: 10 }, base);
  check("a deduction is a negative balance delta and a positive deducted delta",
    d.wildcatCashBalance === -10 && d.wildcatCashDeducted === 10 && d.wildcatCashEarned === 0);
  check("no movement is all zeros", Object.values(H.cashDeltaBetween(base, base)).every((v) => v === 0));
  check("the server's counters are taken only where it has them",
    JSON.stringify(H.serverCashCounters({ wildcatCashBalance: 5, wildcatCashEarned: "x" })) === '{"wildcatCashBalance":5}');

  // The gap is not pinned: loadRosterFromConvex also records the server's
  // history cutoff between these two statements now. What matters is that the
  // base is taken from what the SERVER returned, in the function that returns
  // it -- not from the local array.
  check("the base is recorded from what the server returned at load",
    /data\.students\.forEach\(rememberCashBase\);[\s\S]{0,400}return \{\s*students: data\.students,/.test(code));
  check("and again from what was sent, once the server answered",
    /_studentSaveFingerprint\.set\(String\(st\.id\), JSON\.stringify\(st\)\)\);[\s\S]{0,200}changedStudents\.forEach\(rememberCashBase\);/.test(save));
  // ORDER IS THE WHOLE ASSERTION: the counters must be spread AFTER
  // ...localStudent so the server's values win. What follows them is not
  // pinned -- the cash history is taken from the server on the next line now
  // (see cash-history-cutoff.test.mjs), which is the same fix applied to the
  // one cash field this rule had missed.
  check("the load-time merge takes the server's counters over the local overlay",
    /\.\.\.localStudent,[^\n]*\n[\s\S]{0,600}\.\.\.serverCashCounters\(serverStudent\),/.test(code)
    && code.indexOf("...localStudent,") < code.indexOf("...serverCashCounters(serverStudent),"));
  check("a rollback reload keeps this tab's own unconfirmed movement, as a delta",
    /const pendingDeltas = snapshotPendingCashDeltas\(\);\s*await loadData\(\);\s*reapplyPendingCashDeltas\(pendingDeltas\);/.test(code)
    && /function snapshotPendingCashDeltas\(\)/.test(code) && /function reapplyPendingCashDeltas\(pending\)/.test(code));
  const shape = readFileSync(new URL("./convex/appDataShape.ts", import.meta.url), "utf8");
  // Not pinned to the argument list: planPatch grew a fourth parameter (the
  // history cutoff) and this assertion failed for a change that had nothing to
  // do with what it is checking, which is that planSave routes every record
  // through it rather than writing the record straight to the row.
  check("the server applies them (appDataShape.planPatch)", /export function planPatch\(/.test(shape) && /const patch = planPatch\(row, record, writable\b/.test(shape));
}

console.log("\nThe audit log and the activity panels are live");
{
  check("an incremental pull exists", /async function pullAuditSince\(\)/.test(code));
  check("it asks for entries since the newest one it holds, with overlap",
    /new Date\(newest - 120000\)\.toISOString\(\)/.test(code) && /'auditLog:list',\s*Object\.assign\(\{\}, since \? \{ since \} : \{\}/.test(code));
  check("it unions by entryId and keeps local-only entries", /if \(have\.has\(id\) \|\| tombstonedIds\.has\(id\)\) return;\s*have\.add\(id\);\s*auditLog\.push/.test(code));
  check("it confirms what it saw, so the next save does not resend it", /auditIdsOnServer\.add\(id\);\s*if \(have\.has\(id\)/.test(code));
  check("the current cash week is pulled the same way", /async function pullCashWeek\(\)/.test(code) && /cashIdsOnServer\.add\(t\.id\);\s*if \(have\.has\(t\.id\)\) return;/.test(code));
  check("opening a tab pulls", /wcRememberTab\(tabName\);\s*setTimeout\(function \(\) \{ pullLiveActivity\('tab:' \+ tabName\); \}, 0\);/.test(code));
  check("a visible tab pulls every thirty seconds", /const LIVE_ACTIVITY_MS = 30000;/.test(code) && /setInterval\(function \(\) \{ pullLiveActivity\('tick'\); \}, LIVE_ACTIVITY_MS\);/.test(code));
  check("a hidden tab does not", /if \(_liveActivityBusy \|\| document\.hidden\) return;/.test(code));
  check("and only when an activity panel is on screen", /if \(!wcActivityPanelOnScreen\(\)\) return;/.test(code));
  check("it repaints only what is on screen and only when something arrived",
    /if \(!audit && !cash\) return;/.test(code) && /wcPanelOnScreen\('auditContent'\) && typeof updateAuditLogTable === 'function'\) updateAuditLogTable\(true\)/.test(code));
  check("the rebase after a stale reload keeps unsent audit entries and cash",
    /const pendingAudit = \(auditLog \|\| \[\]\)\.filter/.test(code) && /const pendingCash = \(cashTransactions \|\| \[\]\)\.filter\(t => t && t\.id && !cashIdsOnServer\.has\(t\.id\)\);/.test(code));
}

console.log("\nA hidden tab stops polling the hall-pass boards");
{
  check("the monitor's 30s poll", /setInterval\(function \(\) \{ if \(!document\.hidden\) updateHallMonitor\(\); \}, 30000\)/.test(code));
  check("the monitor's 10s poll", /if \(document\.hidden\) return;[^\n]*\n\s*updateHallMonitor\(\);/.test(code));
  check("the active board", /if \(document\.hidden\) return;\s*renderActivePassesBoard\(\);/.test(code));
  check("the pass-request alert", /setInterval\(function \(\) \{ if \(!document\.hidden\) wcPollPassRequests\(\); \}, 8000\)/.test(code));
  check("the dashboard board", /setInterval\(function \(\) \{ if \(!document\.hidden\) loadHallPassBoard\(\); \}, 20000\)/.test(code));
}

console.log("\nA full localStorage cache cannot report a server write as lost");
{
  // 2026-09-17, 8:11am. Awarding 100 to a student wrote every Convex store --
  // main, students, cash_tx_2026_W38, audit, secondary, all logged OK -- and
  // then localStorage.setItem threw QuotaExceededError, because the blob
  // carried the whole audit log (10,261 entries, 4.43MB, over the ~5MB quota
  // on its own). The outer catch attributed that to 'convex', saveSucceeded
  // went false, the teacher was told the award had not gone through, and the
  // coalesced queue replayed the save four times. The award was on the server
  // from the first attempt. A cache is not a destination and its overflow is
  // not a lost award.
  const helper = code.slice(code.indexOf("function cacheLocally("),
                            code.indexOf("async function saveData()"));
  check("the cache write is its own helper, outside the save's try", helper.length > 0);
  check("the setItem is wrapped", /try \{\s*localStorage\.setItem\('raffleData'/.test(helper));
  check("an overflow retries with only the audit log's tail",
    /auditLog: full\.slice\(-LOCAL_CACHE_AUDIT_MAX\)/.test(helper));
  check("a second failure warns and returns false",
    /catch \(err2\) \{[\s\S]{0,500}console\.warn\([\s\S]{0,400}return false;/.test(helper));
  check("the helper cannot propagate an error", !/\bthrow\b/.test(helper));
  check("the cache cap is a named constant", /const LOCAL_CACHE_AUDIT_MAX = \d+;/.test(code));

  check("saveData never calls setItem('raffleData') itself",
    !/localStorage\.setItem\('raffleData'/.test(save));
  check("both cache writes go through the helper",
    (save.match(/cacheLocally\(\{/g) || []).length === 2);
  check("the primary write claims success only when it happened",
    /if \(cachedOk\) console\.log\('✅ Saved to localStorage'\)/.test(save));
  check("the fallback write likewise",
    /if \(cachedFallbackOk\) console\.log\('✅ Saved to localStorage \(fallback\)'\)/.test(save));
  check("and no cache result ever reaches writesFailed",
    !/cached(Ok|FallbackOk)[\s\S]{0,200}writesFailed\.push/.test(save));
}

console.log("\nThe money has the same durable outbox the audit log has");
{
  // 2026-09-17. Measured on production: since the 13 September reset, 100 cash
  // movements sat in appAuditLog with NO row in cash_tx_2026_W38 -- 97 awards
  // and 3 deductions, 12 staff, about $9,700 of awards students never got.
  // Cause: an audit entry that cannot be written is queued to localStorage and
  // replayed; a cash row was held in memory only, and a reload that reached the
  // server replaced memory. The record of the award survived, the award did not.
  check("there is a cash outbox key", /const CASH_OUTBOX_KEY = 'cashOutbox_v1';/.test(code));
  check("it reads defensively, like the audit one",
    /function readCashOutbox\(\)[\s\S]{0,400}Array\.isArray\(parsed\) \? parsed : \[\]/.test(code));
  check("its write never throws", /function writeCashOutbox\([\s\S]{0,300}catch \(e\) \{[\s\S]{0,200}console\.warn/.test(code));
  check("rows are enqueued AT CREATION, in recordCashTransaction",
    /cashTransactions\.push\(tx\);\s*student\.wildcatCashTransactions\.push\(tx\);[\s\S]{0,160}enqueueCashOutbox\(tx\);/.test(code));
  check("enqueue dedupes by id", /function enqueueCashOutbox[\s\S]{0,300}outbox\.some\(t => t && t\.id === tx\.id\)/.test(code));
  check("pruning drops ONLY confirmed ids",
    /function pruneCashOutbox\(confirmedIds\)[\s\S]{0,400}filter\(t => !\(t && confirmedIds\.has\(t\.id\)\)\)/.test(code));
  check("a confirmed cash write prunes", /cashIdsOnServer\.add\(t\.id\)\);\s*pruneCashOutbox\(cashIdsOnServer\);/.test(code));
  check("a live pull also prunes, because a pull is confirmation",
    /pruneCashOutbox\(cashIdsOnServer\);\s*return added;/.test(code));
  check("the drain skips anything already confirmed",
    /function drainCashOutboxIntoLedger[\s\S]{0,600}have\.has\(t\.id\) \|\| cashIdsOnServer\.has\(t\.id\)/.test(code));
  check("it runs on the server load path, BEFORE the ledger is reconciled",
    /drainCashOutboxIntoLedger\(\);\s*reconcileCashLedger\(\);/.test(code));
  check("and on the localStorage fallback path too",
    (code.match(/drainCashOutboxIntoLedger\(\);\s*reconcileCashLedger\(\);/g) || []).length === 2);
}

console.log("\nA 401 is a lost sign-in, not a red console");
{
  // The bar with "You have been signed out ... do not close this tab" existed
  // and never appeared: a token expires while the session object it arrived in
  // is still in memory, so getSession() answers yes and every write still 401s.
  // Its only caller was gated on the same condition, so it was never reached.
  check("a 401 is recognised", /function isUnauthorized\(err\)[\s\S]{0,240}\\b401\\b\|unauthor/i.test(code));
  check("the save tracks whether it saw one", /let sawUnauthorized = false;/.test(save));
  check("every refusal path sets it",
    (save.match(/if \(isUnauthorized\([^)]*\)\) sawUnauthorized = true;/g) || []).length >= 5);
  check("and a 401 raises the bar", /if \(sawUnauthorized\) reportSessionLost\([^)]*true\);/.test(save));
  check("reportSessionLost takes the override", /function reportSessionLost\(reason, serverRefused\)/.test(code));
  check("which bypasses the has-a-session guard",
    /if \(!serverRefused && auth && auth\.getSession && auth\.getSession\(\)\) return;/.test(code));
}

console.log("\nA green tick for cash requires confirmation, not a non-false value");
{
  // requestSave resolves with whatever the queue hands back. Only a literal
  // false counted as failure, so null (nothing dirty) and undefined (coalesced)
  // both read as success -- clearing the unsaved bar and ticking an award that
  // never left the tab.
  check("the honest test is the outbox", /function allCashOnServer\(ok\)[\s\S]{0,200}readCashOutbox\(\)\.length === 0/.test(code));
  check("ok === false is still a failure", /function allCashOnServer\(ok\) \{\s*if \(ok === false\) return false;/.test(code));
  check("no cash site still tests ok === false directly",
    !/requestSave\('Cash [^']*'\);\s*if \(ok === false\)/.test(code));
  check("all three cash sites use it",
    (code.match(/if \(!allCashOnServer\(ok\)\) \{/g) || []).length === 3);
  check("the Retry button judges cash separately from referrals",
    /const cashOk = allCashOnServer\(ok\);/.test(code) &&
    /if \(cashOk\) \[\.\.\._unsavedCash\.keys\(\)\]\.forEach/.test(code));
  check("and says 'partly saved' rather than 'everything is on the server'",
    /Partly saved/.test(code));
  check("saveData clears cash markers only when the outbox is empty",
    /if \(readCashOutbox\(\)\.length === 0\) \{\s*unsavedAtStart\.cash\.forEach/.test(save));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
