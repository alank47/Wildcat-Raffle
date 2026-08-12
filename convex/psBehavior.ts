import { internalMutation } from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { ConvexError, v } from "convex/values";
import type { Identity } from "./identityRules.js";

/**
 * PowerSchool behavior log entries: store them, shape them, and refuse to let
 * them touch anything a child earned.
 *
 * WHY THIS EXISTS
 * The app runs a complete behavior economy of its own (eight behaviors at plus
 * or minus 100 points, referrals, detentions, hall passes) and Westbrook runs
 * the school's official one inside PowerSchool. Neither knows the other exists.
 * A teacher deducting Wildcat Cash for defiance cannot see that the same
 * student already has three log entries this week, or that the child was
 * serving a suspension that day. This module closes that in exactly one
 * direction: PowerSchool to the Hub, read only, and never back.
 *
 * THE PREMISE WAS MEASURED, NOT ASSUMED. On 2026-08-11, GET only, against
 * lapf.powerschool.com: LOG holds 16987 rows and INCIDENT holds 13. PowerSchool
 * ships two independent behavior models and this module is pointed at the one
 * Westbrook actually uses. See docs/behavior-sourcing.md for the transcript.
 *
 * THE FOUR RULES, all of them structural rather than remembered:
 *
 *   1. NOTHING HERE WRITES EARNED VALUE. There is no reference to the student
 *      table anywhere in this file, no import of sisMerge, and no arithmetic on
 *      a balance. A behavior count is a fact from the SIS; a ticket is
 *      something a child was given by a person. Wiring one to the other would
 *      let a log entry filed by a substitute teacher spend a student's money,
 *      and it would do it silently. psBehavior.test.mjs asserts this by reading
 *      this file's own source, so the guarantee survives a future edit that
 *      forgets the reason.
 *
 *   2. NO NARRATIVE FREE TEXT IS STORED, AND THE ONE CODE FIELD IS SHAPE
 *      CHECKED. LOG.Entry and LOG.Subject are not selected by the PowerQuery,
 *      not requested in the access request, and not in the allowlist below. The
 *      live instance confirms LOG.Entry is a CLOB: a query against it answers
 *      "Querying not supported against clob or blob field types". A log entry
 *      narrative routinely names a second child or carries a medical or family
 *      detail. normalizeBehaviorRow builds its output field by field from
 *      BEHAVIOR_ROW_FIELDS, so a free text column cannot arrive by accident;
 *      rejectedFreeTextKeys is the alarm that fires if upstream starts sending
 *      one anyway.
 *
 *      The qualifier, stated because the previous absolute version of this
 *      claim was false: LOG.Discipline_ActionTaken IS read, and it is a
 *      String 79 a district can type prose into. It used to be guarded by a 79
 *      character cap, which by construction cannot exclude prose shorter than
 *      79 characters: "Suspended for fighting with Jose in the cafeteria" is 48
 *      characters, names a second child, and passed. isActionCode below is a
 *      SHAPE guard instead, and that sentence dies on its first space. A single
 *      bare token still passes, which no shape guard can fix, so the count of
 *      refusals is reported by every sync and open question 4 in
 *      docs/behavior-sourcing.md is whether the column stays in the ask at all.
 *
 *   3. ABSENCE IS NOT ZERO. A student with no behavior rows has either no log
 *      entries or no sync. Those are different facts and the second one must
 *      never be rendered as "0 incidents", which is a claim about a child that
 *      nobody checked. behaviorSummaryFor returns status "unknown" with null
 *      counts until a coverage record proves a window was actually pulled.
 *      This is the same rule psAttendance states in schema.ts and the same one
 *      the grades path applies to a null percent.
 *
 *   4. A CODE IS NOT A NAME. LOG.Subtype holds a district defined code and the
 *      documentation does not say which GEN column carries its description.
 *      resolveSubtype therefore reports resolved:false rather than handing a
 *      teacher a bare code as though it meant something. Same instinct as rule
 *      3: say "unknown" out loud instead of showing something that reads as an
 *      answer.
 *
 * WHAT IS NOT HERE
 * No public query. The read path belongs in studentDetail.ts, which already
 * does requireStaff plus canViewStudent(psRoster) and therefore already knows
 * whether this caller may look at this child. Re-implementing that gate here
 * would create a second copy of the security boundary, and the second copy is
 * the one that drifts. readBehaviorForStudent below takes a ctx and the
 * caller's real principal, and is called from there after the access decision.
 *
 * WHY THE IMPORTS CARRY A .js EXTENSION
 * The repo's test runner is plain node with type stripping. Node cannot resolve
 * the extensionless "./_generated/server" that the other Convex modules use, so
 * a test could not import this file at all. Pointing at the real emitted
 * server.js keeps this module importable by both node and the Convex bundler,
 * which is what lets the pure rules below be tested rather than asserted.
 */

