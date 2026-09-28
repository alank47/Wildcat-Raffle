// The first real sale: two Power-Up Passes, one per campus, one per student.
//
// WHAT THE OWNER ASKED FOR, 2026-09-27, in their words:
//   "Middle school should only be able to buy Middle school as we dont want to
//    sort through the data as to who bought."
//   "There should only be two items available for purchase on tuesday"
//   one per student: "3. Yes."
// and a sale that opens before 7am and runs one day, which nobody should have
// to be awake to open or remember to close.
//
// NOTHING IS COPIED. convex/studentStore.ts, studentStoreRules.ts and
// cashReversalRules.ts are the shipped source, transpiled and wired together
// through a require shim (the cash-award-command.test.mjs pattern), and run
// against an in-memory database. The load-bearing assertions are proved to
// have teeth at the bottom by re-breaking the shipped code.
//
// Run: npm test
import { readFileSync } from "node:fs";
import ts from "typescript";

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

const src = (f) => readFileSync(new URL("./convex/" + f, import.meta.url), "utf8");
const SHIPPED = {
  studentStore: src("studentStore.ts"),
  studentStoreRules: src("studentStoreRules.ts"),
  cashReversalRules: src("cashReversalRules.ts"),
};

// ---------------------------------------------------------------- the loader
function load(overrides) {
  const o = overrides || {};
  const cache = {};
  const who = { student: null, adminOk: true };
  // internal.studentStore.runStoreSchedule, as the dotted path it names, so a
  // queued job can be checked for WHICH function it will run.
  const deep = (path) => new Proxy({}, { get: (_t, k) => {
    if (typeof k === "symbol") return undefined;
    if (k === "toString") return () => path;
    return deep(path ? path + "." + k : k);
  } });
  const stubs = {
    "./_generated/server": {
      mutation: (d) => d, query: (d) => d, internalMutation: (d) => d, internalQuery: (d) => d,
    },
    "./_generated/api": { internal: deep("") },
    "convex/values": { v: new Proxy({}, { get: () => (...a) => ({ _v: true, a }) }) },
    "./identity": {
      requireStudentSelf: async (ctx) => {
        if (!who.student) throw new Error("Students only.");
        return ctx.db.__byId(who.student);
      },
      requireStaff: async () => ({ name: "Desk Staff", role: "teacher" }),
      requireAdmin: async () => {
        if (!who.adminOk) throw new Error("Admins only.");
        return { name: "Alan Kent", role: "admin" };
      },
    },
  };
  const req = (name) => {
    if (stubs[name]) return stubs[name];
    const key = name.replace(/^\.\//, "");
    if (cache[key]) return cache[key];
    let code = SHIPPED[key];
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
  return { store: req("./studentStore"), rules: req("./studentStoreRules"), who };
}

// ------------------------------------------------------- the fake database
function makeDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed || {}));
  let n = 0;
  for (const t of Object.keys(tables)) tables[t].forEach((r) => { if (!r._id) r._id = `${t}:${n++}`; });
  const scans = {};               // table -> collect() calls with NO index
  const jobs = [];
  const q = (name) => {
    let rows = (tables[name] || []).slice();
    let indexed = false;
    const api = {
      withIndex(_idx, fn) {
        indexed = true;
        if (fn) {
          const eqs = {};
          const chain = { eq: (c, v) => { eqs[c] = v; return chain; } };
          fn(chain);
          rows = rows.filter((r) => Object.entries(eqs).every(([c, v]) => r[c] === v));
        }
        return api;
      },
      order() { return api; },
      async first() { return rows[0] ?? null; },
      async unique() {
        if (rows.length > 1) throw new Error("unique() found " + rows.length);
        return rows[0] ?? null;
      },
      async take(k) { return rows.slice(0, k); },
      async collect() { if (!indexed) scans[name] = (scans[name] || 0) + 1; return rows.slice(); },
    };
    return api;
  };
  const byId = (id) => { for (const t of Object.values(tables)) { const r = t.find((x) => x._id === id); if (r) return r; } return null; };
  return {
    tables, scans, jobs,
    ctx: {
      db: {
        query: q,
        __byId: byId,
        async get(id) { return byId(id); },
        async insert(name, doc) {
          tables[name] = tables[name] || [];
          const row = { ...JSON.parse(JSON.stringify(doc)), _id: `${name}:new${n++}` };
          tables[name].push(row);
          return row._id;
        },
        async patch(id, fields) { const r = byId(id); if (r) Object.assign(r, JSON.parse(JSON.stringify(fields))); },
      },
      scheduler: {
        async runAt(ms, fn, args) { jobs.push({ ms, fn: String(fn), args }); },
        async runAfter(ms, fn, args) { jobs.push({ ms: Date.now() + ms, fn: String(fn), args }); },
      },
    },
  };
}

