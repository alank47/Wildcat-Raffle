// Excused tardies never break perfect attendance. Run: npm test
//
// THE OWNER, 2026-10-01: "Can we not count Excused Tardies in Perfect
// Attendance? And make it retroactive to September?"
//
// THE CODES, as this school has them (measured 2026-10-01): T Tardy and
// D Excused Tardy are both coded Present; A Absent, X Excused Absence,
// I Illness and P Independent Study are coded Absent; F Field Trip, K Ditching
// and a blank code are Present and are neither.
//
// THE TRAP THIS FILE EXISTS FOR. "Tardy dates minus excused tardy dates" looks
// like the rule and is not: a day with a D in one period and a T in another is
// in BOTH lists, so the subtraction forgives the plain tardy too. The rebuild
// therefore records the unexcused dates itself, block by block, and the screen
// uses them; the subtraction survives only as the stand-in for rows written
// before the next rebuild. Several checks below exist to tell those apart.
//
// RETROACTIVE needs no migration: nothing is stored per month, every window is
// worked out from the marks each time it is drawn. September is checked here as
// a window like any other.
//
// Everything runs the SHIPPED code: the rebuild itself against a fake
// PowerSchool, the query against an in-memory table, the roster rules loaded
// for real. A regex over the source would still pass with the code broken.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { fakePowerSchool } from "./fake-powerschool.mjs";

const rosterSrc = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
const daysSrc = readFileSync(new URL("./convex/attendanceDays.ts", import.meta.url), "utf8");
const rulesSrc = readFileSync(new URL("./convex/absenceDayRules.ts", import.meta.url), "utf8");
const listSrc = readFileSync(new URL("./convex/attendanceList.ts", import.meta.url), "utf8");
const statsSrc = readFileSync(new URL("./convex/sisStats.ts", import.meta.url), "utf8");
const schemaSrc = readFileSync(new URL("./convex/schema.ts", import.meta.url), "utf8");
const accessSrc = readFileSync(new URL("./convex/accessRules.ts", import.meta.url), "utf8");
const htmlSrc = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const scriptSrc = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

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

// ---------------------------------------------------------------- the roster
function loadRoster(transform) {
  const body = transform ? transform(rosterSrc) : rosterSrc;
  const sandbox = {};
  new Function("globalThis", body).call(sandbox, sandbox);
  return sandbox.WildcatRoster;
}
const R = loadRoster();

// ---------------------------------------------------------------- the rebuild
// The shipped action with its imports stubbed: Convex's wrappers become plain
// objects, absenceDayRules is the REAL module, and fetch and process.env are
// a fake PowerSchool handed in as parameters. The clock is pinned to
// 2026-10-02 (2026-10-02): the year is read in month pieces cut at "today",
// and a test that moved with the calendar would test something else in June.
const absenceRules = await import("data:text/javascript," + encodeURIComponent(tsToJs(rulesSrc)));

function loadRebuild(transform) {
  let body = transform ? transform(daysSrc) : daysSrc;
  body = breakOnce(body, "function laToday(): string {", 'function laToday(): string {\n  return "2026-10-02";', "clock");
  body = body
    .replace(/^"use node";[ \t]*\n/m, "")
    .replace(/^import[\s\S]*?from\s*"[^"]*";[ \t]*\n/gm, "")
    .replace(/^export (const|async function|function) /gm, "$1 ");
  const ref = (path) => new Proxy({}, {
    get: (_, k) => (k === "__path" ? path : ref(path ? path + "." + String(k) : String(k))),
  });
  const v = new Proxy({}, { get: () => () => ({}) });
  return new Function("internalAction", "internal", "v", "addAbsenceDay", "emptyAbsenceSplit", "fetch", "process",
    tsToJs(body) + "\nreturn rebuild;")
    .bind(null, (d) => d, ref(""), v, absenceRules.addAbsenceDay, absenceRules.emptyAbsenceSplit);
}

// The school's attendance codes, as read on 2026-10-01. Every fixture row
// carries the fields the rebuild filters on (schoolid, termid, yearid...):
// the shared fake PowerSchool applies every clause, and throws on a clause a
// fixture row could not answer.
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
const TERMS = [{ id: 3600, schoolid: 1, yearid: 36, firstday: "2026-08-12", lastday: "2027-06-10", isyearrec: 1 }];
const C = Object.fromEntries(CODES.map((c) => [c.att_code || "blank", c.id]));
// Ten sections, one per period slot; 999 is a section the build cannot place.
const CC = Array.from({ length: 10 }, (_, i) => ({ id: 501 + i, expression: `${i + 1}(A-E)`, schoolid: 1, termid: 3600 }));
const SLOTS = CC.map((c) => c.expression);
const P = (n) => 500 + n;   // the section a student sits in for period n
const UNPLACEABLE = 999;

const STUDENTS = [
  ["101", "1001"], ["102", "1002"], ["103", "1003"], ["104", "1004"], ["105", "1005"],
  ["106", "1006"], ["107", "1007"], ["108", "1008"], ["109", "1009"],
].map(([id, n]) => ({ id, student_number: n, entrydate: "2026-08-12", schoolid: 1, enroll_status: 0 }));

