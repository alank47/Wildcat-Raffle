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
  .replace(/const me = await requireStaff\(ctx\);/,
           'const me = { email: "filer@example.org", name: "Test Filer" };')
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
].join("\n");
const touchedJs = ts.transpileModule(moduleScopeTs, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

const runNew = new Function("ctx", "doc", "collection", "rows", "dedupeField",
  "MAX_ROWS_PER_SLICE", "notifyNewReferrals",
  touchedJs +
  "return (async () => {" + js +
  "\nreturn { inserted: toInsert.length, updated: toUpdate.length, deleted, refusedAsHistory };" +
  "})();");

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
    const r2 = await run([], [row({ id: "T2" })], "referrals", "somethingElse");
    check("nor a different collection in the referrals doc", r2.mailed.length === 0);
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

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
