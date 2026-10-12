// The weekly attendance-rate run charts BY STUDENT GROUP (2026-10-12): the
// server half. Run: npm test
//
// THE OWNER'S DECISIONS (2026-10-11), each held by a check below:
//   - Female/Male for admin, superadmin, PBIS and the Attendance Watch grant
//     (gender ONLY for the grant); English Learner and classification for
//     the three roles; Black or African American for admin and superadmin
//     ONLY; Hispanic never charted
//   - floor 30 on a typical day this year; 10 on every day of a week
//   - rates only on the wire; group size to the nearest 5
//   - English Learner lines from the status ON EACH DATE (the history)
//
// THE WAYS IT GOES WRONG, and every section is about one of them:
//   1. A GROUP ROW CORRUPTS TRENDS. The band rows must be byte-identical with
//      and without groups, and no group row may reach attendanceRunDays.
//   2. A DEMOGRAPHIC READ TAKES DOWN TRENDS. Each read fails alone, and the
//      band rows are written first.
//   3. SUBTRACTION EXPOSES A HANDFUL OF STUDENTS. The residual test, day by
//      day, read from the builder's own "none" rows -- and a brute-force
//      reader below tries every sum and difference.
//   4. TWO PERIODS SUBTRACT TO A WITHHELD WEEK. A withheld week is withheld
//      in every period that contains it; no week may be asked for twice.
//   5. THE GRANT, OR PBIS, SEES MORE THAN IT WAS GIVEN.
//   6. A COUNT LEAVES THE SERVER.
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const SRC = {
  rules: read("./convex/absenceDayRules.ts"),
  rollup: read("./convex/raceRollup.ts"),
  days: read("./convex/runChartDays.ts"),
  groups: read("./convex/runChartGroups.ts"),
  query: read("./convex/attendanceGroupRunChart.ts"),
  action: read("./convex/attendanceRunChart.ts"),
};
const dataSrc = read("./convex/attendanceRunChartData.ts");
const schemaSrc = read("./convex/schema.ts");
const approval = read("./docs/field-sourcing-approval.md");
const policySrc = read("./convex/restrictedPolicy.ts");
const subSrc = read("./convex/attendanceSubgroups.ts");
const rosterSrc = read("./wildcat-roster.js");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

const sandbox = {};
new Function("globalThis", rosterSrc).call(sandbox, sandbox);
const R = sandbox.WildcatRoster;

const tsx = (src) => ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const load = (src, deps = {}, prelude = "") => {
  const m = { exports: {} };
  new Function("module", "exports", "require", prelude + tsx(src))(m, m.exports, (p) => {
    if (deps[p]) return deps[p];
    throw new Error("unexpected import " + p);
  });
  return m.exports;
};
const vStub = new Proxy({}, { get: () => () => ({}) });

/** The shipped modules, wired to each other -- or with one source swapped, for the teeth. */
function modules(over = {}) {
  const src = { ...SRC, ...over };
  const rules = load(src.rules);
  const rollup = load(src.rollup);
  const days = load(src.days, { "./absenceDayRules": rules });
  const groups = load(src.groups, { "./raceRollup": rollup, "./absenceDayRules": rules, "./runChartDays": days });
  const query = load(src.query, {
    "./_generated/server": { query: (d) => d, internalMutation: (d) => d, internalQuery: (d) => d },
    "convex/values": { v: vStub },
    "./identity": { requireStaff: async (ctx) => ctx.staff },
    "./runChartDays": days, "./runChartGroups": groups,
  });
  return { rules, rollup, days, groups, query, src };
}
const M = modules();

// ------------------------------------------------------------ a tiny database
// Enough of Convex's query chain for these modules: withIndex ranges, order,
// take, first; insert, patch, delete. Reads and writes are counted.
const INDEXES = {
  attendanceRunGroupDays: { by_yearid_date: ["yearid", "date"], by_axis_date: ["axis", "date"] },
  attendanceRunGroupMonths: { by_yearid_month: ["yearid", "month"] },
  attendanceRunDays: { by_yearid_date: ["yearid", "date"] },
};
function fakeDb(tables) {
  let next = 1;
  const reads = [], writes = [];
  const query = (table) => {
    reads.push(table);
    let fields = null, desc = false;
    const cons = [];
    const result = () => {
      let out = (tables[table] || []).filter((r) => cons.every(([f, op, x]) =>
        op === "eq" ? r[f] === x : op === "gte" ? r[f] >= x : op === "lte" ? r[f] <= x : op === "gt" ? r[f] > x : r[f] < x));
      if (fields) out = out.slice().sort((a, b) => { for (const f of fields) { if (a[f] < b[f]) return -1; if (a[f] > b[f]) return 1; } return 0; });
      return desc ? out.reverse() : out;
    };
    const chain = {
      withIndex(name, fn) {
        fields = (INDEXES[table] || {})[name];
        if (!fields) throw new Error(`no index ${table}.${name}`);
        const q = {};
        for (const op of ["eq", "gte", "lte", "gt", "lt"]) q[op] = (f, x) => { cons.push([f, op, x]); return q; };
        if (fn) fn(q);
        return chain;
      },
      order(d) { desc = d === "desc"; return chain; },
      async take(n) { return result().slice(0, n); },
      async first() { return result()[0] ?? null; },
      async collect() { return result(); },
    };
    return chain;
  };
  return {
    reads, writes, tables,
    query,
    insert: async (t, doc) => { const _id = `${t}:${next++}`; (tables[t] ||= []).push({ _id, ...doc }); writes.push(["insert", t]); return _id; },
    patch: async (id, p) => { for (const t of Object.keys(tables)) { const r = tables[t].find((x) => x._id === id); if (r) Object.assign(r, p); } writes.push(["patch", id]); },
    delete: async (id) => { for (const t of Object.keys(tables)) { const i = tables[t].findIndex((x) => x._id === id); if (i >= 0) tables[t].splice(i, 1); } writes.push(["delete", id]); },
  };
}

const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const week = (monday, n = 5) => Array.from({ length: n }, (_, i) => addDays(monday, i));
/** Source with its comments blanked, so prose that names a rule is never mistaken for code that uses it. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
const keysDeep = (o, path = "", out = new Set()) => {
  if (Array.isArray(o)) { o.forEach((x) => keysDeep(x, path + "[]", out)); return out; }
  if (o && typeof o === "object") for (const k of Object.keys(o)) { out.add(path + "." + k); keysDeep(o[k], path + "." + k, out); }
  return out;
};

// ------------------------------------------------- stored rows from cell sizes
// One school day of every family, from its finest cells. `rate` is the share
// of each cell out a whole day (rounded per cell), so lines differ.
const SYNC = "2026-10-11T10:15:00.000Z";
function storedRow(yearid, date, axis, group, members, full) {
  return { yearid, date, axis, group, members, absentDays: full, fullDaysStrict: full, misrecordDaysByGap: [0, 0, 0],
           partialDays: 0, assumedPresentDays: 0, syncedAt: SYNC };
}
function familyRows(yearid, date, c) {
  // Whole days out: 8% of the school, shared out over each partition's cells
  // so that every axis adds up to the same whole school.
  const total = (c.F || 0) + (c.M || 0) + (c.gnone || 0);
  const target = Math.round(total * 0.08);
  const share = (cells) => {
    const out = Object.fromEntries(cells.map((k) => [k, Math.floor((c[k] || 0) * 0.08)]));
    const big = cells.slice().sort((a, b) => (c[b] || 0) - (c[a] || 0))[0];
    out[big] += target - Object.values(out).reduce((a, b) => a + b, 0);
    return out;
  };
  const fulls = { ...share(["F", "M", "gnone"]), ...share(["black", "rnone"]), ...share(["EL", "EO", "RFEP", "IFEP", "TBD", "NOREC"]) };
  const r = (axis, group, keys) => storedRow(yearid, date, axis, group,
    keys.reduce((n, k) => n + (c[k] || 0), 0), keys.reduce((n, k) => n + fulls[k], 0));
  return [
    r("gender", "F", ["F"]), r("gender", "M", ["M"]), r("gender", "none", ["gnone"]),
    r("race", "black", ["black"]), r("race", "none", ["rnone"]),
    r("el", "el", ["EL"]), r("el", "notel", ["EO", "RFEP", "IFEP", "TBD"]), r("el", "none", ["NOREC"]),
    r("ela", "EO", ["EO"]), r("ela", "RFEP", ["RFEP"]), r("ela", "IFEP", ["IFEP"]), r("ela", "none", ["TBD", "NOREC"]),
  ];
}
// THIS YEAR as measured (typical day): 612 students.
const THIS = { F: 297, M: 315, gnone: 0, black: 47, rnone: 565, EL: 115, EO: 268, RFEP: 197, IFEP: 28, TBD: 4, NOREC: 0 };
// LAST YEAR as measured: 440.
const LAST = { F: 212, M: 228, gnone: 0, black: 66, rnone: 374, EL: 92, EO: 193, RFEP: 136, IFEP: 19, TBD: 0, NOREC: 0 };
const THIS_WEEKS = ["2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"];
const LAST_WEEKS = ["2025-08-18", "2025-08-25", "2025-09-01", "2025-09-08"];

/** A database of both years, with `tweak(date, cells)` to change a day. */
function world(tweak = () => {}) {
  const groupRows = [], trends = [];
  const add = (yearid, weeks, base) => {
    for (const w of weeks) for (const d of week(w)) {
      const c = { ...base };
      tweak(d, c);
      groupRows.push(...familyRows(yearid, d, c));
      const whole = c.F + c.M + c.gnone;
      trends.push({ yearid, date: d, band: "6-8", members: whole, absentDays: 0, fullDaysStrict: 0, misrecordDaysByGap: [0, 0, 0],
                    partialDays: 0, assumedPresentDays: 0, gradeEstimated: false, syncedAt: SYNC });
    }
  };
  add(36, THIS_WEEKS, THIS);
  add(35, LAST_WEEKS, LAST);
  return { attendanceRunGroupDays: groupRows, attendanceRunDays: trends, attendanceRunGroupMonths: [] };
}
const ask = async (Q, staff, args, tables = world()) => {
  const db = fakeDb(tables);
  const res = await Q.query.groupWeeks.handler({ staff, db }, args);
  return { res, db };
};
const ADMIN = { role: "admin", email: "a@x" }, PBIS = { role: "pbis", email: "p@x" };
const GRANT = { role: "campusaide", email: "g@x", attendanceWatch: true };
const servedIn = (res) => res.periods.map((p) => (p.withheld ? null : p.value));

// ===========================================================================
console.log("\nTHE THRESHOLD HELPER AGREES WITH THE BROWSER, FOR EVERY THRESHOLD\n");
// ===========================================================================
{
  const splits = [
    { absentDays: 9, fullDaysStrict: 3, misrecordDaysByGap: [2, 1, 1], partialDays: 2 },
    { absentDays: 4, fullDaysStrict: 0, misrecordDaysByGap: [4], partialDays: 0 },
    { absentDays: 5, fullDaysStrict: 5, misrecordDaysByGap: [], partialDays: 0 },
    { absentDays: 6, fullDaysStrict: 1, misrecordDaysByGap: [1, 2, 3, 4], partialDays: 0 },
    { absentDays: 2, fullDaysStrict: 1.4, misrecordDaysByGap: [0.6, -1, "2"], partialDays: 1 },
    { absentDays: 3, fullDaysStrict: null, misrecordDaysByGap: [1], partialDays: 1 },
    { absentDays: 3, fullDaysStrict: 1, misrecordDaysByGap: "nope", partialDays: 1 },
    { fullDaysStrict: 2, misrecordDaysByGap: [1], partialDays: 1 },
    null, undefined, "x",
  ];
  const thresholds = [0, 1, 2, 3, 4, 5, 6, 10, -1, 1.4, 2.5, NaN, Infinity, "2", undefined, null];
  let agree = 0, total = 0;
  const off = [];
  for (const sp of splits) for (const t of thresholds) {
    total++;
    const b = R.absenceSplit(sp, { misrecordAt: t });
    const want = b ? b.fullDays : 0;
    const got = M.rules.fullDaysAt(sp, t);
    if (got === want) agree++; else off.push(JSON.stringify([sp, t, got, want]));
  }
  check(`fullDaysAt equals WildcatRoster.absenceSplit(...).fullDays in all ${total} cases (thresholds 0-10, junk, null splits)`,
    agree === total, off.slice(0, 3).join(" "));
  check("the threshold is read like the browser's: junk is the default 1, a fraction rounds",
    M.rules.misrecordAtOrDefault(-1) === 1 && M.rules.misrecordAtOrDefault("2") === 1 && M.rules.misrecordAtOrDefault(2.6) === 3
      && M.rules.misrecordAtOrDefault(0) === 0 && M.rules.DEFAULT_MISRECORD_AT === R.DEFAULT_DAY_SETTINGS.misrecordAt);
}

