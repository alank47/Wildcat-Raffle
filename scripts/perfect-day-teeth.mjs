// TEETH for the automatic perfect-day award: every guard's test must FAIL when the guard is broken. Run: npm test
//
// A test that still passes with its guard taken out proves nothing. So this
// copies the code and the tests into a scratch folder (never touching the
// repo), breaks ONE guard at a time -- each break below is the plausible
// mistake, written out -- runs the test that is meant to catch it, and
// requires that exact named check to print FAIL. Before any break, every
// named check must PASS on the unbroken copy, so a renamed or deleted check
// cannot make a break look caught.
//
// An anchor must appear exactly once in its file. If the code moves and an
// anchor no longer matches, this fails loudly rather than skipping the case.
// (The same runner as scripts/reflection-teeth.mjs.)
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULES = "convex/perfectDayRules.ts";
const SERVER = "convex/perfectDay.ts";
const READER = "convex/perfectDayRead.ts";
const SHAPE = "convex/appDataShape.ts";
const LEGACY = "convex/legacyData.ts";
const AWARD = "convex/cashAwardRules.ts";
const UNIT = "perfect-day-rules.test.mjs";
const E2E = "perfect-day.test.mjs";

const CASES = [
  // ---- the rule (owner 10/12)
  { guard: "count K (Ditching) as present", file: RULES, test: UNIT,
    from: 'export const NOT_BREAKING = new Set(["", "D", "F"]);', to: 'export const NOT_BREAKING = new Set(["", "D", "F", "K"]);',
    mustFail: "K (Ditching) breaks it, and is told apart as the screen's known difference" },
  { guard: "forgive excused absences", file: RULES, test: UNIT,
    from: 'export const NOT_BREAKING = new Set(["", "D", "F"]);', to: 'export const NOT_BREAKING = new Set(["", "D", "F", "X"]);',
    mustFail: "an excused absence (X) breaks it: excused absences are not forgiven" },
  { guard: "an unknown code id counts as present", file: RULES, test: UNIT,
    from: "  if (!info) return true;\n  return !NOT_BREAKING.has(info.code);", to: "  if (!info) return false;\n  return !NOT_BREAKING.has(info.code);",
    mustFail: "a code id the code book does not know at all breaks it" },
  // (A leaver's classes end with them too, so the e2e leaver is also caught by
  // "at least one class"; the unit case keeps the classes and moves only the exit.)
  { guard: "enrolment ignores the exit date", file: RULES, test: UNIT,
    from: "const enrolled = isDay(s.entry) && isDay(s.exit) && s.entry <= date && date < s.exit;", to: "const enrolled = isDay(s.entry) && s.entry <= date;",
    mustFail: "enrolled means entrydate <= D < exitdate" },

  // ---- no back-pay, ever (H2)
  // (liveFrom and the pilot's own starts fence the money as well, so the e2e
  // world stays unpaid with this broken; the rule itself is pinned here.)
  { guard: "switching back on keeps the old start date", file: RULES, test: UNIT,
    from: "    const from = input.countFromDate ?? today;", to: "    const from = input.countFromDate ?? prev.countFromDate ?? today;",
    mustFail: "off then on again counts from the day it came back on" },
  { guard: "the payer trusts the stamp and does not re-check today's scope", file: RULES, test: E2E,
    from: '    if (!sc.payable) { skipped.push({ date: r.date, why: sc.why ?? "out-of-scope", row: r }); continue; }\n', to: "",
    mustFail: "A SWITCH OFF/ON NEVER BACK-PAYS: Monday's payday pays none of the days from before the pause" },
  { guard: "a decided day is re-stamped by today's settings", file: RULES, test: UNIT,
    from: "    const stamp = r ? { payable: r.payable, why: r.stampWhy ?? null } : scopeOf(settings, p.sn, date);",
    to: "    const stamp = scopeOf(settings, p.sn, date);",
    mustFail: "a shadow day stays unpayable when the switch is live (the stamp is final)" },
  { guard: "a control can be paid", file: RULES, test: UNIT,
    from: '  if (s.controls.includes(sn)) return { payable: false, why: "control" };\n', to: "",
    mustFail: "...a control is never payable" },
  { guard: "the student is promised days in shadow", file: RULES, test: UNIT,
    from: "  if (!paying(settings.mode) || !payableFrom(settings, sn)) return null;", to: "",
    mustFail: "in shadow nobody sees anything promised" },

  // ---- the second check and the calendar (H1, H3)
  { guard: "one disagreement holds the whole date", file: RULES, test: E2E,
    from: "    const limit = Math.max(1, Math.floor(DISAGREE_DAY_MAX * enrolledTotal));", to: "    const limit = 0;",
    mustFail: "ONE DISAGREEMENT NEVER HOLDS THE SCHOOL: S6 is held, the other eleven are pending, the date is decided" },
  { guard: "the screen's data from before the day ended is used as the check", file: RULES, test: UNIT,
    from: "const usable = input.screen.available && !!input.screen.asOf && input.screen.asOf > date;",
    to: "const usable = input.screen.available;",
    mustFail: "a screen rebuilt before the day ended is no second check: decided unchecked" },
  { guard: "a new day becomes payable without the second check", file: RULES, test: E2E,
    from: 'const status: Status = !stamp.payable ? "unpayable" : !input.judgement.checked ? "held" : "pending";',
    to: 'const status: Status = !stamp.payable ? "unpayable" : "pending";',
    mustFail: "with no second check (the rebuild was writing), the late-entered 10/27 is HELD, not pending" },
  { guard: "the screen is read while the rebuild holds its write lock", file: SERVER, test: E2E,
    from: "    const w = rb.writing;\n    if (w) {", to: "    const w = rb.writing;\n    if (false) {",
    mustFail: "with no second check (the rebuild was writing), the late-entered 10/27 is HELD, not pending" },
  { guard: "a holiday (no attendance) is held as a failed read", file: READER, test: E2E,
    from: '  for (const d of zero) if (decidable(d)) await apply({ runId: a.runId, date: d, state: "no-school", reason: "PowerSchool has no attendance for this date." });',
    to: '  for (const d of zero) if (decidable(d)) await apply({ runId: a.runId, date: d, state: "held", retryable: true, reason: "PowerSchool has no attendance for this date." });',
    mustFail: "A HOLIDAY IS NOT A FAILED READ: Thursday 10/22 (no attendance) is no school, not held, not retried" },
  { guard: "a day with no rows is judged a failed read", file: RULES, test: UNIT,
    from: '      rows.length ? `PowerSchool shows too little attendance for a school day (${rows.length} rows).` : "PowerSchool has no attendance for this date.",\n      false,',
    to: '      rows.length ? `PowerSchool shows too little attendance for a school day (${rows.length} rows).` : "PowerSchool has no attendance for this date.",\n      true,',
    mustFail: "a holiday (no attendance at all) is NO SCHOOL, never held, never retried" },
  { guard: "a read that was not confirmed is taken as an empty day", file: READER, test: E2E,
    from: "      return r.ok ? { ok: true as const, rows: [...r.rows.values()] } : { ok: false as const, reason: r.reason };",
    to: "      return { ok: true as const, rows: r.ok ? [...r.rows.values()] : [] };",
    mustFail: "A FAILED READ IS HELD AND RETRIED: Friday is held (retryable), and Monday's payday waits for it at 07:42" },
  { guard: "a day that looks too perfect is decided", file: RULES, test: E2E,
    from: "      if (stats.studentsWithMarks < TOO_PERFECT_RATIO * usual) {", to: "      if (false) {",
    mustFail: "A DAY THAT LOOKS TOO PERFECT IS HELD, NOT PAID (10/28: 7 students marked against a usual 25)" },
  { guard: "a hold never expires", file: READER, test: E2E,
    from: "await ctx.runMutation(internal.perfectDay.expireOld, { runId: a.runId, before: windowStart });",
    to: 'await ctx.runMutation(internal.perfectDay.expireOld, { runId: a.runId, before: "0000-00-00" });',
    mustFail: "A HOLD NEVER LASTS FOR EVER: 10/28 expired once it left the lookback, unpaid" },
  { guard: "the tick trusts a fixed UTC offset", file: RULES, test: UNIT,
    from: "  const lt = localSchoolTime(input.nowIso, input.tz);", to: '  const lt = localSchoolTime(input.nowIso, "Etc/GMT+7");',
    mustFail: "DST: 14:42Z on Mon 11/2 is 06:42 PST: run, for 11/2" },
  { guard: "no morning window", file: RULES, test: UNIT,
    from: "    if (lt.minuteOfDay < MORNING_FROM || lt.minuteOfDay >= MORNING_TO) {", to: "    if (false) {",
    mustFail: "never at 11:15 school time or later (the Reflection Room's cutoff)" },

  // ---- the admin's tools
  { guard: "no school can be marked over days already decided", file: SERVER, test: E2E,
    from: "      if (decided.length) {", to: "      if (false) {",
    mustFail: "NO SCHOOL IS REFUSED for a date with days already decided (it would stop the reads, not the money)" },
  { guard: "a later run re-holds a day an admin settled", file: RULES, test: E2E,
    from: '    if (r && (r.status === "pending" || r.status === "unpayable") && String(r.why ?? "").startsWith("admin:")) continue;\n', to: "",
    mustFail: "...and the person's word stands, though the screen still disagrees the next morning" },

  // ---- the money: once, stamped, never taken back by itself (M1, M3, L2)
  { guard: "no once-per-student-week key", file: SERVER, test: E2E,
    from: "      if (already) { out.alreadyPaidThisWeek++; continue; }\n", to: "",
    mustFail: "PAYOUT IS EXACTLY ONCE PER STUDENT-WEEK: a second payday the same week pays S3 nothing more" },
  { guard: "the register rows are not marked paid with the money", file: SERVER, test: E2E,
    from: '    await ctx.db.patch(r._id, { status: "paid", why: undefined, paidTxnId: txnId, paidAt: at, updatedAt: input.nowIso, runId: input.runId });',
    to: "    void r;",
    mustFail: "Monday 11/2 pays S3's corrected 10/20 with the new week, as one movement, at the amount stamped when it was first found perfect" },
  { guard: "the amount is today's setting, not the day's stamp", file: SERVER, test: E2E,
    from: "  const amount = input.rows.reduce((s, r) => s + r.amount, 0);", to: "  const amount = input.rows.length * (await loadSettings(ctx)).amount;",
    mustFail: "...at the amounts stamped on each day: $600, $600, $500 (late to school on 10/20), $500 (K on 10/21)" },
  { guard: "a week past $5,000 is one movement", file: RULES, test: UNIT,
    from: "    if (!cur || cur.amount + r.amount > MAX_CASH_DELTA) {", to: "    if (!cur) {",
    mustFail: "a week past $5,000 is split, so Reverse can undo each part" },
  { guard: "a paid day that breaks is taken back automatically", file: RULES, test: E2E,
    from: "        patches.push({ id: r._id, patch: { afterPayBroken: true, afterPayWhy: b.why, afterPayAt: now, ...base } });",
    to: '        patches.push({ id: r._id, patch: { status: "broken", why: b.why, ...base } });',
    mustFail: "a PAID day that later breaks is never taken back automatically: it is flagged for an admin" },
  { guard: "a removed day is paid again once it reads perfect", file: RULES, test: E2E,
    from: '    if (r && (r.status === "removed" || r.status === "expired")) continue;\n    if (r && r.status === "paid") {',
    to: '    if (r && r.status === "paid") {',
    mustFail: "A REMOVED DAY IS NEVER PAID AGAIN, even once it reads perfect" },
  { guard: "a student number on two Hub records is paid to the first", file: SERVER, test: E2E,
    from: 'const rows = await ctx.db.query("students").withIndex("by_studentNumber", (q) => q.eq("studentNumber", sn)).take(2);',
    to: 'const rows = await ctx.db.query("students").withIndex("by_studentNumber", (q) => q.eq("studentNumber", sn)).take(1);',
    mustFail: "a student number on two Hub records is never paid a guess" },
  { guard: "a run that lost its lease still writes", file: SERVER, test: E2E,
    from: '  if (!lease || lease.runId !== runId) return { ok: false, reason: "This run no longer holds the lease." };\n', to: "",
    mustFail: "A RUN THAT LOST ITS LEASE WRITES NOTHING" },
  { guard: "the summary audit entry is written whatever the switch says", file: SERVER, test: E2E,
    from: "    if (live.settings.auditSummary && Number(s.movements) > 0) {", to: "    if (Number(s.movements) > 0) {",
    mustFail: "the job wrote no audit entry per student (summary off), no award command, and no cashApplied" },
  { guard: "the ledger check only looks for a misspelt kind", file: SERVER, test: E2E,
    from: "        if (!isSystemCashRow(p)) continue;\n        attendanceRows++;", to: '        if (p?.kind !== "attendence") continue;\n        attendanceRows++;',
    mustFail: "THE LEDGER CHECK: an attendance row with no payment behind it is found" },

  // ---- the browser cannot send it (M2): all four write paths and the command
  { guard: "appData:save applies an attendance movement", file: SHAPE, test: E2E,
    from: '    if (isSystemCashRow(m)) { refused.push({ id, why: "reserved_kind" }); continue; }\n', to: "",
    mustFail: "...appData:save refuses the movement and the history row: no counter moves, no row is stored" },
  { guard: "appData:save stores an attendance row in a history", file: SHAPE, test: E2E,
    from: "    const pruned = (pruneHistoryArray(incoming, historyCutoff) as unknown[])\n      .filter((r) => !isSystemCashRow(r));",
    to: "    const pruned = pruneHistoryArray(incoming, historyCutoff) as unknown[];",
    mustFail: "...appData:save refuses the movement and the history row: no counter moves, no row is stored" },
  { guard: "mergeSlice inserts a server-only row", file: LEGACY, test: E2E,
    from: "      if (cashDoc && isSystemCashRow(accepted.payload)) {", to: "      if (false) {",
    mustFail: "THE BROWSER CANNOT SEND THE RESERVED BEHAVIOUR: mergeSlice refuses an attendance row, and a row naming the system as giver" },
  { guard: "mergeSlice lets a browser copy rewrite a stored payment", file: LEGACY, test: E2E,
    from: "        if (stored && cashDoc && (isSystemCashRow(stored.payload) || isSystemCashRow(r.payload))) {", to: "        if (false) {",
    mustFail: "...a stored payment is never rewritten by a browser copy, however new its stamp" },
  { guard: "saveSlice inserts a server-only row", file: LEGACY, test: E2E,
    from: "      const fresh = unioned.filter((r) => !isSystemCashRow(r.payload));", to: "      const fresh = unioned;",
    mustFail: "...saveSlice refuses it too" },
  { guard: "the award command takes a system: behaviour", file: AWARD, test: E2E,
    from: "const RESERVED_BEHAVIOR = /^(system_reset|reward:|reward-refund:|reversal:|system:)/i;",
    to: "const RESERVED_BEHAVIOR = /^(system_reset|reward:|reward-refund:|reversal:)/i;",
    mustFail: "...and the award command refuses both the reserved behaviour and the kind" },
];

