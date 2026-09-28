// A child spending their own Wildcat Cash.
//
// WHY THIS FILE IS THE CAREFUL ONE. Until now a student's tap could not move
// money: the portal is four queries and no mutations, and the only student
// write path that exists at all is hall passes, which are closed. This is the
// first time a 12-year-old spends, and hundreds of them will do it at once,
// faster and less carefully than any adult uses this app. Some of them will
// find the developer console.
//
// So the assertions that matter most are not about a purchase succeeding. They
// are about what the server refuses to be told: no cost, no total, no balance,
// no student id. And about two children tapping the last item in the same
// second, which at 620 students is a Tuesday rather than a hypothetical.
//
// Run: npm test

import {
  buildPurchaseLedgerRow,
  buildStudentReceipt,
  normalizeQuantity,
  purchaseCounterDelta,
  studentPurchaseVerdict,
  MAX_STUDENT_QUANTITY,
  STORE_CLOSED_DEFAULT,
  effectiveStoreState,
  ownedUnits,
  rewardCampus,
  rewardLimit,
  studentCampus,
} from "./studentStoreRules.ts";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  (" + d + ")" : ""}`); }
};

const src = readFileSync(new URL("./studentStore.ts", import.meta.url), "utf8");
// Comments stripped before any "this does not appear" assertion: the fourth
// time in this project that an assertion matched its own documentation.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const KID = { id: "S1", firstName: "Ana", lastName: "Reyes", grade: "6",
              wildcatCashBalance: 1000, enrolled: true };
const ITEM = { id: "r1", name: "Front of Line Pass", cost: 500, category: "General",
               stock: null, available: true, studentPurchasable: true };
const OPEN = { storeOpen: true };

