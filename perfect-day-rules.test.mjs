// The automatic perfect-day award's RULES, run for real. Run: npm test
//
// perfectDayRules.ts decides everything the job does: what breaks a day, what
// a switch change means, when a day is held, what the register does with a
// judged date, who is paid on payday and how. Each rule is run here against
// cases written from the owner's decisions (2026-10-12) and the review
// (crit.md H1-H3, M1-M3, L2), not from the code.
//
// THE MIRROR. The money and the Perfect Attendance screen must not drift
// apart. The last section runs the SHIPPED attendance rebuild (against the
// fake PowerSchool) and the SHIPPED wildcat-roster.js perfectVerdict over the
// same rows as the award's own verdict, for every code the school has, and
// requires them to agree on every student-day except the one known
// difference: Ditching (K) is coded Present, so the screen counts it present
// and the award does not. (And a code nobody has seen breaks the award's day.)
//
// TEETH: scripts/perfect-day-teeth.mjs breaks one guard at a time and
// requires the check named for it to FAIL, so the names below are load-bearing.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { loadConvex } from "./fake-convex.mjs";
import { fakePowerSchool } from "./fake-powerschool.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const J = (x) => JSON.stringify(x);

const loaded = await loadConvex(new URL("./", import.meta.url), ["perfectDayRules", "appDataShape", "cashAwardRules", "cashReversalRules"]);
try {
const R = loaded.mods.perfectDayRules;
const SHAPE = loaded.mods.appDataShape;
const AWARD = loaded.mods.cashAwardRules;
const REV = loaded.mods.cashReversalRules;
const TZ = "America/Los_Angeles";

// ---------------------------------------------------------------- codes
console.log("\nWHAT BREAKS A DAY (rule A, the owner 10/12)\n");
const info = (code, absent = false) => ({ code, absent, description: code });
const V = (marks, o = {}) => R.studentDayVerdict({ enrolled: true, hasClass: true, marks, ...o });
{
  check("a day with no mark at all is perfect", V([]).perfect === true);
  check("Present (a blank code), D and F do not break the day",
    ["", "D", "F"].every((c) => V([{ slot: 3, info: info(c) }]).perfect));
  check("A, X, I, P, T and K each break the day",
    ["A", "X", "I", "P", "T", "K"].every((c) => !V([{ slot: 3, info: info(c, "AXIP".includes(c)) }]).perfect));
  check("an excused absence (X) breaks it: excused absences are not forgiven", !V([{ slot: 2, info: info("X", true) }]).perfect);
  check("a Promise Time AM tardy alone breaks it, and is counted as late to school",
    (() => { const v = V([{ slot: 1, info: info("T") }]); return !v.perfect && v.ptAmOnly; })());
  check("a Promise Time PM mark and a Power-Up mark break it too (every block counts)",
    !V([{ slot: 10, info: info("A", true) }]).perfect && !V([{ slot: 8, info: info("T") }]).perfect);
  check("K (Ditching) breaks it, and is told apart as the screen's known difference",
    (() => { const v = V([{ slot: 4, info: info("K") }]); return !v.perfect && v.kOnly && v.why === "ditching"; })());
  check("a code the office adds later breaks it (the rule lists what does NOT break)",
    (() => { const v = V([{ slot: 4, info: info("Z") }]); return !v.perfect && v.why === "unknown-code" && J(v.unknownCodes) === '["Z"]'; })());
  check("a code id the code book does not know at all breaks it", !V([{ slot: 4, info: undefined }]).perfect);
  check("a D and a T on one day: the T still breaks it", !V([{ slot: 2, info: info("D") }, { slot: 3, info: info("T") }]).perfect);
  check("not enrolled on the day: not perfect", R.studentDayVerdict({ enrolled: false, hasClass: true, marks: [] }).why === "not-enrolled");
  check("no class that met: not perfect (a guard; 0 cases measured)", R.studentDayVerdict({ enrolled: true, hasClass: false, marks: [] }).why === "no-class");
  check("the code book is read, never typed in: an empty book is refused", R.codeBookOf([]).ok === false);
  check("breaksDay of an unknown id is true", R.breaksDay(undefined) === true);
}

// ---------------------------------------------------------------- the switch
console.log("\nTHE SWITCH: NO BACK-PAY, EVER (review H2)\n");
{
  const OFF = R.settingsOrDefault(null);
  check("a missing settings row is OFF", OFF.mode === "off" && OFF.amount === 100);
  check("a stored amount that is not a whole number from 1 to 1000 reads as OFF",
    R.settingsOrDefault({ mode: "live", amount: 2.5, countFromDate: "2026-10-19" }).mode === "off"
    && R.settingsOrDefault({ mode: "live", amount: 0, countFromDate: "2026-10-19" }).mode === "off"
    && R.settingsOrDefault({ mode: "live", amount: 5000, countFromDate: "2026-10-19" }).mode === "off");
  check("switched on with no start date reads as OFF", R.settingsOrDefault({ mode: "live", amount: 100 }).mode === "off");

  const on = R.planConfigure(OFF, { mode: "shadow" }, "2026-10-19");
  check("switching on counts from the day of the switch", on.ok && on.next.countFromDate === "2026-10-19" && on.next.mode === "shadow");
  const early = R.planConfigure(OFF, { mode: "live", countFromDate: "2026-09-14" }, "2026-10-19");
  check("switching on from an earlier date is refused without backPay", early.ok === false && /backPay/.test(early.reason));
  const back = R.planConfigure(OFF, { mode: "live", countFromDate: "2026-10-12", backPay: true }, "2026-10-19");
  check("...and allowed only with backPay: true, saying so", back.ok && back.next.countFromDate === "2026-10-12" && back.next.liveFrom === "2026-10-12");

  const live = R.planConfigure(OFF, { mode: "live" }, "2026-10-19").next;
  const paused = R.planConfigure(live, { mode: "off" }, "2026-10-21").next;
  const resumed = R.planConfigure(paused, { mode: "live" }, "2026-10-26");
  check("off then on again counts from the day it came back on", resumed.ok && resumed.next.countFromDate === "2026-10-26" && resumed.next.liveFrom === "2026-10-26");
  check("...so a day not yet decided when it was paused is never decided as payable after it",
    R.scopeOf(resumed.next, "30001", "2026-10-20").payable === false && R.scopeOf(resumed.next, "30001", "2026-10-20").why === "before-start");
  check("BUT A DAY STAMPED PAYABLE BEFORE THE PAUSE STILL IS: it waits while off and is paid once on again",
    R.payNowWhy(paused, "30001", { payable: true }) === "off" && R.payNowWhy(resumed.next, "30001", { payable: true }) === null
    && R.payNowWhy(resumed.next, "30001", { payable: false }) === "unpayable");

  const shadow = R.planConfigure(OFF, { mode: "shadow", pilotAdd: ["30001"] }, "2026-10-12").next;
  check("in shadow nothing is payable", R.scopeOf(shadow, "30001", "2026-10-13").payable === false && R.scopeOf(shadow, "30001", "2026-10-13").why === "shadow");
  const pilot = R.planConfigure(shadow, { mode: "pilot", pilotAdd: ["30002"], controls: ["30004"] }, "2026-10-19");
  check("shadow to pilot: money starts with days from the switch, for every pilot student",
    pilot.ok && pilot.next.pilot.every((e) => e.from === "2026-10-19") && pilot.next.countFromDate === "2026-10-12");
  check("...a shadow-era day of a pilot student is not payable", R.scopeOf(pilot.next, "30001", "2026-10-16").why === "before-start");
  check("...a student outside the pilot is not payable", R.scopeOf(pilot.next, "30009", "2026-10-20").why === "outside-pilot");
  check("...a control is never payable", R.scopeOf(pilot.next, "30004", "2026-10-20").why === "control");
  const widePlan = R.planConfigure(pilot.next, { mode: "live" }, "2026-10-26");
  const wide = widePlan.next;
  check("pilot to live: the rest of the school from the switch day only",
    wide.liveFrom === "2026-10-26" && R.scopeOf(wide, "30009", "2026-10-23").payable === false && R.scopeOf(wide, "30009", "2026-10-26").payable === true);
  check("...the pilot students keep their own start", R.scopeOf(wide, "30001", "2026-10-20").payable === true);
  check("pilot to live clears the controls, and says so",
    widePlan.ok && J(wide.controls) === "[]" && widePlan.notes.some((n) => /control is cleared/.test(n)), J(widePlan));
  check("...so a former control is paid from the switch day like everyone else, and never for a day before it",
    R.scopeOf(wide, "30004", "2026-10-26").payable === true && R.scopeOf(wide, "30004", "2026-10-23").why === "before-start");
  check("naming controls while live is refused; an empty list is fine",
    R.planConfigure(wide, { controls: ["30004"] }, "2026-10-27").ok === false
    && R.planConfigure(pilot.next, { mode: "live", controls: ["30004"] }, "2026-10-26").ok === false
    && R.planConfigure(pilot.next, { mode: "live", controls: [] }, "2026-10-26").ok === true);
  const back2pilot = R.planConfigure(wide, { mode: "pilot" }, "2026-10-28").next;
  check("live back to pilot: nobody outside the pilot is payable", back2pilot.liveFrom === null && R.scopeOf(back2pilot, "30009", "2026-10-27").payable === false);
  check("...but a day they earned while live, stamped payable, is still paid (no switch takes back what was earned)",
    R.payNowWhy(back2pilot, "30009", { payable: true }) === null);
  check("a pilot with nobody in it is refused", R.planConfigure(OFF, { mode: "pilot" }, "2026-10-19").ok === false);
  check("a control cannot be a pilot student", R.planConfigure(OFF, { mode: "pilot", pilotAdd: ["1"], controls: ["1"] }, "2026-10-19").ok === false);
  check("the amount must be a whole number from 1 to 1000",
    [0, -5, 1001, 2.5, NaN].every((a) => R.planConfigure(OFF, { amount: a }, "2026-10-19").ok === false)
    && R.planConfigure(OFF, { amount: 150 }, "2026-10-19").ok);
  check("switching on over a stored amount that is not valid is refused until an amount is given",
    R.planConfigure(R.settingsOrDefault({ mode: "off", amount: 9999 }), { mode: "live" }, "2026-10-19").ok === false
    && R.planConfigure(R.settingsOrDefault({ mode: "off", amount: 9999 }), { mode: "live", amount: 100 }, "2026-10-19").ok === true);
  check("moving the start back while on is back-pay too", R.planConfigure(live, { countFromDate: "2026-10-05" }, "2026-10-21").ok === false);
}

// ---------------------------------------------------------------- the tick
console.log("\nTHE TICK, BY THE SCHOOL'S WALL CLOCK\n");
{
  const T = (iso, o = {}) => R.decideTick({ mode: "live", nowIso: iso, tz: TZ, lastDoneDate: null, lease: null, ...o });
  check("14:42Z on Fri 10/30 is 07:42 PDT: run, for that date", (() => { const d = T("2026-10-30T14:42:00Z"); return d.do === "run" && d.today === "2026-10-30" && d.minute === 7 * 60 + 42; })());
  check("DST: 14:42Z on Mon 11/2 is 06:42 PST: run, for 11/2", (() => { const d = T("2026-11-02T14:42:00Z"); return d.do === "run" && d.today === "2026-11-02" && d.minute === 6 * 60 + 42; })());
  check("DST: 17:42Z on Mon 11/2 is 09:42 PST: still the morning", T("2026-11-02T17:42:00Z").do === "run");
  check("never at 11:15 school time or later (the Reflection Room's cutoff)", T("2026-10-30T18:15:00Z").do === "none" && T("2026-11-02T19:15:00Z").do === "none");
  check("not before 06:30 school time", T("2026-11-02T14:20:00Z").do === "none");
  check("never on a weekend", T("2026-10-31T15:42:00Z").do === "none");
  check("not again once today's run is done", T("2026-10-30T15:42:00Z", { lastDoneDate: "2026-10-30" }).do === "none");
  check("not while another run holds the lease", T("2026-10-30T15:42:00Z", { lease: { runId: "x", startedAt: "", expiresAt: "2026-10-30T15:50:00Z" } }).do === "none");
  check("...but a lapsed lease does not block", T("2026-10-30T15:42:00Z", { lease: { runId: "x", startedAt: "", expiresAt: "2026-10-30T15:00:00Z" } }).do === "run");
  check("switched off: nothing", T("2026-10-30T14:42:00Z", { mode: "off" }).do === "none");
  check("no time zone set: nothing", T("2026-10-30T14:42:00Z", { tz: null }).do === "none");
}

// ---------------------------------------------------------------- the calendar
console.log("\nTHE CALENDAR: A HOLIDAY IS NOT A FAILED READ (review H3)\n");
{
  const cal = R.calendarCandidates({ today: "2026-10-26", reachDays: 10,
    marks: { "2026-10-21": { noSchool: true, scheduled: false }, "2026-10-24": { noSchool: false, scheduled: true } }, adminNoSchool: ["2026-10-20"] });
  check("a date marked no school is no school, and not read", cal.noSchool.some((n) => n.date === "2026-10-21") && !cal.candidates.includes("2026-10-21"));
  check("a date an admin marked no school is no school", cal.noSchool.some((n) => n.date === "2026-10-20"));
  check("an unmarked weekend is never read; a Saturday marked with a schedule is",
    !cal.candidates.includes("2026-10-25") && cal.candidates.includes("2026-10-24"));
  const w = R.windowOf({ candidates: ["2026-10-23", "2026-10-22", "2026-10-19", "2026-10-16", "2026-10-15"],
    counts: { "2026-10-23": 300, "2026-10-22": 0, "2026-10-19": 280, "2026-10-16": 290, "2026-10-15": 310 }, lookback: 3 });
  check("the window is the last N dates with any attendance, oldest first", J(w.window) === J(["2026-10-16", "2026-10-19", "2026-10-23"]));
  check("a weekday with no attendance inside the window is a no-school date", J(w.zero) === J(["2026-10-22"]));
}

// ---------------------------------------------------------------- one day judged
console.log("\nONE DAY, JUDGED\n");
const CODEBOOK = R.codeBookOf([
  { id: 1, att_code: "A", presence_status_cd: "Absent" }, { id: 2, att_code: "T", presence_status_cd: "Present" },
  { id: 3, att_code: "D", presence_status_cd: "Present" }, { id: 4, att_code: "K", presence_status_cd: "Present" },
  { id: 5, att_code: "", presence_status_cd: "Present" }, { id: 6, att_code: "F", presence_status_cd: "Present" },
]);
const D = "2026-10-21";   // a Wednesday
const STU = Array.from({ length: 200 }, (_, i) => ({ psId: String(1000 + i), sn: String(50000 + i), grade: i < 100 ? "7" : "10", entry: "2026-08-12", exit: "2027-06-05" }));
const CC = STU.flatMap((s, i) => [1, 2, 10].map((slot) => ({ id: `${s.psId}-${slot}`, psId: s.psId, section: `${slot}-${i % 5}`, slot, from: "2026-08-12", to: "2027-06-05" })));
let rid = 1;
/** A day: students 0..k-1 tardy in slot 1, and m of them absent in slot 10. */
const dayRows = (date, k = 60, m = 30, extra = []) => [
  ...STU.slice(0, k).map((s) => ({ id: rid++, studentid: s.psId, att_date: date, periodid: 851, attendance_codeid: 2, ccid: `${s.psId}-1` })),
  ...STU.slice(0, m).map((s) => ({ id: rid++, studentid: s.psId, att_date: date, periodid: 860, attendance_codeid: 1, ccid: `${s.psId}-10` })),
  ...extra,
];
const REF = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"].map((d) => R.dayStats(d, dayRows(d), new Set(STU.map((s) => s.psId))));
const noScreen = { available: false, reason: "no screen", asOf: null, bySn: {} };
const screenOf = (bad = {}) => ({ available: true, reason: "", asOf: "2026-10-22", bySn: Object.fromEntries(STU.map((s) => [s.sn, { entry: s.entry, bad: bad[s.sn] ?? [] }])) });
const judge = (o = {}) => R.judgeDay({ date: D, read: { ok: true, rows: dayRows(D) }, codes: CODEBOOK, students: STU, cc: CC, reference: REF, screen: screenOf(), decideAnyway: false, ...o });
{
  const j = judge();
  check("an ordinary day is decided: 140 perfect of 200, the 60 with marks broken",
    j.state === "school" && j.perfect.length === 140 && j.broken.length === 60 && j.checked === true, J({ s: j.state, p: j.perfect.length, b: j.broken.length }));
  check("...MS and HS counted", j.counts.perfect.ms === 40 && j.counts.perfect.hs === 100, J(j.counts.perfect));
  check("...and late-to-school-only counted (equity review)", j.counts.brokenByPromiseTimeAmOnly === 30, String(j.counts.brokenByPromiseTimeAmOnly));
  const none = judge({ read: { ok: true, rows: [] } });
  check("a holiday (no attendance at all) is NO SCHOOL, never held, never retried", none.state === "no-school" && none.retryable === false);
  const thin = judge({ read: { ok: true, rows: dayRows(D, 5, 0) } });
  check("a few stray rows are no evidence of school: no school", thin.state === "no-school", thin.reason);
  const failed = judge({ read: { ok: false, reason: "did not hold still" } });
  check("a read that was not confirmed is HELD and retried", failed.state === "held" && failed.retryable === true && failed.perfect.length === 0);
  const other = judge({ read: { ok: true, rows: [...dayRows(D), { id: 9, studentid: "1000", att_date: "2026-10-20", periodid: 851, attendance_codeid: 2 }] } });
  check("a read holding another date's row is not believed", other.state === "held");
  const tooPerfect = judge({ read: { ok: true, rows: dayRows(D, 22, 0) } });
  check("a day that looks too perfect (far fewer students marked than usual) is held, not paid",
    tooPerfect.state === "held" && tooPerfect.retryable === false && tooPerfect.perfect.length === 0, tooPerfect.reason);
  const anyway = judge({ read: { ok: true, rows: dayRows(D, 22, 0) }, decideAnyway: true });
  check("...unless an admin said decide anyway", anyway.state === "school" && anyway.perfect.length === 178);
  const noPm = judge({ read: { ok: true, rows: dayRows(D, 60, 0) } });
  check("a block far below its usual level (Promise Time PM not entered yet) holds the day", noPm.state === "held" && /Block 10/.test(noPm.reason), noPm.reason);
  const unplaced = judge({ read: { ok: true, rows: [...dayRows(D), ...STU.slice(100, 105).map((s) => ({ id: rid++, studentid: s.psId, att_date: D, periodid: 0, attendance_codeid: 2 }))] } });
  check("more than 1% of rows outside a period: not believed", unplaced.state === "held" && /not in a known period/.test(unplaced.reason));

  // A STACK DAY (all ten blocks met, as on Thu 9/3 and Tue 9/8) beside one ordinary day of the same
  // pattern: blocks that never meet on that pattern must not look "not entered yet" on a normal day.
  const DS = (date, rc) => ({ date, rows: Object.values(rc).reduce((a, n) => a + n, 0), rowCounts: rc, studentsWithMarks: 60, unplaceable: 0, unmatched: 0 });
  const NORMAL = { 1: 60, 10: 30 };
  const STACK = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i + 1), 50]));
  const THU = "2026-10-22";
  const refWith = (mon, thu) => [DS("2026-10-15", thu), DS("2026-10-16", NORMAL), DS("2026-10-19", mon), DS("2026-10-20", NORMAL), DS("2026-10-21", NORMAL)];
  const judgeThu = (reference) => R.judgeDay({ date: THU, read: { ok: true, rows: dayRows(THU) }, codes: CODEBOOK, students: STU, cc: CC, reference,
    screen: { ...screenOf(), asOf: "2026-10-23" }, decideAnyway: false });
  const stackOnce = judgeThu(refWith(NORMAL, STACK));
  check("A STACK DAY IN A TWO-DAY SAME-PATTERN REFERENCE HOLDS NOTHING: a block that ran on only one of them is not expected",
    stackOnce.state === "school" && stackOnce.perfect.length === 140, stackOnce.reason);
  const stackTwice = judgeThu(refWith(STACK, STACK));
  check("...while a block that ran on every same-pattern day, and not today, still holds the day",
    stackTwice.state === "held" && /Block 2 has 0 marks against a usual 50/.test(stackTwice.reason), stackTwice.reason);

  const one = judge({ screen: screenOf({ [STU[150].sn]: [D] }) });
  check("ONE DISAGREEMENT HOLDS ONE STUDENT, NOT THE SCHOOL",
    one.state === "school" && one.held.length === 1 && one.held[0].sn === STU[150].sn && one.perfect.length === 139, J({ s: one.state, h: one.held.length }));
  const two = judge({ screen: screenOf({ [STU[150].sn]: [D], [STU[151].sn]: [D] }) });
  check("...two out of 200 (1%) still hold only those two", two.state === "school" && two.held.length === 2);
  const many = judge({ screen: screenOf(Object.fromEntries(STU.slice(100, 110).map((s) => [s.sn, [D]]))) });
  check("a disagreement about more than 1% of the enrolled holds the date", many.state === "held" && /disagree about 10/.test(many.reason), many.reason);
  check("A HELD DATE STILL SAYS WHO IS DISPUTED AND WHO HAS A BREAKING MARK, and makes nobody perfect",
    many.perfect.length === 0 && many.held.length === 10 && many.broken.length === 60 && many.broken.every((b) => b.why === "marked"),
    J({ p: many.perfect.length, h: many.held.length, b: many.broken.length }));
  check("...a read held as too perfect lists the marks it does show",
    tooPerfect.perfect.length === 0 && tooPerfect.broken.length === 22 && tooPerfect.broken.every((b) => b.why === "marked"), String(tooPerfect.broken.length));
  const k = judge({ read: { ok: true, rows: [...dayRows(D), { id: rid++, studentid: STU[120].psId, att_date: D, periodid: 852, attendance_codeid: 4, ccid: `${STU[120].psId}-2` }] } });
  check("K is the known difference: the award breaks the day, the screen does not, and nothing is held",
    k.state === "school" && k.held.length === 0 && k.counts.screen.knownDitching === 1 && k.broken.some((b) => b.sn === STU[120].sn && b.why === "ditching"));
  const stale = judge({ screen: { ...screenOf({ [STU[150].sn]: [D] }), asOf: D } });
  check("a screen rebuilt before the day ended is no second check: decided unchecked", stale.state === "school" && stale.checked === false && stale.held.length === 0);
  const off = judge({ screen: noScreen });
  check("no screen at all: decided unchecked", off.checked === false && off.perfect.length === 140);
  const leaver = judge({ screen: (() => { const s = screenOf(); delete s.bySn[STU[160].sn]; return s; })() });
  check("a student the screen does not list (left the roster) is judged by PowerSchool alone", leaver.perfect.some((p) => p.sn === STU[160].sn) && leaver.counts.screen.notOnScreen === 1);
  const late = judge({ students: STU.map((s, i) => (i === 170 ? { ...s, entry: "2026-10-22" } : i === 171 ? { ...s, exit: D } : s)) });
  check("enrolled means entrydate <= D < exitdate", !late.perfect.some((p) => p.sn === STU[170].sn || p.sn === STU[171].sn)
    && late.broken.filter((b) => b.why === "not-enrolled").length === 1 && late.broken.some((b) => b.sn === STU[171].sn && b.why === "not-enrolled"));

  // A STUDENT WHO LEFT AND CAME BACK (2026-10-12 review): PowerSchool's students row holds the current span only.
  const back = (i, cc = CC) => judge({ students: STU.map((s, k) => (k === i ? { ...s, entry: "2026-10-26" } : s)), cc });
  const inClass = back(170);
  check("RE-ENTERED LATER, IN CLASS THAT DAY: never a new perfect day, but a day already decided is kept",
    !inClass.perfect.some((p) => p.sn === STU[170].sn) && !!inClass.keep?.some((k) => k.sn === STU[170].sn) && !inClass.broken.some((b) => b.sn === STU[170].sn),
    J({ keep: inClass.keep?.length, broken: inClass.broken.find((b) => b.sn === STU[170].sn) }));
  const noRecord = back(170, CC.filter((c) => c.psId !== STU[170].psId));
  check("...with no class record that day either: a question for an admin (enrolment unconfirmed), never \"not enrolled\"",
    noRecord.broken.some((b) => b.sn === STU[170].sn && b.why === R.ENROLMENT_UNCONFIRMED) && !noRecord.keep?.some((k) => k.sn === STU[170].sn));
  const absentThen = back(5);
  check("...and a breaking mark that day still breaks it", absentThen.broken.some((b) => b.sn === STU[5].sn && b.why === "marked"));
  const screenSaysAbsent = judge({ students: STU.map((s, k) => (k === 170 ? { ...s, entry: "2026-10-26" } : s)), screen: screenOf({ [STU[170].sn]: [D] }) });
  check("...a kept student the screen shows absent that day is held, for a day already decided only",
    screenSaysAbsent.held.some((h) => h.sn === STU[170].sn && h.existingOnly === true) && !!screenSaysAbsent.keep && !screenSaysAbsent.keep.some((k) => k.sn === STU[170].sn));

  // WHICH BLOCKS A DAY RUNS (2026-10-12 review): a block that did not meet is not "not entered yet".
  const MONTHU = [1, 2, 4, 6, 8, 9, 10], TUEFRI = [1, 3, 5, 7, 8, 9, 10];
  const shaped = (date, slots, n = 30) => R.dayStats(date, slots.flatMap((slot) => STU.slice(0, slot === 1 ? 60 : n).map((s) => ({ id: rid++, studentid: s.psId, att_date: date, periodid: 850 + slot, attendance_codeid: slot === 1 ? 2 : 1 }))), new Set(STU.map((s) => s.psId)));
  const rowsShaped = (date, slots, n = 30) => slots.flatMap((slot) => STU.slice(0, slot === 1 ? 60 : n).map((s) => ({ id: rid++, studentid: s.psId, att_date: date, periodid: 850 + slot, attendance_codeid: slot === 1 ? 2 : 1, ccid: `${s.psId}-${slot}` })));
  const WEEK = [["2026-10-12", MONTHU], ["2026-10-13", TUEFRI], ["2026-10-15", MONTHU], ["2026-10-16", TUEFRI], ["2026-10-19", MONTHU], ["2026-10-20", TUEFRI], ["2026-10-22", MONTHU], ["2026-10-23", TUEFRI]];
  const REF2 = WEEK.map(([d, sl]) => shaped(d, sl));
  const MON = "2026-10-26";
  const CC10 = STU.flatMap((s, i) => Array.from({ length: 10 }, (_, k) => ({ id: `${s.psId}-${k + 1}`, psId: s.psId, section: `${k + 1}-${i % 5}`, slot: k + 1, from: "2026-08-12", to: "2027-06-05" })));
  const judgeMon = (slots, decided, reference = REF2) => R.judgeDay({ date: MON, read: { ok: true, rows: rowsShaped(MON, slots) }, codes: CODEBOOK, students: STU, cc: CC10,
    reference, screen: { ...screenOf(), asOf: "2026-10-27" }, decideAnyway: false, decided });
  const swapped = judgeMon(TUEFRI, WEEK.map(([d]) => d));
  check("A MONDAY RUN ON THE TUE/FRI BELL IS DECIDED: it ran exactly the blocks of days already decided",
    swapped.state === "school", swapped.reason);
  check("...while the same Monday with none of those days decided yet is still held (a block it did not run)",
    judgeMon(TUEFRI, []).state === "held" && /did not meet/.test(judgeMon(TUEFRI, []).reason), judgeMon(TUEFRI, []).reason);
  // Thursday 10/22 is still held with Promise Time PM not entered; Monday is missing it too.
  const lateThu = [...REF2.filter((r) => r.date !== "2026-10-22"), shaped("2026-10-22", [1, 2, 4, 6, 8, 9])];
  const lateMon = judgeMon([1, 2, 4, 6, 8, 9], WEEK.map(([d]) => d).filter((d) => d !== "2026-10-22"), lateThu);
  check("ONLY A DECIDED DAY VOUCHES: a held Thursday missing Promise Time PM does not let a Monday missing it too through",
    lateMon.state === "held" && /Block 10/.test(lateMon.reason), lateMon.reason);
  const stack = [shaped("2026-10-19", MONTHU), shaped("2026-10-20", TUEFRI), shaped("2026-10-21", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), shaped("2026-10-22", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    shaped("2026-10-23", TUEFRI), shaped("2026-10-15", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])];
  const afterStacks = judgeMon(MONTHU, ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-15"], stack);
  check("TWO ALL-TEN-BLOCK DAYS OF THE SAME PATTERN DO NOT HOLD A NORMAL DAY: a decided normal day of that pattern vouches for it",
    afterStacks.state === "school" && judgeMon(MONTHU, [], stack).state === "held", afterStacks.reason);
}

