// The Reflection Room verify script: a second, independent reading of
// PowerSchool that the pilot's controls are judged by. Run: npm test
//
// IT RUNS THE SHIPPED SCRIPT (scripts/reflection-verify.mjs) against the fake
// PowerSchool, which applies every filter, and a fake export standing in for
// `npx convex run reflectionList:verifyExport`. Nothing reaches a real
// PowerSchool or Convex, and the script's files go to a scratch folder that is
// removed at the end.
//
// What must hold:
//   - its own rule: an arrival is an arrival, a late arriver's later tardy
//     counts, a section with no marks holds until after school;
//   - its own confirmed read: a teacher saving mid-read is not taken;
//   - the snapshot keeps SALTED hashes only, readable by this user only;
//   - every difference lands in the right bucket, and a list that agrees with
//     PowerSchool is CLEAN, one that does not is NOT CLEAN, and a day with no
//     snapshot is NOT JUDGED;
//   - it prints counts only: no student number ever reaches the output.
//
// TEETH: scripts/reflection-teeth.mjs breaks the verify's own arrival rule,
// its same-ids check, its salt and its "dropped by the reader" bucket, one at a
// time, and requires the check named for each to FAIL.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePowerSchool, REFLECTION_CODES } from "./fake-powerschool.mjs";

const V = await import(new URL("./scripts/reflection-verify.mjs", import.meta.url).href);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const J = (x) => JSON.stringify(x);

const SCHOOL = "1817", YEAR = "36";
const ENV = { schoolId: SCHOOL, yearId: YEAR, termId: "3601" };
const CODE = { A: 1, T: 2, D: 3, K: 4, P: 5 };
const MON = "2026-10-12", TUE = "2026-10-13";
const la = (date, hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + ((h + 7) * 60 + m) * 60000).toISOString();   // PDT
};

/** Middle school sections, by slot: Promise Time AM, P1-P6, MS Power-Up (9), Promise Time PM. */
const MS = { 1: "PT-A", 2: "P1-A", 3: "P2-A", 4: "P3-A", 5: "P4-A", 6: "P5-A", 7: "P6-A", 9: "PU-7", 10: "PM-A" };
const MON_SLOTS = [1, 2, 4, 6, 8, 9, 10], TUE_SLOTS = [1, 3, 5, 7, 8, 9, 10];
/** The students under test: student numbers that must never be printed. */
const SN = { A: "5101", B: "5102", BX: "5103", M: "5104", DR: "5105", L: "5106", C: "5107", S6: "5108", W: "5109", K9: "5110", P: "5111",
  PA: "5112", QA: "5113" };

