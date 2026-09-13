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
//
// BUILT THROUGH A HELPER so the same region can be evaluated twice: once as it
// ships, and once with WP_HALL_PASS_REQUEST forced true. Without the second
// build, every assertion about the hidden hall pass panel is an absence, and
// an absence is equally satisfied by the panel having been deleted - so the
// day somebody turns passes back on would be the day they find out.
const PRELUDE = `const wpEsc = (v) => String(v == null ? "" : v)
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
   globalThis.__el = __el; globalThis.__store = __store;\n`;

const DESK = slice("/* ---- the desk dashboard ---", "/* ---- end desk dashboard ---- */");
const build = (deskSrc) => new Function(PRELUDE + deskSrc +
  "\nreturn { wpDashboard, wpGradeOpen, wpGradeTone, wpUnseenTotal, __el, __store };")();

const { wpDashboard, wpGradeOpen, wpGradeTone, __el, __store } = build(DESK);

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
// "Tickets" and "What you have earned" were removed 2026-09-08 with the Raffle
// panels they named -- ticket sources, and jackpot draw entries. The school
// launched on Wildcat Cash, so a student's own screen was leading with figures
// from a system nobody had switched on. student-portal-cash.test.mjs covers
// what replaced them.
// "Your Wildcat Cash" left this list on 2026-09-10, when the school asked for
// the four Wildcat Cash cards to become one. Its CONTENT did not leave -- the
// recent movements moved into the single card -- so the checks below prove the
// consolidation rather than accepting a panel that simply disappeared.
for (const panel of ["Wildcat Cash", "Grades", "Schedule", "Attendance"]) {
  check(`the ${panel} panel is rendered`, full.includes(">" + panel + "<"));
}
check("the separate Your Wildcat Cash panel is gone", !full.includes(">Your Wildcat Cash<"));
check("and its movements moved into the one card, not out of the app",
  full.includes("wp-cash-activity") && full.includes("Recent activity"));
check("the one card carries the balance", full.includes("wp-cash-balance"));
check("what they earned", full.includes("Earned all year"));
check("and what they spent", full.includes(">Spent<"));
check("no raffle panel survives",
  !full.includes(">Tickets<") && !full.includes(">What you have earned<"));
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
// The ticket stat this checked is gone with the Raffle panels. The rule it
// protects is not, and zeroCash below is the fixture that actually carries a
// real zero -- `missing` is the all-null fixture, deliberately, and asserting
// a zero against it was asserting the opposite of what it exists to prove.
const zeroCash = wpDashboard({ points: {}, wildcatCash: { balance: 0, earned: 0, spent: 0 }, attendance: {} },
  sched([]), grades([]));
check("a real zero still renders as a figure, not as an absence",
  zeroCash.includes("$0"),
  "a student who has genuinely earned none must see $0, not 'not on file'");
check("a balance of exactly zero is $0.00, not an absence", zeroCash.includes("$0.00"));
// ASSERTED DIRECTLY, not by counting. This used to compare how many stats
// carried is-none across the two fixtures, which was a proxy for the rule and
// stopped being one the moment the desk panels stopped repeating their tiles:
// the Wallet card gave up its Balance figure and Attendance gave up Absent
// this term, so both fixtures lost is-none stats and the two counts met. The
// rule itself never changed, so it is now written down as itself, from both
// sides. A stat marked missing prints "not on file" and NEVER a figure.
check("and is not marked as missing",
  !/class="wp-stat is-none"><span class="wp-stat-n">\$/.test(zeroCash) &&
  /class="wp-stat is-none"><span class="wp-stat-n">not on file/.test(missing),
  "a real $0.00 must never be typeset as an absence, and a null must never be typeset as a figure");

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
// SEARCHED INSIDE THE SCHEDULE PANEL, not across the whole page.
//
// This looked for the bare words "First", "Middle", "Last" anywhere in the
// rendered dashboard, and the leaderboard added on 2026-09-10 put a "Middle
// School" tab above the schedule -- so "Middle" was found in a button, the
// order looked wrong, and a correctly sorted schedule failed. The panel the
// assertion is about is the one it should read.
const schedulePanel = (() => {
  const panels = order.split("<article").filter((p) => /wp-panel-title[^<]*>Schedule</.test(p)
    || />Schedule</.test(p));
  return panels.length ? panels[0] : order;
})();
check("the schedule panel was located, not the whole page",
  schedulePanel.length > 0 && schedulePanel.length < order.length);
