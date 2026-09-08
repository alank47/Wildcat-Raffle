import { query } from "./_generated/server";
import { requireStaff } from "./identity";
import { dayCount } from "./views";

/**
 * The school-wide attendance figures behind the chronic absence list.
 *
 * WHY THIS RETURNS NUMBERS AND NOT STUDENTS.
 *
 * The browser already holds the roster, so it can put a name beside a student
 * number without help. That makes it possible to answer "how many days has
 * each child missed" without a single name, grade, address or race crossing
 * the wire, and it means this function can never be the thing that leaks a
 * student record, because it never builds one.
 *
 * The ranking, the thresholds and the tiers are all computed in the browser by
 * WildcatRoster.attendanceRanking. That is deliberate: those are display rules
 * that will be argued about and adjusted, and they belong somewhere they can
 * be changed and unit-tested without a deploy.
 *
 * WHO MAY ASK.
 *
 * Admin, superadmin and PBIS, the same list that reaches Discipline Analytics
 * and Student History. A whole-school attendance ranking is a discipline
 * record: it names the children the school is most worried about, and a
 * teacher who may only file a referral about their own class has no business
 * with it. Campus aides are excluded for the same reason they are excluded
 * from the referral history.
 */
const ATTENDANCE_ROLES = ["admin", "superadmin", "pbis"];

/**
 * Ceiling on rows read, well above the ~671 the school actually has.
 *
 * Convex allows 4,096 document reads per call and this reads one table, so the
 * cap is not about the limit -- it is about noticing. If enrolment ever climbs
 * past this, `truncated` says so on screen rather than the list quietly
 * ending early and a chronically absent child never appearing on it.
 */
const MAX_ROWS = 3000;

export const schoolAttendance = query({
  args: {},
  handler: async (ctx) => {
    const staff = await requireStaff(ctx);
    if (!ATTENDANCE_ROLES.includes(staff.role)) {
      return {
        allowed: false,
        reason:
          "The attendance list is limited to administrators and the PBIS team. " +
          "Ask an administrator to set your access level to PBIS Team.",
        rows: [],
        truncated: false,
        termFirstDay: null as string | null,
        lastSyncedAt: null as string | null,
      };
    }

    const raw = await ctx.db.query("psAttendance").take(MAX_ROWS + 1);
    const truncated = raw.length > MAX_ROWS;
    const rows = truncated ? raw.slice(0, MAX_ROWS) : raw;

    // dayCount, not `?? 0`. views.ts spends thirty lines on why, and the short
    // version is that "0 days absent" and "we were never told" are opposite
    // facts about a child that render identically. A null here keeps the
    // student off the ranking and onto the "no attendance on file" line.
    const out = rows.map((r) => ({
      studentNumber: String(r.studentNumber || ""),
      daysAbsent: dayCount(r.daysAbsentYtd),
      daysTardy: dayCount(r.daysTardyTerm),
    })).filter((r) => r.studentNumber !== "");

    // The term's own first day, if the SIS sent one. The browser prefers this
    // over the hardcoded start date, so that when the term rolls over in
    // January nobody has to remember to edit a constant.
    let termFirstDay: string | null = null;
    let lastSyncedAt: string | null = null;
    for (const r of rows) {
      if (!termFirstDay && typeof r.termFirstDay === "string" && r.termFirstDay) {
        termFirstDay = r.termFirstDay;
      }
      const s = typeof r.syncedAt === "string" ? r.syncedAt : null;
      if (s && (!lastSyncedAt || s > lastSyncedAt)) lastSyncedAt = s;
    }

    return { allowed: true, rows: out, truncated, termFirstDay, lastSyncedAt };
  },
});
