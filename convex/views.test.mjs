// Tests for the response allowlists. Run: npm test
//
// These exist because the failure mode is silent. A response built by spreading
// the source row looks correct in every manual test, and then leaks the day
// someone adds a column upstream. The manifest is explicitly designed to grow,
// and five of its fields are restricted (federal ethnicity, federal race, IEP,
// 504, English Learner), so "a new column appears" is a scheduled event here,
// not a hypothetical.
//
// The test therefore feeds rows carrying fields that must never reach a caller
// and asserts on what comes OUT, rather than trusting the implementation.

import { studentView, staffRosterView, staffAttendanceView } from "./views.ts";

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`); }
}

// A roster row as it will look once the manifest is fully delivered, including
// the restricted fields that are one approval away from existing.
const ROW = {
  studentNumber: "123456",
  stateStudentNumber: "9999999999",          // state identifier
  studentEmail: "ana.lopez@westbrookacademy.org",
  firstName: "Ana",
  lastName: "Lopez",
  gradeLevel: "9",
  gender: "F",
  courseName: "Algebra I",
  courseNumber: "MAT101",
  period: "3",
  teacherFirstName: "Sam",
  teacherLastName: "Rivera",
  teacherEmail: "sam.rivera@lapromisefund.org",
  termAbbreviation: "S1",
  // restricted, Grilled.md constraint 3
  fedEthnicity: "H",
  fedRace: "W",
  iepStatus: "Y",
  section504: "Y",
  elaStatus: "EL",
};

const MUST_NEVER_APPEAR = [
  "9999999999",   // state student number
  "F",            // gender  (checked structurally below too)
  "H", "W", "Y", "EL",
  "ana.lopez@westbrookacademy.org",
  "sam.rivera@lapromisefund.org",
];

console.log("\nStudent view: what a student sees about themselves");
const sv = studentView(ROW);
const svJson = JSON.stringify(sv);
check("returns the course", sv.courseName === "Algebra I");
check("returns the period", sv.period === "3");
check("returns the teacher's name", sv.teacher === "Sam Rivera");
check("does NOT leak state student number", !svJson.includes("9999999999"));
check("does NOT leak the student's own email", !svJson.includes("ana.lopez@"));
check("does NOT leak the teacher's email", !svJson.includes("sam.rivera@"));
check("does NOT leak gender", !("gender" in sv));
check("does NOT leak federal ethnicity", !("fedEthnicity" in sv));
check("does NOT leak federal race", !("fedRace" in sv));
check("does NOT leak IEP status", !("iepStatus" in sv));
check("does NOT leak 504 status", !("section504" in sv));
check("does NOT leak English Learner status", !("elaStatus" in sv));

console.log("\nStaff roster view: what a teacher sees about their student");
const tv = staffRosterView(ROW);
const tvJson = JSON.stringify(tv);
check("returns the student's name", tv.firstName === "Ana" && tv.lastName === "Lopez");
check("returns the student number", tv.studentNumber === "123456");
check("returns grade level", tv.gradeLevel === "9");
check("does NOT leak state student number", !tvJson.includes("9999999999"));
check("does NOT leak restricted fields", !["fedEthnicity","fedRace","iepStatus","section504","elaStatus"].some(k => k in tv));
check("does NOT leak emails", !tvJson.includes("@"));

console.log("\nThe property that actually matters: unknown columns stay out");
// Simulates PowerSchool gaining a column nobody told the app about.
const FUTURE = { ...ROW, someNewSensitiveColumn: "SECRET-VALUE-42" };
check(
  "a brand-new upstream column does not reach students",
  !JSON.stringify(studentView(FUTURE)).includes("SECRET-VALUE-42"),
);
check(
  "a brand-new upstream column does not reach staff",
  !JSON.stringify(staffRosterView(FUTURE)).includes("SECRET-VALUE-42"),
);

console.log("\nStaff attendance view: absent is not zero");
{
  // A psAttendance row as the SIS sync writes it, plus the columns an upstream
  // aggregate could grow and a restricted one to prove the allowlist holds.
  const AV = staffAttendanceView({
    studentNumber: "123456",
    daysAbsentTerm: 2,
    daysAbsentYtd: 7,
    daysTardyTerm: 0,
    attendanceRowsYtd: 44,
    termFirstDay: "2026-01-12",
    termLastDay: "2026-03-20",
    termId: "2600",
    syncedAt: "2026-08-15T06:00:00.000Z",
    fedEthnicity: "H",
    someNewSensitiveColumn: "SECRET-VALUE-42",
  });
  check("returns days absent this term", AV.daysAbsentTerm === 2);
  check("returns days absent year to date", AV.daysAbsentYtd === 7);
  check("a MEASURED zero is reported as 0, not hidden", AV.daysTardyTerm === 0);
  check("returns the term window", AV.termFirstDay === "2026-01-12" && AV.termLastDay === "2026-03-20");
  check("returns when it synced", AV.lastSyncedAt === "2026-08-15T06:00:00.000Z");
  check("does NOT repeat the student number", !("studentNumber" in AV));
  check("does NOT leak a restricted column", !("fedEthnicity" in AV));
  check(
    "a brand-new upstream column does not reach staff",
    !JSON.stringify(AV).includes("SECRET-VALUE-42"),
  );
  check(
    "attendanceRowsYtd is left out, it is a row count and not a day count",
    !("attendanceRowsYtd" in AV),
  );

  // The mistake the schema comment beside psAttendance exists to prevent.
  const sparse = staffAttendanceView({ syncedAt: "2026-08-15T06:00:00.000Z" });
  check("an absent day count is null, NEVER 0", sparse.daysAbsentTerm === null);
  check("  and so is the year to date figure", sparse.daysAbsentYtd === null);
  check("  and so are tardies", sparse.daysTardyTerm === null);
  check("nulls survive JSON", JSON.stringify(sparse).includes('"daysAbsentTerm":null'));

  const broken = staffAttendanceView({ daysAbsentTerm: NaN, daysAbsentYtd: -3, daysTardyTerm: "4" });
  check("NaN does not become a count", broken.daysAbsentTerm === null);
  check("a negative day count does not become a count", broken.daysAbsentYtd === null);
  check("a numeric string is not coerced into a count", broken.daysTardyTerm === null);
}

console.log("\nMissing data degrades to null, never to undefined-in-JSON");
const sparse = studentView({ courseName: "Art" });
check("absent fields become null", sparse.period === null && sparse.teacher === null);
check("nulls survive JSON", JSON.stringify(sparse).includes('"period":null'));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