const HOUR = 3600_000;
const FUTURE = (h) => new Date(Date.now() + h * HOUR).toISOString();
const PAST = (h) => new Date(Date.now() - h * HOUR).toISOString();

const MS_PASS = { id: "pup_ms", name: "Power-Up Pass (Middle School)", cost: 1500, category: "PBIS Event",
  stock: 75, available: true, retiredAt: null, studentPurchasable: true, campus: "middle",
  limitPerStudent: 1, updatedAt: PAST(20), stockSetAt: PAST(20) };
const HS_PASS = { ...MS_PASS, id: "pup_hs", name: "Power-Up Pass (High School)", campus: "high" };
const FRONT = { id: "reward4", name: "Front of Line Pass", cost: 100, stock: null, available: true,
  retiredAt: null, studentPurchasable: false };
const HOMEWORK = { id: "reward1", name: "Homework Pass", cost: 1000, stock: null, available: true,
  retiredAt: null, studentPurchasable: true };

const kid = (id, grade, balance, extra) => Object.assign({
  _id: "st_" + id, legacyId: id, studentNumber: id, email: id + "@westbrookacademy.org",
  firstName: "Kid", lastName: id, grade: String(grade),
  wildcatCashBalance: balance, wildcatCashEarned: balance, wildcatCashSpent: 0, wildcatCashDeducted: 0,
  wildcatCashTransactions: [],
}, extra || {});

const receiptRow = (p) => ({ doc: "secondary", collection: "cashReceipts", payload: p, mirroredAt: "x" });
const rewardRow = (p) => ({ doc: "secondary", collection: "wildcatCashRewards", payload: p, mirroredAt: "x" });

function seed(extra) {
  return Object.assign({
    appState: [{ key: "studentStoreOpen", value: { open: true }, mirroredAt: "x" }],
    students: [kid("7001", 7, 2000), kid("7002", 8, 1600), kid("9001", 10, 5000), kid("7003", 6, 100)],
    psRoster: [{ studentNumber: "7001" }, { studentNumber: "7002" }, { studentNumber: "9001" }, { studentNumber: "7003" }],
    legacyMirror: [rewardRow(MS_PASS), rewardRow(HS_PASS), rewardRow(FRONT), rewardRow(HOMEWORK)],
    studentPurchases: [],
    appAuditLog: [],
  }, extra || {});
}

const M = load();
const S = M.store;
let attempt = 0;
const buyAs = async (d, studentNumber, rewardId, extra) =>
  S.purchaseFor.handler(d.ctx, Object.assign({ studentNumber, rewardId, attemptId: "att-" + (++attempt) }, extra || {}));
const student = (d, id) => d.tables.students.find((s) => s.legacyId === id);
const reward = (d, id) => d.tables.legacyMirror.find((r) => r.collection === "wildcatCashRewards" && r.payload.id === id).payload;
const receiptsOf = (d) => d.tables.legacyMirror.filter((r) => r.collection === "cashReceipts").map((r) => r.payload);
const ledgerOf = (d) => d.tables.legacyMirror.filter((r) => r.doc.startsWith("cash_tx_"));

