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
import ts from "typescript";

const src = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
new Function(src)();
const R = globalThis.WildcatRoster;

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const disc = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");
const conv = readFileSync(new URL("./convex/attendanceList.ts", import.meta.url), "utf8");
// WHO MAY READ is decided in accessRules.ts (canReadInsights: admin,
// superadmin, PBIS, plus the per-person Attendance Watch grant of 2026-09-30).
// It and the two helpers the query imports are pure, so they are transpiled
// and loaded for real below: a stand-in would only test the stand-in.
const accessSrc = readFileSync(new URL("./convex/accessRules.ts", import.meta.url), "utf8");
const viewsSrc = readFileSync(new URL("./convex/views.ts", import.meta.url), "utf8");
const dayRulesSrc = readFileSync(new URL("./convex/absenceDayRules.ts", import.meta.url), "utf8");

new Function(disc)();
const D = globalThis.WildcatDiscipline;

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

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

  // THE PER-PERSON GRANT (2026-09-30). An admin can give ONE staff member
  // Attendance Watch; everyone else of that role is exactly where they were.
  check("a campus aide an admin gave Attendance Watch gets the tab",
    R2(disc, "campusaide", { attendanceWatch: true }));
  check("a teacher an admin gave Attendance Watch gets the tab",
    R2(disc, "teacher", { attendanceWatch: true }));
  check("a campus aide whose grant is switched off does NOT",
    !R2(disc, "campusaide", { attendanceWatch: false }));
  check("only a real true opens it: the string \"true\" does NOT",
    !R2(disc, "campusaide", { attendanceWatch: "true" }));
  check("the grant opens Attendance Watch, not the referral history or analytics",
    ["history", "analytics", "detention", "uniform"].every((t) =>
      D.disciplineTabsFor("campusaide", { attendanceWatch: true }).indexOf(t) === -1));

  // The server refuses independently. Hiding a button is a courtesy, not a
  // permission -- anyone can call the query straight from a console.
  // Since 2026-09-30 the check is the shared rule in accessRules.ts rather than
  // a role list local to this file, so what is pinned is: the rule is
  // imported, and EVERY query in the file asks it, after identity and before
  // any read.
  const handlers = conv.split(/^export const /m).slice(1);
  check("the Convex query gates on the shared access rule, not just the UI",
    /^import \{ canReadInsights \} from "\.\/accessRules";/m.test(conv)
    && handlers.length >= 5
    && handlers.every((h) => /if \(!canReadInsights\(staff\)\)/.test(h)),
    handlers.map((h) => h.slice(0, h.indexOf(" "))).join(","));
  check("and it gates on staff identity first",
    handlers.every((h) => {
      const who = h.indexOf("const staff = await requireStaff(ctx)");
      const gate = h.indexOf("!canReadInsights(staff)");
      const read = h.indexOf("ctx.db");
      return who !== -1 && gate > who && (read === -1 || gate < read);
    }));

  // The real rule, evaluated. INSIGHT_ROLES is the list the server now uses.
  const A = loadCjs(accessSrc);
  check("teacher is not in the server's allowed roles",
    JSON.stringify(A.INSIGHT_ROLES) === JSON.stringify(["admin", "superadmin", "pbis"]),
    JSON.stringify(A.INSIGHT_ROLES));
  // attendanceList.ts still declares its old list; if it does, it must not
  // disagree with the one that decides.
  const local = conv.match(/const ATTENDANCE_ROLES = (\[[^\]]*\])/);
  check("the role list left in attendanceList.ts agrees with INSIGHT_ROLES",
    !local || JSON.stringify(JSON.parse(local[1])) === JSON.stringify(A.INSIGHT_ROLES));
  check("the rule refuses a teacher and a campus aide without the grant",
    !A.canReadInsights({ role: "teacher" }) && !A.canReadInsights({ role: "campusaide" })
    && !A.canReadInsights({ role: "campusaide", attendanceWatch: false })
    && !A.canReadInsights({ role: "campusaide", attendanceWatch: "true" })
    && !A.canReadInsights(null) && !A.canReadInsights({}));
  check("the rule allows the three roles, and a person given the grant",
    ["admin", "superadmin", "pbis"].every((r) => A.canReadInsights({ role: r }))
    && A.canReadInsights({ role: "campusaide", attendanceWatch: true })
    && A.canReadInsights({ role: "teacher", attendanceWatch: true }));
}

