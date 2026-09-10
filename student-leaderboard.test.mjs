// The Wildcat Cash leaderboard on the student portal.
//
// Asked for 2026-09-10: a board with Academy / High School / Middle School,
// and each student's own rank among all students.
//
// This reverses a principle the portal previously stated in its own comments --
// "nobody is ranked on it" -- so the assertions below are mostly about the part
// that did NOT change: what leaves the server. Only the top ten are named. The
// rest of the ordering is computed server-side and stays there, because
// publishing it would tell six hundred children who has the least.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const server = readFileSync(new URL("./convex/leaderboard.ts", import.meta.url), "utf8");
const roster = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\n-- the server decides, and sends only the top --");
{
  check("the query is students-only", /await requireStudentSelf\(ctx\)/.test(server));
  // If the caller could name whose rank to look up, they could name anyone's.
  check("the viewer is never an argument", !/viewer.*:.*v\.string\(\)/.test(server) && !/args:[\s\S]{0,120}student/.test(server));
  check("it uses the tested ranking rule", /cashLeaderboard\(\{/.test(server));
  check("and resolves identity through the same helper", /viewerId: studentIdOf\(me as any\)/.test(server));
  check("it caps how many rows come back", /topN: topN \?\? 10/.test(server));

  // The ranking must NOT live in the browser: a student's page would then need
  // every child's earnings to draw it.
  check("no leaderboard rule was left in the browser bundle",
    !/cashLeaderboard/.test(roster));
}

console.log("\n-- enrolment is DERIVED, not read off the record --");
{
  // THE BUG THIS CAME FROM. No student row carries an `enrolled` field -- all
  // 757 have it undefined -- so `enrolled !== false` passed every record and
  // the board ranked 139 students who had left the school. The dashboard said
  // 618 and the leaderboard said 757, which is how it was spotted.
  check("the query does not trust a stored enrolled flag",
    !/students\"\)\.collect\(\)[\s\S]{0,200}cashLeaderboard/.test(server));
  check("it looks each student up in psRoster", /withIndex\("by_studentNumber"/.test(server));
  check("and sets enrolled from whether a roster row exists",
    /enrolled: Boolean\(hit\)/.test(server));
  check("the definition is documented as matching appData's",
    /same DEFINITION as appData/i.test(server));
  // The cheaper method is the point: this runs on every portal load.
  check("the read cost is recorded", /1,514 documents|about 1,514/.test(server));
  // The ranking rule still filters, so a caller passing enrolled:false is honoured.
  check("the rule still drops unenrolled students",
    /s\.enrolled !== false/.test(readFileSync(new URL("./convex/leaderboardRules.ts", import.meta.url), "utf8")));
}

console.log("\n-- the three bands --");
{
  ["academy", "hs", "ms"].forEach((b) =>
    check(`${b} reaches the client`, script.includes(`'${b}'`)));
  check("Academy is the default", /_wpBoardBand = 'academy'/.test(script));
  check("the labels come from the server, not hardcoded twice",
    /\(board && board\.bands\)/.test(script));
  check("with a fallback if the board failed to load", /key: 'academy', label: 'Academy'/.test(script));
  check("each tab switches band", /onclick="wpSetBoardBand\(/.test(script));
  check("tabs are marked up as tabs for screen readers",
    /role="tablist"/.test(script) && /role="tab"/.test(script) && /aria-selected=/.test(script));
}

console.log("\n-- the student's own rank --");
{
  const fn = script.slice(script.indexOf("function wpBoardPanel()"), script.indexOf("async function wpSetBoardBand"));
  check("their rank and the field size are shown", /You are <strong>#/.test(fn) && /of ' \+ v\.of/.test(fn));
  check("ties are said out loud", /level with/.test(fn));
  // A middle schooler looking at the High School board is not last: they are
  // not in it. Rendering that as a rank would be a lie about a child.
  check("out-of-band says so instead of showing a rank", /not in this group/.test(fn));
  check("and points them at the board they ARE on", /Academy board/.test(fn));
  // Unknown is not zero, and a child must not read it as one.
  check("no cash figure yet is stated as unranked, not as last",
    /do not have a Wildcat Cash total yet/.test(fn) && /not a zero/.test(fn));
  check("their own row is marked so they can find it", /is-me/.test(fn));
}

console.log("\n-- failure is not an empty board --");
{
  check("a failed fetch is kept apart from an empty one", /_wpBoardError/.test(script));
  check("and says it could not load", /could not be loaded just now/.test(script.slice(script.indexOf("function wpBoardPanel()"))));
  check("an genuinely empty group says that instead",
    /No Wildcat Cash has been awarded in this group yet/.test(script));
  check("the rest of the page is said to be unaffected", /Everything else on this page is unaffected/.test(script));
}

console.log("\n-- switching band does not re-deal the page --");
{
  const fn = script.slice(script.indexOf("async function wpSetBoardBand"), script.indexOf("function wpRepaintBoard"));
  check("only the board is refetched", /convexQuery\('leaderboard:cash'/.test(fn) && !/wpLoad|location\.reload/.test(fn));
  check("concurrent switches are guarded", /_wpBoardBusy/.test(fn));
  check("the chosen tab highlights before the network answers",
    fn.indexOf("wpRepaintBoard()") < fn.indexOf("await auth.convexQuery"));
  check("a repeat click on the current band does nothing", /band === _wpBoardBand\) return;/.test(fn));
  check("the band survives the dashboard's wholesale re-render",
    /band: _wpBoardBand/.test(script.slice(script.indexOf("Promise.allSettled"))));
}

console.log("\n-- the panel is in the dashboard, and styled --");
{
  check("the panel is rendered into the stack", /\+ wpBoardPanel\(\) \+/.test(script));
  // The phrase survives ONCE, inside the leaderboard block that explains why
  // the principle was reversed. What must not survive is the original claim
  // sitting beside the cash-activity panel, where it described the code.
  // A first version of this assertion just banned the phrase and failed on the
  // explanation quoting it -- a test cannot tell a claim from a citation by
  // string match alone, so it has to check WHERE.
  const occurrences = (script.match(/nobody is ranked on it/g) || []).length;
  check("the claim survives only once, as a citation", occurrences === 1);
  const leaderBlock = script.slice(script.indexOf("// WILDCAT CASH LEADERBOARD"),
                                   script.indexOf("let _wpBoardBand"));
  check("and that one is inside the block explaining the reversal",
    leaderBlock.includes("nobody is ranked on it"));
  const cashPanel = script.slice(script.indexOf("const recent = Array.isArray(cash.recent)") - 1200,
                                 script.indexOf("const recent = Array.isArray(cash.recent)"));
  check("the cash-activity panel no longer claims nothing is ranked",
    !/nobody is ranked on it/.test(cashPanel));
  check("it now points at the leaderboard instead", /Leaderboard panel above/.test(cashPanel));
  ["wp-board-tabs", "wp-board-tab", "wp-board-list", "wp-board-row",
   "wp-board-rank", "wp-board-name", "wp-board-amount", "wp-board-you"].forEach((c) =>
    check(`.${c} is styled`, css.includes("." + c)));
  check("rows are border-box so a border cannot overflow the panel",
    /\.wp-board-row \{[\s\S]{0,400}box-sizing: border-box/.test(css));
  check("the viewer's row and the podium look different from each other",
    css.includes(".wp-board-row.is-me") && css.includes(".wp-board-row.is-podium"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
