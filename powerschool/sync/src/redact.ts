/**
 * Redaction for sample payloads.
 *
 * The brief requires showing one raw sample payload per query with names
 * redacted. This module is the only sanctioned way to print a record that
 * came out of PowerSchool. Nothing else in the harness prints record bodies.
 *
 * Redaction is allowlist shaped on purpose. A key it has never seen before is
 * masked rather than passed through, so adding a column to a query cannot
 * silently leak a name or an identifier into a terminal or a log file.
 */

/** Keys that are safe to print verbatim. Everything else gets masked. */
const SAFE_KEYS = new Set([
  "grade_level",
  "gender",
  "enroll_status",
  "section_number",
  "section_expression",
  "period_abbreviations",
  "cycle_day_abbreviations",
  "meeting_count",
  "course_number",
  "course_name",
  "term_id",
  "term_abbreviation",
  "school_id",
  "school_number",
  "days_absent_term",
  "days_absent_ytd",
  "days_tardy_term",
  "attendance_rows_ytd",
  "term_first_day",
  "term_last_day",
  "current_grade",
  "current_percent",
  "grade_source",
  "last_grade_update",
  "staff_status",
  "status",
  "role_hint",
  "section_count",
  "abbreviation",
  "name",
  "first_day",
  "last_day",
  "is_year_rec",
  "portion",
  "year_id",
  "presence_status_cd",
  "att_code",
  "description",
]);

/** Keys that are always masked no matter what, including in nested objects. */
const NEVER_PRINT = [
  /name/i,
  /email/i,
  /student_number/i,
  /studentsdcid/i,
  /dcid/i,
  /_id$/i,
  /^id$/i,
  /race/i,
  /ethnic/i,
  /ela/i,
  /iep/i,
  /504/i,
  /secret/i,
  /token/i,
  /password/i,
];

function isNeverPrint(key: string): boolean {
  return NEVER_PRINT.some((pattern) => pattern.test(key));
}

/**
 * Stable pseudonym. The same input maps to the same token within a run so a
 * reviewer can see that two rows belong to one student without seeing who.
 * Not a security control. Do not treat it as de-identification.
 */
const pseudonyms = new Map<string, string>();
function pseudonym(prefix: string, value: string): string {
  const cacheKey = `${prefix}:${value}`;
  const existing = pseudonyms.get(cacheKey);
  if (existing) return existing;
  const token = `${prefix}_${String(pseudonyms.size + 1).padStart(3, "0")}`;
  pseudonyms.set(cacheKey, token);
  return token;
}

export function redactRecord(record: unknown): unknown {
  if (record === null || record === undefined) return record;
  if (Array.isArray(record)) return record.map(redactRecord);
  if (typeof record !== "object") return record;

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (value !== null && typeof value === "object") {
      output[key] = redactRecord(value);
      continue;
    }

    if (isNeverPrint(key)) {
      if (value === null || value === "") {
        output[key] = null;
        continue;
      }
      // Preserve shape so a reviewer can still spot a malformed identifier.
      const kind = /email/i.test(key)
        ? "EMAIL"
        : /name/i.test(key)
          ? "NAME"
          : /race|ethnic|ela|iep|504/i.test(key)
            ? "RESTRICTED"
            : "ID";
      output[key] = pseudonym(kind, String(value));
      continue;
    }

    output[key] = SAFE_KEYS.has(key.toLowerCase()) ? value : maskUnknown(value);
  }
  return output;
}

/**
 * A column nobody added to the allowlist. Show its type and length, not its
 * content. Seeing "[string len=11]" is enough to notice an unexpected value
 * without printing it.
 */
function maskUnknown(value: unknown): string {
  if (value === null) return "[null]";
  if (typeof value === "number") return `[number]`;
  if (typeof value === "boolean") return `[boolean]`;
  return `[string len=${String(value).length}]`;
}

export function redactSample(rows: unknown[], count = 1): unknown[] {
  return rows.slice(0, count).map(redactRecord);
}
