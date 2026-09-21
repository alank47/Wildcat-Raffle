#!/usr/bin/env node
// WHERE THE TIER BOUNDARIES COME FROM.
//
// The combined early warning indicator scores every student across attendance,
// behaviour and course performance, and the whole thing turns on where "Act
// now" starts. That number cannot be chosen by taste: a flat chronic-absence
// line put 54% of this school on one list, a flat failing-a-class line put 66%
// on another, and the second feature was dropped for it.
//
// So this pages the real per-student counts out of production, lifts the REAL
// riskRanking out of wildcat-discipline.js -- not a copy -- and prints the
// score histogram over the whole school, with the tier sizes every candidate
// boundary would produce. Run it when the school's shape moves, which it does
// every morning: every absence rate is measured against school days elapsed.
//
//   node scripts/calibrate-early-warning.mjs [--today YYYY-MM-DD] [--recent 14]
//                                            [--first-day 2026-08-12] [--off 0]
//
// It reads production and writes nothing. Student numbers stay in memory and
// are never printed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const today = arg("today", new Date().toISOString().slice(0, 10));
const recentDays = Number(arg("recent", "14"));
const firstDay = arg("first-day", "2026-08-12");
const offDays = Number(arg("off", "0"));

// The real module, loaded as the browser loads it.
const g = globalThis;
new Function(readFileSync(resolve(REPO, "wildcat-discipline.js"), "utf8")).call(g);
new Function(readFileSync(resolve(REPO, "wildcat-roster.js"), "utf8")).call(g);
const D = g.WildcatDiscipline;
const R = g.WildcatRoster;
if (!D || typeof D.riskRanking !== "function") throw new Error("riskRanking did not load");
if (!R || typeof R.schoolDaysElapsed !== "function") throw new Error("schoolDaysElapsed did not load");

// The same denominator the screen uses: weekdays since the first day, less the
// typed-in non-school days. Holidays are not subtracted automatically, and the
// direction of that error is deliberate -- too large a denominator makes every
// rate too small, so the list under-flags rather than over-flags.
const weekdays = R.schoolDaysElapsed(firstDay, new Date(today + "T12:00:00"));
const schoolDays = Math.max(0, weekdays - offDays);

const rows = [];
let after = "";
for (let page = 0; page < 20; page++) {
  const args = JSON.stringify({ today, recentDays, pageSize: 200, ...(after ? { after } : {}) });
  const out = execFileSync("npx", ["convex", "run", "--prod", "earlyWarningProfile:calibrationRows", args],
    { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  const res = JSON.parse(out);
  rows.push(...res.rows);
  if (res.done) break;
  after = res.last;
}

const pct = (n) => `${((100 * n) / rows.length).toFixed(1)}%`;
console.log(`\nstudents on file: ${rows.length}`);
console.log(`school days: ${schoolDays} (${weekdays} weekdays since ${firstDay}, less ${offDays} non-school)`);
console.log(`recency window: ${recentDays} days back from ${today}`);

// BEHAVIOUR IS DARK, and the calibration must be honest that it is: passing a
// fabricated "covered" here would set the boundaries against a school that
// does not exist.
const coverage = { status: "unknown" };

const base = D.riskRanking(rows, schoolDays, coverage, {});
console.log(`\nbehaviour axis: ${base.behaviourKnown ? "covered" : "UNKNOWN -- scores 0 for everyone"}`);
console.log(`unrankable (no readable axis): ${base.noData.length}`);

const hist = new Map();
base.ranked.forEach((r) => hist.set(r.points, (hist.get(r.points) || 0) + 1));
console.log("\nSCORE HISTOGRAM (max possible 8: attendance 4, behaviour 0, course 4)");
let cum = 0;
[...hist.keys()].sort((a, b) => b - a).forEach((k) => {
  cum += hist.get(k);
  console.log(`  ${String(k).padStart(2)} pts  ${String(hist.get(k)).padStart(4)}  ${pct(hist.get(k)).padStart(6)}   at or above: ${String(cum).padStart(4)} (${pct(cum)})`);
});

console.log("\nWHAT EACH CANDIDATE 'Act now' BOUNDARY WOULD NAME");
for (let actAt = 8; actAt >= 2; actAt--) {
  const n = base.ranked.filter((r) => r.points >= actAt).length;
  const flag = n >= 25 && n <= 45 ? "   <-- a queue a team can work" : "";
  console.log(`  actAt ${actAt}: ${String(n).padStart(4)} students (${pct(n).padStart(6)})${flag}`);
}

console.log("\nTIER SIZES UNDER THE SHIPPED DEFAULTS");
const shipped = D.riskRanking(rows, schoolDays, coverage, {});
const s = shipped.settings;
console.log(`  settings: actAt ${s.actAt}, watchAt ${s.watchAt}, recentDays ${s.recentDays}`);
Object.entries(shipped.counts).forEach(([k, v]) => console.log(`  ${k.padEnd(6)} ${String(v).padStart(4)}  ${pct(v)}`));

// A tier boundary is only meaningful if the children in it are there for
// different reasons. A top tier that is 100% "absent a lot" is an attendance
// list wearing a combined label.
const act = shipped.ranked.filter((r) => r.tier && r.tier.key === "act");
const both = act.filter((r) => r.attendance.points > 0 && r.course.points > 0).length;
console.log(`\nIS THE TOP TIER ACTUALLY COMBINED?`);
console.log(`  of ${act.length} in "Act now": ${both} are flagged on BOTH available axes` +
            `, ${act.length - both} on one only`);
const improving = shipped.ranked.filter((r) => (r.course.missingOlder || 0) >= 3 && (r.course.missingRecent || 0) === 0).length;
console.log(`  students owing 3+ older assignments and nothing recent (improving): ${improving}`);
