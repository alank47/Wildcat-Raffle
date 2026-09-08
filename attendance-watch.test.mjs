// Chronic absence and tardiness in Discipline Mode.
//
// THE NUMBER THAT SHAPED THIS FEATURE. The owner asked for "students who miss
// 10% of the school year... it should go by the amount of time we're in
// school. We started on August 12th." Run literally against production on
// 2026-09-08 -- 19 school days in, so a 1.9-day threshold -- that flagged
// 360 of 671 students, 54% of the school. The definition is right and the
// arithmetic is right; a 360-name list is simply not a queue anyone can work.
//
// So the rule tiers instead (severe 20%+, chronic 10-20%, at risk 5-10%) and
// sorts worst-first. The flat 10% line is still drawn and still counted; it is
// just no longer the only thing on screen. These tests hold that shape, and
// hold the three ways a feature like this does real harm to a child:
//
//   1. rendering "no attendance on file" as perfect attendance
//   2. dividing by zero school days and reporting everyone at 0%
//   3. sending a whole-school list of at-risk children to a teacher
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
new Function(src)();
const R = globalThis.WildcatRoster;

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const disc = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");
const conv = readFileSync(new URL("./convex/attendanceList.ts", import.meta.url), "utf8");

new Function(disc)();
const D = globalThis.WildcatDiscipline;

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const S = (id, last) => ({ id: String(id), studentNumber: "N" + id, firstName: "S" + id, lastName: last || "X" });
const row = (id, abs, tardy) => ({ student: S(id), daysAbsent: abs, daysTardy: tardy });

console.log("\n-- the denominator --");
{
  // Aug 12 2026 is a Wednesday. Through Sep 8 inclusive that is 20 weekdays.
  check("weekdays Aug 12 -> Sep 8 is 20", R.schoolDaysElapsed("2026-08-12", "2026-09-08") === 20);
  check("the first day counts", R.schoolDaysElapsed("2026-09-08", "2026-09-08") === 1);
  check("weekends are not school days", R.schoolDaysElapsed("2026-09-05", "2026-09-06") === 0);
  check("a future start date is 0, not negative", R.schoolDaysElapsed("2026-10-01", "2026-09-08") === 0);
  check("garbage in is 0, not NaN", R.schoolDaysElapsed("not-a-date", "2026-09-08") === 0);
}

console.log("\n-- the tiers --");
{
  check("20% is severe", R.attendanceTier(0.20).key === "severe");
  check("19.9% is chronic, not severe", R.attendanceTier(0.199).key === "chronic");
  check("10% is chronic -- the line the school asked for", R.attendanceTier(0.10).key === "chronic");
  check("9.9% is at risk", R.attendanceTier(0.099).key === "at-risk");
  check("5% is at risk", R.attendanceTier(0.05).key === "at-risk");
  check("4.9% is satisfactory", R.attendanceTier(0.049).key === "satisfactory");
  check("perfect attendance is satisfactory", R.attendanceTier(0).key === "satisfactory");
  // A null rate has no tier. Falling through to satisfactory would say a child
  // we know nothing about is attending fine.
  check("no rate means no tier", R.attendanceTier(null) === null);
  check("NaN means no tier", R.attendanceTier(NaN) === null);
}

console.log("\n-- unknown attendance is never zero --");
{
  const r = R.attendanceRanking([
    row(1, 4, 0),
    row(2, null, null),        // never synced
    row(3, undefined, 2),      // column missing from the aggregate
  ], 20);
  check("a student with no absence figure is not ranked", r.ranked.length === 1);
  check("they are reported separately instead", r.noData.length === 2);
  check("and they are NOT counted as satisfactory", r.counts.satisfactory === 0);
  check("the one real row still ranks", r.ranked[0].student.id === "1" && r.ranked[0].tier.key === "severe");
}

