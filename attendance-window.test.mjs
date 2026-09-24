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
  const sat = R.absenceWindows("2026-09-26");
  check("on a Saturday, this week is the Monday-to-Friday just finished",
    sat.thisWeek.from === "2026-09-21" && sat.thisWeek.to === "2026-09-25");
  check("...and last week the one before it (so on a weekend, 'This week' is Perfect attendance's 'Last full week')",
    sat.lastWeek.from === "2026-09-14" && sat.lastWeek.to === "2026-09-18"
    && R.perfectWindows("2026-09-26", "2026-08-12").week.from === sat.thisWeek.from);
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
  const refused = await q.handler({ db: makeDb(tables, []) }, { from: "2026-09-21", to: "2026-09-25", today: "2026-09-23" });
  check("a teacher is refused, as the year list refuses them", refused.allowed === false && refused.rows.length === 0);
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
  check("the period picker is at the top of 'Who is missing', year to date first and pressed",
    htmlSrc.indexOf('id="attPeriod"') > htmlSrc.indexOf('<div id="attWatchView">')
    && htmlSrc.indexOf('id="attPeriod"') < htmlSrc.indexOf('class="wc-card wc-att-basis"')
    && /data-attwin="ytd" aria-pressed="true"/.test(htmlSrc));
  for (const k of ["thisWeek", "lastWeek", "thisMonth", "lastMonth"]) {
    check(`...with a ${k} button`, new RegExp(`data-attwin="${k}"`).test(htmlSrc));
  }
  check("the week/month filters start hidden, so the year view is unchanged on load",
    /id="attWindowFilter" style="display:none"/.test(htmlSrc));
  check("the year renderer hands a week or month to its own renderer, first thing",
    /async function renderAttendanceWatch\(force\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*if \(_attWindow !== 'ytd'\) return renderAttendanceWindow\(force\);/.test(script));
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
  // A FIXED WEDNESDAY, so these checks mean the same thing on a Monday.
  const todayIso = "2026-09-23";
  const attToday = new Function(liftFn("attTodayIso") + "\nreturn attTodayIso;")();
  check("today is the LOCAL calendar day (9pm on the 23rd is still the 23rd)",
    attToday(new Date(2026, 8, 23, 21, 0, 0)) === "2026-09-23");

  // THE WINDOW RENDERER, RUN: lifted as shipped, with the page stubbed.
  const run = async (opts) => {
    const el = {};
    const mkEl = () => ({ innerHTML: "", textContent: "", value: "", _a: {}, setAttribute(k, v) { this._a[k] = v; }, getAttribute(k) { return this._a[k]; } });
    ["attendanceList", "attTierCards", "attBasisNote", "attFoot", "attGradeFilter", "attSearch"].forEach((id) => { el[id] = mkEl(); });
    el.attGradeFilter.value = "all";
    el.attSearch.value = opts.search || "";
    const w = R.absenceWindows(todayIso)[opts.window || "thisWeek"];
    const days = opts.days || [w.from];
    const marks = opts.marks;
    const state = { window: opts.window || "thisWeek", filter: opts.filter || "absent" };
    const fn = new Function("window", "document", "students", "escapeHtml", "loadPerfectMarks", "loadAbsenceWindow", "state", `
      let _attWindow = state.window, _attWinFilter = state.filter, _attGradeFilter = 'all', _attWinSeq = 0;
      const _paCache = {}, _attWinCache = new Map();
      function attTodayIso() { return ${JSON.stringify(todayIso)}; }
      ${["attShortDay", "attGradeKey", "attGradeOrder", "renderAttendanceWindow"].map(liftFn).join("\n")}
      state.switchTo = (k) => { _attWindow = k; _attWinSeq++; };
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
  const mk = (n, o) => Object.assign({ studentNumber: n, firstName: "Kid", lastName: n, gradeLevel: "9", entryDate: "2026-08-12", absentDates: [], tardyDates: [] }, o || {});
  const w0 = R.absenceWindows(todayIso).thisWeek;
  const d0 = w0.from;
  const r1 = await run({ marks: [mk("N1", { absentDates: [d0] }), mk("N2"), mk("N3", { tardyDates: [d0] })], days: [d0] });
  check("'Missed a day' lists the absent child and not the others",
    /Kid N1/.test(r1.el.attendanceList.innerHTML) && !/Kid N2/.test(r1.el.attendanceList.innerHTML), r1.el.attendanceList.innerHTML.slice(0, 200));
  check("the row reads 'missed class on N of M days'", /missed class on 1 of 1 day/.test(r1.el.attendanceList.innerHTML));
  check("the cards count every day, half or more, missed a day, and late",
    /<div class="wc-att-tier-n">1<\/div><div class="wc-att-tier-l">Every day/.test(r1.el.attTierCards.innerHTML)
    && /<div class="wc-att-tier-n">1<\/div><div class="wc-att-tier-l">Late/.test(r1.el.attTierCards.innerHTML));
  check("no chronic labels in a week", !/Severe|Chronic/.test(r1.el.attTierCards.innerHTML + r1.el.attendanceList.innerHTML));
  check("the note names the period and its school days", /This week/.test(r1.el.attBasisNote.textContent) && /1 school day/.test(r1.el.attBasisNote.textContent),
    r1.el.attBasisNote.textContent);
  check("...and says today is not counted yet", /still being taken/.test(r1.el.attBasisNote.textContent));
  const tardy = await run({ marks: [mk("N1", { absentDates: [d0] }), mk("N3", { tardyDates: [d0] })], days: [d0], filter: "tardy" });
  check("'Tardies' lists the late child", /Kid N3/.test(tardy.el.attendanceList.innerHTML) && !/Kid N1/.test(tardy.el.attendanceList.innerHTML));

  // THE FULL-DAY SPLIT ONLY WHERE IT COVERS EVERY ABSENT DAY.
  const split = (n, absentDays, full) => ({ studentNumber: n, split: { absentDays, fullDaysStrict: full, misrecordDaysByGap: [0, 0, 0], partialDays: absentDays - full, assumedPresentDays: 0 } });
  const r2 = await run({
    marks: [mk("F1", { absentDates: [d0] }), mk("F2", { absentDates: [d0] })], days: [d0],
    windowRes: (w, days) => ({ allowed: true, schoolDays: days, truncated: false, rows: [split("F1", 1, 1), split("F2", 0, 0)] }),
  });
  check("a complete split shows its full days", /Kid F1[\s\S]*?1 full/.test(r2.el.attendanceList.innerHTML));
  check("an incomplete one is not shown, and the footer says why",
    !/Kid F2[^<]*<[\s\S]{0,300}0 full/.test(r2.el.attendanceList.innerHTML) && /not shown for 1 student/.test(r2.el.attFoot.textContent),
    r2.el.attFoot.textContent);
  const r3 = await run({ marks: [mk("G1", { absentDates: [d0, "2099-01-05", todayIso] })], days: [d0] });
  check("absences entered for today or later are said, not counted", /2 absences are already entered for today or later/.test(r3.el.attFoot.textContent)
    && /missed class on 1 of 1 day/.test(r3.el.attendanceList.innerHTML), r3.el.attFoot.textContent);
  // loadAbsenceWindow never throws: a failed query comes back allowed:false.
  const r4 = await run({ marks: [mk("H1", { absentDates: [d0] })], days: [d0],
    windowRes: () => ({ allowed: false, rows: [], reason: "offline" }) });
  check("if the split query fails the day counts still show, counted on the marks' own dates",
    /missed class on 1 of 1 day/.test(r4.el.attendanceList.innerHTML), r4.el.attendanceList.innerHTML.slice(0, 160));

  // WORST FIRST MEANS OUT OF SCHOOL (review 2026-09-23): at the same number of
  // days, whole days out rank above a missed period with a tardy.
  const d1 = "2026-09-22";
  const rank = await run({
    // PART is never late but only ever missed a period; OUT was out whole days
    // and late once. Fewer-tardies-first alone would put PART on top.
    marks: [mk("LATE", { absentDates: [d0, d1] }), mk("OUT", { absentDates: [d0, d1], tardyDates: [d0] })], days: [d0, d1],
    windowRes: (w, days) => ({ allowed: true, schoolDays: days, truncated: false, through: w.through,
      rows: [split("LATE", 2, 0), split("OUT", 2, 2)] }),
  });
  const html = rank.el.attendanceList.innerHTML;
  check("two children out 2 of 2 days: the one out WHOLE days comes first",
    html.indexOf("Kid OUT") > -1 && html.indexOf("Kid OUT") < html.indexOf("Kid LATE"));

  // A LOAD THAT FINISHES AFTER THE PERIOD CHANGED PAINTS NOTHING.
  let release;
  const gate = new Promise((res) => { release = res; });
  const racing = run({ marks: [mk("R1", { absentDates: [d0] })], days: [d0], gate,
    duringLoad: (st) => { st.switchTo("ytd"); setTimeout(release, 0); } });
  const raced = await racing;
  check("a week that finishes loading after 'Year to date' was picked does not paint over it",
    !/Kid R1/.test(raced.el.attendanceList.innerHTML) && raced.el.attTierCards.innerHTML === "",
    raced.el.attendanceList.innerHTML.slice(0, 120));
  check("the year path also gives way when a week is picked during its load",
    /finally \{ _attBusy = false; \}\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*if \(_attWindow !== 'ytd'\) return;/.test(script));
  check("changing the period retires any load in flight",
    /_attWinSeq\+\+;\s*renderAttendanceWatch\(\);\s*\}/.test(script));
  check("...and the footer says the full-day split is missing, not that nobody had one",
    /could not be worked out for this period/.test(r4.el.attFoot.textContent), r4.el.attFoot.textContent);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