// ---------------------------------------------------------------------------
// Names. Nothing below hardcodes a log type integer; see rule 3 in
// powerschool/plugin/queries_root/behavior.named_queries.xml.
// ---------------------------------------------------------------------------

export const BEHAVIOR_QUERY_TYPES = "com.lapromisefund.wildcathub.behavior_types";
export const BEHAVIOR_QUERY_LOG = "com.lapromisefund.wildcathub.behavior_log";

/** appState keys. Both chosen so the only NEW table this piece needs is one. */
export const COVERAGE_KEY = "psBehaviorCoverage";
export const TYPES_KEY = "psBehaviorTypes";

/**
 * Prefix for a log type whose GEN row is missing.
 *
 * LogTypeID values are district defined arbitrary integers and some are
 * negative built-ins. The GEN join in the PowerQuery is a LEFT JOIN precisely
 * so an entry with an unresolvable type keeps its row with a null name instead
 * of being deleted by an inner join, which would make the count look plausible
 * while being wrong.
 *
 * The marker is built HERE and only here. It used to be built twice, once in
 * Oracle with a string concatenation and once in this file, which is two copies
 * of one literal in two languages. The SQL now returns the name as it finds it.
 */
export const UNMAPPED_PREFIX = "UNMAPPED_LOGTYPE_";

/**
 * The declared column width of LOG.Discipline_ActionTaken. A secondary bound,
 * never the guard: see ACTION_CODE_SHAPE for why.
 */
export const ACTION_TAKEN_MAX_CHARS = 79;

/**
 * What a code looks like, as opposed to what a sentence looks like.
 *
 * LOG.Discipline_ActionTaken is described by the data dictionary as a code
 * "such as S=Suspend", and it is a String 79 that a district can type anything
 * into. The previous guard here was a 79 character cap, and it was worthless:
 * "Suspended for fighting with Jose in the cafeteria" is 48 characters, names a
 * second child, and sailed through while this file claimed no free text left
 * the SIS.
 *
 * A code has no whitespace. That single property is what separates every real
 * example (S, OSS, ISS, S=Suspend, ISS-3) from every sentence, and it does not
 * depend on length at all. So: one token, optionally a second after a single
 * '=', drawn from letters, digits, dot, underscore, slash, plus and hyphen.
 *
 * THE LIMIT, NAMED RATHER THAN HIDDEN: a single bare token still passes, and a
 * token can be a person's name. No shape can distinguish "OSS" from "Jose".
 * That is why ingestReport counts every refusal, why the sync surfaces the
 * count, and why removing this column from the access request entirely stays on
 * the table as open question 4 in docs/behavior-sourcing.md.
 */
export const ACTION_CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/+-]*(=[A-Za-z0-9][A-Za-z0-9._/+-]*)?$/;

/**
 * True when a value is shaped like a discipline action code rather than prose.
 *
 * The length bound is kept as a second, weaker check. It is not doing the work.
 */
export function isActionCode(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value.length > ACTION_TAKEN_MAX_CHARS) return false;
  return ACTION_CODE_SHAPE.test(value);
}

// ---------------------------------------------------------------------------
// The allowlist. This is the PII boundary, in the same shape views.ts uses.
// ---------------------------------------------------------------------------

/**
 * Every field a stored behavior row may carry. Built field by field, never
 * spread from the source row.
 *
 * A denylist would be the tempting shape and the wrong one: it fails open, so
 * the day someone adds LOG.Entry to the PowerQuery it lands in the database
 * and then in a browser before a human notices.
 */
export const BEHAVIOR_ROW_FIELDS = [
  "studentNumber",
  "logEntryId",
  "entryDate",
  "logTypeName",
  "logTypeId",
  "subtype",
  "consequence",
  "actionTaken",
  "incidentDate",
  "entryAuthor",
  "schoolId",
] as const;

export type BehaviorRowField = (typeof BEHAVIOR_ROW_FIELDS)[number];

/**
 * Source column names that must never be stored, whatever the PowerQuery does.
 *
 * `entry` and `subject` are the two free text columns on LOG.
 *
 * The discipline block is handled by an ALLOWLIST of exactly two columns rather
 * than by banning the prefix. There are 34 Discipline_ columns; the data
 * dictionary describes only Discipline_ActionTaken and Discipline_IncidentDate
 * as live, and those two answer "was this child suspended, and when", which is
 * the question a rewards app most needs before it deducts anything. Banning the
 * prefix outright would have excluded them too. Naming the two that are allowed
 * means adding a 35th is a test failure rather than an oversight.
 */
export const FORBIDDEN_SOURCE_KEYS = ["entry", "subject", "log_entry", "entry_text"] as const;

/** The only two discipline columns this path will accept, at source. */
export const ALLOWED_DISCIPLINE_SOURCE_KEYS = [
  "discipline_actiontaken",
  "discipline_incidentdate",
] as const;