console.log("\nA MIDDLE SCHOOLER BUYS THE MIDDLE SCHOOL PASS\n");
{
  const d = makeDb(seed());
  const r = await buyAs(d, "7001", "pup_ms", { seenPrice: 1500 });
  check("it goes through", r.ok === true && r.alreadyBought === false, JSON.stringify(r));
  check("the charge is the catalogue's $1,500", r.totalCost === 1500 && student(d, "7001").wildcatCashBalance === 500);
  check("spent goes up by the same, earned is untouched",
    student(d, "7001").wildcatCashSpent === 1500 && student(d, "7001").wildcatCashEarned === 2000);
  check("one pass leaves the shelf", reward(d, "pup_ms").stock === 74);
  check("the other campus's shelf is untouched", reward(d, "pup_hs").stock === 75);
  const rc = receiptsOf(d);
  check("one receipt, for this child, for this pass",
    rc.length === 1 && rc[0].studentId === "7001" && rc[0].rewardId === "pup_ms" && rc[0].status === "issued");
  check("the receipt code is WC- and six unambiguous characters",
    /^WC-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(r.receiptId) && rc[0].id === r.receiptId, r.receiptId);
  // The old code was "WC-" + the last six of the attempt token, which the
  // browser chooses: a child could pick their own code, or somebody else's.
  const chosen = await S.purchaseFor.handler(makeDb(seed()).ctx,
    { studentNumber: "7001", rewardId: "pup_ms", attemptId: "ZZZZZZWC2345" });
  check("and it is not built from the browser's attempt token", chosen.receiptId !== "WC-WC2345", chosen.receiptId);
  check("the receipt says Middle School", rc[0].school === "Middle School");
  check("one ledger row, a redeem, for -$1,500",
    ledgerOf(d).length === 1 && ledgerOf(d)[0].payload.kind === "redeem" && ledgerOf(d)[0].payload.amount === -1500);
  check("the register holds the press", d.tables.studentPurchases.length === 1);
  check("NO read of the whole students table on the way", !d.scans.students, JSON.stringify(d.scans));
}

console.log("\nONE PER STUDENT\n");
{
  const d = makeDb(seed());
  await buyAs(d, "7001", "pup_ms");
  const again = await buyAs(d, "7001", "pup_ms");
  check("a second pass for the same child is refused", again.ok === false && again.code === "limit_reached", JSON.stringify(again));
  check("in words a child can read", /already have this one/i.test(again.reason) && /one per student/i.test(again.reason));
  check("and nothing moved: balance, stock, receipts",
    student(d, "7001").wildcatCashBalance === 500 && reward(d, "pup_ms").stock === 74 && receiptsOf(d).length === 1);

  const two = await buyAs(makeDb(seed()), "7001", "pup_ms", { quantity: 2 });
  check("two at once is refused too", two.ok === false && two.code === "limit_reached" && /1 more/.test(two.reason), JSON.stringify(two));

  // A pass an adult bought for them at the office is still a pass they hold.
  const office = makeDb(seed());
  office.tables.legacyMirror.push(receiptRow({ id: "WC-OFFICE", studentId: "7001", rewardId: "pup_ms",
    quantity: 1, status: "issued", channel: "staff", purchasedAt: PAST(1) }));
  const afterOffice = await buyAs(office, "7001", "pup_ms");
  check("a pass bought for them at the office counts", afterOffice.code === "limit_reached");

  // A cancelled receipt was refunded: the child gets their chance back.
  const refunded = makeDb(seed());
  refunded.tables.legacyMirror.push(receiptRow({ id: "WC-REFUND", studentId: "7001", rewardId: "pup_ms",
    quantity: 1, status: "cancelled", channel: "student", purchasedAt: PAST(1) }));
  check("a cancelled one does not count", (await buyAs(refunded, "7001", "pup_ms")).ok === true);

  // Somebody else's receipt is somebody else's.
  const other = makeDb(seed());
  other.tables.legacyMirror.push(receiptRow({ id: "WC-OTHER", studentId: "7002", rewardId: "pup_ms",
    quantity: 1, status: "issued", purchasedAt: PAST(1) }));
  check("another child's pass does not count against this one", (await buyAs(other, "7001", "pup_ms")).ok === true);

  // No limit set: the Homework Pass may be bought more than once.
  const hw = makeDb(seed());
  await buyAs(hw, "9001", "reward1");
  check("a reward with no limit can be bought again", (await buyAs(hw, "9001", "reward1")).ok === true);
}

