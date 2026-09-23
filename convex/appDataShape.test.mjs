// Tests for the pure shape and merge rules behind the Convex cutover.
// Run: npm test
//
// The merge rule here is the one that matters. The Firestore version replaced
// the whole document on every save, so a browser tab that had loaded before a
// backfill wrote its stale view over everything. That is not hypothetical: it
// wiped 38 staff emails on 2026-08-11. These tests reproduce that shape.

import {
  toAppStudent, toAppTeacher, mergeIncoming, planSave, planPatch, cashDeltaOf,
  refusedCashCounters, CASH_COUNTERS, MAX_CASH_DELTA, STUDENT_WRITABLE,
} from "./appDataShape.ts";

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
}

console.log("\nConvex row to app shape");
{
  const row = {
    legacyId: "s-123",
    studentNumber: "11095",
    firstName: "Ada",
    lastName: "Lovelace",
    grade: "11",
    pbisTickets: 3,
    attendanceTickets: 0,
    academicTickets: 1,
    bigRaffleQualified: [1, 2],
    wildcatCashBalance: 15000,
    cashBalance: 15000,
  };
  const app = toAppStudent(row);
  check("id prefers legacyId", app.id === "s-123", app.id);
  check("name is joined", app.name === "Ada Lovelace", app.name);
  check("earned value survives", app.wildcatCashBalance === 15000);
  check("week numbers stay NUMBERS, never coerced", app.bigRaffleQualified[0] === 1);
}
{
  const app = toAppStudent({
    studentNumber: "12036",
    firstName: "New",
    lastName: "Student",
    pbisTickets: 0,
    attendanceTickets: 0,
    academicTickets: 0,
    bigRaffleQualified: [],
  });
  check("a SIS student with no legacyId falls back to studentNumber", app.id === "12036", app.id);
  check("a student with no balance yet reports 0, not undefined", app.pbisTickets === 0);
}
{
  const t = toAppTeacher({
    _id: "abc",
    legacyId: "T007",
    name: "A Teacher",
    email: "a.teacher@lapromisefund.org",
    role: "teacher",
    ticketsAwarded: 12,
  });
  check("teacher id prefers legacyId", t.id === "T007", t.id);
  check("teacher email is carried", t.email === "a.teacher@lapromisefund.org");
  check("ticketsAwarded is carried", t.ticketsAwarded === 12);
}

console.log("\nThe stale tab rule, which is why this file exists");
{
  // A tab loaded before the email backfill sends "" for a field it never had.
  const existing = { name: "A", email: "al@lapromisefund.org", ticketsAwarded: 3 };
  const incoming = { name: "A", email: "", ticketsAwarded: 4 };
  const patch = mergeIncoming(existing, incoming);
  check("a blank incoming value never overwrites a present one", !("email" in patch), JSON.stringify(patch));
  check("a real change in the same payload still applies", patch.ticketsAwarded === 4);
  check("unchanged fields are absent from the patch", !("name" in patch));
}
{
  const existing = { email: "old@lapromisefund.org" };
  const incoming = { email: "new@lapromisefund.org" };
  const patch = mergeIncoming(existing, incoming);
  check("a non blank change to a present field DOES apply", patch.email === "new@lapromisefund.org");
}
{
  const existing = { email: undefined, name: "A" };
  const incoming = { email: "first@lapromisefund.org", name: "A" };
  const patch = mergeIncoming(existing, incoming);
  check("filling a field that was empty DOES apply", patch.email === "first@lapromisefund.org");
}
{
  // Zero is a real balance. Treating it as absence would make a spent-down
  // account impossible to zero out, which is a worse bug than the one above.
  const existing = { pbisTickets: 5, wildcatCashBalance: 15000 };
  const incoming = { pbisTickets: 5, wildcatCashBalance: 0 };
  const patch = mergeIncoming(existing, incoming);
  check("a balance CAN be set to zero deliberately", patch.wildcatCashBalance === 0, JSON.stringify(patch));
  check("and an unchanged count is still not written", !("pbisTickets" in patch));
}
{
  // An empty ARRAY is a real value too: a student can lose their last
  // qualification. Only undefined, null and "" mean "I do not know".
  const existing = { bigRaffleQualified: [1, 2] };
  const incoming = { bigRaffleQualified: [] };
  const patch = mergeIncoming(existing, incoming);
  check("an empty array is a real value, not absence", Array.isArray(patch.bigRaffleQualified) && patch.bigRaffleQualified.length === 0);
}
{
  const existing = { cashTransactions: [{ amount: 100 }] };
  const incoming = { cashTransactions: [{ amount: 100 }] };
  const patch = mergeIncoming(existing, incoming);
  check("a deep-equal array is not rewritten", !("cashTransactions" in patch), JSON.stringify(patch));
}
{
  const patch = mergeIncoming({ a: 1 }, { a: undefined, b: undefined });
  check("undefined never writes, even for a field that does not exist yet", Object.keys(patch).length === 0, JSON.stringify(patch));
}

