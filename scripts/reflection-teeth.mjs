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
const LIST = "convex/reflectionList.ts";
const PRINT_TEST = "reflection-print.test.mjs";
const VERIFY = "scripts/reflection-verify.mjs";
const VERIFY_TEST = "reflection-verify.test.mjs";
const UNIFORM = "convex/uniformViolations.ts";
const UNIFORM_TEST = "uniform-violations.test.mjs";
const ACCESS = "convex/accessRules.ts";
const ACCESS_TEST = "reflection-access.test.mjs";

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
    mustFail: "a tardy deleted (confirmed) after the room ran and entered again is back on its own detention, never served twice" },
  { guard: "never treat marks as final at the after-school read", file: SERVER, test: READER_TEST,
    from: "      const final = d.date < today || a.kind === \"after-school\";", to: "      const final = d.date < today;",
    mustFail: "...a section that never took attendance is taken as present at 15:45: H2's hold is released, for the next list" },

  // ---- step 7a: the list as staff see it and print it (spec 6, step 7a table, plus four more)
  { guard: "compare with the newest print of the day only, not the viewer's own", file: LIST, test: READER_TEST,
    from: "    const mine = await ctx.db.query(\"reflectionPrints\").withIndex(\"by_day_email\", (q) => q.eq(\"day\", date).eq(\"printedByEmail\", staff.email)).order(\"desc\").first();",
    to: "    const mine = await ctx.db.query(\"reflectionPrints\").withIndex(\"by_day\", (q) => q.eq(\"day\", date)).order(\"desc\").first();",
    mustFail: "each viewer sees their OWN changes, against their own print: PBIS (11:31) +L, release C and Z" },
  { guard: "add studentNumber to an appAuditLog insert", file: LIST, test: READER_TEST,
    from: "    return { ok: true as const, id, final, at: nowIso };",
    to: "    await ctx.db.insert(\"appAuditLog\", { action: \"Reflection Room print\", studentNumber: a.studentNumbers[0] } as any);\n"
      + "    return { ok: true as const, id, final, at: nowIso };",
    mustFail: "static: no appAuditLog insert from reflection code carries a student number, name or unit id" },
  { guard: "drop the access check on the list", file: LIST, test: READER_TEST,
    from: "    if (!canReadReflection(staff, today)) return { allowed: false as const, reason: REFUSED };",
    to: "    if (false) return { allowed: false as const, reason: REFUSED };",
    mustFail: "a teacher is refused, and nothing is read" },
  { guard: "let slips print before the list is final", file: LIST, test: READER_TEST,
    from: "    if (a.kind === \"slips\" && !final) {", to: "    if (false) {",
    mustFail: "slips are refused while the list is not final" },
  { guard: "tomorrow so far ignores what today's freeze will take", file: LIST, test: READER_TEST,
    from: "  if (f.first && f.first !== f.target) {", to: "  if (false) {",
    mustFail: "Tomorrow so far: tonight's P6 (S6), never a student about to serve today for the same thing" },
  { guard: "show the role-only banners to grant holders too", file: LIST, test: READER_TEST,
    from: "    if (roles) {\n      const items = await reviewItems(ctx, today, tz);", to: "    if (true) {\n      const items = await reviewItems(ctx, today, tz);",
    mustFail: "the roles see 'N waiting in review, oldest' on Today; a grant holder never does" },

  // ---- step 8a: the screen and the master print (spec 6, step 8a, plus two more)
  { guard: "print from the array on screen, without the fresh read", file: "script.js", test: PRINT_TEST,
    from: "                const res = await loadReflectionList();", to: "                const res = _rrData;",
    mustFail: "Print waits for a fresh read: the sheet is drawn from a new listForDay answer, never the list on screen" },
  { guard: "drop the NOT FINAL mark from a list not yet made", file: "script.js", test: PRINT_TEST,
    from: "                if (!final) marks.push('NOT FINAL: do not pull');", to: "",
    mustFail: "PILOT and NOT FINAL watermarks: a pilot list not yet final says both on every MS page, NOT FINAL on HS" },
  { guard: "read times off the Chromebook's own clock", file: "script.js", test: PRINT_TEST,
    from: "            return t.toLocaleTimeString('en-US', { timeZone: RR_TZ, hour: 'numeric', minute: '2-digit' });",
    to: "            return t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });",
    mustFail: "times use LA time, never this Chromebook's (the test runs in Tokyo)" },

  // ---- step 9: the independent verify script
  { guard: "the verify's own rule takes any earlier mark as presence (the literal rule)", file: VERIFY, test: VERIFY_TEST,
    from: "      const here = s === 1 ? ms.some((m) => !m.absent && m.code !== \"T\" && m.code !== \"D\") : ms.some((m) => !m.absent);",
    to: "      const here = true;",
    mustFail: "the verify's own rule: absent at Promise Time and P2, then T at P4, is an arrival" },
  { guard: "the verify accepts a single steady read (drops the same-ids check)", file: VERIFY, test: VERIFY_TEST,
    from: "      if (steady && previous && previous.length === ids.length && previous.every((id, k) => id === ids[k])) return r.rows;",
    to: "      if (steady) return r.rows;",
    mustFail: "a teacher saving mid-read (a delete plus an insert, counts unchanged): the verify's own read is refused" },
  { guard: "the snapshot hashes keys without the salt", file: VERIFY, test: VERIFY_TEST,
    from: "export const hashKey = (salt, key) => createHash(\"sha256\").update(`${salt}|${key}`).digest(\"hex\");",
    to: "export const hashKey = (salt, key) => createHash(\"sha256\").update(key).digest(\"hex\");",
    mustFail: "the snapshot holds salted hashes only: no student number, no plain hash of a key" },
  { guard: "a tardy left off the list is filed as entered late, never as dropped", file: VERIFY, test: VERIFY_TEST,
    from: "        else c.dropped++;", to: "        else c.enteredLate++;",
    mustFail: "a tardy counted at the close but left off the list is DROPPED BY THE READER" },

  // ---- step 5: the Uniform Tracker (spec 6, step 5 table)
  { guard: "restore the busy early return (a second Enter during a save is dropped)", file: "script.js", test: UNIFORM_TEST,
    from: "        function commitUniformViolation(withLoaner) {\n            const st = _uvPick;",
    to: "        function commitUniformViolation(withLoaner) {\n            if (_uvPumping) return;\n            const st = _uvPick;",
    mustFail: "a second Enter during a save is queued, not dropped: both are sent, in the order typed" },
  { guard: "drop unconfirmedUniform from the reload decision", file: "wildcat-update.js", test: "self-update.test.mjs",
    from: "    if (s.unconfirmedUniform) {", to: "    if (false) {",
    mustFail: "an unsaved uniform queue blocks the update reload even on a hidden tab past the busy deadline" },
  { guard: "trust the browser's day again (the old DAY_SLACK)", file: UNIFORM, test: UNIFORM_TEST,
    from: "    const day = when.day;", to: "    const day = (typeof args.day === \"string\" && args.day) || when.day;",
    mustFail: "a client day of tomorrow is ignored and counted" },
  { guard: "ignore observedAt (file every entry under the day it is sent)", file: UNIFORM, test: UNIFORM_TEST,
    from: "      observedAt: args.observedAt, nowIso, tz: await schoolZone(ctx), clientDay: args.day,",
    to: "      observedAt: undefined, nowIso, tz: await schoolZone(ctx), clientDay: args.day,",
    mustFail: "an item queued Tue 07:52 and sent Wed 08:10 is filed under Tue and does not block a Wed entry" },
  { guard: "a void after the list is made needs no reason", file: UNIFORM, test: UNIFORM_TEST,
    from: "    if (r.unitId && !why) {", to: "    if (false) {",
    mustFail: "a void after the list is made needs a reason" },

  // ---- step 6: the per-person grant with an end date (spec 6, step 6)
  { guard: "reuse canReadInsights for the list (an Attendance Watch grant opens it)", file: ACCESS, test: ACCESS_TEST,
    from: "  if (REFLECTION_ROLES.includes(String(row.role ?? \"\"))) return true;",
    to: "  if (canReadInsights(row as any)) return true;",
    mustFail: "attendanceWatch alone does not open the list (canReadInsights is not canReadReflection)" },
  { guard: "ignore the grant's end date", file: ACCESS, test: ACCESS_TEST,
    from: "  return /^\\d{4}-\\d{2}-\\d{2}$/.test(String(today)) && today <= until;",
    to: "  return true;",
    mustFail: "expired grant refused: the day after its last day it opens nothing" },
  { guard: "a role change keeps the list grant", file: "convex/roleChangeRules.ts", test: ACCESS_TEST,
    from: "  if (row && (row as any).reflectionList && norm(row.role) !== norm(newRole)) {",
    to: "  if (false) {",
    mustFail: "the grant is cleared on a role change, end date and all" },

  // ---- step 7b: the admin review screen
  { guard: "let anyone who can read the list resolve review items", file: "convex/reflectionRoom.ts", test: READER_TEST,
    from: "    if (!canAdminReflection(staff)) return { ok: false as const, reason: ADMIN_REFUSED };\n    const now = new Date().toISOString();\n    const why",
    to: "    if (false) return { ok: false as const, reason: ADMIN_REFUSED };\n    const now = new Date().toISOString();\n    const why",
    mustFail: "a resolve by a grant holder is refused, and changes nothing" },
  { guard: "the reader sends a resolved collision back to review", file: SERVER, test: READER_TEST,
    from: " && !existing.resolvedAt) {", to: ") {",
    mustFail: "the reader respects the decision: the resolved collision is not sent back to review" },

  // ---- step 8b: room attendance, slips, print safety, the admin buttons
  { guard: "let the room tick Not here after the next list has claimed the carries", file: RULES, test: READER_TEST,
    from: "  if (input.nextListMadeAt) {", to: "  if (false) {",
    mustFail: "a tick after the next freeze is refused: the next list has claimed the carries" },
  { guard: "count a 'room did not run' carry toward the carry limit", file: RULES, test: READER_TEST,
    from: "tag: `Carried over from ${from} (room closed)`, countsTowardLimit: false", to: "tag: `Carried over from ${from} (room closed)`, countsTowardLimit: true",
    mustFail: "Room did not run carries everything with no carryCount increase" },
  { guard: "Read PowerSchool now ignores the lease (two readers at once)", file: "convex/reflectionRoom.ts", test: READER_TEST,
    from: "    if (lease && Date.parse(lease.expiresAt) > now) {", to: "    if (false) {",
    mustFail: "...a second press while that read holds the lease is refused (never two readers)" },
  { guard: "enable the slips button before the list is final", file: "script.js", test: PRINT_TEST,
    from: "if (slips) slips.disabled = !listView || !res || res.frozen !== true || !liveRows.length || _rrPrinting;",
    to: "if (slips) slips.disabled = !listView || !res || !liveRows.length || _rrPrinting;",
    mustFail: "slips are disabled while the list is not final: the button is off, and pressing it prints and records nothing" },
  { guard: "print slips from a list that is not final", file: "script.js", test: PRINT_TEST,
    from: "                if (answer.frozen !== true) {", to: "                if (false) {",
    mustFail: "slips are disabled while the list is not final: the button is off, and pressing it prints and records nothing" },
  { guard: "stop intercepting Ctrl+P on the list", file: "script.js", test: PRINT_TEST,
    from: "        document.addEventListener('keydown', reflectionPrintKeys, true);\n", to: "",
    mustFail: "Ctrl+P is intercepted on this screen: it goes through the Print button's fresh read and recorded print" },
  { guard: "drop the STALE mark from a menu print of an old answer", file: "script.js", test: PRINT_TEST,
    from: "                if (o.stale) marks.push('STALE: as of ' + o.stale + '. Use the Print button');", to: "",
    mustFail: "the STALE banner: an answer over 60 s old says 'STALE: as of 11:46:10 AM. Use the Print button' on every page" },

  // ---- the review of 2026-10-08: each fix's guard, broken back to what it was
  { guard: "the freeze no longer asks, as it claims, whether an item is from before the start (mode and date)", file: RULES, test: RULES_TEST,
    from: "  if (item.mode && item.mode !== mode) return true;", to: "  return false;",
    mustFail: "at the moment of claiming: a tardy or uniform entry dated before countFromDate, a pilot carry, and a carry from before the start are parked, never listed" },
  { guard: "a pilot detention's carry decided after going live waits as an ordinary pending carry", file: SERVER, test: READER_TEST,
    from: "      const otherMode = u.mode !== c.settings.modeByDivision[u.division];", to: "      const otherMode = false;",
    mustFail: "a Friday pilot detention whose carry is decided on Monday, once MS is live, carries as before-start, never pending" },
  { guard: "a tardy re-judged into counting skips the countFromDate check", file: SERVER, test: READER_TEST,
    from: "          if (rides === \"none\" && (r.state === \"countable\" || r.state === \"held\")\n            && admitState(",
    to: "          if (false\n            && admitState(",
    mustFail: "a Friday arrival that Monday's re-read of Friday counts is before-start, never countable" },
  { guard: "an item logged or first seen while its division is off is stamped before-start for good", file: RULES, test: READER_TEST,
    from: "  if (settings.modeByDivision[division] === \"off\") return null;",
    to: "  if (settings.modeByDivision[division] === \"off\") return \"before-start\";",
    mustFail: "a uniform entry logged while its division was off, on the day it starts counting, is on that day's first list with the day's tardies" },
  { guard: "a uniform entry dated before countFromDate is stored as if it counted", file: UNIFORM, test: READER_TEST,
    from: "      ...(beforeStart ? { reflectionState: beforeStart } : {}),\n", to: "",
    mustFail: "a queued Friday uniform entry that reaches the server on Monday, once MS counts from Monday, is stored before-start" },
  { guard: "a tardy back after the room ran never rejoins its released detention (served twice)", file: RULES, test: READER_TEST,
    from: "  return Date.parse(input.releasedAt) >= Date.parse(input.pullAt);", to: "  return false;",
    mustFail: "a tardy deleted (confirmed) after the room ran and entered again is back on its own detention, never served twice" },
  { guard: "a tardy back always rejoins its released detention, even one released before the pull", file: RULES, test: READER_TEST,
    from: "  if (!input.releasedAt || !input.pullAt) return false;\n  return Date.parse(input.releasedAt) >= Date.parse(input.pullAt);",
    to: "  return true;",
    mustFail: "a mark deleted BEFORE the room ran and typed back is still owed: off its released detention, for the next list" },
  { guard: "the fallback waits for any lease, a manual after-close read's too", file: RULES, test: RULES_TEST,
    from: "if (leaseHeld && closingLease(input.lease)) return waitOr(t.lastFreezeMs, \"Fallback freeze\");",
    to: "if (leaseHeld) return waitOr(t.lastFreezeMs, \"Fallback freeze\");",
    mustFail: "the fallback does not wait for a manual after-close read: a Wednesday still gets its list at 11:30" },
  { guard: "yesterday's carries are decided only after today's list is made", file: SERVER, test: READER_TEST,
    from: "      if (!d.full || d.date >= today) continue;\n      await decideFor(d);", to: "      continue;\n      await decideFor(d);",
    mustFail: "the closing read decides yesterday's carry BEFORE it makes the list: K's carry is withdrawn, and K is not listed" },
  { guard: "a second mark for a tardy already on a list sends it to review", file: SERVER, test: READER_TEST,
    from: "          if (existing.state === \"countable\" && onList && onList.state !== \"released\" && onList.state !== \"expired\") {",
    to: "          if (false) {",
    mustFail: "a second PowerSchool mark for a tardy already on a list leaves it on its detention: not sent to review, never on a second list" },
  { guard: "Add to next list takes a tardy off the detention it stands on", file: "convex/reflectionRoom.ts", test: READER_TEST,
    from: "...(keep ? {} : { unitId: undefined })", to: "unitId: undefined",
    mustFail: "Add to next list on a tardy already on a standing detention keeps it there" },
  { guard: "a grant holder is shown why a detention is in review and the admin's reason", file: LIST, test: ACCESS_TEST,
    from: "      after = !roles\n", to: "      after = false\n",
    mustFail: "a grant holder's list never carries the reason an admin typed, or why it was in review" },
  { guard: "a detention dismissed in review stays on the list as a live row", file: LIST, test: ACCESS_TEST,
    from: "      : dismissed ? { at: u.resolvedAt ?? null, reason: DISMISSED_RELEASE }", to: "      : false ? { at: u.resolvedAt ?? null, reason: DISMISSED_RELEASE }",
    mustFail: "...and a dismissed detention is off the list like a released one: not counted, no Not here box" },
  { guard: "a void's own reason becomes the release reason every viewer sees", file: SERVER, test: ACCESS_TEST,
    from: "?? (voided ? UNIFORM_VOID_RELEASE : \"every violation was cleared\");",
    to: "?? (voided ? `uniform entry removed (${voided.voidReason})` : \"every violation was cleared\");",
    mustFail: "a uniform entry voided after the list was made: the release a grant holder sees and prints says only what happened" },
  { guard: "the last-read banner turns red after a flat 15 minutes, whatever the schedule", file: RULES, test: READER_TEST,
    from: "  const overdue = !!dueAt && (!last || Date.parse(last) < Date.parse(dueAt));",
    to: "  const overdue = !last || Date.parse(input.nowIso) - Date.parse(last) > READ_OVERDUE_MIN * 60000;",
    mustFail: "on a healthy day the last-read banner is never red between scheduled reads (08:00 to 14:30, all of lunch)" },
  { guard: "the roles' print list judges a print by its change counts alone", file: LIST, test: READER_TEST,
    from: "          beforeFreeze, outOfDate: changeCount(c) > 0 || beforeFreeze,", to: "          beforeFreeze: false, outOfDate: changeCount(c) > 0,",
    mustFail: "...each print says whether it predates the list and is out of date, as its holder is told" },
  { guard: "the roles' panel calls a print from before the list 'still current'", file: "script.js", test: PRINT_TEST,
    from: "const state = [p.beforeFreeze && res.frozenAt ?", to: "const state = [false ?",
    mustFail: "the roles' panel says a print from before the list was made is out of date, not 'still current'" },
  { guard: "a menu print with the list sheet left open prints that old sheet as it stands", file: "script.js", test: PRINT_TEST,
    from: "            const stale = Date.now() - _rrLoadedAt > RR_STALE_MS ? rrClockSeconds(_rrData.asOf) : null;\n            openReflectionSheet(",
    to: "            if (document.getElementById('wcPrintSheet')) return;\n            const stale = Date.now() - _rrLoadedAt > RR_STALE_MS ? rrClockSeconds(_rrData.asOf) : null;\n            openReflectionSheet(",
    mustFail: "a sheet left open after a print is drawn again for a menu print: the list on screen, STALE on every page, printing as a sheet" },
  { guard: "Logout's uniform message hides a save still being sent", file: "script.js", test: UNIFORM_TEST,
    from: "                    : sending ? { words: 'changes this tab is still sending to the server', the: 'the changes', many: true } : null;",
    to: "                    : null;",
    mustFail: "a save still being sent is named as lost even when a uniform entry waits on this device" },
  { guard: "a tab writes only its own uniform queue over the shared copy", file: "script.js", test: UNIFORM_TEST,
    from: "                    if (!q || typeof q.attemptId !== 'string' || !q.attemptId || mine.has(q.attemptId) || q.attemptId === landed) return;",
    to: "                    return;",
    mustFail: "two tabs of one person: the other tab's sends never erase an entry only this tab holds, so it waits on this device as Logout says" },
  { guard: "a uniform entry seen to land stays in the device's copy", file: "script.js", test: UNIFORM_TEST,
    from: "                    storeUniformQueue(item.attemptId);\n", to: "                    storeUniformQueue();\n",
    mustFail: "...while the entries the other tab saw land are dropped from this device's copy" },
  { guard: "sign-out forgets the uniform queue without writing it once more", file: "script.js", test: UNIFORM_TEST,
    from: "            storeUniformQueue();\n            _uvPumpGen++;", to: "            _uvPumpGen++;",
    mustFail: "...and Logout writes this tab's queue once more as it leaves, whatever another tab removed meanwhile" },
  { guard: "Logout's message stops at a referral and hides uniform entries", file: "script.js", test: UNIFORM_TEST,
    from: "                const u = typeof uniformQueueLength === 'function' ? uniformQueueLength() : 0;",
    to: "                const u = n ? 0 : (typeof uniformQueueLength === 'function' ? uniformQueueLength() : 0);",
    mustFail: "a referral and uniform entries this device could not keep are both named as lost" },
  { guard: "a send that returns after a sign-out and sign-in leaves the resumed queue unsent", file: "script.js", test: UNIFORM_TEST,
    from: "                if (gen !== _uvPumpGen && _uvQueue.length && !_uvPumpTimer) armUniformPump(0);\n", to: "",
    mustFail: "a sign-out and sign-in while a send is out: the resumed queue is sent once that send returns, never stalled" },
  { guard: "the roster guard measures a doubled roster as a whole one", file: "convex/sisAction.ts", test: GUARD_TEST,
    from: "rosterReplaceVerdict({ incomingRows: rosterRows.length, currentRows: rosterRowsCurrent });",
    to: "rosterReplaceVerdict({ incomingRows: rosterRows.length, currentRows: rosterRowsBefore });",
    mustFail: "a roster doubled by two overlapping syncs is replaced by the next believable read, not kept for good" },
  { guard: "'entered late' is judged by when a tardy was first SEEN", file: RULES, test: READER_TEST,
    from: "    } else if (own.closingReadStartedAt && countsSince(t) > Date.parse(own.closingReadStartedAt)) {",
    to: "    } else if (own.closingReadStartedAt && Date.parse(t.firstSeenAt) > Date.parse(own.closingReadStartedAt)) {",
    mustFail: "an arrival re-judged as counted after its list was made lands on the next list tagged 'Entered late in PowerSchool'" },
  { guard: "a cleared tardy counting again keeps its first firstCountableAt", file: SERVER, test: READER_TEST,
    from: "firstCountableAt: state === \"countable\" ? a.startedAt : t.firstCountableAt,",
    to: "firstCountableAt: state === \"countable\" ? (t.firstCountableAt ?? a.startedAt) : t.firstCountableAt,",
    mustFail: "a T changed to D before the close and back to T after it is tagged the same way" },
  { guard: "a re-classified tardy counting again keeps its first firstCountableAt", file: SERVER, test: READER_TEST,
    from: "          if (r.state === \"countable\") next.firstCountableAt = a.startedAt;",
    to: "          if (r.state === \"countable\" && !t.firstCountableAt) next.firstCountableAt = a.startedAt;",
    mustFail: "...and so is a tardy counted, re-judged an arrival before the close, and counted again after it" },
  { guard: "the room's presses decide a shadow division's carries too", file: SERVER, test: READER_TEST,
    from: "      room: roomRuns ? { closed: !!dRow.roomClosed, attendanceDone: !!dRow.roomAttendanceDoneAt, notHere: !!u.roomNotHere } : {},",
    to: "      room: { closed: !!dRow.roomClosed, attendanceDone: !!dRow.roomAttendanceDoneAt, notHere: !!u.roomNotHere },",
    mustFail: "Attendance done for the MS room, nobody ticked: H-ABS (HS, in shadow) still carries, decided by PowerSchool" },
  { guard: "the day's 'room attendance not recorded' counts shadow detentions", file: SERVER, test: READER_TEST,
    from: "    if (roomRuns && (verdict.verdict === \"carry\" || verdict.verdict === \"served\")", to: "    if ((verdict.verdict === \"carry\" || verdict.verdict === \"served\")",
    mustFail: "...and the day's review counts only the LIVE detentions PowerSchool decided (1, not 3)" },
  { guard: "the room's Not here count takes shadow rows", file: LIST, test: READER_TEST,
    from: "notHere: rows.filter((r) => r.notHere && r.state !== \"released\" && r.mode === \"live\").length,",
    to: "notHere: rows.filter((r) => r.notHere && r.state !== \"released\").length,",
    mustFail: "the room's Not here count takes only the live division's rows; HS rows come marked shadow, so the screen draws no box on them" },
  { guard: "the screen draws a Not here box on a shadow division's rows", file: "script.js", test: PRINT_TEST,
    from: "                    if (!r.unitId || r.released || r.mode !== 'live') return '<td></td>';",
    to: "                    if (!r.unitId || r.released) return '<td></td>';",
    mustFail: "...and no box on a row of a division in shadow (the pilot), whose carries PowerSchool decides" },
  { guard: "a cleared tardy typed back as an arrival (or held) drops its detention", file: SERVER, test: READER_TEST,
    from: "            const rides = state === \"countable\" ? await rejoinDetention(ctx, t.unitId, settings, tz) : t.unitId ? \"kept\" : \"none\";",
    to: "            const rides = state === \"countable\" ? await rejoinDetention(ctx, t.unitId, settings, tz) : \"none\";",
    mustFail: "an arrival round trip never puts one tardy on two lists: Wednesday's list does not hold P" },
  { guard: "the roster guard measures the NEWEST syncedAt's rows (a small test group written after the sync)", file: "convex/sisAction.ts", test: GUARD_TEST,
    from: "    const rosterRowsCurrent = Math.max(0, ...rowsBySync.values());",
    to: "    const newestSync = [...rowsBySync.keys()].sort().pop();\n    const rosterRowsCurrent = newestSync ? rowsBySync.get(newestSync)! : 0;",
    mustFail: "a test roster seeded after the last sync never becomes the roster the guard measures: a 30% read keeps the real one" },
  { guard: "Edit Teacher drops a cleared last day", file: "script.js", test: ACCESS_TEST,
    from: "            if (had && until === (teacher.reflectionListUntil || '')) return null;",
    to: "            if (had && (!until || until === (teacher.reflectionListUntil || ''))) return null;",
    mustFail: "Edit Teacher: clearing the last day of a grant is sent as 'until the end of this term', never silently dropped" },

  // ---- the third review (2026-10-08): round-2 regressions and the weeks simulation
  { guard: "the verify calls any arrival that still has a detention 'listed'", file: VERIFY, test: VERIFY_TEST,
    from: "        const listable = sys && (sys.state === \"countable\" || sys.state === \"held\" || sys.state === \"review\");",
    to: "        const listable = sys && (sys.unitId || sys.state === \"countable\" || sys.state === \"held\" || sys.state === \"review\");",
    mustFail: "an arrival the system also calls an arrival, still holding the detention it was listed on, is corrected after the list was made: never an 'arrival tardy listed' or a disagreement" },
  { guard: "the verify skips its PowerSchool carry control on any day a room pressed Attendance done", file: VERIFY, test: VERIFY_TEST,
    from: "  const d = days[day];\n  if (d) {", to: "  const d = days[day];\n  if (d && !row.roomAttendanceDone && !row.roomClosed) {",
    mustFail: "a PowerSchool carry of a student in class before and after Power-Up is a control on a day the OTHER division's room pressed Attendance done" },
  { guard: "the Held tag goes back to 'was ever held, counts since the list'", file: RULES, test: READER_TEST,
    from: "    } else if (own.frozenAt && t.heldReleasedAt && Date.parse(t.heldReleasedAt) > Date.parse(own.frozenAt)) {",
    to: "    } else if (t.wasHeld && own.frozenAt && t.firstCountableAt && Date.parse(t.firstCountableAt) > Date.parse(own.frozenAt)) {",
    mustFail: "...and one once HELD, whose hold was released before the list: Entered late, never 'Held for attendance'" },
  { guard: "a fallback day's tag looks only at when a tardy was first seen", file: RULES, test: READER_TEST,
    from: "    } else if (fallbackAt !== null && countsSince(t) > fallbackAt) {", to: "    } else if (false) {",
    mustFail: "...and so is an arrival re-judged as counted after it: seen before the list, counting only after it" },
  { guard: "the verify has no list cut on a fallback day (everything found after it is 'dropped')", file: VERIFY, test: READER_TEST,
    from: "  const listCut = closeStart ?? (row.freezeKind === \"fallback\" && row.frozenAt ? Date.parse(row.frozenAt) : null);",
    to: "  const listCut = closeStart;",
    mustFail: "the verify on a fallback day: both, counting only after the list was made, are entered late, never dropped by the reader" },
  { guard: "the other division's freeze parks an off division's waiting items for good", file: RULES, test: READER_TEST,
    from: "  if (mode === \"off\") return false;", to: "  if (mode === \"off\") return true;",
    mustFail: "HS off: MS's list is made, and leaves HS's tardy and uniform entry waiting, neither listed nor stamped before-start" },
  { guard: "the verify calls an off division's waiting tardy 'dropped by the reader'", file: VERIFY, test: READER_TEST,
    from: "        else if (row.noList || !row.frozenAt || row.modeByDivision?.[sys.division] === \"off\") c.noList++;",
    to: "        else if (row.noList || !row.frozenAt) c.noList++;",
    mustFail: "...and the verify: an off division's waiting tardy is 'no list was made' for it, never dropped by the reader" },
  { guard: "an off division's waiting tardies keep their dates open for full re-reads", file: SERVER, test: READER_TEST,
    from: "    const counts = (t: Doc<\"reflectionTardies\">) => !t.division || settings.modeByDivision[t.division] !== \"off\";",
    to: "    const counts = (t: Doc<\"reflectionTardies\">) => true;",
    mustFail: "...and Monday's HS tardy, waiting while HS is off, costs no full re-read of Monday at Tuesday's reads" },
  { guard: "owes 2 serves whichever detention was recorded first, not the oldest", file: RULES, test: RULES_TEST,
    from: "    const units = got.units.slice().sort((a, b) => age(a).localeCompare(age(b)) || a.recordedAt.localeCompare(b.recordedAt));",
    to: "    const units = got.units.slice().sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));",
    mustFail: "owes 2 with a carry and a queued detention: the carry, standing for the older detention, is served first" },
  { guard: "re-deciding a waiting carry drops its 'Queued: 2nd detention' tag", file: SERVER, test: READER_TEST,
    from: "          tags: [...(fresh.tags ?? []), ...(carry!.tags.includes(QUEUED_TAG) ? [QUEUED_TAG] : [])],",
    to: "          tags: fresh.tags ?? [],",
    mustFail: "...and Tuesday's, waiting, keeps 'Queued: 2nd detention' through Wednesday's afternoon re-reads" },
];

// A builder's shortcut, never set in npm test: REFLECTION_TEETH_ONLY=<text>
// runs only the cases whose test file or guard contains that text.
const ONLY = process.env.REFLECTION_TEETH_ONLY || "";
const RUN = ONLY ? CASES.filter((c) => c.test.includes(ONLY) || c.guard.includes(ONLY)) : CASES;

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
