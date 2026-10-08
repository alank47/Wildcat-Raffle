// Close is for admin, superadmin and PBIS; a teacher's device holds only their
// own referrals. Run: npm test (node --experimental-strip-types).
//
// THE OWNER'S DECISION (2026-10-07), measured first: all 9 closed referrals in
// production were closed by an admin, none by a teacher, and none had its loop
// closed. So Close and Close-the-loop go to the three roles that see every
// referral, and teachers and campus aides see where their referral stands
// instead of a button. The server agrees: once its close guard is switched on,
// a teacher's close fields are kept out (convex/referralAccessRules.ts).
//
// THE DEVICE COPY. Every staff browser held the whole school's referrals in
// memory (readable from the developer console) and in localStorage 'raffleData'
// (which outlived sign-out and came back at the next page start for whoever sat
// down). The server now scopes its read behind a switch that starts OFF; the
// page cuts a teacher's copy to their own WHATEVER that switch says, stamps the
// cache with whose it is, and strips it at sign-out.
//
// SIGN-OUT (review, 2026-10-07). Emptying the record at sign-out must not throw
// away work the server never received, or leave the "not saved yet" bar naming
// a child on the login screen: unsent work is set aside for its author alone
// and comes back at that person's next sign-in. A read or a save still out at
// sign-out installs nothing, a demotion and a closed tab take the device copy
// down, and Student History is emptied with the rest.
//
// THE SHIPPED CODE RUNS. Each function is lifted out of script.js and run in a
// small world with the real wildcat-discipline.js; the two install steps
// (loadData's and loadDataLocal's) are cut out of script.js line for line and
// run the same way. Every "TEETH" check breaks the code on purpose and shows
// that an assertion notices.

process.env.TZ = "America/Los_Angeles";

import { readFileSync } from "node:fs";
import * as Server from "./convex/referralAccessRules.ts";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const discSrc = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

const J = (x) => JSON.stringify(x);
const loadD = (src) => { const sb = {}; new Function("globalThis", src).call(sb, sb); return sb.WildcatDiscipline; };
const D = loadD(discSrc);

/** A top-level function in script.js: eight spaces in, up to the first eight-space "}". */
function liftFn(src, name) {
  const m = new RegExp("\\n        (?:async )?function " + name + "\\(").exec(src);
  if (!m) throw new Error("missing function " + name);
  const start = m.index + 1;
  const end = src.indexOf("\n        }\n", start);
  if (end < 0) throw new Error("unterminated function " + name);
  return src.slice(start, end + 10);
}
/** A one-line top-level function or const. */
function liftLine(src, name) {
  const m = new RegExp("^        (?:function " + name + "\\(|const " + name + " = )[^\\n]*$", "m").exec(src);
  if (!m) throw new Error("missing line " + name);
  return m[0];
}
/** A multi-line const array, `const NAME = [` ... `];`. */
function liftArray(src, name) {
  const a = src.indexOf("        const " + name + " = [");
  if (a < 0) throw new Error("missing const " + name);
  return src.slice(a, src.indexOf("];", a) + 2);
}
/** Lines of script.js from one anchor through the end of the line holding another. */
function cut(src, fromAnchor, toAnchor) {
  const a = src.indexOf(fromAnchor);
  if (a < 0 || src.indexOf(fromAnchor, a + 1) >= 0) throw new Error("cut: start anchor not found exactly once: " + fromAnchor);
  const b = src.indexOf(toAnchor, a);
  if (b < 0) throw new Error("cut: end anchor not found: " + toAnchor);
  return src.slice(a, src.indexOf("\n", b));
}
function breakOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`teeth "${label}": anchor not found exactly once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}

function makeEl(id, els) {
  const cls = new Set();
  return {
    id, innerHTML: "", textContent: "", value: "",
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    querySelector: () => null,
    remove() { if (els) { delete els[id]; (els.__removed ||= []).push(id); } },
  };
}
function makeStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

const FNS = [
  "escapeHtml", "visibleReferrals", "referralsScopedToViewer", "cacheableReferrals", "shedReferralsNotMine",
  "referralCacheOwner", "localCacheIsMine", "disciplineCacheBlob", "canCloseReferralsHere", "refuseReferralClose",
  "showReferralToast", "updateReferralReviewTable", "updateClosedReferralsList", "openCloseReferralModal",
  "confirmCloseReferral", "createDetentionFromReferral", "openCloseLoopModal", "confirmCloseLoop",
  "closeModalById", "openRefModal", "viewReferralDetails", "cacheLocally", "stripDisciplineFromLocalCache",
  "clearSession", "renderRaceCard", "closeTeacherViewAtSignOut", "dropDisciplineCacheUnlessMine",
  "forgetDisciplineRecord", "renderPreviewBanner", "logout", "establishStudentSession", "reloadPreservingUnsavedWork",
  "serverOwnsReferralClose", "rescopeDisciplineForRole",
  // Review, 2026-10-07: unsent work at sign-out, late answers, the bar.
  "noteDisciplineOnServer", "unsentDisciplineNow", "describeUnsentDiscipline", "readUnsentDiscipline",
  "unsentDisciplineOf", "setAsideUnsentDiscipline", "restoreUnsentDiscipline",
  "putBackUnsentDiscipline", "clearSentFromUnsaved", "renderUnsavedReferralBar",
  "retryUnsavedReferrals", "pullReferralsOnce", "pullReferralsAndRedraw", "updateStudentReferralHistory",
  // Second review, 2026-10-07: what is kept, for how long, and when it goes.
  "writeUnsentDiscipline", "dropSetAside", "disciplineWriteLanded", "cutRestoredToRole",
  "submitBehaviorReferral", "markReferralUnsaved", "markReferralSaved",
];
const LINES = ["isPreviewingTeacher", "getOpenReferrals", "getClosedReferrals", "DETENTION_CLOSING_ACTION", "LOCAL_CACHE_AUDIT_MAX"];

/**
 * script.js's own functions closed over a small world. `G` holds the state a
 * test sets; the returned object exposes the functions and the live globals.
 */
function loadApp(src, G, Dmod) {
  const els = {};
  const document = {
    getElementById: (id) => els[id] || (els[id] = makeEl(id, els)),
    body: { classList: { add() {}, remove() {} }, appendChild() {} },
    createElement: () => makeEl("created", els),
    querySelector: (sel) => (sel === 'input[name="closeResolution"]:checked' ? { value: G.resolution || "action_taken" } : null),
    querySelectorAll: (sel) => (sel === ".closing-action:checked" ? (G.actions || []).map((v) => ({ value: v })) : []),
  };
  // From the comment above the restore, so a test may break the restore's first line.
  const restoreSnippet = cut(src, "// ONLY THE SAME PERSON'S COPY (2026-10-07).",
    "detentionIdCounter = data.detentionIdCounter || 1;");
  // The page's pagehide listener, line for line, so a test can fire it.
  const pagehideLine = (/^        window\.addEventListener\('pagehide', [^\n]*$/m.exec(src) || [""])[0];
  if (!pagehideLine) throw new Error("missing the pagehide listener");
  const installSnippet = cut(src, "                        const referralsData = referralsSnap.exists() ? referralsSnap.data() : {};",
    // Through the counter and the put-back of kept work that follow the
    // detentions install, so a test may break any of those lines.
    "detentionLocations = secondaryData.detentionLocations");
  const body = `
    const window = { WildcatDiscipline: Dm, WildcatAuth: G.auth || null,
      addEventListener: (type, fn) => { (G.listeners ||= {})[type] = fn; } };
    const console = { log() {}, warn() {}, error() {}, info() {} };
    const localStorage = G.localStorage;
    const sessionStorage = G.sessionStorage;
    let currentUser = G.currentUser || null;
    let realUser = G.realUser || null;
    let behaviorReferrals = G.referrals || [];
    let detentions = G.detentions || [];
    let students = G.students || [];
    let teachers = [];
    let detentionIdCounter = G.detentionIdCounter || 1;
    let referralIdCounter = 1;
    let detentionLocations = ['Main Office'];
    let inactivityTimer = null;
    let _referralPullAt = null;
    let previewRoster = G.realUser ? { sections: [] } : null;
    let previewRosterError = null;
    let currentStudent = null;
    let _sidebarModeApplied = true;
    let auditLog = [], cashTransactions = [];
    const auditIdsOnServer = new Set(), cashIdsOnServer = new Set();
    function ensureEntryId(e) { return e && e.id; }
    function wcForgetTab() {}
    async function showConfirm(message) { (G.confirms ||= []).push(message); return G.answers && G.answers.length ? G.answers.shift() : true; }
    function alert() {}
    function setButtonBusy() {}
    function clearReferralForm() {}
    function applyCashAnalyticsGate() {}
    function showStudentLogin() {}
    // loadData, as far as reloadPreservingUnsavedWork needs it: install what
    // the server sends the way loadData does (runServerInstall below).
    async function loadData() { runServerInstall(G.reloadSnap, G.reloadSecondary || {}); }
    // The two reads rescopeDisciplineForRole makes, against a fake server.
    async function loadLegacyDocsFromConvex(names) {
      (G.docReads ||= []).push(names.slice());
      // A read held open until the test lets it go, as a slow network holds it.
      if (G.docGate) await G.docGate;
      return G.docsFail ? { failed: names.slice(), docs: {} } : { docs: {
        secondary: { detentions: G.serverDetentions || [] },
        referrals: { behaviorReferrals: G.serverReferrals || [] },
      } };
    }
    // The real pull, for the tests that need it; the rest get the stub below.
    const realRefresh = (opts) => pullReferralsOnce(opts);
    async function refreshReferralsFromServer(opts) {
      if (G.realPull) return realRefresh(opts);
      G.pulls = (G.pulls || 0) + 1;
      const D = window.WildcatDiscipline;
      behaviorReferrals = D.mergeReferrals(behaviorReferrals, cacheableReferrals(G.serverReferrals || [])).referrals;
      return {};
    }
    const _unsavedReferrals = G.unsaved || new Map();
    const _unsavedCash = G.unsavedCash || new Map();
    const _disciplineOnServer = { referrals: new Map(), detentions: new Map() };
    let _restoredDiscipline = null;
    let _signInGeneration = 0;
    let _disciplineLoadedGeneration = -1;
    const UNSENT_DISCIPLINE_KEY = 'wcUnsentDiscipline';
    async function flushSaves() { (G.flushes ||= []).push(1); return G.flushResult === undefined ? null : G.flushResult; }
    async function requestSave(label) {
      (G.requests ||= []).push(label);
      // A save held open until the test lets it go, as a slow network holds it.
      if (G.saveGate) return G.saveGate;
      return G.requestResult === undefined ? true : G.requestResult;
    }
    function allCashOnServer() { return true; }
    function _fmtPullTime() { return 'now'; }
    function redrawReferralInsightViews() { G.redraws = (G.redraws || 0) + 1; }
    function showToast(message, kind) { G.toasts.push({ message, kind }); }
    function saveInBackground(label) { G.saves.push(label); }
    function updateDetentionLists() {}
    function toggleDetentionDays() {}
    function appendRaceVerification() {}   // admin-only extra, drawn after the card
    ${liftArray(src, "REFERRAL_CLOSING_ACTIONS")}
    ${LINES.map((n) => liftLine(src, n)).join("\n")}
    ${FNS.map((n) => liftFn(src, n)).join("\n")}
    function runLocalRestore(data) {
${restoreSnippet}
    }
    function runServerInstall(referralsSnap, secondaryData) {
${installSnippet}
    }
${pagehideLine}
    return {
      ${FNS.join(", ")}, runLocalRestore, runServerInstall, isPreviewingTeacher,
      get referrals() { return behaviorReferrals; },
      set referrals(v) { behaviorReferrals = v; },
      get detentions() { return detentions; },
      get realUser() { return realUser; },
      get previewRoster() { return previewRoster; },
      set currentUser(v) { currentUser = v; },
      get unsaved() { return _unsavedReferrals; },
      get restored() { return _restoredDiscipline; },
      get detentionIdCounter() { return detentionIdCounter; },
      onServer: _disciplineOnServer,
    };`;
  G.toasts = []; G.saves = [];
  const app = new Function("G", "Dm", "document", body)(G, Dmod || D, document);
  app.els = els;
  app.G = G;
  return app;
}

// ---------------------------------------------------------------- the world

const TEACHER = { id: "t1", role: "teacher", email: "T.Teacher@x.org", name: "T Teacher" };
const AIDE = { id: "c1", role: "campusaide", email: "aide@x.org", name: "C Aide" };
const ADMIN = { id: "a1", role: "admin", email: "admin@x.org", name: "A Admin" };
const PBIS = { id: "p1", role: "pbis", email: "pbis@x.org", name: "P Lead" };
const SUPER = { id: "s1", role: "superadmin", email: "super@x.org", name: "S Super" };

const ref = (id, over) => Object.assign({
  id, studentId: "S1", studentName: "Student " + id, school: "High School", studentGrade: "9",
  behavior: "Defiance", location: "Hallway", date: "2026-10-05", submittedAt: "2026-10-05T21:10:00.000Z",
  status: "open", filedByEmail: "t.teacher@x.org", referredByEmail: "t.teacher@x.org", referredBy: "T Teacher",
  closingActions: [], adminNotes: "", closedBy: "", closedAt: "", loopClosed: false,
}, over);
const theirs = (id, over) => ref(id, Object.assign({ filedByEmail: "other@x.org", referredByEmail: "other@x.org", referredBy: "O Other" }, over));

const REFS = () => [
  ref("MINE-OPEN"),
  ref("MINE-CLOSED", { status: "closed", closedBy: "A Admin", closedAt: "2026-10-06T17:00:00.000Z" }),
  theirs("THEIRS-OPEN"),
  theirs("THEIRS-CLOSED", { status: "closed", closedBy: "A Admin", closedAt: "2026-10-06T17:00:00.000Z" }),
];
const world = (user, over) => Object.assign({
  currentUser: user, referrals: REFS(), detentions: [],
  students: [{ id: "S1", grade: "9" }],
  localStorage: makeStorage(), sessionStorage: makeStorage(),
}, over);

// ---------------------------------------------------------------- the rule

console.log("\n-- who may close: the page and the server agree --");
{
  for (const role of ["teacher", "campusaide", "pbis", "admin", "superadmin", "PBIS", "", "custodian"]) {
    check(`canCloseReferrals("${role}") matches the server's rule`, D.canCloseReferrals(role) === Server.canCloseReferrals(role));
  }
  check("the server's closers are the page's DISCIPLINE_ALL_ROLES",
    [...Server.REFERRAL_CLOSE_ROLES].join() === D.DISCIPLINE_ALL_ROLES.join());
  check("the close fields a teacher's pull takes from the server are the server guard's CLOSE_FIELDS",
    [...Server.CLOSE_FIELDS].join() === D.REFERRAL_CLOSE_FIELDS.join());
}

