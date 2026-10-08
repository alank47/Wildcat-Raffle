// THE REFLECTION ROOM LIST, CHECKED BY A SECOND PAIR OF EYES (build spec 6 step 9, 7).
//
// The pilot's controls ("nothing countable is missing", "nothing is listed
// that should not be") cannot be judged by the system that made the list: a
// reader that drops a tardy also drops it from every count it reports. So
// this script reads PowerSchool ON ITS OWN -- its own token, its own paging,
// confirmed by reading twice -- and applies ITS OWN copy of the rules: the
// code mapping, the "arrived late to school" rule with section marks, and the
// PowerSchool carry fallback. None of it is imported from reflectionRules.ts,
// on purpose: a mistake there must not be repeated here. Enrolment comes from
// PowerSchool's CC table (dated enrolments), not from the app's roster.
//
//   node scripts/reflection-verify.mjs snapshot [--day YYYY-MM-DD]
//        At close + 1 minute (a local scheduled task). Reads today's
//        attendance and stores SALTED SHA-256 HASHES of each P1-P4 tardy key
//        (counted, held, arrival), never a student number, in
//        ~/.wildcat/reflection-verify/ (outside /private/tmp, so a reboot
//        keeps them). REFLECTION_VERIFY_DIR overrides the folder.
//
//   node scripts/reflection-verify.mjs compare --day YYYY-MM-DD
//        After school. Reads PowerSchool again for the day and the 5 school
//        days before it, pulls what the system holds through
//        `npx convex run --deployment prod reflectionList:verifyExport`
//        (parsed in this process: nothing from it is printed), and sorts
//        every difference: on the list, entered late, held, excluded by rule
//        (agrees), rule disagreement, dropped by the reader (in the close
//        snapshot but not on the list), corrected after the list was made, or
//        missing. Then the controls that must be 0 every day.
//        REFLECTION_VERIFY_DEPLOYMENT names another deployment (default prod).
//
// COUNTS ONLY, EVERYWHERE. Nothing this prints or stores names a student,
// carries a student number, or a key that could be turned back into one.
//
// A DAY WITH NO SNAPSHOT is "NOT JUDGED": it neither counts toward the clean
// run nor breaks it (spec 7). Each judged day's counts are kept beside the
// snapshot as <day>.result.json, so the clean run can be counted later.
//
// Needs PS_HOST, PS_CLIENT_ID, PS_CLIENT_SECRET, PS_SCHOOL_ID, PS_YEAR_ID and
// PS_TERM_ID in the environment. It only ever READS PowerSchool. Do not run it
// at 13:25-14:00 or 19:25-20:00 UTC, when the attendance rebuild reads.
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TZ = "America/Los_Angeles";
/** The day's slots in time order: Promise Time AM, P1-P4, Power-Up (HS 8, MS 9), P5, P6, Promise Time PM. */
export const ORDER = [1, 2, 3, 4, 5, 8, 9, 6, 7, 10];
const PERIOD_BASE = 850;
const CLASS_SLOTS = new Set([2, 3, 4, 5, 6, 7]);
const AFTER_POWER_UP = new Set([6, 7]);
const POWER_UP = new Set([8, 9]);
/** A slot "met" with at least this many rows of any code. */
export const MET_ROWS = 10;
/** A weekday with at least this many Promise Time AM rows was in session. */
export const SCHOOL_SLOT1_ROWS = 20;
const LEASE_MS = 4 * 60 * 1000;

// ===========================================================================
// PowerSchool, read on our own
// ===========================================================================

/**
 * Its own token, its own paging (count, every page, count), and its own
 * CONFIRMED read: two reads in a row, each steady (counts before and after
 * equal the rows held, no duplicates), with the same sorted ids. A teacher
 * saving mid-read (a delete plus an insert) keeps both counts equal and still
 * changes the ids, so a single steady read is not enough.
 */
