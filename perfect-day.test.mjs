// THE AUTOMATIC PERFECT-DAY AWARD, END TO END. Run: npm test
//
// IT RUNS THE SHIPPED SERVER CODE: perfectDay.ts (the tick, the writes, the
// admin tools), perfectDayRead.ts (the PowerSchool run) and every module they
// import, transpiled as they are, against an in-memory Convex that knows the
// real schema's indexes (fake-convex.mjs) and a PowerSchool that applies
// every filter (fake-powerschool.mjs). The cron's own clock drives it: each
// school morning the attendance rebuild writes the Perfect Attendance
// screen's table at 13:30 UTC and the tick fires at 14:42 UTC.
//
// The worlds, each built from nothing:
//   A. Shadow for a week, then live: shadow never pays, the switch never
//      back-pays, the week is paid once on Monday (across the clock change),
//      the wallet line reads "Perfect attendance -- 5 days", the student sees
//      pending days only when they will be paid, staff analytics leave it out,
//      and a stale tab's save afterwards keeps both amounts.
//   B. Live, off for two days, on again: nothing from before the pause is paid.
//   C. A pilot with a control: amounts stamped when decided, once per
//      student-week (a crash mid-payday, a second payday attempt), a late
//      correction paid next week, a paid day that later breaks put on the
//      admin list and taken back out by the admin's correction.
//   D. The second check and the calendar: one disagreement holds one student,
//      many hold the date, a holiday is not a failed read, a failed read is
//      retried and payday does not wait for ever, a day that looks too perfect
//      is held and expires, "decide anyway", a block entered late, no second
//      check available.
//   E. Leavers and Hub records: paid while they have a record; never a guess.
//   F. The browser cannot send the reserved behaviour, on any of the four
//      write paths.
//   G. One run at a time, the summary audit entry, the ledger check.
//   M. A pause (off, then on) never stops the re-read of days already decided.
//   N. Holds that must not cost the school a day: a day run on another
//      weekday's bell, stack days, a block entered 11 school days late, an
//      attendance-rebuild outage, a failed re-read, an admin's "no school",
//      and a student who left and came back.
//
// Synthetic student numbers only; nothing here talks to a real deployment.
import { readFileSync } from "node:fs";
import { clock, loadConvex, makeDb, runtime } from "./fake-convex.mjs";
import { fakePowerSchool } from "./fake-powerschool.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const schemaSrc = read("./convex/schema.ts");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "\n        " + why : ""}`));
};
const J = (x) => JSON.stringify(x);
const realLog = console.log;
console.log = (...a) => { if (!(typeof a[0] === "string" && a[0].startsWith("[perfectDay]"))) realLog(...a); };

const fast = (name, src) => (name === "attendanceDays" ? src.replace("const RETRY_PAUSE_MS = 1000;", "const RETRY_PAUSE_MS = 1;") : src);
const MODULES = ["perfectDay", "perfectDayRead", "perfectDayRules", "legacyData", "appData", "cashAward", "views_app", "cashReversal"];
const loaded = await loadConvex(new URL("./", import.meta.url), MODULES, { transform: fast });
// World C pays two students a mutation and can be killed mid-payday: a TEST KNOB, nothing else changed.
const crashy = await loadConvex(new URL("./", import.meta.url), MODULES, {
  transform: (name, src) => {
    src = fast(name, src);
    if (name === "perfectDayRules") src = src.replace("export const PAY_BATCH = 50;", "export const PAY_BATCH = 2;");
    if (name === "perfectDay") {
      src = src.replace("export const payBatch = internalMutation({\n  args: { runId: v.string(), payWeek: v.string(), students: v.array(v.string()), tz: v.string() },\n  handler: async (ctx, a) => {",
        "export const payBatch = internalMutation({\n  args: { runId: v.string(), payWeek: v.string(), students: v.array(v.string()), tz: v.string() },\n  handler: async (ctx, a) => {\n    if ((globalThis as any).__killPayBatch?.()) throw new Error(\"killed mid-payday\");");
    }
    return src;
  },
});

const TZ = "America/Los_Angeles";
const SCHOOL = "1817", YEAR = "36", TERM = "3601";
const STAFF_ISSUER = "https://login.microsoftonline.com/tenant-1/v2.0";
Object.assign(process.env, {
  PS_HOST: "ps.test", PS_CLIENT_ID: "id", PS_CLIENT_SECRET: "secret", PS_SCHOOL_ID: SCHOOL, PS_YEAR_ID: YEAR, PS_TERM_ID: TERM,
  STAFF_DOMAIN: "school.test", ENTRA_TENANT_ID: "tenant-1",
});

// The school's codes as read on 2026-10-12, and one id nobody has seen.
const CODES = [
  { id: 951, att_code: "A", description: "Absent", presence_status_cd: "Absent" },
  { id: 953, att_code: "D", description: "Excused Tardy", presence_status_cd: "Present" },
  { id: 954, att_code: "F", description: "Field Trip", presence_status_cd: "Present" },
  { id: 956, att_code: "I", description: "Illness", presence_status_cd: "Absent" },
  { id: 957, att_code: "K", description: "Ditching", presence_status_cd: "Present" },
  { id: 959, att_code: "P", description: "Independent Study In Progress", presence_status_cd: "Absent" },
  { id: 963, att_code: "T", description: "Tardy", presence_status_cd: "Present" },
  { id: 965, att_code: "X", description: "Excused Absence", presence_status_cd: "Absent" },
  { id: 966, att_code: "", description: "Present", presence_status_cd: "Present" },
].map((c) => ({ ...c, schoolid: SCHOOL, yearid: YEAR }));
const C = { A: 951, D: 953, F: 954, I: 956, K: 957, P: 959, T: 963, X: 965, blank: 966 };
const CODE_BY_ID = Object.fromEntries(CODES.map((c) => [c.id, c]));

// Twelve students under test (S1-S6 middle school, S7-S12 high school) and
// twenty-five others whose marks make every school day look like one.
const TEST = Array.from({ length: 12 }, (_, i) => ({ key: `S${i + 1}`, sn: String(30001 + i), psId: 801 + i, grade: i < 6 ? 7 : 10 }));
const FILL = Array.from({ length: 25 }, (_, i) => ({ key: `F${i + 1}`, sn: String(39001 + i), psId: 901 + i, grade: 8 }));
const ALL = [...TEST, ...FILL];
const BY_KEY = Object.fromEntries(ALL.map((s) => [s.key, s]));
const SN = (k) => BY_KEY[k].sn;

