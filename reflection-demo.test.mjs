// A TEST Reflection Room list in the real Hub, from one day's real PowerSchool
// marks (owner, 2026-10-08). Run: npm test
//
// The owner wanted administrators to see the list in the Hub on Thursday
// 10/8, the day before the pilot counts. reflectionDemo:build (command line)
// reads that day from PowerSchool and stores a TEST list in its own table;
// Discipline > Reflection Room shows it, marked TEST ONLY, while that day has
// no real list; reflectionDemo:clear takes it away.
//
// WHAT COULD GO QUIETLY WRONG, each a TEST list that still looks plausible:
//
//   1. IT IS NOT THE LIST THE REAL SYSTEM WOULD MAKE. A TEST list that drifts
//      from the shipped rules shows admins the wrong thing. So the SHIPPED
//      reader and freeze are driven through Wednesday and Thursday against a
//      fake PowerSchool (fake-powerschool.mjs reflectionDay), and the TEST
//      list built from the same PowerSchool must equal Thursday's real list,
//      row for row: lines, tags, Power-Up, absent this morning, sections.
//   2. IT HIDES OR REPLACES A REAL LIST. A real list made for the same day
//      always wins, and a TEST list is never built for a day the real list
//      counts -- nor shown, nor allowed to stop a print, if the switch is
//      moved after it was built so that its day counts.
//   3. IT LEAVES A RECORD. recordPrint refuses it, and building and clearing
//      it change no table but its own: no tardy, detention, day, print,
//      audit line, setting, lease or uniform entry.
//   4. IT IS SEEN BY SOMEONE THE REAL LIST REFUSES. The same check first.
//   5. SOMETHING ELSE READS IT. Only listForDay and recordPrint ever do.
//   6. AN OPEN TAB FROM BEFORE SHOWS IT UNMARKED. A tab still running an
//      older screen knows nothing of `demo`: handed the rows, it draws them
//      as an ordinary pilot list, names and all, and prints them from the
//      browser's menu with no TEST anywhere. The server sends the rows only
//      to a screen that says it marks them (demoOk); the older screen, run
//      for real against the shipped server, is shown words and no row.
//
// The screen and the printed sheet (TEST banner, watermark, title, slips
// and changes off) are checked in reflection-print.test.mjs, section 11.
//
// TEETH: scripts/reflection-teeth.mjs breaks the "real list wins" guard, the
// print refusal, the access check's place, the previous day's cut and the
// "as if it closed now" judgment, one at a time, and requires the check
// named for each to FAIL.
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { clock, loadConvex, makeDb, runtime } from "./fake-convex.mjs";
import { fakePowerSchool, reflectionDay } from "./fake-powerschool.mjs";
import { makeWorld } from "./fake-reflection-screen.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const schemaSrc = read("./convex/schema.ts");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const J = (x) => JSON.stringify(x);

