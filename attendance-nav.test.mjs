// Attendance Watch, one tab per question. Run: npm test
//
// THE OWNER, 2026-10-07: "build", on the clickable preview of the five-tab
// layout -- Year so far | Week or month | Trends | Perfect attendance |
// Student groups -- with every high and medium point of the critique applied.
//
//   A. THE TABS AND THE GATES. Admin, superadmin and PBIS see all five; the
//      per-person Attendance Watch grant sees four (never Student groups, and
//      a remembered Student groups lands on Year so far); teachers and aides
//      without the grant cannot open the tab at all. The grant reads, never
//      sets: no box, picker or button on any tab changes anything.
//   B. THE SCHOOL-DAY COUNT replaces the unsaved "School year started" and
//      "Holidays" boxes: the days PowerSchool took attendance before today,
//      PLUS TODAY ONCE THE YEAR TOTALS IT DIVIDES HOLD TODAY (their copy is
//      stamped today at 10:00 or later -- the midday copy), never an absence
//      entered ahead of time. It equals the old boxes' value (38 in the
//      morning, 39 from noon), judges a late copy by the rebuild's own stamp
//      (not a clock rule), and says plainly when it is unknown. Every
//      consumer -- the year's bands, Student groups, Perfect attendance and
//      Early Warning -- reads the same number, whichever tab opened first.
//   C. THE DAILY CHART stops at the last FINISHED day.
//   D. "LAST WEEK" is the same finished Monday to Friday on Week or month and
//      on Perfect attendance, weekends included.
//   E. EVERY OLD FILTER IS STILL ONE CHOICE AWAY, with the same students in
//      the same order: the old buttons, as they stood at ebde323, are run
//      below against the band chips and the "Kind of absence" select.
//   F. SORTING uses the shared wcSort* helper; a capped list is sorted WHOLE
//      before the first 50 are cut, and Perfect attendance prints the order
//      on screen.
//   G. THE REMEMBERED TAB, the "what moved where" note, the data line, the
//      word list, the banner, the icon, the one Refresh and the phone layout.
//
// THE SHIPPED CODE RUNS: functions are lifted out of script.js and run
// against a small fake DOM with the real wildcat-roster.js and
// wildcat-discipline.js. Every "TEETH" check breaks the code on purpose and
// shows the assertion catches it.

process.env.TZ = "America/Los_Angeles";

import { readFileSync } from "node:fs";

const scriptSrc = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const rosterSrc = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
const discSrc = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

// ---------------------------------------------------------------- the harness

function loadRoster(transform) {
  const sandbox = {};
  new Function("globalThis", transform ? transform(rosterSrc) : rosterSrc).call(sandbox, sandbox);
  return sandbox.WildcatRoster;
}
const R = loadRoster();
const D = (() => { const sb = {}; new Function("globalThis", discSrc).call(sb, sb); return sb.WildcatDiscipline || globalThis.WildcatDiscipline; })();

/**
 * A top-level function's text: script.js indents them by eight spaces, so a
 * function runs from its line to the first line that is eight spaces and "}".
 */
function liftFn(src, name) {
  const m = new RegExp("\\n        (?:async )?function " + name + "\\(").exec(src);
  if (!m) throw new Error("missing function " + name);
  const start = m.index + 1;
  const end = src.indexOf("\n        }\n", start);
  if (end < 0) throw new Error("unterminated function " + name);
  return src.slice(start, end + 10);
}
/** A top-level const (one line, or brackets matched). */
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
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A fake element. */
function makeEl(id, attrs) {
  const cls = new Set();
  const a = new Map(Object.entries(attrs || {}));
  return {
    id, innerHTML: "", textContent: "", value: "", hidden: false, checked: false, style: {}, focused: 0,
    setAttribute: (k, v) => a.set(k, String(v)),
    getAttribute: (k) => (a.has(k) ? a.get(k) : null),
    removeAttribute: (k) => a.delete(k),
    hasAttribute: (k) => a.has(k),
    focus() { this.focused++; },
    querySelectorAll: () => [],
    classList: {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      toggle: (c, on) => { const v = on === undefined ? !cls.has(c) : !!on; v ? cls.add(c) : cls.delete(c); return v; },
      contains: (c) => cls.has(c),
    },
  };
}
/** The five tab buttons, as index.html draws them. */
function viewButtons(page) {
  const bar = page.slice(page.indexOf('id="attViewSwitch"'), page.indexOf("</div>", page.indexOf('id="attViewSwitch"')));
  return [...bar.matchAll(/data-attview="(\w+)"[^>]*?( hidden)?\s*\n?\s*onclick/g)].map((m) => {
    const b = makeEl("", { "data-attview": m[1] });
    b.hidden = !!m[2];
    return b;
  });
}
function makeDom(opts = {}) {
  const page = opts.html || html;
  const els = {};
  const buttons = viewButtons(page);
  const byId = (id) => {
    if (!new RegExp(`\\bid="${id}"`).test(page)) return null;
    return els[id] || (els[id] = makeEl(id));
  };
  return {
    els, buttons,
    getElementById: byId,
    querySelectorAll: (sel) => {
      if (sel === '#attViewSwitch [data-attview="subgroup"]') return buttons.filter((b) => b.getAttribute("data-attview") === "subgroup");
      if (sel === "#attViewSwitch [data-attview]") return buttons;
      return [];
    },
    querySelector: () => null,
    addEventListener() {},
  };
}
function makeStorage(opts = {}) {
  const m = new Map();
  return {
    m,
    getItem: (k) => { if (opts.throws) throw new Error("denied"); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (opts.throws) throw new Error("denied"); m.set(k, String(v)); },
    removeItem: (k) => { if (opts.throws) throw new Error("denied"); m.delete(k); },
  };
}

const FNS = [
  "escapeHtml", "wcSortCellText", "wcSortValue", "wcSortColumnType", "wcSortOrder", "wcSortSet", "wcSortItems", "wcSortTh",
  "wcSortRowCellText", "wcSortRowsHtml", "wcSortMarkHead", "wcSortApplyDom", "wcSortClick",
  "cashChipsHtml", "cashFoldKey", "cashFoldHtml", "wcForgetTab",
  "attViewKey", "attGroupsAllowed", "attRememberView", "attRememberedView", "setAttendanceView", "drawAttendanceView",
  "refreshAttendanceView", "attMovedNoteKey", "attMovedNoteHtml", "renderAttMovedNote", "dismissAttMovedNote",
  "openAttGlossary", "closeAttGlossary", "attGlossaryKeydown", "attCopiedAt", "attRateBuiltAt", "attDataLineHtml", "renderAttDataLine",
  "ensureSchoolCalendar", "attTodayIso", "setAttendanceWindow", "setAttendanceWindowBand", "setAttendanceWindowKind",
  "showAllAttendanceWindow", "setAttendanceGradeFilter", "attShortDay", "attGradeName", "attFillGradeSelect",
  "attFillKindSelect", "attBandChipsHtml", "attOrderWords", "attTableBarHtml", "attShowMoreHtml",
  "attGradeKey", "attGradeOrder", "attendanceSchoolDays", "attDaysRange", "wipeAttendanceViews",
  "setAttendanceYearBand", "setAttendanceYearKind", "setAttendanceRosterOnly", "showAllAttendanceYear", "renderAttendanceWatch",
  "renderRunChartBody", "renderAbsenceRunChart", "renderAttendanceDetail", "arSeriesInfo", "arAnswerText",
];
const CONSTS = ["WC_SORT_ARROWS", "ATT_VIEWS", "ATT_VIEW_ALIASES", "ATT_WINDOWS", "ATT_LIST_CAP", "ATT_YEAR_COLS", "ATT_WIN_COLS",
  "ATT_PERFECT_COLS", "AR_SERIES"];

/**
 * The Attendance Watch frame, lifted. `G` holds the world: currentUser,
 * students, the caches, the clock (today), and stubs for the renderers a test
 * does not run.
 */
function loadApp(src, G) {
  const body = `
    const document = G.document, window = G.window, localStorage = G.localStorage;
    const console = { log() {}, warn() {}, error() {} };
    let currentUser = G.currentUser || null;
    let students = G.students || [];
    let riskSettings = {};
    var WC_VIEW_KEY = 'wc_view_tab', WC_CASH_VIEW_KEY = 'wcCashAnalyticsView', WC_ATT_VIEW_KEY = 'wcAttendanceView';
    const _wcSortState = new Map(), _wcSortRedraw = new Map(), _cashOpenFolds = new Set(), _attMovedNoteGone = new Set();
    let _attCache = G.attCache || null, _attBusy = false, _attView = 'watch', _attGradeFilter = 'all';
    let _attWindow = 'lastWeek', _attWinBand = 'some', _attWinKind = 'any', _attWinAll = false, _attWinSeq = 0;
    const _attWinCache = new Map();
    let _attYearBand = 'chronicPlus', _attYearKind = 'any', _attYearRosterOnly = false, _attYearAll = false;
    let _attCalHeld = G.calHeld || null, _runFetchedAt = G.runFetchedAt || 0, _runFor = G.runFor || '', _runLoading = null;
    let _runCache = G.runCache || null, _runWhich = 'full', _runBusy = false, _attTotalsLoading = null;
    let _paCache = null, _arCache = null, _sgCache = null;
    let _attGlossaryOpener = null;
    const drawn = G.drawn = [];
    // PowerSchool's totals: G.rows is the copy the server holds now; a read
    // takes it when nothing is in hand or when forced.
    async function loadAttendanceRows(force) {
      G.rowLoads = (G.rowLoads || []).concat([force === true]);
      if (G.rows && (!_attCache || force === true)) _attCache = G.rows;
      return _attCache;
    }
    async function loadAbsenceSeries(force) { G.seriesLoads = (G.seriesLoads || 0) + 1; if (G.series) { _runCache = G.series; _runFor = attTodayIso(); _runFetchedAt = Date.now(); _attCalHeld = G.series; } return _runCache; }
    async function renderAttendanceWindow(f) { drawn.push('window' + (f ? '!' : '')); }
    async function renderPerfectAttendance(f) { drawn.push('perfect' + (f ? '!' : '')); }
    async function renderAttendanceSubgroups(f) { drawn.push('subgroup' + (f ? '!' : '')); }
    async function renderAttendanceRate(f) { drawn.push('rate' + (f ? '!' : '')); }
    function fetchAttendanceRebuildHealth() { return Promise.resolve(); }
    function attendanceRebuildVerdict() { return G.verdict || { level: 'unknown', headline: '' }; }
    function wireRunChartHover() {}
    function openAttendanceRebuildPanel() {}
    ${G.override || ""}
    ${CONSTS.map((n) => liftConst(src, n)).join("\n")}
    ${FNS.filter((n) => !(G.skip || []).includes(n)).map((n) => liftFn(src, n)).join("\n")}
    if (!G.realDraw) { const realDraw = drawAttendanceView; }
    return {
      ${FNS.filter((n) => !(G.skip || []).includes(n)).join(", ")},
      set(k, v) { if (k === "currentUser") currentUser = v; else if (k === "students") students = v; else if (k === "attCache") _attCache = v; else if (k === "runCache") { _runCache = v; } else if (k === "sgCache") _sgCache = v; else throw new Error(k); },
      get state() { return { _attView, _attWindow, _attGradeFilter, _attYearBand, _attYearKind, _attYearAll, _sgCache, _attCache, sortState: _wcSortState, redraws: _wcSortRedraw }; },
      setYear(o) { if ('band' in o) _attYearBand = o.band; if ('kind' in o) _attYearKind = o.kind; if ('all' in o) _attYearAll = o.all; if ('roster' in o) _attYearRosterOnly = o.roster; if ('grade' in o) _attGradeFilter = o.grade; },
      dropRunCache() { _runCache = null; },
      get consts() { return { ATT_PERFECT_COLS }; },
    };`;
  return new Function("G", body)(G);
}
function world(opts = {}) {
  const dom = makeDom(opts);
  const session = makeStorage(opts.storage || {});
  const local = makeStorage();
  const now = opts.now || new Date(2026, 9, 7, 10, 0).getTime();
  const RealDate = Date;
  const G = {
    document: dom,
    window: { WildcatRoster: opts.R || R, WildcatDiscipline: D, sessionStorage: session },
    localStorage: local,
    currentUser: opts.user === undefined ? { id: "A1", role: "admin" } : opts.user,
    students: opts.students || [],
    attCache: opts.attCache || null,
    runCache: opts.runCache || null,
    calHeld: opts.calHeld || null,
    series: opts.series || null,
    rows: opts.rows || null,
    verdict: opts.verdict,
    override: opts.override,
    skip: opts.skip,
  };
  // The clock: attTodayIso() reads new Date().
  G.override = (G.override || "") + `
    const Date = (function (Real, now) {
      return class extends Real { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } };
    })(globalThis.Date, ${now});`;
  const app = loadApp(opts.src || scriptSrc, G);
  void RealDate;
  return { app, dom, session, local, G };
}

