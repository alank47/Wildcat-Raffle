// The server refuses Cash Settings' writes from the roles Cash Settings is not
// for, and owns the idle refresh's dial. Run: npm test
//
// WHY THE SERVER, NOT JUST THE SCREEN (2026-10-16). The screen fix hides Cash
// Settings from teachers, aides and PBIS on every path, and the actions ask for
// the role themselves. Neither reaches a tab still running yesterday's build,
// and nobody can be asked to refresh forty of them. So the real lock is here:
//
//   - RESET ALL CASH. Its movements (and its "system_reset" rows) are refused,
//     one by one, from a caller whose own role is not admin or superadmin, on
//     every path the reset uses: appData:save (the money, and the student's
//     history array), legacyData:mergeSlice and :saveSlice (the week ledger).
//     The movement is held as "reserved_kind", which every live tab drops from
//     its pending list for good, so the save queue is not wedged. The rest of
//     the same save lands. An admin's reset still works.
//   - THE BEHAVIOUR LIST (every award's amount). mergeSlice skips a non-admin's
//     new or changed behaviour row and counts it; saveSlice refuses to replace
//     the list for them. A teacher's ordinary saves, rewards included, are
//     untouched.
//   - THE DIAL. appData:load returns idleRefreshMinutes from an appState row
//     that only appData:setIdleRefresh (deploy key) writes, held to 0.5-60.
//
// THE SHIPPED SERVER RUNS: appData.ts, legacyData.ts and everything they
// import, transpiled into the fake Convex (fake-convex.mjs) with the real
// schema's indexes, called as each role through requireStaff's real lookup.
import { readFileSync } from "node:fs";
import { loadConvex, makeDb, runtime } from "./fake-convex.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const J = (x) => JSON.stringify(x);

const STAFF_ISSUER = "https://login.microsoftonline.com/tenant-1/v2.0";
Object.assign(process.env, { STAFF_DOMAIN: "school.test", ENTRA_TENANT_ID: "tenant-1" });
const loaded = await loadConvex(new URL("./", import.meta.url), ["appData", "legacyData", "appDataShape"]);
const { mods } = loaded;
const ROLES = ["teacher", "campusaide", "pbis", "admin", "superadmin"];
const ADMINS = new Set(["admin", "superadmin"]);
const AT = "2026-10-19T18:00:00.000Z";

async function makeWorld() {
  const store = makeDb(read("./convex/schema.ts"));
  const rt = runtime(store, mods);
  for (const [sn, bal] of [["30001", 600], ["30002", 300], ["30003", 800]]) {
    await store.db.insert("students", { legacyId: sn, studentNumber: sn, firstName: "F" + sn, lastName: "Test", grade: "7",
      pbisTickets: 0, attendanceTickets: 0, academicTickets: 0, bigRaffleQualified: [],
      wildcatCashBalance: bal, wildcatCashEarned: bal, wildcatCashSpent: 0, wildcatCashDeducted: 0, wildcatCashTransactions: [] });
  }
  for (const role of ROLES) {
    await store.db.insert("teachers", { name: "Staff " + role, email: role + "@school.test", role, ticketsAwarded: 0, createdDate: "2026-08-01", legacyId: "T-" + role });
  }
  const as = async (role, fn, args) => {
    rt.signIn({ issuer: STAFF_ISSUER, email: role + "@school.test" });
    try { return await rt.run(fn, args); } finally { rt.signIn(null); }
  };
  return {
    store, rt, as,
    hub: (sn) => store.rows("students").find((r) => r.studentNumber === sn),
    ledger: (doc) => store.rows("legacyMirror").filter((r) => r.doc === doc),
    slice: (doc, col) => store.rows("legacyMirror").filter((r) => r.doc === doc && r.collection === col),
  };
}

