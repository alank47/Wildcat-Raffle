/**
 * Columns of the REAL gradebook tables, the ones that hold rows.
 *
 * Run: see docs/gradebook-sourcing.md for the required `env -u` list.
 *
 * WHY THIS IS A THIRD PROBE. The first one asked about PSM_Assignment and
 * PSM_AssignmentScore, found both EXIST and both hold zero rows, and concluded
 * the gradebook was empty. It was asking the wrong tables. The sweep that
 * followed found the data under names that differ by a single letter:
 *
 *     PSM_Assignment          0 rows        Assignment        44,236 rows
 *     PSM_AssignmentScore     0 rows        AssignmentScore 1,374,093 rows
 *     PSM_AssignmentSection   absent        AssignmentSection  79,879 rows
 *
 * The first probe DID try the unprefixed names — as `Assignments` and
 * `AssignmentScores`, plural, which both 404. Singular is correct. A plural is
 * the whole distance between "this school does not use assignments" and 1.37
 * million scores.
 *
 * The lesson worth keeping: a 0-row count on a table that exists is not
 * evidence that a school does not do the thing. It is evidence about that
 * table. Ask what else could hold it before reporting an absence.
 *
 * GET ONLY. Prints column names and HTTP codes. Reads no scores.
 */

import { loadConfig, redactedConfig, type Config } from "./config.ts";
import { PowerSchoolClient } from "./client.ts";

const config: Config = await loadConfig();
const client = new PowerSchoolClient(config);

const TABLES: Array<{ table: string; why: string; columns: string[] }> = [
  {
    table: "AssignmentScore",
    why: "WHOSE it is, and whether it is missing — 1,374,093 rows",
    columns: [
      "id", "dcid", "assignmentsectionid", "studentid", "studentsdcid",
      "scorepoints", "scorepercent", "scorelettergrade", "scoreentrydate",
      "ismissing", "islate", "isexempt", "isabsent", "iscollected",
      "whomodifiedid", "whenmodified",
    ],
  },
  {
    table: "AssignmentSection",
    why: "the bridge to a section, and what the work is worth — 79,879 rows",
    columns: [
      "id", "dcid", "assignmentid", "sectionid", "sectionsdcid",
      "pointspossible", "duedate", "weight", "extracreditpoints",
      "iscountedinfinalgrade", "isscoringneeded", "scoretype",
      "publishscores", "publishstate", "name", "description", "yearid",
    ],
  },
  {
    table: "Assignment",
    why: "WHAT the assignment is — 44,236 rows",
    columns: [
      "id", "dcid", "name", "abbreviation", "description",
      "assignmentcategoryid", "categoryid", "sectionid", "pointspossible",
      "duedate", "yearid",
    ],
  },
  {
    table: "AssignmentCategoryAssoc",
    why: "which category the work belongs to — 79,879 rows",
    columns: [
      "id", "dcid", "assignmentsectionid", "assignmentcategoryid",
      "teachercategoryid",
    ],
  },
  {
    table: "PSM_AssignmentCategory",
    why: "the category names — 428 rows, already known to exist",
    columns: ["id", "name", "abbreviation", "weight", "gradebooktype"],
  },
  {
    // The half that decides HOW MUCH a missing assignment costs. If none of
    // these carries a weight, a projection can only be offered for a
    // total-points gradebook and must refuse for a weighted one.
    table: "TeacherCategory",
    why: "candidate home for category weights",
    columns: ["id", "dcid", "name", "weight", "sectionid", "teacherid"],
  },
  {
    table: "SectionGradeWeight",
    why: "candidate home for the section's calculation type",
    columns: ["id", "sectionid", "weight", "type"],
  },
  {
    table: "GradeCalculationType",
    why: "candidate home for total-points versus weighted",
    columns: ["id", "sectionid", "type", "calculationtype"],
  },
  {
    table: "GradeCalcSchoolAssoc",
    why: "another candidate for the calculation setup",
    columns: ["id", "sectionid", "gradecalculationtypeid"],
  },
];

function message(json: any, text: string): string {
  const c = json?.message ?? json?.errorMessage ?? json?.errors?.[0]?.message ?? null;
  return String((typeof c === "string" ? c : text) ?? "").replace(/\s+/g, " ").slice(0, 120) || "no message";
}

console.log(`\nGradebook column probe  ${new Date().toISOString()}`);
console.log("=".repeat(74));
console.log(`  instance  ${redactedConfig(config).host}`);
console.log(`  GET only. Column names and status codes; no scores are read.\n`);

const grantable: Record<string, string[]> = {};

for (const t of TABLES) {
  const { status: cs, json: cj } = await client.get(`/ws/schema/table/${t.table}/count`, {});
  const count = typeof cj?.count === "number" ? cj.count : null;
  if (cs === 404) {
    console.log(`${t.table}  —  no such table\n`);
    continue;
  }
  console.log(`${t.table}  —  ${count ?? "?"} rows`);
  console.log(`  ${t.why}`);
  const ok: string[] = [];
  for (const col of t.columns) {
    const { status, json, text } = await client.get(`/ws/schema/table/${t.table}`, {
      projection: col,
      pagesize: 1,
    });
    const verdict =
      status === 200 ? "GRANTED        " :
      status === 403 ? "EXISTS/no grant" :
      status === 400 ? "no such column " :
      status === 405 ? "endpoint closed" : `HTTP ${status}`;
    if (status === 200 || status === 403) ok.push(col);
    console.log(`    ${verdict}  ${col}${status === 200 || status === 403 ? "" : `  (${message(json, text)})`}`);
  }
  if (ok.length) grantable[t.table] = ok;
  console.log("");
}

console.log("=".repeat(74));
console.log("CONFIRMED, SAFE TO PUT IN plugin.xml\n");
console.log("Every name below answered 200 or 403, which is this repo's standard of");
console.log("proof that a column exists. Nothing on a 400 is listed.\n");
for (const [table, cols] of Object.entries(grantable)) {
  console.log(`  ${table}`);
  for (const c of cols) console.log(`      ${c}`);
}
console.log(`\nrequests this run: ${client.requestCount}`);
