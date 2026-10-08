// TEETH for the Reflection Room list: every guard's test must FAIL when the guard is broken. Run: npm test
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
//
// Later steps of the build add their breaks to CASES (one line each).
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULES = "convex/reflectionRules.ts";
const RULES_TEST = "convex/reflectionRules.test.mjs";
const READ = "convex/reflectionRead.ts";
const READ_TEST = "reflection-read.test.mjs";
const GUARD_TEST = "roster-empty-guard.test.mjs";
const SERVER = "convex/reflection.ts";
const READER = "convex/reflectionRead.ts";
const READER_TEST = "reflection-reader.test.mjs";

const CASES = [
  // ---- step 1: the rules (spec 6, step 1 table)
  { guard: "use a fixed UTC-7 clock (getUTCHours) in place of localSchoolTime", file: RULES, test: RULES_TEST,
    from: "export function wallClock(iso: string, tz: string) {\n  return localSchoolTime(iso, tz);\n}",
    to: "export function wallClock(iso: string, tz: string) {\n  const d = new Date(Date.parse(iso) - 7 * 3600 * 1000);\n"
      + "  return { ok: true as const, dateKey: d.toISOString().slice(0, 10), weekday: d.getUTCDay(), minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes() };\n}",
    mustFail: "DST: 2026-11-02 19:45Z is 11:45 PST, a closing read" },
  { guard: "treat a Promise Time AM T as present", file: RULES, test: RULES_TEST,
    from: `return { reading: marks.some((m) => !m.absent && m.code !== "T" && m.code !== "D") ? "present" : "absent", noRow: false };`,
    to: `return { reading: marks.some((m) => !m.absent) ? "present" : "absent", noRow: false };`,
    mustFail: "PT AM tardy then first-class T is skipped" },
  { guard: "drop the 'earlier class absent' check (the literal rule)", file: RULES, test: RULES_TEST,
    from: `    return { reading: marks.some((m) => !m.absent) ? "present" : "absent", noRow: false };`,
    to: `    return { reading: "present", noRow: false };`,
    mustFail: "arrival during P3 is skipped" },
  { guard: "drop the 'earlier class T proves presence' check (the whole-day rule)", file: RULES, test: RULES_TEST,
    from: `    return { reading: marks.some((m) => !m.absent) ? "present" : "absent", noRow: false };`,
    to: `    return { reading: marks.some((m) => !m.absent && m.code !== "T") ? "present" : "absent", noRow: false };`,
    mustFail: "late arriver later tardy to P3 counts" },
  { guard: "count D (Excused Tardy)", file: RULES, test: RULES_TEST,
    from: `  const codes = ["T"];`, to: `  const codes = ["T", "D"];`,
    mustFail: "the D control: an Excused Tardy is never listed" },
  { guard: "let D's freeze claim slot 6 dated D", file: RULES, test: RULES_TEST,
    from: "  if (t.attDate === day && !servesSameDay(t.slot)) return false;\n", to: "",
    mustFail: "P5 never serves the same day" },
  { guard: "use > in place of >= on the closing start", file: RULES, test: RULES_TEST,
    from: "  return startMs >= t.closeMs && startMs + LEASE_MS <= t.readyMs;",
    to: "  return startMs > t.closeMs && startMs + LEASE_MS <= t.readyMs;",
    mustFail: "a read starting exactly at close is closing" },
  { guard: "remove the carry limit", file: RULES, test: RULES_TEST,
    from: "    if (v.countsTowardLimit && input.unit.carryCount >= input.maxCarries) {", to: "    if (false) {",
    mustFail: "6th carry goes to review" },
  // The spec pairs this break with "absent all morning and at Power-Up, then
  // T at P5, is skipped", which is an arrival with Power-Up in either place,
  // so it cannot bite. The case below is decided by Power-Up's position.
  { guard: "place Power-Up after slot 7 in the day's order", file: RULES, test: RULES_TEST,
    from: "export const SLOT_ORDER: number[] = [1, 2, 3, 4, 5, 8, 9, 6, 7, 10];",
    to: "export const SLOT_ORDER: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];",
    mustFail: "Power-Up comes before P5: absent all morning, at Power-Up, then T at P5 counts" },
  { guard: "set ready = close + 1 min", file: RULES, test: RULES_TEST,
    from: "  const readyMinute = READY_MINUTE[kind];", to: "  const readyMinute = closeMinute + 1;",
    mustFail: "closing fails 11:45 and 11:50, succeeds 11:55, is closing" },
  { guard: "drop the lastFreezeInstant check", file: RULES, test: RULES_TEST,
    from: "    if (now >= t.lastFreezeMs) {\n      return { do: \"latest-freeze\"",
    to: "    if (false) {\n      return { do: \"latest-freeze\"",
    mustFail: "no read until 12:40 means no list; items on D+1" },
  // A Saturday is never a school day whatever the evidence, so the spec's
  // Saturday case cannot catch this; the unmarked weekday holiday can.
  { guard: "count uniform rows as school-day evidence", file: RULES, test: RULES_TEST,
    from: "  if (hasEvidence(input.rowCounts)) return",
    to: "  if (hasEvidence(input.rowCounts) || Number(input.uniformRows ?? 0) > 0) return",
    mustFail: "an unmarked weekday holiday with a uniform entry makes no list" },
  { guard: "measure lateness in calendar days (11/20)", file: RULES, test: RULES_TEST,
    from: "  return lists.length;",
    to: "  return Math.floor((seen - Date.parse(input.attDate + \"T00:00:00Z\")) / 86400000);",
    mustFail: "11/20 P6 lands on 11/30" },
  { guard: "measure lateness in calendar days (12/18)", file: RULES, test: RULES_TEST,
    from: "  return lists.length;",
    to: "  return Math.floor((seen - Date.parse(input.attDate + \"T00:00:00Z\")) / 86400000);",
    mustFail: "12/18 P5 lands on 1/11" },
  { guard: "carry on the Power-Up Absent mark alone", file: RULES, test: RULES_TEST,
    from: "  if (puAbsent && !(presentBefore && presentAfter)) {", to: "  if (puAbsent) {",
    mustFail: "pulled student present in P4 and P5 does not carry" },
  { guard: "ignore room attendance", file: RULES, test: RULES_TEST,
    from: "  if (input.room.attendanceDone) {", to: "  if (false) {",
    mustFail: "unticked student absent at Power-Up does not carry" },
  { guard: "treat 'no row' as present whatever the section", file: RULES, test: RULES_TEST,
    from: "  if (sectionHasMarks(summary, slot, section)) return { reading: \"present\", noRow: true };",
    to: "  return { reading: \"present\", noRow: true };",
    mustFail: "PT AM section with no marks holds the first-class T" },
  // Two more guards of this step that the spec's table does not list.
  { guard: "send a tardy to review only AFTER more than 5 lists (> for >=)", file: RULES, test: RULES_TEST,
    from: "  if (input.listsBeforeSeen >= input.lateEntryLists) {", to: "  if (input.listsBeforeSeen > input.lateEntryLists) {",
    mustFail: "a T first seen after 5 lists goes to admin review, never silently onto a list" },
  { guard: "drop the enrolment filter", file: RULES, test: RULES_TEST,
    from: "    && (enrolled ? enrolled.has(s) : !POWER_UP_SLOTS.includes(s)));", to: "    && true);",
    mustFail: "a class the student is not enrolled in is not evidence of being in school" },

  // ---- step 2: the confirmed read
  { guard: "accept a single steady read (drop the same-ids check)", file: READ, test: READ_TEST,
    from: "      if (steady && previous !== null && sameList(previous, ids)) {", to: "      if (steady) {",
    mustFail: "delete + insert mid-read is not taken" },

  // ---- step 3: the empty-clear guard and the roster snapshot
  { guard: "remove the empty-clear guard (clear and rewrite whatever was read)", file: "convex/sisAction.ts", test: GUARD_TEST,
    from: "    if (rosterGuard.replace) {", to: "    if (true) {",
    mustFail: "an empty roster read keeps the roster" },
  { guard: "let the snapshot take rows from two different syncs", file: RULES, test: GUARD_TEST,
    from: "  if (distinct.length !== 1) {", to: "  if (false) {",
    mustFail: "the snapshot refuses mixed syncedAt (rows from two syncs)" },
  { guard: "drop the snapshot's 90% check", file: RULES, test: GUARD_TEST,
    from: "  if (prev > 0 && input.studentCount < 0.9 * prev) {", to: "  if (false) {",
    mustFail: "the snapshot keeps the old one below 90% of the last snapshot's students" },
  { guard: "copy a roster whose sync has not finished", file: "convex/reflection.ts", test: GUARD_TEST,
    from: "    const syncOk = !!rosterSyncedAt && runs.some(", to: "    const syncOk = true || runs.some(",
    mustFail: "a roster mid-rebuild (its sync has not finished) is never copied" },

  // ---- step 4: the reader, the tick, the lease and the freeze (spec 6, step 4 table)
  { guard: "delete the direct id confirmation (a mark missing from a read is removed outright)", file: SERVER, test: READER_TEST,
    from: "        const direct = directAnswer(m.psRowIds.map((id) => directById.get(id)).find(Boolean));",
    to: "        const direct = { status: \"none\" as const };",
    mustFail: "a delete during paging: no clear without the direct id read" },
  { guard: "key a tardy on psRowIds[0] instead of (student, date, period)", file: RULES, test: READER_TEST,
    from: "map((i) => [tardyKey(i.studentNumber, i.attDate, i.periodId), i]));",
    to: "map((i) => [i.psRowIds[0], i]));",
    mustFail: "a re-entered row: no double listing (one tardy, its new id, still on its detention)" },
  { guard: "no lease expiry (a lease is held until released)", file: RULES, test: READER_TEST,
    from: "  const leaseHeld = !!input.lease && Date.parse(input.lease.expiresAt) > now;",
    to: "  const leaseHeld = !!input.lease;",
    mustFail: "an expired lease is taken over: the 09:35 tick books a new read with a new runId" },
  { guard: "let an unconfirmed read through (it can then make the list)", file: SERVER, test: READER_TEST,
    from: "    if (!a.ok || !tz) {", to: "    if (!tz) {",
    mustFail: "a delete plus an insert mid-read (swapDuringRead): the read is not taken, and the arrival stays an arrival" },
  { guard: "skip countFromDate (every new tardy is admitted)", file: SERVER, test: READER_TEST,
    from: "        const admit = admitState(c.attDate, division, settings);", to: "        const admit = null;",
    mustFail: "before-start on switching on: an HS tardy dated before HS's countFromDate is stored, never listed" },
  { guard: "the fallback freeze does not take the lease", file: SERVER, test: READER_TEST,
    from: "      await writeState(ctx, LEASE_KEY, {\n        runId: `fallback_${Date.now().toString(36)}`, kind: \"fallback\", key: \"fallback\", date, startedAt: nowIso, expiresAt: nowIso,\n      } satisfies LeaseValue);\n",
    to: "",
    mustFail: "the fallback fences a straggling read: its write is refused" },
  { guard: "look back by calendar days, not school days", file: READER, test: READER_TEST,
    from: "        const dates = lookbackDates({ today: a.date, days: c.days, n: settings.lateEntryLists, notBefore });",
    to: "        const dates = Array.from({ length: settings.lateEntryLists }, (_, i) => shiftDay(a.date, -(i + 1))).reverse();",
    mustFail: "after a 10-day break, the first day's lookback re-reads the day before the break" },
  // Two more guards of this step that the spec's table does not list.
  { guard: "applyRead ignores the runId (no fence at all)", file: SERVER, test: READER_TEST,
    from: "    if (!lease || lease.runId !== a.runId) {", to: "    if (false) {",
    mustFail: "...and a stale runId write is refused, writing nothing" },
  { guard: "a re-entered mark whose tardy was cleared just follows the new id (never judged again)", file: SERVER, test: READER_TEST,
    from: "        if (byId.get(r.itemId)?.state !== \"cleared\") handled.add(r.itemId);", to: "        handled.add(r.itemId);",
    mustFail: "a tardy deleted (confirmed) and entered again later is judged afresh, never lost: off its released detention, for the next list" },
  { guard: "never treat marks as final at the after-school read", file: SERVER, test: READER_TEST,
    from: "      const final = d.date < today || a.kind === \"after-school\";", to: "      const final = d.date < today;",
    mustFail: "...a section that never took attendance is taken as present at 15:45: H2's hold is released, for the next list" },
];

