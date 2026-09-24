"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { token, readTable } from "./attendanceDays";
import { buildRunDays } from "./runChartDays";

/**
 * FETCH ONE MONTH FROM POWERSCHOOL, TURN IT INTO DAILY TOTALS, SAVE IT.
 *
 * WHY STRAIGHT FROM POWERSCHOOL rather than from the tables the twice-daily
 * sync fills: those hold only students enrolled TODAY and only this year. The
 * run chart needs the students who have since left (their enrolled days belong
 * in the weeks they were here -- 67 left between 12 Aug and 23 Sep) and last
 * year (for a baseline with the holiday dips in it). Both are reachable
 * through the same table endpoint with no plugin change, measured by
 * attendanceProbe:runChartHistoryProbe on 2026-09-23.
 *
 * ONE MONTH PER CALL, so no call runs long: last year is ~103,000 period
 * records, and a month is about a tenth of that.
 *
 * ONLY COMPLETED DAYS: nothing after yesterday in Los Angeles is read. The
 * nightly run is at 03:15 PT, when yesterday's registers are finished.
 *
 * READS ONLY from PowerSchool; writes only the run chart's own two tables.
 */
function laToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}
function dayBefore(iso: string): string {
  return new Date(Date.parse(iso + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
}
function lastOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

async function yearRange(host: string, tok: string, schoolid: string, yearid: number) {
  const t = await readTable(host, tok, "terms", `schoolid==${schoolid};yearid==${yearid}`, "id,firstday,lastday,isyearrec");
  const yr = t.rows.find((r: any) => String(r.isyearrec) === "1") ?? t.rows[0];
  if (!yr) return null;
  return { first: String(yr.firstday ?? "").slice(0, 10), last: String(yr.lastday ?? "").slice(0, 10) };
}

/** How long after a year's last day its months may still be rebuilt: late corrections. */
const CLOSE_AFTER_DAYS = 3;
function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}

export const buildMonth = internalAction({
  args: { yearid: v.number(), month: v.string(), dryRun: v.optional(v.boolean()), onlyWhileOpen: v.optional(v.boolean()) },
  handler: async (ctx, { yearid, month, dryRun, onlyWhileOpen }): Promise<Record<string, any>> => {
    const host = process.env.PS_HOST, id = process.env.PS_CLIENT_ID;
    const secret = process.env.PS_CLIENT_SECRET, schoolid = process.env.PS_SCHOOL_ID;
    const currentYear = Number(process.env.PS_YEAR_ID);
    if (!host || !id || !secret || !schoolid || !Number.isFinite(currentYear)) {
      return { ok: false, reason: "PowerSchool settings are not all present." };
    }
    if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, reason: "month must be YYYY-MM" };
    const tok = await token(host, id, secret);
    const range = await yearRange(host, tok, schoolid, yearid);
    if (!range) return { ok: false, reason: `No year term for yearid ${yearid}.` };

    const yesterday = dayBefore(laToday());
    // A FINISHED YEAR IS LEFT ALONE by the nightly run. Once PowerSchool's
    // end-of-year run promotes everyone, a rebuild of June would file the
    // outgoing 8th graders under 9-12 with grades marked as recorded. A few
    // days' grace catches late corrections; after that, rebuild by hand.
    if (onlyWhileOpen && yesterday > addDays(range.last, CLOSE_AFTER_DAYS)) {
      return { ok: true, skipped: true, reason: `The ${yearid} year ended ${range.last}; its months are no longer rebuilt nightly.` };
    }
    let from = month + "-01";
    let to = lastOfMonth(month);
    if (from < range.first) from = range.first;
    if (to > range.last) to = range.last;
    if (to > yesterday) to = yesterday;
    if (from > to) return { ok: true, skipped: true, reason: "No completed school days in that month.", from, to };

    const codes = await readTable(host, tok, "attendance_code", `schoolid==${schoolid};yearid==${yearid}`,
      "id,presence_status_cd");
    const absentCodeIds = new Set(codes.rows.filter((c: any) => String(c.presence_status_cd) === "Absent").map((c: any) => String(c.id)));
    if (!absentCodeIds.size) return { ok: false, reason: `No Absent codes readable for yearid ${yearid}.` };

    // Schedules for the year, INCLUDING DROPPED classes (PowerSchool negates
    // the termid of a drop), with the dates the student sat in each.
    const base = yearid * 100;
    const ccLive = await readTable(host, tok, "cc", `schoolid==${schoolid};termid=ge=${base};termid=le=${base + 99}`,
      "id,studentid,expression,dateenrolled,dateleft");
    const ccDropped = await readTable(host, tok, "cc", `schoolid==${schoolid};termid=ge=${-(base + 99)};termid=le=${-base}`,
      "id,studentid,expression,dateenrolled,dateleft");
    // EVERY STATUS, and NO NAMES OR NUMBERS: the internal id, grade and exit are all this needs.
    const studs = await readTable(host, tok, "students", `schoolid==${schoolid}`, "id,grade_level,enroll_status,entrydate");
    // STUDENTS WHO HAVE SINCE MOVED TO ANOTHER SCHOOL. Their record now sits
    // under the new school, so the search above misses them, while their
    // classes HERE are still on record. Measured 2025-10: 36 such students,
    // enrolled every day and in no band until looked up by id.
    const known = new Set(studs.rows.map((r: any) => String(r.id)));
    const missing = [...new Set([...ccLive.rows, ...ccDropped.rows].map((r: any) => String(r.studentid ?? "")))]
      .filter((x) => x && !known.has(x));
    const LOOKUP_CAP = 400;
    let lookedUp = 0, lookupFailed = 0;
    for (const sid of missing.slice(0, LOOKUP_CAP)) {
      try {
        const r = await readTable(host, tok, "students", `id==${sid}`, "id,grade_level,enroll_status,entrydate");
        studs.rows.push(...r.rows);
        lookedUp += r.rows.length;
      } catch { lookupFailed++; }
    }
    const att = await readTable(host, tok, "attendance", `schoolid==${schoolid};att_date=ge=${from};att_date=le=${to}`,
      "studentid,att_date,attendance_codeid,ccid");
    for (const [name, r] of [["cc", ccLive], ["cc (dropped)", ccDropped], ["students", studs], ["attendance", att]] as const) {
      if (r.pagedOut) {
        return { ok: false, reason: `${name} paged out at ${r.pages} pages; a truncated read would under-count, so nothing was written.` };
      }
    }

    const built = buildRunDays({
      attendance: att.rows, cc: [...ccLive.rows, ...ccDropped.rows], students: studs.rows,
      absentCodeIds, from, to, isCurrentYear: yearid === currentYear, yearLastDay: range.last,
    });
    // AN EMPTY READ NEVER REPLACES A MONTH. A school month always has school
    // days; none at all means PowerSchool answered with nothing (an outage, a
    // permissions change), and writing that would wipe the month.
    if (!built.schoolDays.length) {
      return { ok: false, reason: `PowerSchool returned no attendance for ${from} to ${to}; nothing was written.` };
    }
    // REFUSE RATHER THAN WRITE NONSENSE, the rebuild's own guard: if most
    // records cannot be placed in a period, the slot map is broken.
    if (built.diagnostics.recordsConsidered && built.diagnostics.unmappedShare > 0.15) {
      return { ok: false, reason: `${Math.round(built.diagnostics.unmappedShare * 100)}% of records could not be placed in a period; nothing was written.`,
               diagnostics: built.diagnostics };
    }
    const summary = {
      ok: true, yearid, month, from, to, schoolDays: built.schoolDays.length,
      dayRows: built.days.length, monthRows: built.months.length, diagnostics: built.diagnostics,
      reads: { cc: ccLive.rows.length + ccDropped.rows.length, students: studs.rows.length, attendance: att.rows.length },
      movedAway: { missing: missing.length, lookedUp, lookupFailed, capped: missing.length > LOOKUP_CAP },
    };
    if (dryRun) return { ...summary, dryRun: true, sample: built.days.slice(0, 4), months: built.months };
    await ctx.runMutation(internal.attendanceRunChartData.replaceMonth, {
      yearid, month, gradeEstimated: yearid !== currentYear, syncedAt: new Date().toISOString(),
      days: built.days, months: built.months,
    });
    return summary;
  },
});

