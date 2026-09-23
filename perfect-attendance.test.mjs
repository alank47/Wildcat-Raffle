// Perfect attendance: no missed classes, no tardies. Run: npm test
//
// WHY THIS FEATURE NEEDED NEW DATA RATHER THAN A NEW SCREEN. PowerSchool
// classifies a tardy as PRESENCE: PRESENT -- correctly, the child is in the
// room -- so psAttendanceDays counted a student marked late as having
// attended, and psAttendance carried only a per-term total. Measured against
// production on 2026-09-22, before any of this existed: of the 103 students
// with no absences at all this year, only 35 were also never once late.
//
// TWO THIRDS OF THIS LIST IS DECIDED BY TARDINESS. That single number is why
// the assertions below care so much about the tardy half being real: a school
// whose tardy code went unrecognised would hand out roughly three times too
// many awards, every list would still look plausible, and nobody would catch
// it. Several assertions exist only to make that failure loud.
//
// THE OTHER WAY IT GOES WRONG IS THE WINDOW. An award list is read out at an
// assembly, so it has to hold still: the owner chose the last COMPLETED
// Monday-to-Friday over a rolling five days and over the current week, because
// "this week" on a Monday morning is a one-day window nearly everyone wins.
import { readFileSync } from "node:fs";
import ts from "typescript";

const rosterSrc = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
const listSrc = readFileSync(new URL("./convex/attendanceList.ts", import.meta.url), "utf8");
const daysSrc = readFileSync(new URL("./convex/attendanceDays.ts", import.meta.url), "utf8");
const statsSrc = readFileSync(new URL("./convex/sisStats.ts", import.meta.url), "utf8");
const schemaSrc = readFileSync(new URL("./convex/schema.ts", import.meta.url), "utf8");
const htmlSrc = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const scriptSrc = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const cssSrc = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

// ---------------------------------------------------------------- the harness
// The shipped roster module, loaded for real. Nothing is copied: a change to
// wildcat-roster.js changes what runs here.
function loadRoster(transform) {
  let body = transform ? transform(rosterSrc) : rosterSrc;
  const sandbox = {};
  new Function("globalThis", body).call(sandbox, sandbox);
  return sandbox.WildcatRoster;
}
const R = loadRoster();

const student = (over) => Object.assign({
  studentNumber: "1001", firstName: "Ana", lastName: "Diaz", gradeLevel: "9",
  entryDate: "2026-08-12",
  absentDates: [], excusedAbsentDates: [], tardyDates: [], excusedTardyDates: [],
}, over || {});

