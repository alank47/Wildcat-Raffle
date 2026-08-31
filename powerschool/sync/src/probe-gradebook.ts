/**
 * Where the gradebook actually lives, and which of its columns exist.
 *
 * Run: op run --env-file=.env -- node src/probe-gradebook.ts
 *      (the .env holds 1Password references, so a plain --env-file passes the
 *       literal "op://..." string as the password and every call 401s)
 *
 * WHY THIS EXISTS. A previous probe read PSM_ASSIGNMENTSCORE through the table
 * endpoint, got 400 on the student and assignment key columns, and concluded
 * the gradebook cannot be joined to a student at all. That conclusion does not
 * follow, for a reason this repo has already written down twice:
 *
 *   1. plugin.xml grants ZERO gradebook fields. Every PSM_ table is outside the
 *      access request entirely. The 400-versus-403 rule that the rest of this
 *      tooling relies on was established for tables INSIDE the grant, and it is
 *      not established that an ungranted table reports a real column as 403
 *      rather than 400.
 *   2. docs/access-gap.md already records the table endpoint lying about a
 *      table that is fine: TEACHERS answers 405 there, and the report says in
 *      as many words that a PowerQuery reads those columns without trouble.
 *      probe.ts:75 carries the same warning.
 *
 * So this probe does not trust one signal. For every candidate it collects:
 *
 *   - /count      Does the table EXIST? This endpoint answers without a grant,
 *                 which is how the behavior model was settled on 2026-08-12
 *                 (log 16,987 rows against incident 13). A count is the only
 *                 question here that a missing grant cannot muddy.
 *   - projection  Per column: 200 granted, 403 exists-but-not-granted,
 *                 400 no-such-column, 405 endpoint-closed-for-this-table.
 *
 * A table that counts rows but 400s every column is the signature of "not
 * granted", NOT of "no such column", and the report says so rather than
 * repeating the earlier mistake.
 *
 * GET ONLY. Nothing here writes. It prints column names, HTTP codes and row
 * counts — never a score, never a student.
 */

import { loadConfig, redactedConfig, type Config } from "./config.ts";
import { PowerSchoolClient } from "./client.ts";

const config: Config = await loadConfig();
const client = new PowerSchoolClient(config);

/**
 * The three facts a missing-work card needs, and the tables that could hold
 * them. PowerSchool ships two generations of gradebook and a school uses one:
 * PowerTeacher Pro writes the PSM_ tables, the classic gradebook writes the
 * unprefixed ones. Both are probed because which one is live is exactly what
 * is unknown, and guessing is what took the plugin down at 1.1.0.
 */
const CANDIDATES: Array<{ table: string; why: string; columns: string[] }> = [
  {
    table: "PSM_AssignmentScore",
    why: "WHOSE it is, and whether it is missing",
    columns: [
      "id", "dcid", "assignmentsectionid", "studentsdcid", "studentid",
      "scorepoints", "scorepercent", "scorelettergrade",
      "ismissing", "islate", "isexempt", "isabsent", "iscollected",
    ],
  },
  {
    table: "PSM_AssignmentSection",
    why: "the bridge from a score to a section, and what it is worth",
    columns: [
      "id", "dcid", "assignmentid", "sectionsdcid", "sectionid",
      "pointspossible", "duedate", "weight", "extracreditpoints",
      "iscountedinfinalgrade", "assignmentcategoryid",
    ],
  },
  {
    table: "PSM_Assignment",
    why: "WHAT the assignment is",
    columns: [
      "id", "dcid", "name", "abbreviation", "description",
      "assignmentcategoryid", "pointspossible", "duedate",
    ],
  },
  {
    table: "PSM_AssignmentCategory",
    why: "which category an assignment belongs to",
    columns: ["id", "dcid", "name", "abbreviation", "defaultpointspossible"],
  },
  {
    // The weighting tables are the half that decides HOW MUCH a missing
    // assignment costs. Without them a projection can only be offered for a
    // total-points gradebook, and must refuse rather than guess for a weighted
    // one. Several spellings exist across PowerSchool versions.
    table: "PSM_SectionGradeWeighting",
    why: "total-points versus category-weighted, per section",
    columns: ["id", "dcid", "sectionsdcid", "gradecalculationtype", "termid"],
  },
  {
    table: "PSM_CategoryWeighting",
    why: "the weight each category carries",
    columns: ["id", "dcid", "sectionsdcid", "assignmentcategoryid", "weight", "percentweight"],
  },
  {
    table: "PSM_TermWeighting",
    why: "how terms roll into a final grade",
    columns: ["id", "dcid", "sectionsdcid", "termid", "weight"],
  },
  {
    table: "PSM_SectionGradeCalcFormula",
    why: "an alternative spelling for the calculation type",
    columns: ["id", "dcid", "sectionsdcid", "calculationtype"],
  },
  // ---- the classic (pre PowerTeacher Pro) gradebook ------------------------
  {
    table: "Assignments",
    why: "classic gradebook: the assignment",
    columns: ["id", "sectionid", "name", "pointspossible", "duedate", "categoryid"],
  },
  {
    table: "AssignmentScores",
    why: "classic gradebook: the score, and whether it carries a student key",
    columns: ["id", "assignmentid", "studentid", "points", "percent", "islate", "isexempt", "ismissing"],
  },
  {
    table: "AssignmentCategory",
    why: "classic gradebook: the category and its weight",
    columns: ["id", "sectionid", "name", "weight", "pointspossible"],
  },
  {
    table: "Gradebook",
    why: "named on the off chance this instance uses it",
    columns: ["id", "sectionid"],
  },
];

