// The five Wildcat Cash analytics fixes, as the owner decided them.
// Run: npm test
//
// THE OWNER, 2026-10-01: "do the 5 fixes, admins and PBIS only, 5 to 1".
//
//   1. Store purchases were counted as bad behaviour. A Power-Up Pass is kind
//      'redeem' with a negative amount, and every screen that split rows by
//      SIGN read it as a $1,500 deduction.
//   2. Every teacher could read every colleague's numbers by name. Staff-level
//      views are for admins, superadmins and the PBIS team -- by ROLE.
//   3. The Teacher table was green from 70% positive (about 2.3 to 1) while
//      the goal everywhere else is 5 to 1.
//   4. Today's goal counted deductions as if they were awards, divided a
//      calendar month by thirty, and took its median over every staff record.
//   5. The Trends tab was a placeholder.
//
// AND THE REVIEW'S FINDINGS (round 1), each run below with a teeth check: the
// home feed scoped like the audit log, an inactivity logout nobody can Cancel,
// a reset row's badge, the quiet list's award count, the gauge rounding down,
// no goal and no "so far" at the weekend, an empty grade selection said as
// such, and a check after EACH renderer rather than once at the end.
//
// Almost all of this RUNS THE SHIPPED CODE: the functions are lifted out of
// script.js and run against a small fake DOM, with the real wildcat-roster.js,
// wildcat-store.js and wildcat-cashaudit.js loaded beside them. Then the
// "teeth" section re-breaks each load-bearing line in a copy of the source and
// checks that a test notices. A regex over the source would still pass with
// the code broken.

// The school's calendar day is Los Angeles. Set before any Date is made, so the
// "not UTC" checks below have something to bite on whatever machine runs them.
process.env.TZ = "America/Los_Angeles";

import { readFileSync } from "node:fs";

