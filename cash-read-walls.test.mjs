// The cash read walls, interim step (2026-10-05). Run: npm test
//
// WHAT THIS PINS. Convex stops one query or mutation at 16 MiB of data read.
// Measured on production that day, the admin Reverse button and the
// reversible list read every cash week since 9/14 plus the whole students
// table (every student row carries its whole cash-history copy): ~7.4 of 16
// MiB, failing about the first week of November. The staff page load read the
// students table plus all 5,463 roster rows just to learn who is enrolled:
// 5.8 MiB by Convex's own count, and its failure is SILENT (the tab falls back
// to its local copy). These tests hold the shipped code to the fix:
//
//   1. a reversal reads ONE student by index and at most three weeks, and a
//      miss is said ("index_miss"), never searched for across the ledger;
//   2. the reversible list's `ledgerRows` is the true total or the words
//      "at least N" -- never a bare short count the panel would print as the
//      child's whole ledger, and never null (which it printed as "null") --
//      and it offers no Reverse button the server would refuse;
//   3. appData:load learns enrolment with one lookup per student, and names
//      exactly the students the whole-roster read named, across batches;
//   4. the nightly headroom check measures, bands, projects the list's stop
//      where it really stops, records a night that threw, and raises its audit
//      entry when a band is worse than what was last announced and the switch
//      is on;
//   5. every capped read in the cash tools that delete or restore rows
//      (reverseRefund, missingLedgerRows) and in the recount's and the
//      diagnostics' reads refuses to conclude when it was cut off.
//
// NOTHING IS COPIED. Every module is the shipped source, transpiled and wired
// through a require shim, run against an in-memory database that counts what
// each call reads. The load-bearing checks are re-run against deliberately
// re-broken source, to prove they have teeth.
import { readFileSync } from "node:fs";
import ts from "typescript";

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

const src = (f) => readFileSync(new URL("./convex/" + f, import.meta.url), "utf8");
const SRC = {
  appDataShape: src("appDataShape.ts"),
  appData: src("appData.ts"),
  cashReversalRules: src("cashReversalRules.ts"),
  cashReversal: src("cashReversal.ts"),
  readHeadroomRules: src("readHeadroomRules.ts"),
  readHeadroom: src("readHeadroom.ts"),
};

// ---------------------------------------------------------------- the loader
const fnRef = new Proxy({}, { get: (_, mod) => new Proxy({}, { get: (__, fn) => `${String(mod)}.${String(fn)}` }) });
// Any other convex module is read on first use, so the tools below can be
// loaded too; the same source is transpiled once.
const TRANSPILED = new Map();
function load(overrides) {
  const o = overrides || {};
  const cache = {};
  const passThrough = (d) => d;
  const stubs = {
    "./_generated/server": {
      mutation: passThrough, query: passThrough, internalMutation: passThrough,
      internalQuery: passThrough, internalAction: passThrough, action: passThrough,
    },
    "./_generated/api": { internal: fnRef, api: fnRef },
    "convex/values": { v: new Proxy({}, { get: () => (...a) => ({ _v: true, a }) }) },
    "./identity": {
      requireStaff: async () => ({ _id: "t1", name: "A Teacher", role: "teacher" }),
      requireAdmin: async () => ({ _id: "t2", legacyId: "T002", name: "An Admin", email: "admin@x", role: "admin" }),
    },
  };
  const req = (name) => {
    const norm = name.replace(/\.js$/, "");
    if (stubs[norm]) return stubs[norm];
    const key = norm.replace(/^\.\//, "");
    if (cache[key]) return cache[key];
    let code = SRC[key] ?? (SRC[key] = src(key + ".ts"));
    if (!code) throw new Error("no module " + name);
    if (o[key]) code = o[key](code);
    if (!TRANSPILED.has(code)) TRANSPILED.set(code, ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText);
    const js = TRANSPILED.get(code);
    const module = { exports: {} };
    cache[key] = module.exports;
    new Function("require", "module", "exports", "console", js)(req, module, module.exports, o.console || quietConsole);
    cache[key] = module.exports;
    return module.exports;
  };
  return {
    rules: req("./cashReversalRules"),
    reversal: req("./cashReversal"),
    appData: req("./appData"),
    headroomRules: req("./readHeadroomRules"),
    headroom: req("./readHeadroom"),
    req,
  };
}
const warnings = [];
const quietConsole = { log() {}, warn: (...a) => warnings.push(a.join(" ")), error() {} };

// ------------------------------------------------------- the fake database
// Index order is the eq'd fields then creation time, as in Convex. Every read
// is logged with the documents it returned and their bytes (JSON of the whole
// row, the estimator the code itself uses).
const size = (r) => JSON.stringify(r).length;
function makeDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed || {}));
  let n = 0;
  for (const t of Object.keys(tables)) tables[t].forEach((r) => {
    if (!r._id) r._id = `${t}:${n++}`;
    if (r._creationTime === undefined) r._creationTime = n;
  });
  const log = [];
  const writes = [];
  const q = (name) => {
    let rows = (tables[name] || []).slice().sort((a, b) => a._creationTime - b._creationTime);
    let idx = null; const eqs = {}; let desc = false;
    const done = (terminal, out) => {
      log.push({ table: name, idx, eqs: { ...eqs }, terminal, docs: out.length, bytes: out.reduce((a, r) => a + size(r), 0) });
      return out;
    };
    const ordered = () => (desc ? rows.slice().reverse() : rows);
    const api = {
      withIndex(i, fn) {
        idx = i;
        if (fn) {
          const chain = {
            eq: (c, v) => { eqs[c] = v; return chain; },
            gte: (c, v) => { rows = rows.filter((r) => r[c] >= v); return chain; },
          };
          fn(chain);
          rows = rows.filter((r) => Object.entries(eqs).every(([c, v]) => r[c] === v));
        }
        return api;
      },
      order(d) { desc = d === "desc"; return api; },
      async first() { return done("first", ordered().slice(0, 1))[0] ?? null; },
      async unique() {
        const out = ordered();
        if (out.length > 1) throw new Error("unique() found two");
        return done("unique", out)[0] ?? null;
      },
      async take(k) { return done(`take(${k})`, ordered().slice(0, k)); },
      async collect() { return done("collect", ordered()); },
      async paginate({ cursor, numItems }) {
        const from = cursor ? Number(cursor) : 0;
        const page = done("paginate", ordered().slice(from, from + numItems));
        const next = from + page.length;
        return { page, continueCursor: String(next), isDone: next >= rows.length };
      },
    };
    return api;
  };
  const find = (id) => { for (const t of Object.values(tables)) { const r = t.find((x) => x._id === id); if (r) return r; } return null; };
  return {
    tables, log, writes,
    db: {
      query: q,
      normalizeId: (table, id) => (typeof id === "string" && id.startsWith(table + ":") ? id : null),
      async get(id) { const r = find(id); log.push({ table: "(get)", terminal: "get", docs: r ? 1 : 0, bytes: r ? size(r) : 0 }); return r; },
      async insert(name, doc) { tables[name] = tables[name] || []; const row = { ...doc, _id: `${name}:new${n++}`, _creationTime: 1e12 + n }; tables[name].push(row); writes.push({ op: "insert", table: name }); return row._id; },
      async patch(id, fields) { const r = find(id); if (r) Object.assign(r, fields); writes.push({ op: "patch", id }); },
      async delete(id) {
        for (const t of Object.keys(tables)) { const i = tables[t].findIndex((x) => x._id === id); if (i >= 0) tables[t].splice(i, 1); }
        writes.push({ op: "delete", id });
      },
    },
  };
}
const readsOf = (log, table) => log.filter((e) => e.table === table);
const weeksRead = (log) => [...new Set(readsOf(log, "legacyMirror").map((e) => e.eqs.doc))];

