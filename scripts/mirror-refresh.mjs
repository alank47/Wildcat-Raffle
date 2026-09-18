#!/usr/bin/env node
/**
 * Refresh the entire Convex mirror from Firestore, then reconcile.
 *
 * WHY THIS EXISTS INSTEAD OF BROWSER DUAL-WRITE
 * The migration plan called for the app to write to both stores at once. It
 * cannot yet, and not for want of caution: a Convex mutation called from the
 * browser needs a Convex identity, and the app has none until Entra sign-in
 * works. The only way to write from the browser today would be a public
 * mutation with no auth, which is an open write endpoint on the internet, and
 * an open database is the thing this migration exists to close.
 *
 * So the mirror is refreshed server-side instead, with the deploy key, on
 * demand or on a schedule. It achieves the same goal (Convex never far behind
 * Firestore) without opening a hole, and it becomes unnecessary the moment
 * real dual-write is possible.
 *
 *   CONVEX_DEPLOY_KEY=$(op read 'op://Employee/Westbrook WildCats Hub/Convex wildcat-hub-ci Deploy Key') \
 *     node scripts/mirror-refresh.mjs
 *
 * Idempotent. Students upsert on studentNumber; each mirrored slice is
 * replaced rather than appended.
 *
 * ============================================================
 * ITS PREMISE IS GONE, AND IT NOW DESTROYS DATA. REFUSES TO RUN.
 * ============================================================
 * Everything above was written while the app still wrote to Firestore, so
 * Firestore was ahead and Convex was the copy. Both halves of that are now
 * false: `grep -c firestore.googleapis.com script.js` is 0, Convex is the
 * system of record, and the Firestore documents are a stale snapshot from
 * whenever the dual-write stopped.
 *
 * Run today it would not refresh a mirror, it would overwrite production with
 * August:
 *
 *   - `migrate:importStudents` (convex/migrate.ts:76) is a `ctx.db.patch` of a
 *     doc carrying all four cash counters AND `wildcatCashTransactions`
 *     verbatim. It is the ONLY write path that can SET a counter rather than
 *     move it by a delta -- everything appDataShape enforces (delta-only,
 *     MAX_CASH_DELTA, "nothing shrinks a stored history") applies to
 *     `appData:save` and not to this. On 2026-09-17 a repair recomputed 223
 *     students' counters from their history; this would put the old numbers
 *     back, silently, for every student in the Firestore snapshot.
 *
 *   - the slice loop below mirrors `cash_tx_*` weeks, and an empty Firestore
 *     array takes the `rows.length === 0` branch: `putSlice` with `rows: []`
 *     and `replace: true`, which deletes every stored row for that document
 *     and inserts nothing (convex/mirror.ts:19-27). That is the cash LEDGER --
 *     2,065 rows, and the thing every counter is derived from.
 *
 * So the two writes together would undo the repair and then delete the
 * evidence needed to redo it. "Nobody will run it" is not a control on a repo
 * two people work in, with a header that used to say "safe to run as often as
 * you like".
 *
 * If you genuinely need it -- restoring a fresh Convex deployment from the
 * Firestore archive, and nothing else -- pass --overwrite-live-data, and read
 * the ledger count first.
 */
import { execFileSync } from "node:child_process";

const FIRESTORE =
  "https://firestore.googleapis.com/v1/projects/wildcat-hub-94025/databases/(default)/documents/raffle_data";

/**
 * The ISO-week key script.js writes cash ledgers under, and the month/week
 * keys it writes audit documents under. Both are reproduced here EXACTLY,
 * because a mirror that computes a key differently from the app copies a
 * document nobody wrote and misses the one that exists — and it reconciles
 * fine, because both sides are counting zero.
 */
function cashWeekKey(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}_W${String(week).padStart(2, "0")}`;
}

const now = new Date();
const auditKeys = new Set();
// Weekly audit docs, 60 weeks back, same window as getKnownAuditMonthKeys().
for (let i = 0; i < 60; i++) {
  const k = cashWeekKey(new Date(now.getTime() - i * 7 * 86400000).toISOString());
  if (k) auditKeys.add(k);
}
// Legacy MONTHLY audit docs, 14 months back.
for (let i = 0; i < 14; i++) {
  const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
  auditKeys.add(`${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, "0")}`);
}
const cashKeys = new Set();
for (let i = 0; i < 60; i++) {
  const k = cashWeekKey(new Date(now.getTime() - i * 7 * 86400000).toISOString());
  if (k) cashKeys.add(k);
}

// ADDED 2026-08-31, and these were the gap that would have made a Firebase
// cutover lose data silently. ticket_history_unknown is READ by loadData and
// was never mirrored; so were the per-month audit documents and every weekly
// cash ledger. The mirror reconciled on the documents it knew about and said
// nothing about the ones it did not.
const DOCS = [
  "main", "audit", "audit_log", "tombstones", "secondary", "schedules",
  "referrals", "ticket_history", "ticket_history_ms", "ticket_history_hs",
  "ticket_history_hs_910", "ticket_history_hs_1112", "ticket_history_unknown",
  ...[...auditKeys].map((k) => `audit_log_${k}`),
  ...[...cashKeys].map((k) => `cash_tx_${k}`),
];

function unwrap(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(unwrap);
  if ("mapValue" in v) {
    const o = {};
    for (const [k, val] of Object.entries(v.mapValue.fields ?? {})) o[k] = unwrap(val);
    return o;
  }
  return null;
}

function run(fn, args) {
  const out = execFileSync("npx", ["convex", "run", fn, JSON.stringify(args)], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

if (!process.env.CONVEX_DEPLOY_KEY) {
  console.error("CONVEX_DEPLOY_KEY is not set. See the header of this file.");
  process.exit(1);
}

// REFUSES BY DEFAULT. See the header: Convex is the system of record now, so
// this no longer refreshes a mirror -- it overwrites live cash counters from a
// stale Firestore snapshot and can delete the cash ledger outright.
if (!process.argv.includes("--overwrite-live-data")) {
  console.error(`
