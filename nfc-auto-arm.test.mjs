// When the native app listens for a tag by itself. Run: npm test
//
// A student with a running pass opens the app at the door and holds it to the
// tag, with nothing to press. The rule that decides when the scanner arms is
// sliced out of the shipped script.js so it cannot drift from what runs.

import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./script.js", import.meta.url), "utf8");
function slice(a, b) {
  const i = src.indexOf(a); assert.notStrictEqual(i, -1, a);
  const j = src.indexOf(b, i + a.length); assert.notStrictEqual(j, -1, b);
  return src.slice(i, j);
}
const { wcAutoArmKey } = new Function(
  slice("/* ---- nfc auto-arm ---- */", "/* ---- end nfc auto-arm ---- */") + "\nreturn { wcAutoArmKey };",
)();

let passed = 0, failed = 0;
const check = (n, ok) => { if (ok) { passed++; console.log(`  PASS  ${n}`); } else { failed++; console.log(`  FAIL  ${n}`); } };
const hp = (o) => ({ available: true, id: "p1", state: "active", ...o });

console.log("\n1. Never without a running pass");
check("no pass", wcAutoArmKey(null, "paint", 1) === "");
check("unavailable", wcAutoArmKey({ available: false, state: "active" }, "paint", 1) === "");
check("requested (still waiting on a teacher)", wcAutoArmKey(hp({ state: "requested" }), "paint", 1) === "");
for (const s of ["returned", "expired", "cancelled", "denied", "none"]) check(`${s}`, wcAutoArmKey(hp({ state: s }), "resume", 1) === "");

console.log("\n2. A running pass arms");
check("active on paint", wcAutoArmKey(hp(), "paint", 1) === "p1|active|paint");
check("out on paint", wcAutoArmKey(hp({ state: "out" }), "paint", 1) === "p1|out|paint");
check("active on resume", /^p1\|active\|resume\|/.test(wcAutoArmKey(hp(), "resume", 5)));

console.log("\n3. Paint arms once per state; resume arms every time");
check("same paint key twice", wcAutoArmKey(hp(), "paint", 1) === wcAutoArmKey(hp(), "paint", 2));
check("a state change is a new paint key", wcAutoArmKey(hp(), "paint", 1) !== wcAutoArmKey(hp({ state: "out" }), "paint", 1));
check("two resumes are two keys", wcAutoArmKey(hp(), "resume", 1) !== wcAutoArmKey(hp(), "resume", 2));
check("an unknown reason does nothing", wcAutoArmKey(hp(), "whenever", 1) === "");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
