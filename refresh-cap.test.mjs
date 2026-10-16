// The idle refresh re-reads the roster once every few minutes, not every
// thirty seconds, and RESET ALL CASH refuses to run on balances it could not
// read fresh. Run: npm test
//
// THE BUG, found 2026-10-15. An idle staff tab asked the server "is anything
// newer?" every 30 seconds, and the answer was always yes: the server's stamp
// moves on every save by anyone, and since 9/9 the refresh never moved the
// tab's own copy of it. So every quiet staff tab re-read every student, about
// 5 MB, every 30 seconds (every 60 in a background tab) until the 30-minute
// logout: most of what appData:load cost the school.
//
// THE DESIGN THESE TESTS HOLD IT TO (cap-verdict.md section 5, owner 10/16):
//   - staff tabs only; idle five minutes AND the dial's minutes (ten unless the
//     server says otherwise) since the last roster load or the last idle
//     attempt, failed attempts included;
//   - background tabs follow the same rule (no hidden-tab skip), and the price
//     list pull and the attendance cache drops run on EVERY idle tick, before
//     the cap;
//   - no "is the server newer?" peek at all;
//   - a load that shows more than 5% fewer enrolled than the tab holds is
//     released unused and read again a minute later, and that answer is
//     believed;
//   - RESET ALL CASH reads the roster fresh after its typed confirmation and
//     stops, saying "Balances were NOT reset", when that read fails.
//
// THE SHIPPED CODE RUNS. The tick, its helpers, both roster loaders and the
// reset are lifted out of script.js and run on a fake clock: the interval the
// page registers is captured and fired every thirty fake seconds. Every guard
// below is broken in turn by scripts/refresh-cap-teeth.mjs, which requires the
// named check to fail.
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const J = (x) => JSON.stringify(x);

function liftFn(name) {
  const m = new RegExp("\\n        (?:async )?function " + name + "\\(").exec(script);
  if (!m) throw new Error("missing function " + name);
  const start = m.index + 1;
  const end = script.indexOf("\n        }\n", start);
  if (end < 0) throw new Error("unterminated function " + name);
  return script.slice(start, end + 10);
}
function liftDecl(name) {
  const m = new RegExp("\\n\\s*((?:const|let) " + name + " = [^\\n]*;)").exec(script);
  if (!m) throw new Error("declaration not found: " + name);
  return m[1];
}
function liftLine(text) {
  const i = script.indexOf(text);
  if (i < 0 || script.indexOf(text, i + 1) >= 0) throw new Error("line not found exactly once: " + text);
  return script.slice(i, script.indexOf("\n", i));
}

const MIN = 60 * 1000;
const T0 = Date.parse("2026-10-19T15:00:00Z");   // 8:00 am in Los Angeles, a Monday

const STATE = ["IDLE_RELOAD_DEFAULT_MINUTES", "IDLE_RELOAD_MIN_MINUTES", "IDLE_RELOAD_MAX_MINUTES",
  "_idleReloadMinutes", "_lastRosterLoadAt", "_lastIdleReloadAttemptAt", "_idleCollapseRetryAt",
  "AUTO_REFRESH_DELAY", "IDLE_COLLAPSE_RETRY_MS", "IDLE_COLLAPSE_FALL", "IDLE_TICK_SLACK_MS"].map(liftDecl).join("\n");
const FNS = ["idleReloadMinutesFrom", "noteIdleRefreshDial", "noteRosterLoaded", "loadRosterFromConvex",
  "refreshRosterFromConvex", "refreshCashFromServer", "dropSisCaches", "idleReloadDue", "idleRefreshTick",
  "canOpenSettings", "resetAllStudentCash", "_resetAllStudentCash", "liveStudentRecord"];
const INTERVAL = liftLine("autoRefreshInterval = setInterval(idleRefreshTick, 30000);");

/**
 * One browser tab: the lifted code, a fake clock, a fake server and the
 * interval the page registers. `src` lets a test run a broken copy.
 */
