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
// SIGN-OUT (2026-10-07). Emptying the record at sign-out must not leave the
// "not saved yet" bar naming a child on the login screen, and must not lose a
// person's own unsent work behind their back: the Logout button names it and
// asks once (Stay signed in / Log out anyway); the inactivity logout and a
// closed tab keep that person's own new referrals on the device for their next
// sign-in, and nobody else's, and no detention. A read or a save still out at
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
  // Review, 2026-10-07: the bar, late answers, and work the server has not got.
  "clearSentFromUnsaved", "renderUnsavedReferralBar", "retryUnsavedReferrals", "pullReferralsOnce",
  "pullReferralsAndRedraw", "updateStudentReferralHistory", "submitBehaviorReferral", "markReferralUnsaved",
  "markReferralSaved", "keepUnsavedReferralsInList", "unsavedWorkAtLogout", "ownUnsavedReferrals",
  "keptReferralsInCache", "restoreOwnUnsavedReferrals",
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
    async function showConfirm(message, opts) {
      (G.confirms ||= []).push(message);
      (G.confirmOpts ||= []).push(opts || null);
      return G.answers && G.answers.length ? G.answers.shift() : true;
    }
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
    let _signInGeneration = 0;
    // What the Logout question reads for a save still out: a direct saveData,
    // and the save queue's pending flag (unsavedWorkAtLogout).
    let isSyncing = G.isSyncing || false;
    const _saveQueue = G.saveQueue || null;
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
      get currentUser() { return currentUser; },
      set currentUser(v) { currentUser = v; },
      get unsaved() { return _unsavedReferrals; },
      get detentionIdCounter() { return detentionIdCounter; },
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

// ---------------------------------------------------------------- work the server has not got, at sign-out (2026-10-07)
//
// (A) The Logout button names it and asks once: Stay signed in changes
// nothing, Log out anyway loses it. (B) The inactivity logout and a closed tab
// keep the signed-in person's own new referrals that never reached the server
// -- in raffleData, stamped with their email, listed by id -- and nothing
// else; only that same email's next sign-in takes them back, onto the "not
// saved yet" bar, and the ordinary save sends them.

const snap = (rows) => ({ exists: () => true, data: () => ({ behaviorReferrals: rows }) });
const ids = (rows) => (rows || []).map((r) => r.id).sort().join();
const TEACHER_EMAIL = "t.teacher@x.org";
const OTHER = { id: "t2", role: "teacher", email: "other@x.org", name: "O Other" };
/** What the failed save left in the device cache: everything this tab holds, through the real cut. */
const failedSaveCache = (a) => a.cacheLocally({ behaviorReferrals: a.referrals, detentions: a.detentions,
  cashTransactions: [{ id: "c1" }], auditLog: [], students: [] });
/** A teacher's tab as a failed save leaves it: their referrals loaded, one filed and not saved, the cache written. */
function teacherWithUnsaved(over, src, Dmod) {
  const R = ref("UNSAVED-NEW");
  const G = world(TEACHER, Object.assign({ unsaved: new Map([[R.id, R]]) }, over));
  const a = loadApp(src || script, G, Dmod);
  a.runServerInstall(snap(REFS()), {});
  a.referrals.push(R);                 // submitBehaviorReferral pushes, then marks it unsaved
  a.renderUnsavedReferralBar();
  failedSaveCache(a);
  return { G, a, R };
}
/** The same browser, a new page: only localStorage carries over. */
const newPage = (G, user, src, over) => loadApp(src || script, world(user || null,
  Object.assign({ localStorage: G.localStorage, referrals: [] }, over)));
/** A sign-in on tab `x`: the listener's load (which does not have the referral), then the session core. */
function signsIn(x, user) {
  x.runServerInstall(snap(REFS()), {});
  x.currentUser = user;
  x.shedReferralsNotMine();
  return x.restoreOwnUnsavedReferrals();
}

