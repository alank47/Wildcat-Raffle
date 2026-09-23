// A cash movement moves a counter ONCE, however many times it is sent.
// Run: npm test
//
// THE INCIDENT, measured on production 2026-09-18. Wildcat Cash keeps two
// stores. The ROWS are keyed by their own id and unioned, so sending one twice
// is harmless. The COUNTERS moved by a DELTA the browser stated, applied
// unconditionally, so sending one twice DOUBLE-COUNTED.
//
// A bulk award by one teacher at 17:35:57 held exactly 7 students, and exactly
// those 7 ended the day $100 above their own ledger. His next bulk 95 seconds
// later held the same 7 plus three more, and those three were fine -- so it was
// not the teacher, the class, the period or the device. It was ONE SAVE,
// applied twice. The ledger holds 7 rows for that instant, not 14.
//
// The first assertion below is that incident, and it FAILS against the code
// that shipped it.
//
// WHY THE OBVIOUS FIX IS ABSENT HERE. An idempotency key per save ATTEMPT
// cannot work: a retry re-enters saveData(), which recomputes the payload from
// in-memory state, so a fresh attempt id is minted and sails past the check.
// The key is the MOVEMENT id, which is born with the movement and lives in the
// durable outbox, so it survives the recomputation.
import { readFileSync } from "node:fs";
import ts from "typescript";

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

// The rules live INSIDE appDataShape.ts, not beside it: that file must keep
// zero imports because convex/appDataShape.test.mjs imports it directly under
// Node, which cannot resolve an extensionless .ts specifier.
const src = readFileSync(new URL("./convex/appDataShape.ts", import.meta.url), "utf8");
const shapeSrc = src;
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

