/**
 * PowerSchool WRITE client for Wildcat Hub.
 *
 * Built complete, tested against a local fake, and DISARMED. It can express
 * every write this project could ever legitimately want, and it refuses to put
 * any of them on the wire until four independent gates are opened deliberately.
 *
 * WHAT IT CAN EXPRESS
 *   create a behavior log entry      POST /ws/schema/table/log
 *   update a behavior log entry      PUT  /ws/schema/table/log/{dcid}
 *   retract a behavior log entry     PUT  (an edit, never a DELETE)
 *
 * WHAT IT REFUSES TO EXPRESS AT ALL
 *   DELETE anywhere. Nothing in Wildcat Hub should be able to remove a SIS row.
 *   Any table other than `log`. That single-entry allowlist is what makes
 *   "PowerSchool is authoritative for enrollment" a fact rather than a promise:
 *   students, cc, sections, courses, terms, attendance, pgfinalgrades and the
 *   whole /ws/v1 resource surface are simply unreachable from this file.
 *   Any U_ extension table. An app-owned U_ table is the only write target a
 *   third party can create from scratch, and it is still the wrong thing to
 *   build here: 6,616,500 of earned Wildcat Cash has no SIS counterpart, and
 *   mirroring it into PowerSchool would create a second authority for a number
 *   the SIS never generated. Declined on principle, not on access.
 *
 * THE FOUR GATES, all of which must be open before a byte leaves this process
 *   1. ARMING.   PS_WRITE_ENABLED must equal the exact literal
 *                "enable-powerschool-writes". Absent or anything else refuses.
 *   2. GRANT.    Every column in the payload must carry access="FullAccess" in
 *                powerschool/plugin/plugin.xml, and that file is the ONLY
 *                admissible answer: for any non loopback target the installed
 *                plugin.xml is re-read from disk and a caller supplied index is
 *                ignored, its version must match INSTALLED_PLUGIN_VERSION, and
 *                a grantsPath whose basename is not plugin.xml is refused at
 *                construction. Today all 107 declared fields are ViewOnly and
 *                LOG is not declared at all, so this gate is shut by the plugin
 *                itself. It is checked by READING the granted access request,
 *                never by attempting a write.
 *                This gate still only reads a FILE. The authority is a
 *                PowerSchool admin, and no code in this repository can stand in
 *                for one. See docs/write-path.md section 4.
 *   3. HOST.     A host with no sandbox marker additionally needs
 *                PS_WRITE_ALLOW_PRODUCTION_HOST=yes. This gate now outranks
 *                gates 1 and 2 in the refusal precedence, so it can actually
 *                fire; a previous round ordered it last, which made
 *                ProductionHostBlocked unreachable under every configuration.
 *   4. CEILING.  PS_WRITE_CEILING caps mutating requests per process, default
 *                25, so a runaway loop cannot spray a thousand log entries.
 *
 * EVERY GATE READS THE URL ON THE WIRE, NOT THE CLIENT'S BASE URL.
 * A previous round decided "am I talking to a local fake?" from this.baseUrl
 * and compared the request URL to it with startsWith(). A reviewer bound a
 * client to http://127.0.0.1, handed it the URL
 * http://127.0.0.1@lapf.powerschool.com/ws/schema/table/log, and every gate
 * agreed it was talking to a loopback fake while fetch() resolved the host
 * lapf.powerschool.com, the production SIS. The production host was hiding in
 * the URL's userinfo component, which startsWith cannot see. The target is now
 * PARSED and compared by ORIGIN (protocol, hostname, port), a URL carrying
 * embedded credentials is refused outright, and loopback status is decided by
 * the parsed hostname of the request. See preflight().
 *
 * AND WHAT THE GATES JUDGE IS WHAT THE WIRE CARRIES.
 * send() takes a plain object, so request.table and request.columns are claims.
 * Gate 1c re-derives the table from the URL path and from the body envelope,
 * re-runs the allowlists against the body's own column set, and requires all
 * three to agree. The request is materialised once before any gate runs, so a
 * getter cannot answer loopback for the gates and production for fetch(). Both
 * the token call and the write call set redirect: "error", because a 3xx would
 * carry the POST, the bearer token and the body to a host no gate examined.
 *
 * The rendering half (`renderCreate`, `renderUpdate`, `renderRetract`) reads no
 * environment, opens no socket, and always works. That is deliberate: a human
 * can print the exact request this client would send and eyeball it long before
 * anybody considers enabling it. See docs/write-path.md.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { productionRisk } from "./config.ts";

// ---------------------------------------------------------------------------
// Errors. One class per refusal reason so a caller can tell them apart and a
// test can assert on the specific gate rather than on a message string.
// ---------------------------------------------------------------------------

export class WriteDisarmed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteDisarmed";
  }
}
export class GrantMissing extends Error {
  readonly missing: GrantCheckRow[];
  constructor(message: string, missing: GrantCheckRow[]) {
    super(message);
    this.name = "GrantMissing";
    this.missing = missing;
  }
}
export class ForbiddenTarget extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenTarget";
  }
}
export class PayloadRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadRejected";
  }
}
/**
 * Gate 3 refused the target. Reachable: it sits in tier 2 of the refusal
 * precedence in `send()`, above arming and above the grant check. A previous
 * round ordered it last and it could not fire under any configuration.
 */
export class ProductionHostBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionHostBlocked";
  }
}
export class WriteCeilingReached extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteCeilingReached";
  }
}

// ---------------------------------------------------------------------------
// Gate 1: arming.
// ---------------------------------------------------------------------------

export const WRITE_ENABLE_VAR = "PS_WRITE_ENABLED";
/**
 * Deliberately not "1", "true" or "yes". A generic truthy value is the kind of
 * thing that gets set by a CI template or copied from another project. This
 * literal can only appear because somebody typed it on purpose, and it greps
 * cleanly across the repo and the deployment config.
 */
export const WRITE_ENABLE_VALUE = "enable-powerschool-writes";
export const WRITE_PRODUCTION_HOST_VAR = "PS_WRITE_ALLOW_PRODUCTION_HOST";
export const WRITE_CEILING_VAR = "PS_WRITE_CEILING";
export const DEFAULT_WRITE_CEILING = 25;

export type ArmingState = { armed: boolean; reason: string };

export function armingState(env: Record<string, string | undefined>): ArmingState {
  const raw = env[WRITE_ENABLE_VAR];
  if (raw === undefined || raw.trim() === "") {
    return {
      armed: false,
      reason: `${WRITE_ENABLE_VAR} is not set. The write client refuses every mutating verb by default.`,
    };
  }
  if (raw.trim() !== WRITE_ENABLE_VALUE) {
    return {
      armed: false,
      reason: `${WRITE_ENABLE_VAR} is set to something other than the exact literal "${WRITE_ENABLE_VALUE}". Refusing.`,
    };
  }
  return { armed: true, reason: `${WRITE_ENABLE_VAR} carries the exact arming literal.` };
}

// ---------------------------------------------------------------------------
// Gate 2: the granted access request, read from plugin.xml.
//
// This is how the project proves writes are blocked. Not by firing a POST at a
// production instance holding real student records and seeing what comes back,
// which is a test that mutates a child's file if it unexpectedly passes, but by
// reading the document that decides the answer.
// ---------------------------------------------------------------------------

export type AccessLevel = "ViewOnly" | "FullAccess";

/**
 * Where a grant index came from.
 *
 * "installed" means it was parsed from the one file in this repo that tracks
 * the plugin PowerSchool actually has installed. "override" means a caller
 * chose the file or built the index itself, which is useful for tests and
 * for cross-checking a proposed grant, and is never evidence about production.
 *
 * This distinction is load bearing. A previous round of this client accepted
 * any `grantsPath`, and a reviewer opened every gate by pointing it at
 * powerschool/plugin/plugin-v2.xml, a proposed grant sitting in the working
 * tree that PowerSchool has never seen. See `assertProductionGrantSource`.
 */
export type GrantSource = "installed" | "override";

export type GrantIndex = {
  sourcePath: string;
  source: GrantSource;
  pluginVersion: string | null;
  /** Key is `table.field`, lowercased. PowerSchool matches case insensitively. */
  fields: Map<string, AccessLevel>;
  counts: { total: number; viewOnly: number; fullAccess: number; tables: number };
};

/**
 * The single file that stands in for "what PowerSchool has installed". Not a
 * default, a binding: nothing else can authorise a write to a real host.
 */
export const INSTALLED_PLUGIN_XML = fileURLToPath(
  new URL("../../plugin/plugin.xml", import.meta.url),
);

const DEFAULT_PLUGIN_XML = INSTALLED_PLUGIN_XML;

/**
 * The plugin version a human has confirmed is installed and enabled on the
 * live instance, recorded here because NOTHING in this repository can verify
 * it. The working tree is not the SIS. Editing plugin.xml, even correctly,
 * changes nothing on lapf.powerschool.com until an admin uploads the zip and
 * disables and re-enables the plugin.
 *
 * The write path refuses to treat plugin.xml as authority when the file's
 * version differs from this constant, so applying a proposed grant locally
 * does not quietly become permission to write. Updating this line is a code
 * change a reviewer sees, and it is still only half the job: the other half
 * happens inside PowerSchool, by a person this repo has no access to.
 */
export const INSTALLED_PLUGIN_VERSION = "1.0.6";

/**
 * Parses the <access_request> block of a plugin.xml.
 *
 * Comments are stripped first. A <field> element sitting inside an XML comment
 * is not a grant, and counting one would turn a commented-out line into a
 * silent write permission. Only the access_request block is considered, so a
 * <field> element elsewhere in the document cannot forge a grant either.
 */
