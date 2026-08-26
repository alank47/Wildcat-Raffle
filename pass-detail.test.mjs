// The pass detail, the campus board and the note badge, rendered. Run: npm test
//
// These build HTML from a payload hallPasses:passDetail / liveBoard actually
// sends. Nobody can sign in as a campus aide from a test, so the builders are
// lifted out of script.js by brace matching (the harness's trick) and run
// against a stub document: if a builder throws, or forgets the form on a live
// pass, or offers a note form on a closed one, this is where it shows.

import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./script.js", import.meta.url), "utf8");
function block(marker) {
  const start = src.indexOf(marker);
  assert.notStrictEqual(start, -1, `marker not found: ${marker}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced: ${marker}`);
}

// A document just big enough: elements by id, innerHTML as a string.
const els = {};
const el = (id) => (els[id] ||= { id, innerHTML: "", style: {}, classList: { add() {}, remove() {} } });
const document = {
  getElementById: (id) => el(id),
  querySelector: () => null,
};
const lifted = [
  block("function wpEsc("),
  block("function wcPassBoardFor("),
  block("function wcStaffRole("),
  block("function wcBellSession("),
  block("function wcNoteBadgeHtml("),
  block("function wcDrawActiveBoard("),
  block("function wcClockAt("),
  block("function wcDrawPassDetail("),
].join("\n");
const api = new Function("document", "window", "currentUser", "wcActiveBoard",
  "let wcActiveBoardState = wcActiveBoard;\n" +
  lifted.replace("function wcDrawActiveBoard()", "function wcDrawActiveBoard(){ wcActiveBoard = wcActiveBoardState; return _draw(); }\nfunction _draw()") +
  "\nreturn { wcNoteBadgeHtml, wcDrawPassDetail, wcDrawActiveBoard, wpEsc };",
);

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); } else { failed++; console.log(`  FAIL  ${name}`); }
}

console.log("\n1. The badge");
{
  const { wcNoteBadgeHtml } = api(document, {}, null, null);
  check("no notes, no badge", wcNoteBadgeHtml({ count: 0, highest: null, latest: null }) === "");
  check("undefined, no badge", wcNoteBadgeHtml(undefined) === "");
  const one = wcNoteBadgeHtml({ count: 1, highest: "concern", latest: { level: "concern", text: "Says <sick>", authorName: "Ms. A", at: "2026-08-26T18:00:00Z" } });
  check("one note says 'note'", /<\/i>note</.test(one));
  check("wears the highest level", /is-concern/.test(one));
  check("escapes the text", one.includes("Says &lt;sick&gt;") && !one.includes("<sick>"));
  const three = wcNoteBadgeHtml({ count: 3, highest: "urgent", latest: { level: "info", text: "fine", authorName: "x", at: "2026-08-26T18:00:00Z" } });
  check("three notes count", /3 notes/.test(three));
  check("urgent outranks the calm latest", /is-urgent/.test(three));
}

const live = {
  id: "p1", state: "out", terminal: false,
  student: { name: "Test Student", number: "12217", grade: "9" },
  reason: "Library", requestedVia: "student-schedule",
  origin: "Test Classroom", assignedDestination: null, tappedDestination: "Restroom",
  courseName: "Test Class · Period 3", period: "3",
  teacherEmail: "lawrenceb@lapromisefund.org", teacherName: "Lawrence Berment",
  approvedByName: "Lawrence Berment", closedByName: null, closedReason: null,
  requestedAt: "2026-08-26T18:08:53Z", approvedAt: "2026-08-26T18:12:00Z", outAt: "2026-08-26T18:15:00Z",
  returnedAt: null, closedAt: null, expiresAfterMinutes: 10, reachMinutes: 5, timerCleared: false,
  clockStartAt: "2026-08-26T18:15:00Z", clockLimitMinutes: 10, elapsedMinutes: 3.2, overdue: false,
  notes: [{ id: "n1", level: "concern", text: "Seen near the gym, not the library", authorName: "Aide One", authorRole: "campusaide", mine: false, at: "2026-08-26T18:17:00Z" }],
  isOwnClass: false, serverTime: "2026-08-26T18:18:00Z",
};

