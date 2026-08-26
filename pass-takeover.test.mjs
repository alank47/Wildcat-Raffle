// When the hall pass owns the student's screen. Run: npm test
//
// A pass with a clock on it used to be one card of four, and on a phone its
// box was shorter than the ring, the route, the tracker and the approver it
// carried, so the Student ID strip sat on top of the tracker. From approval to
// the return tap the pass now takes the whole screen. This file pins WHEN, as
// a pure decision sliced out of the shipped script.js (the same trick
// pass-clock.test.mjs uses), so the rule cannot drift from what is deployed:
//
//   - never while there is no pass, or the pass is only requested
//   - from approval (`active`), through `out`, until it is terminal
//   - "Show my other cards" puts the wallet back for THAT state of THAT pass,
//     and the layer returns the moment the pass moves on or goes overdue

import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./script.js", import.meta.url), "utf8");

function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `marker not found in script.js: ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.notStrictEqual(end, -1, `marker not found in script.js: ${endMarker}`);
  return src.slice(start, end);
}

const { wpTakeoverKey, wpPassTakesOver } = new Function(
  slice("/* ---- pass takeover ---- */", "/* ---- end pass takeover ---- */") +
  "\nreturn { wpTakeoverKey, wpPassTakesOver };",
)();

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}`); }
}

const pass = (over) => ({ available: true, id: "pass_1", state: "active", ...over });

console.log("\n1. No pass, no takeover");
check("nothing at all", wpPassTakesOver(null, "") === false);
check("an unavailable payload", wpPassTakesOver({ available: false, state: "active" }, "") === false);
check("state none", wpPassTakesOver(pass({ state: "none" }), "") === false);

console.log("\n2. A request waiting on a teacher keeps the wallet");
check("requested", wpPassTakesOver(pass({ state: "requested" }), "") === false);
check("pending", wpPassTakesOver(pass({ state: "pending" }), "") === false);
check("and the key is empty, so nothing can be dismissed", wpTakeoverKey(pass({ state: "requested" })) === "");

console.log("\n3. From approval to the return tap, the pass owns the screen");
check("active", wpPassTakesOver(pass({ state: "active" }), "") === true);
check("out", wpPassTakesOver(pass({ state: "out" }), "") === true);
check("an approved pass with its timer cleared", wpPassTakesOver(pass({ state: "active", clockLimitMinutes: null, timerCleared: true }), "") === true);
check("state compares case-insensitively", wpPassTakesOver(pass({ state: "ACTIVE" }), "") === true);

console.log("\n4. Terminal states hand the screen back");
for (const state of ["returned", "expired", "cancelled", "canceled", "denied"]) {
  check(state, wpPassTakesOver(pass({ state }), "") === false);
}

console.log("\n5. Dismissal is per pass state, not forever");
const active = pass({ state: "active" });
const key = wpTakeoverKey(active);
check("the key names the pass and the state", key === "pass_1|active");
check("dismissed with its own key, the layer stays down", wpPassTakesOver(active, key) === false);
check("a destination tap brings it back", wpPassTakesOver(pass({ state: "out" }), key) === true);
check("going overdue brings it back", wpPassTakesOver(pass({ state: "active", overdue: true }), key) === true);
check("and the overdue key differs from the calm one", wpTakeoverKey(pass({ state: "active", overdue: true })) === "pass_1|active|overdue");
check("a different pass in the same state brings it back", wpPassTakesOver(pass({ id: "pass_2" }), key) === true);
check("a stale key from an old session does nothing", wpPassTakesOver(active, "pass_0|out") === true);
check("an undefined key reads as no dismissal", wpPassTakesOver(active, undefined) === true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