console.log("\n1. The store is shut until somebody opens it");
{
  // DEFAULTS TO CLOSED. The UI ships in a deploy that changes nothing, and
  // goes live later by writing one appState row -- which reloads nobody and
  // undoes in seconds.
  const shut = studentPurchaseVerdict({ student: KID, reward: ITEM, storeOpen: false });
  check("a closed store refuses everything", !shut.allowed && shut.code === "store_closed");

  // BEFORE any complaint about their balance. A shut store is not the child's
  // fault, and telling them they are poor first is both unkind and wrong.
  const broke = studentPurchaseVerdict({
    student: { ...KID, wildcatCashBalance: 0 }, reward: ITEM, storeOpen: false });
  check("and says so before it mentions their money", broke.code === "store_closed");

  check("a custom closed message is used when set",
    studentPurchaseVerdict({ student: KID, reward: ITEM, storeOpen: false,
      closedReason: "Opens Monday at lunch." }).reason === "Opens Monday at lunch.");
  // ONE default, exported, so the message cannot depend on which code path
  // noticed the store was shut. There were briefly two.
  // The server reads the switch ONLY through effectiveStoreState, which is
  // where the one default lives now (2026-09-28, with the timed open/close).
  check("and there is a single shared default when it is not",
    studentPurchaseVerdict({ student: KID, reward: ITEM, storeOpen: false }).reason
      === STORE_CLOSED_DEFAULT
    && effectiveStoreState(undefined, Date.now()).reason === STORE_CLOSED_DEFAULT
    && /effectiveStoreState\(/.test(readFileSync(
        new URL("./studentStore.ts", import.meta.url), "utf8")));
}

console.log("\n2. A reward is staff-only until it is deliberately opened up");
{
  // ABSENT IS FALSE. Five of the six rewards in this school's catalogue predate
  // the field. None may become self-serve just because this code shipped.
  const { studentPurchasable, ...noFlag } = ITEM;
  const v = studentPurchaseVerdict({ student: KID, reward: noFlag, ...OPEN });
  check("a reward with no flag is not in the student store",
    !v.allowed && v.code === "not_self_serve");
  check("nor is one explicitly set false",
    !studentPurchaseVerdict({ student: KID, reward: { ...ITEM, studentPurchasable: false }, ...OPEN }).allowed);
  check("and the message sends them to a person, not a field name",
    /Ask a teacher/.test(v.reason) && !/purchasable/i.test(v.reason));

  check("the flagged one is fine",
    studentPurchaseVerdict({ student: KID, reward: ITEM, ...OPEN }).allowed);
}

console.log("\n3. What a child is told when they cannot buy it");
{
  // Every message here is read BY A STUDENT. No ids, no field names.
  const poor = studentPurchaseVerdict({
    student: { ...KID, wildcatCashBalance: 100 }, reward: ITEM, ...OPEN });
  check("not enough money is refused", !poor.allowed && poor.code === "cannot_afford");
  check("and it says how much more, not just no",
    poor.shortfall === 400 && /need \$400 more/.test(poor.reason));
  check("with their real balance in it", /You have \$100/.test(poor.reason));

  const sold = studentPurchaseVerdict({ student: KID, reward: { ...ITEM, stock: 0 }, ...OPEN });
  check("sold out is refused", !sold.allowed && sold.code === "out_of_stock");
  check("and says it plainly", /sold out/.test(sold.reason));

  const few = studentPurchaseVerdict({
    student: { ...KID, wildcatCashBalance: 5000 }, reward: { ...ITEM, stock: 2 },
    quantity: 3, ...OPEN });
  check("too many for the stock left is refused", !few.allowed && few.code === "low_stock");
  check("and names the number they can have", /Only 2 left/.test(few.reason));

  check("a retired reward is refused",
    !studentPurchaseVerdict({ student: KID, reward: { ...ITEM, retiredAt: "2026-01-01" }, ...OPEN }).allowed);
  check("an unavailable one too",
    !studentPurchaseVerdict({ student: KID, reward: { ...ITEM, available: false }, ...OPEN }).allowed);

  // A FREE REWARD IS A BUG, NOT A BARGAIN. Handing out stock for nothing while
  // somebody works out what happened is the worse failure.
  const free = studentPurchaseVerdict({ student: KID, reward: { ...ITEM, cost: 0 }, ...OPEN });
  check("an unpriced reward is refused rather than given away",
    !free.allowed && free.code === "no_price");

  // A child who has left keeps a working Google account for a while.
  check("a student who is no longer enrolled is refused",
    !studentPurchaseVerdict({ student: { ...KID, enrolled: false }, reward: ITEM, ...OPEN }).allowed);
  check("and so is an archived one",
    !studentPurchaseVerdict({ student: { ...KID, archivedAt: "2026-06-01" }, reward: ITEM, ...OPEN }).allowed);
}

console.log("\n4. Quantity, because a spinner a child can hold down will be held down");
{
  check("one is fine", normalizeQuantity(1) === 1);
  check("the cap is fine", normalizeQuantity(MAX_STUDENT_QUANTITY) === MAX_STUDENT_QUANTITY);
  check("over the cap is not", normalizeQuantity(MAX_STUDENT_QUANTITY + 1) === null);
  check("zero is not", normalizeQuantity(0) === null);
  check("negative is not", normalizeQuantity(-1) === null);
  check("a fraction is not", normalizeQuantity(1.5) === null);
  check("a string number is read", normalizeQuantity("3") === 3);
  check("nonsense is not", normalizeQuantity("lots") === null);
  check("Infinity is not", normalizeQuantity(Infinity) === null);
  check("a hundred passes at once is refused by the verdict too",
    !studentPurchaseVerdict({ student: { ...KID, wildcatCashBalance: 999999 },
      reward: ITEM, quantity: 100, ...OPEN }).allowed);
}

console.log("\n5. It is a purchase, not a punishment");
{
  // Getting this wrong is what put Maria Agaton Colin in a red intervention
  // table: her five flagging rows were all Homework Pass purchases. `spent`
  // goes up, the balance goes down, `earned` and `deducted` are untouched.
  const d = purchaseCounterDelta(500);
  check("the balance goes down", d.wildcatCashBalance === -500);
  check("spent goes up", d.wildcatCashSpent === 500);
  check("earned is untouched", !("wildcatCashEarned" in d));
  check("and deducted is untouched, so it cannot read as a behaviour",
    !("wildcatCashDeducted" in d));

  const row = buildPurchaseLedgerRow({
    txnId: "txn_buy_1", receiptId: "WC-ABC123", student: KID, studentAppId: "S1",
    reward: ITEM, quantity: 1, total: 500,
    nowIso: "2026-09-16T18:00:00Z", balanceAfter: 500,
  });
  check("the ledger row is a redemption", row.kind === "redeem");
  check("its amount is negative", row.amount === -500);
  check("and `type` is the sign, as eleven panels expect", row.type === "negative");
  check("no teacher is credited for a child's own purchase",
    row.teacherId === "" && row.teacherUsername === "");
  check("the receipt is findable from the ledger row", /WC-ABC123/.test(String(row.notes)));
  check("and it is marked self-serve", /\[self-serve\]/.test(String(row.notes)));
}

console.log("\n6. The receipt is the same shape the staff store already fulfils");
{
  // canFulfill / applyFulfill / canCancel / buildCancel already work on these.
  // A differently-shaped receipt would be un-fulfillable and un-refundable by
  // every screen that exists.
  const r = buildStudentReceipt({
    receiptId: "WC-ABC123", student: KID, studentAppId: "S1", reward: ITEM,
    quantity: 2, nowIso: "2026-09-16T18:00:00Z",
  });
  const storeSrc = readFileSync(new URL("../wildcat-store.js", import.meta.url), "utf8");
  const staffShape = storeSrc.slice(storeSrc.indexOf("var receipt = {"),
                                    storeSrc.indexOf("var transactionRequest"));
  const staffFields = [...staffShape.matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]);
  const missing = staffFields.filter((f) => !(f in r));
  check("every field the staff receipt has, this one has too",
    missing.length === 0, missing.join(", "));

  check("the snapshot keeps what was actually paid",
    r.unitCost === 500 && r.totalCost === 1000 && r.rewardName === "Front of Line Pass");
  check("the child is the actor", r.purchasedBy.role === "student");
  check("and the channel says self-serve", r.channel === "student");
  check("it starts issued, not fulfilled", r.status === "issued" && r.fulfilledAt === null);
  check("middle school is derived from the grade", r.school === "Middle School");
  check("and high school for a ninth grader",
    buildStudentReceipt({ receiptId: "x", student: { ...KID, grade: "9" }, studentAppId: "S1",
      reward: ITEM, quantity: 1, nowIso: "2026-09-16T18:00:00Z" }).school === "High School");

  // AN EMPTY STUDENT ID THROWS, LOUDLY. It used to be read off `student.id`,
  // and the mutation hands these a RAW Convex row -- `_id` and `legacyId`, no
  // `id` -- so it silently wrote "". WC-A68031 then cancelled without a refund,
  // because the staff path looks the student up by that field, found nobody,
  // and buildCancel only refunds `if (refund && o.student)`. The toast still
  // said "cancelled and refunded". $100 never moved.
  const threw = (fn) => { try { fn(); return false; } catch (e) { return /studentAppId/.test(e.message); } };
  check("a receipt refuses to be built with no student id",
    threw(() => buildStudentReceipt({ receiptId: "x", student: KID, studentAppId: "",
      reward: ITEM, quantity: 1, nowIso: "2026-09-16T18:00:00Z" })));
  check("and so does a ledger row, which would otherwise belong to nobody",
    threw(() => buildPurchaseLedgerRow({ txnId: "t", receiptId: "x", student: KID,
      studentAppId: "  ", reward: ITEM, quantity: 1, total: 500,
      nowIso: "2026-09-16T18:00:00Z", balanceAfter: 0 })));
  check("the receipt carries the id it was given, not one it guessed",
    buildStudentReceipt({ receiptId: "x", student: KID, studentAppId: "11225",
      reward: ITEM, quantity: 1, nowIso: "2026-09-16T18:00:00Z" }).studentId === "11225");
  check("and the mutation computes it as toAppStudent does",
    /const studentAppId = String\(student\.legacyId \?\? student\._id\);/.test(code));
}

