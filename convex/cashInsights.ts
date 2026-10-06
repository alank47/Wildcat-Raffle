import { query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireStaff } from "./identity";
import { rosterEmailFor } from "./views_app";
import { canReadInsights } from "./accessRules";
import { outcomeWeeks, withoutAttendance, laDayOf } from "./cashInsightsRules";

/**
 * WHAT CASH ANALYTICS > TRENDS CANNOT WORK OUT FROM THE LEDGER (2026-10-06).
 *
 * Every staff browser already holds the whole cash ledger, so every cash
 * figure on Trends -- clicks, one-to-one praise, reach, expectation balance --
 * is worked out there and costs the server nothing. Three things are not in
 * the ledger, and this is the one small read that supplies them:
 *
 *   1. THE SCHOOL CALENDAR: which days were school days (completed only), so
 *      "the last 10 school days" is the school's calendar, not a guess from
 *      which weekdays had awards.
 *   2. THE ATTENDANCE LINES for the behaviour-change check: weekly unexcused
 *      tardies and part-day absences per campus (cashInsightsRules.ts).
 *   3. WHO TEACHES A POWERSCHOOL CLASS: the participation denominator. Any
 *      role -- four of the 34 on 2026-10-06 are not teacher accounts -- and a
 *      psEmail patch counts exactly as it does for the roster (rosterEmailFor).
 *
 * CAMPUS-LEVEL AND NAMELESS. The calendar and the class list go to every
 * staff role (the accepted recommendation: all staff, by campus, no names).
 * THE ATTENDANCE LINES DO NOT (review, 2026-10-06): they are the same campus
 * sums the attendance run chart refuses to anyone but administrators, the
 * PBIS team and Attendance Watch, so they follow that rule
 * (accessRules.canReadInsights) -- everyone else gets the weeks without them,
 * and the marks are not even read. It returns weekly sums for grades 6-8 and
 * 9-12, dates, and staff ids -- never a student name, number or grade-level
 * row. Students are refused by requireStaff.
 *
 * WHAT IT READS, bounded and never growing with the cash ledger:
 *   attendanceRunDays  this year's rows, by index (~360 a year)
 *   psAttendanceMarks  one row per enrolled student (607 rows, ~0.4 MiB today),
 *                      and only for a viewer who may read attendance
 *   teachers           every staff row (63)
 *   psRoster           ONE row per staff member, by index, just to ask "any?"
 * It never reads legacyMirror or students: see read-walls.test.mjs. Measured
 * nightly by readHeadroom.ts as "cashInsights:trendsContext".
 */

/** About two school years of day rows per band; `truncated` says so if ever reached. */
const RUN_DAYS_CAP = 800;
/** Well above the ~610 enrolled. The same ceiling attendanceList.ts uses. */
const MARKS_CAP = 3000;
const STAFF_CAP = 500;

export const trendsContext = query({
  args: { today: v.string() },
  handler: async (ctx, { today }) => {
    const me = await requireStaff(ctx);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today))) {
      throw new ConvexError("today must be a calendar day, YYYY-MM-DD.");
    }
    const attendance = canReadInsights(me);

    // THE CURRENT SCHOOL YEAR is the newest one the run table holds.
    const newest = await ctx.db.query("attendanceRunDays").withIndex("by_yearid_date").order("desc").first();
    const yearid = newest ? newest.yearid : null;
    const runRows = yearid === null ? [] : await ctx.db.query("attendanceRunDays")
      .withIndex("by_yearid_date", (q) => q.eq("yearid", yearid)).take(RUN_DAYS_CAP + 1);
    const marks = attendance ? await ctx.db.query("psAttendanceMarks").take(MARKS_CAP + 1) : [];
    const staff = await ctx.db.query("teachers").take(STAFF_CAP + 1);

    // WHO HAS A POWERSCHOOL CLASS: one indexed first() per staff member.
    // With the day each record was created (Los Angeles), so last week's
    // participation is out of those who existed that week (review,
    // 2026-10-06: a teacher added on 10/5 was in the denominator for 9/28).
    const ids: Array<[string, string]> = [];
    const createdDays: Array<string | null> = [];
    for (const t of staff.slice(0, STAFF_CAP)) {
      const lookup = await rosterEmailFor(ctx, t);
      if (!lookup.email) continue;
      const hit = await ctx.db.query("psRoster")
        .withIndex("by_teacherEmail", (q) => q.eq("teacherEmail", lookup.email)).first();
      // [the id the app and the ledger use, the Convex id]: toAppTeacher's rule.
      if (hit) {
        ids.push([String(t.legacyId ?? t._id), String(t._id)]);
        createdDays.push(laDayOf(new Date(t._creationTime).toISOString()));
      }
    }

    // The server's own day bounds the browser's (outcomeWeeks).
    const serverDay = laDayOf(new Date(Date.now()).toISOString());
    const out = outcomeWeeks({ runDays: runRows.slice(0, RUN_DAYS_CAP), marks: marks.slice(0, MARKS_CAP), today, serverDay });
    return {
      allowed: true as const,
      attendance,
      yearid,
      through: out.through,
      runBuiltThrough: out.runBuiltThrough,
      marksThrough: out.marksThrough,
      schoolDates: out.schoolDates,
      weeks: attendance ? out.weeks : withoutAttendance(out.weeks),
      marksRows: out.marksRows,
      marksMissingUnexcused: out.marksMissingUnexcused,
      marksOutsideBands: out.marksOutsideBands,
      rosterStaff: { count: ids.length, ids, createdDays },
      truncated: {
        runDays: runRows.length > RUN_DAYS_CAP,
        marks: marks.length > MARKS_CAP,
        staff: staff.length > STAFF_CAP,
      },
    };
  },
});
