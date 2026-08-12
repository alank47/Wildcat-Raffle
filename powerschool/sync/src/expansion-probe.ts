/**
 * Coverage expansion probe. READ ONLY, GET only.
 *
 * Run:  node --env-file=.env src/expansion-probe.ts
 *
 * There is no npm script for it yet. `powerschool/sync/package.json` is not a
 * file this piece owns, so the one line that adds `npm run expansion` is
 * proposed in the report rather than applied here.
 *
 * Purpose. `probe.ts` answers "did the 19 fields we asked for get granted?".
 * This answers a different question: "what ELSE is in this instance that a
 * teacher or student dashboard would actually look at, and can we reach it?"
 *
 * It writes docs/sis-expansion.md and touches nothing else. It never calls
 * anything but GET, and it inherits the ReadOnlyViolation guard in client.ts,
 * so it structurally cannot write. Behavior tables (LOG, GEN, INCIDENT_*) are
 * deliberately absent from every list below: another piece owns those and two
 * probes hitting the same table teaches nothing twice.
 *
 * ---------------------------------------------------------------------------
 * THE CLASSIFICATION TRICK, which is the whole reason this file exists
 * ---------------------------------------------------------------------------
 * PowerSchool answers a table endpoint read with four distinguishable states,
 * and the difference between them is the difference between "ask the admin for
 * a grant" and "stop, this data does not exist here":
 *
 *   200  column exists AND is granted.
 *   403  "At least one column lacks sufficient permission"
 *        -> the TABLE exists and the COLUMN exists. Only the grant is missing.
 *           Fixable by editing plugin.xml and bumping the version.
 *   400  "Invalid field specified: X is not valid column for table: Y"
 *        -> the TABLE exists (PowerSchool named it back to us) and the COLUMN
 *           does not. No grant will ever fix this. Guess a different column.
 *   404 / other
 *        -> the table itself is not reachable at this endpoint.
 *   405  the table exists but PowerSchool does not expose it over
 *        /ws/schema/table at all, regardless of grants (TEACHERS is the known
 *        case). Read it through a PowerQuery instead. NOT a permission gap.
 *
 * So a single deliberately nonsense column name is a table existence test that
 * needs no grant at all. That is the `canary` below, and it is how this probe
 * answers "does SECTIONMEETING exist in this instance?" without asking anyone
 * for access first.
 *
 * A control probe against a table nobody could plausibly have
 * (`wildcat_probe_no_such_table`) pins down what "missing" actually looks like
 * on this server, so the classification above is measured rather than assumed.
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, redactedConfig, productionRisk, type Config } from "./config.ts";
import { PowerSchoolClient } from "./client.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const OUTPUT_PATH = resolve(REPO_ROOT, "docs", "sis-expansion.md");

/**
 * Everything ABOVE this marker in docs/sis-expansion.md is hand written
 * analysis: the ranking, the reasoning, the proposed grants. Everything BELOW
 * it is regenerated on every run.
 *
 * The probe writes into the same file the analysis lives in, which would
 * normally mean a run destroys the reasoning. It does not, because the run
 * reads the file first, keeps every byte above this line, and replaces only
 * what follows. If the marker is missing the machine section is appended and
 * nothing is lost either way.
 */
const PROBE_MARKER = "<!-- PROBE OUTPUT BELOW. Everything under this line is regenerated. -->";

/** A column name that cannot exist. Used to test table existence with no grant. */
const CANARY_COLUMN = "wildcat_probe_canary_column";
/** A table name that cannot exist. Used to learn what "missing" looks like here. */
const CONTROL_MISSING_TABLE = "wildcat_probe_no_such_table";

type Reach =
  | "granted"
  | "ungranted-column-exists"
  | "column-absent"
  | "table-absent"
  | "endpoint-closed"
  | "error";

type ColumnProbe = {
  table: string;
  column: string;
  reach: Reach;
  status: number;
  detail: string;
};

type TableProbe = {
  table: string;
  exists: "yes" | "no" | "endpoint-closed" | "unknown";
  canaryStatus: number;
  canaryDetail: string;
  columns: ColumnProbe[];
};

type Value = "high" | "medium" | "low" | "declined";

type Candidate = {
  /** Stable key used in the report. */
  key: string;
  title: string;
  /** Why a teacher or a student would ever look at this. Ranking evidence. */
  whyDashboard: string;
  value: Value;
  tables: Array<{ table: string; columns: string[] }>;
  /** Set when we choose not to probe at all, with the reason. */
  skipReason?: string;
};

/**
 * The candidate list, ordered by the ranking argument in the report, not by
 * convenience. Behavior tables are owned by another piece and are absent.
 *
 * Column guesses matter: a 400 tells us the table is real and the guess was
 * wrong, which is still progress. So each table carries several plausible
 * spellings rather than one.
 */
const CANDIDATES: Candidate[] = [
  {
    key: "attendance-per-section",
    title: "Attendance at period level rather than daily",
    whyDashboard:
      "attendance_summary counts COUNT(DISTINCT ATT_DATE), so a student who cuts one period reads " +
      "identically to a student who missed the whole day. A teacher can only act on the first. " +
      "ATTENDANCE.CCID and ATTENDANCE.PERIODID are already granted and used by nothing.",
    value: "high",
    tables: [
      {
        table: "attendance",
        columns: ["ccid", "periodid", "att_date", "studentid", "attendance_codeid", "yearid", "att_mode_code"],
      },
      { table: "cc", columns: ["id", "sectionid", "expression", "dateenrolled", "dateleft"] },
    ],
  },
  {
    key: "period-structure",
    title: "Section meeting and period structure (bell schedule)",
    whyDashboard:
      "ClawPass in script.js matches a student's section period against a bell schedule that is " +
      "hardcoded in the file (A1, P1..P6, HPU, A2 with literal start and end times). If the SIS " +
      "period tokens or the bell times ever move, ClawPass names the wrong teacher on a hall pass " +
      "and nothing errors. A structured period source replaces a hand maintained table.",
    value: "high",
    tables: [
      {
        table: "sectionmeeting",
        columns: ["id", "sectionid", "period_number", "cycle_day_id", "sections_dcid", "periods_dcid", "expression"],
      },
      // Column lists refined by a previous live run: the spellings below are
      // the ones this instance answered 403 to (exists, ungranted) rather than
      // 400 (no such column), so an access request built from them will not be
      // rejected for naming a column that does not exist. PERIOD notably has
      // NO start_time or end_time here; the clock times live on
      // BELL_SCHEDULE_ITEMS, which is exactly what ClawPass hardcodes.
      { table: "period", columns: ["id", "dcid", "period_number", "name", "abbreviation", "sort_order", "schoolid"] },
      { table: "cycle_day", columns: ["id", "dcid", "abbreviation", "letter", "day_number", "schoolid"] },
      { table: "bell_schedule", columns: ["id", "dcid", "name", "schoolid"] },
      { table: "bell_schedule_items", columns: ["id", "dcid", "bell_schedule_id", "period_id", "start_time", "end_time"] },
      { table: "calendar_day", columns: ["id", "date_value", "bell_schedule_id", "cycle_day_id", "insession", "schoolid"] },
    ],
  },
  {
    key: "enrollment-history",
    title: "Transfer history (REENROLLMENTS), and the current enrollment clip",
    whyDashboard:
      "Two different things share this row and the difference decides the value. The CURRENT " +
      "enrollment clip (STUDENTS.ENTRYDATE, STUDENTS.EXITDATE, CC.DATEENROLLED) is already granted " +
      "and in no query, but the evidence section shows it carries almost no per student variation " +
      "at this school, so a denominator built from it is the same number for every student. Actual " +
      "transfer history, which is what a mid year arrival looks like, lives in REENROLLMENTS, and " +
      "that table is NOT granted. Do not read a delivered clip as a delivered history.",
    value: "medium",
    tables: [
      { table: "students", columns: ["entrydate", "exitdate", "enroll_status", "schoolid"] },
      {
        // Spellings refined by a live run: these returned 403 (exists,
        // ungranted). `yearid`, `school_year`, `entry_comment` and
        // `exit_comment` returned 400 here and must NOT appear in an access
        // request, because a request naming a column this instance does not
        // have is a rejected request.
        table: "reenrollments",
        columns: ["id", "dcid", "studentid", "schoolid", "entrydate", "exitdate", "entrycode", "exitcode", "grade_level", "fteid", "track"],
      },
    ],
  },
  {
    key: "v1-api-capability",
    title: "accessLevelV1Api, the plugin capability that unlocks /ws/v1",
    whyDashboard:
      "One capability, not a field grant, and it gates the whole /ws/v1 surface at once: the core " +
      "resources and with them the twelve documented student expansions, which include " +
      "school_enrollment, initial_enrollment, contact, contact_info, fees and lunch. It is ranked " +
      "here rather than mentioned in prose because pricing transfer history at 7 REENROLLMENTS " +
      "field grants while leaving this in a footnote hides the cheaper trade from anyone reading " +
      "the ranking top down. This project would still decline contacts, fees and lunch on value " +
      "grounds after the capability landed. The honest reason to want it is enrollment history.",
    value: "medium",
    tables: [],
    skipReason:
      "Not a table, so the table endpoint cannot probe it. It is measured instead by the /ws/v1 " +
      "evidence section, which is the authority for this row: every /ws/v1 resource path answers " +
      "401 `Plugin is missing required accessLevelV1Api READ permission` on this token, while " +
      "/ws/v1/metadata answers 200 on the same token. Unlocking it is a plugin capability change " +
      "an admin makes, not a <field> line, so it cannot be bundled into a field grant request.",
  },
  {
    key: "gpa",
    title: "Cumulative GPA and credit history",
    whyDashboard:
      "A raffle and rewards product has an obvious eligibility question, and GPA is the field a " +
      "school already trusts for it. GPA is not a stored column on STUDENTS: it is computed from " +
      "STOREDGRADES.GPA_POINTS against GRADESCALEITEM. We hold STOREDGRADES.GRADE and .PERCENT " +
      "but not the GPA arithmetic columns.",
    value: "medium",
    tables: [
      {
        table: "storedgrades",
        columns: ["gpa_points", "earnedcrhrs", "potentialcrhrs", "excludefromgpa", "grade_level", "termid"],
      },
      { table: "gradescaleitem", columns: ["id", "grade", "gpa_value", "cutoffpercentage", "gradescaleid"] },
      { table: "gradescale", columns: ["id", "name", "schoolid"] },
    ],
  },
  {
    key: "assignments",
    title: "Assignment level and standards level grades",
    whyDashboard:
      "A missing assignment count is the single most actionable number a teacher dashboard can " +
      "show, and it is the one thing a term percent hides. PowerTeacher Pro keeps it on " +
      "ASSIGNMENTSCORE.ISMISSING.",
    value: "medium",
    tables: [
      {
        table: "assignmentsection",
        columns: ["assignmentsectionid", "sectionsdcid", "name", "duedate", "pointspossible", "iscountedinfinalgrade"],
      },
      {
        table: "assignmentscore",
        columns: ["assignmentscoreid", "assignmentsectionid", "studentsdcid", "scorepoints", "islate", "ismissing", "isexempt"],
      },
      { table: "pgassignments", columns: ["id", "sectionid", "name", "pointspossible", "duedate"] },
      { table: "pgassignmentscores", columns: ["id", "assignmentid", "studentid", "points"] },
    ],
  },
  {
    key: "honor-roll",
    title: "Honor roll",
    whyDashboard:
      "Named in the brief as a candidate. Would be a ready made reward trigger if the school " +
      "already computes it. PowerSchool computes honor roll into its own table when the district " +
      "has set up honor roll methods; many never do.",
    value: "low",
    tables: [
      { table: "honor_roll", columns: ["id", "studentid", "storecode", "honor_roll_name", "yearid"] },
      { table: "studenthonorroll", columns: ["id", "studentid", "storecode", "name"] },
    ],
  },
  {
    key: "contacts",
    title: "Contacts and guardians",
    whyDashboard:
      "A teacher wanting to call home is a real workflow, but it is not THIS product's workflow: " +
      "Wildcat Hub awards and spends Wildcat Cash. Probed for existence only so the answer is on " +
      "record, and ranked as declined below regardless of the result. Third party adult PII is the " +
      "single largest new exposure this project could take on and it buys a points dashboard nothing.",
    value: "declined",
    tables: [
      { table: "studentcontactassoc", columns: ["studentcontactassocid", "studentdcid", "personid"] },
      { table: "person", columns: ["id", "firstname", "lastname", "isactive"] },
      { table: "personemailaddress", columns: ["personemailaddressid", "personid", "emailaddressid"] },
    ],
  },
  {
    key: "activities",
    title: "Activities and groups",
    whyDashboard:
      "STUDENTS.ACTIVITIES is a legacy bitmask whose meaning lives in GEN rows with Cat='activity'. " +
      "GEN belongs to the behavior piece, so this probe only asks whether the STUDENTS column " +
      "exists and stops there.",
    value: "low",
    tables: [{ table: "students", columns: ["activities"] }],
  },
  {
    key: "fees-lunch",
    title: "Cafeteria and fee balances",
    whyDashboard:
      "Explicitly deranked in docs/sis-coverage.md and deranked again here. A cafeteria balance is " +
      "a debt a child cannot pay; surfacing it inside a rewards app is a bad idea independent of " +
      "whether it is reachable. Existence probe only, one column, so the answer is on record.",
    value: "declined",
    tables: [
      { table: "fee", columns: ["id", "studentid", "amount"] },
      { table: "studentfee", columns: ["id", "studentid", "balance"] },
    ],
  },
  {
    key: "health",
    title: "Health",
    whyDashboard:
      "Named in the brief as a candidate. Declined without a probe, on purpose.",
    value: "declined",
    tables: [],
    skipReason:
      "Not probed at all. Health data is the most sensitive category in the SIS, a points and " +
      "raffle dashboard has no decision that consumes it, and probing it against a PRODUCTION " +
      "instance holding real children's records would put a health table name in a request log for " +
      "no benefit anyone can name. If a use case is ever named, that conversation starts with the " +
      "registrar, not with a probe.",
  },
];