// ------------------------------------------------------------- fixtures
const M = load();
const W = M.rules.cashWeekKey;
const DAY = 86400000;
const NOW = Date.now();
const CUTOFF = new Date(NOW - 25 * DAY).toISOString();
const iso = (ms) => new Date(ms).toISOString();
// Wednesday noon UTC of the week `ms` falls in (the week before, when that is
// still to come): far from a week boundary, so a reversal's search plan is
// exactly the one week. An id within an hour of a boundary also reads its
// neighbour, and the search reads every planned week before deciding.
const midweek = (ms) => {
  const d = new Date(ms); d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 3));
  return d.getTime() <= NOW - 60000 ? d.getTime() : d.getTime() - 7 * DAY;
};
// A fat cash-history copy on every student, as production has: this is what
// a whole-students read pays for.
const fatHistory = (k) => Array.from({ length: 12 }, (_, i) => ({ id: `h${k}_${i}`, amount: 5, kind: "award", notes: "x".repeat(200) }));
function student(k, over) {
  return Object.assign({
    _id: `students:s${k}`, legacyId: String(10000 + k), studentNumber: String(10000 + k),
    firstName: "S", lastName: String(k), grade: "9",
    wildcatCashBalance: 1000, wildcatCashEarned: 1000, wildcatCashSpent: 0, wildcatCashDeducted: 0,
    wildcatCashTransactions: fatHistory(k),
  }, over || {});
}
function cashRow(ms, sid, over) {
  const p = Object.assign({
    id: `txn_${ms}_${Math.random().toString(36).slice(2, 7)}`, timestamp: iso(ms), studentId: sid,
    amount: 100, kind: "award", type: "positive", behaviorId: "be", behaviorName: "Be Present",
    teacherId: "T1", teacherName: "T", notes: "n".repeat(300),
  }, over || {});
  return { doc: "cash_tx_" + W(p.timestamp), collection: "transactions", payload: p, mirroredAt: p.timestamp };
}
function baseSeed() {
  const students = Array.from({ length: 40 }, (_, k) => student(k + 1));
  const ledger = [];
  // Four weeks of filler from other students, so a read of the wrong week, or
  // of every week, shows up in the byte count.
  for (let w = 0; w < 4; w++) for (let i = 0; i < 30; i++) ledger.push(cashRow(NOW - w * 7 * DAY - (i + 1) * 60000, String(10002 + (i % 30))));
  return {
    appState: [{ key: "historyCutoff", value: { iso: CUTOFF }, mirroredAt: "x" }],
    students, legacyMirror: ledger, cashReversals: [], appAuditLog: [],
  };
}

// ======================================================================
console.log("\n1. A reversal reads one student by index and the week its id names");
{
  const recent = cashRow(midweek(NOW - 3600 * 1000), "10001");
  const old = cashRow(midweek(NOW - 14 * DAY), "10001");
  const s = baseSeed(); s.legacyMirror.push(recent, old);
  for (const [label, row] of [["a recent transaction", recent], ["a two-week-old one", old]]) {
    const d = makeDb(s);
    const r = await M.reversal.reverseAsAdmin.handler({ db: d.db }, { originalTxnId: row.payload.id, reason: "wrong child", actorName: "Test" });
    check(`${label} is reversed`, r.ok === true && r.alreadyReversed === false, JSON.stringify(r).slice(0, 200));
    const studentReads = readsOf(d.log, "students");
    check(`  ...reading the student by index, never the whole table`,
      studentReads.length >= 1 && studentReads.every((e) => e.idx === "by_legacyId" && e.terminal !== "collect") &&
      studentReads.reduce((a, e) => a + e.docs, 0) === 1,
      JSON.stringify(studentReads));
    check(`  ...and exactly the one week its id names (${row.doc})`,
      JSON.stringify(weeksRead(d.log)) === JSON.stringify([row.doc]), weeksRead(d.log).join(","));
    const moved = d.tables.students.find((x) => x.legacyId === "10001");
    check(`  ...and the money moved exactly as before: by the delta, recorded once`,
      moved.wildcatCashBalance === 900 && moved.wildcatCashEarned === 900 &&
      d.tables.cashReversals.length === 1 && d.tables.appAuditLog.length === 1 &&
      d.tables.legacyMirror.filter((x) => x.payload.kind === "reversal").length === 1);
  }
}

console.log("\n2. A wrong hint costs one week; an id with no time needs its week");
{
  const row = cashRow(midweek(NOW - 10 * DAY), "10001");
  const s = baseSeed(); s.legacyMirror.push(row);
  let d = makeDb(s);
  const wrongHint = W(iso(NOW));
  let r = await M.reversal.reverseAsAdmin.handler({ db: d.db }, { originalTxnId: row.payload.id, reason: "wrong child", actorName: "T", weekHint: wrongHint });
  check("a wrong weekHint is read first and then the id's own week finds it",
    r.ok === true && JSON.stringify(weeksRead(d.log)) === JSON.stringify(["cash_tx_" + wrongHint, row.doc]),
    weeksRead(d.log).join(","));

  d = makeDb(s);
  r = await M.reversal.reverseAsAdmin.handler({ db: d.db }, { originalTxnId: row.payload.id, reason: "wrong child", actorName: "T", weekHint: "not a week" });
  check("a hint that is not a week key is ignored, never queried",
    r.ok === true && JSON.stringify(weeksRead(d.log)) === JSON.stringify([row.doc]), weeksRead(d.log).join(","));

  const rb = cashRow(NOW - 10 * DAY, "10001", { id: "txn_rb_0123456789ab" });
  const s2 = baseSeed(); s2.legacyMirror.push(rb);
  d = makeDb(s2);
  warnings.length = 0;
  r = await M.reversal.reverseAsAdmin.handler({ db: d.db }, { originalTxnId: rb.payload.id, reason: "wrong child", actorName: "T" });
  check("a txn_rb_ id with no hint is an index_miss that reads NO week at all",
    r.ok === false && r.code === "index_miss" && weeksRead(d.log).length === 0 && /no date/.test(r.reason), JSON.stringify(r));
  check("  ...and it is logged", warnings.some((w) => /index_miss/.test(w) && w.includes(rb.payload.id)));
  check("  ...and nothing was written", d.tables.cashReversals.length === 0 && d.tables.appAuditLog.length === 0);

  d = makeDb(s2);
  r = await M.reversal.reverseAsAdmin.handler({ db: d.db }, { originalTxnId: rb.payload.id, reason: "wrong child", actorName: "T", weekHint: W(rb.payload.timestamp) });
  check("  ...and with its week as the hint it is found and reversed in one read",
    r.ok === true && weeksRead(d.log).length === 1, JSON.stringify(r).slice(0, 160));
}

console.log("\n3. A miss is bounded, whatever the ledger holds");
{
  // Wednesday noon UTC of the week three weeks ago: far from any boundary.
  const wed = new Date(NOW - 21 * DAY); wed.setUTCHours(12, 0, 0, 0);
  wed.setUTCDate(wed.getUTCDate() - (((wed.getUTCDay() || 7) - 3)));
  const ghost = `txn_${wed.getTime()}_ghost`;
  const d = makeDb(baseSeed());
  const r = await M.reversal.reverseAsAdmin.handler({ db: d.db }, { originalTxnId: ghost, reason: "wrong child", actorName: "T" });
  check("an id the ledger does not hold is index_miss after ONE week, not a scan of every week",
    r.ok === false && r.code === "index_miss" && weeksRead(d.log).length === 1, `${r.code} ${weeksRead(d.log).join(",")}`);
  check("  ...and the student table is never touched on a miss", readsOf(d.log, "students").length === 0);

  // Ten minutes into a week (Monday 00:10 UTC): the previous week is searched too.
  const mon = new Date(wed.getTime()); mon.setUTCDate(mon.getUTCDate() - 2); mon.setUTCHours(0, 10, 0, 0);
  const d2 = makeDb(baseSeed());
  const r2 = await M.reversal.reverseAsAdmin.handler({ db: d2.db }, { originalTxnId: `txn_${mon.getTime()}_edge`, reason: "wrong child", actorName: "T", weekHint: "2020_W01" });
  check("an id at a week's edge reads its neighbour too, and never more than three weeks with a hint",
    r2.code === "index_miss" && weeksRead(d2.log).length === 3 &&
    weeksRead(d2.log)[1] === "cash_tx_" + W(iso(mon.getTime())) &&
    weeksRead(d2.log)[2] === "cash_tx_" + W(iso(mon.getTime() - 3600 * 1000)), weeksRead(d2.log).join(","));
}

console.log("\n4. Two rows with one id, two students with one id: refused, nothing moves");
{
  const row = cashRow(NOW - 2 * DAY, "10001");
  const s = baseSeed(); s.legacyMirror.push(row, JSON.parse(JSON.stringify(row)));
  const d = makeDb(s);
  const r = await M.reversal.reverseAsAdmin.handler({ db: d.db }, { originalTxnId: row.payload.id, reason: "wrong child", actorName: "T" });
  check("a duplicated id is refused as duplicate_txn_id, not half-reversed",
    r.ok === false && r.code === "duplicate_txn_id" && d.tables.cashReversals.length === 0 &&
    d.tables.students.find((x) => x.legacyId === "10001").wildcatCashBalance === 1000, JSON.stringify(r));

  const s2 = baseSeed(); const row2 = cashRow(NOW - 2 * DAY, "10001"); s2.legacyMirror.push(row2);
  s2.students.push(student(99, { legacyId: "10001", studentNumber: "99999" }));
  const d2 = makeDb(s2);
  const r2 = await M.reversal.reverseAsAdmin.handler({ db: d2.db }, { originalTxnId: row2.payload.id, reason: "wrong child", actorName: "T" });
  check("two students carrying one legacyId are refused (student_ambiguous), not a coin toss",
    r2.ok === false && r2.code === "student_ambiguous" && d2.tables.cashReversals.length === 0, JSON.stringify(r2));
}

