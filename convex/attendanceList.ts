import { query } from "./_generated/server";
import { v } from "convex/values";
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

    // THE FULL/PARTIAL SPLIT, per student, precomputed by the per-date
    // rebuild. 618 rows, so the whole-school list stays one cheap read:
    // re-summing the 2,577 per-date rows here would put this query near
    // Convex's 4,096 document limit and past it by spring. take() only costs
    // the rows that exist, so the generous cap is free.
    //
    // COMPONENTS ONLY. The browser decides what counts as a full day, because
    // the misrecord threshold is a display rule the school will argue about.
    const totalRows = await ctx.db.query("psAbsenceTotals").take(MAX_ROWS + 1);
    const totalsBy: Record<string, any> = {};
    for (const t of totalRows) {
      const n = String(t.studentNumber || "");
      if (!n) continue;
      totalsBy[n] = t;
    }

    // dayCount, not `?? 0`. views.ts spends thirty lines on why, and the short
    // version is that "0 days absent" and "we were never told" are opposite
    // facts about a child that render identically. A null here keeps the
    // student off the ranking and onto the "no attendance on file" line.
    const out = rows.map((r) => {
      const n = String(r.studentNumber || "");
      const t = totalsBy[n];
      return {
        studentNumber: n,
        daysAbsent: dayCount(r.daysAbsentYtd),
        daysTardy: dayCount(r.daysTardyTerm),
        // THE SPLIT, or null when the rebuild has not covered this student.
        // Null is not zero: "no full days" and "not worked out yet" are
        // different facts, and a zero would read as the good news.
        split: t
          ? {
              absentDays: t.absentDays, fullDaysStrict: t.fullDaysStrict,
              misrecordDaysByGap: t.misrecordDaysByGap,
              partialDays: t.partialDays, assumedPresentDays: t.assumedPresentDays,
            }
          : null,
      };
    }).filter((r) => r.studentNumber !== "");

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

    return {
      allowed: true, rows: out, truncated, termFirstDay, lastSyncedAt,
      // So the screen can tell "nobody has full days" from "the per-date
      // rebuild has not run", which is the same null-versus-zero rule.
      splitCoverage: totalRows.length,
      splitTruncated: totalRows.length > MAX_ROWS,
    };
  },
});

/**
 * ONE STUDENT'S ABSENCE, BROKEN DOWN BY PERIOD.
 *
 * WHY THIS SCREEN EXISTS. The row on Attendance Watch says a child missed six
 * days. It cannot say whether that is six days out of school or six mornings
 * they arrived after Promise Time, and at this school that distinction is most
 * of the signal: measured 2026-09-21, of 10,719 absent period-days, 3,753
 * (35%) are Promise Time -- the advisory block at each end of the day --
 * against 5,519 for all six academic periods put together. The average flagged
 * day covers 3.89 of about 6 blocks. A student who misses Promise Time AM and
 * sits in every lesson is, today, indistinguishable from a student who never
 * came in.
 *
 * NO NAME CROSSES THE WIRE, same as schoolAttendance. The browser already
 * holds the roster and puts the name on; this returns figures for a student
 * number and nothing else, so it can never be the thing that leaks a record.
 *
 * NO RATE, NO PERCENTAGE, NO "N OF M MEETINGS" -- deliberately, because no
 * denominator exists. The section expression carries no weekday, the source
 * query returns no meetings-scheduled count, and the school runs a block
 * timetable where Monday and Thursday take one set of periods and Tuesday and
 * Friday another. Counts are honest; a rate would be invented.
 *
 * THE PERIOD LABEL IS THE BROWSER'S JOB. WildcatRoster.classifySection already
 * translates a PowerSchool slot into the school's spoken period name, is
 * pinned by two test files, and is already on screen in two dropdowns. A
 * second mapping here would be the copy that drifts. This returns the raw
 * expression and the course name and lets that function decide.
 */