// The reader and the build log a line of counts each; keep the output readable.
const realLog = console.log;
console.log = (...a) => { if (!(typeof a[0] === "string" && /^\[reflection/.test(a[0]))) realLog(...a); };

const loaded = await loadConvex(new URL("./", import.meta.url),
  ["reflection", "reflectionRead", "reflectionRules", "reflectionList", "reflectionDemo", "reflectionDemoStore", "reflectionDemoRules"], {
    transform: (name, src) => (name === "attendanceDays" ? src.replace("const RETRY_PAUSE_MS = 1000;", "const RETRY_PAUSE_MS = 1;") : src),
  });
const { mods } = loaded;
const R = mods.reflectionRules;
const DR = mods.reflectionDemoRules;

const TZ = "America/Los_Angeles";
const SCHOOL = "1817", YEAR = "36";
const WED = "2026-10-07", THU = "2026-10-08", FRI = "2026-10-09";
const FIVE = 5 * 60 * 1000;
Object.assign(process.env, {
  PS_HOST: "ps.test", PS_CLIENT_ID: "id", PS_CLIENT_SECRET: "secret", PS_SCHOOL_ID: SCHOOL, PS_YEAR_ID: YEAR, PS_TERM_ID: "3601",
  STAFF_DOMAIN: "school.test", ENTRA_TENANT_ID: "tenant-1",
});
const ISSUER = "https://login.microsoftonline.com/tenant-1/v2.0";
const la = (date, hhmm) => { const [h, m] = hhmm.split(":").map(Number); return R.laWallToUtc(date, h * 60 + m, TZ); };

// ---------------------------------------------------------------- the school
// Wednesday every slot meets; Thursday is a block day (Promise Time, P1, P3,
// P5, Power-Up, Promise Time PM), so it is a regular day, not six periods.
const WED_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], THU_SLOTS = [1, 2, 4, 6, 8, 9, 10];
const MS = { 1: "PT-A", 2: "P1-A", 3: "P2-A", 4: "P3-A", 5: "P4-A", 6: "P5-A", 7: "P6-A", 9: "PU-7", 10: "PM-A" };
const HS = { 1: "PT-H", 2: "P1-H", 3: "P2-H", 4: "P3-H", 5: "P4-H", 6: "P5-H", 7: "P6-H", 8: "PU-10", 10: "PM-H" };
const TEACHER = { 1: "Ms Adams", 2: "Ms Lee", 3: "Ms Ng", 4: "Ms Ortiz", 5: "Ms Park", 6: "Ms Diaz", 7: "Ms Kim", 8: "Ms Cruz", 9: "Ms Ruiz", 10: "Ms Adams" };
const COURSES = { 8: "Power Up 10A", 9: "Power Up 7A" };
const ms = (sn, over = {}) => ({ sn, grade: 7, sections: { ...MS, ...(over.sections || {}) }, teachers: TEACHER, courses: { ...COURSES, ...(over.courses || {}) } });
const hs = (sn, grade, over = {}) => ({ sn, grade, sections: { ...HS, ...(over.sections || {}) }, teachers: TEACHER, courses: COURSES });
const students = [
  ms("M1"), ms("M2"), ms("M3"), ms("M4"), ms("M5"), ms("M7"), ms("M8"), ms("M9"),
  ms("R1", { courses: { 9: "RSP A" } }),
  hs("H1", 10), hs("H2", 11, { sections: { 1: "PT-X" } }), hs("H3", 9),
  // Wednesday's own fillers (reflectionDay's `meet` fills Thursday): ten
  // absences in every slot, so every slot meets and the day is a school day.
  ...WED_SLOTS.flatMap((slot) => Array.from({ length: 10 }, (_, i) => ({ sn: `W${slot}-${i}`, sections: { [slot]: `WFILL-${slot}` } }))),
];
const SECTIONS = [...Object.values(MS), ...Object.values(HS)];   // PT-X never gets a mark
const SLOT_OF = Object.fromEntries([...Object.entries(MS), ...Object.entries(HS)].map(([slot, sec]) => [sec, Number(slot)]));
const marks = [
  // THURSDAY
  { sn: "M1", slot: 2, code: "T" },                                       // late to P1 after Promise Time: listed
  { sn: "M2", slot: 1, code: "A" }, { sn: "M2", slot: 2, code: "T" },     // arrived during P1: an arrival, never listed
  { sn: "M3", slot: 6, code: "T" },                                       // P5 today: tomorrow's list
  { sn: "M7", slot: 1, code: "A" }, { sn: "M7", slot: 2, code: "A" }, { sn: "M7", slot: 4, code: "A" },  // absent all morning
  { sn: "M8", slot: 2, code: "D" },                                       // Excused Tardy: never
  { sn: "M9", slot: 2, code: "T" }, { sn: "M9", slot: 4, code: "T" },     // two tardies today ...
  { sn: "R1", slot: 4, code: "T" },                                       // in RSP at Power-Up: pulled, flagged
  { sn: "H1", slot: 2, code: "T" },                                       // HS
  { sn: "H2", slot: 2, code: "T" },                                       // PT-X has no marks yet: held at the close
  { sn: "H3", slot: 4, code: "T" }, { sn: "H3", slot: 4, code: "T" },     // two marks for one period: admin review
  // WEDNESDAY
  { sn: "M4", slot: 6, code: "T", date: WED },                            // P5 yesterday: today's list, "after Power-Up"
  { sn: "M5", slot: 3, code: "T", date: WED },                            // P2 yesterday: yesterday's own list
  { sn: "M7", slot: 7, code: "T", date: WED },                            // P6 yesterday, absent this morning
  { sn: "M9", slot: 7, code: "T", date: WED },                            // ... and P6 yesterday: one row, three lines
  ...WED_SLOTS.flatMap((slot) => Array.from({ length: 10 }, (_, i) => ({ sn: `W${slot}-${i}`, slot, code: "A", date: WED }))),
  // Every section's classmate is absent on Wednesday too, so a student with
  // no row there was in class.
  ...SECTIONS.map((sec) => ({ sn: `C-${sec}`, slot: SLOT_OF[sec], code: "A", date: WED })),
];
// Classmates are made by sectionMarks before the marks are added, so the
// Wednesday rows above can name them.
const day = reflectionDay({ date: THU, schoolid: SCHOOL, yearid: YEAR, students, meet: THU_SLOTS, sectionMarks: SECTIONS, marks });
// PowerSchool's students table as the reader asks for it: enrolled, with a grade.
const gradeOfSn = Object.fromEntries(day.psRoster.map((r) => [r.studentNumber, r.gradeLevel]));
for (const s of day.tables.students) Object.assign(s, { enroll_status: 0, grade_level: gradeOfSn[s.student_number] ?? "7" });
day.tables.terms = [{ id: 3601, abbreviation: "S1", lastday: "2026-12-18", schoolid: SCHOOL, yearid: YEAR }];
const fake = fakePowerSchool(day.tables);
globalThis.fetch = fake.fetch;