console.log("\n5. The student is the same one the old scan found -- no wider net");
{
  // By _id: a ledger row naming the Convex id still resolves.
  const s = baseSeed();
  s.students.push(student(77, { _id: "students:noLegacy", legacyId: undefined, studentNumber: "55555" }));
  const row = cashRow(NOW - 2 * DAY, "students:noLegacy");
  s.legacyMirror.push(row);
  let d = makeDb(s);
  let r = await M.reversal.reverseAsAdmin.handler({ db: d.db }, { originalTxnId: row.payload.id, reason: "wrong child", actorName: "T" });
  check("a row naming a student by _id is found through normalizeId + get", r.ok === true, JSON.stringify(r).slice(0, 200));

  // By studentNumber ONLY: the old scan never matched this, so neither does the index.
  const s2 = baseSeed();
  s2.students.push(student(78, { legacyId: "L-78", studentNumber: "78787" }));
  const row2 = cashRow(NOW - 2 * DAY, "78787");
  s2.legacyMirror.push(row2);
  d = makeDb(s2);
  r = await M.reversal.reverseAsAdmin.handler({ db: d.db }, { originalTxnId: row2.payload.id, reason: "wrong child", actorName: "T" });
  check("a row that matches only a studentNumber is student_not_found, exactly as the scan was",
    r.ok === false && r.code === "student_not_found", JSON.stringify(r));
}

// ======================================================================
// The live panel's own label code, lifted from script.js, so "compatible
// with the live browser" is checked against what the browser really prints.
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const labelStart = script.indexOf("` &middot; ${data.ledgerRows} ledger row");
const labelEnd = script.indexOf("reversing never deletes anything</p>`", labelStart) + "reversing never deletes anything</p>`".length;
const panelLabel = new Function("data", "rows", "return (" + script.slice(labelStart, labelEnd) + ");");

console.log("\n6. The reversible list: newest weeks first, and a true total or none");
{
  const s = baseSeed();
  for (let i = 0; i < 60; i++) s.legacyMirror.push(cashRow(NOW - i * 7 * 3600 * 1000 - 1000, "10001"));
  const d = makeDb(s);
  const out = await M.reversal.reversibleFor.handler({ db: d.db }, { studentId: "10001" });
  check("every week since the cutoff read: ledgerRows is the TRUE total, past the page of 50",
    out.complete === true && out.ledgerRows === 60 && out.returned === 50 && out.more === true, JSON.stringify({ c: out.complete, l: out.ledgerRows, r: out.returned }));
  check("  ...newest week first", readsOf(d.log, "legacyMirror")[0].eqs.doc === "cash_tx_" + W(iso(NOW)));
  check("  ...one student read by index", readsOf(d.log, "students").every((e) => e.terminal !== "collect"));
  check("  ...and the live panel prints the true total and says it is showing 50",
    /60 ledger rows &middot; showing the newest 50/.test(panelLabel(out, out.transactions)), panelLabel(out, out.transactions));
  check("each row carries its week, the hint a later client can pass back",
    out.transactions.every((t) => /^\d{4}_W\d{2}$/.test(t.weekKey)));

  // The 12/21 cliff: a cutoff more than fourteen weeks back.
  const s2 = baseSeed();
  s2.appState = [{ key: "historyCutoff", value: { iso: new Date(NOW - 20 * 7 * DAY).toISOString() }, mirroredAt: "x" }];
  s2.legacyMirror.push(cashRow(NOW - 60000, "10001"));
  const d2 = makeDb(s2);
  const out2 = await M.reversal.reversibleFor.handler({ db: d2.db }, { studentId: "10001" });
  check("a cutoff twenty weeks back still lists this week's transaction (no 12/21 cliff)",
    out2.transactions.some((t) => t.weekKey === W(iso(NOW))), out2.transactions.map((t) => t.weekKey).join(","));
  check("  ...reads at most fourteen weeks", weeksRead(d2.log).length <= 14, String(weeksRead(d2.log).length));
  check("  ...and, not having reached the cutoff, says so: ledgerRows a lower bound in words, complete false, more true",
    out2.ledgerRows === `at least ${out2.ledgerRowsRead}` && out2.complete === false && out2.more === true,
    JSON.stringify({ l: out2.ledgerRows, c: out2.complete }));
  const label2 = panelLabel(out2, out2.transactions);
  check("  ...and the live panel prints it as a lower bound -- never 'null', never a bare number as the whole ledger",
    /&middot; at least \d+ ledger rows &middot;/.test(label2) && !/null/.test(label2) &&
    !/&middot; \d+ ledger row/.test(label2) && !/showing the newest/.test(label2), label2);

  // More than a page read, and still incomplete: the case from about 11/9.
  const s3 = baseSeed();
  s3.appState = [{ key: "historyCutoff", value: { iso: new Date(NOW - 20 * 7 * DAY).toISOString() }, mirroredAt: "x" }];
  for (let i = 0; i < 60; i++) s3.legacyMirror.push(cashRow(NOW - i * 7 * 3600 * 1000 - 1000, "10001"));
  const out3 = await M.reversal.reversibleFor.handler({ db: makeDb(s3).db }, { studentId: "10001" });
  const label3 = panelLabel(out3, out3.transactions);
  check("  ...with more rows read than a page, it reads 'at least 60' and claims no page size",
    out3.returned === 50 && out3.ledgerRowsRead === 60 &&
    /&middot; at least 60 ledger rows &middot; reversing/.test(label3), label3);
}

console.log("\n7. The list stops inside its byte budget and says so, never half a week");
{
  const tiny = load({ cashReversal: (c) => c.replace("const LIST_BYTE_BUDGET = 12 * 1048576;", "const LIST_BYTE_BUDGET = 60000;") });
  const s = baseSeed();
  s.legacyMirror.push(cashRow(NOW - 60000, "10001"), cashRow(NOW - 15 * DAY, "10001"));
  const d = makeDb(s);
  const out = await tiny.reversal.reversibleFor.handler({ db: d.db }, { studentId: "10001" });
  const read = readsOf(d.log, "legacyMirror");
  check("with a budget of a week or so, it stops before the weeks that do not fit",
    out.complete === false && out.ledgerRows === `at least ${out.ledgerRowsRead}` && out.more === true &&
    out.weeksRead >= 1 && out.weeksRead < 4,
    JSON.stringify({ c: out.complete, w: out.weeksRead, l: out.ledgerRows }));
  check("  ...every read capped by row count, so no read can run far past the budget",
    read.every((e) => /^take\(\d+\)$/.test(e.terminal)), read.map((e) => e.terminal).join(","));
  check("  ...and only whole weeks are listed: the week it stopped at contributes no rows",
    out.transactions.every((t) => weeksRead(d.log).slice(0, out.weeksRead).includes("cash_tx_" + t.weekKey)) &&
    !out.transactions.some((t) => t.weekKey === W(iso(NOW - 15 * DAY))),
    out.transactions.map((t) => t.weekKey).join(","));
}

console.log("\n7b. An incomplete list with nothing in it says what it did not read, not 'no cash movements'");
{
  const tiny = load({ cashReversal: (c) => c.replace("const LIST_BYTE_BUDGET = 12 * 1048576;", "const LIST_BYTE_BUDGET = 60000;") });
  const s = baseSeed();
  // This child's only movement sits in a week the budget leaves out.
  s.legacyMirror.push(cashRow(NOW - 15 * DAY, "10001"));
  const out = await tiny.reversal.reversibleFor.handler({ db: makeDb(s).db }, { studentId: "10001" });
  const only = out.transactions[0] || {};
  check("one greyed row explains the older weeks were not read",
    out.complete === false && out.transactions.length === 1 && only.code === "older_weeks_not_read" &&
    only.canReverse === false && /older than that/.test(String(only.why || "")),
    JSON.stringify({ c: out.complete, n: out.transactions.length, code: only.code }));
  check("  ...it is not counted as a real row", out.returned === 0 && out.ledgerRowsRead === 0,
    JSON.stringify({ r: out.returned, l: out.ledgerRowsRead }));
  check("  ...and a complete empty list still returns no rows at all",
    (await M.reversal.reversibleFor.handler({ db: makeDb(baseSeed()).db }, { studentId: "99999" })).transactions
      .every((t) => t.code !== "older_weeks_not_read"));
}