// ---------------------------------------------------------------- calendars
/** Weekdays from 12 Aug to `last`, less the two days school did not run (4 Sep, Labor Day 7 Sep). */
function schoolDates(last) {
  const out = [];
  for (let d = new Date(Date.UTC(2026, 7, 12)); d.toISOString().slice(0, 10) <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay(), iso = d.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && iso !== "2026-09-04" && iso !== "2026-09-07") out.push(iso);
  }
  return out;
}
const pointFor = (date, i) => ({ date, studentsAbsent: 100 + (i % 9), fullDaysStrict: 40 + (i % 7), misrecordDaysByGap: [0, 0, 0], partialDays: 60 });
/** dailyAbsenceSeries as the server answers it, asked with `today`: rows on file up to and including today. */
function seriesRes(onFile, today, syncedAt, extra) {
  const usable = onFile.filter((d) => d <= today);
  const points = usable.slice(-120).map(pointFor);
  return Object.assign({ allowed: true, reason: null, points, schoolDaysOnFile: usable.length, truncated: false, syncedAt }, extra || {});
}
// PRODUCTION'S SHAPE ON 2026-10-07: rows from 12 Aug to 7 Oct (today's row
// exists, from absences entered ahead of time and the 12:30 copy), and two
// more entered ahead for 8 and 9 Oct.
const ON_FILE = schoolDates("2026-10-07").concat(["2026-10-08", "2026-10-09"]);

