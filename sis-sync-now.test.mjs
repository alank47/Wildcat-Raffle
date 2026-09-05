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
  check("and that the points are a value, not a score",
    /what each is worth, not a score you were given/.test(script));
  check("each row says 'worth N pts' rather than a bare number",
    /'worth ' \+ wpEsc\(String\(m\.pointsPossible\)\)/.test(script));
  check("the heading is styled and visible", /\.wp-missing-head \{/.test(css));
  check("in the amber used for attention, not the red used for a stop",
    /\.wp-missing-title \{[^}]*--warn/.test(css));

  // The three states must stay distinct.
  check("'no data yet' is still separate from 'nothing missing'",
    /No data yet\./.test(script) && /Nothing missing in this class\./.test(script));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
