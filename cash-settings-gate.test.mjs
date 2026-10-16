// Cash Settings and Sync PowerSchool are for admins, on every path into Cash
// mode, and the actions behind them ask for themselves. Run: npm test
//
// THE BUG, checked 2026-10-16 (the owner: "yes check and fix it"). The two
// buttons are built by updateTabVisibility when Cash mode is entered, with
// class "admin-only" -- and that class hides nothing on its own: only
// ".admin-only.disabled" does (styles.css), and `.disabled` is added by a role
// pass that runs ONCE. At a fresh sign-in the pass runs after the mode is
// entered, so the buttons were hidden. At a session restore (every reload,
// including the silent update after every push) the pass runs BEFORE the mode
// is entered, and switching to Discipline and back rebuilt them after it, so
// on both paths every teacher, campus aide and PBIS lead saw Cash Settings and
// Sync PowerSchool. Cash Settings opened the whole Settings pane, including
// Add/Remove Behaviour, Reset All Student Cash and Close the Year, and none of
// those asked who was clicking.
//
// THE SHIPPED CODE RUNS: the real role passes (sign-in and restore, cut from
// script.js verbatim), the real switchSystemMode, updateTabVisibility,
// removeCashTabButtons and applyRoleGates, against a small fake DOM built from
// the real index.html. scripts/refresh-cap-teeth.mjs breaks each guard and
// requires its named check to fail.
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

function liftFn(name) {
  const m = new RegExp("\\n        (?:async )?function " + name + "\\(").exec(script);
  if (!m) throw new Error("missing function " + name);
  const start = m.index + 1;
  const end = script.indexOf("\n        }\n", start);
  return script.slice(start, end + 10);
}
function cut(from, to, after = 0) {
  const i = script.indexOf(from, after);
  const j = script.indexOf(to, i);
  if (i < 0 || j < 0) throw new Error("block not found: " + from);
  return script.slice(i, j);
}
// The two role passes, verbatim.
const SIGN_IN_PASS = (() => {
  const core = liftFn("establishTeacherSessionCore");
  const i = core.indexOf("if (typeof switchSystemMode === 'function') {");
  return core.slice(i, core.indexOf("// Colleagues' cash by name", i));
})();
const RESTORE_PASS = cut("// Show/hide tabs based on role", "// Update displays with fresh currentUser data",
  script.indexOf("} else if (hasSession) {"));

// ------------------------------------------------------------ a small DOM
const attrsOf = (s) => Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
function makeDom() {
  const all = [];
  const make = (tag, a, parent) => {
    const cls = new Set(String(a.class || "").split(/\s+/).filter(Boolean));
    const el = {
      tag, id: a.id || null, onclick: a.onclick || null, style: {}, children: [], parent: parent || null,
      innerHTML: "", value: "", textContent: "",
      classList: {
        add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)),
        contains: (c) => cls.has(c), toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; want ? cls.add(c) : cls.delete(c); },
      },
      getAttribute: (k) => (k === "onclick" ? el.onclick : k === "id" ? el.id : null),
      setAttribute() {},
      remove() {
        const i = all.indexOf(el); if (i >= 0) all.splice(i, 1);
        if (el.parent) { const j = el.parent.children.indexOf(el); if (j >= 0) el.parent.children.splice(j, 1); }
      },
      insertAdjacentHTML(_, h) {
        for (const m of h.matchAll(/<button([^>]*)>([^<]*)</g)) {
          const b = make("button", attrsOf(m[1]), el);
          b.textContent = m[2].trim();
          el.children.push(b); all.push(b);
        }
      },
      querySelectorAll: (sel) => {
        const out = [], walk = (n) => n.children.forEach((c) => { if (matches(c, sel)) out.push(c); walk(c); });
        walk(el); return out;
      },
      querySelector: () => null,
      _cls: cls,
    };
    return el;
  };
  const matches = (el, sel) => /^\.[\w-]+$/.test(sel) && el._cls.has(sel.slice(1));
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const a = attrsOf(m[2]);
    if (a.id || /\b(admin-only|super-admin-only)\b/.test(a.class || "")) all.push(make(m[1], a));
  }
  const body = make("body", {});
  const document = {
    body,
    getElementById: (id) => all.find((e) => e.id === id) || null,
    querySelector: () => null,
    querySelectorAll: (sel) => all.filter((e) => matches(e, sel)),
  };
  return { document, all };
}
/** What a person sees of a button: absent, hidden (.admin-only.disabled), or visible. */
const seen = (document, id) => {
  const b = document.getElementById(id);
  if (!b) return "absent";
  if (b._cls.has("disabled") && (b._cls.has("admin-only") || b._cls.has("super-admin-only"))) return "hidden";
  return "VISIBLE";
};

