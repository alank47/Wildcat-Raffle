// The 40,000-row attendance wall: the year read in month pieces. Run: npm test
//
// THE PROBLEM, measured 2026-10-02. attendanceDays:rebuild re-reads the whole
// school year twice a day, and one read stops at 400 pages x 100 = 40,000 rows.
// 21,407 rows after about 36 school days -- around mid-November every run would
// refuse and every attendance screen would stand still.
//
// THE OWNER'S RULES this file holds the fix to: no data from this year or last
// may be lost; nothing may drift (always a FULL rebuild, never patching); still
// twice a day; staff are never asked to refresh; a { since } rebuild stays
// refused.
//
// EVERYTHING RUNS THE SHIPPED CODE: the real rebuild handler against a fake
// PowerSchool that applies every filter (fake-powerschool.mjs), the real
// sisStats mutations against an in-memory Convex, and the real browser verdict.
// Each guarantee has a TEETH check: the same run with the guard broken, which
// must then fail -- a test that passes with the code broken proves nothing.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { convexToJson, jsonToConvex } from "convex/values";
import { fakePowerSchool } from "./fake-powerschool.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const daysSrc = read("./convex/attendanceDays.ts");
const statsSrc = read("./convex/sisStats.ts");
const rulesSrc = read("./convex/absenceDayRules.ts");
const healthSrc = read("./convex/attendanceDaysRead.ts");
const runChartSrc = read("./convex/attendanceRunChart.ts");
const cronSrc = read("./convex/crons.ts");
const rosterSrc = read("./wildcat-roster.js");
const scriptSrc = read("./script.js");
const htmlSrc = read("./index.html");
const pkg = JSON.parse(read("./package.json"));

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
/** Replace exactly one anchor, or fail loudly: a teeth test whose anchor moved proves nothing. */
function breakOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`teeth "${label}": anchor not found exactly once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}
const tsToJs = (src) => ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
/** A time as the school reads it, the way the server words it ("Oct 2, 6:32 AM"). */
const laClock = (iso) => new Date(iso).toLocaleString("en-US",
  { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** A raw UTC timestamp, which no admin-visible sentence may carry. */
const ISO_STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// ------------------------------------------------------------------ loaders
const absenceRules = await import("data:text/javascript," + encodeURIComponent(tsToJs(rulesSrc)));
const TODAY = "2026-10-02";

/** The shipped rebuild, imports stubbed, the clock pinned (a test must not move with the calendar). */
function loadRebuild(transform, today = TODAY) {
  let body = transform ? transform(daysSrc) : daysSrc;
  body = breakOnce(body, "function laToday(): string {", `function laToday(): string {\n  return "${today}";`, "clock");
  // Retries of a failed page pause for a second in production; not here.
  body = breakOnce(body, "const RETRY_PAUSE_MS = 1000;", "const RETRY_PAUSE_MS = 1;", "pause");
  body = body
    .replace(/^"use node";[ \t]*\n/m, "")
    .replace(/^import[\s\S]*?from\s*"[^"]*";[ \t]*\n/gm, "")
    .replace(/^export (const|async function|function) /gm, "$1 ");
  const ref = (path) => new Proxy({}, {
    get: (_, k) => (k === "__path" ? path : ref(path ? path + "." + String(k) : String(k))),
  });
  const v = new Proxy({}, { get: () => () => ({}) });
  return new Function("internalAction", "internal", "v", "addAbsenceDay", "emptyAbsenceSplit", "fetch", "process",
    tsToJs(body) + "\nreturn { rebuild, planWindows, windowQuery, WINDOW_CONCURRENCY };")
    .bind(null, (d) => d, ref(""), v, absenceRules.addAbsenceDay, absenceRules.emptyAbsenceSplit);
}

/** The shipped sisStats mutations, as plain handlers over an in-memory Convex. */
function loadStats(transform) {
  let body = (transform ? transform(statsSrc) : statsSrc)
    .replace(/^import[^\n]*\n/gm, "")
    .replace(/^export (const|function|async function) /gm, "$1 ");
  const stubs = `
    const internalMutation = (d) => d;
    const internalQuery = (d) => d;
    const v = new Proxy({}, { get: () => (...a) => ({ _v: true, a }) });
  `;
  return new Function(tsToJs(stubs + body) + `
    return { noteAttendanceRebuildStart, claimAttendanceRebuildWrite, finishAttendanceRebuild,
             setAttendanceMonthPieces, replaceAttendanceDays, replaceAbsenceTotals,
             replaceAbsenceDayTotals, replaceAttendanceMarks };`)();
}
const STATS = loadStats();

/** What crosses a Convex function boundary: serialised and back, so undefined and Maps are caught. */
const wire = (x) => jsonToConvex(convexToJson(x));

function makeDb() {
  const tables = {};
  let n = 0;
  const rowsOf = (t) => (tables[t] || (tables[t] = []));
  const reader = (get) => ({
    take: async (k) => get().slice(0, k),
    collect: async () => get().slice(),
    first: async () => get()[0] ?? null,
    unique: async () => {
      const r = get();
      if (r.length > 1) throw new Error("unique() found " + r.length);
      return r[0] ?? null;
    },
  });
  const db = {
    query: (t) => Object.assign(reader(() => rowsOf(t)), {
      withIndex: (_name, f) => {
        const conds = [];
        const q = { eq: (k, val) => { conds.push([k, val]); return q; } };
        if (f) f(q);
        return reader(() => rowsOf(t).filter((r) => conds.every(([k, val]) => r[k] === val)));
      },
    }),
    insert: async (t, doc) => { const _id = `${t}_${++n}`; rowsOf(t).push({ ...wire(doc), _id }); return _id; },
    patch: async (id, fields) => {
      for (const rows of Object.values(tables)) {
        const r = rows.find((x) => x._id === id);
        if (r) { Object.assign(r, wire(fields)); return; }
      }
      throw new Error("patch: no document " + id);
    },
    delete: async (id) => {
      for (const rows of Object.values(tables)) {
        const i = rows.findIndex((x) => x._id === id);
        if (i >= 0) { rows.splice(i, 1); return; }
      }
    },
  };
  return { db, tables };
}

// ------------------------------------------------------------------ fixture
const CODES = [
  { id: 1, att_code: "A", description: "Absent", presence_status_cd: "Absent" },
  { id: 2, att_code: "T", description: "Tardy", presence_status_cd: "Present" },
  { id: 3, att_code: "X", description: "Excused Absence", presence_status_cd: "Absent" },
  { id: 4, att_code: "", description: "Present", presence_status_cd: "Present" },
  { id: 6, att_code: "D", description: "Excused Tardy", presence_status_cd: "Present" },
].map((c) => ({ ...c, schoolid: 1 }));
const C = { A: 1, T: 2, X: 3, blank: 4, D: 6 };
const CC = Array.from({ length: 10 }, (_, i) => ({ id: 501 + i, expression: `${i + 1}(A-E)`, schoolid: 1, termid: 3600 }));
const SLOTS = CC.map((c) => c.expression);
// A semester term listed FIRST: the year term is the one with isyearrec 1.
const TERMS = [
  { id: 3601, schoolid: 1, yearid: 36, firstday: "2026-08-12", lastday: "2027-01-15", isyearrec: 0 },
  { id: 3600, schoolid: 1, yearid: 36, firstday: "2026-08-12", lastday: "2027-06-10", isyearrec: 1 },
];
// Identifiers nothing else in a record could contain by accident, so "no
// student in the health record" is a real check.
const STUDENTS = Array.from({ length: 12 }, (_, i) => ({
  id: `st${101 + i}`, student_number: String(731001 + i), entrydate: "2026-08-12", schoolid: 1, enroll_status: 0,
}));
const NUM = Object.fromEntries(STUDENTS.map((s) => [s.id, s.student_number]));

let nextId = 1;
const att = (studentid, date, code, period = 1, yearid = 36) => ({
  id: nextId++, yearid, schoolid: 1, studentid, att_date: date + "T00:00:00", periodid: period,
  attendance_codeid: code, ccid: 500 + period,
});
// One absence on each date that tests a boundary, each for a different child.
const SPECIAL = [
  att("st101", "2026-07-27", C.A),   // before 1 August: only the open first piece holds it
  att("st102", "2026-08-03", C.A),   // before the first day of school
  att("st103", "2026-08-12", C.A),   // the first day
  att("st104", "2026-08-31", C.A),   // a month's LAST day: le must be inclusive
  att("st105", "2026-09-01", C.A),   // a month's first day
  att("st106", "2026-09-29", C.A),   // the day before the live cut
  att("st107", "2026-09-30", C.A),   // the live cut itself (today minus two)
  att("st108", "2026-10-01", C.T),   // a tardy in the live piece
  att("st109", "2026-10-09", C.A),   // dated into the FUTURE, like the two pre-entered students
  att("st110", "2027-06-30", C.A),   // after the last day
  att("st111", "2027-07-02", C.A),   // after the last day, into next July
];
const BOUNDARY_DATES = ["2026-08-31", "2026-09-01", "2026-09-29", "2026-09-30", "2026-10-01"];
const ODD_DATES = ["2026-07-27", "2026-08-03", "2026-10-09", "2027-06-30", "2027-07-02"];
// Last year's row, inside this year's dates. Must never be read or written.
const LAST_YEAR = att("st112", "2026-08-20", C.A, 1, 35);
// Enough present rows that every piece needs two pages.
const BULK = [];
const span = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
for (const d of span("2026-08-12", "2026-08-31")) for (let s = 0; s < 6; s++) BULK.push(att(STUDENTS[s].id, d, C.blank, 2 + (s % 5)));
for (const d of span("2026-09-01", "2026-09-29")) for (let s = 6; s < 11; s++) BULK.push(att(STUDENTS[s].id, d, C.blank, 2 + (s % 5)));
for (const d of span("2026-09-30", "2026-10-02")) for (const st of STUDENTS) for (let p = 2; p <= 6; p++) BULK.push(att(st.id, d, C.blank, p));
const ATTENDANCE = [...SPECIAL, ...BULK, LAST_YEAR];
const THIS_YEAR = ATTENDANCE.filter((r) => r.yearid === 36);
const BASE = { attendance_code: CODES, cc: CC, students: STUDENTS, attendance: ATTENDANCE, terms: TERMS };
const ENV = { PS_HOST: "ps.example", PS_CLIENT_ID: "id", PS_CLIENT_SECRET: "s", PS_SCHOOL_ID: "1",
              PS_YEAR_ID: "36", PS_TERM_ID: "3600" };
const REPLACE = ["sisStats.replaceAttendanceDays", "sisStats.replaceAbsenceTotals",
                 "sisStats.replaceAbsenceDayTotals", "sisStats.replaceAttendanceMarks"];
const RECORD = ["sisStats.noteAttendanceRebuildStart", "sisStats.claimAttendanceRebuildWrite",
                "sisStats.finishAttendanceRebuild"];

/**
 * One run of the shipped rebuild. `override` answers a mutation in place of
 * the real one (or throws); `state` seeds appState "attendanceRebuild";
 * `shared` (a makeDb()) carries one in-memory Convex from run to run, so a
 * refusal and its retry can meet the same record.
 */
async function run(o = {}) {
  const ps = fakePowerSchool(Object.assign({}, BASE, o.tables || {}), o.fake || {});
  const { db, tables } = o.shared || makeDb();
  const seeded = (tables.appState || []).some((r) => r.key === "attendanceRebuild");
  const seed = o.state === null ? null : Object.assign({ monthPieces: o.monthPieces !== false }, o.state || {});
  if (seed && !seeded) await db.insert("appState", { key: "attendanceRebuild", value: seed, mirroredAt: "x" });
  const calls = [], scheduled = [], cancelled = [];
  const ctx = {
    runQuery: async (fn) => {
      if (fn.__path.endsWith("enrolledSlots")) return Object.fromEntries(STUDENTS.map((s) => [s.student_number, SLOTS]));
      if (fn.__path.endsWith("studentNames")) {
        return Object.fromEntries(STUDENTS.map((s) => [s.student_number, { firstName: "F", lastName: "L", grade: "7" }]));
      }
      throw new Error("unexpected query " + fn.__path);
    },
    runMutation: async (fn, args) => {
      const path = fn.__path, a = wire(args);
      calls.push({ path, args: a });
      const name = path.split(".").pop();
      if (o.override && o.override[name]) {
        const answer = await o.override[name](a);
        if (answer !== undefined) return answer;
      }
      if (!STATS[name] || !path.startsWith("sisStats.")) throw new Error("unexpected mutation " + path);
      return wire(await STATS[name].handler({ db }, a));
    },
    scheduler: {
      runAfter: async (ms, fn, args) => { scheduled.push({ ms, path: fn.__path, args: wire(args) }); return "job_" + scheduled.length; },
      cancel: async (id) => { cancelled.push(id); },
    },
  };
  const mod = loadRebuild(o.transform, o.today)(ps.fetch, { env: ENV });
  let summary = null, threw = null;
  try { summary = await mod.rebuild.handler(ctx, o.args || {}); } catch (e) { threw = e; }
  const strip = (rows) => (rows || []).map(({ _id, syncedAt, ...r }) => r);
  const canon = (rows) => strip(rows).map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();
  const appState = (tables.appState || []).find((r) => r.key === "attendanceRebuild");
  return {
    summary, threw, ps, calls, scheduled, cancelled, db, dbTables: tables,
    health: appState ? appState.value : null,
    replaceCalls: calls.filter((c) => REPLACE.includes(c.path)),
    out: {
      days: strip(tables.psAttendanceDays), totals: strip(tables.psAbsenceTotals),
      dayTotals: strip(tables.psAbsenceDayTotals), marks: strip(tables.psAttendanceMarks),
    },
    canon: {
      days: canon(tables.psAttendanceDays), totals: canon(tables.psAbsenceTotals),
      dayTotals: canon(tables.psAbsenceDayTotals), marks: canon(tables.psAttendanceMarks),
    },
    audit: tables.appAuditLog || [],
  };
}
const attendanceReads = (r) => r.ps.log.filter((e) => e.table === "attendance" && e.kind === "table");
const isLiveQ = (q) => /att_date=ge=2026-09-30/.test(q || "") && !/att_date=le=/.test(q || "");
const wroteNothing = (r) => r.replaceCalls.length === 0 && !r.dbTables.psAttendanceDays;

// ======================================================================
console.log("\nTHE PIECES: CONTIGUOUS, OPEN AT BOTH ENDS\n");
{
  const { planWindows, windowQuery } = loadRebuild()(null, { env: ENV });
  const contiguous = (ws) => ws.every((w, k) => k === 0 || (ws[k - 1].to !== null && addDays(ws[k - 1].to, 1) === w.from));
  const w = planWindows("2026-08-12", "2027-06-10", TODAY);
  check("on 2026-10-02: August, September, and the live piece from 2026-09-30",
    same(w, [{ from: null, to: "2026-08-31", live: false }, { from: "2026-09-01", to: "2026-09-29", live: false },
             { from: "2026-09-30", to: null, live: true }]), JSON.stringify(w));
  check("each piece ends the day before the next begins", contiguous(w));
  check("the first piece has no lower date and the last no upper date", w[0].from === null && w[w.length - 1].to === null);
  const june = planWindows("2026-08-12", "2027-06-10", "2027-06-05");
  check("in June: ten month pieces, the month to the live cut, and the live piece (12)",
    june.length === 12 && contiguous(june) && june[0].from === null && june[11].to === null && june[11].from === "2027-06-03",
    JSON.stringify(june.map((x) => [x.from, x.to])));
  check("...and only the last one is live", june.filter((x) => x.live).length === 1 && june[11].live);
  const cut = planWindows("2026-08-12", "2027-06-10", "2026-10-03");
  check("a live cut that falls on the 1st does not make an empty piece",
    same(cut.map((x) => [x.from, x.to]), [[null, "2026-08-31"], ["2026-09-01", "2026-09-30"], ["2026-10-01", null]]));
  const summer = planWindows("2026-08-12", "2027-06-10", "2027-08-01");
  check("after the last day: still contiguous, nothing split past the year, still open at the end",
    contiguous(summer) && summer[summer.length - 1].to === null && summer[summer.length - 1].from === "2027-07-30"
      && summer[summer.length - 2].from === "2027-06-01", JSON.stringify(summer.slice(-3)));
  const first = planWindows("2026-08-12", "2027-06-10", "2026-08-13");
  check("in the year's first two days it is ONE piece with no date at all -- the old query exactly",
    first.length === 1 && first[0].from === null && first[0].to === null &&
    windowQuery("1", "36", first[0]) === "schoolid==1;yearid==36", JSON.stringify(first));
  check("every piece's query keeps yearid==36",
    june.every((x) => windowQuery("1", "36", x).startsWith("schoolid==1;yearid==36")));
  const off = loadRebuild((s) => breakOnce(s, "const to = k === cuts.length ? null : addDays(cuts[k], -1);",
    "const to = k === cuts.length ? null : cuts[k];", "off-by-one"))(null, { env: ENV })
    .planWindows("2026-08-12", "2027-06-10", TODAY);
  check("TEETH: pieces that overlap by a day (to = the next from) fail the contiguity check", !contiguous(off));
}

// ======================================================================
console.log("\nTHE SAME ROWS AS THE ONE READ, INCLUDING THE AWKWARD ONES\n");
const base = await run();
{
  const s = base.summary;
  check("the rebuild read the year in month pieces and wrote", s && s.ok === true && s.readMode === "month pieces",
    JSON.stringify(s || base.threw && String(base.threw)).slice(0, 400));
  const served = new Set(attendanceReads(base).flatMap((e) => e.ids || []));
  check("the ids served across the pieces are exactly this year's rows",
    served.size === THIS_YEAR.length && THIS_YEAR.every((r) => served.has(String(r.id))), `${served.size} vs ${THIS_YEAR.length}`);
  check("last year's row was never read", !served.has(String(LAST_YEAR.id)));
  check("PowerSchool's count, the rows read and the pieces' counts all agree",
    s.yearCount === THIS_YEAR.length && s.attendanceRows === THIS_YEAR.length &&
    s.windowDetail.reduce((n, w) => n + w.count, 0) === THIS_YEAR.length,
    JSON.stringify({ yearCount: s.yearCount, rows: s.attendanceRows }));
  const marksOf = Object.fromEntries(base.out.marks.map((m) => [m.studentNumber, m]));
  check("a row dated into the future is in absentDates and psAttendanceDays",
    marksOf[NUM.st109].absentDates.includes("2026-10-09") && base.out.days.some((d) => d.date === "2026-10-09"));
  check("so are rows before the first day, before August, and after the last day",
    ODD_DATES.every((d) => base.out.days.some((x) => x.date === d)) &&
    marksOf[NUM.st101].absentDates.includes("2026-07-27") && marksOf[NUM.st111].absentDates.includes("2027-07-02"));
  check("every boundary date is written exactly once",
    BOUNDARY_DATES.filter((d) => d !== "2026-10-01").every((d) => base.out.days.filter((x) => x.date === d).length === 1) &&
    BOUNDARY_DATES.filter((d) => d !== "2026-10-01").every((d) => base.out.dayTotals.filter((x) => x.date === d).length === 1 &&
      base.out.dayTotals.find((x) => x.date === d).studentsAbsent === 1) &&
    same(marksOf[NUM.st108].tardyDates, ["2026-10-01"]));
  check("last year's absence is nowhere: not in the marks, not in the per-date rows",
    !marksOf[NUM.st112].absentDates.includes("2026-08-20") && !base.out.days.some((d) => d.date === "2026-08-20"));
  check("every attendance request, count or read, carries yearid==36",
    base.ps.log.filter((e) => e.table === "attendance").every((e) => /(^|;)yearid==36(;|$)/.test(e.q)));
  check("the time budget is reported with the run", s.budgetSeconds === 360 && s.limitSeconds === 600 &&
    typeof s.readSeconds === "number" && typeof s.writeSeconds === "number");
  const live = attendanceReads(base).filter((e) => isLiveQ(e.q)).map((e) => e.at);
  const rest = attendanceReads(base).filter((e) => !isLiveQ(e.q)).map((e) => e.at);
  check("the live piece is read LAST", live.length > 0 && Math.min(...live) > Math.max(...rest));
}

console.log("\nTHE SAME FOUR TABLES AS THE OLD SINGLE READ\n");
{
  const single = await run({ monthPieces: false });
  check("with the switch off, the old single read runs (no counts, no pieces)",
    single.summary.ok === true && single.summary.readMode === "single read" &&
    !single.ps.log.some((e) => e.kind === "count"), JSON.stringify(single.summary).slice(0, 200));
  for (const k of ["days", "totals", "dayTotals", "marks"]) {
    check(`${k}: the month pieces write exactly what the single read writes`,
      same(single.canon[k], base.canon[k]) && base.canon[k].length > 0, `${single.canon[k].length} vs ${base.canon[k].length}`);
  }
}

console.log("\nORDER DOES NOT MATTER, AND THE WRITE ORDER IS FIXED\n");
{
  const shuffled = await run({ fake: { shuffle: 11 } });
  for (const k of ["days", "totals", "dayTotals", "marks"]) {
    check(`${k}: identical when PowerSchool serves the rows in another order`, same(shuffled.canon[k], base.canon[k]));
  }
  const order = (r) => r.replaceCalls.filter((c) => c.path === "sisStats.replaceAttendanceDays" && !c.args.clearFirst)
    .flatMap((c) => c.args.rows.map((x) => x.date + "|" + x.studentNumber));
  const o1 = order(base), o2 = order(shuffled);
  check("psAttendanceDays is written in date-then-student order, as written, not just as sorted",
    o1.length > 0 && same(o1, [...o1].sort()) && same(o1, o2));
  const unsorted = await run({ fake: { shuffle: 11 }, transform: (s) => breakOnce(s,
    "        out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1\n", "        [].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1\n", "sort") });
  check("TEETH: without the sort, a shuffled read writes in another order", !same(order(unsorted), o1));
}

// ======================================================================
console.log("\nTHE COMPARISON THAT PROVES THE SWITCH ON PRODUCTION\n");
{
  const r = await run({ args: { dryRun: true, compare: true } });
  const c = r.summary && r.summary.compare;
  check("a clean year compares identical, both ways and table by table",
    c && c.possible === true && c.identical === true && c.singleRows === c.windowRows && c.windowRows === THIS_YEAR.length &&
    c.onlyInSingle === 0 && c.onlyInWindows === 0 && c.differing === 0 && Object.values(c.tables).every(Boolean),
    JSON.stringify(c).slice(0, 400));
  check("...and writes no table", wroteNothing(r) && !r.calls.some((x) => x.path === "sisStats.claimAttendanceRebuildWrite"));
  check("...and is filed as the last comparison, not as a run",
    r.health.lastCompare && r.health.lastCompare.identical === true && !r.health.last && r.health.lastDryRun &&
    !("windowDetail" in r.health.lastDryRun));
  check("...with the timings the switch is judged on", typeof c.singleSeconds === "number" && typeof r.summary.msPerPage === "number");

  const swap = await run({ args: { dryRun: true, compare: true },
    fake: { swapFieldInWindows: { id: SPECIAL[3].id, field: "attendance_codeid", value: C.X } } });
  const d = swap.summary.compare;
  check("one row read differently is reported: identical false, differing 1",
    d.identical === false && d.differing === 1 && d.onlyInSingle === 0 && d.onlyInWindows === 0, JSON.stringify(d).slice(0, 300));
  check("...the example names the row, its date and the field -- never a student",
    d.examples.length === 1 && same(d.examples[0].fields, ["attendance_codeid"]) && d.examples[0].att_date === "2026-08-31" &&
    !/studentid|studentNumber|st10|7310/.test(JSON.stringify(d.examples)));
  check("...and the table diff sees it too (the marks would change)", d.tables.marks === false);
  const always = await run({ args: { dryRun: true, compare: true },
    fake: { swapFieldInWindows: { id: SPECIAL[3].id, field: "attendance_codeid", value: C.X } },
    transform: (s) => breakOnce(s, "c.identical = c.onlyInSingle === 0 &&", "c.identical = true || c.onlyInSingle === 0 &&", "always") });
  check("TEETH: a comparison that always says identical is caught by that case", always.summary.compare.identical === true);

  const short = await run({ args: { dryRun: true, compare: true }, fake: { dropFromSingleRead: SPECIAL[5].id } });
  check("when the OLD read is the short one, it says so rather than blaming the pieces",
    short.summary.compare.identical === false && /OLD single read came back short/.test(short.summary.compare.verdict),
    short.summary.compare.verdict);
  const wall = await run({ args: { dryRun: true, compare: true },
    transform: (s) => breakOnce(s, "export const MAX_PAGES = 400;", "export const MAX_PAGES = 3;", "wall") });
  check("past 40,000 rows the comparison says it is not possible, and the pieces still read",
    wall.summary.ok === true && wall.summary.compare.possible === false &&
    wall.summary.compare.reason === "comparison not possible: the old single read hits the 40,000-row wall",
    JSON.stringify(wall.summary.compare));
  const noDry = await run({ args: { compare: true } });
  check("compare without dryRun is refused before anything is read",
    noDry.summary.ok === false && noDry.summary.code === "compare-needs-dryRun" && noDry.ps.log.length === 0 && noDry.calls.length === 0);
  const later = await run({ args: { dryRun: true, since: "2026-09-20" }, state: { lastCompare: { identical: true, keep: 1 } } });
  check("a later measuring run does not wipe the comparison", later.health.lastCompare.keep === 1 && later.health.lastDryRun);
}

// ======================================================================
console.log("\nA GAP, AN OVERLAP OR A FILTER IGNORED REFUSES BEFORE ANY CLEAR\n");
const refusedCleanly = (r, code) => r.summary && r.summary.ok === false && r.summary.code === code && wroteNothing(r) &&
  r.health && r.health.last && r.health.last.ok === false && r.health.last.code === code &&
  /Nothing was written; the previous tables are untouched\./.test(r.summary.reason);
{
  const below = await run({ transform: (s) => breakOnce(s, "const from = k === 0 ? null : cuts[k - 1];",
    "const from = k === 0 ? firstDay.slice(0, 8) + \"01\" : cuts[k - 1];", "gap-below") });
  check("TEETH: a first piece that starts on 1 August misses the July row and refuses 'coverage'",
    refusedCleanly(below, "coverage"), JSON.stringify(below.summary).slice(0, 300));
  const above = await run({ transform: (s) => breakOnce(s, "const to = k === cuts.length ? null :",
    "const to = k === cuts.length ? (lastDay || today) :", "gap-above") });
  check("TEETH: a last piece that stops at the last day misses next July's row and refuses",
    refusedCleanly(above, "coverage"), JSON.stringify(above.summary).slice(0, 300));
  const le = await run({ fake: { leExclusive: true } });
  const lostAtEnds = THIS_YEAR.filter((r) => ["2026-08-31", "2026-09-29"].includes(r.att_date.slice(0, 10))).length;
  check("a PowerSchool whose `le` is exclusive loses the pieces' last days, and the run refuses with both counts",
    refusedCleanly(le, "coverage") && le.summary.reason.includes(`counts ${THIS_YEAR.length} `) &&
    le.summary.reason.includes(`hold ${THIS_YEAR.length - lostAtEnds},`), le.summary && le.summary.reason);
  const ignored = await run({ fake: { ignoreDateFilter: true } });
  check("a PowerSchool that ignores the month filter is refused",
    refusedCleanly(ignored, "filter") && /did not apply the month filter/.test(ignored.summary.reason));
  const noYear = await run({ transform: (s) => breakOnce(s, "const q = [`schoolid==${schoolid}`, `yearid==${yearid}`];",
    "const q = [`schoolid==${schoolid}`];", "no-yearid") });
  check("TEETH: pieces without yearid read last year's row -- refused by the per-row check",
    refusedCleanly(noYear, "filter") && /from year 35/.test(noYear.summary.reason), noYear.summary && noYear.summary.reason);
  const noCheck = await run({ transform: (s) => breakOnce(breakOnce(s,
    "const q = [`schoolid==${schoolid}`, `yearid==${yearid}`];", "const q = [`schoolid==${schoolid}`];", "no-yearid"),
    "      checkPiece(r.rows, p.w, yearid);\n", "", "no-check") });
  check("TEETH: ...and with that check gone too, the count alone still refuses",
    refusedCleanly(noCheck, "coverage") && noCheck.summary.reason.includes(String(THIS_YEAR.length + 1)),
    noCheck.summary && noCheck.summary.reason);
  // ROWS WITH NO DATE (review, 2026-10-02). One used to refuse every run --
  // after mid-November, with the single read past its wall too, every
  // attendance screen would have stopped over one malformed row.
  const blank = await run({ fake: { nullDateRow: true } });
  check("a this-year row with no date: PowerSchool's count of DATED rows equals the pieces, so the run writes, "
    + "reporting undatedRows 1",
    blank.summary && blank.summary.ok === true && blank.summary.undatedRows === 1 &&
    blank.summary.yearCount === THIS_YEAR.length + 1 && blank.summary.attendanceRows === THIS_YEAR.length &&
    blank.health.last.undatedRows === 1, JSON.stringify(blank.summary || String(blank.threw)).slice(0, 300));
  const blankSingle = await run({ monthPieces: false, fake: { nullDateRow: true } });
  check("...and writes exactly the four tables the single read writes from the same PowerSchool (derive skips it there too)",
    ["days", "totals", "dayTotals", "marks"].every((k) => same(blank.canon[k], blankSingle.canon[k]) && blank.canon[k].length > 0));
  check("...the dated count is the year's query with att_date=ge=1900-01-01",
    blank.ps.log.some((e) => e.kind === "count" && e.q === "schoolid==1;yearid==36;att_date=ge=1900-01-01"));
  const anyGap = await run({ fake: { leExclusive: true }, transform: (s) => breakOnce(s,
    "      if (dated === held) {", "      if (true) {", "no-dated-count") });
  check("TEETH: accept any gap without that count, and the `le`-exclusive PowerSchool writes a short year",
    anyGap.summary && anyGap.summary.ok === true && anyGap.summary.attendanceRows < THIS_YEAR.length,
    JSON.stringify(anyGap.summary || String(anyGap.threw)).slice(0, 200));
}

console.log("\nA PIECE THAT PAGES OUT REFUSES BEFORE ANY CLEAR\n");
{
  const out = await run({ transform: (s) => breakOnce(s, "export const MAX_PAGES = 400;", "export const MAX_PAGES = 1;", "pages") });
  check("a piece past MAX_PAGES refuses, naming the piece", refusedCleanly(out, "paged-out") &&
    /The piece (up to 2026-08-31|2026-09-01 to 2026-09-29) paged out/.test(out.summary.reason), out.summary && out.summary.reason);
  const a = daysSrc.indexOf("if (att.pagedOut)"), b = daysSrc.indexOf("replaceAbsenceDayTotals");
  check("the old guard still stands before the first clear", a > 0 && b > a);
}

// ======================================================================
console.log("\nTEACHERS TYPING WHILE IT READS\n");
{
  const row = { yearid: 36, schoolid: 1, studentid: "st112", att_date: "2026-10-01T00:00:00", periodid: 1,
                attendance_codeid: C.A, ccid: 501 };
  const once = await run({ fake: { insertDuringRead: { row, afterPage: 1, match: isLiveQ, times: "once" } } });
  const livePiece = once.summary && once.summary.windowDetail && once.summary.windowDetail.find((w) => w.live);
  check("an entry made during the live piece's read: re-read once, then written",
    once.summary.ok === true && livePiece.attempts === 2 && once.summary.attendanceRows === THIS_YEAR.length + 1,
    JSON.stringify(livePiece));
  check("...and the new absence is in the tables",
    once.out.marks.find((m) => m.studentNumber === NUM.st112).absentDates.includes("2026-10-01"));
  check("...the other pieces were read once each", once.summary.windowDetail.filter((w) => !w.live).every((w) => w.attempts === 1));

  const always = await run({ fake: { insertDuringRead: { row, afterPage: 1, match: isLiveQ, times: "always" } } });
  check("a piece that never holds still refuses 'changing' and writes nothing",
    refusedCleanly(always, "changing"), JSON.stringify(always.summary).slice(0, 300));
  check("...and books exactly one retry, 15 minutes on, which it keeps",
    always.scheduled.length === 1 && always.scheduled[0].path === "attendanceDays.rebuild" &&
    always.scheduled[0].ms === 15 * 60 * 1000 && typeof always.scheduled[0].args.retryOf === "string" &&
    always.cancelled.length === 0 && always.health.last.retryAt && always.summary.retryAt);
  const live = attendanceReads(always).filter((e) => isLiveQ(e.q)).map((e) => e.at);
  const rest = attendanceReads(always).filter((e) => !isLiveQ(e.q)).map((e) => e.at);
  check("...the live piece was read last, three times", live.length >= 3 && Math.min(...live) > Math.max(...rest));
  const retry = await run({ args: { retryOf: always.scheduled[0].args.retryOf },
    fake: { insertDuringRead: { row, afterPage: 1, match: isLiveQ, times: "always" } } });
  check("the retry, refused again, books nothing further", retry.summary.ok === false && retry.scheduled.length === 0 &&
    retry.health.last.trigger === "retry");
  check("...and leaves an audit entry, because twice in a row is news",
    retry.audit.length === 1 && retry.audit[0].payload.action === "attendance_rebuild_refused" &&
    retry.audit[0].payload.studentName === "All students");
  check("a single refusal leaves no audit entry", always.audit.length === 0);
}

// ======================================================================
console.log("\nA FAILURE WRITES NOTHING, AND IS RECORDED\n");
{
  const counts = await run({ fake: { failCountWith500: Infinity } });
  check("PowerSchool's count failing: thrown, nothing written, recorded at stage 'read', retry kept",
    counts.threw && wroteNothing(counts) && counts.health.last.ok === false && counts.health.last.stage === "read" &&
    counts.health.last.code === "failed" && counts.scheduled.length === 1 && counts.cancelled.length === 0,
    String(counts.threw));
  const piece = await run({ fake: { failWindowWith500: { match: (q) => /att_date=le=2026-08-31/.test(q), times: Infinity } } });
  check("one piece failing: the same", piece.threw && wroteNothing(piece) && piece.health.last.stage === "read" &&
    piece.health.running === null);
  const max = piece.ps.maxInFlight;
  check("...and nothing was left reading behind it", piece.ps.log.every((e) => e.finished), String(max));
  const blip = await run({ fake: { failWindowWith500: { match: (q) => /att_date=le=2026-08-31/.test(q), times: 1 } } });
  check("one 500 on one page is asked again, and the run succeeds", blip.summary && blip.summary.ok === true);
  const noRetry = await run({ fake: { failWindowWith500: { match: (q) => /att_date=le=2026-08-31/.test(q), times: 1 } },
    transform: (s) => breakOnce(s, "const PAGE_RETRIES = 2;", "const PAGE_RETRIES = 0;", "no-retry") });
  check("TEETH: without the page retry, that one 500 fails the run", noRetry.threw && wroteNothing(noRetry));
}

console.log("\nTHE TIME BUDGET\n");
{
  const slow = await run({ fake: { slowMs: 20 },
    transform: (s) => breakOnce(s, "const READ_BUDGET_MS = 6 * 60 * 1000;", "const READ_BUDGET_MS = 50;", "budget") });
  check("a read past the budget refuses with 'budget' and writes nothing",
    refusedCleanly(slow, "budget") && /budget/.test(slow.summary.reason) && typeof slow.health.last.seconds === "number",
    JSON.stringify(slow.summary).slice(0, 300));
  const unchecked = await run({ fake: { slowMs: 20 },
    transform: (s) => breakOnce(breakOnce(s, "const READ_BUDGET_MS = 6 * 60 * 1000;", "const READ_BUDGET_MS = 50;", "budget"),
      "function pastDeadline(deadline: number): boolean {\n  return Date.now() > deadline;",
      "function pastDeadline(deadline: number): boolean {\n  return false;", "no-deadline") });
  check("TEETH: with the deadline check gone, the same slow run writes", unchecked.summary && unchecked.summary.ok === true &&
    unchecked.replaceCalls.length > 0);
}

console.log("\nA FAILURE WHILE WRITING\n");
{
  const r = await run({ override: { replaceAbsenceTotals: () => { throw new Error("Convex said no"); } } });
  check("the error is rethrown, so Convex's log keeps the stack", r.threw && /Convex said no/.test(String(r.threw.message)));
  check("...recorded as a failure at stage 'write'", r.health.last.ok === false && r.health.last.stage === "write" &&
    r.health.last.code === "failed" && /Convex said no/.test(r.health.last.reason));
  check("...its lock released and its retry kept", r.health.writing === null && r.health.running === null &&
    r.scheduled.length === 1 && r.cancelled.length === 0 && r.health.last.retryAt);
}

// ======================================================================
console.log("\nTHE WRITE LOCK AND THE SHRINK GUARD\n");
{
  const held = await run({ override: { claimAttendanceRebuildWrite: () => ({ ok: false, code: "lock-held", reason: "another run" }) } });
  check("another run holding the lock: nothing cleared, and its own retry cancelled",
    held.summary.ok === false && held.summary.code === "lock-held" && wroteNothing(held) &&
    /Nothing was written; the previous tables are untouched\./.test(held.summary.reason) && held.cancelled.length === 1);
  check("...filed in recent only: it is not `last`, so it can raise no alarm (review, 2026-10-02)",
    held.health.recent[0].code === "lock-held" && !held.health.last && held.health.running === null);
  const vague = await run({ override: { claimAttendanceRebuildWrite: () => ({ moreToClear: false }) } });
  check("FAIL CLOSED: a claim that does not say ok clears nothing", vague.summary.ok === false && wroteNothing(vague));

  const { db } = makeDb();
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  await db.insert("appState", { key: "attendanceRebuild", value: { writing: { runId: "other", startedAt: iso(now - 5 * 60000) } }, mirroredAt: "x" });
  const claim = (a) => STATS.claimAttendanceRebuildWrite.handler({ db }, Object.assign({ runId: "mine", startedAt: iso(now), yearid: "36", yearCount: 100 }, a || {}));
  const r1 = await claim();
  check("a second run within ten minutes of the holder's START is refused", r1.ok === false && r1.code === "lock-held" && r1.heldBy === "other");
  const row = (await db.query("appState").collect())[0];
  row.value.writing.startedAt = iso(now - 11 * 60000);
  const r2 = await claim();
  check("...and allowed once the holder must be dead (no action outlives ten minutes)", r2.ok === true);
  row.value.writing = null;
  row.value.lastOk = { yearid: "36", attendanceRows: 21407, finishedAt: "2026-10-02T20:00:00Z" };
  const r3 = await claim({ yearCount: 9000 });
  check("a year reading under half of the last good run is refused as a broken read",
    r3.ok === false && r3.code === "shrink" && /acceptShrink/.test(r3.reason));
  check("...allowed by hand with acceptShrink", (await claim({ yearCount: 9000, acceptShrink: true, runId: "m2" })).ok === true);
  row.value.writing = null;
  check("...and not applied across school years", (await claim({ yearCount: 9000, yearid: "37", runId: "m3" })).ok === true);
  const shrink = await run({ state: { lastOk: { yearid: "36", attendanceRows: THIS_YEAR.length * 3, finishedAt: "x" } } });
  check("through the rebuild: the shrink guard stops the run before any clear", refusedCleanly(shrink, "shrink"));
  const accepted = await run({ args: { acceptShrink: true }, state: { lastOk: { yearid: "36", attendanceRows: THIS_YEAR.length * 3 } } });
  check("...and { acceptShrink: true } lets it write", accepted.summary.ok === true && accepted.replaceCalls.length > 0);
}

// ======================================================================
console.log("\nONE RECORD PER RUN\n");
{
  const h = base.health;
  check("a good run is last, lastOk and recent[0]; its marker and lock are gone",
    h.last.ok === true && h.lastOk.runId === h.last.runId && h.recent[0].runId === h.last.runId &&
    h.running === null && h.writing === null);
  check("recent keeps the headline, not the per-piece detail", !("windowDetail" in h.recent[0]) && Array.isArray(h.last.windowDetail));
  check("it carries what an admin needs: rows, count, pieces, pages, seconds",
    h.last.attendanceRows === THIS_YEAR.length && h.last.yearCount === THIS_YEAR.length && h.last.windows === 3 &&
    h.last.pages.attendance > 0 && h.last.pages.cc > 0 && h.last.pages.students > 0 &&
    typeof h.last.readSeconds === "number" && typeof h.last.writeSeconds === "number" && typeof h.last.seconds === "number");
  check("...and what it wrote, matching the tables",
    h.last.rowsWritten.days === base.out.days.length && h.last.rowsWritten.totals === base.out.totals.length &&
    h.last.rowsWritten.dayTotals === base.out.dayTotals.length && h.last.rowsWritten.marks === base.out.marks.length);
  check("the retry booked at the start was cancelled on the clean finish",
    base.scheduled.length === 1 && same(base.cancelled, ["job_1"]));
  check("NO STUDENT is named anywhere in the record",
    !STUDENTS.some((s) => JSON.stringify(h).includes(s.student_number) || JSON.stringify(h).includes(s.id)));
  const nothingAbsent = await run({ tables: { attendance_code: CODES.map((c) => ({ ...c, presence_status_cd: "Present" })) } });
  check("an early refusal goes through the same record, with its code, and leaves no run marked running",
    nothingAbsent.summary.ok === false && nothingAbsent.health.last.code === "no-absent-codes" &&
    nothingAbsent.health.running === null && nothingAbsent.scheduled.length === 1 && nothingAbsent.cancelled.length === 0);
  const dead = await run({ state: { running: { runId: "old", startedAt: new Date(Date.now() - 11 * 60000).toISOString() } } });
  check("a run Convex killed is written in as abandoned when the next one starts",
    dead.health.recent.some((r) => r.runId === "old" && r.code === "abandoned"));
  check("...and, not being a retry, it is not audited: one failure is not news", dead.audit.length === 0);
  const skip = await run({ args: { retryOf: "orig" }, state: { lastOk: { runId: "orig", ok: true } } });
  check("a retry whose original finished ok does nothing at all",
    skip.summary.ok === true && skip.summary.skipped === true && skip.ps.log.length === 0 &&
    same(skip.calls.map((c) => c.path), ["sisStats.noteAttendanceRebuildStart"]));
  check("the switch is one mutation", typeof STATS.setAttendanceMonthPieces.handler === "function" &&
    /export const setAttendanceMonthPieces = internalMutation\(/.test(statsSrc));
}

// ======================================================================
console.log("\nLOAD ON POWERSCHOOL\n");
{
  const jan = await run({ today: "2027-01-15", fake: { slowMs: 3 } });
  const max = jan.ps.maxInFlight;
  check("in January (six month pieces before the live one) the run still succeeds",
    jan.summary.ok === true && jan.summary.windows === 7, JSON.stringify(jan.summary).slice(0, 200));
  check("never more than three requests in flight, counts included -- and really more than one", max <= 3 && max >= 2, String(max));
  const wide = await run({ today: "2027-01-15", fake: { slowMs: 3 },
    transform: (s) => breakOnce(s, "const WINDOW_CONCURRENCY = 3;", "const WINDOW_CONCURRENCY = 6;", "wide") });
  check("TEETH: a pool that ignored the bound would be caught", wide.ps.maxInFlight > 3, String(wide.ps.maxInFlight));
}

// ======================================================================
console.log("\nWHAT MUST NOT CHANGE\n");
{
  const all = [base, ...[await run({ args: { dryRun: true, compare: true } })]].flatMap((r) => r.calls.map((c) => c.path));
  check("the rebuild calls only its four tables and its own record",
    all.every((p) => REPLACE.includes(p) || RECORD.includes(p)), [...new Set(all)].join(","));
  const code = daysSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("never syncRuns (it would reload every open student portal), never the run chart's tables",
    !/syncLog|syncRuns|attendanceRun/.test(code));
  const block = (s) => { const a = s.indexOf("function basic(input: string): string {"); const b = s.indexOf("export async function readTable(");
    return s.slice(a, s.indexOf("\n}\n", b) + 3); };
  check("token() and readTable() are byte-for-byte what 32b13c6 shipped (last year's run chart uses them)",
    createHash("sha256").update(block(daysSrc)).digest("hex") === "ca844187017d18aef398dcb71ff08a3d9369bab81605cf161502424fae76b13d");
  check("MAX_PAGES and PAGE are unchanged",
    daysSrc.includes("\nexport const MAX_PAGES = 400;\nexport const PAGE = 100;\n"));
  check("attendanceRunChart still imports them", runChartSrc.includes('import { token, readTable } from "./attendanceDays";'));
  check("the schedule is unchanged: 13:30 and 19:30 UTC, with {}",
    /"absence day rebuild \(morning\)",\s*\{ hourUTC: 13, minuteUTC: 30 \},\s*internal\.attendanceDays\.rebuild,\s*\{\},/.test(cronSrc) &&
    /"absence day rebuild \(midday\)",\s*\{ hourUTC: 19, minuteUTC: 30 \},\s*internal\.attendanceDays\.rebuild,\s*\{\},/.test(cronSrc));
}

console.log("\n{ since } STAYS REFUSED\n");
{
  const r = await run({ args: { since: "2026-09-20" } });
  check("refused before reading, writing or recording anything",
    r.summary.ok === false && /wiping every earlier date/.test(r.summary.reason) && r.ps.log.length === 0 && r.calls.length === 0);
  const m = await run({ args: { since: "2026-09-20", dryRun: true } });
  check("with dryRun it still measures, and writes nothing but the dry-run note",
    m.summary.ok === true && m.summary.readMode === "since (measuring only)" && wroteNothing(m) &&
    same(m.calls.map((c) => c.path), ["sisStats.finishAttendanceRebuild"]) && !m.health.last && m.health.lastDryRun);
}

// ======================================================================
console.log("\nTHE ADMIN'S VERDICT (wildcat-roster.js, loaded for real)\n");
function loadRoster(transform) {
  const body = transform ? transform(rosterSrc) : rosterSrc;
  const sandbox = {};
  new Function("globalThis", body).call(sandbox, sandbox);
  return sandbox.WildcatRoster;
}
{
  const R = loadRoster();
  const NOW = "2026-10-02T20:00:00.000Z";          // 1:00 PM in Los Angeles
  const ago = (min) => new Date(Date.parse(NOW) - min * 60000).toISOString();
  const okRun = { runId: "a", ok: true, startedAt: ago(30), finishedAt: ago(28), seconds: 95, attendanceRows: 21407, windows: 3, readMode: "month pieces" };
  const V = (h, fetched, Rr) => (Rr || R).rebuildHealthVerdict(h, NOW, {}, fetched || NOW);
  check("a good recent run: ok", V({ last: okRun, lastOk: okRun }).level === "ok");
  const refused = { runId: "b", ok: false, code: "coverage", reason: "PowerSchool counts 21407 rows", startedAt: ago(25), finishedAt: ago(24) };
  const okEarlier = Object.assign({}, okRun, { finishedAt: "2026-10-02T13:32:00.000Z" });
  const v1 = V({ last: refused, lastOk: okEarlier });
  check("the last run refused: bad, naming the reason and when the screens' data is from",
    v1.level === "bad" && v1.headline.includes("PowerSchool counts 21407 rows") && v1.headline.includes("Oct 2, 6:32 AM"), v1.headline);
  const v2 = V({ last: Object.assign({}, refused, { retryAt: ago(-10) }), lastOk: okEarlier });
  check("...but a warning, not an alarm, while its retry is still to come", v2.level === "warn" && /runs again by itself/.test(v2.headline), v2.headline);
  const old = Object.assign({}, okRun, { finishedAt: ago(20 * 60) });
  const v3 = V({ last: old, lastOk: old });
  check("the last good run 20 hours ago: bad, behind PowerSchool", v3.level === "bad" && /behind PowerSchool/.test(v3.headline), v3.headline);
  const v4 = V({ last: okRun, lastOk: okRun, running: { runId: "c", startedAt: ago(16) } });
  check("a run started 16 minutes ago and still going: bad, did not finish", v4.level === "bad" && /did not finish/.test(v4.headline));
  const v5 = V({ last: Object.assign({}, okRun, { seconds: 320 }), lastOk: Object.assign({}, okRun, { seconds: 320 }) });
  check("a good run that took 320 of 600 seconds in all: warn", v5.level === "warn" && /320 of the 600 seconds/.test(v5.headline), v5.headline);
  const v6 = V(null);
  check("nothing recorded yet: 'unknown', which raises no tile", v6.level === "unknown");
  const big = Object.assign({}, okRun, { readMode: "single read", windows: undefined, attendanceRows: 35000 });
  check("still on the single read at 35,000 rows: warn, turn on the month pieces",
    V({ last: big, lastOk: big }).level === "warn");
  // THE STALE COPY (review, 2026-10-02): a dashboard opened during the run and
  // left there. Its copy, fetched ten minutes ago, shows the run in progress.
  const stale = V({ last: okRun, lastOk: okRun, running: { runId: "c", startedAt: ago(16) } }, ago(10));
  check("a copy fetched ten minutes ago never says 'did not finish' -- it is refetched first",
    stale.level !== "bad" && !/did not finish/.test(stale.headline), stale.headline);
  check("...nor 'hours behind'", V({ last: old, lastOk: old }, ago(10)).level !== "bad");
  const noAge = loadRoster((s) => breakOnce(s, "if (okAt === null || now - okAt > L.staleAfterHours * 3600000) {", "if (false) {", "age"));
  check("TEETH: a verdict without the age rule misses the 20-hour case", V({ last: old, lastOk: old }, null, noAge).level !== "bad");
  const noFresh = loadRoster((s) => breakOnce(s,
    "var fresh = isFinite(now) && isFinite(fetched) && Math.abs(now - fetched) <= L.freshMinutes * 60000;", "var fresh = true;", "fresh"));
  check("TEETH: a verdict that trusts an old copy raises the false alarm",
    V({ last: okRun, lastOk: okRun, running: { runId: "c", startedAt: ago(16) } }, ago(10), noFresh).level === "bad");
}

console.log("\nTHE SCREENS AND THE WIRING\n");
{
  check("the health query is admin-only and reads by key",
    /export const rebuildHealth = query\(/.test(healthSrc) && /await requireAdmin\(ctx\);/.test(healthSrc) &&
    /q\.eq\("key", "attendanceRebuild"\)/.test(healthSrc));
  check("...and has no clock (a cached answer would freeze the age)",
    !/Date\.now\(\)|new Date\(/.test(healthSrc.slice(healthSrc.indexOf("export const rebuildHealth"))));
  check("the browser asks for it", scriptSrc.includes("auth.convexQuery('attendanceDaysRead:rebuildHealth', {}, session.idToken)"));
  check("the card exists in Settings > Integrations, after the PowerSchool sync card",
    htmlSrc.indexOf('id="attRebuildHealth"') > htmlSrc.indexOf('id="sisSyncStatus"') &&
    htmlSrc.indexOf('id="attRebuildHealth"') < htmlSrc.indexOf("Kickboard Email Reports"));
  check("it is filled when the Integrations subtab opens",
    /subtab === 'integrations' && typeof showAttendanceRebuildHealth === 'function'/.test(scriptSrc));
  check("the dashboard tile is admins-only and silent unless warn or bad",
    /\(isAdmin && \(attRebuild\.level === 'warn' \|\| attRebuild\.level === 'bad'\)\)/.test(scriptSrc));
  check("the copy is re-asked once it is five minutes old, never once per page load",
    /Date\.now\(\) - _attRebuildAskedAt < 5 \* 60000/.test(scriptSrc) && /fetchedAt: new Date\(\)\.toISOString\(\)/.test(scriptSrc));
  check("the audit entry a failed retry writes has a feed category",
    /'attendance_rebuild_refused':\s*'system'/.test(scriptSrc));
  const card = scriptSrc.slice(scriptSrc.indexOf("async function showAttendanceRebuildHealth"),
    scriptSrc.indexOf("window.showAttendanceRebuildHealth"));
  check("every value in the card goes through escapeHtml",
    !/\+ (r|h|c|ok|last)\.[a-zA-Z]+ \+/.test(card) && (card.match(/escapeHtml\(/g) || []).length >= 15);
  const stamps = [...htmlSrc.matchAll(/\?v=([0-9a-z]+)/g)].map((m) => m[1]);
  check("all 26 cache stamps moved together, at or past 20261002e",
    stamps.length === 26 && new Set(stamps).size === 1 && stamps[0] >= "20261002e", [...new Set(stamps)].join(","));
  check("this file runs in npm test, straight after the excused tardy tests",
    /node perfect-attendance-month\.test\.mjs && node excused-tardy\.test\.mjs && node attendance-wall\.test\.mjs/.test(pkg.scripts.test));
}

// ======================================================================
// THE REVIEW OF 2026-10-02. Each section below holds one fix, and each check
// in it fails on the code as it stood before that fix.
// ======================================================================
const LA_NOW = "2026-10-02T20:00:00.000Z";          // 1:00 PM in Los Angeles
const laAgo = (min) => new Date(Date.parse(LA_NOW) - min * 60000).toISOString();
const OK_MORNING = { runId: "m", ok: true, startedAt: "2026-10-02T13:30:00.000Z", finishedAt: "2026-10-02T13:32:00.000Z",
                     attendanceRows: 21407, windows: 3, readMode: "month pieces", readSeconds: 100, seconds: 120 };
/** One function's source from script.js, or null when it is not there. */
function grabFn(src, name) {
  const a = src.indexOf("function " + name + "(");
  if (a < 0) return null;
  let depth = 0, i = src.indexOf("{", a);
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  return src.slice(a, i + 1);
}
const TYPING = { yearid: 36, schoolid: 1, studentid: "st112", att_date: "2026-10-01T00:00:00", periodid: 3,
                 attendance_codeid: C.A, ccid: 503 };

console.log("\nTHE SLOW WARNING JUDGES THE READ AGAINST THE READ BUDGET\n");
{
  const R = loadRoster();
  const good = (o) => Object.assign({}, OK_MORNING, { finishedAt: laAgo(28) }, o);
  const V = (h) => R.rebuildHealthVerdict(h, LA_NOW, {}, LA_NOW);
  const near = good({ readSeconds: 355, seconds: 370 });
  const v1 = V({ last: near, lastOk: near });
  check("a run that read for 355 of the 360-second budget warns about the READ, not '370 of 600'",
    v1.level === "warn" && /read for 355 of the 360 seconds/.test(v1.headline) && !/of 600/.test(v1.headline) &&
    /read 355 of 360 s/.test(v1.tile), v1.headline);
  const quiet = good({ readSeconds: 295, seconds: 300 });
  const v2 = V({ last: quiet, lastOk: quiet });
  check("a run that read for 295 s -- 65 s from refusing -- is not 'ok'",
    v2.level === "warn" && /295 of the 360/.test(v2.headline), v2.headline);
  const fine = good({ readSeconds: 120, seconds: 150 });
  check("...and one that read for 120 s is", V({ last: fine, lastOk: fine }).level === "ok");
  check("the line under the card names the read and the budget",
    V({ last: fine, lastOk: fine }).lines.some((l) => /read 120 of 360 s, 150 s in all\./.test(l)),
    JSON.stringify(V({ last: fine, lastOk: fine }).lines));
  const budgetMs = Number(Function(`return ${/const READ_BUDGET_MS = ([^;]+);/.exec(daysSrc)[1]};`)());
  check("the health query sends the read budget, equal to READ_BUDGET_MS; the browser's default matches",
    new RegExp(`budgetSeconds: ${budgetMs / 1000},`).test(healthSrc) && R.REBUILD_LIMITS.budgetSeconds === budgetMs / 1000);
  const card = scriptSrc.slice(scriptSrc.indexOf("async function showAttendanceRebuildHealth"),
    scriptSrc.indexOf("window.showAttendanceRebuildHealth"));
  check("the Settings card shows 'read N of <budget> s', not 'N s of 600'",
    /ok\.readSeconds/.test(card) && /budgetSeconds/.test(card) && !/s of 600/.test(card));
}

console.log("\nTHE HEALTH QUERY, RUN FOR REAL\n");
{
  const body = healthSrc.replace(/^import[^\n]*\n/gm, "").replace(/^export (const|function|async function) /gm, "$1 ");
  const load = (requireAdmin) => new Function("query", "internalQuery", "requireAdmin",
    tsToJs(body) + "\nreturn { rebuildHealth };")((d) => d, (d) => d, requireAdmin);
  const { db } = makeDb();
  await db.insert("appState", { key: "attendanceRebuild", value: { last: { runId: "x", ok: true } }, mirroredAt: "x" });
  const denied = await load(async () => { throw new Error("admins only"); }).rebuildHealth.handler({ db })
    .then(() => "answered", (e) => String(e.message));
  check("a non-admin is refused by the query itself (not just a line that mentions requireAdmin)", denied === "admins only", denied);
  const ans = await load(async () => ({})).rebuildHealth.handler({ db });
  check("an admin gets the record and the limits, the read budget included",
    ans.health.last.runId === "x" && ans.limits.budgetSeconds === 360 && ans.limits.slowReadSeconds === 240,
    JSON.stringify(ans.limits));
}

console.log("\nENTRIES BETWEEN ROUNDS, NONE DURING A READ\n");
{
  const four = await run({ fake: { insertAfterYearCount: { row: TYPING, after: [1, 2, 3, 4] } } });
  check("four entries, each just after a count of the year: settled in round 3 and written, all four in",
    four.summary && four.summary.ok === true && four.ps.inserted === 4 &&
    four.summary.attendanceRows === THIS_YEAR.length + 4 && four.summary.settleRounds === 3,
    JSON.stringify(four.summary || String(four.threw)).slice(0, 300));
  const live = four.summary && four.summary.windowDetail && four.summary.windowDetail.find((w) => w.live);
  check("...the live piece read twice a round, a read and its confirmation (6 reads), the others once",
    !!live && live.attempts === 6 && four.summary.windowDetail.filter((w) => !w.live).every((w) => w.attempts === 1),
    JSON.stringify(four.summary && four.summary.windowDetail));
  const three = await run({ fake: { insertAfterYearCount: { row: TYPING, after: [1, 2, 3] } } });
  check("three such entries: written too", three.summary && three.summary.ok === true &&
    three.summary.attendanceRows === THIS_YEAR.length + 3);
}

console.log("\nA REFUSAL RECORDS HOW FAR THE READ GOT\n");
{
  const r = await run({ fake: { insertDuringRead: { row: TYPING, afterPage: 1, match: isLiveQ, times: "always" } } });
  const d = r.health.last && r.health.last.windowDetail;
  check("a 'changing' refusal keeps each piece's reads in the record: pages, rows, seconds, attempts",
    r.health.last.code === "changing" && Array.isArray(d) && d.length === 3 &&
    d.filter((w) => !w.live).every((w) => w.attempts === 1 && w.pages > 0 && w.rows > 0 && typeof w.seconds === "number") &&
    d.find((w) => w.live).attempts === 4, JSON.stringify(d));
  check("...and the attendance pages, ms per page and the pieces' own seconds, beside cc and students",
    r.health.last.pages.attendance > 0 && r.health.last.pages.cc > 0 && r.health.last.pages.students > 0 &&
    typeof r.health.last.msPerPage === "number" && typeof r.health.last.piecesSeconds === "number",
    JSON.stringify(r.health.last.pages));
  check("...in `last` only: recent keeps the headline", !("windowDetail" in r.health.recent[0]));
  check("the reason no longer contradicts itself: the reads were in a row, and the counts it quotes are the last read's",
    /did not hold still in 4 reads in a row: PowerSchool counted \d+ rows before the last read and \d+ after it, and the read held \d+\. Probably somebody is entering attendance in it right now\./
      .test(r.summary.reason), r.summary.reason);
  check("a good run reports the pieces' own seconds beside readSeconds",
    typeof base.summary.piecesSeconds === "number" && base.health.last.piecesSeconds === base.summary.piecesSeconds);
  const cmp = await run({ args: { dryRun: true, compare: true } });
  check("...and the comparison carries piecesSeconds next to singleSeconds, like for like",
    typeof cmp.summary.compare.piecesSeconds === "number" && typeof cmp.summary.compare.singleSeconds === "number");
}

console.log("\nA REQUEST POWERSCHOOL NEVER ANSWERS\n");
{
  const within = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res("timeout"), ms))]);
  const hangAug = { match: (q) => /att_date=le=2026-08-31/.test(q), page: 1 };
  const budget = (s) => breakOnce(s, "const READ_BUDGET_MS = 6 * 60 * 1000;", "const READ_BUDGET_MS = 300;", "budget");
  const r = await within(run({ fake: { hang: hangAug }, transform: budget }), 5000);
  check("one page that never answers ends at the read budget: refused 'budget', nothing written",
    r !== "timeout" && refusedCleanly(r, "budget"),
    r === "timeout" ? "the run had not returned after 5 s" : JSON.stringify(r.summary).slice(0, 300));
  check("...recorded, with its retry kept and nothing left reading",
    r !== "timeout" && r.health.last.code === "budget" && r.scheduled.length === 1 && r.cancelled.length === 0 &&
    r.ps.log.every((e) => e.finished));
  const t = await within(run({ fake: { hang: hangAug }, transform: (s) => breakOnce(budget(s),
    'Accept: "application/json" }, signal });', 'Accept: "application/json" } });', "no-signal") }), 1500);
  check("TEETH: without the per-request timeout the same run never returns", t === "timeout");
}

console.log("\nTHE SINGLE READ (THE SWITCH OFF, THE LIVE PATH) REFUSES A TRUNCATED YEAR\n");
{
  const wall = (s) => breakOnce(s, "export const MAX_PAGES = 400;", "export const MAX_PAGES = 3;", "wall");
  const out = await run({ monthPieces: false, transform: wall });
  check("switch off, the year past MAX_PAGES: refused 'paged-out', nothing cleared, recorded",
    out.summary && out.summary.ok === false && out.summary.code === "paged-out" && /attendance paged out at/.test(out.summary.reason) &&
    wroteNothing(out) && out.health.last.code === "paged-out" && out.health.last.readMode === "single read",
    JSON.stringify(out.summary).slice(0, 300));
  const bypass = await run({ monthPieces: false, transform: (s) => breakOnce(wall(s),
    'att = await readTable(host, tok, "attendance", `schoolid==${schoolid};yearid==${yearid}`,\n          "studentid,att_date,periodid,attendance_codeid,ccid");',
    'att = { ...(await readTable(host, tok, "attendance", `schoolid==${schoolid};yearid==${yearid}`,\n          "studentid,att_date,periodid,attendance_codeid,ccid")), pagedOut: false };',
    "bypass") });
  check("TEETH: with that guard bypassed, the same truncated read clears and rewrites the tables",
    bypass.summary && bypass.summary.ok === true && bypass.replaceCalls.length > 0 && bypass.summary.attendanceRows === 300,
    JSON.stringify(bypass.summary || String(bypass.threw)).slice(0, 200));
}

console.log("\nA REFUSAL AND ITS RETRY, ON ONE RECORD\n");
{
  const shared = makeDb();
  const first = await run({ shared, fake: { insertDuringRead: { row: TYPING, afterPage: 1, match: isLiveQ, times: "always" } } });
  check("the refusal is `last`, and is NOT filed as the last good rebuild",
    first.summary.ok === false && first.health.last.ok === false && !first.health.lastOk,
    JSON.stringify(first.health.lastOk || null).slice(0, 120));
  const retry = await run({ shared, args: { retryOf: first.scheduled[0].args.retryOf } });
  check("...so its booked retry really runs (not skipped as 'the original finished ok') and writes",
    retry.summary.ok === true && !retry.summary.skipped && retry.replaceCalls.length > 0 &&
    retry.health.lastOk.trigger === "retry" && retry.health.last.ok === true && retry.health.recent.length === 2,
    JSON.stringify(retry.summary).slice(0, 200));
  const R = loadRoster();
  const overdue = { runId: "b", ok: false, code: "coverage", stage: "read", reason: "x", startedAt: laAgo(40), finishedAt: laAgo(39), retryAt: laAgo(25) };
  const v = R.rebuildHealthVerdict({ last: overdue, lastOk: OK_MORNING, recent: [overdue, OK_MORNING] }, LA_NOW, {}, LA_NOW);
  check("a refusal whose retry time has passed, with no retry running, is an alarm -- not a warning forever", v.level === "bad", v.headline);
  const vr = R.rebuildHealthVerdict({ last: overdue, lastOk: OK_MORNING, running: { runId: "c", retryOf: "b", startedAt: laAgo(5) } },
    LA_NOW, {}, LA_NOW);
  check("...but a warning while that retry is running", vr.level === "warn", vr.headline);
}

console.log("\nTWO RUNS AT ONCE: THE ONE REFUSED 'LOCK-HELD' RAISES NO ALARM\n");
{
  const { db } = makeDb();
  const ctx = { db };
  const at = new Date().toISOString();
  await STATS.noteAttendanceRebuildStart.handler(ctx, { runId: "A", startedAt: at });
  await STATS.noteAttendanceRebuildStart.handler(ctx, { runId: "B", startedAt: at });
  const a = await STATS.claimAttendanceRebuildWrite.handler(ctx, { runId: "A", startedAt: at, yearid: "36", yearCount: 21407 });
  const b = await STATS.claimAttendanceRebuildWrite.handler(ctx, { runId: "B", startedAt: at, yearid: "36", yearCount: 21407 });
  check("A holds the lock, B is refused", a.ok === true && b.ok === false && b.code === "lock-held");
  await STATS.finishAttendanceRebuild.handler(ctx, { runId: "A", record: { runId: "A", ok: true, startedAt: at,
    finishedAt: new Date().toISOString(), attendanceRows: 21407, readSeconds: 100, seconds: 120, readMode: "month pieces", windows: 3 } });
  await STATS.finishAttendanceRebuild.handler(ctx, { runId: "B", record: { runId: "B", ok: false, trigger: "retry",
    code: "lock-held", stage: "read", reason: b.reason, startedAt: at, finishedAt: new Date().toISOString() } });
  const value = (await db.query("appState").collect())[0].value;
  const now = new Date().toISOString();
  const v = loadRoster().rebuildHealthVerdict(value, now, {}, now);
  check("B's finish landing after A's ok leaves A as `last`, and the verdict ok",
    value.last.runId === "A" && value.lastOk.runId === "A" && v.level === "ok", `${value.last.runId}/${v.level}: ${v.headline}`);
  check("...B is in recent, and a lock-held retry writes no 'twice in a row' audit entry",
    value.recent[0].runId === "B" && value.recent[0].code === "lock-held" &&
    (await db.query("appAuditLog").collect()).length === 0);
}

console.log("\nAFTER A FAILED WRITE, NOBODY IS TOLD THE SCREENS ARE INTACT\n");
{
  const R = loadRoster();
  const V = (h) => R.rebuildHealthVerdict(h, LA_NOW, {}, LA_NOW);
  const wrote = { runId: "w", ok: false, code: "failed", stage: "write", startedAt: laAgo(30), finishedAt: laAgo(28),
    retryAt: laAgo(15), reason: "The rebuild failed while writing: x Some attendance tables may be short until the retry rewrites them." };
  const retryRead = { runId: "r", ok: false, trigger: "retry", retryOf: "w", code: "failed", stage: "read", startedAt: laAgo(15),
    finishedAt: laAgo(14), reason: "The rebuild failed while reading: y Nothing was written; the previous tables are untouched." };
  const v = V({ last: retryRead, lastOk: OK_MORNING, recent: [retryRead, wrote, OK_MORNING] });
  check("a write that failed, then its retry refused while reading: 'may be incomplete since', not 'still show the data from'",
    v.level === "bad" && /Some attendance screens may be incomplete since Oct 2, 12:32 PM, when a rebuild failed while writing\./.test(v.headline) &&
    !/still show the data from/.test(v.headline), v.headline);
  // The stage noteAttendanceRebuildStart now files: 'write' when the run held the lock.
  const killed = { runId: "k", ok: false, code: "abandoned", stage: "write", startedAt: laAgo(200), finishedAt: null,
    reason: "This run never finished: Convex stopped it, while it was writing." };
  const vk = V({ last: killed, lastOk: OK_MORNING, recent: [killed, OK_MORNING] });
  check("a run stopped while writing: the same", /may be incomplete since .*was stopped while writing/.test(vk.headline) &&
    !/still show the data from/.test(vk.headline), vk.headline);
  const stuck = V({ last: OK_MORNING, lastOk: OK_MORNING, recent: [OK_MORNING], running: { runId: "s", startedAt: laAgo(20) },
    writing: { runId: "s", startedAt: laAgo(20), claimedAt: laAgo(18) } });
  check("a run stuck while it held the write lock: 'may be incomplete' as well",
    stuck.level === "bad" && /may be incomplete since/.test(stuck.headline), stuck.headline);
  const readOnly = { runId: "q", ok: false, code: "coverage", stage: "read", reason: "z", startedAt: laAgo(15), finishedAt: laAgo(14) };
  const vq = V({ last: readOnly, lastOk: OK_MORNING, recent: [readOnly, OK_MORNING] });
  check("CONTROL: a refusal with nothing written since the last good run still names that run's data",
    /still show the data from Oct 2, 6:32 AM/.test(vq.headline) && !/incomplete/.test(vq.headline), vq.headline);
  const older = { runId: "o", ok: false, code: "failed", stage: "write", startedAt: "2026-10-01T19:30:00.000Z", finishedAt: "2026-10-01T19:31:00.000Z" };
  const vo = V({ last: readOnly, lastOk: OK_MORNING, recent: [readOnly, OK_MORNING, older] });
  check("CONTROL: a failed write from BEFORE the last good run does not count", !/incomplete/.test(vo.headline), vo.headline);
  // The audit entry the failed retry writes, through the real rebuild and the real mutation.
  const r = await run({ args: { retryOf: "w" }, fake: { failCountWith500: Infinity },
    state: { lastOk: OK_MORNING, last: wrote, recent: [wrote, OK_MORNING] } });
  const details = r.audit.length === 1 ? String(r.audit[0].payload.details) : "";
  check("the audit entry the failed retry writes says so too",
    /Some attendance screens may have been incomplete since Oct 2, 12:32 PM, when a rebuild failed while writing\./.test(details) &&
    !/showing the data from/.test(details), details || `${r.audit.length} audit entries`);
}

console.log("\nTHE DASHBOARD TILE, AS DRAWN\n");
const TWICE = { runId: "r", ok: false, trigger: "retry", code: "changing", stage: "read", reason: "The piece kept changing",
  startedAt: new Date(Date.now() - 3 * 60000).toISOString(), finishedAt: new Date(Date.now() - 2 * 60000).toISOString() };
const OK_RECENT = Object.assign({}, OK_MORNING, { finishedAt: new Date(Date.now() - 400 * 60000).toISOString() });
{
  const R = loadRoster();
  const now = new Date().toISOString();
  const pending = Object.assign({}, TWICE, { runId: "b", trigger: "scheduled/manual", retryAt: new Date(Date.now() + 12 * 60000).toISOString() });
  const bad = R.rebuildHealthVerdict({ last: TWICE, lastOk: OK_RECENT, recent: [TWICE, OK_RECENT] }, now, {}, now);
  const warn = R.rebuildHealthVerdict({ last: pending, lastOk: OK_RECENT, recent: [pending, OK_RECENT] }, now, {}, now);
  const parts = ["escapeHtml", "wcTile", "attendanceRebuildTile"].map((n) => grabFn(scriptSrc, n));
  const tile = parts.every(Boolean) ? new Function(parts.join("\n") + "\nreturn attendanceRebuildTile;")() : null;
  const badHtml = tile ? tile(bad) : "", warnHtml = tile ? tile(warn) : "";
  check("the scheduled run and its retry both refused: the tile is a RED figure, not the grey 'no data' text",
    bad.level === "bad" && /class="wu-tile-figure wu-tile-bad">Not updating</.test(badHtml) && !/wu-absent/.test(badHtml),
    badHtml || "(no attendanceRebuildTile in script.js)");
  check("...with the verdict's own words beneath it", !!bad.tile && badHtml.includes(bad.tile) && /wu-figure-label/.test(badHtml));
  check("a warning is a figure too, and does not look like the alarm",
    warn.level === "warn" && /Needs a look</.test(warnHtml) && !/wu-tile-bad/.test(warnHtml) && !/wu-absent/.test(warnHtml), warnHtml);
  check("the dashboard draws its tile through that function",
    /\(isAdmin && \(attRebuild\.level === 'warn' \|\| attRebuild\.level === 'bad'\)\)\s*\?\s*attendanceRebuildTile\(attRebuild\)/.test(scriptSrc));
  check("the red it relies on exists", /\.wu-tile-figure\.wu-tile-bad\s*\{\s*color: var\(--wu-bad\)/.test(read("./wildcat-ui.css")));
}

console.log("\nTHE BROWSER'S COPY: REPAINTED AND RE-CHECKED BY ITSELF\n");
{
  const from = scriptSrc.indexOf("let _attRebuildHealth = null;");
  const verdictFn = grabFn(scriptSrc, "attendanceRebuildVerdict");
  const block = scriptSrc.slice(from, scriptSrc.indexOf(verdictFn) + verdictFn.length);
  const harness = (health, onScreen) => {
    const calls = { render: 0, update: 0, timers: [] };
    const win = {
      WildcatRoster: loadRoster(),
      WildcatAuth: { getSession: () => ({ idToken: "t" }), convexQuery: async () => ({ health, limits: {} }) },
    };
    const api = new Function("currentUser", "window", "setTimeout", "clearTimeout", "console", "wcPanelOnScreen",
      "renderTeacherDashboard", "updateDashboard", "wcTile",
      block + "\nreturn { fetchAttendanceRebuildHealth, attendanceRebuildVerdict };")(
      { role: "admin" }, win, (fn, ms) => { calls.timers.push(ms); return calls.timers.length; }, () => {},
      { warn: () => {} }, () => onScreen, () => { calls.render++; }, () => { calls.update++; }, () => "");
    return { api, calls };
  };
  const BAD = { last: TWICE, lastOk: OK_RECENT, recent: [TWICE, OK_RECENT] };
  const h1 = harness(BAD, true);
  await h1.api.fetchAttendanceRebuildHealth(true);
  check("trouble appearing repaints the dashboard tiles (renderTeacherDashboard), not the Cash stats",
    h1.api.attendanceRebuildVerdict().level === "bad" && h1.calls.render === 1 && h1.calls.update === 0, JSON.stringify(h1.calls));
  check("...and books its own re-check five minutes on, so it clears without a reload",
    h1.calls.timers.length === 1 && h1.calls.timers[0] >= 5 * 60000 && h1.calls.timers[0] <= 6 * 60000, JSON.stringify(h1.calls.timers));
  const h2 = harness(BAD, false);
  await h2.api.fetchAttendanceRebuildHealth(true);
  check("...but never draws a dashboard that is not on screen", h2.calls.render === 0 && h2.calls.update === 0);
  const h3 = harness({ last: OK_RECENT, lastOk: OK_RECENT, recent: [OK_RECENT] }, true);
  await h3.api.fetchAttendanceRebuildHealth(true);
  check("a healthy record books no re-check", h3.api.attendanceRebuildVerdict().level === "ok" && h3.calls.timers.length === 0);
}

console.log("\nTHE CARD'S SCHEDULE\n");
check("the card does not state the summer times as fact all year: an hour earlier in winter",
  /about <b>6:30 AM<\/b> and\s*<b>12:30 PM<\/b> \(an hour earlier in winter/.test(htmlSrc));

// ======================================================================
// THE SECOND REVIEW OF 2026-10-02. Each check below fails on the code as it
// stood before its fix (the TEETH checks break the fix itself).
// ======================================================================
const TABLES4 = ["days", "totals", "dayTotals", "marks"];
const isoAt = (ms) => new Date(ms).toISOString();

console.log("\nA SAVE DURING THE LIVE PIECE'S FIRST READ\n");
{
  // One teacher save: the first row page 1 served is deleted, a new absence
  // is inserted, both counts stay the same, and page 2 shifts by one.
  const SWAP_IN = { yearid: 36, schoolid: 1, studentid: "st112", att_date: "2026-10-01T00:00:00", periodid: 4,
                    attendance_codeid: C.A, ccid: 504 };
  const swap = { row: SWAP_IN, afterPage: 1, match: isLiveQ, times: "once" };
  const r = await run({ fake: { swapDuringRead: swap } });
  const gone = r.ps.deleted.map((x) => String(x.id));
  const truth = await run({ tables: { attendance: [...ATTENDANCE.filter((x) => !gone.includes(String(x.id))), { ...SWAP_IN, id: 950001 }] } });
  check("a delete and an insert during the live piece's first read: it is read again, and the run writes what PowerSchool holds",
    r.summary && r.summary.ok === true && r.ps.swaps === 1 && gone.length === 1 &&
    TABLES4.every((k) => same(r.canon[k], truth.canon[k]) && r.canon[k].length > 0),
    JSON.stringify(r.summary || String(r.threw)).slice(0, 300));
  const marks = Object.fromEntries(r.out.marks.map((m) => [m.studentNumber, m]));
  check("...the deleted absence is gone, the new one is in, and the row the page shift skipped is held",
    gone[0] === String(SPECIAL[6].id) && !marks[NUM.st107].absentDates.includes("2026-09-30") &&
    marks[NUM.st112].absentDates.includes("2026-10-01") && r.summary.attendanceRows === THIS_YEAR.length,
    JSON.stringify({ gone, rows: r.summary && r.summary.attendanceRows }));
  check("a quiet live piece is read exactly twice, a read and its confirmation; the months once",
    base.summary.windowDetail.find((w) => w.live).attempts === 2 &&
    base.summary.windowDetail.filter((w) => !w.live).every((w) => w.attempts === 1));
  const one = await run({ fake: { swapDuringRead: swap }, transform: (s) => breakOnce(s,
    "const confirmed = prevIds === null ? !confirm : sameList(prevIds, ids);",
    "const confirmed = prevIds === null || sameList(prevIds, ids);", "one-read") });
  check("TEETH: taken on its one steady read, the same run says ok and writes the deleted absence",
    one.summary && one.summary.ok === true && !TABLES4.every((k) => same(one.canon[k], truth.canon[k])));
  check("the gap that remains (a closed month read once) is named where the proof says what it does not prove",
    /WHAT IT DOES NOT PROVE[\s\S]{0,400}CLOSED month read once, a delete and an insert/.test(daysSrc));
}

console.log("\nA 'CHANGING' REFUSAL SAYS WHAT DID NOT HOLD STILL\n");
{
  const aug = (q) => /att_date=le=2026-08-31/.test(q || "");
  const r = await run({ fake: { unstablePaging: { match: aug } } });
  check("a closed month whose pages come back in a new order each time: refused 'changing', naming the paging, not teachers",
    refusedCleanly(r, "changing") &&
    /The piece up to 2026-08-31 did not hold still in 3 reads in a row: PowerSchool counted (\d+) rows before the last read and \1 after it, and the read held \d+\./
      .test(r.summary.reason) &&
    /unstable order/.test(r.summary.reason) && !/entering attendance in it right now/.test(r.summary.reason),
    r.summary && r.summary.reason);
  const sw = await run({ fake: { swapDuringRead: { row: TYPING, afterPage: 1, match: isLiveQ, times: "always" } } });
  check("steady counts but different rows on every read: says so, rather than 'counted N, the read held N'",
    refusedCleanly(sw, "changing") &&
    /held exactly the \d+ rows PowerSchool counted, but not the same rows as the read before it/.test(sw.summary.reason) &&
    !/last counted/.test(sw.summary.reason), sw.summary && sw.summary.reason);
}

console.log("\nWHAT HAPPENS NEXT IS SAID ONCE, AND TRULY\n");
{
  const always = { insertDuringRead: { row: TYPING, afterPage: 1, match: isLiveQ, times: "always" } };
  const shared = makeDb();
  const first = await run({ shared, fake: always });
  check("a scheduled run's refusal: the record leaves the retry to retryAt; the run's answer names the time",
    !!first.health.last.retryAt && !/runs again|15 minutes/.test(first.health.last.reason) &&
    first.summary.reason.includes(`It runs again by itself at ${laClock(first.health.last.retryAt)}, 15 minutes after it started.`),
    first.summary && first.summary.reason);
  const retry = await run({ shared, args: { retryOf: first.scheduled[0].args.retryOf }, fake: always });
  const p = retry.audit[0] && retry.audit[0].payload;
  const NEXT = /Nothing runs again until the next scheduled rebuild\.$/;
  check("its retry, refused again, books nothing and says so: record, answer and audit entry",
    !retry.health.last.retryAt && NEXT.test(retry.health.last.reason) && NEXT.test(retry.summary.reason) &&
    !!p && /Nothing runs again until the next scheduled rebuild\./.test(p.details) &&
    ![retry.health.last.reason, retry.summary.reason, p.details, p.reason].some((t) => /15 minutes|runs again by itself/.test(t)),
    retry.health.last.reason);
  const now = new Date().toISOString();
  const v = loadRoster().rebuildHealthVerdict(retry.health, now, {}, now);
  check("...and the red card headline no longer promises a run",
    v.level === "bad" && /Nothing runs again until the next scheduled rebuild\./.test(v.headline) &&
    !/15 minutes|runs again by itself/.test(v.headline), v.headline);
  const wr = await run({ args: { retryOf: "x" }, override: { replaceAbsenceTotals: () => { throw new Error("Convex said no"); } } });
  check("a retry that fails while WRITING no longer says 'until the retry rewrites them'",
    wr.health.last.stage === "write" &&
    /until a later run rewrites them\. Nothing runs again until the next scheduled rebuild\.$/.test(wr.health.last.reason) &&
    !/the retry rewrites/.test(wr.health.last.reason), wr.health.last.reason);
  const dry = await run({ args: { dryRun: true }, fake: always });
  check("a dry run's refusal says nothing runs again, too",
    dry.summary.ok === false && NEXT.test(dry.summary.reason) && NEXT.test(dry.health.lastDryRun.reason), dry.summary.reason);
  const codeOnly = daysSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no refusal in the source carries a retry sentence of its own",
    !/runs again in 15 minutes|until the retry rewrites/i.test(codeOnly));
}

console.log("\nA RUN CONVEX STOPPED, FILED AT THE STAGE IT WAS IN\n");
{
  const startOn = async (value, args) => {
    const { db } = makeDb();
    await db.insert("appState", { key: "attendanceRebuild", value, mirroredAt: "x" });
    await STATS.noteAttendanceRebuildStart.handler({ db }, Object.assign({ runId: "n", startedAt: isoAt(Date.now()) }, args || {}));
    return (await db.query("appState").collect())[0].value;
  };
  const OK0 = Object.assign({}, OK_MORNING, { finishedAt: isoAt(Date.now() - 60 * 60000) });
  const R = loadRoster();
  const V = (h) => { const now = new Date().toISOString(); return R.rebuildHealthVerdict(h, now, {}, now); };

  // Stopped while READING: it never claimed the write lock. Found by its own retry.
  const rd = await startOn({ lastOk: OK0, last: OK0, recent: [OK0],
    running: { runId: "rd", startedAt: isoAt(Date.now() - 16 * 60000), retryOf: null } }, { retryOf: "rd" });
  const fr = rd.recent.find((x) => x.runId === "rd");
  check("a run stopped while still READING is filed at stage 'read', saying nothing was cleared",
    !!fr && fr.code === "abandoned" && fr.stage === "read" && /before anything was cleared/.test(fr.reason), JSON.stringify(fr));
  const vr = V(rd);
  check("...while its retry runs: a warning, not an alarm", vr.level === "warn" && /Its retry is running now\./.test(vr.headline), vr.headline);
  const vd = V(Object.assign({}, rd, { running: null }));
  check("...and afterwards not 'may be incomplete': the screens still show the last good data",
    vd.level === "bad" && /still show the data from/.test(vd.headline) && !/incomplete/.test(vd.headline), vd.headline);

  // Stopped while WRITING: it held the lock.
  const wv = await startOn({ lastOk: OK0, last: OK0, recent: [OK0],
    running: { runId: "wr", startedAt: isoAt(Date.now() - 12 * 60000), retryOf: null },
    writing: { runId: "wr", startedAt: isoAt(Date.now() - 12 * 60000), claimedAt: isoAt(Date.now() - 11 * 60000) } });
  const fw = wv.recent.find((x) => x.runId === "wr");
  check("a run stopped while holding the write lock is filed at stage 'write', and its dead lock is cleared",
    !!fw && fw.stage === "write" && /while it was writing/.test(fw.reason) && wv.writing === null, JSON.stringify(fw));
  const vw = V(Object.assign({}, wv, { running: null }));
  check("...and the card says the screens may be incomplete", vw.level === "bad" &&
    /may be incomplete since .*was stopped while writing/.test(vw.headline), vw.headline);

  // A write lock whose run is no longer in `running` at all.
  const orphan = await startOn({ lastOk: OK0, last: OK0, recent: [OK0], running: null,
    writing: { runId: "W", startedAt: isoAt(Date.now() - 11 * 60000), claimedAt: isoAt(Date.now() - 10 * 60000) } });
  check("a dead write lock with no run behind it is filed as stopped while writing, and cleared",
    orphan.recent.some((x) => x.runId === "W" && x.code === "abandoned" && x.stage === "write") && orphan.writing === null);
}

console.log("\nA RUN REFUSED 'LOCK-HELD' NO LONGER HIDES THE RUN THAT IS WRITING\n");
{
  const { db } = makeDb();
  const ctx = { db };
  const OK0 = Object.assign({}, OK_MORNING, { finishedAt: isoAt(Date.now() - 6 * 3600000) });
  const X = { runId: "X", ok: false, code: "changing", stage: "read", reason: "The piece kept changing",
    startedAt: isoAt(Date.now() - 19 * 60000), finishedAt: isoAt(Date.now() - 18 * 60000), retryAt: isoAt(Date.now() - 4 * 60000) };
  await db.insert("appState", { key: "attendanceRebuild", value: { lastOk: OK0, last: X, recent: [X, OK0] }, mirroredAt: "x" });
  const hAt = isoAt(Date.now() - 5 * 60000);
  await STATS.noteAttendanceRebuildStart.handler(ctx, { runId: "H", startedAt: hAt });
  const hc = await STATS.claimAttendanceRebuildWrite.handler(ctx, { runId: "H", startedAt: hAt, yearid: "36", yearCount: 21500 });
  const rAt = isoAt(Date.now());
  await STATS.noteAttendanceRebuildStart.handler(ctx, { runId: "R", startedAt: rAt, retryOf: "X" });
  const rc = await STATS.claimAttendanceRebuildWrite.handler(ctx, { runId: "R", startedAt: rAt, yearid: "36", yearCount: 21500 });
  await STATS.finishAttendanceRebuild.handler(ctx, { runId: "R", record: { runId: "R", ok: false, trigger: "retry", retryOf: "X",
    code: "lock-held", stage: "read", reason: rc.reason, startedAt: rAt, finishedAt: isoAt(Date.now()) } });
  const row = (await db.query("appState").collect())[0];
  const live = row.value.running || {};
  check("H writing, R refused 'lock-held' and finished: H is still in `running`, R is not",
    hc.ok === true && rc.code === "lock-held" && !!live.H && !live.R && row.value.writing.runId === "H", JSON.stringify(row.value.running));
  // H is then stopped mid-write. Twenty minutes later:
  const later = isoAt(Date.now() + 20 * 60000);
  const v = loadRoster().rebuildHealthVerdict(JSON.parse(JSON.stringify(row.value)), later, {}, later);
  check("...the card says the run did not finish and the screens may be incomplete -- not 'still show the data from'",
    v.level === "bad" && /did not finish/.test(v.headline) && /may be incomplete/.test(v.headline) && !/still show the data from/.test(v.headline),
    v.headline);
  // ...and the next run to start files H.
  row.value.running.H.startedAt = isoAt(Date.now() - 25 * 60000);
  row.value.writing.startedAt = isoAt(Date.now() - 25 * 60000);
  await STATS.noteAttendanceRebuildStart.handler(ctx, { runId: "N", startedAt: isoAt(Date.now()) });
  const after = (await db.query("appState").collect())[0].value;
  check("...and the next run to start files H as stopped while writing, and clears its lock",
    after.recent.some((x) => x.runId === "H" && x.code === "abandoned" && x.stage === "write") && after.writing === null &&
    Object.keys(after.running).join(",") === "N", JSON.stringify(after.running));
}

console.log("\nA GOOD RUN WHOSE RECORD FAILS ONCE\n");
{
  let tries = 0;
  const r = await run({ override: { finishAttendanceRebuild: (a) => {
    tries++;
    if (a.record && a.record.windowDetail) throw new Error("the record could not be written");
  } } });
  check("the finish is tried once more, without the per-piece detail: lastOk is this run, its marker and lock are gone",
    r.summary.ok === true && tries === 2 && !!r.health.lastOk && r.health.lastOk.runId === r.health.last.runId &&
    r.health.last.recordTrimmed === true && !("windowDetail" in r.health.last) &&
    r.health.running === null && r.health.writing === null, JSON.stringify({ tries, running: r.health.running }));
}

console.log("\nTHE { since } MEASURING READ IS THIS YEAR'S\n");
{
  const m = await run({ args: { since: "2026-08-01", dryRun: true } });
  const reads = attendanceReads(m);
  const want = THIS_YEAR.filter((x) => x.att_date.slice(0, 10) >= "2026-08-01").length;
  check("it carries yearid==36, so last year's row dated 2026-08-20 is not served",
    m.summary.ok === true && reads.length > 0 && reads.every((e) => /(^|;)yearid==36(;|$)/.test(e.q)) &&
    m.summary.attendanceRows === want, `${m.summary.attendanceRows} vs ${want}`);
}

console.log("\nTHE COMPARISON: AN ENTRY BETWEEN THE READS, AN OVERLAP, AND WHAT IT PROVES\n");
{
  const clean = await run({ args: { dryRun: true, compare: true } });
  check("the verdict says the tables were made by this build's own processing on both sides",
    clean.summary.compare.identical === true && /this build's own processing/.test(clean.summary.compare.verdict),
    clean.summary.compare.verdict);
  const NEW = { yearid: 36, schoolid: 1, studentid: "st111", att_date: "2026-10-02T00:00:00", periodid: 7,
                attendance_codeid: C.A, ccid: 507 };
  const between = await run({ args: { dryRun: true, compare: true }, fake: { insertBeforeSingleRead: NEW } });
  const c = between.summary.compare;
  check("an absence entered between the pieces and the old single read: 'PowerSchool changed between the two reads'",
    c.identical === false && c.onlyInSingle === 1 && c.newerInSingle === 1 && c.yearCountAfterSingle === c.singleDistinct &&
    /^PowerSchool changed between the two reads/.test(c.verdict) && /out of school hours/.test(c.verdict) &&
    !/leave the month pieces off/.test(c.verdict), JSON.stringify(c).slice(0, 400));
  const swapped = await run({ args: { dryRun: true, compare: true },
    fake: { swapFieldInWindows: { id: SPECIAL[3].id, field: "attendance_codeid", value: C.X } } });
  check("CONTROL: a row the pieces read differently is still 'different: leave the month pieces off'",
    /^different: leave the month pieces off/.test(swapped.summary.compare.verdict), swapped.summary.compare.verdict);
  const overlapNoProof = (s) => breakOnce(breakOnce(breakOnce(s,
    "const to = k === cuts.length ? null : addDays(cuts[k], -1);", "const to = k === cuts.length ? null : cuts[k];", "overlap"),
    "    if (yBefore === yAfter && yAfter === held && !overlap) {", "    if (true) {", "no-proof"),
    "  if (rows.length !== yearCount - undatedRows) {", "  if (false) {", "no-union-check");
  const ov = await run({ args: { dryRun: true, compare: true }, transform: overlapNoProof });
  const oc = ov.summary && ov.summary.compare;
  check("pieces that overlap by a day, with the count proof switched off, are caught by the comparison itself",
    !!oc && oc.possible === true && oc.windowRepeats > 0 && oc.identical === false && Object.values(oc.tables).every(Boolean),
    JSON.stringify(oc || ov.summary || String(ov.threw)).slice(0, 300));
  const und = await run({ args: { dryRun: true, compare: true }, fake: { nullDateRow: true } });
  check("a row with no date is counted apart, so a year holding one still compares identical",
    und.summary.compare.identical === true && und.summary.compare.singleUndated === 1 && und.summary.undatedRows === 1,
    JSON.stringify(und.summary.compare).slice(0, 300));
}

console.log("\nTHE AUDIT ENTRY: SAID WHERE IT IS SHOWN, AND ONLY TO ADMINS\n");
{
  const r = await run({ args: { retryOf: "orig" }, fake: { failCountWith500: Infinity },
    state: { lastOk: OK_MORNING, last: OK_MORNING, recent: [OK_MORNING] } });
  const p = r.audit[0] && r.audit[0].payload;
  check("the entry's REASON -- the field the dashboard feed renders -- says what stopped and what the screens hold",
    !!p && /did not complete \(failed\)\. Attendance screens were left showing the data from Oct 2, 6:32 AM\./.test(p.reason),
    p && p.reason);
  const sandbox = {};
  new Function("globalThis", read("./wildcat-cashaudit.js")).call(sandbox, sandbox);
  const feedFor = new Function("window", "currentUser", "CASH_STAFF_VIEW_ROLES",
    ["cashStaffViewsAllowed", "cashAuditEntriesFor", "dashFeedEntriesFor"].map((n) => grabFn(scriptSrc, n)).join("\n") +
    "\nreturn dashFeedEntriesFor;")({ WildcatCashAudit: sandbox.WildcatCashAudit }, null, ["admin", "superadmin", "pbis"]);
  const other = { entryId: "o", action: "Awarded Tickets", teacher: "Ms. Lee", teacherId: "t1", studentId: "s6",
    studentName: "Kid S6", reason: "Raffle entry", ticketCount: 1, timestamp: "2026-10-02T20:00:00.000Z" };
  const shown = (role) => feedFor([p, other], { id: "u1", role }).map((e) => e.action);
  check("a teacher's dashboard feed does not carry the rebuild alarm; everything else is left as it was",
    !shown("teacher").includes("attendance_rebuild_refused") && shown("teacher").includes("Awarded Tickets"),
    JSON.stringify(shown("teacher")));
  check("...nor PBIS's; admins and superadmins see it, like the tile and the card",
    !shown("pbis").includes("attendance_rebuild_refused") && shown("admin").includes("attendance_rebuild_refused") &&
    shown("superadmin").includes("attendance_rebuild_refused"));
}

console.log("\nDEPLOY DAY: NO GOOD RUN ON RECORD YET\n");
{
  const r = await run({ args: { retryOf: "orig" }, fake: { failCountWith500: Infinity } });
  const p = r.audit[0] && r.audit[0].payload;
  const BEFORE = /still show the last rebuild from before this record began \(no good run recorded since\)\./;
  const LEFT = /were left showing the last rebuild from before this record began \(no good run recorded since\)\./;
  check("the audit entry says the screens held the last rebuild from before the record began, not 'no good run yet'",
    !!p && LEFT.test(p.reason) && LEFT.test(p.details) && !/no good run yet/.test(p.details + p.reason), p && p.details);
  const now = new Date().toISOString();
  const v = loadRoster().rebuildHealthVerdict(r.health, now, {}, now);
  check("...and so does the card", v.level === "bad" && BEFORE.test(v.headline) && !/no good rebuild yet/.test(v.headline), v.headline);
}

console.log("\n'CURRENT' ONLY FROM A COPY THAT WAS JUST CHECKED\n");
{
  const R = loadRoster();
  const now = Date.now();
  const old = { runId: "a", ok: true, startedAt: isoAt(now - 22 * 3600000), finishedAt: isoAt(now - 22 * 3600000 + 120000),
    attendanceRows: 21407, readSeconds: 90, seconds: 120, readMode: "month pieces", windows: 3 };
  const h = { last: old, lastOk: old, recent: [old] };
  const v = R.rebuildHealthVerdict(h, isoAt(now), {}, isoAt(now - 40 * 60000));
  check("the card's re-check failed and its copy is 40 minutes old: 'could not re-check just now', never 'current'",
    v.level === "unknown" && /^Could not re-check just now; last rebuilt /.test(v.headline) && !/current/.test(v.headline), v.headline);
  check("CONTROL: the same record, just fetched, is the alarm it should be",
    R.rebuildHealthVerdict(h, isoAt(now), {}, isoAt(now)).level === "bad");
  // That old copy now reads 'unknown' where it read 'ok'; neither draws a tile,
  // so a refetch that changes only that must not redraw the dashboard.
  const from = scriptSrc.indexOf("let _attRebuildHealth = null;");
  const verdictFn = grabFn(scriptSrc, "attendanceRebuildVerdict");
  const block = scriptSrc.slice(from, scriptSrc.indexOf(verdictFn) + verdictFn.length);
  const calls = { render: 0 };
  const api = new Function("currentUser", "window", "setTimeout", "clearTimeout", "console", "wcPanelOnScreen",
    "renderTeacherDashboard", "updateDashboard", "wcTile",
    block + "\nreturn { fetchAttendanceRebuildHealth, attendanceRebuildVerdict };")(
    { role: "admin" }, { WildcatRoster: R, WildcatAuth: { getSession: () => ({ idToken: "t" }),
      convexQuery: async () => ({ health: { last: OK_RECENT, lastOk: OK_RECENT, recent: [OK_RECENT] }, limits: {} }) } },
    () => 1, () => {}, { warn: () => {} }, () => true, () => { calls.render++; }, () => {}, () => "");
  await api.fetchAttendanceRebuildHealth(true);
  check("a refetch that changes no tile does not redraw the dashboard", api.attendanceRebuildVerdict().level === "ok" && calls.render === 0,
    JSON.stringify(calls));
}

console.log("\nA GOOD RUN'S OWN WARNING REACHES THE CARD\n");
{
  const codes = CODES.map((c) => ({ ...c, description: c.description.replace(/Tardy/, "Late") }));
  const r = await run({ tables: { attendance_code: codes } });
  check("the run's warning, tardyCodesFound and unmappedCcShare are in its record",
    r.summary.ok === true && /every student will look punctual/.test(String(r.health.last.warning)) &&
    r.health.last.tardyCodesFound === 0 && typeof r.health.last.unmappedCcShare === "number" &&
    r.health.lastOk.warning === r.health.last.warning, JSON.stringify(r.health.last).slice(0, 200));
  const now = new Date().toISOString();
  const v = loadRoster().rebuildHealthVerdict(r.health, now, {}, now);
  check("...and the card warns instead of saying 'current'",
    v.level === "warn" && /finished with a warning/.test(v.headline) && /punctual/.test(v.headline), v.headline);
}

// ======================================================================
// THE THIRD REVIEW OF 2026-10-03. Each check below fails on the code as it
// stood before its fix (the TEETH checks break the fix itself).
// ======================================================================
console.log("\nTHE COMPARISON: AN EDIT OR A DELETE BETWEEN THE TWO READS\n");
{
  const cmp = { dryRun: true, compare: true };
  const excused = await run({ args: cmp, fake: { editBeforeSingleRead: { id: SPECIAL[3].id, field: "attendance_codeid", value: C.X } } });
  const e = excused.summary.compare;
  check("an absence excused (A to X) between the pieces and the old single read: 'PowerSchool changed between the two reads', not 'different'",
    e.identical === false && e.differing === 1 && !!e.recheck && e.recheck.rows === 1 && e.recheck.matchSingle === 1 &&
    /^PowerSchool changed between the two reads: row\(s\) 1 edited after the month pieces read them\./.test(e.verdict) &&
    /run the comparison again/.test(e.verdict) && !/leave the month pieces off/.test(e.verdict), JSON.stringify(e).slice(0, 400));
  const redated = await run({ args: cmp, fake: { editBeforeSingleRead: { id: SPECIAL[4].id, field: "att_date", value: "2026-09-02T00:00:00" } } });
  check("...and one re-dated between them: the same",
    redated.summary.compare.differing === 1 && /^PowerSchool changed between the two reads: row\(s\) 1 edited/.test(redated.summary.compare.verdict),
    redated.summary.compare.verdict);
  const del = await run({ args: cmp, fake: { deleteBeforeSingleRead: SPECIAL[5].id } });
  const d = del.summary.compare;
  check("a row deleted between them: not 'the OLD single read came back short' -- that read matches PowerSchool's count after it",
    del.ps.deleted.length === 1 && d.onlyInWindows === 1 && d.yearCountAfterSingle === d.singleDistinct &&
    /^PowerSchool changed between the two reads: row\(s\) 1 deleted/.test(d.verdict) && !/OLD single read/.test(d.verdict),
    JSON.stringify(d).slice(0, 400));
  const rechecks = [excused, redated, del].flatMap((r) => r.ps.log.filter((x) => x.kind === "table" && /(^|;)id==/.test(x.q || "")));
  check("the re-read is by id, this year's, through a date clause, three at most at once",
    rechecks.length === 3 && rechecks.every((x) => /^schoolid==1;yearid==36;att_date=ge=1900-01-01;id==\d+$/.test(x.q)) &&
    [excused, redated, del].every((r) => r.ps.maxInFlight <= 3), rechecks.map((x) => x.q).join(" | "));
  const short = await run({ args: cmp, fake: { dropFromSingleRead: SPECIAL[5].id } });
  check("CONTROL: an old read that really is short of PowerSchool's count after it still says so",
    /^the OLD single read came back short/.test(short.summary.compare.verdict) &&
    short.summary.compare.yearCountAfterSingle > short.summary.compare.singleDistinct, short.summary.compare.verdict);
  const SWAP = { swapFieldInWindows: { id: SPECIAL[3].id, field: "attendance_codeid", value: C.X } };
  const sw = await run({ args: cmp, fake: SWAP });
  check("CONTROL: a row the PIECES read differently is re-read as they read it, and stays 'different: leave the month pieces off'",
    !!sw.summary.compare.recheck && sw.summary.compare.recheck.matchSingle === 0 &&
    /^different: leave the month pieces off/.test(sw.summary.compare.verdict), JSON.stringify(sw.summary.compare.recheck));
  const undatedRecheck = await run({ args: cmp, fake: SWAP, transform: (s) => breakOnce(s,
    "const q = `${yearQ};att_date=ge=${DATED_FROM};id==${id}`;", "const q = `${yearQ};id==${id}`;", "undated-recheck") });
  check("TEETH: re-read without the date clause, that pieces fault would pass for an edit between the reads",
    /^PowerSchool changed between the two reads/.test(undatedRecheck.summary.compare.verdict), undatedRecheck.summary.compare.verdict);
  const failing = await run({ args: cmp, fake: { editBeforeSingleRead: { id: SPECIAL[3].id, field: "attendance_codeid", value: C.X },
    failWindowWith500: { match: (q) => /;id==/.test(q), times: Infinity } } });
  check("a re-read PowerSchool will not answer excuses nothing: 'different', with the error kept",
    /^different: leave the month pieces off/.test(failing.summary.compare.verdict) && failing.summary.ok === true &&
    !!failing.summary.compare.recheck && failing.summary.compare.recheck.matchSingle === null &&
    /HTTP 500/.test(failing.summary.compare.recheck.error), JSON.stringify(failing.summary.compare.recheck));
}

console.log("\nA ROW WITH NO DATE, AND ENTRIES BETWEEN ROUNDS\n");
{
  const six = await run({ fake: { nullDateRow: true, insertAfterYearCount: { row: TYPING, after: [1, 2, 3, 4, 5, 6] } } });
  check("one undated row and an entry after each of six counts of the year: written, undatedRows 1, all six entries in",
    six.summary && six.summary.ok === true && six.summary.undatedRows === 1 && six.ps.inserted === 6 &&
    six.summary.attendanceRows === THIS_YEAR.length + 6 && six.summary.yearCount === THIS_YEAR.length + 7,
    JSON.stringify(six.summary || String(six.threw)).slice(0, 300));
  const four = await run({ fake: { nullDateRow: true, insertAfterYearCount: { row: TYPING, after: [1, 2, 3, 4] } } });
  check("...with four, it settles in round 3, exactly as a year with no undated row does",
    four.summary && four.summary.ok === true && four.summary.settleRounds === 3 && four.summary.undatedRows === 1,
    JSON.stringify(four.summary || String(four.threw)).slice(0, 300));
  const oldGate = await run({ fake: { nullDateRow: true, insertAfterYearCount: { row: TYPING, after: [1, 2, 3, 4, 5, 6] } },
    transform: (s) => breakOnce(s, "    if (yBefore === yAfter && held < yAfter && !overlap) {",
      "    if (round > 1 && !moved.length && yBefore === yAfter && held < yAfter && !overlap) {", "old-gate") });
  check("TEETH: tried only when nothing moved, the same run refuses 'coverage' and writes nothing",
    refusedCleanly(oldGate, "coverage"), JSON.stringify(oldGate.summary).slice(0, 300));
}

console.log("\nA RETRY CONVEX STOPPED IS AUDITED, AND THE CARD STOPS PROMISING A PAST RUN\n");
{
  const X = { runId: "X", ok: false, code: "changing", stage: "read", reason: "The piece kept changing",
    startedAt: isoAt(Date.now() - 40 * 60000), finishedAt: isoAt(Date.now() - 39 * 60000), retryAt: isoAt(Date.now() - 25 * 60000) };
  const r = await run({ state: { lastOk: OK_MORNING, last: X, recent: [X, OK_MORNING],
    running: { R: { runId: "R", startedAt: isoAt(Date.now() - 25 * 60000), retryOf: "X" } } } });
  const filed = r.health.recent.find((x) => x.runId === "R");
  const p = r.audit[0] && r.audit[0].payload;
  check("a retry Convex stopped is filed as abandoned when the next run starts, and audited like a retry that refused",
    !!filed && filed.code === "abandoned" && filed.trigger === "retry" && r.summary.ok === true &&
    r.audit.length === 1 && p.action === "attendance_rebuild_refused" && p.studentName === "All students" &&
    /did not complete \(abandoned\)\. Attendance screens were left showing the data from Oct 2, 6:32 AM\./.test(p.reason),
    JSON.stringify({ filed, audit: r.audit.map((a) => a.payload.reason) }));

  const card = async (last) => {
    const out = {};
    const fn = new Function("document", "health",
      grabFn(scriptSrc, "escapeHtml") + "\nlet _attRebuildHealth = { health, limits: {} };\n" +
      "async function fetchAttendanceRebuildHealth() {}\nfunction attendanceRebuildVerdict() { return { headline: 'h' }; }\n" +
      "async " + grabFn(scriptSrc, "showAttendanceRebuildHealth") + "\nreturn showAttendanceRebuildHealth;")(
      { getElementById: () => out }, { last, lastOk: OK_MORNING });
    await fn();
    return String(out.innerHTML || "");
  };
  const past = await card(X);
  check("the card's 'Last run' line no longer says 'Runs again by itself' once that time has passed",
    /Last run/.test(past) && /The piece kept changing/.test(past) && !/Runs again by itself/.test(past), past.slice(0, 300));
  const soon = await card(Object.assign({}, X, { retryAt: isoAt(Date.now() + 10 * 60000) }));
  check("CONTROL: ...and still says it while that time is to come", /Runs again by itself at /.test(soon), soon.slice(0, 300));
}

console.log("\nTHE AUDIT ENTRY SAYS WHEN IN THE SCHOOL'S TIME\n");
{
  const r = await run({ args: { retryOf: "orig" }, fake: { failCountWith500: Infinity },
    state: { lastOk: OK_MORNING, last: OK_MORNING, recent: [OK_MORNING] } });
  const p = r.audit[0] && r.audit[0].payload;
  check("no raw UTC timestamp in the reason the dashboard feed shows, nor in the screens sentence of the details",
    !!p && /were left showing the data from Oct 2, 6:32 AM\./.test(p.reason) && !ISO_STAMP.test(p.reason) &&
    /were left showing the data from Oct 2, 6:32 AM\./.test(p.details), p && p.reason);
}

// ======================================================================
// THE FOURTH REVIEW OF 2026-10-03. Each check below fails on the code as it
// stood before its fix; each TEETH check breaks one guard and shows the case
// above it is what catches that.
// ======================================================================
console.log("\nTHE COMPARISON: A DELETE WHILE THE OLD SINGLE READ PAGES\n");
const SINGLE_Q = (q) => q === "schoolid==1;yearid==36";
{
  const cmp = { dryRun: true, compare: true };
  const save = await run({ args: cmp, fake: { swapDuringRead: { row: TYPING, afterPage: 1, match: SINGLE_Q } } });
  const a = save.summary.compare;
  check("a teacher's save (a delete and an insert) while the OLD single read pages: 'PowerSchool changed during or between the reads', not 'different'",
    save.ps.swaps === 1 && a.onlyInWindows === 1 && a.onlyInSingle === 1 && a.newerInSingle === 1 && a.differing === 0 &&
    a.yearCountAfterSingle === a.singleDistinct && !!a.recheck && a.recheck.rows === 2 && a.recheck.matchSingle === 1 &&
    a.recheck.matchPieces === 1 && /^PowerSchool changed during or between the reads; run the comparison again/.test(a.verdict) &&
    !/leave the month pieces off/.test(a.verdict), JSON.stringify(a).slice(0, 500));
  const del = await run({ args: cmp, fake: { swapDuringRead: { afterPage: 1, match: SINGLE_Q } } });
  const b = del.summary.compare;
  const skipped = b.examples.find((x) => x.kind === "only in the month pieces");
  check("a delete alone while it pages: the row it skipped is still in PowerSchool, the count after it equals what it holds -- 'during or between', not 'different', not 'OLD single read'",
    del.ps.deleted.length === 1 && b.onlyInWindows === 1 && b.onlyInSingle === 0 && b.yearCountAfterSingle === b.singleDistinct &&
    !!skipped && skipped.id !== String(del.ps.deleted[0].id) && b.recheck.matchSingle === 0 && b.recheck.matchPieces === 1 &&
    /^PowerSchool changed during or between the reads/.test(b.verdict) && !/OLD single read|leave the month pieces off/.test(b.verdict),
    JSON.stringify(b).slice(0, 500));
  const SWAP = { swapFieldInWindows: { id: SPECIAL[3].id, field: "attendance_codeid", value: C.X } };
  const anyCopy = await run({ args: cmp, fake: SWAP, transform: (s) => breakOnce(s,
    "else if (onlyPieces.has(k) && sameRowNow(", "else if (sameRowNow(", "any-row-as-pieces") });
  check("TEETH: let a row BOTH reads hold be explained by the pieces' copy, and a piece that reads a row wrongly passes for a change",
    /^PowerSchool changed during or between/.test(anyCopy.summary.compare.verdict), anyCopy.summary.compare.verdict);
}

console.log("\nTHE COMPARISON: EACH GUARD ON 'POWERSCHOOL CHANGED' HAS TEETH\n");
{
  const cmp = { dryRun: true, compare: true };
  // (1) The gap the proof names: a delete and an insert in a CLOSED month during its one read.
  const SEPT = (q) => q === "schoolid==1;yearid==36;att_date=ge=2026-09-01;att_date=le=2026-09-29";
  const closed = { swapDuringRead: { row: Object.assign({}, TYPING, { att_date: "2026-09-15T00:00:00" }), afterPage: 1, match: SEPT } };
  const cs = await run({ args: cmp, fake: closed });
  const k = cs.summary.compare;
  check("a delete and an insert in the CLOSED September piece during its one read: the pieces miss a row, and it stays 'different', with no re-read",
    cs.summary.ok === true && cs.ps.swaps === 1 && k.onlyInSingle === 1 && k.newerInSingle === 0 && k.onlyInWindows === 1 &&
    !k.recheck && /^different: leave the month pieces off/.test(k.verdict), JSON.stringify(k).slice(0, 400));
  const m1 = await run({ args: cmp, fake: closed, transform: (s) => breakOnce(s,
    " && c.newerInSingle === c.onlyInSingle) {", ") {", "no-newer-gate") });
  check("TEETH: without 'every row only the single read holds is newer than the pieces', that pieces fault reads as 'PowerSchool changed'",
    /^PowerSchool changed/.test(m1.summary.compare.verdict), m1.summary.compare.verdict);

  // (2) and (5): a row deleted between the reads, and another just after the single read's last page.
  const lastPage = Math.ceil((THIS_YEAR.length - 1) / 100);
  const twoDeletes = { deleteBeforeSingleRead: SPECIAL[5].id, swapDuringRead: { afterPage: lastPage, match: SINGLE_Q } };
  const td = await run({ args: cmp, fake: twoDeletes });
  const g = td.summary.compare;
  check("a row deleted between the reads and another just after the single read: 'different' -- not 'the OLD single read came back short', which it was not",
    td.ps.deleted.length === 2 && g.onlyInWindows === 1 && g.onlyInSingle === 0 && g.yearCountAfterSingle === g.singleDistinct - 1 &&
    !g.recheck && /^different: leave the month pieces off/.test(g.verdict), JSON.stringify(g).slice(0, 400));
  const m5 = await run({ args: cmp, fake: twoDeletes, transform: (s) => breakOnce(s,
    "c.yearCountAfterSingle > c.singleDistinct;", "c.yearCountAfterSingle !== c.singleDistinct;", "short-any-way") });
  check("TEETH: with 'short of the count after it' loosened to 'unequal to it', that reads as the OLD single read came back short",
    /^the OLD single read came back short/.test(m5.summary.compare.verdict), m5.summary.compare.verdict);
  const m2 = await run({ args: cmp, fake: twoDeletes, transform: (s) => breakOnce(s,
    "&& c.yearCountAfterSingle === c.singleDistinct && c.newerInSingle === c.onlyInSingle) {",
    "&& c.newerInSingle === c.onlyInSingle) {", "no-count-gate") });
  check("TEETH: without 'the single read matches the count after it', it reads as 'PowerSchool changed'",
    /^PowerSchool changed/.test(m2.summary.compare.verdict), m2.summary.compare.verdict);

  // (3) Two rows re-read: one as the single read has it, one as only the pieces read it.
  const mixed = { editBeforeSingleRead: { id: SPECIAL[4].id, field: "attendance_codeid", value: C.X },
    swapFieldInWindows: { id: SPECIAL[3].id, field: "attendance_codeid", value: C.X } };
  const mx = await run({ args: cmp, fake: mixed });
  const t = mx.summary.compare;
  check("two rows re-read, one as the single read has it and one as the pieces alone read it: 'different', matchSingle 1",
    t.differing === 2 && !!t.recheck && t.recheck.rows === 2 && t.recheck.matchSingle === 1 && t.recheck.matchPieces === 0 &&
    /^different: leave the month pieces off/.test(t.verdict), JSON.stringify(t.recheck) + " " + t.verdict);
  const m3 = await run({ args: cmp, fake: mixed, transform: (s) => breakOnce(s,
    "editedBetween = matched + skippedBySingle === involved.length;", "editedBetween = matched + skippedBySingle > 0;", "any-match") });
  check("TEETH: with 'every row explained' loosened to 'any row', that reads as 'PowerSchool changed'",
    /^PowerSchool changed/.test(m3.summary.compare.verdict), m3.summary.compare.verdict);

  // (4) More rows than RECHECK_MAX (20): not an edit between two reads.
  const ids21 = BULK.slice(0, 21).map((r) => r.id);
  const many = await run({ args: cmp, fake: { deleteBeforeSingleRead: ids21 } });
  const m = many.summary.compare;
  check("21 rows deleted between the reads, past the 20 the re-read takes: 'different', and not one row re-read",
    many.ps.deleted.length === 21 && m.onlyInWindows === 21 && m.yearCountAfterSingle === m.singleDistinct && !m.recheck &&
    !many.ps.log.some((x) => /;id==/.test(x.q || "")) && /^different: leave the month pieces off/.test(m.verdict),
    JSON.stringify(m).slice(0, 300));
  const twenty = await run({ args: cmp, fake: { deleteBeforeSingleRead: ids21.slice(0, 20) } });
  check("CONTROL: 20 are re-read, and are a change between the reads",
    twenty.summary.compare.recheck && twenty.summary.compare.recheck.rows === 20 &&
    /^PowerSchool changed between the two reads: row\(s\) 20 deleted/.test(twenty.summary.compare.verdict), twenty.summary.compare.verdict);
  const m4 = await run({ args: cmp, fake: { deleteBeforeSingleRead: ids21 }, transform: (s) => breakOnce(s,
    "involved.length > 0 && involved.length <= RECHECK_MAX && ", "involved.length > 0 && ", "no-cap") });
  check("TEETH: without the cap, the 21 are re-read and read as 'PowerSchool changed'",
    /^PowerSchool changed/.test(m4.summary.compare.verdict), m4.summary.compare.verdict);
}

console.log("\nTHE CARD SAYS HOW THE LAST DRY RUN ENDED\n");
{
  const cardWith = async (health) => {
    const out = {};
    const fn = new Function("document", "health",
      grabFn(scriptSrc, "escapeHtml") + "\nlet _attRebuildHealth = { health, limits: {} };\n" +
      "async function fetchAttendanceRebuildHealth() {}\nfunction attendanceRebuildVerdict() { return { headline: 'h' }; }\n" +
      "async " + grabFn(scriptSrc, "showAttendanceRebuildHealth") + "\nreturn showAttendanceRebuildHealth;")(
      { getElementById: () => out }, health);
    await fn();
    return String(out.innerHTML || "");
  };
  const OLD_COMPARE = { runId: "c0", finishedAt: "2026-10-01T03:00:00.000Z", possible: true, identical: true, singleRows: 21000 };
  const always = { insertDuringRead: { row: TYPING, afterPage: 1, match: isLiveQ, times: "always" } };
  const refused = await run({ args: { dryRun: true, compare: true }, fake: always, state: { lastCompare: OLD_COMPARE } });
  const d = refused.health.lastDryRun;
  const html = await cardWith(Object.assign({}, refused.health, { lastOk: OK_MORNING, last: OK_MORNING }));
  check("a dry run refused through the real rebuild: its own line, 'refused <code>: <reason>', beside the older comparison it did not replace",
    !!d && d.ok === false && d.code === "changing" && refused.health.lastCompare.runId === "c0" &&
    /Last dry run [^<]*: refused changing: The piece 2026-09-30 onward did not hold still/.test(html) && /Last comparison/.test(html),
    html.slice(0, 600));
  const tricky = await cardWith({ lastDryRun: { ok: false, code: "failed", finishedAt: "2026-10-03T03:10:00.000Z",
    reason: "The rebuild failed while reading: <img src=x>" } });
  check("...a failed one says 'failed', and its reason is escaped",
    /Last dry run [^<]*: failed: The rebuild failed while reading: &lt;img src=x&gt;<\/div>/.test(tricky) && !/<img/.test(tricky),
    tricky.slice(0, 300));
  const fine = await cardWith({ lastDryRun: { ok: true, finishedAt: "2026-10-03T03:10:00.000Z" } });
  check("...and an ok one says ok", /Last dry run [^<]*: ok<\/div>/.test(fine), fine.slice(0, 300));
}

console.log("\nA STOPPED RETRY'S AUDIT ENTRY SAYS WHAT HAPPENED, AND WHEN\n");
{
  const X = { runId: "X", ok: false, code: "changing", stage: "read", reason: "The piece kept changing",
    startedAt: isoAt(Date.now() - 40 * 60000), finishedAt: isoAt(Date.now() - 39 * 60000), retryAt: isoAt(Date.now() - 25 * 60000) };
  const retryStart = isoAt(Date.now() - 25 * 60000);
  const r = await run({ state: { lastOk: OK_MORNING, last: X, recent: [X, OK_MORNING],
    running: { R: { runId: "R", startedAt: retryStart, retryOf: "X" } } } });
  const p = r.audit[0] && r.audit[0].payload;
  check("found by the next run's start, it is worded in the past tense at the retry's own time in Los Angeles",
    !!p && p.reason === `The attendance rebuild and its retry of ${laClock(retryStart)} did not complete (abandoned). ` +
      "Attendance screens were left showing the data from Oct 2, 6:32 AM." &&
    p.details.includes(`its retry of ${laClock(retryStart)}`), p && p.reason);
  check("...nothing in it is said of now: no 'are not being refreshed', no 'still show'",
    !!p && !/are not being refreshed|still show|is writing/.test(p.reason + " " + p.details), p && p.details);
  check("...and it is still the admin-only kind of entry", !!p && p.action === "attendance_rebuild_refused" && r.summary.ok === true);
}

console.log("\nNO RAW UTC TIME IN ANY REASON A REFUSAL CAN GIVE\n");
{
  const said = [];
  const keep = (label, ...texts) => texts.forEach((t) => said.push([label, String(t ?? "")]));
  const now = Date.now();
  const other = { runId: "other", startedAt: isoAt(now - 2 * 60000) };
  const lk = await run({ state: { writing: Object.assign({ claimedAt: isoAt(now - 60000) }, other), running: { other } } });
  keep("lock-held", lk.summary.reason, lk.health.recent[0].reason);
  check("another run holding the lock: refused, naming when it started in the school's time",
    lk.summary.code === "lock-held" && lk.summary.reason.includes(`started ${laClock(other.startedAt)})`), lk.summary.reason);
  const lastOk = Object.assign({}, OK_MORNING, { yearid: "36", attendanceRows: THIS_YEAR.length * 3 });
  const sh = await run({ state: { lastOk, last: lastOk, recent: [lastOk] } });
  const shNow = new Date().toISOString();
  keep("shrink", sh.summary.reason, sh.health.last.reason, loadRoster().rebuildHealthVerdict(sh.health, shNow, {}, shNow).headline);
  check("the shrink guard: refused, naming the last good run in the school's time, and the retry likewise",
    sh.summary.code === "shrink" && sh.summary.reason.includes("the last good rebuild read (Oct 2, 6:32 AM)") &&
    sh.summary.reason.includes(`It runs again by itself at ${laClock(sh.health.last.retryAt)}`), sh.summary.reason);
  const always = { insertDuringRead: { row: TYPING, afterPage: 1, match: isLiveQ, times: "always" } };
  const shared = makeDb();
  const first = await run({ shared, fake: always });
  keep("changing", first.summary.reason, first.health.last.reason);
  const retry = await run({ shared, args: { retryOf: first.scheduled[0].args.retryOf }, fake: always });
  keep("retry refused", retry.summary.reason, retry.health.last.reason, retry.audit[0].payload.reason, retry.audit[0].payload.details);
  const failed = await run({ fake: { failCountWith500: Infinity } });
  keep("failed", failed.health.last.reason, failed.threw && failed.threw.message);   // a failure is rethrown: Convex logs the stack
  const dry = await run({ args: { dryRun: true }, fake: always });
  keep("dry run", dry.summary.reason, dry.health.lastDryRun.reason);
  const X = { runId: "X", ok: false, code: "changing", stage: "read", reason: "r", startedAt: isoAt(now - 40 * 60000),
    finishedAt: isoAt(now - 39 * 60000), retryAt: isoAt(now - 25 * 60000) };
  const stopped = await run({ state: { lastOk: OK_MORNING, last: X, recent: [X, OK_MORNING],
    running: { R: { runId: "R", startedAt: isoAt(now - 25 * 60000), retryOf: "X" } } } });
  keep("stopped retry", stopped.audit[0].payload.reason, stopped.audit[0].payload.details);
  const bad = said.filter(([, t]) => !t || ISO_STAMP.test(t));
  check(`no reason, record, audit entry or card headline -- ${said.length} sentences from seven refusals -- carries a raw UTC timestamp`,
    said.length === 17 && bad.length === 0, JSON.stringify(bad).slice(0, 400));
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const rawTime = /\$\{(?!laTime\()[^{}]*\b\w*At\b[^{}]*\}/g;
  const found = [daysSrc, statsSrc.slice(statsSrc.indexOf("const REBUILD_KEY"))].flatMap((src) => strip(src).match(rawTime) || []);
  check("...and no sentence in the rebuild's source puts a stored time in without laTime()", found.length === 0, found.join(" | "));
}

// ======================================================================
// THE FIFTH REVIEW OF 2026-10-03. Each check below fails on the code as it
// stood before its fix; each TEETH check breaks one guard and shows the case
// above it is what catches that.
// ======================================================================
console.log("\nTHE COMPARISON: A ROW THE OLD READ SKIPPED EXPLAINS ONLY ITSELF\n");
{
  const cmp = { dryRun: true, compare: true };
  const SWAP = { swapFieldInWindows: { id: SPECIAL[3].id, field: "attendance_codeid", value: C.X } };
  const SKIP = { swapDuringRead: { afterPage: 1, match: SINGLE_Q } };
  // A real piece fault (a row the pieces read wrongly) AND a delete while the
  // old read pages: the row it skipped is explained, the wrong row is not.
  const both = Object.assign({}, SWAP, SKIP);
  const r = await run({ args: cmp, fake: both });
  const a = r.summary.compare;
  check("a piece that reads a row wrongly AND a delete while the old single read pages: 'different', re-read {rows 2, matchSingle 0, matchPieces 1}",
    r.summary.ok === true && r.ps.deleted.length === 1 && a.differing === 1 && a.onlyInWindows === 1 && a.onlyInSingle === 0 &&
    a.yearCountAfterSingle === a.singleDistinct && same(a.recheck, { rows: 2, matchSingle: 0, matchPieces: 1 }) &&
    /^different: leave the month pieces off/.test(a.verdict), JSON.stringify(a).slice(0, 500));
  const anySkip = await run({ args: cmp, fake: both, transform: (s) => breakOnce(s,
    "editedBetween = matched + skippedBySingle === involved.length;",
    "editedBetween = matched === involved.length || skippedBySingle > 0;", "skip-excuses-all") });
  check("TEETH: let one skipped row excuse every other row (matched === involved.length || skippedBySingle > 0), and that piece fault passes for a change",
    /^PowerSchool changed during or between/.test(anySkip.summary.compare.verdict), anySkip.summary.compare.verdict);
  const forced = await run({ args: cmp, fake: both, transform: (s) => breakOnce(s,
    "editedBetween = matched + skippedBySingle === involved.length;",
    "editedBetween = matched + skippedBySingle === involved.length;\n                  if (skippedBySingle > 0) editedBetween = true;",
    "skip-forces") });
  check("TEETH: ...and so it does with 'if (skippedBySingle > 0) editedBetween = true;' appended",
    /^PowerSchool changed during or between/.test(forced.summary.compare.verdict), forced.summary.compare.verdict);

  // The row the old read skipped, edited after it: PowerSchool still holds
  // it, but no longer as the pieces read it, so nothing vouches for them.
  const plain = await run({ args: cmp, fake: SKIP });
  const skippedId = (plain.summary.compare.examples.find((x) => x.kind === "only in the month pieces") || {}).id;
  const before = THIS_YEAR.find((x) => String(x.id) === String(skippedId));
  const EDIT = Object.assign({}, SKIP, { editBeforeRecheck: { id: skippedId, field: "attendance_codeid", value: C.A } });
  const ed = await run({ args: cmp, fake: EDIT });
  const e = ed.summary.compare;
  const after = ed.ps.tables.attendance.find((x) => String(x.id) === String(skippedId));
  check("the row the old read skipped, edited after it (PowerSchool's copy now differs from the pieces'): 'different', matchPieces 0",
    !!before && before.attendance_codeid !== C.A && !!after && after.attendance_codeid === C.A &&
    e.onlyInWindows === 1 && e.onlyInSingle === 0 && e.differing === 0 && e.yearCountAfterSingle === e.singleDistinct &&
    same(e.recheck, { rows: 1, matchSingle: 0, matchPieces: 0 }) && /^different: leave the month pieces off/.test(e.verdict),
    JSON.stringify(e).slice(0, 500));
  const stillHeld = await run({ args: cmp, fake: EDIT, transform: (s) => breakOnce(s,
    "else if (onlyPieces.has(k) && sameRowNow(now[i], byPieces.get(k) ?? null)) skippedBySingle++;",
    "else if (onlyPieces.has(k) && now[i]) skippedBySingle++;", "any-still-held") });
  check("TEETH: count any row only the pieces hold that PowerSchool still has, whatever its copy, and that reads as 'PowerSchool changed'",
    /^PowerSchool changed during or between/.test(stillHeld.summary.compare.verdict), stillHeld.summary.compare.verdict);
}

console.log("\nTHE COMPARISON: A DATED ROW THE PIECES TOOK FOR ONE WITH NO DATE\n");
{
  const cmp = { dryRun: true, compare: true };
  const newest = THIS_YEAR.reduce((m, x) => (x.id > m.id ? x : m), THIS_YEAR[0]);
  const hid = await run({ args: cmp, fake: { hideFromDated: newest.id } });
  const c = hid.summary.compare;
  check("PowerSchool leaves this year's newest DATED row out of every dated read and count: the pieces call it undated, and it is 'different', not 'entered after the pieces'",
    hid.summary.ok === true && hid.summary.undatedRows === 1 && c.singleUndated === 0 && c.onlyInSingle === 1 &&
    c.newerInSingle === 1 && c.onlyInWindows === 0 && c.differing === 0 && c.yearCountAfterSingle === c.singleDistinct &&
    c.windowRows + 1 === c.yearCount && !c.recheck && /^different: leave the month pieces off/.test(c.verdict),
    JSON.stringify(c).slice(0, 500));
  const NEW = { yearid: 36, schoolid: 1, studentid: "st111", att_date: "2026-10-02T00:00:00", periodid: 7,
                attendance_codeid: C.A, ccid: 507 };
  const ins = await run({ args: cmp, fake: { insertBeforeSingleRead: NEW } });
  check("CONTROL: a plain insert between the reads still says 'PowerSchool changed between the two reads'",
    ins.summary.undatedRows === 0 && ins.summary.compare.singleUndated === 0 &&
    /^PowerSchool changed between the two reads: 1 row\(s\) entered/.test(ins.summary.compare.verdict), ins.summary.compare.verdict);
  const noGate = await run({ args: cmp, fake: { hideFromDated: newest.id }, transform: (s) => breakOnce(s,
    "&& c.singleUndated === undated && piecesProved && c.yearCountAfterSingle === c.singleDistinct;",
    "&& piecesProved && c.yearCountAfterSingle === c.singleDistinct;", "no-undated-gate") });
  check("TEETH: without 'the single read's undated rows are the pieces' undatedRows' in changedBetween, that lost row reads as 'entered after the pieces'",
    /^PowerSchool changed between the two reads/.test(noGate.summary.compare.verdict), noGate.summary.compare.verdict);

  // An OLD dated row the pieces took for undated, and an entry with no date
  // between the reads that makes the two undated tallies agree: only 'newer
  // than every row the pieces hold' still tells it from an entry.
  const OLD = { hideFromDated: SPECIAL[3].id, nullDateRow: true, insertBeforeSingleRead: Object.assign({}, NEW, { att_date: "" }) };
  const o = await run({ args: cmp, fake: OLD });
  const k = o.summary.compare;
  check("an OLD dated row the pieces took for undated, the undated tallies balanced by an undated entry between the reads: 'different'",
    o.summary.ok === true && o.summary.undatedRows === 2 && k.singleUndated === 2 && k.onlyInSingle === 1 && k.newerInSingle === 0 &&
    k.onlyInWindows === 0 && k.differing === 0 && k.yearCountAfterSingle === k.singleDistinct && k.windowRows + 2 === k.yearCount &&
    !k.recheck && /^different: leave the month pieces off/.test(k.verdict), JSON.stringify(k).slice(0, 500));
  const m17 = await run({ args: cmp, fake: OLD, transform: (s) => breakOnce(s,
    "const changedBetween = !c.identical && c.onlyInSingle > 0 && c.newerInSingle === c.onlyInSingle",
    "const changedBetween = !c.identical && c.onlyInSingle > 0", "no-newer-between") });
  check("TEETH: without 'every row only the single read holds is newer than the pieces' in changedBetween, it reads as 'entered after the pieces'",
    /^PowerSchool changed between the two reads/.test(m17.summary.compare.verdict), m17.summary.compare.verdict);
}

console.log("\nTHE SETTINGS CARD SAYS EVERY TIME IN THE SCHOOL'S TIME, WHEREVER THE BROWSER IS\n");
{
  const cardFrom = async (src, health) => {
    const out = {};
    const fn = new Function("document", "health",
      grabFn(src, "escapeHtml") + "\nlet _attRebuildHealth = { health, limits: {} };\n" +
      "async function fetchAttendanceRebuildHealth() {}\nfunction attendanceRebuildVerdict() { return { headline: 'h' }; }\n" +
      "async " + grabFn(src, "showAttendanceRebuildHealth") + "\nreturn showAttendanceRebuildHealth;")(
      { getElementById: () => out }, health);
    await fn();
    return String(out.innerHTML || "");
  };
  const under = async (tz, src) => {
    const was = process.env.TZ;
    process.env.TZ = tz;
    try { return await cardFrom(src, CARD); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
  };
  // Evening runs fall on the NEXT day in UTC and in New York.
  const T = { ok: "2026-10-02T13:32:00.000Z", run: "2026-10-03T03:41:00.000Z", retry: isoAt(Date.now() + 10 * 60000),
    dry: "2026-10-03T04:10:00.000Z", cmp: "2026-10-03T04:11:00.000Z", r1: "2026-10-03T03:40:00.000Z", r2: "2026-10-02T13:30:00.000Z" };
  const CARD = {
    lastOk: Object.assign({}, OK_MORNING, { finishedAt: T.ok }),
    last: { runId: "X", ok: false, code: "changing", reason: "r", startedAt: T.r1, finishedAt: T.run, retryAt: T.retry },
    lastDryRun: { ok: true, finishedAt: T.dry },
    lastCompare: { possible: true, identical: true, singleRows: 21000, finishedAt: T.cmp },
    recent: [{ runId: "X", ok: false, code: "changing", reason: "r", startedAt: T.r1 },
             Object.assign({}, OK_MORNING, { startedAt: T.r2 })],
  };
  const WANT = [`Last good rebuild ${laClock(T.ok)}:`, `Last run ${laClock(T.run)}:`, `Runs again by itself at ${laClock(T.retry)}.`,
    `Last dry run ${laClock(T.dry)}: ok`, `Last comparison with the old single read, ${laClock(T.cmp)}:`,
    `<td>${laClock(T.r1)}</td>`, `<td>${laClock(T.r2)}</td>`];
  const CLOCK = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{1,2}:\d{2}\s[AP]M\b/g;
  const allLa = (html) => WANT.every((w) => html.includes(w)) && (html.match(CLOCK) || []).length === WANT.length &&
    !/\d{1,2}\/\d{1,2}\/\d{4}/.test(html) && !ISO_STAMP.test(html);
  const utc = await under("UTC", scriptSrc);
  const ny = await under("America/New_York", scriptSrc);
  check("rendered in a browser set to UTC, every one of the card's seven times is the Los Angeles time, worded like the headline",
    allLa(utc), WANT.filter((w) => !utc.includes(w)).join(" | ") || utc.slice(0, 400));
  check("...and in one set to New York, the very same card", allLa(ny) && ny === utc,
    WANT.filter((w) => !ny.includes(w)).join(" | ") || ny.slice(0, 400));
  const LA_WHEN = "return isFinite(t) ? new Date(t).toLocaleString('en-US', {\n" +
    "                    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'\n" +
    "                }) : 'an unknown time';";
  const browserZone = breakOnce(scriptSrc, LA_WHEN, "return isFinite(t) ? new Date(t).toLocaleString() : 'an unknown time';", "browser-zone");
  check("TEETH: with the browser's own zone (new Date(t).toLocaleString()), the UTC card is wrong", !allLa(await under("UTC", browserZone)));
  const noZone = breakOnce(scriptSrc, LA_WHEN, "return isFinite(t) ? new Date(t).toLocaleString('en-US', {\n" +
    "                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'\n" +
    "                }) : 'an unknown time';", "no-zone");
  check("TEETH: ...and so it is with the headline's wording but no timeZone", !allLa(await under("UTC", noZone)) &&
    !allLa(await under("America/New_York", noZone)));
}

console.log("\nTHE WORKTREE'S node_modules SYMLINK IS IGNORED\n");
{
  const lines = read("./.gitignore").split("\n").map((l) => l.trim());
  check(".gitignore says 'node_modules' (a folder or a symlink), not 'node_modules/' (a folder only)",
    lines.includes("node_modules") && !lines.includes("node_modules/"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