let nextAttendanceId = 1;
const row = (studentid, date, code, ccid) =>
  ({ id: nextAttendanceId++, yearid: 36, schoolid: 1, studentid, att_date: date + "T00:00:00", periodid: 1,
     attendance_codeid: code, ccid });
// Every date is in SEPTEMBER, the month the owner asked to be redone.
const ATTENDANCE = [
  // 1001 Tia: a plain Tardy only.
  row("101", "2026-09-08", C.T, P(1)),
  // 1002 Uma: Excused Tardies only, one day twice over.
  row("102", "2026-09-09", C.D, P(2)),
  row("102", "2026-09-10", C.D, P(1)), row("102", "2026-09-10", C.D, P(3)),
  // 1003 Vic: a T and a D on the SAME day, in both orders. The trap.
  row("103", "2026-09-10", C.T, P(1)), row("103", "2026-09-10", C.D, P(3)),
  row("103", "2026-09-11", C.D, P(1)), row("103", "2026-09-11", C.T, P(3)),
  // 1004 Wes: one of each absence code. Only X says "excused".
  row("104", "2026-09-14", C.A, P(1)), row("104", "2026-09-15", C.X, P(1)),
  row("104", "2026-09-16", C.I, P(1)), row("104", "2026-09-17", C.P, P(1)),
  // 1005 Xan: an X beside an A on one day; X in every period on another.
  row("105", "2026-09-18", C.X, P(1)), row("105", "2026-09-18", C.A, P(2)),
  ...[1, 2, 3, 4, 5].map((n) => row("105", "2026-09-21", C.X, P(n))),
  // 1006 Yui: Field Trip, Ditching and a blank code are not marks at all.
  row("106", "2026-09-22", C.F, P(1)), row("106", "2026-09-22", C.K, P(2)), row("106", "2026-09-22", C.blank, P(3)),
  // 1007 Zed: a D and a T in a section the build cannot place. Still marks.
  row("107", "2026-09-23", C.D, UNPLACEABLE), row("107", "2026-09-24", C.T, UNPLACEABLE),
  // 1008 Amy: nothing at all.
  // 1009 Ben: an Absence and an Excused Tardy on the same day.
  row("109", "2026-09-25", C.A, P(1)), row("109", "2026-09-25", C.D, P(2)),
  // Everyone else present in period 1 on a normal day, so the slot map is real.
  ...STUDENTS.map((s) => row(s.id, "2026-09-29", C.blank, P(1))),
];

async function runRebuild(rebuild, tables) {
  const t = Object.assign({ attendance_code: CODES, cc: CC, students: STUDENTS, attendance: ATTENDANCE, terms: TERMS },
    tables || {});
  const fetch = fakePowerSchool(t).fetch;
  const env = { PS_HOST: "ps.example", PS_CLIENT_ID: "id", PS_CLIENT_SECRET: "s", PS_SCHOOL_ID: "1",
                PS_YEAR_ID: "36", PS_TERM_ID: "3600" };
  const writes = [];
  const ctx = {
    runQuery: async (fn) => {
      if (fn.__path.endsWith("enrolledSlots")) return Object.fromEntries(STUDENTS.map((s) => [s.student_number, SLOTS]));
      if (fn.__path.endsWith("studentNames")) {
        return Object.fromEntries(STUDENTS.map((s) => [s.student_number, { firstName: "F" + s.student_number, lastName: "L", grade: "7" }]));
      }
      throw new Error("unexpected query " + fn.__path);
    },
    // Every mutation succeeds here, and the month-piece switch reads as ON, so
    // these marks come out of the path that will be live. The real run record,
    // write lock and switch are exercised in attendance-wall.test.mjs.
    runMutation: async (fn, args) => { writes.push({ fn: fn.__path, args }); return { ok: true, moreToClear: false, monthPieces: true }; },
    scheduler: { runAfter: async () => "job_1", cancel: async () => {} },
  };
  const summary = await rebuild(fetch, { env }).handler(ctx, {});
  const marks = writes.filter((w) => w.fn === "sisStats.replaceAttendanceMarks" && !w.args.clearFirst)
    .flatMap((w) => w.args.rows);
  return { summary, marks, by: Object.fromEntries(marks.map((r) => [r.studentNumber, r])) };
}