console.log("\nTHE WINDOWS\n");
{
  // Tuesday 22 September 2026.
  const w = R.perfectWindows("2026-09-22", "2026-08-12");
  check("the week is the last COMPLETED Monday to Friday",
    w.week.from === "2026-09-14" && w.week.to === "2026-09-18",
    `${w.week.from} -> ${w.week.to}`);
  check("the month runs from the 1st to today",
    w.month.from === "2026-09-01" && w.month.to === "2026-09-22");
  check("the year runs from the school's own start date",
    w.year.from === "2026-08-12" && w.year.to === "2026-09-22");

  // THE REASON IT IS THE LAST COMPLETED WEEK. "This week" on a Monday is a
  // one-day window almost everybody wins, and a window ending today changes
  // under whoever is reading the list out.
  const mon = R.perfectWindows("2026-09-21", "2026-08-12");
  check("on Monday morning the week does NOT collapse to one day",
    mon.week.from === "2026-09-14" && mon.week.to === "2026-09-18",
    `${mon.week.from} -> ${mon.week.to}`);
  const fri = R.perfectWindows("2026-09-25", "2026-08-12");
  check("...and it is the same list all week, so an assembly can rely on it",
    fri.week.from === mon.week.from && fri.week.to === mon.week.to);
  const nextMon = R.perfectWindows("2026-09-28", "2026-08-12");
  check("...then rolls forward exactly one week on the next Monday",
    nextMon.week.from === "2026-09-21" && nextMon.week.to === "2026-09-25");

  // Sunday is day 0 in JS, which is the classic off-by-one here.
  const sun = R.perfectWindows("2026-09-20", "2026-08-12");
  check("a Sunday belongs to the week that just ended, not the next one",
    sun.week.from === "2026-09-14" && sun.week.to === "2026-09-18",
    `${sun.week.from} -> ${sun.week.to}`);
  const sat = R.perfectWindows("2026-09-19", "2026-08-12");
  check("...and so does a Saturday",
    sat.week.from === "2026-09-14" && sat.week.to === "2026-09-18",
    `${sat.week.from} -> ${sat.week.to}`);
  // The list must never go BACKWARDS as the clock ticks past Friday night.
  check("the window never moves backwards from one day to the next", (() => {
    let prev = null;
    for (const d of ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18",
                     "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"]) {
      const f = R.perfectWindows(d, "2026-08-12").week.from;
      if (prev && f < prev) return false;
      prev = f;
    }
    return true;
  })());

  check("the week is always five days", (() => {
    for (const d of ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24",
                     "2026-09-25", "2026-09-26", "2026-09-27"]) {
      const x = R.perfectWindows(d, "2026-08-12");
      const from = Date.parse(x.week.from + "T00:00:00Z"), to = Date.parse(x.week.to + "T00:00:00Z");
      if ((to - from) / 86400000 !== 4) return false;
    }
    return true;
  })());

  check("a month boundary does not leak into the previous month",
    R.perfectWindows("2026-10-01", "2026-08-12").month.from === "2026-10-01");
  check("a missing school-year start leaves the year window unusable rather than wrong",
    R.perfectWindows("2026-09-22", "").year.from === null);
  check("a junk date returns nothing at all", R.perfectWindows("not-a-date", "2026-08-12") === null);
}

console.log("\nWHO IS PERFECT\n");
{
  const w = R.perfectWindows("2026-09-22", "2026-08-12");

  check("a student with nothing against them is perfect",
    R.perfectVerdict(student(), w.year, {}).perfect === true);

  check("one absence breaks it",
    R.perfectVerdict(student({ absentDates: ["2026-09-16"] }), w.year, {}).perfect === false);

  // THE HALF THAT DID NOT EXIST BEFORE THIS FEATURE.
  const late = R.perfectVerdict(student({ tardyDates: ["2026-09-16"] }), w.year, {});
  check("ONE TARDY breaks it, with no absence at all", late.perfect === false);
  check("...and the screen can say which it was", late.brokenBy === "tardy" &&
    late.firstTardy === "2026-09-16" && late.absentDays === 0);

  check("a mark outside the window is ignored",
    R.perfectVerdict(student({ absentDates: ["2026-08-20"] }), w.week, {}).perfect === true);
  check("...and the same mark inside it is not",
    R.perfectVerdict(student({ absentDates: ["2026-09-16"] }), w.week, {}).perfect === false);
  check("the window is inclusive at both ends", (() => {
    const from = R.perfectVerdict(student({ absentDates: [w.week.from] }), w.week, {});
    const to = R.perfectVerdict(student({ absentDates: [w.week.to] }), w.week, {});
    return from.perfect === false && to.perfect === false;
  })());
  check("...and excludes the day after it ends",
    R.perfectVerdict(student({ absentDates: ["2026-09-21"] }), w.week, {}).perfect === true);

  check("both kinds of mark are reported together",
    R.perfectVerdict(student({ absentDates: ["2026-09-15"], tardyDates: ["2026-09-16"] }), w.week, {})
      .brokenBy === "both");
}

