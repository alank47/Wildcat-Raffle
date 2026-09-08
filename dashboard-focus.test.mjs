// The dashboard is about Wildcat Cash and Discipline, not the raffle.
//
// It opened on "Jackpot qualified", "Your tickets this week" and a gauge
// measuring Jackpot qualification rate -- three figures from a system the
// school has not switched on. The dashboard is the first screen a teacher
// sees, and the topbar and sidebar carried the same cycle vocabulary beside
// it.
//
// Run: npm test

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const raw = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const code = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8")
  .replace(/<!--[\s\S]*?-->/g, "");

/** Just the dashboard surface, not the whole page. */
const dash = (() => {
  const start = html.indexOf('<div id="dashboard" class="tab-content">');
  const next = html.indexOf('class="tab-content"', start + 60);
  return html.slice(start, html.lastIndexOf("<div", next));
})();

console.log("\nNo raffle vocabulary on the dashboard");
{
  for (const word of ["Jackpot", "Raffle", "raffle", "Ticket", "ticket", "Cycle", "cycle"]) {
    check(`"${word}" does not appear`, !dash.includes(word));
  }
}

console.log("\nThe tiles count cash and referrals");
{
  const fn = code.slice(code.indexOf("const tiles = document.getElementById('dashTiles')"),
                        code.indexOf("const gauge = document.getElementById('dashGauge')"));
  check("one tile is cash awarded", /Cash you awarded this week|Cash awarded this week/.test(fn));
  check("one is open referrals", /Open referrals|Your open referrals/.test(fn));
  check("the roster tile stays", /Your students/.test(fn));
  check("no tile counts jackpot qualification", !/[Jj]ackpot/.test(fn));

  // A measured zero is a fact; only a missing measurement is absent.
  check("zero cash is shown as $0, not as 'no data'",
    /'\$' \+ cashAwarded\.toLocaleString\(\)/.test(fn));
}

console.log("\nA teacher sees their own practice, an admin sees the school's");
{
  check("the scope is named once and reused",
    /const seesAll = isAdmin \|\| \(currentUser && currentUser\.role === 'pbis'\)/.test(code));
  check("cash is filtered by actor unless they see all",
    /if \(seesAll\) return true;[\s\S]{0,220}actor === currentUser\.id/.test(code));
  check("an unattributed movement matches nobody here either",
    /return actor && currentUser && actor === currentUser\.id/.test(code));
  check("referrals go through the discipline rules, not a hand-rolled filter",
    /visibleReferrals\(\)\.filter\(r => r && r\.status !== 'closed'\)/.test(code));
  check("and the tile labels change with the scope",
    /seesAll \? 'Cash awarded this week' : 'Cash you awarded this week'/.test(code));
}

console.log("\nThe gauge measures the PBIS ratio");
{
  const g = code.slice(code.indexOf("const gauge = document.getElementById('dashGauge')"),
                       code.indexOf("const days = document.getElementById('dashDays')"));
  check("five positives to one correction is the target", /RATIO_TARGET = 5/.test(g));
  check("it counts positive and corrective movements", /positives/.test(g) && /negatives/.test(g));

  // Nothing awarded is NOT a ratio of zero. 0:1 accuses a teacher of something
  // they have not done.
  check("nothing awarded reads as no measurement, not as a bad ratio",
    /\(positives === 0 && negatives === 0\)\s*\n?\s*\? null/.test(g));
  check("and says so in words", /no awards yet/.test(g));
  check("all-positive does not divide by zero",
    /negatives === 0 \? RATIO_TARGET : positives \/ negatives/.test(g));
  check("the gauge never exceeds full", /Math\.min\(1, ratio \/ RATIO_TARGET\)/.test(g));
  check("the sub-rings show the two counts behind it",
    /wcSubring\('Positive'[\s\S]{0,160}wcSubring\('Corrective'/.test(g));
  check("nothing in it mentions jackpot", !/[Jj]ackpot/.test(g));
}

console.log("\nThe day strip below it is untouched");
{
  // A previous edit removed it by slicing past the gauge; undefined-names
  // caught that, and this says it out loud.
  check("the day strip still renders", /Today first, then backwards/.test(raw));
  check("its variables are still declared",
    /const todayIso = wcIsoDay\(new Date\(\)\);/.test(code) &&
    /const selected = wcDashDay \|\| todayIso;/.test(code));
}

console.log("\nCycle vocabulary is gone from the chrome too");
{
  check("the topbar badge markup is removed", !/id="cycleWeekBadge"/.test(html));
  check("but updateCycleBadge survives for when Raffle starts",
    /function updateCycleBadge\(/.test(code));
  check("and it already returned early on a missing element",
    /const badge = document\.getElementById\('cycleWeekBadge'\);\s*\n\s*if \(!badge\) return;/.test(code));

  check("the phone shortcuts open Cash and Discipline",
    /switchSystemMode\('cash'\)[\s\S]{0,200}Award Cash/.test(html) &&
    /switchSystemMode\('discipline'\)[\s\S]{0,200}Submit Referral/.test(html));
  check("and no longer Award Tickets", !/Award Tickets/.test(dash));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
