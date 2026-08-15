/**
 * Put the student's address onto their roster rows.
 *
 * WHY THIS EXISTS. `psRoster` is the only table that knows who sits in which
 * section, and `me:get` reads it through the `by_studentEmail` index, because a
 * verified token carries an address and nothing else. The roster PowerQuery
 * does not return student email; that comes from a separate query against the
 * Person email model. Nothing joined the two, so every roster row was written
 * with `studentEmail` undefined and EVERY student's schedule came back empty.
 *
 * Nothing errored. The pass card still rendered, because identity and balances
 * come from `students`, and an empty schedule is indistinguishable from a
 * student who has not been scheduled yet. `upsertRoster` was already counting
 * the misses in `missingStudentEmail`; the count was returned and discarded.
 *
 * The join is by STUDENT NUMBER, the one key both queries return.
 *
 * Pure, with no imports, following sisMerge: the sync action is an integration
 * point that cannot be unit tested, so the rule it depends on is kept out of it
 * and tested directly. Which address is a valid key is NOT decided here, it is
 * decided by primaryEmailByStudentNumber in identityRules, beside the domain
 * policy it has to agree with.
 */
export function attachStudentEmail<T extends { studentNumber: string }>(
  rosterRows: readonly T[],
  byNumber: ReadonlyMap<string, string>,
): Array<T & { studentEmail?: string }> {
  return rosterRows.map((row) => {
    const email = byNumber.get(String(row.studentNumber ?? "").trim());
    // A student with no usable address keeps studentEmail undefined, which is
    // the honest answer and what upsertRoster counts. Never "", which would
    // index every unkeyed row under the same value.
    return email ? { ...row, studentEmail: email } : { ...row };
  });
}
