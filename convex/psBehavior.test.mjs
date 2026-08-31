// PowerSchool behavior read: the rules, the PowerQuery contract, and the two
// guarantees that would be expensive to get wrong.
//
// Three groups, in order of how much damage the failure would do:
//
//   1. EARNED VALUE. Nothing on the behavior path may write a ticket or a
//      Wildcat Cash balance. Asserted against this module's own source text,
//      not against a comment, so a future edit that adds the write has to
//      delete a failing test on purpose.
//   2. THE PII BOUNDARY. No log entry free text and no discipline detail column
//      may reach the database or a browser.
//   3. THE POWERQUERY CONTRACT. The column count, the column order, the arg
//      declarations and the read only property, checked mechanically. These are
//      exactly the four mistakes the named_queries header warns about, and
//      three of the four fail SILENTLY on a live instance: the plugin installs,
//      enables, reports nothing, and the query 404s or returns the wrong column
//      in every row.
//
// The contract validator is run against the seven queries already live in
// wildcathub.named_queries.xml as a CONTROL. A validator that only ever sees
// the file it was written for proves nothing; one that agrees with seven
// queries known to work on the live instance has been calibrated.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BEHAVIOR_ROW_FIELDS,
  FORBIDDEN_SOURCE_KEYS,
  ALLOWED_DISCIPLINE_SOURCE_KEYS,
  ACTION_TAKEN_MAX_CHARS,
  isActionCode,
  UNMAPPED_PREFIX,
  BEHAVIOR_TABLE,
  SCHEMA_DIFF_UNAPPLIED,
  readBehaviorForStudent,
  BEHAVIOR_QUERY_LOG,
  BEHAVIOR_QUERY_TYPES,
  normalizeBehaviorRow,
  normalizeTypeRow,
  rejectedFreeTextKeys,
  behaviorSummaryFor,
  staffBehaviorView,
  behaviorAudienceFor,
  isUnmappedType,
  canonicalDate,
  buildSubtypeIndex,
  resolveSubtype,
  ingestReport,
} from "./psBehavior.ts";
import { EARNED_FIELDS } from "./sisMerge.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const BEHAVIOR_XML = resolve(REPO, "powerschool/plugin/queries_root/behavior.named_queries.xml");
const LIVE_XML = resolve(REPO, "powerschool/plugin/queries_root/wildcathub.named_queries.xml");
const PLUGIN_XML = resolve(REPO, "powerschool/plugin/plugin.xml");
const DOC = resolve(REPO, "docs/behavior-sourcing.md");
const MODULE = resolve(REPO, "convex/psBehavior.ts");

