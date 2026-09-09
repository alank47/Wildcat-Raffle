// The cash ledger is unioned, never replaced. Run: npm test
//
// THE INCIDENT SHAPE. Each cash_tx_<week> document is sent by the app as the
// whole array a tab holds in memory, and legacyData:saveSlice deleted every
// stored row before writing it. A tab that loaded the week an hour ago and
// then saved deleted every award a colleague had landed since. Forty teachers
// award in the same week every week, so this was not a corner case.
//
// unionCashRows is lifted out of the shipped legacyData.ts and run against
// that shape. The handler-level check pins that saveSlice routes cash
// documents through it and never reaches the delete loop for them.
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("./legacyData.ts", import.meta.url), "utf8");
let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

const start = src.indexOf("export function unionCashRows(");
const end = src.indexOf("\n}\n", start) + 3;
const js = ts.transpileModule(src.slice(start, end).replace("export function", "function"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const unionCashRows = new Function(js + "\nreturn unionCashRows;")();

const tx = (id, extra) => ({ payload: { id, amount: 100, ...(extra || {}) } });

console.log("\nA stale tab cannot delete what it never saw");
{
  // Stored: the week as it is on the server, including a colleague's award C.
  // Incoming: an older snapshot that has A and B, plus this tab's new award D.
  const stored = [tx("A"), tx("B"), tx("C")];
  const fresh = unionCashRows(stored, [tx("A"), tx("B"), tx("D")]);
  check("only the genuinely new row is written", fresh.length === 1 && fresh[0].payload.id === "D");
  check("the colleague's award is not in the write set, so nothing can delete it",
    !fresh.some((r) => r.payload.id === "C"));
}
{
  const fresh = unionCashRows([tx("A")], [tx("A"), tx("A")]);
  check("a duplicate within one batch is written once at most", fresh.length === 0);
  const fresh2 = unionCashRows([], [tx("X"), tx("X")]);
  check("even when nothing is stored yet", fresh2.length === 1);
}
{
  const fresh = unionCashRows([tx("A")], [{ payload: { amount: 5 } }]);
  check("a row with no id cannot be compared and is kept rather than dropped", fresh.length === 1);
}
{
  const fresh = unionCashRows([tx("A", { amount: 100 })], [tx("A", { amount: 999 })]);
  check("a re-sent id never overwrites the stored movement (a cash row is never edited)", fresh.length === 0);
}
{
  const fresh = unionCashRows([], []);
  check("empty in, empty out", fresh.length === 0);
}

console.log("\nsaveSlice routes cash documents through the union and never deletes them");
{
  const handler = src.slice(src.indexOf("export const saveSlice = mutation({"));
  const cashBranch = handler.slice(handler.indexOf('if (doc.startsWith("cash_tx_"))'), handler.indexOf("for (const r of old) await ctx.db.delete(r._id);"));
  check("the cash branch exists and comes BEFORE the delete loop", cashBranch.length > 0);
  check("it unions", /unionCashRows\(old, rows\)/.test(cashBranch));
  check("it inserts only the union", /for \(const r of fresh\)/.test(cashBranch));
  check("it returns before any delete", /return \{ doc, collection, wrote: fresh\.length, replaced: 0, unioned: true \};/.test(cashBranch));
  check("and contains no delete of its own", !/ctx\.db\.delete/.test(cashBranch));
  check("non-cash documents keep the replace semantics they were written for",
    /for \(const r of old\) await ctx\.db\.delete\(r\._id\);/.test(handler));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