console.log("\n-- (A) Logout names a referral the server has not got, and asks once --");
{
  const { G, a } = teacherWithUnsaved({ answers: [false], sessionStorage: makeStorage({ currentUser: "{}" }) });
  const cacheBefore = G.localStorage.getItem("raffleData");
  const listBefore = J(a.referrals);
  await a.logout();
  check("one question, in plain words",
    J(G.confirms) === J(["Not saved yet: 1 referral. If you log out now, it will be lost from this device."]), J(G.confirms));
  check("...whose buttons are the choice: Stay signed in, Log out anyway",
    G.confirmOpts[0]?.cancelLabel === "Stay signed in" && G.confirmOpts[0]?.confirmLabel === "Log out anyway");
  check("Stay signed in: still signed in", a.currentUser === TEACHER && G.sessionStorage.getItem("currentUser") === "{}");
  check("...the list as it was", J(a.referrals) === listBefore);
  check("...the bar still names the child", a.unsaved.has("UNSAVED-NEW") && a.els.unsavedReferralBar.hidden === false);
  check("...and the device cache untouched", G.localStorage.getItem("raffleData") === cacheBefore);
}
{
  const { G, a } = teacherWithUnsaved({ answers: [true] });
  await a.logout();
  check("Log out anyway: signed out", a.currentUser === null);
  check("...memory and the bar are empty", a.referrals.length === 0 && a.unsaved.size === 0 && a.els.unsavedReferralBar.hidden === true);
  const b = blobIn(G);
  check("...and nothing is kept on the device: no referrals, no stamp, no list of unsaved ones",
    !("behaviorReferrals" in b) && !("referralsOwner" in b) && !("unsavedReferralIds" in b) && !("detentions" in b), J(Object.keys(b)));
  check("...the rest of the cache stays (unsaved cash is recovered from it)", b.cashTransactions.length === 1);
  const c = newPage(G, null);
  check("...so the same teacher's next sign-in brings nothing back", signsIn(c, TEACHER) === 0 && c.unsaved.size === 0);
}
{
  const two = teacherWithUnsaved({ answers: [false] });
  two.a.unsaved.set("UNSAVED-2", ref("UNSAVED-2"));
  await two.a.logout();
  check("two referrals: 'Not saved yet: 2 referrals ... they will be lost'",
    two.G.confirms[0] === "Not saved yet: 2 referrals. If you log out now, they will be lost from this device.", two.G.confirms[0]);

  // An admin's Close or a detention still being sent, or waiting to try again.
  for (const [label, over] of [["a save the queue is still retrying", { saveQueue: { isPending: () => true } }],
                               ["a direct save in flight", { isSyncing: true }]]) {
    const G = world(ADMIN, Object.assign({ answers: [false] }, over));
    const a = loadApp(script, G);
    await a.logout();
    check(`${label}: the same one question`,
      G.confirms[0] === "Not saved yet: changes this tab is still sending to the server. If you log out now, they will be lost from this device."
      && G.confirmOpts[0]?.confirmLabel === "Log out anyway", G.confirms[0]);
    check(`...and Stay signed in keeps them signed in`, a.currentUser === ADMIN && a.referrals.length === 4);
  }
  const plain = world(ADMIN, { saveQueue: { isPending: () => false } });
  const p = loadApp(script, plain);
  await p.logout();
  check("nothing unsaved: the usual question, with the usual buttons",
    J(plain.confirms) === J(["Are you sure you want to logout?"]) && plain.confirmOpts[0] === null);
  check("...and the inactivity logout asks nothing", await (async () => {
    const q = teacherWithUnsaved(); await q.a.logout({ inactive: true }); return !(q.G.confirms || []).length; })());
}

console.log("\n-- (B) the inactivity logout keeps the teacher's own unsaved referral, and nothing else --");
{
  const { G, a } = teacherWithUnsaved();
  check("before: the device cache holds the teacher's three referrals, the unsaved one listed",
    ids(blobIn(G).behaviorReferrals) === "MINE-CLOSED,MINE-OPEN,UNSAVED-NEW" && J(blobIn(G).unsavedReferralIds) === J(["UNSAVED-NEW"]));
  await a.logout({ inactive: true });
  const b = blobIn(G);
  check("after: only the unsaved referral stays", ids(b.behaviorReferrals) === "UNSAVED-NEW");
  check("...whole, as filed", b.behaviorReferrals[0].studentName === "Student UNSAVED-NEW" && b.behaviorReferrals[0].studentId === "S1");
  check("...stamped with the teacher's email", b.referralsOwner === TEACHER_EMAIL);
  check("...listed as not saved yet", J(b.unsavedReferralIds) === J(["UNSAVED-NEW"]));
  check("...no detentions", !("detentions" in b));
  check("...the rest of the cache as it was", b.cashTransactions.length === 1);
  check("memory, the screens' list and the bar are empty, as for any sign-out",
    a.referrals.length === 0 && a.unsaved.size === 0 && a.els.unsavedReferralBar.hidden === true);
}

