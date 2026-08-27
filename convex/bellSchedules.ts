import { query, mutation, QueryCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireStaff, requireAdmin } from "./identity";
import {
  formatClock,
  localSchoolTime,
  normalizeDateKey,
  parseClock,
  periodAt,
  scheduleForDay,
  validateCycleDays,
  validatePeriods,
  validateWeekdays,
} from "./scheduleRules";

/**
 * The bell schedule, as configuration a person types in.
 *
 * The decisions all live in scheduleRules.ts and are tested without a database.
 * This file does the parts that need one: who is allowed to edit, reading the
 * settings row, and answering "what period is it right now" for the rest of the
 * app.
 *
 * WHY ANY OF THIS EXISTS. A hall pass now originates from the class a student is
 * scheduled into, so something has to turn a wall clock into a period number.
 * PowerSchool cannot: the manifest grants no Period table, no BellSchedule
 * table, and Sections.Expression carries "1(A-E)" and never a time. So an admin
 * types the bells in, next to the tap locations, and the app says plainly when
 * it has not been told enough to answer.
 */

/** A ceiling on how many named schedules exist. A school has a handful. */
const MAX_SCHEDULES = 20;

/** How far ahead the day calendar is read for the admin screen. */
const DAY_WINDOW = 120;

/** The settings singleton's key. One row, fetched by index. */
const SETTINGS_KEY = "bell";

/**
 * A starting time zone offered by the UI when the settings row is first written.
 *
 * NOT A FALLBACK. Nothing reads this at decision time: with no settings row the
 * app reports that it cannot tell the time here, and refuses. It exists so the
 * admin form has something sensible in the box before they confirm it, which is
 * a different thing from the server assuming an answer nobody gave.
 */
export const SUGGESTED_TIME_ZONE = "America/Los_Angeles";

export type BellContext = {
  ok: boolean;
  reason: string;
  code: string;
  timeZone: string | null;
  local: { dateKey: string; weekday: number; minuteOfDay: number } | null;
  scheduleName: string | null;
  scheduleSource: "override" | "default" | null;
  cycleDay: string | null;
  schoolCycleDays: string[];
  period: { label: string; startMinute: number; endMinute: number } | null;
  minutesLeft: number | null;
};

/**
 * "What period is it, here, now" for one instant.
 *
 * A PLAIN ASYNC FUNCTION, not a query, because hallPasses.requestMine has to ask
 * the same question inside a mutation and two copies of this would be two
 * answers. Exported so `currentPeriod` below can be the thin wrapper.
 *
 * EVERY FAILURE IS NAMED. There are seven distinct ways to have no period, and
 * they are seven different things to tell a child standing in a corridor: the
 * app has not been set up, today has no schedule, today is a holiday, it is the
 * weekend, school has not started, school is over, or it is lunch. Collapsing
 * them into "unknown" makes all seven read as a bug in the app, and the student
 * is left with nothing to do about it.
 */