console.log("\n-- the server's year list, run as each kind of staff --");
{
  // The shipped schoolAttendance handler, with the REAL accessRules, views and
  // absenceDayRules. Only the Convex runtime and the signed-in identity are
  // faked. The db records every table it is asked for, so a refusal can be
  // shown to have read nothing.
  const tables = {
    psAttendance: [
      { studentNumber: "1001", daysAbsentYtd: 4, daysTardyTerm: 1, termFirstDay: "2026-08-12", syncedAt: "2026-09-29T12:00:00Z" },
      { studentNumber: "1002", daysAbsentYtd: 0, daysTardyTerm: 0, syncedAt: "2026-09-29T12:05:00Z" },
    ],
    psAbsenceTotals: [
      { studentNumber: "1001", absentDays: 4, fullDaysStrict: 1, misrecordDaysByGap: 0, partialDays: 3, assumedPresentDays: 0 },
    ],
  };
  const makeDb = (reads) => ({
    query: (name) => { reads.push(name); return { take: async () => (tables[name] || []).slice() }; },
  });
  const load = (access) => {
    let me = { role: "admin" };
    const stubs = {
      "./_generated/server": { query: (d) => d },
      "convex/values": { v: new Proxy({}, { get: () => (...a) => ({ _v: true, a }) }) },
      "./identity": { requireStaff: async () => me },
      "./accessRules": access,
      "./views": loadCjs(viewsSrc),
      "./absenceDayRules": loadCjs(dayRulesSrc),
    };
    const mod = { exports: {} };
    new Function("require", "module", "exports", tsx(conv))(
      (n) => { if (!stubs[n]) throw new Error("unexpected import " + n); return stubs[n]; }, mod, mod.exports);
    return async (who) => {
      me = who;
      const reads = [];
      const r = await mod.exports.schoolAttendance.handler({ db: makeDb(reads) });
      return { r, reads };
    };
  };
  const ask = load(loadCjs(accessSrc));

  const admin = await ask({ role: "admin" });
  check("an admin gets the list (so a refusal below is the gate, not a broken harness)",
    admin.r.allowed === true && admin.r.rows.length === 2 && admin.reads.length > 0,
    JSON.stringify(admin.r).slice(0, 160));
  const pbis = await ask({ role: "pbis" });
  check("PBIS gets the same list", pbis.r.allowed === true && JSON.stringify(pbis.r) === JSON.stringify(admin.r));

  const refused = (x) => x.r.allowed === false && x.r.rows.length === 0 && x.reads.length === 0;
  const teacher = await ask({ role: "teacher", email: "t@school.org" });
  check("a teacher WITHOUT the grant is refused, before a single row is read", refused(teacher),
    JSON.stringify(teacher));
  const aide = await ask({ role: "campusaide", email: "a@school.org" });
  check("a campus aide WITHOUT the grant is refused, before a single row is read", refused(aide),
    JSON.stringify(aide));
  check("...and one whose grant was switched off is refused too",
    refused(await ask({ role: "campusaide", attendanceWatch: false })));
  check("...and only a real true opens it: the string \"true\" does not",
    refused(await ask({ role: "campusaide", attendanceWatch: "true" })));
  check("...and neither does a grant field on some other key",
    refused(await ask({ role: "campusaide", attendance: true, watch: true })));

  const aideOn = await ask({ role: "campusaide", email: "a@school.org", attendanceWatch: true });
  check("a campus aide WITH the grant gets the list, the same answer an admin gets",
    aideOn.r.allowed === true && JSON.stringify(aideOn.r) === JSON.stringify(admin.r),
    JSON.stringify(aideOn.r).slice(0, 160));
  const teachOn = await ask({ role: "teacher", attendanceWatch: true });
  check("a teacher WITH the grant gets it too",
    teachOn.r.allowed === true && JSON.stringify(teachOn.r) === JSON.stringify(admin.r));
  check("the grant still sends numbers only: no name crosses the wire",
    aideOn.r.rows.every((r) => Object.keys(r).join() === "studentNumber,daysAbsent,daysTardy,split"),
    aideOn.r.rows.map((r) => Object.keys(r).join()).join(" | "));

  // TEETH: the handler really consults the imported rule. With a rule that
  // refuses everyone, even an admin is refused -- so the refusals above come
  // from canReadInsights and not from something incidental in the harness.
  const shut = load({ ...loadCjs(accessSrc), canReadInsights: () => false });
  check("with a rule that refuses everyone, even an admin is refused (the gate is the shared rule)",
    refused(await shut({ role: "admin" })));
}