export function parseAccessRequest(xml: string, sourcePath = "(string)"): GrantIndex {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, "");

  const versionMatch = /<plugin\b[^>]*\sversion\s*=\s*"([^"]*)"/i.exec(withoutComments);

  const blockMatch = /<access_request\b[^>]*>([\s\S]*?)<\/access_request\s*>/i.exec(
    withoutComments,
  );
  const block = blockMatch === null ? "" : blockMatch[1];

  const fields = new Map<string, AccessLevel>();
  const tables = new Set<string>();
  let viewOnly = 0;
  let fullAccess = 0;

  const fieldPattern = /<field\b([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null = fieldPattern.exec(block);
  while (match !== null) {
    const attrs = match[1];
    const table = attribute(attrs, "table");
    const field = attribute(attrs, "field");
    const access = attribute(attrs, "access");
    if (table !== null && field !== null) {
      const level: AccessLevel = access === "FullAccess" ? "FullAccess" : "ViewOnly";
      // An unrecognised or absent access attribute is treated as ViewOnly, the
      // safe direction. FullAccess is only ever recorded when it is written out
      // in full, because the XSD enumerates exactly two values and anything
      // else is a malformed file rather than an implied escalation.
      fields.set(`${table}.${field}`.toLowerCase(), level);
      tables.add(table.toLowerCase());
      if (level === "FullAccess") fullAccess += 1;
      else viewOnly += 1;
    }
    match = fieldPattern.exec(block);
  }

  return {
    sourcePath,
    // A grant index built from a string is by definition not the installed
    // plugin. Only loadAccessRequest reading the pinned path can claim that.
    source: "override",
    pluginVersion: versionMatch === null ? null : versionMatch[1],
    fields,
    counts: { total: fields.size, viewOnly, fullAccess, tables: tables.size },
  };
}

function attribute(attrs: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i");
  const found = pattern.exec(attrs);
  return found === null ? null : found[1];
}

/**
 * Reads a plugin.xml from disk.
 *
 * Only the pinned installed path yields source "installed". Every other path,
 * including a differently named file next to it, is an override and can never
 * authorise a write to a non loopback host.
 */
export function loadAccessRequest(path: string = INSTALLED_PLUGIN_XML): GrantIndex {
  const index = parseAccessRequest(readFileSync(path, "utf8"), path);
  return { ...index, source: path === INSTALLED_PLUGIN_XML ? "installed" : "override" };
}

/** The installed grant, re-read from disk. Never cached, never injected. */
export function installedGrant(): GrantIndex {
  return loadAccessRequest(INSTALLED_PLUGIN_XML);
}

/**
 * Gate 2's source binding, stated as one function so there is one place to
 * read and one place to test.
 *
 * Returns every reason the supplied grant index must not be treated as
 * evidence about the live instance. Empty means it may.
 */
export function grantSourceProblems(grants: GrantIndex): string[] {
  const problems: string[] = [];
  if (grants.source !== "installed" || grants.sourcePath !== INSTALLED_PLUGIN_XML) {
    problems.push(
      `grant-source: the grant index came from ${grants.sourcePath}, not from the installed ` +
        `plugin at ${INSTALLED_PLUGIN_XML}. A caller-chosen file proves nothing about what ` +
        `PowerSchool granted. Overrides are test-only and are honoured for a loopback target only.`,
    );
  }
  if (grants.pluginVersion !== INSTALLED_PLUGIN_VERSION) {
    problems.push(
      `grant-version: plugin.xml declares version ${grants.pluginVersion ?? "(none)"} but the ` +
        `version recorded as installed is ${INSTALLED_PLUGIN_VERSION}. The working tree has moved ` +
        `ahead of the SIS, or the record is stale. A human must confirm what is actually enabled ` +
        `on the instance and update INSTALLED_PLUGIN_VERSION in this file.`,
    );
  }
  return problems;
}

export type GrantCheckRow = {
  field: string;
  required: "FullAccess";
  current: AccessLevel | "not requested";
  ok: boolean;
};

/** Per column: what the write needs, and what the plugin currently grants. */
export function checkWriteGrant(
  grants: GrantIndex,
  table: string,
  columns: string[],
): GrantCheckRow[] {
  return columns.map((column) => {
    const key = `${table}.${column}`.toLowerCase();
    const current = grants.fields.get(key) ?? "not requested";
    return { field: `${table}.${column}`, required: "FullAccess", current, ok: current === "FullAccess" };
  });
}

export function assertWriteGrant(grants: GrantIndex, table: string, columns: string[]): void {
  // An empty column set is the vacuous case, and it used to pass. columns.map
  // over [] returns [], [] has no failures, and the gate reported ok with zero
  // blocks against production. A gate that approves what it cannot inspect is
  // not a gate. Refuse first, then check.
  if (columns.length === 0) {
    throw new GrantMissing(
      [
        "Refused: nothing to check.",
        "",
        "The request declared zero columns, so the grant check had no field to",
        "verify and would have reported success by vacuous truth. A write with",
        "no declared columns cannot be proven safe, so it is refused rather than",
        "waved through. Declare the columns you intend to write.",
        "",
        "Nothing was sent.",
      ].join("\n"),
      [],
    );
  }

  const rows = checkWriteGrant(grants, table, columns);
  const missing = rows.filter((row) => !row.ok);
  if (missing.length === 0) return;
  throw new GrantMissing(
    [
      `Blocked by the granted access request in ${grants.sourcePath}` +
        (grants.pluginVersion === null ? "" : ` (plugin version ${grants.pluginVersion})`) +
        `.`,
      `${missing.length} of ${rows.length} column(s) lack access="FullAccess":`,
      ...missing.map((row) => `  ${row.field}: ${row.current}`),
      "",
      "This is a documentary block, not a network result. Nothing was sent.",
      "Opening it needs a plugin.xml edit, a version bump, a re-upload, and a",
      "PowerSchool admin disabling and re-enabling the plugin. See docs/write-path.md.",
    ].join("\n"),
    missing,
  );
}

// ---------------------------------------------------------------------------
// The writable surface. Allowlists throughout, never denylists.
//
// A denylist fails open. The day somebody adds a table or a column, a denylist
// silently permits it and an allowlist silently refuses it. Refusing is the
// direction that cannot spend a child's money or corrupt a state report.
// ---------------------------------------------------------------------------

/** The only table this client can address. One entry, on purpose. */
export const WRITABLE_TABLES = ["log"] as const;

/**
 * The only LOG columns this client can write.
 *
 * Column names and length caps come from the PowerSchool Data Dictionary as
 * quoted in the project reference: Entry_Author String 30, Subject String 40,
 * Subtype String 20, Consequence String 20.
 *
 * DCID and ID are absent because the server assigns them.
 *
 * All 34 Discipline_* columns are absent, and that is the single most important
 * exclusion in this file. Those columns exist to satisfy the federal Gun-Free
 * Schools Act and feed state discipline reporting. A points dashboard writing
 * into them would inject app-generated data into a legally reportable record.
 * Wildcat Hub may write a behavior NOTE. It may never file a discipline RECORD.
 */
export const LOG_WRITABLE_COLUMNS = [
  "StudentID",
  "SchoolID",
  "TeacherID",
  "Entry_Date",
  "Entry_Time",
  "Entry_Author",
  "Subject",
  "Entry",
  "LogTypeID",
  "Subtype",
  "Consequence",
] as const;

export const COLUMN_MAX_LENGTH: Record<string, number> = {
  Entry_Author: 30,
  Subject: 40,
  Subtype: 20,
  Consequence: 20,
};

/** Present on a remote row means a human promoted the entry. See planUpdate. */
export const DISCIPLINE_COLUMN_PREFIX = "discipline_";

export const ALLOWED_WRITE_VERBS = ["POST", "PUT"] as const;
export type WriteVerb = (typeof ALLOWED_WRITE_VERBS)[number];

export function assertWritableTable(table: string): void {
  if (!(WRITABLE_TABLES as readonly string[]).includes(table.toLowerCase())) {
    throw new ForbiddenTarget(
      `Blocked write to table "${table}". The only writable table is ` +
        `${WRITABLE_TABLES.join(", ")}. PowerSchool is authoritative for enrollment ` +
        `and this client cannot address an enrollment table, a core resource, or a U_ extension table.`,
    );
  }
}

export function assertWritableColumns(columns: string[]): void {
  const allowed = new Set((LOG_WRITABLE_COLUMNS as readonly string[]).map((c) => c.toLowerCase()));
  const rejected = columns.filter((c) => !allowed.has(c.toLowerCase()));
  if (rejected.length > 0) {
    const discipline = rejected.filter((c) => c.toLowerCase().startsWith(DISCIPLINE_COLUMN_PREFIX));
    throw new ForbiddenTarget(
      [
        `Blocked column(s) not on the LOG write allowlist: ${rejected.join(", ")}.`,
        discipline.length > 0
          ? `${discipline.length} of them are Discipline_* columns. Wildcat Hub writes behavior notes, never discipline records that feed state reporting.`
          : "",
      ]
        .filter((line) => line !== "")
        .join(" "),
    );
  }
}

// ---------------------------------------------------------------------------
// Earned value must never cross into the SIS.
//
// THE CONTROLS ARE STRUCTURAL. There are exactly three, and they are the only
// things that should ever be cited as guarding hard rule 2:
//
//   1. BehaviorEntryInput carries no amount, no balance, no points field, so
//      there is no parameter through which a number could arrive.
//   2. No column on LOG_WRITABLE_COLUMNS could hold a balance. Every writable
//      column is an identifier, a date, an author, a type or free prose.
//   3. buildLogRow constructs the outgoing row key by key from known fields.
//      It never spreads the caller's object, so an extra property such as
//      wildcatCashBalance is dropped before a payload exists, and
//      assertWritableColumns re-checks the finished key set anyway.
//
// A reviewer smuggled wildcatCashBalance: 6616500, points: 999,
// Discipline_ActionTaken and DCID onto an input object; all four were gone
// before the payload existed. That is what holds.
//
// WHAT FOLLOWS IS LINT, NOT A CONTROL. The free-text scan below reads Subject
// and Entry looking for an obviously-stated amount. The same reviewer got 11
// of 11 adversarial phrasings past it, including "awarded 100", "student now
// has 1,250", "cash 5000" and "gave him 50 wc". Do not cite it as a guard, do
// not weaken anything above on the strength of it, and do not treat a pass as
// evidence of anything. It exists to catch the honest accident, a teacher
// typing "Deducted 100 Wildcat Cash for defiance" into the note, and it will
// miss a determined phrasing every time.
// ---------------------------------------------------------------------------

// \b on both ends so "point" inside "appointments" is not a value word.
const VALUE_WORD =
  "\\b(?:wildcat\\s*(?:cash|bucks)|wildcatcash|points?|tickets?|balance|dollars?|usd)\\b";

export const EARNED_VALUE_PATTERNS: RegExp[] = [
  // "100 points", "1,250 Wildcat Cash", "3 tickets"
  new RegExp(`\\d[\\d,.]*\\s*${VALUE_WORD}`, "i"),
  // "balance: 1250", "points -100", "Balance is now 1,250". Up to 12 NON-DIGIT
  // characters may sit between the word and the number, which is what catches
  // a sentence like "balance is now 1,250" that \W would miss because the
  // intervening words are word characters.
  new RegExp(`${VALUE_WORD}[^\\d]{0,12}[-+]?\\d`, "i"),
  // "$12", "$ 12"
  /\$\s*\d/,
];

export function findEarnedValueText(text: string): string | null {
  for (const pattern of EARNED_VALUE_PATTERNS) {
    const found = pattern.exec(text);
    if (found !== null) return found[0];
  }
  return null;
}

/**
 * Lint, not a control. Rejects the obvious phrasings and misses the rest.
 * Named so that nobody reading a call site mistakes it for a guarantee.
 */
function lintObviousEarnedValue(column: string, text: string): void {
  const hit = findEarnedValueText(text);
  if (hit === null) return;
  throw new PayloadRejected(
    `Blocked ${column}: the text carries what looks like an earned-value amount (${JSON.stringify(hit)}). ` +
      `The app is authoritative for points and PowerSchool never learns them. ` +
      `Describe the behavior, not the balance. ` +
      `(This check is lint over free text and catches only obvious phrasings. The controls that ` +
      `actually hold hard rule 2 are structural: no amount on the input type, no column that ` +
      `could hold one, and a row built key by key.)`,
  );
}

// ---------------------------------------------------------------------------
// Log types. Never hardcoded.
//
// LOG.LogTypeID points at a GEN row where Cat='logtype'. Those integers are
// district-defined and arbitrary; a published real district's mapping runs
// Merits=404, Contact=461, Medical=514, MTSS=24018 and a built-in negative
// -100000. Hardcoding one is how an integration files a "Medical" entry when it
// meant "Merit". So the input type demands a LogTypeRef carrying provenance,
// and a bare number is rejected by the type and by the runtime check.
// ---------------------------------------------------------------------------

export type LogTypeRef = {
  id: number;
  name: string;
  /** Must be "logtype". Proves the row came from the right GEN category. */
  cat: string;
  schoolId?: string | number;
  /** When GEN was read. A ref older than the freshness bound is refused. */
  readAtIso: string;
};

export type GenRow = Record<string, unknown>;

const LOG_TYPE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function pick(row: GenRow, ...names: string[]): unknown {
  const lower = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) lower.set(key.toLowerCase(), value);
  for (const name of names) {
    const value = lower.get(name.toLowerCase());
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Maps a log type NAME to this instance's id, from GEN rows read at runtime.
 * Throws on absence and on ambiguity rather than picking one, because picking
 * one silently files entries under the wrong classification forever.
 */
export function resolveLogType(genRows: GenRow[], name: string, readAtIso: string): LogTypeRef {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") throw new PayloadRejected("Log type name is empty.");

  const matches = genRows.filter((row) => {
    const cat = String(pick(row, "cat", "gen_cat") ?? "").trim().toLowerCase();
    const rowName = String(pick(row, "name", "gen_name") ?? "").trim().toLowerCase();
    return cat === "logtype" && rowName === wanted;
  });

  if (matches.length === 0) {
    throw new PayloadRejected(
      `No GEN row with Cat='logtype' and Name='${name}'. Log types are district ` +
        `configuration; read GEN from this instance and map by name. Never hardcode an id.`,
    );
  }

  const ids = new Set(matches.map((row) => Number(pick(row, "id", "gen_id"))));
  if (ids.size > 1) {
    throw new PayloadRejected(
      `Log type '${name}' resolves to ${ids.size} different ids (${[...ids].join(", ")}), ` +
        `probably one per school. Pass a school-scoped GEN read instead of guessing.`,
    );
  }

  const id = [...ids][0];
  if (!Number.isInteger(id)) {
    throw new PayloadRejected(`Log type '${name}' has a non-integer GEN id (${String(id)}).`);
  }

  const schoolId = pick(matches[0], "schoolid", "school_id", "gen_schoolid");
  return {
    id,
    name: String(pick(matches[0], "name", "gen_name")),
    cat: "logtype",
    schoolId: schoolId === undefined ? undefined : String(schoolId),
    readAtIso,
  };
}

function assertLogTypeRef(ref: LogTypeRef, now: Date, maxAgeMs: number): void {
  if (ref === null || typeof ref !== "object") {
    throw new PayloadRejected("logType must be a LogTypeRef resolved from GEN, not a number.");
  }
  if (ref.cat !== "logtype") {
    throw new PayloadRejected(
      `logType.cat is "${ref.cat}", expected "logtype". Only GEN rows in the logtype category classify a log entry.`,
    );
  }
  if (!Number.isInteger(ref.id)) {
    throw new PayloadRejected(`logType.id must be an integer, got ${String(ref.id)}.`);
  }
  const readAt = Date.parse(ref.readAtIso);
  if (!Number.isFinite(readAt)) {
    throw new PayloadRejected(`logType.readAtIso is not a parseable timestamp: ${String(ref.readAtIso)}.`);
  }
  const age = now.getTime() - readAt;
  if (age > maxAgeMs) {
    throw new PayloadRejected(
      `logType was read ${Math.round(age / 3_600_000)}h ago, older than the ` +
        `${Math.round(maxAgeMs / 3_600_000)}h freshness bound. Re-read GEN before writing.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Subtype and Consequence. Also never free strings.
//
// A reviewer caught these two being handled as free text capped at 20
// characters while LogTypeID got the full GEN treatment, which meant the client
// could file an entry under a classification this district never configured.
// The published admin docs are explicit that both are CONFIGURED MENU FIELDS:
//
//   Subtype      "Further characterization of a log entry associated to a
//                 specific LogType. By default, this field appears as a menu on
//                 the Log Entries page. To modify the field selections, see Log
//                 Types." Subtypes are created per log type as a code plus a
//                 description pair.
//   Consequence  "By default, this field appears as a menu on the Log Entries
//                 page", and the Data Dictionary says LOG.Consequence is
//                 "populated by a popup build from the Gen table
//                 cat=consequence".
//
// So both live in GEN, in their own Cat, exactly like logtype does, and both
// get the same discipline: resolved by name from rows read at runtime, refused
// on absence, refused on ambiguity, refused when stale, and for a subtype
// additionally bound to the log type it was resolved under.
//
// UNVERIFIED, and it must be confirmed against a real row before enabling:
// which GEN column supplies the STRING that LOG.Subtype and LOG.Consequence
// actually store. The columns are 20 characters wide, subtypes are documented
// as a code plus a description, and GEN carries Name as well as Value. This
// resolver prefers Value, then Code, then Name, and records which one it used
// in `valueColumn` so a human eyeballing the rendered request can see the
// choice rather than having to infer it.
// ---------------------------------------------------------------------------

export type GenValueCat = "subtype" | "consequence";

export type GenValueRef = {
  /** The exact string that would be written to the LOG column. */
  value: string;
  /** GEN.Name as read, for a human reading the rendered request. */
  name: string;
  /** Proves the row came from the right GEN category. */
  cat: GenValueCat;
  /** Which GEN column supplied `value`. See the UNVERIFIED note above. */
  valueColumn: string;
  schoolId?: string;
  /** Subtypes only: the log type this subtype was resolved under. */
  logTypeId?: number;
  logTypeName?: string;
  /** When GEN was read. A ref older than the freshness bound is refused. */
  readAtIso: string;
};

/** Candidate GEN columns for the string a LOG menu column stores, in order. */
const GEN_VALUE_COLUMNS = ["value", "code", "name"] as const;

function genWireValue(row: GenRow): { value: string; column: string } | null {
  for (const column of GEN_VALUE_COLUMNS) {
    const raw = pick(row, column, `gen_${column}`);
    if (raw === undefined || raw === null) continue;
    const text = String(raw).trim();
    if (text !== "") return { value: text, column };
  }
  return null;
}

function genSchoolId(row: GenRow): string | undefined {
  const raw = pick(row, "schoolid", "school_id", "gen_schoolid");
  return raw === undefined || raw === null || String(raw).trim() === "" ? undefined : String(raw);
}

/**
 * Maps a NAME to the string this instance stores for a GEN menu column.
 *
 * Same contract as resolveLogType, for the same reason: picking one of several
 * candidates silently files entries under the wrong classification forever, so
 * absence and ambiguity both throw.
 */
export function resolveGenValue(
  genRows: GenRow[],
  cat: GenValueCat,
  name: string,
  readAtIso: string,
  options: { schoolId?: string | number } = {},
): GenValueRef {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") throw new PayloadRejected(`${cat} name is empty.`);

  let matches = genRows.filter((row) => {
    const rowCat = String(pick(row, "cat", "gen_cat") ?? "").trim().toLowerCase();
    const rowName = String(pick(row, "name", "gen_name") ?? "").trim().toLowerCase();
    return rowCat === cat && rowName === wanted;
  });

  if (matches.length === 0) {
    throw new PayloadRejected(
      `No GEN row with Cat='${cat}' and Name='${name}'. ${cat === "subtype" ? "Subtypes" : "Consequences"} ` +
        `are district configuration, created in the PowerSchool UI, and this district may simply not ` +
        `have one by that name. Read GEN from this instance and map by name. Never send a free string.`,
    );
  }

  // School scoping. GEN.SchoolID scopes a row to a school, so a lookup made in
  // the context of a school-scoped log type is restricted to rows that either
  // carry no school or carry that one. Rows with no school are kept because a
  // district-level row legitimately has none.
  if (options.schoolId !== undefined) {
    const scoped = matches.filter((row) => {
      const school = genSchoolId(row);
      return school === undefined || school === String(options.schoolId);
    });
    if (scoped.length === 0) {
      throw new PayloadRejected(
        `GEN has ${matches.length} row(s) with Cat='${cat}' and Name='${name}', but none scoped to ` +
          `school ${String(options.schoolId)}. Read GEN for the right school rather than borrowing ` +
          `another school's configuration.`,
      );
    }
    matches = scoped;
  }

  const values = new Map<string, string>();
  for (const row of matches) {
    const resolved = genWireValue(row);
    if (resolved === null) {
      throw new PayloadRejected(
        `A GEN row with Cat='${cat}' and Name='${name}' carries no usable value in any of ` +
          `${GEN_VALUE_COLUMNS.join(", ")}. Refusing to invent one.`,
      );
    }
    values.set(resolved.value, resolved.column);
  }

  if (values.size > 1) {
    throw new PayloadRejected(
      `${cat} '${name}' resolves to ${values.size} different values (${[...values.keys()].join(", ")}), ` +
        `probably one per school or per log type. Pass a narrower GEN read instead of guessing.`,
    );
  }

  const [value, valueColumn] = [...values.entries()][0];
  return {
    value,
    name: String(pick(matches[0], "name", "gen_name")),
    cat,
    valueColumn,
    schoolId: genSchoolId(matches[0]),
    readAtIso,
  };
}

/**
 * A subtype, bound to the log type it belongs to.
 *
 * The log type is REQUIRED, not optional. The docs say a subtype is "associated
 * to a specific LogType", so resolving one without knowing which log type it
 * hangs off is exactly the guess this function exists to prevent. The returned
 * ref records the binding, and buildLogRow refuses a ref whose log type does not
 * match the entry's.
 */
export function resolveSubtype(
  genRows: GenRow[],
  name: string,
  readAtIso: string,
  logType: LogTypeRef,
): GenValueRef {
  if (logType === null || typeof logType !== "object" || logType.cat !== "logtype") {
    throw new PayloadRejected(
      "resolveSubtype needs the LogTypeRef the entry will be filed under. A subtype is district " +
        "configuration hanging off a specific log type, so resolving one on its own is a guess.",
    );
  }
  const ref = resolveGenValue(genRows, "subtype", name, readAtIso, { schoolId: logType.schoolId });
  return { ...ref, logTypeId: logType.id, logTypeName: logType.name };
}

/** A consequence. Scoped by school when the log type carries one. */
export function resolveConsequence(
  genRows: GenRow[],
  name: string,
  readAtIso: string,
  logType?: LogTypeRef,
): GenValueRef {
  return resolveGenValue(genRows, "consequence", name, readAtIso, {
    schoolId: logType?.schoolId,
  });
}

function assertGenValueRef(
  column: "Subtype" | "Consequence",
  cat: GenValueCat,
  ref: unknown,
  logType: LogTypeRef,
  now: Date,
  maxAgeMs: number,
): GenValueRef {
  if (typeof ref === "string" || typeof ref === "number") {
    throw new PayloadRejected(
      `${column} must be a GenValueRef resolved from GEN rows where Cat='${cat}', not the free ` +
        `${typeof ref} ${JSON.stringify(ref)}. ${column} is a configured menu field in PowerSchool; ` +
        `a string this client made up can name a classification the district never created. ` +
        `Use ${cat === "subtype" ? "resolveSubtype" : "resolveConsequence"}.`,
    );
  }
  if (ref === null || typeof ref !== "object") {
    throw new PayloadRejected(`${column} must be a GenValueRef resolved from GEN, got ${String(ref)}.`);
  }
  const candidate = ref as GenValueRef;
  if (candidate.cat !== cat) {
    throw new PayloadRejected(
      `${column}.cat is ${JSON.stringify(candidate.cat)}, expected ${JSON.stringify(cat)}. Only GEN ` +
        `rows in the ${cat} category classify this column.`,
    );
  }
  const value = String(candidate.value ?? "").trim();
  if (value === "") throw new PayloadRejected(`${column} resolved to an empty value.`);
  const readAt = Date.parse(candidate.readAtIso);
  if (!Number.isFinite(readAt)) {
    throw new PayloadRejected(`${column}.readAtIso is not a parseable timestamp: ${String(candidate.readAtIso)}.`);
  }
  const age = now.getTime() - readAt;
  if (age > maxAgeMs) {
    throw new PayloadRejected(
      `${column} was read ${Math.round(age / 3_600_000)}h ago, older than the ` +
        `${Math.round(maxAgeMs / 3_600_000)}h freshness bound. Re-read GEN before writing.`,
    );
  }
  if (cat === "subtype") {
    if (candidate.logTypeId === undefined) {
      throw new PayloadRejected(
        `Subtype carries no logTypeId. A subtype is scoped to a log type, so a ref that does not ` +
          `record which one cannot be checked against the entry. Use resolveSubtype.`,
      );
    }
    if (candidate.logTypeId !== logType.id) {
      throw new PayloadRejected(
        `Subtype ${JSON.stringify(candidate.name)} was resolved under log type ` +
          `${candidate.logTypeId} (${candidate.logTypeName ?? "unnamed"}) but this entry is filed ` +
          `under ${logType.id} (${logType.name}). Subtypes do not carry across log types.`,
      );
    }
  }
  return { ...candidate, value };
}

// ---------------------------------------------------------------------------
// Provenance. Every row this client writes is stamped so a human reading the
// student's log can tell which entries came from Wildcat Hub, and so a retry
// after a timeout can find its own earlier write instead of duplicating it.
// PowerSchool offers no idempotency key on this endpoint.
// ---------------------------------------------------------------------------

export const PROVENANCE_PREFIX = "wildcat-hub";
const APP_ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function provenanceMarker(appEntryId: string): string {
  if (!APP_ENTRY_ID_PATTERN.test(appEntryId)) {
    throw new PayloadRejected(
      `appEntryId ${JSON.stringify(appEntryId)} must match ${String(APP_ENTRY_ID_PATTERN)}. ` +
        `Anything else could break out of the marker and forge a second one.`,
    );
  }
  return `[${PROVENANCE_PREFIX}:${appEntryId}]`;
}

export function findProvenanceId(entryText: unknown): string | null {
  const found = new RegExp(`\\[${PROVENANCE_PREFIX}:([A-Za-z0-9_-]{1,64})\\]`).exec(
    String(entryText ?? ""),
  );
  return found === null ? null : found[1];
}

// ---------------------------------------------------------------------------
// School-local date and time.
//
// Entry_Date must be the date the behavior happened in the school's timezone.
// Formatting a Date in UTC puts every after-5pm Pacific entry on the following
// day, which silently misfiles roughly a third of an after-school program's
// entries. Formatted in the school zone instead.
//
// UNVERIFIED against this instance: the Data Dictionary types Entry_Time but
// does not state the wire format the table endpoint expects. HH:MM:SS is the
// assumption. An admin must confirm it against a real row before enabling.
// ---------------------------------------------------------------------------

export const SCHOOL_TIME_ZONE = "America/Los_Angeles";

export function formatEntryDate(when: Date, timeZone = SCHOOL_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
}

export function formatEntryTime(when: Date, timeZone = SCHOOL_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(when);
}

// ---------------------------------------------------------------------------
// The caller-facing input. Note what is NOT here: no amount, no points, no
// balance, no ticket count, no Discipline_* anything. The type is the control.
// ---------------------------------------------------------------------------

export type BehaviorEntryInput = {
  /** The app's own id for this entry. Becomes the provenance marker. */
  appEntryId: string;
  /** STUDENTS.ID, the same key the roster PowerQuery already joins on. */
  studentId: number;
  schoolId: number;
  logType: LogTypeRef;
  /** LOG.Subject, max 40 characters. */
  subject: string;
  /** LOG.Entry, the description of the behavior. */
  entry: string;
  /** LOG.Entry_Author, max 30 characters. */
  author: string;
  occurredAt: Date | string;
  timeZone?: string;
  /**
   * LOG.Subtype. A GEN ref, never a string: it is a configured menu field and a
   * free string can name a classification this district never created. Resolve
   * it with resolveSubtype, which also binds it to `logType`.
   */
  subtype?: GenValueRef;
  /** LOG.Consequence. A GEN ref for the same reason. See resolveConsequence. */
  consequence?: GenValueRef;
  teacherId?: number;
};

export type LogRow = Record<string, string | number>;

function requireString(name: string, value: unknown): string {
  const text = String(value ?? "").trim();
  if (text === "") throw new PayloadRejected(`${name} is required and was empty.`);
  return text;
}

function capped(column: string, text: string): string {
  const max = COLUMN_MAX_LENGTH[column];
  if (max !== undefined && text.length > max) {
    // Refused, never truncated. Silently trimming a behavior note is data loss
    // that nobody notices until someone reads a half sentence in a child's file.
    throw new PayloadRejected(
      `${column} is ${text.length} characters, over the ${max} character column limit. ` +
        `Shorten it at the source; this client will not truncate a behavior record.`,
    );
  }
  return text;
}

function requirePositiveInt(name: string, value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new PayloadRejected(`${name} must be a positive integer, got ${JSON.stringify(value)}.`);
  }
  return n;
}