export async function bellContext(ctx: QueryCtx, nowIso: string): Promise<BellContext> {
  const blank = {
    timeZone: null,
    local: null,
    scheduleName: null,
    scheduleSource: null,
    cycleDay: null,
    schoolCycleDays: [] as string[],
    period: null,
    minutesLeft: null,
  };

  const settings = await ctx.db
    .query("bellSettings")
    .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
    .first();

  if (!settings) {
    return {
      ok: false,
      code: "not-configured",
      reason:
        "The bell schedule has not been set up yet, so the app cannot tell which class " +
        "you are in. An admin sets it in Settings > Bell Schedule.",
      ...blank,
    };
  }

  const local = localSchoolTime(nowIso, settings.timeZone);
  if (!local.ok) {
    return { ok: false, code: local.code, reason: local.reason, ...blank, timeZone: settings.timeZone };
  }

  const cycleDays = validateCycleDays(settings.cycleDays).cycleDays ?? [];
  const override = await ctx.db
    .query("bellScheduleDays")
    .withIndex("by_date", (q) => q.eq("date", local.dateKey))
    .first();

  const schedules = await ctx.db.query("bellSchedules").take(MAX_SCHEDULES);
  const usable = schedules.filter((s) => s.active);

  const chosen = scheduleForDay(override ?? null, usable as any, settings.defaultScheduleId ?? null);
  const common = {
    timeZone: settings.timeZone,
    local: { dateKey: local.dateKey, weekday: local.weekday, minuteOfDay: local.minuteOfDay },
    cycleDay: override?.cycleDay ?? null,
    schoolCycleDays: cycleDays,
  };

  if (!chosen.ok) {
    return {
      ok: false,
      code: chosen.code,
      reason: chosen.reason,
      ...common,
      scheduleName: null,
      scheduleSource: null,
      period: null,
      minutesLeft: null,
    };
  }

  const result = periodAt(chosen.schedule as any, local);
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      reason: result.reason,
      ...common,
      scheduleName: chosen.schedule.name,
      scheduleSource: chosen.source,
      period: null,
      minutesLeft: null,
    };
  }

  return {
    ok: true,
    code: "ok",
    reason: "",
    ...common,
    scheduleName: chosen.schedule.name,
    scheduleSource: chosen.source,
    period: result.period,
    minutesLeft: result.minutesLeft,
  };
}


/**
 * Everything the admin screen renders: the schedules, the settings, the marked
 * days, and what the app thinks the time is.
 *
 * The clock comes back with it on purpose. A schedule that looks right and a
 * time zone that is wrong produce a screen that is entirely plausible and
 * entirely wrong, and the only way to notice is to see the app state the time it
 * believes it is, next to the clock on the wall.
 */
