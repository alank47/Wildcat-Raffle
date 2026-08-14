import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Scheduled PowerSchool sync, run by Convex rather than by a laptop.
 *
 * The local script (powerschool/sync) proved the pipeline and is still the
 * right tool for a one-off or a dry run. It is the wrong tool for "twice a
 * day, every day": it needs a machine that is awake, unlocked, and holding
 * credentials. This runs server side on a schedule with the secrets in
 * Convex's environment.
 *
 * READ ONLY, structurally. The only PowerSchool calls here are the OAuth token
 * request and POSTs to named query paths. There is no code path that can write
 * to the SIS, which matches the plugin's ViewOnly access request. If a future
 * task appears to need a write, that is a new access request and an admin
 * re-approval, not an edit to this file.
 */

type QueryResult = { rows: any[]; pages: number };

const PAGE_SIZE = 100;
const MAX_PAGES = 200;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set on this Convex deployment.`);
  return v;
}

/**
 * Base64 without Buffer or btoa.
 *
 * Buffer is Node-only and this runs in Convex's default runtime; btoa exists in
 * some runtimes and not reliably here. Twelve lines of table lookup is cheaper
 * than forcing the whole module into the Node runtime ("use node") just to
 * encode one short string, which is what made the first deploy time out.
 */
function base64(input: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < input.length; i += 3) {
    const a = input.charCodeAt(i);
    const b = i + 1 < input.length ? input.charCodeAt(i + 1) : NaN;
    const c = i + 2 < input.length ? input.charCodeAt(i + 2) : NaN;
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)];
    out += Number.isNaN(b) ? "=" : chars[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)];
    out += Number.isNaN(c) ? "=" : chars[c & 63];
  }
  return out;
}

async function token(host: string, id: string, secret: string): Promise<string> {
  const basic = base64(`${id}:${secret}`);
  const res = await fetch(`https://${host}/oauth/access_token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PowerSchool auth failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

