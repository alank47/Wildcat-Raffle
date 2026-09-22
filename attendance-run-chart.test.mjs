// The attendance run chart. Run: npm test
//
// WHY A RUN CHART AT ALL. Attendance Watch answers "who is absent a lot" and
// cannot answer "is this getting better or worse" -- which is the question any
// intervention is actually judged on. A run chart plots the measure in time
// order against its MEDIAN and applies published signal rules, so a real
// change is told apart from the bouncing every measure does anyway.
//
// WHAT IS EXACT AND WHAT IS A TABLE. Shift and trend are exact combinatorial
// rules and are asserted exactly. The runs test compares against published
// limits reproduced in the source, so it is asserted on behaviour at the
// boundaries rather than on the table being beyond question.
import { readFileSync } from "node:fs";

const js = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const script = js("./script.js");
const html = js("./index.html");
const css = js("./styles.css");
const conv = js("./convex/attendanceList.ts");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

new Function(js("./wildcat-roster.js"))();
const R = globalThis.WildcatRoster;
const P = (a) => a.map((v, i) => ({ date: "2026-09-" + String(i + 1).padStart(2, "0"), value: v }));

console.log("\nthe median, which every rule is read against");

check("the rules are exported",
  typeof R.runChartMedian === "function" && typeof R.runChartSignals === "function");
check("an odd count takes the middle value", R.runChartMedian([3, 1, 2]) === 2);
check("an even count averages the two middles", R.runChartMedian([1, 2, 3, 4]) === 2.5);
check("it is the MEDIAN, not the mean, so one terrible day cannot drag it",
  R.runChartMedian([1, 1, 1, 1, 100]) === 1,
  "the mean here is 20.8; absence counts are skewed and a mean chases the outlier");
check("unreadable values are dropped rather than becoming zero",
  R.runChartMedian([1, null, 3, "x", undefined]) === 2);
check("nothing readable gives null, never 0", R.runChartMedian([]) === null);

console.log("\nthe shift rule: six or more on one side");

{
  // Six IS the rule. Five is not, and getting that boundary wrong is the
  // difference between a chart that cries wolf and one that misses a change.
  const five = R.runChartSignals(P([1, 9, 1, 9, 1, 9, 10, 11, 12, 13, 14]));
  const six = R.runChartSignals(P([1, 9, 1, 9, 1, 9, 1, 10, 11, 12, 13, 14, 15]));
  check("five points above the median is NOT a shift",
    !five.shifts.some((s) => s.length === 5 && s.side === "above"), JSON.stringify(five.shifts));
  check("six or more IS a shift", six.shifts.length > 0, JSON.stringify(six.shifts));
  check("the shift names its side", six.shifts[0].side === "above" || six.shifts[0].side === "below");
  check("and the span, so a chart can mark it rather than only announce it",
    Number.isFinite(six.shifts[0].from) && six.shifts[0].to >= six.shifts[0].from);
  // A POINT EXACTLY ON THE MEDIAN IS SKIPPED, not counted as a break: it sits
  // on neither side, so it neither extends nor ends a run.
  // Seven below, one ON the median, seven above: the median point must extend
  // neither run and break neither.
  const straddle = R.runChartSignals(P([1, 1, 1, 1, 1, 1, 1, 5, 9, 9, 9, 9, 9, 9, 9]));
  check("a point ON the median does not break a run",
    straddle.shifts.length > 0, JSON.stringify(straddle.shifts));
  check("and is excluded from the useful observations",
    straddle.usefulObservations < straddle.n, `${straddle.usefulObservations} of ${straddle.n}`);
}

console.log("\nthe trend rule: five or more moving one way");

{
  // FOUR points rising (1,2,3,4) then a fall. The earlier fixture ended 4 -> 9,
  // which made it five and the assertion was testing the wrong thing.
  const four = R.runChartSignals(P([9, 1, 2, 3, 4, 2, 9]));
  const five = R.runChartSignals(P([9, 1, 2, 3, 4, 5, 9]));
  check("four rising points is NOT a trend", four.trends.length === 0, JSON.stringify(four.trends));
  check("five IS a trend", five.trends.length === 1 && five.trends[0].direction === "up");
  const down = R.runChartSignals(P([1, 9, 8, 7, 6, 5, 1]));
  check("and it reads downwards too", down.trends.length === 1 && down.trends[0].direction === "down");
  // A REPEATED VALUE IS NO EVIDENCE EITHER WAY. Treating it as a break would
  // hide a genuine climb that happens to plateau for one day.
  const plateau = R.runChartSignals(P([9, 1, 2, 3, 3, 4, 5, 9]));
  check("an equal consecutive value does not break a trend",
    plateau.trends.length === 1, JSON.stringify(plateau.trends));
  check("a flat line produces no trend at all",
    R.runChartSignals(P([4, 4, 4, 4, 4, 4, 4, 4])).trends.length === 0);
}

