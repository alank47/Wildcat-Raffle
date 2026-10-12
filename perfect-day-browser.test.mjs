// THE AUTOMATIC PERFECT-DAY AWARD, IN THE BROWSER. Run: npm test
//
// The server half (perfect-day.test.mjs) pays each student one Wildcat Cash
// movement a week for last week's perfect days: kind "attendance", behaviour
// "system:perfect-day", given by "system:attendance" ("Wildcat Hub
// (attendance)"), labelled "Perfect attendance -- N days". This file is the
// site half, owner's decisions of 2026-10-12:
//
//   1. Staff analytics leave it out: every number on Cash Analytics (Overview,
//      the week strip, the Staff tab, Trends, 5 to 1, one-to-one praise,
//      whole-class detection, reach, expectation balance) is THE SAME with a
//      payday in the ledger as without it. Two rules keep it out (its kind,
//      and its system marks), and either one alone is enough.
//   2. The leaderboard counts it (owner): both boards rank on Earned.
//   3. The Staff tab's list of interactions badges it "Attendance", grey.
//   4. The payday's one summary audit entry is a cash entry with no amount:
//      off a teacher's Activity feed, on an admin's.
//   5. A student sees "Perfect day – pending" from the morning a day is
//      decided, only when the server says it will be paid, on both the desk
//      dashboard and the wallet card; the payment itself in their history.
//   6. Staff Accounts history shows the payment (it has no audit entry).
//   7. A forged movement refused as reserved_kind leaves the save queue.
//   8. The admin card: the server's status, read only, names joined here.
//   9. The browser's rule and the server's rule agree on what is server-only.
//
// THE SHIPPED CODE RUNS: functions are lifted out of script.js (and the
// student portal's regions the way their own tests lift them) and run against
// a fake DOM with the real wildcat-roster.js, wildcat-store.js and
// wildcat-cashaudit.js; the server's rule is transpiled from
// convex/appDataShape.ts. Then the load-bearing lines are re-broken in a copy
// of the source to prove a check notices.

process.env.TZ = "America/Los_Angeles";

import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const scriptSrc = read("./script.js");
const html = read("./index.html");
const css = read("./styles.css");
const pkg = JSON.parse(read("./package.json"));
const rosterSrc = read("./wildcat-roster.js");
const storeSrc = read("./wildcat-store.js");
const cashAuditSrc = read("./wildcat-cashaudit.js");
const pdServer = read("./convex/perfectDay.ts");
const pdRules = read("./convex/perfectDayRules.ts");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = strip(scriptSrc);

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const J = (x) => JSON.stringify(x);