console.log("\nTHE REBUILD RECORDS WHICH DAYS HAD AN UNEXCUSED MARK\n");
const shipped = await runRebuild(loadRebuild());
{
  const { summary, marks, by } = shipped;
  check("the rebuild ran against the fake PowerSchool and wrote a row per student",
    summary.ok === true && marks.length === STUDENTS.length, JSON.stringify(summary).slice(0, 300));
  check("...reading the year in month pieces that PowerSchool's own count agreed with",
    summary.readMode === "month pieces" && summary.yearCount === ATTENDANCE.length && summary.attendanceRows === ATTENDANCE.length,
    JSON.stringify({ readMode: summary.readMode, yearCount: summary.yearCount, rows: summary.attendanceRows }));
  check("the code mapping is as measured: D is an excused tardy, T a plain one, X the only excused absence",
    same(summary.codeMapping.map((c) => c.code + ":" + c.counts + (c.excused ? ":excused" : "")),
      ["A:absence", "T:tardy", "X:absence:excused", "I:absence", "D:tardy:excused", "P:absence"]),
    JSON.stringify(summary.codeMapping));

  const t = by["1001"], u = by["1002"], vic = by["1003"];
  check("T only: a tardy, and an UNEXCUSED one",
    same(t.tardyDates, ["2026-09-08"]) && same(t.excusedTardyDates, []) && same(t.unexcusedTardyDates, ["2026-09-08"]));
  check("D only: tardies, all excused, NONE unexcused",
    same(u.tardyDates, ["2026-09-09", "2026-09-10"]) && same(u.excusedTardyDates, ["2026-09-09", "2026-09-10"]) &&
    same(u.unexcusedTardyDates, []), JSON.stringify(u));
  check("...two D's on one day are one date, not two", u.tardyDates.length === 2);
  check("T AND D ON THE SAME DAY: the day is excused AND unexcused, so the plain tardy still counts",
    same(vic.tardyDates, ["2026-09-10", "2026-09-11"]) && same(vic.excusedTardyDates, ["2026-09-10", "2026-09-11"]) &&
    same(vic.unexcusedTardyDates, ["2026-09-10", "2026-09-11"]), JSON.stringify(vic));
  check("...whichever of the two PowerSchool lists first",
    vic.unexcusedTardyDates.includes("2026-09-10") && vic.unexcusedTardyDates.includes("2026-09-11"));

  const w = by["1004"];
  check("A, X, I and P are all absences", same(w.absentDates, ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]));
  check("...only X is excused (Illness does not say so, and the classification is unchanged)",
    same(w.excusedAbsentDates, ["2026-09-15"]));
  check("...so A, I and P are the unexcused absences", same(w.unexcusedAbsentDates, ["2026-09-14", "2026-09-16", "2026-09-17"]));
  check("...and none of them is a tardy", same(w.tardyDates, []) && same(w.unexcusedTardyDates, []));

  const x = by["1005"];
  check("an X beside an A on one day: excused AND unexcused",
    x.excusedAbsentDates.includes("2026-09-18") && x.unexcusedAbsentDates.includes("2026-09-18"));
  check("X in every period: excused, NOT unexcused",
    x.excusedAbsentDates.includes("2026-09-21") && !x.unexcusedAbsentDates.includes("2026-09-21"));
  check("...and both days are absences", same(x.absentDates, ["2026-09-18", "2026-09-21"]));

  check("Field Trip, Ditching and a blank code mark nothing",
    ["absentDates", "excusedAbsentDates", "unexcusedAbsentDates", "tardyDates", "excusedTardyDates", "unexcusedTardyDates"]
      .every((k) => same(by["1006"][k], [])));
  check("a section the build cannot place still marks the day, excused and not",
    same(by["1007"].tardyDates, ["2026-09-23", "2026-09-24"]) && same(by["1007"].excusedTardyDates, ["2026-09-23"]) &&
    same(by["1007"].unexcusedTardyDates, ["2026-09-24"]), JSON.stringify(by["1007"]));
  check("a student with nothing against them still gets BOTH new lists, empty rather than missing",
    same(by["1008"].unexcusedAbsentDates, []) && same(by["1008"].unexcusedTardyDates, []));
  check("every row carries both new lists, sorted",
    marks.every((r) => Array.isArray(r.unexcusedAbsentDates) && Array.isArray(r.unexcusedTardyDates) &&
      same(r.unexcusedTardyDates, r.unexcusedTardyDates.slice().sort())));
  check("an unexcused date is always one of the marked dates (the subset holds)",
    marks.every((r) => r.unexcusedTardyDates.every((d) => r.tardyDates.includes(d)) &&
      r.unexcusedAbsentDates.every((d) => r.absentDates.includes(d))));
  check("a date with an excused-only tardy is in exactly one of the two tardy lists",
    marks.every((r) => r.tardyDates.every((d) => r.excusedTardyDates.includes(d) || r.unexcusedTardyDates.includes(d))));
  check("an Absence and an Excused Tardy on one day: an absence, and no unexcused tardy",
    same(by["1009"].unexcusedAbsentDates, ["2026-09-25"]) && same(by["1009"].excusedTardyDates, ["2026-09-25"]) &&
    same(by["1009"].unexcusedTardyDates, []));
}

