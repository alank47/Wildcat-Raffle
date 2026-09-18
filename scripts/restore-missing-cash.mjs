/**
 * Rebuild cash movements whose AUDIT ENTRY survived and whose MONEY did not.
 *
 * THE MIRROR IMAGE of scripts/rebuild-missing-audit-entries.mjs, and the
 * harder direction. That one restored the RECORD of movements whose money was
 * safe, which cannot pay anybody twice. This one restores MONEY, so every
 * safeguard below is load-bearing.
 *
 * WHAT WENT WRONG. A movement is written to two tables by two separate calls:
 * recordCashTransaction pushes the ledger row, addToAuditLog writes the audit
 * entry. Either can land without the other. Measured on production
 * 2026-09-17: 101 movements dated after the 14 September history cutoff had an
 * audit entry and no ledger row -- 98 awards worth $10,700 and 3 deductions
 * worth $300, across 95 students. The owner found it in one child: "leo-andrew
 * had -100 deducted but in his account nor in my student list in Award Cash
 * does it show he was deducted."
 *
 * THE RECOUNT CANNOT FIX IT. cashRecount makes the counters agree with the
 * ledger, and here the ledger is the thing missing a row -- so the counter is
 * faithfully reporting an incomplete history. The movement comes back first,
 * then the recount aligns the counters.
 *
 * BOUNDED BY THE HISTORY CUTOFF, which is the single most important filter
 * here. 348 further audit-recorded movements have no ledger row because the
 * ledger was deliberately PURGED at the cutoff. Their absence is correct, and
 * restoring them would re-credit money the school wiped. Counting them is how
 * this looked like 449 movements and $32,000 instead of 101 and $10,400.
 *
 * NOT PAID TWICE. A rebuilt row needs a new id -- the audit entry never
 * carried the original's -- so id alone cannot stop a double credit if the
 * teacher's device still holds the original and sends it later.
 * cashMovementKey closes that by identifying a movement as
 * student|second|amount, and it was widened from millisecond to SECOND
 * precision for exactly this: the ledger row and the audit entry are stamped
 * by two separate `new Date()` calls, and 139 of 2,086 movements on production
 * carry timestamps 1-2ms apart. The id is also derived from the movement
 * itself, so re-running this proposes the same id rather than a second one.
 *
 * AMBIGUOUS CASES ARE HELD BACK. A movement with a same-amount ledger row for
 * the same student within five minutes might be a second real award, or might
 * be the same one recorded twice. None of the 101 has one within 60 seconds;
 * 14 do within five minutes. Those are excluded unless --include-ambiguous,
 * because crediting a child twice is worse than crediting them late.
 *
 * AN UNKNOWN BEHAVIOUR IS REFUSED, NOT GUESSED. The audit entry carries the
 * behaviour's NAME and not its id, so the id is mapped from the names the live
 * ledger actually uses. A name with no mapping is reported for a human.
 *
 * Usage:
 *     npx convex export --prod --path snap.zip && unzip -q snap.zip -d snap
 *     node scripts/restore-missing-cash.mjs snap --out plan.json
 *         # dry run: measure, report, write batch files, touch nothing
 *
 *     npx convex run cashRestore:restoreMovements --prod "$(cat plan.batch1.json)"
 *         # still a dry run: the mutation defaults to apply:false
 *
 * The apply step is deliberately a separate command, run by hand, so nothing
 * writes to production as a side effect of looking.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/restore-missing-cash.mjs <export-dir> [--out plan.json] [--include-ambiguous]");
  process.exit(1);
}
const outIdx = process.argv.indexOf("--out");
const outPath = outIdx > 0 ? process.argv[outIdx + 1] : null;
const includeAmbiguous = process.argv.includes("--include-ambiguous");

const lines = (t) => {
  const p = join(dir, t, "documents.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const payloadOf = (row) => {
  let p = row.payload;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = {}; } }
  return p || {};
};
const money = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US");

// ---- the cutoff, read rather than assumed -------------------------------
let cutoff = null;
for (const r of lines("appState")) {
  if (r.key === "historyCutoff") cutoff = (r.value && r.value.iso) || null;
}
if (!cutoff || !Number.isFinite(Date.parse(cutoff))) {
  console.error("\nNo history cutoff in this export, so a post-reset movement cannot be told\n" +
                "from a pre-reset one. Restoring a pre-reset movement would re-credit money\n" +
                "the school deliberately wiped. Refusing to run.\n");
  process.exit(1);
}

// ---- the ledger ---------------------------------------------------------
const ledger = [];
for (const r of lines("legacyMirror")) {
  if (!String(r.doc ?? "").startsWith("cash_tx_")) continue;
  if (r.collection !== "transactions") continue;
  ledger.push(payloadOf(r));
}
/** Matches convex/legacyData.ts cashMovementKey: student|second|amount. */
const movementKey = (sid, ts, amt) => `${String(sid)}|${String(ts).slice(0, 19)}|${Number(amt)}`;
const present = new Set(ledger.map((t) => movementKey(t.studentId, t.timestamp, t.amount)));