console.log("\nTHE CAMPUS\n");
{
  const d = makeDb(seed());
  const r = await buyAs(d, "7001", "pup_hs");
  check("a middle schooler cannot buy the high school pass", r.ok === false && r.code === "wrong_campus", JSON.stringify(r));
  check("and is told whose it is", /High School/.test(r.reason));
  check("nothing moved", student(d, "7001").wildcatCashBalance === 2000 && reward(d, "pup_hs").stock === 75
    && receiptsOf(d).length === 0);
  const hs = await buyAs(d, "9001", "pup_ms");
  check("and a high schooler cannot buy the middle school one", hs.code === "wrong_campus" && /Middle School/.test(hs.reason));
  check("a high schooler buys theirs", (await buyAs(d, "9001", "pup_hs")).ok === true);
  check("and the receipt says High School", receiptsOf(d).find((x) => x.rewardId === "pup_hs").school === "High School");

  // The campus is checked before the balance: "that one is for the other
  // campus" is the true answer, "you need $1,400 more" would be a false one.
  const broke = await buyAs(makeDb(seed()), "7003", "pup_hs");
  check("the campus answer comes before the money answer", broke.code === "wrong_campus");

  const unknown = makeDb(seed({ students: [kid("5001", "", 5000)], psRoster: [{ studentNumber: "5001" }] }));
  check("a child with no readable grade is sent to the office, not guessed at",
    (await buyAs(unknown, "5001", "pup_ms")).code === "unknown_campus");

  const typo = makeDb(seed());
  reward(typo, "pup_ms").campus = "Middle School";
  check("a campus that is not a campus refuses rather than selling to everyone",
    (await buyAs(typo, "7001", "pup_ms")).code === "bad_campus");
}

console.log("\nWHAT EACH CHILD SEES\n");
{
  const d = makeDb(seed());
  M.who.student = "st_7001";
  const view = await S.myStore.handler(d.ctx, {});
  const ids = view.items.map((i) => i.id);
  check("a middle schooler sees the middle school pass", ids.includes("pup_ms"));
  check("and does NOT see the high school one", !ids.includes("pup_hs"), ids.join(","));
  check("everyone-items still show", ids.includes("reward1"));
  const ms = view.items.find((i) => i.id === "pup_ms");
  check("the pass says it can be bought, with its limit", ms.canBuy === true && ms.limitPerStudent === 1 && ms.owned === 0);

  M.who.student = "st_9001";
  const hsIds = (await S.myStore.handler(d.ctx, {})).items.map((i) => i.id);
  check("a high schooler sees theirs and not the other", hsIds.includes("pup_hs") && !hsIds.includes("pup_ms"));

  M.who.student = "st_7001";
  const bought = await S.purchase.handler(d.ctx, { rewardId: "pup_ms", attemptId: "press-1", seenPrice: 1500 });
  const after = (await S.myStore.handler(d.ctx, {})).items.find((i) => i.id === "pup_ms");
  check("after buying, the card knows they own it", after.owned === 1 && after.canBuy === false && after.code === "limit_reached");
  check("and carries their receipt code, for the office",
    after.myReceipts.length === 1 && after.myReceipts[0].id === bought.receiptId);
  check("the store load never read the whole students table", !d.scans.students, JSON.stringify(d.scans));
  M.who.student = null;
}

console.log("\nA DOUBLE TAP, A RETRY, A REPRICE\n");
{
  const d = makeDb(seed());
  const first = await S.purchaseFor.handler(d.ctx, { studentNumber: "7001", rewardId: "pup_ms", attemptId: "same" });
  const again = await S.purchaseFor.handler(d.ctx, { studentNumber: "7001", rewardId: "pup_ms", attemptId: "same" });
  check("the same press twice is one purchase", again.ok === true && again.alreadyBought === true
    && again.receiptId === first.receiptId && receiptsOf(d).length === 1 && student(d, "7001").wildcatCashBalance === 500);

  const re = makeDb(seed());
  const moved = await buyAs(re, "7001", "pup_ms", { seenPrice: 1000 });
  check("a price that moved since the card loaded is refused", moved.code === "price_changed" && /\$1500/.test(moved.reason));
  check("and nothing was charged", student(re, "7001").wildcatCashBalance === 2000 && receiptsOf(re).length === 0);
  check("the price seen is never what is charged: it only refuses",
    (await buyAs(re, "7001", "pup_ms", { seenPrice: 1500 })).totalCost === 1500);
}

console.log("\nTHE LAST ONE\n");
{
  const d = makeDb(seed());
  reward(d, "pup_ms").stock = 1;
  const a = await buyAs(d, "7001", "pup_ms");
  const b = await buyAs(d, "7002", "pup_ms");
  check("the first child gets it", a.ok === true && reward(d, "pup_ms").stock === 0);
  check("the second is told it sold out, and is not charged",
    b.ok === false && /sold out/i.test(b.reason) && student(d, "7002").wildcatCashBalance === 1600);
}

