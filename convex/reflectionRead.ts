"use node";
import { countRows, readWindow, sameList } from "./attendanceDays";
import { MAX_PAGES, PAGE, psGet, token } from "./attendanceDays";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  buildCodeBook, encodeRow, EVIDENCE_SLOT1_ROWS, idSetHash, lookbackDates, normalizeRows, pickDirectChecks,
  READ_STOP_MS, reconcileDate, rosterSnapshotRows, studentMap, sweepFrom, tardyKey,
  type TardyItem,
} from "./reflectionRules";

/**
 * THE REFLECTION ROOM'S POWERSCHOOL READ: one school day, CONFIRMED.
 *
 * WHY A COUNT IS NOT ENOUGH. Teachers are typing attendance while the list
 * is read. A teacher marking one child present and another absent mid-read
 * is a delete plus an insert: PowerSchool's count before and after both come
 * out right, the read keeps the deleted row, and the page shift skips a row
 * that existed the whole time. The attendance rebuild demonstrated exactly
 * this ("the run said ok and wrote both mistakes") and answered it for its
 * live piece by requiring a second read with the very same row ids
 * (attendanceDays.ts readPiece). This is that rule, for one day's query:
 *
 *   a read is STEADY when PowerSchool's count before it and after it both
 *   equal the rows it held, with no row served twice and no paging out;
 *
 *   the read is ACCEPTED only when two reads in a row are each steady AND
 *   hold the same sorted list of row ids.
 *
 * At most CONFIRM_MAX_READS reads per call. If none is accepted, the read
 * did not succeed: nothing is believed, and the next tick tries again. An
 * unconfirmed read must never make the list, clear a tardy, or turn an
 * arrival into a counted tardy -- that is the whole point of this file.
 *
 * It reuses the rebuild's own psGet / countRows / readWindow (exported for
 * this, unchanged), so the retries on 429 and 5xx, the per-request deadline,
 * the page-size cap and the "a row without an id stops the read" guard are
 * the proven ones, not a second copy.
 */

/** Reads per call, at most. Two is the minimum that can confirm anything. */
export const CONFIRM_MAX_READS = 4;

export type ConfirmedRead =
  | { ok: true; rows: Map<string, any>; ids: string[]; count: number; reads: number; pages: number; ms: number }
  | { ok: false; reason: string; reads: number; pages: number; ms: number };

/**
 * The attendance query for one school day, optionally one code only (the
 * T-only lookback reads). PowerSchool rejects OR clauses, so one code per
 * query. schoolid and yearid stay in every query, as in the rebuild.
 */
export function dayQuery(input: { schoolid: string; yearid: string; date: string; codeId?: string | null }): string {
  const q = [`schoolid==${input.schoolid}`, `yearid==${input.yearid}`, `att_date==${input.date}`];
  if (input.codeId) q.push(`attendance_codeid==${input.codeId}`);
  return q.join(";");
}

/**
 * Read `q` until two steady reads in a row agree on every row id.
 *
 * `expectDate`: every row must carry this att_date. A PowerSchool that
 * ignored the date filter would otherwise hand back another day's rows as
 * today's, and the count endpoint would not necessarily say so.
 */
/**
 * The T-only sweep's query: one code, a RANGE of dates (from..to inclusive).
 * One ranged read of about a month of tardies is far cheaper than a read per
 * date, and the after-school sweep only needs to spot a tardy nobody has seen.
 */
export function rangeQuery(input: { schoolid: string; yearid: string; from: string; to: string; codeId: string }): string {
  return [`schoolid==${input.schoolid}`, `yearid==${input.yearid}`, `att_date=ge=${input.from}`,
    `att_date=le=${input.to}`, `attendance_codeid==${input.codeId}`].join(";");
}

