// Academics Mode: grades aggregated, never a child.
//
// Asked for on 2026-09-10 as a twelve-metric dashboard. This is the honest
// third of it: coverage, how many students carry a D or F, and the same split
// by race. The other nine were either not computable from what the school
// holds, not meaningful at 77% coverage four weeks into a year, or -- in the
// case of English-learner status -- blocked by the school's own approval
// record, which says "NOT approved. No decision has been named that it
// informs."
//
// The assertions that matter are the ones about what does NOT reach the screen.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const server = readFileSync(new URL("./convex/academics.ts", import.meta.url), "utf8");
const approval = readFileSync(new URL("./docs/field-sourcing-approval.md", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\n-- the approval came first, and says what it grants --");
{
  check("academics is recorded as its own decision, dated",
    /Amended 2026-09-10: extended to ACADEMIC outcomes/.test(approval));
  check("it names the decision it informs", /whether course failure falls disproportionately/i.test(approval));
  // The 2026-08-19 grant is for discipline. Reading academics into it silently
  // is exactly what this file exists to prevent.
  check("it does not claim the earlier discipline grant covered it",
    /a different decision and is recorded/i.test(approval) || /different decision/i.test(approval));
  check("the limits are recorded with it, not left to the reader",
    /only a very large gap/i.test(approval) && /never be reported/i.test(approval));
  check("EL is still refused", /English-learner status, which\s*\n?remains "NOT approved"/.test(approval)
    || /NOT approved/.test(approval));
  // Whitespace-tolerant: the sentence wraps in the file, and the first version
  // of this check required the words on one line.
  check("no role gained a field",
    /No role gains a field/.test(approval) && /restrictedPolicy\.ts`\s+is untouched/.test(approval));
}

console.log("\n-- three gates, and the server is the real one --");
{
  check("the query requires staff identity", /await requireStaff\(ctx\)/.test(server));
  check("and refuses anyone outside admin/superadmin",
    /ACADEMICS_ROLES = \["admin", "superadmin"\]/.test(server) &&
    /!ACADEMICS_ROLES\.includes\(staff\.role\)/.test(server));
  check("the mode switcher checks too", /canOpenAcademics\(currentUser && currentUser\.role\)/.test(script));
  check("and sends a refused caller somewhere safe", /switchSystemMode\('cash'\);/.test(script));
  // SCOPED TO THE ACADEMICS RENDERER, not the whole file. script.js legitimately
  // mentions raceCodes elsewhere -- the admin race-VERIFICATION screen, which
  // the 2026-08-19 amendment approved so an administrator can check the
  // aggregate against its source. Scanning the whole file caught that and
  // failed for the wrong reason.
  const renderer = script.slice(script.indexOf("async function renderAcademics"),
                                script.indexOf("function switchSystemMode"));
  check("the academics renderer was located", renderer.length > 1000);
  check("the browser never computes the breakdown itself",
    !/reportedCategories|raceCodes|fedEthnicity|classifyEthnicity/.test(renderer));
  check("it never receives a student number either", !/studentNumber/.test(renderer));
}

console.log("\n-- what cannot reach the screen --");
{
  // A withheld cell must not ship its numbers and let the client hide them.
  check("suppression happens in the server module, not the renderer",
    /cellOf\(/.test(server) && !/SMALL_GROUP|MIN_CELL_COUNT/.test(script));
  check("the renderer only reads what it was given", /c\.withheld/.test(script));
  check("a withheld row still appears, so a group is never silently missing",
    /is-withheld/.test(script) && /wc-acad-row\.is-withheld/.test(css));
  check("and it shows the reason rather than a blank", /escapeHtml\(c\.reason/.test(script));

  // Race at school scope only: the bands partition the school, so publishing a
  // total beside two halves makes a withheld cell recoverable by subtraction.
  check("the query takes no band argument at all", /args: \{\},/.test(server));
  check("and says why in the file", /recovered by subtraction/.test(server));
}

console.log("\n-- coverage is the loudest thing on the screen --");
{
  check("coverage is rendered first", script.indexOf("acadCoverage") < script.indexOf("acadRaceRows"));
  check("as the largest figure", /\.wc-acad-cov-pct \{[^}]*font-size: 30px/.test(css));
  check("it says the numbers are over posted grades only", /over the grades that/.test(script));
  check("and that the figure is a floor, not a rate", /It is a floor, not a rate/.test(script));
  check("coverage is never suppressed", /coverage/.test(server) && !/coverage: null,\s*withheld/.test(server));
}

console.log("\n-- the count is a count, not a rate --");
{
  // A rate whose denominator grows every time a teacher posts would climb for
  // weeks with no child's work changing.
  check("students failing is shown as a number", /studentsFailingAny\.toLocaleString\(\)/.test(script));
  check("and labelled as counted, not rated", /Counted, not rated/.test(script));
  check("with the direction it can move", /can only go up as more grades are entered/.test(script));
}

console.log("\n-- the interval, and the sentence that matters most --");
{
  check("each reported group shows its range", /could be ' \+ lo \+/.test(script));
  check("the footer says how many groups could be reported", /groups are large enough to report/.test(script));
  // The finding at this school is that the two reportable groups do NOT differ.
  check("and that no difference visible is not no difference",
    /not\s*\n?\s*'the same as no gap/.test(script) || /same as no gap/.test(script));
  check("it explains why a small group hides a gap", /the smaller a group, the wider its range/.test(script));
  check("the separation test is the server's, not the screen's", /intervalsSeparate/.test(server));
}

console.log("\n-- wired into the app --");
{
  check("the container exists", /id="academicsContent"/.test(html));
  check("hidden until the mode is opened", /id="academicsContent" style="display: none;"/.test(html));
  check("the mode is registered", /academics:\s*\{ label: 'Academics'/.test(script));
  check("switchSystemMode handles it", /if \(mode === 'academics'\)/.test(script));
  check("it is NOT in the launch list",
    !/LAUNCH_MODES = \['cash', 'discipline', 'academics'\]/.test(
      readFileSync(new URL("./wildcat-modes.js", import.meta.url), "utf8")));

  const ids = [...script.slice(script.indexOf("async function renderAcademics"),
                              script.indexOf("function switchSystemMode"))
    .matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  check("the renderer reads at least four elements", ids.length >= 4);
  [...new Set(ids)].forEach((id) => check(`#${id} exists in index.html`, html.includes(`id="${id}"`)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