function makeTab(opts = {}, src = script) {
  const o = opts;
  const lift = (n) => {
    const m = new RegExp("\\n        (?:async )?function " + n + "\\(").exec(src);
    if (!m) throw new Error("missing function " + n);
    const s = m.index + 1;
    return src.slice(s, src.indexOf("\n        }\n", s) + 10);
  };
  const state = src === script ? STATE : STATE.split("\n").map((l) => {
    const name = /(?:const|let) (\w+)/.exec(l)[1];
    const m = new RegExp("\\n\\s*((?:const|let) " + name + " = [^\\n]*;)").exec(src);
    return m ? m[1] : l;
  }).join("\n");
  const interval = src === script ? INTERVAL : (() => {
    const i = src.indexOf("autoRefreshInterval = setInterval(");
    return src.slice(i, src.indexOf("\n", i));
  })();
  // loadData's own install block, cut verbatim. The week watchdog, the
  // stale-save reload and a reversal's reload load through it, and no
  // refreshRosterFromConvex follows them.
  const loadDataInstall = (() => {
    const head = "                        if (rosterLoad) {\n                            const rows = rosterLoad.install();";
    const i = src.indexOf(head);
    if (i < 0 || src.indexOf(head, i + 1) >= 0) throw new Error("loadData's install block not found exactly once");
    const end = "\n                        }\n";
    return src.slice(i, src.indexOf(end, i) + end.length);
  })();
  const clock = { now: o.now ?? T0 };
  const calls = [];                 // every convexQuery, by name
  const server = {
    enrolled: o.enrolled ?? 100,     // how many enrolled students the next load returns
    former: 10,
    balance: o.balance ?? 600,       // what the server holds for every student
    dial: o.dial,                    // idleRefreshMinutes on the answer (undefined: an old server)
    fail: false,
    latency: 0,                      // how long each appData:load takes, in fake milliseconds
    starts: [],                      // when each appData:load was asked for
  };
  const rowsFor = () => {
    const rows = [];
    for (let i = 0; i < server.enrolled; i++) rows.push({ id: "S" + i, enrolled: true, wildcatCashBalance: server.balance });
    for (let i = 0; i < server.former; i++) rows.push({ id: "F" + i, enrolled: false, wildcatCashBalance: server.balance });
    return rows;
  };
  const counts = { installs: 0, opened: 0, ended: 0, prices: 0, live: 0, recorded: [], saves: 0, alerts: [], prompts: 0 };
  const reg = { tick: null, every: null };
  const window = {
    WildcatAuth: {
      getSession: () => (o.signedOut ? null : { idToken: "tok" }),
      convexQuery: async (name) => {
        calls.push(name);
        if (name !== "appData:load") throw new Error("unexpected query " + name);
        server.starts.push(clock.now);
        if (server.fail) throw new Error("Server Error (the 16 MiB read limit)");
        clock.now += server.latency;
        const answer = { students: rowsFor(), teachers: [], settings: {}, historyCutoff: null };
        if (server.dial !== undefined) answer.idleRefreshMinutes = server.dial;
        return answer;
      },
    },
  };
  const document = {
    hidden: !!o.hidden,
    getElementById: (id) => (id === "studentAccountsTab" ? { classList: { contains: () => false } } : null),
    querySelector: () => null,
  };
  const body = `
    ${state}
    const DATA_SOURCE = ${JSON.stringify(o.dataSource ?? "convex")};
    const CASH_COUNTER_FIELDS = ["wildcatCashBalance"];
    let students = [], nonEnrolledStudents = [], teachers = [], cashTransactions = [], auditLog = [];
    let currentUser = ${JSON.stringify(o.student ? null : { id: "T1", name: "Ada", role: o.role ?? "teacher" })};
    let currentStudent = ${JSON.stringify(o.student ? { id: "S1" } : null)};
    let rosterSource = null;
    const rosterIsAuthoritative = () => rosterSource === 'convex';
    let binId = 'bin', isSyncing = false, lastUserActivity = clock.now, disciplineModeEnabled = false;
    let autoRefreshInterval = null;
    let _attCache = 'x', _runCache = 'x', _ewCache = 'x', _paCache = 'x', _cashNoticeMarks = 'x', _sgCache = 'x', _arCache = 'x';
    const _attWinCache = { n: 1, clear() { this.n = 0; } };
    const dropAttendanceGroupCache = () => {};
    const pullCashBehaviors = () => { counts.prices++; };
    const pullLiveActivity = () => { counts.live++; };
    const noteHistoryCutoff = () => {};
    const beginCashLoad = () => { counts.opened++; return { id: counts.opened }; };
    const endCashLoad = () => { counts.ended++; };
    const commitRosterCash = () => { counts.installs++; };
    const reconcileCashLedger = () => {};
    const saveSession = () => {};
    const isPreviewingTeacher = () => false;
    const _saveQueue = { isPending: () => false };
    const applyRoleGates = () => {};
    const rescopeDisciplineForRole = async () => {};
    const switchTab = () => {};
    const updateCashTable = () => {}, updateStudentAccounts = () => {};
    const showPrompt = async () => { counts.prompts++; return ${JSON.stringify(o.typed ?? "RESET ALL CASH")}; };
    const alert = (m) => { counts.alerts.push(String(m)); };
    const recordCashTransaction = (t) => { counts.recorded.push({ id: t.student.id, amount: t.amount, behaviorId: t.behaviorId }); };
    const saveData = async () => { counts.saves++; return true; };
    const setInterval = (fn, ms) => { reg.tick = fn; reg.every = ms; return 1; };
    const setTimeout = () => 0;
    const Date = class extends RealDate {
      constructor(...a) { if (a.length) super(...a); else super(clock.now); }
      static now() { return clock.now; }
    };
    ${FNS.map(lift).join("\n")}
    ${interval}
    async function loadDataRoster() {
      const rosterLoad = await loadRosterFromConvex();
      const mainData = {};
      ${loadDataInstall}
      students = mainData.students;
    }
    return {
      idleRefreshTick, refreshRosterFromConvex, refreshCashFromServer, resetAllStudentCash, loadDataRoster,
      idleReloadMinutesFrom, noteIdleRefreshDial,
      get students() { return students; }, set students(v) { students = v; },
      get dial() { return _idleReloadMinutes; },
      get lastLoad() { return _lastRosterLoadAt; },
      caches: () => [_attCache, _runCache, _ewCache, _paCache, _cashNoticeMarks, _sgCache, _arCache, _attWinCache.n],
      fill: () => { _attCache = _runCache = _ewCache = _paCache = _cashNoticeMarks = _sgCache = _arCache = 'x'; _attWinCache.n = 1; },
      active: () => { lastUserActivity = clock.now; },
      setStudent: (v) => { currentStudent = v; },
      auditLog: () => auditLog,
    };
  `;
  const api = new Function("window", "document", "console", "clock", "counts", "reg", "RealDate", body)(
    window, document, { log() {}, warn() {}, error() {} }, clock, counts, reg, globalThis.Date);
  return {
    api, clock, calls, server, counts,
    loads: () => calls.filter((c) => c === "appData:load").length,
    every: () => reg.every,
    /** Fire the page's own interval at each 30 s mark up to `toMs` after T0. */
    async runTo(toMs) {
      while (clock.now + reg.every <= T0 + toMs) {
        clock.now += reg.every;
        await reg.tick();
      }
    },
    /** Fire the page's own interval once, at `ms` after T0 (for loads that move the clock). */
    async tickAt(ms) { clock.now = T0 + ms; await reg.tick(); },
    /** A boot or sign-in load at the current time, as loadData / the sign-in listener do. */
    async boot() { return api.refreshRosterFromConvex("sign-in"); },
  };
}

