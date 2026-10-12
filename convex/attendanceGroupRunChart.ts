import { query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff } from "./identity";
import { GROUP_NONE } from "./runChartDays";
import {
  AXES, GROUP_AXES, SERIES, TYPE_LABELS, FAMILY_AXES, NEVER_CHARTED, groupTypesFor,
  CHART_FLOOR, DAY_FLOOR, SMALL_CHART_GROUP, SIZE_ROUND, roundSize, checkPeriods, evaluatePeriods,
  addDaysIso, laDayOf, typicalRows, linesForYear, currentAxes, keptDates, type GroupType, type StoredGroupDay,
} from "./runChartGroups";

/**
 * THE WEEKLY ATTENDANCE RATE BY STUDENT GROUP (2026-10-12): the stored group
 * rows, the one read the Student groups card makes, and the nightly write.
 * Every rule that decides a number or a refusal is in runChartGroups.ts.
 *
 * WHAT LEAVES HERE IS RATES. One whole-day attendance rate per period asked
 * for, to one decimal, for the line chosen and for the rest of the school;
 * each group's size rounded to the nearest 5. Never members, student-days,
 * absence counts, dates of membership, or any id: a group's members on a
 * named day ("one more on 10/7") can be matched to the named lists PBIS
 * already sees. The test pins the response's keys.
 *
 * NOT attendanceRunDays, NOT attendanceRunChartData:series. Those carry the
 * Trends lines, which the Attendance Watch grant and every teacher's Cash
 * Analytics read; a group row there would be summed into the whole school
 * and handed to both. The whole-school line on the group card is drawn from
 * Trends itself, by the browser, so the two can never disagree.
 *
 * THE PILOT'S ACCESS CHECK, read-only, as a named staff member (the tenant
 * from `npx convex env get ENTRA_TENANT_ID --prod`):
 *   npx convex run --prod --identity '{"issuer":"https://login.microsoftonline.com/<tenant>/v2.0",
 *     "email":"<staff email>","subject":"verify","tokenIdentifier":"x"}' attendanceGroupRunChart:groupWeeks '{}'
 * The grant holder must list Female and Male only; a teacher, refused; PBIS,
 * no race line; an admin, every line the floors allow.
 */

const groupDayRow = v.object({
  date: v.string(), axis: v.string(), group: v.string(), members: v.number(), absentDays: v.number(),
  fullDaysStrict: v.number(), misrecordDaysByGap: v.array(v.number()), partialDays: v.number(),
  assumedPresentDays: v.number(),
});

/** One month is at most 23 school days x 12 rows; far past it means something is wrong, and nothing is written. */
const MONTH_ROW_CAP = 2000;
/** A school year of every group row (~180 days x 12 = 2,160). Past it the answer would be a slice, so none is given. */
const YEAR_ROW_CAP = 4000;
/** Rows of one axis over the periods asked for (120 periods of 4 weeks is the most; two years is ~1,600). */
const RANGE_ROW_CAP = 6000;

/**
 * Replace one month of group rows for the axes built, IN ONE MUTATION with
 * their "none" rows -- the residual test reads both, and a stale half would
 * pass it with the true pool still small. Axes not built this time keep their
 * stored rows (a failed race lookup tonight does not blank the Black line);
 * the month's status row records what was built and what was skipped, why.
 * And a week that could already have been served keeps its stored rows on
 * every axis built (runChartGroups.keptDates): a served week's value never
 * changes, so no two mornings subtract to the night's corrections.
 *
 * REFUSES rows that do not add up: every axis must hold every school day once,
 * each group once, and add up to the whole school exactly (the band build's
 * members and absent days, passed in as `whole`, never stored here).
 */
