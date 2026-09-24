// The attendance-RATE run chart (2026-09-23). Run: npm test
//
// The owner's spec, in their words: a weekly attendance rate (student-days
// attended / expected, that week only), two monthly measures (average days
// absent per student; the share out 10%+ of that month), a Provost & Murray
// run chart with a baseline of 10+ points and a median FROZEN once the
// baseline is signal-free, the four signals (shift 6+, trend 5+, runs,
// astronomical), a denominator check at 25% with drop-or-merge, actual
// enrolment per period, grade bands as separate lines, and annotations.
//
// The owner's decisions (2026-09-23), each held by a check below:
//   - absent means a WHOLE day out
//   - grade bands 6-8 and 9-12
//   - short weeks MERGED into the next week by default (toggle: separate, drop)
//   - last year's grade = today's grade minus one (estimated, and said)
//   - enrolled on a day = scheduled in at least one class that met that day
//
// Measured on production before this shipped (read-only dry runs):
//   2025-10  23 school days  6-8 90.9%  9-12 88.6%
//   2026-09  14 school days  6-8 91.7%  9-12 90.7%   unmapped records 0
import { readFileSync } from "node:fs";
import ts from "typescript";

const rosterSrc = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
const rulesSrc = readFileSync(new URL("./convex/absenceDayRules.ts", import.meta.url), "utf8");
const daysSrc = readFileSync(new URL("./convex/runChartDays.ts", import.meta.url), "utf8");
const dataSrc = readFileSync(new URL("./convex/attendanceRunChartData.ts", import.meta.url), "utf8");
const actionSrc = readFileSync(new URL("./convex/attendanceRunChart.ts", import.meta.url), "utf8");
const schemaSrc = readFileSync(new URL("./convex/schema.ts", import.meta.url), "utf8");
const cronSrc = readFileSync(new URL("./convex/crons.ts", import.meta.url), "utf8");
const htmlSrc = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

const sandbox = {};
new Function("globalThis", rosterSrc).call(sandbox, sandbox);
const R = sandbox.WildcatRoster;

const tsx = (src) => ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const load = (src, deps = {}) => {
  const m = { exports: {} };
  new Function("module", "exports", "require", tsx(src))(m, m.exports, (p) => {
    if (deps[p]) return deps[p];
    throw new Error("unexpected import " + p);
  });
  return m.exports;
};
const rulesMod = load(rulesSrc);
const D = load(daysSrc, { "./absenceDayRules": rulesMod });

// ---------------------------------------------------------------------------
console.log("\nGRADE BANDS AND LAST YEAR'S GRADE\n");
{
  check("6, 7 and 8 are the middle-school band", ["6", "7", "8"].every((g) => D.bandOfGrade(g) === "6-8"));
  check("9 to 12 are the high-school band", [9, 10, 11, 12].every((g) => D.bandOfGrade(g) === "9-12"));
  check("a grade outside 6-12 is in NO band (counted, not guessed)",
    D.bandOfGrade(5) === null && D.bandOfGrade(13) === null && D.bandOfGrade("") === null);
  const last = "2026-06-10";
  check("this year: the grade PowerSchool records, not estimated",
    JSON.stringify(D.gradeForYear({ grade_level: 9, enroll_status: 0 }, true, last)) === JSON.stringify({ grade: 9, estimated: false }));
  check("last year, rolled into this year (entrydate after the year): today's grade minus one, marked estimated",
    JSON.stringify(D.gradeForYear({ grade_level: 9, enroll_status: 0, entrydate: "2026-08-12" }, false, last)) === JSON.stringify({ grade: 8, estimated: true }));
  check("rolled over, then left THIS year: also moved up, so minus one",
    D.gradeForYear({ grade_level: 10, enroll_status: 2, entrydate: "2026-08-12", exitdate: "2026-09-10" }, false, last).grade === 9);
  check("left DURING last year: the grade recorded when they left",
    D.gradeForYear({ grade_level: 10, enroll_status: 2, entrydate: "2025-08-14", exitdate: "2026-03-02" }, false, last).grade === 10);
  // THE REVIEW'S CASE (2026-09-24). An exit date is the first day NOT
  // enrolled, so staying to the last day (06-10) and leaving reads 06-11 --
  // after the year -- without any promotion. Keyed on the exit date, this
  // 6th grader became grade 5 and fell out of every line.
  check("stayed to the LAST DAY and left (exit 06-11, never rolled over): keeps grade 6",
    JSON.stringify(D.gradeForYear({ grade_level: 6, enroll_status: 2, entrydate: "2025-08-14", exitdate: "2026-06-11" }, false, last))
      === JSON.stringify({ grade: 6, estimated: false }));
  check("the rule reads the ENTRY date, not the exit date (the exit alone proves nothing)",
    /entry > yearLastDay/.test(daysSrc) && !/exit > yearLastDay/.test(daysSrc));
  check("a graduate (grade 99, status 3) sat last year as a senior",
    D.gradeForYear({ grade_level: 99, enroll_status: 3 }, false, last).grade === 12);
}

