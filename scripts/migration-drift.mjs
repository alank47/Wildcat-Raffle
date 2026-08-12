#!/usr/bin/env node
/**
 * Migration drift check: does the Convex mirror still match Firestore?
 *
 * Run it repeatedly during the migration. Firestore is still the system of
 * record and the app keeps writing to it, so the mirror goes stale the moment
 * a teacher awards a ticket. The point is not that drift is zero forever, it is
 * that drift is VISIBLE and explainable before anyone relies on the mirror.
 *
 * Compares counts AND balances. Counts alone would pass while every balance was
 * wrong, which is the failure that matters when 6.6 million in student currency
 * is at stake.
 *
 *   node scripts/migration-drift.mjs            # compare
 *   node scripts/migration-drift.mjs --refresh  # print the refresh command
 *
 * Needs CONVEX_DEPLOY_KEY in the environment:
 *   CONVEX_DEPLOY_KEY=$(op read 'op://Employee/Westbrook WildCats Hub/Convex wildcat-hub-ci Deploy Key') \
 *     node scripts/migration-drift.mjs
 */
import { execFileSync } from "node:child_process";

const FIRESTORE =
  "https://firestore.googleapis.com/v1/projects/wildcat-hub-94025/databases/(default)/documents/raffle_data";

function unwrap(v) {
  if (v === null || v === undefined) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(unwrap);
  if ("mapValue" in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields ?? {})) out[k] = unwrap(val);
    return out;
  }
  return null;
}

async function firestoreDoc(name) {
  const res = await fetch(`${FIRESTORE}/${name}`);
  if (!res.ok) throw new Error(`Firestore ${name}: HTTP ${res.status}`);
  return (await res.json()).fields ?? {};
}

function convexRun(fn, args = "{}") {
  // stderr was discarded here, so any failure surfaced as "Command failed" with
  // `stderr: null` and no way to tell a missing deploy key from a broken
  // function. Convex writes everything useful to stderr, so it is captured and
  // re-thrown.
  try {
    const out = execFileSync("npx", ["convex", "run", fn, args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch (error) {
    const detail = String(error.stderr ?? "").trim() || String(error.message ?? error);
    throw new Error(`convex run ${fn} failed.\n${detail}`);
  }
}

const sum = (rows, f) => rows.reduce((a, r) => a + (Number(f(r)) || 0), 0);

console.log("\nMigration drift check\n" + "=".repeat(62));

// ---- students: counts AND balances -------------------------------------
const main = await firestoreDoc("main");
const srcStudents = unwrap(main.students) ?? [];
const dst = convexRun("migrate:studentTotals");

const checks = [
  ["students", srcStudents.length, dst.count],
  ["pbisTickets", sum(srcStudents, (s) => s.pbisTickets), dst.pbisTickets],
  ["attendanceTickets", sum(srcStudents, (s) => s.attendanceTickets), dst.attendanceTickets],
  ["academicTickets", sum(srcStudents, (s) => s.academicTickets), dst.academicTickets],
  ["wildcatCashBalance", sum(srcStudents, (s) => s.wildcatCashBalance), dst.wildcatCashBalance],
  ["wildcatCashEarned", sum(srcStudents, (s) => s.wildcatCashEarned), dst.wildcatCashEarned],
  ["wildcatCashSpent", sum(srcStudents, (s) => s.wildcatCashSpent), dst.wildcatCashSpent],
  ["cashBalance", sum(srcStudents, (s) => s.cashBalance), dst.cashBalance],
  ["bigRaffleEntries", srcStudents.reduce((a, s) => a + (s.bigRaffleQualified?.length ?? 0), 0), dst.bigRaffleEntries],
];

let drift = 0;
console.log("\nStudents (source of truth: Firestore)\n");
for (const [label, a, b] of checks) {
  const ok = a === b;
  if (!ok) drift++;
  const delta = ok ? "" : `   drift ${b - a > 0 ? "+" : ""}${b - a}`;
  console.log(
    `  ${label.padEnd(22)} ${String(a).padStart(12)} ${String(b).padStart(12)}  ${ok ? "OK" : "DRIFT"}${delta}`,
  );
}

// ---- staff emails, the field that got wiped once ------------------------
const srcTeachers = unwrap(main.teachers) ?? [];
const srcWithEmail = srcTeachers.filter((t) => (t.email ?? "").trim()).length;
console.log("\nStaff\n");
console.log(`  ${"teachers".padEnd(22)} ${String(srcTeachers.length).padStart(12)}`);
const emailOk = srcWithEmail >= 39;
if (!emailOk) drift++;
console.log(
  `  ${"with an email".padEnd(22)} ${String(srcWithEmail).padStart(12)}  ${emailOk ? "OK" : "REGRESSED - a stale tab may have wiped them"}`,
);

console.log("\n" + "=".repeat(62));
if (drift === 0) {
  console.log("NO DRIFT. Mirror matches Firestore.\n");
} else {
  console.log(`${drift} FIGURE(S) DRIFTED.`);
  console.log("Expected while the app is live and writing to Firestore.");
  console.log("Refresh the mirror before relying on it, then re-run this.\n");
}
process.exit(0);
