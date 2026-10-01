// Perfect attendance by a CHOSEN month, in a chosen order, on paper.
// Run: npm test
//
// THE OWNER, 2026-10-01: "for perfect attendance, can we get a feature where
// we can sort/filter by specific month and not just 'this month'. also I would
// like to be able to pull pdf/print perfect attendance lists by filter as well."
//
// THREE THINGS CAN GO QUIETLY WRONG HERE, and each is invisible on a list that
// still looks plausible:
//
//   1. THE MONTH'S EDGES. A month that runs past today takes in absences
//      entered ahead of time (PowerSchool dates some into the future), and an
//      August that starts on the 1st instead of the first day of school calls
//      every child who enrolled on day one a late arrival -- eligibility is
//      "enrolled on or before the window starts". Both produce a wrong list
//      with nothing on it to say so.
//   2. THE ORDER. The screen and the printed sheet must be the SAME list in
//      the SAME order: a sheet read out at an assembly that disagrees with
//      the screen somebody checked a minute before is worse than no sheet.
//   3. THE PRINT'S SIDE EFFECTS. Printing borrows the page title (Chrome names
//      a saved PDF after it) and a body class shared with the store's purchase
//      list. Either one left behind is a bug in somebody else's screen.
//
// Most of this runs the SHIPPED code: the roster rules loaded for real, and the
// screen's own functions lifted out of script.js and run against a small fake
// DOM. A regex over the source would still pass with the code broken.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const rosterSrc = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
const scriptSrc = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const htmlSrc = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// The store's purchase-list functions as they stood at 1bb196f, the commit this
// feature was built on, plus the one guard line added on purpose on 2026-10-01
// (see THE WIRING below).
const PURCHASE_LIST_HASH = "427a06100b0b81c5";

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

// ---------------------------------------------------------------- the harness
function loadRoster(transform) {
  const body = transform ? transform(rosterSrc) : rosterSrc;
  const sandbox = {};
  new Function("globalThis", body).call(sandbox, sandbox);
  return sandbox.WildcatRoster;
}
const R = loadRoster();

