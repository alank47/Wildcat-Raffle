import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { primaryEmailByStudentNumber } from "./identityRules";
import { attachStudentEmail } from "./rosterEmail";
import { markedMissingButScored } from "./missingWorkRules";
import { rosterReplaceVerdict } from "./rosterGuardRules";

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

    // ---- student email: the sign in join key ----
    // FETCHED FIRST, because the roster rows below have to carry it. The
    // roster PowerQuery does not return student email, and me:get looks up a
    // student's classes BY that address, so a roster written before the
    // addresses are known is a roster no student can ever match. It used to be
    // fetched at the end, purely for the students table, and every student's
    // schedule was empty as a result.
    const emailQuery = await namedQuery(host, tok, `${prefix}.student_email`, { schoolid });
    const emailRows = emailQuery.rows
      .map((r) => ({
        studentNumber: s(r.student_number) ?? "",
        email: s(r.email_address) ?? "",
        isPrimary: r.is_primary ?? null,
      }))
      .filter((r) => r.studentNumber && r.email);
    const emailByNumber = primaryEmailByStudentNumber(emailRows);

    // ---- enrollment ----
    const roster = await namedQuery(host, tok, `${prefix}.roster`, { schoolid, termid });
    const rosterRowsWithoutEmail = roster.rows
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

    // Stamp each row with its student's address. This is what makes
    // psRoster.by_studentEmail answer anything.
    const rosterRows = attachStudentEmail(rosterRowsWithoutEmail, emailByNumber);

    // THE EMPTY-CLEAR GUARD (2026-10-08). The roster is a full replace, so a
    // read that came back empty -- or under half the rows already here --
    // would wipe every class list and schedule in the app, twice a day until
    // somebody noticed. Count what is here first (paged: the table is bigger
    // than one execution may read), and keep it unless the new read is
    // believable. A kept roster is recorded in the run (rosterKept, and why),
    // never silent. See rosterGuardRules.ts.
    let rosterRowsBefore = 0;
    const rowsBySync = new Map<string, number>();
    let rosterCursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const counted: { n: number; bySync: Array<[string, number]>; isDone: boolean; continueCursor: string } =
        await ctx.runQuery(internal.psSync.rosterCountPage, { cursor: rosterCursor });
      rosterRowsBefore += counted.n;
      for (const [at, n] of counted.bySync ?? []) rowsBySync.set(at, (rowsBySync.get(at) ?? 0) + n);
      if (counted.isDone) break;
      rosterCursor = counted.continueCursor;
    }
    // THE ROSTER IN PLACE IS THE NEWEST SYNC'S ROWS (review, 2026-10-08). The
    // 13:00/19:00 cron and an admin's "Sync now" share no lock, so two syncs
    // can overlap -- both clear, both write -- and leave every row twice,
    // under two syncedAts. Measured against all of them, every later read
    // looked "under half" and was refused, so the doubled roster was kept for
    // good. Measured against the newest sync's rows alone, the next
    // believable read replaces it, as it did before the guard.
    const newestSync = [...rowsBySync.keys()].sort().pop();
    const rosterRowsCurrent = newestSync ? rowsBySync.get(newestSync)! : 0;
    const rosterGuard = rosterReplaceVerdict({ incomingRows: rosterRows.length, currentRows: rosterRowsCurrent });
    const rosterKept = !rosterGuard.replace;
    const rosterKeptReason = rosterGuard.replace ? null : rosterGuard.reason;

    // upsertRoster already counted the rows it could not key, and the count was
    // thrown away. That is how "no student has a schedule" stayed invisible:
    // the signal existed and nothing carried it out to where anyone looks.
    // rosterMissingStudentEmail equal to rosterRows means the join is dead.
    let rosterMissingStudentEmail = 0;
    if (rosterGuard.replace) {
      // Loop: one call deletes a batch, because the whole table no longer fits
      // in a single execution's read budget. Bounded so a bug here cannot spin.
      for (let pass = 0; pass < 20; pass++) {
        const cleared: { deleted: number; remaining: string } =
          await ctx.runMutation(internal.psSync.clearRoster, {});
        if (cleared.remaining === "none") break;
      }
      for (let i = 0; i < rosterRows.length; i += 200) {
        const res: { missingStudentEmail: number } = await ctx.runMutation(
          internal.psSync.upsertRoster,
          { syncedAt, rows: rosterRows.slice(i, i + 200) },
        );
        rosterMissingStudentEmail += res.missingStudentEmail;
      }
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
        // Already selected by the roster query as S.GENDER AS gender, and
        // already granted in plugin.xml. Reading it here is the whole change.
        gender: s(r.gender),
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

    // ---- work a teacher marked missing ----
    //
    // ON THE CRON, not only in the local script, and that distinction is the
    // whole point of this block. The student-facing card reads this table, so
    // leaving it to `npm run sync` would mean a child's missing-work list was
    // as fresh as the last time somebody remembered to open a laptop. It was
    // added to sync-to-app.ts first and the cron kept running without it,
    // which is exactly how one of two sync implementations goes quietly stale.
    //
    // Scoped by year through Terms, never by AssignmentSection.YearID: that
    // column is granted and EMPTY on every row here, and filtering on it
    // returned HTTP 200 with zero rows for the whole of plugin 1.3.0.
    //
    // A refusal is REPORTED and skipped, never fatal, for the same reason the
    // demographics below are: the roster matters more than the card, and a
    // sync that aborts here takes the whole school's schedule down over a
    // panel that can say "no data yet".
    type MissingRow = {
      studentNumber: string;
      assignmentSectionId: string;
      assignmentName?: string;
      dueDate?: string;
      pointsPossible?: number;
      sectionId?: string;
      courseName?: string;
      categoryName?: string;
      isLate?: boolean;
      scorePoints?: number;
      totalPointValue?: number;
      isMissing?: boolean;
    };
    let missingRows: MissingRow[] = [];
    let missingError: string | null = null;
    try {
      const missing = await namedQuery(host, tok, `${prefix}.missing_work`, {
        schoolid,
        yearid: need("PS_YEAR_ID"),
      });
      missingRows = missing.rows
        .map((m) => ({
          studentNumber: s(m.student_number) ?? "",
          assignmentSectionId: s(m.assignment_section_id) ?? "",
          assignmentName: s(m.assignment_name),
          dueDate: s(m.due_date),
          // undefined stays undefined, never 0: a section can score by
          // something other than points, and a 0 reads to a student as work
          // that does not count.
          pointsPossible: n(m.points_possible),
          sectionId: s(m.section_id),
          courseName: s(m.course_name),
          categoryName: s(m.category_name),
          // PowerSchool returns booleans as the STRINGS "0" and "1", and
          // Boolean("0") is true, so every assignment would be reported late.
          isLate: String(m.is_late) === "1",
          // Returned by the query since 1.3.0 and discarded here until
          // 2026-09-05. n() keeps undefined as undefined: a missing score and
          // a score of zero are different facts. STORED AS GIVEN, with the
          // flag below: what counts as missing is decided when the table is
          // READ (missingWorkRules.isMissingWork, owner's final rule
          // 2026-10-05), never here, so every row PowerSchool returns is
          // written and a change of rule is a deploy, not a resync.
          scorePoints: n(m.score_points),
          totalPointValue: n(m.total_point_value),
          // Absent means 1.3.x, whose query returned ONLY flagged work, so an
          // old row is missing by definition. String "0"/"1" again: Boolean("0")
          // is true, and getting this backwards would tell every child their
          // handed-in work was never handed in.
          isMissing: m.is_missing === undefined ? true : String(m.is_missing) === "1",
        }))
        .filter((m) => m.studentNumber && m.assignmentSectionId);
    } catch (e: unknown) {
      missingError = e instanceof Error ? e.message : String(e);
    }

    if (missingError === null) {
      // The clear runs even when there is nothing to write. A sync that finds
      // NOTHING missing must still empty the table, or every student keeps
      // yesterday's list forever, on the one day it should have gone away.
      for (let pass = 0; pass < 20; pass++) {
        const r: { remaining?: string } = await ctx.runMutation(
          internal.sisStats.replaceMissingWork,
          { syncedAt, rows: [], clearFirst: true },
        );
        if (r.remaining !== "some") break;
      }
      for (let i = 0; i < missingRows.length; i += 200) {
        await ctx.runMutation(internal.sisStats.replaceMissingWork, {
          syncedAt, rows: missingRows.slice(i, i + 200), clearFirst: false,
        });
      }
    }

    // ---- SECTION POINT TOTALS (plugin 1.4.0) --------------------------------
    //
    // The denominator a percentage projection needs. Its own try/catch and its
    // own error field, like missing work above: an instance still running
    // plugin 1.3.x does not have this query, and a 404 here must not take the
    // roster, grades and attendance down with it. The card simply says it
    // cannot project until the plugin is updated.
    let sectionPointRows: Array<{
      studentNumber: string; sectionId: string; courseName?: string;
      pointsEarned: number; pointsPossible: number;
    }> = [];
    let sectionPointsError: string | null = null;
    try {
      const sp = await namedQuery(host, tok, `${prefix}.section_points`, {
        schoolid,
        yearid: need("PS_YEAR_ID"),
      });
      sectionPointRows = sp.rows
        .map((r) => ({
          studentNumber: s(r.student_number) ?? "",
          sectionId: s(r.section_id) ?? "",
          courseName: s(r.course_name),
          pointsEarned: n(r.points_earned) ?? 0,
          pointsPossible: n(r.points_possible) ?? 0,
        }))
        // A section with no graded work yet has a zero denominator, and a
        // percentage over zero is not a low grade, it is no grade. Dropped
        // here so nothing downstream has to guard against dividing by it.
        .filter((r) => r.studentNumber && r.sectionId && r.pointsPossible > 0);
    } catch (e: unknown) {
      sectionPointsError = e instanceof Error ? e.message : String(e);
    }

    if (sectionPointsError === null) {
      for (let pass = 0; pass < 20; pass++) {
        const r: { moreToClear?: boolean } = await ctx.runMutation(
          internal.sisStats.replaceSectionPoints,
          { syncedAt, rows: [], clearFirst: true },
        );
        if (!r.moreToClear) break;
      }
      for (let i = 0; i < sectionPointRows.length; i += 200) {
        await ctx.runMutation(internal.sisStats.replaceSectionPoints, {
          syncedAt, rows: sectionPointRows.slice(i, i + 200), clearFirst: false,
        });
      }
    }
    // ---- ABSENCE BY PERIOD --------------------------------------------------
    //
    // WHY IT IS WORTH A SECOND ATTENDANCE PULL. attendance_summary returns
    // COUNT(DISTINCT ATT_DATE), so the app can say a child missed six days and
    // cannot say WHICH periods -- and at this school that is the difference
    // between truancy and a late bus. Measured 2026-09-21: of 10,719 absent
    // period-days, 3,753 (35%) are Promise Time, the advisory block at each end
    // of the day, and the average flagged day covers 3.89 of about 6 blocks.
    //
    // ITS OWN try/catch AND ITS OWN ERROR FIELD, like section points above. A
    // 404 or a refusal here must not take the roster, grades and attendance
    // down with it; the screen says it cannot break absence down by period yet.
    //
    // termid AND NOT yearid. The query declares schoolid and termid only, and
    // passing yearid alongside answers HTTP 400 -- which reads exactly like a
    // refusal and is really a mismatched signature.
    let attendanceSectionRows: Array<{
      studentNumber: string; sectionId?: string; sectionNumber?: string;
      sectionExpression?: string; courseNumber?: string; courseName?: string;
      teacherId?: string; daysAbsent?: number; daysTardy?: number;
      attendanceRows?: number; lastAbsenceDate?: string;
      termFirstDay?: string; termLastDay?: string;
    }> = [];
    let attendanceBySectionError: string | null = null;
    let attendanceBySectionPages = 0;
    try {
      const abs = await namedQuery(host, tok, `${prefix}.attendance_by_section`, {
        schoolid,
        termid,
      });
      attendanceBySectionPages = abs.pages;
      attendanceSectionRows = abs.rows
        .map((r) => ({
          studentNumber: s(r.student_number) ?? "",
          sectionId: s(r.section_id),
          sectionNumber: s(r.section_number),
          sectionExpression: s(r.section_expression),
          courseNumber: s(r.course_number),
          courseName: s(r.course_name),
          teacherId: s(r.teacher_id),
          // ABSENT STAYS UNDEFINED, never 0. "not synced yet" and "never
          // absent in this class" are different facts about a child.
          daysAbsent: n(r.days_absent_section_term),
          daysTardy: n(r.days_tardy_section_term),
          // 0 HERE IS LOAD-BEARING: nobody ever took attendance in this
          // section. 1,631 of 5,563 measured rows are in that state and must
          // not render as a clean record.
          attendanceRows: n(r.attendance_rows_section_term),
          // A date from the SIS stays a string. Parsing it into a JS Date in
          // one timezone and re-serializing in another is how a Friday
          // absence becomes a Thursday one.
          lastAbsenceDate: s(r.last_absence_date),
          termFirstDay: s(r.term_first_day),
          termLastDay: s(r.term_last_day),
        }))
        // NEVER an unkeyed row: it would join to every other unkeyed student.
        .filter((r) => r.studentNumber);
    } catch (e: unknown) {
      attendanceBySectionError = e instanceof Error ? e.message : String(e);
    }

    if (attendanceBySectionError === null) {
      for (let pass = 0; pass < 20; pass++) {
        const r: { moreToClear?: boolean } = await ctx.runMutation(
          internal.sisStats.replaceAttendanceBySection,
          { syncedAt, rows: [], clearFirst: true },
        );
        if (!r.moreToClear) break;
      }
      for (let i = 0; i < attendanceSectionRows.length; i += 200) {
        await ctx.runMutation(internal.sisStats.replaceAttendanceBySection, {
          syncedAt, rows: attendanceSectionRows.slice(i, i + 200), clearFirst: false,
        });
      }
    }


    // ---- restricted demographics ----
    //
    // ON THE CRON, not only in the local script, for the same reason student
    // email is: making it depend on somebody's laptop being awake was the
    // wrong call. This is the data the discipline disproportionality view
    // reads, and it goes stale the moment a student's record changes.
    //
    // Two queries because the brief keeps them apart: race codes are one to
    // many and live in STUDENTRACE, ethnicity and EL are columns on the
    // student. Access is granted separately, so a refusal on one still leaves
    // the other. docs/access-gap.md records both granted on this instance.
    //
    // A refusal is REPORTED and skipped, never fatal. The roster matters more
    // than the demographics, and a sync that aborts here would take the whole
    // school's schedule down over a field nobody has looked at yet.
    const restrictedByNumber = new Map<string, any>();
    let raceCodeCount = 0;
    let raceError: string | null = null;
    let ethnicityError: string | null = null;

    try {
      const races = await namedQuery(host, tok, `${prefix}.student_race_restricted`, { schoolid });
      for (const r of races.rows) {
        const num = s(r.student_number);
        const code = s(r.race_code);
        if (!num || !code) continue;
        const row = restrictedByNumber.get(num) ?? { studentNumber: num };
        // Appended, never collapsed into "Two or more": that is a reporting
        // decision this school has not made, and collapsing hides exactly the
        // students it claims to describe.
        (row.raceCodes ??= []).push(code);
        restrictedByNumber.set(num, row);
        raceCodeCount++;
      }
    } catch (e: any) {
      raceError = String(e?.message ?? e);
    }

    try {
      const restricted = await namedQuery(host, tok, `${prefix}.student_restricted`, { schoolid });
      for (const r of restricted.rows) {
        const num = s(r.student_number);
        if (!num) continue;
        const row = restrictedByNumber.get(num) ?? { studentNumber: num };
        row.fedEthnicity = s(r.fed_ethnicity);
        row.elaStatus = s(r.ela_status);
        restrictedByNumber.set(num, row);
      }
    } catch (e: any) {
      ethnicityError = String(e?.message ?? e);
    }

    const restrictedRows = [...restrictedByNumber.values()];
    if (restrictedRows.length) {
      // Full replace, like grades. A student corrected in PowerSchool from two
      // race codes to one must LOSE the extra, and a merge cannot express a
      // deletion. Getting this wrong leaves the app permanently more certain
      // about a child's race than the SIS is.
      for (let i = 0; i < restrictedRows.length; i += 200) {
        await ctx.runMutation(internal.sisStats.replaceRestricted, {
          syncedAt,
          rows: restrictedRows.slice(i, i + 200),
          clearFirst: i === 0,
        });
      }
    }

    // ---- student email onto the students table ----
    // The addresses were fetched at the top of this run, because the roster
    // needed them. This writes the same rows onto the student records, which
    // is what a signed in student's identity and balances are looked up by.
    // Runs on the cron rather than only in the local script: it is the one
    // field student sign in cannot work without, so making it depend on a
    // laptop being awake was the wrong call.
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
      // The empty-clear guard: true when this run's roster read was empty or
      // under half of the rows already here, so it was NOT written and the
      // roster in place was kept. rosterRowsBefore is what was there.
      rosterKept,
      rosterKeptReason,
      rosterRowsBefore,
      // Roster rows nobody can look up by email. Equal to rosterRows means no
      // student can see a schedule at all; a small number is students whose
      // PowerSchool record has no address yet.
      rosterMissingStudentEmail,
      students: students.length,
      studentsCreated: created,
      studentsUpdated: updated,
      attendanceRows: attRows.length,
      gradeRows: gradeRows.length,
      gradeRowsMissingPercent: gradeRows.filter((g) => g.currentPercent === undefined).length,
      missingWorkRows: missingRows.length,
      // Of those, how many carry a score above zero with the Missing box
      // still ticked. Missing by the owner's rule (2026-10-05) "until the
      // teacher removes the designation", so this is the number that falls as
      // teachers untick them -- 808 on the day it was added.
      missingWorkMarkedButScored: missingRows.filter(markedMissingButScored).length,
      // Named rather than silently zero, for the same reason the race error
      // is: "nobody is missing work" and "we were refused" need different
      // responses, and only one of them is a code problem.
      missingWorkError: missingError,
      sectionPointRows: sectionPointRows.length,
      sectionPointsError,
      attendanceBySectionRows: attendanceSectionRows.length,
      attendanceBySectionError,
      // NAMED, NOT SILENT. namedQuery stops at MAX_PAGES without throwing and
      // without saying so, so a table that outgrows 200 pages would sync short
      // and look complete. This reports the pages used and says out loud when
      // it hit the wall. 5,563 rows is 56 pages today.
      attendanceBySectionPages,
      attendanceBySectionPagedOut: attendanceBySectionPages >= 200,
      studentEmailRows: emailRows.length,
      restrictedStudents: restrictedRows.length,
      restrictedRaceCodes: raceCodeCount,
      // Named rather than silently zero: "no race data" and "we were refused"
      // need different responses, and only one of them is a code problem.
      restrictedRaceError: raceError,
      restrictedEthnicityError: ethnicityError,
      studentsWithEmail: emailResult.studentsWithEmail,
      studentsWithoutEmail: emailResult.totalStudents - emailResult.studentsWithEmail,
      durationMs: Date.now() - started,
    };
    await ctx.runMutation(internal.syncLog.record, { summary });
    return summary;
  },
});
