// AWARDS THAT ARRIVE WITHOUT THEIR MONEY: recorded on arrival, fixed by an
// admin, paid exactly once. Run: npm test
//
// WHY, 2026-09-30. A teacher's award command and save both fail with an
// expired sign-in (HTTP 401), the page reloads, and the money that lived only
// in the tab's memory is lost; the ledger row arrives later through
// legacyData:mergeSlice. 67 awards on 9/29-9/30. The owner chose "A + C":
// the server RECORDS such rows and an admin fixes them the same day. Paying
// automatically was built first and reviewed three times; each round found a
// way it paid one award twice when a person re-entered it.
//
// THE PROPERTIES:
//   1. Arrival moves NO money, ever -- whatever order things happen in.
//   2. A row some payer already paid is not recorded.
//   3. An admin's Fix pays through the same register as the command and the
//      save, so every other route afterwards is absorbed, and a Fix after
//      another route paid is recognised ("already paid"), never paid again.
//   4. Only an admin can see, fix or dismiss.
//   5. Nothing from before a reset is ever fixable.
//
// Every test runs the SHIPPED mergeSlice, cashAward:award, appData's planSave
// and cashArrival -- transpiled, wired by a require shim, against an in-memory
// database. The last block re-breaks the shipped code to prove the teeth.
import { readFileSync } from "node:fs";
import ts from "typescript";

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

const src = (f) => readFileSync(new URL("./convex/" + f, import.meta.url), "utf8");
const SRC = {
  appDataShape: src("appDataShape.ts"),
  cashReversalRules: src("cashReversalRules.ts"),
  cashAwardRules: src("cashAwardRules.ts"),
  cashAward: src("cashAward.ts"),
  cashArrivalRules: src("cashArrivalRules.ts"),
  cashArrival: src("cashArrival.ts"),
  legacyData: src("legacyData.ts"),
  auditLog: src("auditLog.ts"),
  cashRecount: src("cashRecount.ts"),
  cashRecountRules: src("cashRecountRules.ts"),
  // legacyData.ts imports the referral rules (2026-10-07). Without this entry
  // the shim dies with "no module ./referralAccessRules" and every test after
  // this one in the chain never runs.
  referralAccessRules: src("referralAccessRules.ts"),
};

class ConvexError extends Error {}
function load(overrides) {
  const o = overrides || {};
  const cache = {};
  let me = { _id: "t1", legacyId: "T034", name: "Yadira F", email: "yadiraf@lapromisefund.org", role: "teacher" };
  const stubs = {
    "./_generated/server": {
      mutation: (d) => d, query: (d) => d, internalMutation: (d) => d, internalQuery: (d) => d,
    },
    "./_generated/api": { internal: {} },
    "convex/values": { v: new Proxy({}, { get: () => (...a) => ({ _v: true, a }) }), ConvexError },
    "./identity": {
      requireStaff: async () => me,
      requireAdmin: async () => {
        if (me.role !== "admin" && me.role !== "superadmin") throw new ConvexError("Admins only.");
        return me;
      },
    },
    "./referralMail": { notifyNewReferrals: async () => {} },
  };
  const req = (name) => {
    if (stubs[name]) return stubs[name];
    const key = name.replace(/^\.\//, "");
    if (cache[key]) return cache[key];
    let code = SRC[key];
    if (!code) throw new Error("no module " + name);
    if (o[key]) code = o[key](code);
    const js = ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const module = { exports: {} };
    cache[key] = module.exports;
    new Function("require", "module", "exports", js)(req, module, module.exports);
    cache[key] = module.exports;
    return module.exports;
  };
  const mods = {
    shape: req("./appDataShape"),
    rules: req("./cashArrivalRules"),
    arrival: req("./cashArrival"),
    award: req("./cashAward"),
    legacy: req("./legacyData"),
    audit: req("./auditLog"),
    weeks: req("./cashReversalRules"),
    recount: req("./cashRecount"),
  };
  mods.setMe = (m) => { me = m; };
  return mods;
}

function makeDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed || {}));
  let n = 0;
  for (const t of Object.keys(tables)) tables[t].forEach((r) => {
    if (!r._id) r._id = `${t}:${n++}`;
    if (r._creationTime === undefined) r._creationTime = Date.now();
  });
  const q = (name) => {
    let rows = (tables[name] || []).slice();
    let desc = false;
    const api = {
      withIndex(idx, fn) {
        if (fn) {
          const eqs = {}, lows = {};
          const chain = { eq: (c, v) => { eqs[c] = v; return chain; }, gte: (c, v) => { lows[c] = v; return chain; } };
          fn(chain);
          rows = rows.filter((r) => Object.entries(eqs).every(([c, v]) => r[c] === v)
            && Object.entries(lows).every(([c, v]) => r[c] >= v));
        }
        return api;
      },
      order(dir) { desc = dir === "desc"; return api; },
      async first() { return (desc ? rows.slice().reverse() : rows)[0] ?? null; },
      async unique() { if (rows.length > 1) throw new Error("unique: many"); return rows[0] ?? null; },
      async take(k) { return (desc ? rows.slice().reverse() : rows).slice(0, k); },
      async collect() { return rows.slice(); },
    };
    return api;
  };
  const db = {
    query: q,
    async get(id) { for (const t of Object.values(tables)) { const r = t.find((x) => x._id === id); if (r) return r; } return null; },
    async insert(name, doc) { tables[name] = tables[name] || []; const row = { ...doc, _id: `${name}:new${n++}`, _creationTime: Date.now() }; tables[name].push(row); return row._id; },
    async patch(id, fields) {
      for (const t of Object.values(tables)) { const r = t.find((x) => x._id === id); if (r) { for (const [k, v] of Object.entries(fields)) { if (v === undefined) delete r[k]; else r[k] = v; } } }
    },
    async delete(id) { for (const t of Object.keys(tables)) tables[t] = tables[t].filter((x) => x._id !== id); },
  };
  return { tables, db, ctx: { db, scheduler: { runAfter: async () => {} } } };
}

const NOW = Date.now();
const HOUR = 3600_000;
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;
const txnAt = (ms) => `txn_${String(ms)}_a${(seq++).toString(36)}`;
const M = load();
const week = (ms) => "cash_tx_" + M.weeks.cashWeekKey(iso(ms));
const TEACHER = { _id: "t1", legacyId: "T034", name: "Yadira F", email: "yadiraf@lapromisefund.org", role: "teacher" };
const ADMIN = { _id: "a1", legacyId: "A001", name: "Leah R", email: "leahr@lapromisefund.org", role: "admin" };

function row(opts = {}) {
  const ms = opts.ms ?? (NOW - 10 * 60_000);
  const kind = opts.kind ?? "award";
  const amount = opts.amount ?? (kind === "deduct" ? -100 : 100);
  return {
    id: opts.id ?? txnAt(ms), timestamp: iso(ms), studentId: opts.studentId ?? "12101",
    studentName: "Test Student", kind, type: kind, amount,
    behaviorId: opts.behaviorId ?? "wc1", behaviorName: opts.behaviorName ?? "On time",
    notes: opts.notes ?? "On time to class",
    teacherId: opts.teacherId ?? "T034", teacherUsername: "", teacherName: opts.teacherName ?? "Yadira F", balanceAfter: 1000,
  };
}
function student(num, extra = {}) {
  return {
    legacyId: num, studentNumber: num, firstName: "S" + num, lastName: "T",
    wildcatCashBalance: 900, wildcatCashEarned: 900, wildcatCashSpent: 0, wildcatCashDeducted: 0,
    wildcatCashTransactions: [], cashApplied: { ids: [] }, ...extra,
  };
}
function seed(opts = {}) {
  const appState = [
    { key: "historyCutoff", value: { iso: "2026-09-14T15:30:00.000Z" }, mirroredAt: "x" },
    { key: "cashAwardCommand", value: { enabled: true, pilotEmails: [] }, mirroredAt: "x" },
  ];
  if (opts.alerts === false) appState.push({ key: "cashArrivalAlerts", value: { enabled: false }, mirroredAt: "x" });
  if (opts.zeroPoint) appState.push({ key: "cashZeroPoint", value: { iso: opts.zeroPoint }, mirroredAt: "x" });
  return {
    appState,
    students: opts.students || [student("12101"), student("11645", { wildcatCashBalance: 0, wildcatCashEarned: 0 })],
    legacyMirror: opts.mirror || [],
    cashAwardCommands: [], appAuditLog: [], cashFallbackLog: [], cashArrivalAlerts: [],
  };
}
const stu = (d, num) => d.tables.students.find((s) => s.studentNumber === num);
const alerts = (d, status) => (d.tables.cashArrivalAlerts || []).filter((a) => !status || a.status === status);
const merge = async (mods, d, rows, doc) => {
  mods.setMe(TEACHER);
  return mods.legacy.mergeSlice.handler(d.ctx, {
    doc: doc ?? week(Date.parse(rows[0].timestamp)), collection: "transactions",
    rows: rows.map((p) => ({ payload: p })), dedupeField: "id",
  });
};
const asAdmin = async (mods, fn) => { mods.setMe(ADMIN); try { return await fn(); } finally { mods.setMe(TEACHER); } };
const fix = (mods, d, ids) => asAdmin(mods, () => mods.arrival.fixAlerts.handler(d.ctx, { ids }));
const list = (mods, d) => asAdmin(mods, () => mods.arrival.openAlerts.handler(d.ctx, {}));
const WRITABLE = M.shape.STUDENT_WRITABLE;
const keysOf = (r) => [r.legacyId, r.studentNumber];
function applySave(mods, d, record) {
  const plan = mods.shape.planSave(d.tables.students, [record], WRITABLE, keysOf, null);
  for (const { rowId, patch } of plan.patches) {
    const r = d.tables.students.find((x) => x._id === rowId);
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete r[k]; else r[k] = v; }
  }
  return plan;
}
const saveRecordFor = (r) => {
  const effect = M.shape.cashMovementEffect(r.amount, r.kind);
  const cashDelta = {};
  for (const [f, val] of Object.entries(effect)) if (val) cashDelta[f] = val;
  return { id: r.studentId, cashDelta, cashMovements: [{ id: r.id, at: r.timestamp, amount: r.amount, kind: r.kind }] };
};
const awardArg = (r) => ({ studentId: r.studentId, txnId: r.id, at: r.timestamp, amount: r.amount, kind: r.kind,
  behaviorId: r.behaviorId, behaviorName: r.behaviorName, notes: r.notes });
