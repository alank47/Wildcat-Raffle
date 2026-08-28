/**
 * Which gradebook this instance runs, and whether we can reach it.
 *
 * Run: node --env-file=.env src/probe-assignments.ts
 *
 * WHAT THIS SETTLES
 *
 * The student grades card shows one row per course out of PGFINALGRADES: a
 * letter, a percent, a last-updated date. The question every student actually
 * asks, "what would raise my grade?", needs the assignments underneath it,
 * and plugin.xml grants zero assignment access today.
 *
 * Before anyone can be asked for a grant, one fact is missing: WHICH GRADEBOOK
 * this instance runs. PowerSchool has shipped two:
 *
 *   ASSIGNMENTS / ASSIGNMENTSCORE          the older gradebook
 *   PSM_ASSIGNMENT / PSM_ASSIGNMENTSCORE   PowerTeacher Pro
 *
 * Asking for all four would be asking for tables that do not exist, which is
 * how an access request comes back with questions instead of an approval.
 *
 * MEASURED 28 AUGUST 2026, and it is not the clean either/or the question
 * assumed: ASSIGNMENTS is ABSENT while ASSIGNMENTSCORE survives it, alongside
 * the full PSM_ set. This instance runs PowerTeacher Pro and carries an orphan
 * remnant of the older gradebook. Full result in docs/sis-gradebook-probe.md,
 * including the finding that matters more than any of this: the join keys are
 * not projectable over this endpoint at any permission level.
 *
 * AND THE WEIGHTS, which are the part that decides whether the feature is
 * honest. A missing summative in a category worth 70% moves a grade far more
 * than a missing homework in one worth 10%. Without the weighting model the
 * card must refuse to project rather than guess, so the category tables are
 * probed with the same weight as the assignment tables, not as a nice-to-have.
 *
 * HOW A TABLE IS TESTED WITHOUT A GRANT. Asking for one deliberately nonsense
 * column separates the two answers that matter, because PowerSchool checks the
 * column name before it checks permission:
 *
 *   400  "not valid column for table: X"  -> the TABLE EXISTS. It named it back
 *                                            to us. A grant is all that is
 *                                            missing, and plugin.xml can fix it.
 *   403  at least one column lacks permission -> the table exists AND the
 *                                            canary somehow resolved. Still a
 *                                            grant question.
 *   404  -> not reachable here. No grant will ever produce it.
 *   405  -> exists, but not exposed over /ws/schema/table at all. Read it
 *           through a PowerQuery instead. NOT a permission gap. (TEACHERS is
 *           the known case in this instance.)
 *
 * A control against a table nobody could have pins down what "missing" looks
 * like on this server, so the reading above is measured rather than assumed.
 *
 * READ ONLY. Every request is a GET, and it inherits the ReadOnlyViolation
 * guard in client.ts, so this file structurally cannot write. Nothing
 * identifiable is fetched: the canary column guarantees no row ever comes back.
 */

import { loadConfig, redactedConfig, type Config } from "./config.ts";
import { PowerSchoolClient } from "./client.ts";

const config: Config = await loadConfig();
const client = new PowerSchoolClient(config);

/** A column name no schema will ever carry. Its whole job is to be rejected. */
const CANARY = "wildcat_probe_no_such_column";

type Verdict = {
  table: string;
  code: number;
  reading: string;
  detail: string;
};

async function probe(table: string): Promise<Verdict> {
  const res = await client.get(`/ws/schema/table/${table}`, {
    "projection": CANARY,
    "pagesize": "1",
  });
  const body = String(res.text ?? "").slice(0, 300).replace(/\s+/g, " ").trim();

  // The 400 is the INFORMATIVE answer, not the failure: PowerSchool can only
  // say "not a valid column for table X" about a table it has.
  let reading: string;
  if (res.status === 400 && /not valid column for table/i.test(body)) {
    reading = "EXISTS, needs a grant";
  } else if (res.status === 400) {
    reading = "400, but not the column message, read the body";
  } else if (res.status === 403) {
    reading = "EXISTS, needs a grant";
  } else if (res.status === 404) {
    reading = "ABSENT from this instance";
  } else if (res.status === 405) {
    reading = "EXISTS but not exposed here, use a PowerQuery";
  } else if (res.status === 200) {
    reading = "200 on a nonsense column, investigate: this should not happen";
  } else {
    reading = `unclassified ${res.status}`;
  }
  return { table, code: res.status, reading, detail: body };
}

console.log(`\nAssignment and gradebook probe  ${new Date().toISOString()}`);
console.log("=".repeat(72));
console.log(`  instance   ${redactedConfig(config).host}`);
console.log(`  method     GET only, one nonsense column per table. No row can return.`);
console.log(`  purpose    Which gradebook model exists, and are the weights reachable.\n`);

// The control first. Everything below is read against what this line proves
// "missing" looks like on this server.
const control = await probe("wildcat_probe_no_such_table");
console.log(`  CONTROL  ${control.table}`);
console.log(`           ${control.code}  ${control.reading}`);
console.log(`           ${control.detail}\n`);

const GROUPS: Array<{ title: string; why: string; tables: string[] }> = [
  {
    title: "Older gradebook",
    why: "One of these two models will exist. Not both.",
    tables: ["ASSIGNMENTS", "ASSIGNMENTSCORE"],
  },
  {
    title: "PowerTeacher Pro gradebook",
    why: "The other candidate.",
    tables: ["PSM_ASSIGNMENT", "PSM_ASSIGNMENTSCORE"],
  },
  {
    title: "Category and weighting",
    why: "Without these the card must refuse to project rather than guess.",
    tables: [
      "PSM_ASSIGNMENTCATEGORY",
      "PSM_SECTIONCATEGORY",
      "ASSIGNMENTCATEGORY",
      "GRADEBOOK_CATEGORY",
      "PGCATEGORIES",
    ],
  },
  {
    title: "Already granted, as a positive control",
    why: "If this does not read as EXISTS, the probe itself is wrong.",
    tables: ["PGFINALGRADES"],
  },
];

const results: Verdict[] = [];
for (const group of GROUPS) {
  console.log(`  ${group.title}`);
  console.log(`  ${"-".repeat(68)}`);
  console.log(`  ${group.why}\n`);
  for (const table of group.tables) {
    const v = await probe(table);
    results.push(v);
    console.log(`    ${v.table.padEnd(26)} ${String(v.code).padEnd(5)} ${v.reading}`);
    if (v.reading.startsWith("unclassified") || v.reading.includes("investigate")) {
      console.log(`      ${v.detail}`);
    }
  }
  console.log("");
}

// ---- what the answer means for the access request -------------------------
const exists = results.filter((r) => r.reading.startsWith("EXISTS"));
const absent = results.filter((r) => r.reading.startsWith("ABSENT"));

console.log("=".repeat(72));
console.log(`\n  ASK FOR (ViewOnly in plugin.xml):`);
console.log(exists.length ? exists.map((r) => `    ${r.table}`).join("\n") : "    nothing, see above");
console.log(`\n  DO NOT ASK FOR (absent from this instance):`);
console.log(absent.length ? absent.map((r) => `    ${r.table}`).join("\n") : "    none");

const haveWeights = exists.some((r) => /CATEG/i.test(r.table));
console.log(`\n  WEIGHTS REACHABLE: ${haveWeights ? "yes" : "NO"}`);
if (!haveWeights) {
  console.log(
    `    No category table answered as present. The grades card must not\n` +
    `    project a ceiling without one: an unweighted guess is wrong the\n` +
    `    first time a category is worth anything other than its share.`,
  );
}
console.log("");