console.log("\n7. These rules agree with the staff store's, which is in production");
{
  // There is no bundler -- index.html loads plain <script> tags -- so
  // wildcat-store.js cannot be imported into convex/ and studentStoreRules is
  // a deliberate duplicate. The day they disagree is the day a child is
  // charged a price the receipt does not show, so they are pinned here.
  const storeSrc = readFileSync(new URL("../wildcat-store.js", import.meta.url), "utf8");
  const lift = (name) => {
    const at = storeSrc.indexOf(`function ${name}(`);
    return storeSrc.slice(at, storeSrc.indexOf("\n  }\n", at) + 5);
  };
  const staff = new Function(
    "function isFiniteNumber(v){return typeof v==='number'&&isFinite(v);}\n" +
    "function balanceOf(s){var b=Number(s&&s.wildcatCashBalance);return isFinite(b)?b:0;}\n" +
    "function trimmed(s){return String(s==null?'':s).trim();}\n" +
    "var CAMPUSES = ['all', 'middle', 'high'];\n" +
    // The campus and limit helpers joined canPurchase on 2026-09-28. Lifted,
    // not re-typed, so this runs the staff store's own copies.
    lift("rewardCampusOf") + lift("studentCampusOf") + lift("rewardLimitOf") +
    lift("ownedUnits") + lift("campusName") +
    lift("canPurchase") + "\nreturn canPurchase;")();

  // On the cases the two SHARE -- an enrolled student, an open store, a
  // flagged reward -- the answers must be identical. The student rules add
  // refusals on top; they must never ALLOW something the staff rules refuse.
  const cases = [
    { student: KID, reward: ITEM, quantity: 1 },
    { student: KID, reward: ITEM, quantity: 2 },
    { student: { ...KID, wildcatCashBalance: 499 }, reward: ITEM, quantity: 1 },
    { student: { ...KID, wildcatCashBalance: 500 }, reward: ITEM, quantity: 1 },
    { student: KID, reward: { ...ITEM, stock: 0 }, quantity: 1 },
    { student: KID, reward: { ...ITEM, stock: 1 }, quantity: 2 },
    { student: KID, reward: { ...ITEM, retiredAt: "2026-01-01" }, quantity: 1 },
    { student: KID, reward: { ...ITEM, available: false }, quantity: 1 },
    { student: { ...KID, wildcatCashBalance: 5000 }, reward: { ...ITEM, cost: 2500 }, quantity: 2 },
    // THE CAMPUS AND THE LIMIT (2026-09-28). Buying it at the office must not
    // be a way around either rule.
    { student: { ...KID, grade: "7" }, reward: { ...ITEM, campus: "middle" }, quantity: 1 },
    { student: { ...KID, grade: "7" }, reward: { ...ITEM, campus: "high" }, quantity: 1 },
    { student: { ...KID, grade: "11" }, reward: { ...ITEM, campus: "high" }, quantity: 1 },
    { student: { ...KID, grade: "11" }, reward: { ...ITEM, campus: "middle" }, quantity: 1 },
    { student: { ...KID, grade: "" }, reward: { ...ITEM, campus: "middle" }, quantity: 1 },
    { student: KID, reward: { ...ITEM, campus: "Middle School" }, quantity: 1 },
    { student: KID, reward: { ...ITEM, limitPerStudent: 1 }, quantity: 1, receipts: [] },
    { student: KID, reward: { ...ITEM, limitPerStudent: 1 }, quantity: 2, receipts: [] },
    { student: KID, reward: { ...ITEM, limitPerStudent: 1 }, quantity: 1,
      receipts: [{ studentId: "S1", rewardId: "r1", quantity: 1, status: "issued" }] },
    { student: KID, reward: { ...ITEM, limitPerStudent: 1 }, quantity: 1,
      receipts: [{ studentId: "S1", rewardId: "r1", quantity: 1, status: "cancelled" }] },
    { student: KID, reward: { ...ITEM, limitPerStudent: 1 }, quantity: 1,
      receipts: [{ studentId: "S2", rewardId: "r1", quantity: 1, status: "issued" }] },
    { student: KID, reward: { ...ITEM, limitPerStudent: 0 }, quantity: 1 },
  ];
  const disagreements = [];
  for (const c of cases) {
    const alreadyOwned = ownedUnits(c.receipts || [], c.student.id, c.reward.id);
    const mine = studentPurchaseVerdict({ ...c, ...OPEN, alreadyOwned });
    const theirs = staff(c);
    if (mine.allowed !== theirs.allowed) {
      disagreements.push(`${c.reward.name} x${c.quantity} @$${c.student.wildcatCashBalance}: ` +
        `student=${mine.allowed} staff=${theirs.allowed}`);
    } else if (mine.allowed && mine.total !== theirs.total) {
      disagreements.push(`total differs: ${mine.total} vs ${theirs.total}`);
    }
  }
  check("student and staff rules agree on every shared case",
    disagreements.length === 0, disagreements.join(" | "));

  // And the shortfall arithmetic matches, since both report it to a human.
  const mineShort = studentPurchaseVerdict({
    student: { ...KID, wildcatCashBalance: 100 }, reward: ITEM, quantity: 1, ...OPEN });
  const theirsShort = staff({ student: { ...KID, wildcatCashBalance: 100 }, reward: ITEM, quantity: 1 });
  check("and on the shortfall", mineShort.shortfall === theirsShort.shortfall);
}

