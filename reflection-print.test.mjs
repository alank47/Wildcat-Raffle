// The Reflection Room list on screen and on paper. Run: npm test
//
// WHAT CAN GO QUIETLY WRONG HERE (build spec 4.8, step 8a), each one a list
// that still looks plausible:
//
//   1. PRINTING A STALE LIST. The screen re-reads every 30 seconds, and the
//      half minute either side of the close is exactly when the list changes.
//      A Print button that draws from the array on screen sends a runner off
//      with a list the server has already moved past. So Print reads the
//      list AGAIN, records the print, and draws from that answer.
//   2. A PAGE THAT LOOKS FINAL WHEN IT IS NOT. Every page of a list not yet
//      made says NOT FINAL, and every page of a pilot list says PILOT, in the
//      header row that repeats on each printed page.
//   3. A NAME WHERE ONLY A DATE BELONGS. Chrome names a saved PDF after the
//      page title: "Reflection Room list 2026-10-13", never a student.
//   4. THE WRONG CLOCK. "As of 11:46" is the school's time, whatever zone the
//      Chromebook is set to.
//   5. A TEST LIST TAKEN FOR A REAL ONE (2026-10-08). A TEST list built from
//      a day's real marks (reflectionDemo.ts) says TEST ONLY in red on the
//      screen, "TEST — not for assignment" on every printed page and in the
//      PDF's name, offers no slips or changes-only sheet, and is never
//      recorded as printed (section 11).
//
// It runs the SHIPPED screen code: the Reflection Room block and the shared
// sort helpers are lifted out of script.js and run against a small fake DOM
// and a fake server. A regex over the source would pass with the code broken.
//
// TEETH: scripts/reflection-teeth.mjs prints from the array on screen without
// the fresh read, drops the NOT FINAL mark, and drops the school's time zone
// -- and for a TEST list drops its TEST mark, offers "Print changes only",
// names its PDF like a real list's and records its print -- one at a time,
// and requires the check named for each to FAIL.

// THE CHROMEBOOK IS IN TOKYO for this whole file: every time on screen and on
// paper must still read as Los Angeles time.
process.env.TZ = "Asia/Tokyo";

import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const scriptSrc = read("./script.js");
const htmlSrc = read("./index.html");
const disciplineSrc = read("./wildcat-discipline.js");
const pkg = JSON.parse(read("./package.json"));

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const J = (x) => JSON.stringify(x);

/** A named function's whole text out of script.js, braces matched past strings and comments. */
function lift(src, name) {
  const m = new RegExp("(?:async\\s+)?function " + name + "\\(").exec(src);
  if (!m) throw new Error("missing function " + name);
  let depth = 0;
  for (let k = src.indexOf("{", m.index + m[0].length); k < src.length; k++) {
    const ch = src[k], two = src.slice(k, k + 2);
    if (two === "//") { k = src.indexOf("\n", k); continue; }
    if (two === "/*") { k = src.indexOf("*/", k + 2) + 1; continue; }
    if (ch === "'" || ch === '"' || ch === "`") {
      k++;
      while (k < src.length && src[k] !== ch) k += src[k] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(m.index, k + 1); }
  }
  throw new Error("unbalanced function " + name);
}

/** The Reflection Room block of script.js, whole: from its header to the referral picker that follows it. */
function rrBlock(src) {
  const start = src.indexOf("        const RR_REFRESH_MS = 30000;");
  const end = src.indexOf("        // At most one roster fetch per visit to the referral form");
  if (start < 0 || end < start) throw new Error("the Reflection Room block was not found in script.js");
  return src.slice(start, end);
}

const SORT_FNS = ["escapeHtml", "wcSortCellText", "wcSortValue", "wcSortColumnType", "wcSortOrder", "wcSortSet", "wcSortTh", "wcSortItems"];

