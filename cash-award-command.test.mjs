// A Wildcat Cash award as ONE server command. Run: npm test
//
// WHY IT EXISTS, 2026-09-23. Until today an award reached the server as three
// separate browser writes seconds apart: a balance delta the tab worked out
// from its own copy, a ledger row, and an audit entry. That afternoon a stale
// tab put 76 repaired students back at their old balances within five minutes,
// and another paid 27 students' repayments twice. The owner's standard: "A
// stale tab should never dictate the information 40+ users see."
//
// THE DESIGN THESE TESTS HOLD IT TO. The command moves money from the server's
// own numbers and writes the ledger row, the child's copy and the audit entry
// in one transaction. The OLD path still runs beside it, carrying the SAME
// receipt, so there is no fallback to get wrong -- which means the single most
// important property here is that the two paths can never both pay. That is
// tested by running the REAL appData:save planner after the REAL command, in
// both orders, and requiring the money to move exactly once.
//
// NOTHING IS COPIED. Every module below is the shipped source, transpiled and
// wired together through a tiny require shim, and run against an in-memory
// database. The load-bearing assertions are proved to have teeth by
// re-breaking the shipped code.
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
};

// ---------------------------------------------------------------- the loader
// Each module is transpiled to CommonJS and evaluated with a require shim, so
// modules keep their own scopes exactly as they do in Convex.
function load(overrides) {
  const o = overrides || {};
  const cache = {};
  let me = { _id: "t1", legacyId: "T034", name: "Rosa Lopez", email: "rosal@lapromisefund.org", role: "teacher" };
  const stubs = {
    "./_generated/server": {
      mutation: (d) => d, query: (d) => d, internalMutation: (d) => d, internalQuery: (d) => d,
    },
    "convex/values": { v: new Proxy({}, { get: () => (...a) => ({ _v: true, a }) }) },
    "./identity": { requireStaff: async () => me },
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
    rules: req("./cashAwardRules"),
    award: req("./cashAward"),
    weeks: req("./cashReversalRules"),
  };
  mods.setMe = (m) => { me = m; };
  return mods;
}

// ------------------------------------------------------- the fake database
const INDEXES = {
  appState: { by_key: ["key"] },
  students: { by_legacyId: ["legacyId"], by_studentNumber: ["studentNumber"] },
  cashAwardCommands: { by_txnId: ["txnId"], by_recordedAt: ["recordedAt"] },
  appAuditLog: { by_entryId: ["entryId"] },
};
function makeDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed || {}));
  let n = 0;
  // Every row has a creation time, as in Convex; a seed row without one was
  // created "just now", which is what the ledger-race tests need by default.
  for (const t of Object.keys(tables)) tables[t].forEach((r) => {
    if (!r._id) r._id = `${t}:${n++}`;
    if (r._creationTime === undefined) r._creationTime = Date.now();
  });
  const reads = { collect: 0, take: 0, first: 0, byTable: {}, ranges: [] };
  const q = (name) => {
    let rows = (tables[name] || []).slice();
    let desc = false;
    const api = {
      withIndex(idx, fn) {
        if (fn) {
          const eqs = {}, lows = {};
          const chain = {
            eq: (c, v) => { eqs[c] = v; return chain; },
            gte: (c, v) => { lows[c] = v; reads.ranges.push({ table: name, idx, field: c, from: v }); return chain; },
          };
          fn(chain);
          rows = rows.filter((r) => Object.entries(eqs).every(([c, v]) => r[c] === v)
            && Object.entries(lows).every(([c, v]) => r[c] >= v));
        }
        return api;
      },
      order(dir) { desc = dir === "desc"; return api; },
      async first() { reads.first++; return (desc ? rows.slice().reverse() : rows)[0] ?? null; },
      async take(k) {
        reads.take++; reads.byTable[name] = (reads.byTable[name] || 0) + 1;
        return (desc ? rows.slice().reverse() : rows).slice(0, k);
      },
      async collect() { reads.collect++; return rows.slice(); },
    };
    return api;
  };
  return {
    tables, reads,
    db: {
      query: q,
      async get(id) { for (const t of Object.values(tables)) { const r = t.find((x) => x._id === id); if (r) return r; } return null; },
      async insert(name, doc) { tables[name] = tables[name] || []; const row = { ...doc, _id: `${name}:new${n++}`, _creationTime: Date.now() }; tables[name].push(row); return row._id; },
      async patch(id, fields) { for (const t of Object.values(tables)) { const r = t.find((x) => x._id === id); if (r) Object.assign(r, fields); } },
    },
  };
}

const NOW = Date.now();
const AT = new Date(NOW - 60_000).toISOString();
const txn = (k) => `txn_${String(NOW - 60_000 + k).padStart(13, "0")}_abc${k}`;

function seed(extra) {
  return Object.assign({
    appState: [{ key: "cashAwardCommand", value: { enabled: true, pilotEmails: [] }, mirroredAt: "x" },
               { key: "historyCutoff", value: { iso: "2026-09-14T15:30:00.000Z" }, mirroredAt: "x" }],
    students: [
      { _id: "s1", legacyId: "12101", studentNumber: "12101", firstName: "Jesus", lastName: "Cruz", grade: "9",
        wildcatCashBalance: 900, wildcatCashEarned: 900, wildcatCashSpent: 0, wildcatCashDeducted: 0,
        wildcatCashTransactions: [], cashApplied: null },
      { _id: "s2", legacyId: "11645", studentNumber: "11645", firstName: "Ace", lastName: "Araiza", grade: "7",
        wildcatCashBalance: 0, wildcatCashEarned: 0, wildcatCashSpent: 0, wildcatCashDeducted: 0,
        wildcatCashTransactions: [], cashApplied: null },
    ],
    cashAwardCommands: [], appAuditLog: [], legacyMirror: [],
  }, extra || {});
}

const award = (k, over) => Object.assign({
  studentId: "12101", txnId: txn(k), at: AT, amount: 100, kind: "award",
  behaviorId: "wc1", behaviorName: "Be Present", notes: "Helped a classmate",
}, over || {});

const M = load();
const run = (dbw, awards, args) => M.award.award.handler({ db: dbw.db }, Object.assign({ awards, week: 4, cycle: 2 }, args || {}));
const stu = (dbw, id) => dbw.tables.students.find((s) => s.legacyId === id);

console.log("\nTHE SWITCH\n");
{
  const off = makeDb(seed({ appState: [] }));
  const r = await run(off, [award(1)]);
  check("absent switch means OFF", r.ok === false && r.code === "disabled");
  check("...and nothing moved or was written",
    stu(off, "12101").wildcatCashBalance === 900 && off.tables.legacyMirror.length === 0 &&
    off.tables.appAuditLog.length === 0 && off.tables.cashAwardCommands.length === 0);

  const explicitOff = makeDb(seed({ appState: [{ key: "cashAwardCommand", value: { enabled: false }, mirroredAt: "x" }] }));
  check("an explicit off is off", (await run(explicitOff, [award(1)])).code === "disabled");

  const pilot = makeDb(seed({ appState: [{ key: "cashAwardCommand", value: { enabled: true, pilotEmails: ["someone@else.org"] }, mirroredAt: "x" }] }));
  check("a pilot list that does not name the caller is off for them",
    (await run(pilot, [award(1)])).code === "disabled");
  const named = makeDb(seed({ appState: [{ key: "cashAwardCommand", value: { enabled: true, pilotEmails: ["ROSAL@lapromisefund.org"] }, mirroredAt: "x" }] }));
  check("...and on for someone it names, whatever the case",
    (await run(named, [award(1)])).ok === true);
}

console.log("\nONE AWARD, EVERYTHING IN ONE TRANSACTION\n");
{
  const d = makeDb(seed());
  const r = await run(d, [award(1)]);
  const res = r.results[0];
  const s = stu(d, "12101");
  check("it applies", r.ok === true && res.status === "applied" && res.wroteRecords === true);
  check("the counters move from the SERVER'S numbers", s.wildcatCashBalance === 1000 && s.wildcatCashEarned === 1000);
  check("...and the answer carries the new balance", res.balanceAfter === 1000);
  check("the receipt joins cashApplied, which is what appData:save checks",
    (s.cashApplied?.ids || []).some((e) => e.i === txn(1)));
  check("...dated by the award's own time, so the watermark means one thing on both paths",
    (s.cashApplied?.ids || []).find((e) => e.i === txn(1))?.at === AT);
  check("the child's own copy of the row is appended",
    s.wildcatCashTransactions.length === 1 && s.wildcatCashTransactions[0].id === txn(1));

  const led = d.tables.legacyMirror;
  check("one ledger row is inserted", led.length === 1);
  check("...into the week its own timestamp belongs to",
    led[0].doc === "cash_tx_" + M.weeks.cashWeekKey(AT) && led[0].collection === "transactions",
    `${led[0].doc} vs cash_tx_${M.weeks.cashWeekKey(AT)}`);
  check("...WITHOUT a key, which would empty every client's ledger", !("key" in led[0]));

  const row = led[0].payload;
  for (const f of ["id", "timestamp", "studentId", "studentName", "studentGrade", "school", "teacherId",
                   "teacherUsername", "teacherName", "kind", "type", "behaviorId", "behaviorName",
                   "amount", "notes", "balanceAfter"]) {
    check(`the ledger row carries ${f}, as recordCashTransaction writes it`, f in row, JSON.stringify(Object.keys(row)));
  }
  check("the teacher is the TOKEN's, not anything the browser said",
    row.teacherId === "T034" && row.teacherName === "Rosa Lopez");
  check("type follows the sign", row.type === "positive");

  const au = d.tables.appAuditLog;
  check("one audit entry is written", au.length === 1);
  check("...under the id derived from the receipt, which the browser derives too",
    au[0].entryId === "a_" + txn(1) && au[0].payload.entryId === "a_" + txn(1));
  check("...with the money in ticketCount, where eleven readers look for it",
    au[0].payload.ticketCount === 100 && au[0].payload.action === "cash_award" && au[0].payload.category === "Wildcat Cash");
  check("...linked to its ledger row by txId, a link these entries never had", au[0].payload.txId === txn(1));
  check("...carrying week and cycle, so the this-week audit view shows it",
    au[0].payload.week === 4 && au[0].payload.cycle === 2);

  check("the receipt is registered", d.tables.cashAwardCommands.length === 1 &&
    d.tables.cashAwardCommands[0].status === "applied" && d.tables.cashAwardCommands[0].wroteRecords === true);
}

