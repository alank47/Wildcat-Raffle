/**
 * Phase 2 acceptance run. Executes each PowerQuery and prints one redacted
 * sample payload per query, plus row count and elapsed time.
 *
 * Run:  npm run queries              runs every query
 *       npm run queries -- terms     runs one query by short name
 *
 * This writes nothing to any database. It reads, counts, and shows a sample.
 * Loading into staging is Phase 3 and is deliberately not implemented here.
 */

import { loadConfig, redactedConfig, type Config } from "./config.ts";
import { PowerSchoolClient } from "./client.ts";
import { QUERY_PREFIX } from "./manifest.ts";
import { redactSample } from "./redact.ts";

type QuerySpec = {
  short: string;
  name: string;
  args: (config: Config) => Record<string, string | number>;
  /** Manifest numbers this query is responsible for. */
  covers: number[];
  restricted: boolean;
};

const QUERIES: QuerySpec[] = [
  {
    short: "terms",
    name: `${QUERY_PREFIX}.terms`,
    args: (c) => ({ schoolid: c.schoolId, yearid: c.yearId }),
    covers: [],
    restricted: false,
  },
  {
    short: "roster",
    name: `${QUERY_PREFIX}.roster`,
    args: (c) => ({ schoolid: c.schoolId, termid: c.termId }),
    covers: [1, 2, 3, 4, 5, 6, 9],
    restricted: false,
  },
  {
    short: "attendance",
    name: `${QUERY_PREFIX}.attendance_summary`,
    args: (c) => ({ schoolid: c.schoolId, termid: c.termId, yeartermid: c.yearTermId }),
    covers: [10],
    restricted: false,
  },
  {
    short: "grades",
    name: `${QUERY_PREFIX}.grades`,
    args: (c) => ({
      schoolid: c.schoolId,
      termid: c.termId,
      finalgradename: c.finalGradeName,
      storecode: c.storeCode,
    }),
    covers: [11],
    restricted: false,
  },
  {
    short: "staff",
    name: `${QUERY_PREFIX}.staff`,
    args: (c) => ({ schoolid: c.schoolId }),
    covers: [15, 16, 17, 18],
    restricted: false,
  },
  {
    short: "race",
    name: `${QUERY_PREFIX}.student_race_restricted`,
    args: (c) => ({ schoolid: c.schoolId }),
    covers: [8],
    restricted: true,
  },
  {
    short: "restricted",
    name: `${QUERY_PREFIX}.student_restricted`,
    args: (c) => ({ schoolid: c.schoolId }),
    covers: [7, 14],
    restricted: true,
  },
];

/** Checks the brief's specific acceptance criteria rather than just "it ran". */
function assertions(short: string, rows: any[]): string[] {
  const notes: string[] = [];

  if (rows.length === 0) {
    notes.push("FAIL: zero rows returned. Check schoolid and termid in .env.");
    return notes;
  }

  if (short === "grades") {
    const zeroPercent = rows.filter((r) => Number(r.current_percent) === 0).length;
    const nullPercent = rows.filter((r) => r.current_percent === null || r.current_percent === "").length;
    const noSource = rows.filter((r) => r.grade_source === "NONE").length;
    notes.push(`grade_source NONE: ${noSource} row(s). These are a known gap, not a zero.`);
    notes.push(`current_percent literally 0: ${zeroPercent} row(s). Confirm each is a real 0.`);
    notes.push(`current_percent null: ${nullPercent} row(s). Must render as not available.`);
  }

  if (short === "race") {
    const byStudent = new Map<string, number>();
    for (const row of rows) {
      const key = String(row.student_id);
      byStudent.set(key, (byStudent.get(key) ?? 0) + 1);
    }
    const multi = [...byStudent.values()].filter((count) => count > 1).length;
    notes.push(`students with more than one race code: ${multi}.`);
    if (multi === 0) {
      notes.push("WARN: no multi race students found. Verify against the SIS before trusting this.");
    }
  }

  if (short === "roster") {
    // SECTIONMEETING does not exist in this instance, so there is no
    // meeting_count column to read. Period structure is derived from the
    // EXPRESSION string instead: "3(A-E)" is one period meeting days A to E,
    // "1,2(A-E)" or "3(A-E),4(A-E)" is a multi period block.
    let single = 0;
    let multi = 0;
    let noExpression = 0;
    for (const row of rows) {
      const expression = String(row.section_expression ?? row.cc_expression ?? "").trim();
      if (expression === "") {
        noExpression += 1;
        continue;
      }
      const periods = expression.split(",").filter((part) => part.trim() !== "").length;
      if (periods > 1) multi += 1;
      else single += 1;
    }
    notes.push(
      `sections meeting one period: ${single}, multi period: ${multi}, no expression: ${noExpression}.`,
    );
    if (multi === 0) {
      notes.push("WARN: no multi period or alternating day section in this sample. Phase 4 needs one.");
    }
    if (noExpression > 0) {
      notes.push("WARN: rows with no EXPRESSION cannot yield a period. Period must render as not available.");
    }
    const missingTeacher = rows.filter((r) => !r.teacher_email).length;
    notes.push(`rows with no teacher email: ${missingTeacher}.`);
  }

  if (short === "attendance") {
    const negative = rows.filter((r) => Number(r.days_absent_term) < 0).length;
    const termOverYtd = rows.filter(
      (r) => Number(r.days_absent_term) > Number(r.days_absent_ytd),
    ).length;
    notes.push(`negative days_absent_term: ${negative} (must be 0).`);
    notes.push(`term absences exceeding YTD: ${termOverYtd} (must be 0).`);
  }

  if (short === "staff") {
    const wrongDomain = rows.filter(
      (r) => r.email_addr && !String(r.email_addr).toLowerCase().endsWith("@lapromisefund.org"),
    ).length;
    notes.push(`staff emails outside @lapromisefund.org: ${wrongDomain}.`);
  }

  return notes;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));

  const selected =
    requested.length === 0 ? QUERIES : QUERIES.filter((q) => requested.includes(q.short));

  if (selected.length === 0) {
    throw new Error(
      `No query matched "${requested.join(", ")}". Known: ${QUERIES.map((q) => q.short).join(", ")}`,
    );
  }

  console.log("Wildcat Hub PowerSchool query run (Phase 2)");
  console.log("Config:", redactedConfig(config));
  console.log("");

  const client = new PowerSchoolClient(config);
  await client.authenticate();

  for (const spec of selected) {
    const args = spec.args(config);
    const missing = Object.entries(args)
      .filter(([, value]) => value === "" || value === undefined || value === null)
      .map(([key]) => key);

    console.log(`\n=== ${spec.short} (${spec.name}) ===`);
    if (spec.covers.length > 0) {
      console.log(`Covers manifest fields: ${spec.covers.join(", ")}`);
    }
    if (spec.restricted) {
      console.log("RESTRICTED query. Output is redacted and must not be pasted anywhere.");
    }

    if (missing.length > 0) {
      console.log(`SKIPPED. Missing .env values: ${missing.join(", ")}`);
      continue;
    }

    try {
      const { rows, pages, ms } = await client.namedQuery(spec.name, args);
      console.log(`rows=${rows.length} pages=${pages} elapsed=${ms}ms`);

      for (const note of assertions(spec.short, rows)) {
        console.log(`  - ${note}`);
      }

      console.log("Sample payload (redacted):");
      console.log(JSON.stringify(redactSample(rows, 1), null, 2));
    } catch (error: unknown) {
      console.log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log("\nRun summary:", client.summary());
  console.log("\nPHASE 2 GATE. Review the samples above before Phase 3.");
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
