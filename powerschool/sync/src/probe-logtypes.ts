/**
 * The one request nobody tried.
 *
 * Run: node --env-file=.env src/probe-logtypes.ts
 *
 * WHAT THIS SETTLES
 *
 * The behavior work needs the school's log type vocabulary: the integers in
 * LOG.LogTypeID and what each one means. That vocabulary is currently blank,
 * and it was written off on inference rather than measurement.
 *
 * What was actually measured before was q=logtypeid=ge=2020-01-01 answering 400
 * on the value type. That proves only that the column exists and is numeric,
 * because the type check runs before the permission check. It does not prove the
 * column is unreadable.
 *
 * The untried request is a plain GET with an equality filter:
 *
 *     GET /ws/schema/table/log/count?q=logtypeid==<n>
 *
 * If it answers 403, the vocabulary genuinely needs the amended access request
 * and the current plan is right.
 *
 * If it answers 200, the entire vocabulary and its usage counts are enumerable
 * TODAY by sweeping candidate integers: no SIS administrator, no plugin bump,
 * no schema change. That would unblock the headline deliverable immediately.
 *
 * READ ONLY. Every request here is a GET. There is no code path in this file
 * that can write, and the count endpoint returns an integer, never a student
 * record, so nothing identifiable is fetched or logged.
 */

import { loadConfig, redactedConfig, type Config } from "./config.ts";
import { PowerSchoolClient } from "./client.ts";

const config: Config = await loadConfig();
const client = new PowerSchoolClient(config);

console.log(`\nLog type probe  ${new Date().toISOString()}`);
console.log("=".repeat(66));
console.log(`  instance   ${redactedConfig(config).host}`);
console.log(`  method     GET only. The count endpoint returns an integer.\n`);

/** GET a path and report the status without throwing on a non 200. */
async function status(path: string, query: Record<string, string> = {}) {
  const res = await client.get(path, query);
  const body = String(res.text ?? "").slice(0, 200).replace(/\s+/g, " ").trim();
  return { code: res.status, body, json: res.json };
}

// ---- control: does the unfiltered count still answer? ---------------------
const unfiltered = await status("/ws/schema/table/log/count");
console.log(`  control   GET /ws/schema/table/log/count`);
console.log(`            ${unfiltered.code}  ${unfiltered.body}\n`);

// ---- the question: does an equality filter on LogTypeID pass? -------------
const filtered = await status("/ws/schema/table/log/count", { q: "logtypeid==1" });
console.log(`  THE TEST  GET /ws/schema/table/log/count?q=logtypeid==1`);
console.log(`            ${filtered.code}  ${filtered.body}\n`);

// ---- siblings, for comparison. These are documented as answering 403. -----
const siblings = ["schoolid==1", "entry_date=ge=2026-01-01"];
for (const q of siblings) {
  const r = await status("/ws/schema/table/log/count", { q });
  console.log(`  sibling   q=${q}  ->  ${r.code}`);
}

console.log("\n" + "=".repeat(66));
if (filtered.code === 200) {
  console.log("  200. The filter is ACCEPTED.");
  console.log("  The log type vocabulary is enumerable today by sweeping integers,");
  console.log("  with no administrator and no plugin change. Sweeping now.\n");

  const found: Array<{ id: number; count: number }> = [];
  for (let id = 1; id <= 40; id++) {
    const r = await status("/ws/schema/table/log/count", { q: `logtypeid==${id}` });
    if (r.code !== 200) {
      console.log(`    logtypeid ${id}: ${r.code}, stopping the sweep`);
      break;
    }
    const n = Number(r.json?.count ?? 0);
    if (n > 0) {
      found.push({ id, count: n });
      console.log(`    logtypeid ${String(id).padStart(3)}  ${String(n).padStart(6)} entries`);
    }
  }
  const total = found.reduce((sum, f) => sum + f.count, 0);
  console.log(`\n  ${found.length} log types in use, ${total} entries accounted for.`);
  console.log("  Names still need GEN, which needs the access request. The IDs and");
  console.log("  their volumes do not.");
} else {
  console.log(`  ${filtered.code}. The filter is REFUSED, which is what was expected.`);
  console.log("  The vocabulary genuinely needs the 1.1.0 access request. The current");
  console.log("  plan is correct and this closes the question by measurement rather");
  console.log("  than by inference.");
}
console.log(`\n  requests this run: ${client.summary().requests}\n`);
