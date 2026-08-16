import { internalMutation } from "./_generated/server";

/**
 * The real Westbrook Academy 2026-27 bell schedules, transcribed from the
 * printed schedule the office published.
 *
 * WHY THIS FILE EXISTS. Hall passes derive their origin from the class a
 * student is scheduled into right now, which needs to know when each period
 * runs. PowerSchool does not grant bell times (no Period or BellSchedule
 * table), so the times are app-owned and live here rather than being typed by
 * hand into Settings, where a transposed digit would silently route a pass to
 * the wrong teacher.
 *
 * THE ONE THING THAT MATTERS FOR ROUTING: a period's `label` is matched
 * against Sections.Expression, so a class period is labelled with its bare
 * NUMBER ("1", "2", ...). Everything that is not a class — Promise Time,
 * Nutrition, the combined Lunch/Power Up block — is labelled descriptively so
 * it matches no section, which is exactly right: a student has no scheduled
 * class during nutrition, so a request then is correctly refused rather than
 * routed.
 *
 * MS vs HS. Middle and high school share identical PERIOD times and differ
 * only on when they take lunch vs Power Up. Since routing keys on the period a
 * section sits in, and the periods are identical, one schedule serves both.
 * During the lunch/power-up block neither division has a class, so it is one
 * non-class block here.
 *
 * Times are minutes after local midnight. Passing periods between blocks are
 * left uncovered on purpose: a request in a 3-minute gap resolves to
 * "between-periods" and is refused, which is honest.
 *
 * Weekday-based, not letter-cycle: M/Th, Tu/F and Wed each run a different
 * schedule, so each regular schedule carries its own weekdays[]. The two
 * special days carry no weekday and are chosen per date in Settings.
 *
 * Run once, then verify in Settings -> Bell Schedule:
 *   CONVEX_DEPLOY_KEY=... npx convex run seedBellSchedules:seedWestbrook
 * Idempotent: it upserts by name, so re-running corrects rather than
 * duplicates.
 */

const t = (h: number, m: number) => h * 60 + m;

// label, start, end. A bare number is a class period (matched to a section).
type P = { label: string; startMinute: number; endMinute: number };
const p = (label: string, sh: number, sm: number, eh: number, em: number): P => ({
  label,
  startMinute: t(sh, sm),
  endMinute: t(eh, em),
});

// ---- Regular: Mondays / Thursdays -> periods 1, 3, 5 ----
const MON_THU: P[] = [
  p("Promise Time", 8, 30, 9, 10),
  p("1", 9, 13, 10, 43),
  p("Nutrition", 10, 43, 10, 58),
  p("3", 11, 1, 12, 31),
  p("Lunch & Power Up", 12, 31, 13, 34),
  p("5", 13, 37, 15, 7),
  p("Promise Time PM", 15, 10, 15, 30),
];

// ---- Regular: Tuesdays / Fridays -> periods 2, 4, 6 ----
const TUE_FRI: P[] = [
  p("Promise Time", 8, 30, 9, 10),
  p("2", 9, 13, 10, 43),
  p("Nutrition", 10, 43, 10, 58),
  p("4", 11, 1, 12, 31),
  p("Lunch & Power Up", 12, 31, 13, 34),
  p("6", 13, 37, 15, 7),
  p("Promise Time PM", 15, 10, 15, 30),
];

// ---- Regular: Wednesdays -> all six periods, shortened ----
const WED: P[] = [
  p("Promise Time", 8, 30, 8, 35),
  p("1", 8, 38, 9, 18),
  p("2", 9, 21, 10, 1),
  p("Nutrition", 10, 1, 10, 16),
  p("3", 10, 19, 10, 59),
  p("4", 11, 2, 11, 42),
  p("Lunch & Power Up", 11, 42, 12, 45),
  p("5", 12, 48, 13, 28),
  p("6", 13, 31, 14, 11),
  p("Promise Time PM", 14, 14, 14, 19),
  // Professional Development 2:30-4:30 is staff-only, not a student period.
];

