"use node";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

/**
 * CAN PERIOD-LEVEL ABSENCE BE BUILT AT ALL? One read-only question, asked
 * before anybody designs a rule that depends on the answer.
 *
 * WHY THIS EXISTS. attendance_summary returns COUNT(DISTINCT ATT_DATE), so the
 * app holds days and not periods, and a request to count "two periods missed"
 * or "came back for period 3" cannot be answered from anything already stored
 * -- the detail was aggregated away in SQL before it ever left PowerSchool.
 * Whether it CAN be answered turns on two columns this instance may or may not
 * populate: ATTENDANCE.PERIODID and ATTENDANCE.CCID. Both are granted in
 * plugin.xml and, as expansion.named_queries.xml says out loud, "nobody has
 * ever checked whether this instance populates it. If it is null, every count
 * in attendance_by_section is a correct zero for the wrong reason."
 *
 * GET ONLY, ONE ROW, NO STUDENT DATA. attendance_join_health was written to be
 * safe to run: it returns counts for one school and one year and carries no
 * identifiers, no names and no dates tied to a person. It is the check that
 * file asks callers to run first, and nothing had.
 *
 * It also tells us whether the EXPANSION PACK is installed at all. A 404 here
 * is a real answer -- it means the queries exist in this repo and not in
 * PowerSchool, so period-level work needs Lawrence to install a plugin build
 * before any of it is possible.
 *
 * internalAction, CLI only, and it writes nothing anywhere.
 */
const PREFIX = "com.lapromisefund.wildcathub";

function base64(input: string): string {
  return Buffer.from(input, "utf8").toString("base64");
}

