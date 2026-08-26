// Notes on a live pass: who may write one, what it may say. Run: npm test
//
// A campus aide who meets a child in a corridor writes a note against the
// pass, and the teacher whose lesson the pass left reads it on their board and
// gets a push. These are the rules that gate the write and shape the badge,
// tested against the real module rather than a copy.

import assert from "node:assert";
import { canNotePass, summarizeNotes, NOTE_LEVELS, MAX_NOTE_LENGTH } from "./hallPassRules.ts";

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}`); }
}

console.log("\n1. The levels are three, and only three");
check("info, concern, urgent", NOTE_LEVELS.join(",") === "info,concern,urgent");
check("a fourth is refused", canNotePass({ state: "out" }, "panic", "hi").ok === false);
check("a level of the wrong type is refused", canNotePass({ state: "out" }, 2, "hi").ok === false);

console.log("\n2. Only a live pass takes a note");
for (const state of ["requested", "active", "out"]) {
  check(`${state} accepts`, canNotePass({ state }, "info", "Seen at the library").ok === true);
}
for (const state of ["returned", "denied", "cancelled", "expired"]) {
  const v = canNotePass({ state }, "urgent", "Not where they said");
  check(`${state} refuses`, v.ok === false);
  check(`  and says why`, /already/.test(v.reason));
}

console.log("\n3. The text is a sentence, not a ping");
check("empty is refused", canNotePass({ state: "out" }, "info", "").ok === false);
check("whitespace is refused", canNotePass({ state: "out" }, "info", "   \n ").ok === false);
check("a non-string is refused", canNotePass({ state: "out" }, "info", null).ok === false);
const long = "x".repeat(MAX_NOTE_LENGTH + 1);
check(`over ${MAX_NOTE_LENGTH} characters is refused`, canNotePass({ state: "out" }, "info", long).ok === false);
check("exactly the limit is accepted", canNotePass({ state: "out" }, "info", "x".repeat(MAX_NOTE_LENGTH)).ok === true);
const messy = canNotePass({ state: "out" }, "concern", "  Says   they\nfeel  sick  ");
check("whitespace is collapsed on the way in", messy.text === "Says they feel sick");
check("and the level comes back typed", messy.level === "concern");

console.log("\n4. The badge is the newest note and the count, and the highest weight");
check("no notes", JSON.stringify(summarizeNotes([])) === JSON.stringify({ count: 0, latest: null, highest: null }));
check("not an array", summarizeNotes(undefined).count === 0);
const notes = [
  { at: "2026-08-26T18:00:00.000Z", level: "urgent", text: "a" },
  { at: "2026-08-26T18:05:00.000Z", level: "info", text: "b" },
  { at: "2026-08-26T18:02:00.000Z", level: "concern", text: "c" },
];
const sum = summarizeNotes(notes);
check("count is all of them", sum.count === 3);
check("latest is by time, not by position", sum.latest.text === "b");
check("highest weight survives a calmer newer note", sum.highest === "urgent");
const one = summarizeNotes([{ at: "2026-08-26T18:00:00.000Z", level: "concern", text: "only" }]);
check("a single note is both latest and highest", one.latest.text === "only" && one.highest === "concern");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