/** What RESET ALL CASH sends for one student, exactly as recordCashTransaction and saveData build it. */
const resetRecord = (sn, balance, id) => ({
  id: sn,
  cashMovements: [{ id, at: AT, amount: -balance, kind: "deduct" }],
  // The movement's own delta plus the reset's pinning of the running totals to zero.
  cashDelta: { wildcatCashBalance: -balance, wildcatCashEarned: -balance },
  wildcatCashTransactions: [{ id, timestamp: AT, studentId: sn, amount: -balance, kind: "deduct", type: "negative",
    behaviorId: "system_reset", behaviorName: "System Reset to $0", teacherId: "T1", notes: "All student accounts reset by administrator" }],
});
/**
 * The same reset for a FORMER student, or for anyone when a cash week failed
 * to load: saveData rebuilds history for the enrolled only, and only when every
 * week was read, so this record carries NO history row beside the movement. It
 * does carry the student's own totals, which the reset pinned at zero.
 */
const bareResetRecord = (sn, balance, id) => ({
  id: sn,
  wildcatCashBalance: 0, wildcatCashEarned: 0, wildcatCashSpent: 0, wildcatCashDeducted: 0,
  cashMovements: [{ id, at: AT, amount: -balance, kind: "deduct" }],
  cashDelta: { wildcatCashBalance: -balance, wildcatCashEarned: -balance },
});
const awardRecord = (sn, amount, id, kind = "award", behaviorId = "wc1") => ({
  id: sn,
  cashMovements: [{ id, at: AT, amount, kind }],
  cashDelta: kind === "award" ? { wildcatCashBalance: amount, wildcatCashEarned: amount } : { wildcatCashBalance: amount, wildcatCashDeducted: -amount },
  wildcatCashTransactions: [{ id, timestamp: AT, studentId: sn, amount, kind, behaviorId, teacherId: "T2" }],
});

