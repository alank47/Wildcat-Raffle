/**
 * Federal / CALPADS reporting categories, from race codes AND ethnicity.
 *
 * THE RULE THIS ENCODES, AND WHY IT IS NOT OPTIONAL.
 *
 * Federal and CALPADS reporting ask two questions, in this order:
 *
 *   1. ETHNICITY: is the student Hispanic or Latino?   (yes / no)
 *   2. RACE:      one or more race codes.
 *
 * If the answer to (1) is yes, the student is reported as HISPANIC OR LATINO
 * and the race codes are NOT reported separately. That is not a rounding
 * convention or a display preference; it is how the categories are defined,
 * and every state and federal discipline report is built that way.
 *
 * IGNORING IT IS WHAT MADE THIS APP'S FIRST RACE CHART WRONG.
 *
 * The race question still has to be answered for a Hispanic student, and in
 * California it is very commonly answered 700 (White). So a breakdown that
 * reads raceCodes alone reports a predominantly Hispanic school as White,
 * with no Hispanic row at all, because there is no race code for Hispanic.
 *
 * The school's own admin caught it on sight: "I see 4 for White students but
 * I am fairly certain that my school has no white students." They were right,
 * and the chart was wrong in exactly the way a wrong chart about children's
 * race is worst: quietly, and with a plausible-looking number.
 *
 * UNKNOWN IS NEVER SILENTLY TREATED AS "NOT HISPANIC".
 *
 * If the ethnicity value is missing or unrecognised, this does NOT assume no.
 * Assuming no is what reproduces the original bug for any student whose
 * ethnicity failed to sync. It is reported as unknown, counted, and surfaced,
 * so a sync gap looks like a sync gap instead of a demographic finding.
 */

export type Ethnicity = "hispanic" | "not" | "unknown";

export const HISPANIC_LABEL = "Hispanic or Latino";

/**
 * Accepted spellings of the federal ethnicity flag.
 *
 * PowerSchool's Students.FedEthnicity is usually 1/0, but instances vary and
 * the value arrives here as a string from a PowerQuery. Anything not listed
 * is UNKNOWN rather than assumed, on purpose: see above.
 */
const YES = new Set(["1", "Y", "YES", "H", "TRUE", "T", "HISPANIC", "HISPANIC OR LATINO", "HISPANIC/LATINO"]);
const NO = new Set(["0", "N", "NO", "FALSE", "F", "NOT HISPANIC", "NON-HISPANIC", "NONHISPANIC", "NOT HISPANIC OR LATINO"]);

export function classifyEthnicity(raw: unknown): Ethnicity {
  const v = String(raw ?? "").trim().toUpperCase();
  if (!v) return "unknown";
  if (YES.has(v)) return "hispanic";
  if (NO.has(v)) return "not";
  return "unknown";
}

/**
 * CALPADS race codes to reporting categories.
 *
 * MAPPED BY GROUP, NOT BY SUBCODE, on purpose. CALPADS distinguishes 201
 * Asian Indian from 203 Chinese from 207 Korean; federal disproportionality
 * reporting uses the categories below, and every subcode in this school has a
 * handful of students, so labelling a group of one or two by national origin
 * on a discipline chart identifies that child to anyone who knows the school.
 * Rolling up is both the correct reporting unit AND the safer one.
 *
 * Filipino stays its own category because CALPADS reports it separately.
 *
 * An unrecognised code is NEVER guessed. A wrong race name on a chart about
 * children is worse than no name, so it is returned flagged and counted in a
 * footnote rather than given a label or a bar of its own.
 */
export function raceLabel(code: string): { label: string; mapped: boolean } {
  const c = String(code ?? "").trim();
  if (c === "100") return { label: "American Indian or Alaska Native", mapped: true };
  if (c === "400") return { label: "Filipino", mapped: true };
  if (c === "600") return { label: "Black or African American", mapped: true };
  if (c === "700") return { label: "White", mapped: true };
  if (/^2\d\d$/.test(c)) return { label: "Asian", mapped: true };
  if (/^3\d\d$/.test(c)) return { label: "Native Hawaiian or Other Pacific Islander", mapped: true };
  return { label: "Code " + c, mapped: false };
}

export interface RestrictedRow {
  fedEthnicity?: string;
  raceCodes?: string[];
}

export interface Reported {
  /** The categories this student is reported under. Hispanic collapses to one. */
  categories: string[];
  /** Which question decided it, so a reader can audit the number. */
  basis: "ethnicity" | "race" | "none";
  ethnicity: Ethnicity;
  /** Race codes the mapping did not recognise. */
  unmapped: string[];
  /** Race labels, ALWAYS computed, even when ethnicity wins. Verification
   *  needs to show what the race codes said as well as what was reported. */
  raceLabels: string[];
}

/**
 * The reporting category or categories for one student.
 *
 * A non-Hispanic student with codes in two categories counts under BOTH, and
 * is never collapsed into "Two or more races": that is a reporting decision
 * this school has not made, and it hides exactly the students it claims to
 * describe.
 */
export function reportedCategories(row: RestrictedRow): Reported {
  const ethnicity = classifyEthnicity(row?.fedEthnicity);

  const labels = new Set<string>();
  const unmapped: string[] = [];
  for (const code of (row?.raceCodes ?? []).filter(Boolean)) {
    const { label, mapped } = raceLabel(code);
    if (!mapped) { unmapped.push(code); continue; }
    labels.add(label);
  }
  const raceLabels = [...labels];

  // Ethnicity wins. This is the whole point of the module.
  if (ethnicity === "hispanic") {
    return { categories: [HISPANIC_LABEL], basis: "ethnicity", ethnicity, unmapped, raceLabels };
  }

  // "not" and "unknown" both fall through to race, but they are NOT the same
  // and the caller is told which: unknown means the ethnicity question was
  // never answered for this student, and a pile of unknowns is a sync problem
  // rather than a fact about children.
  if (!raceLabels.length) {
    return { categories: [], basis: "none", ethnicity, unmapped, raceLabels };
  }
  return { categories: raceLabels, basis: "race", ethnicity, unmapped, raceLabels };
}
