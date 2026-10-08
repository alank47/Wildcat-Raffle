// The Reflection Room's PowerSchool read: one day, CONFIRMED. Run: npm test
//
// IT RUNS THE SHIPPED CODE. reflectionRead.ts and the rebuild's own psGet /
// countRows / readWindow / sameList (attendanceDays.ts, exported for this
// and otherwise unchanged) are loaded with their imports stripped and run
// against the fake PowerSchool, which applies every filter.
//
// THE RULE UNDER TEST: a read is taken only when two reads in a row are each
// steady (PowerSchool's count before and after equal the rows held, nothing
// served twice) AND hold the same row ids. One steady read is not enough: a
// teacher's save mid-read is a delete plus an insert, the counts still
// match, and the read holds the deleted row and skips a real one. The
// rebuild demonstrated that, and an unconfirmed read here could put a
// student who arrived late on the list or take a real tardy off it.
//
// TEETH: scripts/reflection-teeth.mjs breaks the same-ids check (one steady
// read accepted) and requires "delete + insert mid-read is not taken" to FAIL.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { fakePowerSchool, reflectionDay } from "./fake-powerschool.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const daysSrc = read("./convex/attendanceDays.ts");
const readSrc = read("./convex/reflectionRead.ts");
const rulesSrc = read("./convex/absenceDayRules.ts");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const J = (x) => JSON.stringify(x);
const tsToJs = (src) => ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const strip = (s) => s
  .replace(/^"use node";[ \t]*\n/m, "")
  .replace(/^import[\s\S]*?from\s*"[^"]*";[ \t]*\n/gm, "")
  .replace(/^export (const|async function|function|type) /gm, "$1 ");

const absenceRules = await import("data:text/javascript," + encodeURIComponent(tsToJs(rulesSrc)));
/** Both files in one scope, as the bundle sees them; only Convex's wrappers stubbed and PowerSchool faked. */
function load(fake) {
  const body = strip(daysSrc).replace("const RETRY_PAUSE_MS = 1000;", "const RETRY_PAUSE_MS = 1;") + "\n" + strip(readSrc);
  const v = new Proxy({}, { get: () => () => ({}) });
  const ref = new Proxy({}, { get: () => ref });
  return new Function("internalAction", "internal", "v", "addAbsenceDay", "emptyAbsenceSplit", "fetch",
    tsToJs(body) + "\nreturn { readConfirmed, dayQuery, CONFIRM_MAX_READS, psGet, countRows, readWindow, sameList };")(
    (d) => d, ref, v, absenceRules.addAbsenceDay, absenceRules.emptyAbsenceSplit, fake.fetch);
}

const D = "2026-10-13";
const HOST = "ps.test";
const later = () => Date.now() + 60_000;
// A day big enough to page: 130 rows today across three slots, plus other days' rows the filter must keep out.
function bigDay(extra = {}) {
  const students = [];
  for (let i = 0; i < 130; i++) students.push({ sn: String(10000 + i), grade: 7, sections: { 1: "PT-A", 2: "P1-A", 4: "P3-A", 9: "PU-7" } });
  const marks = students.map((s, i) => ({ sn: s.sn, slot: [1, 2, 4][i % 3], code: i % 5 === 0 ? "T" : "A" }));
  marks.push({ sn: "10000", slot: 2, code: "T", date: "2026-10-12" });
  return reflectionDay({ date: D, students, marks, futureRows: 3, ...extra });
}
const truthIds = (fake, date = D) => fake.tables.attendance.filter((r) => r.att_date === date).map((r) => String(r.id)).sort();
const q = (fx, codeId) => `schoolid==1817;yearid==36;att_date==${D}` + (codeId ? `;attendance_codeid==${codeId}` : "");