export const replaceGroupMonth = internalMutation({
  args: {
    yearid: v.number(), month: v.string(), syncedAt: v.string(),
    axes: v.array(v.string()), schoolDays: v.array(v.string()),
    whole: v.array(v.object({ date: v.string(), members: v.number(), absentDays: v.number() })),
    days: v.array(groupDayRow),
    skipped: v.array(v.object({ axis: v.string(), reason: v.string() })),
    // The school's between-student variance of the month's whole-day rate
    // (runChartDays.rateSpread): one number, for the chance band. Optional:
    // a build that could not make the group rows has none.
    rateVar: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    if (!/^\d{4}-\d{2}$/.test(a.month)) throw new Error("month must be YYYY-MM");
    const axes = [...new Set(a.axes)];
    if (axes.length !== a.axes.length || axes.some((x) => !AXES.includes(x))) throw new Error("Unknown or repeated axis.");
    if (axes.includes("el") !== axes.includes("ela")) {
      throw new Error("English Learner and the classification share rows, so they are written together or not at all.");
    }
    let written = 0, keptDays = 0;
    if (axes.length) {
      if (!a.schoolDays.length) throw new Error("Refusing to replace a month of group rows with no school days.");
      const days = new Set(a.schoolDays);
      if (days.size !== a.schoolDays.length || a.schoolDays.some((d) => !d.startsWith(a.month))) {
        throw new Error("The school days must be distinct days of the month.");
      }
      const whole = new Map(a.whole.map((w) => [w.date, w]));
      if (whole.size !== days.size || [...days].some((d) => !whole.has(d))) throw new Error("The whole-school totals do not match the school days.");
      const seen = new Map<string, (typeof a.days)[number]>();
      for (const r of a.days) {
        if (!axes.includes(r.axis) || !days.has(r.date)) throw new Error("A group row is outside the axes or days being written.");
        if (![...GROUP_AXES[r.axis], GROUP_NONE].includes(r.group)) throw new Error("A group row names an unknown group.");
        const k = r.date + "|" + r.axis + "|" + r.group;
        if (seen.has(k)) throw new Error("A group row is repeated.");
        seen.set(k, r);
      }
      for (const d of days) {
        const w = whole.get(d)!;
        for (const axis of axes) {
          const groups = [...GROUP_AXES[axis], GROUP_NONE];
          if (groups.some((g) => !seen.has(d + "|" + axis + "|" + g))) throw new Error("A school day is missing a group row.");
          let members = 0, absent = 0;
          for (const g of groups) { const r = seen.get(d + "|" + axis + "|" + g)!; members += r.members; absent += r.absentDays; }
          // The classification leaves current English Learners out (they are
          // el:el), so it adds up to the whole school WITH that row.
          if (axis === "ela") { const el = seen.get(d + "|el|el")!; members += el.members; absent += el.absentDays; }
          if (members !== w.members || absent !== w.absentDays) {
            throw new Error(`The ${axis} rows do not add up to the whole school on a day; nothing was written.`);
          }
        }
      }
      const buildDay = laDayOf(a.syncedAt);
      if (!buildDay) throw new Error("syncedAt must be the time of the build.");
      const from = a.month + "-01", to = a.month + "-31";
      const old = await ctx.db.query("attendanceRunGroupDays")
        .withIndex("by_yearid_date", (q) => q.eq("yearid", a.yearid).gte("date", from).lte("date", to)).take(MONTH_ROW_CAP + 1);
      if (old.length > MONTH_ROW_CAP) throw new Error("More stored group rows in the month than a month can hold; nothing was written.");
      // A WEEK THAT COULD HAVE BEEN SERVED KEEPS ITS ROWS, so it is served
      // with one value for good (runChartGroups.keptDates): its stored rows
      // stay, and tonight's rows for its days are dropped.
      const kept = new Map(axes.map((axis) => [axis, keptDates(old.filter((r) => r.axis === axis), a.schoolDays, buildDay)]));
      for (const r of old) if (axes.includes(r.axis) && !kept.get(r.axis)!.has(r.date)) await ctx.db.delete(r._id);
      for (const r of a.days) {
        if (kept.get(r.axis)!.has(r.date)) continue;
        await ctx.db.insert("attendanceRunGroupDays", { ...r, yearid: a.yearid, syncedAt: a.syncedAt });
        written++;
      }
      keptDays = new Set([...kept.values()].flatMap((s) => [...s])).size;
    }
    const status = await ctx.db.query("attendanceRunGroupMonths")
      .withIndex("by_yearid_month", (q) => q.eq("yearid", a.yearid).eq("month", a.month)).take(5);
    const prev = status[0];
    const touched = new Set([...axes, ...a.skipped.map((s) => s.axis)]);
    const built = (prev?.built ?? []).filter((b) => !axes.includes(b.axis)).concat(axes.map((axis) => ({ axis, syncedAt: a.syncedAt })));
    const skipped = (prev?.skipped ?? []).filter((s) => !touched.has(s.axis))
      .concat(a.skipped.map((s) => ({ axis: s.axis, reason: String(s.reason).slice(0, 300), at: a.syncedAt })));
    const rateVar = a.rateVar !== undefined && Number.isFinite(a.rateVar) && a.rateVar >= 0 ? { rateVar: a.rateVar } : {};
    for (const extra of status.slice(1)) await ctx.db.delete(extra._id);
    if (prev) await ctx.db.patch(prev._id, { built, skipped, updatedAt: a.syncedAt, ...rateVar });
    else await ctx.db.insert("attendanceRunGroupMonths", { yearid: a.yearid, month: a.month, built, skipped, updatedAt: a.syncedAt, ...rateVar });
    return { written, keptDays, axes, skipped: a.skipped.map((s) => s.axis) };
  },
});