console.log("\n8. A repaired row with no date in its id is greyed, not offered");
{
  const s = baseSeed();
  s.legacyMirror.push(cashRow(NOW - 2 * DAY, "10001", { id: "txn_rb_abcdef012345" }));
  const d = makeDb(s);
  const out = await M.reversal.reversibleFor.handler({ db: d.db }, { studentId: "10001" });
  const rb = out.transactions.find((t) => t.txnId === "txn_rb_abcdef012345");
  check("its Reverse button is not offered (the live panel sends the id alone)",
    rb && rb.canReverse === false && rb.code === "needs_week_hint", JSON.stringify(rb));
  check("  ...and the reason names its week", rb && rb.why.includes(rb.weekKey), rb && rb.why);
  const ordinary = out.transactions.find((t) => t.txnId !== "txn_rb_abcdef012345");
  check("  ...while an ordinary row is still reversible", !ordinary || ordinary.canReverse === true);

  // An id whose time names a week far from the one the row is filed in.
  const s2 = baseSeed();
  const misfiled = cashRow(NOW - 2 * DAY, "10001", { id: `txn_${NOW - 40 * DAY}_misfiled` });
  s2.legacyMirror.push(misfiled);
  const out2 = await M.reversal.reversibleFor.handler({ db: makeDb(s2).db }, { studentId: "10001" });
  const mf = out2.transactions.find((t) => t.txnId === misfiled.payload.id);
  check("a row filed in a different week from the one its id names is greyed the same way",
    mf && mf.canReverse === false && mf.code === "needs_week_hint" && /different week/.test(mf.why), JSON.stringify(mf));
}

// ======================================================================
console.log("\n9. appData:load: enrolment by one lookup per student, the same answer");
{
  const s = {
    students: [
      student(1), student(2), student(3),
      student(4, { studentNumber: "" }),            // no number: never enrolled
      student(5, { studentNumber: "NOT-ROSTERED" }), // left the school
      student(6, { studentNumber: undefined }),
    ],
    teachers: [{ name: "T", email: "t@x", role: "teacher" }],
    appState: [{ key: "liveSettings", value: { currentWeek: 3 }, mirroredAt: "x" },
               { key: "historyCutoff", value: { iso: CUTOFF }, mirroredAt: "x" }],
    psRoster: [],
  };
  // Nine roster rows per student, as production has.
  for (const n of ["10001", "10002", "10003"]) for (let i = 0; i < 9; i++) s.psRoster.push({ studentNumber: n, sectionId: `sec${i}`, teacherEmail: `t${i}@x`, courseName: "c".repeat(300) });
  const d = makeDb(s);
  const out = await M.appData.load.handler({ db: d.db }, {});
  const rosterNums = new Set(s.psRoster.map((r) => r.studentNumber));
  const oldFlags = s.students.map((r) => Boolean(r.studentNumber && rosterNums.has(r.studentNumber)));
  check("every student's enrolled flag equals the whole-roster method's",
    JSON.stringify(out.students.map((x) => x.enrolled)) === JSON.stringify(oldFlags),
    JSON.stringify(out.students.map((x) => x.enrolled)) + " vs " + JSON.stringify(oldFlags));
  const roster = readsOf(d.log, "psRoster");
  check("psRoster is never collected: one indexed first() per student with a number",
    // Four of the six have a number; the other two are never looked up.
    roster.length === 4 && roster.every((e) => e.terminal === "first" && e.idx === "by_studentNumber"),
    roster.map((e) => e.terminal).join(","));
  check("  ...so it reads one roster row per enrolled student, not nine",
    roster.reduce((a, e) => a + e.docs, 0) === 3);
  const self = await M.appData.loadSelfCheck.handler({ db: d.db }, {});
  check("loadSelfCheck proves the two methods agree (for the post-deploy check)",
    self.enrolledNow === 3 && self.enrolledByRosterScan === 3 && self.enrolmentMethodsDisagree === 0, JSON.stringify(self).slice(0, 200));

  // Teeth: put the old whole-roster read back and the read check must notice.
  const broken = load({ appData: (c) => c.replace(
    "const enrolled = await enrolledByIndex(ctx, studentRows);",
    "const rosterRows = await ctx.db.query(\"psRoster\").collect(); const nums = new Set(rosterRows.map((r) => r.studentNumber)); const enrolled = studentRows.map((r) => Boolean(r.studentNumber && nums.has(r.studentNumber)));") });
  const d2 = makeDb(s);
  await broken.appData.load.handler({ db: d2.db }, {});
  check("(teeth) restoring the whole-roster collect is caught by the read check",
    readsOf(d2.log, "psRoster").some((e) => e.terminal === "collect"));
}

// ======================================================================
console.log("\n10. The headroom bands, growth and dates");
{
  const R = M.headroomRules;
  check("bands: 39.9 green, 40 amber, 69.9 amber, 70 red, unmeasurable red",
    R.bandOf(39.9) === "green" && R.bandOf(40) === "amber" && R.bandOf(69.9) === "amber" &&
    R.bandOf(70) === "red" && R.bandOf(NaN) === "red");
  const MiB = 1048576;
  // Today's production numbers (2026-10-05, JSON whole-row bytes).
  const measure = {
    nowIso: "2026-10-05T20:00:00.000Z", cutoffIso: "2026-09-14T15:30:00.000Z",
    students: { rows: 763, bytes: 3.462 * MiB, cashCopyBytes: 2.711 * MiB, largestRowBytes: 25000, rosterLookupBytes: 0.325 * MiB, rosterLookupHits: 607 },
    psRoster: { rows: 5463, bytes: 2.94 * MiB }, teachers: { rows: 63, bytes: 0.014 * MiB }, loadSettingsBytes: 20000,
    mirror: { rows: 7985, bytes: 4.718 * MiB, docs: [
      { doc: "cash_tx_2026_W38", rows: 2527, bytes: 1.414 * MiB }, { doc: "cash_tx_2026_W39", rows: 1855, bytes: 1.044 * MiB },
      { doc: "cash_tx_2026_W40", rows: 2286, bytes: 1.284 * MiB }, { doc: "cash_tx_2026_W41", rows: 286, bytes: 0.16 * MiB },
      { doc: "cash_tx_2026_W30", rows: 10, bytes: 0.01 * MiB }, { doc: "secondary", rows: 347, bytes: 0.36 * MiB } ] },
  };
  const readers = R.estimateReaders(measure);
  const by = Object.fromEntries(readers.map((r) => [r.name, r]));
  check("appData:load = students + one roster row each + teachers + settings",
    Math.abs(by["appData:load"].estMiB - 3.82) < 0.02, String(by["appData:load"].estMiB));
  check("the reversal list = the cash weeks since the cutoff + one student (a pre-cutoff week left out)",
    Math.abs(by["cashReversal:reversibleForStudent"].estMiB - 3.93) < 0.02, String(by["cashReversal:reversibleForStudent"].estMiB));
  check("whole-mirror + students tools are amber today (51%)",
    by["whole-mirror + students tools"].band === "amber" && Math.round(by["whole-mirror + students tools"].pct) === 51,
    JSON.stringify(by["whole-mirror + students tools"]));
  check("readers come nearest-the-wall first", readers.every((r, i) => i === 0 || readers[i - 1].pct >= r.pct));
  const g = R.growthOf(measure);
  check("growth: the completed weeks since the cutoff (W38-W40), not this week, not before the cutoff",
    g.completedWeeks === 3 && Math.abs(g.ledgerMiBPerWeek - 1.25) < 0.01, JSON.stringify(g));
  check("  ...and the student copies grow in proportion (about 0.69 of the ledger)",
    Math.abs(g.studentsMiBPerWeek / g.ledgerMiBPerWeek - 0.69) < 0.02, JSON.stringify(g));
  const dates = R.projectDates([{ name: "x", estMiB: 6, growthMiBPerWeek: 1, pct: 37.5, band: "green" },
                                { name: "flat", estMiB: 2, growthMiBPerWeek: null, pct: 12.5, band: "green" },
                                { name: "over", estMiB: 12, growthMiBPerWeek: 1, pct: 75, band: "red" }], "2026-10-05T00:00:00.000Z");
  check("projected dates: amber in 0.4 weeks, red in 5.2, the limit in 10",
    dates.x.amber === "2026-10-07" && dates.x.red === "2026-11-10" && dates.x.limit === "2026-12-14", JSON.stringify(dates.x));
  check("  ...'now' once it is there, null when it does not grow",
    dates.over.red === "now" && dates.flat.amber === null && dates.flat.limit === null);

  const nxt = (bands) => ({ readers: Object.entries(bands).map(([name, band]) => ({ name, band, pct: 1, estMiB: 1 })) });
  check("worsened: the first record is a baseline -- amber is not news, red is",
    JSON.stringify(R.worsenedReaders(null, nxt({ a: "amber", b: "red", c: "green" })).map((w) => w.name)) === '["b"]');
  check("  ...green to amber and amber to red are news; same or better is not",
    JSON.stringify(R.worsenedReaders(nxt({ a: "green", b: "amber", c: "amber", d: "red" }),
      nxt({ a: "amber", b: "red", c: "amber", d: "green" })).map((w) => w.name)) === '["a","b"]');
}