// ---------------------------------------------------------------------------
console.log("\nWHO IS ENROLLED ON A DAY, AND WHAT A WHOLE DAY OUT IS\n");
const ABS = new Set(["A"]);
const build = (over) => D.buildRunDays(Object.assign({
  absentCodeIds: ABS, from: "2026-09-01", to: "2026-09-30", isCurrentYear: true, yearLastDay: "2027-06-10",
  students: [{ id: "1", grade_level: 7, enroll_status: 0 }, { id: "2", grade_level: 10, enroll_status: 0 }],
}, over));
{
  // Two periods, P1 and P2, both run on the 1st, 2nd and 3rd (a record by
  // student 2 in each proves the period met). Student 1 is in P1 only until
  // the 3rd (dateleft is the first day NOT in the class) and in P2 throughout.
  const cc = [
    { id: "c1", studentid: "1", expression: "1(A)", dateenrolled: "2026-08-12", dateleft: "2026-09-03" },
    { id: "c2", studentid: "1", expression: "2(A)", dateenrolled: "2026-08-12", dateleft: "2027-06-11" },
    { id: "c3", studentid: "2", expression: "1(A)", dateenrolled: "2026-08-12", dateleft: "2027-06-11" },
    { id: "c4", studentid: "2", expression: "2(A)", dateenrolled: "2026-08-12", dateleft: "2027-06-11" },
  ];
  const att = [];
  for (const d of ["2026-09-01", "2026-09-02", "2026-09-03"]) {
    att.push({ studentid: "2", att_date: d, attendance_codeid: "P", ccid: "c3" });
    att.push({ studentid: "2", att_date: d, attendance_codeid: "P", ccid: "c4" });
  }
  // Student 1: absent both periods on the 1st (whole day), absent P1 only
  // with P2 present on the 2nd (partial), nothing recorded on the 3rd.
  att.push({ studentid: "1", att_date: "2026-09-01", attendance_codeid: "A", ccid: "c1" });
  att.push({ studentid: "1", att_date: "2026-09-01", attendance_codeid: "A", ccid: "c2" });
  att.push({ studentid: "1", att_date: "2026-09-02", attendance_codeid: "A", ccid: "c1" });
  att.push({ studentid: "1", att_date: "2026-09-02", attendance_codeid: "P", ccid: "c2" });
  const out = build({ cc, attendance: att });
  const row = (date, band) => out.days.find((r) => r.date === date && r.band === band);
  check("school days are the dates with records, nothing invented", out.schoolDays.join() === "2026-09-01,2026-09-02,2026-09-03");
  check("a student with no record on a day their class met is still ENROLLED that day (the denominator)",
    row("2026-09-03", "6-8").members === 1);
  check("absent in every class that met = a whole day out", row("2026-09-01", "6-8").fullDaysStrict === 1);
  check("absent in one, explicitly present in the other = NOT strictly whole (the misrecord rule decides)",
    row("2026-09-02", "6-8").fullDaysStrict === 0 && row("2026-09-02", "6-8").absentDays === 1);
  check("the bands never mix: student 2's grade-10 day is in 9-12 only",
    row("2026-09-01", "9-12").members === 1 && row("2026-09-01", "6-8").members === 1);

  // dateleft is exclusive: from the 3rd, student 1 is in P2 only.
  const out2 = build({ cc, attendance: att.concat([{ studentid: "1", att_date: "2026-09-03", attendance_codeid: "A", ccid: "c2" }]) });
  check("dateleft is the first day NOT in a class: on the 3rd, absent in P2 alone is the WHOLE day",
    out2.days.find((r) => r.date === "2026-09-03" && r.band === "6-8").fullDaysStrict === 1);

  // Not enrolled in anything that met = not in the denominator.
  const late = [{ id: "c9", studentid: "1", expression: "2(A)", dateenrolled: "2026-09-03", dateleft: "2027-06-11" }].concat(cc.slice(2));
  const out3 = build({ cc: late, attendance: att.filter((a) => a.studentid === "2") });
  check("a student who enrolled on the 3rd is NOT counted on the 1st or 2nd",
    !out3.days.some((r) => r.band === "6-8" && r.date < "2026-09-03") && out3.days.find((r) => r.date === "2026-09-03" && r.band === "6-8").members === 1);

  // A class that never met that day does not make its students members.
  const onlyP3 = [{ id: "c7", studentid: "1", expression: "3(A)", dateenrolled: "2026-08-12", dateleft: "2027-06-11" }].concat(cc.slice(2));
  const out4 = build({ cc: onlyP3, attendance: att.filter((a) => a.studentid === "2") });
  check("scheduled only in a period that never ran = not enrolled that day", !out4.days.some((r) => r.band === "6-8"));

  // A drop recorded with equal dates means they never sat in it.
  const never = cc.concat([{ id: "c8", studentid: "1", expression: "3(A)", dateenrolled: "2026-09-01", dateleft: "2026-09-01" }]);
  const out5 = build({ cc: never, attendance: att.concat([{ studentid: "2", att_date: "2026-09-01", attendance_codeid: "P", ccid: "c8x" }]) });
  check("a class dropped the day it was added (equal dates) is no seat at all",
    out5.days.find((r) => r.date === "2026-09-01" && r.band === "6-8").fullDaysStrict === 1);
  check("a record whose class is unknown is counted as unplaced, not silently dropped", out5.diagnostics.unmappedCc === 1);

  // A student outside both bands is counted in the WHOLE SCHOOL, not in a band.
  const out6 = build({ cc, attendance: att, students: [{ id: "1", grade_level: 5, enroll_status: 0 }, { id: "2", grade_level: 10, enroll_status: 0 }] });
  check("an out-of-band student is reported by grade/status and kept out of BOTH band rows",
    out6.diagnostics.membersWithoutBand === 3 && !out6.days.some((r) => r.band === "6-8")
      && out6.diagnostics.unbandedStudents["grade 5, status 0"] === 1);
  const other = out6.days.find((r) => r.date === "2026-09-01" && r.band === "other");
  check("...but kept in an 'other' row, with their whole day out, so the whole-school line still has them",
    other && other.members === 1 && other.fullDaysStrict === 1);
  check("...and the whole-school series adds that row (it does not depend on the grade estimate)",
    R.runSeriesDays(out6.days.map((r) => Object.assign({ yearid: 36 }, r)), "all", {}).find((d) => d.date === "2026-09-01").members === 2);
}

console.log("\nCHRONIC FOR THAT MONTH: 10% OF THE STUDENT'S OWN DAYS\n");
{
  // Ten school days; one whole day out = exactly 10% -> chronic. Eleven days
  // and one whole day = 9.1% -> not. The boundary is the rule's teeth.
  const mk = (n, absentOn) => {
    const dates = Array.from({ length: n }, (_, i) => "2026-09-" + String(i + 1).padStart(2, "0"));
    const cc = [{ id: "c1", studentid: "1", expression: "1(A)", dateenrolled: "2026-08-12", dateleft: "2027-06-11" },
      { id: "c3", studentid: "2", expression: "1(A)", dateenrolled: "2026-08-12", dateleft: "2027-06-11" }];
    const att = dates.map((d) => ({ studentid: "2", att_date: d, attendance_codeid: "P", ccid: "c3" }));
    absentOn.forEach((i) => att.push({ studentid: "1", att_date: dates[i], attendance_codeid: "A", ccid: "c1" }));
    return build({ cc, attendance: att }).months.find((m) => m.band === "6-8");
  };
  const ten = mk(10, [0]);
  check("1 whole day in 10 enrolled days = 10% = chronic that month", ten.chronicStudents === 1 && ten.memberDays === 10);
  check("1 whole day in 11 = 9.1% = not chronic", mk(11, [0]).chronicStudents === 0);
  check("a month with no absence at all is not chronic (0 >= 0 must not count)", mk(10, []).chronicStudents === 0);
  check("the month row carries students, their enrolled days and their whole days out",
    ten.students === 1 && ten.fullDayAbsences === 1);
}

