// Why an award missed the award command -- the diagnostic. Run: npm test
//
// The owner's choice, 2026-09-27: find the cause before building more. On
// 2026-09-25, 23 of 176 awards reached the server through the ordinary save
// instead of cashAward:award, from tabs that had used the command minutes
// earlier; the ordinary save is the path a page reload can lose money on, and
// the server keeps only ~90 seconds of logs. So both sides now write it down
// (cashFallbackLog): the SERVER when a save applies an award the command did
// not, and the BROWSER with the reason its command did not land.
//
// A diagnostic only: these checks also prove it never moves money, never
// marks anything as sent, and never throws into the award screen.
import { readFileSync } from "node:fs";
import ts from "typescript";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const src = (f) => readFileSync(new URL("./convex/" + f, import.meta.url), "utf8");
let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const lift = (s, name) => {
  const i = s.indexOf("function " + name + "(");
  if (i < 0) throw new Error("missing " + name);
  const head = s.lastIndexOf("\n", i);
  let d = 0, k = s.indexOf("{", i);
  for (; k < s.length; k++) { if (s[k] === "{") d++; else if (s[k] === "}") { d--; if (d === 0) break; } }
  return s.slice(head + 1, k + 1);
};

// ------------------------------------------------------------------ server
console.log("\nTHE SERVER WRITES DOWN AN AWARD THE COMMAND DID NOT DELIVER\n");
{
  const load = (name, deps = {}) => {
    const js = ts.transpileModule(src(name), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const m = { exports: {} };
    new Function("require", "module", "exports", js)((p) => { if (deps[p]) return deps[p]; throw new Error("import " + p); }, m, m.exports);
    return m.exports;
  };
  const shape = load("appDataShape.ts");
  const row = { _id: "s1", legacyId: "12101", studentNumber: "12101", wildcatCashBalance: 500, wildcatCashEarned: 500,
    wildcatCashSpent: 0, wildcatCashDeducted: 0, cashApplied: null };
  const at = new Date().toISOString();
  const rec = { id: "12101", cashDelta: { wildcatCashBalance: 100, wildcatCashEarned: 100 },
    cashMovements: [{ id: "txn_" + Date.now() + "_abc1234", at, amount: 100, kind: "award" }] };
  const plan = shape.planSave([row], [rec], shape.STUDENT_WRITABLE, (r) => [r.legacyId, r.studentNumber], null);
  check("the save plan names each movement it applied (not only a count)",
    plan.movementsApplied === 1 && plan.movementsAppliedList.length === 1
      && plan.movementsAppliedList[0].id === rec.cashMovements[0].id && plan.movementsAppliedList[0].kind === "award");
  const rowAgain = Object.assign({}, row, plan.patches[0].patch);
  const again = shape.planSave([rowAgain], [rec], shape.STUDENT_WRITABLE, (r) => [r.legacyId, r.studentNumber], null);
  check("...and a re-send that is absorbed is not named as applied", again.movementsAppliedList.length === 0);

  const save = src("appData.ts");
  check("appData:save logs awards and deductions it applied, as via 'save'",
    /const viaSave = movementsAppliedList\.filter\(\(m\) => m\.kind === "award" \|\| m\.kind === "deduct"\);[\s\S]{0,300}ctx\.db\.insert\("cashFallbackLog", \{[\s\S]{0,120}via: "save"/.test(save));
  check("...in the save's own transaction, one row per save, ids only",
    /reason: "applied_by_save",\s*count: viaSave\.length,\s*ids: viaSave\.slice\(0, FALLBACK_IDS_MAX\)\.map\(\(m\) => m\.id\),/.test(save));
  const award = src("cashAward.ts");
  const report = award.slice(award.indexOf("export const reportFailure"), award.indexOf("export const fallbacks"));
  check("the browser's report is staff only, and the actor is the token", /await requireStaff\(ctx\)/.test(report)
    && /actorEmail: email/.test(report) && !/args\.actorEmail|r\.actorEmail/.test(report));
  check("...trimmed and capped (30 reports, 60 ids each)", /reports\.slice\(0, 30\)/.test(report) && /r\.ids\.slice\(0, 60\)/.test(report));
  check("...and moves no money: it writes only the log", (report.match(/ctx\.db\.(insert|patch|replace|delete)\(/g) || []).join() === "ctx.db.insert(" && /"cashFallbackLog"/.test(report));
  check("it is internal (read from the command line, not the browser)", /export const fallbacks = internalQuery/.test(award));
  check("the table exists, indexed by time", /cashFallbackLog: defineTable\(\{[\s\S]{0,1200}\}\)\.index\("by_at", \["at"\]\)\.index\("by_reportId", \["reportId"\]\)/.test(src("schema.ts")));
}

// ------------------------------------------------ the readout, run for real
console.log("\nTHE READOUT, RUN ON A SMALL DATABASE WITH ONE OF EVERYTHING\n");
{
  const shapeJs = ts.transpileModule(src("appDataShape.ts"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const mods = {};
  const load = (name) => {
    if (mods[name]) return mods[name];
    const js = ts.transpileModule(src(name + ".ts"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const m = { exports: {} };
    mods[name] = m.exports;
    new Function("require", "module", "exports", js)((p) => {
      if (p === "./_generated/server") return { mutation: (d) => d, query: (d) => d, internalMutation: (d) => d, internalQuery: (d) => d };
      if (p === "convex/values") return { v: new Proxy({}, { get: () => (...a) => ({ a }) }) };
      if (p === "./identity") return { requireStaff: async () => ({ email: "karenc@lapromisefund.org" }) };
      return load(p.replace(/^\.\//, ""));
    }, m, m.exports);
    mods[name] = m.exports;
    return m.exports;
  };
  void shapeJs;
  const award = load("cashAward");
  const makeDb = (tables) => ({
    query: (t) => {
      let rows = (tables[t] || []).slice();
      const api = {
        withIndex: (name, fn) => {
          const conds = [];
          const q = { eq: (f, v) => { conds.push((r) => r[f] === v); return q; }, gte: (f, v) => { conds.push((r) => r[f] >= v); return q; } };
          if (fn) fn(q);
          rows = rows.filter((r) => conds.every((c) => c(r)));
          return api;
        },
        order: (d) => { if (d === "desc") rows.sort((a, b) => (String(a.at) < String(b.at) ? 1 : -1)); return api; },
        take: async (n) => rows.slice(0, n), first: async () => rows[0] || null, unique: async () => rows[0] || null,
      };
      return api;
    },
    insert: async (t, doc) => { (tables[t] = tables[t] || []).push(doc); tables.__reads = tables.__reads; return "id"; },
  });
  const now = new Date().toISOString();
  const tables = {
    appState: [{ key: load("cashAwardRules").CASH_AWARD_SWITCH_KEY, value: { enabled: true, pilotEmails: [] } }],
    cashFallbackLog: [
      { at: now, via: "save", actorEmail: "karenc@x", clientVersion: "V2", reason: "applied_by_save", count: 3, ids: ["r1", "r2", "r3"] },
      { at: now, via: "client", actorEmail: "karenc@x", clientVersion: "V2", reason: "timeout", count: 2, ids: ["r1", "r4"], reportId: "rep1" },
      { at: now, via: "client", actorEmail: "karenc@x", clientVersion: "V2", reason: "timeout", count: 2, ids: ["r1", "r4"], reportId: "rep1" },
    ],
    // r2: the command arrived after the save (a race); r4: a timeout whose command landed anyway.
    cashAwardCommands: [{ txnId: "r2", status: "absorbed" }, { txnId: "r4", status: "applied" }],
    // r1 and r2 are award-screen awards; r3 (a refund or a reset) has no 'a_' audit entry.
    appAuditLog: [{ entryId: "a_r1" }, { entryId: "a_r2" }],
  };
  const out = await award.fallbacks.handler({ db: makeDb(tables) }, { sinceIso: "2000-01-01" });
  check("a race the save won is not a miss", out.save.commandArrivedLater === 1);
  check("a refund or reset (no award-screen audit entry) is not a miss", out.save.notAwardScreen === 1);
  check("the true miss is named by the reason the browser gave for THAT receipt",
    JSON.stringify(out.save.missedByReason) === JSON.stringify({ timeout: 1 }), JSON.stringify(out.save));
  check("a timeout whose command landed anyway is counted as such", out.client.landedAnyway === 1);
  check("a report sent twice is counted once", out.client.duplicateReports === 1 && out.client.receipts === 2);
  check("versions are counted per source, by distinct receipt",
    out.byVersion.save.V2 === 3 && out.byVersion.client.V2 === 2, JSON.stringify(out.byVersion));
  check("it says whether the command was even switched on", out.switch && out.switch.enabled === true);
  check("recent rows carry their receipts", Array.isArray(out.recent[0].ids) && out.recent[0].ids.length > 0);

  // THE READ CEILING: a busy week stops short and says so, never throws.
  const many = Array.from({ length: 1500 }, (_, i) => "m" + i);
  const big = { appState: [], cashAwardCommands: [], appAuditLog: [], cashFallbackLog: [
    { at: now, via: "save", reason: "applied_by_save", count: 60, ids: many.slice(0, 1500) } ] };
  let lookups = 0;
  const counting = makeDb(big);
  const q0 = counting.query;
  counting.query = (t) => { if (t === "cashAwardCommands" || t === "appAuditLog") lookups++; return q0(t); };
  const bigOut = await award.fallbacks.handler({ db: counting }, { sinceIso: "2000-01-01" });
  check("a busy week stops under the read ceiling and says how much it left", lookups <= 2800 && bigOut.lookupsCapped === true && bigOut.unchecked > 0,
    `lookups ${lookups}, unchecked ${bigOut.unchecked}`);

  // A REPORT SENT TWICE IS STORED ONCE.
  const t2 = { cashFallbackLog: [] };
  const db2 = makeDb(t2);
  const rep = { reason: "timeout", ids: ["x1"], reportId: "rep9" };
  const a1 = await award.reportFailure.handler({ db: db2 }, { reports: [rep] });
  const a2 = await award.reportFailure.handler({ db: db2 }, { reports: [rep] });
  check("reportFailure stores a report once, however often it arrives",
    a1.stored === 1 && a2.stored === 0 && a2.duplicates === 1 && t2.cashFallbackLog.length === 1);
  check("...and the actor is the sign-in, not anything in the report", t2.cashFallbackLog[0].actorEmail === "karenc@lapromisefund.org");
}

// ------------------------------------------------------------------ browser
console.log("\nTHE BROWSER SAYS WHY ITS COMMAND DID NOT LAND\n");
const build = (o = {}) => {
  const store = new Map();
  const env = { calls: [], reports: [], cashIdsOnServer: new Set(), auditIdsOnServer: new Set(), session: o.noSession ? null : { idToken: "tok" } };
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (o.storageBroken) throw new Error("QuotaExceededError"); store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const window = { WildcatAuth: {
    getSession: () => env.session,
    convexMutation: async (name, args) => {
      env.calls.push(name);
      if (name === "cashAward:reportFailure") { env.reports.push(...args.reports); return { ok: true }; }
      if (o.throws) throw new Error("network down");
      if (o.hang) return new Promise(() => {});
      return typeof o.answer === "function" ? o.answer(args) : o.answer;
    },
  } };
  const body = [
    "const CASH_AWARD_TIMEOUT_MS = 30;",
    "const APP_VERSION = '20260927a';",
    "const pruneCashOutbox = () => {}; const pruneAuditOutbox = () => {};",
    "const CASH_FALLBACK_REPORTS_KEY = 'cashAwardFallbackReports_v1';",
    "const CASH_FALLBACK_REPORTS_MAX = 30;",
    "let _cashFallbackFlushing = false;",
    lift(script, "cashAwardAuditId"),
    (o.mutateReport || ((x) => x))(lift(script, "reportCashAwardFallback")),
    lift(script, "flushCashAwardFallbackReports"),
    (o.mutateSender || ((x) => x))(lift(script, "sendCashAwardCommand")),
    "return { sendCashAwardCommand, flushCashAwardFallbackReports, queue: () => JSON.parse(localStorage.getItem(CASH_FALLBACK_REPORTS_KEY) || '[]') };",
  ].join("\n");
  const f = new Function("window", "localStorage", "navigator", "cashIdsOnServer", "auditIdsOnServer",
    "isPreviewingTeacher", "currentWeek", "getCurrentCycleNumber", "console", body)(
    window, localStorage, { onLine: o.offline ? false : true }, env.cashIdsOnServer, env.auditIdsOnServer,
    () => o.previewing === true, 4, () => 2, { warn() {}, log() {} });
  return Object.assign(f, { env });
};
const AT = new Date().toISOString();
const items = [{ tx: { id: "txn_a", studentId: "12101", timestamp: AT, amount: 100, kind: "award" }, entryId: "a_txn_a" },
  { tx: { id: "txn_b", studentId: "12102", timestamp: AT, amount: 100, kind: "award" }, entryId: "a_txn_b" }];
const settle = () => new Promise((r) => setTimeout(r, 20));
{
  const t = build({ hang: true });
  const res = await t.sendCashAwardCommand(items); await settle();
  check("a timeout is reported, with both receipts and how long it waited",
    res === null && t.env.reports.length === 1 && t.env.reports[0].reason === "timeout"
      && t.env.reports[0].ids.join() === "txn_a,txn_b" && t.env.reports[0].elapsedMs >= 25, JSON.stringify(t.env.reports));
  check("...with the build and whether it thought it was online", t.env.reports[0].clientVersion === "20260927a" && t.env.reports[0].online === true);
  check("...and an id of its own, so a report sent twice is stored once", /^r_/.test(String(t.env.reports[0].reportId)));

  const e = build({ throws: true });
  await e.sendCashAwardCommand(items); await settle();
  check("an error is reported with its message", e.env.reports[0] && e.env.reports[0].reason === "error" && /network down/.test(e.env.reports[0].detail));

  const off = build({ answer: { ok: false, code: "disabled", results: [] } });
  await off.sendCashAwardCommand(items); await settle();
  check("the switch being off is NOT a failure and is not reported", off.env.reports.length === 0);

  const ref = build({ answer: { ok: true, results: [
    { txnId: "txn_a", status: "applied", wroteRecords: true, entryId: "a_txn_a" },
    { txnId: "txn_b", status: "refused", code: "stale", wroteRecords: false } ] } });
  await ref.sendCashAwardCommand(items); await settle();
  check("an award refused one by one is reported by its code, naming only that receipt",
    ref.env.reports.length === 1 && ref.env.reports[0].reason === "refused:stale" && ref.env.reports[0].ids.join() === "txn_b");

  // SIGNED OUT: the commonest reason is exactly when a report cannot be sent.
  const s = build({ noSession: true });
  const sres = await s.sendCashAwardCommand(items); await settle();
  check("signed out: the award is not sent, and neither is anything else", sres === null && s.env.calls.length === 0);
  check("...but the reason is KEPT", s.queue().length === 1 && s.queue()[0].reason === "not_sent_signed_out");
  s.env.session = { idToken: "tok2" };
  s.env.answerOk = true;
  await s.flushCashAwardFallbackReports();
  check("...and sent once a session is back, then cleared", s.env.reports.length === 1 && s.env.reports[0].reason === "not_sent_signed_out" && s.queue().length === 0);

  const ok = build({ answer: { ok: true, results: [
    { txnId: "txn_a", status: "applied", wroteRecords: true, entryId: "a_txn_a" },
    { txnId: "txn_b", status: "applied", wroteRecords: true, entryId: "a_txn_b" } ] } });
  const okRes = await ok.sendCashAwardCommand(items); await settle();
  check("a command that lands reports nothing", ok.env.reports.length === 0 && okRes && okRes.ok === true);

  // NEVER CHANGES MONEY. The same timeout with and without the reporting
  // marks exactly the same things as sent (nothing), and returns the same.
  const bare = build({ hang: true, mutateSender: (x) => x.replace("if (typeof reportCashAwardFallback === 'function') {", "if (false) {") });
  const r1 = await bare.sendCashAwardCommand(items);
  const r2 = await build({ hang: true }).sendCashAwardCommand(items);
  check("reporting changes nothing about the award: same answer, nothing marked as on the server",
    r1 === r2 && bare.env.cashIdsOnServer.size === 0);
  const broken = build({ hang: true, storageBroken: true });
  let threw = false;
  try { await broken.sendCashAwardCommand(items); } catch (x) { threw = true; }
  check("a full or broken localStorage never throws into the award screen", threw === false);

  // TEETH: the timeout branch without its report is caught.
  const quiet = build({ hang: true, mutateSender: (x) => x.replace("if (res === TIMED_OUT) note('timeout',", "if (false) note('timeout',") });
  await quiet.sendCashAwardCommand(items); await settle();
  // Without its own line a timeout falls through to the vague "not_ok:?" --
  // the reason, which is the whole point, is lost.
  check("TEETH: remove the timeout's line and no report says 'timeout'",
    quiet.env.reports.length > 0 && quiet.env.reports.every((r) => r.reason !== "timeout"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
