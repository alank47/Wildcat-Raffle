// Which board "My Class" is, by role. Run: npm test
//
// A teacher's board is their own lessons' passes. A campus aide or a PBIS
// lead has no lessons and the whole building is their beat, so the same slot
// in the nav is the school-wide list, called Active Passes. The rule is sliced
// out of the shipped script.js so an aide can never again be handed an empty
// class list by a label that lied about what it was.

import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./script.js", import.meta.url), "utf8");
function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  assert.notStrictEqual(end, -1, `marker not found: ${endMarker}`);
  return src.slice(start, end);
}
const { wcPassBoardFor } = new Function(
  slice("/* ---- pass board by role ---- */", "/* ---- end pass board by role ---- */") +
  "\nreturn { wcPassBoardFor };",
)();

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); } else { failed++; console.log(`  FAIL  ${name}`); }
}

console.log("\n1. Campus roles get the building");
for (const role of ["campusaide", "pbis", "CampusAide", " PBIS "]) {
  const nav = wcPassBoardFor(role);
  check(`${JSON.stringify(role)} is the campus board`, nav.board === "campus");
  check(`  and it is called Active Passes`, /Active Passes/.test(nav.label));
}

console.log("\n2. Everyone else keeps their class");
for (const role of ["teacher", "admin", "superadmin", "", null, undefined, "somethingelse"]) {
  const nav = wcPassBoardFor(role);
  check(`${JSON.stringify(role)} is the class board`, nav.board === "class");
  check(`  and it is called My Class`, /My Class/.test(nav.label));
}

console.log("\n3. The campus board explains itself");
const c = wcPassBoardFor("campusaide");
check("has a title", typeof c.title === "string" && c.title.length > 0);
check("has a hint that names the actions", /adjust|close|tell/i.test(c.hint));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
