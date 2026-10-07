// Cash Analytics, one tab per question, and click-to-sort column headings.
// Run: npm test
//
// THE OWNER, 2026-10-06: "We will do the full version after school" (the
// reorganisation previewed that afternoon), and then "can you make it sort the
// charts by clicking the column header?".
//
//   A. Overview | Trends | Students | Expectations | Staff, Staff for admins,
//      superadmins and the PBIS team only, exactly as Teacher Interactions was.
//      The internal keys did not change ('dashboard' is Overview,
//      'teacherInteractions' is Staff). The tab is remembered for the browser
//      tab and cleared at sign-out; a teacher's remembered Staff lands on
//      Overview. Flagged moved to Students and is FILLED there. Folds stay
//      open across redraws. Overview leads with the school's week counted both
//      ways, the per-student half being the Home gauge's own count.
//   B. One shared sorter: a button in each heading, ascending then
//      descending, aria-sort and a visible arrow, numbers as numbers, dates as
//      dates, words A to Z, verdicts ("too few deductions to judge") at the
//      bottom both ways, ties in drawn order, and the sort kept across every
//      redraw. It moves rows; it never changes a number.
//
// AND THE CRITIQUE'S MUST-FIXES, each run below with a check that the fix is
// load-bearing (TEETH): Flagged filled on Students; one Trends/Students branch
// (the server reads exist exactly once); folds kept open across a redraw; the
// week strip honest for a teacher and equal to the gauge for admins; the
// remembered tab wired through switchTab and cleared at logout
// (view-restore.test.mjs); the bar scoped by id so Discipline's switcher cannot
// touch it; the "what moved" note by role and by person.
//
// THE SHIPPED CODE RUNS: the functions are lifted out of script.js and run
// against a small fake DOM with the real wildcat-roster.js and
// wildcat-store.js. CSS cannot run here; the data-cview hiding and the sticky
// column were checked in a real browser with placeholder names only.

process.env.TZ = "America/Los_Angeles";

import { readFileSync } from "node:fs";

