// One honest count, who is reached, expectation balance, and what changed.
// Run: npm test
//
// THE OWNER, 2026-10-06: "do 1 through 4, go with your suggestions".
//
//   1. One honest count of one-to-one praise, in CLICKS (presses of Award),
//      with "any one-student award" beneath it.
//   2. Reach: who is being noticed, by campus for everyone, by grade and by
//      name for admins, superadmins and the PBIS team only, BY ROLE.
//   3. Expectation balance, like for like, with a many-adults check.
//   4. An outcome adults do not control (unexcused tardies, part-day
//      absences) beside the praise, by campus, never named.
//
// AND THE REVIEW OF 2026-10-06, each point run below: #3's ratio like for
// like; the tardy line's freshness fence (server half in
// convex/cashInsightsRules.test.mjs); the whole-school cell greyed when a
// campus is; the one-to-one ratio a reading, never graded; the school gauge
// and Trends in one unit; no grade figure for a teacher on the Data
// Dashboard; the click model kept off the page-load and sign-in paths; the
// adult share for admins and PBIS only; event-only students tagged; a late
// answer thrown away after a wipe; names escaped.
//
// THE SHIPPED CODE RUNS: the functions are lifted out of script.js and run
// against a small fake DOM with the real wildcat-roster.js and
// wildcat-store.js, and the trendsContext the screens are given is built by
// the server's own pure rule (convex/cashInsightsRules.ts, transpiled). Then
// each load-bearing line is re-broken in a copy of the source to prove a
// check notices.

// The school's calendar day is Los Angeles, set before any Date is made.
process.env.TZ = "America/Los_Angeles";

import { readFileSync } from "node:fs";
import ts from "typescript";

