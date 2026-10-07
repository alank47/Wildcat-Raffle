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
  const installSnippet = cut(src, "                        const referralsData = referralsSnap.exists() ? referralsSnap.data() : {};",
    // The line after the detentions install, so a test may break that line itself.
    "// Read the counter back from Firebase, not just localStorage.");
  const body = `
    const window = { WildcatDiscipline: Dm, WildcatAuth: G.auth || null };
    const console = { log() {}, warn() {}, error() {}, info() {} };
    const localStorage = G.localStorage;
    const sessionStorage = G.sessionStorage;
    let currentUser = G.currentUser || null;
    let realUser = G.realUser || null;
    let behaviorReferrals = G.referrals || [];
    let detentions = G.detentions || [];
    let students = G.students || [];
    let teachers = [];
    let detentionIdCounter = 1;
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
    async function showConfirm() { return true; }
    function applyCashAnalyticsGate() {}
    function showStudentLogin() {}
    // loadData, as far as reloadPreservingUnsavedWork needs it: install what
    // the server sends the way loadData does (runServerInstall below).
    async function loadData() { runServerInstall(G.reloadSnap, G.reloadSecondary || {}); }
    // The two reads rescopeDisciplineForRole makes, against a fake server.
    async function loadLegacyDocsFromConvex(names) {
      (G.docReads ||= []).push(names.slice());
      return G.docsFail ? { failed: names.slice(), docs: {} } : { docs: { secondary: { detentions: G.serverDetentions || [] } } };
    }
    async function refreshReferralsFromServer() {
      G.pulls = (G.pulls || 0) + 1;
      const D = window.WildcatDiscipline;
      behaviorReferrals = D.mergeReferrals(behaviorReferrals, cacheableReferrals(G.serverReferrals || [])).referrals;
      return {};
    }
    const _unsavedReferrals = G.unsaved || new Map();
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
    return {
      ${FNS.join(", ")}, runLocalRestore, runServerInstall, isPreviewingTeacher,
      get referrals() { return behaviorReferrals; },
      set referrals(v) { behaviorReferrals = v; },
      get detentions() { return detentions; },
      get realUser() { return realUser; },
      get previewRoster() { return previewRoster; },
      set currentUser(v) { currentUser = v; },
    };`;
  G.toasts = []; G.saves = [];
  const app = new Function("G", "Dm", "document", body)(G, Dmod || D, document);
  app.els = els;
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
const SCREENS = ["referralReviewTable", "closedReferralsList", "referralDetailBody", "studentReferralHistoryBody",
  "referralTrend", "referralDemographics", "referralClosedAnalytics", "activeDetentionsList", "completedDetentionsList"];
/** An admin's tab with the whole school drawn, as the inactivity logout finds it. */
function drawnAdminTab(src, over) {
  const G = world(ADMIN, Object.assign({ detentions: DETS1() }, over));
  const a = loadApp(src, G);
  SCREENS.forEach((id) => { document_el(a, id).innerHTML = "<td>Student THEIRS-OPEN</td>"; });
  document_el(a, "openReferralCount").textContent = "2";
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

console.log("\n-- the page these run in --");
{
  check("index.html has the Open Referrals table these draw into", /id="referralReviewTable"/.test(html));
  check("...and the Closed Referrals list", /id="closedReferralsList"/.test(html));
  check(".tag-neutral, used for the status text, is styled",
    /\.tag-neutral \{/.test(readFileSync(new URL("./styles.css", import.meta.url), "utf8")));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