console.log("\nthe runs test, and its honest limits");

{
  const flat = R.runChartSignals(P([4, 4, 4, 4, 4]));
  check("a line entirely on its median has no useful observations", flat.usefulObservations === 0);
  check("and the runs test is not applied rather than guessed",
    flat.runsVerdict === "not enough data");
  const few = R.runChartSignals(P([1, 1, 1, 1, 1, 1, 9, 9, 9, 9, 9, 9]));
  check("two runs over twelve useful points is TOO FEW", few.runsVerdict === "too few",
    `${few.runs} runs, ${few.usefulObservations} useful`);
  check("and that is reported as drifting rather than bouncing",
    few.signals.some((s) => s.rule === "runs" && /drifting/.test(s.text)));
  const many = R.runChartSignals(P([1, 9, 1, 9, 1, 9, 1, 9, 1, 9, 1, 9]));
  check("alternating every point is TOO MANY", many.runsVerdict === "too many");
  check("and that is reported as two things mixed together",
    many.signals.some((s) => s.rule === "runs" && /mixed together/.test(s.text)));
  check("under ten useful points the test says so rather than pretending",
    R.runChartSignals(P([1, 9, 1, 9, 1, 9])).runsVerdict === "not enough data");
  check("the published limits are present for the readable range",
    R.RUNS_LIMITS[10] && R.RUNS_LIMITS[20] && R.RUNS_LIMITS[30]);
}

console.log("\nturning the server's rows into one series");

{
  const rows = [
    { date: "2026-09-14", studentsAbsent: 110, fullDaysStrict: 59, misrecordDaysByGap: [1, 0, 0], partialDays: 50 },
    { date: "2026-09-15", studentsAbsent: 87, fullDaysStrict: 33, misrecordDaysByGap: [0, 0, 0], partialDays: 54 },
  ];
  const v = (w, s) => R.absenceSeriesValues(rows, s || {}, w).map((p) => p.value);
  check("whole days counts the strict full days plus admitted misrecords",
    v("full").join() === "60,33");
  check("partial days is the remainder of the students absent", v("partial").join() === "50,54");
  check("all absences is the student count", v("all").join() === "110,87");
  check("the misrecord threshold is applied HERE, not on the server",
    v("full", { misrecordAt: 0 }).join() === "59,33");
  check("an empty series is empty, not a crash", R.absenceSeriesValues([], {}, "full").length === 0);
}

console.log("\nthe chart body, run as a pure function");