export const FORBIDDEN_SOURCE_PREFIXES = ["discipline_"] as const;

export type BehaviorLogRow = {
  studentNumber: string;
  logEntryId: string;
  entryDate: string;
  logTypeName: string;
  logTypeId?: string;
  subtype?: string;
  consequence?: string;
  actionTaken?: string;
  incidentDate?: string;
  entryAuthor?: string;
  schoolId?: string;
};

export type BehaviorCoverage = {
  windowStart: string;
  windowEnd: string;
  syncedAt: string;
  entriesLoaded: number;
};

export type BehaviorTypeRow = {
  genId: string;
  genCat: string;
  genName: string;
  genValue?: string;
  schoolId?: string;
  sortOrder?: number;
  entriesAllTime: number;
  firstEntryDate?: string;
  lastEntryDate?: string;
};

// ---------------------------------------------------------------------------
// Pure rules. No ctx, no database, so the boundary is directly testable rather
// than asserted in a comment.
// ---------------------------------------------------------------------------

const text = (x: unknown): string | undefined => {
  const s = String(x ?? "").trim();
  return s === "" ? undefined : s;
};

const ORACLE_MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * A date string from the SIS, canonicalized to YYYY-MM-DD, or undefined.
 *
 * PURE STRING WORK, DELIBERATELY. An Oracle date parsed into a JavaScript Date
 * in one timezone and re-serialized in another is how a Friday incident becomes
 * a Thursday one, and a discipline record dated one day early is exactly the
 * kind of error nobody notices and nobody can defend.
 *
 * THE QUERY RETURNS THESE RAW. It used to format them with TO_CHAR, which was
 * the one construct in the behavior SQL with no precedent on this instance,
 * bought nothing, and had to be tested by a human before the plugin could ship.
 * Three columns already come back raw from live queries (TERMS.FIRSTDAY,
 * TERMS.LASTDAY, PGFINALGRADES.LASTGRADEUPDATE) and sisAction.ts carries them as
 * plain strings today. This function was written to absorb exactly those shapes,
 * so absorbing them is now the design rather than the fallback.
 *
 * Anything else is refused rather than guessed at, because a date this function
 * cannot read is a date nobody should be rendering. A refusal is not silent:
 * ingestReport carries up to three of the unreadable literals into the sync
 * summary, so a fifth Oracle shape names itself on the first run instead of
 * showing up as a pile of dropped rows with no explanation.
 */
export function canonicalDate(raw: unknown): string | undefined {
  const s = text(raw);
  if (s === undefined) return undefined;

  // YYYY-MM-DD, optionally followed by a time. The overwhelmingly common case.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // YYYY/MM/DD.
  const slashed = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(s);
  if (slashed) return `${slashed[1]}-${slashed[2]}-${slashed[3]}`;

  // Oracle's default, DD-MON-YY or DD-MON-YYYY, for example 11-AUG-26.
  const oracle = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(s);
  if (oracle) {
    const month = ORACLE_MONTHS[oracle[2].toLowerCase()];
    if (!month) return undefined;
    const day = oracle[1].padStart(2, "0");
    let year = oracle[3];
    if (year.length === 2) {
      // Oracle's own RR pivot. A two digit year is ambiguous and this is the
      // convention the database itself uses, so it is the one least likely to
      // disagree with what an administrator sees on screen.
      year = Number(year) <= 49 ? `20${year}` : `19${year}`;
    }
    return `${year}-${month}-${day}`;
  }

  return undefined;
}

/**
 * The keys in a raw PowerQuery record that must never be stored.
 *
 * Returned rather than thrown. A sync that dies on the first surprising column
 * loses the whole pull including the rows that were fine; a sync that reports
 * the count keeps working and still makes a human look.
 */
export function rejectedFreeTextKeys(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  const allowedDiscipline = new Set<string>(ALLOWED_DISCIPLINE_SOURCE_KEYS);
  for (const key of Object.keys(raw ?? {})) {
    const k = key.trim().toLowerCase();
    if ((FORBIDDEN_SOURCE_KEYS as readonly string[]).includes(k)) out.push(key);
    else if (FORBIDDEN_SOURCE_PREFIXES.some((p) => k.startsWith(p)) && !allowedDiscipline.has(k)) {
      out.push(key);
    }
  }
  return out;
}

/**
 * One raw `behavior_log` record to one storable row, or null.
 *
 * Null when there is no student number, no log entry id, or no readable date: a
 * behavior row that cannot be attributed to a specific student and a specific
 * entry is not a partial record to keep, it is a row that would inflate a count
 * against whoever it lands nearest.
 *
 * The PowerQuery aliases the two allowed discipline columns to action_taken and
 * incident_date. Those aliases are read here; the raw Discipline_ spellings are
 * ALSO read, so that if the query is ever rewritten to pass them through
 * unaliased the data still lands rather than silently vanishing.
 */