/**
 * Validates an input and returns the exact LOG column map that would be sent.
 * Pure. No environment, no clock beyond `now`, no network.
 */
export function buildLogRow(
  input: BehaviorEntryInput,
  options: { now?: Date; logTypeMaxAgeMs?: number } = {},
): LogRow {
  const now = options.now ?? new Date();
  assertLogTypeRef(input.logType, now, options.logTypeMaxAgeMs ?? LOG_TYPE_MAX_AGE_MS);

  const marker = provenanceMarker(input.appEntryId);

  const subject = capped("Subject", requireString("subject", input.subject));
  const rawEntry = requireString("entry", input.entry);
  const author = capped("Entry_Author", requireString("author", input.author));

  // Lint only. See the block comment above the scan: the controls are structural.
  lintObviousEarnedValue("Subject", subject);
  lintObviousEarnedValue("Entry", rawEntry);

  if (findProvenanceId(rawEntry) !== null) {
    throw new PayloadRejected(
      "entry already carries a Wildcat Hub provenance marker. Pass the behavior text only; " +
        "the marker is appended once, here, so it cannot be forged upstream.",
    );
  }

  const occurredAt = input.occurredAt instanceof Date ? input.occurredAt : new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new PayloadRejected(`occurredAt is not a valid date: ${String(input.occurredAt)}.`);
  }
  const zone = input.timeZone ?? SCHOOL_TIME_ZONE;

  const row: LogRow = {
    StudentID: requirePositiveInt("studentId", input.studentId),
    SchoolID: requirePositiveInt("schoolId", input.schoolId),
    Entry_Date: formatEntryDate(occurredAt, zone),
    Entry_Time: formatEntryTime(occurredAt, zone),
    Entry_Author: author,
    Subject: subject,
    Entry: `${rawEntry}\n${marker}`,
    LogTypeID: input.logType.id,
  };

  const genMaxAge = options.logTypeMaxAgeMs ?? LOG_TYPE_MAX_AGE_MS;
  if (input.subtype !== undefined && input.subtype !== null) {
    const ref = assertGenValueRef("Subtype", "subtype", input.subtype, input.logType, now, genMaxAge);
    row.Subtype = capped("Subtype", ref.value);
  }
  if (input.consequence !== undefined && input.consequence !== null) {
    const ref = assertGenValueRef("Consequence", "consequence", input.consequence, input.logType, now, genMaxAge);
    row.Consequence = capped("Consequence", ref.value);
  }
  if (input.teacherId !== undefined) {
    row.TeacherID = requirePositiveInt("teacherId", input.teacherId);
  }

  assertWritableColumns(Object.keys(row));
  return row;
}

