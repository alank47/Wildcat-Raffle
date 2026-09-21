// The combined early warning indicator. Run: npm test
//
// WHY THE ASSERTIONS LOOK LIKE THIS. Two features shipped from this repo with
// bugs that every text-matching test walked straight past: a switchTab target
// that named a pane which did not exist (a silent dead click), and a temporal
// dead zone crash in a read-back. So the rules here are LIFTED AND RUN, the
// Convex handler is transpiled and INVOKED against an in-memory database, and
// the wiring assertions resolve every id and every handler name across
// index.html and script.js rather than checking that a string is present.
//
// WHAT THE NUMBERS PIN. The tier boundaries are not taste and the test says so:
// they were read off a histogram of this exact function over all 679 students
// on 2026-09-21. If somebody changes actAt without re-running
// scripts/calibrate-early-warning.mjs, the assertion that names the measured
// counts is the thing that should stop them.
import { readFileSync } from "node:fs";
import ts from "typescript";

const js = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const script = js("./script.js");
const html = js("./index.html");
const disciplineSrc = js("./wildcat-discipline.js");
const serverSrc = js("./convex/earlyWarning.ts");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

// The real module, loaded the way the browser loads it. It binds itself to
// globalThis, so that is where it has to be read from.
new Function(disciplineSrc)();
const D = globalThis.WildcatDiscipline;

console.log("\nthe rules, lifted from the shipped module and run");

check("the module exports the ranking", typeof D.riskRanking === "function");
check("and the single-student score", typeof D.riskScore === "function");
check("and the settings coercer", typeof D.riskSettingsOrDefault === "function");

const unknown = { status: "unknown" };
const DAYS = 29;
const row = (o) => ({
  studentNumber: "1001", daysAbsent: 0, daysTardy: 0,
  failingCourses: 0, failingCoursesRaw: 0, ungradedCourses: 0, gradedCourses: 8,
  missingRecent: 0, missingOlder: 0, ...o,
});

console.log("\nabsence is not zero, and it is not safety");

{
  const s = D.riskScore(row({ daysAbsent: null, daysTardy: null }), DAYS, unknown);
  check("a missing attendance figure is not scored as perfect attendance", s.attendance.known === false && s.attendance.points === 0);
  check("and it is named as a gap", s.unknown.indexOf("attendance") !== -1);
  check("and it does not claim a tier for attendance", s.attendance.tier === null);
}
{
  const s = D.riskScore(row(), 0, unknown);
  check("no school days yet refuses a rate rather than dividing by zero", s.attendance.known === false);
  check("and says which of the two reasons it is", /school days/i.test(s.attendance.why));
}
{
  // The flaw the 2026-09-21 calibration run exposed in this very function:
  // 62 students have no grade rows, missing work is presence-only so their
  // owed count is a genuine 0, and an earlier version therefore scored them
  // known-and-fine on course performance.
  const s = D.riskScore(row({ failingCourses: null, failingCoursesRaw: null, gradedCourses: null, missingRecent: 0 }), DAYS, unknown);
  check("a student with NO GRADES is not scored as passing", s.course.gradesKnown === false);
  check("and the gap is named separately from the axis", s.unknown.indexOf("grades") !== -1);
  check("and it is still said in words", /no grades/i.test(s.course.why));
}
{
  const s = D.riskScore(row({ failingCourses: null, missingRecent: null }), DAYS, unknown);
  check("nothing readable on course at all is known:false", s.course.known === false);
}
{
  const r = D.riskRanking([row({ daysAbsent: null, failingCourses: null, missingRecent: null })], DAYS, unknown);
  check("a student readable on NO axis is not ranked", r.ranked.length === 0);
  check("they are carried in noData rather than dropped", r.noData.length === 1);
  check("and they are not counted as clear", r.counts.clear === 0);
}

console.log("\nthe behaviour axis is dark, and says so");

{
  const b = D.riskBehaviour(unknown);
  check("unknown coverage scores zero for everyone", b.points === 0);
  check("and reports known:false so the screen can carry the gap", b.known === false);
  check("and states the reason in words", /no behaviour data/i.test(b.why));
  check("a ranking over dark behaviour reports behaviourKnown false",
    D.riskRanking([row()], DAYS, unknown).behaviourKnown === false);
  check("a ranking over covered behaviour reports true",
    D.riskRanking([row()], DAYS, { status: "covered" }).behaviourKnown === true);
  // The axis must not silently become a scoring input the day it lights up
  // without somebody deciding the weights.
  check("even covered behaviour scores 0 until weights are decided",
    D.riskBehaviour({ status: "covered" }).points === 0);
}

console.log("\nthe attendance axis matches Attendance Watch");

{
  // The same three cuts, so a child is not chronic on one screen and something
  // else on another.
  const at = (abs) => D.riskAttendance(abs, 0, 100, {});
  check("20% or more scores 3 (severe)", at(20).points === 3 && at(20).tier === "severe");
  check("just under 20% scores 2 (chronic)", at(19).points === 2 && at(19).tier === "chronic");
  check("10% scores 2 (chronic)", at(10).points === 2 && at(10).tier === "chronic");
  check("just under 10% scores 1 (at risk)", at(9).points === 1 && at(9).tier === "at-risk");
  check("5% scores 1 (at risk)", at(5).points === 1);
  check("just under 5% scores 0", at(4).points === 0 && at(4).tier === "satisfactory");
  // A student present but always late never appears on an absence ranking.
  const t = D.riskAttendance(0, 10, 100, {});
  check("TARDIES earn their own point, with no absence at all", t.points === 1 && t.tardyFlag === true);
  check("and nine tardies do not", D.riskAttendance(0, 9, 100, {}).points === 0);
  check("attendance tops out at 4", D.riskAttendance(50, 50, 100, {}).points === 4);
}

console.log("\nthe course axis, and the zero-percent artefact it steps around");

{
  const c = (o) => D.riskCourse(row(o), {});
  check("three failing courses scores 2", c({ failingCourses: 3 }).points === 2);
  check("one failing course scores 1", c({ failingCourses: 1 }).points === 1);
  check("none scores 0", c({ failingCourses: 0 }).points === 0);
  check("five recent owed assignments scores 2", c({ missingRecent: 5 }).points === 2);
  check("two recent owed scores 1", c({ missingRecent: 2 }).points === 1);
  check("one recent owed scores 0", c({ missingRecent: 1 }).points === 0);
  check("course tops out at 4", c({ failingCourses: 9, missingRecent: 20 }).points === 4);
  // RECENCY IS THE POINT: old owed work is carried and not scored, which is
  // what makes recovery visible from a single snapshot.
  check("OLDER owed work is carried but scores nothing",
    c({ missingOlder: 18, missingRecent: 0 }).points === 0 && c({ missingOlder: 18 }).missingOlder === 18);
}

console.log("\nthe tiers, and the histogram they were read off");