const command = (mods, d, r) => { mods.setMe(TEACHER); return mods.award.award.handler(d.ctx, { awards: [awardArg(r)] }); };

// ===========================================================================
console.log("\nARRIVAL RECORDS; IT NEVER PAYS\n");
{
  const d = makeDb(seed());
  const r = row();
  const res = await merge(M, d, [r]);
  check("the lost award's row is stored", res.inserted === 1);
  check("NO money moves on arrival", stu(d, "12101").wildcatCashBalance === 900 && stu(d, "12101").cashApplied.ids.length === 0);
  check("it is recorded, open, for an admin", alerts(d, "open").length === 1 && alerts(d)[0].txnId === r.id);
  check("...with who, what and when", alerts(d)[0].teacherName === "Yadira F" && alerts(d)[0].amount === 100 && alerts(d)[0].at === r.timestamp);
  check("...delivered-by is the TOKEN", alerts(d)[0].deliveredBy === "yadiraf@lapromisefund.org");
  await merge(M, d, [r]);
  check("sent again: recorded once", alerts(d).length === 1);
  const dOff = makeDb(seed({ alerts: false }));
  await merge(M, dOff, [row()]);
  check("switch off: nothing recorded", alerts(dOff).length === 0);
  const dRef = makeDb(seed());
  await M.legacy.mergeSlice.handler(dRef.ctx, { doc: "referrals", collection: "behaviorReferrals",
    rows: [{ payload: { id: "r1", studentId: "12101", submittedAt: iso(NOW) } }], dedupeField: "id" });
  check("a non-cash slice records nothing", alerts(dRef).length === 0);
  // The referral still lands for a teacher with no referral switch row at all
  // (2026-10-07): an absent switch is today's behaviour.
  check("...and the teacher's referral itself is inserted, with no switch row present",
    (dRef.tables.legacyMirror || []).filter((r) => r.doc === "referrals").length === 1
    && !(dRef.tables.appState || []).some((r) => /^referral/.test(r.key)));
}

console.log("\nA ROW SOME PAYER ALREADY PAID IS NOT RECORDED\n");
{
  const d1 = makeDb(seed());
  const r1 = row();
  applySave(M, d1, saveRecordFor(r1));
  await merge(M, d1, [r1]);
  check("SAVE THEN ROW (today's fallback): not recorded", alerts(d1).length === 0);
  check("...and paid once", stu(d1, "12101").wildcatCashBalance === 1000);
  const d2 = makeDb(seed());
  const r2 = row();
  await command(M, d2, r2);
  await merge(M, d2, [r2]);
  check("COMMAND THEN ROW (healthy): not recorded, paid once", alerts(d2).length === 0 && stu(d2, "12101").wildcatCashBalance === 1000);
}

console.log("\nTHE ADMIN'S FIX PAYS ONCE, WHATEVER HAPPENS AROUND IT\n");
{
  // The incident: row arrives unpaid; admin fixes.
  const d = makeDb(seed());
  const r = row();
  await merge(M, d, [r]);
  const out = await fix(M, d, [alerts(d)[0]._id]);
  const s = stu(d, "12101");
  check("FIX pays the lost award: balance and earned +100", s.wildcatCashBalance === 1000 && s.wildcatCashEarned === 1000, JSON.stringify(out));
  check("...registers it", s.cashApplied.ids.some((e) => e.i === r.id));
  check("...adds the child's own copy once", s.wildcatCashTransactions.filter((x) => x.id === r.id).length === 1);
  check("...closes the alert as fixed, by the admin", alerts(d)[0].status === "fixed" && alerts(d)[0].resolvedBy === "leahr@lapromisefund.org");
  check("...and writes the audit log", d.tables.appAuditLog.some((e) => e.payload.action === "Restored lost cash awards"));
  await fix(M, d, [alerts(d)[0]._id]);
  check("fixing again pays nothing", stu(d, "12101").wildcatCashBalance === 1000);
  applySave(M, d, saveRecordFor(r));
  await command(M, d, r);
  check("the tab's save or command arriving after the Fix: absorbed, still once", stu(d, "12101").wildcatCashBalance === 1000);

  // In flight: the row arrived a moment BEFORE the save that carries its money.
  const d2 = makeDb(seed());
  const r2 = row();
  await merge(M, d2, [r2]);
  check("row before its save: recorded (for now)", alerts(d2, "open").length === 1);
  applySave(M, d2, saveRecordFor(r2));
  const shown = await list(M, d2);
  check("...then the save pays it, and the list says so (paid meanwhile)", shown.alerts[0].paidMeanwhile === true);
  const summary = await asAdmin(M, () => M.arrival.alertSummary.handler(d2.ctx, {}));
  check("...and the dashboard count leaves it out", summary.waiting === 0);
  await fix(M, d2, [alerts(d2)[0]._id]);
  check("a Fix pressed anyway pays NOTHING more: settled as already paid",
    stu(d2, "12101").wildcatCashBalance === 1000 && alerts(d2)[0].status === "settled");

  // Late command after recording, then Fix.
  const d3 = makeDb(seed());
  const r3 = row();
  await merge(M, d3, [r3]);
  await command(M, d3, r3);
  await fix(M, d3, [alerts(d3)[0]._id]);
  check("row, late command, Fix: once", stu(d3, "12101").wildcatCashBalance === 1000 && alerts(d3)[0].status === "settled");
}

console.log("\nWHAT THE ADMIN IS WARNED ABOUT\n");
{
  // The teacher saw no change and re-entered it; the command paid the re-entry.
  const d = makeDb(seed());
  const x = row({ ms: NOW - 30 * 60_000 });
  const x2 = row({ ms: NOW - 20 * 60_000 });
  await command(M, d, x2);
  await merge(M, d, [x]);
  const a = alerts(d)[0];
  check("a LATER similar award is flagged", a.flags.includes("later_similar") && Array.isArray(a.later) && a.later[0].amount === 100, JSON.stringify(a.flags));
  const dC = makeDb(seed());
  await command(M, dC, row({ ms: NOW - 20 * 60_000, teacherId: "A001", teacherName: "Leah R", behaviorId: "wc9", behaviorName: "Helping" }));
  await merge(M, dC, [row({ ms: NOW - 30 * 60_000 })]);
  check("...even by a DIFFERENT staff member for a different behaviour", alerts(dC)[0].flags.includes("later_similar"));
  const dN = makeDb(seed());
  await merge(M, dN, [row()]);
  check("no later award: no warning", !alerts(dN)[0].flags.includes("later_similar"));
  const dD = makeDb(seed());
  await merge(M, dD, [row({ kind: "deduct", amount: -50, notes: "student is sleeping" })]);
  check("a deduction is marked as one", alerts(dD)[0].flags.includes("deduction"));
  await fix(M, dD, [alerts(dD)[0]._id]);
  check("...and its Fix takes the money: balance -50, deducted +50",
    stu(dD, "12101").wildcatCashBalance === 850 && stu(dD, "12101").wildcatCashDeducted === 50);
}

console.log("\nNEVER RECORDED OR NEVER FIXABLE\n");
{
  for (const [name, opts] of [
    ["a store purchase (txn_buy_)", { id: `txn_buy_${NOW}_abcdefg`, kind: "redeem", amount: -1500, behaviorId: "reward:p1" }],
    ["a store REFUND (reward-refund:)", { kind: "award", amount: 200, behaviorId: "reward-refund:r1" }],
    ["a RESET ALL CASH row", { kind: "deduct", amount: -900, behaviorId: "system_reset" }],
    ["an award with no note", { notes: "" }],
  ]) {
    const d = makeDb(seed());
    const r = row(opts);
    await merge(M, d, [r], week(Date.parse(r.timestamp)));
    check(`${name}: not recorded, no money`, alerts(d).length === 0 && stu(d, "12101").wildcatCashBalance === 900);
  }
  // Before a reset.
  const d = makeDb(seed({ zeroPoint: iso(NOW - 2 * HOUR) }));
  await merge(M, d, [row({ ms: NOW - 3 * HOUR })]);
  check("an award from before a reset is not recorded", alerts(d).length === 0);
  // A reset that happens AFTER it was recorded.
  const d2 = makeDb(seed());
  await merge(M, d2, [row({ ms: NOW - 3 * HOUR, studentId: "11645" })]);
  await M.arrival.setZeroPoint.handler(d2.ctx, { iso: iso(NOW - 2 * HOUR) });
  const out = await fix(M, d2, [alerts(d2)[0]._id]);
  check("a reset after recording makes it unfixable: refused, no money",
    stu(d2, "11645").wildcatCashBalance === 0 && out.results[0].outcome === "refused", JSON.stringify(out.results));
  // Coverage lost: the zeroing tool moved the watermark past it.
  const d3 = makeDb(seed({ students: [student("12101", { cashApplied: { ids: [], since: iso(NOW - HOUR) } })] }));
  await merge(M, d3, [row({ ms: NOW - 2 * HOUR })]);
  const out3 = await fix(M, d3, [alerts(d3)[0]._id]);
  check("older than the register can vouch for: refused, left for the nightly check",
    stu(d3, "12101").wildcatCashBalance === 900 && out3.results[0].reason === "coverage_lost");
}