// ---------------------------------------------------------------------------
// Request rendering. Always available, sends nothing, reads no environment.
// This is the artifact a human eyeballs before anyone opens a gate.
// ---------------------------------------------------------------------------

export type RenderedRequest = {
  method: WriteVerb;
  /** Full URL as it would appear on the wire. */
  url: string;
  /** Authorization is rendered redacted. The real header is built at send time. */
  headers: Record<string, string>;
  body: unknown;
  table: string;
  columns: string[];
  /** What the access request would have to say for this to be permitted. */
  requiredGrants: GrantCheckRow[];
  appEntryId: string;
};

export type RenderOptions = {
  /** Defaults to the plugin.xml in this repo, so the grant column is real. */
  grants?: GrantIndex;
  now?: Date;
  logTypeMaxAgeMs?: number;
  /** Base URL for display. Defaults to https://<host>. */
  baseUrl?: string;
};

function renderedHeaders(): Record<string, string> {
  return {
    Authorization: "Bearer [redacted]",
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function renderFromRow(
  method: WriteVerb,
  baseUrl: string,
  row: LogRow,
  appEntryId: string,
  dcid: string | null,
  grants: GrantIndex,
): RenderedRequest {
  const table = "log";
  assertWritableTable(table);
  const columns = Object.keys(row);
  assertWritableColumns(columns);

  // The table endpoint wraps the column map under a `tables` key keyed by table
  // name. An update additionally carries top level id and name.
  const body: Record<string, unknown> = { tables: { [table]: row } };
  if (method === "PUT") {
    if (dcid === null) throw new PayloadRejected("An update needs the row's DCID.");
    body.id = dcid;
    body.name = table;
  }

  return {
    method,
    url: `${baseUrl}/ws/schema/table/${table}${method === "PUT" ? `/${dcid}` : ""}`,
    headers: renderedHeaders(),
    body,
    table,
    columns,
    requiredGrants: checkWriteGrant(grants, table, columns),
    appEntryId,
  };
}

function grantsFor(options: RenderOptions): GrantIndex {
  return options.grants ?? loadAccessRequest();
}

export function renderCreate(
  host: string,
  input: BehaviorEntryInput,
  options: RenderOptions = {},
): RenderedRequest {
  const row = buildLogRow(input, { now: options.now, logTypeMaxAgeMs: options.logTypeMaxAgeMs });
  return renderFromRow(
    "POST",
    options.baseUrl ?? `https://${host}`,
    row,
    input.appEntryId,
    null,
    grantsFor(options),
  );
}

export function renderUpdate(
  host: string,
  dcid: string,
  input: BehaviorEntryInput,
  options: RenderOptions = {},
): RenderedRequest {
  const row = buildLogRow(input, { now: options.now, logTypeMaxAgeMs: options.logTypeMaxAgeMs });
  return renderFromRow(
    "PUT",
    options.baseUrl ?? `https://${host}`,
    row,
    input.appEntryId,
    requireString("dcid", dcid),
    grantsFor(options),
  );
}

/**
 * Retraction. The app never deletes a SIS row, so "the teacher took it back" is
 * expressed as an edit that leaves the original text in place and appends a
 * dated retraction line. The audit trail survives; the record does not vanish.
 */
export function renderRetract(
  host: string,
  dcid: string,
  original: BehaviorEntryInput,
  reason: string,
  options: RenderOptions = {},
): RenderedRequest {
  const now = options.now ?? new Date();
  const zone = original.timeZone ?? SCHOOL_TIME_ZONE;
  const retracted: BehaviorEntryInput = {
    ...original,
    entry:
      `${requireString("entry", original.entry)}\n\n` +
      `RETRACTED ${formatEntryDate(now, zone)} ${formatEntryTime(now, zone)} by ` +
      `${requireString("author", original.author)}: ${requireString("reason", reason)}`,
  };
  return renderUpdate(host, dcid, retracted, options);
}

// ---------------------------------------------------------------------------
// THE CONFLICT RULE.
//
// Stated in full in docs/write-path.md. Enforced here.
//
//   1. Points: the app is authoritative and the SIS never learns them. Not
//      "the app wins a merge" - the number is never transmitted in either
//      direction. Enforced above by three structural controls: no amount on
//      the input type, no column on the allowlist that could hold one, and a
//      row built key by key rather than spread. The free-text scan is lint
//      over those, not a fourth control.
//   2. Enrollment: PowerSchool is authoritative and the app never writes it.
//      Enforced above by a one-entry table allowlist.
//   3. Behavior entries: the last human edit in PowerSchool beats the app.
//      The app may overwrite a row only when it can prove the row is still
//      exactly what it last wrote. Any divergence returns a conflict for a
//      human. Enforced below, and only meaningful with storage: the watermark
//      has to outlive the process that produced it, so WatermarkStore is part
//      of the rule and createBehaviorEntry / updateBehaviorEntry refuse to run
//      without one.
//
// PowerSchool's LOG table exposes no reliable last-modified column, so this is
// compare-and-set against a stored fingerprint rather than a timestamp check.
// That is stronger, not weaker: a timestamp tells you when, a fingerprint tells
// you whether, and only "whether" decides if an overwrite destroys an edit.
// ---------------------------------------------------------------------------

export type Watermark = {
  appEntryId: string;
  /**
   * null means the write landed but PowerSchool returned no recognisable DCID.
   * The row exists and the app cannot address it, so the next update must be
   * refused rather than fired at a guessed id. Recorded rather than dropped,
   * because "we wrote something we can no longer find" is exactly the state a
   * human needs to see.
   */
  logDcid: string | null;
  writtenAtIso: string;
  author: string;
  /** Exactly the column map the app last wrote. */
  columns: Record<string, string>;
  fingerprint: string;
};

// ---------------------------------------------------------------------------
// Watermark persistence.
//
// Clause 3 of the conflict rule is compare-and-set against what the app last
// wrote. A fingerprint that lives only in a local variable proves nothing
// across processes, so without storage clause 3 degrades to nothing the moment
// somebody wires this up and keeps only the DCID. Storage is therefore part of
// the rule, not a caller's problem: the high level create and update methods
// refuse to run without a store.
//
// FileWatermarkStore is the runnable implementation used by the tests and by
// any script driving this client directly. The eventual Convex caller wants a
// table instead; the exact schema diff is in docs/write-path.md section 8 and
// is NOT applied here, because convex/schema.ts is shared and off limits to
// this piece.
// ---------------------------------------------------------------------------

export interface WatermarkStore {
  get(appEntryId: string): Promise<Watermark | null>;
  put(watermark: Watermark): Promise<void>;
  all(): Promise<Watermark[]>;
}

/** Test-only. Named so a production caller cannot pick it up by accident. */
export class MemoryWatermarkStore implements WatermarkStore {
  private readonly rows = new Map<string, Watermark>();

  async get(appEntryId: string): Promise<Watermark | null> {
    return this.rows.get(appEntryId) ?? null;
  }

  async put(watermark: Watermark): Promise<void> {
    this.rows.set(watermark.appEntryId, watermark);
  }

  async all(): Promise<Watermark[]> {
    return [...this.rows.values()];
  }
}

/**
 * Durable store, one JSON document keyed by appEntryId.
 *
 * Written to a temp file and renamed, because a half written watermark file is
 * worse than none: it would make the next update believe the app wrote
 * something it did not, which is the one belief that lets an overwrite destroy
 * a teacher's edit. rename(2) within a directory is atomic, so a reader sees
 * either the old document or the new one.
 */
export class FileWatermarkStore implements WatermarkStore {
  // Written out longhand rather than as a parameter property: Node's
  // strip-only TypeScript mode, which is how every file in this harness runs,
  // rejects parameter properties.
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private read(): Record<string, Watermark> {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, Watermark>) : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async get(appEntryId: string): Promise<Watermark | null> {
    return this.read()[appEntryId] ?? null;
  }

  async put(watermark: Watermark): Promise<void> {
    const rows = this.read();
    rows[watermark.appEntryId] = watermark;
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
    renameSync(temp, this.path);
  }

  async all(): Promise<Watermark[]> {
    return Object.values(this.read());
  }
}

export type RemoteRow = {
  /** When the row was read back from PowerSchool. */
  readAtIso: string;
  /** null means PowerSchool returned no such row. */
  row: Record<string, unknown> | null;
  /**
   * The projection the read used. Must be "*".
   *
   * This is not bookkeeping. The escalation check below looks for populated
   * Discipline_* columns, and the create de-duplication looks for a provenance
   * marker inside Entry. A caller that read back only the columns it intended
   * to write would find neither, and would sail through both checks having
   * proven nothing. Requiring the caller to state the projection turns that
   * silent bypass into a refusal.
   */
  projection: string;
};

const FULL_PROJECTION = "*";

function projectionProblem(remote: RemoteRow): string | null {
  if (remote.projection === FULL_PROJECTION) return null;
  return (
    `The read-back used projection ${JSON.stringify(remote.projection)} rather than "*". ` +
    `A partial read cannot prove the row is unchanged, cannot see Discipline_* columns, ` +
    `and cannot see the provenance marker. Re-read the whole row.`
  );
}

/** Canonical string form so 100 and "100" fingerprint the same. */
function canonical(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * Fingerprints only the columns the app writes. A remote row carries dozens of
 * columns the app never touches; hashing those would report a conflict every
 * time PowerSchool populated a default.
 */
export function fingerprintRow(row: Record<string, unknown>): string {
  const lower = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) lower.set(key.toLowerCase(), value);

  const pairs: string[] = [];
  for (const column of [...LOG_WRITABLE_COLUMNS].sort()) {
    const value = lower.get(column.toLowerCase());
    if (value === undefined || canonical(value) === "") continue;
    pairs.push(`${column.toLowerCase()}=${canonical(value)}`);
  }
  return createHash("sha256").update(pairs.join("\x00")).digest("hex");
}

export function makeWatermark(
  logDcid: string | null,
  row: LogRow,
  appEntryId: string,
  writtenAt: Date = new Date(),
): Watermark {
  const columns: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) columns[key] = canonical(value);
  return {
    appEntryId,
    logDcid,
    writtenAtIso: writtenAt.toISOString(),
    author: canonical(row.Entry_Author),
    columns,
    fingerprint: fingerprintRow(row),
  };
}

/** Columns on a remote row that a human added and the app never writes. */
export function disciplineColumnsPresent(row: Record<string, unknown>): string[] {
  return Object.entries(row)
    .filter(([key, value]) => key.toLowerCase().startsWith(DISCIPLINE_COLUMN_PREFIX) && canonical(value) !== "")
    .map(([key]) => key)
    .sort();
}

export type UpdatePlan =
  | { action: "write"; request: RenderedRequest }
  | { action: "noop"; reason: string }
  | { action: "conflict"; reason: string; changedColumns: string[] }
  | { action: "abort"; reason: string };

/**
 * How long a read-back may sit before it stops counting as evidence. Two
 * minutes. Long enough for a normal read-modify-write, short enough that a
 * human editing in the PowerSchool UI is unlikely to slip inside the window.
 * It narrows the race; it does not close it, because the endpoint offers no
 * conditional write. Documented as a known weakness.
 */
export const DEFAULT_MAX_REMOTE_AGE_MS = 120_000;

export function planUpdate(args: {
  host: string;
  watermark: Watermark;
  remote: RemoteRow;
  desired: BehaviorEntryInput;
  now?: Date;
  maxRemoteAgeMs?: number;
  render?: RenderOptions;
}): UpdatePlan {
  const now = args.now ?? new Date();
  const maxAge = args.maxRemoteAgeMs ?? DEFAULT_MAX_REMOTE_AGE_MS;

  // 0. A watermark whose fingerprint does not match its own recorded columns
  //    has been edited or corrupted in transit. Trust nothing derived from it.
  if (fingerprintRow(args.watermark.columns) !== args.watermark.fingerprint) {
    return {
      action: "abort",
      reason:
        "Watermark fingerprint does not match its own recorded columns. It has been altered. " +
        "Re-read the row from PowerSchool and rebuild the watermark before any update.",
    };
  }

  // 0a. A watermark with no DCID names no row. The create landed, PowerSchool
  //     returned nothing this client recognised as an id, and there is no
  //     address to PUT to. Refuse rather than guess.
  if (args.watermark.logDcid === null) {
    return {
      action: "abort",
      reason:
        `Watermark for ${args.watermark.appEntryId} carries no DCID. The create landed but ` +
        "PowerSchool returned no recognisable row id, so the app cannot address the row it " +
        "wrote. A human must locate it by its provenance marker before any update.",
    };
  }

  // 0b. A partial read is not evidence.
  const projectionIssue = projectionProblem(args.remote);
  if (projectionIssue !== null) return { action: "abort", reason: projectionIssue };

  // 1. Gone.
  if (args.remote.row === null) {
    return {
      action: "abort",
      reason:
        `LOG row ${args.watermark.logDcid} is not in PowerSchool. Somebody deleted it, or the ` +
        `read failed. The app does not recreate a row a human removed.`,
    };
  }

  // 2. Stale evidence. An old read cannot prove what the row looks like now.
  const readAt = Date.parse(args.remote.readAtIso);
  if (!Number.isFinite(readAt)) {
    return { action: "abort", reason: `remote.readAtIso is not a parseable timestamp.` };
  }
  const age = now.getTime() - readAt;
  if (age > maxAge) {
    return {
      action: "abort",
      reason:
        `The read-back is ${Math.round(age / 1000)}s old, past the ${Math.round(maxAge / 1000)}s ` +
        `freshness bound. Re-read the row immediately before updating it.`,
    };
  }
  if (age < 0) {
    return { action: "abort", reason: "remote.readAtIso is in the future. Refusing to reason about it." };
  }

  // 3. Identity. The row must be the one the app wrote, proven by its marker.
  const remoteEntry = Object.entries(args.remote.row).find(
    ([key]) => key.toLowerCase() === "entry",
  );
  const remoteProvenance = findProvenanceId(remoteEntry === undefined ? "" : remoteEntry[1]);
  if (remoteProvenance !== args.watermark.appEntryId) {
    return {
      action: "conflict",
      reason:
        `LOG row ${args.watermark.logDcid} carries provenance ` +
        `${remoteProvenance === null ? "none" : remoteProvenance} but the watermark claims ` +
        `${args.watermark.appEntryId}. Either a human rewrote the entry text or the DCID has been reused. ` +
        `A human decides, not the app.`,
      changedColumns: ["Entry"],
    };
  }

  // 4. Escalation. A human attached discipline columns, so this is no longer a
  //    behavior note; it is part of a discipline record. Hands off entirely.
  const discipline = disciplineColumnsPresent(args.remote.row);
  if (discipline.length > 0) {
    return {
      action: "conflict",
      reason:
        `A human promoted this entry to a discipline record: ${discipline.join(", ")} ` +
        `are populated. Wildcat Hub never edits a row that carries discipline columns, ` +
        `because those feed state reporting.`,
      changedColumns: discipline,
    };
  }

  // 5. Drift. The remote row is not what the app last wrote, so an overwrite
  //    would destroy somebody's edit.
  const remoteFingerprint = fingerprintRow(args.remote.row);
  if (remoteFingerprint !== args.watermark.fingerprint) {
    return {
      action: "conflict",
      reason:
        `LOG row ${args.watermark.logDcid} has changed in PowerSchool since the app wrote it at ` +
        `${args.watermark.writtenAtIso}. Overwriting would silently discard that edit.`,
      changedColumns: diffColumns(args.watermark.columns, args.remote.row),
    };
  }

  // 6. Already correct.
  const desiredRow = buildLogRow(args.desired, {
    now,
    logTypeMaxAgeMs: args.render?.logTypeMaxAgeMs,
  });
  if (fingerprintRow(desiredRow) === remoteFingerprint) {
    return { action: "noop", reason: "PowerSchool already holds exactly this content." };
  }

  // 7. Safe to write.
  return {
    action: "write",
    request: renderUpdate(args.host, args.watermark.logDcid, args.desired, {
      ...(args.render ?? {}),
      now,
    }),
  };
}

function diffColumns(mine: Record<string, string>, remote: Record<string, unknown>): string[] {
  const remoteLower = new Map<string, unknown>();
  for (const [key, value] of Object.entries(remote)) remoteLower.set(key.toLowerCase(), value);

  const changed: string[] = [];
  for (const column of LOG_WRITABLE_COLUMNS) {
    const before = canonical(mine[column] ?? mine[column.toLowerCase()]);
    const after = canonical(remoteLower.get(column.toLowerCase()));
    if (before !== after) changed.push(column);
  }
  return changed;
}

export type CreatePlan =
  | { action: "write"; request: RenderedRequest }
  | { action: "noop"; reason: string; existingDcid: string | null }
  | { action: "abort"; reason: string };

/**
 * Create is not idempotent at the endpoint, so it is made idempotent here: the
 * caller reads back rows for the student, and a row already carrying this
 * appEntryId means the previous attempt landed even if its response was lost.
 */
export function planCreate(args: {
  host: string;
  desired: BehaviorEntryInput;
  existing: RemoteRow[];
  existingReadAtIso: string;
  now?: Date;
  maxRemoteAgeMs?: number;
  render?: RenderOptions;
}): CreatePlan {
  const now = args.now ?? new Date();
  const maxAge = args.maxRemoteAgeMs ?? DEFAULT_MAX_REMOTE_AGE_MS;

  const readAt = Date.parse(args.existingReadAtIso);
  if (!Number.isFinite(readAt)) {
    return { action: "abort", reason: "existingReadAtIso is not a parseable timestamp." };
  }
  const age = now.getTime() - readAt;
  if (age > maxAge || age < 0) {
    return {
      action: "abort",
      reason:
        `The duplicate check read is ${Math.round(age / 1000)}s old, outside the ` +
        `${Math.round(maxAge / 1000)}s freshness bound. Re-read before creating, or this will duplicate.`,
    };
  }

  for (const candidate of args.existing) {
    const issue = projectionProblem(candidate);
    if (issue !== null) return { action: "abort", reason: issue };
    if (candidate.row === null) continue;
    const entry = Object.entries(candidate.row).find(([key]) => key.toLowerCase() === "entry");
    if (findProvenanceId(entry === undefined ? "" : entry[1]) === args.desired.appEntryId) {
      const dcid = Object.entries(candidate.row).find(([key]) => key.toLowerCase() === "dcid");
      return {
        action: "noop",
        reason: `A LOG row already carries provenance ${args.desired.appEntryId}. The earlier attempt landed.`,
        existingDcid: dcid === undefined ? null : canonical(dcid[1]),
      };
    }
  }

  return {
    action: "write",
    request: renderCreate(args.host, args.desired, { ...(args.render ?? {}), now }),
  };
}

// ---------------------------------------------------------------------------
// The send layer. Everything above is pure. This is the only part that can
// reach a socket, and it is shut by default.
// ---------------------------------------------------------------------------

export type WriteConfig = {
  host: string;
  clientId: string;
  clientSecret: string;
};

export type SentStat = {
  method: string;
  path: string;
  status: number;
  ms: number;
  appEntryId: string;
};

export type PreflightReport = {
  ok: boolean;
  blocks: string[];
  grants: GrantCheckRow[];
  arming: ArmingState;
};

const LOOPBACK_BASE_URL = /^http:\/\/127\.0\.0\.1(:\d{1,5})?$/;

/**
 * The only hostnames this client will treat as "cannot be a PowerSchool
 * instance". Compared against a PARSED hostname, never against a URL string.
 *
 * new URL() canonicalises IPv4 forms, so "http://127.1/" and
 * "http://2130706433/" both arrive here as "127.0.0.1". That is correct: those
 * really are the loopback interface. What it will NOT do is turn
 * "127.0.0.1@lapf.powerschool.com" or "127.0.0.1.lapf.powerschool.com" into
 * "127.0.0.1", which is the whole point of parsing rather than string matching.
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1"]);

/** Every write this client can express lives under this path. */
export const WRITE_PATH_PREFIX = "/ws/schema/table/";

export type ParsedTarget =
  | {
      ok: true;
      protocol: string;
      hostname: string;
      port: string;
      pathname: string;
      /** True when the URL carries a userinfo component (user, or user:pass). */
      credentials: boolean;
      /** protocol//hostname[:port]. Never includes userinfo. */
      origin: string;
    }
  | { ok: false; reason: string };

/**
 * Parses a URL into the pieces the gates compare on.
 *
 * A parse failure is returned rather than thrown, because preflight gathers
 * every refusal reason instead of stopping at the first, and because an
 * unparseable URL must produce a BLOCK, never an exception that some caller
 * could catch and treat as a pass.
 */
export function parseTarget(raw: string): ParsedTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      reason: `${JSON.stringify(raw)} is not a parseable absolute URL. A target that cannot be parsed cannot be compared, so it is refused.`,
    };
  }
  return {
    ok: true,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    credentials: url.username !== "" || url.password !== "",
    origin: `${url.protocol}//${url.hostname}${url.port === "" ? "" : `:${url.port}`}`,
  };
}