console.log("\n2. A live pass, opened by an aide");
{
  const { wcDrawPassDetail } = api(document, {}, { role: "campusaide" }, null);
  wcDrawPassDetail(live);
  const html = el("passDetailContent").innerHTML;
  check("names the student", html.includes("Test Student"));
  check("names the teacher", html.includes("Lawrence Berment"));
  check("shows the route from the tapped destination", html.includes("Restroom → Test Classroom"));
  check("lists the note", html.includes("Seen near the gym"));
  check("offers the note form", html.includes('id="wcNoteText"'));
  check("addresses the teacher by name", html.includes("Tell Lawrence Berment something"));
  check("offers Reset timer / No limit / Close", /Reset timer/.test(html) && /No limit/.test(html) && /Close pass/.test(html));
  check("does not offer Approve on an out pass", !/>Approve</.test(html));
}

console.log("\n3. A request, opened by its own teacher");
{
  const { wcDrawPassDetail } = api(document, {}, { role: "teacher" }, null);
  wcDrawPassDetail({ ...live, state: "requested", approvedAt: null, outAt: null, elapsedMinutes: null, clockStartAt: null, notes: [], isOwnClass: true });
  const html = el("passDetailContent").innerHTML;
  check("offers Approve and Deny", />Approve</.test(html) && />Deny</.test(html));
  check("clock is not running", html.includes("not running"));
  check("form says add a note, not tell someone", html.includes("Add a note to this pass"));
  check("says nothing is written yet", html.includes("Nothing written on this pass yet"));
}

console.log("\n4. A closed pass");
{
  const { wcDrawPassDetail } = api(document, {}, { role: "campusaide" }, null);
  wcDrawPassDetail({ ...live, state: "expired", terminal: true, closedAt: "2026-08-26T18:40:00Z", closedByName: "Aide One", closedReason: "Found in the gym" });
  const html = el("passDetailContent").innerHTML;
  check("no note form on a closed pass", !html.includes('id="wcNoteText"'));
  check("no actions on a closed pass", !/Close pass|Reset timer|>Approve</.test(html));
  check("shows who closed it and why", html.includes("by Aide One: Found in the gym"));
  check("still shows the notes", html.includes("Seen near the gym"));
}

console.log("\n5. The campus board");
{
  const board = {
    passes: [
      { id: "a", state: "out", studentName: "A Student", studentNumber: "1", grade: "9", elapsedMinutes: 12.4, overdue: true, reason: null, origin: "Rm 1", assignedDestination: "Nurse", teacherName: "Mr. T", courseName: "Bio", period: "2", timerCleared: false, notes: { count: 1, highest: "urgent", latest: { level: "urgent", text: "help", authorName: "x", at: "2026-08-26T18:00:00Z" } } },
      { id: "b", state: "active", studentName: "B Student", studentNumber: "2", grade: null, elapsedMinutes: 1, overdue: false, reason: "Locker", origin: null, assignedDestination: null, teacherName: null, courseName: null, period: null, timerCleared: true, notes: { count: 0, highest: null, latest: null } },
    ],
    truncatedStates: ["out"],
  };
  const { wcDrawActiveBoard } = api(document, {}, { role: "campusaide" }, board);
  wcDrawActiveBoard();
  const html = el("myClassHost").innerHTML;
  check("titled as the campus board", html.includes("Every pass open right now"));
  check("two rows, each openable", (html.match(/openPassDetail\('a'\)/g) || []).length >= 1 && (html.match(/openPassDetail\('b'\)/g) || []).length >= 1);
  check("counts them", html.includes("2 open"));
  check("overdue row is tinted", html.includes("rgba(179,57,47,.07)"));
  check("a pass with no teacher says so", html.includes("no teacher on this pass"));
  check("a reason stands in for a destination", html.includes("Locker"));
  check("the cap is reported", html.includes("hit its limit for: out"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
