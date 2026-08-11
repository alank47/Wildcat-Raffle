/**
 * Phase 0. Inventory and confirm. Pulls no bulk data.
 *
 * Run:  npm run probe
 *
 * What it does:
 *   1. Authenticates and reads server metadata.
 *   2. Probes every table and field in the manifest with a one row read.
 *      PowerSchool answers a request for an ungranted field with a 4xx that
 *      names the field, so this is an empirical read of what the plugin was
 *      actually granted rather than a restatement of what we asked for.
 *   3. Confirms each named query is installed and callable.
 *   4. Diffs the result against the manifest.
 *   5. Writes docs/access-gap.md.
 *
 * It stops there. It does not load anything anywhere.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, redactedConfig, productionRisk, type Config } from "./config.ts";
import { PowerSchoolClient } from "./client.ts";
import { MANIFEST, QUERY_PREFIX, type ManifestEntry } from "./manifest.ts";

type FieldVerdict = "granted" | "denied" | "table-missing" | "endpoint-blocked" | "unknown" | "not-probed";

type FieldResult = {
  table: string;
  field: string;
  verdict: FieldVerdict;
  status: number;
  detail: string;
};

type EntryResult = {
  entry: ManifestEntry;
  fields: FieldResult[];
  verdict: "granted" | "partial" | "missing" | "endpoint-blocked" | "unconfirmed";
};

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const OUTPUT_PATH = resolve(REPO_ROOT, "docs", "access-gap.md");

/**
 * A single field probe. One row, one column. Cheapest possible question that
 * distinguishes granted from denied.
 */