/**
 * Origin equality: protocol, hostname and port must all match.
 *
 * NOT a prefix test. `"https://lapf.powerschool.com.evil.test/x".startsWith("https://lapf.powerschool.com")`
 * is true, and so is
 * `"http://127.0.0.1@lapf.powerschool.com/x".startsWith("http://127.0.0.1")`.
 * Both of those addressed a host the client was never bound to, and the second
 * one addressed the production SIS.
 */
function sameOrigin(a: ParsedTarget, b: ParsedTarget): boolean {
  if (!a.ok || !b.ok) return false;
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}

/**
 * GATE 1c. What preflight JUDGES must be what the wire CARRIES.
 *
 * `send()` accepts any object shaped like a RenderedRequest, and the tests
 * themselves hand-build them, so `request.table` and `request.columns` are
 * claims rather than facts. The grant check, the table allowlist and the column
 * allowlist all read those claims. Without this function a hand-built request
 * could declare table "log" with columns ["Entry"], pass every gate, and put
 * `{"tables":{"students":{"Discipline_ActionTaken":"S"}}}` on the wire.
 *
 * So: the table named in the URL path, the table named in the body envelope and
 * the declared table must all be the same one, and the body's column set must
 * be exactly the declared column set. Reported as `body:` blocks, refused in
 * tier 1 alongside the verb, table and target gates.
 */