console.log("\nWhat a save would actually write");
const ROWS = [
  { _id: "r1", legacyId: "s-1", studentNumber: "11095", pbisTickets: 3, wildcatCashBalance: 15000, firstName: "Ada", lastName: "L" },
  { _id: "r2", legacyId: "s-2", studentNumber: "11096", pbisTickets: 0, wildcatCashBalance: 0, firstName: "Bob", lastName: "M" },
];
const keysOf = (r) => [r.legacyId, r.studentNumber];
{
  const plan = planSave(ROWS, [{ id: "s-1", pbisTickets: 4 }], STUDENT_WRITABLE, keysOf);
  check("a real award produces one patch", plan.patches.length === 1, JSON.stringify(plan));
  check("and it targets the right row", plan.patches[0].rowId === "r1");
  check("and contains only the changed field", Object.keys(plan.patches[0].patch).join() === "pbisTickets");
}
{
  // The whole point: a browser cannot invent a student.
  const plan = planSave(ROWS, [{ id: "NOT-A-STUDENT", wildcatCashBalance: 999999 }], STUDENT_WRITABLE, keysOf);
  check("an unknown student is NEVER inserted", plan.patches.length === 0);
  check("and the skip is reported, not silent", plan.skipped[0] === "NOT-A-STUDENT", JSON.stringify(plan.skipped));
}
{
  // A browser must not be able to rename a child or move their grade.
  const plan = planSave(ROWS, [{ id: "s-1", firstName: "Hacked", grade: "12", studentNumber: "99999", pbisTickets: 4 }], STUDENT_WRITABLE, keysOf);
  const written = Object.keys(plan.patches[0].patch);
  check("identity fields are not writable from a browser", !written.includes("firstName") && !written.includes("grade"), written.join());
  check("the student number cannot be reassigned", !written.includes("studentNumber"), written.join());
  check("but the legitimate field still applies", written.includes("pbisTickets"));
}
{
  // A student can be addressed by student number as well as legacy id.
  const plan = planSave(ROWS, [{ id: "11096", pbisTickets: 2 }], STUDENT_WRITABLE, keysOf);
  check("a student number resolves to the same row", plan.patches[0]?.rowId === "r2", JSON.stringify(plan));
}
{
  const plan = planSave(ROWS, [{ id: "s-1", pbisTickets: 3, wildcatCashBalance: 15000 }], STUDENT_WRITABLE, keysOf);
  check("a save that changes nothing writes nothing", plan.patches.length === 0, JSON.stringify(plan));
}
{
  // The 2026-08-11 incident, at save scope.
  const plan = planSave(ROWS, [{ id: "s-1", wildcatCashBalance: null }, { id: "s-2", wildcatCashBalance: "" }], STUDENT_WRITABLE, keysOf);
  check("a stale tab cannot null a balance", plan.patches.length === 0, JSON.stringify(plan));
}

// WHAT A CURRENT BROWSER SENDS: the delta AND the named movement it is made
// of. Since 2026-09-23 the server applies money it can attribute to a named
// movement and nothing else, so every fixture below that expects money to
// move says which movement moved it -- exactly as recordCashTransaction does.
// The assertions are unchanged; only the fixtures now describe a real save.
let _mvSeq = 0;
function keyed(amount, kind, extra) {
  const a = Number(amount);
  const eff = {
    wildcatCashBalance: a,
    wildcatCashEarned: (kind !== "redeem" && a > 0) ? a : 0,
    wildcatCashSpent: kind === "redeem" ? Math.abs(a) : 0,
    wildcatCashDeducted: (kind !== "redeem" && a <= 0) ? Math.abs(a) : 0,
  };
  const cashDelta = {};
  for (const [f, v] of Object.entries(eff)) if (v) cashDelta[f] = v;
  return {
    ...(extra || {}),
    cashDelta,
    cashMovements: [{ id: `m${++_mvSeq}`, at: "2026-09-20T17:00:00.000Z", amount: a, kind }],
  };
}