// ---------------------------------------------------------------- the buttons

const openHtml = (src, user) => { const a = loadApp(src, world(user)); a.updateReferralReviewTable(); return a.els.referralReviewTable.innerHTML; };
const closedHtml = (src, user) => { const a = loadApp(src, world(user)); a.updateClosedReferralsList(); return a.els.closedReferralsList.innerHTML; };
const detailHtml = (src, user, id) => { const a = loadApp(src, world(user)); a.viewReferralDetails(id); return a.els.referralDetailBody.innerHTML; };

console.log("\n-- a teacher and a campus aide see where it stands, not a Close button --");
for (const [label, user] of [["teacher", TEACHER], ["campus aide", { ...AIDE, email: "t.teacher@x.org" }]]) {
  const open = openHtml(script, user);
  check(`${label}: their open referral is listed`, open.includes("Student MINE-OPEN") && !open.includes("THEIRS"));
  check(`${label}: no Close button on Open Referrals`, !open.includes("openCloseReferralModal"));
  check(`${label}: 'Awaiting an administrator' instead`, open.includes("Awaiting an administrator"));
  const closed = closedHtml(script, user);
  check(`${label}: no 'close the loop' button on Closed Referrals`, !closed.includes("openCloseLoopModal"));
  check(`${label}: 'Loop pending' instead`, closed.includes("Loop pending"));
  const detail = detailHtml(script, user, "MINE-OPEN");
  check(`${label}: the detail view offers no 'Close this referral'`, !detail.includes("Close this referral"));
}

console.log("\n-- the hint above Open Referrals says what this person can do (review) --");
{
  const hintFor = (src, user, refs) => {
    const a = loadApp(src, world(user, refs ? { referrals: refs } : {}));
    a.updateReferralReviewTable();
    return a.els.openReferralsHint.textContent;
  };
  for (const [label, user] of [["teacher", TEACHER], ["campus aide", AIDE]]) {
    const h = hintFor(script, user);
    check(`${label}: the hint does not promise Close or "close the loop"`, !/Closing one|close the loop/i.test(h), h);
    check(`${label}: it says who closes them`, /administrator or the PBIS team/.test(h));
    check(`${label}: the same with no open referrals`, !/close the loop/i.test(hintFor(script, user, [])));
  }
  for (const [label, user] of [["admin", ADMIN], ["PBIS", PBIS]]) {
    check(`${label}: the hint still explains Close and the loop`, /Closing one records the resolution/.test(hintFor(script, user)));
  }
  check("index.html gives the hint the id the table draws into", /<p class="panel-hint" id="openReferralsHint"/.test(html));
  const fixed = breakOnce(script, "                hint.textContent = mayClose\n", "                hint.textContent = true\n", "hint");
  check("TEETH: one hint for everyone promises a teacher the loop again", /close the loop/.test(hintFor(fixed, TEACHER)));
}