// behaviour NAME -> id, from what the ledger actually uses.
const behaviourId = new Map();
for (const t of ledger) {
  const nm = String(t.behaviorName ?? "");
  const id = String(t.behaviorId ?? "");
  if (nm && id && !behaviourId.has(nm)) behaviourId.set(nm, id);
}

const byStudent = new Map();
for (const t of ledger) {
  const k = String(t.studentId ?? "");
  if (!byStudent.has(k)) byStudent.set(k, []);
  byStudent.get(k).push(t);
}

const students = new Map();
for (const s of lines("students")) {
  students.set(String(s.legacyId ?? s.studentNumber ?? s._id ?? ""), s);
}

// ---- audit-recorded movements with no money ----------------------------
const SIGN = { cash_award: 1, cash_deduct: -1 };
const orphans = [];
let preCutoff = 0;
for (const r of lines("appAuditLog")) {
  const p = payloadOf(r);
  const sign = SIGN[String(p.action ?? "")];
  if (!sign) continue;
  const ts = String(p.timestamp ?? "");
  const sid = String(p.studentId ?? "");
  const amount = Math.abs(Number(p.ticketCount) || 0) * sign;
  if (!sid || !ts || !amount) continue;
  if (present.has(movementKey(sid, ts, amount))) continue;
  if (ts <= cutoff) { preCutoff++; continue; }
  orphans.push({ p, sid, ts, amount });
}
orphans.sort((a, b) => a.ts.localeCompare(b.ts));

/** The ISO-week key, matching cashReversalRules.cashWeekKey. */
function weekKey(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}_W${String(week).padStart(2, "0")}`;
}

// ---- build, holding back anything not safe to write --------------------
const build = [];
const ambiguous = [];
const refused = [];
for (const o of orphans) {
  const { p, sid, ts, amount } = o;
  const student = students.get(sid);
  if (!student) { refused.push([o, "no student record matches this id"]); continue; }

  const name = String(p.behavior ?? "");

  // A REFUND IS NEVER SYNTHESISED HERE, and this guard is not theoretical: on
  // the first run this tool tried to rebuild the $1,000 refund on receipt
  // WC-XPSGVE that had been deliberately WITHDRAWN an hour earlier, because
  // withdrawing it removed the ledger row and left the audit entry behind --
  // which is precisely the shape this tool hunts for. It happened to be
  // refused for an unrelated reason (the behaviour name no longer mapped to an
  // id once the row was gone), and luck is not a safeguard.
  //
  // Refunds belong to the receipt path -- buildCancel decides whether one is
  // owed at all, and since 2026-09-17 refuses it outright across a balance
  // reset. A refund rebuilt from an audit entry bypasses that judgement
  // entirely and would re-credit money that was taken back on purpose.
  if (/^Refund:/i.test(name) || String(p.action ?? "") === "reward_cancelled") {
    refused.push([o, `"${name}" is a store refund: it belongs to the receipt path, never to this tool`]);
    continue;
  }

  const bid = behaviourId.get(name);
  if (!bid) { refused.push([o, `behaviour "${name}" maps to no behaviorId in the ledger`]); continue; }

  const week = weekKey(ts);
  if (!week) { refused.push([o, "timestamp has no usable date"]); continue; }

  // Same student, same amount, within five minutes: might be a second real
  // award, might be this one already recorded. A human decides.
  const near = (byStudent.get(sid) || []).find((t) =>
    Number(t.amount) === amount &&
    Math.abs(Date.parse(String(t.timestamp)) - Date.parse(ts)) <= 300000);
  const row = {
    // Derived from the movement, so re-running proposes the same id.
    id: "txn_rb_" + createHash("sha1").update(`${sid}|${ts}|${amount}`).digest("hex").slice(0, 12),
    studentId: sid,
    timestamp: ts,
    amount,
    kind: amount >= 0 ? "award" : "deduct",
    behaviorId: bid,
    behaviorName: name,
    notes: String(p.notes ?? ""),
    teacherId: String(p.teacherId ?? ""),
    teacherName: String(p.teacher ?? p.teacherName ?? ""),
  };
  const who = `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim();
  if (near && !includeAmbiguous) { ambiguous.push([o, who, near]); continue; }
  build.push({ week, row, who, ambiguous: Boolean(near) });
}