let pass = 0, fail = 0;
const check = (l, c, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${l}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? `  (${d})` : ""}`); }
};

// ===========================================================================
// A tiny PowerQuery contract validator.
//
// Deliberately not a real XML parser. The failure modes being checked are
// textual (count mismatch, order mismatch, an undeclared bind variable), and a
// DOM would not make any of them easier to see.
// ===========================================================================

const stripXmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, "");
const stripSqlComments = (s) => s.replace(/--[^\n]*/g, "");

/** Split on a delimiter that is at paren depth 0 and outside a quoted string. */
function splitTopLevel(sql, delimiter) {
  const out = [];
  let depth = 0, quoted = false, current = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quoted) {
      current += ch;
      if (ch === "'") quoted = false;
      continue;
    }
    if (ch === "'") { quoted = true; current += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === delimiter && depth === 0) { out.push(current); current = ""; continue; }
    current += ch;
  }
  out.push(current);
  return out;
}

/** Index of a keyword occurring at paren depth 0, outside quotes. */
function indexOfTopLevelKeyword(sql, keyword, from = 0) {
  let depth = 0, quoted = false;
  const kw = keyword.toUpperCase();
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quoted) { if (ch === "'") quoted = false; continue; }
    if (ch === "'") { quoted = true; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (i < from || depth !== 0) continue;
    if (sql.slice(i, i + kw.length).toUpperCase() !== kw) continue;
    const before = i === 0 ? " " : sql[i - 1];
    const after = sql[i + kw.length] ?? " ";
    if (/[\s(),]/.test(before) && /[\s(),]/.test(after)) return i;
  }
  return -1;
}

function parseQueries(xmlText) {
  const xml = stripXmlComments(xmlText);
  const queries = [];
  const blockRe = /<query\b([^>]*)>([\s\S]*?)<\/query>/g;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const attrs = m[1];
    const body = m[2];
    const name = (attrs.match(/\bname="([^"]+)"/) ?? [])[1] ?? "";
    const coreTable = (attrs.match(/\bcoreTable="([^"]+)"/) ?? [])[1] ?? "";
    const args = [...body.matchAll(/<arg\b[^>]*\bname="([^"]+)"/g)].map((a) => a[1]);
    const columns = [...body.matchAll(/<column\b[^>]*\bcolumn="([^"]+)"[^>]*>([^<]*)<\/column>/g)]
      .map((c) => ({ source: c[1], alias: c[2].trim() }));
    const sqlRaw = (body.match(/<!\[CDATA\[([\s\S]*?)\]\]>/) ?? [])[1] ?? "";
    const sql = stripSqlComments(sqlRaw);

    const selectAt = indexOfTopLevelKeyword(sql, "SELECT");
    const fromAt = indexOfTopLevelKeyword(sql, "FROM", selectAt + 6);
    const selectList = selectAt >= 0 && fromAt > selectAt ? sql.slice(selectAt + 6, fromAt) : "";
    const items = selectList.trim() === "" ? [] : splitTopLevel(selectList, ",").map((s) => s.trim());

    let orderBy = [];
    const orderAt = indexOfTopLevelKeyword(sql, "ORDER", fromAt);
    if (orderAt >= 0) {
      orderBy = splitTopLevel(sql.slice(orderAt).replace(/^ORDER\s+BY/i, ""), ",")
        .map((s) => s.trim().replace(/\s+(ASC|DESC)$/i, "").trim())
        .filter(Boolean);
    }

    queries.push({ name, coreTable, args, columns, sql, selectList, items, orderBy, body });
  }
  return { xml, queries };
}

const WRITE_VERBS = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|GRANT)\b/i;

function validate(label, path, { dcidStrict = true } = {}) {
  const raw = readFileSync(path, "utf8");
  const { xml, queries } = parseQueries(raw);

  check(`${label}: root element is <queries> with no namespace`,
    /<queries>\s/.test(xml) && !/<queries\s+xmlns/.test(xml));
  check(`${label}: no <summary> element (there is no such element in the contract)`,
    !/<summary>/.test(xml));
  check(`${label}: parsed at least one query`, queries.length > 0, `found ${queries.length}`);

  for (const q of queries) {
    const id = `${label}: ${q.name.split(".").pop()}`;

    check(`${id} declares a coreTable`, q.coreTable.length > 0);

    // The silent killer. An undeclared :name leaves the query unregistered:
    // the plugin installs and enables with no error, then every call 404s.
    const binds = [...new Set([...q.sql.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((b) => b[1]))];
    const undeclared = binds.filter((b) => !q.args.includes(b));
    check(`${id}: every :bind is declared in <args>`, undeclared.length === 0,
      `undeclared: ${undeclared}`);
    const unused = q.args.filter((a) => !binds.includes(a));
    check(`${id}: every declared arg is used in the SQL`, unused.length === 0, `unused: ${unused}`);

    // <args> must sit after <description> and before <columns>.
    if (q.args.length > 0) {
      const argAt = q.body.indexOf("<arg ");
      const descEnd = q.body.indexOf("</description>");
      const colAt = q.body.indexOf("<columns>");
      check(`${id}: <args> sits after <description> and before <columns>`,
        descEnd >= 0 && argAt > descEnd && colAt > argAt);
    }

    // Count and ORDER must match, or every row carries the wrong labels.
    check(`${id}: ${q.columns.length} <column> entries == ${q.items.length} SELECT items`,
      q.columns.length === q.items.length,
      `columns ${q.columns.map((c) => c.alias)} vs items ${q.items.length}`);

    const aliases = q.items.map((item) => {
      const m = item.match(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i);
      return m ? m[1] : null;
    });
    check(`${id}: every SELECT item is aliased with AS`, aliases.every(Boolean),
      `unaliased: ${q.items.filter((_, i) => !aliases[i])}`);
    const declared = q.columns.map((c) => c.alias);
    check(`${id}: <column> aliases match the SELECT aliases in order`,
      JSON.stringify(declared) === JSON.stringify(aliases),
      `declared ${declared} vs sql ${aliases}`);

    // Referencing DCID in a columns block is reported to disable the query in
    // Data Export Manager. It does NOT stop the API from calling it: the live
    // roster and staff queries both declare DCID columns and both return rows
    // on this instance (docs/access-gap.md). So this is enforced on new work
    // and merely recorded on the existing file. See the calibration note below.
    const dcid = q.columns.filter((c) => /\.DCID$/i.test(c.source));
    q.dcidColumns = dcid.map((c) => c.source);
    if (dcidStrict) {
      check(`${id}: no DCID in a <column> attribute`, dcid.length === 0,
        `${dcid.map((c) => c.source)}`);
    }

    // Read only, structurally. A PowerQuery physically cannot mutate, but a
    // reviewer should not have to take that on faith from a PDF.
    check(`${id}: SQL contains no write verb`, !WRITE_VERBS.test(q.sql),
      `${(q.sql.match(WRITE_VERBS) ?? [])[0]}`);

    // ORDER BY may only reference selected, fully qualified columns.
    for (const ref of q.orderBy) {
      check(`${id}: ORDER BY ${ref} is qualified and selected`,
        ref.includes(".") && q.selectList.toUpperCase().includes(ref.toUpperCase()));
    }
  }

  return queries;
}

// ---------------------------------------------------------------------------
console.log("\n1. Earned value cannot be touched from the behavior path");
// ---------------------------------------------------------------------------
{
  const src = readFileSync(MODULE, "utf8");

  // The app holds 6,616,500 in Wildcat Cash and PowerSchool knows about none of
  // it. A behavior count is a fact from the SIS; a ticket is something a person
  // gave a child. Wiring one to the other lets a log entry spend real money.
  check("psBehavior.ts never names the students table",
    !/["']students["']/.test(src));
  for (const earned of EARNED_FIELDS) {
    check(`psBehavior.ts never mentions ${earned}`, !src.includes(earned));
  }
  const overlap = BEHAVIOR_ROW_FIELDS.filter((f) => EARNED_FIELDS.includes(f));
  check("no stored behavior field collides with an earned field", overlap.length === 0,
    `${overlap}`);
  check("psBehavior.ts writes only its own two destinations",
    [...src.matchAll(/\.insert\(\s*["']([A-Za-z]+)["']/g)].every(
      (m) => m[1] === "psBehaviorLog" || m[1] === "appState",
    ));
  check("psBehavior.ts exposes no public query or mutation",
    !/\b(export const \w+ = (query|mutation)\()/.test(src));
}

// ---------------------------------------------------------------------------
console.log("\n2. No free text can be stored, and only two discipline columns can");
// ---------------------------------------------------------------------------
{
  const raw = {
    student_number: " 11414 ",
    log_entry_id: 90210,
    entry_date: "2026-09-03",
    log_type_name: "Discipline",
    log_type_id: "404",
    subtype: "DEF",
    consequence: "Detention",
    action_taken: "S=Suspend",
    incident_date: "2026-09-02",
    entry_author: "Smith, Tara",
    school_id: "1817",
    // Everything below is what a widened query would start sending.
    entry: "Told a staff member to shut up in front of Jose R and then left.",
    subject: "Fight with Jose",
    // Two of the 32 discipline columns that are NOT allowed. Discipline_Reporter
    // in particular names a third party.
    Discipline_Reporter: "Nguyen, Mai",
    discipline_victimtype: "Student",
    some_future_column: "whatever",
  };

  const row = normalizeBehaviorRow(raw);
  const serialized = JSON.stringify(row);
  check("the narrative never reaches the row", !/shut up|Jose/.test(serialized), serialized);
  check("the subject line never reaches the row", !("subject" in row));
  check("a third party name in a discipline column never reaches the row",
    !serialized.includes("Nguyen"), serialized);
  check("an unknown upstream column is dropped, not carried",
    !("some_future_column" in row));
  check("stored keys are exactly the allowlist",
    Object.keys(row).every((k) => BEHAVIOR_ROW_FIELDS.includes(k)),
    Object.keys(row).join(","));
  check("values are trimmed and stringified", row.studentNumber === "11414" && row.logEntryId === "90210");

  // The two that ARE allowed. These are the pair the data dictionary calls
  // live, and they answer "was this child suspended, and when", which is the
  // question a rewards app most needs before it deducts anything.
  check("the action taken lands, through its alias", row.actionTaken === "S=Suspend");
  check("the incident date lands, canonicalized", row.incidentDate === "2026-09-02");
  check("exactly two discipline source columns are allowed",
    ALLOWED_DISCIPLINE_SOURCE_KEYS.length === 2 &&
      ALLOWED_DISCIPLINE_SOURCE_KEYS.includes("discipline_actiontaken") &&
      ALLOWED_DISCIPLINE_SOURCE_KEYS.includes("discipline_incidentdate"),
    ALLOWED_DISCIPLINE_SOURCE_KEYS.join(","));

  // Discipline_ActionTaken is a String 79 that a district CAN type prose into.
  // The guard used to be a 79 character cap and it was worthless: by
  // construction a length cap cannot exclude prose shorter than the cap. This
  // is the exact sentence that defeated it, kept verbatim as the regression.
  const LEAK = "Suspended for fighting with Jose in the cafeteria";
  check("the sentence that defeated the length cap is well under it",
    LEAK.length === 49 && LEAK.length < ACTION_TAKEN_MAX_CHARS,
    `${LEAK.length} of ${ACTION_TAKEN_MAX_CHARS}`);
  check("and it is now REFUSED, on its shape, not its length",
    normalizeBehaviorRow({ ...raw, action_taken: LEAK }).actionTaken === undefined);
  check("the second child's name does not reach the row through the code field",
    !JSON.stringify(normalizeBehaviorRow({ ...raw, action_taken: LEAK })).includes("Jose"));

  // Real codes still land. If they did not, the column would be dead weight in
  // the access request and should be dropped from it instead.
  for (const code of ["S", "OSS", "ISS", "S=Suspend", "ISS-3", "OSS/ISS", "SUSP_3", "A.1"]) {
    check(`a real action code lands: ${code}`,
      normalizeBehaviorRow({ ...raw, action_taken: code }).actionTaken === code);
  }
  // Everything with whitespace in it dies, whatever its length.
  for (const prose of [
    "S Suspend", "3 days", "Suspended for fighting", "sent home\nearly",
    "S\tSuspend", "See note", " ", "in school suspension",
  ]) {
    check(`prose is refused: ${JSON.stringify(prose)}`,
      normalizeBehaviorRow({ ...raw, action_taken: prose }).actionTaken === undefined);
  }
  check("a value over the declared column width is still refused",
    normalizeBehaviorRow({ ...raw, action_taken: "x".repeat(ACTION_TAKEN_MAX_CHARS + 1) })
      .actionTaken === undefined);
  check("the guard is a shape, and the shape rejects any whitespace at all",
    !isActionCode("a b") && !isActionCode("a b") && isActionCode("ab"));
  check("two equals signs is not a code",
    !isActionCode("S=Suspend=Long") && isActionCode("S=Suspend"));
  check("the honest limit is real and is not hidden: one bare token passes",
    isActionCode("Jose") === true,
    "no shape can separate a code from a one word name; the doc says so and the sync counts refusals");

  const rejected = rejectedFreeTextKeys(raw).map((k) => k.toLowerCase());
  check("the alarm names entry and subject",
    rejected.includes("entry") && rejected.includes("subject"), rejected.join(","));
  check("the alarm names a discipline column outside the two allowed, any casing",
    rejected.includes("discipline_reporter") && rejected.includes("discipline_victimtype"),
    rejected.join(","));
  check("the alarm does NOT fire on the two allowed discipline columns",
    rejectedFreeTextKeys({
      discipline_actiontaken: "S", Discipline_IncidentDate: "2026-09-02",
    }).length === 0);
  check("the alarm does not fire on ordinary columns",
    rejectedFreeTextKeys({ student_number: "1", consequence: "Detention", subtype: "x" }).length === 0);
  check("FORBIDDEN_SOURCE_KEYS covers both LOG free text columns",
    FORBIDDEN_SOURCE_KEYS.includes("entry") && FORBIDDEN_SOURCE_KEYS.includes("subject"));

  const view = staffBehaviorView(row);
  check("the staff view is an allowlist of eight fields",
    JSON.stringify(Object.keys(view)) ===
      JSON.stringify(["id", "date", "type", "subtype", "consequence", "actionTaken", "incidentDate", "author"]),
    Object.keys(view).join(","));
  check("the staff view carries no student identifier",
    !("studentNumber" in view) && !JSON.stringify(view).includes("11414"));
}

// ---------------------------------------------------------------------------
console.log("\n3. A row that cannot be attributed is dropped, not guessed at");
// ---------------------------------------------------------------------------
{
  const base = { student_number: "11414", log_entry_id: "1", entry_date: "2026-09-03" };
  check("no student number, no row", normalizeBehaviorRow({ ...base, student_number: "" }) === null);
  check("no entry id, no row", normalizeBehaviorRow({ ...base, log_entry_id: null }) === null);
  check("no date, no row", normalizeBehaviorRow({ ...base, entry_date: undefined }) === null);
  check("an empty payload is null, not an empty row", normalizeBehaviorRow({}) === null);
  check("a complete row survives", normalizeBehaviorRow(base) !== null);
  check("a date the canonicalizer cannot read is a dropped row, not a guess",
    normalizeBehaviorRow({ ...base, entry_date: "next Tuesday" }) === null);
  check("the date is canonicalized, never re-parsed through a Date object",
    normalizeBehaviorRow(base).entryDate === "2026-09-03");
}

// ---------------------------------------------------------------------------
console.log("\n4. An unresolvable log type is surfaced, never dropped");
// ---------------------------------------------------------------------------
{
  // LogTypeID values are arbitrary per district and some built-ins are
  // negative. An INNER JOIN to GEN would silently delete these rows and the
  // count would look plausible while being wrong.
  const row = normalizeBehaviorRow({
    student_number: "11414", log_entry_id: "7", entry_date: "2026-09-04",
    log_type_id: "-100000",
  });
  check("a missing type name becomes an UNMAPPED marker, not null",
    isUnmappedType(row.logTypeName), row.logTypeName);
  // The marker is now built HERE and only here. It used to be built twice, once
  // in Oracle with a string concatenation and once in this module, which is one
  // literal in two languages waiting to disagree.
  check("the marker carries the real id, so it can be traced back to GEN",
    row.logTypeName === `${UNMAPPED_PREFIX}-100000`, row.logTypeName);
  check("a row with no id at all still gets a marker rather than a null name",
    normalizeBehaviorRow({ student_number: "1", log_entry_id: "1", entry_date: "2026-09-04" })
      .logTypeName === `${UNMAPPED_PREFIX}UNKNOWN`);
  check("the raw id is kept so the marker can be resolved later", row.logTypeId === "-100000");
  check("UNMAPPED_LOGTYPE_404 reads as unmapped", isUnmappedType(`${UNMAPPED_PREFIX}404`));
  check("a real type name does not", !isUnmappedType("Discipline"));
}

// ---------------------------------------------------------------------------
console.log("\n5. Absence is not zero");
// ---------------------------------------------------------------------------
{
  // The rule psAttendance states in schema.ts, applied to behavior: a student
  // with no rows either has no log entries or has never been synced, and
  // rendering the second as "0 incidents" invents a fact about a child.
  const none = behaviorSummaryFor([], null);
  check("no coverage record means status unknown", none.status === "unknown");
  check("no coverage record means totalEntries is null, NOT 0", none.totalEntries === null);
  check("no coverage record returns no type breakdown", none.byType.length === 0);
  check("the unknown summary carries no window", none.window === null);

  const coverage = {
    windowStart: "2026-08-12", windowEnd: "2026-09-30",
    syncedAt: "2026-09-30T13:00:00.000Z", entriesLoaded: 91,
  };
  const covered = behaviorSummaryFor([], coverage);
  check("a covered window with no rows IS zero", covered.status === "covered" && covered.totalEntries === 0);
  check("a covered summary names the window it covers",
    covered.window.start === "2026-08-12" && covered.window.end === "2026-09-30");
  check("a covered summary carries the sync timestamp", covered.syncedAt === coverage.syncedAt);
}

// ---------------------------------------------------------------------------
console.log("\n6. The rollup counts what it should and orders stably");
// ---------------------------------------------------------------------------
{
  const coverage = {
    windowStart: "2026-08-12", windowEnd: "2026-09-30",
    syncedAt: "2026-09-30T13:00:00.000Z", entriesLoaded: 5,
  };
  const rows = [
    { studentNumber: "1", logEntryId: "a", entryDate: "2026-09-01", logTypeName: "Discipline" },
    { studentNumber: "1", logEntryId: "b", entryDate: "2026-09-05", logTypeName: "Discipline" },
    { studentNumber: "1", logEntryId: "c", entryDate: "2026-09-03", logTypeName: "Merit" },
    { studentNumber: "1", logEntryId: "d", entryDate: "2026-08-20", logTypeName: "Discipline" },
    { studentNumber: "1", logEntryId: "e", entryDate: "2026-09-02", logTypeName: `${UNMAPPED_PREFIX}-100000` },
  ];
  const s = behaviorSummaryFor(rows, coverage);
  check("total counts every row", s.totalEntries === 5);
  check("the most frequent type sorts first", s.byType[0].logTypeName === "Discipline");
  check("counts per type are right", s.byType[0].count === 3);
  check("lastEntryDate is the LATEST, not the last one seen",
    s.byType[0].lastEntryDate === "2026-09-05", s.byType[0].lastEntryDate);
  check("ties break alphabetically so the order is stable across runs",
    s.byType[1].logTypeName === "Merit" && s.byType[2].logTypeName === `${UNMAPPED_PREFIX}-100000`,
    s.byType.map((t) => t.logTypeName).join(" > "));
  check("re-summarizing a shuffled input gives the identical order",
    JSON.stringify(behaviorSummaryFor([...rows].reverse(), coverage).byType) ===
      JSON.stringify(s.byType));
  check("unmapped types are reported separately, not hidden",
    s.unmappedTypes.length === 1 && isUnmappedType(s.unmappedTypes[0]));
  check("a real type is not reported as unmapped", !s.unmappedTypes.includes("Discipline"));
}

// ---------------------------------------------------------------------------
console.log("\n7. Students do not read their own SIS discipline log");
// ---------------------------------------------------------------------------
{
  // The gate takes the REAL union classify() returns, imported from
  // identityRules.ts rather than described here. Two rounds, two wrong shapes:
  // `kind: string` with the wiring passing the literal "staff" (the gate could
  // never deny anything while this section certified that students were
  // denied), then `{ kind: string }`, which still lets a typo like "stff"
  // compile and silently deny, and lets any object with any string kind reach
  // the gate at all. The type is now the union itself, so neither compiles.
  const STAFF = { kind: "staff", email: "teacher@westbrookacademy.org" };
  const STUDENT = { kind: "student", email: "kid@westbrookacademy.org" };

  check("staff are allowed", behaviorAudienceFor(STAFF).allowed === true);
  check("students are denied", behaviorAudienceFor(STUDENT).allowed === false);
  check("the denial explains itself", behaviorAudienceFor(STUDENT).reason.length > 40);
  check("an unknown principal is denied, not defaulted open",
    behaviorAudienceFor({ kind: "", email: "x@y.z" }).allowed === false &&
      behaviorAudienceFor({ kind: "parent", email: "x@y.z" }).allowed === false);
  check("a near miss on the kind is denied, not defaulted open",
    behaviorAudienceFor({ kind: "stff", email: "x@y.z" }).allowed === false);
  check("no principal at all is denied, not defaulted open",
    behaviorAudienceFor(null).allowed === false &&
      behaviorAudienceFor(undefined).allowed === false);

  // The literal that made the gate a tautology two rounds ago. A bare string no
  // longer satisfies it even at runtime, so a JavaScript caller that skips the
  // type checker is refused too.
  check("a bare string is refused, so the old tautology cannot come back",
    behaviorAudienceFor("staff").allowed === false);
  // And a hand rolled object that never went through classify() is refused,
  // because classify() throws on a token with no email, so a principal without
  // one did not come from there.
  check("a hand rolled principal with no email is refused at runtime too",
    behaviorAudienceFor({ kind: "staff" }).allowed === false &&
      behaviorAudienceFor({ kind: "staff", email: "  " }).allowed === false);

  const src = readFileSync(MODULE, "utf8");
  // The type cannot be checked from a .mjs test, so its DEFINITION is. An alias
  // to the imported union is the only form that cannot drift from identity.ts.
  check("BehaviorPrincipal IS the union identityRules.ts produces, not a lookalike",
    /import type \{ Identity \} from "\.\/identityRules\.js";/.test(src) &&
      /export type BehaviorPrincipal = Identity;/.test(src),
    "the type must be imported, not re-described");
  {
    const rules = readFileSync(resolve(HERE, "identityRules.ts"), "utf8");
    check("and that union is the two-arm one with an email on both arms",
      /export type Identity =\s*\|\s*\{ kind: "staff"; email: string \}\s*\|\s*\{ kind: "student"; email: string \};/
        .test(rules),
      "identityRules.ts changed shape; this gate's assumptions need re-reading");
  }
  check("readBehaviorForStudent takes the principal, it is not optional",
    /readBehaviorForStudent\(\s*ctx:[^)]*principal: BehaviorPrincipal \| null \| undefined,/s.test(src),
    "signature changed");
  check("the read path calls the gate itself rather than trusting its caller",
    /const audience = behaviorAudienceFor\(principal\)/.test(src));
  check("a denied read is a third state, never rendered as zero entries",
    /status: "denied"/.test(src) && /"unknown" \| "covered" \| "denied"/.test(src));
}

// ---------------------------------------------------------------------------
console.log("\n8. The type vocabulary normalizes without inventing anything");
// ---------------------------------------------------------------------------
{
  const t = normalizeTypeRow({
    gen_id: "404", gen_cat: "logtype", gen_name: " Merits ", gen_value: "MER",
    school_id: "1817", sort_order: "3", entries_all_time: "12",
    first_entry_date: "2026-08-14", last_entry_date: "2026-09-29",
  });
  check("a type row normalizes", t.genId === "404" && t.genName === "Merits" && t.sortOrder === 3);
  check("counts become numbers", t.entriesAllTime === 12);
  check("GEN.Value is carried, because it is one of the two subtype code candidates",
    t.genValue === "MER");
  check("vocabulary dates are canonicalized like every other date",
    t.firstEntryDate === "2026-08-14" && t.lastEntryDate === "2026-09-29");
  check("a row with no name is dropped", normalizeTypeRow({ gen_id: "1", gen_cat: "logtype" }) === null);
  check("a non numeric count becomes 0 rather than NaN",
    normalizeTypeRow({ gen_id: "1", gen_cat: "logtype", gen_name: "x" }).entriesAllTime === 0);
}

// ---------------------------------------------------------------------------
console.log("\n9. PowerQuery contract, CONTROL: the queries already live");
// ---------------------------------------------------------------------------
// Was seven. missing_work was added at plugin 1.3.0 on 2026-08-31, so the
// control is eight. The number is asserted rather than the file merely parsed
// because a query that silently fails to register answers 404 forever and
// reports nothing about why. A count that drops is the cheapest way to notice.
const live = validate("live", LIVE_XML, { dcidStrict: false });
check("control file holds the installed queries", live.length === 8, `${live.length}`);

// CALIBRATION NOTE, and the reason the control is here at all.
//
// The validator was written from the PowerQuery contract as documented, and it
// disagreed with the live file on exactly one rule: roster declares
// STUDENTS.DCID and SECTIONS.DCID, staff declares USERS.DCID three times, and
// all seven queries return rows on lapf.powerschool.com (docs/access-gap.md,
// PowerQuery availability table). So "referencing DCID in a columns block can
// disable the query" is a Data Export Manager caveat, NOT an API one. Without
// the control this would have shipped as a hard rule, and the next person to
// need a DCID column would have deleted a correct line to satisfy a wrong test.
{
  const withDcid = live.filter((q) => q.dcidColumns.length > 0).map((q) => q.name.split(".").pop());
  check("the live file does declare DCID columns, and those queries work anyway",
    withDcid.length === 2 && withDcid.includes("roster") && withDcid.includes("staff"),
    withDcid.join(","));
}

// ---------------------------------------------------------------------------
console.log("\n10. PowerQuery contract: the two behavior queries");
// ---------------------------------------------------------------------------
const behavior = validate("behavior", BEHAVIOR_XML);
{
  check("two queries, types and log", behavior.length === 2);
  const names = behavior.map((q) => q.name);
  check("names match the constants the Convex module uses",
    names.includes(BEHAVIOR_QUERY_TYPES) && names.includes(BEHAVIOR_QUERY_LOG), names.join(" "));

  const types = behavior.find((q) => q.name === BEHAVIOR_QUERY_TYPES);
  const log = behavior.find((q) => q.name === BEHAVIOR_QUERY_LOG);

  // Run behavior_types first: it answers "does this school use log entries"
  // using nothing but configuration rows and counts.
  check("behavior_types touches no student table", !/\bSTUDENTS\b/i.test(types.sql));
  check("behavior_types reads all three GEN categories",
    ["logtype", "subtype", "consequence"].every((c) => types.sql.includes(`'${c}'`)));
  check("behavior_types accepts district scoped lookup rows (SCHOOLID 0 or null)",
    /G\.SCHOOLID\s*=\s*0/.test(types.sql) && /G\.SCHOOLID\s+IS\s+NULL/i.test(types.sql));

  // The free text columns, at the source.
  const logAliases = log.columns.map((c) => c.alias);
  check("behavior_log selects no entry text",
    !logAliases.includes("entry") && !/\bL\.ENTRY\b/i.test(log.sql), logAliases.join(","));
  check("behavior_log selects no subject line",
    !logAliases.includes("subject") && !/\bL\.SUBJECT\b/i.test(log.sql));

  // Enumerated, not pattern matched. There are 34 Discipline_ columns and the
  // data dictionary describes only these two as live; banning the prefix would
  // have excluded them too, and pattern matching on the prefix would let a 35th
  // in unnoticed. Naming the allowed pair makes an addition a test failure.
  {
    const disciplineInSql = [...new Set(
      [...log.sql.matchAll(/\bDISCIPLINE_[A-Z0-9_]+/gi)].map((m) => m[0].toLowerCase()),
    )];
    const allowed = new Set(ALLOWED_DISCIPLINE_SOURCE_KEYS);
    check("behavior_log selects ONLY the two allowed Discipline_ columns",
      disciplineInSql.length === 2 && disciplineInSql.every((d) => allowed.has(d)),
      disciplineInSql.join(","));
    const disciplineDeclared = log.columns
      .filter((c) => /discipline_/i.test(c.source))
      .map((c) => c.source.split(".").pop().toLowerCase());
    check("and declares only those two in the columns block",
      disciplineDeclared.length === 2 && disciplineDeclared.every((d) => allowed.has(d)),
      disciplineDeclared.join(","));
    check("behavior_types touches no discipline column at all",
      !/discipline_/i.test(types.sql));
  }
  check("behavior_types selects GEN.Value so a subtype code can be resolved",
    /G\.VALUE/i.test(types.sql) && types.columns.some((c) => /GEN\.Value/i.test(c.source)));

  // Keyed the same way as every other SIS table in this codebase.
  check("behavior_log keys on student_number, like psRoster and psGrades",
    logAliases[0] === "student_number");
  check("behavior_log requires an explicit date window",
    log.args.includes("startdate") && log.args.includes("enddate"));
  check("the window is half open so a last day entry is counted exactly once",
    /TO_DATE\(:enddate[^)]*\)\s*\+\s*1/i.test(log.sql));
  check("behavior_log restricts to currently enrolled students",
    /ENROLL_STATUS\s*=\s*0/i.test(log.sql));

  // Rule 3 of the query file: never hardcode a log type integer.
  check("no query hardcodes a LOGTYPEID integer",
    !/LOGTYPEID\s*(=|IN)\s*[-(]?\s*\d/i.test(types.sql + log.sql));
  check("the type name comes from a LEFT JOIN to GEN, so nothing is dropped",
    /LEFT JOIN\s+GEN/i.test(log.sql));

  // The marker used to be built twice: once in Oracle with a string
  // concatenation and once in psBehavior.ts as a constant. One literal in two
  // languages drifts. It now exists only in the module, which also removes the
  // last use of ||, a construct with no precedent in the seven live queries.
  check("the UNMAPPED marker is NOT built in SQL, so it lives in exactly one place",
    !log.sql.includes(UNMAPPED_PREFIX) && !types.sql.includes(UNMAPPED_PREFIX));
  check("no behavior query uses string concatenation, which has no live precedent",
    !/\|\|/.test(log.sql) && !/\|\|/.test(types.sql));

  // Deterministic paging. PowerSchool pages with pagesize and page, and an
  // unordered Oracle result set can repeat or skip a row across a boundary.
  check("both behavior queries order deterministically",
    types.orderBy.length > 0 && log.orderBy.length > 0);
}

// ---------------------------------------------------------------------------
console.log("\n11. The access request ask matches what the queries actually read");
// ---------------------------------------------------------------------------
{
  // The most error prone step in this whole handoff: a column gets added to a
  // query and the matching <field> line never makes it into plugin.xml. The
  // symptom is a 403 that names a column nobody remembers adding.
  const plugin = readFileSync(PLUGIN_XML, "utf8");
  const doc = readFileSync(DOC, "utf8");
  const granted = new Set(
    [...plugin.matchAll(/<field\s+table="([^"]+)"\s+field="([^"]+)"/g)]
      .map((m) => `${m[1]}.${m[2]}`.toLowerCase()),
  );
  // The doc's proposed block uses the same <field table= field= /> form.
  const proposed = new Set(
    [...doc.matchAll(/<field\s+table="([^"]+)"\s+field="([^"]+)"/g)]
      .map((m) => `${m[1]}.${m[2]}`.toLowerCase()),
  );

  const needed = [...new Set(behavior.flatMap((q) => q.columns.map((c) => c.source.toLowerCase())))];
  const uncovered = needed.filter((n) => !granted.has(n) && !proposed.has(n));
  check("every column the behavior queries declare is granted already or asked for in the doc",
    uncovered.length === 0, `uncovered: ${uncovered.join(", ")}`);

  check("the doc asks for LOG and GEN, which plugin.xml does not grant today",
    [...proposed].some((f) => f.startsWith("log.")) && [...proposed].some((f) => f.startsWith("gen.")));

  // Anti overreach. A field the queries never touch is a field nobody has a
  // reason to hold, and asking a SIS admin for one costs credibility on the
  // ones that matter. LOG.StudentID is the case this has to allow: the join
  // needs it, the columns block does not declare it.
  const behaviorText = readFileSync(BEHAVIOR_XML, "utf8").toUpperCase();
  const overreach = [...proposed].filter((p) => {
    const [table, column] = p.split(".");
    if (!["log", "gen", "students"].includes(table)) return true;
    return !behaviorText.includes(column.toUpperCase());
  });
  check("the doc asks for nothing the behavior queries do not touch",
    overreach.length === 0, overreach.join(", "));
  // FullAccess is the ONLY access value that can carry a write; the plugin XSD
  // enumerates exactly ViewOnly and FullAccess and nothing else. The word may
  // appear in the doc's prose; it may never appear as a grant.
  check("every field the doc proposes is ViewOnly",
    !/access="FullAccess"/.test(doc) &&
      [...doc.matchAll(/<field\s+table="[^"]+"\s+field="[^"]+"\s+access="([^"]+)"/g)]
        .every((m) => m[1] === "ViewOnly"));
  check("the doc does not ask for LOG.Entry or LOG.Subject",
    ![...proposed].includes("log.entry") && ![...proposed].includes("log.subject"));
}

// ---------------------------------------------------------------------------
console.log("\n12. Dates are canonicalized with no Date object anywhere near them");
// ---------------------------------------------------------------------------
{
  // An Oracle date parsed into a JavaScript Date in one timezone and
  // re-serialized in another is how a Friday incident becomes a Thursday one. A
  // discipline record dated a day early is the kind of error nobody notices and
  // nobody can defend, so this is pure string work.
  check("the happy path passes through", canonicalDate("2026-09-03") === "2026-09-03");
  check("an ISO timestamp loses its time, not its day",
    canonicalDate("2026-09-03T00:00:00.000Z") === "2026-09-03");
  check("a space separated timestamp works too",
    canonicalDate("2026-09-03 14:22:01") === "2026-09-03");

  // These shapes are no longer a fallback, they are the design. The SQL returns
  // the four date columns raw, exactly like TERMS.FIRSTDAY and
  // PGFINALGRADES.LASTGRADEUPDATE already come back from live queries.
  check("Oracle's default DD-MON-YY is understood", canonicalDate("11-AUG-26") === "2026-08-11");
  check("Oracle's four digit variant too", canonicalDate("3-Sep-2026") === "2026-09-03");
  check("the two digit pivot follows Oracle's own RR convention",
    canonicalDate("01-JAN-49") === "2049-01-01" && canonicalDate("01-JAN-50") === "1950-01-01");
  check("slashes are understood", canonicalDate("2026/09/03") === "2026-09-03");

  check("an unreadable date is refused, not guessed at",
    canonicalDate("next Tuesday") === undefined && canonicalDate("09/03/2026") === undefined);
  check("an empty or missing date is undefined",
    canonicalDate("") === undefined && canonicalDate(null) === undefined &&
      canonicalDate(undefined) === undefined);
  check("a nonsense month name is refused rather than mapped to January",
    canonicalDate("11-ZZZ-26") === undefined);

  // The string ordering the rollup depends on only works on a canonical form.
  check("canonical dates sort correctly as plain strings",
    ["2026-09-03", "2026-08-30", "2026-12-01"].sort().join(",") ===
      "2026-08-30,2026-09-03,2026-12-01");

  const src = readFileSync(MODULE, "utf8");
  check("the module never constructs a Date, so no timezone can shift a day",
    !/new Date\(/.test(src) && !/Date\.parse/.test(src));
}

// ---------------------------------------------------------------------------
console.log("\n13. A subtype code is never shown as if it were a name");
// ---------------------------------------------------------------------------
{
  // The admin docs say a subtype is a code plus a description and do NOT say
  // which GEN column holds which. Rather than guess a join in SQL, both are
  // selected and the index accepts either as the key.
  const vocabulary = [
    { genId: "10", genCat: "subtype", genName: "Defiance", genValue: "DEF", entriesAllTime: 4 },
    { genId: "11", genCat: "subtype", genName: "Dress Code", genValue: "DC", entriesAllTime: 1 },
    { genId: "404", genCat: "logtype", genName: "Merits", genValue: "MER", entriesAllTime: 9 },
  ];
  const index = buildSubtypeIndex(vocabulary);

  check("a code resolves through GEN.Value", resolveSubtype("DEF", index).name === "Defiance");
  check("and through GEN.Name, whichever column this district actually uses",
    resolveSubtype("Dress Code", index).name === "Dress Code");
  check("resolution is case insensitive", resolveSubtype("def", index).resolved === true);
  check("the raw code is always preserved alongside the name",
    resolveSubtype("DEF", index).code === "DEF");

  const unknown = resolveSubtype("OOS", index);
  check("an unresolved code says so rather than posing as a name",
    unknown.resolved === false && unknown.name === null && unknown.code === "OOS");
  check("with no vocabulary loaded at all, nothing is resolved and nothing is invented",
    resolveSubtype("DEF", null).resolved === false &&
      resolveSubtype("DEF", null).name === null);
  check("no subtype at all is null, not an empty resolution",
    resolveSubtype(undefined, index) === null && resolveSubtype("", index) === null);
  check("a logtype row does not leak into the subtype index",
    resolveSubtype("MER", index).resolved === false, "MER is a logtype, not a subtype");

  // The staff view returns the object, so a caller cannot print a bare code by
  // accident: to render it they have to look at `resolved`.
  const row = { studentNumber: "1", logEntryId: "a", entryDate: "2026-09-03", logTypeName: "Discipline", subtype: "DEF" };
  check("the staff view hands back a resolved object, not a string",
    typeof staffBehaviorView(row, index).subtype === "object" &&
      staffBehaviorView(row, index).subtype.name === "Defiance");
  check("and reports resolved:false when the vocabulary cannot explain the code",
    staffBehaviorView({ ...row, subtype: "ZZZ" }, index).subtype.resolved === false);
}

// ---------------------------------------------------------------------------
console.log("\n14. One pull produces one report, including what it refused");
// ---------------------------------------------------------------------------
{
  const report = ingestReport([
    { student_number: "1", log_entry_id: "a", entry_date: "2026-09-03" },
    // dropped: no entry id
    { student_number: "2", entry_date: "2026-09-03" },
    // dropped: unreadable date
    { student_number: "3", log_entry_id: "c", entry_date: "whenever" },
    // kept, but the free text alarm fires and the non-code action is dropped
    {
      student_number: "4", log_entry_id: "d", entry_date: "2026-09-04",
      entry: "narrative", action_taken: "Suspended for fighting with Jose",
    },
  ]);

  check("every input row is counted", report.received === 4);
  check("kept rows are the ones that could be attributed", report.rows.length === 2);
  check("dropped rows are counted rather than silently lost", report.dropped === 2);
  check("free text keys are reported, not thrown on",
    report.freeTextKeys.includes("entry"), report.freeTextKeys.join(","));
  check("an action value that is really prose is counted so a human looks",
    report.nonCodeActionTaken === 1);
  check("and that row still lands, minus the field it could not trust",
    report.rows[1].actionTaken === undefined && report.rows[1].logEntryId === "d");
  check("the refused prose is COUNTED, never echoed into the report",
    !JSON.stringify(report).includes("Jose"), "reporting the value would move the thing it refused");
  check("an empty pull is an empty report, not a crash",
    ingestReport([]).received === 0 && ingestReport(undefined).rows.length === 0);

  // The SQL no longer formats the date, so the raw Oracle shape is now
  // discovered on the first sync. A date literal is not PII, and knowing the
  // exact shape is the difference between a five minute fix and an afternoon.
  const oddDates = ingestReport([
    { student_number: "1", log_entry_id: "a", entry_date: "1756944000000" },
    { student_number: "2", log_entry_id: "b", entry_date: "1756944000000" },
    { student_number: "3", log_entry_id: "c", entry_date: "Wed Sep 03 2026" },
    { student_number: "4", log_entry_id: "d", entry_date: "2026-09-03 00:00:00.0" },
  ]);
  check("an unreadable date shape names itself in the report",
    oddDates.unreadableDateSamples.includes("1756944000000"),
    oddDates.unreadableDateSamples.join(" | "));
  check("samples are distinct, so one bad shape is not repeated 3000 times",
    oddDates.unreadableDateSamples.length === 2,
    oddDates.unreadableDateSamples.join(" | "));
  check("a shape canonicalDate CAN read is not reported as unreadable",
    !oddDates.unreadableDateSamples.some((s) => s.startsWith("2026-09-03")) &&
      oddDates.rows.length === 1);
  check("the sample list is capped, so a fully broken pull is a diagnostic not a dump",
    ingestReport(
      Array.from({ length: 50 }, (_, i) => ({
        student_number: String(i), log_entry_id: String(i), entry_date: `garbage-${i}`,
      })),
    ).unreadableDateSamples.length === 3);
  check("and each sample is truncated",
    ingestReport([{ student_number: "1", log_entry_id: "a", entry_date: "z".repeat(200) }])
      .unreadableDateSamples[0].length === 40);
}

// ---------------------------------------------------------------------------
console.log("\n15. Which SQL constructs have live precedent on this instance");
// ---------------------------------------------------------------------------
{
  // Not a pass/fail on style. A standing measurement of how much of the new SQL
  // is built from shapes already proven to work on lapf.powerschool.com, so the
  // pre-flight in docs/behavior-sourcing.md tests the right two things instead
  // of everything.
  const liveText = stripXmlComments(readFileSync(LIVE_XML, "utf8"));
  const newText = stripXmlComments(readFileSync(BEHAVIOR_XML, "utf8"));
  const has = (t, re) => re.test(t);

  const constructs = [
    ["flattened=\"true\"", /flattened="true"/],
    ["coreTable=\"schools\"", /coreTable="schools"/],
    ["coreTable=\"students\"", /coreTable="students"/],
    ["NVL(", /NVL\(/i],
    ["LEFT JOIN a derived table", /LEFT JOIN\s*\(/i],
    ["COUNT( with GROUP BY", /COUNT\(/i],
    ["TRUNC(SYSDATE)", /TRUNC\(SYSDATE\)/i],
    ["TO_CHAR(", /TO_CHAR\(/i],
    ["TO_DATE(", /TO_DATE\(/i],
    ["string concatenation ||", /\|\|/],
  ];

  const unprecedented = [];
  for (const [name, re] of constructs) {
    const inNew = has(newText, re);
    const inLive = has(liveText, re);
    if (inNew && !inLive) unprecedented.push(name);
    console.log(
      `        ${name.padEnd(28)} live=${inLive ? "yes" : "no "} new=${inNew ? "yes" : "no "}` +
        (inNew && !inLive ? "   <-- NO LIVE PRECEDENT" : ""),
    );
  }

  // The whole point of measuring: keep the untested surface small and named.
  // TO_CHAR is gone. Three columns on this instance already come back as raw
  // Oracle dates and sisAction.ts carries them as strings, so formatting in SQL
  // bought nothing and cost the one thing worth conserving, which is the size
  // of the surface a human has to test by hand before the plugin can ship.
  check("the only construct without live precedent is TO_DATE, in the window predicate",
    unprecedented.length === 1 && unprecedented.includes("TO_DATE("),
    unprecedented.join(", "));
  check("TO_CHAR is gone from both queries",
    !/TO_CHAR\(/i.test(newText));
  check("the live queries really do return raw Oracle dates, which is the precedent",
    /TERMS\.FIRSTDAY/i.test(readFileSync(LIVE_XML, "utf8")) &&
      !/TO_CHAR\(/i.test(liveText));
  check("repeated bind variables are proven live, so they are not a risk here",
    (liveText.match(/:schoolid/g) ?? []).length > 1);
  check("the doc names the query tester step as a blocking gate",
    /query tester/i.test(readFileSync(DOC, "utf8")));
}

// ---------------------------------------------------------------------------
console.log("\n16. The live probe, recorded so nobody has to rerun it to trust it");
// ---------------------------------------------------------------------------
{
  const doc = readFileSync(DOC, "utf8");

  // The load bearing premise. PowerSchool ships two independent behavior models
  // and the reference is explicit that Incident Management, not log entries, is
  // the administrator side and state reporting source. If Westbrook used that
  // one, every artifact in this piece would point at the wrong table.
  check("the doc records the measured LOG row count", doc.includes("16987"));
  check("the doc records the measured INCIDENT row count against it",
    /\bincident\b[\s\S]{0,400}\b13\b/i.test(doc));
  check("the doc states the count endpoint needs no grant, which is why this was cheap",
    /count/i.test(doc) && /without a grant|no grant/i.test(doc));
  check("the doc is honest that the counts are district wide, not school scoped",
    /district wide/i.test(doc));

  // The two dead leads, both measured rather than assumed.
  check("the doc records that /ws/v1 is closed to this plugin",
    doc.includes("accessLevelV1Api"));
  check("the doc records that the Students alert columns do not exist here",
    /alert/i.test(doc) && /not valid column|do not exist|absent/i.test(doc));

  // The wiring that was a tautology last round. The proposed diff must pass a
  // real principal, never a literal.
  check("the doc's wiring never passes a string literal to the audience gate",
    !/behaviorAudienceFor\(\s*["']/.test(doc), "a literal argument is the tautology");
  check("the doc's wiring never passes a string literal as the principal",
    !/readBehaviorForStudent\(\s*ctx\s*,\s*["']/.test(doc));
  check("the doc's wiring passes an identity resolved from the request",
    /readBehaviorForStudent\(ctx, id, studentNumber\)/.test(doc) &&
      /requireIdentity/.test(doc));
}

// ---------------------------------------------------------------------------
console.log("\n17. OPEN HAZARD: the plugin zip still contains an unrunnable query");
// ---------------------------------------------------------------------------
{
  // build-plugin.mjs packages the whole powerschool/plugin directory with
  // `zip -r .`, so it sweeps up every file in queries_root without naming any
  // of them. Plugin 1.0.6 is authenticating to a production SIS for 641
  // students right now, and the 1.0.0 SECTIONMEETING precedent says a bad file
  // can get the whole upload rejected.
  //
  // The previous round encoded this as an assertion that FAILED on purpose.
  // That was worse than useless: package.json's test script does not run this
  // file and there is no .github/workflows, so the red test was as inert as the
  // comment it replaced while making the suite look broken. It is now a REPORT,
  // and the escalation goes to the human running the handoff, in the report
  // this piece returns and in the go/no go list at the end of the doc.
  const BUILD = resolve(REPO, "powerschool/sync/scripts/build-plugin.mjs");
  const build = readFileSync(BUILD, "utf8");
  const plugin = readFileSync(PLUGIN_XML, "utf8");
  const doc = readFileSync(DOC, "utf8");

  const excluded = /behavior\.named_queries\.xml/.test(build);
  const granted = /<field\s+table="Log"/i.test(plugin) && /<field\s+table="Gen"/i.test(plugin);
  const sweeps = /\["-r",\s*"-q",\s*zipPath,\s*"\."/.test(build);
  const siblings = ["behavior.named_queries.xml", "expansion.named_queries.xml"]
    .filter((f) => existsSync(resolve(REPO, "powerschool/plugin/queries_root", f)));

  console.log(`        build-plugin.mjs zips the whole directory: ${sweeps ? "YES" : "no"}`);
  console.log(`        files it would sweep in: ${siblings.join(", ") || "none"}`);
  console.log(`        exclusion applied (diff 4): ${excluded ? "YES" : "NO"}`);
  console.log(`        Log and Gen granted:        ${granted ? "YES" : "NO"}`);
  if (sweeps && !excluded && !granted) {
    console.log(
      "        HAZARD OPEN. Do not run `npm run build:plugin` until proposed diff 4 in\n" +
        "        docs/behavior-sourcing.md is applied. Not asserted here on purpose: this\n" +
        "        file is not in npm test and there is no CI, so a red test protects nothing.",
    );
  }

  // What CAN be asserted from inside this piece: that the escalation exists,
  // is exact, and names both files rather than only this change's own.
  check("the doc carries the exact exclusion diff for build-plugin.mjs",
    /zipExcludes/.test(doc) && /queries_root\/behavior\.named_queries\.xml/.test(doc));
  check("and names the sibling file under the same hazard, which this piece does not own",
    /expansion\.named_queries\.xml/.test(doc));
  check("the doc tells the reader not to run build:plugin before applying it",
    /do not run `npm run build:plugin`/i.test(doc));
}

// ---------------------------------------------------------------------------
console.log("\n18. The table does not exist yet, and the module says so in words");
// ---------------------------------------------------------------------------
{
  // convex/schema.ts does not declare psBehaviorLog and this change may not
  // edit it, so every psBehaviorLog access throws TODAY. Without a guard the
  // sync dies inside Convex with a redacted "Server Error" and a request id,
  // and the reader has no way to know the cause is a diff sitting unapplied in
  // a markdown file. These are run against a fake ctx, so they exercise the
  // real function rather than asserting on its source.
  const schema = readFileSync(resolve(REPO, "convex/schema.ts"), "utf8");
  const declared = new RegExp(`\\b${BEHAVIOR_TABLE}\\s*:\\s*defineTable`).test(schema);
  console.log(`        ${BEHAVIOR_TABLE} declared in convex/schema.ts: ${declared ? "YES" : "NO"}`);

  const MISSING = "Table 'psBehaviorLog' not found in schema";
  const ctx = {
    db: {
      query(table) {
        if (table === BEHAVIOR_TABLE) throw new Error(MISSING);
        // appState, which does exist. Nothing has ever written coverage.
        return { withIndex: () => ({ unique: async () => null, collect: async () => [] }) };
      },
    },
  };

  const staff = { kind: "staff", email: "teacher@westbrookacademy.org" };
  const read = await readBehaviorForStudent(ctx, staff, "11414");
  check("a read against the missing table does NOT throw at the page",
    read !== null && typeof read === "object");
  check("it is 'unknown', which is a state this contract already has",
    read.status === "unknown");
  check("with a null count, never 0, because nobody pulled anything",
    read.totalEntries === null && read.entries.length === 0);
  check("the reason names the file, the diff and the command to run",
    read.reason.includes("convex/schema.ts") &&
      read.reason.includes("docs/behavior-sourcing.md") &&
      read.reason.includes("codegen"),
    read.reason);
  check("and carries the underlying fault rather than hiding it behind a guess",
    read.reason.includes(MISSING), read.reason);
  check("the constant is exported so the sync and the read agree on the wording",
    typeof SCHEMA_DIFF_UNAPPLIED === "string" && SCHEMA_DIFF_UNAPPLIED.includes(BEHAVIOR_TABLE));

  // A denied caller is still denied first: the table's absence must not become
  // an accidental disclosure channel, and "denied" must not be softened into
  // "unknown" just because the storage is missing.
  const denied = await readBehaviorForStudent(ctx, { kind: "student", email: "k@x.org" }, "11414");
  check("a student is refused before the table is ever touched", denied.status === "denied");

  // And the same function against a ctx where the table DOES exist, which is
  // the state after diff 1 lands. Without this the guard above could be hiding
  // a read path that never worked, and the whole module would be untested end
  // to end rather than only unwired.
  {
    const coverage = {
      windowStart: "2026-08-12", windowEnd: "2026-09-30",
      syncedAt: "2026-09-30T13:00:00.000Z", entriesLoaded: 2,
    };
    const stored = [
      { studentNumber: "11414", logEntryId: "a", entryDate: "2026-09-01",
        logTypeName: "Discipline", subtype: "DEF", consequence: "Detention" },
      { studentNumber: "11414", logEntryId: "b", entryDate: "2026-09-05",
        logTypeName: "Merits" },
    ];
    const vocabulary = [
      { genId: "10", genCat: "subtype", genName: "Defiance", genValue: "DEF", entriesAllTime: 4 },
    ];
    const liveCtx = {
      db: {
        query(table) {
          if (table === BEHAVIOR_TABLE) {
            return { withIndex: () => ({ collect: async () => stored }) };
          }
          return {
            withIndex: (_i, builder) => {
              // Which appState row is being asked for, by the key the caller
              // binds. Two different rows come back from one fake table.
              let key = null;
              builder({ eq: (_f, v) => { key = v; return {}; } });
              const value = key === "psBehaviorTypes" ? vocabulary : coverage;
              return { unique: async () => ({ _id: key, key, value }) };
            },
          };
        },
      },
    };

    const live = await readBehaviorForStudent(liveCtx, staff, "11414");
    check("with the table present the read is 'covered', not 'unknown'",
      live.status === "covered" && live.reason === null);
    check("it counts what it stored", live.totalEntries === 2 && live.entries.length === 2);
    check("newest first, so the timeline opens on what the teacher came for",
      live.entries[0].date === "2026-09-05");
    check("the window and sync time come from the coverage record",
      live.window.start === "2026-08-12" && live.syncedAt === coverage.syncedAt);
    check("the subtype code is resolved against the stored vocabulary",
      live.entries[1].subtype.name === "Defiance" && live.entries[1].subtype.resolved === true);
    check("and the entries come through the staff allowlist, carrying no student number",
      !JSON.stringify(live.entries).includes("11414"));
  }

  // The write side takes the opposite decision on purpose: a sync that cannot
  // store must stop, loudly, rather than report success over an empty database.
  const src = readFileSync(MODULE, "utf8");
  check("replaceWindow throws a ConvexError, which Convex does NOT redact in production",
    /throw schemaError\(err\)/.test(src) && /new ConvexError\(/.test(src));
  check("both psBehaviorLog accesses go through the guard, none is left bare",
    (src.match(/BEHAVIOR_TABLE/g) ?? []).length >= 4 &&
      !/\.query\("psBehaviorLog"\)/.test(src) && !/\.insert\("psBehaviorLog"/.test(src));
}

// ---------------------------------------------------------------------------
console.log("\n19. The free text claim is qualified everywhere it is made");
// ---------------------------------------------------------------------------
{
  // The previous round asserted "NO FREE TEXT LEAVES THE SIS" in four places
  // while shipping Discipline_ActionTaken behind a 79 character cap, which
  // cannot exclude a 48 character sentence naming a second child. An absolute
  // claim in a document a SIS admin reads while approving an access request is
  // not a wording problem. All four places are checked mechanically here so the
  // absolute cannot creep back into one of them.
  const places = [
    ["behavior.named_queries.xml", BEHAVIOR_XML],
    ["psBehavior.ts", MODULE],
    ["behavior-sourcing.md", DOC],
  ];
  for (const [label, path] of places) {
    const t = readFileSync(path, "utf8");
    check(`${label} does not make the absolute claim`,
      !/NO FREE TEXT LEAVES THE SIS/i.test(t) && !/no free text is read/i.test(t));
    check(`${label} names the column that qualifies it`,
      /Discipline_ActionTaken/i.test(t));
  }
  const doc = readFileSync(DOC, "utf8");
  // The fourth place: the schema.ts comment, which lives inside the doc as a
  // proposed diff and is what an admin reads when approving the ask.
  const schemaDiff = doc.slice(doc.indexOf("psBehaviorLog: defineTable") - 2400,
    doc.indexOf("psBehaviorLog: defineTable"));
  check("the proposed schema.ts comment carries the qualifier, not the absolute",
    !/NO FREE TEXT\./.test(schemaDiff) && /shape/i.test(schemaDiff) &&
      /Discipline_ActionTaken/i.test(schemaDiff),
    "an admin reads this block while deciding whether to approve the access request");
  check("the doc states the limit a shape guard cannot fix",
    /single (bare )?token/i.test(doc) && /cannot/i.test(doc));
  check("the module states it too, next to the guard itself",
    /bare token/i.test(readFileSync(MODULE, "utf8")));
}

// ---------------------------------------------------------------------------
console.log("\n20. House rules");
// ---------------------------------------------------------------------------
{
  const EM_DASH = String.fromCharCode(8212);
  for (const [label, path] of [
    ["behavior.named_queries.xml", BEHAVIOR_XML],
    ["psBehavior.ts", MODULE],
    ["behavior-sourcing.md", DOC],
    ["psBehavior.test.mjs", resolve(HERE, "psBehavior.test.mjs")],
  ]) {
    check(`${label} contains no em dash`, !readFileSync(path, "utf8").includes(EM_DASH));
  }
  // A public repo. Client ids ship in page source; secrets never do.
  const suspicious = /(client[_-]?secret|deploy[_-]?key)\s*[:=]\s*["'][^"']{8,}/i;
  for (const [label, path] of [["behavior.named_queries.xml", BEHAVIOR_XML], ["psBehavior.ts", MODULE], ["behavior-sourcing.md", DOC]]) {
    check(`${label} carries no secret`, !suspicious.test(readFileSync(path, "utf8")));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
process.exit(fail ? 1 : 0);
