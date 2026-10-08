// Seeing a colleague's referral without reloading the page.
//
// REPORTED TWICE. "I created a referral in Jazmin's account, logged in on my
// own account on another computer, and could not see it." Then again on
// 2026-09-08 with Leo C. Both times the referral WAS on the server -- checked
// -- and both times the reader's tab never asked for it again.
//
// Referrals reach a tab once, at page load. The background auto-refresh is
// gated on AUTO_REFRESH_DELAY, five minutes of INACTIVITY, so an admin who
// opens Open Referrals, does not see it, and clicks around looking harder
// resets that timer on every click. The harder you looked, the longer it took.
//
// The dangerous fix is a refresh that REPLACES the local array: that discards
// a referral still sitting in this tab's save queue. So the merge is a union,
// and most of these assertions are about what it must never throw away.
//
// Run: npm test

import { readFileSync } from "node:fs";

const disc = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");
new Function(disc)();
const D = globalThis.WildcatDiscipline;

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };
const R = (id, updatedAt, extra) => Object.assign({ id, updatedAt, status: "open" }, extra || {});
const ids = (a) => a.map((r) => r.id);

console.log("\n-- the reported bug: a colleague's referral arrives --");
{
  const mine = [R("REF11", "2026-09-01")];
  const server = [R("REF11", "2026-09-01"), R("REF-260908-9DGPFAW", "2026-09-08T23:07")];
  const m = D.mergeReferrals(mine, server);
  check("the new referral is now in the list", ids(m.referrals).includes("REF-260908-9DGPFAW"));
  check("counted as added, so the screen can say so", m.added === 1);
  check("nothing counted as updated", m.updated === 0);
  check("changed is true", m.changed === true);
}

console.log("\n-- NOTHING LOCAL IS DISCARDED --");
{
  // The referral this teacher just filed, still in the save queue. A refresh
  // that replaced the array would destroy it mid-write.
  const mine = [R("LOCAL-1", "2026-09-08T23:30")];
  const m = D.mergeReferrals(mine, []);
  check("a referral absent from the server survives", ids(m.referrals).includes("LOCAL-1"));
  check("an empty server is not read as a deletion", m.referrals.length === 1);
  check("and nothing is reported as new", m.added === 0 && m.changed === false);

  const m2 = D.mergeReferrals(mine, [R("OTHER", "2026-09-08T23:00")]);
  check("it survives alongside an incoming one", ids(m2.referrals).sort().join() === "LOCAL-1,OTHER");
}

console.log("\n-- the later edit wins, in both directions --");
{
  const newerLocal = D.mergeReferrals([R("A", "2026-09-08T10:00")], [R("A", "2026-09-08T09:00")]);
  check("a stale server copy does not overwrite a local edit",
    newerLocal.referrals[0].updatedAt === "2026-09-08T10:00");
  check("and that is not reported as an update", newerLocal.updated === 0);

  const newerServer = D.mergeReferrals([R("A", "2026-09-08T09:00")], [R("A", "2026-09-08T10:00")]);
  check("a colleague's newer edit does land", newerServer.referrals[0].updatedAt === "2026-09-08T10:00");
  check("and is counted as updated", newerServer.updated === 1);

  const same = D.mergeReferrals([R("A", "2026-09-08T10:00")], [R("A", "2026-09-08T10:00")]);
  check("identical timestamps change nothing", same.updated === 0 && same.changed === false);
}

console.log("\n-- submittedAt stands in when updatedAt is absent --");
{
  const m = D.mergeReferrals(
    [{ id: "A", submittedAt: "2026-09-08T09:00", status: "open" }],
    [{ id: "A", submittedAt: "2026-09-08T11:00", status: "closed" }]);
  check("an older referral without updatedAt still compares", m.referrals[0].status === "closed");
}

console.log("\n-- no duplicates, whatever the input --");
{
  const m = D.mergeReferrals(
    [R("A", "1"), R("B", "1")],
    [R("B", "2"), R("C", "1"), R("A", "2")]);
  check("each id appears once", ids(m.referrals).length === new Set(ids(m.referrals)).size);
  check("all three ids are present", ids(m.referrals).sort().join() === "A,B,C");
}