console.log("\nCash counters are incremented, so two tabs awarding the same child add up");
{
  // Stored 100. Tab A loaded at 100 and awarded 10; tab B loaded at 100 and
  // awarded 5. Before: A sends 110, B sends 105, the child ends at 105 with
  // two awards in the ledger. Now each sends its delta.
  const stored = { _id: "s1", legacyId: "12217", wildcatCashBalance: 100, wildcatCashEarned: 100 };
  const fromA = keyed(10, "award", { id: "12217", wildcatCashBalance: 110, wildcatCashEarned: 110 });
  const afterA = { ...stored, ...planPatch(stored, fromA, STUDENT_WRITABLE) };
  check("A's delta lands", afterA.wildcatCashBalance === 110 && afterA.wildcatCashEarned === 110);
  const fromB = keyed(5, "award", { id: "12217", wildcatCashBalance: 105, wildcatCashEarned: 105 });
  const afterB = { ...afterA, ...planPatch(afterA, fromB, STUDENT_WRITABLE) };
  check("B's delta is added to what A left, not to what B saw", afterB.wildcatCashBalance === 115);
  check("earned too", afterB.wildcatCashEarned === 115);
  check("B's absolute values were ignored", afterB.wildcatCashBalance !== 105);

  const patch = planPatch(stored, { id: "12217", wildcatCashBalance: 999, cashDelta: { wildcatCashBalance: 0 } }, STUDENT_WRITABLE);
  check("a zero delta writes nothing for that counter, whatever the absolute says", !("wildcatCashBalance" in patch));

  // THE INCIDENT, 2026-09-13. This assertion used to read "a record with no
  // cashDelta (an older client) still merges the absolute value", and that
  // behaviour is what put $4,901,850 back across 336 students: a tab running a
  // build older than 2026-09-09 re-sent its pre-reset in-memory view over a
  // server-side clear, and planPatch handed the absolute counters straight to
  // mergeIncoming. The arithmetic identified it exactly -- the original
  // $6,633,000 less the $1,731,150 held by the 104 students a browser never
  // loads is $4,901,850, to the dollar.
  //
  // A browser may MOVE a counter and may never SET one.
  const older = planPatch(stored, { id: "12217", wildcatCashBalance: 110 }, STUDENT_WRITABLE);
  check("a record with no cashDelta cannot set a counter at all",
    !("wildcatCashBalance" in older));
  check("and cannot resurrect a cleared balance",
    !("wildcatCashBalance" in planPatch({ ...stored, wildcatCashBalance: 0 },
      { id: "12217", wildcatCashBalance: 30500 }, STUDENT_WRITABLE)));
  // Its OTHER writable fields still apply. The refusal is about cash, not
  // about the record.
  const alsoTickets = planPatch(stored, { id: "12217", wildcatCashBalance: 110, pbisTickets: 7 },
    STUDENT_WRITABLE);
  check("but the rest of that record still merges", alsoTickets.pbisTickets === 7);
  // And it is REPORTED. A dropped counter that nobody is told about is worse
  // than the resurrection, because the resurrection was at least visible.
  check("the refusal is named, not swallowed",
    refusedCashCounters(stored, { id: "12217", wildcatCashBalance: 110 }, STUDENT_WRITABLE)
      .includes("wildcatCashBalance"));
  check("an ordinary save with a delta is not reported",
    refusedCashCounters(stored, fromA, STUDENT_WRITABLE).length === 0);
  check("nor is a record that merely restates the stored balance",
    refusedCashCounters(stored, { id: "12217", wildcatCashBalance: 100 }, STUDENT_WRITABLE).length === 0);

  // THE SAME INCIDENT WITH THE SIGN FLIPPED, which review caught and which is
  // worse than the original. After a clear, a stale tab pressing "Reset ALL
  // student balances" computes its delta against the balance IT remembers:
  // 0 - 30500 = -30500. The server holds 0. Unclamped that is -$30,500 for one
  // child and $4.9M of phantom debt across the school.
  const cleared = { ...stored, wildcatCashBalance: 0, wildcatCashEarned: 0 };
  const staleReset = planPatch(cleared,
    { id: "12217", wildcatCashBalance: 0, cashDelta: { wildcatCashBalance: -30500 } },
    STUDENT_WRITABLE);
  // CAPPED BY MAGNITUDE, NOT FLOORED AT ZERO -- and the first version of this
  // rule was floored at zero, which broke the product.
  //
  // Every balance is $0 after tonight's reset, so a floor at zero would have
  // refused the NEXT legitimate deduction any teacher made, reported it as a
  // refusal, and force-reloaded their tab mid-lesson. Deductions are a launch
  // feature and debt is a state this school uses deliberately: the deduct
  // screen says "Deductions may take a balance negative -- the student owes it
  // back", and six students were in debt before the reset.
  //
  // Magnitude is what separates a stale reset from a real deduction. A stale
  // reset carries a whole remembered balance; the behaviour catalogue tops out
  // at 100.
  // ABSENT from the patch, not written as 0. The cap skips the movement
  // entirely, so the stored value is left exactly as it was -- which is
  // stronger than writing a zero over it, and is what "refused" should mean.
  check("a stale reset's huge delta is refused outright",
    !("wildcatCashBalance" in staleReset));
  check("and the refusal is reported",
    refusedCashCounters(cleared,
      { id: "12217", cashDelta: { wildcatCashBalance: -30500 } }, STUDENT_WRITABLE)
      .includes("wildcatCashBalance"));

  // THE CASE THE FLOOR BROKE: a real deduction against a zero balance, which
  // is every student in the school tomorrow morning.
  const deductFromZero = planPatch(cleared, keyed(-100, "deduct", { id: "12217" }), STUDENT_WRITABLE);
  check("a real deduction against a $0 balance APPLIES, and goes negative",
    deductFromZero.wildcatCashBalance === -100);
  check("and its counter moves with it", deductFromZero.wildcatCashDeducted === 100);
  check("and it is NOT reported as refused, so no tab is reloaded at a child",
    refusedCashCounters(cleared,
      { id: "12217", cashDelta: { wildcatCashBalance: -100 } }, STUDENT_WRITABLE).length === 0);
  check("the largest behaviour in the catalogue is well inside the cap",
    MAX_CASH_DELTA > 100);
  // A LEGITIMATE deduction still lands in full. The clamp only bites where the
  // movement exceeds what the server actually holds.
  const realDeduct = planPatch(stored, keyed(-40, "deduct", { id: "12217" }), STUDENT_WRITABLE);
  check("a real deduction still applies", realDeduct.wildcatCashBalance === 60);
  check("and its counter moves with it", realDeduct.wildcatCashDeducted === 40);
  check("a deduction within the balance is not reported",
    refusedCashCounters(stored,
      { id: "12217", cashDelta: { wildcatCashBalance: -40 } }, STUDENT_WRITABLE).length === 0);
  // And spending, which is the same movement by a different name.
  const spend = planPatch(stored, keyed(-25, "redeem", { id: "12217" }), STUDENT_WRITABLE);
  check("a purchase applies", spend.wildcatCashBalance === 75 && spend.wildcatCashSpent === 25);

  const missing = planPatch({ _id: "s2" }, keyed(-25, "deduct", { id: "x" }), STUDENT_WRITABLE);
  check("a counter the row never had starts from zero", missing.wildcatCashDeducted === 25);

  const mixed = planPatch(stored, keyed(-20, "deduct", { id: "12217", pbisTickets: 3 }), STUDENT_WRITABLE);
  check("other writable fields still merge beside a delta", mixed.pbisTickets === 3 && mixed.wildcatCashBalance === 80);

  check("garbage deltas are ignored", cashDeltaOf({ cashDelta: { wildcatCashBalance: "ten", wildcatCashEarned: NaN } }) !== null
    && Object.keys(cashDeltaOf({ cashDelta: { wildcatCashBalance: "ten", wildcatCashEarned: NaN } })).length === 0);
  check("an array is not a delta", cashDeltaOf({ cashDelta: [1, 2] }) === null);
  check("cashDelta itself is never written as a field", !("cashDelta" in planPatch(stored, fromA, STUDENT_WRITABLE)));
  check("the four counters are the balance and the three running totals",
    CASH_COUNTERS.join() === "wildcatCashBalance,wildcatCashEarned,wildcatCashSpent,wildcatCashDeducted");

  const plan = planSave([stored], [fromA], STUDENT_WRITABLE, (r) => [r.legacyId, r.studentNumber]);
  check("planSave carries the delta rule end to end", plan.patches.length === 1 && plan.patches[0].patch.wildcatCashBalance === 110);

  // ===========================================================================
  // A STALE TAB CANNOT DECIDE WHAT ANYBODY ELSE SEES. 2026-09-23.
  //
  // At 16:44 UTC 79 students were reduced to what three independent records
  // agreed they had earned. By 16:49, 76 were back at EXACTLY their old
  // balances: a browser still holding the pre-repair numbers saved them back
  // as a delta with no movement behind it, and the server applied it.
  // ===========================================================================
  const repaired = { _id: "s9", legacyId: "12101", wildcatCashBalance: 900, wildcatCashEarned: 900 };
  const staleTab = { id: "12101", cashDelta: { wildcatCashBalance: 900, wildcatCashEarned: 900 }, cashMovements: [] };
  const reverted = planPatch(repaired, staleTab, STUDENT_WRITABLE);
  check("THE 16:49 SHAPE: a stale tab's +900 with no movement behind it moves NOTHING",
    !("wildcatCashBalance" in reverted) && !("wildcatCashEarned" in reverted), JSON.stringify(reverted));
  const staleSave = planSave([repaired], [staleTab], STUDENT_WRITABLE, (r) => [r.legacyId]);
  check("...and the tab is told it is out of date, which makes it reload itself",
    staleSave.countersIgnored.includes("12101") && staleSave.unkeyedResidual.includes("12101"),
    JSON.stringify({ c: staleSave.countersIgnored, u: staleSave.unkeyedResidual }));

  // The pre-2026-09-20 shape: a delta and no movement list at all.
  const oldBuild = planPatch(stored, { id: "12217", cashDelta: { wildcatCashBalance: 10, wildcatCashEarned: 10 } }, STUDENT_WRITABLE);
  check("a build too old to name its movements moves no money",
    !("wildcatCashBalance" in oldBuild));
  check("...and is told, so it reloads onto one that can",
    planSave([stored], [{ id: "12217", cashDelta: { wildcatCashBalance: 10 } }], STUDENT_WRITABLE,
      (r) => [r.legacyId]).countersIgnored.includes("12217"));

  // A REAL award riding in the same save as a stale excess: the award lands,
  // the excess does not.
  const mixedStale = planPatch(stored, {
    id: "12217",
    cashDelta: { wildcatCashBalance: 910, wildcatCashEarned: 910 },
    cashMovements: [{ id: "real-1", at: "2026-09-20T17:00:00.000Z", amount: 10, kind: "award" }],
  }, STUDENT_WRITABLE);
  check("a named award in the same save still applies, and only the award",
    mixedStale.wildcatCashBalance === 110 && mixedStale.wildcatCashEarned === 110, JSON.stringify(mixedStale));

  // Nothing is reported for a tab that is simply correct.
  const honest = planSave([stored], [fromA], STUDENT_WRITABLE, (r) => [r.legacyId]);
  check("a correct tab is never told it is out of date",
    honest.countersIgnored.length === 0 && honest.unkeyedResidual.length === 0,
    JSON.stringify({ c: honest.countersIgnored, u: honest.unkeyedResidual }));
  check("...and neither is the all-zero save every tab sends after a load",
    planSave([stored], [{ id: "12217", cashDelta: {}, cashMovements: [] }], STUDENT_WRITABLE,
      (r) => [r.legacyId]).countersIgnored.length === 0);
}