// ---------------------------------------------------------------- clock
const laFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function laOf(ms) {
  const p = Object.fromEntries(laFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
const plusDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const weekday = (d) => new Date(d + "T12:00:00Z").getUTCDay();
const weekdaysBetween = (from, to) => { const out = []; for (let d = from; d <= to; d = plusDays(d, 1)) if (weekday(d) >= 1 && weekday(d) <= 5) out.push(d); return out; };

// ---------------------------------------------------------------- the world
async function makeWorld({ mods = loaded.mods, exits = {}, holidays = [] } = {}) {
  const studentsPs = ALL.map((s) => ({ id: s.psId, student_number: s.sn, grade_level: String(s.grade), entrydate: "2026-08-12",
    exitdate: exits[s.key] ?? "2027-06-05", schoolid: SCHOOL }));
  let ccId = 5000;
  const ccOf = {};
  const cc = ALL.flatMap((s) => Array.from({ length: 10 }, (_, k) => {
    const id = ccId++;
    ccOf[`${s.psId}|${k + 1}`] = id;
    return { id, studentid: s.psId, sectionid: 100 * (k + 1) + (s.grade < 9 ? 1 : 2), expression: `${k + 1}(A-E)`, termid: 3600,
      dateenrolled: "2026-08-12", dateleft: exits[s.key] ?? "2027-06-05", schoolid: SCHOOL };
  }));
  const fake = fakePowerSchool({ attendance: [], attendance_code: CODES, students: studentsPs, cc });
  const store = makeDb(schemaSrc);
  const rt = runtime(store, mods);
  await store.db.insert("bellSettings", { key: "bell", timeZone: TZ, updatedAt: "2026-08-17T00:00:00Z" });
  for (const s of ALL) await store.db.insert("students", hubRow(s));
  await store.db.insert("teachers", { name: "Ada Admin", email: "admin@school.test", role: "admin", ticketsAwarded: 0, createdDate: "2026-08-01", legacyId: "T1" });
  await store.db.insert("teachers", { name: "Tess Teacher", email: "teacher@school.test", role: "teacher", ticketsAwarded: 0, createdDate: "2026-08-01", legacyId: "T2" });
  let nextId = 1;
  const w = {
    store, rt, fake, jobLog: [], down: null, screenExtra: {},
    mark(key, date, slot, code) {
      const s = BY_KEY[key];
      fake.tables.attendance.push({ id: nextId++, schoolid: SCHOOL, yearid: YEAR, studentid: s.psId, att_date: date, periodid: 850 + slot,
        attendance_codeid: C[code] ?? code, ccid: ccOf[`${s.psId}|${slot}`] });
    },
    unmark(key, date, slot) {
      const s = BY_KEY[key];
      fake.tables.attendance = fake.tables.attendance.filter((r) => !(r.studentid === s.psId && r.att_date === date && (slot === undefined || r.periodid === 850 + slot)));
    },
    /** A school day's background: 25 others tardy to Promise Time AM, 22 of them absent from Promise Time PM. */
    school(date, { fillers = 25, pm = true } = {}) {
      for (const f of FILL.slice(0, fillers)) w.mark(f.key, date, 1, "T");
      if (pm) for (const f of FILL.slice(0, Math.min(22, fillers))) w.mark(f.key, date, 10, "A");
    },
    rows: (t) => store.rows(t),
    reg: (key, date) => store.rows("perfectDays").find((r) => r.studentNumber === SN(key) && r.date === date) ?? null,
    hub: (key) => store.rows("students").find((r) => r.studentNumber === SN(key)),
    ledger: () => store.rows("legacyMirror").filter((r) => String(r.doc).startsWith("cash_tx_")),
    jobLedger: () => w.ledger().filter((r) => r.payload?.kind === "attendance"),
    payouts: (key) => store.rows("perfectDayPayouts").filter((p) => !key || p.studentNumber === SN(key)),
    dateRec: (date) => store.rows("perfectDayDates").find((d) => d.date === date) ?? null,
    state: () => store.rows("appState").find((r) => r.key === "perfectDay:state")?.value ?? {},
    lastRun: () => [...w.jobLog].reverse().find((j) => j.path === "perfectDayRead.run")?.out ?? null,
  };
  for (const h of holidays) w.holiday = h;
  w.fetch = async (url, init) => {
    if (w.down && w.down(String(url))) {
      return { ok: false, status: 503, json: async () => ({ message: "down" }), text: async () => "down", headers: { get: () => null } };
    }
    return fake.fetch(url, init);
  };
  return w;
}
function hubRow(s, o = {}) {
  return {
    legacyId: s.sn, studentNumber: s.sn, firstName: `First${s.key}`, lastName: "Test", grade: String(s.grade),
    email: `s${s.sn}@westbrookacademy.org`, pbisTickets: 0, attendanceTickets: 0, academicTickets: 0, bigRaffleQualified: [],
    wildcatCashBalance: 1000, wildcatCashEarned: 1000, wildcatCashSpent: 0, wildcatCashDeducted: 0, wildcatCashTransactions: [], ...o,
  };
}

/** The 13:30 UTC attendance rebuild: the Perfect Attendance screen's table, by the rebuild's own classification. */
async function rebuildScreen(w, atIso, { writing = false } = {}) {
  clock.set(atIso);
  for (const r of w.store.rows("psAttendanceMarks")) await w.store.db.delete(r._id);
  const day = laOf(Date.parse(atIso)).date;
  for (const s of ALL) {
    const ps = w.fake.tables.students.find((x) => x.id === s.psId);
    const exit = ps.exitdate;
    if (exit <= day) continue;                      // the current roster only, as the rebuild reads it
    const m = { absent: new Set(), exAbs: new Set(), unexAbs: new Set(), tardy: new Set(), exTardy: new Set(), unexTardy: new Set() };
    for (const r of w.fake.tables.attendance.filter((x) => x.studentid === s.psId)) {
      const c = CODE_BY_ID[r.attendance_codeid];
      if (!c) continue;
      const absent = c.presence_status_cd === "Absent", tardy = !absent && /tardy/i.test(c.description), excused = /excus/i.test(c.description);
      if (absent) { m.absent.add(r.att_date); (excused ? m.exAbs : m.unexAbs).add(r.att_date); }
      if (tardy) { m.tardy.add(r.att_date); (excused ? m.exTardy : m.unexTardy).add(r.att_date); }
    }
    for (const d of w.screenExtra[s.key] ?? []) { m.absent.add(d); m.unexAbs.add(d); }
    const L = (x) => [...x].sort();
    await w.store.db.insert("psAttendanceMarks", {
      studentNumber: s.sn, entryDate: ps.entrydate, absentDates: L(m.absent), excusedAbsentDates: L(m.exAbs), tardyDates: L(m.tardy),
      excusedTardyDates: L(m.exTardy), unexcusedAbsentDates: L(m.unexAbs), unexcusedTardyDates: L(m.unexTardy), syncedAt: atIso,
    });
  }
  const rec = { runId: "att_" + atIso, startedAt: atIso, finishedAt: atIso, ok: true, stage: "done" };
  const row = w.store.rows("appState").find((r) => r.key === "attendanceRebuild");
  // `writing`: a later rebuild holds the write lock when the tick reads (a retry still writing at 14:42).
  const value = { lastOk: rec, last: rec, writing: writing ? { runId: "att_w", startedAt: new Date(Date.parse(atIso) + 70 * 60000).toISOString() } : null };
  if (row) await w.store.db.patch(row._id, { value }); else await w.store.db.insert("appState", { key: "attendanceRebuild", value, mirroredAt: atIso });
}

async function runJobs(w) {
  for (;;) {
    const due = w.rt.jobs.filter((j) => j.at <= Date.now() + 1).sort((a, b) => a.at - b.at)[0];
    if (!due) return;
    w.rt.jobs.splice(w.rt.jobs.indexOf(due), 1);
    globalThis.fetch = w.fetch;
    const out = await w.rt.run(due.path, due.args);
    w.jobLog.push({ at: clock.iso, path: due.path, out });
  }
}
async function tick(w, iso) {
  clock.set(iso);
  globalThis.fetch = w.fetch;
  const t = await w.rt.run("perfectDay.tick", {});
  await runJobs(w);
  return t;
}
/** A school morning: the rebuild at 13:30 UTC, then the tick at 14:42 UTC. */
async function morning(w, date, o = {}) {
  await rebuildScreen(w, `${date}T13:30:00Z`, o);
  return tick(w, `${date}T14:42:00Z`);
}
async function configure(w, iso, args) {
  clock.set(iso);
  return w.rt.run("perfectDay.configure", { actorName: "Ada Admin", ...args });
}
async function status(w) { return w.rt.run("perfectDay.status", {}); }
async function studentView(w, key, iso) {
  clock.set(iso);
  w.rt.signIn({ issuer: "https://accounts.google.com", email: `s${SN(key)}@westbrookacademy.org` });
  try { return await w.rt.run("views_app.myStudentView", {}); } finally { w.rt.signIn(null); }
}
const paidDates = (w, key) => w.store.rows("perfectDays").filter((r) => r.studentNumber === SN(key) && r.status === "paid").map((r) => r.date).sort();

// The shipped analytics filter, lifted out of script.js (read-only), the way cash-analytics-fixes.test.mjs does.
function liftFn(src, name) {
  const m = new RegExp("\\n        (?:async )?function " + name + "\\(").exec(src);
  if (!m) throw new Error("missing function " + name);
  const start = m.index + 1;
  return src.slice(start, src.indexOf("\n        }\n", start) + 10);
}
const scriptSrc = read("./script.js");
const analytics = new Function(liftFn(scriptSrc, "isCashBehaviourRow") + "\n" + liftFn(scriptSrc, "cashBehaviourKind")
  + "\nfunction reversedCashIds() { return new Set(); }\nreturn { isCashBehaviourRow, cashBehaviourKind };")();

try {
// ===========================================================================
console.log("\nA. SHADOW FOR A WEEK, THEN LIVE: SHADOW NEVER PAYS; THE WEEK IS PAID ONCE\n");
{
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-19", "2026-11-06")) w.school(d);
  w.mark("S3", "2026-10-27", 1, "T");    // late to school
  w.mark("S4", "2026-10-28", 3, "X");    // an excused absence
  w.mark("S5", "2026-10-27", 2, "D");    // an excused tardy: still perfect
  w.mark("S6", "2026-10-29", 4, "F");    // a field trip: still perfect
  w.mark("S7", "2026-10-28", 5, "K");    // ditching
  w.mark("S8", "2026-10-30", 10, "A");   // Promise Time PM
  const auditBefore = w.rows("appAuditLog").length;

  const off = await tick(w, "2026-10-19T14:42:00Z");
  check("switched off (the default, no settings row): the tick reads one row and does nothing", off.do === "none" && w.rows("perfectDayRuns").length === 0);
  const on = await configure(w, "2026-10-19T14:00:00Z", { mode: "shadow" });
  check("shadow switched on, counting from the day of the switch", on.ok && on.settings.countFromDate === "2026-10-19", J(on));
  for (const d of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) await morning(w, d);
  const shadowRows = w.rows("perfectDays");
  check("shadow decides every school day: 12 students x 4 days, every one UNPAYABLE (shadow)",
    shadowRows.length === 48 && shadowRows.every((r) => r.status === "unpayable" && r.payable === false && r.stampWhy === "shadow"), J(shadowRows.length));
  check("shadow moves no money: no ledger row, no payout, no balance changed",
    w.jobLedger().length === 0 && w.payouts().length === 0 && TEST.every((s) => w.hub(s.key).wildcatCashBalance === 1000));
  const sv = await studentView(w, "S1", "2026-10-23T18:00:00Z");
  check("in shadow the student is promised nothing (perfectDays null)", sv.wildcatCash.perfectDays === null, J(sv.wildcatCash.perfectDays));
  const shadowSt = await status(w);
  check("THE ADMIN STATUS IN SHADOW HAS NO PAYDAY: no date (never one gone by), and no day counted as not paid",
    shadowSt.nextPayday.payWeek === null && shadowSt.nextPayday.date === null && shadowSt.nextPayday.students === 0
    && J(shadowSt.nextPayday.earnedNotPaid) === "{}", J(shadowSt.nextPayday));

  const live = await configure(w, "2026-10-26T13:00:00Z", { mode: "live" });
  check("live from Monday 10/26", live.ok && live.settings.liveFrom === "2026-10-26" && live.settings.countFromDate === "2026-10-19");
  const liveSt = await status(w);
  check("...live, the real next payday: today's run, still to come at 06:00", liveSt.nextPayday.date === "2026-10-26" && liveSt.nextPayday.payWeek === "2026-10-26",
    J(liveSt.nextPayday));
  await morning(w, "2026-10-26");
  const paidSt = await status(w);
  check("...and once it has run, the Monday after (across the clock change)", paidSt.nextPayday.date === "2026-11-02" && paidSt.nextPayday.payWeek === "2026-11-02",
    J(paidSt.nextPayday));
  check("SHADOW TO LIVE NEVER BACK-PAYS: Friday 10/23, decided after the switch, is not payable (before-start)",
    w.rows("perfectDays").filter((r) => r.date === "2026-10-23").every((r) => r.status === "unpayable" && r.stampWhy === "before-start")
    && w.rows("perfectDays").filter((r) => r.date === "2026-10-23").length === 12);
  check("...and Monday's payday moved nothing", w.jobLedger().length === 0 && w.state().lastPayWeek === "2026-10-26");
  for (const d of ["2026-10-27", "2026-10-28", "2026-10-29"]) await morning(w, d);
  const view = await studentView(w, "S1", "2026-10-29T18:00:00Z");
  check("the student sees this week's perfect days as pending from the morning each is decided, and when it arrives",
    J(view.wildcatCash.perfectDays) === J({ days: ["2026-10-26", "2026-10-27", "2026-10-28"], amount: 300, payday: "2026-11-02" }), J(view.wildcatCash.perfectDays));
  check("...the student's other wallet fields are as they were", view.wildcatCash.balance === 1000 && Array.isArray(view.wildcatCash.recent));
  check("a student outside the scope of money (a filler never perfect) still gets the field, empty", await (async () => {
    const v = await studentView(w, "F1", "2026-10-29T18:00:00Z");
    return J(v.wildcatCash.perfectDays) === J({ days: [], amount: 0, payday: null });
  })());
  await morning(w, "2026-10-30");

  const t = await morning(w, "2026-11-02");   // 14:42 UTC is 06:42 PST: the clock changed on Sunday
  check("DST: Monday 11/2 at 14:42 UTC (06:42 PST) runs, decides Friday 10/30 and pays", t.do === "run" && t.today === "2026-11-02"
    && w.reg("S1", "2026-10-30")?.status === "paid", J(t));
  const expect = { S1: 5, S2: 5, S3: 4, S4: 4, S5: 5, S6: 5, S7: 4, S8: 4, S9: 5, S10: 5, S11: 5, S12: 5 };
  check("each student is paid exactly the week's perfect days (T, X, K and a PM absence break a day; D and F do not)",
    Object.entries(expect).every(([k, n]) => paidDates(w, k).length === n && paidDates(w, k).every((d) => d >= "2026-10-26" && d <= "2026-10-30")),
    J(Object.fromEntries(TEST.map((s) => [s.key, paidDates(w, s.key)]))));
  check("ONE movement per student for the week, and one ledger row each", TEST.every((s) => w.payouts(s.key).length === 1) && w.jobLedger().length === 12);
  check("no shadow-era day is ever paid", !w.rows("perfectDays").some((r) => r.date < "2026-10-26" && r.status === "paid"));
  const h = w.hub("S1");
  const last = h.wildcatCashTransactions[h.wildcatCashTransactions.length - 1];
  check("the counters moved by the week's total from the server's own numbers: balance and earned +$500",
    h.wildcatCashBalance === 1500 && h.wildcatCashEarned === 1500 && h.wildcatCashSpent === 0 && h.wildcatCashDeducted === 0);
  check("the wallet line: 'Perfect attendance — 5 days', the days, by Wildcat Hub (attendance)",
    last.behaviorName === "Perfect attendance — 5 days" && last.notes === "Mon 10/26, Tue 10/27, Wed 10/28, Thu 10/29, Fri 10/30"
    && last.teacherName === "Wildcat Hub (attendance)" && last.kind === "attendance" && last.amount === 500 && last.balanceAfter === 1500, J(last));
  const lrow = w.jobLedger().find((r) => r.payload.studentId === SN("S1"));
  check("the ledger row is the same row, in the payday's week document, with NO key", lrow && lrow.doc === "cash_tx_2026_W45" && lrow.key === undefined
    && lrow.payload.id === last.id && lrow.payload.timestamp.slice(0, 10) === "2026-11-02");
  check("the student's own card shows it, and nothing pending any more", await (async () => {
    const v = await studentView(w, "S1", "2026-11-02T18:00:00Z");
    return v.wildcatCash.recent[0].reason === "Perfect attendance — 5 days" && v.wildcatCash.recent[0].by === "Wildcat Hub (attendance)"
      && v.wildcatCash.perfectDays.days.length === 0 && v.wildcatCash.balance === 1500;
  })());
  const again = await tick(w, "2026-11-02T15:42:00Z");
  const forced = await (async () => { clock.set("2026-11-02T20:00:00Z"); const r = await w.rt.run("perfectDay.runNow", { actorName: "Ada Admin" }); await runJobs(w); return r; })();
  check("the second tick does nothing, and a run by hand the same day pays nobody again",
    again.do === "none" && forced.do === "run" && w.jobLedger().length === 12 && w.hub("S1").wildcatCashBalance === 1500);
  check("STAFF ANALYTICS LEAVE IT OUT: the shipped isCashBehaviourRow calls every row bookkeeping, on every open tab",
    w.jobLedger().every((r) => analytics.isCashBehaviourRow(r.payload, new Set()) === false && analytics.cashBehaviourKind(r.payload, new Set()) === null));
  check("...while a teacher's award still counts (control)", analytics.cashBehaviourKind({ id: "x", kind: "award", amount: 100, behaviorId: "wc1" }, new Set()) === "award");
  check("the job wrote no audit entry per student (summary off), no award command, and no cashApplied",
    w.rows("appAuditLog").length === auditBefore && w.rows("cashAwardCommands").length === 0 && TEST.every((s) => w.hub(s.key).cashApplied === undefined));
  check("EARLY WARNING READS NO CASH, so the award can never be a praise signal there",
    !/legacyMirror|wildcatCash|cash_tx_|cashTransactions/.test(read("./convex/earlyWarning.ts"))
    && !/wildcatCash|cashTransactions|isCashBehaviourRow/.test(read("./wildcat-discipline.js")));
  check("the job never writes the settings row every staff tab watches", !w.rows("appState").some((r) => r.key === "liveSettings") && !w.rows("legacyMirror").some((r) => r.doc === "settings"));

  // A tab loaded before the payday saves an award afterwards: both amounts survive.
  clock.set("2026-11-02T19:00:00Z");
  w.rt.signIn({ issuer: STAFF_ISSUER, email: "teacher@school.test" });
  const award = { id: "txn_1793732400000_abc12", at: "2026-11-02T19:00:00.000Z", amount: 100, kind: "award" };
  const save = await w.rt.run("appData.save", { students: [{ id: SN("S1"), cashMovements: [award],
    cashDelta: { wildcatCashBalance: 100, wildcatCashEarned: 100 },
    wildcatCashTransactions: [{ id: award.id, timestamp: award.at, amount: 100, kind: "award", behaviorId: "wc1", teacherId: "T2", studentId: SN("S1") }] }] });
  w.rt.signIn(null);
  const after = w.hub("S1");
  check("A STALE TAB'S SAVE AFTER THE PAYDAY KEEPS BOTH: the award adds $100 on top, and the history keeps the payment",
    after.wildcatCashBalance === 1600 && after.wildcatCashTransactions.some((r) => r.kind === "attendance") && after.wildcatCashTransactions.some((r) => r.id === award.id),
    J({ bal: after.wildcatCashBalance, save: save?.movementsApplied }));
  const st = await status(w);
  check("the status says it in counts: last run ok, the week paid, nothing held, no controls paid",
    st.runs[0].ok === true && st.lastPayWeek === "2026-11-02" && st.held.count === 0 && st.controls.paidMovements === 0 && st.dates.length > 0, J(st.runs[0]));
  check("...and the ledger check finds every attendance row's payment", w.lastRun()?.summary?.ledgerCheck?.ok === true && w.lastRun().summary.ledgerCheck.attendanceRows === 12,
    J(w.lastRun()?.summary?.ledgerCheck));
}

// ===========================================================================
console.log("\nB. LIVE, OFF FOR TWO DAYS, ON AGAIN: THE PAUSE IS NEVER BACK-PAID, AND WHAT WAS EARNED IS NOT TAKEN BACK\n");
{
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-19", "2026-11-06")) w.school(d);
  await configure(w, "2026-10-19T14:00:00Z", { mode: "live", auditSummary: true });
  await morning(w, "2026-10-20");
  await morning(w, "2026-10-21");
  check("live: 10/19 and 10/20 are pending for every student", w.rows("perfectDays").filter((r) => r.status === "pending").length === 24);
  const k = await configure(w, "2026-10-21T16:00:00Z", { mode: "off" });
  check("the kill switch: mode off, instantly", k.ok && k.settings.mode === "off");
  const t1 = await morning(w, "2026-10-22"); const t2 = await morning(w, "2026-10-23");
  check("switched off, the mornings do nothing", t1.do === "none" && t2.do === "none" && !w.rows("perfectDays").some((r) => r.date >= "2026-10-21"));
  const sneaky = await configure(w, "2026-10-26T13:00:00Z", { mode: "live", countFromDate: "2026-10-19" });
  check("switching back on from an earlier date without backPay is refused", sneaky.ok === false && /backPay/.test(sneaky.reason));
  const offView = await studentView(w, "S1", "2026-10-23T18:00:00Z");
  const offStatus = await status(w);
  check("while off, nothing is promised to the student, and the status counts the earned days as waiting",
    offView.wildcatCash.perfectDays === null && offStatus.nextPayday.earnedNotPaid.off === 24 && offStatus.nextPayday.students === 0, J(offStatus.nextPayday));
  const back = await configure(w, "2026-10-26T13:05:00Z", { mode: "live" });
  check("switched back on, counting from the day it came back", back.ok && back.settings.countFromDate === "2026-10-26");
  const onView = await studentView(w, "S1", "2026-10-26T13:10:00Z");
  check("...and the student is shown again the days earned before the pause, arriving today",
    J(onView.wildcatCash.perfectDays) === J({ days: ["2026-10-19", "2026-10-20"], amount: 200, payday: "2026-10-26" }), J(onView.wildcatCash.perfectDays));
  await morning(w, "2026-10-26");
  check("A SWITCH OFF/ON NEVER BACK-PAYS THE PAUSE: no day from the switch-off on (10/21-10/23) is ever decided",
    !w.rows("perfectDays").some((r) => r.date >= "2026-10-21" && r.date <= "2026-10-23"));
  check("NO SWITCH TAKES BACK WHAT WAS EARNED: Monday's payday pays the 10/19-10/20 days decided before the pause",
    TEST.every((s) => J(paidDates(w, s.key)) === J(["2026-10-19", "2026-10-20"])) && w.jobLedger().length === 12 && w.hub("S1").wildcatCashBalance === 1200,
    J(paidDates(w, "S1")));
  const st = await status(w);
  check("...and nothing is left waiting on the status", st.nextPayday.students === 0 && J(st.nextPayday.earnedNotPaid) === "{}", J(st.nextPayday));
  // THE ADMIN CARD'S QUERY (the browser half): the same answer, admins only.
  const asCaller = async (email) => {
    w.rt.signIn(email ? { issuer: STAFF_ISSUER, email } : null);
    try { return { ok: true, value: await w.rt.run("perfectDay.adminStatus", {}) }; }
    catch (e) { return { ok: false, why: String(e?.data ?? e?.message ?? e) }; }
    finally { w.rt.signIn(null); }
  };
  const asAdmin = await asCaller("admin@school.test"), asTeacher = await asCaller("teacher@school.test"), asNobody = await asCaller(null);
  check("THE ADMIN CARD: perfectDay:adminStatus gives an admin exactly the command line's status",
    asAdmin.ok && J(asAdmin.value) === J(st), asAdmin.why);
  check("...and refuses a teacher and a caller who is not signed in, with no figures",
    !asTeacher.ok && /Admins only/.test(asTeacher.why) && !asNobody.ok, J({ asTeacher, asNobody }));
  for (const d of ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02"]) await morning(w, d);
  check("the next payday pays the days from the switch-on, 10/26-10/30, and never a day of the pause",
    TEST.every((s) => J(paidDates(w, s.key)) === J(["2026-10-19", "2026-10-20", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]))
    && TEST.every((s) => w.payouts(s.key).length === 2) && w.jobLedger().length === 24, J(paidDates(w, "S1")));
  const entries = w.rows("appAuditLog").filter((e) => e.payload?.action === "perfect_day_paid");
  check("with the summary switched on: ONE audit entry per payday, counts only, from the system, never per student",
    entries.length === 2 && entries.every((e) => e.payload.teacherId === "system:attendance" && !("ticketCount" in e.payload)
      && e.payload.behavior === "Perfect attendance (automatic)" && e.payload.notes === e.payload.reason)
    && /12 students, 24 perfect days/.test(entries[0].payload.reason) && /12 students, 60 perfect days/.test(entries[1].payload.reason)
    && w.rows("appAuditLog").length === 2, J(entries.map((e) => e.payload.reason)));
}

// ===========================================================================
console.log("\nC. A PILOT WITH A CONTROL: STAMPED AMOUNTS, ONCE PER STUDENT-WEEK, CORRECTIONS\n");
{
  const w = await makeWorld({ mods: crashy.mods });
  for (const d of weekdaysBetween("2026-10-19", "2026-11-06")) w.school(d);
  w.mark("S3", "2026-10-20", 1, "T");
  w.mark("S2", "2026-10-21", 2, "D");
  w.mark("S1", "2026-10-22", 4, "F");
  w.mark("S7", "2026-10-21", 5, "K");
  const p = await configure(w, "2026-10-19T14:00:00Z", { mode: "pilot", pilotAdd: [SN("S1"), SN("S2"), SN("S3"), SN("S7")], controls: [SN("S4")] });
  check("a pilot of four, with a control", p.ok && p.settings.pilot === 4 && p.settings.controls === 1, J(p));
  for (const d of ["2026-10-20", "2026-10-21", "2026-10-22"]) await morning(w, d);
  const amt = await configure(w, "2026-10-22T16:00:00Z", { amount: 150 });
  check("the amount changed to $150 with no deploy", amt.ok && amt.settings.amount === 150);
  await morning(w, "2026-10-23");
  check("AMOUNT STAMPED AT DECISION TIME: days decided before the change keep $100, after it $150",
    w.reg("S1", "2026-10-21")?.amount === 100 && w.reg("S1", "2026-10-22")?.amount === 150 && w.reg("S1", "2026-10-19")?.amount === 100);
  check("outside the pilot and the control: decided, never payable",
    w.reg("S5", "2026-10-19")?.status === "unpayable" && w.reg("S5", "2026-10-19")?.stampWhy === "outside-pilot"
    && w.reg("S4", "2026-10-19")?.status === "unpayable" && w.reg("S4", "2026-10-19")?.stampWhy === "control");

  // Monday: the run is killed after the first batch of two.
  let calls = 0;
  globalThis.__killPayBatch = () => (++calls === 2);
  await morning(w, "2026-10-26");
  const firstPaid = TEST.filter((s) => w.payouts(s.key).length > 0).map((s) => s.key);
  check("killed mid-payday: the batch that finished is paid, the one that died wrote nothing, and payday is not marked done",
    firstPaid.length === 2 && w.jobLedger().length === 2 && w.state().lastPayWeek !== "2026-10-26" && w.lastRun()?.ok === false, J({ firstPaid, s: w.state() }));
  globalThis.__killPayBatch = null;
  await tick(w, "2026-10-26T15:42:00Z");
  check("the next tick finishes the payday: every pilot student paid ONCE",
    ["S1", "S2", "S3", "S7"].every((k) => w.payouts(k).length === 1) && w.jobLedger().length === 4 && w.state().lastPayWeek === "2026-10-26");
  check("...at the amounts stamped on each day: $600, $600, $500 (late to school on 10/20), $500 (K on 10/21)",
    w.payouts("S1")[0].amount === 600 && w.payouts("S2")[0].amount === 600 && w.payouts("S3")[0].amount === 500 && w.payouts("S7")[0].amount === 500
    && w.hub("S1").wildcatCashBalance === 1600, J(["S1", "S2", "S3", "S7"].map((k) => w.payouts(k)[0]?.amount)));
  check("the control and the students outside the pilot moved nothing",
    w.payouts("S4").length === 0 && w.payouts("S5").length === 0 && w.hub("S4").wildcatCashBalance === 1000 && w.hub("S5").wildcatCashBalance === 1000);

  // Tuesday: S3's tardy on 10/20 is corrected to present; a second payday this week is attempted.
  w.unmark("S3", "2026-10-20", 1);
  const stRow = w.rows("appState").find((r) => r.key === "perfectDay:state");
  await w.store.db.patch(stRow._id, { value: { ...stRow.value, lastPayWeek: "2026-10-19" } });
  await morning(w, "2026-10-27");
  check("a late correction makes 10/20 pending again (paid next week)", w.reg("S3", "2026-10-20")?.status === "pending");
  check("PAYOUT IS EXACTLY ONCE PER STUDENT-WEEK: a second payday the same week pays S3 nothing more",
    w.payouts("S3").length === 1 && w.hub("S3").wildcatCashBalance === 1500 && w.lastRun()?.summary?.pay?.alreadyPaidThisWeek === 1, J(w.lastRun()?.summary?.pay));

  // Wednesday: an office mark lands on a day already paid.
  w.mark("S1", "2026-10-22", 6, "K");
  await morning(w, "2026-10-28");
  check("a PAID day that later breaks is never taken back automatically: it is flagged for an admin",
    w.reg("S1", "2026-10-22")?.status === "paid" && w.reg("S1", "2026-10-22")?.afterPayBroken === true && w.hub("S1").wildcatCashBalance === 1600);
  let st = await status(w);
  check("...and is on the admin's paid-then-broken list", st.paidThenBroken.count === 1 && st.paidThenBroken.list[0].studentNumber === SN("S1")
    && st.paidThenBroken.list[0].date === "2026-10-22", J(st.paidThenBroken));
  clock.set("2026-10-28T18:00:00Z");
  const txn = w.payouts("S1")[0].txnId;
  const bad = await w.rt.run("perfectDay.correctPayout", { txnId: txn, removeDates: ["2026-10-29"], reason: "wrong day", actorName: "Ada Admin" });
  check("a correction must name a day the payment paid", bad.ok === false && bad.code === "bad_dates");
  const fix = await w.rt.run("perfectDay.correctPayout", { txnId: txn, removeDates: ["2026-10-22"], reason: "ditching entered late", actorName: "Ada Admin" });
  const s1 = w.hub("S1");
  check("THE ADMIN TAKES ONE DAY BACK: the week is reversed and the four days that stand are paid again ($450)",
    fix.ok && fix.reversed === true && J(fix.repaid) === J(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-23"])
    && s1.wildcatCashBalance === 1450 && s1.wildcatCashEarned === 1450, J({ fix, bal: s1.wildcatCashBalance, earned: s1.wildcatCashEarned }));
  const s1Ledger = w.ledger().filter((r) => r.payload.studentId === SN("S1")).map((r) => `${r.payload.kind}:${r.payload.amount}`);
  check("...three ledger rows: the payment, its reversal, the replacement", J(s1Ledger) === J(["attendance:600", "reversal:-600", "attendance:450"]), J(s1Ledger));
  check("...the removed day is removed, the rest point at the replacement",
    w.reg("S1", "2026-10-22")?.status === "removed" && w.reg("S1", "2026-10-21")?.paidTxnId === fix.replacedBy && w.rows("cashReversals").length === 1);
  st = await status(w);
  check("...and the paid-then-broken list is empty again (handled)", st.paidThenBroken.count === 0 && st.paidThenBroken.handled === 0, J(st.paidThenBroken));
  const twice = await w.rt.run("perfectDay.correctPayout", { txnId: txn, removeDates: ["2026-10-22"], reason: "again", actorName: "Ada Admin" });
  check("a payment cannot be corrected twice", twice.ok === false && twice.code === "already_corrected");

  // The admin Reverse button on a weekly payment works unchanged, and a reversed week is never re-paid by the job.
  const s2txn = w.payouts("S2")[0].txnId;
  const rev = await w.rt.run("cashReversal.reverseAsAdmin", { originalTxnId: s2txn, reason: "testing the button", actorName: "Ada Admin" });
  check("THE ADMIN REVERSE BUTTON undoes a weekly payment, found by its id", rev.ok === true && rev.reversalAmount === -600 && w.hub("S2").wildcatCashBalance === 1000, J(rev));
  const repay = await w.rt.run("perfectDay.correctPayout", { txnId: s2txn, removeDates: ["2026-10-19"], reason: "only Monday was wrong", actorName: "Ada Admin" });
  check("...and correctPayout after the button re-pays the days that stand, without reversing twice",
    repay.ok && repay.reversed === false && w.hub("S2").wildcatCashBalance === 1500 && w.rows("cashReversals").length === 2, J({ repay, bal: w.hub("S2").wildcatCashBalance }));

  // The office takes the K back off: the removed day is never paid again.
  w.unmark("S1", "2026-10-22", 6);
  for (const d of ["2026-10-29", "2026-10-30", "2026-11-02"]) await morning(w, d);
  check("A REMOVED DAY IS NEVER PAID AGAIN, even once it reads perfect", w.reg("S1", "2026-10-22")?.status === "removed"
    && !w.payouts("S1").some((p) => p.dates.includes("2026-10-22") && p.status === "paid"));
  // 10/20 was first found perfect on 10/27, after the change, so it carries $150.
  check("Monday 11/2 pays S3's corrected 10/20 with the new week, as one movement, at the amount stamped when it was first found perfect",
    w.payouts("S3").length === 2 && J(w.payouts("S3")[1].dates) === J(["2026-10-20", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"])
    && w.reg("S3", "2026-10-20")?.amount === 150 && w.payouts("S3")[1].amount === 6 * 150, J(w.payouts("S3").map((x) => [x.dates, x.amount])));
  st = await status(w);
  check("the controls were never paid", st.controls.paidMovements === 0 && w.hub("S4").wildcatCashBalance === 1000);
}

// ===========================================================================
console.log("\nD. THE SECOND CHECK AND THE CALENDAR\n");
{
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-19", "2026-11-06")) {
    if (d === "2026-10-22") continue;                                     // an unmarked holiday: no attendance at all
    if (d === "2026-10-27") { w.school(d, { pm: false }); continue; }     // Promise Time PM not entered yet
    if (d === "2026-10-28" || d === "2026-10-30") {                      // too few students marked to be true
      for (const f of FILL.slice(0, 7)) for (let slot = 1; slot <= 10; slot++) w.mark(f.key, d, slot, "A");
      continue;
    }
    w.school(d);
  }
  await configure(w, "2026-10-19T14:00:00Z", { mode: "live", lookbackSchoolDays: 5 });
  await morning(w, "2026-10-20");
  w.screenExtra = { S6: ["2026-10-20"] };     // the screen alone shows S6 absent on 10/20
  await morning(w, "2026-10-21");
  check("ONE DISAGREEMENT NEVER HOLDS THE SCHOOL: S6 is held, the other eleven are pending, the date is decided",
    w.reg("S6", "2026-10-20")?.status === "held" && TEST.filter((s) => s.key !== "S6").every((s) => w.reg(s.key, "2026-10-20")?.status === "pending")
    && w.dateRec("2026-10-20").state === "school");
  w.screenExtra = { S1: ["2026-10-21"], S2: ["2026-10-21"], S3: ["2026-10-21"], S4: ["2026-10-21"], S5: ["2026-10-21"] };
  await morning(w, "2026-10-22");
  check("...the next run settles S6 once the two agree", w.reg("S6", "2026-10-20")?.status === "pending");
  check("a disagreement about more than 1% of the school holds the date, and decides nothing for it",
    w.dateRec("2026-10-21").state === "held" && !w.rows("perfectDays").some((r) => r.date === "2026-10-21"), w.dateRec("2026-10-21")?.reason);
  w.screenExtra = {};
  const fri = await morning(w, "2026-10-23");
  check("...and decides it once they agree", TEST.every((s) => w.reg(s.key, "2026-10-21")?.status === "pending"));
  check("A HOLIDAY IS NOT A FAILED READ: Thursday 10/22 (no attendance) is no school, not held, not retried",
    w.dateRec("2026-10-22")?.state === "no-school" && w.dateRec("2026-10-22")?.retryable === false && w.state().lastDoneDate === "2026-10-23", J(w.dateRec("2026-10-22")));
  const again = await tick(w, "2026-10-23T15:42:00Z");
  check("...so the 15:42 tick has nothing to do", again.do === "none" && /done/.test(again.why), J(again));

  // Monday: PowerSchool will not serve Friday's attendance.
  w.down = (u) => /att_date%3D%3D2026-10-23/.test(u) && !/\/count\?/.test(u);
  const m1 = await morning(w, "2026-10-26");
  check("A FAILED READ IS HELD AND RETRIED: Friday is held (retryable), and Monday's payday waits for it at 07:42",
    w.dateRec("2026-10-23")?.state === "held" && w.dateRec("2026-10-23")?.retryable === true && w.jobLedger().length === 0
    && w.lastRun()?.summary?.payday?.due === false && w.state().lastDoneDate !== "2026-10-26", J({ m1, d: w.dateRec("2026-10-23") }));
  await tick(w, "2026-10-26T15:42:00Z");
  check("...the 08:42 tick tries again (still down) and still waits", w.jobLedger().length === 0 && w.rows("perfectDayRuns").length >= 2);
  await tick(w, "2026-10-26T16:42:00Z");
  check("...at 09:42 payday pays what is settled, without Friday", w.jobLedger().length === 12 && TEST.every((s) => !paidDates(w, s.key).includes("2026-10-23"))
    && w.state().lastPayWeek === "2026-10-26");
  w.down = null;
  await morning(w, "2026-10-27");
  check("...and once PowerSchool answers, Friday is decided (it is paid next week)", TEST.every((s) => w.reg(s.key, "2026-10-23")?.status === "pending"));

  await morning(w, "2026-10-28");
  check("a block far below its usual level holds the day (Promise Time PM not entered)", w.dateRec("2026-10-27")?.state === "held" && /Block 10/.test(w.dateRec("2026-10-27").reason)
    && !w.rows("perfectDays").some((r) => r.date === "2026-10-27"), w.dateRec("2026-10-27")?.reason);
  for (const f of FILL.slice(0, 22)) w.mark(f.key, "2026-10-27", 10, "A");   // entered late, in bulk
  await morning(w, "2026-10-29", { writing: true });
  check("A DAY THAT LOOKS TOO PERFECT IS HELD, NOT PAID (10/28: 7 students marked against a usual 25)",
    w.dateRec("2026-10-28")?.state === "held" && /too perfect/.test(w.dateRec("2026-10-28").reason) && !w.rows("perfectDays").some((r) => r.date === "2026-10-28"));
  check("with no second check (the rebuild was writing), the late-entered 10/27 is HELD, not pending",
    TEST.every((s) => w.reg(s.key, "2026-10-27")?.status === "held" && w.reg(s.key, "2026-10-27")?.why === "second-check-unavailable"), J(w.reg("S1", "2026-10-27")));
  check("...while nothing already pending was made payable or unpaid by it", TEST.every((s) => w.reg(s.key, "2026-10-26")?.status === "pending"));
  await morning(w, "2026-10-30");
  check("...the next run, with the second check, makes them pending", TEST.every((s) => w.reg(s.key, "2026-10-27")?.status === "pending"));
  clock.set("2026-11-02T13:00:00Z");
  const any = await w.rt.run("perfectDay.decideAnyway", { date: "2026-10-30", reason: "a minimum day, half the school on a trip", actorName: "Ada Admin" });
  await morning(w, "2026-11-02");
  check("DECIDE ANYWAY: an admin's word decides a held date, student by student", any.ok && TEST.every((s) => w.reg(s.key, "2026-10-30")?.status === "paid"));
  check("the 11/2 payday pays Friday 10/23 late, the re-entered 10/27, and every settled day; never the holiday or the held 10/28",
    TEST.every((s) => { const d = paidDates(w, s.key); return d.includes("2026-10-23") && d.includes("2026-10-27") && !d.includes("2026-10-22") && !d.includes("2026-10-28"); }),
    J(paidDates(w, "S1")));
  for (const d of ["2026-11-03", "2026-11-04", "2026-11-05"]) await morning(w, d);
  check("A HOLD NEVER LASTS FOR EVER: 10/28 expired once it left the lookback, unpaid",
    w.dateRec("2026-10-28")?.state === "expired" && !w.rows("perfectDays").some((r) => r.date === "2026-10-28"), J(w.dateRec("2026-10-28")));
}

// ===========================================================================
console.log("\nE. LEAVERS AND HUB RECORDS: PAID WHILE THEY HAVE A RECORD, NEVER A GUESS\n");
{
  const w = await makeWorld({ exits: { S8: "2026-10-22" } });
  for (const d of weekdaysBetween("2026-10-19", "2026-11-06")) w.school(d);
  await configure(w, "2026-10-19T14:00:00Z", { mode: "live" });
  for (const d of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) await morning(w, d);
  check("a student who left on 10/22 earned 10/19-10/21 and nothing after",
    J(w.rows("perfectDays").filter((r) => r.studentNumber === SN("S8")).map((r) => `${r.date}:${r.status}`).sort())
    === J(["2026-10-19:pending", "2026-10-20:pending", "2026-10-21:pending"]));
  const s9 = w.store.rows("students").find((r) => r.studentNumber === SN("S9"));
  await w.store.db.delete(s9._id);
  await w.store.db.insert("students", hubRow(BY_KEY.S10, { legacyId: "dup-" + SN("S10") }));
  await morning(w, "2026-10-26");
  check("THE LEAVER IS PAID what they earned while enrolled (they still have a Hub record)", w.payouts("S8").length === 1 && w.payouts("S8")[0].amount === 300);
  check("a student with no Hub record is not paid, and nothing is dropped: the days stay pending, counted",
    w.payouts("S9").length === 0 && w.rows("perfectDays").filter((r) => r.studentNumber === SN("S9") && r.status === "pending").length === 5
    && w.lastRun().summary.pay.noHubRecord === 1);
  check("a student number on two Hub records is never paid a guess", w.payouts("S10").length === 0 && w.lastRun().summary.pay.ambiguous === 1);
  await w.store.db.insert("students", hubRow(BY_KEY.S9));
  for (const d of ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02"]) await morning(w, d);
  check("...once the record is back, the next payday pays every day still owed", w.payouts("S9").length === 1 && w.payouts("S9")[0].dates.length === 10);
}

// ===========================================================================
console.log("\nF. THE BROWSER CANNOT SEND THE RESERVED BEHAVIOUR, ON ANY WRITE PATH\n");
{
  const w = await makeWorld();
  clock.set("2026-10-20T18:00:00Z");
  w.rt.signIn({ issuer: STAFF_ISSUER, email: "teacher@school.test" });
  const at = "2026-10-20T18:00:00.000Z";
  const forged = { id: "txn_1792519200000_pdzz", timestamp: at, studentId: SN("S1"), amount: 5000, kind: "attendance", type: "positive",
    behaviorId: "system:perfect-day", behaviorName: "Perfect attendance — 50 days", teacherId: "system:attendance", teacherName: "Wildcat Hub (attendance)" };
  const honest = { id: "txn_1792519200001_ok1", timestamp: at, studentId: SN("S2"), amount: 100, kind: "award", type: "positive", behaviorId: "wc1", teacherId: "T2", notes: "helped" };
  const m = await w.rt.run("legacyData.mergeSlice", { doc: "cash_tx_2026_W43", collection: "transactions", dedupeField: "id",
    rows: [{ payload: forged }, { payload: { ...honest } }, { payload: { ...honest, id: "txn_1792519200002_ok2", kind: "award", teacherId: "system:attendance" } }] });
  const ids = w.ledger().map((r) => r.payload.id);
  check("THE BROWSER CANNOT SEND THE RESERVED BEHAVIOUR: mergeSlice refuses an attendance row, and a row naming the system as giver",
    m.refusedSystemCash === 2 && !ids.includes(forged.id) && !ids.includes("txn_1792519200002_ok2"), J(m));
  check("...while a teacher's ordinary award in the same save lands (control)", ids.includes(honest.id));
  const ss = await w.rt.run("legacyData.saveSlice", { doc: "cash_tx_2026_W43", collection: "transactions", rows: [{ payload: { ...forged, id: "txn_1792519200003_pdyy" } }] });
  check("...saveSlice refuses it too", ss.wrote === 0 && !w.ledger().some((r) => r.payload.id === "txn_1792519200003_pdyy"));
  const sv = await w.rt.run("appData.save", { students: [{ id: SN("S1"),
    cashMovements: [{ id: forged.id, at, amount: 5000, kind: "attendance" }], cashDelta: { wildcatCashBalance: 5000, wildcatCashEarned: 5000 },
    wildcatCashTransactions: [forged] }] });
  const s1 = w.hub("S1");
  check("...appData:save refuses the movement and the history row: no counter moves, no row is stored",
    s1.wildcatCashBalance === 1000 && s1.wildcatCashEarned === 1000 && !(s1.wildcatCashTransactions ?? []).some((r) => r.id === forged.id)
    && (sv.cashMovementsHeldWhy ?? []).some((r) => r.id === forged.id && r.why === "reserved_kind"), J({ bal: s1.wildcatCashBalance, held: sv.cashMovementsHeldWhy }));
  await w.store.db.insert("appState", { key: "cashAwardCommand", value: { enabled: true }, mirroredAt: at });
  let cmd;
  try {
    cmd = await w.rt.run("cashAward.award", { awards: [
      { studentId: SN("S1"), txnId: "txn_1792519200004_c1", at, amount: 100, kind: "award", behaviorId: "system:perfect-day", behaviorName: "x", notes: "a real note" },
      { studentId: SN("S1"), txnId: "txn_1792519200005_c2", at, amount: 100, kind: "attendance", behaviorId: "wc1", behaviorName: "x", notes: "a real note" },
    ] });
  } catch (e) { cmd = { error: String(e?.message || e) }; }
  check("...and the award command refuses both the reserved behaviour and the kind",
    cmd.results?.[0]?.code === "reserved_behavior" && cmd.results?.[1]?.code === "bad_kind" && w.hub("S1").wildcatCashBalance === 1000, J(cmd.results ?? cmd));
  w.rt.signIn(null);

  // The server's own row, sent back by every tab, changes nothing and is never rewritten.
  await w.store.db.insert("legacyMirror", { doc: "cash_tx_2026_W43", collection: "transactions", payload: { ...forged, id: "txn_1792519200009_pdreal", amount: 400 }, mirroredAt: at });
  w.rt.signIn({ issuer: STAFF_ISSUER, email: "teacher@school.test" });
  const echo = await w.rt.run("legacyData.mergeSlice", { doc: "cash_tx_2026_W43", collection: "transactions", dedupeField: "id",
    rows: [{ payload: { ...forged, id: "txn_1792519200009_pdreal", amount: 4000, updatedAt: "2026-10-21T00:00:00Z" } }] });
  w.rt.signIn(null);
  check("...a stored payment is never rewritten by a browser copy, however new its stamp",
    w.ledger().find((r) => r.payload.id === "txn_1792519200009_pdreal").payload.amount === 400 && echo.updated === 0, J(echo));
}

// ===========================================================================
console.log("\nG. ONE RUN AT A TIME; A STALE RUN WRITES NOTHING; THE LEDGER CHECK\n");
{
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-19", "2026-10-30")) w.school(d);
  await configure(w, "2026-10-19T14:00:00Z", { mode: "live" });
  await rebuildScreen(w, "2026-10-20T13:30:00Z");
  clock.set("2026-10-20T14:42:00Z");
  const a = await w.rt.run("perfectDay.tick", {});
  const b = await w.rt.run("perfectDay.tick", {});
  check("two ticks at once book one run: the second sees the lease", a.do === "run" && b.do === "none" && /still going/.test(b.why), J(b));
  // The first run is stuck; its lease lapses (10 minutes) and a run by hand takes over.
  clock.set("2026-10-20T14:53:00Z");
  const c = await w.rt.run("perfectDay.runNow", { actorName: "Ada Admin" });
  const stale = w.rt.jobs.find((j) => j.args.runId === a.runId);
  w.rt.jobs.splice(w.rt.jobs.indexOf(stale), 1);
  await runJobs(w);                                  // the run by hand
  const before = w.rows("perfectDays").length;
  const beforeRows = J(w.rows("perfectDays"));
  globalThis.fetch = w.fetch;
  clock.set("2026-10-20T14:44:00Z");                 // the stuck run's reads come back, inside its own read budget
  const out = await w.rt.run(stale.path, stale.args); // and it tries to write
  check("A RUN THAT LOST ITS LEASE WRITES NOTHING", c.do === "run" && out.ok === false && /lease/.test(out.reason)
    && w.rows("perfectDays").length === before && J(w.rows("perfectDays")) === beforeRows, J(out.reason));
  await w.store.db.insert("legacyMirror", { doc: "cash_tx_2026_W43", collection: "transactions", mirroredAt: "x",
    payload: { id: "txn_1792519200000_pdforged", kind: "attendance", studentId: SN("S1"), amount: 100, timestamp: "2026-10-20T18:00:00Z" } });
  clock.set("2026-10-20T18:00:00Z");
  const lc = await w.rt.run("perfectDay.ledgerCheck", {});
  check("THE LEDGER CHECK: an attendance row with no payment behind it is found", lc.ok === false && lc.withoutPayout === 1 && lc.withoutPayoutIds[0] === "txn_1792519200000_pdforged", J(lc));
}

// ===========================================================================
console.log("\nH. THE ADMIN'S TOOLS: NO SCHOOL, REMOVE, SETTLE A HOLD, AND EVERY ACT RECORDED\n");
{
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-19", "2026-10-30")) {
    if (d === "2026-10-23") { for (const f of FILL.slice(0, 7)) for (let slot = 1; slot <= 10; slot++) w.mark(f.key, d, slot, "A"); continue; }
    w.school(d);
  }
  const nobody = await w.rt.run("perfectDay.configure", { actorName: "", mode: "live" });
  check("a change to the switch must say who made it", nobody.ok === false);
  await configure(w, "2026-10-19T14:00:00Z", { mode: "live" });
  await morning(w, "2026-10-20");
  w.screenExtra = { S2: ["2026-10-20"] };
  await morning(w, "2026-10-21");
  w.screenExtra = { S2: ["2026-10-20"], S3: ["2026-10-21"] };
  await morning(w, "2026-10-22");
  clock.set("2026-10-22T18:00:00Z");
  const refuse = await w.rt.run("perfectDay.markNoSchool", { date: "2026-10-20", reason: "it was a holiday", actorName: "Ada Admin" });
  check("NO SCHOOL IS REFUSED for a date with days already decided (it would stop the reads, not the money)", refuse.ok === false && refuse.decided === 12, J(refuse));
  const rm = await w.rt.run("perfectDay.removeDays", { studentNumber: SN("S1"), dates: ["2026-10-19", "2026-10-20"], reason: "office says not on site", actorName: "Ada Admin" });
  check("removeDays takes unpaid days out for good", rm.ok && J(rm.removed) === J(["2026-10-19", "2026-10-20"]) && w.reg("S1", "2026-10-19")?.status === "removed");
  const pay = await w.rt.run("perfectDay.resolveHeld", { studentNumber: SN("S2"), date: "2026-10-20", decision: "pay", reason: "the screen was out of date", actorName: "Ada Admin" });
  const drop = await w.rt.run("perfectDay.resolveHeld", { studentNumber: SN("S3"), date: "2026-10-21", decision: "drop", reason: "parent note: left early", actorName: "Ada Admin" });
  check("a held day is settled by a person: pay makes it pending, drop removes it",
    pay.ok && pay.status === "pending" && drop.ok && drop.status === "removed" && w.reg("S2", "2026-10-20")?.status === "pending" && w.reg("S3", "2026-10-21")?.status === "removed", J({ pay, drop }));
  await morning(w, "2026-10-23");
  check("...and the person's word stands, though the screen still disagrees the next morning", w.reg("S2", "2026-10-20")?.status === "pending");
  w.screenExtra = {};
  await morning(w, "2026-10-26");
  check("10/23 looked too perfect and is held", w.dateRec("2026-10-23")?.state === "held");
  clock.set("2026-10-26T18:00:00Z");
  const ns = await w.rt.run("perfectDay.markNoSchool", { date: "2026-10-23", reason: "a staff development day after all", actorName: "Ada Admin" });
  await morning(w, "2026-10-27");
  check("...an admin marks it no school: it is never read or decided again", ns.ok && w.dateRec("2026-10-23")?.state === "no-school" && !w.rows("perfectDays").some((r) => r.date === "2026-10-23"));
  check("the removed and dropped days were never paid; the settled one was",
    !paidDates(w, "S1").includes("2026-10-19") && !paidDates(w, "S1").includes("2026-10-20") && !paidDates(w, "S3").includes("2026-10-21") && paidDates(w, "S2").includes("2026-10-20"),
    J({ S1: paidDates(w, "S1"), S2: paidDates(w, "S2"), S3: paidDates(w, "S3") }));
  const paidRm = await w.rt.run("perfectDay.removeDays", { studentNumber: SN("S2"), dates: ["2026-10-20"], reason: "too late", actorName: "Ada Admin" });
  check("a PAID day cannot be removed this way (correctPayout is the way)", paidRm.ok === false && /correctPayout/.test(paidRm.refused[0]?.why ?? ""));
  const acts = w.rows("perfectDayAudit").map((r) => r.action);
  check("every admin act is recorded in the job's own audit table, never the shared audit log",
    ["configure", "markNoSchool", "removeDays", "resolveHeld"].every((x) => acts.includes(x)) && !w.rows("appAuditLog").some((e) => /perfect/i.test(J(e))), J(acts));
}
// ===========================================================================
console.log("\nI. THE KILL SWITCH ON A PAYDAY MORNING: WHAT WAS EARNED AND SHOWN IS STILL PAID\n");
{
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-12", "2026-11-06")) w.school(d);
  await configure(w, "2026-10-19T13:00:00Z", { mode: "live" });
  for (const d of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) await morning(w, d);
  const fri = await studentView(w, "S1", "2026-10-23T22:00:00Z");
  check("Friday: the student is shown four perfect days, arriving Monday",
    J(fri.wildcatCash.perfectDays) === J({ days: ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"], amount: 400, payday: "2026-10-26" }), J(fri.wildcatCash.perfectDays));
  const off = await configure(w, "2026-10-26T13:00:00Z", { mode: "off" });     // Monday 06:00 PT: a false alarm
  const on = await configure(w, "2026-10-26T13:20:00Z", { mode: "live" });     // 06:20 PT: back on
  await morning(w, "2026-10-26");
  check("KILL SWITCH OFF AND ON BEFORE MONDAY'S RUN: last week's pending days are paid",
    off.ok && on.ok && TEST.every((s) => J(paidDates(w, s.key)) === J(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"]))
    && w.jobLedger().length === 12 && w.hub("S1").wildcatCashBalance === 1400, J({ s1: paidDates(w, "S1"), bal: w.hub("S1").wildcatCashBalance }));
  check("...while Friday 10/23, not yet decided when it went off, is never decided: switching on counts from that day",
    on.settings.countFromDate === "2026-10-26" && !w.rows("perfectDays").some((r) => r.date === "2026-10-23"));
}
{
  // The same, mid-payday: two students a mutation (the test knob), the third batch dies.
  const w = await makeWorld({ mods: crashy.mods });
  for (const d of weekdaysBetween("2026-10-12", "2026-11-06")) w.school(d);
  await configure(w, "2026-10-19T13:00:00Z", { mode: "live" });
  for (const d of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) await morning(w, d);
  let calls = 0;
  globalThis.__killPayBatch = () => (++calls === 3);
  await morning(w, "2026-10-26");
  globalThis.__killPayBatch = null;
  const first = TEST.filter((s) => w.payouts(s.key).length > 0).length;
  await configure(w, "2026-10-26T15:00:00Z", { mode: "off" });                // 08:00 PT
  await configure(w, "2026-10-26T15:10:00Z", { mode: "live" });               // 08:10 PT
  await tick(w, "2026-10-26T15:42:00Z");                                      // 08:42 PT
  check("AN INTERRUPTED PAYDAY, THEN OFF AND ON: the next run pays the remaining students, each once, the same as the rest",
    first === 4 && TEST.every((s) => w.payouts(s.key).length === 1 && w.hub(s.key).wildcatCashBalance === 1500) && w.state().lastPayWeek === "2026-10-26",
    J({ first, bal: TEST.map((s) => w.hub(s.key).wildcatCashBalance) }));
}
{
  // Kill switch for a real fault: the days themselves are wrong. Forfeiting them is its own act.
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-12", "2026-11-06")) w.school(d);
  await configure(w, "2026-10-19T13:00:00Z", { mode: "live" });
  for (const d of ["2026-10-20", "2026-10-21", "2026-10-22"]) await morning(w, d);
  clock.set("2026-10-22T18:00:00Z");
  await configure(w, "2026-10-22T18:00:00Z", { mode: "off" });
  const dry = await w.rt.run("perfectDay.forfeitPending", { from: "2026-10-20", to: "2026-10-21", reason: "decided from a bad read", actorName: "Ada Admin" });
  check("forfeitPending counts first and changes nothing without apply",
    dry.ok && dry.applied === false && dry.wouldForfeit.days === 24 && dry.wouldForfeit.students === 12 && w.reg("S1", "2026-10-20")?.status === "pending", J(dry));
  const done = await w.rt.run("perfectDay.forfeitPending", { from: "2026-10-20", to: "2026-10-21", reason: "decided from a bad read", actorName: "Ada Admin", apply: true });
  await configure(w, "2026-10-26T13:00:00Z", { mode: "live" });
  await morning(w, "2026-10-26");
  check("...with apply, those days are removed and never paid; the days outside the range still are, and the act is recorded",
    done.ok && done.forfeited.days === 24 && w.reg("S1", "2026-10-20")?.status === "removed"
    && TEST.every((s) => J(paidDates(w, s.key)) === J(["2026-10-19"])) && w.rows("perfectDayAudit").some((r) => r.action === "forfeitPending" && r.detail.days === 24),
    J({ done, s1: paidDates(w, "S1") }));
}

// ===========================================================================
console.log("\nJ. POWERSCHOOL DOWN ON PAYDAY: PAYING NEEDS NOTHING FROM IT\n");
{
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-12", "2026-11-06")) w.school(d);
  await configure(w, "2026-10-19T13:00:00Z", { mode: "live" });
  for (const d of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) await morning(w, d);
  w.down = () => true;                                 // every PowerSchool call fails, sign-in included
  await morning(w, "2026-10-26");                      // 07:42 PT
  await tick(w, "2026-10-26T15:42:00Z");               // 08:42 PT
  check("PowerSchool down on Monday: the run waits until 09:30 for a read of last week, as for any failed read",
    w.jobLedger().length === 0 && w.lastRun()?.ok === false && /PowerSchool/.test(w.lastRun()?.reason ?? "") && w.lastRun()?.summary?.payday?.due === false,
    J({ run: w.lastRun()?.reason, pay: w.lastRun()?.summary?.payday }));
  await tick(w, "2026-10-26T16:42:00Z");               // 09:42 PT
  check("POWERSCHOOL DOWN DOES NOT HOLD BACK LAST WEEK'S PAY: at 09:42 every settled day is paid",
    TEST.every((s) => J(paidDates(w, s.key)) === J(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"])) && w.state().lastPayWeek === "2026-10-26",
    J({ s1: paidDates(w, "S1"), st: w.state() }));
  check("...and the run is still not done, so the next tick reads again", w.lastRun()?.ok === false && w.state().lastDoneDate !== "2026-10-26");
  w.down = null;
  await morning(w, "2026-10-27");
  check("...once PowerSchool answers, Friday 10/23 is decided, to be paid next week",
    TEST.every((s) => w.reg(s.key, "2026-10-23")?.status === "pending") && w.payouts("S1").length === 1);
}

// ===========================================================================
console.log("\nK. A DATE ALREADY DECIDED WHOSE RE-READ IS HELD IS NEVER PAID OVER\n");
{
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-12", "2026-11-13")) w.school(d);
  await configure(w, "2026-10-16T15:00:00Z", { mode: "live", lookbackSchoolDays: 3 });
  for (const d of ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) await morning(w, d);
  check("Thursday 10/22 decided on Friday: S1, S5 and S6 pending", ["S1", "S5", "S6"].every((k) => w.reg(k, "2026-10-22")?.status === "pending"));
  w.mark("S1", "2026-10-22", 10, "A");                          // a late Promise Time PM absence for Thursday
  w.screenExtra = { S5: ["2026-10-22"], S6: ["2026-10-22"] };   // the screen disputes two students: more than 1% of 37
  await morning(w, "2026-10-26");                               // the re-read is held as a whole, then payday
  check("A HELD RE-READ NEVER PAYS OVER A KNOWN BREAK: S1's pending 10/22, absent in the same read, is broken, not paid",
    w.reg("S1", "2026-10-22")?.status === "broken" && !paidDates(w, "S1").includes("2026-10-22") && paidDates(w, "S1").includes("2026-10-21"),
    J({ s1: w.reg("S1", "2026-10-22")?.status, paid: paidDates(w, "S1") }));
  check("...the students the screen disputes are held, not paid",
    ["S5", "S6"].every((k) => w.reg(k, "2026-10-22")?.status === "held" && !paidDates(w, k).includes("2026-10-22")), J(["S5", "S6"].map((k) => w.reg(k, "2026-10-22")?.status)));
  check("...while the date's other days stand, and are paid: it stays decided, with the re-read's reason",
    w.dateRec("2026-10-22")?.state === "school" && /re-read was held/.test(w.dateRec("2026-10-22")?.reason ?? "") && paidDates(w, "S2").includes("2026-10-22")
    && w.lastRun()?.summary?.recheckHeld?.includes("2026-10-22"), J(w.dateRec("2026-10-22")));
  for (const d of ["2026-10-27", "2026-10-28", "2026-10-29"]) await morning(w, d);
  const st = await status(w);
  check("...once it leaves the lookback the disputed days expire unpaid, and the date is not called \"expired, not paid\" over the days it paid",
    ["S5", "S6"].every((k) => w.reg(k, "2026-10-22")?.status === "expired") && w.dateRec("2026-10-22")?.state === "school" && st.paidThenBroken.count === 0,
    J({ d: w.dateRec("2026-10-22")?.state, rows: ["S5", "S6"].map((k) => w.reg(k, "2026-10-22")?.status) }));
}


// ===========================================================================
console.log("\nM. A PAUSE NEVER STOPS THE RE-READ OF A DAY ALREADY DECIDED\n");
{
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-12", "2026-11-13")) w.school(d);
  await configure(w, "2026-10-19T13:00:00Z", { mode: "live" });
  for (const d of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) await morning(w, d);
  clock.set("2026-10-23T21:00:00Z");
  w.mark("S1", "2026-10-22", 10, "A");                                     // Friday 14:00 PT: a late Promise Time PM absence for Thursday
  await configure(w, "2026-10-23T21:30:00Z", { mode: "off" });             // Friday 14:30 PT: the kill switch
  await configure(w, "2026-10-26T13:00:00Z", { mode: "live" });            // Monday 06:00 PT: back on, counting from 10/26
  await morning(w, "2026-10-26");
  check("AFTER AN OFF/ON, A DAY ALREADY DECIDED IS STILL RE-READ: S1's pending Thursday, absent before payday, is broken, not paid",
    w.reg("S1", "2026-10-22")?.status === "broken" && J(paidDates(w, "S1")) === J(["2026-10-19", "2026-10-20", "2026-10-21"]),
    J({ row: w.reg("S1", "2026-10-22")?.status, paid: paidDates(w, "S1") }));
  check("...the rest of the school is paid for it, and Friday 10/23 (not decided when it went off) is never decided",
    TEST.filter((s) => s.key !== "S1").every((s) => paidDates(w, s.key).includes("2026-10-22")) && !w.rows("perfectDays").some((r) => r.date === "2026-10-23"));
  w.mark("S2", "2026-10-21", 3, "X");                                      // an absence entered for a day already paid
  await morning(w, "2026-10-27");
  const st = await status(w);
  check("...and a paid day from before the switch that later breaks goes on the admin's paid-then-broken list",
    w.reg("S2", "2026-10-21")?.afterPayBroken === true && st.paidThenBroken.list.some((x) => x.studentNumber === SN("S2") && x.date === "2026-10-21"), J(st.paidThenBroken));
}
{
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-12", "2026-11-13")) w.school(d);
  await configure(w, "2026-10-19T13:00:00Z", { mode: "live" });
  for (const d of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) await morning(w, d);
  await morning(w, "2026-10-26", { writing: true });                       // the rebuild still writing: Friday decided, held for the second check
  const fri = w.reg("S1", "2026-10-23");
  await configure(w, "2026-10-26T15:00:00Z", { mode: "off" });             // 08:00 PT, a false alarm
  await configure(w, "2026-10-26T15:10:00Z", { mode: "live" });            // 08:10 PT, back on
  for (const d of weekdaysBetween("2026-10-27", "2026-11-02")) await morning(w, d);
  check("A DAY HELD FOR THE SECOND CHECK IS NOT FORFEITED BY AN OFF/ON: Friday 10/23 is released by the next run and paid on 11/2",
    fri?.status === "held" && fri?.payable === true && TEST.every((s) => paidDates(w, s.key).includes("2026-10-23")),
    J({ fri: fri?.status, now: w.reg("S1", "2026-10-23")?.status }));
}
{
  // A CORRECTION AFTER AN OFF/ON (2026-10-12 final review). S3 is absent on 10/20 when it is first decided (no
  // register row); S4 only by a late mark the next evening (a row, broken). Both are corrected to Present after a
  // Thursday-night off/on: the same final record must be the same money, whatever order the marks came in.
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-12", "2026-11-06")) w.school(d);
  await configure(w, "2026-10-19T13:00:00Z", { mode: "live" });
  w.mark("S3", "2026-10-20", 3, "A");                                      // entered the same day
  await morning(w, "2026-10-20");
  await morning(w, "2026-10-21");                                          // decides 10/20: S3 broken (no row), S4 pending
  clock.set("2026-10-22T02:00:00Z");
  w.mark("S4", "2026-10-20", 5, "A");                                      // Wednesday evening: a late absence for S4 on 10/20
  await morning(w, "2026-10-22");                                          // S4's 10/20: pending -> broken
  await configure(w, "2026-10-23T03:00:00Z", { mode: "off" });             // Thursday 20:00 PT
  await configure(w, "2026-10-23T13:00:00Z", { mode: "live" });            // Friday 06:00 PT: back on, counting from 10/23
  await morning(w, "2026-10-23");
  const before = { s3: w.reg("S3", "2026-10-20"), s4: w.reg("S4", "2026-10-20")?.status };
  clock.set("2026-10-23T22:00:00Z");                                       // Friday afternoon: the office corrects both to Present
  for (const r of w.fake.tables.attendance) {
    if ((r.studentid === BY_KEY.S3.psId || r.studentid === BY_KEY.S4.psId) && r.att_date === "2026-10-20") r.attendance_codeid = C.blank;
  }
  await morning(w, "2026-10-26");
  check("A CORRECTION AFTER AN OFF/ON PAYS THE SAME FINAL RECORD THE SAME: S3, broken when 10/20 was first decided, is paid it like S4",
    before.s3 === null && before.s4 === "broken" && paidDates(w, "S3").includes("2026-10-20") && paidDates(w, "S4").includes("2026-10-20")
    && w.reg("S3", "2026-10-20")?.payable === true && w.dateRec("2026-10-20")?.scope?.mode === "live",
    J({ before, s3: w.reg("S3", "2026-10-20"), s4: paidDates(w, "S4"), scope: w.dateRec("2026-10-20")?.scope }));
  check("...while Thursday 10/22, not decided when it went off, is still never decided",
    !w.rows("perfectDays").some((r) => r.date === "2026-10-22"));
}

// ===========================================================================
console.log("\nN. HOLDS THAT MUST NOT COST THE SCHOOL A DAY\n");
// A school day as PowerSchool shows it, block by block: the 25 others tardy to Promise Time AM, 21 of them absent from every other block that met.
const MONTHU = [1, 2, 4, 6, 8, 9, 10], TUEFRI = [1, 3, 5, 7, 8, 9, 10], ALLTEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const bellOf = (d) => ([1, 4].includes(weekday(d)) ? MONTHU : [2, 5].includes(weekday(d)) ? TUEFRI : ALLTEN);
const blocks = (w, date, slots) => {
  for (const f of FILL) w.mark(f.key, date, 1, "T");
  for (const slot of slots) if (slot !== 1) for (const f of FILL.slice(0, 21)) w.mark(f.key, date, slot, "A");
};
{
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-12", "2026-11-13")) {
    blocks(w, d, d === "2026-10-26" || d === "2026-10-29" ? ALLTEN : d === "2026-11-02" ? TUEFRI : bellOf(d));
  }
  await configure(w, "2026-10-19T13:00:00Z", { mode: "live" });
  for (const d of weekdaysBetween("2026-10-20", "2026-11-03")) await morning(w, d);
  check("A MONDAY RUN ON THE TUE/FRI BELL IS DECIDED THE NEXT MORNING, NOT HELD AS \"NOT ENTERED\"",
    w.dateRec("2026-11-02")?.state === "school" && w.reg("S1", "2026-11-02")?.status === "pending", J(w.dateRec("2026-11-02")?.reason));
  for (const d of weekdaysBetween("2026-11-04", "2026-11-06")) await morning(w, d);
  check("A NORMAL THURSDAY AFTER TWO ALL-TEN-BLOCK MON/THU DAYS IS DECIDED THE NEXT MORNING", w.dateRec("2026-11-05")?.state === "school",
    J(w.dateRec("2026-11-05")?.reason));
  await morning(w, "2026-11-09");
  check("...and both are paid on time, with the stack days, on the 11/9 payday",
    J(w.payouts("S1").find((p) => p.payWeek === "2026-11-09")?.dates) === J(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"])
    && paidDates(w, "S1").includes("2026-10-26") && paidDates(w, "S1").includes("2026-10-29"), J(w.payouts("S1").map((p) => p.dates)));
}
{
  // Promise Time PM for Friday 10/23 is bulk-entered during the 11th school day after it (8/28's was 7-12 school days late).
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-12", "2026-11-20")) blocks(w, d, d === "2026-10-23" ? TUEFRI.filter((x) => x !== 10) : bellOf(d));
  await configure(w, "2026-10-19T13:00:00Z", { mode: "live" });
  for (const d of weekdaysBetween("2026-10-20", "2026-10-27")) await morning(w, d);
  const st = await status(w);
  check("A DAY WITH A BLOCK MISSING SAYS IT MAY NOT HAVE MET, AND THE STATUS LISTS IT FOR AN ADMIN BEFORE IT EXPIRES",
    w.dateRec("2026-10-23")?.state === "held" && /did not meet/.test(w.dateRec("2026-10-23")?.reason ?? "")
    && (st.heldDates ?? []).some((x) => x.date === "2026-10-23" && /decideAnyway/.test(x.reason)), J(st.heldDates));
  for (const d of weekdaysBetween("2026-10-28", "2026-11-09")) await morning(w, d);
  clock.set("2026-11-09T20:00:00Z");
  for (const f of FILL.slice(0, 21)) w.mark(f.key, "2026-10-23", 10, "A");
  for (const d of weekdaysBetween("2026-11-10", "2026-11-16")) await morning(w, d);
  check("A BLOCK ENTERED 11 SCHOOL DAYS LATE IS STILL READ: Friday 10/23 is decided, not expired, and paid on 11/16",
    w.dateRec("2026-10-23")?.state === "school" && paidDates(w, "S1").includes("2026-10-23"), J({ d: w.dateRec("2026-10-23")?.state, s1: w.reg("S1", "2026-10-23")?.status }));
}
{
  // The attendance rebuild down for 18 school days: every day decided meanwhile is held for the second check.
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-12", "2026-11-27")) w.school(d);
  await configure(w, "2026-10-19T13:00:00Z", { mode: "live" });
  await morning(w, "2026-10-20");
  for (const d of weekdaysBetween("2026-10-21", "2026-11-13")) await tick(w, `${d}T14:42:00Z`);
  await morning(w, "2026-11-16");                                           // the rebuild is back; 10/20-10/23 have left the lookback
  check("AN OUTAGE LONGER THAN THE LOOKBACK FORFEITS NOTHING: days held only for the second check stay held for an admin, never expired",
    ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"].every((d) => TEST.every((s) => w.reg(s.key, d)?.status === "held" && w.reg(s.key, d)?.why === "second-check-unavailable")),
    J(["2026-10-20", "2026-10-23"].map((d) => w.reg("S1", d))));
  check("...the days still in the lookback are checked and paid", paidDates(w, "S1").includes("2026-10-26") && paidDates(w, "S1").includes("2026-11-13"), J(paidDates(w, "S1")));
  clock.set("2026-11-16T20:00:00Z");
  const release = (o) => w.rt.run("perfectDay.releaseUnchecked", { date: "2026-10-21", reason: "rebuild was down; PowerSchool's verdict stands", actorName: "Ada Admin", ...o })
    .catch((e) => ({ ok: false, error: String(e?.message || e) }));
  const dry = await release({});
  check("RELEASE A DATE IN ONE CALL: releaseUnchecked counts first and changes nothing without apply",
    dry.ok && dry.applied === false && dry.wouldRelease?.days === 12 && w.reg("S1", "2026-10-21")?.status === "held", J(dry));
  const rel = await release({ apply: true });
  for (const d of weekdaysBetween("2026-11-17", "2026-11-23")) await morning(w, d);
  check("...with apply, the whole date is paid on the next payday, the other dates stay held, and the act is recorded",
    rel.ok && rel.released?.days === 12 && TEST.every((s) => paidDates(w, s.key).includes("2026-10-21") && !paidDates(w, s.key).includes("2026-10-20"))
    && w.reg("S1", "2026-10-20")?.status === "held" && w.rows("perfectDayAudit").some((r) => r.action === "releaseUnchecked" && r.detail.days === 12), J({ rel, s1: paidDates(w, "S1") }));
}
{
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-12", "2026-11-06")) w.school(d);
  await configure(w, "2026-10-19T13:00:00Z", { mode: "live", lookbackSchoolDays: 3 });
  await morning(w, "2026-10-20"); await morning(w, "2026-10-21");
  w.down = (u) => /att_date%3D%3D2026-10-20/.test(u) && !/\/count\?/.test(u);   // reads of 10/20 fail; its count works
  await morning(w, "2026-10-23");                                                // 10/20 is the oldest of three
  const mid = w.dateRec("2026-10-20");
  check("A DECIDED DATE WHOSE RE-READ FAILS STAYS DECIDED, and the run is tried again",
    mid?.state === "school" && mid?.retryable === true && /re-read failed/.test(mid?.reason ?? "") && w.state().lastDoneDate !== "2026-10-23", J(mid));
  w.down = null;
  await morning(w, "2026-10-26");
  check("...so once it leaves the lookback it is not called \"expired, not paid\" over the days it paid",
    w.dateRec("2026-10-20")?.state === "school" && paidDates(w, "S1").includes("2026-10-20"), J(w.dateRec("2026-10-20")));
}
{
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-12", "2026-11-13")) w.school(d);
  await configure(w, "2026-10-19T13:00:00Z", { mode: "live" });
  for (const d of ["2026-10-20", "2026-10-21", "2026-10-22"]) await morning(w, d);
  w.mark("S3", "2026-10-21", 3, "A");                                       // S3's pending 10/21 breaks on the next run
  await morning(w, "2026-10-23");
  clock.set("2026-10-23T18:00:00Z");
  const r1 = await w.rt.run("perfectDay.markNoSchool", { date: "2026-10-21", reason: "staff day after all", actorName: "Ada Admin" });
  // The admin takes out what the refusal names (pending, held or paid); S3's broken day is no money either way.
  for (const s of TEST.filter((x) => x.key !== "S3")) await w.rt.run("perfectDay.removeDays", { studentNumber: s.sn, dates: ["2026-10-21"], reason: "no school that day", actorName: "Ada Admin" });
  const r2 = await w.rt.run("perfectDay.markNoSchool", { date: "2026-10-21", reason: "staff day after all", actorName: "Ada Admin" });
  await morning(w, "2026-10-26");
  const next = w.dateRec("2026-10-21")?.state;
  for (const d of weekdaysBetween("2026-10-27", "2026-11-13")) await morning(w, d);
  check("AN ADMIN'S \"NO SCHOOL\" STICKS once the decided days are taken out: never turned back to held, never expired",
    r1.ok === false && r1.decided === 11 && w.reg("S3", "2026-10-21")?.status === "broken" && r2.ok && next === "no-school" && w.dateRec("2026-10-21")?.state === "no-school",
    J({ r1, next, now: w.dateRec("2026-10-21") }));
}
{
  const w = await makeWorld();
  for (const d of weekdaysBetween("2026-10-12", "2026-11-06")) w.school(d);
  await configure(w, "2026-10-19T13:00:00Z", { mode: "live" });
  for (const d of ["2026-10-20", "2026-10-21", "2026-10-22"]) await morning(w, d);
  // S2 is withdrawn effective Thursday 10/22 (the first day not enrolled), as PowerSchool records it: classes dropped.
  const ps = w.fake.tables.students.find((x) => x.student_number === SN("S2"));
  ps.exitdate = "2026-10-22";
  const old = w.fake.tables.cc.filter((c) => c.studentid === ps.id);
  for (const c of old) Object.assign(c, { dateleft: "2026-10-22", termid: -3600, sectionid: -c.sectionid });
  await morning(w, "2026-10-23");
  const shown = await studentView(w, "S2", "2026-10-23T20:00:00Z");
  // Re-entered Monday 10/26: the students row now holds the NEW span only (the old one is in REENROLLMENTS).
  Object.assign(ps, { entrydate: "2026-10-26", exitdate: "2027-06-05" });
  for (const c of old) w.fake.tables.cc.push({ ...c, id: c.id + 100000, termid: 3600, sectionid: Math.abs(c.sectionid), dateenrolled: "2026-10-26", dateleft: "2027-06-05" });
  await morning(w, "2026-10-26");
  check("A STUDENT WHO LEFT AND CAME BACK IS PAID THE DAYS EARNED BEFORE LEAVING, as they were shown",
    J(shown.wildcatCash.perfectDays?.days) === J(["2026-10-19", "2026-10-20", "2026-10-21"]) && J(paidDates(w, "S2")) === J(["2026-10-19", "2026-10-20", "2026-10-21"]),
    J(["2026-10-19", "2026-10-20", "2026-10-21"].map((d) => `${w.reg("S2", d)?.status}:${w.reg("S2", d)?.why ?? ""}`)));
  check("...and no day is started for the time away", !w.rows("perfectDays").some((r) => r.studentNumber === SN("S2") && (r.date === "2026-10-22" || r.date === "2026-10-23")));
}

// ===========================================================================
console.log("\nL. THE RUNBOOK SAYS WHAT THE SWITCH AND THE CASH CAP DO\n");
{
  const book = read("./docs/runbook.md");
  check("the runbook's kill switch says pending days are not lost, and how to cancel them on purpose",
    /# The kill switch[^\n]*\n# decided as pending are NOT lost[\s\S]{0,200}forfeitPending/.test(book) && /perfectDay:forfeitPending/.test(book));
  check("...its live command says the controls are cleared", /# The whole school \(the pilot's controls are cleared/.test(book));
  check("the runbook warns, before going live, that the browser refuses cash movements over $5,000, and names the server's ways round it",
    /Before going live: the \$5,000 browser cap[\s\S]{0,900}RESET ALL CASH[\s\S]{0,400}zeroAllStudentCash[\s\S]{0,300}studentStore:purchase/.test(book));
}

} finally {
  loaded.cleanup();
  crashy.cleanup();
  clock.real();
  console.log = realLog;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