console.log("\n-- referrals with no id are not collapsed into each other --");
{
  // Two id-less rows are two different referrals about two different children.
  // Keying them both to "" would silently destroy one.
  const m = D.mergeReferrals(
    [{ studentName: "x", updatedAt: "1" }, { studentName: "y", updatedAt: "1" }], []);
  check("both survive", m.referrals.length === 2);
}

console.log("\n-- bad input does not throw --");
{
  check("null local", D.mergeReferrals(null, [R("A", "1")]).referrals.length === 1);
  check("null server", D.mergeReferrals([R("A", "1")], null).referrals.length === 1);
  check("both null", D.mergeReferrals(null, null).referrals.length === 0);
  check("non-arrays", D.mergeReferrals("nope", 7).referrals.length === 0);
}

console.log("\n-- wired to the screen --");
{
  check("opening Open Referrals pulls from the server",
    /subtab === 'review'\)[\s\S]{0,300}pullReferralsAndRedraw\(false\)/.test(script));
  check("so does opening Closed Referrals",
    /subtab === 'closed'\)[\s\S]{0,300}pullReferralsAndRedraw\(false\)/.test(script));
  // Drawing only after the network answers makes the tab look broken on a
  // slow connection.
  check("the table is drawn BEFORE the pull, not after",
    script.indexOf("updateReferralReviewTable();\n                pullReferralsAndRedraw") !== -1);
  check("there is a Refresh button", /onclick="pullReferralsAndRedraw\(true\)"/.test(html));
  check("and a line saying when it last checked", /id="referralRefreshNote"/.test(html));
  check("the pull fetches ONLY the referrals document, not everything",
    /loadLegacyDocsFromConvex\(\['referrals'\]\)/.test(script));
  check("it uses the tested merge rather than assigning the response",
    // (A third argument, the merge's options, is allowed: review, 2026-10-07.)
    /WildcatDiscipline\.mergeReferrals\(behaviorReferrals, rows[,)]/.test(script));
  check("a failed read is not treated as an empty server",
    /res\.failed && res\.failed\.indexOf\('referrals'\) !== -1/.test(script));
  check("concurrent pulls are guarded", /_referralPullBusy/.test(script));
  check("a username session is skipped quietly, not reported as an error",
    /skipped: 'no-session'/.test(script));
}

console.log("\n-- the permission rule is untouched --");
{
  // The pull must not become a way around scoping: a teacher pulls the same
  // document, and visibleReferrals still filters it to their own.
  const all = [R("MINE", "1", { filedByEmail: "t@x.org" }), R("THEIRS", "1", { filedByEmail: "o@x.org" })];
  const teacher = { email: "t@x.org", role: "teacher" };
  check("a teacher still sees only their own after a pull",
    ids(D.visibleReferrals(all, teacher)).join() === "MINE");
  ["admin", "superadmin", "pbis"].forEach((role) =>
    check(`${role} sees every teacher's referrals`,
      D.visibleReferrals(all, { email: "a@x.org", role }).length === 2));
  check("role matching is case-insensitive",
    D.visibleReferrals(all, { email: "a@x.org", role: "PBIS" }).length === 2);
}

// ---------------------------------------------------------------------------
// Analytics and Student History pull too, and a second pull is never dropped.
//
// 2026-10-07. Open and Closed pulled on opening; Analytics and Student History
// drew only from what the page loaded with, so a referral filed on another
// computer stayed out of the counts until a reload. And a pull already in
// flight answered a second caller with { skipped: 'busy' }, so opening
// Analytics right after Open Referrals drew stale numbers and never redrew.
// THE SHIPPED CODE RUNS below: the pull and the redraw are lifted out of
// script.js. Every "TEETH" check breaks it on purpose.
// ---------------------------------------------------------------------------