console.log("\n-- (B) ...and the same teacher signing back in, in the same tab (the app), gets it back and sends it --");
{
  const { G, a } = teacherWithUnsaved();
  await a.logout({ inactive: true });
  check("the same teacher's sign-in brings it back", signsIn(a, TEACHER) === 1);
  check("...onto the bar, so they know it is still not on the server",
    a.unsaved.has("UNSAVED-NEW") && a.els.unsavedReferralBar.hidden === false);
  check("...and into the list, once", a.referrals.filter((r) => r.id === "UNSAVED-NEW").length === 1);
  // The sign-in's own load can land after that and replace the list.
  a.runServerInstall(snap(REFS()), {});
  a.keepUnsavedReferralsInList();
  const sent = new Set(a.referrals.map((r) => r.id));
  check("the sign-in's save still sends it, once", sent.has("UNSAVED-NEW") && a.referrals.filter((r) => r.id === "UNSAVED-NEW").length === 1);
  a.clearSentFromUnsaved(new Set(a.unsaved.keys()), sent);
  check("once it lands, the bar lets it go", a.unsaved.size === 0);
  failedSaveCache(a);
  check("...and the next cache write no longer lists it as unsaved", J(blobIn(G).unsavedReferralIds) === "[]");
  const core = liftFn(script, "establishTeacherSessionCore");
  check("establishTeacherSessionCore sheds, brings it back, then saves, in that order",
    /shedReferralsNotMine\(\);[\s\S]*?restoreOwnUnsavedReferrals\(\);[\s\S]*?await saveData\(\);/.test(core));
}

console.log("\n-- (B) ...and through the web sign-in, which reloads the page --");
{
  const { G, a } = teacherWithUnsaved();
  await a.logout({ inactive: true });
  const b = newPage(G, null);
  b.runLocalRestore(blobIn(G));          // loadDataLocal, at page start, nobody signed in
  check("page start, nobody signed in: nothing in memory", b.referrals.length === 0 && b.unsaved.size === 0);
  b.dropDisciplineCacheUnlessMine();
  check("...and the page start's drop leaves it on the device for its author",
    ids(blobIn(G).behaviorReferrals) === "UNSAVED-NEW" && blobIn(G).referralsOwner === TEACHER_EMAIL);
  b.clearSession();                      // an expired session at page start, a student leaving the portal
  check("...as does any sign-out with nobody signed in", ids(blobIn(G).behaviorReferrals) === "UNSAVED-NEW");
  check("the same teacher signs in: it comes back onto the bar", signsIn(b, TEACHER) === 1 && b.unsaved.has("UNSAVED-NEW"));
  b.runServerInstall(snap(REFS()), {});  // the load landing after the sign-in
  b.keepUnsavedReferralsInList();
  check("...and the save sends it", b.referrals.some((r) => r.id === "UNSAVED-NEW"));
}

console.log("\n-- (B) a closed tab keeps it too, and the same session's reload gets it back --");
{
  const { G } = teacherWithUnsaved();
  await G.listeners.pagehide();
  const b = blobIn(G);
  check("pagehide still flushes saves", (G.flushes || []).length === 1);
  check("...and keeps only the unsaved referral, stamped and listed",
    ids(b.behaviorReferrals) === "UNSAVED-NEW" && b.referralsOwner === TEACHER_EMAIL && J(b.unsavedReferralIds) === J(["UNSAVED-NEW"])
    && !("detentions" in b));
  // A reload keeps the session (sessionStorage) and loses memory.
  const r = newPage(G, TEACHER);
  check("the restored session puts it back on the bar", r.restoreOwnUnsavedReferrals() === 1 && r.unsaved.has("UNSAVED-NEW"));
  const at = script.indexOf("} else if (hasSession) {");
  const boot = script.slice(at, script.indexOf("} else if (currentStudent) {", at));
  check("...which the page start does for a restored staff session", /restoreOwnUnsavedReferrals\(\);/.test(boot));
  // A new tab: the session is gone, and the same teacher signs in.
  const n = newPage(G, null);
  n.dropDisciplineCacheUnlessMine();
  check("a new tab: the same teacher's sign-in brings it back", signsIn(n, TEACHER) === 1);
}

