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
  // RE-POINTED 2026-09-23: a student with cash still listed as pending is
  // always sent too, because the list is what delivers the money.
  check("a save sends only students whose shape differs, or who still have cash pending",
    /const changedStudents = studentsForConvex\.filter\(st =>\s*st && \(JSON\.stringify\(st\) !== _studentSaveFingerprint\.get\(String\(st\.id\)\)\s*\|\| _pendingCashMovements\.has\(String\(st\.id\)\)\)\);/.test(save));
  // The second half was /convexMutation\('appData:save', \{\s*students: …/ and
  // broke on 2026-09-13 when a `clientVersion` field was added ahead of
  // `students`. The property is which LIST is sent, not which key is first.
  // RE-POINTED 2026-09-20, not relaxed. studentsToSend now also snapshots the
  // counters it is sending, so the base can be pinned to those rather than to
  // whatever the student object holds after the await. The property asserted is
  // unchanged: each changed student goes with its delta attached.
  // RE-POINTED 2026-09-21. Each changed student now goes with its delta AND
  // the movements that delta is made of, so the server can apply each movement
  // once. The property asserted is the same one.
  // RE-POINTED 2026-09-23: the per-student send step is buildCashSend, a named
  // function the ordering sweep runs as is. Same property.
  const send = code.slice(code.indexOf("function buildCashSend(changedStudents) {"),
                          code.indexOf("function settleSaveAnswerCash("));
  check("and that, with each one's cash delta attached, is what appData:save receives",
    /const \{ studentsToSend, sentCounters, sentMovements \} = buildCashSend\(changedStudents\);/.test(save)
    && /const base = _studentCashBase\.get\(key\);/.test(send)
    && /cashDelta: cashDeltaBetween\(st, base\)/.test(send)
    && /students: studentsToSend,/.test(save));
  check("and the movements that delta is made of travel with it -- the same COPY the answer is settled against",
    /const moves = \(_pendingCashMovements\.get\(key\) \|\| \[\]\)\.slice\(\);/.test(send)
    && /sentMovements\.set\(key, moves\);/.test(send) && /cashMovements: moves/.test(send));
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
    // Since 2026-09-23 there are TWO ways to know the money is on the server:
    // the ordinary save emptied the outbox, or the server command confirmed
    // this award AND wrote its ledger row and audit entry. Either is real
    // confirmation; neither is a guess.
    check(`${name} says NOT saved unless the outbox is empty or the command confirmed it`,
      /if \(!allCashOnServer\(ok\) && !cashAwardCommandLanded\(cmdRes, cmdItems\)\) \{[\s\S]{0,200}NOT saved yet/.test(body));
    check(`${name} waits for the command's answer before judging`,
      body.indexOf("const cmdRes = await cmd;") > saveAt && body.indexOf("const cmdRes = await cmd;") < okAt);
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
  // RE-POINTED 2026-09-23: the base is seeded from the server's rows when
  // they are installed (commitRosterCash), not at the read -- still from what
  // the SERVER returned, never from the local array.
  check("the base is recorded from what the server returned at load",
    /function commitRosterCash\(rows, mark\) \{[\s\S]{0,1200}server = cashCountersOf\(st\);[\s\S]{0,120}_studentCashBase\.set\(key, Object\.assign\(\{\}, server\)\);/.test(code));
  // RE-POINTED 2026-09-20. This pinned `changedStudents.forEach(rememberCashBase)`,
  // which read the student object AFTER the await and so erased any award made
  // during the round trip -- 21 students and $2,300 on 2026-09-18. The base is
  // now pinned from the snapshot taken before the await. The property asserted
  // is still the one that matters: it happens only once the server has answered.
  // RE-POINTED 2026-09-23: once the server has answered, the base moves by
  // exactly the movements the answer confirmed (settleSaveAnswerCash). It is
  // exercised for real further down this file.
  check("and again once the server answered, from what the answer confirmed",
    /_studentSaveFingerprint\.set\(String\(st\.id\), JSON\.stringify\(st\)\)\);[\s\S]{0,2000}settleSaveAnswerCash\(changedStudents, sentCounters, sentMovements, heldMovements, heldWhy\);/.test(save));
  // ORDER IS THE WHOLE ASSERTION: the counters must be spread AFTER
  // ...localStudent so the server's values win. What follows them is not
  // pinned -- the cash history is taken from the server on the next line now
  // (see cash-history-cutoff.test.mjs), which is the same fix applied to the
  // one cash field this rule had missed.
  check("the load-time merge takes the server's counters over the local overlay",
    /\.\.\.localStudent,[^\n]*\n[\s\S]{0,600}\.\.\.serverCashCounters\(serverStudent\),/.test(code)
    && code.indexOf("...localStudent,") < code.indexOf("...serverCashCounters(serverStudent),"));
  // A RELOAD KEEPS THIS TAB'S UNCONFIRMED MOVEMENT -- and the rebase lives
  // INSIDE the loader, not around its callers.
  //
  // This used to pin the call-site pattern verbatim: snapshot, loadData,
  // reapply. That pattern was the defect. On 2026-09-22 three of the four
  // callers of refreshRosterFromConvex did not do it -- staff invite, sign-in
  // and RESUMED SESSION -- so a teacher who awarded cash and switched away
  // before the save confirmed came back to a tab whose delta read zero while
  // the movement was still listed. The server cancelled it against its own
  // residual and registered it as applied: 38 students lost an award each,
  // unrecoverably. An assertion that pins a call-site pattern cannot see a
  // caller that never adopted it, so this pins the structure instead.
  //
  // RE-POINTED 2026-09-23, same lesson, stricter form. The rebase now happens
  // when the rows go ON SCREEN (loadData shows them seconds after the read),
  // and the loader makes it unskippable in a way no caller can route around:
  // it hands out no `students` at all, only install(), and install() is the
  // rebase. So the structure pinned is: no rows without install(), install()
  // runs commitRosterCash once, and each installer puts the rows on screen with
  // no await in between.
  {
    const fn = code.slice(code.indexOf("async function loadRosterFromConvex"));
    const body = fn.slice(0, fn.indexOf("\n        }\n"));
    check("the journal mark is taken inside the loader, before the await",
      body.indexOf("beginCashLoad()") > 0 && body.indexOf("beginCashLoad()") < body.indexOf("await auth.convexQuery"));
    check("the rows are handed out ONLY through install(), which is the rebase",
      /install\(\) \{[\s\S]{0,300}commitRosterCash\(data\.students, cashMark\);[\s\S]{0,80}return data\.students;/.test(body)
      && !/\bstudents: data\.students\b/.test(body));
    check("and install() refuses to run twice, so the rebase cannot be doubled",
      /if \(installed\) throw new Error/.test(body));
    // TEETH: exactly one place rebases. A second would double the movement.
    const calls = (code.match(/commitRosterCash\(/g) || []).length;
    check("EXACTLY ONE call site of commitRosterCash, so the movement cannot be applied twice",
      calls === 2, `${calls} occurrences (one definition, one call)`);
    // Each installer: from install() to the assignment of `students`, nothing
    // awaits, so the base, the list and the records on screen change together.
    // Searched INSIDE each function, so one installer's text cannot stand in
    // for another's.
    const fnText = (head) => { const i = code.indexOf(head); return i < 0 ? "" : code.slice(i, code.indexOf("\n        }\n", i)); };
    const between = (text, from, to) => { const i = text.indexOf(from); const j = text.indexOf(to, i); return i >= 0 && j > i ? text.slice(i, j) : null; };
    const inLoadData = between(fnText("async function loadData() {"), "const rows = rosterLoad.install();", "students = mergedStudents;");
    const inRefresh = between(fnText("async function refreshRosterFromConvex(reason, opts) {"), "const rows = fresh.install();", "students = rows.filter((s) => s.enrolled !== false)");
    const inCash = between(fnText("async function refreshCashFromServer(reason, attempt) {"), "const rows = fresh.install();", "st.cashApplied = r.cashApplied;");
    check("loadData installs at the merge, with no await before the rows are on screen",
      inLoadData !== null && !/\bawait\b/.test(inLoadData));
    check("refreshRosterFromConvex installs and shows with no await between",
      inRefresh !== null && !/\bawait\b/.test(inRefresh));
    check("refreshCashFromServer installs and copies the cash onto the records on screen with no await between",
      inCash !== null && !/\bawait\b/.test(inCash));
    check("and they are the only three installers",
      (code.match(/\.install\(\);/g) || []).length === 3);
  }
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
  // The window widened on 2026-09-21: the movement is also recorded as
  // PENDING between these two statements, so its id can travel with the next
  // save and the counter cannot be moved twice. The property is unchanged --
  // the row is enqueued at creation, before any save exists.
  check("rows are enqueued AT CREATION, in recordCashTransaction",
    /cashTransactions\.push\(tx\);\s*student\.wildcatCashTransactions\.push\(tx\);[\s\S]{0,700}enqueueCashOutbox\(tx\);/.test(code));
  check("and the movement is recorded as pending in the same breath",
    /cashTransactions\.push\(tx\);[\s\S]{0,400}_pendingCashMovements\.set\(_sid, _list\);/.test(code));
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
    (code.match(/drainCashOutboxIntoLedger\(\);/g) || []).length === 2 &&
    /drainCashOutboxIntoLedger\(\);\s*reconcileCashLedger\(\);/.test(code));
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
  // Was a direct reportSessionLost. A 401 now goes to renewal first, and the
  // bar is what renewal falls back to -- see the renewal block below.
  check("and a 401 is acted on rather than only logged",
    /if \(sawUnauthorized\) \{\s*renewSessionAfterRefusal\(/.test(save));
  check("which ends at the bar when renewal cannot help",
    /function renewSessionAfterRefusal[\s\S]{0,1400}reportSessionLost\(reason, true\);/.test(code));
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
    (code.match(/if \(!allCashOnServer\(ok\) && !cashAwardCommandLanded\(cmdRes, cmdItems\)\) \{/g) || []).length === 3);
  // THE WIDENING MUST NOT TICK WHAT THE SERVER DID NOT FULLY RECORD. A command
  // answer counts only when EVERY award in it came back with its records
  // written; "absorbed" (the ordinary save moved the money and still owes the
  // ledger row) does not, and neither does a refusal or a partial answer.
  {
    const lift = (name) => {
      const i = code.indexOf("function " + name + "(");
      let depth = 0, j = code.indexOf("{", i);
      for (let k = j; k < code.length; k++) {
        if (code[k] === "{") depth++;
        else if (code[k] === "}") { depth--; if (depth === 0) return code.slice(i, k + 1); }
      }
      return "";
    };
    const landed = new Function(lift("cashAwardCommandLanded") + "\nreturn cashAwardCommandLanded;")();
    const items = [{ tx: { id: "txn_1" } }, { tx: { id: "txn_2" } }];
    const good = (id, extra) => Object.assign({ txnId: id, status: "applied", wroteRecords: true }, extra || {});
    check("the command answer counts when every award was written",
      landed({ ok: true, results: [good("txn_1"), good("txn_2")] }, items) === true);
    check("...but not when one of them was only absorbed",
      landed({ ok: true, results: [good("txn_1"), good("txn_2", { status: "alreadyApplied", wroteRecords: false })] }, items) === false);
    check("...nor when one was refused",
      landed({ ok: true, results: [good("txn_1"), { txnId: "txn_2", status: "refused", wroteRecords: false }] }, items) === false);
    check("...nor when one is simply missing from the answer",
      landed({ ok: true, results: [good("txn_1")] }, items) === false);
    check("...nor when the switch was off",
      landed({ ok: false, code: "disabled", results: [] }, items) === false);
    check("...nor when nothing came back", landed(null, items) === false);
    check("...nor for an empty award list", landed({ ok: true, results: [] }, []) === false);
  }
  check("the Retry button judges cash separately from referrals",
    /const cashOk = allCashOnServer\(ok\);/.test(code) &&
    /if \(cashOk\) \[\.\.\._unsavedCash\.keys\(\)\]\.forEach/.test(code));
  check("and says 'partly saved' rather than 'everything is on the server'",
    /Partly saved/.test(code));
  check("saveData clears cash markers only when the outbox is empty",
    /if \(readCashOutbox\(\)\.length === 0\) \{\s*unsavedAtStart\.cash\.forEach/.test(save));
}

console.log("\nCash the server never received is recovered from the device");
{
  // The outbox only holds rows created since it shipped. Every earlier build
  // wrote its cash into the `raffleData` blob on every save attempt, and that
  // blob is read back by exactly ONE function -- loadDataLocal() -- which runs
  // only when the server load FAILS. So a tab whose writes were refused for a
  // day, and which then reloads successfully, has its unsaved awards replaced
  // by the server's copy and silently dropped.
  //
  // Not hypothetical: on 2026-09-17 the school's heaviest awarder recorded 281
  // movements on 15 September and then nothing for two days while her screen
  // kept showing the work. None of it is in the 100 orphans either, because
  // when a token dies BOTH writes fail and no server-side trace survives.
  check("there is a recovery pass over the local cache",
    /function recoverCashFromLocalCache\(\)/.test(code));
  check("it reads the legacy raffleData blob",
    /function recoverCashFromLocalCache[\s\S]{0,500}localStorage\.getItem\('raffleData'\)/.test(code));
  check("an unreadable cache is skipped, not thrown",
    /function recoverCashFromLocalCache[\s\S]{0,700}catch \(e\) \{[\s\S]{0,160}return;/.test(code));
  check("it never re-adds a row the server already has",
    /have\.has\(t\.id\) \|\| cashIdsOnServer\.has\(t\.id\)/.test(code));
  check("it never resurrects cash from before a reset",
    /function lastCashResetAt\(\)/.test(code) &&
    /if \(cutoff && String\(t\.timestamp \|\| ''\) <= cutoff\) return;/.test(code));
  check("the reset boundary comes from the audit log",
    /reset_all_student_cash\|Reset all \.\* Wildcat Cash/.test(code));
  check("recovered rows go into the outbox, so they cannot be lost twice",
    /cashTransactions\.push\(t\);\s*\/\/[^\n]*\n\s*enqueueCashOutbox\(t\);/.test(code) ||
    /function recoverCashFromLocalCache[\s\S]{0,1200}enqueueCashOutbox\(t\);/.test(code));
  check("it runs on the SERVER load path, where the cache was being ignored",
    /drainCashOutboxIntoLedger\(\);\s*recoverCashFromLocalCache\(\);\s*reconcileCashLedger\(\);/.test(code));
  check("and before tombstones, so a deleted row is filtered back out",
    code.indexOf("recoverCashFromLocalCache();") < code.indexOf("applyTombstonesToLocalState();"));
}

console.log("\nA refused save renews its own token before telling anyone");
{
  check("there is a renewal path", /function renewSessionAfterRefusal\(reason\)/.test(code));
  check("it asks for a FORCED resume, which is the only kind that replaces a live-but-dead session",
    /auth\.resumeSession\(\{ force: true \}\)/.test(code));
  check("only one renewal runs at a time", /if \(_renewAfterRefusalInFlight\) return;/.test(code));
  check("a successful renewal re-sends rather than waiting on the queue",
    /requestSave\('after token renewal'\)/.test(code));
  check("and clears the bar it may have already raised",
    /bar\.remove\(\);\s*_sessionLostShown = false;/.test(code));
  check("the bar is the FALLBACK, shown only when renewal fails",
    /\.then\(fresh => \{\s*if \(!fresh\) \{\s*reportSessionLost\(reason, true\);/.test(code));
  check("a thrown renewal also falls back to the bar",
    /\.catch\(err => \{[\s\S]{0,240}reportSessionLost\(reason, true\);/.test(code));
  check("the save calls renewal, not the bar, on a 401",
    /if \(sawUnauthorized\) \{\s*renewSessionAfterRefusal\(/.test(save));
}

console.log("\nBoth cache blobs carry the cash, not just the happy one");
{
  // saveData writes two different localStorage blobs: one when the try
  // completes, one in the outer catch. The catch blob -- the copy written when
  // a save has ALREADY gone wrong, and the only one loadDataLocal reads back --
  // omitted cashTransactions and cashReceipts. The file already carries this
  // exact lesson for wildcatCashRewards.
  const blobs = save.split("cacheLocally({").slice(1);
  check("there are exactly two cache blobs", blobs.length === 2);
  for (const [i, label] of [[0, "primary"], [1, "fallback"]]) {
    const body = blobs[i].slice(0, blobs[i].indexOf("}, 'localStorage"));
    check(`the ${label} blob carries cashTransactions`, /\bcashTransactions\b/.test(body));
    check(`the ${label} blob carries cashReceipts`, /\bcashReceipts\b/.test(body));
    check(`the ${label} blob carries the rewards catalogue`, /\bwildcatCashRewards\b/.test(body));
    check(`the ${label} blob carries the audit log`, /\bauditLog\b/.test(body));
  }
}

console.log("\nAn audit entry is confirmed by id, never by batch");
{
  // The server has always refused some entries -- an empty entryId, a duplicate
  // within one payload -- and reported them separately under `skipped`. The
  // client marked the WHOLE batch the moment the call resolved, so a refused
  // entry was recorded as stored, pruned from the durable outbox, never retried
  // for the life of the tab, and printed on screen as written.
  //
  // auditIdsOnServer accumulates, so once entries were wrongly marked every
  // later batch in that session went the same way. 259 of one teacher's entries
  // on 2026-09-15 while her cash writes all succeeded.
  check("the batch-wide mark is gone",
    !/batch\.forEach\(r => auditIdsOnServer\.add\(r\.entryId\)\);/.test(save));
  check("only ids the server reported as stored are marked",
    /const stored = \(res && Array\.isArray\(res\.storedIds\)\)[\s\S]{0,300}stored\.forEach\(id => auditIdsOnServer\.add\(id\)\);/.test(save));
  check("a refusal is counted", /let auditRefused = 0;/.test(save));
  check("a refusal is reported loudly, not as a footnote",
    /console\.error\([\s\S]{0,200}REFUSED/.test(save));
  check("a refusal makes the save fail, so the queue retries",
    /if \(auditRefused\) \{\s*auditSaveSucceeded = false;\s*writesFailed\.push\('audit'\);/.test(save));
  check("the success line names the refused count too",
    /\$\{auditRefused\} refused/.test(save));
  check("a server that reports no ids leaves entries pending rather than marking them",
    /does not report stored ids[\s\S]{0,80}re-sent/.test(save));
}

console.log("\nAn entry recovered from the outbox counts as minted here");
{
  // saveData drops entries this tab did not mint when the audit table could not
  // be read: `if (tableUnread && !auditIdsMintedHere.has(id)) return false;`.
  // The outbox holds only entries this installation wrote, but the drain pushed
  // them into auditLog without registering the id -- so the load that RECOVERED
  // an entry was also the load that could not send it, under a green tick.
  const fn = code.slice(code.indexOf("function drainAuditOutboxIntoLocalLog"));
  const body = fn.slice(0, fn.indexOf("\n        }"));
  check("the drain registers each recovered id as minted here",
    /auditLog\.push\(entry\);[\s\S]{0,120}auditIdsMintedHere\.add\(id\);/.test(body));
  check("the gate it has to satisfy is still the one in saveData",
    /if \(tableUnread && !auditIdsMintedHere\.has\(id\)\) return false;/.test(save));
}

console.log("\nAn award made WHILE a save is in flight still reaches a counter");
{
  // MEASURED ON PRODUCTION 2026-09-20. 21 students, $2,300, in one school day.
  //
  // The counters move by a DELTA -- how much this tab has changed them since
  // the value it last confirmed -- and the base for that delta was re-pinned
  // after the await by reading the student object as it was THEN:
  //
  //     changedStudents.forEach(rememberCashBase);
  //
  // With forty staff and a save every few seconds, an award landing during
  // the round trip is ordinary. Its movement was erased: the delta sent was
  // +100, the counter in memory was +200 by the time the answer arrived, the
  // base was pinned to +200, and the next delta was therefore 0. The award
  // existed as a ROW forever and never reached a counter.
  //
  // The same structural fact failed the other way too, for 7 students on the
  // same day: a save that lands while its response is lost leaves the base
  // un-pinned, and the identical delta is sent again. A row is idempotent --
  // keyed by id and unioned, so sending it twice is harmless. A delta is not.
  // That half is NOT fixed here and is deliberately still open.
  const FIELDS = ["wildcatCashBalance", "wildcatCashEarned", "wildcatCashSpent", "wildcatCashDeducted"];
  const countersOf = (st) => { const o = {}; FIELDS.forEach((f) => { o[f] = Number(st && st[f]) || 0; }); return o; };
  const deltaBetween = (now, base) => { const d = {}; FIELDS.forEach((f) => { d[f] = (Number(now && now[f]) || 0) - (Number(base && base[f]) || 0); }); return d; };

  // One student, base confirmed at 0, one award of $100 pending.
  const run = (pinFromSent) => {
    const st = { id: "1", wildcatCashBalance: 100, wildcatCashEarned: 100, wildcatCashSpent: 0, wildcatCashDeducted: 0 };
    let base = countersOf({ wildcatCashBalance: 0, wildcatCashEarned: 0, wildcatCashSpent: 0, wildcatCashDeducted: 0 });
    const sent = [];
    // --- save 1 begins: delta computed, snapshot taken
    sent.push(deltaBetween(st, base));
    const snapshot = countersOf(st);
    // --- DURING the await, a teacher awards another $100
    st.wildcatCashBalance += 100; st.wildcatCashEarned += 100;
    // --- save 1 answers, and the base is re-pinned
    base = pinFromSent ? snapshot : countersOf(st);
    // --- save 2
    sent.push(deltaBetween(st, base));
    return sent.reduce((n, d) => n + d.wildcatCashBalance, 0);
  };

  check("pinning from the LIVE object loses the second award (the shipped bug)", run(false) === 100);
  check("pinning from what was SENT carries both", run(true) === 200);

  // And the shipped code must do the second one.
  check("the counters sent are snapshotted before the await",
    /function buildCashSend\(changedStudents\) \{[\s\S]{0,400}const sentCounters = new Map\(\);[\s\S]{0,400}sentCounters\.set\(key, cashCountersOf\(st\)\);/.test(code)
    && save.indexOf("buildCashSend(changedStudents)") < save.indexOf("await auth.convexMutation('appData:save'"));
  // RE-POINTED 2026-09-23. The base no longer pins to what was sent: it
  // moves by exactly the movements the answer confirmed, which keeps the
  // property above (an award made during the round trip was not sent, so it
  // is not confirmed, so the next delta still carries it) and survives a
  // roster load landing during the round trip, which the pin did not. Run
  // for real, lifted from script.js:
  {
    const liftFn = (name) => {
      const i = code.indexOf("function " + name + "(");
      const head = code.lastIndexOf("\n", i);
      let depth = 0;
      for (let k = code.indexOf("{", i); k < code.length; k++) {
        if (code[k] === "{") depth++;
        else if (code[k] === "}") { depth--; if (depth === 0) return code.slice(head + 1, k + 1); }
      }
      return "";
    };
    const SCRIPT_SRC = code;
  // THE STATE, LIFTED FROM script.js, not copied: a test that hardcodes the
    // journal's settings cannot notice them change (review 3, 2026-09-23).
    const liftDecl = (name) => {
      const m = new RegExp("\\n\\s*((?:const|let) " + name + " = [^\\n]*;)").exec(SCRIPT_SRC);
      if (!m) throw new Error("declaration not found: " + name);
      return m[1];
    };
    const CASH_STATE = ["_studentCashBase", "_pendingCashMovements", "_cashConfirmations", "_cashConfirmSeq",
      "CASH_CONFIRMATION_KEEP_MAX", "_openCashLoads", "_cashLoadSeq", "_serverCashOfRow",
      "CASH_TERMINAL_REFUSALS", "CASH_REFUSALS_TO_SAY"].map(liftDecl).join("\n");
    const make = () => new Function("CASH_COUNTER_FIELDS", "console", `
      ${CASH_STATE}
      let students = [], nonEnrolledStudents = [];
      ${["cashCountersOf", "cashMovementEffect", "rememberCashBase", "pruneCashConfirmations", "noteCashConfirmed",
         "beginCashLoad", "liveStudentRecord", "settleSaveAnswerCash"].map(liftFn).join("\n")}
      return { base: _studentCashBase, pending: _pendingCashMovements, journal: _cashConfirmations,
               settleSaveAnswerCash, begin: beginCashLoad };
    `)(FIELDS, { log() {}, warn() {} });
    const m1 = { id: "M1", at: "2026-09-23T10:00:00.000Z", amount: 100, kind: "award" };
    const m2 = { id: "M2", at: "2026-09-23T10:00:01.000Z", amount: 100, kind: "award" };
    // base 0; M1 sent; M2 awarded during the round trip; the answer confirms M1.
    const H = make();
    H.base.set("1", countersOf({})); H.pending.set("1", [m1, m2]);
    H.begin();   // a reload is in flight, so the journal has someone to keep entries for
    const st = { id: "1", wildcatCashBalance: 200, wildcatCashEarned: 200, wildcatCashSpent: 0, wildcatCashDeducted: 0 };
    H.settleSaveAnswerCash([st], new Map([["1", countersOf({ wildcatCashBalance: 100, wildcatCashEarned: 100 })]]),
      new Map([["1", [m1]]]), new Set());
    check("the base moves by exactly what the answer confirmed", H.base.get("1").wildcatCashBalance === 100);
    check("...so the award made during the round trip is still carried by the next delta",
      deltaBetween(st, H.base.get("1")).wildcatCashBalance === 100 && H.pending.get("1").map((m) => m.id).join() === "M2");
    check("...and the confirmation is journalled, so a load running meanwhile can ask about it",
      H.journal.length === 1 && H.journal[0].m.id === "M1");
    // With no load open, nothing can ever ask: nothing is kept.
    const N = make();
    N.base.set("1", countersOf({})); N.pending.set("1", [m1]);
    N.settleSaveAnswerCash([{ id: "1", wildcatCashBalance: 100, wildcatCashEarned: 100, wildcatCashSpent: 0, wildcatCashDeducted: 0 }],
      new Map(), new Map([["1", [m1]]]), new Set());
    check("...and with no load open, the journal keeps nothing", N.journal.length === 0);
    // A refusal no retry can change leaves the list WITHOUT entering the base.
    const T = make();
    T.base.set("1", countersOf({ wildcatCashBalance: 500, wildcatCashEarned: 500 })); T.pending.set("1", [m1]);
    const stT = { id: "1", wildcatCashBalance: 600, wildcatCashEarned: 600, wildcatCashSpent: 0, wildcatCashDeducted: 0 };
    const droppedT = T.settleSaveAnswerCash([stT], new Map(), new Map([["1", [m1]]]), new Set(["M1"]),
      new Map([["M1", "before_cutoff"]]));
    check("a movement refused for good (before_cutoff) leaves the list and stays OUT of the base",
      !T.pending.has("1") && T.base.get("1").wildcatCashBalance === 500 && droppedT.length === 1);
    check("...and comes off the record on screen, so shown = base + list still holds",
      stT.wildcatCashBalance === 500 && stT.wildcatCashEarned === 500);
    const R = make();
    R.base.set("1", countersOf({})); R.pending.set("1", [m1]);
    R.settleSaveAnswerCash([{ id: "1" }], new Map(), new Map([["1", [m1]]]), new Set(["M1"]),
      new Map([["M1", "stated_no_change"]]));
    check("...but one refused for a reason the next save repairs stays listed",
      R.pending.get("1").map((m) => m.id).join() === "M1");
    const C = make();
    C.base.set("1", countersOf({})); C.pending.set("1", [m1]);
    C.settleSaveAnswerCash([{ id: "1" }], new Map(), new Map([["1", [m1]]]), new Set(["M1"]), new Map([["M1", "capped"]]));
    check("...and so does one CAPPED, which may land once sent on its own",
      C.pending.get("1").map((m) => m.id).join() === "M1");
    const O = make();
    O.base.set("1", countersOf({})); O.pending.set("1", [m1]);
    O.settleSaveAnswerCash([{ id: "1" }], new Map(), new Map([["1", [m1]]]), new Set(["M1"]));
    check("...and an older backend that sends no reasons keeps everything held, as before",
      O.pending.get("1").map((m) => m.id).join() === "M1");

    // THE LISTS, pinned exactly: a reason moved into "final" by mistake loses
    // awards for good; one moved out brings back the forever-re-added display.
    const setOf = (name) => {
      const m = new RegExp("const " + name + " = new Set\\(\\[([^\\]]*)\\]\\);").exec(code);
      return m ? m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")).sort().join(",") : null;
    };
    check("final refusals are exactly before_cutoff, coverage_lost, undated, bad_shape",
      setOf("CASH_TERMINAL_REFUSALS") === "bad_shape,before_cutoff,coverage_lost,undated", setOf("CASH_TERMINAL_REFUSALS"));
    check("...and the ones a teacher is TOLD about leave out coverage_lost, which may have been paid",
      setOf("CASH_REFUSALS_TO_SAY") === "bad_shape,before_cutoff,undated", setOf("CASH_REFUSALS_TO_SAY"));

    // The answer is read by a named function, run here on both backends.
    const readHeld = new Function(liftFn("heldFromAnswer") + "\nreturn heldFromAnswer;")();
    const fromNew = readHeld({ cashMovementsHeld: ["M1", "M2"], cashMovementsHeldWhy: [{ id: "M1", why: "before_cutoff" }, { id: "M2", why: "capped" }] });
    check("the answer's reasons are read, one per held id",
      fromNew.heldMovements.size === 2 && fromNew.heldWhy.get("M1") === "before_cutoff" && fromNew.heldWhy.get("M2") === "capped");
    const fromOld = readHeld({ cashMovementsHeld: ["M1"] });
    check("...and an answer with no reasons gives none, so nothing is treated as final",
      fromOld.heldMovements.has("M1") && fromOld.heldWhy.size === 0);
    check("...and a missing answer is not a throw", readHeld(null).heldMovements.size === 0);
    check("saveData reads the answer through it and hands every held movement on",
      /const \{ heldMovements, heldWhy \} = heldFromAnswer\(result\);[\s\S]{0,200}settleSaveAnswerCash\(changedStudents, sentCounters, sentMovements, heldMovements, heldWhy\);\s*onCashHeld\(refusedForGood, heldMovements, heldWhy\);/.test(save));
    // A movement the server would not account for must NOT be forgotten --
    // and must stay OUT of the base, so the next save states what it lists.
    const K = make();
    K.base.set("1", countersOf({})); K.pending.set("1", [m1]);
    const st2 = { id: "1", wildcatCashBalance: 100, wildcatCashEarned: 100, wildcatCashSpent: 0, wildcatCashDeducted: 0 };
    K.settleSaveAnswerCash([st2], new Map([["1", countersOf(st2)]]), new Map([["1", [m1]]]), new Set(["M1"]));
    check("a held movement stays pending and is re-sent",
      K.pending.get("1").map((m) => m.id).join() === "M1");
    check("...and stays out of the base, so the next save states exactly what it lists",
      deltaBetween(st2, K.base.get("1")).wildcatCashBalance === 100 && K.journal.length === 0);
    // THE CASE THE PIN GOT WRONG: a roster load reseeded the base (another
    // teacher's +7 included) while this save was in flight.
    const L = make();
    L.base.set("1", countersOf({ wildcatCashBalance: 107, wildcatCashEarned: 107 })); // the load's read, M1 not in it
    L.pending.set("1", [m1]);
    const st3 = { id: "1", wildcatCashBalance: 207, wildcatCashEarned: 207, wildcatCashSpent: 0, wildcatCashDeducted: 0 };
    L.settleSaveAnswerCash([st3], new Map([["1", countersOf({ wildcatCashBalance: 100, wildcatCashEarned: 100 })]]),
      new Map([["1", [m1]]]), new Set());
    check("a load during the round trip keeps its reseeded base: +M1, not back to what was sent",
      L.base.get("1").wildcatCashBalance === 207 && deltaBetween(st3, L.base.get("1")).wildcatCashBalance === 0);
  }
  check("the old unconditional rebase is gone",
    !/changedStudents\.forEach\(rememberCashBase\);/.test(code));
  check("a student with no snapshot still gets a base, rather than none",
    /else rememberCashBase\(st\);/.test(code));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