console.log("\n-- admin, superadmin and PBIS keep every button --");
for (const [label, user] of [["admin", ADMIN], ["superadmin", SUPER], ["PBIS", PBIS]]) {
  const open = openHtml(script, user);
  check(`${label}: Close on every open referral`, (open.match(/openCloseReferralModal\('/g) || []).length === 2);
  const closed = closedHtml(script, user);
  check(`${label}: 'Loop pending, close it' on every closed referral`, (closed.match(/openCloseLoopModal\('/g) || []).length === 2);
  check(`${label}: the detail view offers 'Close this referral'`, detailHtml(script, user, "THEIRS-OPEN").includes("Close this referral"));
}

console.log("\n-- an admin looking through a teacher's eyes sees the teacher's screen --");
{
  const a = loadApp(script, world({ ...TEACHER }, { realUser: ADMIN }));
  a.updateReferralReviewTable();
  check("teacher preview: no Close button", !a.els.referralReviewTable.innerHTML.includes("openCloseReferralModal"));
}

// ---------------------------------------------------------------- the four entry points

console.log("\n-- a close reached any other way does nothing for a teacher --");
{
  const N = "Notified parents/guardians promptly";
  const G0 = world(TEACHER, { actions: [N] });
  let a = loadApp(script, G0);
  a.openCloseReferralModal("MINE-OPEN");
  check("openCloseReferralModal: no modal body drawn", a.els.closeReferralBody === undefined || a.els.closeReferralBody.innerHTML === "");
  check("...and the teacher is told who closes referrals",
    G0.toasts.length === 1 && /administrator or the PBIS team/.test(G0.toasts[0].message));
  a = loadApp(script, world(TEACHER, { actions: [N] }));
  await a.confirmCloseReferral("MINE-OPEN");
  const r = a.referrals.find((x) => x.id === "MINE-OPEN");
  check("confirmCloseReferral as a teacher leaves the referral open", r.status === "open");
  check("...with no close fields written", r.closedBy === "" && r.closedAt === "" && r.adminNotes === "" && r.closingActions.length === 0);

  a = loadApp(script, world(TEACHER));
  a.openCloseLoopModal("MINE-CLOSED");
  check("openCloseLoopModal: no modal body drawn", a.els.closeLoopBody === undefined || a.els.closeLoopBody.innerHTML === "");
  a = loadApp(script, world(TEACHER));
  await a.confirmCloseLoop("MINE-CLOSED");
  check("confirmCloseLoop as a teacher leaves the loop open",
    a.referrals.find((x) => x.id === "MINE-CLOSED").loopClosed === false);

  const G = world(TEACHER, { actions: [N] });
  const b = loadApp(script, G);
  await b.confirmCloseReferral("MINE-OPEN");
  check("a refused close says why, as a warning", G.toasts.length === 1 && G.toasts[0].kind === "warning"
    && /administrator or the PBIS team/.test(G.toasts[0].message), JSON.stringify(G.toasts));
  check("and saves nothing", G.saves.length === 0);
}

console.log("\n-- an admin's close and loop close still land --");
{
  const N = "Notified parents/guardians promptly";
  const G = world(ADMIN, { actions: [N] });
  const a = loadApp(script, G);
  a.openCloseReferralModal("THEIRS-OPEN");
  check("the close modal opens for an admin", /confirmCloseReferral\('THEIRS-OPEN'\)/.test(a.els.closeReferralBody.innerHTML));
  await a.confirmCloseReferral("THEIRS-OPEN");
  const r = a.referrals.find((x) => x.id === "THEIRS-OPEN");
  check("confirmCloseReferral as an admin closes it", r.status === "closed" && r.closedBy === "A Admin" && r.closingActions[0] === N);
  check("...and saves", G.saves.length === 1);
  await a.confirmCloseLoop("THEIRS-CLOSED");
  check("confirmCloseLoop as an admin closes the loop", a.referrals.find((x) => x.id === "THEIRS-CLOSED").loopClosed === true);
  const P = loadApp(script, world(PBIS, { actions: [N] }));
  await P.confirmCloseReferral("THEIRS-OPEN");
  check("PBIS closes too", P.referrals.find((x) => x.id === "THEIRS-OPEN").status === "closed");
}

// ---------------------------------------------------------------- one detention per referral

console.log("\n-- one active detention per referral --");
{
  const DET = "Assigned the student to mandatory detention";
  const prior = { id: "detention_9", sourceReferralId: "THEIRS-OPEN", status: "active", studentId: "S1" };
  let G = world(ADMIN, { actions: [DET], detentions: [prior] });
  let a = loadApp(script, G);
  await a.confirmCloseReferral("THEIRS-OPEN");
  check("an admin's close with the detention action does not add a second one",
    a.detentions.filter((d) => d.sourceReferralId === "THEIRS-OPEN").length === 1);
  check("...the referral still closes", a.referrals.find((x) => x.id === "THEIRS-OPEN").status === "closed");
  check("...and the admin is told why there is no new one", /already has an active detention/.test(G.toasts[0].message));

  G = world(ADMIN, { actions: [DET], detentions: [{ ...prior, status: "completed" }] });
  a = loadApp(script, G);
  await a.confirmCloseReferral("THEIRS-OPEN");
  check("a COMPLETED detention does not block a new one",
    a.detentions.filter((d) => d.sourceReferralId === "THEIRS-OPEN").length === 2);

  G = world(ADMIN, { actions: [DET], detentions: [{ ...prior, sourceReferralId: "SOMETHING-ELSE" }] });
  a = loadApp(script, G);
  await a.confirmCloseReferral("THEIRS-OPEN");
  check("another referral's detention does not block this one",
    a.detentions.filter((d) => d.sourceReferralId === "THEIRS-OPEN").length === 1);
  check("activeDetentionFor: null for no id or no list",
    D.activeDetentionFor([prior], "") === null && D.activeDetentionFor(null, "THEIRS-OPEN") === null);
}

// ---------------------------------------------------------------- the device copy

console.log("\n-- loadData's install: a teacher keeps their own, whatever the server sent --");
{
  const snap = (rows) => ({ exists: () => true, data: () => ({ behaviorReferrals: rows }) });
  const DETS = [{ id: "detention_1", sourceReferralId: "THEIRS-OPEN", status: "active" }];
  let a = loadApp(script, world(TEACHER));
  a.runServerInstall(snap(REFS()), { detentions: DETS });
  check("teacher, switch OFF (server sent all four): only their two are held",
    a.referrals.map((r) => r.id).sort().join() === "MINE-CLOSED,MINE-OPEN", a.referrals.map((r) => r.id).join());
  check("...and no detentions", a.detentions.length === 0);

  a = loadApp(script, world(TEACHER, { unsaved: new Map([["UNSAVED-1", {}]]) }));
  a.runServerInstall(snap([...REFS(), ref("UNSAVED-1", { filedByEmail: "", referredByEmail: "", referredBy: "" })]), { detentions: [] });
  check("a referral this tab has not finished saving is kept", a.referrals.some((r) => r.id === "UNSAVED-1"));

  for (const [label, user] of [["admin", ADMIN], ["PBIS", PBIS], ["superadmin", SUPER]]) {
    a = loadApp(script, world(user));
    a.runServerInstall(snap(REFS()), { detentions: DETS });
    check(`${label}: all four held, and the detentions`, a.referrals.length === 4 && a.detentions.length === 1);
  }
  a = loadApp(script, world(null));
  a.runServerInstall(snap(REFS()), { detentions: DETS });
  check("nobody signed in yet: kept as served (the sign-in scopes it)", a.referrals.length === 4);
  a.currentUser = TEACHER;
  a.shedReferralsNotMine();
  check("...and the sign-in sheds what the teacher may not hold",
    a.referrals.length === 2 && a.detentions.length === 0);
  a = loadApp(script, world({ ...TEACHER }, { realUser: ADMIN }));
  a.runServerInstall(snap(REFS()), { detentions: DETS });
  check("an admin previewing a teacher keeps the admin's list", a.referrals.length === 4 && a.detentions.length === 1);
}

console.log("\n-- establishTeacherSessionCore sheds before it saves --");
{
  const fn = liftFn(script, "establishTeacherSessionCore");
  check("the shed comes right after currentUser is set and before the save",
    fn.indexOf("currentUser = teacher;") < fn.indexOf("shedReferralsNotMine();")
    && fn.indexOf("shedReferralsNotMine();") < fn.indexOf("await saveData();"));
}

console.log("\n-- the local cache: cut, stamped, and only ever the same person's --");
{
  const blobOf = (G) => JSON.parse(G.localStorage.getItem("raffleData"));
  const DETS = [{ id: "detention_1", status: "active" }];
  let G = world(TEACHER, { detentions: DETS });
  let a = loadApp(script, G);
  a.cacheLocally({ behaviorReferrals: REFS(), detentions: DETS, cashTransactions: [{ id: "c1" }], auditLog: [] });
  let b = blobOf(G);
  check("a teacher's cache holds only their own referrals",
    b.behaviorReferrals.map((r) => r.id).sort().join() === "MINE-CLOSED,MINE-OPEN");
  check("...no detentions", Array.isArray(b.detentions) && b.detentions.length === 0);
  check("...stamped with their email, normalised", b.referralsOwner === "t.teacher@x.org");
  check("...and everything else as given", b.cashTransactions.length === 1);

  G = world(ADMIN);
  a = loadApp(script, G);
  a.cacheLocally({ behaviorReferrals: REFS(), detentions: DETS, auditLog: [] });
  b = blobOf(G);
  check("an admin's cache holds every referral and the detentions, stamped",
    b.behaviorReferrals.length === 4 && b.detentions.length === 1 && b.referralsOwner === "admin@x.org");

  G = world(null);
  a = loadApp(script, G);
  a.cacheLocally({ behaviorReferrals: REFS(), detentions: DETS, auditLog: [] });
  b = blobOf(G);
  check("nobody signed in: the cache holds no referrals or detentions",
    b.behaviorReferrals.length === 0 && b.detentions.length === 0 && b.referralsOwner === "");

  G = world({ ...TEACHER }, { realUser: ADMIN });
  a = loadApp(script, G);
  a.cacheLocally({ behaviorReferrals: REFS(), detentions: DETS, auditLog: [] });
  b = blobOf(G);
  check("during a teacher preview the stamp is the admin's, not the teacher's", b.referralsOwner === "admin@x.org");
}

console.log("\n-- loadDataLocal's restore: only the same person's copy --");
{
  const cached = (owner) => ({ referralsOwner: owner, behaviorReferrals: REFS(), detentions: [{ id: "detention_1" }] });
  let a = loadApp(script, world(null));
  a.runLocalRestore(cached("admin@x.org"));
  check("page start, nobody signed in: nothing restored", a.referrals.length === 0 && a.detentions.length === 0);

  a = loadApp(script, world(TEACHER));
  a.runLocalRestore(cached("admin@x.org"));
  check("a teacher on a device an admin used: the admin's copy is not restored",
    a.referrals.length === 0 && a.detentions.length === 0);

  a = loadApp(script, world(TEACHER));
  a.runLocalRestore(cached(" T.TEACHER@x.org "));
  check("the teacher's own copy is restored (stamp compared normalised), cut to their own",
    a.referrals.map((r) => r.id).sort().join() === "MINE-CLOSED,MINE-OPEN" && a.detentions.length === 0);

  a = loadApp(script, world(ADMIN));
  a.runLocalRestore(cached("admin@x.org"));
  check("an admin's own copy is restored whole", a.referrals.length === 4 && a.detentions.length === 1);

  a = loadApp(script, world(ADMIN));
  a.runLocalRestore({ behaviorReferrals: REFS(), detentions: [{ id: "d" }] });
  check("a cache from before the stamp restores nothing", a.referrals.length === 0 && a.detentions.length === 0);
  // The first page load on every device after this build: nobody signed in,
  // and a cache written by the old build with no stamp at all.
  a = loadApp(script, world(null));
  a.runLocalRestore({ behaviorReferrals: REFS(), detentions: [{ id: "detention_1" }] });
  check("page start, nobody signed in, a cache from before the stamp: nothing restored",
    a.referrals.length === 0 && a.detentions.length === 0);

  a = loadApp(script, world(null, { auth: { getSession: () => ({ me: { kind: "staff", email: "Admin@x.org" } }) } }));
  a.runLocalRestore(cached("admin@x.org"));
  check("before currentUser is set, the Microsoft session's staff email counts", a.referrals.length === 4);
  a = loadApp(script, world(null, { auth: { getSession: () => ({ me: { kind: "student", email: "admin@x.org" } }) } }));
  a.runLocalRestore(cached("admin@x.org"));
  check("...but a student session never does", a.referrals.length === 0);
}

console.log("\n-- signing out takes the discipline record off the device --");
{
  const G = world(TEACHER, {
    localStorage: makeStorage({ raffleData: JSON.stringify({ behaviorReferrals: REFS(), detentions: [{ id: "d" }], referralsOwner: "admin@x.org", cashTransactions: [{ id: "c1" }], students: [] }) }),
    sessionStorage: makeStorage({ currentUser: "{}", lastActivity: "1" }),
  });
  const a = loadApp(script, G);
  a.clearSession();
  const b = JSON.parse(G.localStorage.getItem("raffleData"));
  check("clearSession removes the referrals, the detentions and the stamp",
    !("behaviorReferrals" in b) && !("detentions" in b) && !("referralsOwner" in b));
  check("...and keeps the rest (unsaved cash is recovered from this blob)", b.cashTransactions.length === 1);
  check("...and still clears the session", G.sessionStorage.getItem("currentUser") === null);
  check("logout goes through clearSession", /clearSession\(\); \/\/ Clear saved session/.test(liftFn(script, "logout")));
  const bad = loadApp(script, world(TEACHER, { localStorage: makeStorage({ raffleData: "{not json" }) }));
  let threw = false;
  try { bad.clearSession(); } catch (e) { threw = true; }
  check("a corrupt cache does not stop a sign-out", !threw);
}

// ---------------------------------------------------------------- review, 2026-10-07

const DETS1 = () => [{ id: "detention_1", sourceReferralId: "THEIRS-OPEN", status: "active" }];
const adminCache = (extra) => JSON.stringify(Object.assign({ referralsOwner: "admin@x.org", behaviorReferrals: REFS(),
  detentions: DETS1(), cashTransactions: [{ id: "c1" }], students: [] }, extra));
const blobIn = (G) => JSON.parse(G.localStorage.getItem("raffleData"));
// Every screen forgetDisciplineRecord empties, listed here by hand rather than
// read from it, so dropping one from the function is caught (review: the
// behaviour breakdown, referralBehaviors, was missing and nothing noticed).
const SCREENS = ["referralReviewTable", "closedReferralsList", "referralDetailBody", "studentReferralHistoryBody",
  "referralTrend", "referralBehaviors", "referralDemographics", "referralClosedAnalytics", "activeDetentionsList",
  "completedDetentionsList"];
// Student History's four tiles (Total / Open / Closed / Loop closed, under the
// old severity ids) and what shows them.
const HISTORY_TILES = ["summaryTotal", "summaryMinor", "summaryMajor", "summarySevere"];
const HISTORY_SHOWN = ["studentReferralSummary", "studentReferralHistoryContainer"];
/** An admin's tab with the whole school drawn, as the inactivity logout finds it. */
function drawnAdminTab(src, over) {
  const G = world(ADMIN, Object.assign({ detentions: DETS1() }, over));
  const a = loadApp(src, G);
  SCREENS.forEach((id) => { document_el(a, id).innerHTML = "<td>Student THEIRS-OPEN</td>"; });
  document_el(a, "openReferralCount").textContent = "2";
  // Student History, a child picked: drawn by the real code.
  document_el(a, "historyStudentSelect").value = "S1";
  HISTORY_SHOWN.forEach((id) => document_el(a, id).classList.add("hidden"));
  a.updateStudentReferralHistory();
  return { G, a };
}
function document_el(a, id) { return a.els[id] || (a.els[id] = makeEl(id, a.els)); }

console.log("\n-- logout empties the discipline record from memory and from the screens --");
{
  const { a } = drawnAdminTab(script);
  await a.logout({ inactive: true });
  check("after the inactivity logout the tab holds no referrals", a.referrals.length === 0);
  check("...and no detentions", a.detentions.length === 0);
  check("...and every referral and detention screen is emptied",
    SCREENS.every((id) => !a.els[id] || a.els[id].innerHTML === ""), SCREENS.filter((id) => a.els[id] && a.els[id].innerHTML).join());
  check("...and the counts with them", a.els.openReferralCount.textContent === "");
}

console.log("\n-- logout empties Student History too (review) --");
{
  const { a } = drawnAdminTab(script);
  check("before: Student History shows the picked child's tiles (the drawing ran)",
    a.els.summaryTotal.textContent === 4 && HISTORY_SHOWN.every((id) => !a.els[id].classList.contains("hidden")));
  await a.logout({ inactive: true });
  check("after the logout the four tiles are empty", HISTORY_TILES.every((id) => a.els[id].textContent === ""),
    HISTORY_TILES.map((id) => id + "=" + a.els[id].textContent).join());
  check("...the tiles and the table are hidden", HISTORY_SHOWN.every((id) => a.els[id].classList.contains("hidden")));
  check("...and no child is picked", a.els.historyStudentSelect.value === "");
}

// ---------------------------------------------------------------- unsent work at sign-out (review, 2026-10-07)
//
// Sign-out empties the discipline record (above). Done bluntly it also threw
// away work the server never received, and left the "not saved yet" bar on the
// login screen naming the child. Unsent work is set aside for the person who
// made it, under its own key, and comes back only at that person's sign-in.

const UNSENT = "wcUnsentDiscipline";
const keptOn = (G) => JSON.parse(G.localStorage.getItem(UNSENT) || "null");
const ids = (rows) => (rows || []).map((r) => r.id).sort().join();
/** A teacher's tab as a failed save leaves it: their referrals loaded, one filed and not saved. */
function teacherWithUnsaved(over) {
  const R = ref("UNSAVED-NEW");
  const G = world(TEACHER, Object.assign({ unsaved: new Map([[R.id, R]]) }, over));
  const a = loadApp(script, G);
  a.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: REFS() }) }, {});
  a.referrals.push(R);                 // submitReferral pushes, then marks it unsaved
  a.renderUnsavedReferralBar();
  return { G, a, R };
}

console.log("\n-- a teacher's unsaved referral survives sign-out, for that teacher only (review) --");
{
  const { G, a, R } = teacherWithUnsaved();
  check("before: the bar names the child", a.els.unsavedReferralBar.hidden === false
    && /Student UNSAVED-NEW/.test(a.els.unsavedReferralText.textContent));
  await a.logout({ inactive: true });
  check("after the inactivity logout the bar is gone from the login screen", a.els.unsavedReferralBar.hidden === true);
  check("...the list behind it is empty", a.unsaved.size === 0);
  check("...and memory holds no referrals", a.referrals.length === 0);
  const kept = keptOn(G);
  check("the referral is kept on the device under the teacher's email", ids(kept?.["t.teacher@x.org"]?.referrals) === "UNSAVED-NEW"
    && J(kept["t.teacher@x.org"].unsavedIds) === J(["UNSAVED-NEW"]));
  check("...and nothing the server already holds is kept with it", !!kept && Object.keys(kept).length === 1
    && kept["t.teacher@x.org"]?.referrals.length === 1 && kept["t.teacher@x.org"]?.detentions.length === 0);

  // The app signs back in without a reload: establishTeacherSessionCore sheds,
  // then brings back, then saves.
  a.currentUser = TEACHER;
  a.shedReferralsNotMine();
  check("the same teacher signs in: it comes back", a.restoreUnsentDiscipline() === 1
    && a.referrals.some((r) => r.id === "UNSAVED-NEW"));
  check("...back on the bar, so they know it is still not on the server", a.unsaved.has("UNSAVED-NEW")
    && a.els.unsavedReferralBar.hidden === false);
  // The save: put back, send, and on landing clear only what was sent.
  a.putBackUnsentDiscipline();
  const refSent = JSON.parse(J(a.referrals));
  const sent = new Set(refSent.map((r) => r.id));
  check("the sign-in save sends it", sent.has("UNSAVED-NEW"));
  a.disciplineWriteLanded("referrals", refSent, "t.teacher@x.org", 0);
  a.clearSentFromUnsaved(new Set(a.unsaved.keys()), sent);
  check("once it lands, the bar lets it go", a.unsaved.size === 0);
  check("...and so does the device", G.localStorage.getItem(UNSENT) === null && a.restored === null);
}

console.log("\n-- ...and the web sign-in, which reloads the page (review) --");
{
  const { G, a } = teacherWithUnsaved();
  await a.logout({ inactive: true });
  // A new page on the same browser: only localStorage carries over.
  const b = loadApp(script, world(null, { localStorage: G.localStorage }));
  b.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: REFS() }) }, {});
  b.currentUser = TEACHER;
  b.shedReferralsNotMine();
  b.restoreUnsentDiscipline();
  check("after the reload the same teacher's sign-in brings it back", b.referrals.some((r) => r.id === "UNSAVED-NEW"));
  // The sign-in's own full load can land after that, replacing the list.
  // It puts the kept work straight back and asks for a save to send it
  // (second review, 2026-10-07); before, the next save did the putting back.
  b.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: REFS() }) }, {});
  check("a load that lands afterwards leaves it in the list", b.referrals.some((r) => r.id === "UNSAVED-NEW"));
  b.putBackUnsentDiscipline();
  check("...and the save still sends it, once", b.referrals.filter((r) => r.id === "UNSAVED-NEW").length === 1);
}

console.log("\n-- the bar never lists a referral no save will send (review) --");
{
  // A load replaced the list while a referral was still unsaved (no sign-out
  // involved): it left the list and stayed on the bar, so no save could send
  // it and the bar could never clear.
  const { a } = teacherWithUnsaved();
  a.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: REFS() }) }, {});
  check("before: on the bar, not in the list", a.unsaved.has("UNSAVED-NEW") && !a.referrals.some((r) => r.id === "UNSAVED-NEW"));
  a.putBackUnsentDiscipline();
  check("the save's first step puts it back in the list it sends", a.referrals.some((r) => r.id === "UNSAVED-NEW"));
  const once = a.referrals.length;
  a.putBackUnsentDiscipline();
  check("...once", a.referrals.length === once);
}

console.log("\n-- nobody else gets it (review) --");
{
  const { G, a } = teacherWithUnsaved();
  await a.logout({ inactive: true });
  const OTHER = { id: "t2", role: "teacher", email: "other@x.org", name: "O Other" };
  a.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: REFS() }) }, {});
  a.currentUser = OTHER;
  a.shedReferralsNotMine();
  check("another teacher signing in on the tab brings back nothing", a.restoreUnsentDiscipline() === 0
    && !a.referrals.some((r) => r.id === "UNSAVED-NEW") && a.unsaved.size === 0);
  a.putBackUnsentDiscipline();
  check("...their save does not carry it", !a.referrals.some((r) => r.id === "UNSAVED-NEW"));
  check("...and it stays kept for its author", ids(keptOn(G)?.["t.teacher@x.org"]?.referrals) === "UNSAVED-NEW");
  // The second half of the old leak: had the save in fact landed, the next
  // teacher's tab was served it and kept it because its id was still listed.
  a.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: [...REFS(), ref("UNSAVED-NEW")] }) }, {});
  a.cacheLocally({ behaviorReferrals: a.referrals, detentions: [], auditLog: [] });
  const blob = JSON.parse(G.localStorage.getItem("raffleData"));
  check("served to the next teacher, it is not kept in their memory or their device cache",
    !a.referrals.some((r) => r.id === "UNSAVED-NEW") && !blob.behaviorReferrals.some((r) => r.id === "UNSAVED-NEW"));
}