check("the ONLY thing that hides an admin-only button is .disabled (styles.css)",
  /\.admin-only\s*\{\s*\/\*[^*]*\*\/\s*\}/.test(css) && /\.admin-only\.disabled\s*\{\s*display:\s*none !important;/.test(css));

// ------------------------------------------------------------ a page
function makePage(role, src = script) {
  const lift = (n) => {
    const m = new RegExp("\\n        (?:async )?function " + n + "\\(").exec(src);
    if (!m) throw new Error("missing function " + n);
    const s = m.index + 1;
    return src.slice(s, src.indexOf("\n        }\n", s) + 10);
  };
  const { document } = makeDom();
  const log = { switchTab: [], alerts: [], saves: 0, rollover: 0, prompts: 0 };
  const body = `
    let currentUser = ${JSON.stringify({ id: "T1", name: "Pat", role })};
    const teacher = currentUser;
    let wildcatCashEnabled = false, disciplineModeEnabled = false;
    let students = [], nonEnrolledStudents = [], teachers = [], cashTransactions = [], cashReceipts = [];
    let rosterSource = null, _cashDrift = null;
    let wildcatCashBehaviors = [{ id: "wc1", name: "Be Present", points: 100, type: "positive", custom: true }];
    let STARTING_BALANCE = 2500;
    let _behaviorSaving = false;
    const DATA_SOURCE = 'convex';
    const localStorage = { setItem() {}, getItem() { return null; } };
    const window = { WildcatModes: { canOpenAcademics: () => false },
      WildcatStore: { buildYearEndRollover: () => { log.rollover++; throw new Error("ROLLOVER REACHED"); },
                      validateBehavior: () => ({ ok: false, errors: ["REACHED THE FORM"] }),
                      retireBehavior: (b) => Object.assign({}, b, { active: false }) } };
    const applyCashAnalyticsGate = () => {};
    const getSavedTeacherMode = () => 'cash';
    const allowedModeOrDefault = () => 'cash';
    const renderModeSubnav = () => {}, switchDisciplineTab = () => {}, populateReferringStaffDropdown = () => {};
    const switchHallPassTab = () => {}, updateSidebarModeUI = () => {}, switchAcademicsTab = () => {};
    const switchTab = (t) => { log.switchTab.push(t); };
    const switchSettingsSubtab = () => {};
    const showAlert = (m) => { log.alerts.push(String(m)); };
    const alert = (m) => { log.alerts.push(String(m)); };
    const showConfirm = async () => true;
    const showPrompt = async () => { log.prompts++; return 'START NEW YEAR'; };
    const showToast = () => {};
    const saveData = async () => { log.saves++; return true; };
    const saveBehaviorListTruthfully = async () => true;
    const closeAddBehaviorModal = () => {}, updateBehaviorsList = () => {};
    const fetchCashDrift = () => {};
    const escapeHtml = (s) => String(s);
    const noteHistoryCutoff = () => {}, beginCashLoad = () => ({}), endCashLoad = () => {}, commitRosterCash = () => {};
    const noteRosterLoaded = () => {}, reconcileCashLedger = () => {}, saveSession = () => {};
    const rescopeDisciplineForRole = async () => {};
    ${["canOpenSettings", "applyRoleGates", "updateTabVisibility", "removeCashTabButtons", "switchSystemMode",
       "updateModeToggleUI", "openCashSettings", "openSisSyncPanel", "behaviorEditsAllowed", "showAddBehaviorModal",
       "addNewBehavior", "deleteBehavior", "saveCashSettings", "startNewSchoolYear", "_startNewSchoolYear",
       "renderCashDriftPanel", "loadRosterFromConvex", "refreshRosterFromConvex"].map(lift).join("\n")}
    return {
      signIn() { ${SIGN_IN_PASS} },
      restore() { ${RESTORE_PASS} },
      switchSystemMode, openCashSettings, openSisSyncPanel, showAddBehaviorModal, addNewBehavior, deleteBehavior,
      saveCashSettings, startNewSchoolYear, renderCashDriftPanel, refreshRosterFromConvex,
      setDrift: (d) => { _cashDrift = d; },
      behaviors: () => wildcatCashBehaviors,
      get role() { return currentUser.role; },
    };
  `;
  const serverRole = { role };
  const fakeWindow = { WildcatAuth: { getSession: () => ({ idToken: "t" }),
    convexQuery: async () => ({ students: [], teachers: [{ id: "T1", name: "Pat", role: serverRole.role }], settings: {} }) } };
  const page = new Function("document", "log", "console", "WINDOW", body.replace("const window = {", "const window = Object.assign(WINDOW, {").replace(
    "retireBehavior: (b) => Object.assign({}, b, { active: false }) } };", "retireBehavior: (b) => Object.assign({}, b, { active: false }) } });"))(
    document, log, { log() {}, warn() {}, error() {} }, fakeWindow);
  return { page, document, log, serverRole };
}

const ROLES = ["teacher", "campusaide", "pbis", "admin", "superadmin"];
const an = (role) => (role === "admin" ? "an admin" : "a " + role);
const ADMINS = new Set(["admin", "superadmin"]);
const PATHS = {
  "a fresh sign-in": (p) => p.page.signIn(),
  "a reload (session restore)": (p) => p.page.restore(),
  "a reload, then Discipline and back to Cash": (p) => { p.page.restore(); p.page.switchSystemMode("discipline"); p.page.switchSystemMode("cash"); },
  "a sign-in, then Discipline and back to Cash": (p) => { p.page.signIn(); p.page.switchSystemMode("discipline"); p.page.switchSystemMode("cash"); },
  "a sign-in, then Hall Pass and back to Cash": (p) => { p.page.signIn(); p.page.switchSystemMode("hallpass"); p.page.switchSystemMode("cash"); },
};

console.log("\nA. THE TWO BUTTONS, ON EVERY PATH INTO CASH MODE\n");
for (const [path, go] of Object.entries(PATHS)) {
  for (const role of ROLES) {
    const p = makePage(role);
    go(p);
    const s = seen(p.document, "cashSettingsTabBtn"), y = seen(p.document, "cashSyncTabBtn");
    const want = ADMINS.has(role) ? "VISIBLE" : "hidden";
    const label = ADMINS.has(role)
      ? `${path}: ${an(role)} sees Cash Settings and Sync PowerSchool`
      : `${path}: a ${role} does NOT see Cash Settings or Sync PowerSchool`;
    check(label, s === want && y === want, `Cash Settings ${s}, Sync ${y}`);
  }
}
{
  const p = makePage("teacher");
  p.page.restore();
  check("...and the rest of the Cash nav is there for a teacher (nothing taken away)",
    ["awardCashTabBtn", "cashActivityTabBtn", "cashLeaderboardTabBtn", "rewardsStoreTabBtn", "receiptsTabBtn",
     "studentAccountsTabBtn", "cashAnalyticsTabBtn", "cashAuditTabBtn"].every((id) => seen(p.document, id) === "VISIBLE"));
  check("...and the static admin tabs stay hidden for them too (Settings, Students, Teachers)",
    ["settingsTab", "studentsTab", "teachersTab"].every((id) => seen(p.document, id) === "hidden"));
}

console.log("\nB. A ROLE CHANGED ON THE SERVER REACHES THE BUTTONS WITHOUT A SIGN-OUT\n");
{
  const p = makePage("admin");
  p.page.restore();
  check("an admin starts with Cash Settings", seen(p.document, "cashSettingsTabBtn") === "VISIBLE");
  p.serverRole.role = "teacher";
  await p.page.refreshRosterFromConvex("idle refresh", { redraw: false });
  check("A DEMOTED ADMIN LOSES CASH SETTINGS at the next roster refresh", p.page.role === "teacher" && seen(p.document, "cashSettingsTabBtn") === "hidden"
    && seen(p.document, "settingsTab") === "hidden", seen(p.document, "cashSettingsTabBtn"));
  p.serverRole.role = "superadmin";
  await p.page.refreshRosterFromConvex("idle refresh", { redraw: false });
  check("...and a promoted one gains it, and the super-admin-only tabs with it",
    seen(p.document, "cashSettingsTabBtn") === "VISIBLE" && seen(p.document, "systemTab") === "VISIBLE");
}

console.log("\nC. THE ACTIONS ASK FOR THEMSELVES\n");
for (const role of ROLES) {
  const admin = ADMINS.has(role);
  const p = makePage(role);
  p.page.restore();
  p.log.switchTab.length = 0;
  p.page.openCashSettings();
  p.page.openSisSyncPanel();
  check(admin ? `${an(role)} opens Cash Settings and the sync panel` : `a ${role} calling openCashSettings or openSisSyncPanel opens nothing`,
    admin ? p.log.switchTab.filter((t) => t === "settings").length === 2 : p.log.switchTab.length === 0, p.log.switchTab.join(","));

  const before = JSON.stringify(p.page.behaviors());
  const modal = p.document.getElementById("addBehaviorModal");
  modal.classList.add("hidden");
  p.page.showAddBehaviorModal();
  const opened = !modal.classList.contains("hidden");
  modal.classList.add("hidden");
  await p.page.addNewBehavior();
  await p.page.deleteBehavior("wc1");
  p.page.saveCashSettings();
  if (admin) {
    check(`${an(role)} may change the behaviour list and the cash settings`,
      opened && p.log.alerts.some((a) => /REACHED THE FORM/.test(a)) && p.page.behaviors()[0].active === false
        && p.log.saves === 1 && !p.log.alerts.some((a) => /Only an administrator/.test(a)), JSON.stringify(p.log));
  } else {
    check(`A ${role.toUpperCase()} CANNOT CHANGE BEHAVIOURS: add, remove and Save Settings refuse, and nothing is saved`,
      !opened && JSON.stringify(p.page.behaviors()) === before && p.log.saves === 0
        && p.log.alerts.length === 4 && p.log.alerts.every((a) => /Only an administrator/.test(a)), JSON.stringify(p.log.alerts));
  }

  p.log.alerts.length = 0;
  await p.page.startNewSchoolYear();
  check(admin ? `${an(role)} reaches the year-end rollover` : `A ${role.toUpperCase()} CANNOT CLOSE THE YEAR: refused before anything is worked out`,
    admin ? p.log.rollover === 1 : (p.log.rollover === 0 && /^The year was NOT closed\./.test(p.log.alerts[0] || "")
      && /Only an administrator/.test(p.log.alerts[0] || "")), p.log.alerts[0]);
}

console.log("\nD. SETTINGS ITSELF, AND THE DRIFT PANEL'S RE-CHECK\n");
{
  // switchTab's own door, run as shipped: past the gate, the first thing it does is remember the tab.
  const gate = (role, tab) => {
    const fn = new Function("currentUser", "console", `
      const PASSED = new Error("PASSED");
      const wcRememberTab = () => { throw PASSED; };
      ${liftFn("canOpenSettings")}
      ${liftFn("switchTab")}
      try { switchTab(${JSON.stringify(tab)}); return "stopped"; } catch (e) { return e === PASSED ? "opened" : "error: " + e.message; }
    `);
    return fn({ id: "T1", role }, { warn() {} });
  };
  for (const role of ROLES) {
    check(ADMINS.has(role) ? `switchTab('settings') opens for ${an(role)}` : `switchTab('settings') refuses a ${role}, before anything moves`,
      gate(role, "settings") === (ADMINS.has(role) ? "opened" : "stopped"), gate(role, "settings"));
  }
  check("...and every other tab still opens for a teacher", gate("teacher", "awardCash") === "opened" && gate("teacher", "cashAudit") === "opened");
}
for (const role of ROLES) {
  const p = makePage(role);
  p.page.setDrift({ ok: true, diverged: 1, heldBack: 0, at: "2026-10-16T09:00:00Z", rows: [{ studentId: "1", name: "A", difference: 100 }] });
  p.page.renderCashDriftPanel();
  const has = /Re-check now/.test(p.document.getElementById("cashDriftPanel").innerHTML);
  check(ADMINS.has(role) ? `the drift panel offers ${an(role)} Re-check now` : `the drift panel offers a ${role} no Re-check button (the server refuses it)`,
    has === ADMINS.has(role));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
