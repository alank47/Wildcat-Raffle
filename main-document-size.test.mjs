// What may be written into `raffle_data/main`.
//
// THE PROBLEM. Firestore caps a document at 1MB. `main` holds every student and
// teacher record and is loaded by every staff member on every open. It reached
// 81% of that ceiling, and the cause was a SECOND complete copy of the cash
// ledger: distributeCashTransactions() rebuilds student.wildcatCashTransactions
// from the cash_tx_* documents on every load, and the save then wrote that
// derived view straight back into `main`, sharded across student records.
//
// Crossing the limit does not degrade anything. Firestore rejects the write, so
// `main` stops saving outright: tickets, cash balances and roster changes all
// stop persisting, with the app otherwise behaving normally.
//
// Run: npm test

import { readFileSync } from "node:fs";
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

// The path that builds what the save receives. There were three of them while
// the Firestore transaction hand-rolled its own merge, and each had to strip on
// its own because the merge branch REPLACED studentsToSave wholesale. That
// transaction moved to Convex on 2026-08-31, where the merge is server side and
// per field, so there is one path now and one place to forget.
const saveStart = script.indexOf("🔵 Saving with transactions");
const saveEnd = script.indexOf("✅ Main document saved (transaction)");
const save = script.slice(saveStart, saveEnd);

console.log("\nDerived data is never written into main");
{
  const stripCount = (field) =>
    (save.match(new RegExp("delete (studentData|c)\\." + field + ";", "g")) || []).length;

  // The count was 3 while the Firestore transaction existed: a create path, a
  // merge path for records the server already had, and a second merge path for
  // records only the tab had. Each stripped independently, and each was a place
  // to forget. The transaction went to Convex on 2026-08-31 and there is now
  // ONE path, so the number to assert is 1 — and the reason it is not 3 is that
  // the duplication is gone, not that a strip is missing.
  check("the cash ledger view is stripped on the path that writes students",
    stripCount("wildcatCashTransactions") === 1);
  check("so is its retired name", stripCount("cashTransactions") === 1);
  check("ticket history is still stripped", stripCount("ticketHistory") === 1);
  check("sections are still stripped", stripCount("sections") === 1);
}

console.log("\nThere is one write path, and it strips");
{
  check("students.concat(nonEnrolledStudents) is mapped, not passed through",
    /students\.concat\(nonEnrolledStudents\)\.map\(s => \{/.test(save));
  // What used to be here demanded a comment explaining why two paths stripped
  // separately. There are no longer two paths. What has to stay recorded is the
  // reason the former students are concatenated back on at all: `students` holds
  // the enrolled only, so sending it alone presents everyone else as absent.
  check("the reason former students are sent too is recorded",
    /sending the enrolled alone would\s*\n\s*\/\/ present the rest as absent/.test(save),
    "omitting them is how a roster silently loses its former students",
  );
}

console.log("\nThe per-student view is rebuilt after the save");
{
  // Stripping it from the write also removes it from memory, because the
  // transaction result is assigned back over `students`.
  // Asserted by ORDER rather than a character window: the gap between the two
  // is comment text, and a brittle regex here fails on the next comment edit
  // rather than on the thing that actually matters.
  const reassign = script.indexOf("nonEnrolledStudents = savedAll.filter");
  const rebuild = script.indexOf("distributeCashTransactions();", reassign);
  const savedLog = script.indexOf("✅ Main document saved (transaction)");
  check("distributeCashTransactions runs after students is reassigned",
    reassign > 0 && rebuild > reassign && rebuild < savedLog);
  check("and why is written down, because an empty panel is the symptom",
    /"My Cash Activity" empties out until the next refresh/.test(script));
}

console.log("\nThe health estimate measures what is actually written");
{
  const est = script.slice(script.indexOf("const studentsForMain"),
                           script.indexOf("const referralsPayload"));
  check("the estimate strips the same fields the save does",
    /delete copy\.wildcatCashTransactions;/.test(est) &&
    /delete copy\.cashTransactions;/.test(est));
  // Reporting freed space as still-occupied sends someone chasing nothing.
  check("and no longer reports cash arrays as living inside main",
    !/Cash transactions on students/.test(script));
  check("the detail now names student core records, which is the real bulk",
    /Student records \(core fields\)/.test(script));
}

console.log("\nThe authoritative copy is untouched");
{
  // The point of the change is that nothing is LOST: cash_tx_* is the ledger
  // and it is written independently of main.
  check("weekly cash documents are still written",
    /saveLegacySlice\(`cash_tx_\$\{wk\}`, 'transactions', txs\)/.test(script));
  // Reads moved to Convex on 2026-08-31. The assertion is unchanged in intent:
  // every known cash week is still fetched on load, one document per week, and
  // the ledger is never folded back into `main`.
  check("and still read on load",
    /_cashWeekKeys\.map\(wk => snapOf\(`cash_tx_\$\{wk\}`\)\)/.test(script));
  check("distributeCashTransactions still rebuilds from that ledger",
    /\(cashTransactions \|\| \[\]\)\.forEach\(t => \{/.test(script));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