export function powerSchool({ host, clientId, clientSecret, fetch = globalThis.fetch, pageSize = 100, maxReads = 4 }) {
  let token = null;
  let requests = 0;
  const base = `https://${host}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function getToken() {
    if (token) return token;
    requests++;
    const r = await fetch(`${base}/oauth/access_token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: "grant_type=client_credentials",
    });
    if (!r.ok) throw new Error(`PowerSchool refused a token (HTTP ${r.status})`);
    token = (await r.json()).access_token;
    if (!token) throw new Error("PowerSchool answered without a token");
    return token;
  }
  async function get(path, params) {
    const url = `${base}${path}?${new URLSearchParams(params).toString()}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      requests++;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${await getToken()}`, Accept: "application/json" } });
      if (r.ok) return r.json();
      if (r.status === 429 || r.status >= 500) { await sleep(500 * 2 ** attempt); continue; }
      // The path and the status only: a query string can hold a date, never more, but say less.
      throw new Error(`PowerSchool answered HTTP ${r.status} on ${path}`);
    }
    throw new Error(`PowerSchool kept failing on ${path}`);
  }
  async function count(table, q) {
    const b = await get(`/ws/schema/table/${table}/count`, { q });
    const n = Number(b?.count ?? b?.resource?.count);
    if (!Number.isFinite(n)) throw new Error(`PowerSchool gave no count for ${table}`);
    return n;
  }
  /** One pass: count, every page, count. */
  async function readOnce(table, q, projection) {
    const before = await count(table, q);
    const rows = [];
    for (let page = 1; page <= Math.ceil(before / pageSize); page++) {
      const b = await get(`/ws/schema/table/${table}`, { q, projection, pagesize: String(pageSize), page: String(page) });
      for (const x of b?.record ?? []) rows.push(x?.tables?.[table] ?? x);
    }
    const after = await count(table, q);
    return { before, after, rows };
  }
  async function readAll(table, q, projection) {
    return (await readOnce(table, q, projection)).rows;
  }
  async function readConfirmed(table, q, projection) {
    let previous = null;
    for (let i = 0; i < maxReads; i++) {
      const r = await readOnce(table, q, projection);
      const ids = r.rows.map((x) => String(x.id)).sort();
      const steady = r.before === r.after && r.after === ids.length && new Set(ids).size === ids.length;
      if (steady && previous && previous.length === ids.length && previous.every((id, k) => id === ids[k])) return r.rows;
      previous = steady ? ids : null;
    }
    throw new Error(`PowerSchool did not hold still for ${table} in ${maxReads} reads`);
  }
  return { count, readAll, readConfirmed, get requests() { return requests; } };
}

// ===========================================================================
// THE VERIFY'S OWN RULES (written from the spec, not from reflectionRules.ts)
// ===========================================================================

/** Codes by id: T/D/K by letter, "absent" by presence status (Ditching is Present, Suspended is Absent). */
export function codeBook(rows) {
  const byId = new Map();
  for (const c of rows || []) {
    byId.set(String(c.id), { code: String(c.att_code ?? "").trim().toUpperCase(), absent: String(c.presence_status_cd ?? "") === "Absent" });
  }
  if (![...byId.values()].some((c) => c.code === "T")) throw new Error("PowerSchool's attendance codes have no T");
  return byId;
}