console.log("\n-- a student's sign-in takes the bar and its list too (review) --");
{
  const { a } = teacherWithUnsaved();
  a.currentUser = null;
  a.establishStudentSession({ id: "S1" });
  check("the bar is hidden and its list empty", a.els.unsavedReferralBar.hidden === true && a.unsaved.size === 0);
}

console.log("\n-- an admin's unsent Close and its detention survive sign-out; the school does not (review) --");
{
  const G = world(ADMIN, { actions: ["Assigned the student to mandatory detention"], detentionIdCounter: 2 });
  const a = loadApp(script, G);
  a.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: REFS() }) }, { detentions: DETS1() });
  await a.confirmCloseReferral("MINE-OPEN");       // closes it, and makes detention_2 for it
  check("before: the close and a new detention exist only in this tab",
    a.referrals.find((r) => r.id === "MINE-OPEN").status === "closed" && a.detentions.length === 2);
  await a.logout({ inactive: true });
  const kept = keptOn(G) && keptOn(G)["admin@x.org"];
  check("kept for the admin: exactly the closed referral and the new detention",
    kept && ids(kept.referrals) === "MINE-OPEN" && kept.referrals[0].status === "closed"
    && kept.detentions.length === 1 && kept.detentions[0].sourceReferralId === "MINE-OPEN");
  check("...and none of the other three referrals or the old detention",
    kept && !kept.referrals.some((r) => r.id !== "MINE-OPEN") && !kept.detentions.some((d) => d.id === "detention_1"));

  // The admin's next sign-in, on a fresh page: the server never got the close.
  const b = loadApp(script, world(null, { localStorage: G.localStorage }));
  b.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: REFS() }) }, { detentions: DETS1() });
  b.currentUser = ADMIN;
  b.restoreUnsentDiscipline();
  check("the same admin signs in: the close is back", b.referrals.find((r) => r.id === "MINE-OPEN").status === "closed");
  check("...and the detention", b.detentions.some((d) => d.sourceReferralId === "MINE-OPEN") && b.detentions.length === 2);
  const once = J(b.referrals) + J(b.detentions);
  b.putBackUnsentDiscipline();
  check("putting it back again changes nothing (every save does it until one lands)", J(b.referrals) + J(b.detentions) === once);
}

console.log("\n-- an admin with nothing unsent keeps nothing on the device (review) --");
{
  const { G, a } = drawnAdminTab(script);
  a.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: REFS() }) }, { detentions: DETS1() });
  await a.logout({ inactive: true });
  check("the whole school's referrals, all on the server, are not set aside", G.localStorage.getItem(UNSENT) === null);
  // A tab restored from the device cache (a reload) holds nothing new either.
  const H = world(null, { localStorage: makeStorage(), auth: { getSession: () => ({ me: { kind: "staff", email: "admin@x.org" } }) } });
  const c = loadApp(script, H);
  c.runLocalRestore({ referralsOwner: "admin@x.org", behaviorReferrals: REFS(), detentions: DETS1() });
  c.currentUser = ADMIN;
  await c.logout({ inactive: true });
  check("...nor what a reload restored from the device cache", H.localStorage.getItem(UNSENT) === null);
}

console.log("\n-- Logout says what is not on the server before it asks (review) --");
{
  const { G, a } = teacherWithUnsaved();
  await a.logout();
  check("the question names the unsent referral", /Not on the server yet: 1 referral\./.test(G.confirms[0]), G.confirms[0]);
  check("...and says where it goes", /stays on this device/.test(G.confirms[0]));
  const plain = drawnAdminTab(script);
  plain.a.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: REFS() }) }, { detentions: DETS1() });
  await plain.a.logout();
  check("nothing unsent: the usual question", plain.G.confirms[0] === "Are you sure you want to logout?");
}

console.log("\n-- a save takes off the bar only what it sent; Retry says what is left (review) --");
{
  const a = loadApp(script, world(TEACHER, { unsaved: new Map([["A", ref("A")], ["B", ref("B")]]) }));
  check("clearSentFromUnsaved: sent A, not B -> only A leaves the bar",
    a.clearSentFromUnsaved(new Set(["A", "B"]), new Set(["A", "MINE-OPEN"])) === 1 && J([...a.unsaved.keys()]) === J(["B"]));
  check("...and a write that did not land clears nothing", a.clearSentFromUnsaved(new Set(["B"]), null) === 0 && a.unsaved.has("B"));

  // Retry after a save that succeeded without it.
  const G = world(TEACHER, { unsaved: new Map([["GONE", ref("GONE")]]), flushResult: true, requestResult: true });
  const r = loadApp(script, G);
  await r.retryUnsavedReferrals();
  check("Retry does not announce a referral that was not sent as on the server",
    !G.toasts.some((t) => /Everything is on the server/.test(t.message)) && r.unsaved.has("GONE"), J(G.toasts));
  check("...it asks for a save that includes it", (G.requests || []).length === 1);
  check("...and says it is still only on this device", G.toasts.some((t) => /still only on this device/.test(t.message)));
  const ok = world(TEACHER, { flushResult: true });
  await loadApp(script, ok).retryUnsavedReferrals();
  check("with nothing left on the bar it still says Saved", ok.toasts.some((t) => /Everything is on the server/.test(t.message)));

  const save = liftFn(script, "saveData");
  check("saveData puts unsent work back before it takes its snapshot",
    save.indexOf("            putBackUnsentDiscipline();") !== -1
    && save.indexOf("            putBackUnsentDiscipline();") < save.indexOf("const unsavedAtStart = {"));
  check("...clears the bar by what the referral write sent, never wholesale",
    /clearSentFromUnsaved\(unsavedAtStart\.referrals, referralIdsSent\);/.test(save)
    && !/unsavedAtStart\.referrals\.forEach\(id => _unsavedReferrals\.delete\(id\)\)/.test(save));
  check("...records what it sent only after the write resolves",
    /await mergeLegacySlice\('referrals'[^\n]*\n\s*referralIdsSent = new Set\(refSent/.test(save));
  check("...and takes kept work off the device by what each write that landed carried",
    /referralIdsSent = new Set\(refSent[^\n]*\n\s*disciplineWriteLanded\('referrals', refSent, ownerAtStart, generationAtStart\);/.test(save)
    && /if \(key === 'detentions'\) disciplineWriteLanded\('detentions', sent, ownerAtStart, generationAtStart\);/.test(save)
    && /if \(key === 'detentions'\) dropSetAside\(ownerAtStart, 'detentions', value\);/.test(save));
  const core = liftFn(script, "establishTeacherSessionCore");
  check("the sign-in sheds, brings back, then saves, in that order",
    /shedReferralsNotMine\(\);[\s\S]*?restoreUnsentDiscipline\(\);[\s\S]*?await saveData\(\);/.test(core));
  const out = liftFn(script, "logout");
  check("logout sets the work aside before it forgets who is signed in",
    out.indexOf("setAsideUnsentDiscipline()") !== -1 && out.indexOf("setAsideUnsentDiscipline()") < out.indexOf("currentUser = null;"));
}

console.log("\n-- an answer that comes back after sign-out is dropped (review) --");
{
  let open;
  const G = world(ADMIN, { serverReferrals: REFS(), referrals: [], realPull: true,
    auth: { getSession: () => ({ me: { kind: "staff", email: "admin@x.org" } }) } });
  G.docGate = new Promise((r) => { open = r; });
  const a = loadApp(script, G);
  const pull = a.pullReferralsOnce();
  await a.logout({ inactive: true });
  open();
  const res = await pull;
  check("a referral pull out at sign-out installs nothing when it lands", a.referrals.length === 0 && res.skipped === "signed-out", J(res));
  check("...and pullReferralsAndRedraw draws nothing for it", await (async () => {
    let o2; const H = world(ADMIN, { serverReferrals: REFS(), referrals: [], realPull: true,
      auth: { getSession: () => ({ me: { kind: "staff", email: "admin@x.org" } }) } });
    H.docGate = new Promise((r) => { o2 = r; });
    const b = loadApp(script, H);
    const p = b.pullReferralsAndRedraw(true);
    await b.logout({ inactive: true });
    o2(); await p;
    return b.referrals.length === 0 && !H.redraws;
  })());

  let open2;
  const P = world(TEACHER, { serverDetentions: DETS1(), serverReferrals: REFS() });
  P.docGate = new Promise((r) => { open2 = r; });
  const b = loadApp(script, P);
  b.currentUser = { ...TEACHER, role: "pbis" };
  const widen = b.rescopeDisciplineForRole("teacher");
  await b.logout({ inactive: true });
  open2();
  check("a promotion's detention read out at sign-out installs nothing", (await widen) === "signed-out"
    && b.detentions.length === 0 && b.referrals.length === 0);
  check("the save's own detentions do not come back after a sign-out",
    /if \(generationAtStart === _signInGeneration\) detentions = mergedSecondary\.detentions;/.test(liftFn(script, "saveData")));
  check("clearSession moves the generation on first", /function clearSession\(\) \{\s*(\/\/[^\n]*\n\s*)*_signInGeneration\+\+;/.test(script));
}

console.log("\n-- a role lowered mid-session takes the device copy down too (review) --");
{
  const G = world(ADMIN, { detentions: DETS1() });
  const a = loadApp(script, G);
  a.cacheLocally({ behaviorReferrals: REFS(), detentions: DETS1(), auditLog: [] });
  check("before: the admin's cache holds the school", blobIn(G).behaviorReferrals.length === 4 && blobIn(G).detentions.length === 1);
  a.currentUser = { ...ADMIN, role: "teacher" };
  check("moved down to teacher: shed", (await a.rescopeDisciplineForRole("admin")) === "shed");
  check("...and the device cache holds no referrals or detentions", !("behaviorReferrals" in blobIn(G)) && !("detentions" in blobIn(G)));
  const r = loadApp(script, world(null, { auth: { getSession: () => ({ me: { kind: "staff", email: "admin@x.org" } }) } }));
  r.runLocalRestore(blobIn(G));
  check("...so a reload before their next save restores nothing", r.referrals.length === 0 && r.detentions.length === 0);
}

console.log("\n-- closing the tab takes the discipline cache with it (review) --");
{
  const G = world(ADMIN, { localStorage: makeStorage({ raffleData: adminCache() }) });
  loadApp(script, G);
  check("the page listens for pagehide", typeof (G.listeners || {}).pagehide === "function");
  await G.listeners.pagehide();
  check("pagehide flushes saves, as before", (G.flushes || []).length === 1);
  check("...and strips the referrals, the detentions and the stamp",
    !("behaviorReferrals" in blobIn(G)) && !("detentions" in blobIn(G)) && !("referralsOwner" in blobIn(G)));
  check("...keeping the rest (unsaved cash is recovered from it)", blobIn(G).cashTransactions.length === 1);
}

console.log("\n-- a teacher view ends with the session --");
{
  const G = world({ ...TEACHER }, { realUser: ADMIN, detentions: DETS1() });
  const a = loadApp(script, G);
  document_el(a, "wcPreviewBar");
  await a.logout({ inactive: true });
  check("logging out of a teacher view ends it", a.realUser === null && a.isPreviewingTeacher() === false);
  check("...drops the previewed roster", a.previewRoster === null);
  check("...and takes the banner (and its Exit button) off the page", (a.els.__removed || []).includes("wcPreviewBar"));
  // The next person signs in on that Chromebook: loadData installs before the
  // sign-in knows who they are, then the sign-in sheds.
  a.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: REFS() }) }, { detentions: DETS1() });
  a.currentUser = { id: "t9", role: "teacher", email: "t.teacher@x.org", name: "Next Teacher" };
  a.shedReferralsNotMine();
  check("the next teacher's tab is scoped to their own referrals", a.referrals.map((r) => r.id).sort().join() === "MINE-CLOSED,MINE-OPEN");
  check("...holds no detentions", a.detentions.length === 0);
  check("...and stamps the cache with their email, not the admin's", a.referralCacheOwner() === "t.teacher@x.org");
  check("...and may not close", a.canCloseReferralsHere() === false);
  const plain = loadApp(script, world(ADMIN));
  let threw = false;
  try { plain.clearSession(); } catch (e) { threw = true; }
  check("a sign-out with no preview running is unaffected", !threw && plain.realUser === null);
}

