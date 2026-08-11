/**
 * The field manifest, as data.
 *
 * This is the single source of truth for what Wildcat Hub is allowed to pull.
 * The probe diffs granted access against this list. Nothing gets added here
 * "while we are in there". Adding a row means updating plugin.xml, bumping its
 * version, and having a PowerSchool admin disable and re-enable the plugin.
 */

export type FieldClass = "Key" | "Standard" | "Derived" | "Restricted";

export type ManifestEntry = {
  /** Manifest number from the brief. Stable identifier across docs. */
  n: number;
  label: string;
  fieldClass: FieldClass;
  /**
   * Table endpoint probes. Each is a single table read that proves the field
   * is granted. Empty when the field is derived and has no direct source.
   */
  probes: Array<{ table: string; fields: string[] }>;
  /** Named query that actually delivers this field in production use. */
  deliveredBy: string | null;
  /** Set when the source is not yet confirmed. Blocks the go / no go line. */
  unconfirmed?: string;
};

export const QUERY_PREFIX = "com.lapromisefund.wildcathub";

export const MANIFEST: ManifestEntry[] = [
  {
    n: 1,
    label: "Student ID / SSID",
    fieldClass: "Key",
    probes: [{ table: "students", fields: ["student_number", "state_studentnumber", "id", "dcid"] }],
    deliveredBy: `${QUERY_PREFIX}.roster`,
  },
  {
    n: 2,
    label: "First / Last Name",
    fieldClass: "Standard",
    probes: [{ table: "students", fields: ["first_name", "last_name"] }],
    deliveredBy: `${QUERY_PREFIX}.roster`,
  },
  {
    n: 3,
    label: "Grade Level",
    fieldClass: "Standard",
    probes: [{ table: "students", fields: ["grade_level"] }],
    deliveredBy: `${QUERY_PREFIX}.roster`,
  },
  {
    n: 4,
    label: "Course",
    fieldClass: "Standard",
    probes: [
      { table: "courses", fields: ["course_number", "course_name"] },
      { table: "cc", fields: ["studentid", "sectionid", "termid", "course_number"] },
    ],
    deliveredBy: `${QUERY_PREFIX}.roster`,
  },
  {
    n: 5,
    label: "Period",
    fieldClass: "Derived",
    probes: [
      { table: "sections", fields: ["expression", "section_number", "teacher"] },
      { table: "cc", fields: ["expression"] },
    ],
    deliveredBy: `${QUERY_PREFIX}.roster`,
    unconfirmed:
      "SECTIONMEETING is an invalid table in this instance, so there is no structured period source. Period must be parsed from SECTIONS.EXPRESSION and CC.EXPRESSION. Phase 4 must prove that parse against a single period section, a multi period block, and an alternating day section.",
  },
  {
    n: 6,
    label: "Teacher",
    fieldClass: "Standard",
    probes: [
      { table: "teachers", fields: ["id", "users_dcid", "first_name", "last_name", "teachernumber"] },
    ],
    deliveredBy: `${QUERY_PREFIX}.roster`,
  },
  {
    n: 7,
    label: "Federal Ethnicity",
    fieldClass: "Restricted",
    probes: [{ table: "students", fields: ["fedethnicity"] }],
    deliveredBy: `${QUERY_PREFIX}.student_restricted`,
  },
  {
    n: 8,
    label: "Federal Race codes",
    fieldClass: "Restricted",
    probes: [{ table: "studentrace", fields: ["studentid", "racecd"] }],
    deliveredBy: `${QUERY_PREFIX}.student_race_restricted`,
  },
  {
    n: 9,
    label: "Gender",
    fieldClass: "Standard",
    probes: [{ table: "students", fields: ["gender"] }],
    deliveredBy: `${QUERY_PREFIX}.roster`,
  },
  {
    n: 10,
    label: "Days Absent (term and YTD)",
    fieldClass: "Derived",
    probes: [
      { table: "attendance", fields: ["studentid", "att_date", "attendance_codeid", "att_mode_code"] },
      { table: "attendance_code", fields: ["att_code", "description", "presence_status_cd"] },
    ],
    deliveredBy: `${QUERY_PREFIX}.attendance_summary`,
  },
  {
    n: 11,
    label: "Current Grade / Percent",
    fieldClass: "Derived",
    probes: [
      { table: "pgfinalgrades", fields: ["studentid", "sectionid", "finalgradename", "grade", "percent"] },
      { table: "storedgrades", fields: ["dcid", "studentid", "sectionid", "storecode", "grade", "percent"] },
    ],
    deliveredBy: `${QUERY_PREFIX}.grades`,
  },
  {
    n: 12,
    label: "IEP / Special Ed status",
    fieldClass: "Restricted",
    probes: [],
    deliveredBy: null,
    unconfirmed:
      "Source unknown. Could be SIS core, a state extension, a local custom field, SEIS, or PowerSchool Special Programs. Registrar and SIS admin must answer before this is added to plugin.xml.",
  },
  {
    n: 13,
    label: "504 status",
    fieldClass: "Restricted",
    probes: [],
    deliveredBy: null,
    unconfirmed:
      "Source unknown. Same question as manifest 12 and likely a different answer. Do not assume they live together.",
  },
  {
    n: 14,
    label: "English Learner status",
    fieldClass: "Restricted",
    probes: [
      { table: "s_ca_stu_x", fields: ["studentsdcid", "elastatus"] },
      { table: "s_ca_stu_ela_c", fields: ["studentsdcid", "elastatus"] },
    ],
    deliveredBy: `${QUERY_PREFIX}.student_restricted`,
  },
  {
    n: 15,
    label: "Teacher ID",
    fieldClass: "Key",
    probes: [{ table: "users", fields: ["dcid", "teachernumber"] }],
    deliveredBy: `${QUERY_PREFIX}.staff`,
  },
  {
    n: 16,
    label: "Staff First / Last Name",
    fieldClass: "Standard",
    probes: [{ table: "users", fields: ["first_name", "last_name"] }],
    deliveredBy: `${QUERY_PREFIX}.staff`,
  },
  {
    n: 17,
    label: "Staff Email",
    fieldClass: "Key",
    probes: [{ table: "users", fields: ["email_addr"] }],
    deliveredBy: `${QUERY_PREFIX}.staff`,
  },
  {
    n: 18,
    label: "Role / Title",
    fieldClass: "Derived",
    probes: [{ table: "schoolstaff", fields: ["users_dcid", "schoolid", "status", "staffstatus"] }],
    deliveredBy: `${QUERY_PREFIX}.staff`,
    unconfirmed:
      "SchoolStaff is likely insufficient to separate an assigning admin from a classroom teacher. If it cannot, derive role from Entra ID group membership and document the mapping.",
  },
];

/** Every distinct table the manifest touches, deduplicated. */
export function manifestTables(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  for (const entry of MANIFEST) {
    for (const probe of entry.probes) {
      const existing = tables.get(probe.table) ?? new Set<string>();
      for (const field of probe.fields) existing.add(field);
      tables.set(probe.table, existing);
    }
  }
  return tables;
}