console.log("\nTHE WRITE PATH ACCEPTS WHAT THE REBUILD SENDS\n");
{
  // A FIELD THE MUTATION DOES NOT DECLARE IS REFUSED, and it is refused AFTER
  // the clear has emptied the table: the list would go blank, not stale.
  const fieldsOf = (src, from, to) => {
    const i = src.indexOf(from);
    const j = src.indexOf(to, i + from.length);
    if (i < 0 || j < 0) return null;
    const block = src.slice(i + from.length, j).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    return new Map([...block.matchAll(/^\s*(\w+):\s*(v\..*?),?\s*$/gm)].map((m) => [m[1], m[2]]));
  };
  const mutationFields = (src) => {
    const at = src.indexOf("export const replaceAttendanceMarks = internalMutation({");
    return at < 0 ? null : fieldsOf(src.slice(at), "v.object({", "handler:");
  };
  const tableFields = (src) => fieldsOf(src, "psAttendanceMarks: defineTable({", '.index("by_studentNumber"');
  const written = [...new Set(shipped.marks.flatMap((r) => Object.keys(r)))];
  const missing = (fields) => written.filter((k) => !fields || !fields.has(k));

  check("every field the rebuild writes is declared on replaceAttendanceMarks",
    missing(mutationFields(statsSrc)).length === 0, missing(mutationFields(statsSrc)).join(","));
  check("...and on the psAttendanceMarks table",
    missing(tableFields(schemaSrc)).length === 0, missing(tableFields(schemaSrc)).join(","));
  for (const k of ["unexcusedAbsentDates", "unexcusedTardyDates"]) {
    check(`${k} is an OPTIONAL list of dates in the table (old rows lack it)`,
      tableFields(schemaSrc).get(k) === "v.optional(v.array(v.string()))", tableFields(schemaSrc).get(k));
    check(`...and in the mutation`, mutationFields(statsSrc).get(k) === "v.optional(v.array(v.string()))");
  }
  check("the four existing lists keep their exact declarations",
    ["absentDates", "excusedAbsentDates", "tardyDates", "excusedTardyDates"].every((k) =>
      tableFields(schemaSrc).get(k) === "v.array(v.string())" && mutationFields(statsSrc).get(k) === "v.array(v.string())"));

  // The checker itself: a mutation that forgot the field is caught.
  const forgot = breakOnce(statsSrc, "        unexcusedTardyDates: v.optional(v.array(v.string())),\n", "", "stats-field");
  check("TEETH: a mutation that does not declare unexcusedTardyDates is caught",
    missing(mutationFields(forgot)).includes("unexcusedTardyDates"));
}

console.log("\nTHE QUERY PASSES THEM ON, AND SAYS WHEN A ROW HAS NONE YET\n");
const accessRules = await import("data:text/javascript," + encodeURIComponent(tsToJs(accessSrc)));
function loadQuery(transform) {
  let body = listSrc
    .replace(/^import\s*\{([^}]*)\}\s*from\s*"\.\/accessRules";[ \t]*\n/gm,
      (_, names) => `const {${names.split(",").filter((n) => !/^\s*type\s/.test(n)).join(",")}} = __accessRules;\n`)
    .replace(/^import[\s\S]*?from\s*"[^"]*";[ \t]*\n/gm, "")
    .replace(/^export const /gm, "const ");
  if (transform) body = transform(body);
  const stubs = `
    const query = (d) => d;
    const v = new Proxy({}, { get: () => (...a) => ({ _v: true, a }) });
    const requireStaff = async () => ({ role: "admin", email: "a@b.org" });
    const dayCount = (x) => (x === 0 || x ? Number(x) : null);
  `;
  return new Function("__accessRules", `${tsToJs(stubs + body)}\nreturn { attendanceMarks };`)(accessRules);
}
{
  const table = [
    // Written by the rebuild from 2026-10-01 on.
    Object.assign({ syncedAt: "2026-10-01T19:30:00Z", firstName: "Vic", lastName: "Ng", gradeLevel: "7",
                    entryDate: "2026-08-12" }, shipped.by["1003"]),
    // Written before: no unexcused lists. A plain Tardy on the 16th.
    { studentNumber: "2001", firstName: "Old", lastName: "Row", gradeLevel: "8", entryDate: "2026-08-12",
      absentDates: [], excusedAbsentDates: [], tardyDates: ["2026-09-16"], excusedTardyDates: [],
      syncedAt: "2026-10-01T13:30:00Z" },
  ];
  const ctx = { db: { query: () => ({ take: async () => table.slice() }) } };
  const read = async (Q) => (await Q.attendanceMarks.handler(ctx, {})).rows;
  const rows = await read(loadQuery());
  check("a rebuilt row's unexcused lists reach the browser",
    same(rows[0].unexcusedTardyDates, ["2026-09-10", "2026-09-11"]) && Array.isArray(rows[0].unexcusedAbsentDates));
  check("an older row's are NULL -- not [], which would mean 'never late without an excuse'",
    rows[1].unexcusedTardyDates === null && rows[1].unexcusedAbsentDates === null);
  check("...and the four existing lists are unchanged",
    same(rows[1].tardyDates, ["2026-09-16"]) && same(rows[0].excusedTardyDates, ["2026-09-10", "2026-09-11"]));
  const sep = R.perfectMonthWindow("2026-09", "2026-10-01", "2026-08-12");
  check("through the query, the older row's plain tardy still keeps them off September",
    R.perfectVerdict(rows[1], sep, {}).perfect === false);
  check("...and the rebuilt row's same-day T and D keep Vic off it",
    R.perfectVerdict(rows[0], sep, {}).perfect === false);

  const broken = await read(loadQuery((b) => breakOnce(b,
    "unexcusedTardyDates: r.unexcusedTardyDates ?? null,", "unexcusedTardyDates: r.unexcusedTardyDates ?? [],", "null")));
  check("TEETH: a query that defaults to [] puts a late child on the award list until the next rebuild",
    R.perfectVerdict(broken[1], sep, {}).perfect === true);
}