console.log("\nADMINS ONLY\n");
{
  const d = makeDb(seed());
  await merge(M, d, [row()]);
  const id = alerts(d)[0]._id;
  for (const r of ["teacher", "campusaide", "pbis"]) {
    M.setMe({ ...TEACHER, role: r });
    let refused = false;
    try { await M.arrival.fixAlerts.handler(d.ctx, { ids: [id] }); } catch { refused = true; }
    let listRefused = false;
    try { await M.arrival.openAlerts.handler(d.ctx, {}); } catch { listRefused = true; }
    check(`a ${r} cannot fix or list`, refused && listRefused && stu(d, "12101").wildcatCashBalance === 900);
  }
  M.setMe(TEACHER);
  let dismissRefused = false;
  try { await M.arrival.dismissAlerts.handler(d.ctx, { ids: [id], reason: "no" }); } catch { dismissRefused = true; }
  check("a teacher cannot dismiss", dismissRefused && alerts(d)[0].status === "open");
  const out = await asAdmin(M, () => M.arrival.dismissAlerts.handler(d.ctx, { ids: [id], reason: "Teacher re-gave it at 9:40" }));
  check("an admin can dismiss, with a reason, and no money moves",
    out.dismissed === 1 && alerts(d)[0].status === "dismissed" && stu(d, "12101").wildcatCashBalance === 900);
  let noReason = false;
  try { await asAdmin(M, () => M.arrival.dismissAlerts.handler(d.ctx, { ids: [id], reason: " " })); } catch { noReason = true; }
  check("...a reason is required", noReason);
  await fix(M, d, [id]);
  check("a dismissed alert cannot then be fixed", stu(d, "12101").wildcatCashBalance === 900);
}

console.log("\nTHE ZERO POINT STILL MOVES ON AN ADMIN'S RESET\n");
{
  const d = makeDb(seed());
  M.setMe(ADMIN);
  await M.legacy.mergeSlice.handler(d.ctx, { doc: week(NOW - 2 * HOUR), collection: "transactions",
    rows: [{ payload: row({ ms: NOW - 2 * HOUR, kind: "deduct", amount: -900, behaviorId: "system_reset", notes: "Reset all" }) }], dedupeField: "id" });
  check("an admin's reset row raises the zero point", !!d.tables.appState.find((r) => r.key === "cashZeroPoint"));
  const dT = makeDb(seed());
  await merge(M, dT, [row({ ms: NOW - 2 * HOUR, kind: "deduct", amount: -900, behaviorId: "system_reset", notes: "Reset all" })]);
  check("a teacher's does not", !dT.tables.appState.find((r) => r.key === "cashZeroPoint"));
  M.setMe(TEACHER);
}

console.log("\nTHE ADMIN'S SCREEN\n");
{
  const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  check("the review panel sits on the Cash Audit Log tab", /<div id="cashArrivalPanel"><\/div>/.test(html)
    && html.indexOf('id="cashArrivalPanel"') > html.indexOf('id="cashAuditTab"'));
  check("the dashboard tile is for admins only, and only when some are waiting",
    /\(isAdmin && _cashArrivalSummary && _cashArrivalSummary\.waiting > 0\)/.test(script));
  const load = script.slice(script.indexOf("async function loadCashArrivalAlerts("), script.indexOf("function toggleCashArrivalPick("));
  // THE TICK RULES, RUN (second review: a default tick counted as an OK).
  new Function(readFileSync(new URL("./wildcat-cashaudit.js", import.meta.url), "utf8"))();
  const CA = globalThis.WildcatCashAudit;
  const plain = { id: "A", found: true, kind: "award", flags: [], candidates: [], candidateSig: "" };
  let st = CA.arrivalReload({}, [plain]);
  check("a plain award is ticked by default", st.picks.A === true);
  let req = CA.arrivalFixRequest(st, [plain]);
  check("...and sent with NO acknowledgement", req.ids.join() === "A" && req.acknowledged.length === 0);
  const warned = { ...plain, candidates: [{ id: "L1" }], candidateSig: "L1" };
  st = CA.arrivalReload(st, [warned]);
  check("a default tick is DROPPED when a 'given again' candidate appears", !st.picks.A && !st.acks.A);
  st = CA.arrivalToggle(st, warned);
  req = CA.arrivalFixRequest(st, [warned]);
  check("ticking it by hand acknowledges exactly what it shows", req.acknowledged[0] && req.acknowledged[0].sig === "L1");
  const more = { ...plain, candidates: [{ id: "L1" }, { id: "L2" }], candidateSig: "L1,L2" };
  st = CA.arrivalReload(st, [more]);
  check("a NEW candidate after the tick drops the tick and the acknowledgement", !st.picks.A && !st.acks.A);
  st = CA.arrivalReload(st, [more]);
  check("the same candidates on the next reload keep things as they are", !st.picks.A);
  st = CA.arrivalToggle(st, more);
  st = CA.arrivalReload(st, [more]);
  check("a hand tick survives a reload that changes nothing", st.picks.A === true && st.acks.A === "L1,L2");
  const s2 = CA.arrivalReload({}, [{ ...plain, id: "B", blocked: "coverage_lost" }, { ...plain, id: "C", kind: "deduct" }, { ...plain, id: "D", flags: ["delivered_by_other"] }]);
  check("blocked, deductions and rows sent from another account are never ticked by default", !s2.picks.B && !s2.picks.C && !s2.picks.D);
  const s3 = CA.arrivalToggle(s2, { ...plain, id: "B", blocked: "coverage_lost" });
  check("a row left for the recount (the app cannot check it) cannot even be ticked",
    !s3.picks.B && CA.arrivalFixRequest(s3, [{ ...plain, id: "B", blocked: "coverage_lost" }]).ids.length === 0);
  const s4 = CA.arrivalToggle(CA.arrivalReload({}, [{ ...plain, id: "E", blocked: "before_zero_point" }]), { ...plain, id: "E", blocked: "before_zero_point" });
  check("...while one that can never be paid can be ticked, to Dismiss, but never sent to Give back",
    s4.picks.E === true && CA.arrivalDismissRequest(s4, [{ ...plain, id: "E", blocked: "before_zero_point" }]).join() === "E"
      && CA.arrivalFixRequest(s4, [{ ...plain, id: "E", blocked: "before_zero_point" }]).ids.length === 0);
  check("...and one from around a reset row is left for the recount too (untickable)",
    !CA.arrivalToggle(CA.arrivalReload({}, []), { ...plain, id: "F", blocked: "before_reset" }).picks.F);
  check("the screen disables the tick box on a row left for the recount", /arrivalLeftForRecount\(a\) \? 'disabled '/.test(script));
  check("the screen uses these rules", /WildcatCashAudit\.arrivalReload\(/.test(load) && /WildcatCashAudit\.arrivalFixRequest\(/.test(script));
  check("rows paid another way are closed quietly", /convexMutation\('cashArrival:settlePaid'/.test(load));
  const render = script.slice(script.indexOf("function renderCashArrivalPanel()"), script.indexOf("async function fixCashArrivals()"));
  check("names, notes and teachers are escaped", /escapeHtml\(a\.studentName/.test(render) && /escapeHtml\(\(a\.behaviorName/.test(render) && /escapeHtml\(a\.teacherName/.test(render));
  check("something paid meanwhile is not shown at all", /filter\(a => !a\.paidMeanwhile\)/.test(render));
  check("a 'given again' warning is shown in words", /Possibly given again/.test(render));
  const fixFn = script.slice(script.indexOf("async function fixCashArrivals()"), script.indexOf("async function dismissCashArrivals()"));
  check("Give back calls the admin-only fix and reports what the server did",
    /convexMutation\('cashArrival:fixAlerts'/.test(fixFn) && /already_paid/.test(fixFn));
  const dis = script.slice(script.indexOf("async function dismissCashArrivals()"), script.indexOf("let _cashDrift = null;"));
  check("Dismiss asks why (the server insists too)", /window\.prompt\(/.test(dis) && /convexMutation\('cashArrival:dismissAlerts'/.test(dis));
}

console.log("\nREVIEW FINDINGS, 2026-09-30\n");
{
  // 1. Given again AFTER the row was recorded (the real order).
  const d = makeDb(seed());
  const x = row({ ms: NOW - 3 * HOUR });
  await merge(M, d, [x]);
  check("recorded with no warning at first", !alerts(d)[0].flags.includes("later_similar"));
  await command(M, d, row({ ms: NOW - 20 * 60_000 }));
  const shown = await list(M, d);
  check("the list works the warning out LIVE: 'given again' now shows", shown.alerts[0].candidates.length === 1, JSON.stringify(shown.alerts[0].candidates));
  const r1 = await fix(M, d, [alerts(d)[0]._id]);
  check("Give back WITHOUT the admin having seen it: refused, not paid",
    stu(d, "12101").wildcatCashBalance === 1000 && r1.results[0].reason === "given_again", JSON.stringify(r1.results));
  const stale = await asAdmin(M, () => M.arrival.fixAlerts.handler(d.ctx, { ids: [alerts(d)[0]._id], acknowledged: [{ id: alerts(d)[0]._id, sig: "something-else" }] }));
  check("...an acknowledgement of a DIFFERENT set of candidates is refused", stu(d, "12101").wildcatCashBalance === 1000 && stale.results[0].reason === "given_again");
  const r2 = await asAdmin(M, () => M.arrival.fixAlerts.handler(d.ctx, { ids: [alerts(d)[0]._id], acknowledged: [{ id: alerts(d)[0]._id, sig: shown.alerts[0].candidateSig }] }));
  check("...with exactly what was shown acknowledged: the admin's decision is carried out", stu(d, "12101").wildcatCashBalance === 1100 && r2.paid === 1);

  // 1b. BOTH the original and the re-entry were lost (second review).
  const dB = makeDb(seed());
  const orig = row({ ms: NOW - 30 * 60_000 });
  await merge(M, dB, [orig]);
  const reentry = row({ ms: NOW - 20 * 60_000 });
  await merge(M, dB, [reentry]);
  const lb = await list(M, dB);
  const aOrig = lb.alerts.find((x) => x.txnId === orig.id), aRe = lb.alerts.find((x) => x.txnId === reentry.id);
  check("both lost: the ORIGINAL shows the lost re-entry as a candidate", aOrig.candidates.some((c) => c.id === reentry.id));
  check("...the re-entry itself has none", aRe.candidates.length === 0);
  const rb = await fix(M, dB, [aOrig.id, aRe.id]);
  check("...Give back on both without looking pays ONE, not two", stu(dB, "12101").wildcatCashBalance === 1000 && rb.paid === 1, JSON.stringify(rb.results));

  // 1c. A re-entry more than three days later still counts.
  const dL = makeDb(seed());
  await merge(M, dL, [row({ ms: NOW - 5 * 24 * HOUR })]);
  await command(M, dL, row({ ms: NOW - 10 * 60_000 }));
  const ll = await list(M, dL);
  check("a re-entry FIVE days later is still a candidate", ll.alerts[0].candidates.length === 1);

  // 2. The recount repaired it before anyone pressed Give back.
  // The child's $900 is backed by an earlier award in both witnesses.
  const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" });
  const d2 = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base] })] }));
  const y = row({ ms: NOW - 2 * HOUR });
  await merge(M, d2, [y]);
  stu(d2, "12101").wildcatCashTransactions.push(y);   // the save's history copy
  const rc = await M.recount.recountStudents.handler(d2.ctx, { students: [{ studentId: "12101", rows: [base, y] }], apply: true });
  check("the recount repairs the balance", stu(d2, "12101").wildcatCashBalance === 1000,
    JSON.stringify(rc.details && rc.details[0]));
  check("...and settles the waiting alert", alerts(d2)[0].status === "settled" && alerts(d2)[0].resolvedBy === "recount");
  check("...and registers the id, so nothing pays it again", stu(d2, "12101").cashApplied.ids.some((e) => e.i === y.id));
  const before = stu(d2, "12101").wildcatCashBalance;
  await fix(M, d2, [alerts(d2)[0]._id]);
  applySave(M, d2, saveRecordFor(y));
  check("a Give back or a late save afterwards pays NOTHING", stu(d2, "12101").wildcatCashBalance === before);
  const d2b = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base] })] }));
  const y2 = row({ ms: NOW - 2 * HOUR });
  await merge(M, d2b, [y2]);
  stu(d2b, "12101").wildcatCashTransactions.push(y2);
  await M.recount.recountStudents.handler(d2b.ctx, { students: [{ studentId: "12101", rows: [base, y2] }], apply: false });
  check("a recount DRY RUN settles nothing", alerts(d2b)[0].status === "open");

  // 3. The same id twice in one call.
  const d3 = makeDb(seed());
  await merge(M, d3, [row()]);
  const id = alerts(d3)[0]._id;
  const r3 = await fix(M, d3, [id, id]);
  check("the same alert sent twice: paid once, stays 'fixed'", stu(d3, "12101").wildcatCashBalance === 1000 && alerts(d3)[0].status === "fixed" && r3.paid === 1);

  // 4. Paid meanwhile: closed by settlePaid, and never counted.
  const d4 = makeDb(seed());
  const z = row();
  await merge(M, d4, [z]);
  applySave(M, d4, saveRecordFor(z));
  const s4 = await asAdmin(M, () => M.arrival.settlePaid.handler(d4.ctx, { ids: [alerts(d4)[0]._id] }));
  check("paid by another route: settlePaid closes it, pays nothing", s4.settled === 1 && alerts(d4)[0].status === "settled" && stu(d4, "12101").wildcatCashBalance === 1000);
  const d4b = makeDb(seed());
  await merge(M, d4b, [row()]);
  const s4b = await asAdmin(M, () => M.arrival.settlePaid.handler(d4b.ctx, { ids: [alerts(d4b)[0]._id] }));
  check("...and will not close one that is still unpaid", s4b.settled === 0 && alerts(d4b)[0].status === "open");

  // 5. Blocked rows say why and are not counted.
  const d5 = makeDb(seed({ students: [student("12101", { cashApplied: { ids: [], since: iso(NOW - HOUR) } })] }));
  await merge(M, d5, [row({ ms: NOW - 2 * HOUR })]);
  const l5 = await list(M, d5);
  check("a row the register cannot vouch for is shown as blocked, with the reason", l5.alerts[0].blocked === "coverage_lost");
  const sum5 = await asAdmin(M, () => M.arrival.alertSummary.handler(d5.ctx, {}));
  check("...and is not counted on the dashboard", sum5.waiting === 0);

  // 6. Sent from another account.
  const d6 = makeDb(seed());
  await merge(M, d6, [row({ teacherId: "T999", teacherName: "Someone Else" })]);
  check("a row naming another teacher than the account that sent it is flagged", alerts(d6)[0].flags.includes("delivered_by_other"));

  // 8. Dismiss is final, including for the morning repair (second review).
  const base8 = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" });
  const d8 = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base8] })] }));
  const w8 = row({ ms: NOW - 2 * HOUR });
  await merge(M, d8, [w8]);
  stu(d8, "12101").wildcatCashTransactions.push(w8);
  await asAdmin(M, () => M.arrival.dismissAlerts.handler(d8.ctx, { ids: [alerts(d8)[0]._id], reason: "Teacher re-gave it" }));
  const rc8 = await M.recount.recountStudents.handler(d8.ctx, { students: [{ studentId: "12101", rows: [base8, w8] }], apply: true });
  check("a DISMISSED award is not paid by the recount", stu(d8, "12101").wildcatCashBalance === 900 && rc8.repaired === 0, JSON.stringify(rc8.details && rc8.details[0]));
  const d9 = makeDb(seed());
  const w9 = row();
  await merge(M, d9, [w9]);
  applySave(M, d9, saveRecordFor(w9));
  await asAdmin(M, () => M.arrival.dismissAlerts.handler(d9.ctx, { ids: [alerts(d9)[0]._id], reason: "not needed" }));
  check("dismissing one that was PAID meanwhile marks it settled, not dismissed", alerts(d9)[0].status === "settled");

  // 7. No log noise from staff-desk sales.
  const d7 = makeDb(seed());
  await merge(M, d7, [row({ kind: "redeem", amount: -200, behaviorId: "reward:r1" })]);
  check("a staff-desk sale writes no diagnostic row", (d7.tables.cashFallbackLog || []).length === 0);
}