export function normalizeBehaviorRow(raw: Record<string, unknown>): BehaviorLogRow | null {
  const studentNumber = text(raw?.student_number);
  const logEntryId = text(raw?.log_entry_id);
  const entryDate = canonicalDate(raw?.entry_date);
  if (!studentNumber || !logEntryId || !entryDate) return null;

  const logTypeId = text(raw?.log_type_id);
  const rawAction = text(raw?.action_taken) ?? text(raw?.Discipline_ActionTaken);

  return {
    studentNumber,
    logEntryId,
    entryDate,
    // An entry whose type could not be resolved still gets a name, so it is
    // countable and visibly odd rather than silently absent. Built here, once.
    logTypeName: text(raw?.log_type_name) ?? `${UNMAPPED_PREFIX}${logTypeId ?? "UNKNOWN"}`,
    logTypeId,
    subtype: text(raw?.subtype),
    consequence: text(raw?.consequence),
    // Not code shaped is not a code, it is prose someone typed into a code
    // field. Dropped, and counted by ingestReport. A length cap would let a 48
    // character sentence naming a second child through untouched.
    actionTaken: isActionCode(rawAction) ? rawAction : undefined,
    incidentDate:
      canonicalDate(raw?.incident_date) ?? canonicalDate(raw?.Discipline_IncidentDate),
    entryAuthor: text(raw?.entry_author),
    schoolId: text(raw?.school_id),
  };
}

/** One raw `behavior_types` record to a vocabulary row. Carries no student data. */
export function normalizeTypeRow(raw: Record<string, unknown>): BehaviorTypeRow | null {
  const genId = text(raw?.gen_id);
  const genCat = text(raw?.gen_cat);
  const genName = text(raw?.gen_name);
  if (!genId || !genCat || !genName) return null;
  const sortOrder = Number(raw?.sort_order);
  const count = Number(raw?.entries_all_time);
  return {
    genId,
    genCat,
    genName,
    genValue: text(raw?.gen_value),
    schoolId: text(raw?.school_id),
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : undefined,
    // A missing count is 0 here and only here: the PowerQuery already NVLs it,
    // and this table is configuration, not a claim about a child.
    entriesAllTime: Number.isFinite(count) ? count : 0,
    firstEntryDate: canonicalDate(raw?.first_entry_date),
    lastEntryDate: canonicalDate(raw?.last_entry_date),
  };
}

/**
 * Everything one pull of `behavior_log` produced, including what it refused.
 *
 * One call so the sync does not have to remember to check three things, and so
 * the numbers that make a human look (free text keys appearing, rows dropped,
 * action codes that were actually prose) are reported rather than discarded.
 */
export function ingestReport(rawRows: Array<Record<string, unknown>>): {
  rows: BehaviorLogRow[];
  received: number;
  dropped: number;
  freeTextKeys: string[];
  /** Values in Discipline_ActionTaken that were not code shaped, so were not stored. */
  nonCodeActionTaken: number;
  /** Up to three distinct entry_date literals canonicalDate could not read. */
  unreadableDateSamples: string[];
} {
  const rows: BehaviorLogRow[] = [];
  const freeText = new Set<string>();
  const badDates = new Set<string>();
  let nonCode = 0;

  for (const raw of rawRows ?? []) {
    for (const key of rejectedFreeTextKeys(raw)) freeText.add(key);

    const action = text(raw?.action_taken) ?? text(raw?.Discipline_ActionTaken);
    if (action !== undefined && !isActionCode(action)) nonCode += 1;

    // A date literal is not PII and knowing its exact shape is the difference
    // between a five minute fix and an afternoon. The SQL no longer formats the
    // date, so the first sync is where the raw Oracle shape becomes visible;
    // if it is a fifth shape canonicalDate does not know, this says so in the
    // sync summary instead of silently reporting a pile of dropped rows.
    // Truncated, distinct, and capped at three: a diagnostic, not a dump.
    const rawDate = text(raw?.entry_date);
    if (rawDate !== undefined && canonicalDate(rawDate) === undefined && badDates.size < 3) {
      badDates.add(rawDate.slice(0, 40));
    }

    const row = normalizeBehaviorRow(raw);
    if (row) rows.push(row);
  }

  return {
    rows,
    received: (rawRows ?? []).length,
    dropped: (rawRows ?? []).length - rows.length,
    freeTextKeys: [...freeText],
    nonCodeActionTaken: nonCode,
    unreadableDateSamples: [...badDates],
  };
}

export function isUnmappedType(logTypeName: string): boolean {
  return String(logTypeName ?? "").startsWith(UNMAPPED_PREFIX);
}

// ---------------------------------------------------------------------------
// Subtype resolution. Rule 4: a code is not a name.
// ---------------------------------------------------------------------------

export type SubtypeIndex = Map<string, string>;