console.log("\nA RETRY, A DOUBLE TAP, A LOST RESPONSE\n");
{
  const d = makeDb(seed());
  await run(d, [award(1)]);
  const again = await run(d, [award(1)]);
  check("the same receipt twice moves the money ONCE", stu(d, "12101").wildcatCashBalance === 1000);
  check("...and says it was already applied, with its records", again.results[0].status === "alreadyApplied" &&
    again.results[0].wroteRecords === true);
  check("...and writes no second ledger row, audit entry or register row",
    d.tables.legacyMirror.length === 1 && d.tables.appAuditLog.length === 1 && d.tables.cashAwardCommands.length === 1);
  const dup = await run(makeDb(seed()), [award(1), award(1)]);
  check("the same receipt twice in ONE call is refused the second time",
    dup.results[0].status === "applied" && dup.results[1].code === "duplicate_in_call");
}

console.log("\nTHE TWO PATHS CAN NEVER BOTH PAY\n");
// This is the property the whole design rests on, run through the REAL
// appData:save planner rather than described.
{
  const planSave = M.shape.planSave;
  const WRITABLE = M.shape.STUDENT_WRITABLE;
  const keysOf = (r) => [r.legacyId, r.studentNumber];
  const effect = M.shape.cashMovementEffect(100, "award");
  const cashDelta = {};
  for (const [f, val] of Object.entries(effect)) if (val) cashDelta[f] = val;
  const saveRecord = (k) => ({ id: "12101", cashDelta, cashMovements: [{ id: txn(k), at: AT, amount: 100, kind: "award" }] });
  const applySave = (d, record) => {
    const plan = planSave(d.tables.students, [record], WRITABLE, keysOf, null);
    for (const { rowId, patch } of plan.patches) {
      const r = d.tables.students.find((x) => x._id === rowId); Object.assign(r, patch);
    }
    return plan;
  };

  // COMMAND FIRST, then the ordinary save a second later -- the normal order.
  const d1 = makeDb(seed());
  await run(d1, [award(1)]);
  const plan1 = applySave(d1, saveRecord(1));
  check("COMMAND THEN SAVE: the money moves exactly once",
    stu(d1, "12101").wildcatCashBalance === 1000, String(stu(d1, "12101").wildcatCashBalance));
  check("...the save recognises the receipt and absorbs it", plan1.movementsAbsorbed.includes(txn(1)),
    JSON.stringify(plan1.movementsAbsorbed));
  check("...and nothing is refused, so no tab is told it is out of date",
    plan1.countersIgnored.length === 0 && plan1.unkeyedResidual.length === 0,
    JSON.stringify({ c: plan1.countersIgnored, u: plan1.unkeyedResidual }));

  // SAVE FIRST (the command was slow or off), then the command arrives.
  const d2 = makeDb(seed());
  applySave(d2, saveRecord(2));
  check("SAVE THEN COMMAND: the save moves the money", stu(d2, "12101").wildcatCashBalance === 1000);
  const late = await run(d2, [award(2)]);
  check("...and the late command moves NOTHING", stu(d2, "12101").wildcatCashBalance === 1000,
    String(stu(d2, "12101").wildcatCashBalance));
  check("...and says so, as absorbed", late.results[0].status === "alreadyApplied" && late.results[0].via === "absorbed");
  check("...and reports it wrote NO records, so the browser keeps sending its own",
    late.results[0].wroteRecords === false,
    "marking them sent would leave the ledger short -- the save still owes the row");
  check("...and writes no ledger row or audit entry of its own",
    d2.tables.legacyMirror.length === 0 && d2.tables.appAuditLog.length === 0);
  check("...but does register what happened", d2.tables.cashAwardCommands[0]?.status === "absorbed");
}

console.log("\nA CLASS AT ONCE\n");
{
  const d = makeDb(seed());
  const r = await run(d, [award(1), award(2, { studentId: "NOBODY" }), award(3, { studentId: "11645" })]);
  check("each student gets their own answer", r.results.length === 3);
  check("an unknown student is refused alone", r.results[1].code === "student_not_found");
  check("...and does NOT roll the others back",
    r.results[0].status === "applied" && r.results[2].status === "applied" &&
    stu(d, "12101").wildcatCashBalance === 1000 && stu(d, "11645").wildcatCashBalance === 100);
  const tooMany = await run(makeDb(seed()), Array.from({ length: M.rules.CASH_AWARD_MAX_BATCH + 1 }, (_, i) => award(i)));
  check("a call over the batch cap is refused whole", tooMany.ok === false && tooMany.code === "too_many");
}

console.log("\nDEDUCTIONS\n");
{
  const d = makeDb(seed());
  const r = await run(d, [award(1, { studentId: "11645", amount: -100, kind: "deduct", behaviorId: "wc5", behaviorName: "Disruptive" })]);
  const s = stu(d, "11645");
  check("a deduction from $0 applies and goes negative", r.results[0].status === "applied" && s.wildcatCashBalance === -100);
  check("...and moves the deducted counter, not earned", s.wildcatCashDeducted === 100 && s.wildcatCashEarned === 0);
  check("...and is audited as a deduction with a positive ticketCount",
    d.tables.appAuditLog[0].payload.action === "cash_deduct" && d.tables.appAuditLog[0].payload.ticketCount === 100);
}

console.log("\nWHAT IS REFUSED\n");
{
  const refuse = async (over) => (await run(makeDb(seed()), [award(1, over)])).results[0];
  check("an id this app does not mint", (await refuse({ txnId: "evil" })).code === "bad_id");
  check("an award with a negative amount", (await refuse({ amount: -100 })).code === "sign_mismatch");
  check("a deduction with a positive amount", (await refuse({ kind: "deduct" })).code === "sign_mismatch");
  check("a fraction", (await refuse({ amount: 10.5 })).code === "bad_amount");
  check("zero", (await refuse({ amount: 0 })).code === "bad_amount");
  check("more than the cap every cash path shares", (await refuse({ amount: 999999 })).code === "too_large");
  check("a kind that belongs to another flow", (await refuse({ kind: "redeem", amount: -50 })).code === "bad_kind");
  check("a behaviour owned by the reset or the store",
    (await refuse({ behaviorId: "system_reset" })).code === "reserved_behavior" &&
    (await refuse({ behaviorId: "reward:hat" })).code === "reserved_behavior");
  check("no note", (await refuse({ notes: "" })).code === "note_required");
  check("a note padded with punctuation", (await refuse({ notes: "!!!..." })).code === "note_required");
  check("an award dated tomorrow", (await refuse({ at: new Date(NOW + 86400000).toISOString() })).code === "future");
  check("an award dated before the history reset", (await refuse({ at: "2026-09-01T12:00:00.000Z" })).code === "before_cutoff");
  check("a refusal writes nothing at all", await (async () => {
    const d = makeDb(seed()); await run(d, [award(1, { notes: "" })]);
    return stu(d, "12101").wildcatCashBalance === 900 && d.tables.legacyMirror.length === 0 && d.tables.cashAwardCommands.length === 0;
  })());
}

console.log("\nA RECEIPT MUST BE FRESH AND MINTED WITH ITS AWARD\n");
// Every ledger id is visible to staff and matches TXN_ID_RE, so the shape
// alone protects nothing. These are the checks that do.
{
  const refuse = async (over) => (await run(makeDb(seed()), [award(1, over)])).results[0];
  const oldIso = new Date(NOW - 2 * 3600_000).toISOString();
  check("an award two hours old is refused as stale",
    (await refuse({ at: oldIso, txnId: `txn_${Date.parse(oldIso)}_abc1` })).code === "stale");
  check("a receipt minted twenty minutes away from its award is refused",
    (await refuse({ txnId: `txn_${NOW - 20 * 60_000}_abc1` })).code === "id_mismatch");
  check("an award from before the reset still says exactly that, not merely 'old'",
    (await refuse({ at: "2026-09-01T12:00:00.000Z", txnId: `txn_${Date.parse("2026-09-01T12:00:00.000Z")}_abc1` })).code === "before_cutoff");
  check("the receipt's time is read from the id itself", M.rules.txnIdMs(txn(1)) === NOW - 60_000 + 1);
  check("...and a malformed id has none", Number.isNaN(M.rules.txnIdMs("txn_12_x")));
}