/** Just enough DOM, window and server for the Reflection Room pane and its sheet. */
function makeWorld(src, answer) {
  const listeners = {}, docListeners = {}, alerts = [], prints = [], children = [], timers = [], intervals = [], calls = [];
  let seq = 0;
  class El {
    constructor(tag) {
      this.tagName = tag; this.attrs = {}; this.style = {}; this.id = ""; this.className = ""; this.innerHTML = "";
      this.textContent = ""; this.hidden = false; this.disabled = false;
      const cls = new Set();
      this.classList = { add: (c) => cls.add(c), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c),
        toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) };
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    remove() { const i = children.indexOf(this); if (i >= 0) children.splice(i, 1); }
  }
  const classes = new Set();
  const body = {
    classList: { add: (c) => classes.add(c), remove: (...c) => c.forEach((x) => classes.delete(x)), contains: (c) => classes.has(c) },
    appendChild: (el) => { children.push(el); return el; },
  };
  const fixed = Object.fromEntries(["rrDayNote", "rrBanners", "rrList", "rrFoot", "rrPrintBtn", "rrPastWrap", "rrSlipsBtn", "rrChangesBtn", "rrReviewPill"]
    .map((id) => [id, new El("div")]));
  const document = {
    title: "Wildcat Hub",
    visibilityState: "visible",
    body,
    getElementById: (id) => fixed[id] || children.find((c) => c.id === id) || null,
    createElement: (tag) => new El(tag),
    querySelectorAll: () => [],
    addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
  };
  const window = {
    addEventListener: (t, f) => { const l = (listeners[t] = listeners[t] || []); if (!l.includes(f)) l.push(f); },
    removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
    print: () => { prints.push({ title: document.title, printing: classes.has("wc-printing"), sheet: children.find((c) => c.id === "wcPrintSheet")?.innerHTML ?? null }); },
    WildcatAuth: {
      getSession: () => ({ idToken: "tok" }),
      convexQuery: async (path, args) => { calls.push({ kind: "query", path, args, sheetOpen: !!children.find((c) => c.id === "wcPrintSheet") }); return structuredClone(answer.query(args)); },
      convexMutation: async (path, args) => { calls.push({ kind: "mutation", path, args }); return structuredClone(answer.mutation(args)); },
    },
  };
  let onScreen = true;
  const api = new Function(
    "window", "document", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "showAlert", "wcPanelOnScreen",
    "closePerfectAttendanceSheet", "students", "currentUser", "showToast", "showPrompt", "showConfirm",
    `const _wcSortState = new Map(), _wcSortRedraw = new Map();
    const WC_SORT_ARROWS = { none: '-', asc: '^', desc: 'v' };
    ${SORT_FNS.map((n) => lift(src, n)).join("\n\n")}
    ${rrBlock(src)}
    return {
      loadReflectionList, openReflectionRoom, reflectionRefreshTick, setReflectionView, renderReflectionRoom,
      printReflectionList, reflectionSheetHtml, reflectionSheetTitle, closeReflectionSheet, forgetReflectionRoom, rrClock,
      rrRowsInOrder, rrStudentIndex, printReflectionSlips, printReflectionChanges, reflectionSlipsHtml, reflectionChangesHtml,
      reflectionBeforePrint, reflectionPrintKeys, markReflectionNotHere, reflectionAttendanceDone, setReflectionView,
      setLoadedAt(ms) { _rrLoadedAt = ms; },
      sortBy(table, col, type) { wcSortSet(table, col, type || '', ''); },
      get data() { return _rrData; },
      get why() { return _rrWhy; },
    };`,
  )(window, document,
    (f) => { const id = ++seq; timers.push({ id, f }); return id; },
    (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    (f, ms) => { const id = ++seq; intervals.push({ id, f, ms }); return id; },
    (id) => { const i = intervals.findIndex((t) => t.id === id); if (i >= 0) intervals.splice(i, 1); },
    (m) => { alerts.push(String(m)); return Promise.resolve(); },
    () => onScreen,
    () => {},
    STUDENTS, { name: "Pat Supervisor", email: "pat@school.test" },
    (m, kind) => { alerts.push("toast:" + String(m)); },
    async () => (answer.prompt ? answer.prompt() : null),
    async () => true);
  return {
    app: api, document, window, fixed, alerts, prints, children, timers, intervals, calls, listeners, docListeners,
    sheet: () => children.find((c) => c.id === "wcPrintSheet") || null,
    setOnScreen(v) { onScreen = v; },
    fire: (t) => (listeners[t] || []).slice().forEach((f) => f()),
  };
}

// --------------------------------------------------------------- fixtures
const STUDENTS = [
  { studentNumber: "1001", firstName: "Ana", lastName: "Diaz" },
  { studentNumber: "1002", firstName: "Ben", lastName: "Alvarez" },
  { studentNumber: "1003", firstName: "Cy", lastName: "Moss" },
  { studentNumber: "1004", firstName: "Dee", lastName: "Zane" },
  { studentNumber: "2001", firstName: "Xia", lastName: "Lopez" },
  { studentNumber: "1009", firstName: "New", lastName: "Comer" },
];
const row = (sn, over) => Object.assign({
  key: "u" + sn, unitId: null, studentNumber: sn, grade: "7", division: "ms", mode: "shadow", state: "so-far",
  pu: { teacher: "Ms Ruiz", course: "Power Up 7A", flag: null, check: false }, notOnRoster: false,
  lines: ["Tue 10/13: Tardy P2 (Ms Ng)"], tags: [], owes: 1, absentMorning: false,
  released: null, cleared: [], voided: [], after: null,
}, over || {});
const RES = (over) => Object.assign({
  allowed: true, ok: true, roles: true, date: "2026-10-13", dayLabel: "Tue 10/13", isToday: true, isNext: false,
  today: "2026-10-13", asOf: "2026-10-13T18:31:05.000Z", view: "so-far", frozen: false, frozenAt: null, freezeKind: null,
  noList: null, lastGoodReadAt: "2026-10-13T18:25:00.000Z", kind: "regular",
  times: { close: "11:45", ready: "12:00", lastFreeze: "12:21", powerUp: "12:31" },
  mode: { ms: "shadow", hs: "live" },
  sections: [
    { division: "ms", label: "Middle school (grades 6-8)", mode: "shadow", pullAt: "12:31", count: 3, capacity: null, rows: [
      row("1001", { lines: ["Tue 10/13: Tardy P2 (Ms Ng)", "Tue 10/13: Uniform 7:52 AM"] }),
      row("1002", { pu: { teacher: "Mr Abel", course: "RSP A", flag: "RSP", check: false } }),
      row("1003", { absentMorning: true }),
      row("1004", { state: "released", released: { at: "2026-10-13T18:20:00.000Z", reason: "now Excused Tardy" } }),
    ] },
    { division: "hs", label: "High school (grades 9-12)", mode: "live", pullAt: "12:57", count: 1, capacity: 12, rows: [
      row("2001", { grade: "10", division: "hs", mode: "live", pu: { teacher: "Ms Cruz", course: "Power Up 10A", flag: null, check: false } }),
    ] },
  ],
  listVersion: "4:aaaa", banners: [{ id: "not-final", level: "warn", text: "NOT FINAL: do not pull from this." }],
  review: null, myPrintChanges: null, printsToday: null,
}, over || {});
const FRESH = () => {
  const r = RES({ asOf: "2026-10-13T18:46:10.000Z", view: "made", frozen: true, frozenAt: "2026-10-13T18:45:20.000Z", freezeKind: "closing",
    listVersion: "5:bbbb", banners: [] });
  r.sections[0].rows.push(row("1009", { unitId: "reflectionUnits:9", key: "reflectionUnits:9", state: "listed" }));
  r.sections.forEach((s, j) => s.rows.forEach((x, i) => { if (!x.unitId) { x.unitId = `reflectionUnits:${j}${i}`; x.key = x.unitId; } }));
  r.sections[0].count = 4;
  return r;
};
const sheetPages = (html) => String(html).split('<section class="print-page').slice(1);
const namesIn = (html) => [...String(html).matchAll(/<tr><td class="print-check"><\/td><td>([^<]*)<\/td>/g)].map((m) => m[1]);