console.log("\n-- a current tab is not judged on absolutes it never claimed --");
{
  // THE FALSE REFUSAL that was going to fire for most of 40 staff on launch
  // morning. cashDeltaOf drops ZERO movements, so a tab that moved only the
  // balance and the deducted counter states nothing for earned -- and the
  // no-delta branch then compared earned by the absolute the tab LOADED with
  // against what the server holds now. Any award by any other teacher since
  // that load tripped it, and the teacher was told "This tab was out of date,
  // so some money was not saved. Reloading to get current." and had the page
  // reload under them. The money had saved.
  //
  // A record that states ANY delta speaks deltas, and its absolutes are not a
  // claim about the server. planPatch already ignores them.
  const stored = { legacyId: "1", studentNumber: "1", wildcatCashBalance: 100, wildcatCashEarned: 100 };

  // The first save after a load: every student, all-zero delta. Another
  // teacher has since awarded, so the absolutes disagree.
  check("an all-zero delta reports nothing, even when the absolutes disagree",
    refusedCashCounters(stored, {
      id: "1", wildcatCashBalance: 0, wildcatCashEarned: 0,
      cashDelta: { wildcatCashBalance: 0, wildcatCashEarned: 0, wildcatCashSpent: 0, wildcatCashDeducted: 0 },
    }, STUDENT_WRITABLE).length === 0);

  // A real deduction after another tab's award: balance and deducted move,
  // earned does not, and earned is the one that used to be reported.
  check("a deduction after another teacher's award reports nothing",
    refusedCashCounters(stored, {
      id: "1", wildcatCashBalance: -100, wildcatCashEarned: 0, wildcatCashDeducted: 100,
      cashDelta: { wildcatCashBalance: -100, wildcatCashDeducted: 100 },
    }, STUDENT_WRITABLE).length === 0);

  // THE CASE THIS FUNCTION EXISTS FOR is untouched: a build old enough to send
  // no cashDelta at all is still reported, because its absolutes ARE a claim.
  check("a record with NO cashDelta is still reported",
    refusedCashCounters(stored, { id: "1", wildcatCashBalance: 0 }, STUDENT_WRITABLE)
      .includes("wildcatCashBalance"));

  // And an over-cap movement is still reported, whatever else the record says.
  check("an over-cap delta is still reported",
    refusedCashCounters(stored, {
      id: "1", cashDelta: { wildcatCashBalance: -30500 },
    }, STUDENT_WRITABLE).includes("wildcatCashBalance"));
}