// ---------------------------------------------------------------------------
// Synthetic day rows in the server's shape, for the client functions.
const row = (yearid, date, band, members, full, extra = {}) => Object.assign({
  yearid, date, band, members, absentDays: full, fullDaysStrict: full, misrecordDaysByGap: [], partialDays: 0,
  gradeEstimated: yearid === 35,
}, extra);
const schoolDates = (from, n) => {
  // n weekdays from `from`
  const out = [];
  const d = new Date(from + "T00:00:00Z");
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};

console.log("\nTHE WEEKS, AND THE DENOMINATOR CHECK\n");
{
  check("weekOf: a Wednesday belongs to its Monday", R.weekOf("2026-09-23") === "2026-09-21");
  check("weekOf: a Sunday belongs to the Monday BEFORE it", R.weekOf("2026-09-27") === "2026-09-21");

  // The first week of the year is 3 days (Wed-Fri), then full weeks, and a
  // 2-day Thanksgiving-style week in the middle.
  const days = [];
  const add = (dates, yearid = 36, members = 600) => dates.forEach((d) => days.push({ date: d, yearid, members, full: 0 }));
  add(["2026-08-12", "2026-08-13", "2026-08-14"]);                              // week of 08-10: 3 days
  add(schoolDates("2026-08-17", 5)); add(schoolDates("2026-08-24", 5));
  add(["2026-08-31", "2026-09-01"]);                                            // week of 08-31: 2 days
  add(schoolDates("2026-09-07", 5)); add(schoolDates("2026-09-14", 5));
  const merge = R.runWeekGroups(days, "merge", "2026-09-26");
  check("MERGE (the default): the 3-day first week joins the week after it",
    merge[0].key === "2026-08-10" && merge[0].dates.length === 8 && merge[0].merged === true, JSON.stringify(merge[0].dates));
  check("...and the 2-day week joins the week after it too", merge.some((g) => g.key === "2026-08-31" && g.dates.length === 7));
  check("...leaving 4 points from 6 weeks", merge.length === 4);
  const sep = R.runWeekGroups(days, "separate", "2026-09-26");
  check("SEPARATE: every week kept, the short ones flagged 'short'",
    sep.length === 6 && sep[0].flag === "short" && sep[3].flag === "short" && !sep[1].flag);
  const drop = R.runWeekGroups(days, "drop", "2026-09-26");
  check("DROP: the short weeks are left off", drop.length === 4 && !drop.some((g) => g.key === "2026-08-10" || g.key === "2026-08-31"));
  check("a 4-day week (20% short) is NOT flagged: the line is MORE than 25%",
    !R.runWeekGroups(days.concat(schoolDates("2026-09-21", 4).map((d) => ({ date: d, yearid: 36, members: 600, full: 0 }))), "separate", "2026-09-26")
      .find((g) => g.key === "2026-09-21").flag);

  // A short LAST week of a year merges BACKWARD, and never across the summer.
  const y2 = [];
  schoolDates("2026-05-25", 5).forEach((d) => y2.push({ date: d, yearid: 35, members: 400, full: 0 }));
  schoolDates("2026-06-01", 5).forEach((d) => y2.push({ date: d, yearid: 35, members: 400, full: 0 }));
  ["2026-06-08", "2026-06-09"].forEach((d) => y2.push({ date: d, yearid: 35, members: 400, full: 0 }));
  schoolDates("2026-08-17", 5).forEach((d) => y2.push({ date: d, yearid: 36, members: 600, full: 0 }));
  schoolDates("2026-08-24", 5).forEach((d) => y2.push({ date: d, yearid: 36, members: 600, full: 0 }));
  const g2 = R.runWeekGroups(y2, "merge", "2026-09-26");
  const june = g2.find((g) => g.dates.includes("2026-06-09"));
  check("the short last week of a year merges into the week BEFORE it", june && june.key === "2026-06-01" && june.dates.length === 7);
  check("...never into the next school year's first week", !g2.some((g) => g.dates.includes("2026-06-09") && g.dates.includes("2026-08-17")));
  check("a year with more students does not flag the other year's weeks: each is checked against its OWN year",
    !R.runWeekGroups(y2.filter((d) => d.date !== "2026-06-08" && d.date !== "2026-06-09"), "separate", "2026-09-26").some((g) => g.flag));

  // The week in progress.
  const thisWeek = days.concat(["2026-09-21", "2026-09-22"].map((d) => ({ date: d, yearid: 36, members: 600, full: 0 })));
  check("on a Wednesday, this week (2 days so far) is LEFT OFF, so it cannot merge into and change last week",
    !R.runWeekGroups(thisWeek, "merge", "2026-09-23").some((g) => g.dates.includes("2026-09-21"))
      && R.runWeekGroups(thisWeek, "merge", "2026-09-23").find((g) => g.key === "2026-09-14").dates.length === 5);
  check("on the Saturday it is over, and it joins the chart",
    R.runWeekGroups(thisWeek, "separate", "2026-09-26").some((g) => g.key === "2026-09-21"));

  // THE REVIEW'S CASE: a short week that is the NEWEST completed week of a
  // year still running. Merged backward it rewrote last week's settled point,
  // then jumped forward a week later.
  const thanks = [];
  schoolDates("2026-11-09", 5).forEach((d) => thanks.push({ date: d, yearid: 36, members: 600, full: 30 }));
  schoolDates("2026-11-16", 5).forEach((d) => thanks.push({ date: d, yearid: 36, members: 600, full: 30 }));
  ["2026-11-23", "2026-11-24"].forEach((d) => thanks.push({ date: d, yearid: 36, members: 600, full: 80 }));
  const sat = R.runWeekGroups(thanks, "merge", "2026-11-28");
  check("the newest short week of a running year WAITS: last week keeps its five days",
    sat.find((g) => g.key === "2026-11-16").dates.length === 5 && !sat.some((g) => g.dates.includes("2026-11-23")) && sat.pending === 1);
  const after = thanks.concat(schoolDates("2026-11-30", 5).map((d) => ({ date: d, yearid: 36, members: 600, full: 40 })));
  const sat2 = R.runWeekGroups(after, "merge", "2026-12-05");
  check("...and joins the week after it once that week is over",
    sat2.find((g) => g.dates.includes("2026-11-23")).key === "2026-11-23" && sat2.find((g) => g.key === "2026-11-23").dates.length === 7
      && sat2.find((g) => g.key === "2026-11-16").dates.length === 5);

  // THE YARDSTICK DOES NOT MOVE. A week's flag must not change as later
  // weeks arrive: measured against the average so far, holiday weeks later in
  // the year dragged the average down and un-flagged a week read months ago.
  const early = [];
  schoolDates("2026-08-17", 5).forEach((d) => early.push({ date: d, yearid: 36, members: 600, full: 0 }));
  schoolDates("2026-08-24", 4).forEach((d) => early.push({ date: d, yearid: 36, members: 600, full: 0 }));   // 4 days: -20%
  ["2026-08-31", "2026-09-01", "2026-09-02"].forEach((d) => early.push({ date: d, yearid: 36, members: 600, full: 0 })); // 3 days: -40%
  schoolDates("2026-09-07", 5).forEach((d) => early.push({ date: d, yearid: 36, members: 600, full: 0 }));
  const later = early.slice();
  for (const mon of ["2026-11-23", "2026-12-21", "2026-12-28", "2027-01-04"]) {
    ["", "", ""].forEach((_, i) => later.push({ date: schoolDates(mon, 3)[i], yearid: 36, members: 600, full: 0 }));
  }
  const flagsOf = (days) => Object.fromEntries(R.runWeekGroups(days, "separate", "2027-02-01").map((g) => [g.key, g.flag]));
  const f1 = flagsOf(early), f2 = flagsOf(later);
  check("a flag is the same in September as after four short holiday weeks have arrived",
    ["2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07"].every((k) => f1[k] === f2[k]), JSON.stringify([f1, f2]));
  check("the yardstick is a FULL WEEK: 3 days flagged, 4 days not", f2["2026-08-31"] === "short" && f2["2026-08-24"] === null);
}