// ===========================================================================
console.log("\nTHE BUILDER: ONE LOOP, AND EVERY AXIS ADDS UP TO THE WHOLE SCHOOL\n");
// ===========================================================================
// A month of synthetic PowerSchool records: 40 students, four periods, ten
// school days, a leaver and a joiner, every kind of absent day.
const SLOTS = ["1(A)", "2(A)", "3(A)", "4(A)"];
const DAYS = [...week("2026-09-14"), ...week("2026-09-21")];
function fixture() {
  const students = [], cc = [], attendance = [], demo = new Map();
  for (let i = 1; i <= 40; i++) {
    const id = String(1000 + i);
    students.push({ id, grade_level: i <= 22 ? 7 : 10, enroll_status: 0, entrydate: "2026-08-12" });
    const start = i === 40 ? "2026-09-22" : "2026-08-12";
    const end = i === 39 ? "2026-09-17" : "2027-06-04";
    SLOTS.forEach((slot, k) => cc.push({ id: `${id}-${k}`, studentid: id, expression: slot, dateenrolled: start, dateleft: end }));
  }
  // Absences: whole days, a misrecord (one present among absences), partial days.
  const absent = (sid, date, slots) => new Set(slots.map((s) => `${sid}|${date}|${s}`));
  const out = new Set([
    ...absent("1001", "2026-09-14", SLOTS), ...absent("1001", "2026-09-15", SLOTS),
    ...absent("1002", "2026-09-15", SLOTS.slice(0, 3)),                     // + one explicit present: a misrecord
    ...absent("1003", "2026-09-16", SLOTS.slice(0, 2)),                     // partial
    ...absent("1007", "2026-09-17", SLOTS), ...absent("1013", "2026-09-18", SLOTS),
    ...absent("1020", "2026-09-14", SLOTS), ...absent("1020", "2026-09-21", SLOTS),
    ...absent("1005", "2026-09-22", SLOTS), ...absent("1039", "2026-09-15", SLOTS),
    ...absent("1040", "2026-09-23", SLOTS.slice(1)),
  ]);
  for (const s of students) {
    for (const d of DAYS) {
      for (const [k, slot] of SLOTS.entries()) {
        const seat = cc.find((c) => c.studentid === s.id && c.expression === slot);
        if (!(seat.dateenrolled <= d && d < seat.dateleft)) continue;
        // 1003 has its last two periods unrecorded on its partial day.
        if (s.id === "1003" && d === "2026-09-16" && k >= 2) continue;
        attendance.push({ studentid: s.id, att_date: d, attendance_codeid: out.has(`${s.id}|${d}|${slot}`) ? "A" : "P", ccid: seat.id });
      }
    }
  }
  // Demographics. Hispanic wins; a non-Hispanic 600 is Black, multi-race too,
  // unknown ethnicity falls through to race; gender X and blank are neither.
  for (const s of students) {
    const i = Number(s.id) - 1000;
    demo.set(s.id, {
      gender: i === 5 ? "X" : i === 6 ? "" : i % 2 ? "F" : "M",
      fedEthnicity: i >= 7 && i <= 13 ? "0" : i === 14 ? "" : "1",
      raceCodes: i === 7 || i === 8 || i === 9 ? ["600"] : i === 10 || i === 11 || i === 12 ? ["700"]
        : i === 13 ? ["600", "700"] : i === 14 ? ["600"] : i === 15 ? ["600"] : ["700"],
      elaHistory: i === 20 ? [{ status: "EL", start: "2019-01-01" }, { status: "RFEP", start: "2026-09-17" }]
        : i === 21 ? [{ status: "TBD", start: "2026-08-01" }]
        : i === 22 ? []
        : i === 23 ? [{ status: "IFEP", start: "2018-05-01" }]
        : i === 25 ? [{ status: "EL", start: "" }]
        : i === 26 ? [{ status: "EL", start: "2020-01-01" }, { status: "RFEP", start: "2020-01-01" }]
        : i === 30 ? [{ status: "EL", start: "2020-01-01" }]
        : i === 31 ? [{ status: "EO", start: "2027-01-01" }]
        : i === 39 ? [{ status: "EO", start: "2015-08-01" }]
        : [{ status: i % 3 ? "EO" : "RFEP", start: "2015-08-01" }],
    });
  }
  return { students, cc, attendance, demo };
}
const FX = fixture();
const baseInput = {
  attendance: FX.attendance, cc: FX.cc, students: FX.students, absentCodeIds: new Set(["A"]),
  from: "2026-09-01", to: "2026-09-30", isCurrentYear: true, yearLastDay: "2027-06-04",
};
const withGroups = (Mx, axes = Mx.groups.AXES) => Mx.days.buildRunDays({
  ...baseInput,
  groups: { axes: Object.fromEntries(axes.map((x) => [x, Mx.groups.GROUP_AXES[x]])), of: (sid, d) => Mx.groups.groupPairs(FX.demo.get(sid), d, axes) },
});
const SPLIT = ["members", "absentDays", "fullDaysStrict", "partialDays", "assumedPresentDays"];
function addsUp(built) {
  const bad = [];
  for (const d of built.schoolDays) {
    const whole = built.days.filter((r) => r.date === d);
    const tot = (rows, k) => rows.reduce((n, r) => n + (k === "mis" ? r.misrecordDaysByGap.join(",") : r[k]), 0);
    for (const axis of ["gender", "race", "el", "ela"]) {
      const rows = built.groupDays.filter((r) => r.date === d && r.axis === axis);
      if (axis === "ela") rows.push(built.groupDays.find((r) => r.date === d && r.axis === "el" && r.group === "el"));
      for (const k of SPLIT) if (tot(rows, k) !== tot(whole, k)) bad.push(`${d} ${axis} ${k}`);
      for (let i = 0; i < 3; i++) {
        const sum = (rs) => rs.reduce((n, r) => n + (r.misrecordDaysByGap[i] || 0), 0);
        if (sum(rows) !== sum(whole)) bad.push(`${d} ${axis} mis${i}`);
      }
    }
  }
  return bad;
}
const suite = {};
suite.bandsUntouched = (Mx) => {
  const plain = Mx.days.buildRunDays(baseInput);
  const grouped = withGroups(Mx);
  return JSON.stringify(plain.days) === JSON.stringify(grouped.days)
    && JSON.stringify(plain.months) === JSON.stringify(grouped.months)
    && JSON.stringify(plain.diagnostics) === JSON.stringify(grouped.diagnostics)
    && !("groupDays" in plain) && JSON.stringify(Object.keys(plain)) === JSON.stringify(["schoolDays", "days", "months", "diagnostics"]);
};
suite.sumsExact = (Mx) => addsUp(withGroups(Mx)).length === 0;
suite.asOfDate = (Mx) => {
  const b = withGroups(Mx);
  const at = (d, axis, group) => b.groupDays.find((r) => r.date === d && r.axis === axis && r.group === group).members;
  // 1020 was EL until 2026-09-16 and RFEP from 09-17. 1026 has two rows the
  // same day (unknowable), 1025 an undated row, 1031 a row starting next
  // year, 1022 none: all four in no group. 1030 is EL throughout.
  return at("2026-09-16", "el", "el") - at("2026-09-17", "el", "el") === 1
    && at("2026-09-17", "ela", "RFEP") - at("2026-09-16", "ela", "RFEP") === 1;
};
{
  const plain = M.days.buildRunDays(baseInput);
  const grouped = withGroups(M);
  check("the fixture is a real month: ten school days, a leaver and a joiner, whole, misrecorded and partial days",
    plain.schoolDays.length === 10 && plain.days.some((r) => r.misrecordDaysByGap[0] > 0) && plain.days.some((r) => r.partialDays > 0)
      && plain.days.some((r) => r.assumedPresentDays > 0));
  check("WITHOUT groups the answer is exactly what it always was: same keys, no group key at all",
    !("groupDays" in plain) && JSON.stringify(Object.keys(plain)) === JSON.stringify(["schoolDays", "days", "months", "diagnostics"]));
  check("the band rows, month rows and diagnostics are byte-identical with and without groups", suite.bandsUntouched(M));
  const bad = addsUp(grouped);
  check("every axis adds up to the whole school EXACTLY, every day: members and every absence component (ela with el:el)",
    bad.length === 0, bad.slice(0, 4).join("; "));
  const per = grouped.schoolDays.length * (2 + 1 + 1 + 1 + 2 + 1 + 3 + 1);
  const allF = M.days.buildRunDays({ ...baseInput, groups: { axes: { gender: ["F", "M"] }, of: () => [["gender", "F"]] } });
  check("every group row exists on every school day, zeros included (a missing row means 'not built')",
    grouped.groupDays.length === per && allF.groupDays.length === 30
      && allF.groupDays.filter((r) => r.group === "M").every((r) => r.members === 0 && r.absentDays === 0)
      && allF.groupDays.filter((r) => r.group === "M").length === 10, `${grouped.groupDays.length} vs ${per}`);
  const day = "2026-09-14";
  const g = (axis, group) => grouped.groupDays.find((r) => r.date === day && r.axis === axis && r.group === group).members;
  // Black: 1007, 1008, 1009 (600, not Hispanic), 1013 (600+700), 1014
  // (unknown ethnicity, 600); NOT 1015 (Hispanic, 600 -- Hispanic wins).
  check("race: a non-Hispanic 600 is Black, a multi-race 600 too, an unknown ethnicity falls through; a Hispanic 600 is not",
    g("race", "black") === 5 && g("race", "none") === 34, `${g("race", "black")}/${g("race", "none")}`);
  check("gender: F and M as recorded; 'X' and blank are in no group (never rounded to one of the two)",
    g("gender", "none") === 2 && g("gender", "F") + g("gender", "M") === 37);
  check("English Learner from the status ON THE DATE: a student reclassified on 09-17 moves from EL to RFEP that day", suite.asOfDate(M));
  check("...pending (TBD) is 'not EL' and in no classification group; no status, an undated row, a tie or a future row is in no group",
    g("el", "none") === 4 && g("ela", "none") === 5, `${g("el", "none")}/${g("ela", "none")}`);
  check("seatedStudents is the build's own count of students with a class",
    M.days.seatedStudents(FX.cc).size === plain.diagnostics.studentsWithClasses);
  const pairs = M.groups.groupPairs(FX.demo.get("1030"), "2026-09-14", M.groups.AXES);
  check("a current English Learner is el:el and in NO classification row (the classification's EL line is el:el)",
    JSON.stringify(pairs.filter(([a]) => a === "el" || a === "ela")) === JSON.stringify([["el", "el"]]));
  check("only the axes asked for are built", (() => {
    const b = withGroups(M, ["gender"]);
    return new Set(b.groupDays.map((r) => r.axis)).size === 1 && b.groupDays.every((r) => r.axis === "gender");
  })());
}

// ===========================================================================
console.log("\nWHO MAY SEE WHICH GROUP: A DIRECT ROLE LIST, AND THE GRANT FOR GENDER ONLY\n");
// ===========================================================================
suite.roles = (Mx) => {
  const t = (s) => Mx.groups.groupTypesFor(s).join(",");
  return t(ADMIN) === "gender,race,el,ela" && t({ role: "superadmin" }) === "gender,race,el,ela"
    && t(PBIS) === "gender,el,ela"
    && t(GRANT) === "gender" && t({ role: "teacher", attendanceWatch: true }) === "gender"
    && t({ role: "teacher" }) === "" && t({ role: "campusaide" }) === "" && t({ role: "campusaide", attendanceWatch: false }) === ""
    && t({ role: "campusaide", attendanceWatch: "true" }) === "" && t({ role: "teacher", attendanceWatch: 1 }) === "" && t(null) === "";
};
suite.adminList = async (Mx) => (await ask(Mx, ADMIN, {})).res.groups.map((g) => g.id).join(",")
  === "gender:F,gender:M,race:black,el:el,el:notel,ela:EO,ela:RFEP,ela:EL";