// ===========================================================================
console.log("\nA. AN IDLE STAFF TAB RE-READS THE ROSTER ONCE PER INTERVAL, NOT EVERY TICK\n");
{
  const t = makeTab();
  await t.boot();
  check("the page registers the tick every 30 seconds", t.every() === 30000, String(t.every()));
  await t.runTo(5 * MIN);
  check("nothing at all in the first five idle minutes (no load, no price pull)", t.loads() === 1 && t.counts.prices === 0,
    `loads ${t.loads()}, prices ${t.counts.prices}`);
  await t.runTo(9.5 * MIN);
  check("NO RELOAD BEFORE THE CAP: idle 5-9.5 minutes, still only the boot load", t.loads() === 1, String(t.loads()));
  await t.runTo(10 * MIN);
  check("...and one reload when ten minutes have passed since the last load", t.loads() === 2, String(t.loads()));
  await t.runTo(30 * MIN);
  check("a 30-minute idle stretch costs three reloads (it cost about fifty)", t.loads() - 1 === 3, String(t.loads() - 1));
  check("each reload is installed, with the cash rebase inside install()", t.counts.installs === 4, String(t.counts.installs));
  check("STAFF TABS NEVER ASK appData:freshness: no 'is the server newer?' peek", !t.calls.includes("appData:freshness"));
  check("the live audit and cash pull follows each successful reload", t.counts.live === 3, String(t.counts.live));
}
{
  // A load by ANY path holds the next idle reload off: here a sign-in at 8:07.
  const t = makeTab();
  await t.boot();
  await t.runTo(7 * MIN);
  t.clock.now = T0 + 7 * MIN + 1000;
  await t.boot();
  t.clock.now = T0 + 7 * MIN;
  await t.runTo(16.5 * MIN);
  check("a sign-in load counts: the idle reload waits ten minutes from it, not from the boot", t.loads() === 2, String(t.loads()));
  await t.runTo(17 * MIN);
  check("...and comes at 17:00, the first check within half a tick of ten minutes after it", t.loads() === 3, String(t.loads()));
}
{
  // A held movement's cash-only re-read is a whole appData:load too.
  const t = makeTab();
  await t.boot();
  t.clock.now = T0 + 4 * MIN;
  await t.api.refreshCashFromServer("a movement the server held");
  check("refreshCashFromServer records that it loaded", t.api.lastLoad === T0 + 4 * MIN, String(t.api.lastLoad - T0));
}
{
  // loadData's own load holds the idle reload off too: the week watchdog, a
  // stale-save reload and a reversal's reload run it with no
  // refreshRosterFromConvex after it. Here one lands at 8:09.
  const t = makeTab();
  await t.boot();
  await t.runTo(9 * MIN);
  await t.api.loadDataRoster();
  check("A loadData LOAD COUNTS: it records the moment the roster went on screen", t.api.lastLoad === T0 + 9 * MIN,
    String((t.api.lastLoad - T0) / MIN));
  await t.runTo(18.5 * MIN);
  check("...so the idle reload waits ten minutes from it, not from the boot", t.loads() === 2, String(t.loads()));
  await t.runTo(19 * MIN);
  check("...and comes at 19:00", t.loads() === 3, String(t.loads()));
}