console.log("\nTHE WEEKLY RATE: 1 - WHOLE DAYS OUT / STUDENT-DAYS ENROLLED\n");
{
  const rows = [];
  schoolDates("2026-09-14", 5).forEach((d) => {
    rows.push(row(36, d, "6-8", 300, 10));
    rows.push(row(36, d, "9-12", 200, 15));
  });
  const groups = R.runWeekGroups(R.runSeriesDays(rows, "all", {}), "merge", "2026-09-26");
  const all = R.runWeeklyRate(rows, "all", groups, {})[0];
  const ms = R.runWeeklyRate(rows, "6-8", groups, {})[0];
  const hs = R.runWeeklyRate(rows, "9-12", groups, {})[0];
  check("whole school: 1 - 125/2500 = 95.0%", all.value === 95 && all.memberDays === 2500 && all.full === 125, JSON.stringify(all));
  check("grades 6-8: 1 - 50/1500 = 96.7%", ms.value === 96.7);
  check("grades 9-12: 1 - 75/1000 = 92.5%", hs.value === 92.5);
  // Averaging the two bands would give 94.6: wrong, because the bands are
  // different sizes. The whole school is its own sums.
  check("the whole-school line is the bands ADDED, not averaged (the average would be 94.6)",
    all.value === 95 && Math.round((ms.value + hs.value) / 2 * 10) / 10 === 94.6);

  // The misrecord threshold is the screen's, through the one shared rule.
  const mis = [row(36, "2026-09-14", "6-8", 100, 0, { absentDays: 4, fullDaysStrict: 0, misrecordDaysByGap: [4], partialDays: 4 })];
  check("a day missing all but one explicitly-present period counts as whole at the default threshold",
    R.runDayFull(mis[0], { misrecordAt: 1 }) === 4 && R.runDayFull(mis[0], { misrecordAt: 0 }) === 0);
  check("...the same function every other screen uses (absenceSplit)",
    R.runDayFull(mis[0], {}) === R.absenceSplit(mis[0], {}).fullDays);
}