console.log("\nA. The five tabs, one question each, in the house pill style");
{
  const bar = html.slice(html.indexOf('id="attViewSwitch"'), html.indexOf("</div>", html.indexOf('id="attViewSwitch"')));
  const labels = [...bar.matchAll(/<\/svg> ([^<]+)<\/button>/g)].map((m) => m[1]);
  check("five tabs, in order", labels.join(" | ") === "Year so far | Week or month | Trends | Perfect attendance | Student groups", labels.join(" | "));
  check("each with a house icon", (bar.match(/<use href="#wci-[a-z-]+"><\/use>/g) || []).length === 5);
  check("the keys keep the old view names where a tab kept its job",
    /ATT_VIEWS = \['watch', 'window', 'rate', 'perfect', 'subgroup'\]/.test(scriptSrc)
    && ["watch", "window", "rate", "perfect", "subgroup"].every((k) => bar.includes(`data-attview="${k}"`)));
  check("the bar is scoped by id and NOT .analytics-tabs (Discipline's switcher clears that class page-wide)",
    /<div class="subtab-bar wc-att-views" id="attViewSwitch" role="group"/.test(html));
  const pane = html.slice(html.indexOf('<div id="behaviorAttendance"'), html.indexOf("<!-- Early Warning Subtab"));
  check("no row in Attendance Watch carries .analytics-tabs", !/class="[^"]*\banalytics-tabs\b/.test(pane));
  const ew = html.slice(html.indexOf('id="behaviorEarlyWarning"'), html.indexOf("<!-- Uniform Violations Subtab"));
  check("...nor Early Warning's filter row (it lost its highlight to Discipline > Analytics)", !/class="[^"]*\banalytics-tabs\b/.test(ew));
  check("...nor Uniform's view filter, for the same reason", /<div class="subtab-bar wc-att-pills" id="uvViewFilter">/.test(html));
  check("the row style that replaced it keeps the 18px gap", /\.wc-att-pills \{[^}]*margin: 0 0 14px/.test(css) && /\.wc-att-pills \{[^}]*flex-wrap: wrap/.test(css));
  check("each tab asks its question at its top",
    ["Who has missed the most school this year?", "Who was out on the last school day, last week, or this month?",
     "Is attendance getting better?", "Who had no absences and no unexcused tardies?",
     "Is chronic absence higher for some groups than for the school as a whole?"].every((q) => pane.includes(q)));
  check("one title with the house calendar icon, no emoji",
    /<h2 class="page-title"><svg class="wc-icon"[^>]*><use href="#wci-calendar"><\/use><\/svg> Attendance Watch<\/h2>/.test(pane) && !/📅/.test(pane));
  check("ONE Refresh, in the header, aimed at the tab on screen",
    (pane.match(/>[^<]*Refresh<\/button>/g) || []).length === 1 && /onclick="refreshAttendanceView\(\)"/.test(pane)
    && !/renderAbsenceRunChart\(true\)|renderPerfectAttendance\(true\)|renderAttendanceSubgroups\(true\)|renderAttendanceRate\(true\)/.test(pane));
  check("the old changing subtitle is gone", !/attViewSubtitle|ATT_VIEW_SUBTITLES/.test(scriptSrc + html));
  check("the Discipline banner is gone from every Discipline tab",
    !/<h2[^>]*>Discipline Mode - Behavior Referral System/.test(html) && !/Comprehensive behavior tracking, referral management/.test(html));
  check("...and the empty legacy button row takes no space",
    /<div class="subtab-bar wc-disc-legacy-bar">/.test(html) && /#disciplineContent > \.wc-disc-legacy-bar \{ display: none; \}/.test(css));
  check("the Discipline tabs keep their own titles, so nothing else reads worse",
    ["behaviorAttendance", "behaviorEarlyWarning"].every((id) => /<h2 class="page-title">/.test(html.slice(html.indexOf(`id="${id}"`), html.indexOf(`id="${id}"`) + 900)))
    && /<h3 style="color: #2F67A7; margin-bottom: 6px;">Uniform Violations<\/h3>/.test(html));
  check("Year so far and Week or month share one pane, the tab says which section shows",
    /#attWatchView\[data-attview="watch"\] \[data-asec="window"\],\s*#attWatchView\[data-attview="window"\] \[data-asec="watch"\] \{ display: none; \}/.test(css));
  check("the bar and every chip row wrap on a phone, and the controls go full width under 600px",
    /\.wc-att-views \{[^}]*flex-wrap: wrap/.test(css) && /\.wc-band-row \{[^}]*flex-wrap: wrap/.test(css)
    && /@media \(max-width: 600px\) \{\s*\.wc-band \{ min-width: 0; flex: 1 1 calc\(50% - 8px\); \}/.test(css));
  check("the student column stays put while a wide table scrolls (wc-pin)",
    /cls: i === 0 \? 'wc-pin' : ''/.test(liftFn(scriptSrc, "renderAttendanceWatch")) && /\.wc-trend-table \.wc-pin \{\s*position: sticky; left: 0;/.test(css));
  check("the view-only grant has nothing to type into on the reading tabs: no date or number box in the pane",
    !/<input type="(date|number)"/.test(pane));
}

console.log("\nA. Switching: one pressed button, one pane, aliases, and who sees what");
{
  const { app, dom, G } = world({ series: seriesRes(ON_FILE, "2026-10-07", "2026-10-07T19:30:00Z") });
  await app.setAttendanceView("rate");
  const pressed = dom.buttons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("data-attview"));
  check("one button pressed, the one asked for", pressed.join(",") === "rate", pressed.join(","));
  check("...and only Trends' pane shows",
    dom.els.attRateView.hidden === false && dom.els.attWatchView.hidden === true && dom.els.attPerfectView.hidden === true && dom.els.attSubgroupView.hidden === true);
  check("...and the rate chart is drawn, with the daily one from the calendar just loaded (one read, not two)",
    G.drawn.includes("rate") && G.seriesLoads === 1, G.drawn.join(",") + " / " + G.seriesLoads);
  await app.setAttendanceView("window");
  check("Week or month shows the shared pane, set to its section",
    dom.els.attWatchView.hidden === false && dom.els.attWatchView.getAttribute("data-attview") === "window" && G.drawn.includes("window"));
  for (const [alias, key] of [["trend", "rate"], ["ytd", "watch"], ["week", "window"], ["month", "window"], ["groups", "subgroup"], ["nonsense", "watch"], [undefined, "watch"]]) {
    check(`'${alias}' lands on ${key}`, app.attViewKey(alias) === key);
  }

  for (const role of ["admin", "superadmin", "pbis"]) {
    const w = world({ user: { id: role, role } });
    await w.app.setAttendanceView("subgroup");
    const sg = w.dom.buttons.find((b) => b.getAttribute("data-attview") === "subgroup");
    check(`${role}: Student groups is shown and opens`, sg.hidden === false && w.app.state._attView === "subgroup" && w.dom.els.attSubgroupView.hidden === false);
  }
  const aide = { id: "C1", role: "campusaide", attendanceWatch: true };
  const g = world({ user: aide });
  await g.app.setAttendanceView("subgroup");
  const sg = g.dom.buttons.find((b) => b.getAttribute("data-attview") === "subgroup");
  check("the view-only grant: Student groups is hidden, and asking for it lands on Year so far",
    sg.hidden === true && g.app.state._attView === "watch" && g.dom.els.attSubgroupView.hidden === true && !g.G.drawn.includes("subgroup"));
  check("...four tabs for the grant, five for the roles",
    g.dom.buttons.filter((b) => !b.hidden).length === 4);
  check("teachers and aides without the grant cannot open Attendance Watch at all",
    !D.canOpenDisciplineTab("teacher", "attendance", { role: "teacher" }) && !D.canOpenDisciplineTab("campusaide", "attendance", { role: "campusaide" })
    && D.canOpenDisciplineTab("campusaide", "attendance", { role: "campusaide", attendanceWatch: true })
    && !D.disciplineTabsFor("teacher", { role: "teacher" }).includes("attendance"));
  // TEETH: drop the role check and the grant sees Student groups.
  const broken = breakOnce(scriptSrc, "            if (_attView === 'subgroup' && !groupsOk) _attView = 'watch';\n", "", "gate");
  const b = world({ src: broken, user: aide });
  await b.app.setAttendanceView("subgroup");
  check("TEETH: without the gate the grant would land on Student groups", b.app.state._attView === "subgroup");
}

console.log("\nB. The school-day count: before today, plus today once the midday totals hold it; unknown said");
{
  const today = "2026-10-07";
  const am = seriesRes(ON_FILE, today, "2026-10-07T13:30:00Z");     // the 06:30 copy
  const pm = seriesRes(ON_FILE, today, "2026-10-07T19:30:00Z");     // the 12:30 copy
  const night = seriesRes(ON_FILE, today, "2026-10-06T19:30:00Z");  // before the morning copy: yesterday's 12:30
  const c = R.schoolCalendar(pm, today);
  check("today: 38 school days (12 Aug to 6 Oct, less 4 Sep and Labor Day)", c.known && c.days === 38, JSON.stringify(c));
  check("...the first day is the first date on file", c.first === "2026-08-12");
  check("...40 weekdays to yesterday, 2 of them not school days", c.weekdays === 40 && c.off === 2);
  check("WITHOUT THE TOTALS' STAMP, TODAY'S ROW DOES NOT COUNT, though it is on file", ON_FILE.includes(today) && c.days === ON_FILE.filter((d) => d < today).length && c.todayCounted === false);
  check("...nor the absences entered ahead for 8 and 9 Oct",
    R.schoolCalendar(Object.assign({}, pm, { points: ON_FILE.map(pointFor), schoolDaysOnFile: ON_FILE.length }), today).days === 38);
  check("STEADY THROUGH THE MORNING: before the rebuild's morning copy, after it, and after its lunchtime copy, with the 06:00 totals",
    [night, am, pm].every((r) => R.schoolCalendar(r, today, "2026-10-07T13:00:00Z").days === 38 && R.schoolCalendar(r, today, "2026-10-07T13:00:00Z").status === "ok"));
  check("...and it moves once, at midnight: 39 tomorrow", R.schoolCalendar(seriesRes(ON_FILE, "2026-10-08", "2026-10-08T13:30:00Z"), "2026-10-08").days === 39);
  // THE OLD BOXES TODAY: 12 Aug and 2 holidays, counted by schoolDaysElapsed
  // up to the moment the page was drawn -- which counts today only from noon.
  const oldAt = (h) => R.schoolDaysElapsed("2026-08-12", new Date(2026, 9, 7, h, 0)) - 2;
  check("EQUALS THE OLD BOXES' NUMBER TODAY (38 all morning)", oldAt(8) === 38 && oldAt(11) === 38 && c.days === oldAt(9));
  check("...the old count turned 39 at noon, as the new one does once the midday totals are in", oldAt(15) === 39
    && R.schoolCalendar(pm, today, "2026-10-07T19:00:00Z").days === oldAt(15));
  const tier = (d, days) => (R.attendanceTier(d / days) || {}).key;
  check("...and 38 and 39 put every child in the same band (whole days absent, 0 to 120)",
    Array.from({ length: 121 }, (_, d) => d).every((d) => tier(d, 38) === tier(d, 39)));
  const pts = (d, days) => D.riskAttendance ? D.riskAttendance(d, 0, days, {}).points : (D.riskScore({ daysAbsent: d, daysTardy: 0 }, days, {}, {}) || {}).points;
  check("...and the same Early Warning attendance points", Array.from({ length: 121 }, (_, d) => d).every((d) => {
    const a = D.riskRanking([{ studentNumber: "x", daysAbsent: d, daysTardy: 0 }], 38, { status: "unknown" }, {});
    const b = D.riskRanking([{ studentNumber: "x", daysAbsent: d, daysTardy: 0 }], 39, { status: "unknown" }, {});
    return a.ranked.concat(a.noData).map((r) => r.points).join() === b.ranked.concat(b.noData).map((r) => r.points).join();
  }));
  void pts;

  // A LATE COPY, judged by the rebuild's own stamp.
  const lateFile = schoolDates("2026-10-02");                // no row since Friday 2 Oct
  const late = R.schoolCalendar(seriesRes(lateFile, today, "2026-10-02T19:30:00Z"), today);
  check("a copy last good on Friday 12:30: Mon 5 and Tue 6 Oct are counted as weekdays, and listed",
    late.known && late.status === "estimated" && late.estimated.join(",") === "2026-10-05,2026-10-06" && late.days === 38, JSON.stringify(late));
  check("...holidays already on file stay out (still 38, not 40)", late.off === 2);
  check("...and the chart's last finished day is the day before that copy (Thu 1 Oct)", late.finishedThrough === "2026-10-01");
  const missedMorning = R.schoolCalendar(seriesRes(ON_FILE, today, "2026-10-06T19:30:00Z"), today);
  check("a FAILED MORNING RUN changes nothing: no estimate, no warning, still 38",
    missedMorning.status === "ok" && missedMorning.estimated.length === 0 && missedMorning.days === 38);
  const weekendFail = R.schoolCalendar(seriesRes(schoolDates("2026-10-02"), "2026-10-04", "2026-10-02T19:30:00Z"), "2026-10-04");
  check("A WEEKEND of failed runs changes nothing: Saturday is not a school day", weekendFail.status === "ok" && weekendFail.days === 36);
  const holidayMon = R.schoolCalendar(seriesRes(schoolDates("2026-09-08").filter((d) => d !== "2026-09-07"), "2026-09-09", "2026-09-08T19:30:00Z"), "2026-09-09");
  check("a holiday Monday followed by a good copy is simply not a school day (Labor Day)", holidayMon.status === "ok"
    && holidayMon.days === schoolDates("2026-09-08").length);

  // UNKNOWN, SAID.
  const unknowns = [
    ["a refusal", { allowed: false, reason: "The attendance trend is available to administrators and the PBIS team.", points: [] }, /administrators/],
    ["an empty table (no rows, so the server sends no stamp)", seriesRes([], today, null), /No school days are on file right now/],
    ["a read cut short", seriesRes(ON_FILE, today, "2026-10-07T13:30:00Z", { truncated: true }), /longer than this screen reads/],
    ["no copy time", seriesRes(ON_FILE, today, null), /no copy time/],
    ["far fewer days than weekdays", seriesRes(schoolDates("2026-08-20"), today, "2026-10-07T13:30:00Z"), null],
    ["nothing loaded", null, /not loaded yet/],
  ];
  for (const [label, res, re] of unknowns) {
    const u = R.schoolCalendar(res, today);
    check(`UNKNOWN for ${label}, with the reason in words`, u.known === false && u.days === null && u.reason.length > 10 && (!re || re.test(u.reason)), u.reason);
  }
  check("a stale copy is ESTIMATED, not unknown, until it is far wrong",
    R.schoolCalendar(seriesRes(schoolDates("2026-09-25"), today, "2026-09-25T19:30:00Z"), today).status === "estimated");
  check("the first day after the 120 newest comes from the loader's deeper read (firstDate)",
    R.schoolCalendar(Object.assign(seriesRes(ON_FILE, today, "2026-10-07T13:30:00Z"), { points: ON_FILE.slice(10, 39).map(pointFor), firstDate: "2026-08-12" }), today).first === "2026-08-12"
    && R.schoolCalendar(Object.assign(seriesRes(ON_FILE, today, "2026-10-07T13:30:00Z"), { points: ON_FILE.slice(10, 39).map(pointFor) }), today).known === false);

  // TEETH: count today's row, and the count moves at lunchtime.
  const B = loadRoster((s) => breakOnce(s, "var notYet = dates.filter(function (d) { return d >= today; }).length;", "var notYet = 0;", "today"));
  check("TEETH: a count that takes in today's row reads 39 today, not the old boxes' 38", B.schoolCalendar(pm, today).days === 39);
  const B2 = loadRoster((s) => breakOnce(s, "    var confirmed = la.hour >= CALENDAR_SEEN_HOUR ? la.day : shiftDays(la.day, -1);", "    var confirmed = shiftDays(la.day, -1);", "hour"));
  // The day after Labor Day, before the morning copy: the last copy (Mon 12:30)
  // has seen that school did not run on Monday.
  const laborDay = seriesRes(schoolDates("2026-09-08"), "2026-09-08", "2026-09-07T19:30:00Z");
  check("the day after a holiday, before the morning copy: nothing estimated (the 12:30 copy saw the holiday)",
    R.schoolCalendar(laborDay, "2026-09-08").status === "ok" && R.schoolCalendar(laborDay, "2026-09-08").days === schoolDates("2026-09-07").length);
  check("TEETH: judging a copy without its time of day counts the holiday as a late weekday overnight",
    B2.schoolCalendar(laborDay, "2026-09-08").status === "estimated");
  const B3 = loadRoster((s) => breakOnce(s, "    if (!onFile && !la) {\n", "    if (false) {\n", "empty"));
  check("TEETH: without its own check, an empty table no longer says why it is unknown",
    !/No school days are on file right now/.test(B3.schoolCalendar(seriesRes([], today, null), today).reason));
  // NOBODY IS ASKED TO PRESS ANYTHING (review, 2026-10-07): the loader never
  // keeps an emptied read, so the next draw asks again by itself.
  const emptyWhy = R.schoolCalendar(seriesRes([], today, null), today).reason;
  check("the empty table's reason asks nobody to refresh, and says it is expected before the first day of school",
    !/refresh/i.test(emptyWhy) && /Before the first day of school that is expected/.test(emptyWhy), emptyWhy);
  // BEFORE THE FIRST DAY: a good, stamped copy whose only rows are absences
  // entered ahead is KNOWN, and is 0.
  const before = R.schoolCalendar(seriesRes(["2026-08-12", "2026-08-13"], "2026-08-10", "2026-08-10T13:30:00Z",
    { points: [], schoolDaysOnFile: 0 }), "2026-08-10", "2026-08-10T19:00:00Z");
  check("before the first day of school, a stamped copy with only absences entered ahead is known: 0 school days",
    before.known === true && before.days === 0 && /School has not started yet/.test(before.reason), JSON.stringify(before));
}

console.log("\nB. Today joins the count once the year totals it divides hold today (the midday copy)");
{
  // WHY (review, 2026-10-07): the count divides PowerSchool's year totals,
  // and the 12:00 copy of those totals already holds today's absences. A
  // count without today then divided 39 days of absences by 38 and over-flagged.
  const today = "2026-10-07";
  const T = { "06:00": "2026-10-07T13:00:00Z", "12:00": "2026-10-07T19:00:00Z" };
  const RB = { "06:30": "2026-10-07T13:30:00Z", "12:30": "2026-10-07T19:30:00Z" };
  const cal = (file, rebuild, totals, day) => R.schoolCalendar(seriesRes(file, day || today, rebuild), day || today, totals);
  const noToday = ON_FILE.filter((d) => d !== today);
  const cases = [
    ["8 AM: the 06:00 totals, the 06:30 rebuild", cal(ON_FILE, RB["06:30"], T["06:00"]), 38, false],
    ["12:05: the 12:00 totals, the rebuild still the 06:30 one (today's row from absences entered ahead)", cal(ON_FILE, RB["06:30"], T["12:00"]), 39, true],
    ["12:05, with no row for today yet (nobody pre-entered): a weekday the rebuild has not copied counts", cal(noToday, RB["06:30"], T["12:00"]), 39, true],
    ["12:15, before the 12:30 rebuild", cal(ON_FILE, RB["06:30"], "2026-10-07T19:15:00Z"), 39, true],
    ["1 PM: the 12:00 totals and the 12:30 rebuild", cal(ON_FILE, RB["12:30"], T["12:00"]), 39, true],
    ["a failed midday SIS sync: the totals are still the 06:00 copy at 1 PM", cal(ON_FILE, RB["12:30"], T["06:00"]), 38, false],
    ["the totals are yesterday's midday copy", cal(ON_FILE, RB["12:30"], "2026-10-06T19:00:00Z"), 38, false],
    ["no totals in hand", cal(ON_FILE, RB["12:30"], null), 38, false],
  ];
  for (const [label, c, days, counted] of cases) {
    check(`${label}: ${days}${counted ? ", to today" : ", to yesterday"}`, c.known && c.days === days && c.todayCounted === counted, JSON.stringify({ days: c.days, todayCounted: c.todayCounted }));
  }
  check("...and the weekdays and days off follow the day counted (41 weekdays, 2 off, at 1 PM)",
    cases[4][1].weekdays === 41 && cases[4][1].off === 2);

  // NOT ON A DAY SCHOOL DID NOT RUN.
  const sat = "2026-10-10";
  const satFile = schoolDates("2026-10-09");
  const saturday = R.schoolCalendar(seriesRes(satFile, sat, "2026-10-10T13:30:00Z"), sat, "2026-10-10T19:10:00Z");
  check("a Saturday at 12:10, totals copied at noon: Saturday is not counted (the Friday count, " + satFile.length + ")",
    saturday.known && saturday.todayCounted === false && saturday.days === satFile.length, JSON.stringify({ d: saturday.days, t: saturday.todayCounted }));
  const holiday = "2026-09-07";  // Labor Day: the 12:30 rebuild has no row for it
  const holFile = schoolDates("2026-09-06");
  const afterRebuild = R.schoolCalendar(seriesRes(holFile, holiday, "2026-09-07T19:30:00Z"), holiday, "2026-09-07T19:00:00Z");
  check("a holiday weekday after the 12:30 rebuild: no row, so not counted",
    afterRebuild.known && afterRebuild.todayCounted === false && afterRebuild.days === holFile.length, JSON.stringify({ d: afterRebuild.days, t: afterRebuild.todayCounted }));
  const beforeRebuild = R.schoolCalendar(seriesRes(holFile, holiday, "2026-09-07T13:30:00Z"), holiday, "2026-09-07T19:00:00Z");
  check("...between the noon totals and the 12:30 rebuild it is counted (the safe direction: a larger divisor flags fewer), then drops out",
    beforeRebuild.todayCounted === true && beforeRebuild.days === holFile.length + 1);

  // THE HOUR IS LOS ANGELES', winter and summer.
  const nov = "2026-11-16";
  const novFile = schoolDates("2026-11-13");
  const pst = (stamp) => R.schoolCalendar(seriesRes(novFile, nov, "2026-11-16T14:30:00Z"), nov, stamp);
  check("in winter (PST) a copy at 10:15 counts today", pst("2026-11-16T18:15:00Z").todayCounted === true);
  check("...and one at 9:30 does not (17:30 UTC; read as summer time it would be 10:30)", pst("2026-11-16T17:30:00Z").todayCounted === false);

  // TEETH: each half of the rule, broken.
  const noRule = loadRoster((src) => breakOnce(src, "    var days = before + estimated.length + (todayCounted ? 1 : 0);", "    var days = before + estimated.length;", "today"));
  check("TEETH: a count that never takes in today reads 38 at 1 PM", noRule.schoolCalendar(seriesRes(ON_FILE, today, RB["12:30"]), today, T["12:00"]).days === 38);
  const anyHour = loadRoster((src) => breakOnce(src, "totals.day === today && totals.hour >= CALENDAR_SEEN_HOUR", "totals.day === today", "hour"));
  check("TEETH: a count that takes today from the 06:00 totals reads 39 at 8 AM", anyHour.schoolCalendar(seriesRes(ON_FILE, today, RB["06:30"]), today, T["06:00"]).days === 39);
  const weekend = loadRoster((src) => breakOnce(src, "(!rebuildSawToday && todayDow !== 0 && todayDow !== 6)", "!rebuildSawToday", "weekend"));
  check("TEETH: without the weekday check, Saturday counts", weekend.schoolCalendar(seriesRes(satFile, sat, "2026-10-10T13:30:00Z"), sat, "2026-10-10T19:10:00Z").todayCounted === true);
  const noRow = loadRoster((src) => breakOnce(src, "(seen[today] === true || (!rebuildSawToday", "(true || (!rebuildSawToday", "row"));
  check("TEETH: without the row check, a holiday counts after the 12:30 rebuild", noRow.schoolCalendar(seriesRes(holFile, holiday, "2026-09-07T19:30:00Z"), holiday, "2026-09-07T19:00:00Z").todayCounted === true);

  // A LATE COPY THAT ALREADY HOLDS ITS OWN DAY'S ROW: counted once.
  // Thursday 8 AM; the Thursday 06:30 run failed, so the newest copy is
  // Wednesday's 06:31, which has seen up to Tuesday but holds a row for
  // Wednesday (absences entered ahead).
  const thu = "2026-10-08";
  const lateOwn = R.schoolCalendar(seriesRes(ON_FILE, thu, "2026-10-07T13:31:00Z"), thu, "2026-10-08T13:00:00Z");
  check("a late copy holding its own day's row: Wednesday counts once (39), nothing estimated",
    lateOwn.known && lateOwn.days === schoolDates("2026-10-07").length && lateOwn.estimated.length === 0 && lateOwn.status === "ok", JSON.stringify({ d: lateOwn.days, e: lateOwn.estimated }));
  const twice = loadRoster((src) => breakOnce(src, "if (dow !== 0 && dow !== 6 && !seen[d] && d >= first) estimated.push(d);", "if (dow !== 0 && dow !== 6 && d >= first) estimated.push(d);", "seen"));
  check("TEETH: without the row check, Wednesday is counted twice (40)", twice.schoolCalendar(seriesRes(ON_FILE, thu, "2026-10-07T13:31:00Z"), thu, "2026-10-08T13:00:00Z").days === schoolDates("2026-10-07").length + 1);

  // THE WORD LIST AND THE FOLD SAY THE SAME RULE.
  const list = html.slice(html.indexOf('id="attGlossaryModal"'), html.indexOf("</dl>", html.indexOf('id="attGlossaryModal"')));
  check("the word list says today joins the count at the midday copy, and nothing says it never counts",
    /Today joins the count once PowerSchool&rsquo;s midday copy holds today&rsquo;s attendance/.test(list) && !/Today is not counted until it is over/.test(list));
}

console.log("\nB. Every consumer reads the same count");
{
  const res = seriesRes(ON_FILE, "2026-10-07", "2026-10-07T19:30:00Z");
  const { app } = world({ runCache: res, calHeld: res });
  const basis = app.attendanceSchoolDays();
  check("attendanceSchoolDays() is the calendar, in the { first, weekdays, off, days } shape it always had",
    basis.days === 38 && basis.first === "2026-08-12" && basis.weekdays === 40 && basis.off === 2 && basis.known === true);
  app.dropRunCache();
  check("the idle refresh drops the cache, but the screens still read the last count until the next fetch",
    app.attendanceSchoolDays().days === 38);
  const yearFn = liftFn(scriptSrc, "renderAttendanceWatch");
  const sgFn = liftFn(scriptSrc, "renderAttendanceSubgroups");
  const paFn = liftFn(scriptSrc, "renderPerfectAttendance");
  const ewFn = liftFn(scriptSrc, "renderEarlyWarning");
  check("Year so far ranks by it", /const basis = attendanceSchoolDays\(\);[\s\S]*R\.attendanceRanking\(rows, basis\.days\)/.test(yearFn));
  check("Student groups sends it to the server, and refuses to send a guess",
    /const basis = attendanceSchoolDays\(\);[\s\S]{0,300}if \(!basis\.known\)/.test(sgFn) && /loadAttendanceSubgroups\(force === true, basis\.days\)/.test(sgFn));
  check("Perfect attendance takes its first day from it", /R\.perfectWindows\(today, basis\.first\)/.test(paFn)
    && /R\.perfectMonths\(attTodayIso\(\), attendanceSchoolDays\(\)\.first\)/.test(liftFn(scriptSrc, "syncPerfectMonthPicker")));
  check("Early Warning scores by it, says so, and draws nothing against an unknown count",
    /const basis = attendanceSchoolDays\(\);/.test(ewFn) && /D\.riskRanking\(scoped\.map\(r => r\.row\), basis\.days/.test(ewFn)
    && /if \(basis\.known === false\) \{[\s\S]{0,700}return;/.test(ewFn) && /the days PowerSchool took attendance, the same count Attendance Watch uses/.test(ewFn)
    && !/set on Attendance Watch/.test(scriptSrc));
  check("...and Early Warning and every tab wait for the count before their first draw",
    /async function openEarlyWarning\(force\) \{\s*await ensureSchoolCalendar\(force === true\);/.test(scriptSrc)
    && /await ensureSchoolCalendar\(force === true\);\s*\/\/ Another tab was chosen/.test(liftFn(scriptSrc, "drawAttendanceView")));
  check("the idle refresh drops the series (so the next open refetches) and keeps _attCalHeld",
    /_runCache = null;/.test(scriptSrc.slice(scriptSrc.indexOf("AND THE SIS-BACKED SCREENS GO STALE"), scriptSrc.indexOf("Background data sync complete")))
    && (scriptSrc.match(/_attCalHeld = null/g) || []).length === 1);
  // The loader joins one load, and refetches when the day changed or after 30 minutes.
  const w = world({ series: res });
  await Promise.all([w.app.ensureSchoolCalendar(), w.app.ensureSchoolCalendar()]);
  check("two tabs asking at once share ONE read", w.G.seriesLoads === 1, String(w.G.seriesLoads));
  await w.app.ensureSchoolCalendar();
  check("...and a fresh copy is not read again", w.G.seriesLoads === 1);
  await w.app.ensureSchoolCalendar(true);
  check("...but Refresh reads it again", w.G.seriesLoads === 2);
  const stale = world({ series: res, runCache: res, calHeld: res, runFor: "2026-10-06", runFetchedAt: Date.now() });
  await stale.app.ensureSchoolCalendar();
  check("a copy fetched yesterday (a tab left open overnight) is read again", stale.G.seriesLoads === 1);
}

console.log("\nB. After lunch, every tab says the same count, whichever opened first");
{
  // 1 PM on 7 Oct: the 12:30 rebuild and the 12:00 totals. Perfect attendance,
  // Week or month and Trends never read the totals themselves, so a session
  // that opened on one of them said 38 (to yesterday) until Year so far was
  // opened, then 39 (review, 2026-10-07).
  const at1pm = new Date(2026, 9, 7, 13, 0).getTime();
  const series = seriesRes(ON_FILE, "2026-10-07", "2026-10-07T19:30:00Z");
  const rows = { allowed: true, rows: [], splitCoverage: 0, truncated: false, lastSyncedAt: "2026-10-07T19:00:00Z" };
  const said = (w) => (w.dom.els.attDataLine.innerHTML.match(/<b>(\d+) school days<\/b> so far \(([^)]*)\)/) || []).slice(1).join(" | ");
  for (const first of ["perfect", "window", "rate"]) {
    const w = world({ series, rows, now: at1pm });
    await w.app.setAttendanceView(first);
    // Perfect attendance's data line names the count; Week or month and Trends name their own sources, so ask the count.
    const firstSaid = first === "perfect" ? said(w) : String(w.app.attendanceSchoolDays().days) + " | " + w.app.attDaysRange(w.app.attendanceSchoolDays());
    await w.app.setAttendanceView("watch");
    check(`opened first on ${first}: 39 to today there and on Year so far, the totals read once`,
      firstSaid === "39 | Wed, Aug 12 to today" && said(w) === "39 | Wed, Aug 12 to today" && (w.G.rowLoads || []).length === 1,
      firstSaid + " / " + said(w) + " / " + JSON.stringify(w.G.rowLoads));
  }
  // The idle refresh drops the totals: the next draw reads them again before it counts.
  const w = world({ series, rows, now: at1pm });
  await w.app.setAttendanceView("perfect");
  w.app.set("attCache", null);
  await w.app.refreshAttendanceView();
  check("after the idle drop the next draw reads the totals again, and still says 39", said(w) === "39 | Wed, Aug 12 to today" && w.G.rowLoads.length === 2);
  const opener = makeEl("opener");
  w.app.openAttGlossary(opener);
  check("...and the word list's chronic line agrees (3.9 days)", /39 school days so far, that is 3\.9 days/.test(w.dom.els.attGlossaryChronic.textContent));
  // TEETH: without the totals read in ensureSchoolCalendar, Perfect opened first says 38.
  const broken = breakOnce(scriptSrc, "            if (!_attCache && !_attTotalsLoading) {\n", "            if (false) {\n", "totals");
  const b = world({ src: broken, series, rows, now: at1pm });
  await b.app.setAttendanceView("perfect");
  check("TEETH: without it, Perfect attendance opened first says 38, to yesterday", said(b) === "38 | Wed, Aug 12 to yesterday", said(b));
}

console.log("\nB. Student groups: the count matches the totals the server is about to divide");
{
  // The server (chronicBySubgroup) reads PowerSchool's LIVE year totals. An
  // admin who opened Year so far at 11:00 holds the 06:00 copy; at 1 PM the
  // server's totals are the 12:00 copy, which holds today.
  const at1pm = new Date(2026, 9, 7, 13, 0).getTime();
  const series = seriesRes(ON_FILE, "2026-10-07", "2026-10-07T19:30:00Z");
  const morning = { allowed: true, rows: [], lastSyncedAt: "2026-10-07T13:00:00Z" };
  const noon = { allowed: true, rows: [], lastSyncedAt: "2026-10-07T19:00:00Z" };
  const sg = (src) => liftFn(src, "renderAttendanceSubgroups") + `
    let _sgBusy = false;
    const SG_DEAD_BAND = 1.5;
    async function loadAttendanceSubgroups(force, days) {
      G.sgAsked = (G.sgAsked || []).concat([days]);
      const res = { allowed: true, baseline: { chronicPct: 50, chronic: 1, withAttendance: 2 }, rows: [], schoolDays: days,
                    smallGroupFloor: 10, chronicAt: 0.1, unavailable: [], suppressedGroups: 0 };
      _sgCache = { forDays: days, res: res };
      return res;
    }`;
  const run = async (src) => {
    const w = world({ src, series, attCache: morning, rows: noon, now: at1pm, override: sg(src) });
    await w.app.setAttendanceView("subgroup");
    return w;
  };
  const w = await run(scriptSrc);
  check("asking for the groups first reads the totals again, and sends 39 (today is in the server's totals)",
    (w.G.sgAsked || []).join() === "39" && (w.G.rowLoads || []).includes(true) && w.app.state._attCache === noon, JSON.stringify({ asked: w.G.sgAsked, loads: w.G.rowLoads }));
  check("...and the chip says 39, to today", /Aug 12 to today · 39 school days/.test(w.dom.els.attSubgroupBody.innerHTML));
  const loads = w.G.rowLoads.length;
  await w.app.setAttendanceView("watch");
  await w.app.setAttendanceView("subgroup");
  check("an answer already in hand is drawn as it is: no second read of the totals, nothing asked again",
    w.G.rowLoads.slice(loads).every((f) => f === false) && w.G.sgAsked.length === 1);
  const broken = breakOnce(scriptSrc, "            await loadAttendanceRows(asking);\n", "            await loadAttendanceRows(false);\n", "asking");
  const b = await run(broken);
  check("TEETH: with the morning copy kept, the server would divide the noon totals by 38", (b.G.sgAsked || []).join() === "38", JSON.stringify(b.G.sgAsked));
}

console.log("\nB. The loader: a refusal keeps the good copy, an emptied read is not kept, the first day is found past 120 days");
{
  const loader = (G, src, now) => new Function("G", `
    const Date = (function (Real, now) {
      return class extends Real { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } };
    })(globalThis.Date, ${now});
    const window = { WildcatAuth: { getSession: () => ({ idToken: "t" }), convexQuery: async (name, args) => G.server(name, args) } };
    const console = { log() {}, warn() {}, error() {} };
    let _runCache = null, _attCalHeld = null, _runFor = '', _runFetchedAt = 0;
    ${liftFn(src, "attTodayIso")}
    ${liftFn(src, "loadAbsenceSeries")}
    return { loadAbsenceSeries, get held() { return _attCalHeld; }, get run() { return _runCache; },
             get fetchedAt() { return _runFetchedAt; }, dropRun() { _runCache = null; } };`)(G);
  const serverOf = (file, stamp, G) => async (name, args) => {
    G.asked = (G.asked || []).concat([args.today]);
    if (G.fail) throw new Error(G.fail);
    if (G.emptied) return { allowed: true, reason: null, points: [], schoolDaysOnFile: 0, truncated: false, syncedAt: null };
    const usable = file.filter((d) => d <= args.today);
    return { allowed: true, reason: null, points: usable.slice(-args.days).map(pointFor), schoolDaysOnFile: usable.length, truncated: false, syncedAt: stamp };
  };

  // MORE THAN 120 SCHOOL DAYS: 2 March 2027.
  const march = "2027-03-02";
  const file = schoolDates("2027-03-01");
  const G = {};
  G.server = serverOf(file, "2027-03-02T14:30:00Z", G);
  const L = loader(G, scriptSrc, new Date(2027, 2, 2, 9, 0).getTime());
  await L.loadAbsenceSeries(true);
  const c = R.schoolCalendar(L.run, march);
  check(`past 120 school days (${file.length} on file) the first day is found by stepping back, and the count is whole`,
    file.length > 120 && L.run.firstDate === "2026-08-12" && c.known && c.first === "2026-08-12" && c.days === file.length && G.asked.length === 2,
    JSON.stringify({ first: L.run.firstDate, days: c.days, asked: G.asked }));
  const noStep = breakOnce(scriptSrc, "for (let step = 0; !firstDate && oldest && step < 3; step++) {", "for (let step = 0; false; step++) {", "step");
  const G2 = {};
  G2.server = serverOf(file, "2027-03-02T14:30:00Z", G2);
  const L2 = loader(G2, noStep, new Date(2027, 2, 2, 9, 0).getTime());
  await L2.loadAbsenceSeries(true);
  check("TEETH: without the step back, from about February the count is unknown on every tab", R.schoolCalendar(L2.run, march).known === false);

  // A REFUSAL AFTER A GOOD READ.
  const today = "2026-10-07";
  const H = {};
  H.server = serverOf(ON_FILE, "2026-10-07T19:30:00Z", H);
  const at1pm = new Date(2026, 9, 7, 13, 0).getTime();
  const M = loader(H, scriptSrc, at1pm);
  await M.loadAbsenceSeries(true);
  const good = M.held;
  H.fail = "401 Unauthorized";
  await M.loadAbsenceSeries(true);
  check("a refusal (an expired sign-in) after a good read keeps the good copy for the count", M.held === good && M.run === good && R.schoolCalendar(M.held, today).days === 38);
  M.dropRun();
  await M.loadAbsenceSeries(true);
  check("...even after the idle refresh dropped the series", M.held === good);
  const keepBroken = breakOnce(scriptSrc, "else if (!_attCalHeld || _attCalHeld.allowed === false) _attCalHeld = res;", "else _attCalHeld = res;", "keep");
  const K = {};
  K.server = serverOf(ON_FILE, "2026-10-07T19:30:00Z", K);
  const KL = loader(K, keepBroken, at1pm);
  await KL.loadAbsenceSeries(true);
  K.fail = "401 Unauthorized";
  await KL.loadAbsenceSeries(true);
  check("TEETH: a refusal that replaces the held copy makes the count unknown", KL.held.allowed === false);

  // AN EMPTIED READ (the rebuild's empty moment).
  const E = {};
  E.server = serverOf(ON_FILE, "2026-10-07T19:30:00Z", E);
  const EL = loader(E, scriptSrc, at1pm);
  await EL.loadAbsenceSeries(true);
  const firstRead = EL.held, stampedAt = EL.fetchedAt;
  E.emptied = true;
  await EL.loadAbsenceSeries(true);
  check("an emptied read is not kept: the good copy stays, and it is not marked fresh (the next draw asks again)",
    EL.held === firstRead && EL.run === firstRead && EL.fetchedAt === stampedAt);
  const emptyBroken = breakOnce(scriptSrc, "                if (emptied) {\n", "                if (false) {\n", "emptied");
  const F = {};
  F.server = serverOf(ON_FILE, "2026-10-07T19:30:00Z", F);
  const FL = loader(F, emptyBroken, at1pm);
  await FL.loadAbsenceSeries(true);
  F.emptied = true;
  await FL.loadAbsenceSeries(true);
  check("TEETH: without the guard, the emptied read replaces the series", (FL.run.points || []).length === 0);
}

console.log("\nB. The data line: each tab's own source, amber for everyone when the count is late, the rebuild verdict for admins");
{
  const ok = R.schoolCalendar(seriesRes(ON_FILE, "2026-10-07", "2026-10-07T19:30:00Z"), "2026-10-07");
  const late = R.schoolCalendar(seriesRes(schoolDates("2026-10-02"), "2026-10-07", "2026-10-02T19:30:00Z"), "2026-10-07");
  const unk = R.schoolCalendar(null, "2026-10-07");
  const { app } = world();
  const line = (v, c, h) => app.attDataLineHtml(v, c, { ytd: "2026-10-07T19:00:00Z", marks: "2026-10-07T19:31:00Z", daily: "2026-10-07T19:31:00Z", rate: "2026-10-07T10:16:00Z" }, h);
  check("Year so far names PowerSchool's totals and the count", /From PowerSchool&rsquo;s attendance totals, today at 12:00 PM/.test(line("watch", ok)) && /<b>38 school days<\/b>/.test(line("watch", ok)), line("watch", ok));
  check("Week or month names the twice-daily rebuild and the last finished day", /twice-daily absence rebuild, today at 12:31 PM &middot; finished days up to/.test(line("window", ok)));
  check("Trends names both charts' own builds", /built overnight from PowerSchool, today at 3:16 AM/.test(line("rate", ok)) && /Daily absences/.test(line("rate", ok)));
  check("normal running: no amber line", !/wc-att-stale/.test(line("watch", ok)));
  check("a late copy: the amber line, naming the weekdays counted", /wc-att-stale/.test(line("watch", late)) && /adds the 2 weekdays since/.test(line("watch", late)));
  check("an unknown count: the amber line says so", /The number of school days is unknown right now/.test(line("perfect", unk)));
  check("the rebuild verdict only when one is passed", !/Twice-daily absence rebuild/.test(line("watch", ok)) && /Twice-daily absence rebuild: <b>Attendance data is current/.test(line("watch", ok, { level: "ok", headline: "Attendance data is current" })));
  for (const [role, sees] of [["admin", true], ["superadmin", true], ["pbis", false], ["campusaide", false]]) {
    const w = world({ user: { id: role, role, attendanceWatch: role === "campusaide" }, verdict: { level: "ok", headline: "Attendance data is current" } });
    w.app.renderAttDataLine();
    check(`${role} ${sees ? "sees" : "does not see"} the rebuild verdict`, /Twice-daily absence rebuild/.test(w.dom.els.attDataLine.innerHTML) === sees);
  }
  // The late-copy line is for everyone who can open the tab.
  const gw = world({ user: { id: "C1", role: "campusaide", attendanceWatch: true }, runCache: seriesRes(schoolDates("2026-10-02"), "2026-10-07", "2026-10-02T19:30:00Z") });
  gw.app.renderAttDataLine();
  check("the grant sees the amber late-copy line too", /wc-att-stale/.test(gw.dom.els.attDataLine.innerHTML));
}

console.log("\nC. The daily chart stops at the last finished day");
{
  const today = "2026-10-07";
  const dates = schoolDates(today);
  const finished = R.finishedSeries(dates.map(pointFor), R.schoolCalendar(seriesRes(dates, today, "2026-10-07T19:30:00Z"), today), 30);
  check("after the 12:30 copy: today's half-taken day is not plotted, yesterday is the last point",
    finished.length === 30 && finished[finished.length - 1].date === "2026-10-06" && !finished.some((p) => p.date === today));
  const pre = R.finishedSeries(dates.map(pointFor), R.schoolCalendar(seriesRes(dates, today, "2026-10-06T19:30:00Z"), today), 30);
  check("before the morning copy: yesterday's lunchtime half-day is not plotted either", pre[pre.length - 1].date === "2026-10-05");
  // THE RENDERER, RUN.
  const run = async (syncedAt) => {
    const res = seriesRes(dates, today, syncedAt);
    const w = world({ runCache: res, calHeld: res });
    w.app.set("runCache", res);
    await w.app.renderAbsenceRunChart(false);
    return w.dom.els;
  };
  const els = await run("2026-10-07T19:30:00Z");
  const plotted = [...els.attRunChart.innerHTML.matchAll(/data-rc-date="([^"]+)"/g)].map((m) => m[1]);
  check("the chart draws 30 points, ending yesterday", plotted.length === 30 && plotted[29] === "2026-10-06" && !plotted.includes(today), plotted.slice(-3).join(","));
  check("its chip says so", /Tue, Oct 6|Tue 6 Oct|6 Oct/.test(els.attRunChips.innerHTML) && /30 finished school days/.test(els.attRunChips.innerHTML), els.attRunChips.innerHTML);
  check("its one-line answer is in words", /^Whole-day absences: /.test(els.attRunAnswer.textContent), els.attRunAnswer.textContent);
  check("the fold says up to which day, and that the two charts count different things",
    /data-fold="att-run-how"/.test(els.attRunFold.innerHTML) && /the last finished day/.test(els.attRunFold.innerHTML)
    && /Today is left off while its attendance is still being taken/.test(els.attRunFold.innerHTML) && /can disagree/.test(els.attRunFold.innerHTML));
  const els2 = await run("2026-10-06T19:30:00Z");
  const plotted2 = [...els2.attRunChart.innerHTML.matchAll(/data-rc-date="([^"]+)"/g)].map((m) => m[1]);
  check("before the morning copy the chart ends the day before yesterday", plotted2[plotted2.length - 1] === "2026-10-05");
  const broken = breakOnce(scriptSrc, "            const pts = ok ? R.finishedSeries(res.points, { finishedThrough: through }, 30) : [];",
    "            const pts = ok ? (res.points || []).slice(-30) : [];", "cut");
  const b = world({ src: broken });
  const res = seriesRes(dates, today, "2026-10-07T19:30:00Z");
  b.app.set("runCache", res);
  await b.app.renderAbsenceRunChart(false);
  check("TEETH: a chart that plots what the server sent draws today's half-taken day", b.dom.els.attRunChart.innerHTML.includes(`data-rc-date="${today}"`));
}

console.log("\nD. 'Last week' is one week on both tabs, weekends included");
{
  const cases = [
    ["Friday evening", "2026-10-02", "2026-09-21"], ["Saturday", "2026-10-03", "2026-09-28"],
    ["Sunday", "2026-10-04", "2026-09-28"], ["Monday", "2026-10-05", "2026-09-28"], ["Wednesday", "2026-10-07", "2026-09-28"],
  ];
  for (const [label, day, monday] of cases) {
    const a = R.absenceWindows(day).lastWeek, p = R.perfectWindows(day, "2026-08-12").week;
    check(`${label} (${day}): both tabs' "Last week" is the week of ${monday}`,
      a.from === monday && p.from === monday && a.to === p.to && a.label === "Last week" && p.label === "Last week", `${a.from} / ${p.from}`);
  }
  check("on a weekend 'This week so far' has no finished day", ["2026-10-03", "2026-10-04"].every((d) => { const t = R.absenceWindows(d).thisWeek; return t.from > t.to; }));
  check("on a Monday neither does it", (() => { const t = R.absenceWindows("2026-10-05").thisWeek; return t.from > t.to; })());
  check("'Last school day' is the newest finished school day from the calendar",
    R.absenceWindows("2026-10-05", null, "2026-10-02").lastDay.from === "2026-10-02" && R.absenceWindows("2026-10-05", null, "2026-10-02").lastDay.to === "2026-10-02");
  const old = loadRoster((s) => breakOnce(s, "    var from = weekend ? thisMonday : shiftDays(thisMonday, -7);", "    var from = shiftDays(thisMonday, -7);", "weekend"));
  check("TEETH: the old weekday-only rule puts Sunday's 'Last week' a week early",
    old.absenceWindows("2026-10-04").lastWeek.from === "2026-09-21");
}

// --------------------------------------------- the old buttons, as they stood at ebde323
/** Year so far's seven filter buttons, verbatim in effect. `rows` are attendanceRanking().ranked. */
function oldYear(ranked, splitBy, f) {
  let shown = ranked;
  const sp = (r) => splitBy[String((r.student || {}).studentNumber || "")];
  if (f === "chronicPlus") shown = shown.filter((r) => r.tier && (r.tier.key === "chronic" || r.tier.key === "severe"));
  else if (f === "severe" || f === "at-risk") shown = shown.filter((r) => r.tier && r.tier.key === f);
  else if (f === "fullDays") shown = shown.filter((r) => { const s = sp(r); return s && s.fullDays > 0; }).slice().sort((a, b) => ((sp(b) || { fullDays: 0 }).fullDays - (sp(a) || { fullDays: 0 }).fullDays));
  else if (f === "partialOnly") shown = shown.filter((r) => { const s = sp(r); return s && s.absentDays > 0 && s.fullDays === 0; }).slice().sort((a, b) => (b.daysAbsent || 0) - (a.daysAbsent || 0));
  else if (f === "tardy") shown = shown.filter((r) => (r.daysTardy || 0) > 0).slice().sort((a, b) => (b.daysTardy || 0) - (a.daysTardy || 0));
  return shown.map((r) => r.student.studentNumber);
}
/** Week or month's seven buttons. `rows` are windowAbsenceList().rows with splitBy. */
function oldWindow(rows, splitBy, f) {
  const spOf = (r) => { const s = splitBy[r.studentNumber] || null; return s && s.absentDays === r.daysAbsent ? s : null; };
  const fullOf = (r) => { const s = spOf(r); return s ? s.fullDays : -1; };
  const worstFirst = (a, b) => (b.daysAbsent - a.daysAbsent) || (fullOf(b) - fullOf(a)) || (a.daysTardy - b.daysTardy) || (b.rate - a.rate);
  let shown = rows.slice().sort(worstFirst);
  if (f === "absent") shown = shown.filter((r) => r.daysAbsent > 0);
  else if (f === "every") shown = shown.filter((r) => r.band.key === "every");
  else if (f === "half") shown = shown.filter((r) => r.band.key === "every" || r.band.key === "half");
  else if (f === "fullDays") shown = rows.filter((r) => { const s = spOf(r); return s && s.fullDays > 0; }).slice().sort((a, b) => (spOf(b).fullDays - spOf(a).fullDays) || (b.daysAbsent - a.daysAbsent));
  else if (f === "partialOnly") shown = rows.filter((r) => { const s = spOf(r); return s && s.absentDays > 0 && s.fullDays === 0; });
  else if (f === "tardy") shown = rows.filter((r) => r.daysTardy > 0).slice().sort((a, b) => (b.daysTardy - a.daysTardy) || (b.daysAbsent - a.daysAbsent));
  return shown.map((r) => r.studentNumber);
}
/** A deterministic school: 260 students, some with no split, some off the roster. */
function school(seed) {
  let a = seed;
  const rnd = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; };
  const rows = [], kids = [];
  for (let i = 0; i < 260; i++) {
    const n = "S" + String(1000 + i);
    const abs = Math.floor(rnd() * rnd() * 22);
    const full = Math.floor(abs * rnd());
    const split = rnd() < 0.12 ? null : { absentDays: abs, fullDaysStrict: full, misrecordDaysByGap: [0, 0, 0], partialDays: abs - full, assumedPresentDays: 0 };
    rows.push({ studentNumber: n, daysAbsent: rnd() < 0.02 ? null : abs, daysTardy: Math.floor(rnd() * rnd() * 14), split });
    if (rnd() < 0.9) kids.push({ id: "id" + i, studentNumber: n, firstName: "Kid", lastName: "L" + String(i).padStart(3, "0"), grade: String(6 + (i % 7)), enrolled: true });
  }
  return { rows, kids };
}

console.log("\nE. Year so far: the band chips and Kind of absence reach every old list, same students, same order");
{
  const S = school(7);
  // 10 AM on 7 Oct: the totals in hand are the 06:00 copy (the midday one is not out yet).
  const res = { allowed: true, rows: S.rows, splitCoverage: 230, truncated: false, lastSyncedAt: "2026-10-07T13:00:00Z" };
  const cal = seriesRes(ON_FILE, "2026-10-07", "2026-10-07T19:30:00Z");
  const { app, dom } = world({ students: S.kids, attCache: res, runCache: cal, calHeld: cal });
  const byNumber = Object.fromEntries(S.kids.map((k) => [k.studentNumber, k]));
  const splitBy = {};
  S.rows.forEach((r) => { const sp = R.absenceSplit(r.split, {}); if (sp) splitBy[r.studentNumber] = sp; });
  const ranked = R.attendanceRanking(S.rows.map((r) => ({ student: byNumber[r.studentNumber] || { studentNumber: r.studentNumber }, daysAbsent: r.daysAbsent, daysTardy: r.daysTardy })), 38);
  const listed = () => [...dom.els.attYearTable.innerHTML.matchAll(/openAttendanceDetail\('([^']+)'\)/g)].map((m) => m[1]);
  const map = [["chronicPlus", "chronicPlus", "any"], ["severe", "severe", "any"], ["at-risk", "at-risk", "any"],
    ["fullDays", "all", "whole"], ["partialOnly", "all", "partial"], ["tardy", "all", "tardy"], ["all", "all", "any"]];
  for (const [old, band, kind] of map) {
    app.setYear({ band, kind, all: true });
    await app.renderAttendanceWatch();
    const want = oldYear(ranked.ranked, splitBy, old);
    const got = listed();
    check(`old '${old}' = ${band} + ${kind}: ${want.length} students, same order`, got.join(",") === want.join(",") && want.length > 0, `${got.length} vs ${want.length}`);
  }
  app.setYear({ band: "chronicPlus", kind: "any", all: false });
  await app.renderAttendanceWatch();
  const chips = dom.els.attYearBands.innerHTML;
  const chip = (label) => Number((chips.match(new RegExp("<b>(\\d+)</b><span class=\"wc-band-l\">" + label + "<")) || [])[1]);
  check("the chips carry the old tier cards' counts",
    chip("Severe") === ranked.counts.severe && chip("Chronic") === ranked.counts.chronic && chip("At risk") === ranked.counts["at-risk"]
    && chip("Satisfactory") === ranked.counts.satisfactory && chip("Chronic and severe") === ranked.chronicOrWorse && chip("Everyone") === ranked.ranked.length);
  check("Chronic and severe is pressed by default", /aria-pressed="true" data-band="chronicPlus"/.test(chips));
  check("the default list is the old default list: chronic and severe, worst first",
    listed().join(",") === oldYear(ranked.ranked, splitBy, "chronicPlus").slice(0, 50).join(","));
  check("...the first 50 of them, with 'Show all'", listed().length === 50 && /Show all \d+/.test(dom.els.attYearTable.innerHTML));
  check("Everyone says how many are not on today's roster", new RegExp((S.rows.length - S.kids.length) + " not on today&rsquo;s roster").test(chips));
  const kindSel = dom.els.attYearKind.innerHTML;
  check("Kind of absence counts inside the chosen band", /Has tardies \(\d+\)/.test(kindSel) && new RegExp("Any absence \\(" + ranked.chronicOrWorse + "\\)").test(kindSel));
  check("the help line states the chronic line in days", dom.els.attChronicDays.textContent === "3.8");
  check("the chip names the window and the unit", /Aug 12 to yesterday · 38 school days|12 Aug to yesterday · 38 school days|to yesterday · 38 school days/.test(dom.els.attYearChips.innerHTML.replace(/\\u00b7/g, "·")), dom.els.attYearChips.innerHTML);

  // ONLY TODAY'S ROSTER.
  app.setYear({ band: "all", kind: "any", all: true, roster: true });
  await app.renderAttendanceWatch();
  const onRoster = ranked.ranked.filter((r) => r.student.id).length;
  check("'Only today's roster' leaves out the students the app does not enrol", listed().length === onRoster && listed().every((n) => byNumber[n]));
  app.setYear({ roster: false });

  // SEARCH LOOKS AT EVERYONE.
  const quiet = ranked.ranked.find((r) => r.tier.key === "satisfactory" && r.student.id);
  app.setYear({ band: "chronicPlus", kind: "any", all: false });
  dom.els.attYearSearch.value = quiet.student.lastName;
  await app.renderAttendanceWatch();
  check("a search finds a child outside the band, shaded and said",
    listed().includes(quiet.student.studentNumber) && /class="wc-att-out"/.test(dom.els.attYearTable.innerHTML)
    && /Searching everyone: 1 match, 1 of them outside &ldquo;Chronic and severe&rdquo;/.test(dom.els.attYearTable.innerHTML), dom.els.attYearTable.innerHTML.slice(0, 300));
  dom.els.attYearSearch.value = "";

  // GRADE SCOPES THE CHIPS TOO.
  app.setYear({ grade: "9", band: "all", all: true });
  await app.renderAttendanceWatch();
  check("a grade scopes the list, the chips and the counts", listed().every((n) => byNumber[n] && byNumber[n].grade === "9")
    && /Scoped to grade 9/.test(dom.els.attYearFoot.textContent));
  app.setYear({ grade: "all" });

  // AN UNKNOWN COUNT IS SAID, AND NOTHING IS RANKED.
  const u = world({ students: S.kids, attCache: res, runCache: seriesRes([], "2026-10-07", null) });
  await u.app.renderAttendanceWatch();
  check("with the count unknown, Year so far says so and draws no bands or names",
    /unknown right now/.test(u.dom.els.attYearTable.innerHTML) && !/openAttendanceDetail/.test(u.dom.els.attYearTable.innerHTML)
    && u.dom.els.attYearBands.innerHTML === "" && u.dom.els.attChronicDays.textContent === "—");
  // NO SCHOOL DAY YET (before the first day): known, 0. Said, not "No students match".
  const zero = seriesRes([], "2026-08-10", "2026-08-10T13:30:00Z", { points: [], schoolDaysOnFile: 0 });
  const z = world({ students: S.kids, attCache: res, runCache: zero, now: new Date(2026, 7, 10, 9, 0).getTime() });
  await z.app.renderAttendanceWatch();
  check("with no school day yet, Year so far says so, not 'No students match' or a 0.0-day line",
    /No school days are counted yet/.test(z.dom.els.attYearTable.innerHTML) && !/No students match/.test(z.dom.els.attYearTable.innerHTML)
    && !/openAttendanceDetail/.test(z.dom.els.attYearTable.innerHTML) && z.dom.els.attYearBands.innerHTML === ""
    && z.dom.els.attChronicDays.textContent === "—", z.dom.els.attYearTable.innerHTML.slice(0, 200) + " / " + z.dom.els.attChronicDays.textContent);
  // AFTER LUNCH: the midday totals hold today, and every line says 39, to today.
  const noon = Object.assign({}, res, { lastSyncedAt: "2026-10-07T19:00:00Z" });
  const pm = world({ students: S.kids, attCache: noon, runCache: cal, calHeld: cal, now: new Date(2026, 9, 7, 13, 0).getTime() });
  await pm.app.renderAttendanceWatch();
  check("after lunch the chip, the help line and the fold say 39 school days, to today",
    /Aug 12 to today · 39 school days/.test(pm.dom.els.attYearChips.innerHTML) && pm.dom.els.attChronicDays.textContent === "3.9"
    && /School days: 39 so far, Wed, Aug 12 to today/.test(pm.dom.els.attYearFold.innerHTML), pm.dom.els.attYearChips.innerHTML);
  // TEETH: kind order dropped -- 'Has tardies' then comes out worst first, not most tardies first.
  const broken = loadRoster((s) => breakOnce(s, "    if (kind === 'tardy') return stable(function (a, b) { return num(b.daysTardy) - num(a.daysTardy); });\n", "", "kind-order"));
  const t = world({ students: S.kids, attCache: res, runCache: cal, R: broken });
  t.app.setYear({ band: "all", kind: "tardy", all: true });
  await t.app.renderAttendanceWatch();
  check("TEETH: without the kind's own order, 'Has tardies' is not the old Tardies list",
    [...t.dom.els.attYearTable.innerHTML.matchAll(/openAttendanceDetail\('([^']+)'\)/g)].map((m) => m[1]).join(",") !== oldYear(ranked.ranked, splitBy, "tardy").join(","));
}

console.log("\nE. Week or month: the same for its seven buttons");
{
  const S = school(11);
  const days = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];
  let a = 3;
  const rnd = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; };
  const marks = S.rows.map((r, i) => ({ studentNumber: r.studentNumber, entryDate: rnd() < 0.05 ? "2026-09-30" : "2026-08-12",
    absentDates: i % 17 === 0 ? days.slice() : i % 11 === 0 ? days.slice(0, 3) : days.filter(() => rnd() < 0.18),
    tardyDates: days.filter(() => rnd() < 0.1) }));
  const win = R.absenceWindows("2026-10-07").lastWeek;
  const full = R.windowAbsenceList(marks, days, win);
  const splitBy = {};
  full.rows.forEach((r, i) => { if (i % 9) splitBy[r.studentNumber] = R.absenceSplit({ absentDays: i % 13 ? r.daysAbsent : r.daysAbsent + 1, fullDaysStrict: Math.floor(r.daysAbsent * ((i % 3) / 2)), misrecordDaysByGap: [0, 0, 0], partialDays: 0, assumedPresentDays: 0 }, {}); });
  // Each old button against its band + kind, on the new rows the renderer builds.
  const rows = full.rows.map((r) => { const s0 = splitBy[r.studentNumber] || null; const s = s0 && s0.absentDays === r.daysAbsent ? s0 : null; return Object.assign({}, r, { whole: s ? s.fullDays : null, splitAbsent: s ? s.absentDays : 0 }); });
  const map = [["absent", "some", "any"], ["every", "every", "any"], ["half", "half", "any"], ["fullDays", "all", "whole"],
    ["partialOnly", "all", "partial"], ["tardy", "all", "tardy"], ["all", "all", "any"]];
  for (const [old, band, kind] of map) {
    const got = R.attendanceListOrder(rows.filter((r) => R.windowBandMatch(band, r) && R.attendanceKindMatch(kind, r)), "window", kind).map((r) => r.studentNumber);
    const want = oldWindow(full.rows, splitBy, old);
    check(`old '${old}' = ${band} + ${kind}: ${want.length} students, same order`, got.join(",") === want.join(",") && want.length > 0, `${got.length} vs ${want.length}`);
  }
  check("the 'Late at least once' chip is the old Tardies set", rows.filter((r) => R.windowBandMatch("tardy", r)).map((r) => r.studentNumber).sort().join()
    === oldWindow(full.rows, splitBy, "tardy").slice().sort().join());
  check("the chips carry the old cards' counts (every, half or more, missed a day, late)",
    rows.filter((r) => R.windowBandMatch("every", r)).length === full.rows.filter((r) => r.band.key === "every").length
    && rows.filter((r) => R.windowBandMatch("half", r)).length === full.rows.filter((r) => r.band.key === "every" || r.band.key === "half").length
    && rows.filter((r) => R.windowBandMatch("some", r)).length === full.rows.filter((r) => r.daysAbsent > 0).length
    && rows.filter((r) => R.windowBandMatch("tardy", r)).length === full.rows.filter((r) => r.daysTardy > 0).length);
}

console.log("\nF. Sorting: the shared helper, the whole list before the cut, numbers highest first");
{
  const S = school(5);
  const res = { allowed: true, rows: S.rows, splitCoverage: 230, truncated: false };
  const cal = seriesRes(ON_FILE, "2026-10-07", "2026-10-07T19:30:00Z");
  const { app, dom } = world({ students: S.kids, attCache: res, runCache: cal, calHeld: cal });
  app.setYear({ band: "all", kind: "any", all: false });
  await app.renderAttendanceWatch();
  const tardyHead = (dom.els.attYearTable.innerHTML.match(/<button type="button" class="wc-sort-btn" data-sort-table="attYear" data-sort-col="5"[^>]*>/) || [""])[0];
  check("the headings are the shared helper's buttons, Tardies starting highest first", /data-sort-type="num" data-sort-first="desc" onclick="wcSortClick\(this\)"/.test(tardyHead), tardyHead);
  check("the table registers its redraw", app.state.redraws.has("attYear"));
  // Press Tardies: the WHOLE list is sorted, then cut to 50.
  const btn = makeEl("", { "data-sort-table": "attYear", "data-sort-col": "5", "data-sort-type": "num", "data-sort-first": "desc" });
  btn.closest = () => null;
  app.wcSortClick(btn);
  await new Promise((r) => setTimeout(r, 0));
  const tardies = [...dom.els.attYearTable.innerHTML.matchAll(/<tr[^>]*><th[\s\S]*?<\/th>(?:<td[^>]*>[\s\S]*?<\/td>){4}<td>(\d+|&mdash;)<\/td>/g)].map((m) => Number(m[1]));
  const maxAll = Math.max(...S.rows.filter((r) => r.daysAbsent !== null).map((r) => r.daysTardy));
  check("one press: most tardies first, over ALL students, not only the 50 that were on screen",
    tardies.length === 50 && tardies[0] === maxAll && tardies.every((t, i) => i === 0 || tardies[i - 1] >= t), tardies.slice(0, 6).join(","));
  check("...and says so above the table", /Sorted by Tardies this term, highest first/.test(dom.els.attYearTable.innerHTML));
  await app.renderAttendanceWatch();
  check("the sort survives a redraw (a keystroke, a refresh)", /Sorted by Tardies this term, highest first/.test(dom.els.attYearTable.innerHTML));
  await app.setAttendanceYearBand("severe");
  check("the sort survives a band change", /Sorted by Tardies this term, highest first/.test(dom.els.attYearTable.innerHTML));
  await app.setAttendanceGradeFilter("9");
  check("...and a grade change", /Sorted by Tardies this term, highest first/.test(dom.els.attYearTable.innerHTML));
  await app.setAttendanceGradeFilter("all");
  await app.showAllAttendanceYear(true);
  await app.setAttendanceYearBand("all");
  check("a band change goes back to the first 50 ('Show all' resets)", app.state._attYearAll === false && /Show all \d+/.test(dom.els.attYearTable.innerHTML));
  await app.showAllAttendanceYear(true);
  await app.setAttendanceGradeFilter("all");
  check("...and so does a grade change", app.state._attYearAll === false);
  app.setAttendanceYearKind("whole");
  await new Promise((r) => setTimeout(r, 0));
  check("choosing a kind hands the order back to that kind's own (most whole days first)", /Most whole days first/.test(dom.els.attYearTable.innerHTML));
  // PERFECT ATTENDANCE'S NAME HEADINGS order a shared name by the other one,
  // as the old Sort did (review, 2026-10-07): the list is read aloud.
  {
    const P = app.consts.ATT_PERFECT_COLS;
    const kids = [
      { firstName: "Zoe", lastName: "Diaz", gradeLevel: "6" }, { firstName: "Mia", lastName: "Diaz", gradeLevel: "7" },
      { firstName: "Ana", lastName: "Diaz", gradeLevel: "9" }, { firstName: "Ben", lastName: "Diaz", gradeLevel: "12" },
      { firstName: "Ana", lastName: "Cruz", gradeLevel: "8" }, { firstName: "", lastName: "", gradeLevel: "7" },
    ];
    // One press each (a second press on the same heading would reverse it).
    const by = (col) => { app.wcSortSet("attPerfectT" + col, col, P[col].type, ""); return app.wcSortItems("attPerfectT" + col, kids, (k, c) => P[c].text(k)).map((k) => (k.firstName + " " + k.lastName).trim() || "(blank)"); };
    const byLast = by(1), byFirst = by(0);
    check("Last name: shared surnames by first name, a blank last (Ana Cruz, Ana Diaz, Ben Diaz, Mia Diaz, Zoe Diaz)",
      byLast.join(", ") === "Ana Cruz, Ana Diaz, Ben Diaz, Mia Diaz, Zoe Diaz, (blank)", byLast.join(", "));
    check("First name: shared first names by surname (Ana Cruz before Ana Diaz)", byFirst.slice(0, 2).join(", ") === "Ana Cruz, Ana Diaz", byFirst.join(", "));
    check("...the same order the old Sort gave", byLast.slice(0, 5).join() === R.perfectSort(kids, "last").slice(0, 5).map((k) => k.firstName + " " + k.lastName).join()
      && byFirst.slice(0, 5).join() === R.perfectSort(kids, "first").filter((k) => k.firstName).map((k) => k.firstName + " " + k.lastName).join());
  }
  // Band sorts by severity, not A to Z.
  const order = app.wcSortItems("x", [{ t: "1" }, { t: "4" }, { t: "2" }, { t: "3" }], (r) => r.t);
  check("an unsorted table keeps its order", order.map((r) => r.t).join("") === "1423");
  app.wcSortSet("x", 0, "num", "desc");
  check("a numeric column pressed once with 'desc' first is highest first", app.wcSortItems("x", [{ t: "1" }, { t: "4" }, { t: "" }, { t: "3" }], (r) => r.t).map((r) => r.t).join(",") === "4,3,1,");
  check("Band's sort text is a severity rank", /text: r => String\(\{ severe: 4, chronic: 3, 'at-risk': 2, satisfactory: 1 \}/.test(liftConst(scriptSrc, "ATT_YEAR_COLS")));
  // Cash's tables register nothing and keep the in-place reorder.
  const w2 = world();
  const rows = [3, 1, 2].map((v, i) => ({ cells: [{ getAttribute: () => null, innerHTML: String(v) }], getAttribute: () => String(i) }));
  const appended = [];
  const table = { tBodies: [{ rows, appendChild: (r) => appended.push(r.cells[0].innerHTML) }], querySelectorAll: () => [] };
  const cashBtn = makeEl("", { "data-sort-table": "teacherActivity", "data-sort-col": "0" });
  cashBtn.closest = () => table;
  w2.app.wcSortClick(cashBtn);
  check("a Cash table (nothing registered) is still reordered in place, ascending first", appended.join("") === "123");
  // TEETH: sort only the rows on screen.
  const broken = breakOnce(scriptSrc, "            const ordered = wcSortItems('attYear', R.attendanceListOrder(list, 'year', _attYearKind),",
    "            const ordered = (x => x)(R.attendanceListOrder(list, 'year', _attYearKind),", "whole");
  const b = world({ src: broken, students: S.kids, attCache: res, runCache: cal });
  b.app.setYear({ band: "all", kind: "any" });
  b.app.wcSortSet("attYear", 5, "num", "desc");
  await b.app.renderAttendanceWatch();
  const bt = [...b.dom.els.attYearTable.innerHTML.matchAll(/<tr[^>]*><th[\s\S]*?<\/th>(?:<td[^>]*>[\s\S]*?<\/td>){4}<td>(\d+|&mdash;)<\/td>/g)].map((m) => Number(m[1]));
  check("TEETH: a table that ignores the heading shows a different first 50", bt.join() !== tardies.join());
}

console.log("\nG. The remembered tab: this browser tab, this person, cleared at sign-out");
{
  const { app, session, G } = world();
  await app.setAttendanceView("perfect");
  const saved = JSON.parse(session.m.get("wcAttendanceView") || "null");
  check("the open tab is remembered in sessionStorage, with whose it was, and no names", saved && saved.view === "perfect" && saved.who === "A1" && saved.win === "lastWeek");
  check("...and comes back for the same person", app.attRememberedView() === "perfect");
  app.set("currentUser", { id: "P2", role: "pbis" });
  check("...but not for the next person on the same Chromebook", app.attRememberedView() === "watch");
  app.set("currentUser", { id: "A1", role: "admin" });
  app.wcForgetTab();
  check("sign-out (wcForgetTab) forgets it", !session.m.has("wcAttendanceView"));
  const throwing = world({ storage: { throws: true } });
  let threw = null;
  try { await throwing.app.setAttendanceView("rate"); } catch (e) { threw = e; }
  check("storage that refuses (a private window) costs nothing: no error, the tab still opens", threw === null && throwing.app.state._attView === "rate");
  check("...and the remembered view falls back to Year so far", throwing.app.attRememberedView() === "watch");
  // The grant's remembered Student groups lands on Year so far.
  const g = world({ user: { id: "C1", role: "campusaide", attendanceWatch: true } });
  g.session.setItem("wcAttendanceView", JSON.stringify({ who: "C1", view: "subgroup", win: "lastMonth" }));
  await g.app.setAttendanceView(g.app.attRememberedView());
  check("a grant holder's remembered Student groups opens Year so far, and the period is kept",
    g.app.state._attView === "watch" && g.app.state._attWindow === "lastMonth");
  check("the switch is wired: opening Attendance Watch restores it",
    /subtab === 'attendance'\)\s*\{[\s\S]{0,320}setAttendanceView\(attRememberedView\(\)\)/.test(scriptSrc));
  check("wcForgetTab removes the attendance key", /removeItem\(WC_ATT_VIEW_KEY\)/.test(liftFn(scriptSrc, "wcForgetTab")));
  // Each tab's Grade select redraws that tab, not Year so far.
  for (const view of ["perfect", "window"]) {
    const gw = world();
    await gw.app.setAttendanceView(view);
    const from = gw.G.drawn.length;
    await gw.app.setAttendanceGradeFilter("7");
    check(`the Grade select on ${view === "perfect" ? "Perfect attendance" : "Week or month"} redraws that tab`, gw.G.drawn.slice(from).join() === view && gw.app.state._attGradeFilter === "7", gw.G.drawn.slice(from).join());
  }
  void G;
}

console.log("\nG. Teacher view and a change of person");
{
  // TEACHER VIEW leaves the admin's remembered tab alone (review, 2026-10-07).
  const preview = `
    let realUser = null;
    function isPreviewingTeacher() { return realUser !== null; }
    G.startPreview = (who) => { realUser = currentUser; currentUser = who; };
    G.endPreview = () => { currentUser = realUser; realUser = null; };`;
  const aide = { id: "C1", role: "campusaide", attendanceWatch: true };
  const run = async (src) => {
    const w = world({ src, override: preview });
    await w.app.setAttendanceView("window");
    await w.app.setAttendanceWindow("lastMonth");
    await w.app.setAttendanceView("rate");
    w.G.startPreview(aide);
    await w.app.setAttendanceView(w.app.attRememberedView());
    const asAide = w.app.state._attView;
    w.G.endPreview();
    return { w, asAide, back: w.app.attRememberedView(), win: w.app.state._attWindow };
  };
  const r = await run(scriptSrc);
  check("the previewed grant holder opens on Year so far (not the admin's tab)", r.asAide === "watch");
  check("...and when teacher view ends the admin's Trends and Last month come back", r.back === "rate" && r.win === "lastMonth", JSON.stringify(r.back) + " " + r.win);
  const broken = breakOnce(scriptSrc, "once the preview ends.\n            if (typeof isPreviewingTeacher === 'function' && isPreviewingTeacher()) return;\n", "once the preview ends.\n", "preview");
  const rb = await run(broken);
  check("TEETH: remembering during teacher view drops the admin on Year so far afterwards", rb.back === "watch");

  // A DIFFERENT PERSON ON THE PAGE: the named lists and Student groups are emptied.
  const viewer = `var _cashViewOwner = null;\n` + liftFn(scriptSrc, "cashViewerChanged");
  const fill = (w) => {
    ["attSubgroupBody", "attYearTable", "attWinTable", "attPerfectBody"].forEach((id) => { w.dom.getElementById(id).innerHTML = "<p>Kid L001, Kid L002</p>"; });
    w.app.set("sgCache", { forDays: 38, res: {} });
  };
  const lists = (w) => ["attSubgroupBody", "attYearTable", "attWinTable", "attPerfectBody"].map((id) => w.dom.getElementById(id).innerHTML).join("");
  const v = world({ override: viewer });
  await v.app.setAttendanceView("subgroup");
  check("cashViewerChanged runs the attendance wipe", /wipeAttendanceViews\(\)/.test(liftFn(scriptSrc, "cashViewerChanged")));
  fill(v);
  v.app.wipeAttendanceViews();
  check("the wipe empties Year so far, Week or month, Perfect attendance and Student groups, drops the groups and goes back to Year so far",
    lists(v) === "" && v.app.state._sgCache === null && v.app.state._attView === "watch");
  // Run through the real hook: same person, nothing goes; a new person, everything does.
  const hook = world({ override: viewer + "\nG.viewerChanged = () => cashViewerChanged();" });
  hook.G.viewerChanged();
  fill(hook);
  hook.G.viewerChanged();
  check("the same person again: nothing is emptied", lists(hook) !== "");
  hook.app.set("currentUser", aide);
  hook.G.viewerChanged();
  check("the next person (sign-out, sign-in, teacher view): every list is emptied before they can open anything", lists(hook) === "" && hook.app.state._sgCache === null);
  const unhooked = breakOnce(scriptSrc, "                if (typeof wipeAttendanceViews === 'function') wipeAttendanceViews();\n", "", "wipe");
  const h2 = world({ src: unhooked, override: `var _cashViewOwner = null;\n` + liftFn(unhooked, "cashViewerChanged") + "\nG.viewerChanged = () => cashViewerChanged();" });
  h2.G.viewerChanged();
  fill(h2);
  h2.app.set("currentUser", aide);
  h2.G.viewerChanged();
  check("TEETH: without the wipe the admin's lists stay in the page under the next person", lists(h2) !== "");
}
{
  // THE NEXT PERSON STARTS CLEAN: filters and search text reset at the wipe.
  const w = world({});
  w.app.setYear({ band: "severe", kind: "tardy", all: true, roster: true, grade: "9" });
  ["attYearSearch", "attWinSearch", "attPerfectSearch"].forEach((id) => { const el = w.dom.getElementById(id); if (el) el.value = "Kid"; });
  w.app.wipeAttendanceViews();
  const st = w.app.state;
  const clean = st._attYearBand === "chronicPlus" && st._attYearKind === "any" && st._attYearAll === false &&
    st._attGradeFilter === "all" && st._attWindow === "lastWeek";
  const boxes = ["attYearSearch", "attWinSearch", "attPerfectSearch"].map((id) => (w.dom.getElementById(id) || {}).value || "").join("");
  check("sign-out resets every Attendance Watch filter and empties the three search boxes", clean && boxes === "",
    JSON.stringify({ band: st._attYearBand, grade: st._attGradeFilter, win: st._attWindow, boxes }));
  const keep = breakOnce(scriptSrc, "            _attGradeFilter = 'all';\n            _attWindow = 'lastWeek';", "            _attWindow = 'lastWeek';", "reset");
  const k = world({ src: keep });
  k.app.setYear({ grade: "9" });
  k.app.wipeAttendanceViews();
  check("TEETH: without the reset the next person inherits grade 9", k.app.state._attGradeFilter === "9");
}

console.log("\nG. 'What moved where': once per person, the words by role");
{
  const { app, dom, local } = world();
  app.renderAttMovedNote();
  check("shown to an admin, naming Student groups", dom.els.attMovedNote.hidden === false && /Student groups/.test(dom.els.attMovedNote.innerHTML)
    && /Year so far/.test(dom.els.attMovedNote.innerHTML) && /start date and holiday boxes are gone/.test(dom.els.attMovedNote.innerHTML));
  app.dismissAttMovedNote();
  check("closing it remembers, per person", local.m.get("wcAttNavNote:A1") === "1" && dom.els.attMovedNote.hidden === true);
  app.renderAttMovedNote();
  check("...and it stays closed for that person", dom.els.attMovedNote.hidden === true);
  app.set("currentUser", { id: "C1", role: "campusaide", attendanceWatch: true });
  app.renderAttMovedNote();
  check("the next person still sees it, and the grant's words never mention Student groups",
    dom.els.attMovedNote.hidden === false && !/Student groups|student group/.test(dom.els.attMovedNote.innerHTML));
}

console.log("\nG. The word list");
{
  check("one dialog, opened from under the tab bar", /<div id="attGlossaryModal" class="modal hidden" role="dialog"/.test(html) && /onclick="openAttGlossary\(this\)"/.test(html));
  const list = html.slice(html.indexOf('id="attGlossaryModal"'), html.indexOf("</dl>", html.indexOf('id="attGlossaryModal"')));
  check("it defines every word the tabs use",
    ["School day", "Finished day", "Whole day, partial day", "Tardy", "Excused", "Promise Time", "Chronic", "Severe, at risk, satisfactory",
     "Run chart", "Median", "Signal", "Baseline", "Short week", "Sorting a table"].every((w) => list.includes("<dt>" + w + "</dt>")));
  check("...true to the code: 10%, 20%, 5%, 6 in a row, 5 going one way, 10 weeks, 25%",
    R.attendanceTier(0.10).key === "chronic" && R.attendanceTier(0.20).key === "severe" && R.attendanceTier(0.05).key === "at-risk"
    && /6 or more points in a row on one side of the median/.test(list) && /5 or more in a row going the same way/.test(list)
    && /at least 10 weeks/.test(list) && /more than 25% fewer/.test(list) && /\(k - runStart\) >= 6/.test(rosterSrc) && /count >= 5/.test(rosterSrc));
  check("...and says when today joins the count (the midday copy), as the count does", /Today joins the count once PowerSchool&rsquo;s midday copy/.test(list));
  const { app, dom } = world({ runCache: seriesRes(ON_FILE, "2026-10-07", "2026-10-07T19:30:00Z") });
  const opener = makeEl("opener");
  app.openAttGlossary(opener);
  check("opening it names today's chronic line in days", /38 school days so far, that is 3\.8 days/.test(dom.els.attGlossaryChronic.textContent)
    && !dom.els.attGlossaryModal.classList.contains("hidden"));
  app.closeAttGlossary();
  check("closing it hands focus back", opener.focused === 1 && dom.els.attGlossaryModal.classList.contains("hidden"));
  app.openAttGlossary(opener);
  app.attGlossaryKeydown({ key: "Enter" });
  check("another key leaves it open", !dom.els.attGlossaryModal.classList.contains("hidden"));
  app.attGlossaryKeydown({ key: "Escape" });
  check("Escape closes it, and focus goes back", dom.els.attGlossaryModal.classList.contains("hidden") && opener.focused === 2);
  check("...the thresholds it states are the code's: chronic 10%, severe 20%, at risk 5%",
    /10%/.test(list) && /20%/.test(list) && /5%/.test(list)
    && R.attendanceTier(0.0999).key === "at-risk" && R.attendanceTier(0.1999).key === "chronic" && R.attendanceTier(0.0499).key === "satisfactory");
}

console.log("\nA. The view-only grant reads, never sets");
{
  // Trends: the rate chart's admin tools, drawn for the roles only (run in
  // attendance-rate-chart.test.mjs); here, every edit path is gated.
  const body = liftFn(scriptSrc, "renderAttendanceRateBody");
  check("the From/To pickers, the candidate lines and every change button are drawn only for the roles",
    /if \(arCanEdit\) \{\s*baseHtml \+= '<div class="wc-ar-range">'/.test(body) && /if \(c && arCanEdit\)/.test(body)
    && /if \(c\.canFreeze && arCanEdit\)/.test(body) && /\(arCanEdit \? ' <button type="button" class="analytics-tab wc-ar-btn" onclick="retireAttendanceBaseline/.test(body)
    && /\(arCanEdit \? ' <button type="button" class="analytics-tab wc-ar-btn" onclick="removeAttendanceRateNote/.test(body)
    && /baseHtml \+= arCanEdit \? \('<div class="wc-ar-addnote">'/.test(body));
  check("...inside a closed fold, labelled read only for the grant",
    /cashFoldHtml\('att-rate-base', arCanEdit \? 'Baseline and marked dates' : 'Baseline and marked dates \(read only\)', baseHtml\)/.test(body));
  check("the server still refuses every change to anyone outside the roles",
    /canEditInsightSettings/.test(discSrc) && !D.canEditInsightSettings("campusaide") && D.canEditInsightSettings("pbis"));
  check("Early Warning's thresholds stay greyed out for the grant", /el\.disabled = !canEdit;/.test(scriptSrc));
  check("nothing on any Attendance Watch tab edits school data: the only inputs filter, search or choose a period",
    (() => {
      const pane = html.slice(html.indexOf('<div id="behaviorAttendance"'), html.indexOf("<!-- Early Warning Subtab"));
      const handlers = [...pane.matchAll(/on(?:change|input|click)="([a-zA-Z]+)\(/g)].map((m) => m[1]);
      const ok = new Set(["refreshAttendanceView", "setAttendanceView", "openAttGlossary", "setAttendanceYearKind", "setAttendanceGradeFilter",
        "renderAttendanceWatch", "setAttendanceWindow", "setAttendanceWindowKind", "renderAttendanceWindow", "setAttendanceRateMeasure",
        "setAbsenceRunSeries", "openPerfectAttendanceSheet", "setPerfectWindow", "setPerfectMonth", "renderPerfectAttendance"]);
      return handlers.every((h) => ok.has(h));
    })());
}

console.log("\nG. The breakdown dialog");
{
  const { app } = world();
  const res = {
    allowed: true, reason: null, studentNumber: "1001",
    day: { daysAbsentYtd: 3, daysAbsentTerm: 3, daysTardyTerm: 2, syncedAt: "2026-10-07T13:00:00.000Z" },
    rows: [{ sectionExpression: "1(A-E)", courseName: "Promise Time 6A", sectionNumber: "1", daysAbsent: 3, daysTardy: 1, attendanceRows: 9, lastAbsenceDate: "2026-10-01" },
           { sectionExpression: "2(A-E)", courseName: "Math", sectionNumber: "1", daysAbsent: 1, daysTardy: 0, attendanceRows: 9, lastAbsenceDate: "2026-09-29" }],
    sectionRows: 2,
    days: [{ date: "2026-09-29", blocksThatDay: 5, absentBlocks: 2, presentBlocks: 3, unrecordedBlocks: 0, absentSlots: ["1(A-E)", "2(A-E)"] },
           { date: "2026-10-01", blocksThatDay: 5, absentBlocks: 1, presentBlocks: 4, unrecordedBlocks: 0, absentSlots: ["1(A-E)"] },
           { date: "2026-09-10", blocksThatDay: 5, absentBlocks: 1, presentBlocks: 4, unrecordedBlocks: 0, absentSlots: ["1(A-E)"] }],
  };
  const out = app.renderAttendanceDetail(res, R, { win: { from: "2026-09-28", to: "2026-10-02", label: "Last week" } });
  check("each figure names its window", /days absent, year to date/.test(out) && /days tardy, this term/.test(out) && /Whole year so far/.test(out));
  check("opened from Week or month, the period is named and its dates shaded",
    /Opened from Last week: 2026-09-28 to 2026-10-02, shaded in Day by day/.test(out) && (out.match(/wc-att-hl/g) || []).length === 2);
  check("Day by day is in a CLOSED fold, every date, newest first",
    /<details class="wc-fold" data-fold="att-detail-days"><summary>Day by day \(3 dates, 2 in Last week\)<\/summary>/.test(out)
    && out.indexOf("2026-10-01") < out.indexOf("2026-09-29") && out.indexOf("2026-09-29") < out.indexOf("2026-09-10"));
  check("By period is a table whose headings sort (in place: it is all on screen)",
    /data-sort-table="attDetailPeriods" data-sort-col="1" data-sort-type="num" data-sort-first="desc" onclick="wcSortClick\(this\)"/.test(out)
    && /<td data-sort="2026-10-01">2026-10-01<\/td>/.test(out));
  check("opened from Year so far, nothing is shaded", !/wc-att-hl/.test(app.renderAttendanceDetail(res, R, {})));
  // THE OLD LIST'S ROW CLASS IS A TWO-AREA GRID (review, 2026-10-07): on a
  // table row it put Times absent beside the Period, stacked Tardies and Last
  // absent under it, and left values under the wrong headings.
  const trClasses = [...out.matchAll(/<tr class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
  const gridded = [...new Set(trClasses)].filter((c) => new RegExp("(^|\\n)\\." + c + " \\{[^}]*display: grid").test(css));
  check("By period's rows are table rows: no class on them makes a row a grid", trClasses.length >= 2 && gridded.length === 0, gridded.join(","));
  check("...the old list's grid class is still what it was (so the check above has teeth)", /\n\.wc-ad-row \{\s*display: grid;/.test(css));
  check("...the count in each cell is table-sized, and the never-taken note sits under it",
    /\.wc-ad-table tr\.wc-ad-prow \{ display: table-row; \}/.test(css) && /\.wc-ad-table \.wc-ad-abs \{ font-size: inherit; \}/.test(css)
    && /\.wc-ad-table \.wc-ad-sub \{ display: block;/.test(css));
  check("a row on Week or month passes its tab, so the dialog knows the period",
    /onclick="openAttendanceDetail\(\\'' \+\s*escapeHtml\(String\(st\.studentNumber \|\| ''\)\) \+ '\\', \\'window\\'\)"/.test(scriptSrc));
}

console.log("\nG. The shipped stamp and the suite");
{
  const stamps = [...html.matchAll(/\?v=([0-9a-z]+)/g)].map((m) => m[1]);
  check("all 26 cache stamps moved together, past the last shipped one (20261006e)",
    stamps.length === 26 && new Set(stamps).size === 1 && stamps[0] > "20261006e", [...new Set(stamps)].join(","));
  check("this test runs in npm test", /node attendance-nav\.test\.mjs/.test(pkg.scripts.test));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
