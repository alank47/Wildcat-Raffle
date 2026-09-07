// One cash ledger, and it belongs to the person who awarded it.
//
// Reported 2026-09-07: My Activity showed one transaction, the Teacher
// Interactions analytics showed sixteen, for the same admin on the same day.
//
// Neither screen was wrong about what it read. Cash movements live in TWO
// stores that were never reconciled -- the weekly `cash_tx_<week>` documents
// and an array on each student record -- and the two screens read different
// ones. The weekly documents only began in September, so fifteen August awards
// existed solely on the student records:
//
//   per-student arrays   Alan 16   Jazmin 48   total 64
//   weekly documents     Alan  1   Jazmin 48   total 49
//
// Run: npm test

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const raw = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const code = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

// Run the real function against both stores.
const src = code.slice(code.indexOf("function reconcileCashLedger()"),
                       code.indexOf("function applyTombstonesToLocalState()"));
const make = () => {
  const ctx = { cashTransactions: [], students: [], logs: [], window: {} };
  const fn = new Function("state", `
    let cashTransactions = state.cashTransactions;
    let students = state.students;
    const console = { log: (m) => state.logs.push(m) };
    // The function records what it did on window for the diagnostic. Stubbed
    // rather than stripped, so the test runs the shipped body unaltered.
    const window = state.window;
    ${src}
    reconcileCashLedger();
    state.cashTransactions = cashTransactions;
  `);
  return { ctx, run: () => fn(ctx) };
};

console.log("\nThe two stores become one");
{
  const { ctx, run } = make();
  ctx.cashTransactions = [
    { id: "txn_sep_1", teacherId: "T001", timestamp: "2026-09-01T10:00:00Z", studentId: "s1" },
  ];
  ctx.students = [
    { id: "s1", wildcatCashTransactions: [
      { id: "txn_sep_1", teacherId: "T001", timestamp: "2026-09-01T10:00:00Z" },
      { id: "txn_aug_1", teacherId: "T001", timestamp: "2026-08-14T10:00:00Z" },
      { id: "txn_aug_2", teacherId: "T001", timestamp: "2026-08-15T10:00:00Z" },
    ] },
  ];
  run();
  check("August movements held only on the student record are recovered",
    ctx.cashTransactions.length === 3);
  check("the one already in the weekly document is NOT doubled",
    ctx.cashTransactions.filter((t) => t.id === "txn_sep_1").length === 1);
  check("and the result is in date order",
    ctx.cashTransactions.map((t) => t.id).join(",") === "txn_aug_1,txn_aug_2,txn_sep_1");
  check("a recovered movement carries the student it belongs to",
    ctx.cashTransactions.find((t) => t.id === "txn_aug_1").studentId === "s1");
  check("and it says what it did", /reconciled: 2 movement/.test(ctx.logs[0] ?? ""));
  // Recorded for wcDiagnoseData, so a report of "still only one" can be
  // answered from the machine rather than by another round of guessing.
  check("it records what it found, for the diagnostic",
    ctx.window._wcCashReconcile
      && ctx.window._wcCashReconcile.recovered === 2
      && ctx.window._wcCashReconcile.ledgerAfter === 3
      && ctx.window._wcCashReconcile.onStudentRecords === 3);
}

console.log("\nIt is safe to run when there is nothing to do");
{
  const { ctx, run } = make();
  ctx.cashTransactions = [{ id: "a", teacherId: "T001", timestamp: "2026-09-01T00:00:00Z" }];
  ctx.students = [];
  run();
  check("an empty roster loses nothing", ctx.cashTransactions.length === 1);
  check("and says nothing", ctx.logs.length === 0);

  const second = make();
  second.ctx.cashTransactions = [{ id: "a", teacherId: "T001", timestamp: "2026-09-01T00:00:00Z" }];
  second.ctx.students = [{ id: "s1", wildcatCashTransactions: [{ id: "a", teacherId: "T001" }] }];
  second.run(); second.run();
  check("running it twice does not double anything", second.ctx.cashTransactions.length === 1);
}

console.log("\nA movement with no id is left alone, not duplicated forever");
{
  const { ctx, run } = make();
  ctx.cashTransactions = [];
  ctx.students = [{ id: "s1", wildcatCashTransactions: [{ teacherId: "T001", timestamp: "2026-08-01T00:00:00Z" }] }];
  run(); run();
  check("it is never added, so repeated loads cannot multiply it",
    ctx.cashTransactions.length === 0);
}

console.log("\nMy Activity shows mine, and only mine");
{
  const fn = code.slice(code.indexOf("function updateCashActivityLog("),
                        code.indexOf("function updateCashActivityLog(") + 1400);
  check("it matches on the actor id", /actor === currentUser\.id/.test(fn));
  check("the dead currentUser.username comparison is gone",
    !/currentUser\.username/.test(fn));
  // undefined === undefined is true, so an unattributed movement matched every
  // teacher at once.
  check("an unattributed movement matches nobody", /if \(!actor\) return false;/.test(fn));
  check("and that guard runs before the comparison",
    fn.indexOf("if (!actor) return false;") < fn.indexOf("actor === currentUser.id"));
}

console.log("\nBoth load paths reconcile");
{
  check("the Convex path calls it",
    /reconcileCashLedger\(\);[\s\S]{0,400}Apply tombstone filter as a display layer/.test(raw));
  check("and the localStorage fallback calls it too",
    /reconcileCashLedger\(\);[\s\S]{0,300}localStorage-fallback path/.test(raw));
  check("it runs before anything renders from the ledger",
    raw.indexOf("reconcileCashLedger();") < raw.indexOf("updateAllDisplays();"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
