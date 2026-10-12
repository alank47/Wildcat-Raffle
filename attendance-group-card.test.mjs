// The weekly attendance-rate run chart BY STUDENT GROUP (2026-10-12): the
// browser half, the card at the top of Attendance Watch > Student groups.
// Run: npm test
//
// THE OWNER'S DECISIONS (2026-10-11) this screen has to keep, each held by a
// check below, with the SHIPPED code running against the REAL server query
// (attendanceGroupRunChart:groupWeeks) on a small fake database:
//
//   - the drop-down offers exactly the groups the server lists for the person
//     signed in: Black for admins only, no race line for PBIS, Female and Male
//     only for the Attendance Watch grant -- who gets this tab, and is never
//     sent or shown the year-to-date table under it
//   - one group against a dashed whole-school line that IS Trends' line,
//     value for value; short weeks follow Trends' own setting
//   - the answer leads with the group's run-chart status, gives the gap to the
//     REST of the school averaged over the year, and a small group says
//     whether that is within chance for a group this size
//   - a signal is "worth a look", the screen says how many lines can be
//     checked, and a group under 60 is never coloured
//   - both cards say how they count (whole days, leavers, weekly; any missed
//     period, today's roster, year to date)
//   - rates only: no count on screen, in the hover, or on paper
//   - the provisional countdown, and a recalculated (never frozen) group median
//   - print to #wcPrintSheet; everything goes at sign-out; phone width
//
// THE WAYS IT GOES WRONG, and the sections:
//   A. THE WHOLE-SCHOOL LINE DRIFTS FROM TRENDS (a second copy of the weeks)
//   B. THE SCREEN ASKS FOR SOMETHING THE SERVER REFUSES (a Monday twice, a
//      period crossing a year) and draws nothing
//   C. A PERSON SEES A LINE, OR A TABLE, THEY WERE NOT GIVEN
//   D. THE WORDS CLAIM MORE THAN A RUN CHART TESTS
//   E. A COUNT REACHES THE SCREEN OR THE PAPER
//   F. THE LAST PERSON'S CHART STAYS ON A SHARED CHROMEBOOK
//   G. TRENDS ITSELF CHANGES
process.env.TZ = "America/Los_Angeles";

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const scriptSrc = read("./script.js");
const html = read("./index.html");
const css = read("./styles.css");
const rosterSrc = read("./wildcat-roster.js");
const discSrc = read("./wildcat-discipline.js");
const pkg = JSON.parse(read("./package.json"));
const SRC = {
  rules: read("./convex/absenceDayRules.ts"),
  rollup: read("./convex/raceRollup.ts"),
  days: read("./convex/runChartDays.ts"),
  groups: read("./convex/runChartGroups.ts"),
  query: read("./convex/attendanceGroupRunChart.ts"),
};

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

// ------------------------------------------------------------ the real rules
function loadRoster(src = rosterSrc) {
  const sb = {};
  new Function("globalThis", src).call(sb, sb);
  return sb.WildcatRoster;
}
const R = loadRoster();
const D = (() => { const sb = {}; new Function("globalThis", discSrc).call(sb, sb); return sb.WildcatDiscipline; })();

// ------------------------------------------------------- the real server query
const tsx = (src) => ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const load = (src, deps = {}) => {
  const m = { exports: {} };
  new Function("module", "exports", "require", tsx(src))(m, m.exports, (p) => {
    if (deps[p]) return deps[p];
    throw new Error("unexpected import " + p);
  });
  return m.exports;
};
const vStub = new Proxy({}, { get: () => () => ({}) });
const S = (() => {
  const rules = load(SRC.rules);
  const rollup = load(SRC.rollup);
  const days = load(SRC.days, { "./absenceDayRules": rules });
  const groups = load(SRC.groups, { "./raceRollup": rollup, "./absenceDayRules": rules, "./runChartDays": days });
  return load(SRC.query, {
    "./_generated/server": { query: (d) => d, internalMutation: (d) => d, internalQuery: (d) => d },
    "convex/values": { v: vStub },
    "./identity": { requireStaff: async (ctx) => ctx.staff },
    "./runChartDays": days, "./runChartGroups": groups,
  });
})();

const INDEXES = {
  attendanceRunGroupDays: { by_yearid_date: ["yearid", "date"], by_axis_date: ["axis", "date"] },
  attendanceRunGroupMonths: { by_yearid_month: ["yearid", "month"] },
  attendanceRunDays: { by_yearid_date: ["yearid", "date"] },
};
function fakeDb(tables) {
  const query = (table) => {
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
    };
    return chain;
  };
  return { query };
}

// ------------------------------------------------------------- the fixtures
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const SYNC = "2026-10-12T10:15:00.000Z";
// THIS YEAR as measured (a typical day); LAST YEAR as measured.
const THIS = { F: 297, M: 315, gnone: 0, black: 47, rnone: 565, EL: 115, EO: 268, RFEP: 197, IFEP: 28, TBD: 4, NOREC: 0 };
const LAST = { F: 212, M: 228, gnone: 0, black: 66, rnone: 374, EL: 92, EO: 193, RFEP: 136, IFEP: 19, TBD: 0, NOREC: 0 };
/**
 * School days: this year from Wed 2026-08-12 (a 3-day first week) to Fri
 * 2026-10-09, less Labor Day; last year 2025-08-14 (Thu) to 2025-11-21, less
 * a 2-day Thanksgiving-style week in October. Today is Mon 2026-10-12.
 */
function schoolDays(from, to, skip = []) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const dow = new Date(d + "T00:00:00Z").getUTCDay();
    if (dow !== 0 && dow !== 6 && !skip.includes(d)) out.push(d);
  }
  return out;
}
const THIS_DAYS = schoolDays("2026-08-12", "2026-10-09", ["2026-09-07"]);
const LAST_DAYS = schoolDays("2025-08-14", "2025-11-21", ["2025-10-15", "2025-10-16", "2025-10-17"]);

/** Whole days out for one cell on one day: a rate that moves by week, so lines differ. */
const rateFor = (cell, date, bump) => {
  const w = Math.floor((Date.parse(date + "T00:00:00Z") - Date.parse("2025-08-11T00:00:00Z")) / (7 * 86400000));
  const base = { F: 0.07, M: 0.085, gnone: 0.08, black: 0.1, rnone: 0.078, EL: 0.09, EO: 0.08, RFEP: 0.07, IFEP: 0.06, TBD: 0.1, NOREC: 0.1 }[cell];
  return base + ((w * 7 + cell.length) % 5) * 0.004 + (bump ? bump(cell, date) : 0);
};
function row(yearid, date, axis, group, members, full) {
  return { yearid, date, axis, group, members, absentDays: full, fullDaysStrict: full, misrecordDaysByGap: [0, 0, 0],
           partialDays: 0, assumedPresentDays: 0, syncedAt: SYNC };
}
/** One day of every family from its finest cells, so every axis adds up to the same whole school. */
function dayRows(yearid, date, c, bump) {
  const full = {};
  for (const k of Object.keys(c)) full[k] = Math.round((c[k] || 0) * rateFor(k, date, bump));
  // The race and English Learner cells are re-shared so each axis has the gender axis's total.
  const total = full.F + full.M + full.gnone;
  const fix = (cells) => { const big = cells.slice().sort((a, b) => c[b] - c[a])[0]; full[big] += total - cells.reduce((n, k) => n + full[k], 0); };
  fix(["black", "rnone"]); fix(["EL", "EO", "RFEP", "IFEP", "TBD", "NOREC"]);
  const r = (axis, group, keys) => row(yearid, date, axis, group, keys.reduce((n, k) => n + (c[k] || 0), 0), keys.reduce((n, k) => n + full[k], 0));
  return {
    whole: { members: c.F + c.M + c.gnone, full: total },
    rows: [
      r("gender", "F", ["F"]), r("gender", "M", ["M"]), r("gender", "none", ["gnone"]),
      r("race", "black", ["black"]), r("race", "none", ["rnone"]),
      r("el", "el", ["EL"]), r("el", "notel", ["EO", "RFEP", "IFEP", "TBD"]), r("el", "none", ["NOREC"]),
      r("ela", "EO", ["EO"]), r("ela", "RFEP", ["RFEP"]), r("ela", "IFEP", ["IFEP"]), r("ela", "none", ["TBD", "NOREC"]),
    ],
  };
}
/**
 * Both years: the group rows (attendanceRunGroupDays) and the Trends rows
 * (attendanceRunDays, two bands that add to the whole school). `tweak(date,
 * cells)` changes a day; `bump(cell, date)` moves a cell's absence rate.
 */
