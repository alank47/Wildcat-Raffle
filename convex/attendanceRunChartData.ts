import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff } from "./identity";

/**
 * The attendance run chart's stored data, and the two things people do to it:
 * freeze a baseline median, and mark a date. See runChartDays.ts for how the
 * numbers are made and attendanceRunChart.ts for when.
 *
 * SAME GATE AS THE REST OF ATTENDANCE WATCH: admin, superadmin, PBIS. Numbers
 * only -- no student is named anywhere in these tables.
 */
const ROLES = ["admin", "superadmin", "pbis"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MEASURES = ["weeklyRate", "monthlyAvgAbsent", "monthlyChronic"];
const SERIES = ["all", "6-8", "9-12"];

async function gate(ctx: any) {
  const staff = await requireStaff(ctx);
  if (!ROLES.includes(staff.role)) {
    throw new Error("The attendance run chart is limited to administrators and the PBIS team.");
  }
  return staff;
}

const dayRow = v.object({
  date: v.string(), band: v.string(), members: v.number(), absentDays: v.number(),
  fullDaysStrict: v.number(), misrecordDaysByGap: v.array(v.number()), partialDays: v.number(),
  assumedPresentDays: v.number(),
});
const monthRow = v.object({
  month: v.string(), band: v.string(), students: v.number(), memberDays: v.number(),
  fullDayAbsences: v.number(), chronicStudents: v.number(),
});

/**
 * Replace one month of one school year, days and month totals together.
 *
 * WHOLE MONTHS, REPLACED: attendance is corrected after the fact, so a month
 * is rebuilt from PowerSchool rather than appended to. Only the named month's
 * rows are touched; every other month, and the other year, stay as they are.
 */
export const replaceMonth = internalMutation({
  args: {
    yearid: v.number(), month: v.string(), gradeEstimated: v.boolean(), syncedAt: v.string(),
    days: v.array(dayRow), months: v.array(monthRow),
  },
  handler: async (ctx, a) => {
    if (!/^\d{4}-\d{2}$/.test(a.month)) throw new Error("month must be YYYY-MM");
    // An empty rebuild never replaces a stored month (the action refuses
    // first; this is the backstop, because a wiped month is a silent hole).
    if (!a.days.length) throw new Error("Refusing to replace a month with no days.");
    const from = a.month + "-01", to = a.month + "-31";
    const oldDays = await ctx.db.query("attendanceRunDays")
      .withIndex("by_yearid_date", (q) => q.eq("yearid", a.yearid).gte("date", from).lte("date", to)).take(200);
    for (const r of oldDays) await ctx.db.delete(r._id);
    const oldMonths = await ctx.db.query("attendanceRunMonths")
      .withIndex("by_yearid_month", (q) => q.eq("yearid", a.yearid).eq("month", a.month)).take(20);
    for (const r of oldMonths) await ctx.db.delete(r._id);
    for (const d of a.days) {
      if (!d.date.startsWith(a.month)) continue;           // a row outside its month is refused, not misfiled
      await ctx.db.insert("attendanceRunDays", { ...d, yearid: a.yearid, gradeEstimated: a.gradeEstimated, syncedAt: a.syncedAt });
    }
    for (const m of a.months) {
      if (m.month !== a.month) continue;
      await ctx.db.insert("attendanceRunMonths", { ...m, yearid: a.yearid, gradeEstimated: a.gradeEstimated, syncedAt: a.syncedAt });
    }
    return { deletedDays: oldDays.length, deletedMonths: oldMonths.length, days: a.days.length, months: a.months.length };
  },
});

/** Which months of a year have rows: the nightly run mends the gaps. */
export const monthsPresent = internalQuery({
  args: { yearid: v.number() },
  handler: async (ctx, { yearid }) => {
    const rows = await ctx.db.query("attendanceRunMonths")
      .withIndex("by_yearid_month", (q) => q.eq("yearid", yearid)).take(100);
    return [...new Set(rows.map((r) => r.month))];
  },
});

/** Everything the chart draws, in one read. */
export const series = query({
  args: {},
  handler: async (ctx) => {
    const staff = await requireStaff(ctx);
    if (!ROLES.includes(staff.role)) {
      return { allowed: false as const, reason: "The attendance run chart is limited to administrators and the PBIS team.",
               days: [], months: [], baselines: [], annotations: [], truncated: false };
    }
    // ~360 day rows a school year (180 days x 2 bands), so 3000 is about
    // eight years. The caps keep ONE read comfortably under Convex's
    // per-query document limit with everything else it reads; `truncated`
    // makes the screen say so rather than quietly dropping the oldest weeks.
    const CAP = 3000;
    const days = await ctx.db.query("attendanceRunDays").take(CAP + 1);
    const months = await ctx.db.query("attendanceRunMonths").take(400);
    const baselines = (await ctx.db.query("runChartBaselines").take(200)).filter((b) => !b.retiredAt);
    const annotations = (await ctx.db.query("runChartAnnotations").take(300)).filter((n) => !n.removedAt);
    return {
      allowed: true as const, reason: null,
      truncated: days.length > CAP,
      days: days.slice(0, CAP).map((d) => ({
        yearid: d.yearid, date: d.date, band: d.band, members: d.members, absentDays: d.absentDays,
        fullDaysStrict: d.fullDaysStrict, misrecordDaysByGap: d.misrecordDaysByGap, partialDays: d.partialDays,
        gradeEstimated: d.gradeEstimated, syncedAt: d.syncedAt,
      })),
      months: months.map((m) => ({
        yearid: m.yearid, month: m.month, band: m.band, students: m.students, memberDays: m.memberDays,
        fullDayAbsences: m.fullDayAbsences, chronicStudents: m.chronicStudents, gradeEstimated: m.gradeEstimated,
      })),
      baselines: baselines.map((b) => ({
        id: b._id, measure: b.measure, series: b.series, from: b.from, to: b.to, median: b.median,
        points: b.points, frozenAt: b.frozenAt, frozenBy: b.frozenBy, note: b.note ?? null,
      })),
      annotations: annotations.map((n) => ({
        id: n._id, date: n.date, label: n.label, note: n.note ?? null, createdBy: n.createdBy, createdAt: n.createdAt,
      })).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)),
    };
  },
});