// ------------------------------------------------------------- the verdict
const student = (over) => Object.assign({
  studentNumber: "1001", firstName: "Ana", lastName: "Diaz", gradeLevel: "7", entryDate: "2026-08-12",
  absentDates: [], excusedAbsentDates: [], tardyDates: [], excusedTardyDates: [],
}, over || {});
const D = "2026-09-22";   // a Tuesday: inside the last full week on 1 Oct, September and the year
// Exact rows, as the rebuild now writes them.
const exact = {
  excusedTardyOnly: student({ tardyDates: [D], excusedTardyDates: [D], unexcusedTardyDates: [], unexcusedAbsentDates: [] }),
  plainTardy: student({ tardyDates: [D], excusedTardyDates: [], unexcusedTardyDates: [D], unexcusedAbsentDates: [] }),
  bothTardies: student({ tardyDates: [D], excusedTardyDates: [D], unexcusedTardyDates: [D], unexcusedAbsentDates: [] }),
  excusedAbsenceOnly: student({ absentDates: [D], excusedAbsentDates: [D], unexcusedAbsentDates: [], unexcusedTardyDates: [] }),
  mixedAbsence: student({ absentDates: [D], excusedAbsentDates: [D], unexcusedAbsentDates: [D], unexcusedTardyDates: [] }),
};
// Rows written before 2026-10-01: no unexcused lists.
const old = {
  excusedTardyOnly: student({ tardyDates: [D], excusedTardyDates: [D] }),
  plainTardy: student({ tardyDates: [D] }),
  bothTardies: student({ tardyDates: [D], excusedTardyDates: [D] }),
  excusedAbsenceOnly: student({ absentDates: [D], excusedAbsentDates: [D] }),
};
const perfect = (Roster, r, win, opts) => Roster.perfectVerdict(r, win, opts || {}).perfect;

console.log("\nEXCUSED TARDIES NEVER BREAK IT\n");
{
  const w = R.perfectWindows("2026-10-01", "2026-08-12");
  check("an excused tardy alone does NOT break it, with the box at its strict default",
    perfect(R, exact.excusedTardyOnly, w.year) === true);
  check("...nor with the box explicitly ticked", perfect(R, exact.excusedTardyOnly, w.year, { countExcused: true }) === true);
  check("a plain tardy does", perfect(R, exact.plainTardy, w.year) === false);
  check("A PLAIN TARDY ON A DAY THAT ALSO HAD AN EXCUSED ONE STILL DOES",
    perfect(R, exact.bothTardies, w.year) === false);
  check("...whichever way the box is set",
    perfect(R, exact.bothTardies, w.year, { countExcused: false }) === false);
  const v = R.perfectVerdict(exact.bothTardies, w.year, {});
  check("...and the verdict says it was lateness, on that day",
    v.brokenBy === "tardy" && v.tardyDays === 1 && v.firstTardy === D, JSON.stringify(v));
  const ok = R.perfectVerdict(exact.excusedTardyOnly, w.year, {});
  check("an excused tardy is not counted as a tardy day at all",
    ok.tardyDays === 0 && ok.firstTardy === null && ok.brokenBy === null);
  check("an absence beside an excused tardy is an absence, not 'both'",
    R.perfectVerdict(student({ absentDates: [D], tardyDates: [D], excusedTardyDates: [D],
      unexcusedAbsentDates: [D], unexcusedTardyDates: [] }), w.year, {}).brokenBy === "absence");
  check("an empty unexcused list is a FACT: tardies marked, every one excused, still perfect",
    perfect(R, student({ tardyDates: ["2026-09-15", D], excusedTardyDates: ["2026-09-15", D], unexcusedTardyDates: [] }), w.year) === true);
  check("only unexcused dates inside the window count",
    perfect(R, student({ tardyDates: ["2026-09-01"], unexcusedTardyDates: ["2026-09-01"] }), w.week) === true &&
    perfect(R, student({ tardyDates: ["2026-09-01"], unexcusedTardyDates: ["2026-09-01"] }), w.year) === false);
}

console.log("\nBEFORE THE NEXT REBUILD: TODAY'S RULE, NOBODY ADDED EARLY\n");
{
  // Review, 2026-10-02: the old fallback (tardies minus excused tardies)
  // forgave a day with BOTH kinds, putting a child late without an excuse on
  // a list that may be printed. A row not yet rebuilt now keeps today's rule.
  const w = R.perfectWindows("2026-10-01", "2026-08-12");
  check("an older row's excused tardy still counts until the rebuild (today's rule)",
    perfect(R, old.excusedTardyOnly, w.year) === false);
  check("an older row's plain tardy still breaks it", perfect(R, old.plainTardy, w.year) === false);
  check("an older row's mixed day is NOT forgiven early -- no child is put on the list by the switch-over",
    perfect(R, old.bothTardies, w.year) === false && perfect(R, exact.bothTardies, w.year) === false);
  check("once rebuilt, the same excused-only tardy is forgiven",
    perfect(R, exact.excusedTardyOnly, w.year) === true);
  check("null reads as 'not rebuilt yet', the same as missing",
    perfect(R, Object.assign({}, old.plainTardy, { unexcusedTardyDates: null }), w.year) === false &&
    perfect(R, Object.assign({}, old.excusedTardyOnly, { unexcusedTardyDates: null }), w.year) === false);
  check("the code says why an un-rebuilt row keeps today's rule",
    /A ROW THE REBUILD HAS NOT REFILLED YET keeps today's rule EXACTLY/.test(rosterSrc) &&
    /RETROACTIVE BY CONSTRUCTION/.test(rosterSrc) && !/THE PRE-REBUILD APPROXIMATION/.test(rosterSrc));
}