console.log("\nTHE EXCUSED SWITCH\n");
{
  const w = R.perfectWindows("2026-09-22", "2026-08-12");
  const excusedAbsence = student({ absentDates: ["2026-09-16"], excusedAbsentDates: ["2026-09-16"] });
  const excusedTardy = student({ tardyDates: ["2026-09-16"], excusedTardyDates: ["2026-09-16"] });

  // STRICT IS THE DEFAULT, and it is what an unset option means. A toggle that
  // silently defaults to the generous reading would inflate every list.
  check("strict is the default when nothing is passed",
    R.perfectVerdict(excusedAbsence, w.month, {}).perfect === false);
  check("...and when the option is explicitly true",
    R.perfectVerdict(excusedAbsence, w.month, { countExcused: true }).perfect === false);
  check("forgiving an excused ABSENCE lets them through",
    R.perfectVerdict(excusedAbsence, w.month, { countExcused: false }).perfect === true);
  check("forgiving an excused TARDY lets them through",
    R.perfectVerdict(excusedTardy, w.month, { countExcused: false }).perfect === true);

  // The switch must only forgive the marks actually flagged excused.
  const mixed = student({
    absentDates: ["2026-09-15", "2026-09-16"], excusedAbsentDates: ["2026-09-15"],
  });
  check("forgiving excused does NOT forgive an unexcused one on another day",
    R.perfectVerdict(mixed, w.month, { countExcused: false }).perfect === false);
  check("...and the remaining count is the unexcused one only",
    R.perfectVerdict(mixed, w.month, { countExcused: false }).absentDays === 1);
  check("an excused date not present in the absence list changes nothing",
    R.perfectVerdict(student({ excusedAbsentDates: ["2026-09-16"] }), w.month, { countExcused: false })
      .perfect === true);
}

console.log("\nENROLMENT IS A FENCE, NOT A FILTER\n");
{
  const w = R.perfectWindows("2026-09-22", "2026-08-12");
  // A student who enrolled on 2026-09-15 has no year to have been perfect
  // over. Standing them beside somebody with 28 clean days behind them
  // devalues it for everyone on the list.
  const newcomer = student({ studentNumber: "2002", entryDate: "2026-09-15" });
  const v = R.perfectVerdict(newcomer, w.year, {});
  check("a student who enrolled mid-year is not eligible for the year",
    v.eligible === false && v.perfect === false);
  check("...and the verdict says WHEN, so a screen can explain rather than just drop them",
    v.enrolledSince === "2026-09-15");
  // The week window begins 2026-09-14, so somebody who arrived on the 12th
  // WAS here for all of it and belongs on that list even though they cannot
  // be on the year one.
  const earlier = student({ studentNumber: "2003", entryDate: "2026-09-12" });
  check("...but they ARE eligible for a window that began after they arrived",
    R.perfectVerdict(earlier, w.year, {}).eligible === false &&
    R.perfectVerdict(earlier, w.week, {}).eligible === true &&
    R.perfectVerdict(earlier, w.week, {}).perfect === true);
  check("enrolling exactly on the first day of the window still counts",
    R.perfectVerdict(student({ entryDate: w.week.from }), w.week, {}).eligible === true);
  check("a missing enrolment date is not treated as 'arrived late'",
    R.perfectVerdict(student({ entryDate: undefined }), w.year, {}).eligible === true);
}