/** Replace exactly one anchor, or fail loudly: a teeth test whose anchor moved proves nothing. */
function breakOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`teeth "${label}": anchor not found exactly once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}

/**
 * A named function's whole text out of script.js, braces matched past
 * strings and comments.
 */
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

const decode = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Just enough DOM for the perfect attendance panel and its print sheet. */
function makeDom() {
  const timers = [], listeners = {}, alerts = [], prints = [], children = [];
  let seq = 0;
  const fire = (t) => (listeners[t] || []).slice().forEach((f) => f());
  class El {
    constructor(tag) {
      this.tagName = tag; this.attrs = {}; this.style = {}; this.id = ""; this.className = ""; this.innerHTML = "";
      const cls = new Set();
      this.classList = { add: (c) => cls.add(c), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c) };
    }
    // An innerHTML write tells the element's observers, the way a
    // MutationObserver on childList hears one (here at once; in Chrome a
    // microtask later).
    set innerHTML(v) { this._inner = String(v); (this._observers || []).slice().forEach((o) => o.cb([], o)); }
    get innerHTML() { return this._inner; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    /** Only "[attr]", which is all the sheet asks. */
    querySelector(sel) {
      const m = /^\[([\w-]+)\]$/.exec(sel);
      if (!m) throw new Error("fake querySelector cannot do " + sel);
      return new RegExp("<[^>]*\\s" + m[1] + "(?=[\\s=>])").test(this._inner) ? {} : null;
    }
    remove() { const i = children.indexOf(this); if (i >= 0) children.splice(i, 1); }
  }
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.el = null; }
    observe(el) { this.el = el; (el._observers = el._observers || []).push(this); }
    disconnect() { if (this.el) this.el._observers = this.el._observers.filter((o) => o !== this); this.el = null; }
  }
  class Select extends El {
    constructor(html) { super("select"); this.innerHTML = html || ""; }
    // Like a real <select>: new options select the first; an unknown value selects none.
    set innerHTML(html) {
      this._html = String(html);
      this.options = [...this._html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
        .map((m) => ({ value: decode(m[1]), textContent: decode(m[2]) }));
      this._value = this.options.length ? this.options[0].value : "";
    }
    get innerHTML() { return this._html; }
    get value() { return this._value; }
    set value(v) { this._value = this.options.some((o) => o.value === v) ? v : ""; }
  }
  const classes = new Set();
  const body = {
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    appendChild: (el) => { children.push(el); return el; },
  };
  const fixed = {
    attPerfectBody: new El("div"),
    attPerfectGrade: new Select('<option value="all">All grades</option>'),
    attPerfectExcused: Object.assign(new El("input"), { checked: true }),
    attPerfectSort: new Select(['grade', 'last', 'first', 'id'].map((k) => `<option value="${k}">${k}</option>`).join("")),
    attPerfectMonth: new Select(""),
    attPerfectMonthWrap: Object.assign(new El("label"), { style: { display: "none" } }),
    // What logout() touches.
    mainApp: new El("div"),
    loginScreen: new El("div"),
    loginError: new El("p"),
  };
  const document = {
    title: "Wildcat Hub",
    body,
    getElementById: (id) => fixed[id] || children.find((c) => c.id === id) || null,
    createElement: (tag) => new El(tag),
    querySelectorAll: () => [],
  };
  const window = {
    WildcatRoster: null,
    // Like a browser: adding a listener that is already there does nothing.
    addEventListener: (t, f) => { const l = (listeners[t] = listeners[t] || []); if (!l.includes(f)) l.push(f); },
    removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
    // Chrome fires beforeprint inside window.print(), before it lays the page out.
    print: () => { fire("beforeprint"); prints.push({ title: document.title, printing: classes.has("wc-printing") }); },
  };
  return {
    El, MutationObserver, document, window, fixed, alerts, prints, timers, listeners, children,
    sheets: () => children.filter((c) => c.id === "wcPrintSheet"),
    fire,
    showConfirm: async () => true,
    setTimeout: (f) => { const id = ++seq; timers.push({ id, f }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    runTimers: () => timers.splice(0).forEach((t) => t.f()),
    showAlert: (m) => { alerts.push(String(m)); return Promise.resolve(); },
  };
}

const SCREEN_FNS = ["escapeHtml", "attGradeOrder", "wcClockAt", "paGradeKey", "paGradeName",
  "setPerfectWindow", "setPerfectMonth", "syncPerfectMonthPicker", "renderPerfectAttendance",
  "openPerfectAttendanceSheet", "setPerfectSheetByGrade", "perfectSheetFileName",
  "renderPerfectAttendanceSheet", "printPerfectAttendanceSheet", "beginPerfectAttendancePrint",
  "endPerfectAttendancePrint", "perfectAttendanceSheetOpen", "perfectAttendanceBeforePrint",
  "unhookPerfectAttendanceSheet", "closePerfectAttendanceSheet", "printPurchaseList", "closePurchaseListSheet",
  "logout"];

/**
 * The panel, built from script.js (or a broken copy of it). `env.today` and
 * `env.yearStart` stand in for the school's calendar day and the start date
 * on screen; `env.load` is the marks query.
 */
function buildScreen(src, env, Roster) {
  const dom = makeDom();
  dom.window.WildcatRoster = Roster || R;
  const state = [...src.matchAll(/^[ \t]*let (_pa\w+) = [^;\n]+;/gm)].map((m) => m[0].trim()).join("\n");
  const fns = SCREEN_FNS.map((n) => lift(src, n)).join("\n\n");
  const api = new Function(
    "window", "document", "setTimeout", "clearTimeout", "showAlert", "MutationObserver",
    "attTodayIso", "attendanceSchoolDays", "loadPerfectMarks",
    // logout()'s neighbours, stubbed: it is lifted for what it does to the sheet.
    "wcForgetTab", "showConfirm", "clearSession", "showStudentLogin",
    `let currentUser = { id: "t1" }, currentStudent = null, _sidebarModeApplied = true;
    ${state}\n${fns}\nreturn {
      ${SCREEN_FNS.join(", ")},
      set cache(v) { _paCache = v; },
      get shown() { return _paShown; },
      get month() { return _paMonth; },
    };`,
  )(dom.window, dom.document, dom.setTimeout, dom.clearTimeout, dom.showAlert, dom.MutationObserver,
    () => env.today, () => ({ first: env.yearStart }), (...a) => env.load(...a),
    () => {}, dom.showConfirm, () => {}, () => {});
  return { app: api, dom };
}

const screenIds = (dom) => [...dom.fixed.attPerfectBody.innerHTML.matchAll(/ID ([^<]+)<\/div><\/div>/g)].map((m) => decode(m[1]));
const sheetOf = (dom) => dom.sheets()[0];
const sheetPages = (dom) => (sheetOf(dom).innerHTML.split('<section class="print-page">').slice(1));
const pageRows = (page) => [...page.matchAll(/<tr><td>(\d+)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g)]
  .map((m) => ({ n: +m[1], name: m[2], grade: m[3], id: m[4] }));

const student = (over) => Object.assign({
  studentNumber: "1001", firstName: "Ana", lastName: "Diaz", gradeLevel: "7",
  entryDate: "2026-08-12",
  absentDates: [], excusedAbsentDates: [], tardyDates: [], excusedTardyDates: [],
}, over || {});

// The school as the screen sees it on Thursday 1 October 2026.
const ROWS = [
  student({ studentNumber: "1001", firstName: "Ana", lastName: "Diaz", gradeLevel: "7" }),
  student({ studentNumber: "1002", firstName: "ben", lastName: "alvarez", gradeLevel: "7" }),
  student({ studentNumber: "999", firstName: "Carla", lastName: "Zamora", gradeLevel: "8" }),
  // Late once in September: off September, on October.
  student({ studentNumber: "1003", firstName: "Dev", lastName: "Chen", gradeLevel: "7", tardyDates: ["2026-09-16"] }),
  // An absence entered AHEAD OF TIME for tomorrow. Not missed yet.
  student({ studentNumber: "1004", firstName: "Eva", lastName: "Brown", gradeLevel: "8", absentDates: ["2026-10-02"] }),
  // A name that is also markup, which must print as text.
  student({ studentNumber: "1005", firstName: 'Gil & "Co"', lastName: "Ortiz <i>", gradeLevel: "7" }),
  // Enrolled mid-September: not eligible for September, eligible for October.
  student({ studentNumber: "1006", firstName: "Hal", lastName: "Ng", gradeLevel: "8", entryDate: "2026-09-15" }),
  // An EXCUSED absence: off the strict list, on the forgiving one.
  student({ studentNumber: "1007", firstName: "Ivy", lastName: "Park", gradeLevel: "6",
            absentDates: ["2026-09-10"], excusedAbsentDates: ["2026-09-10"] }),
  student({ studentNumber: "1008", firstName: "Jo", lastName: "Kim", gradeLevel: "" }),
];
const MARKS = { allowed: true, rows: ROWS, lastSyncedAt: "2026-10-01T19:30:00Z", truncated: false };

console.log("\nTHE MONTHS ON OFFER\n");
{
  const m = R.perfectMonths("2026-10-01", "2026-08-12");
  check("every month of the year so far, NEWEST FIRST",
    m.map((x) => x.key).join(",") === "2026-10,2026-09,2026-08", m.map((x) => x.key).join(","));
  check("labelled the way the dropdown reads",
    m.map((x) => x.label).join(" | ") === "October 2026 (so far) | September 2026 | August 2026 (from 12 Aug)",
    m.map((x) => x.label).join(" | "));
  check("this month runs from the 1st to TODAY and says it is partial",
    m[0].from === "2026-10-01" && m[0].to === "2026-10-01" && m[0].partial === true && m[0].clamped === false);
  check("a finished month is the whole month",
    m[1].from === "2026-09-01" && m[1].to === "2026-09-30" && !m[1].partial && !m[1].clamped);
  check("the month school started in begins on the FIRST DAY OF SCHOOL, not the 1st",
    m[2].from === "2026-08-12" && m[2].to === "2026-08-31" && m[2].clamped === true && !m[2].partial);
  check("nothing is offered before the year starts or after today", (() => {
    for (const today of ["2026-08-12", "2026-08-31", "2026-09-01", "2026-10-01", "2027-02-28", "2027-06-30"]) {
      for (const x of R.perfectMonths(today, "2026-08-12")) {
        if (x.from < "2026-08-12" || x.to > today || x.from > x.to) return false;
      }
    }
    return true;
  })());
  check("a year that started on the 1st is not marked as clipped",
    R.perfectMonths("2026-10-01", "2026-08-01").slice(-1)[0].label === "August 2026");
  check("on the first day of school there is one month, clipped AND partial",
    JSON.stringify(R.perfectMonths("2026-08-12", "2026-08-12").map((x) => [x.label, x.from, x.to])) ===
      JSON.stringify([["August 2026 (from 12 Aug, so far)", "2026-08-12", "2026-08-12"]]));
  // THE LAST DAY IS NOT OVER (review, 2026-10-01). The 12:30 rebuild carries
  // half of today, so on the 30th September's list can still lose a name.
  const lastDay = R.perfectMonths("2026-09-30", "2026-08-12")[0];
  check("on the LAST day of a month it is still 'so far': that day's marks are still coming in",
    lastDay.label === "September 2026 (so far)" && lastDay.partial === true && lastDay.to === "2026-09-30", lastDay.label);
  check("...and the screen's sentence says so too",
    R.perfectMonthWindow("2026-09", "2026-09-30", "2026-08-12").label === "September 2026 so far");
  check("the day after, it is whole",
    R.perfectMonths("2026-10-01", "2026-08-12")[1].label === "September 2026" &&
    R.perfectMonthWindow("2026-09", "2026-10-01", "2026-08-12").partial === false);
  check("a short month's last day too (28 Feb 2027)",
    R.perfectMonths("2027-02-28", "2026-08-12")[0].label === "February 2027 (so far)" &&
    R.perfectMonths("2027-03-01", "2026-08-12")[1].label === "February 2027");

  // ACROSS NEW YEAR. The month arithmetic is the place a year boundary bites.
  const jan = R.perfectMonths("2027-01-05", "2026-08-12");
  check("a school year crossing December into January lists both years, in order",
    jan.map((x) => x.key).join(",") === "2027-01,2026-12,2026-11,2026-10,2026-09,2026-08",
    jan.map((x) => x.key).join(","));
  check("...December is 1 to 31 Dec 2026 and January runs from 1 Jan 2027 to today",
    jan[1].from === "2026-12-01" && jan[1].to === "2026-12-31" &&
    jan[0].from === "2027-01-01" && jan[0].to === "2027-01-05" && jan[0].label === "January 2027 (so far)");

  // MONTH LENGTHS, including the two leap-year rules.
  const end = (key, today, start) => (R.perfectMonthWindow(key, today, start) || {}).to;
  check("February 2028 has 29 days (leap year)", end("2028-02", "2028-06-01", "2027-08-12") === "2028-02-29");
  check("February 2027 has 28", end("2027-02", "2027-06-01", "2026-08-12") === "2027-02-28");
  check("February 2100 has 28 (a century, not a leap year)", end("2100-02", "2100-06-01", "2099-08-12") === "2100-02-28");
  check("30-day months end on the 30th",
    ["2026-09", "2026-11", "2027-04", "2027-06"].every((k) => end(k, "2027-07-15", "2026-08-12") === k + "-30"));
  check("31-day months end on the 31st",
    ["2026-08", "2026-10", "2026-12", "2027-01", "2027-03", "2027-05"].every((k) => end(k, "2027-07-15", "2026-08-12") === k + "-31"));

  // THE WINDOW'S OWN SHAPE.
  const sep = R.perfectMonthWindow("2026-09", "2026-10-01", "2026-08-12");
  check("a month window says what it is",
    sep.key === "month" && sep.month === "2026-09" && sep.label === "September 2026");
  check("...and the current month's says 'so far'",
    R.perfectMonthWindow("2026-10", "2026-10-01", "2026-08-12").label === "October 2026 so far");
  check("a month after today is not a window", R.perfectMonthWindow("2026-11", "2026-10-01", "2026-08-12") === null);
  check("nor is one that ended before the year began", R.perfectMonthWindow("2026-07", "2026-10-01", "2026-08-12") === null);

  // BAD INPUT is nothing, never a guess.
  for (const [label, args] of [
    ["a junk today", ["not-a-date", "2026-08-12"]],
    ["no year start", ["2026-10-01", ""]],
    ["a null year start", ["2026-10-01", null]],
    ["a year start after today", ["2026-10-01", "2026-11-01"]],
    ["a date that does not exist", ["2026-02-30", "2026-01-05"]],
  ]) {
    check(`${label} offers no months`, Array.isArray(R.perfectMonths(...args)) && R.perfectMonths(...args).length === 0);
  }
  for (const key of ["2026-13", "2026-00", "2026-9", "abc", "", null, undefined]) {
    check(`month key ${JSON.stringify(key)} is not a window`, R.perfectMonthWindow(key, "2026-10-01", "2026-08-12") === null);
  }
  check("a mistyped century cannot build a dropdown of a thousand months",
    R.perfectMonths("2026-10-01", "1926-08-12").length <= 24);
}

console.log("\nTHE OLD 'THIS MONTH' IS THE NEW DEFAULT MONTH\n");
{
  // perfectWindows().month is untouched; the Month tab opens on the month
  // perfectMonths lists first. They must be the same window on every day of
  // a school year whose start fell in an earlier month.
  check("perfectWindows().month and this month's window agree every day of the year", (() => {
    const bad = [];
    for (let t = Date.UTC(2026, 8, 1); t <= Date.UTC(2027, 6, 31); t += 86400000) {
      const d = new Date(t).toISOString().slice(0, 10);
      const old = R.perfectWindows(d, "2026-08-12").month;
      const now = R.perfectMonthWindow(R.perfectMonths(d, "2026-08-12")[0].key, d, "2026-08-12");
      if (!now || old.from !== now.from || old.to !== now.to) bad.push(d);
    }
    return bad.length === 0 || (console.log("        disagree on", bad.slice(0, 5).join(", ")), false);
  })());
  // The one deliberate difference: in the month school STARTS, the new window
  // begins on the first day, so day-one enrolments are eligible for it.
  const firstDay = student({ entryDate: "2026-08-12" });
  check("in the first month, a day-one enrolment is eligible for the month (the clamp's whole point)",
    R.perfectVerdict(firstDay, R.perfectMonthWindow("2026-08", "2026-08-20", "2026-08-12"), {}).eligible === true);
}

console.log("\nA PAST MONTH, UNDER THE SAME RULES\n");
{
  const oct = R.perfectMonthWindow("2026-10", "2026-10-01", "2026-08-12");
  const sep = R.perfectMonthWindow("2026-09", "2026-10-01", "2026-08-12");
  const aug = R.perfectMonthWindow("2026-08", "2026-10-01", "2026-08-12");
  check("an absence entered AHEAD of time for tomorrow does not break this month",
    R.perfectVerdict(student({ absentDates: ["2026-10-02"] }), oct, {}).perfect === true);
  check("...but one today does", R.perfectVerdict(student({ absentDates: ["2026-10-01"] }), oct, {}).perfect === false);
  check("a tardy in September does not break October",
    R.perfectVerdict(student({ tardyDates: ["2026-09-30"] }), oct, {}).perfect === true);
  check("...and does break September",
    R.perfectVerdict(student({ tardyDates: ["2026-09-30"] }), sep, {}).perfect === false);
  const mid = student({ entryDate: "2026-09-15" });
  check("a student who enrolled mid-September is not eligible for September",
    R.perfectVerdict(mid, sep, {}).eligible === false && R.perfectVerdict(mid, sep, {}).enrolledSince === "2026-09-15");
  check("...and IS eligible, and perfect, for October", R.perfectVerdict(mid, oct, {}).perfect === true);
  check("enrolling on the 1st of a past month counts for that month",
    R.perfectVerdict(student({ entryDate: "2026-09-01" }), sep, {}).eligible === true);
  check("a day-one enrolment is eligible for August (from 12 Aug)",
    R.perfectVerdict(student({ entryDate: "2026-08-12" }), aug, {}).eligible === true);
  const list = R.perfectList(ROWS, sep, {});
  check("September's list over the fixture: 6 of 8 eligible, Hal not counted",
    list.counts.perfect === 6 && list.counts.eligible === 8 && list.counts.notEligible === 1,
    JSON.stringify(list.counts));
}

console.log("\nTHE ORDERS\n");
{
  const sep = R.perfectMonthWindow("2026-09", "2026-10-01", "2026-08-12");
  const shown = R.perfectList(ROWS, sep, {}).students;
  const ids = (key) => R.perfectSort(shown, key).map((s) => s.studentNumber).join(",");
  check("grade, then last name (the default) -- 7s, 8s, then no grade, case ignored",
    ids("grade") === "1002,1001,1005,1004,999,1008", ids("grade"));
  check("...which is the order the list has always had", ids("grade") ===
    R.perfectList(ROWS, sep, {}).students.filter((s) => s.gradeLevel).map((s) => s.studentNumber)
      .concat(["1008"]).join(","));
  check("last name: 'alvarez' sits with the A's, not after the Z's", ids("last") === "1002,1004,1001,1008,1005,999", ids("last"));
  check("first name", ids("first") === "1001,1002,999,1004,1005,1008", ids("first"));
  check("student ID is NUMERIC: 999 before 1001", ids("id") === "999,1001,1002,1004,1005,1008", ids("id"));
  check("an unknown order reads as the default", ids("shoe size") === ids("grade") && ids(undefined) === ids("grade"));

  const g = (gradeLevel, n) => ({ studentNumber: n, firstName: "A", lastName: "B", gradeLevel });
  check("grade is numeric too: 9, 10, 11, 12",
    R.perfectSort([g("12", "a"), g("10", "b"), g("9", "c"), g("11", "d")], "grade").map((s) => s.gradeLevel).join(",") === "9,10,11,12");
  const twins = [
    { studentNumber: "2", firstName: "Ana", lastName: "Diaz", gradeLevel: "7" },
    { studentNumber: "1", firstName: "ana", lastName: "DIAZ", gradeLevel: "7" },
  ];
  check("STABLE and case-insensitive: two Ana Diazes keep the order they came in",
    ["grade", "last", "first"].every((k) => R.perfectSort(twins, k).map((s) => s.studentNumber).join(",") === "2,1") &&
    ["grade", "last", "first"].every((k) => R.perfectSort(twins.slice().reverse(), k).map((s) => s.studentNumber).join(",") === "1,2"));
  check("a blank sorts LAST, so a read-out list never opens on an unknown",
    R.perfectSort([{ lastName: "" }, { lastName: "Zed" }, { lastName: "abe" }], "last").map((s) => s.lastName).join(",") === "abe,Zed,");
  const input = shown.slice();
  R.perfectSort(input, "id");
  check("it returns a new array and leaves the one it was given alone",
    input.map((s) => s.studentNumber).join(",") === shown.map((s) => s.studentNumber).join(",") &&
    R.perfectSort(input, "id") !== input);
  check("nothing in, nothing out", R.perfectSort(null, "last").length === 0);
  check("the dropdown's options are the four the module knows, default first",
    R.PERFECT_SORTS.map((s) => s.key).join(",") === "grade,last,first,id");
}

console.log("\nTHE PERIOD, IN WORDS FOR PAPER\n");
{
  const name = (w) => R.perfectPeriodName(w);
  check("a finished month", name(R.perfectMonthWindow("2026-09", "2026-10-01", "2026-08-12")) === "September 2026");
  check("this month", name(R.perfectMonthWindow("2026-10", "2026-10-01", "2026-08-12")) === "October 2026 (so far)");
  check("the first month", name(R.perfectMonthWindow("2026-08", "2026-10-01", "2026-08-12")) === "August 2026 (from 12 Aug)");
  check("the last full week", name(R.perfectWindows("2026-10-01", "2026-08-12").week) === "Week of 21 to 25 Sep 2026",
    name(R.perfectWindows("2026-10-01", "2026-08-12").week));
  check("a week across two months", name(R.perfectWindows("2026-10-05", "2026-08-12").week) === "Week of 28 Sep to 2 Oct 2026",
    name(R.perfectWindows("2026-10-05", "2026-08-12").week));
  check("a week across New Year", name(R.perfectWindows("2027-01-04", "2026-08-12").week) === "Week of 28 Dec 2026 to 1 Jan 2027",
    name(R.perfectWindows("2027-01-04", "2026-08-12").week));
  check("the year to date", name(R.perfectWindows("2026-10-01", "2026-08-12").year) === "Year to date, 12 Aug to 1 Oct 2026");
  check("...across New Year", name(R.perfectWindows("2027-01-15", "2026-08-12").year) === "Year to date, 12 Aug 2026 to 15 Jan 2027");
  check("no window, no words", name(null) === "");

  // THE DAYS UNDER A MONTH'S HEADING (review, 2026-10-01).
  const dates = (w) => R.perfectPeriodDates(w);
  check("a month's exact days, for the line under its heading",
    dates(R.perfectMonthWindow("2026-09", "2026-10-01", "2026-08-12")) === "1 to 30 Sep 2026" &&
    dates(R.perfectMonthWindow("2026-09", "2026-09-29", "2026-08-12")) === "1 to 29 Sep 2026" &&
    dates(R.perfectMonthWindow("2026-08", "2026-10-01", "2026-08-12")) === "12 to 31 Aug 2026" &&
    dates(R.perfectMonthWindow("2026-10", "2026-10-01", "2026-08-12")) === "1 to 1 Oct 2026");
  check("...and nothing for no window", dates(null) === "" && dates({ key: "month" }) === "");
}

console.log("\nTHE SCREEN: MONTH PICKER AND SORT\n");
{
  const env = { today: "2026-10-01", yearStart: "2026-08-12", load: async () => MARKS };
  const { app, dom } = buildScreen(scriptSrc, env);
  app.cache = MARKS;
  await app.renderPerfectAttendance();
  const wrap = dom.fixed.attPerfectMonthWrap, monthSel = dom.fixed.attPerfectMonth;
  check("on the week tab the month picker is hidden", wrap.style.display === "none");
  check("...and the week is drawn exactly as before", app.shown.win.key === "week" && app.shown.win.from === "2026-09-21");

  app.setPerfectWindow("month");
  check("the Month tab shows the picker", wrap.style.display === "");
  check("...listing the year's months newest first",
    monthSel.options.map((o) => o.textContent).join(" | ") === "October 2026 (so far) | September 2026 | August 2026 (from 12 Aug)",
    monthSel.options.map((o) => o.textContent).join(" | "));
  check("...opening on THIS month, as the old tab did", monthSel.value === "2026-10" && app.shown.win.month === "2026-10");
  check("...the same window the old 'This month' drew",
    app.shown.win.from === R.perfectWindows("2026-10-01", "2026-08-12").month.from &&
    app.shown.win.to === R.perfectWindows("2026-10-01", "2026-08-12").month.to);
  check("the sentence names the period plainly", /October 2026 so far: <strong>/.test(dom.fixed.attPerfectBody.innerHTML));
  check("a mark dated tomorrow does not cost Eva this month", screenIds(dom).includes("1004"));

  app.setPerfectMonth("2026-09");
  check("picking September draws September", app.shown.win.month === "2026-09" &&
    /September 2026: <strong>/.test(dom.fixed.attPerfectBody.innerHTML));
  check("...Dev's September tardy keeps him off it", !screenIds(dom).includes("1003"));
  check("...and Hal, who enrolled on the 15th, is explained, not listed",
    !screenIds(dom).includes("1006") && /1 student is not counted/.test(dom.fixed.attPerfectBody.innerHTML));

  app.setPerfectWindow("week");
  check("leaving the Month tab hides the picker", wrap.style.display === "none");
  app.setPerfectWindow("month");
  check("coming back remembers September", app.shown.win.month === "2026-09" && monthSel.value === "2026-09");

  for (const [key, want] of [["grade", "1002,1001,1005,1004,999,1008"], ["last", "1002,1004,1001,1008,1005,999"],
                             ["first", "1001,1002,999,1004,1005,1008"], ["id", "999,1001,1002,1004,1005,1008"]]) {
    dom.fixed.attPerfectSort.value = key;
    await app.renderPerfectAttendance();
    check(`the screen draws the '${key}' order`, screenIds(dom).join(",") === want, screenIds(dom).join(","));
  }

  // THE REMEMBERED MONTH IS GONE: the school year start moved past it.
  app.setPerfectMonth("2026-08");
  check("August can be picked", app.shown.win.month === "2026-08");
  env.yearStart = "2026-09-01";
  await app.renderPerfectAttendance();
  check("when the picked month is no longer offered, it falls back to this month",
    app.shown.win.month === "2026-10" && monthSel.value === "2026-10" && app.month === null);
}

console.log("\nTHE SHEET IS THE SCREEN, ON PAPER\n");
{
  const env = { today: "2026-10-01", yearStart: "2026-08-12", load: async () => MARKS };
  const { app, dom } = buildScreen(scriptSrc, env);
  app.cache = MARKS;
  app.setPerfectWindow("month");
  app.setPerfectMonth("2026-09");
  dom.fixed.attPerfectSort.value = "last";
  await app.renderPerfectAttendance();
  const onScreen = screenIds(dom);

  app.openPerfectAttendanceSheet();
  const sheet = sheetOf(dom);
  check("one sheet, in the shared print element", dom.sheets().length === 1 && sheet.className === "print-sheet");
  check("...announced as a dialog with its own name",
    sheet.getAttribute("role") === "dialog" && sheet.getAttribute("aria-label") === "Perfect attendance list");
  check("it is the screen's own view, not a fresh read or a fresh sort", app.shown && (() => {
    const flat = sheetPages(dom).flatMap(pageRows).map((r) => r.id);
    return flat.slice().sort().join(",") === onScreen.slice().sort().join(",");
  })());

  // ALL GRADES: a page per grade, each with its own heading and count.
  let pages = sheetPages(dom);
  check("with all grades, a page per grade (6, 7, 8, then no grade)", pages.length === 4, String(pages.length));
  check("...each headed with the period and its grade",
    ["Grade 6", "Grade 7", "Grade 8", "No grade recorded"].every((g, i) =>
      pages[i].includes(`<h2>Perfect Attendance — September 2026 — ${g}</h2>`)));
  check("...each page in the SCREEN's order, split by grade", ["6", "7", "8", ""].every((g, i) => {
    const want = onScreen.filter((id) => (ROWS.find((r) => r.studentNumber === id).gradeLevel || "") === g);
    return pageRows(pages[i]).map((r) => r.id).join(",") === want.join(",");
  }));
  check("...each with its own count, the same as picking that grade on screen",
    /3 of 4 eligible students \(75%\)/.test(pages[1]) && /2 of 2 eligible students \(100%\)/.test(pages[2]) &&
    /1 not counted \(enrolled after the period began\)/.test(pages[2]));
  check("a grade with nobody says so in words, not with an empty table",
    /Nobody had perfect attendance for this period\./.test(pages[0]) && !/<table/.test(pages[0]));
  check("rows are numbered from 1 on each page", pageRows(pages[1]).map((r) => r.n).join(",") === "1,2,3");
  check("the toolbar offers 'Start each grade on a new page', ticked",
    /<input type="checkbox" checked onchange="setPerfectSheetByGrade\(this\.checked\)"> Start each grade on a new page/.test(sheet.innerHTML));

  app.setPerfectSheetByGrade(false);
  pages = sheetPages(dom);
  check("unticked, it is one page in exactly the screen's order",
    pages.length === 1 && pageRows(pages[0]).map((r) => r.id).join(",") === onScreen.join(","));
  check("...headed with the period alone", pages[0].includes("<h2>Perfect Attendance — September 2026</h2>"));
  check("...and the whole school's count", /All grades · No absences and no tardies; excused absences and tardies still count · 6 of 8 eligible students \(75%\)/.test(pages[0]));
  check("it says when it was printed and when PowerSchool was last read",
    / · printed [^·<]+ · attendance last read from PowerSchool [^<]+<\/p>/.test(pages[0]));
  check("students print Last, First",
    pageRows(pages[0]).some((r) => r.id === "1002" && r.name === "alvarez, ben" && r.grade === "7"));
  check("EVERY NAME IS ESCAPED: markup in a name prints as text",
    pageRows(pages[0]).some((r) => r.name === "Ortiz &lt;i&gt;, Gil &amp; &quot;Co&quot;") && !/<i>/.test(sheet.innerHTML));
  check("the file name the PDF will get", app.perfectSheetFileName(app.shown) === "Perfect Attendance - September 2026 - All grades");
  app.closePerfectAttendanceSheet();
  check("Close removes the sheet", dom.sheets().length === 0);

  // ONE GRADE, FORGIVING: what the screen shows, and the rule says so.
  dom.fixed.attPerfectGrade.value = "7";
  dom.fixed.attPerfectExcused.checked = false;
  await app.renderPerfectAttendance();
  app.openPerfectAttendanceSheet();
  pages = sheetPages(dom);
  check("one grade: one page, no grade-per-page option",
    pages.length === 1 && !/Start each grade/.test(sheetOf(dom).innerHTML));
  check("...the sub-line names the grade and the forgiving rule",
    /<p class="print-sub">1 to 30 Sep 2026 · Grade 7 · No absences and no tardies; excused ones forgiven · 3 of 4 eligible students \(75%\)/.test(pages[0]));
  check("...and only that grade's students, in the screen's order",
    pageRows(pages[0]).map((r) => r.id).join(",") === screenIds(dom).join(",") && screenIds(dom).join(",") === "1002,1001,1005");
  check("the file name names the grade", app.perfectSheetFileName(app.shown) === "Perfect Attendance - September 2026 - Grade 7");

  // A PERIOD WITH NOBODY.
  const empty = buildScreen(scriptSrc, { today: "2026-10-01", yearStart: "2026-08-12" });
  const allLate = { allowed: true, rows: ROWS.map((r) => Object.assign({}, r, { tardyDates: ["2026-09-21"] })), truncated: true };
  empty.app.cache = allLate;
  empty.app.setPerfectWindow("week");
  empty.app.openPerfectAttendanceSheet();
  const ep = sheetPages(empty.dom);
  check("an empty result prints ONE page saying nobody, with no table",
    ep.length === 1 && /Nobody had perfect attendance for this period\./.test(ep[0]) && !/<table/.test(ep[0]));
  check("...headed with the week", ep[0].includes("<h2>Perfect Attendance — Week of 21 to 25 Sep 2026</h2>"));
  check("...whose dates are in the heading, so the line under it does not repeat them",
    /<p class="print-sub">All grades · /.test(ep[0]));
  check("a truncated roster is warned about on paper too",
    /some students are missing from this list/.test(ep[0]));
}

console.log("\nPRINTING LEAVES NOTHING BEHIND\n");
{
  const env = { today: "2026-10-01", yearStart: "2026-08-12" };
  const { app, dom } = buildScreen(scriptSrc, env);
  app.cache = MARKS;
  app.setPerfectWindow("month");
  app.setPerfectMonth("2026-09");
  dom.fixed.attPerfectGrade.value = "7";
  await app.renderPerfectAttendance();
  app.openPerfectAttendanceSheet();

  app.printPerfectAttendanceSheet();
  const p = dom.prints[0];
  check("while the dialog is up, the page title is the PDF's file name",
    p && p.title === "Perfect Attendance - September 2026 - Grade 7", p && p.title);
  check("...and only the sheet prints", p && p.printing === true);
  dom.fire("afterprint");
  check("when it closes, the title comes back", dom.document.title === "Wildcat Hub");
  check("...the print class comes off", !dom.document.body.classList.contains("wc-printing"));
  check("...and the listener and its fallback timer are both gone",
    (dom.listeners.afterprint || []).length === 0 && dom.timers.length === 0);

  app.printPerfectAttendanceSheet();
  dom.runTimers();
  check("a browser that never says printing ended still gets its title back",
    dom.document.title === "Wildcat Hub" && !dom.document.body.classList.contains("wc-printing"));

  app.printPerfectAttendanceSheet();
  app.closePerfectAttendanceSheet();
  check("Close puts the title back at once", dom.document.title === "Wildcat Hub" &&
    !dom.document.body.classList.contains("wc-printing") && dom.sheets().length === 0);
  dom.document.title = "Something else, later";
  dom.fire("afterprint");
  dom.runTimers();
  check("...and a late 'printing ended' cannot overwrite a title set since", dom.document.title === "Something else, later");
  dom.document.title = "Wildcat Hub";

  // THE PURCHASE LIST SHARES THE ELEMENT. Open over it: replaced, cleanly.
  const purchase = dom.document.createElement("div");
  purchase.id = "wcPrintSheet";
  purchase.setAttribute("aria-label", "Purchase list");
  purchase.innerHTML = "PURCHASE LIST";
  dom.document.body.appendChild(purchase);
  dom.document.body.classList.add("wc-printing");   // as if its print never said it ended
  app.openPerfectAttendanceSheet();
  check("opening over the purchase list leaves ONE sheet, and it is this one",
    dom.sheets().length === 1 && sheetOf(dom).getAttribute("aria-label") === "Perfect attendance list" &&
    !/PURCHASE LIST/.test(sheetOf(dom).innerHTML));
  check("...and the purchase list's print class does not carry over", !dom.document.body.classList.contains("wc-printing"));
  app.openPerfectAttendanceSheet();
  check("opening it twice is still one sheet", dom.sheets().length === 1);

  // And the other way: this sheet mid-print, then the purchase list's Close
  // and Print. Its print must not inherit this one's title.
  app.printPerfectAttendanceSheet();
  app.closePurchaseListSheet();
  dom.runTimers();
  check("the purchase list's Close over this sheet leaves no title behind",
    dom.sheets().length === 0 && dom.document.title === "Wildcat Hub");
  app.printPurchaseList();
  check("...and its own print goes out under the page's own title",
    dom.prints[dom.prints.length - 1].title === "Wildcat Hub");
}

console.log("\nNOTHING TO PRINT IS SAID, NOT PRINTED\n");
{
  // Still loading.
  let release;
  const env = { today: "2026-10-01", yearStart: "2026-08-12", load: () => new Promise((r) => { release = r; }) };
  const { app, dom } = buildScreen(scriptSrc, env);
  const pending = app.renderPerfectAttendance();
  app.openPerfectAttendanceSheet();
  check("while the list loads, Print says so and opens nothing",
    dom.alerts.length === 1 && /has not loaded yet/.test(dom.alerts[0]) && dom.sheets().length === 0);
  release(MARKS);
  await pending;
  app.openPerfectAttendanceSheet();
  check("once it has loaded, the same button opens the sheet", dom.sheets().length === 1 && dom.alerts.length === 1);

  // Refused.
  const no = buildScreen(scriptSrc, { today: "2026-10-01", yearStart: "2026-08-12",
    load: async () => ({ allowed: false, rows: [], reason: "Perfect attendance is not available to your access level." }) });
  await no.app.renderPerfectAttendance();
  no.app.openPerfectAttendanceSheet();
  check("not allowed: Print says why and opens nothing",
    no.dom.alerts.length === 1 && /access level/.test(no.dom.alerts[0]) && no.dom.sheets().length === 0);
}

// ---------------------------------------------------- review round, 2026-10-01
// Each scenario takes a copy of script.js and reports what happened, so the
// teeth at the end can run the SAME scenario over a broken copy.

const SEP_SIGNIN = "Your sign-in expired. Sign in again to load perfect attendance.";

/**
 * A list on screen, then Refresh comes back refused. With `midClick`, a tab
 * is clicked while the Refresh loads, which redraws the cached list first.
 */
async function refusedRefresh(src, midClick) {
  let release;
  const env = { today: "2026-10-01", yearStart: "2026-08-12", load: () => new Promise((r) => { release = r; }) };
  const { app, dom } = buildScreen(src, env);
  app.cache = MARKS;
  await app.renderPerfectAttendance();
  const refresh = app.renderPerfectAttendance(true);
  if (midClick) app.setPerfectWindow("month");
  release({ allowed: false, needsSignIn: true, rows: [], reason: SEP_SIGNIN });
  await refresh;
  app.openPerfectAttendanceSheet();
  return { screen: dom.fixed.attPerfectBody.innerHTML, alerts: dom.alerts.slice(), sheets: dom.sheets().length };
}

/** Refresh, a tab click while it loads, then Refresh again (turned away by the load guard). */
async function secondRefresh(src) {
  let release;
  const env = { today: "2026-10-01", yearStart: "2026-08-12", load: () => new Promise((r) => { release = r; }) };
  const { app, dom } = buildScreen(src, env);
  app.cache = MARKS;
  await app.renderPerfectAttendance();
  const first = app.renderPerfectAttendance(true);
  app.setPerfectWindow("month");
  await app.renderPerfectAttendance(true);
  const listOnScreen = screenIds(dom).length > 0;
  app.openPerfectAttendanceSheet();
  const opened = dom.sheets().length === 1 && dom.alerts.length === 0;
  release(MARKS);
  await first;
  return { listOnScreen, opened };
}

/** A September list drawn on Tue 29 Sep, the tab left open, printed on Thu 1 Oct. */
async function staleMonthSheet(src) {
  const env = { today: "2026-09-29", yearStart: "2026-08-12" };
  const { app, dom } = buildScreen(src, env);
  app.cache = MARKS;
  app.setPerfectWindow("month");
  await app.renderPerfectAttendance();
  env.today = "2026-10-01";     // the idle refresh drops the marks; it does not redraw
  app.openPerfectAttendanceSheet();
  return { screen: dom.fixed.attPerfectBody.innerHTML, pages: sheetPages(dom) };
}

/** The sheet open, then Ctrl+P: the browser's print, not the sheet's button. */
async function ctrlP(src) {
  const { app, dom } = buildScreen(src, { today: "2026-10-01", yearStart: "2026-08-12" });
  app.cache = MARKS;
  app.setPerfectWindow("month");
  app.setPerfectMonth("2026-09");
  await app.renderPerfectAttendance();
  app.openPerfectAttendanceSheet();
  const state = () => ({ title: dom.document.title, printing: dom.document.body.classList.contains("wc-printing") });
  dom.fire("beforeprint");
  const during = state();
  dom.fire("afterprint");
  const after = state();
  const leftovers = (dom.listeners.afterprint || []).length + dom.timers.length;
  return { app, dom, during, after, leftovers };
}

/**
 * The perfect sheet open, then the purchase list's late draw lands in it --
 * exactly what renderPurchaseListSheet does: find #wcPrintSheet, write its
 * toolbar and pages into it. `printing` starts a print of this sheet first.
 */
async function purchaseListLands(src, printing) {
  const { app, dom } = buildScreen(src, { today: "2026-10-01", yearStart: "2026-08-12" });
  app.cache = MARKS;
  await app.renderPerfectAttendance();
  app.openPerfectAttendanceSheet();
  if (printing) app.printPerfectAttendanceSheet();
  const sheet = sheetOf(dom);
  sheet.innerHTML = '<div class="print-toolbar"><div class="print-toolbar-row"><strong>Purchase list</strong>' +
    '<button type="button" class="btn" onclick="printPurchaseList()">Print or save as PDF</button></div></div>' +
    '<div class="print-pages"><section class="print-page"><h2>Power-Up Pass</h2></section></div>';
  const afterLanding = { title: dom.document.title, printing: dom.document.body.classList.contains("wc-printing") };
  dom.fire("beforeprint");      // Ctrl+P, now over the purchase list
  const ctrlPTitle = dom.document.title;
  const printsBefore = dom.prints.length;
  app.printPerfectAttendanceSheet();   // a stale call cannot print it under this list's name either
  return {
    label: sheet.getAttribute("aria-label"), kind: sheet.getAttribute("data-sheet"),
    afterLanding, ctrlPTitle, printedAgain: dom.prints.length !== printsBefore,
    hooks: (dom.listeners.beforeprint || []).length, sheets: dom.sheets().length,
  };
}

/** All grades, excused ones FORGIVEN, a page per grade: each page's count. */
async function forgivingPages(src) {
  const { app, dom } = buildScreen(src, { today: "2026-10-01", yearStart: "2026-08-12" });
  app.cache = MARKS;
  app.setPerfectWindow("month");
  app.setPerfectMonth("2026-09");
  dom.fixed.attPerfectExcused.checked = false;
  await app.renderPerfectAttendance();
  app.openPerfectAttendanceSheet();
  return { screen: dom.fixed.attPerfectBody.innerHTML, ids: screenIds(dom), pages: sheetPages(dom) };
}

/** A grade from PowerSchool that is also markup, on a page per grade. */
const MARKUP_GRADE = '<img src=x onerror="alert(1)">';
async function markupGradeSheet(src) {
  const { app, dom } = buildScreen(src, { today: "2026-10-01", yearStart: "2026-08-12" });
  app.cache = Object.assign({}, MARKS, { rows: ROWS.concat([
    student({ studentNumber: "2001", firstName: "Zed", lastName: "Quinn", gradeLevel: MARKUP_GRADE })]) });
  app.setPerfectWindow("month");
  app.setPerfectMonth("2026-09");
  await app.renderPerfectAttendance();
  app.openPerfectAttendanceSheet();
  return sheetOf(dom).innerHTML;
}

/** The sheet left open, then the logout confirmed (the inactivity logout's path). */
async function logoutWithSheet(src) {
  const { app, dom } = buildScreen(src, { today: "2026-10-01", yearStart: "2026-08-12" });
  app.cache = MARKS;
  await app.renderPerfectAttendance();
  app.openPerfectAttendanceSheet();
  await app.logout();
  return {
    sheets: dom.sheets().length,
    login: !dom.fixed.loginScreen.classList.contains("hidden") && dom.fixed.mainApp.classList.contains("hidden"),
    hooks: (dom.listeners.beforeprint || []).length,
  };
}

console.log("\nA REFUSED REFRESH LEAVES NOTHING PRINTABLE\n");
{
  const plain = await refusedRefresh(scriptSrc, false);
  check("a list on screen, then Refresh refused: the card says why",
    plain.screen.includes("Your sign-in expired"));
  check("...and Print says so and opens no sheet",
    plain.sheets === 0 && plain.alerts.length === 1 && /sign-in expired/.test(plain.alerts[0]), plain.alerts.join(" / "));
  const mid = await refusedRefresh(scriptSrc, true);
  check("a tab clicked WHILE the Refresh loads redraws the old list, and the refusal still wins the card",
    mid.screen.includes("Your sign-in expired") && !/wc-pa-row/.test(mid.screen));
  check("...and Print then opens no sheet of the earlier list (it used to, with no alert)",
    mid.sheets === 0 && mid.alerts.length === 1 && /sign-in expired/.test(mid.alerts[0]), `${mid.sheets} sheet(s)`);
  const again = await secondRefresh(scriptSrc);
  check("Refresh, a click, Refresh again: the list still on screen is still printable",
    again.listOnScreen && again.opened, JSON.stringify(again));
}

console.log("\nA MONTH ON PAPER SAYS WHICH DAYS\n");
{
  const { screen, pages } = await staleMonthSheet(scriptSrc);
  check("the screen drawn on 29 Sep said 1 to 29 Sep", /September 2026 so far: <strong>/.test(screen));
  check("printed on 1 Oct, the paper still says 'so far'",
    pages.length > 0 && pages.every((p) => p.includes("<h2>Perfect Attendance — September 2026 (so far) — ")));
  check("...and names the days it covers, so it cannot pass for all of September",
    pages.every((p) => /<p class="print-sub">1 to 29 Sep 2026 · /.test(p)), (pages[0] || "").slice(0, 200));
}

console.log("\nCTRL+P PRINTS THE SHEET, NOT THE APP\n");
{
  const { app, dom, during, after, leftovers } = await ctrlP(scriptSrc);
  check("Ctrl+P with the sheet open prints only the sheet (the class the print rules need is on)",
    during.printing === true);
  check("...under the list's file name", during.title === "Perfect Attendance - September 2026 - All grades", during.title);
  check("...and when the dialog closes the title and class come back, with nothing left listening",
    after.title === "Wildcat Hub" && after.printing === false && leftovers === 0);
  app.printPerfectAttendanceSheet();
  check("the sheet's own button still starts ONE print (the Ctrl+P hook stands aside for it)",
    dom.prints.length === 1 && dom.prints[0].title === "Perfect Attendance - September 2026 - All grades" &&
    dom.prints[0].printing === true && (dom.listeners.afterprint || []).length === 1);
  dom.fire("afterprint");
  app.closePerfectAttendanceSheet();
  dom.fire("beforeprint");
  check("after Close, Ctrl+P is the page's own business again",
    dom.document.title === "Wildcat Hub" && !dom.document.body.classList.contains("wc-printing") &&
    (dom.listeners.beforeprint || []).length === 0);
}

console.log("\nTHE PURCHASE LIST LANDING LATE TAKES THE SHEET CLEANLY\n");
{
  const r = await purchaseListLands(scriptSrc, false);
  check("the element is relabelled as the purchase list, not announced as perfect attendance",
    r.label === "Purchase list" && r.kind === null, `${r.label} / ${r.kind}`);
  check("...Ctrl+P over it does not save it under this list's name",
    r.ctrlPTitle === "Wildcat Hub", r.ctrlPTitle);
  check("...a stale Print call does nothing, and this sheet's hooks are gone",
    !r.printedAgain && r.hooks === 0 && r.sheets === 1);
  const p = await purchaseListLands(scriptSrc, true);
  check("a print this sheet had started is ended: the title and class come back",
    p.afterLanding.title === "Wildcat Hub" && p.afterLanding.printing === false, JSON.stringify(p.afterLanding));
}

console.log("\nPER-GRADE PAGES FOLLOW THE EXCUSED SETTING\n");
{
  const { screen, ids, pages } = await forgivingPages(scriptSrc);
  const sep = R.perfectMonthWindow("2026-09", "2026-10-01", "2026-08-12");
  const want = ["6", "7", "8", "(none)"].map((g) => R.perfectList(
    ROWS.filter((r) => (String(r.gradeLevel).trim() || "(none)") === g), sep, { countExcused: false }).counts);
  check("forgiving, Ivy's excused absence keeps her on the screen", ids.includes("1007") && /excused ones forgiven/.test(screen));
  check("...and each grade's page counts by the SAME rule as the screen",
    pages.length === 4 && want.every((c, i) => pages[i].includes(
      `${c.perfect} of ${c.eligible} eligible student${c.eligible === 1 ? "" : "s"} (${c.pct}%)`)),
    pages.map((p) => (p.match(/\d+ of \d+ eligible students? \([\d.]+%\)/) || ["?"])[0]).join(" | "));
  check("...so Grade 6 reads 1 of 1, not 0 of 1 with a name under it",
    /1 of 1 eligible student \(100%\)/.test(pages[0]) && pageRows(pages[0]).some((r) => r.id === "1007"));
}

console.log("\nA GRADE THAT IS MARKUP PRINTS AS TEXT\n");
{
  const html = await markupGradeSheet(scriptSrc);
  check("the per-grade heading escapes a grade from PowerSchool",
    html.includes("<h2>Perfect Attendance — September 2026 — Grade &lt;img src=x onerror=&quot;alert(1)&quot;&gt;</h2>"));
  check("...and nowhere on the sheet is it live markup", !html.includes(MARKUP_GRADE) && !/<img/.test(html));
}

console.log("\nLOGGING OUT TAKES THE SHEET WITH IT\n");
{
  const r = await logoutWithSheet(scriptSrc);
  check("the login screen is up and the sheet of names is gone from on top of it",
    r.login && r.sheets === 0, JSON.stringify(r));
  check("...with its Ctrl+P hook", r.hooks === 0);
}

console.log("\nTHE WIRING\n");
{
  const card = htmlSrc.slice(htmlSrc.indexOf('<div id="attPerfectView" hidden>'), htmlSrc.indexOf("<!-- /attPerfectView -->"));
  check("the perfect attendance card was found", card.length > 500);
  // PINNED THE OLD TAB: the button now reads "Month".
  check("the tab reads 'Month' and still calls setPerfectWindow('month')",
    /data-pa="month"\s+onclick="setPerfectWindow\('month'\)">Month<\/button>/.test(card));
  check("'This month' is gone from the tab bar", !/>This month</.test(card));
  check("'Last full week' and 'Year to date' are unchanged",
    /data-pa="week"\s+onclick="setPerfectWindow\('week'\)">Last full week<\/button>/.test(card) &&
    /data-pa="year"\s+onclick="setPerfectWindow\('year'\)">Year to date<\/button>/.test(card));
  check("the month picker has a label for screen readers and starts hidden",
    /<label class="wc-att-grade-wrap" id="attPerfectMonthWrap" for="attPerfectMonth"\s+style="display:none">/.test(card) &&
    /<select id="attPerfectMonth"[^>]*aria-label="[^"]+"/.test(card.replace(/\s+/g, " ")));
  check("...and is the only place a month is chosen", /onchange="setPerfectMonth\(this\.value\)"/.test(card));
  const sortSel = (card.match(/<select id="attPerfectSort"[\s\S]*?<\/select>/) || [""])[0];
  check("the sort dropdown has a label and the four orders, today's first and selected",
    /aria-label="[^"]+"/.test(sortSel) &&
    [...sortSel.matchAll(/<option value="(\w+)"( selected)?>([^<]+)</g)].map((m) => m[1] + (m[2] ? "*" : "") + "=" + m[3]).join("|") ===
      "grade*=Grade, then last name|last=Last name|first=First name|id=Student ID");
  check("...and its labels are the module's", R.PERFECT_SORTS.every((s) => sortSel.includes(`>${s.label}<`)));
  check("the Print / PDF button is in the card", /onclick="openPerfectAttendanceSheet\(\)"[^>]*>[\s\S]{0,200}Print \/ PDF<\/button>/.test(card));

  const render = lift(scriptSrc, "renderPerfectAttendance");
  check("the screen reads today the school's way before picking a window",
    /const today = attTodayIso\(\);\s*const windows = R\.perfectWindows\(today, basis\.first\);/.test(render));
  check("the Month tab's window is the picked month",
    /_paWindow === 'month'\s*\? R\.perfectMonthWindow\(syncPerfectMonthPicker\(\), today, basis\.first\)/.test(render));
  check("the list is sorted ONCE and that array is what both the screen and Print use",
    /const students = R\.perfectSort\(out\.students, sort\);/.test(render) &&
    /_paShown = \{[^}]*students: students \};/.test(render) && /students\.forEach\(st =>/.test(render));
  const sheetFn = lift(scriptSrc, "renderPerfectAttendanceSheet");
  check("the sheet never fetches or re-sorts (no silent refetch)",
    !/loadPerfectMarks|convexQuery|perfectSort|_paCache/.test(sheetFn + lift(scriptSrc, "openPerfectAttendanceSheet")));
  check("the sheet is built from what the screen drew", /const view = _paShown;/.test(lift(scriptSrc, "openPerfectAttendanceSheet")));
  check("every printed cell but the row number is escaped",
    (sheetFn.match(/'<td>' \+ (?!\(i \+ 1\))[^']*?\+ '<\/td>'/g) || []).every((c) => /escapeHtml\(/.test(c)) &&
    (sheetFn.match(/'<td>' \+ escapeHtml\(/g) || []).length === 3);
  // The button and Ctrl+P share one start (beginPerfectAttendancePrint) since
  // the 2026-10-01 review; the restore lives there now.
  const printFn = lift(scriptSrc, "beginPerfectAttendancePrint");
  check("printing restores the title on afterprint, on a timeout, and on Close",
    /document\.title = before;/.test(printFn) && /window\.addEventListener\('afterprint', done\)/.test(printFn) &&
    /setTimeout\(done, 60000\)/.test(printFn) && /endPerfectAttendancePrint\(\);/.test(lift(scriptSrc, "closePerfectAttendanceSheet")) &&
    /beginPerfectAttendancePrint\(\);\s*try \{ window\.print\(\); \}/.test(lift(scriptSrc, "printPerfectAttendanceSheet")));
  check("logout closes the sheet, inside the confirmed branch",
    /if \(await showConfirm\([^)]*\)\) \{[\s\S]*closePerfectAttendanceSheet\(\);[\s\S]*\}/.test(lift(scriptSrc, "logout")));

  // THE PURCHASE LIST IS NOT TOUCHED. Its four functions are pinned as they
  // stood on 2026-10-01, when this sheet was added beside them. If you change
  // the purchase list ON PURPOSE, re-pin this hash in the same commit.
  const purchase = ["openPurchaseListSheet", "renderPurchaseListSheet", "printPurchaseList", "closePurchaseListSheet"]
    .map((n) => lift(scriptSrc, n)).join("\n");
  const hash = createHash("sha256").update(purchase).digest("hex").slice(0, 16);
  check("the purchase list's functions are exactly as they were", hash === PURCHASE_LIST_HASH, hash);

  // ...BAR ONE LINE, added on purpose (2026-10-01, the final check): a closed
  // purchase list whose Promise Time lookup answers late must not redraw over
  // a perfect attendance sheet opened since.
  {
    const fn = lift(scriptSrc, "renderPurchaseListSheet");
    const drawsInto = (src, kind) => {
      let drew = false;
      const sheet = { getAttribute: (k) => (k === "data-sheet" ? kind : null), set innerHTML(v) { drew = true; } };
      const render = new Function("document", "purchaseListChoices", src + "\nreturn renderPurchaseListSheet;")(
        { getElementById: () => sheet }, () => { drew = true; return []; });
      try { render(); } catch (e) { /* the rest of the purchase list is not set up here */ }
      return drew;
    };
    check("a purchase list's late redraw leaves an open perfect attendance sheet alone", drawsInto(fn, "perfect") === false);
    check("...and still draws into its own sheet", drawsInto(fn, null) === true);
    const unguarded = fn.replace("if (!sheet || sheet.getAttribute('data-sheet') === 'perfect') return;", "if (!sheet) return;");
    check("TEETH: without that line, the late redraw lands in the perfect sheet",
      unguarded !== fn && drawsInto(unguarded, "perfect") === true);
  }
  check("...and know nothing about page titles, which are this sheet's business alone", !/document\.title/.test(purchase));

  check("the new test runs right after the old one in npm test",
    /node perfect-attendance\.test\.mjs && node perfect-attendance-month\.test\.mjs/.test(pkg.scripts.test));
  const stamps = [...htmlSrc.matchAll(/\?v=([0-9a-z]+)/g)].map((m) => m[1]);
  check("every cache stamp moved to 20261001p, so browsers load the new files",
    stamps.length === 26 && stamps.every((s) => s === "20261001p"), [...new Set(stamps)].join(","));
}

console.log("\nDO THE ASSERTIONS HAVE TEETH?\n");
{
  // 1. A month that runs to its last day instead of today.
  const broken = loadRoster((s) => breakOnce(s, "var to = last > today ? today : last;", "var to = last;", "to-today"));
  check("TEETH: a month running past today lets tomorrow's absence break it",
    broken.perfectVerdict(student({ absentDates: ["2026-10-02"] }),
      broken.perfectMonthWindow("2026-10", "2026-10-01", "2026-08-12"), {}).perfect === false);
}
{
  // 2. A month that starts on the 1st even before school did.
  const broken = loadRoster((s) => breakOnce(s, "var from = first < start ? start : first;", "var from = first;", "from-start"));
  check("TEETH: an unclipped August turns day-one enrolments into late arrivals",
    broken.perfectVerdict(student({ entryDate: "2026-08-12" }),
      broken.perfectMonthWindow("2026-08", "2026-10-01", "2026-08-12"), {}).eligible === false);
}
{
  // 3. A case-sensitive sort.
  const broken = loadRoster((s) => s.split(".trim().toLowerCase();").join(".trim();"));
  const twins = [{ studentNumber: "2", lastName: "Diaz" }, { studentNumber: "1", lastName: "diaz" }];
  check("TEETH: a case-sensitive sort reorders two students the stable one keeps",
    broken.perfectSort(twins, "last").map((s) => s.studentNumber).join(",") !== "2,1" &&
    R.perfectSort(twins, "last").map((s) => s.studentNumber).join(",") === "2,1");
}
{
  // 4. The month picker always showing.
  const src = breakOnce(scriptSrc, "if (wrap) wrap.style.display = _paWindow === 'month' ? '' : 'none';",
    "if (wrap) wrap.style.display = '';", "picker");
  const { app, dom } = buildScreen(src, { today: "2026-10-01", yearStart: "2026-08-12" });
  app.cache = MARKS;
  await app.renderPerfectAttendance();
  check("TEETH: a month picker shown on the week tab is caught", dom.fixed.attPerfectMonthWrap.style.display === "");
}
{
  // 5. The sheet rebuilt from the rows instead of the screen's sorted list.
  const src = breakOnce(scriptSrc,
    "pages = [{ heading: '', gradeName: paGradeName(view.grade), counts: view.counts, students: view.students }];",
    "pages = [{ heading: '', gradeName: paGradeName(view.grade), counts: view.counts, students: R.perfectList(view.rows, view.win, {}).students }];",
    "sheet-list");
  const { app, dom } = buildScreen(src, { today: "2026-10-01", yearStart: "2026-08-12" });
  app.cache = MARKS;
  app.setPerfectWindow("month");
  app.setPerfectMonth("2026-09");
  dom.fixed.attPerfectSort.value = "id";
  await app.renderPerfectAttendance();
  app.setPerfectSheetByGrade(false);
  app.openPerfectAttendanceSheet();
  check("TEETH: a sheet that re-derives its list prints a different order from the screen",
    pageRows(sheetPages(dom)[0]).map((r) => r.id).join(",") !== screenIds(dom).join(","));
}
{
  // 6. A print that forgets to give the title back.
  const src = breakOnce(scriptSrc, "                document.title = before;\n", "", "title");
  const { app, dom } = buildScreen(src, { today: "2026-10-01", yearStart: "2026-08-12" });
  app.cache = MARKS;
  await app.renderPerfectAttendance();
  app.openPerfectAttendanceSheet();
  app.printPerfectAttendanceSheet();
  dom.fire("afterprint");
  check("TEETH: a title left as the file name is caught", dom.document.title !== "Wildcat Hub");
}
{
  // 7. Opening over the purchase list without clearing its print class.
  const src = breakOnce(scriptSrc, "            if (old) old.remove();\n            document.body.classList.remove('wc-printing');\n",
    "            if (old) old.remove();\n", "class");
  const { app, dom } = buildScreen(src, { today: "2026-10-01", yearStart: "2026-08-12" });
  app.cache = MARKS;
  await app.renderPerfectAttendance();
  dom.document.body.classList.add("wc-printing");
  app.openPerfectAttendanceSheet();
  check("TEETH: a print class carried over from the purchase list is caught",
    dom.document.body.classList.contains("wc-printing"));
}

// ------------------------------------------- teeth for the 2026-10-01 review
{
  // 8. The last day of a month called finished.
  const broken = loadRoster((s) => breakOnce(s, "var partial = last >= today;", "var partial = to < last;", "last-day"));
  check("TEETH: a month called whole on its last day is caught",
    broken.perfectMonths("2026-09-30", "2026-08-12")[0].label === "September 2026");
}
{
  // 9. The refusal no longer clearing what Print prints.
  const src = breakOnce(scriptSrc, "                _paShown = null;\n                _paWhyNot = (res && res.reason)",
    "                _paWhyNot = (res && res.reason)", "refused");
  const r = await refusedRefresh(src, true);
  check("TEETH: a refused Refresh that leaves the earlier list printable is caught", r.sheets === 1 && r.alerts.length === 0);
}
{
  // 10. Clearing on the way in again (the code as first built).
  const src = breakOnce(scriptSrc, "            const R = window.WildcatRoster;\n            if (!R || typeof R.perfectList",
    "            _paShown = null;\n            const R = window.WildcatRoster;\n            if (!R || typeof R.perfectList", "entry");
  const r = await secondRefresh(src);
  check("TEETH: 'nothing to print' under a list still on screen is caught", r.listOnScreen && !r.opened);
}
{
  // 11. A printed month without its days.
  const src = breakOnce(scriptSrc,
    "const dates = view.win.key === 'month' && R.perfectPeriodDates ? R.perfectPeriodDates(view.win) : '';",
    "const dates = '';", "dates");
  const { pages } = await staleMonthSheet(src);
  check("TEETH: a month sheet that does not say which days is caught",
    pages.length > 0 && !pages.some((p) => /1 to 29 Sep 2026/.test(p)));
}
{
  // 12. No Ctrl+P hook.
  const src = breakOnce(scriptSrc, "            window.addEventListener('beforeprint', perfectAttendanceBeforePrint);\n", "", "ctrl-p");
  const { during } = await ctrlP(src);
  check("TEETH: Ctrl+P printing the whole app is caught", during.printing === false && during.title === "Wildcat Hub");
}
{
  // 13. No takeover watch: the purchase list stays announced as perfect attendance.
  const src = breakOnce(scriptSrc, "                _paSheetWatch.observe(sheet, { childList: true });\n", "", "watch");
  const r = await purchaseListLands(src, false);
  check("TEETH: a purchase list left labelled 'Perfect attendance list' is caught",
    r.label === "Perfect attendance list" && r.kind === "perfect");
  // ...and without the content check either, Ctrl+P saves it under this list's name.
  const worse = breakOnce(src, "\n                && sheet.querySelector('[data-pa-sheet]') ? sheet : null;", " ? sheet : null;", "marker");
  const w = await purchaseListLands(worse, false);
  check("TEETH: the purchase list saved as 'Perfect Attendance - ...' is caught", /^Perfect Attendance - /.test(w.ctrlPTitle));
}
{
  // 14. The per-grade counts judged by the default (strict) rule.
  const src = breakOnce(scriptSrc, "{ countExcused: view.strict }", "{}", "per-grade-rule");
  const { pages } = await forgivingPages(src);
  check("TEETH: a forgiving sheet whose Grade 6 page says 0 of 1 is caught",
    /0 of 1 eligible student \(0%\)/.test(pages[0]) && pageRows(pages[0]).some((r) => r.id === "1007"));
}
{
  // 15. The per-grade heading not escaped.
  const src = breakOnce(scriptSrc,
    "'<h2>' + escapeHtml('Perfect Attendance — ' + period + (pg.heading ? ' — ' + pg.heading : '')) + '</h2>'",
    "'<h2>Perfect Attendance — ' + period + (pg.heading ? ' — ' + pg.heading : '') + '</h2>'", "h2");
  check("TEETH: a grade printed as live markup is caught", (await markupGradeSheet(src)).includes(MARKUP_GRADE));
}
{
  // 16. Logout leaving the sheet up.
  const src = breakOnce(scriptSrc,
    "                if (typeof closePerfectAttendanceSheet === 'function') closePerfectAttendanceSheet();\n", "", "logout");
  const r = await logoutWithSheet(src);
  check("TEETH: names left over the login screen are caught", r.login && r.sheets === 1);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