console.log("\n11. The nightly check end to end: pages, records, and keeps quiet unless told");
{
  const s = baseSeed();
  s.psRoster = s.students.slice(0, 30).flatMap((st) => [0, 1, 2].map((i) => ({ studentNumber: st.studentNumber, sectionId: `x${i}` })));
  s.teachers = [{ name: "T" }];
  s.appState.push({ key: "liveSettings", value: { a: 1 }, mirroredAt: "x" });
  const d = makeDb(s);
  const H = M.headroom;
  const QUERIES = { "readHeadroom.studentsPage": H.studentsPage, "readHeadroom.rosterPage": H.rosterPage,
                    "readHeadroom.mirrorPage": H.mirrorPage, "readHeadroom.smallReads": H.smallReads,
                    "readHeadroom.trendsContextReads": H.trendsContextReads,
                    "readHeadroom.recordResult": H.recordResult };
  const ctx = {
    runQuery: async (ref, args) => QUERIES[ref].handler({ db: d.db }, args),
    runMutation: async (ref, args) => QUERIES[ref].handler({ db: d.db }, args),
  };
  const r1 = await H.nightly.handler(ctx, { reason: "test" });
  const v1 = (await H.latest.handler({ db: d.db }, {})).value;
  check("it records readHeadroom with readers, bands, dates and the measurement time",
    r1.recorded === true && v1 && v1.ok === true && Array.isArray(v1.readers) && v1.readers.length >= 6 &&
    v1.readers.every((x) => ["green", "amber", "red"].includes(x.band) && Number.isFinite(x.estMiB)) &&
    typeof v1.measuredAt === "string" && v1.projectedDates && v1.projectedDates["appData:load"], JSON.stringify(v1).slice(0, 300));
  check("  ...it read every student row in pages, never in one collect",
    readsOf(d.log, "students").every((e) => e.terminal === "paginate"));
  const studentsBytes = s.students.reduce((a, x) => a + size(x), 0);
  check("  ...and measured the students table to the byte (whole rows)",
    Math.abs(v1.tables.students.MiB - Math.round(studentsBytes / 1048576 * 100) / 100) < 0.011, `${v1.tables.students.MiB}`);
  check("  ...the enrolment lookups are measured as load makes them (one per rostered student)",
    v1.tables.enrolmentLookups.rows === 30, JSON.stringify(v1.tables.enrolmentLookups));

  // Force a worsening: pretend last night everything was green.
  const row = d.tables.appState.find((x) => x.key === "readHeadroom");
  row.value = { ...row.value, readers: row.value.readers.map((x) => ({ ...x, band: "green" })) };
  const fake = load({ readHeadroomRules: (c) => c.replace("export const AMBER_PCT = 40;", "export const AMBER_PCT = 0.0001;") });
  const FQ = { ...QUERIES, "readHeadroom.recordResult": fake.headroom.recordResult };
  const fctx = { runQuery: async (ref, a) => (FQ[ref] || QUERIES[ref]).handler({ db: d.db }, a),
                 runMutation: async (ref, a) => FQ[ref].handler({ db: d.db }, a) };
  const r2 = await fake.headroom.nightly.handler(fctx, {});
  check("a worsened band with the switch OFF writes NO audit entry (teachers would see it)",
    r2.worsened.length > 0 && r2.audited === false && d.tables.appAuditLog.length === 0, JSON.stringify(r2).slice(0, 200));

  await H.configure.handler({ db: d.db }, { auditEntries: true });
  row.value = { ...row.value, readers: row.value.readers.map((x) => ({ ...x, band: "green" })) };
  const r3 = await fake.headroom.nightly.handler(fctx, {});
  const entry = d.tables.appAuditLog[0];
  check("with the switch ON, one audit entry, in the shape the feed renders",
    r3.audited === true && d.tables.appAuditLog.length === 1 && entry.payload.action === "read_headroom_warning" &&
    entry.payload.studentName === "All students" && /Server read headroom/.test(entry.payload.reason), JSON.stringify(entry).slice(0, 300));
  const r4 = await fake.headroom.nightly.handler(fctx, {});
  check("  ...and none the next night, when nothing got worse", r4.audited === false && d.tables.appAuditLog.length === 1);

  // A failed night keeps the last good bands for the next comparison.
  const good = d.tables.appState.find((x) => x.key === "readHeadroom").value;
  await H.recordResult.handler({ db: d.db }, { result: { ok: false, why: "test failure" } });
  const failed = d.tables.appState.find((x) => x.key === "readHeadroom").value;
  check("a failed night records why, and carries the last good bands forward",
    failed.ok === false && failed.why === "test failure" && failed.lastGood &&
    JSON.stringify(failed.lastGood.readers) === JSON.stringify(good.readers));
  const r5 = await fake.headroom.nightly.handler(fctx, {});
  check("  ...so the next good night is compared with the last good one, not with nothing",
    r5.worsened.length === 0, JSON.stringify(r5.worsened));
}

// ======================================================================
console.log("\n12. The list never offers a Reverse button the server will refuse");
{
  const offered = (out) => out.transactions.filter((t) => t.canReverse);
  // Two rows with one id, in one week.
  const row = cashRow(midweek(NOW - 2 * DAY), "10001");
  const plain = cashRow(midweek(NOW - 2 * DAY) + 3600000, "10001");
  const s = baseSeed(); s.legacyMirror.push(row, JSON.parse(JSON.stringify(row)), plain);
  let out = await M.reversal.reversibleFor.handler({ db: makeDb(s).db }, { studentId: "10001" });
  let dup = out.transactions.filter((t) => t.txnId === row.payload.id);
  check("both copies of a duplicated id are greyed as duplicate_txn_id, with the reason in words",
    dup.length === 2 && dup.every((t) => t.canReverse === false && t.code === "duplicate_txn_id" && /Two ledger rows/.test(t.why)),
    JSON.stringify(dup.map((t) => [t.canReverse, t.code])));
  check("  ...while the child's other row is still offered",
    offered(out).length === 1 && offered(out)[0].txnId === plain.payload.id);
  const d = makeDb(s);
  const r = await M.reversal.reverseAsAdmin.handler({ db: d.db }, { originalTxnId: row.payload.id, reason: "wrong child", actorName: "T" });
  check("  ...and the server refuses it with the same code the list shows", r.code === "duplicate_txn_id" && d.writes.length === 0);

  // A copy filed in an earlier week under ANOTHER child: still this id twice.
  const s2 = baseSeed();
  const mine = cashRow(midweek(NOW - 2 * DAY), "10001");
  const theirs = JSON.parse(JSON.stringify(mine));
  // A week before mine, always: midweek(NOW - 9 days) landed in mine's own
  // week whenever NOW was a Wednesday before noon UTC (Tue 17:00 to Wed 05:00
  // in Los Angeles), and the "another week" here was the same week.
  theirs.payload.studentId = "10002"; theirs.payload.timestamp = iso(Date.parse(mine.payload.timestamp) - 7 * DAY);
  theirs.doc = "cash_tx_" + W(theirs.payload.timestamp);
  s2.legacyMirror.push(mine, theirs);
  out = await M.reversal.reversibleFor.handler({ db: makeDb(s2).db }, { studentId: "10001" });
  dup = out.transactions.filter((t) => t.txnId === mine.payload.id);
  check("a copy of the id in another week, on another child, greys this child's row too",
    dup.length === 1 && dup[0].canReverse === false && dup[0].code === "duplicate_txn_id", JSON.stringify(dup));

  // Two students carrying one legacyId: every row greyed.
  const s3 = baseSeed();
  for (let i = 0; i < 4; i++) s3.legacyMirror.push(cashRow(midweek(NOW - 2 * DAY) + i * 60000, "10001"));
  s3.students.push(student(99, { legacyId: "10001", studentNumber: "99999" }));
  out = await M.reversal.reversibleFor.handler({ db: makeDb(s3).db }, { studentId: "10001" });
  check("two students with one legacyId: every row is greyed as student_ambiguous",
    out.transactions.length === 4 && out.studentName === null &&
    out.transactions.every((t) => t.canReverse === false && t.code === "student_ambiguous" && /Two student records/.test(t.why)),
    JSON.stringify(out.transactions.map((t) => [t.canReverse, t.code])));
  const d3 = makeDb(s3);
  const r3 = await M.reversal.reverseAsAdmin.handler({ db: d3.db }, { originalTxnId: out.transactions[0].txnId, reason: "wrong child", actorName: "T" });
  check("  ...and the server refuses it with the same code", r3.code === "student_ambiguous" && d3.writes.length === 0);

  // No student at all behind the id.
  const s4 = baseSeed(); s4.legacyMirror.push(cashRow(midweek(NOW - 2 * DAY), "NOBODY-1"));
  out = await M.reversal.reversibleFor.handler({ db: makeDb(s4).db }, { studentId: "NOBODY-1" });
  check("a student id that names no student: greyed as student_not_found",
    out.transactions.length === 1 && out.transactions[0].canReverse === false && out.transactions[0].code === "student_not_found",
    JSON.stringify(out.transactions));
  const d4 = makeDb(s4);
  const r4 = await M.reversal.reverseAsAdmin.handler({ db: d4.db }, { originalTxnId: out.transactions[0].txnId, reason: "wrong child", actorName: "T" });
  check("  ...and the server refuses it with the same code", r4.code === "student_not_found" && d4.writes.length === 0);

  // Precedence: a row already reversed keeps saying so, duplicate or not.
  const s5 = baseSeed(); const rv = cashRow(midweek(NOW - 2 * DAY), "10001");
  s5.legacyMirror.push(rv, JSON.parse(JSON.stringify(rv)));
  s5.cashReversals.push({ originalTxnId: rv.payload.id, reversalTxnId: "txn_rev_x", reversedAt: "x", reversedBy: "A", reason: "r" });
  out = await M.reversal.reversibleFor.handler({ db: makeDb(s5).db }, { studentId: "10001" });
  check("  ...and a row already reversed still reads already_reversed",
    out.transactions.filter((t) => t.txnId === rv.payload.id).every((t) => t.code === "already_reversed" && t.reversal));
}

