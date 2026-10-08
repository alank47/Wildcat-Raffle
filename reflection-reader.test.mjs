// The Reflection Room reader: tick, lease, confirmed reads, the freeze,
// corrections, holds and carries, run as they will run. Run: npm test
//
// IT RUNS THE SHIPPED CODE. reflection.ts (tick, applyRead, setMode),
// reflectionRead.ts (the reader action, with the rebuild's own psGet,
// countRows and readWindow) and reflectionRules.ts are transpiled as they are
// and driven through whole school days -- a tick every 5 minutes on the Los
// Angeles clock, the reads it books, the writes they hand back -- against an
// in-memory Convex (fake-convex.mjs, with the real schema's indexes) and a fake
// PowerSchool that applies every filter (fake-powerschool.mjs). The only knob
// changed is the one-second pause between PowerSchool retries.
//
// The worlds:
//   1. Tuesday 10/13 and Wednesday 10/14, MS in shadow: arrivals, holds, a
//      Monday P5 tardy, P6 never the same day, corrections after the list
//      (excused, re-entered, moved, deleted), a late entry, carries made,
//      cancelled and made late, then MS going live.
//   2. A teacher saving mid-read at the close: the read is not taken.
//   3. A read killed by a deploy, and a straggler at the ready time: leases.
//   4. PowerSchool down all morning: no list, everything on the next one.
//   5. A tardy first seen after five lists: admin review.
//   6. The first day back from Thanksgiving, in standard time.
//   7. HS switched on for Thursday: Wednesday's HS tardy never floods a list.
//   8. The command-line settings, and the owner's 10/8 pull times.
//   9. The list as staff see it and print it (reflectionList.ts): who may read
//      it, today and tomorrow "so far", MS and HS sections, one row per
//      student with every violation dated, prints recorded with ids and
//      numbers only, and each viewer's changes since their OWN print.
//  10. "No list today" and a red last-read banner, on screen.
//  11-14. The room's own attendance, Room did not run, the review queue's
//      decisions and the admin buttons, and "This is a school day".
//  15. The pilot going live over a weekend: a pilot carry decided after the
//      switch, a Friday arrival re-judged on Monday and a queued Friday
//      uniform entry all stay off the first live list (review, 2026-10-08).
//  16. One tardy, one list: a mark typed back after the room ran rejoins its
//      detention; one deleted before the pull is still owed; a second mark
//      for a listed tardy never sends it to a second list; one typed back as
//      an arrival, then counted again, stays on the detention that stood.
//  17. A Power-Up absence taken back just before the close: the closing read
//      decides yesterday's carry before it makes today's list.
//  18. The last-read banner, judged against the reader's own schedule.
//  19. MS live with HS in shadow: the room's Attendance done, Room did not
//      run and Not here decide the live division's carries only.
//  20. Tardies that count only after their own list was made are tagged
//      "Entered late in PowerSchool" on the next one.
//
// TEETH: scripts/reflection-teeth.mjs breaks the direct id confirmation, the
// natural key, the lease expiry, the "unconfirmed changes nothing" rule,
// countFromDate, the fallback's fence and the school-day lookback -- and, for
// the list screen, the access check, per-print changes, the slips refusal,
// "tomorrow so far", the role-only banners and the appAuditLog rule, and each
// guard the 2026-10-08 review added (worlds 15-18) -- one at a time, and
// requires the check named for each to FAIL.
import { readdirSync, readFileSync } from "node:fs";
import { clock, loadConvex, makeDb, runtime } from "./fake-convex.mjs";
import { fakePowerSchool, REFLECTION_CODES } from "./fake-powerschool.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const schemaSrc = read("./convex/schema.ts");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const J = (x) => JSON.stringify(x);

// The reader logs a line of counts per read; keep the test's own output readable.
const realLog = console.log;
console.log = (...a) => { if (!(typeof a[0] === "string" && a[0].startsWith("[reflection]"))) realLog(...a); };

const loaded = await loadConvex(new URL("./", import.meta.url), ["reflection", "reflectionRead", "reflectionRules", "reflectionList", "reflectionRoom", "uniformViolations"], {
  transform: (name, src) => (name === "attendanceDays" ? src.replace("const RETRY_PAUSE_MS = 1000;", "const RETRY_PAUSE_MS = 1;") : src),
});
const { mods } = loaded;
const R = mods.reflectionRules;

const TZ = "America/Los_Angeles";
const SCHOOL = "1817", YEAR = "36";
const CODE = { A: 1, T: 2, D: 3, K: 4, P: 5, S: 6, X: 7 };
const FIVE = 5 * 60 * 1000;
Object.assign(process.env, {
  PS_HOST: "ps.test", PS_CLIENT_ID: "id", PS_CLIENT_SECRET: "secret", PS_SCHOOL_ID: SCHOOL, PS_YEAR_ID: YEAR, PS_TERM_ID: "3601",
  // Who a signed-in caller is, for the list screen's public query and mutation.
  STAFF_DOMAIN: "school.test", ENTRA_TENANT_ID: "tenant-1",
});
const STAFF_ISSUER = "https://login.microsoftonline.com/tenant-1/v2.0";
const la = (date, hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return R.laWallToUtc(date, h * 60 + m, TZ);
};

const MS = { 1: "PT-A", 2: "P1-A", 3: "P2-A", 4: "P3-A", 5: "P4-A", 6: "P5-A", 7: "P6-A", 9: "PU-7", 10: "PM-A" };
const HS = { 1: "PT-H", 2: "P1-H", 3: "P2-H", 4: "P3-H", 5: "P4-H", 6: "P5-H", 7: "P6-H", 8: "PU-10", 10: "PM-H" };
const TEACHER = { 1: "Adams", 2: "Lee", 3: "Ng", 4: "Ortiz", 5: "Park", 6: "Diaz", 7: "Kim", 8: "Cruz", 9: "Ruiz", 10: "Adams" };
const MON_SLOTS = [1, 2, 4, 6, 8, 9, 10], TUE_SLOTS = [1, 3, 5, 7, 8, 9, 10], WED_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * A school: PowerSchool's tables, the psRoster the sync wrote, and the
 * Convex store. `students`: { sn: { grade, sections } }. Twenty filler
 * students and two classmates (CM in every MS section, CH in every HS one)
 * are added: on a day that meets, the fillers make every meeting slot hold
 * 20 rows (school-day evidence), and the classmates' absences give every
 * shared section "marks", so a student with no row there reads as present.
 */
async function world({ students, settings, days = [], marks = [] }) {
  const store = makeDb(schemaSrc);
  await store.db.insert("bellSettings", { key: "bell", timeZone: TZ, updatedAt: "2026-08-17T00:00:00Z" });
  for (const m of marks) await store.db.insert("bellScheduleDays", { date: m.date, noSchool: !!m.noSchool, setAt: "2026-08-17T00:00:00Z" });
  const rt = runtime(store, mods);
  const all = {
    ...students,
    CM: { grade: 7, sections: MS },
    CH: { grade: 10, sections: HS },
    ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`F${String(i).padStart(2, "0")}`,
      { grade: 7, sections: Object.fromEntries(Object.keys(MS).map((s) => [s, `FILL-${s}`])), filler: true }])),
  };
  const ps = {
    attendance: [],
    attendance_code: REFLECTION_CODES.map((c) => ({ ...c, schoolid: SCHOOL, yearid: YEAR })),
    students: [],
    terms: [{ id: 3601, abbreviation: "S1", lastday: "2026-12-18", schoolid: SCHOOL, yearid: YEAR }],
  };
  const psId = {};
  let nextPs = 70000, rid = 100000;
  const syncedAt = "2026-10-01T13:00:05.000Z";
  for (const [sn, s] of Object.entries(all)) {
    psId[sn] = ++nextPs;
    ps.students.push({ id: psId[sn], student_number: sn, grade_level: String(s.grade), schoolid: SCHOOL, enroll_status: 0 });
    for (const [slot, sectionId] of Object.entries(s.sections)) {
      await store.db.insert("psRoster", {
        studentNumber: sn, firstName: "F", lastName: "L", gradeLevel: String(s.grade), sectionId, period: `${slot}(A-E)`,
        courseName: Number(slot) >= 8 && Number(slot) <= 9 ? "Power Up" : "Class",
        teacherFirstName: "Ms", teacherLastName: TEACHER[slot], syncedAt,
      });
    }
  }
  await store.db.insert("syncRuns", { at: syncedAt, summary: { syncedAt, rosterKept: false, rosterRows: 1 } });
  const row = (date, sn, slot, code) => ({
    id: ++rid, schoolid: SCHOOL, yearid: YEAR, studentid: psId[sn], att_date: date, periodid: 850 + Number(slot),
    attendance_codeid: CODE[code], ccid: 0,
  });
  const ctl = { down: false, directFail: false, swap: null };
  const meetRows = (date, slots) => {
    const out = [];
    for (const [sn, s] of Object.entries(all)) {
      if (!s.filler && sn !== "CM" && sn !== "CH") continue;
      for (const slot of slots) if (String(slot) in s.sections) out.push(row(date, sn, slot, "A"));
    }
    return out;
  };
  for (const d of days) ps.attendance.push(...meetRows(d.date, d.slots));
  // The row a teacher's save inserts while the swap is on: set to the swapped
  // day (ctl.swap) so PowerSchool's counts before and after stay EQUAL -- the
  // case a count check alone cannot catch.
  const swapRow = { schoolid: SCHOOL, yearid: YEAR, studentid: psId.F00, att_date: "2099-01-01", periodid: 852, attendance_codeid: CODE.A, ccid: 0 };
  const fake = fakePowerSchool(ps, {
    swapDuringRead: {
      row: swapRow,
      afterPage: 1, times: "always",
      match: (q) => !!ctl.swap && q === `schoolid==${SCHOOL};yearid==${YEAR};att_date==${ctl.swap}`,
    },
  });
  const w = {
    store, rt, fake, ctl, psId, swapRow,
    /** A mark in PowerSchool, now. Returns its row id. */
    mark(date, sn, slot, code) { const r = row(date, sn, slot, code); fake.tables.attendance.push(r); return r.id; },
    meet(date, slots) { fake.tables.attendance.push(...meetRows(date, slots)); },
    unmark(id) {
      const i = fake.tables.attendance.findIndex((r) => r.id === id);
      if (i < 0) throw new Error("no row " + id);
      fake.tables.attendance.splice(i, 1);
    },
    find(date, sn, slot) { return fake.tables.attendance.find((r) => r.att_date === date && r.studentid === psId[sn] && r.periodid === 850 + slot)?.id; },
    tardies: (sn) => store.rows("reflectionTardies").filter((t) => !sn || t.studentNumber === sn),
    units: (sn) => store.rows("reflectionUnits").filter((u) => !sn || u.studentNumber === sn),
    day: (date) => store.rows("reflectionDays").find((d) => d.date === date),
    listed: (date) => store.rows("reflectionUnits").filter((u) => u.serveDay === date && u.state !== "expired").map((u) => u.studentNumber).sort(),
    log: [],
    t: null,
  };
  globalThis.fetch = async (url, init) => {
    const resp = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
    if (w.ctl.down) return resp(503, { message: "down" });
    if (w.ctl.directFail && /[?&]q=id%3D%3D/.test(String(url))) return resp(500, { message: "id read failed" });
    return fake.fetch(url, init);
  };
  if (settings) await store.db.insert("appState", { key: "reflection:settings", value: settings, mirroredAt: "2026-10-01T00:00:00Z" });
  return w;
}

/** Run the booked jobs due before `beforeMs`, earliest first, each at its own time. */
async function runJobs(w, beforeMs) {
  for (;;) {
    const due = w.rt.jobs.filter((j) => j.at < beforeMs).sort((a, b) => a.at - b.at)[0];
    if (!due) return;
    w.rt.jobs.splice(w.rt.jobs.indexOf(due), 1);
    clock.set(Math.max(due.at, Date.parse(clock.iso)));
    const out = await w.rt.run(due.path, due.args);
    w.log.push({ at: clock.iso, path: due.path, key: due.args?.key, out });
  }
}
/**
 * Tick every 5 minutes from `fromIso` through `toIso`, as the cron does,
 * running whatever each tick books. hooks: [[iso, fn]] run just before the
 * first tick at or after their time.
 */
async function drive(w, fromIso, toIso, hooks = []) {
  const pending = hooks.map(([at, fn]) => ({ at: Date.parse(at), fn }));
  for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += FIVE) {
    for (const h of pending.filter((h) => !h.done && h.at <= t)) { clock.set(h.at); await h.fn(); h.done = true; }
    clock.set(t);
    const out = await w.rt.run("reflection.tick", {});
    w.log.push({ at: clock.iso, path: "tick", out });
    await runJobs(w, t + FIVE);
  }
}
const readsOf = (w, key) => w.log.filter((l) => l.path === "reflectionRead.read" && (!key || l.key === key));

