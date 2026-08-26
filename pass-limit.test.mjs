// A child's own daily pass cap. Run: npm test
//
// "Set Pass Limit" on Student Snapshot used to write a number into the
// browser's roster array, where the only thing that ever read it was the
// deleted kiosk: a teacher could set two passes a day, watch it save, and
// watch the child take eight. The cap is a server rule now, and these are its
// edges. Tested against the real module.

import { canRequest, passLimitFor, MAX_PASSES_PER_SCHOOL_DAY } from "./convex/hallPassRules.ts";

let passed = 0, failed = 0;
const check = (n, ok) => { if (ok) { passed++; console.log(`  PASS  ${n}`); } else { failed++; console.log(`  FAIL  ${n}`); } };

const NOW = "2026-08-26T18:00:00.000Z";
const took = (n) => Array.from({ length: n }, () => ({
  state: "returned", requestedAt: "2026-08-26T14:00:00.000Z", approvedAt: "2026-08-26T14:01:00.000Z",
}));
const open = { active: true };

console.log("\n1. Reading the limit off a record a person typed into");
check("a number is taken", passLimitFor({ dailyPassLimit: 3 }) === 3);
check("zero is a real limit, not absent", passLimitFor({ dailyPassLimit: 0 }) === 0);
check("absent is null", passLimitFor({}) === null);
check("null is null", passLimitFor({ dailyPassLimit: null }) === null);
check("a string is refused", passLimitFor({ dailyPassLimit: "3" }) === null);
check("negative is refused", passLimitFor({ dailyPassLimit: -1 }) === null);
check("NaN is refused", passLimitFor({ dailyPassLimit: NaN }) === null);
check("a fraction floors", passLimitFor({ dailyPassLimit: 2.7 }) === 2);

console.log("\n2. The cap stops the request");
check("under the limit is allowed", canRequest(took(1), open, NOW, 2).ok === true);
check("at the limit is refused", canRequest(took(2), open, NOW, 2).ok === false);
check("over the limit is refused", canRequest(took(5), open, NOW, 2).ok === false);
check("the refusal says the number", /2 passes/.test(canRequest(took(2), open, NOW, 2).reason));
check("one pass is singular", /1 pass\b/.test(canRequest(took(1), open, NOW, 1).reason));

console.log("\n3. Zero means no passes, and says so differently");
const zero = canRequest([], open, NOW, 0);
check("zero refuses even with none taken", zero.ok === false);
check("and does not say 'used your 0 passes'", !/used your/.test(zero.reason));
check("it says they cannot take passes", /not able to take hall passes/.test(zero.reason));

console.log("\n4. No personal limit falls back to the school-wide cap");
check("no limit, under the school cap", canRequest(took(3), open, NOW, null).ok === true);
check("no limit, at the school cap", canRequest(took(MAX_PASSES_PER_SCHOOL_DAY), open, NOW, null).ok === false);
check("undefined behaves as absent", canRequest(took(3), open, NOW, undefined).ok === true);
check("a personal limit ABOVE the school cap cannot raise it",
  canRequest(took(MAX_PASSES_PER_SCHOOL_DAY), open, NOW, 99).ok === false);

console.log("\n5. The older rules still win where they should");
check("a live pass still blocks, whatever the limit",
  canRequest([{ state: "out", requestedAt: NOW }], open, NOW, 99).ok === false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