// ===========================================================================
console.log("\nA. RESET ALL CASH THROUGH appData:save\n");
for (const role of ROLES) {
  const w = await makeWorld();
  const reset = "txn_1792519200000_rst01";
  const award = "txn_1792519200001_awd01";
  const res = await w.as(role, "appData.save", { students: [resetRecord("30001", 600, reset), awardRecord("30002", 100, award)] });
  const s1 = w.hub("30001"), s2 = w.hub("30002");
  const held = (res.cashMovementsHeldWhy || []).find((h) => h.id === reset);
  if (ADMINS.has(role)) {
    check(`${role === "admin" ? "an admin" : "a superadmin"}'s reset applies: $600 to $0, and the reset row is kept`,
      s1.wildcatCashBalance === 0 && !held && (s1.wildcatCashTransactions || []).some((r) => r.id === reset), J({ bal: s1.wildcatCashBalance, held }));
  } else {
    check(`A ${role.toUpperCase()}'S RESET IS REFUSED: the balance stays $600, the movement is held as reserved_kind`,
      s1.wildcatCashBalance === 600 && s1.wildcatCashEarned === 600 && held && held.why === "reserved_kind", J({ bal: s1.wildcatCashBalance, held }));
    check(`...and a ${role}'s reset row is not added to the student's history`,
      !(s1.wildcatCashTransactions || []).some((r) => r.id === reset));
  }
  check(`...while the ${role}'s ordinary award in the same save lands (+$100)`,
    s2.wildcatCashBalance === 400 && (s2.wildcatCashTransactions || []).some((r) => r.id === award), String(s2.wildcatCashBalance));
}
for (const role of ROLES) {
  // A FORMER STUDENT'S RESET (review, 2026-10-16): no history row travels with
  // it, so the history-row test alone took it as a plain deduction and zeroed
  // the balance for any role.
  const w = await makeWorld();
  const id = "txn_1792519200006_rst04";
  const res = await w.as(role, "appData.save", { students: [bareResetRecord("30002", 300, id)] });
  const s2 = w.hub("30002");
  const held = (res.cashMovementsHeldWhy || []).find((h) => h.id === id);
  if (ADMINS.has(role)) {
    check(`${role === "admin" ? "an admin" : "a superadmin"}'s reset of a former student applies: $300 to $0`,
      s2.wildcatCashBalance === 0 && !held, J({ bal: s2.wildcatCashBalance, held }));
  } else {
    check(`A ${role.toUpperCase()}'S RESET OF A FORMER STUDENT (NO HISTORY ROW) IS REFUSED: $300 stays, held as reserved_kind`,
      s2.wildcatCashBalance === 300 && s2.wildcatCashEarned === 300 && held && held.why === "reserved_kind", J({ bal: s2.wildcatCashBalance, held }));
  }
}
{
  // Controls: a record whose running totals were zero BEFORE a teacher's own
  // movement. Totals only grow with a movement, so it never reads as pinned.
  const w = await makeWorld();
  await w.store.db.insert("students", { legacyId: "30004", studentNumber: "30004", firstName: "F30004", lastName: "Test", grade: "7",
    pbisTickets: 0, attendanceTickets: 0, academicTickets: 0, bigRaffleQualified: [],
    wildcatCashBalance: 200, wildcatCashEarned: 0, wildcatCashSpent: 0, wildcatCashDeducted: 0, wildcatCashTransactions: [] });
  const d = "txn_1792519200007_ddc02", a = "txn_1792519200008_awd03";
  const res = await w.as("teacher", "appData.save", { students: [
    { id: "30004", wildcatCashBalance: 150, wildcatCashEarned: 0, wildcatCashSpent: 0, wildcatCashDeducted: 50,
      cashMovements: [{ id: d, at: AT, amount: -50, kind: "deduct" }], cashDelta: { wildcatCashBalance: -50, wildcatCashDeducted: 50 } },
  ] });
  check("a teacher's deduction from a student whose totals were all zero still lands ($200 to $150)",
    w.hub("30004").wildcatCashBalance === 150 && (res.cashMovementsHeld || []).length === 0, J(res.cashMovementsHeldWhy));
  const res2 = await w.as("teacher", "appData.save", { students: [
    { id: "30004", wildcatCashBalance: 250, wildcatCashEarned: 100, wildcatCashSpent: 0, wildcatCashDeducted: 50,
      cashMovements: [{ id: a, at: AT, amount: 100, kind: "award" }], cashDelta: { wildcatCashBalance: 100, wildcatCashEarned: 100 } },
  ] });
  check("...and so does an award", w.hub("30004").wildcatCashBalance === 250 && (res2.cashMovementsHeld || []).length === 0, J(res2.cashMovementsHeldWhy));
}
{
  const w = await makeWorld();
  const d = "txn_1792519200002_ddc01";
  const res = await w.as("teacher", "appData.save", { students: [awardRecord("30003", -100, d, "deduct", "wc5")] });
  check("A TEACHER'S ORDINARY DEDUCTION IS UNTOUCHED: $800 to $700, nothing held",
    w.hub("30003").wildcatCashBalance === 700 && (res.cashMovementsHeld || []).length === 0, J(res.cashMovementsHeldWhy));
}
{
  // A movement that names the behaviour itself is refused too (a future client, or a hand-made one).
  const w = await makeWorld();
  const id = "txn_1792519200003_rst02";
  const rec = resetRecord("30001", 600, id);
  rec.cashMovements[0].behaviorId = "system_reset";
  rec.wildcatCashTransactions = [];
  const res = await w.as("teacher", "appData.save", { students: [rec] });
  check("...a reset movement that names system_reset with no history row is refused just the same",
    w.hub("30001").wildcatCashBalance === 600 && (res.cashMovementsHeldWhy || []).some((h) => h.id === id && h.why === "reserved_kind"));
}
{
  // An admin's reset already stored, sent back by a teacher's tab with its next save: kept, and nothing moves.
  const w = await makeWorld();
  const reset = "txn_1792519200004_rst03";
  await w.as("admin", "appData.save", { students: [resetRecord("30001", 600, reset)] });
  const later = "txn_1792519200005_awd02";
  const rec = awardRecord("30001", 100, later);
  rec.wildcatCashTransactions.unshift(resetRecord("30001", 600, reset).wildcatCashTransactions[0]);
  await w.as("teacher", "appData.save", { students: [rec] });
  const s1 = w.hub("30001");
  check("a teacher's tab echoing an admin's stored reset keeps it, and the teacher's award still lands",
    s1.wildcatCashBalance === 100 && s1.wildcatCashTransactions.some((r) => r.id === reset) && s1.wildcatCashTransactions.some((r) => r.id === later),
    J({ bal: s1.wildcatCashBalance, ids: s1.wildcatCashTransactions.map((r) => r.id) }));
}
{
  // The reason is one every live tab drops for good, so a refused reset never wedges the save queue.
  const script = read("./script.js");
  check("reserved_kind is one of the browser's terminal refusals (the movement leaves the pending list)",
    /const CASH_TERMINAL_REFUSALS = new Set\(\[[^\]]*'reserved_kind'[^\]]*\]\);/.test(script));
  // The running totals' zeroing has never been applied: a residual is measured, never added.
  const shape = read("./convex/appDataShape.ts");
  check("the reset's zeroing of earned/spent/deducted is refused for EVERYONE (the residual is never applied)",
    /residual\[f\] = 0;/.test(shape) && !/residual\[f\] = measured/.test(shape));
}