// ======================================================================
console.log("\n13. A second copy in any planned week is seen before anything moves");
{
  // The id's own week holds this child's row; the week a hint names holds a
  // copy filed under another child.
  const mine = cashRow(midweek(NOW - 2 * DAY), "10001");
  const theirs = JSON.parse(JSON.stringify(mine));
  // A week before mine, always: midweek(NOW - 9 days) landed in mine's own
  // week whenever NOW was a Wednesday before noon UTC (Tue 17:00 to Wed 05:00
  // in Los Angeles), and the "another week" here was the same week.
  theirs.payload.studentId = "10002"; theirs.payload.timestamp = iso(Date.parse(mine.payload.timestamp) - 7 * DAY);
  theirs.doc = "cash_tx_" + W(theirs.payload.timestamp);
  const s = baseSeed(); s.legacyMirror.push(mine, theirs);
  const d = makeDb(s);
  const hint = W(theirs.payload.timestamp);
  const r = await M.reversal.reverseAsAdmin.handler({ db: d.db }, { originalTxnId: mine.payload.id, reason: "wrong child", actorName: "T", weekHint: hint });
  check("a weekHint naming another copy's week is refused as duplicate_txn_id, naming both weeks",
    r.ok === false && r.code === "duplicate_txn_id" && r.reason.includes(hint) && r.reason.includes(W(mine.payload.timestamp)),
    JSON.stringify(r));
  check("  ...and nothing moved: no register row, no ledger row, neither child's counters",
    d.writes.length === 0 && d.tables.students.filter((x) => x.legacyId === "10001" || x.legacyId === "10002")
      .every((x) => x.wildcatCashBalance === 1000 && x.wildcatCashEarned === 1000), JSON.stringify(d.writes));
  check("  ...having read both planned weeks, and no others",
    JSON.stringify(weeksRead(d.log).sort()) === JSON.stringify(["cash_tx_" + hint, mine.doc].sort()), weeksRead(d.log).join(","));

  // Control: the right hint, with no second copy, still reverses in one read.
  const s2 = baseSeed(); s2.legacyMirror.push(mine);
  const d2 = makeDb(s2);
  const r2 = await M.reversal.reverseAsAdmin.handler({ db: d2.db }, { originalTxnId: mine.payload.id, reason: "wrong child", actorName: "T", weekHint: W(mine.payload.timestamp) });
  check("  ...while the right hint with one copy still reverses, reading one week",
    r2.ok === true && weeksRead(d2.log).length === 1, JSON.stringify(r2).slice(0, 160));
}

// ======================================================================
console.log("\n14. The headroom check projects the list's stop where readWeeksWithinBudget really stops");
{
  const R = M.headroomRules;
  const MiB = 1048576;
  // The constants the projection mirrors are the ones the list runs on.
  const rev = SRC.cashReversal;
  check("its window, budget and per-row ceiling equal cashReversal.ts's",
    new RegExp(`const MAX_WEEK_DOCS = ${R.LIST_WEEKS};`).test(rev) &&
    new RegExp(`const LIST_BYTE_BUDGET = ${R.LIST_BUDGET_MIB} \\* 1048576;`).test(rev) &&
    new RegExp(`const ROW_BYTES_CEILING = ${R.LIST_ROW_BYTES_CEILING};`).test(rev));
  // 2026-10-05's cash weeks (rows, JSON bytes), newest first.
  const real = [["2026_W41", 286, 0.16], ["2026_W40", 2286, 1.284], ["2026_W39", 1855, 1.044], ["2026_W38", 2527, 1.414]]
    .map(([week, rows, mib]) => ({ week, rows, bytes: Math.round(mib * MiB) }));
  const measure = {
    nowIso: "2026-10-05T20:00:00.000Z", cutoffIso: "2026-09-14T15:30:00.000Z",
    students: { rows: 763, bytes: 3.462 * MiB, cashCopyBytes: 2.711 * MiB, largestRowBytes: 25000, rosterLookupBytes: 0.325 * MiB, rosterLookupHits: 607 },
    psRoster: { rows: 5463, bytes: 2.94 * MiB }, teachers: { rows: 63, bytes: 0.014 * MiB }, loadSettingsBytes: 20000,
    mirror: { rows: 6954, bytes: 3.902 * MiB, docs: real.map((w) => ({ doc: "cash_tx_" + w.week, rows: w.rows, bytes: w.bytes })) },
  };
  const list = R.estimateReaders(measure).find((r) => r.name === "cashReversal:reversibleForStudent");
  // The real stopping rule, run over today's weeks plus k more school weeks of
  // 2,215 rows at the measured 588 bytes, until it first leaves a week out.
  const runList = async (weeks) => M.rules.readWeeksWithinBudget({
    weeks: weeks.map((w) => w.week),
    read: async (week, maxRows) => {
      const w = weeks.find((x) => x.week === week);
      const per = w.bytes / Math.max(1, w.rows);
      return Array.from({ length: Math.min(w.rows, maxRows) }, () => per);
    },
    sizeOf: (b) => b, keep: () => false,
    byteBudget: R.LIST_BUDGET_MIB * MiB, rowBytesCeiling: R.LIST_ROW_BYTES_CEILING,
  });
  let k = 0, lastComplete = null, firstShort = null;
  for (; k < 14; k++) {
    const extra = Array.from({ length: k }, (_, i) => ({ week: `2026_X${String(k - i).padStart(2, "0")}`, rows: 2215, bytes: 2215 * 588 }));
    const weeks = [...extra, ...real];
    const est = (weeks.reduce((a, w) => a + w.bytes, 0) + measure.students.largestRowBytes) / MiB;
    const got = await runList(weeks);
    if (got.stoppedAt === null) lastComplete = est; else { firstShort = est; break; }
  }
  check("the list really stops below 12 MiB (between " + (lastComplete ?? 0).toFixed(2) + " and " + (firstShort ?? 0).toFixed(2) + " MiB)",
    firstShort !== null && firstShort < R.LIST_BUDGET_MIB, String(firstShort));
  check("  ...and degradesAtMiB lands in that gap, not at 12",
    typeof list.degradesAtMiB === "number" && list.degradesAtMiB > lastComplete && list.degradesAtMiB <= firstShort,
    `${list.degradesAtMiB} vs (${lastComplete}, ${firstShort}]`);
  const dates = R.projectDates([list], measure.nowIso)[list.name];
  const at12 = new Date(Date.parse(measure.nowIso) + ((12 - list.estMiB) / list.growthMiBPerWeek) * 7 * DAY).toISOString().slice(0, 10);
  check("  ...so the projected limit date comes before a 12 MiB line's (" + dates.limit + " vs " + at12 + ")",
    typeof dates.limit === "string" && dates.limit < at12, JSON.stringify(dates));
  check("listRoomBytes is negative once a week is already left out",
    R.listRoomBytes([{ rows: 9000, bytes: 9 * MiB }, { rows: 3000, bytes: 1.7 * MiB }]) < 0);
}