/**
 * Materialises a RenderedRequest once so every later read sees the same value.
 *
 * Defeats a time-of-check / time-of-use split: a caller-supplied object whose
 * `url` or `body` is a getter can answer loopback while the gates look and
 * production when fetch() looks. Getters run here, once, and the result is a
 * plain frozen object. A body that will not survive a JSON round trip becomes
 * null, which the payload gate then refuses.
 */
function freezeRequest(request: RenderedRequest): RenderedRequest {
  let body: unknown = null;
  try {
    const text = JSON.stringify(request.body);
    body = text === undefined ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return Object.freeze({
    method: String(request.method) as WriteVerb,
    url: String(request.url),
    headers: { ...(request.headers ?? {}) },
    body,
    table: String(request.table ?? ""),
    columns: [...(request.columns ?? [])].map((column) => String(column)),
    requiredGrants: [...(request.requiredGrants ?? [])],
    appEntryId: String(request.appEntryId ?? ""),
  });
}

function bodyProblems(request: RenderedRequest, target: ParsedTarget): string[] {
  const problems: string[] = [];
  const declaredTable = String(request.table ?? "").toLowerCase();

  if (target.ok && target.pathname.startsWith(WRITE_PATH_PREFIX)) {
    const segment = target.pathname.slice(WRITE_PATH_PREFIX.length).split("/")[0];
    if (segment.toLowerCase() !== declaredTable) {
      problems.push(
        `the URL addresses table ${JSON.stringify(segment)} but the request declares ` +
          `${JSON.stringify(request.table)}. The grant check ran against the declared name; the ` +
          `wire would use the URL.`,
      );
    }
  }

  const body = request.body as Record<string, unknown> | null;
  if (body === null || typeof body !== "object") {
    problems.push("the body is not an object, so what it would write cannot be checked.");
    return problems;
  }
  const tables = body.tables as Record<string, unknown> | undefined;
  if (tables === null || tables === undefined || typeof tables !== "object") {
    problems.push('the body carries no "tables" envelope, which is the only shape this client sends.');
    return problems;
  }
  const keys = Object.keys(tables);
  if (keys.length !== 1 || keys[0].toLowerCase() !== declaredTable) {
    problems.push(
      `the body writes ${JSON.stringify(keys)} but the request declares table ` +
        `${JSON.stringify(request.table)}. One table per request, and it must be the declared one.`,
    );
    return problems;
  }
  const row = tables[keys[0]] as Record<string, unknown> | null;
  if (row === null || typeof row !== "object") {
    problems.push(`the body's ${keys[0]} entry is not a column map.`);
    return problems;
  }

  // Re-run the allowlists against the BODY, not against the claim.
  const bodyColumns = Object.keys(row);
  try {
    assertWritableTable(keys[0]);
    assertWritableColumns(bodyColumns);
  } catch (error) {
    problems.push((error as Error).message);
  }

  const declared = new Set((request.columns ?? []).map((column) => String(column).toLowerCase()));
  const undeclared = bodyColumns.filter((column) => !declared.has(column.toLowerCase()));
  if (undeclared.length > 0) {
    problems.push(
      `the body carries column(s) the grant check never saw: ${undeclared.join(", ")}. Every column ` +
        `on the wire must have been checked against the access request.`,
    );
  }
  const lowerBody = new Set(bodyColumns.map((column) => column.toLowerCase()));
  const absent = (request.columns ?? []).filter((column) => !lowerBody.has(String(column).toLowerCase()));
  if (absent.length > 0) {
    problems.push(`the request declares column(s) absent from the body: ${absent.join(", ")}.`);
  }
  return problems;
}

/**
 * "Is the request that is about to be sent addressed at a local fake?"
 *
 * Answered from the parsed hostname of the REQUEST, and additionally requires
 * that the client itself is loopback bound, so the two have to agree. A URL
 * carrying credentials is never loopback no matter what precedes the "@".
 */
function targetIsLoopback(target: ParsedTarget, baseUrl: string): boolean {
  if (!target.ok || target.credentials) return false;
  return LOOPBACK_HOSTNAMES.has(target.hostname) && LOOPBACK_BASE_URL.test(baseUrl);
}

export type WriteClientOptions = {
  config: WriteConfig;
  /**
   * TEST-ONLY grant override, exactly like `loopbackBaseUrl` below.
   *
   * An index supplied here carries source "override" and can only authorise a
   * write when the client is bound to a loopback base URL. Against any real
   * host the grant check ignores it and reads the installed plugin.xml from
   * disk instead. A reviewer previously opened every gate against
   * lapf.powerschool.com by passing `grantsPath: powerschool/plugin/plugin-v2.xml`;
   * that is what these two rules exist to stop.
   */
  grants?: GrantIndex;
  /** TEST-ONLY. Basename must be plugin.xml. See `grants`. */
  grantsPath?: string;
  /**
   * Where watermarks are recorded and read back. Required by
   * createBehaviorEntry and by every update path, because clause 3 of the
   * conflict rule is compare-and-set and a fingerprint nobody stored proves
   * nothing. Omitting it does not degrade the rule, it disables the methods
   * that depend on it. `send()` and `preflight()` do not need one.
   */
  watermarkStore?: WatermarkStore;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /**
   * Test-only override. Must be a loopback address, checked by regex, so this
   * escape hatch can never be pointed at a PowerSchool instance. When set, the
   * client talks plain HTTP to a local fake and every other gate still applies.
   */
  loopbackBaseUrl?: string;
  log?: (line: string) => void;
};

export class PowerSchoolWriteClient {
  readonly sent: SentStat[] = [];

  private readonly config: WriteConfig;
  private readonly grants: GrantIndex;
  private readonly store: WatermarkStore | null;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly log: (line: string) => void;
  private token: { value: string; expiresAtMs: number } | null = null;
  /**
   * Counts mutating requests ATTEMPTED, not completed. `sent` only records
   * responses, so a fetch that throws would not advance it and a retry loop
   * against a failing network could cross the ceiling unnoticed. The ceiling
   * exists to bound how many times this process can touch a student's file,
   * and an attempt that timed out may well have landed.
   */
  private attempted = 0;

  constructor(options: WriteClientOptions) {
    this.config = options.config;

    // Refused at construction, not at send time, so a wrong path is a loud
    // error at the top of a script rather than a surprise four gates later.
    // basename(), not endsWith(), so "not-plugin.xml" cannot pass.
    if (options.grantsPath !== undefined && basename(options.grantsPath) !== "plugin.xml") {
      throw new ForbiddenTarget(
        `grantsPath ${JSON.stringify(options.grantsPath)} is refused: its basename is ` +
          `${JSON.stringify(basename(options.grantsPath))}, not "plugin.xml". The grant check ` +
          `answers "what did PowerSchool grant", and only the installed plugin.xml can answer it. ` +
          `A proposed grant such as plugin-v2.xml is a request, not a permission.`,
      );
    }
    this.grants = options.grants ?? loadAccessRequest(options.grantsPath);
    this.store = options.watermarkStore ?? null;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? ((line) => console.log(line));

    if (options.loopbackBaseUrl !== undefined) {
      if (!LOOPBACK_BASE_URL.test(options.loopbackBaseUrl)) {
        throw new ForbiddenTarget(
          `loopbackBaseUrl must match ${String(LOOPBACK_BASE_URL)}. It exists so tests can drive ` +
            `a local fake, and it must never be able to address a real instance.`,
        );
      }
      this.baseUrl = options.loopbackBaseUrl;
    } else {
      this.baseUrl = `https://${this.config.host}`;
    }
  }

  get grantIndex(): GrantIndex {
    return this.grants;
  }

  get renderBaseUrl(): string {
    return this.baseUrl;
  }

  get writeCeiling(): number {
    const raw = Number(this.env[WRITE_CEILING_VAR]);
    return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_WRITE_CEILING;
  }

  arming(): ArmingState {
    return armingState(this.env);
  }

  /**
   * Every reason this request would be refused, gathered rather than thrown, so
   * an operator sees the whole list in one pass instead of fixing them one at a
   * time. Sends nothing.
   */
  preflight(request: RenderedRequest): PreflightReport {
    const blocks: string[] = [];
    const arming = this.arming();

    if (!(ALLOWED_WRITE_VERBS as readonly string[]).includes(request.method)) {
      blocks.push(
        `verb: ${request.method} is not on the write verb allowlist (${ALLOWED_WRITE_VERBS.join(", ")}). ` +
          `DELETE in particular is never available from this client.`,
      );
    }
    if (!(WRITABLE_TABLES as readonly string[]).includes(request.table.toLowerCase())) {
      blocks.push(`table: ${request.table} is not on the write table allowlist.`);
    }
    // GATE 1b, the target. An ORIGIN comparison, parsed on both sides.
    //
    // This was a prefix test, `request.url.startsWith(this.baseUrl)`, and a
    // reviewer walked through it: on a client based at http://127.0.0.1 the URL
    // http://127.0.0.1@lapf.powerschool.com/ws/schema/table/log passes that test
    // because the production host is in the userinfo component, after the "@".
    // fetch() resolves the host, not the prefix. Reproduced, confirmed, fixed.
    const target = parseTarget(request.url);
    const base = parseTarget(this.baseUrl);
    if (!target.ok) {
      blocks.push(`url: ${target.reason}`);
    } else if (target.credentials) {
      blocks.push(
        `url: ${request.url} carries an embedded userinfo component. The host a URL like that ` +
          `resolves to is whatever follows the "@", not what precedes it, so a credential in a ` +
          `write target is either an attempt to disguise the destination or a mistake. Refused ` +
          `either way; this client never needs one, it authenticates with a bearer token.`,
      );
    } else if (!base.ok) {
      blocks.push(`url: this client's base URL ${JSON.stringify(this.baseUrl)} does not parse. ${base.reason}`);
    } else if (base.credentials) {
      // Symmetric with the check above. this.baseUrl is built from config.host,
      // so a host string carrying an "@" would move the real destination past
      // the origin comparison by moving BOTH sides of it.
      blocks.push(
        `url: this client's base URL ${JSON.stringify(this.baseUrl)} carries an embedded userinfo ` +
          `component, so the host it resolves to (${base.hostname}) is not the one it appears to name. ` +
          `Fix PS_HOST rather than the comparison.`,
      );
    } else if (!sameOrigin(target, base)) {
      blocks.push(
        `url: ${request.url} resolves to origin ${target.origin}, which is not this client's ` +
          `origin ${base.origin}. Compared by protocol, hostname and port, never by string prefix.`,
      );
    } else if (!target.pathname.startsWith(WRITE_PATH_PREFIX)) {
      blocks.push(
        `url: path ${target.pathname} is not under ${WRITE_PATH_PREFIX}. Every write this client ` +
          `can express is a table write, so any other path is a request it did not build.`,
      );
    }

    // GATE 1c. The declared table and columns must be the ones on the wire.
    for (const problem of bodyProblems(request, target)) blocks.push(`body: ${problem}`);

    if (!arming.armed) blocks.push(`arming: ${arming.reason}`);

    // GATE 2, source-bound.
    //
    // Against a loopback fake the caller's injected index is used, because
    // there is no real instance and no real record to protect. Against
    // anything else the index the caller handed in is IGNORED and the
    // installed plugin.xml is re-read from disk, so a caller cannot answer the
    // question "what did PowerSchool grant" with a file of its own choosing.
    // The override's presence is reported as its own block so the refusal
    // names the real reason rather than looking like a missing column.
    //
    // "Loopback" is decided by the PARSED HOSTNAME OF THE REQUEST, and the
    // client must be loopback bound as well, so both have to agree. Deriving it
    // from this.baseUrl alone is what let a loopback bound client skip this
    // gate entirely for a request addressed to lapf.powerschool.com.
    const loopback = targetIsLoopback(target, this.baseUrl);
    const effective = loopback ? this.grants : installedGrant();
    if (!loopback) {
      for (const problem of grantSourceProblems(effective)) blocks.push(problem);
      if (this.grants.source !== "installed") {
        blocks.push(
          `grant-override: this client was constructed with a grant override ` +
            `(${this.grants.sourcePath}). It is honoured for a loopback target only and was ` +
            `ignored here. The installed plugin at ${effective.sourcePath} decided instead.`,
        );
      }
    }

    // The vacuous case, and it used to pass. checkWriteGrant maps over columns,
    // so zero columns yields zero rows, zero rows yields zero failures, and the
    // gate reported ok with no blocks for a request addressed at production.
    // Gate 1c agreed with it too, because an empty body honestly matches an
    // empty declaration. A gate that approves what it has nothing to inspect is
    // not a gate, so an empty column set is refused before it is checked.
    if (request.columns.length === 0) {
      blocks.push(
        `grant: the request declares zero columns, so there is nothing to check ` +
          `against ${effective.sourcePath}. A write that names no columns cannot be ` +
          `proven safe and is refused rather than passed by vacuous truth.`,
      );
    }

    const grants = checkWriteGrant(effective, request.table, request.columns);
    const missing = grants.filter((row) => !row.ok);
    if (missing.length > 0) {
      blocks.push(
        `grant: ${missing.length} of ${grants.length} columns lack FullAccess in ` +
          `${effective.sourcePath} (${missing.map((row) => `${row.field}=${row.current}`).join(", ")}).`,
      );
    }

    const hostBlock = this.hostBlock(target, loopback);
    if (hostBlock !== null) blocks.push(`host: ${hostBlock}`);

    if (this.attempted >= this.writeCeiling) {
      blocks.push(
        `ceiling: ${this.attempted} mutating request(s) already attempted, ceiling ${this.writeCeiling}.`,
      );
    }

    return { ok: blocks.length === 0, blocks, grants, arming };
  }

  /**
   * GATE 3. Judged on the hostname the socket would actually resolve.
   *
   * This used to return null the moment this.baseUrl looked like loopback,
   * which meant a loopback bound client skipped the production check outright
   * for a request addressed at lapf.powerschool.com. `loopback` is now computed
   * from the parsed request URL, and the risk is assessed against that URL's
   * hostname rather than against this.config.host.
   *
   * An unparseable or credential bearing URL falls back to the configured host,
   * which is the pessimistic answer: gate 1b has already blocked it, and this
   * gate should not become quieter because the target got weirder.
   */
  private hostBlock(target: ParsedTarget, loopback: boolean): string | null {
    if (loopback) return null;
    const host = target.ok && !target.credentials ? target.hostname : this.config.host;
    const risk = productionRisk(host);
    if (risk === null) return null;
    if ((this.env[WRITE_PRODUCTION_HOST_VAR] ?? "").trim().toLowerCase() === "yes") return null;
    return `${risk} Set ${WRITE_PRODUCTION_HOST_VAR}=yes as a separate, deliberate act to allow it.`;
  }

  /**
   * The single mutating chokepoint. Nothing else in this file opens a socket
   * for a write, so the gates cannot be bypassed by reaching past a helper.
   */
  async send(incoming: RenderedRequest): Promise<{ status: number; json: any; text: string; dcid: string | null }> {
    // SNAPSHOT FIRST, then check the snapshot, then send the snapshot.
    //
    // `incoming` is a plain object supplied by a caller. Reading `.url` in
    // preflight and reading it again at fetch() are two reads of a property
    // that a hostile or merely mutable object is free to answer differently:
    // loopback for the gates, production for the socket. Same for `.body`,
    // which is read once by the payload gate and once by JSON.stringify. The
    // snapshot below is materialised through a JSON round trip, so getters run
    // exactly once, and every gate and the wire then read the same frozen
    // value. Nothing after this line touches `incoming` again.
    const request = freezeRequest(incoming);

    const report = this.preflight(request);
    if (!report.ok) {
      const message = [
        `Refusing to send ${request.method} ${request.url}.`,
        ...report.blocks.map((line) => `  - ${line}`),
        "",
        "Nothing was sent. See docs/write-path.md.",
      ].join("\n");
      const blocked = (prefix: string) => report.blocks.some((line) => line.startsWith(prefix));

      // PRECEDENCE. Every block is reported in `report.blocks` regardless; this
      // only decides which error CLASS is thrown, which is to say which reason
      // a human reads first.
      //
      // Tier 1: a forbidden verb, table, target or payload is never permissible
      // under ANY configuration. Nothing can be set to make it acceptable.
      if (blocked("verb:") || blocked("table:") || blocked("url:") || blocked("body:")) {
        throw new ForbiddenTarget(message);
      }
      // Tier 2: the destination is production. Moved ahead of arming and grant
      // in this round. Ordering it last, which a previous round did, made
      // ProductionHostBlocked unreachable under every configuration a caller
      // could construct: on a real host the grant block always outranked it,
      // and on a loopback bound client hostBlock() returned null before it. A
      // gate whose entire job is stopping production traffic must be able to
      // fire, and "you are pointed at the SIS holding 641 real students" is the
      // most alarming true statement available, so it is the one to lead with.
      if (blocked("host:")) throw new ProductionHostBlocked(message);
      // Tier 3: a grant index that is not the installed plugin.xml is not
      // weaker evidence, it is the wrong question answered, so it outranks
      // arming and reports as a grant failure rather than a configuration one.
      if (blocked("grant-source:") || blocked("grant-version:") || blocked("grant-override:")) {
        throw new GrantMissing(message, report.grants.filter((row) => !row.ok));
      }
      if (blocked("arming:")) throw new WriteDisarmed(message);
      if (blocked("grant:")) throw new GrantMissing(message, report.grants.filter((row) => !row.ok));
      if (blocked("ceiling:")) throw new WriteCeilingReached(message);
      throw new ForbiddenTarget(message);
    }

    const token = await this.accessToken();
    // Counted here, before the socket opens, because a request that throws may
    // still have reached PowerSchool.
    this.attempted += 1;
    const started = Date.now();
    const response = await this.fetchImpl(request.url, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request.body),
      // Every gate above judged an origin that fetch() would otherwise be free
      // to leave. A 3xx on a mutating request would carry this POST, its bearer
      // token and its body to a host nothing checked, and following a redirect
      // on a POST can also replay a write. Refused rather than followed: a
      // redirect here is a fact for a human, not something to resolve silently.
      redirect: "error",
    });
    const ms = Date.now() - started;
    const text = await response.text();

    let json: any = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    const path = new URL(request.url).pathname;
    this.sent.push({ method: request.method, path, status: response.status, ms, appEntryId: request.appEntryId });
    this.log(`[write] ${request.method} ${path} status=${response.status} ${ms}ms entry=${request.appEntryId}`);

    if (response.status === 405) {
      throw new ForbiddenTarget(
        `PowerSchool answered 405 on ${path}. That is the endpoint refusing the table outright, ` +
          `not a permission problem. The same class of refusal already observed on teachers over GET. ` +
          `If LOG is not exposed over /ws/schema/table, this write path does not exist and no plugin ` +
          `grant will create it.`,
      );
    }

    return { status: response.status, json, text, dcid: extractDcid(json) };
  }

  private async accessToken(): Promise<string> {
    if (this.token !== null && Date.now() < this.token.expiresAtMs - 60_000) return this.token.value;

    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const response = await this.fetchImpl(`${this.baseUrl}/oauth/access_token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      // The Basic header on this call carries the client secret. A redirect
      // would hand it to whatever host the Location named.
      redirect: "error",
    });
    if (!response.ok) {
      // The body can echo request detail. Status only.
      throw new Error(`Token request failed with ${response.status}.`);
    }
    const json = (await response.json()) as { access_token?: string; expires_in?: string | number };
    if (!json.access_token) throw new Error("Token response contained no access_token.");
    this.token = {
      value: json.access_token,
      expiresAtMs: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  // -- high level operations ------------------------------------------------

  /**
   * The store, or a refusal naming the clause that needs it. Called by every
   * path that writes or reads a watermark, so there is no way to run clause 3
   * with storage that silently is not there.
   */
  private requireStore(operation: string): WatermarkStore {
    if (this.store !== null) return this.store;
    throw new PayloadRejected(
      `${operation} needs a watermarkStore. Clause 3 of the conflict rule is compare-and-set ` +
        `against the exact row the app last wrote, so the fingerprint has to outlive the ` +
        `process that produced it. Pass a FileWatermarkStore, or the Convex-backed store in ` +
        `docs/write-path.md section 8. This method is disabled rather than degraded on purpose: ` +
        `an update with no stored watermark would be an unconditional overwrite of a teacher's edit.`,
    );
  }

  /** Renders, plans against a fresh read, and only then considers sending. */
  async createBehaviorEntry(args: {
    desired: BehaviorEntryInput;
    existing: RemoteRow[];
    existingReadAtIso: string;
    now?: Date;
  }): Promise<{ plan: CreatePlan; watermark: Watermark | null; result: any }> {
    const store = this.requireStore("createBehaviorEntry");
    const plan = planCreate({
      host: this.config.host,
      desired: args.desired,
      existing: args.existing,
      existingReadAtIso: args.existingReadAtIso,
      now: args.now,
      render: { grants: this.grants, baseUrl: this.baseUrl },
    });
    if (plan.action !== "write") return { plan, watermark: null, result: null };

    const result = await this.send(plan.request);
    const row = (plan.request.body as { tables: Record<string, LogRow> }).tables.log;
    // Recorded even when the DCID did not come back. A watermark with a null
    // DCID is the record that something was written and cannot be addressed,
    // which is a state a human has to resolve; dropping it would leave the app
    // believing it never wrote at all and duplicating the entry on retry.
    const watermark = makeWatermark(result.dcid, row, args.desired.appEntryId, args.now ?? new Date());
    await store.put(watermark);
    return { plan, watermark, result };
  }

  /**
   * The method a real caller should use: the watermark comes out of storage,
   * never off the wire and never out of a variable the caller assembled.
   */
  async updateBehaviorEntryByAppEntryId(args: {
    appEntryId: string;
    remote: RemoteRow;
    desired: BehaviorEntryInput;
    now?: Date;
  }): Promise<{ plan: UpdatePlan; watermark: Watermark | null; result: any }> {
    const store = this.requireStore("updateBehaviorEntryByAppEntryId");
    const watermark = await store.get(args.appEntryId);
    if (watermark === null) {
      return {
        plan: {
          action: "abort",
          reason:
            `No watermark on record for ${args.appEntryId}. The app cannot prove what it last ` +
            `wrote to this row, so it must not overwrite it. Either this entry was never written ` +
            `by the app, or the watermark was lost. A human decides, not a retry.`,
        },
        watermark: null,
        result: null,
      };
    }
    return this.updateBehaviorEntry({ ...args, watermark });
  }

  /** Conflict-gated update. A conflict is returned, never resolved silently. */
  async updateBehaviorEntry(args: {
    watermark: Watermark;
    remote: RemoteRow;
    desired: BehaviorEntryInput;
    now?: Date;
  }): Promise<{ plan: UpdatePlan; watermark: Watermark | null; result: any }> {
    const store = this.requireStore("updateBehaviorEntry");
    const plan = planUpdate({
      host: this.config.host,
      watermark: args.watermark,
      remote: args.remote,
      desired: args.desired,
      now: args.now,
      render: { grants: this.grants, baseUrl: this.baseUrl },
    });
    if (plan.action !== "write") return { plan, watermark: null, result: null };

    const result = await this.send(plan.request);
    const row = (plan.request.body as { tables: Record<string, LogRow> }).tables.log;
    const watermark = makeWatermark(
      args.watermark.logDcid,
      row,
      args.desired.appEntryId,
      args.now ?? new Date(),
    );
    // The new fingerprint replaces the old one before the call returns. If this
    // throws, the caller learns the store is broken while the row is still
    // exactly what was just sent, which is recoverable; a silent skip here
    // would leave the next update comparing against a stale fingerprint and
    // reporting a conflict that is really the app's own write.
    await store.put(watermark);
    return { plan, watermark, result };
  }

  // deleteBehaviorEntry does not exist and must not be added. Retraction is an
  // edit (renderRetract), and DELETE is refused at the chokepoint above even if
  // a RenderedRequest carrying it is hand-built.
}

