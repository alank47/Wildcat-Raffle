// The cash counters are derived from history, and the derivation is faithful
// to what each row MEANS rather than to its sign. Run: npm test
//
// THE INCIDENT SHAPE. Nothing has ever recomputed a real student's cash
// counters from their transactions: recordCashTransaction only ever moves a
// counter, and recalculateCashBalance's single caller is the test-data seeder.
// On 2026-09-17, 220 of 509 students with cash history held a stored balance
// that disagreed with their own rows -- 219 of them BELOW, $48,000 between
// them, 26 reading $0 while holding awards -- and studentStore.ts shows a
// child that stored number.
//
// The three cases pinned below are the ones a naive sum gets WRONG, and each
// is a real production record. They are the reason this derivation exists
// rather than a call to recalculateCashBalance: it reproduces all three
// exactly, which is what earns the right to overwrite the other 219.
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("./cashRecountRules.ts", import.meta.url), "utf8");
let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

// Lifted by name from the SHIPPED source, so the test cannot drift from a copy.
function lift(name) {
  const start = src.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} is not exported from cashRecountRules.ts`);
  const end = src.indexOf("\n}\n", start) + 3;
  return src.slice(start, end).replace("export function", "function");
}
const js = ts.transpileModule(
  ["receiptCodeOf", "chargedReceipts", "deriveCounters", "recountVerdict"].map(lift).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText;
const [receiptCodeOf, chargedReceipts, deriveCounters, recountVerdict] =
  new Function(js + "\nreturn [receiptCodeOf, chargedReceipts, deriveCounters, recountVerdict];")();

const C = (r) => r.counters;
const row = (o) => ({ id: "t1", amount: 100, kind: "award", behaviorId: "", notes: "", ...o });

console.log("\nPlain awards and deductions");
{
  const d = deriveCounters([
    row({ id: "a", amount: 100 }),
    row({ id: "b", amount: 100 }),
    row({ id: "c", amount: -100, kind: "deduct" }),
  ]);
  check("balance is the sum", C(d).wildcatCashBalance === 100);
  check("earned counts only the positives", C(d).wildcatCashEarned === 200);
  check("deducted counts the negative, unsigned", C(d).wildcatCashDeducted === 100);
  check("spent is untouched by a deduction", C(d).wildcatCashSpent === 0);
  check("every row was used", d.rowsUsed === 3 && d.excluded.length === 0);
}

console.log("\nA redemption is spent, not deducted");
{
  // Reading the sign here is the mistake that put a purchase in a red
  // intervention table. A redemption and a deduction are both negative.
  const d = deriveCounters([row({ id: "a", amount: 100 }), row({ id: "b", amount: -100, kind: "redeem" })]);
  check("spent carries the redemption", C(d).wildcatCashSpent === 100);
  check("deducted does NOT", C(d).wildcatCashDeducted === 0);
  check("earned is not reduced by a purchase", C(d).wildcatCashEarned === 100);
  check("balance is back to zero", C(d).wildcatCashBalance === 0);
}

console.log("\nBreonny Vazquez: a reversal UN-COUNTS, it does not deduct");
{
  // Production, id 11961. Two real deductions, one award, and a reversal of
  // that award because it was given to the wrong student. Her stored record
  // reads balance -200, earned 0, spent 0, deducted 200 -- and is CORRECT.
  const rows = [
    row({ id: "d1", amount: -100, kind: "deduct" }),
    row({ id: "d2", amount: -100, kind: "deduct" }),
    row({ id: "a1", amount: 100, kind: "award" }),
    row({ id: "rev", amount: -100, kind: "reversal", notes: "Added to the wrong student" }),
  ];
  const deltas = { rev: { wildcatCashBalance: -100, wildcatCashEarned: -100 } };
  const d = deriveCounters(rows, deltas);
  check("balance matches her stored record", C(d).wildcatCashBalance === -200);
  check("earned is un-counted back to zero", C(d).wildcatCashEarned === 0);
  check("deducted holds ONLY the two real deductions", C(d).wildcatCashDeducted === 200);
  check("spent stays zero", C(d).wildcatCashSpent === 0);

  // What the naive, sign-bucketed sum would have done to a correct record.
  const naive = deriveCounters(rows.map((r) => (r.kind === "reversal" ? { ...r, kind: "deduct" } : r)));
  check("the sign-bucketed version really is wrong, so this test has teeth",
    C(naive).wildcatCashDeducted === 300 && C(naive).wildcatCashEarned === 100);
}

console.log("\nFrancisco Antonio-Pascual: a refund un-counts spent, it does not earn");
{
  // Production, id 11225. Purchase WC-A68031 then cancelled. Stored: balance
  // 200, earned 300, spent 0, deducted 100.
  const rows = [
    row({ id: "a1", amount: 100 }),
    row({ id: "buy", amount: -100, kind: "redeem", notes: "Reward purchase WC-A68031 [self-serve]" }),
    row({ id: "ref", amount: 100, behaviorId: "reward-refund:reward4", notes: "Cancelled receipt WC-A68031. This was a test" }),
    row({ id: "a2", amount: 100 }),
    row({ id: "a3", amount: 100 }),
    row({ id: "d1", amount: -100, kind: "deduct" }),
  ];
  const d = deriveCounters(rows);
  check("balance matches his stored record", C(d).wildcatCashBalance === 200);
  check("earned is NOT inflated by the refund", C(d).wildcatCashEarned === 300);
  check("spent is un-counted back to zero", C(d).wildcatCashSpent === 0);
  check("deducted holds the real deduction", C(d).wildcatCashDeducted === 100);
  check("the refund was used, not excluded", d.excluded.length === 0);
}

console.log("\nNadia Almendares-Castaneda: a refund with no charge is not a refund");
{
  // Production, id 11342. A $1,000 refund for receipt WC-XPSGVE, whose
  // purchase predates the 14 September history cutoff and was pruned -- the
  // receipt is not in studentPurchases either. Crediting it hands back money
  // that was never taken. Her stored balance of 1,000 is already right.
  const rows = [
    row({ id: "a1", amount: 100 }), row({ id: "a2", amount: 100 }), row({ id: "a3", amount: 100 }),
    row({ id: "ref", amount: 1000, behaviorId: "reward-refund:reward2", notes: "Cancelled receipt WC-XPSGVE. Test only" }),
    row({ id: "a4", amount: 100 }), row({ id: "a5", amount: 100 }), row({ id: "a6", amount: 100 }),
    row({ id: "a7", amount: 100 }), row({ id: "a8", amount: 100 }), row({ id: "a9", amount: 100 }),
    row({ id: "a10", amount: 100 }),
  ];
  const d = deriveCounters(rows);
  check("the orphan refund is excluded", d.excluded.length === 1 && d.excluded[0].id === "ref");
  check("the exclusion names the receipt", d.excluded[0].receipt === "WC-XPSGVE");
  check("the exclusion says why, for a human to read", /never taken/.test(d.excluded[0].why));
  check("balance is her ten real awards, matching her stored record", C(d).wildcatCashBalance === 1000);
  check("earned is not inflated by $1,000", C(d).wildcatCashEarned === 1000);

  // The whole point: a naive sum would have paid her the phantom.
  const withCharge = deriveCounters(rows.concat([
    row({ id: "buy", amount: -1000, kind: "redeem", notes: "Reward purchase WC-XPSGVE" }),
  ]));
  check("the SAME refund is honoured once its charge is present",
    C(withCharge).wildcatCashBalance === 1000 && C(withCharge).wildcatCashSpent === 0
      && withCharge.excluded.length === 0);
}

console.log("\nA refund is matched by receipt, not by hope");
{
  check("a receipt code is read out of notes", receiptCodeOf("Cancelled receipt WC-A68031. x") === "WC-A68031");
  check("no code means null, not a crash", receiptCodeOf(null) === null);
  check("a charge is found by its own note", chargedReceipts([row({ amount: -100, kind: "redeem", notes: "Reward purchase WC-ZZ1" })])[0] === "WC-ZZ1");
  check("only a redemption counts as a charge",
    chargedReceipts([row({ amount: -100, kind: "deduct", notes: "WC-ZZ1" })]).length === 0);
  const d = deriveCounters([row({ id: "r", amount: 50, behaviorId: "reward-refund:x", notes: "no receipt here" })]);
  check("a refund naming no receipt at all is excluded", d.excluded.length === 1 && C(d).wildcatCashBalance === 0);
}

console.log("\nThe cumulative counters never go below zero; a balance may");
{
  // leaderboardRules treats a negative wildcatCashEarned as UNKNOWN and drops
  // the child off the cash leaderboard their year group can see.
  const d = deriveCounters(
    [row({ id: "rev", amount: -100, kind: "reversal" })],
    { rev: { wildcatCashBalance: -100, wildcatCashEarned: -100 } },
  );
  check("earned is floored at zero, not left negative", C(d).wildcatCashEarned === 0);
  const neg = deriveCounters([row({ id: "d", amount: -100, kind: "deduct" })]);
  check("a balance IS allowed to be negative and stay visible", C(neg).wildcatCashBalance === -100);
}

console.log("\nA row that cannot be read is excluded, never counted as zero");
{
  const d = deriveCounters([row({ id: "ok", amount: 100 }), row({ id: "bad", amount: null })]);
  check("the unreadable row is excluded", d.excluded.length === 1 && d.excluded[0].id === "bad");
  check("the readable row still counts", C(d).wildcatCashBalance === 100);
  const undef = deriveCounters([row({ id: "u", amount: undefined })]);
  check("an absent amount is excluded too", undef.excluded.length === 1);
}

console.log("\nA reversal with no recorded delta still un-counts, by the original's sign");
{
  const d = deriveCounters([row({ id: "a", amount: 100 }), row({ id: "rev", amount: -100, kind: "reversal" })], {});
  check("earned comes back down", C(d).wildcatCashEarned === 0);
  check("deducted is not touched", C(d).wildcatCashDeducted === 0);
  const ofDeduct = deriveCounters([row({ id: "d", amount: -100, kind: "deduct" }), row({ id: "rev", amount: 100, kind: "reversal" })], {});
  check("reversing a deduction un-counts deducted", C(ofDeduct).wildcatCashDeducted === 0);
  check("and does not inflate earned", C(ofDeduct).wildcatCashEarned === 0);
}

console.log("\nThe verdict refuses to take money off a child without being asked");
{
  const stored = { wildcatCashBalance: 100, wildcatCashEarned: 100, wildcatCashSpent: 0, wildcatCashDeducted: 0 };
  // Scarlett Velasquez, id 11887: two $100 deductions against one $100 award.
  const derived = { wildcatCashBalance: -100, wildcatCashEarned: 100, wildcatCashSpent: 0, wildcatCashDeducted: 200 };
  const held = recountVerdict(stored, derived);
  check("a reduction is held back by default", held.action === "held back");
  check("nothing is patched when held back", Object.keys(held.patch).length === 0);
  check("the reason names the amount", /REDUCE the balance by \$200/.test(held.why));
  check("the changes are still reported so a human can decide", held.changes.length === 2);
  const allowed = recountVerdict(stored, derived, { includeDecreases: true });
  check("it goes through when asked in so many words", allowed.action === "repair");
  check("and then patches the balance", allowed.patch.wildcatCashBalance === -100);
}

console.log("\nThe verdict pays what is owed, and only what changed");
{
  const stored = { wildcatCashBalance: 0, wildcatCashEarned: 0, wildcatCashSpent: 0, wildcatCashDeducted: 0 };
  // Isaiah Del Cid, id 12081: five awards from one teacher, stored at zero.
  const v = recountVerdict(stored, { wildcatCashBalance: 500, wildcatCashEarned: 500, wildcatCashSpent: 0, wildcatCashDeducted: 0 });
  check("an increase is repaired", v.action === "repair");
  check("the balance is set to the derived value", v.patch.wildcatCashBalance === 500);
  check("only the fields that changed are patched",
    Object.keys(v.patch).sort().join(",") === "wildcatCashBalance,wildcatCashEarned");
  check("an unchanged counter is left alone", !("wildcatCashSpent" in v.patch));
}

console.log("\nRunning it twice changes nothing the second time");
{
  const rows = [row({ id: "a", amount: 100 }), row({ id: "b", amount: 100 })];
  const first = deriveCounters(rows).counters;
  const stored = { wildcatCashBalance: 0, wildcatCashEarned: 0, wildcatCashSpent: 0, wildcatCashDeducted: 0 };
  const v1 = recountVerdict(stored, first);
  check("the first run repairs", v1.action === "repair");
  const after = { ...stored, ...v1.patch };
  const v2 = recountVerdict(after, deriveCounters(rows).counters);
  check("the second run finds nothing to do", v2.action === "already correct");
  check("and patches nothing", Object.keys(v2.patch).length === 0);
  check("the derivation is stable across runs",
    JSON.stringify(deriveCounters(rows).counters) === JSON.stringify(first));
}

console.log("\nA derivation gone wrong is held back, not written");
{
  const stored = { wildcatCashBalance: 100, wildcatCashEarned: 100, wildcatCashSpent: 0, wildcatCashDeducted: 0 };
  const mad = recountVerdict(stored, { wildcatCashBalance: 900000, wildcatCashEarned: 900000, wildcatCashSpent: 0, wildcatCashDeducted: 0 });
  check("a five-figure correction is refused", mad.action === "held back");
  check("the reason names the cap", /safety cap/.test(mad.why));
  check("nothing is patched", Object.keys(mad.patch).length === 0);
  const raised = recountVerdict(stored, { wildcatCashBalance: 900000, wildcatCashEarned: 900000, wildcatCashSpent: 0, wildcatCashDeducted: 0 }, { maxChange: 1000000 });
  check("the cap is a blast radius, and can be raised deliberately", raised.action === "repair");
  // The real corrections are nowhere near it: the largest measured is $1,200.
  const real = recountVerdict({ wildcatCashBalance: 200, wildcatCashEarned: 200, wildcatCashSpent: 0, wildcatCashDeducted: 0 },
    { wildcatCashBalance: 1400, wildcatCashEarned: 1400, wildcatCashSpent: 0, wildcatCashDeducted: 0 });
  check("the largest real correction measured passes the cap", real.action === "repair");
}

console.log("\nA balance reset is a zero point, not a deduction");
{
  // _resetAllStudentCash writes a REAL ledger row per student -- behaviorId
  // 'system_reset', kind 'deduct', amount -balanceBefore -- and then pins all
  // four counters to zero. Without a rule for it the row fell through to the
  // default bucket, so `deducted` gained the child's whole former balance as
  // though it had been taken off them for behaviour, AND `earned` was restored
  // to the pre-reset sum the reset had deliberately zeroed. $46,250 is the
  // largest reset this repo has recorded.
  const at = (ts, o) => row({ timestamp: ts, ...o });
  const reset = (ts, amt) => at(ts, { id: "reset", amount: -amt, kind: "deduct", behaviorId: "system_reset" });

  const wiped = [
    at("2026-09-01T10:00:00Z", { id: "a1", amount: 500 }),
    at("2026-09-02T10:00:00Z", { id: "a2", amount: 45750 }),
    reset("2026-09-03T10:00:00Z", 46250),
  ];
  const d = deriveCounters(wiped);
  check("a wiped student derives all zeros, matching what the reset pinned",
    C(d).wildcatCashBalance === 0 && C(d).wildcatCashEarned === 0 && C(d).wildcatCashDeducted === 0);
  check("the reset is NOT reported as money deducted for behaviour", C(d).wildcatCashDeducted !== 46250);
  check("and earned is NOT restored to the pre-reset sum", C(d).wildcatCashEarned !== 46250);
  check("so the verdict leaves the record alone",
    recountVerdict({ wildcatCashBalance: 0, wildcatCashEarned: 0, wildcatCashSpent: 0, wildcatCashDeducted: 0 },
      C(d)).action === "already correct");

  // The case the balance rail cannot catch: the balance is already right, so
  // recountVerdict sees a zero balance delta and would have written the two
  // wrong counters unguarded.
  const earnedAgain = [
    at("2026-09-01T10:00:00Z", { id: "a1", amount: 500 }),
    reset("2026-09-03T10:00:00Z", 500),
    at("2026-09-04T10:00:00Z", { id: "a2", amount: 300 }),
  ];
  const e = deriveCounters(earnedAgain);
  check("only post-reset awards count", C(e).wildcatCashBalance === 300 && C(e).wildcatCashEarned === 300);
  check("nothing lands in deducted", C(e).wildcatCashDeducted === 0);
  check("a record that was already correct is left alone",
    recountVerdict({ wildcatCashBalance: 300, wildcatCashEarned: 300, wildcatCashSpent: 0, wildcatCashDeducted: 0 },
      C(e)).action === "already correct");

  // Dropping the reset row ALONE would be strictly worse than the old bug: the
  // pre-reset awards would still sum and hand the balance back.
  const skippedInstead = deriveCounters(wiped.filter((r) => r.behaviorId !== "system_reset"));
  check("merely ignoring the reset row would re-credit the wiped balance, so the boundary matters",
    C(skippedInstead).wildcatCashBalance === 46250);

  // Only the LATEST reset is the boundary.
  const twice = [
    at("2026-09-01T10:00:00Z", { id: "a1", amount: 500 }),
    at("2026-09-03T11:00:00Z", { id: "r1", amount: -500, kind: "deduct", behaviorId: "system_reset" }),
    at("2026-09-04T10:00:00Z", { id: "a2", amount: 700 }),
    at("2026-09-05T11:00:00Z", { id: "r2", amount: -700, kind: "deduct", behaviorId: "system_reset" }),
    at("2026-09-06T10:00:00Z", { id: "a3", amount: 200 }),
  ];
  check("two resets: only the later one is the boundary",
    C(deriveCounters(twice)).wildcatCashBalance === 200);

  // Order independence: the driver pushes rows in pagination order off the
  // by_doc index, NOT in timestamp order, so zeroing accumulators on meeting
  // the row would give a different answer per page boundary.
  const shuffled = [wiped[2], wiped[0], wiped[1]];
  check("the answer does not depend on the order rows arrive in",
    JSON.stringify(C(deriveCounters(shuffled))) === JSON.stringify(C(deriveCounters(wiped))));

  // An undated row cannot be placed either side of the boundary.
  const undatedRow = deriveCounters([reset("2026-09-03T10:00:00Z", 100), at(null, { id: "u", amount: 900 })]);
  check("a row that cannot be dated is excluded, not counted", undatedRow.excluded.length === 1);
  check("and the exclusion says why, naming the reset", /balance reset/.test(undatedRow.excluded[0].why));
  check("so it cannot hand back wiped money", C(undatedRow).wildcatCashBalance === 0);

  // An undated RESET leaves no boundary at all, so nothing is derived.
  const undatedReset = deriveCounters([
    at(null, { id: "reset", amount: -500, kind: "deduct", behaviorId: "system_reset" }),
    at("2026-09-04T10:00:00Z", { id: "a1", amount: 300 }),
  ]);
  check("an undated reset derives nothing rather than guessing",
    C(undatedReset).wildcatCashBalance === 0 && undatedReset.rowsUsed === 0);
  check("and reports that the restart point is unknown",
    undatedReset.excluded.length === 1 && /cannot be established/.test(undatedReset.excluded[0].why));
  check("which leaves a real post-reset balance held back rather than overwritten",
    recountVerdict({ wildcatCashBalance: 300, wildcatCashEarned: 300, wildcatCashSpent: 0, wildcatCashDeducted: 0 },
      C(undatedReset)).action === "held back");
}

console.log("\nNo history at all is not a reason to write zeros");
{
  const d = deriveCounters([]);
  check("an empty history derives all zeros", C(d).wildcatCashBalance === 0 && d.rowsUsed === 0);
  const v = recountVerdict({ wildcatCashBalance: 0, wildcatCashEarned: 0, wildcatCashSpent: 0, wildcatCashDeducted: 0 }, C(d));
  check("and a student already at zero is left alone", v.action === "already correct");
  check("a missing rows array does not throw", deriveCounters(null).rowsUsed === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