try {
  // ==========================================================================
  console.log("\n1. TUESDAY 10/13 AND WEDNESDAY 10/14 (MS in shadow)\n");
  // ==========================================================================
  {
    const TUE = "2026-10-13", MON = "2026-10-12", WED = "2026-10-14";
    const ms = (extra = {}) => ({ grade: 7, sections: { ...MS, ...extra } });
    const w = await world({
      students: {
        A: ms(), B: ms(), C: ms(), R: ms(), M: ms(), K: ms(), Z: ms(), L: ms(), S6: ms(), D1: ms(), W: ms(), Y: ms(),
        N: ms(), S7: ms(), Q: ms(),
        H: ms({ 1: "PT-B" }), CB: { grade: 7, sections: { 1: "PT-B" } }, H2: ms({ 1: "PT-C" }),
        X: { grade: 10, sections: HS },
      },
      days: [{ date: MON, slots: MON_SLOTS }, { date: TUE, slots: TUE_SLOTS }, { date: WED, slots: WED_SLOTS }],
    });
    // Monday: the reader was not running, but MS counts from Monday.
    w.mark(MON, "W", 6, "T");                    // P5 Monday: on Tuesday's list
    const yMon = w.mark(MON, "Y", 2, "T");       // P1 Monday: deleted just before Tuesday's close
    // Tuesday, as PowerSchool holds it at 07:30.
    for (const sn of ["A", "C", "R", "M", "K", "Z", "Q"]) w.mark(TUE, sn, 3, "T");   // late to P2, after Promise Time
    w.mark(TUE, "B", 1, "A"); w.mark(TUE, "B", 3, "A"); w.mark(TUE, "B", 5, "T");  // arrived during P4
    w.mark(TUE, "H", 3, "T");                    // PT-B has no marks yet: held
    w.mark(TUE, "H2", 3, "T");                   // PT-C never gets marks: held until after school
    w.mark(TUE, "S6", 7, "T");                   // P6: never the same day
    w.mark(TUE, "X", 3, "T");                    // HS, which is off
    w.mark(TUE, "D1", 3, "D");                   // Excused Tardy: never
    w.mark(TUE, "K", 9, "A"); w.mark(TUE, "K", 7, "A");   // K misses Power-Up and P6
    const kPu = w.find(TUE, "K", 9);

    clock.set(la("2026-10-11", "20:00"));
    const on = await w.rt.run("reflection.setMode", { division: "ms", mode: "shadow", countFromDate: MON });
    check("setMode turns MS on in shadow, counting from Monday, and writes reflectionAudit",
      on.ok && on.countFromDate === MON && w.store.rows("reflectionAudit").some((r) => r.action === "set-mode" && /MS: off -> shadow/.test(r.reason)), J(on));
    clock.set(la("2026-10-11", "21:00"));
    const offTick = await w.rt.run("reflection.tick", {});
    check("a tick outside the school day books nothing", offTick.do === "none" && w.rt.jobs.length === 0, J(offTick));

    await drive(w, la(TUE, "07:30"), la(TUE, "07:30"));
    const opening = readsOf(w, "opening")[0]?.out;
    check("the opening read runs at 07:30 and is applied", opening?.applied === true && opening?.ok === true, J(opening));
    check("...it takes the roster snapshot and stores the codes and student map",
      w.store.rows("reflectionRoster").length > 20
      && w.store.rows("appState").some((r) => r.key === "reflection:maps" && r.value.codes.length === 7)
      && w.store.rows("reflectionRoster").find((r) => r.studentNumber === "K").puSectionId === "PU-7");
    const tA = w.tardies("A")[0];
    check("a tardy between periods is stored countable, keyed by student, date and period",
      tA?.state === "countable" && tA.periodId === 853 && tA.slot === 3 && tA.firstSeenAt === la(TUE, "07:30") && tA.classTeacher === "Ms Ng", J(tA));
    check("an arrival (absent at Promise Time and P2, late to P4) is stored as an arrival, never countable",
      w.tardies("B")[0]?.state === "arrival" && /Arrived late/.test(w.tardies("B")[0].reason), J(w.tardies("B")));
    check("a tardy whose Promise Time section has no marks yet is held", w.tardies("H")[0]?.state === "held" && w.tardies("H")[0].wasHeld === true);
    check("an HS tardy while HS is off is before-start", w.tardies("X")[0]?.state === "before-start");
    check("an Excused Tardy is never stored", w.tardies("D1").length === 0);
    check("the lookback read Monday (never proved, so counted first) and stored its tardies",
      w.tardies("W")[0]?.state === "countable" && w.tardies("W")[0].attDate === MON && w.tardies("Y")[0]?.state === "countable", J(w.tardies("W")));
    check("...and today is a school day by evidence, a regular day, closing at 11:45",
      w.day(TUE).schoolDay === true && w.day(TUE).kind === "regular" && w.day(TUE).closeInstant === la(TUE, "11:45"), J(w.day(TUE)));

    await drive(w, la(TUE, "07:35"), la(TUE, "11:40"), [
      [la(TUE, "10:25"), () => w.mark(TUE, "CB", 1, "A")],     // PT-B's attendance arrives
      [la(TUE, "11:38"), () => w.unmark(yMon)],                 // Y's Monday mark deleted just before the close
    ]);
    check("the routine and pre-close reads ran, none in the 5 minutes before the close",
      ["routine@510", "routine@570", "routine@630", "pre-close@40", "pre-close@30", "pre-close@20", "pre-close@10"].every((k) => w.day(TUE).readsDone.includes(k))
      && !readsOf(w).some((l) => Date.parse(l.at) > Date.parse(la(TUE, "11:40")) - 1), J(w.day(TUE).readsDone));
    const snapAt = new Set(w.store.rows("reflectionRoster").map((r) => r.snapAt));
    check("the roster snapshot is taken once a day, by the opening read", snapAt.size === 1 && snapAt.has(la(TUE, "07:30")), J([...snapAt]));
    const h = w.tardies("H")[0];
    check("a hold resolves when the section gets marks (10:30), before the list", h.state === "countable" && h.firstCountableAt === la(TUE, "10:30") && h.wasHeld, J(h));

    await drive(w, la(TUE, "11:45"), la(TUE, "11:45"));
    const day = w.day(TUE);
    check("the closing read at 11:45 makes the list", day.frozenAt && day.freezeKind === "closing" && day.closingReadStartedAt === la(TUE, "11:45"), J(day));
    check("...with exactly the right students: between-period tardies, Monday's, the released hold",
      J(w.listed(TUE)) === J(["A", "C", "H", "K", "M", "Q", "R", "W", "Y", "Z"]), J(w.listed(TUE)));
    check("...never the arrival, the P6 tardy of today, the HS tardy, or the Excused Tardy",
      !w.listed(TUE).some((s) => ["B", "S6", "X", "D1"].includes(s)));
    const uW = w.units("W")[0];
    check("...one row each, every violation dated, Monday's P5 tagged after Power-Up, the Power-Up class copied",
      uW.lines.join() === "Mon 10/12: Tardy P5 (Ms Diaz)" && uW.tags.includes("From Mon 10/12 P5 (after Power-Up)")
      && uW.puSnapshot.teacherName === "Ms Ruiz" && uW.mode === "shadow" && uW.state === "listed", J(uW));
    check("the closing read never clears: Y's Monday mark went missing at 11:38 and Y is still on the list",
      w.tardies("Y")[0].state === "countable" && w.tardies("Y")[0].missingSince === la(TUE, "11:45") && w.listed(TUE).includes("Y"), J(w.tardies("Y")));
    check("the list counts MS and HS separately", J(day.listCount) === J({ ms: 10, hs: 0 }), J(day.listCount));

    // After the list: corrections and a late entry.
    const rRow = w.find(TUE, "R", 3), mRow = w.find(TUE, "M", 3), cRow = w.find(TUE, "C", 3), zRow = w.find(TUE, "Z", 3);
    let rNew;
    await drive(w, la(TUE, "11:50"), la(TUE, "13:00"), [
      [la(TUE, "12:30"), () => w.mark(TUE, "L", 3, "T")],
      [la(TUE, "12:40"), () => { rNew = w.fake.reenter(rRow); w.fake.movePeriod(mRow, 855); w.fake.changeCode(cRow, CODE.D); }],
    ]);
    const tL = w.tardies("L")[0];
    check("applyRead on a day already made adds a late entry as pending for the next list",
      tL?.state === "countable" && !tL.unitId && tL.firstSeenAt === la(TUE, "13:00"), J(tL));
    const tR = w.tardies("R");
    check("a re-entered row: no double listing (one tardy, its new id, still on its detention)",
      tR.length === 1 && J(tR[0].psRowIds) === J([String(rNew)]) && tR[0].state === "countable"
      && tR[0].unitId === w.units("R")[0]._id && w.units("R").length === 1 && w.units("R")[0].state === "listed", J({ tR, u: w.units("R") }));
    const tM = w.tardies("M");
    check("a moved period: the assignment moves with it",
      tM.length === 1 && tM[0].periodId === 855 && tM[0].slot === 5 && tM[0].unitId === w.units("M")[0]._id && tM[0].classTeacher === "Ms Park", J(tM));
    const uC = w.units("C")[0];
    check("T to D after the list is made: the tardy is cleared and the detention released",
      w.tardies("C")[0].state === "cleared" && w.tardies("C")[0].reason === "now Excused Tardy"
      && uC.state === "released" && uC.releasedAt === la(TUE, "13:00") && uC.serveDay === TUE, J({ t: w.tardies("C")[0], uC }));

    const qRow = w.fake.tables.attendance.find((r) => r.id === w.find(TUE, "Q", 3));
    await drive(w, la(TUE, "13:05"), la(TUE, "14:00"), [
      [la(TUE, "13:30"), () => { w.unmark(zRow); w.unmark(qRow.id); w.ctl.directFail = true; }],
    ]);
    check("a delete during paging: no clear without the direct id read",
      w.tardies("Z")[0].state === "countable" && w.tardies("Z")[0].missingSince === la(TUE, "14:00") && w.units("Z")[0].state === "listed", J(w.tardies("Z")));
    await drive(w, la(TUE, "14:05"), la(TUE, "15:00"), [[la(TUE, "14:30"), () => { w.ctl.directFail = false; w.fake.tables.attendance.push(qRow); }]]);
    check("...and once the direct id read says the row is gone, it is cleared and the detention released",
      w.tardies("Z")[0].state === "cleared" && w.tardies("Z")[0].reason === "removed in PowerSchool" && w.units("Z")[0].state === "released", J(w.tardies("Z")));
    check("a mark that went missing and came back is simply not missing any more",
      w.tardies("Q")[0].state === "countable" && !w.tardies("Q")[0].missingSince && w.units("Q")[0].state === "listed", J(w.tardies("Q")));
    let zAgain;

    await drive(w, la(TUE, "15:05"), la(TUE, "15:45"), [[la(TUE, "15:20"), () => { zAgain = w.mark(TUE, "Z", 3, "T"); }]]);
    check("the after-school read ran with the lookback and the sweep", w.day(TUE).readsDone.includes("after-school"));
    // Z was released at 15:00, after the room ran at 12:31 with Z on its
    // list: the same PowerSchool mark back again is that detention, never a
    // second one (spec 3.10, "updated, not doubled"; review, 2026-10-08).
    check("a tardy deleted (confirmed) after the room ran and entered again is back on its own detention, never served twice",
      w.tardies("Z").length === 1 && w.tardies("Z")[0].state === "countable" && w.tardies("Z")[0].unitId === w.units("Z")[0]._id
      && J(w.tardies("Z")[0].psRowIds) === J([String(zAgain)]) && w.units("Z").length === 1 && w.units("Z")[0].state === "listed"
      && !w.units("Z")[0].releasedAt && !w.units("Z")[0].releaseReason, J({ t: w.tardies("Z"), u: w.units("Z") }));
    check("...it cleared Y's deleted Monday mark (a direct id read behind it) and released Y",
      w.tardies("Y")[0].state === "cleared" && w.units("Y")[0].state === "released", J(w.tardies("Y")));
    check("...a section that never took attendance is taken as present at 15:45: H2's hold is released, for the next list",
      w.tardies("H2")[0].state === "countable" && !w.tardies("H2")[0].unitId && w.tardies("H2")[0].firstCountableAt === la(TUE, "15:45"), J(w.tardies("H2")));
    const uK = w.units("K");
    check("the PowerSchool fallback carries K (absent at Power-Up and in P6), as a pending carry",
      uK.length === 2 && uK[0].state === "carried" && uK[1].kind === "carry" && uK[1].state === "pending"
      && uK[1].carryCount === 1 && uK[1].tags[0] === "Carried over from Tue 10/13 (absent)" && uK[0].carriedToUnitId === uK[1]._id, J(uK));
    check("...and does not carry A, who was at Power-Up", w.units("A").length === 1 && w.units("A")[0].state === "listed" && w.units("A")[0].carryBasis === "powerschool");
    check("shadow mode raises no day-level review for PowerSchool deciding", !w.day(TUE).fallbackReview && w.day(TUE).carriesDecidedAt);

    // Tuesday evening: A's Power-Up and P6 absences are entered late; K's Power-Up absence is taken back.
    clock.set(la(TUE, "17:30"));
    w.mark(TUE, "A", 9, "A"); w.mark(TUE, "A", 7, "A");
    w.unmark(kPu);
    // Wednesday: A is absent all day; N is late to P1; S7 late to P6.
    for (const s of WED_SLOTS) if (s !== 8) w.mark(WED, "A", s, "A");
    w.mark(WED, "N", 2, "T");
    w.mark(WED, "S7", 7, "T");

    await drive(w, la(WED, "07:30"), la(WED, "07:30"));
    const uA = w.units("A");
    check("a late Power-Up absence creates a fallback carry on the first list after it is seen",
      uA.length === 2 && uA[0].state === "carried" && uA[1].state === "pending" && uA[1].carriedFromDay === TUE, J(uA));
    const uK2 = w.units("K");
    check("a removed Power-Up absence cancels a carry that is still pending",
      uK2[0].state === "listed" && !uK2[0].carriedToUnitId && uK2[1].state === "expired" && /No longer carried/.test(uK2[1].expireReason), J(uK2));

    await drive(w, la(WED, "07:35"), la(WED, "11:20"));
    const wed = w.day(WED);
    check("Wednesday closes at 11:20 and the closing read makes the list",
      wed.frozenAt && wed.freezeKind === "closing" && wed.closingReadStartedAt === la(WED, "11:20") && wed.kind === "wed", J(wed));
    check("Wednesday's list: Tuesday's P6, the late entry, the hold released after school, A's carry, and N",
      J(w.listed(WED)) === J(["A", "H2", "L", "N", "S6"]), J(w.listed(WED)));
    const tag = (sn) => w.units(sn).find((u) => u.serveDay === WED).tags;
    check("...each tagged with why it is on this list",
      tag("S6").includes("From Tue 10/13 P6 (after Power-Up)") && tag("L").includes("Entered late in PowerSchool (Tue 10/13 P2)")
      && tag("H2").includes("Held for attendance (Tue 10/13 P2)") && tag("A").includes("Carried over from Tue 10/13 (absent)"),
      J({ S6: tag("S6"), L: tag("L"), H2: tag("H2"), A: tag("A") }));
    check("...and nobody is listed twice: not R (re-entered), not M (moved), not K (carry cancelled), not Z (entered again after serving)",
      !["R", "M", "K", "C", "Y", "Q", "Z"].some((s) => w.listed(WED).includes(s)));
    check("S7's Wednesday P6 waits for the next list", w.tardies("S7")[0].state === "countable" && !w.tardies("S7")[0].unitId);

    await drive(w, la(WED, "11:25"), la(WED, "15:45"));
    const aCarry = w.units("A").find((u) => u.state === "pending");
    check("A, absent all Wednesday, carries again (count 2)", aCarry && aCarry.carryCount === 2, J(w.units("A")));

    clock.set(la(WED, "18:00"));
    const live = await w.rt.run("reflection.setMode", { division: "ms", mode: "live", countFromDate: "2026-10-15" });
    check("going live sets a new countFromDate and parks what was waiting from shadow",
      live.ok && live.parked === 2 && w.tardies("S7")[0].state === "before-start"
      && w.units("A").find((u) => u._id === aCarry._id).state === "before-start", J({ live, s7: w.tardies("S7")[0] }));
    const past = await w.rt.run("reflection.setMode", { division: "hs", mode: "shadow", countFromDate: "2026-10-01" });
    check("switching on never reaches back: a countFromDate before today is refused", past.ok === false && /before today/.test(past.reason));
    const st = await w.rt.run("reflection.status", { date: WED });
    check("status says what happened, with no student named",
      st.frozenAt === wed.frozenAt && st.onTheList === 5 && !/"(A|K|N|S6|H2|L|Z)"/.test(J(st)), J(st));
  }

  // ==========================================================================
  console.log("\n2. A TEACHER SAVING WHILE THE CLOSING READ READS\n");
  // ==========================================================================
  {
    const TUE = "2026-10-13";
    const w = await world({
      students: { A: { grade: 7, sections: MS }, B: { grade: 7, sections: MS } },
      days: [{ date: TUE, slots: TUE_SLOTS }],
      settings: { modeByDivision: { ms: "shadow", hs: "off" }, countFromDateByDivision: { ms: "2026-10-12", hs: null } },
    });
    w.mark(TUE, "A", 3, "T");
    w.mark(TUE, "B", 1, "A"); w.mark(TUE, "B", 3, "A"); w.mark(TUE, "B", 5, "T");
    await drive(w, la(TUE, "07:30"), la(TUE, "11:40"));
    const before = w.fake.log.filter((l) => l.kind === "table").length;
    w.ctl.swap = TUE;
    w.swapRow.att_date = TUE;
    const countBefore = w.fake.tables.attendance.filter((r) => r.att_date === TUE).length;
    await drive(w, la(TUE, "11:45"), la(TUE, "11:45"));
    const closing = readsOf(w, "closing")[0]?.out;
    const reads = w.fake.log.filter((l) => l.kind === "table").length - before;
    check("a delete plus an insert mid-read (swapDuringRead): the read is not taken, and the arrival stays an arrival",
      closing?.ok === false && !w.day(TUE).frozenAt && !w.day(TUE).readsDone.includes("closing")
      && w.tardies("B")[0].state === "arrival" && /did not hold still in 4 reads/.test(w.day(TUE).lastReadError ?? ""),
      J({ closing, day: w.day(TUE) }));
    check("...an unconfirmed closing read gets up to 4 reads (2 pages each), then waits for the next tick",
      w.fake.swaps === 4 && reads === 8 && w.rt.jobs.length === 0, J({ swaps: w.fake.swaps, reads }));
    check("...and each save really was a delete plus an insert: the day's row count never moved",
      w.fake.tables.attendance.filter((r) => r.att_date === TUE).length === countBefore && w.fake.deleted.length === 4);
    w.ctl.swap = null;
    await drive(w, la(TUE, "11:50"), la(TUE, "11:50"));
    check("...and the 11:50 tick's closing read, confirmed, makes the list as a closing read",
      w.day(TUE).freezeKind === "closing" && w.day(TUE).closingReadStartedAt === la(TUE, "11:50") && J(w.listed(TUE)) === J(["A"]), J(w.day(TUE)));
  }

  // ==========================================================================
  console.log("\n3. LEASES: A READ KILLED BY A DEPLOY, AND A STRAGGLER AT THE READY TIME\n");
  // ==========================================================================
  {
    const TUE = "2026-10-13";
    const w = await world({
      students: { A: { grade: 7, sections: MS }, L2: { grade: 7, sections: MS } },
      days: [{ date: TUE, slots: TUE_SLOTS }],
      settings: { modeByDivision: { ms: "shadow", hs: "off" }, countFromDateByDivision: { ms: "2026-10-12", hs: null } },
    });
    w.mark(TUE, "A", 3, "T");
    await drive(w, la(TUE, "07:30"), la(TUE, "09:25"));
    clock.set(la(TUE, "09:30"));
    const t930 = await w.rt.run("reflection.tick", {});
    const killed = w.rt.take("reflectionRead.read")[0];    // the deploy kills it: it never runs
    clock.set(la(TUE, "09:35"));
    const t935 = await w.rt.run("reflection.tick", {});
    const taken = w.rt.jobs.find((j) => j.path === "reflectionRead.read");
    check("an expired lease is taken over: the 09:35 tick books a new read with a new runId",
      t930.do === "read" && t935.do === "read" && taken && taken.args.runId !== killed.args.runId, J({ t930, t935 }));
    const stale = await w.rt.run("reflection.applyRead", {
      runId: killed.args.runId, key: killed.args.key, kind: killed.args.kind, date: TUE, startedAt: killed.args.startedAt,
      freeze: null, ok: true, dates: [{ date: TUE, full: true, rows: [], unmatched: 0 }], direct: [],
    });
    check("...and a stale runId write is refused, writing nothing", stale.applied === false && /Fenced out/.test(stale.why)
      && !w.day(TUE).readsDone.includes("routine@570"), J(stale));
    await runJobs(w, Date.parse(la(TUE, "09:40")));
    check("...while the run that holds the lease is applied", w.day(TUE).readsDone.includes("routine@570"));

    await drive(w, la(TUE, "09:40"), la(TUE, "11:40"));
    // 11:45 and 11:50: closing reads that hang (never come back).
    for (const at of ["11:45", "11:50"]) {
      clock.set(la(TUE, at));
      await w.rt.run("reflection.tick", {});
      w.rt.take("reflectionRead.read");
    }
    clock.set(la(TUE, "11:55"));
    await w.rt.run("reflection.tick", {});
    const straggler = w.rt.take("reflectionRead.read")[0];
    check("closing reads are booked at 11:45, 11:50 and 11:55 (11:55 + 4 min is still before 12:00)", straggler?.args.key === "closing");
    w.mark(TUE, "L2", 3, "T");                 // entered while the straggler reads
    clock.set(la(TUE, "11:57"));
    let held = null;
    const actx = { ...w.rt.actx, runMutation: async (ref, args) => { held = { ref, args }; return { deferred: true }; } };
    await mods.reflectionRead.read.handler(actx, straggler.args);
    clock.set(la(TUE, "12:00"));
    const fb = await w.rt.run("reflection.tick", {});
    check("the fallback freeze at the ready time makes the list without PowerSchool", fb.do === "fallback-freeze"
      && w.day(TUE).freezeKind === "fallback" && w.day(TUE).frozenAt === la(TUE, "12:00") && J(w.listed(TUE)) === J(["A"]), J(fb));
    const late = await w.rt.run(held.ref, held.args);
    check("the fallback fences a straggling read: its write is refused", late.applied === false && w.tardies("L2").length === 0, J(late));
    check("...the screen says how the list was made", R.freezeBanner({ date: TUE, frozenAt: la(TUE, "12:00"), freezeKind: "fallback", lastGoodReadAt: w.day(TUE).lastGoodReadAt }, TZ)
      === "Made at 12:00 without a final PowerSchool read (last good read 11:35).");
    await drive(w, la(TUE, "12:05"), la(TUE, "13:00"));
    check("...and what the straggler saw becomes pending at the next read (13:00), for the next list",
      w.tardies("L2")[0]?.state === "countable" && !w.tardies("L2")[0].unitId, J(w.tardies("L2")));
  }

  // ==========================================================================
  console.log("\n4. POWERSCHOOL DOWN ALL MORNING\n");
  // ==========================================================================
  {
    const TUE = "2026-10-13", WED = "2026-10-14";
    const w = await world({
      students: { A: { grade: 7, sections: MS }, N: { grade: 7, sections: MS } },
      days: [{ date: TUE, slots: TUE_SLOTS }, { date: WED, slots: WED_SLOTS }],
      settings: { modeByDivision: { ms: "shadow", hs: "off" }, countFromDateByDivision: { ms: "2026-10-12", hs: null } },
    });
    w.mark(TUE, "A", 3, "T");
    w.mark(WED, "N", 2, "T");
    w.ctl.down = true;
    await drive(w, la(TUE, "07:30"), la(TUE, "12:20"));
    check("no read works, so no list is made at the ready time (not proved a school day); late reads try 12:00-12:15",
      !w.day(TUE).frozenAt && readsOf(w, "late-closing").length === 4, J({ late: readsOf(w, "late-closing").length }));
    check("...the opening read is retried every 5 minutes, but the roster (no PowerSchool needed) is copied once",
      readsOf(w, "opening").length === 12 && new Set(w.store.rows("reflectionRoster").map((r) => r.snapAt)).size === 1
      && w.store.rows("reflectionRoster")[0].snapAt === la(TUE, "07:30"), J({ opening: readsOf(w, "opening").length }));
    await drive(w, la(TUE, "12:25"), la(TUE, "12:25"));
    check("the latest freeze records noList (nothing may make the list from 12:21)",
      w.day(TUE).noList && w.day(TUE).noList.at === la(TUE, "12:25") && !w.day(TUE).frozenAt, J(w.day(TUE)));
    const st = await w.rt.run("reflection.status", { date: TUE });
    check("...and the screen says so", st.banner === "No list today: PowerSchool unreachable all morning. Today's violations will be on Wed 10/14's list.", st.banner);
    w.ctl.down = false;
    await drive(w, la(TUE, "12:30"), la(TUE, "13:00"));
    check("PowerSchool back: Tuesday's tardies are stored, unclaimed, and the day is never made late",
      w.tardies("A")[0]?.state === "countable" && !w.tardies("A")[0].unitId && !w.day(TUE).frozenAt, J(w.tardies("A")));
    await drive(w, la(WED, "07:30"), la(WED, "11:20"));
    const uA = w.units("A")[0];
    check("every item lands on the next list (Wednesday), tagged List not made",
      J(w.listed(WED)) === J(["A", "N"]) && uA.tags.includes("List not made Tue 10/13"), J({ l: w.listed(WED), tags: uA?.tags }));
  }

  // ==========================================================================
  console.log("\n5. A TARDY FIRST SEEN AFTER FIVE LISTS\n");
  // ==========================================================================
  {
    const TUE = "2026-10-13";
    const listDays = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"];
    const w = await world({
      students: { V: { grade: 7, sections: MS }, U: { grade: 7, sections: MS } },
      days: [{ date: "2026-10-05", slots: MON_SLOTS }, { date: "2026-10-09", slots: TUE_SLOTS }, { date: TUE, slots: TUE_SLOTS }],
      settings: { modeByDivision: { ms: "shadow", hs: "off" }, countFromDateByDivision: { ms: "2026-10-01", hs: null } },
    });
    for (const d of listDays) {
      await w.store.db.insert("reflectionDays", {
        date: d, schoolDay: true, readsDone: ["opening", "after-school"], frozenAt: la(d, "11:46"), freezeKind: "closing",
        modeByDivision: { ms: "shadow", hs: "off" }, tHashAtFullRead: R.idSetHash([]), updatedAt: la(d, "15:45"),
      });
    }
    w.mark("2026-10-05", "V", 2, "T");      // Monday 10/5 P1, first seen 10/13: five lists later
    w.mark("2026-10-09", "U", 3, "T");      // Friday 10/9 P2, first seen 10/13: one list later
    // The reader was not running today: 15:40 records "No list today", 15:45 is the after-school read.
    await drive(w, la(TUE, "15:40"), la(TUE, "15:45"));
    const v = w.tardies("V")[0], u = w.tardies("U")[0];
    check("a T first seen after 5 lists goes to review (found by the after-school sweep)",
      v?.state === "review" && v.listsBeforeSeen === 5 && /Entered very late: 5 lists/.test(v.reason), J(v));
    check("...one seen after a single list is simply countable (found by the lookback)",
      u?.state === "countable" && u.listsBeforeSeen === 1, J(u));
  }

  // ==========================================================================
  console.log("\n6. THE FIRST DAY BACK FROM THANKSGIVING (standard time)\n");
  // ==========================================================================
  {
    const FRI = "2026-11-20", MON = "2026-11-30";
    const w = await world({
      students: { G: { grade: 7, sections: MS }, E: { grade: 7, sections: MS } },
      days: [{ date: FRI, slots: TUE_SLOTS }, { date: MON, slots: MON_SLOTS }],
      marks: ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"].map((date) => ({ date, noSchool: true })),
      settings: { modeByDivision: { ms: "shadow", hs: "off" }, countFromDateByDivision: { ms: "2026-11-02", hs: null } },
    });
    for (const d of ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", FRI]) {
      await w.store.db.insert("reflectionDays", {
        date: d, schoolDay: true, readsDone: ["after-school"], frozenAt: la(d, "11:46"), freezeKind: "closing",
        modeByDivision: { ms: "shadow", hs: "off" }, tHashAtFullRead: R.idSetHash([]), updatedAt: la(d, "15:45"),
      });
    }
    w.mark(FRI, "G", 7, "T");               // Friday P6, entered at 16:30 Friday, after the after-school read
    w.mark(MON, "E", 2, "T");
    await drive(w, la(MON, "07:30"), la(MON, "11:45"));
    check("after a 10-day break, the first day's lookback re-reads the day before the break",
      J(w.listed(MON)) === J(["E", "G"]) && w.units("G")[0]?.tags.includes("From Fri 11/20 P6 (after Power-Up)")
      && w.tardies("G")[0].listsBeforeSeen === 0, J({ l: w.listed(MON), g: w.tardies("G") }));
    check("...and the list closed at 11:45 PST (19:45Z), not an hour early",
      w.day(MON).closingReadStartedAt === "2026-11-30T19:45:00.000Z", w.day(MON)?.closingReadStartedAt);
  }

  // ==========================================================================
  console.log("\n7. HS SWITCHED ON FOR THURSDAY\n");
  // ==========================================================================
  {
    const WED = "2026-10-14";
    const w = await world({
      students: { N: { grade: 7, sections: MS }, X2: { grade: 10, sections: HS } },
      days: [{ date: WED, slots: WED_SLOTS }],
      settings: { modeByDivision: { ms: "shadow", hs: "off" }, countFromDateByDivision: { ms: "2026-10-12", hs: null } },
    });
    clock.set(la("2026-10-13", "18:00"));
    const hs = await w.rt.run("reflection.setMode", { division: "hs", mode: "shadow", countFromDate: "2026-10-15" });
    w.mark(WED, "N", 2, "T");
    w.mark(WED, "X2", 2, "T");
    await drive(w, la(WED, "07:30"), la(WED, "07:30"));
    // Stored before-start the moment it is first seen -- not merely kept off
    // the list later by the freeze's own check (reflectionRules.beforeStartAtClaim).
    const storedAs = w.tardies("X2")[0]?.state;
    await drive(w, la(WED, "07:35"), la(WED, "11:20"));
    check("before-start on switching on: an HS tardy dated before HS's countFromDate is stored, never listed",
      hs.ok && storedAs === "before-start" && w.tardies("X2")[0]?.state === "before-start" && J(w.listed(WED)) === J(["N"]),
      J({ storedAs, x2: w.tardies("X2"), l: w.listed(WED) }));
    check("...while HS is on, so the list's division modes are recorded on the day",
      J(w.day(WED).modeByDivision) === J({ ms: "shadow", hs: "shadow" }), J(w.day(WED).modeByDivision));
  }

  // ==========================================================================
  console.log("\n8. THE COMMAND-LINE SETTINGS, AND WHEN EACH DIVISION IS PULLED\n");
  // ==========================================================================
  {
    const d = R.reflectionSettingsOrDefault({});
    const hhmm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
    const pt = (k, st = d) => { const p = R.pullTimes(k, st); return [p.msMinute, p.swapMinute, p.hsMinute].map(hhmm).join(" "); };
    check("MS is pulled at the block start; the swap defaults to the block's midpoint; HS 5 minutes before it (owner, 10/8)",
      pt("regular") === "12:31 13:02 12:57" && pt("wed") === "11:42 12:13 12:08" && pt("minimum") === "11:42 12:13 12:08"
      && pt("stack") === "12:22 12:53 12:48", ["regular", "wed", "stack"].map((k) => pt(k)).join(" | "));
    check("slips go to the Power-Up teacher in both divisions until someone says otherwise",
      J(d.slipAddresseeByDivision) === J({ ms: "powerup", hs: "powerup" }) && d.hsPullLeadMinutes === 5);

    const w = await world({ students: {}, settings: { modeByDivision: { ms: "shadow", hs: "off" }, countFromDateByDivision: { ms: "2026-10-12", hs: null } } });
    clock.set(la("2026-10-13", "18:00"));
    const saved = await w.rt.run("reflection.saveSettings", {
      swapMinuteByKind: { regular: 790, stack: 850 }, hsPullLeadMinutes: 7, slipAddresseeByDivision: { ms: "before-lunch" },
      closeMinuteByKind: { regular: 707 }, holdFirstClassOnPtNoRow: true,
    });
    const st = saved.settings;
    check("saveSettings takes a swap minute inside the block, the HS lead, and the MS slip addressee",
      st.swapMinuteByKind.regular === 790 && st.hsPullLeadMinutes === 7 && st.slipAddresseeByDivision.ms === "before-lunch"
      && st.slipAddresseeByDivision.hs === "powerup" && st.holdFirstClassOnPtNoRow === true && pt("regular", st) === "12:31 13:10 13:03", J(st));
    check("...refuses what does not make sense, and says so: a swap outside the block, a close that is not a 5-minute step",
      st.swapMinuteByKind.stack === null && st.closeMinuteByKind.regular === 705
      && saved.refused.includes("swapMinuteByKind") && saved.refused.includes("closeMinuteByKind") && !saved.refused.includes("hsPullLeadMinutes"),
      J(saved.refused));
    check("...never touches the switch (only setMode moves it), and writes reflectionAudit",
      st.modeByDivision.ms === "shadow" && st.countFromDateByDivision.ms === "2026-10-12"
      && w.store.rows("reflectionAudit").some((r) => r.action === "save-settings"), J(st.modeByDivision));
  }

  // ==========================================================================
  console.log("\n9. THE LIST ON SCREEN AND ON PAPER (listForDay, recordPrint, per-print changes)\n");
  // ==========================================================================
  {
    const TUE = "2026-10-13", MON = "2026-10-12", WED = "2026-10-14";
    const ms = { grade: 7, sections: MS };
    const w = await world({
      students: { A: ms, W: ms, C: ms, L: ms, Z: ms, S6: ms, X: { grade: 10, sections: HS } },
      days: [{ date: MON, slots: MON_SLOTS }, { date: TUE, slots: TUE_SLOTS }, { date: WED, slots: WED_SLOTS }],
      settings: { modeByDivision: { ms: "shadow", hs: "live" }, countFromDateByDivision: { ms: MON, hs: MON } },
    });
    const staff = {
      admin: { email: "admin@school.test", role: "admin" },
      pbis: { email: "pbis@school.test", role: "pbis" },
      teacher: { email: "teacher@school.test", role: "teacher" },
      aide: { email: "aide@school.test", role: "campusaide" },
      granted: { email: "granted@school.test", role: "campusaide", reflectionList: true, reflectionListUntil: "2026-12-18" },
      expired: { email: "expired@school.test", role: "campusaide", reflectionList: true, reflectionListUntil: "2026-10-12" },
      openEnded: { email: "open@school.test", role: "teacher", reflectionList: true },
      truthy: { email: "truthy@school.test", role: "teacher", reflectionList: "true" },
    };
    for (const t of Object.values(staff)) await w.store.db.insert("teachers", { name: "Staff", ticketsAwarded: 0, ...t });
    const as = (who) => { w.rt.signIn({ issuer: STAFF_ISSUER, email: staff[who].email }); return w.rt; };
    const list = (who, day = "today") => as(who).run("reflectionList.listForDay", { day });
    const print = (who, res, kind = "master", day = res.date) => as(who).run("reflectionList.recordPrint", {
      day, kind, unitIds: res.sections.flatMap((s) => s.rows).map((r) => r.unitId).filter(Boolean),
      studentNumbers: res.sections.flatMap((s) => s.rows).filter((r) => r.state !== "released").map((r) => r.studentNumber),
      listVersion: res.listVersion,
    });
    const rowsOf = (res, division) => res.sections.find((s) => s.division === division).rows;
    const sns = (res, division) => rowsOf(res, division).map((r) => r.studentNumber).sort();

    w.mark(MON, "W", 6, "T");                                   // Monday P5: on Tuesday's list
    for (const sn of ["A", "C", "Z"]) w.mark(TUE, sn, 3, "T");   // late to P2
    w.mark(TUE, "X", 2, "T");                                   // HS, late to P1
    w.mark(TUE, "S6", 7, "T");                                  // P6: never the same day
    const zRow = w.find(TUE, "Z", 3), cRow = w.find(TUE, "C", 3);
    // A uniform entry for A (two violations, one row), and one for a student
    // PowerSchool's roster does not have.
    const uni = (sn, grade, hhmm) => w.store.db.insert("uniformViolations", {
      studentNumber: sn, studentName: "-", studentGrade: grade, day: TUE, at: la(TUE, hhmm), loanerProvided: false,
      loanerOutstanding: false, loggedByEmail: "pbis@school.test", loggedByName: "-", loggedByRole: "pbis", attemptId: `a-${sn}`,
    });
    await uni("A", "7", "07:52");
    await uni("U9", "8", "08:10");

    // ---- Who may read it: a direct role check, or an unexpired grant.
    clock.set(la(TUE, "07:00"));
    const realQuery = w.store.db.query;
    let listReads = 0;
    w.store.db.query = (t) => { if (/^reflection|^uniformViolations$/.test(t)) listReads++; return realQuery(t); };
    const refused = [];
    for (const who of ["teacher", "aide", "expired", "truthy"]) {
      listReads = 0;
      const r = await list(who);
      refused.push(r.allowed === false && listReads === 0 && !("sections" in r));
    }
    w.store.db.query = realQuery;
    check("a teacher is refused, and nothing is read", refused[0]);
    check("...and so is a campus aide, an EXPIRED grant, and a grant that is not a real true", refused.slice(1).every(Boolean), J(refused));
    w.rt.signIn(null);
    const anon = await w.rt.run("reflectionList.listForDay", { day: "today" }).then(() => "read", (e) => String(e.message || e));
    check("...and nobody signed in reads nothing", /Not authenticated/.test(anon), anon);
    const okGrant = await list("granted"), okOpen = await list("openEnded"), okPbis = await list("pbis");
    check("admin, PBIS and an unexpired (or open-ended) grant may read it",
      (await list("admin")).allowed && okPbis.allowed && okGrant.allowed && okOpen.allowed);
    check("...a direct role check, not the Attendance Watch grant",
      (await list("teacher")).allowed === false
      && (await (async () => { await w.store.db.insert("teachers", { name: "W", ticketsAwarded: 0, email: "watch@school.test", role: "campusaide", attendanceWatch: true });
        w.rt.signIn({ issuer: STAFF_ISSUER, email: "watch@school.test" });
        return w.rt.run("reflectionList.listForDay", { day: "today" }); })()).allowed === false);

    await drive(w, la(TUE, "07:30"), la(TUE, "11:30"));

    // ---- 11:31: the list SO FAR, printed early by PBIS.
    clock.set(la(TUE, "11:31"));
    const early = await list("pbis");
    check("before the close, today is the list SO FAR: not final, never made",
      early.view === "so-far" && early.frozen === false && early.isToday && early.banners.some((b) => b.id === "not-final" && /^NOT FINAL: do not pull/.test(b.text)), J(early.banners));
    check("MS and HS sections, MS first (MS serves in the first half of lunch), each with its own count and pull time",
      J(early.sections.map((s) => [s.division, s.count, s.pullAt])) === J([["ms", 5, "12:31"], ["hs", 1, "12:57"]]), J(early.sections.map((s) => [s.division, s.count, s.pullAt])));
    check("...exactly the students the freeze would claim: never S6 (P6 today)",
      J(sns(early, "ms")) === J(["A", "C", "U9", "W", "Z"]) && J(sns(early, "hs")) === J(["X"]), J([sns(early, "ms"), sns(early, "hs")]));
    const rowA = rowsOf(early, "ms").find((r) => r.studentNumber === "A");
    check("several violations on one list are ONE row, every violation shown with its date",
      rowsOf(early, "ms").filter((r) => r.studentNumber === "A").length === 1
      && J(rowA.lines) === J(["Tue 10/13: Tardy P2 (Ms Ng)", "Tue 10/13: Uniform 7:52 AM"]) && rowA.grade === "7"
      && rowA.pu.teacher === "Ms Ruiz", J(rowA));
    const rowW = rowsOf(early, "ms").find((r) => r.studentNumber === "W");
    check("...a Monday P5 tardy carries its own date and why it is on Tuesday's list",
      J(rowW.lines) === J(["Mon 10/12: Tardy P5 (Ms Diaz)"]) && rowW.tags.includes("From Mon 10/12 P5 (after Power-Up)"), J(rowW));
    check("a uniform-only student with no PowerSchool roster row says so",
      rowsOf(early, "ms").find((r) => r.studentNumber === "U9").notOnRoster === true);
    check("PILOT banner for the division in shadow (MS), none for the live one (HS)",
      early.banners.some((b) => b.id === "pilot-ms" && /^PILOT \(MS\): do not assign/.test(b.text)) && !early.banners.some((b) => b.id === "pilot-hs"), J(early.banners.map((b) => b.id)));
    check("no names leave the server: rows carry student numbers and grades only",
      !/"(firstName|lastName|studentName|name)"/.test(J(early.sections)));
    const nextEarly = await list("pbis", "next");
    check("Tomorrow so far: tonight's P6 (S6), never a student about to serve today for the same thing",
      nextEarly.date === WED && nextEarly.isNext && nextEarly.view === "so-far" && J(sns(nextEarly, "ms")) === J(["S6"]) && sns(nextEarly, "hs").length === 0,
      J([nextEarly.date, sns(nextEarly, "ms"), sns(nextEarly, "hs")]));
    const slipsEarly = await print("pbis", early, "slips");
    check("slips are refused while the list is not final", slipsEarly.ok === false && /only once the list is final/.test(slipsEarly.reason), J(slipsEarly));
    const pEarly = await print("pbis", early);
    check("an early master print is recorded, NOT final (the server decides, not the browser)", pEarly.ok && pEarly.final === false, J(pEarly));

    // ---- L is entered at 11:33; the closing read at 11:45 makes the list.
    await drive(w, la(TUE, "11:35"), la(TUE, "11:45"), [[la(TUE, "11:33"), () => w.mark(TUE, "L", 3, "T")]]);
    clock.set(la(TUE, "11:46"));
    const made = await list("admin");
    check("after the close, today is the list made at 11:45: final",
      made.view === "made" && made.frozen && made.freezeKind === "closing" && J(sns(made, "ms")) === J(["A", "C", "L", "U9", "W", "Z"])
      && !made.banners.some((b) => b.id === "not-final"), J([made.view, sns(made, "ms")]));
    const pAdmin = await print("admin", made);
    check("the admin's 11:46 master print is final", pAdmin.ok && pAdmin.final === true);
    const pbisAfter = await list("pbis");
    check("PBIS, who printed before the list was made, is told: out of date, +1 added",
      pbisAfter.myPrintChanges?.outOfDate && J(pbisAfter.myPrintChanges.added) === J(["L"])
      && pbisAfter.banners.some((b) => b.id === "print-out-of-date" && /The final list was made at 11:45\. Your 11:31 print is out of date \(\+1 added\): print the list again\./.test(b.text)),
      J([pbisAfter.myPrintChanges, pbisAfter.banners.map((b) => b.text)]));

    // ---- 12:40 Z's mark is deleted (confirmed at 13:00); the aide prints slips at 13:05.
    await drive(w, la(TUE, "11:50"), la(TUE, "13:00"), [[la(TUE, "12:40"), () => w.unmark(zRow)]]);
    clock.set(la(TUE, "13:05"));
    const forAide = await list("granted");
    const pSlips = await print("granted", forAide, "slips");
    check("a grant holder may print slips once the list is final", pSlips.ok && pSlips.final === true, J(pSlips));
    check("...and the released student is shown, but not counted, and not printed",
      rowsOf(forAide, "ms").find((r) => r.studentNumber === "Z")?.state === "released" && forAide.sections[0].count === 5);

    // ---- 13:30 C's tardy becomes an Excused Tardy (read at 14:00).
    await drive(w, la(TUE, "13:05"), la(TUE, "14:00"), [[la(TUE, "13:30"), () => w.fake.changeCode(cRow, CODE.D)]]);
    clock.set(la(TUE, "14:05"));
    const vPbis = await list("pbis"), vAdmin = await list("admin"), vAide = await list("granted");
    const rel = (r) => r.myPrintChanges.release.map((x) => x.studentNumber).sort();
    check("each viewer sees their OWN changes, against their own print: PBIS (11:31) +L, release C and Z",
      J(vPbis.myPrintChanges.added) === J(["L"]) && J(rel(vPbis)) === J(["C", "Z"]), J(vPbis.myPrintChanges));
    check("...the admin (11:46): release C and Z",
      vAdmin.myPrintChanges.added.length === 0 && J(rel(vAdmin)) === J(["C", "Z"]), J(vAdmin.myPrintChanges));
    check("...the aide (13:05 slips): release C only",
      vAide.myPrintChanges.added.length === 0 && J(rel(vAide)) === J(["C"])
      && vAide.banners.some((b) => b.id === "print-out-of-date" && b.text === "Since your 1:05 print: release 1."), J([vAide.myPrintChanges, vAide.banners.map((b) => b.text)]));
    check("T to D after the list is made: released, and shown in each earlier print's changes as release this student",
      vPbis.myPrintChanges.release.find((x) => x.studentNumber === "C")?.reason === "now Excused Tardy"
      && rowsOf(vAdmin, "ms").find((r) => r.studentNumber === "C").released?.reason === "now Excused Tardy");
    check("the roles see each print of the day with its change counts (staff emails only); a grant holder does not",
      vAdmin.printsToday?.length === 3 && J(vAdmin.printsToday.map((p) => [p.by, p.kind, p.final, p.changes.release])) === J([
        ["pbis@school.test", "master", false, 2], ["admin@school.test", "master", true, 2], ["granted@school.test", "slips", true, 1]])
      && vAide.printsToday === null && vAide.roles === false, J(vAdmin.printsToday));
    check("...each print says whether it predates the list and is out of date, as its holder is told",
      J(vAdmin.printsToday.map((p) => [p.beforeFreeze, p.outOfDate])) === J([[true, true], [false, true], [false, true]]), J(vAdmin.printsToday));

    const prints = w.store.rows("reflectionPrints");
    const FIELDS = ["_creationTime", "_id", "at", "day", "final", "kind", "listVersion", "mode", "printedByEmail", "studentNumbers", "unitIds"];
    check("reflectionPrints holds ids and student numbers only (no name field, in the rows or the schema)",
      prints.length === 3 && prints.every((p) => J(Object.keys(p).sort()) === J(FIELDS))
      && !/name/i.test(schemaSrc.slice(schemaSrc.indexOf("reflectionPrints: defineTable("), schemaSrc.indexOf('.index("by_day_email"'))),
      J(prints.map((p) => Object.keys(p))));
    check("...with the division modes the list was made under", prints[1].mode === "ms:shadow hs:live", prints[1].mode);

    // ---- Role-only banners: the review queue's size and age.
    await w.store.db.insert("reflectionTardies", {
      studentNumber: "W", attDate: MON, periodId: 852, slot: 2, psRowIds: ["1"], code: "T", division: "ms", state: "review",
      reason: "PowerSchool has 2 marks for this period", firstSeenAt: la(TUE, "07:30"), listsBeforeSeen: 0, lastSeenAt: la(TUE, "07:30"),
    });
    const withReview = await list("pbis"), aideReview = await list("granted");
    check("the roles see 'N waiting in review, oldest' on Today; a grant holder never does",
      withReview.banners.some((b) => b.id === "review" && b.text === "1 waiting in review, oldest Mon 10/12.")
      && J(withReview.review) === J({ count: 1, oldest: MON }) && !aideReview.banners.some((b) => b.id === "review") && aideReview.review === null,
      J(withReview.banners.map((b) => b.text)));
    const queue = await w.rt.run("reflectionList.adminReview", {});
    check("the review queue's data, from the command line: the item with its age in school days",
      queue.count === 1 && queue.items[0].kind === "tardy" && queue.items[0].ageSchoolDays === 1, J(queue));

    const exp = await w.rt.run("reflectionList.verifyExport", { day: TUE });
    check("verifyExport (command line only) gives the verify script keys and states",
      exp.dayRow.freezeKind === "closing" && exp.list.length === 7
      && exp.tardies.some((t) => t.key === `L|${TUE}|853` && t.unitServeDay === TUE) && exp.uniformsOnList.length === 2, J({ n: exp.list.length }));
    const past = await list("admin", MON);
    check("a past day with no list made says so", past.view === "not-made" && past.banners.some((b) => b.id === "not-made"), J(past.view));
    const future = await list("admin", "2026-10-20");
    check("only today, the next school day and past days can be shown", future.ok === false, J(future));
  }

  // ==========================================================================
  console.log("\n10. NO LIST TODAY, ON SCREEN\n");
  // ==========================================================================
  {
    const TUE = "2026-10-13";
    const w = await world({
      students: { A: { grade: 7, sections: MS } },
      days: [{ date: TUE, slots: TUE_SLOTS }],
      settings: { modeByDivision: { ms: "live", hs: "off" }, countFromDateByDivision: { ms: "2026-10-12", hs: null } },
    });
    await w.store.db.insert("teachers", { name: "Staff", ticketsAwarded: 0, email: "admin@school.test", role: "admin" });
    w.rt.signIn({ issuer: STAFF_ISSUER, email: "admin@school.test" });
    w.mark(TUE, "A", 3, "T");
    w.ctl.down = true;
    await drive(w, la(TUE, "07:30"), la(TUE, "11:00"));
    clock.set(la(TUE, "11:01"));
    const stale = await w.rt.run("reflectionList.listForDay", { day: "today" });
    check("PowerSchool unreadable all morning: the last-read banner is red",
      stale.banners.some((b) => b.id === "last-read" && b.level === "alert" && b.text === "No PowerSchool read has worked yet today."), J(stale.banners));
    await drive(w, la(TUE, "11:05"), la(TUE, "12:25"));
    clock.set(la(TUE, "12:26"));
    const none = await w.rt.run("reflectionList.listForDay", { day: "today" });
    check("No list today: the banner says why and where today's violations go",
      none.view === "no-list" && none.sections.every((s) => s.rows.length === 0)
      && none.banners.some((b) => b.id === "no-list" && b.text === "No list today: PowerSchool unreachable all morning. Today's violations will be on Wed 10/14's list."),
      J(none.banners));
    check("...and a live division has no PILOT banner", !none.banners.some((b) => /^pilot/.test(b.id)));
    clock.set(la("2026-10-14", "08:00"));
    const later = await w.rt.run("reflectionList.listForDay", { day: TUE });
    check("...looked back on the next day, it names the day it is about",
      later.view === "no-list" && later.banners.some((b) => b.id === "no-list"
        && b.text === "No list on Tue 10/13: PowerSchool unreachable all morning. That day's violations will be on Wed 10/14's list."),
      J(later.banners));
  }

  // ==========================================================================
  console.log("\n11. THE ROOM'S OWN ATTENDANCE: Not here, Attendance done (reflectionRoom.ts)\n");
  // ==========================================================================
  {
    const TUE = "2026-10-13", WED = "2026-10-14";
    const ms = { grade: 7, sections: MS };
    const w = await world({
      students: { A: ms, C: ms, E: ms },
      days: [{ date: TUE, slots: TUE_SLOTS }, { date: WED, slots: WED_SLOTS }],
      settings: { modeByDivision: { ms: "live", hs: "off" }, countFromDateByDivision: { ms: "2026-10-12", hs: null } },
    });
    const staff = {
      pbis: { email: "pbis@school.test", role: "pbis" },
      granted: { email: "granted@school.test", role: "campusaide", reflectionList: true, reflectionListUntil: "2026-12-18" },
      teacher: { email: "teacher@school.test", role: "teacher" },
    };
    for (const t of Object.values(staff)) await w.store.db.insert("teachers", { name: "Staff", ticketsAwarded: 0, ...t });
    const as = (who) => { w.rt.signIn({ issuer: STAFF_ISSUER, email: staff[who].email }); return w.rt; };
    const unitOf = (sn, day = TUE) => w.units(sn).find((u) => u.serveDay === day);
    for (const sn of ["A", "C", "E"]) w.mark(TUE, sn, 3, "T");     // late to P2
    w.mark(TUE, "C", 9, "A");          // pulled: the Power-Up teacher marked C absent, but C was in the room
    await drive(w, la(TUE, "07:30"), la(TUE, "11:45"));
    check("the list is made at 11:45 with A, C and E", J(w.listed(TUE)) === J(["A", "C", "E"]) && w.day(TUE).freezeKind === "closing", J(w.listed(TUE)));

    clock.set(la(TUE, "12:00"));
    const early = await as("granted").run("reflectionRoom.markRoom", { unitId: unitOf("A")._id, notHere: true });
    check("Not here opens at Lunch & Power-Up, never before the room has run",
      early.ok === false && /opens at Lunch & Power-Up \(12:31 PM\)/.test(early.reason) && !unitOf("A").roomNotHere, J(early));
    const before = await as("granted").run("reflectionList.listForDay", { day: "today" });
    check("...and the screen says so, with no box to tick yet",
      before.room && before.room.tick === false && /opens at Lunch/.test(before.room.why) && before.room.closeRoom === false, J(before.room));

    clock.set(la(TUE, "12:35"));
    const refusedTeacher = await as("teacher").run("reflectionRoom.markRoom", { unitId: unitOf("A")._id, notHere: true });
    check("a teacher cannot tick anyone", refusedTeacher.ok === false && !unitOf("A").roomNotHere);
    const tick = await as("granted").run("reflectionRoom.markRoom", { unitId: unitOf("A")._id, notHere: true });
    const done = await as("granted").run("reflectionRoom.roomAttendanceDone", { day: TUE });
    const audit = w.store.rows("reflectionAudit").filter((r) => r.day === TUE).map((r) => [r.action, r.byEmail]);
    check("a grant holder may tick Not here and press Attendance done; each is kept on the detention or the day, and in reflectionAudit",
      tick.ok && done.ok && unitOf("A").roomNotHere === true && unitOf("A").roomMarkedBy === "granted@school.test"
        && w.day(TUE).roomAttendanceDoneAt === la(TUE, "12:35") && w.day(TUE).roomAttendanceDoneBy === "granted@school.test"
        && J(audit) === J([["room-not-here", "granted@school.test"], ["room-attendance-done", "granted@school.test"]]), J({ tick, done, audit }));
    const screen = await as("pbis").run("reflectionList.listForDay", { day: "today" });
    const rowA = screen.sections[0].rows.find((r) => r.studentNumber === "A");
    check("the screen shows the tick, the count and who pressed Attendance done",
      rowA.notHere === true && screen.room.tick === true && screen.room.notHere === 1 && screen.room.doneBy === "granted@school.test"
        && screen.room.closeRoom === true, J(screen.room));
    check("...and no reflection code wrote appAuditLog", w.store.rows("appAuditLog").length === 0);

    await drive(w, la(TUE, "12:40"), la(TUE, "15:45"));
    const carryA = w.units("A").find((u) => u.kind === "carry");
    check("Attendance done: exactly the ticked row carries (A); C, marked absent at Power-Up but unticked, served",
      unitOf("A").state === "carried" && unitOf("A").carryBasis === "room" && carryA?.state === "pending"
        && /^Carried over from Tue 10\/13 \(at school: did not come\)$/.test(carryA.tags[0])
        && unitOf("C").state === "listed" && unitOf("C").carryBasis === "room" && unitOf("E").state === "listed",
      J({ A: unitOf("A"), carryA, C: unitOf("C") }));

    await drive(w, la(WED, "07:30"), la(WED, "11:45"));
    check("the carry lands on the next list, with its tag", unitOf("A", WED)?.kind === "carry" && unitOf("A", WED).state === "listed");
    clock.set(la(WED, "12:40"));
    const afterNext = await as("pbis").run("reflectionRoom.markRoom", { unitId: unitOf("C")._id, notHere: true });
    const doneAfter = await as("pbis").run("reflectionRoom.roomAttendanceDone", { day: TUE, done: false });
    check("a tick after the next freeze is refused: the next list has claimed the carries",
      afterNext.ok === false && /next list was made at 11:20 AM/.test(afterNext.reason) && !unitOf("C").roomNotHere
        && doneAfter.ok === false && !!w.day(TUE).roomAttendanceDoneAt, J({ afterNext, doneAfter }));
  }

  // ==========================================================================
  console.log("\n12. ROOM DID NOT RUN TODAY\n");
  // ==========================================================================
  {
    const TUE = "2026-10-13";
    const ms = { grade: 7, sections: MS };
    const w = await world({
      students: { A: ms, C: ms },
      days: [{ date: TUE, slots: TUE_SLOTS }],
      settings: { modeByDivision: { ms: "live", hs: "off" }, countFromDateByDivision: { ms: "2026-10-12", hs: null } },
    });
    const staff = {
      admin: { email: "admin@school.test", role: "admin" },
      granted: { email: "granted@school.test", role: "campusaide", reflectionList: true, reflectionListUntil: "2026-12-18" },
    };
    for (const t of Object.values(staff)) await w.store.db.insert("teachers", { name: "Staff", ticketsAwarded: 0, ...t });
    const as = (who) => { w.rt.signIn({ issuer: STAFF_ISSUER, email: staff[who].email }); return w.rt; };
    const unitOf = (sn) => w.units(sn).find((u) => u.serveDay === TUE);
    for (const sn of ["A", "C"]) w.mark(TUE, sn, 3, "T");
    await drive(w, la(TUE, "07:30"), la(TUE, "11:45"));
    // A's detention has already carried twice (from earlier lists).
    await w.store.db.patch(unitOf("A")._id, { carryCount: 2 });

    clock.set(la(TUE, "11:55"));
    const byGrant = await as("granted").run("reflectionRoom.roomDidNotRun", { day: TUE, reason: "no supervisor" });
    const noReason = await as("admin").run("reflectionRoom.roomDidNotRun", { day: TUE });
    check("Room did not run is the roles' alone, and needs a reason",
      byGrant.ok === false && /Only administrators and the PBIS team/.test(byGrant.reason) && noReason.ok === false && /Say why/.test(noReason.reason)
        && !w.day(TUE).roomClosed, J({ byGrant, noReason }));
    const closed = await as("admin").run("reflectionRoom.roomDidNotRun", { day: TUE, reason: "Supervisor out sick" });
    check("an admin may press it as soon as the list is made, before lunch, and it is recorded on the day and in reflectionAudit",
      closed.ok && w.day(TUE).roomClosed?.reason === "Supervisor out sick" && w.day(TUE).roomClosed.by === "admin@school.test"
        && w.store.rows("reflectionAudit").some((r) => r.action === "room-did-not-run" && r.day === TUE && r.reason === "Supervisor out sick"));
    await drive(w, la(TUE, "12:00"), la(TUE, "15:45"));
    const carries = w.units().filter((u) => u.kind === "carry");
    check("Room did not run carries everything with no carryCount increase",
      ["A", "C"].every((sn) => unitOf(sn).state === "carried" && unitOf(sn).carryBasis === "room-closed")
        && carries.length === 2 && carries.every((c) => c.state === "pending" && c.tags[0] === "Carried over from Tue 10/13 (room closed)")
        && carries.find((c) => c.studentNumber === "A").carryCount === 2 && carries.find((c) => c.studentNumber === "C").carryCount === 0,
      J(carries.map((c) => [c.studentNumber, c.carryCount, c.tags])));
  }

  // ==========================================================================
  console.log("\n13. THE REVIEW QUEUE'S DECISIONS, THE ADMIN BUTTONS AND THE HEALTH CARD\n");
  // ==========================================================================
  {
    const TUE = "2026-10-13", MON = "2026-10-12";
    const ms = { grade: 7, sections: MS };
    const w = await world({
      students: { A: ms, V: ms, V2: ms, U: ms },
      days: [{ date: MON, slots: MON_SLOTS }, { date: TUE, slots: TUE_SLOTS }],
      settings: { modeByDivision: { ms: "live", hs: "off" }, countFromDateByDivision: { ms: MON, hs: null } },
    });
    const staff = {
      admin: { email: "admin@school.test", role: "admin" },
      pbis: { email: "pbis@school.test", role: "pbis" },
      granted: { email: "granted@school.test", role: "campusaide", reflectionList: true, reflectionListUntil: "2026-12-18" },
    };
    for (const t of Object.values(staff)) await w.store.db.insert("teachers", { name: "Staff", ticketsAwarded: 0, ...t });
    const as = (who) => { w.rt.signIn({ issuer: STAFF_ISSUER, email: staff[who].email }); return w.rt; };

    // PowerSchool has TWO marks for V2's P2 on Tuesday: a collision, for review.
    w.mark(TUE, "V2", 3, "T"); w.mark(TUE, "V2", 3, "T");
    w.mark(MON, "V", 2, "T");
    await drive(w, la(TUE, "07:30"), la(TUE, "07:30"));
    const v2 = () => w.tardies("V2")[0];
    check("a collision goes to review", v2()?.state === "review" && /2 marks/.test(v2().reason), J(w.tardies("V2")));
    // Two more, as the reader would leave them: a very late Monday entry and
    // a detention whose carry hit the limit.
    const late = w.tardies("V")[0]._id;
    await w.store.db.patch(late, { state: "review", reason: "Entered after 5 lists were made", listsBeforeSeen: 5 });
    const limit = await w.store.db.insert("reflectionUnits", {
      studentNumber: "U", division: "ms", kind: "carry", tardyIds: [], uniformIds: [], lines: ["Mon 10/12: Tardy P1 (Ms Lee)"],
      recordedAt: la(MON, "15:45"), state: "review", serveDay: MON, mode: "live", carryCount: 5, tags: [], reviewReason: "Carried 5 times",
    });

    clock.set(la(TUE, "09:00"));
    const grantQ = await as("granted").run("reflectionRoom.reviewQueue", {});
    const q = await as("pbis").run("reflectionRoom.reviewQueue", {});
    check("the review queue is the roles' alone: a grant holder is refused it",
      grantQ.allowed === false && q.allowed === true && q.count === 3, J({ grantQ, n: q.count }));
    check("...each item with what it is about, why, its age in school days, and what may be done with it",
      J(q.items.map((i) => [i.kind, i.studentNumber, i.actions.join("+")])) === J([["detention", "U", "add+dismiss"], ["tardy", "V", "add+dismiss"], ["tardy", "V2", "add+dismiss"]])
        && q.items.find((i) => i.studentNumber === "V").lines[0] === "Mon 10/12: Tardy P1 (Ms Lee)"
        && q.items.find((i) => i.studentNumber === "V").ageSchoolDays === 1 && q.items.find((i) => i.studentNumber === "V2").ageSchoolDays === 0, J(q.items));

    const byGrant = await as("granted").run("reflectionRoom.resolveReview", { kind: "tardy", id: late, action: "add" });
    check("a resolve by a grant holder is refused, and changes nothing",
      byGrant.ok === false && w.tardies("V")[0].state === "review" && !w.tardies("V")[0].resolvedAt, J(byGrant));
    const bare = await as("pbis").run("reflectionRoom.resolveReview", { kind: "detention", id: limit, action: "dismiss" });
    check("Dismiss needs a reason", bare.ok === false && /reason/.test(bare.reason));

    const addLate = await as("pbis").run("reflectionRoom.resolveReview", { kind: "tardy", id: late, action: "add", reason: "Teacher was out; real tardy" });
    const tV = w.tardies("V")[0];
    check("Add to next list: a very late tardy becomes countable for the next freeze, the decision kept on the item",
      addLate.ok && tV.state === "countable" && !tV.unitId && tV.resolvedBy === "pbis@school.test" && tV.resolution === "added"
        && tV.resolutionReason === "Teacher was out; real tardy", J(tV));
    const addLimit = await as("pbis").run("reflectionRoom.resolveReview", { kind: "detention", id: limit, action: "add" });
    const uU = w.units("U").find((u) => u._id === limit), carryU = w.units("U").find((u) => u.carryFromUnitId === limit);
    check("Add to next list: a detention at the carry limit carries now, tagged, without counting toward the limit",
      addLimit.ok && uU.state === "carried" && uU.resolution === "added" && carryU?.state === "pending" && carryU.carryCount === 5
        && carryU.tags[0] === "Added to the next list by review (from Mon 10/12)", J({ uU, carryU }));
    const addV2 = await as("admin").run("reflectionRoom.resolveReview", { kind: "tardy", id: v2()._id, action: "add" });
    const auditRows = w.store.rows("reflectionAudit").filter((r) => /^review-/.test(r.action));
    check("every decision is written to reflectionAudit, never appAuditLog",
      addV2.ok && auditRows.length === 3 && auditRows.every((r) => r.byEmail && (r.tardyId || r.unitId)) && w.store.rows("appAuditLog").length === 0, J(auditRows));

    await drive(w, la(TUE, "09:30"), la(TUE, "09:30"));
    check("the reader respects the decision: the resolved collision is not sent back to review",
      v2().state === "countable" && v2().resolution === "added", J(v2()));
    const soFar = await as("pbis").run("reflectionList.listForDay", { day: "today" });
    check("...and both added tardies, and the added carry, are on today's list so far",
      ["U", "V", "V2"].every((sn) => soFar.sections[0].rows.some((r) => r.studentNumber === sn)), J(soFar.sections[0].rows.map((r) => r.studentNumber)));
    const after = await as("pbis").run("reflectionRoom.reviewQueue", {});
    check("the queue is empty once each item is decided", after.count === 0, J(after.items));

    // A day-level item: room attendance not recorded on a live day.
    const mon = await w.store.db.insert("reflectionDays", { date: "2026-10-09", readsDone: [], updatedAt: "x", schoolDay: true,
      frozenAt: la("2026-10-09", "11:45"), freezeKind: "closing",
      fallbackReview: { reason: "Room attendance not recorded Fri 10/9 (3 detentions decided from PowerSchool)", at: la("2026-10-09", "15:45") } });
    const flagged = await as("pbis").run("reflectionList.listForDay", { day: "today" });
    check("the roles see 'Room attendance not recorded' for the last list until it is acknowledged",
      flagged.banners.some((b) => b.id === "room-not-recorded" && /^Room attendance not recorded Fri 10\/9 \(3 detentions decided from PowerSchool\)\./.test(b.text)),
      J(flagged.banners.map((b) => b.id)));
    const addDay = await as("pbis").run("reflectionRoom.resolveReview", { kind: "day", id: mon, action: "add" });
    const okDay = await as("pbis").run("reflectionRoom.resolveReview", { kind: "day", id: mon, action: "dismiss", reason: "Supervisor forgot; told her" });
    check("a day's item can only be dismissed, with a reason, and then leaves the queue",
      addDay.ok === false && okDay.ok && (await as("pbis").run("reflectionRoom.reviewQueue", {})).count === 0
        && w.store.rows("reflectionDays").find((d) => d._id === mon).fallbackReview.resolvedBy === "pbis@school.test"
        && !(await as("pbis").run("reflectionList.listForDay", { day: "today" })).banners.some((b) => b.id === "room-not-recorded"), J({ addDay, okDay }));

    // ---- Read PowerSchool now, at 11:47: a closing read, which makes the list.
    clock.set(la(TUE, "11:41"));
    const nowByGrant = await as("granted").run("reflectionRoom.readNow", {});
    check("Read PowerSchool now is refused to a grant holder", nowByGrant.ok === false && /Only administrators/.test(nowByGrant.reason));
    clock.set(la(TUE, "11:47"));
    w.log.length = 0;
    const pressed = await as("admin").run("reflectionRoom.readNow", {});
    check("pressed by an admin between the close and ready - 4 minutes, it is a CLOSING read that makes the list",
      pressed.ok && pressed.kind === "closing" && pressed.makesList === true
        && w.rt.jobs.some((j) => j.path === "reflectionRead.read" && j.args.key === "closing" && j.args.freeze === "closing"), J(pressed));
    const again = await as("admin").run("reflectionRoom.readNow", {});
    check("...a second press while that read holds the lease is refused (never two readers)",
      again.ok === false && /already running/.test(again.reason), J(again));
    await runJobs(w, Date.parse(la(TUE, "11:48")));
    check("...and the read it booked made the list", w.day(TUE).frozenAt && w.day(TUE).freezeKind === "closing"
      && w.day(TUE).closingReadStartedAt === la(TUE, "11:47"), J({ f: w.day(TUE).frozenAt, k: w.day(TUE).freezeKind }));
    clock.set(la(TUE, "11:48"));
    const tooSoon = await as("pbis").run("reflectionRoom.readNow", {});
    check("...and it runs at most once every 2 minutes, whoever presses it", tooSoon.ok === false && /once every 2 minutes/.test(tooSoon.reason), J(tooSoon));
    check("each press is in reflectionAudit", w.store.rows("reflectionAudit").filter((r) => r.action === "read-now").length === 1);

    // ---- The health card.
    const hGrant = await as("granted").run("reflectionRoom.health", {});
    const health = await as("admin").run("reflectionRoom.health", {});
    check("the health card is the roles' alone, and names no student",
      hGrant.allowed === false && health.allowed === true && health.day.made === "11:47 AM" && health.day.freezeKind === "closing"
        && health.review.count === 0 && !/"studentNumber"|\b(A|V|V2|U)\b"/.test(J(health)) && Array.isArray(health.recent), J(health).slice(0, 400));
  }

  // ==========================================================================
  console.log("\n14. THIS IS A SCHOOL DAY, WHEN POWERSCHOOL CANNOT SAY SO\n");
  // ==========================================================================
  {
    const TUE = "2026-10-13";
    const w = await world({
      students: { A: { grade: 7, sections: MS } },
      days: [{ date: TUE, slots: TUE_SLOTS }],
      settings: { modeByDivision: { ms: "live", hs: "off" }, countFromDateByDivision: { ms: "2026-10-12", hs: null } },
    });
    await w.store.db.insert("teachers", { name: "Staff", ticketsAwarded: 0, email: "admin@school.test", role: "admin" });
    await w.store.db.insert("teachers", { name: "Staff", ticketsAwarded: 0, email: "granted@school.test", role: "campusaide", reflectionList: true });
    w.ctl.down = true;          // PowerSchool unreadable all morning
    await drive(w, la(TUE, "07:30"), la(TUE, "09:55"));
    clock.set(la(TUE, "10:00"));
    w.rt.signIn({ issuer: STAFF_ISSUER, email: "granted@school.test" });
    const byGrant = await w.rt.run("reflectionRoom.markSchoolDay", {});
    w.rt.signIn({ issuer: STAFF_ISSUER, email: "admin@school.test" });
    const marked = await w.rt.run("reflectionRoom.markSchoolDay", {});
    check("This is a school day: refused to a grant holder; an admin's press is recorded on the day and in reflectionAudit",
      byGrant.ok === false && marked.ok && w.day(TUE).adminMarkedSchoolDay === true && w.day(TUE).schoolDayMarkedBy === "admin@school.test"
        && w.store.rows("reflectionAudit").some((r) => r.action === "mark-school-day" && r.day === TUE), J({ byGrant, marked }));
    await drive(w, la(TUE, "10:05"), la(TUE, "12:00"));
    check("...so the list is made at the ready time without PowerSchool (the fallback), instead of no list",
      w.day(TUE).freezeKind === "fallback" && w.day(TUE).frozenAt === la(TUE, "12:00") && !w.day(TUE).noList, J({ k: w.day(TUE).freezeKind, n: w.day(TUE).noList }));
  }

  // ==========================================================================
  console.log("\n15. FROM THE PILOT TO LIVE OVER A WEEKEND: NOTHING FROM BEFORE REACHES THE FIRST LIVE LIST\n");
  // ==========================================================================
  // setMode parks what is waiting at the moment of the switch. Three things
  // become claimable only AFTER it, and each must still never be listed
  // (review, 2026-10-08): a Friday pilot detention whose carry is decided on
  // Monday, a Friday arrival Monday's re-read turns into a counted tardy,
  // and a Friday uniform entry that reaches the server on Monday.
  {
    const FRI = "2026-11-06", MON = "2026-11-09";
    const ms = { grade: 7, sections: MS };
    const w = await world({
      students: { A: ms, B: ms, E: ms },
      days: [{ date: FRI, slots: TUE_SLOTS }, { date: MON, slots: MON_SLOTS }],
      settings: { modeByDivision: { ms: "shadow", hs: "off" }, countFromDateByDivision: { ms: "2026-10-21", hs: null } },
    });
    await w.store.db.insert("teachers", { name: "Pat PBIS", ticketsAwarded: 0, email: "pbis@school.test", role: "pbis" });
    await w.store.db.insert("students", { studentNumber: "U1", firstName: "Una", lastName: "Test", grade: "7" });
    w.mark(FRI, "A", 3, "T");                                   // late to P2, at school all day: served on Friday's pilot list
    const bPt = w.mark(FRI, "B", 1, "A"), bP2 = w.mark(FRI, "B", 3, "A");
    w.mark(FRI, "B", 5, "T");                                   // absent at Promise Time and P2, late to P4: an arrival
    await drive(w, la(FRI, "07:30"), la(FRI, "15:45"));
    check("Friday's pilot list holds A (B arrived late to school), and A served it",
      J(w.listed(FRI)) === J(["A"]) && w.units("A")[0].mode === "shadow" && w.units("A")[0].state === "listed"
        && w.tardies("B")[0].state === "arrival", J({ l: w.listed(FRI), a: w.units("A"), b: w.tardies("B") }));
    clock.set(la(FRI, "17:00"));
    const live = await w.rt.run("reflection.setMode", { division: "ms", mode: "live", countFromDate: MON });
    check("MS goes live from Monday; nothing is waiting at the switch", live.ok && live.parked === 0, J(live));

    // Monday 07:00: A's Friday Power-Up and P6 absences are entered late, and
    // B's Friday absences are taken back.
    clock.set(la(MON, "07:00"));
    w.mark(FRI, "A", 9, "A"); w.mark(FRI, "A", 7, "A");
    w.unmark(bPt); w.unmark(bP2);
    w.mark(MON, "E", 2, "T");                                   // a Monday tardy: the live list's own
    await drive(w, la(MON, "07:30"), la(MON, "07:30"));
    const aCarry = w.units("A").find((u) => u.kind === "carry");
    check("a Friday pilot detention whose carry is decided on Monday, once MS is live, carries as before-start, never pending",
      w.units("A")[0].state === "carried" && aCarry?.state === "before-start" && aCarry.mode === "shadow", J(w.units("A")));
    check("a Friday arrival that Monday's re-read of Friday counts is before-start, never countable",
      w.tardies("B")[0].state === "before-start" && !w.tardies("B")[0].unitId, J(w.tardies("B")));
    clock.set(la(MON, "07:45"));
    w.rt.signIn({ issuer: STAFF_ISSUER, email: "pbis@school.test" });
    const queued = await w.rt.run("uniformViolations.log", { studentNumber: "U1", loanerProvided: false, attemptId: "q-fri", observedAt: Date.parse(la(FRI, "13:00")) });
    const uRow = w.store.rows("uniformViolations").find((x) => x.studentNumber === "U1");
    check("a queued Friday uniform entry that reaches the server on Monday, once MS counts from Monday, is stored before-start",
      queued.ok && uRow?.day === FRI && uRow.reflectionState === "before-start", J(uRow));
    await drive(w, la(MON, "07:35"), la(MON, "11:45"));
    check("Monday's first live list holds Monday's own tardy and nothing from the pilot: not A's carry, not B, not the Friday uniform entry",
      w.day(MON).freezeKind === "closing" && J(w.listed(MON)) === J(["E"]) && w.units("E")[0].mode === "live", J(w.listed(MON)));
  }

  // ==========================================================================
  console.log("\n16. A MARK DELETED AND TYPED BACK, A SECOND MARK FOR THE SAME PERIOD: ONE TARDY, ONE LIST\n");
  // ==========================================================================
  {
    const TUE = "2026-10-13", WED = "2026-10-14";
    const ms = { grade: 7, sections: MS };
    const w = await world({
      students: { Z2: ms, A2: ms, A3: ms },
      days: [{ date: TUE, slots: TUE_SLOTS }, { date: WED, slots: WED_SLOTS }],
      settings: { modeByDivision: { ms: "live", hs: "off" }, countFromDateByDivision: { ms: "2026-10-12", hs: null } },
    });
    const staff = { admin: { email: "admin@school.test", role: "admin" }, pbis: { email: "pbis@school.test", role: "pbis" } };
    for (const t of Object.values(staff)) await w.store.db.insert("teachers", { name: "Staff", ticketsAwarded: 0, ...t });
    const as = (who) => { w.rt.signIn({ issuer: STAFF_ISSUER, email: staff[who].email }); return w.rt; };
    const z2Row = w.mark(TUE, "Z2", 3, "T");
    w.mark(TUE, "A2", 3, "T");
    await drive(w, la(TUE, "07:30"), la(TUE, "11:45"));
    check("Tuesday's list holds Z2 and A2", J(w.listed(TUE)) === J(["A2", "Z2"]), J(w.listed(TUE)));

    // 12:05 Z2's mark is deleted; an admin reads PowerSchool at 12:10, before
    // the 12:31 pull, so Z2 is released before the room runs.
    clock.set(la(TUE, "12:05"));
    w.unmark(z2Row);
    clock.set(la(TUE, "12:10"));
    const now = await as("admin").run("reflectionRoom.readNow", {});
    await runJobs(w, Date.parse(la(TUE, "12:11")));
    check("released before the pull: Z2's detention is released at 12:10",
      now.ok && w.units("Z2")[0].state === "released" && w.units("Z2")[0].releasedAt === la(TUE, "12:10"), J({ now, u: w.units("Z2") }));
    // 12:58 a second T row for A2's same period, after the room ran.
    await drive(w, la(TUE, "12:15"), la(TUE, "15:45"), [
      [la(TUE, "12:58"), () => w.mark(TUE, "A2", 3, "T")],
      [la(TUE, "13:58"), () => w.mark(TUE, "Z2", 3, "T")],
    ]);
    const tA2 = w.tardies("A2");
    check("a second PowerSchool mark for a tardy already on a list leaves it on its detention: not sent to review, never on a second list",
      tA2.length === 1 && tA2[0].state === "countable" && tA2[0].unitId === w.units("A2")[0]._id && tA2[0].psRowIds.length === 2
        && !!tA2[0].collisionSeenAt && w.units("A2")[0].state === "listed", J({ tA2, u: w.units("A2") }));
    check("a mark deleted BEFORE the room ran and typed back is still owed: off its released detention, for the next list",
      w.tardies("Z2")[0].state === "countable" && !w.tardies("Z2")[0].unitId && w.units("Z2")[0].state === "released", J(w.tardies("Z2")));
    await drive(w, la(WED, "07:30"), la(WED, "11:20"));
    check("...so Wednesday's list holds Z2, and not A2",
      J(w.listed(WED)) === J(["Z2"]) && w.units("Z2").filter((u) => u.serveDay === WED).length === 1, J(w.listed(WED)));

    // An item already in review that sits on a standing detention: "Add to
    // next list" keeps it there, never on a second list.
    const u3 = await w.store.db.insert("reflectionUnits", { studentNumber: "A3", division: "ms", kind: "new", tardyIds: [], uniformIds: [],
      lines: ["Tue 10/13: Tardy P2 (Ms Ng)"], recordedAt: la(TUE, "11:45"), state: "listed", serveDay: TUE, mode: "live", carryCount: 0, tags: [] });
    const t3 = await w.store.db.insert("reflectionTardies", { studentNumber: "A3", attDate: TUE, periodId: 853, slot: 3, psRowIds: ["1", "2"], code: "T",
      division: "ms", state: "review", reason: "PowerSchool has 2 marks for this period", firstSeenAt: la(TUE, "11:45"), listsBeforeSeen: 0,
      lastSeenAt: la(TUE, "13:00"), unitId: u3 });
    clock.set(la(WED, "12:40"));
    const add = await as("pbis").run("reflectionRoom.resolveReview", { kind: "tardy", id: t3, action: "add" });
    const after3 = w.store.rows("reflectionTardies").find((t) => t._id === t3);
    check("Add to next list on a tardy already on a standing detention keeps it there",
      add.ok && after3.state === "countable" && after3.unitId === u3 && after3.resolution === "added", J(after3));
  }
  // AN ARRIVAL ROUND TRIP ON A DETENTION THAT STANDS (second review,
  // 2026-10-08). P's detention holds two tardies. One is deleted and typed
  // back, but by then a Promise Time absence makes it an arrival; the
  // absence is then taken back, and it counts again. Its detention stood the
  // whole time (it still held the other tardy), so it must stay on it: the
  // cleared branch dropped unitId for an arrival, and the next list served
  // the same tardy a second time.
  {
    const TUE = "2026-10-13", WED = "2026-10-14";
    const ms = { grade: 7, sections: MS };
    const w = await world({
      students: { P: ms },
      days: [{ date: TUE, slots: TUE_SLOTS }, { date: WED, slots: WED_SLOTS }],
      settings: { modeByDivision: { ms: "live", hs: "off" }, countFromDateByDivision: { ms: "2026-10-12", hs: null } },
    });
    const p3 = w.mark(TUE, "P", 3, "T");
    w.mark(TUE, "P", 5, "T");
    await drive(w, la(TUE, "07:30"), la(TUE, "11:45"));
    const unit = w.units("P")[0];
    const slot3 = () => w.tardies("P").find((t) => t.slot === 3);
    check("Tuesday's list holds P, one detention for both tardies",
      J(w.listed(TUE)) === J(["P"]) && w.units("P").length === 1 && unit.tardyIds.length === 2, J(w.units("P")));
    const seen = {};
    let pt;
    await drive(w, la(TUE, "11:50"), la(TUE, "15:45"), [
      [la(TUE, "12:40"), () => w.unmark(p3)],
      [la(TUE, "13:05"), () => { seen.cleared = { ...slot3() }; }],
      [la(TUE, "13:10"), () => { w.mark(TUE, "P", 3, "T"); pt = w.mark(TUE, "P", 1, "A"); }],
      [la(TUE, "14:05"), () => { seen.arrival = { ...slot3() }; }],
      [la(TUE, "14:30"), () => w.unmark(pt)],
      [la(TUE, "15:05"), () => { seen.back = { ...slot3() }; }],
    ]);
    check("...the deleted mark is cleared at 13:00 while the detention stands on the other tardy",
      seen.cleared.state === "cleared" && w.units("P")[0].state !== "released", J({ t: seen.cleared, u: w.units("P")[0].state }));
    check("typed back as an arrival, a tardy whose detention still stands stays on it",
      seen.arrival.state === "arrival" && seen.arrival.unitId === unit._id, J(seen.arrival));
    check("...and counting again, it is back on that same detention",
      seen.back.state === "countable" && seen.back.unitId === unit._id, J(seen.back));
    await drive(w, la(WED, "07:30"), la(WED, "11:20"));
    const holding = w.units("P").filter((u) => u.tardyIds.includes(slot3()._id) && u.state !== "expired" && u.state !== "released");
    check("an arrival round trip never puts one tardy on two lists: Wednesday's list does not hold P",
      w.day(WED).freezeKind === "closing" && !w.listed(WED).includes("P") && holding.length === 1 && holding[0]._id === unit._id,
      J({ wed: w.listed(WED), units: w.units("P").map((u) => [u.serveDay, u.state, u.tardyIds.length]) }));
  }

  // ==========================================================================
  console.log("\n17. A POWER-UP ABSENCE TAKEN BACK JUST BEFORE THE CLOSE\n");
  // ==========================================================================
  {
    const TUE = "2026-10-13", WED = "2026-10-14";
    const ms = { grade: 7, sections: MS };
    const w = await world({
      students: { K: ms, N: ms },
      days: [{ date: TUE, slots: TUE_SLOTS }, { date: WED, slots: WED_SLOTS }],
      settings: { modeByDivision: { ms: "shadow", hs: "off" }, countFromDateByDivision: { ms: "2026-10-12", hs: null } },
    });
    w.mark(TUE, "K", 3, "T");
    const kPu = w.mark(TUE, "K", 9, "A");
    w.mark(TUE, "K", 7, "A");
    w.mark(WED, "N", 2, "T");
    await drive(w, la(TUE, "07:30"), la(TUE, "15:45"));
    check("K, absent at Power-Up and P6, carries from Tuesday (pending)",
      w.units("K")[0].state === "carried" && w.units("K").find((u) => u.kind === "carry")?.state === "pending", J(w.units("K")));
    // 11:15 Wednesday, after the last pre-close read: K's Power-Up absence is
    // taken back. Only the 11:20 closing read sees it.
    await drive(w, la(WED, "07:30"), la(WED, "11:20"), [[la(WED, "11:15"), () => w.unmark(kPu)]]);
    const kCarry = w.units("K").find((u) => u.kind === "carry");
    check("the closing read decides yesterday's carry BEFORE it makes the list: K's carry is withdrawn, and K is not listed",
      w.day(WED).freezeKind === "closing" && J(w.listed(WED)) === J(["N"]) && kCarry?.state === "expired"
        && w.units("K")[0].state === "listed" && !w.units("K")[0].carriedToUnitId, J({ l: w.listed(WED), k: w.units("K") }));
  }

  // ==========================================================================
  console.log("\n18. THE LAST-READ BANNER ON A HEALTHY DAY, AND WHEN A READ FAILS\n");
  // ==========================================================================
  {
    const TUE = "2026-10-13";
    const w = await world({
      students: { A: { grade: 7, sections: MS } },
      days: [{ date: TUE, slots: TUE_SLOTS }],
      settings: { modeByDivision: { ms: "live", hs: "off" }, countFromDateByDivision: { ms: "2026-10-12", hs: null } },
    });
    await w.store.db.insert("teachers", { name: "Staff", ticketsAwarded: 0, email: "pbis@school.test", role: "pbis" });
    w.mark(TUE, "A", 3, "T");
    const seen = [];
    const look = (hhmm) => [la(TUE, hhmm), async () => {
      w.rt.signIn({ issuer: STAFF_ISSUER, email: "pbis@school.test" });
      const r = await w.rt.run("reflectionList.listForDay", { day: "today" });
      seen.push([hhmm, r.banners.find((b) => b.id === "last-read")]);
    }];
    const healthy = ["08:00", "08:20", "09:00", "09:20", "10:00", "10:50", "12:10", "12:35", "13:40", "14:30"];
    await drive(w, la(TUE, "07:30"), la(TUE, "15:10"), [
      ...healthy.map(look),
      [la(TUE, "14:55"), () => { w.ctl.down = true; }],          // the 15:00 read fails
      look("15:07"),
    ]);
    const levels = seen.filter(([t]) => healthy.includes(t));
    check("on a healthy day the last-read banner is never red between scheduled reads (08:00 to 14:30, all of lunch)",
      levels.length === healthy.length && levels.every(([, b]) => b && b.level === "info"), J(levels));
    check("...and it says when the next read is",
      levels.find(([t]) => t === "12:35")?.[1]?.text === "Last good PowerSchool read 11:45. Next read 1:00.", J(levels.find(([t]) => t === "12:35")));
    const failed = seen.find(([t]) => t === "15:07")?.[1];
    check("a read that failed turns it red at once", failed && failed.level === "alert" && /the latest read failed/.test(failed.text), J(failed));
  }

  // ==========================================================================
  console.log("\n19. MS LIVE, HS IN SHADOW: THE ROOM DECIDES ONLY THE LIVE DIVISION'S CARRIES\n");
  // ==========================================================================
  // The MS live week (spec 7): MS is pulled, HS stays in shadow as the
  // control. No room runs for HS, so its carries are PowerSchool's (spec 3.8
  // rule 3), whatever the room presses for MS (second review, 2026-10-08).
  {
    const MON = "2026-11-09", TUE = "2026-11-10";
    async function liveWeek(press) {
      const w = await world({
        // Ten HS fillers, absent everywhere, so HS's own Power-Up (slot 8) meets.
        students: { M1: { grade: 7, sections: MS }, HABS: { grade: 10, sections: HS }, HOK: { grade: 10, sections: HS },
          ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`HF${i}`, { grade: 10, sections: HS, filler: true }])) },
        days: [{ date: MON, slots: MON_SLOTS }, { date: TUE, slots: TUE_SLOTS }],
        settings: { modeByDivision: { ms: "live", hs: "shadow" }, countFromDateByDivision: { ms: MON, hs: MON } },
      });
      const staff = { admin: { email: "admin@school.test", role: "admin" }, pbis: { email: "pbis@school.test", role: "pbis" } };
      for (const t of Object.values(staff)) await w.store.db.insert("teachers", { name: "Staff", ticketsAwarded: 0, ...t });
      w.as = (who) => { w.rt.signIn({ issuer: STAFF_ISSUER, email: staff[who].email }); return w.rt; };
      w.mark(MON, "M1", 2, "T");                                 // MS, at school all day
      w.mark(MON, "HOK", 2, "T");                                // HS, at school all day
      const hooks = [
        [la(MON, "09:21"), () => w.mark(MON, "HABS", 2, "T")],   // HS: late to P1 ...
        [la(MON, "12:36"), () => w.mark(MON, "HABS", 8, "A")],   // ... absent at Power-Up ...
        [la(MON, "13:42"), () => w.mark(MON, "HABS", 6, "A")],   // ... and at P5: gone after lunch
      ];
      if (press) hooks.push(press(w));
      await drive(w, la(MON, "07:30"), la(MON, "15:45"), hooks);
      await drive(w, la(TUE, "07:30"), la(TUE, "11:45"));
      return w;
    }
    const carryOf = (w, sn) => w.units(sn).find((u) => u.serveDay === TUE);

    const none = await liveWeek(null);
    check("nothing pressed: HS H-ABS, absent at Power-Up and after it, carries to Tuesday through the PowerSchool fallback",
      J(none.listed(MON)) === J(["HABS", "HOK", "M1"]) && J(none.listed(TUE)) === J(["HABS"])
        && carryOf(none, "HABS")?.tags[0] === "Carried over from Mon 11/9 (absent)", J({ mon: none.listed(MON), tue: none.listed(TUE) }));
    check("...and the day's review counts only the LIVE detentions PowerSchool decided (1, not 3)",
      /^Room attendance not recorded Mon 11\/9 \(1 detention decided from PowerSchool\)$/.test(none.day(MON).fallbackReview?.reason || ""),
      J(none.day(MON).fallbackReview));

    let done = null;
    const pressed = await liveWeek((w) => [la(MON, "13:30"), async () => { done = await w.as("pbis").run("reflectionRoom.roomAttendanceDone", { day: MON }); }]);
    const habs = pressed.units("HABS").find((u) => u.serveDay === MON);
    check("Attendance done for the MS room, nobody ticked: H-ABS (HS, in shadow) still carries, decided by PowerSchool",
      done?.ok === true && J(pressed.listed(TUE)) === J(["HABS"]) && habs.carryBasis === "powerschool"
        && pressed.units("M1")[0].carryBasis === "room" && pressed.units("M1")[0].state === "listed",
      J({ done, tue: pressed.listed(TUE), habs: habs?.carryBasis, m1: pressed.units("M1")[0].carryBasis }));
    check("...and with Attendance done pressed, no day review is raised",
      !pressed.day(MON).fallbackReview, J(pressed.day(MON).fallbackReview));
    clock.set(la(TUE, "11:00"));

    let closed = null;
    const shut = await liveWeek((w) => [la(MON, "12:40"), async () => { closed = await w.as("admin").run("reflectionRoom.roomDidNotRun", { day: MON, reason: "Supervisor out" }); }]);
    check("Room did not run carries the live division's detentions only: M1 (room closed) and H-ABS (absent), never H-OK, who was in class all day",
      closed?.ok === true && J(shut.listed(TUE)) === J(["HABS", "M1"])
        && carryOf(shut, "M1")?.tags[0] === "Carried over from Mon 11/9 (room closed)"
        && carryOf(shut, "HABS")?.tags[0] === "Carried over from Mon 11/9 (absent)" && shut.units("HOK")[0].state === "listed",
      J({ closed, tue: shut.listed(TUE), hok: shut.units("HOK").map((u) => [u.serveDay, u.state, u.carryBasis]) }));

    // On screen: the room counts and ticks only the live division's rows.
    let monScreen = null;
    await liveWeek((w) => [la(MON, "12:45"), async () => {
      for (const sn of ["M1", "HABS"]) {
        await w.as("pbis").run("reflectionRoom.markRoom", { unitId: w.units(sn).find((u) => u.serveDay === MON)._id, notHere: true });
      }
      monScreen = await w.as("pbis").run("reflectionList.listForDay", { day: MON });
    }]);
    const modesOf = (div) => monScreen.sections.find((s) => s.division === div).rows.map((r) => r.mode);
    check("the room's Not here count takes only the live division's rows; HS rows come marked shadow, so the screen draws no box on them",
      monScreen.room?.tick === true && monScreen.room.notHere === 1 && modesOf("ms").every((m) => m === "live")
        && modesOf("hs").length === 2 && modesOf("hs").every((m) => m === "shadow"), J({ room: monScreen.room, ms: modesOf("ms"), hs: modesOf("hs") }));
  }

  // ==========================================================================
  console.log("\n20. COUNTED ONLY AFTER ITS OWN LIST WAS MADE: TAGGED ENTERED LATE\n");
  // ==========================================================================
  // Spec 3.10: an item that becomes countable after its own list was made
  // lands on the next list, tagged as entered late. Two such items were
  // SEEN before the close, so a tag judged by firstSeenAt never fired (second
  // review, 2026-10-08): an arrival re-judged as counted once the Promise
  // Time mark is corrected, a T changed to D before the close and back to T
  // after it, and a counted tardy re-judged an arrival and counted again.
  {
    const MON = "2026-12-07", TUE = "2026-12-08";
    const ms = { grade: 7, sections: MS };
    const w = await world({
      students: { MREJ: ms, MDT: ms, MBACK: ms },
      days: [{ date: MON, slots: MON_SLOTS }, { date: TUE, slots: TUE_SLOTS }],
      settings: { modeByDivision: { ms: "shadow", hs: "off" }, countFromDateByDivision: { ms: MON, hs: null } },
    });
    const recode = (id, code) => { w.fake.tables.attendance.find((r) => r.id === id).attendance_codeid = CODE[code]; };
    let pt, dt, bt;
    await drive(w, la(MON, "07:30"), la(MON, "15:45"), [
      [la(MON, "08:40"), () => { pt = w.mark(MON, "MREJ", 1, "A"); }],   // absent at Promise Time ...
      [la(MON, "09:20"), () => w.mark(MON, "MREJ", 2, "T")],             // ... so a T in P1 is an arrival
      [la(MON, "09:21"), () => { dt = w.mark(MON, "MDT", 2, "T"); }],
      [la(MON, "09:22"), () => w.mark(MON, "MBACK", 2, "T")],            // counted at 09:30 ...
      [la(MON, "10:00"), () => { recode(dt, "D"); bt = w.mark(MON, "MBACK", 1, "A"); }],   // excused; an arrival ...
      [la(MON, "12:30"), () => { recode(pt, "P"); recode(dt, "T"); recode(bt, "P"); }],     // ... all corrected after the close
    ]);
    check("neither is on Monday's list: one was an arrival, the other excused, when it was made",
      w.day(MON).freezeKind === "closing" && ["MREJ", "MDT", "MBACK"].every((sn) => !w.listed(MON).includes(sn) && w.tardies(sn)[0].state === "countable"),
      J({ mon: w.listed(MON), t: w.tardies().filter((t) => ["MREJ", "MDT", "MBACK"].includes(t.studentNumber)).map((t) => [t.studentNumber, t.state]) }));
    await drive(w, la(TUE, "07:30"), la(TUE, "11:45"));
    const tagsOf = (sn) => w.units(sn).find((u) => u.serveDay === TUE)?.tags;
    check("an arrival re-judged as counted after its list was made lands on the next list tagged 'Entered late in PowerSchool'",
      J(tagsOf("MREJ")) === J(["Entered late in PowerSchool (Mon 12/7 P1)"]), J(tagsOf("MREJ")));
    check("a T changed to D before the close and back to T after it is tagged the same way",
      J(tagsOf("MDT")) === J(["Entered late in PowerSchool (Mon 12/7 P1)"]), J(tagsOf("MDT")));
    check("...and so is a tardy counted, re-judged an arrival before the close, and counted again after it",
      J(tagsOf("MBACK")) === J(["Entered late in PowerSchool (Mon 12/7 P1)"]), J(tagsOf("MBACK")));
  }

  // ==========================================================================
  console.log("\nWIRING\n");
  // ==========================================================================
  {
    const crons = read("./convex/crons.ts");
    check("one cron tick, every 5 minutes 14:00-23:55 UTC, calling reflection.tick",
      /crons\.cron\(\s*"reflection tick",\s*"0,5,10,15,20,25,30,35,40,45,50,55 14-23 \* \* \*",\s*internal\.reflection\.tick,\s*\{\},?\s*\)/.test(crons));
    const off = await world({ students: {} });
    clock.set(la("2026-10-13", "11:45"));
    const t = await off.rt.run("reflection.tick", {});
    check("switched off (no settings row), the tick does nothing at all", t.do === "none" && off.rt.jobs.length === 0
      && off.store.rows("reflectionDays").length === 0 && /Switched off/.test(t.why), J(t));
    const src = read("./convex/reflection.ts") + read("./convex/reflectionRead.ts");
    check("every reflection function is internal: nothing here is reachable from a browser",
      !/export const \w+ = (query|mutation|action)\(/.test(src));
    check("no reflection code writes to appAuditLog", !/appAuditLog/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")));

    // EVERY convex/reflection*.ts, including the list screen's file. Every
    // staff browser downloads appAuditLog (auditLog.ts, script.js), so a line
    // there may say at most "Resolved 1 Reflection Room review item": never
    // which student, which detention or which tardy (spec 3.9, 4.7).
    const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const files = readdirSync(new URL("./convex/", import.meta.url)).filter((f) => /^reflection\w*\.ts$/.test(f));
    const inserts = [];
    for (const f of files) {
      const code = strip(read(`./convex/${f}`));
      for (const m of code.matchAll(/insert\(\s*["'`]appAuditLog["'`]/g)) {
        let depth = 0, k = code.indexOf("(", m.index);
        const start = k;
        for (; k < code.length; k++) { if (code[k] === "(") depth++; else if (code[k] === ")" && --depth === 0) break; }
        inserts.push({ f, text: code.slice(start, k + 1) });
      }
    }
    const IDENT = /\b(studentNumbers?|studentName|studentId|firstName|lastName|name|unitIds?|unitId|tardyIds?|uniformIds?)\b/;
    check("static: no appAuditLog insert from reflection code carries a student number, name or unit id",
      files.includes("reflectionList.ts") && inserts.every((x) => !IDENT.test(x.text)),
      inserts.filter((x) => IDENT.test(x.text)).map((x) => `${x.f}: ${x.text.slice(0, 120)}`).join(" | "));
    // EVERY public reflection function checks who is asking before it reads
    // a row: the list and the room's attendance with canReadReflection (the
    // roles and a grant), everything else with canAdminReflection (the roles
    // alone, never a grant).
    const READERS = { "reflectionList.ts": ["listForDay", "recordPrint"], "reflectionRoom.ts": ["markRoom", "roomAttendanceDone"] };
    const ADMINS = { "reflectionRoom.ts": ["roomDidNotRun", "reviewQueue", "resolveReview", "markSchoolDay", "readNow", "health"] };
    const gated = [];
    for (const f of ["reflectionList.ts", "reflectionRoom.ts"]) {
      const code = strip(read(`./convex/${f}`));
      const fns = [...code.matchAll(/export const (\w+) = (query|mutation|action)\(/g)].map((m) => m[1]);
      const want = [...(READERS[f] || []), ...(ADMINS[f] || [])];
      gated.push(J(fns.slice().sort()) === J(want.slice().sort()) && fns.every((n) => {
        const body = code.slice(code.indexOf(`export const ${n} =`));
        const gate = (READERS[f] || []).includes(n) ? body.indexOf("canReadReflection(staff, today)") : body.indexOf("canAdminReflection(staff)");
        return gate > 0 && gate < body.indexOf("requireStaff(ctx)") + 200
          && gate < body.search(/ctx\.db\.|getDay\(|loadSettings\(|roomStateOf\(|reviewItems\(|markedOf\(/);
      }) ? "ok" : `${f}: ${J(fns)}`);
    }
    check("the list's public functions are exactly these, and each checks who is asking (the roles, or a grant only where named) first",
      gated.every((g) => g === "ok"), J(gated));
    const pkg = JSON.parse(read("./package.json"));
    check("this test runs in npm test", /&& node reflection-reader\.test\.mjs\b/.test(pkg.scripts.test));
  }
} finally {
  clock.real();
  console.log = realLog;
  loaded.cleanup();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
