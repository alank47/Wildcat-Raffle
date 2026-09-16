// The reversal button, and the twenty screens that had to be told what a
// reversal is.
//
// THE PART THAT IS EASY. A reversal is a new ledger row carrying
// kind:'reversal' and reversesTxnId naming the row it cancels. The server
// writes it, atomically, and refuses to write it twice.
//
// THE PART THAT IS NOT. Nothing is deleted and the original is never
// annotated, because distributeCashTransactions (script.js:29346) rebuilds
// every student's array from the ledger on each load -- so a mark written on
// the original would not survive one reload. Which means every READER has to
// derive "was this reversed", and a reader that does not counts one mistake as
// two behaviours. An adversarial review found ~20 such readers; the ones below
// are the ones that would have shown something actually wrong:
//
//   the intervention table  -- a child flagged red for a deduction an adult
//                              already withdrew
//   Most Common Behaviors   -- "Reversed: Be Present" climbing the chart
//   Teacher Interactions    -- the admin who fixed a mistake counted as a
//                              teacher who made one
//   the student's own phone -- kind:'reversal' fell through a label map and
//                              read as the bare words "Wildcat Cash"
//
// Run: npm test

import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const audit = readFileSync(new URL("./wildcat-cashaudit.js", import.meta.url), "utf8");
// Comments stripped before any "this does not appear" assertion. I have had an
// assertion pass against my own comment three times in this project.
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  (" + d + ")" : ""}`); }
};

