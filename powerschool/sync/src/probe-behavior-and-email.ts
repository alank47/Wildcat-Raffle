/**
 * Post 1.1.1 verification. Three questions, one pass, GET only.
 *
 * Run: node --env-file=.env src/probe-behavior-and-email.ts
 *
 *   1. Did the two behavior PowerQueries register? A query that installs but
 *      does not register answers 404 forever and reports nothing about why.
 *   2. What are the REAL log type ids? The first sweep guessed 1 to 40 and found
 *      nothing against an unfiltered count of 16,987, which says the guess was
 *      wrong, not that the data is missing. Read the values instead of guessing.
 *   3. Where does student email actually live? docs/access-gap.md proved
 *      U_StudentsUserFields and StudentCoreFields EXIST (403, not 400) and that
 *      `student_email` is not their column name. The spelling never tried is
 *      EMAIL_ADDR, which is what staff email uses on USERS.
 *
 * PII: this prints column names, counts and type ids. Email addresses are
 * MASKED before they are printed, because the point is to learn which column
 * holds them, not to read them.
 */

import { loadConfig, redactedConfig, type Config } from "./config.ts";
import { PowerSchoolClient } from "./client.ts";

const config: Config = await loadConfig();
const client = new PowerSchoolClient(config);
const QP = "com.lapromisefund.wildcathub";

console.log(`\nPost 1.1.1 verification  ${new Date().toISOString()}`);
console.log("=".repeat(70));
console.log(`  instance  ${redactedConfig(config).host}\n`);

async function get(path: string, query: Record<string, string | number> = {}) {
  const res = await client.get(path, query);
  return { code: res.status, json: res.json, text: String(res.text ?? "").slice(0, 160) };
}

/** a.student@domain.org -> a****t@domain.org */
function mask(value: unknown): string {
  const s = String(value ?? "");
  const at = s.lastIndexOf("@");
  if (at < 1) return s ? "(non email value present)" : "(empty)";
  const local = s.slice(0, at);
  const domain = s.slice(at);
  const keep = local.length <= 2 ? local[0] : `${local[0]}${"*".repeat(Math.max(1, local.length - 2))}${local.at(-1)}`;
  return `${keep}${domain}`;
}

// ---- 1. did the new named queries register? -------------------------------
console.log("1. New PowerQueries");
// Each query declares its own args. Passing the wrong ones is a 400 that
// looks exactly like a broken query, so the args come from the XML.
const QUERY_ARGS: Record<string, Record<string, string | number>> = {
  behavior_types: { schoolid: config.schoolId },
  behavior_log: { schoolid: config.schoolId, startdate: "2025-08-01", enddate: "2026-08-12" },
  attendance_by_section: { schoolid: config.schoolId, termid: config.termId },
  enrollment_window: { schoolid: config.schoolId, termid: config.termId },
};
for (const [q, args] of Object.entries(QUERY_ARGS)) {
  const res = await client
    .namedQuery(`${QP}.${q}`, args)
    .then((r) => ({ ok: true, rows: r.rows }))
    .catch((e) => ({ ok: false, msg: String(e.message ?? e).slice(0, 130) }));
  if (!res.ok) {
    console.log(`   ${q.padEnd(24)} NOT USABLE: ${res.msg}`);
    continue;
  }
  console.log(`   ${q.padEnd(24)} registered, ${res.rows.length} row(s)`);
  if (q === "behavior_types") {
    for (const row of res.rows.slice(0, 25)) {
      console.log(
        `       id ${String(row.gen_id ?? "?").padStart(8)}  ${String(row.gen_name ?? "(unnamed)").padEnd(30)}` +
          `  entries ${row.entries_all_time ?? 0}`,
      );
    }
  }
}

// ---- 2. the real log type ids ---------------------------------------------
console.log("\n2. Log types actually in use");
const page = await get("/ws/schema/table/log", {
  projection: "logtypeid,subtype,consequence",
  pagesize: 100,
});
if (page.code !== 200) {
  console.log(`   ${page.code}. ${page.text}`);
} else {
  const rows = page.json?.record ?? page.json?.records ?? [];
  const tally = new Map<string, number>();
  for (const r of rows) {
    const t = r.tables?.log ?? r;
    const key = String(t.logtypeid ?? "(null)");
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  console.log(`   sampled ${rows.length} rows, ${tally.size} distinct log type id(s):`);
  for (const [id, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     logtypeid ${String(id).padStart(10)}   ${String(n).padStart(4)} in sample`);
  }
}

// ---- 3. where student email lives -----------------------------------------
console.log("\n3. Student email, candidate columns");
const candidates: Array<[string, string]> = [
  ["students", "email_addr"],
  ["students", "student_email"],
  ["students", "email"],
  ["students", "student_web_id"],
  ["u_studentsuserfields", "email_addr"],
  ["u_studentsuserfields", "student_email"],
  ["studentcorefields", "email_addr"],
  ["studentcorefields", "student_email"],
];
for (const [table, column] of candidates) {
  const r = await get(`/ws/schema/table/${table}`, { projection: column, pagesize: 1 });
  let verdict: string;
  if (r.code === 200) {
    const rows = r.json?.record ?? r.json?.records ?? [];
    const first = rows[0]?.tables?.[table] ?? rows[0] ?? {};
    const value = Object.values(first)[0];
    verdict = `200 EXISTS AND READABLE -> ${mask(value)}`;
  } else if (r.code === 403) {
    verdict = "403 exists, not granted";
  } else if (/not valid column/i.test(r.text)) {
    verdict = "400 column does not exist (table does)";
  } else {
    verdict = `${r.code} ${r.text.slice(0, 80)}`;
  }
  console.log(`   ${`${table}.${column}`.padEnd(38)} ${verdict}`);
}

console.log(`\n  requests this run: ${client.summary().requests}\n`);