// ---------------------------------------------------------------- the register
console.log("\nTHE REGISTER: STAMPED ONCE, SETTLED UNTIL PAID\n");
{
  const live = R.planConfigure(R.settingsOrDefault(null), { mode: "live" }, "2026-10-19").next;
  const shadow = R.planConfigure(R.settingsOrDefault(null), { mode: "shadow" }, "2026-10-19").next;
  const NOW = "2026-10-22T14:42:00Z";
  const J1 = { perfect: [{ sn: "1", div: "ms" }, { sn: "2", div: "hs" }], held: [], broken: [{ sn: "3", why: "marked" }], checked: true };
  const p1 = R.planDateRows({ date: D, now: NOW, runId: "r1", settings: live, existing: [], judgement: J1 });
  check("a perfect student gets a pending row, stamped payable at $100", p1.inserts.length === 2 && p1.inserts.every((r) => r.status === "pending" && r.payable && r.amount === 100));
  check("a broken student with no row gets no row", !p1.inserts.some((r) => r.studentNumber === "3"));
  const pS = R.planDateRows({ date: D, now: NOW, runId: "r1", settings: shadow, existing: [], judgement: J1 });
  check("in shadow the row is UNPAYABLE, stamped why", pS.inserts.every((r) => r.status === "unpayable" && !r.payable && r.stampWhy === "shadow"));
  const later = R.planConfigure(live, { amount: 150 }, "2026-10-23").next;
  const rows = p1.inserts.map((r, i) => ({ ...r, _id: "id" + i }));
  const p2 = R.planDateRows({ date: D, now: NOW, runId: "r2", settings: later, existing: rows, judgement: { ...J1, perfect: [{ sn: "1" }], broken: [{ sn: "2", why: "marked" }] } });
  check("a pending day read as broken before payday settles to broken", p2.patches.some((p) => p.id === "id1" && p.patch.status === "broken"));
  check("...and nothing about the still-perfect one changes", !p2.patches.some((p) => p.id === "id0"));
  const brokenRows = rows.map((r) => (r._id === "id1" ? { ...r, status: "broken" } : r));
  const p3 = R.planDateRows({ date: D, now: NOW, runId: "r3", settings: later, existing: brokenRows, judgement: J1 });
  check("broken back to perfect before payday: pending again, at its OWN stamped amount",
    p3.patches.some((p) => p.id === "id1" && p.patch.status === "pending") && p3.inserts.length === 0 && brokenRows[1].amount === 100);
  const shadowRows = pS.inserts.map((r, i) => ({ ...r, _id: "s" + i, status: "broken" }));
  const p4 = R.planDateRows({ date: D, now: NOW, runId: "r4", settings: live, existing: shadowRows, judgement: J1 });
  check("a shadow day stays unpayable when the switch is live (the stamp is final)", p4.patches.every((p) => p.patch.status === "unpayable") && p4.patches.length === 2);
  const p5 = R.planDateRows({ date: D, now: NOW, runId: "r5", settings: live, existing: [], judgement: { ...J1, checked: false } });
  check("without the second check a new day is HELD, not pending", p5.inserts.every((r) => r.status === "held" && r.why === "second-check-unavailable"));
  const p6 = R.planDateRows({ date: D, now: NOW, runId: "r6", settings: live, existing: rows, judgement: { perfect: [], held: [], broken: [{ sn: "1", why: "marked" }, { sn: "2", why: "marked" }], checked: false } });
  check("...but a day becoming NOT payable always applies", p6.patches.filter((p) => p.patch.status === "broken").length === 2);
  const paid = rows.map((r) => ({ ...r, status: "paid", paidTxnId: "txn_1" }));
  const p7 = R.planDateRows({ date: D, now: NOW, runId: "r7", settings: live, existing: paid, judgement: { ...J1, perfect: [{ sn: "2" }], broken: [{ sn: "1", why: "marked" }] } });
  check("a PAID day read as broken is flagged for an admin, never taken back",
    p7.patches.length === 1 && p7.patches[0].patch.afterPayBroken === true && !("status" in p7.patches[0].patch));
  const p8 = R.planDateRows({ date: D, now: NOW, runId: "r8", settings: live, existing: paid.map((r) => ({ ...r, afterPayBroken: true })), judgement: J1 });
  check("...and the flag comes off if a later read says perfect again", p8.patches.every((p) => p.patch.afterPayBroken === false) && p8.patches.length === 2);
  const removed = rows.map((r) => ({ ...r, status: "removed" }));
  const p9 = R.planDateRows({ date: D, now: NOW, runId: "r9", settings: live, existing: removed, judgement: J1 });
  check("a removed day is final: never pending again", p9.patches.length === 0 && p9.inserts.length === 0);
  const p10 = R.planDateRows({ date: D, now: NOW, runId: "r10", settings: live, existing: rows, judgement: { ...J1, perfect: [{ sn: "2" }], held: [{ sn: "1", why: "screen-disagrees" }] } });
  check("a pending day the screen now disagrees about is held", p10.patches.some((p) => p.id === "id0" && p.patch.status === "held"));
  const mixed = [
    { ...rows[0], studentNumber: "1", _id: "m1" }, { ...rows[0], studentNumber: "2", _id: "m2" },
    { ...rows[0], studentNumber: "3", _id: "m3", status: "paid", paidTxnId: "txn_1" }, { ...rows[0], studentNumber: "4", _id: "m4", status: "broken", why: "marked" },
  ];
  const p11 = R.planDateRows({ date: D, now: NOW, runId: "r11", settings: live, existing: mixed, onlyNotPayable: true,
    judgement: { perfect: [{ sn: "4", div: "ms" }, { sn: "6", div: "ms" }], held: [{ sn: "2", why: "screen-disagrees" }, { sn: "5", why: "screen-disagrees" }],
      broken: [{ sn: "1", why: "marked" }, { sn: "3", why: "marked" }], checked: true } });
  const patchOf = (id) => p11.patches.find((x) => x.id === id)?.patch ?? null;
  check("A HELD RE-READ OF A DECIDED DATE ONLY STOPS PAY: pending and absent is broken, pending and disputed is held, paid and absent is flagged",
    patchOf("m1")?.status === "broken" && patchOf("m2")?.status === "held" && patchOf("m3")?.afterPayBroken === true && !("status" in (patchOf("m3") ?? {})), J(p11.patches));
  check("...and nothing becomes pending or is inserted from a read that was not believed",
    patchOf("m4") === null && p11.inserts.length === 0, J({ m4: patchOf("m4"), ins: p11.inserts.length }));

  // A DATE DECIDED BEFORE THE SWITCH LAST CAME ON (2026-10-12 review): its days settle; none is started.
  const off2on = R.planConfigure(R.planConfigure(live, { mode: "off" }, "2026-10-23").next, { mode: "live" }, "2026-10-26").next;
  const before = [
    { ...rows[0], studentNumber: "1", _id: "b1", status: "pending" }, { ...rows[0], studentNumber: "2", _id: "b2", status: "held", why: "second-check-unavailable" },
    { ...rows[0], studentNumber: "3", _id: "b3", status: "paid", paidTxnId: "txn_1" }, { ...rows[0], studentNumber: "4", _id: "b4", status: "broken", why: "marked" },
  ];
  const p12 = R.planDateRows({ date: D, now: NOW, runId: "r12", settings: off2on, existing: before, existingOnly: true,
    judgement: { perfect: [{ sn: "2", div: "ms" }, { sn: "4", div: "ms" }, { sn: "9", div: "ms" }], held: [{ sn: "8", why: "screen-disagrees" }],
      broken: [{ sn: "1", why: "marked" }, { sn: "3", why: "marked" }], checked: true } });
  const p12of = (id) => p12.patches.find((x) => x.id === id)?.patch ?? null;
  check("A PAUSE NEVER STARTS A DAY: before the start, nothing is inserted, perfect or held", p12.inserts.length === 0, J(p12.inserts));
  check("...but the days already decided settle by their own stamps: a known break applies, a paid one is flagged, a held one is released, a corrected one restored",
    p12of("b1")?.status === "broken" && p12of("b3")?.afterPayBroken === true && p12of("b2")?.status === "pending" && p12of("b4")?.status === "pending", J(p12.patches));

  // ENROLMENT UNCONFIRMED is a question for an admin, never a break.
  const p13 = R.planDateRows({ date: D, now: NOW, runId: "r13", settings: live,
    existing: [{ ...rows[0], studentNumber: "1", _id: "e1" }, { ...rows[0], studentNumber: "2", _id: "e2", status: "paid", paidTxnId: "txn_2" }],
    judgement: { perfect: [], held: [], broken: [{ sn: "1", why: R.ENROLMENT_UNCONFIRMED }, { sn: "2", why: R.ENROLMENT_UNCONFIRMED }, { sn: "3", why: R.ENROLMENT_UNCONFIRMED }], checked: true } });
  const p13of = (id) => p13.patches.find((x) => x.id === id)?.patch ?? null;
  check("ENROLMENT UNCONFIRMED HOLDS, NEVER BREAKS: a pending day is held for an admin, a paid one flagged, and no day is started",
    p13of("e1")?.status === "held" && p13of("e1")?.why === R.ENROLMENT_UNCONFIRMED && p13of("e2")?.afterPayBroken === true && p13.inserts.length === 0, J(p13.patches));
  const p14 = R.planDateRows({ date: D, now: NOW, runId: "r14", settings: live, existing: [{ ...rows[0], studentNumber: "1", _id: "k1" }],
    judgement: { perfect: [{ sn: "1", div: "ms", existingOnly: true }, { sn: "5", div: "ms", existingOnly: true }], held: [{ sn: "6", why: "screen-disagrees", existingOnly: true }], broken: [], checked: true } });
  check("...and a student kept on class records keeps the day already decided, and starts none",
    p14.patches.length === 0 && p14.inserts.length === 0, J(p14));

  // A RUN WITH NO SECOND CHECK NEVER RELABELS A HOLD (2026-10-12 final review).
  const heldRows = [
    { ...rows[0], studentNumber: "1", _id: "h1", status: "held", why: "screen-disagrees" },
    { ...rows[0], studentNumber: "2", _id: "h2", status: "held", why: R.ENROLMENT_UNCONFIRMED },
    { ...rows[0], studentNumber: "3", _id: "h3", status: "broken", why: "marked" },
  ];
  const p15 = R.planDateRows({ date: D, now: NOW, runId: "r15", settings: live, existing: heldRows,
    judgement: { perfect: ["1", "2", "3", "4"].map((sn) => ({ sn, div: "ms" })), held: [], broken: [], checked: false } });
  const p15of = (id) => p15.patches.find((x) => x.id === id)?.patch ?? null;
  check("A HELD DAY KEEPS ITS REASON WITHOUT THE SECOND CHECK: one the screen disputes, or enrolment unconfirmed, is not relabelled for releaseUnchecked",
    p15of("h1") === null && p15of("h2") === null, J(p15.patches));
  check("...while a broken day and a new one are still held for the check",
    p15of("h3")?.status === "held" && p15of("h3")?.why === R.UNCHECKED
    && p15.inserts.length === 1 && p15.inserts[0].studentNumber === "4" && p15.inserts[0].why === R.UNCHECKED, J({ p: p15.patches, i: p15.inserts }));
}