export type ResolvedSubtype = { code: string; name: string | null; resolved: boolean };

/**
 * Code to display name, built from the GEN vocabulary this instance returned.
 *
 * The admin documentation says a subtype is configured as a code plus a
 * description, and does NOT say which GEN column holds which. Rather than guess
 * a join in SQL, `behavior_types` selects both GEN.Name and GEN.Value and this
 * index accepts either as the key. Whichever one Westbrook actually uses, the
 * lookup succeeds; if neither matches, resolveSubtype says so out loud.
 *
 * Once the grant lands, one look at the behavior_types output settles which
 * column it is, and this can collapse to a SQL join.
 */
export function buildSubtypeIndex(types: BehaviorTypeRow[]): SubtypeIndex {
  const index: SubtypeIndex = new Map();
  for (const row of types ?? []) {
    if (row.genCat !== "subtype") continue;
    // Name keyed first so a stored value that is already the display name
    // resolves to itself, then value, which is the more likely code column.
    if (row.genName) index.set(row.genName.trim().toLowerCase(), row.genName);
    if (row.genValue) index.set(row.genValue.trim().toLowerCase(), row.genName);
  }
  return index;
}

/**
 * A stored subtype code, resolved against the vocabulary, or reported unresolved.
 *
 * Never returns a bare code in the `name` position. A teacher shown "OOS" with
 * no explanation is being shown a database artifact, and a teacher shown "OOS"
 * styled as a label is being misled about how much this app knows.
 */
export function resolveSubtype(
  code: string | undefined | null,
  index: SubtypeIndex | null | undefined,
): ResolvedSubtype | null {
  const raw = text(code);
  if (raw === undefined) return null;
  const hit = index?.get(raw.toLowerCase());
  if (hit === undefined) return { code: raw, name: null, resolved: false };
  return { code: raw, name: hit, resolved: true };
}

export type BehaviorSummary = {
  /** "unknown" until a coverage record proves a window was actually pulled. */
  status: "unknown" | "covered";
  window: { start: string; end: string } | null;
  syncedAt: string | null;
  /** null, never 0, when status is "unknown". */
  totalEntries: number | null;
  byType: Array<{ logTypeName: string; count: number; lastEntryDate: string | null }>;
  /** Types the SIS could not resolve to a GEN row. Visible, not swallowed. */
  unmappedTypes: string[];
};

/**
 * Per student rollup.
 *
 * The coverage argument is what separates "this child has no log entries" from
 * "nobody has pulled log entries". Without it the two are indistinguishable and
 * the app would report the second as the first.
 */
export function behaviorSummaryFor(
  rows: BehaviorLogRow[],
  coverage: BehaviorCoverage | null,
): BehaviorSummary {
  if (!coverage) {
    return {
      status: "unknown",
      window: null,
      syncedAt: null,
      totalEntries: null,
      byType: [],
      unmappedTypes: [],
    };
  }

  const counts = new Map<string, { count: number; last: string | null }>();
  for (const row of rows) {
    const key = row.logTypeName;
    const prior = counts.get(key) ?? { count: 0, last: null };
    prior.count += 1;
    if (prior.last === null || row.entryDate > prior.last) prior.last = row.entryDate;
    counts.set(key, prior);
  }

  const byType = [...counts.entries()]
    .map(([logTypeName, v]) => ({ logTypeName, count: v.count, lastEntryDate: v.last }))
    // Most frequent first, then alphabetical so the order is stable across runs
    // and a screenshot from yesterday still lines up with one from today.
    .sort((a, b) => b.count - a.count || a.logTypeName.localeCompare(b.logTypeName));

  return {
    status: "covered",
    window: { start: coverage.windowStart, end: coverage.windowEnd },
    syncedAt: coverage.syncedAt,
    totalEntries: rows.length,
    byType,
    unmappedTypes: byType.map((t) => t.logTypeName).filter(isUnmappedType),
  };
}

/**
 * One stored row as STAFF see it.
 *
 * An allowlist built field by field, like everything in views.ts. studentNumber
 * is not repeated here because the caller already resolved the student, and
 * schoolId is not here because it identifies nothing a teacher needs.
 *
 * `subtype` is a resolved object rather than a string, so a caller cannot print
 * a raw code by accident: to render it they have to look at `resolved`.
 */
export function staffBehaviorView(row: BehaviorLogRow, subtypes?: SubtypeIndex | null) {
  return {
    id: row.logEntryId,
    date: row.entryDate,
    type: row.logTypeName,
    subtype: resolveSubtype(row.subtype, subtypes ?? null),
    consequence: row.consequence ?? null,
    actionTaken: row.actionTaken ?? null,
    incidentDate: row.incidentDate ?? null,
    author: row.entryAuthor ?? null,
  };
}

// ---------------------------------------------------------------------------
// Audience.
// ---------------------------------------------------------------------------