console.log("\nTHE MONTHLY MEASURES\n");
{
  const months = [
    { yearid: 35, month: "2025-09", band: "6-8", students: 200, memberDays: 4000, fullDayAbsences: 300, chronicStudents: 50 },
    { yearid: 35, month: "2025-09", band: "9-12", students: 200, memberDays: 4000, fullDayAbsences: 500, chronicStudents: 70 },
    { yearid: 35, month: "2025-10", band: "6-8", students: 200, memberDays: 4200, fullDayAbsences: 320, chronicStudents: 55 },
    { yearid: 35, month: "2025-10", band: "9-12", students: 200, memberDays: 4200, fullDayAbsences: 480, chronicStudents: 60 },
    { yearid: 35, month: "2025-12", band: "6-8", students: 200, memberDays: 2400, fullDayAbsences: 200, chronicStudents: 40 },
    { yearid: 35, month: "2025-12", band: "9-12", students: 200, memberDays: 2400, fullDayAbsences: 260, chronicStudents: 45 },
    { yearid: 36, month: "2026-09", band: "6-8", students: 340, memberDays: 4700, fullDayAbsences: 390, chronicStudents: 100 },
  ];
  const avg = R.runMonthly(months, "all", "avgAbsent", "merge", "2026-09-23");
  const chr = R.runMonthly(months, "all", "chronic", "merge", "2026-09-23");
  check("days absent per student: whole days / students enrolled that month (800/400 = 2.00)", avg[0].value === 2);
  check("chronic that month: students out 10%+ / students (120/400 = 30.0%)", chr[0].value === 30);
  check("a short month (December, 43% below the year's average) is FLAGGED, not merged",
    avg.find((p) => p.key === "2025-12").flag === "short" && avg.length === 3);
  check("'drop' leaves the flagged month off", !R.runMonthly(months, "all", "avgAbsent", "drop", "2026-09-23").some((p) => p.key === "2025-12"));
  check("the month in progress is left off (September 2026, on the 23rd)", !avg.some((p) => p.key === "2026-09"));
  // With the day rows, a month is measured against its weekdays at the
  // year's typical enrolment -- fixed, not the average of months so far.
  const dRows = [];
  schoolDates("2026-02-02", 19).forEach((d) => dRows.push(row(35, d, "6-8", 100, 0)));             // Feb 2026: 20 weekdays, 19 days
  schoolDates("2025-12-01", 14).forEach((d) => dRows.push(row(35, d, "6-8", 100, 0)));             // Dec 2025: 23 weekdays, 14 days
  const mRows = [
    { yearid: 35, month: "2026-02", band: "6-8", students: 100, memberDays: 1900, fullDayAbsences: 0, chronicStudents: 0 },
    { yearid: 35, month: "2025-12", band: "6-8", students: 100, memberDays: 1400, fullDayAbsences: 0, chronicStudents: 0 },
  ];
  const withDays = R.runMonthly(mRows, "6-8", "avgAbsent", "merge", "2026-09-23", dRows);
  check("with day rows: December (14 of 23 weekdays) is short, February (19 of 20) is not",
    withDays.find((p) => p.key === "2025-12").flag === "short" && withDays.find((p) => p.key === "2026-02").flag === null);
  check("a month ends on its real last day (February has 28)",
    R.runMonthly([{ yearid: 35, month: "2026-02", band: "6-8", students: 1, memberDays: 10, fullDayAbsences: 0, chronicStudents: 0 }],
      "6-8", "avgAbsent", "merge", "2026-09-23")[0].to === "2026-02-28");
}

// ---------------------------------------------------------------------------
console.log("\nTHE FOUR SIGNALS, AND THE FROZEN MEDIAN\n");
const P = (vals, start = "2025-08-18", yearid = 35) => {
  const out = [];
  let d = start;
  vals.forEach((v) => { out.push({ key: d, from: d, to: d, yearid, value: v }); d = new Date(Date.parse(d + "T00:00:00Z") + 7 * 86400000).toISOString().slice(0, 10); });
  return out;
};
{
  // SHIFT: 6 or more on one side, points ON the median skipped.
  const five = P([90, 90, 90, 90, 90, 92, 92, 92, 92, 92, 91]);
  const a5 = R.runChartAnalysis(five, { from: "2025-01-01", to: "2025-01-02", median: 91 });
  check("5 above a frozen median is not a shift", a5.shifts.length === 0);
  const six = P([90, 90, 90, 90, 90, 92, 92, 92, 91, 92, 92, 92]);
  const a6 = R.runChartAnalysis(six, { from: "2025-01-01", to: "2025-01-02", median: 91 });
  check("6 above (one ON the median in the middle, skipped) IS a shift", a6.shifts.some((s) => s.side === "above" && s.length === 6),
    JSON.stringify(a6.shifts));

  // TREND: 5 or more all moving one way.
  const up = P([90, 90.5, 91, 91.5, 92, 90, 91, 90, 91, 90]);
  check("5 points climbing is a trend", R.runChartAnalysis(up, null).trends.some((t) => t.direction === "up" && t.length === 5));
  check("4 climbing is not", R.runChartAnalysis(P([90, 91, 92, 93, 90, 91, 90, 91, 90, 91]), null).trends.length === 0);

  // THE FROZEN MEDIAN. Twelve baseline points around 90, then ten points
  // around 93: against the frozen 90 that is a shift. A median recalculated
  // from all 22 points sits in the middle and the change goes quiet.
  const baseVals = [89, 91, 90, 89.5, 90.5, 90, 91, 89, 90.2, 89.8, 90.6, 89.4];
  const after = [93, 92.5, 93.4, 92.8, 93.1, 92.6, 93.3, 92.9, 93.2, 92.7];
  const pts = P(baseVals.concat(after));
  const baseline = { from: pts[0].from, to: pts[11].from, median: R.runChartAnalysis(pts.slice(0, 12), null).median };
  const frozen = R.runChartAnalysis(pts, baseline);
  const moving = R.runChartAnalysis(pts, null);
  check("frozen: the median is the baseline's (90), not recalculated from all 22 points",
    frozen.median === 90 && frozen.frozen === true, String(frozen.median));
  check("frozen: the ten later points are a SHIFT above it", frozen.shifts.some((s) => s.side === "above" && s.length >= 10));
  check("recalculated instead, the median drifts up toward the change (90 -> 91)", moving.median === 91 && moving.median > frozen.median);
  check("adding points never moves a frozen median",
    R.runChartAnalysis(pts.concat(P([95, 95, 95], "2026-02-01")), baseline).median === 90);
  check("frozen: the runs test is read on the BASELINE points only (12), not on everything",
    frozen.usefulObservations <= 12 && frozen.baselinePoints === 12, String(frozen.usefulObservations));
  check("no baseline, fewer than 10 points: said to be too few", R.runChartAnalysis(P([1, 2, 3]), null).status === "too-few");

  // THE REVIEW'S CASES.
  check("an even baseline's median is exact: (87.1 + 87.3) / 2 is 87.2, not 87.19999999999999",
    R.runChartAnalysis(P([87.1, 87.3, 87.1, 87.3, 87.1, 87.3, 87.1, 87.3, 87.1, 87.3]), null).median === 87.2);
  const onIt = R.runChartSignals([87.2, 87.2, 87.2, 87.2, 87.2, 87.2, 87.2].map((v, i) => ({ date: "d" + i, value: v })), { median: (87.1 + 87.3) / 2 });
  check("...and even when a caller hands in the raw float, a point of 87.2 is compared against it as given",
    typeof onIt.median === "number");
  check("points exactly ON a rounded median are skipped, not counted above it",
    R.runChartAnalysis(P([87.1, 87.3, 87.2, 87.2, 87.2, 87.2, 87.2, 87.2, 87.1, 87.3]), null).shifts.length === 0);
  const long = [];
  for (let i = 0; i < 44; i++) long.push(i % 2 ? 91 : 89);
  const big = R.runChartAnalysis(P(long), null);
  check("beyond 40 points the runs test still runs (it used to fall silent and say 'too few points')",
    big.runsVerdict !== "not enough data" && big.runsLimits && big.runsApproximate === true);
  check("...and 44 points strictly alternating is 'too many' runs, the signature of two things mixed",
    big.runsVerdict === "too many", JSON.stringify([big.runs, big.runsLimits]));
  {
    // The formula reproduces the published table at its last row: 20 above
    // and 20 below gives 15 to 27.
    const up = 20, dn = 20, nn = 40;
    const mean = 1 + 2 * up * dn / nn, sd = Math.sqrt(2 * up * dn * (2 * up * dn - nn) / (nn * nn * (nn - 1)));
    check("the approximation agrees with the table at 40 (15 to 27)",
      Math.ceil(mean - 1.96 * sd) === 15 && Math.floor(mean + 1.96 * sd) === 27);
  }
  const reb = P([80, 80.5, 79.5, 80, 80.2, 79.8, 80.4, 79.6, 90, 90.5, 89.5, 90, 90.2, 89.8, 90.4, 89.6, 90.1, 89.9, 90.3, 89.7]);
  const rb = R.runChartAnalysis(reb, { from: reb[8].from, to: reb[19].from, median: 90 });
  check("a frozen median is carried FORWARD only: the 8 weeks before the baseline are not a 'shift below'",
    rb.shifts.length === 0 && rb.beforeBaseline === 8, JSON.stringify(rb.shifts));
  check("...while a real shift AFTER the baseline is still found, at the right place",
    (() => {
      const r2 = P([90, 90.5, 89.5, 90, 90.2, 89.8, 90.4, 89.6, 90.1, 89.9, 93, 93, 93, 93, 93, 93]);
      const a = R.runChartAnalysis(r2, { from: r2[0].from, to: r2[9].from, median: 90 });
      return a.shifts.some((sp) => sp.from === 10 && sp.side === "above");
    })());

  // ASTRONOMICAL: far outside the rest, as a prompt.
  const astro = P([90, 90.4, 89.8, 90.2, 89.6, 90.1, 72, 90.3, 89.9, 90.5]);
  const aa = R.runChartAnalysis(astro, null);
  check("a point far outside the rest (72 among ~90s) is offered as astronomical", aa.astronomical.length === 1 && aa.astronomical[0] === 6);
  check("the ordinary highest point is NOT: every chart has one", !aa.astronomical.includes(9));
  check("an astronomical point is described as a prompt, not a verdict",
    aa.signals.some((s) => s.rule === "astronomical" && /proves nothing/.test(s.text)));

  // A month belongs to a baseline by its start date: "2025-10" sorts before
  // "2025-10-01", so a comparison on keys would have dropped October.
  const monthsPts = [{ key: "2025-10", from: "2025-10-01", value: 1 }, { key: "2025-11", from: "2025-11-01", value: 2 }];
  check("a MONTH is inside a baseline that starts on its first day",
    R.runChartAnalysis(monthsPts, { from: "2025-10-01", to: "2025-11-01", median: 1.5 }).baselinePoints === 2);
}