console.log("\n-- no school days yet --");
{
  // The first morning of the year. Every rate would be x/0.
  const r = R.attendanceRanking([row(1, 0, 0), row(2, 3, 1)], 0);
  check("nobody is ranked at 0 school days", r.ranked.length === 0);
  check("everyone lands in noData rather than at 0%", r.noData.length === 2);
  check("the threshold refuses rather than guessing", r.thresholdDays === null);
  check("schoolDays is null, not 0, so the screen can say so", r.schoolDays === null);

  const bad = R.attendanceRanking([row(1, 3, 0)], -5);
  check("a negative day count is refused too", bad.ranked.length === 0);
}

console.log("\n-- worst first --");
{
  const r = R.attendanceRanking([
    row(1, 1, 0), row(2, 8, 0), row(3, 4, 0), row(4, 0, 0)
  ], 20);
  check("ordered by rate, descending", r.ranked.map(x => x.student.id).join(",") === "2,3,1,4");
  check("counts add up to the ranked list",
    r.counts.severe + r.counts.chronic + r.counts["at-risk"] + r.counts.satisfactory === r.ranked.length);
  check("chronicOrWorse is the flat 10% line the owner asked for",
    r.chronicOrWorse === r.ranked.filter(x => x.rate >= 0.10).length);
  check("the threshold in days is shown, not just the percentage", r.thresholdDays === 2);
}

console.log("\n-- tardies break ties, and are their own axis --");
{
  const r = R.attendanceRanking([row(1, 2, 0), row(2, 2, 9)], 20);
  check("same absence rate, more tardies ranks first", r.ranked[0].student.id === "2");
  // A punctual-but-absent child and a present-but-always-late child are
  // different problems. Tardies survive onto the row so the second is findable.
  const punctual = R.attendanceRanking([row(1, 0, 14)], 20);
  check("a never-absent, always-late student is satisfactory on absence",
    punctual.ranked[0].tier.key === "satisfactory");
  check("but their tardy count is still carried", punctual.ranked[0].daysTardy === 14);
}

console.log("\n-- September reality: the tiers are what make it workable --");
{
  // 671 students, 19 school days, shaped like the production probe: roughly
  // a quarter each satisfactory / at risk / chronic / severe.
  const rows = [];
  for (let i = 0; i < 671; i++) {
    const abs = i % 4 === 0 ? 0 : i % 4 === 1 ? 1 : i % 4 === 2 ? 2 : 5;
    rows.push(row(i, abs, i % 7));
  }
  const r = R.attendanceRanking(rows, 19);
  const flat10 = r.chronicOrWorse;
  check("the flat 10% rule really does flag about half the school", flat10 > rows.length * 0.4);
  check("severe alone is a list a person could actually work", r.counts.severe < flat10);
  check("severe students sort above chronic ones",
    r.ranked[0].tier.key === "severe" && r.ranked[r.ranked.length - 1].tier.key === "satisfactory");
}

console.log("\n-- who may open it --");
{
  check("admin gets the tab", R2(disc, "admin"));
  check("superadmin gets the tab", R2(disc, "superadmin"));
  check("pbis gets the tab", R2(disc, "pbis"));
  // A whole-school ranking of at-risk children is a discipline record.
  check("teacher does NOT get the tab", !R2(disc, "teacher"));
  check("campusaide does NOT get the tab", !R2(disc, "campusaide"));

  // The server refuses independently. Hiding a button is a courtesy, not a
  // permission -- anyone can call the query straight from a console.
  check("the Convex query gates on role, not just the UI",
    /ATTENDANCE_ROLES/.test(conv) && /!ATTENDANCE_ROLES\.includes\(staff\.role\)/.test(conv));
  check("and it gates on staff identity first", /requireStaff\(ctx\)/.test(conv));
  check("teacher is not in the server's allowed roles",
    /const ATTENDANCE_ROLES = \["admin", "superadmin", "pbis"\]/.test(conv));
}

function R2(_source, role) {
  // The real disciplineTabsFor, evaluated -- not a string match on the file.
  return D.disciplineTabsFor(role).indexOf("attendance") !== -1;
}

