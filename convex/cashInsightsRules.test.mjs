// The behaviour-change check's attendance lines, and the one server read that
// carries them. Run: npm test
//
// THE OWNER, 2026-10-06: recommendation #4 -- "an outcome adults don't control"
// (unexcused tardies, part-day absences) beside the cash figures, by campus,
// with no names -- for the people the attendance screens already serve
// (admins, PBIS, Attendance Watch; review, 2026-10-06), the calendar for all.
//
// TWO HALVES. outcomeWeeks (cashInsightsRules.ts) is pure, so it is imported
// and run. cashInsights:trendsContext is then TRANSPILED AND INVOKED against an
// in-memory database holding names, student numbers and a psEmail patch, with
// only Convex's wrappers stubbed -- a text match would pass for a name added
// to the payload by a later edit. Every load-bearing rule is then re-broken in
// a copy of the source to prove a check notices.

import { readFileSync } from "node:fs";
import ts from "typescript";
import * as rules from "./cashInsightsRules.ts";
import * as headroomRules from "./readHeadroomRules.ts";

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const RULES_SRC = read("./cashInsightsRules.ts");

/** Replace exactly one anchor, or fail loudly: a teeth test whose anchor moved proves nothing. */
function breakOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`teeth "${label}": anchor not found exactly once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}
/** A broken copy of the rules module, transpiled and loaded. */
async function rulesFrom(src) {
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

// ---------------------------------------------------------------- fixtures
// A school year that starts on Wed 2026-09-02. Week of 9/7 has a holiday
// (Mon 9/7); 9/14-9/18 is a full week; 9/21-9/25 a full week; 9/28-10/2 too.
const DAYS = ["2026-09-02", "2026-09-03", "2026-09-04",
              "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11",
              "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18",
              "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25",
              "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];
// Built by the nightly run at 03:15 Los Angeles on Saturday 10/3: through Friday.
const BUILT = "2026-10-03T10:15:00.000Z";
function runRows(days = DAYS, syncedAt = BUILT) {
  const out = [];
  for (const date of days) {
    out.push({ date, band: "6-8", members: 100, absentDays: 10, fullDaysStrict: 3, misrecordDaysByGap: [1, 1, 0], partialDays: 5,
               assumedPresentDays: 0, syncedAt });
    out.push({ date, band: "9-12", members: 50, absentDays: 6, fullDaysStrict: 2, misrecordDaysByGap: [0, 1, 0], partialDays: 3,
               assumedPresentDays: 0, syncedAt });
    // A band no line reads is ignored, never summed into a campus.
    out.push({ date, band: "other", members: 3, absentDays: 3, fullDaysStrict: 3, misrecordDaysByGap: [0, 0, 0], partialDays: 0,
               assumedPresentDays: 0, syncedAt });
  }
  return out;
}
// Marks rebuilt on Saturday 10/3 at 06:30 Los Angeles: complete through Friday.
const MARKS_SYNC = "2026-10-03T13:30:00.000Z";
function marks(sync = MARKS_SYNC) {
  return [
    // Grade 7, enrolled all year, late without an excuse on two school days,
    // on a holiday (9/7), and on a date in the future (10/9).
    { gradeLevel: "7", entryDate: "2026-09-02", absentDates: [], tardyDates: ["2026-09-15", "2026-09-16", "2026-09-07", "2026-10-09"],
      unexcusedTardyDates: ["2026-09-15", "2026-09-16", "2026-09-07", "2026-10-09"], syncedAt: sync },
    // Grade 8, joined Wednesday 9/16: two days of the week of 9/14 are not theirs.
    { gradeLevel: "8", entryDate: "2026-09-16", absentDates: [], tardyDates: ["2026-09-17"], unexcusedTardyDates: ["2026-09-17"], syncedAt: sync },
    // Grade 10, a re-entry: entry 9/23 but late on 9/15, so counted from 9/15 (windowAbsenceList's rule).
    { gradeLevel: "10", entryDate: "2026-09-23", absentDates: [], tardyDates: ["2026-09-15"], unexcusedTardyDates: ["2026-09-15"], syncedAt: sync },
    // Grade 11, rebuilt before the unexcused field existed: NOT "never late".
    { gradeLevel: "11", entryDate: "2026-09-02", absentDates: [], tardyDates: ["2026-09-15"], unexcusedTardyDates: null, syncedAt: sync },
    // Grade 5 and no grade: in neither campus.
    { gradeLevel: "5", entryDate: "2026-09-02", absentDates: [], tardyDates: [], unexcusedTardyDates: [], syncedAt: sync },
    { gradeLevel: "", entryDate: "2026-09-02", absentDates: [], tardyDates: [], unexcusedTardyDates: [], syncedAt: sync },
  ];
}
const wk = (out, monday) => out.weeks.find((w) => w.monday === monday);

// ==================================================================== 1
console.log("\n1. Finished weeks only, and only once the run table has been built past them");
{
  const sat = rules.outcomeWeeks({ runDays: runRows(), marks: marks(), today: "2026-10-03" });
  check("on a Saturday the week just ended is in", wk(sat, "2026-09-28") && wk(sat, "2026-09-28").status === "in");
  const wed = rules.outcomeWeeks({ runDays: runRows(), marks: marks(), today: "2026-09-30" });
  check("on a Wednesday the current week is absent (its Friday is not before today)", !wk(wed, "2026-09-28") && !!wk(wed, "2026-09-21"),
    wed.weeks.map((w) => w.monday).join());
  check("weeks run from the year's first school day, a three-day week included", sat.weeks[0].monday === "2026-08-31" &&
    sat.weeks[0].dates.length === 3 && wk(sat, "2026-09-07").dates.length === 4);
  // The nightly run failed on Saturday morning: built Friday 10/2 at 03:15, through Thursday.
  const stale = runRows(DAYS.filter((d) => d <= "2026-10-01"), "2026-10-02T10:15:00.000Z");
  const pend = rules.outcomeWeeks({ runDays: stale, marks: marks(), today: "2026-10-03" });
  check("a week the run table has not been built past is 'pending', not a short week", wk(pend, "2026-09-28").status === "pending" &&
    wk(pend, "2026-09-21").status === "in", JSON.stringify(pend.weeks.map((w) => [w.monday, w.status])));
  // A whole week with no rows and a run table built after it: a holiday week, skipped.
  const holiday = rules.outcomeWeeks({ runDays: runRows(DAYS.filter((d) => d < "2026-09-21" || d > "2026-09-25")), marks: marks(), today: "2026-10-03" });
  check("a whole week with no school day, run table built past it: a holiday week, not shown", !wk(holiday, "2026-09-21"));
  // ...but with the run table stuck before it, the same empty week is pending.
  const stuck = rules.outcomeWeeks({ runDays: runRows(DAYS.filter((d) => d < "2026-09-21"), "2026-09-19T10:15:00.000Z"), marks: marks(), today: "2026-10-03" });
  check("...and with the run table stuck before it, the same empty weeks are pending, never missing",
    wk(stuck, "2026-09-21") && wk(stuck, "2026-09-21").status === "pending" && wk(stuck, "2026-09-28").status === "pending");
  check("output bands are only 6-8 and 9-12", sat.weeks.every((w) => JSON.stringify(Object.keys(w.bands)) === '["6-8","9-12"]'));
  const w = wk(sat, "2026-09-14");
  check("components are summed per campus, misrecord buckets element by element (the 'other' band ignored)",
    w.bands["6-8"].members === 500 && w.bands["6-8"].absentDays === 50 && w.bands["6-8"].fullDaysStrict === 15 &&
    JSON.stringify(w.bands["6-8"].misrecordDaysByGap) === "[5,5,0]" && w.bands["9-12"].members === 250 &&
    JSON.stringify(w.bands["9-12"].misrecordDaysByGap) === "[0,5,0]", JSON.stringify(w.bands));
  check("schoolDates are the completed school days, and `through` the last", sat.schoolDates.length === DAYS.length && sat.through === "2026-10-02");
}

// ==================================================================== 2
console.log("\n2. Unexcused tardies: school days only, one entry rule, no zero for missing data");
{
  const out = rules.outcomeWeeks({ runDays: runRows(), marks: marks(), today: "2026-10-03" });
  const w = wk(out, "2026-09-14");
  // MS: the grade 7 child, 5 days, late 9/15 and 9/16; the grade 8 child, from
  // Wed 9/16 (3 days), late 9/17. HS: the re-entry, counted from 9/15 (4 days).
  check("MS: 3 late days in 8 student-days (the joiner is outside Mon and Tue)",
    w.bands["6-8"].unexcusedTardyDays === 3 && w.bands["6-8"].tardyMemberDays === 8, JSON.stringify(w.bands["6-8"]));
  check("HS: a re-entry counts from their first marked school day, in both halves (1 in 4)",
    w.bands["9-12"].unexcusedTardyDays === 1 && w.bands["9-12"].tardyMemberDays === 4, JSON.stringify(w.bands["9-12"]));
  const hol = wk(out, "2026-09-07");
  check("a tardy dated on a holiday (9/7, no school day) is not counted", hol.bands["6-8"].unexcusedTardyDays === 0 &&
    hol.bands["6-8"].tardyMemberDays === 4);
  const early = rules.outcomeWeeks({ runDays: runRows(), marks: marks(), today: "2026-10-06" });
  check("a tardy dated in the future (10/9, when today is 10/6) is not counted anywhere",
    early.weeks.reduce((a, x) => a + (x.bands["6-8"].unexcusedTardyDays || 0), 0) === 3 + 0);
  check("a row with no unexcused field is counted as missing, not as zero tardies (and not in the denominator)",
    out.marksMissingUnexcused === 1 && w.bands["9-12"].tardyMemberDays === 4);
  check("grades outside 6-12 go to marksOutsideBands", out.marksOutsideBands === 2 && out.marksRows === 6);
  check("entry before the year: the effective entry rule matches windowAbsenceList",
    rules.effectiveEntry({ entryDate: "2026-09-23", tardyDates: ["2026-09-15"] }, new Set(DAYS)) === "2026-09-15" &&
    rules.effectiveEntry({ entryDate: "2026-09-23", tardyDates: ["2026-09-07"] }, new Set(DAYS)) === "2026-09-23" &&
    rules.effectiveEntry({ entryDate: "bad" }, new Set(DAYS)) === "");
}

// ==================================================================== 3
console.log("\n3. The freshness fence: marks that stopped refreshing never read as an improvement");
{
  // The marks last rebuilt at 06:30 on Wed 9/30: complete through Tue 9/29.
  const out = rules.outcomeWeeks({ runDays: runRows(), marks: marks("2026-09-30T13:30:00.000Z"), today: "2026-10-03" });
  check("marksThrough is the day before the newest marks sync, in Los Angeles", out.marksThrough === "2026-09-29", out.marksThrough);
  const last = wk(out, "2026-09-28");
  check("the week reaching past it is tardyStale, with no rate (null, not 0)",
    last.tardyStale === true && last.bands["6-8"].unexcusedTardyDays === null && last.bands["6-8"].tardyMemberDays === null);
  check("...while the part-day line, a different table, still has the week", last.status === "in" && last.bands["6-8"].members === 500);
  check("a week wholly before it keeps its rate", wk(out, "2026-09-21").tardyStale === false && wk(out, "2026-09-21").bands["6-8"].tardyMemberDays === 10);
  // The midday rebuild (12:30 Los Angeles, 19:30 UTC) on Friday 10/2 has half of Friday.
  const midday = rules.outcomeWeeks({ runDays: runRows(), marks: marks("2026-10-02T19:30:00.000Z"), today: "2026-10-03" });
  check("the midday rebuild's own day is not complete: through Thursday", midday.marksThrough === "2026-10-01" &&
    wk(midday, "2026-09-28").tardyStale === true);
  check("Los Angeles, not UTC: a 17:30 sync on 10/2 is still 10/2's", rules.laDayOf("2026-10-03T00:30:00.000Z") === "2026-10-02");
  check("no marks at all: every week is stale, never zero", rules.outcomeWeeks({ runDays: runRows(), marks: [], today: "2026-10-03" })
    .weeks.every((x) => x.tardyStale && x.bands["6-8"].unexcusedTardyDays === null));
}

// ==================================================================== 4
console.log("\n4. The nightly headroom check measures the new read");
{
  const base = { nowIso: "2026-10-06T20:00:00.000Z", cutoffIso: "2026-09-14T15:30:00.000Z",
    students: { rows: 1, bytes: 1000, cashCopyBytes: 0, largestRowBytes: 1000, rosterLookupBytes: 0, rosterLookupHits: 0 },
    psRoster: { rows: 1, bytes: 100 }, teachers: { rows: 1, bytes: 100 }, loadSettingsBytes: 10, mirror: { rows: 0, bytes: 0, docs: [] } };
  const without = headroomRules.estimateReaders(base);
  const withIt = headroomRules.estimateReaders({ ...base, trendsContext: { rows: 1300, bytes: 3 * 1048576 } });
  const r = withIt.find((x) => x.name === "cashInsights:trendsContext");
  check("with its measurement, cashInsights:trendsContext is a reader (3 MiB = 18.8%, green)",
    r && r.estMiB === 3 && Math.abs(r.pct - 18.8) < 0.01 && r.band === "green", JSON.stringify(r));
  check("without one (an older record), there is simply no such reader", !without.some((x) => x.name === "cashInsights:trendsContext"));
  const H = read("./readHeadroom.ts");
  check("the nightly run reads it through its own measuring query and records it",
    /ctx\.runQuery\(internal\.readHeadroom\.trendsContextReads, \{\}\)/.test(H) && /trendsContext: \{ rows: trends\.rows, bytes: trends\.bytes \}/.test(H));
}

// ==================================================================== 5
console.log("\n5. cashInsights:trendsContext, run against an in-memory database");
const fnRef = new Proxy({}, { get: (_, mod) => new Proxy({}, { get: (__, fn) => `${String(mod)}.${String(fn)}` }) });
class ConvexError extends Error { constructor(m) { super(typeof m === "string" ? m : JSON.stringify(m)); this.data = m; } }
function makeDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed));
  let n = 0;
  for (const t of Object.keys(tables)) tables[t].forEach((r) => { r._id = r._id || `${t}:${n++}`; r._creationTime = r._creationTime ?? n++; });
  const log = [];
  const q = (name) => {
    let rows = (tables[name] || []).slice();
    let desc = false;
    const api = {
      withIndex(i, fn) {
        if (fn) { const eqs = {}; const ch = { eq: (c, v) => { eqs[c] = v; return ch; } }; fn(ch);
          rows = rows.filter((r) => Object.entries(eqs).every(([c, v]) => r[c] === v)); }
        if (i === "by_yearid_date") rows.sort((a, b) => (a.yearid - b.yearid) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        return api;
      },
      order(d) { desc = d === "desc"; return api; },
      async first() { log.push(name); return (desc ? rows.slice().reverse() : rows)[0] ?? null; },
      async take(k) { log.push(name); return (desc ? rows.slice().reverse() : rows).slice(0, k); },
      async collect() { log.push(name); return rows; },
      async unique() { log.push(name); return rows[0] ?? null; },
    };
    return api;
  };
  return { db: { query: q }, log };
}
function loadQuery(srcText, who) {
  const stubs = {
    "./_generated/server": { query: (d) => d, mutation: (d) => d, action: (d) => d, internalQuery: (d) => d,
                             internalMutation: (d) => d, internalAction: (d) => d, httpAction: (d) => d },
    "./_generated/api": { internal: fnRef, api: fnRef },
    "convex/values": { v: new Proxy({}, { get: () => () => ({}) }), ConvexError },
    "./identity": {
      requireStaff: async () => {
        if (who.kind !== "staff") throw new ConvexError("Staff only.");
        return who.staff;
      },
    },
  };
  const cache = {};
  const req = (name) => {
    const norm = name.replace(/\.(js|ts)$/, "");
    if (stubs[norm]) return stubs[norm];
    const key = norm.replace(/^\.\//, "");
    if (cache[key]) return cache[key];
    let code;
    try { code = key === "cashInsights" ? srcText : read("./" + key + ".ts"); } catch (e) { throw new Error("no module " + name); }
    const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} };
    cache[key] = module.exports;
    new Function("require", "module", "exports", "console", js)(req, module, module.exports, { warn() {}, log() {}, error() {} });
    cache[key] = module.exports;
    return module.exports;
  };
  return req("./cashInsights");
}
const SEED = () => ({
  attendanceRunDays: [
    ...runRows().map((r) => ({ ...r, yearid: 36, gradeEstimated: false })),
    // Last year's rows: never read as this year's.
    { yearid: 35, date: "2026-05-01", band: "6-8", members: 999, absentDays: 999, fullDaysStrict: 0, misrecordDaysByGap: [0, 0, 0],
      partialDays: 999, assumedPresentDays: 0, gradeEstimated: true, syncedAt: BUILT },
  ],
  psAttendanceMarks: marks().map((m, i) => ({ ...m, studentNumber: "SN" + (9000 + i), firstName: "Zebulon", lastName: "Quartermaine" })),
  teachers: [
    { _id: "teachers:lee", legacyId: "T001", name: "Ms. Lee", email: "lee@x", role: "teacher" },
    // Signs in as park2@x; PowerSchool files the sections under park@x.
    { _id: "teachers:park", name: "Mr. Park", email: "park2@x", psEmail: "park@x", role: "teacher",
      _creationTime: Date.parse("2026-10-05T17:00:00.000Z") },
    // A psEmail that is another staff member's sign-in: refused (rosterEmailFor).
    { _id: "teachers:sly", name: "Mx. Sly", email: "sly@x", psEmail: "lee@x", role: "teacher" },
    { _id: "teachers:pat", name: "Pat PBIS", email: "pat@x", role: "pbis" },
    { _id: "teachers:none", name: "No Class", email: "none@x", role: "teacher" },
  ],
  psRoster: [
    { studentNumber: "SN9000", firstName: "Zebulon", lastName: "Quartermaine", teacherEmail: "lee@x", syncedAt: "x" },
    { studentNumber: "SN9001", firstName: "Zebulon", lastName: "Quartermaine", teacherEmail: "park@x", syncedAt: "x" },
    { studentNumber: "SN9002", firstName: "Zebulon", lastName: "Quartermaine", teacherEmail: "pat@x", syncedAt: "x" },
  ],
  students: [{ firstName: "Zebulon", lastName: "Quartermaine", studentNumber: "SN9000" }],
  legacyMirror: [{ doc: "cash_tx_2026_W40", collection: "transactions", payload: { notes: "secret note" } }],
});
const STAFF = { kind: "staff", staff: { _id: "teachers:me", name: "Me", role: "teacher" } };
const PBIS = { kind: "staff", staff: { _id: "teachers:pat", name: "Pat PBIS", role: "pbis" } };
const WATCH = { kind: "staff", staff: { _id: "teachers:aide", name: "An Aide", role: "campusaide", attendanceWatch: true } };
const QSRC = read("./cashInsights.ts");
{
  const d = makeDb(SEED());
  const Q = loadQuery(QSRC, PBIS);
  const res = await Q.trendsContext.handler({ db: d.db }, { today: "2026-10-03" });
  const flat = JSON.stringify(res);
  check("the PBIS team gets the campus-level figures", res.allowed === true && res.attendance === true && res.weeks.length === 5 &&
    res.yearid === 36 && wk(res, "2026-09-14").bands["6-8"].unexcusedTardyDays === 3, flat.slice(0, 200));
  // THE ATTENDANCE SCREENS' RULE (review, 2026-10-06): the run chart refuses
  // these campus sums to anyone but admins, PBIS and Attendance Watch.
  const td = makeDb(SEED());
  const tres = await loadQuery(QSRC, STAFF).trendsContext.handler({ db: td.db }, { today: "2026-10-03" });
  check("a teacher gets the calendar and the class list, and no attendance: every week's bands null, the marks never read",
    tres.allowed === true && tres.attendance === false && tres.weeks.length === 5 && tres.weeks.every((w) => w.bands === null) &&
    tres.schoolDates.length === DAYS.length && tres.rosterStaff.count === 3 && !td.log.includes("psAttendanceMarks") &&
    !/unexcusedTardyDays|partialDays|absentDays/.test(JSON.stringify(tres)), JSON.stringify(tres.weeks[0]));
  const ares = await loadQuery(QSRC, WATCH).trendsContext.handler({ db: makeDb(SEED()).db }, { today: "2026-10-03" });
  check("...and a campus aide WITH Attendance Watch gets them, as the run chart gives them", ares.attendance === true &&
    wk(ares, "2026-09-14").bands["6-8"].members === 500);
  const park = res.rosterStaff.ids.findIndex((p) => p[0] === "teachers:park");
  check("each class-list id comes with the day its record was created (Los Angeles), for last week's denominator",
    res.rosterStaff.createdDays.length === res.rosterStaff.ids.length && res.rosterStaff.createdDays[park] === "2026-10-05" &&
    res.rosterStaff.createdDays.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)), JSON.stringify(res.rosterStaff.createdDays));
  // THE BROWSER'S DAY IS BOUNDED BY THE SERVER'S (review, 2026-10-06).
  const tomorrow = rules.addDays(rules.laDayOf(new Date().toISOString()), 1);
  const far = await Q.trendsContext.handler({ db: makeDb(SEED()).db }, { today: "9999-12-31" });
  const bounded = rules.outcomeWeeks({ runDays: runRows(), marks: marks(), today: tomorrow });
  check("today = 9999-12-31 is read as the server's tomorrow: the same weeks, not 416,031 of them",
    far.weeks.length === bounded.weeks.length && far.weeks.length < 60, String(far.weeks.length));
  check("last year's rows are not this year's", !/999/.test(JSON.stringify(res.weeks)));
  check("no name, no student number, no note anywhere in what it returns",
    !/Zebulon|Quartermaine|SN900|secret note|firstName|lastName|studentNumber/.test(flat), flat.match(/Zebulon|SN900|firstName|studentNumber/));
  check("it never reads the students table or the cash ledger (legacyMirror)",
    !d.log.includes("students") && !d.log.includes("legacyMirror"), d.log.join());
  const ids = res.rosterStaff.ids.map((p) => p[0]).sort();
  check("staff with a PowerSchool class, any role: by sign-in email, or by a psEmail patch (3 of 5)",
    res.rosterStaff.count === 3 && ids.includes("T001") && ids.includes("teachers:park") && ids.includes("teachers:pat") && !ids.includes("teachers:none"),
    JSON.stringify(res.rosterStaff));
  check("...and a psEmail that is another staff member's sign-in is refused, as rosterEmailFor refuses it",
    !ids.includes("teachers:sly"));
  check("ids pair the app's id (legacyId, else _id) with the Convex id", JSON.stringify(res.rosterStaff.ids.find((p) => p[0] === "T001")) === '["T001","teachers:lee"]');
  let refused = null;
  try { await loadQuery(QSRC, { kind: "student" }).trendsContext.handler({ db: makeDb(SEED()).db }, { today: "2026-10-03" }); }
  catch (e) { refused = String(e.message); }
  check("a student is refused", refused === "Staff only.", refused);
  let bad = null;
  try { await Q.trendsContext.handler({ db: makeDb(SEED()).db }, { today: "Oct 3" }); } catch (e) { bad = String(e.message); }
  check("a 'today' that is not a calendar day is refused", /YYYY-MM-DD/.test(String(bad)));
}

// ==================================================================== 6
console.log("\nDO THE ASSERTIONS HAVE TEETH?\n");
{
  const anyDate = await rulesFrom(breakOnce(RULES_SRC, "            if (u.late.has(d)) late[u.band] += 1;",
    "            if (u.late.has(d)) late[u.band] += 1;\n          }\n          for (const d of u.late) {\n            if (dates.includes(d) || !(d >= mon && d <= addDays(mon, 6))) continue;\n            late[u.band] += 1;", "any-date"));
  const hol = anyDate.outcomeWeeks({ runDays: runRows(), marks: marks(), today: "2026-10-03" });
  check("TEETH: count a tardy on any date of the week and the holiday's tardy is counted",
    wk(hol, "2026-09-07").bands["6-8"].unexcusedTardyDays === 1);
  const noFence = await rulesFrom(breakOnce(RULES_SRC, "            if (u.entry && d < u.entry) continue;\n", "", "entry-fence"));
  const nf = wk(noFence.outcomeWeeks({ runDays: runRows(), marks: marks(), today: "2026-10-03" }), "2026-09-14");
  check("TEETH: drop the entry fence and the joiner's Monday and Tuesday enter the denominator", nf.bands["6-8"].tardyMemberDays === 10);
  const noStale = await rulesFrom(breakOnce(RULES_SRC, "      const tardyStale = !marksThrough || dates.some((d) => d > marksThrough);",
    "      const tardyStale = false;", "stale"));
  const ns = wk(noStale.outcomeWeeks({ runDays: runRows(), marks: marks("2026-09-30T13:30:00.000Z"), today: "2026-10-03" }), "2026-09-28");
  check("TEETH: without the freshness fence the stale week reads as a (lower) rate, not 'not refreshed'",
    ns.tardyStale === false && ns.bands["6-8"].unexcusedTardyDays === 0 && ns.bands["6-8"].tardyMemberDays > 0);
  const anyBuilt = await rulesFrom(breakOnce(RULES_SRC, "      const status: \"in\" | \"pending\" = runBuiltThrough && friday <= runBuiltThrough ? \"in\" : \"pending\";",
    "      const status: \"in\" | \"pending\" = \"in\";", "pending"));
  const ab = wk(anyBuilt.outcomeWeeks({ runDays: runRows(DAYS.filter((d) => d <= "2026-10-01"), "2026-10-02T10:15:00.000Z"),
    marks: marks(), today: "2026-10-03" }), "2026-09-28");
  check("TEETH: call every week 'in' and the unbuilt week reads as a short four-day week", ab.status === "in" && ab.dates.length === 4);
  const nullZero = await rulesFrom(breakOnce(RULES_SRC,
    "    if (!Array.isArray(m.unexcusedTardyDates)) { marksMissingUnexcused++; continue; }",
    "    if (!Array.isArray(m.unexcusedTardyDates)) { marksMissingUnexcused++; }", "null"));
  let threw = false, nz = null;
  try { nz = nullZero.outcomeWeeks({ runDays: runRows(), marks: marks(), today: "2026-10-03" }); } catch (e) { threw = true; }
  check("TEETH: let a row with no unexcused field through and the run breaks or counts it",
    threw || wk(nz, "2026-09-14").bands["9-12"].tardyMemberDays !== 4);
  const named = QSRC.replace("      marksRows: out.marksRows,", "      marksRows: out.marksRows,\n      firstName: (marks[0] as any)?.firstName,");
  const leak = JSON.stringify(await loadQuery(named, PBIS).trendsContext.handler({ db: makeDb(SEED()).db }, { today: "2026-10-03" }));
  check("TEETH: add a name to the payload and the no-name check sees it", named !== QSRC && /Zebulon/.test(leak));
  const open = breakOnce(QSRC, "    const attendance = canReadInsights(me);", "    const attendance = true;", "gate");
  const openRes = await loadQuery(open, STAFF).trendsContext.handler({ db: makeDb(SEED()).db }, { today: "2026-10-03" });
  check("TEETH: without the gate a teacher gets the tardy and part-day sums the run chart refuses",
    wk(openRes, "2026-09-14").bands["6-8"].unexcusedTardyDays === 3);
  const unbounded = await rulesFrom(breakOnce(RULES_SRC,
    "  const today = ISO.test(serverDay) && ISO.test(asked) && asked > addDays(serverDay, 1) ? addDays(serverDay, 1) : asked;",
    "  const today = asked;", "bound"));
  const fast = unbounded.outcomeWeeks({ runDays: runRows(), marks: marks(), today: "2027-10-06", serverDay: "2026-10-03" });
  const fastOk = rules.outcomeWeeks({ runDays: runRows(), marks: marks(), today: "2027-10-06", serverDay: "2026-10-03" });
  check("TEETH: without the bound a clock a year fast adds a year of empty 'not yet in' weeks",
    fast.weeks.length > 50 && fastOk.weeks.length === 5, `${fast.weeks.length} vs ${fastOk.weeks.length}`);
  check("the bound only ever moves a day back: a slow or right clock is untouched",
    JSON.stringify(rules.outcomeWeeks({ runDays: runRows(), marks: marks(), today: "2026-10-03", serverDay: "2026-10-05" })) ===
    JSON.stringify(rules.outcomeWeeks({ runDays: runRows(), marks: marks(), today: "2026-10-03" })));
  check("withoutAttendance keeps the calendar of each week and nothing else",
    JSON.stringify(rules.withoutAttendance([{ monday: "m", friday: "f", status: "in", dates: ["d"], tardyStale: false, bands: { x: 1 } }])) ===
    '[{"monday":"m","friday":"f","status":"in","dates":["d"],"tardyStale":false,"bands":null}]');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