// A builder's shortcut, never set in npm test: PERFECT_DAY_TEETH_ONLY=<text>
const ONLY = process.env.PERFECT_DAY_TEETH_ONLY || "";
const RUN = ONLY ? CASES.filter((c) => c.test.includes(ONLY) || c.guard.includes(ONLY)) : CASES;

const COPY_EXT = /\.(mjs|js|ts|json|html|css|md)$/;
function copyTree(from, to, top = true) {
  for (const name of readdirSync(from)) {
    if (name === "node_modules" || name === ".git" || name === ".claude" || name.startsWith(".")) continue;
    const src = join(from, name);
    const st = statSync(src);
    if (st.isDirectory()) {
      if (top && !["convex", "scripts", "docs"].includes(name)) continue;
      copyTree(src, join(to, name), false);
    } else if (COPY_EXT.test(name)) {
      cpSync(src, join(to, name));
    }
  }
}

const scratch = mkdtempSync(join(process.env.PERFECT_DAY_TEETH_DIR || tmpdir(), "perfect-day-teeth-"));
let bad = 0;
const say = (s) => console.log(s);
try {
  copyTree(ROOT, scratch);
  symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"), "dir");
  const run = (test) => spawnSync(process.execPath, [join(scratch, test)], { cwd: scratch, encoding: "utf8", timeout: 120_000 });
  const lines = (r) => String(r.stdout || "").split("\n");
  const has = (r, verdict, name) => lines(r).some((l) => l === `  ${verdict}  ${name}` || l.startsWith(`  ${verdict}  ${name}  (`));

  say("\nTHE UNBROKEN COPY: every named check passes\n");
  for (const test of [...new Set(RUN.map((c) => c.test))]) {
    const r = run(test);
    const missing = RUN.filter((c) => c.test === test && !has(r, "PASS", c.mustFail));
    if (r.status !== 0 || missing.length) {
      bad++;
      say(`  FAIL  ${test} unbroken: exit ${r.status}; checks not passing: ${missing.map((c) => JSON.stringify(c.mustFail)).join(", ") || "none"}`);
      if (r.stderr) say(String(r.stderr).slice(0, 800));
    } else {
      say(`  PASS  ${test} passes unbroken`);
    }
  }

  say("\nEACH GUARD BROKEN IN TURN: its check must fail\n");
  for (const c of RUN) {
    const path = join(scratch, c.file);
    const original = readFileSync(path, "utf8");
    const at = original.indexOf(c.from);
    if (at < 0 || original.indexOf(c.from, at + 1) >= 0) {
      bad++;
      say(`  FAIL  ${c.guard}: anchor not found exactly once in ${c.file}`);
      continue;
    }
    writeFileSync(path, original.slice(0, at) + c.to + original.slice(at + c.from.length));
    try {
      const r = run(c.test);
      if (r.status !== 0 && has(r, "FAIL", c.mustFail)) {
        say(`  PASS  ${c.guard}  ->  "${c.mustFail}" fails`);
      } else {
        bad++;
        say(`  FAIL  ${c.guard}: "${c.mustFail}" did not fail (exit ${r.status})`);
        if (r.status !== 0 && !has(r, "FAIL", c.mustFail)) say(String(r.stderr || "").slice(0, 400));
      }
    } finally {
      writeFileSync(path, original);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${RUN.length - Math.min(bad, RUN.length)} of ${RUN.length} breaks caught${ONLY ? ` (only "${ONLY}")` : ""}${bad ? `; ${bad} problem(s)` : ""}\n`);
if (bad) process.exit(1);