// ======================================================================
console.log("\n1. PRINT WAITS FOR A FRESH READ\n");
// ======================================================================
{
  let answer = RES();
  const w = makeWorld(scriptSrc, {
    query: () => answer,
    mutation: (a) => ({ ok: true, id: "reflectionPrints:1", final: true, at: "2026-10-13T18:46:12.000Z", args: a }),
  });
  await w.app.loadReflectionList();
  check("the screen draws the list it was given (so far, 11:31)", w.app.data?.asOf === "2026-10-13T18:31:05.000Z" && /Ana/.test(w.fixed.rrList.innerHTML));
  answer = FRESH();            // the list is made at 11:45, with a student entered at 11:33
  w.calls.length = 0;
  await w.app.printReflectionList();
  const sheet = w.sheet();
  const q = w.calls.findIndex((c) => c.kind === "query" && c.path === "reflectionList:listForDay");
  const m = w.calls.findIndex((c) => c.kind === "mutation" && c.path === "reflectionList:recordPrint");
  check("Print waits for a fresh read: the sheet is drawn from a new listForDay answer, never the list on screen",
    q === 0 && !w.calls[q].sheetOpen && m === 1 && w.prints.length === 1 && /Comer, New/.test(w.prints[0].sheet)
      && /Final/.test(w.prints[0].sheet) && !/NOT FINAL: do not pull/.test(w.prints[0].sheet),
    J({ calls: w.calls.map((c) => c.path), prints: w.prints.length }));
  const rec = w.calls[m]?.args;
  check("...and the print is recorded from that same answer: its version, its unit ids and student numbers, never a name",
    rec && rec.day === "2026-10-13" && rec.kind === "master" && rec.listVersion === "5:bbbb"
      && J(rec.studentNumbers.slice().sort()) === J(["1001", "1002", "1003", "1009", "2001"])
      && rec.unitIds.length === 5 && J(Object.keys(rec).sort()) === J(["day", "kind", "listVersion", "studentNumbers", "unitIds"])
      && !/Ana|Diaz|Comer/.test(J(rec)), J(rec));
  check("...the released student is on the screen, struck off, and never on the paper",
    /Zane, Dee/.test(w.fixed.rrList.innerHTML) && /Released: now Excused Tardy/.test(w.fixed.rrList.innerHTML)
      && !/Zane/.test(w.prints[0].sheet) && !rec.studentNumbers.includes("1004"));
  check("the PDF title is the list's day, never a name, and only while printing",
    w.app.reflectionSheetTitle(answer) === "Reflection Room list 2026-10-13" && w.prints[0].title === "Reflection Room list 2026-10-13"
      && w.prints[0].printing === true);
  w.fire("afterprint");
  check("...the title and the print class come back when the dialog closes", w.document.title === "Wildcat Hub" && !w.document.body.classList.contains("wc-printing"));
  check("...and the sheet marks itself, so the purchase list's late redraw steps aside",
    sheet && sheet.getAttribute("data-sheet") === "reflection" && /data-rr-sheet/.test(sheet.innerHTML));
  w.app.closeReflectionSheet();
  check("Close takes the sheet away", w.sheet() === null);

  // A print the server would not record is not printed.
  const w2 = makeWorld(scriptSrc, {
    query: () => FRESH(),
    mutation: () => ({ ok: false, reason: "Slips print only once the list is final." }),
  });
  await w2.app.printReflectionList();
  check("a print that could not be recorded is not printed, and says why",
    w2.prints.length === 0 && w2.sheet() === null && /could not be recorded/.test(w2.alerts[0] || "") && /only once the list is final/.test(w2.alerts[0] || ""), J(w2.alerts));
}

// ======================================================================
console.log("\n2. EVERY PAGE SAYS WHAT IT IS\n");
// ======================================================================
{
  const w = makeWorld(scriptSrc, { query: () => RES(), mutation: () => ({ ok: true }) });
  const html = w.app.reflectionSheetHtml(RES(), { byNumber: w.app.rrStudentIndex(), printedBy: "Pat Supervisor", printedAt: "2026-10-13T18:31:07.000Z" });
  const pages = sheetPages(html);
  const marks = pages.map((p) => (/<th colspan="8" class="rr-watermark">([^<]*)<\/th>/.exec(p) || [])[1] || "");
  check("PILOT and NOT FINAL watermarks: a pilot list not yet final says both on every MS page, NOT FINAL on HS",
    pages.length === 2 && marks[0] === "PILOT: do not assign · NOT FINAL: do not pull" && marks[1] === "NOT FINAL: do not pull"
      && pages.every((p) => /<thead><tr><th colspan="8" class="rr-watermark">/.test(p)), J(marks));
  const finalHtml = w.app.reflectionSheetHtml(RES({ frozen: true, frozenAt: "2026-10-13T18:45:20.000Z", view: "made",
    sections: RES().sections.map((s) => ({ ...s, mode: "live" })) }), { byNumber: {}, printedBy: "Pat" });
  check("...and a final live list carries neither", !/rr-watermark/.test(finalHtml) && /Final/.test(finalHtml));
  check("MS prints first (pulled at the block start), then HS, each on its own page with its count and pull time",
    /Middle school/.test(pages[0]) && /High school/.test(pages[1])
      && /As of 11:31 AM · NOT FINAL · 4 students \(MS 3, HS 1 of 12\) · pull at about 12:31/.test(pages[0])
      && /pull at about 12:57/.test(pages[1]), pages.map((p) => (/<p class="print-sub">([^<]*)</.exec(p) || [])[1]).join(" | "));
  check("the columns: an empty Served box, then student, number, grade, Power-Up, violations with dates, tag, absent this morning",
    /<th>Served<\/th><th>Student<\/th><th>Student #<\/th><th>Grade<\/th><th>Power-Up<\/th><th>Violations<\/th><th>Tag<\/th><th>Absent this morning: check if arrived<\/th>/.test(pages[0])
      && /Tue 10\/13: Tardy P2 \(Ms Ng\)<\/div><div>Tue 10\/13: Uniform 7:52 AM/.test(pages[0]));
  check("an RSP student is pulled like anyone, and the row tells the runner which room",
    /Mr Abel <div class="print-note">RSP A<\/div> <span class="rr-flag">RSP: pull from this class<\/span>/.test(pages[0]));
  check("the footer says who printed it and when, in school time",
    /Printed by Pat Supervisor at 11:31 AM on Tue 10\/13/.test(pages[0]));
}