console.log("\nTHE BOX IS ABOUT EXCUSED ABSENCES ONLY\n");
{
  const w = R.perfectWindows("2026-10-01", "2026-08-12");
  check("ticked (the default), an excused absence breaks it", perfect(R, exact.excusedAbsenceOnly, w.year) === false);
  check("unticked, an excused-only absence day is forgiven",
    perfect(R, exact.excusedAbsenceOnly, w.year, { countExcused: false }) === true);
  check("unticked, a day with an excused AND a plain absence still breaks it (exact)",
    perfect(R, exact.mixedAbsence, w.year, { countExcused: false }) === false);
  check("...though an older row's mixed day is forgiven by the approximation",
    perfect(R, student({ absentDates: [D], excusedAbsentDates: [D] }), w.year, { countExcused: false }) === true);
  check("unticked, the older row's excused absence is forgiven too",
    perfect(R, old.excusedAbsenceOnly, w.year, { countExcused: false }) === true);
  check("THE BOX NO LONGER TOUCHES TARDIES: every rebuilt tardy case reads the same both ways",
    Object.values(exact).every((r) =>
      R.perfectVerdict(r, w.year, { countExcused: true }).tardyDays ===
      R.perfectVerdict(r, w.year, { countExcused: false }).tardyDays));
  check("...while an un-rebuilt row keeps today's rule until the rebuild: unticked forgives its excused tardy",
    perfect(R, old.excusedTardyOnly, w.year, { countExcused: false }) === true &&
    perfect(R, old.excusedTardyOnly, w.year, { countExcused: true }) === false);
  const count = R.perfectVerdict(student({
    absentDates: ["2026-09-14", D], excusedAbsentDates: [D], unexcusedAbsentDates: ["2026-09-14"],
  }), w.year, { countExcused: false });
  check("unticked, the remaining absence count is the unexcused days only",
    count.absentDays === 1 && count.firstAbsence === "2026-09-14");
}

console.log("\nEVERY WINDOW, SEPTEMBER INCLUDED\n");
{
  const today = "2026-10-01";
  const w = R.perfectWindows(today, "2026-08-12");
  const windows = [
    ["the last full week", w.week],
    ["September", R.perfectMonthWindow("2026-09", today, "2026-08-12")],
    ["the year to date", w.year],
  ];
  check("the fixture date sits inside all three", windows.every(([, x]) => x.from <= D && D <= x.to));
  for (const [name, win] of windows) {
    check(`${name}: an excused tardy keeps them on it (once rebuilt)`, perfect(R, exact.excusedTardyOnly, win) === true);
    check(`${name}: a plain tardy, or one beside an excused one, keeps them off`,
      perfect(R, exact.plainTardy, win) === false && perfect(R, exact.bothTardies, win) === false &&
      perfect(R, old.plainTardy, win) === false);
  }
  check("October does not inherit September's tardies",
    perfect(R, exact.plainTardy, R.perfectMonthWindow("2026-10", today, "2026-08-12")) === true);
  check("August, clipped to the first day of school, judges the same way",
    perfect(R, student({ tardyDates: ["2026-08-20"], excusedTardyDates: ["2026-08-20"], unexcusedTardyDates: [] }),
      R.perfectMonthWindow("2026-08", today, "2026-08-12")) === true);

  // RETROACTIVE: September read on 1 October, from the marks the rebuild wrote.
  const sep = R.perfectMonthWindow("2026-09", today, "2026-08-12");
  const list = R.perfectList(shipped.marks, sep, {});
  const ids = list.students.map((s) => s.studentNumber).sort();
  check("SEPTEMBER, REDONE: Uma's Excused Tardies no longer keep her off",
    ids.includes("1002"), ids.join(","));
  check("...while Tia's plain tardy and Vic's same-day T and D still do",
    !ids.includes("1001") && !ids.includes("1003"));
  check("...and the whole of September's list is exactly who it should be",
    same(ids, ["1002", "1006", "1008"]), ids.join(","));
}