/**
 * THE ONE-TIME BACKFILL: every month of a past year, one call each, spaced out
 * so PowerSchool is never asked for more than one month at a time. Run it in
 * the evening: npx convex run attendanceRunChart:backfillYear '{"yearid":35}'
 */
export const backfillYear = internalAction({
  args: { yearid: v.number(), spacingSeconds: v.optional(v.number()) },
  handler: async (ctx, { yearid, spacingSeconds }): Promise<Record<string, any>> => {
    const host = process.env.PS_HOST, id = process.env.PS_CLIENT_ID;
    const secret = process.env.PS_CLIENT_SECRET, schoolid = process.env.PS_SCHOOL_ID;
    if (!host || !id || !secret || !schoolid) return { ok: false, reason: "PowerSchool settings missing." };
    const tok = await token(host, id, secret);
    const range = await yearRange(host, tok, schoolid, yearid);
    if (!range) return { ok: false, reason: `No year term for yearid ${yearid}.` };
    const months: string[] = [];
    for (let m = range.first.slice(0, 7); m <= range.last.slice(0, 7);) {
      months.push(m);
      const [y, mm] = m.split("-").map(Number);
      m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
    }
    const gap = Math.max(30, Number(spacingSeconds) || 120);
    for (let i = 0; i < months.length; i++) {
      await ctx.scheduler.runAfter(i * gap * 1000, internal.attendanceRunChart.buildMonth, { yearid, month: months[i] });
    }
    return { ok: true, yearid, range, scheduled: months, spacingSeconds: gap };
  },
});

