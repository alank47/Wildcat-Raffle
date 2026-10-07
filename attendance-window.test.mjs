// Attendance Watch, "Who is missing", by WEEK and by MONTH. Run: npm test
//
// ASKED FOR 2026-09-23: "can you give attendance watch a filter by week and
// by month? particularly for the who is missing part". The year to date stays
// the default and keeps its chronic tiers; a week or a month is a different
// question -- who was OUT -- and these tests hold it to three rules:
//
//   1. THE DAYS ARE REAL. A window counts only the days school ran (a date
//      with attendance on record), never weekdays, and never a date after
//      today: PowerSchool holds absences entered ahead of time (measured to
//      2026-10-09 on 2026-09-23).
//   2. NO CHRONIC LABELS. In a five-day week one absence is 20%, so the year's
//      "severe" would name every absent child. Plain bands instead.
//   3. ONE RULE FOR A WHOLE DAY. The week/month split and the year's split
//      classify the same per-date rows with the same function.
//
// Measured on production data before this shipped (read-only):
//   this week (3 days)  172 missed a day, 30 every day, 244 late
//   last week (5 days)  233 missed a day, 11 every day, 302 late
//   this month (15)     398 missed a day
// and the per-date marks agree with PowerSchool's own year-to-date total for
// 616 of 618 students, against 603 for the per-period records -- which is why
// the day counts come from the marks and the full-day split is shown only
// where it covers every absent day.
import { readFileSync } from "node:fs";
import ts from "typescript";

const rosterSrc = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
const listSrc = readFileSync(new URL("./convex/attendanceList.ts", import.meta.url), "utf8");
const rulesSrc = readFileSync(new URL("./convex/absenceDayRules.ts", import.meta.url), "utf8");
const daysSrc = readFileSync(new URL("./convex/attendanceDays.ts", import.meta.url), "utf8");
const htmlSrc = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

// The shipped roster module, loaded for real.
const sandbox = {};
new Function("globalThis", rosterSrc).call(sandbox, sandbox);
const R = sandbox.WildcatRoster;

const tsx = (src) => ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const rulesMod = (() => { const m = { exports: {} }; new Function("module", "exports", tsx(rulesSrc))(m, m.exports); return m.exports; })();
// THE REAL ACCESS RULE, not a stand-in: who may read the whole-school lists is
// decided by accessRules.ts canReadInsights, and a fake here would test the fake.
const accessSrc = readFileSync(new URL("./convex/accessRules.ts", import.meta.url), "utf8");
const accessMod = (() => { const m = { exports: {} }; new Function("module", "exports", tsx(accessSrc))(m, m.exports); return m.exports; })();

console.log("\nWHICH DATES MAKE A WEEK AND A MONTH\n");
{
  const w = R.absenceWindows("2026-09-23");          // a Wednesday
  check("this week runs Monday to YESTERDAY -- today's attendance is still being taken",
    w.thisWeek.from === "2026-09-21" && w.thisWeek.to === "2026-09-22" && w.thisWeek.capped === true,
    `${w.thisWeek.from}..${w.thisWeek.to}`);
  check("last week is the previous Monday to Friday, complete", w.lastWeek.from === "2026-09-14" && w.lastWeek.to === "2026-09-18"
    && w.lastWeek.capped === false);
  check("this month runs from the 1st to yesterday", w.thisMonth.from === "2026-09-01" && w.thisMonth.to === "2026-09-22");
  check("last month is the whole of the previous month", w.lastMonth.from === "2026-08-01" && w.lastMonth.to === "2026-08-31");
  const mon = R.absenceWindows("2026-09-21");
  check("on a Monday, this week has no completed day yet (an empty window, not a wrong one)",
    mon.thisWeek.from > mon.thisWeek.to);
  const stale = R.absenceWindows("2026-09-23", "2026-09-21");
  check("when the server says only Monday is complete, this week ends on Monday",
    stale.thisWeek.to === "2026-09-21" && stale.thisMonth.to === "2026-09-21");
  check("...and a 'complete through' later than yesterday is never believed",
    R.absenceWindows("2026-09-23", "2026-09-30").thisWeek.to === "2026-09-22");
  // ONE RULE FOR "LAST WEEK" (2026-10-07): on a weekend it is the week just
  // finished, the same week Perfect attendance calls "Last week". It used to
  // be the week before, so the two tabs named different weeks on a Sunday.
  const sat = R.absenceWindows("2026-09-26");
  check("on a Saturday, last week is the Monday-to-Friday just finished",
    sat.lastWeek.from === "2026-09-21" && sat.lastWeek.to === "2026-09-25");
  check("...the same week as Perfect attendance's 'Last week'",
    R.perfectWindows("2026-09-26", "2026-08-12").week.from === sat.lastWeek.from
    && R.perfectWindows("2026-09-26", "2026-08-12").week.label === "Last week");
  check("...and 'This week so far' is the coming week, with no finished day yet",
    sat.thisWeek.from === "2026-09-28" && sat.thisWeek.from > sat.thisWeek.to);
  const ny = R.absenceWindows("2026-01-02");
  check("across New Year, last month is December of the year before",
    ny.lastMonth.from === "2025-12-01" && ny.lastMonth.to === "2025-12-31" && ny.thisWeek.from === "2025-12-29");
  const leap = R.absenceWindows("2028-03-10");
  check("a leap February ends on the 29th", leap.lastMonth.to === "2028-02-29");
  check("a date that cannot be read gives no windows, not a wrong one", R.absenceWindows("not a date") === null);
}