const STAFF = {
  admin: { email: "admin@school.test", role: "admin", name: "Ada Admin" },
  pbis: { email: "pbis@school.test", role: "pbis", name: "Pat Pbis" },
  teacher: { email: "teacher@school.test", role: "teacher", name: "Tom Teacher" },
  aide: { email: "aide@school.test", role: "campusaide", name: "Ana Aide" },
  expired: { email: "expired@school.test", role: "campusaide", name: "Ed Expired", reflectionList: true, reflectionListUntil: "2026-10-07" },
  granted: { email: "granted@school.test", role: "campusaide", name: "Gus Granted", reflectionList: true, reflectionListUntil: "2026-12-18" },
};
// The app's own student records (names the BROWSER joins): never in a TEST row.
const NAMES = { M1: ["Anouk", "Quarles"], M4: ["Bartholomew", "Vasquezz"], M7: ["Cyprian", "Mossberg"], M9: ["Delphine", "Zanetti"],
  R1: ["Eliska", "Rojanova"], H1: ["Xiomara", "Lindqvist"] };
const NAME_RE = new RegExp(Object.values(NAMES).flat().join("|"));

async function school(settings, { snapshot = null } = {}) {
  const store = makeDb(schemaSrc);
  await store.db.insert("bellSettings", { key: "bell", timeZone: TZ, updatedAt: "2026-08-17T00:00:00Z" });
  await store.db.insert("appState", { key: "reflection:settings", value: settings, mirroredAt: "2026-10-01T00:00:00Z" });
  for (const r of day.psRoster) await store.db.insert("psRoster", { ...r });
  await store.db.insert("syncRuns", { at: day.psRoster[0].syncedAt, summary: { syncedAt: day.psRoster[0].syncedAt, rosterKept: false, rosterRows: 1 } });
  for (const t of Object.values(STAFF)) await store.db.insert("teachers", { ticketsAwarded: 0, ...t });
  for (const [sn, [firstName, lastName]] of Object.entries(NAMES)) await store.db.insert("students", { studentNumber: sn, firstName, lastName, grade: gradeOfSn[sn] });
  for (const r of snapshot ?? []) { const { _id, _creationTime, ...doc } = r; await store.db.insert("reflectionRoster", doc); }
  const rt = runtime(store, mods);
  const as = (who) => { rt.signIn({ issuer: ISSUER, email: STAFF[who].email }); return rt; };
  const tryRun = (who, path, args) => (who ? as(who) : rt).run(path, args).then((x) => x, (e) => ({ threw: String(e.message || e) }));
  return { store, rt, as, tryRun, log: [] };
}
async function runJobs(w, beforeMs) {
  for (;;) {
    const due = w.rt.jobs.filter((j) => j.at < beforeMs).sort((a, b) => a.at - b.at)[0];
    if (!due) return;
    w.rt.jobs.splice(w.rt.jobs.indexOf(due), 1);
    clock.set(Math.max(due.at, Date.parse(clock.iso)));
    w.log.push({ at: clock.iso, path: due.path, key: due.args?.key, out: await w.rt.run(due.path, due.args) });
  }
}
/** The cron: a tick every 5 minutes, running whatever it books. */
async function drive(w, fromIso, toIso) {
  for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += FIVE) {
    clock.set(t);
    w.rt.signIn(null);
    w.log.push({ at: clock.iso, path: "tick", out: await w.rt.run("reflection.tick", {}) });
    await runJobs(w, t + FIVE);
  }
}
/** A list as staff see it, minus the ids only a real detention has. */
const shape = (res) => (res.sections || []).map((s) => ({
  division: s.division, label: s.label, mode: s.mode, pullAt: s.pullAt, count: s.count, capacity: s.capacity,
  rows: s.rows.map(({ key, unitId, ...r }) => r),
}));
const numbers = (res) => (res.sections || []).flatMap((s) => s.rows.map((r) => r.studentNumber)).sort();
/** Every table but the TEST list's own, in a fixed order; a table never written to is the same as an empty one. */
const OTHER_TABLES = (snap) => Object.fromEntries(Object.entries(snap)
  .filter(([t, rows]) => t !== "reflectionDemoLists" && rows.length).sort((a, b) => a[0].localeCompare(b[0])));