console.log("\n-- page start: a cache that is not this tab's session's is removed, not just left unread --");
{
  let G = world(null, { localStorage: makeStorage({ raffleData: adminCache() }) });
  let a = loadApp(script, G);
  check("nobody signed in (a closed tab, a new one opened): the admin's cache is dropped", a.dropDisciplineCacheUnlessMine() === true);
  let b = blobIn(G);
  check("...no referrals, no detentions, no stamp left on the device",
    !("behaviorReferrals" in b) && !("detentions" in b) && !("referralsOwner" in b));
  check("...and the rest of the cache is kept (unsaved cash is recovered from it)", b.cashTransactions.length === 1);

  G = world(null, { localStorage: makeStorage({ raffleData: adminCache({ referralsOwner: undefined }) }) });
  loadApp(script, G).dropDisciplineCacheUnlessMine();
  check("an unstamped cache from before this build is dropped too", !("behaviorReferrals" in blobIn(G)));

  G = world(TEACHER, { localStorage: makeStorage({ raffleData: adminCache() }) });
  loadApp(script, G).dropDisciplineCacheUnlessMine();
  check("a teacher's session on a device an admin used: dropped", !("behaviorReferrals" in blobIn(G)));

  G = world(ADMIN, { localStorage: makeStorage({ raffleData: adminCache() }) });
  a = loadApp(script, G);
  check("the admin's own reload keeps the admin's cache", a.dropDisciplineCacheUnlessMine() === false
    && blobIn(G).behaviorReferrals.length === 4 && blobIn(G).detentions.length === 1);

  const bad = loadApp(script, world(null, { localStorage: makeStorage({ raffleData: "{not json" }) }));
  let threw = false;
  try { bad.dropDisciplineCacheUnlessMine(); } catch (e) { threw = true; }
  check("a corrupt cache does not stop a page start", !threw);

  const boot = script.slice(script.indexOf("const hasSession = loadSession();"), script.indexOf("} else if (hasSession) {"));
  check("the page start drops it right after the session is restored, before anything is shown",
    /^const hasSession = loadSession\(\);\s*(\/\/[^\n]*\n\s*)*dropDisciplineCacheUnlessMine\(\);/.test(boot));
  check("...and strips it when the restored staff session turns out to be dead",
    /if \(staffNeedsReauth\) \{[\s\S]*?currentUser = null;[\s\S]{0,120}stripDisciplineFromLocalCache\(\);/.test(boot));
}

console.log("\n-- a student signing in never inherits the staff discipline record --");
{
  const G = world(null, { localStorage: makeStorage({ raffleData: adminCache() }), detentions: DETS1() });
  const a = loadApp(script, G);
  a.establishStudentSession({ id: "S1" });
  check("establishStudentSession strips the cache and empties memory",
    !("behaviorReferrals" in blobIn(G)) && a.referrals.length === 0 && a.detentions.length === 0);
  const code = script.replace(/^\s*\/\/.*$/gm, "");
  check("the Google student sign-in strips and forgets before opening the portal",
    /if \(me\.kind !== 'student'\) return;\s*stripDisciplineFromLocalCache\(\);\s*forgetDisciplineRecord\(\);\s*openStudentPortal\(null\);/.test(code));
}

console.log("\n-- the two install paths a test did not reach (review) --");
{
  // A teacher whose 'referrals' document is absent gets the legacy secondary
  // list -- cut to their own like the main one.
  const a = loadApp(script, world(TEACHER));
  a.runServerInstall({ exists: () => false, data: () => ({}) }, { behaviorReferrals: REFS(), detentions: DETS1() });
  check("legacy secondary fallback: a teacher keeps only their own", a.referrals.map((r) => r.id).sort().join() === "MINE-CLOSED,MINE-OPEN");
  const adm = loadApp(script, world(ADMIN));
  adm.runServerInstall({ exists: () => false, data: () => ({}) }, { behaviorReferrals: REFS(), detentions: DETS1() });
  check("...an admin keeps all four", adm.referrals.length === 4);

  // A teacher tab still holding other teachers' rows (loaded before it knew
  // who was signed in) goes through the reload every save conflict triggers.
  const unsaved = ref("UNSAVED-9", { filedByEmail: "", referredByEmail: "", referredBy: "" });
  const G = world(TEACHER, { unsaved: new Map([["UNSAVED-9", unsaved]]),
    reloadSnap: { exists: () => true, data: () => ({ behaviorReferrals: [ref("MINE-OPEN")] }) } });
  const r = loadApp(script, G);
  r.referrals = [...REFS(), unsaved];
  await r.reloadPreservingUnsavedWork();
  check("reloadPreservingUnsavedWork keeps the teacher's own and the unsaved one, and nobody else's",
    r.referrals.map((x) => x.id).sort().join() === "MINE-CLOSED,MINE-OPEN,UNSAVED-9", r.referrals.map((x) => x.id).join());
  // The same reload, for a teacher whose clock runs fast: their copy looks
  // newer than the admin's close, and must not win it back.
  const fast = ref("MINE-OPEN", { updatedAt: "2026-10-07T15:10:00.000Z", submittedAt: "2026-10-07T15:10:00.000Z" });
  const closed = { ...fast, status: "closed", closedBy: "A Admin", closedAt: "2026-10-07T15:03:00.000Z", updatedAt: "2026-10-07T15:03:00.000Z" };
  const F = loadApp(script, world(TEACHER, { reloadSnap: { exists: () => true, data: () => ({ behaviorReferrals: [closed] }) } }));
  F.referrals = [fast];
  await F.reloadPreservingUnsavedWork();
  check("...and a teacher's fast-clock copy takes the admin's close through the reload",
    F.referrals.length === 1 && F.referrals[0].status === "closed" && F.referrals[0].closedBy === "A Admin");
}

console.log("\n-- an access change mid-session reaches what the tab holds (review) --");
{
  const SERVER_DETS = [{ id: "detention_1", sourceReferralId: "THEIRS-OPEN", status: "active" }, { id: "detention_2", status: "completed" }];
  // A teacher's tab, scoped, then promoted to PBIS by refreshRosterFromConvex.
  let G = world(TEACHER, { serverDetentions: SERVER_DETS, serverReferrals: REFS() });
  let a = loadApp(script, G);
  a.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: REFS() }) }, { detentions: SERVER_DETS });
  check("before: the teacher's tab holds their two referrals and no detentions", a.referrals.length === 2 && a.detentions.length === 0);
  a.currentUser = { ...TEACHER, role: "pbis" };
  check("promoted to PBIS: the detentions are read", (await a.rescopeDisciplineForRole("teacher")) === "widened"
    && a.detentions.length === 2 && J(G.docReads) === J([["secondary"]]));
  check("...the referrals are pulled", G.pulls === 1 && a.referrals.length === 4);
  check("...so the referral's active detention is found, and a close will not make a second",
    !!D.activeDetentionFor(a.detentions, "THEIRS-OPEN"));

  // Moved down from admin to teacher: shed, nothing fetched.
  G = world(ADMIN, { detentions: SERVER_DETS.slice() });
  a = loadApp(script, G);
  a.currentUser = { ...ADMIN, role: "teacher", email: "t.teacher@x.org" };
  check("moved down to teacher: the tab sheds to their own and holds no detentions",
    (await a.rescopeDisciplineForRole("admin")) === "shed" && a.referrals.length === 2 && a.detentions.length === 0 && !G.docReads);

  G = world(ADMIN, { serverDetentions: SERVER_DETS });
  a = loadApp(script, G);
  a.currentUser = { ...ADMIN, role: "pbis" };
  check("admin to PBIS (both see everything): nothing is read", (await a.rescopeDisciplineForRole("admin")) === "unchanged" && !G.docReads);

  G = world({ ...TEACHER, role: "pbis" }, { realUser: ADMIN, serverDetentions: SERVER_DETS });
  a = loadApp(script, G);
  check("during a teacher preview: nothing changes", (await a.rescopeDisciplineForRole("teacher")) === "unchanged" && !G.docReads);

  G = world({ ...TEACHER, role: "pbis" }, { docsFail: true, detentions: [{ id: "detention_9" }] });
  a = loadApp(script, G);
  await a.rescopeDisciplineForRole("teacher");
  check("a failed read keeps what the tab has", a.detentions.length === 1);

  const roster = liftFn(script, "refreshRosterFromConvex");
  check("refreshRosterFromConvex applies it when the role changed",
    /if \(before !== fresh\.role\) \{\n[^\n]*\n\s*rescopeDisciplineForRole\(before\)/.test(roster));

  const noFetch = breakOnce(script, "                const res = await loadLegacyDocsFromConvex(['secondary']);\n",
    "                const res = null;\n", "promotion read");
  G = world(TEACHER, { serverDetentions: SERVER_DETS });
  a = loadApp(noFetch, G);
  a.currentUser = { ...TEACHER, role: "pbis" };
  await a.rescopeDisciplineForRole("teacher");
  check("TEETH: without the read a promoted user's Detention tab stays empty", a.detentions.length === 0);
}

console.log("\n-- the referral save reports numbers only --");
{
  const res = { doc: "referrals", collection: "behaviorReferrals", stored: 18, incoming: 3, inserted: 1, updated: 0, deleted: 0,
    refusedAsHistory: 0, refusedNotYours: 2, keptCloseFields: 1, clampedStamps: 0, refusedReferralDetentions: 0,
    cashArrival: null, keptCancelledReceipts: 0, studentName: "Student X", note: "anything" };
  const counts = D.referralSaveCounts(res);
  check("every value is a number", Object.values(counts).every((v) => typeof v === "number"));
  check("the counters the server returns are all there",
    ["incoming", "inserted", "updated", "deleted", "refusedAsHistory", "refusedNotYours", "keptCloseFields", "clampedStamps", "refusedReferralDetentions"]
      .every((k) => k in counts));
  check("nothing else rides along (no doc name, no stored total, no stray text)",
    !("doc" in counts) && !("stored" in counts) && !("studentName" in counts) && !("note" in counts));
  check("a non-number under a counter's name is dropped", !("inserted" in D.referralSaveCounts({ inserted: "Student X" })));
  check("no answer at all is an empty object", JSON.stringify(D.referralSaveCounts(undefined)) === "{}");
  const save = script.slice(script.indexOf("const refSaved = await mergeLegacySlice("), script.indexOf("} catch (refErr) {"));
  check("saveData logs referralSaveCounts(...) and never the raw answer",
    /referralSaveCounts\(refSaved\)/.test(save) && !/console\.\w+\([^)]*refSaved\b/.test(save));
}

// ---------------------------------------------------------------- Demographics

console.log("\n-- Demographics: a PBIS cell withheld to protect a small group --");
{
  const pbisRes = {
    allowed: true, loaded: true, counted: 31, unmatched: 0, groupsWithheld: 2, smallGroupThreshold: 10, minReferralsForIndex: 30,
    windowApplied: false, snapshotStudents: 20,
    rows: [
      { code: "Hispanic or Latino", count: 25, shareOfReferrals: 0.8, shareOfEnrollment: 0.6, index: 1.33, suppressed: false, tooFewReferrals: true, countSuppressed: false },
      { code: "Asian", count: null, shareOfReferrals: null, shareOfEnrollment: null, index: null, suppressed: true, tooFewReferrals: false, countSuppressed: true },
      { code: "White", count: null, shareOfReferrals: null, shareOfEnrollment: null, index: null, suppressed: true, tooFewReferrals: false, countSuppressed: true },
    ],
  };
  const host = makeEl("referralRaceCard");
  const a = loadApp(script, world(PBIS));
  a.renderRaceCard(host, pbisRes, []);
  const rows = host.innerHTML.split("<tr>").slice(2);
  check("withheld rows say 'withheld to protect a small group'",
    rows.filter((r) => /withheld to protect a small group/.test(r)).length === 2);
  check("...and print no number or share", rows.slice(1).every((r) => !/\d+%|<strong>/.test(r)));
  check("the legend says what that means: fewer than 10 referred students, or held back with one",
    /fewer than\s+10\s+referred students/.test(host.innerHTML) && /next-smallest group is withheld with it/.test(host.innerHTML));
  check("the PBIS view says it is the whole year, moving in steps of ten",
    /whole school year/.test(host.innerHTML) && /20 students so far/.test(host.innerHTML));

  const adminRes = { ...pbisRes, windowApplied: undefined, snapshotStudents: undefined,
    rows: [{ code: "Asian", count: null, shareOfReferrals: null, shareOfEnrollment: null, index: null, suppressed: true, tooFewReferrals: false }] };
  const h2 = makeEl("referralRaceCard");
  a.renderRaceCard(h2, adminRes, []);
  check("an admin's enrolment-withheld row still reads 'withheld' as before",
    /<span class="receipt-meta">withheld<\/span>/.test(h2.innerHTML) && !/protect a small group/.test(h2.innerHTML));
  check("...with no PBIS snapshot note", !/whole school year/.test(h2.innerHTML));
}

// ---------------------------------------------------------------- TEETH

