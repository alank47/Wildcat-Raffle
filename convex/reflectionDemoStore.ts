import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { getDay, loadRoster, loadSettings, markedOf, readState, ROSTER_KEY, schoolTimeZone } from "./reflection";
import { DEMO_ROW_KEYS } from "./reflectionDemoRules";
import {
  clockText, dayLabel, wallClock,
  type Marked, type ReflectionSettings, type RosterMeta, type RosterSnap,
} from "./reflectionRules";

/**
 * THE TEST LIST'S OWN TABLE: what reflectionDemo.ts (the command line) reads
 * before it builds, and the only two writes it makes (owner, 2026-10-08).
 *
 * WHY A SEPARATE FILE. reflectionDemo.ts reads PowerSchool with the real
 * reader's confirmed read, which lives in a "use node" file, and a Node file
 * may only hold actions. Its queries and mutations are here.
 *
 * WHAT THE TEST LIST MAY TOUCH: reflectionDemoLists, and nothing else. It
 * READS the settings, the bell schedule, the day row and the roster snapshot,
 * to know whether a TEST list may be built and who is in which Power-Up. It
 * never writes reflectionTardies, reflectionUnits, reflectionDays,
 * reflectionPrints, reflectionAudit, the settings, the lease or a uniform
 * entry, so the real list -- in its pilot from Friday 10/9 -- cannot tell it
 * was ever built.
 *
 * Only reflectionList.ts (listForDay, which shows it, and recordPrint, which
 * refuses it) reads this table besides this file. The tick, the reader, the
 * carries, the review queue, the verify export, the health card and the
 * status read never do (reflection-demo.test.mjs checks the source).
 */

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

const DIVISIONS = ["ms", "hs"] as const;

/**
 * Why no TEST list may be built for `day` -- or null when one may.
 *
 * NEVER FOR A DAY THE REAL LIST COUNTS. A real list always wins on screen,
 * but only once it is made: before that, a TEST list for the same day would
 * hide the real "so far" view and stop its prints (recordPrint refuses a day
 * with a TEST list). So a TEST list is only ever for a day before the switch
 * counts, such as 10/8 with the pilot counting from 10/9.
 */
async function refusal(ctx: QueryCtx, day: string, today: string, settings: ReflectionSettings, tz: string): Promise<string | null> {
  if (!DAY_KEY.test(day)) return `Not a day: "${day}". Give it as YYYY-MM-DD.`;
  if (day > today) return `A TEST list is built from marks already taken, and ${day} is after today (${today}).`;
  const row = await getDay(ctx, day);
  if (row?.frozenAt) {
    return `The real list for ${dayLabel(day)} was made at ${clockText(row.frozenAt, tz)}. A real list always wins, `
      + "so a TEST list for that day would never be shown. Nothing was built.";
  }
  for (const d of DIVISIONS) {
    const mode = settings.modeByDivision[d];
    const from = settings.countFromDateByDivision[d];
    if (mode !== "off" && from && from <= day) {
      return `The real list counts ${dayLabel(day)} (${d.toUpperCase()} is in ${mode} from ${from}). A TEST list would hide `
        + "its NOT FINAL view and stop its prints until it is made, so none is built for a day the real list counts.";
    }
  }
  return null;
}

async function schoolToday(ctx: QueryCtx): Promise<{ tz: string | null; today: string }> {
  const tz = await schoolTimeZone(ctx);
  const nowIso = new Date().toISOString();
  const lt = tz ? wallClock(nowIso, tz) : null;
  return { tz, today: lt && lt.ok ? lt.dateKey : nowIso.slice(0, 10) };
}

/**
 * What the build needs before it reads PowerSchool: whether it may build at
 * all, the settings, the day's bell-schedule mark, the no-school days before
 * it (to find the previous school day), and the roster snapshot (Power-Up
 * class, sections and teachers; no names). Counts and numbers only.
 */