/** The slots a CC expression covers: "8(A-E)" -> [8], "2-3(A)" -> [2, 3]. */
export function slotsOfExpression(expression) {
  const out = new Set();
  for (const m of String(expression ?? "").matchAll(/(\d+)(?:-(\d+))?\(/g)) {
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    for (let s = a; s <= b && s <= 10; s++) out.add(s);
  }
  return [...out];
}

/**
 * The school as PowerSchool holds it: who is who (students), who is enrolled
 * where and when (CC, by date: enrolled on or after dateenrolled and before
 * dateleft), and each day's rows.
 */
export function school({ codes, students, cc }) {
  const book = codeBook(codes);
  const snOf = new Map(), gradeOf = new Map();
  for (const s of students || []) {
    snOf.set(String(s.id), String(s.student_number ?? ""));
    if (s.grade_level !== undefined) gradeOf.set(String(s.student_number ?? ""), String(s.grade_level));
  }
  const enrol = new Map();   // sn -> [{ slots, section, from, to }]
  for (const r of cc || []) {
    const sn = snOf.get(String(r.studentid));
    if (!sn) continue;
    const slots = slotsOfExpression(r.expression);
    if (!slots.length) continue;
    if (!enrol.has(sn)) enrol.set(sn, []);
    enrol.get(sn).push({ slots, section: String(r.sectionid ?? ""), from: String(r.dateenrolled ?? "").slice(0, 10), to: String(r.dateleft ?? "").slice(0, 10) });
  }
  const sectionIn = (sn, slot, date) => {
    for (const e of enrol.get(sn) ?? []) {
      if (e.slots.includes(slot) && (!e.from || e.from <= date) && (!e.to || e.to > date)) return e.section || null;
    }
    return null;
  };
  return { book, snOf, gradeOf, enrol, sectionIn, hasEnrolment: (sn) => (enrol.get(sn) ?? []).length > 0 };
}

/** One school day: its rows by student and slot, which slots met, and which sections took attendance. */
export function dayOf(date, rows, sch) {
  const marks = new Map();   // sn -> Map(slot -> [{ id, code, absent }])
  const perSlot = {};
  let unmatched = 0;
  for (const r of rows || []) {
    if (String(r.att_date ?? "").slice(0, 10) !== date) continue;
    const slot = Number(r.periodid) - PERIOD_BASE;
    perSlot[slot] = (perSlot[slot] ?? 0) + 1;
    const sn = sch.snOf.get(String(r.studentid));
    if (!sn) { unmatched++; continue; }
    const c = sch.book.get(String(r.attendance_codeid)) ?? { code: "?", absent: false };
    if (!marks.has(sn)) marks.set(sn, new Map());
    const m = marks.get(sn);
    if (!m.has(slot)) m.set(slot, []);
    m.get(slot).push({ id: String(r.id), code: c.code, absent: c.absent });
  }
  const marked = new Set();
  for (const [sn, bySlot] of marks) {
    for (const slot of bySlot.keys()) {
      const sec = sch.sectionIn(sn, slot, date);
      if (sec) marked.add(`${slot}|${sec}`);
    }
  }
  return {
    date, marks, perSlot, unmatched,
    met: (slot) => (perSlot[slot] ?? 0) >= MET_ROWS,
    marksOf: (sn, slot) => marks.get(sn)?.get(slot) ?? [],
    sectionMarked: (slot, section) => marked.has(`${slot}|${section}`),
  };
}

/**
 * A class T: BETWEEN periods (counted), the student ARRIVING late to school
 * (arrival), or not knowable yet (held)?
 *
 * Counted when any earlier slot that met, and that the student is enrolled in
 * on that date, shows the student in the building: a mark that is not Absent
 * (at Promise Time AM, not T or D either: a tardy there is a late arrival), or
 * no mark in a section that took attendance. Held when nothing shows them in
 * but some section has not taken attendance yet; after school ("final") such
 * a section counts as everyone present. Otherwise an arrival. A student with
 * no enrolment at all is read without the enrolment filter, except Power-Up,
 * where nobody can tell which of the two slots is theirs.
 */
export function verdictOf(day, sch, sn, slot, { final }) {
  const enrolled = sch.hasEnrolment(sn);
  let present = false, unknown = false;
  for (const s of ORDER.slice(0, ORDER.indexOf(slot))) {
    if (!day.met(s)) continue;
    let section = null;
    if (enrolled) {
      section = sch.sectionIn(sn, s, day.date);
      if (!section) continue;
    } else if (POWER_UP.has(s)) continue;
    const ms = day.marksOf(sn, s);
    if (ms.length) {
      const here = s === 1 ? ms.some((m) => !m.absent && m.code !== "T" && m.code !== "D") : ms.some((m) => !m.absent);
      if (here) present = true;
      continue;
    }
    if (!section || day.sectionMarked(s, section) || final) present = true;
    else unknown = true;
  }
  return present ? "counted" : unknown ? "held" : "arrival";
}

/** Every class T of a day (slots 2-7; K too when the school counts ditching), with the verify's verdict. */
export function classTardies(day, sch, { final, countDitching = false }) {
  const out = [];
  for (const [sn, bySlot] of day.marks) {
    for (const [slot, ms] of bySlot) {
      if (!CLASS_SLOTS.has(slot)) continue;
      if (!ms.some((m) => m.code === "T" || (countDitching && m.code === "K"))) continue;
      out.push({ key: `${sn}|${day.date}|${slot + PERIOD_BASE}`, sn, date: day.date, slot, verdict: verdictOf(day, sch, sn, slot, { final }) });
    }
  }
  return out;
}

/**
 * The PowerSchool carry fallback, the verify's own copy (spec 3.8, 3): a
 * listed student carries when their Power-Up section took attendance, the
 * Power-Up mark is Absent, and they were NOT in class both in the last class
 * before Power-Up and the first after it. A Power-Up section with no marks
 * falls back to the whole day: every slot they are enrolled in that met (and
 * took attendance) Absent.
 */
export function carryOf(day, sch, sn) {
  const absentIn = (s) => { const ms = day.marksOf(sn, s); return ms.length > 0 && ms.every((m) => m.absent); };
  const mine = ORDER.filter((s) => day.met(s) && sch.sectionIn(sn, s, day.date));
  const pu = mine.find((s) => POWER_UP.has(s));
  if (!mine.length) return { verdict: "unknown" };
  if (!pu) {
    const any = ORDER.filter((s) => POWER_UP.has(s)).some((s) => day.met(s));
    if (!any) return { verdict: "unknown" };
    return { verdict: mine.every(absentIn) ? "carry" : "served", presentBoth: false };
  }
  const puSection = sch.sectionIn(sn, pu, day.date);
  if (!day.sectionMarked(pu, puSection)) {
    const took = mine.filter((s) => day.sectionMarked(s, sch.sectionIn(sn, s, day.date)));
    return { verdict: took.length && took.every(absentIn) ? "carry" : "served", presentBoth: false };
  }
  const before = mine.filter((s) => ORDER.indexOf(s) < ORDER.indexOf(pu) && CLASS_SLOTS.has(s)).pop();
  const after = mine.find((s) => ORDER.indexOf(s) > ORDER.indexOf(pu) && CLASS_SLOTS.has(s));
  const presentBefore = before !== undefined && !absentIn(before);
  const presentAfter = after !== undefined && !absentIn(after);
  return { verdict: absentIn(pu) && !(presentBefore && presentAfter) ? "carry" : "served", presentBoth: presentBefore && presentAfter };
}

// ===========================================================================
// Storage: salted hashes only
// ===========================================================================

export function storeDir() {
  return process.env.REFLECTION_VERIFY_DIR || join(homedir(), ".wildcat", "reflection-verify");
}

/** The salt, made once (random, 32 bytes), readable by this user only. */
export function saltOf(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, "salt");
  if (!existsSync(p)) {
    writeFileSync(p, randomBytes(32).toString("hex"), { mode: 0o600 });
    chmodSync(p, 0o600);
  }
  return readFileSync(p, "utf8").trim();
}