/** Lift one 8-space-indented function out of the shipped file and run it. */
const lift = (name) => {
  const start = raw.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} is not in script.js`);
  return raw.slice(start, raw.indexOf("\n        }\n", start) + 11);
};

console.log("\n1. The derivation, executed");
{
  const H = (rows) => new Function("cashTransactions",
    lift("reversedCashIds") + lift("isCashBehaviourRow") +
    "\nreturn { reversedCashIds, isCashBehaviourRow };")(rows);

  const award = { id: "a", kind: "award", amount: 100, behaviorName: "Be Present" };
  const deduct = { id: "b", kind: "deduct", amount: -500, behaviorName: "Not Being Responsible" };
  const reversal = { id: "r", kind: "reversal", amount: 500, reversesTxnId: "b" };
  const reset = { id: "s", kind: "deduct", amount: -300, behaviorId: "system_reset" };
  const refund = { id: "f", kind: "award", amount: 200, behaviorId: "reward-refund:r1" };

  const h = H([award, deduct, reversal, reset, refund]);
  const ids = h.reversedCashIds();
  check("the reversed set is derived from reversesTxnId", ids.has("b") && ids.size === 1);

  check("a plain award is a behaviour", h.isCashBehaviourRow(award, ids));
  check("a REVERSED deduction is not", !h.isCashBehaviourRow(deduct, ids));
  check("and neither is the reversal row itself", !h.isCashBehaviourRow(reversal, ids));
  check("a system_reset row is not a behaviour", !h.isCashBehaviourRow(reset, ids));
  check("a store refund is not a behaviour", !h.isCashBehaviourRow(refund, ids));
  check("null is handled", !h.isCashBehaviourRow(null, ids));

  // DERIVED ON READ, NOT CACHED AT LOAD. pullCashWeek and
  // recordCashTransaction both mutate cashTransactions afterwards, so a Set
  // computed once at load goes stale the moment anybody awards cash.
  const empty = H([]);
  check("with no ledger, nothing is reversed", empty.reversedCashIds().size === 0);
  check("and the deduction counts again", empty.isCashBehaviourRow(deduct));
  check("the set is recomputed per call, not memoised",
    /function reversedCashIds\(\)\s*\{[\s\S]{0,400}const out = new Set\(\);/.test(raw));
}

console.log("\n2. Teacher Interactions reads the LEDGER, not the lagging cache");
{
  // The per-student arrays are a cache rebuilt from whatever the saving tab
  // held: 461 rows against the ledger's 710, measured 2026-09-15. This panel
  // was silently 249 awards short, reported as "it showed 423 yesterday and
  // 405 today".
  const fn = code.slice(code.indexOf("function updateTeacherInteractions()"),
                        code.indexOf("function updateTeacherActivityTable"));
  check("it iterates the ledger", /ledgerRows\.forEach\(txn =>/.test(fn));
  check("and no longer walks student.wildcatCashTransactions",
    !/student\.wildcatCashTransactions/.test(fn), fn.match(/student\.wildcatCashTransactions/g)?.join());
  check("it skips anything that is not a behaviour",
    /if \(!isCashBehaviourRow\(txn, reversedIds\)\) return;/.test(fn));
  check("students impacted comes off the row, since there is no student loop now",
    /stats\.studentsImpacted\.add\(txn\.studentId\)/.test(fn));

  // The dead `teacher.username` arm is gone. There is no username column on
  // the teachers table -- it was a Firestore-era key -- so that comparison
  // never matched once.
  check("the dead username comparison is gone", !/teacher\.username === teacherId/.test(fn));
}

console.log("\n3. The intervention table cannot flag a withdrawn deduction");
{
  // The harm, not the metric: a child named in a red "needs intervention"
  // table for money an adult already gave back. The same panel already had to
  // learn that a purchase is not a deduction, after Maria Agaton Colin was
  // flagged for spending her own money.
  const sites = code.match(/kind === 'deduct' && t\.behaviorId !== 'system_reset'[\s\S]{0,120}?\)/g) || [];
  check("both intervention sites exist", sites.length === 2, String(sites.length));
  check("and both are reversal-aware",
    sites.every((s) => /isCashBehaviourRow\(t, _interventionReversedIds\)/.test(s)));

  // ONE DERIVATION PER PASS, shared. The whole lesson of this panel is that
  // the predicate and the row renderer must agree; they once disagreed about
  // `type` versus `kind`.
  check("the set is derived once per render",
    /function updateInterventionStudents\(\)\s*\{\s*_interventionReversedIds = reversedCashIds\(\);/.test(code));
}

console.log("\n4. Most Common Behaviors counts behaviours");
{
  const fn = code.slice(code.indexOf("const behaviorFreq = {}"),
                        code.indexOf("const sortedBehaviors"));
  check("bookkeeping rows are skipped",
    /if \(!isCashBehaviourRow\(txn, _behaviourReversedIds\)\) return;/.test(fn));
}

console.log("\n5. What a child sees on their own phone");
{
  // views_app.ts hands both `kind` and `reason` to the wallet, and the title is
  // `(t.reason) || KIND[t.kind] || 'Wildcat Cash'`. A reversal row HAS a
  // behaviourName -- "Reversed: Be Present" -- so `reason` wins and the KIND
  // entry is the FALLBACK, not what a child normally reads. Worth being exact
  // about: an adversarial review called the entry unreachable, and it is right
  // that it does not normally fire. It stays because the alternative fallback
  // is the bare words "Wildcat Cash" on a line that moved their balance.
  const kindMap = code.slice(code.indexOf("const KIND = { award:"),
                             code.indexOf("};", code.indexOf("const KIND = { award:")));
  check("the wallet has a fallback label for 'reversal'",
    /reversal: 'Correction by a teacher'/.test(kindMap), kindMap.replace(/\s+/g, " "));
  check("and the row's own text is what a child normally reads",
    /const title = \(t && t\.reason\) \|\| KIND\[t && t\.kind\]/.test(code));
  check("which for a reversal says what was reversed",
    /behaviorName: "Reversed: "/.test(
      readFileSync(new URL("./convex/cashReversalRules.ts", import.meta.url), "utf8")));
}

console.log("\n6. The audit vocabulary, in all three registries");
{
  // dashboard-feed.test.mjs asserts every action string the app writes appears
  // in FEED_ACTION_CATS, so an unregistered one fails CI rather than quietly
  // rendering as "Unknown".
  for (const action of ["cash_reversal_credit", "cash_reversal_debit"]) {
    check(`${action} is in FEED_ACTION_CATS`, new RegExp(`'${action}':\\s*'undo'`).test(code));
    check(`${action} is in CASH_ACTIONS`, new RegExp(`'${action}'`).test(audit));
    check(`${action} has a label and a sign`, new RegExp(`${action}:\\s*\\{[^}]*sign:`).test(audit));
  }

  // TWO ACTIONS AND NOT ONE, and the signs are why. describe() computes
  // `signed = meta.sign * Math.abs(amount)` off a static map, so a single
  // action would need sign 0 and would render every reversal as "+$0" -- the
  // file's own "null, never 0" comment warns about exactly this.
  check("reversing a deduction renders as money coming back",
    /cash_reversal_credit:\s*\{[^}]*sign:\s*1\s*\}/.test(audit));
  check("reversing an award renders as money going away",
    /cash_reversal_debit:\s*\{[^}]*sign:\s*-1\s*\}/.test(audit));
  check("neither carries sign 0", !/cash_reversal_\w+:\s*\{[^}]*sign:\s*0/.test(audit));
}

console.log("\n7. The panel: admin-gated, ledger-backed, and escaped");
{
  const fn = code.slice(code.indexOf("async function showStudentCashReversal("),
                        code.indexOf("window.showStudentCashReversal"));
  check("it refuses a non-admin", /if \(!cashReversalIsAdmin\(\)\)/.test(fn));
  check("it reads the ledger-backed query",
    /convexQuery\('cashReversal:reversibleForStudent'/.test(fn));
  check("and never the student's cached array", !/wildcatCashTransactions/.test(fn));

  // EVERY INTERPOLATION ESCAPED. A behaviour name, a teacher's note and a
  // reversal reason are free text an adult typed, rendered through innerHTML.
  const interpolations = fn.match(/\$\{[^}]*\}/g) || [];
  const unescaped = interpolations.filter((x) =>
    /\br\.(behaviorName|notes|teacherName|txnId|why|kind)\b/.test(x) && !/escapeHtml/.test(x));
  check("no free text reaches innerHTML unescaped", unescaped.length === 0, unescaped.join(" | "));
  check("the reversal note is escaped too",
    /chr-reversed[\s\S]{0,300}escapeHtml\(String\(r\.reversal\.reason/.test(fn));

  // The entry point is admin-only and does not also open the history dialog
  // the whole card is wired to.
  check("the button only renders for an admin",
    /\$\{cashReversalIsAdmin\(\) \? `[\s\S]{0,400}showStudentCashReversal/.test(code));
  check("and it stops the card's own click handler",
    /event\.stopPropagation\(\);showStudentCashReversal/.test(code));

  // The row buttons carry their own class, because _wcDialog resolves and
  // clears on any .wc-dialog-btn click.
  check("row buttons are not dialog buttons", /class="btn btn-sm-red wc-reverse-btn"/.test(code));
  check("and the styles they use exist",
    /\.cash-history-row--act/.test(css) && /\.chr-action/.test(css)
    && /\.chr-why/.test(css) && /\.chr-reversed/.test(css) && /\.btn-sm-grey/.test(css));
  check("the correction button gets the shared sizing rule",
    /\.btn-sm-green, \.btn-sm-red, \.btn-sm-grey \{/.test(css));
  check("and the action column collapses on a phone",
    /\.cash-history-row--act \{ grid-template-columns: 1fr; \}/.test(css));
}