async function probeField(
  client: PowerSchoolClient,
  table: string,
  field: string,
): Promise<FieldResult> {
  try {
    const { status, json, text } = await client.get(`/ws/schema/table/${table}`, {
      projection: field,
      pagesize: 1,
    });

    if (status === 200) {
      return { table, field, verdict: "granted", status, detail: "one row read succeeded" };
    }

    const message = extractMessage(json, text);

    if (status === 404) {
      return {
        table,
        field,
        verdict: "table-missing",
        status,
        detail: `table not found in this instance: ${message}`,
      };
    }

    if (status === 405) {
      // PowerSchool closes the table endpoint for some tables (TEACHERS is
      // one) regardless of what the access request grants. This is NOT a
      // denial. The same columns read fine from inside a PowerQuery, which
      // is SQL and never touches this endpoint. Treating it as "missing"
      // produces a false negative that sends someone editing plugin.xml to
      // add access they already have.
      return {
        table,
        field,
        verdict: "endpoint-blocked",
        status,
        detail: `table endpoint not exposed by PowerSchool (${message}). Read this field through a PowerQuery instead.`,
      };
    }

    if (status === 400 || status === 401 || status === 403) {
      return {
        table,
        field,
        verdict: "denied",
        status,
        detail: message,
      };
    }

    return { table, field, verdict: "unknown", status, detail: message };
  } catch (error: unknown) {
    return {
      table,
      field,
      verdict: "unknown",
      status: 0,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractMessage(json: any, text: string): string {
  const candidate =
    json?.message ??
    json?.errorMessage ??
    json?.errors?.[0]?.message ??
    json?.error_description ??
    null;
  const raw = typeof candidate === "string" ? candidate : text;
  return String(raw ?? "").replace(/\s+/g, " ").slice(0, 240) || "no message returned";
}

async function probeEntry(client: PowerSchoolClient, entry: ManifestEntry): Promise<EntryResult> {
  if (entry.probes.length === 0) {
    return { entry, fields: [], verdict: "unconfirmed" };
  }

  const fields: FieldResult[] = [];
  for (const probe of entry.probes) {
    for (const field of probe.fields) {
      fields.push(await probeField(client, probe.table, field));
    }
  }

  const granted = fields.filter((f) => f.verdict === "granted").length;
  const blocked = fields.filter((f) => f.verdict === "endpoint-blocked").length;
  const verdict: EntryResult["verdict"] =
    granted === fields.length
      ? "granted"
      : blocked === fields.length
        ? "endpoint-blocked"
        : granted + blocked === fields.length
          ? "partial"
          : granted === 0
            ? "missing"
            : "partial";

  return { entry, fields, verdict };
}

/**
 * Confirms a named query exists and is callable without pulling a real page.
 * Sends the declared args with pagesize 1. A 404 means the PowerQuery was not
 * shipped in the plugin zip or the plugin was not re-enabled after upload.
 */
async function probeQuery(
  client: PowerSchoolClient,
  config: Config,
  name: string,
  args: Record<string, string | number>,
): Promise<{ name: string; status: string; detail: string }> {
  const missingArgs = Object.entries(args)
    .filter(([, value]) => value === "" || value === undefined || value === null)
    .map(([key]) => key);

  if (missingArgs.length > 0) {
    return {
      name,
      status: "skipped",
      detail: `missing .env values for: ${missingArgs.join(", ")}`,
    };
  }

  try {
    const result = await client.namedQuery(name, args, { maxPages: 1 });
    return {
      name,
      status: "callable",
      detail: `returned ${result.rows.length} row(s) on page 1 in ${result.ms}ms`,
    };
  } catch (error: unknown) {
    return {
      name,
      status: "failed",
      detail: error instanceof Error ? error.message.slice(0, 240) : String(error),
    };
  }
}

function symbol(verdict: string): string {
  if (verdict === "granted" || verdict === "callable") return "YES";
  if (verdict === "partial") return "PARTIAL";
  if (verdict === "unconfirmed") return "UNCONFIRMED";
  if (verdict === "skipped") return "SKIPPED";
  if (verdict === "endpoint-blocked") return "VIA QUERY";
  return "NO";
}

function renderReport(
  config: Config,
  results: EntryResult[],
  queryResults: Array<{ name: string; status: string; detail: string }>,
  metadata: any,
  summary: ReturnType<PowerSchoolClient["summary"]>,
  generatedAt: string,
): string {
  const lines: string[] = [];

  lines.push("# Access gap");
  lines.push("");
  lines.push("Generated by `powerschool/sync/src/probe.ts`. Do not hand edit.");
  lines.push("Re-run with `npm run probe` from `powerschool/sync`.");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Instance: \`${config.host}\``);
  lines.push(`- Production escape hatch: ${config.allowProduction ? "SET" : "not set"}`);
  lines.push(`- Server max page size: ${metadata?.max_page_size ?? "unknown"}`);
  lines.push(`- Requests this run: ${summary.requests} (ceiling ${config.hourlyRequestCeiling})`);
  lines.push("");

  const granted = results.filter((r) => r.verdict === "granted");
  const partial = results.filter((r) => r.verdict === "partial");
  const missing = results.filter((r) => r.verdict === "missing");
  const blocked = results.filter((r) => r.verdict === "endpoint-blocked");
  const unconfirmed = results.filter((r) => r.verdict === "unconfirmed");

  lines.push("## Summary");
  lines.push("");
  lines.push(`- Fully granted: ${granted.length} of ${MANIFEST.length}`);
  lines.push(`- Partially granted: ${partial.length}`);
  lines.push(`- Not granted: ${missing.length}`);
  lines.push(`- Granted but only readable through a PowerQuery: ${blocked.length}`);
  lines.push(`- Source unconfirmed: ${unconfirmed.length}`);
  lines.push("");

  lines.push("## Manifest");
  lines.push("");
  lines.push("| # | Field | Class | Verdict | Notes |");
  lines.push("|---|---|---|---|---|");
  for (const result of results) {
    const notes =
      result.verdict === "unconfirmed"
        ? (result.entry.unconfirmed ?? "source not yet determined")
        : result.fields
            .filter((f) => f.verdict !== "granted")
            .map((f) => `${f.table}.${f.field} ${f.status} ${f.detail}`)
            .join("; ") || "all probes returned 200";
    lines.push(
      `| ${result.entry.n} | ${result.entry.label} | ${result.entry.fieldClass} | ${symbol(result.verdict)} | ${notes.replace(/\|/g, "/")} |`,
    );
  }
  lines.push("");

  lines.push("## Fields missing from the granted access request");
  lines.push("");
  const missingFields = results.flatMap((r) =>
    r.fields.filter((f) => f.verdict === "denied" || f.verdict === "table-missing"),
  );
  const blockedFields = results.flatMap((r) =>
    r.fields.filter((f) => f.verdict === "endpoint-blocked"),
  );
  if (missingFields.length === 0) {
    lines.push("None. Every probed field returned 200.");
  } else {
    lines.push("Add these to `powerschool/plugin/plugin.xml`, bump the plugin version,");
    lines.push("re-upload, and have a PowerSchool admin disable and re-enable the plugin.");
    lines.push("Do this once for the whole list rather than three times.");
    lines.push("");
    for (const field of missingFields) {
      lines.push(`- \`${field.table}.${field.field}\` (${field.status}) ${field.detail}`);
    }
  }
  lines.push("");

  if (blockedFields.length > 0) {
    lines.push("## Fields granted but not readable from the table endpoint");
    lines.push("");
    lines.push("PowerSchool does not expose these tables through `/ws/schema/table/`.");
    lines.push("The access request already covers them and a PowerQuery reads them fine.");
    lines.push("Do NOT add these to `plugin.xml`. They are already granted.");
    lines.push("");
    for (const field of blockedFields) {
      lines.push(`- \`${field.table}.${field.field}\` status ${field.status}`);
    }
    lines.push("");
  }

  lines.push("## Fields whose source is still unconfirmed");
  lines.push("");
  if (unconfirmed.length === 0) {
    lines.push("None.");
  } else {
    for (const result of unconfirmed) {
      lines.push(`### ${result.entry.n}. ${result.entry.label}`);
      lines.push("");
      lines.push(result.entry.unconfirmed ?? "No detail recorded.");
      lines.push("");
    }
    lines.push("These are resolved in Phase 1. See `docs/field-sourcing.md`.");
  }
  lines.push("");

  lines.push("## PowerQuery availability");
  lines.push("");
  lines.push("| Query | Status | Detail |");
  lines.push("|---|---|---|");
  for (const query of queryResults) {
    lines.push(`| \`${query.name}\` | ${symbol(query.status)} | ${query.detail.replace(/\|/g, "/")} |`);
  }
  lines.push("");

  lines.push("## Gate");
  lines.push("");
  lines.push("Phase 0 ends here. Do not start Phase 1 until this list is reviewed");
  lines.push("and the full set of plugin.xml additions is agreed in one pass.");
  lines.push("");

  return lines.join("\n");
}

async function main(): Promise<void> {
  const config = loadConfig();
  const generatedAt = new Date().toISOString();

  console.log("Wildcat Hub PowerSchool access probe (Phase 0)");
  console.log("Config:", redactedConfig(config));

  const risk = productionRisk(config.host);
  if (risk !== null) {
    console.warn(`\nWARNING: ${risk}\n`);
  }

  const client = new PowerSchoolClient(config);
  await client.authenticate();
  const metadata = await client.metadata();

  console.log("\nProbing manifest fields. One row per field, no bulk reads.\n");

  const results: EntryResult[] = [];
  for (const entry of MANIFEST) {
    const result = await probeEntry(client, entry);
    results.push(result);
    console.log(`  ${String(entry.n).padStart(2)}. ${entry.label.padEnd(30)} ${symbol(result.verdict)}`);
  }

  console.log("\nProbing named queries.\n");

  const queryResults = [
    await probeQuery(client, config, `${QUERY_PREFIX}.terms`, {
      schoolid: config.schoolId,
      yearid: config.yearId,
    }),
    await probeQuery(client, config, `${QUERY_PREFIX}.roster`, {
      schoolid: config.schoolId,
      termid: config.termId,
    }),
    await probeQuery(client, config, `${QUERY_PREFIX}.attendance_summary`, {
      schoolid: config.schoolId,
      termid: config.termId,
      yeartermid: config.yearTermId,
    }),
    await probeQuery(client, config, `${QUERY_PREFIX}.grades`, {
      schoolid: config.schoolId,
      termid: config.termId,
      finalgradename: config.finalGradeName,
      storecode: config.storeCode,
    }),
    await probeQuery(client, config, `${QUERY_PREFIX}.staff`, {
      schoolid: config.schoolId,
    }),
    await probeQuery(client, config, `${QUERY_PREFIX}.student_race_restricted`, {
      schoolid: config.schoolId,
    }),
    await probeQuery(client, config, `${QUERY_PREFIX}.student_restricted`, {
      schoolid: config.schoolId,
    }),
  ];

  for (const query of queryResults) {
    console.log(`  ${query.name.padEnd(52)} ${symbol(query.status)}`);
  }

  const summary = client.summary();
  const report = renderReport(config, results, queryResults, metadata, summary, generatedAt);

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, report, "utf8");

  console.log(`\nWrote ${OUTPUT_PATH}`);
  console.log("Run summary:", summary);
  console.log("\nPHASE 0 GATE. Review docs/access-gap.md and confirm before Phase 1.");
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