console.log("\nA CODE NOBODY ELSE HOLDS\n");
{
  const d = makeDb(seed());
  d.tables.legacyMirror.push(receiptRow({ id: "WC-222222", studentId: "x", rewardId: "reward1", status: "fulfilled" }));
  const real = Math.random;
  let calls = 0;
  // The first six draws spell WC-222222, which is taken; after that, anything.
  Math.random = () => (calls++ < 6 ? 0 : 0.5);
  let r;
  try { r = await buyAs(d, "9001", "reward1"); } finally { Math.random = real; }
  check("a code that is already taken is not reused", r.ok === true && r.receiptId !== "WC-222222", r && r.receiptId);
}

console.log("\nOPENING AND CLOSING ON A TIMER\n");
{
  const d = makeDb(seed({ appState: [] }));
  const opensAt = FUTURE(9), closesAt = FUTURE(26);
  const st = await S.scheduleStore.handler(d.ctx, { opensAt, closesAt,
    reason: "The Power-Up Pass goes on sale Tuesday morning.", endedReason: "Power-Up Pass sales have ended." });
  check("scheduled to open later means shut now", st.open === false && st.opensAt === opensAt && st.closesAt === closesAt);
  check("with the before-message showing", st.shownWhileClosed === "The Power-Up Pass goes on sale Tuesday morning.");
  check("and nobody can buy yet", (await buyAs(d, "7001", "pup_ms")).code === "store_closed");
  check("two jobs are queued, at the two times",
    d.jobs.length === 2 && d.jobs[0].ms === Date.parse(opensAt) && d.jobs[1].ms === Date.parse(closesAt)
    && d.jobs.every((j) => j.fn === "studentStore.runStoreSchedule"), JSON.stringify(d.jobs));
  const [openJob, closeJob] = d.jobs;

  await S.runStoreSchedule.handler(d.ctx, openJob.args);
  check("the opening job opens it", (await S.storeOpenState.handler(d.ctx, {})).open === true);
  check("and a child can buy", (await buyAs(d, "7001", "pup_ms")).ok === true);

  await S.runStoreSchedule.handler(d.ctx, closeJob.args);
  const shut = await S.storeOpenState.handler(d.ctx, {});
  check("the closing job closes it", shut.open === false);
  check("and the message is now the 'has ended' one", shut.shownWhileClosed === "Power-Up Pass sales have ended.");
  check("nobody can buy after the close", (await buyAs(d, "7002", "pup_ms")).code === "store_closed");

  // A job from a plan somebody has since replaced does nothing.
  const d2 = makeDb(seed({ appState: [] }));
  await S.scheduleStore.handler(d2.ctx, { opensAt: FUTURE(1), closesAt: FUTURE(5) });
  const stale = d2.jobs[0];
  await S.setStore.handler(d2.ctx, { change: "close" });
  const res = await S.runStoreSchedule.handler(d2.ctx, stale.args);
  check("a job from a replaced plan is skipped", res.skipped === true);
  check("so 'Close now' is not overruled by the old opening time",
    (await S.storeOpenState.handler(d2.ctx, {})).open === false);

  // The CLOSING TIME is read from the clock by every purchase: a late job
  // cannot sell past the close.
  const d3 = makeDb(seed({ appState: [{ key: "studentStoreOpen",
    value: { open: true, closesAt: PAST(0.01), endedReason: "Sales have ended." }, mirroredAt: "x" }] }));
  const late = await buyAs(d3, "7001", "pup_ms");
  check("past the closing time, a purchase is refused even if the job has not run",
    late.code === "store_closed" && late.reason === "Sales have ended.", JSON.stringify(late));

  // "Open now" the morning after a sale must actually open it.
  const d4 = makeDb(seed({ appState: [{ key: "studentStoreOpen",
    value: { open: false, closesAt: PAST(10) }, mirroredAt: "x" }] }));
  const reopened = await S.setStoreOpen.handler(d4.ctx, { open: true });
  check("'Open now' drops a closing time already behind it", reopened.open === true && reopened.closesAt === null);
  check("and a child can buy", (await buyAs(d4, "7001", "pup_ms")).ok === true);

  // Nonsense is refused rather than half-applied.
  const d5 = makeDb(seed({ appState: [] }));
  const throws = async (args) => { try { await S.scheduleStore.handler(d5.ctx, args); return false; } catch { return true; } };
  check("closing before opening is refused", await throws({ opensAt: FUTURE(5), closesAt: FUTURE(2) }));
  check("a closing time in the past is refused", await throws({ closesAt: PAST(1) }));
  check("a date that is not a date is refused", await throws({ opensAt: "Tuesday-ish" }));
  check("an empty schedule is refused", await throws({}));
  check("and none of those wrote anything", d5.tables.appState.length === 0 && d5.jobs.length === 0);

  // Only an admin may flip it from the screen.
  M.who.adminOk = false;
  let refused = false;
  try { await S.setStore.handler(makeDb(seed()).ctx, { change: "open" }); } catch { refused = true; }
  M.who.adminOk = true;
  check("a non-admin cannot open or close the store", refused);
  const byAdmin = await S.setStore.handler(makeDb(seed({ appState: [] })).ctx, { change: "open" });
  check("an admin can, and it records who", byAdmin.open === true && byAdmin.changedBy === "Alan Kent");
}