suite.grantGenderOnly = async (Mx) => {
  const list = (await ask(Mx, GRANT, {})).res;
  const el = (await ask(Mx, GRANT, { group: "el:el", periods: [[THIS_WEEKS[4]]] })).res;
  const race = (await ask(Mx, GRANT, { group: "race:black", periods: [[THIS_WEEKS[4]]] })).res;
  return list.allowed === true && list.groups.map((g) => g.id).join(",") === "gender:F,gender:M"
    && el.refused && el.periods.length === 0 && el.group === null
    && race.refused && race.periods.length === 0;
};
suite.pbisNoRace = async (Mx) => {
  const list = (await ask(Mx, PBIS, {})).res;
  const race = (await ask(Mx, PBIS, { group: "race:black", periods: [[THIS_WEEKS[4]]] })).res;
  return !list.groups.some((g) => g.type === "race") && race.refused && race.periods.length === 0
    && list.unavailable.some((u) => u.type === "race" && /administrators only/.test(u.reason));
};
{
  check("admin and superadmin: every type; PBIS: no race; the grant: gender only; '\"true\"' or 1 is no grant", suite.roles(M));
  const admin = (await ask(M, ADMIN, {})).res;
  check("admin's list: Female, Male, Black, Current EL, Not EL, EO, RFEP, and the classification's EL (IFEP at 28 is not offered)",
    await suite.adminList(M), admin.groups.map((g) => g.id).join(","));
  check("...IFEP is listed as not charted, with the floor's reason and no number of its own",
    admin.unavailable.some((u) => u.group === "Initially fluent (IFEP)" && /Fewer than 30 students/.test(u.reason) && !/28/.test(u.reason)));
  check("...Hispanic or Latino is never charted, and says why", admin.unavailable.some((u) => u.group === "Hispanic or Latino")
    && !M.groups.SERIES.some((s) => /hispanic/i.test(s.id + s.label)));
  check("...the classification's EL is the same line as Current English Learner (one series, not stored twice)",
    admin.groups.find((g) => g.id === "ela:EL").sameAs === "el:el" && M.groups.SERIES.find((s) => s.id === "ela:EL").row === "el:el");
  check("PBIS sees no race line at all, and is refused one if it asks", await suite.pbisNoRace(M));
  check("the grant sees Female and Male only; asking for English Learner or race is refused with no periods", await suite.grantGenderOnly(M));
  for (const staff of [{ role: "teacher", email: "t@x" }, { role: "campusaide", email: "c@x" }, { role: "campusaide", email: "c@x", attendanceWatch: "true" }]) {
    const { res, db } = await ask(M, staff, { group: "gender:F", periods: [[THIS_WEEKS[4]]] });
    check(`${staff.role}${staff.attendanceWatch ? " with a non-boolean grant" : ""}: refused, nothing listed, and not one table read`,
      res.allowed === false && res.groups.length === 0 && res.periods.length === 0 && db.reads.length === 0);
  }
  // SOURCE PINS, both ways.
  const handler = SRC.query.slice(SRC.query.indexOf("export const groupWeeks"));
  check("the query decides access with groupTypesFor, before any table is read",
    /const types = groupTypesFor\(staff\);/.test(handler) && handler.indexOf("groupTypesFor(staff)") < handler.indexOf("ctx.db"));
  check("...and never with canReadInsights (which lets the grant in for everything)",
    !/canReadInsights|INSIGHT_ROLES|accessRules/.test(code(SRC.query)) && !/canReadInsights|accessRules/.test(code(SRC.groups)));
  const fn = SRC.groups.slice(SRC.groups.indexOf("export function groupTypesFor"), SRC.groups.indexOf("export const TYPE_LABELS"));
  check("groupTypesFor: the role lists first, then attendanceWatch === true for [\"gender\"] and nothing else",
    /if \(RACE_LINE_ROLES\.includes\(role\)\)/.test(fn) && /if \(GROUP_CHART_ROLES\.includes\(role\)\)/.test(fn)
      && /if \(staff\.attendanceWatch === true\) return \["gender"\];/.test(fn)
      && /export const GROUP_CHART_ROLES = \["admin", "superadmin", "pbis"\];/.test(SRC.groups)
      && /export const RACE_LINE_ROLES = \["admin", "superadmin"\];/.test(SRC.groups));
  // The Trends reads never carry a group row.
  const tablesReading = (name) => [...new Set(Object.entries({
    "attendanceRunChartData.ts": dataSrc, "cashInsights.ts": read("./convex/cashInsights.ts"),
    "attendanceSubgroups.ts": subSrc, "attendanceList.ts": read("./convex/attendanceList.ts"),
  }).filter(([, s]) => s.includes(name)).map(([f]) => f))];
  check("series() and cashInsights:trendsContext never read the group table (so the grant and teachers never get a group key)",
    tablesReading("attendanceRunGroupDays").length === 0 && tablesReading("attendanceRunGroupMonths").length === 0);
  check("...and the group rows are written only to their own table, never to attendanceRunDays",
    !/attendanceRunDays"/.test(SRC.query.slice(0, SRC.query.indexOf("export const groupWeeks"))) && !/insert\("attendanceRunDays"/.test(SRC.query)
      && /replaceGroupMonth/.test(SRC.action) && (SRC.action.match(/attendanceRunChartData\.replaceMonth/g) || []).length === 1);
  check("the year-to-date table still checks the ROLES, unchanged", /if \(!SUBGROUP_ROLES\.includes\(staff\.role\)\)/.test(subSrc) && !/canReadInsights/.test(subSrc));
}

// ===========================================================================
console.log("\nTHE FLOORS: 30 ON A TYPICAL DAY, 10 ON EVERY DAY OF A WEEK\n");
// ===========================================================================
suite.dayFloor = async (Mx) => {
  // On Wednesday of the 5th week, Female has 9 students that day (the rest of
  // the school in Male): that week goes blank; at 10 it is drawn. On the 6th
  // week's Tuesday the group has NOBODY that day: blank too.
  const at = (n) => world((d, c) => {
    if (d === addDays(THIS_WEEKS[4], 2)) { c.M += c.F - n; c.F = n; }
    if (d === addDays(THIS_WEEKS[5], 1)) { c.M += c.F; c.F = 0; }
  });
  const periods = THIS_WEEKS.slice(3, 7).map((w) => [w]);
  const nine = (await ask(Mx, ADMIN, { group: "gender:F", periods }, at(9))).res;
  const ten = (await ask(Mx, ADMIN, { group: "gender:F", periods }, at(10))).res;
  return nine.periods[1].withheld === "small" && nine.periods[0].withheld === null && nine.periods[3].withheld === null
    && ten.periods[1].withheld === null && typeof ten.periods[1].value === "number"
    && nine.periods[2].withheld === "small" && ten.periods[2].withheld === "small";
};
{
  check("a day with 9 in the group leaves its week blank; 10 draws it; a day with nobody leaves it blank", await suite.dayFloor(M));
  const res = (await ask(M, ADMIN, {})).res;
  const black = res.groups.find((g) => g.id === "race:black");
  check("Black (47 on a typical day) is offered and marked small (under 60); Female (297) is not small",
    black && black.small === true && res.groups.find((g) => g.id === "gender:F").small === false);
  check("sizes leave rounded to the nearest 5 (297 -> 295, 47 -> 45, 115 -> 115)",
    res.groups.find((g) => g.id === "gender:F").size === 295 && black.size === 45 && res.groups.find((g) => g.id === "el:el").size === 115);
  const at30 = (await ask(M, ADMIN, {}, world((d, c) => { c.IFEP = 30; c.TBD = 0; c.EO += 2; }))).res;
  check("IFEP at 30 on a typical day IS offered (the floor is 30, not 31)", at30.groups.some((g) => g.id === "ela:IFEP"));
  // With 2 pending assessment every day, the five classification lines and
  // the whole school subtract to those 2: IFEP (the smallest line whose going
  // settles it) is not charted, and says so -- it is not offered only to be
  // withheld every week.
  const pend = (await ask(M, ADMIN, {}, world((d, c) => { c.IFEP = 30; c.TBD = 2; }))).res;
  check("...but with 2 students pending on a typical day, IFEP's line would let them be worked out: not charted, and why",
    !pend.groups.some((g) => g.id === "ela:IFEP")
      && pend.unavailable.some((u) => u.group === "Initially fluent (IFEP)" && /worked out by subtraction/.test(u.reason)));
  const onlyLast = world();
  onlyLast.attendanceRunGroupDays = onlyLast.attendanceRunGroupDays.filter((r) => r.yearid === 35);
  const ol = (await ask(M, ADMIN, {}, onlyLast)).res;
  check("last year's group rows alone (backfilled first) never set this year's floors: nothing is offered until this year is built",
    ol.groups.length === 0 && ol.unavailable.some((u) => /No figures for this group yet this year/.test(u.reason)));
  check("the floors are stated in the answer for the screen to say", res.floors.chart === 30 && res.floors.day === 10
    && res.floors.small === 60 && res.floors.sizeRoundedTo === 5 && res.elBasis === "status on each date");
}

// ===========================================================================
console.log("\nTHE RESIDUAL TEST: NOTHING ADDS OR SUBTRACTS DOWN TO 1 TO 9 STUDENTS\n");
// ===========================================================================
suite.raceExample = (Mx) => {
  // Measured: 555 Hispanic, 47 Black, 5 in neither. Both lines together would
  // give the 5 back; the Black line alone does not.
  const cells = new Map([["hisp", 555], ["black", 47], ["rest", 5]]);
  return Mx.groups.exposesSmall(cells, [["hisp"], ["black"]]) === true && Mx.groups.exposesSmall(cells, [["black"]]) === false;
};
suite.pendingTakesSmallest = async (Mx) => {
  // IFEP at 35 is offered; on the 5th week's Thursday 3 students are pending
  // assessment: Not EL - EO - RFEP - IFEP would be those 3. The smallest line
  // shown (IFEP) goes for that week, and only it.
  const w = world((d, c) => { c.IFEP = 35; c.EO -= 7; c.TBD = d === addDays(THIS_WEEKS[4], 3) ? 3 : 0; c.EO += 4 - c.TBD; });
  const ids = ["ela:IFEP", "ela:EO", "ela:RFEP", "el:notel", "el:el", "ela:EL"];
  const out = {};
  for (const id of ids) out[id] = (await ask(Mx, ADMIN, { group: id, periods: [[THIS_WEEKS[3]], [THIS_WEEKS[4]]] }, w)).res.periods.map((p) => p.withheld);
  return out["ela:IFEP"][0] === null && out["ela:IFEP"][1] === "small"
    && ids.slice(1).every((id) => out[id][0] === null && out[id][1] === null);
};
suite.sharedLine = async (Mx) => {
  // LAST YEAR, a week with 5 students who had no status yet on one day:
  // whole - EL - Not EL = 5. Current EL (smaller) goes -- AND so does the
  // classification's EL, which is the same rows, or it would come straight
  // back through the other menu.
  const w = world((d, c) => { if (d === addDays(LAST_WEEKS[1], 1)) { c.NOREC = 5; c.EO -= 5; } });
  const p = [[LAST_WEEKS[0]], [LAST_WEEKS[1]]];
  const el = (await ask(Mx, ADMIN, { group: "el:el", periods: p }, w)).res.periods.map((x) => x.withheld);
  const elaEl = (await ask(Mx, ADMIN, { group: "ela:EL", periods: p }, w)).res.periods.map((x) => x.withheld);
  const notel = (await ask(Mx, ADMIN, { group: "el:notel", periods: p }, w)).res.periods.map((x) => x.withheld);
  return el[1] === "small" && elaEl[1] === "small" && el[0] === null && elaEl[0] === null && notel[1] === null;
};
suite.genderPool = async (Mx) => {
  const w = world((d, c) => { if (d === addDays(THIS_WEEKS[2], 0)) { c.gnone = 3; c.M -= 3; } });
  const p = [[THIS_WEEKS[1]], [THIS_WEEKS[2]]];
  const f = (await ask(Mx, ADMIN, { group: "gender:F", periods: p }, w)).res.periods.map((x) => x.withheld);
  const m = (await ask(Mx, GRANT, { group: "gender:M", periods: p }, w)).res.periods.map((x) => x.withheld);
  return f[1] === "small" && f[0] === null && m[1] === null && m[0] === null;
};
// A BRUTE-FORCE READER: random days of the English Learner family, every
// line the residual test leaves, and every sum and difference of them and
// the whole school with coefficients -2..2. None may come to 1-9 students.
suite.bruteForce = (Mx) => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const LINES = { "el:el": ["EL"], "el:notel": ["EO", "RFEP", "IFEP", "TBD"], "ela:EO": ["EO"], "ela:RFEP": ["RFEP"], "ela:IFEP": ["IFEP"] };
  const CELLS = ["EL", "EO", "RFEP", "IFEP", "TBD", "NOREC"];
  let leaks = 0, cases = 0, missed = 0;
  for (let t = 0; t < 250; t++) {
    const size = Object.fromEntries(CELLS.map((c) => [c, [0, 1, 3, 5, 9, 10, 12, 40, 100][rnd(9)]]));
    const rows = new Map();
    const put = (k, n) => rows.set(k, { members: n });
    put("el:el", size.EL); put("el:notel", size.EO + size.RFEP + size.IFEP + size.TBD); put("el:none", size.NOREC);
    put("ela:EO", size.EO); put("ela:RFEP", size.RFEP); put("ela:IFEP", size.IFEP); put("ela:none", size.TBD + size.NOREC);
    const offered = Object.keys(LINES).filter(() => rnd(4) > 0);
    const order = offered.slice().sort(() => rnd(3) - 1);
    const { removed } = Mx.groups.withheldOnDay("el", rows, offered, order);
    const shown = offered.filter((r) => !removed.has(r));
    const vecs = [CELLS.map(() => 1), ...shown.map((r) => CELLS.map((c) => (LINES[r].includes(c) ? 1 : 0)))];
    const smallest = (lines) => {
      const coef = new Array(lines.length).fill(-2);
      let best = null;
      for (;;) {
        let pool = 0;
        for (let k = 0; k < CELLS.length; k++) {
          let s = 0;
          for (let j = 0; j < lines.length; j++) s += coef[j] * lines[j][k];
          if (s !== 0) pool += size[CELLS[k]];
        }
        if (pool > 0 && pool < 10) best = best === null ? pool : Math.min(best, pool);
        let j = 0;
        while (j < coef.length && coef[j] === 2) coef[j++] = -2;
        if (j === coef.length) break;
        coef[j]++;
      }
      return best;
    };
    cases++;
    if (smallest(vecs) !== null) leaks++;
    // The other direction: where the brute force finds a pool among the lines
    // OFFERED, the rank test must have said so too.
    const allVecs = [CELLS.map(() => 1), ...offered.map((r) => CELLS.map((c) => (LINES[r].includes(c) ? 1 : 0)))];
    const cells = new Map(CELLS.map((c) => [c, size[c]]));
    if (smallest(allVecs) !== null && !Mx.groups.exposesSmall(cells, offered.map((r) => LINES[r]))) missed++;
  }
  return { ok: leaks === 0 && missed === 0, leaks, missed, cases };
};
{
  check("555 / 47 / 5: the Hispanic and Black lines together give the 5 back; the Black line alone does not", suite.raceExample(M));
  check("...so there is no Hispanic line to ask for, and the Black line is served",
    !M.groups.SERIES.some((s) => /hisp/i.test(s.id)) && (await ask(M, ADMIN, { group: "race:black", periods: [[THIS_WEEKS[4]]] })).res.periods[0].withheld === null);
  check("3 students pending assessment on one day withhold the SMALLEST classification line (IFEP) that week, and nothing else",
    await suite.pendingTakesSmallest(M));
  check("a shared line goes from BOTH menus: 5 students with no status withhold Current EL and the classification's EL alike",
    await suite.sharedLine(M));
  check("3 students outside F/M on one day withhold Female (the smaller) that week; Male stays, for the grant too", await suite.genderPool(M));
  const bf = suite.bruteForce(M);
  check(`a brute-force reader finds no sum or difference of 1-9 students in ${bf.cases} random days (and the rank test misses none)`,
    bf.ok, JSON.stringify(bf));
  check("the test reads the builder's own 'none' rows, never whole-school minus groups from two tables",
    /familyCells/.test(SRC.groups) && !/attendanceRunDays/.test(code(SRC.groups))
      && /"el:" \+ GROUP_NONE/.test(SRC.groups) && /"ela:" \+ GROUP_NONE/.test(SRC.groups));
  check("a day whose rows do not add up is no data, never served",
    M.groups.familyCells("el", new Map([["el:el", { members: 10 }], ["el:notel", { members: 50 }], ["el:none", { members: 0 }],
      ["ela:EO", { members: 30 }], ["ela:RFEP", { members: 10 }], ["ela:IFEP", { members: 5 }], ["ela:none", { members: 0 }]])) === null);
}