/**
 * The caller's classified identity. Not a lookalike of it, IT.
 *
 * This is the real union `classify()` in convex/identityRules.ts returns, so
 * the two cannot drift and there is no second definition to keep in step.
 *
 * The shape has now been wrong twice in two different ways, which is why it is
 * imported rather than described. First it was `kind: string` with the wiring
 * passing the literal "staff", so the gate could never return anything but
 * allowed while a test certified that students were denied. Then it was
 * `{ kind: string }`, which is narrower but still lets
 * behaviorAudienceFor({ kind: "stff" }) compile and silently deny, and lets any
 * object with any string kind satisfy the gate. Importing the union makes both
 * of those a compile error: the only values that typecheck here are the two
 * classify() actually produces.
 */
export type BehaviorPrincipal = Identity;

/**
 * Whether a signed in principal may see SIS behavior at all, before any
 * per-student roster check.
 *
 * STUDENTS ARE DENIED, deliberately, and denied here rather than by omission
 * somewhere upstream. A discipline record's disclosure to the student it
 * concerns is governed by the school's own process, and a rewards app is not
 * where that decision gets made by default. Widening this is a deliberate act
 * by a named person with a line in docs/behavior-sourcing.md, exactly as
 * restrictedPolicy.ts requires for the restricted demographic set.
 *
 * This is the SECOND gate, not the only one. requireStaff in identity.ts throws
 * before this is ever reached. Defence in depth is the point: identity.ts
 * answers "is this person staff", and this answers "may staff see behavior at
 * all", and the day those two answers diverge there is somewhere to put it.
 */
export function behaviorAudienceFor(
  principal: BehaviorPrincipal | null | undefined,
): { allowed: true } | { allowed: false; reason: string } {
  // The email is checked as well as the kind, and not for identification: it is
  // the field only classify() can populate, because classify throws on a token
  // that carries no email. Requiring it means a hand rolled { kind: "staff" }
  // from JavaScript that skipped the type checker is refused at runtime too.
  const email = typeof principal?.email === "string" ? principal.email.trim() : "";
  if (principal?.kind === "staff" && email !== "") return { allowed: true };
  return {
    allowed: false,
    reason:
      "SIS behavior records are staff only. Nobody has decided that a student " +
      "should read their own PowerSchool discipline log inside this app.",
  };
}

// ---------------------------------------------------------------------------
// Storage. internalMutation only: reachable from the sync action holding a
// deploy key, never from a browser. The SIS is upstream truth and nothing
// signed in from a Chromebook should be able to rewrite it.
// ---------------------------------------------------------------------------

/**
 * `psBehaviorLog` is not in the generated DataModel yet.
 *
 * convex/schema.ts is shared and this change may not edit it, so the exact
 * defineTable block is written out in docs/behavior-sourcing.md and has to be
 * pasted in before any of the mutations below can run. Until that lands
 * TypeScript has no way to know the table exists.
 *
 * The widening happens HERE, once, behind a narrow structural type rather than
 * `any`, so a typo in a method name is still a compile error. The row objects
 * themselves are built as typed BehaviorLogRow values before they reach this,
 * so field names and types stay checked; only the table NAME is unchecked.
 * When the schema diff lands, delete this function and use ctx.db directly.
 * Nothing else in this file changes.
 */
type WidenedDb = {
  insert(table: string, doc: Record<string, unknown>): Promise<unknown>;
  delete(id: unknown): Promise<void>;
  query(table: string): {
    withIndex(
      index: string,
      builder: (q: { eq(field: string, value: unknown): unknown }) => unknown,
    ): { collect(): Promise<Array<Record<string, unknown>>> };
    collect(): Promise<Array<Record<string, unknown>>>;
  };
};

function behaviorDb(db: unknown): WidenedDb {
  return db as unknown as WidenedDb;
}

/** The one table this module needs, named once so both guards below agree. */
export const BEHAVIOR_TABLE = "psBehaviorLog";

/**
 * What to say when the table is not there, which is the state TODAY.
 *
 * Every access to psBehaviorLog goes through a guard that produces this string,
 * because the alternative is a Convex internal error with a request id, and in
 * production Convex REDACTS a plain Error so the caller sees "Server Error" and
 * nothing else. The person who hits this has not made a mistake; they have hit
 * an unapplied diff, and the message names it, names the file it lives in, and
 * names the command that has to follow.
 */
export const SCHEMA_DIFF_UNAPPLIED =
  `Table "${BEHAVIOR_TABLE}" is not declared in convex/schema.ts, so no behavior ` +
  "row can be written or read. This is proposed diff 1 in docs/behavior-sourcing.md " +
  "and it is UNAPPLIED. Paste that defineTable block into convex/schema.ts, run " +
  "convex codegen, then delete the WidenedDb helper in convex/psBehavior.ts.";