export const hashKey = (salt, key) => createHash("sha256").update(`${salt}|${key}`).digest("hex");

function writePrivate(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

// ===========================================================================
// Dates
// ===========================================================================

export function laToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const weekday = (d) => new Date(d + "T12:00:00Z").getUTCDay();
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The 5 school days before `day`, by the verify's own evidence: a weekday
 * whose Promise Time AM has at least 20 rows. One count request per weekday,
 * at most three weeks back.
 */
export async function schoolDaysBefore(ps, env, day, n = 5) {
  const out = [];
  for (let d = addDays(day, -1), i = 0; out.length < n && i < 21; d = addDays(d, -1), i++) {
    if (weekday(d) === 0 || weekday(d) === 6) continue;
    const c = await ps.count("attendance", `schoolid==${env.schoolId};yearid==${env.yearId};att_date==${d};periodid==${PERIOD_BASE + 1}`);
    if (c >= SCHOOL_SLOT1_ROWS) out.push(d);
  }
  return out.sort();
}

async function readSchool(ps, env, dates) {
  const yq = `schoolid==${env.schoolId};yearid==${env.yearId}`;
  const codes = await ps.readAll("attendance_code", yq, "id,att_code,presence_status_cd");
  const students = await ps.readAll("students", `schoolid==${env.schoolId}`, "id,student_number,grade_level");
  const termBase = Math.floor(Number(env.termId) / 100) * 100;
  const cc = await ps.readAll("cc", `schoolid==${env.schoolId};termid=ge=${termBase};termid=le=${termBase + 99}`,
    "id,studentid,sectionid,expression,dateenrolled,dateleft");
  const sch = school({ codes, students, cc });
  const days = {};
  for (const d of dates) {
    const rows = await ps.readConfirmed("attendance", `${yq};att_date==${d}`, "id,studentid,att_date,periodid,attendance_codeid");
    days[d] = dayOf(d, rows, sch);
  }
  return { sch, days };
}

// ===========================================================================
// snapshot: at close + 1 minute
// ===========================================================================

/**
 * Today's P1-P4 tardies as the verify sees them just after the close, as
 * salted hashes by verdict. Compared after school with what the list holds:
 * a counted tardy in here that is not on the day's list, and was not entered
 * after the closing read started, was DROPPED BY THE READER.
 */
export async function snapshot({ ps, env, day, dir = storeDir(), now = new Date(), say = console.log }) {
  const { sch, days } = await readSchool(ps, env, [day]);
  const d = days[day];
  const salt = saltOf(dir);
  const out = { day, takenAt: now.toISOString(), counted: [], held: [], arrival: [], afterPowerUp: 0, rows: Object.values(d.perSlot).reduce((a, n) => a + n, 0) };
  for (const t of classTardies(d, sch, { final: false })) {
    if (AFTER_POWER_UP.has(t.slot)) { out.afterPowerUp++; continue; }
    out[t.verdict].push(hashKey(salt, t.key));
  }
  for (const k of ["counted", "held", "arrival"]) out[k].sort();
  writePrivate(join(dir, `${day}.snapshot.json`), out);
  say(`Reflection Room verify snapshot ${day}: ${out.rows} PowerSchool rows; P1-P4 tardies counted ${out.counted.length}, `
    + `held ${out.held.length}, arrivals ${out.arrival.length}; P5-P6 ${out.afterPowerUp}. ${ps.requests} requests.`);
  return out;
}

// ===========================================================================
// compare: after school
// ===========================================================================

/** What the system holds, from `npx convex run`, parsed here. stdout is never echoed. */
export function exportFromConvex(day, { cwd, deployment = process.env.REFLECTION_VERIFY_DEPLOYMENT || "prod" } = {}) {
  return new Promise((resolve, reject) => {
    execFile("npx", ["convex", "run", "--deployment", deployment, "reflectionList:verifyExport", JSON.stringify({ day })],
      { cwd, maxBuffer: 64 * 1024 * 1024, env: process.env },
      (err, stdout) => {
        if (err) { reject(new Error(`npx convex run reflectionList:verifyExport failed (exit ${err.code ?? "?"})`)); return; }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error("verifyExport did not answer with JSON")); }
      });
  });
}

