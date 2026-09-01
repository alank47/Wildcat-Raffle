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
const { wpDashboard, wpGradeOpen, wpGradeTone, __el, __store } = new Function(
  `const wpEsc = (v) => String(v == null ? "" : v)
     .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
   const wpEmpty = (t) => '<p class="wp-empty">' + wpEsc(t) + '</p>';
   const wpFoot  = (t) => '<p class="wp-foot">' + wpEsc(t) + '</p>';
   const wpPeriodRank = (p) => { const n = parseInt(String(p ?? ""), 10); return isNaN(n) ? 999 : n; };
   // The modal writes into an element and reads localStorage. Both are stubbed
   // so the real wpGradeOpen runs here, rather than the test re-implementing
   // what it thinks the modal renders.
   // SEPARATE elements. One stub for both ids meant wpGradeOpen wrote the modal
   // and then the dashboard re-render overwrote it in the same call, and every
   // assertion about modal content read the dashboard instead.
   const __el = { innerHTML: "", classList: { add(){}, remove(){} } };
   const __dash = { innerHTML: "", classList: { add(){}, remove(){} } };
   const wpById = (id) => id === "wpGradeModal" ? __el : (id === "wpDash" ? __dash : null);
   const __store = new Map();
   const localStorage = {
     getItem: (k) => (__store.has(k) ? __store.get(k) : null),
     setItem: (k, v) => __store.set(k, String(v)),
   };
   globalThis.__el = __el; globalThis.__store = __store;\n` +
  slice("/* ---- the desk dashboard ---", "/* ---- end desk dashboard ---- */") +
  "\nreturn { wpDashboard, wpGradeOpen, wpGradeTone, wpUnseenTotal, __el, __store };",
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

console.log("\n9. A grade row opens a modal, and says which nothing it means");
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
  const gradesWith = { rows, available: true, missingWork: MISSING };
  const render = (g) => wpDashboard(FULL, sched([]), g);

  // THE BUG THIS PAIR EXISTS FOR. missingWork reached wpDashboard in every
  // earlier test because they handed it over directly. On the real page it went
  // through wpSection, which kept three keys and dropped the rest, so the
  // feature shipped dead. Assert the CARRY, not just the render.
  const src = readFileSync(new URL("./script.js", import.meta.url), "utf8");
  check("wpSection is told to carry missingWork",
    /wpSection\(mine && mine\.grades, 'courses', \['missingWork'\]\)/.test(src),
    "without this the panel renders correctly and is fed nothing");
  check("and wpSection can carry extra keys at all",
    /function wpSection\(node, rowsKey, carry\)/.test(src));

  // Every row opens, always. A row that is sometimes a button teaches a student
  // the app is broken.
  const noSync = render({ rows, available: true });
  check("a row is a button even before the sync has run", /wp-row-btn/.test(noSync));
  check("and still a button when a class has nothing missing",
    (render(gradesWith).match(/wp-row-btn/g) || []).length === 2);
  check("a course with missing work carries a count", /wp-rowbadge">3</.test(render(gradesWith)));
  check("a course with none carries no count",
    (render(gradesWith).match(/wp-rowbadge/g) || []).length === 1);

  // ---- the modal ----------------------------------------------------------
  __store.clear();
  wpGradeOpen("S1");
  const open = __el.innerHTML;
  check("opening a course renders a dialog", /role="dialog"/.test(open));
  check("titled with the course", /wp-modal-title">Algebra</.test(open));
  check("and showing its grade", /B \u00b7 86%|B · 86%/.test(open));

  check("due work sorts oldest first", open.indexOf("Problem set") < open.indexOf("Late essay"));
  check("and undated work sorts LAST", open.indexOf("Journal") > open.indexOf("Late essay"));
  check("a late piece says so", /marked late/.test(open));
  // \b matters: /0 pts/ matches inside "20 pts".
  check("no point value shows no points, never 0 pts",
    !/\b0 pts/.test(open) && /20 pts/.test(open));

  // THREE STATES, THREE SENTENCES. "we did not look" and "you are fine" are not
  // the same fact and must not render the same.
  wpGradeOpen("S2");
  check("a class with nothing missing says exactly that",
    /Nothing missing in this class\./.test(__el.innerHTML));

  // Render a dashboard whose sync has NOT run, which is what the modal reads.
  render({ rows, available: true });
  wpGradeOpen("S1");
  check("before the sync, the modal says NO DATA YET, not 'nothing missing'",
    /No data yet\./.test(__el.innerHTML) && !/Nothing missing/.test(__el.innerHTML),
    "an empty box cannot tell a student which of the two is true");
}

console.log("\n10. The dot means new since you last looked");
{
  const MISSING = {
    available: true,
    bySection: { S1: [{ assignmentSectionId: "n1", name: "New thing", dueDate: "2026-08-30", pointsPossible: 5 }] },
  };
  const rows = [{ courseName: "Algebra", currentGrade: "B", currentPercent: 86, sectionId: "S1" }];
  const grades = { rows, available: true, missingWork: MISSING };

  __store.clear();
  check("unseen work shows a dot on the row", /wp-rowdot/.test(wpDashboard(FULL, sched([]), grades)));
  check("and on the panel head, so it reads without opening a class",
    /wp-headdot/.test(wpDashboard(FULL, sched([]), grades)));

  wpGradeOpen("S1");
  const after = wpDashboard(FULL, sched([]), grades);
  check("opening the course clears both", !/wp-rowdot/.test(after) && !/wp-headdot/.test(after));
  check("but the count stays, because the work is still missing", /wp-rowbadge">1</.test(after));
}

console.log("\n11. Grades wear a band, and an unposted grade wears none");
{
  // The letter wins when there is one: a school can set its own cut points, and
  // a percentage bucketed here would quietly disagree with the mark beside it.
  check("A bands green", wpGradeTone("A", 94) === "a");
  check("F bands red", wpGradeTone("F", 41) === "f");
  check("A- bands with A, which is what a student means by 'an A'", wpGradeTone("A-", null) === "a");
  check("B+ bands with B", wpGradeTone("B+", null) === "b");
  check("the letter wins over a percent that disagrees with it",
    wpGradeTone("A", 55) === "a",
    "the school's cut points are the school's, not this file's");

  // Percent only when there is no letter to read.
  check("90 with no letter is an A band", wpGradeTone(null, 90) === "a");
  check("89 is a B", wpGradeTone(null, 89) === "b");
  check("59 is an F", wpGradeTone(null, 59) === "f");

  // THE ONE THAT MATTERS.
  check("nothing posted gets NO band", wpGradeTone(null, null) === null,
    "red on an unmarked class tells a child they are failing something nobody has graded");
  check("an empty string is not a grade", wpGradeTone("", null) === null);
  check("a narrative or pass/fail mark gets no band rather than a guessed one",
    wpGradeTone("Pass", null) === null && wpGradeTone("INC", null) === null);

  const rows = [
    { courseName: "Algebra", currentGrade: "A", currentPercent: 94, sectionId: "S1" },
    { courseName: "History", currentGrade: "F", currentPercent: 41, sectionId: "S2" },
    { courseName: "Art", currentGrade: null, currentPercent: null, sectionId: "S3" },
  ];
  const out = wpDashboard(FULL, sched([]), { rows, available: true });
  check("the band reaches the markup", /wp-grade-a/.test(out) && /wp-grade-f/.test(out));
  // "Not posted" renders through its own branch and never reaches the band
  // code at all, which is the right shape: there is no grade to colour. What
  // matters is that it comes out UNBANDED, so assert that rather than assert a
  // class it was never going to carry.
  const artRow = out.slice(out.indexOf("Art"), out.indexOf("Art") + 400);
  check("the unposted course is not banded at all",
    /Not posted/.test(artRow) && !/wp-grade-[abcdf]\b/.test(artRow),
    "red on an unmarked class is the failure this whole portal is written against");
  check("wp-grade-none exists for a real mark that has no band",
    /wp-grade-none/.test(wpDashboard(FULL, sched([]), {
      rows: [{ courseName: "PE", currentGrade: "Pass", currentPercent: null, sectionId: "S9" }],
      available: true,
    })));
  check("the letter is still printed, so colour is never the only signal",
    />A</.test(out) && />F</.test(out));
}

console.log("\n12. The desk view drops the ID card");
{
  const out = wpDashboard(FULL, sched([]), grades([]), {
    studentId: { available: true, value: "12217" },
    hallPass: { available: false },
  });
  check("no Student ID panel on the desk", !/Student ID/.test(out),
    "a barcode is for holding to a scanner, which is a phone errand");
  check("and no barcode element is left behind", !/wpDashBarcode/.test(out));
  const src = readFileSync(new URL("./script.js", import.meta.url), "utf8");
  check("the drawing function went with it", !/function wpDashBarcode/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