// ---- Special: Stack Day / Return from Holiday -> all six, 45-min ----
const STACK_DAY: P[] = [
  p("Promise Time", 8, 30, 8, 55),
  p("1", 8, 58, 9, 43),
  p("2", 9, 46, 10, 31),
  p("Nutrition", 10, 31, 10, 46),
  p("3", 10, 49, 11, 34),
  p("4", 11, 37, 12, 22),
  p("Lunch & Power Up", 12, 22, 13, 25),
  p("5", 13, 28, 14, 13),
  p("6", 14, 16, 15, 1),
  p("Promise Time PM", 15, 3, 15, 28),
];

// ---- Special: Minimum Day -> same clock as Wednesday ----
const MINIMUM_DAY: P[] = [
  p("Promise Time", 8, 30, 8, 35),
  p("1", 8, 38, 9, 18),
  p("2", 9, 21, 10, 1),
  p("Nutrition", 10, 1, 10, 16),
  p("3", 10, 19, 10, 59),
  p("4", 11, 2, 11, 42),
  p("Lunch & Power Up", 11, 42, 12, 45),
  p("5", 12, 48, 13, 28),
  p("6", 13, 31, 14, 11),
  p("Promise Time PM", 14, 14, 14, 19),
];

const SCHEDULES: Array<{ name: string; weekdays: number[]; periods: P[] }> = [
  { name: "Regular · Mon/Thu", weekdays: [1, 4], periods: MON_THU },
  { name: "Regular · Tue/Fri", weekdays: [2, 5], periods: TUE_FRI },
  { name: "Regular · Wednesday", weekdays: [3], periods: WED },
  { name: "Stack Day / Return from Holiday", weekdays: [], periods: STACK_DAY },
  { name: "Minimum Day", weekdays: [], periods: MINIMUM_DAY },
];

export const seedWestbrook = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = new Date().toISOString();
    let created = 0;
    let updated = 0;
    const ids: Record<string, string> = {};

    for (const s of SCHEDULES) {
      const existing = await ctx.db
        .query("bellSchedules")
        .withIndex("by_name", (q) => q.eq("name", s.name))
        .unique();
      const doc = {
        name: s.name,
        periods: s.periods,
        weekdays: s.weekdays,
        active: true,
        updatedAt: now,
        updatedByEmail: "seed:westbrook-2026-27",
      };
      if (existing) {
        await ctx.db.patch(existing._id, doc);
        ids[s.name] = existing._id;
        updated++;
      } else {
        const id = await ctx.db.insert("bellSchedules", { ...doc, createdAt: now });
        ids[s.name] = id;
        created++;
      }
    }

    // Settings: time zone is what every period boundary is computed against,
    // and getting it wrong silently shifts every bell. The default schedule is
    // the fallback only when a weekday matches nothing (it never does Mon-Fri
    // here); point it at the Wednesday schedule as a safe all-six default.
    const settings = await ctx.db.query("bellSettings").withIndex("by_key", (q) => q.eq("key", "bell")).unique();
    const settingsDoc = {
      key: "bell",
      timeZone: "America/Los_Angeles",
      defaultScheduleId: ids["Regular · Wednesday"] as any,
      // The school runs a weekday schedule, not a letter cycle, so a section
      // that meets "(A-E)" should always be considered in session. Listing all
      // five letters makes the cycle-day check a non-constraint rather than a
      // gate that would refuse every request.
      cycleDays: ["A", "B", "C", "D", "E"],
      updatedAt: now,
    };
    if (settings) await ctx.db.patch(settings._id, settingsDoc);
    else await ctx.db.insert("bellSettings", settingsDoc as any);

    return { created, updated, schedules: SCHEDULES.map((s) => s.name), timeZone: "America/Los_Angeles" };
  },
});