function R2(_source, role, user) {
  // The real disciplineTabsFor, evaluated -- not a string match on the file.
  return D.disciplineTabsFor(role, user).indexOf("attendance") !== -1;
}

/** Transpile one convex/*.ts file to CommonJS. */
function tsx(source) {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

/** Load a pure convex/*.ts module (one that imports nothing) for real. */
function loadCjs(source) {
  const m = { exports: {} };
  new Function("module", "exports", tsx(source))(m, m.exports);
  return m.exports;
}

console.log("\n-- no names cross the wire --");
{
  // The browser already holds the roster, so the server sends numbers only.
  // This is what keeps the query from ever being the thing that leaks a
  // student record: it never builds one.
  // Sliced to the end of THIS handler. The previous anchor was the literal
  // "return { allowed: true", which vanished when the return became a
  // multi-line object -- and indexOf returning -1 made the slice cover most of
  // the file, so the assertion silently stopped testing what it named.
  const start = conv.indexOf("const raw =");
  const stop = conv.indexOf("export const studentPeriods");
  const handler = conv.slice(start, stop > start ? stop : conv.length);
  check("the handler slice was actually found", start > 0 && stop > start);
  check("the student number is stringified, never passed through raw",
    /String\(r\.studentNumber \|\| ""\)/.test(handler));
  // THE RULE IS NO NAME, GRADE OR DEMOGRAPHIC -- not a fixed field count. The
  // full/partial split was added on 2026-09-21 and is counts, which is exactly
  // what this query is for.
  check("no name, grade or demographic crosses the wire",
    !/firstName|lastName|studentEmail|gradeLevel|raceCodes|fedEthnicity|grade:/.test(handler));
  check("the full/partial split is counts only",
    /fullDaysStrict/.test(handler) && /partialDays/.test(handler)
    && !/absentSlots|studentName/.test(handler));
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
  // THE CHAIN, since 2026-09-22. The tab handler no longer calls the renderer
  // itself: it applies the remembered view, and the absence half draws this.
  // Both links are asserted so neither end can drop it silently.
  // Since 2026-10-07 the tab this person last had, in this browser tab.
  check("opening the tab applies the remembered view",
    /subtab === 'attendance'\)\s*\{[\s\S]{0,320}setAttendanceView\(attRememberedView\(\)\)/.test(script));
  check("...and the absence list (Year so far) is what this tab defaults to",
    /let _attView = 'watch';/.test(script),
    "a reader opening Attendance Watch expects the absence list, not the award list");
  check("...and showing it renders the list, once the school-day count is in hand",
    /function setAttendanceView[\s\S]{0,3600}return drawAttendanceView\(false\);/.test(script)
    && /await ensureSchoolCalendar\(force === true\);[\s\S]{0,900}else await renderAttendanceWatch\(force === true\);/.test(script));
  check("the sidebar lists it", /id: 'attendance', fn: 'switchDisciplineTab'/.test(script));

  // EVERY id the renderer touches must exist. This exact class of bug -- a
  // getElementById on an element that was renamed or never added -- has broken
  // sign-in twice and shipped once.
  const fn = script.slice(script.indexOf("async function renderAttendanceWatch"),
                          script.indexOf("// THE ATTENDANCE RUN CHART"));
  const ids = [...fn.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
  check("the renderer reads at least five elements", ids.length >= 5);
  ids.forEach(id => check(`#${id} exists in index.html`, html.includes(`id="${id}"`)));

  // THE DENOMINATOR IS COUNTED NOW, NOT TYPED (2026-10-07): the days
  // PowerSchool took attendance before today, plus today once the year totals
  // hold it (attendance-nav.test.mjs runs the rule). It stays on screen: the
  // chip, the help line and the fold, each naming the days it covers
  // (attDaysRange: "Wed, Aug 12 to yesterday", or "to today" after lunch).
  check("the start-date and holiday boxes are gone", !/id="attFirstDay"/.test(html) && !/id="attNonSchoolDays"/.test(html));
  check("the school days count is shown on screen, on the chip and in the fold",
    /escapeHtml\(attDaysRange\(basis\) \+ ' \\u00b7 ' \+ basis\.days \+ ' school days'\)/.test(fn)
    && /<b>School days: ' \+ basis\.days \+ ' so far, ' \+ escapeHtml\(attDaysRange\(basis\)\)/.test(fn));
  check("the chronic threshold is stated in days, in the help line and the fold",
    /id="attChronicDays"/.test(html) && /\(basis\.days \* 0\.10\)\.toFixed\(1\)/.test(fn)
    && /Chronic starts at ' \+ \(basis\.days \* 0\.10\)/.test(fn));
  check("an unknown count is said, and nothing is ranked against a guess",
    /if \(!basis\.known\) \{[\s\S]{0,300}unknown right now/.test(fn));

  check("students with no attendance are named in the footer, not dropped",
    /no attendance on file and are not ranked/.test(script));

  // THE OLD FILTER BUTTONS ARE BAND CHIPS (2026-10-07), drawn from
  // WildcatRoster.YEAR_BANDS; Tardies is "Has tardies" in Kind of absence.
  const bands = R.YEAR_BANDS.map(b => b.key);
  ["chronicPlus", "severe", "at-risk", "all"].forEach(f => check(`the ${f} filter is a band chip`, bands.includes(f)));
  check("the tardy filter is a kind of absence", R.ATTENDANCE_KINDS.some(k => k.key === "tardy"));
  check("the chips call the setter", /attBandChipsHtml\(chips, bandCounts, _attYearBand, 'setAttendanceYearBand'\)/.test(fn));
  check("Chronic and severe is still the default", /let _attYearBand = 'chronicPlus';/.test(script));
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

console.log("\n-- the grade filter --");
{
  /** The closing brace matching the `{` at or after `from`. */
  const blockEnd = (src, from) => {
    let i = src.indexOf("{", from), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return i + 1;
    }
    throw new Error("unbalanced");
  };
  // Run the real helpers rather than copies. Sliced by brace matching so the
  // test does not pass for the wrong reason when a line is added above.
  const kAt = script.indexOf("function attGradeKey(student) {");
  const oAt = script.indexOf("function attGradeOrder(keys) {");
  const helpers = script.slice(kAt, blockEnd(script, kAt)) + "\n" +
                  script.slice(oAt, blockEnd(script, oAt));
  const attGradeKey = new Function(helpers + "\nreturn attGradeKey;")();
  const attGradeOrder = new Function(helpers + "\nreturn attGradeOrder;")();

  // MEASURED AGAINST PRODUCTION 2026-09-13. The school is 6-12, not 7-12:
  // 69 in grade 6, 124, 148, 106, 73, 58, and 41 seniors. Hardcoding a grade
  // list in the markup would have shipped a filter missing 69 children, which
  // is why the options are built from the data instead.
  check("10 sorts after 9, not between 1 and 2",
    attGradeOrder(["10", "6", "9", "11", "7", "12", "8"]).join(",") === "6,7,8,9,10,11,12");

  // A student the roster has no grade for is a real case -- production has one
  // attendance row with no student record at all -- and a filter that drops
  // them silently hides a chronically absent child.
  check("a missing grade is its own bucket, not a miss", attGradeKey({}) === "(none)");
  check("blank and whitespace count as missing too",
    attGradeKey({ grade: "" }) === "(none)" && attGradeKey({ grade: "  " }) === "(none)");
  check("(none) sorts last so it never hides at the top",
    attGradeOrder(["(none)", "9", "6"]).join(",") === "6,9,(none)");
  check("a non-numeric grade still appears, after the numbers",
    attGradeOrder(["K", "9", "(none)", "6"]).join(",") === "6,9,K,(none)");
  // Grades arrive from the roster as strings; a number must key the same way
  // or the selected value stops matching after a re-render.
  check("a numeric grade keys the same as a string one",
    attGradeKey({ grade: 9 }) === attGradeKey({ grade: "9" }));

  // THE DESIGN DECISION, pinned: filtering after the ranking would leave the
  // four tier cards showing whole-school numbers over a one-grade list, which
  // reads as a broken screen rather than a filter.
  const fn = script.slice(script.indexOf("async function renderAttendanceWatch(force)"));
  const body = fn.slice(0, fn.indexOf("\n        }\n"));
  const rankAt = body.indexOf("R.attendanceRanking(rows, basis.days)");
  const filterAt = body.indexOf("const rows = grade === 'all'\n                ? allRows");
  check("the grade filter is applied BEFORE the ranking", filterAt !== -1 && filterAt < rankAt);
  check("the ranking is fed the filtered rows", /R\.attendanceRanking\(rows, basis\.days\)/.test(body));

  // Option counts must come from the unfiltered set, or picking grade 9 puts
  // "(0)" beside every other grade and reads as "that grade has nobody".
  check("option counts are taken from allRows", /gradeCounts\[k\] = \(gradeCounts\[k\] \|\| 0\) \+ 1/.test(body) &&
    /allRows\.forEach\(r => \{/.test(body));
  // The select is built by the shared attFillGradeSelect (2026-10-07: one
  // chosen grade across Year so far, Week or month and Perfect attendance).
  const filler = script.slice(script.indexOf("function attFillGradeSelect("), script.indexOf("function attFillKindSelect("));
  check("the options are rebuilt only when they changed, so typing does not close the dropdown",
    /attFillGradeSelect\(document\.getElementById\('attYearGrade'\), gradeCounts, allRows\.length\)/.test(body) && /data-built/.test(filler));
  check("a selected grade that leaves the data falls back to all",
    /Object\.prototype\.hasOwnProperty\.call\(counts, _attGradeFilter\)\)\)\s*\? _attGradeFilter : 'all'/.test(filler));

  // The screen has to say it is scoped, or the smaller tier numbers look wrong.
  check("the footer says which grade the screen is scoped to", /Scoped to grade/.test(body));
  check("and says the band chips followed the filter", /the bands and counts above cover only that grade/.test(body));
  check("the empty state names the grade", /No students match this filter/.test(body) && /' in ' \+ attGradeName\(grade\)\.toLowerCase\(\)/.test(body));

  // The control exists, is labelled, and is wired.
  const controls = html.slice(html.indexOf('<section data-asec="watch">'), html.indexOf('id="attYearTable"'));
  check("the markup carries a grade select", /<select id="attYearGrade"/.test(controls));
  check("it is wired to the setter", /onchange="setAttendanceGradeFilter\(this\.value\)"/.test(controls));
  check("it has a visible label, not a bare dropdown of numbers, and says where grades come from",
    /<span class="wc-att-grade-label">Grade \(app roster\)<\/span>/.test(controls));
  check("the label points at the select", /for="attYearGrade"/.test(controls));
  // The grades are NOT hardcoded here: production is 6-12 and that can change.
  check("no grade numbers are hardcoded in the markup",
    !/<option value="(6|7|8|9|10|11|12)"/.test(controls));
  ["wc-att-grade-wrap", "wc-att-grade-label", "wc-att-grade"].forEach((c) =>
    check(`.${c} is styled`, css.includes("." + c + " ") || css.includes("." + c + "{") ||
                             css.includes("." + c + ",") || css.includes("." + c + ":")));
  check("the select cannot overflow its row", /\.wc-att-grade \{[^}]*box-sizing: border-box/.test(css));

  // The server still sends no grade. attendanceList.ts exists so that a
  // whole-school attendance answer can be given without a name, grade, address
  // or race crossing the wire, and a grade filter must not be the thing that
  // undoes that. The browser already holds the roster.
  check("the grade filter did NOT add grade to the wire", !/\bgrade\b/.test(
    conv.slice(conv.indexOf("const out = rows.map"), conv.indexOf("const out = rows.map") + 400)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
