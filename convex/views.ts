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