export const context = internalQuery({
  args: { day: v.string() },
  handler: async (ctx, { day }): Promise<
    | { ok: false; reason: string }
    | {
      ok: true; today: string; tz: string; settings: ReflectionSettings; marked: Marked; noSchool: string[];
      roster: RosterSnap[]; rosterMeta: RosterMeta | null;
    }
  > => {
    const { tz, today } = await schoolToday(ctx);
    if (!tz) return { ok: false, reason: "No school time zone is set in Settings > Bell Schedule, so no list day can be placed." };
    const settings = await loadSettings(ctx);
    const why = await refusal(ctx, day, today, settings, tz);
    if (why) return { ok: false, reason: why };
    const marks = await ctx.db.query("bellScheduleDays").withIndex("by_date", (q) => q.gte("date", addDays(day, -60)).lt("date", day)).collect();
    return {
      ok: true, today, tz, settings,
      marked: (await markedOf(ctx, day)) ?? null,
      noSchool: marks.filter((m) => m.noSchool).map((m) => m.date),
      roster: Object.values(await loadRoster(ctx)),
      rosterMeta: await readState(ctx, ROSTER_KEY),
    };
  },
});

/**
 * Store the TEST list for `day`, replacing any earlier one for that day. The
 * same refusals as the build, asked again here: the real list may have been
 * made, or the switch moved, while PowerSchool was being read.
 */
export const write = internalMutation({
  args: {
    day: v.string(),
    builtAt: v.string(),
    builtByEmail: v.optional(v.string()),
    previousDay: v.union(v.string(), v.null()),
    kind: v.union(v.literal("regular"), v.literal("wed"), v.literal("minimum"), v.literal("stack")),
    // Checked below, and again by the schema's own row shape on insert.
    rows: v.array(v.any()),
    counts: v.record(v.string(), v.number()),
  },
  handler: async (ctx, a): Promise<{ ok: boolean; reason?: string; rows?: number; replaced?: number }> => {
    const { tz, today } = await schoolToday(ctx);
    if (!tz) return { ok: false, reason: "No school time zone is set in Settings > Bell Schedule." };
    const why = await refusal(ctx, a.day, today, await loadSettings(ctx), tz);
    if (why) return { ok: false, reason: why };
    // STUDENT NUMBERS AND GRADES ONLY: a row with any other field (a name,
    // say) is refused whole, so this table never becomes a list of names.
    const extra = a.rows.flatMap((r) => Object.keys(r ?? {}).filter((k) => !DEMO_ROW_KEYS.includes(k)));
    if (extra.length) return { ok: false, reason: `A TEST row may not carry ${[...new Set(extra)].join(", ")}. Nothing was stored.` };
    if (!a.rows.every((r) => /^[0-9A-Za-z-]{1,20}$/.test(String(r?.studentNumber ?? "")))) {
      return { ok: false, reason: "A TEST row must name a student by number only. Nothing was stored." };
    }
    if (a.builtByEmail !== undefined && !/^[^\s@]+@[^\s@]+$/.test(a.builtByEmail)) {
      return { ok: false, reason: `builtByEmail must be an email address, not "${a.builtByEmail}". Nothing was stored.` };
    }
    const old = await ctx.db.query("reflectionDemoLists").withIndex("by_day", (q) => q.eq("day", a.day)).collect();
    for (const d of old) await ctx.db.delete(d._id);
    await ctx.db.insert("reflectionDemoLists", {
      day: a.day, builtAt: a.builtAt, ...(a.builtByEmail ? { builtByEmail: a.builtByEmail } : {}),
      ...(a.previousDay ? { previousDay: a.previousDay } : {}), kind: a.kind, rows: a.rows, counts: a.counts,
    });
    return { ok: true, rows: a.rows.length, replaced: old.length };
  },
});

/**
 * Take the TEST list for `day` away. The screen goes back to whatever the
 * real list says for that day ("No list was made", or "No list today").
 */
export const clear = internalMutation({
  args: { day: v.string() },
  handler: async (ctx, { day }): Promise<{ ok: boolean; reason?: string; removed?: number }> => {
    if (!DAY_KEY.test(day)) return { ok: false, reason: `Not a day: "${day}". Give it as YYYY-MM-DD.` };
    const rows = await ctx.db.query("reflectionDemoLists").withIndex("by_day", (q) => q.eq("day", day)).collect();
    for (const d of rows) await ctx.db.delete(d._id);
    return { ok: true, removed: rows.length };
  },
});