console.log("\nTHE LIST, AND ITS DENOMINATOR\n");
{
  const w = R.perfectWindows("2026-09-22", "2026-08-12");
  const rows = [
    student({ studentNumber: "1", lastName: "Alvarez", gradeLevel: "9" }),
    student({ studentNumber: "2", lastName: "Brown", gradeLevel: "10" }),
    student({ studentNumber: "3", lastName: "Chen", gradeLevel: "9", tardyDates: ["2026-09-16"] }),
    student({ studentNumber: "4", lastName: "Diaz", gradeLevel: "9", absentDates: ["2026-09-16"] }),
    student({ studentNumber: "5", lastName: "Evans", gradeLevel: "9",
              absentDates: ["2026-09-15"], tardyDates: ["2026-09-16"] }),
    student({ studentNumber: "6", lastName: "Flores", gradeLevel: "11", entryDate: "2026-09-15" }),
  ];
  const out = R.perfectList(rows, w.year, {});
  check("only the clean ones are listed", out.students.length === 2,
    out.students.map((s) => s.lastName).join(","));
  check("...and the late arrival is neither listed nor counted as a failure",
    out.counts.notEligible === 1 && out.counts.eligible === 5);
  check("the denominator is on the result, because '2 students' means nothing alone",
    out.counts.considered === 6 && out.counts.perfect === 2);
  check("the percentage is of the ELIGIBLE, not of everybody", out.counts.pct === 40,
    String(out.counts.pct));

  // The breakdown is what tells a headteacher WHY the list is short.
  check("it says how many missed out on lateness alone", out.counts.brokenByTardy === 1);
  check("...on absence alone", out.counts.brokenByAbsence === 1);
  check("...and on both", out.counts.brokenByBoth === 1);

  check("the list is ordered by grade then surname, so it can be read out",
    out.students.map((s) => s.lastName).join(",") === "Alvarez,Brown",
    out.students.map((s) => s.gradeLevel + ":" + s.lastName).join(","));
  check("grade 10 sorts after grade 9 rather than between 1 and 2", (() => {
    const many = [
      student({ studentNumber: "a", lastName: "Ten", gradeLevel: "10" }),
      student({ studentNumber: "b", lastName: "Nine", gradeLevel: "9" }),
      student({ studentNumber: "c", lastName: "Eleven", gradeLevel: "11" }),
    ];
    return R.perfectList(many, w.year, {}).students.map((s) => s.gradeLevel).join(",") === "9,10,11";
  })());

  check("an empty roster is an empty list and a zero percentage, not a crash",
    (() => { const e = R.perfectList([], w.year, {}); return e.students.length === 0 && e.counts.pct === 0; })());
  check("a null roster does not throw", R.perfectList(null, w.year, {}).students.length === 0);
}