// ===========================================================================
console.log("\nB. A BACKGROUND TAB FOLLOWS THE SAME RULE, AND KEEPS ITS PRICES CURRENT\n");
{
  const t = makeTab({ hidden: true });
  await t.boot();
  await t.runTo(6 * MIN);
  check("A HIDDEN TAB STILL PULLS PRICES on every idle tick (5:30 and 6:00)", t.counts.prices === 2, String(t.counts.prices));
  t.api.fill();
  await t.runTo(6.5 * MIN);
  check("...and drops the attendance caches on every idle tick, before the cap", t.api.caches().every((c) => c === null || c === 0),
    JSON.stringify(t.api.caches()));
  check("...with no reload yet", t.loads() === 1);
  await t.runTo(10 * MIN);
  check("A HIDDEN TAB RELOADS AFTER THE CAP, exactly as a visible one does", t.loads() === 2, String(t.loads()));
  await t.runTo(30 * MIN);
  check("...three reloads in the idle stretch, and a price pull on every idle tick",
    t.loads() === 4 && t.counts.prices === 50, `loads ${t.loads()}, prices ${t.counts.prices}`);
}
{
  // The teacher comes back: activity ends the idle stretch, nothing reloads on return.
  const t = makeTab({ hidden: true });
  await t.boot();
  await t.runTo(12 * MIN);
  const before = t.loads();
  t.api.active();
  await t.runTo(16 * MIN);
  check("NO REFRESH ON RETURN: activity stops the idle path; nothing loads in the next four minutes", t.loads() === before,
    `${before} -> ${t.loads()}`);
}