/**
 * Fails loudly and legibly instead of with a Convex internal error.
 *
 * Any throw from a psBehaviorLog access is treated as the table being absent,
 * because that is overwhelmingly what it is right now and because the original
 * text is carried through anyway, truncated, so a genuinely different fault is
 * still readable rather than hidden behind a guess.
 */
function schemaError(err: unknown): ConvexError<string> {
  return new ConvexError(`${SCHEMA_DIFF_UNAPPLIED} Underlying: ${String(err).slice(0, 160)}`);
}

const behaviorRowValidator = v.object({
  studentNumber: v.string(),
  logEntryId: v.string(),
  entryDate: v.string(),
  logTypeName: v.string(),
  logTypeId: v.optional(v.string()),
  subtype: v.optional(v.string()),
  consequence: v.optional(v.string()),
  actionTaken: v.optional(v.string()),
  incidentDate: v.optional(v.string()),
  entryAuthor: v.optional(v.string()),
  schoolId: v.optional(v.string()),
});

/**
 * Full replace of the behavior window.
 *
 * A replace rather than a merge, for the same reason clearRoster is a replace:
 * a log entry can be DELETED in PowerSchool, and a merge cannot express a
 * deletion. A student whose entry was retracted by an administrator must stop
 * having it here too, and the only way to be sure of that is to stop trusting
 * anything from the previous run.
 *
 * `clearFirst` is passed on the first chunk only, matching replaceGrades, so a
 * multi chunk load does not wipe the chunks it just wrote.
 */
export const replaceWindow = internalMutation({
  args: {
    syncedAt: v.string(),
    windowStart: v.string(),
    windowEnd: v.string(),
    clearFirst: v.optional(v.boolean()),
    rows: v.array(behaviorRowValidator),
  },
  handler: async (ctx: MutationCtx, { rows, syncedAt, windowStart, windowEnd, clearFirst }) => {
    const db = behaviorDb(ctx.db);

    // The table does not exist until proposed diff 1 lands in convex/schema.ts,
    // which this change is not permitted to edit. Without this guard the first
    // real sync dies inside Convex with a redacted "Server Error" and a request
    // id, and whoever is looking at it has no way to know the cause is a diff
    // sitting unapplied in a markdown file.
    try {
      let deleted = 0;
      if (clearFirst) {
        const old = await db.query(BEHAVIOR_TABLE).collect();
        for (const row of old) {
          await db.delete(row._id);
          deleted += 1;
        }
      }

      for (const row of rows) {
        await db.insert(BEHAVIOR_TABLE, { ...row, syncedAt, windowStart, windowEnd });
      }

      return { inserted: rows.length, deleted };
    } catch (err) {
      throw schemaError(err);
    }
  },
});

/**
 * Records that a window was actually pulled.
 *
 * This is the difference between "no entries" and "no sync", and it is written
 * LAST in the sync, after the rows, so a run that dies halfway leaves the old
 * coverage in place rather than claiming a window it did not finish loading.
 *
 * Lives in appState rather than a new table because it is one row.
 */
export const recordCoverage = internalMutation({
  args: {
    windowStart: v.string(),
    windowEnd: v.string(),
    syncedAt: v.string(),
    entriesLoaded: v.number(),
  },
  handler: async (ctx: MutationCtx, coverage) => {
    const prior = await ctx.db
      .query("appState")
      .withIndex("by_key", (q) => q.eq("key", COVERAGE_KEY))
      .unique();
    const value = { ...coverage };
    if (prior) await ctx.db.patch(prior._id, { value, mirroredAt: coverage.syncedAt });
    else
      await ctx.db.insert("appState", {
        key: COVERAGE_KEY,
        value,
        mirroredAt: coverage.syncedAt,
      });
    return value;
  },
});

/**
 * The log type vocabulary as this school actually configures it.
 *
 * Stored as one appState row rather than a table: it is tens of rows, it is
 * read whole or not at all, and it contains no student data. Storing it at all
 * matters because it is the only record of what the integers in logTypeId
 * meant on the day the entries were pulled, and because buildSubtypeIndex reads
 * it to turn a subtype code into something a teacher can act on.
 */