async function token(host: string, id: string, secret: string): Promise<string> {
  const res = await fetch(`https://${host}/oauth/access_token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${base64(`${id}:${secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PowerSchool auth failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

/**
 * WHAT attendance_by_section ACTUALLY RETURNS, sized and shaped before a table
 * is designed around it.
 *
 * Two questions only this can answer. How many rows, so the chunking matches
 * the existing psMissingWork pattern rather than guessing. And which COURSE
 * NAMES sit in which period expression, because the school's spoken period
 * names are not PowerSchool's period numbers -- "Promise Time 1 (am)" is
 * PowerSchool period 1 and "Power Up" is period 8 -- and a view that asserted
 * a mapping nobody verified would put the wrong period name beside a child's
 * absences.
 *
 * AGGREGATE ONLY. This query returns student_number per section, and a
 * diagnostic has no business echoing a roster, so nothing per student leaves
 * here: row counts, distinct counts, and the expression-to-course-name map.
 */
export const sectionShape = internalAction({
  args: {},
  handler: async () => {
    const host = process.env.PS_HOST, id = process.env.PS_CLIENT_ID;
    const secret = process.env.PS_CLIENT_SECRET, schoolid = process.env.PS_SCHOOL_ID;
    const termid = process.env.PS_TERM_ID;
    if (!host || !id || !secret || !schoolid || !termid) {
      return { ok: false as const, reason: "PowerSchool settings are not all present." };
    }
    const tok = await token(host, id, secret);
    const rows: any[] = [];
    // Paged, because one school-term of per-section attendance is thousands of
    // rows and a single page would silently truncate -- the mistake that made
    // a ten-period day look like a five-period one earlier today.
    for (let page = 1; page <= 40; page++) {
      const res = await fetch(`https://${host}/ws/schema/query/${PREFIX}.attendance_by_section?pagesize=500&page=${page}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ schoolid, termid }),
      });
      if (!res.ok) return { ok: false as const, reason: `HTTP ${res.status} on page ${page}` };
      const body = await res.json();
      const batch = body.record ?? body.records ?? [];
      rows.push(...batch);
      if (batch.length < 500) break;
    }

    const byExpression: Record<string, { rows: number; courses: Record<string, number>; absentDays: number; students: Set<string> }> = {};
    const students = new Set<string>();
    let withAbsence = 0, totalAbsentDays = 0, totalTardyDays = 0, noRows = 0;
    const today = new Date().toISOString().slice(0, 10);
    let futureLast = 0;

    for (const r of rows) {
      const ex = String(r.section_expression || "(none)");
      const course = String(r.course_name || "(none)");
      const abs = Number(r.days_absent_section_term) || 0;
      const tardy = Number(r.days_tardy_section_term) || 0;
      const attRows = Number(r.attendance_rows_section_term) || 0;
      const sn = String(r.student_number || "");
      if (sn) students.add(sn);
      if (!byExpression[ex]) byExpression[ex] = { rows: 0, courses: {}, absentDays: 0, students: new Set() };
      byExpression[ex].rows++;
      byExpression[ex].courses[course] = (byExpression[ex].courses[course] || 0) + 1;
      byExpression[ex].absentDays += abs;
      if (sn) byExpression[ex].students.add(sn);
      if (abs > 0) withAbsence++;
      totalAbsentDays += abs; totalTardyDays += tardy;
      // "never absent in this class" must never render the same as "no
      // attendance rows joined to this class at all", per the query's own note.
      if (attRows === 0) noRows++;
      const d = String(r.last_absence_date || "").slice(0, 10);
      if (d && d > today) futureLast++;
    }

    return {
      ok: true as const,
      totalRows: rows.length, distinctStudents: students.size,
      rowsWithAnAbsence: withAbsence, rowsWithNoAttendanceAtAll: noRows,
      totalAbsentDays, totalTardyDays,
      rowsWithFutureLastAbsence: futureLast,
      // The empirical period-to-course map, which is what lets a label come
      // from the data instead of from a hardcoded bell schedule.
      periods: Object.entries(byExpression)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([expression, v]) => ({
          expression, rows: v.rows, students: v.students.size, absentDays: v.absentDays,
          topCourses: Object.entries(v.courses).sort((x, y) => y[1] - x[1]).slice(0, 4)
            .map(([name, n]) => `${name} (${n})`),
        })),
    };
  },
});

/**
 * IS ANYTHING DAY-LEVEL BEING RECORDED AT ALL?
 *
 * The owner asked whether the actual day is calculated when an absence is
 * marked. attendance_join_health says distinct_mode_codes = 1, which means one
 * mode -- but not WHICH. That distinction is the whole answer: ATT_ModeDaily
 * rows would be PowerSchool writing a day-level record, and ATT_ModeMeeting
 * rows are period records only, from which a day figure has to be derived.
 *
 * Also reads the attendance CODE vocabulary, because a half-day or
 * portion-of-day code would be the authoritative answer sitting unused. The
 * plugin grants Att_Code, Description and Presence_Status_CD on
 * Attendance_Code, so this asks for exactly those and nothing else.
 *
 * GET ONLY, via the table endpoint rather than a named query, because no named
 * query returns the mode value. Codes and counts only -- no student is read.
 */
/**
 * HOW MUCH EACH ATTENDANCE CODE IS ACTUALLY USED.
 *
 * The code vocabulary turned up three things that matter more than the
 * question that led to it, and all three turn on volume:
 *
 *   K "Ditching" carries PRESENCE_STATUS_CD = 'Present', so a student recorded
 *   as ditching is counted as present by attendance_summary and appears in NO
 *   absence figure this app shows. Class-cutting is being recorded and then
 *   filtered out.
 *
 *   S "Suspended" carries 'Absent', so suspensions are inside every absence
 *   rate on Attendance Watch and Early Warning. A suspended child is a
 *   discipline case, not a truancy case, and calling home about attendance
 *   would be the wrong conversation.
 *
 *   H "Partial Attendance (for Distance Learning)" carries 'Present', and
 *   there is NO half-day or portion-of-day code anywhere in the 16. So no
 *   authoritative day fraction exists to read, which is why the app derives
 *   bounds instead.
 *
 * Counted through the table endpoint's /count, one call per code, so nothing
 * per student is read and no page limit is involved.
 */
export const codeUsage = internalAction({
  args: {},
  handler: async () => {
    const host = process.env.PS_HOST, id = process.env.PS_CLIENT_ID;
    const secret = process.env.PS_CLIENT_SECRET, schoolid = process.env.PS_SCHOOL_ID;
    const yearid = process.env.PS_YEAR_ID;
    if (!host || !id || !secret || !schoolid || !yearid) {
      return { ok: false as const, reason: "PowerSchool settings are not all present." };
    }
    const tok = await token(host, id, secret);
    const get = async (url: string) => {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" } });
      if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, body: null as any };
      return { error: null as string | null, body: await res.json() };
    };

    const codesRes = await get(`https://${host}/ws/schema/table/attendance_code`
      + `?q=${encodeURIComponent(`schoolid==${schoolid};yearid==${yearid}`)}`
      + `&projection=id,att_code,description,presence_status_cd&pagesize=100`);
    if (codesRes.error) return { ok: false as const, reason: codesRes.error };
    const codes = (codesRes.body?.record ?? []).map((r: any) => r.tables?.attendance_code ?? r);

    const out: Array<Record<string, any>> = [];
    let total = 0;
    for (const c of codes) {
      const r = await get(`https://${host}/ws/schema/table/attendance/count`
        + `?q=${encodeURIComponent(`schoolid==${schoolid};yearid==${yearid};attendance_codeid==${c.id}`)}`);
      const n = r.error ? null : Number(r.body?.count ?? 0);
      if (typeof n === "number") total += n;
      out.push({
        code: c.att_code, presence: c.presence_status_cd, description: c.description,
        rows: n, error: r.error,
      });
    }
    out.sort((a, b) => (Number(b.rows) || 0) - (Number(a.rows) || 0));
    const absentRows = out.filter((r) => r.presence === "Absent").reduce((n, r) => n + (Number(r.rows) || 0), 0);
    const presentRows = out.filter((r) => r.presence === "Present").reduce((n, r) => n + (Number(r.rows) || 0), 0);
    return {
      ok: true as const,
      totalRowsCounted: total, absentCodedRows: absentRows, presentCodedRows: presentRows,
      byCode: out,
    };
  },
});

export const dayLevelCheck = internalAction({
  args: {},
  handler: async () => {
    const host = process.env.PS_HOST, id = process.env.PS_CLIENT_ID;
    const secret = process.env.PS_CLIENT_SECRET, schoolid = process.env.PS_SCHOOL_ID;
    const yearid = process.env.PS_YEAR_ID;
    if (!host || !id || !secret || !schoolid || !yearid) {
      return { ok: false as const, reason: "PowerSchool settings are not all present." };
    }
    const tok = await token(host, id, secret);

    // MAX PAGESIZE IS 100 on the table endpoint, and exceeding it answers
    // HTTP 400 -- which reads exactly like a permissions refusal and is not
    // one. Clamped here so a future caller cannot make that mistake again.
    const table = async (name: string, q: string, projection: string, pagesize = 100) => {
      pagesize = Math.min(Math.max(1, pagesize), 100);
      const url = `https://${host}/ws/schema/table/${name}`
        + `?q=${encodeURIComponent(q)}&projection=${encodeURIComponent(projection)}&pagesize=${pagesize}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" } });
      if (!res.ok) {
        // THE BODY IS THE DIAGNOSTIC, not the status. plugin.xml records that
        // this endpoint distinguishes its failures in the message -- a 400
        // saying "not a valid column for table X" means the column does not
        // exist, while a 400 about access means it exists and is not granted.
        // Those are opposite answers to the owner's question.
        let body = "";
        try { body = (await res.text()).slice(0, 400); } catch { body = "(unreadable)"; }
        return { error: `HTTP ${res.status}: ${body}`, rows: [] as any[] };
      }
      const body = await res.json();
      const recs = body?.record ?? body?.records ?? [];
      return { error: null as string | null, rows: recs.map((r: any) => r.tables?.[name] ?? r) };
    };

    // The MODE, which is the question. A sample is enough: if any
    // ATT_ModeDaily row existed, distinct_mode_codes would be 2.
    const attempts: Array<Record<string, any>> = [];
    let att = { error: "not tried" as string | null, rows: [] as any[] };
    for (const t of [
      { label: "schoolid+yearid", q: `schoolid==${schoolid};yearid==${yearid}`, proj: "att_mode_code,att_date,periodid" },
      { label: "schoolid only", q: `schoolid==${schoolid}`, proj: "att_mode_code" },
      { label: "mode projection alone", q: `yearid==${yearid}`, proj: "att_mode_code" },
      { label: "id projection, sanity", q: `schoolid==${schoolid}`, proj: "id" },
    ]) {
      const r = await table("attendance", t.q, t.proj, 100);
      attempts.push({ attempt: t.label, projection: t.proj, error: r.error, rows: r.rows.length });
      if (!r.error && r.rows.length) { att = r; break; }
    }
    const modes: Record<string, number> = {};
    for (const r of att.rows) {
      const m = String(r.att_mode_code ?? "(null)");
      modes[m] = (modes[m] || 0) + 1;
    }

    // The CODE vocabulary. A half-day or portion code would be the
    // authoritative day figure we are deriving instead of reading.
    const codes = await table("attendance_code", `schoolid==${schoolid};yearid==${yearid}`,
      "att_code,description,presence_status_cd", 100);

    return {
      ok: true as const,
      attendanceSample: { rows: att.rows.length, error: att.error, modeCodesSeen: modes, attempts },
      codes: {
        error: codes.error, count: codes.rows.length,
        vocabulary: codes.rows.map((r: any) => ({
          code: r.att_code, presence: r.presence_status_cd, description: r.description,
        })),
      },
      note: "Mode ATT_ModeMeeting means period records only, so no day-level record is written "
        + "and the day figure must be derived. A half-day or portion code in the vocabulary "
        + "would mean an authoritative day fraction exists.",
    };
  },
});

export const joinHealth = internalAction({
  args: { yearid: v.optional(v.string()) },
  handler: async (_ctx, { yearid }) => {
    const host = process.env.PS_HOST;
    const id = process.env.PS_CLIENT_ID;
    const secret = process.env.PS_CLIENT_SECRET;
    const schoolid = process.env.PS_SCHOOL_ID;
    const year = yearid || process.env.PS_YEAR_ID;
    if (!host || !id || !secret || !schoolid || !year) {
      return { ok: false as const, reason: "PowerSchool settings are not all present in this deployment." };
    }

    const tok = await token(host, id, secret);
    const attempts: Array<Record<string, any>> = [];

    // Every query that would be needed for a period-level rule, asked one at a
    // time so a 404 names WHICH piece is missing rather than failing as a lump.
    for (const name of ["attendance_join_health", "period_structure", "attendance_by_section"]) {
      // EACH QUERY'S OWN ARG CONTRACT. attendance_join_health takes yearid;
      // the other two take termid and NOT yearid. Passing both is what made
      // them answer HTTP 400, which reads like a refusal and is really a
      // mismatched signature.
      const args: Record<string, string> = name === "attendance_join_health"
        ? { schoolid, yearid: String(year) }
        : { schoolid, termid: String(process.env.PS_TERM_ID || "") };
      try {
        // PAGESIZE 200, NOT 5. A pagesize of 5 truncated period_structure to
        // five rows and made a ten-period school day look like a five-period
        // one -- a wrong answer that arrived looking exactly like a right one.
        // Every query here returns well under 200 rows for one school.
        const res = await fetch(`https://${host}/ws/schema/query/${PREFIX}.${name}?pagesize=200&page=1`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tok}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(args),
        });
        if (!res.ok) {
          attempts.push({
            query: name, http: res.status,
            verdict: res.status === 404
              ? "NOT INSTALLED in PowerSchool -- exists in this repo only"
              : `refused: HTTP ${res.status}`,
          });
          continue;
        }
        const body = await res.json();
        const rows = body.record ?? body.records ?? [];
        // attendance_join_health returns one row of counts and no identifiers,
        // so it is safe to echo. The other two are per student, so only their
        // SHAPE is reported -- column names and a row count, never values.
        if (name === "attendance_join_health") {
          attempts.push({ query: name, http: 200, verdict: "installed", row: rows[0] ?? null });
        } else if (name === "period_structure") {
          // Section expressions and how many students sit in each. No names.
          attempts.push({
            query: name, http: 200, verdict: "installed", rowsReturned: rows.length,
            periods: rows.map((r: any) => ({
              expression: r.section_expression, sections: r.section_count, students: r.student_count,
              example: r.example_course_name,
            })),
          });
        } else {
          // AGGREGATED HERE, deliberately. This query returns student_number
          // per section, and a diagnostic has no business echoing a roster.
          const cols = rows.length && rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0]).sort() : [];
          let futureLastAbsence = 0;
          const today = new Date().toISOString().slice(0, 10);
          for (const r of rows) {
            const d = String((r as any).last_absence_date || "").slice(0, 10);
            if (d && d > today) futureLastAbsence++;
          }
          attempts.push({
            query: name, http: 200, verdict: "installed", rowsReturned: rows.length, columns: cols,
            sampleRowsWithFutureLastAbsence: futureLastAbsence,
          });
        }
      } catch (e) {
        attempts.push({ query: name, verdict: `error: ${e instanceof Error ? e.message : String(e)}` });
      }
    }

    return {
      ok: true as const,
      host, schoolid, yearid: String(year),
      attempts,
      note: "GET only. attendance_join_health carries no student data; the other two are "
        + "reported by column name and row count only.",
    };
  },
});