// ===========================================================================
console.log("\nC. A FAILING LOAD IS TRIED ONCE PER INTERVAL, NOT EVERY TICK\n");
{
  const t = makeTab();
  await t.boot();
  t.server.fail = true;
  const before = t.api.students;
  await t.runTo(30 * MIN);
  check("A FAILED ATTEMPT COUNTS: three tries in the idle stretch (10, 20, 30 minutes), not one per tick",
    t.loads() - 1 === 3, String(t.loads() - 1));
  check("...each failure leaves the roster on screen exactly as it was", t.api.students === before);
  check("...and the load is closed in the cash journal every time", t.counts.opened === t.counts.ended, `${t.counts.opened}/${t.counts.ended}`);
  t.server.fail = false;
  await t.runTo(40 * MIN);
  check("...and once the server answers again, the next interval reloads", t.loads() - 1 === 4 && t.counts.installs === 2,
    `${t.loads() - 1} tries, ${t.counts.installs} installs`);
}

// ===========================================================================
console.log("\nD. THE ENROLMENT-COLLAPSE GUARD: RELEASE, RETRY A MINUTE LATER, BELIEVE THE RETRY\n");
{
  const t = makeTab({ enrolled: 100 });
  await t.boot();
  const held = t.api.students;
  t.server.enrolled = 40;                        // the sync has the enrolment table half empty
  await t.runTo(10 * MIN);
  check("A COLLAPSED LOAD IS RELEASED, NOT INSTALLED: 100 enrolled stay on screen, the same records",
    t.loads() === 2 && t.api.students === held && t.api.students.length === 100 && t.counts.installs === 1,
    `loads ${t.loads()}, enrolled ${t.api.students.length}, installs ${t.counts.installs}`);
  check("...and released in the cash journal, so it holds nothing open", t.counts.opened === t.counts.ended);
  await t.runTo(10.5 * MIN);
  check("...no retry thirty seconds on", t.loads() === 2);
  await t.runTo(11 * MIN);
  check("THE RETRY'S ANSWER IS BELIEVED: a minute later, still 40, it is installed", t.loads() === 3 && t.api.students.length === 40,
    `loads ${t.loads()}, enrolled ${t.api.students.length}`);
  await t.runTo(20.5 * MIN);
  check("...and the ten-minute rhythm resumes from the retry", t.loads() === 3);
}
{
  const t = makeTab({ enrolled: 100 });
  await t.boot();
  t.server.enrolled = 30;
  await t.runTo(10 * MIN);
  t.server.enrolled = 101;                       // the sync finished
  await t.runTo(11 * MIN);
  check("a retry after the sync has finished installs the full roster", t.api.students.length === 101, String(t.api.students.length));
}
{
  const t = makeTab({ enrolled: 100 });
  await t.boot();
  t.server.enrolled = 96;                        // a 4% fall is ordinary (withdrawals)
  await t.runTo(10 * MIN);
  check("a fall of 5% or less is installed at once, with no retry", t.api.students.length === 96 && t.loads() === 2);
}
{
  // The guard is the idle path's alone: a sign-in or a reset installs whatever it reads.
  const t = makeTab({ enrolled: 100 });
  await t.boot();
  t.server.enrolled = 20;
  await t.boot();
  check("...and a sign-in load is never second-guessed by it", t.api.students.length === 20);
}
{
  // THE RETRY COUNTS ONLY INSIDE ITS OWN MINUTE (review, 2026-10-16). The
  // teacher comes back inside the retry's minute and works until 50:00, so the
  // retry is never reached while it means anything. At the first idle tick
  // after that, the sync (or an admin's Sync now) has the table half empty
  // again: that read must be guarded like any other, not installed unchecked.
  const t = makeTab({ enrolled: 100 });
  await t.boot();
  t.server.enrolled = 30;
  await t.runTo(10 * MIN);                       // released at 10:00; the retry was due at 11:00
  t.server.enrolled = 100;
  for (let m = 10.5; m <= 50; m += 0.5) { t.api.active(); await t.runTo(m * MIN); }
  t.server.enrolled = 30;
  await t.runTo(55.5 * MIN);                     // idle again from 55:00
  check("A LATE RETRY IS GUARDED: idle again 45 minutes on, a short read is released, not installed unchecked",
    t.loads() === 3 && t.api.students.length === 100, `loads ${t.loads()}, enrolled ${t.api.students.length}`);
}
{
  // A roster put on screen by another route after the release leaves the
  // retry nothing to re-check: here a sign-in at 10:00, straight after it.
  const t = makeTab({ enrolled: 100 });
  await t.boot();
  t.server.enrolled = 30;
  await t.runTo(10 * MIN);
  t.server.enrolled = 100;
  await t.boot();
  await t.runTo(19.5 * MIN);
  check("A NEWER ROSTER CANCELS A PENDING RETRY: after a sign-in load, nothing is read again a minute later",
    t.loads() === 3, String(t.loads()));
  await t.runTo(20 * MIN);
  check("...the next idle reload is ten minutes after the sign-in", t.loads() === 4, String(t.loads()));
}

