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
  // ---- no switch takes back what was earned (2026-10-12 review)
  { guard: "the payer re-checks today's start date and forfeits days already stamped payable", file: RULES, test: E2E,
    from: "    const wait = payNowWhy(input.settings, input.sn, r);",
    to: "    const wait = payNowWhy(input.settings, input.sn, r) ?? scopeOf(input.settings, input.sn, r.date).why;",
    mustFail: "KILL SWITCH OFF AND ON BEFORE MONDAY'S RUN: last week's pending days are paid" },
  { guard: "a control is paid at payday", file: RULES, test: UNIT,
    from: '  if (s.controls.includes(sn)) return "control";\n  return null;', to: "  return null;",
    mustFail: "a control is never paid, even with a payable day" },
  { guard: "the controls stay in place when the whole school goes live", file: RULES, test: UNIT,
    from: '  next.controls = newMode === "live" ? [] : controls;', to: "  next.controls = controls;",
    mustFail: "pilot to live clears the controls, and says so" },
  { guard: "forfeitPending forfeits without apply", file: SERVER, test: E2E,
    from: "    if (a.apply !== true) return { ok: true as const, applied: false, wouldForfeit: counted };\n", to: "",
    mustFail: "forfeitPending counts first and changes nothing without apply" },
  { guard: "a failed PowerSchool read stops payday", file: READER, test: E2E,
    from: "    read = { ok: false, reason: String(e?.message || e).slice(0, 300) };", to: "    throw e;",
    mustFail: "POWERSCHOOL DOWN DOES NOT HOLD BACK LAST WEEK'S PAY: at 09:42 every settled day is paid" },
  { guard: "a decided day is re-stamped by today's settings", file: RULES, test: UNIT,
    from: "    const stamp = r ? { payable: r.payable, why: r.stampWhy ?? null } : scopeOf(settings, p.sn, date);",
    to: "    const stamp = scopeOf(settings, p.sn, date);",
    mustFail: "a shadow day stays unpayable when the switch is live (the stamp is final)" },
  { guard: "a control can be paid", file: RULES, test: UNIT,
    from: '  if (s.controls.includes(sn)) return { payable: false, why: "control" };\n', to: "",
    mustFail: "...a control is never payable" },
  { guard: "the student is promised days in shadow", file: RULES, test: UNIT,
    from: '    .filter((r) => r.studentNumber === sn && r.status === "pending" && payNowWhy(settings, sn, r) === null)',
    to: '    .filter((r) => r.studentNumber === sn && r.status === "pending" && r.payable)',
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
  { guard: "a held read lists no breaking marks", file: RULES, test: E2E,
    from: "      broken: broken.filter((b) => MARK_BROKEN.has(b.why)), counts:", to: "      broken: [], counts:",
    mustFail: "A HELD RE-READ NEVER PAYS OVER A KNOWN BREAK: S1's pending 10/22, absent in the same read, is broken, not paid" },
  { guard: "a held re-read of a decided date changes no day", file: SERVER, test: E2E,
    from: '    const recheckHeld = a.state === "held" && !a.retryable && existing.length > 0;', to: "    const recheckHeld = false;",
    mustFail: "...the students the screen disputes are held, not paid" },
  { guard: "a held re-read makes days pending", file: RULES, test: UNIT,
    from: "  for (const p of input.onlyNotPayable ? [] : input.judgement.perfect) {", to: "  for (const p of input.judgement.perfect) {",
    mustFail: "...and nothing becomes pending or is inserted from a read that was not believed" },
  { guard: "a block that met on one same-pattern day of two is expected", file: RULES, test: UNIT,
    from: "        if (ran.length * 2 <= same.length) continue;\n", to: "",
    mustFail: "A STACK DAY IN A TWO-DAY SAME-PATTERN REFERENCE HOLDS NOTHING: a block that ran on only one of them is not expected" },
  { guard: "a day that looks too perfect is decided", file: RULES, test: E2E,
    from: "    } else if (usualMarked !== null && stats.studentsWithMarks < TOO_PERFECT_RATIO * usualMarked) {", to: "    } else if (false) {",
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

  // ---- a pause never stops the re-read of days already decided (2026-10-12 review, money)
  { guard: "the run reads only dates from countFromDate on", file: READER, test: E2E,
    from: "  const decidable = (d: string) => (!!settings.countFromDate && d >= settings.countFromDate) || settle.has(d);",
    to: "  const decidable = (d: string) => !!settings.countFromDate && d >= settings.countFromDate;",
    mustFail: "AFTER AN OFF/ON, A DAY ALREADY DECIDED IS STILL RE-READ: S1's pending Thursday, absent before payday, is broken, not paid" },
  { guard: "a date before the start is never written, even with days standing", file: SERVER, test: E2E,
    from: '    if (beforeStart && !standing) return { skipped: true as const, reason: "Before the start date." };',
    to: '    if (beforeStart) return { skipped: true as const, reason: "Before the start date." };',
    mustFail: "...and a paid day from before the switch that later breaks goes on the admin's paid-then-broken list" },
  { guard: "a held day does not keep its date in the re-read", file: SERVER, test: E2E,
    from: 'const STANDING = ["pending", "held", "broken", "paid"] as const;', to: 'const STANDING = ["pending", "broken", "paid"] as const;',
    mustFail: "A DAY HELD FOR THE SECOND CHECK IS NOT FORFEITED BY AN OFF/ON: Friday 10/23 is released by the next run and paid on 11/2" },
  { guard: "a date before the start inserts new days", file: RULES, test: UNIT,
    from: "    if (!r && (input.existingOnly || p.existingOnly)) continue;", to: "    if (!r && p.existingOnly) continue;",
    mustFail: "A PAUSE NEVER STARTS A DAY: before the start, nothing is inserted, perfect or held" },
  { guard: "a student kept on class records starts a new day", file: RULES, test: UNIT,
    from: "    if (!r && (input.existingOnly || p.existingOnly)) continue;", to: "    if (!r && input.existingOnly) continue;",
    mustFail: "...and a student kept on class records keeps the day already decided, and starts none" },

  // ---- holds that must not cost the school a day (2026-10-12 review, holds)
  { guard: "every block of the weekday pattern is expected, whatever kind of day it was", file: RULES, test: E2E,
    from: '      const same = today !== "" && vouched.has(today) ? [] : ref.filter((r) => patternOf(r.date) === patternOf(date));',
    to: "      const same = ref.filter((r) => patternOf(r.date) === patternOf(date));",
    mustFail: "A MONDAY RUN ON THE TUE/FRI BELL IS DECIDED THE NEXT MORNING, NOT HELD AS \"NOT ENTERED\"" },
  { guard: "a day still held vouches for the blocks it ran", file: RULES, test: UNIT,
    from: "      const vouched = new Set(ref.filter((r) => decided.has(r.date)).map((r) => shapeOf(r.rowCounts)));",
    to: "      const vouched = new Set(ref.map((r) => shapeOf(r.rowCounts)));",
    mustFail: "ONLY A DECIDED DAY VOUCHES: a held Thursday missing Promise Time PM does not let a Monday missing it too through" },
  { guard: "the run never says which dates were decided", file: SERVER, test: E2E,
    from: '      decided: dates.filter((d) => d.state === "school" && !d.adminDecideAnyway).map((d) => d.date),', to: "      decided: [] as string[],",
    mustFail: "A NORMAL THURSDAY AFTER TWO ALL-TEN-BLOCK MON/THU DAYS IS DECIDED THE NEXT MORNING" },
  { guard: "the lookback is ten school days", file: RULES, test: E2E,
    from: "export const DEFAULT_LOOKBACK = 15;", to: "export const DEFAULT_LOOKBACK = 10;",
    mustFail: "A BLOCK ENTERED 11 SCHOOL DAYS LATE IS STILL READ: Friday 10/23 is decided, not expired, and paid on 11/16" },
  { guard: "a day held only for the second check expires", file: SERVER, test: E2E,
    from: "      if (r.why === R.UNCHECKED) continue;\n", to: "",
    mustFail: "AN OUTAGE LONGER THAN THE LOOKBACK FORFEITS NOTHING: days held only for the second check stay held for an admin, never expired" },
  { guard: "releaseUnchecked releases without apply", file: SERVER, test: E2E,
    from: "    if (a.apply !== true) return { ok: true as const, applied: false, wouldRelease: counted };\n", to: "",
    mustFail: "RELEASE A DATE IN ONE CALL: releaseUnchecked counts first and changes nothing without apply" },
  { guard: "a failed re-read turns a decided date to held", file: SERVER, test: E2E,
    from: '    if (existing.length && (failed || (a.state === "no-school" && owed))) {', to: '    if (existing.length && a.state === "no-school" && owed) {',
    mustFail: "A DECIDED DATE WHOSE RE-READ FAILS STAYS DECIDED, and the run is tried again" },
  { guard: "a failed re-read of a decided date is not tried again", file: READER, test: E2E,
    from: "retryable: r.retryable === true, recheckHeld: r.recheckHeld === true });",
    to: 'retryable: args.retryable === true && r.state === "held", recheckHeld: r.recheckHeld === true });',
    mustFail: "A DECIDED DATE WHOSE RE-READ FAILS STAYS DECIDED, and the run is tried again" },
  { guard: "removed and broken days keep a date from being no school", file: SERVER, test: E2E,
    from: '    const owed = existing.filter((r) => r.status === "pending" || r.status === "held" || r.status === "paid").length;', to: "    const owed = existing.length;",
    mustFail: "AN ADMIN'S \"NO SCHOOL\" STICKS once the decided days are taken out: never turned back to held, never expired" },
  { guard: "a student who came back is not enrolled on the days before", file: RULES, test: E2E,
    from: "    const enteredLater = !enrolled && isDay(s.entry) && s.entry > date;", to: "    const enteredLater = false;",
    mustFail: "A STUDENT WHO LEFT AND CAME BACK IS PAID THE DAYS EARNED BEFORE LEAVING, as they were shown" },
  { guard: "a student who came back with no class record is not enrolled", file: RULES, test: UNIT,
    from: "      if (v.why === \"no-class\") v = { ...v, why: ENROLMENT_UNCONFIRMED };", to: "      if (v.why === \"no-class\") v = { ...v, why: \"not-enrolled\" };",
    mustFail: "...with no class record that day either: a question for an admin (enrolment unconfirmed), never \"not enrolled\"" },
  { guard: "an unconfirmed enrolment breaks the day", file: RULES, test: UNIT,
    from: "    if (b.why === ENROLMENT_UNCONFIRMED) {", to: "    if (false) {",
    mustFail: "ENROLMENT UNCONFIRMED HOLDS, NEVER BREAKS: a pending day is held for an admin, a paid one flagged, and no day is started" },
  { guard: "a kept student is not checked against the screen", file: RULES, test: UNIT,
    from: "      if (sv && sv.bad.includes(date)) {", to: "      if (false) {",
    mustFail: "...a kept student the screen shows absent that day is held, for a day already decided only" },

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