console.log("\nTHE SERVER SIDE\n");
{
  // The shipped query, run against an in-memory database.
  function loadQuery(transform) {
    let body = listSrc
      .replace(/^import[\s\S]*?from\s*"[^"]*";[ \t]*\n/gm, "")
      .replace(/^export const /gm, "const ");
    if (transform) body = transform(body);
    const stubs = `
      const query = (d) => d;
      const v = new Proxy({}, { get: () => (...a) => ({ _v: true, a }) });
      let __me = { role: "admin", email: "a@b.org" };
      const requireStaff = async () => __me;
      const dayCount = (x) => (x === 0 || x ? Number(x) : null);
      const setMe = (m) => { __me = m; };
    `;
    const js = ts.transpileModule(stubs + body, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    return new Function(`${js}\nreturn { attendanceMarks, setMe };`)();
  }

  const marksRows = [
    { studentNumber: "1", firstName: "Ana", lastName: "Diaz", gradeLevel: "9",
      entryDate: "2026-08-12", absentDates: [], excusedAbsentDates: [],
      tardyDates: [], excusedTardyDates: [], syncedAt: "2026-09-22T16:00:00Z" },
    { studentNumber: "2", firstName: "Ben", lastName: "Cruz", gradeLevel: "10",
      entryDate: "2026-08-12", absentDates: ["2026-09-16"], excusedAbsentDates: [],
      tardyDates: [], excusedTardyDates: [], syncedAt: "2026-09-22T17:00:00Z" },
  ];
  const ctx = { db: { query: () => ({ take: async () => marksRows.slice() }) } };

  const Q = loadQuery();
  const ok = await Q.attendanceMarks.handler(ctx, {});
  check("an admin gets the rows", ok.allowed === true && ok.rows.length === 2);
  check("...carrying the dates the browser needs to decide any window",
    Array.isArray(ok.rows[0].absentDates) && Array.isArray(ok.rows[0].tardyDates) &&
    Array.isArray(ok.rows[0].excusedTardyDates));
  check("...and the newest sync time, so the screen can say how fresh it is",
    ok.lastSyncedAt === "2026-09-22T17:00:00Z", String(ok.lastSyncedAt));

  // The gate is the thing protecting a screen that DOES carry names, unlike
  // its neighbour, because an award list is a list of names by purpose.
  for (const role of ["admin", "superadmin", "pbis"]) {
    Q.setMe({ role });
    check(`${role} may read it`, (await Q.attendanceMarks.handler(ctx, {})).allowed === true);
  }
  for (const role of ["teacher", "campusaide"]) {
    Q.setMe({ role });
    const res = await Q.attendanceMarks.handler(ctx, {});
    check(`${role} may NOT -- the same rows say who was absent and when`, res.allowed === false);
    check(`...and ${role} is told how to get access, not just refused`,
      /access level/i.test(String(res.reason)));
    check(`...and no row leaks with the refusal`, res.rows.length === 0);
  }

  check("the gate is the SAME list the absence ranking uses",
    /const ATTENDANCE_ROLES = \["admin", "superadmin", "pbis"\]/.test(listSrc));
}

console.log("\nTHE PIPELINE THAT FILLS IT\n");
{
  check("a row is written for EVERY enrolled student, not just the marked ones",
    /\[\.\.\.new Set\(numberOf\.values\(\)\)\]/.test(daysSrc),
    "a table holding only absent students cannot name a perfect one");
  check("tardy codes are derived from the school's descriptions, not a letter list",
    /tardy.*test\(desc\)|\/tardy\/i\.test\(desc\)/.test(daysSrc));
  check("a school with NO recognised tardy code is reported, not assumed punctual",
    /tardyCodesFound/.test(daysSrc) && /will look punctual/.test(daysSrc));
  check("the code mapping is returned with the run, so a renamed code is visible",
    /summary\.codeMapping = codeMap/.test(daysSrc));
  check("marks are taken BEFORE the section join, so an unplaceable absence still counts",
    (() => {
      const i = daysSrc.indexOf("MARKS ARE TAKEN BEFORE THE SLOT MAP");
      const j = daysSrc.indexOf("if (!slot) { unmappedCc++; continue; }");
      return i > 0 && j > i;
    })(), "otherwise a child absent in an unmapped section lands on an award list");
  check("the enrolment date is read from PowerSchool",
    /student_number,entrydate/.test(daysSrc));
  check("the writer clears in pages, like its neighbours",
    /replaceAttendanceMarks/.test(statsSrc) && /moreToClear/.test(statsSrc));
  check("the table exists with the indexes the query walks",
    /psAttendanceMarks: defineTable\(/.test(schemaSrc) &&
    /\.index\("by_studentNumber", \["studentNumber"\]\)/.test(
      schemaSrc.slice(schemaSrc.indexOf("psAttendanceMarks: defineTable("))));
  check("excused dates are stored SEPARATELY rather than subtracted on the server",
    /excusedAbsentDates: v\.array\(v\.string\(\)\)/.test(schemaSrc) &&
    /excusedTardyDates: v\.array\(v\.string\(\)\)/.test(schemaSrc),
    "the switch lives in the browser, so the server must keep both facts");
}

console.log("\nTHE SCREEN\n");
{
  for (const id of ["attPerfectBody", "attPerfectWindow", "attPerfectExcused", "attPerfectGrade"]) {
    check(`#${id} exists in the markup`, htmlSrc.includes(`id="${id}"`));
  }
  check("the excused box is CHECKED in the markup, so strict is what loads",
    /id="attPerfectExcused"[\s\S]{0,60}checked/.test(htmlSrc));
  check("all three windows have a button",
    ["week", "month", "year"].every((k) => htmlSrc.includes(`setPerfectWindow('${k}')`)));
  check("the panel is drawn when the Attendance tab opens",
    /subtab === 'attendance'\)\s*\{[\s\S]{0,320}setAttendanceView\(_attView\)/.test(scriptSrc) &&
    /function setAttendanceView[\s\S]{0,2600}if \(_attView === 'perfect'\) renderPerfectAttendance\(\);/
      .test(scriptSrc));
  check("its cache is dropped on the idle refresh, like the other three",
    /_paCache = null/.test(scriptSrc),
    "staff are never asked to hard refresh, so a stale panel must expire itself");
  check("the renderer guards the FETCH, not the whole function",
    (() => {
      const i = scriptSrc.indexOf("async function renderPerfectAttendance");
      const body = scriptSrc.slice(i, i + 3000);
      return /if \(_paBusy\) return;/.test(body) && /if \(!res \|\| force\)/.test(body);
    })(), "guarding the render drops a click that arrives mid-load");
  check("the denominator is printed, not just the winners",
    /of ' \+ c\.eligible \+ ' students/.test(scriptSrc));
  check("the screen says how many lost it on lateness alone",
    /brokenByTardy/.test(scriptSrc));
  check("students who enrolled late are explained, not silently dropped",
    /enrolled after this period began/.test(scriptSrc));
  check("every cache stamp still matches",
    (() => {
      const stamps = [...htmlSrc.matchAll(/\?v=([0-9a-z]+)/g)].map((m) => m[1]);
      return stamps.length > 0 && new Set(stamps).size === 1;
    })(), [...new Set([...htmlSrc.matchAll(/\?v=([0-9a-z]+)/g)].map((m) => m[1]))].join(","));
}

console.log("\nTHE VIEW SWITCH\n");
{
  // It shipped at the BOTTOM of the tab: under the basis card, the run chart,
  // four tier cards and a list of up to 671 children. Reaching the one panel
  // on the screen that is good news meant scrolling past every child the
  // school is worried about, which made it effectively unreachable.
  const switchAt = htmlSrc.indexOf('id="attViewSwitch"');
  check("the switch exists", switchAt > 0);
  check("...and is ABOVE everything it switches between",
    switchAt < htmlSrc.indexOf('class="wc-card wc-att-basis"') &&
    switchAt < htmlSrc.indexOf('id="attRunChart"') &&
    switchAt < htmlSrc.indexOf('id="attTierCards"') &&
    switchAt < htmlSrc.indexOf('id="attPerfectBody"'),
    "a switch below the thing it reveals is the problem it was added to fix");
  check("both halves have a button",
    /data-attview="watch"/.test(htmlSrc) && /data-attview="perfect"/.test(htmlSrc));

  check("the two halves are wrapped separately",
    /id="attWatchView"/.test(htmlSrc) && /id="attPerfectView"/.test(htmlSrc));
  check("the absence half is the one that loads",
    /<div id="attWatchView">/.test(htmlSrc) && /<div id="attPerfectView" hidden>/.test(htmlSrc),
    "somebody opening Attendance Watch expects the absence list");
  check("the script agrees on that default", /let _attView = 'watch';/.test(scriptSrc));

  // THE 2026-09-08 TRAP. `hidden` is a user-agent rule and loses to ANY author
  // declaration that sets display, which is how a red unsaved-referral bar
  // shipped visible to every user on launch morning. A wrapper with no class
  // of its own cannot be caught by it. (hidden-attribute.test.mjs enforces the
  // general rule; this pins the specific decision.)
  check("the toggled wrappers carry no class that could set display",
    !/<div id="attWatchView" [^>]*class=/.test(htmlSrc) &&
    !/<div id="attPerfectView"[^>]*class=/.test(htmlSrc),
    "an author display rule silently defeats the hidden attribute");

  const switcher = (() => {
    const i = scriptSrc.indexOf("function setAttendanceView");
    return scriptSrc.slice(i, i + 2600);
  })();
  check("the switch function was found", switcher.length > 500);
  check("it toggles BOTH halves, so they cannot both show",
    /watchEl\.hidden = \(_attView !== 'watch'\)/.test(switcher) &&
    /perfectEl\.hidden = \(_attView !== 'perfect'\)/.test(switcher));
  check("...and announces the state, not just colours a button",
    /setAttribute\('aria-pressed'/.test(switcher),
    "two buttons are not a tablist, so the state has to be spoken");
  check("...and swaps the subtitle, so the page says which question it answers",
    /attViewSubtitle/.test(switcher) && /ATT_VIEW_SUBTITLES/.test(scriptSrc));
  // The switch grew a third view on 2026-09-22 (by student group), so the
  // fallback is now a membership test rather than a two-way ternary. The
  // invariant is unchanged: an unrecognised view shows the absence list.
  check("anything unrecognised falls back to the absence list",
    /ATT_VIEWS\.indexOf\(view\) === -1 \? 'watch' : view/.test(switcher),
    "an unknown view must not leave the tab blank");
  check("...and the absence list is a member of that set",
    /ATT_VIEWS = \['watch'/.test(scriptSrc));

  check("the header Refresh aims at whichever half is showing",
    /onclick="refreshAttendanceView\(\)"/.test(htmlSrc) &&
    /function refreshAttendanceView[\s\S]{0,400}renderPerfectAttendance\(true\)[\s\S]{0,200}renderAttendanceWatch\(true\)/
      .test(scriptSrc),
    "a Refresh that reloads the hidden half does nothing a reader can see");

  check("every class the switch uses is defined in the stylesheet",
    ["wc-att-views"].every((c) => cssSrc.includes("." + c)));
}

console.log("\nDO THE ASSERTIONS HAVE TEETH?\n");
{
  // 1. Stop counting tardies. Two thirds of the real list depends on this.
  const broken = loadRoster((body) => {
    const before = body;
    body = body.replace("var tardies = datesInWindow(r.tardyDates, win);", "var tardies = [];");
    if (body === before) throw new Error("teeth 1: anchor moved");
    return body;
  });
  const w = broken.perfectWindows("2026-09-22", "2026-08-12");
  check("TEETH: with tardies ignored, a late student is wrongly called perfect",
    broken.perfectVerdict(student({ tardyDates: ["2026-09-16"] }), w.year, {}).perfect === true);
}
{
  // 2. Make the week the CURRENT one instead of the last completed one.
  const broken = loadRoster((body) => {
    const before = body;
    body = body.replace("var lastMonday = weekend ? thisMonday : shiftDays(thisMonday, -7);",
      "var lastMonday = thisMonday;");
    if (body === before) throw new Error("teeth 2: anchor moved");
    return body;
  });
  const w = broken.perfectWindows("2026-09-21", "2026-08-12");
  check("TEETH: a current-week window is caught", w.week.from === "2026-09-21");
}
{
  // 3. Default the excused switch to forgiving.
  const broken = loadRoster((body) => {
    const before = body;
    body = body.replace("var countExcused = o.countExcused !== false;", "var countExcused = o.countExcused === true;");
    if (body === before) throw new Error("teeth 3: anchor moved");
    return body;
  });
  const w = broken.perfectWindows("2026-09-22", "2026-08-12");
  check("TEETH: a switch defaulting to forgiving is caught",
    broken.perfectVerdict(
      student({ absentDates: ["2026-09-16"], excusedAbsentDates: ["2026-09-16"] }), w.month, {},
    ).perfect === true);
}
{
  // 4. Drop the enrolment fence.
  const broken = loadRoster((body) => {
    const before = body;
    body = body.replace("if (/^\\d{4}-\\d{2}-\\d{2}$/.test(entry) && win && win.from && entry > win.from) {",
      "if (false) {");
    if (body === before) throw new Error("teeth 4: anchor moved");
    return body;
  });
  const w = broken.perfectWindows("2026-09-22", "2026-08-12");
  check("TEETH: a student who enrolled last week landing on the year list is caught",
    broken.perfectVerdict(student({ entryDate: "2026-09-15" }), w.year, {}).perfect === true);
}

{
  // Leave the absence half showing when perfect attendance is selected, which
  // is the switch doing nothing at all.
  const broken = scriptSrc.replace(
    "if (watchEl) watchEl.hidden = (_attView !== 'watch');", "");
  check("TEETH: a switch that never hides the absence half is caught",
    broken !== scriptSrc &&
    !/watchEl\.hidden = \(_attView !== 'watch'\)/.test(
      broken.slice(broken.indexOf("function setAttendanceView"),
                   broken.indexOf("function setAttendanceView") + 2600)));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