// ===========================================================================
console.log("\nTHE PERIODS: WHOLE WEEKS, ONE YEAR, NO WEEK TWICE, AND A WITHHELD WEEK STAYS WITHHELD\n");
// ===========================================================================
suite.periodShape = (Mx) => {
  const c = (p) => Mx.groups.checkPeriods(p).ok;
  return c([["2026-09-14"]]) && c([["2026-09-14", "2026-09-21"], ["2026-09-28"]])
    && !c([["2026-09-15"]])                                     // a Tuesday: a single date is not a week
    && !c([["2026-09-14"], ["2026-09-14", "2026-09-21"]])      // a week in two periods
    && !c([["2026-09-14", "2026-09-14"]])                      // the same week twice in one
    && !c([["2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14"]]) // five weeks
    && !c([]) && !c([[]]) && !c("2026-09-14") && !c([["2026-9-14"]]) && !c([["2026-02-30"]])
    && !c(Array.from({ length: 121 }, (_, i) => [addDays("2026-01-05", 7 * i)]));
};
suite.withheldEverywhere = async (Mx) => {
  // Week 5 fails (a pending pool of 3 with IFEP offered); every period that
  // contains it withholds IFEP, every period that does not, serves it.
  const w = world((d, c) => { c.IFEP = 35; c.EO -= 7; c.TBD = d === addDays(THIS_WEEKS[4], 3) ? 3 : 0; c.EO += 4 - c.TBD; });
  const W1 = THIS_WEEKS[3], W2 = THIS_WEEKS[4], W3 = THIS_WEEKS[5], W4 = THIS_WEEKS[6];
  const sets = [[[W2]], [[W1, W2]], [[W2, W3]], [[W1, W2, W3]], [[W1, W2, W3, W4]], [[W1]], [[W3, W4]], [[W1, W3]]];
  const got = [];
  for (const s of sets) got.push((await ask(Mx, ADMIN, { group: "ela:IFEP", periods: s }, w)).res.periods[0].withheld);
  return got.slice(0, 5).every((x) => x === "small") && got.slice(5).every((x) => x === null);
};
suite.minDays = async (Mx) => {
  // A week with ONE school day is withheld on its own AND merged into the
  // next week: served merged, it would come back as the merged rate less the
  // next week's, asked for separately -- a daily rate.
  const tables = world();
  const keep = new Set([...week(THIS_WEEKS[0]).slice(0, 1), ...THIS_WEEKS.slice(1).flatMap((w) => week(w)), ...LAST_WEEKS.flatMap((w) => week(w))]);
  tables.attendanceRunDays = tables.attendanceRunDays.filter((r) => keep.has(r.date));
  tables.attendanceRunGroupDays = tables.attendanceRunGroupDays.filter((r) => keep.has(r.date));
  const one = (await ask(Mx, ADMIN, { group: "gender:F", periods: [[THIS_WEEKS[0]], [THIS_WEEKS[1]]] }, tables)).res;
  const merged = (await ask(Mx, ADMIN, { group: "gender:F", periods: [[THIS_WEEKS[0], THIS_WEEKS[1]]] }, tables)).res;
  return one.periods[0].withheld === "few-days" && one.periods[0].value === null && one.periods[1].withheld === null
    && merged.periods[0].withheld === "few-days" && merged.periods[0].value === null;
};
{
  check("periods are 1-4 whole weeks named by their Mondays; a lone date, a week twice, five weeks, a bad date or 121 periods are refused",
    suite.periodShape(M));
  const mixed = (await ask(M, ADMIN, { group: "gender:F", periods: [[LAST_WEEKS[3], THIS_WEEKS[0]]] })).res;
  check("a period crossing from one school year into the next is refused, with no rates at all",
    typeof mixed.invalid === "string" && /school year/.test(mixed.invalid) && mixed.periods.length === 0);
  const twice = (await ask(M, ADMIN, { group: "gender:F", periods: [[THIS_WEEKS[2]], [THIS_WEEKS[2], THIS_WEEKS[3]]] })).res;
  check("overlapping periods in one call are refused before anything is read", typeof twice.invalid === "string" && twice.periods.length === 0);
  check("a withheld week is withheld in EVERY period containing it, and only those", await suite.withheldEverywhere(M));
  check("a week of one school day is never served, alone OR merged into the next week (either way, a daily rate)", await suite.minDays(M));
  // Weeks merged across a break (runWeekGroups carries a short week into the
  // next SCHOOL week) are not consecutive, and are allowed.
  const gap = (await ask(M, ADMIN, { group: "gender:F", periods: [[THIS_WEEKS[0], THIS_WEEKS[2]]] })).res;
  check("weeks merged across a break (not consecutive) are one period", gap.periods.length === 1 && gap.periods[0].withheld === null);
}

// ===========================================================================
console.log("\nTHE LINES LINE UP WITH TRENDS\n");
// ===========================================================================
{
  // A group that IS the whole school must read exactly what Trends reads, at
  // every threshold, through the browser's own week grouping.
  const tables = world((d, c) => { c.F += c.M; c.M = 0; });
  // Give the days misrecord days and partial days, so the threshold matters.
  let k = 0;
  for (const r of tables.attendanceRunGroupDays) {
    if (r.axis !== "gender") continue;
    if (r.group === "F") { k++; r.misrecordDaysByGap = [k % 4, k % 3, k % 2]; r.partialDays = k % 5; r.absentDays = r.fullDaysStrict + (k % 4) + (k % 3) + (k % 2) + (k % 5); }
  }
  const trendsRows = tables.attendanceRunGroupDays.filter((r) => r.axis === "gender" && r.group === "F")
    .map((r) => ({ ...r, band: "6-8", gradeEstimated: false }));
  // A two-day week (a holiday week), so merging and keeping it separate differ.
  const holiday = new Set(week(THIS_WEEKS[2]).slice(2));
  tables.attendanceRunGroupDays = tables.attendanceRunGroupDays.filter((r) => !holiday.has(r.date));
  const trendsRowsAll = trendsRows.filter((r) => !holiday.has(r.date));
  trendsRows.length = 0;
  trendsRows.push(...trendsRowsAll);
  // Trends sees the same rows as its whole school.
  tables.attendanceRunDays = trendsRows.map((r) => ({ ...r }));
  let same = 0, total = 0;
  const off = [];
  for (const misrecordAt of [0, 1, 2, 3, 5]) for (const policy of ["merge", "separate"]) {
    const groups = R.runWeekGroups(R.runSeriesDays(trendsRows, "all", { misrecordAt }), policy, "2026-10-12");
    const trend = R.runWeeklyRate(trendsRows, "all", groups, { misrecordAt });
    const periods = groups.map((g) => g.parts.map((p) => p.week));
    const res = (await ask(M, ADMIN, { group: "gender:F", periods, misrecordAt }, tables)).res;
    trend.forEach((p, i) => {
      total++;
      const s = res.periods[i];
      if (s && (s.value === p.value || (s.withheld === "few-days" && p.schoolDays < 2))) same++;
      else off.push(`${misrecordAt}/${policy} ${p.key}: ${s && s.value} vs ${p.value}`);
    });
  }
  check(`a group that is the whole school reads exactly the Trends line: ${total} weekly points, thresholds 0-5, merged and separate`,
    same === total && total > 30, off.slice(0, 3).join("; "));
  check("...including a two-day week kept separate, and the same week merged into the next",
    R.runWeekGroups(R.runSeriesDays(trendsRows, "all", {}), "merge", "2026-10-12").some((g) => g.parts.length === 2)
      && R.runWeekGroups(R.runSeriesDays(trendsRows, "all", {}), "separate", "2026-10-12").some((g) => g.flag === "short"));
  // A day in the group table that Trends does not have is not read: on
  // Wednesday of week 5 every Female student is out in the group rows, but
  // Trends has no such day. The answer is the four days Trends has.
  const wed = addDays(THIS_WEEKS[4], 2);
  const extra = world();
  extra.attendanceRunDays = extra.attendanceRunDays.filter((r) => r.date !== wed);
  for (const r of extra.attendanceRunGroupDays) if (r.date === wed && r.axis === "gender" && r.group === "F") { r.fullDaysStrict = r.members; r.absentDays = r.members; }
  const four = world();
  four.attendanceRunDays = four.attendanceRunDays.filter((r) => r.date !== wed);
  four.attendanceRunGroupDays = four.attendanceRunGroupDays.filter((r) => r.date !== wed);
  const a = (await ask(M, ADMIN, { group: "gender:F", periods: [[THIS_WEEKS[4]]] }, extra)).res.periods[0];
  const b = (await ask(M, ADMIN, { group: "gender:F", periods: [[THIS_WEEKS[4]]] }, four)).res.periods[0].value;
  check("a day Trends does not have is never read: the week is withheld as no data (it could gain that day later), "
    + "and the same four days with no extra row are served", a.value === null && a.withheld === "no-data" && b > 80, `${JSON.stringify(a)} vs ${b}`);
  // The rest of the school, and the gap the headline reads.
  const res = (await ask(M, ADMIN, { group: "race:black", periods: THIS_WEEKS.slice(0, 6).map((w) => [w]) },
    world((d, c) => {}))).res;
  check("each period carries the REST of the school's rate (not the whole school containing the group)",
    res.periods.every((p) => typeof p.rest === "number") && res.vsRest && res.vsRest.periods === 6 && res.vsRest.yearid === 36);
}

// ===========================================================================
console.log("\nNOTHING COUNTABLE LEAVES THE SERVER\n");
// ===========================================================================
const ALLOWED_KEYS = new Set([
  ".allowed", ".reason", ".refused", ".invalid", ".notYet", ".asOf", ".elBasis",
  ".groups", ".groups[].id", ".groups[].type", ".groups[].typeLabel", ".groups[].label", ".groups[].size", ".groups[].small", ".groups[].sameAs",
  ".unavailable", ".unavailable[].type", ".unavailable[].group", ".unavailable[].reason",
  ".floors", ".floors.chart", ".floors.day", ".floors.small", ".floors.sizeRoundedTo",
  ".group", ".group.id", ".group.type", ".group.typeLabel", ".group.label", ".group.size", ".group.small", ".group.sameAs",
  ".periods", ".periods[].key", ".periods[].value", ".periods[].rest", ".periods[].withheld",
  ".vsRest", ".vsRest.yearid", ".vsRest.periods", ".vsRest.points", ".vsRest.withinChance", ".notBuilt",
]);
suite.keys = async (Mx) => {
  const bad = new Set();
  for (const staff of [ADMIN, PBIS, GRANT, { role: "teacher" }]) {
    for (const args of [{}, { group: "gender:F" }, { group: "race:black", periods: THIS_WEEKS.map((w) => [w]) },
      { group: "ela:EL", periods: LAST_WEEKS.map((w) => [w]) }, { group: "el:el", periods: [["2026-09-15"]] }]) {
      const { res } = await ask(Mx, staff, args);
      for (const k of keysDeep(res)) if (!ALLOWED_KEYS.has(k)) bad.add(k);
    }
  }
  return { ok: bad.size === 0, bad: [...bad] };
};
{
  const k = await suite.keys(M);
  check("every key of every answer is on the allowlist: no members, student-days, absence counts, dates of membership or ids",
    k.ok, k.bad.join(", "));
  const { res } = await ask(M, ADMIN, { group: "gender:F", periods: THIS_WEEKS.map((w) => [w]) });
  check("rates to one decimal; sizes multiples of 5",
    res.periods.every((p) => p.value === null || Math.round(p.value * 10) === p.value * 10)
      && res.groups.every((g) => g.size % 5 === 0));
  check("the schema keeps the group rows to numbers: no name, email or student number",
    !/name|email|student_number|studentNumber/i.test(schemaSrc.slice(schemaSrc.indexOf("attendanceRunGroupDays: defineTable"),
      schemaSrc.indexOf("attendanceRunMonths: defineTable"))));
}