console.log("\n-- no names cross the wire --");
{
  // The browser already holds the roster, so the server sends numbers only.
  // This is what keeps the query from ever being the thing that leaks a
  // student record: it never builds one.
  const handler = conv.slice(conv.indexOf("const raw ="), conv.indexOf("return { allowed: true"));
  check("the response carries studentNumber, absences and tardies -- nothing else",
    /studentNumber: String/.test(handler) &&
    !/firstName|lastName|studentEmail|grade:/.test(handler));
  check("counts go through dayCount, never ?? 0",
    /dayCount\(r\.daysAbsentYtd\)/.test(conv) && !/daysAbsentYtd \?\? 0/.test(conv));
  check("the row cap is announced rather than silently truncating",
    /truncated/.test(conv) && /MAX_ROWS \+ 1/.test(conv));
}

console.log("\n-- the screen --");
{
  check("the pane exists", /id="behaviorAttendance"/.test(html));
  check("it is hidden until opened", /id="behaviorAttendance" class="discipline-subtab hidden"/.test(html));
  check("switchDisciplineTab knows the pane", /attendance:\{ pane: 'behaviorAttendance'/.test(script));
  check("opening the tab renders it", /subtab === 'attendance'\)\s*\{\s*renderAttendanceWatch\(\)/.test(script));
  check("the sidebar lists it", /id: 'attendance', fn: 'switchDisciplineTab'/.test(script));

  // EVERY id the renderer touches must exist. This exact class of bug -- a
  // getElementById on an element that was renamed or never added -- has broken
  // sign-in twice and shipped once.
  const fn = script.slice(script.indexOf("async function renderAttendanceWatch"),
                          script.indexOf("// At most one roster fetch"));
  const ids = [...fn.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
  check("the renderer reads at least five elements", ids.length >= 5);
  ids.forEach(id => check(`#${id} exists in index.html`, html.includes(`id="${id}"`)));

  // The denominator is a judgement call this school has to be able to see and
  // correct. No school calendar exists in the app (bellScheduleDays is empty),
  // so a hidden weekday count would be a guess presented as a measurement.
  check("the school days count is shown on screen", /id="attBasisNote"/.test(html));
  check("the start date can be corrected", /id="attFirstDay"/.test(html) && /2026-08-12/.test(html));
  check("holidays can be subtracted", /id="attNonSchoolDays"/.test(html));
  check("the note states the chronic threshold in days",
    /Chronic starts at ' \+ \(basis\.days \* 0\.10\)/.test(script));

  check("students with no attendance are named in the footer, not dropped",
    /no attendance on file and are not ranked/.test(script));

  const filters = ["chronicPlus", "severe", "at-risk", "tardy", "all"];
  filters.forEach(f => check(`the ${f} filter is wired`, script.includes(`'${f}'`) && html.includes(`data-atier="${f}"`)));
}

console.log("\n-- the styles --");
{
  ["wc-att-basis", "wc-att-tiers", "wc-att-tier", "wc-att-row", "wc-att-name",
   "wc-att-figs", "wc-att-pct", "wc-att-days", "wc-att-badge", "wc-att-foot",
   "wc-att-search", "wc-att-list", "wc-att-meta", "wc-att-controls"].forEach(c =>
    check(`.${c} is styled`, css.includes("." + c + " ") || css.includes("." + c + "{") ||
                             css.includes("." + c + ",") || css.includes("." + c + ":")));
  // The bug that made the quiet-students cards look clipped: a border pushing
  // a 100%-wide row past its padded container.
  const rowCss = css.slice(css.indexOf(".wc-att-row {"), css.indexOf(".wc-att-row:hover"));
  check("rows are border-box so they cannot overflow their panel", /box-sizing: border-box/.test(rowCss));
  check("every tier has a colour", ["severe", "chronic", "at-risk", "satisfactory"]
    .every(t => css.includes(`.wc-att-row.wc-att-${t}`)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