REFUSING TO RUN. This script's premise is gone.

It was written while the app wrote to Firestore and Convex was the copy.
Convex is now the system of record and the Firestore documents are stale.
Running this would:

  1. overwrite every student's four cash counters and their transaction
     array with the Firestore values, through the one write path that can
     SET a counter instead of moving it by a delta, and
  2. delete whole legacyMirror slices -- including cash_tx_* weekly ledger
     documents -- wherever the Firestore array is empty.

On 2026-09-17 a repair recomputed 223 students' counters from their
transaction history. This would undo that and then delete the history it
was derived from.

If you are restoring a FRESH deployment from the Firestore archive and
nothing else, re-run with --overwrite-live-data.
`);
  process.exit(1);
}

const stamp = new Date().toISOString();
console.log(`\nMirror refresh  ${stamp}\n${"=".repeat(58)}`);

// ---- fetch every document once -----------------------------------------
const docs = {};
for (const name of DOCS) {
  const res = await fetch(`${FIRESTORE}/${name}`);
  if (!res.ok) { console.log(`  skip ${name} (HTTP ${res.status})`); continue; }
  docs[name] = (await res.json()).fields ?? {};
}

// ---- students, with their balances --------------------------------------
const students = (unwrap(docs.main?.students) ?? []).map((s) => {
  const r = {
    studentNumber: String(s.id ?? ""),
    firstName: s.firstName ?? "",
    lastName: s.lastName ?? "",
    grade: s.grade != null ? String(s.grade) : undefined,
    pbisTickets: s.pbisTickets ?? 0,
    attendanceTickets: s.attendanceTickets ?? 0,
    academicTickets: s.academicTickets ?? 0,
    bigRaffleQualified: s.bigRaffleQualified ?? [],
    weeksQualified: s.weeksQualified,
    wildcatCashBalance: s.wildcatCashBalance,
    wildcatCashEarned: s.wildcatCashEarned,
    wildcatCashSpent: s.wildcatCashSpent,
    wildcatCashDeducted: s.wildcatCashDeducted,
    wildcatCashRewardsRedeemed: s.wildcatCashRewardsRedeemed,
    wildcatCashTransactions: s.wildcatCashTransactions,
    cashBalance: s.cashBalance,
    cashTransactions: s.cashTransactions,
  };
  for (const k of Object.keys(r)) if (r[k] === undefined || r[k] === null) delete r[k];
  return r;
});

let created = 0, updated = 0;
for (let i = 0; i < students.length; i += 90) {
  const res = run("migrate:importStudents", { students: students.slice(i, i + 90) });
  created += res.created; updated += res.updated;
}
console.log(`  students        ${students.length} (created ${created}, updated ${updated})`);

// ---- every other slice ---------------------------------------------------
let sliceCount = 0, rowCount = 0;
const appstate = [];
for (const [doc, fields] of Object.entries(docs)) {
  for (const [key, raw] of Object.entries(fields)) {
    if (doc === "main" && (key === "students" || key === "teachers")) continue;
    const val = unwrap(raw);
    let rows = null;
    if (Array.isArray(val)) rows = val.map((x) => ({ payload: x }));
    else if (val && typeof val === "object" && doc !== "main")
      rows = Object.entries(val).map(([k, v]) => ({ key: String(k), payload: v }));
    else if (doc === "main") { appstate.push({ key, value: val }); continue; }
    if (!rows) continue;

    if (rows.length === 0) {
      run("mirror:putSlice", { doc, collection: key, mirroredAt: stamp, rows: [], replace: true });
    } else {
      for (let i = 0; i < rows.length; i += 250) {
        run("mirror:putSlice", {
          doc, collection: key, mirroredAt: stamp,
          rows: rows.slice(i, i + 250), replace: i === 0,
        });
      }
    }
    sliceCount++; rowCount += rows.length;
  }
}
run("mirror:putAppState", { mirroredAt: stamp, entries: appstate });
console.log(`  slices          ${sliceCount} (${rowCount.toLocaleString()} rows)`);
console.log(`  app settings    ${appstate.length} keys`);

console.log(`${"=".repeat(58)}\nRefreshed. Verify with: npm run drift\n`);