// ===========================================================================
console.log("\nFINAL REVIEW, 2026-10-01\n");
{
  // A. DISMISS IS BINDING: a stuck tab's later save or award pays nothing.
  const d = makeDb(seed());
  const r = row();
  await merge(M, d, [r]);
  const out = await asAdmin(M, () => M.arrival.dismissAlerts.handler(d.ctx, { ids: [alerts(d)[0]._id], reason: "Teacher re-gave it by hand" }));
  check("Dismiss closes it and moves no money", out.dismissed === 1 && alerts(d)[0].status === "dismissed" && stu(d, "12101").wildcatCashBalance === 900);
  check("...and registers the receipt, so the child's register knows it", stu(d, "12101").cashApplied.ids.some((e) => e.i === r.id));
  applySave(M, d, saveRecordFor(r));
  check("a stuck tab's LATER SAVE of the dismissed award pays nothing", stu(d, "12101").wildcatCashBalance === 900, String(stu(d, "12101").wildcatCashBalance));
  await command(M, d, r);
  check("...and neither does a late award command for it", stu(d, "12101").wildcatCashBalance === 900);

  // B. A ROW THE APP CANNOT CHECK STAYS WITH THE RECOUNT (re-review): Dismiss leaves it open.
  const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" });
  const w = row({ ms: NOW - 2 * HOUR });
  // The $100 really did arrive (balance 1000), but the register's watermark
  // has moved past it, so the app cannot vouch either way.
  const dB = makeDb(seed({ students: [student("12101", { wildcatCashBalance: 1000, wildcatCashEarned: 1000,
    wildcatCashTransactions: [base, w], cashApplied: { ids: [], since: iso(NOW - HOUR) } })] }));
  await merge(M, dB, [w]);
  check("setup: the row is shown as one the app cannot check", (await list(M, dB)).alerts[0].blocked === "coverage_lost");
  const oB = await asAdmin(M, () => M.arrival.dismissAlerts.handler(dB.ctx, { ids: [alerts(dB)[0]._id], reason: "Cannot tell, leave it" }));
  check("Dismiss does NOT touch a row the app cannot check: left open for the recount, nothing registered",
    oB.dismissed === 0 && oB.closed === 0 && oB.left === 1 && alerts(dB)[0].status === "open"
      && !stu(dB, "12101").cashApplied.ids.some((e) => e.i === w.id), JSON.stringify(oB));
  const rcB = await M.recount.recountStudents.handler(dB.ctx, { students: [{ studentId: "12101", rows: [base, w] }], apply: true, includeDecreases: true });
  check("...the recount counts it against the ledger: it WAS paid, so nothing changes, even with decreases allowed",
    stu(dB, "12101").wildcatCashBalance === 1000 && rcB.details[0].action === "already correct", JSON.stringify(rcB.details && rcB.details[0]));
  check("...and settles it", alerts(dB)[0].status === "settled" && alerts(dB)[0].resolvedBy === "recount");

  // B2. A row the app cannot check, re-given by the teacher: never paid twice.
  const baseE = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" });
  const dE = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [baseE], cashApplied: { ids: [], since: iso(NOW - HOUR) } })] }));
  const lostE = row({ ms: NOW - 2 * HOUR });
  await merge(M, dE, [lostE]);
  const againE = row({ ms: NOW - 20 * 60_000 });
  await command(M, dE, againE);
  const hE = stu(dE, "12101").wildcatCashTransactions;
  for (const x of [lostE, againE]) if (!hE.some((h) => h.id === x.id)) hE.push(x);
  check("setup: a lost award the app cannot check, re-given by the teacher (balance 1000)",
    stu(dE, "12101").wildcatCashBalance === 1000 && (await list(M, dE)).alerts[0].blocked === "coverage_lost");
  const oE = await asAdmin(M, () => M.arrival.dismissAlerts.handler(dE.ctx, { ids: [alerts(dE)[0]._id], reason: "Already given again by the teacher" }));
  check("...Dismiss leaves it open", oE.left === 1 && alerts(dE)[0].status === "open");
  const rcE = await M.recount.recountStudents.handler(dE.ctx, { students: [{ studentId: "12101", rows: [baseE, lostE, againE] }], apply: true, includeDecreases: true });
  const detE = rcE.details && rcE.details[0];
  check("the recount does NOT pay it: the student is held for a person ('possibly given again'), 1000 not 1100",
    stu(dE, "12101").wildcatCashBalance === 1000 && detE.action === "held back" && /possibly given again/.test(detE.why || ""), JSON.stringify(detE));

  // B3. A row the app cannot check, paid by the recount BEFORE anyone acts: the panel asks nothing more of the admin.
  const baseF = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" });
  const dF = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [baseF], cashApplied: { ids: [], since: iso(NOW - HOUR) } })] }));
  const lostF = row({ ms: NOW - 2 * HOUR });
  await merge(M, dF, [lostF]);
  stu(dF, "12101").wildcatCashTransactions.push(lostF);
  await M.recount.recountStudents.handler(dF.ctx, { students: [{ studentId: "12101", rows: [baseF, lostF] }], apply: true });
  check("a row the app cannot check and nobody re-gave is paid ONCE by the recount, and settled",
    stu(dF, "12101").wildcatCashBalance === 1000 && alerts(dF)[0].status === "settled");

  // B4. A deduction the app cannot check is never handed back or taken twice by a Dismiss.
  const dedG = row({ ms: NOW - 2 * HOUR, kind: "deduct", amount: -100, notes: "Phone out in class" });
  const dG = makeDb(seed({ students: [student("12101", { wildcatCashBalance: 800, wildcatCashDeducted: 100,
    wildcatCashTransactions: [baseF, dedG], cashApplied: { ids: [], since: iso(NOW - HOUR) } })] }));
  await merge(M, dG, [dedG]);
  const oG = await asAdmin(M, () => M.arrival.dismissAlerts.handler(dG.ctx, { ids: [alerts(dG)[0]._id], reason: "Cannot tell" }));
  const rcG = await M.recount.recountStudents.handler(dG.ctx, { students: [{ studentId: "12101", rows: [baseF, dedG] }], apply: true, includeDecreases: true });
  check("a deduction the app cannot check: Dismiss leaves it, and the recount neither hands it back nor takes it twice",
    oG.left === 1 && stu(dG, "12101").wildcatCashBalance === 800 && rcG.details[0].action === "already correct", JSON.stringify(rcG.details && rcG.details[0]));

  // B4b. ...and one the teacher re-entered on their own: never taken twice.
  const dK = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [baseF], cashApplied: { ids: [], since: iso(NOW - HOUR) } })] }));
  const lostK = row({ ms: NOW - 2 * HOUR, kind: "deduct", amount: -100, notes: "Phone out in class" });
  await merge(M, dK, [lostK]);
  const againK = row({ ms: NOW - 20 * 60_000, kind: "deduct", amount: -100, notes: "Phone out in class" });
  await command(M, dK, againK);
  const hK = stu(dK, "12101").wildcatCashTransactions;
  for (const x of [lostK, againK]) if (!hK.some((h) => h.id === x.id)) hK.push(x);
  check("setup: a lost deduction the app cannot check, re-entered by the teacher (balance 800)", stu(dK, "12101").wildcatCashBalance === 800);
  const rcK = await M.recount.recountStudents.handler(dK.ctx, { students: [{ studentId: "12101", rows: [baseF, lostK, againK] }], apply: true, includeDecreases: true });
  check("the recount does NOT take it a second time, even with decreases allowed: held for a person",
    stu(dK, "12101").wildcatCashBalance === 800 && rcK.details[0].action === "held back" && /possibly given again/.test(rcK.details[0].why || ""),
    JSON.stringify(rcK.details && rcK.details[0]));

  // B5. The tile and the panel.
  const dT = makeDb(seed({ students: [student("12101", { cashApplied: { ids: [], since: iso(NOW - HOUR) } })] }));
  await merge(M, dT, [row({ ms: NOW - 2 * HOUR })]);
  alerts(dT)[0].arrivedAt = iso(NOW - HOUR);                    // not a moment ago
  const sumT = await asAdmin(M, () => M.arrival.alertSummary.handler(dT.ctx, {}));
  check("the dashboard tile does not count a row left for the recount (there is nothing for an admin to do)", sumT.waiting === 0, JSON.stringify(sumT));
  const dH = makeDb(seed());
  await merge(M, dH, [row({ ms: NOW - 3 * HOUR, studentId: "11645" })]);
  await M.arrival.setZeroPoint.handler(dH.ctx, { iso: iso(NOW - 2 * HOUR) });
  const oH = await asAdmin(M, () => M.arrival.dismissAlerts.handler(dH.ctx, { ids: [alerts(dH)[0]._id], reason: "From before the reset" }));
  check("a row that can never be paid (from before a reset) is simply closed by Dismiss",
    oH.closed === 1 && alerts(dH)[0].status === "closed_unverified" && stu(dH, "11645").wildcatCashBalance === 0, JSON.stringify(oH));
  const scriptB = readFileSync(new URL("./script.js", import.meta.url), "utf8");
  check("the panel says such a row is left for the cash recount, with nothing to do, and never asks for a re-entry",
    /so it is left for the cash recount\. Nothing to do here/.test(scriptB) && !/award it again the usual way/.test(scriptB));
  // C. THE RECOUNT HOLDS BACK A LOST AWARD THAT MAY HAVE BEEN GIVEN AGAIN.
  const baseC = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" });
  const dC = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [baseC] })] }));
  const lost = row({ ms: NOW - 2 * HOUR });
  await merge(M, dC, [lost]);
  const again = row({ ms: NOW - 20 * 60_000 });
  await command(M, dC, again);                                   // the teacher gave it again
  const hist = stu(dC, "12101").wildcatCashTransactions;
  for (const x of [lost, again]) if (!hist.some((h) => h.id === x.id)) hist.push(x);
  check("setup: the re-given award is paid (1000) and the lost one is waiting", stu(dC, "12101").wildcatCashBalance === 1000 && alerts(dC, "open").length === 1);
  const rcC = await M.recount.recountStudents.handler(dC.ctx, { students: [{ studentId: "12101", rows: [baseC, lost, again] }], apply: true });
  const detC = rcC.details && rcC.details.find((x) => x.studentId === "12101");
  check("the recount does NOT pay a lost award that may have been given again: the child is held back",
    stu(dC, "12101").wildcatCashBalance === 1000 && detC && detC.action === "held back" && /possibly given again/.test(detC.why || ""),
    JSON.stringify(detC));
  check("...and the decision stays with the admin: the alert is still open", alerts(dC)[0].status === "open");
  const rcD = await M.recount.recountStudents.handler(dC.ctx, { students: [{ studentId: "12101", rows: [baseC, lost, again] }], apply: false });
  check("...the dry run says the same", (rcD.details || []).some((x) => x.action === "held back"));

  // D. DISMISS ACTS ONLY ON ROWS TICKED BY HAND.
  new Function(readFileSync(new URL("./wildcat-cashaudit.js", import.meta.url), "utf8"))();
  const CA = globalThis.WildcatCashAudit;
  const plain = { id: "A", found: true, kind: "award", flags: [], candidates: [], candidateSig: "" };
  const warned = { ...plain, id: "W", candidates: [{ id: "L1" }], candidateSig: "L1" };
  let st = CA.arrivalReload({}, [plain, warned]);
  check("setup: the plain award arrives pre-ticked for Give back", st.picks.A === true && !st.picks.W);
  check("...and Dismiss, with nothing ticked by hand, would dismiss NOTHING", CA.arrivalDismissRequest(st, [plain, warned]).length === 0);
  st = CA.arrivalToggle(st, warned);
  check("ticking the one warned row by hand: Dismiss takes ONLY that row, not the pre-ticked one",
    CA.arrivalDismissRequest(st, [plain, warned]).join() === "W", CA.arrivalDismissRequest(st, [plain, warned]).join());
  st = CA.arrivalToggle(CA.arrivalToggle(st, plain), plain);  // untick, then tick by hand
  check("a pre-ticked row unticked and ticked again by hand is included", CA.arrivalDismissRequest(st, [plain, warned]).sort().join() === "A,W");
  st = CA.arrivalReload(st, [plain, warned]);
  check("...a reload that changes nothing keeps the hand ticks", CA.arrivalDismissRequest(st, [plain, warned]).sort().join() === "A,W");
  const moreW = { ...warned, candidates: [{ id: "L1" }, { id: "L2" }], candidateSig: "L1,L2" };
  st = CA.arrivalReload(st, [plain, moreW]);
  check("...a new 'given again' candidate drops the hand tick (look again)", CA.arrivalDismissRequest(st, [plain, moreW]).join() === "A");
  check("...and a row paid meanwhile is never dismissed",
    CA.arrivalDismissRequest(st, [{ ...plain, paidMeanwhile: true }, moreW]).length === 0);
  const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
  const dis = script.slice(script.indexOf("async function dismissCashArrivals()"), script.indexOf("let _cashDrift = null;"));
  check("the Dismiss button uses these rules", /WildcatCashAudit\.arrivalDismissRequest\(/.test(dis) && /dismissIds/.test(dis));
  const loose = readFileSync(new URL("./wildcat-cashaudit.js", import.meta.url), "utf8")
    .replace("if (a && state.hand && state.hand[a.id] && state.picks[a.id]", "if (a && state.picks[a.id]");
  new Function(loose)();
  const st2 = globalThis.WildcatCashAudit.arrivalToggle(globalThis.WildcatCashAudit.arrivalReload({}, [plain, warned]), warned);
  check("TEETH: without the hand rule, Dismiss on one warned row takes the pre-ticked award with it",
    globalThis.WildcatCashAudit.arrivalDismissRequest(st2, [plain, warned]).sort().join() === "A,W");
  new Function(readFileSync(new URL("./wildcat-cashaudit.js", import.meta.url), "utf8"))();
}