// ===========================================================================
console.log("\nTHE WRITE: ONE MUTATION, WHOLE AXES, NOTHING STALE LEFT BEHIND\n");
// ===========================================================================
function monthPayload(axes, days = week("2026-09-14").concat(week("2026-09-21"))) {
  const rows = [], whole = [];
  for (const d of days) {
    const fam = familyRows(36, d, THIS).filter((r) => axes.includes(r.axis));
    rows.push(...fam.map(({ yearid, syncedAt, ...r }) => r));
    whole.push({ date: d, members: 612, absentDays: familyRows(36, d, THIS).filter((r) => r.axis === "gender").reduce((n, r) => n + r.absentDays, 0) });
  }
  return { yearid: 36, month: "2026-09", syncedAt: "2026-10-12T10:15:00.000Z", axes, schoolDays: days, whole, days: rows, skipped: [] };
}
const DAYS20 = ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"].flatMap((w) => week(w))
  .filter((d) => d.startsWith("2026-09")).slice(0, 20);
suite.replaceClean = async (Mx) => {
  // 240 stale rows: a month of every axis (20 days x 12), built the night before.
  const tables = { attendanceRunGroupDays: [], attendanceRunGroupMonths: [] };
  for (const d of DAYS20) {
    for (const r of familyRows(36, d, THIS)) tables.attendanceRunGroupDays.push({ _id: "old" + Math.random(), ...r, syncedAt: "old" });
  }
  // ...and a row of another month, which must survive.
  tables.attendanceRunGroupDays.push({ _id: "aug", ...storedRow(36, "2026-08-31", "gender", "F", 297, 9), syncedAt: "old" });
  const db = fakeDb(tables);
  const before = tables.attendanceRunGroupDays.length;
  await Mx.query.replaceGroupMonth.handler({ db }, monthPayload(Mx.groups.AXES, DAYS20));
  const left = tables.attendanceRunGroupDays;
  return before === 241 && left.filter((r) => r.syncedAt === "old").length === 1 && left.find((r) => r._id === "aug")
    && left.length === 1 + 240 && left.every((r) => r.syncedAt === "old" || r.syncedAt === "2026-10-12T10:15:00.000Z");
};
{
  check("replacing a month of 240 stored rows leaves none of them behind, and another month untouched", await suite.replaceClean(M));
  // Only the axes built are replaced: a skipped race read keeps last night's Black line.
  const tables = { attendanceRunGroupDays: [], attendanceRunGroupMonths: [] };
  for (const d of week("2026-09-14")) for (const r of familyRows(36, d, THIS)) tables.attendanceRunGroupDays.push({ _id: "o" + Math.random(), ...r, syncedAt: "old" });
  const db = fakeDb(tables);
  const p = monthPayload(["gender", "el", "ela"], week("2026-09-14"));
  p.skipped = [{ axis: "race", reason: "Race codes could not be read: HTTP 403" }];
  await M.query.replaceGroupMonth.handler({ db }, p);
  const race = tables.attendanceRunGroupDays.filter((r) => r.axis === "race");
  check("an axis that was skipped keeps its stored rows; the others are replaced",
    race.length === 10 && race.every((r) => r.syncedAt === "old")
      && tables.attendanceRunGroupDays.filter((r) => r.axis !== "race").every((r) => r.syncedAt !== "old"));
  const st = tables.attendanceRunGroupMonths[0];
  check("...and the month's status says what was built and what was skipped, and why",
    st && st.built.map((b) => b.axis).sort().join(",") === "el,ela,gender" && st.skipped.length === 1 && /403/.test(st.skipped[0].reason));
  const refuse = async (mut, why) => {
    const t = { attendanceRunGroupDays: [{ _id: "keep", ...storedRow(36, "2026-09-14", "gender", "F", 1, 0) }], attendanceRunGroupMonths: [] };
    const d2 = fakeDb(t);
    const pay = monthPayload(M.groups.AXES, week("2026-09-14"));
    mut(pay);
    try { await M.query.replaceGroupMonth.handler({ db: d2 }, pay); return { threw: false }; }
    catch (e) { return { threw: why.test(String(e.message)), deletes: d2.writes.filter((w) => w[0] === "delete").length, msg: e.message }; }
  };
  const r1 = await refuse((p) => { p.days.find((r) => r.axis === "gender" && r.group === "F").members += 1; }, /do not add up/);
  check("rows that do not add up to the whole school are refused, and nothing is deleted first", r1.threw && r1.deletes === 0, JSON.stringify(r1));
  const r2 = await refuse((p) => { p.days.splice(p.days.findIndex((r) => r.axis === "race" && r.group === "none"), 1); }, /missing a group row/);
  check("an axis missing a row on a school day (its 'none' row) is refused", r2.threw && r2.deletes === 0, JSON.stringify(r2));
  const r3 = await refuse((p) => { p.axes = ["gender", "el"]; p.days = p.days.filter((r) => r.axis !== "ela" && r.axis !== "race"); }, /written together/);
  check("English Learner without the classification (they share rows) is refused", r3.threw);
  const r4 = await refuse((p) => { p.days.push({ ...p.days[0] }); }, /repeated/);
  check("a repeated row is refused", r4.threw);
  check("the group rows and their 'none' rows are written by ONE mutation",
    (SRC.action.match(/attendanceGroupRunChart\.replaceGroupMonth/g) || []).length === 1 && /days: g\.groupDays/.test(SRC.action));
}