console.log("\n-- TEETH: each guard, removed, is caught --");
{
  const allButtons = breakOnce(script, "            const mayClose = canCloseReferralsHere();\n            // The hint above",
    "            const mayClose = true;\n            // The hint above", "open table");
  check("TEETH: a Close button drawn for everyone is caught", openHtml(allButtons, TEACHER).includes("openCloseReferralModal"));

  const loopForAll = breakOnce(script, "            const mayClose = canCloseReferralsHere();\n            host.innerHTML",
    "            const mayClose = true;\n            host.innerHTML", "closed list");
  check("TEETH: a loop button drawn for everyone is caught", closedHtml(loopForAll, TEACHER).includes("openCloseLoopModal"));

  const detailForAll = breakOnce(script, "${r.status !== 'closed' && canCloseReferralsHere() ?", "${r.status !== 'closed' ?", "detail");
  check("TEETH: 'Close this referral' for everyone is caught", detailHtml(detailForAll, TEACHER, "MINE-OPEN").includes("Close this referral"));

  const noGuard = script.replace(
    "            if (!canCloseReferralsHere()) { refuseReferralClose(); return; }\n            const r = (behaviorReferrals || []).find(x => x.id === referralId);\n            if (!r) return;\n            const resolution",
    "            const r = (behaviorReferrals || []).find(x => x.id === referralId);\n            if (!r) return;\n            const resolution");
  if (noGuard === script) throw new Error("teeth: confirmCloseReferral guard anchor moved");
  const a = loadApp(noGuard, world(TEACHER, { actions: ["Notified parents/guardians promptly"] }));
  await a.confirmCloseReferral("MINE-OPEN");
  check("TEETH: confirmCloseReferral without its guard lets a teacher close", a.referrals.find((x) => x.id === "MINE-OPEN").status === "closed");

  const loopNoGuard = breakOnce(script,
    "            // Closing the loop stops the reminder emails, so it is a close.\n            if (!canCloseReferralsHere()) { refuseReferralClose(); return; }\n",
    "", "loop guard");
  const l = loadApp(loopNoGuard, world(TEACHER));
  await l.confirmCloseLoop("MINE-CLOSED");
  check("TEETH: confirmCloseLoop without its guard lets a teacher close the loop", l.referrals.find((x) => x.id === "MINE-CLOSED").loopClosed === true);

  const twoDetentions = breakOnce(script,
    "            if (window.WildcatDiscipline.activeDetentionFor(detentions, r && r.id)) return false;\n", "", "detention dedupe");
  const t = loadApp(twoDetentions, world(ADMIN, { actions: ["Assigned the student to mandatory detention"],
    detentions: [{ id: "detention_9", sourceReferralId: "THEIRS-OPEN", status: "active" }] }));
  await t.confirmCloseReferral("THEIRS-OPEN");
  check("TEETH: without the dedupe a second detention is made", t.detentions.length === 2);

  const rawInstall = breakOnce(script, "behaviorReferrals = cacheableReferrals(referralsData.behaviorReferrals);",
    "behaviorReferrals = referralsData.behaviorReferrals;", "install filter");
  const i = loadApp(rawInstall, world(TEACHER));
  i.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: REFS() }) }, {});
  check("TEETH: an unfiltered install keeps the whole school on a teacher's tab", i.referrals.length === 4);

  const detInstall = breakOnce(script, "detentions = referralsScopedToViewer() ? [] : (secondaryData.detentions || []);",
    "detentions = secondaryData.detentions || [];", "install detentions");
  const di = loadApp(detInstall, world(TEACHER));
  di.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: [] }) }, { detentions: [{ id: "d" }] });
  check("TEETH: unscoped detentions at install are caught", di.detentions.length === 1);

  const rawCache = breakOnce(script, "            blob = disciplineCacheBlob(blob);\n", "", "cache blob");
  const G = world(TEACHER);
  loadApp(rawCache, G).cacheLocally({ behaviorReferrals: REFS(), detentions: [], auditLog: [] });
  check("TEETH: a cache write that skips the cut holds the whole school",
    JSON.parse(G.localStorage.getItem("raffleData")).behaviorReferrals.length === 4);

  const anyRestore = breakOnce(script, "const discCacheMine = localCacheIsMine(data);", "const discCacheMine = true;", "restore stamp");
  const r = loadApp(anyRestore, world(null));
  r.runLocalRestore({ referralsOwner: "admin@x.org", behaviorReferrals: REFS(), detentions: [{ id: "d" }] });
  check("TEETH: restoring without the stamp check puts an admin's copy back at page start", r.referrals.length === 4);

  const noStrip = breakOnce(script, "            stripDisciplineFromLocalCache();\n            closeTeacherViewAtSignOut();",
    "            closeTeacherViewAtSignOut();", "sign-out strip");
  const G2 = world(TEACHER, { localStorage: makeStorage({ raffleData: JSON.stringify({ behaviorReferrals: REFS() }) }) });
  loadApp(noStrip, G2).clearSession();
  check("TEETH: a sign-out that does not strip leaves the referrals on the device",
    JSON.parse(G2.localStorage.getItem("raffleData")).behaviorReferrals.length === 4);

  // Review, 2026-10-07.
  const noForget = breakOnce(script, "                clearSession(); // Clear saved session\n                if (typeof forgetDisciplineRecord === 'function') forgetDisciplineRecord();\n",
    "                clearSession(); // Clear saved session\n", "logout forgets");
  const nf = drawnAdminTab(noForget).a;
  await nf.logout({ inactive: true });
  check("TEETH: a logout that does not forget leaves the whole school in memory", nf.referrals.length === 4);

  const previewLives = breakOnce(script, "            stripDisciplineFromLocalCache();\n            closeTeacherViewAtSignOut();\n",
    "            stripDisciplineFromLocalCache();\n", "preview ends");
  const pl = loadApp(previewLives, world({ ...TEACHER }, { realUser: ADMIN }));
  await pl.logout({ inactive: true });
  pl.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: REFS() }) }, { detentions: DETS1() });
  pl.currentUser = { id: "t9", role: "teacher", email: "t.teacher@x.org" };
  pl.shedReferralsNotMine();
  check("TEETH: a preview that outlives the logout leaves the next teacher holding the whole school",
    pl.referrals.length === 4 && pl.detentions.length === 1);

  const keepsAny = breakOnce(script, "if (!data || typeof data !== 'object' || localCacheIsMine(data)) return false;",
    "return false;", "page-start drop");
  const Gk = world(null, { localStorage: makeStorage({ raffleData: adminCache() }) });
  loadApp(keepsAny, Gk).dropDisciplineCacheUnlessMine();
  check("TEETH: a page start that only declines to restore leaves the admin's cache readable", blobIn(Gk).behaviorReferrals.length === 4);

  const studentKeeps = breakOnce(script, "            // used this browser before them (review, 2026-10-07).\n            stripDisciplineFromLocalCache();\n            forgetDisciplineRecord();\n",
    "            // used this browser before them (review, 2026-10-07).\n", "student sign-in");
  const Gs = world(null, { localStorage: makeStorage({ raffleData: adminCache() }) });
  loadApp(studentKeeps, Gs).establishStudentSession({ id: "S1" });
  check("TEETH: a student session that does not strip leaves the cache", blobIn(Gs).behaviorReferrals.length === 4);

  const rawFallback = breakOnce(script, "behaviorReferrals = cacheableReferrals(secondaryData.behaviorReferrals || []);",
    "behaviorReferrals = secondaryData.behaviorReferrals || [];", "secondary fallback");
  const rf = loadApp(rawFallback, world(TEACHER));
  rf.runServerInstall({ exists: () => false, data: () => ({}) }, { behaviorReferrals: REFS() });
  check("TEETH: an unfiltered legacy fallback keeps the whole school on a teacher's tab", rf.referrals.length === 4);

  const rawReload = breakOnce(script,
    "const pendingReferrals = cacheableReferrals(Array.isArray(behaviorReferrals) ? behaviorReferrals.slice() : []);",
    "const pendingReferrals = Array.isArray(behaviorReferrals) ? behaviorReferrals.slice() : [];", "reload cut");
  const Gr = world(TEACHER, { reloadSnap: { exists: () => true, data: () => ({ behaviorReferrals: [ref("MINE-OPEN")] }) } });
  const rr = loadApp(rawReload, Gr);
  rr.referrals = REFS();
  await rr.reloadPreservingUnsavedWork();
  check("TEETH: a reload that carries everything across merges other teachers' rows back in",
    rr.referrals.some((x) => x.id.startsWith("THEIRS")));

  const noOwnerCheck = breakOnce(script, "return Boolean(owner) && stamp === owner;", "return stamp === owner;", "owner required");
  const no = loadApp(noOwnerCheck, world(null));
  no.runLocalRestore({ behaviorReferrals: REFS(), detentions: [{ id: "detention_1" }] });
  check("TEETH: without 'nobody signed in owns nothing', an unstamped cache is restored at page start",
    no.referrals.length === 4 && no.detentions.length === 1);

  // The pure rules in wildcat-discipline.js.
  const teacherCloses = loadD(breakOnce(discSrc,
    "  function canCloseReferrals(role) {\n    return DISCIPLINE_ALL_ROLES.indexOf(trimmed(role).toLowerCase()) !== -1;",
    "  function canCloseReferrals(role) {\n    return true;", "canCloseReferrals"));
  check("TEETH: a canCloseReferrals that lets teachers close puts the button back",
    (() => { const x = loadApp(script, world(TEACHER), teacherCloses); x.updateReferralReviewTable(); return x.els.referralReviewTable.innerHTML.includes("openCloseReferralModal"); })());
  const dropsUnsaved = loadD(breakOnce(discSrc, "return ownsReferral(r, user) || Boolean(keep && r && keep.has(r.id));",
    "return ownsReferral(r, user);", "unsaved kept"));
  const u = loadApp(script, world(TEACHER, { unsaved: new Map([["UNSAVED-1", {}]]) }), dropsUnsaved);
  u.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: [ref("UNSAVED-1", { filedByEmail: "", referredByEmail: "", referredBy: "" })] }) }, {});
  check("TEETH: a rule that ignores unsaved ids would drop a referral this tab has not saved", u.referrals.length === 0);
  const leaky = loadD(breakOnce(discSrc, "      if (typeof res[k] === 'number' && isFinite(res[k])) out[k] = res[k];",
    "      if (k in res) out[k] = res[k];", "numbers only"));
  check("TEETH: copying counters without the number check lets text through",
    leaky.referralSaveCounts({ inserted: "Student X" }).inserted === "Student X");
  const sayFewer = breakOnce(script, ">withheld to protect a small group</span>`", ">withheld</span>`", "label");
  const h = makeEl("x");
  loadApp(sayFewer, world(PBIS)).renderRaceCard(h, { allowed: true, loaded: true, counted: 1, smallGroupThreshold: 10, minReferralsForIndex: 30,
    rows: [{ code: "Asian", count: null, suppressed: true, countSuppressed: true }] }, []);
  check("TEETH: the PBIS label reverting to plain 'withheld' is caught", !/withheld to protect a small group<\/span>/.test(h.innerHTML));
}

console.log("\n-- TEETH: the sign-out review fixes, each removed, are caught --");
{
  const install = (x) => x.runServerInstall({ exists: () => true, data: () => ({ behaviorReferrals: REFS() }) }, { detentions: DETS1() });
  const loggedOutTeacher = async (src, Dmod) => {
    const R = ref("UNSAVED-NEW");
    const G = world(TEACHER, { unsaved: new Map([[R.id, R]]) });
    const x = loadApp(src, G, Dmod);
    install(x);
    x.referrals.push(R);
    x.renderUnsavedReferralBar();
    await x.logout({ inactive: true });
    return { G, x };
  };

  const dropsWork = breakOnce(script, "const kept = typeof setAsideUnsentDiscipline === 'function' ? setAsideUnsentDiscipline() : null;",
    "const kept = { referrals: 0, detentions: 0 };", "set aside at logout");
  check("TEETH: a logout that does not set the work aside loses the unsaved referral",
    (await loggedOutTeacher(dropsWork)).G.localStorage.getItem(UNSENT) === null);

  const keepsBar = breakOnce(script, "                _unsavedReferrals.clear();\n                renderUnsavedReferralBar();",
    "                renderUnsavedReferralBar();", "bar cleared");
  const kb = (await loggedOutTeacher(keepsBar)).x;
  check("TEETH: a sign-out that keeps the bar's list leaves the child named on the login screen",
    kb.els.unsavedReferralBar.hidden === false && kb.unsaved.size === 1);

  const everything = loadD(breakOnce(discSrc,
    "      return !(p !== null && prints && typeof prints.has === 'function' && prints.has(p));", "      return true;", "rowsNotOnServer"));
  const G = world(ADMIN);
  const ev = loadApp(script, G, everything);
  install(ev);
  await ev.logout({ inactive: true });
  check("TEETH: counting loaded rows as unsent sets an admin's whole school aside on the device",
    (keptOn(G)?.["admin@x.org"]?.referrals || []).length === 4);

  const anyones = breakOnce(script, "                const mine = unsentDisciplineOf(readUnsentDiscipline(), owner);",
    "                const mine = Object.values(readUnsentDiscipline())[0];", "owner check");
  const ao = (await loggedOutTeacher(anyones)).x;
  ao.currentUser = { id: "t2", role: "teacher", email: "other@x.org", name: "O Other" };
  ao.restoreUnsentDiscipline();
  check("TEETH: a restore that ignores whose it is hands the referral to the next teacher",
    ao.referrals.some((r) => r.id === "UNSAVED-NEW"));

  const latePull = breakOnce(script, "                if (generation !== _signInGeneration || !currentUser) return { skipped: 'signed-out' };\n",
    "", "late pull");
  let open;
  const P = world(ADMIN, { serverReferrals: REFS(), referrals: [], realPull: true,
    auth: { getSession: () => ({ me: { kind: "staff", email: "admin@x.org" } }) } });
  P.docGate = new Promise((r) => { open = r; });
  const lp = loadApp(latePull, P);
  const pending = lp.pullReferralsOnce();
  await lp.logout({ inactive: true });
  open(); await pending;
  check("TEETH: a pull that does not check who is signed in puts the school back after sign-out", lp.referrals.length === 4);

  const shedOnly = breakOnce(script, "                    stripDisciplineFromLocalCache();\n                    return 'shed';",
    "                    return 'shed';", "shed strips cache");
  const S = world(ADMIN, { detentions: DETS1() });
  const so = loadApp(shedOnly, S);
  so.cacheLocally({ behaviorReferrals: REFS(), detentions: DETS1(), auditLog: [] });
  so.currentUser = { ...ADMIN, role: "teacher" };
  await so.rescopeDisciplineForRole("admin");
  check("TEETH: a demotion that only trims memory leaves the school in the device cache", blobIn(S).behaviorReferrals.length === 4);

  const keepsOnClose = breakOnce(script, "window.addEventListener('pagehide', function () { flushSaves(); stripDisciplineFromLocalCache(); });",
    "window.addEventListener('pagehide', function () { flushSaves(); });", "pagehide strip");
  const C = world(ADMIN, { localStorage: makeStorage({ raffleData: adminCache() }) });
  loadApp(keepsOnClose, C);
  await C.listeners.pagehide();
  check("TEETH: a pagehide that only flushes leaves the school's referrals in localStorage", blobIn(C).behaviorReferrals.length === 4);
}

// ---------------------------------------------------------------- kept work: the second review (2026-10-07)
//
// What a sign-out keeps for its author: a row leaves the device only when a
// write carrying it lands; it goes back only once the sign-in has the server's
// lists, by rules that cannot replace another child's detention or make a
// second active one; it is kept 14 days at most, someone else's referral as
// its close alone, and only what the person may still hold comes back.

const DET = "Assigned the student to mandatory detention";
const snap = (rows) => ({ exists: () => true, data: () => ({ behaviorReferrals: rows }) });
const copy = (x) => JSON.parse(J(x));
const ADMIN_EMAIL = "admin@x.org";
const TEACHER_EMAIL = "t.teacher@x.org";
/** An admin's tab that loaded the school, closed THEIRS-OPEN with a detention, and was logged out before any of it landed. */
async function adminClosedOffline(over, src) {
  const G = world(ADMIN, Object.assign({ actions: [DET], detentionIdCounter: 5 }, over));
  const a = loadApp(src || script, G);
  a.runServerInstall(snap(REFS()), { detentions: [] });
  await a.confirmCloseReferral("THEIRS-OPEN");
  const made = copy(a.detentions), closed = copy(a.referrals);
  await a.logout({ inactive: true });
  return { G, a, made, closed };
}
/** The same admin signing in on a new page of the same browser. */
function adminSignsIn(G, src, Dmod) {
  const b = loadApp(src || script, world(null, { localStorage: G.localStorage, referrals: [] }), Dmod);
  b.currentUser = ADMIN;
  b.restoreUnsentDiscipline();
  return b;
}
const OTHER_KIDS = () => ({ id: "detention_5", studentId: "S2", studentName: "Other Kid", sourceReferralId: "OTHER-REF",
  assignedAt: "2026-10-07T20:00:00.000Z", status: "active", daysServed: 0, servedDates: [] });

