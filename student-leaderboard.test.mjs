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
  // THE COPY CHANGED ON LAUNCH EVE and the reason is worth keeping. This read
  // "You do not have a Wildcat Cash total yet, so you are not ranked. That is
  // not a zero." -- correct while a zero WAS ranked, so this branch only ever
  // meant "no figure at all".
  //
  // Since 2026-09-13 a zero is deliberately NOT a rank
  // (convex/leaderboardRules.ts), because the school reset every balance and
  // every one of 619 students would otherwise have been told "You are #1 of
  // 619 with $0.00 -- level with 618 others" above ten classmates on a gold
  // podium at $0.00. So this branch is now mostly reached by a child who has
  // simply earned nothing, and telling them their zero "is not a zero" is a
  // riddle.
  check("earning nothing yet is stated plainly, not as last place",
    /have not earned any Wildcat Cash yet/.test(fn) && /not on the board/.test(fn));
  check("and it points forward rather than just refusing", /Earn some and you will be/.test(fn));
  // COMMENT-STRIPPED. The first version of this was !/not a zero/.test(fn) and
  // failed against the comment ABOVE the changed line, which quotes the old
  // copy to explain why it went. An absence assertion over raw source tests
  // the prose as well as the code -- the same trap that was caught in the
  // leaderboard CSS earlier today.
  const fnCode = fn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the riddle is gone from the code", !/not a zero/.test(fnCode));
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
  // Asserted against the RETURN EXPRESSION rather than a literal "+ x() +".
  // Adding the store card wrapped that line, so the old regex stopped matching
  // while the code was correct -- a test that depends on where a line breaks
  // fails on formatting, not on behaviour.
  const renderExpr = (() => {
    // Anchored on wpDashboard's own return statement rather than on the first
    // panel named in it. This was "return tiles + passPanel", and the tile row
    // was removed on 2026-09-10 -- so a locator naming the first term broke
    // while the code was fine. Twice, in two files.
    // The render list is the return that names the panels -- NOT the first
    // return in the function, which is the early-out for missing data, and not
    // one identified by its first term, which broke when the tile row was
    // removed. Found by what it contains.
    const dStart = script.indexOf("function wpDashboard(");
    let at = dStart, found = "";
    for (;;) {
      const r = script.indexOf("return ", at);
      if (r === -1) break;
      const stmt = script.slice(r, script.indexOf(";", r) + 1);
      if (stmt.includes("passPanel") && stmt.includes("attendance")) { found = stmt; break; }
      at = r + 7;
    }
    return found;
  })();
  check("the render expression was located", renderExpr.length > 40 && renderExpr.length < 400);
  check("the panel is rendered into the stack", renderExpr.includes("wpBoardPanel()"));
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

  // ---- THE ROW GEOMETRY, reported 2026-09-13 as "the box the balances are
  // in are a bit cut off". Two faults in one row.
  //
  // COMMENT-STRIPPED, as insurance rather than as a present necessity. These
  // rules carry long comments naming the properties they REPLACED, and a
  // regex over raw CSS would match that prose and pass either way -- an
  // assertion that .wp-board-name no longer says `text-overflow` matching the
  // comment that explains `text-overflow` never worked. That is avoided today
  // by keeping both comments ABOVE their selector, so the rule bodies hold no
  // prose at all and these assertions would pass without the strip. Review
  // caught the version where one comment sat inside the block. The strip stays
  // so that moving a comment back inside cannot silently turn these into
  // tautologies; it is the cheap half of the fix and the placement is the
  // fragile half.
  const rule = (sel) => {
    const at = css.indexOf(sel + " {");
    if (at === -1) return "";
    return css.slice(at, css.indexOf("}", at))
      .replace(/\/\*[\s\S]*?\*\//g, "");
  };
  const nameRule = rule(".wp-board-name");
  const rowRule = rule(".wp-board-row");
  const amountRule = rule(".wp-board-amount");
  check("the three rules were located", nameRule && rowRule && amountRule);

  // FAULT 1, the one the owner saw. 10px was the entire distance between the
  // last word of a name and a 700-weight figure, so they read as one run of
  // text and the money looked chopped.
  check("the figure is not 10px from the row edge any more", /padding: 8px 12px/.test(rowRule));
  check("nor 10px from the name beside it", /gap: 12px/.test(rowRule));

  // FAULT 2. The standard truncation recipe was on a display:flex box, where
  // text-overflow does nothing: it acts on the inline content of a BLOCK box
  // and is not inherited, and the name is an anonymous flex item. So
  // "Christopher Alexander Villanueva-Hernandez" stopped mid-word with no
  // ellipsis. Compound surnames are common on this roster.
  check("the dead ellipsis is gone from the declarations", !/text-overflow/.test(nameRule));
  check("and the nowrap that hard-clipped the name with it", !/white-space:\s*nowrap/.test(nameRule));
  check("a long name wraps instead", /overflow-wrap: anywhere/.test(nameRule));
  check("and can still shrink below its content width", /min-width: 0/.test(nameRule));

  // A wrapped name must not leave the rank and the figure floating in the
  // middle of it. Caught by review, not by the design pass.
  check("rank and figure hang off the FIRST line of a wrapped name",
    /align-items: flex-start/.test(rowRule) && !/align-items: center/.test(rowRule));

  // THE MONEY NEVER GIVES WAY. "$1,2" over "450.00" is a different number.
  check("the figure never shrinks", /flex: 0 0 auto/.test(amountRule));
  check("and never wraps", /white-space: nowrap/.test(amountRule));
  // The measured reason is recorded elsewhere in this stylesheet: a tabular
  // full stop takes a whole digit cell in this face and typesets "$14 . 50".
  // Every figure here carries a full stop.
  check("and carries no tabular numerals", !/font-variant-numeric/.test(amountRule));

  // The grade line inherited the nowrap that just went, and inherits
  // `anywhere` instead -- which would break "Grade 12" after "Grade 1".
  check("the grade label keeps its own nowrap",
    /white-space: nowrap/.test(rule(".wp-board-grade")));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
