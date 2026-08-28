/**
 * Which COLUMNS the gradebook tables actually carry.
 *
 * Run: node --env-file=.env src/probe-assignment-columns.ts
 * (or export PS_CLIENT_ID / PS_CLIENT_SECRET from 1Password and run plainly)
 *
 * WHY A SECOND PROBE. probe-assignments.ts settled which TABLES exist. That is
 * not enough to write an access request with, because PowerSchool's approval
 * screen lists every table AND every field, and an admin asked to approve a
 * field that does not exist has been handed a mistake to find rather than a
 * decision to make.
 *
 * The same status codes separate the two answers, one column at a time:
 *
 *   403  the column EXISTS and is not granted   -> name it in plugin.xml
 *   400  "not valid column for table"           -> this instance does not have
 *                                                  it; guess a different name
 *   200  exists and is already granted          -> nothing to ask for
 *
 * Column names differ between PowerSchool releases far more than table names
 * do, which is exactly why they are measured here instead of copied out of a
 * schema document written for somebody else's instance.
 *
 * READ ONLY. GET only, one column per request, pagesize 1. A 403 or 400 returns
 * no rows at all; the only way a row could come back is a column that is
 * already granted, and the three tables below are granted nothing today.
 */

import { loadConfig, redactedConfig, type Config } from "./config.ts";
import { PowerSchoolClient } from "./client.ts";

const config: Config = await loadConfig();
const client = new PowerSchoolClient(config);

/** What each table is being asked for, and why the card needs it. */
const WANTED: Array<{ table: string; why: string; columns: string[] }> = [
  {
    table: "PSM_ASSIGNMENT",
    why: "The task itself: what it is, what it is out of, when it is due.",
    columns: [
      "id", "sectionid", "name", "description", "duedate",
      "pointspossible", "weight", "extracredit", "iscountedinfinalgrade",
      "assignmentcategoryid", "categoryid", "scoreentrypoints", "publishscores",
    ],
  },
  {
    table: "PSM_ASSIGNMENTSCORE",
    why: "This student's mark on it, and whether it was ever handed in.",
    columns: [
      "id", "assignmentid", "studentid", "scorepoints", "scorepercent",
      "scorelettergrade", "islate", "ismissing", "isexempt", "iscollected",
      "scoreentrydate",
    ],
  },
  {
    table: "PSM_ASSIGNMENTCATEGORY",
    why: "THE WEIGHTS. Without these the card must refuse to project.",
    columns: [
      "id", "sectionid", "name", "abbreviation", "weight",
      "pointspossible", "isweightedbypoints", "defaultscoreentrypoints",
    ],
  },
];

/** A control on each table: a name no schema carries, to prove 400 means 400. */
const CANARY = "wildcat_probe_no_such_column";

async function column(table: string, col: string) {
  const res = await client.get(`/ws/schema/table/${table}`, {
    projection: col,
    pagesize: "1",
  });
  const body = String(res.text ?? "").slice(0, 200).replace(/\s+/g, " ").trim();
  let reading: string;
  if (res.status === 403) reading = "EXISTS, not granted";
  else if (res.status === 200) reading = "already granted";
  else if (res.status === 400 && /not valid column/i.test(body)) reading = "no such column here";
  else reading = `unclassified ${res.status}`;
  return { col, code: res.status, reading, body };
}

console.log(`\nGradebook column probe  ${new Date().toISOString()}`);
console.log("=".repeat(72));
console.log(`  instance   ${redactedConfig(config).host}`);
console.log(`  method     GET, one column per request, pagesize 1.\n`);

const ask: Record<string, string[]> = {};
for (const group of WANTED) {
  console.log(`  ${group.table}`);
  console.log(`  ${"-".repeat(68)}`);
  console.log(`  ${group.why}`);
  const control = await column(group.table, CANARY);
  console.log(`    (control: ${CANARY} -> ${control.code} ${control.reading})\n`);
  ask[group.table] = [];
  for (const col of group.columns) {
    const r = await column(group.table, col);
    const mark = r.reading.startsWith("EXISTS") ? "  ->ASK" : r.reading === "already granted" ? "  have" : "";
    console.log(`    ${col.padEnd(26)} ${String(r.code).padEnd(5)} ${r.reading}${mark}`);
    if (r.reading.startsWith("EXISTS") || r.reading === "already granted") ask[group.table].push(col);
    if (r.reading.startsWith("unclassified")) console.log(`      ${r.body}`);
  }
  console.log("");
}

console.log("=".repeat(72));
console.log(`\n  plugin.xml, ViewOnly. Every name below was measured on this instance:\n`);
for (const [table, cols] of Object.entries(ask)) {
  console.log(`  <field table="${table}" field="${cols[0] ?? "?"}" access="ViewOnly" />`);
  for (const c of cols.slice(1)) {
    console.log(`  <field table="${table}" field="${c}" access="ViewOnly" />`);
  }
  console.log("");
}