console.log("\n-- (B) nobody else ever gets it --");
{
  // The same tab (the app), the next teacher.
  const { G, a } = teacherWithUnsaved();
  await a.logout({ inactive: true });
  check("another teacher signing in on the tab gets nothing back", signsIn(a, OTHER) === 0
    && !a.referrals.some((r) => r.id === "UNSAVED-NEW") && a.unsaved.size === 0 && a.els.unsavedReferralBar.hidden === true);
  a.keepUnsavedReferralsInList();
  check("...their save does not carry it", !a.referrals.some((r) => r.id === "UNSAVED-NEW"));
  failedSaveCache(a);
  check("...and their first cache write makes the cache theirs: it is gone, never theirs",
    blobIn(G).referralsOwner === "other@x.org" && !blobIn(G).behaviorReferrals.some((r) => r.id === "UNSAVED-NEW"));
  // Had the save in fact landed, the server sends it to the next teacher: they do not keep it.
  const H = teacherWithUnsaved();
  await H.a.logout({ inactive: true });
  H.a.runServerInstall(snap([...REFS(), ref("UNSAVED-NEW")]), {});
  H.a.currentUser = OTHER;
  H.a.shedReferralsNotMine();
  failedSaveCache(H.a);
  check("served to the next teacher, it stays in neither their memory nor their cache",
    !H.a.referrals.some((r) => r.id === "UNSAVED-NEW") && !blobIn(H.G).behaviorReferrals.some((r) => r.id === "UNSAVED-NEW"));
}
{
  const { G, a } = teacherWithUnsaved();
  await a.logout({ inactive: true });
  for (const [label, user] of [["another teacher on a new page", OTHER], ["an admin", ADMIN], ["PBIS", PBIS]]) {
    const b = newPage(G, null);
    b.dropDisciplineCacheUnlessMine();
    check(`${label}: nothing comes back`, signsIn(b, user) === 0 && !b.referrals.some((r) => r.id === "UNSAVED-NEW") && b.unsaved.size === 0);
  }
  const s = newPage(G, null);
  s.establishStudentSession({ id: "S1" });
  check("a student: nothing in memory, nothing on the bar", s.referrals.length === 0 && s.unsaved.size === 0
    && s.restoreOwnUnsavedReferrals() === 0);
  const pv = newPage(G, { ...TEACHER }, script, { realUser: ADMIN });
  check("an admin looking through that teacher's eyes: nothing", pv.restoreOwnUnsavedReferrals() === 0 && pv.unsaved.size === 0);
}

console.log("\n-- (B) others' referrals and detentions never stay --");
{
  // An admin's tab: the whole school and its detentions, an unsent Close with
  // the detention it made, one referral the admin filed and could not save,
  // and -- however it got there -- a colleague's unsaved referral on the bar.
  const MINE = ref("ADMIN-NEW", { filedByEmail: "Admin@x.org", referredByEmail: "admin@x.org", referredBy: "A Admin" });
  const COLLEAGUE = theirs("COLLEAGUE-NEW");
  const G = world(ADMIN, { actions: ["Assigned the student to mandatory detention"], detentionIdCounter: 5,
    unsaved: new Map([[MINE.id, MINE], [COLLEAGUE.id, COLLEAGUE]]) });
  const a = loadApp(script, G);
  a.runServerInstall(snap(REFS()), { detentions: DETS1() });
  a.referrals.push(MINE, COLLEAGUE);
  await a.confirmCloseReferral("MINE-OPEN");
  check("before: the close and its new detention exist only in this tab",
    a.referrals.find((r) => r.id === "MINE-OPEN").status === "closed" && a.detentions.length === 2);
  failedSaveCache(a);
  check("...and the device cache holds the whole school", blobIn(G).behaviorReferrals.length === 6 && blobIn(G).detentions.length === 2);
  await a.logout({ inactive: true });
  const b = blobIn(G);
  check("after the inactivity logout only the admin's own unsaved referral stays", ids(b.behaviorReferrals) === "ADMIN-NEW", ids(b.behaviorReferrals));
  check("...not the colleague's, though it was on the bar", !b.behaviorReferrals.some((r) => r.id === "COLLEAGUE-NEW"));
  check("...no detention, and not the unsent Close (the accepted limit)", !("detentions" in b) && !b.behaviorReferrals.some((r) => r.id === "MINE-OPEN"));
  // The same through pagehide.
  const H = world(ADMIN, { unsaved: new Map([[MINE.id, MINE], [COLLEAGUE.id, COLLEAGUE]]) });
  const h = loadApp(script, H);
  h.runServerInstall(snap([...REFS(), MINE, COLLEAGUE]), { detentions: DETS1() });
  failedSaveCache(h);
  await H.listeners.pagehide();
  check("a closed admin tab keeps the same and no more", ids(blobIn(H).behaviorReferrals) === "ADMIN-NEW" && !("detentions" in blobIn(H)));
  // With nothing unsaved, nothing stays at all.
  const { G: N, a: n } = drawnAdminTab(script);
  n.runServerInstall(snap(REFS()), { detentions: DETS1() });
  failedSaveCache(n);
  await n.logout({ inactive: true });
  check("an admin with nothing unsaved leaves no referral, detention or stamp on the device",
    !("behaviorReferrals" in blobIn(N)) && !("detentions" in blobIn(N)) && !("referralsOwner" in blobIn(N)));
}