try {
  // ==========================================================================
  console.log("\n1. THE TEST LIST IS THE LIST THE SHIPPED SYSTEM MAKES\n");
  // ==========================================================================
  // The reference: the SHIPPED reader, tick and freeze, both divisions in
  // shadow from Wednesday, run through Wednesday and Thursday morning.
  const real = await school({ modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: WED, hs: WED } });
  await drive(real, la(WED, "07:30"), la(WED, "15:45"));
  await drive(real, la(THU, "07:30"), la(THU, "11:45"));
  const realDay = real.store.rows("reflectionDays").find((d) => d.date === THU);
  clock.set(la(THU, "11:46"));
  const realList = await real.tryRun("admin", "reflectionList.listForDay", { day: THU });
  check("the reference: the shipped system made Thursday's list at its 11:45 closing read, from both days' marks",
    realDay?.frozenAt && realDay.freezeKind === "closing" && realList.view === "made"
      && J(numbers(realList)) === J(["H1", "M1", "M4", "M7", "M9", "R1"]), J({ frozen: realDay?.frozenAt, n: numbers(realList), view: realList.view }));

  // The TEST list, in a Hub like production on 10/8: the pilot counting from
  // Friday, today's roster snapshot, no real list for Thursday.
  const demo = await school({ modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: FRI, hs: FRI } },
    { snapshot: real.store.rows("reflectionRoster") });
  const before = demo.store.snapshot();
  clock.set(la(THU, "11:46"));
  const built = await demo.tryRun(null, "reflectionDemo.build", { day: THU });
  const builtAt = clock.iso;
  check("reflectionDemo:build reads Thursday and Wednesday from PowerSchool and stores a TEST list, answering in counts only",
    built.ok === true && built.previousDay === WED && built.rosterFrom === "snapshot" && built.counts.total === 6
      && !/"(M\d|R1|H\d)"/.test(J(built)) && !NAME_RE.test(J(built)), J(built));
  const shown = await demo.tryRun("admin", "reflectionList.listForDay", { day: "today", demoOk: true });
  check("demo rows identical to the real list the shipped rules make for the same day: every row, line, tag, Power-Up and section",
    shown.demo === true && J(shape(shown)) === J(shape(realList)), J({ demo: shape(shown), real: shape(realList) }));
  const row = (res, sn) => res.sections.flatMap((s) => s.rows).find((r) => r.studentNumber === sn);
  check("...not trivially: P5 from yesterday tagged after Power-Up, three violations on one row, absent this morning, RSP flagged, HS in its own section",
    J(row(shown, "M4")?.tags) === J(["From Wed 10/7 P5 (after Power-Up)"])
      && J(row(shown, "M9")?.lines) === J(["Wed 10/7: Tardy P6 (Ms Kim)", "Thu 10/8: Tardy P1 (Ms Lee)", "Thu 10/8: Tardy P3 (Ms Ortiz)"])
      && row(shown, "M7")?.absentMorning === true && row(shown, "R1")?.pu?.flag === "RSP" && row(shown, "R1")?.pu?.teacher === "Ms Ruiz"
      && J(shown.sections.map((s) => [s.division, s.count, s.pullAt])) === J([["ms", 5, "12:31"], ["hs", 1, "12:57"]]),
    J(shown.sections.map((s) => s.rows)));
  check("...and never the arrival, today's P5, yesterday's P2 (yesterday's own list), the Excused Tardy, the held tardy or the two-mark period",
    !["M2", "M3", "M5", "M8", "H2", "H3"].some((sn) => numbers(shown).includes(sn)), J(numbers(shown)));
  const doc = demo.store.rows("reflectionDemoLists");
  check("the stored TEST list: one row for the day, when it was built, the previous day, the schedule type, and its counts",
    doc.length === 1 && doc[0].day === THU && doc[0].builtAt === builtAt && doc[0].previousDay === WED && doc[0].kind === "regular"
      && doc[0].counts.ms === 5 && doc[0].counts.hs === 1 && doc[0].counts.held === 1 && doc[0].counts.arrivals === 1
      && doc[0].counts.collisions === 1 && doc[0].counts.dayTardies === 5 && doc[0].counts.previousDayTardies === 3, J(doc[0]?.counts));
  check("...its rows carry student numbers and grades, never a name, and nothing but the made list's own fields",
    doc[0].rows.every((r) => J(Object.keys(r).sort()) === J(DR.DEMO_ROW_KEYS.slice().sort()))
      && !NAME_RE.test(J(doc[0])) && !NAME_RE.test(J(shown)), J(doc[0].rows[0]));
  check("the answer says it is a TEST list and when it was built, with nothing of the real list's machinery",
    shown.view === "demo" && shown.demoBuiltAt === builtAt && shown.frozen === false && J(shown.banners) === "[]"
      && shown.room === null && shown.controls === null && shown.printsToday === null && shown.myPrintChanges === null
      && shown.isToday === true && J(shown.mode) === J({ ms: "shadow", hs: "shadow" }), J({ ...shown, sections: undefined }));
  check("building it touched no table but its own: no tardy, detention, day, print, audit line, setting, lease or uniform entry",
    J(OTHER_TABLES(demo.store.snapshot())) === J(OTHER_TABLES(before)),
    Object.keys(demo.store.snapshot()).filter((t) => J(demo.store.snapshot()[t]) !== J(before[t] ?? [])).join(", "));

  // A second build replaces the first; with no roster snapshot yet, psRoster
  // gives the same Power-Up classes.
  clock.set(la(THU, "11:50"));
  const again = await demo.tryRun(null, "reflectionDemo.build", { day: THU, builtByEmail: "admin@school.test" });
  check("building again replaces the TEST list for that day, never adds a second, and keeps who built it when the command line says",
    again.ok && demo.store.rows("reflectionDemoLists").length === 1 && demo.store.rows("reflectionDemoLists")[0].builtAt === clock.iso
      && demo.store.rows("reflectionDemoLists")[0].builtByEmail === "admin@school.test" && !("builtByEmail" in doc[0]), J(again));
  const bare = await school({ modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: FRI, hs: FRI } });
  const bareBuilt = await bare.tryRun(null, "reflectionDemo.build", { day: THU });
  const bareShown = await bare.tryRun("admin", "reflectionList.listForDay", { day: THU, demoOk: true });
  check("no roster snapshot yet: the Power-Up classes come from psRoster, made the way the snapshot is made, and nothing is written but the TEST list",
    bareBuilt.ok && bareBuilt.rosterFrom === "psRoster" && J(shape(bareShown)) === J(shape(realList))
      && bare.store.rows("reflectionRoster").length === 0 && bare.store.rows("appState").length === 1, J(bareBuilt));

  // ==========================================================================
  console.log("\n2. A REAL LIST ALWAYS WINS, AND NONE IS BUILT FOR A DAY IT COUNTS\n");
  // ==========================================================================
  {
    const refusedReal = await real.tryRun(null, "reflectionDemo.build", { day: THU });
    check("build refuses a day whose real list is made, and writes nothing",
      refusedReal.ok === false && /real list for Thu 10\/8 was made at 11:45/.test(refusedReal.reason) && real.store.rows("reflectionDemoLists").length === 0,
      J(refusedReal));
    const future = await demo.tryRun(null, "reflectionDemo.build", { day: FRI });
    check("...and a day after today", future.ok === false && /after today/.test(future.reason), J(future));
    const s = demo.store.rows("appState").find((r) => r.key === "reflection:settings");
    await demo.store.db.patch(s._id, { value: { modeByDivision: { ms: "off", hs: "shadow" }, countFromDateByDivision: { ms: null, hs: THU } } });
    const counted = await demo.tryRun(null, "reflectionDemo.build", { day: THU });
    await demo.store.db.patch(s._id, { value: s.value });
    check("...and a day the real list counts (HS in shadow from that day): it would hide the real list's NOT FINAL view",
      counted.ok === false && /The real list counts Thu 10\/8 \(HS is in shadow from 2026-10-08\)/.test(counted.reason)
        && demo.store.rows("reflectionDemoLists")[0].builtAt === la(THU, "11:50"), J(counted));

    // The switch moved AFTER the TEST list was built: setMode allows counting
    // from today, so on Thursday HS can be set to count from Thursday itself,
    // with Thursday's TEST list still stored.
    const beforeMove = demo.store.snapshot();
    await demo.store.db.patch(s._id, { value: { modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: FRI, hs: THU } } });
    const moved = await demo.tryRun("admin", "reflectionList.listForDay", { day: THU, demoOk: true });
    const movedPrint = await demo.tryRun("admin", "reflectionList.recordPrint", { day: THU, kind: "master", unitIds: [], studentNumbers: [], listVersion: "x" });
    const storedTest = demo.store.rows("reflectionDemoLists").length;
    demo.store.restore(beforeMove);
    check("a TEST list built before the switch was moved to count its day never hides the real list: the real NOT FINAL list is shown, and its print is recorded",
      storedTest === 1 && moved.demo === false && moved.view === "so-far" && movedPrint.ok === true && movedPrint.final === false,
      J({ storedTest, view: moved.view, demo: moved.demo, movedPrint }));

    // Thursday's real list is made after all (a fallback freeze, say).
    const snap = demo.store.snapshot();
    await demo.store.db.insert("reflectionDays", { date: THU, readsDone: ["closing"], frozenAt: la(THU, "11:45"), freezeKind: "closing",
      kind: "regular", schoolDay: true, modeByDivision: { ms: "shadow", hs: "shadow" }, updatedAt: la(THU, "11:45") });
    await demo.store.db.insert("reflectionUnits", { studentNumber: "M1", division: "ms", kind: "new", tardyIds: [], uniformIds: [],
      lines: ["Thu 10/8: Tardy P1 (Ms Lee)"], recordedAt: la(THU, "11:45"), state: "listed", serveDay: THU, mode: "shadow", carryCount: 0, tags: [] });
    const wins = await demo.tryRun("admin", "reflectionList.listForDay", { day: THU, demoOk: true });
    check("a real frozen list for the same day hides the demo: the real list is shown, and nothing of the TEST list",
      wins.demo === false && wins.view === "made" && J(numbers(wins)) === J(["M1"]) && !("demoBuiltAt" in wins && wins.demoBuiltAt), J({ view: wins.view, n: numbers(wins) }));
    const printReal = await demo.tryRun("admin", "reflectionList.recordPrint", { day: THU, kind: "master", unitIds: [], studentNumbers: ["M1"], listVersion: "x" });
    check("...and its prints are recorded as ever", printReal.ok === true && printReal.final === true, J(printReal));
    demo.store.restore(snap);
  }

  // ==========================================================================
  console.log("\n3. NEVER A RECORD\n");
  // ==========================================================================
  {
    const kinds = [];
    for (const kind of ["master", "slips", "changes"]) {
      const r = await demo.tryRun("admin", "reflectionList.recordPrint", { day: THU, kind, unitIds: [], studentNumbers: ["M1"], listVersion: shown.listVersion });
      kinds.push(r.ok === false && r.reason === mods.reflectionList.DEMO_PRINT_REFUSED ? "refused" : J(r));
    }
    check("recordPrint refused on demo: a master, slips or changes print of a TEST list is never recorded, and says why",
      kinds.every((k) => k === "refused") && demo.store.rows("reflectionPrints").length === 0 && /TEST list, not a real one/.test(mods.reflectionList.DEMO_PRINT_REFUSED), J(kinds));
    const other = await demo.tryRun("admin", "reflectionList.recordPrint", { day: WED, kind: "master", unitIds: [], studentNumbers: [], listVersion: "x" });
    check("...only that day: a print of another day is recorded as ever", other.ok === true && demo.store.rows("reflectionPrints").length === 1, J(other));
  }

  // ==========================================================================
  console.log("\n4. THE SAME CHECK OF WHO IS ASKING, FIRST\n");
  // ==========================================================================
  {
    const out = {};
    for (const who of ["teacher", "aide", "expired"]) {
      const r = await demo.tryRun(who, "reflectionList.listForDay", { day: THU, demoOk: true });
      const p = await demo.tryRun(who, "reflectionList.recordPrint", { day: THU, kind: "master", unitIds: [], studentNumbers: [], listVersion: "x" });
      out[who] = r.allowed === false && !/M1|M9|demo/i.test(J(r)) && p.ok === false && /limited to administrators/.test(p.reason) ? "refused" : J([r, p]);
    }
    check("access refused for a teacher and a campus aide without the grant, and for an expired grant: no TEST list, no TEST row",
      Object.values(out).every((x) => x === "refused"), J(out));
    const g = await demo.tryRun("granted", "reflectionList.listForDay", { day: THU, demoOk: true });
    const p = await demo.tryRun("pbis", "reflectionList.listForDay", { day: "today", demoOk: true });
    check("...while PBIS, and a staff member an admin gave the list to, see it as they would see the real one",
      g.demo === true && g.roles === false && J(numbers(g)) === J(numbers(shown)) && p.demo === true && p.roles === true, J({ g: g.view, p: p.view }));
  }

  // ==========================================================================
  console.log("\n5. CLEARED, AND THE SCREEN IS THE REAL ONE AGAIN\n");
  // ==========================================================================
  {
    const beforeClear = demo.store.snapshot();
    const cleared = await demo.tryRun(null, "reflectionDemo.clear", { day: THU });
    const after = await demo.tryRun("admin", "reflectionList.listForDay", { day: THU, demoOk: true });
    check("reflectionDemo:clear takes the TEST list away, and the day shows what the real list says (no list was made)",
      cleared.ok && cleared.removed === 1 && demo.store.rows("reflectionDemoLists").length === 0 && after.demo === false
        && after.view !== "demo" && numbers(after).length === 0, J({ cleared, view: after.view }));
    check("...touching no other table", J(OTHER_TABLES(demo.store.snapshot())) === J(OTHER_TABLES(beforeClear)));
    const none = await demo.tryRun(null, "reflectionDemo.clear", { day: THU });
    const bad = await demo.tryRun(null, "reflectionDemo.clear", { day: "10/8" });
    check("...clearing twice removes nothing; a malformed day is refused", none.ok && none.removed === 0 && bad.ok === false, J([none, bad]));
  }

  // ==========================================================================
  console.log("\n6. ONLY A STEADY READ BUILDS ANYTHING\n");
  // ==========================================================================
  {
    // A teacher saving attendance during every page of Thursday: a delete and
    // an insert, so PowerSchool's counts before and after agree.
    const busy = fakePowerSchool(day.tables, {
      swapDuringRead: { afterPage: 1, times: "always", match: (q) => q === `schoolid==${SCHOOL};yearid==${YEAR};att_date==${THU}`,
        row: { ...day.tables.attendance.find((r) => r.att_date === THU) } },
    });
    globalThis.fetch = busy.fetch;
    const w = await school({ modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: FRI, hs: FRI } });
    const r = await w.tryRun(null, "reflectionDemo.build", { day: THU });
    globalThis.fetch = fake.fetch;
    check("a day that does not hold still is not built: the shipped confirmed read refuses it, and nothing is stored",
      r.ok === false && /was not read steadily/.test(r.reason) && w.store.rows("reflectionDemoLists").length === 0, J(r));
  }

  // ==========================================================================
  console.log("\n7. THE PREVIOUS SCHOOL DAY\n");
  // ==========================================================================
  check("the previous school day: Monday's is Friday, a no-school Friday is skipped, Thursday's is Wednesday",
    DR.previousWeekday("2026-10-12", []) === "2026-10-09" && DR.previousWeekday("2026-10-12", ["2026-10-09"]) === "2026-10-08"
      && DR.previousWeekday(THU, new Set()) === WED);

  // ==========================================================================
  console.log("\n8. NOTHING ELSE READS IT\n");
  // ==========================================================================
  {
    const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // A folder that is not there (the teeth script's copy has no hub/) has nothing in it.
    const list0 = (dir) => { try { return readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }); } catch { return []; } };
    const walk = (dir) => list0(dir).flatMap((e) => {
      if (e.name === "node_modules" || e.name === "_generated" || e.name.startsWith(".")) return [];
      const p = `${dir}${e.name}`;
      return e.isDirectory() ? walk(`${p}/`) : /\.(ts|tsx|js|mjs|html)$/.test(e.name) && !/\.test\.|^fake-/.test(e.name) ? [p] : [];
    });
    const files = [...walk("./convex/"), ...walk("./scripts/"), ...readdirSync(new URL("./", import.meta.url)).filter((f) => /\.(js|html)$/.test(f)).map((f) => `./${f}`),
      ...walk("./hub/")].filter((f) => !f.includes("scripts/reflection-teeth.mjs"));
    const refs = files.filter((f) => /reflectionDemoLists/.test(strip(read(f)))).map((f) => f.replace(/^\.\//, "")).sort();
    check("no other module references reflectionDemoLists: only the schema, the file that writes it, and the list's reader",
      J(refs) === J(["convex/reflectionDemoStore.ts", "convex/reflectionList.ts", "convex/schema.ts"]), J(refs));
    const list = strip(read("./convex/reflectionList.ts"));
    const fnOf = (at) => [...list.slice(0, at).matchAll(/export const (\w+) = |async function (\w+)\(|^function (\w+)\(/gm)].pop()?.slice(1).find(Boolean);
    const calls = [...list.matchAll(/(?<!function )demoListOf\(ctx/g)].map((m) => fnOf(m.index));
    check("...and in reflectionList.ts it is read in one place, called only by listForDay and recordPrint (never the review queue, verify export or audit trail)",
      (list.match(/ctx\.db\.query\("reflectionDemoLists"\)/g) || []).length === 1 && J(calls) === J(["listForDay", "recordPrint"]), J(calls));
    const store = strip(read("./convex/reflectionDemoStore.ts"));
    const writes = [...store.matchAll(/ctx\.db\.(insert|patch|replace|delete)\(\s*("?\w+"?)/g)].map((m) => `${m[1]} ${m[2]}`);
    check("the TEST list's writes: insert into reflectionDemoLists, and delete what was read from it -- never a patch or another table",
      J(writes) === J(['delete d', 'insert "reflectionDemoLists"', 'delete d']) && !/\.(patch|replace)\(/.test(store)
        && !/ctx\.db\./.test(strip(read("./convex/reflectionDemo.ts"))), J(writes));
    const demoSrc = strip(read("./convex/reflectionDemo.ts")) + strip(read("./convex/reflectionDemoStore.ts"));
    check("build and clear are command line only: nothing in either file is reachable from a browser",
      !/export const \w+ = (query|mutation|action)\(/.test(demoSrc) && /export const build = internalAction\(/.test(demoSrc)
        && /export const clear = internalAction\(/.test(demoSrc));
    check("listForDay asks who is asking before it reads the TEST list",
      (() => { const body = list.slice(list.indexOf("export const listForDay =")); return body.indexOf("canReadReflection(staff, today)") < body.indexOf("demoListOf(ctx"); })());
    const pkg = JSON.parse(read("./package.json"));
    check("this test runs in npm test", /&& node reflection-demo\.test\.mjs\b/.test(pkg.scripts.test));
  }

  // ==========================================================================
  console.log("\n9. AN OPEN TAB FROM BEFORE THIS BUILD\n");
  // ==========================================================================
  // An open tab updates itself only at a free moment, after the site's cache,
  // and is held for up to a day by unsent work; on a Convex deploy before the
  // site push, every open tab is one. Its screen knows nothing of `demo`.
  // Each screen below is the SHIPPED screen code, run (fake-reflection-screen)
  // against the SHIPPED server with exactly the arguments it sends, signed in
  // as an administrator. `bare` holds Thursday's TEST list.
  {
    const BROWSER = Object.entries(NAMES).map(([studentNumber, [firstName, lastName]]) => ({ studentNumber, firstName, lastName }));
    const server = (send = (a) => a) => ({
      query: (args, path) => bare.as("admin").run(path.replace(":", "."), send(args)),
      mutation: (args, path) => bare.as("admin").run(path.replace(":", "."), args),
    });
    const screenText = (w) => w.fixed.rrDayNote.textContent + w.fixed.rrBanners.innerHTML + w.fixed.rrList.innerHTML;

    const oldAsk = await bare.tryRun("admin", "reflectionList.listForDay", { day: "today" });
    const oldNo = await bare.tryRun("admin", "reflectionList.listForDay", { day: THU, demoOk: false });
    const told = { allowed: true, ok: false, reason: mods.reflectionList.DEMO_NEEDS_UPDATE };
    check("a screen that does not say it marks a TEST list as TEST (every screen from before this build) is sent no TEST row: words only, asking nobody to refresh",
      J(oldAsk) === J(told) && J(oldNo) === J(told) && /TEST/.test(told.reason) && !/refresh|reload/i.test(told.reason),
      J([oldAsk, oldNo].map((r) => ({ ok: r.ok, view: r.view, reason: r.reason, rows: (r.sections || []).reduce((n, x) => n + x.rows.length, 0) }))));

    const now = makeWorld(read("./script.js"), server(), BROWSER);
    await now.app.loadReflectionList();
    check("this build's screen asks with demoOk and, through the shipped server, draws the TEST list under its red TEST ONLY banner",
      now.calls[0]?.args?.demoOk === true && now.app.data?.demo === true && /data-rr-banner="demo"/.test(now.fixed.rrBanners.innerHTML)
        && NAME_RE.test(now.fixed.rrList.innerHTML) && /rr-test-chip/.test(now.fixed.rrList.innerHTML) && !/rr-pilot/.test(now.fixed.rrList.innerHTML),
      J({ args: now.calls[0]?.args, why: now.app.why }));

    // The screen that is on production today (61309f3), from git. Skipped
    // where git or that commit is not available (the teeth script's copy has
    // no history), because a check that cannot run must not fail a build.
    let oldSrc = null;
    try {
      oldSrc = execFileSync("git", ["show", "61309f3:script.js"],
        { cwd: fileURLToPath(new URL("./", import.meta.url)), stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 << 20 }).toString();
    } catch { /* no git here */ }
    if (oldSrc) {
      const old = makeWorld(oldSrc, server(), BROWSER);
      await old.app.loadReflectionList();
      const onScreen = screenText(old);
      check("the 61309f3 screen, against this server on a day with only a TEST list: no row, no name, no PILOT chip -- the server's words about the TEST list instead",
        !("demoOk" in (old.calls[0]?.args ?? {})) && old.app.data === null && !NAME_RE.test(onScreen) && !/rr-pilot/.test(onScreen)
          && onScreen.includes(mods.reflectionList.DEMO_NEEDS_UPDATE), onScreen.slice(0, 300));
      await old.app.printReflectionList();
      old.fire("beforeprint");
      old.fire("afterprint");
      check("...and nothing to print: its Print button prints nothing, the browser's own print menu draws no list, and no print is recorded",
        old.prints.length === 0 && !old.sheet() && !old.calls.some((c) => c.kind === "mutation") && bare.store.rows("reflectionPrints").length === 0,
        J({ prints: old.prints.length, calls: old.calls.map((c) => c.path) }));

      // THE CONTROL: the same old screen handed the TEST rows, as it was
      // before demoOk. It shows what the gate keeps from it.
      const leak = makeWorld(oldSrc, server((a) => ({ ...a, demoOk: true })), BROWSER);
      await leak.app.loadReflectionList();
      leak.fire("beforeprint");
      const leakSheet = leak.sheet()?.innerHTML || "";
      check("...the control: handed the TEST rows, the 61309f3 screen draws names under PILOT chips with no TEST anywhere, on screen or on its menu print",
        NAME_RE.test(screenText(leak)) && /rr-pilot/.test(screenText(leak)) && !/TEST/.test(screenText(leak))
          && NAME_RE.test(leakSheet) && !/TEST/.test(leakSheet), screenText(leak).slice(0, 300));
      leak.fire("afterprint");
    } else {
      console.log("  SKIP  the 61309f3 screen against this server (git or that commit not available here)");
    }
  }
} finally {
  clock.real();
  console.log = realLog;
  loaded.cleanup();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
