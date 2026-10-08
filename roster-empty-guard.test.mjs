// The roster is never emptied by a bad read, and the Reflection Room list only
// copies a whole one. Run: npm test
//
// THE EMPTY-CLEAR GUARD (build spec 4.5). The PowerSchool sync replaces
// psRoster wholesale, so a roster query that came back empty -- a term id that
// no longer matches after the semester change, say -- used to wipe every class
// list and schedule in the app. Now the sync keeps what it has when the new
// read is empty or under half of it, and says so in syncRuns.
//
// THE SNAPSHOT. The list copies psRoster into reflectionRoster once a day, and
// only a clean, whole roster: the sync that wrote it finished, every row has
// one syncedAt, and at least 90% as many students as the last snapshot.
//
// IT RUNS THE SHIPPED CODE: sisAction.syncFromPowerSchool and the psSync
// mutations against an in-memory Convex and a fake PowerSchool that answers
// the named queries; reflection.writeRosterSnapshot against the same.
//
// TEETH: scripts/reflection-teeth.mjs removes the guard and requires "an empty
// roster read keeps the roster" to FAIL, and breaks the snapshot's mixed-sync
// and 90% checks the same way.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { clock, loadConvex, makeDb, runtime } from "./fake-convex.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const schemaSrc = read("./convex/schema.ts");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const J = (x) => JSON.stringify(x);