{
  // Not taste. Measured over all 679 students on 2026-09-21: at or above
  // 8 pts = 7 students, 7 = 31, 6 = 80, 5 = 139, 4 = 205, 3 = 322. Only one
  // cut yields a list a team can finish, and the team said 30-40.
  const d = D.DEFAULT_RISK_SETTINGS;
  check("'Act now' ships at 7 points, the cut that named 31 of 679", d.actAt === 7,
    "changing this requires re-running scripts/calibrate-early-warning.mjs");
  check("'Watch' ships at 6, putting the next 49 beside them", d.watchAt === 6);
  check("the recency window ships at 14 days", d.recentDays === 14);
  check("a score of exactly actAt is 'Act now'", D.riskTier(7, {}).key === "act");
  check("one below is 'Watch'", D.riskTier(6, {}).key === "watch");
  check("one below that is 'Some signs'", D.riskTier(5, {}).key === "some");
  check("1 point is still 'Some signs'", D.riskTier(1, {}).key === "some");
  check("0 is 'Clear'", D.riskTier(0, {}).key === "clear");
  check("an unreadable score claims no tier", D.riskTier(null, {}) === null);
  check("the maximum reachable score is 8",
    D.riskScore(row({ daysAbsent: 99, daysTardy: 99, failingCourses: 9, missingRecent: 99 }), 100, unknown).points === 8);
}

console.log("\nthe settings ladder cannot invert");

{
  const s = D.riskSettingsOrDefault({ actAt: 2, watchAt: 6 });
  check("an act tier below the watch tier is corrected, not stored", s.actAt >= s.watchAt);
  const f = D.riskSettingsOrDefault({ failManyAt: 1, failSomeAt: 4 });
  check("'several failing' below 'some failing' is corrected", f.failManyAt >= f.failSomeAt);
  const m = D.riskSettingsOrDefault({ missManyAt: 1, missSomeAt: 9 });
  check("'a lot owed' below 'some owed' is corrected", m.missManyAt >= m.missSomeAt);
  const a = D.riskSettingsOrDefault({ absSevereAt: 0.1, absChronicAt: 0.5 });
  check("chronic above severe is corrected", a.absChronicAt <= a.absSevereAt);
  check("a string threshold is refused, not coerced", D.riskSettingsOrDefault({ actAt: "9" }).actAt === 7);
  check("a negative is refused", D.riskSettingsOrDefault({ actAt: -3 }).actAt === 7);
  check("NaN is refused", D.riskSettingsOrDefault({ actAt: NaN }).actAt === 7);
  check("an absent blob falls back entirely", D.riskSettingsOrDefault(null).actAt === 7);
  check("settings are taken as an argument, never read from a global",
    !/\briskSettings\b/.test(disciplineSrc), "wildcat-discipline.js must not know the app's state");
}

console.log("\nthe ranking is stable and honest");

{
  const rows = [
    row({ studentNumber: "b", daysAbsent: 6, missingRecent: 5 }),
    row({ studentNumber: "a", daysAbsent: 6, missingRecent: 5 }),
    row({ studentNumber: "c", daysAbsent: 20, failingCourses: 3, missingRecent: 5, daysTardy: 12 }),
  ];
  const r1 = D.riskRanking(rows, DAYS, unknown);
  const r2 = D.riskRanking(rows.slice().reverse(), DAYS, unknown);
  check("worst first", r1.ranked[0].studentNumber === "c");
  check("the order does not depend on input order",
    r1.ranked.map((x) => x.studentNumber).join() === r2.ranked.map((x) => x.studentNumber).join(),
    r1.ranked.map((x) => x.studentNumber).join() + " vs " + r2.ranked.map((x) => x.studentNumber).join());
  check("ties break deterministically on student number",
    r1.ranked[1].studentNumber === "a" && r1.ranked[2].studentNumber === "b");
  check("the tier counts add up to the ranked rows",
    Object.values(r1.counts).reduce((a, b) => a + b, 0) === r1.ranked.length);
}
{
  // Silently removing children from a risk list is how a child who is still
  // enrolled disappears from it.
  const rows = [row({ studentNumber: "old", sisAsOf: "2026-08-12" }), row({ studentNumber: "now", sisAsOf: "2026-09-21" })];
  const r = D.riskRanking(rows, DAYS, unknown, { staleBefore: "2026-09-01" });
  check("a stale SIS row is held back", r.ranked.length === 1 && r.ranked[0].studentNumber === "now");
  check("and counted rather than dropped", r.stale.length === 1);
  check("with no staleBefore set, nobody is held back",
    D.riskRanking(rows, DAYS, unknown).ranked.length === 2);
}

console.log("\nthe server query, transpiled and invoked");