export async function readConfirmed(
  host: string, tok: string, q: string, deadline: number,
  opts: { maxReads?: number; abort?: { stop: boolean }; expectDate?: string; expectRange?: { from: string; to: string } } = {},
): Promise<ConfirmedRead> {
  const maxReads = Math.max(2, opts.maxReads ?? CONFIRM_MAX_READS);
  const abort = opts.abort ?? { stop: false };
  let reads = 0, pages = 0, ms = 0;
  // The ids of the previous read -- kept only when that read was steady, so
  // a match always means two steady reads in a row.
  let previous: string[] | null = null;
  let why = "";
  try {
    for (let k = 0; k < maxReads; k++) {
      const before = await countRows(host, tok, "attendance", q, deadline);
      const r = await readWindow(host, tok, q, deadline, abort);
      const after = await countRows(host, tok, "attendance", q, deadline);
      reads++;
      pages += r.pages;
      ms += r.ms;
      if (opts.expectDate) {
        for (const row of r.rows.values()) {
          const d = String(row?.att_date ?? "").slice(0, 10);
          if (d !== opts.expectDate) {
            return { ok: false, reason: `PowerSchool did not apply the date filter: the read of ${opts.expectDate} `
              + `came back with a row dated "${d}". Nothing was taken from it.`, reads, pages, ms };
          }
        }
      }
      if (opts.expectRange) {
        const { from, to } = opts.expectRange;
        for (const row of r.rows.values()) {
          const d = String(row?.att_date ?? "").slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < from || d > to) {
            return { ok: false, reason: `PowerSchool did not apply the date filter: the read of ${from} to ${to} `
              + `came back with a row dated "${d}". Nothing was taken from it.`, reads, pages, ms };
          }
        }
      }
      const ids = [...r.rows.keys()].sort();
      const steady = before === after && after === r.rows.size && r.duplicates === 0 && !r.pagedOut;
      if (steady && previous !== null && sameList(previous, ids)) {
        return { ok: true, rows: r.rows, ids, count: after, reads, pages, ms };
      }
      why = !steady
        ? `PowerSchool counted ${before} rows before a read and ${after} after it, and the read held ${r.rows.size}`
          + (r.duplicates ? ` (${r.duplicates} served twice)` : "") + (r.pagedOut ? " (paged out)" : "")
        : previous === null
          ? "only one steady read"
          : "two steady reads in a row held different rows";
      previous = steady ? ids : null;
    }
  } catch (e: any) {
    return { ok: false, reason: String(e?.message || e), reads, pages, ms };
  }
  return {
    ok: false,
    reason: `The read did not hold still in ${reads} reads (${why}): probably somebody is entering attendance `
      + `right now. Nothing was taken from it; the next read tries again.`,
    reads, pages, ms,
  };
}

// ===========================================================================
// THE READER (build spec 4.3): internal.reflectionRead.read
// ===========================================================================
//
// Booked by reflection.tick together with the lease, and only ever by it.
// It READS: PowerSchool (confirmed, two matching reads every time), and the
// list's own context through internal queries. It WRITES ONLY THROUGH
// reflection.applyRead, which refuses a run that no longer holds the lease.
// Every decision is a pure rule in reflectionRules.ts; this gathers the rows.
// It stops reading at 3 minutes (READ_STOP_MS) so its lease, 4 minutes, is
// still its own when it hands the rows over. Logs carry counts only.

/** Past dates read IN FULL per read (the others wait for the next read). */
export const FULL_REREAD_CAP = 3;
/** Dates the after-school sweep may read in full, because it found a tardy nobody had seen. */
export const SWEEP_FULL_CAP = 5;
/** PowerSchool requests at once, as in the rebuild's month pieces. */
export const READ_CONCURRENCY = 3;
const DIRECT_FIELDS = "id,studentid,att_date,periodid,attendance_codeid";