// ------------------------------------------------------------------ the copy
// .md for docs/runbook.md, which the roster guard's test reads.
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

const scratch = mkdtempSync(join(process.env.REFLECTION_TEETH_DIR || tmpdir(), "reflection-teeth-"));
let bad = 0;
const say = (s) => console.log(s);
try {
  copyTree(ROOT, scratch);
  symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"), "dir");
  const run = (test) => spawnSync(process.execPath, [join(scratch, test)], { cwd: scratch, encoding: "utf8", timeout: 120_000 });
  const lines = (r) => String(r.stdout || "").split("\n");
  const has = (r, verdict, name) => lines(r).some((l) => l === `  ${verdict}  ${name}` || l.startsWith(`  ${verdict}  ${name}  (`));

  say("\nTHE UNBROKEN COPY: every named check passes\n");
  for (const test of [...new Set(CASES.map((c) => c.test))]) {
    const r = run(test);
    const missing = CASES.filter((c) => c.test === test && !has(r, "PASS", c.mustFail));
    if (r.status !== 0 || missing.length) {
      bad++;
      say(`  FAIL  ${test} unbroken: exit ${r.status}; checks not passing: ${missing.map((c) => JSON.stringify(c.mustFail)).join(", ") || "none"}`);
      if (r.stderr) say(String(r.stderr).slice(0, 800));
    } else {
      say(`  PASS  ${test} passes unbroken`);
    }
  }

  say("\nEACH GUARD BROKEN IN TURN: its check must fail\n");
  for (const c of CASES) {
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
      }
    } finally {
      writeFileSync(path, original);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${CASES.length - Math.min(bad, CASES.length)} of ${CASES.length} breaks caught${bad ? `; ${bad} problem(s)` : ""}\n`);
if (bad) process.exit(1);