const seq = ["First", "Middle", "Last", "Lunch"].map((n) => schedulePanel.indexOf(n));
check("every course was found in it", seq.every((i) => i !== -1));
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

console.log("\n12. A student with no pass is offered nothing while the request is hidden");
{
  // THE OUTAGE THIS EXISTS TO PREVENT. passCard:mine ends its hall pass block
  // `live ? { available: true, ... } : { available: false, state: "none" }`.
  // The desk panel read that false as "the lookup failed" and printed
  // "Unavailable / Your pass could not be looked up just now" instead of the
  // Request button. Since almost every student is in class almost all of the
  // time, that was every student, every period: the one screen whose whole
  // purpose is asking for a pass could not ask for one.
  //
  // It shipped because the fixture below used to be `{ available: false }` and
  // nothing asserted what came out of it.
  const none = wpDashboard(FULL, sched([]), grades([]), {
    hallPass: { available: false, state: "none" },
  });
  // HIDDEN 2026-09-13, see WP_HALL_PASS_REQUEST in script.js. A student who
  // cannot ask for a pass is offered NOTHING rather than a teaser, so these
  // now prove the panel is gone. The outage comment above stays because the
  // bug it records is what the flag must not reintroduce when it flips back:
  // the branch that returns has to be the one with the button in it.
  check("with the request hidden, no Hallway panel is drawn at all",
    !/openHallPassSheet\(\)/.test(none) && !/Hall pass/.test(none));
  check("and no empty shell is left behind either",
    !/None active/.test(none) && !/No pass right now/.test(none));
  check("still does not claim the lookup failed",
    !/could not be looked up/.test(none) && !/Unavailable/.test(none));

  // The shapes an older or partial payload can take. Same answer: nothing.
  check("a missing hallPass key draws no panel",
    !/openHallPassSheet\(\)/.test(wpDashboard(FULL, sched([]), grades([]), {})));
  check("a bare available:false, with no state, draws no panel",
    !/openHallPassSheet\(\)/.test(
      wpDashboard(FULL, sched([]), grades([]), { hallPass: { available: false } })));

  // POSITIVE OFF-PATH CHECK. Every assertion above is an absence, and an
  // absence is equally satisfied by the panel having been DELETED. This is
  // what tells the difference between hidden and gone, so that flipping the
  // flag back on in a month restores a panel that still exists.
  const deskSrc = src.slice(src.indexOf("/* ---- the desk dashboard ---"),
                            src.indexOf("/* ---- end desk dashboard ---- */"));
  check("the panel it will draw again is still written down",
    /No pass right now\. Ask for one/.test(deskSrc) && /openHallPassSheet\(\)/.test(deskSrc));
  check("and it is one flag away, not a rewrite",
    /const WP_HALL_PASS_REQUEST = false;/.test(deskSrc));

  // A REAL refusal is still honoured, and is still not a button. The server
  // does not send one today; if it ever does, a student must not be handed a
  // control that cannot work.
  const broken = wpDashboard(FULL, sched([]), grades([]), {
    hallPass: { available: false, reason: "Passes are turned off during testing." },
  });
  check("a server-stated reason is printed instead of the button",
    /Passes are turned off during testing/.test(broken) && !/openHallPassSheet/.test(broken));
  check("and that one does say Unavailable", /Unavailable/.test(broken));

  // A running pass must not grow a second Request button underneath it.
  const live = wpDashboard(FULL, sched([]), grades([]), {
    hallPass: { available: true, state: "approved", sentTo: "Office", clockLimitMinutes: 8 },
  });
  check("a live pass shows its detail, not a request button",
    !/openHallPassSheet/.test(live) && /Office/.test(live));

  // The phone card is the reference reading; the desk copy is what drifted.
  // SLICED TO THE FUNCTION, because this exact expression is also QUOTED in a
  // comment on the desk panel, so testing the whole file passed on the prose
  // and would have kept passing with the code gone.
  const phoneCard = src.slice(src.indexOf("function wpHallPassCard(hp) {"),
                              src.indexOf("function wpStudentIdCard("));
  check("the phone card reads available:false the same way",
    phoneCard.length > 200 && /if \(!live \|\| state === 'none'\)/.test(phoneCard),
    "two screens must not tell a student different things about the same field");
}