function world() {
  const tables = {
    attendance: [],
    attendance_code: REFLECTION_CODES.map((c) => ({ ...c, schoolid: SCHOOL, yearid: YEAR })),
    students: [],
    cc: [],
  };
  let sid = 70000, rid = 100000, ccid = 1;
  const psId = {};
  const add = (sn, sections) => {
    psId[sn] = ++sid;
    tables.students.push({ id: psId[sn], student_number: sn, grade_level: "7", schoolid: SCHOOL });
    for (const [slot, sectionid] of Object.entries(sections)) {
      tables.cc.push({ id: ccid++, studentid: psId[sn], sectionid, expression: `${slot}(A-E)`, dateenrolled: "2026-08-12",
        dateleft: "2027-06-10", termid: 3601, schoolid: SCHOOL });
    }
  };
  for (const sn of Object.values(SN)) add(sn, MS);
  // A classmate in every section (so every section has marks) and 20 fillers
  // (so every meeting slot holds at least 20 rows: a school day).
  add("CM", MS);
  for (let i = 0; i < 20; i++) add(`F${i}`, Object.fromEntries(Object.keys(MS).map((s) => [s, `FILL-${s}`])));
  const mark = (date, sn, slot, code) => {
    const r = { id: ++rid, schoolid: SCHOOL, yearid: YEAR, studentid: psId[sn], att_date: date, periodid: 850 + slot, attendance_codeid: CODE[code], ccid: 0 };
    tables.attendance.push(r);
    return r;
  };
  for (const [date, slots] of [[MON, MON_SLOTS], [TUE, TUE_SLOTS]]) {
    for (const slot of slots) {
      mark(date, "CM", slot, "A");
      for (let i = 0; i < 20; i++) if (String(slot) in MS) mark(date, `F${i}`, slot, "A");
    }
  }
  // Tuesday, as PowerSchool holds it at 11:46 (close + 1).
  mark(TUE, SN.A, 3, "T");                                         // late to P2: counted, on the list
  mark(TUE, SN.B, 1, "A"); mark(TUE, SN.B, 3, "A"); mark(TUE, SN.B, 5, "T");      // arrived during P4: an arrival
  mark(TUE, SN.BX, 1, "A"); mark(TUE, SN.BX, 3, "A"); mark(TUE, SN.BX, 5, "T");   // the same, but the system listed it
  mark(TUE, SN.M, 3, "T");                                         // the system never stored it: missing
  mark(TUE, SN.DR, 3, "T");                                        // seen before the close, left off the list: dropped
  const c = mark(TUE, SN.C, 3, "T");                               // on the list; becomes an Excused Tardy after
  mark(TUE, SN.S6, 7, "T");                                        // P6: the next list
  mark(MON, SN.W, 6, "T");                                         // Monday P5: on Tuesday's list
  mark(TUE, SN.K9, 9, "T");                                        // a Power-Up tardy the system listed: a control
  mark(TUE, SN.P, 9, "A");                                         // absent at Power-Up only: in P4 and P6
  return { tables, psId, mark, cRow: c };
}

/** What the system holds, as verifyExport would hand it over. `good`: a list that agrees with PowerSchool. */
function exportOf({ good }) {
  const listed = (sn, attDate, slot, over) => ({
    id: `t-${sn}-${slot}`, key: `${sn}|${attDate}|${850 + slot}`, studentNumber: sn, attDate, periodId: 850 + slot, slot, code: "T",
    division: "ms", state: "countable", reason: null, firstSeenAt: la(TUE, "07:30"), firstCountableAt: la(TUE, "07:30"), wasHeld: false,
    listsBeforeSeen: 0, unitId: `u-${sn}`, unitServeDay: TUE, unitState: "listed", ...over,
  });
  const tardies = [
    listed(SN.A, TUE, 3),
    listed(SN.B, TUE, 5, { state: "arrival", reason: "Arrived late to school", unitId: null, unitServeDay: null, unitState: null }),
    good ? listed(SN.BX, TUE, 5, { state: "arrival", unitId: null, unitServeDay: null, unitState: null }) : listed(SN.BX, TUE, 5),
    listed(SN.L, TUE, 3, { firstSeenAt: la(TUE, "12:00"), firstCountableAt: la(TUE, "12:00"), unitId: null, unitServeDay: null, unitState: null }),
    listed(SN.C, TUE, 3, { state: "cleared", reason: "now Excused Tardy", unitState: "released" }),
    listed(SN.S6, TUE, 7, { unitId: null, unitServeDay: null, unitState: null }),
    listed(SN.W, MON, 6, { firstSeenAt: la(MON, "15:45") }),
  ];
  if (good) {
    tardies.push(listed(SN.M, TUE, 3), listed(SN.DR, TUE, 3));
  } else {
    tardies.push(listed(SN.DR, TUE, 3, { unitId: null, unitServeDay: null, unitState: null }));
    tardies.push({ ...listed(SN.K9, TUE, 9) });
  }
  const units = [...new Set(tardies.filter((t) => t.unitServeDay === TUE).map((t) => t.studentNumber))]
    .map((sn) => ({ unitId: `u-${sn}`, studentNumber: sn, division: "ms", kind: "new", state: "listed", mode: "shadow", carryBasis: null, carryCount: 0 }));
  units.push({ unitId: `u-${SN.P}`, studentNumber: SN.P, division: "ms", kind: "new", mode: "shadow", carryCount: 0,
    state: good ? "listed" : "carried", carryBasis: "powerschool" });
  return {
    day: TUE,
    settings: { modeByDivision: { ms: "shadow", hs: "off" }, countFromDateByDivision: { ms: MON, hs: null }, lateEntryLists: 5, countDitching: false },
    marked: null,
    dayRow: {
      schoolDay: true, kind: "regular", closeInstant: la(TUE, "11:45"), readyInstant: la(TUE, "12:00"), lastFreezeInstant: la(TUE, "12:21"),
      frozenAt: la(TUE, "11:46"), freezeKind: "closing", closingReadStartedAt: la(TUE, "11:45"), noList: null,
      roomAttendanceDone: false, roomClosed: false,
    },
    days: [], list: units, tardies, uniformsOnList: [],
  };
}