console.log("\nCOUNTING A WINDOW\n");
{
  const win = { key: "thisWeek", from: "2026-09-21", to: "2026-09-23", label: "This week" };
  const school = ["2026-09-21", "2026-09-22", "2026-09-23"];
  const mk = (n, o) => Object.assign({ studentNumber: n, entryDate: "2026-08-12", absentDates: [], tardyDates: [] }, o || {});
  const marks = [
    mk("A", { absentDates: ["2026-09-21", "2026-09-22", "2026-09-23"] }),
    mk("B", { absentDates: ["2026-09-22", "2026-09-22", "2026-09-30"], tardyDates: ["2026-09-21"] }),
    mk("C", { absentDates: ["2026-09-18"] }),
    mk("D", { entryDate: "2026-09-23", absentDates: ["2026-09-23"] }),
    mk("E", { absentDates: ["2026-09-21", "2026-09-22"] }),
  ];
  const out = R.windowAbsenceList(marks, school, win);
  const by = Object.fromEntries(out.rows.map((r) => [r.studentNumber, r]));
  check("absent every school day is 'Every day'", by.A.band.key === "every" && by.A.daysAbsent === 3 && by.A.schoolDays === 3);
  check("a date entered AHEAD of time (30 Sep) is not counted", by.B.daysAbsent === 1, JSON.stringify(by.B.absentDates));
  check("...nor is the same date twice", by.B.absentDates.length === 1);
  check("a tardy in the window is counted", by.B.daysTardy === 1);
  check("an absence before the window is not in it", by.C.daysAbsent === 0 && by.C.band.key === "none");
  check("a student who enrolled mid-week is counted from the day they started (1 of 1, not 1 of 3)",
    by.D.schoolDays === 1 && by.D.daysAbsent === 1 && by.D.band.key === "every" && by.D.enrolledSince === "2026-09-23");
  check("two of three days is 'Half or more'", by.E.band.key === "half");
  check("one of three is 'Missed a day'", R.windowBand(1, 3).key === "some");
  check("no rate ever passes 100%", out.rows.every((r) => r.rate <= 1));
  check("ranked worst first: most days absent at the top", out.rows[0].studentNumber === "A" && out.rows[1].studentNumber === "E",
    out.rows.map((r) => r.studentNumber).join());
  check("the counts add up to the students considered",
    out.counts.every + out.counts.half + out.counts.some + out.counts.none === out.counts.considered && out.counts.considered === 5);
  const none = R.windowAbsenceList(marks, [], win);
  check("a window with no school days yet puts nobody in a band but 'No absences'",
    none.rows.every((r) => r.band.key === "none" && r.schoolDays === 0));
  // ENROLMENT, both ways (review 2026-09-23).
  const later = R.windowAbsenceList([mk("L", { entryDate: "2026-10-01" })], school, win);
  check("a student who enrolled AFTER the window is not in it at all (not '0 of 0', which read as a perfect week)",
    later.rows.length === 0 && later.counts.considered === 0);
  const reentry = R.windowAbsenceList([mk("Q", { entryDate: "2026-09-23", absentDates: ["2026-09-21"] })], school, win);
  check("an absence PowerSchool recorded before a re-entry date is counted, from that day",
    reentry.rows[0].daysAbsent === 1 && reentry.rows[0].schoolDays === 3);
}

