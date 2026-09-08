// A referral is not "submitted" until the server has it.
//
// THE BUG, 2026-09-08. submitBehaviorReferral pushed the referral onto the
// local array, showed a green "Referral submitted" toast, cleared the form,
// and THEN called a fire-and-forget save. A teacher whose save failed had
// already been told it worked, had lost the form, and was holding the only
// copy of a child's behaviour record in one tab's memory. Two teachers
// reported referrals that never appeared; one was genuinely not on the server.
//
// The confirmation must therefore come after the save, and an unsaved referral
// must be impossible to miss -- a bar that stays, not a toast that fades.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const start = script.indexOf("async function submitBehaviorReferral()");
const end = script.indexOf("\n        // ====", start);
const fn = script.slice(start, end);

console.log("\n-- the function was located --");
{
  check("submitBehaviorReferral found", start !== -1);
  check("and bounded sanely", end > start && fn.length > 1000 && fn.length < 20000);
  check("it is async, so it can await the save", /^async function submitBehaviorReferral\(\)/.test(fn));
}

console.log("\n-- ORDER: nothing claims success before the save --");
{
  const saveAt = fn.indexOf("await requestSave(");
  // The RENDERED toast, not any mention of the phrase -- the comment above
  // this code quotes it while explaining the bug, and matching that made this
  // assertion fail for the wrong reason.
  const successAt = fn.indexOf("<strong>Referral submitted</strong>");
  check("the save is awaited, not fire-and-forget", saveAt !== -1);
  check("the success message comes AFTER the save", successAt > saveAt);
  check("the old fire-and-forget call is gone from this function",
    !/saveInBackground\(/.test(fn));
  // The row still appears immediately -- the table must not wait on a network.
  const pushAt = fn.indexOf("behaviorReferrals.push(referral)");
  check("the referral is still added to the table optimistically", pushAt !== -1 && pushAt < saveAt);
  check("the table is redrawn before the save, so the screen feels instant",
    fn.indexOf("updateReferralReviewTable") < saveAt);
}

console.log("\n-- a failed save is reported as a failure --");
{
  check("a false result is treated as an error", /ok === false\) throw new Error/.test(fn));
  check("the catch says it is NOT filed", /Not filed yet/.test(fn));
  check("and points at the retry", /Retry in the bar/.test(fn));
  check("the failure path does not claim submission",
    !/catch[\s\S]{0,400}<strong>Referral submitted<\/strong>/.test(fn));
  check("the button is released either way", /finally \{[\s\S]{0,120}setButtonBusy/.test(fn));
}

console.log("\n-- an unsaved referral is impossible to miss --");
{
  check("unsaved referrals are tracked", /_unsavedReferrals/.test(script));
  check("marked unsaved before the save runs",
    fn.indexOf("markReferralUnsaved(referral)") !== -1 &&
    fn.indexOf("markReferralUnsaved(referral)") < fn.indexOf("await requestSave("));
  check("cleared only on success", /markReferralSaved\(referral\.id\)/.test(fn));
  check("the bar exists in the markup", /id="unsavedReferralBar"/.test(html));
  check("it is hidden until needed", /id="unsavedReferralBar"[^>]*hidden/.test(html));
  check("it is announced to screen readers", /id="unsavedReferralBar"[^>]*role="alert"/.test(html));
  check("it names the student, so the teacher knows which one", /r\.studentName/.test(script.slice(script.indexOf("function renderUnsavedReferralBar"), script.indexOf("async function retryUnsavedReferrals"))));
  check("it has a retry button", /id="unsavedReferralRetry"/.test(html));
  check("retry flushes rather than queues", /await flushSaves\(\)/.test(script));
  check("the bar is styled and fixed on screen", /\.wc-unsaved-bar/.test(css) && /position: fixed/.test(css.slice(css.indexOf(".wc-unsaved-bar"))));
}

console.log("\n-- closing the tab is guarded --");
{
  const guard = script.slice(script.indexOf("window.addEventListener('beforeunload'"), script.indexOf("window.addEventListener('beforeunload'") + 400);
  check("a beforeunload handler exists", guard.length > 50);
  check("it only fires when something is actually unsaved", /if \(!_unsavedReferrals\.size\) return;/.test(guard));
  // A page that always prompts on close trains people to click through it.
  check("it does NOT prompt when everything is saved", /_unsavedReferrals\.size\) return/.test(guard));
}

console.log("\n-- every element these functions touch exists --");
{
  const region = script.slice(script.indexOf("const _unsavedReferrals"), script.indexOf("window.addEventListener('beforeunload'"));
  const ids = [...region.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  check("the bar functions read at least two elements", ids.length >= 2);
  [...new Set(ids)].forEach((id) => check(`#${id} exists in index.html`, html.includes(`id="${id}"`)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
