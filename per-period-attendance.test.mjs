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
    // BOTH Promise Times are needed to bound anything -- they are the only
    // blocks that meet every day. Absent from AM on all 8, present for PM on
    // all 8, so no day can be a full day.
    rows: [sec("1(A-E)", "Promise Time 6A", 8), sec("10(A-E)", "Promise Time 6A", 0),
           sec("2(A-E)", "Math", 0)],
  }), R);
  // The bound replaced a heuristic sentence that guessed from the
  // periods-per-day average. NONE-can-be-a-full-day is provable; "almost all
  // are a single period" was not.
  check("a one-period-a-day pattern is stated as a PROOF, not an impression",
    /NONE of these 8 absent days can be a full day/.test(out), out.slice(0, 400));
  check("and the ceiling figure reads zero", /&le;0<\/span><span class="wc-ad-l">full days at most/.test(out));
}
{
  const out = renderDetail(answer({
    day: { daysAbsentYtd: 10, daysAbsentTerm: 10, daysTardyTerm: 0, syncedAt: "x" },
    rows: [1, 2, 3, 4, 5, 6, 10].map((i) => sec(`${i}(A-E)`, "C" + i, 10)),
  }), R);
  check("a whole-day pattern says all of them could be full days",
    /Up to all 10 of these days could be full days/.test(out), out.slice(0, 400));
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
  // SILENCE IS NOT PRESENCE. With no Promise Time attendance taken there is no
  // every-day anchor, so no bound is offered at all rather than a wrong one.
  // 137 of 679 students are in this position.
  const out = renderDetail(answer({
    rows: [sec("1(A-E)", "Promise Time", 0, { attendanceRows: 0 }),
           sec("2(A-E)", "Math", 6)],
  }), R);
  check("no Promise Time attendance means NO full-day bound is offered",
    !/full days at most/.test(out), "a bound without an anchor would be invented");
  check("and it says why instead of going quiet",
    /Attendance was not taken in Promise Time/.test(out), out.slice(0, 500));
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


console.log("\nthe full-day bound, which is a bound and not a count");

// The per-section figures are MARGINALS and cannot be intersected, so an exact
// full-day count does not exist. What does exist: Promise Time meets every day
// (both blocks (A-E), both 618 students, both in all three day patterns), so a
// full day must include both -- the smaller count is a hard ceiling. And the
// totals give an independent one: P >= f*b + (D-f) gives f <= (P-D)/(b-1).
{
  const s2 = (e, a, rows) => ({ sectionExpression: e, courseName: e.startsWith("1(") || e.startsWith("10(") ? "Promise Time 6A" : "Class",
                                daysAbsent: a, daysTardy: 0, attendanceRows: rows === undefined ? a + 3 : rows });
  const B = R.absenceDayBounds, S = R.absenceDaySentence;
  check("the rule is exported", typeof B === "function" && typeof S === "function");

  // The school's real highest-absence student.
  const worst = [["1(A-E)", 23], ["2(A-E)", 14], ["9(A-E)", 14], ["10(A-E)", 14], ["3(A-E)", 13],
                 ["5(A-E)", 9], ["7(A-E)", 9], ["4(A-E)", 8], ["6(A-E)", 7]].map(([e, a]) => s2(e, a));
  const b = B(23, worst, {});
  check("Promise Time anchors the ceiling for the real worst student", b.promiseCeiling === 14);
  check("the totals give an independent, looser ceiling here", b.totalsCeiling === 17);
  check("the TIGHTER of the two wins", b.fullDayCeiling === 14 && b.tighter === "promise");
  check("so at least 9 of their 23 absent days are provably partial", b.partialDayFloor === 9);
  check("and the sentence says at most and at least, never a bare number",
    /At most 14 .* at least 9 were partial/.test(S(b)) && !/^14/.test(S(b)));

  // A pure late arriver: the case the whole feature exists for.
  const late = B(8, [s2("1(A-E)", 8), s2("10(A-E)", 0), s2("2(A-E)", 0)], {});
  check("missing only the block that meets every day gives a ceiling of ZERO", late.fullDayCeiling === 0);
  check("every one of those days is provably partial", late.partialDayFloor === 8);
  check("and the sentence says NONE can be a full day", /NONE of these 8/.test(S(late)));

  // Genuinely out all day.
  const gone = B(5, [1, 2, 3, 4, 6, 10].map((i) => s2(i + "(A-E)", 5)), {});
  check("missing everything on the same days leaves the ceiling at the day count", gone.fullDayCeiling === 5);
  check("and nothing is provably partial", gone.partialDayFloor === 0);
  check("the sentence does not overclaim: 'could be', not 'were'", /could be full days/.test(S(gone)));

  // SILENCE IS NOT PRESENCE.
  const blind = B(6, [s2("1(A-E)", 0, 0), s2("2(A-E)", 6)], {});
  check("a Promise Time with no attendance taken cannot anchor a bound", blind.anchored === false);
  check("no ceiling is invented", blind.fullDayCeiling === null && blind.partialDayFloor === null);
  check("and the refusal names the reason", /only block that meets every day/.test(S(blind)));

  // Degenerate inputs must refuse rather than produce a number.
  check("no absence figure at all refuses", B(null, worst, {}).anchored === false);
  check("a negative absence figure refuses", B(-3, worst, {}).anchored === false);
  check("zero absences is a real, bounded answer", (() => {
    const z = B(0, [s2("1(A-E)", 0), s2("10(A-E)", 0)], {});
    return z.anchored === true && z.fullDayCeiling === 0 && z.partialDayFloor === 0;
  })());
  check("no sections at all refuses rather than guessing", B(4, [], {}).anchored === false);
  // The ceiling can never exceed the number of absent days.
  check("the ceiling is capped by the absent-day count",
    B(3, [s2("1(A-E)", 9), s2("10(A-E)", 9), s2("2(A-E)", 9)], {}).fullDayCeiling === 3);
  check("blocksPerDay is an argument, not a hidden constant",
    B(10, [s2("1(A-E)", 10), s2("10(A-E)", 10), s2("2(A-E)", 10)], { blocksPerDay: 3 }).totalsCeiling
      !== B(10, [s2("1(A-E)", 10), s2("10(A-E)", 10), s2("2(A-E)", 10)], { blocksPerDay: 6 }).totalsCeiling);
  check("a nonsense blocksPerDay falls back rather than dividing by zero",
    Number.isFinite(B(5, [s2("1(A-E)", 5), s2("10(A-E)", 5)], { blocksPerDay: 1 }).totalsCeiling));
  check("the rule reads no global state",
    !/\briskSettings\b|\bstudents\b/.test(
      js("./wildcat-roster.js").slice(js("./wildcat-roster.js").indexOf("function absenceDayBounds"),
        js("./wildcat-roster.js").indexOf("function absenceDaySentence"))));
}


console.log("\nthe per-date verdict: full, partial, or not an absence");

// The owner's rule, 2026-09-21: look at a date, count the blocks that ran, and
// say what kind of day it was. Two decisions of theirs are encoded and both
// are pinned here, because a fix with no test is a fix that comes back.
//   1. One stray present mark among a day of absences reads as a FULL day and
//      is FLAGGED -- more likely a misrecord than a child attending one class.
//   2. A block nobody recorded counts as PRESENT, which understates absence.
{
  const C = (o, s) => R.classifyAbsenceDay(o, s || {});
  const day = (o) => ({ date: "2026-09-14", blocksThatDay: 7, absentBlocks: 0,
                        presentBlocks: 0, unrecordedBlocks: 0, ...o });
  check("the rule and the tally are exported",
    typeof R.classifyAbsenceDay === "function" && typeof R.absenceDayTally === "function");

  check("every block missed is a FULL day",
    C(day({ absentBlocks: 7 })).kind.key === "full");
  check("and it is not flagged, because nothing was overridden",
    C(day({ absentBlocks: 7 })).flagged === false);
  check("nothing missed is NOT AN ABSENCE",
    C(day({ absentBlocks: 0, unrecordedBlocks: 7 })).kind.key === "none");
  check("some missed is a PARTIAL day",
    C(day({ absentBlocks: 3, presentBlocks: 4 })).kind.key === "partial");

  // DECISION 1, the owner's misrecord case, in their own words: "marked
  // present for Period 5 but absent for the rest of the periods".
  const mis = C(day({ absentBlocks: 6, presentBlocks: 1 }));
  check("absent for all but one PRESENT-MARKED block is a FULL day", mis.kind.key === "full");
  check("and it is FLAGGED rather than silently overridden", mis.flagged === true);
  check("and the reason names the judgement", /more likely a misrecord/.test(mis.reason));
  check("two present marks is a genuine PARTIAL, not a misrecord",
    C(day({ absentBlocks: 5, presentBlocks: 2 })).kind.key === "partial");
  check("the misrecord threshold is a setting, not a constant",
    C(day({ absentBlocks: 5, presentBlocks: 2 }), { misrecordAt: 2 }).kind.key === "full"
    && C(day({ absentBlocks: 6, presentBlocks: 1 }), { misrecordAt: 0 }).kind.key === "partial");

  // DECISION 2: unrecorded reads as present, and the day says so.
  const un = C(day({ absentBlocks: 6, unrecordedBlocks: 1 }));
  check("absent for all but one UNRECORDED block is a PARTIAL day", un.kind.key === "partial");
  check("and it is NOT flagged, because nothing was marked present", un.flagged === false);
  check("and it says the unrecorded block is being counted as present",
    /no attendance recorded and are counted as present/.test(un.reason), un.reason);

  // A date on which none of this student's blocks ran is not a school day for
  // them and must not be ranked either way.
  const nb = C(day({ blocksThatDay: 0, absentBlocks: 0 }));
  check("a date with no blocks for this student is neither full nor partial", nb.kind.key === "unknown");
  check("unreadable counts refuse rather than guessing",
    C(day({ blocksThatDay: null, absentBlocks: null })).kind === null);
  check("a negative count refuses", C(day({ absentBlocks: -2 })).kind === null);
  check("more absent than blocks is still just a full day, never over 100%",
    C(day({ blocksThatDay: 5, absentBlocks: 9 })).kind.key === "full");

  // The tally, which is what the screen shows.
  const t = R.absenceDayTally([
    day({ date: "2026-09-14", absentBlocks: 7 }),
    day({ date: "2026-09-15", absentBlocks: 6, presentBlocks: 1 }),
    day({ date: "2026-09-16", blocksThatDay: 10, absentBlocks: 1, unrecordedBlocks: 9 }),
    day({ date: "2026-09-17", absentBlocks: 0, unrecordedBlocks: 7 }),
  ], {});
  check("the tally counts full, partial and not-an-absence separately",
    t.full === 2 && t.partial === 1 && t.none === 1, `${t.full}/${t.partial}/${t.none}`);
  check("absentDays is full plus partial, excluding non-absences", t.absentDays === 3);
  check("the flagged day is counted", t.flagged === 1);
  check("and so is how much rests on the assumed-present decision",
    t.restingOnAssumedPresent === 1, String(t.restingOnAssumedPresent));
  check("full days sort before partial ones", t.dates[0].kind.key === "full" && t.dates[2].kind.key === "partial");
  check("ties break on date, so the list is stable between renders",
    t.dates[0].date === "2026-09-15" && t.dates[1].date === "2026-09-14");
  check("an empty list tallies to zero rather than throwing",
    R.absenceDayTally([], {}).absentDays === 0);
  check("the rule reads no global state",
    !/\bstudents\b|\briskSettings\b/.test(
      js("./wildcat-roster.js").slice(js("./wildcat-roster.js").indexOf("function classifyAbsenceDay"),
        js("./wildcat-roster.js").indexOf("function absenceDayTally"))));
}

console.log("\nthe per-date picture, end to end through the real renderer");

// renderAttendanceDetail is a pure function of (server answer, rules module),
// so these run it directly rather than through the DOM harness above.
{
  const secRow = (e, a) => ({ sectionExpression: e, courseName: /^(1|10)\(/.test(e) ? "Promise Time 6A" : "Class",
                              sectionNumber: "1", daysAbsent: a, daysTardy: 0,
                              attendanceRows: a + 3, lastAbsenceDate: "2026-09-18" });
  const withDays = {
    allowed: true, reason: null, studentNumber: "1001",
    day: { daysAbsentYtd: 3, daysAbsentTerm: 3, daysTardyTerm: 0, syncedAt: "2026-09-21T13:00:00.000Z" },
    rows: [secRow("1(A-E)", 3), secRow("10(A-E)", 2), secRow("2(A-E)", 1)],
    sectionRows: 3, daysTruncated: false,
    days: [
      { date: "2026-09-14", blocksThatDay: 7, absentBlocks: 7, presentBlocks: 0, unrecordedBlocks: 0,
        absentSlots: ["1(A-E)", "2(A-E)", "4(A-E)", "6(A-E)", "8(A-E)", "9(A-E)", "10(A-E)"] },
      { date: "2026-09-15", blocksThatDay: 7, absentBlocks: 6, presentBlocks: 1, unrecordedBlocks: 0,
        absentSlots: ["1(A-E)", "3(A-E)", "5(A-E)", "7(A-E)", "8(A-E)", "10(A-E)"] },
      { date: "2026-09-16", blocksThatDay: 10, absentBlocks: 1, presentBlocks: 0, unrecordedBlocks: 9,
        absentSlots: ["1(A-E)"] },
    ],
  };
  let threw = null, out = "";
  try { out = renderDetail(withDays, R); } catch (e) { threw = e; }
  check("the view renders per-date rows without throwing", threw === null, threw && (threw.message || String(threw)));
  if (!threw) {
    // Plain string matches: a closing tag inside a regex literal needs every
    // slash escaped, and missing one silently terminates the pattern.
    check("the EXACT full-day count replaces the bound",
      out.includes('>2</span><span class="wc-ad-l">full days<'), out.slice(0, 600));
    check("and the partial count sits beside it",
      out.includes('>1</span><span class="wc-ad-l">partial days<'));
    check("no 'at most' bound survives once the dates are known",
      !out.includes("full days at most") && !out.includes("&le;"));
    check("a Day by day section is rendered", out.includes("Day by day"));
    check("each date is named", out.includes("2026-09-14") && out.includes("2026-09-16"));
    check("the verdict is written on the date, in words",
      out.includes("Full day absent") && out.includes("Partial day"));
    check("the flagged misrecord day carries its marker", out.includes("wc-ad-flagged"));
    check("the missed periods are named by their spoken names, not raw slots",
      out.includes("Promise Time (AM)"));
    check("the sentence states both counts",
      /2 of these 3 absent days were full days/.test(out), out.slice(0, 900));
    check("and names the flagged day and the assumption it rests on",
      /reads as a misrecord/.test(out) && /counted as present/.test(out));
    check("a date nobody missed anything on is not listed as a day",
      !out.includes("Not an absence"));
  }
  // No per-date rows yet: the bound must still be there as the fallback.
  const noDays = { ...withDays, days: [] };
  let t2 = null, out2 = "";
  try { out2 = renderDetail(noDays, R); } catch (e) { t2 = e; }
  check("with no per-date rows it falls back to the bound",
    t2 === null && out2.includes("full days at most"), t2 ? String(t2) : out2.slice(0, 300));
  check("and the bound's sentence returns with it",
    out2.includes("At most") || out2.includes("NONE of these"));
}

console.log("\nthe per-date server side");

{
  const schema = js("./convex/schema.ts");
  const stats = js("./convex/sisStats.ts");
  const days = js("./convex/attendanceDays.ts");
  const crons = js("./convex/crons.ts");
  check("psAttendanceDays is declared with a per-student index",
    /psAttendanceDays: defineTable\(/.test(schema)
    && /\.index\("by_student_date", \["studentNumber", "date"\]\)/.test(schema));
  check("the writer replaces wholesale and pages its clear",
    /export const replaceAttendanceDays = internalMutation\(/.test(stats)
    && /\.take\(2000\)/.test(stats.slice(stats.indexOf("replaceAttendanceDays"))));
  check("the build reads which codes mean absent rather than assuming",
    /presence_status_cd\) === "Absent"/.test(days),
    "Ditching is coded Present and Suspended Absent, so a code letter cannot be guessed");
  check("which blocks ran is DERIVED from the data, not transcribed",
    /slotsRan/.test(days) && !/Monday|Tuesday|weekday/i.test(
      days.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")));
  check("cc is scoped to the year's terms, after an unscoped read hit 40,000 rows",
    /termid=ge=\$\{termBase\}/.test(days));
  // The refusal message is built across a template concatenation, so match the
  // behaviour rather than one contiguous sentence.
  check("it REFUSES to write when the slot map is incomplete",
    /unmappedShare > 0\.15/.test(days)
    && /could not be mapped to a/.test(days)
    && /nothing was written/.test(days),
    "a table of confident wrong verdicts is worse than no table");
  check("page exhaustion is reported, never silent", /pagedOut/.test(days));
  check("the pagesize cap of 100 is respected", /pagesize=\$\{PAGE\}/.test(days) && /const PAGE = 100/.test(days));
  check("only dates with an absent block are stored",
    /if \(absentBlocks === 0\) continue;/.test(days));
  check("it writes in 200-row chunks like every other sync block", /i \+= 200/.test(days));
  check("it runs on its own cron, after the SIS sync rather than inside it",
    /absence day rebuild \(morning\)/.test(crons) && /minuteUTC: 30/.test(crons));
  check("the per-student query serves the dates",
    /psAttendanceDays/.test(js("./convex/attendanceList.ts")));
  check("and caps them with a reported flag",
    /daysTruncated: dayRows\.length > DAY_CAP/.test(js("./convex/attendanceList.ts")));
}


console.log("\nthe main tab now carries full days");

{
  const script2 = js("./script.js");
  const html2 = js("./index.html");
  const conv = js("./convex/attendanceList.ts");
  const schema2 = js("./convex/schema.ts");
  const stats2 = js("./convex/sisStats.ts");
  const days2 = js("./convex/attendanceDays.ts");

  // The pure rule, which is where the misrecord threshold is applied.
  const sp = (o) => ({ absentDays: 10, fullDaysStrict: 4, misrecordDaysByGap: [1, 2, 0],
                       partialDays: 3, assumedPresentDays: 2, ...o });
  check("absenceSplit is exported", typeof R.absenceSplit === "function");
  const d1 = R.absenceSplit(sp(), {});
  check("at the shipped threshold, a gap of one counts as a full day",
    d1.fullDays === 5 && d1.flaggedDays === 1, JSON.stringify(d1));
  check("and the rest stay partial", d1.partialDays === 5);
  check("a threshold of two admits the gap-of-two days too",
    R.absenceSplit(sp(), { misrecordAt: 2 }).fullDays === 7);
  check("a threshold of zero admits none of them",
    R.absenceSplit(sp(), { misrecordAt: 0 }).fullDays === 4);
  check("days the threshold rejects are reported, not dropped",
    R.absenceSplit(sp(), { misrecordAt: 0 }).misrecordDaysNotCounted === 3);
  // NULL IN, NULL OUT. Reporting zero full days for a student the rebuild has
  // not covered would be the good news read off missing data.
  check("no split gives null, never a zero", R.absenceSplit(null, {}) === null);
  check("an unreadable split gives null",
    R.absenceSplit({ fullDaysStrict: "4", partialDays: 3, absentDays: 10 }, {}) === null);
  check("a student with absences and no full days reports zero, honestly",
    R.absenceSplit(sp({ fullDaysStrict: 0, misrecordDaysByGap: [0, 0, 0], partialDays: 10 }), {}).fullDays === 0);
  check("fullShare is a share of ABSENT days, not of the year",
    R.absenceSplit(sp({ fullDaysStrict: 5, misrecordDaysByGap: [0, 0, 0], partialDays: 5 }), {}).fullShare === 0.5);

  // The screen.
  check("the row prints the full-day count beside the total",
    /sp\.fullDays \+ ' full'/.test(script2));
  check("the split is looked up beside the ranking, not threaded through it",
    /splitByNumber\[String\(st\.studentNumber/.test(script2),
    "attendanceRanking is pinned by two test files; widening its row shape is the invasive change");
  check("a Full days view exists and ranks by whole days",
    /_attTierFilter === 'fullDays'/.test(script2) && /B\.fullDays - A\.fullDays/.test(script2));
  check("a Never-a-full-day view exists, for the students the rate cannot separate",
    /_attTierFilter === 'partialOnly'/.test(script2) && /sp\.fullDays === 0/.test(script2));
  check("both buttons are in the markup and wired",
    /data-atier="fullDays"/.test(html2) && /data-atier="partialOnly"/.test(html2)
    && /setAttendanceTierFilter\('fullDays'\)/.test(html2)
    && /setAttendanceTierFilter\('partialOnly'\)/.test(html2));
  check("the basis note states the school-wide split",
    /were whole days out of school and/.test(script2));
  // THE ORDERING TRAP: the note is built before splitByNumber exists, so it
  // must read res.rows. Getting this wrong is a temporal dead zone, which is
  // the crash class that shipped from this repo once already.
  check("the note reads res.rows, NOT the later splitByNumber",
    script2.indexOf("splitNote = ' Of '") < script2.indexOf("const splitByNumber = {}"),
    "the note runs first; reading splitByNumber there would be a dead-zone crash");
  // The comment sits ABOVE the declaration, so look at the window around it
  // rather than after it.
  check("and it says so in a comment, so the next edit does not undo it",
    /temporal dead zone/.test(
      script2.slice(Math.max(0, script2.indexOf("let splitNote") - 900),
                    script2.indexOf("let splitNote") + 200)));
  check("a missing rebuild is announced rather than shown as zero full days",
    /not worked out yet; they appear after the next rebuild/.test(script2));

  // The server side.
  check("psAbsenceTotals is declared, one row per student",
    /psAbsenceTotals: defineTable\(/.test(schema2)
    && /\.index\("by_studentNumber", \["studentNumber"\]\)/.test(
        schema2.slice(schema2.indexOf("psAbsenceTotals"))));
  check("it stores components, not a verdict",
    /misrecordDaysByGap: v\.array\(v\.number\(\)\)/.test(schema2)
    && !/fullDays: v\.number/.test(schema2.slice(schema2.indexOf("psAbsenceTotals"),
        schema2.indexOf("psAbsenceTotals") + 1400)));
  check("the writer exists and replaces wholesale",
    /export const replaceAbsenceTotals = internalMutation\(/.test(stats2));
  check("the rebuild derives the totals from the same rows as the dates",
    /replaceAbsenceTotals/.test(days2) && /misrecordDaysByGap\[i\]\+\+/.test(days2));
  check("a gap made of UNRECORDED blocks is a partial day, not a misrecord",
    /r\.presentBlocks >= gap/.test(days2),
    "unrecorded reads as present by decision, so it cannot also be a misrecord");
  check("the school list reads the totals in one go, capped and flagged",
    /psAbsenceTotals"\)\.take\(MAX_ROWS \+ 1\)/.test(conv)
    && /splitTruncated: totalRows\.length > MAX_ROWS/.test(conv));
  check("and reports coverage so null is distinguishable from zero",
    /splitCoverage: totalRows\.length/.test(conv));
}

console.log(`\nper-period attendance: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