// ===========================================================================
console.log("\nTHIRD RE-REVIEW, 2026-10-01: A HELD ROW HAS A WAY OUT\n");
const resolve = (mods, d, ids, decision, reason = "Checked the history by hand") =>
  mods.arrival.resolveForRecount.handler(d.ctx, { ids, decision, reason, by: "alank@lapromisefund.org",
    ...(decision === "leave_out" ? { notPaid: true } : {}) });
{
  // U1. A row the app cannot check, an UNRELATED later award, and $40 of other drift.
  const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" });
  const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base], cashApplied: { ids: [], since: iso(NOW - HOUR) } })] }));
  const lost = row({ ms: NOW - 2 * HOUR });
  await merge(M, d, [lost]);
  const other = row({ ms: NOW - 15 * 60_000, amount: 150, behaviorName: "Helping", notes: "Helped a classmate" });
  const paidOther = await command(M, d, other);
  check("setup: the unrelated $150 is paid by the award command (balance 1050)", stu(d, "12101").wildcatCashBalance === 1050, JSON.stringify(paidOther));
  const drift = row({ ms: NOW - 10 * 60_000, amount: 40, notes: "Never landed" });
  const h = stu(d, "12101").wildcatCashTransactions;
  for (const x of [lost, other, drift]) if (!h.some((y) => y.id === x.id)) h.push(x);
  const rows = [base, lost, other, drift];
  const r1 = await M.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows }], apply: true });
  const held = r1.details[0];
  check("setup: the recount holds the student and NAMES the alert and the tool to decide it",
    held.action === "held back" && held.alerts && held.alerts[0].txnId === lost.id && /resolveForRecount/.test(held.why),
    JSON.stringify(held));
  const out = await resolve(M, d, [held.alerts[0].id], "count", "The $150 was a different award, not a re-entry");
  check("a person decides 'count': recorded, no money moved yet", out.results[0].outcome === "the recount may count it"
    && stu(d, "12101").wildcatCashBalance === 1050 && alerts(d)[0].status === "open",
    JSON.stringify({ out, bal: stu(d, "12101").wildcatCashBalance, st: alerts(d).map((x) => x.status) }));
  const r2 = await M.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows }], apply: true });
  check("...and the next recount pays what is owed ONCE (1050 -> 1190) and settles it",
    stu(d, "12101").wildcatCashBalance === 1190 && r2.details[0].action === "repaired" && alerts(d)[0].status === "settled",
    JSON.stringify(r2.details[0]));
  const r3 = await M.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows }], apply: true });
  check("...a third recount finds nothing to do", stu(d, "12101").wildcatCashBalance === 1190 && r3.details[0].action === "already correct");
  const audit = (d.tables.appAuditLog || []).find((e) => e.payload && e.payload.action === "Decided lost cash awards");
  check("...and the decision is in the audit log, with who and why", audit && /different award/.test(audit.payload.details) && audit.payload.userId === "alank@lapromisefund.org");
}
{
  // "leave_out": it WAS given again.
  const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" });
  const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base], cashApplied: { ids: [], since: iso(NOW - HOUR) } })] }));
  const lost = row({ ms: NOW - 2 * HOUR });
  await merge(M, d, [lost]);
  const again = row({ ms: NOW - 20 * 60_000 });
  await command(M, d, again);
  const h = stu(d, "12101").wildcatCashTransactions;
  for (const x of [lost, again]) if (!h.some((y) => y.id === x.id)) h.push(x);
  const rows = [base, lost, again];
  const r1 = await M.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows }], apply: true });
  const out = await resolve(M, d, [r1.details[0].alerts[0].id], "leave_out", "Re-given by the teacher at 2pm");
  check("a person decides 'leave_out': dismissed and registered, no money moved",
    out.results[0].outcome === "left out" && alerts(d)[0].status === "dismissed" && stu(d, "12101").wildcatCashBalance === 1000
      && stu(d, "12101").cashApplied.ids.some((e) => e.i === lost.id));
  const r2 = await M.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows }], apply: true });
  check("...and the recount now finds the student correct at 1000, never 1100",
    stu(d, "12101").wildcatCashBalance === 1000 && r2.details[0].action === "already correct", JSON.stringify(r2.details[0]));
  applySave(M, d, saveRecordFor(lost));
  check("...and a stuck tab's later save of it pays nothing", stu(d, "12101").wildcatCashBalance === 1000);
  const again2 = await resolve(M, d, [alerts(d)[0]._id], "count");
  check("a decision on a row that is no longer open changes nothing", again2.results[0].outcome === "not open" && alerts(d)[0].status === "dismissed");
  let noWhy = false;
  try { await M.arrival.resolveForRecount.handler(d.ctx, { ids: [alerts(d)[0]._id], decision: "count", reason: " ", by: "x" }); } catch { noWhy = true; }
  check("...and a reason is required", noWhy);
}
{
  // "leave_out" on one that WAS paid meanwhile: settled, never left out.
  const d = makeDb(seed());
  const r = row();
  await merge(M, d, [r]);
  applySave(M, d, saveRecordFor(r));
  const out = await resolve(M, d, [alerts(d)[0]._id], "leave_out");
  check("'leave_out' on one already paid settles it instead, so the recount keeps counting real money",
    out.results[0].outcome === "already paid: settled, not left out" && alerts(d)[0].status === "settled");
}
{
  // U2. A DISMISSED award is not a re-entry of an earlier one.
  const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" });
  const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base] })] }));
  const a = row({ ms: NOW - 3 * HOUR, amount: 50 });
  const b = row({ ms: NOW - 2 * HOUR, amount: 100 });
  await merge(M, d, [a]);
  await merge(M, d, [b]);
  const bAlert = alerts(d).find((x) => x.txnId === b.id);
  await asAdmin(M, () => M.arrival.dismissAlerts.handler(d.ctx, { ids: [bAlert._id], reason: "Given by mistake, do not pay" }));
  // A stuck tab's later save unions both rows into the history (its money absorbed).
  const h = stu(d, "12101").wildcatCashTransactions;
  for (const x of [a, b]) if (!h.some((y) => y.id === x.id)) h.push(x);
  const shown = await list(M, d);
  check("the panel no longer shows a dismissed award as 'possibly given again'",
    shown.alerts.length === 1 && shown.alerts[0].txnId === a.id && shown.alerts[0].candidates.length === 0, JSON.stringify(shown.alerts[0].candidates));
  const rc = await M.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows: [base, a, b] }], apply: true });
  check("...and the recount does not hold the student for it: the $50 is paid, the dismissed $100 is not (950)",
    stu(d, "12101").wildcatCashBalance === 950 && rc.details[0].action === "repaired", JSON.stringify(rc.details[0]));
}
{
  // A lost award from BEFORE a reset row cannot change the count, so it holds nothing.
  const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" });
  const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base] })] }));
  const lost = row({ ms: NOW - 3 * HOUR });
  await merge(M, d, [lost]);
  const reset = { ...row({ ms: NOW - 2 * HOUR, kind: "deduct", amount: -900, behaviorId: "system_reset", notes: "Reset all cash" }), behaviorName: "Reset" };
  const st = stu(d, "12101");
  Object.assign(st, { wildcatCashBalance: 0, wildcatCashEarned: 0, wildcatCashSpent: 0, wildcatCashDeducted: 0 });
  st.wildcatCashTransactions.push(lost, reset);
  const after = row({ ms: NOW - HOUR });
  await command(M, d, after);
  const drift = row({ ms: NOW - 30 * 60_000, amount: 40, notes: "Never landed" });
  for (const x of [after, drift]) if (!st.wildcatCashTransactions.some((y) => y.id === x.id)) st.wildcatCashTransactions.push(x);
  const rc = await M.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows: [base, lost, reset, after, drift] }], apply: true });
  check("a lost award from before a reset does not hold the student: the $40 after the reset is repaired (100 -> 140)",
    stu(d, "12101").wildcatCashBalance === 140 && rc.details[0].action === "repaired", JSON.stringify(rc.details[0]));
}

