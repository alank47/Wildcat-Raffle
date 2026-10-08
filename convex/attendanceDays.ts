"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { addAbsenceDay, emptyAbsenceSplit, type AbsenceSplit } from "./absenceDayRules";

/**
 * BUILD THE PER-DATE PICTURE: for every student and every date they missed
 * something, how many of their blocks ran, how many they were absent from, how
 * many they were explicitly marked present for, and how many nobody recorded.
 *
 * WHY THIS READS THE TABLE ENDPOINT RATHER THAN A NAMED QUERY. Every installed
 * named query aggregates -- attendance_summary to a distinct-date count,
 * attendance_by_section to a per-section term total -- so none of them can say
 * what happened on one date. The conclusion drawn from that was that this
 * needed a new named query, a plugin build and an install. That was wrong: the
 * table endpoint serves the nine granted Attendance fields directly, including
 * ATT_DATE, PERIODID, CCID and ATTENDANCE_CODEID, and filters on att_date. No
 * plugin work at all.
 *
 * WHICH BLOCKS RAN IS DERIVED, NOT TRANSCRIBED. For each date, the period
 * slots carrying any attendance row school-wide. Verified 2026-09-21: Monday
 * and Thursday carry slots 1, 2, 4, 6, 8, 9, 10; Tuesday and Friday carry 1,
 * 3, 5, 7, 8, 9, 10; Wednesday carries all ten -- which is the school's block
 * timetable exactly, without this file knowing anything about weekdays. A
 * transcribed schedule would be a second copy to drift, and it would be wrong
 * on an assembly day or a minimum day.
 *
 * NOTHING HERE TOUCHES EARNED VALUE, and nothing decides a verdict. It writes
 * counts; WildcatRoster.classifyAbsenceDay turns them into full or partial in
 * the browser, where a threshold the school will argue about can be changed
 * without a deploy.
 */

export const MAX_PAGES = 400;
export const PAGE = 100;

/*
 * THE YEAR IS READ IN MONTH PIECES (2026-10-02).
 *
 * Every run re-reads the whole school year, and ONE read of it stops at
 * MAX_PAGES x PAGE = 40,000 rows. Measured on 2026-10-02, about 36 school days
 * in: 21,407 rows in 215 pages, and 2 min 01 s for the whole run -- roughly
 * 600 to 660 rows a school day, so that single read would pass 40,000 around
 * mid-November, and from then on every run would refuse and every attendance
 * screen would stand still. Nothing would be lost; nothing would move either.
 *
 * So the year is read as calendar months instead, each with its own page
 * guard, and the pieces are only believed once PowerSchool's own count says
 * they add up to the year (readYearInWindows). Still a FULL rebuild every
 * time: nothing is patched, so nothing can drift. The knobs, and why:
 */
/** Pieces read at the same time. One constant, so it can drop to 2 or 1 if PowerSchool objects. */
const WINDOW_CONCURRENCY = 3;
/**
 * Every read and every count must finish inside this, measured from the start
 * of the run. Convex stops an action at 10 minutes; 6 for reading leaves at
 * least 4 for the writes, which took well under one on 2026-10-02.
 */
const READ_BUDGET_MS = 6 * 60 * 1000;
/** Convex's own limit, for the comparison's "is there time left" check. */
const ACTION_LIMIT_MS = 10 * 60 * 1000;
/** Reads of one piece before a piece that will not hold still is given up on. */
const WINDOW_ATTEMPTS = 3;
/** Rounds of "count the year, re-check every piece" before a mismatch is final. */
const SETTLE_ROUNDS = 4;
/**
 * The days teachers are still typing into. From today minus this onward is one
 * small piece read LAST, so an entry made mid-read costs a re-read of about ten
 * seconds rather than of a whole month.
 */
const LIVE_DAYS = 2;
/** A real run that refuses, fails or is killed runs once more this much later. */
const RETRY_AFTER_MS = 15 * 60 * 1000;
/** Today's fields plus id (to de-duplicate and to prove) and yearid (to check). Both are granted. */
const ATT_FIELDS = "id,yearid,studentid,att_date,periodid,attendance_codeid,ccid";
/**
 * Four times the pages means four times the chance of one hiccup. A page that
 * answers 429 or 5xx, or drops the connection, is asked again -- twice, inside
 * the budget. The count proof still decides whether the result is believed.
 */
const PAGE_RETRIES = 2;
const RETRY_PAUSE_MS = 1000;
/** How every refusal ends, so nobody has to wonder what it did to the screens. */
const NOTHING_WRITTEN = "Nothing was written; the previous tables are untouched.";
/**
 * And what happens next, when nothing is booked: a retry, a dry run, or a run
 * whose retry could not be booked (review, 2026-10-02). Said by the one way
 * out at the bottom of rebuild, never inside a refusal, because a refusal
 * cannot know whether its run booked a retry.
 */
const NO_RETRY = "Nothing runs again until the next scheduled rebuild.";
/**
 * PowerSchool's count of the year's rows that HAVE a date: every dated piece's
 * clause is a date comparison, so this is the most the pieces can hold. No
 * school year has attendance before 1900.
 */
const DATED_FROM = "1900-01-01";

function basic(input: string): string {
  return Buffer.from(input, "utf8").toString("base64");
}

export async function token(host: string, id: string, secret: string): Promise<string> {
  const res = await fetch(`https://${host}/oauth/access_token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic(`${id}:${secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PowerSchool auth failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

/**
 * Page a table read to exhaustion, and say so when it hits the wall.
 *
 * PAGESIZE IS CAPPED AT 100 by the endpoint and answers HTTP 400 above it,
 * which reads exactly like a permissions refusal and is not one. And page
 * exhaustion must never be silent: a table that outgrows MAX_PAGES would sync
 * short and look complete, which is the failure that broke clearRoster and the
 * grade sync.
 */
export async function readTable(
  host: string, tok: string, table: string, q: string, projection: string,
): Promise<{ rows: any[]; pages: number; pagedOut: boolean }> {
  const rows: any[] = [];
  let page = 1;
  for (; page <= MAX_PAGES; page++) {
    const url = `https://${host}/ws/schema/table/${table}`
      + `?q=${encodeURIComponent(q)}&projection=${encodeURIComponent(projection)}&pagesize=${PAGE}&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`${table} read failed on page ${page}: HTTP ${res.status} ${body}`);
    }
    const b = await res.json();
    const batch = (b?.record ?? []).map((r: any) => r.tables?.[table] ?? r);
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return { rows, pages: page, pagedOut: page > MAX_PAGES };
}

// ---------------------------------------------------------------------------
// THE MONTH-PIECE READ (2026-10-02). Plain functions and no imports, because
// the tests load this file with its imports stripped and run it for real.
// ---------------------------------------------------------------------------

/** Today in Los Angeles. A copy of attendanceRunChart's: importing that would be circular. */
function laToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}
/**
 * A time as the school reads it, "Oct 2, 6:47 AM" (review, 2026-10-03, round
 * 4): a copy of sisStats' laTime, for the same reason. A reason reaches the
 * card's headline and the command line, and a raw UTC timestamp there is
 * seven hours off to anyone who reads it as a clock.
 */
function laTime(iso: string): string {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "an unknown time";
  return new Date(t).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}
function nextMonthStart(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

type Win = { from: string | null; to: string | null; live: boolean };

/**
 * Cut the year into pieces: one per calendar month, and a cut at today minus
 * LIVE_DAYS so the days still being typed into are a piece of their own.
 *
 * THE ENDS ARE OPEN, and that is the whole coverage argument. The first piece
 * has no lower date and the last has no upper date, so a row dated before the
 * first day, after the last day, or into the future -- PowerSchool does all
 * three -- is inside a piece by construction. Each piece ends the day before
 * the next begins and ge/le are both inclusive, so nothing falls between.
 *
 * NOTHING AFTER THE LIVE CUT IS SPLIT. Everything from it on is one piece
 * bounded only below: a month that has not happened yet is a request that
 * reads nothing. A year whose live cut is not after its first day (its first
 * two days) is ONE piece with no date at all -- exactly the old single query.
 */
export function planWindows(firstDay: string, lastDay: string | null, today: string): Win[] {
  const liveFrom = addDays(today, -LIVE_DAYS);
  const cuts: string[] = [];
  for (let m = nextMonthStart(firstDay); m <= liveFrom && (!lastDay || m <= lastDay); m = nextMonthStart(m)) {
    cuts.push(m);
  }
  if (liveFrom > firstDay && !cuts.includes(liveFrom)) cuts.push(liveFrom);
  cuts.sort();
  const out: Win[] = [];
  for (let k = 0; k <= cuts.length; k++) {
    const from = k === 0 ? null : cuts[k - 1];
    const to = k === cuts.length ? null : addDays(cuts[k], -1);
    out.push({ from, to, live: to === null });
  }
  return out;
}

/** The old year query, plus a date range. yearid stays in EVERY piece: last year is never read. */
function windowQuery(schoolid: string, yearid: string, w: Win): string {
  const q = [`schoolid==${schoolid}`, `yearid==${yearid}`];
  if (w.from) q.push(`att_date=ge=${w.from}`);
  if (w.to) q.push(`att_date=le=${w.to}`);
  return q.join(";");
}
function windowName(w: Win): string {
  if (w.from && w.to) return `${w.from} to ${w.to}`;
  if (w.from) return `${w.from} onward`;
  if (w.to) return `up to ${w.to}`;
  return "the whole year";
}

/** A refusal: the run stops before anything is cleared, and says why in plain words. */
class Refusal extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The ONE place the read budget is checked, so a test can prove it is what stops a slow run. */
function pastDeadline(deadline: number): boolean {
  return Date.now() > deadline;
}
function budgetRefusal(deadline: number): Refusal {
  const s = Math.round((Date.now() - (deadline - READ_BUDGET_MS)) / 1000);
  return new Refusal("budget", `Reading took ${s} s, past the ${READ_BUDGET_MS / 60000}-minute budget that keeps `
    + `room for the writes inside Convex's 10-minute limit. ${NOTHING_WRITTEN} If this keeps happening, the `
    + `read has to be split across runs.`);
}

/**
 * One GET to PowerSchool, inside the budget, asked again on a hiccup.
 *
 * NO REQUEST OUTLIVES THE BUDGET (review, 2026-10-02). The deadline used to be
 * checked only BETWEEN requests, so one page PowerSchool never answered held
 * the whole run past it -- to Node's own 300-second timeout or Convex's
 * 10-minute kill, which records nothing. Each request now carries a timeout at
 * the deadline: a request still open then is abandoned and the run refuses
 * 'budget' like any other slow read.
 *
 * EXPORTED (2026-10-08), with countRows, readWindow and sameList, for the
 * Reflection Room reader (reflectionRead.ts), which reads one school day the
 * same proven way rather than through a second copy. Export only: nothing in
 * these four changed.
 */
export async function psGet(url: string, tok: string, deadline: number, what: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    if (pastDeadline(deadline)) throw budgetRefusal(deadline);
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    let res: any;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" }, signal });
    } catch (e: any) {
      if (signal.aborted || pastDeadline(deadline)) throw budgetRefusal(deadline);
      if (attempt < PAGE_RETRIES) { await pause(RETRY_PAUSE_MS * 2 ** attempt); continue; }
      throw new Error(`${what} failed: ${String(e?.message || e)}`);
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch (e) {
        // The timeout covers the body too: a body still arriving at the deadline is the same refusal.
        if (signal.aborted || pastDeadline(deadline)) throw budgetRefusal(deadline);
        throw e;
      }
    }
    if ((res.status === 429 || res.status >= 500) && attempt < PAGE_RETRIES) {
      const asked = Number(res.headers?.get?.("retry-after"));
      const wait = Number.isFinite(asked) && asked > 0 ? asked * 1000 : RETRY_PAUSE_MS * 2 ** attempt;
      if (Date.now() + wait > deadline) {
        throw new Error(`${what}: PowerSchool answered HTTP ${res.status} and asked for a wait past the read budget`);
      }
      await pause(wait);
      continue;
    }
    const body = (await res.text()).slice(0, 200);
    throw new Error(`${what} failed: HTTP ${res.status} ${body}`);
  }
}

/**
 * PowerSchool's own count of the rows a query matches. WITHOUT IT THERE IS NO
 * PROOF, so an unreadable count throws rather than reading as zero.
 */
export async function countRows(host: string, tok: string, table: string, q: string, deadline: number): Promise<number> {
  const b = await psGet(`https://${host}/ws/schema/table/${table}/count?q=${encodeURIComponent(q)}`,
    tok, deadline, `the count of ${table} (${q})`);
  const raw = b?.count ?? b?.resource?.count;
  const n = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`PowerSchool's count of ${table} for ${q} came back unreadable `
      + `(${JSON.stringify(b).slice(0, 120)}), so nothing can be proved.`);
  }
  return n;
}