const scriptSrc = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const rosterSrc = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
const storeSrc = readFileSync(new URL("./wildcat-store.js", import.meta.url), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = strip(scriptSrc);

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

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
const MODS = (() => {
  const sandbox = {};
  for (const src of [rosterSrc, storeSrc]) new Function("globalThis", src).call(sandbox, sandbox);
  return sandbox;
})();

function makeEl(id) {
  const cls = new Set();
  const attrs = new Map();
  return {
    id, innerHTML: "", textContent: "", value: "", hidden: false, style: {}, focused: 0,
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    focus() { this.focused++; },
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
  const page = opts.html || html;
  const byId = (id) => {
    if (!new RegExp(`\\bid="${id}"`).test(page)) return null;
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
  "setCashCountUnit", "cashRatioPlain", "cashRatioPlainHtml", "cashClickTotals", "cashSchoolClickWindow", "cashSchoolWeekClicks",
  "cashLastFinishedMonday", "cashFinishedMondays", "cashStudentGroups", "cashPraiseWeeks", "cashReachWindow", "cashReachModel",
  "cashNoticeDefaultSince", "cashNoticeSinceFor", "setCashNoticeSince", "cashNeverNoticed", "cashExpectationBalance",
  "cashOutcomeWeeks", "cashShortDate", "cashPraiseHtml", "cashShareWords", "cashReachHtml", "cashNeverNoticedHtml",
  "cashOutcomeHtml", "cashBalanceHtml", "cashPaneOpen", "cashTrendsContextNow", "cashNoticeMarksNow", "loadCashTrendsContext",
  "loadCashNeverNoticedMarks", "dashSelectedGrades",
  "cashViewKey", "cashRememberView", "cashRememberedView", "openCashAnalytics", "cashHistorySinceLabel", "cashSinceChips",
  "cashChipsHtml", "cashMovedNoteKey", "cashMovedNoteHtml", "renderCashMovedNote", "dismissCashMovedNote", "openCashGlossary",
  "closeCashGlossary", "cashFoldKey", "cashFoldHtml", "setCashFoldOpen", "cashFoldToggled", "wcSortCellText", "wcSortValue", "wcSortColumnType",
  "wcSortOrder", "wcSortSet", "wcSortTh", "wcSortRowCellText", "wcSortRowsHtml", "wcSortMarkHead", "wcSortApplyDom", "wcSortClick", "cashViewerChanged", "cashBarIntoView",
  "cashKeepPlace", "cashGlossaryKeydown",
  "cashGaugeWeekStartMs", "cashGaugeWeekRows", "cashRowKindCounts", "cashWeekStripModel", "cashWeekStripHtml", "renderCashWeekStrip",
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
/** Counts each build of the expectation balance, so "never on a gate run" can be checked. */
const countBalance = (src) => breakOnce(src, "        function cashExpectationBalance(o) {\n",
  "        function cashExpectationBalance(o) {\n            window.__balanceBuilds = (window.__balanceBuilds || 0) + 1;\n", "count-balance");

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
    let _paCache = null;
    let _cashGlossaryOpener = null;
    function switchTab(name) {
      let view = null;
      try { view = window.sessionStorage.getItem('wcCashAnalyticsView'); } catch (e) { view = 'threw'; }
      (G.switched = G.switched || []).push(name + '@' + view);
    }
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
      ${FNS.join(", ")}
    };`;
  return new Function("G", body)(G);
}

// ---------------------------------------------------------------- the world
// Today is Tuesday 2026-10-06, 10:00 in Los Angeles. Cash history starts 9/14.
const NOW = new Date(2026, 9, 6, 10, 0).getTime();
const CUTOFF = new Date(2026, 8, 14, 8, 30).getTime();
const T = (m, d, h = 10, mi = 0, s = 0) => new Date(2026, m - 1, d, h, mi, s).getTime();
let seq = 0;
function row(o) {
  const kind = o.kind || "award";
  return {
    id: o.id || "r" + (++seq), kind, type: kind === "deduct" ? "negative" : "positive",
    amount: o.amount !== undefined ? o.amount : (kind === "deduct" ? -100 : 100),
    teacherId: o.t === undefined ? "T1" : o.t, studentId: o.s, studentName: "Hidden Name",
    behaviorId: o.b || (kind === "deduct" ? "wc6" : "wc2"), behaviorName: kind === "deduct" ? "Not Being Respectful" : "Be Respectful",
    notes: o.note === undefined ? "a note" : o.note, timestamp: new Date(o.at).toISOString(),
    ...(o.extra || {}),
  };
}
const press = (o, ids, gap = 400) => ids.map((s, i) => row({ ...o, s, at: o.at + i * gap }));

const STAFF = [
  { id: "T1", name: "Ms. Lee", role: "teacher" }, { id: "T2", name: "Mr. Park", role: "teacher" },
  { id: "T3", name: "Mx. Quinn", role: "teacher" },
  { id: "P1", name: "Pat PBIS", role: "pbis" }, { id: "A1", name: "Dr. Admin", role: "admin" },
  { id: "S1", name: "Owner Person", role: "superadmin" },
  { id: "C1", name: "Casey Aide", role: "campusaide", attendanceWatch: true },
];
const by = (id) => STAFF.find((s) => s.id === id);
const PARK = by("T2"), PBIS = by("P1"), ADMIN = by("A1"), SUPER = by("S1"), AIDE = by("C1");
const kid = (n, grade, extra = {}) => ({ id: "s" + n, studentNumber: "N" + n, firstName: "Stu" + n, lastName: "Last" + n,
  grade: String(grade), wildcatCashBalance: 0, ...extra });

/** Twenty students; s7 and s15 never awarded; s3 with five deductions on her own record (Flagged). */
function people() {
  return Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    if (n === 3) {
      return kid(n, 7, { wildcatCashBalance: 200, wildcatCashTransactions: Array.from({ length: 5 }, (_, k) =>
        ({ id: "fx" + k, kind: "deduct", amount: -100, teacherId: "T1", behaviorId: "wc6" })) });
    }
    return kid(n, n <= 10 ? 7 : 10);
  });
}
function ledgerRows() {
  const rows = [];
  // Every student but s7 and s15 gets an expectation award, spread over 9/15-10/5.
  people().forEach((s, i) => {
    if (s.id === "s7" || s.id === "s15") return;
    rows.push(row({ s: s.id, at: T(9, 15 + (i % 20), 10, i), note: "own " + i, t: i % 2 ? "T1" : "T2" }));
  });
  // A whole-class press and five individual deductions, last week and this week.
  rows.push(...press({ at: T(9, 29, 9), note: "class" }, ["s1", "s2", "s4", "s5", "s6"]));
  [0, 1, 2, 3, 4].forEach((i) => rows.push(row({ s: "s" + (i + 1), kind: "deduct", at: T(9, 30, 9, i), note: "d" + i, t: ["T1", "T2", "T3", "T1", "T2"][i] })));
  rows.push(...press({ at: T(10, 5, 9), note: "class2" }, ["s1", "s2", "s4", "s5", "s6", "s8"]));
  rows.push(row({ s: "s9", at: T(10, 5, 11), note: "solo" }));
  [0, 1, 2, 3, 4, 5].forEach((i) => rows.push(row({ s: "s" + (11 + i), kind: "deduct", at: T(10, 6, 8, i), note: "dd" + i, t: i % 2 ? "T1" : "T3" })));
  // Bookkeeping this week: a purchase and a reversed award, neither a behaviour.
  rows.push(row({ s: "s2", kind: "redeem", amount: -1500, at: T(10, 5, 12), b: "reward:pup", t: "" }));
  const wrong = row({ s: "s3", at: T(10, 5, 13), note: "oops" });
  rows.push(wrong, { ...row({ s: "s3", kind: "reversal", at: T(10, 5, 13, 5), note: "" }), reversesTxnId: wrong.id, behaviorId: "" });
  return rows;
}
const SCHOOL_DAYS = (() => {
  const out = [];
  for (let d = new Date(2026, 8, 2, 12); d <= new Date(2026, 9, 5, 12); d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (dow >= 1 && dow <= 5 && iso !== "2026-09-07") out.push(iso);
  }
  return out;
})();
const CTX = { allowed: true, schoolDates: SCHOOL_DAYS, weeks: [], attendance: false, rosterStaff: { count: 3, ids: [["T1", "k1"], ["T2", "k2"], ["T3", "k3"]] } };

function store(throwing) {
  if (throwing) return { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
function world(src, o = {}) {
  const dom = makeDom(o);
  const G = {
    currentUser: o.currentUser === undefined ? PBIS : o.currentUser, teachers: STAFF, students: o.students || people(),
    cashTransactions: o.rows || ledgerRows(), cutoffMs: CUTOFF, document: dom, Date: dateAt(o.now || NOW),
    localStorage: o.localStorage || store(), queries: [],
  };
  G.session = o.sessionStorage || store();
  G.window = Object.assign({}, MODS, {
    sessionStorage: G.session,
    WildcatAuth: {
      getSession: () => ({ idToken: "tok" }),
      convexQuery: async (name) => {
        G.queries.push(name);
        if (name === "cashInsights:trendsContext") return CTX;
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
async function open(w, view) {
  w.app.switchAnalyticsSubtab(view);
  await settle(); await settle();
  return w;
}
/** The rows of a table in a drawn string, in order, by its data-sort-id. */
function tableRows(markup, id) {
  const at = markup.indexOf('data-sort-id="' + id + '"');
  if (at < 0) return [];
  const body = markup.slice(markup.indexOf("<tbody>", at) + 7, markup.indexOf("</tbody>", at));
  return body.split(/(?=<tr\b)/).filter((r) => /^<tr\b/.test(r));
}
const firstCellText = (r) => (/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/.exec(r) || [, ""])[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const cellText = (r, k) => [...r.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim())[k];

// ==================================================================== 1
console.log("\n1. Five tabs, one question each, in the house pill style");
{
  const barAt = html.lastIndexOf("<div", html.indexOf('id="cashAnalyticsViews"'));
  const bar = html.slice(barAt, html.indexOf("</div>", barAt));
  const buttons = [...bar.matchAll(/<button[^>]*id="([^"]+)"[^>]*data-cview="([^"]+)"[^>]*>[\s\S]*?<\/svg>\s*([^<]+)<\/button>/g)]
    .map((m) => ({ id: m[1], view: m[2], label: m[3].trim() }));
  check("the bar reads Overview | Trends | Students | Expectations | Staff, in that order",
    buttons.map((b) => b.label).join(" | ") === "Overview | Trends | Students | Expectations | Staff", buttons.map((b) => b.label).join(" | "));
  check("...on the old keys: Overview is 'dashboard' and Staff is 'teacherInteractions'",
    buttons.map((b) => b.view).join() === "dashboard,trends,students,expectations,teacherInteractions" &&
    buttons[0].id === "dashboardSubtab" && buttons[4].id === "teacherInteractionsSubtab");
  check("every button is a type=button pill with aria-pressed; the bar is a labelled group",
    /class="subtab-bar wc-cash-views" id="cashAnalyticsViews" role="group" aria-label=/.test(html) &&
    (bar.match(/class="analytics-tab[^"]*"/g) || []).length === 5 && (bar.match(/aria-pressed="(true|false)"/g) || []).length === 5 &&
    (bar.match(/<button type="button"/g) || []).length === 5);
  check("Staff starts hidden in the markup, so it never flashes for a teacher", /id="teacherInteractionsSubtab" style="display: none;"/.test(html));
  check("the bar is NOT an .analytics-tabs container and no button carries data-atab (Discipline's switcher scope)",
    !/class="[^"]*\banalytics-tabs\b[^"]*" id="cashAnalyticsViews"/.test(html) && !/data-atab/.test(bar));
  check("the empty Transactions tab and pane are gone", !/transactionsSubtab|analyticsTransactions|Transaction history will be displayed/.test(html));
  const pane = (id) => html.slice(html.indexOf('id="' + id + '"'));
  check("the panes: Overview, Staff, Trends+Students (one pane), Expectations",
    ["analyticsDashboard", "analyticsTeacherInteractions", "analyticsTrends", "analyticsExpectations"].every((id) => html.includes('id="' + id + '"')));
  check("Expectation balance lives inside the Expectations pane, not under every tab",
    /id="analyticsExpectations"[\s\S]*?<div id="cashAnalyticsDetails"><\/div>\s*<\/div>\s*<\/div>/.test(html));
  check("Flagged is a Students section inside the Trends/Students pane, hidden until the gate shows it, with a Loading placeholder",
    /id="analyticsTrends"[^>]*data-cview="trends"/.test(html) &&
    /id="interventionCard" data-csec="students" style="display: none;"/.test(pane("analyticsTrends").slice(0, 6000)) &&
    /id="interventionStudentsTableBody">\s*<tr>\s*<td colspan="7"[^>]*>Loading&hellip;/.test(html) && !/No students flagged<\/td>/.test(html));
  check("styles.css hides the other tab's sections by data-cview",
    /#analyticsTrends\[data-cview="trends"\] \[data-csec="students"\],\s*#analyticsTrends\[data-cview="students"\] \[data-csec="trends"\] \{ display: none; \}/.test(css));
  check("the bar wraps on a phone", /\.wc-cash-views \{ flex-wrap: wrap;/.test(css));
  check("'What do these words mean?' sits under the bar, on every tab", /id="cashAnalyticsViews"[\s\S]{0,3000}?What do these words mean\?<\/button><\/p>\s*(<!--[\s\S]*?-->\s*)?<div id="cashMovedNote" hidden><\/div>/.test(html));
  check("the Trends icon trends up", /data-cview="trends"[^>]*>[\s\S]{0,140}wci-trending-up/.test(bar));
  check("the page subtitle says what the section is for", /How praise and corrections are going, for students, staff and each expectation\./.test(html));
  check("the home gauge's arrow opens Analytics on Overview, through openCashAnalytics",
    /id="dashGaugeAnalyticsBtn"[\s\S]{0,200}onclick="openCashAnalytics\('dashboard'\)"/.test(html) && /<p class="wu-panel-sub">Counted per student<\/p>/.test(html));
}
{
  // DISCIPLINE'S SWITCHER, RUN: it clears .active on every '.analytics-tabs
  // .analytics-tab' on the page. Walk index.html's tags to find what that
  // selector reaches, and check no Cash button is among them.
  const reached = (page) => {
    const stack = [], out = [];
    for (const m of page.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
      const [, close, tag, attrs] = m;
      if (/^(br|img|input|use|meta|link|hr|source|path|circle|rect|line|polyline|polygon)$/i.test(tag) || /\/$/.test(attrs)) continue;
      if (close) { const i = stack.map((s) => s.tag).lastIndexOf(tag); if (i >= 0) stack.length = i; continue; }
      const cls = (/\bclass="([^"]*)"/.exec(attrs) || [, ""])[1].split(/\s+/);
      const id = (/\bid="([^"]*)"/.exec(attrs) || [, ""])[1];
      if (cls.includes("analytics-tab") && stack.some((s) => s.cls.includes("analytics-tabs"))) out.push(id);
      stack.push({ tag, cls });
    }
    return out;
  };
  const cashIds = ["dashboardSubtab", "trendsSubtab", "studentsSubtab", "expectationsSubtab", "teacherInteractionsSubtab"];
  const hits = reached(html).filter((id) => cashIds.includes(id));
  check("Discipline's '.analytics-tabs .analytics-tab' reaches no Cash Analytics button", hits.length === 0, hits.join());
  check("...and the selector it uses is still that one", /querySelectorAll\('\.analytics-tabs \.analytics-tab'\)/.test(liftFn(code, "switchAnalyticsTab")));
  const clash = html.replace('class="subtab-bar wc-cash-views" id="cashAnalyticsViews"', 'class="subtab-bar analytics-tabs wc-cash-views" id="cashAnalyticsViews"');
  check("TEETH: put .analytics-tabs on the bar and Discipline's switcher would clear the Cash highlight",
    reached(clash).filter((id) => cashIds.includes(id)).length === 5);
}

// ==================================================================== 2
console.log("\n2. Switching: one pressed button, one pane, the old names as aliases");
{
  const w = world(scriptSrc);
  const pressed = () => ["dashboardSubtab", "trendsSubtab", "studentsSubtab", "expectationsSubtab", "teacherInteractionsSubtab"]
    .filter((id) => el(w, id).getAttribute("aria-pressed") === "true");
  const shown = () => ["analyticsDashboard", "analyticsTrends", "analyticsExpectations", "analyticsTeacherInteractions"]
    .filter((id) => el(w, id).style.display === "block");
  const cases = [["dashboard", "dashboardSubtab", "analyticsDashboard"], ["trends", "trendsSubtab", "analyticsTrends"],
    ["students", "studentsSubtab", "analyticsTrends"], ["expectations", "expectationsSubtab", "analyticsExpectations"],
    ["teacherInteractions", "teacherInteractionsSubtab", "analyticsTeacherInteractions"]];
  for (const [view, btn, pane] of cases) {
    await open(w, view);
    check(`${view}: only its button is pressed (aria-pressed and .active) and only its pane shows`,
      pressed().join() === btn && el(w, btn).classList.contains("active") && shown().join() === pane, pressed().join() + " / " + shown().join());
  }
  await open(w, "trends");
  check("Trends sets data-cview=trends on the shared pane", el(w, "analyticsTrends").getAttribute("data-cview") === "trends");
  await open(w, "students");
  check("Students sets data-cview=students on it", el(w, "analyticsTrends").getAttribute("data-cview") === "students");
  for (const [alias, to] of [["transactions", "dashboardSubtab"], ["overview", "dashboardSubtab"], ["staff", "teacherInteractionsSubtab"],
                             ["nonsense", "dashboardSubtab"], [undefined, "dashboardSubtab"]]) {
    await open(w, alias);
    check(`'${alias}' lands on ${to}`, pressed().join() === to);
  }
  check("the cashViewKey map: aliases resolve and nothing unknown escapes",
    w.app.cashViewKey("staff") === "teacherInteractions" && w.app.cashViewKey("__proto__") === "dashboard" &&
    w.app.cashViewKey("constructor") === "dashboard");
  check("ONE Trends/Students branch: the server reads are asked for in exactly one place",
    (scriptSrc.match(/Promise\.all\(\[loadCashTrendsContext\(\)/g) || []).length === 1 &&
    /else if \(subtab === 'trends' \|\| subtab === 'students'\) \{/.test(liftFn(code, "switchAnalyticsSubtab")));
  const w2 = world(scriptSrc);
  await open(w2, "students");
  await open(w2, "trends");
  check("Students then Trends reads trendsContext once (one cache, one branch)",
    w2.G.queries.filter((q) => q === "cashInsights:trendsContext").length === 1, w2.G.queries.join());
}

// ==================================================================== 3
console.log("\n3. Who sees what, tab by tab (admin, superadmin and PBIS by ROLE)");
for (const who of [PARK, AIDE]) {
  const w = world(scriptSrc, { currentUser: who });
  await open(w, "dashboard");
  check(`${who.role}: Staff button and Staff guide line hidden`, el(w, "teacherInteractionsSubtab").style.display === "none" &&
    el(w, "cashGuideStaff").style.display === "none");
  await open(w, "staff");
  check(`${who.role}: asking for Staff by any name lands on Overview`, el(w, "analyticsDashboard").style.display === "block" &&
    el(w, "analyticsTeacherInteractions").style.display === "none");
  await open(w, "students");
  const body = el(w, "cashTrendsBody").innerHTML;
  check(`${who.role}: Students has no names and no flagged card`, !/Stu\d|Last\d|Ms\. Lee|Mr\. Park/.test(w.dom.text()) &&
    el(w, "interventionCard").style.display === "none" && !/cashNeverNoticedList/.test(body));
  check(`${who.role}: ...but says where their own students are, with the way there`,
    /Your own students who haven&rsquo;t been noticed lately are on your Dashboard\./.test(body) && /onclick="switchTab\('dashboard'\)">Open my Dashboard</.test(body));
  check(`${who.role}: the campus reach still shows, retitled Reach`, /Reach: expectation awards, last 10 school days/.test(body) && /Middle School/.test(body));
  await open(w, "expectations");
  const bal = el(w, "cashAnalyticsDetails").innerHTML;
  check(`${who.role}: Expectations is nameless, with no adult share and no Staff link`, /Expectation balance/.test(bal) &&
    !/top adult|from \d+ adult|Staff tab/.test(bal) && /the PBIS team follows these up/.test(bal));
  check(`${who.role}: the names query was never made`, !w.G.queries.includes("attendanceList:attendanceMarks"));
}
for (const who of [PBIS, ADMIN, SUPER]) {
  const w = world(scriptSrc, { currentUser: who });
  await open(w, "students");
  const body = el(w, "cashTrendsBody").innerHTML;
  check(`${who.role}: Staff shows; Students has the named list and the flagged card; no Dashboard pointer`,
    el(w, "teacherInteractionsSubtab").style.display === "" && el(w, "interventionCard").style.display === "" &&
    /cashNeverNoticedList/.test(body) && /Stu7 Last7/.test(body) && !/Open my Dashboard/.test(body));
  await open(w, "expectations");
  check(`${who.role}: Expectations shows how many adults are behind a cell, and the help line for those who follow it up`,
    /from 3 adults; top adult 40%/.test(el(w, "cashAnalyticsDetails").innerHTML) &&
    /talk with those adults; it is not a school-wide reteach/.test(el(w, "cashAnalyticsDetails").innerHTML));
}
{
  // THE SHARED CHROMEBOOK: PBIS on Students, then a teacher, no reload.
  const w = world(scriptSrc, { currentUser: PBIS });
  await open(w, "students");
  check("before: PBIS has flagged rows and names on Students", /Stu3 Last3/.test(el(w, "interventionStudentsTableBody").innerHTML) && /Stu7/.test(w.dom.text()));
  w.app.set("currentUser", PARK);
  w.app.applyCashAnalyticsGate();
  check("after a teacher signs in: no student or staff name anywhere, the flagged card hidden",
    !/Stu\d|Ms\. Lee|Mr\. Park/.test(w.dom.text()) && el(w, "interventionCard").style.display === "none", (w.dom.text().match(/Stu\d+ Last\d+|Ms\. Lee|Mr\. Park/) || [])[0]);
  // EACH LAYER ON ITS OWN: the gate hides the card and the wipe hides it too.
  const gateLine = "            if (flagged) flagged.style.display = allowed ? '' : 'none';\n";
  const wipeLine = "            if (flagged) flagged.style.display = 'none';\n";
  const hiddenWith = (src) => { const x = world(src, { currentUser: PARK }); x.app.applyCashAnalyticsGate(); return el(x, "interventionCard").style.display === "none"; };
  check("the gate alone hides the flagged card, and so does the wipe alone",
    hiddenWith(breakOnce(scriptSrc, gateLine, "", "gate-card")) && hiddenWith(breakOnce(scriptSrc, wipeLine, "", "wipe-card")));
  check("TEETH: take both away and a teacher's Students shows the flagged card",
    !hiddenWith(breakOnce(breakOnce(scriptSrc, gateLine, "", "gate-card"), wipeLine, "", "wipe-card")));
}

// ==================================================================== 4
console.log("\n4. Flagged is FILLED when Students opens, not only from Staff");
{
  const w = world(scriptSrc, { currentUser: PBIS });
  await open(w, "students");
  check("PBIS opening Students first: the flagged child is listed, with the count on the fold",
    /Stu3 Last3/.test(el(w, "interventionStudentsTableBody").innerHTML) && el(w, "interventionFlaggedCount").textContent === "1 student: show list",
    el(w, "interventionFlaggedCount").textContent);
  check("...with her primary teacher (names: admins and PBIS only)", /Ms\. Lee/.test(el(w, "interventionStudentsTableBody").innerHTML));
  const noFill = breakOnce(scriptSrc, "                if (subtab === 'students' && cashStaffViewsAllowed()) updateInterventionStudents();\n", "", "fill");
  const n = world(noFill, { currentUser: PBIS });
  await open(n, "students");
  check("TEETH: without the call, Students opens on an empty flagged table (a false all-clear)",
    !/Stu3/.test(el(n, "interventionStudentsTableBody").innerHTML) && el(n, "interventionFlaggedCount").textContent === "");
  const t = world(scriptSrc, { currentUser: PARK });
  await open(t, "students");
  check("a teacher opening Students never fills it", !/Stu3/.test(el(t, "interventionStudentsTableBody").innerHTML));
  const none = world(scriptSrc, { currentUser: PBIS, students: people().map((s) => ({ ...s, wildcatCashTransactions: [] })) });
  await open(none, "students");
  check("with nobody flagged the fold says so", el(none, "interventionFlaggedCount").textContent === "No students flagged");
}

// ==================================================================== 5
console.log("\n5. The tab is remembered for this browser tab, and wired through switchTab");
{
  const w = world(scriptSrc);
  await open(w, "students");
  check("opening Students stores it (sessionStorage, wcCashAnalyticsView)", w.G.session.getItem("wcCashAnalyticsView") === "students");
  check("...and the next open of Analytics asks for it", w.app.cashRememberedView() === "students");
  const sw = liftFn(code, "switchTab");
  check("switchTab('cashAnalytics') opens the remembered tab, and no longer draws the balance on every open",
    /tabName === 'cashAnalytics'\) \{\s*switchAnalyticsSubtab\(cashRememberedView\(\)\);\s*\}/.test(sw) &&
    !/updateCashAnalytics\(\)/.test(sw) && !/switchAnalyticsSubtab\('dashboard'\)/.test(sw));
  w.app.openCashAnalytics("trends");
  check("openCashAnalytics stores the tab BEFORE switchTab, so switchTab opens that one",
    w.G.switched[w.G.switched.length - 1] === "cashAnalytics@trends", w.G.switched.join());
  const t = world(scriptSrc, { currentUser: PARK });
  t.G.session.setItem("wcCashAnalyticsView", "teacherInteractions");
  await open(t, t.app.cashRememberedView());
  check("a teacher's remembered Staff lands on Overview, and Overview is what is remembered",
    el(t, "analyticsDashboard").style.display === "block" && t.G.session.getItem("wcCashAnalyticsView") === "dashboard");
  const g = world(scriptSrc);
  g.G.session.setItem("wcCashAnalyticsView", "<img onerror=x>");
  check("a stored value that is not a tab opens Overview", g.app.cashRememberedView() === "dashboard");
  const b = world(scriptSrc, { sessionStorage: store(true) });
  let threw = false;
  try { await open(b, "trends"); b.app.cashRememberedView(); } catch (e) { threw = true; }
  check("with storage throwing nothing breaks, and Analytics opens on Overview", !threw && b.app.cashRememberedView() === "dashboard");
  check("logout clears it: wcForgetTab removes the key (view-restore.test.mjs runs it)",
    /removeItem\(WC_CASH_VIEW_KEY\)/.test(liftFn(code, "wcForgetTab")) && /var WC_CASH_VIEW_KEY = 'wcCashAnalyticsView';/.test(scriptSrc));
}

// ==================================================================== 6
console.log("\n6. Folds stay open across a redraw");
{
  const w = world(scriptSrc, { currentUser: PBIS });
  await open(w, "students");
  const isOpen = (id) => new RegExp('data-fold="' + id + '" open>').test(el(w, "cashTrendsBody").innerHTML);
  check("the named list is folded closed, its count in the summary",
    !isOpen("never-noticed") && /data-fold="never-noticed"><summary><b>2<\/b> students: show list<\/summary>/.test(el(w, "cashTrendsBody").innerHTML));
  // What the page's capture-phase 'toggle' listener does when the PBIS lead opens it.
  w.app.cashFoldToggled({ target: { open: true, getAttribute: (k) => (k === "data-fold" ? "never-noticed" : null) } });
  // A later date that still leaves a working list (2 of 20: a tenth), so the fold is drawn.
  w.app.setCashNoticeSince("2026-09-15");
  check("open the list, change 'No award since': it is still open", isOpen("never-noticed"));
  w.app.setCashCountUnit("students");
  check("...and after the unit switch redraws everything", isOpen("never-noticed"));
  await open(w, "trends");
  check("...and after the server's answers land and Trends redraws", isOpen("never-noticed"));
  w.app.cashFoldToggled({ target: { open: false, getAttribute: () => "never-noticed" } });
  w.app.setCashNoticeSince("2026-09-14");
  check("closed again, it stays closed", !isOpen("never-noticed"));
  w.app.cashFoldToggled({ target: { open: true, getAttribute: () => null } });
  w.app.cashFoldToggled({ target: null });
  w.app.renderCashTrends();
  check("a toggle on anything without data-fold is ignored", !isOpen("never-noticed") && !/ open>/.test(el(w, "cashTrendsBody").innerHTML));
  const shut = breakOnce(scriptSrc, "(_cashOpenFolds.has(cashFoldKey(id)) ? ' open' : '')", "''", "fold-open");
  const s = world(shut, { currentUser: PBIS });
  await open(s, "students");
  s.app.cashFoldToggled({ target: { open: true, getAttribute: () => "never-noticed" } });
  s.app.setCashNoticeSince("2026-09-15");
  check("TEETH: draw folds without the remembered set and the list snaps shut on the redraw",
    !/data-fold="never-noticed" open>/.test(el(s, "cashTrendsBody").innerHTML));
  const e = world(scriptSrc, { currentUser: PBIS });
  e.app.setCashFoldOpen("balance-how", true);
  await open(e, "expectations");
  await open(e, "expectations");
  check("Expectations redraws on every open, and its 'How this is counted' stays open", /data-fold="balance-how" open>/.test(el(e, "cashAnalyticsDetails").innerHTML));
  // THE SHARED CHROMEBOOK: the next admin starts with every fold closed.
  const swap = world(scriptSrc, { currentUser: PBIS });
  await open(swap, "students");
  swap.app.cashFoldToggled({ target: { open: true, getAttribute: () => "never-noticed" } });
  swap.app.renderCashTrends();
  const openForPbis = /data-fold="never-noticed" open>/.test(el(swap, "cashTrendsBody").innerHTML);
  swap.app.set("currentUser", ADMIN);
  await open(swap, "students");
  check("open folds are per person: the next admin on the same page starts with the named list closed",
    openForPbis && /data-fold="never-noticed">/.test(el(swap, "cashTrendsBody").innerHTML) && !/data-fold="never-noticed" open>/.test(el(swap, "cashTrendsBody").innerHTML));
  const shared = breakOnce(scriptSrc, "            return String((currentUser && currentUser.id) || '') + '\\u0001' + String(id);",
    "            return String(id);", "fold-per-person");
  const sh = world(shared, { currentUser: PBIS });
  await open(sh, "students");
  sh.app.cashFoldToggled({ target: { open: true, getAttribute: () => "never-noticed" } });
  sh.app.set("currentUser", ADMIN);
  await open(sh, "students");
  check("TEETH: key the folds by name alone and the next admin opens on the last one's open list",
    /data-fold="never-noticed" open>/.test(el(sh, "cashTrendsBody").innerHTML));
  check("the listener is on the document, in the CAPTURE phase (a <details> toggle does not bubble)",
    /document\.addEventListener\('toggle', cashFoldToggled, true\);/.test(code));
  check("the folds hold definitions only: the 10-week banner and the recording question stay outside them",
    /question \+\s*'<div class="wu-scroll-x">/.test(liftFn(code, "cashOutcomeHtml")) &&
    liftFn(code, "cashOutcomeHtml").indexOf("weeks so far.</b>") < liftFn(code, "cashOutcomeHtml").indexOf("cashFoldHtml('outcome-how'"));
  // Since the review of 2026-10-06 one function names them: cashViewerChanged
  // shuts them for a different person (section 15). Nothing redraws them.
  check("the static folds (Flagged, the latest 100) are never redrawn: their renderers write rows and a count only",
    (code.match(/interventionFold|teacherInteractionDetailsFold/g) || []).length === 2 &&
    /interventionFold|teacherInteractionDetailsFold/.test(liftFn(code, "cashViewerChanged")) &&
    !/interventionFold|teacherInteractionDetailsFold/.test(liftFn(code, "updateInterventionStudents") + liftFn(code, "updateTeacherInteractionDetails")));
}

// ==================================================================== 7
console.log("\n7. Expectations is drawn when its tab opens, never on a teacher's gate run");
{
  const w = world(countBalance(scriptSrc), { currentUser: PARK });
  w.app.applyCashAnalyticsGate();
  await open(w, "dashboard");
  await open(w, "trends");
  await open(w, "students");
  check("a teacher's sign-in gate and every other tab: the balance is never built", !w.G.window.__balanceBuilds, String(w.G.window.__balanceBuilds));
  await open(w, "expectations");
  check("opening Expectations builds it once", w.G.window.__balanceBuilds === 1, String(w.G.window.__balanceBuilds));
  const gateDraws = breakOnce(countBalance(scriptSrc), "            if (!allowed) wipeStaffCashViews();\n            return allowed;",
    "            if (!allowed) { wipeStaffCashViews(); updateCashAnalytics(); }\n            return allowed;", "gate-draws");
  const g = world(gateDraws, { currentUser: PARK });
  g.app.applyCashAnalyticsGate();
  check("TEETH: a gate that draws the balance is caught", g.G.window.__balanceBuilds > 0);
}

// ==================================================================== 8
console.log("\n8. This week so far: the Home gauge's count beside Trends', whole school");
/** The Home gauge's own statements, lifted out of renderTeacherDashboard and run. */
function gaugeRun(src, w, seesAll, user) {
  const s = strip(src);
  const a = s.indexOf("const weekStart = cashGaugeWeekStartMs(Date.now());");
  const A = s.slice(a, s.indexOf("const cashAwarded", a));
  const c = s.indexOf("const gaugeTally = cashRowKindCounts(cashThisWeek");
  const C = s.slice(c, s.indexOf("const RATIO_TARGET = CASH_RATIO_GOAL;", c));
  return new Function("cashTransactions", "seesAll", "currentUser", "Date", "cashGaugeWeekStartMs", "cashGaugeWeekRows", "cashRowKindCounts",
    "reversedCashIds", A + C + "return gaugeCounts;")(w.G.cashTransactions, seesAll, user, dateAt(NOW), w.app.cashGaugeWeekStartMs,
    w.app.cashGaugeWeekRows, w.app.cashRowKindCounts, w.app.reversedCashIds);
}
function stripModel(w) {
  return w.app.cashWeekStripModel({ rows: w.G.cashTransactions, reversedIds: w.app.reversedCashIds(), nowMs: NOW, todayIso: "2026-10-06",
    praise: w.app.cashPraiseWeeks({ model: w.app.cashClicksNow(), cutoffIso: "2026-09-14", todayIso: "2026-10-06" }) });
}
{
  // A double-tapped row (the same child twice in one press) and a row stamped
  // in the future: the gauge counts both (it counts rows from Monday on);
  // Trends counts neither -- which is exactly why the strip must take its
  // per-student half from the gauge's function and not from Trends.
  const rows = ledgerRows().concat([row({ s: "s9", at: T(10, 5, 11, 0, 1), note: "solo" }), row({ s: "s10", at: T(10, 8, 9), note: "future" })]);
  const w = world(scriptSrc, { rows });
  const m = stripModel(w);
  const gauge = gaugeRun(scriptSrc, w, true, PBIS);
  check("admins and PBIS: 'per student' this week IS the Home gauge's count (same function, same Monday)",
    m.thisWeek.perStudent.awards === gauge.awards && m.thisWeek.perStudent.deductions === gauge.deductions && gauge.unit === "per student",
    JSON.stringify({ strip: m.thisWeek.perStudent, gauge }));
  const praise = w.app.cashPraiseWeeks({ model: w.app.cashClicksNow(), cutoffIso: "2026-09-14", todayIso: "2026-10-06" }).weeks;
  const wk = (mon) => praise.find((x) => x.monday === mon);
  check("'per press of Award' this week is Trends' own top row (its 5 to 1 column)",
    m.thisWeek.perPress.awards === wk("2026-10-05").clicks.allAwards && m.thisWeek.perPress.deductions === wk("2026-10-05").clicks.allDeductions &&
    m.thisWeek.perPress.verdict.label === wk("2026-10-05").verdict.clicks.label, JSON.stringify(m.thisWeek.perPress));
  check("last week, both ways, is Trends' row for Sep 28 in both units",
    m.lastWeek.monday === "2026-09-28" && m.lastWeek.perPress.awards === wk("2026-09-28").clicks.allAwards &&
    m.lastWeek.perStudent.awards === wk("2026-09-28").students.allAwards && m.lastWeek.perStudent.deductions === wk("2026-09-28").students.allDeductions,
    JSON.stringify({ strip: m.lastWeek, trends: wk("2026-09-28").students }));
  check("the purchase and the reversed award are in neither count", m.thisWeek.perStudent.awards === 9 && m.thisWeek.perPress.awards === 2,
    JSON.stringify(m.thisWeek));
  const fromTrends = breakOnce(scriptSrc, "                    perStudent: { awards: s.awards, deductions: s.deductions, verdict: cashRatioVerdict(s.awards, s.deductions) },",
    "                    perStudent: p ? { awards: p.students.allAwards, deductions: p.students.allDeductions, verdict: p.verdict.students } : null,", "strip-source");
  const wt = world(fromTrends, { rows });
  check("TEETH: take 'per student' from Trends instead and it stops matching the gauge (a fourth 5 to 1 figure)",
    stripModel(wt).thisWeek.perStudent.awards !== gaugeRun(fromTrends, wt, true, PBIS).awards);
  check("the gauge and the strip call the same two functions",
    /const weekStart = cashGaugeWeekStartMs\(Date\.now\(\)\);\s*const cashThisWeek = cashGaugeWeekRows\(cashTransactions, weekStart, null,/.test(code) &&
    /const s = cashRowKindCounts\(cashGaugeWeekRows\(rows, from, to, null\), reversedIds\);/.test(code));
  const teacherGauge = gaugeRun(scriptSrc, w, false, by("T1"));
  check("a teacher's gauge is their own week, and the strip is the school's: different numbers, said as such",
    JSON.stringify([teacherGauge.awards, teacherGauge.deductions]) !== JSON.stringify([m.thisWeek.perStudent.awards, m.thisWeek.perStudent.deductions]),
    JSON.stringify({ teacherGauge, school: m.thisWeek.perStudent }));
  const staffHtml = w.app.cashWeekStripHtml(m, true), teacherHtml = w.app.cashWeekStripHtml(m, false);
  check("the strip tells admins and PBIS it is their gauge's count",
    /Per student is the same count as your Dashboard gauge\./.test(staffHtml) && /same as the 5 to 1 column on Trends/.test(staffHtml));
  check("...and tells a teacher it is the whole school, never that it matches their gauge",
    /This is the whole school\. Your own week is on your Dashboard gauge\./.test(teacherHtml) && !/same count as your Dashboard gauge/.test(teacherHtml));
  check("on a Tuesday it says 'so far'; on a Saturday the week is just 'This week'",
    /This week so far &middot; Oct 5–9/.test(staffHtml) &&
    /<h4>This week &middot; Oct 5–9<\/h4>/.test(w.app.cashWeekStripHtml(w.app.cashWeekStripModel({ rows, reversedIds: new Set(), nowMs: T(10, 10, 10), todayIso: "2026-10-10", praise: { weeks: [] } }), true)));
  check("the strip is nameless and dollar-free", !/Stu\d|Ms\. Lee|\$/.test(staffHtml + teacherHtml));
  const o = world(scriptSrc, { rows });
  await open(o, "dashboard");
  check("Overview's open draws it, with the time-window chips filled from the cutoff",
    /per press of Award/.test(el(o, "cashWeekStrip").innerHTML) && el(o, "dashTilesSince").textContent === "All time since Sep 14" &&
    el(o, "staffTableSince").textContent === "All time since Sep 14");
  check("...from its own function: updateDashboard (also called from Home) never draws it", !/renderCashWeekStrip/.test(liftFn(code, "updateDashboard")));
}

// ==================================================================== 9
console.log("\n9. 'What moved where': once per person, the words by role");
{
  const t = world(scriptSrc, { currentUser: PARK });
  await open(t, "dashboard");
  const tn = el(t, "cashMovedNote");
  check("a teacher reads their own version: no 'Teacher Interactions is now Staff', and their movements are in My Activity",
    tn.hidden === false && /Data Dashboard is now <b>Overview<\/b>/.test(tn.innerHTML) && !/Teacher Interactions/.test(tn.innerHTML) &&
    /My Activity and the Cash Audit Log/.test(tn.innerHTML) && !/every movement is in/.test(tn.innerHTML));
  const p = world(scriptSrc, { currentUser: PBIS });
  await open(p, "dashboard");
  check("admins and PBIS read that Teacher Interactions is now Staff and Flagged is on Students",
    /Teacher Interactions is now <b>Staff<\/b>/.test(el(p, "cashMovedNote").innerHTML) && /flagged students are on <b>Students<\/b>/.test(el(p, "cashMovedNote").innerHTML));
  p.app.dismissCashMovedNote();
  check("the x closes it and remembers it for that person", el(p, "cashMovedNote").hidden === true && p.G.localStorage.getItem("wcCashNavNote:P1") === "1");
  await open(p, "trends");
  check("...it stays closed on the next open", el(p, "cashMovedNote").hidden === true);
  p.app.set("currentUser", ADMIN);
  await open(p, "trends");
  check("the next person on the same Chromebook still gets it (keyed per person, not per browser)", el(p, "cashMovedNote").hidden === false);
  const perBrowser = breakOnce(scriptSrc, "            return 'wcCashNavNote:' + String((user && user.id) || '');", "            return 'wcCashNavNote';", "per-person");
  const pb = world(perBrowser, { currentUser: PBIS });
  await open(pb, "dashboard");
  pb.app.dismissCashMovedNote();
  pb.app.set("currentUser", ADMIN);
  await open(pb, "dashboard");
  check("TEETH: key it per browser and the second person never sees it", el(pb, "cashMovedNote").hidden === true);
  const b = world(scriptSrc, { currentUser: PBIS, localStorage: store(true) });
  await open(b, "dashboard");
  b.app.dismissCashMovedNote();
  await open(b, "trends");
  check("with storage blocked, the x still closes it for this page", el(b, "cashMovedNote").hidden === true);
  const g = world(scriptSrc, { currentUser: null });
  g.app.renderCashMovedNote();
  check("signed out, there is no note", el(g, "cashMovedNote").hidden === true && el(g, "cashMovedNote").innerHTML === "");
  check("its host is a bare div with the hidden attribute (no class a display rule could beat)", /<div id="cashMovedNote" hidden><\/div>/.test(html));
}

// ==================================================================== 10
console.log("\n10. The word list: one dialog, opened from every tab, and true to the code");
{
  const w = world(scriptSrc);
  const opener = makeEl("x");
  el(w, "cashGlossaryModal").classList.add("hidden");
  w.app.openCashGlossary(opener);
  check("it opens and puts focus on its close button", !el(w, "cashGlossaryModal").classList.contains("hidden") && el(w, "cashGlossaryClose").focused === 1);
  w.app.closeCashGlossary();
  check("it closes and hands focus back to whatever opened it", el(w, "cashGlossaryModal").classList.contains("hidden") && opener.focused === 1);
  check("a click outside closes it", /id="cashGlossaryModal"[^>]*onclick="if \(event\.target === this\) closeCashGlossary\(\)"/.test(html));
  // ESCAPE WHEREVER FOCUS IS (review, 2026-10-06). It listened on the dialog
  // itself, so after a click on a definition (focus to the page) Escape did
  // nothing. Now on the document, like the app's other dialogs.
  const heard = (src) => /document\.addEventListener\('keydown', cashGlossaryKeydown\);/.test(strip(src));
  check("Escape is heard on the document, not only by the dialog", heard(scriptSrc) && !/id="cashGlossaryModal"[^>]*onkeydown=/.test(html));
  check("TEETH: without the document listener it is caught", !heard(scriptSrc.replace("document.addEventListener('keydown', cashGlossaryKeydown);", "")));
  const opener2 = makeEl("y");
  w.app.openCashGlossary(opener2);
  w.app.cashGlossaryKeydown({ key: "Enter" });
  check("another key leaves it open", !el(w, "cashGlossaryModal").classList.contains("hidden"));
  w.app.cashGlossaryKeydown({ key: "Escape" });
  check("Escape, with focus anywhere, closes it and hands focus back", el(w, "cashGlossaryModal").classList.contains("hidden") && opener2.focused === 1);
  w.app.cashGlossaryKeydown({ key: "Escape" });
  check("...and Escape with the list already shut does nothing", opener2.focused === 1);
  const g = html.slice(html.indexOf('id="cashGlossaryModal"'), html.indexOf("</dl>", html.indexOf('id="cashGlossaryModal"')));
  const k = (name) => Number((new RegExp("const " + name + " = ([0-9.]+);").exec(scriptSrc) || [])[1]);
  check("its figures are the code's: 5 seconds, 5 or more students, 3 adults, 40%, 10 school days, 5 deductions",
    g.includes("within " + k("CASH_CLICK_GAP_MS") / 1000 + " seconds") && g.includes("reached " + k("CASH_CLICK_WHOLE") + " or more students") &&
    g.includes("at least " + k("CASH_MANY_ADULTS_MIN") + " adults") && g.includes("more than " + Math.round(k("CASH_MANY_ADULTS_TOP_SHARE") * 100) + "%") &&
    g.includes("last " + k("CASH_REACH_SCHOOL_DAYS") + " school days") && g.includes("until there are " + k("CASH_RATIO_MIN_DEDUCTIONS") + " deductions"));
  check("it sits with the other body-level modals, not inside a tab that may be animated", html.indexOf('id="cashGlossaryModal"') > html.indexOf('id="passDetailModal"'));
}

// ==================================================================== 11
console.log("\n11. Sorting, the pure part: what a cell is sorted as");
{
  const { app } = world(scriptSrc);
  const v = app.wcSortValue;
  check("money: '$1,500' is 1500, '-$50' and '$-50' are -50, '+$100' is 100",
    v("$1,500").num === 1500 && v("-$50").num === -50 && v("$-50").num === -50 && v("+$100").num === 100);
  check("a share reads by its percent: '45% 120 of 268' is 45", v("45% 120 of 268").num === 45);
  check("a ratio reads by its N: '4.8 to 1 below the 5 to 1 goal' is 4.8", v("4.8 to 1 below the 5 to 1 goal").num === 4.8);
  check("a verdict is not a number: 'too few deductions to judge', 'a ratio is shown from 5 deductions'",
    v("too few deductions to judge").num === null && v("a ratio is shown from 5 deductions").num === null);
  check("a dash or nothing is blank", v("—") === null && v("–") === null && v("-") === null && v("  ") === null && v("") === null);
  check("an ISO day or time is a date, not 2026", v("2026-09-14").date === Date.parse("2026-09-14") && v("2026-09-14").num === null &&
    v("2026-10-05T16:30:00.000Z").date === Date.parse("2026-10-05T16:30:00.000Z"));
  check("cell markup is read as its text, entities decoded, tags as spaces",
    app.wcSortCellText('<b>45%</b><span class="wc-trend-of">120 of 268</span>') === "45% 120 of 268" &&
    app.wcSortCellText("&mdash;") === "—" && app.wcSortCellText("Sep 28 &ndash; Oct 2") === "Sep 28 – Oct 2" && app.wcSortCellText("&lt;b&gt;") === "<b>");
  const order = (texts, dir, hint, orig) => app.wcSortOrder(texts, dir, hint, orig).map((i) => texts[i]);
  // Words compare with numeric collation ("Grade 9" before "Grade 10"), so the
  // difference shows on decimals and on money with a thousands comma.
  check("numbers sort as numbers: 4.75 before 4.8, and $200 before $1,500 (as words both would be the other way)",
    order(["4.8 to 1", "4.75 to 1"], "asc").join() === "4.75 to 1,4.8 to 1" && order(["4.8 to 1", "4.75 to 1"], "asc", "text").join() === "4.8 to 1,4.75 to 1" &&
    order(["$1,500", "$200"], "asc").join() === "$200,$1,500" && order(["$1,500", "$200"], "asc", "text").join() === "$1,500,$200");
  check("words with numbers in them read naturally: Grade 9 before Grade 10", order(["Grade 10", "Grade 9"], "asc", "text").join() === "Grade 9,Grade 10");
  check("money and signs: -$50, $0, $25, $1,500", order(["$1,500", "-$50", "$25", "$0"], "asc").join() === "-$50,$0,$25,$1,500");
  check("words sort A to Z, ignoring case", order(["bob", "Alice", "carol"], "asc").join() === "Alice,bob,carol" &&
    order(["bob", "Alice", "carol"], "desc").join() === "carol,bob,Alice");
  check("dates sort as dates", order(["2026-09-21", "2026-09-14", "2026-10-05"], "desc").join() === "2026-10-05,2026-09-21,2026-09-14");
  const ratios = ["3.0 to 1", "too few deductions to judge", "5.5 to 1", "no deductions", "—", "1.2 to 1"];
  check("VERDICTS AT THE BOTTOM, ascending: 1.2, 3.0, 5.5, then the words in drawn order",
    order(ratios, "asc").join("|") === "1.2 to 1|3.0 to 1|5.5 to 1|too few deductions to judge|no deductions|—", order(ratios, "asc").join("|"));
  check("...and descending: 5.5, 3.0, 1.2, then the same words in the same order",
    order(ratios, "desc").join("|") === "5.5 to 1|3.0 to 1|1.2 to 1|too few deductions to judge|no deductions|—", order(ratios, "desc").join("|"));
  check("ties keep the drawn order in BOTH directions", app.wcSortOrder(["5", "3", "5", "3"], "asc").join() === "1,3,0,2" &&
    app.wcSortOrder(["5", "3", "5", "3"], "desc").join() === "0,2,1,3");
  check("...and the drawn order is the row's own tag when given (a re-sort of rows already moved)",
    app.wcSortOrder(["5", "5"], "asc", "", [7, 2]).join() === "1,0");
  const sinks = breakOnce(scriptSrc, "                if (an !== bn) return an ? 1 : -1;\n", "                if (an !== bn) return (an ? -1 : 1) * sign;\n", "verdict-bottom");
  check("TEETH: let the words sort as the smallest values and they head an ascending column",
    !/^\d/.test(world(sinks).app.wcSortOrder(ratios, "asc").map((i) => ratios[i])[0]));
  const flipTies = breakOnce(scriptSrc, "                return a.o - b.o;\n            });", "                return (a.o - b.o) * sign;\n            });", "ties");
  check("TEETH: reverse the ties with the values and the second press reorders equal rows", world(flipTies).app.wcSortOrder(["5", "3", "5", "3"], "desc").join() !== "0,2,1,3");
  // The direction: the same heading reverses, another starts ascending.
  const s1 = app.wcSortSet("t", 2, ""), s2 = app.wcSortSet("t", 2, ""), s3 = app.wcSortSet("t", 2, ""), s4 = app.wcSortSet("t", 5, "text");
  check("press a heading: ascending; again: descending; again: ascending; another heading: ascending",
    s1.dir === "asc" && s2.dir === "desc" && s3.dir === "asc" && s4.dir === "asc" && s4.col === 5 && s4.type === "text");
  check("each table keeps its own sort", app.wcSortSet("other", 2, "").dir === "asc");
}

// ==================================================================== 12
console.log("\n12. Sorting, on the screens: kept across every redraw, never changing a number");
{
  // The Teacher table (Staff): one row per adult, sorted by Deductions.
  const w = world(scriptSrc, { currentUser: PBIS });
  await open(w, "teacherInteractions");
  const body = () => el(w, "teacherActivityTableBody").innerHTML;
  const names = () => body().split(/(?=<tr\b)/).filter((r) => /^<tr\b/.test(r)).map(firstCellText);
  const before = names();
  const bag = (h) => h.split(/(?=<tr\b)/).filter((r) => /^<tr\b/.test(r)).map((r) => r.replace(/ data-sort-i="\d+"/, "")).sort().join("");
  const unsortedBag = bag(body());
  w.app.wcSortSet("teacherActivity", 3, "");
  w.app.updateTeacherInteractions();
  const asc = names();
  const negOf = (h) => h.split(/(?=<tr\b)/).filter((r) => /^<tr\b/.test(r)).map((r) => Number(cellText(r, 3)));
  check("Deductions ascending, after a redraw", negOf(body()).every((x, i, a) => !i || a[i - 1] <= x) && asc.join() !== before.join(),
    negOf(body()).join());
  w.app.updateTeacherInteractions();
  check("...and again after the next redraw (a load, a role check)", names().join() === asc.join());
  check("sorting moves rows and changes no figure in them", bag(body()) === unsortedBag);
  w.app.wcSortSet("teacherActivity", 3, "");
  w.app.updateTeacherInteractions();
  check("pressed again: descending", negOf(body()).every((x, i, a) => !i || a[i - 1] >= x));
  w.app.wcSortSet("teacherActivity", 4, "");
  w.app.updateTeacherInteractions();
  const ratioCells = body().split(/(?=<tr\b)/).filter((r) => /^<tr\b/.test(r)).map((r) => cellText(r, 4));
  const firstWords = ratioCells.findIndex((t) => !/^\d/.test(t));
  check("by ratio, the 'too few deductions to judge' rows sit at the bottom",
    firstWords > 0 && ratioCells.slice(firstWords).every((t) => /too few deductions to judge|no deductions/.test(t)), ratioCells.join(" | "));
  w.app.wcSortSet("teacherActivity", 4, "");
  w.app.updateTeacherInteractions();
  const desc = body().split(/(?=<tr\b)/).filter((r) => /^<tr\b/.test(r)).map((r) => cellText(r, 4));
  check("...and still at the bottom descending", /^\d/.test(desc[0]) && desc.slice(desc.findIndex((t) => !/^\d/.test(t))).every((t) => !/^\d/.test(t)),
    desc.join(" | "));
  const unsortedTable = breakOnce(scriptSrc, "            tbody.innerHTML = wcSortRowsHtml('teacherActivity', sortedTeachers.map(stats => {",
    "            tbody.innerHTML = ((rows) => rows.join(''))(sortedTeachers.map(stats => {", "teacher-sort");
  const u = world(unsortedTable, { currentUser: PBIS });
  await open(u, "teacherInteractions");
  const first = u.dom.getElementById("teacherActivityTableBody").innerHTML;
  u.app.wcSortSet("teacherActivity", 3, "");
  u.app.updateTeacherInteractions();
  check("TEETH: a renderer that skips wcSortRowsHtml forgets the sort on its next redraw",
    u.dom.getElementById("teacherActivityTableBody").innerHTML === first);
}
{
  // Trends: weeks newest first, through the unit switch and the server's answers.
  const w = world(scriptSrc, { currentUser: PBIS });
  await open(w, "trends");
  const weeks = () => tableRows(el(w, "cashTrendsBody").innerHTML, "cashPraise").map(firstCellText);
  const chrono = weeks();
  check("Trends opens chronological", chrono[0].startsWith("Sep 14") && /Oct 5/.test(chrono[chrono.length - 1]), chrono.join(" | "));
  w.app.wcSortSet("cashPraise", 0, "");
  w.app.wcSortSet("cashPraise", 0, "");
  w.app.renderCashTrends();
  check("Week pressed twice: newest first", /Oct 5/.test(weeks()[0]) && weeks()[weeks().length - 1].startsWith("Sep 14"));
  const head = el(w, "cashTrendsBody").innerHTML.slice(el(w, "cashTrendsBody").innerHTML.indexOf('data-sort-id="cashPraise"'));
  check("the Week heading says so: aria-sort=descending and a down arrow; the others show the neutral arrow",
    /<th scope="col" class="wc-pin" aria-sort="descending"><button type="button" class="wc-sort-btn" data-sort-table="cashPraise" data-sort-col="0" onclick="wcSortClick\(this\)">Week<span class="wc-sort-arrow" aria-hidden="true">▼<\/span>/.test(head) &&
    (head.slice(0, head.indexOf("</thead>")).match(/aria-sort=/g) || []).length === 1 && /⇅/.test(head));
  w.app.setCashCountUnit("students");
  check("...still newest first after the unit switch redraws the table", /Oct 5/.test(weeks()[0]));
  w.app.setCashNoticeSince("2026-09-21");
  check("...and after a 'No award since' pick redraws the page", /Oct 5/.test(weeks()[0]));
  w.app.wcSortSet("cashStudentsAwarded", 1, "");
  w.app.wcSortSet("cashStudentsAwarded", 1, "");
  w.app.renderCashTrends();
  const ms = tableRows(el(w, "cashTrendsBody").innerHTML, "cashStudentsAwarded").map((r) => Number(cellText(r, 1).split("%")[0]));
  check("Students who got at least one award, by Middle School share, highest first", ms.every((x, i, a) => !i || a[i - 1] >= x), ms.join());
  check("each Trends table keeps its own sort (the praise table is still by week)", /Oct 5/.test(weeks()[0]));
  const raw = breakOnce(scriptSrc, "                        '<tbody>' + wcSortRowsHtml(T, rows) + '</tbody>' +\n                    '</table></div>' +\n                    cashFoldHtml('praise-how'",
    "                        '<tbody>' + rows.join('') + '</tbody>' +\n                    '</table></div>' +\n                    cashFoldHtml('praise-how'", "praise-sort");
  const r = world(raw, { currentUser: PBIS });
  await open(r, "trends");
  r.app.wcSortSet("cashPraise", 0, ""); r.app.wcSortSet("cashPraise", 0, "");
  r.app.renderCashTrends();
  check("TEETH: draw the praise rows without the sorter and the redraw is chronological again",
    tableRows(el(r, "cashTrendsBody").innerHTML, "cashPraise").map(firstCellText)[0].startsWith("Sep 14"));
}
{
  // The named list (Students), by absences, and by name.
  const marks = { allowed: true, rows: [
    { studentNumber: "N7", entryDate: "2026-08-12", absentDates: ["2026-09-15", "2026-09-16", "2026-09-17"], tardyDates: [], unexcusedTardyDates: [] },
    { studentNumber: "N15", entryDate: "2026-08-12", absentDates: ["2026-09-15"], tardyDates: [], unexcusedTardyDates: null },
  ] };
  const w = world(scriptSrc, { currentUser: PBIS });
  w.G.window.WildcatAuth.convexQuery = async (name) => (name === "cashInsights:trendsContext" ? CTX : marks);
  await open(w, "students");
  const names = () => tableRows(el(w, "cashTrendsBody").innerHTML, "cashNeverNoticed").map(firstCellText);
  check("the named list opens by grade, then name", names().join() === "Stu7 Last7,Stu15 Last15", names().join());
  w.app.wcSortSet("cashNeverNoticed", 2, "");
  w.app.renderCashTrends();
  check("Absent (any period), ascending: 1 of 16 before 3 of 16", names().join() === "Stu15 Last15,Stu7 Last7", names().join());
  w.app.wcSortSet("cashNeverNoticed", 3, "");
  w.app.renderCashTrends();
  check("Late without an excuse: 'late days not yet refreshed' sinks below a 0", names().join() === "Stu7 Last7,Stu15 Last15");
  w.app.wcSortSet("cashNeverNoticed", 3, "");
  w.app.renderCashTrends();
  check("...in both directions", names().join() === "Stu7 Last7,Stu15 Last15");
}
{
  // The latest 100 movements sort by the moment, not by the words on screen.
  const w = world(scriptSrc, { currentUser: PBIS });
  await open(w, "teacherInteractions");
  const rowsNow = () => el(w, "teacherInteractionDetailsTableBody").innerHTML.split(/(?=<tr\b)/).filter((r) => /^\s*<tr\b/.test(r) || /<td/.test(r));
  // The date cell is the row's first; the student cell carries a surname key of its own.
  const stamps = () => [...el(w, "teacherInteractionDetailsTableBody").innerHTML.matchAll(/<tr[^>]*>\s*<td[^>]*data-sort="([^"]*)"/g)].map((m) => m[1]);
  check("every movement's date cell carries its ISO time", stamps().length > 10 && stamps().every((s) => /^\d{4}-\d{2}-\d{2}T/.test(s)));
  w.app.wcSortSet("teacherInteractionDetails", 0, "");
  w.app.updateTeacherInteractionDetails();
  const asc = stamps();
  check("Date/Time ascending is oldest first, by the timestamp", asc.every((x, i, a) => !i || a[i - 1] <= x) && asc.join() !== [...asc].reverse().join());
  w.app.wcSortSet("teacherInteractionDetails", 6, "");
  w.app.updateTeacherInteractionDetails();
  const amounts = [...el(w, "teacherInteractionDetailsTableBody").innerHTML.matchAll(/font-size: 16px;">\s*([-+]\$\d+|—)\s*<\/td>/g)].map((m) => m[1]);
  check("Amount ascending: -$1500 first, by value with the sign", amounts[0] === "-$1500" && amounts.every((x, i, a) => !i ||
    Number(a[i - 1].replace(/[$+]/g, "")) <= Number(x.replace(/[$+]/g, ""))), amounts.join());
}

// ==================================================================== 13
console.log("\n13. Sorting, the click: the rows on screen move, the button keeps focus");
/** A table as the browser would hold it, built from a renderer's own markup. */
function domTable(markup, id) {
  const rows = tableRows(markup, id).map((h) => {
    const cells = [...h.matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => {
      const a = /\bdata-sort="([^"]*)"/.exec(m[2]);
      return { innerHTML: m[3], getAttribute: (k) => (k === "data-sort" && a ? a[1] : null) };
    });
    const i = /data-sort-i="(\d+)"/.exec(h);
    return { html: h, cells, getAttribute: (k) => (k === "data-sort-i" && i ? i[1] : null) };
  });
  const body = { rows: rows.slice(), appendChild(r) { this.rows.splice(this.rows.indexOf(r), 1); this.rows.push(r); } };
  const headAt = markup.indexOf("<thead>", markup.indexOf('data-sort-id="' + id + '"'));
  const head = markup.slice(headAt, markup.indexOf("</thead>", headAt));
  const table = { tBodies: [body] };
  const buttons = [...head.matchAll(/<th\b([^>]*)><button type="button" class="wc-sort-btn" ([^>]*)>/g)].map((m) => {
    const attrs = Object.fromEntries([...m[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const th = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
    const arrow = { textContent: "" };
    return { th, arrow, focused: 0, getAttribute: (k) => (k in attrs ? attrs[k] : null), closest: (s) => (s === "th" ? th : table),
             querySelector: () => arrow, focus() { this.focused++; } };
  });
  table.querySelectorAll = () => buttons;
  return { table, body, buttons };
}
{
  const w = world(scriptSrc, { currentUser: PBIS });
  await open(w, "trends");
  const markup = el(w, "cashTrendsBody").innerHTML;
  const t = domTable(markup, "cashPraise");
  const labels = () => t.body.rows.map((r) => firstCellText(r.html));
  const drawn = labels();
  const week = t.buttons[0];
  w.app.wcSortClick(week);
  check("first press of Week: ascending (drawn order was already chronological)", labels().join() === drawn.join() &&
    week.th.attrs["aria-sort"] === "ascending" && week.arrow.textContent === "▲");
  w.app.wcSortClick(week);
  check("second press: descending, rows moved in place, arrow and aria-sort follow",
    labels().join() === [...drawn].reverse().join() && week.th.attrs["aria-sort"] === "descending" && week.arrow.textContent === "▼");
  w.app.wcSortClick(t.buttons[7]);
  check("another heading: ascending on it, and the Week heading goes back to neutral",
    t.buttons[7].th.attrs["aria-sort"] === "ascending" && !("aria-sort" in week.th.attrs) && week.arrow.textContent === "⇅");
  const ind = t.body.rows.map((r) => Number(r.cells[7].innerHTML.replace(/<[^>]*>/g, "")) );
  check("...rows ordered by Individual deductions, ties in week order", ind.every((x, i, a) => !i || a[i - 1] <= x), ind.join());
  check("the page is not redrawn by a click (the table keeps its sideways scroll and the button its focus)",
    el(w, "cashTrendsBody").innerHTML === markup);
  w.app.renderCashTrends();
  check("the next redraw comes back in the clicked order", tableRows(el(w, "cashTrendsBody").innerHTML, "cashPraise").map((r) =>
    Number(cellText(r, 7))).every((x, i, a) => !i || a[i - 1] <= x));
}
{
  // Keyboard: a real <button type="button"> in every sortable heading -- Tab
  // reaches it, Enter and Space press it -- in the static tables and in every
  // drawn one; no <th> is clickable on its own.
  const w = world(scriptSrc, { currentUser: PBIS });
  await open(w, "trends");
  const drawn = el(w, "cashTrendsBody").innerHTML;
  const staticBtns = [...html.matchAll(/<th scope="col"><button type="button" class="wc-sort-btn" data-sort-table="(\w+)" data-sort-col="(\d+)"[^>]*onclick="wcSortClick\(this\)">/g)];
  const drawnBtns = [...drawn.matchAll(/<button type="button" class="wc-sort-btn" data-sort-table="(\w+)" data-sort-col="(\d+)"[^>]*onclick="wcSortClick\(this\)">/g)];
  check("the static tables' headings are buttons: Teacher (8), Flagged (6 of 7, Action is not data), Latest 100 (8)",
    staticBtns.filter((m) => m[1] === "teacherActivity").length === 8 && staticBtns.filter((m) => m[1] === "interventionStudents").length === 6 &&
    staticBtns.filter((m) => m[1] === "teacherInteractionDetails").length === 8);
  check("the drawn tables' headings are buttons too (praise 12, students awarded 3 + 7 grades, behaviour change 5)",
    drawnBtns.filter((m) => m[1] === "cashPraise").length === 12 && drawnBtns.filter((m) => m[1] === "cashStudentsAwarded").length === 10 &&
    drawnBtns.filter((m) => m[1] === "cashOutcome").length === 5, JSON.stringify(drawnBtns.reduce((a, m) => (a[m[1]] = (a[m[1]] || 0) + 1, a), {})));
  const section = html.slice(html.indexOf('id="cashAnalyticsTab"'), html.indexOf('id="cashAuditTab"'));
  check("no Cash Analytics heading is a clickable <th> or a div pretending to be a button",
    section.length > 1000 && !/<th[^>]*onclick=/.test(section + drawn) && !/role="button"[^>]*wcSortClick/.test(section + drawn));
  const asTh = scriptSrc.replace("'<button type=\"button\" class=\"wc-sort-btn\" data-sort-table=\"' + tableId",
    "'<span class=\"wc-sort-btn\" data-sort-table=\"' + tableId");
  const k = world(asTh, { currentUser: PBIS });
  await open(k, "trends");
  check("TEETH: a heading drawn as a <span> (no Tab, no Enter) is caught",
    asTh !== scriptSrc && ![...el(k, "cashTrendsBody").innerHTML.matchAll(/<button type="button" class="wc-sort-btn" data-sort-table="cashPraise"/g)].length);
  check("the focus ring is visible on a heading button", /\.wc-sort-btn:focus-visible \{ outline: 2px solid/.test(css));
}
{
  // Which tables sort, and the two that deliberately do not.
  const w = world(scriptSrc, { currentUser: PBIS });
  await open(w, "students");
  const students = el(w, "cashTrendsBody").innerHTML;
  await open(w, "expectations");
  const bal = el(w, "cashAnalyticsDetails").innerHTML;
  const reach = students.slice(students.indexOf("Reach: expectation awards"), students.indexOf("Staff taking part"));
  check("the reach table (campuses, a total row, grades in a fixed order) is not sortable", reach.length > 100 && !/wc-sort-btn/.test(reach));
  check("the expectation balance (three rows under one spanning name) is not sortable", /Expectation balance/.test(bal) && !/wc-sort-btn/.test(bal));
  const staticIds = [...html.matchAll(/data-sort-table="(\w+)"/g)].map((m) => m[1]);
  const drawnIds = ["cashPraiseHtml", "cashTrendsHtml", "cashOutcomeHtml", "cashNeverNoticedHtml"]
    .map((f) => (/const T = '(\w+)';/.exec(liftFn(code, f)) || [])[1]);
  const all = [...new Set(staticIds.concat(drawnIds))].sort();
  check("seven sortable tables: Teacher Activity, Flagged, Latest 100, the named list, and Trends' three week tables",
    all.join() === "cashNeverNoticed,cashOutcome,cashPraise,cashStudentsAwarded,interventionStudents,teacherActivity,teacherInteractionDetails", all.join());
  check("every renderer of a sortable table passes its rows through the sorter",
    ["teacherActivity", "interventionStudents", "teacherInteractionDetails"].every((id) => scriptSrc.includes("wcSortRowsHtml('" + id + "'")) &&
    (liftFn(code, "cashPraiseHtml") + liftFn(code, "cashTrendsHtml") + liftFn(code, "cashOutcomeHtml") + liftFn(code, "cashNeverNoticedHtml"))
      .match(/wcSortRowsHtml\(T, /g).length === 4);
}

// ==================================================================== 14
console.log("\n14. Wiring: the stamps, the suite, and nothing new on the server");
{
  const stamps = [...html.matchAll(/\?v=([0-9a-z]+)/g)].map((m) => m[1]);
  check("all 26 cache stamps moved together, past the live 20261006b (open tabs update themselves; nobody is asked to refresh)",
    stamps.length === 26 && new Set(stamps).size === 1 && stamps[0] > "20261006b", [...new Set(stamps)].join(","));
  check("this suite runs in npm test, after cash-insights", /node cash-insights\.test\.mjs && node cash-nav\.test\.mjs/.test(pkg.scripts.test));
  const added = ["switchAnalyticsSubtab", "renderCashWeekStrip", "wcSortClick", "renderCashMovedNote", "cashRememberedView"]
    .map((n) => liftFn(code, n)).join("\n");
  check("no new server read: the new code asks for nothing", !/convexQuery|fetch\(/.test(added.replace(/Promise\.all\(\[loadCashTrendsContext\(\), cashStaffViewsAllowed\(\) \? loadCashNeverNoticedMarks\(\) : false\]\)/, "")));
  check("no dollars in the new panels' wording (the Flagged rule keeps its $2,000, parked for the owner)",
    !/\$/.test(liftFn(code, "cashWeekStripHtml") + liftFn(code, "cashMovedNoteHtml")));
}

// ==================================================================== 15
console.log("\n15. The review of 2026-10-06: each fix, and a check that it is load-bearing");
/** breakOnce inside one function only, for text that appears in more than one. */
function breakIn(src, fn, from, to, label) {
  const body = liftFn(src, fn);
  const at = src.indexOf(body);
  return src.slice(0, at) + breakOnce(body, from, to, label) + src.slice(at + body.length);
}
{
  // ONE ELEMENT PER ID. The fake DOM keeps one element per id, so it could
  // not see two: the Flagged fold's summary shared "interventionCount" with
  // Discipline's referral banner, which comes first in the page, so the cash
  // code wrote "Admins and the PBIS team only" and "10 students: show list"
  // over the referral form, and the fold read "Loading..." for ever.
  const dupIds = (page) => {
    const seen = new Map();
    for (const m of page.replace(/<!--[\s\S]*?-->/g, "").replace(/<script\b[\s\S]*?<\/script>/gi, "").matchAll(/\sid="([^"]+)"/g)) {
      seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    }
    return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  };
  check("no id appears twice in index.html", dupIds(html).length === 0, dupIds(html).join(","));
  check("TEETH: the Flagged count back on the referral banner's id is caught",
    dupIds(html.replace('<summary id="interventionFlaggedCount">', '<summary id="interventionCount">')).join() === "interventionCount");
  check("the cash code writes the Flagged count to its own id, and only the referral form writes the banner",
    (code.match(/getElementById\('interventionFlaggedCount'\)/g) || []).length === 2 &&
    (code.match(/getElementById\('interventionCount'\)/g) || []).length === 1 && /getElementById\('interventionCount'\)/.test(liftFn(code, "updateInterventionCount")));
}
{
  // A DIFFERENT PERSON ON THIS PAGE starts unsorted with the static folds shut;
  // the same person keeps both across tab switches.
  const run = async (src) => {
    const w = world(src, { currentUser: ADMIN });
    await open(w, "trends");
    const weeks = () => tableRows(el(w, "cashTrendsBody").innerHTML, "cashPraise").map(firstCellText);
    w.app.wcSortSet("cashPraise", 0, ""); w.app.wcSortSet("cashPraise", 0, "");
    el(w, "interventionFold").open = true; el(w, "teacherInteractionDetailsFold").open = true;
    await open(w, "students"); await open(w, "trends");
    const kept = /Oct 5/.test(weeks()[0]) && el(w, "interventionFold").open === true && el(w, "teacherInteractionDetailsFold").open === true;
    // Logout does not reload the page; a teacher signs in next.
    w.app.set("currentUser", null); w.app.applyCashAnalyticsGate();
    w.app.set("currentUser", PARK); w.app.applyCashAnalyticsGate();
    await open(w, "trends");
    const body = el(w, "cashTrendsBody").innerHTML;
    const teacher = { weeks: weeks(), marked: /aria-sort=|▲|▼/.test(body), folds: [el(w, "interventionFold").open, el(w, "teacherInteractionDetailsFold").open] };
    // Admin to PBIS straight across (teacher view of a PBIS lead does this): both may see Flagged.
    w.app.set("currentUser", ADMIN); w.app.applyCashAnalyticsGate();
    el(w, "interventionFold").open = true;
    w.app.set("currentUser", PBIS); w.app.applyCashAnalyticsGate();
    return { kept, teacher, pbisFold: el(w, "interventionFold").open };
  };
  const ok = await run(scriptSrc);
  check("the same person keeps their sort and their open folds across tab switches", ok.kept);
  check("a teacher signing in next opens Trends in date order, no heading marked",
    ok.teacher.weeks.length > 1 && ok.teacher.weeks[0].startsWith("Sep 14") && !ok.teacher.marked, ok.teacher.weeks.join(" | "));
  check("...with the Flagged and Latest 100 folds shut", ok.teacher.folds.join() === "false,false");
  check("the next admin or PBIS lead does not open on the last one's Flagged names", ok.pbisFold === false);
  const bad = await run(breakOnce(scriptSrc, "                cashViewerChanged();\n", "", "viewer"));
  check("TEETH: without it the teacher inherits the admin's sort and the open folds, and PBIS the admin's Flagged list",
    /Oct 5/.test(bad.teacher.weeks[0]) && bad.teacher.marked && bad.teacher.folds.join() === "true,true" && bad.pbisFold === true);
}
{
  // LATEST 100'S ORDER CHIP says the order the rows are in.
  check("the chip is tagged with its table and its default", /<span class="wc-chip" data-sort-chip="teacherInteractionDetails" data-sort-default="Newest first">Newest first<\/span>/.test(html));
  const run = (src) => {
    const w = world(src, { currentUser: PBIS });
    const chip = { textContent: "Newest first", getAttribute: (k) => (k === "data-sort-default" ? "Newest first" : null) };
    const arrow = { textContent: "⇅" };
    const th = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
    const attrs = { "data-sort-table": "teacherInteractionDetails", "data-sort-col": "6" };
    const table = { querySelectorAll: () => [btn] };
    const btn = { get textContent() { return "Amount" + arrow.textContent; }, getAttribute: (k) => (k in attrs ? attrs[k] : null),
                  closest: (s) => (s === "th" ? th : table), querySelector: () => arrow };
    const qsa = w.dom.querySelectorAll;
    w.dom.querySelectorAll = (sel) => (sel === '[data-sort-chip="teacherInteractionDetails"]' ? [chip] : sel === ".wc-sort-btn" ? [btn] : qsa(sel));
    w.app.applyCashAnalyticsGate();
    w.app.wcSortClick(btn);
    const sorted = { chip: chip.textContent, arrow: arrow.textContent };
    w.app.set("currentUser", ADMIN); w.app.applyCashAnalyticsGate();
    return { sorted, next: { chip: chip.textContent, arrow: arrow.textContent, aria: "aria-sort" in th.attrs } };
  };
  const r = run(scriptSrc);
  check("sorted by Amount, the chip reads 'Sorted by Amount', not 'Newest first'", r.sorted.chip === "Sorted by Amount" && r.sorted.arrow === "▲", JSON.stringify(r.sorted));
  check("the next person: 'Newest first' again, and the Amount heading unsorted", r.next.chip === "Newest first" && r.next.arrow === "⇅" && !r.next.aria, JSON.stringify(r.next));
  const noChip = breakOnce(scriptSrc, "                document.querySelectorAll('[data-sort-chip=\"' + tableId + '\"]').forEach(c => {\n",
    "                [].forEach(c => {\n", "chip");
  check("TEETH: without the chip line it still says 'Newest first' over rows sorted by Amount", run(noChip).sorted.chip === "Newest first");
}
{
  // AN IN-PAGE LINK LANDS ON THE NEW TAB'S TOP.
  const run = async (src) => {
    const w = world(src, { currentUser: PBIS });
    await open(w, "dashboard");
    const bar = el(w, "cashAnalyticsViews");
    const calls = [];
    let rect = { top: -334, height: 44 };
    bar.getBoundingClientRect = () => rect;
    bar.scrollIntoView = (o) => calls.push(o);
    w.dom.querySelector = (sel) => (sel === ".app-topbar" ? { getBoundingClientRect: () => ({ bottom: 66 }) } : null);
    const out = [];
    await open(w, "teacherInteractions"); out.push(calls.length);          // "Open Staff", bar above the screen
    rect = { top: 30, height: 44 }; await open(w, "trends"); out.push(calls.length);    // behind the sticky top bar
    rect = { top: 140, height: 44 }; await open(w, "students"); out.push(calls.length); // a press on the bar itself
    rect = { top: 0, height: 0 }; await open(w, "dashboard"); out.push(calls.length);   // Cash Analytics not laid out
    return { out, first: calls[0] };
  };
  const r = await run(scriptSrc);
  check("a link pressed with the bar above the screen brings the bar back to the top", r.out[0] === 1 && r.first && r.first.block === "start");
  check("...and when the bar is hidden behind the sticky top bar", r.out[1] === 2);
  check("a press on the bar itself, on screen, never moves the page; nor a switch while the tab is not laid out", r.out[2] === 2 && r.out[3] === 2, r.out.join());
  check("the bar stops just under the sticky top bar, not behind it", /\.wc-cash-views \{ scroll-margin-top: calc\(var\(--wc-topbar-h\) \+ 8px\); \}/.test(css));
  check("TEETH: without the call the reader is left partway down the new tab",
    (await run(breakOnce(scriptSrc, "            cashBarIntoView();\n", "", "bar"))).out.join() === "0,0,0,0");
}
{
  // THE TOP BAR SCROLLS AWAY on the real page (#mainApp.container keeps
  // overflow:hidden), so its bottom edge goes negative. A Cash bar sitting just
  // above the screen must still be brought back (final review, 2026-10-06).
  const run = async (src) => {
    const w = world(src, { currentUser: PBIS });
    await open(w, "dashboard");
    const bar = el(w, "cashAnalyticsViews");
    const calls = [];
    bar.getBoundingClientRect = () => ({ top: -20, height: 44 });
    bar.scrollIntoView = (o) => calls.push(o);
    w.dom.querySelector = (sel) => (sel === ".app-topbar" ? { getBoundingClientRect: () => ({ bottom: -50 }) } : null);
    await open(w, "trends");
    return calls.length;
  };
  check("with the top bar scrolled away, a bar just above the screen is still brought back", (await run(scriptSrc)) === 1);
  check("TEETH: comparing against the scrolled-away top bar's negative edge leaves it off screen",
    (await run(breakOnce(scriptSrc, "            if (r.top >= Math.max(0, under)) return false;", "            if (r.top >= under) return false;", "under"))) === 0);
}
{
  // THE PAGE IS CALLED DASHBOARD on screen, so the words say Dashboard.
  const page = (h) => h.replace(/<!--[\s\S]*?-->/g, "");
  const homeWords = (h, c) => [...(page(h) + "\n" + c).matchAll(/[^\n]{0,40}\bHome (?:page|gauge)\b[^\n]{0,20}/gi)].map((m) => m[0].trim());
  check("the page these lines open is labelled Dashboard in the sidebar and in its own title",
    /<button class="tab" id="dashboardTab" onclick="switchTab\('dashboard'\)">[^\n]*<\/svg> Dashboard<\/button>/.test(html) &&
    /<h2 class="page-title">[^\n]*<\/svg> Dashboard<\/h2>/.test(html));
  check("no words on screen send anyone to a 'Home page' or a 'Home gauge'", homeWords(html, code).length === 0, homeWords(html, code).join(" | "));
  check("TEETH: one old line back is caught", homeWords(html.replace("your own students are on your Dashboard.)", "your own students are on your Home page.)"), code).length === 1);
}
{
  // WHERE THE READER WAS SURVIVES THE TRENDS REDRAW (the server's first
  // answer, a unit switch, a date pick). A small model of the browser's half:
  // elements found by selector in the drawn markup, new ones after each
  // redraw, and a sideways scroll that a new box does not have.
  const run = async (src) => {
    const w = world(src, { currentUser: PBIS });
    await open(w, "trends");
    const host = el(w, "cashTrendsBody");
    let markup = host.innerHTML, gen = 0;
    Object.defineProperty(host, "innerHTML", { get: () => markup, set: (v) => { markup = v; gen++; }, configurable: true });
    const boxes = new Map();
    const ids = () => [...markup.matchAll(/data-sort-id="(\w+)"/g)].map((m) => m[1]);
    const box = (id) => { const k = gen + ":" + id; if (!boxes.has(k)) boxes.set(k, { scrollLeft: 0, querySelector: () => tbl(id) }); return boxes.get(k); };
    const tbl = (id) => ({ getAttribute: (a) => (a === "data-sort-id" ? id : null), closest: () => box(id) });
    const btn = (table, col) => ({ gen, table, col, classList: { contains: (c) => c === "wc-sort-btn" },
      getAttribute: (a) => (a === "data-sort-table" ? table : a === "data-sort-col" ? col : null), focus() { w.dom.activeElement = this; } });
    host.querySelectorAll = (sel) => (sel === ".wu-scroll-x" ? ids().map(box) : []);
    host.querySelector = (sel) => {
      let m = /^table\[data-sort-id="(\w+)"\]$/.exec(sel);
      if (m) return ids().includes(m[1]) ? tbl(m[1]) : null;
      m = /^\.wc-sort-btn\[data-sort-table="(\w+)"\]\[data-sort-col="(\d+)"\]$/.exec(sel);
      if (m) return markup.includes(`data-sort-table="${m[1]}" data-sort-col="${m[2]}"`) ? btn(m[1], m[2]) : null;
      return null;
    };
    host.contains = (x) => !!x && x.gen === gen;
    w.dom.activeElement = btn("cashPraise", "7");
    box("cashPraise").scrollLeft = 310;
    w.app.renderCashTrends();
    const a = w.dom.activeElement;
    return { redrawn: gen === 1, focus: a.gen === gen && a.table === "cashPraise" && a.col === "7", scroll: box("cashPraise").scrollLeft };
  };
  const r = await run(scriptSrc);
  check("after a redraw the same sort heading has focus again", r.redrawn && r.focus);
  check("...and the praise table is scrolled sideways where it was", r.scroll === 310, String(r.scroll));
  const bad = await run(breakOnce(scriptSrc, "            putBack();\n", "", "keep"));
  check("TEETH: without it focus stays on a heading that is gone and the table is back at its left edge", bad.redrawn && !bad.focus && bad.scroll === 0);
}
{
  // ABSENT (ANY PERIOD) SORTS BY THE SHARE OF EACH STUDENT'S OWN DAYS.
  const marks = { allowed: true, rows: [
    { studentNumber: "N7", entryDate: "2026-08-12", absentDates: ["2026-09-15", "2026-09-16", "2026-09-17"], tardyDates: [], unexcusedTardyDates: [] },
    // Joined 9/29: absent two of their five school days.
    { studentNumber: "N15", entryDate: "2026-09-29", absentDates: ["2026-09-30", "2026-10-01"], tardyDates: [], unexcusedTardyDates: [] },
  ] };
  const run = async (src) => {
    const w = world(src, { currentUser: PBIS });
    w.G.window.WildcatAuth.convexQuery = async (name) => (name === "cashInsights:trendsContext" ? CTX : marks);
    await open(w, "students");
    w.app.wcSortSet("cashNeverNoticed", 2, ""); w.app.wcSortSet("cashNeverNoticed", 2, "");
    w.app.renderCashTrends();
    const rows = tableRows(el(w, "cashTrendsBody").innerHTML, "cashNeverNoticed");
    return { names: rows.map(firstCellText).join(), absent: rows.map((x) => cellText(x, 2)).join() };
  };
  const r = await run(scriptSrc);
  check("most absent first: 2 of 5 days (a late joiner, 40%) above 3 of 16 (19%)", r.names === "Stu15 Last15,Stu7 Last7", r.names);
  check("...and the words on screen are unchanged", r.absent === "2 of 5 school days,3 of 16 school days", r.absent);
  const bad = await run(breakOnce(scriptSrc, "'<td' + (absentShare === null ? '' : ' data-sort=\"' + absentShare + '\"') + '>'", "'<td>'", "share"));
  check("TEETH: sorted by the count, the late joiner sinks below a classmate who missed far less", bad.names === "Stu7 Last7,Stu15 Last15");
}
{
  // STUDENT COLUMNS SORT BY SURNAME, as the lists are drawn and as
  // PowerSchool lists students; the cells still read "First Last".
  const named = (n, first, last, extra) => (p) => (p.id === "s" + n ? { ...p, firstName: first, lastName: last, ...(extra || {}) } : p);
  const fiveDeductions = (k) => ({ wildcatCashTransactions: Array.from({ length: 5 }, (_, i) =>
    ({ id: "fz" + k + i, kind: "deduct", amount: -100, teacherId: "T1", behaviorId: "wc6" })) });
  const cast = () => people().map(named(7, "Alpha", "Zulu")).map(named(15, "Bravo", "Mike"))
    .map(named(3, "Alpha", "Zulu", fiveDeductions(3))).map(named(5, "Bravo", "Mike", fiveDeductions(5)))
    .map(named(1, "Alpha", "Zulu")).map(named(2, "Bravo", "Mike")).map(named(4, "Charlie", "Lima"));
  const latest = ["s1", "s2", "s4"].map((sid, i) => row({ s: sid, at: T(10, 5, 9, i), extra: { studentName: "" } }));
  const run = async (src) => {
    const w = world(src, { currentUser: PBIS, students: cast() });
    await open(w, "students");
    w.app.wcSortSet("cashNeverNoticed", 0, "text");
    w.app.renderCashTrends();
    const list = tableRows(el(w, "cashTrendsBody").innerHTML, "cashNeverNoticed").map(firstCellText).join();
    w.app.wcSortSet("interventionStudents", 0, "text");
    w.app.updateInterventionStudents();
    const flagged = el(w, "interventionStudentsTableBody").innerHTML.split(/(?=<tr\b)/).filter((x) => /^\s*<tr\b/.test(x)).map(firstCellText).join();
    const l = world(src, { currentUser: PBIS, students: cast(), rows: latest });
    await open(l, "teacherInteractions");
    l.app.wcSortSet("teacherInteractionDetails", 2, "text");
    l.app.updateTeacherInteractionDetails();
    const log = el(l, "teacherInteractionDetailsTableBody").innerHTML.split(/(?=<tr\b)/).filter((x) => /^\s*<tr\b/.test(x)).map((x) => cellText(x, 2)).join();
    return { list, flagged, log };
  };
  const r = await run(scriptSrc);
  check("the named list: Bravo Mike before Alpha Zulu (by surname, as drawn by grade then surname)", r.list === "Bravo Mike,Alpha Zulu", r.list);
  check("Flagged: the same", r.flagged === "Bravo Mike,Alpha Zulu", r.flagged);
  check("Latest 100: Charlie Lima, Bravo Mike, Alpha Zulu", r.log === "Charlie Lima,Bravo Mike,Alpha Zulu", r.log);
  const bad = await run(breakIn(breakIn(breakIn(scriptSrc,
    "cashNeverNoticedHtml", " data-sort=\"' + sortName + '\"", "", "list-surname"),
    "updateInterventionStudents", ' data-sort="${escapeHtml([student.lastName, student.firstName].filter(Boolean).join(\', \'))}"', "", "flag-surname"),
    "updateTeacherInteractionDetails", ' data-sort="${escapeHtml(txn.studentSortName || String(txn.studentName))}"', "", "log-surname"));
  check("TEETH: without the surname keys all three sort by first name",
    r.list !== bad.list && bad.list === "Alpha Zulu,Bravo Mike" && bad.flagged === "Alpha Zulu,Bravo Mike" && bad.log === "Alpha Zulu,Bravo Mike,Charlie Lima",
    JSON.stringify(bad));
}
{
  // A CLICK ORDERS TIED ROWS AS THE NEXT REDRAW WILL: by the drawn order,
  // never by the order the screen last had them in.
  const run = async (src) => {
    const w = world(src, { currentUser: PBIS });
    await open(w, "trends");
    const t = domTable(el(w, "cashTrendsBody").innerHTML, "cashPraise");
    w.app.wcSortClick(t.buttons[0]); w.app.wcSortClick(t.buttons[0]);   // Week, newest first
    w.app.wcSortClick(t.buttons[7]);                                   // Individual deductions
    const ind = t.body.rows.map((x) => x.cells[7].innerHTML.replace(/<[^>]*>/g, "").trim());
    const onScreen = t.body.rows.map((x) => firstCellText(x.html)).join(" | ");
    w.app.renderCashTrends();
    return { ties: new Set(ind).size < ind.length, onScreen, redrawn: tableRows(el(w, "cashTrendsBody").innerHTML, "cashPraise").map(firstCellText).join(" | ") };
  };
  const r = await run(scriptSrc);
  check("some weeks tie on individual deductions", r.ties);
  check("the rows a click leaves on screen are the rows the next redraw draws, ties included", r.onScreen === r.redrawn, r.onScreen + " vs " + r.redrawn);
  const bad = await run(breakOnce(scriptSrc, "                        return isFinite(v) ? v : i;\n", "                        return i;\n", "dom-ties"));
  check("TEETH: break ties by the screen's order and the redraw reorders the tied weeks", bad.onScreen !== bad.redrawn);
}
{
  // WEEK SORTS BY ITS MONDAY in all three week tables, not by its words.
  // Behaviour change draws a row per week the server's calendar names.
  const weeks = ["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"].map((monday) => ({ monday, status: "pending" }));
  const run = async (src) => {
    const w = world(src, { currentUser: PBIS });
    w.G.window.WildcatAuth.convexQuery = async (name) =>
      (name === "cashInsights:trendsContext" ? { ...CTX, weeks } : { allowed: true, rows: [] });
    await open(w, "trends");
    const tables = ["cashPraise", "cashStudentsAwarded", "cashOutcome"];
    tables.forEach((T) => { w.app.wcSortSet(T, 0, ""); w.app.wcSortSet(T, 0, ""); });
    w.app.renderCashTrends();
    const out = {};
    tables.forEach((T) => { out[T] = tableRows(el(w, "cashTrendsBody").innerHTML, T).map(firstCellText); });
    return out;
  };
  const r = await run(scriptSrc);
  const newestFirst = (labels) => labels.length > 1 && /^Oct 5/.test(labels[0]) && labels[labels.length - 1].startsWith("Sep 14");
  check("Week pressed twice: newest first on all three (praise, students awarded, behaviour change)",
    newestFirst(r.cashPraise) && newestFirst(r.cashStudentsAwarded) && newestFirst(r.cashOutcome), JSON.stringify(r));
  const noKey = "const weekCell = (w) => '<th scope=\"row\" class=\"wc-pin\" data-sort=\"' + escapeHtml(w.monday) + '\">'";
  const words = breakIn(breakIn(scriptSrc, "cashTrendsHtml", noKey, "const weekCell = (w) => '<th scope=\"row\" class=\"wc-pin\">'", "awarded-key"),
    "cashOutcomeHtml", "'<th scope=\"row\" class=\"wc-pin\" data-sort=\"' + escapeHtml(w.monday) + '\">'", "'<th scope=\"row\" class=\"wc-pin\">'", "outcome-key");
  const b = await run(words);
  check("TEETH: without the Monday key, students awarded and behaviour change sort the week as words",
    newestFirst(b.cashPraise) && !newestFirst(b.cashStudentsAwarded) && !newestFirst(b.cashOutcome), JSON.stringify(b));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
