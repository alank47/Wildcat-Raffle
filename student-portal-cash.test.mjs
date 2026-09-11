// The student portal is about Wildcat Cash, not the raffle.
//
// A child opening their own screen led with "Tickets, this cycle", then a
// "Ticket sources" panel breaking it into PBIS / Attendance / Academic, then a
// "Jackpot draw" panel counting draw entries and weeks qualified. All Raffle,
// which the school has not switched on -- so the first number a student saw
// about themselves came from a system nobody was using.
//
// What replaced the jackpot panel was already being sent: myStudentView has
// returned the last fifteen cash movements since the portal was built, with a
// field-by-field allowlist, and nothing rendered them.
//
// Run: npm test

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const raw = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const server = readFileSync(new URL("./convex/views_app.ts", import.meta.url), "utf8");

/** The portal renderer only, comments stripped. */
const portal = raw
  .slice(raw.indexOf("function wpDashboard("), raw.indexOf("let _wpDashLast = null;"))
  .replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

console.log("\nNo raffle vocabulary on a student's own screen");
{
  for (const w of ["Jackpot", "jackpot", "Raffle", "raffle", "Ticket", "ticket"]) {
    check(`"${w}" does not appear`, !portal.includes(w));
  }
  check("the ticket-sources panel is gone", !/wpPanel\('Ticket sources'/.test(portal));
  check("the jackpot panel is gone", !/wpPanel\('Jackpot draw'/.test(portal));
  check("and neither is still concatenated into the page",
    !/\+ tickets \+/.test(portal));
}

console.log("\nOne card leads with what the student came to see");
{
  // THE PRINCIPLES HERE ARE UNCHANGED; ONLY THEIR LOCATION MOVED.
  // Until 2026-09-10 the balance and Earned were TILES and this block asserted
  // wpTile(...). The school asked for the four Wildcat Cash cards to become
  // one, so the figures moved into the card and the tiles were removed rather
  // than duplicated. What must still hold is what these checks were always
  // really about: the balance leads, and Earned is visible beside it.
  check("the balance still leads, now as the card's hero figure",
    /wp-cash-balance">' \+ wpMoney\(cash\.balance\)/.test(portal));
  // A balance falls when they spend. A child who only sees it drop has no
  // record of ever having earned anything.
  check("earned sits with it, so spending does not read as loss",
    /wp-cash-stat-v">' \+ wpMoney\(cash\.earned\)/.test(portal));
  check("and spent, which is the other half of the balance",
    /wp-cash-stat-v">' \+ wpMoney\(cash\.spent\)/.test(portal));
  check("attendance is still there", /Absent this term/.test(portal));

  // The rule this file has held since 2026-09-08: a figure appears once.
  // Consolidating must not quietly reintroduce the repetition it was fixing.
  check("the balance is NOT also a tile", !/wpTile\('Wildcat Cash'/.test(portal));
  check("nor is Earned", !/wpTile\('Earned'/.test(portal));
}

console.log("\nRecent activity: a balance a child can question");
{
  check("the movements live in that same card, not a fourth one",
    /wp-cash-activity/.test(portal) && !/wpPanel\('Recent activity'/.test(portal));
  check("under a heading that says what they are", /Recent activity<\/p>/.test(portal));
  check("it reads the movements the server already sends", /cash\.recent/.test(portal));
  check("and defends against a non-array", /Array\.isArray\(cash\.recent\)/.test(portal));

  check("each row shows what it was for", /r\.reason/.test(portal));
  check("who gave it", /r\.by/.test(portal));
  check("when", /wpWhen\(r\.at\)/.test(portal));
  // behaviourName is what the adult picked; notes is what they typed. They say
  // different things, so both are shown when both exist.
  check("and the note the adult typed, separately", /r\.note/.test(portal));

  check("an award and a deduction are signed differently",
    /r\.amount < 0 \? '\\u2212' : '\+'/.test(portal));
  check("and coloured differently", /wp-amt-' \+ dir/.test(portal));
  check("green for earned, red for taken off",
    /\.wp-rowend\.wp-amt-up\s*\{[^}]*#6FD39A/.test(css) &&
    /\.wp-rowend\.wp-amt-down\s*\{[^}]*#F2938A/.test(css));

  // An unknown amount must never render as 0: that reads as an award of
  // nothing rather than as a missing figure.
  // The window was 120 chars and the real line is indented past that -- a
  // distance-based assertion failing on whitespace, again. Both halves are
  // checked instead: the guard, and the dash it falls through to.
  check("an unknown amount renders as a dash, not a zero",
    /typeof r\.amount === 'number'\)/.test(portal) && /: '\\u2014';/.test(portal));

  check("nothing yet says so kindly, and says what would change it",
    /When a teacher awards you Wildcat Cash, it will show up here/.test(portal));
  check("and the child is told what to do if it looks wrong",
    /Ask a teacher if something/.test(portal));
  check("the list is capped for a phone", /recent\.slice\(0, 8\)/.test(portal));
}

console.log("\nWhat the server sends a child is still an allowlist");
{
  // The portal now RENDERS these, so the allowlist matters more than it did.
  check("teacherName is sent, because 'who gave me this' is the first question",
    /by: t\?\.teacherName/.test(server));
  check("teacherId is NOT",
    !/teacherId: t\?\./.test(server.slice(server.indexOf("recent:"), server.indexOf("recent:") + 900)));
  check("and the row is built field by field, not spread",
    !/\.\.\.t,/.test(server.slice(server.indexOf("recent:"), server.indexOf("recent:") + 900)));
}

console.log("\nA note wraps; a date does not");
{
  // A note is a sentence and truncating it loses the half that explains the
  // number. The sub-line is a date and a name, and fits.
  check("the note wraps", /\.wp-rownote \{[^}]*overflow-wrap: anywhere/.test(css));
  check("the sub-line still truncates", /\.wp-rowsub \{[^}]*text-overflow: ellipsis/.test(css));
}


console.log("\nThe one card is styled for the portal, not the staff app");
{
  const card = css.slice(css.indexOf("/* ---- The one Wildcat Cash card"),
                         css.indexOf("@media (max-width: 460px) {\n    .wp-cash {"));
  check("the card's styles were located", card.length > 400);
  // THE PORTAL IS ITS OWN THEME, and it flips: dark on a phone, light in the
  // wide laptop layout. --wp-fg / --wp-dim are redefined per theme; the staff
  // app's --wc-ink / --wc-gray-text are not, so using them renders the balance
  // as near-black text on the dark portal. Caught by looking at it.
  check("the balance uses the portal's foreground token", /\.wp-cash-balance \{[^}]*--wp-fg/.test(card));
  check("so do the earned and spent figures", /\.wp-cash-stat-v \{[^}]*--wp-fg/.test(card));
  check("and the labels use the portal's dim token", /--wp-dim/.test(card));
  check("no staff-app light-theme token survives in the card",
    !/--wc-ink|--wc-gray-text/.test(card));

  // The divider has to be visible on a dark surface too.
  check("the divider is an alpha white, not a light-theme hairline",
    /border-bottom: 1px solid rgba\(255, 255, 255/.test(card));

  // The balance is the thing they came for; it must dominate.
  check("the balance is the largest figure on the card", /\.wp-cash-balance \{[^}]*font-size: 34px/.test(card));
  check("earned and spent are smaller", /\.wp-cash-stat-v \{[^}]*font-size: 16px/.test(card));

  // THE TILE ROW IS GONE ENTIRELY as of 2026-09-10. Its three figures live on
  // the cards that own them: the balance and Earned on the Wildcat Cash card,
  // Absent this term on Attendance. A lone tile stretched across the top of
  // the page, saying one number a card below already owned, was the last thing
  // left of it.
  check("no tile row is rendered", !/<div class="wp-tiles">/.test(portal));
  check("and the function that drew tiles went with it", !/function wpTile\(/.test(portal));
  // Against `raw`, not `portal`: `portal` is comment-stripped by design, so a
  // comment can never be found in it. Asserting a tombstone against the
  // stripped copy can only ever fail.
  check("a tombstone says where the figures went", /wpTile was removed on 2026-09-10/.test(raw));

  // Absent this term must have LANDED somewhere, not merely been deleted.
  check("Absent this term is now a figure on the Attendance card",
    /wpStat\('Absent this term', att\.daysAbsentTerm\)/.test(portal));
  check("beside the year figure it only means something next to",
    /wpStat\('Absent this term'[\s\S]{0,120}wpStat\('Absent this year'/.test(portal));
  check("and the tardy figure is still there",
    /wpStat\('Tardy this term', att\.daysTardyTerm\)/.test(portal));

  // The Coming Soon card had the same token mistake.
  check("the coming-soon copy also uses the portal's dim token",
    /\.wp-soon \{[^}]*--wp-dim/.test(css));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