/**
 * One piece, paged to exhaustion like readTable -- same PAGE, same MAX_PAGES
 * guard -- but held BY ROW ID. A row served twice across a page boundary is
 * counted once (and the repeat is reported), and a row with no id stops the
 * run: without ids there is nothing to prove.
 */
export async function readWindow(host: string, tok: string, q: string, deadline: number, abort: { stop: boolean }) {
  const t = Date.now();
  const rows = new Map<string, any>();
  let duplicates = 0;
  let page = 1;
  for (; page <= MAX_PAGES; page++) {
    if (abort.stop) throw new Error("stopped because another piece failed");
    const url = `https://${host}/ws/schema/table/attendance`
      + `?q=${encodeURIComponent(q)}&projection=${encodeURIComponent(ATT_FIELDS)}&pagesize=${PAGE}&page=${page}`;
    const b = await psGet(url, tok, deadline, `attendance (${q}) page ${page}`);
    const batch = (b?.record ?? []).map((r: any) => r.tables?.attendance ?? r);
    for (const r of batch) {
      const key = r?.id === null || r?.id === undefined ? "" : String(r.id);
      if (!key) throw new Error(`an attendance row came back without its id (${q}, page ${page}), so the pieces cannot be proved`);
      if (rows.has(key)) duplicates++;
      rows.set(key, r);
    }
    if (batch.length < PAGE) break;
  }
  return { rows, pages: page, pagedOut: page > MAX_PAGES, duplicates, ms: Date.now() - t };
}

/**
 * At most `n` at once. A failure stops the rest from starting another page,
 * and is only reported once every request already in flight has come back --
 * so the run never returns with PowerSchool still being read behind it.
 */