console.log("\n8. What the mutation refuses to be told");
{
  const args = code.slice(code.indexOf("export const purchaseFor = internalMutation({"),
                          code.indexOf("handler", code.indexOf("export const purchaseFor")));
  check("no cost", !/cost/i.test(args));
  check("no total", !/total/i.test(args));
  check("no balance", !/balance/i.test(args));
  check("no counter delta", !/delta/i.test(args));
  check("it takes a reward id, a quantity and an attempt token",
    /rewardId: v\.string\(\)/.test(args) && /attemptId: v\.string\(\)/.test(args));

  // THE PUBLIC PAIR SHIPPED WITH THE UI, as planned. What has to stay true is
  // what they refuse to be told: a student id (a child who could name the
  // buyer could name somebody else) and a price.
  const pub = code.slice(code.indexOf("export const purchase = mutation({"),
                         code.indexOf("handler", code.indexOf("export const purchase = mutation({")));
  check("purchase takes no student id", !/studentNumber|studentId/.test(pub), pub.replace(/\s+/g, " "));
  check("and no price", !/cost|total|balance/i.test(pub));
  check("both public entry points resolve the student from their own token",
    (code.match(/requireStudentSelf\(ctx\)/g) || []).length >= 2);
  check("and the store still defaults to CLOSED, so shipping changed nothing",
    effectiveStoreState(undefined, Date.now()).open === false
    && effectiveStoreState({ open: "true" }, Date.now()).open === false
    && /const s = effectiveStoreState\(row\?\.value/.test(code));
}

console.log("\n9. Two children tapping the last one");
{
  // The pure verdict sees a SNAPSHOT of stock and cannot hold a lock. The
  // authoritative check is in the mutation, in the same transaction that
  // decrements it -- without the pair, both children pass and both get a
  // receipt for an item that exists once, and an adult has to break a promise.
  check("stock is re-read inside the mutation", /const liveStock = reward!\.stock;/.test(code));
  check("and re-checked before anything is written",
    code.indexOf("Number(liveStock) < quantity") < code.indexOf('insert("studentPurchases"'));
  check("then decremented in the same transaction",
    /stock: Number\(liveStock\) - quantity/.test(code));
  check("unlimited stock is left alone", /if \(liveStock != null\)/.test(code));

  // A DOUBLE-TAP IS A QUIET SUCCESS. Keyed on the button press, not the
  // intent: two Homework Passes is a legitimate thing to want.
  // SCOPED TO doPurchase. Compared across the whole file this read the
  // storeState call inside storeForStudent, which is a different function
  // entirely -- an assertion that looks past its subject fails for reasons
  // that have nothing to do with what it is checking.
  const buy = code.slice(code.indexOf("async function doPurchase"),
                         code.indexOf("export const purchaseFor"));
  check("the register is read by its index before anything else",
    /withIndex\("by_attemptId"/.test(buy)
    && buy.indexOf("by_attemptId") < buy.indexOf("await storeState"));
  check("a repeat returns the first receipt rather than charging again",
    /alreadyBought: true/.test(code));
  check("the register is written before the money moves",
    code.indexOf('insert("studentPurchases"') < code.indexOf("ctx.db.patch(student._id"));
  // Minted from the server's own randomness and checked against every code
  // already issued. It used to be the last six of the browser's attempt token,
  // which let a child choose their own code -- or somebody else's.
  check("the receipt code is minted server-side",
    /const receiptId = mintReceiptCode\(new Set\(receipts\.map/.test(code)
    && /const code = "WC-" \+ out;/.test(code)
    && !/receiptId = [^;]*attemptId/.test(code));
  check("counters move by adding the delta to what is stored",
    /patch\[field\] = \(Number\.isFinite\(base\) \? base : 0\) \+ d;/.test(code));
  check("and the student's own copy of the row is written, for their wallet",
    /wildcatCashTransactions: \[\.\.\.storedHistory, ledgerRow\]/.test(code));
}

console.log("\n9b. No mirror insert carries a key");
{
  // THE WORST BUG OF THE DAY, and it was three characters. loadDoc decides a
  // collection's shape with `slice.some(r => typeof r.key === "string")` and
  // builds the map from keyed rows ONLY, so ONE keyed row in an unkeyed
  // collection makes every other row vanish from what the client loads.
  // mergeSlice's own comment warns about it: "Mixing the two loses rows
  // silently."
  //
  // A keyed receipt and a keyed ledger row put 1,485 cash rows and 4 receipts
  // behind a two-entry map. Staff tabs loaded a near-empty ledger,
  // distributeCashTransactions rebuilt all 620 student histories from it, and
  // the arrays fell to single digits -- diagnosed twice, guarded twice, cause
  // never asked about. Then Receipts threw: an array had become an object.
  const inserts = [...code.matchAll(/ctx\.db\.insert\("legacyMirror",\s*\{([\s\S]*?)\}\)/g)]
    .map((m) => m[1]);
  check("there are mirror inserts to check", inserts.length >= 2, String(inserts.length));
  const keyed = inserts.filter((b) => /(^|\s)key:/.test(b));
  check("and not one of them sets a key", keyed.length === 0,
    keyed.map((k) => k.replace(/\s+/g, " ").slice(0, 70)).join(" | "));
}

console.log("\n10. The purchase log has what an export needs");
{
  const log = code.slice(code.indexOf("export const purchaseLog = internalQuery({"), code.length);
  for (const field of ["studentName", "studentNumber", "grade", "reward",
                       "quantity", "unitCost", "totalCost", "date", "time",
                       "boughtBy", "channel", "status"]) {
    check(`the log carries ${field}`, new RegExp(`\\b${field}:`).test(log));
  }
  // A spreadsheet handed one ISO string cannot be sorted by day without
  // somebody writing a formula.
  check("date and time are split out as well as the raw stamp",
    /purchasedAtIso:/.test(log) && /date: valid/.test(log) && /time: valid/.test(log));
  check("cancelled receipts are excluded from the money total",
    /filter\(\(r\) => r\.status !== "cancelled"\)/.test(log));
  check("it reads receipts, which know about fulfilment, not the ledger",
    /RECEIPTS_COLLECTION/.test(log) && !/cash_tx_/.test(log));
  check("the student number comes from the live record",
    /studentNumber: st\?\.studentNumber/.test(log));
}

console.log("\n11. Which campus a reward is for, and which a child is on");
{
  check("absent is everyone", rewardCampus({}) === "all" && rewardCampus({ campus: null }) === "all"
    && rewardCampus({ campus: "" }) === "all");
  check("the three campus words, whatever their case",
    rewardCampus({ campus: "middle" }) === "middle" && rewardCampus({ campus: " HIGH " }) === "high"
    && rewardCampus({ campus: "All" }) === "all");
  // A TYPO IS NOT "EVERYONE". Reading "Middle School" as all would sell the
  // middle school pass to the high school, the one thing asked for.
  check("anything else is null, which the verdict refuses",
    rewardCampus({ campus: "Middle School" }) === null && rewardCampus({ campus: "ms" }) === null);
  check("grades 6 to 8 are the middle school",
    ["6", "7", "8", "06", 7].every((g) => studentCampus(g) === "middle"));
  check("grades 9 to 12 are the high school",
    ["9", "10", "11", "12"].every((g) => studentCampus(g) === "high"));
  check("anything else is unknown, not rounded to the nearer campus",
    ["", "5", "13", "K", null, undefined, "Grade 7"].every((g) => studentCampus(g) === null));

  const MS = { ...ITEM, campus: "middle" }, HS = { ...ITEM, campus: "high" };
  const seventh = { ...KID, grade: "7" }, tenth = { ...KID, grade: "10" };
  check("a middle schooler may buy a middle school item",
    studentPurchaseVerdict({ student: seventh, reward: MS, ...OPEN }).allowed);
  const wrong = studentPurchaseVerdict({ student: seventh, reward: HS, ...OPEN });
  check("but not a high school one", !wrong.allowed && wrong.code === "wrong_campus");
  check("and is told whose it is", /High School/.test(wrong.reason));
  check("the reverse holds", studentPurchaseVerdict({ student: tenth, reward: MS, ...OPEN }).code === "wrong_campus");
  check("an everyone item is for everyone",
    studentPurchaseVerdict({ student: tenth, reward: ITEM, ...OPEN }).allowed);
  check("the campus answer comes before the money answer",
    studentPurchaseVerdict({ student: { ...seventh, wildcatCashBalance: 0 }, reward: HS, ...OPEN }).code === "wrong_campus");
  check("but after the store being shut",
    studentPurchaseVerdict({ student: seventh, reward: HS, storeOpen: false }).code === "store_closed");
  check("an unreadable grade is sent to the office",
    studentPurchaseVerdict({ student: { ...KID, grade: "" }, reward: MS, ...OPEN }).code === "unknown_campus");
  check("and does not matter for an everyone item",
    studentPurchaseVerdict({ student: { ...KID, grade: "" }, reward: ITEM, ...OPEN }).allowed);
  check("a campus typo is refused rather than sold to everyone",
    studentPurchaseVerdict({ student: seventh, reward: { ...ITEM, campus: "Middle School" }, ...OPEN }).code === "bad_campus");
}

console.log("\n12. One per student");
{
  check("no limit is null", rewardLimit({}) === null && rewardLimit({ limitPerStudent: null }) === null);
  check("a whole number of one or more is the limit", rewardLimit({ limitPerStudent: 1 }) === 1
    && rewardLimit({ limitPerStudent: "3" }) === 3);
  check("anything else is undefined, which the verdict refuses",
    [0, -1, 1.5, "one", NaN].every((x) => rewardLimit({ limitPerStudent: x }) === undefined));

  const ONE = { ...ITEM, limitPerStudent: 1 };
  check("the first is allowed", studentPurchaseVerdict({ student: KID, reward: ONE, ...OPEN, alreadyOwned: 0 }).allowed);
  const second = studentPurchaseVerdict({ student: KID, reward: ONE, ...OPEN, alreadyOwned: 1 });
  check("the second is refused", !second.allowed && second.code === "limit_reached");
  check("in words a child can read", /already have this one/.test(second.reason));
  check("two at once when one is allowed is refused",
    studentPurchaseVerdict({ student: KID, reward: ONE, ...OPEN, quantity: 2 }).code === "limit_reached");
  check("a limit of three leaves room for the rest",
    /1 more/.test(studentPurchaseVerdict({ student: { ...KID, wildcatCashBalance: 9999 },
      reward: { ...ITEM, limitPerStudent: 3 }, ...OPEN, alreadyOwned: 2, quantity: 2 }).reason));
  check("no limit ignores what they hold",
    studentPurchaseVerdict({ student: KID, reward: ITEM, ...OPEN, alreadyOwned: 40 }).allowed);
  check("a broken limit is refused, not read as no limit",
    studentPurchaseVerdict({ student: KID, reward: { ...ITEM, limitPerStudent: 0 }, ...OPEN }).code === "bad_limit");
  check("already holding one is the answer even when they are broke",
    studentPurchaseVerdict({ student: { ...KID, wildcatCashBalance: 0 }, reward: ONE, ...OPEN,
      alreadyOwned: 1 }).code === "limit_reached");

  const R = [
    { studentId: "S1", rewardId: "r1", quantity: 1, status: "issued" },
    { studentId: "S1", rewardId: "r1", quantity: 2, status: "fulfilled" },
    { studentId: "S1", rewardId: "r1", quantity: 1, status: "cancelled" },
    { studentId: "S1", rewardId: "r2", quantity: 1, status: "issued" },
    { studentId: "S2", rewardId: "r1", quantity: 1, status: "issued" },
    { studentId: "S1", rewardId: "r1", status: "issued" },
    null,
  ];
  check("owned counts units on every live receipt, fulfilled or not", ownedUnits(R, "S1", "r1") === 4);
  check("a cancelled receipt is not held", ownedUnits([R[2]], "S1", "r1") === 0);
  check("another reward or another child is not counted", ownedUnits(R, "S2", "r1") === 1
    && ownedUnits(R, "S1", "r2") === 1);
  check("an empty id owns nothing, rather than matching every blank",
    ownedUnits([{ studentId: "", rewardId: "", status: "issued" }], "", "") === 0);
}

console.log("\n13. The price the child saw");
{
  check("the same price goes through",
    studentPurchaseVerdict({ student: KID, reward: ITEM, ...OPEN, seenPrice: 500 }).allowed);
  const moved = studentPurchaseVerdict({ student: KID, reward: ITEM, ...OPEN, seenPrice: 400 });
  check("a different one is refused, naming the new price", moved.code === "price_changed" && /\$500/.test(moved.reason));
  check("not saying is allowed", studentPurchaseVerdict({ student: KID, reward: ITEM, ...OPEN }).allowed);
  check("junk is a mismatch", studentPurchaseVerdict({ student: KID, reward: ITEM, ...OPEN, seenPrice: "cheap" }).code === "price_changed");
  check("and the total is always the catalogue's, never the one sent",
    studentPurchaseVerdict({ student: KID, reward: ITEM, ...OPEN, seenPrice: 500 }).total === 500);
}

console.log("\n14. The switch, the clock and the closing time");
{
  const now = Date.parse("2026-09-29T15:00:00Z");
  check("nothing stored is shut", effectiveStoreState(undefined, now).open === false);
  check("open is open", effectiveStoreState({ open: true }, now).open === true);
  check("open with a closing time ahead is open",
    effectiveStoreState({ open: true, closesAt: "2026-09-30T06:59:00Z" }, now).open === true);
  const past = effectiveStoreState({ open: true, closesAt: "2026-09-29T14:59:59Z",
    reason: "Opens Tuesday.", endedReason: "Sales have ended." }, now);
  check("open past the closing time is SHUT, whether or not the job ran", past.open === false);
  check("and says it has ended, not that it opens Tuesday", past.reason === "Sales have ended.");
  check("with no ended message, the plain default",
    effectiveStoreState({ open: true, closesAt: "2026-09-29T14:00:00Z", reason: "Opens Tuesday." }, now).reason
      === STORE_CLOSED_DEFAULT);
  check("before it opens, the before message",
    effectiveStoreState({ open: false, opensAt: "2026-09-29T16:00:00Z", reason: "Opens Tuesday." }, now).reason
      === "Opens Tuesday.");
  // THE OPENING TIME IS NOT READ FROM THE CLOCK: a failed opening job leaves
  // the store shut, which is the safe way to fail.
  check("an opening time that has passed does not open a shut store by itself",
    effectiveStoreState({ open: false, opensAt: "2026-09-29T14:00:00Z" }, now).open === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
