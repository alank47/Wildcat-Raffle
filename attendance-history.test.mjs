// Attendance is now a SERIES, not a single overwritten number. Run: npm test
//
// WHY THIS TABLE EXISTS. psAttendance holds exactly one row per student and
// every sync replaces it, so on 2026-09-20 all 679 students had a max of one
// observation and YTD equalled term for every one of them. A child with three
// absences was indistinguishable from a child who had three absences last week
// and none since -- and that difference is the entire content of an early
// warning system. This cannot be backfilled: a day not recorded is a day of
// trajectory permanently gone, which is why it shipped ahead of the indicator
// that will use it.
//
// THIS TEST RUNS THE REAL HANDLER. The uniform-violations miss on 2026-09-18
// was a temporal-dead-zone crash that 98 text-matching assertions all walked
// straight past, because reading source as a string cannot execute it. So the
// module below is transpiled and INVOKED against an in-memory database, and
// the ordering assertion is proved to have teeth by re-breaking the code.
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("./convex/sisStats.ts", import.meta.url), "utf8");
const schemaSrc = readFileSync(new URL("./convex/schema.ts", import.meta.url), "utf8");
let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

// Just this table: from its declaration to the start of whatever follows it.
const table = (() => {
  const head = "psAttendanceHistory: defineTable({";
  const i = schemaSrc.indexOf(head);
  if (i < 0) return "";
  const next = schemaSrc.indexOf("defineTable({", i + head.length);
  return schemaSrc.slice(i, next < 0 ? schemaSrc.length : schemaSrc.lastIndexOf("\n", next));
})();
// THE INDEXES THE SCHEMA ACTUALLY DECLARES, read out of it rather than
// restated here. The fake database below orders by these, so a test that
// walks an index walks it the way production will.
const INDEX_FIELDS = Object.fromEntries(
  [...table.matchAll(/\.index\("([^"]+)",\s*\[([^\]]*)\]\)/g)].map(([, name, cols]) => [
    name, cols.split(",").map((c) => c.trim().replace(/"/g, "")).filter(Boolean),
  ]),
);

// ---------------------------------------------------------------- the harness
// The shipped module, with Convex's wrappers stubbed so its handlers become
// plain async functions. Nothing is copied: a change to sisStats.ts changes
// what runs here.
function loadModule(transform) {
  let body = src
    .replace(/^import[^\n]*\n/gm, "")
    .replace(/^export (const|function) /gm, "$1 ");
  if (transform) body = transform(body);
  const stubs = `
    const internalMutation = (d) => d;
    const internalQuery = (d) => d;
    const v = new Proxy({}, { get: () => (...a) => ({ _v: true, a }) });
  `;
  const js = ts.transpileModule(stubs + body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(js + "\nreturn { attendanceMoved, putAttendance, seedAttendanceHistory, attendanceHistoryHealth };")();
}

// An in-memory Convex. collect()/take() hand back the SAME objects the table
// holds, exactly as a real read does, so a handler that patched before it
// compared would see its own write. That is what gives the ordering test below
// its teeth.
function makeDb(seed) {
  const tables = { psAttendance: (seed || []).map((r, i) => ({ ...r, _id: `a_${i + 1}` })), psAttendanceHistory: [] };
  let n = 0, reads = 0, writes = 0;
  const rowsOf = (t) => (tables[t] || (tables[t] = []));
  const reader = (get) => ({
    async first() { const r = get(); reads += 1; return r[0] || null; },
    async collect() { const r = get(); reads += r.length; return r.slice(); },
    async take(k) { const r = get().slice(0, k); reads += r.length; return r; },
    order(dir) { return reader(() => (dir === "desc" ? get().slice().reverse() : get())); },
    // Streaming, as Convex does it, so a handler that walks an index and
    // breaks early is charged only for what it actually pulled.
    async *[Symbol.asyncIterator]() { for (const r of get()) { reads += 1; yield r; } },
  });
  const ctx = {
    db: {
      query(t) {
        return {
          ...reader(() => rowsOf(t)),
          withIndex(name, fn) {
            const fields = INDEX_FIELDS[name];
            if (!fields) throw new Error(`the schema declares no index named ${name}`);
            const eqs = {};
            if (fn) { const q = { eq(f, val) { eqs[f] = val; return q; } }; fn(q); }
            return reader(() => rowsOf(t)
              .filter((r) => Object.entries(eqs).every(([k, val]) => r[k] === val))
              // Index order, ascending on the declared fields -- which is what
              // makes order("desc") mean "newest first" below.
              .sort((a, b) => {
                for (const f of fields) {
                  const x = a[f] === undefined ? "" : a[f], y = b[f] === undefined ? "" : b[f];
                  if (x < y) return -1;
                  if (x > y) return 1;
                }
                return 0;
              }));
          },
        };
      },
      async insert(t, doc) { writes += 1; const d = { ...doc, _id: `${t}_${++n}` }; rowsOf(t).push(d); return d._id; },
      async patch(id, p) {
        writes += 1;
        for (const t of Object.keys(tables)) { const r = tables[t].find((x) => x._id === id); if (r) Object.assign(r, p); }
      },
    },
  };
  return { ctx, tables, stats: () => ({ reads, writes }), zero() { reads = 0; writes = 0; } };
}

const mod = loadModule();
const { attendanceMoved, putAttendance, seedAttendanceHistory, attendanceHistoryHealth } = mod;
const at = (studentNumber, o) => ({ studentNumber, daysAbsentYtd: 0, daysAbsentTerm: 0, daysTardyTerm: 0, ...o });
const hist = (db, num) => db.tables.psAttendanceHistory.filter((r) => r.studentNumber === num);

console.log("\nthe change rule, exercised directly");

check("no prior is not a change", attendanceMoved(null, at("1")) === false);
check("undefined prior is not a change", attendanceMoved(undefined, at("1")) === false);
check("identical figures are not a change", attendanceMoved(at("1", { daysAbsentYtd: 4 }), at("1", { daysAbsentYtd: 4 })) === false);

// All three axes, on their own. A student who is present but always late never
// moves an absence count, and tardies are already a separate axis in
// Attendance Watch.
check("absences year-to-date moving is a change",
  attendanceMoved(at("1", { daysAbsentYtd: 3 }), at("1", { daysAbsentYtd: 4 })) === true);
check("absences this term moving is a change",
  attendanceMoved(at("1", { daysAbsentTerm: 1 }), at("1", { daysAbsentTerm: 2 })) === true);
check("TARDIES moving is a change, with no absence moving",
  attendanceMoved(at("1", { daysTardyTerm: 2 }), at("1", { daysTardyTerm: 3 })) === true);

// A correction is an event on a child's record, not noise to suppress.
check("a DECREASE is a change (PowerSchool corrected an absence)",
  attendanceMoved(at("1", { daysAbsentYtd: 5 }), at("1", { daysAbsentYtd: 4 })) === true);

// A field the SIS stops sending must not read as "changed to nothing" and
// append a row on every sync forever.
check("absent and zero compare equal",
  attendanceMoved({ studentNumber: "1", daysAbsentYtd: 0 }, { studentNumber: "1" }) === false);
check("undefined and zero compare equal the other way",
  attendanceMoved({ studentNumber: "1" }, { studentNumber: "1", daysAbsentYtd: 0 }) === false);
check("a real figure appearing where there was none is a change",
  attendanceMoved({ studentNumber: "1" }, { studentNumber: "1", daysAbsentYtd: 2 }) === true);

console.log("\nthe sync handler, actually invoked");

{
  const db = makeDb([at("1001", { daysAbsentYtd: 3, daysAbsentTerm: 3, daysTardyTerm: 1 })]);
  const out = await putAttendance.handler(db.ctx, {
    syncedAt: "2026-09-21T13:05:00.000Z",
    rows: [at("1001", { daysAbsentYtd: 5, daysAbsentTerm: 5, daysTardyTerm: 1 })],
  });
  const h = hist(db, "1001");
  check("a moved figure appends exactly one history row", h.length === 1, `got ${h.length}`);
  check("the appended row carries the NEW observation", h[0] && h[0].daysAbsentYtd === 5);
  check("observedOn is the sync's date", h[0] && h[0].observedOn === "2026-09-21", h[0] && h[0].observedOn);
  check("syncedAt is kept in full so clock skew stays visible", h[0] && h[0].syncedAt === "2026-09-21T13:05:00.000Z");
  check("a change is not marked baseline", h[0] && h[0].baseline === undefined);
  check("the live psAttendance row is still overwritten", db.tables.psAttendance[0].daysAbsentYtd === 5);
  check("the count is reported back", out.historyAppended === 1 && out.updated === 1, JSON.stringify(out));
}

{
  const db = makeDb([at("1001", { daysAbsentYtd: 3 })]);
  await putAttendance.handler(db.ctx, { syncedAt: "2026-09-21T13:05:00.000Z", rows: [at("1001", { daysAbsentYtd: 3 })] });
  check("an unchanged student appends nothing", hist(db, "1001").length === 0);
}

{
  // A student the app has never seen gets their starting point now, rather
  // than a series that begins at their second observation.
  const db = makeDb([]);
  const out = await putAttendance.handler(db.ctx, { syncedAt: "2026-09-21T13:05:00.000Z", rows: [at("2002", { daysAbsentYtd: 7 })] });
  const h = hist(db, "2002");
  check("a brand new student gets a baseline point", h.length === 1 && h[0].baseline === true);
  check("the baseline carries their figures", h[0] && h[0].daysAbsentYtd === 7);
  check("and they are created in psAttendance too", out.created === 1 && db.tables.psAttendance.length === 1);
}

{
  // The whole point of comparing against the collect: history costs nothing.
  const seed = Array.from({ length: 50 }, (_, i) => at(`s${i}`, { daysAbsentYtd: i }));
  const db = makeDb(seed);
  db.zero();
  await putAttendance.handler(db.ctx, {
    syncedAt: "2026-09-21T13:05:00.000Z",
    rows: seed.map((r) => at(r.studentNumber, { daysAbsentYtd: r.daysAbsentYtd + 1 })),
  });
  check("ZERO extra reads: the one collect and nothing else", db.stats().reads === 50, `${db.stats().reads} reads`);
  check("all 50 moved students got a row", db.tables.psAttendanceHistory.length === 50);
}

{
  // ORDER MATTERS, AND THE HARNESS CAN SEE IT. collect() hands back live rows,
  // so a handler that overwrote psAttendance before it compared would be
  // reading its own write and every change would silently vanish. Inject
  // exactly that mistake -- the overwrite moved up one statement -- and prove
  // the assertions above would have caught it.
  const broken = loadModule((body) => {
    const anchor = "      const prior = byNumber.get(r.studentNumber);";
    if (!body.includes(anchor)) throw new Error("could not find the loop head to re-break");
    return body.replace(anchor, anchor + "\n      if (prior) { await ctx.db.patch(prior._id, { ...r, syncedAt }); }");
  });
  const db = makeDb([at("1001", { daysAbsentYtd: 3 })]);
  const out = await broken.putAttendance.handler(db.ctx, {
    syncedAt: "2026-09-21T13:05:00.000Z",
    rows: [at("1001", { daysAbsentYtd: 9 })],
  });
  check("TEETH: overwriting before the compare loses the change entirely",
    hist(db, "1001").length === 0 && out.historyAppended === 0,
    "the append is not actually ordered before the overwrite");
}

console.log("\nthe one-off seeder, actually invoked");

{
  const seed = Array.from({ length: 5 }, (_, i) => ({ ...at(`s${i}`, { daysAbsentYtd: i }), syncedAt: "2026-09-20T09:00:00.000Z" }));
  const db = makeDb(seed);
  const dry = await seedAttendanceHistory.handler(db.ctx, {});
  check("a dry run writes nothing", db.tables.psAttendanceHistory.length === 0);
  check("a dry run still counts the work", dry.seeded === 5 && dry.applied === false, JSON.stringify(dry));
  check("a dry run does not claim to be done", dry.remaining === 5, String(dry.remaining));

  const run = await seedAttendanceHistory.handler(db.ctx, { apply: true });
  check("apply seeds every student on file", db.tables.psAttendanceHistory.length === 5 && run.seeded === 5);
  check("seeded rows are marked baseline", db.tables.psAttendanceHistory.every((r) => r.baseline === true));
  check("seeded rows date from their own sync, not today", db.tables.psAttendanceHistory.every((r) => r.observedOn === "2026-09-20"));
  check("apply reports nothing remaining", run.remaining === 0, String(run.remaining));

  const again = await seedAttendanceHistory.handler(db.ctx, { apply: true });
  check("RUNNING IT TWICE IS HARMLESS", db.tables.psAttendanceHistory.length === 5 && again.seeded === 0);
  check("and it says why", again.alreadyHad === 5);
}

{
  // A student with a real series must never be flattened by a late reseed.
  const db = makeDb([{ ...at("3003", { daysAbsentYtd: 9 }), syncedAt: "2026-09-21T09:00:00.000Z" }]);
  db.tables.psAttendanceHistory.push({ _id: "h1", studentNumber: "3003", observedOn: "2026-09-01", daysAbsentYtd: 1, syncedAt: "2026-09-01T09:00:00.000Z" });
  const out = await seedAttendanceHistory.handler(db.ctx, { apply: true });
  check("a student who already has history is skipped", out.seeded === 0 && out.alreadyHad === 1);
  check("their real series is untouched", db.tables.psAttendanceHistory.length === 1 && db.tables.psAttendanceHistory[0].daysAbsentYtd === 1);
}

{
  const db = makeDb([at("1"), at("2")]);
  const out = await seedAttendanceHistory.handler(db.ctx, { apply: true, limit: 1 });
  check("limit is honoured", out.seeded === 1 && db.tables.psAttendanceHistory.length === 1);
  check("and the rest is reported as remaining", out.remaining === 1, String(out.remaining));
}

{
  // NO SILENT CAP. take(1000) is a read-limit guard; if the table outgrows it
  // the rows past 1000 are invisible here and must be said out loud.
  const db = makeDb(Array.from({ length: 1000 }, (_, i) => at(`b${i}`)));
  const out = await seedAttendanceHistory.handler(db.ctx, {});
  check("a table at the page cap is flagged, not silently truncated", out.truncated === true);
  check("and the note says so in words", /PARTIAL/.test(String(out.note)));

  const small = await seedAttendanceHistory.handler(makeDb([at("1")]).ctx, {});
  check("a normal-sized table is not flagged", small.truncated === false);
}

console.log("\nthe health read-back");

// A series is only worth having if somebody would notice it stopping.
const hrow = (studentNumber, observedOn, o) => ({ studentNumber, observedOn, daysAbsentYtd: 1, syncedAt: observedOn + "T09:00:00.000Z", ...o });

{
  const db = makeDb([]);
  db.tables.psAttendanceHistory.push(
    { _id: "h1", ...hrow("1", "2026-09-14", { baseline: true }) },
    { _id: "h2", ...hrow("2", "2026-09-14", { baseline: true }) },
    { _id: "h3", ...hrow("1", "2026-09-18") },
    { _id: "h4", ...hrow("2", "2026-09-21") },
    { _id: "h5", ...hrow("3", "2026-09-21") },
  );
  const out = await attendanceHistoryHealth.handler(db.ctx, {});
  check("it reports the newest day it can see", out.newestDay === "2026-09-21", String(out.newestDay));
  check("days come back newest first", out.days.map((d) => d.observedOn).join(",") === "2026-09-21,2026-09-18,2026-09-14",
    out.days.map((d) => d.observedOn).join(","));
  check("it counts distinct students", out.studentsSeen === 3, String(out.studentsSeen));
  check("CHANGES are told apart from one-off baselines", out.changesScanned === 3 && out.baselinesScanned === 2,
    `${out.changesScanned}/${out.baselinesScanned}`);
  check("per-day rows add up", out.days[0].rows === 2 && out.days[2].baselines === 2);
  check("a complete scan does not claim to be partial", out.capped === false && !/PARTIAL/.test(out.note));
}

{
  const db = makeDb([]);
  db.tables.psAttendanceHistory.push({ _id: "h1", ...hrow("1", "2026-09-01") });
  const out = await attendanceHistoryHealth.handler(db.ctx, {});
  check("one day of data reports that one day", out.daysWithData === 1 && out.newestDay === "2026-09-01");
}

{
  const db = makeDb([]);
  const out = await attendanceHistoryHealth.handler(db.ctx, {});
  check("an empty table answers null rather than throwing", out.newestDay === null && out.daysWithData === 0);
}

{
  // It must stop as soon as it has the days asked for, not read the year.
  const db = makeDb([]);
  let n = 0;
  for (const day of ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22"]) {
    for (let k = 0; k < 10; k++) db.tables.psAttendanceHistory.push({ _id: `h${++n}`, ...hrow(`s${k}`, day) });
  }
  db.zero();
  const out = await attendanceHistoryHealth.handler(db.ctx, { days: 2 });
  check("asking for 2 days returns 2 days", out.daysWithData === 2, String(out.daysWithData));
  check("and it walks away early instead of reading the whole year",
    db.stats().reads <= 21 && out.scanned === 20, `${db.stats().reads} reads, scanned ${out.scanned}`);
}

{
  // NO SILENT CAP, again: an over-long scan says so rather than presenting a
  // half-read oldest day as fact.
  const db = makeDb([]);
  let n = 0;
  for (let d = 1; d <= 40; d++) {
    const day = `2026-09-${String(d).padStart(2, "0")}`;
    for (let k = 0; k < 100; k++) db.tables.psAttendanceHistory.push({ _id: `h${++n}`, ...hrow(`s${k}`, day) });
  }
  const out = await attendanceHistoryHealth.handler(db.ctx, { days: 60 });
  check("hitting the scan cap is reported, not hidden", out.capped === true && /PARTIAL/.test(out.note));
  check("and the scan really is bounded", out.scanned === 3000, String(out.scanned));
}

{
  const db = makeDb([]);
  db.tables.psAttendanceHistory.push({ _id: "h1", ...hrow("1", "2026-09-01") });
  const wild = await attendanceHistoryHealth.handler(db.ctx, { days: 9999 });
  check("an absurd days argument is clamped", wild.daysWithData === 1);
  const zero = await attendanceHistoryHealth.handler(db.ctx, { days: 0 });
  check("a zero days argument still returns something", zero.daysWithData === 1);
}

console.log("\nthe table itself");

check("psAttendanceHistory is declared in the schema", table.length > 0);
check("it keys on studentNumber, matching every other SIS table", /studentNumber: v\.string\(\)/.test(table));
check("observedOn is required, so a row cannot land undated", /observedOn: v\.string\(\)/.test(table));
check("the per-student index exists, for one child's series", /\.index\("by_student", \["studentNumber"\]\)/.test(table));
check("the per-student-per-day index exists, for dedup and ranges",
  /\.index\("by_student_observedOn", \["studentNumber", "observedOn"\]\)/.test(table));
check("the per-day index exists, for a whole-school snapshot", /\.index\("by_observedOn", \["observedOn"\]\)/.test(table));
check("it does NOT touch the students table or any balance",
  !/balance|wildcatCash|earned|spent/i.test(table));

console.log(`\nattendance history: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
