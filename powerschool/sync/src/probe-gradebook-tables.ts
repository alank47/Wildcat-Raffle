/**
 * Find the table PowerTeacher Pro actually writes assignments into.
 *
 * Run: see docs/gradebook-sourcing.md for the required `env -u` list.
 *
 * WHY. probe-gradebook.ts found PSM_Assignment and PSM_AssignmentScore both
 * EXIST and both hold ZERO rows, while PSM_AssignmentCategory holds 428. The
 * SIS admin says teachers do enter grades in PowerTeacher. Those two facts
 * cannot both be true of the same tables, so one of the following is:
 *
 *   a) assignments live in a table under a different name,
 *   b) the names probed are exposed stubs and the real data sits in a schema
 *      the table endpoint does not surface (the TEACHERS precedent, where the
 *      endpoint answers 405 and a PowerQuery reads the same columns fine), or
 *   c) teachers enter final percentages directly and never create assignments,
 *      which PGFinalGrades holding 166,495 rows would be consistent with.
 *
 * This separates (a) from the others, cheaply. /count answers WITHOUT a grant
 * and costs one request per name, so a wide sweep is affordable where a column
 * probe would not be.
 *
 * A table that reports a row COUNT is real and populated whatever its
 * permissions say. That is the single fact this file is looking for.
 *
 * GET ONLY. Prints table names and row counts. No student data is read.
 */

import { loadConfig, redactedConfig, type Config } from "./config.ts";
import { PowerSchoolClient } from "./client.ts";

const config: Config = await loadConfig();
const client = new PowerSchoolClient(config);

/** Names worth trying, grouped by the guess behind them. */
const NAMES: Array<[string, string[]]> = [
  ["PowerTeacher Pro, other spellings", [
    "PSM_AssignmentSection", "AssignmentSection", "PSM_SectionAssignment",
    "SectionAssignment", "PSM_AssignmentScoreComment", "PSM_AssignmentStandard",
    "PSM_StandardScore", "PSM_AssignmentSectionStandard",
  ]],
  ["the classic gradebook, other spellings", [
    "Assignment", "AssignmentScore", "AssignmentCategoryAssoc",
    "PGAssignments", "PGCategories", "PGScores", "PGAssignmentScores",
    "GradebookAssignment", "Gradebook_Assignment",
  ]],
  ["section and term grades, which may carry the detail instead", [
    "PSM_SectionGrade", "PSM_TermGrade", "PSM_StudentSectionGrade",
    "SectionGrade", "TermGrade", "StoredGrades", "PGFinalGrades",
  ]],
  ["standards based grading, a separate model entirely", [
    "PSM_StandardGrade", "StandardGrade", "S_GradeScale", "GradeScaleItem",
  ]],
  ["controls: known-good names, to prove the sweep can see data at all", [
    "Students", "Sections", "CC", "Teachers", "PSM_AssignmentCategory",
  ]],
];

console.log(`\nGradebook table sweep  ${new Date().toISOString()}`);
console.log("=".repeat(70));
console.log(`  instance  ${redactedConfig(config).host}`);
console.log(`  one /count request per name. GET only.\n`);

const populated: Array<[string, number]> = [];
const emptyButReal: string[] = [];
const absent: string[] = [];
const other: Array<[string, number]> = [];

for (const [group, names] of NAMES) {
  console.log(`-- ${group}`);
  for (const name of names) {
    const { status, json } = await client.get(`/ws/schema/table/${name}/count`, {});
    const count = typeof json?.count === "number" ? json.count : null;
    if (status === 200 && count !== null) {
      console.log(`   ${String(count).padStart(8)}  ${name}`);
      if (count > 0) populated.push([name, count]);
      else emptyButReal.push(name);
    } else if (status === 404) {
      console.log(`   ${"absent".padStart(8)}  ${name}`);
      absent.push(name);
    } else {
      console.log(`   ${("HTTP " + status).padStart(8)}  ${name}`);
      other.push([name, status]);
    }
  }
  console.log("");
}

console.log("=".repeat(70));
console.log("READING THE RESULT\n");

const interesting = populated.filter(
  ([n]) => !["Students", "Sections", "CC", "Teachers", "PSM_AssignmentCategory", "PGFinalGrades", "StoredGrades"].includes(n),
);

if (interesting.length) {
  console.log("Assignment-shaped tables that hold rows. This is where the data is:");
  for (const [n, c] of interesting) console.log(`  ${n}  (${c} rows)`);
  console.log("\nProbe these for columns next, then grant only what a query needs.");
} else {
  console.log(
    "No assignment-shaped table anywhere holds a row.\n\n" +
    "Combined with PGFinalGrades holding six figures, the reading is (c): teachers\n" +
    "are entering FINAL GRADES in PowerTeacher, not individual assignments. Those\n" +
    "are different actions in the same product, and both are 'using PowerTeacher\n" +
    "to submit grades' in ordinary speech.\n\n" +
    "If that is right, a missing-assignment card has no source and cannot be built\n" +
    "at any permission level. The question for the SIS admin is narrower than\n" +
    "'do teachers use PowerTeacher': it is whether they create assignments inside\n" +
    "a course and score them, or type a percentage per student per term.\n\n" +
    "One caveat this sweep cannot rule out: a table the endpoint does not surface\n" +
    "at all. TEACHERS answers 405 here and reads fine from a PowerQuery. Nothing\n" +
    "below returned 405, so that is unlikely — but the only way to be certain is\n" +
    "a PowerQuery, which needs a plugin re-upload to test.",
  );
}

const closed = other.filter(([, s]) => s === 405);
if (closed.length) {
  console.log(`\n${closed.length} table(s) answered 405, endpoint closed. These may still hold data`);
  console.log(`and would need a PowerQuery to read: ${closed.map(([n]) => n).join(", ")}`);
}

console.log(`\nrequests this run: ${client.requestCount}`);