function lift(name) {
  const start = src.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} is not exported from convex/appDataShape.ts`);
  const end = src.indexOf("\n}\n", start) + 3;
  return src.slice(start, end).replace("export function", "function");
}
const consts = ["CASH_COUNTERS", "CASH_APPLIED_MAX"]
  .map((n) => src.match(new RegExp(`^export const ${n} =[\\s\\S]*?;$`, "m"))[0]
    .replace("export ", "").replace(" as const", ""))
  .join("\n") + "\nconst HISTORY_SLACK_MS = 60 * 60 * 1000;";
const js = ts.transpileModule(
  consts + "\n" + ["cashMovementEffect", "ringPush", "planCashMovements"].map(lift).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText;
const [cashMovementEffect, ringPush, planCashMovements, MOVEMENT_FIELDS, CASH_APPLIED_MAX] =
  new Function(js + "\nreturn [cashMovementEffect, ringPush, planCashMovements, CASH_COUNTERS, CASH_APPLIED_MAX];")();

const F = ["wildcatCashBalance", "wildcatCashEarned", "wildcatCashSpent", "wildcatCashDeducted"];
const OPTS = { cutoffMs: null, maxDelta: 5000 };

/** One student row, as the server holds it. */
const row = (o = {}) => ({ wildcatCashBalance: 0, wildcatCashEarned: 0, wildcatCashSpent: 0, wildcatCashDeducted: 0, ...o });
/** Apply a plan to a row the way planPatch does, and return the new row. */
function applyTo(r, record) {
  const stated = {};
  F.forEach((f) => { stated[f] = Number((record.cashDelta || {})[f]) || 0; });
  const mv = planCashMovements(r, record, stated, OPTS);
  const next = { ...r };
  F.forEach((f) => { if (mv.net[f]) next[f] = (Number(r[f]) || 0) + mv.net[f]; });
  if (mv.nextApplied) next.cashApplied = mv.nextApplied;
  return { row: next, mv };
}
/** The payload a tab sends for an award of `amount`, measured from a base of 0. */
const award = (id, amount, at = "2026-09-18T17:35:57.100Z", kind = "award") => {
  const e = cashMovementEffect(amount, kind);
  return { cashDelta: { ...e }, cashMovements: [{ id, at, amount, kind }] };
};

console.log("\n2026-09-18: the seven-student bulk award, applied twice");
{
  // Exactly the incident. Seven students, one payload each, delivered twice.
  let doubled = 0;
  for (let i = 0; i < 7; i++) {
    const p = award("txn_bulk_" + i, 100);
    const first = applyTo(row({ wildcatCashBalance: 300, wildcatCashEarned: 300 }), p);
    const second = applyTo(first.row, p);          // the same payload, again
    if (second.row.wildcatCashBalance !== 400) doubled++;
  }
  check("all seven counters move ONCE, not twice", doubled === 0, `${doubled} doubled`);

  const p = award("txn_bulk_0", 100);
  const a = applyTo(row(), p);
  const b = applyTo(a.row, p);
  check("the first delivery applies it", a.row.wildcatCashBalance === 100 && a.mv.applied.length === 1);
  check("the second applies nothing", b.row.wildcatCashBalance === 100 && b.mv.applied.length === 0);
  check("and says it absorbed it, so the bug becomes a measurement",
    b.mv.absorbed.length === 1 && b.mv.absorbed[0] === "txn_bulk_0");
  check("earned moved once too", b.row.wildcatCashEarned === 100);
  check("a third delivery is still a no-op", applyTo(b.row, p).row.wildcatCashBalance === 100);
}

console.log("\nOrder does not matter, which is what makes it safe");
{
  // P1 = (+100, [M]); P2 = (+200, [M,N]) -- the shape a retry interleaved with
  // a new award actually takes.
  const M = { id: "M", at: "2026-09-18T17:00:00.000Z", amount: 100, kind: "award" };
  const N = { id: "N", at: "2026-09-18T17:01:00.000Z", amount: 100, kind: "award" };
  const P1 = { cashDelta: { wildcatCashBalance: 100, wildcatCashEarned: 100 }, cashMovements: [M] };
  const P2 = { cashDelta: { wildcatCashBalance: 200, wildcatCashEarned: 200 }, cashMovements: [M, N] };

  const forward = applyTo(applyTo(row(), P1).row, P2).row;
  const backward = applyTo(applyTo(row(), P2).row, P1).row;
  check("P1 then P2 lands +200", forward.wildcatCashBalance === 200);
  check("P2 then P1 lands +200 as well", backward.wildcatCashBalance === 200);
  check("and the two orders agree on every counter",
    F.every((f) => (forward[f] || 0) === (backward[f] || 0)));
  check("a duplicate delivery of P2 changes nothing",
    applyTo(forward, P2).row.wildcatCashBalance === 200);
}

console.log("\nAn OLD client's unnamed delta moves nothing (2026-09-23)");
{
  // THIS BLOCK USED TO ASSERT THE OPPOSITE, and recorded the trade-off
  // honestly: "an old tab keeps failure mode 2 for its own life -- nothing
  // server-side can tell its recomputed delta from a genuinely larger one."
  // That was accepted on 2026-09-20 because most tabs were old and refusing
  // them would have stopped cash for most of forty staff on deploy morning.
  //
  // On 2026-09-23 the accepted risk arrived: a tab holding pre-repair numbers
  // saved 76 students back to their old balances within five minutes of a
  // repair. Three days on, the fleet has turned over, and a delta the server
  // cannot attribute to a named movement is no longer applied. The tab is told
  // it is out of date and reloads itself; its ledger row still lands, so any
  // real award it was carrying leaves the counter SHORT, which the recount pays.
  const old = { cashDelta: { wildcatCashBalance: 100, wildcatCashEarned: 100 } };
  const r = applyTo(row({ wildcatCashBalance: 300, wildcatCashEarned: 300 }), old);
  check("its unnamed delta moves no money", r.row.wildcatCashBalance === 300);
  check("it is reported as unkeyed, so the fleet is measurable", r.mv.hasResidual === true);
  check("and it writes NO register", r.row.cashApplied === undefined);
  check("so it cannot consume ring capacity or evict a new tab's entry",
    r.mv.applied.length === 0);
  // An old tab keeps failure mode 2 for its own life -- nothing server-side
  // can tell its recomputed delta from a genuinely larger one -- but it
  // cannot break a NEW tab's guarantee.
  const keyed = applyTo(r.row, award("txn_new", 100));
  check("a new tab's movement still registers afterwards", keyed.mv.applied.length === 1);
  check("and re-sending it is still absorbed",
    applyTo(keyed.row, award("txn_new", 100)).mv.applied.length === 0);
}

console.log("\nA delta that nets a counter to zero is not skipped, and is not NaN");
{
  // cashDeltaOf drops zero-valued fields, so reading the delta by iterating
  // its KEYS would miss the correction entirely. This is the defect that made
  // baseline-keying wrong, asserted here so the shape cannot come back.
  const M = { id: "M", at: "2026-09-18T17:00:00.000Z", amount: 100, kind: "award" };
  const D = { id: "D", at: "2026-09-18T17:05:00.000Z", amount: -100, kind: "deduct" };
  // Award then deduct: balance nets to 0, earned +100, deducted +100.
  const p = { cashDelta: { wildcatCashEarned: 100, wildcatCashDeducted: 100 }, cashMovements: [M, D] };
  const r = applyTo(row({ wildcatCashBalance: 500 }), p);
  check("the balance is unchanged, not NaN", r.row.wildcatCashBalance === 500);
  F.forEach((f) => check(`${f} is a finite number`, Number.isFinite(Number(r.row[f] ?? 0))));
  check("earned moved", r.row.wildcatCashEarned === 100);
  check("deducted moved", r.row.wildcatCashDeducted === 100);
  check("both movements registered", r.mv.applied.length === 2);
  const again = applyTo(r.row, p);
  check("and re-sending changes nothing", again.row.wildcatCashEarned === 100 && again.row.wildcatCashDeducted === 100);
}

console.log("\nThe cap still stops the stale-reset shape");
{
  // A stale tab's reset computes 0 - 30500 against a server holding 0. It
  // arrives as a RESIDUAL with no movement id, and the residual is what the
  // cap sees. $4,901,850 of phantom debt is the incident this prevents.
  const stale = { cashDelta: { wildcatCashBalance: -30500 } };
  const r = applyTo(row(), stale);
  check("a huge unkeyed delta is refused", r.row.wildcatCashBalance === 0);
  // REFUSED EARLIER NOW, and by a stronger rule: since 2026-09-23 an unnamed
  // delta never reaches the cap, because it is never applied at all. So the
  // refusal is reported as an unexplained change -- which is also what tells
  // the tab to reload -- rather than as a capped field.
  check("and it is reported as unexplained, so the tab is told",
    r.mv.residualRefused === true);
  // The cap is still what guards a NAMED movement of absurd size.
  const huge = applyTo(row(), award("txn_huge", -30500, "2026-09-23T17:00:00.000Z", "deduct"));
  check("the cap still stops a named movement of absurd size",
    huge.row.wildcatCashBalance === 0 && huge.mv.capped.includes("wildcatCashBalance"),
    JSON.stringify(huge.mv.capped));
  // A capped field must not swallow a movement: registered but never applied
  // would lose it forever.
  const big = award("txn_big", 9999);
  const rb = applyTo(row(), big);
  check("a capped MOVEMENT is not applied", rb.row.wildcatCashBalance === 0);
  check("and is NOT registered, so it can be re-sent", rb.mv.applied.length === 0);
  check("it is reported as held, by id", rb.mv.refused.some((x) => x.id === "txn_big" && x.why === "capped"));
  check("a normal award is under the cap", applyTo(row(), award("t", 100)).row.wildcatCashBalance === 100);
}

console.log("\nThe register is bounded, and its watermark only moves forward");
{
  const mk = (i) => ({ id: "m" + i, at: `2026-09-18T10:${String(i).padStart(2, "0")}:00.000Z`, amount: 100, kind: "award" });
  let reg = null;
  for (let i = 0; i < CASH_APPLIED_MAX + 5; i++) reg = ringPush(reg, [mk(i)]);
  check(`it holds at most ${CASH_APPLIED_MAX}`, reg.ids.length === CASH_APPLIED_MAX);
  check("the oldest are evicted, the newest kept", reg.ids[reg.ids.length - 1].i === "m" + (CASH_APPLIED_MAX + 4));
  check("eviction sets a watermark", typeof reg.since === "string");
  const before = reg.since;
  reg = ringPush(reg, [mk(99)]);
  check("which only ever moves forward", reg.since >= before);
  check("pushing an id it already holds does not duplicate it",
    ringPush(reg, [mk(99)]).ids.filter((e) => e.i === "m99").length === 1);
  check("a null register starts empty", ringPush(null, []).ids.length === 0);
  check("and has no watermark until something is evicted", ringPush(null, [mk(1)]).since === undefined);
}

console.log("\nWhat it refuses, it refuses by name, and the client re-sends it");
{
  const reg = { ids: [], since: "2026-09-18T12:00:00.000Z" };
  const old = applyTo(row({ cashApplied: reg }), award("txn_old", 100, "2026-09-18T11:00:00.000Z"));
  check("a movement older than the watermark is refused, not guessed",
    old.mv.refused.some((x) => x.why === "coverage_lost"));
  check("and its counter does not move", old.row.wildcatCashBalance === 0);

  const undated = applyTo(row(), { cashDelta: { wildcatCashBalance: 100 }, cashMovements: [{ id: "u", at: "", amount: 100, kind: "award" }] });
  check("an undated movement is refused", undated.mv.refused.some((x) => x.why === "undated"));

  const cut = Date.parse("2026-09-14T15:30:00Z");
  const pre = planCashMovements(row(), award("p", 100, "2026-09-01T10:00:00.000Z"),
    { wildcatCashBalance: 100, wildcatCashEarned: 100, wildcatCashSpent: 0, wildcatCashDeducted: 0 },
    { cutoffMs: cut, maxDelta: 5000 });
  check("a movement from before the history cutoff is refused",
    pre.refused.some((x) => x.why === "before_cutoff"));
  const inside = planCashMovements(row(), award("q", 100, "2026-09-14T15:00:00.000Z"),
    { wildcatCashBalance: 100, wildcatCashEarned: 100, wildcatCashSpent: 0, wildcatCashDeducted: 0 },
    { cutoffMs: cut, maxDelta: 5000 });
  check("one inside the hour of slack is allowed", inside.applied.length === 1);

  const dup = applyTo(row(), {
    cashDelta: { wildcatCashBalance: 100, wildcatCashEarned: 100 },
    cashMovements: [{ id: "d", at: "2026-09-18T17:00:00.000Z", amount: 100, kind: "award" },
                    { id: "d", at: "2026-09-18T17:00:00.000Z", amount: 100, kind: "award" }],
  });
  check("one movement listed twice in a record counts once",
    dup.mv.applied.length === 1 && dup.row.wildcatCashBalance === 100);
  check("and the copy is named", dup.mv.refused.some((x) => x.why === "duplicate_in_record"));

  const bad = applyTo(row(), { cashDelta: { wildcatCashBalance: 100 }, cashMovements: [{ id: "", amount: 100, kind: "award" }] });
  check("a shapeless entry is refused rather than counted", bad.mv.refused.some((x) => x.why === "bad_shape"));
}

console.log("\nThe effect rule is ONE rule, in two places that must agree");
{
  check("a redemption is spent, not deducted",
    cashMovementEffect(-100, "redeem").wildcatCashSpent === 100 &&
    cashMovementEffect(-100, "redeem").wildcatCashDeducted === 0);
  check("a deduction is deducted, not spent",
    cashMovementEffect(-100, "deduct").wildcatCashDeducted === 100 &&
    cashMovementEffect(-100, "deduct").wildcatCashSpent === 0);
  check("an award is earned", cashMovementEffect(100, "award").wildcatCashEarned === 100);
  check("the balance always takes the signed amount",
    cashMovementEffect(-100, "deduct").wildcatCashBalance === -100);
  check("junk is zero, not NaN", F.every((f) => cashMovementEffect("x", "award")[f] === 0));

  // The client has the same function. A divergence between them is money.
  const m = script.match(/function cashMovementEffect\(amount, kind\) \{[\s\S]*?\n        \}/);
  check("the client defines it too", Boolean(m));
  const clientFn = new Function("amount", "kind", m[0].replace(/^\s*function cashMovementEffect\(amount, kind\) \{/, "").replace(/\}\s*$/, ""));
  const cases = [[100, "award"], [-100, "deduct"], [-100, "redeem"], [0, "award"], [250, "award"], [-50, "redeem"]];
  const agree = cases.every(([a, k]) => {
    const s = cashMovementEffect(a, k), c = clientFn(a, k);
    return F.every((f) => s[f] === c[f]);
  });
  check("and computes exactly the same effect as the server, on every case", agree);

  // The field list must match appDataShape's, or a counter would be missed.
  const shape = shapeSrc.match(/export const CASH_COUNTERS = \[([\s\S]*?)\]/)[1];
  const shapeFields = [...shape.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  check("the rule iterates exactly CASH_COUNTERS, so no counter is missed",
    [...MOVEMENT_FIELDS].join(",") === shapeFields.join(","),
    `${[...MOVEMENT_FIELDS].join(",")} vs ${shapeFields.join(",")}`);
  check("and the rules sit inside the pure save-shape module, which has no imports",
    !/^import /m.test(src));
}

console.log("\nThe client keeps a held movement pending, and forgets an accepted one");
{
  check("movements are recorded as pending when a movement is created",
    /_pendingCashMovements\.set\(_sid, _list\)/.test(script));
  check("born with the transaction, before any save exists",
    script.indexOf("_pendingCashMovements.set(_sid") > script.indexOf("cashTransactions.push(tx);"));
  check("they are sent beside the delta", /cashMovements: pend/.test(script));
  check("the response is read defensively, never destructured",
    /result && result\.cashMovementsHeld \? result\.cashMovementsHeld : \[\]/.test(script));
  check("a held movement stays pending", /return !sentThis \|\| heldMovements\.has\(String\(m\.id\)\)/.test(script));
  check("and a held movement is logged rather than swallowed",
    /the server held ' \+ heldMovements\.size/.test(script));
  check("the server reports what it held, by id", /cashMovementsHeld: movementsRefused\.map/.test(src === "" ? "" : readFileSync(new URL("./convex/appData.ts", import.meta.url), "utf8")));
  check("and reports absorptions, which is the bug becoming a measurement",
    /cashMovementsAbsorbed: movementsAbsorbed\.length/.test(readFileSync(new URL("./convex/appData.ts", import.meta.url), "utf8")));
}


console.log("\nthe sign convention, which a test fixture got wrong first");
{
  // cashMovementEffect reads the AMOUNT, not the kind. Only "redeem" is
  // special-cased. A deduction is a NEGATIVE amount carrying kind "deduct",
  // and script.js sends exactly that (kind: points >= 0 ? 'award' : 'deduct').
  const e = (a, k) => cashMovementEffect(a, k);
  check("a positive award earns", e(100, "award").wildcatCashEarned === 100);
  check("and does not deduct", e(100, "award").wildcatCashDeducted === 0);
  check("a NEGATIVE amount deducts", e(-100, "deduct").wildcatCashDeducted === 100);
  check("and does not earn", e(-100, "deduct").wildcatCashEarned === 0);
  check("the balance follows the amount either way",
    e(100, "award").wildcatCashBalance === 100 && e(-100, "deduct").wildcatCashBalance === -100);
  check("redeem spends rather than deducting",
    e(-50, "redeem").wildcatCashSpent === 50 && e(-50, "redeem").wildcatCashDeducted === 0);
  // The trap: a POSITIVE amount with kind "deduct" reads as an award, because
  // the kind string is not consulted. Nothing sends that, and the guard below
  // refuses it when a payload does.
  check("a positive amount labelled deduct still reads as earned, so the sign is what matters",
    e(100, "deduct").wildcatCashEarned === 100);
}

console.log("\nthe self-contradictory payload, which cost 38 students a movement");

// MEASURED ON PRODUCTION 2026-09-22. 53 students had drifted; 38 of them were
// short exactly one movement, and every one of those movements was REGISTERED
// in cashApplied while the counter had not moved. Registered means never
// re-sent, so the money was gone permanently rather than recoverably -- the
// worst shape a cash bug can take.
//
// The cause: `residual` is `stated - claimed`, and the order-independence
// argument rests on `stated` including every movement the record lists. A tab
// that lists a +100 award and states a delta of ZERO breaks that. The residual
// becomes -100 and cancels the movement, nothing is capped, so the old code
// registered it and planPatch then skipped the counter because the delta was
// zero.
{
  const mv = (id, amount, kind) => ({ id, at: "2026-09-21T18:13:00.000Z", amount, kind: kind || "award" });
  const zero = { wildcatCashBalance: 0, wildcatCashEarned: 0, wildcatCashSpent: 0, wildcatCashDeducted: 0 };
  const plan = (row, movements, stated) =>
    planCashMovements(row, { cashMovements: movements }, stated, { cutoffMs: null, maxDelta: 5000 });

  {
    const p = plan({ wildcatCashBalance: 800, cashApplied: null }, [mv("txn_a", 100)], zero);
    check("a fresh movement with an all-zero stated delta is NOT registered",
      p.applied.length === 0, `registered ${p.applied.length}`);
    check("and nothing is applied either, so it cannot double-credit later",
      p.net.wildcatCashBalance === 0 && p.net.wildcatCashEarned === 0);
    check("and the refusal names the reason rather than going quiet",
      p.refused.length === 1 && p.refused[0].why === "stated_no_change",
      JSON.stringify(p.refused));
  }
  {
    // The second shape with the same end state: a movement already registered,
    // re-sent with a zero stated delta. The residual used to SUBTRACT it.
    const row = {
      wildcatCashBalance: 900,
      cashApplied: { ids: [{ i: "txn_a", at: Date.parse("2026-09-21T18:13:00.000Z") }],
                     since: "2026-09-20T00:00:00.000Z" },
    };
    const p = plan(row, [mv("txn_a", 100)], zero);
    check("an already-applied movement re-sent with a zero delta takes nothing back",
      p.net.wildcatCashBalance === 0, String(p.net.wildcatCashBalance));
    check("and it is not registered a second time", p.applied.length === 0);
  }

  // APPLY AND REGISTER MOVE TOGETHER, OR NEITHER. A first draft of the guard
  // zeroed the residual and left net at +100 while refusing to register --
  // which applies the movement and then lets the NEXT save apply it again,
  // turning a loss into a double-credit.
  {
    const blocked = plan({ wildcatCashBalance: 800, cashApplied: null }, [mv("txn_a", 100)], zero);
    check("TEETH: a blocked movement never moves a counter without registering",
      !(blocked.applied.length === 0 && blocked.net.wildcatCashBalance !== 0),
      "net moved while nothing was registered, which double-credits on the next save");
    check("the blocked counters are named, not merely zeroed",
      blocked.cancelled.indexOf("wildcatCashBalance") !== -1, JSON.stringify(blocked.cancelled));
  }

  // THE HEALTHY SHAPES MUST BE UNTOUCHED. An all-zero delta is completely
  // normal -- the first save after every load ships every student that way --
  // but always with NO movements listed.
  {
    const p = plan({ wildcatCashBalance: 800, cashApplied: null }, [mv("txn_a", 100)],
      { wildcatCashBalance: 100, wildcatCashEarned: 100 });
    check("a coherent payload still applies and registers", p.net.wildcatCashBalance === 100 && p.applied.length === 1);
    check("and refuses nothing", p.refused.length === 0);
  }
  {
    const p = plan({ wildcatCashBalance: 800, cashApplied: null }, [], zero);
    check("the ordinary post-load save with no movements is untouched",
      p.net.wildcatCashBalance === 0 && p.applied.length === 0 && p.refused.length === 0);
  }
  {
    const p = plan({ wildcatCashBalance: 800, cashApplied: null }, [],
      { wildcatCashBalance: -50, wildcatCashSpent: 50 });
    // THIS USED TO SAY A PURCHASE IS A RESIDUAL WITH NO MOVEMENTS. No live
    // path produces that shape: students buy through studentStore:purchase, a
    // server mutation that charges the balance itself and never passes through
    // appData:save, and the staff client has no redeem call at all. An
    // unexplained change is therefore stale state wearing a purchase's shape,
    // and it moves nothing.
    check("an unexplained change moves nothing, whatever it resembles",
      p.net.wildcatCashBalance === 0 && p.net.wildcatCashSpent === 0);
    check("...and it is flagged, so the tab is told", p.residualRefused === true);
  }
  {
    const p = plan({ wildcatCashBalance: 800, cashApplied: null },
      [mv("txn_a", 100), mv("txn_b", 100)],
      { wildcatCashBalance: 200, wildcatCashEarned: 200 });
    check("two coherent awards both apply and both register",
      p.net.wildcatCashBalance === 200 && p.applied.length === 2);
  }
  {
    // A deduction stated coherently must still go through. NOTE THE SIGN:
    // cashMovementEffect keys off the AMOUNT, not the kind string -- only
    // "redeem" is special-cased -- so a deduction carries a NEGATIVE amount.
    // A first draft of this fixture passed +100 with kind "deduct" and the
    // guard correctly refused it, because a movement claiming +100 earned
    // against a stated -100 balance really is self-contradictory.
    const p = plan({ wildcatCashBalance: 800, cashApplied: null }, [mv("txn_d", -100, "deduct")],
      { wildcatCashBalance: -100, wildcatCashDeducted: 100 });
    check("a coherent deduction applies and registers",
      p.net.wildcatCashBalance === -100 && p.net.wildcatCashDeducted === 100 && p.applied.length === 1,
      JSON.stringify(p.net) + " applied=" + p.applied.length);
  }
}


console.log("\nthe reload rebase, executed rather than pattern-matched");

// THE SEQUENCE THAT COST 38 STUDENTS AN AWARD ON 2026-09-22, run end to end.
// A teacher awards cash; the tab reloads before the save confirms; the next
// save must state a delta that MATCHES the movements it lists. When it did
// not, the server cancelled the movement against its own residual and
// registered it as applied, so no later save could ever re-send it.
{
  const src = readFileSync(new URL("./script.js", import.meta.url), "utf8");
  const lift = (start, end) => {
    const i = src.indexOf(start);
    if (i < 0) throw new Error("not found: " + start);
    const j = src.indexOf(end, i);
    return src.slice(i, j < 0 ? src.length : j);
  };
  const body = [
    lift("function cashCountersOf(st) {", "\n        /**"),
    lift("function cashMovementEffect(amount, kind) {", "\n        /** How much this tab"),
    lift("function cashDeltaBetween(now, base) {", "\n        /** Cash this tab has moved"),
    lift("function snapshotPendingCashDeltas() {", "\n        /**\n         * Put that movement"),
    lift("function reapplyPendingCashDeltas(pending, into) {", "\n        function rememberCashBase"),
    lift("function rememberCashBase(st) {", "\n\n        //"),
  ].join("\n");

  const make = () => new Function("CASH_COUNTER_FIELDS", "state", `
    const _studentCashBase = state.base;
    let students = state.students, nonEnrolledStudents = [];
    ${body}
    return {
      snapshot: snapshotPendingCashDeltas,
      reapply: reapplyPendingCashDeltas,
      remember: rememberCashBase,
      effect: cashMovementEffect,
      delta: cashDeltaBetween,
      counters: cashCountersOf,
      setStudents: (s) => { students = s; },
    };
  `);

  const FIELDS = ["wildcatCashBalance", "wildcatCashEarned", "wildcatCashSpent", "wildcatCashDeducted"];
  const serverRow = () => ({ id: "s1", wildcatCashBalance: 800, wildcatCashEarned: 800,
                             wildcatCashSpent: 0, wildcatCashDeducted: 0 });

  // 1. Load. Base is seeded from the server.
  const state = { base: new Map(), students: [serverRow()] };
  const api = make()(FIELDS, state);
  api.remember(state.students[0]);
  check("after a clean load the delta is zero",
    api.delta(state.students[0], state.base.get("s1")).wildcatCashBalance === 0);

  // 2. A teacher awards $100. The tab's record moves; the base does not.
  const e = api.effect(100, "award");
  FIELDS.forEach((f) => { state.students[0][f] = (state.students[0][f] || 0) + (e[f] || 0); });
  check("the award shows as a delta of +100",
    api.delta(state.students[0], state.base.get("s1")).wildcatCashBalance === 100);

  // 3. THE RELOAD, before the save confirms. Fresh server records arrive
  //    WITHOUT the award, and the base is reseeded from them.
  const pending = api.snapshot();
  check("the snapshot caught the unconfirmed movement",
    pending.size === 1 && pending.get("s1").wildcatCashBalance === 100);
  const fresh = [serverRow()];
  fresh.forEach(api.remember);
  api.reapply(pending, fresh);
  api.setStudents(fresh);

  // 4. The next save must state exactly what it lists.
  const after = api.delta(fresh[0], state.base.get("s1"));
  check("AFTER THE RELOAD THE DELTA STILL CARRIES THE AWARD", after.wildcatCashBalance === 100,
    JSON.stringify(after));
  check("and the earned counter too", after.wildcatCashEarned === 100);
  check("so the payload is coherent: stated matches the movement it lists",
    after.wildcatCashBalance === e.wildcatCashBalance);
  check("and the teacher still sees the money on screen", fresh[0].wildcatCashBalance === 900);

  // 5. TEETH: skip the rebase, which is what three of four callers did.
  const state2 = { base: new Map(), students: [serverRow()] };
  const api2 = make()(FIELDS, state2);
  api2.remember(state2.students[0]);
  FIELDS.forEach((f) => { state2.students[0][f] = (state2.students[0][f] || 0) + (e[f] || 0); });
  const fresh2 = [serverRow()];
  fresh2.forEach(api2.remember);          // base reseeded...
  api2.setStudents(fresh2);               // ...and NO reapply
  const broken = api2.delta(fresh2[0], state2.base.get("s1"));
  check("TEETH: without the rebase the delta reads ZERO while the movement is still listed",
    broken.wildcatCashBalance === 0,
    "that is the self-contradictory payload the server cancels and registers");
  check("which is exactly the shape that lost 38 awards",
    broken.wildcatCashBalance !== e.wildcatCashBalance);

  // 6. Applying it twice would be the other failure: a double credit.
  const twice = [serverRow()];
  twice.forEach(api.remember);
  api.reapply(pending, twice);
  api.reapply(pending, twice);
  check("applying the rebase twice really would double the award",
    twice[0].wildcatCashBalance === 1000,
    "which is why exactly one call site is pinned above");
}

// ===========================================================================
// A STALE TAB CANNOT DECIDE WHAT ANYBODY ELSE SEES. 2026-09-23.
//
// This replaces a guard written that morning, which keyed an old client's
// delta on the transaction list it sends and applied it when anything in that
// list was "new". Within the day it was shown insufficient: 79 students were
// repaired at 16:44 UTC and by 16:49, 76 were back at EXACTLY their old
// balances. Their old awards had never been registered, so to that guard the
// whole history looked new, and a stale tab's +900 matched nine real +100 rows.
//
// No narrowing of WHEN to trust an unnamed delta could have caught that, so
// the server no longer trusts one at all.
// ===========================================================================
console.log("\n-- the 16:49 incident, and the rule that closes it --");
{
  const tx = (id, amount, at, kind = "award") => ({ id, amount, kind, timestamp: at });
  const nine = Array.from({ length: 9 }, (_, i) =>
    tx(`t${i}`, 100, `2026-09-${String(14 + i).padStart(2, "0")}T17:00:00.000Z`));

  // The shape exactly: repaired to 900, a stale tab still believes 1800.
  const repaired = row({ wildcatCashBalance: 900, wildcatCashEarned: 900 });
  const stale = {
    cashDelta: { wildcatCashBalance: 900, wildcatCashEarned: 900 },
    cashMovements: [],
    wildcatCashTransactions: nine,
  };
  const r = applyTo(repaired, stale);
  check("THE 16:49 SHAPE: a stale tab cannot put a repaired child back",
    r.row.wildcatCashBalance === 900 && r.row.wildcatCashEarned === 900,
    JSON.stringify(r.row));
  check("...even though nine real rows would have 'explained' the +900",
    nine.length * 100 === 900);
  check("...and it is flagged, which is what makes the tab reload itself",
    r.mv.residualRefused === true && r.mv.hasResidual === true);
  check("...and nothing is registered for money that did not move",
    r.mv.nextApplied === null);

  // Sent again, and again: still nothing.
  const twice = applyTo(applyTo(repaired, stale).row, stale);
  check("sending it again changes nothing", twice.row.wildcatCashBalance === 900);

  // A real award from a CURRENT tab, in the same breath, still lands.
  const real = applyTo(repaired, award("txn_real", 100, "2026-09-23T17:00:00.000Z"));
  check("a named award from a current tab still applies",
    real.row.wildcatCashBalance === 1000, String(real.row.wildcatCashBalance));
  check("...and is not flagged", real.mv.residualRefused !== true);
  check("...and is registered, so its own re-send is absorbed",
    applyTo(real.row, award("txn_real", 100, "2026-09-23T17:00:00.000Z")).row.wildcatCashBalance === 1000);

  // A named award riding with a stale excess: only the award moves.
  const both = applyTo(repaired, {
    cashDelta: { wildcatCashBalance: 1000, wildcatCashEarned: 1000 },
    cashMovements: [{ id: "txn_x", at: "2026-09-23T17:05:00.000Z", amount: 100, kind: "award" }],
  });
  check("a real award beside a stale excess: the award lands, the excess does not",
    both.row.wildcatCashBalance === 1000, String(both.row.wildcatCashBalance));

  // Downward too. A stale tab cannot undo a repair that PAID a child.
  const paid = row({ wildcatCashBalance: 1100, wildcatCashEarned: 1100 });
  const undo = applyTo(paid, { cashDelta: { wildcatCashBalance: -100, wildcatCashEarned: -100 }, cashMovements: [] });
  check("nor can it take back money a repair restored",
    undo.row.wildcatCashBalance === 1100, String(undo.row.wildcatCashBalance));

  // Healthy shapes are untouched.
  const quiet = applyTo(repaired, { cashDelta: {}, cashMovements: [] });
  check("the all-zero save every tab sends after a load is not flagged",
    quiet.mv.residualRefused !== true && quiet.row.wildcatCashBalance === 900);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