const dirs = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "wc-reflection-verify-")); dirs.push(d); return d; };
// A student number standing on its own. Not a run of digits inside a salted
// hash: 64 random hex characters hold "5101" by chance about once in 70
// snapshots, which made this test fail at random.
const leaks = (text) => Object.values(SN).filter((sn) => new RegExp(`(^|[^0-9a-f])${sn}(?![0-9a-f])`).test(String(text)));

try {
  // ==========================================================================
  console.log("\n1. THE VERIFY'S OWN RULE\n");
  // ==========================================================================
  {
    const w = world();
    const sch = V.school({ codes: w.tables.attendance_code, students: w.tables.students, cc: w.tables.cc });
    const day = V.dayOf(TUE, w.tables.attendance, sch);
    check("the verify's own rule: absent at Promise Time and P2, then T at P4, is an arrival",
      V.verdictOf(day, sch, SN.B, 5, { final: true }) === "arrival");
    check("...and late to P2 with Promise Time AM taken (no row, its section has marks) counts",
      V.verdictOf(day, sch, SN.A, 3, { final: false }) === "counted");
    const w2 = world();
    w2.tables.attendance = w2.tables.attendance.filter((r) => !(r.periodid === 851 && r.att_date === TUE && r.studentid === w2.psId.CM));
    w2.tables.cc.find((r) => r.studentid === w2.psId[SN.A] && r.sectionid === "PT-A").sectionid = "PT-Z";
    const sch2 = V.school({ codes: w2.tables.attendance_code, students: w2.tables.students, cc: w2.tables.cc });
    const day2 = V.dayOf(TUE, w2.tables.attendance, sch2);
    check("...a Promise Time AM section with no marks yet holds the first-class T, and after school it counts",
      V.verdictOf(day2, sch2, SN.A, 3, { final: false }) === "held" && V.verdictOf(day2, sch2, SN.A, 3, { final: true }) === "counted");
    w.mark(TUE, SN.L, 1, "T"); w.mark(TUE, SN.L, 3, "T");
    const day3 = V.dayOf(TUE, w.tables.attendance, sch);
    check("...a tardy at Promise Time AM then the first class: an arrival (owner decision)", V.verdictOf(day3, sch, SN.L, 3, { final: true }) === "arrival");
    check("the verify's own carry fallback: absent at Power-Up only, in class before and after, is served (a pulled student)",
      J(V.carryOf(day, sch, SN.P)) === J({ verdict: "served", presentBoth: true }), J(V.carryOf(day, sch, SN.P)));
    const src = read("./scripts/reflection-verify.mjs");
    check("its rules are its own: nothing is imported from the app's rules or from Convex",
      !/from\s+["'][^"']*(reflectionRules|convex\/|attendanceDays)/.test(src) && !/import\(["'][^"']*convex/.test(src));
  }

  // ==========================================================================
  console.log("\n2. ITS OWN CONFIRMED READ\n");
  // ==========================================================================
  {
    const w = world();
    const steady = fakePowerSchool(w.tables);
    const ps = V.powerSchool({ host: "ps.test", clientId: "id", clientSecret: "secret", fetch: steady.fetch });
    const rows = await ps.readConfirmed("attendance", `schoolid==${SCHOOL};yearid==${YEAR};att_date==${TUE}`, "id,studentid,att_date,periodid,attendance_codeid");
    check("a quiet day is read twice and taken", rows.length === w.tables.attendance.filter((r) => r.att_date === TUE).length);
    const moving = fakePowerSchool(w.tables, {
      swapDuringRead: { row: { schoolid: SCHOOL, yearid: YEAR, studentid: w.psId.CM, att_date: TUE, periodid: 855, attendance_codeid: CODE.A, ccid: 0 },
        afterPage: 1, times: "always", match: (q) => q.includes(`att_date==${TUE}`) },
    });
    const ps2 = V.powerSchool({ host: "ps.test", clientId: "id", clientSecret: "secret", fetch: moving.fetch });
    const refused = await ps2.readConfirmed("attendance", `schoolid==${SCHOOL};yearid==${YEAR};att_date==${TUE}`, "id,studentid,att_date,periodid,attendance_codeid")
      .then(() => "taken", (e) => e.message);
    check("a teacher saving mid-read (a delete plus an insert, counts unchanged): the verify's own read is refused",
      /did not hold still/.test(refused) && moving.swaps >= 2, refused);
  }

  // ==========================================================================
  console.log("\n3. THE CLOSE SNAPSHOT: SALTED HASHES ONLY\n");
  // ==========================================================================
  const dir = scratch();
  {
    const w = world();
    const fake = fakePowerSchool(w.tables);
    const ps = V.powerSchool({ host: "ps.test", clientId: "id", clientSecret: "secret", fetch: fake.fetch });
    const said = [];
    const snap = await V.snapshot({ ps, env: ENV, day: TUE, dir, now: new Date(la(TUE, "11:46")), say: (s) => said.push(s) });
    const file = join(dir, `${TUE}.snapshot.json`);
    const text = readFileSync(file, "utf8");
    const plain = (k) => createHash("sha256").update(k).digest("hex");
    const keys = Object.values(SN).flatMap((sn) => [3, 5, 7, 9].map((s) => `${sn}|${TUE}|${850 + s}`));
    check("the snapshot holds salted hashes only: no student number, no plain hash of a key",
      leaks(text).length === 0 && !keys.some((k) => text.includes(plain(k))) && snap.counted.length === 4 && snap.arrival.length === 2,
      J({ counted: snap.counted.length, arrival: snap.arrival.length, leaks: leaks(text) }));
    check("...readable by this user only, the salt too",
      (statSync(file).mode & 0o777) === 0o600 && (statSync(join(dir, "salt")).mode & 0o777) === 0o600);
    check("...and it prints counts only", said.length === 1 && leaks(said.join("\n")).length === 0
      && /P1-P4 tardies counted 4, held 0, arrivals 2; P5-P6 1/.test(said[0]), said[0]);
  }

  // ==========================================================================
  console.log("\n4. COMPARE: EVERY DIFFERENCE IN ITS BUCKET\n");
  // ==========================================================================
  {
    const w = world();
    w.cRow.attendance_codeid = CODE.D;            // C's tardy excused after the list was made
    w.mark(TUE, SN.L, 3, "T");                     // L entered at 12:00, after the close
    const fake = fakePowerSchool(w.tables);
    const ps = V.powerSchool({ host: "ps.test", clientId: "id", clientSecret: "secret", fetch: fake.fetch });
    const said = [];
    const bad = await V.compare({ ps, env: ENV, day: TUE, dir, exportFn: async () => exportOf({ good: false }), say: (s) => said.push(s),
      now: new Date(la(TUE, "16:00")) });
    const c = bad.counts, k = bad.controls;
    check("the list's own and Monday's P5 tardy are on the list", c.onList === 2, J(c));
    check("an arrival the system also calls an arrival is excluded by rule (agrees)", c.excluded === 1, J(c));
    check("an arrival the system listed is a rule disagreement, and the 'arrival tardies listed' control", k.arrivalListed === 1, J(k));
    check("a tardy counted in PowerSchool that the system never stored is missing", c.missing === 1 && k.missing === 1, J(c));
    check("a tardy counted at the close but left off the list is DROPPED BY THE READER", c.dropped === 1 && k.dropped === 1, J(c));
    check("a tardy entered after the closing read started is entered late, not dropped", c.enteredLate === 1, J(c));
    check("today's P6 waits for the next list", c.nextList === 1, J(c));
    check("a listed tardy PowerSchool has since excused is corrected after the list was made", c.corrected === 1, J(c));
    check("a Power-Up tardy on the list is a control, and a disagreement", k.slotNotClass === 1 && c.disagree === 2, J({ c, k }));
    check("a fallback carry for a student in class before and after Power-Up is a control", k.carryPresentBoth === 1, J(k));
    check("...so the day is NOT CLEAN", bad.verdict === "NOT CLEAN" && said.some((l) => l === "Verdict: NOT CLEAN"));
    check("compare prints counts only: no student number reaches the output", leaks(said.join("\n")).length === 0, J(leaks(said.join("\n"))));
    const result = readFileSync(join(dir, `${TUE}.result.json`), "utf8");
    check("...and keeps the day's counts (no identifiers) for the clean run", leaks(result).length === 0 && JSON.parse(result).verdict === "NOT CLEAN");

    const fake2 = fakePowerSchool(w.tables);
    const ps2 = V.powerSchool({ host: "ps.test", clientId: "id", clientSecret: "secret", fetch: fake2.fetch });
    const good = await V.compare({ ps: ps2, env: ENV, day: TUE, dir, exportFn: async () => exportOf({ good: true }), say: () => {} });
    check("a list that agrees with PowerSchool is CLEAN",
      good.verdict === "CLEAN" && Object.values(good.controls).every((n) => n === 0) && good.counts.onList === 4, J(good));

    const fake3 = fakePowerSchool(w.tables);
    const ps3 = V.powerSchool({ host: "ps.test", clientId: "id", clientSecret: "secret", fetch: fake3.fetch });
    const said3 = [];
    const unjudged = await V.compare({ ps: ps3, env: ENV, day: TUE, dir: scratch(), exportFn: async () => exportOf({ good: true }), say: (s) => said3.push(s) });
    check("a day with no close snapshot is NOT JUDGED (it neither counts toward the clean run nor breaks it)",
      unjudged.verdict === "NOT JUDGED" && said3.some((l) => /NOT JUDGED/.test(l)));
    check("the five school days before are found by its own count of Promise Time rows (Monday, the only one here)",
      fake.log.some((l) => l.kind === "count" && l.q === `schoolid==${SCHOOL};yearid==${YEAR};att_date==${MON};periodid==851`)
      && fake.log.filter((l) => l.kind === "table" && l.table === "attendance" && /att_date==2026-10-12/.test(l.q)).length >= 2);
  }

  // ==========================================================================
  console.log("\n5. THE SECOND REVIEW (2026-10-08): WHAT THE VERIFY MUST NOT CALL A FAULT, AND WHAT IT MUST\n");
  // ==========================================================================
  // Each check judges one export with the verify's own judge(), against
  // PowerSchool as the fake holds it, and only for the students it is about.
  const only = (w, sns) => {
    const ids = new Set(Object.values(SN).filter((sn) => !sns.includes(sn)).map((sn) => w.tables.students.find((s) => s.student_number === sn).id));
    return w.tables.attendance.filter((r) => !ids.has(r.studentid));
  };
  const item = (sn, slot, over) => ({
    id: `t-${sn}-${slot}`, key: `${sn}|${TUE}|${850 + slot}`, studentNumber: sn, attDate: TUE, periodId: 850 + slot, slot, code: "T",
    division: "ms", state: "countable", reason: null, firstSeenAt: la(TUE, "09:30"), firstCountableAt: la(TUE, "09:30"), wasHeld: false,
    listsBeforeSeen: 0, unitId: `u-${sn}`, unitServeDay: TUE, unitState: "listed", ...over,
  });
  const exportWith = (tardies, list, over = {}) => {
    const base = exportOf({ good: true });
    return { ...base, ...over, dayRow: { ...base.dayRow, ...(over.dayRow ?? {}) }, tardies, list, uniformsOnList: [] };
  };
  {
    // P: late to P2 and P4, listed at 11:45. The P2 mark is deleted, then
    // typed back at 13:10 with a Promise Time absence: P2 is now an arrival,
    // and keeps the detention, which still stands on P4 (dc20098).
    // Q: late to P2 only, listed; a Promise Time absence entered after the
    // list re-judges it an arrival and releases the detention.
    const w = world();
    w.mark(TUE, SN.PA, 1, "A"); w.mark(TUE, SN.PA, 3, "T"); w.mark(TUE, SN.PA, 5, "T");
    w.mark(TUE, SN.QA, 1, "A"); w.mark(TUE, SN.QA, 3, "T");
    const sch = V.school({ codes: w.tables.attendance_code, students: w.tables.students, cc: w.tables.cc });
    const days = { [TUE]: V.dayOf(TUE, only(w, [SN.PA, SN.QA]), sch) };
    const unit = (sn, state) => ({ unitId: `u-${sn}`, studentNumber: sn, division: "ms", kind: "new", state, mode: "shadow", carryBasis: null, carryCount: 0 });
    const exp = exportWith([
      item(SN.PA, 3, { state: "arrival", reason: "Arrived late to school" }),
      item(SN.PA, 5),
      item(SN.QA, 3, { state: "arrival", reason: "Arrived late to school", unitState: "released" }),
    ], [unit(SN.PA, "listed"), unit(SN.QA, "released")]);
    const r = V.judge({ day: TUE, days, sch, exp, snap: null, salt: null });
    check("an arrival the system also calls an arrival, still holding the detention it was listed on, is corrected after the list was made: never an 'arrival tardy listed' or a disagreement",
      r.counts.corrected === 2 && r.counts.onList === 1 && r.counts.disagree === 0 && r.controls.arrivalListed === 0
        && Object.values(r.controls).every((n) => n === 0), J({ c: r.counts, k: r.controls }));
    const listedCountable = exportWith([item(SN.PA, 3), item(SN.PA, 5), item(SN.QA, 3, { unitState: "released" })],
      [unit(SN.PA, "listed"), unit(SN.QA, "released")]);
    const r2 = V.judge({ day: TUE, days, sch, exp: listedCountable, snap: null, salt: null });
    check("...while one the system still counts, on the list, is still an 'arrival tardy listed'",
      r2.controls.arrivalListed === 2 && r2.counts.disagree === 2, J({ c: r2.counts, k: r2.controls }));
  }

  // ==========================================================================
  console.log("\nWIRING\n");
  // ==========================================================================
  {
    const pkg = JSON.parse(read("./package.json"));
    check("this test runs in npm test", /&& node reflection-verify\.test\.mjs\b/.test(pkg.scripts.test));
    const src = read("./scripts/reflection-verify.mjs");
    check("the export comes through npx convex run with the deployment named, parsed in this process",
      /execFile\("npx", \["convex", "run", "--deployment", deployment, "reflectionList:verifyExport"/.test(src)
      && /JSON\.parse\(stdout\)/.test(src) && !/console\.log\(stdout|process\.stdout\.write\(stdout/.test(src));
    check("snapshots live outside /private/tmp by default", /join\(homedir\(\), "\.wildcat", "reflection-verify"\)/.test(src));
  }
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