console.log("\nONE RULE FOR A WHOLE DAY, SHARED BY THE YEAR AND THE WINDOW\n");
{
  // THE REFERENCE is the loop the per-date rebuild ran inline until today,
  // kept here verbatim as the specification the shared function must match.
  const reference = (rows) => {
    const t = { absentDays: 0, fullDaysStrict: 0, misrecordDaysByGap: [0, 0, 0], partialDays: 0, assumedPresentDays: 0 };
    for (const r of rows) {
      t.absentDays++;
      const gap = r.blocksThatDay - r.absentBlocks;
      if (gap <= 0) { t.fullDaysStrict++; continue; }
      if (r.presentBlocks >= gap) {
        const i = gap <= 1 ? 0 : gap === 2 ? 1 : 2;
        t.misrecordDaysByGap[i]++;
      } else {
        t.partialDays++;
        if (r.presentBlocks === 0 && r.unrecordedBlocks > 0) t.assumedPresentDays++;
      }
    }
    return t;
  };
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let same = true;
  for (let trial = 0; trial < 400 && same; trial++) {
    const rows = Array.from({ length: 1 + rnd(12) }, () => {
      const blocks = 1 + rnd(10), absent = 1 + rnd(blocks), rest = blocks - absent;
      const present = rnd(rest + 2), unrec = Math.max(0, rest - present);
      return { blocksThatDay: blocks, absentBlocks: absent, presentBlocks: present, unrecordedBlocks: unrec };
    });
    const a = reference(rows);
    const b = rows.reduce((t, r) => rulesMod.addAbsenceDay(t, r), rulesMod.emptyAbsenceSplit());
    if (JSON.stringify(a) !== JSON.stringify(b)) { same = false; console.log("   differs:", JSON.stringify(rows), a, b); }
  }
  check("the shared rule gives exactly what the rebuild's own loop gave, on 400 random students", same);
  check("the per-date rebuild now calls the shared rule, not a copy of it",
    /import \{ addAbsenceDay, emptyAbsenceSplit, type AbsenceSplit \} from "\.\/absenceDayRules";/.test(daysSrc)
    && /addAbsenceDay\(t, r\);/.test(daysSrc) && !/t\.fullDaysStrict\+\+; continue;/.test(daysSrc.split("PER-STUDENT TOTALS")[1].split("and the same thing per DAY")[0]));
  check("...and the window query calls the same one", /addAbsenceDay\(sp, r\);/.test(listSrc));
}