{
  const start = script.indexOf("function renderRunChartBody(res, R, which, settings)");
  const end = script.indexOf("\n        async function renderAbsenceRunChart", start);
  const body = new Function("escapeHtml",
    script.slice(start, end) + "\nreturn renderRunChartBody;")(
    (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
  check("the chart body lifted and built", typeof body === "function");

  const day = (d, total, full) => ({ date: "2026-09-" + String(d).padStart(2, "0"),
    studentsAbsent: total, fullDaysStrict: full, misrecordDaysByGap: [0, 0, 0],
    partialDays: total - full });
  const rows = [];
  for (let i = 1; i <= 14; i++) rows.push(day(i, 100 + i, 40 + (i % 5) * 3));
  const res = { allowed: true, reason: null, points: rows, schoolDaysOnFile: 27, truncated: false };

  let threw = null, out = "";
  try { out = body(res, R, "full", {}); } catch (e) { threw = e; }
  check("IT RUNS WITHOUT THROWING", threw === null, threw && (threw.message || String(threw)));
  if (!threw) {
    check("it draws an svg", out.includes("<svg") && out.includes("wc-rc-svg"));
    check("with a median reference line", out.includes("wc-rc-median"));
    check("and one point per school day",
      (out.match(/<circle /g) || []).length === rows.length,
      String((out.match(/<circle /g) || []).length));
    check("the median is stated in words, not only drawn", /median \d/.test(out));
    check("it says how many days of the file it is showing", /of 27 on file/.test(out));
    check("NO PERCENTAGE ANYWHERE, because enrolment grew and there is no per-day enrolment",
      !out.includes("%"), "a rate here would be invented");
    check("and it says why in words", /a percentage would be invented/.test(out));
    check("it says days school did not run are absent rather than zero",
      /rather than plotted as zero/.test(out));
    check("the axis starts at zero, so a wobble is not drawn as a cliff",
      out.includes('class="wc-rc-ylab">0<'));
  }
  // The verdict must be in words either way.
  {
    const rising = [];
    for (let i = 1; i <= 12; i++) rising.push(day(i, 60 + i * 5, 20 + i * 4));
    const o = body({ allowed: true, points: rising, schoolDaysOnFile: 12 }, R, "full", {});
    check("a real trend is announced in words", /points in a row moving up/.test(o), o.slice(0, 300));
    check("and the points in it are marked on the chart", /wc-rc-sig/.test(o));
  }
  {
    // IRREGULAR ON PURPOSE. A strictly alternating series (40,44,40,44...) has
    // a run for every point, which the runs test correctly calls TOO MANY --
    // so the earlier fixture was not "ordinary variation" at all, it was a
    // signal. This one has ten runs over twelve useful points, which is what
    // ordinary looks like.
    const wobble = [44, 39, 46, 41, 47, 38, 43, 45, 37, 42, 48, 40];
    const steady = wobble.map((f, i) => day(i + 1, 100, f));
    const o = body({ allowed: true, points: steady, schoolDaysOnFile: 12 }, R, "full", {});
    check("ordinary variation is called ordinary, not left ambiguous",
      /No signal: this is ordinary variation/.test(o), o.slice(0, 300));
  }
  {
    const o = body({ allowed: true, points: [day(1, 10, 5), day(2, 10, 5)], schoolDaysOnFile: 2 }, R, "full", {});
    check("too few days says so instead of drawing a two-point chart",
      /needs about ten before its signals mean anything/.test(o));
  }
  {
    const o = body({ allowed: false, reason: "Not your access level." }, R, "full", {});
    check("a refusal prints the server's reason", /Not your access level\./.test(o));
  }
}

console.log("\nthe wiring");

check("the chart host exists in the pane", /id="attRunChart"/.test(html));
check("and sits ABOVE the tier cards, since the trend frames the tiers",
  html.indexOf('id="attRunChart"') < html.indexOf('id="attTierCards"'));
check("the series toggle is present and wired",
  /data-run="full"/.test(html) && /setAbsenceRunSeries\('partial'\)/.test(html));
check("opening the tab draws it", /subtab === 'attendance'\)\s*\{[\s\S]{0,160}renderAbsenceRunChart\(\)/.test(script));
check("the fetch is guarded, not the render",
  /if \(!res \|\| force\) \{\s*\n\s*if \(_runBusy\) return;/.test(script));
check("every handler named in the markup is a real function",
  ["setAbsenceRunSeries", "renderAbsenceRunChart"].every((f) =>
    new RegExp("function " + f + "\\s*\\(").test(script)));
check("every class the chart renders is defined in the stylesheet",
  ["wc-rc-svg", "wc-rc-line", "wc-rc-median", "wc-rc-dot", "wc-rc-sig", "wc-rc-xlab",
   "wc-rc-ylab", "wc-rc-signals", "wc-rc-signal", "wc-rc-none", "wc-rc-head"]
    .every((c) => css.includes("." + c)));

console.log("\nthe server side");

check("the series query exists", /export const dailyAbsenceSeries = query\(/.test(conv));
check("gated to the same three roles as the ranking",
  /ATTENDANCE_ROLES\.includes\(staff\.role\)/.test(conv.slice(conv.indexOf("dailyAbsenceSeries"))));
check("FUTURE DATES ARE EXCLUDED: two students carry absences dated to 2026-10-09",
  /d <= day/.test(conv));
check("today comes from the browser, never a server clock",
  /today: v\.string\(\)/.test(conv.slice(conv.indexOf("dailyAbsenceSeries"))));
check("it reads the precomputed per-day table, not the per-student rows",
  /psAbsenceDayTotals"\)\.take/.test(conv),
  "summing 2,579 growing rows would pass Convex's 4,096 limit by spring");
check("the read cap is announced rather than silently truncating",
  /truncated = raw\.length > CAP/.test(conv));
check("it sends counts, no names",
  !/firstName|lastName|studentName/.test(conv.slice(conv.indexOf("dailyAbsenceSeries"))));

// THE DENOMINATOR FIX. There is no attendance at all on 2026-09-04 or on Labor
// Day 2026-09-07, so two weekdays in the window were not school days. The box
// said one, which divided every absence by a day too many and made every rate
// slightly low.
check("the non-school-days default counts BOTH days school did not run",
  /id="attNonSchoolDays"[^>]*value="2"/.test(html),
  "2026-09-04 and Labor Day 2026-09-07 both have zero attendance rows");

console.log(`\nattendance run chart: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
