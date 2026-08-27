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

// ===========================================================================
// THE HALF THAT WAS MISSING, and the reason it needs a test of its own.
//
// Everything above passed while the screen was still broken. The rule was
// right, the schema field was right, the mutation was right, and NOTHING IN
// THE BROWSER CALLED ANY OF IT: Set Pass Limit wrote the number onto the
// roster object and handed it to appData:save, which does not carry the field.
// A green suite reported a working cap for a screen that could not set one.
//
// So these check the wiring, sliced out of the shipped script.js.
// ===========================================================================
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./script.js", import.meta.url), "utf8");
function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`marker not found: ${endMarker}`);
  return src.slice(start, end);
}

// A document stub: only what these three functions touch.
const els = {};
const makeEl = () => ({ style: {}, textContent: "", innerHTML: "", className: "" });
["passLimitStatus", "passLimitText"].forEach((id) => { els[id] = makeEl(); });
const ui = new Function(
  "document",
  slice("/* ---- pass limit: this child's own cap", "/* ---- end pass limit ---- */") +
    "\nreturn { wcRenderPassLimit, wcPassLimitInputValue, wcPassLimitArg };",
)({ getElementById: (id) => els[id] || null });

console.log("\n6. What the box holds when the modal opens");
check("no personal cap is BLANK, not 0", ui.wcPassLimitInputValue({ limit: null, takenToday: 0 }) === "");
check("a missing cap object is blank too", ui.wcPassLimitInputValue(null) === "");
check("a cap of 0 shows 0, not blank", ui.wcPassLimitInputValue({ limit: 0, takenToday: 0 }) === "0");
check("a cap of 3 shows 3", ui.wcPassLimitInputValue({ limit: 3, takenToday: 1 }) === "3");

console.log("\n7. What the box MEANS when Save is pressed");
check("blank clears the cap (null, not 0)", ui.wcPassLimitArg("").limit === null);
check("whitespace is blank", ui.wcPassLimitArg("   ").limit === null);
check("'0' is a cap of zero, not a clear", ui.wcPassLimitArg("0").limit === 0);
check("'3' is three", ui.wcPassLimitArg("3").limit === 3);
check("a negative is refused, not floored", ui.wcPassLimitArg("-1").ok === false);
check("a fraction is refused rather than silently rounded", ui.wcPassLimitArg("2.5").ok === false);
check("letters are refused", ui.wcPassLimitArg("three").ok === false);
check("above the server's 50 is refused here, before the round trip", ui.wcPassLimitArg("51").ok === false);
check("50 itself is allowed", ui.wcPassLimitArg("50").limit === 50);
check("a refusal explains blank vs a number", /blank to clear/.test(ui.wcPassLimitArg("x").message));

console.log("\n8. The row beside the button says what the server says");
const render = (cap) => ui.wcRenderPassLimit(cap, els.passLimitStatus);
check("no cap hides the row", render({ limit: null, takenToday: 4 }) === null
  && els.passLimitStatus.style.display === "none");
const three = render({ limit: 3, takenToday: 1 });
check("a cap shows the row", els.passLimitStatus.style.display === "block");
check("and both figures are the server's", three.limit === 3 && three.taken === 1);
check("the sentence is the count over the cap", /1 \/ 3 passes used today/.test(els.passLimitText.innerHTML));
check("under the cap is not flagged as reached", three.reached === false);
check("at the cap is reached", render({ limit: 3, takenToday: 3 }).reached === true);
const none = render({ limit: 0, takenToday: 0 });
check("A CAP OF ZERO IS VISIBLE, not hidden as falsy", els.passLimitStatus.style.display === "block");
check("zero reads as the stop it is, not '0 / 0'", /may not take hall passes/.test(els.passLimitText.innerHTML));
check("and counts as reached before the day starts", none.reached === true);
check("a count the server did not send does not invent one",
  render({ limit: 2 }).taken === 0);

console.log("\n9. Nothing writes this number except the audited mutation");
check("savePassLimit calls studentDetail:setPassLimit",
  /convexMutation\(\s*'studentDetail:setPassLimit'/.test(src));
check("and no longer pushes dailyPassLimit through saveData",
  !/selectedSnapshotStudent\.dailyPassLimit\s*=/.test(src));
check("the status row no longer counts the pre-Convex array",
  !/hallPasses\.filter\(p =>\s*\n?\s*p\.studentId === selectedSnapshotStudent/.test(src));
check("the cap is read off the query response, not the roster",
  /wcSnapshotCap = res\.cap/.test(src));
check("the server sends it: history returns cap",
  /cap = \{ limit: passLimitFor\(student\), takenToday: passesTakenOnDay\(rows, now\) \}/
    .test(readFileSync(new URL("./convex/hallPasses.ts", import.meta.url), "utf8")));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
