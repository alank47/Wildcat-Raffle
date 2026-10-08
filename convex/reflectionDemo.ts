"use node";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { token } from "./attendanceDays";
import { dayQuery, readConfirmed, readMaps } from "./reflectionRead";
import { demoListRows, previousWeekday, readShowsSchool } from "./reflectionDemoRules";
import { buildCodeBook, normalizeRows, rosterSnapshotRows, studentMap, type AttRow, type RosterSnap } from "./reflectionRules";

/**
 * A TEST REFLECTION ROOM LIST IN THE REAL HUB, FROM ONE DAY'S REAL
 * POWERSCHOOL MARKS (owner, 2026-10-08). COMMAND LINE ONLY:
 *
 *   npx convex run --prod reflectionDemo:build '{"day":"2026-10-08"}'
 *   npx convex run --prod reflectionDemo:clear '{"day":"2026-10-08"}'
 *
 * The owner wanted administrators to see the list in the Hub on Thursday
 * 10/8, the day before the pilot starts counting. Discipline > Reflection
 * Room then shows this TEST list for that day -- under a red "TEST ONLY"
 * banner, with "TEST — not for assignment" across every printed page -- but
 * only while that day has no real list (reflectionList.listForDay). Clear it
 * once it has been shown.
 *
 * WHAT IT READS. PowerSchool, with the real reader's own confirmed read
 * (reflectionRead.readConfirmed: two steady reads in a row holding the same
 * rows, or nothing is taken): the whole of `day`, and the whole of the
 * previous school day, whose P5 and P6 tardies a list on `day` would carry
 * (the earlier classes are read too, because the arrival rule needs them).
 * The codes and the student map are read fresh. The Power-Up classes come
 * from the list's roster snapshot, or, if there is none yet, from psRoster
 * the way the snapshot is made -- in memory, never written.
 *
 * WHAT IT DECIDES: nothing of its own. reflectionDemoRules.demoListRows runs
 * the shipped rules (arrival, codes, slots, one row per student, tags) as if
 * the list closed at the moment of the build.
 *
 * WHAT IT WRITES: one row of reflectionDemoLists (reflectionDemoStore.write),
 * and nothing else -- no tardy, detention, day, print, audit line, setting,
 * lease or uniform entry. Its answer and its logs carry counts only.
 */

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** The whole build's PowerSchool budget (a command-line action may run for 10 minutes). */
const BUILD_BUDGET_MS = 4 * 60 * 1000;
/** Weekdays stepped back past days PowerSchool shows no attendance on, looking for the previous school day. */
const PREVIOUS_DAY_TRIES = 5;

type DayRead = { ok: true; rows: AttRow[]; unmatched: number; reads: number; pages: number } | { ok: false; reason: string };

/** psRoster, paged the way the opening read pages it, as snapshot rows (no names leave the query). */
async function rosterFromPsRoster(ctx: ActionCtx): Promise<RosterSnap[]> {
  const rows: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const p: { rows: any[]; isDone: boolean; continueCursor: string } = await ctx.runQuery(internal.reflection.rosterPage, { cursor });
    rows.push(...p.rows);
    if (p.isDone) break;
    cursor = p.continueCursor;
  }
  return rosterSnapshotRows(rows);
}

