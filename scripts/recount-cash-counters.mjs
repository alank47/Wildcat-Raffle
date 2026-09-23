/**
 * Put every student's four cash counters back in agreement with their own
 * transaction history.
 *
 * WHAT WENT WRONG. `recordCashTransaction` only ever MOVES a counter, and the
 * one function that derives a counter from history has a single caller inside
 * the test-data seeder. So no real student's counters have ever been
 * recomputed, and a counter that drifts stays drifted. Measured on production
 * 2026-09-17: of 509 students with cash history, 220 held a stored balance
 * that disagreed with their rows -- 219 of them BELOW, $48,000 between them,
 * and 26 reading $0 while holding awards. convex/studentStore.ts shows a child
 * that stored number and the Buy button compares a price against it.
 *
 * WHY THIS IS SAFE TO RUN.
 *   - DRY RUN BY DEFAULT. It prints what it would do and writes nothing.
 *   - IDEMPOTENT. It writes a value derived from history, so a second run
 *     finds nothing to change. There is no double-credit to fear.
 *   - TWO WITNESSES. Every student's counters are derived twice, from the
 *     weekly ledger and from the student record's own history cache, and a
 *     student whose two histories disagree is held back, never patched.
 *   - IT WILL NOT REDUCE A BALANCE unless asked in so many words. A repair
 *     that can only pay a child what the ledger says they earned needs no
 *     decision about any individual.
 *   - BOUNDED BY THE HISTORY CUTOFF. It refuses to read a cash week that
 *     starts before the cutoff, because summing pre-reset rows would
 *     re-credit money the school deliberately wiped.
 *
 * WHAT IT DOES NOT DO. It does not create, edit or delete a single
 * transaction. The ledger is the input and is never written. If a counter is
 * wrong because a movement is MISSING from the ledger, this cannot fix that --
 * that is the other list, and it needs the movement restored first.
 *
 * Usage:
 *     CONVEX_DEPLOY_KEY=... node scripts/recount-cash-counters.mjs --prod
 *         # dry run: measure and print, touch nothing
 *
 *     CONVEX_DEPLOY_KEY=... node scripts/recount-cash-counters.mjs --prod --apply
 *         # write the counters, and log one audit entry for the run
 *
 *   --only <id>            just this student (repeatable). Use it first.
 *   --include-decreases    also apply where a balance would go DOWN
 *   --report <path>        write the full per-student detail as JSON
 *   --batch <n>            students per call (default 25)
 *   --max-change <n>       per-counter blast radius (default 50000)
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const all = (f) => argv.reduce((a, x, i) => (x === f ? a.concat([argv[i + 1]]) : a), []);

const PROD = has("--prod");
const APPLY = has("--apply");
const INCLUDE_DECREASES = has("--include-decreases");
const ONLY = all("--only").filter(Boolean);
const BATCH = Math.max(1, Number(val("--batch", 25)) || 25);
const MAX_CHANGE = Number(val("--max-change", 50000)) || 50000;
const REPORT = val("--report", null);

// A deploy key is one way in; an interactively logged-in `npx convex` is the
// other, and it is what a laptop normally has. Saying which is being used
// beats refusing to run for a machine that is already authenticated.
if (!process.env.CONVEX_DEPLOY_KEY) {
  console.log("no CONVEX_DEPLOY_KEY -- using the logged-in `npx convex` session");
}

function run(fn, args) {
  const a = ["convex", "run", fn, JSON.stringify(args ?? {})];
  if (PROD) a.push("--prod");
  const out = execFileSync("npx", a, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/** The ISO-week key, matching cashReversalRules.cashWeekKey. */