// The shipped handler, with Convex's wrappers and its two imports stubbed.
function loadServer(opts) {
  const o = opts || {};
  let body = serverSrc.replace(/^import[^\n]*\n/gm, "").replace(/^export (const|function|async function) /gm, "$1 ");
  const stubs = `
    const query = (d) => d;
    const v = new Proxy({}, { get: () => (...a) => ({ _v: true, a }) });
    const requireStaff = async () => ({ role: ${JSON.stringify(o.role || "admin")}, email: "x@y.z" });
    // PARENTHESISED. Without them an object literal is parsed as a function
    // block and the stub silently returns undefined, which reads exactly like
    // "behaviour is dark" and would have made the covered case untestable.
    const readCoverage = async () => (${JSON.stringify(o.coverage || null)});
  `;
  const out = ts.transpileModule(stubs + body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(out + "\nreturn { academicCounts, countsForStudent, recencyCutoff };")();
}

function makeDb(tables) {
  const t = { psAttendance: [], psGrades: [], psMissingWork: [], ...tables };
  let reads = 0;
  const keys = [];
  const reader = (get) => ({
    async take(n) { const r = get().slice(0, n); reads += r.length; return r; },
    async collect() { const r = get(); reads += r.length; return r.slice(); },
    async first() { reads += 1; return get()[0] || null; },
  });
  return {
    stats: () => ({ reads, keys }),
    ctx: {
      db: {
        query(name) {
          return {
            ...reader(() => t[name] || []),
            withIndex(_i, fn) {
              const eqs = {}; const gts = {};
              const q = { eq(f, val) { eqs[f] = val; keys.push([f, val]); return q; },
                          gt(f, val) { gts[f] = val; return q; } };
              if (fn) fn(q);
              return reader(() => (t[name] || [])
                .filter((r) => Object.entries(eqs).every(([k, val]) => r[k] === val))
                .filter((r) => Object.entries(gts).every(([k, val]) => String(r[k]) > String(val)))
                .sort((a, b) => (String(a.studentNumber) < String(b.studentNumber) ? -1 : 1)));
            },
          };
        },
      },
    },
  };
}

const att = (n, o) => ({ studentNumber: n, daysAbsentYtd: 0, daysTardyTerm: 0, syncedAt: "2026-09-21T13:00:00.000Z", ...o });
const grade = (n, sec, pct) => ({ studentNumber: n, sectionId: sec, currentPercent: pct, syncedAt: "x" });
const miss = (n, sec, due, o) => ({ studentNumber: n, sectionId: sec, assignmentSectionId: sec, dueDate: due, syncedAt: "x", ...o });

for (const role of ["teacher", "campusaide"]) {
  const m = loadServer({ role });
  const db = makeDb({ psAttendance: [att("1")] });
  const out = await m.academicCounts.handler(db.ctx, { today: "2026-09-21" });
  check(`a ${role} is REFUSED`, out.allowed === false && out.rows.length === 0);
  check(`and the ${role} refusal is returned, not thrown, with a reason`, typeof out.reason === "string" && out.reason.length > 20);
}
for (const role of ["pbis", "admin", "superadmin"]) {
  const m = loadServer({ role });
  const db = makeDb({ psAttendance: [att("1")] });
  const out = await m.academicCounts.handler(db.ctx, { today: "2026-09-21" });
  check(`${role} is allowed`, out.allowed === true);
}

{
  const m = loadServer({});
  const db = makeDb({
    psAttendance: [att("1001")],
    // The measured artefact: 721 grade rows at exactly 0%, 709 of them with no
    // teacher-flagged work anywhere in that section. An empty gradebook, not a
    // failing child.
    psGrades: [grade("1001", "S1", 0), grade("1001", "S2", 0), grade("1001", "S3", 45), grade("1001", "S4", 90)],
    psMissingWork: [miss("1001", "S2", "2026-09-18")],
  });
  const out = await m.academicCounts.handler(db.ctx, { today: "2026-09-21" });
  const r = out.rows[0];
  check("a 0% with NO flagged work in that section is not counted as failing", r.failingCourses === 2, String(r.failingCourses));
  check("a 0% WITH flagged work in that section IS counted", r.failingCourses === 2 && r.failingCoursesRaw === 3,
    `failing ${r.failingCourses} raw ${r.failingCoursesRaw}`);
  check("the uncorroborated zero is reported as ungraded instead", r.ungradedCourses === 1, String(r.ungradedCourses));
  check("the raw count rides along so the screen can show both", r.failingCoursesRaw === 3);
  check("a passing course is not counted either way", r.gradedCourses === 4);
}
{
  const m = loadServer({});
  const db = makeDb({ psAttendance: [att("1001")], psGrades: [], psMissingWork: [] });
  const out = await m.academicCounts.handler(db.ctx, { today: "2026-09-21" });
  const r = out.rows[0];
  check("NO GRADE ROWS gives null, not 0", r.failingCourses === null && r.gradedCourses === null);
  check("owed work with no rows is a real 0, not null", r.missingRecent === 0 && r.hasMissingFeed === false);
}
{
  const m = loadServer({});
  const db = makeDb({
    psAttendance: [att("1001")],
    psMissingWork: [
      miss("1001", "S1", "2026-09-20"), miss("1001", "S1", "2026-09-08"),
      miss("1001", "S1", "2026-09-06"), miss("1001", "S1", "2026-08-20"),
      // isMissing FALSE is a scored zero, not work owed, and must not count.
      miss("1001", "S1", "2026-09-19", { isMissing: false }),
      // isMissing ABSENT reads as true: plugin 1.3.x rows carried no column.
      miss("1001", "S1", "2026-09-19"),
    ],
  });
  const out = await m.academicCounts.handler(db.ctx, { today: "2026-09-21", recentDays: 14 });
  const r = out.rows[0];
  check("the 14-day window splits owed work by due date", r.missingRecent === 3 && r.missingOlder === 2,
    `recent ${r.missingRecent} older ${r.missingOlder}`);
  check("isMissing:false is excluded", r.missingRecent + r.missingOlder === 5);
  check("the cutoff is reported so the screen can state it", out.cutoff === "2026-09-07", out.cutoff);
  check("a date is compared as a STRING, never parsed and re-serialized",
    !/new Date\(\s*[a-z]*\.?dueDate/i.test(serverSrc) && !/Date\.parse\([^)]*dueDate/i.test(serverSrc));
}
{
  const m = loadServer({});
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(att(`s${i}`));
  const db = makeDb({ psAttendance: rows });
  const p1 = await m.academicCounts.handler(db.ctx, { today: "2026-09-21", pageSize: 2 });
  check("a full page does NOT claim to be done", p1.done === false && p1.rows.length === 2);
  const p2 = await m.academicCounts.handler(db.ctx, { today: "2026-09-21", pageSize: 2, after: p1.last });
  check("the cursor advances past the last row returned", p2.rows[0].studentNumber === "s2", p2.rows[0].studentNumber);
  const p3 = await m.academicCounts.handler(db.ctx, { today: "2026-09-21", pageSize: 2, after: p2.last });
  check("the final short page says done", p3.done === true && p3.rows.length === 1);
  const all = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.studentNumber);
  check("paging covers every student exactly once", all.join() === "s0,s1,s2,s3,s4", all.join());
}
{
  // q.eq("studentNumber", "") is NOT a no-op: it matches every unkeyed row and
  // would render another child's grades under this child's name.
  const m = loadServer({});
  const db = makeDb({
    psAttendance: [att(""), att("1001")],
    psGrades: [grade("", "S1", 10), grade("1001", "S1", 90)],
  });
  const out = await m.academicCounts.handler(db.ctx, { today: "2026-09-21" });
  check("a student with no number is skipped entirely", out.rows.length === 1 && out.rows[0].studentNumber === "1001");
  check("and an empty key is NEVER queried",
    db.stats().keys.every(([f, val]) => !(f === "studentNumber" && val === "")),
    JSON.stringify(db.stats().keys));
}
{
  // THE CURSOR MUST ALWAYS ADVANCE. An empty studentNumber sorts first in the
  // index, so a page whose final row carried one used to hand back last:"",
  // which the caller reads as "no cursor" -- paging then stopped early or
  // restarted from the top forever. gt("") on every page makes that
  // unreachable.
  const m = loadServer({});
  const db = makeDb({ psAttendance: [att(""), att(""), att("1001"), att("1002")] });
  const p1 = await m.academicCounts.handler(db.ctx, { today: "2026-09-21", pageSize: 2 });
  check("empty-keyed rows never occupy a page at all", p1.rows.length === 2, String(p1.rows.length));
  check("so the cursor it returns is a real student number", p1.last === "1002", p1.last);
  check("and it reports done rather than stalling", p1.done === true);
  const allEmpty = makeDb({ psAttendance: [att(""), att("")] });
  const p2 = await m.academicCounts.handler(allEmpty.ctx, { today: "2026-09-21", pageSize: 2 });
  check("a table of nothing but unkeyed rows is done and empty, not a loop",
    p2.done === true && p2.rows.length === 0 && p2.last === "");
}
{
  const m = loadServer({});
  const db = makeDb({ psAttendance: [att("1001", { syncedAt: "2026-08-12T13:00:00.000Z" })] });
  const out = await m.academicCounts.handler(db.ctx, { today: "2026-09-21" });
  check("SIS freshness rides on the row so staleness is visible", out.rows[0].sisAsOf === "2026-08-12");
}
{
  const dark = loadServer({ coverage: null });
  const db1 = makeDb({ psAttendance: [att("1")] });
  const o1 = await dark.academicCounts.handler(db1.ctx, { today: "2026-09-21" });
  check("no coverage record reports behaviour UNKNOWN", o1.behaviour.status === "unknown");
  check("and never a count", o1.behaviour.entriesLoaded === null);
  const lit = loadServer({ coverage: { windowStart: "2026-09-01", windowEnd: "2026-09-21", syncedAt: "z", entriesLoaded: 12 } });
  const db2 = makeDb({ psAttendance: [att("1")] });
  const o2 = await lit.academicCounts.handler(db2.ctx, { today: "2026-09-21" });
  check("a real coverage record reports covered, with its window", o2.behaviour.status === "covered" && o2.behaviour.entriesLoaded === 12);
}
{
  const m = loadServer({});
  const db = makeDb({ psAttendance: [att("1001")], psGrades: [grade("1001", "S1", 90)] });
  const out = await m.academicCounts.handler(db.ctx, { today: "2026-09-21" });
  const keys = Object.keys(out.rows[0]);
  const pii = ["firstName", "lastName", "name", "studentName", "email", "grade", "race", "raceCodes", "fedEthnicity", "gender"];
  check("NO NAME, GRADE OR DEMOGRAPHIC CROSSES THE WIRE",
    pii.every((k) => !keys.includes(k)), keys.join(","));
  check("and the handler source never mentions one",
    !/firstName|lastName|studentName|fedEthnicity|raceCodes/.test(serverSrc));
}
{
  // An unbounded read is what broke clearRoster and the grade sync once
  // psGrades passed Convex's 4,096 documents.
  check("the handler never calls collect()", !/\.collect\(\)/.test(serverSrc));
  check("every read is take()-bounded", (serverSrc.match(/\.take\(/g) || []).length >= 3);
  check("the page size is capped by a constant", /PAGE_MAX/.test(serverSrc));
  // SIZED FOR MAY, NOT SEPTEMBER. 250 students a page was ~4,126 reads against
  // a 4,096 limit on 2026-09-21 data, and psMissingWork accumulates all term.
  check("the page is small enough to survive the term's growth", /const PAGE_MAX = 100;/.test(serverSrc),
    "at 250 it passed in September and would fail by spring");
}
{
  // What it actually spent, so growth is visible before it is fatal.
  const m = loadServer({});
  const db = makeDb({
    psAttendance: [att("1001"), att("1002")],
    psGrades: [grade("1001", "S1", 90), grade("1001", "S2", 80), grade("1002", "S1", 70)],
    psMissingWork: [miss("1001", "S1", "2026-09-20"), miss("1002", "S1", "2026-09-20")],
  });
  const out = await m.academicCounts.handler(db.ctx, { today: "2026-09-21" });
  check("the response reports the documents it read", out.docsRead === 7, String(out.docsRead));
  check("and does not cry wolf on a small page", out.nearReadLimit === false);
  check("and states the page size it used", out.pageSize === 100, String(out.pageSize));
  check("the client surfaces the warning rather than swallowing it",
    /nearReadLimit\) bits\.push/.test(script));
  check("and the page loop is bounded above 679 students at 100 a page",
    /pages < 40/.test(script), "679/100 is 7 pages; 20 was fine at 250 and is not a real bound now");
}

console.log("\nthe wiring, resolved end to end");

// CHECKLIST 02: the role gate, on both sides.
check("the privileged tab list includes earlyWarning", D.disciplineTabsFor("admin").indexOf("earlyWarning") !== -1);
for (const r of ["pbis", "admin", "superadmin"]) check(`${r} may open the tab`, D.canOpenDisciplineTab(r, "earlyWarning") === true);
for (const r of ["teacher", "campusaide"]) check(`${r} may NOT open the tab`, D.canOpenDisciplineTab(r, "earlyWarning") === false);
check("a teacher's tabs are still exactly the three they were",
  D.disciplineTabsFor("teacher").join() === "submit,review,closed");
check("the client gate and the server gate name the same three roles",
  /RISK_ROLES = \["admin", "superadmin", "pbis"\]/.test(serverSrc));

// CHECKLIST 04 + 05: the registry and the pane map, which must agree or the
// click is silently dead. This is the exact bug that shipped on 2026-09-20.
const registry = script.slice(script.indexOf("discipline: ["), script.indexOf("};", script.indexOf("discipline: [")));
check("the tab is in the MODE_SUBTABS registry", /id: 'earlyWarning', fn: 'switchDisciplineTab'/.test(registry));
check("its label carries an icon sprite, not an emoji", /wcIcon\('target'\) \+ ' Early Warning'/.test(registry));
const panes = script.slice(script.indexOf("const PANES = {"), script.indexOf("};", script.indexOf("const PANES = {")));
check("the tab id is mapped to a pane in PANES", /earlyWarning: \{ pane: 'behaviorEarlyWarning'/.test(panes));
check("and that pane element actually exists in index.html",
  /id="behaviorEarlyWarning"[^>]*class="discipline-subtab hidden"/.test(html));
// TEETH: every id in the registry must resolve through PANES to a real element.
{
  const ids = [...registry.matchAll(/id: '([a-zA-Z]+)'/g)].map((m) => m[1]);
  const broken = ids.filter((id) => {
    const m = panes.match(new RegExp(id + "\\s*:\\s*\\{\\s*pane: '([A-Za-z]+)'"));
    return !m || !html.includes('id="' + m[1] + '"');
  });
  check("EVERY discipline tab resolves to a pane that exists", broken.length === 0, broken.join(","));
  check("the registry and PANES have the same number of tabs",
    ids.length === [...panes.matchAll(/pane: '/g)].length, `${ids.length} vs ${[...panes.matchAll(/pane: '/g)].length}`);
}
// CHECKLIST 06: opening the tab must actually load it.
check("opening the tab calls the renderer",
  /subtab === 'earlyWarning'\)\s*\{\s*renderEarlyWarning\(\);/.test(script));

// Every handler named in the pane's markup must be a real top-level function.
{
  const pane = html.slice(html.indexOf('id="behaviorEarlyWarning"'), html.indexOf('<!-- Uniform Violations Subtab'));
  check("the pane markup was found", pane.length > 500);
  const handlers = [...pane.matchAll(/on(?:click|change|input)="([a-zA-Z_$][\w$]*)\(/g)].map((m) => m[1]);
  const missing = [...new Set(handlers)].filter((h) => !new RegExp("function " + h + "\\s*\\(").test(script));
  check("EVERY inline handler in the pane is a defined function", missing.length === 0, missing.join(","));
  check("and there is at least one", handlers.length >= 5, String(handlers.length));
  // Every element the renderer reaches for must exist, or the screen is blank
  // with nothing in the console.
  const renderer = script.slice(script.indexOf("async function renderEarlyWarning"), script.indexOf("async function saveRiskSettings"));
  const ids = [...renderer.matchAll(/getElementById\('([A-Za-z]+)'\)/g)].map((m) => m[1]);
  const absent = [...new Set(ids)].filter((id) => !html.includes('id="' + id + '"'));
  check("EVERY element the renderer reads exists in the markup", absent.length === 0, absent.join(","));
  check("and it reads several", ids.length >= 5, String(ids.length));
}

// CHECKLIST 22: the settings blob is replaced wholesale on save, so a key read
// but not sent is destroyed by the next save from any tab.
{
  const sites = (script.match(/^\s*riskSettings,$/gm) || []).length;
  check("riskSettings is SENT and CACHED at every plumbing site", sites === 4, `${sites} of 4`);
  check("it is declared", /let riskSettings = \{\};/.test(script));
  check("it is read on the server load path", /riskSettings = mainData\.riskSettings \|\| riskSettings;/.test(script));
  check("it is read on the local fallback path", /riskSettings = data\.riskSettings \|\| riskSettings;/.test(script));
  check("the defaults are NOT copied into script.js, so there is one set to change",
    !/actAt: 7/.test(script), "the numbers belong to wildcat-discipline.js");
}

// The fetch guard, which is the bug the attendance screen already fixed once.
{
  const fn = script.slice(script.indexOf("async function renderEarlyWarning"), script.indexOf("async function saveRiskSettings"));
  check("the busy guard wraps the FETCH, not the whole render",
    /if \(!res \|\| force\) \{\s*\n\s*if \(_ewBusy\) return;/.test(fn),
    "guarding the render drops a keystroke that arrives mid-load");
  check("and it is released in a finally", /finally \{ _ewBusy = false; \}/.test(fn));
  check("a refusal clears the cards rather than leaving stale ones", /cards\.innerHTML = '';/.test(fn));
  check("the page loop is bounded so a server that never says done cannot hang the tab",
    /for \(pages = 0; pages < 40; pages\+\+\)/.test(script),
    "679 students at 100 a page is 7 round trips; the bound must exceed that and still terminate");
}

// The wall the owner put around uniform violations, checked mechanically.
check("the indicator does not read uniform violations anywhere",
  !/uniformViolations|uniformRanking|uniformTier/.test(serverSrc),
  "owner decision 2026-09-18: uniform violations are a separate log");
{
  // THE RULE IS NO DATA DEPENDENCY, not the absence of a word. An earlier
  // version of this assertion forbade "uniform" anywhere in the block and
  // failed on a comment crediting the screen whose save pattern this copied,
  // which is a worse screen for a better test score.
  const ewBlock = script.slice(script.indexOf("// EARLY WARNING"), script.indexOf("// UNIFORM VIOLATIONS"));
  const reads = /uniformRanking|uniformTier|uniformSettingsNow|uniformViolations|UNIFORM_TIERS|uniformSettings\b/;
  check("and the screen reads no uniform data either", !reads.test(ewBlock),
    "owner decision 2026-09-18: uniform violations are a separate log");
  check("nor does it query the uniform table", !/uniformViolations:/.test(ewBlock));
}
check("nothing in the indicator touches earned value",
  !/wildcatCash|pbisTickets|balance|deducted/i.test(serverSrc));


console.log("\nthe renderer, actually executed against a fake DOM");

// WHY THIS EXISTS. The uniform screen shipped a temporal dead zone crash that
// 98 text-matching assertions walked past, because reading source as a string
// cannot execute it. The id-and-handler resolution above proves the wiring is
// consistent; it cannot prove the function runs. So the real renderEarlyWarning
// is lifted out of script.js and INVOKED, with a DOM just real enough to catch
// a crash, an unreachable element, or an undefined reference.
{
  const lift = (name, endMarker) => {
    const start = script.indexOf(name);
    if (start < 0) throw new Error(name + " is not in script.js");
    const end = script.indexOf(endMarker, start);
    if (end < 0) throw new Error("no end marker after " + name);
    return script.slice(start, end);
  };

  const els = {};
  const mkEl = (id) => (els[id] = {
    id, innerHTML: "", textContent: "", value: "", _attrs: {},
    classList: { toggle() {}, add() {}, remove() {} },
    getAttribute(k) { return this._attrs[k] === undefined ? null : this._attrs[k]; },
    setAttribute(k, v) { this._attrs[k] = v; },
    querySelectorAll() { return []; },
  });
  // Exactly the ids the pane declares. Anything the renderer reaches for that
  // is NOT here comes back null, which is what a missing element does in the
  // browser -- so a typo surfaces as a crash or a silently blank screen.
  ["earlyWarningList", "ewTierCards", "ewCoverageNote", "ewFoot", "ewSettingsHint",
   "ewGradeFilter", "ewSearch", "ewTierFilter", "ewActAt", "ewWatchAt", "ewRecentDays",
   "ewFailManyAt", "ewMissManyAt", "ewTardyManyAt"].forEach(mkEl);

  const sandbox = {
    document: { getElementById: (id) => els[id] || null, activeElement: null },
    window: { WildcatDiscipline: D },
    console,
    escapeHtml: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    students: [
      { id: "s1", studentNumber: "1001", firstName: "A", lastName: "One", grade: "9" },
      { id: "s2", studentNumber: "1002", firstName: "B", lastName: "Two", grade: "10" },
      { id: "s3", studentNumber: "1003", firstName: "C", lastName: "Three", grade: "" },
    ],
    attendanceSchoolDays: () => ({ first: "2026-08-12", weekdays: 29, off: 0, days: 29 }),
  };

  // The REAL grade helpers, the REAL merge, and the REAL renderer. The merge
  // is included rather than stubbed because it is where the dark-feed nulling
  // and the attendance re-merge actually happen.
  const src =
    lift("function attGradeKey(", "\n        function attendanceSchoolDays") +
    "\n" +
    lift("function hydrateRiskSettingsInputs(settings)", "\n        function setEarlyWarningTierFilter") +
    "\n" +
    lift("function mergeEarlyWarningRows(cache, att)", "\n        /**\n         * Pull the course-performance counts") +
    "\n" +
    lift("async function renderEarlyWarning(", "\n        /**\n         * Save the thresholds");

  const build = (payload, settings, attCache) => new Function(
    "document", "window", "console", "escapeHtml", "students", "attendanceSchoolDays",
    "riskSettings", "loadEarlyWarningRows", "_ewCacheIn", "filters", "_attCacheIn",
    `let _ewCache = _ewCacheIn, _ewBusy = false, _ewSettingsHydrated = false;
     let _attCache = _attCacheIn;
     let _ewTierFilter = filters.tier, _ewGradeFilter = filters.grade;
     ${src}
     return renderEarlyWarning().then(() => ({ cache: _ewCache, hydrated: _ewSettingsHydrated }));`
  )(sandbox.document, sandbox.window, sandbox.console, sandbox.escapeHtml, sandbox.students,
    sandbox.attendanceSchoolDays, settings || {}, async () => payload, payload,
    { tier: filters.tier, grade: filters.grade }, attCache === undefined ? null : attCache);

  let filters = { tier: "actWatch", grade: "all" };
  // The ACADEMIC half, exactly as convex/earlyWarning.ts returns it.
  const academic = [
    { studentNumber: "1001", failingCourses: 3, failingCoursesRaw: 4, ungradedCourses: 1, gradedCourses: 9,
      missingRecent: 6, missingOlder: 2, hasMissingFeed: true, missingTruncated: false, gradesTruncated: false, sisAsOf: "2026-09-21" },
    { studentNumber: "1002", failingCourses: 0, failingCoursesRaw: 0, ungradedCourses: 0, gradedCourses: 9,
      missingRecent: 0, missingOlder: 0, hasMissingFeed: false, missingTruncated: false, gradesTruncated: false, sisAsOf: "2026-09-21" },
    // No grades on file at all: the gap case.
    { studentNumber: "1003", failingCourses: null, failingCoursesRaw: null, ungradedCourses: null, gradedCourses: null,
      missingRecent: 4, missingOlder: 0, hasMissingFeed: true, missingTruncated: false, gradesTruncated: false, sisAsOf: "2026-09-21" },
  ];
  // The ATTENDANCE half, as attendanceList:schoolAttendance returns it.
  const attCache = { allowed: true, truncated: false, lastSyncedAt: "2026-09-21T13:00:00.000Z", rows: [
    { studentNumber: "1001", daysAbsent: 20, daysTardy: 12 },
    { studentNumber: "1002", daysAbsent: 0, daysTardy: 0 },
    // null, never 0: this child's figure was never sent.
    { studentNumber: "1003", daysAbsent: null, daysTardy: null },
  ] };
  const mkPayload = (over) => ({
    allowed: true, reason: null, academic, attRef: null, rows: [],
    behaviour: { status: "unknown" }, truncated: false, incomplete: false, nearReadLimit: false,
    missingFeedDark: false, feedStudents: 2, truncatedRows: 0,
    lastSyncedAt: "2026-09-21T13:00:00.000Z", ...(over || {}),
  });
  const payload = mkPayload();

  let threw = null;
  try { await build(payload, {}, attCache); } catch (e) { threw = e; }
  check("IT RUNS WITHOUT THROWING", threw === null, threw && (threw.message || String(threw)));

  if (!threw) {
    check("it writes the ranked list", els.earlyWarningList.innerHTML.length > 100);
    check("the worst student is first", els.earlyWarningList.innerHTML.indexOf("A One") <
      (els.earlyWarningList.innerHTML.indexOf("C Three") + 1 || 1e9));
    check("the top row is badged Act now", /wc-ew-act[\s\S]*Act now/.test(els.earlyWarningList.innerHTML));
    // The outer card carries both classes; the three inner divs are
    // wc-att-tier-n/-l/-s, so match the accent class rather than the prefix.
    check("it writes the four tier cards",
      (els.ewTierCards.innerHTML.match(/wc-att-tier wc-ew-/g) || []).length === 4,
      String((els.ewTierCards.innerHTML.match(/wc-att-tier wc-ew-/g) || []).length));
    check("the dark behaviour axis is stated above the list, in words",
      /Behaviour is NOT part of these scores/.test(els.ewCoverageNote.textContent), els.ewCoverageNote.textContent);
    check("the school-day basis is stated and points at where to change it",
      /29 school days/.test(els.ewCoverageNote.textContent) && /Attendance Watch/.test(els.ewCoverageNote.textContent));
    check("the settings hint reports what the thresholds name RIGHT NOW",
      /name \d+ and \d+/.test(els.ewSettingsHint.textContent), els.ewSettingsHint.textContent);
    check("the grade dropdown is built from the data, with counts",
      /All grades \(3\)/.test(els.ewGradeFilter.innerHTML) && /No grade on file/.test(els.ewGradeFilter.innerHTML));
    check("the stored thresholds are pushed into the inputs",
      els.ewActAt.value === 7 || els.ewActAt.value === "7", String(els.ewActAt.value));
    // A gap must be COUNTED wherever you are, and REACHABLE from the Data gaps
    // view. It is deliberately not in the default Act now & watch list: this
    // student scores 1 point, because two of their three axes are dark and an
    // unknown must never be scored as though it were bad OR good.
    check("the foot counts students ranked with no grades on file",
      /no grades on file/.test(els.ewFoot.textContent), els.ewFoot.textContent);
    check("the last sync is stated", /Last synced 2026-09-21/.test(els.ewFoot.textContent));
    check("nothing is rendered unescaped", !/<script/i.test(els.earlyWarningList.innerHTML));
  }

  // A refusal must clear the screen rather than leave the previous list up.
  {
    let t = null;
    try { await build({ allowed: false, reason: "Nope, not your access level.", rows: [] }, {}, attCache); }
    catch (e) { t = e; }
    check("a refusal renders without throwing", t === null, t && (t.message || String(t)));
    if (!t) {
      check("and prints the server's reason", /Nope, not your access level\./.test(els.earlyWarningList.innerHTML));
      check("and clears the tier cards rather than leaving stale ones", els.ewTierCards.innerHTML === "");
      check("and clears the foot", els.ewFoot.textContent === "");
    }
  }

  // A name carrying markup must not become markup. Names come from PowerSchool.
  {
    sandbox.students.push({ id: "s4", studentNumber: "1004", firstName: "<img src=x onerror=alert(1)>", lastName: "Evil", grade: "9" });
    const evil = mkPayload({ academic: [...academic, { studentNumber: "1004",
      failingCourses: 3, failingCoursesRaw: 3, ungradedCourses: 0, gradedCourses: 9,
      missingRecent: 6, missingOlder: 0, hasMissingFeed: true, sisAsOf: "2026-09-21" }] });
    const evilAtt = { ...attCache, rows: [...attCache.rows, { studentNumber: "1004", daysAbsent: 20, daysTardy: 0 }] };
    let t = null;
    try { await build(evil, {}, evilAtt); } catch (e) { t = e; }
    check("a hostile student name renders without throwing", t === null, t && (t.message || String(t)));
    if (!t) {
      check("A HOSTILE NAME IS ESCAPED, not injected",
        !/<img src=x/.test(els.earlyWarningList.innerHTML) && /&lt;img src=x/.test(els.earlyWarningList.innerHTML));
    }
  }

  // THE DARK FEED, END TO END through the real merge and the real renderer.
  {
    const dark = mkPayload({
      missingFeedDark: true, feedStudents: 0,
      academic: academic.map((a) => ({ ...a, hasMissingFeed: false })),
    });
    filters = { tier: "all", grade: "all" };
    let t = null, got = null;
    try { got = await build(dark, {}, attCache); } catch (e) { t = e; }
    check("a dark owed-work feed renders without throwing", t === null, t && (t.message || String(t)));
    if (!t) {
      check("and the merge nulls the counts for EVERY student",
        got.cache.rows.every((r) => r.missingRecent === null && r.missingOlder === null),
        JSON.stringify(got.cache.rows.map((r) => r.missingRecent)));
      check("and the screen warns, naming it a sync problem not a healthy school",
        /owed work is NOT part of these scores/i.test(els.ewCoverageNote.textContent) &&
        /sync problem/i.test(els.ewCoverageNote.textContent), els.ewCoverageNote.textContent);
      check("and says the top tier cannot be reached",
        /"Act now" at 7 will read 0/.test(els.ewCoverageNote.textContent), els.ewCoverageNote.textContent);
      check("and the rows say owed work is unknown rather than showing a clean zero",
        /owed work unknown/.test(els.earlyWarningList.innerHTML));
      check("and nobody reaches Act now, which is the point of the warning",
        !/Act now<\/span>/.test(els.earlyWarningList.innerHTML));
    }
    // The healthy case must NOT warn, or the warning means nothing.
    filters = { tier: "all", grade: "all" };
    let t2 = null;
    try { await build(payload, {}, attCache); } catch (e) { t2 = e; }
    check("a healthy feed does not cry wolf",
      t2 === null && !/owed work is NOT part/i.test(els.ewCoverageNote.textContent));
    check("and states the coverage as a fact", /Owed-work data covers 2 of 3 students/.test(els.ewFoot.textContent),
      els.ewFoot.textContent);
  }

  // THE ATTENDANCE RE-MERGE. Attendance Watch replaces _attCache on Refresh;
  // a stale copy meant the two screens disagreeing about the same child.
  {
    const cached = mkPayload();
    // Pretend the cache was built against the old attendance object.
    const stale = { ...attCache, rows: [{ studentNumber: "1001", daysAbsent: 5, daysTardy: 0 },
                                        { studentNumber: "1002", daysAbsent: 0, daysTardy: 0 },
                                        { studentNumber: "1003", daysAbsent: null, daysTardy: null }] };
    cached.attRef = stale;
    cached.rows = [{ studentNumber: "1001", daysAbsent: 5, daysTardy: 0, failingCourses: 3, missingRecent: 6 }];
    filters = { tier: "all", grade: "all" };
    let t = null, got = null;
    // A DIFFERENT attendance object is now live - the post-sync one.
    try { got = await build(cached, {}, attCache); } catch (e) { t = e; }
    check("a replaced attendance cache triggers a re-merge", t === null, t && (t.message || String(t)));
    if (!t) {
      const one = got.cache.rows.find((r) => r.studentNumber === "1001");
      check("and the row now carries the NEW attendance figure, not the cached one",
        one && one.daysAbsent === 20, one && String(one.daysAbsent));
      check("and attRef is updated so it does not re-merge forever", got.cache.attRef === attCache);
    }
  }

  // A CAPPED READ means an under-counted student, and the screen must say the
  // score is a floor rather than a total.
  {
    const capped = mkPayload({
      truncatedRows: 1,
      academic: academic.map((a) => a.studentNumber === "1001" ? { ...a, missingTruncated: true } : a),
    });
    filters = { tier: "all", grade: "all" };
    let t = null;
    try { await build(capped, {}, attCache); } catch (e) { t = e; }
    check("a truncated student renders without throwing", t === null, t && (t.message || String(t)));
    if (!t) {
      check("their row says the score is a floor", /score is a floor/.test(els.earlyWarningList.innerHTML));
      check("and the foot counts them", /1 student has more grades or owed work/.test(els.ewFoot.textContent),
        els.ewFoot.textContent);
    }
  }

  // THE HINT'S TWO HALVES MUST BE THE SAME POPULATION.
  {
    filters = { tier: "all", grade: "all" };
    await build(payload, {}, attCache);
    check("unscoped, the hint says whole school", /across the whole school\.$/.test(els.ewSettingsHint.textContent),
      els.ewSettingsHint.textContent.slice(-70));
    filters = { tier: "all", grade: "9" };
    await build(payload, {}, attCache);
    check("scoped to a grade, the hint says WHICH grade it just counted",
      /in grade 9\.$/.test(els.ewSettingsHint.textContent), els.ewSettingsHint.textContent.slice(-70));
  }

  // THE INPUTS ARE THE ADMIN'S once the pane has drawn.
  {
    filters = { tier: "all", grade: "all" };
    const got = await build(payload, {}, attCache);
    check("the first render hydrates the thresholds", got.hydrated === true && String(els.ewActAt.value) === "7");
    // Simulate an unsaved edit, then a re-render caused by typing in search.
    els.ewActAt.value = "6";
    const again = new Function(
      "document", "window", "console", "escapeHtml", "students", "attendanceSchoolDays",
      "riskSettings", "loadEarlyWarningRows", "_ewCacheIn", "filters", "_attCacheIn", "hydratedIn",
      `let _ewCache = _ewCacheIn, _ewBusy = false, _ewSettingsHydrated = hydratedIn;
       let _attCache = _attCacheIn;
       let _ewTierFilter = filters.tier, _ewGradeFilter = filters.grade;
       ${src}
       return renderEarlyWarning();`
    );
    await again(sandbox.document, sandbox.window, sandbox.console, sandbox.escapeHtml, sandbox.students,
      sandbox.attendanceSchoolDays, {}, async () => payload, payload,
      { tier: "all", grade: "all" }, attCache, true);
    check("A RE-RENDER DOES NOT REVERT AN UNSAVED EDIT", String(els.ewActAt.value) === "6",
      "an every-render hydrate is what made Save store the old number");
  }

  // Every filter must render. A filter that throws is a dead button.
  for (const tier of ["actWatch", "act", "watch", "improving", "gaps", "all"]) {
    filters = { tier, grade: "all" };
    let t = null;
    try { await build(payload, {}, attCache); } catch (e) { t = e; }
    check(`the "${tier}" filter renders without throwing`, t === null, t && (t.message || String(t)));
    if (!t && tier === "gaps") {
      check("and the Data gaps view REACHES the student with no grades",
        /C Three/.test(els.earlyWarningList.innerHTML) && /no grades on file/.test(els.earlyWarningList.innerHTML),
        els.earlyWarningList.innerHTML.slice(0, 200));
    }
    if (!t && tier === "act") {
      check("and Act now holds only the 8-point student",
        (els.earlyWarningList.innerHTML.match(/wc-att-row/g) || []).length === 1);
    }
  }
  // And so must a grade scope, including the no-grade bucket.
  for (const grade of ["9", "(none)", "all"]) {
    filters = { tier: "all", grade };
    let t = null;
    try { await build(payload, {}, attCache); } catch (e) { t = e; }
    check(`the grade scope "${grade}" renders without throwing`, t === null, t && (t.message || String(t)));
  }
  filters = { tier: "actWatch", grade: "all" };
  // Zero school days: every rate must be refused rather than read as perfect.
  {
    const saved = sandbox.attendanceSchoolDays;
    sandbox.attendanceSchoolDays = () => ({ first: "", weekdays: 0, off: 0, days: 0 });
    let t = null;
    try { await build(payload, {}, attCache); } catch (e) { t = e; }
    check("no school days yet renders without throwing", t === null, t && (t.message || String(t)));
    if (!t) check("and says no rate can be worked out", /No school days counted yet/.test(els.ewCoverageNote.textContent));
    sandbox.attendanceSchoolDays = saved;
  }
  // An empty school renders an empty state, not a crash.
  {
    let t = null;
    try { await build(mkPayload({ academic: [] }), {}, { allowed: true, rows: [] }); } catch (e) { t = e; }
    check("an empty roster renders an empty state", t === null && /No students match/.test(els.earlyWarningList.innerHTML),
      t && (t.message || String(t)));
  }
}


console.log("\nwhat the adversarial review found, now pinned");

// Eight defects survived two independent skeptics on 2026-09-21. Each one gets
// an assertion here, because a fix with no test is a fix that comes back.
{
  // 1 (high). An empty psMissingWork table is a SYNC FAULT, not a school that
  // owes nothing. sisAction.ts:333-348 clears the table unconditionally before
  // inserting, and this feed returned HTTP 200 with zero rows for the whole of
  // plugin 1.3.0. Scored as a known zero it drops every student up to 2 points:
  // the ceiling falls from 8 to 6 and "Act now" at 7 is mathematically empty.
  const m = loadServer({});
  const db = makeDb({ psAttendance: [att("1001")], psGrades: [grade("1001", "S1", 40)], psMissingWork: [] });
  const out = await m.academicCounts.handler(db.ctx, { today: "2026-09-21" });
  check("the server reports how many students the owed-work feed covers", out.withMissingFeed === 0);
  const db2 = makeDb({ psAttendance: [att("1001")], psMissingWork: [miss("1001", "S1", "2026-09-20")] });
  const out2 = await m.academicCounts.handler(db2.ctx, { today: "2026-09-21" });
  check("and counts a student who does have a feed", out2.withMissingFeed === 1);

  // The rule half: null must mean unknown all the way to the row.
  const dark = D.riskCourse({ failingCourses: 2, missingRecent: null, missingOlder: null }, {});
  check("a null owed-work count is NOT a known zero", dark.missingKnown === false);
  const sc = D.riskScore({ studentNumber: "1", daysAbsent: 6, daysTardy: 0, failingCourses: 2, missingRecent: null }, 29, unknown);
  check("and the gap is nameable on the row", sc.unknown.indexOf("missing") !== -1, sc.unknown.join(","));
  check("a KNOWN zero is still a known zero, per student",
    D.riskCourse({ failingCourses: 2, missingRecent: 0, missingOlder: 0 }, {}).missingKnown === true);
  // The client half.
  check("the client derives a school-wide dark feed rather than trusting one row",
    /const missingFeedDark = academic\.length > 0 && feedStudents === 0;/.test(script));
  check("a dark feed nulls the counts for everybody instead of scoring them",
    /missingRecent: dark \? null : c\.missingRecent/.test(script));
  check("and the screen says so beside the behaviour gap, in words",
    /WARNING: owed work is NOT part of these scores/.test(script));
  check("hasMissingFeed now has a consumer", /r\.hasMissingFeed \? 1 : 0/.test(script));
}
{
  // 2 (medium). A capped per-student read means an under-counted and therefore
  // UNDER-RANKED student - the child who hands in nothing is exactly who sinks.
  const m = loadServer({});
  const many = [];
  for (let i = 0; i < 200; i++) many.push(miss("1001", "S1", "2026-09-20"));
  const db = makeDb({ psAttendance: [att("1001")], psMissingWork: many });
  const out = await m.academicCounts.handler(db.ctx, { today: "2026-09-21" });
  check("a student at the owed-work read cap is flagged", out.rows[0].missingTruncated === true);
  check("and the page counts them", out.truncatedRows === 1);
  const db2 = makeDb({ psAttendance: [att("1001")], psMissingWork: [miss("1001", "S1", "2026-09-20")] });
  const out2 = await m.academicCounts.handler(db2.ctx, { today: "2026-09-21" });
  check("a normal student is not flagged", out2.rows[0].missingTruncated === false && out2.truncatedRows === 0);
  check("the caps are named constants, so their edge is checkable",
    /MAX_MISSING_PER_STUDENT/.test(serverSrc) && /MAX_GRADES_PER_STUDENT/.test(serverSrc));
  check("the rule carries the flag through to the row", D.riskCourse({ failingCourses: 1, missingRecent: 5, missingTruncated: true }, {}).missingTruncated === true);
  check("and the screen calls the score a floor", /score is a floor/.test(script));
}
{
  // 3 (medium). The search box re-renders on every keystroke, so an
  // every-render hydrate reverted a threshold the admin had typed - and Save
  // then read the reverted number back out of the DOM and stored it.
  check("the inputs are hydrated once, not on every render",
    /if \(!_ewSettingsHydrated\) hydrateRiskSettingsInputs\(settings\);/.test(script));
  check("and the hydrate sets the flag so it cannot repeat",
    /_ewSettingsHydrated = true;/.test(script));
  check("a successful save re-hydrates, so the saved value is what is shown",
    /hydrateRiskSettingsInputs\(next\);/.test(script));
}
{
  // 4 (medium). riskSettings was assigned before the save and never rolled
  // back, so a failed save left memory claiming a 30-day window while the
  // cache held counts the server split at 14.
  check("a failed save rolls the thresholds back", /riskSettings = prev;/.test(script));
  check("and puts the inputs back too", /hydrateRiskSettingsInputs\(prev\);/.test(script));
  check("and says they were put back rather than just 'not saved'",
    /have been put back/.test(script));
}
{
  // 5 (medium). ranked.counts is computed from the GRADE-SCOPED rows, so
  // printing it after "measured across the whole school" asserted that a
  // grade's four students were the school's 31.
  check("the thresholds hint states which population it is counting",
    /across the whole school'\s*\n?\s*: \(_ewGradeFilter === '\(none\)'/.test(script) || /\+ where \+ '\.'/.test(script));
}
{
  // 6 (medium). _attCache is shared with Attendance Watch, which replaces it on
  // Refresh. A copied figure meant one screen saying 21% absent and the other
  // 18%, about the same child, with nothing to say which was true.
  check("the merge is extracted so it can be redone", /function mergeEarlyWarningRows\(cache, att\)/.test(script));
  check("the cache remembers which attendance object it merged", /attRef: att \|\| null;?/.test(script) || /cache\.attRef = att \|\| null;/.test(script));
  check("and the render re-merges when that object has been replaced",
    /res\.attRef !== _attCache\) \{\s*\n\s*mergeEarlyWarningRows\(res, _attCache\);/.test(script));
}
{
  // 7 and 8 (low). A band that cannot hold anybody is not a tier: actAt ===
  // watchAt made "Watch" unreachable and printed "6-5 points" above a
  // permanent zero; watchAt 1 did the same to "Some signs" with "1-0 points".
  const s1 = D.riskSettingsOrDefault({ watchAt: 1 });
  check("Watch cannot start below 2, or 'Some signs' can hold nobody", s1.watchAt >= 2, String(s1.watchAt));
  const s2 = D.riskSettingsOrDefault({ actAt: 6, watchAt: 6 });
  check("Act now cannot equal Watch, or 'Watch' can hold nobody", s2.actAt > s2.watchAt, `${s2.actAt} vs ${s2.watchAt}`);
  const s3 = D.riskSettingsOrDefault({ actAt: 5, watchAt: 6 });
  check("an inverted pair is separated, not merely ordered", s3.actAt > s3.watchAt);
  // The card's band is watchAt..actAt-1, so it can never render reversed now.
  ["watchAt", "actAt"].forEach(() => {});
  for (const cand of [{ actAt: 1, watchAt: 1 }, { actAt: 2, watchAt: 8 }, { actAt: 0, watchAt: 0 }, {}]) {
    const s4 = D.riskSettingsOrDefault(cand);
    check(`bands stay orderable for ${JSON.stringify(cand)}`,
      s4.watchAt >= 2 && s4.actAt > s4.watchAt && (s4.actAt - 1) >= s4.watchAt && (s4.watchAt - 1) >= 1,
      `act ${s4.actAt} watch ${s4.watchAt}`);
  }
  check("the defaults still hold after the stricter clamp",
    D.DEFAULT_RISK_SETTINGS.actAt === 7 && D.DEFAULT_RISK_SETTINGS.watchAt === 6);
  check("the markup's bounds cannot offer an impossible number",
    /id="ewWatchAt" min="2" max="7"/.test(html) && /id="ewActAt" min="3" max="8"/.test(html));
}

console.log(`\nearly warning: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
