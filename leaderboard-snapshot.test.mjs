// The leaderboard's stored copy, end to end. Run: npm test
//
// WHY IT EXISTS (2026-10-13). leaderboard:cash read every student row -- each
// carrying that child's whole cash history -- on every portal open: 4.88 MiB
// a call and growing towards Convex's 16 MiB wall. It now ranks from one
// stored copy of what the ranking reads, rebuilt on a timetable, with the
// viewer's own row read live. These tests hold the shipped code to that:
//
//   1. with the copy served, a portal open reads one document and one roster
//      row, and NO student row (any students read throws here);
//   2. every viewer, every band, gets exactly the answer the live read gives;
//   3. every reason not to serve the copy (none, off, shadow, an old version,
//      a pilot without the viewer, a viewer it cannot place) ranks live;
//   4. the build keeps the lease, the switch and the drop guard; the kill
//      switch is one call; live needs a clean compare on record;
//   5. every mutation writes only appState and leaderboardSnapshots;
//   6. no status, compare or log line carries a fixture name or id.
//
// NOTHING IS COPIED. The shipped .ts files are transpiled and run through a
// require shim against fake-convex.mjs's in-memory database (real indexes
// from schema.ts), wrapped so every read and write is recorded. The guards'
// teeth are scripts/leaderboard-snapshot-teeth.mjs.
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { clock, makeDb, runtime } from "./fake-convex.mjs";

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const J = (x) => JSON.stringify(x);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const SCHEMA = read("./convex/schema.ts");