export const putTypes = internalMutation({
  args: {
    syncedAt: v.string(),
    types: v.array(
      v.object({
        genId: v.string(),
        genCat: v.string(),
        genName: v.string(),
        genValue: v.optional(v.string()),
        schoolId: v.optional(v.string()),
        sortOrder: v.optional(v.number()),
        entriesAllTime: v.number(),
        firstEntryDate: v.optional(v.string()),
        lastEntryDate: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx: MutationCtx, { types, syncedAt }) => {
    const prior = await ctx.db
      .query("appState")
      .withIndex("by_key", (q) => q.eq("key", TYPES_KEY))
      .unique();
    if (prior) await ctx.db.patch(prior._id, { value: types, mirroredAt: syncedAt });
    else await ctx.db.insert("appState", { key: TYPES_KEY, value: types, mirroredAt: syncedAt });

    const used = types.filter((t) => t.entriesAllTime > 0);
    return {
      types: types.length,
      logTypes: types.filter((t) => t.genCat === "logtype").length,
      subtypes: types.filter((t) => t.genCat === "subtype").length,
      // The number that answers "does this school use log entries at all",
      // per school. The district wide answer is already known: 16987.
      typesWithEntries: used.length,
      entriesAllTime: used.reduce((sum, t) => sum + t.entriesAllTime, 0),
    };
  },
});

// ---------------------------------------------------------------------------
// Read. Called from studentDetail.ts AFTER requireStaff and canViewStudent,
// never before. There is no public query in this file on purpose.
// ---------------------------------------------------------------------------

export async function readCoverage(ctx: QueryCtx | MutationCtx): Promise<BehaviorCoverage | null> {
  const row = await ctx.db
    .query("appState")
    .withIndex("by_key", (q) => q.eq("key", COVERAGE_KEY))
    .unique();
  const value = row?.value as Partial<BehaviorCoverage> | undefined;
  if (!value?.windowStart || !value?.windowEnd || !value?.syncedAt) return null;
  return {
    windowStart: value.windowStart,
    windowEnd: value.windowEnd,
    syncedAt: value.syncedAt,
    entriesLoaded: Number(value.entriesLoaded ?? 0),
  };
}

/** The stored vocabulary, or null when no sync has written one. */
export async function readSubtypeIndex(ctx: QueryCtx | MutationCtx): Promise<SubtypeIndex | null> {
  const row = await ctx.db
    .query("appState")
    .withIndex("by_key", (q) => q.eq("key", TYPES_KEY))
    .unique();
  if (!row) return null;
  return buildSubtypeIndex((row.value ?? []) as BehaviorTypeRow[]);
}

export type BehaviorRead = {
  status: "unknown" | "covered" | "denied";
  reason: string | null;
  window: { start: string; end: string } | null;
  syncedAt: string | null;
  totalEntries: number | null;
  byType: BehaviorSummary["byType"];
  unmappedTypes: string[];
  entries: ReturnType<typeof staffBehaviorView>[];
};

/**
 * One student's SIS behavior, summarized, plus the entries themselves through
 * the staff allowlist.
 *
 * Takes ctx AND the caller's real principal. The principal is not optional and
 * is not a string, so there is no way to call this without having asked who is
 * asking. A denied caller gets status "denied" with a null count, which is a
 * third distinct state from "unknown" and "covered": rendering a refusal as
 * "no incidents" would be a claim about a child that nobody made.
 *
 * The per student access decision still belongs to the caller. studentDetail.ts
 * has already run requireStaff and canViewStudent(psRoster) by the time this
 * runs; re-implementing that here would create a second copy of the security
 * boundary, and the second copy is the one that drifts.
 */
export async function readBehaviorForStudent(
  ctx: QueryCtx | MutationCtx,
  principal: BehaviorPrincipal | null | undefined,
  studentNumber: string,
): Promise<BehaviorRead> {
  const audience = behaviorAudienceFor(principal);
  if (!audience.allowed) {
    return {
      status: "denied",
      reason: audience.reason,
      window: null,
      syncedAt: null,
      totalEntries: null,
      byType: [],
      unmappedTypes: [],
      entries: [],
    };
  }

  const coverage = await readCoverage(ctx);

  // Same guard as replaceWindow, opposite behaviour, and deliberately so. A
  // sync that cannot write should stop and say why; a page load that cannot
  // read must not take the student detail screen down with it. "unknown" with a
  // reason is already a state this contract has, and it is the correct one:
  // nobody has pulled anything, and the app says so instead of rendering a
  // number it does not have.
  let rows: BehaviorLogRow[];
  try {
    const raw = await behaviorDb(ctx.db)
      .query(BEHAVIOR_TABLE)
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", studentNumber))
      .collect();
    rows = raw as unknown as BehaviorLogRow[];
  } catch (err) {
    return {
      status: "unknown",
      reason: `${SCHEMA_DIFF_UNAPPLIED} Underlying: ${String(err).slice(0, 160)}`,
      window: null,
      syncedAt: null,
      totalEntries: null,
      byType: [],
      unmappedTypes: [],
      entries: [],
    };
  }

  const summary = behaviorSummaryFor(rows, coverage);
  const subtypes = summary.status === "covered" ? await readSubtypeIndex(ctx) : null;

  return {
    ...summary,
    reason: null,
    // Newest first. A behavior timeline read oldest first buries the thing the
    // teacher opened it for.
    entries:
      summary.status === "covered"
        ? [...rows]
            .sort((a, b) => (a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : 0))
            .map((row) => staffBehaviorView(row, subtypes))
        : [],
  };
}