async function namedQuery(
  host: string, tok: string, name: string, args: Record<string, string | number>,
): Promise<QueryResult> {
  const rows: any[] = [];
  let page = 1;
  for (; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `https://${host}/ws/schema/query/${name}?pagesize=${PAGE_SIZE}&page=${page}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(args),
      },
    );
    if (!res.ok) {
      throw new Error(`Query ${name} failed on page ${page}: HTTP ${res.status}`);
    }
    const body = await res.json();
    const batch = body.record ?? body.records ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return { rows, pages: page };
}

const ne = (x: unknown) => String(x ?? "").trim().length > 0;
const s = (x: unknown) => (ne(x) ? String(x).trim() : undefined);
const n = (x: unknown) => {
  const v = Number(x);
  return Number.isFinite(v) ? v : undefined;
};

export const syncFromPowerSchool = internalAction({
  args: { reason: v.optional(v.string()) },
  handler: async (ctx, { reason }) => {
    const started = Date.now();
    const host = need("PS_HOST");
    const schoolid = need("PS_SCHOOL_ID");
    const termid = need("PS_TERM_ID");
    const yeartermid = need("PS_YEAR_TERM_ID");
    const prefix = "com.lapromisefund.wildcathub";
    const syncedAt = new Date().toISOString();

    const tok = await token(host, need("PS_CLIENT_ID"), need("PS_CLIENT_SECRET"));

    // ---- enrollment ----
    const roster = await namedQuery(host, tok, `${prefix}.roster`, { schoolid, termid });
    const rosterRows = roster.rows
      .map((r) => ({
        studentNumber: s(r.student_number) ?? "",
        firstName: s(r.first_name) ?? "",
        lastName: s(r.last_name) ?? "",
        gradeLevel: s(r.grade_level),
        sectionId: s(r.section_id),
        sectionNumber: s(r.section_number),
        sectionExpression: s(r.section_expression),
        courseNumber: s(r.course_number),
        courseName: s(r.course_name),
        period: s(r.section_expression) ?? s(r.cc_expression),
        teacherEmail: s(r.teacher_email),
        teacherFirstName: s(r.teacher_first_name),
        teacherLastName: s(r.teacher_last_name),
        teacherNumber: s(r.teacher_number),
        termId: s(r.term_id),
        termAbbreviation: s(r.term_abbreviation),
        schoolId: s(r.school_id),
      }))
      .filter((r) => r.studentNumber);

    // Loop: one call deletes a batch, because the whole table no longer fits
    // in a single execution's read budget. Bounded so a bug here cannot spin.
    for (let pass = 0; pass < 20; pass++) {
      const cleared: { deleted: number; remaining: string } =
        await ctx.runMutation(internal.psSync.clearRoster, {});
      if (cleared.remaining === "none") break;
    }
    for (let i = 0; i < rosterRows.length; i += 200) {
      await ctx.runMutation(internal.psSync.upsertRoster, {
        syncedAt, rows: rosterRows.slice(i, i + 200),
      });
    }

    // ---- students: identity and enrollment ONLY, never balances ----
    const seen = new Map<string, any>();
    for (const r of roster.rows) {
      const key = s(r.student_number);
      if (!key || seen.has(key)) continue;
      seen.set(key, {
        studentNumber: key,
        firstName: s(r.first_name) ?? "",
        lastName: s(r.last_name) ?? "",
        grade: s(r.grade_level),
      });
    }
    const students = [...seen.values()];
    let created = 0, updated = 0;
    for (let i = 0; i < students.length; i += 200) {
      const res = await ctx.runMutation(internal.sisSync.syncStudents, {
        syncedAt, students: students.slice(i, i + 200), archiveMissing: false,
      });
      created += res.created; updated += res.updated;
    }

    // ---- statistics ----
    const att = await namedQuery(host, tok, `${prefix}.attendance_summary`, {
      schoolid, termid, yeartermid,
    });
    const attRows = att.rows
      .map((a) => ({
        studentNumber: s(a.student_number) ?? "",
        daysAbsentTerm: n(a.days_absent_term),
        daysAbsentYtd: n(a.days_absent_ytd),
        daysTardyTerm: n(a.days_tardy_term),
        attendanceRowsYtd: n(a.attendance_rows_ytd),
        termFirstDay: s(a.term_first_day),
        termLastDay: s(a.term_last_day),
        termId: String(termid),
      }))
      .filter((a) => a.studentNumber);
    for (let i = 0; i < attRows.length; i += 200) {
      await ctx.runMutation(internal.sisStats.putAttendance, {
        syncedAt, rows: attRows.slice(i, i + 200),
      });
    }

    const grades = await namedQuery(host, tok, `${prefix}.grades`, {
      schoolid, termid,
      finalgradename: need("PS_FINAL_GRADE_NAME"),
      storecode: need("PS_STORE_CODE"),
    });
    const gradeRows = grades.rows
      .map((g) => ({
        studentNumber: s(g.student_number) ?? "",
        sectionId: s(g.section_id),
        courseNumber: s(g.course_number),
        courseName: s(g.course_name),
        currentGrade: s(g.current_grade),
        currentPercent: n(g.current_percent), // undefined stays undefined, never 0
        gradeSource: s(g.grade_source),
        lastGradeUpdate: s(g.last_grade_update),
      }))
      .filter((g) => g.studentNumber);
    for (let i = 0; i < gradeRows.length; i += 200) {
      // The first chunk clears, and clearing may need several passes because
      // the table no longer fits in one execution's read budget.
      if (i === 0) {
        for (let pass = 0; pass < 20; pass++) {
          const r: { remaining?: string } = await ctx.runMutation(
            internal.sisStats.replaceGrades,
            { syncedAt, rows: [], clearFirst: true },
          );
          if (r.remaining !== "some") break;
        }
      }
      await ctx.runMutation(internal.sisStats.replaceGrades, {
        syncedAt, rows: gradeRows.slice(i, i + 200), clearFirst: false,
      });
    }

    // ---- student email: the sign-in join key ----
    // Runs here, on the cron, rather than only in the local script. It is the
    // one field student sign in cannot work without, so making it depend on a
    // laptop being awake was the wrong call.
    const emailQuery = await namedQuery(host, tok, `${prefix}.student_email`, { schoolid });
    const emailRows = emailQuery.rows
      .map((r) => ({
        studentNumber: s(r.student_number) ?? "",
        email: s(r.email_address) ?? "",
        isPrimary: r.is_primary ?? null,
      }))
      .filter((r) => r.studentNumber && r.email);

    let emailResult: any = { studentsWithEmail: 0, totalStudents: 0 };
    for (let i = 0; i < emailRows.length; i += 200) {
      emailResult = await ctx.runMutation(internal.studentEmail.setStudentEmails, {
        rows: emailRows.slice(i, i + 200),
      });
    }

    const summary = {
      reason: reason ?? "scheduled",
      syncedAt,
      rosterRows: rosterRows.length,
      students: students.length,
      studentsCreated: created,
      studentsUpdated: updated,
      attendanceRows: attRows.length,
      gradeRows: gradeRows.length,
      gradeRowsMissingPercent: gradeRows.filter((g) => g.currentPercent === undefined).length,
      studentEmailRows: emailRows.length,
      studentsWithEmail: emailResult.studentsWithEmail,
      studentsWithoutEmail: emailResult.totalStudents - emailResult.studentsWithEmail,
      durationMs: Date.now() - started,
    };
    await ctx.runMutation(internal.syncLog.record, { summary });
    return summary;
  },
});