console.log("\nTHE COUNTS FOLLOW THE SAME RULE\n");
{
  const w = R.perfectWindows("2026-10-01", "2026-08-12");
  const rows = [
    Object.assign({}, exact.excusedTardyOnly, { studentNumber: "1" }),
    Object.assign({}, exact.plainTardy, { studentNumber: "2" }),
    Object.assign({}, exact.bothTardies, { studentNumber: "3" }),
    Object.assign({}, old.excusedTardyOnly, { studentNumber: "4" }),
    Object.assign({}, old.plainTardy, { studentNumber: "5" }),
    student({ studentNumber: "6", absentDates: [D], tardyDates: [D], excusedTardyDates: [D],
              unexcusedAbsentDates: [D], unexcusedTardyDates: [] }),
    student({ studentNumber: "7", absentDates: [D], tardyDates: [D], unexcusedAbsentDates: [D], unexcusedTardyDates: [D] }),
  ];
  const c = R.perfectList(rows, w.year, {}).counts;
  check("perfect: the rebuilt excused-only tardy (1); the un-rebuilt one waits for the rebuild", c.perfect === 1, JSON.stringify(c));
  check("lateness alone: unexcused tardies (2, 3, 5) and the un-rebuilt row (4)", c.brokenByTardy === 4);
  check("absence alone: an absence beside an excused tardy (6)", c.brokenByAbsence === 1);
  check("both: an absence beside a plain tardy (7)", c.brokenByBoth === 1);
  check("...and every eligible student is in exactly one bucket",
    c.perfect + c.brokenByTardy + c.brokenByAbsence + c.brokenByBoth === c.eligible);
}

console.log("\nTHE BOX, THE WORDS AND THE STAMPS\n");
{
  const box = (htmlSrc.match(/<label class="wc-pa-check"[^>]*>[\s\S]*?<\/label>/) || [""])[0];
  check("the box reads 'Excused absences still break it'", /<span>Excused absences still break it<\/span>/.test(box), box);
  check("...and no longer mentions tardies in its label", !/<span>[^<]*tard/i.test(box));
  check("...it is still CHECKED, so strict is what loads",
    /<input type="checkbox" id="attPerfectExcused" checked/.test(box));
  check("...and says, near it, that excused tardies never count",
    /title="Excused tardies never count[^"]*"/.test(box));
  check("the screen's sentence states the rule, both ways",
    scriptSrc.includes("' had no absences and no tardies (excused tardies do not count); excused absences '") &&
    /\+ \(strict \? 'still count' : 'forgiven'\) \+ '\.'/.test(scriptSrc));
  check("the printed sheet states the same rule",
    scriptSrc.includes("const rule = 'No absences and no tardies (excused tardies do not count); excused absences '") &&
    /\+ \(view\.strict \? 'still count' : 'forgiven'\);/.test(scriptSrc));
  check("the old wording is gone from both",
    !/excused ones forgiven|excused absences and tardies still count/.test(scriptSrc));
  check("the footnote says UNEXCUSED tardy", /at least one unexcused tardy/.test(scriptSrc));
  const stamps = [...htmlSrc.matchAll(/\?v=([0-9a-z]+)/g)].map((m) => m[1]);
  // NOT PINNED TO ONE VALUE: every later publish bumps the stamp again. All 26
  // move together, and never back behind the stamp this change shipped with.
  check("all 26 cache stamps moved together, at or past 20261001t",
    stamps.length === 26 && new Set(stamps).size === 1 && stamps[0] >= "20261001t", [...new Set(stamps)].join(","));
  check("this file runs in npm test, after the perfect attendance tests",
    /node perfect-attendance-month\.test\.mjs && node excused-tardy\.test\.mjs/.test(pkg.scripts.test));
}

console.log("\nTHE EARLY WARNING CROSS-CHECK FOLLOWS THE SCREEN (review, 2026-10-02)\n");
{
  const ews = readFileSync(new URL("./convex/earlyWarningProfile.ts", import.meta.url), "utf8");
  const pc = ews.slice(ews.indexOf("export const perfectCounts"), ews.indexOf("export const perfectCounts") + 4000);
  check("perfectCounts counts every tardy strictly for a row not rebuilt yet, like the screen",
    /const strictT = exactUt !== null \? exactUt : t;/.test(pc) && /if \(!a && !strictT\) perfect\+\+;/.test(pc));
  check("...and forgives by subtraction only in the forgiving count",
    /if \(!ua && !forgivingT\) forgiving\+\+;/.test(pc));
}

console.log("\nA PARTIAL REBUILD IS REFUSED (review, 2026-10-02)\n");
{
  // With { since } the read covers only recent days, but every table is
  // CLEARED and rewritten from it: all earlier attendance would be wiped. The
  // 40,000-row refusal used to recommend exactly that.
  const sinceRun = async (rb, args) => {
    let fetched = 0; const writes = [];
    const fetch = async () => { fetched++; return { ok: true, status: 200, json: async () => ({ record: [] }), text: async () => "{}" }; };
    const env = { PS_HOST: "ps.example", PS_CLIENT_ID: "id", PS_CLIENT_SECRET: "s", PS_SCHOOL_ID: "1", PS_YEAR_ID: "36", PS_TERM_ID: "3600" };
    const ctx = { runQuery: async () => ({}), runMutation: async (fn, a) => { writes.push(fn.__path); return { moreToClear: false }; } };
    let out = null;
    try { out = await rb(fetch, { env }).handler(ctx, args); } catch (e) { out = { threw: String(e && e.message || e) }; }
    return { out, fetched, writes };
  };
  const r = await sinceRun(loadRebuild(), { since: "2026-09-20" });
  check("a rebuild with { since } is refused before reading or writing anything",
    r.out && r.out.ok === false && /wiping every earlier date/.test(r.out.reason) && r.fetched === 0 && r.writes.length === 0,
    JSON.stringify(r));
  check("the 40,000-row refusal no longer recommends a partial rebuild",
    !/pass \{ since \} to read only recent days/.test(daysSrc) && /a partial \{ since \} rebuild is refused/.test(daysSrc));
  const unguarded = await sinceRun(loadRebuild((src) => breakOnce(src, "if (since && dryRun !== true) {", "if (false) {", "since-guard")), { since: "2026-09-20" });
  check("TEETH: without the guard, a { since } run goes on to read PowerSchool", unguarded.fetched > 0);
}

