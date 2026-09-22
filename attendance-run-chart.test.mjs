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
    // TWO circles per point now: the visible dot and the invisible hit target
    // over it. Counting bare <circle> would pass at any ratio, so count the
    // dots -- which is what "one point per school day" actually means.
    check("and one visible point per school day",
      (out.match(/class="wc-rc-dot/g) || []).length === rows.length,
      String((out.match(/class="wc-rc-dot/g) || []).length));
    check("each with exactly one hit target over it",
      (out.match(/class="wc-rc-hit"/g) || []).length === rows.length);
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


console.log("\nhovering a point shows the day behind it");

{
  const start = script.indexOf("function renderRunChartBody(res, R, which, settings)");
  const end = script.indexOf("\n        /**\n         * Show the day behind a point", start);
  const body = new Function("escapeHtml",
    script.slice(start, end) + "\nreturn renderRunChartBody;")(
    (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));

  const day = (d, total, full) => ({ date: "2026-09-" + String(d).padStart(2, "0"),
    studentsAbsent: total, fullDaysStrict: full, misrecordDaysByGap: [0, 0, 0],
    partialDays: total - full });
  const rows = [];
  for (let i = 1; i <= 12; i++) rows.push(day(i, 100 + i, 40 + (i % 5) * 3));
  const out = body({ allowed: true, points: rows, schoolDaysOnFile: 27 }, R, "full", {});

  check("every point carries a hit target", (out.match(/class="wc-rc-hit"/g) || []).length === rows.length,
    String((out.match(/class="wc-rc-hit"/g) || []).length));
  check("the hit target is larger than the dot, so a trackpad can reach it",
    /r="11"[^>]*class="wc-rc-hit"/.test(out) || /class="wc-rc-hit"/.test(out) && out.includes('r="11"'));
  // NO <title>: an SVG title is the accessible name but ALSO fires the
  // browser's own slow tooltip, so keeping it shows two tooltips at once.
  check("the old native <title> tooltip is gone", !out.includes("<title>"),
    "an svg <title> would show a second, slower tooltip saying something different");
  check("replaced by aria-label, so the accessible name survives",
    (out.match(/aria-label="2026-09-/g) || []).length === rows.length);
  check("and the label says where the point sits relative to the median",
    /above the median of|below the median of|on the median of/.test(out));
  check("points are keyboard reachable", (out.match(/tabindex="0"/g) || []).length === rows.length);

  // THE WHOLE DAY, not just the plotted series. A run chart of whole-day
  // absences still has to answer "and how many were partial".
  check("each point carries the whole day, not only the plotted value",
    /data-rc-full="/.test(out) && /data-rc-partial="/.test(out) && /data-rc-total="/.test(out));
  check("and its side of the median, so the tooltip need not recompute it",
    /data-rc-side="(above|below|on)"/.test(out));
  check("and whether it is inside a signal", /data-rc-signal="/.test(out));
  // NO GLOBAL ID: the tooltip is created by the renderer, so an id here would
  // be one dom-refs.test.mjs cannot verify against index.html -- and that
  // guard exists because a lookup for a missing element is a dead screen.
  check("the tooltip element is rendered with the chart", /class="wc-rc-tip"/.test(out));
  check("it is hidden until something is hovered", /class="wc-rc-tip"[^>]*hidden/.test(out));
  check("and it carries no global id for dom-refs to fail on", !out.includes('id="attRunTip"'));
  check("and announced politely rather than interrupting", /aria-live="polite"/.test(out));
  check("the plot is a positioned wrapper, since the svg scales with the card",
    /class="wc-rc-plot"/.test(out));

  // The values are numbers here, but a date comes from the SIS.
  const hostile = [day(1, 5, 2), day(2, 6, 3), day(3, 7, 4), day(4, 8, 5), day(5, 9, 6)];
  hostile[0].date = '2026-09-01" onmouseover="alert(1)';
  const evil = body({ allowed: true, points: hostile, schoolDaysOnFile: 5 }, R, "full", {});
  check("a hostile date cannot break out of an attribute",
    !evil.includes('onmouseover="alert(1)"') && evil.includes("&quot;"), evil.slice(0, 200));
}

console.log("\nthe hover handler, executed against a fake DOM");

{
  // The pattern that keeps catching real faults here: run it, do not read it.
  const start = script.indexOf("function wireRunChartHover() {");
  const end = script.indexOf("\n        async function renderAbsenceRunChart", start);
  const src = script.slice(start, end);

  const mkEl = (attrs) => {
    const a = Object.assign({}, attrs || {});
    return {
      _a: a, hidden: true, innerHTML: "", style: {},
      getAttribute: (k) => (a[k] === undefined ? null : a[k]),
      setAttribute: (k, v) => { a[k] = String(v); },
      getBoundingClientRect: () => ({ left: 100, top: 100, width: 20, height: 20 }),
    };
  };
  const listeners = {};
  const tip = mkEl({});
  const plot = mkEl({});
  plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 700, height: 220 });
  tip.getBoundingClientRect = () => ({ left: 0, top: 0, width: 160, height: 90 });
  const host = Object.assign(mkEl({}), {
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    querySelector: (sel) => (sel === ".wc-rc-plot" ? plot : sel === ".wc-rc-tip" ? tip : null),
  });
  const byId = { attRunChart: host };
  const wire = new Function("document", "escapeHtml",
    src + "\nreturn wireRunChartHover;")(
    { getElementById: (id) => byId[id] || null },
    (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));

  let threw = null;
  try { wire(); } catch (e) { threw = e; }
  check("wiring runs without throwing", threw === null, threw && (threw.message || String(threw)));
  check("it listens for mouse AND keyboard",
    listeners.mouseover && listeners.mouseout && listeners.focusin && listeners.focusout,
    Object.keys(listeners).join(","));
  check("and for Escape", Boolean(listeners.keydown));

  // ATTACHED ONCE. The chart's innerHTML is replaced on every toggle, so
  // binding per render would stack handlers for the life of the tab.
  const before = Object.values(listeners).reduce((n, a) => n + a.length, 0);
  wire(); wire(); wire();
  const after = Object.values(listeners).reduce((n, a) => n + a.length, 0);
  check("TEETH: re-wiring does not stack listeners", before === after, `${before} -> ${after}`);
  check("because the host is marked", host.getAttribute("data-hover-wired") === "1");

  // Hovering a real point fills the tooltip.
  const hit = mkEl({ "data-rc-i": "3", "data-rc-date": "2026-09-14", "data-rc-value": "60",
                     "data-rc-full": "60", "data-rc-partial": "50", "data-rc-total": "110",
                     "data-rc-side": "above", "data-rc-signal": "1" });
  let t2 = null;
  try { listeners.mouseover.forEach((fn) => fn({ target: hit })); } catch (e) { t2 = e; }
  check("hovering a point runs without throwing", t2 === null, t2 && (t2.message || String(t2)));
  check("the tooltip is shown", tip.hidden === false);
  check("it names the weekday, not just the date", /Mon|Tue|Wed|Thu|Fri|Sat|Sun/.test(tip.innerHTML),
    tip.innerHTML.slice(0, 120));
  check("it shows all three figures, not only the plotted one",
    tip.innerHTML.includes(">60<") && tip.innerHTML.includes(">50<") && tip.innerHTML.includes(">110<"));
  check("it says which side of the median the point is on", /Above the median/.test(tip.innerHTML));
  check("and flags a point that is part of a signal", /part of a signal/.test(tip.innerHTML));
  check("it is positioned within the plot, not off the card",
    parseFloat(tip.style.left) >= 4 && parseFloat(tip.style.left) <= 700 - 160 - 4,
    tip.style.left);

  // Leaving hides it again.
  listeners.mouseout.forEach((fn) => fn({ target: hit }));
  check("leaving the point hides the tooltip", tip.hidden === true);

  // Focus does the same, because a keyboard user has the same question.
  listeners.focusin.forEach((fn) => fn({ target: hit }));
  check("focusing a point shows it too", tip.hidden === false);
  listeners.keydown.forEach((fn) => fn({ key: "Escape" }));
  check("Escape closes it", tip.hidden === true);

  // Events from somewhere that is not a point must be ignored.
  const notAPoint = mkEl({});
  let t3 = null;
  try { listeners.mouseover.forEach((fn) => fn({ target: notAPoint })); } catch (e) { t3 = e; }
  check("an event from a non-point is ignored rather than throwing",
    t3 === null && tip.hidden === true, t3 && String(t3));
  let t4 = null;
  try { listeners.mouseover.forEach((fn) => fn({})); } catch (e) { t4 = e; }
  check("and an event with no target at all does not throw", t4 === null, t4 && String(t4));

  // A date parsed bare would be midnight UTC, which in Los Angeles is the
  // previous evening -- and would name the wrong weekday on a school chart.
  check("the date is parsed at noon, never bare", /\+ 'T12:00:00'/.test(src),
    "new Date('2026-09-14') is the previous evening in Los Angeles");
}


console.log("\nwhat a signal likely MEANS, which is a separate question from whether it is real");

{
  const B = R.absenceSignalBlurb;
  check("the reading is exported", typeof B === "function");
  const shift = (dir) => ({ rule: "shift", text: "7 points in a row " + dir + " the median." });
  const trend = (dir) => ({ rule: "trend", text: "5 points in a row moving " + dir + "." });
  const few = { rule: "runs", text: "Only 8 runs where 9 to 19 would be expected: drifting." };
  const many = { rule: "runs", text: "20 runs where 9 to 19 would be expected: alternating." };

  // A RISE READS DIFFERENTLY PER SERIES, because the action differs: whole-day
  // absence is a staying-away problem and partial-day absence is an arriving
  // problem, and telling a teacher the wrong one wastes their week.
  check("a rise in PARTIAL days is read as arriving late, not staying away",
    /arriving late/.test(B(shift("above"), "partial")));
  check("and points at the morning routine and first period",
    /morning routine/.test(B(shift("above"), "partial")) && /scheduled first/.test(B(shift("above"), "partial")));
  check("a rise in WHOLE days names illness and events before disengagement",
    /illness/.test(B(shift("above"), "full")) && /before reading it as disengagement/.test(B(shift("above"), "full")));
  check("and the two readings are genuinely different",
    B(shift("above"), "partial") !== B(shift("above"), "full"));

  // THE BORING EXPLANATION FIRST on any fall. A drop in recorded absence and a
  // drop in RECORDING look identical, and 1,631 of 5,563 registers carry no
  // attendance at all.
  ["full", "partial", "all"].forEach((w) => {
    const t = B(shift("below"), w);
    check(`a FALL in ${w} warns that recording can fall too`,
      /take the register|being recorded/.test(t), t.slice(0, 80));
    check(`and says to confirm before celebrating (${w})`, /before celebrating/.test(t));
  });

  check("a climbing trend is read as gradual, and contrasted with a one-off",
    /Gradual causes/.test(B(trend("up"), "full")) && /jump/.test(B(trend("up"), "full")));
  check("a falling trend asks for what changed to be written down",
    /writing down/.test(B(trend("down"), "full")), B(trend("down"), "full"));

  check("too few runs asks WHEN it moved rather than asserting a cause",
    /the useful question is WHEN/.test(B(few, "full")));
  // THE DAY-OF-WEEK TRAP is the likeliest cause of alternation here and a
  // reader would otherwise hunt for one that is not there.
  check("too many runs names the day-of-week trap first",
    /day of the week/.test(B(many, "full")) && /Mondays and Fridays/.test(B(many, "full")));
  check("and says how to separate them", /weekly totals|one weekday at a time/.test(B(many, "full")));

  // HONESTY PROPERTIES. A run chart establishes that something CHANGED and can
  // never say why; a reading that asserted a cause would be worse than none.
  const all = [B(shift("above"), "full"), B(shift("above"), "partial"), B(shift("below"), "full"),
               B(trend("up"), "full"), B(trend("down"), "full"), B(few, "full"), B(many, "full")];
  check("every reading is non-empty", all.every((t) => t && t.length > 40));
  // HEDGED, not merely free of one word. A first draft banned "because" and
  // failed on "because a chart cannot tell you later" -- which is the reading
  // DISCLAIMING a cause, the opposite of the thing being guarded against.
  check("none of them asserts a cause",
    all.every((t) => !/\bproves\b|\bcaused by\b|\bthis is due to\b/i.test(t)),
    all.find((t) => /\bproves\b|\bcaused by\b|\bthis is due to\b/i.test(t)));
  check("and every one of them hedges or names something to check",
    all.every((t) => /usually|likely|worth|check|question|rule out|before reading/i.test(t)),
    all.find((t) => !/usually|likely|worth|check|question|rule out|before reading/i.test(t)));
  check("an unknown rule returns nothing rather than inventing a reading",
    B({ rule: "mystery", text: "?" }, "full") === "");
  check("and a missing signal does not throw", B(null, "full") === "");

  // The generic rules must stay generic: the statistics module should not
  // acquire opinions about schools.
  const roster = js("./wildcat-roster.js");
  // Sliced to the END OF THE FUNCTION, not to the start of the next one: the
  // next function's doc comment sits in between and legitimately talks about
  // the school, which a first draft of this assertion flagged as the maths
  // acquiring opinions.
  const rsStart = roster.indexOf("function runChartSignals");
  const rules = roster.slice(rsStart, roster.indexOf("\n  /**", rsStart));
  check("runChartSignals itself says nothing about schools",
    !/school|teacher|register|illness|Monday/i.test(rules),
    "the maths must not quietly acquire domain opinions");
}

console.log("\nthe reading reaches the screen");

{
  const start = script.indexOf("function renderRunChartBody(res, R, which, settings)");
  const end = script.indexOf("\n        /**\n         * Show the day behind a point", start);
  const body = new Function("escapeHtml",
    script.slice(start, end) + "\nreturn renderRunChartBody;")(
    (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
  const day = (d, total, full) => ({ date: "2026-09-" + String(d).padStart(2, "0"),
    studentsAbsent: total, fullDaysStrict: full, misrecordDaysByGap: [0, 0, 0],
    partialDays: total - full });
  const rising = [];
  for (let i = 1; i <= 12; i++) rising.push(day(i, 60 + i * 5, 20 + i * 4));
  const out = body({ allowed: true, points: rising, schoolDaysOnFile: 12 }, R, "full", {});
  check("the rule and the reading are both rendered",
    /class="wc-rc-rule"/.test(out) && /class="wc-rc-why"/.test(out));
  check("and kept visibly apart, since one is statistics and one is judgement",
    out.indexOf('class="wc-rc-rule"') < out.indexOf('class="wc-rc-why"'));
  check("the reading is the domain one, not a restatement of the rule",
    /Gradual causes|illness|arriving late/.test(out), out.slice(0, 400));
  check("both classes are styled", css.includes(".wc-rc-rule") && css.includes(".wc-rc-why"));
}


console.log("\nthe chart goes stale on its own, without anyone pressing anything");

{
  // THE STALENESS THIS CLOSES. _attCache, _runCache and _ewCache are filled
  // once and were never invalidated, so a tab opened at 8am still showed 8am's
  // numbers at 2pm -- and 8am's numbers were the 6am sync, which runs BEFORE
  // school and therefore carries yesterday. Today's absences would not have
  // appeared at all until somebody pressed Refresh, and a fix that needs forty
  // people to remember a button is not a fix.
  const idle = script.slice(script.indexOf("Auto-refresh data from cloud only when inactive"),
                            script.indexOf("Background data sync complete"));
  check("the idle refresh drops the attendance cache", /_attCache = null;/.test(idle));
  check("and the run chart cache", /_runCache = null;/.test(idle));
  check("and the early warning cache", /_ewCache = null;/.test(idle));
  check("all three are dropped together, since all three read the same sync",
    (idle.match(/_(att|run|ew)Cache = null;/g) || []).length === 3);

  // ORDERING: the assignment sits ABOVE the `let` that declares each cache.
  // That is safe only because it runs inside an interval callback, which
  // fires long after the declaration has executed -- and it is worth pinning,
  // because moving it out of the callback would be a temporal dead zone.
  ["_attCache", "_runCache", "_ewCache"].forEach((name) => {
    const drop = script.indexOf(name + " = null;");
    const decl = script.indexOf("let " + name + " = null;");
    check(`${name} is dropped before its declaration, so it must stay inside a callback`,
      drop > 0 && decl > drop,
      "if this ever stops being true the comment explaining it is wrong, not the code");
  });
  check("and the reason is written down for whoever moves it",
    /A fix that needs forty people to remember to\s*\n\s*\/\/ press a button is not a fix/.test(script));

  // The explicit Refresh button stays: an admin who has just fixed something
  // upstream should not have to wait for a timer.
  check("the Refresh button still forces a fetch",
    /onclick="renderAbsenceRunChart\(true\)"/.test(html));
  check("and force bypasses the cache", /if \(_runCache && !force\) return _runCache;/.test(script));
}

console.log(`\nattendance run chart: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