// ---------------------------------------------------------------- payday
console.log("\nPAYDAY\n");
{
  const PV = (o) => R.paydayVerdict({ today: "2026-10-26", minute: 7 * 60 + 42, mode: "live", lastPayWeek: "2026-10-19", retryableHeldBefore: false, ...o });
  check("Monday is payday", PV({}).due && PV({}).payWeek === "2026-10-26");
  check("once a week: not again after it is done", PV({ lastPayWeek: "2026-10-26" }).due === false);
  check("a failed Monday does not slip a week: Tuesday pays", PV({ today: "2026-10-27" }).due === true);
  check("on Monday, a retried read of last week is waited for until 09:30", PV({ retryableHeldBefore: true }).due === false && PV({ retryableHeldBefore: true, minute: 9 * 60 + 42 }).due === true);
  check("no money in shadow", PV({ mode: "shadow" }).due === false);

  const live = R.planConfigure(R.settingsOrDefault(null), { mode: "live" }, "2026-10-19").next;
  const row = (date, o = {}) => ({ studentNumber: "1", date, status: "pending", payable: true, amount: 100, decidedAt: "", updatedAt: "", runId: "r", _id: date, ...o });
  const plan = R.planPayout({ sn: "1", rows: [row("2026-10-19"), row("2026-10-20", { amount: 150 }), row("2026-10-26"), row("2026-10-21", { status: "paid" })],
    settings: live, before: "2026-10-26", zeroPointDate: null, cutoffDate: null });
  check("payday pays pending days before this week, at their stamped amounts", plan.parts.length === 1 && J(plan.parts[0].dates) === J(["2026-10-19", "2026-10-20"]) && plan.parts[0].amount === 250);
  check("...not a day of this week, not a paid day", !plan.parts[0].dates.includes("2026-10-26") && !plan.parts[0].dates.includes("2026-10-21"));
  // Off on 10/14, on again 10/19: countFromDate moved to 10/19. 10/12-10/13 were decided while live, stamped payable, shown.
  const resumed = R.planConfigure(R.planConfigure(R.planConfigure(R.settingsOrDefault(null), { mode: "live" }, "2026-10-12").next, { mode: "off" }, "2026-10-14").next, { mode: "live" }, "2026-10-19").next;
  const kept = R.planPayout({ sn: "1", rows: [row("2026-10-12"), row("2026-10-13"), row("2026-10-19")], settings: resumed, before: "2026-10-26", zeroPointDate: null, cutoffDate: null });
  check("A DAY EARNED BEFORE A PAUSE IS PAID: today's start date fenced the deciding, it is not asked again at payday",
    resumed.countFromDate === "2026-10-19" && kept.parts.length === 1 && J(kept.parts[0].dates) === J(["2026-10-12", "2026-10-13", "2026-10-19"]) && kept.skipped.length === 0, J(kept));
  const never = R.planPayout({ sn: "1", rows: [row("2026-10-19", { payable: false })], settings: live, before: "2026-10-26", zeroPointDate: null, cutoffDate: null });
  check("...a day stamped unpayable when decided is never paid", never.parts.length === 0 && never.skipped[0].why === "unpayable");
  const offPlan = R.planPayout({ sn: "1", rows: [row("2026-10-19")], settings: R.planConfigure(live, { mode: "off" }, "2026-10-22").next, before: "2026-10-26", zeroPointDate: null, cutoffDate: null });
  check("...and nothing is paid while no money moves (it waits, counted)", offPlan.parts.length === 0 && offPlan.skipped[0].why === "off");
  const reset = R.planPayout({ sn: "1", rows: [row("2026-10-19"), row("2026-10-20")], settings: live, before: "2026-10-26", zeroPointDate: "2026-10-19", cutoffDate: null });
  check("a day on or before a cash reset is dropped, not paid", reset.parts[0].dates.length === 1 && reset.skipped[0].why === "before-reset");
  const big = R.planPayout({ sn: "1", rows: Array.from({ length: 8 }, (_, i) => row(R.addDays("2026-10-19", i), { amount: 1000 })), settings: live, before: "2026-11-02", zeroPointDate: null, cutoffDate: null });
  check("a week past $5,000 is split, so Reverse can undo each part", big.parts.length === 2 && big.parts.every((p) => p.amount <= 5000) && big.parts[0].amount === 5000);
  const ctl = R.planPayout({ sn: "1", rows: [row("2026-10-19")], settings: { ...live, controls: ["1"] }, before: "2026-10-26", zeroPointDate: null, cutoffDate: null });
  check("a control is never paid, even with a payable day", ctl.parts.length === 0 && ctl.skipped[0].why === "control");

  const id = R.payoutTxnId(Date.parse("2026-10-26T14:42:01.003Z"), "30001", "2026-10-26", 0);
  check("the movement id has the shape the award command and Reverse expect", AWARD.TXN_ID_RE.test(id) && REV.weekOfTxnId(id) === "2026_W44", id);
  const lbl = R.payoutLabel(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-23"]);
  check("the wallet reads 'Perfect attendance — 4 days', and names the days",
    lbl.behaviorName === "Perfect attendance — 4 days" && lbl.notes === "Mon 10/19, Tue 10/20, Wed 10/21, Fri 10/23");
  const pr = R.buildPayoutRow({ txnId: id, at: "2026-10-26T14:42:01.003Z", appStudentId: "30001", student: { firstName: "A", lastName: "B", grade: "7" }, amount: 400, dates: ["2026-10-19"], balanceAfter: 1400 });
  check("the ledger row always carries a kind, and the three server-only marks",
    pr.kind === "attendance" && pr.behaviorId === "system:perfect-day" && pr.teacherId === "system:attendance" && pr.teacherName === "Wildcat Hub (attendance)" && !("key" in pr));
  check("...which the browser paths refuse (isSystemCashRow)", SHAPE.isSystemCashRow(pr) === true && SHAPE.isSystemCashRow({ kind: "award", behaviorId: "wc1", teacherId: "T1" }) === false);
  check("...and the money counts as earned, as an award does", J(SHAPE.cashMovementEffect(400, "attendance")) === J({ wildcatCashBalance: 400, wildcatCashEarned: 400, wildcatCashSpent: 0, wildcatCashDeducted: 0 }));
  check("the award command refuses the reserved behaviour and the kind",
    AWARD.validateAward({ studentId: "1", txnId: "txn_1760000000000_ab", at: new Date(1760000000000).toISOString(), amount: 100, kind: "award", behaviorId: "system:perfect-day", behaviorName: "x", notes: "a note" }, { nowMs: 1760000000000, cutoffMs: null }).code === "reserved_behavior"
    && AWARD.validateAward({ studentId: "1", txnId: "txn_1760000000000_ab", at: new Date(1760000000000).toISOString(), amount: 100, kind: "attendance", behaviorId: "wc1", behaviorName: "x", notes: "a note" }, { nowMs: 1760000000000, cutoffMs: null }).code === "bad_kind");

  const pilot = R.planConfigure(R.settingsOrDefault(null), { mode: "pilot", pilotAdd: ["1"] }, "2026-10-19").next;
  const rows = [row("2026-10-20"), row("2026-10-21", { status: "held" }), row("2026-10-22", { status: "unpayable", payable: false })];
  check("a pilot student sees only the days that will be paid, and when", J(R.pendingForStudent({ settings: pilot, sn: "1", rows })) === J({ days: ["2026-10-20"], amount: 100, payday: "2026-10-26" }));
  check("a student outside the pilot sees nothing promised", R.pendingForStudent({ settings: pilot, sn: "2", rows }) === null);
  const moved = R.planConfigure(pilot, { pilotRemove: ["1"], pilotAdd: ["9"] }, "2026-10-21").next;
  check("a student taken out of the pilot still sees, and is paid, the days already earned in it",
    J(R.pendingForStudent({ settings: moved, sn: "1", rows })) === J({ days: ["2026-10-20"], amount: 100, payday: "2026-10-26" })
    && R.planPayout({ sn: "1", rows, settings: moved, before: "2026-10-26", zeroPointDate: null, cutoffDate: null }).parts[0]?.dates.length === 1);
  check("a control is promised nothing, though a day was stamped payable before", R.pendingForStudent({ settings: { ...pilot, controls: ["1"] }, sn: "1", rows }) === null);
  check("in shadow nobody sees anything promised", R.pendingForStudent({ settings: R.planConfigure(R.settingsOrDefault(null), { mode: "shadow" }, "2026-10-19").next, sn: "1", rows }) === null);

  // THE ADMIN CARD'S NEXT PAYDAY: the day the money moves, never one gone by.
  const NP = (nowIso, lastDoneDate, lastPayWeek) => R.nextPaydayOf({ nowIso, tz: TZ, lastDoneDate, lastPayWeek });
  check("Monday before its run: payday is today", J(NP("2026-10-19T13:00:00Z", "2026-10-16", "2026-10-12")) === J({ date: "2026-10-19", payWeek: "2026-10-19" }));
  check("Monday after payday ran: next Monday", J(NP("2026-10-19T20:00:00Z", "2026-10-19", "2026-10-19")) === J({ date: "2026-10-26", payWeek: "2026-10-26" }));
  check("SWITCHED ON MIDWEEK, after the morning: not the Monday gone by, but the next run, which pays this week's payday",
    J(NP("2026-10-21T21:00:00Z", "2026-10-21", "2026-10-12")) === J({ date: "2026-10-22", payWeek: "2026-10-19" })
    && J(NP("2026-10-19T18:30:00Z", "2026-10-16", "2026-10-12")) === J({ date: "2026-10-20", payWeek: "2026-10-19" }));
  check("a weekend with this week's payday never run: the Monday after", J(NP("2026-10-24T18:00:00Z", "2026-10-23", "2026-10-12")) === J({ date: "2026-10-26", payWeek: "2026-10-26" }));
  check("across the clock change: Monday 11/2 at 05:00 PST, its 06:42 run is the payday", J(NP("2026-11-02T13:00:00Z", "2026-10-30", "2026-10-26")) === J({ date: "2026-11-02", payWeek: "2026-11-02" }));
  check("...on the cron's own firings: the rule's hours are crons.ts's",
    read("./convex/crons.ts").includes(`"perfect day award",\n  "${R.TICK_UTC_MINUTE} ${R.TICK_UTC_HOURS.join(",")} * * *",`));
}

// ---------------------------------------------------------------- the mirror
console.log("\nTHE MIRROR: THE AWARD AND THE PERFECT ATTENDANCE SCREEN AGREE, EXCEPT ON K\n");
{
  // The SHIPPED rebuild, loaded the way excused-tardy.test.mjs loads it.
  const tsToJs = (src) => ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const absenceRules = await import("data:text/javascript," + encodeURIComponent(tsToJs(read("./convex/absenceDayRules.ts"))));
  let body = read("./convex/attendanceDays.ts").replace("function laToday(): string {", 'function laToday(): string {\n  return "2026-10-02";');
  body = body.replace(/^"use node";[ \t]*\n/m, "").replace(/^import[\s\S]*?from\s*"[^"]*";[ \t]*\n/gm, "").replace(/^export (const|async function|function) /gm, "$1 ");
  const ref = (path) => new Proxy({}, { get: (_, k) => (k === "__path" ? path : ref(path ? path + "." + String(k) : String(k))) });
  const vv = new Proxy({}, { get: () => () => ({}) });
  const rebuild = new Function("internalAction", "internal", "v", "addAbsenceDay", "emptyAbsenceSplit", "fetch", "process", tsToJs(body) + "\nreturn rebuild;")
    .bind(null, (d) => d, ref(""), vv, absenceRules.addAbsenceDay, absenceRules.emptyAbsenceSplit);
  const sandbox = {};
  new Function("globalThis", read("./wildcat-roster.js")).call(sandbox, sandbox);
  const Roster = sandbox.WildcatRoster;

  const CODES = [
    { id: 1, att_code: "A", description: "Absent", presence_status_cd: "Absent" },
    { id: 2, att_code: "T", description: "Tardy", presence_status_cd: "Present" },
    { id: 3, att_code: "X", description: "Excused Absence", presence_status_cd: "Absent" },
    { id: 4, att_code: "", description: "Present", presence_status_cd: "Present" },
    { id: 5, att_code: "I", description: "Illness", presence_status_cd: "Absent" },
    { id: 6, att_code: "D", description: "Excused Tardy", presence_status_cd: "Present" },
    { id: 7, att_code: "F", description: "Field Trip", presence_status_cd: "Present" },
    { id: 8, att_code: "K", description: "Ditching", presence_status_cd: "Present" },
    { id: 9, att_code: "P", description: "Independent Study In Progress", presence_status_cd: "Absent" },
  ].map((c) => ({ ...c, schoolid: 1 }));
  const C = Object.fromEntries(CODES.map((c) => [c.att_code || "blank", c.id]));
  const CCT = Array.from({ length: 10 }, (_, i) => ({ id: 501 + i, expression: `${i + 1}(A-E)`, schoolid: 1, termid: 3600 }));
  const DAYS = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"];
  // Every single code, every pair of codes, on its own student-day; plus a clean student.
  const combos = [[]];
  const letters = ["A", "T", "X", "blank", "I", "D", "F", "K", "P"];
  for (const a of letters) combos.push([a]);
  for (let i = 0; i < letters.length; i++) for (let j = i + 1; j < letters.length; j++) combos.push([letters[i], letters[j]]);
  const STUDENTS = combos.map((_, i) => ({ id: String(100 + i), student_number: String(7000 + i), entrydate: "2026-08-12", schoolid: 1, enroll_status: 0 }));
  let n = 1;
  const ATT = [];
  combos.forEach((codes, i) => {
    const day = DAYS[i % DAYS.length];
    codes.forEach((code, k) => ATT.push({ id: n++, yearid: 36, schoolid: 1, studentid: String(100 + i), att_date: day + "T00:00:00", periodid: 851 + k * 4, attendance_codeid: C[code], ccid: 501 + k * 4 }));
  });
  const fetch = fakePowerSchool({ attendance_code: CODES, cc: CCT, students: STUDENTS, attendance: ATT,
    terms: [{ id: 3600, schoolid: 1, yearid: 36, firstday: "2026-08-12", lastday: "2027-06-10", isyearrec: 1 }] }).fetch;
  const writes = [];
  const ctx = {
    runQuery: async (fn) => {
      if (fn.__path.endsWith("enrolledSlots")) return Object.fromEntries(STUDENTS.map((s) => [s.student_number, CCT.map((c) => c.expression)]));
      if (fn.__path.endsWith("studentNames")) return Object.fromEntries(STUDENTS.map((s) => [s.student_number, { firstName: "F", lastName: "L", grade: "7" }]));
      throw new Error("unexpected query " + fn.__path);
    },
    runMutation: async (fn, args) => { writes.push({ fn: fn.__path, args }); return { ok: true, moreToClear: false, monthPieces: true }; },
    scheduler: { runAfter: async () => "job", cancel: async () => {} },
  };
  const env = { PS_HOST: "ps.example", PS_CLIENT_ID: "id", PS_CLIENT_SECRET: "s", PS_SCHOOL_ID: "1", PS_YEAR_ID: "36", PS_TERM_ID: "3600" };
  const summary = await rebuild(fetch, { env }).handler(ctx, {});
  const marks = writes.filter((w) => w.fn === "sisStats.replaceAttendanceMarks" && !w.args.clearFirst).flatMap((w) => w.args.rows);
  const bySn = Object.fromEntries(marks.map((r) => [r.studentNumber, r]));
  check("the shipped rebuild ran over every code and every pair of codes", summary.ok === true && marks.length === STUDENTS.length, J(summary).slice(0, 200));

  const book = R.codeBookOf(CODES);
  let agree = 0;
  const differ = [];
  combos.forEach((codes, i) => {
    const day = DAYS[i % DAYS.length];
    const sn = String(7000 + i);
    const screen = Roster.perfectVerdict(bySn[sn], { from: day, to: day }).perfect;
    const award = R.studentDayVerdict({ enrolled: true, hasClass: true, marks: codes.map((c) => ({ slot: 1, info: book.byId[String(C[c])] })) });
    if (screen === award.perfect) agree++;
    else differ.push({ codes: codes.join("+") || "none", screen, award: award.perfect, kOnly: award.kOnly });
  });
  check("on every other code and pair of codes, the award's verdict IS the screen's",
    differ.every((d) => d.kOnly), J(differ.filter((d) => !d.kOnly)));
  const kOnlyDays = combos.filter((c) => c.includes("K") && c.every((x) => x === "K" || ["blank", "D", "F"].includes(x))).map((c) => c.join("+"));
  check("the only difference is a day broken by K alone: the screen says perfect, the award does not",
    differ.length === kOnlyDays.length && differ.every((d) => kOnlyDays.includes(d.codes) && d.screen === true && d.award === false), J(differ));
  check("...K beside a code the screen counts agrees (both broken)", J(kOnlyDays) === J(["K", "blank+K", "D+K", "F+K"]) && agree === combos.length - kOnlyDays.length);
  check("an excused tardy (D) and a field trip (F) keep the day perfect on both", ["D", "F", "blank"].every((c) => {
    const i = combos.findIndex((x) => x.length === 1 && x[0] === c);
    return Roster.perfectVerdict(bySn[String(7000 + i)], { from: DAYS[i % 5], to: DAYS[i % 5] }).perfect === true;
  }));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
} finally {
  loaded.cleanup();
}