const scriptSrc = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const rosterSrc = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
const storeSrc = readFileSync(new URL("./wildcat-store.js", import.meta.url), "utf8");
const insightsSrc = readFileSync(new URL("./convex/cashInsights.ts", import.meta.url), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = strip(scriptSrc);

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

// ---------------------------------------------------------------- the harness

/** One 8-space-indented top-level function, whole, out of a copy of script.js. */
function liftFn(src, name) {
  const m = new RegExp("\\n        (?:async )?function " + name + "\\(").exec(src);
  if (!m) throw new Error("missing function " + name);
  const start = m.index + 1;
  const end = src.indexOf("\n        }\n", start);
  if (end < 0) throw new Error("unterminated function " + name);
  return src.slice(start, end + 10);
}
function liftConst(src, name) {
  const m = new RegExp("^        const " + name + " = [^\\n]*;$", "m").exec(src);
  if (!m) throw new Error("missing const " + name);
  return m[0];
}
function breakOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`teeth "${label}": anchor not found exactly once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}
function breakAll(src, from, to, n, label) {
  const count = src.split(from).length - 1;
  if (count !== n) throw new Error(`teeth "${label}": anchor found ${count} times, expected ${n}`);
  return src.split(from).join(to);
}
function dateAt(nowMs) {
  const Real = globalThis.Date;
  return class extends Real {
    constructor(...a) { if (a.length) super(...a); else super(nowMs); }
    static now() { return nowMs; }
  };
}
function loadModules() {
  const sandbox = {};
  for (const src of [rosterSrc, storeSrc]) new Function("globalThis", src).call(sandbox, sandbox);
  return sandbox;
}
const MODS = loadModules();
const R = MODS.WildcatRoster;

function makeEl(id) {
  const cls = new Set();
  return {
    id, innerHTML: "", textContent: "", value: "", hidden: false, style: {},
    classList: {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      toggle: (c, on) => { const v = on === undefined ? !cls.has(c) : !!on; v ? cls.add(c) : cls.delete(c); return v; },
      contains: (c) => cls.has(c),
    },
  };
}
function makeDom(opts = {}) {
  const els = {};
  const byId = (id) => {
    if (!new RegExp(`\\bid="${id}"`).test(html)) return null;
    return els[id] || (els[id] = makeEl(id));
  };
  const subtabs = ["dashboardSubtab", "teacherInteractionsSubtab", "transactionsSubtab", "trendsSubtab"];
  const panes = ["analyticsDashboard", "analyticsTeacherInteractions", "analyticsTransactions", "analyticsTrends"];
  return {
    els,
    getElementById: byId,
    querySelectorAll: (sel) => {
      if (sel === ".analytics-subtab") return subtabs.map(byId);
      if (sel === ".analytics-subtab-content") return panes.map(byId);
      if (sel === ".grade-filter-checkbox:checked") return (opts.grades || ["6", "7", "8", "9", "10", "11", "12"]).map((v) => ({ value: v }));
      if (sel === ".campus-filter-checkbox:checked") return (opts.campuses || ["middle", "high"]).map((v) => ({ value: v }));
      return [];
    },
    text: () => Object.values(els).map((e) => e.innerHTML + " " + e.textContent).join(" "),
  };
}

const FNS = [
  "escapeHtml", "wcIsoDay", "enrolledStudents", "reversedCashIds", "isCashBehaviourRow", "cashBehaviourKind",
  "cashStaffViewsAllowed", "wipeStaffCashViews", "applyCashAnalyticsGate", "cashRatioVerdict", "cashRatioHtml",
  "setCashRatioTile", "switchAnalyticsSubtab", "updateDashboard", "updateCashAnalytics", "updateTeacherInteractions",
  "updateTeacherActivityTable", "updateInterventionStudents", "updateTeacherInteractionDetails",
  "populateTeacherFilterDropdown", "cashWeekMonday", "cashWeekLabel", "cashTrendWeeks", "cashTrendShare", "cashTrendsHtml",
  "renderCashTrends", "cashLedgerChanged", "cashNoteKey", "cashAddDays", "cashClickModel", "cashClicksNow", "cashCountUnit",
  "setCashCountUnit", "cashRatioPlain", "cashRatioPlainHtml", "cashClickTotals", "cashSchoolClickWindow", "cashSchoolWeekClicks", "cashLastFinishedMonday",
  "cashFinishedMondays", "cashStudentGroups", "cashPraiseWeeks", "cashReachWindow", "cashReachModel", "cashNoticeDefaultSince",
  "cashNoticeSinceFor", "setCashNoticeSince", "cashNeverNoticed", "cashExpectationBalance", "cashOutcomeWeeks", "cashShortDate",
  "cashPraiseHtml", "cashShareWords", "cashReachHtml", "cashNeverNoticedHtml", "cashOutcomeHtml", "cashBalanceHtml",
  "cashPaneOpen", "cashTrendsContextNow", "cashNoticeMarksNow", "loadCashTrendsContext", "loadCashNeverNoticedMarks",
  "dashSelectedGrades",
];
const CONSTS = [
  "CASH_STAFF_VIEW_ROLES", "CASH_RATIO_GOAL", "CASH_RATIO_MIN_DEDUCTIONS", "CASH_LAUNCH_WEEK", "CASH_TREND_GRADES",
  "CASH_CORE_EXPECTATIONS", "CASH_EXPECTATION_ORDER", "CASH_EXPECTATION_NAMES", "CASH_CLICK_GAP_MS", "CASH_CLICK_WHOLE",
  "CASH_REACH_SCHOOL_DAYS", "CASH_BALANCE_WEEKS", "CASH_MANY_ADULTS_MIN", "CASH_MANY_ADULTS_TOP_SHARE",
  "CASH_NAMED_LIST_MAX_SHARE", "CASH_OUTCOME_WEEKS_NEEDED", "CASH_MARKS_MIN_COVERAGE", "CASH_TRENDS_CONTEXT_MS",
  "CASH_COUNT_UNIT_KEY", "CASH_PART_DAY_QUESTION_FROM",
];
/** Counts every build of the click model, so "not on this path" can be checked. */
const counted = (src) => breakOnce(breakOnce(src, "        function cashClickModel(rows, reversedIds) {\n",
  "        function cashClickModel(rows, reversedIds) {\n            G.clickCalls = (G.clickCalls || 0) + 1;\n", "count-clicks"),
  "        function renderCashTrends() {\n", "        function renderCashTrends() {\n            G.renders = (G.renders || 0) + 1;\n", "count-renders");

function loadApp(src, G) {
  const body = `
    let currentUser = G.currentUser || null;
    let teachers = G.teachers || [];
    let students = G.students || [];
    let cashTransactions = G.cashTransactions || [];
    let auditLog = [];
    let _historyCutoffMs = G.cutoffMs === undefined ? null : G.cutoffMs;
    let _interventionReversedIds = null;
    let _cashLedgerVersion = 0, _cashClickMemo = null, _cashTrendsCtx = null, _cashNoticeMarks = null, _cashNoticeGen = 0;
    let _cashNoticeSince = null, _cashCountUnitHere = null, _cashTrendsDrawnForStaff = false, _cashBalanceDrawnForStaff = false;
    let _paCache = G.paCache || null;
    const localStorage = G.localStorage;
    const document = G.document;
    const window = G.window;
    const Date = G.Date || globalThis.Date;
    const console = { log() {}, warn() {}, error() {} };
    function activeTeacherRoster() { return null; }
    function paginate(key, rows) { return { slice: rows, page: 1, pages: 1, total: rows.length }; }
    function renderPager() {}
    ${CONSTS.map((n) => liftConst(src, n)).join("\n")}
    ${FNS.map((n) => liftFn(src, n)).join("\n")}
    return {
      set(k, v) {
        if (k === "currentUser") currentUser = v;
        else if (k === "cashTransactions") cashTransactions = v;
        else if (k === "students") students = v;
        else throw new Error("unknown global " + k);
      },
      state: () => ({ marks: _cashNoticeMarks, ctx: _cashTrendsCtx, gen: _cashNoticeGen, memo: _cashClickMemo,
                      drawnForStaff: _cashTrendsDrawnForStaff, balanceForStaff: _cashBalanceDrawnForStaff }),
      ${FNS.join(", ")}
    };`;
  return new Function("G", body)(G);
}

/** The server's own pure rule, transpiled: the trendsContext the screens are given. */
const rulesJs = ts.transpileModule(readFileSync(new URL("./convex/cashInsightsRules.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const RULES = await import("data:text/javascript;base64," + Buffer.from(rulesJs).toString("base64"));

// ---------------------------------------------------------------- the world
// Today is Tuesday 2026-10-06, 10:00 in Los Angeles. Cash history starts 9/14.
const NOW = new Date(2026, 9, 6, 10, 0).getTime();
const CUTOFF = new Date(2026, 8, 14, 8, 30).getTime();
const T = (m, d, h = 10, mi = 0, s = 0, ms = 0) => new Date(2026, m - 1, d, h, mi, s, ms).getTime();
let seq = 0;
/** One ledger row. Awards default to Be Respectful (wc2), deductions to Not Being Respectful (wc6). */
function row(o) {
  const kind = o.kind || "award";
  return {
    id: o.id || "r" + (++seq), kind, type: kind === "deduct" ? "negative" : "positive", amount: kind === "deduct" ? -100 : 100,
    teacherId: o.t === undefined ? "T1" : o.t, teacherName: "Ms. Lee", studentId: o.s, studentName: "Hidden Name",
    behaviorId: o.b || (kind === "deduct" ? "wc6" : "wc2"), behaviorName: o.name || (kind === "deduct" ? "Not Being Respectful" : "Be Respectful"),
    notes: o.note === undefined ? "a note" : o.note, timestamp: new Date(o.at).toISOString(),
  };
}
/** One press of Award to several students: rows 400 ms apart. */
const press = (o, ids, gap = 400) => ids.map((s, i) => row({ ...o, s, at: o.at + i * gap }));

const STAFF = [
  { id: "T1", name: "Ms. Lee", role: "teacher" }, { id: "T2", name: "Mr. Park", role: "teacher" },
  { id: "T3", name: "Mx. Quinn", role: "teacher" }, { id: "T4", name: "Dr. Fourth", role: "teacher" },
  { id: "P1", name: "Pat PBIS", role: "pbis" }, { id: "A1", name: "Dr. Admin", role: "admin" },
  { id: "S1", name: "Owner Person", role: "superadmin" },
  { id: "C1", name: "Casey Aide", role: "campusaide", attendanceWatch: true },
];
const by = (id) => STAFF.find((s) => s.id === id);
const PARK = by("T2"), PBIS = by("P1"), ADMIN = by("A1"), SUPER = by("S1"), AIDE = by("C1");
const kid = (n, grade, extra = {}) => ({ id: "s" + n, studentNumber: "N" + n, firstName: "Stu" + n, lastName: "Last" + n, grade: String(grade), ...extra });

/** Monday-Friday school days from 9/2 to 10/5 (9/7 a holiday), and a run table built 03:15 on 10/6. */
const SCHOOL_DAYS = (() => {
  const out = [];
  for (let d = new Date(2026, 8, 2, 12); d <= new Date(2026, 9, 5, 12); d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (dow >= 1 && dow <= 5 && iso !== "2026-09-07") out.push(iso);
  }
  return out;
})();
function contextFor(o = {}) {
  const days = o.days || SCHOOL_DAYS;
  const runDays = [];
  for (const date of days) {
    runDays.push({ date, band: "6-8", members: 100, absentDays: 12, fullDaysStrict: 2, misrecordDaysByGap: [2, 1, 0], partialDays: 7,
                   assumedPresentDays: 0, syncedAt: o.builtAt || "2026-10-06T10:15:00.000Z" });
    runDays.push({ date, band: "9-12", members: 50, absentDays: 6, fullDaysStrict: 1, misrecordDaysByGap: [0, 0, 0], partialDays: 5,
                   assumedPresentDays: 0, syncedAt: o.builtAt || "2026-10-06T10:15:00.000Z" });
  }
  const marks = (o.marks || []).map((m) => ({ syncedAt: o.marksAt || "2026-10-06T13:30:00.000Z", ...m }));
  const out = RULES.outcomeWeeks({ runDays, marks, today: "2026-10-06" });
  return { allowed: true, yearid: 36, ...out, rosterStaff: o.roster || { count: 3, ids: [["T1", "k1"], ["T2", "k2"], ["P1", "k3"]] },
           marksRows: o.marksRows === undefined ? out.marksRows : o.marksRows };
}

function world(src, o = {}) {
  const dom = makeDom(o);
  const G = {
    currentUser: o.currentUser || PBIS, teachers: o.teachers || STAFF, students: o.students || [], cashTransactions: o.rows || [],
    cutoffMs: o.cutoffMs === undefined ? CUTOFF : o.cutoffMs, document: dom, Date: dateAt(o.now || NOW), paCache: o.paCache,
    localStorage: o.localStorage || { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); } },
    queries: [],
  };
  G.window = Object.assign({}, MODS, {
    WildcatAuth: {
      getSession: () => ({ idToken: "tok" }),
      convexQuery: async (name, args) => {
        G.queries.push(name);
        if (o.server) return o.server(name, args, G);
        if (name === "cashInsights:trendsContext") return o.ctx === undefined ? contextFor() : o.ctx;
        if (name === "attendanceList:attendanceMarks") return o.marks === undefined ? { allowed: true, rows: [] } : o.marks;
        throw new Error("unexpected query " + name);
      },
    },
  });
  const app = loadApp(o.count ? counted(src) : src, G);
  if (o.tabOpen !== false) dom.getElementById("cashAnalyticsTab").classList.add("active");
  return { dom, app, G };
}
const el = (w, id) => w.dom.getElementById(id);
const settle = () => new Promise((r) => setImmediate(r));
/** Open Cash Analytics > Trends the way a person does, and let both reads land. */
async function openTrends(w) {
  w.app.switchAnalyticsSubtab("trends");
  await settle(); await settle();
  return el(w, "cashTrendsBody").innerHTML;
}
const clicksOf = (src, rows, reversed = []) => world(src).app.cashClickModel(rows, new Set(reversed)).clicks;
const sizes = (clicks) => clicks.map((c) => c.size).join(",");

// ==================================================================== 1
console.log("\n1. A click is one press of Award");
{
  const base = T(9, 22, 10);
  const c1 = clicksOf(scriptSrc, [row({ s: "a", at: base }), row({ s: "b", at: base + 4900 })]);
  check("rows 4.9 s apart are one click", c1.length === 1 && c1[0].size === 2, sizes(c1));
  const c2 = clicksOf(scriptSrc, [row({ s: "a", at: base }), row({ s: "b", at: base + 5100 })]);
  check("rows 5.1 s apart are two", c2.length === 2, sizes(c2));
  const chain = [row({ s: "a", at: base }), row({ s: "b", at: base + 4000 }), row({ s: "c", at: base + 8000 })];
  check("three rows 4 s apart (8 s end to end) are ONE click: each is compared with the one before",
    clicksOf(scriptSrc, chain).length === 1 && clicksOf(scriptSrc, chain)[0].size === 3);
  const split = [row({ s: "a", at: base }), row({ s: "b", at: base + 100, note: "other words" }),
                 row({ s: "c", at: base + 200, b: "wc3" }), row({ s: "d", at: base + 300, t: "T2" })];
  check("a different note, behaviour or adult is a different click", clicksOf(scriptSrc, split).length === 4);
  check("an award and a deduction never share a click, even with one behaviour id and note",
    clicksOf(scriptSrc, [row({ s: "a", at: base, b: "wc2" }), row({ s: "b", at: base + 100, b: "wc2", kind: "deduct" })]).length === 2);
  check("rows with no adult are never merged",
    clicksOf(scriptSrc, [row({ s: "a", at: base, t: "" }), row({ s: "b", at: base + 100, t: "" })]).length === 2);
  const dup = clicksOf(scriptSrc, [row({ s: "a", at: base }), row({ s: "a", at: base + 100 }), row({ s: "b", at: base + 200 })]);
  check("size counts distinct students", dup.length === 1 && dup[0].size === 2 && dup[0].sizeClass === "small");
  const classes = clicksOf(scriptSrc, [...press({ at: base }, ["a"]), ...press({ at: base + 60000, note: "n2" }, ["a", "b", "c", "d"]),
    ...press({ at: base + 120000, note: "n3" }, ["a", "b", "c", "d", "e"])]);
  check("one student, two to four (small group), five or more (whole class)", classes.map((c) => c.sizeClass).join() === "one,small,whole");
}

// ==================================================================== 2
console.log("\n2. Size is counted before reversals; what is counted is what is live");
{
  const base = T(9, 22, 10);
  const pair = press({ at: base, note: "pair" }, ["a", "b"]);
  const c = clicksOf(scriptSrc, pair, [pair[0].id]);
  check("a two-student award with one row reversed stays a small-group click", c.length === 1 && c[0].sizeClass === "small" &&
    c[0].liveStudents.join() === "b");
  check("...and the survivor is NOT a one-student award, nor one-to-one", c[0].sizeClass !== "one" && c[0].oneToOne === false);
  const whole = press({ at: base, note: "class" }, ["a", "b", "c", "d", "e", "f"]);
  const { app } = world(scriptSrc);
  const p = app.cashPraiseWeeks({ model: app.cashClickModel(whole, new Set(whole.map((r) => r.id))), cutoffIso: "2026-09-14", todayIso: "2026-10-06" });
  check("a whole-class click reversed in full counts nowhere", p.weeks.every((w) => w.clicks.awards === 0 && w.students.awards === 0));
}

// ==================================================================== 3
console.log("\n3. One-to-one: a one-student award whose note that adult gave no one else that day");
function oneToOneCase(src) {
  const day = (d, h, mi = 0) => T(9, d, h, mi);
  const rows = [
    // T1 reuses "nice focus" with a 30-student press and a one-student press: not one-to-one.
    ...press({ at: day(22, 9), note: "Nice focus" }, Array.from({ length: 30 }, (_, i) => "c" + i)),
    row({ s: "x1", at: day(22, 13), note: "nice focus" }),
    // ...and in another one-student press to a different child.
    row({ s: "x2", at: day(22, 11), note: "kept going" }), row({ s: "x3", at: day(22, 14), note: "kept going" }),
    // T2's identical note does not count against T1, nor T1's against T2.
    row({ s: "x4", at: day(22, 15), note: "unique words", t: "T2" }), row({ s: "x5", at: day(22, 15, 30), note: "unique words" }),
    // The same note the NEXT day: one-to-one again.
    row({ s: "x6", at: day(23, 10), note: "nice focus" }),
    // The same note to the same child twice, an hour apart: still one-to-one.
    row({ s: "x7", at: day(24, 9), note: "Helped Sam" }), row({ s: "x7", at: day(24, 10), note: "Helped Sam" }),
    // "Great job " and "great  job" are the same words.
    row({ s: "x8", at: day(25, 9), note: "Great job " }), row({ s: "x9", at: day(25, 10), note: "great  job" }),
    // 5:30 PM in Los Angeles is that school day's, not UTC's next day: this
    // note was used for someone else on the 28th in UTC terms only.
    row({ s: "y1", at: day(28, 17, 30), note: "evening note" }), row({ s: "y2", at: T(9, 29, 9), note: "evening note" }),
  ];
  const clicks = world(src).app.cashClickModel(rows, new Set()).clicks;
  const ofStudent = (s) => clicks.find((c) => c.size === 1 && c.students[0] === s);
  return { clicks, ofStudent };
}
{
  const { ofStudent, clicks } = oneToOneCase(scriptSrc);
  check("a note the same adult gave a whole class that day: not one-to-one", ofStudent("x1").oneToOne === false);
  check("...but it IS a one-student award (the loose count)", ofStudent("x1").sizeClass === "one");
  check("a note the same adult gave another child in another one-student press: neither is one-to-one",
    ofStudent("x2").oneToOne === false && ofStudent("x3").oneToOne === false);
  check("another adult's identical note does not count against it", ofStudent("x4").oneToOne === true && ofStudent("x5").oneToOne === true);
  check("the same note the next day is one-to-one", ofStudent("x6").oneToOne === true);
  check("the same note to the same child twice is still one-to-one", clicks.filter((c) => c.students[0] === "x7").every((c) => c.oneToOne));
  check("'Great job ' and 'great  job' are one note (reuse)", ofStudent("x8").oneToOne === false && ofStudent("x9").oneToOne === false);
  check("5:30 PM in Los Angeles is that school day's: different days, both one-to-one",
    ofStudent("y1").oneToOne === true && ofStudent("y2").oneToOne === true && ofStudent("y1").day === "2026-09-28");
  check("the note is a comparison key: trimmed, collapsed, lower case", world(scriptSrc).app.cashNoteKey("  Great \t JOB ") === "great job");
}

// ==================================================================== 4
console.log("\n4. Deductions: two to four students at once is a group deduction (owner's rule)");
function deductionWeek(src) {
  const at = T(9, 22, 10);
  const rows = [row({ s: "a", kind: "deduct", at, note: "d1" }), ...press({ kind: "deduct", at: at + 60000, note: "d3" }, ["b", "c", "d"]),
                row({ s: "e", at: at + 120000, note: "praise" })];
  const { app } = world(src);
  return app.cashPraiseWeeks({ model: app.cashClickModel(rows, new Set()), cutoffIso: "2026-09-14", todayIso: "2026-10-06" })
    .weeks.find((w) => w.monday === "2026-09-21");
}
{
  const w = deductionWeek(scriptSrc);
  check("a three-student deduction is a group deduction, not individual", w.clicks.deductOne === 1 && w.clicks.deductGroup === 1,
    JSON.stringify(w.clicks));
  check("...so the one-to-one ratio's bottom is one", w.oneToOneRatio.label === "too few deductions to judge" && w.clicks.oneToOne === 1);
  check("...and in students it is three students in the group column", w.students.deductGroup === 3 && w.students.deductOne === 1);
}

// ==================================================================== 5
console.log("\n5. The ratios, the clicks | students switch, and the control");
function ratioWorld(src, o = {}) {
  const at = T(9, 22, 9);
  const rows = [
    ...press({ at, note: "class" }, ["s1", "s2", "s3", "s4", "s5", "s6"]),
    row({ s: "s1", at: at + 3600000, note: "personal" }),
    ...[0, 1, 2, 3].map((i) => row({ s: "s" + (i + 1), kind: "deduct", at: at + 7200000 + i * 60000, note: "d" + i })),
    // An event behaviour (Spirit Week): left out, and counted as such.
    ...press({ at: at + 9000000, b: "wc_custom_1", name: "Spirit Week (ASB ONLY)", note: "spirit" }, ["s1", "s2"]),
  ];
  const students = [1, 2, 3, 4, 5, 6].map((n) => kid(n, n <= 3 ? 7 : 10));
  return world(src, { rows, students, ...o });
}
{
  const w = ratioWorld(scriptSrc);
  const html1 = await openTrends(w);
  const praise = w.app.cashPraiseWeeks({ model: w.app.cashClicksNow(), cutoffIso: "2026-09-14", todayIso: "2026-10-06" });
  const wk = praise.weeks.find((x) => x.monday === "2026-09-21");
  check("four deductions: 'too few deductions to judge', in both units", wk.verdict.clicks.label === "too few deductions to judge" &&
    wk.verdict.students.label === "too few deductions to judge");
  check("no deductions at all: 'no deductions'", praise.weeks.find((x) => x.monday === "2026-09-14").verdict.clicks.label === "no deductions");
  check("clicks: 2 award presses (one whole class, one personal) to 4 deductions",
    wk.clicks.awards === 2 && wk.clicks.awardWhole === 1 && wk.clicks.awardOne === 1 && wk.clicks.deductions === 4);
  check("students: 7 awards (six and one) to 4", wk.students.awards === 7 && wk.students.awardWhole === 6);
  check("the one-to-one ratio is one per press in both units", wk.clicks.oneToOne === 1 && wk.students.oneToOne === 1 &&
    wk.clicks.deductOne === 4 && wk.students.deductOne === 4);
  const trend = w.app.cashTrendWeeks({ rows: w.G.cashTransactions, reversedIds: new Set(), staff: STAFF, students: [],
    campusOf: MODS.WildcatStore.studentCampusOf, cutoffIso: "2026-09-14", todayIso: "2026-10-06" }).weeks.find((x) => x.monday === "2026-09-21");
  check("CONTROL: students + left out = the old per-row count, week by week (nothing existing moved)",
    wk.students.awards + wk.students.deductions + wk.students.leftOut === trend.awards + trend.deductions && wk.students.leftOut === 2,
    `${wk.students.awards}+${wk.students.deductions}+${wk.students.leftOut} vs ${trend.awards}+${trend.deductions}`);
  check("the table opens in clicks", /counted in <b>clicks<\/b>/.test(html1) && /aria-pressed="true">Clicks</.test(html1));
  w.app.setCashCountUnit("students");
  const html2 = el(w, "cashTrendsBody").innerHTML;
  check("the switch moves to students and the split cells change", /counted in <b>students<\/b>/.test(html2) &&
    /aria-pressed="true">Students</.test(html2) && w.G.localStorage.store.wcCashCountUnit === "students");
  const weekRow = (h) => h.split("<tr>").find((r) => /Sep 21–25/.test(r)) || "";
  check("...the all-awards ratio's n moves (3 to 4 presses, 9 to 4 students: the Spirit Week press counts there) but never the one-to-one ratio's (1 to 4)",
    /wc-insight-n">3 to 4</.test(weekRow(html1)) && /wc-insight-n">9 to 4</.test(weekRow(html2)) &&
    /wc-insight-n">1 to 4</.test(weekRow(html1)) && /wc-insight-n">1 to 4</.test(weekRow(html2)), weekRow(html2).slice(0, 400));
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const wt = ratioWorld(scriptSrc, { localStorage: throwing });
  check("with storage throwing, the page renders in clicks", /counted in <b>clicks<\/b>/.test(await openTrends(wt)));
  wt.app.setCashCountUnit("students");
  check("...and the switch still works for this tab", /counted in <b>students<\/b>/.test(el(wt, "cashTrendsBody").innerHTML));
  const plain = w.app.cashRatioPlain(30, 10);
  const plainHtml = w.app.cashRatioPlainHtml(plain);
  check("the one-to-one ratio is a reading: never 'goal', never amber or green",
    plain.label === "3.0 to 1" && plain.tone === "neutral" && !/goal/.test(plainHtml) && !/is-below|is-meets/.test(plainHtml) &&
    !/goal/.test(w.app.cashRatioPlainHtml(w.app.cashRatioPlain(1, 0))) && !/goal/.test(w.app.cashRatioPlainHtml(w.app.cashRatioPlain(1, 3))));
}

// ==================================================================== 6
console.log("\n6. Events and custom behaviours are left out by id, and listed");
function eventCase(src, withEvent) {
  const at = T(9, 22, 9);
  const rows = [
    row({ s: "s1", at, note: "personal" }),
    // A core behaviour RENAMED: still Be Respectful, by id.
    row({ s: "s2", at: at + 60000, note: "renamed", b: "wc2", name: "Respect" }),
    ...(withEvent ? [row({ s: "s3", at: at + 120000, b: "wc_custom_1790276383280", name: "Spirit Week (ASB ONLY)", note: "only one of these" })] : []),
  ];
  const students = [1, 2, 3].map((n) => kid(n, 7));
  const w = world(src, { rows, students, now: T(10, 6, 10) });
  const model = w.app.cashClickModel(rows, new Set());
  const praise = w.app.cashPraiseWeeks({ model, cutoffIso: "2026-09-14", todayIso: "2026-10-06" }).weeks.find((x) => x.monday === "2026-09-21");
  const campusOf = MODS.WildcatStore.studentCampusOf;
  const reach = w.app.cashReachModel({ model, students, campusOf, window: { source: "calendar", dates: ["2026-09-22"] }, todayIso: "2026-10-06" });
  const never = w.app.cashNeverNoticed({ model, students, campusOf, from: "2026-09-14", through: "2026-10-05" });
  const bal = w.app.cashExpectationBalance({ model, students, campusOf, todayIso: "2026-10-06", cutoffIso: "2026-09-14" });
  return { praise, reach, never, bal, html: w.app.cashBalanceHtml(bal, false) };
}
{
  const a = eventCase(scriptSrc, false), b = eventCase(scriptSrc, true);
  check("an event one-student award with a unique note changes no click class and no one-to-one count",
    JSON.stringify([a.praise.clicks.awards, a.praise.clicks.awardOne, a.praise.clicks.oneToOne]) ===
    JSON.stringify([b.praise.clicks.awards, b.praise.clicks.awardOne, b.praise.clicks.oneToOne]));
  check("...no reach figure", JSON.stringify(a.reach.any) === JSON.stringify(b.reach.any) && JSON.stringify(a.reach.oneToOne) === JSON.stringify(b.reach.oneToOne));
  check("...no balance cell", JSON.stringify(a.bal.rows) === JSON.stringify(b.bal.rows));
  check("...and is counted as left out, and listed by name under Other behaviours",
    b.praise.clicks.leftOut === 1 && a.praise.clicks.leftOut === 0 && /Spirit Week \(ASB ONLY\): 1 award, 0 deductions/.test(b.html));
  check("an event award is not being noticed: the child is still on the no-award list, TAGGED event award only",
    b.never.rows.some((r) => r.id === "s3" && r.eventOnly === true) && b.never.counts.eventOnly.all === 1 && b.never.counts.none.all === 0 &&
    a.never.rows.some((r) => r.id === "s3" && r.eventOnly === false));
  check("a renamed core behaviour still counts as Be Respectful, by id",
    b.bal.rows.find((r) => r.expectation === "respectful").cells.all.oneToOne === 2 && b.praise.clicks.oneToOne === 2);
}

// ==================================================================== 7
console.log("\n7. Reach: the school calendar's last ten school days, enrolled now, staff with a class");
function reachCase(src, ctx) {
  const days = SCHOOL_DAYS;
  const rows = [
    // T1 (a class) one-to-one to s1; P1 (PBIS, with a class) one-to-one to s2;
    // T3 (no class) one-to-one to s3; T2 a whole class.
    row({ s: "s1", at: T(10, 1, 9), note: "a" }), row({ s: "s2", at: T(10, 1, 10), note: "b", t: "P1" }),
    row({ s: "s3", at: T(10, 1, 11), note: "c", t: "T3" }), row({ s: "s20", at: T(10, 1, 12), note: "c2", t: "A1" }),
    ...press({ at: T(10, 2, 9), note: "class", t: "T2" }, ["s4", "s5", "s6", "s7", "s8"]),
    // Before the window: 9/1 is not in the last ten school days.
    row({ s: "s9", at: T(9, 1, 9), note: "old" }),
    // A student who has left.
    row({ s: "gone", at: T(10, 1, 9, 30), note: "x" }),
  ];
  const students = Array.from({ length: 10 }, (_, i) => kid(i + 1, i < 5 ? 6 : 9));
  const w = world(src, { rows, students });
  const model = w.app.cashClickModel(rows, new Set());
  const win = w.app.cashReachWindow({ ctx, model, todayIso: "2026-10-06" });
  return { w, win, reach: w.app.cashReachModel({ model, students, campusOf: MODS.WildcatStore.studentCampusOf, window: win,
    todayIso: "2026-10-06", roster: ctx && ctx.data ? ctx.data.rosterStaff : null }), days };
}
{
  const ok = { status: "ok", data: contextFor() };
  const r = reachCase(scriptSrc, ok);
  check("the window is the last ten entries of the school calendar", r.win.source === "calendar" &&
    JSON.stringify(r.win.dates) === JSON.stringify(SCHOOL_DAYS.slice(-10)), r.win.dates.join());
  check("denominators are students enrolled now (a leaver is not counted)", r.reach.enrolled.all === 10 && r.reach.any.all === 8,
    JSON.stringify(r.reach.any));
  check("one-student and one-to-one reach", r.reach.one.all === 3 && r.reach.oneToOne.all === 3);
  check("one-to-one from staff with a PowerSchool class counts only roster ids (T1 and PBIS P1, not T3)",
    r.reach.rosterOneToOne.all === 2, JSON.stringify(r.reach.rosterOneToOne));
  check("participation counts roster staff only, out of rosterStaff.count, last finished week",
    JSON.stringify(r.reach.participation) === JSON.stringify({ of: 3, monday: "2026-09-28", any: 3, one: 2, oneToOne: 2 }),
    JSON.stringify(r.reach.participation));
  const loading = reachCase(scriptSrc, { status: "loading", data: null });
  check("while the calendar loads there is no window (no figures that jump when it lands)",
    loading.win.source === "loading" && loading.win.dates.length === 0);
  check("...and the card says it is loading", /Loading the attendance calendar/.test(loading.w.app.cashReachHtml({ reach: loading.reach })));
  const failed = reachCase(scriptSrc, { status: "failed", data: null });
  check("if it fails, the window is the weekdays with any activity, and the card says so",
    failed.win.source === "activity" && failed.win.dates.includes("2026-10-02") &&
    /could not be loaded, so these are the weekdays with any award/.test(failed.w.app.cashReachHtml({ reach: failed.reach })));
  check("with no class list, participation is a dash, never 0",
    failed.reach.participation === null && /award last week: &mdash;/.test(failed.w.app.cashReachHtml({ reach: failed.reach })));
}

// ==================================================================== 8
console.log("\n8. Who sees grades and names: admin, superadmin and PBIS, by role");
const UNNOTICED = (n) => ({ n, grade: n <= 20 ? 7 : 10 });
function roleWorld(src, who, o = {}) {
  // 40 students; every one but s7 (grade 7) and s33 (grade 10) has an award in
  // the window. s33's name would inject if it were not escaped.
  const students = Array.from({ length: 40 }, (_, i) => kid(i + 1, UNNOTICED(i + 1).grade,
    i + 1 === 33 ? { firstName: "<b>Bold</b>", lastName: "Kid" } : {}));
  const rows = [];
  students.forEach((s, i) => { if (s.id !== "s7" && s.id !== "s33") rows.push(row({ s: s.id, at: T(9, 15 + (i % 4), 10, i), note: "SECRET-NOTE-" + i })); });
  rows.push(...[0, 1, 2, 3, 4].map((i) => row({ s: "s" + (i + 1), kind: "deduct", at: T(9, 22, 9, i), note: "SECRET-NOTE-d" + i, t: "T1" })));
  const marks = { allowed: true, rows: [
    { studentNumber: "N7", entryDate: "2026-08-12", absentDates: ["2026-09-15", "2026-09-16", "2026-08-20", "2026-10-09"],
      tardyDates: ["2026-09-21"], unexcusedTardyDates: ["2026-09-21"] },
    { studentNumber: "N33", entryDate: "2026-09-21", absentDates: [], tardyDates: [], unexcusedTardyDates: null },
  ] };
  return world(src, { currentUser: who, students, rows, marks, ...o });
}
for (const who of [by("T2"), AIDE]) {
  const w = roleWorld(scriptSrc, who);
  const out = await openTrends(w);
  w.app.updateCashAnalytics();
  const bal = el(w, "cashAnalyticsDetails").innerHTML;
  check(`${who.role}${who.attendanceWatch ? " (with the attendance grant)" : ""}: no grade rows or grade columns`, !/Grade \d/.test(out));
  check(`${who.role}: no named list and no student name`, !/cashNeverNoticedList/.test(out) && !/Stu7|Last7|Bold/.test(out + bal));
  check(`${who.role}: the campus counts are still there`, /No award since/.test(out) && /Middle School/.test(out));
  check(`${who.role}: no Teacher Interactions link and no adult share in the balance`,
    !/Teacher Interactions/.test(bal) && !/top adult/.test(bal) && !/from \d+ adult/.test(bal));
  check(`${who.role}: the names query was never made`, !w.G.queries.includes("attendanceList:attendanceMarks"));
}
for (const who of [PBIS, ADMIN, SUPER]) {
  const w = roleWorld(scriptSrc, who);
  const out = await openTrends(w);
  w.app.updateCashAnalytics();
  const bal = el(w, "cashAnalyticsDetails").innerHTML;
  check(`${who.role}: grade rows, the named list, the adult share and the link`, /Grade 7/.test(out) && /cashNeverNoticedList/.test(out) &&
    /Stu7 Last7/.test(out) && /top adult/.test(bal) && /Teacher Interactions/.test(bal), who.role);
}
{
  // An admin previewing a teacher: currentUser IS the teacher (applyPreviewVisibility).
  const w = roleWorld(scriptSrc, ADMIN);
  await openTrends(w);
  check("before: the admin's Trends holds names", /Stu7/.test(el(w, "cashTrendsBody").innerHTML) && w.app.state().marks !== null);
  w.app.set("currentUser", by("T2"));
  w.app.applyCashAnalyticsGate();
  check("entering teacher view empties the named list and grade rows from the page and drops the names",
    !/Stu7|Grade 7/.test(w.dom.text()) && w.app.state().marks === null && w.app.state().drawnForStaff === false);
  const asTeacher = await openTrends(w);
  check("...and Trends reopens as the teacher's version", !/Grade 7|Stu7/.test(asTeacher) && /Who is being noticed/.test(asTeacher));
  w.app.set("currentUser", null);
  w.app.applyCashAnalyticsGate();
  check("logout drops the calendar too (it was fetched for someone else)", w.app.state().ctx === null);
}
{
  // THE LATE ANSWER (review, 2026-10-06): the names arrive after a logout.
  let release;
  const gate = new Promise((r) => { release = r; });
  const w = roleWorld(scriptSrc, PBIS, { server: async (name) => {
    if (name === "cashInsights:trendsContext") return contextFor();
    await gate; return { allowed: true, rows: [{ studentNumber: "N7", entryDate: "2026-08-12", absentDates: [], tardyDates: [], unexcusedTardyDates: [] }] };
  } });
  w.app.switchAnalyticsSubtab("trends");
  await settle();
  w.app.set("currentUser", null);
  w.app.applyCashAnalyticsGate();
  release(); await settle(); await settle();
  check("a names answer that lands after a logout is thrown away, not kept in memory", w.app.state().marks === null, JSON.stringify(w.app.state().marks));
  let release2;
  const gate2 = new Promise((r) => { release2 = r; });
  const keeps = breakOnce(scriptSrc, "            if (gen !== _cashNoticeGen || !currentUser || currentUser.id !== who || !cashStaffViewsAllowed()) return;\n", "", "late");
  const wk2 = roleWorld(keeps, PBIS, { server: async (name) => {
    if (name === "cashInsights:trendsContext") return contextFor();
    await gate2; return { allowed: true, rows: [] };
  } });
  wk2.app.switchAnalyticsSubtab("trends");
  await settle();
  wk2.app.set("currentUser", null);
  wk2.app.applyCashAnalyticsGate();
  release2(); await settle(); await settle();
  check("TEETH: without the generation check the late answer is kept", wk2.app.state().marks !== null);
}

// ==================================================================== 9
console.log("\n9. The named list: a working list, with attendance beside it");
{
  const w = roleWorld(scriptSrc, PBIS);
  const out = await openTrends(w);
  const list = out.slice(out.indexOf('id="cashNeverNoticedList"'));
  check("two names, sorted by grade, the HTML in a name escaped", /Stu7 Last7[\s\S]*&lt;b&gt;Bold&lt;\/b&gt; Kid/.test(list) && !/<b>Bold<\/b>/.test(list));
  // Since 9/14 through 10/5 is 16 school days. s7: absent 9/15 and 9/16 (8/20
  // is before the date; 10/9 is not a school day yet), late 9/21.
  check("absence context counts only school days inside the window",
    /Stu7 Last7[\s\S]*?absent \(any period\) on 2 of 16 school days; late without an excuse on 1</.test(list), list.slice(0, 600));
  check("a student who joined after the date is tagged, from their own first day", /Bold[\s\S]*?of 11 school days[\s\S]*?joined Sep 21/.test(list));
  check("a row without tardy codes says so instead of zero", /late days not yet refreshed/.test(list));
  check("no staff name and no note text anywhere on Trends", !/Ms\. Lee|Mr\. Park|Pat PBIS|SECRET-NOTE/.test(out));
  const failed = roleWorld(scriptSrc, PBIS, { marks: { allowed: false, rows: [], reason: "no" } });
  check("an attendance failure still shows the names, with 'attendance context unavailable'",
    /Stu7 Last7[\s\S]*attendance context unavailable/.test(await openTrends(failed)));
  // Seventy of a hundred unnoticed: a tenth is ten.
  const many = Array.from({ length: 100 }, (_, i) => kid(i + 1, 8));
  const rows = many.slice(70).map((s, i) => row({ s: s.id, at: T(9, 22, 9, i), note: "n" + i }));
  const big = world(scriptSrc, { currentUser: PBIS, students: many, rows });
  const bigOut = await openTrends(big);
  check("over a tenth of the school: no names, the count and 'pick an earlier date'",
    /<b>70<\/b> students: too many to be a working list; pick an earlier date/.test(bigOut) && !/Stu1 Last1/.test(bigOut));
  const noCap = breakOnce(scriptSrc, "                overCap: rows.length > CASH_NAMED_LIST_MAX_SHARE * G.enrolled.all\n",
    "                overCap: false\n", "cap");
  const capOff = await openTrends(world(noCap, { currentUser: PBIS, students: many, rows }));
  check("TEETH: remove the tenth-of-the-school cap and 70 names render", (capOff.match(/<li><b>Stu/g) || []).length === 70);
  const picked = roleWorld(scriptSrc, PBIS);
  await openTrends(picked);
  picked.app.setCashNoticeSince("2026-09-28");
  const later = el(picked, "cashTrendsBody").innerHTML;
  check("picking a later date (a shorter window) raises the count -- here past a working list -- and the picker keeps it",
    /value="2026-09-28"/.test(later) && /<b>40<\/b> students: too many to be a working list/.test(later));
  picked.app.setCashNoticeSince("2026-01-01");
  check("a date before the cutoff falls back to the default", /value="2026-09-14"/.test(el(picked, "cashTrendsBody").innerHTML));
}

// ==================================================================== 10
console.log("\n10. Expectation balance: like for like, and the many-adults check");
function balanceOf(src, rows, students) {
  const w = world(src, { rows, students });
  return w.app.cashExpectationBalance({ model: w.app.cashClickModel(rows, new Set()), students,
    campusOf: MODS.WildcatStore.studentCampusOf, todayIso: "2026-10-06", cutoffIso: "2026-09-14" });
}
const MS = Array.from({ length: 120 }, (_, i) => kid(i + 1, 7));
const HS = Array.from({ length: 30 }, (_, i) => kid(i + 201, 10));
/** n individual deductions from each adult in `shares`, to distinct MS students, Be Respectful. */
function deductionsBy(shares, base = 1, students = "s") {
  const out = [];
  let k = base;
  Object.entries(shares).forEach(([t, n]) => { for (let i = 0; i < n; i++) { out.push(row({ s: students + (k++), kind: "deduct", t, at: T(9, 22, 9, k), note: "d" + k })); } });
  return out;
}
const respect = (b) => b.rows.find((r) => r.expectation === "respectful").cells;
{
  const ids = ["wc1", "wc2", "wc3", "wc4", "wc5", "wc6", "wc7", "wc8"];
  const rows = ids.map((b, i) => row({ s: "s" + (i + 1), b, kind: i < 4 ? "award" : "deduct", at: T(9, 22, 10, i), note: "n" + i }))
    // Activity in the weeks of 9/14 and 9/28 (an event award, so no expectation cell moves): school weeks.
    .concat([row({ s: "s9", at: T(9, 15, 10), b: "wc_custom_1", name: "Spirit Week", note: "e1" }),
             row({ s: "s9", at: T(9, 29, 10), b: "wc_custom_1", name: "Spirit Week", note: "e2" })]);
  const b = balanceOf(scriptSrc, rows, MS);
  const cell = (e, f) => b.rows.find((r) => r.expectation === e).cells.all[f];
  check("wc1/wc5 Present, wc2/wc6 Respectful, wc3/wc7 Responsible, wc4/wc8 Safe",
    ["present", "respectful", "responsible", "safe"].every((e) => cell(e, "oneToOne") === 1 && cell(e, "individual") === 1));
  check("the window is the last four finished school weeks (three since the cutoff here: Sep 14 to Oct 2)",
    b.mondays.join() === "2026-09-14,2026-09-21,2026-09-28" && b.from === "2026-09-14" && b.to === "2026-10-02");
  const later = world(scriptSrc).app.cashFinishedMondays("2026-10-27", "2026-09-14").slice(-4);
  check("...four once there are four (never the week in progress)", later.join() === "2026-09-28,2026-10-05,2026-10-12,2026-10-19");
  const like = [
    ...[1, 2, 3, 4, 5].map((i) => row({ s: "s" + i, at: T(9, 22, 9, i), note: "own " + i })),            // 5 one-to-one
    ...[6, 7, 8, 9, 10].map((i) => row({ s: "s" + i, kind: "deduct", t: ["T1", "T2", "T3", "T4", "T1"][i - 6], at: T(9, 22, 10, i), note: "d" + i })),
  ];
  const plus = like.concat(...[0, 1, 2, 3, 4].map((g) => press({ at: T(9, 23, 9, g), note: "grp" + g }, ["s1" + g, "s2" + g])),
    ...[0, 1, 2, 3, 4].map((g) => press({ kind: "deduct", at: T(9, 23, 11, g), note: "dg" + g }, ["s1" + g, "s2" + g])));
  const a = respect(balanceOf(scriptSrc, like, MS)).all, c = respect(balanceOf(scriptSrc, plus, MS)).all;
  check("ten small-group awards and ten small-group deductions leave the ratio alone; they sit in their own columns",
    a.ratio.label === "1.0 to 1" && c.ratio.label === "1.0 to 1" && c.smallAwards === 10 && c.smallDeducts === 10, `${a.ratio.label} ${c.ratio.label}`);
  const top = breakOnce(scriptSrc, "                cell.ratio = cashRatioPlain(cell.oneToOne, cell.individual);",
    "                cell.ratio = cashRatioPlain(cell.oneToOne + cell.smallAwards, cell.individual);", "like-for-like");
  check("TEETH: put small-group awards back on top and the same fixture reads 3.0 to 1",
    respect(balanceOf(top, plus, MS)).all.ratio.label === "3.0 to 1");

  const chk = (shares) => respect(balanceOf(scriptSrc, deductionsBy(shares), MS)).all;
  check("two adults: greyed", chk({ T1: 3, T2: 3 }).check === "concentrated");
  check("three adults at 34/33/33%: passes", chk({ T1: 34, T2: 33, T3: 33 }).check === "spread");
  check("exactly 40% passes", chk({ T1: 4, T2: 3, T3: 3 }).check === "spread", JSON.stringify(chk({ T1: 4, T2: 3, T3: 3 })));
  check("41% is greyed", chk({ T1: 41, T2: 30, T3: 29 }).check === "concentrated");
  check("fewer than five individual deductions: 'too few', not greyed", chk({ T1: 4 }).check === "few");
  const tooTop = breakAll(scriptSrc, "cell.topShare > CASH_MANY_ADULTS_TOP_SHARE", "cell.topShare >= 0.5", 1, "share");
  check("TEETH: '> 0.4' as '>= 0.5' lets 41% through",
    respect(balanceOf(tooTop, deductionsBy({ T1: 41, T2: 30, T3: 29 }), MS)).all.check === "spread");
  // Two adults can never pass the 40% rule (one of them gives half), so the
  // three-adult minimum is pinned from the other side.
  const fourMin = breakOnce(scriptSrc, "        const CASH_MANY_ADULTS_MIN = 3;", "        const CASH_MANY_ADULTS_MIN = 4;", "min");
  check("TEETH: '< 3' as '< 4' greys three adults at 34/33/33",
    respect(balanceOf(fourMin, deductionsBy({ T1: 34, T2: 33, T3: 33 }), MS)).all.check === "concentrated");

  // Each campus led by a different adult at 50% (with 4 adults school-wide,
  // the top one at 25%): the whole school must not read as a school pattern.
  const campuses = deductionsBy({ T1: 5, T2: 5 }, 1).concat(deductionsBy({ T3: 5, T4: 5 }, 201));
  const both = respect(balanceOf(scriptSrc, campuses, MS.concat(HS)));
  check("two campuses, each with one adult at 50%: both campus cells greyed, and the whole school too ('within a campus')",
    both.middle.check === "concentrated" && both.high.check === "concentrated" && both.all.check === "concentrated" && both.all.why === "campus" &&
    both.all.topShare === 0.25, JSON.stringify(both.all));
  const combined = breakOnce(scriptSrc, "                    r.cells.all.check = 'concentrated';\n", "", "campus-grey");
  check("TEETH: judge the whole school on its combined total and it passes",
    respect(balanceOf(combined, campuses, MS.concat(HS))).all.check === "spread");

  const htmlAdmin = world(scriptSrc).app.cashBalanceHtml(balanceOf(scriptSrc, campuses, MS.concat(HS)), true);
  const htmlTeacher = world(scriptSrc).app.cashBalanceHtml(balanceOf(scriptSrc, campuses, MS.concat(HS)), false);
  check("a greyed row reads 'talk with staff, not a school reteach', for everyone",
    /class="wc-insight-grey"/.test(htmlTeacher) && /talk with staff, not a school reteach/.test(htmlTeacher) && /Concentrated within a campus/.test(htmlTeacher));
  check("the adult count and top share for admins and PBIS only; no '%' adult share for a teacher",
    /from 4 adults; top adult 25%/.test(htmlAdmin) && /from 2 adults; top adult 50%/.test(htmlAdmin) &&
    !/top adult|from \d+ adult/.test(htmlTeacher));
  check("the dated Not Being Present line is there, and the old heading is gone",
    /Not Being Present for engagement \(phones, off task\)[\s\S]*Sep 14 &ndash; Oct 2/.test(htmlTeacher) && !/Most Common Behaviors/.test(htmlTeacher));
  check("per-adult counts never leave the model", !JSON.stringify(balanceOf(scriptSrc, campuses, MS.concat(HS))).match(/byAdult|"T[1-4]"/));
}
{
  const evil = [row({ s: "s1", at: T(9, 22, 9), b: "wc_custom_x", name: "__proto__" }),
                row({ s: "s2", at: T(9, 22, 10), b: "wc_custom_y", name: "<img src=x onerror=alert(1)>" })];
  const b = balanceOf(scriptSrc, evil, MS);
  const out = world(scriptSrc).app.cashBalanceHtml(b, true);
  check("a behaviour named __proto__ is only a name (no prototype poisoned), and markup in a name is escaped",
    /__proto__: 1 award/.test(out) && /&lt;img src=x onerror=alert\(1\)&gt;: 1 award/.test(out) && !/<img/.test(out) && ({}).awards === undefined);
}

// ==================================================================== 11
console.log("\n11. The behaviour-change check: rates per 100 students per school day, never a zero it does not know");
function outcomeOf(src, ctxData, o = {}) {
  const students = Array.from({ length: 40 }, (_, i) => kid(i + 1, i < 20 ? 7 : 10));
  const rows = o.rows || [row({ s: "s1", at: T(9, 29, 9), note: "one" }), ...press({ at: T(9, 30, 9), note: "cls" }, ["s2", "s3", "s21", "s22", "s23"])];
  const w = world(src, { rows, students });
  const out = w.app.cashOutcomeWeeks({ ctx: ctxData === null ? null : (ctxData.status ? ctxData : { status: "ok", data: ctxData }),
    model: w.app.cashClickModel(rows, new Set()), students, campusOf: MODS.WildcatStore.studentCampusOf, cutoffIso: "2026-09-14",
    todayIso: "2026-10-06", R });
  return { out, html: w.app.cashOutcomeHtml(out) };
}
const MARKS40 = Array.from({ length: 40 }, (_, i) => ({ gradeLevel: i < 20 ? "7" : "10", entryDate: "2026-08-12", absentDates: [],
  tardyDates: i === 0 ? ["2026-09-29", "2026-09-30"] : [], unexcusedTardyDates: i === 0 ? ["2026-09-29", "2026-09-30"] : [] }));
{
  const { out, html } = outcomeOf(scriptSrc, contextFor({ marks: MARKS40 }));
  const last = out.weeks.find((w) => w.monday === "2026-09-28");
  // 6-8 per day: absent 12, strict 2, misrecord [2, 1, 0] -> at the default
  // threshold (1) the first bucket counts as whole days: full 4, partial 8.
  const expected = 100 * R.absenceSplit({ absentDays: 60, fullDaysStrict: 10, misrecordDaysByGap: [10, 5, 0], partialDays: 35, assumedPresentDays: 0 },
    R.DEFAULT_DAY_SETTINGS).partialDays / 500;
  check("part-day = 100 x absenceSplit(summed components).partialDays / members (8.0, not the raw 7.0)",
    last.campus.middle.part.state === "ok" && Math.abs(last.campus.middle.part.rate - 8) < 1e-9 && Math.abs(expected - 8) < 1e-9,
    JSON.stringify(last.campus.middle.part));
  check("unexcused tardies per 100 student-days (2 in 100 is 2.0)", last.campus.middle.tardy.state === "ok" && last.campus.middle.tardy.rate === 2,
    JSON.stringify(last.campus.middle.tardy));
  check("praise cells: one-to-one 1 of 20 in Middle School, any award 3 of 20", last.campus.middle.oneToOne === 1 && last.campus.middle.any === 3 &&
    last.campus.high.oneToOne === 0 && last.campus.high.any === 3);
  check("weeks before cash history read 'no cash record'", out.weeks[0].preCash && /no cash record/.test(html));
  check("the newest finished week is provisional; a short week shows its day count",
    last.provisional === true && /provisional/.test(html) && /4 school days/.test(html) && /3 school days/.test(html));
  check("the counter: '3 of 10 weeks so far'", /<b>3 of 10 weeks so far\.<\/b>/.test(html));
  check("the fixed caption, with this week's own figure in it (no number that goes stale)",
    /These lines share weeks; this table cannot show that praise caused a change\./.test(html) &&
    /One-to-one praise reached 1 student in the latest finished week \(Sep 28 – Oct 2\)/.test(html) &&
    /a planned push, in the group that got it and not in the others/.test(html) && !/about 60 students/.test(code));
  check("campus level only: no grade, no name, no dollars", !/Grade \d|Stu\d|\$/.test(html));
  const refreshing = outcomeOf(scriptSrc, contextFor({ marks: MARKS40, marksRows: 30 }));
  check("marks under 95% of enrolled (a rebuild mid-way): 'tardy marks refreshing', no rate",
    refreshing.out.weeks.every((w) => w.campus.middle.tardy.state === "refreshing") && /tardy marks refreshing/.test(refreshing.html));
  const stale = outcomeOf(scriptSrc, contextFor({ marks: MARKS40, marksAt: "2026-09-30T13:30:00.000Z" }));
  check("marks not refreshed past 9/29: the last week says so, never a rate",
    stale.out.weeks.find((w) => w.monday === "2026-09-28").campus.middle.tardy.state === "stale" &&
    /tardies not refreshed since Sep 29/.test(stale.html));
  const codes = outcomeOf(scriptSrc, contextFor({ marks: MARKS40.map((m, i) => i ? m : { ...m, unexcusedTardyDates: null }) }));
  check("a marks row without tardy codes: 'tardy codes refreshing'", /tardy codes refreshing/.test(codes.html));
  const pending = outcomeOf(scriptSrc, contextFor({ marks: MARKS40, days: SCHOOL_DAYS.filter((d) => d <= "2026-10-01"), builtAt: "2026-10-02T10:15:00.000Z" }));
  check("a week the run table has not reached: 'attendance not yet in'", /attendance not yet in/.test(pending.html));
  const failedOut = outcomeOf(scriptSrc, { status: "failed", data: null });
  check("trendsContext failed: 'Attendance lines unavailable right now', never zeros",
    /Attendance lines unavailable right now\./.test(failedOut.html) && !/0\.0/.test(failedOut.html));
  check("still loading: says loading", /Loading the attendance calendar/.test(outcomeOf(scriptSrc, null).html));
  const raw = breakOnce(scriptSrc, "                    else if (sp && b.members) part = { state: 'ok', n: sp.partialDays, of: b.members, rate: (100 * sp.partialDays) / b.members };",
    "                    else if (sp && b.members) part = { state: 'ok', n: b.partialDays, of: b.members, rate: (100 * b.partialDays) / b.members };", "raw-partial");
  check("TEETH: use the stored partialDays and the misrecord fixture reads 7.0, not 8.0",
    outcomeOf(raw, contextFor({ marks: MARKS40 })).out.weeks.find((w) => w.monday === "2026-09-28").campus.middle.part.rate === 7);
}

// ==================================================================== 12
console.log("\n12. Privacy across every new panel");
{
  const w = roleWorld(scriptSrc, PBIS);
  const trends = await openTrends(w);
  w.app.updateCashAnalytics();
  const all = trends + el(w, "cashAnalyticsDetails").innerHTML;
  check("note text never appears", !/SECRET-NOTE/.test(all));
  check("staff names never appear", !/Ms\. Lee|Mr\. Park|Mx\. Quinn|Pat PBIS|Dr\. Admin|Casey Aide|Owner Person/.test(all));
  const outsideList = trends.slice(0, trends.indexOf('id="cashNeverNoticedList"')) + trends.slice(trends.indexOf("</ul>", trends.indexOf('id="cashNeverNoticedList"'))) +
    el(w, "cashAnalyticsDetails").innerHTML;
  check("student names appear only inside cashNeverNoticedList", /Stu7/.test(trends) && !/Stu\d|Last\d|Hidden Name/.test(outsideList));
  check("no dollar sign in any new panel", !/\$/.test(all));
}

// ==================================================================== 13
console.log("\n13. The Data Dashboard: clicks, campus for everyone below admin and PBIS, and only while on screen");
function dashWorld(src, who, o = {}) {
  const students = [kid(1, 8), kid(2, 8), kid(3, 7), kid(4, 10)];
  const rows = [
    // Grade 8 only: one award press, six individual deductions -- a grade 8 figure of 0.1 to 1.
    row({ s: "s1", at: T(10, 5, 9), note: "g8" }),
    ...[0, 1, 2, 3, 4, 5].map((i) => row({ s: i % 2 ? "s1" : "s2", kind: "deduct", at: T(10, 5, 10, i), note: "x" + i })),
    // Elsewhere in Middle School, five award presses; High School, five.
    ...[0, 1, 2, 3, 4].map((i) => row({ s: "s3", at: T(10, 5, 11, i), note: "ms" + i })),
    ...[0, 1, 2, 3, 4].map((i) => row({ s: "s4", at: T(10, 5, 12, i), note: "hs" + i })),
  ];
  return world(src, { currentUser: who, students, rows, ...o });
}
{
  const t = dashWorld(scriptSrc, by("T2"), { grades: ["8"], campuses: ["middle"] });
  t.app.applyCashAnalyticsGate();
  t.app.updateDashboard();
  check("a teacher with only grade 8 ticked reads Middle School, never grade 8 (6 to 6 = 1.0, not 0.1)",
    el(t, "avgPositivityRatio").textContent === "1.0 to 1", el(t, "avgPositivityRatio").textContent);
  check("...the filter offers campuses, not grades", el(t, "dashCampusFilter").style.display === "grid" &&
    el(t, "dashGradeFilter").style.display === "none" && el(t, "dashFilterTitle").textContent === "Filter by Campus");
  const p = dashWorld(scriptSrc, PBIS, { grades: ["8"] });
  p.app.applyCashAnalyticsGate();
  p.app.updateDashboard();
  check("PBIS picks grades, and reads grade 8's (1 to 6 = 0.1)", el(p, "avgPositivityRatio").textContent === "0.1 to 1" &&
    el(p, "dashGradeFilter").style.display === "grid");
  const grant = breakOnce(scriptSrc, "            return !!(u && CASH_STAFF_VIEW_ROLES.indexOf(String(u.role || '')) !== -1);",
    "            return !!(u && (CASH_STAFF_VIEW_ROLES.indexOf(String(u.role || '')) !== -1 || u.attendanceWatch === true));", "grant");
  const ga = dashWorld(grant, AIDE, { grades: ["8"], campuses: ["middle"] });
  ga.app.updateDashboard();
  check("TEETH: let the attendance grant in and the aide reads grade 8", el(ga, "avgPositivityRatio").textContent === "0.1 to 1");
  const gw = roleWorld(grant, AIDE);
  check("TEETH: ...and sees the grade rows and the names on Trends", /Grade 7/.test(await openTrends(gw)));

  // The existing screens stay per student (owner, 2026-10-06), so the Data
  // Dashboard never builds the click model, on screen or off.
  const hidden = dashWorld(scriptSrc, PBIS, { tabOpen: false, count: true });
  hidden.app.updateDashboard();
  const onScreen = dashWorld(scriptSrc, PBIS, { count: true });
  onScreen.app.updateDashboard();
  check("updateDashboard never builds the click model (home page or Cash Analytics)",
    !hidden.G.clickCalls && !onScreen.G.clickCalls, String(hidden.G.clickCalls) + "/" + String(onScreen.G.clickCalls));
  const shown = dashWorld(scriptSrc, PBIS, { count: true });
  shown.app.cashClicksNow();
  shown.app.cashClicksNow();
  check("the new panels build it once, and a second read reuses it", shown.G.clickCalls === 1, String(shown.G.clickCalls));
  shown.G.cashTransactions.push(row({ s: "s4", at: T(10, 5, 14), note: "new" }));
  shown.app.cashClicksNow();
  check("a new row is noticed (length)", shown.G.clickCalls === 2);
  // A week replaced in place with the same number of rows: only the counter sees it.
  shown.G.cashTransactions[0] = row({ s: "s2", at: T(10, 5, 9), note: "replaced" });
  shown.app.cashLedgerChanged();
  shown.app.cashClicksNow();
  check("a same-length change is noticed through cashLedgerChanged", shown.G.clickCalls === 3);
  const noVer = breakOnce(scriptSrc, "                m.ver === _cashLedgerVersion) return m.model;", "                true) return m.model;", "memo-ver");
  const nv = dashWorld(noVer, PBIS, { count: true });
  nv.app.cashClicksNow();
  nv.G.cashTransactions[0] = row({ s: "s2", at: T(10, 5, 9), note: "replaced" });
  nv.app.cashLedgerChanged();
  nv.app.cashClicksNow();
  check("TEETH: without the counter in the key, an in-place change is served stale", nv.G.clickCalls === 1);
  check("the ledger's writers bump the counter (a pull, an award, a load)",
    /if \(added && typeof cashLedgerChanged === 'function'\) cashLedgerChanged\(\);/.test(code) &&
    (code.match(/typeof cashLedgerChanged === 'function'/g) || []).length === 3);

  const tw = roleWorld(scriptSrc, by("T2"), { count: true });
  await openTrends(tw);
  const renders = tw.G.renders;
  const before = el(tw, "cashTrendsBody").innerHTML;
  tw.app.switchAnalyticsSubtab("dashboard");
  tw.app.applyCashAnalyticsGate();
  tw.app.switchAnalyticsSubtab("transactions");
  check("a teacher's gate runs (sign-in, every subtab switch) never redraw Trends, and leave the teacher's copy alone",
    tw.G.renders === renders && el(tw, "cashTrendsBody").innerHTML === before, `${renders} -> ${tw.G.renders}`);
  const redraw = breakOnce(counted(scriptSrc), "            if (!allowed) wipeStaffCashViews();\n            return allowed;",
    "            if (!allowed) { wipeStaffCashViews(); renderCashTrends(); }\n            return allowed;", "redraw");
  const rd = roleWorld(redraw, by("T2"));
  await openTrends(rd);
  const r0 = rd.G.renders;
  rd.app.switchAnalyticsSubtab("dashboard");
  check("TEETH: a gate that redraws Trends is caught", rd.G.renders > r0);
  const noWipe = breakOnce(scriptSrc, "                if (trends) trends.innerHTML = '';\n", "", "wipe");
  const nw = roleWorld(noWipe, PBIS);
  await openTrends(nw);
  nw.app.set("currentUser", null);
  nw.app.applyCashAnalyticsGate();
  check("TEETH: remove the wipe line and the names survive logout", /Stu7/.test(nw.dom.text()));
}

// ==================================================================== 14
console.log("\n14. Wiring: the server read, the loaders, the markup, the stamps");
{
  const blank = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
  const q = blank(insightsSrc);
  const handler = q.slice(q.indexOf("export const trendsContext = query({"));
  check("trendsContext calls requireStaff", /await requireStaff\(ctx\);/.test(handler));
  check("it never queries legacyMirror or students", !/query\(\s*["'](legacyMirror|students)["']/.test(q));
  const ret = handler.slice(handler.indexOf("return {"));
  check("its return object carries no firstName, lastName or studentNumber", !/firstName|lastName|studentNumber/.test(ret));
  const named = blank(insightsSrc.replace("      marksRows: out.marksRows,", "      marksRows: out.marksRows,\n      firstName: marks[0]?.firstName,"));
  const namedRet = named.slice(named.indexOf("export const trendsContext")).slice(named.slice(named.indexOf("export const trendsContext")).indexOf("return {"));
  check("TEETH: add firstName to the returned object and the scan sees it", /firstName/.test(namedRet));
  check("the browser asks for it, as a query, from the subtab and never from the renderer",
    /convexQuery\('cashInsights:trendsContext', \{ today: wcIsoDay\(new Date\(\)\) \}/.test(code) &&
    /renderCashTrends\(\);\s*Promise\.all\(\[loadCashTrendsContext\(\), cashStaffViewsAllowed\(\) \? loadCashNeverNoticedMarks\(\) : false\]\)/.test(liftFn(code, "switchAnalyticsSubtab")) &&
    !/convexQuery|fetch\(|loadCash/.test(liftFn(code, "renderCashTrends") + liftFn(code, "cashTrendsHtml")));
  check("views_app exports rosterEmailFor, unchanged otherwise",
    /export async function rosterEmailFor\(/.test(readFileSync(new URL("./convex/views_app.ts", import.meta.url), "utf8")) &&
    /import \{ rosterEmailFor \} from "\.\/views_app";/.test(insightsSrc));
  check("the Data Dashboard has a campus filter for roles below admin and PBIS",
    /class="campus-filter-checkbox" value="middle"/.test(html) && /class="campus-filter-checkbox" value="high"/.test(html) &&
    /id="dashGradeFilter"/.test(html) && /id="dashCampusFilter" style="display: none;/.test(html));
  const stamps = [...html.matchAll(/\?v=([0-9a-z]+)/g)].map((m) => m[1]);
  check("all 26 cache stamps moved together, past 20261005b (open tabs self-update; nobody is asked to refresh)",
    stamps.length === 26 && new Set(stamps).size === 1 && stamps[0] > "20261005b", [...new Set(stamps)].join(","));
  check("the new styles are there, and every new table scrolls inside its card",
    /\.wc-unit-toggle \{/.test(css) && /\.wc-insight-n \{/.test(css) && /tr\.wc-insight-grey td/.test(css) &&
    (code.match(/'<div class="wu-scroll-x"><table class="student-table wc-trend-table">'/g) || []).length >= 5);
  check("this suite and the server rules' run after cash-read-walls in npm test",
    /node cash-read-walls\.test\.mjs && node --experimental-strip-types convex\/cashInsightsRules\.test\.mjs && node cash-insights\.test\.mjs/.test(pkg.scripts.test));
}

// ==================================================================== 15
console.log("\n15. TEETH for the click and one-to-one rules\n");
{
  const base = T(9, 22, 10);
  const wide = breakOnce(scriptSrc, "        const CASH_CLICK_GAP_MS = 5000;", "        const CASH_CLICK_GAP_MS = 60000;", "gap");
  check("TEETH: a 60 s gap merges rows 5.1 s apart", clicksOf(wide, [row({ s: "a", at: base }), row({ s: "b", at: base + 5100 })]).length === 1);
  const fromFirst = breakOnce(scriptSrc, "if (cur && en.ms - cur[cur.length - 1].ms <= CASH_CLICK_GAP_MS)", "if (cur && en.ms - cur[0].ms <= CASH_CLICK_GAP_MS)", "chain");
  check("TEETH: comparing with the first row splits the 8 s chain",
    clicksOf(fromFirst, [row({ s: "a", at: base }), row({ s: "b", at: base + 4000 }), row({ s: "c", at: base + 8000 })]).length === 2);
  const noNote = breakOnce(scriptSrc, "const key = actor + '\\u0001' + kind + '\\u0001' + behaviorId + '\\u0001' + note;",
    "const key = actor + '\\u0001' + kind + '\\u0001' + behaviorId;", "note-key");
  check("TEETH: drop the note from the key and two notes merge into one click",
    clicksOf(noNote, [row({ s: "a", at: base }), row({ s: "b", at: base + 100, note: "other words" })]).length === 1);
  const afterReversal = breakOnce(scriptSrc, "                const size = students.size;", "                const size = liveStudents.size;", "size-live");
  const pair = press({ at: base, note: "pair" }, ["a", "b"]);
  const ar = clicksOf(afterReversal, pair, [pair[0].id]);
  check("TEETH: size after reversals turns the survivor of a pair into a one-student award", ar[0].sizeClass === "one");

  const sameKid = breakOnce(scriptSrc, "                c.liveStudents.forEach(sid => s.add(sid));", "                s.add(c.ms);", "different-student");
  check("TEETH: drop 'a different student' and the same note to the same child twice stops being one-to-one",
    oneToOneCase(sameKid).clicks.filter((c) => c.students[0] === "x7").some((c) => !c.oneToOne));
  const utc = breakOnce(scriptSrc, "                const day = wcIsoDay(new Date(first.ms));", "                const day = new Date(first.ms).toISOString().slice(0, 10);", "utc");
  check("TEETH: a UTC day puts 5:30 PM on the next day, and the evening note reads as reused", oneToOneCase(utc).ofStudent("y2").oneToOne === false);
  const noteOnly = breakAll(scriptSrc, "c.actor + '\\u0001' + c.day + '\\u0001' + c.note", "c.day + '\\u0001' + c.note", 2, "adult");
  check("TEETH: key reuse by note alone and another adult's identical note counts against it", oneToOneCase(noteOnly).ofStudent("x4").oneToOne === false);
  const anyBehaviour = breakOnce(scriptSrc, "expectation: (exp && exp[1] === first.kind) ? exp[0] : null,", "expectation: (exp && exp[1] === first.kind) ? exp[0] : 'present',", "core-filter");
  check("TEETH: drop the core-id filter and the event award becomes one more one-to-one",
    eventCase(anyBehaviour, true).praise.clicks.oneToOne === eventCase(scriptSrc, true).praise.clicks.oneToOne + 1);
  const groupIndividual = breakOnce(scriptSrc, "                    add(c.sizeClass === 'one' ? 'deductOne' : 'deductGroup');",
    "                    add(c.sizeClass !== 'whole' ? 'deductOne' : 'deductGroup');", "group-deduct");
  const gi = deductionWeek(groupIndividual);
  check("TEETH: count 2-4 student deductions as individual and the fixture changes", gi.clicks.deductOne === 2 && gi.clicks.deductGroup === 0);
  const rawRatio = breakOnce(scriptSrc, "                    verdict: { clicks: cashRatioVerdict(w.clicks.allAwards, w.clicks.allDeductions),",
    "                    verdict: { clicks: { tone: 'below', ratio: w.clicks.awards / (w.clicks.deductions || 1), label: (w.clicks.awards / (w.clicks.deductions || 1)).toFixed(1) + ' to 1', note: '' },", "raw-ratio");
  const rw = ratioWorld(rawRatio);
  check("TEETH: a raw division shows a number for a four-deduction week",
    /0\.5 to 1/.test(await openTrends(rw)));
  const rosterAny = breakOnce(scriptSrc, "                if (roster && c.monday === lastMonday && canon.has(c.actor)) {\n                    const who = canon.get(c.actor);",
    "                if (roster && c.monday === lastMonday) {\n                    const who = c.actor;", "roster");
  check("TEETH: count staff without a class in participation and it rises", reachCase(rosterAny, { status: "ok", data: contextFor() }).reach.participation.any === 5);
  const pbisClassroom = breakOnce(scriptSrc, "                            if (canon.has(c.actor)) otoRoster.add(sid);", "                            otoRoster.add(sid);", "classroom");
  check("TEETH: count every adult in the classroom line and it rises", reachCase(pbisClassroom, { status: "ok", data: contextFor() }).reach.rosterOneToOne.all === 3);
}

// ==================================================================== 16
console.log("\n16. The second review (2026-10-06): each fix, and what it would look like without it");

// ---- One rule for the 5 to 1 ratio in clicks: every behaviour, the whole school.
/**
 * Spirit Week: 20 expectation award presses and 10 event presses to enrolled
 * students, 5 individual deductions; and the population edges -- 2 awards to
 * students who have left, 1 deduction from someone no longer on the staff list.
 * Expectations only it is 22 to 6 (3.6, below); every behaviour 32 to 6 (5.3, meets).
 */
function spiritWeek() {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row({ s: "s" + (i + 1), at: T(9, 22, 9, i), note: "own " + i }));
  for (let i = 0; i < 10; i++) rows.push(row({ s: "s" + (i + 1), t: "P1", at: T(9, 23, 9, i), b: "wc_custom_1", name: "Spirit Week (ASB ONLY)", note: "spirit " + i }));
  for (let i = 0; i < 5; i++) rows.push(row({ s: "s" + (21 + i), kind: "deduct", t: ["T1", "T2", "T3", "T4", "T1"][i], at: T(9, 24, 9, i), note: "d" + i }));
  rows.push(row({ s: "gone1", at: T(9, 22, 13), note: "left later 1" }), row({ s: "gone2", at: T(9, 22, 14), note: "left later 2" }));
  rows.push(row({ s: "s26", kind: "deduct", t: "X9", at: T(9, 24, 13), note: "former staff" }));
  const students = Array.from({ length: 30 }, (_, i) => kid(i + 1, i < 15 ? 7 : 10));
  return { rows, students };
}
async function ratioScreens(src) {
  const { rows, students } = spiritWeek();
  const w = world(src, { currentUser: PBIS, rows, students });
  const praise = w.app.cashPraiseWeeks({ model: w.app.cashClicksNow(), cutoffIso: "2026-09-14", todayIso: "2026-10-06" });
  const sum = praise.weeks.reduce((a, x) => ({ awards: a.awards + x.clicks.allAwards, deductions: a.deductions + x.clicks.allDeductions }), { awards: 0, deductions: 0 });
  w.app.applyCashAnalyticsGate();
  w.app.updateDashboard();
  w.app.updateTeacherInteractions();
  const gauge = w.app.cashSchoolWeekClicks(rows, new Set(), "2026-09-21", "2026-10-06");
  return { praise, sum, week: praise.weeks.find((x) => x.monday === "2026-09-21"), gauge,
           dash: el(w, "avgPositivityRatio").textContent, dashNote: el(w, "avgPositivityRatioNote").textContent,
           dashPerStudent: w.app.cashRatioVerdict(Number(el(w, "dashTotalPositive").textContent),
             Number(el(w, "dashTotalNegative").textContent)).label,
           ti: el(w, "teacherInteractionsPositivityRatio").textContent, tiNote: el(w, "teacherInteractionsRatioNote").textContent,
           tiPerStudent: w.app.cashRatioVerdict(Number(String(el(w, "teacherInteractionsTotalPositive").textContent).replace(/,/g, "")),
             Number(String(el(w, "teacherInteractionsTotalNegative").textContent).replace(/,/g, ""))).label,
           html: w.app.cashPraiseHtml(w.app.cashTrendWeeks({ rows, reversedIds: new Set(), staff: STAFF, students,
             campusOf: MODS.WildcatStore.studentCampusOf, cutoffIso: "2026-09-14", todayIso: "2026-10-06" }), { unit: "clicks", praise }) };
}
{
  const r = await ratioScreens(scriptSrc);
  check("Spirit Week's week: the 5 to 1 verdict counts every press, events included (32 to 6 = 5.3, meets), not the expectations alone (22 to 6, below)",
    r.week.clicks.allAwards === 32 && r.week.clicks.allDeductions === 6 && r.week.clicks.awards === 22 &&
    r.week.verdict.clicks.label === "5.3 to 1" && r.week.verdict.clicks.tone === "meets", JSON.stringify(r.week.verdict.clicks));
  check("...and the table shows it under the ratio, says events count there, and still splits the expectations",
    /wc-insight-n">32 to 6</.test(r.html) && /Event and custom \(in the 5 to 1 ratio only\)/.test(r.html) &&
    /events and custom behaviours \(such as Spirit Week\) included/.test(r.html) && !/Event and custom, left out/.test(r.html));
  // OWNER, 2026-10-06 ("option 2"): the EXISTING screens -- the Data Dashboard
  // tile, Teacher Interactions and the home gauge -- STAY PER STUDENT, exactly
  // the totals printed beside them. The school's ratio in clicks is on Trends.
  check("Trends' weeks summed are 32 to 6 in clicks (the new panels)", r.sum.awards === 32 && r.sum.deductions === 6 &&
    r.gauge.awards === 32 && r.gauge.deductions === 6, JSON.stringify({ sum: r.sum, gauge: r.gauge }));
  check("EXISTING SCREENS STAY PER STUDENT: the Data Dashboard tile is the ratio of its own totals, not clicks",
    r.dash === r.dashPerStudent && r.dash !== "5.3 to 1" && !/clicks/i.test(r.dashNote), JSON.stringify({ dash: r.dash, per: r.dashPerStudent, note: r.dashNote }));
  check("...and so is Teacher Interactions", r.ti === r.tiPerStudent && !/clicks/i.test(r.tiNote),
    JSON.stringify({ ti: r.ti, per: r.tiPerStudent, note: r.tiNote }));
  const { rows, students } = spiritWeek();
  const some = world(scriptSrc, { currentUser: PBIS, rows, students, grades: ["7"] });
  some.app.applyCashAnalyticsGate();
  some.app.updateDashboard();
  // Grade 7 is s1-s15: 15 expectation presses and 10 event presses reached them; no deduction did.
  check("with only some grades ticked the tile is the per-student ratio of the totals for those grades",
    el(some, "avgPositivityRatio").textContent === some.app.cashRatioVerdict(Number(el(some, "dashTotalPositive").textContent),
      Number(el(some, "dashTotalNegative").textContent)).label,
    el(some, "avgPositivityRatio").textContent + " / " + el(some, "avgPositivityRatioNote").textContent);

  const expOnly = breakOnce(scriptSrc, "                    verdict: { clicks: cashRatioVerdict(w.clicks.allAwards, w.clicks.allDeductions),",
    "                    verdict: { clicks: cashRatioVerdict(w.clicks.awards, w.clicks.deductions),", "verdict-expectations");
  check("TEETH: the verdict on the four expectations alone reads Spirit Week's week as below the goal",
    (await ratioScreens(expOnly)).week.verdict.clicks.tone === "below");
}

// ---- The click rule's stated accuracy is the measured one.
{
  // The doc comment above cashClickModel, up to the function itself.
  const fnAt = scriptSrc.indexOf("        function cashClickModel(rows, reversedIds) {");
  const model = scriptSrc.slice(scriptSrc.lastIndexOf("/**", fnAt), fnAt);
  check("the click model's comment gives the measured figure (98 rows, all Spirit Week; no expectation row), not 'all but one of about 2,050'",
    /49 clicks span two presses -- 98 rows, all\s+\*\s+one-student Spirit Week presses/.test(model) && /Not one expectation row differs\./.test(model) &&
    !/all but one of about 2,050 rows/.test(scriptSrc));
}

// ---- The 9/25 step in part-day absences is tagged and explained.
{
  const { out, html } = outcomeOf(scriptSrc, contextFor({ marks: MARKS40 }));
  const wk = (m) => out.weeks.find((w) => w.monday === m);
  const rowOf = (label) => (html.split("<tr>").find((r) => r.includes(label)) || "").split("</tr>")[0];
  check("weeks with days on or after Sep 25 carry the part-day question; earlier weeks do not",
    wk("2026-09-14").partQuestion === false && wk("2026-09-21").partQuestion === true && wk("2026-09-28").partQuestion === true);
  check("...each such part-day cell is tagged 'recording question', and the caption dates and explains it",
    (rowOf("Sep 28").match(/recording question/g) || []).length === 2 && (rowOf("Sep 21").match(/recording question/g) || []).length === 2 &&
    !/recording question/.test(rowOf("Sep 14")) && /Part-day absences, from Sep 25:<\/b> they jumped that day at both campuses/.test(html) &&
    /The attendance office has been asked/.test(html));
  const untagged = breakOnce(scriptSrc, "        const CASH_PART_DAY_QUESTION_FROM = '2026-09-25';", "        const CASH_PART_DAY_QUESTION_FROM = '';", "question");
  check("TEETH: without the dated question the jump sits beside the praise columns unexplained",
    !/recording question|Part-day absences, from/.test(outcomeOf(untagged, contextFor({ marks: MARKS40 })).html));
}

// ---- One name, one number: the expectation-only figures say so.
{
  const r = reachCase(scriptSrc, { status: "ok", data: contextFor() });
  const reachHtml = r.w.app.cashReachHtml({ reach: r.reach });
  const { html } = outcomeOf(scriptSrc, contextFor({ marks: MARKS40 }));
  check("the reach column is 'Any expectation award', with no 'TFI-style' claim",
    /Any expectation award<span class="wc-trend-of">events left out/.test(reachHtml) && !/TFI-style/.test(reachHtml) && !/>Any award</.test(reachHtml));
  check("the behaviour-change column is 'Given an expectation award', not 'Given any award'",
    /Given an expectation award/.test(html) && !/Given any award/.test(html));
  // ---- The classroom line counts any role with a class, and states no fixed conclusion.
  check("the classroom line says 'any role' and no longer claims 'cannot carry the school's figure'",
    /from staff with a PowerSchool class \(any role\) reached 20% \(2 of 10\) of students\./.test(reachHtml) && !/cannot carry/.test(reachHtml),
    (reachHtml.match(/One-to-one praise from staff[^<]*/) || [""])[0]);
}

// ---- Participation is out of the staff who existed that week.
{
  const roster = { count: 4, ids: [["T1", "k1"], ["T2", "k2"], ["P1", "k3"], ["N1", "k4"]],
                   createdDays: ["2026-08-11", "2026-08-11", "2026-08-12", "2026-10-05"] };
  const r = reachCase(scriptSrc, { status: "ok", data: contextFor({ roster }) });
  check("a staff record created 10/5 is not in last week's (Sep 28 - Oct 2) denominator: 3 of 3, not of 4",
    r.reach.participation.of === 3 && r.reach.participation.any === 3, JSON.stringify(r.reach.participation));
  const old = reachCase(scriptSrc, { status: "ok", data: contextFor({ roster: { count: 4, ids: roster.ids } }) });
  check("...and without creation days (an older server) it is today's count", old.reach.participation.of === 4);
  const today = breakOnce(scriptSrc, "            const of = !roster ? 0 : (created", "            const of = !roster ? 0 : (false", "created");
  check("TEETH: count today's roster and the 10/5 record is in the 9/28 week", reachCase(today, { status: "ok", data: contextFor({ roster }) }).reach.participation.of === 4);
}

// ---- A withdrawn award does not spoil the corrected one.
{
  const wrong = row({ s: "S1", b: "wc1", name: "Be Present", at: T(9, 22, 9), note: "Great focus today" });
  const undo = { ...row({ s: "S1", kind: "reversal", at: T(9, 22, 9, 2), note: "" }), reversesTxnId: wrong.id, behaviorId: "", kind: "reversal" };
  const right = row({ s: "S2", b: "wc1", name: "Be Present", at: T(9, 22, 9, 3), note: "Great focus today" });
  const oneTo = (src) => clicksOf(src, [wrong, undo, right], [wrong.id]).find((c) => c.students[0] === "S2");
  check("an award reversed (wrong child) and given to the right child with the same note: the corrected one is one-to-one",
    oneTo(scriptSrc).oneToOne === true && oneTo(scriptSrc).sizeClass === "one");
  const before = breakOnce(scriptSrc, "                c.liveStudents.forEach(sid => s.add(sid));", "                c.students.forEach(sid => s.add(sid));", "reuse-live");
  check("TEETH: build the note-reuse set before reversals and the corrected award loses one-to-one", oneTo(before).oneToOne === false);
}

// ---- Expectation balance reads school weeks, not calendar weeks.
{
  // Today 2027-01-06. Awards in the weeks of 11/16, 11/30, 12/07 and 12/14; none
  // in Thanksgiving week (11/23) or winter break (12/21, 12/28).
  const at = (m, d) => new Date(2026, m - 1, d, 10).getTime();
  const rows = [[11, 17], [12, 1], [12, 8], [12, 15]].map(([m, d], i) => row({ s: "s" + (i + 1), at: at(m, d), note: "w" + i }));
  const bal = (src) => { const w = world(src, { rows, students: MS, now: new Date(2027, 0, 6, 10).getTime() });
    return w.app.cashExpectationBalance({ model: w.app.cashClickModel(rows, new Set()), students: MS,
      campusOf: MODS.WildcatStore.studentCampusOf, todayIso: "2027-01-06", cutoffIso: "2026-09-14" }); };
  const b = bal(scriptSrc);
  check("on Jan 6 the last four finished school weeks skip the break: Nov 16, Nov 30, Dec 7, Dec 14",
    b.mondays.join() === "2026-11-16,2026-11-30,2026-12-07,2026-12-14" && respect(b).all.oneToOne === 4, b.mondays.join());
  check("...and the panel says weeks with nothing at all are skipped",
    /finished school weeks, Nov 16 &ndash; Dec 18 \(a week with no awards or deductions at all, such as a break, is skipped\)/.test(world(scriptSrc).app.cashBalanceHtml(b, false)));
  const calendar = breakOnce(scriptSrc, "                .filter(m => active.has(m)).slice(-CASH_BALANCE_WEEKS);", "                .slice(-CASH_BALANCE_WEEKS);", "school-weeks");
  check("TEETH: calendar weeks put two empty break weeks in the four", bal(calendar).mondays.join() === "2026-12-07,2026-12-14,2026-12-21,2026-12-28");
}

// ---- The attendance lines follow the attendance screens' rule.
{
  const restricted = { ...contextFor({ marks: MARKS40 }), attendance: false };
  restricted.weeks = RULES.withoutAttendance(restricted.weeks);
  const { out, html } = outcomeOf(scriptSrc, restricted);
  check("refused attendance by the server: the praise columns stay, the attendance columns go, and a line says who they are for",
    out.attendance === false && out.weeks.every((w) => w.campus.middle.tardy.state === "restricted" && w.campus.high.part.state === "restricted") &&
    !/Unexcused tardies per 100|Part-day absences per 100|recording question/.test(html) && /Given one-to-one praise/.test(html) &&
    /are for administrators, the PBIS team and staff given Attendance Watch access/.test(html) && !/\d+\.\d<\/b>/.test(html));
  const t = roleWorld(scriptSrc, by("T2"), { ctx: restricted });
  const trends = await openTrends(t);
  check("...and a teacher's Trends draws that way end to end, with no rate anywhere", /Did behaviour change/.test(trends) &&
    !/Unexcused tardies per 100/.test(trends) && /Attendance Watch access/.test(trends));
  const full = outcomeOf(scriptSrc, contextFor({ marks: MARKS40 })).html;
  check("CONTROL: with the attendance the columns are there", /Unexcused tardies per 100/.test(full) && !/are for administrators, the PBIS team/.test(full));
}

// ---- The named list's marks are dropped by the idle refresh, with the other attendance caches.
{
  const s = strip(scriptSrc);
  const start = s.indexOf("autoRefreshInterval = setInterval(");
  const block = s.slice(start, s.indexOf("pullLiveActivity('idle')", start));
  check("the idle refresh drops the named list's marks beside Perfect Attendance's (_paCache)",
    start > 0 && /_paCache = null;\s*_cashNoticeMarks = null;/.test(block));
  const kept = strip(breakOnce(scriptSrc, "                            _cashNoticeMarks = null;\n", "", "idle"));
  const keptBlock = kept.slice(kept.indexOf("autoRefreshInterval = setInterval("), kept.indexOf("pullLiveActivity('idle')", kept.indexOf("autoRefreshInterval = setInterval(")));
  check("TEETH: without that line the marks outlive every refresh", !/_cashNoticeMarks = null;/.test(keptBlock));
}

// ---- The one-to-one ratio's bottom is individual deductions only.
{
  const at = T(9, 22, 9);
  const rows = [
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => row({ s: "s" + (i + 1), at: at + i * 60000, note: "own " + i })),
    ...[0, 1, 2, 3, 4].map((i) => row({ s: "s" + (i + 1), kind: "deduct", at: at + 3600000 + i * 60000, note: "d" + i })),
    ...[0, 1, 2].flatMap((g) => press({ kind: "deduct", at: at + 7200000 + g * 60000, note: "grp" + g }, ["s1" + g, "s2" + g])),
  ];
  const wk = (src) => { const { app } = world(src); return app.cashPraiseWeeks({ model: app.cashClickModel(rows, new Set()), cutoffIso: "2026-09-14", todayIso: "2026-10-06" })
    .weeks.find((w) => w.monday === "2026-09-21"); };
  const w = wk(scriptSrc);
  check("8 one-to-one against 5 individual deductions (3 group deductions beside them) reads 1.6 to 1, not 1.0",
    w.clicks.deductOne === 5 && w.clicks.deductGroup === 3 && w.oneToOneRatio.label === "1.6 to 1" &&
    w.oneToOneRatio.label === world(scriptSrc).app.cashRatioPlain(w.clicks.oneToOne, w.clicks.deductOne).label, JSON.stringify(w.oneToOneRatio));
  const allBottom = breakOnce(scriptSrc, "                    oneToOneRatio: cashRatioPlain(w.clicks.oneToOne, w.clicks.deductOne)",
    "                    oneToOneRatio: cashRatioPlain(w.clicks.oneToOne, w.clicks.deductions)", "oto-bottom");
  check("TEETH: put group deductions back on the bottom and it reads 1.0", wk(allBottom).oneToOneRatio.label === "1.0 to 1");
}

// ---- A small-group press is not a one-student award in the reach panel.
{
  const ctx = { status: "ok", data: contextFor() };
  const rows = [row({ s: "s1", at: T(10, 1, 9), note: "solo" }), ...press({ at: T(10, 1, 10), note: "pair", t: "T2" }, ["s2", "s3"])];
  const students = Array.from({ length: 10 }, (_, i) => kid(i + 1, i < 5 ? 6 : 9));
  const reach = (src) => { const w = world(src, { rows, students }); const model = w.app.cashClickModel(rows, new Set());
    return w.app.cashReachModel({ model, students, campusOf: MODS.WildcatStore.studentCampusOf,
      window: w.app.cashReachWindow({ ctx, model, todayIso: "2026-10-06" }), todayIso: "2026-10-06", roster: ctx.data.rosterStaff }); };
  const r = reach(scriptSrc);
  check("a two-student press counts as any award but not as a one-student award, in reach and in participation",
    r.any.all === 3 && r.one.all === 1 && r.participation.any === 2 && r.participation.one === 1, JSON.stringify({ any: r.any.all, one: r.one.all, p: r.participation }));
  const notWhole = breakOnce(scriptSrc, "                        if (c.sizeClass === 'one') one.add(sid);", "                        if (c.sizeClass !== 'whole') one.add(sid);", "reach-one");
  check("TEETH: count 2-4 student presses as one-student awards and the share rises", reach(notWhole).one.all === 3);
}

// ---- One campus concentrated greys the whole school.
{
  // Middle School: T1 gives 6 of 10 (60%). High School: 10 spread over four adults.
  // Whole school on its own: 20 deductions, the top adult 6 (30%), five adults -- spread.
  const rows = deductionsBy({ T1: 6, T2: 2, T3: 2 }, 1).concat(deductionsBy({ T4: 3, P1: 3, A1: 2, S1: 2 }, 201));
  const cells = (src) => respect(balanceOf(src, rows, MS.concat(HS)));
  const c = cells(scriptSrc);
  check("one campus concentrated, the other spread: the whole school is greyed 'within a campus'",
    c.middle.check === "concentrated" && c.high.check === "spread" && c.all.check === "concentrated" && c.all.why === "campus" &&
    c.all.topShare === 0.3, JSON.stringify({ m: c.middle.check, h: c.high.check, all: c.all.check, share: c.all.topShare }));
  const both = breakOnce(scriptSrc, "(r.cells.middle.check === 'concentrated' || r.cells.high.check === 'concentrated')",
    "(r.cells.middle.check === 'concentrated' && r.cells.high.check === 'concentrated')", "either-campus");
  check("TEETH: require both campuses and the whole school reads as a school-wide pattern", cells(both).all.check === "spread");
}

// ---- The staff-only balance is wiped when the next person is not staff.
{
  const balanceWorld = (src) => {
    const w = world(src, { currentUser: ADMIN, rows: deductionsBy({ T1: 3, T2: 3, T3: 3 }), students: MS });
    w.app.updateCashAnalytics();
    const before = el(w, "cashAnalyticsDetails").innerHTML;
    w.app.set("currentUser", by("T2"));
    w.app.applyCashAnalyticsGate();
    return { before, after: el(w, "cashAnalyticsDetails").innerHTML };
  };
  const b = balanceWorld(scriptSrc);
  check("an admin's balance shows the adult counts; once a teacher is in, none of it is left on the page",
    /top adult/.test(b.before) && !/top adult|from \d+ adult/.test(b.after));
  const noWipe = breakOnce(scriptSrc, "                if (balance) balance.innerHTML = '';\n", "", "balance-wipe");
  check("TEETH: drop the balance wipe and 'top adult' stays for the teacher", /top adult/.test(balanceWorld(noWipe).after));
}

// ---- A finished week is one whose Friday is before today, on the browser as on the server.
{
  const { app } = world(scriptSrc);
  const runDays = SCHOOL_DAYS.map((date) => ({ date, band: "6-8", members: 1, absentDays: 0, fullDaysStrict: 0, misrecordDaysByGap: [0],
    partialDays: 0, assumedPresentDays: 0, syncedAt: "2026-10-06T10:15:00.000Z" }));
  const serverLast = (today) => { const w = RULES.outcomeWeeks({ runDays, marks: [], today }).weeks; return w[w.length - 1].monday; };
  check("on a Friday the week in progress is not finished, on the Saturday it is -- the browser and the server agree",
    app.cashLastFinishedMonday("2026-10-09") === "2026-09-28" && serverLast("2026-10-09") === "2026-09-28" &&
    app.cashLastFinishedMonday("2026-10-10") === "2026-10-05" && serverLast("2026-10-10") === "2026-10-05");
  const fri = breakOnce(scriptSrc, "            return cashAddDays(mon, 4) < todayIso ? mon : cashAddDays(mon, -7);",
    "            return cashAddDays(mon, 4) <= todayIso ? mon : cashAddDays(mon, -7);", "friday");
  check("TEETH: '<=' calls Friday's own week finished", world(fri).app.cashLastFinishedMonday("2026-10-09") === "2026-10-05");
}

// ---- A pending week's tardy cell is pending, not a rate.
{
  const ctx = contextFor({ marks: MARKS40, days: SCHOOL_DAYS.filter((d) => d <= "2026-10-01"), builtAt: "2026-10-02T10:15:00.000Z" });
  const p = (src) => outcomeOf(src, ctx).out.weeks.find((w) => w.monday === "2026-09-28").campus.middle;
  check("the week the run table has not reached: tardy and part-day both 'pending'", p(scriptSrc).tardy.state === "pending" && p(scriptSrc).part.state === "pending");
  const noPending = breakOnce(scriptSrc, "                    else if (w.status !== 'in') tardy = { state: 'pending' };\n", "", "pending-tardy");
  check("TEETH: drop the pending line and the tardy cell reads a rate over a partial week", p(noPending).tardy.state !== "pending");
}

// ---- trendsContext is asked once per ten minutes per person.
{
  const twice = async (src) => { const w = roleWorld(src, by("T2")); await openTrends(w); w.app.switchAnalyticsSubtab("dashboard"); await openTrends(w);
    return w.G.queries.filter((q) => q === "cashInsights:trendsContext").length; };
  check("opening Trends twice within ten minutes reads trendsContext once", (await twice(scriptSrc)) === 1);
  const noCache = breakOnce(scriptSrc, "            if (!force && have && have.status === 'ok' && Date.now() - have.at < CASH_TRENDS_CONTEXT_MS) return;\n", "", "ctx-cache");
  check("TEETH: without the ten-minute cache every open reads it again", (await twice(noCache)) === 2);
}

// ---- Opening Trends draws it once now, and once more when both reads have landed.
{
  const draws = async (src) => { const w = roleWorld(src, PBIS, { count: true }); await openTrends(w); return w.G.renders; };
  check("PBIS opening Trends: two draws (now, and once both reads land), not three", (await draws(scriptSrc)) === 2);
  // The shape before the fix: each loader redrew Trends when its own answer landed.
  const each = breakOnce(breakOnce(breakOnce(scriptSrc,
    "                Promise.all([loadCashTrendsContext(), cashStaffViewsAllowed() ? loadCashNeverNoticedMarks() : false])\n" +
    "                    .then(got => { if (got.some(Boolean) && cashPaneOpen('analyticsTrends')) renderCashTrends(); });",
    "                loadCashTrendsContext();\n                if (cashStaffViewsAllowed()) loadCashNeverNoticedMarks();", "one-draw"),
    "                : { userId: who, at: Date.now(), status: 'failed', data: null };\n            return true;",
    "                : { userId: who, at: Date.now(), status: 'failed', data: null };\n            if (cashPaneOpen('analyticsTrends')) renderCashTrends();", "ctx-draw"),
    "            _cashNoticeMarks = { userId: who, gen: gen, status: ok ? 'ok' : 'failed', res: ok ? res : null };\n            return true;",
    "            _cashNoticeMarks = { userId: who, gen: gen, status: ok ? 'ok' : 'failed', res: ok ? res : null };\n            if (cashPaneOpen('analyticsTrends')) renderCashTrends();", "marks-draw");
  check("TEETH: a redraw per answer is three draws", (await draws(each)) === 3);
}

// A synthetic year (about 85,000 rows by June): the click model's cost, measured.
{
  const rows = [];
  const start = T(9, 14, 8);
  for (let i = 0; i < 85000; i++) {
    const press = Math.floor(i / 6);
    rows.push({ id: "z" + i, kind: i % 9 === 0 ? "deduct" : "award", teacherId: "T" + (press % 40), studentId: "s" + (i % 600),
      behaviorId: i % 9 === 0 ? "wc6" : "wc" + (1 + (press % 4)), notes: "note " + (press % 300), timestamp: new Date(start + press * 61000 + (i % 6) * 300).toISOString() });
  }
  const { app } = world(scriptSrc);
  const t0 = performance.now();
  const m = app.cashClickModel(rows, new Set());
  const ms = performance.now() - t0;
  console.log(`  INFO  85,000 synthetic rows -> ${m.clicks.length.toLocaleString()} clicks in ${ms.toFixed(0)} ms on this machine`);
  check("the click model handles a year's ledger well inside a second here (memoised, and never on the award path)", ms < 1500, ms.toFixed(0) + " ms");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