console.log("\n-- a kept detention never replaces another child's that took its id (second review) --");
{
  const { G, made } = await adminClosedOffline();
  check("before: the offline close made detention_5 for S1, and it was kept",
    made.length === 1 && made[0].id === "detention_5" && keptOn(G)?.[ADMIN_EMAIL]?.detentions.length === 1);
  // A colleague's tab, whose counter the failed save never moved, then saved detention_5 for S2.
  const b = adminSignsIn(G);
  check("nothing kept goes into the lists before the sign-in load brings the server's",
    b.detentions.length === 0 && !b.referrals.some((r) => r.id === "THEIRS-OPEN") && b.restored?.detentions.length === 1);
  check("...and the next detention made here starts above every kept id", b.detentionIdCounter >= 6);
  b.runServerInstall(snap(REFS()), { detentions: [OTHER_KIDS()], detentionIdCounter: 6 });
  const s2 = b.detentions.filter((d) => d.studentId === "S2");
  const s1 = b.detentions.filter((d) => d.studentId === "S1");
  check("the other child's detention_5 is untouched", s2.length === 1 && s2[0].id === "detention_5" && s2[0].sourceReferralId === "OTHER-REF");
  check("this child's detention is back under a new id", s1.length === 1 && s1[0].id !== "detention_5" && s1[0].sourceReferralId === "THEIRS-OPEN");
  check("...no two detentions share an id", new Set(b.detentions.map((d) => d.id)).size === b.detentions.length);
  check("...the counter has moved past it", Number(s1[0].id.replace("detention_", "")) < b.detentionIdCounter);
  check("the load asked for a save to send it", (b.G.requests || []).includes("Unsent work from before sign-out"));
  // The save carrying it lands: the device copy goes, matched as a record despite the new id.
  b.disciplineWriteLanded("referrals", copy(b.referrals), ADMIN_EMAIL, 0);
  b.disciplineWriteLanded("detentions", copy(b.detentions), ADMIN_EMAIL, 0);
  check("once a write carrying it lands, nothing is left on the device or in memory", keptOn(G) === null && b.restored === null);
}

console.log("\n-- a kept copy older than the server's is dropped, not put over it (second review) --");
{
  const { G, a, made, closed } = await adminClosedOffline({ detentionIdCounter: 7 });
  // The save that was running at sign-out lands afterwards.
  a.disciplineWriteLanded("referrals", closed, ADMIN_EMAIL, 0);
  a.disciplineWriteLanded("detentions", made, ADMIN_EMAIL, 0);
  check("a save still running at sign-out takes what it carried off the device when it lands", keptOn(G) === null);
  check("...without noting anything for a tab nobody is signed in to",
    a.onServer.referrals.size === 0 && a.onServer.detentions.size === 0);

  // The landing's answer was lost instead: the device still holds detention_7,
  // and a colleague has since recorded two days served on the server's copy.
  const lost = await adminClosedOffline({ detentionIdCounter: 7 });
  const served = { ...lost.made[0], daysServed: 2, servedDates: ["2026-10-08", "2026-10-09"], updatedAt: "2026-10-09T16:00:00.000Z" };
  const server = lost.closed;
  const b = adminSignsIn(lost.G);
  b.runServerInstall(snap(server), { detentions: [served] });
  check("the colleague's two days served stay on this screen", b.detentions.length === 1 && b.detentions[0].daysServed === 2);
  check("...and the stale kept copy is gone from the device", (keptOn(lost.G)?.[ADMIN_EMAIL]?.detentions || []).length === 0);
}

console.log("\n-- a load that lands mid-save cannot make a save drop kept work unsent (second review) --");
{
  const { G } = await adminClosedOffline({ actions: [DET, "Notified parents/guardians promptly"] });
  const b = adminSignsIn(G);
  b.runServerInstall(snap(REFS()), { detentions: [] });
  check("before: the kept close and detention are back", b.referrals.find((r) => r.id === "THEIRS-OPEN").status === "closed"
    && b.detentions.some((d) => d.sourceReferralId === "THEIRS-OPEN"));
  // A save starts, then another load lands before its snapshot.
  b.putBackUnsentDiscipline();
  b.runServerInstall(snap(REFS()), { detentions: [] });
  const refSent = copy(b.referrals), detSent = copy(b.detentions);
  check("the load puts them straight back, so the snapshot carries them",
    refSent.find((r) => r.id === "THEIRS-OPEN").status === "closed" && detSent.some((d) => d.sourceReferralId === "THEIRS-OPEN"));
  // And a write that carried only the server's lists lands: nothing kept is let go.
  b.disciplineWriteLanded("referrals", REFS(), ADMIN_EMAIL, 0);
  const still = keptOn(G)?.[ADMIN_EMAIL];
  check("a landed write that did not carry the kept rows leaves them on the device",
    still?.referrals.length === 1 && still?.detentions.length === 1);
  check("...and in what the next save puts back", b.restored?.referrals.length === 1 && b.restored?.detentions.length === 1);
  check("Logout would still find them unsent", /1 referral and 1 detention/.test(b.describeUnsentDiscipline()), b.describeUnsentDiscipline());
  b.disciplineWriteLanded("referrals", refSent, ADMIN_EMAIL, 0);
  b.disciplineWriteLanded("detentions", detSent, ADMIN_EMAIL, 0);
  check("the write that carried them lets them go", keptOn(G) === null && b.restored === null);
}

console.log("\n-- a kept detention is never a referral's second active one (second review) --");
{
  // The server's referral is still open, but it already has an active detention.
  const one = await adminClosedOffline();
  const b = adminSignsIn(one.G);
  b.runServerInstall(snap(REFS()), { detentions: [{ id: "detention_6", studentId: "S1", sourceReferralId: "THEIRS-OPEN",
    assignedAt: "2026-10-07T19:00:00.000Z", status: "active" }] });
  check("the kept close still goes over the open referral", b.referrals.find((r) => r.id === "THEIRS-OPEN").status === "closed");
  check("...but its detention is not added beside the active one",
    b.detentions.filter((d) => d.sourceReferralId === "THEIRS-OPEN" && d.status === "active").length === 1);
  check("...and is gone from the device", (keptOn(one.G)?.[ADMIN_EMAIL]?.detentions || []).length === 0);

  // The referral was closed again since, later, with no detention: that close wins, and the kept detention goes with the losing one.
  const two = await adminClosedOffline();
  const later = new Date(Date.now() + 3600e3).toISOString();
  const reclosed = theirs("THEIRS-OPEN", { status: "closed", closedBy: "B Admin", closedAt: later, updatedAt: later,
    resolutionType: "no_action", closingActions: [] });
  const c = adminSignsIn(two.G);
  c.runServerInstall(snap([...REFS().filter((r) => r.id !== "THEIRS-OPEN"), reclosed]), { detentions: [] });
  check("a later close elsewhere keeps the referral", c.referrals.find((r) => r.id === "THEIRS-OPEN").closedBy === "B Admin");
  check("...and the losing close's detention is not added", c.detentions.length === 0);
  check("...nor kept on the device", keptOn(two.G) === null);
}

console.log("\n-- a save lets go of the rows it carried, not a second tab's (second review) --");
{
  const store = makeStorage();
  const { a: X } = teacherWithUnsaved({ localStorage: store });
  await X.logout({ inactive: true });                       // R1 kept
  const A = loadApp(script, world(null, { localStorage: store }));
  A.runServerInstall(snap(REFS()), {});
  A.currentUser = TEACHER;
  A.restoreUnsentDiscipline();                              // R1 back; its first save fails
  const R2 = ref("UNSAVED-TWO");
  const B = loadApp(script, world(TEACHER, { localStorage: store, unsaved: new Map([[R2.id, R2]]) }));
  B.runServerInstall(snap(REFS()), {});
  B.referrals.push(R2);
  await B.logout({ inactive: true });                       // R2 kept beside R1
  check("before: both tabs' referrals are kept for the teacher", ids(JSON.parse(store.getItem(UNSENT))[TEACHER_EMAIL].referrals) === "UNSAVED-NEW,UNSAVED-TWO");
  A.putBackUnsentDiscipline();
  A.disciplineWriteLanded("referrals", copy(A.referrals), TEACHER_EMAIL, 0);   // carries R1 only
  const left = JSON.parse(store.getItem(UNSENT) || "null")?.[TEACHER_EMAIL];
  check("the save that carried R1 takes R1 off the device, and leaves R2",
    ids(left?.referrals) === "UNSAVED-TWO" && J(left?.unsavedIds) === J(["UNSAVED-TWO"]));
}

console.log("\n-- a device that cannot keep the work says so (second review) --");
{
  const quota = () => { const e = new Error("full"); e.name = "QuotaExceededError"; return e; };
  const failing = () => Object.assign(makeStorage(), { setItem() { throw quota(); } });
  let { G, a } = teacherWithUnsaved({ localStorage: failing(), answers: [true, false] });
  await a.logout();
  check("Logout asks again when the work could not be kept", G.confirms.length === 2 && /could not keep 1 referral/.test(G.confirms[1]), J(G.confirms));
  check("...and staying signed in keeps the person, the referral and the bar",
    a.referralCacheOwner() === TEACHER_EMAIL && a.referrals.some((r) => r.id === "UNSAVED-NEW") && a.unsaved.has("UNSAVED-NEW")
    && a.els.unsavedReferralBar.hidden === false);
  ({ G, a } = teacherWithUnsaved({ localStorage: failing(), answers: [true, true] }));
  await a.logout();
  check("'Log out anyway' still logs out", a.referralCacheOwner() === "" && a.referrals.length === 0);

  // An admin's device near full: the school's referrals in raffleData leave no room.
  const capped = (seed, cap) => {
    const m = new Map(Object.entries(seed));
    const size = () => [...m.values()].reduce((n, v) => n + v.length, 0);
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem(k, v) { const old = m.get(k); m.set(k, String(v)); if (size() > cap) { if (old === undefined) m.delete(k); else m.set(k, old); throw quota(); } },
      removeItem: (k) => m.delete(k),
    };
  };
  const school = JSON.stringify({ referralsOwner: ADMIN_EMAIL, cashTransactions: [{ id: "c1" }],
    behaviorReferrals: Array.from({ length: 120 }, (_, i) => theirs("R" + i, { description: "x".repeat(300) })) });
  const full = (src) => {
    const H = world(ADMIN, { localStorage: capped({ raffleData: school }, school.length + 200), actions: ["Notified parents/guardians promptly"] });
    const x = loadApp(src || script, H);
    x.runServerInstall(snap(REFS()), { detentions: [] });
    return { H, x };
  };
  const f = full();
  await f.x.confirmCloseReferral("THEIRS-OPEN");
  await f.x.logout({ inactive: true });
  check("with the cache stripped first, the admin's unsent close fits", keptOn(f.H)?.[ADMIN_EMAIL]?.referrals.length === 1);
  const late = full(breakOnce(script, "                if (typeof stripDisciplineFromLocalCache === 'function') stripDisciplineFromLocalCache();\n                // Before anyone is forgotten",
    "                // Before anyone is forgotten", "strip first"));
  await late.x.confirmCloseReferral("THEIRS-OPEN");
  await late.x.logout({ inactive: true });
  check("TEETH: keeping the work before the strip finds no room for it", keptOn(late.H) === null);
}

console.log("\n-- kept work has an end, and keeps no one else's referral whole (second review) --");
{
  const now = Date.parse("2026-10-07T18:00:00.000Z");
  check("kept six days ago: current", D.setAsideIsCurrent("2026-10-01T18:00:00.000Z", now) === true);
  check("kept fifteen days ago: past its time", D.setAsideIsCurrent("2026-09-22T17:00:00.000Z", now) === false);
  check("kept before 1 July, read after it: past its time",
    D.setAsideIsCurrent("2026-06-29T18:00:00.000Z", Date.parse("2026-07-02T18:00:00.000Z")) === false);
  check("no stamp, a bad stamp, or one days ahead: not current",
    !D.setAsideIsCurrent(undefined, now) && !D.setAsideIsCurrent("soon", now) && !D.setAsideIsCurrent("2026-10-10T18:00:00.000Z", now));

  const { G, a } = teacherWithUnsaved();
  await a.logout({ inactive: true });
  const all = keptOn(G);
  all[TEACHER_EMAIL].at = "2025-06-01T12:00:00.000Z";
  G.localStorage.setItem(UNSENT, J(all));
  const b = loadApp(script, world(null, { localStorage: G.localStorage }));
  b.currentUser = TEACHER;
  check("the same teacher signing in after it expired gets nothing back", b.restoreUnsentDiscipline() === 0 && !b.referrals.some((r) => r.id === "UNSAVED-NEW"));
  check("...and it is gone from the device", G.localStorage.getItem(UNSENT) === null);

  const { G: S, a: s } = teacherWithUnsaved();
  await s.logout({ inactive: true });
  const old = keptOn(S);
  old[TEACHER_EMAIL].at = new Date(Date.now() - 20 * 86400000).toISOString();
  old["other@x.org"] = { at: new Date().toISOString(), referrals: [ref("OTHER-KEPT")], unsavedIds: ["OTHER-KEPT"], detentions: [] };
  S.localStorage.setItem(UNSENT, J(old));
  s.establishStudentSession({ id: "S9" });
  check("a student's sign-in removes what is past its time, and leaves what is current for its author",
    J(Object.keys(keptOn(S))) === J(["other@x.org"]));
  const boot = script.slice(script.indexOf("const hasSession = loadSession();"), script.indexOf("} else if (hasSession) {"));
  check("the page start removes it too, right after the cache drop",
    /dropDisciplineCacheUnlessMine\(\);\s*(\/\/[^\n]*\n\s*)*readUnsentDiscipline\(\);/.test(boot));

  const { G: Q, a: q } = teacherWithUnsaved();
  await q.logout();
  check("the Logout question says how long it stays", /stays on this device for up to 14 days/.test(Q.confirms[0]), Q.confirms[0]);

  const { G: P } = await adminClosedOffline();
  const kept = keptOn(P)[ADMIN_EMAIL].referrals[0];
  check("an admin's Close of a teacher's referral is kept as the close alone",
    kept.id === "THEIRS-OPEN" && kept.status === "closed" && !("studentName" in kept) && !("description" in kept) && !("studentId" in kept));
  const r = adminSignsIn(P);
  r.runServerInstall(snap(REFS()), { detentions: [] });
  const back = r.referrals.find((x) => x.id === "THEIRS-OPEN");
  check("...and goes back over the server's row whole", back.status === "closed" && back.studentName === "Student THEIRS-OPEN"
    && back.closedBy === "A Admin");
  const t = keptOn(Q)?.[TEACHER_EMAIL]?.referrals[0];
  check("a teacher's own unsaved referral is still kept whole", !!t && t.studentName === "Student UNSAVED-NEW" && t.studentId === "S1");
}