// ======================================================================
console.log("\n3. THE SCHOOL'S CLOCK, AND THE SCREEN'S ORDER ON PAPER\n");
// ======================================================================
{
  const w = makeWorld(scriptSrc, { query: () => RES(), mutation: () => ({ ok: true, at: "2026-10-13T18:31:07.000Z" }) });
  check("times use LA time, never this Chromebook's (the test runs in Tokyo)",
    w.app.rrClock("2026-10-13T18:46:00.000Z") === "11:46 AM" && w.app.rrClock("2026-11-02T19:45:00.000Z") === "11:45 AM"
      && new Date("2026-10-13T18:46:00.000Z").getHours() !== 11, w.app.rrClock("2026-10-13T18:46:00.000Z"));
  await w.app.loadReflectionList();
  const order = (html) => [...String(html).matchAll(/<tr(?: class="rr-released")?><td><b>([^<]*)<\/b>/g)].map((m) => m[1]);
  const screen = order(w.fixed.rrList.innerHTML);
  check("each section is in Power-Up teacher order, then student",
    J(screen) === J(["Alvarez, Ben", "Diaz, Ana", "Moss, Cy", "Zane, Dee", "Lopez, Xia"]), J(screen));
  w.app.sortBy("rrMs", 1, "num");
  w.app.sortBy("rrMs", 1, "num");           // a second press: highest student number first
  w.app.renderReflectionRoom();
  const sorted = order(w.fixed.rrList.innerHTML);
  await w.app.printReflectionList();
  const paper = namesIn(w.prints[0]?.sheet);
  check("click-to-sort uses the shared wcSort helpers, and the paper keeps the screen's order",
    J(sorted.slice(0, 4)) === J(["Zane, Dee", "Moss, Cy", "Alvarez, Ben", "Diaz, Ana"]) && /wc-sort-btn" data-sort-table="rrMs"/.test(w.fixed.rrList.innerHTML)
      && J(paper) === J(["Moss, Cy", "Alvarez, Ben", "Diaz, Ana", "Lopez, Xia"]), J({ sorted, paper }));
}

// ======================================================================
console.log("\n4. FRESH WITHOUT ASKING ANYONE TO REFRESH\n");
// ======================================================================
{
  const w = makeWorld(scriptSrc, { query: () => RES(), mutation: () => ({ ok: true }) });
  w.app.openReflectionRoom();
  await new Promise((r) => setImmediate(r));
  const reads = () => w.calls.filter((c) => c.path === "reflectionList:listForDay").length;
  const n0 = reads();
  check("opening the pane reads the list and starts ONE 30-second timer", n0 === 1 && w.intervals.length === 1 && w.intervals[0].ms === 30000);
  w.app.openReflectionRoom();
  check("...a second visit does not start a second timer", w.intervals.length === 1);
  const before = reads();
  w.intervals[0].f(); await new Promise((r) => setImmediate(r));
  const onTick = reads() - before;
  w.setOnScreen(false); w.intervals[0].f(); await new Promise((r) => setImmediate(r));
  const offScreen = reads() - before - onTick;
  w.setOnScreen(true); w.document.visibilityState = "hidden"; w.intervals[0].f(); await new Promise((r) => setImmediate(r));
  const hidden = reads() - before - onTick - offScreen;
  w.document.visibilityState = "visible";
  (w.docListeners.visibilitychange || []).forEach((f) => f()); await new Promise((r) => setImmediate(r));
  const visible = reads() - before - onTick - offScreen - hidden;
  check("the timer reads only while the pane is on screen and the tab visible; becoming visible reads at once",
    onTick === 1 && offScreen === 0 && hidden === 0 && visible === 1, J({ onTick, offScreen, hidden, visible }));
  w.app.forgetReflectionRoom();
  check("sign-out takes the list and the timer with the person leaving", w.intervals.length === 0 && w.app.data === null && w.fixed.rrList.innerHTML === "");

  const refused = makeWorld(scriptSrc, { query: () => ({ allowed: false, reason: "The Reflection Room list is limited to administrators." }), mutation: () => ({}) });
  await refused.app.loadReflectionList();
  check("a refused viewer sees the reason, not a list", /limited to administrators/.test(refused.fixed.rrList.innerHTML) && refused.app.data === null
    && refused.fixed.rrPrintBtn.disabled === true);
}