function liftFn(src, name) {
  const m = new RegExp("\\n        (?:async )?function " + name + "\\(").exec(src);
  if (!m) throw new Error("missing function " + name);
  const start = m.index + 1;
  const end = src.indexOf("\n        }\n", start);
  if (end < 0) throw new Error("unterminated function " + name);
  return src.slice(start, end + 10);
}
function breakOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`teeth "${label}": anchor not found exactly once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}
/** The `let` line that declares a module-level variable, as shipped. */
function liftLet(src, name) {
  const m = new RegExp("\\n        let " + name + " = [^\\n]*;").exec(src);
  if (!m) throw new Error("missing let " + name);
  return m[0].trim();
}
/** The same for a module-level `const`. */
function liftConst(src, name) {
  const m = new RegExp("\\n        const " + name + " = [^\\n]*;").exec(src);
  if (!m) throw new Error("missing const " + name);
  return m[0].trim();
}

/**
 * The pull, lifted, against a fake server. `G.rows` is what the server holds;
 * each read is counted and answered after `G.delay` milliseconds.
 */
function loadPull(src, G) {
  const body = `
    const window = { WildcatAuth: { getSession: () => G.session }, WildcatDiscipline: G.D };
    const console = { warn() {}, log() {} };
    let behaviorReferrals = G.local;
    let detentions = G.detentions || [];
    const _unsavedReferrals = G.unsaved || new Map();
    // An admin unless a test says otherwise, so scoping what a pull keeps is
    // a no-op for the read-count checks; the device-copy checks below pass a
    // teacher.
    let currentUser = G.user || { role: 'admin', email: 'admin@x.org' };
    function isPreviewingTeacher() { return Boolean(G.previewing); }
    ${liftFn(src, "visibleReferrals")}
    ${liftFn(src, "referralsScopedToViewer")}
    ${liftFn(src, "cacheableReferrals")}
    ${liftFn(src, "shedReferralsNotMine")}
    ${liftFn(src, "canCloseReferralsHere")}
    ${liftFn(src, "serverOwnsReferralClose")}
    ${liftLet(src, "_referralPullBusy")}
    ${liftLet(src, "_referralPullAt")}
    // What the pull records as on the server, and whose sign-in it is
    // (review, 2026-10-07; referral-close-gate.test.mjs tests both).
    ${liftLet(src, "_signInGeneration")}
    ${liftConst(src, "_disciplineOnServer")}
    ${liftFn(src, "noteDisciplineOnServer")}
    async function loadLegacyDocsFromConvex(names) {
      G.reads.push(names.slice());
      await new Promise((r) => setTimeout(r, G.delay || 5));
      if (G.fail) return { failed: ['referrals'], errors: [{ error: 'boom' }], docs: {} };
      return { docs: { referrals: { behaviorReferrals: G.rows } } };
    }
    ${liftFn(src, "refreshReferralsFromServer")}
    ${liftFn(src, "pullReferralsOnce")}
    return { refreshReferralsFromServer, held: () => behaviorReferrals, busy: () => _referralPullBusy,
             detentions: () => detentions };
  `;
  return new Function("G", body)(G);
}

{
  const tests = [];
  const later = (name, fn) => tests.push([name, fn]);

  later("two pulls at once", async () => {
    const G = { D, session: { ok: 1 }, local: [R("MINE", "1")], rows: [R("MINE", "1"), R("NEW1", "2"), R("NEW2", "2")], reads: [] };
    const app = loadPull(script, G);
    const [a, b] = await Promise.all([app.refreshReferralsFromServer({ loud: true }), app.refreshReferralsFromServer()]);
    check("two pulls at once make ONE read of the referrals document", G.reads.length === 1, String(G.reads.length));
    check("the second caller gets the same answer, not 'busy'", a === b && !("skipped" in b));
    check("and both see what arrived", a.added === 2 && b.added === 2 && b.updated === 0 && b.changed === true);
    check("the merged list is held once, not twice", app.held().length === 3);
    check("the flag is clear once the pull is done", app.busy() === null);
    await app.refreshReferralsFromServer();
    check("so the next pull reads again", G.reads.length === 2);
  });

  later("a failed read", async () => {
    const G = { D, session: { ok: 1 }, local: [], rows: [], reads: [], fail: true };
    const app = loadPull(script, G);
    const res = await app.refreshReferralsFromServer();
    check("a failed read is reported, not swallowed", res.error === "boom");
    check("and does not leave the pull stuck", app.busy() === null);
  });

  later("no session", async () => {
    const G = { D, session: null, local: [], rows: [], reads: [] };
    const app = loadPull(script, G);
    const res = await app.refreshReferralsFromServer();
    check("with no session nothing is read and nothing is stuck",
      res.skipped === "no-session" && G.reads.length === 0 && (await Promise.resolve(), app.busy() === null));
  });

  // ---- what a teacher's tab keeps (2026-10-07) ----------------------------
  // The server scopes this read behind a switch that starts OFF, so for a
  // while it still sends a teacher the whole school. The tab cuts both sides
  // to the teacher's own BEFORE the merge, whatever the server sent.
  const T = { role: "teacher", email: "t@x.org", name: "T Teacher" };
  const mineR = (id, at) => R(id, at, { filedByEmail: "t@x.org", referredByEmail: "t@x.org" });
  const theirsR = (id, at) => R(id, at, { filedByEmail: "o@x.org", referredByEmail: "o@x.org", referredBy: "O Other" });

  later("a teacher's pull with the server switch OFF", async () => {
    // A tab that loaded the whole school before this build.
    const local = [mineR("MINE1", "1"), theirsR("THEIRS1", "1"), theirsR("THEIRS2", "1")];
    const rows = [mineR("MINE1", "1"), mineR("MINE2", "2"), theirsR("THEIRS1", "1"), theirsR("THEIRS2", "1"), theirsR("THEIRS3", "2")];
    const G = { D, session: { ok: 1 }, local, rows, reads: [], user: T, detentions: [{ id: "detention_1" }] };
    const app = loadPull(script, G);
    const res = await app.refreshReferralsFromServer();
    check("the teacher's tab keeps only their own after a pull",
      ids(app.held()).sort().join() === "MINE1,MINE2", ids(app.held()).join());
    check("'N new' counts only what they can see (1), not the colleague's new one too",
      res.added === 1 && res.updated === 0, JSON.stringify(res));
    check("and any detentions the tab held are dropped (only the Detention tab draws them)",
      app.detentions().length === 0);
  });

  later("a referral this tab has not saved is never shed", async () => {
    // Owned in every real case; kept even when it somehow is not.
    const odd = R("UNSAVED", "3", { filedByEmail: "" });
    const G = { D, session: { ok: 1 }, local: [odd, theirsR("THEIRS1", "1")], rows: [theirsR("THEIRS1", "1")],
      reads: [], user: T, unsaved: new Map([["UNSAVED", odd]]) };
    const app = loadPull(script, G);
    await app.refreshReferralsFromServer();
    check("the unsaved referral survives the pull", ids(app.held()).join() === "UNSAVED", ids(app.held()).join());
  });

  later("admin, PBIS and a teacher preview keep everything", async () => {
    for (const [label, user, previewing] of [
      ["admin", { role: "admin", email: "a@x.org" }, false],
      ["PBIS", { role: "pbis", email: "p@x.org" }, false],
      ["an admin previewing a teacher", T, true],
    ]) {
      const G = { D, session: { ok: 1 }, local: [theirsR("THEIRS1", "1")], rows: [theirsR("THEIRS1", "1"), mineR("MINE1", "1")],
        reads: [], user, previewing, detentions: [{ id: "detention_1" }] };
      const app = loadPull(script, G);
      const res = await app.refreshReferralsFromServer();
      check(`${label}: every referral is kept and the new one counted`,
        app.held().length === 2 && res.added === 1, `${app.held().length} held, ${res.added} added`);
      check(`${label}: detentions untouched`, app.detentions().length === 1);
    }
  });

  later("teeth: device copy", async () => {
    const noFilter = breakOnce(script, "const rows = cacheableReferrals(served);", "const rows = served;", "served side");
    let G = { D, session: { ok: 1 }, local: [mineR("MINE1", "1")], rows: [mineR("MINE1", "1"), theirsR("THEIRS9", "2")], reads: [], user: T };
    let res = await loadPull(noFilter, G).refreshReferralsFromServer();
    check("TEETH: without the served-side filter a colleague's referral arrives (and is counted)", res.added === 1);

    const noShed = breakOnce(script, "                shedReferralsNotMine();\n                const merged", "                const merged", "held side");
    G = { D, session: { ok: 1 }, local: [mineR("MINE1", "1"), theirsR("THEIRS1", "1")], rows: [mineR("MINE1", "1")], reads: [], user: T };
    const app = loadPull(noShed, G);
    await app.refreshReferralsFromServer();
    check("TEETH: without the shed an old whole-school copy stays in memory", app.held().length === 2);
  });

  // ---- a fast clock on a teacher's Chromebook (review, 2026-10-07) ---------
  // The teacher's copy is stamped by the teacher's clock. Ten minutes fast,
  // it looked newer than the admin's close made three minutes after filing,
  // so every pull kept the teacher's open copy.
  const filedFast = () => mineR("FAST", "2026-10-07T15:10:00.000Z");
  const closedOnServer = () => ({ ...filedFast(), status: "closed", closedBy: "A Admin", closedAt: "2026-10-07T15:03:00.000Z",
    closingActions: ["Notified parents/guardians promptly"], resolutionType: "action_taken",
    updatedAt: "2026-10-07T15:03:00.000Z" });
  later("a teacher whose clock runs fast sees the admin's close", async () => {
    const G = { D, session: { ok: 1 }, local: [filedFast()], rows: [closedOnServer()], reads: [], user: T };
    const app = loadPull(script, G);
    const res = await app.refreshReferralsFromServer();
    const r = app.held()[0];
    check("the teacher's tab shows it closed after a pull, with the admin's close fields",
      r.status === "closed" && r.closedBy === "A Admin" && r.closingActions.length === 1, JSON.stringify(r));
    check("...and the screen is told something changed", res.updated === 1 && res.changed === true);
    check("...while the copy's own fields (its stamp) are the tab's", r.updatedAt === "2026-10-07T15:10:00.000Z");

    // An admin's tab keeps the stamp rule exactly: its own close, made a
    // moment ago and maybe not saved yet, must not be undone by a pull.
    const adminLocal = { ...closedOnServer(), status: "closed", closedBy: "Me", updatedAt: "2026-10-07T15:20:00.000Z" };
    const A = { D, session: { ok: 1 }, local: [adminLocal], rows: [filedFast()], reads: [], user: { role: "admin", email: "a@x.org" } };
    const adm = loadPull(script, A);
    await adm.refreshReferralsFromServer();
    check("an admin's newer local close survives a pull of the older open copy", adm.held()[0].closedBy === "Me");
    const P = { D, session: { ok: 1 }, local: [filedFast()], rows: [closedOnServer()], reads: [], user: T, previewing: true };
    const pv = loadPull(script, P);
    await pv.refreshReferralsFromServer();
    check("and nothing changes during a teacher preview (the admin's list is underneath)", pv.held()[0].status === "open");

    const plain = loadPull(breakOnce(script, "{ serverOwnsClose: serverOwnsReferralClose() });\n                behaviorReferrals = merged.referrals;\n                _referralPullAt",
      "{});\n                behaviorReferrals = merged.referrals;\n                _referralPullAt", "server owns close"),
      { D, session: { ok: 1 }, local: [filedFast()], rows: [closedOnServer()], reads: [], user: T });
    await plain.refreshReferralsFromServer();
    check("TEETH: without serverOwnsClose the fast-clock copy keeps the referral open", plain.held()[0].status === "open");
  });

  later("teeth: busy", async () => {
    const broken = breakOnce(script, "if (_referralPullBusy) return _referralPullBusy;", "", "shared pull");
    const G = { D, session: { ok: 1 }, local: [], rows: [R("A", "1")], reads: [] };
    const app = loadPull(broken, G);
    await Promise.all([app.refreshReferralsFromServer(), app.refreshReferralsFromServer()]);
    check("TEETH: without the shared pull two callers make two reads", G.reads.length === 2);
  });

  // ---- the redraw ---------------------------------------------------------
  function loadRedraw(src, G) {
    const el = (id, hidden, value) => ({ id, value: value || "", textContent: "",
      classList: { contains: (c) => c === "hidden" && hidden } });
    const els = {
      behaviorAnalytics: el("behaviorAnalytics", !G.analytics),
      behaviorHistory: el("behaviorHistory", !G.history),
      historyStudentSelect: el("historyStudentSelect", false, G.student || ""),
      referralRefreshNote: el("referralRefreshNote", false),
    };
    const body = `
      const document = { getElementById: (id) => G.els[id] || null };
      let analyticsTab = 'demographics';
      let _referralPullAt = null;
      async function refreshReferralsFromServer() { return G.res; }
      function updateReferralReviewTable() {}
      function updateClosedReferralsList() {}
      function updateReferralAnalytics() { G.calls.push('analytics'); }
      function renderAnalyticsPane(tab) { G.calls.push('pane:' + tab); }
      function updateStudentReferralHistory() { G.calls.push('history'); }
      ${liftFn(src, "redrawReferralInsightViews")}
      ${liftFn(src, "_fmtPullTime")}
      ${liftFn(src, "pullReferralsAndRedraw")}
      return { pullReferralsAndRedraw };
    `;
    G.els = els;
    G.calls = [];
    return new Function("G", body)(G);
  }

  later("redraw", async () => {
    let G = { analytics: true, res: { added: 1, updated: 0, changed: true } };
    await loadRedraw(script, G).pullReferralsAndRedraw(false);
    check("Analytics on screen is redrawn when the pull brought something",
      G.calls.join() === "analytics,pane:demographics", G.calls.join());

    G = { analytics: true, res: { added: 0, updated: 0, changed: false } };
    await loadRedraw(script, G).pullReferralsAndRedraw(false);
    check("and NOT when nothing changed (Demographics would query the server again)", G.calls.length === 0, G.calls.join());

    G = { history: true, student: "S1", res: { added: 0, updated: 1, changed: true } };
    await loadRedraw(script, G).pullReferralsAndRedraw(false);
    check("Student History is redrawn for the student on screen", G.calls.join() === "history", G.calls.join());

    G = { history: true, student: "", res: { added: 1, updated: 0, changed: true } };
    await loadRedraw(script, G).pullReferralsAndRedraw(false);
    check("but not with no student chosen", G.calls.length === 0);

    G = { res: { added: 1, updated: 0, changed: true } };
    await loadRedraw(script, G).pullReferralsAndRedraw(false);
    check("a pane that is not on screen is not redrawn", G.calls.length === 0);

    const always = breakOnce(script, "if (res && (res.changed || res.added || res.updated)) redrawReferralInsightViews();",
      "redrawReferralInsightViews();", "changed only");
    G = { analytics: true, res: { added: 0, updated: 0, changed: false } };
    await loadRedraw(always, G).pullReferralsAndRedraw(false);
    check("TEETH: redrawing on every pull is caught", G.calls.length > 0);
  });

  console.log("\n-- Analytics and Student History pull too --");
  {
    const tab = liftFn(script, "switchDisciplineTab");
    const history = tab.slice(tab.indexOf("subtab === 'history'"), tab.indexOf("subtab === 'analytics'"));
    const analytics = tab.slice(tab.indexOf("subtab === 'analytics'"));
    check("opening Student History pulls from the server", /pullReferralsAndRedraw\(false\)/.test(history));
    check("after drawing what it has", history.indexOf("populateHistoryStudentDropdown()") < history.indexOf("pullReferralsAndRedraw(false)"));
    check("opening Analytics pulls from the server", /pullReferralsAndRedraw\(false\)/.test(analytics));
    check("after drawing what it has", analytics.indexOf("switchAnalyticsTab(analyticsTab)") < analytics.indexOf("pullReferralsAndRedraw(false)"));
    const pullCode = (liftFn(script, "refreshReferralsFromServer") + liftFn(script, "pullReferralsOnce"))
      .replace(/\/\/.*$/gm, "");
    check("nothing answers a second caller with 'busy' any more", !/skipped: 'busy'/.test(pullCode));
  }

  for (const [name, fn] of tests) {
    console.log(`\n-- ${name} --`);
    await fn();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