const shiftDay = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/** At most `n` at once; each item's own failure is its own (fn decides what a failure returns). */
async function rrAtMost<T, R>(n: number, items: T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/** A small table, paged through psGet so every request is inside the read's deadline. */
async function tableRows(host: string, tok: string, table: string, q: string, projection: string, deadline: number): Promise<any[]> {
  const rows: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://${host}/ws/schema/table/${table}?q=${encodeURIComponent(q)}`
      + `&projection=${encodeURIComponent(projection)}&pagesize=${PAGE}&page=${page}`;
    const b = await psGet(url, tok, deadline, `${table} page ${page}`);
    const batch = (b?.record ?? []).map((r: any) => r.tables?.[table] ?? r);
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
  throw new Error(`${table} paged out at ${MAX_PAGES} pages, so it would be read short.`);
}

/** Enrolled students as "psId|studentNumber|grade": the map from PowerSchool's own id to the number the app joins on. */
async function readStudentEntries(host: string, tok: string, schoolid: string, deadline: number): Promise<string[]> {
  const rows = await tableRows(host, tok, "students", `schoolid==${schoolid};enroll_status==0`, "id,student_number,grade_level", deadline);
  return rows
    .filter((r) => r?.id !== null && r?.id !== undefined && String(r?.student_number ?? "").trim())
    .map((r) => `${r.id}|${String(r.student_number).trim()}|${String(r.grade_level ?? "").trim()}`);
}

/**
 * THE CODES ARE READ, NEVER TYPED IN: which id is T, which mean Absent
 * (presence status, not a letter: Ditching is coded Present, Suspended
 * Absent). This year's codes only, so the T-only reads ask for this year's T.
 */
async function readMaps(host: string, tok: string, schoolid: string, yearid: string, deadline: number) {
  const codes = await tableRows(host, tok, "attendance_code", `schoolid==${schoolid};yearid==${yearid}`,
    "id,att_code,description,presence_status_cd", deadline);
  return {
    codes: codes.filter((r) => r?.id !== null && r?.id !== undefined).map((r) => ({
      id: String(r.id), att_code: String(r.att_code ?? ""), description: String(r.description ?? ""),
      presence_status_cd: String(r.presence_status_cd ?? ""),
    })),
    students: await readStudentEntries(host, tok, schoolid, deadline),
    readAt: new Date().toISOString(),
  };
}

/** The term PS_TERM_ID names, for the semester banner: its last day and short name. Never fatal. */
async function readTerm(host: string, tok: string, schoolid: string, yearid: string, termId: string | undefined, deadline: number) {
  if (!termId) return {};
  try {
    const rows = await tableRows(host, tok, "terms", `schoolid==${schoolid};yearid==${yearid}`, "id,abbreviation,lastday", deadline);
    const t = rows.find((r) => String(r?.id) === String(termId));
    const end = String(t?.lastday ?? "").slice(0, 10);
    return {
      termId: String(termId),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(end) ? { termEnd: end } : {}),
      ...(t?.abbreviation ? { termName: String(t.abbreviation) } : {}),
    };
  } catch {
    return { termId: String(termId) };
  }
}

/**
 * THE ROSTER SNAPSHOT, which needs no PowerSchool: page psRoster (no names
 * leave the query), build one row per student, and hand it to
 * reflection.writeRosterSnapshot, which decides -- in its own transaction --
 * whether the roster is whole enough to take.
 */
export async function takeRosterSnapshot(ctx: ActionCtx, term: { termId?: string; termEnd?: string; termName?: string }):
  Promise<{ taken: boolean; reason: string; students: number }> {
  const rows: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const p: { rows: any[]; isDone: boolean; continueCursor: string } = await ctx.runQuery(internal.reflection.rosterPage, { cursor });
    rows.push(...p.rows);
    if (p.isDone) break;
    cursor = p.continueCursor;
  }
  const snaps = rosterSnapshotRows(rows);
  return ctx.runMutation(internal.reflection.writeRosterSnapshot, {
    rows: snaps, syncedAts: [...new Set(rows.map((r) => String(r.syncedAt)))], studentCount: snaps.length, ...term,
  });
}

type DirectResult = { psRowId: string; status: "none" | "row" | "error"; studentNumber?: string; attDate?: string; code?: string; periodId?: number };

/** One `id==` read: is this PowerSchool row still there, and is it still the same tardy? */
async function directCheck(host: string, tok: string, id: string, deadline: number,
  snOf: Record<string, string>, codeOf: (codeId: string) => string): Promise<DirectResult> {
  try {
    const url = `https://${host}/ws/schema/table/attendance?q=${encodeURIComponent(`id==${id}`)}`
      + `&projection=${encodeURIComponent(DIRECT_FIELDS)}&pagesize=1&page=1`;
    const b = await psGet(url, tok, deadline, `attendance row ${id}`);
    const row = (b?.record ?? []).map((r: any) => r.tables?.attendance ?? r)[0];
    if (!row) return { psRowId: id, status: "none" };
    const sn = snOf[String(row.studentid ?? "")];
    // A student the map does not know cannot be compared: no decision.
    if (!sn) return { psRowId: id, status: "error" };
    return {
      psRowId: id, status: "row", studentNumber: sn, attDate: String(row.att_date ?? "").slice(0, 10),
      code: codeOf(String(row.attendance_codeid ?? "")), periodId: Number(row.periodid),
    };
  } catch {
    return { psRowId: id, status: "error" };
  }
}