/** Which axes each stored month of a year has CURRENT rows for: the nightly run mends the rest. */
export const groupMonthsStatus = internalQuery({
  args: { yearid: v.number() },
  handler: async (ctx, { yearid }) => {
    const rows = await ctx.db.query("attendanceRunGroupMonths")
      .withIndex("by_yearid_month", (q) => q.eq("yearid", yearid)).take(100);
    return rows.map((r) => ({ month: r.month, built: currentAxes(r) }));
  },
});

/** Said to anyone the role list and the grant both leave out. */
const REFUSED = "Attendance by student group is limited to administrators, the PBIS team and, for gender only, "
  + "staff given Attendance Watch access.";

/**
 * THE GROUP CARD'S ONE READ.
 *
 *   no `group`             the groups this person may see (and those they
 *                          may not, with why), nothing else
 *   `group`, `periods`     that line's rate for each period, and the rest of
 *                          the school's, withheld where the floors say so
 *
 * `periods` are the browser's week groups (runWeekGroups on the Trends rows),
 * each named by its Mondays; `misrecordAt` is the screen's threshold, applied
 * here through absenceDayRules.fullDaysAt so the line reads like Trends.
 */
export const groupWeeks = query({
  args: {
    group: v.optional(v.string()),
    periods: v.optional(v.array(v.array(v.string()))),
    misrecordAt: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const staff = await requireStaff(ctx);
    // A DIRECT ROLE LIST, and the grant for gender only (runChartGroups.ts),
    // decided before any table is read.
    const types = groupTypesFor(staff);
    const empty = { groups: [], unavailable: [], group: null, periods: [], vsRest: null };
    if (!types.length) return { allowed: false as const, reason: REFUSED, ...empty };

    // Refuse a malformed request before reading anything.
    let periods: string[][] | null = null;
    if (a.periods !== undefined) {
      const c = checkPeriods(a.periods);
      if (!c.ok) return { allowed: true as const, invalid: c.reason, ...empty };
      periods = c.periods;
    }

    // THIS SCHOOL YEAR'S ROWS: a group's typical day decides whether it is
    // offered at all (CHART_FLOOR) and which line goes first when the
    // residual test needs one gone (smallest first). This year is the newest
    // on Trends too: last year's group rows, backfilled before this year's
    // were built, never set this year's floors.
    const newestGroup = await ctx.db.query("attendanceRunGroupDays").withIndex("by_yearid_date").order("desc").first();
    const newestTrends = await ctx.db.query("attendanceRunDays").withIndex("by_yearid_date").order("desc").first();
    const newest = newestGroup ? { yearid: Math.max(newestGroup.yearid, newestTrends?.yearid ?? newestGroup.yearid) } : null;
    const unavailable: Array<{ type: string; group: string; reason: string }> = [];
    if (!types.includes("race") && types.includes("el")) {
      unavailable.push({ type: "race", group: "Race or ethnicity", reason: "Race lines are shown to administrators only." });
    }
    if (!types.includes("el")) {
      unavailable.push({ type: "el", group: "English Learner, language classification and race",
        reason: "Attendance Watch access shows the gender lines only." });
    }
    if (types.includes("race")) for (const n of NEVER_CHARTED) unavailable.push({ type: n.type, group: n.group, reason: n.reason });
    if (!newest) {
      return { allowed: true as const, notYet: "The group lines have not been built yet. They are built overnight.",
               ...empty, unavailable };
    }
    const yearRows = await ctx.db.query("attendanceRunGroupDays")
      .withIndex("by_yearid_date", (q) => q.eq("yearid", newest.yearid)).take(YEAR_ROW_CAP + 1);
    if (yearRows.length > YEAR_ROW_CAP) {
      return { allowed: true as const, notYet: "This year's group rows are longer than this reads. Tell an administrator.",
               ...empty, unavailable };
    }
    let asOf = "";
    for (const r of yearRows) if (r.syncedAt > asOf) asOf = r.syncedAt;
    const typical = typicalRows(yearRows);
    const months = await ctx.db.query("attendanceRunGroupMonths")
      .withIndex("by_yearid_month", (q) => q.eq("yearid", newest.yearid)).take(30);
    // A skip still on record is a CURRENT one: a later build of that axis
    // clears it (replaceGroupMonth), so its days are missing until then.
    const skipWhy = (axis: string) => {
      let latest: { reason: string; at: string } | null = null;
      for (const m of months) for (const s of m.skipped) if (s.axis === axis && (!latest || s.at > latest.at)) latest = s;
      return latest?.reason ?? null;
    };

    // WHICH LINES THIS YEAR MAY SHOW, family by family, from the lines this
    // person may see that have rows: the floor of 30 on a typical day, for
    // each line AND for every pool the lines and the whole school subtract to
    // (linesForYear).
    const visible = SERIES.filter((s) => types.includes(s.type));
    const thisYear = new Map<string, ReturnType<typeof linesForYear>>();
    for (const f of new Set(visible.map((s) => s.family))) {
      const candidates = [...new Set(visible.filter((s) => s.family === f && typical.has(s.row)).map((s) => s.row))];
      thisYear.set(f, linesForYear(f, yearRows, candidates));
    }
    const groups: Array<{ id: string; type: GroupType; typeLabel: string; label: string; size: number; small: boolean; sameAs?: string }> = [];
    for (const s of visible) {
      const t = typical.get(s.row);
      if (t === undefined) {
        const why = skipWhy(s.row.split(":")[0]);
        unavailable.push({ type: s.type, group: s.label,
          reason: why ? "Not built this year: " + why : "No figures for this group yet this year." });
        continue;
      }
      const lines = thisYear.get(s.family)!;
      if (lines.under.includes(s.row)) {
        unavailable.push({ type: s.type, group: s.label,
          reason: `Fewer than ${CHART_FLOOR} students on a typical school day this year, so one or two students `
            + "would move its weekly rate. It is not charted." });
        continue;
      }
      if (lines.pool.includes(s.row)) {
        unavailable.push({ type: s.type, group: s.label,
          reason: "Drawn beside the other lines of its kind and the whole school, it would let a group of fewer than "
            + `${CHART_FLOOR} students be worked out by subtraction, so it is not charted this year.` });
        continue;
      }
      groups.push({ id: s.id, type: s.type, typeLabel: TYPE_LABELS[s.type], label: s.label,
        size: roundSize(t), small: t < SMALL_CHART_GROUP, ...(s.sameAs ? { sameAs: s.sameAs } : {}) });
    }
    const listed = {
      allowed: true as const, groups, unavailable, asOf,
      floors: { chart: CHART_FLOOR, day: DAY_FLOOR, small: SMALL_CHART_GROUP, sizeRoundedTo: SIZE_ROUND },
      // English Learner lines use each student's status ON EACH DATE (the
      // PowerSchool history), not today's status applied backwards.
      elBasis: "status on each date",
    };
    if (a.group === undefined) return { ...listed, group: null, periods: [], vsRest: null };

    const series = SERIES.find((s) => s.id === a.group);
    const chosen = series ? groups.find((g) => g.id === series.id) : undefined;
    if (!series || !chosen) {
      return { ...listed, refused: "That group is not available to you.", group: null, periods: [], vsRest: null };
    }
    // Days of this line a failed PowerSchool read left unbuilt, and why:
    // the mend retries them each night (refreshCurrent).
    const why = FAMILY_AXES[series.family].map(skipWhy).find((x) => x !== null) ?? null;
    const notBuilt = why ? { notBuilt: why } : {};
    if (!periods) return { ...listed, group: chosen, periods: [], vsRest: null, ...notBuilt };

    // THE FAMILY'S ROWS IN RANGE.
    const min = periods.reduce((m, p) => (p[0] < m ? p[0] : m), periods[0][0]);
    const max = addDaysIso(periods.reduce((m, p) => (p[p.length - 1] > m ? p[p.length - 1] : m), periods[0][0]), 4);
    const rows: StoredGroupDay[] = [];
    for (const axis of FAMILY_AXES[series.family]) {
      const got = await ctx.db.query("attendanceRunGroupDays")
        .withIndex("by_axis_date", (q) => q.eq("axis", axis).gte("date", min).lte("date", max)).take(RANGE_ROW_CAP + 1);
      if (got.length > RANGE_ROW_CAP) return { ...listed, invalid: "That is more weeks than one answer can read.", group: chosen, periods: [], vsRest: null };
      rows.push(...got);
    }
    // THE SCHOOL DAYS TRENDS HAS, over the WHOLE MONTHS the periods touch,
    // and how far each month's build reached (the day before the build's own
    // day in Los Angeles): a week is served only once no build can add a day
    // to it.
    const years = new Set<number>([newest.yearid, newest.yearid - 1, ...rows.map((r) => r.yearid)]);
    const trendsDays = new Map<string, number>();
    const monthSync = new Map<string, string>();
    for (const y of years) {
      const t = await ctx.db.query("attendanceRunDays")
        .withIndex("by_yearid_date", (q) => q.eq("yearid", y).gte("date", min.slice(0, 7) + "-01").lte("date", max.slice(0, 7) + "-31"))
        .take(2000);
      for (const r of t) {
        trendsDays.set(r.date, r.yearid);
        const m = r.date.slice(0, 7);
        const was = monthSync.get(m);
        if (was === undefined || r.syncedAt < was) monthSync.set(m, r.syncedAt);
      }
    }
    const dayBefore = (at: unknown) => { const d = laDayOf(at); return d ? addDaysIso(d, -1) : null; };
    const builtThrough = new Map<string, string>();
    for (const [m, at] of monthSync) { const d = dayBefore(at); if (d) builtThrough.set(m, d); }

    // THE LINES EACH YEAR MAY SHOW: this year's as listed; any other year's,
    // from those, on that year's own figures.
    const offeredByYear = new Map<number, string[]>([[newest.yearid, thisYear.get(series.family)!.kept]]);
    for (const y of new Set(trendsDays.values())) {
      if (offeredByYear.has(y)) continue;
      const other = await ctx.db.query("attendanceRunGroupDays")
        .withIndex("by_yearid_date", (q) => q.eq("yearid", y)).take(YEAR_ROW_CAP + 1);
      if (other.length > YEAR_ROW_CAP) return { ...listed, invalid: "That year's group rows are longer than this reads.", group: chosen, periods: [], vsRest: null };
      offeredByYear.set(y, linesForYear(series.family, other, offeredByYear.get(newest.yearid)!).kept);
    }
    const order = offeredByYear.get(newest.yearid)!.slice()
      .sort((x, y) => (typical.get(x)! - typical.get(y)!) || (x < y ? -1 : x > y ? 1 : 0));
    // The school's spread of student rates this year, for the chance band.
    const spreads = months.map((m) => m.rateVar).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    const spread = spreads.length ? spreads.reduce((p, q) => p + q, 0) / spreads.length : null;
    const out = evaluatePeriods({
      series, periods, trendsDays, builtThrough, newestBuilt: dayBefore(newestTrends?.syncedAt), today: laDayOf(Date.now())!,
      rows, offeredByYear, order, misrecordAt: a.misrecordAt, newestYear: newest.yearid, spread,
    });
    if (!out.ok) return { ...listed, invalid: out.reason, group: chosen, periods: [], vsRest: null };
    return { ...listed, group: chosen, periods: out.periods, vsRest: out.vsRest, ...notBuilt };
  },
});