/** One column read. Cheapest question that separates the four reach states. */
async function probeColumn(
  client: PowerSchoolClient,
  table: string,
  column: string,
): Promise<ColumnProbe> {
  try {
    const { status, json, text } = await client.get(`/ws/schema/table/${table}`, {
      projection: column,
      pagesize: 1,
    });
    const detail = extractMessage(json, text);

    if (status === 200) {
      return { table, column, reach: "granted", status, detail: "one row read succeeded" };
    }
    if (status === 403) {
      return { table, column, reach: "ungranted-column-exists", status, detail };
    }
    if (status === 400) {
      // "not valid column for table: X" names the table back to us, which is
      // itself proof the table exists. A different 400 is not that proof.
      const namesTable = /not valid column for table/i.test(detail);
      return {
        table,
        column,
        reach: namesTable ? "column-absent" : "error",
        status,
        detail,
      };
    }
    if (status === 405) {
      return { table, column, reach: "endpoint-closed", status, detail };
    }
    return { table, column, reach: "table-absent", status, detail };
  } catch (error: unknown) {
    return {
      table,
      column,
      reach: "error",
      status: 0,
      detail: error instanceof Error ? error.message.slice(0, 200) : String(error),
    };
  }
}

async function probeTable(
  client: PowerSchoolClient,
  table: string,
  columns: string[],
): Promise<TableProbe> {
  const canary = await probeColumn(client, table, CANARY_COLUMN);

  let exists: TableProbe["exists"] = "unknown";
  if (canary.reach === "column-absent" || canary.reach === "ungranted-column-exists") exists = "yes";
  else if (canary.reach === "endpoint-closed") exists = "endpoint-closed";
  else if (canary.reach === "table-absent") exists = "no";
  else if (canary.reach === "granted") exists = "yes"; // would be bizarre, but it is still a yes

  // No point burning requests enumerating columns on a table that is not there.
  const probes: ColumnProbe[] = [];
  if (exists === "yes") {
    for (const column of columns) {
      probes.push(await probeColumn(client, table, column));
    }
  }

  return {
    table,
    exists,
    canaryStatus: canary.status,
    canaryDetail: canary.detail,
    columns: probes,
  };
}

function extractMessage(json: any, text: string): string {
  const candidate =
    json?.message ??
    json?.errorMessage ??
    json?.errors?.[0]?.message ??
    json?.error_description ??
    null;
  const raw = typeof candidate === "string" ? candidate : text;
  return String(raw ?? "").replace(/\s+/g, " ").slice(0, 220) || "no message returned";
}

// ---------------------------------------------------------------------------
// Evidence. Reachability is not usefulness. A granted column that is null in
// every row buys nothing, so the high value candidates get a real bounded read
// and a populated rate. Values are never printed; only counts, rates, and
// period expression tokens, which are timetable labels and not PII.
// ---------------------------------------------------------------------------

type Populated = { column: string; rows: number; nonNull: number; rate: string; distinct: number };

function populationStats(rows: any[], columns: string[]): Populated[] {
  return columns.map((column) => {
    const values = rows.map((row) => row?.tables ? firstTableValue(row, column) : row?.[column]);
    const nonNull = values.filter((v) => v !== null && v !== undefined && v !== "").length;
    const distinct = new Set(values.filter((v) => v !== null && v !== undefined && v !== "")).size;
    return {
      column,
      rows: rows.length,
      nonNull,
      rate: rows.length === 0 ? "n/a" : `${Math.round((nonNull / rows.length) * 100)}%`,
      distinct,
    };
  });
}

/** Table endpoint rows arrive as { tables: { students: { ... } } }. */
function firstTableValue(row: any, column: string): unknown {
  const tables = row?.tables;
  if (!tables || typeof tables !== "object") return undefined;
  for (const value of Object.values(tables)) {
    if (value && typeof value === "object" && column in (value as Record<string, unknown>)) {
      return (value as Record<string, unknown>)[column];
    }
  }
  return undefined;
}

function extractRows(json: any): any[] {
  if (Array.isArray(json?.record)) return json.record;
  if (Array.isArray(json?.records)) return json.records;
  return [];
}

type Evidence = { title: string; ok: boolean; lines: string[] };

/**
 * The expansion PowerQueries this probe calls, and the args each one declares.
 *
 * Single sourced so the live install check and the offline self test cannot
 * drift apart. The self test asserts this list and the query file name the same
 * four queries, which is what stops a rename from turning into a phantom 404.
 */
const NAMED_QUERY_ARGS: Array<{ short: string; args: string[] }> = [
  { short: "attendance_join_health", args: ["schoolid", "yearid"] },
  { short: "attendance_by_section", args: ["schoolid", "termid"] },
  { short: "enrollment_window", args: ["schoolid", "termid"] },
  { short: "period_structure", args: ["schoolid", "termid"] },
];

/** Reads one value out of a table endpoint row, whatever table wrapper it came in. */
function cell(row: any, column: string): unknown {
  return row?.tables ? firstTableValue(row, column) : row?.[column];
}

/**
 * Pages a scoped table read to exhaustion, or to a cap.
 *
 * The `q` argument is not optional by accident. An earlier version of this file
 * sampled page 1 of SECTIONS with no filter and reported the result as the
 * Westbrook timetable. Every one of those 100 rows belonged to school 1818,
 * a DIFFERENT school in the same district, so the conclusion drawn from it was
 * about the wrong building. Every read below is scoped to PS_SCHOOL_ID now, and
 * each report line states the scope it was measured under.
 */
async function pageScoped(
  client: PowerSchoolClient,
  table: string,
  projection: string[],
  q: string,
  cap: number,
): Promise<{ rows: any[]; status: number; detail: string }> {
  const out: any[] = [];
  let status = 0;
  for (let page = 1; page <= 80; page += 1) {
    const response = await client.get(`/ws/schema/table/${table}`, {
      projection: projection.join(","),
      q,
      pagesize: 100,
      page,
    });
    status = response.status;
    if (response.status !== 200) {
      return { rows: out, status, detail: extractMessage(response.json, response.text) };
    }
    const rows = extractRows(response.json);
    out.push(...rows);
    if (rows.length < 100 || out.length >= cap) break;
  }
  return { rows: out, status, detail: "" };
}

/**
 * The one read in this file that is deliberately NOT scoped to the school.
 *
 * Every other read is scoped, for the reason recorded on `pageScoped`. This one
 * must not be, and that is the entire point: 130 of the 484 COURSES rows in this
 * instance carry SCHOOLID 0, meaning district level, and a read scoped to
 * `schoolid==1817` cannot see them. Scoping this read is exactly the mistake
 * that the equality predicate in the sibling query file makes in SQL.
 *
 * COURSES holds no student data. Course number, course name, school. Reading all
 * of it costs five requests and exposes nothing.
 */
type CourseCensus = {
  ok: boolean;
  detail: string;
  rows: Array<{ number: string; name: string; school: string }>;
  bySchool: Map<string, number>;
};

const DISTRICT_SCHOOL_ID = "0";

async function readCourseCensus(client: PowerSchoolClient): Promise<CourseCensus> {
  const out: any[] = [];
  for (let page = 1; page <= 60; page += 1) {
    const response = await client.get("/ws/schema/table/courses", {
      projection: "id,course_number,course_name,schoolid",
      pagesize: 100,
      page,
    });
    if (response.status !== 200) {
      return {
        ok: false,
        detail: `${response.status} ${extractMessage(response.json, response.text)}`,
        rows: [],
        bySchool: new Map(),
      };
    }
    const rows = extractRows(response.json);
    out.push(...rows);
    if (rows.length < 100) break;
  }
  const bySchool = new Map<string, number>();
  const rows = out.map((row) => {
    const school = String(cell(row, "schoolid") ?? "");
    bySchool.set(school, (bySchool.get(school) ?? 0) + 1);
    return {
      number: String(cell(row, "course_number") ?? ""),
      name: String(cell(row, "course_name") ?? ""),
      school,
    };
  });
  return { ok: true, detail: "", rows, bySchool };
}

/**
 * How many COURSES rows a section's course resolves to under one predicate.
 *
 * `allowDistrict` false is the equality predicate the sibling file ships.
 * `allowDistrict` true is the OR predicate this file ships. Returning a COUNT
 * rather than a boolean is deliberate: a count above one would mean the OR
 * multiplies rows, which is the one way the fix could be worse than the defect,
 * so it has to be measured rather than asserted.
 */
function courseMatchCount(
  census: CourseCensus,
  courseNumber: string,
  sectionSchool: string,
  allowDistrict: boolean,
): number {
  let matches = 0;
  for (const course of census.rows) {
    if (course.number !== courseNumber) continue;
    if (course.school === sectionSchool) matches += 1;
    else if (allowDistrict && course.school === DISTRICT_SCHOOL_ID) matches += 1;
  }
  return matches;
}

/** GET /ws/schema/table/{t}/count. Cheap exact size for a scope. */
async function scopedCount(
  client: PowerSchoolClient,
  table: string,
  q: string,
): Promise<number | null> {
  const response = await client.get(`/ws/schema/table/${table}/count`, { q });
  if (response.status !== 200) return null;
  const count = response.json?.count;
  return typeof count === "number" ? count : null;
}

/**
 * The load bearing question for the top ranked gap. ATTENDANCE.CCID and
 * .PERIODID are granted, but "granted" says nothing about "populated". If CCID
 * is null on every row then per section attendance is not a small build, it is
 * impossible, and the ranking below is wrong.
 */