console.log("\n-- (B) what keeps it there until its author is back --");
{
  // The save that failed to send it is still being retried by the queue after
  // the inactivity logout, with nobody signed in. Its cache write must not
  // write over the only copy.
  const { G, a } = teacherWithUnsaved();
  await a.logout({ inactive: true });
  a.cacheLocally({ behaviorReferrals: REFS(), detentions: DETS1(), cashTransactions: [{ id: "c2" }], auditLog: [] });
  const b = blobIn(G);
  check("a save with nobody signed in leaves the kept referral, its stamp and its listing",
    ids(b.behaviorReferrals) === "UNSAVED-NEW" && b.referralsOwner === TEACHER_EMAIL && J(b.unsavedReferralIds) === J(["UNSAVED-NEW"]));
  check("...writes no one's referrals or detentions from the tab", b.detentions.length === 0);
  check("...and the rest of the cache as usual", b.cashTransactions[0].id === "c2");
  // A Microsoft sign-in that has not reached establishTeacherSessionCore yet.
  const m = newPage(G, null, script, { auth: { getSession: () => ({ me: { kind: "staff", email: TEACHER_EMAIL } }) } });
  m.runServerInstall(snap(REFS()), { detentions: DETS1() });
  failedSaveCache(m);
  check("...nor does a save between a Microsoft sign-in and the app's own", ids(blobIn(G).behaviorReferrals) === "UNSAVED-NEW");
  // A tab that dies with no pagehide (a crash, a battery): the last save listed it.
  const { G: C } = teacherWithUnsaved();
  const c = newPage(C, null);
  c.dropDisciplineCacheUnlessMine();
  check("a tab that died without a pagehide still leaves the unsaved referral, and only it",
    ids(blobIn(C).behaviorReferrals) === "UNSAVED-NEW" && !("detentions" in blobIn(C)));
  check("...for its author's sign-in", signsIn(c, TEACHER) === 1 && J([...c.unsaved.keys()]) === J(["UNSAVED-NEW"]));
  const A = world(null, { localStorage: makeStorage({ raffleData: adminCache({ unsavedReferralIds: ["MINE-OPEN", "THEIRS-OPEN"] }) }) });
  loadApp(script, A).dropDisciplineCacheUnlessMine();
  check("an admin's crashed tab: nothing the admin did not file stays, listed or not", !("behaviorReferrals" in blobIn(A)));
  const { G: R2, a: r2 } = teacherWithUnsaved();
  await r2.rescopeDisciplineForRole("admin");      // moved down to teacher mid-session
  check("a role lowered mid-session strips the cache and keeps it too", ids(blobIn(R2).behaviorReferrals) === "UNSAVED-NEW");
}