console.log("\n8. Pressing Reverse asks for a reason, then reloads");
{
  const h = code.slice(code.indexOf("let _cashReversalInFlight = false;"),
                       code.indexOf("function filterStudentAccounts"));
  check("a reason is required before the call goes out",
    /showPrompt\(/.test(h) && /cleaned\.length < 3\)/.test(h));
  check("the mutation is called with the id and the reason only",
    /convexMutation\('cashReversal:reverse',\s*\{ originalTxnId: txnId, reason: cleaned \}/.test(h));

  // THE PANEL CLOSES BEFORE ANYTHING IS ASKED. _wcDialog has one host and
  // assigns innerHTML, so a prompt opened over the panel destroyed it while
  // its promise was still pending -- leaking a keydown listener and a history
  // entry, and leaving every cancel, refusal or error on a blank screen.
  check("the panel is dismissed before the prompt opens",
    h.indexOf("_wcDialogDismiss()") < h.indexOf("showPrompt("));
  check("and every non-success path puts it back",
    (h.match(/if \(sid\) showStudentCashReversal\(sid\);/g) || []).length >= 4);
  check("a cancelled prompt is not treated as a reason",
    /reason === false \|\| reason == null/.test(h));
  check("a too-short reason is said out loud, not swallowed",
    /Give a real reason/.test(h));

  // The success message is AWAITED, or reopening the panel in the same tick
  // destroys it -- which on the already-reversed path reported nothing at all.
  check("the already-reversed message is awaited before the panel returns",
    /await showAlert\('This was already reversed/.test(h));

  // Unsaved cash movement in this tab survives the refresh.
  check("the refresh preserves this tab's unconfirmed work",
    /await reloadPreservingUnsavedWork\(\)/.test(h));
  check("no amount is sent", !/amount/.test(h.slice(0, h.indexOf("convexMutation") + 300)));
  check("a refusal is shown rather than swallowed", /res\.ok !== true/.test(h) && /showAlert/.test(h));
  check("an already-reversed answer reads as done, not failed",
    /res\.alreadyReversed/.test(h) && h.indexOf("res.alreadyReversed") > h.indexOf("res.ok !== true"));
  check("the tab reloads its data afterwards, rather than guessing",
    /await loadData\(\)/.test(h));
  // NOT btn.disabled: the panel is dismissed before the prompt, so by then the
  // button is detached from the document and disabling it guards nothing. A
  // fast double-click dispatches two events and closest() still matches on the
  // detached node.
  check("a second click while one is in flight is refused",
    /if \(_cashReversalInFlight\) return;/.test(h) && /_cashReversalInFlight = true;/.test(h));
  check("and the flag is released on every path, including a throw",
    /\} finally \{[\s\S]{0,300}_cashReversalInFlight = false;/.test(h));
  check("the student comes off the button, not from the mutation's answer",
    /btn\.getAttribute\('data-wc-student'\)/.test(h));
}

console.log("\n9. The reload race that could eat a save");
{
  // maybeApplyUpdate derived savePending from _saveQueue.isPending() alone,
  // and ~84 call sites call saveData() directly. During one of those the queue
  // is clean, so a tab going into the background reloaded straight through an
  // in-flight appData:save -- and `detentions.push(d); saveData();` is
  // un-awaited with the form already cleared, so the loss was silent.
  const gate = code.slice(code.indexOf("const decision = window.WildcatUpdate.shouldAutoReload({"),
                          code.indexOf("if (!decision.reload) return;"));
  check("the gate sees a direct save in flight", /isSyncing === true/.test(gate));
  check("as well as the queued kind", /_saveQueue\.isPending\(\)/.test(gate));

  const flush = code.slice(code.indexOf("async function flushSaves()"),
                           code.indexOf("async function flushSaves()") + 900);
  check("flushSaves awaits the queue", /await _saveQueue\.flush\(\)/.test(flush));
  check("and then waits for a direct save", /while|for \(let waited = 0; isSyncing/.test(flush));
  check("with a ceiling rather than forever", /DIRECT_SAVE_WAIT_MS/.test(flush));
  check("and says so when it gives up", /gave up waiting/.test(flush));

  // The one caller that matters awaits it before replacing the document.
  check("the update path still awaits the flush before reloading",
    /await flushSaves\(\);/.test(code));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
