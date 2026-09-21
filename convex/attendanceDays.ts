"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * BUILD THE PER-DATE PICTURE: for every student and every date they missed
 * something, how many of their blocks ran, how many they were absent from, how
 * many they were explicitly marked present for, and how many nobody recorded.
 *
 * WHY THIS READS THE TABLE ENDPOINT RATHER THAN A NAMED QUERY. Every installed
 * named query aggregates -- attendance_summary to a distinct-date count,
 * attendance_by_section to a per-section term total -- so none of them can say
 * what happened on one date. The conclusion drawn from that was that this
 * needed a new named query, a plugin build and an install. That was wrong: the
 * table endpoint serves the nine granted Attendance fields directly, including
 * ATT_DATE, PERIODID, CCID and ATTENDANCE_CODEID, and filters on att_date. No
 * plugin work at all.
 *
 * WHICH BLOCKS RAN IS DERIVED, NOT TRANSCRIBED. For each date, the period
 * slots carrying any attendance row school-wide. Verified 2026-09-21: Monday
 * and Thursday carry slots 1, 2, 4, 6, 8, 9, 10; Tuesday and Friday carry 1,
 * 3, 5, 7, 8, 9, 10; Wednesday carries all ten -- which is the school's block
 * timetable exactly, without this file knowing anything about weekdays. A
 * transcribed schedule would be a second copy to drift, and it would be wrong
 * on an assembly day or a minimum day.
 *
 * NOTHING HERE TOUCHES EARNED VALUE, and nothing decides a verdict. It writes
 * counts; WildcatRoster.classifyAbsenceDay turns them into full or partial in
 * the browser, where a threshold the school will argue about can be changed
 * without a deploy.
 */

const MAX_PAGES = 400;
const PAGE = 100;

function basic(input: string): string {
  return Buffer.from(input, "utf8").toString("base64");
}

