/**
 * The missing middle of the PowerTeacher Pro gradebook.
 *
 * Run: node --env-file=.env src/probe-gradebook-shape.ts
 *
 * WHY A THIRD PROBE, and it is the one that matters.
 *
 * probe-assignment-columns.ts came back with a score table that has no student
 * and no score: `studentid`, `scorepoints`, `scorepercent` and `assignmentid`
 * all answered 400 "not a valid column", while `id` and `ismissing` answered
 * 403. A score table cannot be missing the score. Either the endpoint hides
 * them, or the schema is not shaped the way the request assumed.
 *
 * It is the second one. PowerTeacher Pro splits an assignment across THREE
 * tables, not two:
 *
 *   PSM_ASSIGNMENT          the assignment as a teacher wrote it: name,
 *                           description, category.
 *   PSM_ASSIGNMENTSECTION   the same assignment AS GIVEN TO ONE SECTION: the
 *                           due date, the points possible, the weight. A
 *                           teacher who gives the same task to three periods
 *                           has one assignment and three of these.
 *   PSM_ASSIGNMENTSCORE     one student's mark, hung off the SECTION row, not
 *                           off the assignment.
 *
 * That middle table was not in the access request at all, which is why the two
 * ends looked broken. Without it there is no due date, no points possible, no
 * section link, and no way to join a score to a course. The feature is not
 * buildable without it and neither is a correct plugin.xml.
 *
 * This probe measures the middle table and re-asks the two ends with the names
 * that shape implies, plus every plausible home for the category WEIGHT, which
 * answered 400 on PSM_ASSIGNMENTCATEGORY and therefore lives somewhere else.
 *
 * READ ONLY. GET only, one column per request, pagesize 1.
 */

import { loadConfig, redactedConfig, type Config } from "./config.ts";
import { PowerSchoolClient } from "./client.ts";

const config: Config = await loadConfig();
const client = new PowerSchoolClient(config);
const CANARY = "wildcat_probe_no_such_column";

async function ask(table: string, col: string) {
  const res = await client.get(`/ws/schema/table/${table}`, { projection: col, pagesize: "1" });
  const body = String(res.text ?? "").slice(0, 160).replace(/\s+/g, " ").trim();
  if (res.status === 403) return { code: 403, reading: "EXISTS, not granted" };
  if (res.status === 200) return { code: 200, reading: "already granted" };
  if (res.status === 404) return { code: 404, reading: "TABLE ABSENT" };
  if (res.status === 400 && /not valid column/i.test(body)) return { code: 400, reading: "no such column" };
  return { code: res.status, reading: `unclassified: ${body}` };
}

console.log(`\nGradebook shape probe  ${new Date().toISOString()}`);
console.log("=".repeat(72));
console.log(`  instance   ${redactedConfig(config).host}\n`);

// ---- 1. Does the middle table exist at all? -------------------------------
console.log("  1. The middle table the request was missing");
console.log("  " + "-".repeat(68));
for (const t of ["PSM_ASSIGNMENTSECTION", "PSM_SECTION", "PSM_ASSIGNMENTSCORECOMMENT"]) {
  const r = await ask(t, CANARY);
  console.log(`    ${t.padEnd(30)} ${String(r.code).padEnd(5)} ${r.code === 400 ? "TABLE EXISTS" : r.reading}`);
}
console.log("");

// ---- 2. Its columns, and the two ends re-asked -----------------------------
const SWEEP: Array<{ table: string; note: string; columns: string[] }> = [
  {
    table: "PSM_ASSIGNMENTSECTION",
    note: "due date, points possible, weight, and the section link",
    columns: [
      "id", "assignmentid", "sectionid", "duedate", "pointspossible", "weight",
      "extracreditpoints", "iscountedinfinalgrade", "isscorespublish",
      "scoreentrypoints", "name", "description", "assignmentcategoryid",
      "sectionsdcid", "totalpointvalue",
    ],
  },
  {
    table: "PSM_ASSIGNMENTSCORE",
    note: "re-asked against the section-row shape",
    columns: [
      "assignmentsectionid", "studentsdcid", "studentsectionenrollmentid",
      "scorepoints", "score", "points", "actualscoreentered", "scoreletter",
      "percent", "islate", "isexempt", "iscollected", "lastmodified",
    ],
  },
  {
    table: "PSM_ASSIGNMENTCATEGORY",
    note: "the weight was NOT here; confirm what is",
    columns: ["assignmentcategoryid", "categoryweight", "defaultpointspossible", "isactive", "sortorder"],
  },
];

for (const g of SWEEP) {
  console.log(`  2. ${g.table}  (${g.note})`);
  console.log("  " + "-".repeat(68));
  const control = await ask(g.table, CANARY);
  if (control.code === 404) { console.log(`    TABLE ABSENT, nothing to ask for.\n`); continue; }
  for (const c of g.columns) {
    const r = await ask(g.table, c);
    console.log(`    ${c.padEnd(30)} ${String(r.code).padEnd(5)} ${r.reading}${r.code === 403 ? "  ->ASK" : ""}`);
  }
  console.log("");
}

// ---- 3. Where the category weight actually lives ---------------------------
console.log("  3. Candidate homes for the category weight");
console.log("  " + "-".repeat(68));
console.log("  Without one of these the card must refuse to project a ceiling.\n");
const WEIGHT_TABLES = [
  "PSM_SECTIONSCORECONFIG",
  "PSM_CATEGORYWEIGHT",
  "PSM_SECTIONCATEGORYWEIGHT",
  "PSM_TERMBIN",
  "PSM_SECTIONTERMWEIGHT",
  "PSM_SCORECONFIG",
];
for (const t of WEIGHT_TABLES) {
  const r = await ask(t, CANARY);
  const verdict = r.code === 400 ? "TABLE EXISTS  <- probe its columns next" : r.reading;
  console.log(`    ${t.padEnd(30)} ${String(r.code).padEnd(5)} ${verdict}`);
}
console.log("");