const CATEGORIES = [
  ["onList", "on the list"],
  ["earlierList", "on an earlier list"],
  ["enteredLate", "entered late (on a later list or pending)"],
  ["nextList", "P5-P6 of the day, waiting for the next list"],
  ["noList", "waiting: no list was made"],
  ["held", "held for attendance"],
  ["review", "in admin review"],
  ["excluded", "excluded by rule (agrees)"],
  ["disagree", "rule disagreement"],
  ["dropped", "dropped by the reader"],
  ["corrected", "corrected after the list was made"],
  ["missing", "missing"],
];
const CONTROLS = [
  ["slotNotClass", "listed tardies from Promise Time or Power-Up"],
  ["codeNotT", "listed items whose code is not T (D or K)"],
  ["future", "listed items dated after the list day"],
  ["sameDayAfterPowerUp", "P5-P6 tardies listed the day they happened"],
  ["arrivalListed", "arrival tardies listed"],
  ["twoLists", "a key on two lists"],
  ["voidedListed", "uniform entries voided before the list, listed"],
  ["beforeStart", "items dated before countFromDate listed"],
  ["missing", "missing"],
  ["dropped", "dropped by the reader"],
  ["disagree", "rule disagreements"],
  ["closingWindow", "a list made by a read outside the closing window"],
  ["afterLatest", "a list made after the latest freeze time"],
  ["noSchoolList", "a list made on a no-school day or an unmarked weekend"],
  ["lateTooSoon", "tardies sent to review as late with fewer lists than the setting"],
  ["carryPresentBoth", "fallback carries for a student in class both before and after Power-Up"],
  ["standardTimeDrift", "a standard-time closing read more than 5 minutes off the close"],
];

