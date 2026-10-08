// WEEKS OF SCHOOL, END TO END, AGAINST AN INDEPENDENT ORACLE.
// Run: node reflection-weeks.test.mjs
//
// WHY (adversarial review, 2026-10-08). reflection-reader.test.mjs drives the
// shipped server code through single days and checks each expectation by
// hand. This test drives it through WHOLE WEEKS -- the cron's own UTC clock,
// a tick every 5 minutes from 14:00 to 23:55 UTC every calendar day, weekends
// and holidays included -- and compares EVERY list it makes (who is on it,
// each row's violation lines, its tags, its carry count, and what became of
// the detention) with lists worked out by an ORACLE written here from the
// owner's rules in the build spec alone. The oracle imports nothing from
// convex/reflection*.ts: it has its own Los Angeles clock, its own arrival
// rule (spec 3.3), its own freeze windows (3.5, 3.6), its own claim and tag
// rules (3.6), its own carry rule (3.8) and room rules, replaying a ledger of
// every PowerSchool change, uniform entry, switch and room press with the
// time it happened.
//
// The worlds:
//   A. Fri 10/30 -> Mon 11/2 (the clock change) -> Tue 11/3 (a marked
//      Minimum Day) -> Wed 11/4 and Thu 11/5 with PowerSchool down
//      11:00-11:50 -> Fri 11/6: P5/P6, entered late, a hold released after
//      school, a carry, "owes 2", a weekend uniform entry, arrivals.
//   B. Fri 11/20 -> Mon 11/30 over Thanksgiving, once with the break MARKED
//      no school (and 11/30 a marked Stack Day) and once UNMARKED.
//   E. MS from shadow to live midweek (Tue 12/8 evening) with HS in shadow;
//      the room's Not here, Attendance done and Room did not run for the live
//      division only; a tardy cleared, typed back as an arrival and counted
//      again (released after the pull, released before it, and before the list).
//   E2. MS to live on a Wednesday morning counting from that day; HS to live
//      after Thursday's list counting from Thursday.
//   B2. No list on the Friday before Thanksgiving (PowerSchool down all morning).
//   A2. An unmarked six-period Thursday, treated as a Minimum Day (spec 3.5).
//   F2. Friday's room attendance recorded on Monday morning; a T changed to D
//      and back behind a Promise Time absence.
//   C5. One detention carried five times across a marked holiday, then review.
//   U. Queued uniform entries: saved late, sent over a weekend, past 72 hours,
//      observed before the close and saved after the list.
//   O. "Owes 2" twice in a row: a carried and a queued detention together.
//   H. Uniform entries (and tardies) logged while a division is off, then the
//      division switched on counting from that same day.
//   M. A switch corrected the same morning (counting from tomorrow, then
//      today); a rollback after the list, switched back on that afternoon
//      counting from that day, before and after the after-school read.
//   T. Tags on tardies that missed their list: a hold released before the
//      list, then an arrival at the close, counted again after it; on a
//      fallback day, a late entry and an arrival re-judged after the list.
//
// DUMP=1 prints the oracle's lists, day by day.
// Synthetic student numbers only; nothing here talks to a real deployment.
import { readFileSync } from "node:fs";
import { clock, loadConvex, makeDb, runtime } from "./fake-convex.mjs";
import { fakePowerSchool, REFLECTION_CODES } from "./fake-powerschool.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const schemaSrc = read("./convex/schema.ts");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "\n        " + why : ""}`));
};
const J = (x) => JSON.stringify(x);

const realLog = console.log;
console.log = (...a) => { if (!(typeof a[0] === "string" && a[0].startsWith("[reflection]"))) realLog(...a); };

const loaded = await loadConvex(new URL("./", import.meta.url),
  ["reflection", "reflectionRead", "reflectionRules", "reflectionList", "reflectionRoom", "uniformViolations"], {
    transform: (name, src) => (name === "attendanceDays" ? src.replace("const RETRY_PAUSE_MS = 1000;", "const RETRY_PAUSE_MS = 1;") : src),
  });
const { mods } = loaded;

const TZ = "America/Los_Angeles";
const SCHOOL = "1817", YEAR = "36";
const CODE = { A: 1, T: 2, D: 3, K: 4, P: 5, S: 6, X: 7 };
const FIVE = 5 * 60 * 1000;
const MIN = 60 * 1000;
Object.assign(process.env, {
  PS_HOST: "ps.test", PS_CLIENT_ID: "id", PS_CLIENT_SECRET: "secret", PS_SCHOOL_ID: SCHOOL, PS_YEAR_ID: YEAR, PS_TERM_ID: "3601",
  STAFF_DOMAIN: "school.test", ENTRA_TENANT_ID: "tenant-1",
});
const STAFF_ISSUER = "https://login.microsoftonline.com/tenant-1/v2.0";

