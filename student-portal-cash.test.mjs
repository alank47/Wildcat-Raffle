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

console.log("\nThe tiles lead with what the student came to see");
{
  check("balance is first", /wpTile\('Wildcat Cash', wpMoney\(cash\.balance\)/.test(portal));
  // A balance falls when they spend. A child who only sees it drop has no
  // record of ever having earned anything.
  check("earned sits beside it, so spending does not read as loss",
    /wpTile\('Earned', wpMoney\(cash\.earned\)/.test(portal));
  check("attendance is still there", /Absent this term/.test(portal));
}

console.log("\nRecent activity: a balance a child can question");
{
  check("the panel exists", /wpPanel\('Recent activity', 'Your Wildcat Cash'/.test(portal));
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

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