console.log("\nWHAT THE REVIEW FOUND (2026-09-28), EACH PINNED\n");
{
  // 1. A purchase must not move the reward's updatedAt: that stamp decides
  //    whether an admin's edit is newer, and a sale every few seconds kept it
  //    ahead of every edit made during the sale.
  const d = makeDb(seed());
  const before = reward(d, "pup_ms").updatedAt;
  await buyAs(d, "7001", "pup_ms");
  check("a purchase leaves the reward's updatedAt alone", reward(d, "pup_ms").updatedAt === before);
  check("and records the stock move under its own stamp", typeof reward(d, "pup_ms").stockMovedAt === "string");

  // 2. Somebody else's retry token does not return somebody else's receipt.
  const d2 = makeDb(seed());
  await S.purchaseFor.handler(d2.ctx, { studentNumber: "7001", rewardId: "pup_ms", attemptId: "shared-chromebook" });
  const theirs = await S.purchaseFor.handler(d2.ctx, { studentNumber: "7002", rewardId: "pup_ms", attemptId: "shared-chromebook" });
  check("another child's token is refused, not answered with the first child's receipt",
    theirs.ok === false && theirs.code === "attempt_mismatch" && !theirs.receiptId);
  check("and the second child was not charged", student(d2, "7002").wildcatCashBalance === 1600);

  // 3. A close that already ran spends the opening.
  const d3 = makeDb(seed({ appState: [] }));
  await S.scheduleStore.handler(d3.ctx, { opensAt: FUTURE(9), closesAt: FUTURE(17) });
  const [openJob] = d3.jobs;
  const closeFirst = await S.runStoreSchedule.handler(d3.ctx, { token: openJob.args.token, action: "close" });
  const thenOpen = await S.runStoreSchedule.handler(d3.ctx, openJob.args);
  check("after the close has run, the opening job does nothing",
    closeFirst.skipped === false && thenOpen.skipped === true
    && (await S.storeOpenState.handler(d3.ctx, {})).open === false);

  // 4. The order is checked after merging, not only on what was sent.
  const d4 = makeDb(seed({ appState: [] }));
  await S.setStore.handler(d4.ctx, { change: "schedule", opensAt: FUTURE(9), closesAt: FUTURE(17) });
  let refused = false;
  try { await S.setStore.handler(d4.ctx, { change: "schedule", opensAt: null, closesAt: FUTURE(2) }); }
  catch { refused = true; }
  check("a closing time before a KEPT opening time is refused", refused);
  let cliRefused = false;
  try { await S.scheduleStore.handler(d4.ctx, { closesAt: FUTURE(3) }); } catch { cliRefused = true; }
  check("from the CLI too", cliRefused);

  // 5. 'Open now' with a closing time already behind it is refused, not
  //    quietly turned into 'open forever'.
  let pastClose = false;
  try { await S.setStore.handler(makeDb(seed({ appState: [] })).ctx, { change: "open", closesAt: PAST(1) }); }
  catch { pastClose = true; }
  check("'Open now' with a closing time already passed is refused", pastClose);

  // 6. A time with no zone is refused: the server runs in UTC.
  let noZone = false;
  try { await S.scheduleStore.handler(makeDb(seed({ appState: [] })).ctx, { opensAt: "2026-09-29T06:45" }); }
  catch (e) { noZone = /time zone/.test(e.message); }
  check("a time with no time zone is refused, with an example", noZone);
  const withOffset = await S.scheduleStore.handler(makeDb(seed({ appState: [] })).ctx,
    { opensAt: new Date(Date.now() + 5 * HOUR).toISOString().replace("Z", "+00:00") });
  check("an offset is fine", withOffset.opensAt !== null);
}