function world({ tweak = () => {}, bump = null, baselines = [] } = {}) {
  const groupRows = [], trends = [];
  const add = (yearid, days, base) => {
    for (const d of days) {
      const c = { ...base };
      tweak(d, c);
      const { whole, rows } = dayRows(yearid, d, c, bump);
      groupRows.push(...rows);
      const ms = Math.round(whole.members * 0.55), mf = Math.round(whole.full * 0.5);
      trends.push({ yearid, date: d, band: "6-8", members: ms, absentDays: mf + 2, fullDaysStrict: mf, misrecordDaysByGap: [1, 1, 0],
                    partialDays: 0, assumedPresentDays: 0, gradeEstimated: yearid === 35, syncedAt: SYNC });
      trends.push({ yearid, date: d, band: "9-12", members: whole.members - ms, absentDays: whole.full - mf + 1, fullDaysStrict: whole.full - mf,
                    misrecordDaysByGap: [0, 1, 0], partialDays: 0, assumedPresentDays: 0, gradeEstimated: yearid === 35, syncedAt: SYNC });
    }
  };
  add(36, THIS_DAYS, THIS);
  add(35, LAST_DAYS, LAST);
  return {
    tables: { attendanceRunGroupDays: groupRows, attendanceRunDays: trends, attendanceRunGroupMonths: [] },
    // What attendanceRunChartData:series answers: the same Trends rows.
    series: { allowed: true, days: trends, months: [], baselines, annotations: [], truncated: false },
  };
}
const ADMIN = { role: "admin", email: "a@x" }, SUPER = { role: "superadmin", email: "s@x" }, PBIS = { role: "pbis", email: "p@x" };
const GRANT = { role: "campusaide", email: "g@x", attendanceWatch: true };
const TEACHER = { role: "teacher", email: "t@x" };
/** The real query, as a tab would call it: arguments through JSON, unknown arguments refused as Convex does. */
async function serverAsk(tables, staff, args) {
  const a = JSON.parse(JSON.stringify(args || {}));
  for (const k of Object.keys(a)) if (!["group", "periods", "misrecordAt"].includes(k)) throw new Error("ArgumentValidationError: " + k);
  if ("misrecordAt" in a && typeof a.misrecordAt !== "number") throw new Error("ArgumentValidationError: misrecordAt");
  return S.groupWeeks.handler({ staff, db: fakeDb(tables) }, a);
}
const TODAY = "2026-10-12";
const opts = (policy = "merge", misrecordAt = 1) => ({ policy, settings: { misrecordAt }, today: TODAY });

