// Teacher view: an admin looking through a member of staff's eyes.
//
// The assertions that matter are the ones about what it must NOT do. Swapping
// the current user is easy; doing it without letting an admin write a ticket
// award or a referral under somebody else's name is the whole job. This is a
// discipline system, and a falsified attribution in the audit log is worse
// than a missing feature.
//
// Run: npm test

import { readFileSync } from "node:fs";
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\nIt is read-only, enforced at the chokepoint");
{
  // ONE guard in saveData rather than trust at 102 call sites.
  const head = script.slice(script.indexOf("async function saveData() {"),
                            script.indexOf("let saveSucceeded = false;"));
  check("saveData refuses while previewing",
    /isPreviewingTeacher\(\)\) \{[\s\S]*?return false;/.test(head));
  // Compared against the FULL script from the function start: `head` stops
  // before showSavingIndicator, so indexOf returned -1 and the first version
  // of this assertion could never pass.
  const fnStart = script.indexOf("async function saveData() {");
  const guardAt = script.indexOf("isPreviewingTeacher()", fnStart);
  const indicatorAt = script.indexOf("showSavingIndicator(true)", fnStart);
  check("the guard runs before saveData does any work",
    guardAt > fnStart && indicatorAt > fnStart && guardAt < indicatorAt);
  check("and the reason is recorded",
    /falsified attribution is worse\n\s*\/\/ than a missing feature/.test(script));
  // false is the signal every caller already understands.
  check("it returns the same 'did not save' value callers handle",
    /console\.warn\('\[teacher view\] Save blocked/.test(script));
}

console.log("\nIt only ever narrows, and never nests");
{
  check("only an admin or superadmin may start one",
    /me\.role !== 'admin' && me\.role !== 'superadmin'/.test(script));
  check("a preview cannot be started from inside a preview",
    /if \(isPreviewingTeacher\(\)\) return;\s*\/\/ never nest a preview/.test(script));
  check("the real user is kept, not overwritten",
    /let realUser = null;/.test(script) && /realUser = me;/.test(script));
  check("the previewed record is COPIED, so it cannot be edited in place",
    /currentUser = Object\.assign\(\{\}, target\);/.test(script));
  check("exiting restores the real user",
    /currentUser = realUser;\s*\n\s*realUser = null;/.test(script));
}

console.log("\nIt is never persisted");
{
  // A preview that survived a refresh would be an admin permanently wearing
  // somebody else's role with no memory of choosing it.
  const fn = script.slice(script.indexOf("function startTeacherPreview()"),
                          script.indexOf("function endTeacherPreview()"));
  check("starting a preview does not save the session", !/saveSession\(\)/.test(fn));
  check("nor write anything", !/saveData\(\)/.test(fn) && !/requestSave\(/.test(fn));
  check("and the guarantee is written down",
    /refresh always lands back as the real admin/.test(script));
}

console.log("\nIt is impossible to forget you are in it");
{
  check("a banner is rendered while previewing",
    /id="wcPreviewBar"|bar\.id = 'wcPreviewBar'/.test(script));
  check("and removed when it ends",
    /if \(!isPreviewingTeacher\(\)\) \{ if \(bar\) bar\.remove\(\); return; \}/.test(script));
  check("it is fixed on screen rather than scrolled past",
    /\.wc-preview-bar \{[\s\S]*?position: fixed/.test(css));
  check("it carries an exit control", /onclick="endTeacherPreview\(\)"/.test(script));
  check("and content is padded so the bar does not cover the last row",
    /body:has\(\.wc-preview-bar\) \.app-content/.test(css));
}

console.log("\nIt tells the truth about what it cannot show");
{
  // The browser still holds the ADMIN's token, so server-side decisions still
  // answer as admin. An admin who believes otherwise will conclude a teacher
  // can see restricted data they cannot.
  check("the banner says server permissions still answer as the admin",
    /server permissions ' \+\s*\n\s*'still answer as you/.test(script));
  check("and the limitation is explained at the code",
    /PREVIEW OF THE SCREEN, not a test of server permissions/.test(script));
  check("with the specific wrong conclusion named",
    /Never conclude from this view\n\s*\/\/ that a teacher can see something/.test(script));
}

console.log("\nThe entry point is gated twice");
{
  check("the card is admin-only in the markup",
    /class="wc-card panel-card admin-only" id="teacherPreviewCard"/.test(html));
  check("and script.js checks again rather than trusting that",
    /Gated here as well as in the markup/.test(script));
  check("the picker excludes the admin themselves",
    /String\(t\.id\) !== String\(me && me\.id\)/.test(script));
  check("it repopulates when the Teachers tab opens",
    /tabName === 'teachers' && typeof populatePreviewTeacherSelect === 'function'/.test(script));
  check("and it says read-only where the button is",
    /<strong>Read-only<\/strong>/.test(html));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