/**
 * NIGHTLY, for the current year: this month to yesterday, and during the first
 * week of a month the month just ended too (late corrections).
 *
 * IT ALSO MENDS GAPS. Any earlier month of this year with no rows at all -- a
 * build that failed, or a year that began before this chart existed -- is
 * built too, up to three a night, so a missing month repairs itself rather
 * than sitting as a silent hole in the chart. Months that exist are left as
 * built; run buildMonth by hand to refresh one.
 */
export const refreshCurrent = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, any>> => {
    const yearid = Number(process.env.PS_YEAR_ID);
    if (!Number.isFinite(yearid)) return { ok: false, reason: "PS_YEAR_ID missing." };
    const today = laToday();
    const prevOf = (mo: string) => {
      const [y, m] = mo.split("-").map(Number);
      return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    };
    const months = [today.slice(0, 7)];
    if (Number(today.slice(8, 10)) <= 7) months.unshift(prevOf(today.slice(0, 7)));
    const have: string[] = await ctx.runQuery(internal.attendanceRunChartData.monthsPresent, { yearid });
    const present = new Set(have);
    const first = have.length ? have.slice().sort()[0] : null;
    const mend: string[] = [];
    // Walk back from last month to the earliest stored month (or ten months,
    // a school year), collecting the gaps.
    for (let mo = prevOf(today.slice(0, 7)), k = 0; k < 10 && (!first || mo >= first); mo = prevOf(mo), k++) {
      if (!present.has(mo) && !months.includes(mo)) mend.push(mo);
    }
    const all = [...months, ...mend.slice(0, 3)];
    for (let i = 0; i < all.length; i++) {
      await ctx.scheduler.runAfter(i * 60000, internal.attendanceRunChart.buildMonth,
        { yearid, month: all[i], onlyWhileOpen: true });
    }
    return { ok: true, yearid, months: all, mended: mend.slice(0, 3) };
  },
});