// ======================================================================
// Shared by 15 and 16: the nightly check against an in-memory database.
function nightlyRig(d, mod) {
  const H = mod.headroom;
  const Q = { "readHeadroom.studentsPage": H.studentsPage, "readHeadroom.rosterPage": H.rosterPage,
              "readHeadroom.mirrorPage": H.mirrorPage, "readHeadroom.smallReads": H.smallReads,
                    "readHeadroom.trendsContextReads": H.trendsContextReads,
              "readHeadroom.recordResult": H.recordResult };
  return {
    H, Q,
    ctx: {
      runQuery: async (ref, args) => Q[ref].handler({ db: d.db }, args),
      runMutation: async (ref, args) => Q[ref].handler({ db: d.db }, args),
    },
  };
}
function headroomSeed() {
  const s = baseSeed();
  s.psRoster = s.students.slice(0, 30).map((st) => ({ studentNumber: st.studentNumber, sectionId: "x" }));
  s.teachers = [{ name: "T" }];
  s.appState.push({ key: "liveSettings", value: { a: 1 }, mirroredAt: "x" });
  // What cashInsights:trendsContext reads (2026-10-06), big enough to register
  // as a reader at all: "every reader turns amber" below includes it.
  s.attendanceRunDays = Array.from({ length: 40 }, (_, i) => ({ yearid: 36, date: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
    band: i % 2 ? "6-8" : "9-12", members: 300, absentDays: 20, fullDaysStrict: 5, misrecordDaysByGap: [0, 0, 0],
    partialDays: 15, assumedPresentDays: 0, gradeEstimated: false, syncedAt: "2026-10-01T10:15:00.000Z" }));
  s.psAttendanceMarks = Array.from({ length: 30 }, (_, i) => ({ studentNumber: String(9000 + i),
    absentDates: Array.from({ length: 20 }, (_, j) => `2026-09-${String(j + 1).padStart(2, "0")}`), syncedAt: "2026-10-01T13:30:00.000Z" }));
  return s;
}

console.log("\n15. A band that worsened while the alert was off is announced once it is on");
{
  const d = makeDb(headroomSeed());
  const real = nightlyRig(d, M);
  // Every reader turns amber under these bands: a stand-in for real growth.
  const grown = nightlyRig(d, load({ readHeadroomRules: (c) => c.replace("export const AMBER_PCT = 40;", "export const AMBER_PCT = 0.0001;") }));
  const n1 = await real.H.nightly.handler(real.ctx, {});
  const v1 = d.tables.appState.find((x) => x.key === "readHeadroom").value;
  check("night 1 (off): a baseline, every reader green", n1.recorded && v1.readers.every((r) => r.band === "green"));
  const n2 = await grown.H.nightly.handler(grown.ctx, {});
  check("night 2 (off): green to amber is seen, and nothing is written",
    n2.worsened.length === v1.readers.length && n2.audited === false && d.tables.appAuditLog.length === 0, JSON.stringify(n2).slice(0, 200));
  const n2b = await grown.H.nightly.handler(grown.ctx, {});
  check("night 3 (off): still unannounced, still nothing written",
    n2b.worsened.length === v1.readers.length && n2b.audited === false && d.tables.appAuditLog.length === 0);
  await real.H.configure.handler({ db: d.db }, { auditEntries: true });
  const n3 = await grown.H.nightly.handler(grown.ctx, {});
  const entry = d.tables.appAuditLog[0];
  check("night 4 (switched on, no change since): the change made while it was off is announced",
    n3.audited === true && d.tables.appAuditLog.length === 1 && /appData:load is now amber/.test(entry.payload.details) &&
    /was green/.test(entry.payload.details), JSON.stringify(n3).slice(0, 200));
  const n4 = await grown.H.nightly.handler(grown.ctx, {});
  check("  ...once, not nightly", n4.audited === false && n4.worsened.length === 0 && d.tables.appAuditLog.length === 1);
  // Better, then worse again, while on: news again.
  await real.H.nightly.handler(real.ctx, {});
  const n5 = await grown.H.nightly.handler(grown.ctx, {});
  check("  ...and after a return to green, amber again is news again", n5.audited === true && d.tables.appAuditLog.length === 2);
  // The pure rule, alone.
  const R = M.headroomRules;
  const b = (o) => ({ readers: Object.entries(o).map(([name, band]) => ({ name, band })) });
  check("announcedBands: off, a band moves down never up; a new reader starts at amber; on, it follows",
    JSON.stringify(R.announcedBands(b({ a: "green", b: "red" }), b({ a: "amber", b: "amber", c: "red", e: "green" }), false)) ===
      JSON.stringify({ a: "green", b: "amber", c: "amber", e: "green" }) &&
    JSON.stringify(R.announcedBands(b({ a: "green" }), b({ a: "red" }), true)) === JSON.stringify({ a: "red" }));
}

console.log("\n16. A night whose read throws is recorded as failed, and latest says how old it is");
{
  const d = makeDb(headroomSeed());
  const rig = nightlyRig(d, M);
  await rig.H.nightly.handler(rig.ctx, {});
  const good = d.tables.appState.find((x) => x.key === "readHeadroom").value;
  const broken = { ...rig.ctx, runQuery: async (ref, args) => {
    if (ref === "readHeadroom.mirrorPage") throw new Error("Too many bytes read in a single function execution");
    return rig.ctx.runQuery(ref, args);
  } };
  let threw = null, res = null;
  try { res = await rig.H.nightly.handler(broken, {}); } catch (e) { threw = e; }
  const after = d.tables.appState.find((x) => x.key === "readHeadroom").value;
  check("a page query that throws is recorded as ok:false with the error, not left as last night",
    threw === null && res && res.recorded === true && after.ok === false && /threw: Too many bytes/.test(after.why),
    threw ? String(threw) : JSON.stringify(after).slice(0, 200));
  check("  ...and the last good bands are carried forward",
    after.lastGood && JSON.stringify(after.lastGood.readers) === JSON.stringify(good.readers));
  const fresh = await rig.H.latest.handler({ db: d.db }, {});
  check("latest gives the row's age and is not stale tonight",
    fresh.found && typeof fresh.ageHours === "number" && fresh.ageHours < 1 && fresh.stale === false, JSON.stringify({ a: fresh.ageHours, s: fresh.stale }));
  after.recordedAt = new Date(NOW - 3 * DAY).toISOString();
  const old = await rig.H.latest.handler({ db: d.db }, {});
  check("  ...and says stale when the last record is three days old", old.stale === true && old.ageHours >= 71, JSON.stringify({ a: old.ageHours, s: old.stale }));
}

// ======================================================================
console.log("\n17. appData:load's enrolment lookups across several batches");
{
  // 130 students, three batches of 50; enrolment mixed and in no order.
  const studs = Array.from({ length: 130 }, (_, k) => student(k + 1, k % 11 === 0 ? { studentNumber: "" } : {}));
  const enrolledNums = studs.filter((x, k) => x.studentNumber && ((k * 7) % 5 === 1 || k % 13 === 2 || k > 118)).map((x) => x.studentNumber);
  const roster = [];
  for (const n of enrolledNums.slice().reverse()) for (let i = 0; i < 3; i++) roster.push({ studentNumber: n, sectionId: `s${i}` });
  const s = { students: studs, teachers: [], appState: [], psRoster: roster };
  const nums = new Set(roster.map((r) => r.studentNumber));
  const truth = studs.map((r) => Boolean(r.studentNumber && nums.has(r.studentNumber)));
  const out = await M.appData.load.handler({ db: makeDb(s).db }, {});
  check("every one of 130 flags equals the whole-roster method's, in every batch",
    truth.filter(Boolean).length > 20 && truth.filter((x) => !x).length > 20 &&
    JSON.stringify(out.students.map((x) => x.enrolled)) === JSON.stringify(truth),
    `${out.students.filter((x) => x.enrolled).length} vs ${truth.filter(Boolean).length}`);
  const broken = load({ appData: (c) => c.replace("out[i + j] = Boolean(hit);", "out[j] = Boolean(hit);") });
  const out2 = await broken.appData.load.handler({ db: makeDb(s).db }, {});
  check("(teeth) writing each batch over the first 50 is caught",
    JSON.stringify(out2.students.map((x) => x.enrolled)) !== JSON.stringify(truth));
}