console.log("\nTHE DRY RUN: TESTERS BUY WHILE IT IS SHUT TO EVERYONE ELSE\n");
{
  const d = makeDb(seed({ appState: [{ key: "studentStoreOpen", value: { open: false, reason: "Soon." }, mirroredAt: "x" }] }));
  const st = await S.setStore.handler(d.ctx, { change: "testers", testers: ["7001", " 9001 ", "7001", "not-a-number"] });
  check("the list keeps real student numbers, once each", JSON.stringify(st.testers) === JSON.stringify(["7001", "9001"]));
  check("and lapses on its own, a few hours later",
    Date.parse(st.testersUntil) > Date.now() + 2.9 * HOUR && Date.parse(st.testersUntil) < Date.now() + 3.1 * HOUR);
  check("the store stays closed for everyone", st.open === false);
  check("a tester can buy", (await buyAs(d, "7001", "pup_ms")).ok === true);
  check("nobody else can", (await buyAs(d, "7002", "pup_ms")).code === "store_closed");
  M.who.student = "st_9001";
  const view = await S.myStore.handler(d.ctx, {});
  check("a tester's store says it is a test", view.storeOpen === true && view.testing === true);
  M.who.student = "st_7002";
  check("everyone else's says closed", (await S.myStore.handler(d.ctx, {})).storeOpen === false);
  M.who.student = null;

  const lapsed = makeDb(seed({ appState: [{ key: "studentStoreOpen",
    value: { open: false, testers: ["7001"], testersUntil: PAST(0.1) }, mirroredAt: "x" }] }));
  check("once the list lapses, a tester is refused like anybody else",
    (await buyAs(lapsed, "7001", "pup_ms")).code === "store_closed");

  let tooMany = false;
  try {
    await S.setStore.handler(makeDb(seed()).ctx, { change: "testers",
      testers: Array.from({ length: 11 }, (_, i) => String(1000 + i)) });
  } catch { tooMany = true; }
  check("it is for a handful: more than 10 is refused", tooMany);

  // Setting testers does not disturb a schedule already queued.
  const d2 = makeDb(seed({ appState: [] }));
  await S.scheduleStore.handler(d2.ctx, { opensAt: FUTURE(9), closesAt: FUTURE(17) });
  const tokenBefore = d2.tables.appState[0].value.token;
  await S.setStore.handler(d2.ctx, { change: "testers", testers: ["7001"] });
  check("adding testers leaves the schedule and its jobs in place",
    d2.tables.appState[0].value.token === tokenBefore && d2.tables.appState[0].value.opensAt !== null);
  const cleared = await S.setStore.handler(d2.ctx, { change: "testers", testers: [] });
  check("an empty list clears it", cleared.testers.length === 0 && cleared.testersUntil === null);
}