// ===========================================================================
console.log("\nB. THE RESET'S LEDGER ROWS THROUGH mergeSlice AND saveSlice\n");
const ledgerRow = (id, sn, amount, behaviorId, kind = "deduct") =>
  ({ payload: { id, timestamp: AT, studentId: sn, amount, kind, behaviorId, teacherId: "T1" } });
for (const role of ROLES) {
  const w = await makeWorld();
  const res = await w.as(role, "legacyData.mergeSlice", { doc: "cash_tx_2026_W43", collection: "transactions", dedupeField: "id",
    rows: [ledgerRow("txn_1792519200010_r1", "30001", -600, "system_reset"), ledgerRow("txn_1792519200011_a1", "30002", 100, "wc1", "award")] });
  const ids = w.ledger("cash_tx_2026_W43").map((r) => r.payload.id);
  if (ADMINS.has(role)) {
    check(`mergeSlice keeps ${role === "admin" ? "an admin" : "a superadmin"}'s reset row`, ids.includes("txn_1792519200010_r1") && res.refusedResetCash === 0);
  } else {
    check(`MERGESLICE REFUSES A ${role.toUpperCase()}'S RESET ROW, and still takes the award beside it`,
      !ids.includes("txn_1792519200010_r1") && ids.includes("txn_1792519200011_a1") && res.refusedResetCash === 1, J(res));
  }
}
{
  const w = await makeWorld();
  await w.as("admin", "legacyData.mergeSlice", { doc: "cash_tx_2026_W43", collection: "transactions", dedupeField: "id",
    rows: [ledgerRow("txn_1792519200012_r2", "30001", -600, "system_reset")] });
  const copy = ledgerRow("txn_1792519200012_r2", "30001", -6000, "system_reset");
  copy.payload.updatedAt = "2026-10-20T00:00:00Z";
  const res = await w.as("teacher", "legacyData.mergeSlice", { doc: "cash_tx_2026_W43", collection: "transactions", dedupeField: "id", rows: [copy] });
  check("...and never lets a teacher's newer copy rewrite an admin's stored reset row",
    w.ledger("cash_tx_2026_W43")[0].payload.amount === -600 && res.updated === 0 && res.refusedResetCash === 1, J(res));
}
{
  const w = await makeWorld();
  const res = await w.as("teacher", "legacyData.saveSlice", { doc: "cash_tx_2026_W43", collection: "transactions",
    rows: [ledgerRow("txn_1792519200013_r3", "30001", -600, "system_reset"), ledgerRow("txn_1792519200014_a3", "30002", 100, "wc1", "award")] });
  const ids = w.ledger("cash_tx_2026_W43").map((r) => r.payload.id);
  check("SAVESLICE REFUSES A TEACHER'S RESET ROW too, and takes the award", !ids.includes("txn_1792519200013_r3") && ids.includes("txn_1792519200014_a3") && res.wrote === 1, J(res));
  const res2 = await w.as("admin", "legacyData.saveSlice", { doc: "cash_tx_2026_W43", collection: "transactions",
    rows: [ledgerRow("txn_1792519200015_r4", "30001", -600, "system_reset")] });
  check("...but an admin's lands", w.ledger("cash_tx_2026_W43").some((r) => r.payload.id === "txn_1792519200015_r4") && res2.wrote === 1);
}

