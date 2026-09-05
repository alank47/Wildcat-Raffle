// Referral ids, and the day two teachers minted the same one.
//
// THE INCIDENT, 2026-09-04. Ids came from `REF${referralIdCounter++}` -- one
// counter, held per browser, reconciled between machines only when a save
// happened to land. A referral for Nadia Almendares-Castaneda was minted as
// REF12. The server already held a REF12: a different child, Milachi Isidro
// Rogers, filed by a different teacher.
//
// The save path is mergeLegacySlice(..., 'id'), which dedupes on the id and
// lets the STORED copy win. That is right when the two are the same record
// arriving twice and catastrophic when they are different children. Nadia's
// referral reported success, appeared in Open Referrals, and was gone on the
// next reload -- where View then showed the other teacher's referral about the
// other child. Production also carried a duplicate REF2.
//
// A referral is a disciplinary record about a named child. These assertions are
// about not losing one.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");
new Function(src)();
const D = globalThis.WildcatDiscipline;
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\nThe counter is gone from id minting");
{
  check("nothing mints an id from the counter any more",
    !/id: `REF\$\{referralIdCounter\+\+\}`/.test(script));
  check("referrals are minted by the rules module",
    /id: window\.WildcatDiscipline\.newReferralId\(\)/.test(script));
  check("the counter survives, because old ids came from it",
    /let referralIdCounter = 1;/.test(script));
  check("and says so, so nobody deletes it or starts using it again",
    /LEGACY\. No longer mints ids/.test(script));
}

console.log("\nTwo computers cannot mint the same id");
{
  // The actual failure. Independent mints, no shared state of any kind.
  // SIZED TO REALITY, not to a round number. The suffix is 7 characters from a
  // 32-symbol alphabet: 34.4 billion per day. A school files tens of referrals
  // a day, so the honest test is that a day's worth never collides.
  //
  // An earlier version of this asserted zero collisions in 100,000 mints. That
  // is 100,000 referrals in ONE DAY, which cannot happen, and at that volume
  // the birthday bound EXPECTS about 0.145 collisions -- so it failed roughly
  // one run in seven. A test that flakes teaches people to re-run it, which is
  // worse than not having it.
  const DAY = 2000;                       // far above a real day at this school
  const ids = new Set();
  for (let i = 0; i < DAY; i++) ids.add(D.newReferralId());
  check(`${DAY} referrals in one day are all distinct`, ids.size === DAY);

  // And the rate at absurd volume, which is the property the size was chosen
  // for. Expected collisions at 100,000 is ~0.145; anything near 1% would mean
  // the alphabet or the length is wrong.
  const many = new Set();
  const N = 100000;
  for (let i = 0; i < N; i++) many.add(D.newReferralId());
  const rate = (N - many.size) / N;
  check(`at 100,000 mints the collision rate stays under 0.01% (${(rate * 100).toFixed(4)}%)`,
    rate < 0.0001);

  // Two machines filing in the same second, which is the real scenario.
  const sameInstant = new Date("2026-09-04T18:30:00");
  const burst = new Set();
  for (let i = 0; i < 5000; i++) burst.add(D.newReferralId(sameInstant));
  check("5,000 mints in the SAME instant are still distinct", burst.size === 5000);
}

console.log("\nThe id stays something a person can read and say");
{
  const id = D.newReferralId(new Date("2026-09-04T10:00:00"));
  check("it carries the date, so the column sorts and reads", /^REF-260904-/.test(id));
  check("it is short enough to dictate", id.length === 18);
  check("uppercase and digits only", /^REF-\d{6}-[0-9A-Z]{7}$/.test(id));

  // Confusable characters. 0/O and 1/I are the pairs people get wrong reading
  // a case number aloud; L stays because with 0, 1 and I all absent there is
  // nothing left for it to be mistaken for -- and 32 characters is what keeps
  // the byte modulo unbiased.
  let alphabet = new Set();
  for (let i = 0; i < 3000; i++) D.newReferralId().slice(-7).split("").forEach((c) => alphabet.add(c));
  check("no 0 and no O", !alphabet.has("0") && !alphabet.has("O"));
  check("no 1 and no I", !alphabet.has("1") && !alphabet.has("I"));
  check("exactly 32 symbols, which keeps the modulo unbiased", alphabet.size === 32);
}

console.log("\nThe suffix is not predictable across machines");
{
  // Math.random is seeded per process, and a school's Chromebooks boot together
  // off an identical image. Correlated seeds are exactly how two of them mint
  // the same suffix in the same second.
  check("crypto.getRandomValues is preferred", /crypto\.getRandomValues/.test(src));
  check("with Math.random only as a fallback",
    /Falls back to Math\.random rather than throwing/.test(src));

  // Injected randomness is honoured, which is what makes this testable at all.
  let n = 0;
  const fixed = () => { n += 0.31; return n % 1; };
  const a = D.newReferralId(new Date("2026-09-04T10:00:00"), fixed);
  n = 0;
  const b = D.newReferralId(new Date("2026-09-04T10:00:00"), fixed);
  check("the same clock and the same randomness reproduce an id", a === b);
  check("which means the generator has no hidden state", a === b && /^REF-260904-/.test(a));
}

console.log("\nA duplicate that already exists is found and shouted about");
{
  check("duplicates are detected", D.duplicateReferralIds(
    [{ id: "REF2" }, { id: "REF3" }, { id: "REF2" }]).join(",") === "REF2");
  check("a clean list reports nothing",
    D.duplicateReferralIds([{ id: "A" }, { id: "B" }]).length === 0);
  check("three of the same id is still reported once",
    D.duplicateReferralIds([{ id: "X" }, { id: "X" }, { id: "X" }]).join(",") === "X");
  check("blank and missing ids are not counted as duplicates of each other",
    D.duplicateReferralIds([{ id: "" }, { id: "  " }, {}]).length === 0);
  check("whitespace around an id does not hide a duplicate",
    D.duplicateReferralIds([{ id: "REF2" }, { id: " REF2 " }]).join(",") === "REF2");
  check("an empty list is fine", D.duplicateReferralIds([]).length === 0);
  check("so is no list at all", D.duplicateReferralIds(undefined).length === 0);

  check("the loader checks every load", /duplicateReferralIds\(behaviorReferrals\)/.test(script));
  check("and reports it as an error, not a shrug",
    /console\.error\([\s\S]{0,120}duplicate referral id/.test(script));
  check("saying plainly that a referral was overwritten",
    /a referral was overwritten by another with the same id/.test(script));
  check("without throwing, because the surviving records still matter",
    /catch \(e\) \{ \/\* the rules module is optional at this point \*\/ \}/.test(script));
}

console.log("\nOld ids still work");
{
  // REF1..REF12 exist in production and are printed in the referral table and
  // the audit log. Nothing may stop resolving them.
  check("the dedupe field is unchanged, so old records still match themselves",
    /mergeLegacySlice\('referrals', 'behaviorReferrals', behaviorReferrals, 'id'\)/.test(script));
  check("lookup is by id, never by position in a filtered list",
    /viewReferralDetails\('\$\{r\.id\}'\)/.test(script));
  check("and the old counter is still loaded and merged as a max",
    /referralIdCounter = Math\.max\(referralIdCounter \|\| 1, referralsData\.referralIdCounter\)/.test(script));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