// ======================================================================
console.log("\n18. reverseRefund refuses every read that was cut off, and deletes nothing");
{
  const refundAt = midweek(NOW - 2 * DAY);
  const refundId = `txn_refund_${refundAt}_abc`;
  const refundRow = { id: refundId, timestamp: iso(refundAt), studentId: "10001", amount: 50, kind: "award",
    behaviorId: "reward-refund:WC-TEST", behaviorName: "Refund" };
  const week = W(refundRow.timestamp);
  const seedWith = ({ weekFiller = 0, reversals = 0, receipts = 0 } = {}) => {
    const s = baseSeed();
    s.students[0].wildcatCashTransactions = [
      { id: "txn_a", timestamp: iso(refundAt - DAY), studentId: "10001", amount: 1000, kind: "award" }, refundRow];
    s.students[0].wildcatCashBalance = 1050; s.students[0].wildcatCashEarned = 1050;
    s.legacyMirror = [];
    for (let i = 0; i < weekFiller; i++) s.legacyMirror.push({ doc: "cash_tx_" + week, collection: "transactions", payload: { id: `f${i}`, studentId: "1", amount: 1 } });
    // The refund's own ledger row comes LAST, past any cap.
    s.legacyMirror.push({ doc: "cash_tx_" + week, collection: "transactions", payload: refundRow });
    for (let i = 0; i < receipts; i++) s.legacyMirror.push({ doc: "secondary", collection: "cashReceipts", payload: { id: `r${i}`, refundTxId: null } });
    s.cashReversals = Array.from({ length: reversals }, (_, i) => ({ originalTxnId: `o${i}`, reversalTxnId: `v${i}`, counterDelta: null }));
    return s;
  };
  const run = async (mod, seed) => {
    const d = makeDb(seed);
    const r = await mod.req("./legacyPurge").reverseRefund.handler({ db: d.db }, { txId: refundId, studentId: "10001", apply: true });
    return { r, d };
  };
  const control = await run(M, seedWith());
  check("control: with every read whole, the refund is withdrawn (one delete, one patch)",
    control.r.ok === true && control.d.writes.some((w) => w.op === "delete"), JSON.stringify(control.r).slice(0, 200));
  const cases = [
    ["a week of 4,001 rows, the refund's row past the 4,000th", { weekFiller: 4000 },
      "if (!ledgerRow && weekTruncated) {"],
    ["2,001 reversals on record", { reversals: 2001 },
      "if (revRead.length > REVERSAL_CAP) {"],
    ["2,001 receipts, the one that names the refund unseen", { receipts: 2001 },
      "if (!receiptRow && receiptRead.length > RECEIPT_CAP) {"],
  ];
  for (const [label, opts, guard] of cases) {
    const { r, d } = await run(M, seedWith(opts));
    check(`${label}: refused, truncated, and nothing deleted or patched`,
      r.ok === false && r.refused === true && r.truncated === true && d.writes.length === 0, JSON.stringify(r).slice(0, 200));
    const unguarded = load({ legacyPurge: (c) => { if (!c.includes(guard)) throw new Error("guard not found: " + guard); return c.replace(guard, "if (false) {"); } });
    const bad = await run(unguarded, seedWith(opts));
    check(`  (teeth) without that guard the same call no longer refuses as truncated`,
      !(bad.r.ok === false && bad.r.truncated === true && bad.d.writes.length === 0), JSON.stringify(bad.r).slice(0, 120));
  }
}

// ======================================================================
console.log("\n19. The recount's and the diagnostics' capped reads refuse to conclude");
{
  const at = midweek(NOW - 2 * DAY);
  const week = W(iso(at));
  const sinceIso = iso(at - DAY);
  const mine = { id: `txn_${at}_m`, timestamp: iso(at), studentId: "10001", amount: 100, kind: "award", behaviorName: "Be Present", behaviorId: "be" };
  const seed = ({ weekFiller = 0, auditFiller = 0 } = {}) => {
    const s = baseSeed();
    s.legacyMirror = [];
    for (let i = 0; i < weekFiller; i++) s.legacyMirror.push({ doc: "cash_tx_" + week, collection: "transactions", payload: { id: `f${i}`, studentId: "1", amount: 1, timestamp: iso(at - 1000) } });
    s.legacyMirror.push({ doc: "cash_tx_" + week, collection: "transactions", payload: mine });
    // The audit entry for the child's row: present in the ledger, so NOT missing.
    s.appAuditLog = [];
    for (let i = 0; i < auditFiller; i++) s.appAuditLog.push({ entryId: `a${i}`, timestamp: iso(at - 3600000 + i), payload: { action: "note", timestamp: iso(at - 3600000 + i) } });
    s.appAuditLog.push({ entryId: "a_mine", timestamp: iso(at), payload: { action: "cash_award", studentId: "10001", ticketCount: 100, timestamp: iso(at), behavior: "Be Present" } });
    return s;
  };
  const ewp = (mod) => mod.req("./earlyWarningProfile");
  const args = { weeks: [week], studentIds: ["10001"], sinceIso };

  const ctl = await ewp(M).missingLedgerRows.handler({ db: makeDb(seed()).db }, args);
  check("control: missingLedgerRows with whole reads finds the row present, proposes nothing",
    Array.isArray(ctl.missing) && ctl.missing.length === 0 && !ctl.truncated, JSON.stringify(ctl).slice(0, 160));

  const cut = await ewp(M).missingLedgerRows.handler({ db: makeDb(seed({ weekFiller: 3000 })).db }, args);
  check("a week of 3,001 rows: truncated, refused, and no `missing` to restore",
    cut.truncated === true && cut.truncatedWeeks[0] === week && typeof cut.refused === "string" && cut.missing === undefined,
    JSON.stringify(cut).slice(0, 200));
  for (const [label, edit] of [
    ["the week read capped at exactly 3,000 again", (c) => c.replace("take(DIAG_WEEK_CAP + 1)", "take(DIAG_WEEK_CAP)")],
    ["missingLedgerRows' refusal removed", (c) => c.replace(
      "    if (truncatedWeeks.length || auditTruncated) {\n      return refusedAsTruncated(truncatedWeeks, auditTruncated, sinceIso);\n    }\n    const missing: any[] = [];",
      "    const missing: any[] = [];")],
  ]) {
    const mod = load({ earlyWarningProfile: (c) => { const e = edit(c); if (e === c) throw new Error("edit did not apply: " + label); return e; } });
    const r = await ewp(mod).missingLedgerRows.handler({ db: makeDb(seed({ weekFiller: 3000 })).db }, args);
    check(`  (teeth) ${label}: the child's row is proposed as missing -- a second restore`,
      r.truncated !== true && Array.isArray(r.missing) && r.missing.length === 1, JSON.stringify(r).slice(0, 160));
  }

  const cutA = await ewp(M).missingLedgerRows.handler({ db: makeDb(seed({ auditFiller: 4000 })).db }, args);
  check("4,001 audit entries since sinceIso: truncated (auditTruncated), refused, no verdicts",
    cutA.truncated === true && cutA.auditTruncated === true && cutA.missing === undefined, JSON.stringify(cutA).slice(0, 200));
  const vsA = await ewp(M).auditVsLedger.handler({ db: makeDb(seed({ auditFiller: 4000 })).db }, args);
  check("  ...and auditVsLedger refuses the same way", vsA.truncated === true && vsA.auditTruncated === true, JSON.stringify(vsA).slice(0, 160));
  const auditTeeth = load({ earlyWarningProfile: (c) => c.replace("take(DIAG_AUDIT_CAP + 1)", "take(DIAG_AUDIT_CAP)") });
  const rA = await ewp(auditTeeth).missingLedgerRows.handler({ db: makeDb(seed({ auditFiller: 4000 })).db }, args);
  check("  (teeth) with the audit read capped at exactly 4,000 again, it answers instead of refusing",
    rA.truncated !== true && Array.isArray(rA.missing));

  const rec = M.req("./cashRecount");
  const rfs = await rec.rowsForStudents.handler({ db: makeDb(seed({ weekFiller: 4000 })).db }, { studentIds: ["10001"], doc: "cash_tx_" + week });
  check("rowsForStudents over a week of 4,001 rows: truncated, with the warning, and the child's row unread",
    rfs.truncated === true && /Do not conclude anything from an absence/.test(rfs.warning) && rfs.rows.length === 0 && rfs.slicesRead === 4000,
    JSON.stringify(rfs).slice(0, 200));
  const rfsOk = await rec.rowsForStudents.handler({ db: makeDb(seed()).db }, { studentIds: ["10001"], doc: "cash_tx_" + week });
  check("  ...and whole when the week fits", !rfsOk.truncated && rfsOk.rows.length === 1);
  const recTeeth = load({ cashRecount: (c) => c.replace("    if (truncated) {\n      return {\n        rows: out, slicesRead: slices.length,", "    if (false) {\n      return {\n        rows: out, slicesRead: slices.length,") });
  const rfsBad = await recTeeth.req("./cashRecount").rowsForStudents.handler({ db: makeDb(seed({ weekFiller: 4000 })).db }, { studentIds: ["10001"], doc: "cash_tx_" + week });
  check("  (teeth) with its truncated return disabled, the cut is silent again", rfsBad.truncated !== true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