async function token(host: string, id: string, secret: string): Promise<string> {
  const res = await fetch(`https://${host}/oauth/access_token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic(`${id}:${secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PowerSchool auth failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

/**
 * Page a table read to exhaustion, and say so when it hits the wall.
 *
 * PAGESIZE IS CAPPED AT 100 by the endpoint and answers HTTP 400 above it,
 * which reads exactly like a permissions refusal and is not one. And page
 * exhaustion must never be silent: a table that outgrows MAX_PAGES would sync
 * short and look complete, which is the failure that broke clearRoster and the
 * grade sync.
 */
async function readTable(
  host: string, tok: string, table: string, q: string, projection: string,
): Promise<{ rows: any[]; pages: number; pagedOut: boolean }> {
  const rows: any[] = [];
  let page = 1;
  for (; page <= MAX_PAGES; page++) {
    const url = `https://${host}/ws/schema/table/${table}`
      + `?q=${encodeURIComponent(q)}&projection=${encodeURIComponent(projection)}&pagesize=${PAGE}&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`${table} read failed on page ${page}: HTTP ${res.status} ${body}`);
    }
    const b = await res.json();
    const batch = (b?.record ?? []).map((r: any) => r.tables?.[table] ?? r);
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return { rows, pages: page, pagedOut: page > MAX_PAGES };
}

export const rebuild = internalAction({
  args: {
    /** Only dates on or after this, as "YYYY-MM-DD". Omit for the whole year. */
    since: v.optional(v.string()),
    /** Read and report without writing. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { since, dryRun }): Promise<Record<string, any>> => {
    const host = process.env.PS_HOST, id = process.env.PS_CLIENT_ID;
    const secret = process.env.PS_CLIENT_SECRET, schoolid = process.env.PS_SCHOOL_ID;
    const yearid = process.env.PS_YEAR_ID;
    if (!host || !id || !secret || !schoolid || !yearid) {
      return { ok: false, reason: "PowerSchool settings are not all present in this deployment." };
    }
    const syncedAt = new Date().toISOString();
    const tok = await token(host, id, secret);

    // 1. WHICH CODES MEAN ABSENT. Read, never assumed: the school has 16 codes
    //    and PRESENCE_STATUS_CD is the only thing that decides. Note that
    //    "Ditching" is coded Present and "Suspended" Absent, which is why this
    //    cannot be guessed from a code letter.
    const codes = await readTable(host, tok, "attendance_code",
      `schoolid==${schoolid}`, "id,att_code,presence_status_cd");
    const absentCode = new Set<string>();
    for (const c of codes.rows) {
      if (String(c.presence_status_cd) === "Absent") absentCode.add(String(c.id));
    }
    if (!absentCode.size) return { ok: false, reason: "No absent-status attendance codes were readable." };

    // 2. ccid -> the period slot, so a row can be placed in the timetable.
    //    CC.Expression is the section expression, e.g. "2(A-E)".
    //
    //    FILTERED BY TERM, and that is not a tidy-up. Unfiltered, cc holds
    //    every enrolment this school has ever recorded: a dry run read 40,000
    //    rows, hit the 400-page wall, and still had not reached the current
    //    term -- so every one of the 15,417 attendance rows failed to map and
    //    the build produced nothing. It reported ccPagedOut: true and
    //    unmappedCc: 15417 rather than a confident zero, which is the only
    //    reason the cause took one run to find.
    const termid = process.env.PS_TERM_ID;
    if (!termid) return { ok: false, reason: "PS_TERM_ID is not set, so cc cannot be scoped to the term." };
    //    SCOPED TO THE YEAR'S TERMS, not to the single year term. A section can
    //    be scoped to a semester or a quarter, whose TermID is a child of the
    //    year term rather than equal to it -- so filtering on the year term
    //    alone left 975 of 15,417 attendance rows unplaceable. PowerSchool
    //    numbers a year's terms within one hundred of the year id, so the range
    //    covers every term of this year and no other.
    const termBase = Math.floor(Number(termid) / 100) * 100;
    const cc = await readTable(host, tok, "cc",
      `schoolid==${schoolid};termid=ge=${termBase};termid=le=${termBase + 99}`, "id,expression");
    if (cc.pagedOut) {
      return {
        ok: false,
        reason: `cc still paged out at ${cc.pages} pages for term ${termid}, so the slot map is `
          + `incomplete and every verdict would be wrong. Nothing was written.`,
        ccRows: cc.rows.length,
      };
    }
    const slotOf = new Map<string, string>();
    for (const r of cc.rows) {
      const e = String(r.expression || "").trim();
      if (e) slotOf.set(String(r.id), e);
    }

    // 3. PowerSchool's internal student id -> the student number everything
    //    else in this app joins on.
    const studs = await readTable(host, tok, "students",
      `schoolid==${schoolid};enroll_status==0`, "id,student_number");
    const numberOf = new Map<string, string>();
    for (const r of studs.rows) {
      const n = String(r.student_number || "").trim();
      if (n) numberOf.set(String(r.id), n);
    }

    // 4. THE ATTENDANCE ITSELF. Filtered by date when asked, so a routine run
    //    reads only new days instead of the whole year.
    const day = String(since || "").slice(0, 10);
    const q = day
      ? `schoolid==${schoolid};att_date=ge=${day}`
      : `schoolid==${schoolid};yearid==${yearid}`;
    const att = await readTable(host, tok, "attendance", q,
      "studentid,att_date,periodid,attendance_codeid,ccid");

    // 5. Which slots ran on each date, school-wide. Derived, not transcribed.
    const slotsRan = new Map<string, Set<string>>();
    // And each student's own absences and explicit presents, per date.
    type Cell = { absent: Set<string>; present: Set<string> };
    const byStudentDate = new Map<string, Cell>();
    let unmappedCc = 0, unmappedStudent = 0;
    for (const r of att.rows) {
      const date = String(r.att_date || "").slice(0, 10);
      const slot = slotOf.get(String(r.ccid || ""));
      if (!date) continue;
      if (!slot) { unmappedCc++; continue; }
      if (!slotsRan.has(date)) slotsRan.set(date, new Set());
      slotsRan.get(date)!.add(slot);

      const num = numberOf.get(String(r.studentid || ""));
      if (!num) { unmappedStudent++; continue; }
      const key = num + "|" + date;
      if (!byStudentDate.has(key)) byStudentDate.set(key, { absent: new Set(), present: new Set() });
      const cell = byStudentDate.get(key)!;
      if (absentCode.has(String(r.attendance_codeid || ""))) cell.absent.add(slot);
      else cell.present.add(slot);
    }

    // 6. Each student's enrolled slots, from the table this app already syncs.
    const enrolled: Record<string, string[]> = await ctx.runQuery(
      internal.attendanceDaysRead.enrolledSlots, {},
    );

    // 7. Assemble. Only dates with at least one ABSENT block are stored: a day
    //    nobody missed anything on is not worth a row per student per day.
    type DayRow = {
      studentNumber: string; date: string; blocksThatDay: number;
      absentBlocks: number; presentBlocks: number; unrecordedBlocks: number;
      absentSlots?: string[];
    };
    const out: DayRow[] = [];
    let noEnrolment = 0;
    for (const [key, cell] of byStudentDate) {
      if (!cell.absent.size) continue;
      const sep = key.lastIndexOf("|");
      const studentNumber = key.slice(0, sep), date = key.slice(sep + 1);
      const ran = slotsRan.get(date) || new Set<string>();
      const mine = enrolled[studentNumber];
      if (!mine || !mine.length) { noEnrolment++; continue; }
      // BLOCKS THAT RAN FOR THIS STUDENT: their timetable intersected with what
      // the school actually ran that day.
      const blocks = mine.filter((s) => ran.has(s));
      const blocksThatDay = blocks.length;
      const absentBlocks = blocks.filter((s) => cell.absent.has(s)).length;
      const presentBlocks = blocks.filter((s) => !cell.absent.has(s) && cell.present.has(s)).length;
      const unrecordedBlocks = Math.max(0, blocksThatDay - absentBlocks - presentBlocks);
      if (absentBlocks === 0) continue;
      out.push({
        studentNumber, date, blocksThatDay, absentBlocks, presentBlocks, unrecordedBlocks,
        absentSlots: blocks.filter((s) => cell.absent.has(s)).sort(),
      });
    }

    // REFUSE RATHER THAN WRITE NONSENSE. If most attendance rows could not be
    // placed in the timetable the slot map is broken, and a table of confident
    // wrong verdicts is worse than no table.
    const unmappedShare = att.rows.length ? unmappedCc / att.rows.length : 0;
    if (att.rows.length && unmappedShare > 0.15) {
      return {
        ok: false,
        reason: `${unmappedCc} of ${att.rows.length} attendance rows could not be mapped to a `
          + `period slot (${Math.round(unmappedShare * 100)}%). The cc slot map is incomplete, so `
          + `nothing was written.`,
        ccRows: cc.rows.length, ccPages: cc.pages, attendanceRows: att.rows.length, unmappedCc,
      };
    }

    const summary: Record<string, any> = {
      ok: true, syncedAt, since: day || null, dryRun: dryRun === true,
      codesRead: codes.rows.length, absentCodeIds: absentCode.size,
      ccRows: cc.rows.length, ccPages: cc.pages, ccPagedOut: cc.pagedOut,
      students: numberOf.size,
      attendanceRows: att.rows.length, attendancePages: att.pages, attendancePagedOut: att.pagedOut,
      datesSeen: slotsRan.size,
      // Named rather than silent. A row whose section or student cannot be
      // mapped is dropped, and a caller has to be able to see how many.
      unmappedCc, unmappedStudent, studentsWithNoEnrolment: noEnrolment,
      // A row whose enrolment is not in the term range is usually a section
      // the student has since left, whose attendance still happened. Reported
      // as a share so a map that breaks is distinguishable from ordinary churn.
      unmappedCcShare: att.rows.length ? Math.round(unmappedShare * 1000) / 10 : 0,
      absentDayRows: out.length,
    };
    if (dryRun === true) {
      summary.sampleShape = out.slice(0, 3).map((r) => ({ ...r, studentNumber: "(withheld)" }));
      return summary;
    }

    for (let pass = 0; pass < 20; pass++) {
      const r: { moreToClear?: boolean } = await ctx.runMutation(
        internal.sisStats.replaceAttendanceDays, { syncedAt, rows: [], clearFirst: true },
      );
      if (!r.moreToClear) break;
    }
    for (let i = 0; i < out.length; i += 200) {
      await ctx.runMutation(internal.sisStats.replaceAttendanceDays, {
        syncedAt, rows: out.slice(i, i + 200), clearFirst: false,
      });
    }
    return summary;
  },
});
