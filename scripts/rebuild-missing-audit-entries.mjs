/**
 * Rebuild audit entries for cash movements that have money on the server and
 * no record of themselves.
 *
 * WHY THIS IS SAFE, and the other list is not. An audit entry does not move
 * money: rebuilding one restores the trail and cannot pay a student twice. The
 * opposite list -- audit entries whose MONEY never landed -- must not be
 * applied this way, because the audit payload carries no transaction id, so a
 * reconstructed cash row would take a new id and would be credited a second
 * time if the teacher's device later sent the original.
 *
 * Measured on production 2026-09-17: 287 cash movements in cash_tx_2026_W38
 * had no matching entry in appAuditLog. 259 of them one teacher's Tuesday
 * afternoon, the rest spread across four more.
 *
 * IDEMPOTENT. Each rebuilt entry takes its id from the cash row it describes:
 *     entryId = 'a_rb_' + <cash row id>
 * so running this twice inserts nothing the second time -- auditLog:append and
 * auditLog:importEntries both dedupe by entryId. The 'a_' prefix is what
 * isMintedAuditId() tests for, so the client treats these as its own.
 *
 * Every rebuilt entry carries `reconstructed: true`, the same flag
 * healAuditEntriesFromHistory() has always used, so a reader can tell a
 * rebuilt record from one written at the time.
 *
 * Usage:
 *     node scripts/rebuild-missing-audit-entries.mjs <unpacked-export-dir>
 *         --out plan.json                 # dry run: compute and write, touch nothing
 *     npx convex run auditLog:importEntries --prod '<batch json>'
 *
 * The apply step is deliberately a separate command, run by hand, so nothing
 * writes to production as a side effect of looking.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/rebuild-missing-audit-entries.mjs <export-dir> [--out plan.json]");
  process.exit(1);
}
const outIdx = process.argv.indexOf("--out");
const outPath = outIdx > 0 ? process.argv[outIdx + 1] : null;

/** The week document the cash ledger currently writes to. */
const CASH_DOC = "cash_tx_2026_W38";

/** Held constant across every entry since 14 September; see the payloads. */
const CYCLE = 2;
const WEEK = 4;

function lines(file) {
  const raw = readFileSync(join(dir, file), "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function payloadOf(row) {
  let p = row.payload;
  if (typeof p === "string") {
    try { p = JSON.parse(p); } catch { p = {}; }
  }
  return p || {};
}

// ---- what the audit log already knows about -------------------------------
// Keyed on (studentId, timestamp to the second). The audit payload carries no
// transaction id, so this pair is the only link between the two stores, and
// the timestamps match to the millisecond where both exist.
const known = new Set();
for (const row of lines("appAuditLog/documents.jsonl")) {
  const p = payloadOf(row);
  if (!String(p.action || "").includes("cash")) continue;
  known.add(`${p.studentId}|${String(p.timestamp || "").slice(0, 19)}`);
}

// ---- cash movements with no record of themselves -------------------------
const orphans = [];
for (const row of lines("legacyMirror/documents.jsonl")) {
  if (String(row.doc) !== CASH_DOC) continue;
  const t = payloadOf(row);
  if (!t.id) continue;
  if (known.has(`${t.studentId}|${String(t.timestamp || "").slice(0, 19)}`)) continue;
  orphans.push(t);
}
orphans.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

// ---- build the entries ---------------------------------------------------
// A redemption has no established action value in this table -- the only
// non-award/deduct one ever written is cash_reversal_debit -- so rather than
// invent one and have a reader render it wrongly, those are set aside for a
// human. There is one, and it is the store test purchase.
const ACTION = { award: "cash_award", deduct: "cash_deduct" };

const entries = [];
const setAside = [];
for (const t of orphans) {
  const action = ACTION[String(t.kind)];
  if (!action) { setAside.push(t); continue; }
  const behavior = String(t.behaviorName || "");
  const notes = String(t.notes || "");
  const entryId = `a_rb_${t.id}`;
  entries.push({
    entryId,
    timestamp: String(t.timestamp || ""),
    payload: {
      action,
      behavior,
      category: "Wildcat Cash",
      cycle: CYCLE,
      entryId,
      notes,
      reason: notes ? `${behavior}, ${notes}` : behavior,
      studentId: String(t.studentId || ""),
      studentName: String(t.studentName || ""),
      teacher: String(t.teacherName || ""),
      teacherId: String(t.teacherId || ""),
      ticketCount: Math.abs(Number(t.amount) || 0),
      timestamp: String(t.timestamp || ""),
      week: WEEK,
      // Tells a reader this was rebuilt from the cash row, not written at the
      // time. Same flag healAuditEntriesFromHistory has always used.
      reconstructed: true,
    },
  });
}

// ---- report -------------------------------------------------------------
const byTeacher = {};
for (const e of entries) {
  const k = e.payload.teacher || "(none)";
  byTeacher[k] = (byTeacher[k] || 0) + 1;
}
console.log(`cash movements with no audit record : ${orphans.length}`);
console.log(`entries to rebuild                  : ${entries.length}`);
console.log(`set aside for a human               : ${setAside.length}`);
for (const t of setAside) {
  console.log(`    ${String(t.timestamp).slice(0, 19)}  ${t.studentName}  ${t.amount}  kind=${t.kind}  ${t.notes}`);
}
console.log("\nby teacher:");
for (const [k, v] of Object.entries(byTeacher).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(28)} ${v}`);
}
console.log("\nfirst rebuilt entry, in full:");
console.log(JSON.stringify(entries[0], null, 2));

if (outPath) {
  // Chunked to the append/import cap so each file is one runnable call.
  const CHUNK = 500;
  const batches = [];
  for (let i = 0; i < entries.length; i += CHUNK) batches.push(entries.slice(i, i + CHUNK));
  batches.forEach((b, i) => {
    const p = outPath.replace(/\.json$/, "") + `.batch${i + 1}.json`;
    writeFileSync(p, JSON.stringify({ entries: b }));
    console.log(`\nwrote ${p}  (${b.length} entries)`);
    console.log(`  apply with: npx convex run auditLog:importEntries --prod "$(cat ${p})"`);
  });
  console.log("\nNOTHING HAS BEEN WRITTEN TO PRODUCTION. The apply command above is separate on purpose.");
}