console.log("\nTHE ORDINARY SAVE'S LEDGER ROW GOT THERE FIRST\n");
// The race review found: mergeSlice and appData:save are separate mutations,
// so the ledger row can land before the counter. The command then rightly
// moves the money -- and must not write the row a second time.
const WEEK_DOC = "cash_tx_" + M.weeks.cashWeekKey(AT);
const oldPathRow = (over) => ({ doc: WEEK_DOC, collection: "transactions", mirroredAt: "x",
  payload: Object.assign({ id: txn(1), studentId: "12101", amount: 100, kind: "award", timestamp: AT }, over || {}) });
{
  const d = makeDb(seed({ legacyMirror: [oldPathRow()] }));
  const r = await run(d, [award(1)]);
  check("the money still moves, once", r.results[0].status === "applied" && stu(d, "12101").wildcatCashBalance === 1000);
  check("...but there is NO second ledger row with the same receipt",
    d.tables.legacyMirror.filter((x) => x.payload.id === txn(1)).length === 1,
    String(d.tables.legacyMirror.length));
  check("...while the child's copy and the audit entry are still written",
    stu(d, "12101").wildcatCashTransactions.length === 1 && d.tables.appAuditLog.length === 1);
  check("...and it reports its records as on the server, which they are", r.results[0].wroteRecords === true);

  const d2 = makeDb(seed({ legacyMirror: [Object.assign(oldPathRow(), { payload: JSON.stringify(oldPathRow().payload) })] }));
  await run(d2, [award(1)]);
  check("a row stored as a JSON string is recognised too", d2.tables.legacyMirror.length === 1);

  const d3 = makeDb(seed({ legacyMirror: [oldPathRow({ studentId: "11645" })] }));
  const r3 = await run(d3, [award(1)]);
  check("a receipt the ledger holds for ANOTHER child is refused", r3.results[0].code === "receipt_in_use");
  check("...and nothing moves, and nothing is written",
    stu(d3, "12101").wildcatCashBalance === 900 && d3.tables.legacyMirror.length === 1 &&
    d3.tables.appAuditLog.length === 0 && d3.tables.cashAwardCommands.length === 0);

  const d4 = makeDb(seed());
  await run(d4, [award(1), award(2, { studentId: "11645" }), award(3)]);
  const tail = d4.reads.ranges.filter((x) => x.table === "legacyMirror");
  check("the week is read as a RANGE on creation time, never scanned",
    tail.length === 1 && tail[0].field === "_creationTime" && tail[0].idx === "by_doc_collection",
    JSON.stringify(tail));
  check("...reaching back about an hour: enough for any real race, a tiny slice of a 900-row week",
    tail.length === 1 && NOW - tail[0].from >= 45 * 60_000 && NOW - tail[0].from <= 2 * 3600_000);
  check("...read ONCE for a class sharing a week, not once per child", d4.reads.byTable.legacyMirror === 1,
    String(d4.reads.byTable.legacyMirror));
  check("...and each award in that call still gets exactly one row", d4.tables.legacyMirror.length === 3);
}

console.log("\nIT NEVER READS THE WHOLE STUDENT TABLE\n");
{
  const d = makeDb(seed());
  await run(d, [award(1), award(2, { studentId: "11645" })]);
  check("no collect() on any table", d.reads.collect === 0, String(d.reads.collect));
  check("...and none in the source, where a later edit could add one", !/\.collect\(\)/.test(SRC.cashAward));
  check("the student is found by the same indexes appData:save uses",
    /by_legacyId[\s\S]{0,200}by_studentNumber/.test(SRC.cashAward));
}

console.log("\nDO THE ASSERTIONS HAVE TEETH?\n");
{
  // 1. Forget to register the receipt in cashApplied -> the ordinary save pays again.
  const broken = load({ cashAward: (c) => {
    const b = c.replace("patch.cashApplied = ringPush(cur, [{ id: a.txnId, at: a.at, amount: a.amount, kind: a.kind }]);", "");
    if (b === c) throw new Error("teeth 1: anchor moved"); return b; } });
  const d = makeDb(seed());
  await broken.award.award.handler({ db: d.db }, { awards: [award(1)], week: 4, cycle: 2 });
  const effect = broken.shape.cashMovementEffect(100, "award");
  const cashDelta = {}; for (const [f, v] of Object.entries(effect)) if (v) cashDelta[f] = v;
  const plan = broken.shape.planSave(d.tables.students,
    [{ id: "12101", cashDelta, cashMovements: [{ id: txn(1), at: AT, amount: 100, kind: "award" }] }],
    broken.shape.STUDENT_WRITABLE, (r) => [r.legacyId, r.studentNumber], null);
  for (const { rowId, patch } of plan.patches) Object.assign(d.tables.students.find((x) => x._id === rowId), patch);
  check("TEETH: without the shared receipt, command-then-save pays TWICE",
    stu(d, "12101").wildcatCashBalance === 1100, String(stu(d, "12101").wildcatCashBalance));
}
{
  // 2. Drop the register check -> a retry pays again.
  const broken = load({ cashAward: (c) => {
    const b = c.replace("if (reg) {", "if (false && reg) {");
    if (b === c) throw new Error("teeth 2: anchor moved"); return b; } });
  const d = makeDb(seed());
  // The ring still catches it, so blind the ring too, to isolate the register.
  await broken.award.award.handler({ db: d.db }, { awards: [award(1)] });
  stu(d, "12101").cashApplied = null;
  await broken.award.award.handler({ db: d.db }, { awards: [award(1)] });
  check("TEETH: without the register, a retry pays twice", stu(d, "12101").wildcatCashBalance === 1100);
}
{
  // 3. Claim records were written when the save still owes them.
  const broken = load({ cashAward: (c) => {
    const b = c.replace('status: "alreadyApplied",\n          via: "absorbed", wroteRecords: false,', 'status: "alreadyApplied",\n          via: "absorbed", wroteRecords: true,');
    if (b === c) throw new Error("teeth 3: anchor moved"); return b; } });
  const d = makeDb(seed());
  stu(d, "12101").cashApplied = { ids: [{ i: txn(1), at: AT }] };
  const r = await broken.award.award.handler({ db: d.db }, { awards: [award(1)] });
  check("TEETH: an absorbed award claiming its records is caught", r.results[0].wroteRecords === true);
}
{
  // 4. Ignore the switch.
  const broken = load({ cashAward: (c) => {
    const b = c.replace("if (!switchAllows(sw, actor.email)) {", "if (false) {");
    if (b === c) throw new Error("teeth 4: anchor moved"); return b; } });
  const d = makeDb(seed({ appState: [] }));
  await broken.award.award.handler({ db: d.db }, { awards: [award(1)] });
  check("TEETH: a command that ignores the switch is caught", stu(d, "12101").wildcatCashBalance === 1000);
}
{
  // 5. Drop the ledger check -> the race leaves two rows with one receipt.
  const broken = load({ cashAward: (c) => {
    const b = c.replace("if (!ledgerHasRow) {", "if (true) {");
    if (b === c) throw new Error("teeth 5: anchor moved"); return b; } });
  const d = makeDb(seed({ legacyMirror: [oldPathRow()] }));
  await broken.award.award.handler({ db: d.db }, { awards: [award(1)] });
  check("TEETH: without the ledger check, the race writes a second row", d.tables.legacyMirror.length === 2);
}
{
  // 6. Drop the owner check -> a receipt aimed at another child pays.
  const broken = load({ cashAward: (c) => {
    const b = c.replace('if (ledgerOwner !== undefined && ledgerOwner !== ""', 'if (false && ledgerOwner !== undefined && ledgerOwner !== ""');
    if (b === c) throw new Error("teeth 6: anchor moved"); return b; } });
  const d = makeDb(seed({ legacyMirror: [oldPathRow({ studentId: "11645" })] }));
  await broken.award.award.handler({ db: d.db }, { awards: [award(1)] });
  check("TEETH: without the owner check, a borrowed receipt moves money", stu(d, "12101").wildcatCashBalance === 1000);
}
{
  // 7. Drop the age check -> an old receipt arrives as a command.
  const broken = load({ cashAwardRules: (c) => {
    const b = c.replace("if (atMs < opts.nowMs - CASH_AWARD_MAX_AGE_MS) {", "if (false) {");
    if (b === c) throw new Error("teeth 7: anchor moved"); return b; } });
  const oldIso = new Date(NOW - 2 * 3600_000).toISOString();
  const d = makeDb(seed());
  const r = await broken.award.award.handler({ db: d.db }, { awards: [award(1, { at: oldIso, txnId: `txn_${Date.parse(oldIso)}_abc1` })] });
  check("TEETH: without the age check, a two-hour-old award is applied", r.results[0].status === "applied");
}

console.log("\nTHE ROLLOUT WATCH SEES THE NEWEST, AND SAYS WHEN IT STOPPED COUNTING\n");
{
  const rows = Array.from({ length: 5 }, (_, i) => ({ txnId: txn(i), studentId: "12101", status: "applied",
    wroteRecords: true, amount: 100, kind: "award", actorEmail: "rosal@lapromisefund.org", at: AT,
    recordedAt: `2026-09-23T10:0${i}:00.000Z` }));
  const d = makeDb(seed({ cashAwardCommands: rows }));
  const st = await M.award.status.handler({ db: d.db }, {});
  check("the newest command is listed first", st.last[0].at === "2026-09-23T10:04:00.000Z", JSON.stringify(st.last[0]));
  check("...and it says whether it stopped counting", st.capped === false && st.commands === 5);
}