console.log("\nA CONFIRMED READ OF ONE DAY\n");
{
  const fx = bigDay();
  const fake = fakePowerSchool(fx.tables);
  const R = load(fake);
  check("the day query keeps school and year in every read, as the rebuild does",
    R.dayQuery({ schoolid: "1817", yearid: "36", date: D }) === q(fx)
    && R.dayQuery({ schoolid: "1817", yearid: "36", date: D, codeId: "2" }) === q(fx, 2));
  const r = await R.readConfirmed(HOST, "tok", q(fx), later(), { expectDate: D });
  check("a quiet day is accepted on the second read, holding exactly PowerSchool's rows for that date",
    r.ok && r.reads === 2 && J(r.ids) === J(truthIds(fake)) && r.count === truthIds(fake).length, J({ ok: r.ok, reads: r.reads, reason: r.reason }));
  check("...and it paged (130 rows is two pages)", r.ok && r.pages >= 4);
  check("other dates (yesterday's row, tomorrow's absences) are never in it", r.ok && [...r.rows.values()].every((x) => x.att_date === D));
  const t = await R.readConfirmed(HOST, "tok", q(fx, 2), later(), { expectDate: D });
  check("the T-only read holds only T rows", t.ok && [...t.rows.values()].every((x) => String(x.attendance_codeid) === "2") && t.ids.length === 26, J(t.ids.length));
  check("one call never makes more than 4 reads", R.CONFIRM_MAX_READS === 4);
}

console.log("\nTEACHERS TYPING WHILE IT READS\n");
{
  const fx = bigDay();
  const newcomer = { schoolid: "1817", yearid: "36", studentid: fx.psIdOf["10001"], att_date: D, periodid: 854, attendance_codeid: 2, ccid: 0 };
  const fake = fakePowerSchool(fx.tables, { swapDuringRead: { row: newcomer, afterPage: 1, match: (s) => s.includes(`att_date==${D}`), times: "once" } });
  const R = load(fake);
  const r = await R.readConfirmed(HOST, "tok", q(fx), later(), { expectDate: D });
  const truth = truthIds(fake);
  check("delete + insert mid-read is not taken", r.ok && J(r.ids) === J(truth), J({ ok: r.ok, reads: r.reads, reason: r.reason }));
  check("...the swap really happened, and it took a third read to confirm",
    fake.swaps === 1 && fake.deleted.length === 1 && r.reads === 3 && !r.ids.includes(String(fake.deleted[0].id)));

  const always = fakePowerSchool(fx.tables, { swapDuringRead: { row: newcomer, afterPage: 1, match: (s) => s.includes(`att_date==${D}`), times: "always" } });
  const ra = await load(always).readConfirmed(HOST, "tok", q(fx), later(), { expectDate: D });
  check("a day that never holds still is refused after 4 reads, with a reason, and nothing is taken",
    !ra.ok && ra.reads === 4 && /did not hold still in 4 reads/.test(ra.reason), J(ra));

  const ins = fakePowerSchool(fx.tables, { insertDuringRead: { row: newcomer, afterPage: 1, match: (s) => s.includes(`att_date==${D}`), times: "once" } });
  const ri = await load(ins).readConfirmed(HOST, "tok", q(fx), later(), { expectDate: D });
  check("an entry that moves the count mid-read is re-read, and the confirmed read includes it",
    ri.ok && ri.reads === 3 && J(ri.ids) === J(truthIds(ins)), J({ ok: ri.ok, reads: ri.reads }));

  const shuffled = fakePowerSchool(fx.tables, { unstablePaging: { match: (s) => s.includes(`att_date==${D}`) } });
  const rs = await load(shuffled).readConfirmed(HOST, "tok", q(fx), later(), { expectDate: D });
  check("pages served from an unstable order (rows twice, rows missing) are never steady", !rs.ok && rs.reads === 4, J(rs));
}

console.log("\nPOWERSCHOOL MISBEHAVING\n");
{
  const fx = bigDay();
  const ignore = fakePowerSchool(fx.tables, { ignoreDateFilter: true });
  const r = await load(ignore).readConfirmed(HOST, "tok", q(fx), later(), { expectDate: D });
  check("a read that comes back with another day's rows is refused", !r.ok && /did not apply the date filter/.test(r.reason), J(r));
  const down = fakePowerSchool(fx.tables, { failCountWith500: 50 });
  const rd = await load(down).readConfirmed(HOST, "tok", q(fx), later());
  check("PowerSchool answering 500: refused with the reason, not thrown", !rd.ok && /HTTP 500/.test(rd.reason), J(rd));
  const slow = fakePowerSchool(fx.tables);
  const rb = await load(slow).readConfirmed(HOST, "tok", q(fx), Date.now() - 1);
  check("past its deadline: refused, never left running", !rb.ok && /budget/.test(rb.reason), J(rb));
}