type ColumnResult = { column: string; status: number; message: string };
type TableResult = {
  table: string;
  why: string;
  exists: boolean | null;
  count: number | null;
  countStatus: number;
  columns: ColumnResult[];
};

function message(json: any, text: string): string {
  const c =
    json?.message ?? json?.errorMessage ?? json?.errors?.[0]?.message ??
    json?.error_description ?? null;
  return String((typeof c === "string" ? c : text) ?? "")
    .replace(/\s+/g, " ")
    .slice(0, 150) || "no message";
}

/** Does the table exist? /count answers without needing a grant. */
async function tableCount(table: string): Promise<{ exists: boolean | null; count: number | null; status: number }> {
  const { status, json, text } = await client.get(`/ws/schema/table/${table}/count`, {});
  if (status === 200) {
    const n = json?.count ?? json?.tables?.count ?? null;
    return { exists: true, count: typeof n === "number" ? n : null, status };
  }
  // 404 is the clear "no such table". Anything else is inconclusive: the
  // endpoint may be closed for this table while the table itself is fine.
  if (status === 404) return { exists: false, count: null, status };
  return { exists: null, count: null, status };
}

async function probeColumn(table: string, column: string): Promise<ColumnResult> {
  const { status, json, text } = await client.get(`/ws/schema/table/${table}`, {
    projection: column,
    pagesize: 1,
  });
  return { column, status, message: status === 200 ? "read one row" : message(json, text) };
}

const risk = redactedConfig(config);
console.log(`\nGradebook discovery probe  ${new Date().toISOString()}`);
console.log("=".repeat(72));
console.log(`  instance   ${risk.host}`);
console.log(`  GET only. No writes anywhere in this file.\n`);

const results: TableResult[] = [];

for (const candidate of CANDIDATES) {
  const { exists, count, status } = await tableCount(candidate.table);
  const columns: ColumnResult[] = [];
  // Probing every column of a table that reported 404 is a waste of the request
  // ceiling and tells us nothing new.
  if (exists !== false) {
    for (const column of candidate.columns) {
      columns.push(await probeColumn(candidate.table, column));
    }
  }
  results.push({ table: candidate.table, why: candidate.why, exists, count, countStatus: status, columns });

  const head = exists === true ? `EXISTS (${count ?? "?"} rows)`
    : exists === false ? "no such table"
    : `count inconclusive (HTTP ${status})`;
  console.log(`${candidate.table}  —  ${head}`);
  console.log(`  purpose: ${candidate.why}`);
  for (const c of columns) {
    const verdict =
      c.status === 200 ? "GRANTED       " :
      c.status === 403 ? "EXISTS/no grant" :
      c.status === 400 ? "no such column" :
      c.status === 405 ? "endpoint closed" :
      `HTTP ${c.status}`;
    console.log(`    ${verdict}  ${c.column}${c.status === 200 || c.status === 403 ? "" : `  (${c.message})`}`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// The read of it, stated rather than left for someone to infer.
// ---------------------------------------------------------------------------
console.log("=".repeat(72));
console.log("READING THE RESULT\n");

for (const r of results) {
  if (r.exists === false) continue;
  const granted = r.columns.filter((c) => c.status === 200).length;
  const needsGrant = r.columns.filter((c) => c.status === 403).length;
  const absent = r.columns.filter((c) => c.status === 400).length;
  const closed = r.columns.filter((c) => c.status === 405).length;

  if (closed > 0) {
    console.log(
      `${r.table}: the table endpoint is CLOSED (405). This says nothing about the\n` +
      `  columns. TEACHERS behaves the same way and reads fine from a PowerQuery.\n` +
      `  Add the fields to plugin.xml and read them through a query, not this endpoint.`);
  } else if (r.exists === true && granted === 0 && needsGrant === 0 && absent === r.columns.length) {
    console.log(
      `${r.table}: the table EXISTS and has ${r.count ?? "?"} rows, but every column\n` +
      `  answered 400. With no PSM_ grant anywhere in plugin.xml this is the\n` +
      `  signature of an ungranted table, NOT proof the columns are absent.\n` +
      `  Grant a small number of them, re-upload the plugin, and re-run this.`);
  } else if (needsGrant > 0) {
    console.log(
      `${r.table}: ${needsGrant} column(s) answered 403 — they EXIST and are simply\n` +
      `  not granted. These are safe to add to plugin.xml: 403 is the confirmation\n` +
      `  this repo requires before a field is written into the access request.`);
    console.log(`    ${r.columns.filter((c) => c.status === 403).map((c) => c.column).join(", ")}`);
  } else if (granted > 0) {
    console.log(`${r.table}: ${granted} column(s) already granted and readable.`);
  }
  console.log("");
}

console.log(`requests this run: ${client.requestCount}`);
console.log(
  "\nNOTHING GOES INTO plugin.xml ON A 400. A guessed column got 1.1.0 rejected\n" +
  "and took the sync down; plugin.xml records that every field there was\n" +
  "confirmed to exist first. 403 is a confirmation. 400 is not.\n");
