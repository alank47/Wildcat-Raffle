// legacyData:mergeSlice — the merge that stops two teachers erasing each other.
//
// WHAT CHANGED, 2026-09-04, AND WHAT MUST NOT. The handler used to delete every
// stored row and re-insert the merged set, so appending one audit entry to a
// week holding 1,278 rewrote all 1,279. Convex counts a delete as a READ, so
// that cost 2n against a 4,096 limit: a hard ceiling near 2,048 rows.
//
// The audit log is partitioned weekly and takes one entry per student per cash
// award. A launch week with 34 teachers awarding whole classes crosses 2,048
// mid-week, and the PBIS team reads that log to see who is giving what. Ticket
// history had already crossed it and failed on every save.
//
// Survivors are now left in place. THE MERGE RULE IS UNCHANGED, and that is
// what these assertions are for: the reference implementation below is the OLD
// algorithm, and the new one is checked against it row for row on every case.
// If the two ever disagree, the optimisation broke the durability guarantee and
// that is the only thing here worth failing over.
//
// Run: npm test

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const src = readFileSync(new URL("./legacyData.ts", import.meta.url), "utf8");

// ---- Extract the handler and run it against a fake ctx ---------------------
//
// Transpiled with the real TypeScript compiler rather than stripped with
// regexes: this test's whole value is that it runs the SHIPPED code, and a
// hand-rolled type-stripper that silently mangles the handler would assert
// against something the server never executes.
import ts from "typescript";

const handlerStart = src.indexOf("  handler: async (ctx, { doc, collection, rows, dedupeField }) => {");
const handlerEnd = src.indexOf("export const saveSlice");
const tsBody = src.slice(handlerStart, handlerEnd)
  .replace("  handler: async (ctx, { doc, collection, rows, dedupeField }) => {", "")
  // The identity was `await requireStaff(ctx);` and became
  // `const me = await requireStaff(ctx);` on 2026-09-11, because the referral
  // confirmation email must take its recipient from the VERIFIED token and
  // never from `payload`, which is v.any() and caller-chosen. Stubbed rather
  // than stripped, so the handler still binds `me` and the mail call below is
  // really executed.
  //
  // ctx.__me picks who is calling (2026-10-07): the referral rules depend on
  // the caller's role and email. The default is a teacher, which is what the
  // stub always effectively was.
  .replace(/const me = await requireStaff\(ctx\);/,
           'const me = ctx.__me ?? { email: "filer@example.org", name: "Test Filer", role: "teacher" };')
  .replace(/await requireStaff\(ctx\);/, "")
  // The one substitution: the indexed query becomes the fake db's collect().
  .replace(/const existing = await ctx\.db[\s\S]*?\.collect\(\);/,
           "const existing = await ctx.db.collect();")
  // The history cutoff, added 2026-09-14, reads appState. Injected rather than
  // stubbed to null, so the guard itself can be tested: a cutoff a client
  // cannot influence is exactly the thing worth asserting, since it is what
  // makes a stale tab harmless instead of asking 40 staff to hard-refresh.
  .replace(/const cutoffRow = await ctx\.db[\s\S]*?\.unique\(\);/,
           "const cutoffRow = ctx.__cutoffRow ?? null;");