console.log("\nDO THE ASSERTIONS HAVE TEETH?\n");
{
  // 1. The rebuild working the unexcused dates out by subtraction: the trap.
  const broken = await runRebuild(loadRebuild((s) => breakOnce(
    breakOnce(s, "if (excused) m.exTardy.add(date); else m.unexTardy.add(date);", "if (excused) m.exTardy.add(date);", "sub-1"),
    "unexcusedTardyDates: m ? sorted(m.unexTardy) : [],",
    "unexcusedTardyDates: m ? sorted(m.tardy).filter((d) => !m.exTardy.has(d)) : [],", "sub-2")));
  check("TEETH: a rebuild that subtracts loses Vic's same-day plain tardy",
    same(broken.by["1003"].unexcusedTardyDates, []));
}
{
  // 2. The rebuild ignoring the excuse altogether.
  const broken = await runRebuild(loadRebuild((s) => breakOnce(s,
    "if (excused) m.exTardy.add(date); else m.unexTardy.add(date);",
    "if (excused) m.exTardy.add(date); m.unexTardy.add(date);", "ignore")));
  check("TEETH: a rebuild that calls every tardy unexcused keeps Uma off September",
    same(broken.by["1002"].unexcusedTardyDates, ["2026-09-09", "2026-09-10"]) &&
    !R.perfectList(broken.marks, R.perfectMonthWindow("2026-09", "2026-10-01", "2026-08-12"), {})
      .students.some((s) => s.studentNumber === "1002"));
}
{
  // 3. The same for absences.
  const broken = await runRebuild(loadRebuild((s) => breakOnce(s,
    "if (excused) m.exAbsent.add(date); else m.unexAbsent.add(date);", "if (excused) m.exAbsent.add(date);", "abs")));
  check("TEETH: a rebuild that drops unexcused absences is caught", same(broken.by["1004"].unexcusedAbsentDates, []));
}
{
  // 4. The rebuild not writing the new lists at all.
  const broken = await runRebuild(loadRebuild((s) => breakOnce(s,
    "        unexcusedTardyDates: m ? sorted(m.unexTardy) : [],\n", "", "unwritten")));
  check("TEETH: a rebuild that never writes the list is caught",
    broken.marks.every((r) => !("unexcusedTardyDates" in r)));
}
{
  // 5. The screen ignoring the exact list.
  const broken = loadRoster((s) => breakOnce(s, "if (Array.isArray(r.unexcusedTardyDates)) {", "if (false) {", "exact"));
  const w = broken.perfectWindows("2026-10-01", "2026-08-12");
  check("TEETH: a screen that ignores the exact list never forgives an excused tardy",
    perfect(broken, exact.excusedTardyOnly, w.year) === false);
}
{
  // 6. The old fallback put back: an un-rebuilt row forgiven early.
  const broken = loadRoster((s) => breakOnce(s,
    "    } else if (!countExcused) {\n      // A ROW THE REBUILD HAS NOT REFILLED YET",
    "    } else if (true) {\n      // A ROW THE REBUILD HAS NOT REFILLED YET", "fallback"));
  const w = broken.perfectWindows("2026-10-01", "2026-08-12");
  check("TEETH: forgiving un-rebuilt rows early puts a mixed-day child on the list",
    perfect(broken, old.bothTardies, w.year) === true);
}
{
  // 7. Excused tardies counting again for rebuilt rows: the rule before 2026-10-01.
  const broken = loadRoster((s) => breakOnce(s,
    "tardies = datesInWindow(r.unexcusedTardyDates, win);", "tardies = datesInWindow(r.tardyDates, win);", "old-rule"));
  const w = broken.perfectWindows("2026-10-01", "2026-08-12");
  check("TEETH: excused tardies counting again under the strict default is caught",
    perfect(broken, exact.excusedTardyOnly, w.year) === false);
}
{
  // 8. Forgiving absences by subtraction even when the exact list is there.
  const broken = loadRoster((s) => breakOnce(s,
    "absences = Array.isArray(r.unexcusedAbsentDates)", "absences = false", "abs-exact"));
  const w = broken.perfectWindows("2026-10-01", "2026-08-12");
  check("TEETH: a forgiving box that forgives a plain absence beside an excused one is caught",
    perfect(broken, exact.mixedAbsence, w.year, { countExcused: false }) === true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