console.log("\n-- the bar never lists a referral no save will send (review) --");
{
  // A load replaced the list while a referral was still unsaved (no sign-out
  // involved): it left the list and stayed on the bar, so no save could send
  // it and the bar could never clear.
  const { a } = teacherWithUnsaved();
  a.runServerInstall(snap(REFS()), {});
  check("before: on the bar, not in the list", a.unsaved.has("UNSAVED-NEW") && !a.referrals.some((r) => r.id === "UNSAVED-NEW"));
  a.keepUnsavedReferralsInList();
  check("the save's first step puts it back in the list it sends", a.referrals.some((r) => r.id === "UNSAVED-NEW"));
  const once = a.referrals.length;
  a.keepUnsavedReferralsInList();
  check("...once", a.referrals.length === once);
  const pv = loadApp(script, world({ ...TEACHER }, { realUser: ADMIN, unsaved: new Map([["X", ref("X")]]) }));
  pv.keepUnsavedReferralsInList();
  check("...and never into a teacher view's list, which is the admin's", !pv.referrals.some((r) => r.id === "X"));
}

console.log("\n-- a student's sign-in takes the bar and its list too (review) --");
{
  const { a } = teacherWithUnsaved();
  a.currentUser = null;
  a.establishStudentSession({ id: "S1" });
  check("the bar is hidden and its list empty", a.els.unsavedReferralBar.hidden === true && a.unsaved.size === 0);
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
  check("saveData puts the bar's referrals back in the list before it takes its snapshot",
    save.indexOf("            keepUnsavedReferralsInList();") !== -1
    && save.indexOf("            keepUnsavedReferralsInList();") < save.indexOf("const unsavedAtStart = {"));
  check("...clears the bar by what the referral write sent, never wholesale",
    /clearSentFromUnsaved\(unsavedAtStart\.referrals, referralIdsSent\);/.test(save)
    && !/unsavedAtStart\.referrals\.forEach\(id => _unsavedReferrals\.delete\(id\)\)/.test(save));
  check("...takes the ids as the list goes, and records them only after the write resolves",
    /const refIdsGoing = new Set\(\(behaviorReferrals[^\n]*\n\s*const refSaved = await mergeLegacySlice\('referrals'[^\n]*\n\s*referralIdsSent = refIdsGoing;/.test(save));
  const out = liftFn(script, "logout");
  check("logout decides what stays on the device before it forgets who is signed in",
    out.indexOf("stripDisciplineFromLocalCache(inactive") !== -1
    && out.indexOf("stripDisciplineFromLocalCache(inactive") < out.indexOf("currentUser = null;"));
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

/** The page's pagehide listener, as shipped. */
const PAGEHIDE = "window.addEventListener('pagehide', function () { flushSaves(); stripDisciplineFromLocalCache(ownUnsavedReferrals()); });";

console.log("\n-- TEETH: the sign-out review fixes, each removed, are caught --");
{
  const keepsBar = breakOnce(script, "                _unsavedReferrals.clear();\n                renderUnsavedReferralBar();",
    "                renderUnsavedReferralBar();", "bar cleared");
  const kb = teacherWithUnsaved({}, keepsBar).a;
  await kb.logout({ inactive: true });
  check("TEETH: a sign-out that keeps the bar's list leaves the child named on the login screen",
    kb.els.unsavedReferralBar.hidden === false && kb.unsaved.size === 1);

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

  const keepsOnClose = breakOnce(script, PAGEHIDE, "window.addEventListener('pagehide', function () { flushSaves(); });", "pagehide strip");
  const C = world(ADMIN, { localStorage: makeStorage({ raffleData: adminCache() }) });
  loadApp(keepsOnClose, C);
  await C.listeners.pagehide();
  check("TEETH: a pagehide that only flushes leaves the school's referrals in localStorage", blobIn(C).behaviorReferrals.length === 4);
}

console.log("\n-- a referral save that settles after sign-out says nothing (review) --");
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
    return { G, a, done, release };
  };

  const one = submitting();
  await one.a.logout();
  check("Logout during the save names the referral as not saved yet", /^Not saved yet: 1 referral\./.test(one.G.confirms[0]), one.G.confirms[0]);
  one.release(true); await one.done;

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

console.log("\n-- TEETH: work the server has not got, at sign-out: each rule, removed, is caught --");
{
  // (A) the Logout question.
  const silent = breakOnce(script, "const unsaved = !inactive && typeof unsavedWorkAtLogout === 'function' ? unsavedWorkAtLogout() : '';",
    "const unsaved = '';", "logout names it");
  const sq = teacherWithUnsaved({ answers: [false] }, silent);
  await sq.a.logout();
  check("TEETH: a Logout that does not name the unsaved referral asks the usual question", sq.G.confirms[0] === "Are you sure you want to logout?");

  const noSending = breakOnce(script, "const sending = isSyncing === true || Boolean(_saveQueue && _saveQueue.isPending());",
    "const sending = false;", "pending save");
  const ns = world(ADMIN, { answers: [false], saveQueue: { isPending: () => true } });
  await loadApp(noSending, ns).logout();
  check("TEETH: a Logout blind to a save still being retried asks the usual question", ns.confirms[0] === "Are you sure you want to logout?");

  const stayLeaves = breakOnce(script, "            if (inactive || await showConfirm(question, buttons)) {",
    "            await showConfirm(question, buttons); {", "stay");
  const sl = teacherWithUnsaved({ answers: [false] }, stayLeaves);
  await sl.a.logout();
  check("TEETH: a Stay signed in that does not stay signs the teacher out", sl.a.currentUser === null);

  const buttonKeeps = breakOnce(script,
    "stripDisciplineFromLocalCache(inactive && typeof ownUnsavedReferrals === 'function' ? ownUnsavedReferrals() : []);",
    "stripDisciplineFromLocalCache(typeof ownUnsavedReferrals === 'function' ? ownUnsavedReferrals() : []);", "button discards");
  const bk = teacherWithUnsaved({ answers: [true] }, buttonKeeps);
  await bk.a.logout();
  check("TEETH: a Log out anyway that keeps the work leaves it on the device", "behaviorReferrals" in blobIn(bk.G));

  // (B) what the inactivity logout and a closed tab keep.
  const idleDrops = breakOnce(script,
    "stripDisciplineFromLocalCache(inactive && typeof ownUnsavedReferrals === 'function' ? ownUnsavedReferrals() : []);",
    "stripDisciplineFromLocalCache([]);", "idle keeps");
  const id = teacherWithUnsaved({}, idleDrops);
  await id.a.logout({ inactive: true });
  check("TEETH: an inactivity logout that keeps nothing loses the teacher's referral", !("behaviorReferrals" in blobIn(id.G)));

  const closeDrops = breakOnce(script, PAGEHIDE, "window.addEventListener('pagehide', function () { flushSaves(); stripDisciplineFromLocalCache([]); });", "pagehide keeps");
  const cd = teacherWithUnsaved({}, closeDrops);
  await cd.G.listeners.pagehide();
  check("TEETH: a closed tab that keeps nothing loses the teacher's referral", !("behaviorReferrals" in blobIn(cd.G)));

  const forgetsKept = breakOnce(script, ": keptReferralsInCache(data);", ": { owner: '', rows: [] };", "strip keeps kept");
  const fk = teacherWithUnsaved({}, forgetsKept);
  await fk.a.logout({ inactive: true });
  newPage(fk.G, null, forgetsKept).dropDisciplineCacheUnlessMine();
  check("TEETH: a page start that forgets what the cache keeps loses the referral before its author is back",
    !("behaviorReferrals" in blobIn(fk.G)));

  const anyonesD = loadD(breakOnce(discSrc,
    "        (trimmed(r.filedByEmail).toLowerCase() === who || trimmed(r.referredByEmail).toLowerCase() === who);",
    "        true;", "filed by"));
  const MINE = ref("ADMIN-NEW", { filedByEmail: "admin@x.org", referredByEmail: "admin@x.org" });
  const COLLEAGUE = theirs("COLLEAGUE-NEW");
  const AG = world(ADMIN, { unsaved: new Map([[MINE.id, MINE], [COLLEAGUE.id, COLLEAGUE]]) });
  const ag = loadApp(script, AG, anyonesD);
  ag.runServerInstall(snap([...REFS(), MINE, COLLEAGUE]), { detentions: DETS1() });
  failedSaveCache(ag);
  await ag.logout({ inactive: true });
  check("TEETH: keeping every unsaved referral, whoever filed it, leaves a colleague's on the device",
    blobIn(AG).behaviorReferrals.some((r) => r.id === "COLLEAGUE-NEW"));

  const unlisted = breakOnce(script, "referralsFiledBy(rows.filter(r => r && ids.has(r.id)), owner);", "referralsFiledBy(rows, owner);", "listed only");
  const { G: UG } = teacherWithUnsaved({}, unlisted);
  const ul = newPage(UG, null, unlisted);
  ul.dropDisciplineCacheUnlessMine();
  check("TEETH: keeping what is not listed as unsaved puts saved referrals on the bar as unsaved",
    signsIn(ul, TEACHER) === 3);

  const anyStamp = breakOnce(script, "                if (!data || !localCacheIsMine(data)) return 0;", "                if (!data) return 0;", "restore stamp");
  const as = teacherWithUnsaved({}, anyStamp);
  await as.a.logout({ inactive: true });
  check("TEETH: a restore that ignores whose the cache is hands the referral to the next teacher",
    signsIn(as.a, OTHER) === 1 && as.a.referrals.some((r) => r.id === "UNSAVED-NEW"));

  const listOnly = breakOnce(script, "                    _unsavedReferrals.set(r.id, r);\n", "", "restore to bar");
  const lo = teacherWithUnsaved({}, listOnly);
  await lo.a.logout({ inactive: true });
  signsIn(lo.a, TEACHER);
  lo.a.runServerInstall(snap(REFS()), {});
  lo.a.keepUnsavedReferralsInList();
  check("TEETH: a restore into the list alone is undone by the sign-in's load, and nothing sends it",
    !lo.a.referrals.some((r) => r.id === "UNSAVED-NEW"));

  const noPutBack = breakOnce(script, "                _unsavedReferrals.forEach((r, id) => { if (!have.has(id)) behaviorReferrals.push(r); });\n", "", "put back");
  const np = teacherWithUnsaved({}, noPutBack);
  np.a.runServerInstall(snap(REFS()), {});
  np.a.keepUnsavedReferralsInList();
  check("TEETH: without the put-back the save never sends a referral the bar still names",
    np.a.unsaved.has("UNSAVED-NEW") && !np.a.referrals.some((r) => r.id === "UNSAVED-NEW"));

  const wipes = breakOnce(script, "                    const kept = keptReferralsInCache(stored);", "                    const kept = { owner: '', rows: [] };", "no-owner write");
  const wp = teacherWithUnsaved({}, wipes);
  await wp.a.logout({ inactive: true });
  wp.a.cacheLocally({ behaviorReferrals: [], detentions: [], auditLog: [] });
  check("TEETH: a save retried with nobody signed in writes over the kept referral", blobIn(wp.G).behaviorReferrals.length === 0);

  const sessionOwns = breakOnce(script, "const owner = currentUser ? referralCacheOwner() : '';", "const owner = referralCacheOwner();", "app sign-in");
  const so = teacherWithUnsaved({}, sessionOwns);
  await so.a.logout({ inactive: true });
  const ms = newPage(so.G, null, sessionOwns, { auth: { getSession: () => ({ me: { kind: "staff", email: TEACHER_EMAIL } }) } });
  ms.runServerInstall(snap(REFS()), { detentions: DETS1() });
  failedSaveCache(ms);
  check("TEETH: a save between a Microsoft sign-in and the app's own writes over it (and writes the school)",
    !blobIn(so.G).behaviorReferrals.some((r) => r.id === "UNSAVED-NEW") && blobIn(so.G).behaviorReferrals.length === 4);

  const noList = breakOnce(script, "                out.unsavedReferralIds = (ownUnsavedReferrals() || []).map(r => r.id);\n", "", "list in cache");
  const { G: NL } = teacherWithUnsaved({}, noList);
  newPage(NL, null, noList).dropDisciplineCacheUnlessMine();
  check("TEETH: a cache that does not list the unsaved ones loses them when the tab dies without a pagehide",
    !("behaviorReferrals" in blobIn(NL)));

  const noBoot = breakOnce(script, "                    // write the cache over them.\n                    restoreOwnUnsavedReferrals();\n",
    "                    // write the cache over them.\n", "boot restore");
  const at = noBoot.indexOf("} else if (hasSession) {");
  check("TEETH: a page start that does not restore is caught",
    !/restoreOwnUnsavedReferrals\(\);/.test(noBoot.slice(at, noBoot.indexOf("} else if (currentStudent) {", at))));

  // The toasts of a referral save that settles after sign-out.
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