// Everything up to the final `return`, then our own reporting return.
const upToReturn = tsBody.slice(0, tsBody.lastIndexOf("return {"));
const js = ts.transpileModule(upToReturn, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

// The cap lives at module scope in the source, so it is passed in rather than
// redefined here -- reading it from the file keeps the two in step.
const MAX_ROWS_PER_SLICE = Number(
  /const MAX_ROWS_PER_SLICE = (\d+);/.exec(src)[1]);

// touchedAt is module scope in the source, so it is lifted out and transpiled
// the same way, and passed in: the handler must run against the shipped one.
// Lifted the same way, and for the same reason: the handler must run against
// the SHIPPED helpers, not against copies in this file that could drift.
// isHistorySlice / rowDate / HISTORY_CUTOFF_SLACK_MS joined touchedAt on
// 2026-09-14 with the history cutoff.
function liftDecl(startsWith) {
  const a = src.indexOf(startsWith);
  if (a === -1) throw new Error("declaration not found in legacyData.ts: " + startsWith);
  // A const ends at the first semicolon; a function at the first line-start brace.
  const end = startsWith.startsWith("const")
    ? src.indexOf(";", a) + 1
    : src.indexOf("\n}\n", a) + 3;
  return src.slice(a, end);
}
const moduleScopeTs = [
  liftDecl("function touchedAt("),
  liftDecl("function isHistorySlice("),
  liftDecl("function rowDate("),
  liftDecl("const HISTORY_CUTOFF_SLACK_MS"),
  // Added 2026-09-16 with the rule it implements: an update keeps stored
  // fields the incoming row does not carry. The mutation body calls it, so
  // without it lifted the whole harness dies on "mergeRowFields is not
  // defined" -- the same way cash-ledger.test.mjs died when
  // reconcileCashLedger gained a dependency.
  liftDecl("function mergeRowFields("),
  // Added 2026-09-28: a student-store reward keeps the server's stock unless
  // an admin deliberately set a new one. Called by the update path.
  liftDecl("function keepServerStock("),
  // Added 2026-10-02: a cancelled store receipt is final. Called by the
  // update path.
  liftDecl("function receiptIsCancelled("),
].join("\n");
const touchedJs = ts.transpileModule(moduleScopeTs, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

// THE REFERRAL RULES (2026-10-07), the SHIPPED module, transpiled and passed
// in under the names legacyData.ts imports them by. It imports nothing, so it
// needs no shim. ConvexError is a real class here so a refusal can be told
// apart from a ReferenceError: an undefined ConvexError would also "throw".
const rulesSrc = readFileSync(new URL("./referralAccessRules.ts", import.meta.url), "utf8");
const RULES = (() => {
  const m = { exports: {} };
  new Function("module", "exports", "require", ts.transpileModule(rulesSrc, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(m, m.exports, (p) => { throw new Error("unexpected import " + p); });
  return m.exports;
})();
class ConvexError extends Error {}

const runNew = new Function("RULES", "ConvexError",
  "return function (ctx, doc, collection, rows, dedupeField, MAX_ROWS_PER_SLICE, notifyNewReferrals) {" +
  touchedJs +
  // The arrival credit (2026-09-30) runs inside mergeSlice after the inserts.
  // Stubbed as its switch-OFF behaviour, so this file still proves the MERGE
  // is row-for-row what it always was; cash-arrival-alerts.test.mjs runs the
  // real one.
  "const noteArrivedCash = async () => null;\n" +
  "const { pinOwnerFields, planReferralUpdate, planReferralInsert, canCloseReferrals, seesAllReferrals,\n" +
  "  switchAllows, normalizeSwitch, REFERRAL_CLOSE_GUARD_KEY } = RULES;\n" +
  // The close-guard switch (2026-10-07) is an appState row, read through
  // legacyData's readReferralSwitch. Injected per call as ctx.__switches, and
  // every read is counted so a test can prove which merges pay for it.
  "const readReferralSwitch = async (ctx, key) => {\n" +
  "  ctx.__switchReads = (ctx.__switchReads || 0) + 1;\n" +
  "  return normalizeSwitch((ctx.__switches || {})[key]);\n" +
  "};\n" +
  "return (async () => {" + js +
  "\nreturn { inserted: toInsert.length, updated: toUpdate.length, deleted, refusedAsHistory, keptCancelledReceipts," +
  " refusedNotYours, keptCloseFields, clampedStamps, refusedReferralDetentions };" +
  "})();" +
  "};")(RULES, ConvexError);

/** The OLD algorithm, verbatim. The thing the new one must still agree with. */
function referenceMerge(existing, rows, dedupeField, keyedHint) {
  const idOf = (p) => (p && typeof p === "object" ? p[dedupeField] : undefined);
  const keyed = existing.some((r) => typeof r.key === "string")
    || rows.some((r) => typeof r.key === "string") || keyedHint === true;
  const seen = new Set();
  const keep = [];
  const push = (r) => {
    const id = idOf(r.payload);
    const token = id === undefined || id === null
      ? `__nokey__${keep.length}`
      : `${keyed ? r.key ?? "" : ""} ${String(id)}`;
    if (seen.has(token)) return;
    seen.add(token);
    keep.push({ key: r.key, payload: r.payload });
  };
  for (const r of existing) push(r);
  for (const r of rows) push(r);
  return keep;
}

function fakeDb(existing) {
  const live = existing.map((r, i) => ({ ...r, _id: "row" + i }));
  let reads = 0, writes = 0;
  return {
    ctx: {
      db: {
        collect: async () => { reads += live.length; return live.slice(); },
        delete: async (id) => {
          reads++; writes++;              // Convex charges a delete as a read too
          const i = live.findIndex((r) => r._id === id);
          if (i >= 0) live.splice(i, 1);
        },
        insert: async (_t, row) => { writes++; live.push({ ...row, _id: "new" + writes }); },
        patch: async (id, fields) => {
          writes++;
          const r = live.find((x) => x._id === id);
          if (r) Object.assign(r, fields);
        },
      },
      rowsInOrder: () => live.map((r) => ({ key: r.key, payload: r.payload })),
    },
    cost: () => ({ reads, writes }),
    live,
  };
}

async function runBoth({ existing, rows, dedupeField, cutoffIso, doc, collection }) {
  const f = fakeDb(existing);
  const ctx = { db: { ...f.ctx.db }, rowsInOrder: f.ctx.rowsInOrder };
  if (cutoffIso !== undefined) ctx.__cutoffRow = { value: { iso: cutoffIso } };
  const got = await runNew(ctx, doc ?? "d", collection ?? "c", rows, dedupeField,
                           MAX_ROWS_PER_SLICE, mailSpy().fn)
    .catch((e) => { throw new Error("handler failed: " + e.message); });
  return { result: got, final: f.ctx.rowsInOrder(), cost: f.cost(),
           expected: referenceMerge(existing, rows, dedupeField) };
}

const row = (payload, key) => (key === undefined ? { payload } : { key, payload });

/**
 * A spy for the referral-mail hook, so the handler's call site really executes.
 *
 * THE CLAIM IT PINS is the whole idempotency argument for the confirmation
 * email: the referrals slice is re-sent whole on every save from every tab
 * forever, so the ONLY thing that can make an email once-per-referral is that
 * a stored id never reaches toInsert. If that ever stopped being true, every
 * save would mail every referral to six people.
 */
function mailSpy() {
  const calls = [];
  const fn = async (_ctx, me, payloads) => { calls.push({ me, payloads }); };
  return { fn, calls, mailed: () => calls.flatMap((c) => c.payloads.map((p) => p.id)) };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("\nThe merged result is identical to the old algorithm");
{
  const cases = [
    { name: "an empty slice takes everything offered",
      existing: [], rows: [row({ entryId: "a" }), row({ entryId: "b" })] },
    { name: "a re-send of identical data changes nothing",
      existing: [row({ entryId: "a" }), row({ entryId: "b" })],
      rows: [row({ entryId: "a" }), row({ entryId: "b" })] },
    { name: "one new entry appended to many",
      existing: Array.from({ length: 50 }, (_, i) => row({ entryId: "e" + i })),
      rows: Array.from({ length: 51 }, (_, i) => row({ entryId: "e" + i })) },
    { name: "STORED WINS a collision, which is the durability rule",
      existing: [row({ entryId: "a", who: "stored" })],
      rows: [row({ entryId: "a", who: "incoming" })] },
    { name: "another tab's entry this one never saw is kept",
      existing: [row({ entryId: "other-tab" })],
      rows: [row({ entryId: "mine" })] },
    { name: "a duplicate already in storage is collapsed",
      existing: [row({ entryId: "dup" }), row({ entryId: "dup" })], rows: [] },
    { name: "rows with no dedupe value are all kept, never dropped",
      existing: [row({ note: "x" }), row({ note: "y" })], rows: [row({ note: "z" })] },
    { name: "keyed rows dedupe within their key, not across",
      existing: [row({ entryId: "t1" }, "s1"), row({ entryId: "t1" }, "s2")],
      rows: [row({ entryId: "t1" }, "s1"), row({ entryId: "t2" }, "s2")] },
    { name: "keyed array payloads (ticket history) behave exactly as before",
      existing: [row([{ entryId: "a" }], "s1")],
      rows: [row([{ entryId: "a" }, { entryId: "b" }], "s1")] },
    { name: "nothing offered leaves storage untouched",
      existing: [row({ entryId: "a" })], rows: [] },
  ];

  for (const c of cases) {
    const { final, expected } = await runBoth({ ...c, dedupeField: "entryId" });
    check(c.name, same(final, expected));
  }
}

console.log("\nAppending is now cheap, which is the entire point");
{
  const existing = Array.from({ length: 1278 }, (_, i) => row({ entryId: "e" + i }));
  const rows = [...existing.map((r) => row(r.payload)), row({ entryId: "new" })];
  const { final, expected, cost } = await runBoth({ existing, rows, dedupeField: "entryId" });

  check("the result is still right", same(final, expected));
  check("only the genuinely new row is written", cost.writes === 1);
  check("nothing is deleted", final.length === 1279);
  // The old code cost 1278 (collect) + 1278 (deletes) = 2556 reads, over the
  // 4,096 limit at ~2,048 rows. Now it is the collect alone.
  check("reads are the collect alone, not doubled by deletes", cost.reads === 1278);
  check("so the ceiling is ~4,096 rows, not ~2,048", cost.reads < 4096);
}

console.log("\nA re-send of an unchanged month writes nothing at all");
{
  const existing = Array.from({ length: 300 }, (_, i) => row({ entryId: "e" + i }));
  const { cost, final } = await runBoth({
    existing, rows: existing.map((r) => row(r.payload)), dedupeField: "entryId" });
  check("zero writes", cost.writes === 0);
  check("and the slice is unchanged", final.length === 300);
}

console.log("\nA row that does NOT survive is still removed");
{
  // Storage-side duplicates must still be collapsed, or the optimisation would
  // quietly turn "keep survivors" into "keep everything".
  const { final, expected, cost } = await runBoth({
    existing: [row({ entryId: "dup" }), row({ entryId: "dup" }), row({ entryId: "keep" })],
    rows: [], dedupeField: "entryId" });
  check("the stored duplicate is deleted", final.length === 2);
  check("matching the old algorithm exactly", same(final, expected));
  check("and it really was a delete, not a skip", cost.writes === 1);
}

console.log("\nThe guarantees that were already there are still written down");
{
  check("stored still wins a collision, in the comment that explains why",
    /UNION, NEVER REPLACE|stored[\s\S]{0,40}wins/i.test(src));
  check("the row cap is unchanged", /MAX_ROWS_PER_SLICE/.test(src));
  check("and the reason for the change is recorded where it was made",
    /Convex counts a delete as a READ/.test(src));
}

console.log("\nA row touched more recently wins, which is how a referral edit lands");
{
  // 2026-09-09. Closing a referral set updatedAt on the client and re-sent the
  // list, and stored-wins discarded the edit every time. Rows without stamps
  // keep the old rule so audit and ticket history are untouched by this.
  const t1 = "2026-09-08T10:00:00.000Z", t2 = "2026-09-08T11:00:00.000Z";
  const run = async (existing, rows) => {
    const f = fakeDb(existing);
    const ctx = { db: { ...f.ctx.db }, rowsInOrder: f.ctx.rowsInOrder };
    const spy = mailSpy();
    const result = await runNew(ctx, "referrals", "behaviorReferrals", rows, "id",
                                MAX_ROWS_PER_SLICE, spy.fn);
    return { result, final: f.ctx.rowsInOrder(), cost: f.cost(), mailed: spy.mailed() };
  };
  {
    const r = await run([row({ id: "R1", status: "open", updatedAt: t1 })],
                        [row({ id: "R1", status: "closed", updatedAt: t2 })]);
    check("a newer incoming copy replaces the stored one", r.final[0].payload.status === "closed");
    // THE ONE THAT MATTERS FOR THE EMAIL. An edit to a referral already on the
    // server is an update, so nobody is mailed again about it.
    check("and nobody is emailed about a referral that was already stored",
      r.mailed.length === 0);
    check("and is counted as an update, not an insert", r.result.updated === 1 && r.result.inserted === 0);
    check("nothing is deleted to do it", r.result.deleted === 0);
    check("the read cost is still the one collect", r.cost.reads === 1);
  }
  {
    const r = await run([row({ id: "R1", status: "closed", updatedAt: t2 })],
                        [row({ id: "R1", status: "open", updatedAt: t1 })]);
    check("an older incoming copy is ignored", r.final[0].payload.status === "closed" && r.result.updated === 0);
  }
  {
    const r = await run([row({ id: "R1", status: "closed", updatedAt: t1 })],
                        [row({ id: "R1", status: "open", updatedAt: t1 })]);
    check("equal stamps keep the stored copy", r.final[0].payload.status === "closed" && r.result.updated === 0);
  }
  {
    const r = await run([row({ id: "R1", status: "closed" })],
                        [row({ id: "R1", status: "open" })]);
    check("no stamps at all keeps the stored copy, the original rule", r.final[0].payload.status === "closed");
  }
  {
    const r = await run([row({ id: "R1", status: "open", submittedAt: t1 })],
                        [row({ id: "R1", status: "closed", submittedAt: t1, loopClosedAt: t2 })]);
    check("the latest of the four stamps decides, not just updatedAt", r.final[0].payload.status === "closed");
  }
  {
    const r = await run([row({ id: "R1", status: "open", updatedAt: t1 })],
                        [row({ id: "R1", status: "closed", updatedAt: t2 }), row({ id: "R2", updatedAt: t2 })]);
    check("an update and an insert in the same batch both land",
      r.result.updated === 1 && r.result.inserted === 1 && r.final.length === 2);
  }
}

console.log("\nThe referral email fires on the insert, and only on the insert");
{
  // THE WHOLE IDEMPOTENCY ARGUMENT, pinned here rather than reasoned about.
  //
  // The referrals slice is re-sent whole on every save from every tab forever.
  // Nothing debounces it and nothing marks it clean. So the only reason a
  // confirmation email is sent once per referral rather than once per save is
  // that a stored id never reaches toInsert. If that stops being true, every
  // save mails every referral to six people and the Chief of Schools finds out
  // before we do.
  const run = async (existing, rows, doc = "referrals", coll = "behaviorReferrals") => {
    const f = fakeDb(existing);
    const ctx = { db: { ...f.ctx.db }, rowsInOrder: f.ctx.rowsInOrder };
    const spy = mailSpy();
    const result = await runNew(ctx, doc, coll, rows, "id", MAX_ROWS_PER_SLICE, spy.fn);
    return { result, mailed: spy.mailed(), calls: spy.calls };
  };

  {
    const r = await run([], [row({ id: "R9", studentName: "A Student" })]);
    check("a genuinely new referral is mailed", r.mailed.length === 1);
    check("and it is the one that was inserted", r.mailed[0] === "R9");
    check("counted as an insert", r.result.inserted === 1);
    // The recipient comes from the token, never from the payload.
    check("the filer passed on is the verified account, not a payload field",
      r.calls[0].me.email === "filer@example.org");
  }
  {
    // The same referral coming back on the next save, unchanged.
    const r = await run([row({ id: "R9", studentName: "A Student" })],
                        [row({ id: "R9", studentName: "A Student" })]);
    check("a re-sent referral is mailed to nobody", r.mailed.length === 0);
    check("and wrote nothing", r.result.inserted === 0 && r.result.updated === 0);
  }
  {
    // Two new, one already stored: only the new ones.
    const r = await run([row({ id: "R1" })], [row({ id: "R1" }), row({ id: "R2" }), row({ id: "R3" })]);
    check("a mixed save mails only the new referrals",
      r.mailed.length === 2 && r.mailed.includes("R2") && r.mailed.includes("R3"));
    check("and not the stored one", !r.mailed.includes("R1"));
  }
  {
    // Every other slice in the app goes through this same mutation.
    const r = await run([], [row({ id: "T1" })], "main", "wildcatCashRewards");
    check("no other collection triggers referral mail", r.mailed.length === 0);
    // A different collection under doc 'referrals' is now refused outright
    // (2026-10-07; no real tab sends one), so it mails nobody by throwing.
    const spy2 = mailSpy();
    const f2 = fakeDb([]);
    const threw2 = await runNew({ db: { ...f2.ctx.db } }, "referrals", "somethingElse", [row({ id: "T2" })], "id",
      MAX_ROWS_PER_SLICE, spy2.fn).then(() => null, (e) => e);
    check("nor a different collection in the referrals doc (refused, so nobody is mailed)",
      threw2 instanceof ConvexError && spy2.mailed().length === 0);
  }
}

console.log("\n-- the history cutoff: a stale tab cannot re-insert last term --");
{
  // THE INCIDENT THIS CLOSES, 2026-09-13 and 14. Pre-launch rows deleted from
  // the cash ledger and the referrals came back repeatedly through the insert
  // path here: the slice merges by id, a DELETED stored row is no longer a
  // collision, so a tab open since before the clear re-inserted its whole copy
  // on its next save. Three stores, three times in one day.
  //
  // The only remedy until now was asking 40+ staff to hard-refresh, which the
  // owner said plainly is never feasible -- there is no channel that reaches
  // them all and no way to confirm. A fix that needs every human to cooperate
  // is not a fix, so the SERVER refuses and a stale tab becomes harmless.
  const CUT = "2026-09-14T15:30:00Z";
  const oldRow  = { id: "r-old",  submittedAt: "2026-08-20T16:37:14.634Z" };
  const newRow  = { id: "r-new",  submittedAt: "2026-09-14T19:36:56.719Z" };
  const noDate  = { id: "r-none" };

  const refs = async (rows, existing = []) => runBoth({
    existing, rows: rows.map((p) => ({ payload: p })), dedupeField: "id",
    cutoffIso: CUT, doc: "referrals", collection: "behaviorReferrals",
  });

  let r = await refs([oldRow]);
  check("a pre-cutoff referral is refused", r.result.inserted === 0);
  check("and the refusal is counted, not silent", r.result.refusedAsHistory === 1);
  check("so nothing lands in the slice", r.final.length === 0);

  r = await refs([newRow]);
  check("today's referral still lands", r.result.inserted === 1);
  check("and is not counted as refused", r.result.refusedAsHistory === 0);

  r = await refs([oldRow, newRow]);
  check("a mixed save keeps today and drops last term",
    r.result.inserted === 1 && r.result.refusedAsHistory === 1);
  check("and the one kept is the new one", r.final[0].payload.id === "r-new");

  // AN UNDATED ROW IS INSERTED. It cannot be proved old, and refusing it would
  // lose real work in order to be tidy.
  r = await refs([noDate]);
  check("an undated row is inserted rather than refused",
    r.result.inserted === 1 && r.result.refusedAsHistory === 0);

  // UPDATES ARE NOT GUARDED. A referral being CLOSED is an edit to a row that
  // is already here, and closing the loop on an old referral must still work.
  const storedOld = [{ key: undefined, payload: { ...oldRow, updatedAt: "2026-08-21T00:00:00Z" } }];
  r = await refs([{ ...oldRow, updatedAt: "2026-09-14T20:00:00Z", status: "closed" }], storedOld);
  check("closing a pre-cutoff referral still updates it", r.result.updated === 1);
  check("and is not refused", r.result.refusedAsHistory === 0);
  check("the edit really landed", r.final[0].payload.status === "closed");

  // THE ALLOWLIST. mergeSlice also carries detentions, hall passes, prevention
  // groups, receipts and the rewards catalogue, and NONE of those is history:
  // a detention gets marked served, a receipt fulfilled, a reward repriced.
  // Guarding them would refuse legitimate edits.
  r = await runBoth({
    existing: [], rows: [{ payload: oldRow }], dedupeField: "id",
    cutoffIso: CUT, doc: "secondary", collection: "detentions",
  });
  check("a non-history slice is NOT guarded", r.result.inserted === 1);
  check("and reports no refusal", r.result.refusedAsHistory === 0);

  // The cash ledger is guarded by its DOC name, not its collection.
  r = await runBoth({
    existing: [], rows: [{ payload: { id: "t1", timestamp: "2026-08-20T16:00:00Z" } }],
    dedupeField: "id", cutoffIso: CUT, doc: "cash_tx_2026_W34", collection: "transactions",
  });
  check("the cash ledger is guarded too", r.result.inserted === 0 && r.result.refusedAsHistory === 1);

  // NO CUTOFF SET means nothing is guarded -- the behaviour every slice had
  // before this existed.
  r = await runBoth({
    existing: [], rows: [{ payload: oldRow }], dedupeField: "id",
    doc: "referrals", collection: "behaviorReferrals",
  });
  check("with no cutoff set, nothing is refused",
    r.result.inserted === 1 && r.result.refusedAsHistory === 0);

  // CLOCK SLACK. The row's date comes from the client, so a device with a
  // wrong clock could stamp a new filing in the past. An hour of slack means a
  // clock has to be badly wrong before real work is lost; last term is months
  // out and still refused.
  r = await refs([{ id: "r-skew", submittedAt: "2026-09-14T15:00:00Z" }]);
  check("a row 30 minutes before the cutoff is still accepted (clock slack)",
    r.result.inserted === 1);
  r = await refs([{ id: "r-way-off", submittedAt: "2026-09-14T13:00:00Z" }]);
  check("a row two hours before it is not", r.result.inserted === 0);
}

console.log("\n-- an update keeps fields the client never sent --");
{
  // THE RULE mergeIncoming ALREADY STATES for students: "never write an
  // absence, in either direction." This path replaced the whole payload, so any
  // field a browser did not know about was erased the next time somebody
  // edited that row.
  //
  // It bit within the hour of shipping the student store. Rewards gained a
  // server-owned `studentPurchasable` flag with no admin toggle yet; the owner
  // repriced Front of Line Pass and switched it on; the Rewards editor
  // round-tripped the object without that field and wiped it. Two rewards were
  // on and only one appeared in the store, with nothing on screen to say why.
  const src = readFileSync(new URL("./legacyData.ts", import.meta.url), "utf8");
  const merge = new Function("stored", "incoming",
    src.slice(src.indexOf("function mergeRowFields"),
              src.indexOf("\n}", src.indexOf("function mergeRowFields")) + 2)
       .replace(/: unknown/g, "").replace(/ as Record<string, unknown>/g, "")
    + "\nreturn mergeRowFields(stored, incoming);");

  const stored = { id: "r4", name: "Front of Line Pass", cost: 500,
                   available: false, studentPurchasable: true };
  const edited = { id: "r4", name: "Front of Line Pass", cost: 100, available: true };
  const out = merge(stored, edited);
  check("a field the client omitted survives the edit", out.studentPurchasable === true);
  check("and every field it did send wins",
    out.cost === 100 && out.available === true);

  // ABSENT IS NOT NULL, which is what makes this safe: a client clearing a
  // field sends null, and a present null still wins.
  check("an explicit null still clears",
    merge(stored, { id: "r4", studentPurchasable: null }).studentPurchasable === null);
  check("and an explicit false still wins over a stored true",
    merge(stored, { id: "r4", studentPurchasable: false }).studentPurchasable === false);

  // A slice whose rows are not objects has no fields to merge.
  check("a non-object row passes straight through", merge("a", "b") === "b");
  check("and so does an array", Array.isArray(merge([1], [2])) && merge([1], [2])[0] === 2);
  check("a null stored row does not crash", merge(null, { id: "x" }).id === "x");
}

console.log("\n-- a student-store reward keeps the server's stock --");
{
  // THE POWER-UP PASS, 2026-09-29. studentStore:purchase decrements stock on
  // the stored row. An admin who fixes a typo in the pass's description from a
  // tab that loaded at 7am -- 75 left -- re-sends the whole row, and without
  // this the 40 sold since then go back on the shelf. Run through the SHIPPED
  // handler, not a copy.
  const T0 = "2026-09-28T20:00:00.000Z";   // an admin set stock to 75
  const T2 = "2026-09-29T15:00:00.000Z";   // the server's last decrement
  const T3 = "2026-09-29T16:00:00.000Z";   // the admin's edit, later still
  const storedPass = { id: "p_ms", name: "Power-Up Pass (Middle School)", cost: 1500,
    stock: 35, stockSetAt: T0, studentPurchasable: true, updatedAt: T2, description: "old" };
  const final = async (incoming, stored = storedPass, collection = "wildcatCashRewards") =>
    (await runBoth({ existing: [row(stored)], rows: [row(incoming)], dedupeField: "id",
                     doc: "secondary", collection })).final[0].payload;

  const typo = await final({ ...storedPass, stock: 75, description: "new", updatedAt: T3 });
  check("an edit that did not touch stock keeps the server's count", typo.stock === 35);
  check("and the rest of the edit still lands", typo.description === "new");

  const oldClient = { ...storedPass, stock: 75, description: "new", updatedAt: T3 };
  delete oldClient.stockSetAt;
  check("a tab from before stockSetAt existed cannot restock it either",
    (await final(oldClient)).stock === 35);

  const deliberate = await final({ ...storedPass, stock: 100, stockSetAt: T3, updatedAt: T3 });
  check("an admin who typed a new stock number gets it", deliberate.stock === 100);
  check("and the stamp moves with it, so the next stale copy loses", deliberate.stockSetAt === T3);

  const sameStamp = await final({ ...storedPass, stock: 75, stockSetAt: T0, updatedAt: T3 });
  check("re-sending the SAME stamp is not a new decision", sameStamp.stock === 35);

  // AN EDIT MADE DURING THE SALE LANDS. A purchase no longer moves updatedAt
  // (it writes stockMovedAt), so the admin's edit, stamped after the last
  // HUMAN edit, is newer -- even though children bought since.
  const T1 = "2026-09-29T15:30:00.000Z";
  const selling = { ...storedPass, updatedAt: T0, stockMovedAt: T2 };
  const repriced = await final({ ...storedPass, cost: 1200, available: false, stock: 75,
    updatedAt: T1, stockMovedAt: undefined }, selling);
  check("an admin's price change during the sale is not thrown away",
    repriced.cost === 1200 && repriced.available === false);
  check("and the count stays the server's", repriced.stock === 35);

  // Staff-sold rewards are untouched: nothing on the server moves their stock,
  // so the tab's decrement is still the truth.
  const staffItem = { ...storedPass, studentPurchasable: false };
  check("a reward staff sell by hand still takes the tab's stock",
    (await final({ ...staffItem, stock: 34, updatedAt: T3 }, staffItem)).stock === 34);
  check("and other collections are not touched at all",
    (await final({ ...storedPass, stock: 75, updatedAt: T3 }, storedPass, "c")).stock === 75);

  // An unticked flag in the same edit: the STORED copy decides, so the count
  // the server holds is not dropped on the way out of the student store.
  const unticked = await final({ ...storedPass, stock: 75, studentPurchasable: false, updatedAt: T3 });
  check("unticking 'students can buy' does not restock it on the way out",
    unticked.stock === 35 && unticked.studentPurchasable === false);
}

console.log("\nA cancelled store receipt is final (2026-10-02)");
{
  // A stale or offline tab sending its older "issued" or "fulfilled" copy of
  // a receipt that is already cancelled -- or an Unfulfil made against one --
  // reopened it on the server and wiped refundTxId, while the refund (its own
  // ledger row) stayed: the same purchase could then be refunded twice.
  const t1 = "2026-10-02T16:00:00.000Z", t2 = "2026-10-02T16:05:00.000Z";
  const run = async (existing, rows, doc = "secondary", coll = "cashReceipts") => {
    const f = fakeDb(existing);
    const ctx = { db: { ...f.ctx.db }, rowsInOrder: f.ctx.rowsInOrder };
    const result = await runNew(ctx, doc, coll, rows, "id", MAX_ROWS_PER_SLICE, mailSpy().fn);
    return { result, final: f.ctx.rowsInOrder() };
  };
  const cancelled = row({ id: "WC-1", status: "cancelled", refundTxId: "txn_r1", updatedAt: t1 });
  {
    const r = await run([cancelled], [row({ id: "WC-1", status: "issued", updatedAt: t2 })]);
    check("a NEWER 'issued' copy does not reopen a cancelled receipt",
      r.final[0].payload.status === "cancelled" && r.final[0].payload.refundTxId === "txn_r1");
    check("...and the server says it kept it", r.result.keptCancelledReceipts === 1 && r.result.updated === 0);
  }
  {
    const r = await run([cancelled], [row({ id: "WC-1", status: "fulfilled", updatedAt: t2 })]);
    check("...nor does a newer 'fulfilled' copy", r.final[0].payload.status === "cancelled");
  }
  {
    const r = await run([cancelled], [row({ id: "WC-1", status: "cancelled", refundTxId: "txn_r1", cancelReason: "Corrected", updatedAt: t2 })]);
    check("a newer CANCELLED copy still updates it (a corrected reason)",
      r.final[0].payload.cancelReason === "Corrected" && r.result.updated === 1);
  }
  {
    const r = await run([row({ id: "WC-2", status: "fulfilled", updatedAt: t1 })],
                        [row({ id: "WC-2", status: "issued", updatedAt: t2 })]);
    check("an Unfulfil of a FULFILLED receipt still lands (only cancelled is final)",
      r.final[0].payload.status === "issued" && r.result.updated === 1);
  }
  {
    const r = await run([row({ id: "WC-3", status: "cancelled", updatedAt: t1 })],
                        [row({ id: "WC-3", status: "issued", updatedAt: t2 })], "referrals", "behaviorReferrals");
    check("the rule is the store receipts' alone: other lists merge as before",
      r.final[0].payload.status === "issued");
  }
}

console.log("\nForged referral shapes are refused; the app's own call is untouched (2026-10-07)");
{
  // THE HOLES. mergeSlice took any doc, collection and dedupeField from any
  // staff member. Three shapes the app never sends could each damage every
  // referral in the school; they are now refused before anything is read.
  // The app's ONE referral write -- mergeLegacySlice('referrals',
  // 'behaviorReferrals', list, 'id') with unkeyed rows -- must merge exactly
  // as it did.
  const seeded = () => [
    row({ id: "R1", status: "open", updatedAt: "2026-09-20T10:00:00.000Z" }),
    row({ id: "R2", status: "open", updatedAt: "2026-09-20T10:00:00.000Z" }),
    row({ id: "R3", status: "closed", updatedAt: "2026-09-20T10:00:00.000Z" }),
    row({ id: "R4", status: "closed", updatedAt: "2026-09-20T10:00:00.000Z" }),
  ];
  const attempt = async (collection, rows, dedupeField, existing = seeded()) => {
    const f = fakeDb(existing);
    const ctx = { db: { ...f.ctx.db } };
    const spy = mailSpy();
    const err = await runNew(ctx, "referrals", collection, rows, dedupeField, MAX_ROWS_PER_SLICE, spy.fn)
      .then(() => null, (e) => e);
    return { err, final: f.ctx.rowsInOrder(), cost: f.cost(), mailed: spy.mailed() };
  };
  const refusedProperly = (e) => e instanceof ConvexError && /behaviorReferrals by id only/.test(e.message);

  let a = await attempt("behaviorReferrals", [], "status");
  check("dedupeField 'status' is refused with the readable reason", refusedProperly(a.err), a.err && a.err.message);
  check("...and every seeded referral is still there (it used to delete 2 of 4 here, 16 of 18 in prod)",
    a.final.length === 4 && a.cost.writes === 0);
  check("...and nothing was even read", a.cost.reads === 0);

  a = await attempt("behaviorReferrals", [row({ id: "R9", status: "open" }, "k1")], "id");
  check("a keyed referral row is refused", refusedProperly(a.err));
  check("...and nothing is written or mailed", a.final.length === 4 && a.cost.writes === 0 && a.mailed.length === 0);

  a = await attempt("other", [row({ id: "R9" })], "id");
  check("another collection under doc 'referrals' is refused", refusedProperly(a.err));

  a = await attempt("behaviorReferrals", [row({ id: "R9" })], "entryId");
  check("any dedupeField but 'id' is refused, not only 'status'", refusedProperly(a.err));

  // THE CLAIM. Ownership is matched on these emails, so a newer copy that
  // names you must not make a colleague's referral yours.
  const t1 = "2026-09-20T10:00:00.000Z", t2 = "2026-09-21T10:00:00.000Z";
  const theirs = row({ id: "R1", filedByEmail: "them@school.org", referredByEmail: "them@school.org",
    submittedAt: t1, updatedAt: t1, status: "open", description: "old" });
  a = await attempt("behaviorReferrals", [row({ ...theirs.payload, filedByEmail: "me@school.org",
    referredByEmail: "me@school.org", submittedAt: t2, id: "R1", description: "new", updatedAt: t2 })], "id", [theirs]);
  const landed = a.final[0].payload;
  check("a newer copy naming a different filer lands its other edits", !a.err && landed.description === "new");
  check("...but keeps the stored filedByEmail, referredByEmail and submittedAt",
    landed.filedByEmail === "them@school.org" && landed.referredByEmail === "them@school.org" && landed.submittedAt === t1);

  // THE APP'S REAL CALL: every outcome counted as before, by the same rule.
  const realShape = [
    [[row({ id: "R1", status: "open", updatedAt: t1 })], [row({ id: "R1", status: "closed", updatedAt: t2 })], { inserted: 0, updated: 1, deleted: 0 }],
    [[row({ id: "R1", status: "closed", updatedAt: t2 })], [row({ id: "R1", status: "open", updatedAt: t1 })], { inserted: 0, updated: 0, deleted: 0 }],
    [[row({ id: "R1", updatedAt: t1 })], [row({ id: "R1", updatedAt: t1 }), row({ id: "R2", updatedAt: t2 })], { inserted: 1, updated: 0, deleted: 0 }],
    [[row({ id: "R1" }), row({ id: "R1" })], [], { inserted: 0, updated: 0, deleted: 1 }],
    [[], [row({ id: "R5" }), row({ id: "R6" })], { inserted: 2, updated: 0, deleted: 0 }],
  ];
  let allSame = true;
  for (const [existing, rows, want] of realShape) {
    const f = fakeDb(existing);
    const res = await runNew({ db: { ...f.ctx.db } }, "referrals", "behaviorReferrals", rows, "id", MAX_ROWS_PER_SLICE, mailSpy().fn);
    if (res.inserted !== want.inserted || res.updated !== want.updated || res.deleted !== want.deleted) allSame = false;
  }
  check("the app's own call shape gives the same inserted/updated/deleted as before", allSame);

  // CONTROLS: the refusal is the referrals doc's alone.
  const ok = async (doc, collection, rows, dedupeField) => {
    const f = fakeDb([]);
    return runNew({ db: { ...f.ctx.db } }, doc, collection, rows, dedupeField, MAX_ROWS_PER_SLICE, mailSpy().fn)
      .then((r) => r.inserted, (e) => "threw " + e.message);
  };
  check("control: secondary detentions still merge", (await ok("secondary", "detentions", [row({ id: "d1" })], "id")) === 1);
  check("control: store receipts still merge", (await ok("secondary", "cashReceipts", [row({ id: "WC-1" })], "id")) === 1);
  check("control: a cash week still merges", (await ok("cash_tx_2026_W40", "transactions", [row({ id: "t1" })], "id")) === 1);
  check("control: keyed ticket history still merges", (await ok("ticket_history_ms", "histories", [row([{ entryId: "a" }], "s1")], "entryId")) === 1);
  check("control: an audit week on entryId still merges", (await ok("audit_log_2026_W40", "auditLog", [row({ entryId: "e1" })], "entryId")) === 1);
}

console.log("\nThe close guard: a non-closer's copy cannot close, claim or lock a referral (2026-10-07)");
{
  // Behind the appState switch 'referralCloseGuard'. Only admin, superadmin
  // and PBIS close referrals; with the switch on for anyone else, their tab's
  // copies are taken row by row -- their own edits land, close fields keep
  // the stored values, other people's rows are skipped -- and NOTHING THROWS,
  // because an old tab re-sends every referral it holds on every save.
  const T = { email: "teacher.one@school.org", name: "Teacher One", role: "teacher" };
  const ADMIN = { email: "admin@school.org", name: "An Admin", role: "admin" };
  const PBIS = { email: "pbis@school.org", name: "Pbis Lead", role: "pbis" };
  const ON = { referralCloseGuard: { enabled: true } };
  const past = new Date(Date.now() - 5 * 86400e3).toISOString();
  const recent = new Date(Date.now() - 60e3).toISOString();
  const ref = (i, who, extra) => ({ id: "R" + i, studentName: "Student " + i, description: "d" + i,
    status: i % 3 ? "open" : "closed", adminNotes: i % 3 ? "" : "met parent", closedBy: i % 3 ? "" : "An Admin",
    closedAt: i % 3 ? "" : past, loopClosed: false, loopClosedBy: "", loopClosedAt: "", forwardedTo: [],
    resolutionType: "", closingActions: [], filedByEmail: who, referredByEmail: who,
    submittedAt: past, updatedAt: past, ...extra });
  // 18 rows, as production holds: 5 filed by this teacher, 13 by others.
  const SEED = Array.from({ length: 18 }, (_, i) => row(ref(i + 1, i < 5 ? T.email : `other${i}@school.org`)));
  const go = async ({ me, existing = SEED, rows, switches = ON, doc = "referrals", coll = "behaviorReferrals" }) => {
    const f = fakeDb(existing);
    const ctx = { db: { ...f.ctx.db }, __me: me, __switches: switches };
    const spy = mailSpy();
    const res = await runNew(ctx, doc, coll, rows, "id", MAX_ROWS_PER_SLICE, spy.fn).then((r) => r, (e) => ({ threw: e }));
    return { res, final: f.ctx.rowsInOrder().map((r) => r.payload), byId: (id) => f.ctx.rowsInOrder().find((r) => r.payload.id === id)?.payload,
      mailed: spy.mailed(), mailCalls: spy.calls, switchReads: ctx.__switchReads || 0 };
  };
  const copy = (p) => JSON.parse(JSON.stringify(p));

  {
    // THE OLD TEACHER TAB: every row it loaded, unchanged, plus a new filing.
    const fresh = ref(98, T.email, { submittedAt: recent, updatedAt: recent });   // 98: an open one
    const g = await go({ me: T, rows: [...SEED.map((r) => row(copy(r.payload))), row(fresh)] });
    check("an old teacher tab's whole-list save does not throw", !g.res.threw, g.res.threw && g.res.threw.message);
    check("...its new referral is inserted", g.res.inserted === 1 && !!g.byId("R98"));
    check("...and mailed, to the verified filer", g.mailed.join() === "R98" && g.mailCalls[0].me.email === T.email);
    check("...nothing else is written", g.res.updated === 0 && g.res.deleted === 0);
    check("...the 13 rows that are not theirs are counted as notYours", g.res.refusedNotYours === 13);
    check("...and every stored row is byte-identical to before",
      SEED.every((r) => JSON.stringify(g.byId(r.payload.id)) === JSON.stringify(r.payload)));
    check("...and its own unchanged copies are NOT counted as close attempts (stale)", g.res.keptCloseFields === 0);
  }
  {
    // CLICKING CLOSE IN AN OLD TAB, on their own referral.
    const mine = copy(SEED[0].payload);
    const g = await go({ me: T, rows: [row({ ...mine, status: "closed", closedAt: recent, closedBy: T.name,
      adminNotes: "sorted it", resolutionType: "action_taken", closingActions: ["x"], updatedAt: recent })] });
    check("a teacher's Close on their own referral leaves it open", g.byId("R1").status === "open");
    check("...with the admin notes and close fields as they were", g.byId("R1").adminNotes === "" && g.byId("R1").closedBy === "");
    check("...counted as keptCloseFields, not written", g.res.keptCloseFields === 1 && g.res.updated === 0);
  }
  {
    const g = await go({ me: T, rows: [row({ ...copy(SEED[1].payload), description: "corrected", updatedAt: recent })] });
    check("a teacher's own description edit lands", g.byId("R2").description === "corrected" && g.res.updated === 1);
  }
  {
    const g = await go({ me: T, rows: [row({ ...copy(SEED[10].payload), description: "mine now", updatedAt: recent })] });
    check("a teacher's edit to someone else's referral is skipped", g.byId("R11").description === "d11" && g.res.refusedNotYours === 1);
  }
  {
    // THE LOCK. A copy stamped 9999 used to win every later merge, so no
    // admin's close could ever land on that referral again.
    const mine = copy(SEED[3].payload);   // R4: theirs, and open
    const g = await go({ me: T, rows: [row({ ...mine, description: "edit", updatedAt: "9999-01-01T00:00:00.000Z" })] });
    const lockedAt = g.byId("R4").updatedAt;
    check("a teacher's 9999 stamp is pulled back to the server's clock", !lockedAt.startsWith("9999") && g.res.clampedStamps === 1);
    const adminClose = new Date(Date.now() + 60e3).toISOString();
    const f = fakeDb([row(g.byId("R4"))]);
    await runNew({ db: { ...f.ctx.db }, __me: ADMIN, __switches: ON }, "referrals", "behaviorReferrals",
      [row({ ...g.byId("R4"), status: "closed", closedAt: adminClose, closedBy: ADMIN.name, adminNotes: "done", updatedAt: adminClose })],
      "id", MAX_ROWS_PER_SLICE, mailSpy().fn);
    check("...so an admin's close afterwards still lands", f.ctx.rowsInOrder()[0].payload.status === "closed");
    // The control: without the guard the 9999 stamp is stored and the
    // admin's close is thrown away -- the bug.
    const off = await go({ me: T, switches: {}, rows: [row({ ...mine, description: "edit", updatedAt: "9999-01-01T00:00:00.000Z" })] });
    const f2 = fakeDb([row(off.byId("R4"))]);
    await runNew({ db: { ...f2.ctx.db }, __me: ADMIN }, "referrals", "behaviorReferrals",
      [row({ ...off.byId("R4"), status: "closed", closedAt: adminClose, updatedAt: adminClose })], "id", MAX_ROWS_PER_SLICE, mailSpy().fn);
    check("control: with the guard off the 9999 copy is stored and the admin's close is lost (today's bug)",
      f2.ctx.rowsInOrder()[0].payload.status === "open");
  }
  for (const who of [ADMIN, PBIS]) {
    const g = await go({ me: who, rows: [row({ ...copy(SEED[12].payload), status: "closed", closedAt: recent,
      closedBy: who.name, adminNotes: "closed by " + who.role, updatedAt: recent })] });
    check(`${who.role}'s close lands on anyone's referral, with the guard on`,
      g.byId("R13").status === "closed" && g.byId("R13").adminNotes === "closed by " + who.role && g.res.updated === 1);
    check(`...and ${who.role} pays no switch read`, g.switchReads === 0);
  }
  {
    const g = await go({ me: T, rows: [row(ref(50, T.email, { status: "closed", closedAt: recent, closedBy: T.name,
      adminNotes: "pre-closed", submittedAt: recent, updatedAt: recent }))] });
    check("a teacher's new referral sent already closed is filed OPEN", g.byId("R50").status === "open"
      && g.byId("R50").adminNotes === "" && g.byId("R50").closedAt === "" && g.res.inserted === 1);
    check("...counted as keptCloseFields", g.res.keptCloseFields === 1);
  }
  {
    // An admin deleted a colleague's referral; this teacher's old tab still holds it.
    const deleted = copy(SEED[14].payload);
    const g = await go({ me: T, existing: SEED.filter((r) => r.payload.id !== deleted.id), rows: [row({ ...deleted, submittedAt: recent })] });
    check("an old tab cannot re-file a colleague's deleted referral", !g.byId(deleted.id) && g.res.inserted === 0 && g.res.refusedNotYours === 1);
    check("...and nobody is mailed about it", g.mailed.length === 0);
  }
  {
    // GUARD OFF: no row, a pilot list without this teacher, or switched off.
    for (const [label, switches] of [["no switch row", {}], ["a pilot list without them", { referralCloseGuard: { enabled: true, pilotEmails: ["someone@school.org"] } }],
      ["switched off", { referralCloseGuard: { enabled: false } }]]) {
      const g = await go({ me: T, switches, rows: [row({ ...copy(SEED[0].payload), status: "closed", closedAt: recent, adminNotes: "mine", updatedAt: recent })] });
      check(`${label}: a teacher's close lands exactly as today`, g.byId("R1").status === "closed" && g.res.updated === 1
        && g.res.keptCloseFields === 0 && g.res.refusedNotYours === 0);
    }
    const g = await go({ me: T, switches: { referralCloseGuard: { enabled: true, pilotEmails: [T.email] } },
      rows: [row({ ...copy(SEED[0].payload), status: "closed", closedAt: recent, updatedAt: recent })] });
    check("a pilot list naming them: guarded", g.byId("R1").status === "open" && g.res.keptCloseFields === 1);
  }
  {
    // THE DETENTION A REFUSED CLOSE WOULD LEAVE BEHIND. Closing with the
    // detention action makes a detention in the same save; if the close is
    // kept open, the detention must not land either, or the admin's real
    // close makes a second one for the same referral.
    const det = (id, extra) => ({ id, studentName: "Student 1", status: "active", totalDays: 1, ...extra });
    const g = await go({ me: T, doc: "secondary", coll: "detentions", existing: [],
      rows: [row(det("detention_7", { sourceReferralId: "R1", reason: "Referral R1: x" }))] });
    check("a teacher's detention made from a referral is not inserted", g.res.inserted === 0 && g.res.refusedReferralDetentions === 1);
    check("...and the merge paid one switch read", g.switchReads === 1);
    const plain = await go({ me: T, doc: "secondary", coll: "detentions", existing: [], rows: [row(det("detention_8"))] });
    check("a detention not made from a referral is not this rule's business", plain.res.inserted === 1);
    const adm = await go({ me: ADMIN, doc: "secondary", coll: "detentions", existing: [],
      rows: [row(det("detention_9", { sourceReferralId: "R1" }))] });
    check("an admin's detention from a referral is inserted", adm.res.inserted === 1 && adm.res.refusedReferralDetentions === 0);
    const off = await go({ me: T, switches: {}, doc: "secondary", coll: "detentions", existing: [],
      rows: [row(det("detention_10", { sourceReferralId: "R1" }))] });
    check("with the guard off, a teacher's is inserted as today", off.res.inserted === 1);
    // The whole old-tab Close-with-detention sequence: two merges, one save.
    const close = await go({ me: T, rows: [row({ ...copy(SEED[0].payload), status: "closed", closedAt: recent,
      closingActions: ["Assigned the student to mandatory detention"], detentionDays: 2, updatedAt: recent })] });
    const detSave = await go({ me: T, doc: "secondary", coll: "detentions", existing: [],
      rows: [row(det("detention_11", { sourceReferralId: "R1" }))] });
    check("an old tab's Close with the detention action: referral kept open AND no detention",
      close.byId("R1").status === "open" && close.res.keptCloseFields === 1 && detSave.res.inserted === 0);
  }
  {
    // CONTROLS: what the switch read costs, and who it touches.
    const cash = await go({ me: T, doc: "cash_tx_2026_W40", coll: "transactions", existing: [], rows: [row({ id: "t1" })] });
    const recs = await go({ me: T, doc: "secondary", coll: "cashReceipts", existing: [], rows: [row({ id: "WC-1", sourceReferralId: "R1" })] });
    const passes = await go({ me: T, doc: "secondary", coll: "hallPasses", existing: [], rows: [row({ id: "p1" })] });
    check("control: cash weeks, receipts and passes merge as before, with no switch read",
      cash.res.inserted === 1 && recs.res.inserted === 1 && passes.res.inserted === 1
      && cash.switchReads + recs.switchReads + passes.switchReads === 0);
    const t = await go({ me: T, rows: [] });
    check("a teacher's referral merge pays exactly one switch read", t.switchReads === 1);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
