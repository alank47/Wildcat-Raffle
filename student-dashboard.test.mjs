// The student's desk dashboard, and the one rule it exists to keep. Run: npm test
//
// A PHONE AND A CHROMEBOOK ARE NOT THE SAME ERRAND. On a phone the student is
// holding the device for the pass, the barcode or the lunch number, so the
// wallet is the whole product. On a Chromebook they are sitting down and the
// question is where they stand. Schedule and Grades used to be two more cards
// in the swipeable stack above 900px, which put a timetable and a report card
// inside a box sized for a barcode; they are panels now, next to tickets, what
// the student has earned, and attendance.
//
// NULL IS NOT ZERO, and this is the screen where that costs a child something.
// views_app.ts says it plainly: weeksQualified, the three cash figures and
// every attendance count are OPTIONAL in schema.ts, and a field a sync dropped
// must not render as a 0 that a student reads as "you have earned nothing", or
// as a $0.00 balance indistinguishable from having spent it. Most of the file
// below is that one rule, from both sides: an absence must not look like a
// number, and a REAL zero must still look like a number.

import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
const check = (n, ok, detail) => {
  if (ok) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; console.log(`  FAIL  ${n}${detail ? "\n        " + detail : ""}`); }
};

const src = readFileSync(new URL("./script.js", import.meta.url), "utf8");
function slice(start, end) {
  const a = src.indexOf(start);
  if (a === -1) throw new Error(`marker not found: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b === -1) throw new Error(`marker not found: ${end}`);
  return src.slice(a, b);
}

// The region under test, plus the two helpers it borrows from the card stack.
const { wpDashboard, wpGradeToggle } = new Function(
  `const wpEsc = (v) => String(v == null ? "" : v)
     .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
   const wpEmpty = (t) => '<p class="wp-empty">' + wpEsc(t) + '</p>';
   const wpFoot  = (t) => '<p class="wp-foot">' + wpEsc(t) + '</p>';
   const wpPeriodRank = (p) => { const n = parseInt(String(p ?? ""), 10); return isNaN(n) ? 999 : n; };
   // wpGradeToggle re-renders through the DOM. There is no DOM here, and a null
   // element is the branch it already handles, so the toggle reduces to exactly
   // the state change this file wants to drive.
   const wpById = () => null;\n` +
  slice("/* ---- the desk dashboard ---", "/* ---- end desk dashboard ---- */") +
  "\nreturn { wpDashboard, wpGradeToggle };",
)();

const FULL = {
  points: { pbis: 12, attendance: 4, academic: 7, total: 23, weeksQualified: 5, bigRaffleEntries: 5 },
  wildcatCash: { balance: 14.5, earned: 40, spent: 25.5 },
  attendance: { available: true, daysAbsentTerm: 2, daysAbsentYtd: 6, daysTardyTerm: 1 },
};
const sched = (rows) => ({ rows, available: true, reason: null });
const grades = (rows) => ({ rows, available: true, reason: null });

console.log("\n1. Everything the student asked to see is on it");
const full = wpDashboard(FULL, sched([{ courseName: "Biology", period: "2", teacher: "Ms Okafor" }]),
  grades([{ courseName: "Biology", currentGrade: "B", currentPercent: 86 }]));
for (const panel of ["Tickets", "What you have earned", "Wildcat Cash", "Grades", "Schedule", "Attendance"]) {
  check(`the ${panel} panel is rendered`, full.includes(">" + panel + "<"));
}
check("the ticket figures are the student's", /12/.test(full) && /\b7\b/.test(full));
check("cash is money, not a bare number", full.includes("$14.50"));

console.log("\n2. NULL IS NOT ZERO");
const missing = wpDashboard({
  points: { pbis: 3, attendance: 0, academic: 0, total: 3, weeksQualified: null, bigRaffleEntries: 0 },
  wildcatCash: { balance: null, earned: null, spent: null },
  attendance: { available: true, daysAbsentTerm: null, daysAbsentYtd: null, daysTardyTerm: null },
}, sched([]), grades([]));
check("an absent weeksQualified says so", missing.includes("not on file"));
check("and is NEVER rendered as 0",
  !/<span class="wp-stat-n">0<\/span>\s*<span class="wp-stat-l">Weeks qualified/.test(missing));
check("an absent balance is not $0.00", !missing.includes("$0.00"));
check("an absence is marked so CSS can shrink it", missing.includes('class="wp-stat is-none"'));

console.log("\n3. A REAL ZERO IS A REAL ANSWER, and still looks like a number");
check("zero tickets renders as 0, not as an absence",
  full.includes('wp-stat-n') && missing.includes(">0<"),
  "a student who has genuinely earned none must see 0, not 'not on file'");
const zeroCash = wpDashboard({ points: {}, wildcatCash: { balance: 0, earned: 0, spent: 0 }, attendance: {} },
  sched([]), grades([]));
check("a balance of exactly zero is $0.00, not an absence", zeroCash.includes("$0.00"));
check("and is not marked as missing",
  (zeroCash.match(/wp-stat is-none/g) || []).length < (missing.match(/wp-stat is-none/g) || []).length);

console.log("\n4. Grades: an empty grade is not a zero, and not an F");
const noGrades = wpDashboard(FULL, sched([]), grades([]));
check("nothing posted says it is not a zero", /not a zero/.test(noGrades));
check("and does not invent a letter", !/>F</.test(noGrades));
const partly = wpDashboard(FULL, sched([]), grades([
  { courseName: "Art", currentGrade: null, currentPercent: null },
  { courseName: "Maths", currentGrade: "A", currentPercent: 95 },
]));
check("an unposted course reads 'Not posted'", partly.includes("Not posted"));
check("the lead counts what is posted, not what exists", partly.includes("1 of 2 posted"));

console.log("\n5. Unavailable is not the same as empty");
const out = wpDashboard({
  points: {}, wildcatCash: {},
  attendance: { available: false, reason: "No student number on file." },
}, { rows: [], available: false, reason: "The schedule service did not answer." },
   { rows: [], available: false, reason: "Grades are not published yet." });
check("an attendance outage prints its reason", out.includes("No student number on file."));
check("a schedule outage prints its reason", out.includes("The schedule service did not answer."));
check("a grades outage prints its reason", out.includes("Grades are not published yet."));
check("and none of them claims a count", !out.includes("0 of 0 posted"));

console.log("\n6. A failed student view does not blank the wallet's own data");
const none = wpDashboard(null, sched([]), grades([]));
check("it says the stats failed", /could not be loaded/.test(none));
check("and says the pass and ID above are unaffected", /unaffected/.test(none));

console.log("\n7. The schedule reads in the order the day runs");
const order = wpDashboard(FULL, sched([
  { courseName: "Last", period: "6" },
  { courseName: "First", period: "1" },
  { courseName: "Lunch", period: "Nutrition" },
  { courseName: "Middle", period: "3" },
]), grades([]));
const seq = ["First", "Middle", "Last", "Lunch"].map((n) => order.indexOf(n));
check("periods are sorted ascending", seq[0] < seq[1] && seq[1] < seq[2]);
check("an unparseable period sorts last, not first", seq[3] > seq[2]);

console.log("\n8. The wallet is the same on every device now");
check("Schedule and Grades are no longer built as cards",
  !/wpScheduleCard|wpGradesCard/.test(src),
  "the dashboard replaced them; a card sized for a barcode is not a report card");
check("the card list is no longer gated on a width",
  !/const onMobile = window\.innerWidth/.test(src));
check("the dashboard is rendered unconditionally, so a resize needs no reload",
  /dash\.innerHTML = wpDashboard\(/.test(src));
check("and is shown by the same .wp-wide the rest of the wide layout uses",
  /#studentPassView\.wp-wide \.wp-dash/.test(readFileSync(new URL("./styles.css", import.meta.url), "utf8")));
check("the container exists in the markup",
  /id="wpDash"/.test(readFileSync(new URL("./index.html", import.meta.url), "utf8")));

console.log("\n9. A grade row opens its own missing work");
{
  const MISSING = {
    available: true,
    total: 3,
    bySection: {
      S1: [
        { assignmentSectionId: "a1", name: "Late essay", dueDate: "2026-08-28", pointsPossible: 15, isLate: true },
        { assignmentSectionId: "a2", name: "Problem set", dueDate: "2026-08-21", pointsPossible: 20, isLate: false },
        { assignmentSectionId: "a3", name: "Journal", dueDate: null, pointsPossible: null, isLate: false },
      ],
      S2: [],
    },
  };
  const rows = [
    { courseName: "Algebra", currentGrade: "B", currentPercent: 86, sectionId: "S1" },
    { courseName: "Biology", currentGrade: "A", currentPercent: 94, sectionId: "S2" },
  ];
  const withMissing = () => wpDashboard(FULL, sched([]), { rows, available: true, missingWork: MISSING });

  // A row must not become a button before there is anything to open. Until the
  // sync runs, opening onto "unavailable" teaches a student the feature is broken.
  const noSync = wpDashboard(FULL, sched([]), { rows, available: true });
  check("without the sync, a course row is not a button", !/wp-row-btn/.test(noSync));
  check("with it, the row is a real button", /<button[^>]*class="wp-row wp-row-btn"/.test(withMissing()));
  check("and says whether it is expanded", /aria-expanded="false"/.test(withMissing()));

  // The count belongs on the closed row, or a student opens six classes to find
  // the one that needs them. Zero is not a count worth showing.
  check("a course with missing work carries a badge", /wp-rowbadge">3</.test(withMissing()));
  check("a course with none carries no badge", (withMissing().match(/wp-rowbadge/g) || []).length === 1);

  wpGradeToggle("S1");
  const open = withMissing();
  check("opening one course marks it open", /wp-gradesec is-open/.test(open));
  check("and flips its aria-expanded", /aria-expanded="true"/.test(open));

  const body = open.slice(open.indexOf("wp-gradesec is-open"));
  const at = (n) => body.indexOf(n);
  check("due work sorts oldest first", at("Problem set") < at("Late essay"));
  check("and undated work sorts LAST, not first",
    at("Journal") > at("Late essay"),
    "sorting on `dueDate || \'\'` puts undated work above things genuinely overdue");
  check("a late piece says so", /marked late/.test(body));

  // The rule this panel shares with every other one: an absent value is absent.
  // \b matters: /0 pts/ matches INSIDE "20 pts", so the naive version fails on
  // correct output and would have been "fixed" by weakening it.
  check("an assignment with no point value shows no points, never 0 pts",
    !/\b0 pts/.test(body) && /20 pts/.test(body));

  wpGradeToggle("S2");
  const other = withMissing();
  check("a course with nothing missing says so rather than showing an empty box",
    /Nothing missing in this class\./.test(other));
  check("only one course is open at a time",
    (other.match(/wp-gradesec is-open/g) || []).length === 1);

  wpGradeToggle("S2");
  check("pressing the open row again closes it",
    !/wp-gradesec is-open/.test(withMissing()));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
