// Absence broken down by period, and the click that opens it. Run: npm test
//
// WHY THIS FEATURE EXISTS, so the assertions have a point. Attendance Watch's
// row says a child missed six days and cannot say whether that is six days out
// of school or six mornings they arrived after Promise Time. Measured
// 2026-09-21 across all 618 students: of 10,719 absent period-days, 3,753
// (35%) are Promise Time -- the advisory block at each end of the day --
// against 5,519 for all six academic periods combined, and the average flagged
// day covers 3.89 of about six blocks. The school's own highest-absence
// student misses Promise Time AM on all 23 of their absent days and their
// academic classes on 7 to 14 of them.
import { readFileSync } from "node:fs";
import ts from "typescript";

const js = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const script = js("./script.js");
const html = js("./index.html");
const css = js("./styles.css");
const statsSrc = js("./convex/sisStats.ts");
const actionSrc = js("./convex/sisAction.ts");
const listSrc = js("./convex/attendanceList.ts");
const schemaSrc = js("./convex/schema.ts");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

new Function(js("./wildcat-roster.js"))();
const R = globalThis.WildcatRoster;

console.log("\nthe period labels come from the existing translator");

// SLOT_MAP is the app's one slot-to-period translator, already pinned by two
// other test files and already on screen in two dropdowns. The new view must
// call it rather than write a second mapping that can drift.
check("classifySection is available to the view", typeof R.classifySection === "function");
{
  const c = (expr, course) => R.classifySection({ period: expr, courseName: course });
  // The owner's bell schedule independently confirms this mapping: their
  // Periods 1/3/5 run Mon/Thu and are slots 2/4/6; Periods 2/4/6 run Tue/Fri
  // and are slots 3/5/7.
  check("slot 2 is Period 1", c("2(A-E)", "English 7A").label.indexOf("Period 1") === 0);
  check("slot 4 is Period 3", c("4(A-E)", "Art 1A").label.indexOf("Period 3") === 0);
  check("slot 6 is Period 5", c("6(A-E)", "Spanish 1A").label.indexOf("Period 5") === 0);
  check("slot 3 is Period 2", c("3(A-E)", "Math 7A").label.indexOf("Period 2") === 0);
  check("slot 7 is Period 6", c("7(A-E)", "World History A").label.indexOf("Period 6") === 0);
  // AM and PM Promise Time carry the SAME course name, so only the slot tells
  // them apart -- a name-based rule would render two rows that look identical.
  check("slot 1 is Promise Time AM", c("1(A-E)", "Promise Time 6A").label === "Promise Time (AM)");
  check("slot 10 is Promise Time PM", c("10(A-E)", "Promise Time 6A").label === "Promise Time (PM)");
  check("and the two are distinguishable at all",
    c("1(A-E)", "Promise Time 6A").label !== c("10(A-E)", "Promise Time 6A").label);
  check("slot 8 is Power Up", c("8(A-E)", "Power Up 10A").label === "Power Up");
  // Slot 9 is NOT in SLOT_MAP. Measured: it holds Power Up for grades 6-8 plus
  // ELD and RSP, so the course-name fallback must name it and must NOT call it
  // a period it does not occupy.
  check("slot 9 Power Up is named by its course, not given a period number",
    c("9(A-E)", "Power Up 6A").label === "Power Up" && c("9(A-E)", "Power Up 6A").period === null);
  check("slot 9 ELD falls back to its own name rather than a period",
    !/Period/.test(c("9(A-E)", "Designated ELD 3A").label));
  check("every classification keeps the raw slot, so a wrong mapping is visible",
    c("6(A-E)", "Spanish 1A").slot === 6 && c("9(A-E)", "RSP A").slot === 9);
}

console.log("\nthe view body, run as a pure function");