console.log("\nTHE SERVER'S WINDOW QUERY\n");
{
  let me = { role: "pbis" };
  const stubs = {
    "./_generated/server": { query: (d) => d, internalQuery: (d) => d, mutation: (d) => d },
    "convex/values": { v: new Proxy({}, { get: () => () => ({}) }) },
    "./identity": { requireStaff: async () => me },
    "./views": { dayCount: (n) => (typeof n === "number" ? n : null) },
    "./absenceDayRules": rulesMod,
    "./accessRules": accessMod,
  };
  const mod = { exports: {} };
  new Function("require", "module", "exports", tsx(listSrc))((n) => { if (!stubs[n]) throw new Error("no " + n); return stubs[n]; }, mod, mod.exports);
  const q = mod.exports.absenceWindow;

  const day = (n, date, o) => Object.assign({ studentNumber: n, date, blocksThatDay: 6, absentBlocks: 6, presentBlocks: 0, unrecordedBlocks: 0, syncedAt: "2026-09-23T13:00:00Z" }, o || {});
  const makeDb = (tables, reads) => ({
    query(name) {
      let rows = (tables[name] || []).slice();
      const api = {
        withIndex(idx, fn) {
          const c = { lo: null, hi: null, gte(f, v) { c.lo = v; return c; }, lte(f, v) { c.hi = v; return c; } };
          fn(c);
          rows = rows.filter((r) => (c.lo === null || r.date >= c.lo) && (c.hi === null || r.date <= c.hi));
          reads.push({ name, idx, lo: c.lo, hi: c.hi });
          return api;
        },
        async take(k) { return rows.slice(0, k); },
        async first() { return rows[0] ?? null; },
      };
      return api;
    },
  });
  const tables = {
    psAttendanceDays: [
      day("A", "2026-09-21"), day("A", "2026-09-22", { absentBlocks: 2, presentBlocks: 0, unrecordedBlocks: 4 }),
      day("B", "2026-09-22"), day("B", "2026-09-30"), day("C", "2026-09-10"),
    ],
    psAbsenceDayTotals: ["2026-09-18", "2026-09-21", "2026-09-22", "2026-09-30"].map((date) => ({ date, syncedAt: "2026-09-24T13:30:00Z" })),
  };
  const reads = [];
  const res = await q.handler({ db: makeDb(tables, reads) }, { from: "2026-09-21", to: "2026-09-25", today: "2026-09-24" });
  const by = Object.fromEntries(res.rows.map((r) => [r.studentNumber, r.split]));
  check("it answers for the window", res.allowed === true && res.from === "2026-09-21");
  check("...and stops at the last COMPLETE day: yesterday, and nothing entered for 30 Sep is read",
    res.to === "2026-09-23" && res.through === "2026-09-23" && by.B.absentDays === 1 && !res.schoolDays.includes("2026-09-30"));
  check("its school days are the days attendance was taken in the window", JSON.stringify(res.schoolDays) === JSON.stringify(["2026-09-21", "2026-09-22"]));
  {
    // TODAY IS NEVER READ: before school its only rows are absences entered
    // ahead; at lunchtime it is half taken.
    const t2 = { psAttendanceDays: [day("A", "2026-09-21"), day("Z", "2026-09-23")],
                 psAbsenceDayTotals: [{ date: "2026-09-21", syncedAt: "2026-09-23T13:30:00Z" }, { date: "2026-09-23", syncedAt: "2026-09-23T13:30:00Z" }] };
    const r2 = await q.handler({ db: makeDb(t2, []) }, { from: "2026-09-21", to: "2026-09-25", today: "2026-09-23" });
    check("today is not a school day yet, whatever was entered ahead for it",
      r2.through === "2026-09-22" && !r2.schoolDays.includes("2026-09-23") && !r2.rows.some((x) => x.studentNumber === "Z"));
    // Before the morning rebuild has run, yesterday is still the lunchtime snapshot.
    const t3 = { psAttendanceDays: [day("A", "2026-09-21"), day("Y", "2026-09-22")],
                 psAbsenceDayTotals: [{ date: "2026-09-21", syncedAt: "2026-09-22T19:30:00Z" }, { date: "2026-09-22", syncedAt: "2026-09-22T19:30:00Z" }] };
    const r3 = await q.handler({ db: makeDb(t3, []) }, { from: "2026-09-21", to: "2026-09-25", today: "2026-09-23" });
    check("before the morning rebuild, yesterday is not complete either: the window ends the day before",
      r3.through === "2026-09-21" && r3.schoolDays.join() === "2026-09-21" && !r3.rows.some((x) => x.studentNumber === "Y"));
  }
  check("whole and partial days use the shared rule", by.A.fullDaysStrict === 1 && by.A.partialDays === 1 && by.A.assumedPresentDays === 1);
  check("a student absent only outside the window is not in it", !by.C);
  check("it reads BY DATE through the index, not the whole table",
    reads.filter((r) => r.name === "psAttendanceDays").every((r) => r.idx === "by_date" && r.lo === "2026-09-21" && r.hi === "2026-09-23"));
  check("numbers and the complete-through day only", typeof res.through === "string");
  check("numbers only: no names cross the wire", res.rows.every((r) => Object.keys(r).join() === "studentNumber,split"));

  me = { role: "teacher" };
  const refusedReads = [];
  const refused = await q.handler({ db: makeDb(tables, refusedReads) }, { from: "2026-09-21", to: "2026-09-25", today: "2026-09-23" });
  check("a teacher is refused, as the year list refuses them", refused.allowed === false && refused.rows.length === 0);
  check("...before a single attendance row is read", refusedReads.length === 0, JSON.stringify(refusedReads));

  // THE PER-PERSON GRANT (2026-09-30, Attendance Watch for one campus aide).
  // It opens this list to the ONE person an admin marked, and to nobody else
  // of that role: an aide or teacher without it is refused exactly as before.
  const askAs = async (who) => {
    me = who;
    const rd = [];
    const r = await q.handler({ db: makeDb(tables, rd) }, { from: "2026-09-21", to: "2026-09-25", today: "2026-09-24" });
    return { r, rd };
  };
  const aide = await askAs({ role: "campusaide" });
  check("a campus aide WITHOUT the grant is refused, and nothing is read",
    aide.r.allowed === false && aide.r.rows.length === 0 && aide.r.schoolDays.length === 0 && aide.rd.length === 0);
  const aideOff = await askAs({ role: "campusaide", attendanceWatch: false });
  check("...and one whose grant was switched off is refused too", aideOff.r.allowed === false && aideOff.r.rows.length === 0 && aideOff.rd.length === 0);
  const aideStr = await askAs({ role: "campusaide", attendanceWatch: "true" });
  check("...and only a real true opens it: the string \"true\" does not", aideStr.r.allowed === false && aideStr.r.rows.length === 0 && aideStr.rd.length === 0);
  const teachOff = await askAs({ role: "teacher", attendanceWatch: false });
  check("a teacher without the grant is still refused", teachOff.r.allowed === false && teachOff.r.rows.length === 0 && teachOff.rd.length === 0);
  const aideOn = await askAs({ role: "campusaide", attendanceWatch: true });
  check("a campus aide WITH the grant gets the window, the same answer PBIS got",
    aideOn.r.allowed === true && aideOn.r.rows.length > 0 && JSON.stringify(aideOn.r) === JSON.stringify(res),
    JSON.stringify(aideOn.r).slice(0, 160));
  const teachOn = await askAs({ role: "teacher", attendanceWatch: true });
  check("a teacher WITH the grant gets it too, the same answer PBIS got",
    teachOn.r.allowed === true && JSON.stringify(teachOn.r) === JSON.stringify(res));
  check("the query asks the shared rule, not its own role list",
    /if \(!canReadInsights\(staff\)\)/.test(listSrc.split("export const absenceWindow")[1].split("export const ")[0])
    && /import \{ canReadInsights \} from "\.\/accessRules";/.test(listSrc));
  me = { role: "admin" };
  const future = await q.handler({ db: makeDb(tables, []) }, { from: "2026-09-28", to: "2026-10-02", today: "2026-09-23" });
  check("a window that has not started is empty, not an error", future.allowed === true && future.rows.length === 0 && future.schoolDays.length === 0);
  const long = await q.handler({ db: makeDb(tables, []) }, { from: "2026-01-01", to: "2026-09-23", today: "2026-09-23" });
  check("anything longer than two months is sent to Year to date", long.allowed === false && /two months/.test(long.reason));
  const bad = await q.handler({ db: makeDb(tables, []) }, { from: "yesterday", to: "2026-09-23", today: "2026-09-23" });
  check("a date it cannot read is refused", bad.allowed === false);
  const many = { psAttendanceDays: Array.from({ length: 4001 }, (_, i) => day("S" + i, "2026-09-22")), psAbsenceDayTotals: [{ date: "2026-09-22", syncedAt: "2026-09-23T13:30:00Z" }] };
  const big = await q.handler({ db: makeDb(many, []) }, { from: "2026-09-21", to: "2026-09-23", today: "2026-09-23" });
  check("past its read limit it says so (truncated) rather than quietly under-counting", big.truncated === true);
}

