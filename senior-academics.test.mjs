// The Seniors tab: the one screen in Academics that names a child.
//
// Asked for on 2026-09-11: the school uses grades as the incentive for senior
// privileges and a failing grade withdraws them, so the decision is about a
// named student and cannot be made from an aggregate.
//
// THE ASSERTIONS THAT MATTER ARE THE ONES ABOUT WHO STILL CANNOT SEE IT, and
// the ones that stop this becoming a general "any named student's academic
// record" endpoint. The rest of Academics promises the opposite of this tab;
// this file is the argument that both promises are still true.
//
// Run: npm test

import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL("./" + f, import.meta.url), "utf8");
const script = read("script.js");
const html = read("index.html");
const css = read("styles.css");
const server = read("convex/seniorAcademics.ts");
const rules = read("convex/seniorEligibility.ts");
const schema = read("convex/schema.ts");
const policy = read("convex/restrictedPolicy.ts");
const approval = read("docs/field-sourcing-approval.md");
const modes = read("wildcat-modes.js");

/**
 * Source with comments removed.
 *
 * THREE ASSERTIONS IN THE FIRST DRAFT OF THIS FILE FAILED BECAUSE THEY MATCHED
 * A COMMENT. "requireStaff" appears in seniorAcademics.ts only inside the
 * paragraph explaining why requireStaff was NOT used; the old two-way ternary
 * appears in script.js only inside the comment recording the bug it caused.
 * Asserting an absence against commented source tests the documentation and
 * calls it the code.
 */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
/**
 * Collapsed whitespace, for prose that wraps across lines in the source.
 *
 * Strips the JSDoc continuation asterisk FIRST. Collapsing whitespace alone
 * turns "...in two\n * browsers is worse..." into "...in two * browsers is
 * worse...", so a sentence that reads correctly in the file still fails to
 * match, and the obvious repair is to shorten the assertion until it fits
 * inside one line -- which makes the test about line wrapping.
 */
const flat = (src) => src.replace(/^\s*\*[ \t]?/gm, "").replace(/\s+/g, " ");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

// The senior code, isolated the way the other academics tests isolate theirs.
const ui = script.slice(
  script.indexOf("// ---- Academics: two tabs, two rules"),
  script.indexOf("function switchSystemMode"),
);

console.log("\n-- the approval came first, and says what it grants --");
{
  check("it is recorded as its own decision, dated",
    /Added 2026-09-11: individual senior academic records/.test(approval));
  check("it names the decision it informs",
    /whether a named senior takes part in senior privileges/i.test(flat(approval)));
  check("it does not read itself into the aggregate grant",
    /a new decision, not a widening/i.test(approval));
  check("it records the failing bar in force", /D, F and NP/.test(approval));
  check("and a review date", /Review due: 2027-09-11/.test(approval));
  check("it says what was NOT granted",
    /nothing below grade 12/i.test(approval) && /no export/i.test(approval));
}

console.log("-- the gate is the strict one, and cannot drift by editing an array --");
{
  // requireAdmin and requireStaff+ACADEMICS_ROLES express the same set today.
  // That is the trap: the obvious future edit is appending "pbis" when PBIS
  // asks for the aggregate dashboard. On an aggregate that hands over counts.
  // Here the same one-word edit hands over 41 named seniors' failing grades
  // and their homework.
  const admins = server.match(/requireAdmin\(ctx\)/g) || [];
  check("both queries call requireAdmin", admins.length === 2);
  // Against the CODE, not the comments: the paragraph above these calls
  // explains at length why requireStaff was not used, and an absence assertion
  // over commented source would fail on its own rationale.
  check("and neither uses the editable role array",
    !/ACADEMICS_ROLES/.test(code(server)) && !/requireStaff/.test(code(server)));
  check("teachers are not given their own seniors either",
    !/canViewStudent/.test(code(server)));
  check("the file says why the strict check was chosen",
    /cannot drift by editing an array|Widening this means editing identity\.ts/.test(server));
  check("Academics Mode itself is still admin-only",
    /ACADEMICS_ROLES = \['admin', 'superadmin'\]/.test(modes));
}