// ======================================================================
console.log("\n1. Static: what the new code may reach, and what may reach it");
{
  const blank = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
  const snapSrc = blank(read("./convex/leaderboardSnapshot.ts"));
  const exports = [...snapSrc.matchAll(/^export\s+(.*)$/gm)].map((m) => m[1]);
  check("leaderboardSnapshot.ts exports only internal functions",
    exports.length >= 10 && exports.every((e) => /^const \w+ = internal(Query|Mutation|Action)\(/.test(e)),
    exports.filter((e) => !/^const \w+ = internal(Query|Mutation|Action)\(/.test(e)).join(" | "));

  const mentions = [];
  for (const f of readdirSync(new URL("./convex/", import.meta.url))) {
    if (!f.endsWith(".ts") || f.endsWith(".d.ts") || f.includes(".test.")) continue;
    if (/\bleaderboardSnapshots\b/.test(read("./convex/" + f))) mentions.push(f);
  }
  check("only schema, leaderboard, leaderboardSnapshot and readHeadroom name the table",
    J(mentions.sort()) === J(["leaderboard.ts", "leaderboardSnapshot.ts", "readHeadroom.ts", "schema.ts"]), J(mentions));
  const client = read("./script.js");
  const viewsApp = read("./convex/views_app.ts");
  check("views_app.ts and script.js mention neither the table nor the module",
    !/leaderboardSnapshot/.test(client) && !/leaderboardSnapshot/.test(viewsApp));

  const board = read("./convex/leaderboard.ts");
  check("leaderboard.ts has no clock", !/Date\.now\(/.test(board) && !/new Date\(/.test(board));
  const page = snapSrc.slice(snapSrc.indexOf("export const compactPage"), snapSrc.indexOf("export const build"));
  check("compactPage pages fifty students at a time through the shared roster lookup",
    /\.query\("students"\)\.paginate\(\{[^}]*numItems: 50/.test(page) && /rosterHit\(/.test(page) && !/\.collect\(\)/.test(page));
  // THE CLIENT CONTRACT IS UNTOUCHED: no new stamp is needed because nothing
  // the browser sends or reads changed. Same call, same arguments.
  check("the portal still calls leaderboard:cash with the band and topN 10, unchanged",
    /convexQuery\('leaderboard:cash', \{ band: _wpBoardBand, topN: 10 \}/.test(client) &&
    /args: \{\n    band: v\.optional\(v\.string\(\)\),\n    topN: v\.optional\(v\.number\(\)\),\n  \},/.test(board));
}

// ---------------------------------------------------------------- the loader
// Each module is transpiled to CommonJS and evaluated with a require shim (the
// cash-award-command.test.mjs loader), so modules keep their own scopes.
// `console` is handed in, so every log line any module writes is captured.
const LOGS = [];
const ALL_LOGS = [];
const logLine = (...a) => { const line = a.map(String).join(" "); LOGS.push(line); ALL_LOGS.push(line); };
const captured = { log: logLine, warn: logLine, error: logLine, info: logLine };
let VIEWER = null;
function load() {
  const def = (kind) => (d) => ({ ...d, _kind: kind });
  const ref = (path) => new Proxy({}, { get: (_, k) => (typeof k === "symbol" ? undefined : path ? `${path}.${String(k)}` : ref(String(k))) });
  const stubs = {
    "./_generated/server": {
      query: def("query"), mutation: def("mutation"), action: def("action"),
      internalQuery: def("internalQuery"), internalMutation: def("internalMutation"), internalAction: def("internalAction"),
    },
    "./_generated/api": { internal: ref(""), api: ref("") },
    "convex/values": { v: new Proxy({}, { get: () => (...a) => ({ _v: true, a }) }) },
    // The viewer is whoever the test says is signed in: the real
    // requireStudentSelf resolves them from the token by email, which is
    // outside what this file tests (and is one read the copy cannot avoid).
    "./identity": { requireStudentSelf: async () => structuredClone(VIEWER) },
  };
  const cache = {};
  const req = (name) => {
    if (stubs[name]) return stubs[name];
    const key = name.replace(/^\.\//, "");
    if (cache[key]) return cache[key];
    const code = read(`./convex/${key}.ts`);
    const js = ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const module = { exports: {} };
    cache[key] = module.exports;
    new Function("require", "module", "exports", "console", js)(req, module, module.exports, captured);
    cache[key] = module.exports;
    return module.exports;
  };
  return {
    leaderboard: req("./leaderboard"),
    leaderboardSnapshot: req("./leaderboardSnapshot"),
    leaderboardRules: req("./leaderboardRules"),
    leaderboardSnapshotRules: req("./leaderboardSnapshotRules"),
  };
}

// ------------------------------------------------------- the recorded database
// fake-convex's database (real indexes, copies out, patch-to-undefined
// removes), with every read and write written down. `forbid` makes any read
// of a table throw, which is how "no students read" is proved rather than
// inferred.
function recorded(store) {
  const reads = [];
  const writes = [];
  const forbid = new Set();
  const tableOf = (id) => String(id).split(":")[0];
  const query = (t) => {
    if (forbid.has(t)) throw new Error(`test: a read of ${t} here is forbidden`);
    const inner = store.db.query(t);
    const entry = { table: t, index: null, terminal: null, numItems: null };
    const done = (terminal, p) => { entry.terminal = terminal; reads.push(entry); return p; };
    const b = {
      withIndex(name, f) { entry.index = name; inner.withIndex(name, f); return b; },
      order(o) { inner.order(o); return b; },
      first: () => done("first", inner.first()),
      unique: () => done("unique", inner.unique()),
      take: (n) => done(`take`, inner.take(n)),
      collect: () => done("collect", inner.collect()),
      paginate: (o) => { entry.numItems = o.numItems; return done("paginate", inner.paginate(o)); },
    };
    return b;
  };
  const db = {
    query,
    get: (id) => { reads.push({ table: tableOf(id), index: null, terminal: "get" }); return store.db.get(id); },
    insert: (t, doc) => { writes.push({ op: "insert", table: t }); return store.db.insert(t, doc); },
    patch: (id, f) => { writes.push({ op: "patch", table: tableOf(id) }); return store.db.patch(id, f); },
    replace: (id, d) => { writes.push({ op: "replace", table: tableOf(id) }); return store.db.replace(id, d); },
    delete: (id) => { writes.push({ op: "delete", table: tableOf(id) }); return store.db.delete(id); },
  };
  return { db, reads, writes, forbid, snapshot: store.snapshot, restore: store.restore };
}

// ------------------------------------------------------------------ the school
// Invented names and numbers, distinctive enough that finding one in any
// output is never a coincidence.
const TZ = "America/Los_Angeles";
const FIXTURE_TOKENS = [];
function seedSchool(store) {
  const add = (t, doc) => store.db.insert(t, doc);
  add("bellSettings", { key: "bell", timeZone: TZ, updatedAt: "2026-09-01T00:00:00.000Z" });
  add("syncRuns", { at: "2026-10-13T13:04:00.000Z", summary: { ok: true } });
  const grades = ["6", "7", "8", "9", "10", "11", "12", " 09 ", "K", undefined];
  const amounts = [120, 120, 80, 45, 45, 45, 300, 10, 0, null, 250, 60, 60, 15, 5, 0, undefined, 95, 20, 120];
  const ids = [];
  for (let i = 0; i < 60; i++) {
    const n = 1000 + i;
    const s = {
      legacyId: i % 7 === 3 ? undefined : `LBX${n}`,
      studentNumber: i === 17 ? undefined : `SNQ${n}`,
      firstName: i % 11 === 5 ? "Twin" : `Avalyn${n}`,
      lastName: i % 11 === 5 ? "Samesby" : `Brightwater${n}`,
      grade: grades[i % grades.length],
      email: `lbx${n}@students.example`,
      wildcatCashEarned: amounts[i % amounts.length],
      pbisTickets: 0, attendanceTickets: 0, academicTickets: 0, bigRaffleQualified: [],
      // A cash history on every row, as production has: what the copy avoids reading.
      wildcatCashTransactions: Array.from({ length: 6 }, (_, k) => ({ id: `t${n}_${k}`, amount: 5, notes: "x".repeat(120) })),
    };
    if (i === 40 || i === 41) s.legacyId = "LBXDUP";
    ids.push(add("students", s));
    for (const tok of [s.legacyId, s.studentNumber, s.firstName, s.lastName, s.email]) {
      if (tok && !["Twin", "Samesby"].includes(tok)) FIXTURE_TOKENS.push(tok);
    }
    // Enrolled: on the roster, unless they are one of the leavers.
    if (s.studentNumber && i % 9 !== 4) {
      for (const sec of ["A", "B"]) add("psRoster", { studentNumber: s.studentNumber, firstName: s.firstName, lastName: s.lastName, sectionId: `${sec}${n}` });
    }
  }
  FIXTURE_TOKENS.push("LBXDUP", "Twin Samesby");
  return ids;
}

function world() {
  const store = makeDb(SCHEMA);
  const ids = seedSchool(store);
  const rec = recorded(store);
  const mods = load();
  const rt = runtime(rec, mods);
  const S = mods.leaderboardSnapshotRules;
  const students = () => store.rows("students");
  const snapRows = () => store.rows("leaderboardSnapshots");
  const stateOf = () => S.stateOrEmpty(store.rows("appState").find((r) => r.key === S.STATE_KEY)?.value);
  const configure = (args) => rt.run("leaderboardSnapshot.configure", { actorName: "Test Admin", ...args });
  const runBuilds = async () => {
    const out = [];
    for (const job of rt.take("leaderboardSnapshot.build")) out.push(await rt.run(job.path, job.args));
    return out;
  };
  const cash = async (viewerRow, args) => {
    VIEWER = viewerRow;
    return rt.run("leaderboard.cash", args ?? { band: "academy", topN: 10 });
  };
  return { store, ids, rec, mods, rt, S, students, snapRows, stateOf, configure, runBuilds, cash };
}

// A school day: Tuesday 2026-10-13, 09:03 PDT.
const T0 = "2026-10-13T16:03:00.000Z";
const at = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60000).toISOString();
const ALL_WRITES = [];
const keepWrites = (w) => ALL_WRITES.push(...w.rec.writes);

// ======================================================================
console.log("\n2. Shadow builds the copy and serves nobody");
{
  clock.set(T0);
  const w = world();
  const off = await w.rt.run("leaderboardSnapshot.tick", {});
  check("switched off (no config row), the tick builds nothing", off.do === "none" && off.why === "off" &&
    w.rt.jobs.length === 0 && w.snapRows().length === 0);
  const c = await w.configure({ mode: "shadow" });
  check("configure shadow books a build straight away", c.ok === true && c.build === "build" && w.rt.jobs.length === 1, J(c));
  w.rec.reads.length = 0;
  const [b] = await w.runBuilds();
  const doc = w.snapRows()[0];
  check("the build is kept: one row, every student, served to nobody", b.ok === true && w.snapRows().length === 1 &&
    doc.rows.length === 60 && doc.serve === "none" && doc.why === "shadow", J(b));
  const studentReads = w.rec.reads.filter((r) => r.table === "students");
  check("a build reads students only in pages of 50, never one collect",
    studentReads.length === 2 && studentReads.every((r) => r.terminal === "paginate" && r.numItems === 50), J(studentReads));
  const enrolledLive = w.students().filter((s) => s.studentNumber && w.store.rows("psRoster").some((p) => p.studentNumber === s.studentNumber)).length;
  const st = w.stateOf();
  check("the state row counts rows, enrolled (the live definition), leavers and the shared id",
    st.lastOk.rows === 60 && st.lastOk.enrolled === enrolledLive && st.lastOk.leavers === 60 - enrolledLive &&
    st.lastOk.dupIds === 1 && st.serve === "none" && st.builtAt === doc.builtAt && st.lease === null, J(st.lastOk));
  check("no copy row holds a cash history, an email, or any field outside the validator",
    !J(doc).includes("wildcatCashTransactions") && !J(doc).includes("students.example") &&
    doc.rows.every((r) => Object.keys(r).every((k) => ["id", "enrolled", "firstName", "lastName", "grade", "wildcatCashEarned"].includes(k))));
  const v = w.students()[2];
  w.rec.reads.length = 0;
  await w.cash(v);
  check("in shadow a portal open ranks live (serve none)", w.rec.reads.some((r) => r.table === "students" && r.terminal === "collect"));
  keepWrites(w);
}

// ======================================================================
console.log("\n3. Served: one document, one roster row, and the live answer");
{
  clock.set(T0);
  const w = world();
  await w.configure({ mode: "shadow" });
  await w.runBuilds();
  const live = await w.configure({ mode: "live", acceptWithoutCompare: true });
  check("switched live (by an explicit override here): the copy is served to all", live.ok && w.snapRows()[0].serve === "all", J(live));

  const viewers = w.students();
  const me = viewers[0];
  w.rec.reads.length = 0;
  w.rec.forbid.add("students");
  let out = null, err = null;
  try { out = await w.cash(me); } catch (e) { err = e; }
  w.rec.forbid.delete("students");
  const shape = w.rec.reads.map((r) => `${r.table}.${r.index}.${r.terminal}`);
  check("WITH THE COPY SERVED, A PORTAL OPEN READS ONE DOCUMENT AND ONE ROSTER ROW, NO STUDENTS",
    !err && J(shape) === J(["leaderboardSnapshots.by_name.first", "psRoster.by_studentNumber.first"]),
    err ? String(err.message) : J(shape));
  check("  ...and answers in the same shape: bands, top, total, viewer",
    out && Array.isArray(out.top) && typeof out.total === "number" && out.viewer && J(out.bands.map((b) => b.key)) === J(["academy", "hs", "ms"]));

  // Every viewer, every band, both page sizes: the copy's answer, then the
  // same with the copy gone.
  const served = [];
  for (const v of viewers) for (const band of ["academy", "hs", "ms", "bogus"]) for (const topN of [10, 50]) {
    served.push({ v, band, topN, out: await w.cash(v, { band, topN }) });
  }
  const docId = w.snapRows()[0]._id;
  await w.store.db.delete(docId);
  w.rec.reads.length = 0;
  let differ = 0, first = "";
  for (const s of served) {
    const liveOut = await w.cash(s.v, { band: s.band, topN: s.topN });
    if (J(liveOut) !== J(s.out)) { differ++; first = first || `${s.band}/${s.topN}`; }
  }
  const studentsCollects = w.rec.reads.filter((r) => r.table === "students");
  check("EVERY VIEWER, EVERY BAND: THE COPY GIVES EXACTLY THE ANSWER THE LIVE READ GIVES",
    served.length === 480 && differ === 0, `${differ} differ, first ${first}`);
  check("  ...and the live read (the copy deleted) reads students once a call, as before",
    studentsCollects.length === served.length && studentsCollects.every((r) => r.terminal === "collect"));
  keepWrites(w);
}

// ======================================================================
console.log("\n4. Every reason not to serve the copy ranks live");
{
  clock.set(T0);
  const w = world();
  const viewers = w.students();
  const me = viewers[1];
  const wentLive = async (viewer) => {
    w.rec.reads.length = 0;
    LOGS.length = 0;
    const out = await w.cash(viewer);
    return { live: w.rec.reads.some((r) => r.table === "students" && r.terminal === "collect"), out, logs: LOGS.slice() };
  };
  check("no copy at all: live", (await wentLive(me)).live);
  await w.configure({ mode: "shadow" });
  await w.runBuilds();
  check("serve none (shadow): live", (await wentLive(me)).live);
  await w.configure({ mode: "live", acceptWithoutCompare: true });
  check("served to all: from the copy", !(await wentLive(me)).live);
  const doc = () => w.snapRows()[0];
  await w.store.db.patch(doc()._id, { version: 0 });
  check("a copy written by another version: live", (await wentLive(me)).live);
  await w.store.db.patch(doc()._id, { version: w.mods.leaderboardRules.LEADERBOARD_SNAPSHOT_VERSION });

  await w.configure({ mode: "pilot", pilotEmails: [viewers[5].email.toUpperCase(), "nobody@students.example"] });
  check("pilot: a viewer not on the list is live", (await wentLive(me)).live);
  check("pilot: the viewer on the list is served the copy", !(await wentLive(viewers[5])).live);
  const p = w.stateOf();
  check("  ...the pilot list holds the resolved id (stored, never returned)",
    J(doc().pilotIds) === J([viewers[5].legacyId]) && p.serve === "pilot");

  await w.configure({ mode: "live" , acceptWithoutCompare: true });
  const ghost = { ...viewers[3], legacyId: "LBXGHOST" };
  FIXTURE_TOKENS.push("LBXGHOST");
  const g = await wentLive(ghost);
  check("a viewer whose id changed since the build (viewer-unplaced): live",
    g.live && g.logs.some((l) => l === "leaderboard:cash live fallback: viewer-unplaced"), J(g.logs));
  const dup = viewers.find((s) => s.legacyId === "LBXDUP");
  const d = await wentLive(dup);
  check("a viewer whose id two rows share (viewer-duplicated): live",
    d.live && d.logs.some((l) => l === "leaderboard:cash live fallback: viewer-duplicated"));
  const leaks = (lines) => lines.filter((l) => FIXTURE_TOKENS.some((t) => l.includes(t)));
  check("each fallback's log line names the reason, never the student", leaks([...g.logs, ...d.logs]).length === 0);

  // A student added after the build is placed at the end, from the copy.
  const newId = await w.store.db.insert("students", {
    legacyId: "LBXNEW", studentNumber: "SNQNEW", firstName: "Avalyn9999", lastName: "Brightwater9999", grade: "9",
    email: "lbxnew@students.example", wildcatCashEarned: 70, pbisTickets: 0, attendanceTickets: 0, academicTickets: 0, bigRaffleQualified: [],
  });
  FIXTURE_TOKENS.push("LBXNEW", "SNQNEW", "Avalyn9999", "Brightwater9999");
  await w.store.db.insert("psRoster", { studentNumber: "SNQNEW", firstName: "x", lastName: "y", sectionId: "N1" });
  const nu = await w.store.db.get(newId);
  const n = await wentLive(nu);
  w.rec.reads.length = 0;
  await w.store.db.patch(doc()._id, { serve: "none" });
  const nLive = await w.cash(nu);
  check("a student added since the build is placed from the copy, and their answer is the live one",
    !n.live && J(n.out.viewer) === J(nLive.viewer) && n.out.viewer.rank !== null, J([n.out.viewer, nLive.viewer]));
  keepWrites(w);
}

// ======================================================================
console.log("\n5. The build's guards: the lease, the switch, the roster, one row");
{
  clock.set(T0);
  const w = world();
  await w.configure({ mode: "shadow" });
  const [job] = w.rt.take("leaderboardSnapshot.build");
  const leaseRun = w.stateOf().lease.runId;
  const args = (o) => ({
    runId: leaseRun, startedAt: T0, rows: [{ id: "r1", wildcatCashEarned: 5 }], newestCreationTime: 1, enrolled: 1,
    rosterSteady: true, syncAt: null, pageVersions: [w.mods.leaderboardRules.LEADERBOARD_SNAPSHOT_VERSION],
    pages: 1, tookMs: 1, estBytesRead: 1, ...(o || {}),
  });
  const wrong = await w.rt.run("leaderboardSnapshot.write", args({ runId: "lb_not_mine" }));
  check("write refuses a run that does not hold the lease, and writes nothing",
    wrong.ok === false && wrong.why === "not-the-lease" && w.snapRows().length === 0 && w.stateOf().lease?.runId === leaseRun, J(wrong));
  clock.set(at(T0, 11));
  const late = await w.rt.run("leaderboardSnapshot.write", args());
  check("write refuses once the lease has lapsed, and counts it as a failure",
    late.ok === false && late.why === "lease-expired" && w.snapRows().length === 0 && w.stateOf().firstFailAt !== null &&
    w.stateOf().lease === null, J(late));

  clock.set(at(T0, 15));
  await w.rt.run("leaderboardSnapshot.runNow", { actorName: "Test Admin" });
  const [job2] = w.rt.take("leaderboardSnapshot.build");
  await w.configure({ mode: "off" });
  const offRun = await w.rt.run(job2.path, job2.args);
  check("the kill switch beats a build already under way: write refuses when off",
    offRun.ok === false && offRun.why === "off" && w.snapRows().length === 0 && w.stateOf().lease === null, J(offRun));
  check("  ...and an off tick books nothing", (await w.rt.run("leaderboardSnapshot.tick", {})).do === "none" && w.rt.jobs.length === 0);

  // Each mode's build serves who it should.
  for (const [mode, serve] of [["shadow", "none"], ["pilot", "pilot"], ["live", "all"]]) {
    clock.advance(20 * 60000);
    await w.configure({ mode, acceptWithoutCompare: true });
    await w.rt.run("leaderboardSnapshot.runNow", { actorName: "Test Admin" });
    const [r] = await w.runBuilds();
    check(`a build in ${mode} is served to ${serve}`, r.ok && w.snapRows()[0].serve === serve && w.stateOf().serve === serve, J(r));
  }

  // A second row (two writers past the lease) is removed by the next build.
  const extra = structuredClone(w.snapRows()[0]);
  delete extra._id; delete extra._creationTime;
  await w.store.db.insert("leaderboardSnapshots", extra);
  clock.advance(20 * 60000);
  await w.rt.run("leaderboardSnapshot.runNow", { actorName: "Test Admin" });
  await w.runBuilds();
  check("a second copy row is deleted by the next build: one row, always", w.snapRows().length === 1);

  // A roster replace that overlaps the build.
  clock.advance(20 * 60000);
  const before = w.snapRows()[0].buildId;
  await w.rt.run("leaderboardSnapshot.runNow", { actorName: "Test Admin" });
  const [job3] = w.rt.take("leaderboardSnapshot.build");
  const real = w.rt.actx.runQuery;
  let pagesSeen = 0;
  w.rt.actx.runQuery = async (ref, a) => {
    const out = await real(ref, a);
    if (String(ref).endsWith("compactPage") && ++pagesSeen === 1) {
      await w.store.db.insert("psRoster", { studentNumber: "SNQ1000", firstName: "x", lastName: "y", sectionId: "NEW" });
    }
    return out;
  };
  const moved = await w.rt.run(job3.path, job3.args);
  w.rt.actx.runQuery = real;
  check("a roster replace during the build: refused, the previous copy keeps serving",
    moved.ok === false && moved.why === "roster-moved" && w.snapRows()[0].buildId === before && w.snapRows()[0].serve === "all", J(moved));

  // A deploy that bumps the copy's version lands between a build's pages
  // (review, 2026-10-13): rows made by the old compactStudent must never be
  // kept under the new number, which the version gate would then serve.
  await w.rt.run("leaderboardSnapshot.runNow", { actorName: "Test Admin" });
  const [job5] = w.rt.take("leaderboardSnapshot.build");
  let pageNo = 0;
  w.rt.actx.runQuery = async (ref, a) => {
    const out = await real(ref, a);
    if (String(ref).endsWith("compactPage") && ++pageNo === 1) out.version -= 1;
    return out;
  };
  const straddled = await w.rt.run(job5.path, job5.args);
  w.rt.actx.runQuery = real;
  await w.rt.run("leaderboardSnapshot.runNow", { actorName: "Test Admin" });
  w.rt.take("leaderboardSnapshot.build");
  const bare = await w.rt.run("leaderboardSnapshot.write", {
    ...args({ runId: w.stateOf().lease.runId, startedAt: clock.iso, rows: w.snapRows()[0].rows, enrolled: w.stateOf().lastOk.enrolled }), pageVersions: undefined,
  });
  check("a build whose pages were made by another version of compactStudent is not kept (a deploy landed mid-build)",
    straddled.ok === false && straddled.why === "version-moved" && bare.ok === false && bare.why === "version-moved" &&
    w.snapRows()[0].buildId === before && w.snapRows()[0].serve === "all" && w.stateOf().lease === null, J([straddled, bare]));

  // A half-cleared roster (a sync that died): held, then kept when a later build agrees.
  const roster = w.store.rows("psRoster");
  for (const r of roster.slice(0, Math.floor(roster.length / 2))) await w.store.db.delete(r._id);
  clock.advance(20 * 60000);
  await w.rt.run("leaderboardSnapshot.runNow", { actorName: "Test Admin" });
  const [h] = await w.runBuilds();
  check("a half-cleared roster with no newer sync is held: the old copy serves on",
    h.ok === false && h.why === "drop-held" && w.snapRows()[0].buildId === before && w.stateOf().pendingDrop !== null, J(h));
  clock.advance(15 * 60000);
  check("  ...the tick waits for the re-read", (await w.rt.run("leaderboardSnapshot.tick", {})).why === "drop-wait");
  clock.advance(10 * 60000);
  const t = await w.rt.run("leaderboardSnapshot.tick", {});
  const [h2] = await w.runBuilds();
  check("  ...and a build 20 minutes on that agrees is kept", t.why === "drop-recheck" && h2.ok === true && h2.why === "drop-confirmed" &&
    w.stateOf().pendingDrop === null, J([t, h2]));

  // A build whose page read throws is recorded, with a code, and releases the lease.
  clock.set("2026-10-13T20:03:00.000Z");
  await w.rt.run("leaderboardSnapshot.runNow", { actorName: "Test Admin" });
  const [job4] = w.rt.take("leaderboardSnapshot.build");
  w.rec.forbid.add("students");
  LOGS.length = 0;
  const thrown = await w.rt.run(job4.path, job4.args);
  w.rec.forbid.delete("students");
  const sf = w.stateOf();
  check("a build that throws is recorded as a failure with a short code, and releases the lease",
    thrown.ok === false && sf.lastAttempt.why === "page-threw" && sf.lease === null && sf.firstFailAt !== null, J(sf.lastAttempt));
  check("  ...and its log line is numbers only", LOGS.length === 1 && /^\[leaderboardSnapshot\] \{("[a-zA-Z]+":-?\d+,?)+\}$/.test(LOGS[0]), J(LOGS));

  // ONE STUDENT ROW DELETED BY HAND (the duplicate behind a dupIds entry, say):
  // held, read again, and kept -- not refused for good (review, 2026-10-13).
  const victim = w.students().find((s) => s.legacyId === "LBXDUP");
  await w.store.db.delete(victim._id);
  clock.set("2026-10-13T20:18:00.000Z");
  await w.rt.run("leaderboardSnapshot.runNow", { actorName: "Test Admin" });
  const [r1] = await w.runBuilds();
  const servedOn = w.snapRows()[0].rows.length === 60 && w.snapRows()[0].serve === "all";
  clock.set("2026-10-13T20:43:00.000Z");
  const t2 = await w.rt.run("leaderboardSnapshot.tick", {});
  const [r2] = await w.runBuilds();
  check("a student row deleted by hand: the build is held, and one 20 minutes on that agrees is kept",
    r1.ok === false && r1.why === "rows-held" && servedOn && t2.why === "drop-recheck" && r2?.ok === true && r2.why === "rows-confirmed" &&
    w.snapRows()[0].rows.length === 59 && w.stateOf().lastOk.rows === 59 && w.stateOf().pendingDrop === null, J([r1, t2, r2]));
  keepWrites(w);
}

// ======================================================================
console.log("\n5b. Only a roster sync counts as a newer sync");
{
  // syncRuns also holds the hall-pass cleanup's rows (summary.job) and syncs
  // whose roster guard kept the old roster; neither replaced the roster, so
  // neither may excuse a half-cleared one (review, 2026-10-13).
  clock.set(T0);
  const w = world();
  await w.configure({ mode: "live", acceptWithoutCompare: true });
  await w.runBuilds();
  await w.store.db.insert("syncRuns", { at: "2026-10-13T16:40:00.000Z", summary: { job: "expireAbandoned", expired: 2, purged: 0 } });
  await w.store.db.insert("syncRuns", { at: "2026-10-13T16:45:00.000Z", summary: { reason: "manual", rosterKept: true } });
  // A "Sync now" that died after clearing half the roster: it writes no row.
  const roster = w.store.rows("psRoster");
  for (const r of roster.slice(0, Math.floor(roster.length / 2))) await w.store.db.delete(r._id);
  clock.set("2026-10-13T16:48:00.000Z");
  await w.rt.run("leaderboardSnapshot.tick", {});
  const [held] = await w.runBuilds();
  check("a hall-pass row or a kept-roster sync in syncRuns is not a newer sync: a half-cleared roster is still held",
    held?.ok === false && held.why === "drop-held" && w.stateOf().pendingDrop?.syncAt === "2026-10-13T13:04:00.000Z", J([held, w.stateOf().pendingDrop]));
  await w.store.db.insert("syncRuns", { at: "2026-10-13T16:50:00.000Z", summary: { reason: "scheduled", rosterKept: false } });
  clock.set("2026-10-13T16:52:00.000Z");
  await w.rt.run("leaderboardSnapshot.runNow", { actorName: "Test Admin" });
  const [kept] = await w.runBuilds();
  check("  ...while a real roster sync after it is", kept?.ok === true && kept.why === "drop-new-sync", J(kept));
  keepWrites(w);
}

// ======================================================================
console.log("\n6. The tick: cadence, sync windows, staleness, self-healing");
{
  clock.set(T0);
  const w = world();
  await w.configure({ mode: "live", acceptWithoutCompare: true });
  await w.runBuilds();
  check("live from off: the first build is served to all", w.snapRows()[0]?.serve === "all");
  clock.set(at(T0, 5));
  check("a board 5 minutes old in school hours is not rebuilt", (await w.rt.run("leaderboardSnapshot.tick", {})).do === "none");
  clock.set(at(T0, 15));
  check("  ...15 minutes old it is", (await w.rt.run("leaderboardSnapshot.tick", {})).do === "build" && w.rt.jobs.length === 1);
  check("  ...one build at a time: a second tick under the lease books nothing",
    (await w.rt.run("leaderboardSnapshot.tick", {})).why === "busy" && w.rt.jobs.length === 1);
  await w.runBuilds();
  clock.set("2026-10-13T19:03:30.000Z");
  check("at 19:03 UTC, while the sync replaces the roster, the tick builds nothing",
    (await w.rt.run("leaderboardSnapshot.tick", {})).why === "sync-window" && w.rt.jobs.length === 0);
  clock.set("2026-10-13T19:18:30.000Z");
  check("  ...at 19:18 it builds", (await w.rt.run("leaderboardSnapshot.tick", {})).do === "build");
  w.rt.take();

  // The booked build never ran (Convex stopped it): the lapsed lease is a failure.
  clock.set("2026-10-13T20:03:30.000Z");
  const lapsed = await w.rt.run("leaderboardSnapshot.tick", {});
  check("a lease that lapsed is counted as a failed build", lapsed.do === "build" && w.stateOf().firstFailAt === "2026-10-13T20:03:30.000Z" &&
    w.stateOf().lastAttempt.why === "lapsed" && w.stateOf().buildsByDay.some((d) => d.refusals > 0), J(lapsed));
  check("  ...dated when it was booked, which is when the backoff counts from",
    w.stateOf().lastAttempt.at === "2026-10-13T19:18:30.000Z", J(w.stateOf().lastAttempt));
  w.rt.take();
  // That one dies too. An hour of failure: stop serving.
  clock.set("2026-10-13T21:03:30.000Z");
  const failing = await w.rt.run("leaderboardSnapshot.tick", {});
  check("builds failing for an hour: the tick stops serving the copy (why failing)",
    failing.markStale === "failing" && w.snapRows()[0].serve === "none" && w.snapRows()[0].why === "failing", J(failing));
  w.rt.take();
  w.rec.reads.length = 0;
  await w.cash(w.students()[0]);
  check("  ...and the next portal open ranks live, with no refresh", w.rec.reads.some((r) => r.table === "students"));
  clock.set("2026-10-13T21:18:30.000Z");
  await w.rt.run("leaderboardSnapshot.runNow", { actorName: "Test Admin" });
  await w.runBuilds();
  check("  ...until a good build serves it again", w.snapRows()[0].serve === "all" && w.stateOf().firstFailAt === null);

  // Old: stale. (Off hours, so the tick also books a build; it is left to lapse.)
  const staleAt = at("2026-10-13T21:18:30.000Z", 781);
  clock.set(staleAt);
  const stale = await w.rt.run("leaderboardSnapshot.tick", {});
  check("a board 13 hours old is no longer served (why stale)",
    stale.markStale === "stale" && w.snapRows()[0].serve === "none" && w.snapRows()[0].why === "stale", J(stale));
  w.rt.take();

  clock.set(at(staleAt, 11));
  await w.rt.run("leaderboardSnapshot.runNow", { actorName: "Test Admin" });
  await w.runBuilds();
  check("(served again)", w.snapRows()[0].serve === "all");

  // The kill switch, in one call.
  const killed = await w.configure({ mode: "off" });
  check("configure off sets the copy's serve to none in the same call",
    killed.ok && w.snapRows()[0].serve === "none" && w.snapRows()[0].why === "off" && w.stateOf().serve === "none", J(killed));
  // A state row put back by hand: the tick heals the copy.
  const stRow = w.store.rows("appState").find((r) => r.key === w.S.STATE_KEY);
  await w.store.db.patch(stRow._id, { value: { ...stRow.value, serve: "all" } });
  await w.store.db.patch(w.snapRows()[0]._id, { serve: "all" });
  const healed = await w.rt.run("leaderboardSnapshot.tick", {});
  check("off with the copy still marked served: the tick puts it back to none", healed.healed === true && w.snapRows()[0].serve === "none");

  // THE STATE ROW LOST WHILE THE COPY IS SERVED (review, 2026-10-13). The
  // mirror forgets the copy; the switch and the tick must find it by name.
  const appRow = (key) => w.store.rows("appState").find((r) => r.key === key);
  const dropRow = async (key) => { const r = appRow(key); if (r) await w.store.db.delete(r._id); };
  const goLive = async () => {
    clock.advance(20 * 60000);
    await w.configure({ mode: "live", acceptWithoutCompare: true });
    await w.rt.run("leaderboardSnapshot.runNow", { actorName: "Test Admin" });
    await w.runBuilds();
    return w.snapRows()[0].serve === "all";
  };
  const servedA = await goLive();
  await dropRow(w.S.STATE_KEY);
  const killed2 = await w.configure({ mode: "off" });
  w.rec.reads.length = 0;
  await w.cash(w.students()[0]);
  check("configure off stops serving the copy even when the state row lost track of it",
    servedA && killed2.ok && w.snapRows()[0].serve === "none" && w.snapRows()[0].why === "off" &&
    w.stateOf().snapshotId === w.snapRows()[0]._id && w.rec.reads.some((r) => r.table === "students" && r.terminal === "collect"),
    J([servedA, killed2, w.snapRows()[0].serve]));

  const servedB = await goLive();
  await dropRow(w.S.STATE_KEY);
  await dropRow(w.S.CONFIG_KEY);
  const found = await w.rt.run("leaderboardSnapshot.tick", {});
  check("with both appState rows deleted (which reads as off), the next tick finds the copy and stops serving it",
    servedB && found.healed === true && w.snapRows()[0].serve === "none" && w.stateOf().snapshotId === w.snapRows()[0]._id,
    J([servedB, found, w.snapRows()[0].serve]));

  const servedC = await goLive();
  await dropRow(w.S.STATE_KEY);
  clock.advance(14 * 60 * 60000);
  const late = await w.rt.run("leaderboardSnapshot.tick", {});
  w.rt.take();
  check("in live, a lost state row is found again by the tick, and an old copy is still stopped (stale)",
    servedC && late.markStale === "stale" && w.snapRows()[0].serve === "none" && w.snapRows()[0].why === "stale",
    J([servedC, late, w.snapRows()[0].serve]));
  keepWrites(w);
}

// ======================================================================
console.log("\n6b. A build that keeps failing backs off nights and weekends");
{
  // Cadence is measured from the last GOOD build, so without a backoff a
  // refusal that keeps happening re-read every student at every tick, around
  // the clock (review, 2026-10-13). A Saturday, every cron firing, every
  // build failing: about as many builds as the off-hours cadence makes.
  clock.set("2026-10-16T23:03:00.000Z");
  const w = world();
  await w.configure({ mode: "live", acceptWithoutCompare: true });
  await w.runBuilds();
  const servedFri = w.snapRows()[0].serve === "all";
  w.rec.forbid.add("students");
  let ticks = 0, builds = 0;
  for (let h = 0; h < 24; h++) {
    if (h === 13 || h === 19) continue; // crons.ts never fires in those hours
    for (const m of [3, 18, 33, 48]) {
      clock.set(`2026-10-17T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`);
      const t = await w.rt.run("leaderboardSnapshot.tick", {});
      ticks++;
      if (t.do === "build") builds++;
      await w.runBuilds();
    }
  }
  w.rec.forbid.delete("students");
  check("a Saturday of failing builds makes a handful, not one at every tick",
    servedFri && ticks === 88 && builds >= 4 && builds <= 8 && w.snapRows()[0].serve === "none" && w.snapRows()[0].why === "failing",
    J({ servedFri, ticks, builds, serve: w.snapRows()[0].serve }));
  keepWrites(w);
}

// ======================================================================
console.log("\n7. The compare, the live gate, and what status says");
{
  clock.set(T0);
  const w = world();
  await w.configure({ mode: "shadow" });
  await w.runBuilds();
  const refused = await w.configure({ mode: "live" });
  check("configure live is refused without a clean compare on record",
    refused.ok === false && refused.code === "no-clean-compare" && w.snapRows()[0].serve === "none", J(refused));
  const logic = await w.rt.run("leaderboardSnapshot.compare", { kind: "logic" });
  check("a logic compare finds no difference across every viewer, band and page size",
    logic.ok && logic.comparisons === (60 - 2) * 6 && logic.differ === 0 && logic.fallbacksByReason["viewer-duplicated"] === 2, J(logic));
  // THE RUNBOOK'S ORDER (spec 3.12): fresh compares run after the logic one,
  // and the switch to live still finds the logic one (review, 2026-10-13).
  const between = await w.rt.run("leaderboardSnapshot.compare", { kind: "fresh" });
  const ok = await w.configure({ mode: "live" });
  check("  ...after which live is allowed, even with a fresh compare run since (the runbook's order)",
    between.ok === true && ok.ok === true && w.snapRows()[0].serve === "all", J(ok));

  // Drift: an award after the build. A fresh compare must see it.
  const someone = w.students().find((s) => s.wildcatCashEarned === 45);
  await w.store.db.patch(someone._id, { wildcatCashEarned: 9000 });
  const fresh = await w.rt.run("leaderboardSnapshot.compare", { kind: "fresh" });
  check("a fresh compare on a copy older than an award sees the drift",
    fresh.ok && fresh.differ > 0 && fresh.rowsChangedSinceBuild === 1 && fresh.byField.top > 0, J(fresh));
  const logic2 = await w.rt.run("leaderboardSnapshot.compare", { kind: "logic" });
  check("  ...while a logic compare of the same moment finds none", logic2.differ === 0);

  // The sample pilot.
  const sample = await w.configure({ mode: "pilot", pilotSample: 5 });
  check("pilotSample picks enrolled students from the copy, and says how many, not who",
    sample.ok && sample.pilot.ids === 5 && sample.pilot.sampled === 5 && w.snapRows()[0].pilotIds.length === 5 &&
    !FIXTURE_TOKENS.some((t) => J(sample).includes(t)), J(sample));
  const tooMany = await w.configure({ pilotSample: 51 });
  check("  ...at most 50", tooMany.ok === false);
  check("a cadence outside its bounds is refused", (await w.configure({ schoolEveryMinutes: 3 })).ok === false);
  check("  ...and one inside them is kept", (await w.configure({ schoolEveryMinutes: 30 })).schoolEveryMinutes === 30);

  const status = await w.rt.run("leaderboardSnapshot.status", {});
  check("status says the mode, the copy's size and its builds",
    status.config.mode === "pilot" && status.snapshot.exists && status.snapshot.rows === 60 && status.snapshot.bytes > 1000 &&
    status.state.lastOk.rows === 60 && status.config.pilot === 5);
  const outputs = J([status, logic, between, fresh, logic2, sample]);
  check("NO STATUS OR COMPARE OUTPUT CARRIES A FIXTURE NAME OR ID",
    !FIXTURE_TOKENS.some((t) => outputs.includes(t)), FIXTURE_TOKENS.filter((t) => outputs.includes(t)).slice(0, 3).join(", "));
  keepWrites(w);
}

// ======================================================================
console.log("\n8. Across every run above");
{
  const tables = [...new Set(ALL_WRITES.map((x) => x.table))].sort();
  check("EVERY MUTATION WRITES ONLY appState AND leaderboardSnapshots",
    ALL_WRITES.length > 20 && J(tables) === J(["appState", "leaderboardSnapshots"]), J(tables));
  const leaked = ALL_LOGS.filter((l) => FIXTURE_TOKENS.some((t) => l.includes(t)));
  check("no log line any module wrote carries a fixture name or id",
    ALL_LOGS.length > 5 && leaked.length === 0, leaked.slice(0, 2).join(" | "));
}

clock.real();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