{
  // EVERY ROW THE ARRIVAL CHECK TAKES FOR A RESET (review, 2026-10-16).
  // cashArrivalRules.isResetRow reads any behaviour that merely STARTS with
  // "system_reset" as that child's zero point, and holds back every late award
  // dated before it. An exact match let "system_reset_x" through every lock
  // while the arrival check still believed it, so the lock is the prefix too,
  // in any case (the award command's own RESERVED_BEHAVIOR).
  const odd = ["system_reset_x", "SYSTEM_RESET", "system_resetX"];
  for (const role of ["teacher", "admin"]) {
    const w = await makeWorld();
    const ids = odd.map((_, i) => "txn_17925192000" + (30 + i) + "_x" + i);
    const res = await w.as(role, "legacyData.mergeSlice", { doc: "cash_tx_2026_W43", collection: "transactions", dedupeField: "id",
      rows: odd.map((b, i) => ledgerRow(ids[i], "30001", -1, b)) });
    const stored = w.ledger("cash_tx_2026_W43").map((r) => r.payload.id);
    const rec = awardRecord("30002", 100, "txn_1792519200040_awd09");
    odd.forEach((b, i) => rec.wildcatCashTransactions.push({ id: ids[i], timestamp: AT, studentId: "30002", amount: -1, kind: "deduct", behaviorId: b, teacherId: "T1" }));
    await w.as(role, "appData.save", { students: [rec] });
    const hist = (w.hub("30002").wildcatCashTransactions || []).map((r) => r.id);
    if (role === "admin") {
      check("an admin's rows that start with system_reset are kept, in the ledger and in the history",
        ids.every((id) => stored.includes(id) && hist.includes(id)), J({ stored, hist }));
    } else {
      check("A TEACHER'S ROW THAT ONLY STARTS WITH system_reset (OR IN CAPITALS) IS REFUSED TOO, in the ledger and in the history",
        ids.every((id) => !stored.includes(id) && !hist.includes(id)) && res.refusedResetCash === odd.length
          && hist.includes("txn_1792519200040_awd09"), J({ stored, hist, refused: res.refusedResetCash }));
    }
  }
  check("...the same rows the arrival check reads as a reset (cashArrivalRules.isResetRow is a prefix match)",
    /\/\^system_reset\/\.test\(/.test(read("./convex/cashArrivalRules.ts")));
}

// ===========================================================================
console.log("\nC. THE BEHAVIOUR LIST (EVERY AWARD'S AMOUNT)\n");
const beh = (id, points, updatedAt = "2026-10-01T00:00:00Z", extra = {}) =>
  ({ payload: { id, name: "B " + id, points, type: points > 0 ? "positive" : "negative", active: true, custom: true, updatedAt, ...extra } });
/** The list as the server already holds it, written straight to the table so no guard under test is in the way. */
async function seedBehaviours(w) {
  for (const r of [beh("wc1", 100), beh("wc_custom_1", 50)]) {
    await w.store.db.insert("legacyMirror", { doc: "secondary", collection: "wildcatCashBehaviors", payload: r.payload, mirroredAt: AT });
  }
}
for (const role of ROLES) {
  const w = await makeWorld();
  await seedBehaviours(w);
  const add = await w.as(role, "legacyData.mergeSlice", { doc: "secondary", collection: "wildcatCashBehaviors", dedupeField: "id",
    rows: [beh("wc1", 100), beh("wc_custom_1", 5000, "2026-10-19T00:00:00Z"), beh("wc_custom_2", 4000, "2026-10-19T00:00:00Z")] });
  const list = w.slice("secondary", "wildcatCashBehaviors").map((r) => r.payload);
  const c1 = list.find((b) => b.id === "wc_custom_1");
  if (ADMINS.has(role)) {
    check(`${role === "admin" ? "an admin" : "a superadmin"} reprices and adds behaviours`,
      c1?.points === 5000 && list.some((b) => b.id === "wc_custom_2") && add.refusedBehaviorEdits === 0, J(add));
  } else {
    check(`A ${role.toUpperCase()} CANNOT REPRICE OR ADD A BEHAVIOUR: both rows skipped and counted, nothing thrown`,
      c1?.points === 50 && !list.some((b) => b.id === "wc_custom_2") && add.refusedBehaviorEdits === 2 && add.inserted === 0 && add.updated === 0, J(add));
  }
}
{
  const w = await makeWorld();
  await seedBehaviours(w);
  const same = await w.as("teacher", "legacyData.mergeSlice", { doc: "secondary", collection: "wildcatCashBehaviors", dedupeField: "id",
    rows: [beh("wc1", 100), beh("wc_custom_1", 50)] });
  check("a teacher's tab re-sending the list it read writes nothing and is refused nothing", same.inserted === 0 && same.updated === 0 && same.refusedBehaviorEdits === 0, J(same));
  const rewards = await w.as("teacher", "legacyData.mergeSlice", { doc: "secondary", collection: "wildcatCashRewards", dedupeField: "id",
    rows: [{ payload: { id: "rw1", name: "Pass", cost: 1500, active: true, updatedAt: AT } }] });
  check("REWARDS STAY OPEN TO STAFF: a teacher's reward edit lands (the 10/8 map; the owner has not decided otherwise)",
    rewards.inserted === 1 && w.slice("secondary", "wildcatCashRewards").length === 1, J(rewards));
  let threw = null;
  try { await w.as("teacher", "legacyData.saveSlice", { doc: "secondary", collection: "wildcatCashBehaviors", rows: [] }); } catch (e) { threw = e; }
  check("SAVESLICE WILL NOT LET A TEACHER REPLACE THE LIST (one call would delete every behaviour)",
    threw && /administrator/.test(String(threw.message)) && w.slice("secondary", "wildcatCashBehaviors").length === 2, String(threw && threw.message));
  const ok = await w.as("admin", "legacyData.saveSlice", { doc: "secondary", collection: "wildcatCashBehaviors", rows: [beh("wc1", 100)] });
  check("...an admin keeps that call as they had it", ok.wrote === 1 && w.slice("secondary", "wildcatCashBehaviors").length === 1);
  const other = await w.as("teacher", "legacyData.saveSlice", { doc: "secondary", collection: "detentionReasons", rows: [{ payload: "Tardy" }] });
  check("...and a teacher's other whole-value slices save as before", other.wrote === 1);
}

// ===========================================================================
console.log("\nD. THE ROLES, AND WHERE THEY COME FROM\n");
{
  const S = mods.appDataShape;
  check("the reset and behaviour roles are exactly requireAdmin's (identity.ts)",
    /teacher\.role !== "admin" && teacher\.role !== "superadmin"/.test(read("./convex/identity.ts"))
      && J([...S.CASH_SETTINGS_ROLES].sort()) === J(["admin", "superadmin"]));
  check("an unknown or missing role may not", !S.canChangeCashSettings("") && !S.canChangeCashSettings(undefined) && !S.canChangeCashSettings("owner"));
  const save = read("./convex/appData.ts");
  check("appData:save takes the role from the verified caller (requireStaff), never from the payload",
    /historyCutoff, \{ mayReset: canChangeCashSettings\(\(me as any\)\?\.role\) \}\);/.test(save) && /const me = await requireStaff\(ctx\);/.test(save));
}

