/**
 * Validates every shipped PowerQuery against plugin.xml before the zip is built.
 *
 * Run:  npm run validate:queries   (also runs inside npm run build:plugin)
 *
 * WHY THIS EXISTS
 *
 * Three of the four ways a PowerQuery can be wrong fail SILENTLY. The plugin
 * installs, the administrator approves the access request, the plugin enables,
 * nothing reports an error, and then every call to the query returns 404 or 403
 * forever. The cost of finding that out is a second trip to a PowerSchool
 * administrator, and a school SIS administrator gets asked once cheaply.
 *
 * The four failure modes, all documented at the top of the query files and all
 * learned the hard way on this project:
 *
 *   1. Column count mismatch. The number of <column> entries must equal the
 *      number of columns the SQL returns, in the same order. Off by one leaves
 *      the query unregistered.
 *   2. Alias mismatch. The <column> element text must match the SQL output
 *      column name exactly.
 *   3. Undeclared bind variable. Every :name in the SQL must appear in <args>.
 *      An undeclared one installs with no validation error and 404s on call.
 *   4. Ungranted column. Every <column column="TABLE.FIELD"> must be granted in
 *      plugin.xml. This is what took the whole plugin down at 1.0.0 when
 *      SECTIONMEETING turned out not to exist in this instance.
 *
 * This checks all four mechanically. What it CANNOT check is whether Oracle
 * will parse the SQL, because that needs Oracle. That gate stays human: paste
 * each <sql> body into the PowerSchool query tester and run it once.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, "..", "..", "plugin");
const QUERIES_DIR = resolve(PLUGIN_DIR, "queries_root");
const PLUGIN_XML = resolve(PLUGIN_DIR, "plugin.xml");

const problems = [];
const notes = [];
let queriesChecked = 0;

/** Fields plugin.xml grants, lowercased as "table.field". */
function grantedFields(xml) {
  const granted = new Set();
  for (const m of xml.matchAll(/<field\s+table="([^"]+)"\s+field="([^"]+)"/g)) {
    granted.add(`${m[1]}.${m[2]}`.toLowerCase());
  }
  return granted;
}

/**
 * The alias list a SELECT actually returns.
 *
 * Split on top level commas only: a comma inside COUNT(DISTINCT a, b) or inside
 * a CASE expression does not start a new output column, and treating it as one
 * is how a hand count of this drifts from the real one.
 */
function selectAliases(sql) {
  const upper = sql.toUpperCase();
  const selectAt = upper.indexOf("SELECT");
  if (selectAt === -1) return null;
  const fromAt = findTopLevel(sql, upper, selectAt + 6, "FROM");
  if (fromAt === -1) return null;

  const body = sql.slice(selectAt + 6, fromAt);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));

  return parts
    .map((part) => stripComments(part).trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const alias = part.match(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i);
      if (alias) return alias[1];
      const bare = part.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
      return bare ? bare[1] : part;
    });
}

/** Index of `word` at paren depth 0, so a nested SELECT ... FROM is skipped. */
function findTopLevel(raw, upper, from, word) {
  let depth = 0;
  for (let i = from; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && upper.startsWith(word, i)) {
      const before = i === 0 ? " " : raw[i - 1];
      const after = raw[i + word.length] ?? " ";
      if (/\s/.test(before) && /\s/.test(after)) return i;
    }
  }
  return -1;
}

function stripComments(text) {
  return text.replace(/--[^\n]*/g, "");
}

function checkFile(path, granted) {
  const xml = readFileSync(path, "utf8");
  const name = basename(path);

  for (const block of xml.matchAll(/<query\b([^>]*)>([\s\S]*?)<\/query>/g)) {
    const attrs = block[1];
    const inner = block[2];
    const queryName = (attrs.match(/name="([^"]+)"/) ?? [, "(unnamed)"])[1];
    const where = `${name} :: ${queryName}`;
    queriesChecked++;

    const columns = [...inner.matchAll(/<column\s+column="([^"]+)"\s*>([^<]*)<\/column>/g)].map(
      (m) => ({ source: m[1], alias: m[2].trim() }),
    );
    const sqlMatch = inner.match(/<sql>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/sql>/);
    if (!sqlMatch) {
      problems.push(`${where}: no <sql> CDATA block found.`);
      continue;
    }
    const sql = sqlMatch[1];

    // 4. Every referenced column is granted.
    for (const col of columns) {
      if (!granted.has(col.source.toLowerCase())) {
        problems.push(
          `${where}: <column column="${col.source}"> is NOT granted in plugin.xml. ` +
            `This query will 403 on every call, or fail validation on upload.`,
        );
      }
    }

    // 3. Every bind variable is declared.
    const declared = new Set(
      [...inner.matchAll(/<arg\s+name="([^"]+)"/g)].map((m) => m[1].toLowerCase()),
    );
    const used = new Set(
      [...stripComments(sql).matchAll(/(?<![:\w]):([a-z_][a-z0-9_]*)/gi)].map((m) =>
        m[1].toLowerCase(),
      ),
    );
    for (const bind of used) {
      if (!declared.has(bind)) {
        problems.push(
          `${where}: SQL uses :${bind} but <args> does not declare it. ` +
            `The plugin will install and enable with no error, then this query 404s forever.`,
        );
      }
    }
    for (const arg of declared) {
      if (!used.has(arg)) {
        notes.push(`${where}: <arg name="${arg}"> is declared but never used in the SQL.`);
      }
    }

    // 1 and 2. Column count and alias agreement.
    const aliases = selectAliases(sql);
    if (aliases === null) {
      notes.push(`${where}: could not parse the SELECT list, so the column check was skipped.`);
      continue;
    }
    if (aliases.length !== columns.length) {
      problems.push(
        `${where}: ${columns.length} <column> entries but the SELECT returns ${aliases.length} ` +
          `columns. They must match exactly, in order. Declared: [${columns
            .map((c) => c.alias)
            .join(", ")}] SQL: [${aliases.join(", ")}]`,
      );
      continue;
    }
    for (let i = 0; i < aliases.length; i++) {
      if (aliases[i].toLowerCase() !== columns[i].alias.toLowerCase()) {
        problems.push(
          `${where}: column ${i + 1} is declared as "${columns[i].alias}" but the SQL returns ` +
            `"${aliases[i]}". The element text must match the SQL output column name.`,
        );
      }
    }
  }
}

if (!existsSync(PLUGIN_XML)) {
  console.error(`FAILED: plugin.xml not found at ${PLUGIN_XML}`);
  process.exit(1);
}
const granted = grantedFields(readFileSync(PLUGIN_XML, "utf8"));

const files = existsSync(QUERIES_DIR)
  ? readdirSync(QUERIES_DIR)
      .filter((n) => n.endsWith(".xml"))
      .sort()
      .map((n) => resolve(QUERIES_DIR, n))
  : [];

for (const file of files) checkFile(file, granted);

console.log(
  `Checked ${queriesChecked} queries across ${files.length} file(s) against ${granted.size} granted fields.`,
);
for (const note of notes) console.log(`  note: ${note}`);

if (problems.length > 0) {
  console.error(`\nFAILED: ${problems.length} problem(s).\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

console.log("All queries agree with the access request. Oracle syntax is still a human gate.");