// ---- report ------------------------------------------------------------
console.log(`\nRestore missing cash movements   (dry run)`);
console.log("=".repeat(70));
console.log(`history cutoff              : ${cutoff}`);
console.log(`ledger rows read            : ${ledger.length}`);
console.log(`pre-cutoff, correctly absent: ${preCutoff}   (the ledger was purged; NOT restored)`);
console.log(`post-cutoff with no money   : ${orphans.length}`);
console.log(`  to restore                : ${build.length}   ${money(build.reduce((n, b) => n + b.row.amount, 0))}`);
console.log(`  held back as ambiguous    : ${ambiguous.length}${includeAmbiguous ? " (INCLUDED by flag)" : ""}`);
console.log(`  refused                   : ${refused.length}`);

const awards = build.filter((b) => b.row.amount > 0);
const deducts = build.filter((b) => b.row.amount < 0);
console.log(`\n  awards    : ${awards.length}  ${money(awards.reduce((n, b) => n + b.row.amount, 0))}`);
console.log(`  deductions: ${deducts.length}  ${money(deducts.reduce((n, b) => n + b.row.amount, 0))}`);
console.log(`  students  : ${new Set(build.map((b) => b.row.studentId)).size}`);

if (deducts.length) {
  console.log(`\nTHE DEDUCTIONS -- these REDUCE a balance, so read them:`);
  deducts.forEach((b) => console.log(
    `  ${b.row.timestamp.slice(0, 19)}  ${money(b.row.amount).padStart(7)}  ${b.who.padEnd(28)} ` +
    `${b.row.behaviorName} / ${b.row.notes} (by ${b.row.teacherName})`));
}
if (ambiguous.length) {
  console.log(`\nHELD BACK (${ambiguous.length}) -- a same-amount row exists within 5 minutes.`);
  console.log(`Either a second real award, or this movement already recorded. Not restored:`);
  ambiguous.forEach(([o, who, near]) => console.log(
    `  ${o.ts.slice(0, 19)}  ${money(o.amount).padStart(7)}  ${who.padEnd(28)} ` +
    `ledger row at ${String(near.timestamp).slice(0, 19)}`));
}
if (refused.length) {
  console.log(`\nREFUSED (${refused.length}):`);
  refused.forEach(([o, why]) => console.log(`  ${o.ts.slice(0, 19)}  ${money(o.amount).padStart(7)}  ${why}`));
}

const byTeacher = {};
build.forEach((b) => { const k = b.row.teacherName || "(none)"; byTeacher[k] = (byTeacher[k] || 0) + 1; });
console.log(`\nby teacher:`);
Object.entries(byTeacher).sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${k.padEnd(28)} ${v}`));

if (build.length) {
  console.log(`\nfirst row to be written, in full:`);
  console.log(JSON.stringify(build[0].row, null, 2));
}

// ---- batch files, one runnable call each -------------------------------
if (outPath) {
  const byWeek = {};
  build.forEach((b) => { (byWeek[b.week] = byWeek[b.week] || []).push(b.row); });
  const CHUNK = 25;   // one week document is re-read per call; keep it modest
  let n = 0;
  for (const [week, rows] of Object.entries(byWeek)) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      n++;
      const p = outPath.replace(/\.json$/, "") + `.batch${n}.json`;
      writeFileSync(p, JSON.stringify({ doc: `cash_tx_${week}`, movements: rows.slice(i, i + CHUNK), apply: true }));
      console.log(`\nwrote ${p}  (${Math.min(CHUNK, rows.length - i)} movements, ${week})`);
      console.log(`  apply with: npx convex run cashRestore:restoreMovements --prod "$(cat ${p})"`);
    }
  }
  console.log(`\nNOTHING HAS BEEN WRITTEN TO PRODUCTION. Each command above is separate on purpose.`);
  console.log(`Afterwards, align the counters: node scripts/recount-cash-counters.mjs --prod --apply`);
}