console.log("\nTHE SECOND REVIEW (2026-09-28)\n");
{
  // "Close now" means nobody, testers included.
  const d = makeDb(seed({ appState: [{ key: "studentStoreOpen", value: { open: false }, mirroredAt: "x" }] }));
  await S.setStore.handler(d.ctx, { change: "testers", testers: ["9001"] });
  await S.setStore.handler(d.ctx, { change: "open" });
  const closed = await S.setStore.handler(d.ctx, { change: "close" });
  check("'Close now' clears the testers", closed.testers.length === 0 && closed.testersUntil === null);
  check("so a tester cannot buy after an emergency close", (await buyAs(d, "9001", "pup_hs")).code === "store_closed");

  const d2 = makeDb(seed({ appState: [] }));
  await S.setStore.handler(d2.ctx, { change: "testers", testers: ["9001"] });
  await S.scheduleStore.handler(d2.ctx, { opensAt: FUTURE(1), closesAt: FUTURE(5) });
  const closeJob = d2.jobs.find((j) => j.fn === "studentStore.runStoreSchedule" && j.args.action === "close");
  await S.runStoreSchedule.handler(d2.ctx, closeJob.args);
  check("the scheduled close clears them too",
    (await S.storeOpenState.handler(d2.ctx, {})).testers.length === 0
    && (await buyAs(d2, "9001", "pup_hs")).code === "store_closed");

  // The lapse is WRITTEN at testersUntil, so cached reads settle.
  const d3 = makeDb(seed({ appState: [] }));
  const set = await S.setStore.handler(d3.ctx, { change: "testers", testers: ["7001"] });
  const lapse = d3.jobs.find((j) => j.fn === "studentStore.lapseStoreTesters");
  check("setting testers queues their lapse, at the time it names",
    !!lapse && lapse.ms === Date.parse(set.testersUntil) && lapse.args.testersUntil === set.testersUntil);
  await S.lapseStoreTesters.handler(d3.ctx, lapse.args);
  check("which clears the list", (await S.storeOpenState.handler(d3.ctx, {})).testers.length === 0);
  const d4 = makeDb(seed({ appState: [] }));
  const first = await S.setStore.handler(d4.ctx, { change: "testers", testers: ["7001"] });
  const firstLapse = d4.jobs.find((j) => j.fn === "studentStore.lapseStoreTesters");
  d4.tables.appState[0].value.testersUntil = FUTURE(2.5);   // re-set since
  const res = await S.lapseStoreTesters.handler(d4.ctx, firstLapse.args);
  check("but a lapse for a list that was re-set since does nothing",
    res.skipped === true && d4.tables.appState[0].value.testers.length === 1 && !!first);
}

console.log("\nA CHILD'S RECEIPT OUTLIVES THE SALE\n");
{
  const d = makeDb(seed());
  M.who.student = "st_7001";
  const bought = await S.purchase.handler(d.ctx, { rewardId: "pup_ms", attemptId: "keep-1" });
  await S.setStoreOpen.handler(d.ctx, { open: false });
  reward(d, "pup_ms").available = false;
  const shut = await S.myStore.handler(d.ctx, {});
  check("with the store closed and the pass paused, their purchase is still listed",
    shut.storeOpen === false && shut.myPurchases.length === 1 && shut.myPurchases[0].id === bought.receiptId
    && shut.myPurchases[0].rewardName === "Power-Up Pass (Middle School)");
  M.who.student = null;
}

console.log("\nTHE TEETH: re-break the shipped code, and these must fail\n");
{
  const broken = (key, from, to) => {
    const m = load({ [key]: (code) => {
      if (!code.includes(from)) throw new Error("mutation anchor missing: " + from);
      return code.replace(from, to);
    } });
    return m.store;
  };
  const tryBuy = async (store, d, sn, id) =>
    store.purchaseFor.handler(d.ctx, { studentNumber: sn, rewardId: id, attemptId: "t-" + (++attempt) });

  // 9001 holds $5,000, so a second $1,500 pass is affordable and only the
  // limit stands in the way -- otherwise "cannot afford" would pass for teeth.
  const noLimit = broken("studentStoreRules", "if (limit !== null) {", "if (false) {");
  const d1 = makeDb(seed());
  await tryBuy(noLimit, d1, "9001", "pup_hs");
  check("without the limit check a second pass WOULD sell (so the test above bites)",
    (await tryBuy(noLimit, d1, "9001", "pup_hs")).ok === true);

  const noCampus = broken("studentStoreRules", "if (mine !== forCampus) {", "if (false) {");
  check("without the campus check the other campus's pass WOULD sell",
    (await tryBuy(noCampus, makeDb(seed()), "7001", "pup_hs")).ok === true);

  const noOwned = broken("studentStore", "alreadyOwned: owned,\n    seenPrice", "alreadyOwned: 0,\n    seenPrice");
  const d3 = makeDb(seed());
  await tryBuy(noOwned, d3, "9001", "pup_hs");
  check("if the purchase stopped counting receipts, the limit WOULD be bypassed",
    (await tryBuy(noOwned, d3, "9001", "pup_hs")).ok === true);

  const noClock = broken("studentStoreRules", "const everyone = v.open === true && !pastClose;", "const everyone = v.open === true;");
  const d4 = makeDb(seed({ appState: [{ key: "studentStoreOpen", value: { open: true, closesAt: PAST(1) }, mirroredAt: "x" }] }));
  check("without the clock check a late job WOULD keep selling",
    (await tryBuy(noClock, d4, "7001", "pup_ms")).ok === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