/**
 * Sort every difference between PowerSchool (as the verify reads it) and the
 * list (as the system holds it). Pure: PowerSchool days and the export in,
 * counts out. Keys are compared in memory and never leave this function.
 */
export function judge({ day, days, sch, exp, snap, salt }) {
  const c = Object.fromEntries(CATEGORIES.map(([k]) => [k, 0]));
  const ctl = Object.fromEntries(CONTROLS.map(([k]) => [k, 0]));
  const row = exp.dayRow ?? {};
  const closeStart = row.closingReadStartedAt ? Date.parse(row.closingReadStartedAt) : null;
  const sysByKey = new Map();
  for (const t of exp.tardies ?? []) {
    if (sysByKey.has(t.key)) ctl.twoLists++;
    sysByKey.set(t.key, t);
  }
  const onDay = (t) => t.unitServeDay === day;
  // What the list was cut at: the closing read's start, or, on a day the
  // fallback made the list (no closing read), the fallback's own time (third
  // review, 2026-10-08). Without it, everything found after a fallback list
  // read as "dropped by the reader".
  const listCut = closeStart ?? (row.freezeKind === "fallback" && row.frozenAt ? Date.parse(row.frozenAt) : null);
  const seenAfterClose = (t) => listCut !== null
    && Math.max(Date.parse(t.firstSeenAt), t.firstCountableAt ? Date.parse(t.firstCountableAt) : 0) > listCut;
  const psT = new Set();

  // ---- 1. Every class T PowerSchool has, judged by the verify's own rule (marks final after school).
  for (const d of Object.values(days)) {
    for (const t of classTardies(d, sch, { final: true, countDitching: !!exp.settings?.countDitching })) {
      psT.add(t.key);
      const sys = sysByKey.get(t.key);
      if (t.verdict === "arrival") {
        // Judged by the system's STATE, never by whether it still has a
        // detention (second review, 2026-10-08). Countable, held or in review,
        // it could still be listed: a rule disagreement. Stored as an arrival,
        // before-start or cleared, the system agrees -- even when it keeps the
        // detention it was on (a tardy listed at the close and re-judged an
        // arrival after, or a cleared tardy typed back as an arrival): that
        // was "corrected after the list was made", the release metric the
        // pilot tolerates, never an "arrival tardy listed".
        const listable = sys && (sys.state === "countable" || sys.state === "held" || sys.state === "review");
        if (listable) { c.disagree++; if (onDay(sys)) ctl.arrivalListed++; }
        else if (sys && sys.unitId && sys.unitServeDay && sys.unitServeDay <= day) c.corrected++;
        else c.excluded++;
        continue;
      }
      if (!sys) { c.missing++; continue; }
      if (sys.unitServeDay === day) { c.onList++; continue; }
      if (sys.unitServeDay && sys.unitServeDay < day) { c.earlierList++; continue; }
      if (sys.unitServeDay && sys.unitServeDay > day) { c.enteredLate++; continue; }
      if (sys.state === "countable") {
        if (t.date === day && AFTER_POWER_UP.has(t.slot)) c.nextList++;
        // A division switched off when the list was made has no list that
        // day: its tardies wait, stored as they read, until it is switched
        // on (third review, 2026-10-08).
        else if (row.noList || !row.frozenAt || row.modeByDivision?.[sys.division] === "off") c.noList++;
        else if (t.date > day) c.enteredLate++;
        else if (sys.unitId || seenAfterClose(sys)) c.enteredLate++;
        else c.dropped++;
        continue;
      }
      if (sys.state === "held") { c.held++; continue; }
      if (sys.state === "review") { c.review++; continue; }
      if (sys.state === "before-start") {
        const from = exp.settings?.countFromDateByDivision?.[sys.division] ?? null;
        if (!from || t.date < from) c.excluded++; else c.disagree++;
        continue;
      }
      if (sys.state === "arrival") { c.disagree++; continue; }
      // cleared, while PowerSchool still says T.
      c.missing++;
    }
  }

  // ---- 2. What D's list holds that PowerSchool no longer counts.
  for (const t of exp.tardies ?? []) {
    if (!onDay(t)) continue;
    if (!CLASS_SLOTS.has(t.slot)) ctl.slotNotClass++;
    if (t.code !== "T" && !(exp.settings?.countDitching && t.code === "K")) ctl.codeNotT++;
    if (t.attDate > day) ctl.future++;
    if (t.attDate === day && AFTER_POWER_UP.has(t.slot)) ctl.sameDayAfterPowerUp++;
    const from = exp.settings?.countFromDateByDivision?.[t.division] ?? null;
    if (from && t.attDate < from) ctl.beforeStart++;
    if (!psT.has(t.key) && days[t.attDate]) {
      if (t.state === "cleared" || t.unitState === "released") c.corrected++;
      else c.disagree++;
    }
  }

  // ---- 3. The close + 1 snapshot: counted then, on the list now? Only
  // what step 1 could not see is counted here (PowerSchool no longer has the
  // mark), so nothing is counted twice.
  let judged = false;
  if (snap && salt) {
    judged = true;
    const byHash = new Map();
    for (const t of exp.tardies ?? []) if (t.attDate === day) byHash.set(hashKey(salt, t.key), t);
    const stillInPowerSchool = new Set([...psT].map((k) => hashKey(salt, k)));
    for (const h of snap.counted ?? []) {
      if (stillInPowerSchool.has(h)) continue;                                   // judged in step 1
      const t = byHash.get(h);
      if (t && onDay(t)) continue;
      if (t && (t.state === "cleared" || t.unitState === "released")) continue;   // corrected
      if (t && (seenAfterClose(t) || (t.unitServeDay && t.unitServeDay > day))) continue;   // entered late
      if (row.noList || !row.frozenAt) continue;
      c.dropped++;
    }
  }

  // ---- 4. The day itself.
  if (row.frozenAt) {
    const close = row.closeInstant ? Date.parse(row.closeInstant) : null;
    const ready = row.readyInstant ? Date.parse(row.readyInstant) : null;
    if (row.freezeKind === "closing" && closeStart !== null && close !== null && ready !== null
      && (closeStart < close || closeStart + LEASE_MS > ready)) ctl.closingWindow++;
    if (row.lastFreezeInstant && Date.parse(row.frozenAt) > Date.parse(row.lastFreezeInstant)) ctl.afterLatest++;
    const wd = weekday(day);
    if (exp.marked?.noSchool || ((wd === 0 || wd === 6) && !exp.marked?.scheduleId)) ctl.noSchoolList++;
    // Standard time: 11:45 PST is 19:45Z. A closing read more than 5 minutes off the close says the clock moved.
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "short" }).formatToParts(new Date(day + "T20:00:00Z"))
      .find((p) => p.type === "timeZoneName")?.value;
    if (offset === "PST" && row.freezeKind === "closing" && closeStart !== null && close !== null && Math.abs(closeStart - close) > 5 * 60 * 1000) {
      ctl.standardTimeDrift++;
    }
  }
  for (const u of exp.uniformsOnList ?? []) {
    if (u.voidedAt && row.frozenAt && u.voidedAt < row.frozenAt) ctl.voidedListed++;
  }
  for (const t of exp.tardies ?? []) {
    if (t.state === "review" && /^Entered very late/.test(t.reason ?? "") && t.listsBeforeSeen < (exp.settings?.lateEntryLists ?? 5)) ctl.lateTooSoon++;
  }
  // The verify's own carry fallback, for detentions PowerSchool decided.
  // Every day, the room's presses or not (second review, 2026-10-08): the
  // room decides only the live division's carries (carryBasis "room"), so in
  // the MS live week the HS shadow control's carries are still PowerSchool's,
  // and still checked, on every day the MS room records attendance.
  const d = days[day];
  if (d) {
    for (const u of exp.list ?? []) {
      if (u.state !== "carried" || u.carryBasis !== "powerschool") continue;
      if (carryOf(d, sch, u.studentNumber).presentBoth) ctl.carryPresentBoth++;
    }
  }
  ctl.missing = c.missing;
  ctl.dropped = c.dropped;
  ctl.disagree = c.disagree;
  const clean = Object.values(ctl).every((n) => n === 0);
  return { counts: c, controls: ctl, judged, verdict: !judged ? "NOT JUDGED" : clean ? "CLEAN" : "NOT CLEAN" };
}