/**
 * FREEZE A BASELINE MEDIAN.
 *
 * THE MEDIAN IS STORED AND THEN NEVER RECALCULATED, deliberately. It will look
 * like a bug -- new points arrive and the line does not move -- and it is the
 * method: once a baseline of 10+ points shows no signal, its median is frozen
 * and extended forward, so later points are judged against how things WERE.
 * A median recalculated from every point would drift toward any real change
 * and quietly erase the shift it exists to reveal. To move it, freeze a NEW
 * baseline (the old one is retired, not deleted, with who and why).
 *
 * The browser computes the median from the points it shows and sends it with
 * the range; the server checks the shape and the 10-point minimum. The range
 * is kept, so the screen can say if the data under a frozen median later
 * changed (a corrected absence) without moving the line.
 */
export const freezeBaseline = mutation({
  args: {
    measure: v.string(), series: v.string(), from: v.string(), to: v.string(),
    median: v.number(), points: v.number(), note: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const staff = await gate(ctx);
    if (!MEASURES.includes(a.measure)) throw new Error("Unknown measure.");
    if (!SERIES.includes(a.series)) throw new Error("Unknown series.");
    if (!ISO.test(a.from) || !ISO.test(a.to) || a.from > a.to) throw new Error("The baseline dates could not be read.");
    if (!Number.isFinite(a.median)) throw new Error("The median must be a number.");
    if (!(a.points >= 10)) throw new Error("A baseline needs at least 10 points.");
    const now = new Date().toISOString();
    const who = String((staff as any).email ?? (staff as any).name ?? "unknown");
    const current = await ctx.db.query("runChartBaselines")
      .withIndex("by_measure_series", (q) => q.eq("measure", a.measure).eq("series", a.series)).take(200);
    for (const b of current) {
      if (!b.retiredAt) await ctx.db.patch(b._id, { retiredAt: now, retiredBy: who, retiredWhy: "replaced by a new baseline" });
    }
    const id = await ctx.db.insert("runChartBaselines", {
      measure: a.measure, series: a.series, from: a.from, to: a.to, median: a.median, points: a.points,
      frozenAt: now, frozenBy: who, note: a.note ? String(a.note).slice(0, 300) : undefined,
    });
    return { ok: true, id };
  },
});

/** Unfreeze: back to a provisional median. Kept on record with the reason. */
export const retireBaseline = mutation({
  args: { measure: v.string(), series: v.string(), why: v.string() },
  handler: async (ctx, a) => {
    const staff = await gate(ctx);
    const who = String((staff as any).email ?? (staff as any).name ?? "unknown");
    const why = String(a.why || "").trim().slice(0, 300);
    if (!why) throw new Error("Say why the baseline is being retired.");
    const now = new Date().toISOString();
    const rows = await ctx.db.query("runChartBaselines")
      .withIndex("by_measure_series", (q) => q.eq("measure", a.measure).eq("series", a.series)).take(200);
    let n = 0;
    for (const b of rows) if (!b.retiredAt) { await ctx.db.patch(b._id, { retiredAt: now, retiredBy: who, retiredWhy: why }); n++; }
    return { ok: true, retired: n };
  },
});

/** Mark a date on the chart ("new attendance incentive started"). */
export const addAnnotation = mutation({
  args: { date: v.string(), label: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const staff = await gate(ctx);
    const label = String(a.label || "").trim();
    if (!ISO.test(a.date)) throw new Error("The date could not be read.");
    if (!label) throw new Error("Give the note a short label.");
    const id = await ctx.db.insert("runChartAnnotations", {
      date: a.date, label: label.slice(0, 80), note: a.note ? String(a.note).trim().slice(0, 500) : undefined,
      createdBy: String((staff as any).email ?? (staff as any).name ?? "unknown"), createdAt: new Date().toISOString(),
    });
    return { ok: true, id };
  },
});

/** Take a mark off the chart. Kept on record, never deleted. */
export const removeAnnotation = mutation({
  args: { id: v.id("runChartAnnotations") },
  handler: async (ctx, { id }) => {
    const staff = await gate(ctx);
    const row = await ctx.db.get(id);
    if (!row || row.removedAt) return { ok: true, already: true };
    await ctx.db.patch(id, { removedAt: new Date().toISOString(), removedBy: String((staff as any).email ?? "unknown") });
    return { ok: true };
  },
});
