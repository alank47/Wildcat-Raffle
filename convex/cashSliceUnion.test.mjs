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

// unionCashRows now calls cashMovementKey, so both are lifted. Slicing each
// function out by name keeps the test reading the SHIPPED source rather than a
// copy that can drift from it.
function lift(name) {
  const start = src.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} is not exported from legacyData.ts`);
  const end = src.indexOf("\n}\n", start) + 3;
  return src.slice(start, end).replace("export function", "function");
}
const js = ts.transpileModule(lift("cashMovementKey") + "\n" + lift("unionCashRows"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const [cashMovementKey, unionCashRows] =
  new Function(js + "\nreturn [cashMovementKey, unionCashRows];")();

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

console.log("\nThe same movement under a second id is refused");
{
  // Deduping on `id` alone assumes every copy of a movement carries the id it
  // was born with. Two things break that:
  //   - an audit entry records a movement but carries NO transaction id, so a
  //     row reconstructed from one necessarily takes a fresh txn_ id
  //   - recoverCashFromLocalCache sends a teacher's own original off their
  //     device, under its original id, possibly days later
  // Land both and the ledger holds two rows for one award: the child is paid
  // twice. This is the precondition for putting LIST A back.
  const award = (id, sid, ts, amt) => ({
    payload: { id, studentId: sid, timestamp: ts, amount: amt, kind: "award" },
  });

  const stored = [award("txn_orig", "11342", "2026-09-15T23:09:34.100Z", 100)];
  const sameMovementNewId = [award("txn_rebuilt", "11342", "2026-09-15T23:09:34.100Z", 100)];
  check("a reconstructed row is refused when the original is already stored",
    unionCashRows(stored, sameMovementNewId).length === 0);

  check("and the other way round, whichever lands second",
    unionCashRows(
      [award("txn_rebuilt", "11342", "2026-09-15T23:09:34.100Z", 100)],
      [award("txn_orig", "11342", "2026-09-15T23:09:34.100Z", 100)],
    ).length === 0);

  check("two copies in ONE payload also collapse to one",
    unionCashRows([], [
      award("txn_a", "11342", "2026-09-15T23:09:34.100Z", 100),
      award("txn_b", "11342", "2026-09-15T23:09:34.100Z", 100),
    ]).length === 1);

  // The guard must not eat genuine awards.
  check("a different student at the same instant is kept",
    unionCashRows(stored, [award("txn_2", "11343", "2026-09-15T23:09:34.100Z", 100)]).length === 1);
  // THE WINDOW IS ONE SECOND, AND THIS ASSERTION WAS REVERSED ON PURPOSE.
  //
  // It used to require that the same student a MILLISECOND later was kept.
  // That was wrong, and it is the case that would have paid a child twice.
  // One movement is stamped twice -- recordCashTransaction for the ledger row,
  // addToAuditLog for the audit entry -- by two separate `new Date()` calls,
  // and 139 of the 2,086 movements on production carry timestamps 1-2ms apart.
  // So when a lost movement is rebuilt from its surviving audit entry, the
  // rebuilt row and the original the teacher's device may still send differ
  // only in the milliseconds. At the old precision the guard passed both.
  check("the same student a millisecond later is the SAME movement, and refused",
    unionCashRows(stored, [award("txn_2", "11342", "2026-09-15T23:09:34.101Z", 100)]).length === 0);
  check("and so is one 999ms later, still inside the same second",
    unionCashRows(stored, [award("txn_2", "11342", "2026-09-15T23:09:34.999Z", 100)]).length === 0);
  // But no wider than a second: a teacher awarding the same student the same
  // amount twice in one minute is real, and minute precision collides 24 times
  // on the live ledger.
  check("a second later is a different movement, and kept",
    unionCashRows(stored, [award("txn_2", "11342", "2026-09-15T23:09:35.100Z", 100)]).length === 1);
  check("the same student and instant but a different amount is kept",
    unionCashRows(stored, [award("txn_2", "11342", "2026-09-15T23:09:34.100Z", 200)]).length === 1);
  check("a deduction is not confused with the award it reverses",
    unionCashRows(stored, [award("txn_2", "11342", "2026-09-15T23:09:34.100Z", -100)]).length === 1);

  // A row that cannot be identified this way falls back to the id check only,
  // rather than being guessed at.
  check("a row with no studentId is judged on its id alone",
    unionCashRows([], [{ payload: { id: "txn_x", timestamp: "2026-09-15T23:09:34.100Z", amount: 100 } },
                        { payload: { id: "txn_y", timestamp: "2026-09-15T23:09:34.100Z", amount: 100 } }]).length === 2);
  check("and an id duplicate is still refused as before",
    unionCashRows(stored, [award("txn_orig", "11342", "2026-09-15T23:09:34.100Z", 100)]).length === 0);

  check("cashMovementKey is exported for the handler and the tests",
    /export function cashMovementKey/.test(src));
  check("the union consults it", /const mk = cashMovementKey\(r\.payload\);/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