// renderAttendanceDetail takes the server's answer and returns markup, so it
// runs with no DOM and no network. That is the point: the uniform screen's
// dead-zone crash got past 98 text-matching assertions.
const renderDetail = (() => {
  const start = script.indexOf("function renderAttendanceDetail(res, R)");
  const end = script.indexOf("\n        // ========================================\n        // EARLY WARNING", start);
  const src = script.slice(start, end);
  return new Function("escapeHtml", `${src}\nreturn renderAttendanceDetail;`)(
    (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  );
})();
check("the view body lifted and built", typeof renderDetail === "function");

const sec = (expr, course, absent, o) => ({
  sectionExpression: expr, courseName: course, sectionNumber: "1",
  daysAbsent: absent, daysTardy: 0, attendanceRows: absent === null ? 0 : absent + 3,
  lastAbsenceDate: "2026-09-18", ...o,
});
const answer = (over) => ({
  allowed: true, reason: null, studentNumber: "1001",
  day: { daysAbsentYtd: 23, daysAbsentTerm: 23, daysTardyTerm: 9, syncedAt: "2026-09-21T13:00:00.000Z" },
  rows: [
    sec("1(A-E)", "Promise Time 6A", 23),
    sec("2(A-E)", "Common Core Math 6A", 14),
    sec("10(A-E)", "Promise Time 6A", 14),
    sec("6(A-E)", "Enrichment 6A", 7),
  ],
  sectionRows: 4, ...(over || {}),
});

{
  let out = "", threw = null;
  try { out = renderDetail(answer(), R); } catch (e) { threw = e; }
  check("IT RUNS WITHOUT THROWING", threw === null, threw && (threw.message || String(threw)));
  check("the day count is shown", /23<\/span><span class="wc-ad-l">days absent/.test(out));
  check("the tardy count is shown", /9<\/span><span class="wc-ad-l">days tardy/.test(out));
  // THE RECONCILIATION is the reason for the screen: 23 days against 58
  // period-absences is 2.5 periods a day, not a whole day.
  check("the periods-missed total is the sum of the rows", /58<\/span><span class="wc-ad-l">periods missed/.test(out), out.slice(0, 400));
  check("periods per absent day is computed and shown", /2\.5<\/span><span class="wc-ad-l">periods per absent day/.test(out));
  check("Promise Time AM and PM are told apart on screen",
    /Promise Time \(AM\)/.test(out) && /Promise Time \(PM\)/.test(out));
  check("the academic period gets its spoken name", /Period 1/.test(out) && /Period 5/.test(out));
  check("the raw slot rides along on every row", /wc-ad-slot">1\(A-E\)/.test(out) && /wc-ad-slot">10\(A-E\)/.test(out));
  check("worst period first", out.indexOf("Promise Time (AM)") < out.indexOf("Enrichment"));
  check("NO PERCENTAGE ANYWHERE, because no denominator exists", !/%/.test(out), "a rate here would be invented");
  check("and it says why in words", /no per-period percentage/.test(out));
  check("the sync time is stated", /synced 2026-09-21/.test(out));
}
{
  // A single missed period per absent day is the case the whole feature is for.
  const out = renderDetail(answer({
    day: { daysAbsentYtd: 8, daysAbsentTerm: 8, daysTardyTerm: 0, syncedAt: "x" },
    rows: [sec("1(A-E)", "Promise Time 6A", 8), sec("2(A-E)", "Math", 0)],
  }), R);
  check("a one-period-a-day pattern is called out as such", /SINGLE PERIOD/.test(out), out.slice(0, 300));
  check("and it says the student was in school for most of them", /in\s*school for most of them/.test(out));
}
{
  const out = renderDetail(answer({
    day: { daysAbsentYtd: 10, daysAbsentTerm: 10, daysTardyTerm: 0, syncedAt: "x" },
    rows: [1, 2, 3, 4, 5, 6].map((i) => sec(`${i}(A-E)`, "C" + i, 10)),
  }), R);
  check("a whole-day pattern is called out as whole days", /WHOLE DAYS/.test(out));
}
{
  // NEVER TAKEN IS NOT ZERO. 1,631 of 5,563 measured rows are in this state.
  const out = renderDetail(answer({
    rows: [sec("2(A-E)", "PE 6A", null, { attendanceRows: 0, daysAbsent: 0 })],
  }), R);
  check("a section nobody took attendance in does NOT read as 0 absences",
    /not taken/.test(out) && /never taken in this class/.test(out));
  check("and it is marked so it cannot be skimmed as clean", /wc-ad-unknown/.test(out));
}
{
  const out = renderDetail({ allowed: false, reason: "Not your access level." });
  check("a refusal prints the server's reason", /Not your access level\./.test(out));
  const out2 = renderDetail(answer({ rows: [], sectionRows: 0 }), R);
  check("no synced sections yet says so rather than rendering an empty list",
    /No per-period attendance has been synced/.test(out2));
  const out3 = renderDetail({ allowed: true, reason: "This student has no PowerSchool number on file." });
  check("a student with no SIS number gets the reason, not an empty screen",
    /no PowerSchool number on file/.test(out3));
}
{
  // Names come from PowerSchool, so a course name is not fully trusted.
  const out = renderDetail(answer({
    rows: [sec("2(A-E)", '<img src=x onerror=alert(1)>', 4)],
  }), R);
  check("a hostile course name is escaped, not injected",
    !/<img src=x/.test(out) && /&lt;img src=x/.test(out));
}

console.log("\nthe click now opens absence, not the raffle profile");

check("the Attendance Watch row calls openAttendanceDetail",
  /const openable = ' onclick="openAttendanceDetail\(/.test(script));
// Scoped to the two RANKED-LIST row builders. openStudentProfile is still the
// right destination from the student list and the cash screens; what changed is
// only what an attendance row opens.
check("neither ranked list opens the raffle profile any more",
  [script.indexOf("async function renderAttendanceWatch"), script.indexOf("async function renderEarlyWarning")]
    .every((i) => !/onclick="openStudentProfile\(/.test(script.slice(i, i + 9000))),
  "the profile is reachable from a button inside the new view instead");
check("Early Warning opens the same screen, so one child has one destination",
  (script.match(/onclick="openAttendanceDetail\(/g) || []).length === 2);
// st.id is absent for any student whose PowerSchool number does not match a
// local record. Their row used to look clickable, take focus, and do nothing.
check("the row passes studentNumber, not the app's roster id",
  /openAttendanceDetail\('' \+\s*\n?\s*escapeHtml\(String\(st\.studentNumber/.test(script)
  || /escapeHtml\(String\(st\.studentNumber \|\| ''\)\)/.test(script));
check("so a student with no app record is no longer silently unclickable",
  !/st\.id \? ' onclick/.test(script));
check("the profile is still reachable from the new view",
  /openStudentProfile\(st\.id\)/.test(script));
check("the view opens through the dialog that handles Escape, backdrop and Back",
  /_wcDialog\(\{[\s\S]{0,400}?wide: true/.test(script));
check("every class the view renders is defined in the stylesheet",
  ["wc-ad-figs", "wc-ad-fig", "wc-ad-n", "wc-ad-l", "wc-ad-read", "wc-ad-list", "wc-ad-row",
   "wc-ad-per", "wc-ad-slot", "wc-ad-abs", "wc-ad-sub", "wc-ad-unknown", "wc-ad-note"]
    .every((c) => css.includes("." + c)),
  ["wc-ad-figs", "wc-ad-fig", "wc-ad-n", "wc-ad-l", "wc-ad-read", "wc-ad-list", "wc-ad-row",
   "wc-ad-per", "wc-ad-slot", "wc-ad-abs", "wc-ad-sub", "wc-ad-unknown", "wc-ad-note"]
    .filter((c) => !css.includes("." + c)).join(","));
check("the absence figures are NOT count-up animated",
  !/wcCountUp[\s\S]{0,200}wc-ad-n/.test(script),
  "this screen is read aloud with the student present");

console.log("\nthe server side");

check("the per-student query exists", /export const studentPeriods = query\(/.test(listSrc));
check("it is gated to the same three roles as the ranking",
  /ATTENDANCE_ROLES\.includes\(staff\.role\)/.test(listSrc.slice(listSrc.indexOf("studentPeriods"))));
check("it never queries an empty student key",
  /const key = String\(studentNumber \|\| ""\)\.trim\(\);[\s\S]{0,200}if \(!key\)/.test(listSrc));
check("it sends no name, grade or demographic",
  !/firstName|lastName|studentName|gradeLevel|raceCodes/.test(listSrc.slice(listSrc.indexOf("studentPeriods"))));
check("it returns no rate or percentage", !/percent|rate/i.test(
  listSrc.slice(listSrc.indexOf("export const studentPeriods"))
    .replace(/\/\*[\s\S]*?\*\//g, "")));
check("attendanceRows crosses the wire, so never-taken stays distinguishable",
  /attendanceRows: typeof r\.attendanceRows === "number"/.test(listSrc));
check("a missing figure is null via dayCount, never 0",
  /daysAbsent: dayCount\(r\.daysAbsent\)/.test(listSrc));
check("reads are capped", /\.take\(40\)/.test(listSrc.slice(listSrc.indexOf("studentPeriods"))));

check("the table is declared with a by_studentNumber index",
  /psAttendanceBySection: defineTable\(/.test(schemaSrc)
  && /\.index\("by_studentNumber", \["studentNumber"\]\)/.test(
      schemaSrc.slice(schemaSrc.indexOf("psAttendanceBySection"))));
check("the writer exists and replaces wholesale",
  /export const replaceAttendanceBySection = internalMutation\(/.test(statsSrc)
  && /clearFirst: v\.optional\(v\.boolean\(\)\)/.test(statsSrc.slice(statsSrc.indexOf("replaceAttendanceBySection"))));
{
  // Convex allows 4,096 reads per call and the measured table is ~5,563 rows,
  // so the clear pages. collect() here is what broke the grade sync.
  const w = statsSrc.slice(statsSrc.indexOf("replaceAttendanceBySection"),
                           statsSrc.indexOf("export const", statsSrc.indexOf("replaceAttendanceBySection") + 40));
  check("the clear pages instead of collecting", /\.take\(2000\)/.test(w) && !/\.collect\(\)/.test(w));
  check("and reports that more remains", /moreToClear: true/.test(w));
  // A field in the schema and missing from the validator fails the WHOLE sync
  // at the boundary.
  const tbl = schemaSrc.slice(schemaSrc.indexOf("psAttendanceBySection: defineTable({"),
                              schemaSrc.indexOf(".index(\"by_studentNumber\"", schemaSrc.indexOf("psAttendanceBySection")));
  const fields = [...tbl.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((m) => m[1]);
  const missing = fields.filter((f) => f !== "syncedAt" && !new RegExp("\\b" + f + ":").test(w));
  check("the writer's validator lists every field the table declares", missing.length === 0, missing.join(","));
}
{
  const blk = actionSrc.slice(actionSrc.indexOf("// ---- ABSENCE BY PERIOD"),
                              actionSrc.indexOf("attendanceSectionRows.slice(i, i + 200)") + 60);
  check("the sync pulls it with its own try/catch", /attendanceBySectionError = e instanceof Error/.test(blk));
  check("and the write is gated on that error being null",
    /if \(attendanceBySectionError === null\)/.test(actionSrc));
  // Comments stripped first: the block's own comment EXPLAINS the yearid trap,
  // so a naive search for the word fails on the documentation of the fix.
  const code = blk.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("it passes termid and NOT yearid", /termid,/.test(code) && !/yearid/.test(code),
    "attendance_by_section declares schoolid and termid only; both together answers HTTP 400");
  check("it chunks at 200 like every other write", /i \+= 200/.test(blk));
  check("absent figures stay undefined rather than 0",
    /daysAbsent: n\(r\.days_absent_section_term\)/.test(blk) && !/\?\? 0/.test(blk));
  check("an unkeyed row is dropped", /\.filter\(\(r\) => r\.studentNumber\)/.test(blk));
  check("the sync summary names the row count and the error",
    /attendanceBySectionRows: attendanceSectionRows\.length/.test(actionSrc)
    && /attendanceBySectionError,/.test(actionSrc));
  // namedQuery stops at MAX_PAGES silently, so a table that outgrows it would
  // sync short and look complete. 5,563 rows is 56 pages today.
  check("page exhaustion is reported rather than silent",
    /attendanceBySectionPagedOut: attendanceBySectionPages >= 200/.test(actionSrc));
}

console.log(`\nper-period attendance: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