const loaded = await loadConvex(new URL("./", import.meta.url), ["sisAction", "psSync", "syncLog", "reflection", "rosterGuardRules", "reflectionRules", "seedTestRoster"]);
try {
  const { mods } = loaded;
  const G = mods.rosterGuardRules;
  const RR = mods.reflectionRules;

  console.log("\nTHE GUARD'S VERDICT\n");
  {
    check("an empty read never replaces a roster", !G.rosterReplaceVerdict({ incomingRows: 0, currentRows: 5466 }).replace);
    check("...and says why, with what was kept", /came back empty.*5466 roster rows/.test(G.rosterReplaceVerdict({ incomingRows: 0, currentRows: 5466 }).reason));
    check("a read at 40% of the roster here is not believed", !G.rosterReplaceVerdict({ incomingRows: 40, currentRows: 100 }).replace);
    check("a read at exactly half is believed (under half is the line)", G.rosterReplaceVerdict({ incomingRows: 50, currentRows: 100 }).replace);
    check("a read at 95% replaces it", G.rosterReplaceVerdict({ incomingRows: 95, currentRows: 100 }).replace);
    check("a read that GROWS the roster replaces it", G.rosterReplaceVerdict({ incomingRows: 300, currentRows: 100 }).replace);
    check("the first sync ever (nothing here yet) writes what it read", G.rosterReplaceVerdict({ incomingRows: 50, currentRows: 0 }).replace);
  }

  // ------------------------------------------------------------ the real sync
  const HOST = "ps.test";
  Object.assign(process.env, {
    PS_HOST: HOST, PS_SCHOOL_ID: "1817", PS_TERM_ID: "3601", PS_YEAR_TERM_ID: "3600", PS_YEAR_ID: "36",
    PS_CLIENT_ID: "id", PS_CLIENT_SECRET: "secret", PS_FINAL_GRADE_NAME: "S1", PS_STORE_CODE: "S1",
  });
  const rosterRow = (i) => ({
    student_number: String(20000 + Math.floor(i / 5)), first_name: "F", last_name: "L", grade_level: "7",
    section_id: `SEC-${i % 5}`, section_expression: `${(i % 5) + 2}(A-E)`, course_name: "Course",
    teacher_email: "t@school.test", teacher_first_name: "T", teacher_last_name: "Teacher", term_id: "3601",
  });
  /** PowerSchool answering the named queries: the roster with `n` rows, everything else empty. */
  const namedQueryServer = (n) => async (url) => {
    const u = new URL(url);
    const resp = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.pathname === "/oauth/access_token") return resp({ access_token: "tok" });
    const m = /^\/ws\/schema\/query\/[\w.]+\.(\w+)$/.exec(u.pathname);
    if (!m) throw new Error("unexpected " + u.pathname);
    const page = Number(u.searchParams.get("page")), size = Number(u.searchParams.get("pagesize"));
    const all = m[1] === "roster" ? Array.from({ length: n }, (_, i) => rosterRow(i)) : [];
    return resp({ record: all.slice((page - 1) * size, page * size) });
  };
  const stub = (ret) => ({ _kind: "internalMutation", handler: async () => ret });
  const stubs = {
    sisSync: { syncStudents: stub({ created: 0, updated: 0 }) },
    sisStats: {
      putAttendance: stub({}), replaceGrades: stub({ remaining: "none" }), replaceMissingWork: stub({ remaining: "none" }),
      replaceSectionPoints: stub({ moreToClear: false }), replaceAttendanceBySection: stub({ moreToClear: false }),
      replaceRestricted: stub({}),
    },
    studentEmail: { setStudentEmails: stub({ studentsWithEmail: 0, totalStudents: 0 }) },
  };
  /** A store holding `rows` roster rows from an earlier sync, and a sync that reads `incoming`. */
  async function syncWith(rows, incoming) {
    const store = makeDb(schemaSrc);
    for (let i = 0; i < rows; i++) {
      const r = rosterRow(i);
      await store.db.insert("psRoster", {
        studentNumber: r.student_number, firstName: "F", lastName: "L", gradeLevel: "7", sectionId: r.section_id,
        period: r.section_expression, syncedAt: "2026-10-07T19:00:00.000Z",
      });
    }
    const rt = runtime(store, { ...mods, ...stubs });
    globalThis.fetch = namedQueryServer(incoming);
    clock.set("2026-10-08T13:00:00.000Z");
    const summary = await rt.run("sisAction.syncFromPowerSchool", { reason: "test" });
    return { store, summary, roster: store.rows("psRoster"), runs: store.rows("syncRuns") };
  }

  console.log("\nTHE SYNC KEEPS THE ROSTER IT HAS ON A BAD READ\n");
  {
    const e = await syncWith(100, 0);
    check("an empty roster read keeps the roster",
      e.roster.length === 100 && e.roster.every((r) => r.syncedAt === "2026-10-07T19:00:00.000Z"), `rows ${e.roster.length}`);
    check("...and the run records rosterKept with the reason and what was there",
      e.summary.rosterKept === true && /came back empty/.test(e.summary.rosterKeptReason) && e.summary.rosterRowsBefore === 100
      && e.runs.length === 1 && e.runs[0].summary.rosterKept === true, J(e.summary));
    const low = await syncWith(100, 40);
    check("a roster read at 40% keeps the roster", low.roster.length === 100 && low.summary.rosterKept === true, `rows ${low.roster.length}`);
    const ok = await syncWith(100, 95);
    check("a roster read at 95% replaces it",
      ok.roster.length === 95 && ok.roster.every((r) => r.syncedAt === ok.summary.syncedAt) && ok.summary.rosterKept === false
      && ok.summary.rosterKeptReason === null, `rows ${ok.roster.length}`);
    const first = await syncWith(0, 50);
    check("the first sync into an empty table writes its rows", first.roster.length === 50 && first.summary.rosterKept === false);
    const big = await syncWith(4500, 4400);
    check("the count of what is here is paged, so a roster bigger than one page is counted whole",
      big.summary.rosterRowsBefore === 4500 && big.roster.length === 4400, J({ before: big.summary.rosterRowsBefore }));
    // TWO SYNCS THAT OVERLAPPED (the cron and a "Sync now") leave every row
    // twice, under two syncedAts. The guard measures the newest sync's rows,
    // so the next believable read still replaces the doubled roster (review,
    // 2026-10-08); measured against all of them it was kept for good.
    {
      const store = makeDb(schemaSrc);
      for (const at of ["2026-10-07T19:00:00.000Z", "2026-10-07T19:00:30.000Z"]) {
        for (let i = 0; i < 100; i++) {
          const r = rosterRow(i);
          await store.db.insert("psRoster", {
            studentNumber: r.student_number, firstName: "F", lastName: "L", gradeLevel: "7", sectionId: r.section_id,
            period: r.section_expression, syncedAt: at,
          });
        }
      }
      const rt = runtime(store, { ...mods, ...stubs });
      globalThis.fetch = namedQueryServer(95);
      clock.set("2026-10-08T13:00:00.000Z");
      const summary = await rt.run("sisAction.syncFromPowerSchool", { reason: "test" });
      const roster = store.rows("psRoster");
      check("a roster doubled by two overlapping syncs is replaced by the next believable read, not kept for good",
        roster.length === 95 && summary.rosterKept === false && summary.rosterRowsBefore === 200, J({ rows: roster.length, kept: summary.rosterKeptReason }));
    }
    // A SMALL GROUP NEWER THAN THE LAST SYNC (second review, 2026-10-08).
    // seedTestRoster.seedLawrencebTest -- run in production, and re-run after
    // each sync -- writes 6 TESTROSTER rows stamped "now". Measured against
    // the newest syncedAt's rows alone, those 6 became "the roster", and a
    // 30% read of the real one was believed: 70 real rows deleted. The
    // shipped seeder runs here, as it does in production.
    {
      const store = makeDb(schemaSrc);
      for (let i = 0; i < 100; i++) {
        const r = rosterRow(i);
        await store.db.insert("psRoster", {
          studentNumber: r.student_number, firstName: "F", lastName: "L", gradeLevel: "7", sectionId: r.section_id,
          period: r.section_expression, syncedAt: "2026-10-07T19:00:00.000Z",
        });
      }
      await store.db.insert("teachers", { name: "Lawrence Test", ticketsAwarded: 0, email: "lawrenceb@lapromisefund.org", role: "teacher" });
      const rt = runtime(store, { ...mods, ...stubs });
      clock.set("2026-10-07T21:00:00.000Z");
      const seeded = await rt.run("seedTestRoster.seedLawrencebTest", {});
      const testRows = store.rows("psRoster").filter((r) => r.schoolId === "TESTROSTER");
      globalThis.fetch = namedQueryServer(30);
      clock.set("2026-10-08T13:00:00.000Z");
      const summary = await rt.run("sisAction.syncFromPowerSchool", { reason: "test" });
      const roster = store.rows("psRoster");
      check("a test roster seeded after the last sync never becomes the roster the guard measures: a 30% read keeps the real one",
        seeded.ok && testRows.length === 6 && testRows.every((r) => r.syncedAt === "2026-10-07T21:00:00.000Z")
          && summary.rosterKept === true && summary.rosterRowsBefore === 106 && roster.length === 106
          && /30 rows against 100/.test(summary.rosterKeptReason),
        J({ rows: roster.length, kept: summary.rosterKept, why: summary.rosterKeptReason }));
    }
    const src = read("./convex/sisAction.ts");
    check("the guard sits before the clear: nothing is deleted until the new read is believed",
      src.indexOf("rosterReplaceVerdict(") > 0 && src.indexOf("rosterReplaceVerdict(") < src.indexOf("internal.psSync.clearRoster"));
  }

  // --------------------------------------------------------------- snapshot
  console.log("\nTHE LIST COPIES ONLY A WHOLE ROSTER\n");
  const TZ = "America/Los_Angeles";
  /** A psRoster for `n` students (grade 7, Power-Up in slot 9), stamped `syncedAt`, and the sync run that wrote it. */
  async function seedRoster(store, n, syncedAt, { finished = true, kept = false, from = 0 } = {}) {
    for (let s = from; s < from + n; s++) {
      for (const slot of [1, 2, 4, 9]) {
        await store.db.insert("psRoster", {
          studentNumber: String(30000 + s), firstName: "F", lastName: "L", gradeLevel: "7",
          sectionId: `S${slot}-${s % 3}`, period: `${slot}(A-E)`, courseName: slot === 9 ? (s === 0 ? "RSP A" : "Power Up 7") : "Class",
          teacherFirstName: "Pat", teacherLastName: `T${slot}`, syncedAt,
        });
      }
    }
    if (finished) await store.db.insert("syncRuns", { at: syncedAt, summary: { syncedAt, rosterKept: kept, rosterRows: n * 4 } });
  }
  /** What the opening read does: page psRoster, build the rows, hand them to the mutation. */
  async function snapshot(rt, extra = {}) {
    const rows = [];
    let cursor = null;
    for (;;) {
      const p = await rt.run("reflection.rosterPage", { cursor });
      rows.push(...p.rows);
      if (p.isDone) break;
      cursor = p.continueCursor;
    }
    const snaps = RR.rosterSnapshotRows(rows);
    return rt.run("reflection.writeRosterSnapshot", {
      rows: snaps, syncedAts: [...new Set(rows.map((r) => r.syncedAt))], studentCount: snaps.length, termId: "3601", ...extra,
    });
  }
  const fresh = async () => {
    const store = makeDb(schemaSrc);
    await store.db.insert("bellSettings", { key: "bell", timeZone: TZ, updatedAt: "2026-08-17T00:00:00Z" });
    return { store, rt: runtime(store, mods) };
  };
  {
    const { store, rt } = await fresh();
    clock.set("2026-10-13T14:30:00.000Z");   // 07:30 LA, the opening read
    await seedRoster(store, 30, "2026-10-13T13:00:05.000Z");
    const r = await snapshot(rt, { termEnd: "2026-12-18", termName: "S1" });
    const snap = store.rows("reflectionRoster");
    check("a whole roster from a finished sync is taken: one row per student", r.taken && snap.length === 30, J(r));
    const s0 = snap.find((x) => x.studentNumber === "30000");
    check("...with the Power-Up row (slot 9) and its flag, every slot's section, and no names",
      s0.puSlot === 9 && s0.puFlag === "RSP" && s0.division === "ms" && J(s0.enrolledSlots) === J([1, 2, 4, 9])
      && s0.sectionBySlot["2"] === "S2-0" && !("firstName" in s0) && !("lastName" in s0), J(s0));
    const status = await rt.run("reflection.rosterStatus", {});
    check("rosterStatus: today's snapshot, so no age banner", status.snapshot.snapDay === "2026-10-13" && status.banners.length === 0, J(status));

    // Two overlapping syncs (the cron and a "Sync now") both finished and left a doubled roster.
    await seedRoster(store, 30, "2026-10-14T13:00:07.000Z");
    clock.set("2026-10-14T14:30:00.000Z");
    const mixed = await snapshot(rt);
    check("the snapshot refuses mixed syncedAt (rows from two syncs)",
      !mixed.taken && /2 different syncs/.test(mixed.reason) && store.rows("reflectionRoster").every((x) => x.rosterSyncedAt === "2026-10-13T13:00:05.000Z"),
      J(mixed));
    const age = await rt.run("reflection.rosterStatus", {});
    check("...the old one stays, the refusal is recorded, and the list says how old it is",
      age.snapshot.lastRefusal && /2 different syncs/.test(age.snapshot.lastRefusal.reason)
      && age.banners.includes("Power-Up teachers from the 10/13 roster."), J(age));
  }
  {
    const { store, rt } = await fresh();
    clock.set("2026-10-13T14:30:00.000Z");
    await seedRoster(store, 30, "2026-10-13T13:00:05.000Z");
    await snapshot(rt);
    const s2 = await fresh();   // the next day: only 25 of 30 students came back
    for (const [k, rows] of Object.entries(store.tables)) if (k !== "psRoster" && k !== "syncRuns") s2.store.tables[k] = rows;
    clock.set("2026-10-14T14:30:00.000Z");
    await seedRoster(s2.store, 25, "2026-10-14T13:00:05.000Z");
    const low = await snapshot(s2.rt);
    check("the snapshot keeps the old one below 90% of the last snapshot's students",
      !low.taken && /25 students against 30/.test(low.reason) && s2.store.rows("reflectionRoster").length === 30, J(low));
    const s3 = await fresh();
    for (const [k, rows] of Object.entries(store.tables)) if (k !== "psRoster" && k !== "syncRuns") s3.store.tables[k] = rows;
    await seedRoster(s3.store, 28, "2026-10-14T13:00:05.000Z");
    const ok = await snapshot(s3.rt);
    check("...and takes one at 93%, dropping the students who left", ok.taken && s3.store.rows("reflectionRoster").length === 28, J(ok));
  }
  {
    const { store, rt } = await fresh();
    clock.set("2026-10-13T19:05:00.000Z");   // 12:05 PDT: the midday sync has emptied the roster and is refilling it
    await seedRoster(store, 30, "2026-10-13T13:00:05.000Z");
    await snapshot(rt);
    for (const r of store.rows("psRoster")) await store.db.delete(r._id);
    // 28 of 30 students are back so far: over the 90% line, so only "finished" stops it.
    await seedRoster(store, 28, "2026-10-13T19:00:03.000Z", { finished: false });
    const mid = await snapshot(rt);
    check("a roster mid-rebuild (its sync has not finished) is never copied",
      !mid.taken && /did not finish cleanly/.test(mid.reason) && store.rows("reflectionRoster").every((x) => x.rosterSyncedAt === "2026-10-13T13:00:05.000Z"), J(mid));
  }
  {
    const { store, rt } = await fresh();
    clock.set("2026-10-13T14:30:00.000Z");
    await seedRoster(store, 30, "2026-10-12T19:00:02.000Z");
    // This morning's sync read an empty roster and KEPT yesterday's: the roster is still whole.
    await store.db.insert("syncRuns", { at: "2026-10-13T13:00:09.000Z", summary: { syncedAt: "2026-10-13T13:00:09.000Z", rosterKept: true, rosterRows: 0 } });
    const r = await snapshot(rt);
    check("a roster the sync's guard kept is still whole, so the list takes it", r.taken && store.rows("reflectionRoster").length === 30, J(r));
  }

  console.log("\nTHE SEMESTER CHANGE\n");
  {
    const meta = { snapDay: "2026-12-21", termId: "3601", termEnd: "2026-12-18", termName: "S1" };
    const tb = (today, current) => RR.termBanner({ today, termEnd: meta.termEnd, termName: meta.termName, snapshotTermId: meta.termId, currentTermId: current });
    check("after the snapshot term's last day, with PS_TERM_ID unchanged, the banner says so",
      tb("2026-12-19", "3601") === "S1 roster ended 12/18: Power-Up teachers may be out of date until PS_TERM_ID is switched to the next term.",
      tb("2026-12-19", "3601"));
    check("...not on the term's last day itself", tb("2026-12-18", "3601") === null);
    check("...and not once PS_TERM_ID has been switched", tb("2027-01-11", "3602") === null);
    check("no term end known: no banner, never a guess", RR.termBanner({ today: "2027-01-11", termEnd: null, snapshotTermId: "3601", currentTermId: "3601" }) === null);

    const { store, rt } = await fresh();
    clock.set("2026-12-18T15:30:00.000Z");
    await seedRoster(store, 10, "2026-12-18T14:00:05.000Z");
    await snapshot(rt, { termEnd: "2026-12-18", termName: "S1" });
    clock.set("2027-01-11T15:30:00.000Z");   // first day of S2, nothing switched, no fresh snapshot
    process.env.PS_TERM_ID = "3601";
    const st = await rt.run("reflection.rosterStatus", {});
    check("rosterStatus on 1/11 shows the term banner AND the roster's age",
      st.banners.some((b) => /^S1 roster ended 12\/18/.test(b)) && st.banners.includes("Power-Up teachers from the 12/18 roster."), J(st.banners));
    process.env.PS_TERM_ID = "3602";
    const st2 = await rt.run("reflection.rosterStatus", {});
    check("...and drops the term banner once PS_TERM_ID is switched", !st2.banners.some((b) => /ended/.test(b)), J(st2.banners));
  }

  console.log("\nWIRING\n");
  {
    const pkg = JSON.parse(read("./package.json"));
    check("this test runs in npm test", /&& node roster-empty-guard\.test\.mjs\b/.test(pkg.scripts.test));
    check("...and the teeth script breaks its guards",
      /roster-empty-guard\.test\.mjs/.test(read("./scripts/reflection-teeth.mjs")));
    const schema = schemaSrc.replace(/\/\*[\s\S]*?\*\//g, "");
    check("reflectionRoster holds no student names", !/reflectionRoster: defineTable\(\{[^}]*(firstName|lastName|studentName)/.test(schema));
    check("the runbook says what a kept roster means", /rosterKept: true/.test(read("./docs/runbook.md")));
    // Compile check of the helper the sync now imports, so a typo cannot hide behind the stubs above.
    check("rosterGuardRules transpiles on its own", ts.transpileModule(read("./convex/rosterGuardRules.ts"), {}).outputText.includes("rosterReplaceVerdict"));
  }
} finally {
  clock.real();
  loaded.cleanup();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