async function pool<T, R>(items: T[], n: number, abort: { stop: boolean }, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown = null;
  const worker = async () => {
    while (!abort.stop && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (e) {
        if (!failed) { failed = true; failure = e; }
        abort.stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  if (failed) throw failure;
  return out;
}

/** Every row must be this year's, and inside its piece's dates: proof the filters were applied. */
function checkPiece(rows: Map<string, any>, w: Win, yearid: string): void {
  for (const r of rows.values()) {
    if (String(r.yearid ?? "") !== String(yearid)) {
      throw new Refusal("filter", `PowerSchool returned an attendance row from year ${String(r.yearid ?? "(none)")} `
        + `in the read of year ${yearid}, so it did not apply the year filter. ${NOTHING_WRITTEN}`);
    }
    if (w.from === null && w.to === null) continue;
    // A blank date is not inside ANY dated piece. "" sorts before every date,
    // so without the shape check it would pass "on or before the 31st".
    const d = String(r.att_date ?? "").slice(0, 10);
    if (!ISO_DAY.test(d) || (w.from !== null && d < w.from) || (w.to !== null && d > w.to)) {
      throw new Refusal("filter", `PowerSchool did not apply the month filter: the piece ${windowName(w)} `
        + `came back with a row dated "${d}". ${NOTHING_WRITTEN}`);
    }
  }
}

/** Two sorted id lists hold exactly the same ids. */
export function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

type Piece = {
  w: Win; q: string; held: Map<string, any>; count: number;
  attempts: number; pages: number; ms: number; duplicates: number;
};

function firstOverlap(pieces: Piece[]): string | null {
  const seen = new Set<string>();
  for (const p of pieces) {
    for (const id of p.held.keys()) {
      if (seen.has(id)) return id;
      seen.add(id);
    }
  }
  return null;
}

/**
 * THE WHOLE YEAR, IN MONTH PIECES, PROVED TO BE THE WHOLE YEAR.
 *
 * WHAT IS PROVED, exactly. PowerSchool's own count of the old one-read query
 * (`schoolid==S;yearid==Y`) is taken before the first piece and again after
 * the last, and the run goes on only when both equal the number of distinct
 * rows the pieces hold, no row id sits in two pieces, and every row is this
 * year's and inside its piece's dates. Each piece is counted just before and
 * just after it is read, and is taken only when both counts equal what was
 * read. A delete and an insert during one read leave both counts right and
 * the rows wrong -- the read keeps the deleted row and the page shift skips
 * the next one -- and only a second read can see that, so: the LIVE piece,
 * where teachers are typing, is always read at least twice and taken only
 * when a steady read returns the very same row ids as the read before it;
 * and any piece read again in the same round is held to the same rule.
 * The one exception to "the pieces hold the year" is rows with NO date,
 * which no dated piece can hold: accepted only when PowerSchool's count of
 * the year's dated rows equals what the pieces hold, and reported.
 *
 * WHAT IT DOES NOT PROVE: that no row's CONTENT was edited while it was read;
 * and, in a CLOSED month read once, a delete and an insert in that month
 * during its one read (an office correction landing mid-read): the count
 * nets out and there is no second read to compare, so one row can be wrong
 * until the next run. The old single read had both gaps, in every month, and
 * the next run, a few hours later, reads it all again from scratch.
 *
 * LOAD. Never more than WINDOW_CONCURRENCY requests in flight, counts
 * included; the live piece is read last and alone.
 *
 * Anything that does not add up throws a Refusal, before anything is cleared.
 *
 * PROGRESS IS WRITTEN AS IT HAPPENS (review, 2026-10-02) into `progress` --
 * the run's own record -- after every piece read: which pieces were read, in
 * how many pages and seconds, and the pieces' own wall time. A run refused
 * halfway ('budget', 'changing') is exactly the one somebody has to diagnose,
 * and it used to record none of it.
 */
async function readYearInWindows(
  host: string, tok: string, schoolid: string, yearid: string, today: string, deadline: number,
  progress: Record<string, any> = {},
): Promise<Record<string, any>> {
  const t = Date.now();
  // (a) Where the months fall: the year term, the same read the run chart
  //     already makes. The boundaries only decide the SIZE of the pieces --
  //     correctness comes from the count -- so a terms table that cannot be
  //     read falls back to calendar months from 1 August rather than freezing
  //     every attendance screen.
  let first = "";
  let last: string | null = null;
  let termsNote: string | null = null;
  try {
    const terms = await readTable(host, tok, "terms", `schoolid==${schoolid};yearid==${yearid}`, "id,firstday,lastday,isyearrec");
    const yr = terms.rows.find((r: any) => String(r.isyearrec) === "1") ?? terms.rows[0];
    first = String(yr?.firstday ?? "").slice(0, 10);
    last = String(yr?.lastday ?? "").slice(0, 10);
  } catch (e: any) {
    termsNote = `terms could not be read (${String(e?.message || e).slice(0, 120)})`;
  }
  if (!ISO_DAY.test(first)) {
    const startYear = 1990 + Number(yearid);   // PowerSchool: yearid 36 is 2026-27
    first = Number.isFinite(startYear) ? `${startYear}-08-01` : today;
    last = null;
    termsNote = termsNote || "the year term has no readable first day";
  }
  if (last !== null && !ISO_DAY.test(last)) last = null;

  const pieces: Piece[] = planWindows(first, last, today).map((w) => ({
    w, q: windowQuery(schoolid, yearid, w), held: new Map(), count: 0,
    attempts: 0, pages: 0, ms: 0, duplicates: 0,
  }));
  const yearQ = `schoolid==${schoolid};yearid==${yearid}`;
  const abort = { stop: false };
  const count = (q: string) => countRows(host, tok, "attendance", q, deadline);
  let rounds = 0;
  const detail = () => pieces.map((p) => ({
    from: p.w.from, to: p.w.to, live: p.w.live, rows: p.held.size, count: p.count,
    pages: p.pages, attempts: p.attempts, seconds: Math.round(p.ms / 100) / 10,
  }));
  const note = () => {
    const pages = pieces.reduce((n, p) => n + p.pages, 0);
    const ms = pieces.reduce((n, p) => n + p.ms, 0);
    Object.assign(progress, {
      windows: pieces.length, windowDetail: detail(), settleRounds: rounds,
      msPerPage: pages ? Math.round(ms / pages) : null,
      piecesSeconds: Math.round((Date.now() - t) / 100) / 10, termsNote,
    });
    progress.pages = Object.assign({}, progress.pages, { attendance: pages });
  };

  // THE CAP AND THE MATCH ARE PER CALL (review, 2026-10-02). They used to be
  // counted across the whole run: a piece that moved between rounds can never
  // match the ids it held before it moved, so every later round cost two reads
  // and the third round refused 'changing' without reading at all -- with
  // steady entries between rounds, not "while it was read". Now each call has
  // its own WINDOW_ATTEMPTS, and only reads inside one call must match;
  // p.attempts still counts every read, for the record.
  //
  // THE LIVE PIECE IS NEVER TAKEN ON ONE READ (review, 2026-10-02). A teacher
  // marking one child present and another absent mid-read is a delete and an
  // insert: both counts come out right, the read keeps the deleted row, and
  // the page shift skips a row that existed the whole time. Demonstrated: the
  // run said ok and wrote both mistakes. A count cannot see a swap; a second
  // read can. So the live piece is taken only when a steady read returns the
  // very same ids as the read before it -- about 15 more pages a run -- and it
  // gets one read more than a month, so it keeps as many chances to settle.
  const readPiece = async (p: Piece) => {
    const confirm = p.w.live;
    const tries = WINDOW_ATTEMPTS + (confirm ? 1 : 0);
    let prevIds: string[] | null = null;
    let before = 0, steady = false;
    for (let k = 0; k < tries; k++) {
      before = await count(p.q);
      const r = await readWindow(host, tok, p.q, deadline, abort);
      const after = await count(p.q);
      p.attempts++;
      p.pages += r.pages;
      p.ms += r.ms;
      p.duplicates += r.duplicates;
      if (r.pagedOut) {
        throw new Refusal("paged-out", `The piece ${windowName(p.w)} paged out at ${MAX_PAGES} pages `
          + `(${r.rows.size} rows), so it is truncated. ${NOTHING_WRITTEN}`);
      }
      checkPiece(r.rows, p.w, yearid);
      const ids = [...r.rows.keys()].sort();
      steady = before === after && after === r.rows.size;
      const confirmed = prevIds === null ? !confirm : sameList(prevIds, ids);
      p.held = r.rows;
      p.count = after;
      prevIds = ids;
      note();
      if (steady && confirmed) return;
    }
    // WHAT DID NOT HOLD STILL, AND WHO MIGHT BE MOVING IT (review, 2026-10-02).
    // "PowerSchool last counted 2062, the read held 2062" read as a
    // contradiction when the counts were steady and the ROWS differed; and a
    // closed month nobody edits can also move because PowerSchool served its
    // pages in a different order from one page to the next.
    const what = steady
      ? `the last read held exactly the ${p.held.size} rows PowerSchool counted, but not the same rows as the read before it`
      : `PowerSchool counted ${before} rows before the last read and ${p.count} after it, and the read held ${p.held.size}`;
    const who = p.w.live
      ? "somebody is entering attendance in it right now"
      : "somebody is changing attendance in that month, or PowerSchool is serving its pages in an unstable order";
    throw new Refusal("changing", `The piece ${windowName(p.w)} did not hold still in ${tries} reads in a row: `
      + `${what}. Probably ${who}. ${NOTHING_WRITTEN}`);
  };
  // Three at a time, then the live piece LAST and alone: the one most likely
  // to move is read when the rest are done, and re-reading it is cheap.
  const readAll = async (list: Piece[]) => {
    await pool(list.filter((p) => !p.w.live), WINDOW_CONCURRENCY, abort, readPiece);
    for (const p of list.filter((p) => p.w.live)) await readPiece(p);
  };

  const yearCounts: number[][] = [];
  let yearCount = -1;
  let held = 0;
  let undatedRows = 0;
  for (let round = 1; round <= SETTLE_ROUNDS && yearCount < 0; round++) {
    rounds = round;
    const yBefore = await count(yearQ);
    let moved = pieces;
    if (round > 1) {
      const now = await pool(pieces, WINDOW_CONCURRENCY, abort, (p) => count(p.q));
      moved = pieces.filter((p, i) => now[i] !== p.held.size);
    }
    if (moved.length) await readAll(moved);
    const yAfter = await count(yearQ);
    yearCounts.push([yBefore, yAfter]);
    held = pieces.reduce((n, p) => n + p.held.size, 0);
    const overlap = firstOverlap(pieces);
    if (yBefore === yAfter && yAfter === held && !overlap) {
      yearCount = yAfter;
      break;
    }
    // ROWS WITH NO DATE (review, 2026-10-02). A row of this year whose
    // att_date is blank is in the year's count and in no dated piece -- the
    // pieces are contiguous and open at both ends, so nothing else can fall
    // between them -- and the old single read held it only for derive() to
    // skip it ("if (!date) continue"). Refusing over it would stop every
    // attendance screen for one malformed row. So PowerSchool counts the
    // year's DATED rows: when that equals what the pieces hold, the
    // difference is exactly the undated rows, and the run goes on without
    // them, as 32b13c6 effectively did. A piece whose filter LOST rows (an
    // `le` that excludes its last day) leaves a gap too, and this count is
    // what tells the two apart: those rows have dates.
    //
    // IN ANY ROUND THE YEAR HELD STILL (review, 2026-10-03). It used to be
    // tried only in a round where no piece had moved, so with one undated
    // row, ordinary entries landing between rounds -- each round re-reading
    // the piece they landed in -- kept every round from qualifying, and the
    // run refused 'coverage' after SETTLE_ROUNDS over rows it had read. The
    // dated count is the same proof in any round: the year unchanged across
    // the round and across the dated count, and the pieces holding exactly
    // its dated rows. Anything else is simply another round.
    let dated: number | null = null;
    if (yBefore === yAfter && held < yAfter && !overlap) {
      dated = await count(`${yearQ};att_date=ge=${DATED_FROM}`);
      // The year moved while it was being counted: another round, not a verdict.
      if (await count(yearQ) !== yAfter) continue;
      if (dated === held) {
        yearCount = yAfter;
        undatedRows = yAfter - held;
        break;
      }
    }
    // NOTHING MOVED AND IT STILL DOES NOT ADD UP: a gap or an overlap in the
    // pieces themselves, which another round cannot fix.
    if (round > 1 && !moved.length && yBefore === yAfter) {
      if (overlap) {
        throw new Refusal("overlap", `Attendance row ${overlap} came back in two month pieces, so the pieces `
          + `overlap. ${NOTHING_WRITTEN}`);
      }
      if (dated !== null) {
        throw new Refusal("coverage", `PowerSchool counts ${yAfter} attendance rows for the year, ${dated} of `
          + `them with a date, but the ${pieces.length} month pieces hold ${held}, so the pieces do not cover `
          + `the year exactly. ${NOTHING_WRITTEN}`);
      }
      throw new Refusal("coverage", `PowerSchool counts ${yAfter} attendance rows for the year, but the `
        + `${pieces.length} month pieces hold ${held}, so the pieces do not cover the year exactly. ${NOTHING_WRITTEN}`);
    }
  }
  if (yearCount < 0) {
    const lastY = yearCounts.length ? yearCounts[yearCounts.length - 1][1] : -1;
    throw new Refusal("coverage", `After ${SETTLE_ROUNDS} rounds the month pieces still did not add up: `
      + `PowerSchool counts ${lastY} attendance rows for the year, the pieces hold ${held}. Attendance is `
      + `probably being entered right now. ${NOTHING_WRITTEN}`);
  }

  // The union, in piece order rather than the order the reads happened to
  // finish in. Disjoint by the check above, so its size is the year's count
  // less the rows that have no date.
  const rows: any[] = [];
  for (const p of pieces) for (const r of p.held.values()) rows.push(r);
  if (rows.length !== yearCount - undatedRows) {
    throw new Refusal("coverage", `The pieces hold ${rows.length} rows against PowerSchool's ${yearCount}`
      + `${undatedRows ? ` (${undatedRows} of them with no date)` : ""}. ${NOTHING_WRITTEN}`);
  }
  const pages = pieces.reduce((n, p) => n + p.pages, 0);
  const ms = pieces.reduce((n, p) => n + p.ms, 0);
  return {
    rows, pages, pagedOut: false,
    proof: {
      yearCount, yearCounts, windowCounts: pieces.map((p) => p.count), settleRounds: rounds, undatedRows,
      rereads: pieces.reduce((n, p) => n + p.attempts - 1, 0),
      duplicatesSeen: pieces.reduce((n, p) => n + p.duplicates, 0),
      firstDay: first, lastDay: last, termsNote,
      msPerPage: pages ? Math.round(ms / pages) : null,
    },
    windows: detail(),
    seconds: Math.round((Date.now() - t) / 100) / 10,
  };
}

/**
 * The comparison's row-by-row half. Examples carry the PowerSchool row id, its
 * date and period and the names of the fields that differ -- never a student.
 */
function compareReads(
  single: any[], pieces: any[],
  ids: { differing: string[]; onlyInSingle: string[]; onlyInWindows: string[] } = { differing: [], onlyInSingle: [], onlyInWindows: [] },
): Record<string, any> {
  const fields = ATT_FIELDS.split(",");
  const a = new Map<string, any>();
  const b = new Map<string, any>();
  let singleWithoutId = 0;
  for (const r of single) {
    const k = r?.id === null || r?.id === undefined ? "" : String(r.id);
    if (!k) { singleWithoutId++; continue; }
    a.set(k, r);
  }
  for (const r of pieces) b.set(String(r.id), r);
  const examples: Array<Record<string, any>> = [];
  const note = (kind: string, r: any, differ?: string[]) => {
    if (examples.length >= 20) return;
    examples.push({
      kind, id: String(r?.id ?? ""), att_date: String(r?.att_date ?? "").slice(0, 10),
      periodid: r?.periodid === undefined ? null : r.periodid, fields: differ || [],
    });
  };
  // A row with no date cannot be in any dated piece, by construction, and the
  // pieces' proof reports how many there are (undatedRows); it is counted
  // here apart, not as a row the pieces missed (review, 2026-10-02). And an
  // id above every id the pieces hold is a row PowerSchool created after them.
  let maxPieceId = -Infinity;
  for (const k of b.keys()) { const n = Number(k); if (Number.isFinite(n) && n > maxPieceId) maxPieceId = n; }
  let onlyInSingle = 0, onlyInWindows = 0, differing = 0, singleUndated = 0, newerInSingle = 0;
  for (const [k, r] of a) {
    const o = b.get(k);
    if (!o) {
      if (!ISO_DAY.test(String(r?.att_date ?? "").slice(0, 10))) { singleUndated++; continue; }
      onlyInSingle++;
      ids.onlyInSingle.push(k);
      if (Number(k) > maxPieceId) newerInSingle++;
      note("only in the single read", r);
      continue;
    }
    const differ = fields.filter((f) => String(r[f] ?? "") !== String(o[f] ?? ""));
    if (differ.length) { differing++; ids.differing.push(k); note("different", r, differ); }
  }
  for (const [k, r] of b) {
    if (!a.has(k)) { onlyInWindows++; ids.onlyInWindows.push(k); note("only in the month pieces", r); }
  }
  return {
    singleRows: single.length, singleDistinct: a.size, singleWithoutId, singleUndated,
    windowRows: b.size, windowRepeats: pieces.length - b.size,
    onlyInSingle, newerInSingle, onlyInWindows, differing, examples,
  };
}

/** The comparison re-reads at most this many rows by id; more than a handful is not an edit between two reads. */
const RECHECK_MAX = 20;
/** ...and gives them this long, so a slow PowerSchool cannot eat the time the record still needs. */
const RECHECK_BUDGET_MS = 60 * 1000;

/**
 * One attendance row as PowerSchool holds it NOW, or null when it holds none.
 *
 * THROUGH A DATE CLAUSE, AS THE PIECES READ (review, 2026-10-03). The
 * comparison asks this of the rows its two reads disagree on, to tell an edit
 * made between them from a fault in the pieces. Read without a date clause, a
 * PowerSchool that answered dated reads differently would hand back the
 * single read's copy and pass for an edit; read with one, it hands back the
 * pieces' copy again, and the difference stands.
 */
async function readRowNow(host: string, tok: string, yearQ: string, id: string, deadline: number): Promise<any | null> {
  const q = `${yearQ};att_date=ge=${DATED_FROM};id==${id}`;
  const url = `https://${host}/ws/schema/table/attendance`
    + `?q=${encodeURIComponent(q)}&projection=${encodeURIComponent(ATT_FIELDS)}&pagesize=${PAGE}&page=1`;
  const b = await psGet(url, tok, deadline, `attendance row ${id}`);
  const rows = (b?.record ?? []).map((r: any) => r.tables?.attendance ?? r);
  return rows.find((r: any) => String(r?.id ?? "") === id) ?? null;
}

/** Every field the rebuild reads, equal -- or both absent. */
function sameRowNow(now: any | null, single: any | null): boolean {
  if (!now || !single) return !now && !single;
  return ATT_FIELDS.split(",").every((f) => String(now[f] ?? "") === String(single[f] ?? ""));
}

/** The same rows, whatever order they were built in. */
function sameRows(a: any[], b: any[]): boolean {
  const canon = (rows: any[]) => rows.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();
  return sameList(canon(a), canon(b));
}

export const rebuild = internalAction({
  args: {
    /** Only dates on or after this, as "YYYY-MM-DD". Omit for the whole year. */
    since: v.optional(v.string()),
    /** Read and report without writing. */
    dryRun: v.optional(v.boolean()),
    /**
     * With dryRun only: ALSO make the old single read of the year and compare
     * the two, row by row and table by table. How the switch to month pieces
     * is proven on production -- possible only while the year is under 40,000.
     */
    compare: v.optional(v.boolean()),
    /** Set by the automatic retry: the run it is retrying. A retry never books another. */
    retryOf: v.optional(v.string()),
    /** By hand only: write even though the year reads under half of the last good run. */
    acceptShrink: v.optional(v.boolean()),
  },
  handler: async (ctx, { since, dryRun, compare, retryOf, acceptShrink }): Promise<Record<string, any>> => {
    const host = process.env.PS_HOST, id = process.env.PS_CLIENT_ID;
    const secret = process.env.PS_CLIENT_SECRET, schoolid = process.env.PS_SCHOOL_ID;
    const yearid = process.env.PS_YEAR_ID;
    if (!host || !id || !secret || !schoolid || !yearid) {
      return { ok: false, reason: "PowerSchool settings are not all present in this deployment." };
    }
    // A PARTIAL REBUILD IS REFUSED (review, 2026-10-02). With { since } the
    // read covers only the recent days, but every table below is CLEARED and
    // rewritten from that read -- psAttendanceDays, the totals, the day
    // totals and the perfect attendance marks would all lose every earlier
    // date. The owner: no data from this year or last may be lost. `since`
    // stays usable for measuring, with dryRun.
    if (since && dryRun !== true) {
      return {
        ok: false,
        reason: "A rebuild with { since } would replace the whole year's tables with only the days it "
          + "read, wiping every earlier date. Refused; nothing was read or written. Run it without "
          + "since, or with dryRun: true to measure.",
      };
    }
    if (compare && dryRun !== true) {
      return {
        ok: false, code: "compare-needs-dryRun",
        reason: "compare reads the whole year twice and is a measuring tool: run it with dryRun: true. "
          + "Refused; nothing was read or written.",
      };
    }

    // ONE RECORD PER RUN, WHATEVER HAPPENS (2026-10-02).
    //
    // A run used to leave no trace except the tables themselves, so a refusal
    // was found by somebody noticing a screen had not moved. Now every real
    // run notes that it started, books its own retry, and on the way out --
    // ok, refused or thrown -- writes one record to appState
    // "attendanceRebuild", which admins see in Settings > Integrations and on
    // the dashboard when something is wrong. NOT syncRuns: a write there
    // reloads every open student portal.
    //
    // THE RETRY IS BOOKED AT THE START, and cancelled on a clean finish. A run
    // that Convex kills -- the 10-minute limit, a deploy, a crash -- cannot
    // book anything on its way out, and if it died mid-write some tables are
    // short until something rewrites them. Booked up front, the rewrite comes
    // 15 minutes later instead of at the next cron, up to 18 hours away.
    const t0 = Date.now();
    const deadline = t0 + READ_BUDGET_MS;
    const runId = `att_${t0.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date(t0).toISOString();
    const real = dryRun !== true;
    const run: Record<string, any> = { stage: "read", yearid: String(yearid), pages: {} };
    // A dry run always reads in month pieces: measuring them is what it is for.
    let monthPieces = !real;
    let retryJob: any = null;
    if (real) {
      const start: any = await ctx.runMutation(internal.sisStats.noteAttendanceRebuildStart, {
        runId, startedAt, retryOf,
      });
      if (retryOf && start?.originalOk === true) {
        return { ok: true, skipped: true, reason: `The run this retry was booked for (${retryOf}) finished ok.` };
      }
      // THE SWITCH (2026-10-02). Off until the comparison has come back
      // identical on production; while off, real runs make today's single
      // read, which works until about 40,000 rows. Turned on and off with
      // sisStats:setAttendanceMonthPieces -- no deploy either way.
      monthPieces = start?.monthPieces === true;
      if (!retryOf && ctx.scheduler) {
        try {
          retryJob = await ctx.scheduler.runAfter(RETRY_AFTER_MS, internal.attendanceDays.rebuild, { retryOf: runId });
        } catch (e: any) {
          console.error("[attendance] could not book the retry:", String(e?.message || e));
        }
      }
    }

    const buildAndWrite = async (): Promise<Record<string, any>> => {
      const syncedAt = new Date().toISOString();
      run.syncedAt = syncedAt;
      const tok = await token(host, id, secret);

      // 1. WHICH CODES MEAN ABSENT. Read, never assumed: the school has 16 codes
      //    and PRESENCE_STATUS_CD is the only thing that decides. Note that
      //    "Ditching" is coded Present and "Suspended" Absent, which is why this
      //    cannot be guessed from a code letter.
      const codes = await readTable(host, tok, "attendance_code",
        `schoolid==${schoolid}`, "id,att_code,description,presence_status_cd");
      // A truncated read is the same silent failure whichever table it is in.
      if (codes.pagedOut) {
        return { ok: false, code: "codes-paged-out", reason: `attendance_code paged out at ${codes.pages} pages. ${NOTHING_WRITTEN}` };
      }
      const absentCode = new Set<string>();
      // TARDY HAS NO PRESENCE STATUS OF ITS OWN, and that is PowerSchool being
      // right rather than a gap: a tardy student IS present. But it means the
      // only thing separating "late" from "here" is the code's own description,
      // so the word is matched against the school's configuration rather than a
      // list of letters transcribed into this file. The codes it matched are
      // returned in the run summary so the mapping can be checked by eye.
      const tardyCode = new Set<string>();
      const excusedCode = new Set<string>();
      const codeMap: Array<Record<string, any>> = [];
      for (const c of codes.rows) {
        const id = String(c.id);
        const desc = String(c.description ?? "");
        const absent = String(c.presence_status_cd) === "Absent";
        const tardy = !absent && /tardy/i.test(desc);
        const excused = /excus/i.test(desc);
        if (absent) absentCode.add(id);
        if (tardy) tardyCode.add(id);
        if (excused) excusedCode.add(id);
        if ((absent || tardy) && !codeMap.some((m) => m.code === c.att_code)) {
          codeMap.push({ code: c.att_code, description: desc, counts: absent ? "absence" : "tardy", excused });
        }
      }
      if (!absentCode.size) {
        return { ok: false, code: "no-absent-codes", reason: `No absent-status attendance codes were readable. ${NOTHING_WRITTEN}` };
      }
      // A SCHOOL WITH NO TARDY CODE IS A CONFIGURATION TO REPORT, NOT TO ASSUME
      // AWAY. Silently writing zero tardies for everyone would make every
      // student look punctual and the perfect attendance list twice too long.
      const tardyCodesFound = tardyCode.size;

      // 2. ccid -> the period slot, so a row can be placed in the timetable.
      //    CC.Expression is the section expression, e.g. "2(A-E)".
      //
      //    FILTERED BY TERM, and that is not a tidy-up. Unfiltered, cc holds
      //    every enrolment this school has ever recorded: a dry run read 40,000
      //    rows, hit the 400-page wall, and still had not reached the current
      //    term -- so every one of the 15,417 attendance rows failed to map and
      //    the build produced nothing. It reported ccPagedOut: true and
      //    unmappedCc: 15417 rather than a confident zero, which is the only
      //    reason the cause took one run to find.
      const termid = process.env.PS_TERM_ID;
      if (!termid) {
        return { ok: false, code: "no-term", reason: `PS_TERM_ID is not set, so cc cannot be scoped to the term. ${NOTHING_WRITTEN}` };
      }
      //    SCOPED TO THE YEAR'S TERMS, not to the single year term. A section can
      //    be scoped to a semester or a quarter, whose TermID is a child of the
      //    year term rather than equal to it -- so filtering on the year term
      //    alone left 975 of 15,417 attendance rows unplaceable. PowerSchool
      //    numbers a year's terms within one hundred of the year id, so the range
      //    covers every term of this year and no other.
      const termBase = Math.floor(Number(termid) / 100) * 100;
      const cc = await readTable(host, tok, "cc",
        `schoolid==${schoolid};termid=ge=${termBase};termid=le=${termBase + 99}`, "id,expression");
      run.pages.cc = cc.pages;
      if (cc.pagedOut) {
        return {
          ok: false, code: "cc-paged-out",
          reason: `cc still paged out at ${cc.pages} pages for term ${termid}, so the slot map is `
            + `incomplete and every verdict would be wrong. Nothing was written.`,
          ccRows: cc.rows.length,
        };
      }
      const slotOf = new Map<string, string>();
      for (const r of cc.rows) {
        const e = String(r.expression || "").trim();
        if (e) slotOf.set(String(r.id), e);
      }

      // 3. PowerSchool's internal student id -> the student number everything
      //    else in this app joins on.
      //    entrydate comes with them: a student who enrolled in September cannot
      //    have a perfect YEAR, and without it they would appear on the same
      //    list as somebody with the whole year behind them.
      const studs = await readTable(host, tok, "students",
        `schoolid==${schoolid};enroll_status==0`, "id,student_number,entrydate");
      run.pages.students = studs.pages;
      if (studs.pagedOut) {
        return {
          ok: false, code: "students-paged-out",
          reason: `students paged out at ${studs.pages} pages, so some students' attendance would be dropped. ${NOTHING_WRITTEN}`,
        };
      }
      const numberOf = new Map<string, string>();
      const entryOf = new Map<string, string>();
      for (const r of studs.rows) {
        const n = String(r.student_number || "").trim();
        if (!n) continue;
        numberOf.set(String(r.id), n);
        const e = String(r.entrydate || "").slice(0, 10);
        if (e.length === 10) entryOf.set(n, e);
      }

      // 4. THE ATTENDANCE ITSELF: THE WHOLE YEAR, EVERY RUN. Every table below
      //    is cleared and rewritten from this read, so it has to be the whole
      //    year -- never "only the new days" -- and it has to be complete.
      //    With the switch on it is read in month pieces and proved against
      //    PowerSchool's own count (readYearInWindows); with it off, it is the
      //    single read it has always been. `since` is a measuring read only:
      //    it is refused above unless dryRun.
      const day = String(since || "").slice(0, 10);
      let att: { rows: any[]; pages: number; pagedOut: boolean };
      if (day) {
        // THIS YEAR ONLY (review, 2026-10-02). Without yearid this measuring
        // read was served last year's and next year's rows from the same
        // dates, and its counts in lastDryRun mixed the years.
        att = await readTable(host, tok, "attendance", `schoolid==${schoolid};yearid==${yearid};att_date=ge=${day}`,
          "studentid,att_date,periodid,attendance_codeid,ccid");
      } else if (!monthPieces) {
        att = await readTable(host, tok, "attendance", `schoolid==${schoolid};yearid==${yearid}`,
          "studentid,att_date,periodid,attendance_codeid,ccid");
      } else {
        // `run` is filled as the pieces are read, so a refusal records how far it got.
        run.concurrency = WINDOW_CONCURRENCY;
        const year = await readYearInWindows(host, tok, schoolid, yearid, laToday(), deadline, run);
        att = year as { rows: any[]; pages: number; pagedOut: boolean };
        Object.assign(run, {
          yearCount: year.proof.yearCount, windows: year.windows.length, windowDetail: year.windows,
          settleRounds: year.proof.settleRounds, rereads: year.proof.rereads,
          duplicatesSeen: year.proof.duplicatesSeen, msPerPage: year.proof.msPerPage,
          undatedRows: year.proof.undatedRows,
          termsNote: year.proof.termsNote, concurrency: WINDOW_CONCURRENCY,
          // The pieces' own wall time, attendance only: the figure to set beside
          // the comparison's singleSeconds. readSeconds also holds the setup reads.
          piecesSeconds: year.seconds,
        });
      }
      run.pages.attendance = att.pages;
      run.attendanceRows = att.rows.length;

      // A TRUNCATED READ MUST NOT REACH THE CLEAR.
      //
      // The cc read above refuses when it pages out, because a partial slot map
      // makes every verdict wrong. This read had no such guard, and it is the
      // more dangerous of the two: the write path below CLEARS psAbsenceDayTotals
      // before rewriting it, so a truncated read does not produce a slightly
      // wrong calendar -- it produces a permanently SHORT one, missing its most
      // recent dates, and then everything that counts school days silently
      // stops. referralPing reads exactly this table.
      //
      // It is not hypothetical and it is dated. On 2026-10-02 the year held
      // 21,407 rows after about 36 school days -- 600 to 660 a day -- and
      // MAX_PAGES 400 times PAGE 100 is 40,000, so the SINGLE read reaches the
      // wall around mid-November. The month pieces each have their own guard
      // and refuse inside readYearInWindows; this stays as the last check.
      //
      // Refusing leaves YESTERDAY'S calendar in place, which is the right
      // failure: stale and detectable beats short and silent.
      if (att.pagedOut) {
        return {
          ok: false, code: "paged-out",
          reason: `attendance paged out at ${att.pages} pages (${att.rows.length} rows), so the read is `
            + `truncated and the newest dates are missing. Nothing was written and the previous `
            + `calendar is untouched. Turn on the month-piece read (sisStats:setAttendanceMonthPieces) `
            + `rather than raising MAX_PAGES (a partial { since } rebuild is refused: it `
            + `would wipe every earlier date).`,
          attendanceRows: att.rows.length,
          attendancePages: att.pages,
        };
      }

      // 6. Each student's enrolled slots, from the table this app already syncs.
      const enrolled: Record<string, string[]> = await ctx.runQuery(
        internal.attendanceDaysRead.enrolledSlots, {},
      );
      const names: Record<string, { firstName: string; lastName: string; grade: string }> =
        await ctx.runQuery(internal.attendanceDaysRead.studentNames, {});

      // EVERYTHING THE RUN WILL WRITE IS WORKED OUT FIRST, IN MEMORY (2026-10-02).
      // It used to be computed between the writes. As one function over a set of
      // rows, the comparison runs this very code over the old single read and
      // over the month pieces and diffs what each would write -- the direct proof
      // that no screen changes -- and nothing is cleared until all of it exists.
      const derive = (rows: any[]) => {
        // 5. Which slots ran on each date, school-wide. Derived, not transcribed.
        const slotsRan = new Map<string, Set<string>>();
        // And each student's own absences and explicit presents, per date.
        type Cell = { absent: Set<string>; present: Set<string> };
        const byStudentDate = new Map<string, Cell>();
        let unmappedCc = 0, unmappedStudent = 0;
        // The per-student marks for the perfect attendance rollup, accumulated in
        // this same pass.
        //
        // THE UNEXCUSED DATES ARE RECORDED, NOT WORKED OUT LATER (2026-10-01). The
        // owner: excused tardies must not cost a child perfect attendance. A day
        // can carry an Excused Tardy in one period and a plain Tardy in another,
        // and "tardy dates minus excused tardy dates" forgives that whole day,
        // plain tardy included. Only here, block by block, is the difference
        // visible, so a date goes in unexTardy when at least one of its tardy
        // blocks is NOT excused -- and the same for absences, so the excused
        // absences switch can be exact too.
        type Marks = {
          absent: Set<string>; exAbsent: Set<string>; unexAbsent: Set<string>;
          tardy: Set<string>; exTardy: Set<string>; unexTardy: Set<string>;
        };
        const marksOf = new Map<string, Marks>();
        const marksFor = (num: string) => {
          let m = marksOf.get(num);
          if (!m) {
            m = {
              absent: new Set(), exAbsent: new Set(), unexAbsent: new Set(),
              tardy: new Set(), exTardy: new Set(), unexTardy: new Set(),
            };
            marksOf.set(num, m);
          }
          return m;
        };

        for (const r of rows) {
          const date = String(r.att_date || "").slice(0, 10);
          const slot = slotOf.get(String(r.ccid || ""));
          if (!date) continue;

          // MARKS ARE TAKEN BEFORE THE SLOT MAP, ON PURPOSE. Everything below this
          // point needs to know WHICH period a row belongs to, and drops the row
          // when the cc join fails. Perfect attendance does not: a child marked
          // absent in a section this build could not place was still marked
          // absent, and dropping that row would put them on an award list. So the
          // verdict that hands out awards does not depend on a join succeeding.
          const numAny = numberOf.get(String(r.studentid || ""));
          if (numAny) {
            const code = String(r.attendance_codeid || "");
            const isAbsent = absentCode.has(code), isTardy = tardyCode.has(code);
            if (isAbsent || isTardy) {
              const m = marksFor(numAny);
              const excused = excusedCode.has(code);
              if (isAbsent) {
                m.absent.add(date);
                if (excused) m.exAbsent.add(date); else m.unexAbsent.add(date);
              }
              if (isTardy) {
                m.tardy.add(date);
                if (excused) m.exTardy.add(date); else m.unexTardy.add(date);
              }
            }
          }

          if (!slot) { unmappedCc++; continue; }
          if (!slotsRan.has(date)) slotsRan.set(date, new Set());
          slotsRan.get(date)!.add(slot);

          const num = numberOf.get(String(r.studentid || ""));
          if (!num) { unmappedStudent++; continue; }
          const key = num + "|" + date;
          if (!byStudentDate.has(key)) byStudentDate.set(key, { absent: new Set(), present: new Set() });
          const cell = byStudentDate.get(key)!;
          if (absentCode.has(String(r.attendance_codeid || ""))) cell.absent.add(slot);
          else cell.present.add(slot);
        }

        // 7. Assemble. Only dates with at least one ABSENT block are stored: a day
        //    nobody missed anything on is not worth a row per student per day.
        type DayRow = {
          studentNumber: string; date: string; blocksThatDay: number;
          absentBlocks: number; presentBlocks: number; unrecordedBlocks: number;
          absentSlots?: string[];
        };
        const out: DayRow[] = [];
        let noEnrolment = 0;
        for (const [key, cell] of byStudentDate) {
          if (!cell.absent.size) continue;
          const sep = key.lastIndexOf("|");
          const studentNumber = key.slice(0, sep), date = key.slice(sep + 1);
          const ran = slotsRan.get(date) || new Set<string>();
          const mine = enrolled[studentNumber];
          if (!mine || !mine.length) { noEnrolment++; continue; }
          // BLOCKS THAT RAN FOR THIS STUDENT: their timetable intersected with what
          // the school actually ran that day.
          const blocks = mine.filter((s) => ran.has(s));
          const blocksThatDay = blocks.length;
          const absentBlocks = blocks.filter((s) => cell.absent.has(s)).length;
          const presentBlocks = blocks.filter((s) => !cell.absent.has(s) && cell.present.has(s)).length;
          const unrecordedBlocks = Math.max(0, blocksThatDay - absentBlocks - presentBlocks);
          if (absentBlocks === 0) continue;
          out.push({
            studentNumber, date, blocksThatDay, absentBlocks, presentBlocks, unrecordedBlocks,
            absentSlots: blocks.filter((s) => cell.absent.has(s)).sort(),
          });
        }
        // IN A FIXED ORDER (2026-10-02). The rows used to be inserted in whatever
        // order PowerSchool served them; the month pieces finish in no fixed
        // order, and a reader that caps with take() keeps the first rows on a
        // tie. By date, then student: the same order every run.
        out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
          : a.studentNumber < b.studentNumber ? -1 : a.studentNumber > b.studentNumber ? 1 : 0));

        // PER-STUDENT TOTALS, derived here from the same rows rather than
        // aggregated at read time. Attendance Watch lists the whole school in one
        // query, and re-summing 2,577 per-date rows beside psAttendance would put
        // that list near Convex's 4,096 reads and past it by spring.
        //
        // COMPONENTS, NOT A VERDICT: fullDaysStrict needs no interpretation, and
        // the misrecord days are bucketed by gap size so the browser can apply
        // whatever threshold the school settles on without a deploy.
        //
        // THE RULE ITSELF lives in absenceDayRules.ts (2026-09-23), because
        // Attendance Watch's week and month windows classify the same per-date
        // rows at read time, and two copies of it would be two answers.
        type Tot = AbsenceSplit & { studentNumber: string };
        const totals = new Map<string, Tot>();
        for (const r of out) {
          let t = totals.get(r.studentNumber);
          if (!t) {
            t = Object.assign({ studentNumber: r.studentNumber }, emptyAbsenceSplit());
            totals.set(r.studentNumber, t);
          }
          addAbsenceDay(t, r);
        }
        const totalRows = [...totals.values()];
        // --- and the same thing per DAY, for the run chart ---------------------
        // A date with no absences at all still gets no row: school may not have
        // run. 2026-09-04 and Labor Day 2026-09-07 are exactly that, and plotting
        // them as zero would invent two perfect days.
        type DayTot = {
          date: string; studentsAbsent: number; fullDaysStrict: number;
          misrecordDaysByGap: number[]; partialDays: number;
        };
        const perDay = new Map<string, DayTot>();
        for (const r of out) {
          let t = perDay.get(r.date);
          if (!t) {
            t = { date: r.date, studentsAbsent: 0, fullDaysStrict: 0,
                  misrecordDaysByGap: [0, 0, 0], partialDays: 0 };
            perDay.set(r.date, t);
          }
          t.studentsAbsent++;
          const gap = r.blocksThatDay - r.absentBlocks;
          if (gap <= 0) { t.fullDaysStrict++; continue; }
          if (r.presentBlocks >= gap) {
            const i = gap <= 1 ? 0 : gap === 2 ? 1 : 2;
            t.misrecordDaysByGap[i]++;
          } else {
            t.partialDays++;
          }
        }
        const dayRows = [...perDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

        // --- and the per-student marks rollup, for perfect attendance ----------
        //
        // A ROW FOR EVERY ENROLLED STUDENT, including the ones with nothing
        // against them. They ARE the answer: a table holding only students with
        // absences could not name a single perfect one.
        const sorted = (v: Set<string>) => [...v].sort();
        const markRows = [...new Set(numberOf.values())].sort().map((num) => {
          const m = marksOf.get(num);
          const who = names[num];
          return {
            studentNumber: num,
            firstName: who?.firstName || undefined,
            lastName: who?.lastName || undefined,
            gradeLevel: who?.grade || undefined,
            entryDate: entryOf.get(num),
            absentDates: m ? sorted(m.absent) : [],
            excusedAbsentDates: m ? sorted(m.exAbsent) : [],
            tardyDates: m ? sorted(m.tardy) : [],
            excusedTardyDates: m ? sorted(m.exTardy) : [],
            // Always written, [] included: an empty list here is a fact ("never
            // late without an excuse"), where a missing one means "not rebuilt
            // since 2026-10-01" and sends the browser to its approximation.
            unexcusedAbsentDates: m ? sorted(m.unexAbsent) : [],
            unexcusedTardyDates: m ? sorted(m.unexTardy) : [],
          };
        });
        return { slotsRan, unmappedCc, unmappedStudent, noEnrolment, out, totalRows, dayRows, markRows, marksOf };
      };

      const {
        slotsRan, unmappedCc, unmappedStudent, noEnrolment, out, totalRows, dayRows, markRows, marksOf,
      } = derive(att.rows);
      run.readSeconds = Math.round((Date.now() - t0) / 100) / 10;

      // REFUSE RATHER THAN WRITE NONSENSE. If most attendance rows could not be
      // placed in the timetable the slot map is broken, and a table of confident
      // wrong verdicts is worse than no table.
      const unmappedShare = att.rows.length ? unmappedCc / att.rows.length : 0;
      if (att.rows.length && unmappedShare > 0.15) {
        return {
          ok: false, code: "unmapped",
          reason: `${unmappedCc} of ${att.rows.length} attendance rows could not be mapped to a `
            + `period slot (${Math.round(unmappedShare * 100)}%). The cc slot map is incomplete, so `
            + `nothing was written.`,
          ccRows: cc.rows.length, ccPages: cc.pages, attendanceRows: att.rows.length, unmappedCc,
        };
      }

      const summary: Record<string, any> = {
        ok: true, syncedAt, since: day || null, dryRun: dryRun === true,
        codesRead: codes.rows.length, absentCodeIds: absentCode.size,
        ccRows: cc.rows.length, ccPages: cc.pages, ccPagedOut: cc.pagedOut,
        students: numberOf.size,
        attendanceRows: att.rows.length, attendancePages: att.pages, attendancePagedOut: att.pagedOut,
        datesSeen: slotsRan.size,
        // Named rather than silent. A row whose section or student cannot be
        // mapped is dropped, and a caller has to be able to see how many.
        unmappedCc, unmappedStudent, studentsWithNoEnrolment: noEnrolment,
        // A row whose enrolment is not in the term range is usually a section
        // the student has since left, whose attendance still happened. Reported
        // as a share so a map that breaks is distinguishable from ordinary churn.
        unmappedCcShare: att.rows.length ? Math.round(unmappedShare * 1000) / 10 : 0,
        absentDayRows: out.length,
        // How the year was read, and how long it took (2026-10-02).
        readMode: day ? "since (measuring only)" : monthPieces ? "month pieces" : "single read",
        yearCount: run.yearCount ?? null, windows: run.windows ?? null, windowDetail: run.windowDetail ?? null,
        settleRounds: run.settleRounds ?? null, rereads: run.rereads ?? null,
        duplicatesSeen: run.duplicatesSeen ?? null, msPerPage: run.msPerPage ?? null,
        undatedRows: run.undatedRows ?? null,
        concurrency: WINDOW_CONCURRENCY, readSeconds: run.readSeconds, piecesSeconds: run.piecesSeconds ?? null,
        budgetSeconds: READ_BUDGET_MS / 1000, limitSeconds: ACTION_LIMIT_MS / 1000,
      };
      // THE CODE MAPPING IS PART OF THE RESULT, not a detail. Which codes count
      // as a tardy is derived from the school's own descriptions, so the run has
      // to show its working; a school that renamed its tardy code would
      // otherwise quietly start producing twice as many perfect students.
      summary.codeMapping = codeMap;
      summary.tardyCodesFound = tardyCodesFound;
      if (!tardyCodesFound) {
        summary.warning = "No attendance code's description mentions 'tardy', so every student "
          + "will look punctual and any perfect attendance list will be too long. Check the "
          + "attendance_code table before trusting it.";
      }
      // ...AND IT GOES IN THE RUN'S OWN RECORD (review, 2026-10-02). The cron
      // throws the summary away, so a warning that lived only there reached
      // nobody: the card said "current" while the run had said the perfect
      // attendance list was wrong. The verdict raises a warning on it.
      run.tardyCodesFound = tardyCodesFound;
      run.unmappedCcShare = summary.unmappedCcShare;
      if (summary.warning) run.warning = summary.warning;
      if (dryRun === true) {
        summary.sampleShape = out.slice(0, 3).map((r) => ({ ...r, studentNumber: "(withheld)" }));
        // THE COMPARISON (2026-10-02): the old single read beside the month
        // pieces, row by row, then this run's own processing over both and the
        // four tables each would write. Judged ONLY on numbers from this one
        // run, so an edit made between two runs cannot fail it. The old read
        // is exempt from the read budget but skipped if the action is short of
        // time, and it is impossible once the year passes 40,000 rows.
        //
        // WHAT IT PROVES, AND WHAT IT DOES NOT (review, 2026-10-02). It proves
        // the READ: the pieces hold the rows the single read holds, each once.
        // The tables are made by THIS build's derive() on both sides, so a
        // processing change cannot show here -- that this build writes what
        // 32b13c6 wrote is held by the tests, not by this. And an entry made
        // in the minutes BETWEEN the two reads is not a fault in the pieces:
        // PowerSchool is counted again after the single read, and the few rows
        // the reads disagree on are read again by id, to tell the two apart.
        if (compare === true && !day) {
          const c: Record<string, any> = {
            at: new Date().toISOString(), yearCount: run.yearCount ?? null,
            // Like for like: the pieces' attendance reads against the single read's.
            piecesSeconds: run.piecesSeconds ?? null,
          };
          const left = ACTION_LIMIT_MS - (Date.now() - t0);
          if (left < 4 * 60 * 1000) {
            Object.assign(c, { possible: false, identical: null,
              reason: `not enough time left for the old single read (${Math.round(left / 1000)} s of the 10-minute limit)` });
          } else {
            const ts = Date.now();
            const single = await readTable(host, tok, "attendance", `schoolid==${schoolid};yearid==${yearid}`, ATT_FIELDS);
            Object.assign(c, {
              singleRows: single.rows.length, singlePages: single.pages, singlePagedOut: single.pagedOut,
              singleSeconds: Math.round((Date.now() - ts) / 100) / 10,
            });
            if (single.pagedOut) {
              Object.assign(c, { possible: false, identical: null,
                reason: "comparison not possible: the old single read hits the 40,000-row wall" });
            } else {
              const ids = { differing: [] as string[], onlyInSingle: [] as string[], onlyInWindows: [] as string[] };
              Object.assign(c, compareReads(single.rows, att.rows, ids));
              // PowerSchool's count straight after the single read. Not part of
              // the read budget; an unreadable count only means the verdict
              // cannot excuse a difference.
              try {
                c.yearCountAfterSingle = await countRows(host, tok, "attendance",
                  `schoolid==${schoolid};yearid==${yearid}`, t0 + ACTION_LIMIT_MS - 30 * 1000);
              } catch (e: any) {
                c.yearCountAfterSingle = null;
              }
              const a = derive(single.rows);
              const b = { out, totalRows, dayRows, markRows };
              c.tables = {
                days: sameRows(a.out, b.out), totals: sameRows(a.totalRows, b.totalRows),
                dayTotals: sameRows(a.dayRows, b.dayRows), marks: sameRows(a.markRows, b.markRows),
              };
              c.possible = true;
              // windowRepeats: no row id twice in the union. The proof refuses an
              // overlap before this point; the comparison checks it again for
              // itself rather than de-duplicating it out of sight.
              const undated = Number(run.undatedRows) || 0;
              c.identical = c.onlyInSingle === 0 && c.onlyInWindows === 0 && c.differing === 0
                && c.singleWithoutId === 0 && c.windowRepeats === 0 && c.singleUndated === undated
                && Object.values(c.tables).every(Boolean);
              const piecesProved = c.windowRows + undated === c.yearCount;
              // THE OLD READ CAN BE THE SHORT ONE. Paging a table that is being
              // written to can skip a row; the pieces are held to PowerSchool's
              // own count and the old read never was.
              //
              // SHORT OF POWERSCHOOL'S COUNT TAKEN RIGHT AFTER IT (review,
              // 2026-10-03), not of the count before it. A row deleted between
              // the two reads leaves the single read one short of the pieces and
              // exactly equal to PowerSchool's count after it: that read was
              // right, and it was blamed. An unreadable count excuses nothing.
              const oldReadShort = !c.identical && c.onlyInSingle === 0 && c.differing === 0
                && c.onlyInWindows > 0 && c.singleDistinct < c.yearCount && piecesProved
                && typeof c.yearCountAfterSingle === "number" && c.yearCountAfterSingle > c.singleDistinct;
              // OR POWERSCHOOL MOVED BETWEEN THE TWO READS: every row the single
              // read has extra is newer than every row the pieces hold, nothing
              // else differs, and the single read matches PowerSchool's count
              // taken right after it.
              //
              // AND THE SINGLE READ'S UNDATED ROWS ARE THE PIECES' undatedRows
              // (review, 2026-10-03, round 5). A dated row the pieces lost, with
              // PowerSchool's dated count losing it too, is booked as undated, so
              // the pieces still "prove"; the single read holds it with its date,
              // as a row only it has. Newest of all, it read as "entered after the
              // pieces". It is a fault in the pieces, so it stays 'different'.
              const changedBetween = !c.identical && c.onlyInSingle > 0 && c.newerInSingle === c.onlyInSingle
                && c.onlyInWindows === 0 && c.differing === 0 && c.singleWithoutId === 0 && c.windowRepeats === 0
                && c.singleUndated === undated && piecesProved && c.yearCountAfterSingle === c.singleDistinct;
              // OR AN EDIT OR A DELETE BETWEEN THE TWO READS (review, 2026-10-03).
              // An absence excused or re-dated in the minutes between them read
              // as "different: leave the month pieces off", and a delete as "the
              // OLD single read came back short". So the rows the two reads
              // disagree on -- a handful, or this does not apply -- are read once
              // more, now, by id (readRowNow), three at a time like the pieces,
              // inside their own minute. When PowerSchool's copy of every one is
              // the single read's (a deleted row: gone), PowerSchool moved, not
              // the pieces. Never a pass: the comparison is to be run again.
              //
              // OR A DELETE WHILE THE SINGLE READ PAGED (review, 2026-10-03,
              // round 4). It shifts every later page by one, so that read skips
              // a row that was there throughout -- and keeps the deleted one, so
              // the count after it still equals what it holds. The skipped row
              // is only in the pieces, and PowerSchool still holds it exactly as
              // they read it: that, too, is PowerSchool moving. Only for a row
              // the pieces ALONE hold: a row both reads hold but differently is
              // still held to the single read's copy, so a piece that reads a
              // row wrongly stays 'different'.
              let editedBetween = false;
              let skippedBySingle = 0;
              const involved = [...ids.differing, ...ids.onlyInWindows, ...ids.onlyInSingle];
              if (!c.identical && !oldReadShort && !changedBetween
                  && involved.length > 0 && involved.length <= RECHECK_MAX && involved.every((k) => /^\d+$/.test(k))
                  && c.singleWithoutId === 0 && c.windowRepeats === 0 && c.singleUndated === undated && piecesProved
                  && c.yearCountAfterSingle === c.singleDistinct && c.newerInSingle === c.onlyInSingle) {
                const bySingle = new Map<string, any>();
                for (const r of single.rows) if (r?.id !== null && r?.id !== undefined) bySingle.set(String(r.id), r);
                const until = Math.min(t0 + ACTION_LIMIT_MS - 30 * 1000, Date.now() + RECHECK_BUDGET_MS);
                const yearQ = `schoolid==${schoolid};yearid==${yearid}`;
                try {
                  const now = await pool(involved, WINDOW_CONCURRENCY, { stop: false },
                    (k) => readRowNow(host, tok, yearQ, k, until));
                  const onlyPieces = new Set(ids.onlyInWindows);
                  const byPieces = new Map<string, any>(att.rows.map((r: any) => [String(r.id), r]));
                  let matched = 0;
                  involved.forEach((k, i) => {
                    if (sameRowNow(now[i], bySingle.get(k) ?? null)) matched++;
                    else if (onlyPieces.has(k) && sameRowNow(now[i], byPieces.get(k) ?? null)) skippedBySingle++;
                  });
                  c.recheck = { rows: involved.length, matchSingle: matched, matchPieces: skippedBySingle };
                  editedBetween = matched + skippedBySingle === involved.length;
                } catch (e: any) {
                  c.recheck = { rows: involved.length, matchSingle: null, error: String(e?.message || e).slice(0, 200) };
                }
              }
              const moves = [
                c.differing ? `${c.differing} edited` : "", c.onlyInWindows ? `${c.onlyInWindows} deleted` : "",
                c.onlyInSingle ? `${c.onlyInSingle} entered` : "",
              ].filter(Boolean).join(", ");
              c.verdict = c.identical
                ? "identical: the month pieces read exactly the rows the single read does, and this build's own "
                  + "processing makes the same four tables from both"
                : oldReadShort
                  ? "the OLD single read came back short of PowerSchool's own count; the month pieces hold exactly that count"
                  : changedBetween
                    ? `PowerSchool changed between the two reads: ${c.onlyInSingle} row(s) entered after the month `
                      + "pieces were read are in the single read, which matches PowerSchool's count after it. Not a "
                      + "fault in the pieces: run the comparison again out of school hours"
                    : editedBetween && skippedBySingle
                      ? "PowerSchool changed during or between the reads; run the comparison again out of school hours. "
                        + `The single read missed ${skippedBySingle} row(s) PowerSchool still holds exactly as the month `
                        + "pieces read them (a delete while it paged shifts its later pages)"
                        + (involved.length > skippedBySingle
                          ? ", and PowerSchool's own copy of every other row the reads disagree on, read again now, is the single read's"
                          : "")
                        + ". Not a fault in the pieces"
                    : editedBetween
                      ? `PowerSchool changed between the two reads: row(s) ${moves} after the month pieces read them. `
                        + "PowerSchool's own copy of each, read again now, is the single read's, and the single read "
                        + "matches its count after it. Not a fault in the pieces: run the comparison again out of school hours"
                      : "different: leave the month pieces off and look at the examples";
            }
          }
          summary.compare = c;
          run.compare = c;
        }
        return summary;
      }

      // THE LAST CHECKS BEFORE ANYTHING IS CLEARED (2026-10-02).
      //
      // Out of time: the writes need the minutes that are left.
      if (pastDeadline(deadline)) throw budgetRefusal(deadline);
      // The write lock, and the shrink guard, are one mutation: no other run
      // may be clearing these tables, and a year that suddenly reads under half
      // of the last good run is far likelier a broken read than a real change.
      // FAIL CLOSED: anything but an explicit ok stops the run here.
      const claim: any = await ctx.runMutation(internal.sisStats.claimAttendanceRebuildWrite, {
        runId, startedAt, yearid: String(yearid),
        yearCount: typeof run.yearCount === "number" ? run.yearCount : att.rows.length,
        acceptShrink: acceptShrink === true,
      });
      if (!claim || claim.ok !== true) {
        return {
          ok: false, code: claim?.code || "lock",
          reason: `${claim?.reason || "The write lock could not be confirmed."} ${NOTHING_WRITTEN}`,
        };
      }
      run.stage = "write";
      const tw = Date.now();

      for (let pass = 0; pass < 20; pass++) {
        const r: { moreToClear?: boolean } = await ctx.runMutation(
          internal.sisStats.replaceAttendanceDays, { syncedAt, rows: [], clearFirst: true },
        );
        if (!r.moreToClear) break;
      }
      for (let i = 0; i < out.length; i += 200) {
        await ctx.runMutation(internal.sisStats.replaceAttendanceDays, {
          syncedAt, rows: out.slice(i, i + 200), clearFirst: false,
        });
      }

      for (let pass = 0; pass < 20; pass++) {
        const r: { moreToClear?: boolean } = await ctx.runMutation(
          internal.sisStats.replaceAbsenceTotals, { syncedAt, rows: [], clearFirst: true },
        );
        if (!r.moreToClear) break;
      }
      for (let i = 0; i < totalRows.length; i += 200) {
        await ctx.runMutation(internal.sisStats.replaceAbsenceTotals, {
          syncedAt, rows: totalRows.slice(i, i + 200), clearFirst: false,
        });
      }

      for (let pass = 0; pass < 20; pass++) {
        const r: { moreToClear?: boolean } = await ctx.runMutation(
          internal.sisStats.replaceAbsenceDayTotals, { syncedAt, rows: [], clearFirst: true },
        );
        if (!r.moreToClear) break;
      }
      for (let i = 0; i < dayRows.length; i += 200) {
        await ctx.runMutation(internal.sisStats.replaceAbsenceDayTotals, {
          syncedAt, rows: dayRows.slice(i, i + 200), clearFirst: false,
        });
      }

      for (let pass = 0; pass < 20; pass++) {
        const r: { moreToClear?: boolean } = await ctx.runMutation(
          internal.sisStats.replaceAttendanceMarks, { syncedAt, rows: [], clearFirst: true },
        );
        if (!r.moreToClear) break;
      }
      for (let i = 0; i < markRows.length; i += 200) {
        await ctx.runMutation(internal.sisStats.replaceAttendanceMarks, {
          syncedAt, rows: markRows.slice(i, i + 200), clearFirst: false,
        });
      }
      run.writeSeconds = Math.round((Date.now() - tw) / 100) / 10;
      run.rowsWritten = { days: out.length, totals: totalRows.length, dayTotals: dayRows.length, marks: markRows.length };

      summary.totalRows = totalRows.length;
      summary.dayRows = dayRows.length;
      summary.markRows = markRows.length;
      summary.marksWithSomething = marksOf.size;
      summary.studentsWithNoMarks = markRows.length - marksOf.size;
      summary.withoutEntryDate = markRows.filter((r) => !r.entryDate).length;
      summary.withoutName = markRows.filter((r) => !r.lastName).length;
      summary.writeSeconds = run.writeSeconds;
      return summary;
    };

    // ONE WAY OUT. Whatever buildAndWrite returned or threw is recorded, and
    // the booked retry is kept (refused, failed) or cancelled (ok, or another
    // run already writing). A failure is rethrown afterwards so Convex's log
    // keeps the stack.
    let result: Record<string, any> | null = null;
    let thrown: unknown = null;
    try {
      result = await buildAndWrite();
    } catch (e) {
      if (e instanceof Refusal) result = { ok: false, code: e.code, reason: e.message };
      else thrown = e;
    }
    const outcome: Record<string, any> = result ?? {
      ok: false, code: "failed",
      reason: `The rebuild failed while ${run.stage === "write" ? "writing" : "reading"}: `
        + `${String((thrown as any)?.message || thrown).slice(0, 300)}`
        + (run.stage === "write"
          ? " Some attendance tables may be short until a later run rewrites them."
          : ` ${NOTHING_WRITTEN}`),
    };
    const finishedAt = new Date().toISOString();
    const ok = outcome.ok === true;
    const record: Record<string, any> = {
      ...run, runId, trigger: retryOf ? "retry" : "scheduled/manual", retryOf: retryOf ?? null,
      dryRun: !real, since: since ?? null, readMode: since ? "since (measuring only)" : monthPieces ? "month pieces" : "single read",
      startedAt, finishedAt, ok,
      stage: ok ? null : run.stage, code: ok ? null : String(outcome.code || "refused"),
      reason: null,
      seconds: Math.round((Date.parse(finishedAt) - t0) / 100) / 10,
    };
    if (real && retryJob) {
      if (ok || outcome.code === "lock-held") {
        try { await ctx.scheduler.cancel(retryJob); } catch (e: any) {
          console.error("[attendance] could not cancel the booked retry:", String(e?.message || e));
        }
      } else {
        record.retryAt = new Date(t0 + RETRY_AFTER_MS).toISOString();
        outcome.retryAt = record.retryAt;
      }
    }
    // WHAT HAPPENS NEXT IS SAID HERE, AND ONLY HERE (review, 2026-10-02). The
    // refusals used to end "It runs again in 15 minutes" whoever raised them,
    // so a RETRY -- which books nothing -- told the audit log, the red card
    // and "Last run" that it would run again. Only this point knows whether a
    // retry was booked. The record leaves a booked retry to its retryAt, which
    // the card words in Los Angeles time and stops saying once it has passed;
    // the caller's own answer says it outright.
    if (!ok) {
      const cause = String(outcome.reason || outcome.code || "refused").slice(0, 700);
      record.reason = record.retryAt ? cause : `${cause} ${NO_RETRY}`;
      outcome.reason = record.retryAt
        ? `${cause} It runs again by itself at ${laTime(record.retryAt)}, 15 minutes after it started.`
        : `${cause} ${NO_RETRY}`;
    }
    // A HEALTH RECORD THAT CANNOT BE WRITTEN NEVER CHANGES THE OUTCOME: a good
    // rebuild stays good, and its booked retry stays cancelled.
    //
    // BUT IT IS TRIED TWICE (review, 2026-10-02). An unfiled record leaves this
    // run's marker and write lock behind, and the next run would file it as
    // stopped while writing -- a false "screens may be incomplete" about a run
    // that wrote everything -- with lastOk left stale. The second try drops
    // the per-piece detail, the one part of a record that grows.
    try {
      await ctx.runMutation(internal.sisStats.finishAttendanceRebuild, { runId, record });
    } catch (e: any) {
      console.error("[attendance] the run record could not be written:", String(e?.message || e));
      const { windowDetail, ...compact } = record;
      try {
        await ctx.runMutation(internal.sisStats.finishAttendanceRebuild, {
          runId, record: { ...compact, recordTrimmed: true },
        });
      } catch (e2: any) {
        console.error("[attendance] the trimmed run record could not be written either:", String(e2?.message || e2));
      }
    }
    if (thrown) throw thrown;
    return outcome;
  },
});
