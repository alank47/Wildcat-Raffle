/**
 * The join keys a student's own portal view is allowed to use. Pure, no ctx, no
 * database, no Convex imports.
 *
 * Split out for the same reason as identityRules.ts, sisMerge.ts and
 * hallPassRules.ts: this decides whether a child is shown another child's
 * grades, and that is worth testing directly rather than through a handler this
 * repo cannot run in a test.
 *
 * THE FAILURE THIS PREVENTS, in full, because it is not obvious from the code
 * it replaced.
 *
 * `psGrades.studentNumber`, `psAttendance.studentNumber` and
 * `psRoster.studentNumber` are REQUIRED strings in schema.ts.
 * `students.studentNumber` is optional, and 209 of 646 enrolled students have
 * incomplete SIS identity today. myStudentView bridged that gap with
 *
 *     const num = student.studentNumber ?? student.legacyId ?? "";
 *
 * and then ran `withIndex("by_studentNumber", q => q.eq("studentNumber", num))`.
 *
 * An index lookup for "" IS NOT A NO-OP. It is a real bucket, and it returns
 * every row whose studentNumber is the empty string. Those rows are written by a
 * sync from an upstream system nobody here controls, so it takes exactly one
 * malformed import for a student with no number of their own to open their
 * portal and read somebody else's grades and absences. Nothing would error. The
 * page would render perfectly.
 *
 * So: no key, no query. A student who is not synced yet sees a panel that says
 * so, which is a fact the office can act on. The alternative is a different
 * child's record, which is not recoverable by anyone.
 *
 * The same argument applies to the email key and `psRoster.by_studentEmail`,
 * where the optional column makes `undefined` the value that indexes every
 * unkeyed roster row together. upsertRoster already refuses to WRITE "" for
 * exactly this reason (psSync.ts:51); this refuses to READ with one.
 */

/** Shown to the student, so it names what is missing and who fixes it. */
export const NO_NUMBER_REASON =
  "Your student number is not on your account yet, so grades and attendance " +
  "cannot be looked up. The office can add it in PowerSchool.";

export const NO_EMAIL_REASON =
  "Your school email is not on your student record yet, so your class " +
  "schedule cannot be looked up. The office can add it in PowerSchool under " +
  "Student Profile > Email.";

export type JoinKey =
  | { ok: true; value: string; reason: null }
  | { ok: false; value: null; reason: string };

/**
 * The student number to join the PowerSchool per-student tables on, or a
 * refusal with the reason.
 *
 * `legacyId` is accepted as the fallback because for students it holds THE SAME
 * VALUE: migrate.ts:52 and sisSync.ts:59 both write `legacyId: studentNumber`.
 * It is a second name for one key, not a second key, and studentDetail.ts reads
 * it the same way. What is removed is only the `?? ""` on the end.
 */
export function sisNumberKey(student: {
  studentNumber?: string | null;
  legacyId?: string | null;
}): JoinKey {
  // Trimmed before it is tested, so a record carrying a single space is treated
  // as the missing key it is rather than queried as " ".
  const value = String(student.studentNumber ?? student.legacyId ?? "").trim();
  if (!value) return { ok: false, value: null, reason: NO_NUMBER_REASON };
  return { ok: true, value, reason: null };
}

/**
 * The email to join `psRoster.by_studentEmail` on, or a refusal with the reason.
 *
 * In practice this cannot fail for a caller that reached here: requireStudentSelf
 * found this row BY that email, so it is present and normalized. It is still a
 * checked key rather than a `!`, because the thing being prevented is an indexed
 * read on an optional column, and "the caller proves it upstream" is exactly the
 * kind of invariant that survives until someone adds a second way to resolve a
 * student and does not notice this read.
 *
 * Lowercased here as well as at write time. Entra and Google hand back directory
 * casing, and an index lookup is byte-exact.
 */
export function sisEmailKey(student: { email?: string | null }): JoinKey {
  const value = String(student.email ?? "").trim().toLowerCase();
  if (!value) return { ok: false, value: null, reason: NO_EMAIL_REASON };
  return { ok: true, value, reason: null };
}

/**
 * One row of the grades panel: is there actually a grade here, and what is it.
 *
 * `available` WAS `currentGrade !== undefined`, WHICH IS TRUE FOR "". A SIS row
 * with an empty-string grade, which is what PowerSchool writes for a section
 * that has been created but not graded, therefore reported as available and
 * rendered an empty box where a letter goes. An empty box in a grade column does
 * not read as "no grade yet"; it reads as a page that failed to load, or as a
 * grade somebody deleted.
 *
 * The same trap in the other column: currentPercent could be NaN from a bad
 * import, which is a number, passes a `!== undefined` test, and serializes to
 * null, so the row claims to have a percent and shows nothing.
 *
 * Pure, so the emptiness rule is asserted rather than eyeballed once.
 */
export function gradeCell(row: {
  courseName?: string | null;
  courseNumber?: string | null;
  currentGrade?: string | null;
  currentPercent?: number | null;
}) {
  const grade = typeof row.currentGrade === "string" ? row.currentGrade.trim() : "";
  const percent =
    typeof row.currentPercent === "number" && Number.isFinite(row.currentPercent)
      ? row.currentPercent
      : null;

  return {
    courseName: row.courseName ?? null,
    courseNumber: row.courseNumber ?? null,
    // null when the SIS has no grade. NEVER 0 and never "": a student with no
    // gradebook entry must not appear to be failing, and must not appear to
    // have a grade that is simply invisible.
    currentGrade: grade === "" ? null : grade,
    currentPercent: percent,
    available: grade !== "" || percent !== null,
  };
}