console.log("-- it is bounded to seniors by the server, not by the UI --");
{
  // detail takes a caller-supplied student number, so without a subject check
  // it is a general "any named student's complete academic record" endpoint
  // that merely happens to be called from this tab.
  check("the grade level is re-derived on every open",
    /gradeLevel \?\? ""\)\.trim\(\) === SENIOR_GRADE/.test(server));
  check("and a non-senior is refused in words",
    /not in twelfth grade/.test(server));
  check("the senior constant is 12", /SENIOR_GRADE = "12"/.test(server));
  check("a blank student number is refused, never looked up",
    /if \(!key\)/.test(server) && /FAIL CLOSED/.test(server));
  check("and the file says why an empty key is dangerous",
    /is a real bucket/.test(server));
}

console.log("-- the senior set comes from the live sync, not the app's own table --");
{
  // MEASURED 2026-09-11: students.grade === "12" returns 80 people;
  // psRoster.gradeLevel === "12" returns 41. The other 39 are in the app's
  // table and in no PowerSchool enrolment -- last year's class, graduated and
  // gone. They carry no current grades, so every one of them would have
  // appeared at the top of an eligibility list showing zero failing classes.
  check("seniors are enumerated from psRoster",
    /query\("psRoster"\)[\s\S]{0,200}by_gradeLevel/.test(server));
  check("and NOT from students.grade",
    !/query\("students"\)[\s\S]{0,160}eq\("grade"/.test(server));
  check("the measurement is written down so nobody 'fixes' it",
    /graduated and left/.test(server) && /757 rows for a school of 618/.test(server));
  check("the index it needs exists", /by_gradeLevel", \["gradeLevel"\]/.test(schema));
  check("names are joined from the roster table", /firstName/.test(server));
}

console.log("-- an undercount grants a privilege, so a running sync is announced --");
{
  // replaceGrades DELETES psGrades and refills it chunk by chunk, and a run is
  // recorded only on success. Mid-sync the table holds a PREFIX of the truth:
  // nothing errors, and a senior failing three classes shows zero.
  check("the server detects a sync in flight", /function detectInFlight/.test(server));
  check("by comparing row timestamps to the last successful run",
    /maxSyncedAt > lastRunAt/.test(server));
  check("the file names the hazard and its direction",
    /holds a PREFIX of the truth/.test(server) && /GRANTS A PRIVILEGE/.test(server));
  check("the screen says so above the table, not in a footnote",
    /A grade sync is running/.test(ui) && /FEWER failing classes/.test(ui));
}

console.log("-- 'we did not look' never wears the costume of 'nothing wrong' --");
{
  check("no posted grade gives null, not zero",
    /const failingCount = anyMark \? counts\.failingDF : null/.test(server));
  check("the file says why", /must never wear the costume/.test(server));
  check("those rows sort to the very top", /a\.failingCount === null \? -1 : 1/.test(server));
  check("and render as an absence, not a zero", /no grades synced/.test(ui));
  check("an unmarked class is neither a pass nor a fail",
    /THREE BANDS, NOT A BOOLEAN/.test(rules));
  check("and nothing unposted can ever read as failing",
    /CAN EVER BECOME "fails"/.test(flat(rules)));
}

console.log("-- the rule is a constant, and the screen prints it --");
{
  check("one exported constant", /export const FAILING_THRESHOLD/.test(rules));
  check("not a setting, and the file says why",
    /NOT A SETTING/.test(rules) && /two browsers is worse than either answer/.test(flat(rules)));
  check("both readings are always computed",
    /export function countUnderBothRules/.test(rules));
  check("the footnote is generated from the server, not typed",
    /d\.rule\.label/.test(ui) && /wouldDropIfFOnly/.test(ui));
}

console.log("-- the popup has to hold up if the student challenges it --");
{
  check("the timestamp is at the top, not in a footer",
    ui.indexOf("grades as of") < ui.indexOf("wc-sr-foot"));
  check("classes nobody has marked are NAMED, never omitted",
    /Classes with no grade posted/.test(ui) &&
    /not counted as passing or failing/.test(ui));
  check("the reasons the count could be wrong sit above the classes",
    ui.indexOf("Read these first") < ui.indexOf("Classes being failed"));
  check("a stale gradebook is one of them", /days ago\. The grade may not reflect/.test(ui));
  check("so is work flagged missing that already carries a score",
    /flag may be out of date/.test(ui));
  check("failing with nothing outstanding is explained, not an empty box",
    /Nothing is outstanding in this class/.test(ui));
  check("the projection is phrased as arithmetic, not a forecast",
    /would come to/.test(ui) && /which way the number moves/.test(ui));
  check("and admits the app does not hold the grade scale",
    /does not hold the school/.test(ui) && /grade scale/.test(ui));
  check("points with no possible value are omitted, never 'worth 0'",
    /pointsPossible !== null/.test(ui));
  check("work attached to no class is shown rather than dropped",
    /Work with no class recorded/.test(ui));
}

console.log("-- the words this screen never uses --");
{
  // A screen that prints "Eligible" beside a name is the app making the
  // decision, and "Eligible" is what gets quoted in a meeting.
  const banned = /\b(eligible|ineligible|qualifies|at risk|at-risk)\b/i;
  check("no verdict word appears in the senior UI", !banned.test(ui));
  check("nor in the server", !banned.test(server.replace(/eligibility/gi, "")));
  check("and the screen says outright that it does not decide",
    /does not decide eligibility/.test(ui));
}

console.log("-- the aggregate promise is still true where it was made --");
{
  check("the old promise moved into the Whole School pane, unedited",
    /Whole-school grades only\. Never a single student\./.test(html));
  check("it sits inside that pane, not in the mode header",
    html.indexOf('id="acadPaneSchool"') < html.indexOf("Whole-school grades only"));
  check("the mode header now says the two tabs differ",
    /Two tabs, and they follow different rules/.test(html));
  check("the seniors pane carries a standing banner instead",
    /This tab names individual students/.test(html));
  // Scoped to the banner element itself rather than to a span of the file:
  // a close control anywhere between two unrelated ids is not the thing being
  // asserted.
  const bannerHtml = html.slice(html.indexOf('class="wc-sr-banner"'),
                                html.indexOf('</div>', html.indexOf('class="wc-sr-banner"')));
  check("the banner carries no way to dismiss it",
    bannerHtml.length > 50 && !/onclick|<button/.test(bannerHtml));
  check("named-student rows have their own CSS namespace",
    /\.wc-sr-row/.test(css) && /ITS OWN NAMESPACE ON PURPOSE/.test(css));
}

console.log("-- no demographic field is anywhere near this --");
{
  check("restricted fields are untouched", /RESTRICTED_FIELDS = \[/.test(policy));
  check("and still five", (policy.match(/\/\/ manifest \d+/g) || []).length >= 5);
  check("teacher, campusaide and pbis still hold nothing",
    /teacher: \[\]/.test(policy) && /campusaide: \[\]/.test(policy) && /pbis: \[\]/.test(policy));
  check("neither query touches psRestricted", !/psRestricted/.test(server));
  check("nor any demographic column",
    !/fedEthnicity|raceCodes|elaStatus|iepStatus|section504/.test(server));
}

console.log("-- a mode with subtabs keeps them, whoever asks --");
{
  // THE BUG THIS BLOCK EXISTS FOR, AND IT SHIPPED ONCE. updateSidebarModeUI
  // rendered the subnav for `mode === 'hallpass' || mode === 'discipline'` and
  // its else branch set innerHTML = ''. switchSystemMode('academics') built
  // the Seniors buttons and then called that function one line later, which
  // fell through to the else and WIPED them. Nothing errored; the nav was just
  // empty, and the tab did not exist as far as anyone could tell.
  //
  // This was the SECOND hardcoded two-mode list to break a third mode in one
  // feature -- sidebarSubTab's container ternary was the first. So the
  // assertion is about the shape, not about academics: no code path may decide
  // whether a mode has a subnav by naming modes.
  const src = code(script);
  check("the subnav branch asks MODE_SUBTABS, not a list of mode names",
    /\} else if \(MODE_SUBTABS\[mode\]\) \{/.test(src));
  check("no surviving code compares mode against two hardcoded names",
    !/mode === '(hallpass|discipline|academics)' \|\| mode === '/.test(src));
  check("the container lookup is a map too", /MODE_CONTAINERS = \{/.test(src));
  check("and every mode with subtabs has a container entry", (() => {
    const subtabKeys = [...(script.match(/^\s{12}(\w+): \[$/gm) || [])]
      .map((l) => l.trim().replace(":", "").replace(" [", ""));
    const containers = (src.match(/MODE_CONTAINERS = \{([\s\S]*?)\}/) || [])[1] || "";
    return subtabKeys.length >= 3 && subtabKeys.every((k) => containers.includes(k + ":"));
  })());
  // And the ordering hazard that made it invisible rather than broken.
  check("switchSystemMode renders the subnav before it updates the sidebar",
    script.indexOf("renderModeSubnav('academics')") <
    script.indexOf("if (typeof updateSidebarModeUI === 'function') updateSidebarModeUI();\n                return;"));
}

console.log("-- the layout is not flush against its own edges --");
{
  // THE BUG THIS BLOCK EXISTS FOR. .ref-modal-card carries no padding of its
  // own, and every modal body in this app got its padding from a hardcoded
  // list of three ids. A fourth modal was simply not in the list, so every
  // line of the senior record sat against the card edge.
  check("modal bodies get padding from a class, not only from an id list",
    /\.ref-modal-body,\s*\n#closeReferralBody/.test(css));
  check("and the senior modal uses it",
    /id="seniorDetailBody" class="ref-modal-body"/.test(html));

  // .form-input does not exist in this stylesheet -- it was invented, so the
  // search box rendered with the browser's own 1px of padding.
  check("the search box uses a class this stylesheet actually defines",
    /id="seniorSearch" class="wc-input/.test(html) && /\.wc-select, \.wc-input \{/.test(css));
  check("and no element on this screen asks for a class that does not exist",
    !/class="[^"]*\bform-input\b/.test(html));

  // A margin-top on an inline span does nothing, so the course number butted
  // straight against the course name: "Common Core English 12 A1003A".
  check("the class meta line is a block, so it breaks",
    /\.wc-sr-class-meta \{[^}]*display: block/.test(css));
  check("and the class name is too",
    /\.wc-sr-class-name \{[^}]*display: block/.test(css));

  // Measured at 165 characters per line with line-height: normal before this.
  check("the explaining paragraphs have a readable measure",
    /#academicsContent \.panel-hint \{[^}]*max-width: 78ch/.test(css) &&
    /#academicsContent \.panel-hint \{[^}]*line-height: 1\.6/.test(css));
  check("scoped to this mode, because .panel-hint is used across every other one",
    /used 57 times across/.test(css));
  check("the counts block hugs its content instead of banding the card",
    /\.wc-acad-tally \{[^}]*width: fit-content/.test(css));
}

console.log("-- wired into the app --");
{
  check("the mode has a subnav key", /academics: \[\s*\n\s*\{ id: 'school'/.test(script));
  check("and it opens on the aggregate tab", /switchAcademicsTab\('school'\)/.test(script));
  // The old ternary still appears in script.js -- inside the comment that
  // records the bug it caused. Assert against the code.
  check("the container lookup is a map, not a two-way ternary",
    /MODE_CONTAINERS = \{/.test(script) &&
    !/mode === 'hallpass' \? 'clawPassContent' : 'disciplineContent'/.test(code(script)));
  check("both queries are reachable from the browser",
    /convexQuery\('seniorAcademics:failingList'/.test(script) &&
    /convexQuery\('seniorAcademics:detail'/.test(script));
  check("the list only loads when its tab is opened",
    /if \(_acadTab === 'seniors'\) loadSeniorAcademics\(\); else renderAcademics\(\);/.test(script));

  const ids = [...ui.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  check("the senior UI reads at least six elements", ids.length >= 6);
  [...new Set(ids)].forEach((id) => check(`#${id} exists in index.html`, html.includes(`id="${id}"`)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