// ===========================================================================
console.log("\nE. THE IDLE REFRESH'S DIAL\n");
{
  const w = await makeWorld();
  const load = async () => (await w.as("teacher", "appData.load", {})).idleRefreshMinutes;
  check("unset, appData:load says null (the tabs use their default of ten)", (await load()) === null);
  const set = await w.rt.run("appData.setIdleRefresh", { minutes: 3, actorName: "Test Admin" });
  check("setIdleRefresh sets it, and appData:load returns it", set.ok === true && (await load()) === 3, J(set));
  const st = await w.rt.run("appData.idleRefreshStatus", {});
  check("...and the status says who set it", st.minutes === 3 && st.setBy === "Test Admin" && typeof st.setAt === "string", J(st));
  const stored = () => w.store.rows("appState").find((r) => r.key === "idleRefresh")?.value?.minutes;
  await w.rt.run("appData.setIdleRefresh", { minutes: 0.1, actorName: "Test Admin" });
  check("held to 0.5 minutes at the fast end, as stored and as loaded", stored() === 0.5 && (await load()) === 0.5, String(stored()));
  const big = await w.rt.run("appData.setIdleRefresh", { minutes: 999, actorName: "Test Admin" });
  check("...and 60 at the slow end, saying it was clamped", stored() === 60 && (await load()) === 60 && big.clamped === true);
  const bad = await w.rt.run("appData.setIdleRefresh", { minutes: -2, actorName: "Test Admin" });
  check("a non-positive number is refused, and the dial is left as it was", bad.ok === false && (await load()) === 60, J(bad));
  const anon = await w.rt.run("appData.setIdleRefresh", { minutes: 5, actorName: "  " });
  check("...and so is a change with no name on it", anon.ok === false && (await load()) === 60);
  await w.rt.run("appData.setIdleRefresh", { minutes: null, actorName: "Test Admin" });
  check("null unsets it: back to the tabs' default", (await load()) === null && !w.store.rows("appState").some((r) => r.key === "idleRefresh"));
  await w.store.db.insert("appState", { key: "idleRefresh", value: { minutes: "fast" }, mirroredAt: AT });
  check("a stored value that is not a number reads as unset, never as 'every tick'", (await load()) === null);
  check("THE DIAL IS AN ADMIN'S: setIdleRefresh is an internalMutation (deploy key only, no browser can reach it)",
    mods.appData.setIdleRefresh._kind === "internalMutation" && mods.appData.idleRefreshStatus._kind === "internalQuery",
    `${mods.appData.setIdleRefresh._kind}/${mods.appData.idleRefreshStatus._kind}`);
  let refused = null;
  try { await w.rt.run("appData.load", {}); } catch (e) { refused = e; }
  check("...and appData:load still refuses anyone who is not staff", refused !== null);
}
{
  // A SECOND DIAL ROW (review, 2026-10-16), say one added by hand in the
  // dashboard instead of with the command. A cost dial must never be able to
  // stop every staff roster load, and the documented command must repair it.
  const w = await makeWorld();
  const dialRows = () => w.store.rows("appState").filter((r) => r.key === "idleRefresh");
  const tryRun = async (fn) => { try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, why: String(e && e.message) }; } };
  await w.rt.run("appData.setIdleRefresh", { minutes: 4, actorName: "Test Admin" });
  await w.store.db.insert("appState", { key: "idleRefresh", value: { minutes: 7 }, mirroredAt: AT });
  const loaded = await tryRun(async () => (await w.as("teacher", "appData.load", {})).idleRefreshMinutes);
  check("A DUPLICATE DIAL ROW DOES NOT STOP THE ROSTER: appData:load still answers, with the first row's number",
    loaded.ok && loaded.v === 4, J(loaded));
  const st = await tryRun(() => w.rt.run("appData.idleRefreshStatus", {}));
  check("...the status command still answers", st.ok && st.v.minutes === 4, J(st));
  const set = await tryRun(() => w.rt.run("appData.setIdleRefresh", { minutes: 5, actorName: "Test Admin" }));
  const after = await tryRun(async () => (await w.as("teacher", "appData.load", {})).idleRefreshMinutes);
  check("...and setIdleRefresh repairs it: one row left, holding the new number",
    set.ok && set.v.ok === true && dialRows().length === 1 && dialRows()[0].value.minutes === 5 && after.v === 5,
    J({ set, rows: dialRows().length, after }));
  await w.store.db.insert("appState", { key: "idleRefresh", value: { minutes: 9 }, mirroredAt: AT });
  const bad = await tryRun(() => w.rt.run("appData.setIdleRefresh", { minutes: -1, actorName: "Test Admin" }));
  check("...a refused change writes nothing, duplicates included", bad.ok && bad.v.ok === false && dialRows().length === 2, J({ bad, rows: dialRows().length }));
  const unset = await tryRun(() => w.rt.run("appData.setIdleRefresh", { minutes: null, actorName: "Test Admin" }));
  check("...and unsetting removes every copy", unset.ok && dialRows().length === 0, J({ unset, rows: dialRows().length }));
}

loaded.cleanup();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