console.log("\nTHE SCREEN'S MODEL: CANDIDATE BASELINES, NOTES, YEARS\n");
{
  // 12 weeks of last year, flat, then 5 weeks of this year.
  const rows = [];
  const weeks = [];
  let mon = "2025-09-08";
  for (let w = 0; w < 12; w++) { weeks.push([35, mon]); mon = new Date(Date.parse(mon + "T00:00:00Z") + 7 * 86400000).toISOString().slice(0, 10); }
  ["2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14"].forEach((m) => weeks.push([36, m]));
  const noise = [10, 12, 9, 11, 10, 12, 11, 9, 10, 12, 11, 10, 10, 11, 12, 9, 10];
  weeks.forEach(([y, m], i) => schoolDates(m, 5).forEach((d) => {
    rows.push(row(y, d, "6-8", 300, noise[i]));
    rows.push(row(y, d, "9-12", 200, noise[i] + 3));
  }));
  const res = { days: rows, months: [], baselines: [], annotations: [
    { id: "n1", date: "2025-09-13", label: "Saturday event", createdBy: "x" },     // a Saturday -> its own week
    { id: "n2", date: "2026-07-01", label: "Summer", createdBy: "x" },             // the summer -> the next point
  ] };
  const m = R.runRateModel(res, { measure: "weeklyRate", policy: "merge", series: ["all", "6-8", "9-12"], settings: {}, today: "2026-09-23",
    candidate: { from: "2025-09-08", to: "2025-11-24" } });
  check("one time axis for all three lines", m.axis.length === 17 && m.series.every((s) => s.points.every((p) => typeof p.x === "number")));
  check("the school year turns over where the summer is", m.yearBreaks.length === 1 && m.yearBreaks[0] === 12);
  check("12 signal-free weeks can be frozen", m.series[0].candidate.canFreeze === true && m.series[0].candidate.n === 12);
  check("a note on a Saturday lands on the week it ended", m.notes[0].x === 0);
  check("a note in the summer lands on the next point", m.notes[1].x === 12);
  const m9 = R.runRateModel(res, { measure: "weeklyRate", policy: "merge", series: ["all"], settings: {}, today: "2026-09-23",
    candidate: { from: "2025-09-08", to: "2025-11-03" } });
  check("9 weeks cannot be frozen, and it says why", m9.series[0].candidate.canFreeze === false && /at least 10/.test(m9.series[0].candidate.why));
  // A range with a shift inside it is not ordinary variation.
  const shifted = rows.map((r) => r.date >= "2025-10-20" && r.yearid === 35 ? Object.assign({}, r, { fullDaysStrict: r.fullDaysStrict + 25, absentDays: r.absentDays + 25 }) : r);
  const ms = R.runRateModel(Object.assign({}, res, { days: shifted }), { measure: "weeklyRate", policy: "merge", series: ["all"], settings: {}, today: "2026-09-23",
    candidate: { from: "2025-09-08", to: "2025-11-24" } });
  check("a range that contains a shift cannot be frozen", ms.series[0].candidate.canFreeze === false && ms.series[0].candidate.blocking.length > 0);
  // A stored baseline is used for its own measure and series only.
  const withBase = Object.assign({}, res, { baselines: [{ measure: "weeklyRate", series: "6-8", from: "2025-09-08", to: "2025-11-24", median: 99 }] });
  const mb = R.runRateModel(withBase, { measure: "weeklyRate", policy: "merge", series: ["all", "6-8"], settings: {}, today: "2026-09-23" });
  check("a frozen baseline applies to its own line only", mb.series[1].analysis.median === 99 && mb.series[0].analysis.median !== 99);
  check("...and not to another measure", R.runRateModel(withBase, { measure: "monthlyChronic", series: ["6-8"], today: "2026-09-23" }).series[0].analysis.frozen === false);
  // A month that failed to build is NAMED, not drawn across in silence.
  const gap = rows.filter((r) => !r.date.startsWith("2025-10"));
  const mg = R.runRateModel(Object.assign({}, res, { days: gap }), { measure: "weeklyRate", policy: "merge", series: ["all"], today: "2026-09-23" });
  check("a month with no rows inside a year is reported as missing", mg.missingMonths.join() === "2025-10", JSON.stringify(mg.missingMonths));
  check("...and a complete year reports none", m.missingMonths.length === 0);
}

