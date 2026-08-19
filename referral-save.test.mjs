// The referral save, exercised as a transaction rather than reasoned about.
//
// wildcat-merge.test.mjs proves the merge. This proves the INTEGRATION: that
// the save path built on it survives the things a real Firestore transaction
// does, which are a retried callback and an outright failure.
//
// The scenario throughout is the reported one: teacher A files a referral,
// teacher B's tab has been open since morning and saves.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-merge.js", import.meta.url), "utf8");
new Function(src)();
const M = globalThis.WildcatMerge;

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

const ref = (id, over = {}) =>
  Object.assign({ id, status: "open", submittedAt: "2026-08-19T09:00:00.000Z" }, over);

/**
 * A Firestore stand-in that behaves the way the real one does where it
 * matters: the callback may run more than once, and each attempt re-reads.
 */
function fakeFirestore(initialDoc, { failAttempts = 0, mutateBetweenAttempts = null } = {}) {
  let stored = JSON.parse(JSON.stringify(initialDoc));
  let attempts = 0;
  return {
    get stored() { return stored; },
    get attempts() { return attempts; },
    async runTransaction(fn) {
      for (;;) {
        attempts++;
        let staged = null;
        const transaction = {
          async get() {
            return { exists: () => stored !== null, data: () => stored };
          },
          set(_ref, value) { staged = value; },
        };
        await fn(transaction);
        if (attempts <= failAttempts) {
          // Contention: another writer landed first, so the attempt is thrown
          // away and the callback runs again against the newer document.
          if (mutateBetweenAttempts) stored = mutateBetweenAttempts(stored);
          continue;
        }
        stored = staged;
        return;
      }
    },
  };
}

/** The save path from script.js, structured identically. */
async function saveReferrals(db, localReferrals, localCounter) {
  let mergedReferrals = null;
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get();
    const stored = snap.exists() ? (snap.data().behaviorReferrals || []) : [];
    const merged = M.mergeById(stored, localReferrals);
    transaction.set(null, {
      behaviorReferrals: merged,
      referralIdCounter: Math.max(
        Number(localCounter) || 1,
        Number(snap.exists() ? snap.data().referralIdCounter : 1) || 1),
      lastSaveTimestamp: 1,
    });
    mergedReferrals = merged;
  });
  return mergedReferrals;
}

console.log("\nThe reported scenario, through the real save path");
{
  // Storage has A's new referral. B's tab predates it.
  const db = fakeFirestore({ behaviorReferrals: [ref("REF1"), ref("REF2"), ref("REF3")], referralIdCounter: 4 });
  const bStaleLocal = [ref("REF1"), ref("REF2")];

  const result = await saveReferrals(db, bStaleLocal, 3);
  check("B's save does NOT delete A's referral", db.stored.behaviorReferrals.length === 3);
  check("A's referral is still there by id",
    db.stored.behaviorReferrals.some((r) => r.id === "REF3"));
  check("and B's in-memory list is corrected to match", result.length === 3);
  check("the counter does not go backwards", db.stored.referralIdCounter === 4);
}

console.log("\nA retried transaction loses nothing");
{
  // First attempt is discarded; between attempts another teacher files REF4.
  const db = fakeFirestore(
    { behaviorReferrals: [ref("REF1")], referralIdCounter: 2 },
    {
      failAttempts: 1,
      mutateBetweenAttempts: (s) => ({
        behaviorReferrals: [...s.behaviorReferrals, ref("REF4")],
        referralIdCounter: 5,
      }),
    },
  );
  const local = [ref("REF1"), ref("REF2")];

  const result = await saveReferrals(db, local, 3);
  check("the callback really did run twice", db.attempts === 2);
  check("the referral that landed BETWEEN attempts survives",
    db.stored.behaviorReferrals.some((r) => r.id === "REF4"));
  check("this tab's own new referral also survives",
    db.stored.behaviorReferrals.some((r) => r.id === "REF2"));
  check("nothing is duplicated by the retry",
    new Set(db.stored.behaviorReferrals.map((r) => r.id)).size === db.stored.behaviorReferrals.length);
  check("three referrals in total", db.stored.behaviorReferrals.length === 3);
  check("the higher counter from the other writer wins", db.stored.referralIdCounter === 5);
  check("the returned list matches what was stored", result.length === 3);
}

console.log("\nEvery attempt merges the ORIGINAL local list");
{
  // If an attempt mutated the caller's array, a retry would compound it.
  const db = fakeFirestore(
    { behaviorReferrals: [ref("REF1")] },
    { failAttempts: 2, mutateBetweenAttempts: (s) => s },
  );
  const local = [ref("REF2")];
  const before = JSON.stringify(local);
  await saveReferrals(db, local, 1);
  check("the caller's array is untouched across three attempts", JSON.stringify(local) === before);
  check("and the stored result is still exactly two rows", db.stored.behaviorReferrals.length === 2);
}

console.log("\nA failed transaction does not corrupt memory");
{
  const db = {
    stored: { behaviorReferrals: [ref("REF1")] },
    async runTransaction() { throw new Error("permission-denied"); },
  };
  const local = [ref("REF2")];
  let threw = false;
  let applied = null;
  try {
    applied = await saveReferrals(db, local, 1);
  } catch (e) { threw = true; }

  check("the failure propagates rather than being swallowed", threw === true);
  check("nothing was applied to the in-memory list", applied === null);
  check("the caller's list still holds only what it had", local.length === 1 && local[0].id === "REF2");
}

console.log("\nAn empty or missing document is not a reason to lose anything");
{
  const db = fakeFirestore(null);
  const result = await saveReferrals(db, [ref("REF1")], 2);
  check("a first-ever save writes the local list", db.stored.behaviorReferrals.length === 1);
  check("and returns it", result.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