// ---------------------------------------------------------------- the harness
function liftFn(src, name) {
  const m = new RegExp("\\n        (?:async )?function " + name + "\\(").exec(src);
  if (!m) throw new Error("missing function " + name);
  const start = m.index + 1;
  const end = src.indexOf("\n        }\n", start);
  if (end < 0) throw new Error("unterminated function " + name);
  return src.slice(start, end + 10);
}
function liftConst(src, name) {
  const m = new RegExp("^        (?:const|var) " + name + " = [^\\n]*;$", "m").exec(src);
  if (!m) throw new Error("missing const " + name);
  return m[0];
}
/** A multi-line `const NAME = {...};` or `[...]` at the top level of script.js. */
function liftBlockConst(src, name) {
  const at = src.indexOf("\n        const " + name + " = ");
  if (at < 0) throw new Error("missing const " + name);
  const end = src.indexOf("\n        };\n", at);
  return src.slice(at + 1, end + 11);
}
function breakOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`teeth "${label}": anchor not found exactly once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}
function dateAt(nowMs) {
  const Real = globalThis.Date;
  return class extends Real {
    constructor(...a) { if (a.length) super(...a); else super(nowMs); }
    static now() { return nowMs; }
  };
}
function loadModules(srcs = [rosterSrc, storeSrc, cashAuditSrc]) {
  const sandbox = {};
  for (const src of srcs) new Function("globalThis", src).call(sandbox, sandbox);
  return sandbox;
}
const MODS = loadModules();
const CA = MODS.WildcatCashAudit;

function makeEl(id) {
  const cls = new Set();
  const attrs = new Map();
  return {
    id, innerHTML: "", textContent: "", value: "", hidden: false, style: {},
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
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
  return {
    els,
    getElementById: byId,
    querySelectorAll: (sel) => {
      if (sel === ".grade-filter-checkbox:checked") return ["6", "7", "8", "9", "10", "11", "12"].map((v) => ({ value: v }));
      if (sel === ".campus-filter-checkbox:checked") return ["middle", "high"].map((v) => ({ value: v }));
      return [];
    },
  };
}

// Cash Analytics, whole, as cash-insights.test.mjs lifts it.
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
  "cashViewKey", "cashRememberView", "cashRememberedView", "openCashAnalytics", "cashHistorySinceLabel", "cashSinceChips",
  "cashChipsHtml", "cashMovedNoteKey", "cashMovedNoteHtml", "renderCashMovedNote", "dismissCashMovedNote", "openCashGlossary",
  "closeCashGlossary", "cashFoldKey", "cashFoldHtml", "setCashFoldOpen", "cashFoldToggled", "wcSortCellText", "wcSortValue", "wcSortColumnType",
  "wcSortOrder", "wcSortSet", "wcSortTh", "wcSortRowCellText", "wcSortRowsHtml", "wcSortMarkHead", "wcSortApplyDom", "wcSortClick", "cashViewerChanged", "cashBarIntoView",
  "cashKeepPlace", "cashGlossaryKeydown",
  "cashGaugeWeekStartMs", "cashGaugeWeekRows", "cashRowKindCounts", "cashWeekStripModel", "cashWeekStripHtml", "renderCashWeekStrip",
  // This file's own:
  "updateCashLeaderboards", "renderCashRankBoard", "cashAuditEntriesFor", "dashFeedEntriesFor", "wcFeedActionKey", "wcFeedCat",
  "cashReversalIsAdmin", "perfectDayShort", "perfectDayNameOf", "perfectDayPanelHtml", "renderPerfectDayPanel", "fetchPerfectDayStatus",
  "systemCashRowsHeld", "showStudentCashHistory",
];
const CONSTS = [
  "CASH_STAFF_VIEW_ROLES", "CASH_RATIO_GOAL", "CASH_RATIO_MIN_DEDUCTIONS", "CASH_LAUNCH_WEEK", "CASH_TREND_GRADES",
  "CASH_CORE_EXPECTATIONS", "CASH_EXPECTATION_ORDER", "CASH_EXPECTATION_NAMES", "CASH_CLICK_GAP_MS", "CASH_CLICK_WHOLE",
  "CASH_REACH_SCHOOL_DAYS", "CASH_BALANCE_WEEKS", "CASH_MANY_ADULTS_MIN", "CASH_MANY_ADULTS_TOP_SHARE",
  "CASH_NAMED_LIST_MAX_SHARE", "CASH_OUTCOME_WEEKS_NEEDED", "CASH_MARKS_MIN_COVERAGE", "CASH_TRENDS_CONTEXT_MS",
  "CASH_COUNT_UNIT_KEY", "CASH_PART_DAY_QUESTION_FROM", "QUIET_WINDOW_DAYS",
  "CASH_VIEW_KEYS", "CASH_VIEW_ALIASES", "CASH_VIEW_BUTTONS", "CASH_VIEW_PANES", "WC_CASH_VIEW_KEY",
  "_cashMovedNoteGone", "_cashOpenFolds", "_wcSortState", "WC_SORT_ARROWS", "_cashViewOwner",
];
const BLOCK_CONSTS = ["FEED_CATS", "FEED_ACTION_CATS"];

function loadApp(src, G) {
  const body = `
    let currentUser = G.currentUser || null;
    let teachers = G.teachers || [];
    let students = G.students || [];
    let nonEnrolledStudents = G.nonEnrolled || [];
    let cashTransactions = G.cashTransactions || [];
    let auditLog = G.auditLog || [];
    let _historyCutoffMs = G.cutoffMs === undefined ? null : G.cutoffMs;
    let _interventionReversedIds = null;
    let _cashLedgerVersion = 0, _cashClickMemo = null, _cashTrendsCtx = null, _cashNoticeMarks = null, _cashNoticeGen = 0;
    let _cashNoticeSince = null, _cashCountUnitHere = null, _cashTrendsDrawnForStaff = false, _cashBalanceDrawnForStaff = false;
    let _paCache = null;
    let _cashGlossaryOpener = null;
    let _perfectDayStatus = null, _perfectDayAskedAt = 0;
    const STARTING_BALANCE = 0;
    function switchTab(name) {}
    function _wcDialog(o) { (G.dialogs = G.dialogs || []).push(o); return Promise.resolve(true); }
    const localStorage = G.localStorage;
    const document = G.document;
    const window = G.window;
    const Date = G.Date || globalThis.Date;
    const console = { log() {}, warn() {}, error() {} };
    function activeTeacherRoster() { return null; }
    function paginate(key, rows) { return { slice: rows, page: 1, pages: 1, total: rows.length }; }
    function renderPager() {}
    ${CONSTS.map((n) => liftConst(src, n)).join("\n")}
    ${BLOCK_CONSTS.map((n) => liftBlockConst(src, n)).join("\n")}
    ${FNS.map((n) => liftFn(src, n)).join("\n")}
    return {
      set(k, v) {
        if (k === "currentUser") currentUser = v;
        else if (k === "cashTransactions") cashTransactions = v;
        else if (k === "students") students = v;
        else throw new Error("unknown global " + k);
      },
      perfectDayStatus: () => _perfectDayStatus,
      ${FNS.join(", ")}
    };`;
  return new Function("G", body)(G);
}

// ---------------------------------------------------------------- the world
// Today is Tuesday 2026-10-06, 10:00 in Los Angeles. Cash history starts 9/14.
const NOW = new Date(2026, 9, 6, 10, 0).getTime();
const CUTOFF = new Date(2026, 8, 14, 8, 30).getTime();
const T = (m, d, h = 10, mi = 0, s = 0, ms = 0) => new Date(2026, m - 1, d, h, mi, s, ms).getTime();
let seq = 0;
function row(o) {
  const kind = o.kind || "award";
  return {
    id: o.id || "r" + (++seq), kind, type: kind === "deduct" ? "negative" : "positive", amount: kind === "deduct" ? -100 : 100,
    teacherId: o.t === undefined ? "T1" : o.t, teacherName: "Ms. Lee", studentId: o.s, studentName: "Hidden Name",
    behaviorId: o.b || (kind === "deduct" ? "wc6" : "wc2"), behaviorName: o.name || (kind === "deduct" ? "Not Being Respectful" : "Be Respectful"),
    notes: o.note === undefined ? "a note" : o.note, timestamp: new Date(o.at).toISOString(),
  };
}
const press = (o, ids, gap = 400) => ids.map((s, i) => row({ ...o, s, at: o.at + i * gap }));
/** One perfect-day payment, field for field as perfectDayRules.buildPayoutRow writes it. */
function payout(s, at, days = 4, amount = 100 * days) {
  const ms = at;
  return {
    id: `txn_${String(ms).padStart(13, "0")}_pd${(++seq).toString(36)}`, timestamp: new Date(ms).toISOString(),
    studentId: s, studentName: "Hidden Name", studentGrade: "7", school: "middle",
    teacherId: "system:attendance", teacherUsername: "", teacherName: "Wildcat Hub (attendance)",
    kind: "attendance", type: "positive", behaviorId: "system:perfect-day",
    behaviorName: `Perfect attendance — ${days} day${days === 1 ? "" : "s"}`, amount,
    notes: ["Mon 9/28", "Tue 9/29", "Wed 9/30", "Fri 10/2"].slice(0, days).join(", "), balanceAfter: 1000,
  };
}

const STAFF = [
  { id: "T1", name: "Ms. Lee", role: "teacher" }, { id: "T2", name: "Mr. Park", role: "teacher" },
  { id: "T3", name: "Mx. Quinn", role: "teacher" }, { id: "P1", name: "Pat PBIS", role: "pbis" },
  { id: "A1", name: "Dr. Admin", role: "admin" }, { id: "S1", name: "Owner Person", role: "superadmin" },
];
const by = (id) => STAFF.find((s) => s.id === id);
const PBIS = by("P1"), ADMIN = by("A1"), SUPER = by("S1"), TEACHER = by("T1");
const kid = (n, grade, extra = {}) => ({ id: "s" + n, studentNumber: "N" + n, firstName: "Stu" + n, lastName: "Last" + n, grade: String(grade),
  wildcatCashBalance: 500, wildcatCashEarned: 600, wildcatCashSpent: 100, wildcatCashDeducted: 0, wildcatCashTransactions: [], ...extra });
const STUDENTS = Array.from({ length: 40 }, (_, i) => kid(i + 1, i < 20 ? 7 : 10));

/** A school's two weeks of adults' cash: whole-class presses, one-to-one praise, deductions, an event. */
function staffRows() {
  const rows = [];
  for (const [d, wk] of [[28, 9], [29, 9], [30, 9], [5, 10], [6, 10]]) {
    rows.push(...press({ at: T(wk, d, 9), note: "class " + d }, STUDENTS.slice(0, 25).map((s) => s.id)));
    rows.push(row({ s: "s30", at: T(wk, d, 11), note: "helped a friend " + d }));
    rows.push(row({ s: "s31", at: T(wk, d, 11, 30), t: "T2", b: "wc1", name: "Be Present", note: "on time " + d }));
    rows.push(...[0, 1, 2].map((i) => row({ s: "s" + (32 + i), kind: "deduct", at: T(wk, d, 13, i), t: i ? "T2" : "T1", note: "d" + i })));
  }
  rows.push(...press({ at: T(10, 1, 14), b: "wc_custom_1", name: "Spirit Week (ASB ONLY)", note: "spirit" }, ["s1", "s2", "s3"]));
  return rows;
}
/**
 * Two paydays: Monday 9/28 for the week of 9/21, Monday 10/5 for 9/28's.
 * Every student, a millisecond apart (as payBatch writes them), from one
 * actor with one behaviour and one note -- the exact shape that would be
 * a forty-student whole-class "press" if anything counted it. Plus one week
 * an admin reversed with the button and one re-paid by correctPayout.
 */
function paydayRows() {
  const rows = [];
  for (const at of [T(9, 28, 7, 42), T(10, 5, 7, 42)]) STUDENTS.forEach((s, i) => rows.push(payout(s.id, at + i)));
  const reversed = rows[rows.length - 1];
  rows.push({ id: "txn_" + T(10, 5, 12) + "_rev", timestamp: new Date(T(10, 5, 12)).toISOString(), studentId: reversed.studentId,
    teacherId: "A1", teacherName: "Dr. Admin", kind: "reversal", type: "negative", amount: -reversed.amount,
    behaviorId: "reversal:" + reversed.id, behaviorName: "Reversed: " + reversed.behaviorName, notes: "one day was a K",
    reversesTxnId: reversed.id, reversesKind: "attendance", reversesBehaviorId: "system:perfect-day", reversesTeacherId: "system:attendance" });
  rows.push(payout(reversed.studentId, T(10, 5, 12) + 1, 3));
  return rows;
}

function world(src, o = {}) {
  const dom = makeDom();
  const G = {
    currentUser: o.currentUser || PBIS, teachers: STAFF, students: o.students || STUDENTS, nonEnrolled: o.nonEnrolled || [],
    cashTransactions: o.rows || [], auditLog: o.auditLog || [], cutoffMs: CUTOFF, document: dom, Date: dateAt(o.now || NOW),
    localStorage: { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); } },
    queries: [],
  };
  const session = new Map();
  G.window = Object.assign({}, o.mods || MODS, {
    sessionStorage: { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)), removeItem: (k) => session.delete(k) },
    WildcatAuth: {
      getSession: () => (o.signedOut ? null : { idToken: "tok" }),
      convexQuery: async (name, args) => {
        G.queries.push(name);
        if (o.server) return o.server(name, args, G);
        if (name === "cashInsights:trendsContext") return { allowed: false };
        if (name === "attendanceList:attendanceMarks") return { allowed: true, rows: [] };
        throw new Error("unexpected query " + name);
      },
    },
  });
  const app = loadApp(src, G);
  dom.getElementById("cashAnalyticsTab").classList.add("active");
  return { dom, app, G };
}
const el = (w, id) => w.dom.getElementById(id);
const settle = () => new Promise((r) => setImmediate(r));

/** Every Cash Analytics view, opened the way a person opens it; each element's content after. */
async function analyticsSnapshot(src, rows, user = PBIS) {
  const w = world(src, { rows, currentUser: user });
  const out = {};
  for (const view of ["dashboard", "trends", "students", "expectations", "teacherInteractions"]) {
    w.app.switchAnalyticsSubtab(view);
    await settle(); await settle();
    for (const [id, e] of Object.entries(w.dom.els)) {
      // The one list that SHOWS every row by design: checked on its own in section 3.
      if (id === "teacherInteractionDetailsTableBody") continue;
      out[view + "#" + id] = e.innerHTML + "\u0001" + e.textContent;
    }
  }
  const reversed = w.app.reversedCashIds();
  const clicks = w.app.cashClickModel(rows, reversed).clicks;
  const trend = w.app.cashTrendWeeks({ rows, reversedIds: reversed, staff: STAFF, students: STUDENTS,
    campusOf: MODS.WildcatStore.studentCampusOf, cutoffIso: "2026-09-14", todayIso: "2026-10-06" });
  const praise = w.app.cashPraiseWeeks({ model: w.app.cashClickModel(rows, reversed), cutoffIso: "2026-09-14", todayIso: "2026-10-06" });
  const strip = w.app.cashWeekStripModel({ rows, reversedIds: reversed, nowMs: NOW, todayIso: "2026-10-06", praise });
  // The home dashboard's "cash awarded this week", by its own rule: this week's rows, awards by kind.
  const weekRows = w.app.cashGaugeWeekRows(rows, w.app.cashGaugeWeekStartMs(NOW), null, null);
  const homeAwarded = weekRows.filter((t) => w.app.cashBehaviourKind(t, reversed) === "award")
    .reduce((n, t) => n + Math.abs(Number(t.amount) || 0), 0);
  return { out, clicks, trend, praise, strip, homeAwarded, w };
}
function diffKeys(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]);
}

// ==================================================================== 1
console.log("\n1. Staff analytics leave the payment out: every number is the same with a payday in the ledger");
const STAFF_ROWS = staffRows();
const PAY_ROWS = paydayRows();
async function sameWithPayday(src) {
  const without = await analyticsSnapshot(src, STAFF_ROWS);
  const withPay = await analyticsSnapshot(src, [...STAFF_ROWS, ...PAY_ROWS]);
  return {
    screens: diffKeys(without.out, withPay.out),
    clicks: J(without.clicks) === J(withPay.clicks),
    trend: J(without.trend) === J(withPay.trend),
    praise: J(without.praise) === J(withPay.praise),
    strip: J(without.strip) === J(withPay.strip),
    home: without.homeAwarded === withPay.homeAwarded,
    without, withPay,
  };
}
{
  const r = await sameWithPayday(scriptSrc);
  check("the world is real: the Overview, Staff, Trends and Expectations screens drew something",
    /\d/.test(r.without.out["dashboard#dashTotalPositive"] || "") && Object.keys(r.without.out).length > 20,
    String(Object.keys(r.without.out).length));
  check("and the payday rows really are in the second ledger (81 movements and a reversal)",
    r.withPay.w.app.cashBehaviourKind(PAY_ROWS[0], new Set()) === null && PAY_ROWS.length === 82);
  check("EVERY ELEMENT OF EVERY CASH ANALYTICS VIEW IS IDENTICAL with two paydays added (Overview, Trends, Students, Expectations, Staff)",
    r.screens.length === 0, r.screens.slice(0, 6).join(" | "));
  check("the click model is identical: no forty-student 'whole-class press' from Wildcat Hub", r.clicks);
  check("...so one-to-one praise and whole-class detection are unchanged",
    J(r.without.clicks.filter((c) => c.oneToOne).length) === J(r.withPay.clicks.filter((c) => c.oneToOne).length)
    && r.withPay.clicks.every((c) => c.actor !== "system:attendance"));
  check("Trends' weeks are identical (awards, teachers and others awarding, students reached)", r.trend);
  check("the 5 to 1 weeks (per press and per student) are identical", r.praise);
  check("the Overview week strip is identical", r.strip);
  check("the home dashboard's 'cash awarded this week' is identical (Monday's payday is not an award)",
    r.home && r.without.homeAwarded > 0, String(r.without.homeAwarded));
  check("the Overview tiles: awards, deductions and dollars awarded",
    ["dashTotalPositive", "dashTotalNegative", "dashTotalAwarded", "avgPositivityRatio"].every((id) =>
      r.without.out["dashboard#" + id] === r.withPay.out["dashboard#" + id]));
  check("the Staff tab's table and totals",
    ["teacherActivityTableBody", "teacherInteractionsTotalPositive", "teacherInteractionsActiveCount", "teacherInteractionsPositivityRatio"]
      .every((id) => r.without.out["teacherInteractions#" + id] === r.withPay.out["teacherInteractions#" + id]));
  check("quiet students and the daily goal read the same filter (isCashBehaviourRow on every move)",
    /const moves = \(Array\.isArray\(cashTransactions\)[\s\S]{0,260}isCashBehaviourRow\(t, _quietReversedIds\)\)/.test(code));
  check("...and the home tile counts awards by kind", /const cashAwarded = cashThisWeek\s*\.filter\(t => cashBehaviourKind\(t, _weekReversedIds\) === 'award'\)/.test(code));

  // TEETH. Two rules keep the payment out, so either alone is enough -- and
  // both gone, the screens change.
  const KIND_RULE = "            if (kind && kind !== 'award' && kind !== 'deduct') return false;\n";
  const MARKS_RULE = "            if (/^system:/i.test(String(t.behaviorId || '').trim())\n" +
    "                || /^system:/i.test(String(t.teacherId || '').trim())) return false;\n";
  const noKind = breakOnce(scriptSrc, KIND_RULE, "            if (kind && kind !== 'award' && kind !== 'deduct' && kind !== 'attendance') return false;\n", "kind");
  const noMarks = breakOnce(scriptSrc, MARKS_RULE, "", "marks");
  const neither = breakOnce(noKind, MARKS_RULE, "", "both");
  const a = await sameWithPayday(noKind), b = await sameWithPayday(noMarks), c = await sameWithPayday(neither);
  check("BELT AND BRACES: with the kind rule loosened to count 'attendance', the system marks alone still keep every screen the same",
    a.screens.length === 0 && a.clicks && a.trend && a.praise && a.strip && a.home, a.screens.slice(0, 3).join(" | "));
  check("...and with the marks check gone, the kind rule alone does", b.screens.length === 0 && b.clicks && b.trend && b.home);
  check("TEETH: with both gone the payday reaches the screens: the Overview tiles move",
    c.screens.some((k) => k.startsWith("dashboard#dashTotal")), c.screens.slice(0, 4).join(" | "));
  check("TEETH: ...the click model gets a forty-student whole-class press from Wildcat Hub",
    !c.clicks && c.withPay.clicks.some((x) => x.actor === "system:attendance" && x.sizeClass === "whole" && x.size === 40));
  check("TEETH: ...and the home tile counts the payday as cash awarded", !c.home && c.withPay.homeAwarded - c.without.homeAwarded > 0,
    String(c.withPay.homeAwarded - c.without.homeAwarded));
}

console.log("\n1b. A row carrying the system marks under another kind is still not a behaviour");
{
  const { app } = world(scriptSrc);
  const forged = [
    { ...row({ s: "s1", at: T(10, 5, 9) }), teacherId: "system:attendance" },
    { ...row({ s: "s1", at: T(10, 5, 9) }), behaviorId: "system:perfect-day" },
    { ...row({ s: "s1", at: T(10, 5, 9) }), behaviorId: " SYSTEM:perfect-day", teacherId: "T1" },
    { ...row({ s: "s1", at: T(10, 5, 9) }), kind: undefined, teacherId: "system:attendance" },
    { ...row({ s: "s1", at: T(10, 5, 9) }), kind: "Attendance" },
  ];
  check("kind award with a system giver, a system behaviour, either case, kindless, or a capitalised kind: none is a behaviour",
    forged.every((t) => app.isCashBehaviourRow(t, new Set()) === false && app.cashBehaviourKind(t, new Set()) === null));
  check("an adult's own award is still one", app.cashBehaviourKind(row({ s: "s1", at: T(10, 5, 9) }), new Set()) === "award");
  check("an id that merely CONTAINS 'system' is an adult's", app.cashBehaviourKind({ ...row({ s: "s1", at: T(10, 5, 9) }), behaviorId: "wc_system_reset_like" }, new Set()) === "award");
  const noMarks = world(breakOnce(scriptSrc, "            if (/^system:/i.test(String(t.behaviorId || '').trim())\n" +
    "                || /^system:/i.test(String(t.teacherId || '').trim())) return false;\n", "", "marks-forged")).app;
  check("TEETH: without the marks check a mis-kinded system row counts as praise",
    noMarks.cashBehaviourKind(forged[0], new Set()) === "award");
}

// ==================================================================== 2
console.log("\n2. The leaderboard counts it (owner, 2026-10-12)");
{
  const students = [
    kid(1, 7, { wildcatCashEarned: 900 }),                 // staff awards only
    kid(2, 7, { wildcatCashEarned: 300 + 2000 }),          // $300 from staff, $2,000 of perfect days
  ];
  const w = world(scriptSrc, { students });
  w.app.updateCashLeaderboards();
  const board = el(w, "topEarnersBoard").innerHTML;
  check("Top Earners ranks on Earned, perfect-day money included: the attendance earner is first",
    board.indexOf("Stu2") > -1 && board.indexOf("Stu2") < board.indexOf("Stu1") && /\$2300/.test(board), board.replace(/\s+/g, " ").slice(0, 200));
  check("the student portal's board ranks on the same counter", /wildcatCashEarned/.test(read("./convex/leaderboardRules.ts")));
  check("and the money is written to that counter (cashMovementEffect: a positive movement that is not a purchase is earned)",
    /cashMovementEffect\(/.test(pdServer));
}

// ==================================================================== 3
console.log("\n3. The Staff tab's interaction list: a grey 'Attendance' badge, never 'Positive'");
async function detailsFor(src, type) {
  const w = world(src, { rows: [...STAFF_ROWS.slice(0, 3), payout("s5", T(10, 5, 7, 42))], currentUser: PBIS });
  el(w, "teacherInteractionFilterType").value = type;
  w.app.updateTeacherInteractionDetails();
  return el(w, "teacherInteractionDetailsTableBody").innerHTML;
}
{
  const all = await detailsFor(scriptSrc, "");
  const pdRow = all.split("<tr").find((r) => /Perfect attendance/.test(r)) || "";
  check("the payment is listed (the All filter shows every row), from Wildcat Hub", /Wildcat Hub \(attendance\)/.test(pdRow));
  check("with a grey 'Attendance' badge", /#6E7885;[^>]*>\s*Attendance\s*</.test(pdRow), pdRow.replace(/\s+/g, " ").slice(0, 400));
  check("not a green 'Positive' one", !/Positive/.test(pdRow) && !/#2E7D52/.test(pdRow));
  check("an adult's award still reads Positive", /Positive/.test(all));
  const positive = await detailsFor(scriptSrc, "positive");
  check("'Positive only' leaves the payment out", !/Perfect attendance/.test(positive) && /Be Respectful/.test(positive));
  const broken = breakOnce(scriptSrc, "                    : isAttendance ? 'Attendance'\n", "", "badge");
  check("TEETH: without its branch the payment wears 'Positive'",
    /Positive/.test(((await detailsFor(broken, "")).split("<tr").find((r) => /Perfect attendance/.test(r))) || ""));
}

// ==================================================================== 4
console.log("\n4. The payday's summary entry: a cash entry with no amount, off a teacher's feed");
const SUMMARY = {
  entryId: "a_perfectday_20261019_pd_x", timestamp: "2026-10-19T16:40:00.000Z", action: "perfect_day_paid", category: "Wildcat Cash",
  studentId: "all", studentName: "All students", teacher: "Wildcat Hub (attendance)", teacherName: "Wildcat Hub (attendance)",
  teacherId: "system:attendance", behavior: "Perfect attendance (automatic)",
  notes: "Perfect attendance paid for the week before Mon 10/19: 370 students, 1850 perfect days.",
  reason: "Perfect attendance paid for the week before Mon 10/19: 370 students, 1850 perfect days.",
};
{
  check("perfect_day_paid is a cash action", CA.CASH_ACTIONS.includes("perfect_day_paid") && CA.isCashEntry(SUMMARY));
  const d = CA.describe(SUMMARY);
  check("labelled, and with NO amount: a dash, never '+$0'", d.actionLabel === "Perfect Attendance Paid" && d.amount === null && d.signed === null);
  check("...even if a writer puts a 0 (or a number) in ticketCount",
    CA.describe({ ...SUMMARY, ticketCount: 0 }).signed === null && CA.describe({ ...SUMMARY, ticketCount: 1850 }).signed === null);
  check("behaviour and notes are its own fields, not the sentence split at a comma",
    d.behavior === "Perfect attendance (automatic)" && /370 students, 1850 perfect days/.test(d.notes));
  check("other sign-0 actions keep their figures (describe changed for this action only)",
    CA.describe({ action: "cash_recount", ticketCount: 3 }).signed === 0 && CA.describe({ action: "cash_award", ticketCount: 5 }).signed === 5);
  check("the server writes exactly that action, from the system, with behaviour and notes and no ticketCount",
    /action: "perfect_day_paid"/.test(pdServer) && /teacherId: R\.SYSTEM_ACTOR\.id/.test(pdServer) &&
    /behavior: "Perfect attendance \(automatic\)", notes: reason/.test(pdServer) &&
    !/ticketCount/.test(strip(pdServer.slice(pdServer.indexOf("export const finishPayday"), pdServer.indexOf("export const finishRun")))));

  const feedFor = (src, user, mods = MODS) => {
    const w = world(src, { currentUser: user, mods });
    return w.app.dashFeedEntriesFor([SUMMARY, { action: "Awarded Tickets", teacherId: "T1", studentId: "s1" }], user);
  };
  check("A TEACHER'S ACTIVITY FEED DOES NOT SHOW IT", !feedFor(scriptSrc, TEACHER).includes(SUMMARY) && feedFor(scriptSrc, TEACHER).length === 1);
  check("an admin's, a superadmin's and the PBIS team's do",
    [ADMIN, SUPER, PBIS].every((u) => feedFor(scriptSrc, u).includes(SUMMARY)));
  check("nor the teacher's Cash Audit Log", world(scriptSrc, { currentUser: TEACHER }).app.cashAuditEntriesFor([SUMMARY], TEACHER).length === 0);
  const { app } = world(scriptSrc);
  check("its feed category is System, not 'Cash Earned' (no adult gave it)", app.wcFeedCat(SUMMARY).key === "system");
  // A tab without the registration: the reason the server keeps the entry off by default.
  const oldCa = loadModules([rosterSrc, storeSrc, cashAuditSrc.replace("    'cash_reversal_debit',\n    'perfect_day_paid'\n", "    'cash_reversal_debit'\n")]);
  check("TEETH: a cash module that does not know the action shows it on every teacher's feed (why auditSummary waits for this site)",
    feedFor(scriptSrc, TEACHER, oldCa).includes(SUMMARY));
  check("and the runbook says to switch the summary on only after this site has spread",
    /auditSummary[\s\S]{0,400}20261012c/.test(read("./docs/runbook.md")));
}

// ==================================================================== 5
console.log("\n5. What a student sees: 'Perfect day – pending', and the payment in their history");
const pendingFn = new Function(liftFn(scriptSrc, "wpPerfectDayPending") + "\nreturn wpPerfectDayPending;")();
const TUE = new Date(2026, 9, 13, 8, 0);      // Tuesday 10/13, the morning 10/12 was decided
{
  const p = pendingFn({ days: ["2026-10-12"], amount: 100, payday: "2026-10-19" }, TUE);
  check("one day: 'Perfect day – pending', 'Mon 10/12', +$100, 'Arrives Monday 10/19'",
    p.title === "Perfect day – pending" && p.days === "Mon 10/12" && p.amountText === "+$100" && p.when === "Arrives Monday 10/19", J(p));
  const three = pendingFn({ days: ["2026-10-14", "2026-10-12", "2026-10-13"], amount: 300, payday: "2026-10-19" }, TUE);
  check("three days, in date order: '3 perfect days – pending', 'Mon 10/12, Tue 10/13, Wed 10/14', +$300",
    three.title === "3 perfect days – pending" && three.days === "Mon 10/12, Tue 10/13, Wed 10/14" && three.amountText === "+$300", J(three));
  check("on payday morning before the money moves: 'Arrives today'",
    pendingFn({ days: ["2026-10-16"], amount: 100, payday: "2026-10-19" }, new Date(2026, 9, 19, 7, 0)).when === "Arrives today");
  check("a payday already gone by never shows its date: 'On its way'",
    pendingFn({ days: ["2026-10-16"], amount: 100, payday: "2026-10-19" }, new Date(2026, 9, 20, 9, 0)).when === "On its way");
  check("NOTHING when the server sends null (off, shadow, outside the pilot, a control)", pendingFn(null, TUE) === null);
  check("nothing for no days, a missing field, or a malformed answer",
    [undefined, {}, { days: [] }, { days: "2026-10-12" }, { days: [null, "Monday"] }, "x"].every((x) => pendingFn(x, TUE) === null));
  check("an unreadable amount is a dash, never $0",
    pendingFn({ days: ["2026-10-12"], amount: null, payday: "2026-10-19" }, TUE).amountText === "—");
  check("the server sends only days that will be paid (pendingForStudent: payable, in scope, pending)",
    /status === "pending" && r\.payable && scopeOf\(settings, sn, r\.date\)\.payable/.test(pdRules));
}

// The wallet card, built as student-rewards-card.test.mjs builds it, with the helper beside it.
const cardBody = scriptSrc.slice(scriptSrc.indexOf("function wpRewardsCard"), scriptSrc.indexOf("function wpMealCard"));
const faces = scriptSrc.slice(scriptSrc.indexOf("const WP_FACE = {"), scriptSrc.indexOf("function wpEmpty"));
const esc = (x) => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function buildCard(src, withHelper = true) {
  const body = src.slice(src.indexOf("function wpRewardsCard"), src.indexOf("function wpMealCard"));
  return new Function("WP_FACE", "wpEsc", "wpEmpty", "wpFoot", "__Date",
    "const Date = __Date;\n" + faces.slice(faces.indexOf("{")).replace(/^\{/, "const F = {") + ";\n" +
    (withHelper ? liftFn(src, "wpPerfectDayPending") + "\n" : "") +
    body.replace(/WP_FACE\./g, "F.") + "\nreturn wpRewardsCard;")(null, esc, (t) => `<p class="wp-empty">${t}</p>`, (t) => `<p class="wp-foot">${t}</p>`, dateAt(TUE.getTime()));
}
const PAID_ROW = { at: "2026-10-12T14:42:00.000Z", kind: "attendance", amount: 400, reason: "Perfect attendance — 4 days",
  note: "Mon 10/5, Tue 10/6, Wed 10/7, Fri 10/9", by: "Wildcat Hub (attendance)", balanceAfter: 1400 };
const AWARD_ROW = { at: "2026-10-12T17:00:00.000Z", kind: "award", amount: 100, reason: "Be Respectful", note: "held the door", by: "Ms. Lee" };
{
  const card = buildCard(scriptSrc);
  const c = card({ wildcatCash: { balance: 1500, recent: [AWARD_ROW, PAID_ROW], perfectDays: { days: ["2026-10-12"], amount: 100, payday: "2026-10-19" } },
    points: { total: 0 } });
  check("WALLET: the pending line is there, with its days, its amount and its Monday",
    /wp-tx is-pending[\s\S]*Perfect day – pending[\s\S]*Mon 10\/12[\s\S]*Arrives Monday 10\/19[\s\S]*is-pending">\+\$100</.test(c.body));
  check("...and it leads: before the movements that have happened", c.body.indexOf("is-pending") < c.body.indexOf("Be Respectful"));
  check("the weekly payment in the history reads 'Perfect attendance — 4 days', by Wildcat Hub (attendance), with its days",
    /Perfect attendance — 4 days<\/span><span class="wp-tx-sub">Wildcat Hub \(attendance\)/.test(c.body) && /Mon 10\/5, Tue 10\/6, Wed 10\/7, Fri 10\/9/.test(c.body));
  check("as money in, like an award", /is-plus">\+\$400</.test(c.body));
  const noReason = card({ wildcatCash: { balance: 1, recent: [{ ...PAID_ROW, reason: null }] }, points: {} });
  check("a payment that arrived without its label still says what it is", /Perfect attendance</.test(noReason.body));
  const none = card({ wildcatCash: { balance: 1500, recent: [AWARD_ROW], perfectDays: null }, points: {} });
  check("no perfect days for this student: no pending line, nothing promised", !/pending/i.test(none.body));
  const onlyPending = card({ wildcatCash: { balance: 0, recent: [], perfectDays: { days: ["2026-10-12"], amount: 100, payday: "2026-10-19" } }, points: {} });
  check("a first-ever perfect day with no history yet: the line shows, not 'No activity yet'",
    /Perfect day – pending/.test(onlyPending.body) && !/No activity yet/.test(onlyPending.body));
  const bare = buildCard(scriptSrc, false)({ wildcatCash: { balance: 1, recent: [AWARD_ROW], perfectDays: { days: ["2026-10-12"], amount: 100 } }, points: {} });
  check("built on its own without the helper (as its own test builds it), the card still draws, with no line",
    /Be Respectful/.test(bare.body) && !/pending/.test(bare.body));
}

// The desk dashboard, built as student-dashboard.test.mjs builds it.
const PRELUDE = `const wpEsc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
   const wpEmpty = (t) => '<p class="wp-empty">' + wpEsc(t) + '</p>';
   const wpFoot  = (t) => '<p class="wp-foot">' + wpEsc(t) + '</p>';
   const wpPeriodRank = (p) => { const n = parseInt(String(p ?? ""), 10); return isNaN(n) ? 999 : n; };
   const wpWhen = (iso) => String(iso).slice(5, 10);
   const __el = { innerHTML: "", classList: { add(){}, remove(){} } };
   const wpById = (id) => null;
   const localStorage = { getItem: () => null, setItem() {} };
   const Date = __Date;\n`;
function buildDesk(src) {
  const a = src.indexOf("/* ---- the desk dashboard ---"), b = src.indexOf("/* ---- end desk dashboard ---- */", a);
  return new Function("__Date", PRELUDE + src.slice(a, b) + "\nreturn wpDashboard;")(dateAt(TUE.getTime()));
}
{
  const wpDashboard = buildDesk(scriptSrc);
  const mine = (pd, recent = [AWARD_ROW, PAID_ROW]) => ({ points: {}, attendance: {},
    wildcatCash: { balance: 1500, earned: 2000, spent: 500, recent, perfectDays: pd } });
  const grades = { rows: [], available: true, reason: null };
  const out = wpDashboard(mine({ days: ["2026-10-12", "2026-10-13"], amount: 200, payday: "2026-10-19" }), { rows: [], available: true }, grades);
  check("DESK DASHBOARD: '2 perfect days – pending', 'Mon 10/12, Tue 10/13', +$200, 'Arrives Monday 10/19', in Recent activity",
    /Recent activity<\/p><div class="wp-rows wp-rows-nested wp-pending-rows"><div class="wp-row wp-row-nested wp-row-pending">[\s\S]*2 perfect days – pending[\s\S]*Mon 10\/12, Tue 10\/13[\s\S]*Arrives Monday 10\/19[\s\S]*wp-amt-pending">\+\$200</.test(out),
    out.slice(out.indexOf("Recent activity"), out.indexOf("Recent activity") + 300));
  check("...ahead of the movements, and the payment reads as its label", out.indexOf("wp-row-pending") < out.indexOf("Be Respectful") &&
    /Perfect attendance — 4 days/.test(out));
  check("no perfect days: nothing pending on the desk either", !/pending/i.test(wpDashboard(mine(null), { rows: [] }, grades)));
  const first = wpDashboard(mine({ days: ["2026-10-12"], amount: 100, payday: "2026-10-19" }, []), { rows: [] }, grades);
  check("a pending day and no history: the line, not 'Nothing yet'", /Perfect day – pending/.test(first) && !/Nothing yet\. When a teacher/.test(first));
  check("the styles exist: pending amounts dimmed, the rule dashed",
    /\.wp-rowend\.wp-amt-pending\s*\{/.test(css) && /\.wp-row-pending\s*\{[^}]*dashed/.test(css) &&
    /\.wp-tx\.is-pending\s*\{[^}]*dashed/.test(css) && /\.wp-tx-amt\.is-pending\s*\{/.test(css));
}

// ==================================================================== 6
console.log("\n6. Staff Accounts: the payment is in a student's history (it has no audit entry)");
{
  const pay = payout("s7", T(10, 5, 7, 42));
  const rows = CA.systemRowsByStudent([pay, { ...pay }, row({ s: "s7", at: T(10, 5, 9) }), payout("s8", T(10, 5, 7, 42) + 1)]);
  check("one pass finds each student's payments, each id once (the ledger and the record both hold a copy)",
    rows.s7.length === 1 && rows.s8.length === 1 && !rows.s1);
  const d = rows.s7[0];
  check("described like an audit entry: 'Perfect Attendance', +$400, by Wildcat Hub (attendance), its label and days",
    d.actionLabel === "Perfect Attendance" && d.signed === 400 && d.teacher === "Wildcat Hub (attendance)" &&
    d.behavior === "Perfect attendance — 4 days" && /Mon 9\/28/.test(d.notes), J(d));
  check("an adult's movement is not taken from the ledger (its audit entry already shows it)",
    !Object.values(rows).flat().some((x) => x.behavior === "Be Respectful"));
  const merged = CA.mergeHistory([{ timestamp: "2026-10-06T16:00:00.000Z", actionLabel: "Cash Awarded" }, { timestamp: "2026-10-01T16:00:00.000Z", actionLabel: "Cash Deducted" }], rows.s7);
  check("merged with the audit entries, newest first", merged.map((x) => x.actionLabel).join() === "Cash Awarded,Perfect Attendance,Cash Deducted");

  const student = kid(7, 7, { wildcatCashTransactions: [{ ...payout("s7", T(9, 28, 7, 42)), studentId: undefined }] });
  const w = world(scriptSrc, { rows: [pay], students: [student], currentUser: TEACHER,
    auditLog: [{ entryId: "e1", timestamp: "2026-10-06T16:00:00.000Z", action: "cash_award", studentId: "s7", teacher: "Ms. Lee", ticketCount: 100, behavior: "Be Respectful" }] });
  w.app.showStudentCashHistory("s7");
  const body = (w.G.dialogs || [])[0]?.body || "";
  check("'View full history' lists both payments (the ledger's and the one only on the record) and the adult's award",
    (body.match(/Perfect Attendance/g) || []).length === 2 && /Be Respectful/.test(body) && /3 records/.test(body), body.replace(/\s+/g, " ").slice(0, 300));
  check("as money in", /chr-up">\+\$400/.test(body));
  check("the Accounts card's Recent Activity merges them too",
    /const systemRows = CA\.systemRowsByStudent\(systemCashRowsHeld\(\)\)/.test(code) &&
    /CA\.mergeHistory\(CA\.forStudent\(auditLog, student\.id\)[\s\S]{0,120}systemRows\[String\(student\.id\)\]\)/.test(code));
  check("TEETH: the history without the merge would not show them",
    !/Perfect Attendance/.test((() => { const x = world(breakOnce(scriptSrc,
      "            const rows = CA.mergeHistory(CA.forStudent(auditLog, studentId).map(e => CA.describe(e)),\n                CA.systemRowsByStudent(systemCashRowsHeld())[String(studentId)]);",
      "            const rows = CA.forStudent(auditLog, studentId).map(e => CA.describe(e));", "merge"), { rows: [pay], students: [student], currentUser: TEACHER });
      x.app.showStudentCashHistory("s7"); return (x.G.dialogs || [])[0]?.body || ""; })()));
  check("Reverse warns that the weekly payment is every day in it", /r\.kind === 'attendance'[\s\S]{0,160}This takes back every day in this payment/.test(scriptSrc));
}

// ==================================================================== 7
console.log("\n7. A movement refused as reserved_kind leaves the save queue for good, silently");
{
  const setOf = (name) => {
    const m = new RegExp("const " + name + " = new Set\\(\\[([^\\]]*)\\]\\);").exec(code);
    return m ? m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")) : [];
  };
  check("reserved_kind is a final refusal", setOf("CASH_TERMINAL_REFUSALS").includes("reserved_kind"));
  check("...that no teacher is told about (only a forged movement earns it)", !setOf("CASH_REFUSALS_TO_SAY").includes("reserved_kind"));
  check("and the server holds a movement with that reason", /refused\.push\(\{ id, why: "reserved_kind" \}\)/.test(read("./convex/appDataShape.ts")));
}

// ==================================================================== 8
console.log("\n8. The admin card: the server's status, read only, with names");
const STATUS = {
  settings: { mode: "pilot", amount: 100, countFromDate: "2026-10-22", liveFrom: null, pilot: 12, controls: 3, lookbackSchoolDays: 10, auditSummary: false },
  invalid: null, today: "2026-10-27", lease: null, lastDoneDate: "2026-10-27", lastPayWeek: "2026-10-26",
  runs: [{ runId: "pd_1", trigger: "tick", startedAt: "2026-10-27T14:42:00.000Z", finishedAt: "2026-10-27T14:44:00.000Z", ok: true, reason: "ok" }],
  dates: [
    { date: "2026-10-26", state: "school", reason: "Decided.", enrolled: { ms: 336, hs: 271, other: 0 }, perfect: { ms: 229, hs: 141, other: 0 }, classesNoMarks: 3 },
    { date: "2026-10-23", state: "held", reason: "Far fewer students marked than usual: held.", retryable: false },
    { date: "2026-10-21", state: "no-school", reason: "No attendance at all: no school." },
  ],
  held: { count: 1, list: [{ studentNumber: "N7", date: "2026-10-26", why: "The Perfect Attendance screen shows an absence or tardy that PowerSchool's read does not." }] },
  paidThenBroken: { count: 1, handled: 0, list: [{ studentNumber: "N8", date: "2026-10-22", txnId: "txn_1", why: "a late T" }] },
  nextPayday: { payWeek: "2026-11-02", students: 11, days: 22, total: 2200, earnedNotPaid: { "outside-pilot": 900, control: 6 } },
  controls: { count: 3, paidMovements: 0 },
};
async function cardFor(src, user, o = {}) {
  const w = world(src, { currentUser: user, students: STUDENTS, server: async (name) => {
    if (name !== "perfectDay:adminStatus") throw new Error("unexpected " + name);
    if (o.refuse) throw new Error("Admins only.");
    return o.status === undefined ? STATUS : o.status;
  } });
  w.app.renderPerfectDayPanel();
  await settle(); await settle();
  return { html: el(w, "perfectDayPanel").innerHTML, queries: w.G.queries };
}
{
  const a = await cardFor(scriptSrc, ADMIN);
  check("an admin's Cash Audit Log asks perfectDay:adminStatus once", a.queries.join() === "perfectDay:adminStatus");
  check("the mode, the amount and the start", /Pilot: 12 students, 3 controls/.test(a.html) && /\$100 a perfect day, counting from Thu 10\/22/.test(a.html));
  check("the last run", /Last run[\s\S]*finished/.test(a.html));
  check("each date: counts, classes with no marks, and why a date was held",
    /Mon 10\/26[\s\S]*370 of 607 perfect &middot; 3 classes with no marks[\s\S]*Decided/.test(a.html) &&
    /Fri 10\/23[\s\S]*Far fewer students marked[\s\S]*Held/.test(a.html) && /No school/.test(a.html));
  check("held students and paid-then-broken days BY NAME, joined from this tab's roster",
    /Held students[\s\S]*Stu7 Last7 \(N7\)/.test(a.html) && /Paid, then broken[\s\S]*Stu8 Last8 \(N8\)/.test(a.html));
  check("the next payday: students, days, the school's total, and what is earned but not paid",
    /Next payday[\s\S]*Mon 11\/2 &middot; 11 students, 22 days, \$2,200 in all &middot; not paid: 900 outside the pilot, 6 controls/.test(a.html), a.html.slice(a.html.indexOf("Next payday"), a.html.indexOf("Next payday") + 250));
  check("the controls: none paid", /Controls[\s\S]*3, none paid/.test(a.html));
  check("it says it changes nothing, and where the switch is", /Nothing here changes anything/.test(a.html) && /runbook/.test(a.html));
  check("no dollar figure for any student or group: one $ for the amount, one for the school's payday",
    (a.html.match(/\$/g) || []).length === 2, String((a.html.match(/\$/g) || []).length));
  check("a superadmin sees it too", /Perfect-day award/.test((await cardFor(scriptSrc, SUPER)).html));
  const t = await cardFor(scriptSrc, TEACHER);
  check("A TEACHER sees nothing and asks nothing", t.html === "" && t.queries.length === 0);
  const pb = await cardFor(scriptSrc, PBIS);
  check("nor the PBIS team (the server lets admins only)", pb.html === "" && pb.queries.length === 0);
  check("a refusal or an older backend: no card", (await cardFor(scriptSrc, ADMIN, { refuse: true })).html === "");
  check("never switched on: no card",
    (await cardFor(scriptSrc, ADMIN, { status: { ...STATUS, settings: { mode: "off" }, runs: [], dates: [], held: { count: 0 }, paidThenBroken: { count: 0 } } })).html === "");
  const paid = await cardFor(scriptSrc, ADMIN, { status: { ...STATUS, controls: { count: 3, paidMovements: 1 } } });
  check("a control that was paid is said out loud", /A control was paid/.test(paid.html));
  const bad = await cardFor(scriptSrc, ADMIN, { status: { ...STATUS, settings: { mode: "off" }, invalid: "The stored amount (0) is not a whole number from 1 to 1000." } });
  check("an unreadable switch is said out loud", /not a whole number[\s\S]*treated as off/.test(bad.html));
  const nameless = await cardFor(scriptSrc, ADMIN, { status: { ...STATUS, held: { count: 1, list: [{ studentNumber: "Z9", date: "2026-10-26", why: "x" }] } } });
  check("a number the roster does not know is shown as a number, not dropped", /Student #Z9/.test(nameless.html));
  const many = await cardFor(scriptSrc, ADMIN, { status: { ...STATUS, held: { count: 140,
    list: Array.from({ length: 100 }, (_, i) => ({ studentNumber: "N" + (i + 1), date: "2026-10-26", why: "x" })) },
    paidThenBroken: { count: 0, handled: 0, list: [] } } });
  check("ten held students by name, and the rest counted against the total (140), not the page the server sent (100)",
    (many.html.match(/<li>Stu/g) || []).length === 10 && /and 130 more/.test(many.html));
  const unchecked = await cardFor(scriptSrc, ADMIN, { status: { ...STATUS, dates: [{ ...STATUS.dates[0],
    reason: "Decided without the second check (no rebuild after the day): nothing new becomes payable until it runs." }] } });
  check("a date decided without the second check says so beside its counts", /370 of 607 perfect[\s\S]*without the second check/.test(unchecked.html));
  check("the last payday", /Last payday[\s\S]*Mon 10\/26/.test(a.html));
  check("names are escaped", /&lt;b&gt;/.test((await (async () => {
    const w = world(scriptSrc, { currentUser: ADMIN, students: [kid(7, 7, { firstName: "<b>" })] });
    return w.app.perfectDayPanelHtml(STATUS, w.app.perfectDayNameOf);
  })())));

  // The server side of the card.
  const fn = strip(pdServer.slice(pdServer.indexOf("export const adminStatus")));
  check("perfectDay:adminStatus is a public query that asks requireAdmin before anything",
    /export const adminStatus = query\(\{\s*args: \{\},\s*handler: async \(ctx\) => \{\s*await requireAdmin\(ctx\);\s*return statusFor\(ctx, 10\);/.test(fn));
  const sf = pdServer.slice(pdServer.indexOf("export async function statusFor"), pdServer.indexOf("export const status ="));
  check("every field the card reads is one statusFor returns",
    ["settings:", "invalid:", "lease:", "runs:", "dates:", "held:", "paidThenBroken:", "nextPayday:", "controls:",
     "enrolled:", "perfect:", "classesNoMarks:", "earnedNotPaid:", "paidMovements:"].every((k) => sf.includes(k)));
  check("the card has its home on the Cash Audit Log, after the drift panel, before the table",
    html.indexOf('id="perfectDayPanel"') > html.indexOf('id="cashDriftPanel"') && html.indexOf('id="perfectDayPanel"') < html.indexOf('id="cashAuditLogTable"'));
  check("and the Cash Audit Log draws it", /renderPerfectDayPanel\(\);\s*\n\s*renderCashDriftPanel\(\);/.test(code));
  check("its styles exist", /\.wc-drift\.wc-pd\s*\{/.test(css) && /\.wc-pd-line\s*\{/.test(css) && /\.wc-pd-warn\s*\{/.test(css));
}

// ==================================================================== 9
console.log("\n9. The browser's rule and the server's rule agree on what only the server may write");
{
  const shapeJs = ts.transpileModule(read("./convex/appDataShape.ts"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const SHAPE = await import("data:text/javascript;base64," + Buffer.from(shapeJs).toString("base64"));
  const { app } = world(scriptSrc);
  const kinds = [undefined, "", "award", "deduct", "redeem", "reversal", "attendance", "ATTENDANCE", " attendance "];
  const bids = [undefined, "wc2", "system:perfect-day", "SYSTEM:x", " system:x", "wc_system", "reward:1"];
  const tids = [undefined, "T1", "system:attendance", "System:Attendance", "systemic"];
  let n = 0, agree = 0, neverPraise = 0, server = 0;
  for (const kind of kinds) for (const behaviorId of bids) for (const teacherId of tids) {
    const r = { id: "x" + n, kind, behaviorId, teacherId, amount: 100, studentId: "s1", timestamp: "2026-10-05T14:42:00.000Z" };
    n++;
    const s = SHAPE.isSystemCashRow(r);
    if (s === CA.isSystemCashRow(r)) agree++;
    if (s) { server++; if (app.isCashBehaviourRow(r, new Set()) === false) neverPraise++; }
  }
  check(`wildcat-cashaudit.js's isSystemCashRow agrees with the server's on all ${n} rows`, agree === n, `${agree}/${n}`);
  check(`every one of the ${server} rows the server calls server-only is never a behaviour on Cash Analytics`, neverPraise === server && server > 100);
}

console.log("\n10. Wired in");
{
  check("this file runs in npm test", pkg.scripts.test.includes("node perfect-day-browser.test.mjs"));
  check("the student card reads the field the server sends", /wpPerfectDayPending\(cash\.perfectDays\)/.test(code) &&
    /perfectDays,/.test(read("./convex/views_app.ts")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