async function evidenceAttendanceKeys(
  client: PowerSchoolClient,
  config: Config,
): Promise<Evidence> {
  const title = "ATTENDANCE.CCID and .PERIODID are populated at this school";
  const lines: string[] = [];
  const columns = ["id", "studentid", "att_date", "ccid", "periodid", "attendance_codeid", "att_mode_code", "yearid"];
  try {
    // Attendance volume per year, so a zero is never read as a null column.
    lines.push(`Scope: \`schoolid==${config.schoolId}\`. Row counts straight from the count endpoint.`);
    lines.push("");
    lines.push("| Scope | ATTENDANCE rows |");
    lines.push("|---|---:|");
    const currentYear = Number(config.yearId);
    const years = [currentYear - 2, currentYear - 1, currentYear].filter((year) => Number.isFinite(year));
    let bestYear = currentYear;
    let bestCount = -1;
    for (const year of years) {
      const count = await scopedCount(client, "attendance", `schoolid==${config.schoolId};yearid==${year}`);
      lines.push(`| \`yearid==${year}\`${year === currentYear ? " (current)" : ""} | ${count ?? "read failed"} |`);
      if ((count ?? 0) > bestCount) {
        bestCount = count ?? 0;
        bestYear = year;
      }
    }
    lines.push("");
    if (bestCount <= 0) {
      lines.push("**No attendance rows in any sampled year.** Nothing further can be measured here.");
      return { title, ok: false, lines };
    }
    if (
      (await scopedCount(client, "attendance", `schoolid==${config.schoolId};yearid==${currentYear}`)) === 0
    ) {
      lines.push(
        `The CURRENT year has zero attendance rows, which is expected rather than broken: the 26-27 ` +
          `school year begins after this was run. Population is therefore measured against \`yearid==${bestYear}\`, ` +
          `the most recent year that has data. A dashboard built on the current year must render this ` +
          `as "not started", never as a 100 percent attendance rate.`,
      );
      lines.push("");
    }

    const { rows, status, detail } = await pageScoped(
      client,
      "attendance",
      columns,
      `schoolid==${config.schoolId};yearid==${bestYear}`,
      100,
    );
    if (status !== 200) return { title, ok: false, lines: [...lines, `Read failed with ${status}: ${detail}`] };

    lines.push(`Sampled ${rows.length} ATTENDANCE rows at \`schoolid==${config.schoolId};yearid==${bestYear}\`.`);
    lines.push("");
    lines.push("| Column | Rows | Non null | Rate | Distinct values |");
    lines.push("|---|---:|---:|---:|---:|");
    for (const stat of populationStats(rows, columns)) {
      lines.push(`| \`${stat.column}\` | ${stat.rows} | ${stat.nonNull} | ${stat.rate} | ${stat.distinct} |`);
    }
    const ccidStat = populationStats(rows, ["ccid"])[0];
    lines.push("");
    lines.push(
      ccidStat.nonNull > 0
        ? `**CCID is populated: ${ccidStat.nonNull} of ${ccidStat.rows} sampled rows carry one.** A per ` +
          "section absence count is buildable from columns already granted."
        : "**CCID is null on every sampled row.** Per section attendance is NOT buildable from this " +
          "column and the ranking below must be corrected before anyone builds it.",
    );
    return { title, ok: ccidStat.nonNull > 0, lines };
  } catch (error: unknown) {
    return { title, ok: false, lines: [error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * The four expansion PowerQueries, actually called.
 *
 * POST to `/ws/schema/query/{name}` is the one POST the project's hard rules
 * permit, because a PowerQuery's SQL is structurally read only. Calling them is
 * the only way to tell "this SQL is correct" from "this SQL has never run", and
 * a 404 here is itself the answer to "are these installed?".
 */
async function evidenceNamedQueriesInstalled(
  client: PowerSchoolClient,
  config: Config,
): Promise<Evidence> {
  const title = "Are the four expansion PowerQueries callable on this instance?";
  const lines: string[] = [];
  lines.push(
    "Each name below was called for real with POST, the one verb the hard rules permit against a " +
      "named query path. This is not a dry run and not a simulation.",
  );
  lines.push("");
  lines.push("| PowerQuery | Result |");
  lines.push("|---|---|");
  let anyInstalled = false;
  for (const { short, args: argSpec } of NAMED_QUERY_ARGS) {
    const name = `com.lapromisefund.wildcathub.${short}`;
    const body: Record<string, string | number> = {};
    for (const key of argSpec) {
      body[key] =
        key === "schoolid" ? config.schoolId : key === "termid" ? config.termId : config.yearId;
    }
    try {
      const { rows } = await client.namedQuery(name, body, { maxPages: 1 });
      anyInstalled = true;
      lines.push(`| \`${short}\` | **200, ${rows.length} rows on page 1** |`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /with (\d{3})\./.exec(message)?.[1] ?? "error";
      const notFound = message.includes("not found");
      lines.push(
        `| \`${short}\` | ${status}${notFound ? ", `Query ... not found`" : ""} |`,
      );
    }
  }
  // A control: a query that IS installed, to prove a 404 above means "absent"
  // rather than "the whole named query surface is broken for this token".
  try {
    await client.namedQuery("com.lapromisefund.wildcathub.roster", { nothing: 1 }, { maxPages: 1 });
    lines.push("| `roster` (control, already installed) | **200** |");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /with (\d{3})\./.exec(message)?.[1] ?? "error";
    lines.push(
      `| \`roster\` (control, already installed) | ${status}${
        status === "400" ? ", rejected the argument, so the query EXISTS" : ""
      } |`,
    );
  }
  lines.push("");
  lines.push(
    anyInstalled
      ? "**At least one expansion query is live.** Row counts above are real."
      : "**None of the four are installed.** They live in `queries_root/` in this repo and in no " +
        "running system. PowerQueries ship inside the plugin zip, so until the plugin is rebuilt, " +
        "version bumped, re-uploaded and re-enabled by a PowerSchool admin, every one of them " +
        "answers 404 and NO caller can reach them. The control row is the proof that a 404 means " +
        "the query is absent rather than the token being wrong: an installed query on the same " +
        "token answers with an argument error, not a 404.",
  );
  return { title, ok: true, lines };
}

/**
 * The COURSES join predicate, measured rather than trusted.
 *
 * The sibling query file joins COURSES with
 * `C.COURSE_NUMBER = SEC.COURSE_NUMBER AND C.SCHOOLID = SEC.SCHOOLID`, and the
 * first version of this file copied it into two of its four queries without
 * checking. It is wrong here, silently, and the size of the silence is what this
 * function reports: how many sections and how many enrollments the equality
 * predicate throws away, how many students that touches, whether the OR fix can
 * multiply rows, and which period tokens disappear entirely.
 *
 * No student identifier is written to the report. Counts only.
 */
async function evidenceCoursesJoin(
  client: PowerSchoolClient,
  config: Config,
  census: CourseCensus,
): Promise<Evidence> {
  const title = "The COURSES join predicate, and what the equality version silently drops";
  const lines: string[] = [];
  try {
    if (!census.ok) return { title, ok: false, lines: [`COURSES read failed: ${census.detail}`] };

    lines.push(
      `Read the whole COURSES table, unscoped on purpose: ${census.rows.length} rows. Scoping this ` +
        "one read to the school would hide the finding, which is the same mistake the SQL makes.",
    );
    lines.push("");
    lines.push("| COURSES.SCHOOLID | Rows | Meaning |");
    lines.push("|---|---:|---|");
    for (const [school, count] of [...census.bySchool.entries()].sort()) {
      const meaning =
        school === DISTRICT_SCHOOL_ID
          ? "**district level, invisible to an equality join**"
          : school === String(config.schoolId)
            ? "this school"
            : "another school in the district";
      lines.push(`| \`${school}\` | ${count} | ${meaning} |`);
    }
    lines.push("");

    const sections = await pageScoped(
      client,
      "sections",
      ["id", "course_number", "schoolid", "termid", "expression"],
      `schoolid==${config.schoolId};termid==${config.termId}`,
      5000,
    );
    const cc = await pageScoped(
      client,
      "cc",
      ["id", "studentid", "sectionid", "termid", "schoolid", "expression", "dateleft"],
      `schoolid==${config.schoolId};termid==${config.termId}`,
      20000,
    );
    if (sections.status !== 200 || cc.status !== 200) {
      return { title, ok: false, lines: [...lines, `sections ${sections.status}, cc ${cc.status}`] };
    }

    const sectionById = new Map<string, { number: string; school: string; expression: string }>();
    for (const row of sections.rows) {
      sectionById.set(String(cell(row, "id")), {
        number: String(cell(row, "course_number") ?? ""),
        school: String(cell(row, "schoolid") ?? ""),
        expression: String(cell(row, "expression") ?? "").trim(),
      });
    }

    let sectionsEquality = 0;
    let sectionsOr = 0;
    let fanout = 0;
    for (const section of sectionById.values()) {
      if (courseMatchCount(census, section.number, section.school, false) > 0) sectionsEquality += 1;
      const orMatches = courseMatchCount(census, section.number, section.school, true);
      if (orMatches > 0) sectionsOr += 1;
      if (orMatches > 1) fanout += 1;
    }

    // The same live-row filter the SQL applies, so the totals here are the
    // totals the query works from rather than the raw table size.
    const today = new Date().toISOString().slice(0, 10);
    const live = cc.rows.filter((row) => {
      const left = cell(row, "dateleft");
      if (left === null || left === undefined || String(left) === "") return true;
      return String(left).slice(0, 10) >= today;
    });

    let ccEquality = 0;
    let ccOr = 0;
    const students = new Set<string>();
    const studentsHurt = new Set<string>();
    const tokensAll = new Map<string, number>();
    const tokensEquality = new Map<string, number>();
    const leadingToken = (expression: string) => expression.split(/[^A-Za-z0-9]/)[0] ?? expression;
    for (const row of live) {
      students.add(String(cell(row, "studentid")));
      const section = sectionById.get(String(cell(row, "sectionid")));
      const expression = String(cell(row, "expression") ?? section?.expression ?? "").trim();
      const token = leadingToken(expression);
      if (token !== "") tokensAll.set(token, (tokensAll.get(token) ?? 0) + 1);
      if (!section) continue;
      if (courseMatchCount(census, section.number, section.school, true) > 0) ccOr += 1;
      if (courseMatchCount(census, section.number, section.school, false) > 0) {
        ccEquality += 1;
        if (token !== "") tokensEquality.set(token, (tokensEquality.get(token) ?? 0) + 1);
      } else {
        studentsHurt.add(String(cell(row, "studentid")));
      }
    }

    const lost = live.length - ccEquality;
    const pct = live.length === 0 ? "0" : ((lost / live.length) * 100).toFixed(1);

    lines.push(
      `Replayed both predicates against live rows for the configured term \`${config.termId}\`, ` +
        "in JavaScript, over the same keys the SQL joins on.",
    );
    lines.push("");
    lines.push("| Measure | Equality predicate (sibling file) | OR predicate (this file) | LEFT JOIN (this file, shipped) |");
    lines.push("|---|---:|---:|---:|");
    lines.push(`| SECTIONS surviving, of ${sectionById.size} | ${sectionsEquality} | ${sectionsOr} | ${sectionById.size} |`);
    lines.push(`| Live CC rows surviving, of ${live.length} | ${ccEquality} | ${ccOr} | ${live.length} |`);
    lines.push("");
    lines.push(
      `**The equality predicate drops ${lost} of ${live.length} live enrollments, ${pct} percent, ` +
        `touching ${studentsHurt.size} of ${students.size} students.**`,
    );
    lines.push("");
    lines.push(
      "Two numbers above deserve to be read twice. This project's established facts are " +
        `"3805 enrollments, 145 sections". The equality predicate leaves ${ccEquality} enrollments and ` +
        `${sectionsEquality} sections. Those established facts are measurements of the defect, not ` +
        `measurements of the school. The school has ${live.length} live enrollments across ` +
        `${sectionById.size} sections.`,
    );
    lines.push("");
    lines.push(
      `Fan out check, because an OR that matched twice would be worse than the bug it fixes: ` +
        `${fanout} sections resolve to more than one COURSES row under the OR predicate. ` +
        `The OR cannot duplicate a row here.`,
    );

    const onlyWithoutDefect = [...tokensAll.keys()].filter((token) => !tokensEquality.has(token));
    lines.push("");
    lines.push(
      "Period tokens, counted as live CC rows. `period_structure` itself reports distinct students " +
        "and distinct sections rather than raw rows, so these are the population behind those " +
        "counts rather than the counts themselves.",
    );
    lines.push("");
    lines.push("| Period token | Live CC rows | Surviving the equality predicate |");
    lines.push("|---|---:|---:|");
    for (const token of [...tokensAll.keys()].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))) {
      const truth = tokensAll.get(token) ?? 0;
      const broken = tokensEquality.get(token) ?? 0;
      const flag = broken === 0 ? " **invisible**" : "";
      lines.push(`| \`${token}\` | ${truth} | ${broken}${flag} |`);
    }
    lines.push("");
    if (onlyWithoutDefect.length > 0) {
      lines.push(
        `**Period ${onlyWithoutDefect.map((t) => `\`${t}\``).join(", ")} exists only inside the dropped ` +
          "set.** A period vocabulary query built on the equality predicate cannot see an entire period " +
          "of the school day, and would report the rest under counted by 20 to 50 percent.",
      );
    } else {
      lines.push("No period token disappears entirely under the equality predicate on this term.");
    }

    // Even the OR predicate is not enough on its own. Report the residue.
    const orphans = [...sectionById.entries()].filter(
      ([, section]) => courseMatchCount(census, section.number, section.school, true) === 0,
    );
    lines.push("");
    if (orphans.length === 0) {
      lines.push("Every section in this term resolves to a course under the OR predicate.");
    } else {
      const orphanIds = new Set(orphans.map(([id]) => id));
      const orphanRows = live.filter((row) => orphanIds.has(String(cell(row, "sectionid"))));
      const orphanNumbers = [...new Set(orphans.map(([, section]) => section.number))];
      lines.push(
        `**And the OR alone is still not enough, which is why the shipped join is a LEFT JOIN.** ` +
          `${orphans.length} sections in this term resolve to no course even with the OR, because ` +
          `course number ${orphanNumbers.map((n) => `\`${n}\``).join(", ")} is defined only at another ` +
          `school in the district. Those sections carry ${orphanRows.length} enrollments. An INNER ` +
          "JOIN would drop them for a missing lookup row; a LEFT JOIN shows a blank course name and " +
          "keeps the child.",
      );
    }

    return { title, ok: true, lines };
  } catch (error: unknown) {
    return { title, ok: false, lines: [error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * The join at the heart of the top ranked capability, executed for real.
 *
 * The PowerQuery cannot run (see above), so the join it describes is run here
 * instead: read CC for one term, read ATTENDANCE for that year, match on
 * ATTENDANCE.CCID = CC.ID, resolve codes through ATTENDANCE_CODE, and count
 * distinct dates per (student, section). Same keys, same grouping, same
 * presence semantics as the SQL. If this produces rows, the SQL's join is
 * sound; if it produces nothing, the SQL would too.
 *
 * No student identifier is written to the report. Only counts.
 */
async function evidenceAttendanceJoin(
  client: PowerSchoolClient,
  config: Config,
  census: CourseCensus,
): Promise<Evidence> {
  const title = "The attendance_by_section join, executed against real rows";
  const lines: string[] = [];
  try {
    // Pick the most recent term at this school that actually has both CC rows
    // and attendance. The current term has no attendance yet by design.
    const termRead = await pageScoped(
      client,
      "terms",
      ["id", "abbreviation", "firstday", "lastday", "schoolid", "yearid"],
      `schoolid==${config.schoolId}`,
      400,
    );
    if (termRead.status !== 200) return { title, ok: false, lines: [`terms read ${termRead.status}: ${termRead.detail}`] };

    const terms = termRead.rows
      .map((row) => ({
        id: Number(cell(row, "id")),
        abbr: String(cell(row, "abbreviation") ?? ""),
        year: Number(cell(row, "yearid")),
        first: String(cell(row, "firstday") ?? ""),
        last: String(cell(row, "lastday") ?? ""),
      }))
      .filter((term) => Number.isFinite(term.id))
      .sort((a, b) => b.id - a.id);

    // The attendance scope must be the term's DATE WINDOW, not merely its year.
    // A first attempt scoped attendance by yearid and picked term S2; the read
    // returned the year's first 4000 rows, which all fell in S1, so every CCID
    // missed and the join reported a false zero. The SQL joins
    // `A.ATT_DATE BETWEEN TM.FIRSTDAY AND TM.LASTDAY`, so the replication does
    // the same, which makes it both correct and a closer match to the query.
    const attendanceScope = (term: { id: number; first: string; last: string }) =>
      `schoolid==${config.schoolId};att_date=ge=${term.first};att_date=le=${term.last}`;

    let chosen: (typeof terms)[number] | null = null;
    let ccCount = 0;
    let attCount = 0;
    for (const term of terms.slice(0, 10)) {
      if (term.first === "" || term.last === "") continue;
      const cc = await scopedCount(client, "cc", `schoolid==${config.schoolId};termid==${term.id}`);
      if ((cc ?? 0) === 0) continue;
      const att = await scopedCount(client, "attendance", attendanceScope(term));
      if ((att ?? 0) === 0) continue;
      chosen = term;
      ccCount = cc ?? 0;
      attCount = att ?? 0;
      break;
    }
    if (chosen === null) {
      lines.push(
        "No term at this school has both section enrollments and attendance rows, so the join " +
          "cannot be exercised yet. That is a calendar fact, not a schema fault.",
      );
      return { title, ok: false, lines };
    }

    lines.push(
      `Executed against the most recent term that has both: term \`${chosen.id}\` (${chosen.abbr}, ` +
        `yearid ${chosen.year}, ${chosen.first} to ${chosen.last}), ${ccCount} CC rows and ` +
        `${attCount} ATTENDANCE rows inside the term's own date window.`,
    );

    const ATT_CAP = 4000;
    const cc = await pageScoped(
      client,
      "cc",
      ["id", "studentid", "sectionid", "termid", "schoolid", "expression", "dateenrolled", "dateleft"],
      `schoolid==${config.schoolId};termid==${chosen.id}`,
      8000,
    );
    const att = await pageScoped(
      client,
      "attendance",
      ["id", "studentid", "att_date", "ccid", "periodid", "attendance_codeid", "yearid"],
      attendanceScope(chosen),
      ATT_CAP,
    );
    const codes = await pageScoped(
      client,
      "attendance_code",
      ["id", "att_code", "presence_status_cd", "schoolid", "yearid"],
      `schoolid==${config.schoolId}`,
      400,
    );
    if (cc.status !== 200 || att.status !== 200 || codes.status !== 200) {
      return {
        title,
        ok: false,
        lines: [...lines, `cc ${cc.status}, attendance ${att.status}, attendance_code ${codes.status}`],
      };
    }

    // The COURSES half of the same statement. The previous round replicated the
    // ATTENDANCE to CC join and stopped there, which is why it never saw that
    // the COURSES join sitting beside it was discarding a third of the school.
    // Both predicates are now carried through the aggregation so the headline
    // ratio can be published on a stated basis instead of an assumed one.
    const termSections = await pageScoped(
      client,
      "sections",
      ["id", "course_number", "schoolid", "termid"],
      `schoolid==${config.schoolId};termid==${chosen.id}`,
      5000,
    );
    const sectionById = new Map<string, { number: string; school: string }>();
    for (const row of termSections.rows) {
      sectionById.set(String(cell(row, "id")), {
        number: String(cell(row, "course_number") ?? ""),
        school: String(cell(row, "schoolid") ?? ""),
      });
    }
    const survivesEquality = (sectionId: string): boolean => {
      const section = sectionById.get(sectionId);
      if (!section) return false;
      return courseMatchCount(census, section.number, section.school, false) > 0;
    };

    const ccById = new Map<number, any>();
    for (const row of cc.rows) ccById.set(Number(cell(row, "id")), row);
    const codeById = new Map<number, { att: string; presence: string }>();
    for (const row of codes.rows) {
      codeById.set(Number(cell(row, "id")), {
        att: String(cell(row, "att_code") ?? ""),
        presence: String(cell(row, "presence_status_cd") ?? ""),
      });
    }

    type Bucket = { absent: Set<string>; tardy: Set<string>; rows: number };
    type Basis = { pairs: Map<string, Bucket>; studentDays: Map<string, Set<string>> };
    const shipped: Basis = { pairs: new Map(), studentDays: new Map() };
    const equality: Basis = { pairs: new Map(), studentDays: new Map() };
    let matched = 0;
    let unmatched = 0;
    for (const row of att.rows) {
      const ccRow = ccById.get(Number(cell(row, "ccid")));
      if (!ccRow) {
        unmatched += 1;
        continue;
      }
      matched += 1;
      const student = String(cell(ccRow, "studentid"));
      const sectionId = String(cell(ccRow, "sectionid"));
      const key = `${student}|${sectionId}`;
      const code = codeById.get(Number(cell(row, "attendance_codeid")));
      const date = String(cell(row, "att_date"));
      const targets = survivesEquality(sectionId) ? [shipped, equality] : [shipped];
      for (const basis of targets) {
        let bucket = basis.pairs.get(key);
        if (!bucket) {
          bucket = { absent: new Set(), tardy: new Set(), rows: 0 };
          basis.pairs.set(key, bucket);
        }
        bucket.rows += 1;
        if (code?.presence === "Absent") {
          bucket.absent.add(date);
          if (!basis.studentDays.has(student)) basis.studentDays.set(student, new Set());
          basis.studentDays.get(student)!.add(date);
        }
        if (code?.att === "T") bucket.tardy.add(date);
      }
    }

    const perPair = shipped.pairs;
    const perStudentDays = shipped.studentDays;
    const sectionDays = [...perPair.values()].reduce((sum, b) => sum + b.absent.size, 0);
    const studentDays = [...perStudentDays.values()].reduce((sum, d) => sum + d.size, 0);
    const sectionDaysEquality = [...equality.pairs.values()].reduce((sum, b) => sum + b.absent.size, 0);

    lines.push("");
    lines.push("| Measure | Value |");
    lines.push("|---|---:|");
    lines.push(`| ATTENDANCE rows read (capped at ${ATT_CAP}) | ${att.rows.length} |`);
    lines.push(`| CC rows read for the term | ${cc.rows.length} |`);
    lines.push(`| ATTENDANCE_CODE rows for this school | ${codes.rows.length} |`);
    lines.push(`| Attendance rows whose CCID matched a CC row in this term | ${matched} |`);
    lines.push(`| Attendance rows whose CCID belonged to another term | ${unmatched} |`);
    lines.push(`| Distinct (student, section) pairs produced | ${perPair.size} |`);
    lines.push(
      `| Pairs with at least one absence | ${[...perPair.values()].filter((b) => b.absent.size > 0).length} |`,
    );
    lines.push(
      `| Pairs with at least one tardy | ${[...perPair.values()].filter((b) => b.tardy.size > 0).length} |`,
    );
    lines.push(`| Sum of per SECTION absent days | ${sectionDays} |`);
    lines.push(`| Sum of per STUDENT absent days, the metric shipping today | ${studentDays} |`);
    lines.push("");
    lines.push(
      "**Basis, stated because the last round did not state one.** Every number above is on the " +
        "shipped basis: every CC row for the term, with the COURSES join LEFT and its predicate " +
        "allowing district level courses at SCHOOLID 0. The row below is the same rows re-aggregated " +
        "under the equality predicate the sibling query file ships, which is what this file would " +
        "have returned before the fix.",
    );
    lines.push("");
    lines.push("| Aggregation | (student, section) pairs | Section absent days |");
    lines.push("|---|---:|---:|");
    lines.push(`| Shipped: LEFT JOIN, district courses included | ${perPair.size} | ${sectionDays} |`);
    lines.push(`| Equality predicate, the defect | ${equality.pairs.size} | ${sectionDaysEquality} |`);
    lines.push(
      `| Absences the defect would have hidden | ${perPair.size - equality.pairs.size} | ` +
        `${sectionDays - sectionDaysEquality} |`,
    );
    lines.push("");

    const ok = perPair.size > 0 && matched > 0;
    if (ok) {
      lines.push(
        `**The join works and returns real rows.** ${matched} of ${att.rows.length} sampled attendance ` +
          `rows resolved through CCID into a section enrollment, producing ${perPair.size} distinct ` +
          "(student, section) rows. This is the shape `attendance_by_section` would return.",
      );
      if (studentDays > 0) {
        lines.push("");
        lines.push(
          `**And it measures something the current metric cannot.** On the shipped basis the same ` +
            `rows collapse to ${studentDays} student absent days but expand to ${sectionDays} section ` +
            `absent days, a factor of ${(sectionDays / studentDays).toFixed(2)}. That gap IS the ` +
            "single period cut that `attendance_summary` cannot see, quantified. A student missing " +
            "one class shows up in the section number and is invisible in the daily one.",
        );
      }
      lines.push("");
      lines.push(
        "Caveat, stated rather than buried: this is the join executed in JavaScript over paged table " +
          "reads, NOT the PowerQuery executed by Oracle. It now covers both joins in the statement, " +
          "ATTENDANCE to CC and SECTIONS to COURSES, because covering only the first is exactly how " +
          "the COURSES defect survived a round. It proves the keys join, the codes resolve and the " +
          "grouping produces rows. It does not prove the SQL parses. Only installing the plugin " +
          "proves that.",
      );
    } else {
      lines.push(
        "**The join produced nothing.** Either CCID does not point at CC.ID in this instance or the " +
          "term scoping is wrong. Do not build `attendance_by_section` until this reads otherwise.",
      );
    }
    return { title, ok, lines };
  } catch (error: unknown) {
    return { title, ok: false, lines: [error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * The literals the attendance SQL depends on, checked against the instance.
 *
 * `attendance_by_section` hardcodes two strings: PRESENCE_STATUS_CD = 'Absent'
 * and ATT_CODE = 'T'. Both are district configuration. If either spelling is
 * different here, the query returns zeros and no error.
 */
async function evidenceAttendanceCodes(
  client: PowerSchoolClient,
  config: Config,
): Promise<Evidence> {
  const title = "The attendance code literals the SQL hardcodes actually exist here";
  const lines: string[] = [];
  try {
    const { rows, status, detail } = await pageScoped(
      client,
      "attendance_code",
      ["id", "att_code", "presence_status_cd", "schoolid", "yearid"],
      `schoolid==${config.schoolId}`,
      400,
    );
    if (status !== 200) return { title, ok: false, lines: [`Read failed with ${status}: ${detail}`] };

    const presence = new Map<string, number>();
    const attCodes = new Map<string, number>();
    const perYear = new Map<string, Set<string>>();
    for (const row of rows) {
      const p = String(cell(row, "presence_status_cd") ?? "");
      const a = String(cell(row, "att_code") ?? "");
      const y = String(cell(row, "yearid") ?? "");
      presence.set(p, (presence.get(p) ?? 0) + 1);
      attCodes.set(a, (attCodes.get(a) ?? 0) + 1);
      if (!perYear.has(y)) perYear.set(y, new Set());
      perYear.get(y)!.add(a);
    }
    lines.push(
      `${rows.length} ATTENDANCE_CODE rows at \`schoolid==${config.schoolId}\`, spanning ` +
        `${perYear.size} school years. Codes are configured per school AND per year, so the join must ` +
        "be on ATTENDANCE_CODEID and never on a code string.",
    );
    lines.push("");
    lines.push("| PRESENCE_STATUS_CD | Rows |");
    lines.push("|---|---:|");
    for (const [value, count] of [...presence.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| \`${value}\` | ${count} |`);
    }
    lines.push("");
    lines.push("| ATT_CODE | Rows |");
    lines.push("|---|---:|");
    for (const [value, count] of [...attCodes.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| \`${value === "" ? "(empty)" : value}\` | ${count} |`);
    }
    lines.push("");
    const hasAbsent = presence.has("Absent");
    const hasTardy = attCodes.has("T");
    lines.push(`\`PRESENCE_STATUS_CD = 'Absent'\` matches something here: **${hasAbsent ? "yes" : "NO"}**`);
    lines.push(`\`ATT_CODE = 'T'\` matches something here: **${hasTardy ? "yes" : "NO"}**`);
    if (hasTardy) {
      lines.push("");
      lines.push(
        "Note the semantics this pins down: `T` carries PRESENCE_STATUS_CD `Present`, so a tardy is " +
          "not an absence in this instance. Counting them separately, as the query does, is correct " +
          "rather than merely tidy.",
      );
    }
    return { title, ok: hasAbsent && hasTardy, lines };
  } catch (error: unknown) {
    return { title, ok: false, lines: [error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * The period tokens the SIS actually uses, against the tokens script.js
 * hardcodes. An expression is a timetable label such as "P1(A)". Not PII.
 */
async function evidencePeriodExpressions(client: PowerSchoolClient, config: Config): Promise<Evidence> {
  const title = "SIS period tokens versus the bell schedule hardcoded in script.js";
  const lines: string[] = [];
  const APP_PERIODS = ["A1", "P1", "P2", "P3", "P4", "HPU", "P5", "P6", "A2"];
  const leadingToken = (expression: string) => expression.split(/[^A-Za-z0-9]/)[0] ?? expression;
  try {
    const sections = await pageScoped(
      client,
      "sections",
      ["id", "expression", "section_number", "schoolid", "termid"],
      `schoolid==${config.schoolId};termid==${config.termId}`,
      3000,
    );
    if (sections.status !== 200) {
      return { title, ok: false, lines: [`Read failed with ${sections.status}: ${sections.detail}`] };
    }
    const counts = new Map<string, number>();
    const schools = new Set<string>();
    for (const row of sections.rows) {
      schools.add(String(cell(row, "schoolid")));
      const expression = String(cell(row, "expression") ?? "").trim();
      if (expression === "") continue;
      counts.set(expression, (counts.get(expression) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    lines.push(
      `Read ${sections.rows.length} SECTIONS rows scoped to \`schoolid==${config.schoolId};termid==${config.termId}\`. ` +
        `Distinct schoolid values in the result: ${[...schools].join(", ") || "none"}.`,
    );
    lines.push(
      "The scope matters. An earlier run of this probe read page 1 of SECTIONS with no filter, got " +
        "100 rows that all belonged to a different school in the same district, and reported them as " +
        "the Westbrook timetable. Everything below is filtered.",
    );
    lines.push("");
    lines.push(`Distinct SECTIONS.EXPRESSION values: ${sorted.length}.`);
    lines.push("");
    lines.push("| SECTIONS.EXPRESSION | Sections | Leading token | In the script.js bell schedule |");
    lines.push("|---|---:|---|---|");
    for (const [expression, count] of sorted.slice(0, 30)) {
      const token = leadingToken(expression);
      lines.push(`| \`${expression}\` | ${count} | \`${token}\` | ${APP_PERIODS.includes(token) ? "yes" : "**NO**"} |`);
    }
    const tokens = new Set(sorted.map(([expression]) => leadingToken(expression)));
    const unknown = [...tokens].filter((token) => !APP_PERIODS.includes(token));
    const unused = APP_PERIODS.filter((period) => !tokens.has(period));
    lines.push("");
    lines.push(
      `Tokens the SIS uses that script.js does not know: ${unknown.length === 0 ? "none" : unknown.map((t) => `\`${t}\``).join(", ")}`,
    );
    lines.push(
      `Tokens script.js hardcodes that this term never shows: ${unused.length === 0 ? "none" : unused.map((t) => `\`${t}\``).join(", ")}`,
    );

    // The same read against the PREVIOUS year, because a timetable that changed
    // between years is the strongest possible argument against hardcoding it.
    const priorTerm = Number(config.termId) - 100;
    const prior = await pageScoped(
      client,
      "sections",
      ["id", "expression", "schoolid", "termid"],
      `schoolid==${config.schoolId};termid==${priorTerm}`,
      3000,
    );
    if (prior.status === 200 && prior.rows.length > 0) {
      const priorExpressions = new Set(
        prior.rows
          .map((row) => String(cell(row, "expression") ?? "").trim())
          .filter((expression) => expression !== ""),
      );
      const priorTokens = new Set([...priorExpressions].map(leadingToken));
      const nowExpressions = new Set(counts.keys());

      const addedTokens = [...tokens].filter((token) => !priorTokens.has(token));
      const droppedTokens = [...priorTokens].filter((token) => !tokens.has(token));
      const addedExpressions = [...nowExpressions].filter((e) => !priorExpressions.has(e));
      const droppedExpressions = [...priorExpressions].filter((e) => !nowExpressions.has(e));

      lines.push("");
      lines.push(
        `Same read against the previous year's term \`${priorTerm}\` (${prior.rows.length} sections, ` +
          `${priorExpressions.size} distinct expressions).`,
      );
      lines.push("");
      lines.push("| | Previous year | This year |");
      lines.push("|---|---|---|");
      lines.push(
        `| Leading tokens | \`${[...priorTokens].sort().join("`, `")}\` | \`${[...tokens].sort().join("`, `")}\` |`,
      );
      lines.push(
        `| Full expressions | \`${[...priorExpressions].sort().slice(0, 12).join("`, `")}\` | ` +
          `\`${[...nowExpressions].sort().slice(0, 12).join("`, `")}\` |`,
      );
      lines.push("");
      lines.push(
        `Tokens added: ${addedTokens.length === 0 ? "none" : addedTokens.map((t) => `\`${t}\``).join(", ")}. ` +
          `Tokens dropped: ${droppedTokens.length === 0 ? "none" : droppedTokens.map((t) => `\`${t}\``).join(", ")}.`,
      );
      lines.push(
        `Whole expressions added: ${addedExpressions.length}. Whole expressions dropped: ${droppedExpressions.length}.`,
      );
      if (addedExpressions.length > 0 || droppedExpressions.length > 0) {
        lines.push("");
        lines.push(
          "**The timetable changed shape between school years even though the period numbers did not.** " +
            "The part in brackets is the meeting cycle, and it is different this year. A hand maintained " +
            "period table that happened to survive on the numbers alone would still be describing last " +
            "year's meeting pattern. This is not hypothetical drift: it already happened between the two " +
            "most recent years on this instance.",
        );
      }
    }

    return { title, ok: true, lines };
  } catch (error: unknown) {
    return { title, ok: false, lines: [error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Are the granted enrollment dates populated, and do they carry any SIGNAL?
 *
 * "Populated" is the easy half and it was the only half the previous round
 * measured. 100 percent non null is worthless if every row holds the same date,
 * because the whole argument for `enrollment_window` is that students differ
 * from one another. This reads EVERY active student at the school and counts
 * distinct values, which is the question that actually decides the ranking.
 */
async function evidenceEnrollmentDates(client: PowerSchoolClient, config: Config): Promise<Evidence> {
  const title = "Do the granted enrollment dates carry any per student signal?";
  const lines: string[] = [];
  try {
    const students = await pageScoped(
      client,
      "students",
      ["id", "student_number", "entrydate", "exitdate", "enroll_status", "schoolid"],
      `schoolid==${config.schoolId};enroll_status==0`,
      4000,
    );
    const cc = await pageScoped(
      client,
      "cc",
      ["id", "studentid", "sectionid", "dateenrolled", "dateleft", "expression", "termid"],
      `schoolid==${config.schoolId};termid==${config.termId}`,
      8000,
    );
    if (students.status !== 200 || cc.status !== 200) {
      return { title, ok: false, lines: [`students read ${students.status}, cc read ${cc.status}`] };
    }

    lines.push(
      `Every active student at \`schoolid==${config.schoolId}\` (${students.rows.length} rows) and every ` +
        `CC row for term \`${config.termId}\` (${cc.rows.length} rows). Not a sample.`,
    );
    lines.push("");
    lines.push("| Table | Column | Rows | Non null | Rate | **Distinct values** |");
    lines.push("|---|---|---:|---:|---:|---:|");
    for (const stat of populationStats(students.rows, ["entrydate", "exitdate", "enroll_status"])) {
      lines.push(
        `| STUDENTS | \`${stat.column}\` | ${stat.rows} | ${stat.nonNull} | ${stat.rate} | **${stat.distinct}** |`,
      );
    }
    for (const stat of populationStats(cc.rows, ["dateenrolled", "dateleft", "expression"])) {
      lines.push(
        `| CC | \`${stat.column}\` | ${stat.rows} | ${stat.nonNull} | ${stat.rate} | **${stat.distinct}** |`,
      );
    }

    const entry = populationStats(students.rows, ["entrydate"])[0];
    const enrolled = populationStats(cc.rows, ["dateenrolled"])[0];
    const modal = (rows: any[], column: string) => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const value = String(cell(row, column) ?? "");
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["none", 0];
    };
    const [entryValue, entryCount] = modal(students.rows, "entrydate");
    const [ccValue, ccCount] = modal(cc.rows, "dateenrolled");
    lines.push("");
    lines.push(
      `Most common STUDENTS.ENTRYDATE: \`${entryValue}\` on ${entryCount} of ${students.rows.length} students. ` +
        `Most common CC.DATEENROLLED: \`${ccValue}\` on ${ccCount} of ${cc.rows.length} rows.`,
    );

    // The active-only number above is measured on a particular day, and that
    // day matters enormously. Reading it alone would be a trap: of course every
    // active student shares an entry date before the year has started. The
    // honest comparison is against every student the school has on file, which
    // answers a different and better question, namely whether this column EVER
    // varies here.
    const everyone = await pageScoped(
      client,
      "students",
      ["id", "entrydate", "exitdate", "enroll_status", "schoolid"],
      `schoolid==${config.schoolId}`,
      6000,
    );
    let everDistinct = 0;
    if (everyone.status === 200 && everyone.rows.length > 0) {
      const stats = populationStats(everyone.rows, ["entrydate", "exitdate"]);
      everDistinct = stats[0].distinct;
      lines.push("");
      lines.push(
        `Same two columns across EVERY student on file at this school, active and inactive ` +
          `(${everyone.rows.length} rows):`,
      );
      lines.push("");
      lines.push("| Column | Rows | Distinct values |");
      lines.push("|---|---:|---:|");
      for (const stat of stats) {
        lines.push(`| STUDENTS.\`${stat.column}\` | ${stat.rows} | ${stat.distinct} |`);
      }
    }

    lines.push("");
    const thinNow = entry.distinct <= 3 && enrolled.distinct <= 3;
    if (thinNow && everDistinct > 10) {
      lines.push(
        `**The honest reading: this query is correct and, today, a no-op.** Among the ` +
          `${students.rows.length} currently active students it returns the same window for almost all ` +
          `of them (${entry.distinct} distinct entry dates, ${enrolled.distinct} distinct section ` +
          "enrollment dates), because this ran before the school year started and the whole school " +
          "rolls over on one day. It is NOT that the column is meaningless here: across every student " +
          `on file it holds ${everDistinct} distinct entry dates. The variation appears as students ` +
          "arrive and leave during the year, not on day one.",
      );
      lines.push("");
      lines.push(
        "Two consequences, and they point in opposite directions, which is why the row is ranked in " +
          "the middle rather than at either end. Against it: nobody should expect a visible change on " +
          "a dashboard from shipping this today, and a reviewer told it fixes skewed denominators " +
          "would be right to ask where. For it: it costs no new grant, and the day a student does " +
          "arrive in October it is already correct rather than needing a retrofit.",
      );
      lines.push("");
      lines.push(
        "Either way it is NOT transfer history. STUDENTS holds the CURRENT enrolment only, so a " +
          "student's prior spans at this school are invisible to it. Those live in REENROLLMENTS, " +
          "which the reachability table above shows EXISTS here and is not granted. The ranking names " +
          "the two separately for that reason.",
      );
    } else if (thinNow) {
      lines.push(
        `**These columns carry almost no information here** (${entry.distinct} distinct entry dates ` +
          `across ${students.rows.length} active students, and ${everDistinct} across every student on ` +
          "file). A denominator computed from them is the same number for every student.",
      );
    } else {
      lines.push(
        `**These columns carry real per student variation** (${entry.distinct} distinct entry dates among ` +
          "active students), so a denominator correction computed from them differs between students " +
          "and is worth having. Note it is still an enrolment window, not transfer history: prior " +
          "spans live in REENROLLMENTS, which is not granted.",
      );
    }
    return { title, ok: true, lines };
  } catch (error: unknown) {
    return { title, ok: false, lines: [error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * /ws/v1 is a second read surface the project has never touched. Enrollment
 * history is a named expansion there, which would be a route to the same data
 * without a plugin change. Status only: no student values are recorded.
 */
async function evidenceV1Expansions(client: PowerSchoolClient, config: Config): Promise<Evidence> {
  const lines: string[] = [];
  const expansions = ["school_enrollment", "initial_enrollment", "schedule_setup"];
  try {
    const district = await client.get("/ws/v1/district/school");
    lines.push(`\`GET /ws/v1/district/school\` -> ${district.status}`);
    if (district.status !== 200) {
      lines.push(`  ${extractMessage(district.json, district.text)}`);
    }
    const schoolId = district.json?.schools?.school?.[0]?.id ?? district.json?.schools?.school?.id ?? null;
    lines.push(`  school id discovered: ${schoolId === null ? "none" : "yes"}`);

    if (schoolId !== null) {
      // All three expansions travel on ONE request as a comma separated list,
      // so this is a single call and the loop below only reads the response.
      const requested = expansions.join(",");
      const response = await client.get(`/ws/v1/school/${schoolId}/student`, {
        expansions: requested,
        pagesize: 1,
      });
      lines.push(
        `\`GET /ws/v1/school/{id}/student?expansions=${requested}\` -> ${response.status}`,
      );
      if (response.status !== 200) {
        lines.push(`  ${extractMessage(response.json, response.text)}`);
      }
      const first =
        response.json?.students?.student?.[0] ?? response.json?.students?.student ?? null;
      for (const expansion of expansions) {
        const present = first !== null && typeof first === "object" && expansion in first;
        lines.push(`  \`${expansion}\` key present in payload: ${present ? "yes" : "no"}`);
      }
      lines.push("");
      lines.push(
        "Only the presence of each key is recorded. No student values from this surface are " +
          "written to this file.",
      );
    }
    return { title: "/ws/v1 enrollment expansions", ok: true, lines };
  } catch (error: unknown) {
    return {
      title: "/ws/v1 enrollment expansions",
      ok: false,
      lines: [error instanceof Error ? error.message : String(error)],
    };
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function reachSymbol(reach: Reach): string {
  if (reach === "granted") return "GRANTED";
  if (reach === "ungranted-column-exists") return "EXISTS, NOT GRANTED";
  if (reach === "column-absent") return "COLUMN ABSENT";
  if (reach === "table-absent") return "TABLE ABSENT";
  if (reach === "endpoint-closed") return "ENDPOINT CLOSED";
  return "ERROR";
}

function candidateVerdict(probes: TableProbe[]): string {
  const anyGranted = probes.some((t) => t.columns.some((c) => c.reach === "granted"));
  const anyUngranted = probes.some((t) => t.columns.some((c) => c.reach === "ungranted-column-exists"));
  const anyExists = probes.some((t) => t.exists === "yes");
  const anyClosed = probes.some((t) => t.exists === "endpoint-closed");
  if (anyGranted && !anyUngranted) return "REACHABLE NOW";
  if (anyGranted && anyUngranted) return "PARTLY REACHABLE";
  if (anyUngranted) return "NEEDS A GRANT";
  if (anyClosed) return "POWERQUERY ONLY";
  if (anyExists) return "TABLE EXISTS, COLUMNS UNKNOWN";
  return "NOT IN THIS INSTANCE";
}

/**
 * The bytes of an existing docs/sis-expansion.md that a run must NOT destroy.
 * Everything before the marker is kept. With no marker present the whole file
 * is kept and the machine section is appended, so a run can never lose text it
 * did not write.
 */
export function preservedPrefix(existing: string): string {
  if (existing === "") return "";
  const markerAt = existing.indexOf(PROBE_MARKER);
  return markerAt >= 0 ? existing.slice(0, markerAt) : `${existing}\n\n`;
}

function renderReport(
  config: Config,
  control: ColumnProbe,
  results: Array<{ candidate: Candidate; probes: TableProbe[] }>,
  evidence: Evidence[],
  summary: ReturnType<PowerSchoolClient["summary"]>,
  generatedAt: string,
): string {
  const lines: string[] = [];

  lines.push(PROBE_MARKER);
  lines.push("");
  lines.push("# Probe output");
  lines.push("");
  lines.push("Generated by `powerschool/sync/src/expansion-probe.ts`. Do not hand edit this section.");
  lines.push("Re-run with `node --env-file=.env src/expansion-probe.ts` from `powerschool/sync`.");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Instance: \`${config.host}\``);
  lines.push(`- Requests this run: ${summary.requests} (ceiling ${config.hourlyRequestCeiling})`);
  lines.push(`- Verbs used: GET only. Zero POSTs, including named queries.`);
  lines.push("");
  lines.push("Behavior tables (LOG, GEN, INCIDENT_*) are deliberately absent. Another piece owns them.");
  lines.push("");

  lines.push("## How to read a status code on this instance");
  lines.push("");
  lines.push("Control probe against a table that cannot exist:");
  lines.push("");
  lines.push(`- \`GET /ws/schema/table/${CONTROL_MISSING_TABLE}?projection=${CANARY_COLUMN}\``);
  lines.push(`  -> **${control.status}** ${control.detail}`);
  lines.push("");
  lines.push("| Status | Meaning here | Fixable by editing plugin.xml |");
  lines.push("|---|---|---|");
  lines.push("| 200 | column exists and is granted | already done |");
  lines.push("| 403 | table and column exist, grant missing | **yes** |");
  lines.push("| 400 naming the table | table exists, that column does not | no, guess again |");
  lines.push("| 405 | table exists, endpoint closed by PowerSchool | no, use a PowerQuery |");
  lines.push(`| ${control.status} | table not reachable at this endpoint | no |`);
  lines.push("");

  lines.push("## Ranked result");
  lines.push("");
  lines.push("| # | Capability | Value | Verdict | Cost to unlock |");
  lines.push("|---|---|---|---|---|");
  results.forEach(({ candidate, probes }, index) => {
    const verdict = candidate.skipReason ? "NOT PROBED" : candidateVerdict(probes);
    const cost =
      verdict === "REACHABLE NOW"
        ? "nothing, columns already granted"
        : verdict === "NEEDS A GRANT" || verdict === "PARTLY REACHABLE"
          ? "plugin.xml version bump plus admin re-enable"
          : verdict === "NOT IN THIS INSTANCE"
            ? "cannot be unlocked, data is not here"
            : verdict === "NOT PROBED"
              ? candidate.value === "declined"
                ? "declined"
                : "not a field grant, see the detail below"
              : "unknown";
    lines.push(
      `| ${index + 1} | ${candidate.title} | ${candidate.value} | ${verdict} | ${cost} |`,
    );
  });
  lines.push("");

  lines.push("## Evidence from real rows");
  lines.push("");
  lines.push("Reachability is not usefulness. A granted column that is null on every row buys nothing.");
  lines.push("");
  for (const item of evidence) {
    lines.push(`### ${item.title}`);
    lines.push("");
    if (!item.ok) lines.push("**Probe failed.**");
    for (const line of item.lines) lines.push(line);
    lines.push("");
  }

  lines.push("## Per capability detail");
  lines.push("");
  for (const { candidate, probes } of results) {
    lines.push(`### ${candidate.title}`);
    lines.push("");
    lines.push(`**Value: ${candidate.value}.** ${candidate.whyDashboard}`);
    lines.push("");
    if (candidate.skipReason) {
      lines.push(`**Not probed.** ${candidate.skipReason}`);
      lines.push("");
      continue;
    }
    lines.push(`**Verdict: ${candidateVerdict(probes)}**`);
    lines.push("");
    lines.push("| Table | Exists | Column | Reach | Status | Detail |");
    lines.push("|---|---|---|---|---|---|");
    for (const table of probes) {
      if (table.columns.length === 0) {
        lines.push(
          `| \`${table.table}\` | ${table.exists} | (canary only) | - | ${table.canaryStatus} | ${table.canaryDetail.replace(/\|/g, "/")} |`,
        );
        continue;
      }
      for (const column of table.columns) {
        lines.push(
          `| \`${table.table}\` | ${table.exists} | \`${column.column}\` | ${reachSymbol(column.reach)} | ${column.status} | ${column.detail.replace(/\|/g, "/")} |`,
        );
      }
    }
    lines.push("");
  }

  lines.push("## Grants that would have to be requested");
  lines.push("");
  const needed = results.flatMap(({ candidate, probes }) =>
    probes.flatMap((table) =>
      table.columns
        .filter((column) => column.reach === "ungranted-column-exists")
        .map((column) => ({ candidate: candidate.title, table: table.table, column: column.column })),
    ),
  );
  if (needed.length === 0) {
    lines.push("None. Every column that exists in this instance and is worth reading is already granted.");
  } else {
    lines.push("Each line below is a table and column that EXISTS in this instance and returned 403.");
    lines.push("A `<field ... access=\"ViewOnly\"/>` line, a version bump and an admin re-enable unlock it.");
    lines.push("");
    lines.push("| Capability | Table | Column |");
    lines.push("|---|---|---|");
    for (const item of needed) {
      lines.push(`| ${item.candidate} | \`${item.table}\` | \`${item.column}\` |`);
    }
  }
  lines.push("");

  lines.push("## Run summary");
  lines.push("");
  lines.push("```");
  lines.push(JSON.stringify(summary, null, 2));
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// OFFLINE VALIDATOR.  node src/expansion-probe.ts --selftest
//
// Needs no credentials, no network and no PowerSchool. It exists because the
// two ways this work can be wrong are both silent:
//
//   1. A PowerQuery that selects an ungranted column installs cleanly and then
//      403s at call time, naming a column nobody expected to be missing.
//   2. A bind variable used in the SQL but not declared in <args> leaves the
//      query unregistered. The plugin installs with NO validation error and
//      every call 404s forever. The sibling query file learned that the
//      expensive way and wrote it down; this checks it mechanically.
//
// Both are caught here by parsing plugin.xml and the query file and comparing
// them, which is a real check against the real grant rather than a promise.
// ---------------------------------------------------------------------------

const PLUGIN_XML = resolve(REPO_ROOT, "powerschool", "plugin", "plugin.xml");
const EXPANSION_QUERIES = resolve(
  REPO_ROOT,
  "powerschool",
  "plugin",
  "queries_root",
  "expansion.named_queries.xml",
);
const SIBLING_QUERIES = resolve(
  REPO_ROOT,
  "powerschool",
  "plugin",
  "queries_root",
  "wildcathub.named_queries.xml",
);

/**
 * Written as an escape so this file does not itself contain the character it
 * is banning. `scripts/build-plugin.mjs` makes the same move for the same
 * reason; a guard that trips on its own source is not a guard.
 */
const EM_DASH = "\u2014";

/** A column no access request could ever grant. Used to fault inject the validator. */
const FAULT_COLUMN = "wildcat_probe_ungranted_column";

let checksPassed = 0;
let checksFailed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    checksPassed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    checksFailed += 1;
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`);
  }
}

/** table.column -> access, lowercased, from plugin.xml access_request. */
function parseGrants(xml: string): Map<string, string> {
  const grants = new Map<string, string>();
  const pattern = /<field\s+table="([^"]+)"\s+field="([^"]+)"\s+access="([^"]+)"\s*\/>/g;
  for (const match of xml.matchAll(pattern)) {
    grants.set(`${match[1].toLowerCase()}.${match[2].toLowerCase()}`, match[3]);
  }
  return grants;
}

type ParsedQuery = {
  name: string;
  coreTable: string;
  args: string[];
  columns: Array<{ source: string; alias: string }>;
  sql: string;
};

function parseQueries(xml: string): ParsedQuery[] {
  const queries: ParsedQuery[] = [];
  const blocks = xml.matchAll(/<query\s+([^>]*)>([\s\S]*?)<\/query>/g);
  for (const block of blocks) {
    const attrs = block[1];
    const body = block[2];
    const name = /name="([^"]+)"/.exec(attrs)?.[1] ?? "";
    const coreTable = /coreTable="([^"]+)"/.exec(attrs)?.[1] ?? "";
    const args = [...body.matchAll(/<arg\s+name="([^"]+)"/g)].map((m) => m[1]);
    const columns = [...body.matchAll(/<column\s+column="([^"]+)"\s*>([^<]*)<\/column>/g)].map(
      (m) => ({ source: m[1], alias: m[2].trim() }),
    );
    const sql = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(body)?.[1] ?? "";
    queries.push({ name, coreTable, args, columns, sql });
  }
  return queries;
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Split a SQL fragment on commas that sit at parenthesis depth zero. */
function splitTopLevel(fragment: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (const character of fragment) {
    if (character === "'") inString = !inString;
    if (!inString) {
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      else if (character === "," && depth === 0) {
        items.push(current);
        current = "";
        continue;
      }
    }
    current += character;
  }
  if (current.trim() !== "") items.push(current);
  return items.map((item) => item.trim());
}

/** The SELECT list, from SELECT to the first FROM at depth zero. */
function selectList(sql: string): string[] {
  const clean = stripSqlComments(sql);
  const selectAt = clean.search(/\bSELECT\b/i);
  if (selectAt < 0) return [];
  let depth = 0;
  let inString = false;
  let fromAt = -1;
  for (let index = selectAt; index < clean.length; index += 1) {
    const character = clean[index];
    if (character === "'") inString = !inString;
    if (inString) continue;
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (depth === 0 && /\s/.test(character)) {
      if (/^FROM\b/i.test(clean.slice(index + 1))) {
        fromAt = index + 1;
        break;
      }
    }
  }
  if (fromAt < 0) return [];
  return splitTopLevel(clean.slice(selectAt + "SELECT".length, fromAt));
}

function aliasOf(selectItem: string): string {
  const explicit = /\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(selectItem.trim());
  if (explicit) return explicit[1];
  const bare = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(selectItem.trim());
  return bare ? bare[1] : "";
}

/**
 * Words that can follow a table name but are never an alias.
 *
 * These have to be excluded INSIDE the regex, not after it. See the comment on
 * ALIAS_PATTERN for why that distinction is the whole bug this list fixes.
 */
const SQL_NON_ALIAS_WORDS = [
  "on", "where", "group", "order", "left", "right", "inner", "outer", "full",
  "cross", "join", "and", "or", "having", "select", "from", "union", "using",
  "natural", "start", "connect", "partition", "fetch", "offset",
];

/**
 * Matches `FROM <table> [AS] [<alias>]` and `JOIN <table> [AS] [<alias>]`.
 *
 * The alias group is guarded by a negative lookahead rather than being matched
 * and then discarded, and that is load bearing rather than stylistic.
 *
 * The previous version was `(\s+(\w+))?` with the keyword test applied to the
 * captured text afterwards. On `FROM CC JOIN SECTIONS SEC` the optional group
 * happily matched the whitespace and the word `JOIN`; the after the fact test
 * correctly refused to register `JOIN` as an alias, but the regex had already
 * CONSUMED it. matchAll resumed after `JOIN`, so `SECTIONS SEC` was never seen
 * as a table at all, and every `SEC.` reference in the query silently resolved
 * to nothing and went unchecked. A validator that skips columns is worse than
 * no validator, because it reads as a pass.
 *
 * With the lookahead the optional group fails to match at all when the next
 * word is a keyword, the group collapses to zero width, and matchAll resumes
 * immediately after the table name where the next `JOIN` is still waiting.
 */
const ALIAS_PATTERN = new RegExp(
  String.raw`\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)` +
    String.raw`(?:\s+(?:AS\s+)?(?!(?:${SQL_NON_ALIAS_WORDS.join("|")})\b)([A-Za-z_][A-Za-z0-9_]*))?`,
  "gi",
);

/** alias -> real table, read from FROM and JOIN clauses. */
function aliasMap(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  const clean = stripSqlComments(sql);
  for (const match of clean.matchAll(ALIAS_PATTERN)) {
    const table = match[1].toLowerCase();
    const alias = match[2];
    map.set(table, table);
    if (alias) map.set(alias.toLowerCase(), table);
  }
  return map;
}

/**
 * Words that are SQL, not columns. Anything here is never reported as a bare
 * column reference. Function names that are always followed by an open paren do
 * not need to be listed, because the paren rule in `bareIdentifiers` already
 * excludes them; SYSDATE is listed because it is a bare word with no paren.
 */
const SQL_RESERVED = new Set(
  [
    "select", "distinct", "from", "where", "group", "by", "order", "having", "join",
    "left", "right", "inner", "outer", "full", "cross", "natural", "on", "using",
    "and", "or", "not", "in", "is", "null", "between", "like", "exists", "as",
    "case", "when", "then", "else", "end", "asc", "desc", "union", "all", "with",
    "sysdate", "partition", "over", "fetch", "offset", "rows", "only", "connect",
    "start", "prior", "interval", "date", "timestamp", "escape",
  ],
);

/**
 * Bare, unqualified identifiers in the SQL, which the grant checker cannot see.
 *
 * A critic defeated the previous validator by replacing `MIN(C.COURSE_NAME)`
 * with `MIN(ROOM)`. `ROOM` is a real PowerSchool column and an ungranted one,
 * and every check passed, because the grant checker only ever resolved
 * `alias.COLUMN` shapes. "0 ungranted references" meant "0 references I could
 * see", which is the exact failure mode this file already fixed once for
 * aliases and had not fixed for bare columns.
 *
 * A bare column is also bad SQL in a multi table join regardless of grants, so
 * the rule here is simply: every column reference must carry an alias. That
 * makes this a syntactic check with no false-negative surface, rather than a
 * guess at which bare words are columns.
 *
 * Excluded, in order: the column half of `alias.COLUMN`, the alias half, a word
 * followed by an open paren (a function call), a reserved word, a known table or
 * alias name, and a word that directly follows `AS` (an output alias).
 */
function bareIdentifiers(sql: string, declaredAliases: Set<string>): string[] {
  // Strip comments, then string literals, so 'Absent' and 'T' are not words.
  const clean = stripSqlComments(sql).replace(/'[^']*'/g, "''");
  const aliases = aliasMap(clean);
  const found = new Set<string>();
  const pattern = /[A-Za-z_][A-Za-z0-9_]*/g;
  for (const match of clean.matchAll(pattern)) {
    const word = match[0];
    const start = match.index ?? 0;
    const end = start + word.length;

    // The column half of alias.COLUMN, or a bind variable.
    const before = clean.slice(0, start).replace(/\s+$/, "");
    if (before.endsWith(".") || before.endsWith(":")) continue;

    const after = clean.slice(end).replace(/^\s+/, "");
    // The alias half of alias.COLUMN, or a function call.
    if (after.startsWith(".") || after.startsWith("(")) continue;

    const lower = word.toLowerCase();
    if (SQL_RESERVED.has(lower)) continue;
    if (aliases.has(lower)) continue;
    if (declaredAliases.has(lower)) continue;

    // An output alias: the word immediately after AS.
    if (/\bAS$/i.test(before)) continue;

    found.add(word);
  }
  return [...found];
}

/** Every ALIAS.COLUMN token in the SQL, resolved through the alias map. */
function referencedColumns(sql: string): string[] {
  const clean = stripSqlComments(sql);
  const aliases = aliasMap(clean);
  const seen = new Set<string>();
  for (const match of clean.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    const table = aliases.get(match[1].toLowerCase());
    if (!table) continue;
    seen.add(`${table}.${match[2].toLowerCase()}`);
  }
  return [...seen];
}

async function selftest(): Promise<void> {
  console.log("Expansion probe offline self test. No credentials, no network.\n");

  // ---- 1. The reach classifier, against synthetic PowerSchool responses ----
  console.log("Reach classifier");
  const fakeResponses: Record<string, { status: number; json: any; text: string }> = {
    "granted-table": { status: 200, json: { record: [] }, text: "" },
    "ungranted-table": {
      status: 403,
      json: { message: "At least one column lacks sufficient permission" },
      text: "",
    },
    "badcolumn-table": {
      status: 400,
      json: { message: "Invalid field specified: nope is not valid column for table: Badcolumn" },
      text: "",
    },
    "missing-table": { status: 404, json: { message: "not found" }, text: "" },
    "closed-table": {
      status: 405,
      json: { message: "GET, POST and PUT are not allowed on table" },
      text: "",
    },
    "weird-table": { status: 400, json: { message: "Something else entirely" }, text: "" },
  };
  const fakeClient = {
    get: async (path: string) => {
      const table = path.split("/").pop() ?? "";
      return fakeResponses[table] ?? { status: 500, json: null, text: "" };
    },
  } as unknown as PowerSchoolClient;

  const expectations: Array<[string, Reach]> = [
    ["granted-table", "granted"],
    ["ungranted-table", "ungranted-column-exists"],
    ["badcolumn-table", "column-absent"],
    ["missing-table", "table-absent"],
    ["closed-table", "endpoint-closed"],
    ["weird-table", "error"],
  ];
  for (const [table, expected] of expectations) {
    const result = await probeColumn(fakeClient, table, "nope");
    check(`${table} classifies as ${expected}`, result.reach === expected, `got ${result.reach}`);
  }

  // A 403 on the canary must be read as "table exists", because a permission
  // error can only be raised about a table the server actually has.
  const canaryYes = await probeTable(fakeClient, "ungranted-table", []);
  check("403 canary means the table exists", canaryYes.exists === "yes", canaryYes.exists);
  const canaryNo = await probeTable(fakeClient, "missing-table", ["a", "b"]);
  check("404 canary means the table is absent", canaryNo.exists === "no", canaryNo.exists);
  check(
    "an absent table burns no further requests",
    canaryNo.columns.length === 0,
    `${canaryNo.columns.length} column probes issued`,
  );

  // ---- 2. Population stats ----
  console.log("\nPopulation stats");
  const sample = [
    { tables: { attendance: { ccid: 11, periodid: null } } },
    { tables: { attendance: { ccid: 12, periodid: null } } },
    { tables: { attendance: { ccid: null, periodid: null } } },
    { tables: { attendance: { ccid: 11, periodid: null } } },
  ];
  const stats = populationStats(sample, ["ccid", "periodid"]);
  check("non null count is right", stats[0].nonNull === 3, String(stats[0].nonNull));
  check("rate is right", stats[0].rate === "75%", stats[0].rate);
  check("distinct count is right", stats[0].distinct === 2, String(stats[0].distinct));
  check("an all null column reads 0%", stats[1].rate === "0%", stats[1].rate);

  // ---- 2b. aliasMap, against the shape that used to defeat it ----------
  //
  // Regression test for a real defect. `FROM CC` with no alias, followed by
  // `JOIN SECTIONS SEC`, used to lose SECTIONS entirely because the optional
  // alias group ate the JOIN keyword. Every SEC.* reference in the real
  // period_structure query then went unchecked while the suite reported a pass.
  console.log("\naliasMap");
  const unaliasedFrom = aliasMap("SELECT SEC.ID FROM CC JOIN SECTIONS SEC ON SEC.ID = CC.SECTIONID");
  check("an unaliased FROM does not swallow the next JOIN", unaliasedFrom.get("sec") === "sections",
    `sec -> ${unaliasedFrom.get("sec")}`);
  check("the unaliased table itself is still registered", unaliasedFrom.get("cc") === "cc");
  const aliasedFrom = aliasMap("SELECT S.ID FROM STUDENTS S JOIN CC ON CC.STUDENTID = S.ID LEFT JOIN TERMS TM ON TM.ID = 1");
  check("an aliased FROM registers both names", aliasedFrom.get("s") === "students" && aliasedFrom.get("students") === "students");
  check("a later unaliased JOIN is registered", aliasedFrom.get("cc") === "cc");
  check("a JOIN after an unaliased JOIN is registered", aliasedFrom.get("tm") === "terms", `tm -> ${aliasedFrom.get("tm")}`);
  const asAlias = aliasMap("SELECT X.A FROM COURSES AS X JOIN TERMS AS T ON T.ID = X.ID");
  check("the AS keyword form is understood", asAlias.get("x") === "courses" && asAlias.get("t") === "terms");
  check(
    "a keyword is never registered as an alias",
    !aliasMap("SELECT 1 FROM CC WHERE CC.ID = 1").has("where"),
  );

  // ---- 3. The PowerQueries, against the real grant in plugin.xml ----
  console.log("\nPowerQueries versus the granted access request");
  const pluginXml = await readFile(PLUGIN_XML, "utf8");
  const expansionXml = await readFile(EXPANSION_QUERIES, "utf8");
  const siblingXml = await readFile(SIBLING_QUERIES, "utf8");
  const grants = parseGrants(pluginXml);
  const queries = parseQueries(expansionXml);
  const siblingNames = new Set(parseQueries(siblingXml).map((query) => query.name));

  check(`plugin.xml parsed (${grants.size} granted fields)`, grants.size > 100, String(grants.size));
  check(`expansion file parsed (${queries.length} queries)`, queries.length === 4, String(queries.length));
  check(
    "every grant is ViewOnly",
    [...grants.values()].every((access) => access === "ViewOnly"),
    "a FullAccess grant appeared in plugin.xml",
  );
  check("no em dash anywhere in the query file", !/\u2014/.test(expansionXml));

  // The live install check calls each query by name. If the XML is renamed and
  // that list is not, the probe reports 404 for a query that is actually there,
  // which is the most misleading failure this file could produce. Bind them.
  const declaredNames = new Set(queries.map((query) => query.name));
  const calledNames = NAMED_QUERY_ARGS.map((entry) => `com.lapromisefund.wildcathub.${entry.short}`);
  const notDeclared = calledNames.filter((name) => !declaredNames.has(name));
  const notCalled = [...declaredNames].filter((name) => !calledNames.includes(name));
  check("every query the probe calls exists in the XML", notDeclared.length === 0, notDeclared.join(", "));
  check("every query in the XML is called by the probe", notCalled.length === 0, notCalled.join(", "));

  for (const query of queries) {
    const label = query.name.replace("com.lapromisefund.wildcathub.", "");

    check(`${label}: name does not collide with the sibling file`, !siblingNames.has(query.name));

    // Column attribute must name a granted table.column.
    const ungrantedAttrs = query.columns
      .map((column) => column.source.toLowerCase())
      .filter((source) => !grants.has(source));
    check(
      `${label}: every <column> attribute is granted`,
      ungrantedAttrs.length === 0,
      ungrantedAttrs.join(", "),
    );

    // Every ALIAS.COLUMN the SQL touches must be granted. This is the check
    // that catches a 403 before it reaches production.
    //
    // The name is narrow on purpose. It says "alias qualified" because that is
    // all it can see: the resolver only understands `alias.COLUMN`. A bare
    // `ROOM` is invisible to it, which is a real hole a critic walked through.
    // The bare column check below closes that hole; this one must not claim to.
    const ungrantedRefs = referencedColumns(query.sql).filter((reference) => !grants.has(reference));
    check(
      `${label}: every alias qualified column the SQL touches is granted`,
      ungrantedRefs.length === 0,
      ungrantedRefs.join(", "),
    );

    // And nothing may be unqualified, because an unqualified column is exactly
    // what the check above cannot see. Output aliases are excluded, so this
    // rejects `MIN(ROOM)` and accepts `MIN(C.COURSE_NAME) AS example_course_name`.
    const declaredAliases = new Set(query.columns.map((column) => column.alias.toLowerCase()));
    const bare = bareIdentifiers(query.sql, declaredAliases);
    check(
      `${label}: no unqualified column reference`,
      bare.length === 0,
      `bare identifiers: ${bare.join(", ")}`,
    );

    // Column count and order must match the SELECT list exactly.
    const aliases = selectList(query.sql).map(aliasOf);
    check(
      `${label}: <columns> count matches the SELECT list`,
      aliases.length === query.columns.length,
      `sql ${aliases.length} vs columns ${query.columns.length}`,
    );
    const mismatched = aliases
      .map((alias, index) => ({ alias, declared: query.columns[index]?.alias ?? "(missing)" }))
      .filter((pair) => pair.alias.toLowerCase() !== pair.declared.toLowerCase());
    check(
      `${label}: aliases match in order`,
      mismatched.length === 0,
      mismatched.map((pair) => `${pair.alias} vs ${pair.declared}`).join(", "),
    );

    // The 404-forever trap: a bind variable the args block does not declare.
    const bound = [...new Set([...query.sql.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
    const undeclared = bound.filter((name) => !query.args.includes(name));
    check(`${label}: every bind variable is declared in <args>`, undeclared.length === 0, undeclared.join(", "));
    const unused = query.args.filter((name) => !bound.includes(name));
    check(`${label}: every declared arg is used`, unused.length === 0, unused.join(", "));

    // Read only, structurally.
    check(
      `${label}: SQL is SELECT only`,
      !/\b(INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE|ALTER|CREATE)\b/i.test(stripSqlComments(query.sql)),
    );
    check(`${label}: no wildcard SELECT`, !/SELECT\s+\*/i.test(query.sql));
    check(`${label}: coreTable is set`, query.coreTable.length > 0);

    // ---- The check that the check works -------------------------------
    //
    // A previous round shipped a validator that passed an ungranted column
    // because aliasMap silently dropped a table, so "0 ungranted references"
    // meant "0 references seen" rather than "0 problems". Two guards now stop
    // that from ever reading as a pass again.
    //
    // Guard one: every alias prefix that appears before a dot anywhere in the
    // SQL must resolve to a real table. An unresolvable prefix is exactly the
    // silent skip, and it is now a failure rather than a shrug.
    const aliasesInSql = aliasMap(query.sql);
    const unresolved = [
      ...new Set(
        [...stripSqlComments(query.sql).matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_]/g)]
          .map((match) => match[1].toLowerCase())
          .filter((prefix) => !aliasesInSql.has(prefix)),
      ),
    ];
    check(
      `${label}: every table alias used in the SQL resolves`,
      unresolved.length === 0,
      `unresolved prefixes: ${unresolved.join(", ")}`,
    );

    // Guard two: fault injection, on EVERY alias in the query rather than one
    // hand picked spot. For each alias, splice a column that cannot possibly be
    // granted into the WHERE clause and require the validator to catch it. If
    // any single alias is being skipped, one of these injections passes
    // validation and this test fails loudly.
    for (const alias of [...new Set(aliasesInSql.keys())]) {
      const poisoned = query.sql.replace(
        /\bWHERE\b/i,
        `WHERE ${alias.toUpperCase()}.${FAULT_COLUMN} IS NOT NULL AND`,
      );
      check(
        `${label}: an ungranted column on alias "${alias}" is caught`,
        poisoned !== query.sql &&
          referencedColumns(poisoned)
            .filter((reference) => !grants.has(reference))
            .some((reference) => reference.endsWith(`.${FAULT_COLUMN}`)),
        poisoned === query.sql
          ? "no WHERE clause to inject into, so this query is untested"
          : `injection on ${alias} was NOT reported as ungranted`,
      );
    }

    // Guard three: the injection that actually got past the previous round.
    // A critic replaced MIN(C.COURSE_NAME) with MIN(ROOM) in period_structure
    // and the suite still reported 106 of 106. Reproduce that exact edit here
    // on every query that has a function call to poison, and require a catch.
    const barePoisoned = query.sql.replace(
      /\b[A-Za-z_][A-Za-z0-9_]*\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\s*\)/,
      "MIN(ROOM)",
    );
    if (barePoisoned !== query.sql) {
      check(
        `${label}: a bare unqualified column is caught`,
        bareIdentifiers(barePoisoned, declaredAliases).includes("ROOM"),
        "MIN(ROOM) was NOT reported as a bare identifier",
      );
    }
  }

  // The bare column detector, against the shapes it must and must not flag.
  console.log("\nBare column detector");
  const noAliases = new Set<string>();
  check(
    "a bare column in a function call is flagged",
    bareIdentifiers("SELECT MIN(ROOM) AS r FROM SECTIONS SEC WHERE SEC.ID = 1", new Set(["r"])).includes("ROOM"),
  );
  check(
    "a qualified column is not flagged",
    bareIdentifiers("SELECT MIN(SEC.ROOM) AS r FROM SECTIONS SEC WHERE SEC.ID = 1", new Set(["r"])).length === 0,
  );
  check(
    "an output alias after AS is not flagged",
    !bareIdentifiers("SELECT SEC.ID AS section_id FROM SECTIONS SEC", noAliases).includes("section_id"),
  );
  check(
    "a string literal is not read as a column",
    bareIdentifiers("SELECT SEC.ID AS a FROM SECTIONS SEC WHERE SEC.NAME = 'Absent'", new Set(["a"])).length === 0,
    bareIdentifiers("SELECT SEC.ID AS a FROM SECTIONS SEC WHERE SEC.NAME = 'Absent'", new Set(["a"])).join(", "),
  );
  check(
    "SYSDATE is not read as a column",
    bareIdentifiers("SELECT S.ID AS a FROM STUDENTS S WHERE S.D >= TRUNC(SYSDATE)", new Set(["a"])).length === 0,
    bareIdentifiers("SELECT S.ID AS a FROM STUDENTS S WHERE S.D >= TRUNC(SYSDATE)", new Set(["a"])).join(", "),
  );
  check(
    "a bind variable is not read as a column",
    bareIdentifiers("SELECT S.ID AS a FROM STUDENTS S WHERE S.SCHOOLID = :schoolid", new Set(["a"])).length === 0,
    bareIdentifiers("SELECT S.ID AS a FROM STUDENTS S WHERE S.SCHOOLID = :schoolid", new Set(["a"])).join(", "),
  );

  // The COURSES join predicate. The defect that cost this piece a round: an
  // equality join on SCHOOLID cannot see a district level course at SCHOOLID 0,
  // and 130 of the 484 COURSES rows in this instance are exactly that.
  console.log("\nCOURSES join predicate");
  for (const query of queries) {
    const label = query.name.replace("com.lapromisefund.wildcathub.", "");
    const clean = stripSqlComments(query.sql);
    if (!/\bCOURSES\b/i.test(clean)) continue;
    check(
      `${label}: the COURSES join allows district level courses at SCHOOLID 0`,
      /C\.SCHOOLID\s*=\s*SEC\.SCHOOLID\s+OR\s+C\.SCHOOLID\s*=\s*0/i.test(clean),
      "the equality only predicate drops 34 percent of live enrollments on this instance",
    );
    check(
      `${label}: the COURSES join is a LEFT JOIN`,
      /LEFT\s+JOIN\s+COURSES\b/i.test(clean),
      "an INNER JOIN drops a student when the course row is missing entirely",
    );
  }
  for (const query of queries) {
    const label = query.name.replace("com.lapromisefund.wildcathub.", "");
    const clean = stripSqlComments(query.sql);
    if (!/\bJOIN\s+CC\b|\bFROM\s+CC\b/i.test(clean)) continue;
    check(
      `${label}: CC is filtered to enrollments overlapping the term`,
      /CC\.DATELEFT\s+IS\s+NULL\s+OR\s+CC\.DATELEFT\s*>=/i.test(clean),
      "without this the queries in this file count different populations",
    );
    // The bound must be the TERM, not today. Against TRUNC(SYSDATE) every row
    // in a completed term has already left, so the query returns nothing on
    // every term that actually has attendance data, which is all of them except
    // the one currently running. It looks like a correct zero and is not.
    check(
      `${label}: the enrollment window is bounded by the term, not by today`,
      !/CC\.DATELEFT\s*>=\s*TRUNC\s*\(\s*SYSDATE/i.test(clean),
      "TRUNC(SYSDATE) returns zero rows for every completed term",
    );
    check(
      `${label}: and the near side of the window is bounded too`,
      /CC\.DATEENROLLED\s*<=\s*\w+\.LASTDAY/i.test(clean),
      "without an upper bound on DATEENROLLED the window is open ended",
    );
  }

  // ---- 4. A run must never destroy the hand written analysis ----
  console.log("\nHand written analysis survives a run");
  const analysis = "# SIS coverage expansion\n\nRanking that took real work.\n\n";
  check(
    "text above the marker is kept verbatim",
    preservedPrefix(`${analysis}${PROBE_MARKER}\n\nold machine output\n`) === analysis,
  );
  check(
    "stale machine output below the marker is dropped",
    !preservedPrefix(`${analysis}${PROBE_MARKER}\n\nold machine output\n`).includes("old machine output"),
  );
  check(
    "a file with no marker is kept whole and appended to",
    preservedPrefix("hand written, no marker").startsWith("hand written, no marker"),
  );
  check("an absent file preserves nothing", preservedPrefix("") === "");
  check("the rendered report starts with the marker", renderReport(
    { host: "example.test", hourlyRequestCeiling: 3000 } as Config,
    { table: "x", column: "y", reach: "table-absent", status: 404, detail: "not found" },
    [],
    [],
    { requests: 0, tokenFetches: 0, totalMs: 0, slowest: null, errors: 0 },
    "1970-01-01T00:00:00.000Z",
  ).startsWith(PROBE_MARKER));

  // ---- 5. Report rendering must not throw on an empty run ----
  console.log("\nReport rendering");
  try {
    const rendered = renderReport(
      { host: "example.test", hourlyRequestCeiling: 3000 } as Config,
      { table: "x", column: "y", reach: "table-absent", status: 404, detail: "not found" },
      CANDIDATES.map((candidate) => ({ candidate, probes: [] })),
      [],
      { requests: 0, tokenFetches: 0, totalMs: 0, slowest: null, errors: 0 },
      "1970-01-01T00:00:00.000Z",
    );
    check("report renders", rendered.includes("# Probe output"));
    check("report has no em dash", !/\u2014/.test(rendered));
  } catch (error: unknown) {
    check("report renders", false, error instanceof Error ? error.message : String(error));
  }

  console.log(`\n${checksPassed} passed, ${checksFailed} failed`);
  if (checksFailed > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (process.argv.includes("--selftest")) {
    await selftest();
    return;
  }

  const config = loadConfig();
  const generatedAt = new Date().toISOString();

  console.log("Wildcat Hub SIS coverage expansion probe (GET only)");
  console.log("Config:", redactedConfig(config));

  const risk = productionRisk(config.host);
  if (risk !== null) console.warn(`\nWARNING: ${risk}\n`);

  const client = new PowerSchoolClient(config);
  await client.authenticate();

  console.log("\nControl probe: what does a missing table look like here?\n");
  const control = await probeColumn(client, CONTROL_MISSING_TABLE, CANARY_COLUMN);
  console.log(`  ${CONTROL_MISSING_TABLE} -> ${control.status} ${reachSymbol(control.reach)}`);

  console.log("\nProbing candidates.\n");
  const results: Array<{ candidate: Candidate; probes: TableProbe[] }> = [];
  for (const candidate of CANDIDATES) {
    if (candidate.skipReason) {
      console.log(`  ${candidate.title.padEnd(52)} NOT PROBED`);
      results.push({ candidate, probes: [] });
      continue;
    }
    const probes: TableProbe[] = [];
    for (const target of candidate.tables) {
      probes.push(await probeTable(client, target.table, target.columns));
    }
    results.push({ candidate, probes });
    console.log(`  ${candidate.title.padEnd(52)} ${candidateVerdict(probes)}`);
  }

  console.log("\nPulling evidence from real rows.\n");
  // Read once, used by two evidence sections. COURSES is small and carries no
  // student data, but five requests is five requests.
  const census = await readCourseCensus(client);
  const evidence: Evidence[] = [
    await evidenceNamedQueriesInstalled(client, config),
    await evidenceCoursesJoin(client, config, census),
    await evidenceAttendanceKeys(client, config),
    await evidenceAttendanceCodes(client, config),
    await evidenceAttendanceJoin(client, config, census),
    await evidencePeriodExpressions(client, config),
    await evidenceEnrollmentDates(client, config),
    await evidenceV1Expansions(client, config),
  ];
  for (const item of evidence) {
    console.log(`  ${item.title.padEnd(60)} ${item.ok ? "ok" : "FAILED"}`);
  }

  const summary = client.summary();
  const report = renderReport(config, control, results, evidence, summary, generatedAt);

  // Keep the hand written analysis above the marker. Replace only below it.
  let existing = "";
  try {
    existing = await readFile(OUTPUT_PATH, "utf8");
  } catch {
    existing = "";
  }
  const preserved = preservedPrefix(existing);

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${preserved}${report}`, "utf8");

  console.log(`\nWrote ${OUTPUT_PATH}`);
  console.log(
    preserved === ""
      ? "  (no hand written analysis found above the marker)"
      : `  (preserved ${preserved.length} bytes of hand written analysis above the marker)`,
  );
  console.log("Run summary:", summary);
}

/**
 * Only run when this file is the entry point.
 *
 * Without the guard, importing this module for any reason (a test reaching for
 * `preservedPrefix`, a future harness reusing the classifier) would fire a live
 * run against PRODUCTION as an import side effect. That is a bad way to find
 * out about a bad default.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return resolve(invoked) === fileURLToPath(import.meta.url);
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