function weekKey(ms) {
  const d = new Date(ms);
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = u.getUTCDay() || 7;
  u.setUTCDate(u.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(u.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((u.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${u.getUTCFullYear()}_W${String(week).padStart(2, "0")}`;
}

const money = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US");
const line = (c) => c.repeat(66);

/**
 * WHICH DEPLOYMENT IS THIS ACTUALLY TALKING TO?
 *
 * The label used to read "dev" whenever --prod was absent, which is a guess
 * about the caller's setup rather than a fact. This repo's .env.local holds
 * CONVEX_DEPLOYMENT=prod:quick-cassowary-644, so a bare `npx convex run` here
 * hits PRODUCTION and the script announced "dev" while doing it. Somebody
 * reading that line before typing --apply would have been told the opposite
 * of the truth about 577 real children's balances.
 *
 * So it is read rather than inferred, and an unreadable answer says so
 * instead of picking the reassuring one.
 */
function deploymentLabel() {
  if (PROD) return "PRODUCTION (--prod)";
  const env = String(process.env.CONVEX_DEPLOYMENT ?? "");
  let configured = env;
  if (!configured) {
    try {
      const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
      const m = txt.match(/^CONVEX_DEPLOYMENT=(.+)$/m);
      configured = m ? m[1].trim() : "";
    } catch { configured = ""; }
  }
  if (!configured) return "UNKNOWN deployment -- check .env.local before applying";
  return configured.startsWith("prod:")
    ? `PRODUCTION (${configured})`
    : `${configured}`;
}

console.log(`\nCash counter recount  ${deploymentLabel()}  ${APPLY ? "APPLY" : "DRY RUN"}`);
console.log(line("="));

// ---- 1. the cutoff bounds which weeks may be read ------------------------
const cut = run("legacyPurge:historyCutoff");
const cutoffIso = cut && cut.value ? cut.value.iso : null;
const cutoffMs = cutoffIso ? Date.parse(cutoffIso) : NaN;
if (!Number.isFinite(cutoffMs)) {
  console.error(
    "\nNo history cutoff is set, so this script cannot tell a post-reset cash\n" +
    "week from a pre-reset one. Summing a pre-reset week would re-credit money\n" +
    "the school deliberately wiped. Refusing to run.\n");
  process.exit(1);
}
console.log(`history cutoff      : ${cutoffIso}`);

// ---- 2. read the weeks, a page at a time ---------------------------------
const WEEK_MS = 7 * 86400000;
const weeks = [];
for (let t = cutoffMs; t <= Date.now() + WEEK_MS; t += WEEK_MS) {
  const k = weekKey(t);
  if (!weeks.includes(k)) weeks.push(k);
}

const rows = [];
let unreadable = 0;
const perWeek = [];
for (const w of weeks) {
  const doc = `cash_tx_${w}`;
  let cursor = null, isDone = false, n = 0;
  while (!isDone) {
    const page = run("cashRecount:ledgerPage", { doc, cursor, numItems: 500 });
    page.rows.forEach((r) => rows.push(r));
    unreadable += page.unreadable || 0;
    n += page.rows.length;
    cursor = page.cursor; isDone = page.isDone;
  }
  perWeek.push([doc, n]);
}
console.log(`cash weeks read     : ${perWeek.filter((w) => w[1]).map((w) => `${w[0]} (${w[1]})`).join(", ") || "none"}`);
console.log(`ledger rows         : ${rows.length}${unreadable ? `  (${unreadable} unreadable, EXCLUDED)` : ""}`);
if (!rows.length) { console.log("\nNothing to do: no cash rows in range.\n"); process.exit(0); }

// ---- 3. the reversal deltas, whole ---------------------------------------
const rev = run("cashRecount:reversalDeltas", {});
if (rev.capped) {
  console.error("\nThe reversal list came back capped, so some reversals would be bucketed\n" +
                "by sign and inflate `deducted`. Refusing to run.\n");
  process.exit(1);
}
console.log(`reversals           : ${rev.count}`);

// ---- 4. group by student -------------------------------------------------
const byStudent = new Map();
for (const r of rows) {
  const id = String(r.studentId || "");
  if (!id) continue;
  if (ONLY.length && !ONLY.includes(id)) continue;
  if (!byStudent.has(id)) byStudent.set(id, []);
  byStudent.get(id).push(r);
}
const students = [...byStudent.entries()].map(([studentId, rs]) => ({ studentId, rows: rs }));
console.log(`students with cash  : ${students.length}${ONLY.length ? `  (narrowed to --only ${ONLY.join(", ")})` : ""}`);
console.log(line("-"));

// ---- 5. recount, a slice at a time --------------------------------------
const details = [];
let repaired = 0, heldBack = 0, alreadyCorrect = 0, notFound = 0, balanceMoved = 0;
for (let i = 0; i < students.length; i += BATCH) {
  const slice = students.slice(i, i + BATCH);
  const res = run("cashRecount:recountStudents", {
    students: slice,
    reversalDeltas: rev.byTxnId,
    apply: APPLY,
    includeDecreases: INCLUDE_DECREASES,
    maxChange: MAX_CHANGE,
  });
  repaired += res.repaired; heldBack += res.heldBack;
  alreadyCorrect += res.alreadyCorrect; notFound += res.notFound;
  balanceMoved += res.balanceMoved;
  res.details.forEach((d) => details.push(d));
  process.stdout.write(`\r  ${Math.min(i + BATCH, students.length)}/${students.length} students…`);
}
process.stdout.write("\r" + " ".repeat(40) + "\r");

// ---- 6. what happened ---------------------------------------------------
const changed = details.filter((d) => d.action === "repaired" || d.action === "would repair");
const held = details.filter((d) => d.action === "held back");
const missing = details.filter((d) => d.action === "not found");

console.log(`already correct     : ${alreadyCorrect}`);
console.log(`${APPLY ? "repaired" : "would repair"}${" ".repeat(APPLY ? 12 : 9)}: ${repaired}`);
console.log(`held back           : ${heldBack}`);
console.log(`no student record   : ${notFound}`);
console.log(`net balance change  : ${money(balanceMoved)}`);

const excluded = details.flatMap((d) => (d.excluded || []).map((x) => [d.name, x]));
if (excluded.length) {
  console.log(`\nrows EXCLUDED from the derivation (${excluded.length}) -- a human should look:`);
  excluded.forEach(([name, x]) => console.log(`  ${String(name).padEnd(30)} ${money(Number(x.amount) || 0).padStart(9)}  ${x.why}`));
}

if (held.length) {
  console.log(`\nHELD BACK (${held.length}) -- nothing was written for these:`);
  held.forEach((d) => {
    console.log(`  ${String(d.name || d.studentId).padEnd(30)} ${d.why}`);
    (d.changes || []).forEach((c) => console.log(`      ${c.field.padEnd(20)} ${c.was} -> ${c.now}`));
  });
}

if (missing.length) {
  console.log(`\nNO STUDENT RECORD (${missing.length}):`);
  missing.forEach((d) => console.log(`  ledger id ${d.studentId}`));
}

if (changed.length) {
  const top = changed
    .map((d) => [d, (d.changes.find((c) => c.field === "wildcatCashBalance") || { delta: 0 }).delta])
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  console.log(`\nlargest 20 of ${changed.length} corrections:`);
  top.slice(0, 20).forEach(([d, delta]) => {
    const b = d.changes.find((c) => c.field === "wildcatCashBalance");
    console.log(`  ${(delta >= 0 ? "+" : "") + money(delta).padEnd(9)} ${String(d.name).padEnd(32)}` +
      (b ? ` balance ${b.was} -> ${b.now}` : " (counters only, balance unchanged)"));
  });
}

if (REPORT) {
  writeFileSync(REPORT, JSON.stringify({
    at: new Date().toISOString(), prod: PROD, applied: APPLY,
    includeDecreases: INCLUDE_DECREASES, cutoff: cutoffIso,
    weeks: perWeek, ledgerRows: rows.length,
    totals: { repaired, heldBack, alreadyCorrect, notFound, balanceMoved },
    details,
  }, null, 2));
  console.log(`\nfull detail written to ${REPORT}`);
  console.log("  (it names students -- keep it out of the repo)");
}

// ---- 7. one audit entry for the run, so the edit is not invisible -------
if (APPLY && repaired > 0) {
  const stamp = new Date().toISOString();
  const entryId = `a_recount_${stamp.replace(/[^0-9]/g, "")}`;
  const res = run("auditLog:importEntries", {
    entries: [{
      entryId, timestamp: stamp,
      payload: {
        action: "cash_recount",
        entryId, timestamp: stamp,
        studentId: "all", studentName: "",
        category: "Wildcat Cash",
        teacher: "System (counter recount)", teacherId: "", teacherName: "System (counter recount)",
        details: `Recounted ${repaired} student cash counter set${repaired === 1 ? "" : "s"} from ` +
                 `transaction history. Net balance change ${money(balanceMoved)}. ` +
                 `${heldBack} held back.`,
        reason: "Stored counters disagreed with the transaction ledger",
      },
    }],
  });
  console.log(`\naudit entry: ${res.inserted ? "written" : "already present"}  (${entryId})`);
}

console.log(`\n${APPLY ? "Done." : "DRY RUN -- nothing was written. Add --apply to write."}\n`);