function extractDcid(json: any): string | null {
  if (json === null || typeof json !== "object") return null;
  // UNVERIFIED shape. PowerSchool's documented insert responses vary by surface,
  // so several plausible shapes are read and anything unrecognised returns null
  // rather than a guess. A null DCID means no watermark, which means the next
  // update is refused rather than fired blind. That is the safe failure.
  const candidates = [
    json.id,
    json.dcid,
    json?.tables?.log?.dcid,
    json?.tables?.log?.id,
    json?.result?.id,
    json?.result?.[0]?.success_message?.id,
    json?.insert_result?.[0]?.success_message?.id,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const text = String(candidate).trim();
    if (text !== "") return text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// `node src/write-client.ts --explain`
//
// Prints the grant proof and the exact requests. No credentials, no network.
// ---------------------------------------------------------------------------

/**
 * ILLUSTRATIVE GEN rows. NOT read from lapf.powerschool.com, and not a claim
 * about what Westbrook has configured. They exist so --explain can demonstrate
 * the resolution path end to end rather than printing hardcoded ids and
 * strings. The real ids and menu values are unknown until somebody reads GEN;
 * see docs/write-path.md section 6, "Still open".
 */
const EXAMPLE_GEN: GenRow[] = [
  { id: 404, name: "Merits", cat: "logtype", schoolid: 3 },
  { id: 461, name: "Contact", cat: "logtype", schoolid: 3 },
  { id: 12, name: "Respect", cat: "subtype", value: "RESPECT", schoolid: 3 },
  { id: 31, name: "None", cat: "consequence", value: "NONE", schoolid: 3 },
];

function explain(): void {
  const grants = loadAccessRequest();
  const readAt = new Date().toISOString();
  const logType = resolveLogType(EXAMPLE_GEN, "Merits", readAt);
  const example: BehaviorEntryInput = {
    appEntryId: "wh-2026-08-12-000123",
    studentId: 4021,
    schoolId: 3,
    logType,
    subject: "Positive behavior",
    entry: "Helped a classmate reset the lab bench without being asked.",
    author: "Wildcat Hub (app)",
    occurredAt: new Date("2026-08-12T22:15:00Z"),
    subtype: resolveSubtype(EXAMPLE_GEN, "Respect", readAt, logType),
    teacherId: 91,
  };

  const host = "lapf.powerschool.com";
  const create = renderCreate(host, example, { grants });
  const update = renderUpdate(host, "998877", { ...example, entry: `${example.entry} Follow up sent home.` }, { grants });

  console.log("PowerSchool write path: grant proof and rendered requests");
  console.log("=".repeat(72));
  console.log(`\nAccess request read from: ${grants.sourcePath}`);
  console.log(`Grant source:             ${grants.source} (only "installed" can authorise a write)`);
  console.log(`Plugin version:           ${grants.pluginVersion ?? "(none found)"}`);
  console.log(`Version recorded as installed on the instance: ${INSTALLED_PLUGIN_VERSION}`);
  const sourceProblems = grantSourceProblems(grants);
  console.log(
    sourceProblems.length === 0
      ? "Source binding:           OK, this is the installed plugin at the pinned version."
      : `Source binding:           REFUSED\n  ${sourceProblems.join("\n  ")}`,
  );
  console.log(
    `Declared fields:          ${grants.counts.total} across ${grants.counts.tables} tables ` +
      `(${grants.counts.viewOnly} ViewOnly, ${grants.counts.fullAccess} FullAccess)`,
  );

  console.log(`\nGrant check for the ${create.columns.length} columns a create would write:`);
  for (const row of create.requiredGrants) {
    console.log(`  ${row.ok ? "OK   " : "BLOCK"} ${row.field.padEnd(22)} needs ${row.required}, has ${row.current}`);
  }
  const blocked = create.requiredGrants.filter((row) => !row.ok).length;
  console.log(
    `\nVERDICT: ${blocked} of ${create.requiredGrants.length} columns are blocked by the granted ` +
      `access request. Writes are impossible today, proven by reading plugin.xml, not by sending anything.`,
  );

  console.log(`\nArming: ${armingState(process.env).reason}`);

  for (const [label, request] of [["CREATE", create], ["UPDATE", update]] as const) {
    console.log(`\n${"-".repeat(72)}\n${label}: ${request.method} ${request.url}`);
    for (const [key, value] of Object.entries(request.headers)) console.log(`  ${key}: ${value}`);
    console.log(JSON.stringify(request.body, null, 2));
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// `node --env-file=.env src/write-client.ts --probe-log`
//
// The one question that decides whether anything below section 3 of
// docs/write-path.md is worth building: does PowerSchool expose the LOG table
// over /ws/schema/table at all?
//
//   405  the endpoint does not serve this table, for anyone, at any grant.
//        The table write path does not exist and no plugin.xml edit creates it.
//        The teachers table already answers this way on this instance.
//   403  the table IS exposed and the plugin simply lacks the columns. The
//        write path is real and gated exactly where this client says it is.
//   200  exposed and already readable, which would be a surprise, because LOG
//        appears nowhere in plugin.xml.
//   404  no such table.
//
// This is a GET. It reads at most one row, through the existing read-only
// client, whose chokepoint refuses any verb but GET and POST-to-a-named-query.
// It cannot mutate anything. It is here rather than in the read harness
// because it is the write path's own load-bearing unknown.
// ---------------------------------------------------------------------------

// `teachers` is the control, not a target. This instance already answers 405
// on it, so a run that shows teachers=405 and log=403 has demonstrated that
// the probe can tell the two apart rather than returning 403 for everything.
const PROBE_TABLES = ["log", "gen", "teachers"] as const;

async function probeLogExposure(): Promise<void> {
  const { loadConfig } = await import("./config.ts");
  const { PowerSchoolClient } = await import("./client.ts");

  const config = loadConfig();
  const client = new PowerSchoolClient(config, () => {});

  console.log("LOG exposure probe. GET only, one row, no mutation possible.");
  console.log("=".repeat(72));
  for (const table of PROBE_TABLES) {
    let status: number;
    let text: string;
    try {
      const response = await client.get(`/ws/schema/table/${table}`, {
        projection: "dcid",
        pagesize: 1,
      });
      status = response.status;
      text = response.text;
    } catch (error) {
      console.log(`  ${table.padEnd(4)} request failed: ${(error as Error).message}`);
      continue;
    }

    const verdict =
      status === 405
        ? "NOT EXPOSED. PowerSchool does not serve this table over /ws/schema/table for anyone. " +
          "No access_request edit can open it. The table write path does not exist."
        : status === 403
          ? "EXPOSED, UNGRANTED. The write path is real and is gated by the access request, " +
            "exactly where this client says it is."
          : status === 200
            ? "EXPOSED AND READABLE. Unexpected: this table appears nowhere in plugin.xml."
            : status === 404
              ? "NO SUCH TABLE on this instance."
              : "UNCLASSIFIED. Record the status and the body shape in docs/write-path.md.";

    // The body can echo column names but not values at pagesize 1 with a
    // dcid projection. Truncated anyway, and never logged on a 200.
    const detail = status === 200 ? "(body withheld)" : text.slice(0, 200).replace(/\s+/g, " ");
    console.log(`  ${table.padEnd(4)} HTTP ${status}  ${verdict}`);
    console.log(`       ${detail}`);
  }
  console.log("");
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly && process.argv.includes("--explain")) explain();
if (invokedDirectly && process.argv.includes("--probe-log")) await probeLogExposure();