console.log("\n-- a student row with no cash fields is not a refusal --");
{
  // convex/sisSync.ts inserts a student without the four cash counters, so
  // row[field] is undefined while the client sends 0. refusedCashCounters used
  // to compare with same(), which is JSON.stringify equality -- and
  // JSON.stringify(undefined) is undefined, NOT a string, so undefined never
  // equalled "0". ONE such student was therefore enough to make the first save
  // from every tab report a refusal, warn the teacher their tab was out of
  // date, and force a reload, with nothing actually wrong.
  const bare = { legacyId: "9999", studentNumber: "9999" };   // no cash fields at all
  check("a client sending 0 against an absent stored value is not refused",
    refusedCashCounters(bare, { id: "9999", wildcatCashBalance: 0, wildcatCashEarned: 0 },
      STUDENT_WRITABLE).length === 0);
  check("but a client sending a real figure against it still is",
    refusedCashCounters(bare, { id: "9999", wildcatCashBalance: 250 }, STUDENT_WRITABLE)
      .includes("wildcatCashBalance"));
  check("and a matching non-zero value is not",
    refusedCashCounters({ ...bare, wildcatCashBalance: 250 },
      { id: "9999", wildcatCashBalance: 250 }, STUDENT_WRITABLE).length === 0);
}

console.log("\n-- the third write path: per-student history arrays --");
{
  // I GUARDED TWO OF THREE, AND TWO OF THREE IS NONE. On 2026-09-14 a history
  // cutoff went into legacyData:mergeSlice so a stale tab could not re-insert
  // last term's rows. It closed the cash_tx_* ledger and the referrals, and
  // held. Within hours 330 pre-launch rows were back on 348 students, because
  // students.wildcatCashTransactions arrives through appData:save instead --
  // a different mutation the guard never touched. reconcileCashLedger then
  // feeds those arrays into the ledger the analytics counts, so the pollution
  // returns by a route the fix had closed at the other end.
  const CUT = Date.parse("2026-09-14T15:30:00Z");
  const stored = { legacyId: "1", studentNumber: "1" };
  const rows = (...ts) => ts.map((t, i) => ({ id: "t" + i, amount: 100, timestamp: t }));

  const mixed = planPatch(stored, {
    id: "1",
    wildcatCashTransactions: rows(
      "2026-08-20T16:37:14.634Z",   // last term
      "2026-09-14T15:42:29.550Z",   // today
      "2026-09-14T20:26:48.163Z",   // today
    ),
  }, STUDENT_WRITABLE, CUT);
  check("pre-cutoff rows are pruned from the array",
    mixed.wildcatCashTransactions.length === 2);
  check("and the ones kept are today's",
    mixed.wildcatCashTransactions.every((r) => r.timestamp >= "2026-09-14T15:30"));

  // AN UNDATED ROW IS KEPT. It cannot be proved old, and dropping a teacher's
  // award to be tidy is the worse error.
  const undated = planPatch(stored, {
    id: "1", wildcatCashTransactions: [{ id: "x", amount: 100 }],
  }, STUDENT_WRITABLE, CUT);
  check("an undated row survives", undated.wildcatCashTransactions.length === 1);

  // NO CUTOFF means no pruning: the behaviour before this existed, and what
  // every three-argument call site still gets.
  const noCutoff = planPatch(stored, {
    id: "1", wildcatCashTransactions: rows("2026-08-20T16:37:14.634Z"),
  }, STUDENT_WRITABLE);
  check("with no cutoff, nothing is pruned", noCutoff.wildcatCashTransactions.length === 1);

  // CLOCK SLACK, matching the ledger guard: a row half an hour early survives,
  // one two hours early does not.
  const slack = planPatch(stored, {
    id: "1", wildcatCashTransactions: rows("2026-09-14T15:00:00Z"),
  }, STUDENT_WRITABLE, CUT);
  check("a row 30 minutes before the cutoff is kept", slack.wildcatCashTransactions.length === 1);
  const wayOff = planPatch(stored, {
    id: "1", wildcatCashTransactions: rows("2026-09-14T13:00:00Z"),
  }, STUDENT_WRITABLE, CUT);
  check("a row two hours before it is not", wayOff.wildcatCashTransactions.length === 0);

  // A non-array value is not this rule's business.
  const junk = planPatch(stored, {
    id: "1", wildcatCashTransactions: "not an array",
  }, STUDENT_WRITABLE, CUT);
  check("a non-array value passes through untouched",
    junk.wildcatCashTransactions === "not an array");

  // AND THE COUNTERS ARE UNTOUCHED BY ANY OF THIS. Pruning history must not
  // move money: the balance is delta-only and this rule never sees a delta.
  const withDelta = planPatch({ ...stored, wildcatCashBalance: 100 }, keyed(50, "award", {
    id: "1",
    wildcatCashTransactions: rows("2026-08-20T16:37:14.634Z"),
  }), STUDENT_WRITABLE, CUT);
  check("a delta still applies while its history row is pruned",
    withDelta.wildcatCashBalance === 150 && withDelta.wildcatCashTransactions.length === 0);

  // PRUNING MUST NOT BECOME DELETING. mergeIncoming writes an array whole, so
  // a stale tab's save replaces the field. Prune that tab's array and the
  // write becomes "today's history, minus everything except my two recent
  // rows" -- the resurrection bug turned into a deletion bug. A record that
  // was carrying stale rows is therefore UNIONED with what the server holds.
  const storedToday = {
    legacyId: "1", studentNumber: "1",
    wildcatCashTransactions: [
      { id: "a", amount: 100, timestamp: "2026-09-14T16:00:00Z" },
      { id: "b", amount: 100, timestamp: "2026-09-14T17:00:00Z" },
    ],
  };
  const stale = planPatch(storedToday, {
    id: "1",
    wildcatCashTransactions: [
      { id: "old", amount: 100, timestamp: "2026-08-20T16:37:14.634Z" },
      { id: "c", amount: 100, timestamp: "2026-09-14T18:00:00Z" },
    ],
  }, STUDENT_WRITABLE, CUT);
  check("a stale tab's save does not erase today's stored rows",
    stale.wildcatCashTransactions.map((r) => r.id).join(",") === "a,b,c");

  // A row the server already has is not duplicated by the union.
  const resend = planPatch(storedToday, {
    id: "1",
    wildcatCashTransactions: [
      { id: "old", amount: 100, timestamp: "2026-08-20T16:37:14.634Z" },
      { id: "a", amount: 100, timestamp: "2026-09-14T16:00:00Z" },
    ],
  }, STUDENT_WRITABLE, CUT);
  // The union came out identical to what is stored, so mergeIncoming writes
  // nothing at all -- the field is absent from the patch, not set to a copy.
  check("and re-sending a row the server has writes nothing",
    !("wildcatCashTransactions" in resend));

  // A SAVE CANNOT CLEAR A HISTORY AT ALL, and the empty array is the case that
  // proves it. I exempted emptiness on 2026-09-16 for the year-end roll --
  // "emptiness is a decision, brevity is an accident" -- and a tab that failed
  // to read the ledger wrote `[]` onto all 620 students through the exemption
  // within three hours, taking 1,096 rows to seven. A FAILED LOAD PRODUCES
  // EMPTINESS. Clearing is an administrative act with a backup step and
  // belongs in legacyPurge:zeroAllStudentCash, which does counters and arrays
  // together and cannot be reached by a browser.
  const roll = planPatch(storedToday, {
    id: "1", wildcatCashTransactions: [],
  }, STUDENT_WRITABLE, CUT);
  check("an empty array cannot erase a stored history",
    !("wildcatCashTransactions" in roll)
    || roll.wildcatCashTransactions.length === storedToday.wildcatCashTransactions.length);

  // A student with NOTHING stored still gets their first rows; the rule is
  // about shrinking, not about writing.
  const firstEver = planPatch({ legacyId: "1", studentNumber: "1" }, {
    id: "1", wildcatCashTransactions: rows("2026-09-14T16:00:00Z"),
  }, STUDENT_WRITABLE, CUT);
  check("a first row still lands on an empty record",
    firstEver.wildcatCashTransactions.length === 1);

  // Rows with no id are keyed by content, so the union neither duplicates a
  // re-send nor collapses two different awards in the same second.
  const noIds = planPatch({
    legacyId: "1", studentNumber: "1",
    wildcatCashTransactions: [{ amount: 100, timestamp: "2026-09-14T16:00:00Z" }],
  }, {
    id: "1",
    wildcatCashTransactions: [
      { amount: 100, timestamp: "2026-08-20T16:00:00Z" },
      { amount: 100, timestamp: "2026-09-14T16:00:00Z" },
      { amount: 250, timestamp: "2026-09-14T16:00:00Z" },
    ],
  }, STUDENT_WRITABLE, CUT);
  check("id-less rows union by content rather than by position",
    noIds.wildcatCashTransactions.length === 2
    && noIds.wildcatCashTransactions.map((r) => r.amount).join(",") === "100,250");

  // A SHORT TAB CANNOT SHRINK A HISTORY, which is the rule the 2026-09-16
  // collapse needed. The arrays were repaired to 1,094 rows at 17:48 and were
  // down to SIX by 18:14, because distributeCashTransactions rebuilds every
  // student's array from whatever the saving tab holds and one tab held almost
  // nothing.
  const fat = {
    legacyId: "1", studentNumber: "1",
    wildcatCashTransactions: rows(
      "2026-09-16T16:00:00Z", "2026-09-16T16:01:00Z", "2026-09-16T16:02:00Z"),
  };
  const shortTab = planPatch(fat, {
    id: "1", wildcatCashTransactions: [{ id: "t0", amount: 100, timestamp: "2026-09-16T16:00:00Z" }],
  }, STUDENT_WRITABLE, CUT);
  check("a tab sending one row does not erase the other two",
    !("wildcatCashTransactions" in shortTab)
    || shortTab.wildcatCashTransactions.length === 3);

  // And it can still ADD. Append is the whole point; only shrinking is refused.
  const adds = planPatch(fat, {
    id: "1",
    wildcatCashTransactions: [{ id: "new", amount: 100, timestamp: "2026-09-16T17:00:00Z" }],
  }, STUDENT_WRITABLE, CUT);
  check("but a new row is still added", adds.wildcatCashTransactions.length === 4);

  // NOT EVEN TO EMPTY. See the note above: a tab that could not read the ledger
  // sends empty arrays for every student, which is indistinguishable from a
  // deliberate clear and was honoured as one.
  const rollNow = planPatch(fat, {
    id: "1", wildcatCashTransactions: [],
  }, STUDENT_WRITABLE, CUT);
  check("an empty array does not erase three stored rows",
    !("wildcatCashTransactions" in rollNow)
    || rollNow.wildcatCashTransactions.length === 3);

  // planSave threads it through, which is what appData:save actually calls.
  const plan = planSave([stored], [{
    id: "1", wildcatCashTransactions: rows("2026-08-20T16:37:14.634Z", "2026-09-14T16:00:00Z"),
  }], STUDENT_WRITABLE, (r) => [r.legacyId, r.studentNumber], CUT);
  check("planSave passes the cutoff to planPatch",
    plan.patches[0].patch.wildcatCashTransactions.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
