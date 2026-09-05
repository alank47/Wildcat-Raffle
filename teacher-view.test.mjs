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

console.log("\nIt shows THEIR roster, via an admin-only query");
{
  const views = readFileSync(new URL("./convex/views_app.ts", import.meta.url), "utf8");

  check("there is a query that names the staff member",
    /export const teacherRosterFor = query\(\{\s*\n\s*args: \{ email: v\.string\(\) \}/.test(views));
  // The one line that must be exactly right.
  check("it is gated on requireAdmin, not requireStaff",
    /teacherRosterFor[\s\S]*?const admin = await requireAdmin\(ctx\);/.test(views));
  check("a teacher cannot reach it: requireStaff is not used in it",
    !/teacherRosterFor[\s\S]{0,900}requireStaff/.test(views));

  // The existing query every teacher depends on must be untouched.
  check("teacherRoster still takes no arguments",
    /export const teacherRoster = query\(\{\s*\n\s*args: \{\},/.test(views));
  // The lookup address is now resolved through rosterEmailFor, so a teacher
  // whose sections PowerSchool files under an older address still gets them.
  // The property this asserts is unchanged and is the one that matters: the
  // address comes from the AUTHENTICATED record, never from an argument.
  check("and still resolves from the caller's own token",
    /teacherRoster = query[\s\S]*?const lookup = await rosterEmailFor\(ctx, teacher\);[\s\S]*?q\.eq\("teacherEmail", lookup\.email\)/.test(views));
  check("and rosterEmailFor is handed the authenticated record, not an argument",
    !/teacherRoster = query\(\{\s*\n\s*args: \{[^}]/.test(views));
  check("the duplication is a recorded decision, not an accident",
    /WHY THIS DUPLICATES teacherRoster INSTEAD OF SHARING A HELPER/.test(views));

  // An empty roster is the answer this feature exists to give.
  check("an empty roster explains itself rather than looking broken",
    /No PowerSchool roster rows for this address/.test(views));
}

console.log("\nThe preview roster never touches the shared cache");
{
  // THE BUG THIS PREVENTS. sisTeacherRoster is cached and only refetched when
  // empty or forced. Writing a previewed teacher's roster into it would leave
  // it there after the preview ended, when saving is re-enabled — an admin
  // awarding cash to somebody else's class with nothing on screen saying so.
  check("preview has its own variable", /let previewRoster = null;/.test(script));
  check("nothing in the preview path assigns the shared cache",
    !/previewRoster[\s\S]{0,400}sisTeacherRoster =/.test(script));

  const loader = script.slice(script.indexOf("async function loadPreviewRoster"),
                              script.indexOf("function endTeacherPreview"));
  check("the loader writes only the preview variable",
    /previewRoster = await auth\.convexQuery/.test(loader) &&
    !/sisTeacherRoster/.test(loader));

  check("the shared loader short-circuits while previewing",
    /if \(isPreviewingTeacher\(\)\) return previewRoster;/.test(script));
  check("and every reader goes through one accessor",
    /function activeTeacherRoster\(\) \{/.test(script) &&
    /roster: activeTeacherRoster\(\)/.test(script) &&
    /sectionsFrom\(activeTeacherRoster\(\)\)/.test(script));

  const exit = script.slice(script.indexOf("function endTeacherPreview"),
                            script.indexOf("function renderPreviewBanner"));
  check("exiting clears the preview roster", /previewRoster = null;/.test(exit));
  check("and forces the real one to be re-read before saving resumes",
    /loadTeacherRosterFromSIS\(true\)/.test(exit));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
