// Referral Analytics in words: the Closed pane and the Trends pane.
// Run: npm test
//
// MEASURED IN PRODUCTION, 2026-10-07 (counts only): the Closed pane printed
// "action_taken 8 89%" and "no_action 1 11%", the stored codes. Trends printed
// keys like "2026-W40" (not even the ISO week: Oct 5 is ISO W41), counted the
// moment a form was sent rather than the incident, and stopped at the last
// referral, so the quiet weeks since were missing. The "This Week" tile
// counted referrals FILED in the last seven days, which disagreed with an
// incident-week trend on the same screen.
//
// THE SHIPPED CODE RUNS: both renderers are lifted out of script.js and run
// with the real wildcat-discipline.js, "today" pinned to 6:30pm on Oct 7 in
// Los Angeles (UTC is already the 8th). Every "TEETH" check breaks the code on
// purpose and shows the assertion catches it.

process.env.TZ = "America/Los_Angeles";

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const discSrc = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");
const D = (() => { const sb = {}; new Function("globalThis", discSrc).call(sb, sb); return sb.WildcatDiscipline; })();

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

function liftFn(src, name) {
  const m = new RegExp("\\n        (?:async )?function " + name + "\\(").exec(src);
  if (!m) throw new Error("missing function " + name);
  const start = m.index + 1;
  const end = src.indexOf("\n        }\n", start);
  if (end < 0) throw new Error("unterminated function " + name);
  return src.slice(start, end + 10);
}
function breakOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`teeth "${label}": anchor not found exactly once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}

const NOW = Date.parse("2026-10-07T18:30:00-07:00");
const WD = Object.assign({}, D, { schoolToday: (now) => D.schoolToday(now == null ? NOW : now) });

/** Run one renderer; returns the HTML it drew. */
function render(src, fn, elId, rows, grain = "week") {
  const el = { innerHTML: "" };
  const document = { getElementById: (id) => (id === elId ? el : null) };
  const body = `
    let trendGrain = G.grain;
    ${liftFn(src, "escapeHtml")}
    ${liftFn(src, fn)}
    ${fn}(G.rows);
  `;
  new Function("G", "document", "window", body)({ rows, grain }, document, { WildcatDiscipline: WD });
  return el.innerHTML;
}

const N = "Notified parents/guardians promptly";
const C = "Scheduled a mandatory Parent-Conference";
const ref = (over) => Object.assign({
  id: "R", studentId: "S1", status: "open", date: "2026-09-15", time: "09:00",
  submittedAt: "2026-09-15T17:00:00.000Z", closingActions: [], resolutionType: "",
}, over);

// Nine closed, shaped like production: eight with action taken, seven of
// those with the parent notified, one with a conference instead; one closed
// with no action required. Plus two open.
const CLOSED = [];
for (let i = 0; i < 7; i++) {
  CLOSED.push(ref({ id: `A${i}`, status: "closed", resolutionType: "action_taken", closingActions: [N],
    closedAt: "2026-09-17T17:00:00.000Z" }));
}
CLOSED.push(ref({ id: "A7", status: "closed", resolutionType: "action_taken", closingActions: [N, C],
  closedAt: "2026-09-18T17:00:00.000Z" }));
CLOSED.push(ref({ id: "B0", status: "closed", resolutionType: "no_action", closingActions: [],
  closedAt: "2026-09-16T17:00:00.000Z" }));
const ALL = CLOSED.concat([ref({ id: "O1" }), ref({ id: "O2", date: "2026-09-30" })]);

console.log("\n-- the Closed pane is in words --");
{
  const out = render(script, "renderClosedAnalytics", "referralClosedAnalytics", ALL);
  check("no stored code is printed", !/action_taken|no_action/.test(out));
  check("'Action taken' with its count and share", /Action taken<\/td><td><strong>8<\/strong><\/td>\s*<td>89%/.test(out));
  check("'No action required' with its count", /No action required<\/td><td><strong>1<\/strong>/.test(out));
  check("closing actions are listed as what closers did", /Notified parents\/guardians promptly<\/td><td><strong>8<\/strong><\/td>\s*<td>8 of 9<\/td>/.test(out));
  check("including the parent conference", /Scheduled a mandatory Parent-Conference<\/td><td><strong>1<\/strong>/.test(out));
  check("a closed referral with no code reads 'Not recorded'",
    /Not recorded/.test(render(script, "renderClosedAnalytics", "referralClosedAnalytics", [ref({ status: "closed" })])));
  check("and an action list that is empty says so",
    /No closing actions were recorded/.test(render(script, "renderClosedAnalytics", "referralClosedAnalytics", [ref({ status: "closed" })])));
}

console.log("\n-- Trends: real labels, by incident, to this week --");
{
  const out = render(script, "renderReferralTrend", "referralTrend", ALL);
  check("weeks read 'Week of <Monday>'", /Week of Sep 14/.test(out) && /Week of Oct 5/.test(out));
  check("no raw '-W' key", !/\d{4}-W\d/.test(out));
  check("no raw ISO key either", !/>\s*2026-\d\d-\d\d/.test(out));
  check("it runs to the current Los Angeles week, which is marked in progress",
    /Week of Oct 5 <span class="panel-hint">\(so far\)<\/span>/.test(out));
  check("quiet weeks before it are drawn as quiet",
    /<tr class="trend-quiet">\s*<td>Week of Sep 21<\/td>/.test(out));
  check("the current week is not styled as quiet",
    !/<tr class="trend-quiet">\s*<td>Week of Oct 5/.test(out));
  check("the pane says what it counts", /Counted by the day of the incident, not the day the referral was filed/.test(out));

  const months = render(script, "renderReferralTrend", "referralTrend", ALL, "month");
  check("months read in words", /September 2026/.test(months) && /October 2026/.test(months) && />Month</.test(months));

  const future = render(script, "renderReferralTrend", "referralTrend", ALL.concat([ref({ id: "F", date: "2026-12-01" })]));
  check("an incident dated after today is said, not drawn",
    /Not shown: 1 referral has an incident date after today/.test(future) && !/Week of Nov 30/.test(future));

  const fn = liftFn(script, "renderReferralTrend");
  check("the renderer passes the school's today", /trend\(all, trendGrain, window\.WildcatDiscipline\.schoolToday\(\)\)/.test(fn));
}

console.log("\n-- the tile says what it counts --");
{
  const m = /<div class="stat-label">([^<]*)<\/div>\s*<div class="stat-num" id="analyticsThisWeek">/.exec(html);
  check("'Filed in the last 7 days', not 'This Week'", m && m[1] === "Filed in the last 7 days", m && m[1]);
  check("the analytics tab selector cash-nav pins is untouched",
    /querySelectorAll\('\.analytics-tabs \.analytics-tab'\)/.test(liftFn(script, "switchAnalyticsTab")));
}

console.log("\n-- TEETH --");
{
  const raw = breakOnce(script, "const res = D.resolutionLabel(r.resolutionType);",
    "const res = String(r.resolutionType || '').trim() || 'Not recorded';", "resolution words");
  check("TEETH: grouping on the stored code prints action_taken again",
    /action_taken/.test(render(raw, "renderClosedAnalytics", "referralClosedAnalytics", ALL)));

  const key = breakOnce(script, "<td>${escapeHtml(p.label)}${p.current", "<td>${escapeHtml(p.key)}${p.current", "label");
  check("TEETH: printing the key instead of the label loses 'Week of'",
    !/Week of/.test(render(key, "renderReferralTrend", "referralTrend", ALL)));

  const noToday = breakOnce(script, "trend(all, trendGrain, window.WildcatDiscipline.schoolToday())",
    "trend(all, trendGrain)", "today");
  check("TEETH: without today the chart stops at the last referral",
    !/Week of Oct 5/.test(render(noToday, "renderReferralTrend", "referralTrend", ALL)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