{
  // V1 (fourth re-review). "count" is not a blank cheque: a re-entry made AFTER the decision is new doubt.
  const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" });
  const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base], cashApplied: { ids: [], since: iso(NOW - HOUR) } })] }));
  const lost = row({ ms: NOW - 2 * HOUR });
  await merge(M, d, [lost]);
  const other = row({ ms: NOW - 15 * 60_000, amount: 150, behaviorName: "Helping", notes: "Helped a classmate" });
  await command(M, d, other);
  const h = stu(d, "12101").wildcatCashTransactions;
  for (const x of [lost, other]) if (!h.some((y) => y.id === x.id)) h.push(x);
  await resolve(M, d, [alerts(d)[0]._id], "count", "The $150 was a different award");
  const again = row({ ms: NOW - 2 * 60_000 });                    // ...and then the teacher re-gives the $100
  alerts(d)[0].recountDecision.at = iso(NOW - 5 * 60_000);         // the decision was made before it
  await command(M, d, again);
  if (!h.some((y) => y.id === again.id)) h.push(again);
  const rc = await M.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows: [base, lost, other, again] }], apply: true });
  check("a re-entry made AFTER a 'count' decision holds the student again: 1150, never 1250",
    stu(d, "12101").wildcatCashBalance === 1150 && rc.details[0].action === "held back", JSON.stringify(rc.details[0]));
}
{
  // V2. "leave_out" must be told the award was never paid.
  const d = makeDb(seed({ students: [student("12101", { cashApplied: { ids: [], since: iso(NOW - HOUR) } })] }));
  await merge(M, d, [row({ ms: NOW - 2 * HOUR })]);
  let refused = false;
  try { await M.arrival.resolveForRecount.handler(d.ctx, { ids: [alerts(d)[0]._id], decision: "leave_out", reason: "Given again", by: "x@y" }); }
  catch (e) { refused = /notPaid: true/.test(e.message); }
  check("'leave_out' without notPaid is refused, with the reason (leaving out a paid award takes the money back)",
    refused && alerts(d)[0].status === "open");
}
{
  // W1. A lost award dated just AFTER a reset row: the panel calls it "around a reset"; the recount must not pay it.
  const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" });
  const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base] })] }));
  const resetAt = NOW - 3 * HOUR;
  const lost = row({ ms: resetAt + 10 * 60_000 });
  await merge(M, d, [lost]);
  const reset = { ...row({ ms: resetAt, kind: "deduct", amount: -900, behaviorId: "system_reset", notes: "Reset all cash" }), behaviorName: "Reset" };
  const st = stu(d, "12101");
  Object.assign(st, { wildcatCashBalance: 0, wildcatCashEarned: 0, wildcatCashSpent: 0, wildcatCashDeducted: 0 });
  st.wildcatCashTransactions.push(reset, lost);
  const shown = await list(M, d);
  check("setup: the panel shows it as from around a cash reset", shown.alerts[0].blocked === "before_reset");
  const o = await asAdmin(M, () => M.arrival.dismissAlerts.handler(d.ctx, { ids: [alerts(d)[0]._id], reason: "From the reset" }));
  check("...Dismiss leaves it open for the recount (never 'closed, can never be paid' while the recount counts it)",
    o.left === 1 && alerts(d)[0].status === "open", JSON.stringify(o));
  const rc = await M.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows: [base, reset, lost] }], apply: true });
  check("...and the recount does NOT pay it on its own: held for a person (0, not 100)",
    stu(d, "12101").wildcatCashBalance === 0 && rc.details[0].action === "held back" && /just after a cash reset/.test(rc.details[0].why || ""),
    JSON.stringify(rc.details[0]));
}
{
  // V3. Only a row the derivation reads as a reset exempts anything.
  const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" });
  const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base] })] }));
  const lost = row({ ms: NOW - 3 * HOUR });
  await merge(M, d, [lost]);
  const again = row({ ms: NOW - 10 * 60_000 });
  await command(M, d, again);
  const note = { ...row({ ms: NOW - 5 * 60_000, kind: "deduct", amount: -5, behaviorId: "system_reset_note", notes: "Odd row" }) };
  const h = stu(d, "12101").wildcatCashTransactions;
  for (const x of [lost, again, note]) if (!h.some((y) => y.id === x.id)) h.push(x);
  const rc = await M.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows: [base, lost, again, note] }], apply: true });
  check("a row that merely STARTS with 'system_reset' is not a reset: the re-given award still holds the student",
    stu(d, "12101").wildcatCashBalance === 1000 && rc.details[0].action === "held back", JSON.stringify(rc.details[0]));
}