export const build = internalAction({
  args: {
    day: v.string(),
    /** Only if the previous school day is not the weekday before `day` and PowerSchool cannot show it. */
    previousDay: v.optional(v.string()),
    builtByEmail: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<Record<string, any>> => {
    if (!DAY_KEY.test(a.day)) return { ok: false, reason: `Not a day: "${a.day}". Give it as YYYY-MM-DD.` };
    if (a.previousDay !== undefined && (!DAY_KEY.test(a.previousDay) || a.previousDay >= a.day)) {
      return { ok: false, reason: `previousDay must be a YYYY-MM-DD date before ${a.day}, not "${a.previousDay}".` };
    }
    const c = await ctx.runQuery(internal.reflectionDemoStore.context, { day: a.day });
    if (!c.ok) return { ok: false, reason: c.reason };
    const host = process.env.PS_HOST, id = process.env.PS_CLIENT_ID, secret = process.env.PS_CLIENT_SECRET;
    const schoolid = process.env.PS_SCHOOL_ID, yearid = process.env.PS_YEAR_ID;
    if (!host || !id || !secret || !schoolid || !yearid) {
      return { ok: false, reason: "PowerSchool settings are not all present in this deployment." };
    }
    const deadline = Date.now() + BUILD_BUDGET_MS;
    let tok: string;
    let maps: Awaited<ReturnType<typeof readMaps>>;
    try {
      tok = await token(host, id, secret);
      maps = await readMaps(host, tok, schoolid, yearid, deadline);
    } catch (e: any) {
      return { ok: false, reason: `PowerSchool could not be read: ${String(e?.message || e)}. Nothing was built.` };
    }
    const codes = buildCodeBook(maps.codes);
    if (!codes.ok) return { ok: false, reason: codes.reason };
    const sm = studentMap(maps.students);

    let reads = 0, pages = 0;
    const readDay = async (date: string): Promise<DayRead> => {
      const r = await readConfirmed(host, tok, dayQuery({ schoolid, yearid, date }), deadline, { expectDate: date });
      reads += r.reads;
      pages += r.pages;
      if (!r.ok) return { ok: false, reason: r.reason };
      const n = normalizeRows([...r.rows.values()], sm.snOf);
      return { ok: true, rows: n.rows.filter((x) => x.attDate === date), unmatched: n.unmatched, reads: r.reads, pages: r.pages };
    };

    // THE DAY ITSELF, confirmed, or nothing is built: an unconfirmed read can
    // hold a mark that was being deleted and miss one that was there.
    const day = await readDay(a.day);
    if (!day.ok) return { ok: false, reason: `${a.day} was not read steadily: ${day.reason} Nothing was built; run it again.` };
    if (!readShowsSchool(a.day, day.rows, codes)) {
      return { ok: false, reason: `PowerSchool shows no attendance taken on ${a.day}, so there is nothing to build a list from.` };
    }

    // THE PREVIOUS SCHOOL DAY: the weekday before, not marked no school, that
    // PowerSchool shows attendance on (an unmarked holiday is stepped past).
    let previousDay: string | null = null;
    let previous: Extract<DayRead, { ok: true }> | null = null;
    const tries: string[] = [];
    if (a.previousDay) tries.push(a.previousDay);
    else for (let d = a.day; tries.length < PREVIOUS_DAY_TRIES;) { d = previousWeekday(d, c.noSchool); tries.push(d); }
    for (const d of tries) {
      const r = await readDay(d);
      if (!r.ok) return { ok: false, reason: `${d} was not read steadily: ${r.reason} Nothing was built; run it again.` };
      if (readShowsSchool(d, r.rows, codes)) { previousDay = d; previous = r; break; }
    }

    let roster = c.roster;
    let rosterFrom = "snapshot";
    if (!roster.length) {
      roster = await rosterFromPsRoster(ctx);
      rosterFrom = "psRoster";
    }
    const builtAt = new Date().toISOString();
    const out = demoListRows({
      day: a.day, previousDay, tz: c.tz, builtAt, settings: c.settings, codes,
      roster: Object.fromEntries(roster.map((r) => [r.studentNumber, r])), gradeOf: sm.gradeOf, marked: c.marked,
      dayRows: day.rows, previousRows: previous?.rows ?? null, unmatched: day.unmatched + (previous?.unmatched ?? 0),
    });
    const counts = { ...out.counts, reads, pages, rosterStudents: roster.length };
    const saved = await ctx.runMutation(internal.reflectionDemoStore.write, {
      day: a.day, builtAt, ...(a.builtByEmail ? { builtByEmail: a.builtByEmail } : {}), previousDay, kind: out.kind, rows: out.rows, counts,
    });
    // Counts only, as the reader logs.
    console.log(`[reflection-demo] ${a.day}: ${JSON.stringify({ ok: saved.ok, previousDay, rosterFrom, ...counts })}`);
    if (!saved.ok) return { ok: false, reason: saved.reason };
    return {
      ok: true, day: a.day, previousDay, builtAt, rosterFrom, counts,
      note: previousDay ? undefined : `No school day with attendance was found in the ${tries.length} weekdays before ${a.day}, so no P5/P6 tardies were carried.`,
      shown: "Discipline > Reflection Room shows this TEST list for that day while it has no real list. Clear it after showing it.",
    };
  },
});

/**
 * Take the TEST list for `day` away (reflectionDemoStore.clear, one
 * mutation). An action only because this file is a Node file, which may not
 * hold a mutation; the command line is the same as for build.
 */
export const clear = internalAction({
  args: { day: v.string() },
  handler: async (ctx, { day }): Promise<{ ok: boolean; reason?: string; removed?: number }> =>
    ctx.runMutation(internal.reflectionDemoStore.clear, { day }),
});
