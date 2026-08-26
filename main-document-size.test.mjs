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

// The three independent paths that build what `main` receives. Each one has to
// strip on its own: the merge branch REPLACES studentsToSave wholesale, so a
// strip in one path does not protect the others.
const saveStart = script.indexOf("🔵 Saving with transactions");
const saveEnd = script.indexOf("✅ Main document saved (transaction)");
const save = script.slice(saveStart, saveEnd);

console.log("\nDerived data is never written into main");
{
  const stripCount = (field) =>
    (save.match(new RegExp("delete (studentData|c)\\." + field + ";", "g")) || []).length;

  check("the cash ledger view is stripped on every path that writes students",
    stripCount("wildcatCashTransactions") === 3);
  check("so is its retired name", stripCount("cashTransactions") === 3);
  // These two were already correct and must stay that way.
  check("ticket history is still stripped", stripCount("ticketHistory") === 3);
  check("sections are still stripped", stripCount("sections") === 3);
}

console.log("\nThe first-write path strips too, not just the merge path");
{
  // `main` not existing is the one case where studentsToSave is used as built,
  // and it previously carried everything.
  check("students.concat(nonEnrolledStudents) is mapped, not passed through",
    /students\.concat\(nonEnrolledStudents\)\.map\(s => \{/.test(save));
  check("and the reason the two paths strip separately is recorded",
    /the two paths have to strip independently/.test(save));
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
    /raffle_data', `cash_tx_\$\{wk\}`/.test(script));
  check("and still read on load",
    /'raffle_data', `cash_tx_\$\{wk\}`\)\)\)/.test(script) ||
    /getKnownCashWeekKeys\(\)\.map\(wk => getDoc/.test(script));
  check("distributeCashTransactions still rebuilds from that ledger",
    /\(cashTransactions \|\| \[\]\)\.forEach\(t => \{/.test(script));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