console.log("\nTHE FAKE'S NEW MOVES\n");
{
  const fx = bigDay();
  const fake = fakePowerSchool(fx.tables);
  const R = load(fake);
  const tId = fx.markIds[0];   // student 10000's T in slot 1 today
  const tRow = () => fake.tables.attendance.find((x) => String(x.id) === String(tId));
  const key = (r) => `${r.studentid}|${r.att_date}|${r.periodid}`;
  const before = { ...tRow() };
  fake.changeCode(tId, 3);
  const r1 = await R.readConfirmed(HOST, "tok", q(fx), later());
  check("changeCode: the next read sees the same row with its new code", r1.ok && String(r1.rows.get(String(tId)).attendance_codeid) === "3");
  const fresh = fake.reenter(tId);
  const r2 = await R.readConfirmed(HOST, "tok", q(fx), later());
  const again = r2.rows.get(String(fresh));
  check("reenter: a new row id under the same student, date and period, and the old id is gone",
    r2.ok && again && key(again) === key(before) && !r2.rows.has(String(tId)) && String(fresh) !== String(tId));
  fake.movePeriod(fresh, 856);
  const r3 = await R.readConfirmed(HOST, "tok", q(fx), later());
  check("movePeriod: the same row id, now under another period", r3.ok && Number(r3.rows.get(String(fresh)).periodid) === 856);

  const day = reflectionDay({
    date: D,
    students: [{ sn: "S1", grade: 7, sections: { 1: "PT-A", 2: "P1-A", 9: "PU-7" }, courses: { 9: "RSP A" } }],
    meet: [1, 2], sectionMarks: ["PU-7"], marks: [{ sn: "S1", slot: 2, code: "T" }], futureRows: 3,
  });
  check("the day fixture: a slot it meets holds at least 10 rows", day.rowCountBySlot[1] === 10 && day.rowCountBySlot[2] === 11);
  check("...a marked section has a classmate's row in its slot, and an unmarked one has none",
    day.tables.attendance.some((r) => r.periodid === 859 && r.att_date === D) && !day.tables.attendance.some((r) => r.periodid === 851 && r.studentid === day.psIdOf.S1));
  check("...future-dated rows land on the next day only (3 per slot)",
    day.tables.attendance.filter((r) => r.att_date === "2026-10-14").length === 18 && day.rowCountBySlot[10] === undefined);
  check("...and the roster rows carry the slot in the section expression, as psRoster does",
    day.psRoster.some((r) => r.studentNumber === "S1" && r.period === "9(A-E)" && r.courseName === "RSP A"));
  check("...with PowerSchool's codes and student ids to map them", day.codeId.T === 2 && day.codeId.D === 3
    && day.tables.students.some((s) => s.student_number === "S1" && s.id === day.psIdOf.S1));
}

console.log("\nTHE REBUILD IS UNCHANGED\n");
{
  check("psGet, countRows, readWindow and sameList are exported",
    ["export async function psGet(", "export async function countRows(", "export async function readWindow(", "export function sameList("]
      .every((s) => daysSrc.includes(s)));
  check("the rebuild's live piece still demands a second read with the same ids",
    daysSrc.includes("const confirmed = prevIds === null ? !confirm : sameList(prevIds, ids);"));
  check("reflectionRead.ts reads PowerSchool only through the rebuild's helpers",
    /^import \{ countRows, readWindow, sameList \} from "\.\/attendanceDays";$/m.test(readSrc) && !/await fetch\(/.test(readSrc));
  check("this test runs in npm test, before the teeth that break it",
    /node reflection-read\.test\.mjs && node scripts\/reflection-teeth\.mjs/.test(JSON.parse(read("./package.json")).scripts.test));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