// ===========================================================================
console.log("\nE. THE DIAL IS THE SERVER'S\n");
{
  const t = makeTab({ dial: 2 });
  await t.boot();
  check("appData:load's idleRefreshMinutes is taken on the load", t.api.dial === 2, String(t.api.dial));
  await t.runTo(30 * MIN);
  // Idle from 5:00; a load is due at the first idle tick (5:30) and then every two minutes.
  check("THE SERVER DIAL CHANGES THE INTERVAL: at 2 minutes, 13 reloads in the idle stretch", t.loads() - 1 === 13, String(t.loads() - 1));
  t.server.dial = 30;
  t.clock.now = T0;
  const t2 = makeTab({ dial: 30 });
  await t2.boot();
  await t2.runTo(30 * MIN);
  check("...and at 30 minutes, one", t2.loads() - 1 === 1, String(t2.loads() - 1));
}
{
  // THE DIAL MEANS WHAT IT SAYS when a load takes a few seconds (review,
  // 2026-10-16). A load is recorded when it goes on screen, seconds after the
  // tick that asked for it, and the ticks come every 30 seconds, so every
  // interval came out one tick long: 0.5 minutes behaved as 1, 2 as 2.5 and
  // 10 as 10.5. Here every appData:load takes three seconds.
  const gapsAt = async (dial) => {
    const t = makeTab({ dial });
    await t.boot();
    t.server.latency = 3000;
    t.server.starts = [];
    for (let k = 1; k <= 80; k++) await t.tickAt(k * 30000);
    const at = t.server.starts.map((ms) => (ms - T0) / MIN);
    return { gaps: [...new Set(at.slice(1).map((m, i) => +(m - at[i]).toFixed(3)))], n: at.length };
  };
  const ten = await gapsAt(undefined), two = await gapsAt(2), half = await gapsAt(0.5);
  check("THE DIAL MEANS WHAT IT SAYS WHEN A LOAD TAKES SECONDS: unset, loads start exactly 10 minutes apart",
    ten.n >= 3 && J(ten.gaps) === J([10]), J(ten));
  check("...set to 2, exactly 2 minutes apart", two.n >= 10 && J(two.gaps) === J([2]), J(two));
  check("...and set to 0.5, at every check (it behaved as 1)", half.n >= 60 && J(half.gaps) === J([0.5]), J(half));
}
{
  const t = makeTab();
  const read = (v) => { t.api.noteIdleRefreshDial(v); return t.api.dial; };
  check("null (nobody has set it) is the default of ten", read(null) === 10);
  check("an old server (no field at all) is the default of ten", read(undefined) === 10);
  check("nonsense is the default, never 'every tick'", read("5") === 10 && read(NaN) === 10 && read(0) === 10 && read(-3) === 10 && read(true) === 10);
  check("a real number is held to 0.5-60 minutes", read(0.1) === 0.5 && read(999) === 60 && read(7.5) === 7.5);
}

