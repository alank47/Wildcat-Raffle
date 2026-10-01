// An award refused for its token is sent once more with a renewed one, and
// "Sign in again" renews instead of looping. Run: npm test
//
// WHY, 2026-09-30. On 9/29 about 92 of ~613 awards missed cashAward:award,
// each 3-33 seconds from a token renewal, and every browser report said
// "Convex HTTP 401". The command was never retried, so the award waited on the
// ordinary save, which the same dead token also refused. A page reload in that
// window -- the "Sign in again" redirect is one -- emptied the money held in
// memory, and 67 awards were lost on 9/29-9/30. The owner chose "option C":
// make that happen less often.
//
// WHAT THESE CHECKS HOLD IT TO:
//   - a 401 makes exactly ONE silent renewal and ONE retry, with the SAME
//     receipt (txnId), so the server's register absorbs any repeat;
//   - a second 401 falls back exactly as before (null, nothing marked sent,
//     the 'error' report, the ordinary save delivers it);
//   - nothing that is not a 401 is retried, and a timeout is not either;
//   - the save's renewal and the award's renewal are the same one;
//   - "Sign in again" forces a renewal (silent first) instead of handing back
//     the expired session, and redirects only when silent renewal fails.
//
// AND WHAT THE ADVERSARIAL REVIEW FOUND (2026-09-30), numbered as it was:
//   1. the redirect only when a PERSON is needed (Microsoft says so, no
//      account, the server refuses even a new token); a network drop, a
//      timeout, a 5xx or a CDN failure keeps the page and says so on the bar;
//   2. one forced renewal at a time, and the bar's button waits for its press;
//   3. the renewal is for the account of the person holding the session, and
//      a token for anybody else never replaces it;
//   4. the page-load restore refreshes a cached id token that has expired or
//      is under five minutes from it, or that the server refuses -- once.
//
// The shipped functions are lifted from script.js and wildcat-auth.js and run
// against fakes; the server is the REAL cashAward:award, transpiled. Every
// load-bearing check is re-broken at the end to prove it has teeth.
import { readFileSync } from "node:fs";
import ts from "typescript";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const authSrc = readFileSync(new URL("./wildcat-auth.js", import.meta.url), "utf8");
const convexSrc = (f) => readFileSync(new URL("./convex/" + f, import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (x) => x;
const mustReplace = (label, from, to) => (s) => {
  const out = s.replace(from, to);
  if (out === s) throw new Error("teeth anchor moved: " + label);
  return out;
};
// A whole function declaration, `async` included, by brace matching.
const lift = (s, name) => {
  const i = s.indexOf("function " + name + "(");
  if (i < 0) throw new Error("missing " + name);
  const head = s.lastIndexOf("\n", i);
  let d = 0, k = s.indexOf("{", i);
  for (; k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}") { d--; if (d === 0) break; } }
  return s.slice(head + 1, k + 1);
};

// ------------------------------------------------------------ the server
// The real command, transpiled, on a tiny in-memory database: enough to show
// that the retry's receipt is paid once.
function loadServer() {
  const SRC = {
    appDataShape: convexSrc("appDataShape.ts"), cashReversalRules: convexSrc("cashReversalRules.ts"),
    cashAwardRules: convexSrc("cashAwardRules.ts"), cashAward: convexSrc("cashAward.ts"),
  };
  const cache = {};
  const stubs = {
    "./_generated/server": { mutation: (d) => d, query: (d) => d, internalMutation: (d) => d, internalQuery: (d) => d },
    "convex/values": { v: new Proxy({}, { get: () => (...a) => ({ a }) }) },
    "./identity": { requireStaff: async () => ({ _id: "t1", legacyId: "T034", name: "Karen Ceballos", email: "karenc@lapromisefund.org" }) },
  };
  const req = (name) => {
    if (stubs[name]) return stubs[name];
    const key = name.replace(/^\.\//, "");
    if (cache[key]) return cache[key];
    const js = ts.transpileModule(SRC[key], { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const m = { exports: {} };
    cache[key] = m.exports;
    new Function("require", "module", "exports", js)(req, m, m.exports);
    cache[key] = m.exports;
    return m.exports;
  };
  return req("./cashAward");
}
function makeDb() {
  const tables = {
    appState: [{ key: "cashAwardCommand", value: { enabled: true, pilotEmails: [] } }],
    students: [{ _id: "s1", legacyId: "11512", studentNumber: "11512", firstName: "Ana", lastName: "Ruiz", grade: "8",
      wildcatCashBalance: 500, wildcatCashEarned: 500, wildcatCashSpent: 0, wildcatCashDeducted: 0,
      wildcatCashTransactions: [], cashApplied: null, _creationTime: Date.now() }],
    cashAwardCommands: [], appAuditLog: [], legacyMirror: [],
  };
  let n = 0;
  const query = (name) => {
    let rows = (tables[name] || []).slice();
    const api = {
      withIndex(_idx, fn) {
        if (fn) {
          const conds = [];
          const q = { eq: (f, v) => { conds.push((r) => r[f] === v); return q; }, gte: (f, v) => { conds.push((r) => r[f] >= v); return q; } };
          fn(q);
          rows = rows.filter((r) => conds.every((c) => c(r)));
        }
        return api;
      },
      order() { return api; },
      async first() { return rows[0] ?? null; },
      async take(k) { return rows.slice(0, k); },
      async collect() { return rows.slice(); },
    };
    return api;
  };
  return {
    tables,
    db: {
      query,
      async insert(t, doc) { (tables[t] = tables[t] || []).push({ ...doc, _id: t + ":" + n++, _creationTime: Date.now() }); return t + ":" + (n - 1); },
      async patch(id, f) { for (const t of Object.values(tables)) { const r = t.find((x) => x._id === id); if (r) Object.assign(r, f); } },
    },
  };
}

// ------------------------------------------------------------ the browser
// sendCashAwardCommand with the renewal it now uses, lifted from script.js.
function buildSender(o = {}) { return buildSenderFrom(script, o); }
function buildSenderFrom(script, o = {}) {
  const env = {
    session: { idToken: "tok1", me: { kind: "staff", email: "karenc@lapromisefund.org" } },
    calls: [], resumes: [], notes: [], saves: [], lost: [],
    cashIdsOnServer: new Set(), auditIdsOnServer: new Set(),
    refused: new Set(o.refused || ["tok1"]),
  };
  let minted = 1;
  const auth = {
    getSession: () => env.session,
    resumeSession: async (opts) => {
      env.resumes.push(opts);
      if (o.renewHangs) return new Promise(() => {});
      if (o.renewDelayMs) await sleep(o.renewDelayMs);
      if (o.renewFails) return null;
      if (o.renewSameToken) return env.session;
      env.session = { idToken: "tok" + (++minted), me: { kind: "staff", email: o.renewAs || "karenc@lapromisefund.org" } };
      return env.session;
    },
    convexMutation: async (name, args, tok) => {
      env.calls.push({ name, args: JSON.parse(JSON.stringify(args)), tok });
      if (o.transport) return o.transport(name, args, tok, env);
      if (o.hang) return new Promise(() => {});
      if (o.otherError) throw new Error(o.otherError);
      if (env.refused.has(tok) || o.refuseAll) throw new Error("Convex HTTP 401");
      return { ok: true, results: args.awards.map((a) => ({ txnId: a.txnId, status: "applied", wroteRecords: true, entryId: "a_" + a.txnId })) };
    },
  };
  const body = [
    "const CASH_AWARD_TIMEOUT_MS = " + (o.timeoutMs ?? 80) + ";",
    "let _renewAfterRefusalInFlight = null;",
    "let _sessionLostShown = false;",
    "const pruneCashOutbox = () => {}; const pruneAuditOutbox = () => {};",
    lift(script, "cashAwardAuditId"),
    (o.mutateRenew || same)(lift(script, "renewSessionAfterRefusal")),
    lift(script, "isUnauthorized"),
    lift(script, "freshTokenAfterAwardRefusal"),
    (o.mutateSender || same)(lift(script, "sendCashAwardCommand")),
    lift(script, "cashAwardCommandLanded"),
    "return { sendCashAwardCommand, cashAwardCommandLanded, renewSessionAfterRefusal };",
  ].join("\n");
  const f = new Function("window", "document", "cashIdsOnServer", "auditIdsOnServer", "isPreviewingTeacher",
    "currentWeek", "getCurrentCycleNumber", "reportCashAwardFallback", "reportSessionLost", "requestSave", "console", body)(
    { WildcatAuth: auth }, { getElementById: () => null }, env.cashIdsOnServer, env.auditIdsOnServer, () => false,
    4, () => 2,
    (reason, detail, ids) => env.notes.push({ reason, detail, ids }),
    (reason, serverRefused) => env.lost.push({ reason, serverRefused }),
    (why) => { env.saves.push(why); return Promise.resolve(true); },
    { log() {}, warn() {}, error() {} });
  return Object.assign(f, { env });
}

// Minted the way recordCashTransaction mints it: the server checks that a
// receipt's time matches its award's.
const AT_MS = Date.now() - 30_000;
const AT = new Date(AT_MS).toISOString();
const TXN = "txn_" + AT_MS + "_abc1234";
const tx = (id, sid) => ({ id, studentId: sid || "11512", timestamp: AT, amount: 100, kind: "award",
  behaviorId: "wc1", behaviorName: "Be Responsible", notes: "Chairs" });
const items = [{ tx: tx(TXN), entryId: "a_" + TXN }];
const txnIdsOf = (call) => call.args.awards.map((a) => a.txnId).join(",");
const awardCalls = (env) => env.calls.filter((c) => c.name === "cashAward:award");

// =====================================================================
console.log("\nTHE SERVER ALREADY REFUSES TO PAY ONE RECEIPT TWICE (read, then run)\n");
{
  const award = convexSrc("cashAward.ts");
  check("the register is read by receipt before anything moves, and a known receipt is 'alreadyApplied'",
    /withIndex\("by_txnId", \(q\) => q\.eq\("txnId", a\.txnId\)\)\.first\(\);\s*if \(reg\) \{\s*results\.push\(\{[^}]*status: "alreadyApplied"[\s\S]{0,120}continue;/.test(award));
  check("...a receipt the ordinary save already paid (cashApplied) is 'alreadyApplied' too",
    /if \(known\.has\(a\.txnId\)\) \{[\s\S]{0,400}status: "alreadyApplied"/.test(award));
  check("...and those checks come before the counters move",
    award.indexOf('status: "alreadyApplied"') < award.indexOf("const effect = cashMovementEffect(a.amount, a.kind);"));

  const server = loadServer();
  // The browser's transport in front of the real command: an expired token is
  // refused at the door (HTTP 401), a good one reaches the handler.
  const dbw = makeDb();
  const viaServer = (name, args, tok, env) => {
    if (env.refused.has(tok)) throw new Error("Convex HTTP 401");
    return server.award.handler({ db: dbw.db }, args);
  };
  const t = buildSender({ transport: viaServer });
  const res = await t.sendCashAwardCommand(items);
  const s = dbw.tables.students[0];
  check("end to end: refused for its token, renewed, sent again -- and it LANDS",
    res && res.ok === true && t.cashAwardCommandLanded(res, items) === true, JSON.stringify(res));
  check("...the child is paid exactly once (500 -> 600)", s.wildcatCashBalance === 600, String(s.wildcatCashBalance));
  check("...one register row, one ledger row, one audit entry",
    dbw.tables.cashAwardCommands.length === 1 && dbw.tables.legacyMirror.length === 1 && dbw.tables.appAuditLog.length === 1);

  // THE REFUSAL THAT LIED. Suppose the server HAD run the first call and the
  // 401 came back anyway. The retry carries the same receipt, so the command
  // answers from its register and nothing moves again.
  const dbl = makeDb();
  const liar = (name, args, tok, env) => {
    const ran = server.award.handler({ db: dbl.db }, args);
    if (env.refused.has(tok)) return ran.then(() => { throw new Error("Convex HTTP 401"); });
    return ran;
  };
  const l = buildSender({ transport: liar });
  const lres = await l.sendCashAwardCommand(items);
  check("even if a 401 lied and the first call had landed, the retry is answered 'alreadyApplied'",
    lres && lres.results && lres.results[0].status === "alreadyApplied", JSON.stringify(lres));
  check("...and the child is still paid exactly once", dbl.tables.students[0].wildcatCashBalance === 600,
    String(dbl.tables.students[0].wildcatCashBalance));
}

// =====================================================================
console.log("\nA 401 ON THE COMMAND: ONE SILENT RENEWAL, ONE RETRY, THE SAME RECEIPT\n");
{
  const t = buildSender();
  const res = await t.sendCashAwardCommand(items);
  const calls = awardCalls(t.env);
  check("exactly one silent renewal", t.env.resumes.length === 1, String(t.env.resumes.length));
  check("...and it is FORCED, the kind that replaces a live-but-dead session",
    t.env.resumes[0] && t.env.resumes[0].force === true);
  check("exactly one retry (two calls in all)", calls.length === 2, String(calls.length));
  check("the retry carries the SAME receipt", calls.length === 2 && txnIdsOf(calls[0]) === txnIdsOf(calls[1])
    && txnIdsOf(calls[1]) === items[0].tx.id, calls.map(txnIdsOf).join(" | "));
  check("...and the very same award, field for field",
    calls.length === 2 && JSON.stringify(calls[0].args) === JSON.stringify(calls[1].args));
  check("...sent with the NEW token, not the refused one", calls[0].tok === "tok1" && calls[1] && calls[1].tok === "tok2");
  check("the award counts as landed, so the teacher sees it saved",
    res && t.cashAwardCommandLanded(res, items) === true);
  check("...and its receipt is marked as on the server", t.env.cashIdsOnServer.has(items[0].tx.id));
  check("a retry that lands is not reported as a miss", t.env.notes.length === 0, JSON.stringify(t.env.notes));
  check("the renewal still re-sends the ordinary save, as it always did",
    t.env.saves.length === 1 && t.env.saves[0] === "after token renewal");
  check("and no signed-out bar", t.env.lost.length === 0);
}

// =====================================================================
console.log("\nA SECOND 401 FALLS BACK EXACTLY AS BEFORE\n");
{
  const t = buildSender({ refuseAll: true });
  const res = await t.sendCashAwardCommand(items);
  check("the answer is null, as a failed command always was", res === null);
  check("no more than one renewal and one retry", t.env.resumes.length === 1 && awardCalls(t.env).length === 2,
    `${t.env.resumes.length} renewals, ${awardCalls(t.env).length} calls`);
  check("nothing is marked as on the server, so the ordinary save still carries it",
    t.env.cashIdsOnServer.size === 0 && t.env.auditIdsOnServer.size === 0);
  check("the failure is reported as it was: one 'error' naming the 401, with the receipt",
    t.env.notes.length === 1 && t.env.notes[0].reason === "error" && /Convex HTTP 401/.test(t.env.notes[0].detail)
      && (t.env.notes[0].ids || []).join() === items[0].tx.id, JSON.stringify(t.env.notes));
  check("...and says it WAS retried", /retried once/.test(t.env.notes[0] && t.env.notes[0].detail));
  let threw = false;
  try { await buildSender({ refuseAll: true }).sendCashAwardCommand(items); } catch (e) { threw = true; }
  check("it never throws into the award screen", threw === false);
}

// =====================================================================
console.log("\nNOTHING ELSE IS RETRIED\n");
{
  for (const msg of ["network down", "Convex HTTP 500", "Staff only."]) {
    const t = buildSender({ otherError: msg });
    const res = await t.sendCashAwardCommand(items);
    check(`"${msg}": no renewal, no retry, reported as before`,
      res === null && t.env.resumes.length === 0 && awardCalls(t.env).length === 1
        && t.env.notes.length === 1 && t.env.notes[0].reason === "error" && t.env.notes[0].detail === msg,
      JSON.stringify({ resumes: t.env.resumes.length, calls: awardCalls(t.env).length, notes: t.env.notes }));
  }
  const hung = buildSender({ hang: true, timeoutMs: 30 });
  const hres = await hung.sendCashAwardCommand(items);
  check("a TIMEOUT is an unknown outcome, not a refusal: no renewal, no retry",
    hres === null && hung.env.resumes.length === 0 && awardCalls(hung.env).length === 1
      && hung.env.notes.length === 1 && hung.env.notes[0].reason === "timeout");
  const off = buildSender({ transport: () => ({ ok: false, code: "disabled", results: [] }) });
  await off.sendCashAwardCommand(items);
  check("the switch being off is not a refusal either", off.env.resumes.length === 0 && awardCalls(off.env).length === 1);
}

// =====================================================================
console.log("\nWHEN THE RENEWAL CANNOT HELP\n");
{
  const f = buildSender({ renewFails: true });
  const res = await f.sendCashAwardCommand(items);
  check("renewal fails: nothing is re-sent", res === null && awardCalls(f.env).length === 1);
  check("...the signed-out bar is raised, exactly as a refused save raises it",
    f.env.lost.length === 1 && f.env.lost[0].serverRefused === true);
  check("...and the report says it was NOT retried", f.env.notes.length === 1 && f.env.notes[0].reason === "error"
    && /not retried/.test(f.env.notes[0].detail), JSON.stringify(f.env.notes));

  const s = buildSender({ renewSameToken: true });
  await s.sendCashAwardCommand(items);
  check("a 'renewal' that hands back the SAME token is not retried: it would only be refused again",
    awardCalls(s.env).length === 1);

  const other = buildSender({ renewAs: "someone.else@lapromisefund.org" });
  await other.sendCashAwardCommand(items);
  check("a session that now belongs to SOMEBODY ELSE is not used: the award would be recorded as theirs",
    awardCalls(other.env).length === 1);

  const gone = buildSender({ transport: (name, args, tok, env) => { env.session = null; throw new Error("Convex HTTP 401"); } });
  await gone.sendCashAwardCommand(items);
  check("signed out while the award was on its way: no renewal, no retry",
    gone.env.resumes.length === 0 && awardCalls(gone.env).length === 1);

  const h = buildSender({ renewHangs: true, timeoutMs: 40 });
  const t0 = Date.now();
  const hres = await h.sendCashAwardCommand(items);
  check("a renewal that hangs does not hold the award screen", hres === null && Date.now() - t0 < 2000
    && awardCalls(h.env).length === 1, `${Date.now() - t0}ms`);
}

// =====================================================================
console.log("\nONE RENEWAL, WHOEVER ASKS\n");
{
  // A save's 401 started the renewal a moment before the award's 401 arrived.
  const t = buildSender({ renewDelayMs: 30 });
  t.renewSessionAfterRefusal("the server refused this save: 401");
  const res = await t.sendCashAwardCommand(items);
  check("the award waits on the save's renewal instead of starting a second", t.env.resumes.length === 1,
    String(t.env.resumes.length));
  check("...and retries with what it produced", awardCalls(t.env).length === 2 && awardCalls(t.env)[1].tok === "tok2"
    && res && res.ok === true);

  // Renewed already while the award was in the air.
  const r = buildSender({ transport: (name, args, tok, env) => {
    if (tok === "tok1") { env.session = { idToken: "tok9", me: { kind: "staff", email: "KarenC@lapromisefund.org" } }; throw new Error("Convex HTTP 401"); }
    return { ok: true, results: args.awards.map((a) => ({ txnId: a.txnId, status: "applied", wroteRecords: true, entryId: "a_" + a.txnId })) };
  } });
  const rres = await r.sendCashAwardCommand(items);
  check("renewed while the award was on its way: no second renewal, retried with the new token",
    r.env.resumes.length === 0 && awardCalls(r.env).length === 2 && awardCalls(r.env)[1].tok === "tok9" && rres && rres.ok === true);
}

// =====================================================================
// "SIGN IN AGAIN" -- wildcat-auth.js, run for real against a fake Microsoft.
// =====================================================================
const KAREN = "karenc@lapromisefund.org";
const OTHER = "rosal@lapromisefund.org";
const msalError = (errorCode, name, message) => Object.assign(new Error(message || errorCode), { errorCode, name });
const INTERACTION = () => msalError("interaction_required", "InteractionRequiredAuthError", "interaction_required: AADSTS50058");
const NETWORK = () => msalError("post_request_failed", "BrowserAuthError", "Network request failed");
const jwt = (claims) => "h." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s";

function bootAuth(src, o = {}) {
  const world = {
    cached: o.cached || "tok1", minted: 1, silent: [], redirects: [], order: [], adopted: [],
    expired: new Set(),          // tokens the server refuses (401)
    expireAll: false,            // ...or every token
    meGetStatus: null,           // e.g. 503: the server is down
    refreshError: null,          // what a forceRefresh throws
    refreshDelayMs: 0,
    refreshAs: null,             // a refreshed token that belongs to somebody else
    claimsOf: {},                // token -> idTokenClaims MSAL reports
    emailOf: {},                 // token -> the email the server says it is
    accounts: o.accounts || [{ username: KAREN }],
    active: o.active || null,
    signins: [],                 // the wildcat-auth-signin events, by email
    nativeAs: null,              // who the app's sign-in sheet signs in
    nativeLogins: 0,
    meGetDelayMs: 0,             // how long the server takes to answer me:get
  };
  // Storage that holds what is written, so a test can see MSAL's keys.
  const store = () => {
    const m = new Map();
    return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
      getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); } };
  };
  globalThis.window = {
    location: { origin: "https://wildcatraffle.com", hash: "", pathname: "/", search: "" },
    addEventListener() {},
    dispatchEvent(ev) { if (ev.type === "wildcat-auth-signin") world.signins.push(ev.detail && ev.detail.email); },
    sessionStorage: store(), localStorage: store(),
    msal: {
      PublicClientApplication: class {
        async initialize() {}
        async handleRedirectPromise() { return null; }
        // With accountsInStorage, accounts live in storage as MSAL's really do:
        // a sign-out's wipe removes them, and a renewal's answer writes back.
        getAllAccounts() {
          if (!o.accountsInStorage) return world.accounts;
          const out = [];
          for (let i = 0; i < window.localStorage.length; i++) {
            const k = window.localStorage.key(i);
            if (k.startsWith("msal.account.")) out.push({ username: k.slice("msal.account.".length) });
          }
          return out;
        }
        getActiveAccount() { return world.active; }
        // MSAL judges its cache by the ACCESS token, so without forceRefresh
        // it hands back whatever id token it holds -- expired or not.
        async acquireTokenSilent(req) {
          world.silent.push(req);
          world.order.push(req.forceRefresh ? "silent:refresh" : "silent:cache");
          if (!req.forceRefresh) return { idToken: world.cached, idTokenClaims: world.claimsOf[world.cached] };
          if (world.refreshDelayMs) await sleep(world.refreshDelayMs);
          if (world.refreshError) throw world.refreshError;
          // MSAL writes the renewed account into its cache as it goes.
          window.localStorage.setItem("msal.account." + String(req.account && req.account.username), "cached");
          const tok = "tok" + (++world.minted);
          world.cached = tok;
          world.emailOf[tok] = world.refreshAs || String(req.account && req.account.username).toLowerCase();
          return { idToken: tok };
        }
        async loginRedirect(req) { world.redirects.push(req); world.order.push("redirect"); }
        logoutPopup() { return Promise.resolve(); }
      },
    },
  };
  const errorEl = { textContent: "", addEventListener() {}, style: {}, disabled: false };
  globalThis.document = {
    readyState: "complete",
    querySelector: () => null,
    createElement: () => ({ dataset: {}, src: "", async: false, onload: null, onerror: null, addEventListener() {} }),
    head: { appendChild(el) { if (el && el.onload) el.onload(); } },
    body: { classList: { contains: () => false } },
    addEventListener() {},
    // The staff app is on screen: no student pass view, no student login form.
    getElementById: (id) => (id === "studentPassView" || id === "studentLoginForm") ? null
      : id === "entraSignInError" ? errorEl : { textContent: "", addEventListener() {}, style: {}, disabled: false },
  };
  if (o.native) {
    // The iPhone app: Microsoft's sign-in sheet instead of a redirect.
    window.WC_NATIVE = true;
    window.Capacitor = { Plugins: { SocialLogin: {
      async initialize() {},
      async login() {
        world.nativeLogins++;
        const tok = "ntok" + (++world.minted);
        world.emailOf[tok] = world.nativeAs || KAREN;
        return { result: { idToken: tok } };
      },
    } } };
  }
  globalThis.CustomEvent = class { constructor(n, x) { this.type = n; this.detail = x && x.detail; } };
  globalThis.fetch = async (url, opts) => {
    const tok = String((opts.headers && opts.headers.Authorization) || "").replace(/^Bearer /, "");
    if (world.expireAll || world.expired.has(tok)) return { ok: false, status: 401, json: async () => ({}) };
    if (world.meGetStatus) return { ok: false, status: world.meGetStatus, json: async () => ({}) };
    const { path } = JSON.parse(opts.body);
    if (path === "me:get" && world.meGetDelayMs) await sleep(world.meGetDelayMs);
    const value = path === "me:get" ? { kind: "staff", email: world.emailOf[tok] || KAREN } : null;
    return { ok: true, status: 200, json: async () => ({ status: "success", value }) };
  };
  globalThis.teachers = [{ id: "T034", email: KAREN, name: "Karen Ceballos" },
                         { id: "T035", email: OTHER, name: "Rosa Lopez" }];
  globalThis.establishTeacherSession = async (teacher) => { world.adopted.push(teacher.id); };
  if (o.accountsInStorage) for (const a of world.accounts) window.localStorage.setItem("msal.account." + a.username, "cached");
  new Function(src)();
  return { A: window.WildcatAuth, world, errorEl };
}
// signInStaff never resolves in redirect flow (the browser leaves the page),
// so every press is raced against a beat. A press that keeps the page answers.
const press = (A) => Promise.race([A.signInWithMicrosoft(), sleep(60).then(() => "no answer (left the page)")]);
// This tab's staff session, then an hour later the server refuses its token.
async function heldThenExpired(src, o) {
  const b = bootAuth(src, o);
  await b.A.resumeSession({ knownStaff: true });
  b.world.expired.add(b.A.getSession().idToken);
  return b;
}

console.log("\n\"SIGN IN AGAIN\" RENEWS INSTEAD OF HANDING BACK THE EXPIRED SESSION\n");
{
  const { A, world } = bootAuth(authSrc);
  await A.resumeSession({ knownStaff: true });                 // this tab's staff session
  check("setup: this tab holds a staff session on tok1", A.getSession() && A.getSession().idToken === "tok1");
  world.expired.add("tok1");                                   // an hour later, the server refuses it
  const before = world.silent.length;
  const out = await press(A);
  check("pressing it asks MSAL for a NEW token (forceRefresh), not the held one",
    world.silent.length === before + 1 && world.silent[before].forceRefresh === true,
    JSON.stringify(world.silent.slice(before)));
  check("...and the session now carries it", A.getSession().idToken === "tok2", A.getSession().idToken);
  check("...with NO redirect, so the page and the money in it stay put", world.redirects.length === 0);
  check("...and the staff record is adopted once, as any sign-in does", world.adopted.length === 1);
  check("...and the press answers ok", out && out.ok === true, JSON.stringify(out));
}
{
  const { A, world } = await heldThenExpired(authSrc);
  world.refreshError = INTERACTION();
  await press(A);
  check("when Microsoft says a person must sign in, it falls through to the redirect",
    world.redirects.length === 1, JSON.stringify(world.order));
  check("...but only AFTER the silent attempt", world.order.join(",") === "silent:cache,silent:refresh,redirect",
    world.order.join(","));
}
{
  // Nothing held: the login-screen press is the guarded, cache-first resume it always was.
  const { A, world } = bootAuth(authSrc);
  await press(A);
  check("with no session held, the button reads MSAL's cache first, unforced, as before",
    world.silent.length === 1 && !world.silent[0].forceRefresh && A.getSession().idToken === "tok1"
      && world.redirects.length === 0, JSON.stringify(world.silent));
}
{
  // The renewal a refused SAVE asks for is forced too, so it also skips the cache.
  const { A, world } = await heldThenExpired(authSrc);
  const fresh = await A.resumeSession({ force: true });
  check("a forced resume (the save's and the award's renewal) returns a token the server accepts",
    fresh && fresh.idToken === "tok2" && world.silent[world.silent.length - 1].forceRefresh === true);
}

// =====================================================================
console.log("\n1. THE REDIRECT ONLY WHEN A PERSON IS NEEDED; OTHERWISE THE PAGE IS KEPT\n");
{
  const { A, world, errorEl } = await heldThenExpired(authSrc);
  world.refreshError = NETWORK();
  const out = await press(A);
  check("the network drops during the refresh: NO redirect, the page and its money are kept",
    world.redirects.length === 0 && A.getSession().idToken === "tok1", JSON.stringify(world.order));
  check("...the press answers 'kept' with the plain message for the bar",
    out && out.kept === true && out.message === "Could not reach Microsoft. Your awards are still here — try again in a moment.",
    JSON.stringify(out));
  check("...and the same words are on the sign-in form too", errorEl.textContent === out.message);
  world.refreshError = null;
  const again = await press(A);
  check("...pressing again once the network is back renews, still without a redirect",
    again && again.ok === true && A.getSession().idToken === "tok2" && world.redirects.length === 0);
}
{
  const { A, world } = await heldThenExpired(authSrc);
  world.meGetStatus = 503;
  const out = await press(A);
  check("the server is down (me:get 503): kept, no redirect", out && out.kept === true && world.redirects.length === 0,
    JSON.stringify(out));
}
{
  const { A, world } = await heldThenExpired(authSrc);
  world.refreshError = msalError("monitor_window_timeout", "BrowserAuthError", "Token acquisition in iframe failed due to timeout.");
  const out = await press(A);
  check("a silent-frame timeout: kept, no redirect", out && out.kept === true && world.redirects.length === 0);
}
{
  // The Microsoft library cannot be loaded (a CDN or filter problem).
  const { A, world } = await heldThenExpired(authSrc);
  A.forgetCachedStaffAccount();          // drops the loaded client, keeps the session object
  delete window.msal;                    // ...and the library does not come back
  const out = await press(A);
  check("the Microsoft library does not load: kept, no redirect", out && out.kept === true && world.redirects.length === 0,
    JSON.stringify(out));
}
{
  const { A, world } = await heldThenExpired(authSrc);
  world.accounts = [];
  await press(A);
  check("no cached Microsoft account at all: a person is needed, so it redirects", world.redirects.length === 1);
}
{
  const { A, world } = await heldThenExpired(authSrc);
  world.expireAll = true;                // even the NEW token is refused
  await press(A);
  check("the server refuses even the NEW token (401): only a real sign-in helps, so it redirects",
    world.redirects.length === 1 && world.order.join(",") === "silent:cache,silent:refresh,redirect", world.order.join(","));
}
{
  // The classifier, row by row.
  const needs = new Function(lift(authSrc, "needsInteraction") + "\nreturn needsInteraction;")();
  const yes = [INTERACTION(), msalError("login_required"), msalError("consent_required"), msalError("no_tokens_found"),
    msalError("refresh_token_expired"), msalError("invalid_grant"), Object.assign(new Error("x"), { name: "InteractionRequiredAuthError" }),
    Object.assign(new Error("renewed someone else"), { wcNeedsInteraction: true })];
  const no = [NETWORK(), msalError("no_network_connectivity"), msalError("monitor_window_timeout"),
    new Error("Failed to load https://cdn.jsdelivr.net/npm/@azure/msal-browser@5.18.0/lib/msal-browser.min.js"),
    new Error("Convex HTTP 503"), new TypeError("Failed to fetch"), null];
  check("these need a person: interaction_required, login_required, consent_required, no_tokens_found, expired grants",
    yes.every((e) => needs(e) === true), yes.map((e) => needs(e)).join());
  check("these do not: network, timeouts, a CDN failure, a 5xx, a failed fetch",
    no.every((e) => needs(e) === false), no.map((e) => needs(e)).join());
}

// =====================================================================
console.log("\n2. ONE RENEWAL AT A TIME, AND ONE PRESS AT A TIME\n");
{
  const { A, world } = await heldThenExpired(authSrc);
  world.refreshDelayMs = 30;
  const before = world.silent.length;
  // A refused save, a refused award and two presses, all at once.
  const all = await Promise.all([A.resumeSession({ force: true }), A.resumeSession({ force: true }), press(A), press(A)]);
  const refreshes = world.silent.slice(before).filter((r) => r.forceRefresh).length;
  check("a save's, an award's and two presses' renewals are ONE forced refresh", refreshes === 1, String(refreshes));
  check("...and every caller gets its answer", all[0] && all[1] && all[0].idToken === "tok2" && all[1].idToken === "tok2");
  check("...with no redirect", world.redirects.length === 0);
}
// The bar's button, lifted from script.js with a small fake DOM.
function buildBar(o = {}) {
  const env = { presses: 0, resolvers: [], saves: [] };
  const mkEl = (tag) => {
    const el = {
      tagName: tag, className: "", textContent: "", disabled: false, attrs: {}, children: [], listeners: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(n, f) { (this.listeners[n] = this.listeners[n] || []).push(f); },
      click() { (this.listeners.click || []).forEach((f) => f()); },
      insertBefore(n, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, n); },
      querySelector(sel) { return this.children.find((c) => ("." + c.className) === sel) || null; },
      remove() {},
    };
    Object.defineProperty(el, "innerHTML", { set() {
      const span = mkEl("span"); const btn = mkEl("button"); btn.className = "wc-session-signin"; btn.textContent = "Sign in again";
      this.children = [span, btn];
    } });
    return el;
  };
  let bar = null;
  const document = {
    getElementById: (id) => (id === "wcSessionLost" ? bar : null),
    createElement: (tag) => mkEl(tag),
    body: { appendChild(el) { bar = el; } },
  };
  const signInWithMicrosoft = () => { env.presses++; return new Promise((r) => env.resolvers.push(r)); };
  const body = [
    "let _sessionLostShown = false; let _hadSessionThisLoad = true;",
    (o.mutate || same)(lift(script, "reportSessionLost")),
    "return { reportSessionLost };",
  ].join("\n");
  const f = new Function("window", "document", "signInWithMicrosoft", "console", "requestSave", body)(
    { WildcatAuth: { getSession: () => ({ idToken: "dead" }) } }, document, signInWithMicrosoft, { error() {} },
    (reason) => env.saves.push(reason));
  f.reportSessionLost("the server refused this save: 401", true);
  const btn = () => bar.querySelector(".wc-session-signin");
  return { env, bar: () => bar, btn };
}
{
  const b = buildBar();
  b.btn().click();
  check("the bar's button says 'Signing in…' and is disabled while a press is running",
    b.btn().disabled === true && b.btn().textContent === "Signing in…");
  b.btn().click(); b.btn().click();
  check("...so pressing again does not start a second sign-in", b.env.presses === 1, String(b.env.presses));
  b.env.resolvers[0]({ ok: false, kept: true, message: "Could not reach Microsoft. Your awards are still here — try again in a moment." });
  await sleep(5);
  const note = b.bar().querySelector(".wc-session-note");
  check("a kept page gets the plain message on the bar", note && /Could not reach Microsoft/.test(note.textContent)
    && note.attrs.role === "status");
  check("...and the button comes back for another try", b.btn().disabled === false && b.btn().textContent === "Sign in again");
  b.btn().click();
  check("...which starts exactly one more", b.env.presses === 2);
}

// =====================================================================
console.log("\n3. THE RENEWAL IS FOR THE PERSON HOLDING THE SESSION, NOBODY ELSE\n");
{
  // A shared Chromebook after a select_account redirect: two cached accounts,
  // and the first one is not the person signed in here.
  const { A, world } = bootAuth(authSrc, { accounts: [{ username: OTHER }, { username: KAREN }] });
  world.emailOf.tok1 = KAREN;
  // Held as Karen (the restore used the first account, but the server said Karen).
  await A.resumeSession({ knownStaff: true });
  world.expired.add("tok1");
  await press(A);
  const forced = world.silent.filter((r) => r.forceRefresh);
  check("the forced refresh is for the account that matches the session, not accounts[0]",
    forced.length === 1 && forced[0].account.username === KAREN, JSON.stringify(forced.map((r) => r.account.username)));
  check("...so the session is renewed for the same person, with no redirect",
    A.getSession().me.email === KAREN && A.getSession().idToken === "tok2" && world.redirects.length === 0);
}
{
  const { A, world } = bootAuth(authSrc, { accounts: [{ username: OTHER }, { username: "x@y.org" }],
    active: { username: "someone@lapromisefund.org", idTokenClaims: { email: KAREN } } });
  await A.resumeSession({ knownStaff: true });
  world.expired.add("tok1");
  world.refreshAs = KAREN;               // its token's email claim is Karen's
  await press(A);
  const forced = world.silent.filter((r) => r.forceRefresh);
  check("MSAL's active account is used when its email claim is the session's",
    forced.length === 1 && forced[0].account.username === "someone@lapromisefund.org"
      && A.getSession().idToken === "tok2" && world.redirects.length === 0);
}
{
  const { A, world } = await heldThenExpired(authSrc);
  world.accounts = [{ username: OTHER }];
  await press(A);
  check("no cached account is the session's person: nothing is renewed for anybody else",
    world.silent.filter((r) => r.forceRefresh).length === 0 && A.getSession().me.email === KAREN);
  check("...and a person is needed, so it redirects (where they choose the account)", world.redirects.length === 1);
}
{
  // Microsoft hands back a token for somebody else anyway.
  const { A, world } = await heldThenExpired(authSrc);
  world.refreshAs = OTHER;
  await press(A);
  check("a renewed token that the server says is SOMEBODY ELSE never replaces the session",
    A.getSession().me.email === KAREN && A.getSession().idToken === "tok1" && world.adopted.length === 0);
  check("...and is treated as needing a person (redirect), not adopted", world.redirects.length === 1);
  const { A: A2, world: w2 } = await heldThenExpired(authSrc);
  w2.refreshAs = OTHER;
  const viaSave = await A2.resumeSession({ force: true });
  check("the save's and the award's renewal refuse it too", viaSave === null && A2.getSession().me.email === KAREN);
}

// =====================================================================
console.log("\n4. THE PAGE-LOAD RESTORE CHECKS THE CACHED TOKEN INSTEAD OF TRUSTING IT\n");
{
  const now = Math.floor(Date.now() / 1000);
  for (const [label, exp, refresh] of [["already expired", now - 60, true], ["two minutes left", now + 120, true],
                                       ["an hour left", now + 3600, false]]) {
    const { A, world } = bootAuth(authSrc);
    world.claimsOf.tok1 = { exp };
    const s = await A.resumeSession({ knownStaff: true });
    const kinds = world.order.join(",");
    check(`restore with the cached id token ${label}: ${refresh ? "refreshed once, silently" : "used as it is"}`,
      refresh ? (kinds === "silent:cache,silent:refresh" && s && s.idToken === "tok2")
              : (kinds === "silent:cache" && s && s.idToken === "tok1"), kinds);
    check(`...no redirect (${label})`, world.redirects.length === 0);
  }
  const { A, world } = bootAuth(authSrc, { cached: jwt({ exp: now - 30 }) });
  const s = await A.resumeSession({ knownStaff: true });
  check("the expiry is read from the token itself when MSAL gives no claims",
    world.order.join(",") === "silent:cache,silent:refresh" && s && s.idToken === "tok2", world.order.join(","));
}
{
  // The token's expiry cannot be read, but the server refuses it.
  const { A, world } = bootAuth(authSrc);
  world.expired.add("tok1");
  const s = await A.resumeSession({ knownStaff: true });
  check("a cached token the server refuses (401) gets ONE fresh try, and the restore works",
    world.order.join(",") === "silent:cache,silent:refresh" && s && s.idToken === "tok2", world.order.join(","));
}
{
  const { A, world } = bootAuth(authSrc);
  world.expireAll = true;
  const s = await A.resumeSession({ knownStaff: true });
  check("...ONCE: if the fresh one is refused too, it gives up quietly, no loop and no redirect",
    s === null && world.order.join(",") === "silent:cache,silent:refresh" && world.redirects.length === 0, world.order.join(","));
}
{
  const { A, world } = bootAuth(authSrc);
  world.meGetStatus = 503;
  const s = await A.resumeSession({ knownStaff: true });
  check("a server that is down is not a refused token: no refresh is spent on it",
    s === null && world.order.join(",") === "silent:cache");
}

// =====================================================================
console.log("\n5. THE FINAL REVIEW (2026-10-01): SIGNING OUT, AND THE APP'S SIGN-IN SHEET\n");
const msalKeys = () => {
  const out = [];
  for (const st of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < st.length; i++) if (String(st.key(i)).startsWith("msal.")) out.push(st.key(i));
  }
  return out;
};
{
  // A shared Chromebook: a renewal is on its way, and the teacher signs out.
  const { A, world } = await heldThenExpired(authSrc);
  world.refreshDelayMs = 40;
  const renewal = A.resumeSession({ force: true });
  await sleep(5);
  A.signOut();
  const out = await renewal;
  check("a sign-out while a renewal is on its way: the renewal does NOT sign the teacher back in",
    out === null && A.getSession() === null, JSON.stringify(A.getSession() && A.getSession().me));
  check("...and the account MSAL wrote back meanwhile is wiped again, so nothing is left to resume",
    msalKeys().length === 0, msalKeys().join());
  check("...and no sign-in is announced to the app (which would reload it as that teacher)",
    world.signins.length === 1, JSON.stringify(world.signins));
}
{
  const { A, world, errorEl } = await heldThenExpired(authSrc);
  world.refreshDelayMs = 40;
  const pressed = press(A);
  await sleep(5);
  A.signOut();
  const out = await pressed;
  check("a 'Sign in again' press overtaken by a sign-out answers quietly: no record adopted, no redirect, no error",
    out && out.ok === false && world.adopted.length === 0 && world.redirects.length === 0 && errorEl.textContent === "",
    JSON.stringify({ out, adopted: world.adopted, err: errorEl.textContent }));
}
{
  // ...and the next person signs in before the old renewal lands.
  const { A, world } = await heldThenExpired(authSrc);
  world.refreshDelayMs = 40;
  const late = A.resumeSession({ force: true });
  await sleep(5);
  A.signOut();
  world.cached = "tokB"; world.emailOf.tokB = OTHER;
  await A.resumeSession({ knownStaff: true });
  check("setup: the next person (Rosa) is signed in", A.getSession() && A.getSession().me.email === OTHER);
  await late;
  check("the old renewal landing late does not replace the next person's session",
    A.getSession() && A.getSession().me.email === OTHER && A.getSession().idToken === "tokB");
}
{
  // A renewal dropped by a sign-out must not drop the NEXT renewal when it settles.
  const { A, world } = await heldThenExpired(authSrc);
  world.refreshDelayMs = 40;
  const doomed = A.resumeSession({ force: true });
  await sleep(5);
  A.signOut();
  world.expired.clear();
  await A.resumeSession({ knownStaff: true });                 // signed in again, on tok1
  world.expired.add(A.getSession().idToken);                   // ...which the server then refuses
  world.refreshDelayMs = 120;
  const before = world.silent.filter((r) => r.forceRefresh).length;
  const second = A.resumeSession({ force: true });
  await doomed;                                                // the old one settles meanwhile
  await sleep(20);
  const third = A.resumeSession({ force: true });              // a refused save arrives
  await Promise.all([second, third]);
  check("after a sign-out, the old renewal settling does not split the next one in two",
    world.silent.filter((r) => r.forceRefresh).length - before === 1,
    String(world.silent.filter((r) => r.forceRefresh).length - before));
}
{
  // THE APP. Its first staff sign-in goes through the sheet.
  const { A, world } = bootAuth(authSrc, { native: true, accounts: [] });
  const out = await press(A);
  check("in the app, a first sign-in through the sheet adopts the staff record (it used to crash on 'me')",
    out && out.ok === true && world.adopted.length === 1 && A.getSession().me.email === KAREN, JSON.stringify(out));
  world.expired.add(A.getSession().idToken);                   // an hour later, refused
  world.nativeAs = OTHER;                                      // somebody else picks their account in the sheet
  const other = await press(A);
  check("'Sign in again' in the app refuses a DIFFERENT person: the session and its waiting money stay with Karen",
    other && other.ok === false && A.getSession().me.email === KAREN && world.adopted.length === 1,
    JSON.stringify(other));
  check("...and says plainly who to choose", /signed in as karenc@lapromisefund\.org/.test(other && other.message || "")
    && /sign out first to switch/.test(other && other.message || ""), other && other.message);
  world.nativeAs = KAREN;
  const same = await press(A);
  check("...while the same person picking their own account is signed back in, with no reload",
    same && same.ok === true && A.getSession().me.email === KAREN && /^ntok/.test(A.getSession().idToken)
      && world.adopted.length === 2 && world.redirects.length === 0, JSON.stringify(same));
}
{
  const b = buildBar();
  b.btn().click();
  b.env.resolvers[0]({ ok: true });
  await sleep(5);
  check("signed back in from the bar: what is waiting is sent straight away (one save)",
    b.env.saves.length === 1 && b.env.saves[0] === "after sign in again", JSON.stringify(b.env.saves));
  b.btn().click();
  b.env.resolvers[1]({ ok: false, kept: true, message: "Could not reach Microsoft." });
  await sleep(5);
  check("...but not when the press did not sign anybody in", b.env.saves.length === 1);
}

{
  // RE-REVIEW: the next person presses the staff button while the old
  // renewal is still asking the server who its token belongs to.
  const { A, world } = await heldThenExpired(authSrc, { accountsInStorage: true });
  world.refreshDelayMs = 40; world.meGetDelayMs = 60;
  const renewal = A.resumeSession({ force: true });
  await sleep(5);
  A.signOut();                                                 // Karen leaves
  await sleep(45);                                             // Microsoft has answered; the server has not
  const adoptedBefore = world.adopted.length;
  const rosa = await press(A);                                 // Rosa presses the staff button
  await renewal;
  await sleep(120);                                            // let the press finish
  check("the next person's press finds NO account left behind: it goes to Microsoft (redirect), it does not resume the last teacher",
    world.redirects.length === 1 && world.adopted.length === adoptedBefore && A.getSession() === null,
    JSON.stringify({ rosa, adopted: world.adopted, session: A.getSession() && A.getSession().me }));
}
{
  // A forced renewal with nobody signed in renews nobody.
  const { A, world } = bootAuth(authSrc);
  const out = await A.resumeSession({ force: true });
  check("a forced renewal with no session held signs nobody in (it used to take the first cached account)",
    out === null && A.getSession() === null && world.silent.length === 0, JSON.stringify(world.silent));
}
{
  const b = buildBar();
  b.btn().click();
  b.env.resolvers[0]({ ok: false, message: "This page is signed in as karenc@lapromisefund.org, but Microsoft signed in rosal@lapromisefund.org. Choose karenc@lapromisefund.org, or sign out first to switch." });
  await sleep(5);
  const note = b.bar().querySelector(".wc-session-note");
  check("a refusal (the wrong account picked in the app) is shown ON THE BAR, where the teacher is looking",
    note && /sign out first to switch/.test(note.textContent));
  b.btn().click();
  b.env.resolvers[1]({ ok: false, message: "" });
  await sleep(5);
  check("...while a cancelled press leaves the message as it was", /sign out first to switch/.test(b.bar().querySelector(".wc-session-note").textContent));
}

// =====================================================================
console.log("\nDO THE CHECKS HAVE TEETH?\n");
{
  // The old button: a held session handed straight back.
  const oldBtn = mustReplace("button renews", "const renewing = holding && !nativeSignInAvailable();", "const renewing = false;")(
    mustReplace("no resume when holding", "} else if (!holding) {", "} else {")(authSrc));
  const { A, world } = await heldThenExpired(oldBtn);
  const before = world.silent.length;
  await press(A);
  check("TEETH: the old 'Sign in again' keeps the dead token and never renews or redirects (the loop)",
    A.getSession().idToken === "tok1" && world.silent.length === before && world.redirects.length === 0);
}
{
  // A forced resume that still reads the cache gets the refused token back.
  const cacheFirst = mustReplace("forceRefresh", "forceRefresh: force,", "")(authSrc);
  const { A, world } = await heldThenExpired(cacheFirst);
  await press(A);
  check("TEETH: without forceRefresh, the cache hands back the expired token and the page redirects",
    world.redirects.length === 1 && A.getSession().idToken === "tok1");
}
{
  // Every failure treated as "a person is needed" -- the reviewed bug.
  const anyFailure = mustReplace("keep the page", "if (renewal.failure !== RENEW_NEEDS_INTERACTION) {", "if (false) {")(authSrc);
  const { A, world } = await heldThenExpired(anyFailure);
  world.refreshError = NETWORK();
  await press(A);
  check("TEETH: redirecting on any failure reloads the page over a network blip", world.redirects.length === 1);
}
{
  const unshared = mustReplace("one renewal", "if (forcedRenewal) return forcedRenewal;", "")(authSrc);
  const { A, world } = await heldThenExpired(unshared);
  world.refreshDelayMs = 30;
  const before = world.silent.length;
  await Promise.all([A.resumeSession({ force: true }), press(A)]);
  check("TEETH: without the shared renewal, a save and a press run two forced refreshes",
    world.silent.slice(before).filter((r) => r.forceRefresh).length === 2);
}
{
  const b = buildBar({ mutate: mustReplace("button guard", "if (signInBtn.disabled) return;", "") });
  b.btn().click(); b.btn().click();
  check("TEETH: without the guard, a second press starts a second sign-in", b.env.presses === 2);
}
{
  const firstAccount = mustReplace("held account", "const account = wanted ? heldAccount(app, accounts, wanted) : accounts[0];",
    "const account = accounts[0];")(authSrc);
  const { A, world } = bootAuth(firstAccount, { accounts: [{ username: OTHER }, { username: KAREN }] });
  await A.resumeSession({ knownStaff: true });
  world.expired.add("tok1");
  await press(A);
  const forced = world.silent.filter((r) => r.forceRefresh);
  check("TEETH: renewing accounts[0] renews somebody else's account (and then has to redirect)",
    forced.length === 1 && forced[0].account.username === OTHER && world.redirects.length === 1);
}
{
  const noSamePerson = mustReplace("same person", "if (sameAs && normalEmail(me.email) !== normalEmail(sameAs)) {",
    "if (false) {")(authSrc);
  const { A, world } = await heldThenExpired(noSamePerson);
  world.refreshAs = OTHER;
  await press(A);
  check("TEETH: without the same-person check, the session is handed to somebody else",
    A.getSession().me.email === OTHER);
}
{
  const trustCache = mustReplace("near expiry", "if (left !== null && left < ID_TOKEN_MIN_SECONDS) {", "if (false) {")(authSrc);
  const { A, world } = bootAuth(trustCache);
  world.claimsOf.tok1 = { exp: Math.floor(Date.now() / 1000) + 120 };
  const s = await A.resumeSession({ knownStaff: true });
  check("TEETH: trusting the cache restores a token with two minutes left (the next write 401s)",
    s && s.idToken === "tok1" && world.order.join(",") === "silent:cache");
}
{
  const no401Retry = mustReplace("401 retry", "if (refreshed || !refusedByServer(err)) throw err;", "throw err;")(authSrc);
  const { A, world } = bootAuth(no401Retry);
  world.expired.add("tok1");
  const s = await A.resumeSession({ knownStaff: true });
  check("TEETH: without the one fresh try, a refused cached token leaves the restore signed out", s === null);
}
{
  const noRetry = buildSender({ mutateSender: mustReplace("no retry",
    "const fresh = await freshTokenAfterAwardRefusal(session);", "const fresh = null;") });
  const res = await noRetry.sendCashAwardCommand(items);
  check("TEETH: without the retry, a 401 goes straight to the fallback (the 9/29 shape)",
    res === null && awardCalls(noRetry.env).length === 1);
}
{
  const newReceipt = buildSender({ mutateSender: mustReplace("new receipt", "res = await attempt(fresh);",
    "res = await auth.convexMutation('cashAward:award', Object.assign({}, args, { awards: args.awards.map(a => Object.assign({}, a, { txnId: a.txnId + '_r' })) }), fresh);") });
  await newReceipt.sendCashAwardCommand(items);
  const calls = awardCalls(newReceipt.env);
  check("TEETH: a retry that minted a new receipt is caught (the server could not absorb it)",
    calls.length === 2 && txnIdsOf(calls[0]) !== txnIdsOf(calls[1]));
}
{
  // ONCE: a second round of renew-and-retry would be caught by the counts.
  const twice = buildSender({ refuseAll: true, mutateSender: mustReplace("once", "res = await attempt(fresh);",
    "res = await attempt(fresh).catch(async (e2) => { const f2 = await freshTokenAfterAwardRefusal({ idToken: fresh, me: session.me }); if (!f2) throw e2; return attempt(f2); });") });
  await twice.sendCashAwardCommand(items);
  check("TEETH: a second round of renew-and-retry is caught (two renewals, three calls)",
    twice.env.resumes.length === 2 && awardCalls(twice.env).length === 3,
    `${twice.env.resumes.length} renewals, ${awardCalls(twice.env).length} calls`);
}
{
  // THE SAME PERSON: without the rule, somebody else's token carries the award.
  const helper = lift(script, "freshTokenAfterAwardRefusal");
  const loose = mustReplace("same person", "return who(s) === who(refused) ? String(s.idToken) : null;",
    "return String(s.idToken);")(helper);
  const t = buildSenderFrom(script.replace(helper, loose), { renewAs: "someone.else@lapromisefund.org" });
  await t.sendCashAwardCommand(items);
  check("TEETH: without the same-person rule, the award is re-sent under somebody else's token",
    awardCalls(t.env).length === 2);
}
{
  const anyError = buildSender({ otherError: "network down", mutateSender: mustReplace("401 gate",
    "if (!(typeof isUnauthorized === 'function' && isUnauthorized(e))) throw e;", "") });
  await anyError.sendCashAwardCommand(items);
  check("TEETH: retrying on any error is caught (a network failure renewed and re-sent)",
    anyError.env.resumes.length === 1 && awardCalls(anyError.env).length === 2);
}
{
  const unshared = buildSender({ renewDelayMs: 30, mutateRenew: mustReplace("single flight",
    "if (_renewAfterRefusalInFlight) return _renewAfterRefusalInFlight;", "") });
  unshared.renewSessionAfterRefusal("the server refused this save: 401");
  await unshared.sendCashAwardCommand(items);
  check("TEETH: without the shared renewal, a save and an award renew twice", unshared.env.resumes.length === 2,
    String(unshared.env.resumes.length));
}

{
  const noCount = mustReplace("sign-out count", "signOutCount++;", "")(authSrc);
  const { A, world } = await heldThenExpired(noCount);
  world.refreshDelayMs = 40;
  const renewal = A.resumeSession({ force: true });
  await sleep(5);
  A.signOut();
  await renewal;
  check("TEETH: without the sign-out count, a renewal on its way signs the teacher straight back in",
    A.getSession() && A.getSession().me.email === KAREN && msalKeys().length > 0);
}
{
  const loose = mustReplace("own renewal", "if (forcedRenewal === renewal) forcedRenewal = null;", "forcedRenewal = null;")(authSrc);
  const { A, world } = await heldThenExpired(loose);
  world.refreshDelayMs = 40;
  const doomed = A.resumeSession({ force: true });
  await sleep(5);
  A.signOut();
  world.expired.clear();
  await A.resumeSession({ knownStaff: true });
  world.expired.add(A.getSession().idToken);
  world.refreshDelayMs = 120;
  const before = world.silent.filter((r) => r.forceRefresh).length;
  const second = A.resumeSession({ force: true });
  await doomed;
  await sleep(20);
  const third = A.resumeSession({ force: true });
  await Promise.all([second, third]);
  check("TEETH: clearing whichever renewal is running splits the next one in two",
    world.silent.filter((r) => r.forceRefresh).length - before === 2);
}
{
  const oldSheet = mustReplace("native answer", "return finishSignIn(idToken, 'staff', sameAs || null);",
    "await finishSignIn(idToken, 'staff');")(authSrc);
  const { A, world } = bootAuth(oldSheet, { native: true, accounts: [] });
  const out = await press(A);
  check("TEETH: the old app sign-in answered nothing, so adopting the record crashed",
    out && out.ok === false && world.adopted.length === 0, JSON.stringify(out));
  world.nativeAs = OTHER;
  await press(A);
  check("TEETH: ...and handed the held session to whoever picked an account in the sheet",
    A.getSession().me.email === OTHER);
}
{
  const b = buildBar({ mutate: mustReplace("save after", "requestSave('after sign in again');", "") });
  b.btn().click();
  b.env.resolvers[0]({ ok: true });
  await sleep(5);
  check("TEETH: without the save, a sign-in from the bar leaves the waiting money for the next change",
    b.env.saves.length === 0);
}
{
  const late = mustReplace("checked on answer", "      if (signedOutSince(count)) throw abandonSignIn();\n", "")(authSrc);
  const { A, world } = await heldThenExpired(late, { accountsInStorage: true });
  world.refreshDelayMs = 40; world.meGetDelayMs = 60;
  const renewal = A.resumeSession({ force: true });
  await sleep(5);
  A.signOut();
  await sleep(45);
  await press(A);
  await renewal;
  await sleep(120);                                            // let the press finish
  check("TEETH: checking only after the server answers lets the next press resume the teacher who left",
    world.adopted.includes("T034") && world.redirects.length === 0, JSON.stringify(world.adopted));
}
{
  const firstCached = mustReplace("nobody to renew", "if (force && !wanted) return failedRenewal(RENEW_NEEDS_INTERACTION, 'no session to renew');", "")(authSrc);
  const { A } = bootAuth(firstCached);
  const out = await A.resumeSession({ force: true });
  check("TEETH: without the rule, a forced renewal with nobody held signs in the first cached account", out && A.getSession() !== null);
}
{
  const keptOnly = buildBar({ mutate: mustReplace("bar message", "if (out && out.ok === false && out.message) {", "if (out && out.kept && out.message) {") });
  keptOnly.btn().click();
  keptOnly.env.resolvers[0]({ ok: false, message: "This page is signed in as karenc@lapromisefund.org" });
  await sleep(5);
  check("TEETH: showing only 'kept' messages hides the wrong-account refusal", !keptOnly.bar().querySelector(".wc-session-note"));
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