export async function compare({ ps, env, day, dir = storeDir(), exportFn = exportFromConvex, say = console.log, now = new Date() }) {
  const before = await schoolDaysBefore(ps, env, day, 5);
  const { sch, days } = await readSchool(ps, env, [...before, day]);
  const exp = await exportFn(day);
  const snapPath = join(dir, `${day}.snapshot.json`);
  const snap = existsSync(snapPath) ? JSON.parse(readFileSync(snapPath, "utf8")) : null;
  const salt = snap ? saltOf(dir) : null;
  const res = judge({ day, days, sch, exp, snap, salt });
  const row = exp.dayRow ?? {};
  const rows = Object.values(days).reduce((a, d) => a + Object.values(d.perSlot).reduce((x, n) => x + n, 0), 0);
  const width = 60;
  const line = (label, n) => `  ${label} ${".".repeat(Math.max(2, width - label.length))} ${n}`;
  say(`Reflection Room verify ${day}: ${row.frozenAt ? `list made (${row.freezeKind})` : row.noList ? "no list made" : "no list"}`);
  say(`PowerSchool read on its own: ${Object.keys(days).length} school days, ${rows} rows, ${ps.requests} requests.`);
  for (const [k, label] of CATEGORIES) say(line(label, res.counts[k]));
  say("Controls (each must be 0):");
  for (const [k, label] of CONTROLS) say(line(label, res.controls[k]));
  say(snap ? `Close snapshot: ${snap.counted.length} counted, ${snap.held.length} held, ${snap.arrival.length} arrivals.`
    : "No close snapshot for this day: NOT JUDGED (it neither counts toward the clean run nor breaks it).");
  say(`Verdict: ${res.verdict}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivate(join(dir, `${day}.result.json`), { day, at: now.toISOString(), verdict: res.verdict, counts: res.counts, controls: res.controls });
  return res;
}

// ===========================================================================
// The command line
// ===========================================================================

function envOf() {
  const e = process.env;
  const need = ["PS_HOST", "PS_CLIENT_ID", "PS_CLIENT_SECRET", "PS_SCHOOL_ID", "PS_YEAR_ID", "PS_TERM_ID"];
  const missing = need.filter((k) => !e[k]);
  if (missing.length) throw new Error(`Set ${missing.join(", ")} first (PowerSchool, read only).`);
  return { host: e.PS_HOST, clientId: e.PS_CLIENT_ID, clientSecret: e.PS_CLIENT_SECRET, schoolId: e.PS_SCHOOL_ID, yearId: e.PS_YEAR_ID, termId: e.PS_TERM_ID };
}

export async function main(argv = process.argv.slice(2)) {
  const [mode, ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (mode !== "snapshot" && mode !== "compare") {
    console.log("Usage: node scripts/reflection-verify.mjs snapshot [--day YYYY-MM-DD]\n"
      + "       node scripts/reflection-verify.mjs compare --day YYYY-MM-DD");
    return 1;
  }
  const day = opt("--day") ?? (mode === "snapshot" ? laToday() : undefined);
  if (!day || !DAY_RE.test(day)) { console.log("--day YYYY-MM-DD is required for compare."); return 1; }
  const env = envOf();
  const ps = powerSchool({ host: env.host, clientId: env.clientId, clientSecret: env.clientSecret });
  if (mode === "snapshot") { await snapshot({ ps, env, day }); return 0; }
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const res = await compare({ ps, env, day, exportFn: (d) => exportFromConvex(d, { cwd: repo }) });
  return res.verdict === "NOT CLEAN" ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    // The message only: never a stack with a query in it.
    console.log(`Reflection Room verify failed: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
}