// ===========================================================================
console.log("\nF. STUDENT TABS, AND TABS THAT CANNOT LOAD\n");
{
  const t = makeTab({ student: true });
  await t.runTo(30 * MIN);
  check("STUDENT TABS NEVER CALL FRESHNESS, or the roster read, or the price pull",
    t.calls.length === 0 && t.counts.prices === 0, `${t.calls.join(",")} prices ${t.counts.prices}`);
}
{
  const t = makeTab();
  check("refreshRosterFromConvex says true when the roster is on screen", (await t.boot()) === true);
  t.server.fail = true;
  check("...false when the load failed", (await t.boot()) === false);
  const off = makeTab({ dataSource: "firestore" });
  check("...and false when the source is not Convex", (await off.boot()) === false);
}

// ===========================================================================
console.log("\nG. RESET ALL CASH WORKS FROM CURRENT BALANCES, OR NOT AT ALL\n");
{
  const t = makeTab({ role: "admin", balance: 500 });
  await t.boot();                                   // the tab holds $500 each
  t.server.balance = 600;                           // a colleague's award since
  t.server.enrolled = 3; t.server.former = 1;
  await t.api.resetAllStudentCash();
  check("THE RESET READS FRESH: each child is charged the server's $600, not the tab's $500",
    t.counts.recorded.length === 4 && t.counts.recorded.every((r) => r.amount === -600 && r.behaviorId === "system_reset"),
    JSON.stringify(t.counts.recorded.slice(0, 2)));
  check("...after the typed confirmation, then one save", t.counts.prompts === 1 && t.counts.saves === 1,
    `prompts ${t.counts.prompts}, saves ${t.counts.saves}, alerts ${JSON.stringify(t.counts.alerts)}`);
}
{
  const t = makeTab({ role: "admin", balance: 500 });
  await t.boot();
  t.server.fail = true;
  await t.api.resetAllStudentCash();
  check("THE RESET REFUSES WHEN THE FRESH LOAD FAILS: no movement, no save, no audit entry",
    t.counts.recorded.length === 0 && t.counts.saves === 0 && t.api.auditLog().length === 0,
    `${t.counts.recorded.length} movements, ${t.counts.saves} saves`);
  check("...and says so, on the existing 'Balances were NOT reset' path",
    t.counts.alerts.length === 1 && /^Balances were NOT reset\./.test(t.counts.alerts[0]) && /Nothing was changed/.test(t.counts.alerts[0]),
    t.counts.alerts[0]);
}
{
  const t = makeTab({ role: "superadmin", balance: 200 });
  await t.boot();
  t.server.enrolled = 2; t.server.former = 0;
  await t.api.resetAllStudentCash();
  check("a superadmin may reset", t.counts.recorded.length === 2 && t.counts.saves === 1);
}
for (const role of ["teacher", "campusaide", "pbis"]) {
  const t = makeTab({ role, balance: 500 });
  await t.boot();
  const loadsBefore = t.loads();
  await t.api.resetAllStudentCash();
  check(`A ${role.toUpperCase()} CANNOT RESET: refused before the prompt, nothing read, moved or saved`,
    t.counts.prompts === 0 && t.loads() === loadsBefore && t.counts.recorded.length === 0 && t.counts.saves === 0
      && /^Balances were NOT reset\./.test(t.counts.alerts[0] || ""), t.counts.alerts[0]);
}
{
  const t = makeTab({ role: "admin", typed: "reset" });
  await t.boot();
  const before = t.loads();
  await t.api.resetAllStudentCash();
  check("a wrong confirmation reads nothing and moves nothing", t.loads() === before && t.counts.recorded.length === 0);
}
{
  // Between the fresh read and the movements, nothing may await: another load
  // landing in between would change the balances being charged.
  const body = liftFn("_resetAllStudentCash");
  const from = body.indexOf("if (!(await refreshRosterFromConvex('reset', { redraw: false })))");
  const to = body.indexOf("const saved = await saveData();");
  const between = body.slice(from, to).replace(/\/\/.*$/gm, "");
  check("NOTHING AWAITS between the fresh read and the movements (the read is the only await before the save)",
    from > 0 && to > from && (between.match(/\bawait\b/g) || []).length === 1, String((between.match(/\bawait\b/g) || []).length));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