// ---------------------------------------------------------- the screen, lifted
/** A top-level function or const of script.js (eight-space indent, as attendance-nav lifts). */
function liftFn(src, name) {
  const m = new RegExp("\\n        (?:async )?function " + name + "\\(").exec(src);
  if (!m) throw new Error("missing function " + name);
  const start = m.index + 1;
  const end = src.indexOf("\n        }\n", start);
  return src.slice(start, end + 10);
}
function liftConst(src, name) {
  const m = new RegExp("\\n        const " + name + " = ").exec(src);
  if (!m) throw new Error("missing const " + name);
  const i = m.index + 1;
  const line = src.slice(i, src.indexOf("\n", i));
  if (/;\s*$/.test(line) && !/[\[{]\s*$/.test(line)) return line.trim();
  const open = src.slice(i).search(/[\[{]/) + i;
  const close = src[open] === "[" ? "]" : "}";
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === src[open]) depth++;
    else if (src[k] === close) { depth--; if (depth === 0) return src.slice(i, k + 1) + ";"; }
  }
  throw new Error("unbalanced const " + name);
}
function breakOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`teeth "${label}": anchor not found exactly once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}

const FNS = [
  "escapeHtml", "cashFoldKey", "cashFoldHtml", "cashChipsHtml", "wcIsoDay",
  "arSeriesInfo", "arYearLabel", "arPeriodLabel", "arFmt", "arAsOf", "arPlotHtml", "arTipParts", "wireAttendanceRateHover",
  "loadAttendanceRate", "attGroupsAllowed", "attGroupChartsAllowed",
  "grLook", "grLinesChecked", "grOptionLabel", "grBuiltAt", "grMisrecordAt", "grControlsHtml", "grGapSentence", "grAnswerText",
  "grMedianNote", "renderAttendanceGroupBody", "grFoldsHtml", "grTipParts", "grFailure", "grLoadList", "grAsk", "grSay",
  "renderAttendanceGroupChart", "grRememberGroup", "grRememberedGroup", "setAttendanceGroup", "setAttendanceGroupPolicy",
  "toggleAttendanceGroupGhost", "dropAttendanceGroupCache", "forgetAttendanceGroupChart", "groupChartSheetHtml",
  "groupChartSheetOpen", "openGroupChartSheet", "groupChartBeforePrint", "printGroupChartSheet", "beginGroupChartPrint",
  "endGroupChartPrint", "closeGroupChartSheet", "loadAttendanceSubgroups", "renderAttendanceSubgroups", "drawAttendanceView",
  "wipeAttendanceViews", "wcForgetTab",
];
const CONSTS = ["AR_SERIES", "AR_POLICY_WORDS", "GR_WITHHELD_WORDS", "GR_KEEP_MS"];

/** A fake element: enough of the DOM for these functions. */
function el(id, page) {
  const attrs = new Map();
  const cls = new Set();
  const listeners = {};
  const e = {
    id, innerHTML: "", textContent: "", hidden: false, focused: 0, style: {}, value: "",
    setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, listeners,
    focus() { e.focused++; page.focused = e.id || e.sel; },
    remove() { page.removed(e); },
    querySelector: (sel) => page.inside(e, sel),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
  return e;
}
/** A page: the ids index.html has, a body, sessionStorage and the network. */
function makePage({ staff, w, src = scriptSrc, chronic = null, storage = new Map(), riskSettings = { misrecordAt: 1 } }) {
  const calls = [];
  const page = { calls, storage, focused: null };
  const ids = {};
  const fixed = ["attGroupCard", "attGroupBody", "attGroupAnswer", "attGroupPrint", "attSubgroupCard", "attSubgroupBody", "attSubgroupView",
    "attYearTable", "attWinTable", "attPerfectBody", "attYearSearch", "attWinSearch", "attPerfectSearch"];
  for (const id of fixed) {
    if (!new RegExp(`\\bid="${id}"`).test(html)) throw new Error("index.html has no #" + id);
    ids[id] = el(id, page);
  }
  ids.attSubgroupCard.hidden = /<div id="attSubgroupCard" hidden>/.test(html);
  const body = el("body", page);
  body.children = [];
  body.appendChild = (c) => { body.children.push(c); ids[c.id] = c; };
  page.removed = (c) => { body.children = body.children.filter((x) => x !== c); if (ids[c.id] === c) delete ids[c.id]; };
  // Elements drawn by innerHTML: found while their markup is there.
  const drawn = {};
  page.inside = (host, sel) => {
    const m = /^\[data-grpolicy="(\w+)"\]$/.exec(sel);
    const key = host.id + "|" + sel;
    const present = sel === ".wc-rc-tip" ? host.innerHTML.includes("wc-rc-tip")
      : sel === ".wc-ar-plot" ? host.innerHTML.includes("wc-ar-plot")
      : sel === "[data-gr-sheet]" ? host.innerHTML.includes("data-gr-sheet")
      : m ? host.innerHTML.includes(`data-grpolicy="${m[1]}"`) : false;
    if (!present) return null;
    return drawn[key] || (drawn[key] = Object.assign(el("", page), { sel }));
  };
  const document = {
    title: "Wildcat Hub",
    body,
    getElementById: (id) => {
      if (id === "attGroupSelect" || id === "attGroupGhost") {
        if (!ids.attGroupBody.innerHTML.includes(`id="${id}"`)) return null;
        return drawn[id] || (drawn[id] = el(id, page));
      }
      return ids[id] || null;
    },
    createElement: () => el("", page),
  };
  const winListeners = {};
  const window = {
    WildcatRoster: R, WildcatDiscipline: D,
    sessionStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    addEventListener: (t, f) => { (winListeners[t] ||= new Set()).add(f); },
    removeEventListener: (t, f) => { winListeners[t] && winListeners[t].delete(f); },
    print: () => { page.printed = (page.printed || 0) + 1; },
    WildcatAuth: {
      getSession: () => (staff ? { idToken: "t" } : null),
      convexQuery: async (name, args) => {
        calls.push({ name, args: JSON.parse(JSON.stringify(args || {})) });
        if (name === "attendanceRunChartData:series") return JSON.parse(JSON.stringify(w.series));
        if (name === "attendanceGroupRunChart:groupWeeks") return serverAsk(w.tables, staff, args);
        if (name === "attendanceSubgroups:chronicBySubgroup") return chronic || { allowed: true, rows: [], baseline: {}, schoolDays: 39, unavailable: [] };
        throw new Error("Could not find public function for '" + name + "'");
      },
    },
  };
  page.winListeners = winListeners;
  const user = staff ? { id: staff.email, role: staff.role, attendanceWatch: staff.attendanceWatch } : null;
  page.G = { user, riskSettings, alerts: [] };
  const app = new Function("document", "window", "G", `
    const console = { log() {}, warn() {}, error() {} };
    const Date = (function (Real, now) {
      return class extends Real { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } };
    })(globalThis.Date, ${new Date(2026, 9, 12, 10, 0).getTime()});
    let currentUser = G.user;
    let riskSettings = G.riskSettings;
    var WC_VIEW_KEY = 'wc_view_tab', WC_CASH_VIEW_KEY = 'wcCashAnalyticsView', WC_ATT_VIEW_KEY = 'wcAttendanceView', WC_ATT_GROUP_KEY = 'wcAttGroup';
    const _cashOpenFolds = new Set();
    let _arCache = null, _arCacheAt = 0, _arPolicy = 'merge', _arGhost = true, _arModel = null;
    let _grGroup = null, _grGhost = true, _grList = null, _grModel = null, _grShown = null, _grSeq = 0, _grFocus = null, _grPrintDone = null;
    const _grAnswers = new Map();
    let _sgCache = null, _sgBusy = false, _attView = 'subgroup';
    let _attYearBand, _attYearKind, _attYearRosterOnly, _attYearAll, _attGradeFilter, _attWindow, _attWinBand, _attWinKind, _attWinAll, _paWindow, _paMonth;
    const SG_DEAD_BAND = 1.5;
    function showAlert(m) { G.alerts.push(m); }
    function closePerfectAttendanceSheet() { G.closedOthers = (G.closedOthers || 0) + 1; }
    function closeReflectionSheet() {}
    function attendanceSchoolDays() { return { known: true, days: 39 }; }
    async function loadAttendanceRows() {}
    function attDaysRange() { return 'Aug 12 to today'; }
    function wcClockAt(s) { return String(s); }
    async function ensureSchoolCalendar() {}
    function fetchAttendanceRebuildHealth() { return Promise.resolve(); }
    function renderAttDataLine() {}
    async function renderPerfectAttendance() {}
    async function renderAttendanceRate() {}
    async function renderAbsenceRunChart() {}
    async function renderAttendanceWindow() {}
    async function renderAttendanceWatch() {}
    ${CONSTS.map((n) => liftConst(src, n)).join("\n")}
    ${FNS.map((n) => liftFn(src, n)).join("\n")}
    return {
      ${FNS.join(", ")},
      signIn(u) { currentUser = u; },
      setSettings(s) { riskSettings = s; },
      get state() { return { _grGroup, _grGhost, _grList, _grModel, _grShown, answers: _grAnswers.size, _arPolicy, _sgCache, _attView }; },
    };`)(document, window, page.G);
  return Object.assign(page, { app, document, window, ids, user });
}
const groupCalls = (page) => page.calls.filter((c) => c.name === "attendanceGroupRunChart:groupWeeks");
const optionsOf = (host) => [...host.innerHTML.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
const W = world();

// ===========================================================================
console.log("\nA. THE WHOLE-SCHOOL LINE IS TRENDS' LINE, VALUE FOR VALUE\n");
// ===========================================================================
{
  let same = 0, total = 0;
  const off = [];
  for (const policy of ["merge", "separate", "drop"]) for (const misrecordAt of [0, 1, 2, 3, 5]) {
    const o = opts(policy, misrecordAt);
    const trends = R.runRateModel(W.series, { measure: "weeklyRate", policy, series: ["all", "6-8", "9-12"], settings: o.settings, today: TODAY, candidate: null });
    const ask = R.runGroupAsk(W.series, o);
    const answer = await serverAsk(W.tables, ADMIN, { group: "gender:F", periods: ask.periods, misrecordAt });
    const m = R.runGroupRateModel(W.series, answer, Object.assign({ group: "gender:F" }, o));
    const t = trends.series.find((s) => s.series === "all").points;
    for (const p of m.reference.points) {
      total++;
      const q = t.find((x) => x.key === p.key);
      if (q && q.value === p.value && q.from === p.from && q.to === p.to) same++; else off.push(`${policy}/${misrecordAt} ${p.key}`);
    }
    if (m.reference.points.length !== t.length) off.push(`${policy}/${misrecordAt}: ${m.reference.points.length} of ${t.length} points`);
  }
  check(`the card's whole school equals Trends' whole-school line: ${total} weekly points, thresholds 0-5, merged, separate and left off`,
    same === total && total > 200 && !off.length, off.slice(0, 3).join("; "));
  // The weeks are Trends' weeks: every group point is a Trends point's stretch of days.
  const o = opts("merge");
  const ask = R.runGroupAsk(W.series, o);
  const groups = R.runWeekGroups(R.runSeriesDays(W.series.days, "all", o.settings), "merge", TODAY);
  check("the periods asked for are Trends' week groups, named by their Mondays (the first week of the year merged into the next)",
    JSON.stringify(ask.periods) === JSON.stringify(groups.map((g) => g.parts.map((p) => p.week)))
      && ask.periods.some((p) => p.length === 2 && p[0] === "2026-08-10"), JSON.stringify(ask.periods.slice(0, 2)));
  // A GROUP THAT IS THE WHOLE SCHOOL reads exactly the dashed line, end to end:
  // the browser's weeks, the server's rates, the browser's model.
  const all = world({ tweak: (d, c) => { c.F += c.M + c.gnone; c.M = 0; c.gnone = 0; } });
  // Its Trends rows are its group rows, with misrecorded days so the threshold matters.
  let k = 0;
  for (const r of all.tables.attendanceRunGroupDays) {
    if (r.axis === "gender" && r.group === "F") { k++; r.misrecordDaysByGap = [k % 3, k % 2, 0]; r.absentDays = r.fullDaysStrict + (k % 3) + (k % 2) + (k % 4); r.partialDays = k % 4; }
  }
  all.tables.attendanceRunDays = all.tables.attendanceRunGroupDays.filter((r) => r.axis === "gender" && r.group === "F")
    .map((r) => ({ ...r, band: "6-8", gradeEstimated: false }));
  all.series = { allowed: true, days: all.tables.attendanceRunDays, months: [], baselines: [], annotations: [] };
  let eq = 0, n = 0;
  const bad = [];
  for (const policy of ["merge", "separate"]) for (const misrecordAt of [0, 1, 2, 3]) {
    const o2 = opts(policy, misrecordAt);
    const a2 = R.runGroupAsk(all.series, o2);
    const res = await serverAsk(all.tables, ADMIN, { group: "gender:F", periods: a2.periods, misrecordAt });
    const m = R.runGroupRateModel(all.series, res, Object.assign({ group: "gender:F" }, o2));
    for (const p of m.reference.points) {
      n++;
      const g = m.series[0].points.find((q) => q.key === p.key);
      const held = m.withheld.find((q) => q.key === p.key);
      if ((g && g.value === p.value) || (held && held.why === "few-days" && p.schoolDays < 2)) eq++; else bad.push(`${policy}/${misrecordAt} ${p.key}: ${g && g.value} vs ${p.value}`);
    }
  }
  check(`a group that is the whole school sits exactly on the dashed line: ${n} points, thresholds 0-3, merged and separate`,
    eq === n && n > 80, bad.slice(0, 3).join("; "));
  check("the screen draws the dashed line from the model's reference (Trends), never from a group answer",
    /refs: \[\{ label: 'Whole school', cls: 'wc-ar-all', points: model\.reference\.points \}\]/.test(liftFn(scriptSrc, "renderAttendanceGroupBody"))
      && /refs: \[\{ label: 'Whole school', cls: 'wc-ar-all', points: m\.reference\.points \}\]/.test(liftFn(scriptSrc, "groupChartSheetHtml")));
  check("...and reads the Trends rows Trends reads (the same copy, the same query), never a copy of its own",
    /let res = _arCache;/.test(liftFn(scriptSrc, "renderAttendanceGroupChart")) && /res = await loadAttendanceRate\(true\);/.test(liftFn(scriptSrc, "renderAttendanceGroupChart")));
  // Short weeks follow Trends' own setting.
  const p = makePage({ staff: ADMIN, w: W });
  await p.app.renderAttendanceGroupChart(false);
  await p.app.setAttendanceGroupPolicy("separate");
  // The main ask (it reaches this year); the last-year ask is all 2025.
  const sent = groupCalls(p).filter((c) => c.args.group && c.args.periods.some((x) => x[0] >= "2026-08-01")).pop();
  const sepGroups = R.runWeekGroups(R.runSeriesDays(W.series.days, "all", { misrecordAt: 1 }), "separate", TODAY);
  check("the short-week pills ARE Trends' setting (_arPolicy), and the periods sent follow it",
    p.app.state._arPolicy === "separate" && JSON.stringify(sent.args.periods) === JSON.stringify(sepGroups.map((g) => g.parts.map((x) => x.week)))
      && /aria-pressed="true" onclick="setAttendanceGroupPolicy\('separate'\)"/.test(p.ids.attGroupBody.innerHTML));
  check("...and focus goes back to the pill that was pressed", p.focused === '[data-grpolicy="separate"]', String(p.focused));
}

// ===========================================================================
console.log("\nB. EVERY ASK IS ONE THE SERVER ACCEPTS\n");
// ===========================================================================
{
  const odd = [];
  for (const policy of ["merge", "separate", "drop"]) for (const ghost of [false, true]) {
    const o = opts(policy);
    const ask = R.runGroupAsk(W.series, o);
    const periods = ghost ? ask.ghost : ask.periods;
    const res = await serverAsk(W.tables, ADMIN, { group: "gender:F", periods, misrecordAt: 1 });
    if (res.invalid || res.refused || res.periods.length !== periods.length) odd.push(`${policy}/${ghost ? "ghost" : "main"}: ${res.invalid || res.refused || res.periods.length}`);
    const mondays = periods.flat();
    if (new Set(mondays).size !== mondays.length) odd.push(`${policy}: a Monday twice`);
    if (periods.some((x) => x.length > R.GROUP_MAX_PERIOD_WEEKS)) odd.push(`${policy}: a period over 4 weeks`);
  }
  check("every policy's periods, and every 'same week last year' ask, are accepted: no Monday twice, none over 4 weeks", !odd.length, odd.join("; "));
  const ask = R.runGroupAsk(W.series, opts());
  check("the last-year ask is this year's weeks moved back 364 days, Monday to Monday (as runLastYearWeekly reads)",
    ask.ghost.length > 0 && ask.ghost.every((x) => new Date(x[0] + "T00:00:00Z").getUTCDay() === 1)
      && ask.ghost[1][0] === addDays(ask.periods.find((x) => x[0] >= "2026-08-17")[0], -364), JSON.stringify(ask.ghost.slice(0, 2)));
  check("the two are separate asks: no Monday is in both a main and a last-year period of one call",
    /answer = await grAsk\(chosen\.id, ask\.periods, mr, force === true\);/.test(scriptSrc) && /ghost = await grAsk\(chosen\.id, ask\.ghost, mr, force === true\);/.test(scriptSrc));
  check("only this year and last are asked for (no third year)", ask.periods.flat().every((m) => m >= "2025-08-01"));
  // The group's last-year line matches the group's own rows, the way Trends' does its.
  const m = R.runGroupRateModel(W.series, await serverAsk(W.tables, ADMIN, { group: "gender:F", periods: ask.periods, misrecordAt: 1 }),
    Object.assign({ group: "gender:F", ghost: await serverAsk(W.tables, ADMIN, { group: "gender:F", periods: ask.ghost, misrecordAt: 1 }) }, opts()));
  const fRows = W.tables.attendanceRunGroupDays.filter((r) => r.axis === "gender" && r.group === "F").map((r) => ({ ...r, band: "x" }));
  const expect = R.runLastYearWeekly(fRows, "all", m.series[0].points, { misrecordAt: 1 }, 36);
  check("the group's 'same week last year' points equal runLastYearWeekly over the group's own rows",
    m.series[0].lastYear.filter(Boolean).length > 3 && m.series[0].lastYear.every((g, i) => (g ? g.value : null) === (expect[i] ? expect[i].value : null)),
    JSON.stringify(m.series[0].lastYear.slice(0, 3)) + " vs " + JSON.stringify(expect.slice(0, 3)));
  // The misrecord threshold reaches the server as a number, or not at all.
  const p = makePage({ staff: ADMIN, w: W, riskSettings: { misrecordAt: "2" } });
  await p.app.renderAttendanceGroupChart(false);
  const q = makePage({ staff: ADMIN, w: W, riskSettings: { misrecordAt: 3 } });
  await q.app.renderAttendanceGroupChart(false);
  check("the screen's threshold is sent as a number; a non-number is not sent (Convex would refuse the call)",
    groupCalls(p).filter((c) => c.args.group).every((c) => !("misrecordAt" in c.args))
      && groupCalls(q).filter((c) => c.args.group).every((c) => c.args.misrecordAt === 3)
      && /<svg/.test(p.ids.attGroupBody.innerHTML));
}

// ===========================================================================
console.log("\nC. WHO SEES WHICH LINE, AND WHO SEES THE TABLE\n");
// ===========================================================================
{
  const drawTab = async (staff) => {
    const p = makePage({ staff, w: W });
    await p.app.drawAttendanceView(false);
    return p;
  };
  const admin = await drawTab(ADMIN);
  const listed = (await serverAsk(W.tables, ADMIN, {})).groups.map((g) => g.id);
  check("admin: the drop-down is exactly the server's list (Female, Male, Black, Current EL, Not EL, EO, RFEP, the classification's EL)",
    JSON.stringify(optionsOf(admin.ids.attGroupBody)) === JSON.stringify(listed) && listed.includes("race:black") && listed.length === 8,
    optionsOf(admin.ids.attGroupBody).join(","));
  check("...grouped by type, the small group and the shared line said in the option",
    /<optgroup label="Race or ethnicity"><option value="race:black">Black or African American \(small group\)<\/option>/.test(admin.ids.attGroupBody.innerHTML)
      && /English Learner \(the same line as Current English Learner\)/.test(admin.ids.attGroupBody.innerHTML));
  check("...and the year-to-date table is asked for and shown", admin.calls.some((c) => c.name === "attendanceSubgroups:chronicBySubgroup")
    && admin.ids.attSubgroupCard.hidden === false);
  const sup = await drawTab(SUPER);
  check("superadmin: the same list as admin", JSON.stringify(optionsOf(sup.ids.attGroupBody)) === JSON.stringify(listed));
  const pbis = await drawTab(PBIS);
  check("PBIS: no race line in the drop-down at all, and told why in the 'not charted' fold",
    optionsOf(pbis.ids.attGroupBody).length === 7 && !optionsOf(pbis.ids.attGroupBody).some((id) => id.startsWith("race:"))
      && /Race lines are shown to administrators only/.test(pbis.ids.attGroupBody.innerHTML));
  const grant = await drawTab(GRANT);
  check("the Attendance Watch grant: Female and Male only",
    JSON.stringify(optionsOf(grant.ids.attGroupBody)) === JSON.stringify(["gender:F", "gender:M"]) && /<svg/.test(grant.ids.attGroupBody.innerHTML));
  check("...the year-to-date table is never asked for, never drawn, and its wrapper stays hidden",
    !grant.calls.some((c) => c.name === "attendanceSubgroups:chronicBySubgroup")
      && grant.ids.attSubgroupBody.innerHTML === "" && grant.ids.attSubgroupCard.hidden === true);
  check("...and every group ask it makes is for Female or Male",
    groupCalls(grant).every((c) => !c.args.group || c.args.group.startsWith("gender:")));
  // A grant holder whose tab asks for a line she does not have is refused by
  // the server, and the screen says so rather than drawing it.
  grant.storage.set("wcAttGroup", JSON.stringify({ who: GRANT.email, group: "race:black" }));
  const g2 = makePage({ staff: GRANT, w: W, storage: grant.storage });
  await g2.app.renderAttendanceGroupChart(false);
  check("...a remembered group she was never given is ignored: the server's list decides",
    g2.app.state._grGroup === "gender:F" && groupCalls(g2).every((c) => !c.args.group || c.args.group === "gender:F"));
  const refusedLine = await serverAsk(W.tables, GRANT, { group: "race:black", periods: [["2026-09-14"]] });
  check("...and the server refuses it anyway (no periods)", typeof refusedLine.refused === "string" && refusedLine.periods.length === 0);
  const teacher = await drawTab(TEACHER);
  check("a teacher without the grant: the card is hidden and nothing is asked for", teacher.ids.attGroupCard.hidden === true
    && teacher.calls.length === 0 && teacher.ids.attGroupBody.innerHTML === "");
  check("'\"true\"' is no grant: hidden, nothing asked",
    await (async () => { const t = await drawTab({ role: "campusaide", email: "c@x", attendanceWatch: "true" }); return t.ids.attGroupCard.hidden === true && t.calls.length === 0; })());
  // TEETH: drawn from a local list instead of the server's, PBIS would get Black.
  const local = breakOnce(scriptSrc, "            const groups = (list && list.groups) || [];\n            const types = [];",
    "            const groups = ((list && list.groups) || []).concat([{ id: 'race:black', type: 'race', typeLabel: 'Race or ethnicity', label: 'Black or African American', size: 45, small: true }]);\n            const types = [];", "local list");
  const lp = makePage({ staff: PBIS, w: W, src: local });
  await lp.app.renderAttendanceGroupChart(false);
  check("TEETH: a drop-down built from anything but the server's list is caught (PBIS would be offered Black)",
    optionsOf(lp.ids.attGroupBody).includes("race:black"));
  // TEETH: the renderer's table gate dropped, the grant would see the table's
  // card; both gates dropped, the server would be asked for it.
  const drawGate = ["            if (!attGroupsAllowed()) {\n                if (tableWrap) tableWrap.hidden = true;", "            if (false) {\n                if (tableWrap) tableWrap.hidden = true;"];
  const loadGate = ["            if (!attGroupsAllowed()) {\n                return { allowed: false, rows: [], reason:", "            if (false) {\n                return { allowed: false, rows: [], reason:"];
  const open = breakOnce(scriptSrc, drawGate[0], drawGate[1], "table gate");
  const op = makePage({ staff: GRANT, w: W, src: open });
  await op.app.drawAttendanceView(false);
  check("TEETH: without the renderer's gate the grant would be shown the table's card", op.ids.attSubgroupCard.hidden === false);
  const both = breakOnce(open, loadGate[0], loadGate[1], "loader gate");
  const bp = makePage({ staff: GRANT, w: W, src: both });
  await bp.app.drawAttendanceView(false);
  check("TEETH: without both gates the grant's tab would ask the server for the table",
    bp.calls.some((c) => c.name === "attendanceSubgroups:chronicBySubgroup"));
}

// ===========================================================================
console.log("\nD. THE WORDS: STATUS FIRST, THE REST OF THE SCHOOL, WORTH A LOOK, HOW MANY CHECKED\n");
// ===========================================================================
{
  // Female's absence climbs three points a week from late August: a run
  // going down (or, with more weeks, a shift below its median).
  const weekNo = (date) => Math.floor((Date.parse(date + "T00:00:00Z") - Date.parse("2026-08-17T00:00:00Z")) / (7 * 86400000));
  const shifted = world({ bump: (cell, date) => (cell === "F" && date >= "2026-08-17" ? 0.03 * weekNo(date) : 0) });
  const p = makePage({ staff: ADMIN, w: shifted });
  await p.app.renderAttendanceGroupChart(false);
  const ans = p.ids.attGroupAnswer.textContent;
  check("the answer LEADS with the group's run-chart status, then the gap",
    /^Female: \d+ weeks in a row (below its median|going down)\. Worth a look, not a finding\. Over the \d+ weeks of 2026–27 on the chart it averaged \d+\.\d points below the rest of the school\.$/.test(ans), ans);
  const res = await serverAsk(shifted.tables, ADMIN, { group: "gender:F", periods: R.runGroupAsk(shifted.series, opts()).periods, misrecordAt: 1 });
  check("...the gap is the server's REST-of-school average over this year's weeks (not the whole, which contains the group)",
    ans.includes(Math.abs(res.vsRest.points).toFixed(1) + " points below the rest of the school") && res.vsRest.yearid === 36);
  const body = p.ids.attGroupBody.innerHTML;
  check("every signal under the chart is 'worth a look, not a finding', in grey, and says how many lines can be checked",
    /class="wc-rc-signal wc-gr-look"/.test(body) && !/class="wc-rc-signal wc-rc-shift"/.test(body)
      && /Worth a look, not a finding: 7 lines can be checked here, and with that many one is likely to show a signal by chance/.test(body));
  check("...and the reading says it again even with no signal (how many lines; a signal is worth a look)",
    await (async () => { const q = makePage({ staff: ADMIN, w: W }); await q.app.renderAttendanceGroupChart(false);
      return /7 lines can be checked here\. With that many, a signal on one of them by chance alone is likely/.test(q.ids.attGroupBody.innerHTML)
        && /no signal|No signal/.test(q.ids.attGroupAnswer.textContent + q.ids.attGroupBody.innerHTML); })());
  check("the count is of LINES: the classification's EL (the same line) is not counted twice", R && (() => {
    const list = { groups: [{ id: "a" }, { id: "b", sameAs: "a" }, { id: "c" }] };
    return p.app.grLinesChecked(list) === 2; })());
  check("an admin is told 7 lines (8 menu entries, one line shared); PBIS 6; the grant 2", await (async () => {
    const q = makePage({ staff: PBIS, w: W }); await q.app.renderAttendanceGroupChart(false);
    const g = makePage({ staff: GRANT, w: W }); await g.app.renderAttendanceGroupChart(false);
    return /6 lines can be checked here/.test(q.ids.attGroupBody.innerHTML) && /2 lines can be checked here/.test(g.ids.attGroupBody.innerHTML); })());
  // A SMALL GROUP (Black, about 45): whether the gap is within chance for a
  // group this size is the SERVER's verdict, which counts who happens to be
  // in a group that size as well as how its weeks wobble.
  const spreadW = world();
  spreadW.tables.attendanceRunGroupMonths = ["2026-08", "2026-09", "2026-10"].map((month) =>
    ({ yearid: 36, month, built: [], skipped: [], updatedAt: SYNC, rateVar: 0.0096 }));
  const small = makePage({ staff: ADMIN, w: spreadW });
  await small.app.renderAttendanceGroupChart(false);
  await small.app.setAttendanceGroup("race:black");
  const sAns = small.ids.attGroupAnswer.textContent;
  const sm = small.app.state._grModel;
  check("a small group's answer says whether the gap is within chance for a group this size -- the server's verdict, said as given",
    sm.vsRest && typeof sm.vsRest.withinChance === "boolean" && (sm.vsRest.withinChance ? /within chance for a group this size\.$/.test(sAns)
      : /more than chance usually gives a group this size: worth a look, not a finding\.$/.test(sAns)), sAns);
  const say = (withinChance) => small.app.grGapSentence({ vsRest: { yearid: 36, periods: 8, points: -2.2, withinChance } }, { small: true });
  check("...each verdict in its own words, and no verdict (under 3 weeks, or no spread built yet) says it is too soon",
    /within chance for a group this size\.$/.test(say(true)) && /more than chance usually gives a group this size/.test(say(false))
      && /too soon to tell that from chance\.$/.test(say(null)) && !/weeks usually vary/.test(liftFn(scriptSrc, "grGapSentence")));
  check("...and the browser computes no chance test of its own (the old one counted only the weekly wobble)",
    typeof R.runGapSpread === "undefined" && !/gapSpread/.test(rosterSrc));
  // A NEW YEAR: a gap the server averaged over another year is never quoted as this year's.
  const other = R.runGroupRateModel(W.series, { periods: [], vsRest: { yearid: 35, periods: 42, points: -3.6, withinChance: null } },
    Object.assign({ group: "race:black", ghost: null }, opts()));
  check("a gap for any year but the one the chart reads is dropped, so no sentence quotes it",
    other.vsRest === null && small.app.grGapSentence(other, { small: true }) === "");
  check("a large group never gets the chance clause (it is for small groups)", !/chance/.test(ans.split(". Over")[1] || ""));
  check("the small group's reading says it can move with one or two students, and its line is never coloured",
    /A small group: about 45 students on a typical school day\. Its line is never coloured, because a group this size can move with one or two students\./.test(small.ids.attGroupBody.innerHTML));
}

// ===========================================================================
console.log("\nD. NEVER-COLOURED SMALL GROUPS, LABELS, COUNTDOWN, THE RECALCULATED MEDIAN\n");
// ===========================================================================
{
  const p = makePage({ staff: ADMIN, w: W });
  await p.app.renderAttendanceGroupChart(false);
  const big = p.ids.attGroupBody.innerHTML;
  await p.app.setAttendanceGroup("race:black");
  const small = p.ids.attGroupBody.innerHTML;
  check("a group of 60 or more is drawn in its colour (wc-gr-grp)", /class="wc-ar-line wc-gr-grp"/.test(big) && !/wc-gr-plain/.test(big));
  check("a small group is drawn grey (wc-gr-small) with grey rings: never coloured",
    /class="wc-ar-line wc-gr-small"/.test(small) && !/wc-gr-grp/.test(small) && /wc-ar-plot wc-gr-plot wc-gr-plain/.test(small)
      && /\.wc-gr-small \{ --ar: #6b7280; \}/.test(css) && /\.wc-gr-plain \.wc-ar-astro \{ stroke: #6b7280; \}/.test(css));
  check("the whole school is a thin dashed reference with no median of its own",
    /class="wc-ar-refline wc-ar-all"/.test(big) && !/wc-ar-median[^"]*wc-ar-all/.test(big)
      && /\.wc-ar-refline \{[^}]*stroke-dasharray: 6 4/.test(css));
  check("the legend says it is Trends' line, read there", /Whole school<\/strong> the same line as Trends, drawn for reference; its median and signals are read there/.test(big));
  const tSmall = breakOnce(scriptSrc, "cls: chosen && chosen.small ? 'wc-gr-small' : 'wc-gr-grp'", "cls: 'wc-gr-grp'", "colour");
  const tp = makePage({ staff: ADMIN, w: W, src: tSmall });
  await tp.app.renderAttendanceGroupChart(false);
  await tp.app.setAttendanceGroup("race:black");
  check("TEETH: a small group drawn in colour is caught", /class="wc-ar-line wc-gr-grp"/.test(tp.ids.attGroupBody.innerHTML));

  // LABELS (item 14): the chart says what it counts; so does the table.
  const card = html.slice(html.indexOf('<div id="attGroupCard">'), html.indexOf('<div id="attSubgroupCard"'));
  check("the chart card says: weekly, whole days only, includes students who have left",
    /Week by week &middot; this school year and last/.test(card) && /whole days only &middot; includes students who have left/.test(card));
  check("...and its 'how counted' fold says a part day counts as attended, leavers are in, and the table counts differently",
    /A day missing only some periods counts as attended\. The year-to-date table counts any missed period instead/.test(big)
      && /includes students who have since left, for the weeks they were enrolled; the table counts students enrolled today/.test(big));
  check("the table says: year to date, any missed period, students enrolled today",
    /'Year to date \\u00b7 ' \+ attDaysRange\(basis\)/.test(liftFn(scriptSrc, "renderAttendanceSubgroups"))
      && /'any missed period counts \\u00b7 students enrolled today'/.test(liftFn(scriptSrc, "renderAttendanceSubgroups")));
  check("English Learner lines say they use each student's status on each date", /status on each date, from PowerSchool’s history/.test(big));

  // THE COUNTDOWN: 8 finished weeks this year (the 3-day first week merged).
  const m = p.app.state._grModel;
  check("the provisional countdown: this year's weeks, how many more, and roughly when",
    /2026–27 has \d+ finished weeks\. Until it has 10 \(about \d+ more, around October \d+\), the group’s middle line is provisional/.test(big),
    (big.match(/wc-ar-countdown">([^<]+)/) || [])[1]);
  void m;
  // THE WHOLE SCHOOL FROZEN: the group's own median over those weeks, recalculated.
  const frozen = world({ baselines: [{ id: "b", measure: "weeklyRate", series: "all", from: "2026-08-10", to: "2026-10-05", median: 50, points: 8 }] });
  const f = makePage({ staff: ADMIN, w: frozen });
  await f.app.renderAttendanceGroupChart(false);
  const fm = f.app.state._grModel;
  const own = R.runChartMedian(fm.series[0].points.filter((x) => x.from >= "2026-08-10" && x.from <= "2026-10-05").map((x) => x.value));
  check("with the whole school's median frozen, the group's middle line is its OWN median over those weeks (not the school's 50.0)",
    fm.series[0].analysis.median === own && own > 80 && fm.series[0].baseline.recalculated === true);
  check("...and the screen says it is recalculated, not frozen",
    /its OWN median over those same weeks/.test(f.ids.attGroupBody.innerHTML) && /recalculated every time the chart is drawn, not frozen/.test(f.ids.attGroupBody.innerHTML));
  check("...no group median is stored or frozen anywhere: no freeze button on the card, no group key sent to a freeze",
    !/freezeAttendanceBaseline|Freeze this median|Unfreeze/.test(big + f.ids.attGroupBody.innerHTML)
      && !/attendanceRunChartData:freezeBaseline/.test(liftFn(scriptSrc, "renderAttendanceGroupChart")));
}

// ===========================================================================
console.log("\nD. A WITHHELD WEEK IS A GAP, AND A LINE THAT IS ALL GAP IS SAID IN WORDS\n");
// ===========================================================================
{
  // 3 students outside F/M on one day of the week of 09-14: Female (smaller) withheld that week.
  const w = world({ tweak: (d, c) => { if (d === "2026-09-16") { c.gnone = 3; c.F -= 3; } } });
  const p = makePage({ staff: ADMIN, w });
  await p.app.renderAttendanceGroupChart(false);
  const m = p.app.state._grModel;
  const held = m.withheld.find((x) => x.key === "2026-09-14");
  check("the withheld week is a gap in the model, never a zero", held && held.why === "small" && !m.series[0].points.some((x) => x.key === "2026-09-14"));
  const path = (p.ids.attGroupBody.innerHTML.match(/<path d="([^"]+)" class="wc-ar-line wc-gr-grp"\/>/) || [])[1] || "";
  check("...the line breaks there instead of joining across it", (path.match(/M/g) || []).length >= 3, path.slice(0, 60));
  const said = (p.ids.attGroupBody.innerHTML.match(/1 week is not on this line: [^<]+/) || [""])[0];
  check("...and the reading says how many weeks are not shown and why, without naming the pool",
    /this line set against the whole school could have singled out a small group of students \(fewer than 10 on one of its school days/.test(said)
      && !/gender|female|male|neither|outside/i.test(said), said);
  // EVERY week withheld (a pool of 3 outside F/M every Wednesday, so not on a
  // typical day): words, not an empty chart.
  const wed = (d) => new Date(d + "T00:00:00Z").getUTCDay() === 3;
  const all = world({ tweak: (d, c) => { if (wed(d)) { c.gnone = 3; c.F -= 3; } } });
  const g = makePage({ staff: GRANT, w: all });
  await g.app.renderAttendanceGroupChart(false);
  check("a line held back on most days is a plain explanation, not an empty chart (the grant's gender case)",
    !/<svg/.test(g.ids.attGroupBody.innerHTML) && /Female cannot be drawn: on most school days, this line set against the whole school could single out a handful of students/.test(g.ids.attGroupBody.innerHTML)
      && /nothing needs doing/.test(g.ids.attGroupBody.innerHTML) && g.ids.attGroupAnswer.textContent === "Female: not shown for most weeks.");
  check("...and Male, the larger, is still drawn for her", await (async () => { await g.app.setAttendanceGroup("gender:M"); return /<svg/.test(g.ids.attGroupBody.innerHTML); })());
  // MOST of this year held back, a few weeks drawable: the chart, with the words first.
  const most = world({ tweak: (d, c) => { if (d >= "2026-08-24" && d <= "2026-09-25" && wed(d)) { c.gnone = 3; c.F -= 3; } } });
  const mp = makePage({ staff: GRANT, w: most });
  await mp.app.renderAttendanceGroupChart(false);
  const mh = mp.ids.attGroupBody.innerHTML;
  check("most of this year held back but some weeks drawable: the chart, with a plain explanation above it",
    /<svg/.test(mh) && /Most of this year’s weeks of Female cannot be shown/.test(mh) && mh.indexOf("Most of this year") < mh.indexOf("<svg"));
  const few = makePage({ staff: GRANT, w: world({ tweak: (d, c) => { if (d === "2026-09-16") { c.gnone = 3; c.F -= 3; } } }) });
  await few.app.renderAttendanceGroupChart(false);
  check("...and one week held back draws no such box (the reading's sentence says it)", !/Most of this year/.test(few.ids.attGroupBody.innerHTML));
  // 3 STUDENTS OUTSIDE F/M ON A TYPICAL DAY: whole - Female - Male is those
  // 3 all year, so Female (the smaller) is not offered at all -- the grant is
  // shown Male, and told in words why Female is not there (review, 2026-10-12).
  const pool = makePage({ staff: GRANT, w: world({ tweak: (d, c) => { c.gnone = 3; c.F -= 3; } }) });
  await pool.app.renderAttendanceGroupChart(false);
  const ph = pool.ids.attGroupBody.innerHTML;
  check("3 outside F/M on a typical day: the grant is offered Male only, drawn, and the 'not charted' fold says why Female is not",
    optionsOf(pool.ids.attGroupBody).join(",") === "gender:M" && /<svg/.test(ph)
      && /<strong>Female<\/strong><div class="wc-sub">Drawn beside the other lines of its kind and the whole school, it would let a group of fewer than 30 students be worked out by subtraction/.test(ph));
  check("...and the 'how counted' fold says the floor of 30 covers what can be worked out, not only what is drawn",
    /cannot work out a group of fewer than 30\. A week is shown only once it is over, when it has at least 2 school days/.test(ph));
  // A WEEK A BUILD COULD STILL ADD A DAY TO: September's last build stopped at 9/29.
  const edge = world();
  for (const t of [edge.tables.attendanceRunDays, edge.tables.attendanceRunGroupDays]) {
    for (let i = t.length - 1; i >= 0; i--) {
      if (t[i].date === "2026-09-30") t.splice(i, 1);
      else if (t[i].date.startsWith("2026-09")) t[i] = { ...t[i], syncedAt: "2026-09-30T10:15:00.000Z" };
    }
  }
  const ep = makePage({ staff: ADMIN, w: edge });
  await ep.app.renderAttendanceGroupChart(false);
  check("a week a later build could still add a day to is a gap, said as not over or not built yet",
    ep.app.state._grModel.withheld.some((x) => x.key === "2026-09-28" && x.why === "open")
      && /1 week is not on this line: the week is not over, or its last days are not built yet; it joins the line once they are\./.test(ep.ids.attGroupBody.innerHTML));
  // A FAILED POWERSCHOOL READ: the reading says why the days are missing.
  const skip = world();
  skip.tables.attendanceRunGroupMonths = [{ yearid: 36, month: "2026-09", built: [{ axis: "gender", syncedAt: "2026-10-07T10:15:00.000Z" }],
    skipped: [{ axis: "race", reason: "Race codes could not be read: HTTP 503", at: "2026-10-07T10:15:00.000Z" }], updatedAt: "x" }];
  const sp = makePage({ staff: ADMIN, w: skip });
  await sp.app.renderAttendanceGroupChart(false);
  await sp.app.setAttendanceGroup("race:black");
  const sh = sp.ids.attGroupBody.innerHTML;
  await sp.app.setAttendanceGroup("gender:F");
  check("a line some of whose days a failed read left unbuilt says so, with the reason; another line does not",
    /Some school days of this line could not be built from PowerSchool \(Race codes could not be read: HTTP 503\)\. They are tried again each night\./.test(sh)
      && !/could not be built from PowerSchool/.test(sp.ids.attGroupBody.innerHTML));
}

// ===========================================================================
console.log("\nE. NOTHING COUNTABLE ON SCREEN, IN THE HOVER, OR ON PAPER\n");
// ===========================================================================
const COUNTS = /student-days\b(?! the group)|whole days out of|\b\d+ of \d+ students|\bmembers\b|\babsentDays\b|fullDays|\d+ whole days/;
{
  const p = makePage({ staff: ADMIN, w: W });
  await p.app.renderAttendanceGroupChart(false);
  const m = p.app.state._grModel;
  const tips = m.axis.map((_, i) => p.app.grTipParts(m, i));
  const tipText = tips.map((t) => t.rows + t.extra.join(" ")).join(" ");
  check("the hover says rates and the gap only: no student-days, no whole days, no 'N of M students'",
    !COUNTS.test(tipText) && /points (above|below) the rest of the school/.test(tipText) && /Whole school/.test(tipText), tipText.match(COUNTS)?.[0]);
  check("...Trends' readout keeps its counts (it is not this card's)", /whole days out of/.test(liftFn(scriptSrc, "arTipParts")));
  const visible = p.ids.attGroupBody.innerHTML.replace(/student-days the group was enrolled/g, "");
  check("the card prints no count anywhere", !COUNTS.test(visible), visible.match(COUNTS)?.[0]);
  check("every percentage on the card is a rate to one decimal; group sizes are multiples of 5",
    [...p.ids.attGroupBody.innerHTML.matchAll(/about (\d+) students/g)].every((x) => Number(x[1]) % 5 === 0)
      && [...p.ids.attGroupBody.innerHTML.matchAll(/(\d+(?:\.\d+)?)%/g)].every((x) => /^\d+\.\d$/.test(x[1]) || /^\d+$/.test(x[1])));
  // TEETH: the Trends readout on this card would show counts.
  const counts = breakOnce(scriptSrc, "            wireAttendanceRateHover('attGroupBody', () => _grModel, grTipParts);", "            wireAttendanceRateHover('attGroupBody', () => _grModel, arTipParts);", "tip");
  check("TEETH: the card wired to Trends' readout is caught", !/wireAttendanceRateHover\('attGroupBody', \(\) => _grModel, grTipParts\)/.test(counts)
    && /wireAttendanceRateHover\('attGroupBody', \(\) => _grModel, grTipParts\);/.test(scriptSrc));

  // ON PAPER.
  await p.app.openGroupChartSheet();
  const sheet = p.ids.wcPrintSheet;
  check("Print fills #wcPrintSheet with this chart (data-sheet 'groups'), closing any other sheet first",
    sheet && sheet.getAttribute("data-sheet") === "groups" && /data-gr-sheet/.test(sheet.innerHTML) && p.G.closedOthers >= 1);
  const paper = sheet.innerHTML;
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const reading = p.app.state._grShown.reading;
  check("...the paper has the title, group, dates, as-of, the chart, the answer and the reading",
    /Weekly attendance rate — Female against the whole school/.test(paper) && /2025-08-14 to 2026-10-09/.test(paper)
      && /group lines built Oct 12/.test(paper) && /<svg/.test(paper) && paper.includes(esc(p.ids.attGroupAnswer.textContent))
      && reading.length > 2 && reading.every((t) => paper.includes(esc(t))) && /No counts are printed: rates only\./.test(paper));
  check("...readable in greyscale: solid group, dashed whole school, dotted last year, said in words and styled for paper",
    /Solid line: Female\. Dashed line: the whole school \(Trends’ line\)\. Dotted line: the same week last year\./.test(paper)
      && /wc-gr-print/.test(paper) && /\.wc-gr-print \.wc-ar-line, \.wc-gr-print \.wc-ar-median \{ stroke: #111827; \}/.test(css)
      && /\.wc-gr-plot \.wc-ar-ghost \{ stroke-dasharray: 0\.1 4\.5; stroke-width: 2\.25; stroke-linecap: round;/.test(css));
  check("...and no count on paper either", !COUNTS.test(paper.replace(/student-days the group was enrolled/g, "")), paper.match(COUNTS)?.[0]);
  const before = p.document.title;
  await p.app.printGroupChartSheet();
  check("Print sets the PDF's name and the print class, and puts both back after", p.printed === 1
    && /Weekly attendance rate - Female/.test(p.document.title) && p.document.body.classList.contains("wc-printing"));
  [...(p.winListeners.afterprint || [])].forEach((f) => f());
  check("...after printing the title and the class come back", p.document.title === before && !p.document.body.classList.contains("wc-printing"));
  p.app.closeGroupChartSheet();
  check("Close removes the sheet and its Ctrl+P hook", !p.ids.wcPrintSheet && !(p.winListeners.beforeprint || new Set()).size);
  const none = makePage({ staff: ADMIN, w: W });
  none.app.openGroupChartSheet();
  check("Print before anything is drawn says so, and builds nothing", !none.ids.wcPrintSheet);
}

// ===========================================================================
console.log("\nF. A DIFFERENT PERSON ON THE PAGE: EVERYTHING GOES\n");
// ===========================================================================
{
  const storage = new Map();
  const p = makePage({ staff: ADMIN, w: W, storage });
  await p.app.renderAttendanceGroupChart(false);
  await p.app.setAttendanceGroup("race:black");
  check("the chosen group is remembered for this browser tab, under this person", JSON.parse(storage.get("wcAttGroup")).group === "race:black"
    && JSON.parse(storage.get("wcAttGroup")).who === ADMIN.email);
  check("...and focus goes back to the drop-down after the redraw", p.focused === "attGroupSelect");
  const again = makePage({ staff: ADMIN, w: W, storage });
  await again.app.renderAttendanceGroupChart(false);
  check("...so the next draw in this tab opens on it", again.app.state._grGroup === "race:black");
  await p.app.openGroupChartSheet();
  p.app.wipeAttendanceViews();
  const st = p.app.state;
  check("the sign-out wipe empties the card and the answer, drops the list, the answers, the model and the choice, and closes the sheet",
    p.ids.attGroupBody.innerHTML === "" && p.ids.attGroupAnswer.textContent === "" && st._grList === null && st.answers === 0
      && st._grModel === null && st._grShown === null && st._grGroup === null && !p.ids.wcPrintSheet);
  const next = makePage({ staff: GRANT, w: W, storage });
  await next.app.renderAttendanceGroupChart(false);
  check("the next person never inherits the last one's group (the memory is per person)", next.app.state._grGroup === "gender:F");
  p.app.wcForgetTab();
  check("sign-out removes the remembered group from the browser tab", !storage.has("wcAttGroup"));
  check("the idle drop forgets the group lines too (they are rebuilt nightly)",
    /if \(typeof dropAttendanceGroupCache === 'function'\) dropAttendanceGroupCache\(\);/.test(scriptSrc));
  check("wipeAttendanceViews runs the group chart's own forget", /if \(typeof forgetAttendanceGroupChart === 'function'\) forgetAttendanceGroupChart\(\);/.test(liftFn(scriptSrc, "wipeAttendanceViews")));
  const keep = breakOnce(scriptSrc, "            if (typeof forgetAttendanceGroupChart === 'function') forgetAttendanceGroupChart();\n", "", "wipe");
  const k = makePage({ staff: ADMIN, w: W, src: keep });
  await k.app.renderAttendanceGroupChart(false);
  k.app.wipeAttendanceViews();
  check("TEETH: a wipe that skips the group chart leaves the admin's chart under the next person", /<svg/.test(k.ids.attGroupBody.innerHTML));
  // An answer arriving after a wipe is not drawn.
  const late = makePage({ staff: ADMIN, w: W });
  const drawing = late.app.renderAttendanceGroupChart(false);
  late.app.forgetAttendanceGroupChart();
  await drawing;
  check("an answer that lands after the wipe is thrown away, not drawn", late.ids.attGroupBody.innerHTML === "");
}

// ===========================================================================
console.log("\nG. THE PAGE: IDS, THE WRAPPERS, PHONE WIDTH, OLD TABS, TRENDS UNCHANGED\n");
// ===========================================================================
{
  check("index.html has the card, its answer, its body and its print button, above the table",
    ["attGroupCard", "attGroupAnswer", "attGroupBody", "attGroupPrint", "attSubgroupCard"].every((id) => new RegExp(`\\bid="${id}"`).test(html))
      && html.indexOf('id="attGroupCard"') < html.indexOf('id="attSubgroupCard"') && html.indexOf('id="attSubgroupCard"') < html.indexOf('id="attSubgroupBody"'));
  check("both wrappers are BARE divs, so `hidden` cannot be beaten by a display rule",
    /<div id="attGroupCard">/.test(html) && /<div id="attSubgroupCard" hidden>/.test(html));
  check("the drop-down and the last-year box are drawn with ids the dom-refs check can see", /id="attGroupSelect"/.test(scriptSrc) && /id="attGroupGhost"/.test(scriptSrc));
  check("phone width: the controls wrap, the drop-down goes full width, and the chart scrolls inside its card (never the page)",
    /\.wc-gr-controls \{ display: flex; flex-wrap: wrap;/.test(css)
      && /@media \(max-width: 600px\) \{\s*\.wc-gr-pick \{ display: flex; width: 100%; \}\s*\.wc-gr-pick \.wc-att-grade \{ flex: 1 1 auto; min-width: 0; width: 100%; \}/.test(css)
      && /@media \(max-width: 640px\) \{\s*\.wc-ar-plot \{ overflow-x: auto;/.test(css));
  check("no partial dark-mode rule was added", (css.match(/@media \(prefers-color-scheme/g) || []).length === 0);
  check("the test is in the suite", pkg.scripts.test.includes("node attendance-group-card.test.mjs"));
  // OLD TABS: the new query is called only by this card, with arguments it lists.
  const calls = [...scriptSrc.matchAll(/convexQuery\('attendanceGroupRunChart:groupWeeks', ([^,]+),/g)].map((x) => x[1]);
  check("groupWeeks is called only by the new card (an old tab never calls it), with {} or { group, periods, misrecordAt }",
    calls.length === 2 && calls.includes("{}") && calls.includes("args")
      && /const args = \{ group: group, periods: periods \};/.test(liftFn(scriptSrc, "grAsk")));
  check("the table's query keeps its arguments for old and new tabs alike", /\{ schoolDays: schoolDays, withheldOk: true \}/.test(scriptSrc));
  // TRENDS ITSELF: the panel renders byte-identically to the code before this
  // change (314c9ba), across measures, policies, last year on and off, the
  // lines shown, a frozen baseline and an empty chart, for an admin and the grant.
  let oldSrc = null;
  try {
    oldSrc = execFileSync("git", ["show", "314c9ba:script.js"],
      { cwd: fileURLToPath(new URL("./", import.meta.url)), stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 << 20 }).toString();
  } catch { /* no git here */ }
  if (oldSrc) {
    const lift = (src) => (name) => {
      const i = src.indexOf("function " + name + "(");
      if (i < 0) return "";
      const head = src.lastIndexOf("\n", i);
      let depth = 0;
      for (let k = src.indexOf("{", i); k < src.length; k++) {
        if (src[k] === "{") depth++; else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(head + 1, k + 1); }
      }
      return "";
    };
    const panel = (src) => new Function("R", "window", `
      let currentUser = null; const _cashOpenFolds = new Set();
      ${["escapeHtml", "cashFoldKey", "cashFoldHtml"].map(lift(src)).join("\n")}
      ${liftConst(src, "AR_SERIES")} ${liftConst(src, "AR_POLICY_WORDS")}
      ${["arSeriesInfo", "arYearLabel", "arPeriodLabel", "arFmt", "arDefaultRange", "arPlotHtml", "renderAttendanceRateBody"].map(lift(src)).join("\n")}
      return { render: renderAttendanceRateBody, signIn: (u) => { currentUser = u; } };`)(R, { WildcatDiscipline: D });
    const A = panel(oldSrc), B = panel(scriptSrc);
    const months = [{ yearid: 36, month: "2026-09", band: "6-8", students: 340, memberDays: 6740, fullDayAbsences: 494, chronicStudents: 123 },
      { yearid: 35, month: "2025-09", band: "6-8", students: 221, memberDays: 4400, fullDayAbsences: 300, chronicStudents: 60 }];
    const base = Object.assign({}, W.series, { months, annotations: [{ id: "n", date: "2026-09-14", label: "raffle <b>", createdBy: "x" }] });
    const frozen = Object.assign({}, base, { baselines: [{ id: "b", measure: "weeklyRate", series: "all", from: "2025-08-18", to: "2025-11-10", median: 92.5, points: 12, frozenAt: "2026-09-23T10:00:00Z", frozenBy: "a@x" }] });
    let same = 0, n = 0;
    for (const user of [{ role: "admin" }, { role: "campusaide", attendanceWatch: true }]) for (const res of [base, frozen, { allowed: true, days: [], months: [], baselines: [], annotations: [] }])
      for (const measure of ["weeklyRate", "monthlyAvgAbsent", "monthlyChronic"]) for (const policy of ["merge", "separate", "drop"]) for (const ghost of [true, false])
        for (const shown of [{ all: true, "6-8": true, "9-12": true }, { all: true, "6-8": false, "9-12": false }]) {
          const st = { measure, policy, shown, cand: null, ghost, settings: { misrecordAt: 1 }, today: TODAY, realToday: TODAY };
          A.signIn(user); B.signIn(user);
          n++;
          if (A.render(res, R, st).html === B.render(res, R, st).html) same++;
        }
    check(`Trends' panel is byte-identical to 314c9ba's: ${same} of ${n} renders (measures, short weeks, last year, lines, frozen, empty, admin and grant)`, same === n && n === 216);
  } else {
    console.log("  SKIP  Trends' panel against 314c9ba (git or that commit not available here)");
  }
  check("Trends' hover is the shared one, called as before with no arguments", /            wireAttendanceRateHover\(\);\n/.test(scriptSrc)
    && /const modelOf = typeof getModel === 'function' \? getModel : \(\) => _arModel;/.test(liftFn(scriptSrc, "wireAttendanceRateHover")));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
