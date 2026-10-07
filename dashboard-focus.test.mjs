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
  // 2026-10-06: the week's rows come from cashGaugeWeekRows, which Cash
  // Analytics' "This week so far" strip shares, so the strip can say it is this
  // gauge's number. Run here, not just matched: the whole school when the
  // person sees all, otherwise only their own rows.
  const at = code.indexOf("        function cashGaugeWeekRows(");
  const gaugeRows = new Function(code.slice(at, code.indexOf("\n        }\n", at) + 10) + "\nreturn cashGaugeWeekRows;")();
  const now = new Date().toISOString();
  const rows = [{ teacherId: "t1", timestamp: now }, { teacherId: "t2", timestamp: now }, { teacherId: "", timestamp: now },
                { addedBy: "t1", timestamp: now }, { teacherId: "t1", timestamp: "2020-01-01T00:00:00Z" }];
  const weekStart = Date.now() - 86400000;
  // The actor the gauge passes, RUN (review, 2026-10-06): null means the
  // whole school, so a signed-in person with no id must come out as '' --
  // nobody's rows, as the old inline filter gave -- never null.
  const actorSrc = (/cashGaugeWeekRows\(cashTransactions, weekStart, null,\s*(seesAll \? null : [^;]*?)\);/.exec(code) || [])[1] || "undefined";
  const actorFor = (src, seesAll, currentUser) => new Function("seesAll", "currentUser", "return " + src + ";")(seesAll, currentUser);
  check("a teacher without an id gets nobody's rows, not the whole school",
    gaugeRows(rows, weekStart, null, actorFor(actorSrc, false, { id: null, role: "teacher" })).length === 0 &&
    gaugeRows(rows, weekStart, null, actorFor(actorSrc, false, null)).length === 0 &&
    gaugeRows(rows, weekStart, null, actorFor(actorSrc, false, { id: "t1", role: "teacher" })).length === 2 &&
    gaugeRows(rows, weekStart, null, actorFor(actorSrc, true, { id: "a1", role: "admin" })).length === 4, actorSrc);
  check("TEETH: the earlier `currentUser ? currentUser.id : ''` hands a teacher with no id the whole school",
    gaugeRows(rows, weekStart, null, actorFor("seesAll ? null : (currentUser ? currentUser.id : '')", false, { id: null })).length === 4);
  check("cash is filtered by actor unless they see all",
    /cashGaugeWeekRows\(cashTransactions, weekStart, null,\s*seesAll \? null : \(\(currentUser && currentUser\.id\) \|\| ''\)\)/.test(code) &&
    gaugeRows(rows, weekStart, null, null).length === 4 && gaugeRows(rows, weekStart, null, "t1").length === 2 &&
    gaugeRows(rows, weekStart, null, "t2").length === 1);
  check("an unattributed movement matches nobody here either",
    gaugeRows(rows, weekStart, null, "").length === 0 && gaugeRows([{ timestamp: now }], weekStart, null, undefined).length === 0);
  check("referrals go through the discipline rules, not a hand-rolled filter",
    /visibleReferrals\(\)\.filter\(r => r && r\.status !== 'closed'\)/.test(code));
  check("and the tile labels change with the scope",
    /seesAll \? 'Cash awarded this week' : 'Cash you awarded this week'/.test(code));
}

console.log("\nThe gauge measures the PBIS ratio");
{
  const g = code.slice(code.indexOf("const gauge = document.getElementById('dashGauge')"),
                       code.indexOf("const days = document.getElementById('dashDays')"));
  check("five positives to one correction is the target",
    /RATIO_TARGET = CASH_RATIO_GOAL/.test(g) && /const CASH_RATIO_GOAL = 5;/.test(code));
  check("it counts positive and corrective movements", /positives/.test(g) && /negatives/.test(g));

  // Nothing awarded is NOT a ratio of zero. 0:1 accuses a teacher of something
  // they have not done.
  // 2026-10-06: the counts behind it are `gaugeCounts` -- a teacher's own week
  // per student, the school's week (admins and PBIS) in clicks, as on Trends.
  check("nothing awarded reads as no measurement, not as a bad ratio",
    /const nothingYet = gaugeCounts\.awards === 0 && gaugeCounts\.deductions === 0;/.test(g) && /nothingYet\s*\?\s*'<span class="wu-absent">no awards yet/.test(g));
  check("and says so in words", /no awards yet/.test(g));
  // 2026-10-01: the shared 5 to 1 rule judges the gauge too, so no
  // deductions (or one to four) is never a full gauge or a perfect score.
  check("no deductions, or too few, are judged by the shared rule, never a full gauge",
    /const verdict = cashRatioVerdict\(gaugeCounts\.awards, gaugeCounts\.deductions\);/.test(g) && /verdict\.ratio === null \? null/.test(g));
  check("the gauge never exceeds full", /Math\.min\(1, verdict\.ratio \/ RATIO_TARGET\)/.test(g));
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