// ===========================================================================
console.log("\nTHE NIGHTLY BUILD: BANDS FIRST AND UNTOUCHED, EACH DEMOGRAPHIC READ ON ITS OWN\n");
// ===========================================================================
// The real action, against a fake PowerSchool built from the fixture.
const NOW = Date.parse("2026-10-12T10:15:00Z");
function powerschool(fx, opts = {}) {
  const calls = [];
  const readTable = async (host, tok, table, q, projection) => {
    calls.push({ table, q, projection });
    const ok = (rows) => ({ rows, pages: 1, pagedOut: false });
    if (opts.fail && opts.fail(table, q, projection)) throw new Error(`${table} read failed on page 1: HTTP 403`);
    if (table === "terms") return ok([{ id: "3600", firstday: "2026-08-12", lastday: "2027-06-04", isyearrec: "1" }]);
    if (table === "attendance_code") return ok([{ id: "A", presence_status_cd: "Absent" }, { id: "P", presence_status_cd: "Present" }]);
    if (table === "cc") return ok(/termid=ge=-/.test(q) ? [] : fx.cc);
    if (table === "attendance") return ok(fx.attendance);
    if (table === "students") {
      const away = new Set(opts.away || []);
      const one = /^id==(\d+)$/.exec(q);
      const pick = one ? fx.students.filter((s) => s.id === one[1]) : fx.students.filter((s) => !away.has(s.id));
      if (projection === "id,grade_level,enroll_status,entrydate") return ok(pick);
      if (projection === "id,dcid,gender,fedethnicity") {
        return ok(pick.map((s) => ({ id: s.id, dcid: "5" + s.id, gender: fx.demo.get(s.id).gender, fedethnicity: fx.demo.get(s.id).fedEthnicity })));
      }
      throw new Error("unexpected students projection " + projection);
    }
    if (table === "studentrace") {
      const sid = /^studentid==(\d+)$/.exec(q)[1];
      return ok((fx.demo.get(sid)?.raceCodes || []).map((racecd) => ({ studentid: sid, racecd })));
    }
    if (table === "s_ca_stu_ela_c") {
      const rows = [];
      for (const [sid, d] of fx.demo) for (const h of d.elaHistory || []) rows.push({ studentsdcid: "5" + sid, elastatus: h.status, elastatusstartdate: h.start });
      return ok(rows);
    }
    throw new Error("unexpected table " + table);
  };
  return { readTable, calls };
}
const internalRef = new Proxy({}, { get: (_, mod) => new Proxy({}, { get: (_, fn) => `${String(mod)}.${String(fn)}` }) });
function loadAction(ps, src = SRC.action, Mx = M) {
  const prelude = `const Date = class extends globalThis.Date { constructor(...a) { super(...(a.length ? a : [${NOW}])); } static now() { return ${NOW}; } };\n`;
  return load(src, {
    "./_generated/server": { internalAction: (d) => d },
    "./_generated/api": { internal: internalRef },
    "convex/values": { v: vStub },
    "./attendanceDays": { token: async () => "tok", readTable: ps.readTable },
    "./runChartDays": Mx.days, "./runChartGroups": Mx.groups,
  }, prelude);
}
const ENV = { PS_HOST: "ps.example", PS_CLIENT_ID: "id", PS_CLIENT_SECRET: "secret", PS_SCHOOL_ID: "100", PS_YEAR_ID: "36" };
async function runAction(name, args, { ps = powerschool(FX), queries = {}, src, Mx } = {}) {
  const saved = {};
  for (const k of Object.keys(ENV)) { saved[k] = process.env[k]; process.env[k] = ENV[k]; }
  const mutations = [], scheduled = [];
  const ctx = {
    runMutation: async (ref, a) => { mutations.push({ ref, args: a }); return {}; },
    runQuery: async (ref, a) => (queries[ref] ? queries[ref](a) : []),
    scheduler: { runAfter: async (ms, ref, a) => { scheduled.push({ ms, ref, args: a }); } },
  };
  try {
    const A = loadAction(ps, src, Mx);
    const res = await A[name].handler(ctx, args);
    return { res, mutations, scheduled, calls: ps.calls };
  } finally {
    for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
suite.groupsOnly = async (src) => {
  const go = await runAction("buildMonth", { yearid: 35, month: "2026-09", groupsOnly: true }, { src });
  return go.mutations.map((m) => m.ref).join(",") === "attendanceGroupRunChart.replaceGroupMonth" && go.res.groupsOnly === true;
};
suite.backfillSays = async (src) => {
  const none = await runAction("backfillYear", { yearid: 35 }, { src });
  const both = await runAction("backfillYear", { yearid: 35, groupsOnly: true, rewriteBands: true }, { src });
  const gOnly = await runAction("backfillYear", { yearid: 35, groupsOnly: true }, { src });
  return none.res.ok === false && both.res.ok === false && none.scheduled.length === 0 && both.scheduled.length === 0
    && gOnly.scheduled.length > 0 && gOnly.scheduled.every((x) => x.args.groupsOnly === true);
};
suite.isolation = async (Mx, src) => {
  const plain = await runAction("buildMonth", { yearid: 36, month: "2026-09" }, { Mx, src });
  const bandArgs = plain.mutations.find((m) => m.ref === "attendanceRunChartData.replaceMonth");
  const race = await runAction("buildMonth", { yearid: 36, month: "2026-09" }, { Mx, src, ps: powerschool(FX, { fail: (t) => t === "studentrace" }) });
  const raceBand = race.mutations.find((m) => m.ref === "attendanceRunChartData.replaceMonth");
  const raceGroup = race.mutations.find((m) => m.ref === "attendanceGroupRunChart.replaceGroupMonth");
  const demo = await runAction("buildMonth", { yearid: 36, month: "2026-09" }, { Mx, src,
    ps: powerschool(FX, { fail: (t, q, p) => t === "students" && p === "id,dcid,gender,fedethnicity" }) });
  const demoBand = demo.mutations.find((m) => m.ref === "attendanceRunChartData.replaceMonth");
  const demoGroup = demo.mutations.find((m) => m.ref === "attendanceGroupRunChart.replaceGroupMonth");
  const ela = await runAction("buildMonth", { yearid: 36, month: "2026-09" }, { Mx, src, ps: powerschool(FX, { fail: (t) => t === "s_ca_stu_ela_c" }) });
  const elaGroup = ela.mutations.find((m) => m.ref === "attendanceGroupRunChart.replaceGroupMonth");
  const sameBand = (m) => m && JSON.stringify({ ...m.args, syncedAt: 0 }) === JSON.stringify({ ...bandArgs.args, syncedAt: 0 });
  return sameBand(raceBand) && sameBand(demoBand)
    && raceGroup.args.axes.join(",") === "gender,el,ela" && raceGroup.args.skipped[0].axis === "race" && /HTTP 403/.test(raceGroup.args.skipped[0].reason)
    && demoGroup.args.axes.length === 0 && demoGroup.args.days.length === 0 && demoGroup.args.skipped.length === 4
    && elaGroup.args.axes.join(",") === "gender,race" && elaGroup.args.skipped.map((s) => s.axis).join(",") === "el,ela";
};
{
  const run = await runAction("buildMonth", { yearid: 36, month: "2026-09" });
  const order = run.mutations.map((m) => m.ref);
  check("the nightly build writes the band rows FIRST, then the group rows",
    order.join(",") === "attendanceRunChartData.replaceMonth,attendanceGroupRunChart.replaceGroupMonth", order.join(","));
  const band = run.mutations[0].args, grp = run.mutations[1].args;
  const plain = M.days.buildRunDays({ ...baseInput, from: "2026-09-01", to: "2026-09-30" });
  check("...the band rows are exactly the plain build's (no group key reaches attendanceRunDays)",
    JSON.stringify(band.days) === JSON.stringify(plain.days) && JSON.stringify(band.months) === JSON.stringify(plain.months)
      && !JSON.stringify(band).includes("axis"));
  check("...and the group write carries every axis, the school days, and the whole school to add up to",
    grp.axes.join(",") === "gender,race,el,ela" && grp.schoolDays.length === 10 && grp.whole.length === 10
      && grp.days.length === 10 * 12 && grp.skipped.length === 0);
  const raceCalls = run.calls.filter((c) => c.table === "studentrace").map((c) => c.q.replace("studentid==", ""));
  const want = [...M.days.seatedStudents(FX.cc)].filter((sid) => FX.demo.get(sid).fedEthnicity !== "1");
  check("race codes are looked up only for students who sat a class AND are not Hispanic, one id each",
    raceCalls.length === want.length && want.every((s) => raceCalls.includes(s)) && raceCalls.length === 8, raceCalls.join(","));
  check("the band students read is unchanged (no demographic field on it); demographics are a read of their own",
    run.calls.filter((c) => c.table === "students" && /schoolid==/.test(c.q)).map((c) => c.projection).join("|")
      === "id,grade_level,enroll_status,entrydate|id,dcid,gender,fedethnicity");
  check("a failed race read skips RACE only; a failed students read skips every group; a failed history skips English Learner "
    + "and the classification -- and the band rows are written, identical, every time", await suite.isolation(M));

  const away = await runAction("buildMonth", { yearid: 36, month: "2026-09" }, { ps: powerschool(FX, { away: ["1007", "1020"] }) });
  const ag = away.mutations.find((m) => m.ref === "attendanceGroupRunChart.replaceGroupMonth").args;
  check("students who have moved away are looked up by id for their demographics too, and still add up",
    ag.axes.length === 4 && away.calls.filter((c) => c.table === "students" && c.projection === "id,dcid,gender,fedethnicity" && /^id==/.test(c.q)).length === 2);

  check("groupsOnly writes the group rows and NEVER the band rows (how last year's group lines are filled)", await suite.groupsOnly(SRC.action));

  const dry = await runAction("buildMonth", { yearid: 36, month: "2026-09", dryRun: true });
  check("a dry run writes nothing and says whether every axis adds up", dry.mutations.length === 0
    && Object.values(dry.res.groups.addsUp).length === 4 && Object.values(dry.res.groups.addsUp).every(Boolean));
  const figs = JSON.stringify(dry.res.groups.typical);
  check("the dry run's group figures hold no small group's number: under 30 is 'under 30', the rest rounded to 5",
    Object.values(dry.res.groups.typical).every((t) => t === "under 30" || (t >= 30 && t % 5 === 0)) && /under 30/.test(figs)
      && Number.isInteger(dry.res.groups.reads.raceLookups / 10), figs);
  check("...and the existing dry-run keys are all still there for the back-to-back comparison",
    ["ok", "yearid", "month", "from", "to", "schoolDays", "dayRows", "monthRows", "diagnostics", "reads", "movedAway", "dryRun", "sample", "months"]
      .every((k) => k in dry.res));

  // A group write that throws does not fail the build (its bands are written).
  const boom = await runAction("buildMonth", { yearid: 36, month: "2026-09" }, {
    ps: powerschool(FX), queries: {},
  });
  check("the group summary is part of the answer, never instead of it", boom.res.ok === true && boom.res.groups && boom.res.dayRows === plain.days.length);

  // THE BACKFILL MUST SAY WHICH ROWS.
  const none = await runAction("backfillYear", { yearid: 35 });
  const both = await runAction("backfillYear", { yearid: 35, groupsOnly: true, rewriteBands: true });
  const gOnly = await runAction("backfillYear", { yearid: 35, groupsOnly: true });
  const bands = await runAction("backfillYear", { yearid: 35, rewriteBands: true });
  check("a backfill that does not say which rows is refused, and so is one that says both; nothing is scheduled",
    none.res.ok === false && both.res.ok === false && none.scheduled.length === 0 && both.scheduled.length === 0
      && await suite.backfillSays(SRC.action));
  check("groupsOnly: every month scheduled with groupsOnly; rewriteBands: without it",
    gOnly.scheduled.length > 0 && gOnly.scheduled.every((s) => s.args.groupsOnly === true)
      && bands.scheduled.length > 0 && bands.scheduled.every((s) => !("groupsOnly" in s.args)));

  // THE NIGHTLY MEND: group months missing an axis, groups only, two a night.
  const all4 = ["gender", "race", "el", "ela"];
  const nightly = await runAction("refreshCurrent", {}, { queries: {
    "attendanceRunChartData.monthsPresent": () => ["2026-08", "2026-09", "2026-10", "2026-07"],
    "attendanceGroupRunChart.groupMonthsStatus": () => [
      { month: "2026-08", built: ["gender", "el", "ela"] }, { month: "2026-10", built: all4 }, { month: "2026-07", built: [] },
    ],
  } });
  const sch = nightly.scheduled;
  const bandRuns = sch.filter((s) => !s.args.groupsOnly).map((s) => s.args.month);
  const groupRuns = sch.filter((s) => s.args.groupsOnly).map((s) => s.args.month);
  check("the nightly run still rebuilds this month in full (bands and groups)", bandRuns.includes("2026-10"));
  check("...and mends group months missing an axis for their GROUPS ONLY, oldest first, two a night, never this month",
    groupRuns.join(",") === "2026-07,2026-08" && sch.filter((s) => s.args.groupsOnly).every((s) => s.args.onlyWhileOpen === true),
    JSON.stringify(sch.map((s) => s.args)));
  check("...after every band month, so a mend never runs first", Math.min(...sch.filter((s) => s.args.groupsOnly).map((s) => s.ms))
    > Math.max(...sch.filter((s) => !s.args.groupsOnly).map((s) => s.ms)));
}

// ===========================================================================
console.log("\nGOVERNANCE: THE APPROVAL IS ON RECORD, AND NOTHING ELSE WAS WIDENED\n");
// ===========================================================================
{
  const flat = approval.replace(/\n>\s?/g, " ").replace(/\s+/g, " ");
  check("docs/field-sourcing-approval.md records the owner's 2026-10-11 decision, in his words",
    /### Added 2026-10-11: the weekly attendance run charts by group/.test(approval)
      && flat.includes("\"Attendance run charts by group: EL/classification and gender aggregates for admin/superadmin/PBIS; "
        + "race (Black) line for admin/superadmin only; gender only for the Attendance Watch grant; floor 30; no individual figures; "
        + "printing allowed for the same roles.\""));
  check("...and an individual's English Learner status is still NOT approved for anyone",
    /\*\*An individual student's status: NOT approved\.\*\*/.test(approval));
  check("restrictedPolicy.ts is untouched: PBIS holds no restricted field, and no role holds elaStatus",
    /pbis: \[\],/.test(policySrc) && /admin: \["fedEthnicity", "raceCodes"\],/.test(policySrc) && !/: \[[^\]]*"elaStatus"/.test(policySrc));
  const restricted = schemaSrc.slice(schemaSrc.indexOf("RESTRICTED demographics"), schemaSrc.indexOf("psRestricted: defineTable"));
  check("the schema comment no longer says no query reads English Learner, and names the aggregate approval",
    !/no query in this codebase returns\s+it\./.test(restricted) && /APPROVED AS AN AGGREGATE ONLY/.test(restricted)
      && /2026-10-11/.test(restricted));
}

// ===========================================================================
console.log("\nNO TWO ANSWERS SUBTRACT TO LESS THAN ONE FINISHED WEEK (review, 2026-10-12)\n");
// ===========================================================================
// THE ATTACK: ask for the week in progress each morning (one more day in it
// each time), or for a short week merged and separately, and subtract. On a
// group of ~115 with rates to 0.1, that gave the EXACT number of English
// Learners out a whole day, every day. A week is now served only once no
// build can add a day to it, and only with at least 2 school days.
/** `world()` as it stood on the morning of `morning`: rows through the day before; October's builds stamped that morning. */
function asOfMorning(morning, tweak) {
  const t = world(tweak);
  const keep = (r) => r.date < morning;
  const stamp = (r) => (r.date.startsWith(morning.slice(0, 7)) ? { ...r, syncedAt: morning + "T10:15:00.000Z" } : r);
  t.attendanceRunDays = t.attendanceRunDays.filter(keep).map(stamp);
  t.attendanceRunGroupDays = t.attendanceRunGroupDays.filter(keep).map(stamp);
  return t;
}
suite.mornings = async (Mx) => {
  // The week of 10/5 as it was built: Tuesday morning holds Monday, ...,
  // Saturday morning holds the whole week. The weeks before it are finished.
  const W = THIS_WEEKS[7], W1 = THIS_WEEKS[6], W2 = THIS_WEEKS[5];
  const asks = [[[W]], [[W1, W]], [[W2, W1, W]], [[W1]], [[W2], [W1]], [[W2, W1]]];
  const seen = new Map();       // the weeks asked -> the values served, morning by morning
  const out = { ok: true, why: [] };
  for (let k = 1; k <= 5; k++) {
    const tables = asOfMorning(addDays(W, k));
    for (const p of asks) {
      for (const g of ["el:el", "gender:F", "ela:EO"]) {
        const res = (await ask(Mx, PBIS, { group: g, periods: p }, tables)).res;
        res.periods.forEach((a, i) => {
          const weeks = p[i].join("+");
          const hasW = p[i].includes(W);
          // A period holding the unfinished week is never served until the week is whole.
          if (hasW && k < 5 && (a.value !== null || a.withheld !== "open")) { out.ok = false; out.why.push(`${g} ${weeks} morning ${k}: ${JSON.stringify(a)}`); }
          if (!hasW && a.value === null) { out.ok = false; out.why.push(`${g} ${weeks} morning ${k}: a finished week withheld`); }
          const key = g + "|" + weeks;
          if (!seen.has(key)) seen.set(key, new Set());
          if (a.value !== null) seen.get(key).add(a.value);
        });
      }
    }
  }
  // Every period is served with ONE value across the mornings: nothing to subtract.
  for (const [k, vals] of seen) if (vals.size > 1) { out.ok = false; out.why.push(`${k} served ${[...vals].join(" and ")}`); }
  return out;
};
suite.monthEdge = async (Mx) => {
  // September's last build ran on the morning of 9/30 (through 9/29) and its
  // first-week rebuilds all failed; October is built through 10/10. The
  // week of 9/28 must wait: a later September build would add 9/30 to it.
  const t = world();
  t.attendanceRunDays = t.attendanceRunDays.filter((r) => r.date !== "2026-09-30")
    .map((r) => (r.date.startsWith("2026-09") ? { ...r, syncedAt: "2026-09-30T10:15:00.000Z" } : r));
  t.attendanceRunGroupDays = t.attendanceRunGroupDays.filter((r) => r.date !== "2026-09-30")
    .map((r) => (r.date.startsWith("2026-09") ? { ...r, syncedAt: "2026-09-30T10:15:00.000Z" } : r));
  const res = (await ask(Mx, ADMIN, { group: "gender:F", periods: [[THIS_WEEKS[5]], [THIS_WEEKS[6]]] }, t)).res;
  return res.periods[0].withheld === null && res.periods[1].withheld === "open";
};
{
  const m = await suite.mornings(M);
  check("asked every morning of a week, alone or with the weeks before it, the week in progress is never served; "
    + "every finished period has ONE value all week -- no two answers subtract to a day", m.ok, m.why.slice(0, 3).join("; "));
  // The repro, decoded the attacker's way: Wednesday's 2-day rate less
  // Tuesday's 1-day rate. With the week withheld there is nothing to decode.
  const tue = (await ask(M, PBIS, { group: "el:el", periods: [[THIS_WEEKS[7]]] }, asOfMorning(addDays(THIS_WEEKS[7], 2)))).res.periods[0];
  check("...the repro's Wednesday ask (two built days of the week in progress) is withheld as 'open'", tue.value === null && tue.withheld === "open");
  check("a week touching a month whose last build stopped short of it waits, though a later month is built", await suite.monthEdge(M));
  // A FRIDAY OFF (no Trends row for it) still finishes the week once the
  // Saturday build has run: the week is not stuck open.
  const fri = world();
  const off = addDays(THIS_WEEKS[7], 4);
  fri.attendanceRunDays = fri.attendanceRunDays.filter((r) => r.date !== off);
  fri.attendanceRunGroupDays = fri.attendanceRunGroupDays.filter((r) => r.date !== off);
  const f = (await ask(M, ADMIN, { group: "gender:F", periods: [[THIS_WEEKS[7]]] }, fri)).res.periods[0];
  check("a week whose Friday is a holiday is served once its month's build has passed the Friday", typeof f.value === "number" && f.withheld === null);
  // A WEEK STARTING IN A MONTH WITH NO SCHOOL DAYS (a year opening on Tuesday
  // 9/1): August has no Trends rows, so the newest build decides it.
  const sep = world();
  sep.attendanceRunDays = sep.attendanceRunDays.filter((r) => r.yearid !== 36 || r.date >= "2026-09-01");
  sep.attendanceRunGroupDays = sep.attendanceRunGroupDays.filter((r) => r.yearid !== 36 || r.date >= "2026-09-01");
  const s1 = (await ask(M, ADMIN, { group: "gender:F", periods: [["2026-08-31"]] }, sep)).res.periods[0];
  check("a week whose Monday falls in a month with no school days is not stuck open", typeof s1.value === "number");
  check("the clock is the server's own (Los Angeles), never the browser's: no 'today' argument exists",
    /today: laDayOf\(Date\.now\(\)\)!/.test(SRC.query) && !/a\.today|args\.today/.test(SRC.query));
}

// ===========================================================================
console.log("\nTHE FLOOR OF 30 HOLDS FOR WHAT CAN BE WORKED OUT, NOT ONLY FOR WHAT IS DRAWN (review, 2026-10-12)\n");
// ===========================================================================
// As measured this year: nobody pending assessment on most days, IFEP 28.
// Current EL, Not EL, English Only and RFEP beside the whole school (Trends)
// subtract to exactly the IFEP students.
const PROD_LIKE = (d, c) => { c.EO += c.TBD; c.TBD = 0; };
suite.pbisPool = async (Mx) => {
  const res = (await ask(Mx, PBIS, {}, world(PROD_LIKE))).res;
  return res.groups.map((g) => g.id).join(",") === "gender:F,gender:M,el:el,el:notel,ela:EO,ela:EL"
    && res.unavailable.some((u) => u.group === "Reclassified fluent (RFEP)" && /fewer than 30 students be worked out by subtraction/.test(u.reason));
};
suite.adminListProd = async (Mx) => (await ask(Mx, ADMIN, {}, world(PROD_LIKE))).res.groups.map((g) => g.id).join(",")
  === "gender:F,gender:M,race:black,el:el,el:notel,ela:EO,ela:EL";
/** Every sum and difference (coefficients -2..2) of these lines and the whole school: the smallest pool of 1..floor-1, or null. */
function smallestPool(cells, lines, floor) {
  const keys = [...cells.keys()];
  const vecs = [keys.map(() => 1), ...lines.map((l) => keys.map((k) => (l.includes(k) ? 1 : 0)))];
  const coef = new Array(vecs.length).fill(-2);
  let best = null;
  for (;;) {
    let pool = 0, ok = true;
    for (let k = 0; k < keys.length; k++) {
      let s = 0;
      for (let j = 0; j < vecs.length; j++) s += coef[j] * vecs[j][k];
      if (s !== 0 && s !== 1) { ok = false; break; }
      if (s === 1) pool += cells.get(keys[k]);
    }
    if (ok && pool > 0 && pool < floor) best = best === null ? pool : Math.min(best, pool);
    let j = 0;
    while (j < coef.length && coef[j] === 2) coef[j++] = -2;
    if (j === coef.length) break;
    coef[j]++;
  }
  return best;
}
suite.poolBrute = (Mx) => {
  // Random typical years of the English Learner family: whatever linesForYear
  // keeps, no sum or difference of it and the whole school is a group of
  // 1 to 29 students -- and where the lines offered DO isolate one, the rank
  // test said so.
  let seed = 777;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const CELLS = ["EL", "EO", "RFEP", "IFEP", "TBD", "NOREC"];
  const LINES = { "el:el": ["EL"], "el:notel": ["EO", "RFEP", "IFEP", "TBD"], "ela:EO": ["EO"], "ela:RFEP": ["RFEP"], "ela:IFEP": ["IFEP"] };
  let leaks = 0, missed = 0, cases = 0;
  for (let t = 0; t < 200; t++) {
    const size = Object.fromEntries(CELLS.map((c) => [c, [0, 0, 2, 5, 12, 19, 28, 31, 45, 120, 268][rnd(11)]]));
    // A school under 30 is its own small pool, on Trends: not this card's to guard.
    if (CELLS.reduce((n, c) => n + size[c], 0) < 30) continue;
    const rows = [];
    for (const d of ["2026-09-14", "2026-09-15", "2026-09-16"]) {
      const r = (axis, group, n) => storedRow(36, d, axis, group, n, 0);
      rows.push(r("el", "el", size.EL), r("el", "notel", size.EO + size.RFEP + size.IFEP + size.TBD), r("el", "none", size.NOREC),
        r("ela", "EO", size.EO), r("ela", "RFEP", size.RFEP), r("ela", "IFEP", size.IFEP), r("ela", "none", size.TBD + size.NOREC));
    }
    const offered = Object.keys(LINES).filter(() => rnd(4) > 0);
    const { kept } = Mx.groups.linesForYear("el", rows, offered);
    const cells = new Map(CELLS.filter((c) => size[c] > 0).map((c) => [c, size[c]]));
    cases++;
    if (smallestPool(cells, kept.map((r) => LINES[r]), 30) !== null) leaks++;
    for (const r of kept) if (size[LINES[r][0]] !== undefined && LINES[r].reduce((n, c) => n + size[c], 0) < 30) leaks++;
    if (smallestPool(cells, offered.map((r) => LINES[r]), 30) !== null
      && !Mx.groups.exposesSmall(cells, offered.map((r) => LINES[r]), 30)) missed++;
  }
  return { ok: leaks === 0 && missed === 0, leaks, missed, cases };
};
{
  const pb = (await ask(M, PBIS, {}, world(PROD_LIKE))).res;
  check("this year as measured (IFEP 28, nobody pending): PBIS is offered Current EL, Not EL and English Only -- RFEP goes, "
    + "because with it the lines subtract to the IFEP students -- and RFEP says why", await suite.pbisPool(M),
    pb.groups.map((g) => g.id).join(","));
  const cells = M.groups.typicalCells("el", world(PROD_LIKE).attendanceRunGroupDays.filter((r) => r.yearid === 36));
  const LINES = { "el:el": ["EL"], "el:notel": ["EO", "RFEP", "IFEP", "TBD"], "ela:EO": ["EO"], "ela:RFEP": ["RFEP"] };
  check("...the reviewer's subtraction (whole - EL - EO - RFEP) is no longer possible from what PBIS is served: "
    + "no sum or difference of its lines and the whole school is under 30",
    smallestPool(cells, pb.groups.filter((g) => g.type !== "gender").map((g) => LINES[M.groups.SERIES.find((s) => s.id === g.id).row]), 30) === null
      && smallestPool(cells, Object.values(LINES), 30) === 28);
  const rf = (await ask(M, PBIS, { group: "ela:RFEP", periods: [[THIS_WEEKS[4]]] }, world(PROD_LIKE))).res;
  check("...and asking for RFEP anyway is refused, with no rate", rf.refused && rf.periods.length === 0);
  const bf = suite.poolBrute(M);
  check(`a brute-force reader finds no pool of 1-29 students in the lines kept, over ${bf.cases} random years (and the rank test misses none)`,
    bf.ok, JSON.stringify(bf));
  // LAST YEAR IS HELD TO LAST YEAR'S SIZES. This year (2 pending on a
  // typical day) keeps all four lines; last year (IFEP 19, nobody pending)
  // they subtract to the IFEP students, so last year's RFEP weeks go.
  const lastRfep = (await ask(M, ADMIN, { group: "ela:RFEP", periods: LAST_WEEKS.map((w) => [w]) })).res;
  const lastEo = (await ask(M, ADMIN, { group: "ela:EO", periods: LAST_WEEKS.map((w) => [w]) })).res;
  const thisRfep = (await ask(M, ADMIN, { group: "ela:RFEP", periods: [[THIS_WEEKS[4]]] })).res;
  check("last year's weeks are judged on last year's own figures: RFEP held back there, English Only served, RFEP served this year",
    lastRfep.periods.every((p) => p.withheld === "small") && lastEo.periods.every((p) => typeof p.value === "number")
      && typeof thisRfep.periods[0].value === "number");
}

// ===========================================================================
console.log("\nTHE GAP TO THE REST OF THE SCHOOL: THIS YEAR'S, AND WITHIN CHANCE ONLY WHEN IT IS (review, 2026-10-12)\n");
// ===========================================================================
{
  // A NEW YEAR WITH NO FINISHED WEEK: last year in full, this year two days.
  // The morning of Wednesday 8/19: this year holds Monday and Tuesday.
  const t = asOfMorning("2026-08-19");
  const early = (await ask(M, ADMIN, { group: "race:black", periods: [...LAST_WEEKS.map((w) => [w]), [THIS_WEEKS[0]]] }, t)).res;
  check("a new year with no finished week has NO gap to report -- never last year's, quoted as this year's reading",
    t.attendanceRunGroupDays.some((r) => r.yearid === 36) && early.vsRest === null && early.periods[4].withheld === "open"
      && early.periods.slice(0, 4).every((p) => typeof p.value === "number"), JSON.stringify(early.vsRest));
  const later = (await ask(M, ADMIN, { group: "race:black", periods: [...LAST_WEEKS, ...THIS_WEEKS.slice(0, 3)].map((w) => [w]) })).res;
  check("...and once this year has weeks, the gap is this year's only (3 weeks, not 7)", later.vsRest && later.vsRest.yearid === 36 && later.vsRest.periods === 3);
}
// THE CHANCE BAND, CALIBRATED: groups of 47 drawn at random from a school
// of 610 with NO true difference. Student propensities follow Beta(0.918,
// 10.552), fitted to the measured September (8.0% whole days, 39% chronic);
// then all students alike. The spread is what the build stores (rateSpread
// of one simulated month); the gaps are weekly, as served.
function chanceSim(Mx, { a, b, weeks, trials, shift = 0, seed = 99 }) {
  let st = seed;
  const rnd = () => { st = (st * 1103515245 + 12345) % 2147483648; return st / 2147483648; };
  const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const gamma = (k) => { if (k < 1) return gamma(k + 1) * Math.pow(rnd(), 1 / k); const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) { let x, v; do { x = gauss(); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = rnd();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; } };
  const N = 610, G = 47;
  const p = Array.from({ length: N }, () => { const x = gamma(a), y = gamma(b); return x / (x + y); });
  const tallies = p.map((q) => { let f = 0; for (let d = 0; d < 20; d++) if (rnd() < q) f++; return { memberDays: 20, fullDays: f }; });
  const spread = Mx.days.rateSpread(tallies);
  let flagged = 0, said = 0;
  for (let t = 0; t < trials; t++) {
    const idx = Array.from({ length: N }, (_, i) => i);
    for (let i = N - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    const inG = new Uint8Array(N);
    for (let i = 0; i < G; i++) inG[idx[i]] = 1;
    const gaps = [];
    for (let w = 0; w < weeks; w++) {
      let gf = 0, rf = 0;
      for (let i = 0; i < N; i++) { const q = Math.min(1, p[i] + (inG[i] ? shift : 0)); for (let d = 0; d < 5; d++) if (rnd() < q) (inG[i] ? gf++ : rf++); }
      gaps.push(((1 - gf / (G * 5)) - (1 - rf / ((N - G) * 5))) * 100);
    }
    const v = Mx.groups.gapWithinChance(gaps, G, N - G, spread);
    if (v !== null) { said++; if (v === false) flagged++; }
  }
  return { rate: flagged / said, said, spread };
}
suite.calibrated = (Mx) => {
  const out = [];
  for (const [a, b] of [[0.918, 10.552], [1000, 12333]]) for (const weeks of [3, 5, 9]) {
    const r = chanceSim(Mx, { a, b, weeks, trials: 300 });
    out.push({ a, weeks, rate: +r.rate.toFixed(3) });
  }
  return { ok: out.every((r) => r.rate <= 0.07), out };
};
suite.power = (Mx) => {
  const r = chanceSim(Mx, { a: 0.918, b: 10.552, weeks: 9, trials: 200, shift: 0.06, seed: 7 });
  return { ok: r.rate >= 0.7, rate: r.rate };
};
{
  const cal = suite.calibrated(M);
  check("random groups of 47 with NO true difference are called 'more than chance' at most 7% of the time "
    + "(3, 5 and 9 weeks; chronic absentees and alike students) -- the old test said so about 30% of the time", cal.ok, JSON.stringify(cal.out));
  const pw = suite.power(M);
  check("...and a group truly 6 points worse IS called more than chance most of the time (9 weeks)", pw.ok, JSON.stringify(pw));
  const spread = chanceSim(M, { a: 0.918, b: 10.552, weeks: 3, trials: 1 }).spread;
  check("the reviewer's example (weekly gaps -1, -2, -3 in a group of 47) is within chance for a group that size",
    M.groups.gapWithinChance([-1, -2, -3], 47, 563, spread) === true);
  check("...and nothing is said with fewer than 3 weeks, or before a spread is built",
    M.groups.gapWithinChance([-5, -6], 47, 563, spread) === null && M.groups.gapWithinChance([-5, -6, -7], 47, 563, null) === null);
  // THE SPREAD, END TO END: the group build computes it, the write keeps it,
  // the answer uses it -- and the plain band build never sees it.
  const g = withGroups(M);
  const t30 = [{ memberDays: 10, fullDays: 2 }, { memberDays: 20, fullDays: 2 }, ...Array.from({ length: 28 }, () => ({ memberDays: 10, fullDays: 0 }))];
  const r30 = [0.2, 0.1, ...new Array(28).fill(0)];
  const mean = r30.reduce((a, b) => a + b, 0) / 30;
  const want = r30.reduce((a, r) => a + (r - mean) ** 2, 0) / 29;
  check("rateSpread is the variance across students of their month's whole-day rate; under 10 days enrolled is left out; under 30 students, none",
    Math.abs(M.days.rateSpread(t30) - want) < 1e-15
      && Math.abs(M.days.rateSpread([...t30, { memberDays: 9, fullDays: 9 }]) - want) < 1e-15
      && M.days.rateSpread(t30.slice(1)) === null);
  check("the group build returns the school's spread of monthly rates; the plain build has no such key",
    typeof g.rateSpread === "number" && g.rateSpread >= 0 && !("rateSpread" in M.days.buildRunDays(baseInput)));
  const run = await runAction("buildMonth", { yearid: 36, month: "2026-09" });
  const gw = run.mutations.find((m) => m.ref === "attendanceGroupRunChart.replaceGroupMonth").args;
  check("...the nightly build passes it with the group rows", typeof gw.rateVar === "number" && Math.abs(gw.rateVar - g.rateSpread) < 1e-12);
  const tables = { attendanceRunGroupDays: [], attendanceRunGroupMonths: [] };
  const pay = monthPayload(M.groups.AXES, week("2026-09-14"));
  await M.query.replaceGroupMonth.handler({ db: fakeDb(tables) }, { ...pay, rateVar: 0.0096 });
  const kept = tables.attendanceRunGroupMonths[0].rateVar;
  await M.query.replaceGroupMonth.handler({ db: fakeDb(tables) }, { ...pay, axes: [], days: [], skipped: [{ axis: "race", reason: "x" }] });
  check("...the month keeps it, and a build that could not make groups does not erase it", kept === 0.0096 && tables.attendanceRunGroupMonths[0].rateVar === 0.0096);
  const w = world();
  w.attendanceRunGroupMonths = ["2026-08", "2026-09", "2026-10"].map((month) => ({ _id: month, yearid: 36, month, built: [], skipped: [], updatedAt: SYNC, rateVar: 0.0096 }));
  const withSpread = (await ask(M, ADMIN, { group: "race:black", periods: THIS_WEEKS.map((x) => [x]) }, w)).res;
  const without = (await ask(M, ADMIN, { group: "race:black", periods: THIS_WEEKS.map((x) => [x]) })).res;
  check("...and the answer carries the verdict once a spread is stored (none before)",
    typeof withSpread.vsRest.withinChance === "boolean" && without.vsRest.withinChance === null);
}

// ===========================================================================
console.log("\nA SKIPPED AXIS IS MENDED, NOT LEFT STALE FOR GOOD (review, 2026-10-12)\n");
// ===========================================================================
suite.staleMended = async (Mx) => {
  // 9/30 night: every axis, school days to 9/29. Nights of 10/1-10/7: the
  // race read fails each time while 9/30 is added to the others.
  const tables = { attendanceRunGroupDays: [], attendanceRunGroupMonths: [] };
  const db = fakeDb(tables);
  const A = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29"];
  const B = [...A, "2026-09-30"];
  await Mx.query.replaceGroupMonth.handler({ db }, { ...monthPayload(Mx.groups.AXES, A), syncedAt: "2026-09-30T10:15:00.000Z" });
  for (let n = 1; n <= 7; n++) {
    await Mx.query.replaceGroupMonth.handler({ db }, { ...monthPayload(["gender", "el", "ela"], B), syncedAt: `2026-10-0${n}T10:15:00.000Z`,
      skipped: [{ axis: "race", reason: "Race codes could not be read: HTTP 503" }] });
  }
  const stale = await Mx.query.groupMonthsStatus.handler({ db }, { yearid: 36 });
  // The nightly run on 10/8: September is not this month or last week's, so only a mend reaches it.
  const nightly = await runAction("refreshCurrent", {}, { Mx, queries: {
    "attendanceRunChartData.monthsPresent": () => ["2026-08", "2026-09", "2026-10"],
    "attendanceGroupRunChart.groupMonthsStatus": () => stale,
  } });
  const mended = nightly.scheduled.filter((x) => x.args.groupsOnly).map((x) => x.args.month);
  // The mend's build succeeds: race is current again.
  await Mx.query.replaceGroupMonth.handler({ db }, { ...monthPayload(Mx.groups.AXES, B), syncedAt: "2026-10-09T10:15:00.000Z" });
  const fixed = await Mx.query.groupMonthsStatus.handler({ db }, { yearid: 36 });
  return { ok: !stale[0].built.includes("race") && stale[0].built.join(",") === "gender,el,ela" && mended.includes("2026-09")
    && fixed[0].built.slice().sort().join(",") === "el,ela,gender,race" && tables.attendanceRunGroupMonths[0].skipped.length === 0,
    stale: stale[0].built, mended };
};
{
  const sm = await suite.staleMended(M);
  check("a month whose last builds all skipped race is NOT complete: the nightly mend rebuilds it, and race is current again after",
    sm.ok, JSON.stringify(sm));
  // The screen is told why the days are missing, for that line's axes only.
  const t = world();
  t.attendanceRunGroupMonths = [{ _id: "s", yearid: 36, month: "2026-09", built: [{ axis: "gender", syncedAt: "2026-10-07T10:15:00.000Z" }],
    skipped: [{ axis: "race", reason: "Race codes could not be read: HTTP 503", at: "2026-10-07T10:15:00.000Z" }], updatedAt: "x" }];
  const black = (await ask(M, ADMIN, { group: "race:black", periods: [[THIS_WEEKS[4]]] }, t)).res;
  const fem = (await ask(M, ADMIN, { group: "gender:F", periods: [[THIS_WEEKS[4]]] }, t)).res;
  check("...and the Black line's answer says why some of its days are missing; Female's does not",
    /HTTP 503/.test(black.notBuilt || "") && !("notBuilt" in fem));
}

// ===========================================================================
console.log("\nTEETH: EACH RULE, BROKEN ON PURPOSE, IS CAUGHT\n");
// ===========================================================================
{
  const mutate = (key, from, to) => {
    if (!SRC[key].includes(from)) throw new Error("teeth anchor missing in " + key + ": " + from);
    return modules({ [key]: SRC[key].replace(from, to) });
  };
  const caught = async (name, Mx, run) => {
    let ok;
    try { ok = await run(Mx); } catch { ok = false; }
    if (ok && typeof ok === "object") ok = ok.ok;
    check(`teeth: ${name}`, ok === false);
  };
  await caught("PBIS given the race line", mutate("groups", 'export const RACE_LINE_ROLES = ["admin", "superadmin"];',
    'export const RACE_LINE_ROLES = ["admin", "superadmin", "pbis"];'), suite.roles);
  await caught("the grant read as anything truthy", mutate("groups", "if (staff.attendanceWatch === true) return",
    "if (staff.attendanceWatch) return"), suite.roles);
  await caught("the grant given every type", mutate("groups", 'if (staff.attendanceWatch === true) return ["gender"];',
    'if (staff.attendanceWatch === true) return ["gender", "el", "ela"];'), suite.grantGenderOnly);
  await caught("PBIS given race through the menu", mutate("groups", 'if (GROUP_CHART_ROLES.includes(role)) return ["gender", "el", "ela"];',
    'if (GROUP_CHART_ROLES.includes(role)) return ["gender", "race", "el", "ela"];'), suite.pbisNoRace);
  await caught("no per-day floor", mutate("groups", "if (!(n >= DAY_FLOOR)) removed.add(r);", "void n;"), suite.dayFloor);
  await caught("no residual test", mutate("groups", "if (!shown.length || !exposesSmall(cells, shown.map(cellsOf))) break;", "break;"),
    suite.pendingTakesSmallest);
  await caught("no residual test (the brute-force reader)", mutate("groups",
    "if (!shown.length || !exposesSmall(cells, shown.map(cellsOf))) break;", "break;"), suite.bruteForce);
  await caught("the rank test reads every cell as big", mutate("groups", "const big = all.filter((i) => size[i] >= floor);",
    "const big = all.slice();"), suite.raceExample);
  await caught("the largest line withheld instead of the smallest", mutate("groups", "const next = order.find((r) => shown.includes(r));",
    "const next = order.slice().reverse().find((r) => shown.includes(r));"), suite.pendingTakesSmallest);
  await caught("a shared line withheld from one menu only", mutate("groups",
    "else if (v.removed.has(series.row)) small = true;", "else if (v.removed.has(series.id)) small = true;"), suite.sharedLine);
  await caught("a week allowed in two periods", mutate("groups", 'if (seen.has(w)) return { ok: false, reason: "A week can only be in one period." };',
    ""), suite.periodShape);
  await caught("a withheld week served inside a longer period", mutate("groups",
    "else if (v.removed.has(series.row)) small = true;", "else if (v.removed.has(series.row) && dates.length < 6) small = true;"),
    suite.withheldEverywhere);
  await caught("a one-day week served", mutate("groups", "export const MIN_WEEK_DAYS = 2;", "export const MIN_WEEK_DAYS = 1;"), suite.minDays);
  await caught("a one-day week served inside a merged period", mutate("groups", "if (inWeek < MIN_WEEK_DAYS) fewDays = true;",
    "if (inWeek < MIN_WEEK_DAYS && weeks.length === 1) fewDays = true;"), suite.minDays);
  await caught("a count on the wire", mutate("groups", "answers.push({ key, value, rest, withheld: value === null ? \"no-data\" : null });",
    "answers.push({ key, value, rest, withheld: value === null ? \"no-data\" : null, memberDays: md } as any);"), suite.keys);
  await caught("the group absences not bumped in the loop", mutate("days",
    "for (const [axis, group] of pairs) addAbsenceDay(groupRow(date, axis, group), day);", ""), suite.sumsExact);
  await caught("the band rows changed when groups are on", mutate("days", "row.members++;\n      const pairs",
    "row.members++; if (grp) row.members++;\n      const pairs"), suite.bandsUntouched);
  await caught("English Learner from today's status applied backwards", mutate("groups",
    "if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(start) || start > date) continue;", "if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(start)) continue;"), suite.asOfDate);
  const bandsFirst = "    if (!groupsOnly) {\n      await ctx.runMutation(internal.attendanceRunChartData.replaceMonth";
  if (!SRC.action.includes(bandsFirst)) throw new Error("teeth anchor missing in action");
  await caught("a failed demographic read taking the band rows down", M, async (Mx) => suite.isolation(Mx, SRC.action.replace(bandsFirst,
    "    const g0 = await buildGroups(host, tok, schoolid, input, missing, built); if (!g0.axes.length) throw new Error('no groups');\n" + bandsFirst)));
  const actionMut = (from, to) => { if (!SRC.action.includes(from)) throw new Error("teeth anchor missing in action: " + from); return SRC.action.replace(from, to); };
  await caught("groupsOnly rewriting the band rows", M, async () => suite.groupsOnly(actionMut("    if (!groupsOnly) {\n", "    if (true) {\n")));
  await caught("a backfill that rewrites last year's bands by default", M, async () => suite.backfillSays(actionMut(
    "if (groupsOnly === rewriteBands || (groupsOnly !== true && rewriteBands !== true)) {", "if (groupsOnly === true && rewriteBands === true) {")));
  await caught("the week in progress served (no build-coverage check)", mutate("groups", "if (!covered(d)) open = true;", ""), suite.mornings);
  await caught("a month's coverage taken from the newest build only", mutate("groups",
    "const through = builtThrough.get(date.slice(0, 7)) ?? newestBuilt;", "const through = newestBuilt;"), suite.monthEdge);
  await caught("the pool test at 10, not 30 (RFEP offered beside the IFEP pool)", mutate("groups",
    "exposesSmall(cells, lines.map(cellsOf), CHART_FLOOR)", "exposesSmall(cells, lines.map(cellsOf), DAY_FLOOR)"), suite.pbisPool);
  await caught("the chart floor lowered to 28 (IFEP and RFEP offered, as measured)", mutate("groups", "export const CHART_FLOOR = 30;",
    "export const CHART_FLOOR = 28;"), suite.adminListProd);
  await caught("the pool brute force, with no pool test", mutate("groups", "while (exposes(live)) {", "while (false) {"), suite.poolBrute);
  await caught("the chance band without who-is-in-the-group", mutate("groups",
    "const who = spread * 10000 * (1 / n + 1 / rest);", "const who = 0;"), suite.calibrated);
  await caught("a skipped axis counted as built", mutate("groups",
    "return m.built.filter((b) => !m.skipped.some((s) => s.axis === b.axis && s.at >= b.syncedAt)).map((b) => b.axis);",
    "return m.built.map((b) => b.axis);"), suite.staleMended);
  await caught("a stale row left behind", mutate("query", "for (const r of old) if (axes.includes(r.axis)) await ctx.db.delete(r._id);",
    "for (const r of old.slice(1)) if (axes.includes(r.axis)) await ctx.db.delete(r._id);"), suite.replaceClean);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