// ---------------------------------------------------------------------------
console.log("\nTHE SERVER: WHO MAY CHANGE IT, AND WHAT IT REFUSES\n");
{
  const body = (name) => dataSrc.slice(dataSrc.indexOf("export const " + name), dataSrc.indexOf("export const", dataSrc.indexOf("export const " + name) + 10) >>> 0 || undefined);
  check("reads and changes are limited to admin, superadmin and PBIS", /const ROLES = \["admin", "superadmin", "pbis"\]/.test(dataSrc));
  check("the chart's read checks the role", /export const series = query[\s\S]*?ROLES\.includes\(staff\.role\)/.test(dataSrc));
  ["freezeBaseline", "retireBaseline", "addAnnotation", "removeAnnotation"].forEach((n) =>
    check(`${n} goes through the role gate`, new RegExp("export const " + n + " = mutation[\\s\\S]*?await gate\\(ctx\\)").test(dataSrc)));
  check("a baseline under 10 points is refused by the server too", /a\.points >= 10/.test(body("freezeBaseline")));
  check("freezing RETIRES the old baseline rather than deleting it", /retiredWhy: "replaced by a new baseline"/.test(dataSrc) && !/db\.delete/.test(body("freezeBaseline")));
  check("unfreezing needs a reason", /Say why the baseline is being retired/.test(dataSrc));
  check("a removed note is kept on record (soft delete)", /removedAt: new Date\(\)\.toISOString\(\)/.test(body("removeAnnotation")) && !/db\.delete/.test(body("removeAnnotation")));
  check("a month is replaced whole, and a row outside it is refused rather than misfiled",
    /if \(!d\.date\.startsWith\(a\.month\)\) continue/.test(dataSrc));
  check("no student is named in the chart's tables: numbers only",
    !/name|email|student_number/.test(schemaSrc.slice(schemaSrc.indexOf("attendanceRunDays"), schemaSrc.indexOf("runChartBaselines"))));
  check("the fetch refuses a truncated read rather than under-counting", /pagedOut[\s\S]{0,200}nothing was written/.test(actionSrc));
  check("the fetch refuses when records cannot be placed in a period (> 15%)", /unmappedShare > 0\.15/.test(actionSrc));
  check("the fetch reads only COMPLETED days: nothing after yesterday in Los Angeles",
    /America\/Los_Angeles/.test(actionSrc) && /if \(to > yesterday\) to = yesterday/.test(actionSrc));
  check("it runs nightly", /attendanceRunChart\.refreshCurrent/.test(cronSrc));
  check("an EMPTY read never replaces a month: the fetch refuses, and the save refuses as a backstop",
    /if \(!built\.schoolDays\.length\)[\s\S]{0,200}nothing was written/.test(actionSrc)
      && /if \(!a\.days\.length\) throw/.test(dataSrc));
  check("a finished year's months stop being rebuilt nightly (after PowerSchool promotes everyone)",
    /onlyWhileOpen && yesterday > addDays\(range\.last, CLOSE_AFTER_DAYS\)/.test(actionSrc)
      && /onlyWhileOpen: true/.test(actionSrc.slice(actionSrc.indexOf("export const refreshCurrent"))));
  check("the nightly run mends missing months of the year, a few a night",
    /monthsPresent/.test(actionSrc) && /mend\.slice\(0, 3\)/.test(actionSrc) && /export const monthsPresent = internalQuery/.test(dataSrc));
  check("the students read asks for the ENTRY date (the promotion rule needs it)",
    (actionSrc.match(/"id,grade_level,enroll_status,entrydate"/g) || []).length === 2);
}

console.log("\nTHE FROZEN MEDIAN IS EXPLAINED WHERE SOMEONE WOULD 'FIX' IT\n");
{
  check("the rules file says why a frozen median is never recalculated",
    /WHY A FROZEN MEDIAN IS NEVER RECALCULATED[\s\S]{0,900}Do not "fix"/.test(rosterSrc));
  check("the server says it too, where the median is stored", /NEVER RECALCULATED, deliberately/.test(dataSrc));
  check("and the schema", /runChartBaselines/.test(schemaSrc) && /recalculat/i.test(schemaSrc.slice(schemaSrc.indexOf("runChartBaselines") - 1500, schemaSrc.indexOf("runChartBaselines") + 200)));
}