export const studentPeriods = query({
  args: { studentNumber: v.string() },
  handler: async (ctx, { studentNumber }) => {
    const staff = await requireStaff(ctx);
    if (!ATTENDANCE_ROLES.includes(staff.role)) {
      return {
        allowed: false as const,
        reason:
          "Per-period attendance is available to administrators and the PBIS team. " +
          "Ask an administrator to set your access level to PBIS Team.",
        rows: [], day: null, studentNumber: "",
      };
    }

    // NEVER QUERY AN EMPTY KEY. q.eq("studentNumber", "") is not a no-op: it
    // matches every unkeyed row, so an unkeyed student would be shown another
    // child's absences under their own name and nothing would error.
    const key = String(studentNumber || "").trim();
    if (!key) {
      return {
        allowed: true as const,
        reason: "This student has no PowerSchool number on file, so their attendance cannot be looked up.",
        rows: [], day: null, studentNumber: "",
      };
    }

    const sections = await ctx.db
      .query("psAttendanceBySection")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", key))
      .take(40);

    // The day-level figures the row already showed, so the breakdown can be
    // reconciled against them on screen rather than in somebody's head.
    const dayRow = await ctx.db
      .query("psAttendance")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", key))
      .first();

    // THE PER-DATE PICTURE, which is what turns "6 days absent" into "2 full
    // days and 4 partial". Counts only: the browser decides what counts as a
    // full day, because the misrecord threshold is a rule the school will
    // argue about. Capped, and the cap is reported.
    const DAY_CAP = 200;
    const dayRows = await ctx.db
      .query("psAttendanceDays")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", key))
      .take(DAY_CAP + 1);

    return {
      allowed: true as const,
      reason: null,
      studentNumber: key,
      day: dayRow
        ? {
            daysAbsentYtd: dayCount(dayRow.daysAbsentYtd),
            daysAbsentTerm: dayCount(dayRow.daysAbsentTerm),
            daysTardyTerm: dayCount(dayRow.daysTardyTerm),
            syncedAt: dayRow.syncedAt ?? null,
          }
        : null,
      rows: sections.map((r) => ({
        sectionExpression: r.sectionExpression ?? null,
        courseName: r.courseName ?? null,
        sectionNumber: r.sectionNumber ?? null,
        // dayCount's rule: a missing figure is null, never 0.
        daysAbsent: dayCount(r.daysAbsent),
        daysTardy: dayCount(r.daysTardy),
        // 0 MEANS NOBODY EVER TOOK ATTENDANCE IN THIS CLASS. 1,631 of 5,563
        // measured rows are in that state, and rendering it as a clean record
        // would tell a family their child attended a class nobody registered.
        attendanceRows: typeof r.attendanceRows === "number" ? r.attendanceRows : null,
        lastAbsenceDate: r.lastAbsenceDate ?? null,
      })),
      // One row per date this student missed at least one block. Sorted by
      // the browser, which also decides full versus partial.
      days: dayRows.slice(0, DAY_CAP).map((d) => ({
        date: d.date,
        blocksThatDay: d.blocksThatDay,
        absentBlocks: d.absentBlocks,
        // EXPLICIT present-coded records only, never the absence of a record.
        presentBlocks: d.presentBlocks,
        // No record at all. Read as present by the owner's decision of
        // 2026-09-21; carried so the gap stays visible.
        unrecordedBlocks: d.unrecordedBlocks,
        absentSlots: d.absentSlots ?? [],
      })),
      daysTruncated: dayRows.length > DAY_CAP,
      daysSyncedAt: dayRows.length ? (dayRows[0].syncedAt ?? null) : null,
      syncedAt: sections.length ? (sections[0].syncedAt ?? null) : null,
      // So a caller can tell "this student has no section rows" from "the feed
      // has not run", which are different facts.
      sectionRows: sections.length,
    };
  },
});

/**
 * THE DAILY ABSENCE SERIES, for a run chart.
 *
 * WHY A SERIES AND NOT A TOTAL. Attendance Watch answers "who is absent a
 * lot"; it cannot answer "is this getting better or worse", and that is the
 * question an intervention is judged on. A run chart against the median tells
 * a real change apart from the bouncing every measure does anyway.
 *
 * COUNTS ONLY, and the browser draws and decides. The median, the signal rules
 * and the misrecord threshold all live in WildcatRoster, where they can be
 * argued with and unit-tested without a deploy.
 *
 * FUTURE DATES ARE EXCLUDED. Two students carry pre-entered absences running to
 * 2026-10-09; charting them would put ten phantom two-absence days on the end
 * of the series and drag the median with them. `today` comes from the browser,
 * never from a server clock, because a server-side UTC date rolls over at 5pm
 * Pacific.
 *
 * A DAY SCHOOL DID NOT RUN HAS NO ROW AND STAYS ABSENT FROM THE SERIES. There
 * is no attendance at all on 2026-09-04 or Labor Day 2026-09-07, and plotting
 * those as zero would invent two spectacular days and pull the median down.
 */
export const dailyAbsenceSeries = query({
  args: {
    /** "YYYY-MM-DD" from the browser. Anything after this is dropped. */
    today: v.string(),
    /** How many school days to return, most recent last. */
    days: v.optional(v.number()),
  },
  handler: async (ctx, { today, days }) => {
    const staff = await requireStaff(ctx);
    if (!ATTENDANCE_ROLES.includes(staff.role)) {
      return {
        allowed: false as const,
        reason:
          "The attendance trend is available to administrators and the PBIS team. " +
          "Ask an administrator to set your access level to PBIS Team.",
        points: [], truncated: false,
      };
    }
    const want = Math.min(Math.max(5, Number(days) || 25), 120);
    const day = String(today || "").slice(0, 10);

    // ~180 rows a year, so one read covers it. The cap is about noticing: if
    // this table ever outgrows it the chart must say so rather than quietly
    // charting a slice.
    const CAP = 400;
    const raw = await ctx.db.query("psAbsenceDayTotals").take(CAP + 1);
    const truncated = raw.length > CAP;

    const usable = raw
      .filter((r) => {
        const d = String(r.date || "").slice(0, 10);
        return d.length === 10 && (!day || d <= day);
      })
      .sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));

    const points = usable.slice(-want).map((r) => ({
      date: r.date,
      studentsAbsent: r.studentsAbsent,
      fullDaysStrict: r.fullDaysStrict,
      misrecordDaysByGap: r.misrecordDaysByGap ?? [],
      partialDays: r.partialDays,
    }));

    return {
      allowed: true as const,
      reason: null,
      points,
      // So a screen can say "25 of 27 school days" rather than implying the
      // series is everything there is.
      schoolDaysOnFile: usable.length,
      truncated,
      syncedAt: raw.length ? (raw[0].syncedAt ?? null) : null,
    };
  },
});