console.log("\n-- a referral saved during sign-out, and what is said about it (second review) --");
{
  /** A teacher's tab whose referral save is held open, as a slow network holds it. */
  const submitting = (over) => {
    let release;
    const G = world(TEACHER, Object.assign({ students: [{ id: "S1", firstName: "Kid", lastName: "Synthetic", grade: "9" }] }, over));
    G.saveGate = new Promise((r) => { release = r; });
    const a = loadApp(over && over.src || script, G);
    a.runServerInstall(snap(REFS()), {});
    document_el(a, "referralStudentSelect").value = "S1";
    document_el(a, "referralDate").value = "2026-10-07";
    document_el(a, "referralBehaviorType").value = "Defiance";
    document_el(a, "referralDescription").value = "SYNTHETIC-DESCRIPTION";
    document_el(a, "referralReferringStaff").value = "T Teacher";
    const done = a.submitBehaviorReferral();
    return { G, a, done, release, sent: copy(a.referrals) };
  };

  const one = submitting();
  await one.a.logout();
  check("Logout during the save names the referral as not on the server", /Not on the server yet: 1 referral\./.test(one.G.confirms[0]));
  check("...and keeps it", keptOn(one.G)?.[TEACHER_EMAIL]?.referrals.length === 1);
  // The save that was sending it lands now.
  one.a.disciplineWriteLanded("referrals", one.sent, TEACHER_EMAIL, 0);
  one.release(true); await one.done;
  check("when that save lands, the copy kept on the device goes", keptOn(one.G) === null);
  const save = liftFn(script, "saveData");
  check("saveData takes whose save it is before anything is awaited",
    /const ownerAtStart = referralCacheOwner\(\);/.test(save)
    && save.indexOf("const ownerAtStart = referralCacheOwner();") < save.indexOf("await peekOnceInSave()"));

  for (const landed of [true, false]) {
    const x = submitting();
    await x.a.logout({ inactive: true });
    const before = x.G.toasts.length;
    x.release(landed); await x.done;
    const after = x.G.toasts.slice(before);
    check(`a save that ${landed ? "lands" : "fails"} after sign-out puts no toast naming the child on the login screen`,
      !after.some((t) => /Synthetic/.test(t.message)), J(after));
  }
}

console.log("\n-- only what the person may hold now comes back (second review) --");
{
  const G = world(ADMIN, { actions: [DET], detentionIdCounter: 5 });
  const a = loadApp(script, G);
  a.runServerInstall(snap(REFS()), { detentions: [] });
  await a.confirmCloseReferral("MINE-OPEN");      // a teacher's referral, closed by the admin, with a detention
  await a.logout({ inactive: true });
  check("before: the close and its detention are kept for the admin",
    keptOn(G)?.[ADMIN_EMAIL]?.referrals.length === 1 && keptOn(G)?.[ADMIN_EMAIL]?.detentions.length === 1);
  const b = loadApp(script, world(null, { localStorage: G.localStorage, referrals: [] }));
  b.currentUser = { ...ADMIN, role: "teacher" };   // the same email, moved down to teacher
  b.restoreUnsentDiscipline();
  check("moved down to teacher: neither comes back into this tab's memory", b.restored === null
    && !b.referrals.some((r) => r.id === "MINE-OPEN") && b.detentions.length === 0);
  check("...and neither stays on the device (the owner's call: work this role may not do waits for no one)", keptOn(G) === null);
}

console.log("\n-- TEETH: the second review's fixes, each removed, are caught --");
{
  const brokenD = (from, to, label) => loadD(breakOnce(discSrc, from, to, label));

  const noReId = brokenD("      if (indexWhere(function (x) { return x.id === d.id; }) !== -1) {",
    "      if (false) {", "re-id");
  let { G } = await adminClosedOffline();
  let b = adminSignsIn(G, script, noReId);
  b.runServerInstall(snap(REFS()), { detentions: [OTHER_KIDS()] });
  check("TEETH: without a new id the kept detention shares detention_5 with another child's",
    b.detentions.filter((d) => d.id === "detention_5").length === 2);

  const noGate = breakOnce(script, "                if (_disciplineLoadedGeneration !== _signInGeneration) return null;\n", "", "load gate");
  ({ G } = await adminClosedOffline());
  b = adminSignsIn(G, noGate);
  check("TEETH: without the gate the kept detention goes into the sign-in save before the server's list is here",
    b.detentions.some((d) => d.id === "detention_5" && d.studentId === "S1"));

  const overwrite = brokenD("        if (mine < theirs) { superseded.push(d); return; }\n" +
    "        var row = d.id === out[at].id ? d : withId(d, out[at].id);\n        if (mine > theirs) out[at] = row;",
    "        var row = d.id === out[at].id ? d : withId(d, out[at].id);\n        out[at] = row;", "newer only");
  const lost = await adminClosedOffline({ detentionIdCounter: 7 });
  b = adminSignsIn(lost.G, script, overwrite);
  b.runServerInstall(snap(lost.closed), { detentions: [{ ...lost.made[0], daysServed: 2, updatedAt: "2026-10-09T16:00:00.000Z" }] });
  check("TEETH: a kept copy put over a newer server copy undoes the colleague's two days", b.detentions[0].daysServed === 0);

  const noActive = brokenD("(d.status === 'active' && activeDetentionFor(out, src))", "false", "one active");
  ({ G } = await adminClosedOffline());
  b = adminSignsIn(G, script, noActive);
  b.runServerInstall(snap(REFS()), { detentions: [{ id: "detention_6", studentId: "S1", sourceReferralId: "THEIRS-OPEN",
    assignedAt: "2026-10-07T19:00:00.000Z", status: "active" }] });
  check("TEETH: without the one-active rule the referral gets a second active detention",
    b.detentions.filter((d) => d.sourceReferralId === "THEIRS-OPEN" && d.status === "active").length === 2);

  const noLost = brokenD("(lost && lost.has(src))", "false", "lost close");
  ({ G } = await adminClosedOffline());
  const later = new Date(Date.now() + 3600e3).toISOString();
  b = adminSignsIn(G, script, noLost);
  b.runServerInstall(snap([...REFS().filter((r) => r.id !== "THEIRS-OPEN"),
    theirs("THEIRS-OPEN", { status: "closed", closedBy: "B Admin", closedAt: later, updatedAt: later })]), { detentions: [] });
  check("TEETH: without the lost-close rule a detention from the losing close is added", b.detentions.length === 1);

  const wholesale = breakOnce(script, "                const left = D.rowsNotCoveredBy(kind, before, rows);", "                const left = [];", "only covered rows");
  ({ G } = await adminClosedOffline());
  b = adminSignsIn(G, wholesale);
  b.runServerInstall(snap(REFS()), { detentions: [] });
  b.disciplineWriteLanded("referrals", REFS(), ADMIN_EMAIL, 0);
  check("TEETH: letting go of rows a write did not carry loses the kept close from the device",
    (keptOn(G)?.[ADMIN_EMAIL]?.referrals || []).length === 0);

  const noHook = breakOnce(script, "                        if (_restoredDiscipline && putBackUnsentDiscipline()) {", "                        if (false) {", "load hook");
  ({ G } = await adminClosedOffline());
  b = adminSignsIn(G, noHook);
  b.runServerInstall(snap(REFS()), { detentions: [] });
  check("TEETH: without the load's put-back the kept close is not in the list the next snapshot takes",
    b.referrals.find((r) => r.id === "THEIRS-OPEN").status !== "closed");

  const notOnLanding = breakOnce(script, "            if (generation === _signInGeneration) noteDisciplineOnServer(kind, sent);\n            dropSetAside(owner, kind, sent);",
    "            if (generation === _signInGeneration) noteDisciplineOnServer(kind, sent);", "landing drops");
  const { G: T, a: t } = teacherWithUnsaved();
  const tSent = copy(t.referrals);
  const tl = loadApp(notOnLanding, world(TEACHER, { localStorage: T.localStorage }));
  await t.logout({ inactive: true });
  tl.disciplineWriteLanded("referrals", tSent, TEACHER_EMAIL, 0);
  check("TEETH: a landing that does not touch the kept copy leaves a referral the server holds on the device",
    keptOn(T)?.[TEACHER_EMAIL]?.referrals.length === 1);

  const forever = brokenD("    return t >= yearStart && now - t <= SET_ASIDE_DAYS * DAY_MS;", "    return true;", "expiry");
  const ex = teacherWithUnsaved();
  await ex.a.logout({ inactive: true });
  const all = keptOn(ex.G);
  all[TEACHER_EMAIL].at = "2025-06-01T12:00:00.000Z";
  ex.G.localStorage.setItem(UNSENT, J(all));
  const ev = loadApp(script, world(null, { localStorage: ex.G.localStorage }), forever);
  ev.currentUser = TEACHER;
  check("TEETH: without the expiry last June's referral comes back", ev.restoreUnsentDiscipline() === 1);

  const whole = brokenD("  function closePatch(r) {\n", "  function closePatch(r) {\n    return r;\n", "close only");
  const W = world(ADMIN, { actions: [DET], detentionIdCounter: 5 });
  const w = loadApp(script, W, whole);
  w.runServerInstall(snap(REFS()), { detentions: [] });
  await w.confirmCloseReferral("THEIRS-OPEN");
  await w.logout({ inactive: true });
  check("TEETH: without the close-only copy the device keeps the teacher's description and the child's name",
    "studentName" in keptOn(W)[ADMIN_EMAIL].referrals[0]);

  const noCut = breakOnce(script, "            if (!refsOut.length && !detsOut.length) return;\n", "            return;\n", "role cut");
  const C = world(ADMIN, { actions: [DET], detentionIdCounter: 5 });
  const cA = loadApp(script, C);
  cA.runServerInstall(snap(REFS()), { detentions: [] });
  await cA.confirmCloseReferral("MINE-OPEN");
  await cA.logout({ inactive: true });
  const cB = loadApp(noCut, world(null, { localStorage: C.localStorage }));
  cB.currentUser = { ...ADMIN, role: "teacher" };
  cB.restoreUnsentDiscipline();
  check("TEETH: without the cut a demoted person's tab holds the kept close and detention", cB.restored?.detentions.length === 1);

  const ask = breakOnce(script, "                if (notKept && !inactive && !(await showConfirm(", "                if (false && !(await showConfirm(", "ask on failure");
  const failing = Object.assign(makeStorage(), { setItem() { const e = new Error("full"); e.name = "QuotaExceededError"; throw e; } });
  const R = ref("UNSAVED-NEW");
  const F = world(TEACHER, { localStorage: failing, unsaved: new Map([[R.id, R]]), answers: [true, false] });
  const fa = loadApp(ask, F);
  fa.runServerInstall(snap(REFS()), {});
  fa.referrals.push(R);
  await fa.logout();
  check("TEETH: without the second question a full device signs out and loses the referral", fa.referrals.length === 0);

  const chatty = script.replace("                if (generation !== _signInGeneration) return;\n                if (ok === false)", "                if (ok === false)")
    .replace("                console.error('[referral] save failed', e);\n                if (generation !== _signInGeneration) return;\n", "                console.error('[referral] save failed', e);\n");
  if (chatty === script) throw new Error("teeth: toast guard anchors moved");
  let rel;
  const K = world(TEACHER, { students: [{ id: "S1", firstName: "Kid", lastName: "Synthetic", grade: "9" }] });
  K.saveGate = new Promise((r) => { rel = r; });
  const k = loadApp(chatty, K);
  k.runServerInstall(snap(REFS()), {});
  for (const [id, v] of [["referralStudentSelect", "S1"], ["referralDate", "2026-10-07"], ["referralBehaviorType", "Defiance"],
    ["referralDescription", "SYNTHETIC-DESCRIPTION"], ["referralReferringStaff", "T Teacher"]]) document_el(k, id).value = v;
  const kd = k.submitBehaviorReferral();
  await k.logout({ inactive: true });
  const n = K.toasts.length;
  rel(true); await kd;
  check("TEETH: without the sign-in check the login screen gets a toast naming the child", K.toasts.slice(n).some((x) => /Synthetic/.test(x.message)));
}

console.log("\n-- the page these run in --");
{
  check("index.html has the Open Referrals table these draw into", /id="referralReviewTable"/.test(html));
  check("...and the Closed Referrals list", /id="closedReferralsList"/.test(html));
  check(".tag-neutral, used for the status text, is styled",
    /\.tag-neutral \{/.test(readFileSync(new URL("./styles.css", import.meta.url), "utf8")));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