export const read = internalAction({
  args: {
    runId: v.string(),
    key: v.string(),
    kind: v.string(),
    date: v.string(),
    startedAt: v.string(),
    reads: v.object({
      maps: v.boolean(), roster: v.boolean(), today: v.boolean(), lookback: v.boolean(), sweep: v.boolean(), final: v.boolean(),
    }),
    freeze: v.union(v.literal("closing"), v.literal("late"), v.null()),
  },
  handler: async (ctx, a): Promise<Record<string, any>> => {
    const deadline = Date.parse(a.startedAt) + READ_STOP_MS;
    const base = { runId: a.runId, key: a.key, kind: a.kind, date: a.date, startedAt: a.startedAt, freeze: a.freeze };
    const stats: Record<string, any> = { confirmedReads: 0, reads: 0, pages: 0, skipped: [] as string[] };
    const finish = (ok: boolean, extra: Record<string, any>): Promise<Record<string, any>> =>
      ctx.runMutation(internal.reflection.applyRead, { ...base, ok, dates: [], direct: [], stats, ...extra });

    const host = process.env.PS_HOST, id = process.env.PS_CLIENT_ID, secret = process.env.PS_CLIENT_SECRET;
    const schoolid = process.env.PS_SCHOOL_ID, yearid = process.env.PS_YEAR_ID;
    if (!host || !id || !secret || !schoolid || !yearid) {
      return finish(false, { reason: "PowerSchool settings are not all present in this deployment." });
    }
    const c = await ctx.runQuery(internal.reflection.readContext, { date: a.date });

    let tok: string | null = null;
    let tokError = "";
    try { tok = await token(host, id, secret); } catch (e: any) { tokError = String(e?.message || e); }

    // The snapshot first: it needs no PowerSchool, so a morning when
    // PowerSchool is down still gets today's Power-Up teachers.
    if (a.reads.roster || !c.rosterMeta) {
      const term = tok ? await readTerm(host, tok, schoolid, yearid, process.env.PS_TERM_ID, deadline) : { termId: process.env.PS_TERM_ID };
      try {
        stats.roster = await takeRosterSnapshot(ctx, term);
      } catch (e: any) {
        stats.roster = { taken: false, reason: String(e?.message || e) };
      }
    }
    if (!tok) return finish(false, { reason: tokError });

    try {
      let maps = c.maps;
      let fresh: any = null;
      if (a.reads.maps || !maps?.codes?.length) maps = fresh = await readMaps(host, tok, schoolid, yearid, deadline);
      const codes = buildCodeBook(maps.codes);
      if (!codes.ok) return finish(false, { reason: codes.reason, maps: fresh ?? undefined });
      const settings = c.settings;
      const count = (r: { reads: number; pages: number }) => { stats.reads += r.reads; stats.pages += r.pages; };
      const confirmed = async (q: string, opts: { expectDate?: string; expectRange?: { from: string; to: string } }) => {
        const r = await readConfirmed(host, tok!, q, deadline, opts);
        count(r);
        if (r.ok) stats.confirmedReads++;
        return r;
      };
      /** date -> PowerSchool's raw rows, and whether the read was the whole day or T only. */
      const got = new Map<string, { full: boolean; rows: any[] }>();
      const tOnly = async (d: string) => {
        const rows: any[] = [];
        for (const tId of codes.tIds) {
          const r = await confirmed(dayQuery({ schoolid, yearid, date: d, codeId: tId }), { expectDate: d });
          if (!r.ok) return null;
          rows.push(...r.rows.values());
        }
        return rows;
      };
      const fullDay = async (d: string) => {
        const r = await confirmed(dayQuery({ schoolid, yearid, date: d }), { expectDate: d });
        return r.ok ? [...r.rows.values()] : null;
      };

      // 1. TODAY, in full. Not confirmed, nothing is taken: an unconfirmed
      //    read must never make the list or change a tardy.
      if (a.reads.today) {
        const r = await confirmed(dayQuery({ schoolid, yearid, date: a.date }), { expectDate: a.date });
        if (!r.ok) return finish(false, { reason: `Today's read was not confirmed: ${r.reason}`, maps: fresh ?? undefined });
        got.set(a.date, { full: true, rows: [...r.rows.values()] });
      }

      // 2. THE LOOKBACK: the last school days BY VERDICT (not calendar days,
      //    so the first day after a break reaches back to the day before it),
      //    each read T-only; a date never proved a school day costs one count.
      const on = (["ms", "hs"] as const).filter((dv) => settings.modeByDivision[dv] !== "off");
      const notBefore = on.map((dv) => settings.countFromDateByDivision[dv]).filter((x): x is string => !!x).sort()[0] ?? null;
      const tRows = new Map<string, any[]>();
      if (a.reads.lookback) {
        const verdict = new Map(c.days.map((d) => [d.date, d]));
        const dates = lookbackDates({ today: a.date, days: c.days, n: settings.lateEntryLists, notBefore });
        stats.lookback = dates.length;
        const worth = await rrAtMost(READ_CONCURRENCY, dates, async (d) => {
          if (verdict.get(d)?.schoolDay === true) return true;
          try {
            return (await countRows(host, tok!, "attendance", `${dayQuery({ schoolid, yearid, date: d })};periodid==851`, deadline)) >= EVIDENCE_SLOT1_ROWS;
          } catch { return false; }
        });
        const toRead = dates.filter((_, i) => worth[i]);
        const res = await rrAtMost(READ_CONCURRENCY, toRead, tOnly);
        toRead.forEach((d, i) => { if (res[i]) tRows.set(d, res[i]!); else stats.skipped.push(d); });
      }

      // 3. THE AFTER-SCHOOL SWEEP: one ranged T-only read reaching back
      //    further, to catch a tardy entered very late. A date the lookback
      //    already read on its own keeps that read.
      const sweepDates: string[] = [];
      if (a.reads.sweep) {
        const to = shiftDay(a.date, -1);
        let from = sweepFrom({ today: a.date, days: c.days });
        if (notBefore && from < notBefore) from = notBefore;
        const byDate = new Map<string, Map<string, any>>();
        let swept = from <= to;
        for (const tId of swept ? codes.tIds : []) {
          const r = await confirmed(rangeQuery({ schoolid, yearid, from, to, codeId: tId }), { expectRange: { from, to } });
          if (!r.ok) { stats.skipped.push(`sweep ${from}..${to}`); swept = false; break; }
          for (const row of r.rows.values()) {
            const d = String(row.att_date).slice(0, 10);
            if (got.has(d) || tRows.has(d)) continue;
            if (!byDate.has(d)) byDate.set(d, new Map());
            byDate.get(d)!.set(String(row.id), row);
          }
        }
        if (swept) {
          for (const [d, rows] of byDate) { tRows.set(d, [...rows.values()]); sweepDates.push(d); }
        }
      }

      // 4. PowerSchool student ids -> student numbers. One that the map does
      //    not know means a new student: the students are read again, once.
      //    A student who has LEFT keeps their old marks but is not in the
      //    map; ids a fresh read could not resolve are remembered
      //    (`unresolved`), so they do not cost a re-read on every read.
      let sm = studentMap(maps.students);
      const allRaw = () => [...[...got.values()].flatMap((g) => g.rows), ...[...tRows.values()].flat()];
      const unknownIds = () => [...new Set(allRaw().map((r) => String(r.studentid ?? "")).filter((x) => x && !sm.snOf[x]))];
      const known = new Set<string>(maps.unresolved ?? []);
      if (!fresh && unknownIds().some((x) => !known.has(x))) {
        try {
          maps = fresh = { ...maps, students: await readStudentEntries(host, tok, schoolid, deadline), readAt: new Date().toISOString() };
          sm = studentMap(maps.students);
        } catch (e: any) {
          // Not worth failing the read over: the unknown students' marks
          // are counted as unmatched this time, and asked about next read.
          stats.skipped.push(`students map (${String(e?.message || e).slice(0, 80)})`);
        }
      }
      if (fresh) fresh.unresolved = [...new Set([...(fresh.unresolved ?? []), ...unknownIds()])].sort().slice(0, 500);

      // 5. WHICH PAST DATES TO READ IN FULL: those whose tardies changed
      //    since their last full read, those holding a held or pending item,
      //    the last list's date while its carries can still change -- and any
      //    date where the sweep found a tardy nobody has stored.
      const stored = new Map(c.days.map((d) => [d.date, d.tHash]));
      // The same fingerprint applyRead stores: T rows of students the map knows.
      const tHash = (rows: any[]) => idSetHash(rows.filter((r) => sm.snOf[String(r.studentid ?? "")]).map((r) => String(r.id)));
      const changed = [...tRows.keys()].filter((d) => tHash(tRows.get(d)!) !== stored.get(d));
      const open = [...c.held, ...(c.carryOpen ? [c.carryOpen] : []), ...c.pending].filter((d) => d < a.date);
      const sweepNew: string[] = [];
      if (sweepDates.length) {
        const items: TardyItem[] = await ctx.runQuery(internal.reflection.itemsForDates, { dates: sweepDates });
        const keys = new Set(items.map((t) => tardyKey(t.studentNumber, t.attDate, t.periodId)));
        for (const d of sweepDates) {
          const unseen = tRows.get(d)!.some((r) => {
            const sn = sm.snOf[String(r.studentid ?? "")];
            return !!sn && !keys.has(tardyKey(sn, d, Number(r.periodid)));
          });
          if (unseen) sweepNew.push(d);
        }
      }
      const newestFirst = (xs: string[]) => [...new Set(xs)].sort().reverse();
      // A sweep-only date's fingerprint was never stored, so "changed" means
      // nothing there: only a tardy nobody has stored earns it a full read.
      const lookbackChanged = changed.filter((d) => !sweepDates.includes(d));
      const fullDates = [...new Set([...newestFirst(lookbackChanged), ...newestFirst(open)])]
        .filter((d) => !got.has(d)).slice(0, FULL_REREAD_CAP);
      for (const d of newestFirst(sweepNew).slice(0, SWEEP_FULL_CAP)) if (!fullDates.includes(d)) fullDates.push(d);
      const fulls = await rrAtMost(READ_CONCURRENCY, fullDates, fullDay);
      fullDates.forEach((d, i) => {
        if (fulls[i]) { got.set(d, { full: true, rows: fulls[i]! }); tRows.delete(d); } else stats.skipped.push(`${d} (full)`);
      });
      for (const [d, rows] of tRows) got.set(d, { full: false, rows });

      const dates = [...got.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([d, g]) => {
        const n = normalizeRows(g.rows, sm.snOf);
        return { date: d, full: g.full, rows: n.rows.filter((r) => r.attDate === d).map(encodeRow), unmatched: n.unmatched };
      });

      // 6. DIRECT ID READS for marks a confirmed read no longer holds. Never
      //    on a closing read: the closing read never removes anything.
      const direct: DirectResult[] = [];
      if (a.kind !== "closing" && a.kind !== "late-closing" && dates.length) {
        const items: TardyItem[] = await ctx.runQuery(internal.reflection.itemsForDates, { dates: dates.map((d) => d.date) });
        const missing: string[] = [];
        for (const d of dates) {
          const rec = reconcileDate({
            date: d.date, candidates: [], rows: normalizeRows(got.get(d.date)!.rows, sm.snOf).rows, codes,
            items: items.filter((t) => t.attDate === d.date && t.state !== "cleared"), confirmed: true, fullRead: d.full, settings,
          });
          for (const m of rec.missing) missing.push(...m.psRowIds);
        }
        const picked = pickDirectChecks([...new Set(missing)]);
        stats.directChecks = picked.now.length;
        stats.directDeferred = picked.later.length;
        const codeOf = (cid: string) => (codes.byId[cid]?.code ?? "?");
        direct.push(...await rrAtMost(READ_CONCURRENCY, picked.now, (rid) => directCheck(host, tok!, rid, deadline, sm.snOf, codeOf)));
      }
      return finish(true, { maps: fresh ?? undefined, dates, direct });
    } catch (e: any) {
      return finish(false, { reason: String(e?.message || e) });
    }
  },
});
