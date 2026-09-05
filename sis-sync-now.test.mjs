// "Sync now", and the missing-work card saying what it is.
//
// The scheduled syncs run at 13:00 and 19:00 UTC. On 2026-09-05 the owner
// flagged two assignments as Missing in PowerSchool, saw nothing on the
// student's card, and reasonably concluded the feature was broken. It was not:
// the sync had not run. A manual run produced both assignments immediately.
//
// Run: npm test

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const strip = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const script = strip(readFileSync(new URL("./script.js", import.meta.url), "utf8"));
const auth = strip(readFileSync(new URL("./wildcat-auth.js", import.meta.url), "utf8"));
const server = readFileSync(new URL("./convex/sisManual.ts", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const views = readFileSync(new URL("./convex/views_app.ts", import.meta.url), "utf8");
const sisAction = readFileSync(new URL("./convex/sisAction.ts", import.meta.url), "utf8");
const sisStats = readFileSync(new URL("./convex/sisStats.ts", import.meta.url), "utf8");

console.log("\nThe guards are server side, where they cannot be clicked past");
{
  check("every entry point requires an admin",
    (server.match(/await requireAdmin\(ctx\)/g) || []).length >= 3);
  check("there is a cooldown", /const COOLDOWN_MS/.test(server));
  check("it is claimed in a MUTATION, because an action cannot write and two callers would both proceed",
    /export const claim = mutation/.test(server));
  check("the action claims before running", 
    /const claimed[\s\S]{0,200}api\.sisManual\.claim[\s\S]{0,200}if \(!claimed\.ok\) return/.test(server));
  check("it runs the SAME action the cron runs, not a second copy",
    /internal\.sisAction\.syncFromPowerSchool/.test(server));
  check("the outcome is recorded either way",
    /finish[\s\S]{0,400}ok: true[\s\S]{0,400}finish[\s\S]{0,300}ok: false/.test(server));
}

console.log("\nThe cron still owns the schedule");
{
  const crons = readFileSync(new URL("./convex/crons.ts", import.meta.url), "utf8");
  check("the two scheduled syncs are untouched",
    /hourUTC: 13/.test(crons) && /hourUTC: 19/.test(crons));
  check("and both still call the same internal action",
    (crons.match(/internal\.sisAction\.syncFromPowerSchool/g) || []).length >= 2);
}

console.log("\nActions have their own transport");
{
  // /api/action, not /api/mutation. Calling an action through the mutation
  // endpoint fails in a way that reads like the function not existing.
  check("convexAction exists", /async function convexAction\(/.test(auth));
  check("it posts to the action endpoint", /convexUrl\}\/api\/action/.test(auth));
  check("and is exported", /convexAction,/.test(auth));
  check("the mutation endpoint is still separate",
    /convexUrl\}\/api\/mutation/.test(auth));
}

console.log("\nThe button reports rather than fires and forgets");
{
  check("the panel is in Settings", /id="sisSyncNowBtn"/.test(html));
  check("it says when the automatic syncs run, so the button is the exception",
    /6:00 AM<\/b> and <b>12:00 PM/.test(html));
  check("the handler exists", /async function runSisSyncNow\(/.test(script));
  const fn = script.slice(script.indexOf("async function runSisSyncNow("),
                          script.indexOf("window.runSisSyncNow"));
  check("it awaits the result", /await auth\.convexAction\('sisManual:runNow'/.test(fn));
  check("a refused start is reported, not swallowed", /!res\.started/.test(fn));
  check("a failed sync names the error", /res\.error/.test(fn));
  check("a successful one reports what arrived, including missing work",
    /missingWorkRows/.test(fn));
  check("and the button is re-enabled whatever happens", /finally \{/.test(fn));
  check("it refuses politely with no session", /Not signed in/.test(fn));
}

console.log("\nA student can tell missing work from a score");
{
  // The modal opened straight into assignment names, due dates and point
  // values, directly beneath the posted grade, with nothing saying "missing".
  // Read top to bottom that is "here is what I scored".
  check("the list is titled", /wp-missing-title/.test(script));
  check("with the count", /' assignment' : ' assignments'/.test(script));
  check("it says a teacher marked them, not the app",
    /Your teacher marked these as not handed in/.test(script));
  check("and, where they are all flagged, that the points are a value not a score",
    /what each is\s*\n?\s*'?\s*\+?\s*'?worth, not a score you were given/.test(script));
  // The intent, not one wording: a bare point value under a posted grade reads
  // as a score. Every branch must attach a word that says which it is.
  check("no row renders a bare point number",
    !/const worth = \(typeof m\.pointsPossible === 'number'\)\s*\?\s*wpEsc/.test(script));
  // TWO branches now, not three. A flagged assignment shows what the work is
  // worth whatever it scored -- the owner's rule 3 -- so partial credit stopped
  // being its own case on 2026-09-05.
  check("both branches label the number they print",
    /worth = 'worth ' \+ wpEsc\(String\(P\)\) \+ ' pts'/.test(script) &&
    /worth = 'scored 0 of ' \+ wpEsc\(String\(P\)\)/.test(script));
  check("the heading is styled and visible", /\.wp-missing-head \{/.test(css));
  check("in the amber used for attention, not the red used for a stop",
    /\.wp-missing-title \{[^}]*--warn/.test(css));

  // The three states must stay distinct.
  check("'no data yet' is still separate from 'nothing missing'",
    /No data yet\./.test(script) && /Nothing missing in this class\./.test(script));
}


console.log("\nA student can see what there is to gain");
{
  // The point of the card, per the owner: "students can see the benefit of
  // submitting an assignment or retaking it". A percentage projection needs the
  // whole gradebook and, for a weighted section, category weights -- neither of
  // which this PowerSchool instance exposes. Points do not need either.
  check("the card totals what is still recoverable",
    /const upFor = items\.reduce/.test(script));
  check("it subtracts what the student already has",
    /m\.pointsPossible - got/.test(script));
  check("and never goes negative", /Math\.max\(0, m\.pointsPossible - got\)/.test(script));
  check("it is phrased as 'up to', because a teacher sets the mark",
    /Up to <b>' \+ upFor \+/.test(script) && /points<\/b> back in this class/.test(script));
  check("and is hidden when there is nothing to gain", /upFor > 0/.test(script));

  // 634 of 1,054 flagged items at this school are scored zero. Collapsing that
  // into "not handed in" would mislabel most of them.
  check("a zero reads as a zero, not as nothing handed in",
    /worth = 'scored 0 of '/.test(script));
  // Rule 3: flagged and NOT zero reads the same as flagged and zero. So a
  // partially credited flagged assignment shows what it is worth, like every
  // other flagged row, rather than its own third wording.
  check("a flagged row never shows a partial score instead of its value",
    !/wpEsc\(String\(got\)\) \+ ' of '/.test(script));
  check("and an unscored item still says what it is worth",
    /worth = 'worth ' \+ wpEsc\(String\(P\)\)/.test(script));
  // THE FLAG DECIDES, NOT THE SCORE. Set by the owner 2026-09-05: a flagged
  // assignment means the work is not in, whatever it scored -- and 634 of 1,054
  // flagged items carry a zero, so scoring cannot be the signal.
  check("a flagged row asks whether it can still be handed in",
    /flagged\s*\?\s*' &middot; <b>ask if you can still turn it in<\/b>'/.test(script));
  check("and only an UNFLAGGED row asks about a retake",
    /:\s*' &middot; <b>ask about a retake<\/b>'/.test(script));
  check("the flag is what is tested, not the score",
    /const flagged = m\.isMissing !== false;/.test(script));
  check("a flagged row shows what the work is worth, not the zero it carries",
    /if \(P !== null && flagged\) \{\s*\n\s*worth = 'worth '/.test(script));
  check("an unflagged zero shows the zero, which is the fact it turns on",
    /worth = 'scored 0 of '/.test(script));

  // null and 0 are different answers all the way down.
  check("the server sends the score through", /scorePoints: m\.scorePoints \?\? null/.test(views));
  check("with ?? so a genuine zero survives", !/scorePoints: m\.scorePoints \|\|/.test(views));
  check("the sync stores it", /scorePoints: n\(m\.score_points\)/.test(sisAction));
  check("and the mutation validator accepts it, or the whole sync fails",
    /scorePoints: v\.optional\(v\.number\(\)\)/.test(sisStats));
  check("the gain line is styled", /\.wp-missing-gain \{/.test(css));
}


console.log("\nThe button is reachable from the mode people are actually in");
{
  // body.cash-mode hides #settingsTab -- the Settings BUTTON -- and Cash is the
  // launch mode for everybody. The panel was reachable only by pressing "Cash
  // Settings" and then finding an Integrations subtab: two hops through a
  // button named after something else, for a control an admin needs the moment
  // a teacher says "I just flagged it".
  check("Cash mode hides the Settings tab button, which is why this is needed",
    /body\.cash-mode #settingsTab/.test(css));
  check("the Cash nav carries its own entry", /id="cashSyncTabBtn"/.test(script));
  check("it is admin-only, like Cash Settings beside it",
    /cashSyncTabBtn" onclick="openSisSyncPanel\(\)/.test(script) &&
    /class="tab admin-only" id="cashSyncTabBtn"/.test(script));
  check("it opens the Integrations panel directly, not Cash Settings",
    /function openSisSyncPanel[\s\S]{0,400}switchSettingsSubtab\('integrations'\)/.test(script));
  check("and scrolls the button into view rather than leaving it below the fold",
    /function openSisSyncPanel[\s\S]{0,600}scrollIntoView/.test(script));
  check("it is torn down with the other cash tabs when the mode changes",
    /'cashSyncTabBtn'/.test(script) &&
    /removeCashTabButtons[\s\S]{0,400}cashSyncTabBtn/.test(script));
}


console.log("\nThe heading never contradicts the rows");
{
  // It said "Missing work" over every row while a row said "ask about a
  // retake". A retake is not missing work, and that contradiction is what the
  // owner reported as confusing for students.
  check("it counts the two kinds separately", /const nMissing = items\.filter/.test(script));
  check("all flagged reads as missing work", /'Missing work &middot; ' \+ nMissing/.test(script));
  check("all zeros reads as scored zero", /'Scored zero &middot; ' \+ nZero/.test(script));
  check("and a mix names both", /' missing &middot; ' \+\s*\n?\s*nZero \+ ' scored zero'/.test(script));
  check("the explanation follows the same three cases",
    /const headNote = \(nZero === 0\)/.test(script));
  check("it never claims a graded zero was 'not handed in'",
    /These were graded and scored zero/.test(script));
  check("missing rows sort above zeros, so each ask is in one place",
    /const am = \(a\.isMissing !== false\) \? 0 : 1;/.test(script));
}

console.log("\nThe flag survives the whole path, and an old row defaults to missing");
{
  const plugin = readFileSync(new URL("./powerschool/plugin/queries_root/wildcathub.named_queries.xml", import.meta.url), "utf8");
  check("the query returns the flag", /<column column="ASSIGNMENTSCORE.ISMISSING">is_missing<\/column>/.test(plugin));
  check("and now also returns unflagged zeros", /OR SCORE\.SCOREPOINTS = 0/.test(plugin));
  check("a NULL score is still excluded, because ungraded is not zero",
    /NULL = 0 is NULL in Oracle/.test(plugin));
  check("counted work only, so the list cannot include practice work",
    /ISCOUNTEDINFINALGRADE = 1/.test(plugin));

  check("the sync maps it, with the string trap handled",
    /isMissing: m\.is_missing === undefined \? true : String\(m\.is_missing\) === "1"/.test(sisAction));
  check("the mutation validator accepts it, or the whole sync fails",
    /isMissing: v\.optional\(v\.boolean\(\)\)/.test(sisStats));
  check("the server sends it on, defaulting absent to missing",
    /isMissing: m\.isMissing !== false/.test(views));

  // Rows written by 1.3.x have no such column, and that query returned only
  // flagged work -- so absent must read as TRUE. Reading it as false would tell
  // every child with old data that their work was graded zero.
  check("absent means missing everywhere it is read, never false",
    !/isMissing: m\.isMissing === true/.test(views) &&
    !/m\.isMissing === true/.test(script));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