// ===========================================================================
console.log("\nTEETH: RE-BREAK THE SHIPPED CODE, THE TESTS MUST CATCH IT\n");
async function tooth(name, overrides, scenario) {
  const B = load(overrides);
  let caught = false;
  try { caught = !(await scenario(B)); } catch { caught = true; }
  check(`catches: ${name}`, caught);
}
await tooth("the Fix not registering (a later save pays twice)",
  { cashArrivalRules: (s) => s.replace("patch.cashApplied = ringPush(", "patch.__nothing = (") },
  async (B) => { const d = makeDb(seed()); const r = row(); await merge(B, d, [r]); await fix(B, d, [alerts(d)[0]._id]); applySave(B, d, saveRecordFor(r)); return stu(d, "12101").wildcatCashBalance === 1000; });
await tooth("the Fix not checking the register (paid meanwhile, paid again)",
  { cashArrivalRules: (s) => s.replace("if (known.has(id) || commandIds.has(id) || inCall.has(id))", "if (inCall.has(id))") },
  async (B) => { const d = makeDb(seed()); const r = row(); await merge(B, d, [r]); applySave(B, d, saveRecordFor(r)); await fix(B, d, [alerts(d)[0]._id]); return stu(d, "12101").wildcatCashBalance === 1000; });
await tooth("arrival recording a row a payer already paid",
  { cashArrival: (s) => s.replace("if (known.has(it.award.txnId)) { paidAlready++; continue; }", "") },
  async (B) => { const d = makeDb(seed()); const r = row(); applySave(B, d, saveRecordFor(r)); await merge(B, d, [r]); return alerts(d).length === 0; });
await tooth("the Fix ignoring a reset",
  { cashArrivalRules: (s) => s.replace("if (atMs <= o.zeroPointMs + ZERO_POINT_SLACK_MS)", "if (false)") },
  async (B) => { const d = makeDb(seed()); await merge(B, d, [row({ ms: NOW - 3 * HOUR, studentId: "11645" })]); await B.arrival.setZeroPoint.handler(d.ctx, { iso: iso(NOW - 2 * HOUR) }); await fix(B, d, [alerts(d)[0]._id]); return stu(d, "11645").wildcatCashBalance === 0; });
await tooth("fix open to non-admins",
  { cashArrival: (s) => s.replace("const admin = await requireAdmin(ctx);\n    const unique = [...new Set(ids)];", "const admin = { email: 'x', name: 'x' };\n    const unique = [...new Set(ids)];") },
  async (B) => { const d = makeDb(seed()); await merge(B, d, [row()]); B.setMe({ ...TEACHER }); try { await B.arrival.fixAlerts.handler(d.ctx, { ids: [alerts(d)[0]._id] }); } catch {} return stu(d, "12101").wildcatCashBalance === 900; });
await tooth("Give back ignoring a 'given again' the admin never saw",
  { cashArrival: (s) => s.replace("if (live.candidates.length && !live.paid && ack.get(String(id)) !== live.sig) {", "if (false) {") },
  async (B) => { const d = makeDb(seed()); await merge(B, d, [row({ ms: NOW - 3 * HOUR })]); await command(B, d, row({ ms: NOW - 20 * 60_000 })); await fix(B, d, [alerts(d)[0]._id]); return stu(d, "12101").wildcatCashBalance === 1000; });