// ===========================================================================
// THE ORACLE'S OWN CLOCK (not reflectionRules.laWallToUtc)
// ===========================================================================
const laFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function laOf(ms) {
  const p = Object.fromEntries(laFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
/** Los Angeles wall clock on a date -> epoch ms. */
function LA(date, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  for (const off of [7, 8]) {
    const ms = Date.UTC(y, mo - 1, d, h + off, m);
    const back = laOf(ms);
    if (back.date === date && back.minute === h * 60 + m) return ms;
  }
  throw new Error(`no Los Angeles time ${date} ${hhmm}`);
}
const plusDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const weekday = (d) => new Date(d + "T12:00:00Z").getUTCDay();
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const lbl = (d) => `${WD[weekday(d)]} ${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const hm = (ms, ampm = false) => {
  const { minute } = laOf(ms);
  const h24 = Math.floor(minute / 60), m = minute % 60;
  const h = h24 % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")}${ampm ? (h24 >= 12 ? " PM" : " AM") : ""}`;
};
const iso = (ms) => new Date(ms).toISOString();

// ===========================================================================
// THE SCHOOL
// ===========================================================================
const MSS = { 1: "PT-A", 2: "P1-A", 3: "P2-A", 4: "P3-A", 5: "P4-A", 6: "P5-A", 7: "P6-A", 9: "PU-7", 10: "PM-A" };
const HSS = { 1: "PT-H", 2: "P1-H", 3: "P2-H", 4: "P3-H", 5: "P4-H", 6: "P5-H", 7: "P6-H", 8: "PU-10", 10: "PM-H" };
const TEACHER = { 1: "Adams", 2: "Lee", 3: "Ng", 4: "Ortiz", 5: "Park", 6: "Diaz", 7: "Kim", 8: "Cruz", 9: "Ruiz", 10: "Adams" };
const SLOTS = { mon: [1, 2, 4, 6, 8, 9, 10], tue: [1, 3, 5, 7, 8, 9, 10], all: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
const pad = (i) => String(i).padStart(2, "0");

// ===========================================================================
// THE WORLD: the shipped code, a fake Convex and a fake PowerSchool, and a
// LEDGER of everything that happens, with its time, for the oracle.
// ===========================================================================
async function makeWorld(cfg) {
  const store = makeDb(schemaSrc);
  const rt = runtime(store, mods);
  await store.db.insert("bellSettings", { key: "bell", timeZone: TZ, updatedAt: "2026-08-17T00:00:00Z" });
  const schedIds = {};
  for (const [date, c] of Object.entries(cfg.calendar)) {
    if (!c.mark) continue;
    if (c.mark.noSchool) {
      await store.db.insert("bellScheduleDays", { date, noSchool: true, setAt: "2026-08-17T00:00:00Z" });
    } else {
      const nm = c.mark.schedule;
      schedIds[nm] ??= await store.db.insert("bellSchedules", {
        name: nm, periods: [], weekdays: [], active: true, createdAt: "2026-08-17T00:00:00Z", updatedAt: "2026-08-17T00:00:00Z",
      });
      await store.db.insert("bellScheduleDays", { date, scheduleId: schedIds[nm], noSchool: false, setAt: "2026-08-17T00:00:00Z" });
    }
  }
  const roster = {};
  const enroll = (sn, div, sections, role) => { roster[sn] = { div, grade: div === "ms" ? "7" : "10", sections, role }; };
  for (const [sn, div] of Object.entries(cfg.students)) enroll(sn, div, { ...(div === "ms" ? MSS : HSS), ...(cfg.sections?.[sn] ?? {}) }, "test");
  enroll("CM", "ms", MSS, "classmate");
  enroll("CH", "hs", HSS, "classmate");
  const fill = (prefix, base) => Object.fromEntries(Object.keys(base).map((s) => [s, `${prefix}-${s}`]));
  for (let i = 0; i < 20; i++) enroll(`F${pad(i)}`, "ms", fill("FILL", MSS), "filler");
  for (let i = 0; i < 10; i++) enroll(`G${pad(i)}`, "hs", fill("FILLH", HSS), "filler");

  const ps = {
    attendance: [],
    attendance_code: REFLECTION_CODES.map((c) => ({ ...c, schoolid: SCHOOL, yearid: YEAR })),
    students: [],
    terms: [{ id: 3601, abbreviation: "S1", lastday: "2026-12-18", schoolid: SCHOOL, yearid: YEAR }],
  };
  const psId = {};
  let nextPs = 70000;
  const syncedAt = "2026-10-01T13:00:05.000Z";
  for (const [sn, s] of Object.entries(roster)) {
    psId[sn] = ++nextPs;
    ps.students.push({ id: psId[sn], student_number: sn, grade_level: s.grade, schoolid: SCHOOL, enroll_status: 0 });
    for (const [slot, sectionId] of Object.entries(s.sections)) {
      await store.db.insert("psRoster", {
        studentNumber: sn, firstName: "F", lastName: "L", gradeLevel: s.grade, sectionId, period: `${slot}(A-E)`,
        courseName: Number(slot) >= 8 && Number(slot) <= 9 ? "Power Up" : "Class",
        teacherFirstName: "Ms", teacherLastName: TEACHER[slot], syncedAt,
      });
    }
    if (s.role === "test") await store.db.insert("students", { studentNumber: sn, firstName: "Test", lastName: sn, grade: s.grade });
  }
  await store.db.insert("syncRuns", { at: syncedAt, summary: { syncedAt, rosterKept: false, rosterRows: 1 } });
  for (const t of [{ email: "pbis@school.test", role: "pbis" }, { email: "admin@school.test", role: "admin" }]) {
    await store.db.insert("teachers", { name: "Staff", ticketsAwarded: 0, ...t });
  }
  if (cfg.settings) await store.db.insert("appState", { key: "reflection:settings", value: cfg.settings, mirroredAt: "2026-10-01T00:00:00Z" });

  const fake = fakePowerSchool(ps, {});
  const downs = (cfg.down ?? []).map(([d, a, b]) => [LA(d, a), LA(d, b)]);
  const isDown = (ms) => downs.some(([a, b]) => ms >= a && ms < b);
  const L = { ps: [], uniform: [], mode: [], room: [], readNow: [] };
  let rid = 100000;
  const w = {
    store, rt, fake, roster, psId, L, cfg, downs, isDown, tickLog: [], jobLog: [],
    settings0: structuredClone(cfg.settings ?? { modeByDivision: { ms: "off", hs: "off" }, countFromDateByDivision: { ms: null, hs: null } }),
    mark(date, sn, slot, code) {
      const id = ++rid;
      fake.tables.attendance.push({
        id, schoolid: SCHOOL, yearid: YEAR, studentid: psId[sn], att_date: date, periodid: 850 + slot, attendance_codeid: CODE[code], ccid: 0,
      });
      L.ps.push({ at: Date.now(), type: "add", id, date, sn, slot, code });
      return id;
    },
    unmark(id) {
      const i = fake.tables.attendance.findIndex((r) => r.id === id);
      if (i < 0) throw new Error("no PowerSchool row " + id);
      fake.tables.attendance.splice(i, 1);
      L.ps.push({ at: Date.now(), type: "del", id });
    },
    recode(id, code) {
      const r = fake.tables.attendance.find((x) => x.id === id);
      if (!r) throw new Error("no PowerSchool row " + id);
      r.attendance_codeid = CODE[code];
      L.ps.push({ at: Date.now(), type: "code", id, code });
    },
    find(date, sn, slot) { return fake.tables.attendance.find((r) => r.att_date === date && r.studentid === psId[sn] && r.periodid === 850 + slot)?.id; },
    meet(date, slots) {
      for (const [sn, s] of Object.entries(roster)) {
        if (s.role === "test") continue;
        for (const slot of slots) if (String(slot) in s.sections) w.mark(date, sn, slot, "A");
      }
    },
    as(email) { rt.signIn({ issuer: STAFF_ISSUER, email }); return rt; },
    /** A uniform entry reaching the server now; `observedAt` is when Enter was pressed (the send queue's stamp). */
    async uniform(sn, observedAt = Date.now()) {
      const r = await w.as("pbis@school.test").run("uniformViolations.log", {
        studentNumber: sn, loanerProvided: false, attemptId: `u-${sn}-${observedAt}`, observedAt,
      });
      L.uniform.push({ at: Date.now(), sn, sentObservedAt: observedAt, ok: r.ok === true });
      return r;
    },
    async setMode(division, mode, countFromDate) {
      const r = await rt.run("reflection.setMode", { division, mode, ...(countFromDate ? { countFromDate } : {}) });
      if (!r.ok) throw new Error("setMode refused: " + r.reason);
      L.mode.push({ at: Date.now(), division, mode, from: r.countFromDate ?? null });
      return r;
    },
    unitOn(day, sn) {
      return store.rows("reflectionUnits").find((u) => u.serveDay === day && u.studentNumber === sn && ["listed", "carried", "review"].includes(u.state));
    },
    async notHere(day, sn) {
      const u = w.unitOn(day, sn);
      if (!u) throw new Error(`no unit for ${sn} on ${day}`);
      const r = await w.as("pbis@school.test").run("reflectionRoom.markRoom", { unitId: u._id, notHere: true });
      L.room.push({ at: Date.now(), day, type: "notHere", sn, value: true, ok: r.ok });
      return r;
    },
    async attendanceDone(day) {
      const r = await w.as("pbis@school.test").run("reflectionRoom.roomAttendanceDone", { day });
      L.room.push({ at: Date.now(), day, type: "done", ok: r.ok });
      return r;
    },
    async roomDidNotRun(day, reason) {
      const r = await w.as("admin@school.test").run("reflectionRoom.roomDidNotRun", { day, reason });
      L.room.push({ at: Date.now(), day, type: "closed", ok: r.ok });
      return r;
    },
    async readNow() {
      const r = await w.as("admin@school.test").run("reflectionRoom.readNow", {});
      if (r.ok) L.readNow.push({ at: Date.now(), kind: r.kind });
      await runJobs(w, Date.now() + 1);
      return r;
    },
  };
  globalThis.fetch = async (url, init) => {
    if (isDown(Date.now())) {
      return { ok: false, status: 503, json: async () => ({ message: "down" }), text: async () => "down", headers: { get: () => null } };
    }
    return fake.fetch(url, init);
  };
  return w;
}

async function runJobs(w, beforeMs) {
  for (;;) {
    const due = w.rt.jobs.filter((j) => j.at < beforeMs).sort((a, b) => a.at - b.at)[0];
    if (!due) return;
    w.rt.jobs.splice(w.rt.jobs.indexOf(due), 1);
    clock.set(Math.max(due.at, Date.parse(clock.iso)));
    const out = await w.rt.run(due.path, due.args);
    w.jobLog.push({ at: clock.iso, path: due.path, key: due.args?.key, out });
  }
}

/**
 * THE CRON, AS DEPLOYED: "0,5,...,55 14-23 * * *" UTC, every calendar day
 * from `from` to `to`. Hooks ([epoch ms, fn]) run in time order, each just
 * before the first tick at or after it, with the clock set to its own time.
 */
async function drive(w, from, to, hooks) {
  const pending = hooks.map(([at, fn]) => ({ at, fn, done: false })).sort((a, b) => a.at - b.at);
  const runHooks = async (t) => {
    for (const h of pending) {
      if (h.done || h.at > t) continue;
      clock.set(h.at);
      h.done = true;
      await h.fn();
      await runJobs(w, h.at + 1);
    }
  };
  for (let d = from; d <= to; d = plusDays(d, 1)) {
    for (let t = Date.parse(`${d}T14:00:00Z`); t <= Date.parse(`${d}T23:55:00Z`); t += FIVE) {
      await runHooks(t);
      clock.set(t);
      const out = await w.rt.run("reflection.tick", {});
      w.tickLog.push({ t, out });
      await runJobs(w, t + FIVE);
    }
  }
  const left = pending.filter((h) => !h.done);
  if (left.length) throw new Error(`${left.length} hooks never ran (first at ${iso(left[0].at)})`);
}

// ===========================================================================
// THE ORACLE. From the build spec's owner rules only.
// ===========================================================================
const ABSENT = new Set(["A", "S", "X"]);
const ORDER = [1, 2, 3, 4, 5, 8, 9, 6, 7, 10];
const TIMES = {
  regular: { close: "11:45", ready: "12:00", last: "12:21", pu: "12:31", swap: "13:02" },
  wed: { close: "11:20", ready: "11:30", last: "11:32", pu: "11:42", swap: "12:13" },
  minimum: { close: "11:20", ready: "11:30", last: "11:32", pu: "11:42", swap: "12:13" },
  stack: { close: "11:50", ready: "12:00", last: "12:12", pu: "12:22", swap: "12:53" },
};

function oracle(w, endMs) {
  const { roster, L, cfg, isDown } = w;
  const calendar = cfg.calendar;
  const dates = Object.keys(calendar).sort();
  const kindOf = (d) => calendar[d].kind ?? (weekday(d) === 3 ? "wed" : "regular");
  // Owner, 10/8: MS pulled at the block start, HS at the midpoint less 5 minutes.
  const pullAt = (d, div) => (div === "ms" ? LA(d, TIMES[kindOf(d)].pu) : LA(d, TIMES[kindOf(d)].swap) - 5 * MIN);

  const modeEvents = L.mode.slice().sort((a, b) => a.at - b.at);
  const settingsAt = (ms) => {
    const s = structuredClone(w.settings0);
    for (const e of modeEvents) {
      if (e.at > ms) break;
      s.modeByDivision[e.division] = e.mode;
      s.countFromDateByDivision[e.division] = e.mode === "off" ? null : e.from;
    }
    return s;
  };
  const anyOn = (ms) => { const s = settingsAt(ms); return s.modeByDivision.ms !== "off" || s.modeByDivision.hs !== "off"; };
  const parkingEvents = modeEvents.filter((e, i) => {
    if (e.mode === "off") return false;
    const before = settingsAt(e.at - 1);
    return before.modeByDivision[e.division] !== e.mode || before.countFromDateByDivision[e.division] !== e.from;
  });

  // ---- PowerSchool at any moment, replayed from the ledger.
  const psEv = L.ps.slice().sort((a, b) => a.at - b.at);
  const psCache = new Map();
  const psAt = (ms) => {
    if (psCache.has(ms)) return psCache.get(ms);
    const rows = new Map();
    for (const e of psEv) {
      if (e.at > ms) break;
      if (e.type === "add") rows.set(e.id, { date: e.date, sn: e.sn, slot: e.slot, code: e.code });
      else if (e.type === "del") rows.delete(e.id);
      else if (e.type === "code") rows.set(e.id, { ...rows.get(e.id), code: e.code });
    }
    psCache.set(ms, rows);
    return rows;
  };
  const viewCache = new Map();
  const view = (ms, date) => {
    const k = `${ms}|${date}`;
    if (viewCache.has(k)) return viewCache.get(k);
    const v = { count: {}, marks: {}, secMarks: new Set() };
    for (const r of psAt(ms).values()) {
      if (r.date !== date) continue;
      v.count[r.slot] = (v.count[r.slot] ?? 0) + 1;
      ((v.marks[r.sn] ??= {})[r.slot] ??= []).push(r.code);
      const sec = roster[r.sn]?.sections[r.slot];
      if (sec) v.secMarks.add(`${r.slot}|${sec}`);
    }
    viewCache.set(k, v);
    return v;
  };
  const met = (v, s) => (v.count[s] ?? 0) >= 10;

  // ---- Spec 3.3: counted, held or an arrival.
  function arrival(v, sn, slot, final) {
    const enrolled = Object.keys(roster[sn].sections).map(Number);
    const kept = ORDER.slice(0, ORDER.indexOf(slot)).filter((s) => met(v, s) && enrolled.includes(s));
    let present = false, unknown = false;
    for (const s of kept) {
      const codes = v.marks[sn]?.[s] ?? [];
      if (codes.length) {
        if (s === 1) { if (codes.some((c) => !ABSENT.has(c) && c !== "T" && c !== "D")) present = true; }
        else if (codes.some((c) => !ABSENT.has(c))) present = true;
      } else if (v.secMarks.has(`${s}|${roster[sn].sections[s]}`) || final) present = true;
      else unknown = true;
    }
    return present ? "counted" : unknown ? "held" : "arrival";
  }

  // ---- Spec 4.2: the reads of each day, and whether each worked.
  const schoolDays = dates.filter((d) => calendar[d].school);
  const lookbackOf = (d) => schoolDays.filter((x) => x < d).slice(-5);
  const reads = [];
  for (const d of dates) {
    const c = calendar[d];
    if (c.mark?.noSchool) continue;
    if ((weekday(d) === 0 || weekday(d) === 6) && !c.mark?.schedule) continue;
    const T = TIMES[kindOf(d)];
    const push = (ms, kind) => {
      if (!anyOn(ms)) return null;
      const r = { t: ms, date: d, kind, ok: !isDown(ms), lookback: ["opening", "closing", "after-school"].includes(kind) };
      reads.push(r);
      return r;
    };
    push(LA(d, "07:30"), "opening");
    for (const h of ["08:30", "09:30", "10:30"]) push(LA(d, h), "routine");
    const close = LA(d, T.close), ready = LA(d, T.ready);
    if (c.school) {
      for (const o of [40, 30, 20, 10]) push(close - o * MIN, "pre-close");
      for (let x = close; x + 4 * MIN <= ready; x += FIVE) { const r = push(x, "closing"); if (r?.ok) break; }
      for (const h of ["13:00", "14:00", "15:00"]) push(LA(d, h), "after-close");
    } else {
      push(close, "closing");    // an unmarked weekday with no school: one closing read finds nothing
    }
    push(LA(d, "15:45"), "after-school");
  }
  for (const r of L.readNow) reads.push({ t: r.at, date: laOf(r.at).date, kind: "manual", ok: !isDown(r.at), lookback: false });
  reads.sort((a, b) => a.t - b.t);
  const covering = new Map();
  const readsOfDate = (A) => {
    if (!covering.has(A)) covering.set(A, reads.filter((r) => r.ok && (r.date === A || (r.lookback && lookbackOf(r.date).includes(A)))));
    return covering.get(A);
  };
  const lastReadOf = (A, ms) => readsOfDate(A).filter((r) => r.t <= ms).pop() ?? null;

  // ---- One tardy (student, date, slot) as the reads saw it.
  const keyOf = (k) => { const [sn, date, slot] = k.split("|"); return { k, sn, date, slot: Number(slot) }; };
  const stateAt = (K, r) => {
    const v = view(r.t, K.date);
    const codes = v.marks[K.sn]?.[K.slot] ?? [];
    if (!codes.includes("T")) return { t: r.t, kind: r.kind, present: false };
    const final = r.date > K.date || r.kind === "after-school";
    return { t: r.t, kind: r.kind, present: true, verdict: arrival(v, K.sn, K.slot, final) };
  };
  const history = (K, untilMs) => readsOfDate(K.date).filter((r) => r.t <= untilMs).map((r) => stateAt(K, r));
  const keyAt = (K, ms) => { const r = lastReadOf(K.date, ms); return r ? stateAt(K, r) : null; };
  const firstSeen = (K) => history(K, Infinity).find((h) => h.present)?.t ?? null;
  /** When it last began to count (seen counted after not being so), up to `untilMs`. */
  const countsSince = (K, untilMs) => {
    let since = null, prev = false;
    for (const h of history(K, untilMs)) {
      const now = h.present && h.verdict === "counted";
      if (now && !prev) since = h.t;
      if (!now) since = null;
      prev = now;
    }
    return since;
  };
  /**
   * When a HOLD was last released into counting (a held reading, then a
   * counted one), up to `untilMs`. Spec 3.3: "A tardy released after its
   * date's list was made lands on the next list, tagged Held for attendance"
   * -- released after the list, not merely held at some point (third review,
   * 2026-10-08: a hold released before the list, then an arrival at the
   * close, missed the list as an arrival).
   */
  const holdReleasedAt = (K, untilMs) => {
    let at = null, prev = null;
    for (const h of history(K, untilMs)) {
      const v = h.present ? h.verdict : null;
      if (v === "counted" && prev === "held") at = h.t;
      prev = v;
    }
    return at;
  };

  // Spec 3.4: the server believes observedAt inside [now - 72 h, now + 5 min], else it files the entry now.
  for (const u of L.uniform) {
    const believed = u.sentObservedAt >= u.at - 72 * 3600 * 1000 && u.sentObservedAt <= u.at + 5 * MIN;
    u.observedAt = believed ? u.sentObservedAt : u.at;
    u.day = laOf(u.observedAt).date;
  }
  const allKeys = [...new Set(psEv.filter((e) => (e.type === "add" && e.code === "T") || e.type === "code")
    .map((e) => (e.type === "add" ? e : { ...psEv.find((x) => x.type === "add" && x.id === e.id), code: e.code }))
    .filter((e) => e.code === "T" && e.slot >= 2 && e.slot <= 7).map((e) => `${e.sn}|${e.date}|${e.slot}`))].sort();

  // ---- Spec 3.6: each school day's freeze.
  const freeze = {};
  for (const d of schoolDays) {
    const T = TIMES[kindOf(d)];
    const close = LA(d, T.close), ready = LA(d, T.ready);
    let fz = null;
    for (let x = close; x + 4 * MIN <= ready; x += FIVE) if (!isDown(x) && anyOn(x)) { fz = { F: x, kind: "closing" }; break; }
    if (!fz && anyOn(ready)) {
      const evidence = !!calendar[d].mark?.schedule
        || reads.some((r) => r.date === d && r.ok && r.t < ready && (view(r.t, d).count[1] ?? 0) >= 20);
      if (evidence) fz = { F: ready, kind: "fallback" };
    }
    freeze[d] = fz ?? (anyOn(ready) ? { noList: true } : { off: true });
  }

  // ---- Tags (spec 3.6).
  const slotName = (s) => `P${s - 1}`;
  function tardyTags(K, D, since) {
    const A = K.date;
    if (A >= D) return [];
    if (K.slot >= 6) return [`From ${lbl(A)} ${slotName(K.slot)} (after Power-Up)`];
    const own = freeze[A];
    if (!own || own.off) return [];
    if (own.noList) return [`List not made ${lbl(A)}`];
    if (own.kind === "fallback" && firstSeen(K) > own.F) return [`Found after the list was made (PowerSchool unreadable at close, ${lbl(A)})`];
    if (since !== null && (holdReleasedAt(K, since) ?? -Infinity) > own.F) return [`Held for attendance (${lbl(A)} ${slotName(K.slot)})`];
    // Spec 3.9: a fallback day's list had no final read; what began to count after it was "found after".
    if (own.kind === "fallback" && since !== null && since > own.F) return [`Found after the list was made (PowerSchool unreadable at close, ${lbl(A)})`];
    if (own.kind === "closing" && since !== null && since > own.F) return [`Entered late in PowerSchool (${lbl(A)} ${slotName(K.slot)})`];
    return [];
  }
  function uniformTags(u, D) {
    const tags = [];
    const own = freeze[u.day];
    if (u.day < D && own?.noList) tags.push(`List not made ${lbl(u.day)}`);
    // Spec 3.4/3.6: an entry is RECORDED when the server saves it, and one recorded after its day's list was
    // made lands on a later list -- tagged, so staff can see why a morning entry is on tomorrow's list.
    else if (own && own.F !== undefined && u.at >= own.F) {
      tags.push(`Uniform logged after the list closed (${lbl(u.day)} ${hm(u.observedAt >= own.F ? u.observedAt : u.at)})`);
    }
    if (u.at - u.observedAt > 10 * MIN) tags.push(`Saved late (observed ${WD[weekday(u.day)]} ${hm(u.observedAt)})`);
    return tags;
  }
  const tardyLine = (K) => `${lbl(K.date)}: Tardy ${slotName(K.slot)} (Ms ${TEACHER[K.slot]})`;
  const uniformLine = (u) => `${lbl(u.day)}: Uniform ${hm(u.observedAt, true)}`;

  // ---- Spec 3.8: the carry verdict.
  function carryVerdict(U, P, atMs) {
    const r = lastReadOf(P, atMs);
    const v = r ? view(r.t, P) : null;
    const sn = U.sn, div = U.div;
    const pu = div === "ms" ? 9 : 8;
    const absentIn = (s) => { const c = v.marks[sn]?.[s] ?? []; return c.length > 0 && c.every((x) => ABSENT.has(x)); };
    const room = L.room.filter((e) => e.ok && e.day === P && e.at < atMs);
    if (U.mode === "live") {
      if (room.some((e) => e.type === "closed")) return { carry: true, why: "room closed", counts: false };
      if (room.some((e) => e.type === "done")) {
        const ticks = room.filter((e) => e.type === "notHere" && e.sn === sn);
        if (!ticks.length || !ticks[ticks.length - 1].value) return { carry: false, why: "room: in the room" };
        return { carry: true, why: absentIn(pu) ? "absent" : "at school: did not come", counts: true };
      }
    }
    if (!v || !met(v, pu)) return { review: "Power-Up did not meet" };
    const enrolled = Object.keys(roster[sn].sections).map(Number);
    const own = [2, 3, 4, 5, 6, 7].filter((s) => met(v, s) && enrolled.includes(s));
    if (!v.secMarks.has(`${pu}|${roster[sn].sections[pu]}`)) {
      const all = ORDER.filter((s) => met(v, s) && enrolled.includes(s));
      return all.every(absentIn) ? { carry: true, why: "absent", counts: true } : { carry: false, why: "whole day: in school" };
    }
    const before = own.filter((s) => s <= 5).pop(), after = own.find((s) => s >= 6);
    const presentBefore = before !== undefined && !absentIn(before);
    const presentAfter = after !== undefined && !absentIn(after);
    return absentIn(pu) && !(presentBefore && presentAfter) ? { carry: true, why: "absent", counts: true } : { carry: false, why: "powerschool: served" };
  }

  // ---- The days, in order: carries of the last list, then the claim.
  const units = [];
  let unitSeq = 0;
  const keyUnit = new Map();
  const uniUnit = new Map();
  const lists = {};
  const listDays = [];
  // Spec 3.9: switching on parks what is waiting from BEFORE the start -- made under another mode ("shadow
  // carries do not move into live"), or dated before the new countFromDate: a carry by the list it carries
  // from, a queued detention by the list that queued it. One from the new date's own list waits on.
  const parkedBetween = (U, a, b) => parkingEvents.some((e) => e.division === U.div && e.at > a && e.at <= b
    && (e.mode !== U.mode || (U.fromDay ?? U.listDay) < e.from));

  /** A tardy whose detention was released BEFORE its pull and that counts again is owed on the next list. */
  function clearedAt(K, U, untilMs) {
    for (const h of history(K, untilMs)) if (h.t > U.F && !h.present && h.kind !== "closing") return h.t;
    return null;
  }
  function releasedAt(U, untilMs) {
    if (U.uniforms.length) return null;
    const ts = U.keys.map((k) => clearedAt(keyOf(k), U, untilMs));
    return ts.every((t) => t !== null) ? Math.max(...ts) : null;
  }
  function returnedAt(K, U, untilMs) {
    const c1 = clearedAt(K, U, untilMs);
    if (c1 === null) return null;
    for (const h of history(K, untilMs)) {
      if (h.t <= c1 || !(h.present && h.verdict === "counted")) continue;
      const rel = releasedAt(U, h.t);
      return rel !== null && rel < pullAt(U.day, U.div) ? h.t : null;
    }
    return null;
  }
  /** Released and not put back by a tardy that counted again after the pull. */
  function stillReleased(U, untilMs) {
    const rel = releasedAt(U, untilMs);
    if (rel === null) return false;
    for (const k of U.keys) {
      const K = keyOf(k);
      for (const h of history(K, untilMs)) {
        if (h.t > rel && h.present && h.verdict === "counted") return rel < pullAt(U.day, U.div);
      }
    }
    return true;
  }

  function decideCarries(P, atMs) {
    for (const U of units.filter((u) => u.day === P && u.state === "listed")) {
      if (stillReleased(U, atMs)) { U.state = "released"; continue; }
      const v = carryVerdict(U, P, atMs);
      if (v.review) { U.state = "review"; U.reason = v.review; continue; }
      if (!v.carry) continue;
      // Spec 3.8: at most 5 carries (room-closed carries do not count); the next goes to admin review.
      if (v.counts && U.carryCount >= 5) { U.state = "review"; U.reason = `Carried ${U.carryCount} times`; continue; }
      U.state = "carried";
      units.push({
        id: ++unitSeq, sn: U.sn, div: U.div, mode: U.mode, kind: "carry", keys: U.keys, uniforms: U.uniforms, lines: U.lines,
        tags: [`Carried over from ${lbl(P)} (${v.why})`], carryCount: U.carryCount + (v.counts ? 1 : 0),
        createdAt: LA(P, "15:45"), origin: U.origin, fromDay: P, state: "pending",
      });
    }
  }

  let prevList = null, prevF = -Infinity;
  for (const D of schoolDays) {
    const fz = freeze[D];
    if (!fz.F) continue;
    const F = fz.F;
    const s = settingsAt(F);
    if (prevList) decideCarries(prevList, F);

    const per = new Map();
    const bucket = (sn) => { if (!per.has(sn)) per.set(sn, { keys: [], unis: [], units: [] }); return per.get(sn); };
    for (const k of allKeys) {
      const K = keyOf(k);
      if (K.date > D || (K.date === D && K.slot >= 6)) continue;
      let back = null;
      if (keyUnit.has(k)) {
        back = returnedAt(K, units.find((u) => u.id === keyUnit.get(k)), F);
        if (back === null) continue;
      }
      const st = keyAt(K, F);
      if (!st?.present || st.verdict !== "counted") continue;
      const div = roster[K.sn].div;
      if (s.modeByDivision[div] === "off") continue;
      const from = s.countFromDateByDivision[div];
      if (!from || K.date < from) continue;
      // Spec 3.9: first seen after `lateEntryLists` lists of its division -> admin review.
      const seen = firstSeen(K);
      const before = listDays.filter((x) => x.date > K.date && x.F < seen && x.modes[div] !== "off").length;
      if (before >= 5) continue;
      bucket(K.sn).keys.push({ K, since: back ?? countsSince(K, F) });
    }
    L.uniform.forEach((u, i) => {
      if (!u.ok || u.at > F || u.day > D || uniUnit.has(i)) return;
      const div = roster[u.sn].div;
      if (s.modeByDivision[div] === "off") return;
      const from = s.countFromDateByDivision[div];
      if (!from || u.day < from) return;
      bucket(u.sn).unis.push({ ...u, i });
    });
    for (const U of units) {
      if (U.state !== "pending") continue;
      if (s.modeByDivision[U.div] !== U.mode || parkedBetween(U, U.createdAt, F)
        || (U.fromDay && (!s.countFromDateByDivision[U.div] || U.fromDay < s.countFromDateByDivision[U.div]))) {
        U.state = "parked";
        continue;
      }
      bucket(U.sn).units.push(U);
    }

    const rows = {};
    for (const [sn, got] of [...per.entries()].sort()) {
      const div = roster[sn].div;
      const keys = got.keys.sort((a, b) => (a.K.date + ORDER.indexOf(a.K.slot)).localeCompare(b.K.date + ORDER.indexOf(b.K.slot)));
      const hasNew = keys.length + got.unis.length > 0;
      // Spec 2.4: "The oldest detention is served" -- a carried detention is as old as the one it carries.
      const owed = [...got.units.sort((a, b) => a.origin - b.origin || a.createdAt - b.createdAt), ...(hasNew ? ["new"] : [])];
      let fresh = null;
      if (hasNew) {
        fresh = {
          id: ++unitSeq, sn, div, mode: s.modeByDivision[div], kind: "new", keys: keys.map((x) => x.K.k), uniforms: got.unis.map((u) => u.i),
          lines: [...keys.map((x) => tardyLine(x.K)), ...got.unis.map(uniformLine)],
          tags: [...new Set([...keys.flatMap((x) => tardyTags(x.K, D, x.since)), ...got.unis.flatMap((u) => uniformTags(u, D))])],
          carryCount: 0, createdAt: F, origin: F, listDay: D, state: "pending",
        };
        units.push(fresh);
        for (const x of keys) keyUnit.set(x.K.k, fresh.id);
        for (const u of got.unis) uniUnit.set(u.i, fresh.id);
      }
      const serve = owed[0] === "new" ? fresh : owed[0];
      serve.state = "listed";
      serve.day = D;
      serve.F = F;
      if (owed.length > 1) serve.tags = [...serve.tags, `Owes ${owed.length}`];
      for (const q of owed.slice(1)) {
        const u = q === "new" ? fresh : q;
        if (q === "new") u.kind = "queued";
        if (!u.tags.includes("Queued: 2nd detention")) u.tags = [...u.tags, "Queued: 2nd detention"];
      }
      rows[sn] = serve;
    }
    lists[D] = rows;
    listDays.push({ date: D, F, kind: fz.kind, modes: { ...s.modeByDivision } });
    prevList = D; prevF = F;
  }
  if (prevList) decideCarries(prevList, endMs);
  // Released after the last list's carries were decided (or never carried).
  for (const U of units) if (U.state === "listed" && stillReleased(U, endMs)) U.state = "released";

  const out = {};
  for (const [D, rows] of Object.entries(lists)) {
    out[D] = {};
    for (const [sn, U] of Object.entries(rows)) {
      out[D][sn] = {
        div: U.div, mode: U.mode, kind: U.kind, lines: U.lines.slice().sort(), tags: U.tags.slice().sort(),
        carryCount: U.carryCount, state: U.state,
      };
    }
  }
  return { lists: out, freeze, listDays };
}

// ===========================================================================
// WHAT THE SHIPPED CODE MADE, and the diff
// ===========================================================================
function actual(w) {
  const lists = {};
  const dup = [];
  for (const u of w.store.rows("reflectionUnits")) {
    if (!u.serveDay || u.state === "expired" || u.state === "before-start") continue;
    const day = (lists[u.serveDay] ??= {});
    if (day[u.studentNumber]) dup.push(`${u.serveDay} ${u.studentNumber}`);
    day[u.studentNumber] = {
      div: u.division, mode: u.mode, kind: u.kind, lines: (u.lines ?? []).slice().sort(), tags: (u.tags ?? []).slice().sort(),
      carryCount: u.carryCount, state: u.state === "carried" ? "carried" : u.state,
    };
  }
  const days = Object.fromEntries(w.store.rows("reflectionDays").map((d) => [d.date, d]));
  return { lists, days, dup };
}

function compare(name, w, endMs) {
  const exp = oracle(w, endMs);
  const got = actual(w);
  if (process.env.DUMP) for (const [D, rows] of Object.entries(exp.lists)) realLog(`   ${name} ${D} ${exp.freeze[D]?.kind} ` + Object.entries(rows).map(([sn, r]) => `${sn}[${r.div}/${r.mode}/${r.kind}/${r.state}/c${r.carryCount}] ${J(r.tags)}`).join(' | '));
  check(`${name}: no student holds two detentions on one list`, got.dup.length === 0, J(got.dup));
  const allDays = [...new Set([...Object.keys(exp.lists), ...Object.keys(got.lists)])].sort();
  for (const D of allDays) {
    const fz = exp.freeze[D];
    const dRow = got.days[D];
    if (fz?.F) {
      check(`${name} ${lbl(D)}: the list is made at ${hm(fz.F)} (${fz.kind})`,
        dRow?.frozenAt === iso(fz.F) && dRow?.freezeKind === fz.kind,
        `oracle ${iso(fz.F)} ${fz.kind}; code ${dRow?.frozenAt} ${dRow?.freezeKind}`);
    }
    const e = exp.lists[D] ?? {}, g = got.lists[D] ?? {};
    const es = Object.keys(e).sort(), gs = Object.keys(g).sort();
    check(`${name} ${lbl(D)}: the students on the list`, J(es) === J(gs),
      `oracle [${es}] code [${gs}]; missing [${es.filter((x) => !gs.includes(x))}] extra [${gs.filter((x) => !es.includes(x))}]`);
    for (const sn of es.filter((x) => gs.includes(x))) {
      const a = e[sn], b = g[sn];
      const diffs = [];
      for (const f of ["div", "mode", "kind", "lines", "tags", "carryCount", "state"]) if (J(a[f]) !== J(b[f])) diffs.push(`${f}: oracle ${J(a[f])} code ${J(b[f])}`);
      check(`${name} ${lbl(D)} ${sn}: lines, tags, carry count and what became of it`, diffs.length === 0, diffs.join("; "));
    }
  }
  // Controls the spec says must be 0 every day (spec 7), checked on the code's own records.
  const units = w.store.rows("reflectionUnits");
  const onList = new Map();
  for (const u of units) {
    if (!u.serveDay || ["expired", "before-start", "released"].includes(u.state) || u.kind === "carry") continue;
    for (const t of u.tardyIds) { if (!onList.has(t)) onList.set(t, []); onList.get(t).push(u.serveDay); }
  }
  const twice = [...onList.entries()].filter(([, ds]) => ds.length > 1);
  check(`${name}: no tardy is on two lists`, twice.length === 0, J(twice));
  const tardies = Object.fromEntries(w.store.rows("reflectionTardies").map((t) => [t._id, t]));
  const later = units.filter((u) => u.serveDay && u.tardyIds.some((id) => tardies[id] && tardies[id].attDate > u.serveDay));
  check(`${name}: no item listed before its own date`, later.length === 0, J(later.map((u) => u.studentNumber)));
  const madeLate = Object.values(got.days).filter((d) => d.frozenAt && d.lastFreezeInstant && d.frozenAt >= d.lastFreezeInstant);
  check(`${name}: no list made at or after its latest time`, madeLate.length === 0, J(madeLate.map((d) => d.date)));
  return { exp, got };
}

const school = (kind, slots, mark) => ({ school: true, kind, slots, ...(mark ? { mark } : {}) });
const calendarHooks = (w) => Object.entries(w.cfg.calendar).filter(([, c]) => c.school && c.slots)
  .map(([d, c]) => [LA(d, "07:45"), () => w.meet(d, c.slots)]);

try {
  // ==========================================================================
  realLog("\nA. FRI 10/30 -> MON 11/2 (THE CLOCK CHANGE) -> TUE 11/3 MINIMUM DAY -> WED 11/4, THU 11/5 (POWERSCHOOL DOWN 11:00-11:50)\n");
  // ==========================================================================
  {
    const cal = {
      "2026-10-29": school("regular", SLOTS.mon),
      "2026-10-30": school("regular", SLOTS.tue),
      "2026-10-31": { school: false }, "2026-11-01": { school: false },
      "2026-11-02": school("regular", SLOTS.mon),
      "2026-11-03": school("minimum", SLOTS.all, { schedule: "Minimum Day" }),
      "2026-11-04": school("wed", SLOTS.all),
      "2026-11-05": school("regular", SLOTS.mon),
      "2026-11-06": school("regular", SLOTS.tue),
      "2026-11-07": { school: false }, "2026-11-08": { school: false },
      "2026-11-09": school("regular", SLOTS.mon),
    };
    const ms = "ms", hs = "hs";
    const w = await makeWorld({
      calendar: cal,
      students: {
        T0: ms, A1: ms, A2: ms, A3: hs, A4: hs, A5: ms, A6: ms, A7: hs, A8: ms,
        B1: ms, B2: hs, B3: hs, B4: ms, B5: hs, H1: ms, C1: ms, C2: hs, C3: ms, C4: hs,
        D1: ms, D2: hs, D3: ms, E1: ms, E2: hs, E3: hs, Z6: ms,
      },
      sections: { H1: { 1: "PT-B" } },      // a Promise Time section that never takes attendance
      settings: { modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: "2026-10-21", hs: "2026-10-21" } },
      down: [["2026-11-04", "11:00", "11:50"], ["2026-11-05", "11:00", "11:50"]],
    });
    const at = (d, t, fn) => [LA(d, t), fn];
    const FRI = "2026-10-30", MON = "2026-11-02", TUE = "2026-11-03", WED = "2026-11-04", THU = "2026-11-05";
    const hooks = [
      ...calendarHooks(w),
      at("2026-10-29", "08:10", () => w.mark("2026-10-29", "T0", 2, "T")),
      // Friday 10/30 (P2, P4, P6 meet)
      at(FRI, "07:55", () => w.uniform("A6")),
      at(FRI, "08:40", () => w.mark(FRI, "A5", 1, "A")),          // absent at Promise Time ...
      at(FRI, "08:50", () => w.mark(FRI, "A1", 3, "T")),
      at(FRI, "09:00", () => w.mark(FRI, "A4", 3, "T")),
      at(FRI, "09:20", () => w.mark(FRI, "A5", 3, "T")),          // ... late to P2: arrived late to school
      at(FRI, "12:00", () => w.uniform("A7")),                      // after the list closed
      at(FRI, "12:10", () => w.mark(FRI, "A3", 5, "T")),          // P4, entered after the list
      at(FRI, "12:40", () => w.mark(FRI, "A4", 8, "A")),          // A4 absent at Power-Up ...
      at(FRI, "13:50", () => w.mark(FRI, "A4", 7, "A")),          // ... and P6: carries
      at(FRI, "14:20", () => w.mark(FRI, "A2", 7, "T")),          // P6
      at("2026-10-31", "10:00", () => w.uniform("A8")),            // a Saturday entry
      // Monday 11/2, standard time (P1, P3, P5 meet)
      at(MON, "08:10", () => w.mark(MON, "B1", 2, "T")),
      at(MON, "08:15", () => w.mark(MON, "B5", 2, "T")),
      at(MON, "08:20", () => w.mark(MON, "H1", 2, "T")),          // PT-B never has marks: held until after school
      at(MON, "11:00", () => w.mark(MON, "B3", 4, "T")),          // 11:00 PST: after 10:45, before 11:45
      at(MON, "11:40", () => w.mark(MON, "B2", 4, "T")),
      at(MON, "12:40", () => w.mark(MON, "B5", 8, "A")),
      at(MON, "13:30", () => w.mark(MON, "B4", 6, "T")),          // P5
      at(MON, "13:40", () => w.mark(MON, "B5", 6, "A")),          // B5 carries to Tuesday
      // Tuesday 11/3, a marked Minimum Day (all six periods; closes 11:20)
      at(TUE, "08:20", () => { w.mark(TUE, "C4", 1, "T"); w.mark(TUE, "C4", 2, "T"); }),   // late to Promise Time: P1 is an arrival
      at(TUE, "09:00", () => w.mark(TUE, "B5", 3, "T")),          // B5 owes the carry AND a new one
      at(TUE, "10:00", () => w.mark(TUE, "C4", 4, "T")),          // P3 counts: P1's T proves presence
      at(TUE, "11:10", () => w.mark(TUE, "C1", 5, "T")),
      at(TUE, "11:22", () => w.mark(TUE, "C2", 5, "T")),          // after the 11:20 close
      at(TUE, "12:00", () => w.mark(TUE, "C3", 7, "T")),
      // Wednesday 11/4: PowerSchool down 11:00-11:50 (list at 11:30 from the 10:50 read)
      at(WED, "09:00", () => w.mark(WED, "D1", 2, "T")),
      at(WED, "10:45", () => w.mark(WED, "D3", 5, "T")),
      at(WED, "10:55", () => w.mark(WED, "D2", 4, "T")),          // after the last good read
      // Thursday 11/5: PowerSchool down 11:00-11:50 (closing read at 11:50)
      at(THU, "11:20", () => w.mark(THU, "E1", 4, "T")),
      at(THU, "11:48", () => w.mark(THU, "E2", 2, "T")),
      at(THU, "11:52", () => w.mark(THU, "E3", 2, "T")),
      at("2026-11-06", "08:30", () => w.mark("2026-11-06", "Z6", 3, "T")),
    ];
    await drive(w, "2026-10-29", "2026-11-09", hooks);
    compare("A", w, Date.parse("2026-11-09T23:55:00Z"));
  }

  // ==========================================================================
  for (const marked of [true, false]) {
    realLog(`\nB. THANKSGIVING, FRI 11/20 -> MON 11/30, THE BREAK ${marked ? "MARKED NO SCHOOL (11/30 A MARKED STACK DAY)" : "NOT MARKED"}\n`);
    // ==========================================================================
    const FRI = "2026-11-20", MON = "2026-11-30";
    const cal = {
      "2026-11-19": school("regular", SLOTS.mon),
      [FRI]: school("regular", SLOTS.tue),
      "2026-11-21": { school: false }, "2026-11-22": { school: false },
      ...Object.fromEntries(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]
        .map((d) => [d, marked ? { school: false, mark: { noSchool: true } } : { school: false }])),
      "2026-11-28": { school: false }, "2026-11-29": { school: false },
      [MON]: marked ? school("stack", SLOTS.all, { schedule: "Stack Day / Return from Holiday" }) : school("regular", SLOTS.mon),
      "2026-12-01": school("regular", SLOTS.tue),
    };
    const w = await makeWorld({
      calendar: cal,
      students: { T19: "ms", F1: "ms", F2: "hs", F3: "ms", F4: "hs", F5: "ms", F6: "hs", G1: "ms", S1: "hs", S2: "ms" },
      settings: { modeByDivision: { ms: "live", hs: "live" }, countFromDateByDivision: { ms: "2026-11-16", hs: "2026-11-16" } },
    });
    const at = (d, t, fn) => [LA(d, t), fn];
    const hooks = [
      ...calendarHooks(w),
      at("2026-11-19", "08:10", () => w.mark("2026-11-19", "T19", 2, "T")),
      at(FRI, "09:00", () => w.mark(FRI, "F3", 3, "T")),
      at(FRI, "12:40", () => { w.mark(FRI, "F2", 3, "T"); w.mark(FRI, "F3", 9, "A"); }),
      at(FRI, "13:00", () => w.uniform("F5")),
      at(FRI, "13:50", () => w.mark(FRI, "F3", 7, "A")),
      at(FRI, "16:30", () => w.mark(FRI, "F1", 7, "T")),           // after the after-school read
      at("2026-11-24", "09:00", () => w.uniform("F6")),             // an admin logs one during the break
      at("2026-11-24", "10:00", () => w.mark(FRI, "F4", 5, "T")),  // Friday's P4, entered during the break
      at(MON, "08:10", () => w.mark(MON, "G1", 2, "T")),
      ...(marked ? [
        at(MON, "11:45", () => w.mark(MON, "S1", 5, "T")),          // Stack Day closes 11:50
        at(MON, "11:52", () => w.mark(MON, "S2", 5, "T")),
      ] : []),
    ];
    await drive(w, "2026-11-19", "2026-12-01", hooks);
    const { got } = compare(`B(${marked ? "marked" : "unmarked"})`, w, Date.parse("2026-12-01T23:55:00Z"));
    const breakDays = Object.values(got.days).filter((d) => d.date > FRI && d.date < MON);
    check(`B(${marked ? "marked" : "unmarked"}): no list and no "No list today" on any day of the break`,
      breakDays.every((d) => !d.frozenAt && !d.noList), J(breakDays.map((d) => [d.date, d.frozenAt, d.noList])));
  }

  // ==========================================================================
  realLog("\nE. MS FROM SHADOW TO LIVE MIDWEEK, HS IN SHADOW; THE ROOM; A TARDY CLEARED, TYPED BACK AS AN ARRIVAL, COUNTED AGAIN\n");
  // ==========================================================================
  {
    const MON = "2026-12-07", TUE = "2026-12-08", WED = "2026-12-09", THU = "2026-12-10", FRI = "2026-12-11", MON2 = "2026-12-14";
    const cal = {
      [MON]: school("regular", SLOTS.mon), [TUE]: school("regular", SLOTS.tue), [WED]: school("wed", SLOTS.all),
      [THU]: school("regular", SLOTS.mon), [FRI]: school("regular", SLOTS.tue),
      "2026-12-12": { school: false }, "2026-12-13": { school: false },
      [MON2]: school("regular", SLOTS.mon), "2026-12-15": school("regular", SLOTS.tue),
    };
    const S = {};
    for (const sn of ["K1", "L1", "L2", "L5", "UL1", "W1", "W2", "W3", "G1", "X1", "G2", "Y1", "Z1"]) S[sn] = "ms";
    for (const sn of ["K2", "L3", "L4", "UL2", "W4", "W5", "W6", "G4", "X2"]) S[sn] = "hs";
    const w = await makeWorld({
      calendar: cal, students: S,
      settings: { modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: "2026-10-21", hs: "2026-10-21" } },
    });
    const at = (d, t, fn) => [LA(d, t), fn];
    const ids = {};
    const hooks = [
      ...calendarHooks(w),
      at(MON, "08:10", () => { w.mark(MON, "K1", 2, "T"); w.mark(MON, "K2", 2, "T"); }),
      // Tuesday: both in shadow; MS goes live at 18:00, counting from Wednesday.
      at(TUE, "08:30", () => { w.mark(TUE, "L1", 3, "T"); w.mark(TUE, "L4", 3, "T"); }),
      at(TUE, "12:40", () => { w.mark(TUE, "L1", 9, "A"); w.mark(TUE, "L4", 8, "A"); }),
      at(TUE, "13:00", async () => { await w.uniform("UL1"); await w.uniform("UL2"); }),
      at(TUE, "13:50", () => { w.mark(TUE, "L1", 7, "A"); w.mark(TUE, "L4", 7, "A"); }),
      at(TUE, "14:10", () => { w.mark(TUE, "L2", 7, "T"); w.mark(TUE, "L3", 7, "T"); }),
      at(TUE, "18:00", () => w.setMode("ms", "live", WED)),
      at(TUE, "19:00", () => w.mark(TUE, "L5", 3, "T")),
      // Wednesday: MS live, HS shadow.
      at(WED, "08:10", () => { for (const sn of ["W1", "W2", "W4", "W5", "W6"]) w.mark(WED, sn, 2, "T"); }),
      at(WED, "08:20", () => { ids.g1 = w.mark(WED, "G1", 2, "T"); ids.g4 = w.mark(WED, "G4", 2, "T"); }),
      at(WED, "09:10", () => w.mark(WED, "W3", 4, "T")),
      at(WED, "11:21", () => w.unmark(ids.g4)),                                  // G4's mark deleted ...
      at(WED, "11:23", async () => { const r = await w.readNow(); if (!r.ok) throw new Error(J(r)); }),   // ... and read before HS is pulled
      at(WED, "12:40", () => {
        w.unmark(ids.g1);                                                          // G1's deleted after MS was pulled
        w.mark(WED, "W2", 9, "A"); w.mark(WED, "W3", 9, "A"); w.mark(WED, "W4", 8, "A"); w.mark(WED, "W6", 8, "A");
      }),
      at(WED, "12:44", async () => { for (const sn of ["W1", "W3", "W5"]) await w.notHere(WED, sn); }),
      at(WED, "12:45", () => w.attendanceDone(WED)),
      at(WED, "13:10", () => {                                                     // typed back, now as arrivals
        w.mark(WED, "G1", 2, "T"); ids.g1pt = w.mark(WED, "G1", 1, "A");
        w.mark(WED, "G4", 2, "T"); ids.g4pt = w.mark(WED, "G4", 1, "A");
      }),
      at(WED, "13:50", () => { w.mark(WED, "W2", 6, "A"); w.mark(WED, "W4", 6, "A"); }),
      at(WED, "14:30", () => { w.unmark(ids.g1pt); w.unmark(ids.g4pt); }),      // ... and counted again
      // Thursday: the room did not run.
      at(THU, "08:00", () => { ids.g2 = w.mark(THU, "G2", 2, "T"); }),
      at(THU, "08:10", () => { w.mark(THU, "X1", 2, "T"); w.mark(THU, "X2", 2, "T"); }),
      at(THU, "09:00", () => w.unmark(ids.g2)),
      at(THU, "09:40", () => { w.mark(THU, "G2", 2, "T"); ids.g2pt = w.mark(THU, "G2", 1, "A"); }),
      at(THU, "10:45", () => w.unmark(ids.g2pt)),
      at(THU, "12:00", async () => { const r = await w.roomDidNotRun(THU, "Supervisor out"); if (!r.ok) throw new Error(J(r)); }),
      // Friday: nothing pressed; W1 owes its carry and a new one.
      at(FRI, "08:10", () => w.mark(FRI, "Y1", 3, "T")),
      at(FRI, "09:00", () => w.mark(FRI, "W1", 3, "T")),
      at(FRI, "12:40", () => w.mark(FRI, "Y1", 9, "A")),
      at(FRI, "13:50", () => w.mark(FRI, "Y1", 7, "A")),
      at(MON2, "08:10", () => w.mark(MON2, "Z1", 2, "T")),
    ];
    await drive(w, MON, "2026-12-15", hooks);
    compare("E", w, Date.parse("2026-12-15T23:55:00Z"));
    const room = w.L.room.filter((e) => !e.ok);
    check("E: every room press the test made was accepted", room.length === 0, J(room));
  }

  // ==========================================================================
  realLog("\nE2. MS TO LIVE ON A WEDNESDAY MORNING (counting from that day); HS TO LIVE AFTER THURSDAY'S LIST (counting from Thursday)\n");
  // ==========================================================================
  {
    const TUE = "2026-12-08", WED = "2026-12-09", THU = "2026-12-10", FRI = "2026-12-11";
    const cal = {
      "2026-12-07": school("regular", SLOTS.mon), [TUE]: school("regular", SLOTS.tue), [WED]: school("wed", SLOTS.all),
      [THU]: school("regular", SLOTS.mon), [FRI]: school("regular", SLOTS.tue),
      "2026-12-12": { school: false }, "2026-12-13": { school: false }, "2026-12-14": school("regular", SLOTS.mon),
    };
    const w = await makeWorld({
      calendar: cal,
      students: { L1: "ms", L2: "ms", W7: "ms", Q1: "hs", Q2: "hs", Q3: "hs", Q4: "hs" },
      settings: { modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: "2026-10-21", hs: "2026-10-21" } },
    });
    const at = (d, t, fn) => [LA(d, t), fn];
    await drive(w, "2026-12-07", "2026-12-14", [
      ...calendarHooks(w),
      at(TUE, "08:30", () => w.mark(TUE, "L1", 3, "T")),
      at(TUE, "12:40", () => w.mark(TUE, "L1", 9, "A")),
      at(TUE, "13:50", () => w.mark(TUE, "L1", 7, "A")),       // L1's shadow carry, decided Tuesday
      at(TUE, "14:10", () => w.mark(TUE, "L2", 7, "T")),       // pending from the pilot
      at(WED, "07:50", () => w.mark(WED, "W7", 2, "T")),       // seen at 08:30, in shadow, dated Wednesday
      at(WED, "08:10", () => w.mark(WED, "L1", 2, "T")),
      at(WED, "08:40", () => w.setMode("ms", "live", WED)),
      at(THU, "08:10", () => { w.mark(THU, "Q1", 2, "T"); w.mark(THU, "Q2", 2, "T"); }),
      at(THU, "12:00", () => w.setMode("hs", "live", THU)),
      at(THU, "12:40", () => w.mark(THU, "Q2", 8, "A")),
      at(THU, "13:30", () => { w.mark(THU, "Q3", 6, "T"); w.mark(THU, "Q2", 6, "A"); }),
      at(FRI, "08:10", () => w.mark(FRI, "Q4", 3, "T")),
    ]);
    compare("E2", w, Date.parse("2026-12-14T23:55:00Z"));
  }

  // ==========================================================================
  realLog("\nB2. NO LIST ON THE FRIDAY BEFORE THANKSGIVING (POWERSCHOOL DOWN 07:00-12:30); 11/30 A MARKED STACK DAY\n");
  // ==========================================================================
  {
    const FRI = "2026-11-20", MON = "2026-11-30";
    const cal = {
      "2026-11-19": school("regular", SLOTS.mon), [FRI]: school("regular", SLOTS.tue),
      "2026-11-21": { school: false }, "2026-11-22": { school: false },
      ...Object.fromEntries(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"].map((d) => [d, { school: false, mark: { noSchool: true } }])),
      "2026-11-28": { school: false }, "2026-11-29": { school: false },
      [MON]: school("stack", SLOTS.all, { schedule: "Stack Day / Return from Holiday" }),
      "2026-12-01": school("regular", SLOTS.tue),
    };
    const w = await makeWorld({
      calendar: cal, students: { N1: "ms", N2: "hs", N3: "ms", N4: "hs" },
      settings: { modeByDivision: { ms: "live", hs: "live" }, countFromDateByDivision: { ms: "2026-11-16", hs: "2026-11-16" } },
      down: [[FRI, "07:00", "12:30"]],
    });
    const at = (d, t, fn) => [LA(d, t), fn];
    await drive(w, "2026-11-19", "2026-12-01", [
      ...calendarHooks(w),
      at(FRI, "08:00", () => w.uniform("N3")),
      at(FRI, "09:00", () => w.mark(FRI, "N1", 3, "T")),
      at(FRI, "14:00", () => w.mark(FRI, "N2", 7, "T")),
      at(MON, "09:00", () => w.mark(MON, "N4", 3, "T")),
    ]);
    const { got } = compare("B2", w, Date.parse("2026-12-01T23:55:00Z"));
    check("B2: Friday 11/20 has no list, recorded at the latest time", !!got.days[FRI]?.noList && !got.days[FRI]?.frozenAt, J(got.days[FRI]?.noList));
  }

  // ==========================================================================
  realLog("\nA2. AN UNMARKED SIX-PERIOD THURSDAY IS TREATED AS A MINIMUM DAY (spec 3.5 rule 3)\n");
  // ==========================================================================
  {
    const THU = "2026-11-12", FRI = "2026-11-13";
    const w = await makeWorld({
      calendar: { "2026-11-11": school("wed", SLOTS.all), [THU]: school("minimum", SLOTS.all), [FRI]: school("regular", SLOTS.tue), "2026-11-14": { school: false }, "2026-11-15": { school: false }, "2026-11-16": school("regular", SLOTS.mon) },
      students: { V1: "ms", V2: "hs", V3: "ms" },
      settings: { modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: "2026-10-21", hs: "2026-10-21" } },
    });
    const at = (d, t, fn) => [LA(d, t), fn];
    await drive(w, "2026-11-11", "2026-11-16", [
      ...calendarHooks(w),
      at(THU, "11:10", () => w.mark(THU, "V1", 5, "T")),
      at(THU, "11:22", () => w.mark(THU, "V2", 5, "T")),       // after an 11:20 close, before an 11:45 one
      at(THU, "12:30", () => w.mark(THU, "V3", 6, "T")),
    ]);
    compare("A2", w, Date.parse("2026-11-16T23:55:00Z"));
  }

  // ==========================================================================
  realLog("\nF2. ROOM ATTENDANCE FOR FRIDAY RECORDED ON MONDAY MORNING (MS live, HS shadow); T CHANGED TO D AND BACK AS AN ARRIVAL\n");
  // ==========================================================================
  {
    const WED = "2026-12-09", THU = "2026-12-10", FRI = "2026-12-11", MON = "2026-12-14";
    const w = await makeWorld({
      calendar: {
        [WED]: school("wed", SLOTS.all), [THU]: school("regular", SLOTS.mon), [FRI]: school("regular", SLOTS.tue),
        "2026-12-12": { school: false }, "2026-12-13": { school: false }, [MON]: school("regular", SLOTS.mon), "2026-12-15": school("regular", SLOTS.tue),
      },
      students: { R8: "ms", R9: "ms", R10: "hs", G5: "ms", G6: "hs", G7: "ms" },
      settings: { modeByDivision: { ms: "live", hs: "shadow" }, countFromDateByDivision: { ms: "2026-12-09", hs: "2026-10-21" } },
    });
    const at = (d, t, fn) => [LA(d, t), fn];
    const ids = {};
    await drive(w, WED, "2026-12-15", [
      ...calendarHooks(w),
      // (g) by code change: T -> D after the room ran, then back to T behind a Promise Time absence, then counted.
      at(WED, "08:10", () => { ids.g5 = w.mark(WED, "G5", 2, "T"); ids.g6 = w.mark(WED, "G6", 2, "T"); ids.g7 = w.mark(WED, "G7", 2, "T"); }),
      at(WED, "11:21", () => w.recode(ids.g6, "D")),
      at(WED, "11:23", async () => { const r = await w.readNow(); if (!r.ok) throw new Error(J(r)); }),   // G6 released before HS is pulled
      at(WED, "12:40", () => { w.recode(ids.g5, "D"); w.unmark(ids.g7); }),
      at(WED, "13:10", () => {
        w.recode(ids.g5, "T"); ids.g5pt = w.mark(WED, "G5", 1, "A");
        w.recode(ids.g6, "T"); ids.g6pt = w.mark(WED, "G6", 1, "A");
        w.mark(WED, "G7", 2, "T"); w.mark(WED, "G7", 1, "A");                 // G7 stays an arrival
      }),
      at(WED, "14:30", () => { w.unmark(ids.g5pt); w.unmark(ids.g6pt); }),
      // Friday: nobody records the room. R9 is absent at Power-Up and P6 (PowerSchool carries him).
      at(FRI, "08:10", () => { w.mark(FRI, "R8", 3, "T"); w.mark(FRI, "R9", 3, "T"); w.mark(FRI, "R10", 3, "T"); }),
      at(FRI, "12:40", () => w.mark(FRI, "R9", 9, "A")),
      at(FRI, "13:50", () => w.mark(FRI, "R9", 7, "A")),
      // Monday 08:00: the supervisor records Friday's room: R8 and R10 Not here, R9 there.
      at(MON, "08:00", async () => {
        for (const sn of ["R8", "R10"]) { const r = await w.notHere(FRI, sn); if (!r.ok) throw new Error(J(r)); }
        const d = await w.attendanceDone(FRI); if (!d.ok) throw new Error(J(d));
      }),
    ]);
    compare("F2", w, Date.parse("2026-12-15T23:55:00Z"));
  }

  // ==========================================================================
  realLog("\nC5. ONE DETENTION CARRIED FIVE TIMES, ACROSS A MARKED HOLIDAY (11/11), THEN ADMIN REVIEW\n");
  // ==========================================================================
  {
    const cal = {
      "2026-11-09": school("regular", SLOTS.mon), "2026-11-10": school("regular", SLOTS.tue),
      "2026-11-11": { school: false, mark: { noSchool: true } },
      "2026-11-12": school("regular", SLOTS.mon), "2026-11-13": school("regular", SLOTS.tue),
      "2026-11-14": { school: false }, "2026-11-15": { school: false },
      "2026-11-16": school("regular", SLOTS.mon), "2026-11-17": school("regular", SLOTS.tue),
      "2026-11-18": school("wed", SLOTS.all), "2026-11-19": school("regular", SLOTS.mon),
    };
    const w = await makeWorld({
      calendar: cal, students: { CL: "ms", CK: "hs" },
      settings: { modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: "2026-10-21", hs: "2026-10-21" } },
    });
    const at = (d, t, fn) => [LA(d, t), fn];
    const absentAfterLunch = Object.entries(cal).filter(([, c]) => c.school).map(([d, c]) => at(d, "13:55", () => {
      for (const slot of [9, 6, 7]) if (c.slots.includes(slot)) w.mark(d, "CL", slot, "A");
      for (const slot of [8, 6, 7]) if (c.slots.includes(slot)) w.mark(d, "CK", slot, "A");
    }));
    await drive(w, "2026-11-09", "2026-11-19", [
      ...calendarHooks(w),
      at("2026-11-09", "08:10", () => { w.mark("2026-11-09", "CL", 2, "T"); w.mark("2026-11-09", "CK", 2, "T"); }),
      ...absentAfterLunch,
    ]);
    compare("C5", w, Date.parse("2026-11-19T23:55:00Z"));
  }

  // ==========================================================================
  realLog("\nU. QUEUED UNIFORM ENTRIES: SAVED LATE, SENT OVER A WEEKEND, AND PAST THE 72-HOUR WINDOW\n");
  // ==========================================================================
  {
    const THU = "2026-11-12", FRI = "2026-11-13", MON = "2026-11-16", TUE = "2026-11-17";
    const w = await makeWorld({
      calendar: { [THU]: school("regular", SLOTS.mon), [FRI]: school("regular", SLOTS.tue), "2026-11-14": { school: false }, "2026-11-15": { school: false },
        [MON]: school("regular", SLOTS.mon), [TUE]: school("regular", SLOTS.tue) },
      students: { Q1: "ms", Q2: "hs", Q3: "ms", Q4: "hs", Q5: "ms" },
      settings: { modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: "2026-10-21", hs: "2026-10-21" } },
    });
    const at = (d, t, fn) => [LA(d, t), fn];
    await drive(w, THU, TUE, [
      ...calendarHooks(w),
      at(FRI, "08:20", () => w.uniform("Q1", LA(FRI, "07:52"))),         // saved 28 minutes late, before the list
      at(MON, "08:00", () => w.uniform("Q2", LA(FRI, "15:00"))),         // Friday's, sent Monday (65 h): Friday's entry
      at(MON, "08:05", () => w.uniform("Q3", LA(THU, "15:00"))),         // Thursday's, sent Monday (89 h): filed now
      at(MON, "11:50", () => w.uniform("Q4", LA(MON, "11:40"))),         // observed before the close, saved after it
      at(TUE, "07:40", () => w.uniform("Q5", LA(MON, "12:10"))),         // Monday after the list, sent Tuesday
    ]);
    compare("U", w, Date.parse("2026-11-17T23:55:00Z"));
  }

  // ==========================================================================
  realLog("\nO. OWES 2 TWICE IN A ROW: A CARRIED DETENTION AND A QUEUED ONE WAITING TOGETHER (spec 2.4)\n");
  // ==========================================================================
  {
    const MON = "2026-11-16", TUE = "2026-11-17", WED = "2026-11-18";
    const w = await makeWorld({
      calendar: { [MON]: school("regular", SLOTS.mon), [TUE]: school("regular", SLOTS.tue), [WED]: school("wed", SLOTS.all),
        "2026-11-19": school("regular", SLOTS.mon), "2026-11-20": school("regular", SLOTS.tue) },
      students: { OW: "ms" },
      settings: { modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: "2026-10-21", hs: "2026-10-21" } },
    });
    const at = (d, t, fn) => [LA(d, t), fn];
    await drive(w, MON, "2026-11-20", [
      ...calendarHooks(w),
      at(MON, "08:10", () => w.mark(MON, "OW", 2, "T")),                          // Monday's detention
      at(MON, "13:50", () => { w.mark(MON, "OW", 9, "A"); w.mark(MON, "OW", 6, "A"); }),   // gone after lunch: carries
      at(TUE, "08:30", () => w.mark(TUE, "OW", 3, "T")),                          // Tuesday: owes 2 (carry served, new queued)
      at(TUE, "13:50", () => { w.mark(TUE, "OW", 9, "A"); w.mark(TUE, "OW", 7, "A"); }),   // gone again: Monday's carries again
      ...(process.env.DUMP ? ["11:21", "15:00", "15:46"].map((t) => at(WED, t, () => {
        const c = w.store.rows("reflectionUnits").find((u) => u.studentNumber === "OW" && u.kind === "carry" && u.carriedFromDay === TUE);
        realLog(`        [debug] Wed ${t}: Monday's re-carried detention is ${c?.state}, tags ${J(c?.tags)}`);
      })) : []),
    ]);
    compare("O", w, Date.parse("2026-11-20T23:55:00Z"));
  }

  // ==========================================================================
  realLog("\nH. LOGGED WHILE A DIVISION IS OFF, THEN THE DIVISION SWITCHED ON COUNTING FROM THAT DAY\n");
  // ==========================================================================
  {
    // H0: both divisions off at 07:50; MS on at 08:30, counting from today (reflection-reader world 21's case).
    const MON = "2026-11-16";
    const w = await makeWorld({
      calendar: { [MON]: school("regular", SLOTS.mon), "2026-11-17": school("regular", SLOTS.tue) },
      students: { U0: "ms", M0: "ms" },
    });
    const at = (d, t, fn) => [LA(d, t), fn];
    await drive(w, MON, "2026-11-17", [
      ...calendarHooks(w),
      at(MON, "07:50", () => w.uniform("U0")),
      at(MON, "08:10", () => w.mark(MON, "M0", 2, "T")),
      at(MON, "08:30", () => w.setMode("ms", "shadow", MON)),
    ]);
    compare("H0", w, Date.parse("2026-11-17T23:55:00Z"));
  }
  {
    // H: MS in shadow all along, HS off. Monday: HS switched on at 09:00 counting from Monday.
    // Tuesday: HS rolled back to off at 06:50, switched on again at 13:00 counting from Tuesday.
    const MON = "2026-11-16", TUE = "2026-11-17", WED = "2026-11-18";
    const w = await makeWorld({
      calendar: { [MON]: school("regular", SLOTS.mon), [TUE]: school("regular", SLOTS.tue), [WED]: school("wed", SLOTS.all), "2026-11-19": school("regular", SLOTS.mon) },
      students: { MT1: "ms", MT2: "ms", MT3: "ms", UH1: "hs", HT1: "hs", HT2: "hs", UH2: "hs", HT3: "hs", HT4: "hs" },
      settings: { modeByDivision: { ms: "shadow", hs: "off" }, countFromDateByDivision: { ms: "2026-10-21", hs: null } },
    });
    const at = (d, t, fn) => [LA(d, t), fn];
    await drive(w, MON, "2026-11-19", [
      ...calendarHooks(w),
      at(MON, "07:50", () => w.uniform("UH1")),
      at(MON, "08:00", () => { w.mark(MON, "HT1", 2, "T"); w.mark(MON, "MT1", 2, "T"); }),
      at(MON, "09:00", () => w.setMode("hs", "shadow", MON)),
      at(MON, "09:10", () => w.mark(MON, "HT2", 4, "T")),
      at(TUE, "06:50", () => w.setMode("hs", "off")),
      at(TUE, "08:00", async () => { await w.uniform("UH2"); w.mark(TUE, "HT3", 3, "T"); w.mark(TUE, "MT2", 3, "T"); }),
      at(TUE, "13:00", () => w.setMode("hs", "shadow", TUE)),
      at(TUE, "13:30", () => w.mark(TUE, "HT4", 7, "T")),
      at(WED, "08:10", () => w.mark(WED, "MT3", 2, "T")),
    ]);
    compare("H", w, Date.parse("2026-11-19T23:55:00Z"));
    const ht1 = w.store.rows("reflectionTardies").find((t) => t.studentNumber === "HT1");
    const uh2 = w.store.rows("uniformViolations").find((u) => u.studentNumber === "UH2");
    realLog(`        (HT1 is stored ${ht1?.state}; UH2 is stored ${uh2?.reflectionState ?? "unstamped"})`);
  }

  // ==========================================================================
  realLog("\nM. A SWITCH CORRECTED THE SAME DAY: COUNTING FROM TOMORROW, THEN TODAY; A ROLLBACK SWITCHED BACK ON THAT AFTERNOON\n");
  // ==========================================================================
  {
    // M1 (fourth review, 2026-10-08): MS switched to live at 07:00 with no
    // date (so counting from Tuesday), corrected at 09:00 to count from
    // Monday. What was logged and seen in between counts from Monday too.
    const MON = "2026-11-09", TUE = "2026-11-10";
    const w = await makeWorld({
      calendar: { [MON]: school("regular", SLOTS.mon), [TUE]: school("regular", SLOTS.tue) },
      students: { TM: "ms", UM: "ms", TN: "ms", UN: "ms" },
      settings: { modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: "2026-10-21", hs: "2026-10-21" } },
    });
    const at = (d, t, fn) => [LA(d, t), fn];
    let first, fixed;
    await drive(w, MON, TUE, [
      ...calendarHooks(w),
      at(MON, "07:00", async () => { first = await w.setMode("ms", "live"); }),         // no date: counting from Tuesday
      at(MON, "07:50", () => w.uniform("UM")),
      at(MON, "08:10", () => w.mark(MON, "TM", 2, "T")),                             // seen at 08:30
      at(MON, "09:00", async () => { fixed = await w.setMode("ms", "live", MON); }),   // corrected: counting from today
      at(MON, "09:10", () => w.mark(MON, "TN", 2, "T")),
      at(MON, "09:15", () => w.uniform("UN")),
    ]);
    check("M1: switched on with no date, MS counts from Tuesday; corrected, from Monday",
      first?.countFromDate === TUE && fixed?.countFromDate === MON, J({ first, fixed }));
    compare("M1", w, Date.parse("2026-11-10T23:55:00Z"));
  }
  for (const backAt of ["14:00", "16:30"]) {
    // M2 (fourth review, 2026-10-08): MS live, HS in shadow. Tuesday's list
    // serves OW's carry and queues Tuesday's detention ("Owes 2"); MS is
    // rolled back after the list and switched on again that afternoon,
    // counting from Tuesday -- before the after-school read (14:00), or after
    // it (16:30), once the read has decided CA's carry while MS was off. NX
    // (a P6 tardy after the rollback) is the control.
    const MON = "2026-11-09", TUE = "2026-11-10", WED = "2026-11-11", THU = "2026-11-12";
    const w = await makeWorld({
      calendar: { [MON]: school("regular", SLOTS.mon), [TUE]: school("regular", SLOTS.tue), [WED]: school("wed", SLOTS.all), [THU]: school("regular", SLOTS.mon) },
      students: { OW: "ms", CA: "ms", NX: "ms" },
      settings: { modeByDivision: { ms: "live", hs: "shadow" }, countFromDateByDivision: { ms: MON, hs: "2026-10-21" } },
    });
    const at = (d, t, fn) => [LA(d, t), fn];
    await drive(w, MON, THU, [
      ...calendarHooks(w),
      at(MON, "08:10", () => w.mark(MON, "OW", 2, "T")),
      at(MON, "13:50", () => { w.mark(MON, "OW", 9, "A"); w.mark(MON, "OW", 6, "A"); }),    // OW carries to Tuesday
      at(TUE, "08:30", () => { w.mark(TUE, "OW", 3, "T"); w.mark(TUE, "CA", 3, "T"); }),   // OW owes 2: Tuesday's is queued
      at(TUE, "12:45", () => w.setMode("ms", "off")),                                       // the rollback, after the list
      at(TUE, "13:50", () => { w.mark(TUE, "CA", 9, "A"); w.mark(TUE, "CA", 7, "A"); }),    // CA carries
      at(TUE, "14:10", () => w.mark(TUE, "NX", 7, "T")),
      at(TUE, backAt, () => w.setMode("ms", "live", TUE)),
    ]);
    compare(`M2@${backAt}`, w, Date.parse("2026-11-12T23:55:00Z"));
  }

  // ==========================================================================
  realLog("\nT. WHY A TARDY MISSED ITS LIST: THE TAG NAMES THE REASON\n");
  // ==========================================================================
  {
    const MON = "2026-12-07", TUE = "2026-12-08", WED = "2026-12-09";
    const w = await makeWorld({
      calendar: { [MON]: school("regular", SLOTS.mon), [TUE]: school("regular", SLOTS.tue), [WED]: school("wed", SLOTS.all) },
      students: { MH: "ms", CB: "ms", RJ: "hs", LT: "ms" },
      // MH's Promise Time section has no marks until CB's absence at 09:40.
      sections: { MH: { 1: "PT-B" }, CB: { 1: "PT-B" } },
      settings: { modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: "2026-10-21", hs: "2026-10-21" } },
      // Tuesday's closing reads all fail: the fallback makes the list at 12:00.
      down: [[TUE, "11:41", "12:02"]],
    });
    const at = (d, t, fn) => [LA(d, t), fn];
    let mhPt, rjPt;
    await drive(w, MON, WED, [
      ...calendarHooks(w),
      at(MON, "09:00", () => w.mark(MON, "MH", 2, "T")),                 // held: PT-B has no marks yet
      at(MON, "09:40", () => w.mark(MON, "CB", 1, "A")),                 // PT-B's marks: released at 10:30, before the list
      at(MON, "10:40", () => { mhPt = w.mark(MON, "MH", 1, "A"); }),     // absent at Promise Time: an arrival at the close
      at(MON, "12:30", () => w.recode(mhPt, "P")),                       // corrected after the list: counts from 13:00
      at(TUE, "08:40", () => { rjPt = w.mark(TUE, "RJ", 1, "A"); }),      // absent at Promise Time ...
      at(TUE, "09:20", () => w.mark(TUE, "RJ", 3, "T")),                 // ... so late to P2 is an arrival
      at(TUE, "12:10", () => w.mark(TUE, "LT", 3, "T")),                 // entered after the fallback list
      at(TUE, "12:30", () => w.recode(rjPt, "P")),                       // RJ's absence corrected: counts from 13:00
    ]);
    compare("T", w, Date.parse("2026-12-09T23:55:00Z"));
  }

  // ==========================================================================
  realLog("\nWIRING\n");
  // ==========================================================================
  {
    const pkg = JSON.parse(read("./package.json"));
    check("this test runs in npm test", /&& node reflection-weeks\.test\.mjs\b/.test(pkg.scripts.test));
    const src = read("./reflection-weeks.test.mjs");
    const oracleSrc = src.slice(src.indexOf("function oracle("), src.indexOf("function actual("));
    check("the oracle is its own: it calls nothing from the shipped code (no mods., no reflectionRules)",
      oracleSrc.length > 1000 && !/\bmods\.|reflectionRules|laWallToUtc/.test(oracleSrc));
  }
} finally {
  clock.real();
  console.log = realLog;
  loaded.cleanup();
}

realLog(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
