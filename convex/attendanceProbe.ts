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