console.log("\n13. The desk view drops the ID card");
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

console.log("\n14. The hall pass request is hidden by one flag, and it flips back");
{
  const DECL = "const WP_HALL_PASS_REQUEST = false;";
  check("the flag is declared exactly once, and is off",
    src.split(DECL).length - 1 === 1);
  check("only the declaration assigns it, so there is one source of truth",
    (src.match(/WP_HALL_PASS_REQUEST\s*=[^=]/g) || []).length === 1);
  check("it is declared inside the region this file evaluates", DESK.includes(DECL),
    "a flag outside the desk markers throws ReferenceError under new Function");

  // THE FLIP-BACK, EXECUTED. Same region, same fixtures, flag forced on: the
  // panel has to come back, in its documented first position, with the button
  // in it. This is the assertion that makes "hidden" different from "deleted".
  const ON = build(DESK.replace(DECL, "const WP_HALL_PASS_REQUEST = true;"));
  const noneOn = ON.wpDashboard(FULL, sched([]), grades([]), {
    hallPass: { available: false, state: "none" },
  });
  check("flipped on, a student with no pass is offered one again",
    /openHallPassSheet\(\)/.test(noneOn));
  check("and it reads as None active, as it always did", /None active/.test(noneOn));
  check("and it does not claim the lookup failed",
    !/could not be looked up/.test(noneOn) && !/Unavailable/.test(noneOn));
  // Its documented slot: first term of the return, so top of column one and
  // above the fold on a 1366x768 Chromebook.
  check("flipped on, the Hallway panel is the FIRST panel again",
    noneOn.indexOf("Hall pass") < noneOn.indexOf("Wildcat Cash"));

  // And with it hidden, the balance inherits that guaranteed slot.
  const noneOff = wpDashboard(FULL, sched([]), grades([]), {
    hallPass: { available: false, state: "none" },
  });
  check("hidden, the balance opens the screen instead",
    noneOff.indexOf("Wildcat Cash") >= 0 &&
    noneOff.indexOf("Wildcat Cash") < noneOff.indexOf("Grades"));
  check("and no blank first panel is left where the pass was",
    !/^\s*<section[^>]*>\s*<\/section>/.test(noneOff));

  // A pass a TEACHER opened is never hidden. The gate is "can a student ask",
  // never "is there a pass": a student must always be able to see a clock that
  // is running against them.
  const liveOff = wpDashboard(FULL, sched([]), grades([]), {
    hallPass: { available: true, state: "approved", sentTo: "Office", clockLimitMinutes: 8 },
  });
  check("a running pass still shows while the request is hidden",
    /Office/.test(liveOff) && /Hall pass/.test(liveOff));
  check("and still grows no request button under it", !/openHallPassSheet/.test(liveOff));

  // The server is the door; this flag is only the button. Both have to agree
  // or a student gets a control that throws.
  const rules = readFileSync(new URL("./convex/hallPassRules.ts", import.meta.url), "utf8");
  check("the server-side switch exists and is off too",
    /export const STUDENT_PASS_REQUESTS_OPEN = false;/.test(rules));
  check("canRequest checks it before any rule",
    /if \(!STUDENT_PASS_REQUESTS_OPEN\)/.test(rules));
  check("and the rules themselves stay testable through canRequestWhenOpen",
    /export function canRequestWhenOpen\(/.test(rules));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