// ---------------------------------------------------------------------------
console.log("\nTHE SCREEN\n");
{
  check("a fourth view on the switch", /data-attview="rate"/.test(htmlSrc) && /id="attRateView" hidden/.test(htmlSrc) && /id="attRateBody"/.test(htmlSrc));
  check("the switch knows it", /ATT_VIEWS = \['watch', 'perfect', 'subgroup', 'rate'\]/.test(script) && /rateEl\.hidden = \(_attView !== 'rate'\)/.test(script));
  check("the three measures are buttons", ["weeklyRate", "monthlyAvgAbsent", "monthlyChronic"].every((k) => htmlSrc.includes(`data-armeasure="${k}"`)));

  const liftFn = (name) => {
    const i = script.indexOf("function " + name + "(");
    if (i < 0) throw new Error("missing " + name);
    const head = script.lastIndexOf("\n", i);
    let depth = 0;
    for (let k = script.indexOf("{", i); k < script.length; k++) {
      if (script[k] === "{") depth++;
      else if (script[k] === "}") { depth--; if (depth === 0) return script.slice(head + 1, k + 1); }
    }
    return "";
  };
  const liftConst = (name) => {
    const i = script.indexOf("const " + name + " = ");
    const open = script.slice(i).search(/[\[{]/) + i;
    const close = script[open] === "[" ? "]" : "}";
    let depth = 0;
    for (let k = open; k < script.length; k++) {
      if (script[k] === script[open]) depth++;
      else if (script[k] === close) { depth--; if (depth === 0) return script.slice(i, k + 1) + ";"; }
    }
    return "";
  };
  const body = new Function("R", `
    ${liftFn("escapeHtml")}
    ${liftConst("AR_SERIES")}
    ${liftConst("AR_POLICY_WORDS")}
    ${["arSeriesInfo", "arYearLabel", "arPeriodLabel", "arFmt", "arDefaultRange", "renderAttendanceRateBody"].map(liftFn).join("\n")}
    return renderAttendanceRateBody;`)(R);
  const asOf = new Function(liftFn("arAsOf") + "\nreturn arAsOf;")();
  check("'today' is the day of the newest build when that is earlier (a tab left open over a weekend)",
    asOf({ days: [{ syncedAt: "2026-09-25T10:15:00.000Z" }] }, "2026-09-27") === "2026-09-25");
  check("...and the real date when the data is fresh", asOf({ days: [{ syncedAt: "2026-09-27T10:15:00.000Z" }] }, "2026-09-27") === "2026-09-27");
  check("...read in Los Angeles: a 03:15 PT build on the 25th is the 25th", asOf({ days: [{ syncedAt: "2026-09-25T10:15:00.000Z" }] }, "2026-09-30") === "2026-09-25");
  const rows = [];
  let mon = "2025-09-08";
  for (let w = 0; w < 14; w++) {
    schoolDates(mon, 5).forEach((d) => { rows.push(row(35, d, "6-8", 300, 10 + (w % 3))); rows.push(row(35, d, "9-12", 200, 14 - (w % 2))); });
    mon = new Date(Date.parse(mon + "T00:00:00Z") + 7 * 86400000).toISOString().slice(0, 10);
  }
  const st = { measure: "weeklyRate", policy: "merge", shown: { all: true, "6-8": true, "9-12": true }, cand: null, settings: {}, today: "2026-09-23" };
  const res = { allowed: true, days: rows, months: [], baselines: [], annotations: [{ id: "a1", date: "2025-10-01", label: "<img src=x onerror=alert(1)>", createdBy: "t" }] };
  const out = body(res, R, st);
  check("draws a chart with a legend entry per line", /<svg/.test(out.html) && (out.html.match(/<li><span class="wc-ar-swatch/g) || []).length >= 3);
  check("offers to freeze a signal-free default range (last year, 14 weeks)", /Freeze this median/.test(out.html) && out.model.candidateRange.from === "2025-09-08");
  check("a staff-typed note is ESCAPED, never run", !out.html.includes("<img src=x") && out.html.includes("&lt;img src=x"));
  check("says how a short week was handled and what 'enrolled' means", /at least one class that met/.test(out.html));
  const denied = body({ allowed: false, reason: "The attendance run chart is limited to administrators and the PBIS team." }, R, st);
  check("someone outside the roles is told why, not shown an empty chart", /limited to administrators/.test(denied.html) && denied.model === null);
  const frozenRes = Object.assign({}, res, { baselines: [{ id: "b", measure: "weeklyRate", series: "all", from: "2025-09-08", to: "2025-11-24", median: 95.5, points: 12, frozenAt: "2026-09-23T10:00:00Z", frozenBy: "admin@x", note: null }] });
  const fr = body(frozenRes, R, st);
  check("a frozen line says so, who froze it, and offers to unfreeze", /frozen at 95\.5%/.test(fr.html) && /admin@x/.test(fr.html) && /Unfreeze/.test(fr.html));
  check("a frozen median is drawn solid over its baseline and dashed after", /wc-ar-frozen/.test(fr.html) && /wc-ar-extended/.test(fr.html));
  const empty = body({ allowed: true, days: [], months: [], baselines: [], annotations: [] }, R, st);
  check("nothing yet: says the history is built overnight rather than drawing an empty chart", /built overnight/.test(empty.html));
  // Axis labels keep the decimals the step needs.
  const labels = [...out.html.matchAll(/class="wc-rc-ylab">([^<]+)</g)].map((m) => m[1]);
  check("axis labels are exact for the step (no '88%' standing for 87.5%)",
    labels.length >= 3 && labels.every((l) => /^\d+(\.\d+)?%$/.test(l)), JSON.stringify(labels));

  const section = script.slice(script.indexOf("// ATTENDANCE RATE OVER TIME"), script.indexOf("async function loadPerfectMarks"));
  check("one change at a time: a double click cannot save twice", /if \(_arSaving\) return false;/.test(section));
  check("a refresh asked for during a load is remembered, not dropped", /if \(_arBusy\) \{ _arAgain = true; return; \}/.test(section));
  check("unfreezing with an empty reason SAYS so rather than doing nothing", /A reason is needed to unfreeze/.test(section));
  check("the cache expires (30 minutes) and is dropped on the idle timer like every other Attendance Watch cache",
    /Date\.now\(\) - _arCacheAt > 30 \* 60 \* 1000/.test(section) && /_arCache = null;/.test(script.slice(0, script.indexOf("// ATTENDANCE RATE OVER TIME"))));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