console.log("\nTHE SCREEN\n");
{
  // ITS OWN TAB since 2026-10-07: "Week or month", which shares one pane with
  // Year so far (the tab's data-attview says which section shows).
  const sec = htmlSrc.slice(htmlSrc.indexOf('<section data-asec="window">'), htmlSrc.indexOf('</div><!-- /attWatchView -->'));
  check("the period picker is at the top of Week or month, last week pressed",
    sec.indexOf('id="attWinPick"') > 0 && sec.indexOf('id="attWinPick"') < sec.indexOf('id="attWinTable"')
    && /data-attwin="lastWeek" aria-pressed="true"/.test(sec));
  for (const k of ["lastDay", "lastWeek", "thisWeek", "lastMonth", "thisMonth"]) {
    check(`...with a ${k} button`, new RegExp(`data-attwin="${k}"`).test(sec));
  }
  check("...in plain words, 'so far' where the period is still running",
    />Last school day</.test(sec) && />This week so far</.test(sec) && />This month so far</.test(sec));
  check("the pane opens on Year so far, so the year view is unchanged on load",
    /<div id="attWatchView" data-attview="watch">/.test(htmlSrc));
  check("each tab has its own renderer, so neither can paint over the other",
    /else if \(view === 'window'\) await renderAttendanceWindow\(force === true\);\s*else await renderAttendanceWatch\(force === true\);/.test(script)
    && !/_attWindow !== 'ytd'/.test(script));
  check("perfect attendance reads today as the school's calendar day too, not UTC",
    /const today = attTodayIso\(\);\s*const windows = R\.perfectWindows\(today, basis\.first\);/.test(script));

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
    if (i < 0) throw new Error("missing const " + name);
    const line = script.slice(i, script.indexOf("\n", i));
    if (/;\s*$/.test(line)) return line;
    const open = script.slice(i).search(/[\[{]/) + i;
    const close = script[open] === "[" ? "]" : "}";
    let depth = 0;
    for (let k = open; k < script.length; k++) {
      if (script[k] === script[open]) depth++;
      else if (script[k] === close) { depth--; if (depth === 0) return script.slice(i, k + 1) + ";"; }
    }
    return "";
  };
  // A FIXED WEDNESDAY, so these checks mean the same thing on a Monday.
  const todayIso = "2026-09-23";
  const attToday = new Function(liftFn("attTodayIso") + "\nreturn attTodayIso;")();
  check("today is the LOCAL calendar day (9pm on the 23rd is still the 23rd)",
    attToday(new Date(2026, 8, 23, 21, 0, 0)) === "2026-09-23");

  // THE WINDOW RENDERER, RUN: lifted as shipped, with the page stubbed.
  const LIFT = ["attShortDay", "attGradeKey", "attGradeOrder", "attGradeName", "attFillGradeSelect", "attFillKindSelect",
    "attBandChipsHtml", "attOrderWords", "attTableBarHtml", "attShowMoreHtml", "cashChipsHtml", "cashFoldKey", "cashFoldHtml",
    "wcSortCellText", "wcSortValue", "wcSortColumnType", "wcSortOrder", "wcSortSet", "wcSortTh", "wcSortItems",
    "setAttendanceWindowBand", "setAttendanceWindowKind", "renderAttendanceWindow"];
  const run = async (opts) => {
    const el = {};
    const mkEl = () => ({ innerHTML: "", textContent: "", value: "", hidden: false, _a: {},
      setAttribute(k, v) { this._a[k] = v; }, getAttribute(k) { return this._a[k] === undefined ? null : this._a[k]; },
      querySelectorAll() { return []; } });
    ["attWinTable", "attWinPick", "attWinChips", "attWinBands", "attWinOneDay", "attWinFold", "attWinGrade", "attWinKind", "attWinSearch"]
      .forEach((id) => { el[id] = mkEl(); });
    el.attWinSearch.value = opts.search || "";
    const key = opts.window || "thisWeek";
    const today = opts.today || todayIso;
    const w = R.absenceWindows(today)[key];
    const days = opts.days || [w.from];
    const marks = opts.marks;
    const state = { window: key, band: opts.band || "some", kind: opts.kind || "any", sort: opts.sort || null };
    const fn = new Function("window", "document", "students", "escapeHtml", "loadPerfectMarks", "loadAbsenceWindow", "state", `
      let _attWindow = state.window, _attWinBand = state.band, _attWinKind = state.kind, _attWinAll = false;
      let _attGradeFilter = 'all', _attWinSeq = 0, currentUser = { id: 'u1' };
      const _paCache = {}, _attWinCache = new Map(), _wcSortState = new Map(), _wcSortRedraw = new Map(), _cashOpenFolds = new Set();
      ${["WC_SORT_ARROWS", "ATT_LIST_CAP", "ATT_WIN_COLS"].map(liftConst).join("\n")}
      function attTodayIso() { return ${JSON.stringify(today)}; }
      function attendanceSchoolDays() { return { known: true, lastSchoolDay: null }; }
      function renderAttDataLine() {}
      ${LIFT.map(liftFn).join("\n")}
      state.switchTo = (k) => { _attWindow = k; _attWinSeq++; };
      if (state.sort) _wcSortState.set('attWin', state.sort);
      return renderAttendanceWindow;
    `)({ WildcatRoster: R }, { getElementById: (id) => el[id] || null }, opts.students || [],
       (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
       async () => ({ allowed: true, rows: marks, lastSyncedAt: "2026-09-23T13:00:00Z" }),
       async () => {
         if (opts.gate) await opts.gate;
         return opts.windowRes ? opts.windowRes(w, days) : { allowed: true, rows: [], schoolDays: days, truncated: false, through: w.through };
       },
       state);
    const p = fn();
    if (opts.duringLoad) opts.duringLoad(state);
    await p;
    return { el, w, days };
  };
  /** One table row's cells as text, by the student's surname. */
  const rowOf = (html, name) => {
    const tr = (html.match(new RegExp("<tr[^>]*>(?:(?!</tr>)[\\s\\S])*Kid " + name + "<(?:(?!</tr>)[\\s\\S])*</tr>")) || [""])[0];
    return [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  };
  const mk = (n, o) => Object.assign({ studentNumber: n, firstName: "Kid", lastName: n, gradeLevel: "9", entryDate: "2026-08-12", absentDates: [], tardyDates: [] }, o || {});
  const w0 = R.absenceWindows(todayIso).thisWeek;
  const d0 = w0.from;
  const r1 = await run({ marks: [mk("N1", { absentDates: [d0] }), mk("N2"), mk("N3", { tardyDates: [d0] })], days: [d0] });
  const t1 = r1.el.attWinTable.innerHTML;
  check("'Missed a day' lists the absent child and not the others",
    /Kid N1/.test(t1) && !/Kid N2/.test(t1) && !/Kid N3/.test(t1), t1.slice(0, 200));
  check("the row reads N of M days in the Days absent column", rowOf(t1, "N1")[2] === "1 of 1", JSON.stringify(rowOf(t1, "N1")));
  check("a one-day period has one absence chip, 'Missed the day', and 'Late', with their counts",
    /<b>1<\/b><span class="wc-band-l">Missed the day/.test(r1.el.attWinBands.innerHTML)
    && /<b>1<\/b><span class="wc-band-l">Late</.test(r1.el.attWinBands.innerHTML)
    && !/Missed half or more|Missed every day/.test(r1.el.attWinBands.innerHTML), r1.el.attWinBands.innerHTML.slice(0, 300));
  check("...and says why the other two are not there", r1.el.attWinOneDay.hidden === false && /1 school day/.test(r1.el.attWinOneDay.textContent));
  check("no chronic labels in a week", !/Severe|Chronic/.test(r1.el.attWinBands.innerHTML + t1));
  check("the chip names the period's days and its school days", /1 school day/.test(r1.el.attWinChips.innerHTML), r1.el.attWinChips.innerHTML);
  check("...and the fold says today is not counted yet", /still being taken/.test(r1.el.attWinFold.innerHTML));
  const tardy = await run({ marks: [mk("N1", { absentDates: [d0] }), mk("N3", { tardyDates: [d0] })], days: [d0], band: "tardy" });
  check("the 'Late' chip lists the late child", /Kid N3/.test(tardy.el.attWinTable.innerHTML) && !/Kid N1/.test(tardy.el.attWinTable.innerHTML));
  const tardyKind = await run({ marks: [mk("N1", { absentDates: [d0] }), mk("N3", { tardyDates: [d0] })], days: [d0], band: "all", kind: "tardy" });
  check("...and so does Everyone + 'Has tardies' (the old Tardies button)",
    /Kid N3/.test(tardyKind.el.attWinTable.innerHTML) && !/Kid N1/.test(tardyKind.el.attWinTable.innerHTML));

  // A LONGER PERIOD BRINGS THE NESTED CHIPS BACK, in one ramp of colour.
  const d1 = "2026-09-22";
  const two = await run({ marks: [mk("E1", { absentDates: [d0, d1] }), mk("H1", { absentDates: [d0] }), mk("Z1")], days: [d0, d1] });
  check("two school days: missed a day 2, half or more 2, every day 1",
    /<b>2<\/b><span class="wc-band-l">Missed a day/.test(two.el.attWinBands.innerHTML)
    && /<b>2<\/b><span class="wc-band-l">Missed half or more/.test(two.el.attWinBands.innerHTML)
    && /<b>1<\/b><span class="wc-band-l">Missed every day/.test(two.el.attWinBands.innerHTML), two.el.attWinBands.innerHTML.slice(0, 400));
  check("...drawn as one colour ramp, not the year's tier colours",
    /wc-band wc-ramp-1/.test(two.el.attWinBands.innerHTML) && !/wc-att-severe|wc-att-chronic/.test(two.el.attWinBands.innerHTML));

  // THE FULL-DAY SPLIT ONLY WHERE IT COVERS EVERY ABSENT DAY.
  const split = (n, absentDays, full) => ({ studentNumber: n, split: { absentDays, fullDaysStrict: full, misrecordDaysByGap: [0, 0, 0], partialDays: absentDays - full, assumedPresentDays: 0 } });
  const r2 = await run({
    marks: [mk("F1", { absentDates: [d0] }), mk("F2", { absentDates: [d0] })], days: [d0],
    windowRes: (w, days) => ({ allowed: true, schoolDays: days, truncated: false, rows: [split("F1", 1, 1), split("F2", 0, 0)] }),
  });
  check("a complete split shows its whole days", rowOf(r2.el.attWinTable.innerHTML, "F1")[3] === "1", JSON.stringify(rowOf(r2.el.attWinTable.innerHTML, "F1")));
  check("an incomplete one is a dash, not a zero, and the fold says why",
    rowOf(r2.el.attWinTable.innerHTML, "F2")[3] === "—" || rowOf(r2.el.attWinTable.innerHTML, "F2")[3] === "&mdash;"
    && /not shown for 1 student/.test(r2.el.attWinFold.innerHTML), JSON.stringify(rowOf(r2.el.attWinTable.innerHTML, "F2")));
  check("...the fold says it in words", /not shown for 1 student/.test(r2.el.attWinFold.innerHTML));
  const r3 = await run({ marks: [mk("G1", { absentDates: [d0, "2099-01-05", todayIso] })], days: [d0] });
  check("absences entered for today or later are said, not counted",
    /2 absences are already entered for today or later/.test(r3.el.attWinFold.innerHTML)
    && rowOf(r3.el.attWinTable.innerHTML, "G1")[2] === "1 of 1", r3.el.attWinFold.innerHTML.slice(0, 300));
  // loadAbsenceWindow never throws: a failed query comes back allowed:false.
  const r4 = await run({ marks: [mk("H1", { absentDates: [d0] })], days: [d0],
    windowRes: () => ({ allowed: false, rows: [], reason: "offline" }) });
  check("if the split query fails the day counts still show, counted on the marks' own dates",
    rowOf(r4.el.attWinTable.innerHTML, "H1")[2] === "1 of 1", r4.el.attWinTable.innerHTML.slice(0, 160));
  check("...and the fold says the full-day split is missing, not that nobody had one",
    /could not be worked out for this period/.test(r4.el.attWinFold.innerHTML));
  check("...and the whole/partial kinds are offered disabled, with the reason, never as an empty list",
    /<option value="whole" disabled>Has whole days \(not available just now\)</.test(r4.el.attWinKind.innerHTML)
    && /<option value="partial" disabled>/.test(r4.el.attWinKind.innerHTML), r4.el.attWinKind.innerHTML);

  // WORST FIRST MEANS OUT OF SCHOOL (review 2026-09-23): at the same number of
  // days, whole days out rank above a missed period with a tardy.
  const rank = await run({
    marks: [mk("LATE", { absentDates: [d0, d1] }), mk("OUT", { absentDates: [d0, d1], tardyDates: [d0] })], days: [d0, d1],
    windowRes: (w, days) => ({ allowed: true, schoolDays: days, truncated: false, through: w.through,
      rows: [split("LATE", 2, 0), split("OUT", 2, 2)] }),
  });
  const html = rank.el.attWinTable.innerHTML;
  check("two children out 2 of 2 days: the one out WHOLE days comes first",
    html.indexOf("Kid OUT") > -1 && html.indexOf("Kid OUT") < html.indexOf("Kid LATE"));

  // A HEADING PRESS SORTS THE WHOLE LIST BEFORE THE FIRST 50 ARE CUT (review,
  // 2026-10-07): 60 children out, the most tardies on the 60th worst.
  {
    const many = Array.from({ length: 60 }, (_, i) => mk("M" + String(i).padStart(2, "0"),
      { absentDates: i < 30 ? [d0, d1] : [d0], tardyDates: i === 59 ? [d0, d1] : (i % 3 ? [] : [d0]) }));
    const sorted = await run({ marks: many, days: [d0, d1], sort: { col: 4, dir: "desc", type: "num" } });
    const first = rowOf(sorted.el.attWinTable.innerHTML, "M59");
    check("Tardies, highest first, over every child: the one with the most tardies (60th worst) is on screen, at the top",
      first.length > 0 && sorted.el.attWinTable.innerHTML.indexOf("Kid M59") < sorted.el.attWinTable.innerHTML.indexOf("Kid M00")
      && /The first 50 of 60 shown/.test(sorted.el.attWinTable.innerHTML), sorted.el.attWinTable.innerHTML.slice(0, 200));
    const unsorted = await run({ marks: many, days: [d0, d1] });
    check("...unsorted, worst first, that child is past the first 50", !/Kid M59/.test(unsorted.el.attWinTable.innerHTML));
  }

  // SEARCH LOOKS AT EVERYONE, and says when a match is outside the band.
  const found = await run({ marks: [mk("N1", { absentDates: [d0] }), mk("QUIET")], days: [d0], search: "quiet" });
  check("a search finds a child outside 'Missed a day', shaded and said",
    /Kid QUIET/.test(found.el.attWinTable.innerHTML) && /class="wc-att-out"/.test(found.el.attWinTable.innerHTML)
    && /Searching everyone: 1 match, 1 of them outside/.test(found.el.attWinTable.innerHTML), found.el.attWinTable.innerHTML.slice(0, 300));

  // AN EMPTY PERIOD IS SAID, with the two that have days one click away.
  const mon = await run({ today: "2026-09-21", window: "thisWeek", marks: [mk("N1", { absentDates: ["2026-09-18"] })], days: [] });
  check("on a Monday, 'This week so far' has no finished day, and says so in words",
    mon.w.from > mon.w.to && /This week so far has no finished school day yet/.test(mon.el.attWinTable.innerHTML)
    && /setAttendanceWindow\('lastDay'\)/.test(mon.el.attWinTable.innerHTML) && mon.el.attWinBands.innerHTML === "",
    mon.el.attWinTable.innerHTML.slice(0, 200));

  // A LOAD THAT FINISHES AFTER THE PERIOD CHANGED PAINTS NOTHING.
  let release;
  const gate = new Promise((res) => { release = res; });
  const racing = run({ marks: [mk("R1", { absentDates: [d0] })], days: [d0], gate,
    duringLoad: (st) => { st.switchTo("lastMonth"); setTimeout(release, 0); } });
  const raced = await racing;
  check("a week that finishes loading after another period was picked does not paint over it",
    !/Kid R1/.test(raced.el.attWinTable.innerHTML) && raced.el.attWinBands.innerHTML === "",
    raced.el.attWinTable.innerHTML.slice(0, 120));
  check("Year so far and Week or month draw into different elements",
    /getElementById\('attYearTable'\)/.test(liftFn("renderAttendanceWatch")) && /getElementById\('attWinTable'\)/.test(liftFn("renderAttendanceWindow")));
  check("changing the period retires any load in flight",
    /_attWinSeq\+\+;\s*return renderAttendanceWindow\(\);\s*\}/.test(script));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