export const settings = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    const now = new Date().toISOString();

    const row = await ctx.db
      .query("bellSettings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .first();

    const schedules = await ctx.db.query("bellSchedules").take(MAX_SCHEDULES);
    const days = await ctx.db.query("bellScheduleDays").order("desc").take(DAY_WINDOW);
    const context = await bellContext(ctx, now);

    return {
      configured: Boolean(row),
      timeZone: row?.timeZone ?? null,
      suggestedTimeZone: SUGGESTED_TIME_ZONE,
      defaultScheduleId: row?.defaultScheduleId ?? null,
      cycleDays: row?.cycleDays ?? [],
      schedules: schedules
        .map((s) => ({
          id: s._id,
          name: s.name,
          active: s.active,
          weekdays: s.weekdays,
          isDefault: String(row?.defaultScheduleId ?? "") === String(s._id),
          periods: s.periods.map((p) => ({
            label: p.label,
            startMinute: p.startMinute,
            endMinute: p.endMinute,
            start: formatClock(p.startMinute),
            end: formatClock(p.endMinute),
          })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      days: days.map((d) => ({
        id: d._id,
        date: d.date,
        scheduleId: d.scheduleId ?? null,
        noSchool: d.noSchool,
        cycleDay: d.cycleDay ?? null,
        note: d.note ?? null,
        setByEmail: d.setByEmail ?? null,
      })),
      // What the app believes, right now, in its own words.
      now: {
        ok: context.ok,
        code: context.code,
        reason: context.reason,
        dateKey: context.local?.dateKey ?? null,
        clock: context.local ? formatClock(context.local.minuteOfDay) : null,
        scheduleName: context.scheduleName,
        scheduleSource: context.scheduleSource,
        cycleDay: context.cycleDay,
        periodLabel: context.period?.label ?? null,
      },
      serverTime: now,
    };
  },
});

/**
 * Save the settings singleton.
 *
 * THE TIME ZONE IS TESTED BEFORE IT IS STORED, by asking the runtime to format a
 * date in it. A zone nobody can read is a zone that makes every request refuse,
 * and finding that out at the moment a child is standing in a doorway is too
 * late. Admin only, like every other tag and schedule write.
 */
export const saveSettings = mutation({
  args: {
    timeZone: v.string(),
    defaultScheduleId: v.optional(v.id("bellSchedules")),
    cycleDays: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { timeZone, defaultScheduleId, cycleDays }) => {
    const admin = await requireAdmin(ctx);
    const now = new Date().toISOString();

    const zone = timeZone.trim();
    // Round-tripped through the same function every decision uses, rather than a
    // separate "is this a zone" check that could accept something the decision
    // path then chokes on.
    const probe = localSchoolTime(now, zone);
    if (!probe.ok) throw new ConvexError(probe.reason);

    const cycle = validateCycleDays(cycleDays);
    if (!cycle.ok) throw new ConvexError(cycle.reason);

    if (defaultScheduleId) {
      const target = await ctx.db.get(defaultScheduleId);
      if (!target) throw new ConvexError("That bell schedule no longer exists.");
      if (!target.active) {
        throw new ConvexError(
          `"${target.name}" is retired, so it cannot be the usual schedule. ` +
            `Bring it back first, or choose another.`,
        );
      }
    }

    const existing = await ctx.db
      .query("bellSettings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .first();

    const fields = {
      key: SETTINGS_KEY,
      timeZone: zone,
      cycleDays: cycle.cycleDays,
      updatedAt: now,
      updatedByEmail: admin.email,
      // Written explicitly as undefined when cleared, so "no usual schedule" is
      // reachable. Without it an admin could set a default and never unset it.
      defaultScheduleId: defaultScheduleId ?? undefined,
    };

    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return { outcome: "updated" as const, localTime: formatClock(probe.minuteOfDay) };
    }
    await ctx.db.insert("bellSettings", fields);
    return { outcome: "created" as const, localTime: formatClock(probe.minuteOfDay) };
  },
});

/**
 * Create or replace one named schedule.
 *
 * The periods arrive as "08:15" strings because that is what a person types, and
 * are stored as minutes because that is what the arithmetic needs. parseClock is
 * the only thing that crosses between the two, and it answers null rather than
 * zero for anything unusable: zero is midnight, a real start time, so a parser
 * that defaulted would quietly file a period at 00:00 and route every early
 * morning request into it.
 */
export const saveSchedule = mutation({
  args: {
    id: v.optional(v.id("bellSchedules")),
    name: v.string(),
    weekdays: v.array(v.number()),
    periods: v.array(v.object({ label: v.string(), start: v.string(), end: v.string() })),
  },
  handler: async (ctx, { id, name, weekdays, periods }) => {
    const admin = await requireAdmin(ctx);
    const now = new Date().toISOString();

    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean) throw new ConvexError("A bell schedule needs a name, for example Regular.");
    if (clean.length > 40) throw new ConvexError("Keep the schedule name under 40 characters.");

    const days = validateWeekdays(weekdays);
    if (!days.ok) throw new ConvexError(days.reason);

    const parsed = [];
    for (const row of periods) {
      const startMinute = parseClock(row.start);
      const endMinute = parseClock(row.end);
      if (startMinute === null || endMinute === null) {
        throw new ConvexError(
          `Period "${row.label || "(unnamed)"}" needs times written as HH:MM, ` +
            `for example 08:15. "${row.start}" to "${row.end}" could not be read.`,
        );
      }
      parsed.push({ label: row.label, startMinute, endMinute });
    }

    const checked = validatePeriods(parsed);
    if (!checked.ok) throw new ConvexError(checked.reason);

    if (id) {
      const existing = await ctx.db.get(id);
      if (!existing) throw new ConvexError("That bell schedule no longer exists.");
      await ctx.db.patch(id, {
        name: clean,
        weekdays: days.weekdays!,
        periods: checked.periods!,
        active: true,
        updatedAt: now,
        updatedByEmail: admin.email,
      });
      return { outcome: "updated" as const, id };
    }

    const clash = await ctx.db
      .query("bellSchedules")
      .withIndex("by_name", (q) => q.eq("name", clean))
      .first();
    if (clash) {
      throw new ConvexError(
        `A schedule called "${clean}" already exists. Edit that one, or give this a different name.`,
      );
    }

    const count = (await ctx.db.query("bellSchedules").take(MAX_SCHEDULES)).length;
    if (count >= MAX_SCHEDULES) {
      throw new ConvexError(`${MAX_SCHEDULES} bell schedules is the limit. Retire one first.`);
    }

    const newId = await ctx.db.insert("bellSchedules", {
      name: clean,
      weekdays: days.weekdays!,
      periods: checked.periods!,
      active: true,
      createdAt: now,
      updatedAt: now,
      updatedByEmail: admin.email,
    });
    return { outcome: "created" as const, id: newId };
  },
});

/**
 * Retire a schedule. Never deleted: bellScheduleDays rows point at it, and a
 * deleted schedule turns a marked day into a dangling reference that
 * scheduleForDay has to refuse, on a day somebody deliberately marked.
 */
export const retireSchedule = mutation({
  args: { id: v.id("bellSchedules") },
  handler: async (ctx, { id }) => {
    const admin = await requireAdmin(ctx);
    const row = await ctx.db.get(id);
    if (!row) throw new ConvexError("That bell schedule no longer exists.");

    const current = await ctx.db
      .query("bellSettings")
      .withIndex("by_key", (q) => q.eq("key", SETTINGS_KEY))
      .first();
    if (current && String(current.defaultScheduleId ?? "") === String(id)) {
      throw new ConvexError(
        `"${row.name}" is the usual schedule. Choose a different usual schedule first, ` +
          `or the app will have nothing to fall back to and every request will be refused.`,
      );
    }

    await ctx.db.patch(id, { active: false, updatedAt: new Date().toISOString(), updatedByEmail: admin.email });
    return { retired: row.name };
  },
});

/**
 * Mark one date: which schedule it runs, whether there is school at all, and
 * which cycle day it is.
 *
 * ALL THREE ARE THE SAME KIND OF FACT: something only a human knows, that no
 * table can be asked. The alternative to storing them is guessing, and a guess
 * here is a hall pass in a child's record naming a teacher who never saw them.
 */
export const setDay = mutation({
  args: {
    date: v.string(),
    scheduleId: v.optional(v.id("bellSchedules")),
    noSchool: v.optional(v.boolean()),
    cycleDay: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { date, scheduleId, noSchool, cycleDay, note }) => {
    const admin = await requireAdmin(ctx);
    const now = new Date().toISOString();

    const key = normalizeDateKey(date);
    if (!key) throw new ConvexError("Give the date as YYYY-MM-DD, for example 2026-09-04.");

    if (scheduleId) {
      const target = await ctx.db.get(scheduleId);
      if (!target) throw new ConvexError("That bell schedule no longer exists.");
    }

    const letter = String(cycleDay ?? "").trim().toUpperCase();
    if (letter && letter.length > 4) {
      throw new ConvexError("A cycle day is a short label like A or Day1.");
    }

    const clean = String(note ?? "").replace(/\s+/g, " ").trim().slice(0, 120);

    const existing = await ctx.db
      .query("bellScheduleDays")
      .withIndex("by_date", (q) => q.eq("date", key))
      .first();

    const fields = {
      date: key,
      scheduleId: scheduleId ?? undefined,
      noSchool: noSchool === true,
      cycleDay: letter || undefined,
      note: clean || undefined,
      setByEmail: admin.email,
      setAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return { outcome: "updated" as const, date: key };
    }
    await ctx.db.insert("bellScheduleDays", fields);
    return { outcome: "created" as const, date: key };
  },
});

/** Unmark a date, so it falls back to the usual schedule again. */
export const clearDay = mutation({
  args: { id: v.id("bellScheduleDays") },
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(id);
    if (!row) throw new ConvexError("That day is not marked.");
    await ctx.db.delete(id);
    return { cleared: row.date };
  },
});