// ======================================================================
console.log("\n5. WIRING\n");
// ======================================================================
{
  check("the Discipline subtab, its pane, and its opener are wired",
    /\{ id: 'reflection', fn: 'switchDisciplineTab', label: wcIcon\('list'\) \+ ' Reflection Room' \}/.test(scriptSrc)
      && /reflection: \{ pane: 'behaviorReflection', btn: null \}/.test(scriptSrc)
      && /\} else if \(subtab === 'reflection'\) \{\s*openReflectionRoom\(\);/.test(scriptSrc));
  check("the pane has every element the screen draws into",
    ["behaviorReflection", "rrPrintBtn", "rrViewFilter", "rrPastWrap", "rrPastDay", "rrDayNote", "rrBanners", "rrList", "rrFoot"]
      .every((id) => htmlSrc.includes(`id="${id}"`)));
  const D = (() => { const g = {}; new Function("globalThis", "window", disciplineSrc).call(g, g, g); return g.WildcatDiscipline || globalThis.WildcatDiscipline; })();
  check("the tab is drawn for admin, superadmin and PBIS, never for a teacher, an aide or an Attendance Watch grant",
    ["admin", "superadmin", "pbis"].every((r) => D.canOpenDisciplineTab(r, "reflection"))
      && !D.canOpenDisciplineTab("teacher", "reflection") && !D.canOpenDisciplineTab("campusaide", "reflection")
      && !D.canOpenDisciplineTab("campusaide", "reflection", { role: "campusaide", attendanceWatch: true }));
  const logout = lift(scriptSrc, "logout");
  check("sign-out closes the sheet and forgets the list, inside the confirmed branch",
    /if \((?:inactive \|\| )?await showConfirm\([^)]*\)\) \{[\s\S]*forgetReflectionRoom\(\);[\s\S]*\}/.test(logout));
  check("the purchase-list guard has been widened: any sheet that marks itself is left alone",
    /if \(!sheet \|\| sheet\.getAttribute\('data-sheet'\)\) return;/.test(lift(scriptSrc, "renderPurchaseListSheet")));
  const block = rrBlock(scriptSrc).replace(/^\s*\/\/.*$/gm, "");
  check("no time on this screen is read off the Chromebook's own clock",
    !/toLocaleTimeString\(\s*\[\]|toLocaleString\(\s*\[\]|getHours\(|getMinutes\(/.test(block) && /timeZone: RR_TZ/.test(block));
  check("the sheet's title is built from the date alone",
    /return 'Reflection Room list ' \+ String\(res && res\.date \|\| ''\);/.test(lift(scriptSrc, "reflectionSheetTitle")));
  check("this test runs in npm test", /&& node reflection-print\.test\.mjs\b/.test(pkg.scripts.test));
}

// ======================================================================
console.log("\n6. PULL SLIPS: FINAL LISTS ONLY, FOUR FIELDS ONLY\n");
// ======================================================================
{
  let answer = RES();
  const recorded = [];
  const w = makeWorld(scriptSrc, {
    query: () => answer,
    mutation: (a) => { recorded.push(a); return { ok: true, id: "reflectionPrints:2", final: true, at: "2026-10-13T18:50:00.000Z" }; },
  });
  await w.app.loadReflectionList();
  const disabledEarly = w.fixed.rrSlipsBtn.disabled === true;
  await w.app.printReflectionSlips();
  check("slips are disabled while the list is not final: the button is off, and pressing it prints and records nothing",
    disabledEarly && w.prints.length === 0 && recorded.length === 0 && w.sheet() === null
      && /only once the list is final/.test(w.alerts[0] || ""), J({ disabledEarly, prints: w.prints.length, alerts: w.alerts }));

  answer = FRESH();
  answer.sections[0].rows.find((r) => r.studentNumber === "1003").pu = { teacher: "Ms Ruiz", course: "Power Up 7A", flag: null, check: false };
  await w.app.loadReflectionList();
  check("...and on once it is final", w.fixed.rrSlipsBtn.disabled === false);
  await w.app.printReflectionSlips();
  const sheet = w.prints[0]?.sheet || "";
  check("a final list prints slips, recorded as a slips print from a fresh read",
    w.prints.length === 1 && recorded.length === 1 && recorded[0].kind === "slips" && w.prints[0].title === "Reflection Room slips 2026-10-13",
    J({ prints: w.prints.length, recorded }));
  const rowCells = [...sheet.matchAll(/<tr data-rr-slip-row>((?:<td>[^<]*<\/td>)*)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<td>([^<]*)<\/td>/g)].map((x) => x[1]));
  check("slips contain only the four fields: name, student number, grade, 'Reflection Room today'",
    rowCells.length === 5 && rowCells.every((c) => c.length === 4 && /^Grade \d+$/.test(c[2]) && c[3] === "Reflection Room today")
      && !/Tardy|Uniform|Ms Ng|loaner|Absent this morning|students?\b \(|PILOT: do not assign/.test(sheet.replace(/<h2>[^<]*<\/h2>/g, "")),
    J(rowCells));
  const outs = [...sheet.matchAll(/<div class="rr-slip-out">([^<]*)(?: <span class="rr-slip-extra">([^<]*)<\/span>)?<\/div>/g)].map((m) => [m[1], m[2] || ""]);
  check("several teachers to a page, one slip each, alphabetical, each folding to the teacher's name only",
    J(outs) === J([["Mr Abel", "RSP A (RSP)"], ["Ms Ruiz", ""], ["Ms Cruz", ""]]) && (sheet.match(/class="rr-slip"/g) || []).length === 3, J(outs));
  check("an RSP student is pulled like anyone: the slip names the class they are actually in, flagged",
    /Mr Abel <span class="rr-slip-extra">RSP A \(RSP\)<\/span>/.test(sheet));
  check("MS slips first, then HS, each headed with its pull time; the released student gets none",
    /Middle school \(grades 6-8\) — pull at about 12:31/.test(sheet) && sheet.indexOf("Middle school") < sheet.indexOf("High school")
      && /High school \(grades 9-12\) — pull at about 12:57/.test(sheet) && !/Zane/.test(sheet));
  check("the slips button prints from its own fresh read, never the list on screen",
    /async function printReflectionSlips\(\) \{[\s\S]*?const answer = await loadReflectionList\(\);[\s\S]*?if \(answer\.frozen !== true\) \{/.test(scriptSrc));
}

// ======================================================================
console.log("\n7. PRINT CHANGES ONLY\n");
// ======================================================================
{
  const answer = FRESH();
  answer.myPrintChanges = { printAt: "2026-10-13T18:31:07.000Z", kind: "master", final: false, count: 2, outOfDate: true,
    added: ["1009"], release: [{ studentNumber: "1004", reason: "now Excused Tardy" }], cleared: [], voided: [] };
  const recorded = [];
  const w = makeWorld(scriptSrc, { query: () => answer, mutation: (a) => { recorded.push(a); return { ok: true, at: "2026-10-13T18:52:00.000Z" }; } });
  await w.app.loadReflectionList();
  check("Print changes only is offered when this person's own print is out of date", w.fixed.rrChangesBtn.hidden === false);
  await w.app.printReflectionChanges();
  const sheet = w.prints[0]?.sheet || "";
  check("it prints only the rows added since their print, with the list's columns, and a release list",
    /Changes since your 11:31 AM print/.test(sheet) && /<td>Comer, New<\/td>/.test(sheet) && !/<td>Diaz, Ana<\/td>/.test(sheet)
      && /<th>Served<\/th><th>Student<\/th>/.test(sheet) && /Release this student:<\/b> Zane, Dee \(1004\) — now Excused Tardy/.test(sheet), sheet.slice(0, 300));
  check("...recorded as a 'changes' print of the whole list now, which is what that person holds once it is added",
    recorded.length === 1 && recorded[0].kind === "changes" && recorded[0].studentNumbers.length === 5 && !recorded[0].studentNumbers.includes("1004"));
  const none = makeWorld(scriptSrc, { query: () => FRESH(), mutation: () => ({ ok: true }) });
  await none.app.loadReflectionList();
  await none.app.printReflectionChanges();
  check("with nothing changed it is not offered, and prints nothing", none.fixed.rrChangesBtn.hidden === true && none.prints.length === 0);
}

// ======================================================================
console.log("\n8. CTRL+P AND THE BROWSER'S PRINT MENU\n");
// ======================================================================
{
  const w = makeWorld(scriptSrc, { query: () => FRESH(), mutation: () => ({ ok: true, at: "2026-10-13T18:47:00.000Z" }) });
  await w.app.loadReflectionList();
  const keyHandler = (w.docListeners.keydown || [])[0];
  let prevented = 0;
  const press = (k, mods) => keyHandler && keyHandler({ key: k, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...mods, preventDefault() { prevented++; } });
  w.calls.length = 0;
  press("p");
  await new Promise((r) => setImmediate(r));
  check("Ctrl+P is intercepted on this screen: it goes through the Print button's fresh read and recorded print",
    prevented === 1 && w.calls[0]?.path === "reflectionList:listForDay" && w.calls.some((c) => c.path === "reflectionList:recordPrint") && w.prints.length === 1,
    J({ prevented, calls: w.calls.map((c) => c.path) }));
  w.fire("afterprint"); w.app.closeReflectionSheet();
  press("p", { ctrlKey: false, metaKey: true });
  await new Promise((r) => setImmediate(r));
  check("...and so is Cmd+P", prevented === 2 && w.prints.length === 2);
  w.fire("afterprint"); w.app.closeReflectionSheet();
  w.setOnScreen(false);
  press("p");
  check("...but not on any other screen, where Ctrl+P is the browser's", prevented === 2);
  w.setOnScreen(true);

  // The browser's own menu: no time to read, so it prints what is on screen.
  w.app.setLoadedAt(Date.now() - 5000);
  w.fire("beforeprint");
  const fresh = w.sheet()?.innerHTML || "";
  check("Print from the browser menu draws the list on screen at once, says it is not recorded, and is NOT stale when under a minute old",
    !!w.sheet() && /This print is not recorded: use the Print button\./.test(fresh) && !/STALE/.test(fresh) && w.document.body.classList.contains("wc-printing"));
  w.fire("afterprint");
  check("...and the sheet it drew goes when the print dialog closes", w.sheet() === null && !w.document.body.classList.contains("wc-printing"));
  w.app.setLoadedAt(Date.now() - 61000);
  w.fire("beforeprint");
  const stale = w.sheet()?.innerHTML || "";
  const pages = sheetPages(stale);
  check("the STALE banner: an answer over 60 s old says 'STALE: as of 11:46:10 AM. Use the Print button' on every page",
    pages.length === 2 && pages.every((p) => /STALE: as of 11:46:10 AM\. Use the Print button/.test(p)), J(pages.map((p) => (/rr-watermark">([^<]*)</.exec(p) || [])[1])));
  w.fire("afterprint");
}
{
  // THE PRINT BUTTON'S SHEET LEFT OPEN, then the browser's menu (review,
  // 2026-10-08). The dialog's close takes the print class away, not the
  // sheet. A later menu print must draw the list again, aged, never put out
  // the old sheet as it stood.
  let answer = FRESH();
  const w = makeWorld(scriptSrc, { query: () => answer, mutation: () => ({ ok: true, at: "2026-10-13T18:47:00.000Z" }) });
  await w.app.loadReflectionList();
  await w.app.printReflectionList();
  w.fire("afterprint");
  const leftOpen = !!w.sheet() && !w.document.body.classList.contains("wc-printing");
  answer = FRESH();
  answer.asOf = "2026-10-13T18:50:00.000Z";
  answer.sections[1].rows.push(row("2002", { unitId: "reflectionUnits:22", key: "reflectionUnits:22", state: "listed", grade: "11", division: "hs", mode: "live" }));
  await w.app.loadReflectionList();
  w.app.setLoadedAt(Date.now() - 61000);
  w.fire("beforeprint");
  const again = w.sheet()?.innerHTML || "";
  const againPages = sheetPages(again);
  check("a sheet left open after a print is drawn again for a menu print: the list on screen, STALE on every page, printing as a sheet",
    leftOpen && /2002/.test(again) && againPages.length === 2 && againPages.every((p) => /STALE: as of 11:50:00 AM\. Use the Print button/.test(p))
      && w.document.body.classList.contains("wc-printing") && w.document.title === "Reflection Room list 2026-10-13"
      && /This print is not recorded: use the Print button\./.test(again) && !/Read from the server just now/.test(again),
    J({ leftOpen, pages: againPages.length, title: w.document.title, printing: w.document.body.classList.contains("wc-printing") }));
  w.fire("afterprint");
}

// ======================================================================
console.log("\n9. THE ROOM'S ATTENDANCE ON SCREEN\n");
// ======================================================================
{
  const answer = FRESH();
  answer.room = { tick: true, closeRoom: false, why: null, doneAt: null, doneBy: null, closed: null, notHere: 0 };
  const sent = [];
  const w = makeWorld(scriptSrc, { query: () => answer, mutation: (a) => { sent.push(a); return { ok: true }; } });
  await w.app.loadReflectionList();
  const html = w.fixed.rrList.innerHTML;
  // MS is in shadow here and HS live: no room runs for a shadow division,
  // so only the HS row is the room's to tick (second review, 2026-10-08).
  const boxes = [...html.matchAll(/data-rr-unit="([^"]*)"/g)].map((m) => m[1]);
  check("while the room's attendance is open, each LIVE row has a Not here box (screen only) and there is an Attendance done button",
    /<th>Not here<\/th>/.test(html) && J(boxes) === J(["reflectionUnits:10"]) && /onclick="reflectionAttendanceDone\(true\)">Attendance done</.test(html)
      && !/Room did not run today/.test(html), J(boxes));
  check("...and no box on a row of a division in shadow (the pilot), whose carries PowerSchool decides",
    !boxes.some((id) => answer.sections[0].rows.some((r) => r.unitId === id)), J(boxes));
  w.app.printReflectionList && (await w.app.printReflectionList());
  check("...never on paper: the printed list has the empty Served box instead", !/Not here/.test(w.prints[0]?.sheet || "x"));
  await w.app.markReflectionNotHere("reflectionUnits:9", true);
  await w.app.reflectionAttendanceDone(true);
  check("a tick and Attendance done go to the server as they are", J(sent.slice(-2)) === J([{ unitId: "reflectionUnits:9", notHere: true }, { day: "2026-10-13", done: true }]), J(sent));
}

// ======================================================================
console.log("\n10. WHO HAS PRINTED: A PRINT FROM BEFORE THE LIST WAS MADE IS OUT OF DATE\n");
// ======================================================================
{
  // The same four students before and after the freeze: no change counts,
  // but the 11:31 paper says NOT FINAL, and its holder is told to print
  // again. The roles' panel must say the same (review, 2026-10-08).
  const answer = FRESH();
  answer.printsToday = [
    { by: "granted@school.test", at: "2026-10-13T18:31:00.000Z", kind: "master", final: false, students: 4,
      changes: { added: 0, release: 0, cleared: 0, voided: 0 }, beforeFreeze: true, outOfDate: true },
    { by: "pbis@school.test", at: "2026-10-13T18:46:00.000Z", kind: "master", final: true, students: 4,
      changes: { added: 0, release: 0, cleared: 0, voided: 0 }, beforeFreeze: false, outOfDate: false },
  ];
  const w = makeWorld(scriptSrc, { query: () => answer, mutation: () => ({ ok: true }) });
  await w.app.loadReflectionList();
  const items = [...w.fixed.rrList.innerHTML.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
  check("the roles' panel says a print from before the list was made is out of date, not 'still current'",
    items.some((t) => /^11:31 AM · granted@school\.test · master \(NOT FINAL\) · out of date: list made final at 11:45 AM$/.test(t))
      && items.some((t) => /^11:46 AM · pbis@school\.test · master · still current$/.test(t)), J(items));
}

// ======================================================================
console.log("\n11. A TEST LIST: SAID IN RED, ON SCREEN AND ON EVERY PAGE, AND NEVER A RECORD\n");
// ======================================================================
{
  // reflectionDemo:build (2026-10-08): a TEST list for a day with no real
  // list, built at 11:46 from that day's PowerSchool marks. The server sends
  // demo: true, and no PILOT or NOT FINAL banner.
  const DEMO = () => {
    const r = RES({ view: "demo", demo: true, demoBuiltAt: "2026-10-13T18:46:00.000Z", banners: [], times: null,
      mode: { ms: "shadow", hs: "shadow" },
      myPrintChanges: { printAt: "2026-10-13T18:31:07.000Z", kind: "master", final: false, count: 1, outOfDate: true, added: ["1009"], release: [], cleared: [], voided: [] } });
    r.sections = r.sections.map((s) => ({ ...s, mode: "shadow", rows: s.rows.filter((x) => !x.released).map((x) => ({ ...x, mode: "shadow", state: "listed", key: "demo:" + x.studentNumber })) }));
    return r;
  };
  const BANNER = "TEST ONLY — built from today's PowerSchool marks at 11:46 AM. Not a real list. Do not assign.";
  const BANNER_HTML = BANNER.replace("'", "&#39;");
  const recorded = [];
  const w = makeWorld(scriptSrc, { query: () => DEMO(), mutation: (a) => { recorded.push(a); return { ok: true, at: "2026-10-13T18:47:00.000Z" }; } });
  await w.app.loadReflectionList();
  const banners = w.fixed.rrBanners.innerHTML;
  check("the screen shows the red TEST ONLY banner first, with the time it was built in school time",
    banners.startsWith('<div class="rr-banner rr-banner-test" data-rr-banner="demo" role="alert">' + BANNER_HTML + "</div>"), banners.slice(0, 200));
  const list = w.fixed.rrList.innerHTML;
  check("...each section says TEST, never PILOT, and the day line says it is not a real list",
    (list.match(/rr-test-chip">TEST: do not assign</g) || []).length === 2 && !/PILOT/.test(list)
      && /TEST ONLY: built at 11:46 AM, not a real list/.test(w.fixed.rrDayNote.textContent), w.fixed.rrDayNote.textContent);
  check("slips and 'Print changes only' are off for a TEST list (even with a print it could be compared with); Print is on",
    w.fixed.rrSlipsBtn.disabled === true && w.fixed.rrChangesBtn.hidden === true && w.fixed.rrPrintBtn.disabled === false,
    J({ slips: w.fixed.rrSlipsBtn.disabled, changes: w.fixed.rrChangesBtn.hidden }));

  w.calls.length = 0;
  await w.app.printReflectionList();
  const p = w.prints[0] || {};
  const pages = sheetPages(p.sheet || "");
  check("Print prints the TEST copy from a fresh read, and records nothing (the server refuses a TEST list's print)",
    w.prints.length === 1 && w.calls.map((c) => c.path).join() === "reflectionList:listForDay" && recorded.length === 0, J(w.calls.map((c) => c.path)));
  const thead = (pg) => (/<th colspan="8" class="rr-watermark">([^<]*)<\/th>/.exec(pg) || [])[1] || "";
  check("printed TEST pages carry the watermark and the banner: 'TEST — not for assignment' across every page, in every page's header row, and the red banner under every heading",
    pages.length === 2 && (p.sheet.match(/class="rr-test-watermark" aria-hidden="true" data-rr-test-watermark>TEST — not for assignment<\/div>/g) || []).length === 1
      && pages.every((pg) => thead(pg) === "TEST — not for assignment" && /^ rr-print-page rr-test"/.test(pg)
        && pg.includes('<p class="rr-test-banner" data-rr-test>' + BANNER_HTML + "</p>")),
    J({ marks: pages.map(thead), watermarks: (p.sheet.match(/rr-test-watermark/g) || []).length, banner: (/<p class="rr-test-banner"[^<]*</.exec(p.sheet) || [])[0] }));
  check("...and never PILOT or NOT FINAL as well: each page heads 'TEST ONLY'",
    !/PILOT|NOT FINAL/.test(p.sheet) && pages.every((pg) => /As of 11:31 AM · TEST ONLY · 4 students/.test(pg)), pages.map((pg) => (/<p class="print-sub">([^<]*)</.exec(pg) || [])[1]).join(" | "));
  const names = STUDENTS.flatMap((s) => [s.firstName, s.lastName]);
  check("title has no names: the PDF is named 'Reflection Room TEST list 2026-10-13 - not for assignment', and the title comes back after",
    p.title === "Reflection Room TEST list 2026-10-13 - not for assignment" && /TEST/.test(p.title) && !names.some((n) => p.title.includes(n)) && p.printing === true,
    p.title);
  w.fire("afterprint");
  check("...the app's own title comes back when the print dialog closes", w.document.title === "Wildcat Hub");
  w.app.closeReflectionSheet();

  w.alerts.length = 0;
  const callsBefore = w.calls.length;
  await w.app.printReflectionSlips();
  await w.app.printReflectionChanges();
  check("slips and 'Print changes only', pressed anyway, print and record nothing for a TEST list, and say why",
    w.prints.length === 1 && recorded.length === 0 && w.calls.slice(callsBefore).every((c) => c.kind === "query")
      && /TEST list, so there are no slips/.test(w.alerts[0] || "") && /TEST list: no print of it is recorded/.test(w.alerts[1] || ""), J(w.alerts));

  w.app.setLoadedAt(Date.now() - 5000);
  w.fire("beforeprint");
  const menu = w.sheet()?.innerHTML || "";
  check("the browser's own print menu prints the TEST copy too, watermark and banner on every page",
    /data-rr-test-watermark>TEST — not for assignment/.test(menu) && sheetPages(menu).length === 2
      && sheetPages(menu).every((pg) => /data-rr-test>TEST ONLY/.test(pg)) && w.document.title === "Reflection Room TEST list 2026-10-13 - not for assignment");
  w.fire("afterprint");

  // A REAL day is drawn exactly as before.
  const real = makeWorld(scriptSrc, { query: () => RES(), mutation: () => ({ ok: true }) });
  const realHtml = real.app.reflectionSheetHtml(RES(), { byNumber: real.app.rrStudentIndex(), printedBy: "Pat" });
  await real.app.loadReflectionList();
  check("the PILOT watermark logic is unchanged for real days: PILOT and NOT FINAL as before, no TEST anywhere, the real title",
    sheetPages(realHtml).map(thead).join(" | ") === "PILOT: do not assign · NOT FINAL: do not pull | NOT FINAL: do not pull"
      && !/TEST|rr-test/.test(realHtml) && !/TEST|rr-test/.test(real.fixed.rrBanners.innerHTML + real.fixed.rrList.innerHTML)
      && real.app.reflectionSheetTitle(RES()) === "Reflection Room list 2026-10-13", sheetPages(realHtml).map(thead).join(" | "));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
