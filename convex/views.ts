/**
 * Response shapes. Pure, no Convex imports, so the PII boundary is directly
 * testable rather than asserted in a comment.
 *
 * Every one of these is an ALLOWLIST built field by field from the input. None
 * of them spread the source row. That is the whole point: the PowerSchool
 * roster grows columns over time, and restricted fields (federal ethnicity,
 * federal race, IEP, 504, English Learner) are one approval away from existing.
 * With an allowlist a new upstream column is invisible until someone adds it
 * here on purpose. With a spread, or a denylist, it ships to students the day
 * it arrives.
 */

export type RosterRowLike = {
  studentNumber?: string;
  studentEmail?: string;
  firstName?: string;
  lastName?: string;
  gradeLevel?: string;
  courseName?: string;
  courseNumber?: string;
  period?: string;
  sectionExpression?: string;
  sectionNumber?: string;
  teacherFirstName?: string;
  teacherLastName?: string;
  teacherEmail?: string;
  termAbbreviation?: string;
  // Anything else upstream adds is intentionally not described here, and is
  // intentionally not returned by the functions below.
  [key: string]: unknown;
};

/**
 * What a STUDENT may see about their own schedule.
 *
 * Deliberately absent: state_student_number (a state-issued identifier),
 * gender, their own and their teacher's email addresses, and every restricted
 * field. A student needs to know which class, which period, and which teacher.
 */
export function studentView(row: RosterRowLike) {
  return {
    courseName: row.courseName ?? null,
    courseNumber: row.courseNumber ?? null,
    period: row.period ?? row.sectionExpression ?? null,
    teacher:
      [row.teacherFirstName, row.teacherLastName].filter(Boolean).join(" ") ||
      null,
    term: row.termAbbreviation ?? null,
  };
}

/**
 * What STAFF may see about a student on their own roster.
 *
 * Wider than the student view because a teacher needs to identify who they are
 * looking at, but still an allowlist. Restricted fields are not here either:
 * per Grilled.md constraint 3 those sit behind their own go/no-go gate with
 * separate access tests, and a classroom roster is not that gate.
 */
export function staffRosterView(row: RosterRowLike) {
  return {
    studentNumber: row.studentNumber ?? null,
    firstName: row.firstName ?? null,
    lastName: row.lastName ?? null,
    gradeLevel: row.gradeLevel ?? null,
    courseName: row.courseName ?? null,
    courseNumber: row.courseNumber ?? null,
    period: row.period ?? row.sectionExpression ?? null,
    term: row.termAbbreviation ?? null,
  };
}

/**
 * One SIS schedule row as STAFF see it in a student drill-down.
 *
 * Wider than the student's own view (it names the section) but still an
 * allowlist built field by field. Restricted fields are not in psRoster at
 * all, so this cannot surface one; the allowlist is the second line, for the
 * day someone adds a column upstream.
 */
export function studentSisView(row: RosterRowLike) {
  return {
    courseName: row.courseName ?? null,
    courseNumber: row.courseNumber ?? null,
    period: row.period ?? row.sectionExpression ?? null,
    sectionNumber: row.sectionNumber ?? null,
    teacher:
      [row.teacherFirstName, row.teacherLastName].filter(Boolean).join(" ") ||
      null,
    term: row.termAbbreviation ?? null,
  };
}

/**
 * A day count from the SIS, or null. The single most repeated mistake in this
 * codebase's history, written down once.
 *
 * `?? 0` on an OPTIONAL column reads on screen as a measurement. "0 days absent"
 * and "we have never been told" are opposite facts about a child and they look
 * identical, which is why schema.ts says beside psAttendance that absence there
 * "means not synced yet, NOT zero".
 *
 * Rejected as well as undefined:
 *   NaN        survives `!== undefined`, IS a number, serializes to null, so the
 *              field would claim a count while rendering nothing.
 *   Infinity   same.
 *   negative   a student cannot be absent minus three days. That is a broken
 *              aggregate upstream, and a broken aggregate is not a fact.
 *   "4"        a string that looks like a count. Coercing it would hide the day
 *              the sync starts writing text into a number column.
 *
 * Lives here rather than in studentProfileRules.ts beside the panel that uses
 * it, because views.ts and studentProfileRules.ts are both imported directly by
 * plain-node tests, and node will not resolve an extensionless specifier between
 * two `.ts` files. Both modules therefore import nothing, which is the property
 * that makes them testable at all.
 */
export function dayCount(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

export type AttendanceRowLike = {
  studentNumber?: string;
  daysAbsentTerm?: number;
  daysAbsentYtd?: number;
  daysTardyTerm?: number;
  attendanceRowsYtd?: number;
  termFirstDay?: string;
  termLastDay?: string;
  termId?: string;
  syncedAt?: string;
  [key: string]: unknown;
};

/**
 * One psAttendance row as STAFF see it in a student drill-down.
 *
 * An allowlist for the same reason every function above is one: psAttendance is
 * written by a sync from a system nobody here controls, and a column added
 * upstream must be invisible until someone adds it here on purpose.
 *
 * NOTHING IS DEFAULTED TO ZERO. Every count column in psAttendance is optional,
 * and the schema comment beside it is explicit: "Absent means not synced yet,
 * NOT zero. A student with no row here has unknown attendance; rendering that
 * as 0 days absent would invent a fact about a child." dayCount enforces that,
 * and also refuses NaN, Infinity and negatives, all of which survive a bare
 * `!== undefined` test and would claim a measurement while rendering nothing.
 *
 * `attendanceRowsYtd` is deliberately NOT here. It is a row count from the
 * aggregate, not a day count, and beside "days absent" it reads as a fourth
 * attendance figure that means something to a teacher. It does not.
 *
 * `studentNumber` is not repeated because the caller already resolved the
 * student, and `termId` is not here because it identifies nothing a teacher
 * standing at a desk can use.
 */
export function staffAttendanceView(row: AttendanceRowLike) {
  return {
    daysAbsentTerm: dayCount(row.daysAbsentTerm),
    daysAbsentYtd: dayCount(row.daysAbsentYtd),
    daysTardyTerm: dayCount(row.daysTardyTerm),
    termFirstDay: typeof row.termFirstDay === "string" ? row.termFirstDay : null,
    termLastDay: typeof row.termLastDay === "string" ? row.termLastDay : null,
    lastSyncedAt: typeof row.syncedAt === "string" ? row.syncedAt : null,
  };
}
