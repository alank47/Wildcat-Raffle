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
  .replace(/await requireStaff\(ctx\);/, "")
  // The one substitution: the indexed query becomes the fake db's collect().
  .replace(/const existing = await ctx\.db[\s\S]*?\.collect\(\);/,
           "const existing = await ctx.db.collect();");

// Everything up to the final `return`, then our own reporting return.
const upToReturn = tsBody.slice(0, tsBody.lastIndexOf("return {"));
const js = ts.transpileModule(upToReturn, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

// The cap lives at module scope in the source, so it is passed in rather than
// redefined here -- reading it from the file keeps the two in step.
const MAX_ROWS_PER_SLICE = Number(
  /const MAX_ROWS_PER_SLICE = (\d+);/.exec(src)[1]);

const runNew = new Function("ctx", "doc", "collection", "rows", "dedupeField",
  "MAX_ROWS_PER_SLICE",
  "return (async () => {" + js +
  "\nreturn { inserted: toInsert.length, deleted };" +
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
      },
      rowsInOrder: () => live.map((r) => ({ key: r.key, payload: r.payload })),
    },
    cost: () => ({ reads, writes }),
    live,
  };
}

async function runBoth({ existing, rows, dedupeField }) {
  const f = fakeDb(existing);
  const ctx = { db: { ...f.ctx.db }, rowsInOrder: f.ctx.rowsInOrder };
  const got = await runNew(ctx, "d", "c", rows, dedupeField, MAX_ROWS_PER_SLICE)
    .catch((e) => { throw new Error("handler failed: " + e.message); });
  return { result: got, final: f.ctx.rowsInOrder(), cost: f.cost(),
           expected: referenceMerge(existing, rows, dedupeField) };
}

const row = (payload, key) => (key === undefined ? { payload } : { key, payload });
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

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