console.log("\nTHE BROWSER HALF\n");
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
function liftFn(name) {
  const i = script.indexOf("function " + name + "(");
  if (i < 0) return "";
  const head = script.lastIndexOf("\n", i);
  let depth = 0;
  for (let k = script.indexOf("{", i); k < script.length; k++) {
    if (script[k] === "{") depth++;
    else if (script[k] === "}") { depth--; if (depth === 0) return script.slice(head + 1, k + 1); }
  }
  return "";
}
{
  // The sender, run for real with the world around it stubbed.
  const build = (opts) => {
    const o = opts || {};
    const env = {
      cashIdsOnServer: new Set(), auditIdsOnServer: new Set(), calls: [],
      // THE REAL OUTBOXES' SHAPE. The first build of this test stubbed the
      // prune functions with callbacks that accepted anything, so it passed
      // while the shipped code handed them arrays and threw on every award.
      cashOutbox: [{ id: "txn_a" }, { id: "txn_b" }],
      auditOutbox: [{ entryId: "a_txn_a" }, { entryId: "a_txn_b" }],
    };
    let sender = liftFn("sendCashAwardCommand");
    if (o.mutateSender) sender = o.mutateSender(sender);
    const body = [
      "const CASH_AWARD_TIMEOUT_MS = " + (o.timeoutMs ?? 50) + ";",
      "const CASH_OUTBOX_KEY = 'wc_cash_outbox';",
      "const readCashOutbox = () => env.cashOutbox.slice();",
      "const writeCashOutbox = (k) => { if (env.storageBroken) throw new Error('QuotaExceededError'); env.cashOutbox = k.slice(); };",
      "const readAuditOutbox = () => env.auditOutbox.slice();",
      "const writeAuditOutbox = (k) => { env.auditOutbox = k.slice(); };",
      "const clearAuditOutbox = () => { env.auditOutbox = []; };",
      "const ensureEntryId = (e) => e && e.entryId;",
      "const localStorage = { removeItem: () => { env.cashOutbox = []; } };",
      // The shipped prune functions, not stand-ins.
      liftFn("pruneCashOutbox"), liftFn("pruneAuditOutbox"),
      liftFn("cashAwardAuditId"), sender, liftFn("cashAwardCommandLanded"),
      "return { sendCashAwardCommand, cashAwardCommandLanded, cashAwardAuditId };",
    ].join("\n");
    const window = { WildcatAuth: {
      getSession: () => (o.noSession ? null : { idToken: "tok" }),
      convexMutation: async (name, args, tok) => {
        env.calls.push({ name, args, tok });
        if (o.throws) throw new Error("network down");
        if (o.hang) return new Promise(() => {});
        return typeof o.answer === "function" ? o.answer(args) : o.answer;
      },
    } };
    if (o.storageBroken) env.storageBroken = true;
    const f = new Function(
      "window", "env", "cashIdsOnServer", "auditIdsOnServer",
      "isPreviewingTeacher", "currentWeek", "getCurrentCycleNumber", "console",
      body,
    )(window, env, env.cashIdsOnServer, env.auditIdsOnServer,
      () => o.previewing === true, 4, () => 2, { warn: () => {} });
    return Object.assign(f, { env });
  };
  const tx = (id) => ({ id, studentId: "12101", timestamp: AT, amount: 100, kind: "award",
                        behaviorId: "wc1", behaviorName: "Be Present", notes: "Helped" });
  const items = [{ tx: tx("txn_a"), entryId: "a_txn_a" }, { tx: tx("txn_b"), entryId: "a_txn_b" }];

  const answer = { ok: true, results: [
    { txnId: "txn_a", status: "applied", wroteRecords: true, entryId: "a_txn_a" },
    { txnId: "txn_b", status: "alreadyApplied", via: "absorbed", wroteRecords: false, entryId: "a_txn_b" },
  ] };
  const wrote = build({ answer });
  const wroteRes = await wrote.sendCashAwardCommand(items);
  check("AN AWARD THE SERVER CONFIRMED IS REPORTED AS LANDED",
    wroteRes !== null && wrote.cashAwardCommandLanded(wroteRes, [items[0]]) === true,
    "the first build returned null here, and the teacher was told NOT saved yet");
  check("the command is sent once, with every award in it",
    wrote.env.calls.length === 1 && wrote.env.calls[0].name === "cashAward:award" &&
    wrote.env.calls[0].args.awards.length === 2);
  check("...carrying the SAME receipt the ledger row has",
    wrote.env.calls[0].args.awards[0].txnId === "txn_a");
  check("...and week and cycle for the audit view",
    wrote.env.calls[0].args.week === 4 && wrote.env.calls[0].args.cycle === 2);
  check("rows the server WROTE are marked as on the server",
    wrote.env.cashIdsOnServer.has("txn_a") && wrote.env.auditIdsOnServer.has("a_txn_a"));
  check("...and leave the real outboxes", !wrote.env.cashOutbox.some((t) => t.id === "txn_a") &&
    !wrote.env.auditOutbox.some((e) => e.entryId === "a_txn_a"), JSON.stringify(wrote.env.cashOutbox));
  check("...but an ABSORBED one is not, because the ordinary save still owes its row",
    !wrote.env.cashIdsOnServer.has("txn_b") && wrote.env.cashOutbox.some((t) => t.id === "txn_b") &&
    wrote.env.auditOutbox.some((e) => e.entryId === "a_txn_b"),
    "marking it sent would leave the ledger short");

  const broke = build({ answer, storageBroken: true });
  const brokeRes = await broke.sendCashAwardCommand(items);
  check("a storage failure while tidying does NOT turn a landed award into a lost one",
    brokeRes !== null && broke.cashAwardCommandLanded(brokeRes, [items[0]]) === true);

  // TEETH: put the arrays back, as the first build had them. The guard around
  // the tidying now stops that reaching the teacher as "NOT saved" -- but the
  // real prune functions still throw on an array, so the outbox is never
  // tidied, and the outbox assertion above is the one that catches it.
  const arrays = build({ answer, mutateSender: (src) => {
    const b = src.replace(/new Set\(\)/g, "[]").replace(/Confirmed\.add\(/g, "Confirmed.push(")
      .replace(/Confirmed\.size/g, "Confirmed.length");
    if (b === src) throw new Error("teeth arrays: anchor moved"); return b; } });
  await arrays.sendCashAwardCommand(items);
  check("TEETH: with arrays, the REAL prune throws and the outbox is never tidied",
    arrays.env.cashOutbox.some((t) => t.id === "txn_a") && arrays.env.auditOutbox.some((e) => e.entryId === "a_txn_a"));

  // TEETH: the first build EXACTLY -- arrays and no guard. This is the version
  // that told teachers "NOT saved yet" about awards that had landed.
  const firstBuild = build({ answer, mutateSender: (src) => {
    const b = src.replace(/new Set\(\)/g, "[]").replace(/Confirmed\.add\(/g, "Confirmed.push(")
      .replace(/Confirmed\.size/g, "Confirmed.length")
      .replace(/try \{\n(\s*if \(cashConfirmed[^\n]*\n\s*if \(auditConfirmed[^\n]*\n)\s*\} catch \(e\) \{\n[^\n]*\n\s*\}/, "$1");
    if (!/pruneCashOutbox\(cashConfirmed\);\n\s*if \(auditConfirmed\.length\) pruneAuditOutbox\(auditConfirmed\);\n\s*return res;/.test(b)) {
      throw new Error("teeth first build: anchor moved");
    }
    return b; } });
  const firstRes = await firstBuild.sendCashAwardCommand(items);
  check("TEETH: the first build reports a landed award as NOT landed",
    !(firstRes !== null && firstBuild.cashAwardCommandLanded(firstRes, [items[0]]) === true));

  const off = build({ answer: { ok: false, code: "disabled", results: [] } });
  await off.sendCashAwardCommand(items);
  check("switched off, nothing is marked as sent", off.env.cashIdsOnServer.size === 0 && off.env.cashOutbox.length === 2);

  const boom = build({ throws: true });
  let threw = false;
  try { await boom.sendCashAwardCommand(items); } catch { threw = true; }
  check("a network failure never throws into the award screen", threw === false);
  check("...and marks nothing", boom.env.cashIdsOnServer.size === 0);

  const hung = build({ hang: true, timeoutMs: 20 });
  const t0 = Date.now();
  const hres = await hung.sendCashAwardCommand(items);
  check("a hung call gives up rather than holding the screen", hres === null && Date.now() - t0 < 2000);
  check("...and treats the outcome as unknown, marking nothing", hung.env.cashIdsOnServer.size === 0);

  const preview = build({ previewing: true, answer: { ok: true, results: [] } });
  await preview.sendCashAwardCommand(items);
  check("previewing as a teacher sends NOTHING -- the token is the admin's", preview.env.calls.length === 0);

  const nosess = build({ noSession: true, answer: { ok: true, results: [] } });
  check("signed out, nothing is sent", (await nosess.sendCashAwardCommand(items)) === null && nosess.env.calls.length === 0);

  check("the browser derives the audit id exactly as the server does",
    wrote.cashAwardAuditId("txn_x") === M.rules.cashAwardAuditId("txn_x"));
}

console.log("\nEVERY ORDERING OF AN AWARD, A SAVE AND A RELOAD KEEPS THE MONEY RIGHT\n");
// THE PROPERTY, checked exhaustively rather than by example. Two adversarial
// reviews on 2026-09-23 found the tab's cash going wrong only in particular
// orderings -- a save answered during a reload, an award made while loadData
// was still paging the audit log, an award on a record a save had already
// replaced -- each one found by a reviewer enumerating orderings by hand. So
// this enumerates them: every interleaving of
//
//   an award (made on the record the modal captured, or the live one),
//   the award command landing on the server,
//   a save: send -> commit on the server -> answer,
//   a reload as loadData does it: start -> server read -> rows returned ->
//     rows installed on screen (seconds later, after the audit log),
//   another teacher's award to the same child,
//
// and after EVERY step requires:
//   - the screen shows exactly this tab's own awards (plus the colleague's,
//     once a read has seen it) -- never twice, never missing;
//   - shown minus base equals the listed movements, the rule every save is
//     judged by;
// and at the end, after the tab settles and reloads:
//   - the server holds every award exactly once;
//   - no save was refused at any point (a refusal is a forced reload and a
//     "money was not saved" toast).
//
// THE REAL CODE. recordCashTransaction, liveStudentRecord, settleSaveAnswerCash,
// commitRosterCash and loadRosterFromConvex are lifted from script.js; planSave
// and ringPush are the transpiled server. Only saveData's send step is mirrored,
// because it is inline in a 1,000-line function: it replaces `students` with
// copies (as saveData does) and states shown - base with the pending list.
{
  const FIELDS = ["wildcatCashBalance", "wildcatCashEarned", "wildcatCashSpent", "wildcatCashDeducted"];
  const { planSave, STUDENT_WRITABLE, ringPush } = M.shape;
  const effectOf = M.shape.cashMovementEffect;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const LIFT = ["cashCountersOf", "cashMovementEffect", "cashDeltaBetween", "rememberCashBase",
    "pruneCashConfirmations", "noteCashConfirmed", "beginCashLoad", "endCashLoad", "commitRosterCash",
    "buildCashSend", "heldFromAnswer", "settleSaveAnswerCash", "liveStudentRecord", "ensureCashFields",
    "recordCashTransaction", "loadRosterFromConvex", "showCashByTheRule"];
  // The state is LIFTED, not restated: a harness that hardcodes the journal's
  // settings cannot notice them change (review 3, 2026-09-23).
  const liftDecl = (name) => {
    const m = new RegExp("\\n\\s*((?:const|let) " + name + " = [^\\n]*;)").exec(script);
    if (!m) throw new Error("declaration not found: " + name);
    return m[1];
  };
  const CASH_STATE = ["_studentCashBase", "_pendingCashMovements", "_cashConfirmations", "_cashConfirmSeq",
    "CASH_CONFIRMATION_KEEP_MAX", "_openCashLoads", "_cashLoadSeq", "_serverCashOfRow",
    "CASH_TERMINAL_REFUSALS", "CASH_REFUSALS_TO_SAY"].map(liftDecl).join("\n");
  const factoryFor = (mutate) => {
    let src = LIFT.map((n) => { const f = liftFn(n); if (!f) throw new Error("missing " + n); return f; }).join("\n");
    if (mutate) {
      const out = mutate(src);
      if (out === src) throw new Error("mutation anchor moved");
      src = out;
    }
    return new Function("CASH_COUNTER_FIELDS", "window", "console", "noteHistoryCutoff", "enqueueCashOutbox", `
      ${CASH_STATE}
      let students = [], nonEnrolledStudents = [], cashTransactions = [];
      let currentUser = { id: "T034", name: "Rosa Lopez", username: "rosal" };
      ${src}
      return { base: _studentCashBase, pending: _pendingCashMovements, journal: _cashConfirmations,
        openLoads: _openCashLoads, loadRosterFromConvex, recordCashTransaction, settleSaveAnswerCash,
        buildCashSend, heldFromAnswer, showCashByTheRule, cashCountersOf, cashDeltaBetween,
        getStudents: () => students, setStudents: (s) => { students = s; } };
    `);
  };

  const makeWorld = (factory, opts) => {
    const o = opts || {};
    const w = { refusals: [], nextQuery: null,
      srv: { _id: "s1", legacyId: "12101", studentNumber: "12101", wildcatCashBalance: 500, wildcatCashEarned: 500,
             wildcatCashSpent: 0, wildcatCashDeducted: 0, cashApplied: null } };
    const readRow = () => Object.assign({ id: "12101", enrolled: true, firstName: "Jesus", lastName: "Cruz", grade: "9",
      wildcatCashTransactions: [], cashApplied: clone(w.srv.cashApplied) }, ...FIELDS.map((f) => ({ [f]: w.srv[f] })));
    const window = { WildcatAuth: {
      getSession: () => ({ idToken: "tok" }),
      convexQuery: async () => (w.nextQuery ? w.nextQuery() : { students: [readRow()] }),
    } };
    const api = factory(FIELDS, window, { log() {}, warn() {} }, () => {}, () => {});
    w.api = api;
    w.me = () => api.getStudents()[0];
    w.startLoad = () => {
      const h = { rows: null };
      let release;
      const gate = new Promise((r) => { release = r; });
      w.nextQuery = async () => { await gate; return { students: h.rows }; };
      h.promise = api.loadRosterFromConvex();
      w.nextQuery = null;
      h.read = () => { h.rows = [readRow()]; };
      h.deliver = async () => {
        if (!h.rows) h.read();
        release();
        h.fresh = await h.promise;
        // THE OLD ARCHITECTURE, for the teeth below: rebase at the read.
        if (o.installAtDeliver) h.early = h.fresh.install();
      };
      h.install = () => {
        const rows = h.early || h.fresh.install();
        api.setStudents(rows.filter((s) => s.enrolled !== false));
      };
      return h;
    };
    w.fullLoad = async () => { const h = w.startLoad(); h.read(); await h.deliver(); h.install(); };
    w.award = (target, amount, kind) => api.recordCashTransaction({ student: target, amount: amount ?? 100,
      kind: kind || "award", behaviorId: kind === "deduct" ? "wc5" : "wc1",
      behaviorName: kind === "deduct" ? "Disruptive" : "Be Present", notes: "Helped a classmate" });
    w.land = (id, at, amount, kind) => {
      if ((w.srv.cashApplied?.ids || []).some((e) => e.i === id)) return;
      const e = effectOf(amount, kind);
      FIELDS.forEach((f) => { w.srv[f] += e[f]; });
      w.srv.cashApplied = ringPush(w.srv.cashApplied, [{ id, at, amount, kind }]);
    };
    w.command = (tx) => w.land(tx.id, tx.timestamp, tx.amount, tx.kind);
    w.colleague = () => w.land("txn_colleague", new Date().toISOString(), 7, "award");
    w.saveSend = () => {
      // saveData replaces `students` with copies before its first await,
      // then builds the payload with the REAL buildCashSend.
      api.setStudents(api.getStudents().map((x) => Object.assign({}, x)));
      // What saveData hands both steps is a stripped COPY (studentsToSave ->
      // changedStudents), never the record on screen.
      const st = Object.assign({}, w.me());
      const built = api.buildCashSend([st]);
      return { st, record: built.studentsToSend[0], sentCounters: built.sentCounters, sentMovements: built.sentMovements };
    };
    w.cutoffMs = null;
    w.saveCommit = (msg) => {
      // The record crosses the wire as JSON, exactly once, at send time.
      const record = JSON.parse(JSON.stringify(msg.record));
      const plan = planSave([w.srv], [record], STUDENT_WRITABLE, (r) => [r.legacyId, r.studentNumber], w.cutoffMs);
      for (const { patch } of plan.patches) Object.assign(w.srv, patch);
      const bad = [...(plan.countersIgnored || []), ...(plan.unkeyedResidual || []), ...(plan.movementsRefused || [])];
      if (bad.length) w.refusals.push(bad);
      // The answer, shaped exactly as appData.ts builds it.
      msg.answer = {
        cashMovementsHeld: (plan.movementsRefused || []).map((r) => r.id),
        cashMovementsHeldWhy: (plan.movementsRefused || []).map((r) => ({ id: r.id, why: r.why })),
      };
    };
    w.saveAnswer = (msg) => {
      const { heldMovements, heldWhy } = api.heldFromAnswer(msg.answer);
      return api.settleSaveAnswerCash([msg.st], msg.sentCounters, msg.sentMovements, heldMovements, heldWhy);
    };
    w.save = () => { const m = w.saveSend(); w.saveCommit(m); w.saveAnswer(m); };
    w.inv = () => {
      const d = api.cashDeltaBetween(w.me(), api.base.get("12101"));
      const sum = {}; FIELDS.forEach((f) => { sum[f] = 0; });
      (api.pending.get("12101") || []).forEach((m) => { const e = effectOf(m.amount, m.kind); FIELDS.forEach((f) => { sum[f] += e[f]; }); });
      return FIELDS.every((f) => d[f] === sum[f]);
    };
    return w;
  };

  // Every interleaving of the given step sequences, each kept in its own order.
  const interleavings = (seqs) => {
    const out = [];
    const idx = seqs.map(() => 0);
    const cur = [];
    const rec = () => {
      let done = true;
      for (let i = 0; i < seqs.length; i++) {
        if (idx[i] < seqs[i].length) {
          done = false;
          cur.push(seqs[i][idx[i]]); idx[i]++;
          rec();
          idx[i]--; cur.pop();
        }
      }
      if (done) out.push(cur.slice());
    };
    rec();
    return out;
  };

  // One schedule, run. Returns null when every requirement held, else why not.
  const runOne = async (factory, cfg, schedule) => {
    const w = makeWorld(factory, cfg);
    await w.fullLoad();
    const captured = w.me();                  // the Add Cash modal opened on this record
    let own = 500;
    if (cfg.m0) { w.award(w.me()); own += 100; }   // an earlier award, not yet saved
    const handles = {}, msgs = {};
    let tx = null;
    let staleShown = 0;          // a refused-for-good award may show until its save answers
    const trace = [];
    for (const step of schedule) {
      const [what, n] = step.split(":");
      if (what === "award") {
        tx = w.award(cfg.captured ? captured : w.me(), cfg.amount ?? 100, cfg.kind || "award");
        if (cfg.stale) {
          // Recorded before a reset: dated three hours ago, cutoff now. The
          // server refuses it for good (before_cutoff); it must leave the
          // screen once refused, and never be paid.
          const list = w.api.pending.get("12101");
          list[list.length - 1].at = new Date(Date.now() - 3 * 3600_000).toISOString();
          w.cutoffMs = Date.now();
          staleShown = cfg.amount ?? 100;
        } else {
          own += cfg.amount ?? 100;
        }
      }
      else if (what === "cmd") w.command(tx);
      else if (what === "colleague") w.colleague();
      else if (what === "send") msgs[n] = w.saveSend();
      else if (what === "commit") w.saveCommit(msgs[n]);
      else if (what === "answer") w.saveAnswer(msgs[n]);
      else if (what === "start") handles[n] = w.startLoad();
      else if (what === "read") handles[n].read();
      else if (what === "deliver") await handles[n].deliver();
      else if (what === "install") handles[n].install();
      trace.push(step);
      if (!w.inv()) return "shown minus base stopped matching the list after " + trace.join(" > ");
      const shown = w.me().wildcatCashBalance;
      const okShown = [own, own + staleShown].some((v) => shown === v || (cfg.colleague && shown === v + 7));
      if (!okShown) {
        return `the screen showed ${shown} (own awards ${own}) after ` + trace.join(" > ");
      }
    }
    // The tab settles: saves until nothing is pending, a reload, one more save.
    for (let i = 0; i < 4 && w.api.pending.size; i++) w.save();
    await w.fullLoad();
    w.save();
    const truth = own + (cfg.colleague ? 7 : 0);
    // The one refusal a stale award is allowed: its own before_cutoff.
    const refusals = w.refusals.map((b) => b.filter((r) => !(cfg.stale && r.why === "before_cutoff"))).filter((b) => b.length);
    if (refusals.length) return "a save was REFUSED (forced reload) in " + schedule.join(" > ") + " :: " + JSON.stringify(refusals[0]);
    if (w.srv.wildcatCashBalance !== truth) return `the server holds ${w.srv.wildcatCashBalance}, not ${truth}, after ` + schedule.join(" > ");
    if (w.me().wildcatCashBalance !== truth) return `the screen settled at ${w.me().wildcatCashBalance}, not ${truth}, after ` + schedule.join(" > ");
    if (w.api.pending.size || !w.inv()) return "something was left pending after " + schedule.join(" > ");
    return null;
  };

  const SAVE = (n) => [`send:${n}`, `commit:${n}`, `answer:${n}`];
  const LOAD = (n) => [`start:${n}`, `read:${n}`, `deliver:${n}`, `install:${n}`];
  const CONFIGS = [];
  for (const m0 of [false, true]) {
    for (const cmd of [true, false]) {
      for (const colleague of [false, true]) {
        const seqs = [cmd ? ["award", "cmd"] : ["award"], SAVE(1), LOAD(1)];
        if (colleague) seqs.push(["colleague"]);
        CONFIGS.push({ name: `command ${cmd ? "on" : "off"}${m0 ? ", an earlier award unsaved" : ""}${colleague ? ", a colleague awards too" : ""}`,
          cfg: { m0, colleague }, seqs });
      }
    }
  }
  for (const cmd of [true, false]) {
    CONFIGS.push({ name: `command ${cmd ? "on" : "off"}, the award made on the record the modal captured`,
      cfg: { captured: true }, seqs: [cmd ? ["award", "cmd"] : ["award"], SAVE(1), LOAD(1)] });
  }
  for (const cmd of [true, false]) {
    CONFIGS.push({ name: `command ${cmd ? "on" : "off"}, a DEDUCTION, a colleague awards too`,
      cfg: { colleague: true, amount: -50, kind: "deduct" }, seqs: [cmd ? ["award", "cmd"] : ["award"], SAVE(1), LOAD(1), ["colleague"]] });
    CONFIGS.push({ name: `command ${cmd ? "on" : "off"}, the save's answer is LOST and the next save re-sends`,
      cfg: { m0: true }, seqs: [cmd ? ["award", "cmd"] : ["award"], ["send:1", "commit:1"], LOAD(1)] });
    CONFIGS.push({ name: `command ${cmd ? "on" : "off"}, two reloads overlapping (the sign-in path after a token renewal)`,
      cfg: { m0: true }, seqs: [cmd ? ["award", "cmd"] : ["award"], SAVE(1), LOAD(1), LOAD(2)], big: true });
  }
  for (const m0 of [false, true]) {
    CONFIGS.push({ name: `an award dated before a reset (refused for good)${m0 ? ", an earlier award unsaved" : ""}, a colleague awards too`,
      cfg: { stale: true, m0, colleague: true }, seqs: [["award"], SAVE(1), LOAD(1), ["colleague"]] });
  }
  CONFIGS.push({ name: "an award dated before a reset, two reloads overlapping",
    cfg: { stale: true, m0: true }, seqs: [["award"], SAVE(1), LOAD(1), LOAD(2)], big: true });
  CONFIGS.push({ name: "command on, two saves back to back while a reload runs",
    cfg: { m0: true, colleague: true }, seqs: [["award", "cmd"], [...SAVE(1), ...SAVE(2)], LOAD(1), ["colleague"]], big: true });

  const sweep = async (factory, config, limit) => {
    let all = interleavings(config.seqs);
    if (limit && all.length > limit) all = all.filter((_, i) => i % Math.ceil(all.length / limit) === 0);
    let failures = 0, first = null;
    for (const sch of all) {
      const why = await runOne(factory, Object.assign({}, config.cfg, config.extra || {}), sch);
      if (why) { failures++; if (!first) first = why; }
    }
    return { n: all.length, failures, first };
  };

  // The two largest (up to 900,900 orderings) are sampled by a fixed stride in
  // an ordinary run, so `npm test` stays quick; WC_DEEP=1 runs every one.
  // Every one was run before this shipped.
  const DEEP = process.env.WC_DEEP === "1";
  const shipped = factoryFor(null);
  let total = 0;
  const t0 = Date.now();
  for (const c of CONFIGS) {
    const r = await sweep(shipped, c, c.big && !DEEP ? 40000 : 0);
    total += r.n;
    check(`${c.name}: ${c.big && !DEEP ? "a fixed sample of " : "all "}${r.n} orderings keep the money right`, r.failures === 0,
      r.failures ? `${r.failures} failed; first: ${r.first}` : "");
  }
  console.log(`        (${total} orderings, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // TEETH. Each re-creates, in the REAL code, one defect a review found, and
  // the sweep must catch it. A sweep that passes these too proves nothing.
  const teeth = [
    { name: "the save's answer pins the base to what it SENT (the old rule)",
      mutate: (s) => s.replace("if (hadBase) _studentCashBase.set(key, base);",
        "if (hadBase) _studentCashBase.set(key, Object.assign({}, sentCounters.get(key)));"),
      config: CONFIGS.find((c) => c.cfg.colleague && !c.cfg.m0 && c.seqs[0].length === 2) },
    { name: "a reload ignores the server's register and re-adds what it already holds",
      mutate: (s) => s.replace("if (holds.has(id)) { alreadyThere++; noteCashConfirmed(key, m); return; }", ""),
      config: CONFIGS[0] },
    { name: "a reload forgets movements a save confirmed during it",
      mutate: (s) => s.replace("if (c.seq <= sinceSeq) return;", "return;"),
      config: CONFIGS[0] },
    { name: "a reload that drops a held movement does not journal it (two overlapping reloads)",
      mutate: (s) => s.replace("if (holds.has(id)) { alreadyThere++; noteCashConfirmed(key, m); return; }",
        "if (holds.has(id)) { alreadyThere++; return; }"),
      config: CONFIGS.find((c) => c.seqs.length === 4 && c.seqs[3][0] === "start:2"), limit: 40000 },
    { name: "a reload does not carry an award made while it was loading",
      mutate: (s) => s.replace("next.push(m);\n                    carried++;", "carried++;"),
      config: CONFIGS.find((c) => !c.cfg.m0 && c.seqs[0].length === 1 && !c.cfg.colleague && !c.cfg.captured) },
    { name: "an award is recorded on the captured record, not the one on screen",
      mutate: (s) => s.replace("ensureCashFields(liveStudentRecord(opts.student))", "ensureCashFields(opts.student)"),
      config: CONFIGS.find((c) => c.cfg.captured && c.seqs[0].length === 1) },
    { name: "the rows are rebased when READ, not when they go on screen (the old architecture)",
      mutate: null, extra: { installAtDeliver: true },
      config: CONFIGS.find((c) => !c.cfg.m0 && c.seqs[0].length === 1 && !c.cfg.colleague && !c.cfg.captured) },
  ];
  teeth.push({ name: "a refused-for-good award is taken off the COPY saveData passed, not the record on screen",
    mutate: (s) => s.replace("const live = liveStudentRecord(st);", "const live = st;"),
    config: CONFIGS.find((c) => c.cfg.stale && !c.cfg.m0) });
  teeth.push({ name: "the answer's reasons are not read (fix switched off)",
    mutate: (s) => s.replace("(result && Array.isArray(result.cashMovementsHeldWhy) ? result.cashMovementsHeldWhy : [])", "[]"),
    config: CONFIGS.find((c) => c.cfg.stale && !c.cfg.m0) });
  for (const t of teeth) {
    const r = await sweep(factoryFor(t.mutate), Object.assign({}, t.config, { extra: t.extra }), t.limit);
    check(`TEETH: ${t.name} -- caught`, r.failures > 0, `${r.failures} of ${r.n} orderings failed`);
  }

  // THE LOCALSTORAGE FALLBACK. A failed load puts the cached copy on screen;
  // its numbers can predate this tab's base and list.
  {
    const withRule = new Function("CASH_COUNTER_FIELDS", "base", "pending", `
      const _studentCashBase = base, _pendingCashMovements = pending;
      ${liftFn("cashMovementEffect")}
      ${liftFn("showCashByTheRule")}
      return showCashByTheRule;
    `);
    const base = new Map([["12101", { wildcatCashBalance: 607, wildcatCashEarned: 607, wildcatCashSpent: 0, wildcatCashDeducted: 0 }]]);
    const pending = new Map([["12101", [{ id: "M1", at: AT, amount: 100, kind: "award" }]]]);
    base.set("11645", { wildcatCashBalance: 507, wildcatCashEarned: 507, wildcatCashSpent: 0, wildcatCashDeducted: 0 });
    const cached = [{ id: "12101", wildcatCashBalance: 500, wildcatCashEarned: 500, wildcatCashSpent: 0, wildcatCashDeducted: 0 },
                    { id: "99999", wildcatCashBalance: 42, wildcatCashEarned: 42, wildcatCashSpent: 0, wildcatCashDeducted: 0 },
                    { id: "11645", wildcatCashBalance: 500, wildcatCashEarned: 500, wildcatCashSpent: 0, wildcatCashDeducted: 0 }];
    withRule(FIELDS, base, pending)(cached);
    check("a stale cached copy is shown as base + list (607 + 100), not its own 500",
      cached[0].wildcatCashBalance === 707 && cached[0].wildcatCashEarned === 707);
    check("...and a student with no base is left as the copy had it", cached[1].wildcatCashBalance === 42);
    check("...and a student with a base and NOTHING pending is shown as the base (507), not the copy (500)",
      cached[2].wildcatCashBalance === 507, "a colleague's award the copy predates would otherwise be refused as this tab's own");
    check("loadDataLocal applies it to what it puts on screen",
      /students = data\.students \|\| \[\];\s*\/\/[^\n]*\n\s*showCashByTheRule\(students\);/.test(script));
  }

  // A REFUSAL NO RETRY CAN CHANGE. Review 3's one regression: a movement the
  // server held for good (here before_cutoff: dated before a history reset)
  // stayed listed, and every reload re-added it on top of the server's number
  // for as long as the page stayed open.
  const refusedForGood = async (factory) => {
    const w = makeWorld(factory, {});
    await w.fullLoad();                                   // base $500
    w.award(w.me(), 100, "award");
    // Recorded three hours ago; a reset since zeroed the child and moved the
    // cutoff to now.
    const list = w.api.pending.get("12101");
    list[list.length - 1].at = new Date(Date.now() - 3 * 3600_000).toISOString();
    w.cutoffMs = Date.now();
    FIELDS.forEach((f) => { w.srv[f] = 0; });
    w.save();
    const out = { listed: w.api.pending.has("12101"), shownAfterSave: w.me().wildcatCashBalance, ruleAfterSave: w.inv() };
    // The next save, BEFORE any reload: it must state exactly what it lists.
    w.refusals = [];
    w.save();
    out.refusedBeforeReload = w.refusals.length;
    await w.fullLoad();
    out.shownAfterReload = w.me().wildcatCashBalance;
    out.server = w.srv.wildcatCashBalance;
    w.refusals = []; w.cutoffMs = null;
    w.award(w.me(), 50, "award");
    w.save();
    out.after = { refusals: w.refusals.length, server: w.srv.wildcatCashBalance, shown: w.me().wildcatCashBalance };
    return out;
  };
  {
    const r = await refusedForGood(shipped);
    check("before_cutoff: the movement leaves the list", r.listed === false);
    check("...and the screen drops it at once: base $500, the number this tab last read (the reset is not loaded yet)",
      r.shownAfterSave === 500, String(r.shownAfterSave));
    check("...so shown minus base still equals the list, and the next save is refused nothing",
      r.ruleAfterSave === true && r.refusedBeforeReload === 0, JSON.stringify(r));
    check("...and after a reload it is NOT re-added on top of the server's $0 (the regression)",
      r.shownAfterReload === 0 && r.server === 0, `${r.shownAfterReload} vs server ${r.server}`);
    check("...and the next award lands cleanly, nothing refused",
      r.after.refusals === 0 && r.after.server === 50 && r.after.shown === 50, JSON.stringify(r.after));
    const mutant = await refusedForGood(factoryFor((src) =>
      src.replace("CASH_TERMINAL_REFUSALS.has(why.get(id))", "false")));
    check("TEETH: keep a refused-for-good movement listed and the reload shows it on top of the server again",
      mutant.shownAfterReload === 100 && mutant.server === 0, JSON.stringify(mutant));
  }

  // A RELOAD LEFT OPEN WHILE THE TEACHER KEEPS WORKING. Review 3: the journal
  // used to expire after 15 minutes, and a load stalled past that (a hung
  // audit page, a closed lid) installed without the awards confirmed in the
  // meantime. Entries now live exactly as long as an open load needs them.
  const stalledLoad = async (factory) => {
    const w = makeWorld(factory, {});
    await w.fullLoad();
    const h = w.startLoad();
    h.read();                                   // reads $500
    for (let i = 0; i < 3; i++) { w.award(w.me(), 100, "award"); w.save(); }
    const kept = w.api.journal.length;
    await h.deliver();
    h.install();
    const out = { kept, shown: w.me().wildcatCashBalance, leftAfter: w.api.journal.length, open: w.api.openLoads.size };
    w.save();
    out.refusals = w.refusals.length; out.server = w.srv.wildcatCashBalance;
    return out;
  };
  {
    const r = await stalledLoad(shipped);
    check("confirmations are kept while a load is open", r.kept === 3, String(r.kept));
    check("...so the stalled load installs showing all three ($800), not $500", r.shown === 800, String(r.shown));
    check("...and once it installed, nothing keeps them", r.leftAfter === 0 && r.open === 0);
    check("...and the next save is refused nothing", r.refusals === 0 && r.server === 800);
    const mutant = await stalledLoad(factoryFor((src) =>
      src.replace("(_cashConfirmations[0].seq <= oldest ||", "(true ||")));
    check("TEETH: prune the journal regardless of open loads and the stalled load shows $500",
      mutant.shown === 500, JSON.stringify(mutant));
  }

  // A WITHDRAWN STUDENT IS NOT KEPT TWICE (review 3, pre-existing): the merge
  // checks local-only students against every row, and RESET ALL CASH visits
  // each child once.
  check("loadData's merge treats a student in the fresh FORMER rows as known, not local-only",
    /const formerIds = new Set\(\(nonEnrolledStudents \|\| \[\]\)\.map\(s => String\(s && s\.id\)\)\);[\s\S]{0,300}&& !formerIds\.has\(String\(localStudent\.id\)\)\) \{\s*mergedStudents\.push\(localStudent\);/.test(script));
  check("RESET ALL CASH visits each child once, on the record on screen",
    /async function _resetAllStudentCash\(\)[\s\S]{0,3000}if \(!s \|\| seenIds\.has\(id\)\) return;\s*seenIds\.add\(id\);\s*everyStudent\.push\(liveStudentRecord\(s\)\);/.test(script));
  // THE MERGE, RUN. Cut from loadData verbatim: install, the enrolled/former
  // split, and the merge of local records. Each child must be held ONCE.
  {
    const i = script.indexOf("                        if (rosterLoad) {");
    const j = script.indexOf("                        // Load from main document (non-student data can be overwritten safely)", i);
    const chunk = script.slice(i, j);
    const runMerge = (local, rows) => new Function("serverCashCounters", "mergeCashHistory", `
      let students = ${JSON.stringify(local)};
      let nonEnrolledStudents = [];
      const rosterLoad = { install: () => ${JSON.stringify(rows)} };
      const mainData = {};
      const serverTicketHistories = {};
      const currentWeek = 1;
      const entryBelongsToCurrentCycle = () => true;
      ${chunk}
      return { students, nonEnrolledStudents };
    `)((st) => { const o = {}; FIELDS.forEach((f) => { if (st && typeof st[f] === "number") o[f] = st[f]; }); return o; },
       (a) => a || []);
    const row = (id, enrolled, bal) => Object.assign({ id, enrolled, firstName: "X", lastName: id }, ...FIELDS.map((f) => ({ [f]: f === "wildcatCashBalance" || f === "wildcatCashEarned" ? bal : 0 })));
    const out = runMerge(
      [row("W1", true, 500), row("E1", true, 300), row("L1", true, 10)],          // on screen: withdrawn-to-be, enrolled, local-only
      [row("W1", false, 507), row("E1", true, 300)]);                              // fresh: W1 now former, L1 unknown to the server
    const ids = out.students.concat(out.nonEnrolledStudents).map((s) => String(s.id)).sort();
    check("the merge holds each child once: withdrawn, enrolled and local-only", JSON.stringify(ids) === JSON.stringify(["E1", "L1", "W1"]),
      JSON.stringify(ids));
    check("...the withdrawn child only as the fresh former row ($507), not the stale enrolled copy",
      out.nonEnrolledStudents.length === 1 && out.nonEnrolledStudents[0].wildcatCashBalance === 507 && !out.students.some((s) => s.id === "W1"));
    check("...and a student the server does not know is still kept", out.students.some((s) => s.id === "L1"));
    const numeric = runMerge([Object.assign(row("5", true, 1), { id: 5 })], [row("5", true, 2)]);
    check("...and an id held as a number locally and a string on the server is still one child",
      numeric.students.length === 1, JSON.stringify(numeric.students.map((s) => s.id)));
  }
  // WHAT A TEACHER IS TOLD AFTER A HOLD, and when the tab re-reads the server.
  {
    const make = () => {
      const log = { toasts: [], refreshes: 0 };
      const f = new Function("CASH_REFUSALS_TO_SAY", "students", "nonEnrolledStudents", "showToast", "refreshCashFromServer", "setTimeout", `
        ${liftFn("liveStudentRecord")}
        let _lastCashHeldRefresh = 0;
        ${liftFn("onCashHeld")}
        return onCashHeld;
      `)(new Set(["before_cutoff", "undated", "bad_shape"]),
         [{ id: "12101", firstName: "Jesus", lastName: "Cruz" }], [],
         (m) => log.toasts.push(m), async () => { log.refreshes++; }, (fn) => fn());
      return { f, log };
    };
    let t = make();
    t.f([{ key: "12101", id: "M1", why: "coverage_lost", amount: 100 }], new Set(["M1"]), new Map([["M1", "coverage_lost"]]));
    check("coverage_lost: NO teacher message (it may have been paid), but the tab re-reads the server",
      t.log.toasts.length === 0 && t.log.refreshes === 1);
    t = make();
    t.f([{ key: "12101", id: "M1", why: "before_cutoff", amount: 100 }], new Set(["M1"]), new Map([["M1", "before_cutoff"]]));
    check("before_cutoff: the message names the child and the amount, and says nothing else is needed",
      t.log.toasts.length === 1 && /Jesus Cruz \(\+\$100\)/.test(t.log.toasts[0]) && /Nothing else needs doing/.test(t.log.toasts[0]),
      t.log.toasts[0]);
    t = make();
    t.f([], new Set(["M1"]), new Map([["M1", "stated_no_change"]]));
    check("an incoherent save (stated_no_change) makes the tab re-read the server -- the silent 38-student shape",
      t.log.refreshes === 1 && t.log.toasts.length === 0);
    t = make();
    t.f([], new Set(["M1"]), new Map([["M1", "capped"]]));
    check("capped alone does not re-read: a refresh cannot change the answer", t.log.refreshes === 0);
    t = make();
    t.f([], new Set(["M1"]), new Map([["M1", "stated_no_change"]]));
    t.f([], new Set(["M2"]), new Map([["M2", "stated_no_change"]]));
    check("and it re-reads at most once every 30 seconds, never in a loop", t.log.refreshes === 1);
  }
  // THE RE-READ TOUCHES CASH AND NOTHING ELSE (review 5): the first version
  // replaced `students` from inside the save that asked for it, undoing a
  // ticket award made in those seconds.
  {
    const run = async (opts) => {
      const log = { loads: 0, retries: 0 };
      const liveRec = { id: "12101", firstName: "Maria", pbisTickets: 3, wildcatCashBalance: 600, wildcatCashEarned: 600,
                        wildcatCashSpent: 0, wildcatCashDeducted: 0 };
      const server = { id: "12101", firstName: "Maria", pbisTickets: 2, wildcatCashBalance: 700, wildcatCashEarned: 700,
                       wildcatCashSpent: 0, wildcatCashDeducted: 0, cashApplied: { ids: [{ i: "M1", at: AT }] } };
      const f = new Function("CASH_COUNTER_FIELDS", "DATA_SOURCE", "isPreviewingTeacher", "isSyncing", "_saveQueue",
        "loadRosterFromConvex", "students", "nonEnrolledStudents", "setTimeout", "console", `
        ${liftFn("refreshCashFromServer")}
        return refreshCashFromServer;
      `)(FIELDS, "convex", () => !!opts.preview, !!opts.syncing, { isPending: () => false },
         async () => { log.loads++; return { install: () => [server] }; },
         [liveRec], [], () => { log.retries++; }, { log() {}, warn() {} });
      await f("test");
      return { log, liveRec };
    };
    const r = await run({});
    check("the re-read puts the server's cash on the record on screen",
      r.liveRec.wildcatCashBalance === 700 && r.liveRec.cashApplied && r.log.loads === 1);
    check("...and leaves every other field alone (a ticket award made meanwhile survives)",
      r.liveRec.pbisTickets === 3 && r.liveRec.firstName === "Maria");
    const busy = await run({ syncing: true });
    check("...and while a save is running it waits and tries again, instead of loading mid-save",
      busy.log.loads === 0 && busy.log.retries === 1);
    const preview = await run({ preview: true });
    check("...and while an admin previews as a teacher it does nothing",
      preview.log.loads === 0 && preview.log.retries === 0);
    check("onCashHeld asks for the cash-only re-read, not a roster refresh",
      /setTimeout\(\(\) => \{ refreshCashFromServer\('a movement the server held'\); \}, 0\);/.test(liftFn("onCashHeld"))
      && !/refreshRosterFromConvex\(/.test(liftFn("onCashHeld")));
  }
  check("the server tells the client WHY each movement was held, every one",
    /cashMovementsHeldWhy: movementsRefused\.map\(\(r\) => \(\{ id: r\.id, why: r\.why \}\)\),/.test(readFileSync(new URL("./convex/appData.ts", import.meta.url), "utf8")));
}

console.log("\nTHE ADD CASH BUTTON NO LONGER CRASHES BEFORE SAVING\n");
{
  // RUN, not read. The old code passed every text-matching test while throwing
  // a TypeError between recording the award and requesting the save.
  const runConfirm = async (fnName) => {
    const log = { saved: 0, toasts: [], recorded: 0, audited: 0, sentCmd: 0 };
    const student = { id: "12101", firstName: "Jesus", lastName: "Cruz" };
    const els = {
      addCashBehaviorSelect: { value: "wc1" }, addCashNotes: { value: "Helped a classmate" },
      removeCashBehaviorSelect: { value: "wc5" }, removeCashNotes: { value: "Talking over others" },
      addCashModal: { classList: { add() {} } }, removeCashModal: { classList: { add() {} } },
      mainApp: { classList: { remove() {} } },
    };
    const body = [
      "let selectedStudentForCash = __student;",
      liftFn("cancelAddCash"), liftFn("cancelRemoveCash"), liftFn(fnName),
      "return " + fnName + ";",
    ].join("\n").replace(/async function/g, "async function");
    const fn = new Function(
      "__student", "document", "window", "alert", "wildcatCashBehaviors", "recordCashTransaction",
      "addToAuditLog", "updateStudentAccounts", "updateCashTable", "markCashUnsaved", "showToast",
      "requestSave", "allCashOnServer", "sendCashAwardCommand", "cashAwardCommandLanded",
      "cashAwardAuditId", "_unsavedCash", "renderUnsavedReferralBar",
      body,
    )(student, { getElementById: (id) => els[id] || null },
      { WildcatRoster: { cashNoteVerdict: () => ({ ok: true }) } },
      () => {},
      [{ id: "wc1", name: "Be Present", points: 100 }, { id: "wc5", name: "Disruptive", points: -100 }],
      (o) => { log.recorded++; return { id: "txn_1", studentId: o.student.id }; },
      () => { log.audited++; },
      () => {}, () => {}, () => {},
      (m) => log.toasts.push(m),
      async () => { log.saved++; return true; },
      () => true,
      async () => { log.sentCmd++; return null; },
      () => false,
      (id) => "a_" + id,
      new Map(), () => {},
    );
    let error = null;
    try { await fn(); } catch (e) { error = e; }
    return { log, error };
  };
  for (const name of ["confirmAddCash", "confirmRemoveCash"]) {
    const { log, error } = await runConfirm(name);
    check(`${name} runs to the end without a TypeError`, error === null, error && error.message);
    check(`...and REQUESTS THE SAVE, which the crash used to skip`, log.saved === 1);
    check(`...and sends the award as a command`, log.sentCmd === 1);
    check(`...and tells the teacher it saved`, log.toasts.some((t) => /✅/.test(t)), JSON.stringify(log.toasts));
  }
  check("neither function reads the student through the variable the modal clears",
    !/selectedStudentForCash\.firstName/.test(liftFn("confirmAddCash") + liftFn("confirmRemoveCash")));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
