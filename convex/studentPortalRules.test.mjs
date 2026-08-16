// The join keys behind the student portal. Run: npm test
//
// This file exists for one failure, and it is silent.
//
// myStudentView used to derive its PowerSchool key as
//
//     student.studentNumber ?? student.legacyId ?? ""
//
// and then query psGrades, psAttendance and psRoster with it. An index lookup
// for "" is not a no-op: it is a real bucket, and it returns every row that was
// written with an empty student number. Those rows come from an upstream sync
// nobody here controls, so one malformed import is all it takes for a student
// with no number of their own to open their portal and read another child's
// grades and absences. Nothing throws. The page renders perfectly.
//
// So the assertions below are about what comes OUT for a BROKEN record, not
// about the happy path. The property that matters is: when there is no key,
// there is no key, and the value handed back is null rather than a string a
// careless caller could still pass to eq().

import {
  sisNumberKey,
  sisEmailKey,
  gradeCell,
  NO_NUMBER_REASON,
  NO_EMAIL_REASON,
} from "./studentPortalRules.ts";

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`); }
}

console.log("\nThe student number key: a real number resolves");
{
  check("a student number is used", sisNumberKey({ studentNumber: "11095" }).value === "11095");
  check(
    "legacyId is the fallback, because migrate.ts and sisSync.ts write the same value into it",
    sisNumberKey({ legacyId: "11095" }).value === "11095",
  );
  check(
    "studentNumber wins when both are present",
    sisNumberKey({ studentNumber: "11095", legacyId: "99999" }).value === "11095",
  );
  check("a resolved key reports ok", sisNumberKey({ studentNumber: "11095" }).ok === true);
  check("a resolved key carries no reason", sisNumberKey({ studentNumber: "11095" }).reason === null);
  check("surrounding whitespace is stripped", sisNumberKey({ studentNumber: " 11095 " }).value === "11095");
}

console.log("\nThe empty join key: fail closed, never query");
{
  // Every one of these is a record that exists in the live data today. 209 of
  // 646 enrolled students have incomplete SIS identity.
  const BROKEN = [
    ["no fields at all", {}],
    ["an undefined student number", { studentNumber: undefined }],
    ["a null student number", { studentNumber: null }],
    ["an EMPTY STRING student number", { studentNumber: "" }],
    ["an empty string in both fields", { studentNumber: "", legacyId: "" }],
    ["a whitespace-only student number", { studentNumber: "   " }],
    ["a whitespace-only legacyId", { studentNumber: undefined, legacyId: "\t" }],
  ];

  for (const [label, student] of BROKEN) {
    const key = sisNumberKey(student);
    check(`${label} is refused`, key.ok === false, JSON.stringify(key));
    // The one that actually protects a child: a caller that ignores `ok` and
    // reaches for `.value` gets null, which cannot be handed to eq(). If this
    // ever became "" the whole guard would be decorative.
    check(`${label} yields null, NOT ""`, key.value === null, JSON.stringify(key.value));
    check(`${label} explains itself to the student`, key.reason === NO_NUMBER_REASON);
  }

  check("the reason names what is missing", /student number/i.test(NO_NUMBER_REASON));
  check("and who can fix it", /office|powerschool/i.test(NO_NUMBER_REASON));
}

console.log("\nThe email key: the one the token actually proves");
{
  check(
    "an address resolves",
    sisEmailKey({ email: "ms10826@westbrookacademy.org" }).value === "ms10826@westbrookacademy.org",
  );
  check(
    "directory casing is normalized, because an index lookup is byte-exact",
    sisEmailKey({ email: " MS10826@WestbrookAcademy.org " }).value === "ms10826@westbrookacademy.org",
  );

  for (const [label, student] of [
    ["a missing email", {}],
    ["an undefined email", { email: undefined }],
    ["a null email", { email: null }],
    ["an empty email", { email: "" }],
    ["a whitespace-only email", { email: "  " }],
  ]) {
    const key = sisEmailKey(student);
    check(`${label} is refused`, key.ok === false, JSON.stringify(key));
    // psRoster.studentEmail is OPTIONAL, so undefined is the value every
    // unkeyed roster row shares. upsertRoster refuses to write "" for this
    // reason; this refuses to read with one.
    check(`${label} yields null, NOT "" or undefined`, key.value === null);
    check(`${label} explains itself to the student`, key.reason === NO_EMAIL_REASON);
  }
}

console.log("\nThe property both keys share");
{
  const SAMPLES = [
    {},
    { studentNumber: "" },
    { studentNumber: "  " },
    { studentNumber: "11095" },
    { legacyId: "11095" },
    { email: "" },
    { email: "a@westbrookacademy.org" },
    { studentNumber: "11095", email: "a@westbrookacademy.org" },
  ];

  check(
    "ok is true only when the value is a usable, non-empty, trimmed string",
    SAMPLES.every((s) =>
      [sisNumberKey(s), sisEmailKey(s)].every((k) =>
        k.ok
          ? typeof k.value === "string" && k.value.length > 0 && k.value === k.value.trim()
          : k.value === null && typeof k.reason === "string" && k.reason.length > 0,
      ),
    ),
  );
  check(
    "a refusal never carries a queryable value",
    SAMPLES.every((s) =>
      [sisNumberKey(s), sisEmailKey(s)].every((k) => k.ok || k.value === null),
    ),
  );
}

// `available` was `currentGrade !== undefined`, WHICH IS TRUE FOR "". An empty
// string is what PowerSchool writes for a section created but not yet graded, so
// the row claimed to have a grade and rendered an empty box where a letter goes.
// An empty box in a grade column does not read as "not graded yet"; it reads as
// a page that failed to load, or as a grade somebody deleted.
console.log("\nA grade cell is available only when there is something to show");
{
  const g = (row) => gradeCell(row);

  check("a letter grade is available", g({ currentGrade: "B+" }).available);
  check("and comes through", g({ currentGrade: "B+" }).currentGrade === "B+");
  check("a percent alone is available", g({ currentPercent: 88.5 }).available);
  check("zero percent is a REAL grade, not a missing one", g({ currentPercent: 0 }).available);
  check("and zero survives as zero", g({ currentPercent: 0 }).currentPercent === 0);

  for (const [label, row] of [
    ["an empty-string grade", { currentGrade: "" }],
    ["a whitespace-only grade", { currentGrade: "   " }],
    ["no fields at all", {}],
    ["explicit undefined", { currentGrade: undefined, currentPercent: undefined }],
    ["explicit null", { currentGrade: null, currentPercent: null }],
    ["a NaN percent from a bad import", { currentPercent: NaN }],
    ["an Infinity percent", { currentPercent: Infinity }],
    ["an empty grade AND a NaN percent", { currentGrade: "", currentPercent: NaN }],
  ]) {
    const cell = g(row);
    check(`${label} is NOT available`, cell.available === false, JSON.stringify(cell));
    check(`${label} reports null, never "" or NaN`, cell.currentGrade === null && cell.currentPercent === null);
  }

  check(
    "an empty grade with a real percent is still available",
    g({ currentGrade: "", currentPercent: 72 }).available,
    "the percent is the thing worth showing",
  );
  check("and the empty letter is nulled out", g({ currentGrade: "", currentPercent: 72 }).currentGrade === null);
  check("a grade is trimmed", g({ currentGrade: "  A  " }).currentGrade === "A");

  // Still an allowlist: it is built field by field from a psGrades row, and
  // psGrades gains columns from an upstream sync nobody here controls.
  const cell = g({ currentGrade: "A", sectionId: "SEC-1", studentNumber: "11095", secret: "x" });
  check("no unexpected column reaches the student", !JSON.stringify(cell).includes("11095"));
  check("nor a section id", !("sectionId" in cell));
  check("nor anything upstream adds later", !JSON.stringify(cell).includes("\"x\""));
  check(
    "the shape is exactly the five fields",
    Object.keys(cell).sort().join() ===
      "available,courseName,courseNumber,currentGrade,currentPercent",
    Object.keys(cell).join(),
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
