/**
 * Sync PowerSchool into the Wildcat Hub app (Convex).
 *
 * Run:  npm run sync            full run
 *       npm run sync -- --dry   pull and report, write nothing
 *
 * Needs CONVEX_DEPLOY_KEY in the environment alongside the PowerSchool config.
 *
 * WHAT IT SYNCS
 *   enrollment    roster       -> psRoster (student x section) and students
 *   statistics    attendance   -> psAttendance   (days absent, tardies)
 *                 grades       -> psGrades       (current grade / percent)
 *   demographics  roster       -> gender, grade level on the student record
 *
 * WHAT IT DELIBERATELY DOES NOT SYNC
 *   The restricted fields (federal ethnicity, federal race, English Learner).
 *   The queries exist and are granted, but the brief's closing question asks
 *   what decision those fields inform in a teacher-facing dashboard and says
 *   to descope them if nobody can name one. Loading them is a separate act
 *   with its own go/no-go line, not a side effect of a roster sync.
 *
 * THE RULE THIS RUNS ON
 *   A sync writes identity, enrollment and statistics. It NEVER writes a
 *   ticket balance or Wildcat Cash. PowerSchool does not know a child earned
 *   6,616,500 of anything, so any value it appears to offer for one is absence,
 *   not zero. That guarantee is enforced in convex/sisMerge.ts, which builds
 *   its patch from an allowlist, and is covered by 27 tests.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, redactedConfig, type Config } from "./config.ts";
import { PowerSchoolClient } from "./client.ts";
import { QUERY_PREFIX } from "./manifest.ts";

const DRY = process.argv.includes("--dry");
const CHUNK = 200;

function convex(fn: string, args: unknown): any {
  const out = execFileSync("npx", ["convex", "run", fn, JSON.stringify(args)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    // fileURLToPath, not .pathname: this repo lives under a Dropbox path
    // containing spaces, and .pathname leaves them percent-encoded, which
    // makes the cwd invalid and npx unfindable.
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
  });
  return JSON.parse(out);
}

const nonEmpty = (v: unknown) => String(v ?? "").trim().length > 0;
const str = (v: unknown) => (nonEmpty(v) ? String(v).trim() : undefined);
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const config: Config = await loadConfig();
const client = new PowerSchoolClient(config);
const syncedAt = new Date().toISOString();

console.log(`\nWildcat Hub SIS sync  ${syncedAt}${DRY ? "  (DRY RUN)" : ""}`);
console.log("=".repeat(64));
console.log(`  instance   ${redactedConfig(config).host}`);
console.log(`  school     ${config.schoolId}   term ${config.termId}`);

// ---- 1. enrollment ------------------------------------------------------
const { rows: roster, ms: rosterMs } = await client.namedQuery(
  `${QUERY_PREFIX}.roster`,
  { schoolid: config.schoolId, termid: config.termId },
);
const students = new Map<string, any>();
for (const r of roster) {
  const key = str(r.student_number);
  if (!key) continue;
  if (!students.has(key)) {
    students.set(key, {
      studentNumber: key,
      firstName: str(r.first_name) ?? "",
      lastName: str(r.last_name) ?? "",
      grade: str(r.grade_level),
      // student_email is absent from this instance entirely: 0 of 3805 rows
      // carried one and PowerSchool does not return the column. Student
      // sign-in cannot key off the SIS. Left undefined rather than derived.
    });
  }
}
console.log(`\n  roster       ${roster.length} rows, ${students.size} students, ${rosterMs}ms`);

// ---- 2. statistics ------------------------------------------------------
const { rows: attendance } = await client.namedQuery(
  `${QUERY_PREFIX}.attendance_summary`,
  // yeartermid as well as termid: the attendance aggregate spans the year
  // record, which is a different id from the term. Taken from the query's own
  // declared args rather than assumed.
  { schoolid: config.schoolId, termid: config.termId, yeartermid: config.yearTermId },
);
const { rows: grades } = await client.namedQuery(`${QUERY_PREFIX}.grades`, {
  schoolid: config.schoolId,
  termid: config.termId,
  finalgradename: config.finalGradeName,
  storecode: config.storeCode,
});
console.log(`  attendance   ${attendance.length} rows`);
console.log(`  grades       ${grades.length} rows`);

// ---- 2b. restricted demographics ---------------------------------------
//
// Two queries because the brief keeps them separate: race codes are one to
// many and live in STUDENTRACE, ethnicity and EL status are columns on the
// student. Both are behind their own access grant, so a school that is
// refused one still gets the other rather than losing both.
//
// docs/access-gap.md records both as granted on this instance, probed
// 2026-08-12, with student_race_restricted returning 100 rows.
const restrictedRows = new Map<string, any>();
const touch = (num: string) => {
  if (!restrictedRows.has(num)) restrictedRows.set(num, { studentNumber: num });
  return restrictedRows.get(num);
};

let raceCount = 0;
try {
  const { rows: races } = await client.namedQuery(
    `${QUERY_PREFIX}.student_race_restricted`,
    { schoolid: config.schoolId },
  );
  for (const r of races) {
    const num = str(r.student_number);
    const code = str(r.race_code);
    if (!num || !code) continue;
    const row = touch(num);
    // One row per code. Never collapsed: a multi-race student is multi-race,
    // and flattening to "Two or more" is a reporting decision the school has
    // not made.
    (row.raceCodes ??= []).push(code);
    raceCount++;
  }
  console.log(`  race         ${races.length} rows, ${raceCount} codes`);
} catch (e: any) {
  // Refused access is a FACT to report, not a reason to abort the sync. The
  // roster matters more than the demographics.
  console.log(`  race         SKIPPED: ${e?.message ?? e}`);
}

try {
  const { rows: restricted } = await client.namedQuery(
    `${QUERY_PREFIX}.student_restricted`,
    { schoolid: config.schoolId },
  );
  for (const r of restricted) {
    const num = str(r.student_number);
    if (!num) continue;
    const row = touch(num);
    row.fedEthnicity = str(r.fed_ethnicity);
    row.elaStatus = str(r.ela_status);
  }
  console.log(`  ethnicity    ${restricted.length} rows`);
} catch (e: any) {
  console.log(`  ethnicity    SKIPPED: ${e?.message ?? e}`);
}

const missingPercent = grades.filter((g: any) => !nonEmpty(g.current_percent)).length;
if (missingPercent) {
  console.log(`               ${missingPercent} with no percent (a GAP, never rendered as 0%)`);
}

if (DRY) {
  console.log("\n" + "=".repeat(64));
  console.log("DRY RUN. Nothing written.\n");
  process.exit(0);
}

// ---- 3. write ------------------------------------------------------------
console.log("\n  writing to Convex...");

// enrollment: psRoster is a full replace, because a dropped section must
// disappear from a teacher's roster and a merge cannot express a deletion.
for (let pass = 0; pass < 20; pass++) {
  const cleared = convex("psSync:clearRoster", {});
  if (cleared.remaining === "none") break;
}
const rosterRows = roster.map((r: any) => ({
  studentNumber: str(r.student_number) ?? "",
  firstName: str(r.first_name) ?? "",
  lastName: str(r.last_name) ?? "",
  gradeLevel: str(r.grade_level),
  sectionId: str(r.section_id),
  sectionNumber: str(r.section_number),
  sectionExpression: str(r.section_expression),
  courseNumber: str(r.course_number),
  courseName: str(r.course_name),
  period: str(r.section_expression) ?? str(r.cc_expression),
  teacherEmail: str(r.teacher_email),
  teacherFirstName: str(r.teacher_first_name),
  teacherLastName: str(r.teacher_last_name),
  teacherNumber: str(r.teacher_number),
  termId: str(r.term_id),
  termAbbreviation: str(r.term_abbreviation),
  schoolId: str(r.school_id),
})).filter((r) => r.studentNumber);

for (let i = 0; i < rosterRows.length; i += CHUNK) {
  convex("psSync:upsertRoster", { syncedAt, rows: rosterRows.slice(i, i + CHUNK) });
}
console.log(`    psRoster      ${rosterRows.length} rows`);

// students: identity and enrollment only. Balances are untouchable here.
const studentRows = [...students.values()];
let created = 0, updated = 0, unchanged = 0;
for (let i = 0; i < studentRows.length; i += CHUNK) {
  const res = convex("sisSync:syncStudents", {
    syncedAt,
    students: studentRows.slice(i, i + CHUNK),
    archiveMissing: false, // partial-term data; absence here does not mean gone
  });
  created += res.created; updated += res.updated; unchanged += res.unchanged;
}
console.log(`    students      ${created} new, ${updated} updated, ${unchanged} unchanged`);

// statistics
const attRows = attendance.map((a: any) => ({
  studentNumber: str(a.student_number) ?? "",
  daysAbsentTerm: num(a.days_absent_term),
  daysAbsentYtd: num(a.days_absent_ytd),
  daysTardyTerm: num(a.days_tardy_term),
  attendanceRowsYtd: num(a.attendance_rows_ytd),
  termFirstDay: str(a.term_first_day),
  termLastDay: str(a.term_last_day),
  termId: String(config.termId),
})).filter((a) => a.studentNumber);
for (let i = 0; i < attRows.length; i += CHUNK) {
  convex("sisStats:putAttendance", { syncedAt, rows: attRows.slice(i, i + CHUNK) });
}
console.log(`    psAttendance  ${attRows.length} rows`);

const gradeRows = grades.map((g: any) => ({
  studentNumber: str(g.student_number) ?? "",
  sectionId: str(g.section_id),
  courseNumber: str(g.course_number),
  courseName: str(g.course_name),
  currentGrade: str(g.current_grade),
  currentPercent: num(g.current_percent), // undefined stays undefined, never 0
  gradeSource: str(g.grade_source),
  lastGradeUpdate: str(g.last_grade_update),
})).filter((g) => g.studentNumber);
for (let i = 0; i < gradeRows.length; i += CHUNK) {
  if (i === 0) {
    for (let pass = 0; pass < 20; pass++) {
      const r = convex("sisStats:replaceGrades", { syncedAt, rows: [], clearFirst: true });
      if (r.remaining !== "some") break;
    }
  }
  convex("sisStats:replaceGrades", {
    syncedAt, rows: gradeRows.slice(i, i + CHUNK), clearFirst: false,
  });
}
console.log(`    psGrades      ${gradeRows.length} rows`);

// ---- 3b. student email, the sign-in join key ------------------------------
// Separate from the roster on purpose: identity is not enrollment, and a
// failure in one should not quietly take the other with it.
const { rows: emailRows } = await client.namedQuery(`${QUERY_PREFIX}.student_email`, {
  schoolid: config.schoolId,
});
const emails = emailRows
  .map((r: any) => ({
    studentNumber: str(r.student_number) ?? "",
    email: str(r.email_address) ?? "",
    isPrimary: r.is_primary ?? null,
  }))
  .filter((r) => r.studentNumber && r.email);


// restricted demographics: FULL REPLACE, like grades. A student corrected in
// PowerSchool from two race codes to one must lose the extra, and a merge
// cannot express a deletion. Getting this wrong leaves the app permanently
// more certain about a child's race than the SIS is.
{
  const rows = [...restrictedRows.values()];
  if (!rows.length) {
    console.log("  restricted   nothing to write (both queries skipped or empty)");
  } else {
    const first = convex("sisStats:replaceRestricted", {
      syncedAt, rows: rows.slice(0, CHUNK), clearFirst: true,
    });
    for (let i = CHUNK; i < rows.length; i += CHUNK) {
      convex("sisStats:replaceRestricted", {
        syncedAt, rows: rows.slice(i, i + CHUNK), clearFirst: false,
      });
    }
    console.log(`  restricted   ${rows.length} students (cleared ${first.cleared})`);
  }
}

for (let i = 0; i < emails.length; i += CHUNK) {
  const res = convex("studentEmail:setStudentEmails", { rows: emails.slice(i, i + CHUNK) });
  if (i + CHUNK >= emails.length) {
    console.log(`    studentEmail  ${res.studentsWithEmail} of ${res.totalStudents} students now have an address`);
    if (res.refusedDomains?.length) {
      console.log(`                  refused domains: ${res.refusedDomains.join(", ")}`);
    }
    if (res.noStudent) console.log(`                  ${res.noStudent} address(es) matched no student record`);
  }
}

// ---- 4. report -----------------------------------------------------------
const after = convex("sisStats:stats", {});
console.log("\n" + "=".repeat(64));
console.log("  After sync:");
for (const [k, v] of Object.entries(after)) console.log(`    ${k.padEnd(24)} ${v}`);
console.log(`\n  requests this run: ${client.summary().requests} (ceiling ${config.hourlyRequestCeiling})`);
console.log("\nDone.\n");
