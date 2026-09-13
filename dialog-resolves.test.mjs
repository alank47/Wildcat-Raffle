// Every dialog settles its promise, however it is closed.
//
// THE BUG THIS CATCHES, reported 2026-09-13 as "I pressed the blue button and
// nothing happens" and then "still nothing". The Back-button handler wiped an
// open dialog straight out of the DOM:
//
//     host.innerHTML = '';
//
// and stopped there. It had no reference to the promise that dialog belonged
// to, so the promise was never resolved and never rejected. Every
// `await showConfirm(...)` behind it hung forever -- mid-function, silently,
// with nothing on screen and nothing in the console.
//
// MEASURED IN THE OWNER'S OWN TAB, which is how it was finally caught:
//   host:     yes, html 0 chars      <- cleared
//   backdrop: ABSENT
//   dialog:   ABSENT
//   startNewSchoolYear() -> Promise { <pending> }   <- and staying pending
//
// It had nothing to do with the button, the roster, the store module or the
// cache, all of which were checked first and were fine. It was the one
// mechanism that can make a function stop halfway with no trace: an await on a
// promise nobody owns any more.
//
// It could do this to any of the ~216 dialog call sites in this file, which is
// why this is its own test rather than a line in the rollover's.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./script.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  (" + d + ")" : ""}`); }
};

function blockEnd(s, from) {
  let i = s.indexOf("{", from), depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i + 1;
  }
  throw new Error("unbalanced");
}
// The body brace, not the first brace. _wcDialog's parameter list is a
// destructuring pattern -- `function _wcDialog({ kind, title, ... })` -- so
// matching from the first `{` matched the PARAMETERS and returned a six-line
// slice, which failed nine assertions about code that was already correct.
const fn = (decl) => {
  const a = src.indexOf(decl);
  if (a === -1) throw new Error("not found: " + decl);
  const open = decl.includes("({") ? src.indexOf("{", src.indexOf(") {", a)) : a;
  const body = src.slice(a, blockEnd(src, open));
  if (body.length < 200) throw new Error("slice too short for " + decl + ": " + body.length);
  return body;
};
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("\n1. Back does not strand a dialog");
{
  const handler = code(fn("(function backClosesDialogs() {"));
  // THE REGRESSION, named: clearing the host without resolving is the bug.
  check("the handler no longer wipes the host directly",
    !/host\.innerHTML = ''/.test(handler),
    "wiping without resolving is what hung every caller");
  check("it dismisses through the dialog's own canceller",
    /dismiss\(\{ historyAlreadyConsumed: true \}\)/.test(handler));
  check("and does nothing when no dialog is open", /if \(!dismiss\) return;/.test(handler));
  check("it still restores the history entry it consumed",
    /pushState\(\{ wcDialogClosed: true \}/.test(handler));
}

console.log("\n2. The canceller reaches the promise");
{
  const dlg = code(fn("function _wcDialog({ kind, title, body, buttons, input, wide }) {"));
  check("a dismiss function is defined", /const dismiss = \(how\) =>/.test(dlg));
  check("it routes through finish, which resolves", /finish\(cancelIdx >= 0/.test(dlg));
  check("finish still resolves", /resolve\(val\);/.test(dlg));
  check("the live dialog registers itself", /_wcDialogDismiss = dismiss;/.test(dlg));
  check("and deregisters when it closes", /_wcDialogDismiss = null;/.test(dlg));
  // A click and a trailing popstate can both land in the same tick.
  check("finish runs once only", /if \(settled\) return;/.test(dlg));
  check("Escape goes through the same canceller", /if \(e\.key === 'Escape'\) dismiss\(\);/.test(dlg));
}

console.log("\n3. A dialog chain still works");
{
  const dlg = code(fn("function _wcDialog({ kind, title, body, buttons, input, wide }) {"));
  // finish() calls history.back() to spend the entry its dialog pushed, and
  // that fires a popstate a moment later. A confirm-then-prompt chain -- which
  // is exactly what the rollover is -- would have that trailing event cancel
  // the SECOND dialog. Counted, so it is ignored.
  check("our own back() is counted", /_wcDialogSelfBack\+\+/.test(dlg));
  const handler = code(fn("(function backClosesDialogs() {"));
  check("and the handler ignores exactly that many events",
    /if \(_wcDialogSelfBack > 0\) \{ _wcDialogSelfBack--; return; \}/.test(handler));
  const ignoreAt = handler.indexOf("_wcDialogSelfBack");
  const dismissAt = handler.indexOf("dismiss");
  check("the ignore check comes first", ignoreAt !== -1 && ignoreAt < dismissAt);

  // Closing via popstate must NOT spend a second history entry, or a Back
  // press would walk the operator off the page instead of closing a dialog.
  check("a popstate close does not call back() again",
    /if \(!\(how && how\.historyAlreadyConsumed\)\)/.test(dlg));
}

console.log("\n4. The rollover is behind exactly this");
{
  // Why it surfaced here: the rollover awaits a confirm, then a prompt, then a
  // third confirm. Three chances to hang, on the one button that cannot be
  // half-run.
  const roll = fn("async function _startNewSchoolYear() {");
  const awaits = (roll.match(/await show(Confirm|Prompt)\(/g) || []).length;
  check("it awaits more than one dialog", awaits >= 2, String(awaits));
  check("and it is still wrapped so a genuine throw is visible",
    /The year was NOT closed/.test(fn("async function startNewSchoolYear() {")));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