await tooth("the recount not settling what it counted",
  { cashRecount: (s) => s.replace(".filter((a: any) => rowIds.has(a.txnId));", ".filter((a: any) => false);") },
  async (B) => { const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" }); const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base] })] })); const y = row({ ms: NOW - 2 * HOUR }); await merge(B, d, [y]); stu(d, "12101").wildcatCashTransactions.push(y); await B.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows: [base, y] }], apply: true }); const b = stu(d, "12101").wildcatCashBalance; await fix(B, d, [alerts(d)[0]._id]); return stu(d, "12101").wildcatCashBalance === b; });
await tooth("the other open alerts left out of 'given again' (both lost, both paid)",
  { cashArrival: (s) => s.replace("...(weekRows.get(\"open:\" + alert.studentId) ?? []),", "") },
  async (B) => { const d = makeDb(seed()); await merge(B, d, [row({ ms: NOW - 30 * 60_000 })]); await merge(B, d, [row({ ms: NOW - 20 * 60_000 })]); await fix(B, d, alerts(d).map((a) => a._id)); return stu(d, "12101").wildcatCashBalance === 1000; });
await tooth("the recount paying a dismissed award",
  { cashRecount: (s) => s.replace("const keep = (r: any) => !dismissed.has(String(r?.id ?? \"\"));", "const keep = (r: any) => true;") },
  async (B) => { const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" }); const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base] })] })); const w = row({ ms: NOW - 2 * HOUR }); await merge(B, d, [w]); stu(d, "12101").wildcatCashTransactions.push(w); await asAdmin(B, () => B.arrival.dismissAlerts.handler(d.ctx, { ids: [alerts(d)[0]._id], reason: "Teacher re-gave it" })); await B.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows: [base, w] }], apply: true }); return stu(d, "12101").wildcatCashBalance === 900; });
await tooth("the later-similar warning removed",
  { cashArrival: (s) => s.replace('if (later.length) flags.push("later_similar");', "") },
  async (B) => { const d = makeDb(seed()); await command(B, d, row({ ms: NOW - 20 * 60_000 })); await merge(B, d, [row({ ms: NOW - 30 * 60_000 })]); return alerts(d)[0].flags.includes("later_similar"); });

await tooth("Dismiss not registering (a stuck tab's later save pays the dismissed award)",
  { cashArrival: (s) => s.replace("cashApplied: ringPush(st.cashApplied ?? null, [{ id: alert.txnId", "__nothing: ([{ id: alert.txnId") },
  async (B) => { const d = makeDb(seed()); const r = row(); await merge(B, d, [r]); await asAdmin(B, () => B.arrival.dismissAlerts.handler(d.ctx, { ids: [alerts(d)[0]._id], reason: "Teacher re-gave it" })); applySave(B, d, saveRecordFor(r)); return stu(d, "12101").wildcatCashBalance === 900; });
await tooth("Dismiss deciding a row the app cannot check (re-given, then paid a second time)",
  { cashArrival: (s) => s.replace("if (live.blocked && LEFT_FOR_THE_RECOUNT.has(live.blocked)) { left++; continue; }", "") },
  async (B) => { const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" }); const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base], cashApplied: { ids: [], since: iso(NOW - HOUR) } })] })); const lost = row({ ms: NOW - 2 * HOUR }); await merge(B, d, [lost]); const again = row({ ms: NOW - 20 * 60_000 }); await command(B, d, again); const h = stu(d, "12101").wildcatCashTransactions; for (const x of [lost, again]) if (!h.some((y) => y.id === x.id)) h.push(x); await asAdmin(B, () => B.arrival.dismissAlerts.handler(d.ctx, { ids: [alerts(d)[0]._id], reason: "Already given again" })); await B.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows: [base, lost, again] }], apply: true }); return stu(d, "12101").wildcatCashBalance === 1000; });
await tooth("Dismiss leaving out a row the app cannot check (the recount takes real money off)",
  { cashArrival: (s) => s.replace("if (live.blocked && LEFT_FOR_THE_RECOUNT.has(live.blocked)) { left++; continue; }", "").replace("if (live.blocked || !live.student) {", "if (false) {") },
  async (B) => { const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" }); const w = row({ ms: NOW - 2 * HOUR }); const d = makeDb(seed({ students: [student("12101", { wildcatCashBalance: 1000, wildcatCashEarned: 1000, wildcatCashTransactions: [base, w], cashApplied: { ids: [], since: iso(NOW - HOUR) } })] })); await merge(B, d, [w]); await asAdmin(B, () => B.arrival.dismissAlerts.handler(d.ctx, { ids: [alerts(d)[0]._id], reason: "Cannot tell" })); await B.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows: [base, w] }], apply: true, includeDecreases: true }); return stu(d, "12101").wildcatCashBalance === 1000; });
await tooth("the recount paying a lost award that may have been given again",
  { cashRecount: (s) => s.replace("if (doubtful.length) {", "if (false) {") },
  async (B) => { const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" }); const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base] })] })); const lost = row({ ms: NOW - 2 * HOUR }); await merge(B, d, [lost]); const again = row({ ms: NOW - 20 * 60_000 }); await command(B, d, again); const h = stu(d, "12101").wildcatCashTransactions; for (const x of [lost, again]) if (!h.some((y) => y.id === x.id)) h.push(x); await B.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows: [base, lost, again] }], apply: true }); return stu(d, "12101").wildcatCashBalance === 1000; });

await tooth("the 'count' decision ignored (a held row stays stuck for good)",
  { cashRecount: (s) => s.replace('const decided = a.recountDecision && a.recountDecision.decision === "count"', "const decided = false") },
  async (B) => { const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" }); const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base], cashApplied: { ids: [], since: iso(NOW - HOUR) } })] })); const lost = row({ ms: NOW - 2 * HOUR }); await merge(B, d, [lost]); const other = row({ ms: NOW - 15 * 60_000, amount: 150, notes: "Helped a classmate" }); await command(B, d, other); const h = stu(d, "12101").wildcatCashTransactions; for (const x of [lost, other]) if (!h.some((y) => y.id === x.id)) h.push(x); await B.arrival.resolveForRecount.handler(d.ctx, { ids: [alerts(d)[0]._id], decision: "count", reason: "Not a re-entry", by: "x@y" }); await B.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows: [base, lost, other] }], apply: true }); return stu(d, "12101").wildcatCashBalance === 1150; });
await tooth("a dismissed award counted as a re-entry (the student held for nothing)",
  { cashRecount: (s) => s.replace("laterCandidates([...cache, ...ledgerRows], a.row ?? {})", "laterCandidates([...cacheAll, ...entry.rows], a.row ?? {})") },
  async (B) => { const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" }); const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base] })] })); const a = row({ ms: NOW - 3 * HOUR, amount: 50 }); const b = row({ ms: NOW - 2 * HOUR, amount: 100 }); await merge(B, d, [a]); await merge(B, d, [b]); await asAdmin(B, () => B.arrival.dismissAlerts.handler(d.ctx, { ids: [alerts(d).find((x) => x.txnId === b.id)._id], reason: "Given by mistake" })); const h = stu(d, "12101").wildcatCashTransactions; for (const x of [a, b]) if (!h.some((y) => y.id === x.id)) h.push(x); await B.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows: [base, a, b] }], apply: true }); return stu(d, "12101").wildcatCashBalance === 950; });
await tooth("the panel showing a dismissed award as 'given again'",
  { cashArrival: (s) => s.replace('].filter((r: any) => !dismissedIds.has(String(r?.id ?? ""))), alert.row);', "], alert.row);") },
  async (B) => { const d = makeDb(seed()); const a = row({ ms: NOW - 3 * HOUR, amount: 50 }); const b = row({ ms: NOW - 2 * HOUR, amount: 100 }); await merge(B, d, [a]); await merge(B, d, [b]); await asAdmin(B, () => B.arrival.dismissAlerts.handler(d.ctx, { ids: [alerts(d).find((x) => x.txnId === b.id)._id], reason: "Given by mistake" })); const h = stu(d, "12101").wildcatCashTransactions; for (const x of [a, b]) if (!h.some((y) => y.id === x.id)) h.push(x); const shown = await list(B, d); return shown.alerts[0].candidates.length === 0; });
await tooth("'leave_out' on a row already paid (real money left out of the recount)",
  { cashArrival: (s) => s.replace("if (st && paidNow(st, cmd, alert.txnId)) {", "if (false) {") },
  async (B) => { const d = makeDb(seed()); const r = row(); await merge(B, d, [r]); applySave(B, d, saveRecordFor(r)); await B.arrival.resolveForRecount.handler(d.ctx, { ids: [alerts(d)[0]._id], decision: "leave_out", reason: "Given again", by: "x@y", notPaid: true }); return alerts(d)[0].status === "settled"; });

await tooth("'count' honoured whatever came after it (a later re-entry paid twice)",
  { cashRecount: (s) => s.replace("if (Number.isFinite(decided)) return candidatesOf(a).some((c: any) => !(Date.parse(c.at) <= decided));", "if (Number.isFinite(decided)) return false;") },
  async (B) => { const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" }); const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base], cashApplied: { ids: [], since: iso(NOW - HOUR) } })] })); const lost = row({ ms: NOW - 2 * HOUR }); await merge(B, d, [lost]); const other = row({ ms: NOW - 15 * 60_000, amount: 150, notes: "Helped a classmate" }); await command(B, d, other); const h = stu(d, "12101").wildcatCashTransactions; for (const x of [lost, other]) if (!h.some((y) => y.id === x.id)) h.push(x); await B.arrival.resolveForRecount.handler(d.ctx, { ids: [alerts(d)[0]._id], decision: "count", reason: "Different award", by: "x@y" }); alerts(d)[0].recountDecision.at = iso(NOW - 5 * 60_000); const again = row({ ms: NOW - 2 * 60_000 }); await command(B, d, again); if (!h.some((y) => y.id === again.id)) h.push(again); await B.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows: [base, lost, other, again] }], apply: true }); return stu(d, "12101").wildcatCashBalance === 1150; });
await tooth("'leave_out' without the never-paid confirmation",
  { cashArrival: (s) => s.replace('if (decision === "leave_out" && notPaid !== true) {', "if (false) {") },
  async (B) => { const d = makeDb(seed({ students: [student("12101", { cashApplied: { ids: [], since: iso(NOW - HOUR) } })] })); await merge(B, d, [row({ ms: NOW - 2 * HOUR })]); try { await B.arrival.resolveForRecount.handler(d.ctx, { ids: [alerts(d)[0]._id], decision: "leave_out", reason: "Given again", by: "x@y" }); } catch {} return alerts(d)[0].status === "open"; });
await tooth("a row just after a reset paid by the recount",
  { cashRecount: (s) => s.replace("if (Number.isFinite(resetMs) && !(at > resetMs + ZERO_POINT_SLACK_MS)) return true;", "") },
  async (B) => { const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" }); const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base] })] })); const resetAt = NOW - 3 * HOUR; const lost = row({ ms: resetAt + 10 * 60_000 }); await merge(B, d, [lost]); const reset = { ...row({ ms: resetAt, kind: "deduct", amount: -900, behaviorId: "system_reset", notes: "Reset all cash" }) }; const st = stu(d, "12101"); Object.assign(st, { wildcatCashBalance: 0, wildcatCashEarned: 0, wildcatCashSpent: 0, wildcatCashDeducted: 0 }); st.wildcatCashTransactions.push(reset, lost); await B.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows: [base, reset, lost] }], apply: true }); return stu(d, "12101").wildcatCashBalance === 0; });
await tooth("a prefix match for reset rows (a 'system_reset_note' exempts a re-given award)",
  { cashRecount: (s) => s.replace('if (String(r && r.behaviorId ? r.behaviorId : "") !== "system_reset") continue;', 'if (!/^system_reset/.test(String(r && r.behaviorId ? r.behaviorId : ""))) continue;') },
  async (B) => { const base = row({ ms: NOW - 20 * HOUR, amount: 900, notes: "Earlier awards" }); const d = makeDb(seed({ students: [student("12101", { wildcatCashTransactions: [base] })] })); const lost = row({ ms: NOW - 3 * HOUR }); await merge(B, d, [lost]); const again = row({ ms: NOW - 10 * 60_000 }); await command(B, d, again); const note = row({ ms: NOW - 5 * 60_000, kind: "deduct", amount: -5, behaviorId: "system_reset_note", notes: "Odd row" }); const h = stu(d, "12101").wildcatCashTransactions; for (const x of [lost, again, note]) if (!h.some((y) => y.id === x.id)) h.push(x); await B.recount.recountStudents.handler(d.ctx, { students: [{ studentId: "12101", rows: [base, lost, again, note] }], apply: true }); return stu(d, "12101").wildcatCashBalance === 1000; });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
