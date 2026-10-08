// The Reflection Room screen, run for real in a test: the SHIPPED screen code
// lifted out of a copy of script.js and run against a small fake DOM, window
// and server. Used by reflection-print.test.mjs (this build's screen) and
// reflection-demo.test.mjs (this build's screen, and the screen of an older
// build that an open tab may still be running, against the shipped server).
//
// A regex over the source would pass with the code broken; running it cannot.

/** A named function's whole text out of script.js, braces matched past strings and comments. */
export function lift(src, name) {
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
export function rrBlock(src) {
  const start = src.indexOf("        const RR_REFRESH_MS = 30000;");
  const end = src.indexOf("        // At most one roster fetch per visit to the referral form");
  if (start < 0 || end < start) throw new Error("the Reflection Room block was not found in script.js");
  return src.slice(start, end);
}

export const SORT_FNS = ["escapeHtml", "wcSortCellText", "wcSortValue", "wcSortColumnType", "wcSortOrder", "wcSortSet", "wcSortTh", "wcSortItems"];

/**
 * Just enough DOM, window and server for the Reflection Room pane and its
 * sheet. `answer.query(args, path)` and `answer.mutation(args, path)` stand
 * in for the server: either may return a promise, so a test can pass the call straight
 * through to the shipped server code (reflection-demo.test.mjs does).
 * `students` are the app's own records the screen joins names from.
 */
export function makeWorld(src, answer, students = []) {
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
      convexQuery: async (path, args) => { calls.push({ kind: "query", path, args, sheetOpen: !!children.find((c) => c.id === "wcPrintSheet") }); return structuredClone(await answer.query(args, path)); },
      convexMutation: async (path, args) => { calls.push({ kind: "mutation", path, args }); return structuredClone(await answer.mutation(args, path)); },
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
    students, { name: "Pat Supervisor", email: "pat@school.test" },
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