const scriptSrc = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const uiCss = readFileSync(new URL("./wildcat-ui.css", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const rosterSrc = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
const storeSrc = readFileSync(new URL("./wildcat-store.js", import.meta.url), "utf8");
const auditSrc = readFileSync(new URL("./wildcat-cashaudit.js", import.meta.url), "utf8");
// Comments stripped before any "this is not in the code" assertion.
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

/** One single-line top-level const. */
function liftConst(src, name) {
  const m = new RegExp("^        const " + name + " = [^\\n]*;$", "m").exec(src);
  if (!m) throw new Error("missing const " + name);
  return m[0];
}

/** Replace exactly one anchor, or fail loudly: a teeth test whose anchor moved proves nothing. */
function breakOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`teeth "${label}": anchor not found exactly once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}

/** Replace an anchor that must occur exactly `n` times -- every copy of one guard, say. */
function breakAll(src, from, to, n, label) {
  const count = src.split(from).length - 1;
  if (count !== n) throw new Error(`teeth "${label}": anchor found ${count} times, expected ${n}`);
  return src.split(from).join(to);
}

/** A Date whose "now" is fixed, for the screens that ask what day it is. */
function dateAt(nowMs) {
  const Real = globalThis.Date;
  return class extends Real {
    constructor(...a) { if (a.length) super(...a); else super(nowMs); }
    static now() { return nowMs; }
  };
}

/** The shared modules, loaded for real into one sandbox that plays `window`. */
function loadModules() {
  const sandbox = {};
  for (const src of [rosterSrc, storeSrc, auditSrc]) new Function("globalThis", src).call(sandbox, sandbox);
  return sandbox;
}

/** A fake element: what the renderers touch, and nothing more. */
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

/**
 * A document that only knows the ids index.html really has. A renderer reaching
 * for an element that does not exist gets null here as it would in the app,
 * rather than a convenient stand-in.
 */
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
      return [];
    },
    /** Everything any element holds, for "is a name anywhere on screen?". */
    text: () => Object.values(els).map((e) => e.innerHTML + " " + e.textContent).join(" "),
  };
}

const FNS = [
  "escapeHtml", "wcIsoDay", "enrolledStudents", "reversedCashIds", "isCashBehaviourRow", "cashBehaviourKind",
  "cashMovementEffect", "cashStaffViewsAllowed", "wipeStaffCashViews", "applyCashAnalyticsGate",
  "cashRatioVerdict", "cashRatioHtml", "setCashRatioTile", "switchAnalyticsSubtab", "updateDashboard",
  "updateCashAnalytics", "updateTeacherInteractions", "updateTeacherActivityTable", "updateInterventionStudents",
  "updateTeacherInteractionDetails", "populateTeacherFilterDropdown", "cashWeekMonday", "cashWeekLabel",
  "cashTrendWeeks", "cashTrendShare", "cashTrendsHtml", "renderCashTrends", "wcRenderDailyGoal",
  "cashGoalStaffCounts", "wcRenderQuietStudents", "cashAuditEntriesFor", "updateCashAuditLogTable",
  "dashFeedEntriesFor",
];
const CONSTS = [
  "CASH_STAFF_VIEW_ROLES", "CASH_RATIO_GOAL", "CASH_RATIO_MIN_DEDUCTIONS", "CASH_LAUNCH_WEEK",
  "CASH_TREND_GRADES", "CASH_GOAL_MIN_STAFF", "QUIET_WINDOW_DAYS",
];

/**
 * The app's own functions, from `src`, closed over a small world: the globals
 * they read are `let`s that set() can change between calls, the way a sign-in
 * on a shared Chromebook changes them without a reload.
 */
function loadApp(src, G) {
  const body = `
    let currentUser = G.currentUser || null;
    let teachers = G.teachers || [];
    let students = G.students || [];
    let cashTransactions = G.cashTransactions || [];
    let auditLog = G.auditLog || [];
    let _historyCutoffMs = G.cutoffMs === undefined ? null : G.cutoffMs;
    let _interventionReversedIds = null;
    const document = G.document;
    const window = G.window;
    // "Now", when a test needs it fixed: a weekday, or a Saturday.
    const Date = G.Date || globalThis.Date;
    const console = { log() {}, warn() {}, error() {} };
    function activeTeacherRoster() { return G.roster || null; }
    function paginate(key, rows) { return { slice: rows, page: 1, pages: 1, total: rows.length }; }
    function renderPager() {}
    function loadCashArrivalAlerts() {}
    function renderCashDriftPanel() {}
    ${CONSTS.map((n) => liftConst(src, n)).join("\n")}
    ${FNS.map((n) => liftFn(src, n)).join("\n")}
    return {
      set(k, v) {
        if (k === "currentUser") currentUser = v;
        else if (k === "teachers") teachers = v;
        else if (k === "students") students = v;
        else if (k === "cashTransactions") cashTransactions = v;
        else if (k === "auditLog") auditLog = v;
        else if (k === "cutoffMs") _historyCutoffMs = v;
        else throw new Error("unknown global " + k);
      },
      ${FNS.join(", ")}
    };`;
  return new Function("G", body)(G);
}

// ---------------------------------------------------------------- the world

const MODS = loadModules();
const ADMIN = { id: "a1", name: "Dr. Admin", role: "admin" };
const SUPER = { id: "su", name: "Owner", role: "superadmin" };
const PBIS = { id: "p1", name: "Pat PBIS", role: "pbis" };
// A campus aide WITH the attendance grant: the grant is for attendance, not cash.
const AIDE = { id: "c1", name: "Casey Aide", role: "campusaide", attendanceWatch: true };
const LEE = { id: "t1", name: "<b>Ms. Lee</b>", role: "teacher" };   // a name that would inject if not escaped
const PARK = { id: "t2", name: "Mr. Park", role: "teacher" };
const STAFF = [ADMIN, SUPER, PBIS, AIDE, LEE, PARK];

const kid = (id, grade, extra = {}) => ({ id, firstName: "Kid", lastName: id.toUpperCase(), grade, wildcatCashBalance: 0, ...extra });

/** The ledger every section shares: one of each thing that is NOT a behaviour, beside real ones. */
function ledger() {
  const at = new Date().toISOString();
  return [
    { id: "a1", kind: "award", type: "positive", amount: 100, teacherId: "t1", studentId: "s6", behaviorName: "Be Present", timestamp: at },
    { id: "a2", kind: "award", type: "positive", amount: 100, teacherId: "t1", studentId: "s9", behaviorName: "Be Present", timestamp: at },
    { id: "d1", kind: "deduct", type: "negative", amount: -50, teacherId: "t1", studentId: "s9", behaviorName: "Not Responsible", timestamp: at },
    // A child buying a Power-Up Pass from their own Chromebook: no adult at all.
    { id: "p1", kind: "redeem", type: "negative", amount: -1500, teacherId: "", teacherName: "Kid S9", studentId: "s9",
      behaviorId: "reward:pup", behaviorName: "Power-Up Pass", timestamp: at },
    // The same pass rung up at the desk by Ms. Lee: it carries HER id.
    { id: "p2", kind: "redeem", type: "negative", amount: -1500, teacherId: "t1", studentId: "s10",
      behaviorId: "reward:pup", behaviorName: "Power-Up Pass", timestamp: at },
    { id: "f1", kind: "award", type: "positive", amount: 1500, teacherId: "", studentId: "s10",
      behaviorId: "reward-refund:pup", behaviorName: "Refund: Power-Up Pass", timestamp: at },
    { id: "r0", kind: "deduct", type: "negative", amount: -500, teacherId: "t2", studentId: "s10", behaviorName: "Disrespect", timestamp: at },
    { id: "rv", kind: "reversal", type: "positive", amount: 500, teacherId: "a1", studentId: "s10", reversesTxnId: "r0",
      behaviorName: "Reversed: Disrespect", timestamp: at },
    { id: "z", kind: "deduct", type: "negative", amount: -2000, teacherId: "a1", studentId: "s9", behaviorId: "system_reset", timestamp: at },
    // Older than the `kind` field: its sign is all there is.
    { id: "old", type: "positive", amount: 25, teacherId: "t2", studentId: "s6", behaviorName: "Be Kind", timestamp: at },
  ];
}
// s6 carries Ms. Lee's award on its own record (the dropdown reads those), and
// s11 five of her deductions, so the intervention table flags him and names her.
const KIDS = () => [
  kid("s6", "6", { wildcatCashBalance: 125, wildcatCashTransactions: [{ id: "a1", kind: "award", amount: 100, teacherId: "t1" }] }),
  kid("s9", "9", { wildcatCashBalance: 550 }),
  kid("s10", "10", { wildcatCashBalance: 1000 }),
  kid("s11", "11", { wildcatCashTransactions: Array.from({ length: 5 }, (_, i) =>
    ({ id: "i" + i, kind: "deduct", amount: -100, teacherId: "t1" })) }),
  kid("gone", "9", { enrolled: false, wildcatCashBalance: 999 }),
];

function world(src = scriptSrc, over = {}) {
  const dom = makeDom(over);
  const app = loadApp(src, {
    currentUser: over.currentUser || ADMIN, teachers: over.teachers || STAFF, students: over.students || KIDS(),
    cashTransactions: over.cashTransactions || ledger(), auditLog: over.auditLog || [], cutoffMs: over.cutoffMs,
    document: dom, window: MODS, roster: over.roster, Date: over.Date,
  });
  return { dom, app };
}
const el = (w, id) => w.dom.getElementById(id);
/** The detail table's row for the balance reset: the ledger's one -$2000. */
function resetRow(table) {
  return table.split("<tr").find((r) => /-\$2000/.test(r)) || "";
}
/** All Types in the detail table, from `src`. */
function allTypes(src) {
  const w = world(src);
  el(w, "teacherInteractionFilterType").value = "all";
  w.app.updateTeacherInteractionDetails();
  return el(w, "teacherInteractionDetailsTableBody").innerHTML;
}
/** The quiet list's note for a child with five awards and one deduction, beside two well-noticed classmates. */
function quietNote(src) {
  const at = new Date().toISOString();
  const rows = [];
  const add = (sid, n, kind) => { for (let i = 0; i < n; i++) rows.push({ id: sid + kind + i, kind,
    amount: kind === "award" ? 100 : -50, teacherId: "t1", studentId: sid, timestamp: at }); };
  add("q", 5, "award"); add("q", 1, "deduct"); add("a", 20, "award"); add("b", 20, "award");
  const w = world(src, { students: [kid("q", "9"), kid("a", "9"), kid("b", "9")], cashTransactions: rows });
  w.app.wcRenderQuietStudents(true);
  return (el(w, "dashQuietList").innerHTML.split("wc-quiet-row").find((r) => /Kid Q</.test(r)) || "");
}
/** The cells of Ms. Lee's row in the Teacher table: name, total, +, -, ratio, $+, $-, students. */
const leeCells = (table) => {
  const row = table.split("<tr>").find((r) => /Ms\. Lee/.test(r)) || "";
  return [...row.matchAll(/<td[^>]*>\s*([\s\S]*?)\s*<\/td>/g)].map((m) => m[1]);
};

// ==================================================================== 1
console.log("\n1. Real behaviour only: one rule, by kind, on every screen");
{
  const { app } = world();
  const rows = ledger();
  const ids = new Set(["r0"]);
  const k = (id) => app.cashBehaviourKind(rows.find((r) => r.id === id), ids);
  check("an award is an award", k("a1") === "award");
  check("a deduction is a deduction", k("d1") === "deduct");
  check("a store PURCHASE is not a behaviour", app.isCashBehaviourRow(rows.find((r) => r.id === "p1"), ids) === false && k("p1") === null);
  check("nor is one rung up at the desk", k("p2") === null);
  check("nor a store refund, though it is kind 'award'", k("f1") === null);
  check("nor a reversal, nor the row it reversed", k("rv") === null && k("r0") === null);
  check("nor a balance reset", k("z") === null);
  check("a row older than `kind` falls back to its sign", k("old") === "award");
  check("a kind nobody has invented yet starts out as bookkeeping",
    app.cashBehaviourKind({ id: "q", kind: "adjust", amount: -10 }, ids) === null);
  check("the money rule is untouched: a purchase still moves the balance and `spent`",
    app.cashMovementEffect(-1500, "redeem").wildcatCashBalance === -1500 &&
    app.cashMovementEffect(-1500, "redeem").wildcatCashSpent === 1500 &&
    app.cashMovementEffect(-1500, "redeem").wildcatCashDeducted === 0);
}

console.log("\n   The Data Dashboard");
{
  const w = world();
  w.app.updateDashboard();
  // Real behaviour: a1, a2 and the kind-less award; d1. Not p1, p2, f1, r0, rv, z.
  check("positive behaviours are the three awards", el(w, "dashTotalPositive").textContent === 3, el(w, "dashTotalPositive").textContent);
  check("negative behaviours are the ONE deduction, no purchases", el(w, "dashTotalNegative").textContent === 1,
    el(w, "dashTotalNegative").textContent);
  check("cash deducted is $50, not $3,050", el(w, "dashTotalDeducted").textContent === "$50", el(w, "dashTotalDeducted").textContent);
  check("cash awarded leaves the refund and the reversal out", el(w, "dashTotalAwarded").textContent === "$225",
    el(w, "dashTotalAwarded").textContent);
  check("Total in Circulation is still the balances, enrolled only",
    el(w, "dashTotalCirculation").textContent === "$1,675", el(w, "dashTotalCirculation").textContent);
  check("the ratio tile speaks the 5 to 1 language", el(w, "avgPositivityRatio").textContent === "too few deductions to judge");
}

console.log("\n   Most Common Behaviors");
{
  const w = world();
  w.app.updateCashAnalytics();
  const out = el(w, "cashAnalyticsDetails").innerHTML;
  check("lists real behaviours", /Be Present/.test(out));
  check("and not the Power-Up Pass", !/Power-Up Pass/.test(out));
}

console.log("\n   Teacher Interactions, the detail filter and the badge");
{
  const w = world();
  w.app.updateTeacherInteractions();
  const cells = leeCells(el(w, "teacherActivityTableBody").innerHTML);
  check("the sale Ms. Lee rang up is not one of her interactions", cells[1] === "3" && cells[3] === "1", cells.slice(0, 4).join("|"));
  check("nor is it dollars she deducted", cells[6] === "$50", cells[6]);

  el(w, "teacherInteractionFilterType").value = "negative";
  w.app.updateTeacherInteractionDetails();
  const neg = el(w, "teacherInteractionDetailsTableBody").innerHTML;
  check("'Negative Only' lists the deduction", /Not Responsible/.test(neg));
  check("and no purchase, reset or reversal", !/Power-Up Pass|System Reset|Disrespect/.test(neg));

  el(w, "teacherInteractionFilterType").value = "all";
  w.app.updateTeacherInteractionDetails();
  const all = el(w, "teacherInteractionDetailsTableBody").innerHTML;
  check("in 'All Types' a purchase wears a Purchase badge, not Negative", /Purchase/.test(all));
  check("and a self-serve sale is not filed under a child's name as teacher",
    /<td>Student store<\/td>/.test(all) && !/<td>Kid S9<\/td>/.test(all));
  check("and a balance reset wears a grey Reset badge, not a red Negative one", /Reset/.test(resetRow(all)) &&
    !/Negative/.test(resetRow(all)) && /#6E7885/.test(resetRow(all)), resetRow(all).replace(/\s+/g, " ").slice(0, 200));
}

console.log("\n   The home gauge and the cash tile (the shipped statements, run)");
{
  const g = code;
  const a = g.indexOf("const _weekReversedIds = reversedCashIds();");
  const b = g.indexOf("const openReferrals", a);
  const c = g.indexOf("const positives = cashThisWeek");
  const d = g.indexOf("const RATIO_TARGET = CASH_RATIO_GOAL;", c);
  check("the gauge's statements were found", a > 0 && b > a && c > b && d > c);
  const run = (src) => {
    const s = strip(src);
    const A = s.slice(s.indexOf("const _weekReversedIds = reversedCashIds();"), s.indexOf("const openReferrals", s.indexOf("const _weekReversedIds")));
    const C = s.slice(s.indexOf("const positives = cashThisWeek"), s.indexOf("const RATIO_TARGET = CASH_RATIO_GOAL;", s.indexOf("const positives = cashThisWeek")));
    const { app } = world(src);
    return new Function("cashThisWeek", "reversedCashIds", "cashBehaviourKind",
      A + C + "return { cashAwarded, positives, negatives };")(ledger(), () => new Set(["r0"]), app.cashBehaviourKind);
  };
  const r = run(scriptSrc);
  check("a purchase is not 'Corrective' and a withdrawn deduction is not 'Positive'",
    r.positives === 3 && r.negatives === 1, JSON.stringify(r));
  check("'Cash awarded this week' is awards, not refunds", r.cashAwarded === 225, String(r.cashAwarded));
  check("the gauge still targets 5", /const RATIO_TARGET = CASH_RATIO_GOAL;/.test(code) && /const CASH_RATIO_GOAL = 5;/.test(code));
  globalThis.__gaugeRun = run;

  // THE GAUGE FOLLOWS THE SHARED 5 TO 1 RULE (2026-10-01): a teacher's own
  // week of awards with no deductions, or with one to four, fills nothing.
  const fill = (src, positives, negatives) => {
    const s = strip(src);
    const from = s.indexOf("const RATIO_TARGET = CASH_RATIO_GOAL;");
    const to = s.indexOf("wcSetGauge(gauge", from);
    const verdictFn = liftFn(src, "cashRatioVerdict");
    return new Function("positives", "negatives",
      "const CASH_RATIO_GOAL = 5, CASH_RATIO_MIN_DEDUCTIONS = 5;\n" + verdictFn + "\n" + s.slice(from, to) +
      "return { rate, ratioShown, nothingYet };")(positives, negatives);
  };
  const g0 = fill(scriptSrc, 3, 0), g4 = fill(scriptSrc, 12, 4), g5 = fill(scriptSrc, 12, 5), g6 = fill(scriptSrc, 30, 5);
  check("the gauge: awards and no deductions fill nothing (never a perfect score)", g0.rate === null && g0.ratioShown === "", JSON.stringify(g0));
  check("the gauge: one to four deductions fill nothing (too few to judge)", g4.rate === null, JSON.stringify(g4));
  check("the gauge: five deductions give a ratio, rounded down", g5.rate !== null && Math.abs(g5.rate - 0.48) < 1e-9 && g5.ratioShown === "2.4", JSON.stringify(g5));
  check("the gauge: at or above 5 to 1 it is full", g6.rate === 1 && g6.ratioShown === "6.0", JSON.stringify(g6));
  const oldFill = scriptSrc.replace("const rate = verdict.ratio === null ? null : Math.min(1, verdict.ratio / RATIO_TARGET);",
    "const rate = nothingYet ? null : Math.min(1, (negatives === 0 ? RATIO_TARGET : positives / negatives) / RATIO_TARGET);");
  check("TEETH: the old gauge filled completely for awards with no deductions", oldFill !== scriptSrc && fill(oldFill, 3, 0).rate === 1);
}

console.log("\n   'Not being noticed'");
{
  const kids = [kid("buyer", "9"), kid("seen", "9")];
  const rows = [
    { id: "b", kind: "redeem", amount: -1500, teacherId: "", studentId: "buyer", timestamp: new Date().toISOString() },
    { id: "s", kind: "award", amount: 100, teacherId: "t1", studentId: "seen", timestamp: new Date().toISOString() },
  ];
  const w = world(scriptSrc, { students: kids, cashTransactions: rows });
  w.app.wcRenderQuietStudents(true);
  const list = el(w, "dashQuietList").innerHTML;
  const buyer = list.split("wc-quiet-row").find((r) => /BUYER/.test(r)) || "";
  check("a child whose only movement is a purchase has never been awarded", /never awarded/.test(buyer), buyer.slice(0, 160));
  // Five awards and one deduction is 5 to 1 and below the school's average,
  // so the child is on the list. The note read "6 awards" -- the deduction
  // counted as an award, the mistake Today's goal made.
  const note = quietNote(scriptSrc);
  check("a quiet child's note counts awards as awards, and the deduction as a deduction",
    /5 awards &middot; 1 deduction/.test(note) && !/6 award/.test(note), note.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}

// ==================================================================== 2
console.log("\n2. Admins and PBIS only, by role");
{
  const { app } = world();
  check("admin, superadmin and pbis may see colleagues",
    [ADMIN, SUPER, PBIS].every((u) => app.cashStaffViewsAllowed(u) === true));
  check("a teacher may not", app.cashStaffViewsAllowed(PARK) === false);
  check("a campus aide may not, even holding the attendance grant", app.cashStaffViewsAllowed(AIDE) === false);
  check("nor an unknown role, nor nobody",
    app.cashStaffViewsAllowed({ id: "x", role: "counselor" }) === false && app.cashStaffViewsAllowed(null) === false);
  check("the role is read directly, not through canReadInsights or the grant",
    !/canReadInsights|attendanceWatch/.test(liftFn(code, "cashStaffViewsAllowed")));
}
/**
 * Every Teacher Interactions renderer called directly, as `who`, with the DOM
 * read after EACH call. Read once at the end, a leak from one renderer was
 * wiped by the next one's guard before anything looked (found in review: the
 * intervention table's guard could be deleted and the test still passed).
 */
const STAFF_NAMES = /Ms\. Lee|Mr\. Park|Dr\. Admin/;
function directCallLeaks(w) {
  const leaks = [];
  [["updateTeacherInteractions", () => w.app.updateTeacherInteractions()],
   ["updateTeacherActivityTable", () => w.app.updateTeacherActivityTable({ t1: { name: "Ms. Lee", totalInteractions: 3,
     positiveCount: 2, negativeCount: 1, totalAwarded: 0, totalDeducted: 0, studentsImpacted: new Set() } })],
   ["updateInterventionStudents", () => w.app.updateInterventionStudents()],
   ["updateTeacherInteractionDetails", () => w.app.updateTeacherInteractionDetails()],
   ["populateTeacherFilterDropdown", () => w.app.populateTeacherFilterDropdown()],
  ].forEach(([name, call]) => {
    call();
    const m = w.dom.text().match(STAFF_NAMES);
    if (m) leaks.push(name + " showed " + m[0]);
  });
  return leaks;
}
for (const who of [PARK, AIDE]) {
  const w = world(scriptSrc, { currentUser: who });
  w.app.switchAnalyticsSubtab("dashboard");
  check(`${who.role}: the Teacher Interactions button is hidden`, el(w, "teacherInteractionsSubtab").style.display === "none");
  w.app.switchAnalyticsSubtab("teacherInteractions");
  check(`${who.role}: asking for it lands on the Data Dashboard`,
    el(w, "analyticsDashboard").style.display === "block" && el(w, "analyticsTeacherInteractions").style.display === "none");
  const leaks = directCallLeaks(w);
  check(`${who.role}: a direct call to each renderer, checked after each, shows no colleague`, !leaks.length, leaks.join("; "));
  check(`${who.role}: and the summary cards are left empty, not filled with staff totals`,
    ["teacherInteractionsActiveCount", "teacherInteractionsTotalPositive", "teacherInteractionsTotalNegative"]
      .every((id) => el(w, id).textContent === "—"));
  check(`${who.role}: the Data Dashboard still works`, el(w, "dashTotalPositive").textContent === 3);
}
{
  const w = world(scriptSrc, { currentUser: PBIS });
  w.app.switchAnalyticsSubtab("teacherInteractions");
  check("pbis: the button shows and the pane opens",
    el(w, "teacherInteractionsSubtab").style.display === "" && el(w, "analyticsTeacherInteractions").style.display === "block");
  const t = el(w, "teacherActivityTableBody").innerHTML;
  check("pbis: colleagues are listed", /Mr\. Park/.test(t));
  check("the staff name is escaped", /&lt;b&gt;Ms\. Lee&lt;\/b&gt;/.test(t) && !/<b>Ms\. Lee<\/b>/.test(t));
  const dd = el(w, "teacherInteractionFilterTeacher").innerHTML;
  check("and in the teacher dropdown", /&lt;b&gt;Ms\. Lee/.test(dd) && !/<b>Ms\. Lee<\/b>/.test(dd), dd);
  const flagged = el(w, "interventionStudentsTableBody").innerHTML;
  check("and beside a flagged child, under Primary Teachers", /&lt;b&gt;Ms\. Lee/.test(flagged) && !/<b>Ms\. Lee<\/b>/.test(flagged));

  // THE SHARED CHROMEBOOK. The PBIS lead signs out, a teacher signs in, and
  // nobody reloads the page: whatever the pane held must go.
  w.app.set("currentUser", PARK);
  w.app.applyCashAnalyticsGate();
  check("a role change mid-session empties what the last person left",
    !/Ms\. Lee|Mr\. Park/.test(w.dom.text()) && el(w, "teacherInteractionsSubtab").style.display === "none");
}
// EACH LAYER ON ITS OWN. updateTeacherInteractions asks the gate itself and
// so does every renderer it calls; either layer alone must be enough, or a
// regression in one is masked by the other and nothing notices.
const INNER_GUARD = "            if (!cashStaffViewsAllowed()) { wipeStaffCashViews(); return; }\n";
const innerGuardsOff = (src) => breakAll(src, INNER_GUARD, "", 4, "inner guards");
{
  const w = world(innerGuardsOff(scriptSrc), { currentUser: PARK });
  w.app.updateTeacherInteractions();
  check("with every renderer's own guard gone, the tab's guard alone still shows a teacher nobody",
    !STAFF_NAMES.test(w.dom.text()), (w.dom.text().match(STAFF_NAMES) || [])[0]);
}

/** Flagged children and their Primary Teachers, for PBIS, where Mr. Park only SOLD s11 a pass. */
function primaryTeachers(src) {
  const kids = KIDS().map((k) => k.id !== "s11" ? k : { ...k, wildcatCashTransactions: k.wildcatCashTransactions.concat(
    [{ id: "sale", kind: "redeem", amount: -1500, teacherId: "t2", behaviorId: "reward:pup", behaviorName: "Power-Up Pass" }]) });
  const w = world(src, { currentUser: PBIS, students: kids });
  w.app.updateInterventionStudents();
  return el(w, "interventionStudentsTableBody").innerHTML;
}
{
  const t = primaryTeachers(scriptSrc);
  check("Primary Teachers names who gave the behaviour, not who rang up a sale",
    /Ms\. Lee/.test(t) && !/Mr\. Park/.test(t), t.replace(/\s+/g, " ").slice(0, 300));
}

console.log("\n   The home dashboard's activity feed");
/**
 * The shipped feed statements from renderTeacherDashboard, with the shipped
 * classifier (FEED_CATS through wcFeedCat), run for one person and one log.
 */
function feedRun(src, user, log) {
  const cats = src.slice(src.indexOf("        const FEED_CATS = {"),
    src.indexOf("\n        }\n", src.indexOf("        function wcFeedCat(entry) {")) + 10);
  const a = src.indexOf("            const feed = document.getElementById('dashFeed');");
  const b = src.indexOf("                    : (function () {", a);
  if (a < 0 || b < 0 || !cats) throw new Error("feed block not found");
  const block = src.slice(a, b) + "                    : '';\n            }\n";
  const dom = makeDom();
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return new Function("document", "window", "auditLog", "currentUser", "students", "selected", "todayIso", `
    let wcFeedFilter = 'all';
    ${["escapeHtml", "wcIsoDay", "wcWhen"].map((n) => liftFn(src, n)).join("\n")}
    ${liftConst(src, "CASH_STAFF_VIEW_ROLES")}
    ${["cashStaffViewsAllowed", "cashAuditEntriesFor", "dashFeedEntriesFor"].map((n) => liftFn(src, n)).join("\n")}
    ${cats}
    ${block}
    return { feed: document.getElementById('dashFeed').innerHTML,
             chips: document.getElementById('dashFeedFilters').innerHTML };`)(dom, MODS, log, user, [], iso, iso);
}
const FEED_LOG = () => {
  const at = new Date().toISOString();
  return [
    { entryId: "f1", action: "cash_deduct", teacher: "Ms. Lee", teacherId: "t1", studentId: "s9", studentName: "Kid S9",
      reason: "Not Responsible, talked back", ticketCount: 50, timestamp: at },
    { entryId: "f2", action: "cash_award", teacher: "Mr. Park", teacherId: "t2", studentId: "s6", studentName: "Kid S6",
      reason: "Be Present", ticketCount: 100, timestamp: at },
    // Not cash: the owner's decision is about cash, so this is left as it was.
    { entryId: "f3", action: "Awarded Tickets", teacher: "Ms. Lee", teacherId: "t1", studentId: "s6", studentName: "Kid S6",
      reason: "Raffle entry", ticketCount: 1, timestamp: at },
  ];
};
{
  const park = feedRun(scriptSrc, PARK, FEED_LOG());
  check("a teacher's home feed does not show a colleague's cash, by name or by note",
    !/talked back/.test(park.feed), park.feed.replace(/\s+/g, " ").slice(0, 300));
  check("...nor offer a 'Cash Deducted' chip built from it", !/Cash Deducted/.test(park.chips));
  check("their own cash is still there", /Be Present/.test(park.feed));
  check("and what is not cash is left as it was", /Raffle entry/.test(park.feed));
  check("a campus aide with the attendance grant is scoped the same way", !/talked back|Be Present/.test(feedRun(scriptSrc, AIDE, FEED_LOG()).feed));
  check("admins, superadmins and PBIS still see the school's feed",
    [ADMIN, SUPER, PBIS].every((u) => /talked back/.test(feedRun(scriptSrc, u, FEED_LOG()).feed)));
  check("the feed uses the audit log's own rule, not a second one",
    /return list\.filter\(e => !CA\.isCashEntry\(e\) \|\| mine\.has\(e\)\);/.test(liftFn(code, "dashFeedEntriesFor")) &&
    /const mine = new Set\(cashAuditEntriesFor\(list, user\)\);/.test(liftFn(code, "dashFeedEntriesFor")));
}

console.log("\n   The inactivity logout on a shared Chromebook");
/**
 * resetInactivityTimer and logout, lifted, with the admin's Teacher
 * Interactions table still on the page. `answer` is what the next person
 * presses if asked "Are you sure?".
 */
function inactivityWorld(src, answer) {
  const dom = makeDom();
  dom.body = makeEl("body");
  const G = { dom, answer, timers: [], confirms: 0 };
  const app = new Function("G", `
    let currentUser = ${JSON.stringify(ADMIN)}, currentStudent = null, inactivityTimer = null, _sidebarModeApplied = true;
    const INACTIVITY_TIMEOUT = 30 * 60 * 1000;
    const document = G.dom;
    const window = {};
    const sessionStorage = { setItem() {}, removeItem() {} };
    const setTimeout = (f) => G.timers.push(f);
    const clearTimeout = () => {};
    const alert = () => {};
    const showConfirm = async () => { G.confirms++; return G.answer; };
    function wcForgetTab() {}
    function clearSession() {}
    function showStudentLogin() {}
    ${liftConst(src, "CASH_STAFF_VIEW_ROLES")}
    ${["cashStaffViewsAllowed", "wipeStaffCashViews", "applyCashAnalyticsGate", "resetInactivityTimer", "logout"]
      .map((n) => liftFn(src, n)).join("\n")}
    return { resetInactivityTimer, logout, who: () => currentUser };`)(G);
  dom.getElementById("teacherActivityTableBody").innerHTML = "<tr><td>Mr. Park</td></tr>";
  dom.getElementById("loginScreen").classList.add("hidden");
  return { app, dom, G };
}
/** Thirty minutes pass; whoever sits down next presses `answer` if asked. */
async function idleOut(src, answer) {
  const r = inactivityWorld(src, answer);
  r.app.resetInactivityTimer();
  r.G.timers.splice(0).forEach((f) => f());
  await new Promise((done) => setImmediate(done));
  return r;
}
{
  const r = await idleOut(scriptSrc, false);
  check("the inactivity logout does not ask, so the next person cannot Cancel it",
    r.app.who() === null && r.G.confirms === 0, JSON.stringify({ who: r.app.who(), confirms: r.G.confirms }));
  check("...and the admin's colleagues leave the page with them",
    !/Mr\. Park/.test(r.dom.text()) && !el(r, "loginScreen").classList.contains("hidden"));
  const m = inactivityWorld(scriptSrc, false);
  await m.app.logout();
  check("the Logout button still asks, and Cancel still cancels", m.app.who() !== null && m.G.confirms === 1);
}

{
  // Who calls the gate, so a role change is picked up without a reload.
  const logout = liftFn(code, "logout");
  check("logout applies the gate and clears the audit table",
    /applyCashAnalyticsGate\(\)/.test(logout) && /cashAuditLogTable/.test(logout));
  check("so does signing in", /applyCashAnalyticsGate\(\);/.test(liftFn(code, "establishTeacherSessionCore")));
  check("and teacher view, both ways", /applyCashAnalyticsGate\(\);/.test(liftFn(code, "applyPreviewVisibility")));
  const restore = code.slice(code.indexOf("const seesAdminTabs ="), code.indexOf("const seesAdminTabs =") + 900);
  check("and a restored session", /applyCashAnalyticsGate\(\);/.test(restore));
  check("the subtab button starts hidden in the markup, so it never flashes",
    /id="teacherInteractionsSubtab" style="display: none;/.test(html));
}

console.log("\n   The Cash Audit Log");
{
  const log = [
    { entryId: "1", action: "cash_award", teacher: "Ms. Lee", teacherId: "t1", studentId: "s6", studentName: "Kid S6", ticketCount: 100, timestamp: "2026-09-30T10:00:00Z" },
    { entryId: "2", action: "cash_deduct", teacher: "Mr. Park", teacherId: "t2", studentId: "s9", studentName: "Kid S9", ticketCount: 50, timestamp: "2026-09-30T11:00:00Z" },
    { entryId: "3", action: "reward_redemption", teacher: "Office", studentId: "s9", studentName: "Kid S9", ticketCount: 1500, timestamp: "2026-09-30T12:00:00Z" },
    { entryId: "4", action: "Awarded Tickets", teacher: "Mr. Park", teacherId: "t2", studentId: "s9", ticketCount: 1, timestamp: "2026-09-30T13:00:00Z" },
  ];
  const { app } = world(scriptSrc, { auditLog: log });
  check("a teacher sees only their own entries", app.cashAuditEntriesFor(log, PARK).map((e) => e.entryId).join() === "2");
  check("an entry with no id on it belongs to nobody", !app.cashAuditEntriesFor(log, { id: "", role: "teacher" }).length);
  check("an admin, superadmin and PBIS see every cash entry",
    [ADMIN, SUPER, PBIS].every((u) => app.cashAuditEntriesFor(log, u).map((e) => e.entryId).join() === "1,2,3"));
  check("a campus aide with the attendance grant does not", app.cashAuditEntriesFor(log, AIDE).length === 0);

  const w = world(scriptSrc, { auditLog: log, currentUser: PARK });
  el(w, "searchCashAudit").value = "lee";
  w.app.updateCashAuditLogTable();
  check("a teacher cannot search a colleague into view", /No cash activity matches/.test(el(w, "cashAuditLogTable").innerHTML) &&
    !/Ms\. Lee/.test(el(w, "cashAuditLogTable").innerHTML));
  el(w, "searchCashAudit").value = "";
  w.app.updateCashAuditLogTable();
  check("their own row is still there", /Mr\. Park/.test(el(w, "cashAuditLogTable").innerHTML));
  check("and the screen says whose rows these are", /Admins and the PBIS team see everyone/.test(el(w, "cashAuditScopeNote").textContent) &&
    el(w, "cashAuditScopeNote").style.display === "");
  w.app.set("currentUser", PBIS);
  w.app.updateCashAuditLogTable();
  check("PBIS sees the whole log, and the movements list is unchanged for them",
    /Ms\. Lee/.test(el(w, "cashAuditLogTable").innerHTML) && /Office/.test(el(w, "cashAuditLogTable").innerHTML) &&
    el(w, "cashAuditScopeNote").style.display === "none");
}

console.log("\n   The gauge's shortcut");
{
  const btn = (html.match(/<button[^>]*id="dashGaugeAnalyticsBtn"[^>]*>/) || [""])[0];
  check("it is no longer .admin-only", btn && !/admin-only/.test(btn));
  check("it starts hidden", /style="display: none;"/.test(btn));
  check("and the dashboard shows it through the same role rule",
    /gaugeLink\.style\.display = cashStaffViewsAllowed\(\) \? '' : 'none'/.test(code));
}

// ==================================================================== 3
console.log("\n3. One goal: 5 to 1");
{
  const { app } = world();
  const v = app.cashRatioVerdict;
  check("no deductions is said as such, never a perfect score",
    v(12, 0).label === "no deductions" && v(12, 0).tone === "neutral" && v(12, 0).ratio === null);
  check("under five deductions there is no ratio", v(15, 3).label === "too few deductions to judge" && v(15, 3).tone === "neutral");
  check("3 to 1 is below the goal -- the old table called 75% green", v(15, 5).label === "3.0 to 1" && v(15, 5).tone === "below");
  check("exactly 5 to 1 meets it", v(25, 5).label === "5.0 to 1" && v(25, 5).tone === "meets");
  check("4.99 to 1 reads 4.9, below -- never 5.0 in amber", v(499, 100).label === "4.9 to 1" && v(499, 100).tone === "below");
  check("there is no red tone at all", ![[0, 9], [1, 50], [100, 5]].some(([a, d]) => !["meets", "below", "neutral"].includes(v(a, d).tone)));

  const w = world();
  w.app.updateTeacherActivityTable({
    x: { name: "Three To One", totalInteractions: 20, positiveCount: 15, negativeCount: 5, totalAwarded: 0, totalDeducted: 0, studentsImpacted: new Set() },
    y: { name: "Six To One", totalInteractions: 35, positiveCount: 30, negativeCount: 5, totalAwarded: 0, totalDeducted: 0, studentsImpacted: new Set() },
  });
  const t = el(w, "teacherActivityTableBody").innerHTML;
  const row = (n) => t.split("<tr>").find((r) => r.includes(n)) || "";
  check("the 3 to 1 teacher is amber 'below the goal', not green", /is-below/.test(row("Three To One")) &&
    /below the 5 to 1 goal/.test(row("Three To One")) && !/#2E7D52/.test(row("Three To One")));
  check("the 6 to 1 teacher meets it", /is-meets/.test(row("Six To One")) && /6\.0 to 1/.test(row("Six To One")));
  check("no percentage is left in the table", !/%/.test(t));
  check("below is amber in the stylesheet, never red",
    /\.wc-ratio\.is-below \{[^}]*--wc-amber-deep/.test(css) && !/\.wc-ratio\.is-below \{[^}]*#B3392F/.test(css));
  check("the Teacher table's header names the goal", /Awards to Deductions \(goal: 5 to 1\)/.test(html) && !/Positivity %/.test(html));
  check("the Data Dashboard tile is 'Awards to Deductions' with a note under it",
    /Awards to Deductions<\/div>\s*<div class="stat-num" id="avgPositivityRatio">/.test(html) && /id="avgPositivityRatioNote"/.test(html));

  const many = ledger().concat(Array.from({ length: 4 }, (_, i) =>
    ({ id: "dd" + i, kind: "deduct", amount: -10, teacherId: "t1", studentId: "s6", timestamp: new Date().toISOString() })));
  const w2 = world(scriptSrc, { cashTransactions: many });
  w2.app.updateDashboard();
  check("the tile reads 'N to 1' with the goal beside it, once there are five deductions",
    el(w2, "avgPositivityRatio").textContent === "0.6 to 1" && /below the 5 to 1 goal/.test(el(w2, "avgPositivityRatioNote").textContent),
    el(w2, "avgPositivityRatio").textContent + " / " + el(w2, "avgPositivityRatioNote").textContent);

  // Nothing selected is not "no deductions": that would be a claim about a
  // school with hundreds of them.
  const none = noGradesTile(scriptSrc, []);
  check("with no grades ticked the tile says so, not 'no deductions'",
    none.value === "—" && none.note === "no grades selected", JSON.stringify(none));
  const empty = noGradesTile(scriptSrc, ["5"]);
  check("...and with no students in the grades ticked, says that",
    empty.value === "—" && empty.note === "no students in these grades", JSON.stringify(empty));

  // THE HOME GAUGE FOLLOWS THE SHARED RULE (2026-10-01): it rounds down the
  // way cashRatioVerdict does, so it cannot say 5.0 where Trends says 4.9, and
  // an all-award week or one with one to four deductions fills nothing.
  const g = (p, n) => gaugeDisplay(scriptSrc, p, n);
  check("the gauge reads 4.99 to 1 as 4.9, as Trends does", /^4\.9</.test(g(499, 100).html), g(499, 100).html);
  check("...in whole numbers, so 29 to 10 is 2.9 and not 2.8", /^2\.9</.test(g(29, 10).html) && /2\.9 to 1/.test(g(29, 10).label));
  check("5 to 1 is 5.0 and full", /^5\.0</.test(g(25, 5).html) && g(25, 5).rate === 1);
  check("an all-award week reads 'no deductions' and fills nothing (never a perfect score)",
    /no deductions/.test(g(12, 0).html) && g(12, 0).rate === null, JSON.stringify(g(12, 0)));
  check("one to four deductions read 'too few deductions to judge' and fill nothing",
    /too few deductions to judge/.test(g(12, 4).html) && g(12, 4).rate === null, JSON.stringify(g(12, 4)));
  check("nothing awarded yet still says so", /no awards yet/.test(g(0, 0).html) && g(0, 0).rate === null);
}

/** The ratio tile with only `grades` ticked. */
function noGradesTile(src, grades) {
  const w = world(src, { grades });
  w.app.updateDashboard();
  return { value: el(w, "avgPositivityRatio").textContent, note: el(w, "avgPositivityRatioNote").textContent };
}
/** The gauge's shipped display statements, from RATIO_TARGET to the sub-rings, for one week's counts. */
function gaugeDisplay(src, positives, negatives) {
  const a = src.indexOf("            const RATIO_TARGET = CASH_RATIO_GOAL;");
  const b = src.indexOf("            if (legs) {", a);
  if (a < 0 || b < 0) throw new Error("gauge display not found");
  const out = { html: "" };
  const gaugeVal = { set innerHTML(v) { out.html = v; } };
  // The shared rule and the escaper, lifted from the same source, so a broken
  // copy of either is what the gauge runs.
  const helpers = "const CASH_RATIO_GOAL = 5, CASH_RATIO_MIN_DEDUCTIONS = 5;\n" +
    liftFn(src, "cashRatioVerdict") + "\n" + liftFn(src, "escapeHtml") + "\n";
  new Function("positives", "negatives", "gauge", "gaugeVal", "wcSetGauge", helpers + src.slice(a, b))(
    positives, negatives, {}, gaugeVal, (g, rate, label) => { out.rate = rate; out.label = label; });
  return out;
}

// ==================================================================== 4
const DAY = 86400000;
// A THURSDAY, fixed: the goal now has nothing to say at the weekend, so a
// suite that read the real clock would change its answer on a Saturday.
const GOAL_NOW = new Date(2026, 9, 1, 10, 0).getTime();
const SATURDAY = new Date(2026, 9, 3, 10, 0).getTime();
function goalWorld(src, opts = {}) {
  const nowMs = opts.now || GOAL_NOW;
  const D = dateAt(nowMs);
  // History started nine days ago; the window would reach thirty.
  const cutoff = new D(); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() - 9);
  const then = new Date(cutoff.getTime() + DAY + 12 * 3600000).toISOString();   // inside, not today
  const now = new Date(nowMs).toISOString();
  const T = (id) => ({ id, name: id, role: "teacher" });
  const staff = [T("t1"), T("t2"), T("t3"), T("t4"), T("vacant"),
                 { id: "a1", role: "admin" }, { id: "c1", role: "campusaide" }, { id: "p1", role: "pbis" }];
  const rows = [];
  const add = (who, n, kind, at) => { for (let i = 0; i < n; i++) rows.push({ id: `${who}-${kind}-${at}-${i}`, kind,
    amount: kind === "award" ? 100 : -100, teacherId: who, studentId: "s" + (i % 7), timestamp: at }); };
  const counts = opts.counts || { t1: 40, t2: 60, t3: 80 };
  for (const [who, n] of Object.entries(counts)) add(who, n, "award", then);
  add("t1", 50, "deduct", then);           // a teacher who corrects a lot
  add("t1", 2, "award", now);              // two awards today
  add("t1", 3, "deduct", now);             // and three corrections today
  add("a1", 100, "award", then);           // an admin who is not the yardstick
  add("c1", 30, "award", then);
  add("p1", 20, "award", then);
  rows.push({ id: "buy", kind: "redeem", amount: -1500, teacherId: "t1", studentId: "s1", timestamp: now });
  const w = world(src, { currentUser: staff[0], teachers: staff, cashTransactions: rows, cutoffMs: cutoff.getTime(),
    students: Array.from({ length: 7 }, (_, i) => kid("s" + i, "9")), Date: D });
  w.app.wcRenderQuietStudents(false);
  // The school days from the cutoff to today, both included, counted here
  // independently of the app: Monday to Friday on the local calendar.
  let days = 0;
  const end = new Date(nowMs); end.setHours(12, 0, 0, 0);
  for (const d = new Date(cutoff.getTime()); d.setHours(12, 0, 0, 0) && d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) days++;
  }
  return { w, days };
}
console.log("\n4. Today's goal: awards, per school day, against teachers who award");
{
  const { w, days } = goalWorld(scriptSrc);
  // t1 has 42 awards in the window (40 + 2 today); t2 60; t3 80. Median 60.
  const want = Math.max(1, Math.ceil(60 / days));
  const chip = el(w, "dashGoalChip").textContent;
  check(`the goal is the median teacher's awards per school day (60 over ${days} days = ${want})`,
    chip === `2 / ${want}`, chip);
  check("today counts awards only: two awards and three corrections is 2", chip.startsWith("2 /"));
  check("the window is said in school days", new RegExp(`<b>42</b> awards in ${days} school days`).test(el(w, "dashGoalBody").innerHTML),
    el(w, "dashGoalBody").innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  check("the typical colleague is a teacher who awards", /typical colleague <b>60<\/b>/.test(el(w, "dashGoalBody").innerHTML));
  check("drawn for a teacher with no classes too, so the last person's goal is never left showing",
    el(w, "dashGoalPanel").hidden === false && el(w, "dashQuietPanel").hidden === true);

  const { app } = world();
  check("only teacher accounts with an award are comparable",
    app.cashGoalStaffCounts([{ id: "t", role: "teacher" }, { id: "z", role: "teacher" }, { id: "a", role: "admin" },
                              { id: "c", role: "campusaide" }, { id: "p", role: "pbis" }, { id: "s", role: "superadmin" }],
      { t: 4, z: 0, a: 9, c: 9, p: 9, s: 9 }).join() === "4");

  const few = goalWorld(scriptSrc, { counts: { t2: 60, t3: 80 } }).w;   // t1 still has 2 today -> 3 teachers award
  const fewer = goalWorld(scriptSrc, { counts: { t2: 60 } }).w;          // t1 and t2: two teachers
  check("three teachers awarding is enough for a goal", /\d+ \/ \d+/.test(el(few, "dashGoalChip").textContent));
  check("two is not: it says so instead of showing a goal",
    /Not enough teachers are awarding yet/.test(el(fewer, "dashGoalSub").textContent) &&
    !/wc-goal-track/.test(el(fewer, "dashGoalBody").innerHTML), el(fewer, "dashGoalSub").textContent);
  check("the day is the school's: the attendance screens' wcIsoDay and weekday count",
    /R\.schoolDaysElapsed\(wcIsoDay\(new Date\(windowStart\)\), wcIsoDay\(new Date\(\)\)\)/.test(code));

  const sat = goalWorld(scriptSrc, { now: SATURDAY }).w;
  check("on a Saturday there is no goal to chase: 'No school today', and no bar",
    el(sat, "dashGoalChip").textContent === "No school today" && !/wc-goal-track/.test(el(sat, "dashGoalBody").innerHTML) &&
    /awards? in \d+ school days?/.test(el(sat, "dashGoalBody").innerHTML), el(sat, "dashGoalChip").textContent);
}

// ==================================================================== 5
const at = (y, m, d, h = 10, min = 0) => new Date(y, m - 1, d, h, min).toISOString();   // local, i.e. the school's day
const TREND_STAFF = [{ id: "T1", role: "teacher", name: "Ms. Lee" }, { id: "T2", role: "teacher", name: "Mr. Park" },
                     { id: "T3", role: "teacher", name: "Mx. Quinn" }, { id: "V1", role: "teacher", name: "Vacancy" },
                     { id: "P1", role: "pbis", name: "Pat PBIS" }, { id: "A1", role: "admin", name: "Dr. Admin" }];
const TREND_KIDS = ["6", "7", "8", "9", "10", "11", "12"].map((g) => kid("s" + g, g, { firstName: "Student" + g }));
function trendRows() {
  const r = [];
  const aw = (id, who, sid, t) => r.push({ id, kind: "award", amount: 100, teacherId: who, studentId: sid, timestamp: t });
  // Launch week, Sep 14-18.
  aw("w1a", "T1", "s6", at(2026, 9, 15));
  aw("w1b", "T1", "s9", at(2026, 9, 16));
  aw("w1c", "P1", "s10", at(2026, 9, 17));
  aw("w1d", "T2", "sx", at(2026, 9, 17));                     // a student no longer enrolled
  aw("w1e", "T2", "s7", at(2026, 9, 20, 20, 0));              // SUNDAY evening: still this week, though UTC says Monday
  for (let i = 0; i < 5; i++) r.push({ id: "w1d" + i, kind: "deduct", amount: -50, teacherId: "T1", studentId: "s9", timestamp: at(2026, 9, 18) });
  r.push({ id: "w1p", kind: "redeem", amount: -1500, teacherId: "", studentId: "s9", timestamp: at(2026, 9, 16) });
  // Before the cutoff, and after today.
  aw("pre", "T1", "s8", at(2026, 9, 10));
  aw("fut", "T1", "s8", at(2026, 10, 2));
  // This week, so far.
  aw("w3a", "T3", "s6", at(2026, 10, 1, 9));
  aw("w3r", "T3", "s12", at(2026, 9, 29));
  r.push({ id: "w3rv", kind: "reversal", amount: -100, teacherId: "A1", studentId: "s12", reversesTxnId: "w3r", timestamp: at(2026, 9, 29, 11) });
  r.push({ id: "w3d", kind: "deduct", amount: -50, teacherId: "T3", studentId: "s11", timestamp: at(2026, 9, 30) });
  return r;
}
function trendModel(src = scriptSrc, over = {}) {
  const { app } = world(src);
  const rows = trendRows();
  return app.cashTrendWeeks({
    rows, reversedIds: new Set(rows.filter((t) => t.reversesTxnId).map((t) => t.reversesTxnId)),
    staff: TREND_STAFF, students: TREND_KIDS, campusOf: MODS.WildcatStore.studentCampusOf,
    cutoffIso: "2026-09-14", todayIso: "2026-10-01", ...over,
  });
}
console.log("\n5. Trends: the school, week by week");
{
  const m = trendModel();
  const [w1, w2, w3] = m.weeks;
  check("three weeks since the cutoff, the empty one included", m.weeks.length === 3 && w2 && w2.awards === 0,
    m.weeks.map((w) => w.monday).join());
  check("the first is the launch week", w1.launch === true && w1.label === "Sep 14–18" && !w2.launch && !w3.launch);
  check("the current week is 'so far'", w3.soFar === true && !w1.soFar && w3.label === "Sep 28 – Oct 2");
  const sat = trendModel(scriptSrc, { todayIso: "2026-10-03" }).weeks;
  const sun = trendModel(scriptSrc, { todayIso: "2026-10-04" }).weeks;
  const mon = trendModel(scriptSrc, { todayIso: "2026-10-05" }).weeks;
  check("on Saturday and Sunday the week just finished is not 'so far'",
    sat[sat.length - 1].label === "Sep 28 – Oct 2" && !sat.some((w) => w.soFar) && !sun.some((w) => w.soFar));
  check("...and on Monday the new week is", mon[mon.length - 1].label === "Oct 5–9" && mon[mon.length - 1].soFar === true);
  const later = trendModel(scriptSrc, { cutoffIso: "2026-09-21" }).weeks;
  check("a history that starts in another week has no launch week", later[0].monday === "2026-09-21" && !later.some((w) => w.launch),
    later.map((w) => w.monday + (w.launch ? "*" : "")).join());
  check("awards and deductions are real behaviour only (no purchase, no reversed award)",
    w1.awards === 5 && w1.deductions === 5 && w3.awards === 1 && w3.deductions === 1, `${w1.awards}/${w1.deductions} ${w3.awards}/${w3.deductions}`);
  check("an award on Sunday evening is that week's, by the school's calendar day", w1.awards === 5 && w2.awards === 0);
  check("nothing before the cutoff and nothing from the future", m.weeks.every((w) => w.monday >= "2026-09-14") && w3.awards === 1);
  check("staff who awarded, split teachers / other staff", w1.teachersAwarding === 2 && w1.otherStaffAwarding === 1);
  check("teacher accounts counted, vacancy included", m.teacherAccounts === 4);
  check("the ratio has the five-deduction minimum",
    w1.verdict.label === "1.0 to 1" && w1.verdict.tone === "below" && w3.verdict.label === "too few deductions to judge" &&
    w2.verdict.label === "no deductions");
  check("students awarded, by grade, out of those enrolled now",
    w1.studentsAwarded.byGrade["6"] === 1 && w1.studentsAwarded.byGrade["7"] === 1 &&
    w1.studentsAwarded.byGrade["9"] === 1 && w1.studentsAwarded.byGrade["10"] === 1 && w1.studentsAwarded.total === 4);
  check("Middle School (6-8) and High School (9-12) by the app's own campus rule",
    w1.studentsAwarded.middle === 2 && w1.studentsAwarded.high === 2 && m.enrolled.middle === 3 && m.enrolled.high === 4);

  const { app } = world();
  const out = app.cashTrendsHtml(m);
  check("the table shows 'launch week' and 'so far'", /launch week/.test(out) && /so far/.test(out));
  check("'of N teacher accounts' comes with the vacancy caveat on screen",
    /of 4 teacher accounts/.test(out) && /vacancies or staff without a classroom/.test(out));
  check("Middle School and High School sit side by side",
    /<th scope="col">Middle School<\/th><th scope="col">High School<\/th>/.test(out));
  check("by grade, with the shares", /Grade 6/.test(out) && /Grade 12/.test(out) && /<b>33%<\/b><span class="wc-trend-of">1 of 3<\/span>/.test(out));
  check("nobody is named: no adult, no student", !/Ms\. Lee|Mr\. Park|Quinn|Vacancy|Pat PBIS|Dr\. Admin|Student\d|Kid/.test(out));
  check("both tables scroll inside their card, never the page",
    (out.match(/<div class="wu-scroll-x"><table class="student-table wc-trend-table">/g) || []).length === 2 &&
    /\.wu-scroll-x \{ overflow-x: auto;/.test(uiCss) && /\.wc-trend-table th,\n\.wc-trend-table td \{ white-space: nowrap;/.test(css));

  // Through the subtab, from what is loaded, for a teacher as much as an admin.
  const w = world(scriptSrc, { currentUser: PARK, cashTransactions: trendRows(), teachers: TREND_STAFF, students: TREND_KIDS,
                               cutoffMs: new Date(2026, 8, 14).getTime() });
  w.app.switchAnalyticsSubtab("trends");
  const body = el(w, "cashTrendsBody").innerHTML;
  check("opening Trends draws it, for a teacher too", el(w, "analyticsTrends").style.display === "block" && /Sep 14–18/.test(body));
  check("the placeholder is gone and Transactions is left alone",
    !/Trend analysis will be displayed here/.test(html) && /Transaction history will be displayed here\./.test(html));
  check("it reads what is loaded: no query in the renderer",
    !/convexQuery|fetch\(/.test(liftFn(code, "renderCashTrends") + liftFn(code, "cashTrendWeeks")));
}

// ==================================================================== 6, 7
console.log("\n6. Version stamps and wiring");
{
  const stamps = [...html.matchAll(/\?v=([0-9a-z]+)/g)].map((m) => m[1]);
  check("all 26 stamps moved to 20261001s together", stamps.length === 26 && stamps.every((s) => s === "20261001s"),
    [...new Set(stamps)].join(","));
  check("this test runs right after cash-audit.test.mjs",
    /node cash-audit\.test\.mjs && node cash-analytics-fixes\.test\.mjs/.test(pkg.scripts.test));
}

// ==================================================================== teeth
console.log("\nDO THE ASSERTIONS HAVE TEETH?\n");
{
  // 1. Purchases back in as behaviour.
  const src = breakOnce(scriptSrc, "            if (kind && kind !== 'award' && kind !== 'deduct') return false;\n", "", "kind");
  const w = world(src);
  w.app.updateDashboard();
  check("TEETH: let a purchase be a behaviour and the dashboard counts two Power-Up Passes as deductions",
    el(w, "dashTotalNegative").textContent === 3 && el(w, "dashTotalDeducted").textContent === "$3,050",
    el(w, "dashTotalNegative").textContent + " " + el(w, "dashTotalDeducted").textContent);
  w.app.updateTeacherInteractions();
  check("TEETH: ...and charges Ms. Lee with the sale she rang up",
    leeCells(el(w, "teacherActivityTableBody").innerHTML)[3] === "2");
  const kids = [kid("buyer", "9"), kid("seen", "9")];
  const rows = [
    { id: "b", kind: "redeem", amount: -1500, teacherId: "", studentId: "buyer", timestamp: new Date().toISOString() },
    { id: "s", kind: "award", amount: 100, teacherId: "t1", studentId: "seen", timestamp: new Date().toISOString() },
  ];
  const wq = world(src, { students: kids, cashTransactions: rows });
  wq.app.wcRenderQuietStudents(true);
  const buyer = el(wq, "dashQuietList").innerHTML.split("wc-quiet-row").find((r) => /BUYER/.test(r)) || "";
  check("TEETH: ...and stops calling the child who bought a pass 'never awarded'", !/never awarded/.test(buyer));
}
{
  // 1b. The gauge back on the sign.
  const src = breakOnce(scriptSrc,
    "const negatives = cashThisWeek.filter(t => cashBehaviourKind(t, _weekReversedIds) === 'deduct').length;",
    "const negatives = cashThisWeek.filter(t => (Number(t.amount) || 0) < 0).length;", "gauge");
  const r = globalThis.__gaugeRun(src);
  check("TEETH: a gauge counting by sign calls purchases and a reset 'Corrective'", r.negatives > 1, JSON.stringify(r));
}
{
  // 1c. The 'Negative Only' filter back on `type`.
  const src = breakOnce(scriptSrc,
    "if (selectedType === 'negative' && cashBehaviourKind(txn, _detailReversedIds) !== 'deduct') return false;",
    "if (selectedType === 'negative' && txn.type !== 'negative') return false;", "neg-filter");
  const w = world(src);
  el(w, "teacherInteractionFilterType").value = "negative";
  w.app.updateTeacherInteractionDetails();
  check("TEETH: a sign-based 'Negative Only' lists the Power-Up Pass", /Power-Up Pass/.test(el(w, "teacherInteractionDetailsTableBody").innerHTML));
}
{
  // 2. Each guard removed on its own -- the others would otherwise mask it.
  const stats = { t1: { name: "Ms. Lee", totalInteractions: 3, positiveCount: 2, negativeCount: 1,
    totalAwarded: 0, totalDeducted: 0, studentsImpacted: new Set() } };
  const tableOpen = breakOnce(scriptSrc,
    "            if (!cashStaffViewsAllowed()) { wipeStaffCashViews(); return; }\n            const tbody = document.getElementById('teacherActivityTableBody');",
    "            const tbody = document.getElementById('teacherActivityTableBody');", "gate-table");
  const w = world(tableOpen, { currentUser: PARK });
  w.app.updateTeacherActivityTable(stats);
  check("TEETH: without its guard, a direct call shows a teacher a colleague by name",
    /Ms\. Lee/.test(el(w, "teacherActivityTableBody").innerHTML));

  const detailsOpen = breakOnce(scriptSrc,
    "            if (!cashStaffViewsAllowed()) { wipeStaffCashViews(); return; }\n            const tbody = document.getElementById('teacherInteractionDetailsTableBody');",
    "            const tbody = document.getElementById('teacherInteractionDetailsTableBody');", "gate-details");
  const wd = world(detailsOpen, { currentUser: PARK });
  wd.app.updateTeacherInteractionDetails();
  check("TEETH: without its guard, the detail table lists a colleague's rows and notes",
    /Not Responsible/.test(el(wd, "teacherInteractionDetailsTableBody").innerHTML));

  const noRedirect = breakOnce(scriptSrc,
    "            if (!applyCashAnalyticsGate() && subtab === 'teacherInteractions') subtab = 'dashboard';",
    "            applyCashAnalyticsGate();", "redirect");
  const wr = world(noRedirect, { currentUser: PARK });
  wr.app.switchAnalyticsSubtab("teacherInteractions");
  // The guards inside still empty and hide the pane, so what a teacher would
  // see without the redirect is NOTHING: no Data Dashboard either.
  check("TEETH: without the redirect a teacher lands on a blank tab instead of the Data Dashboard",
    el(wr, "analyticsDashboard").style.display === "none" && el(wr, "analyticsTeacherInteractions").style.display === "none");

  const noWipe = breakOnce(scriptSrc, "            if (!allowed) wipeStaffCashViews();\n            return allowed;",
    "            return allowed;", "wipe");
  const wn = world(noWipe, { currentUser: PBIS });
  wn.app.switchAnalyticsSubtab("teacherInteractions");
  wn.app.set("currentUser", PARK);
  wn.app.applyCashAnalyticsGate();
  check("TEETH: without the wipe, the PBIS lead's tables outlive their sign-out", /Mr\. Park/.test(wn.dom.text()));

  const noPbis = breakOnce(scriptSrc, "const CASH_STAFF_VIEW_ROLES = ['admin', 'superadmin', 'pbis'];",
    "const CASH_STAFF_VIEW_ROLES = ['admin', 'superadmin'];", "pbis");
  check("TEETH: drop 'pbis' from the roles and the PBIS lead is refused", world(noPbis).app.cashStaffViewsAllowed(PBIS) === false);

  const unscoped = breakOnce(scriptSrc, "            let rows = cashAuditEntriesFor(auditLog, currentUser)\n",
    "            let rows = auditLog.filter(CA.isCashEntry)\n", "audit");
  const log = [{ entryId: "1", action: "cash_award", teacher: "Ms. Lee", teacherId: "t1", studentId: "s6", ticketCount: 100, timestamp: "2026-09-30T10:00:00Z" }];
  const wa = world(unscoped, { auditLog: log, currentUser: PARK });
  el(wa, "searchCashAudit").value = "lee";
  wa.app.updateCashAuditLogTable();
  check("TEETH: an unscoped audit log lets a teacher search a colleague", /Ms\. Lee/.test(el(wa, "cashAuditLogTable").innerHTML));

  const raw = breakOnce(scriptSrc, "<td style=\"font-weight: 600;\">${escapeHtml(String(stats.name || 'Unknown'))}</td>",
    "<td style=\"font-weight: 600;\">${stats.name}</td>", "escape");
  const we = world(raw);
  we.app.updateTeacherInteractions();
  check("TEETH: an unescaped name injects markup", /<b>Ms\. Lee<\/b>/.test(el(we, "teacherActivityTableBody").innerHTML));
}
{
  // 3. The minimum and the rounding.
  const noMin = breakOnce(scriptSrc, "            if (d < CASH_RATIO_MIN_DEDUCTIONS) {", "            if (false) {", "min");
  check("TEETH: without the minimum, one deduction makes a ratio", world(noMin).app.cashRatioVerdict(15, 3).tone !== "neutral");
  const rounded = breakOnce(scriptSrc, "label: shown.toFixed(1) + ' to 1',", "label: ratio.toFixed(1) + ' to 1',", "round");
  check("TEETH: rounding to nearest shows 4.99 as '5.0 to 1' below the goal",
    world(rounded).app.cashRatioVerdict(499, 100).label === "5.0 to 1");
  const seventy = breakOnce(scriptSrc, "const meets = ratio >= CASH_RATIO_GOAL;", "const meets = a / (a + d) >= 0.7;", "70");
  check("TEETH: the old 70% line calls 3 to 1 green", world(seventy).app.cashRatioVerdict(15, 5).tone === "meets");
}
{
  // 4. Each of the goal's three corrections, undone one at a time.
  const base = goalWorld(scriptSrc);
  const goalOf = (w) => el(w, "dashGoalChip").textContent;
  const everyone = breakOnce(scriptSrc, "            const staffCounts = cashGoalStaffCounts(teachers, awardsByActor);",
    "            const staffCounts = (Array.isArray(teachers) ? teachers : []).map(t => awardsByActor[t.id] || 0);", "everyone");
  check("TEETH: a median over every staff record moves the goal", goalOf(goalWorld(everyone).w) !== goalOf(base.w),
    goalOf(goalWorld(everyone).w) + " vs " + goalOf(base.w));
  const withDeductions = breakOnce(scriptSrc,
    "                if (cashBehaviourKind(t, _quietReversedIds) !== 'award') return;\n                const actor = t.teacherId || t.addedBy || t.removedBy;\n                if (!actor) return;",
    "                const actor = t.teacherId || t.addedBy || t.removedBy;\n                if (!actor) return;", "awards-only");
  check("TEETH: counting deductions toward the goal moves it", goalOf(goalWorld(withDeductions).w) !== goalOf(base.w));
  const calendar = breakOnce(scriptSrc, "R.dailyGoal(staffCounts, Math.max(1, schoolDays))", "R.dailyGoal(staffCounts, QUIET_WINDOW_DAYS)", "days");
  check("TEETH: thirty calendar days moves it", goalOf(goalWorld(calendar).w) !== goalOf(base.w));
  const todayAll = breakOnce(scriptSrc,
    "                if (cashBehaviourKind(t, _quietReversedIds) !== 'award') return false;\n", "", "today");
  check("TEETH: counting today's corrections as progress is caught", goalOf(goalWorld(todayAll).w).startsWith("5 /"));
}
{
  // 5. The calendar day, and the future.
  const utc = breakOnce(scriptSrc, "                const day = wcIsoDay(t.timestamp);", "                const day = String(t.timestamp).slice(0, 10);", "utc");
  const m = trendModel(utc);
  check("TEETH: a UTC day moves Sunday evening's award into the next week", m.weeks[0].awards === 4 && m.weeks[1].awards === 1,
    m.weeks.map((w) => w.awards).join());
  const future = breakOnce(scriptSrc, "                if (!day || day > todayIso) return;", "                if (!day) return;", "future");
  check("TEETH: without the today check, tomorrow's award is counted 'so far'", trendModel(future).weeks[2].awards === 2);
}

{
  // THE REVIEW'S FINDINGS, each undone on its own.
  const noReset = breakOnce(scriptSrc, "                    : isReset ? 'Reset'\n", "", "reset");
  check("TEETH: without its own badge, a balance reset is a red 'Negative' again", /Negative/.test(resetRow(allTypes(noReset))));

  const totalNote = breakOnce(scriptSrc,
    "'<span class=\"wc-quiet-few\">' + r.positive + ' award' + (r.positive === 1 ? '' : 's') +",
    "'<span class=\"wc-quiet-few\">' + r.total + ' award' + (r.total === 1 ? '' : 's') +", "quiet-note");
  check("TEETH: printing r.total calls the deduction an award ('6 awards')", /6 awards/.test(quietNote(totalNote)));

  const flaggedOpen = breakOnce(scriptSrc,
    "            // \"Primary Teachers\" names colleagues: admins and PBIS only (2026-10-01).\n" +
    "            if (!cashStaffViewsAllowed()) { wipeStaffCashViews(); return; }\n", "", "gate-intervention");
  const leaks = directCallLeaks(world(flaggedOpen, { currentUser: PARK }));
  check("TEETH: without its guard, the flagged table names a colleague to a teacher -- and the per-call check sees it",
    leaks.some((l) => /^updateInterventionStudents/.test(l)), leaks.join("; "));

  const bothOff = breakOnce(innerGuardsOff(scriptSrc), "            if (!applyCashAnalyticsGate()) return;\n", "", "gate-outer");
  const wb = world(bothOff, { currentUser: PARK });
  wb.app.updateTeacherInteractions();
  check("TEETH: take the tab's own guard away as well and the names are back", STAFF_NAMES.test(wb.dom.text()));

  const saleCounts = breakOnce(scriptSrc,
    "                    if (!isCashBehaviourRow(txn, _interventionReversedIds)) return;\n", "", "primary-teachers");
  check("TEETH: count the sale and Mr. Park becomes a Primary Teacher", /Mr\. Park/.test(primaryTeachers(saleCounts)));

  const wholeLog = breakOnce(scriptSrc, "                const log = dashFeedEntriesFor(auditLog, currentUser);",
    "                const log = Array.isArray(auditLog) ? auditLog : [];", "feed");
  check("TEETH: the whole log in the feed shows a teacher a colleague's deduction note",
    /talked back/.test(feedRun(wholeLog, PARK, FEED_LOG()).feed));

  const asks = breakOnce(scriptSrc, "                logout({ inactive: true });", "                logout();", "inactivity");
  const r = await idleOut(asks, false);
  check("TEETH: an inactivity logout that asks can be Cancelled, and the admin stays signed in",
    r.app.who() !== null && r.G.confirms === 1);

  const verdictZero = breakOnce(scriptSrc, "{ tone: 'neutral', label: '—', note: 'no grades selected' }", "cashRatioVerdict(0, 0)", "no-grades");
  check("TEETH: a verdict of (0, 0) with nothing ticked says 'no deductions'", noGradesTile(verdictZero, []).value === "no deductions");

  const nearest = breakOnce(scriptSrc, "const shown = Math.floor((a * 10) / d) / 10;", "const shown = Math.round((a * 10) / d) / 10;", "gauge-round");
  check("TEETH: rounding the gauge to the nearest shows 4.99 as 5.0", /^5\.0</.test(gaugeDisplay(nearest, 499, 100).html));

  const weekendGoal = breakOnce(scriptSrc,
    "                                median: staffMedian, schoolDays: schoolDays,\n" +
    "                                noSchool: todayDow === 0 || todayDow === 6 });",
    "                                median: staffMedian, schoolDays: schoolDays });", "weekend-goal");
  check("TEETH: without the weekend check, Saturday asks for awards",
    /^\d+ \/ \d+$/.test(el(goalWorld(weekendGoal, { now: SATURDAY }).w, "dashGoalChip").textContent));

  const weekendSoFar = breakOnce(scriptSrc, "soFar: m === thisMonday && schoolDayToday,", "soFar: m === thisMonday,", "weekend-so-far");
  check("TEETH: without the weekday check, a finished week is 'so far' on Saturday",
    trendModel(weekendSoFar, { todayIso: "2026-10-03" }).weeks.some((w) => w.soFar));

  const anyLaunch = breakOnce(scriptSrc, "launch: m === first && m === CASH_LAUNCH_WEEK,", "launch: m === first,", "launch");
  check("TEETH: 'launch week' on whatever week the history starts is caught",
    trendModel(anyLaunch, { cutoffIso: "2026-09-21" }).weeks[0].launch === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
