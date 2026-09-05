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

/**
 * Which address a TEACHER's sections are looked up under.
 *
 * `email` is the identity: what the token carries, what sign-in matched, what
 * every permission check reads. `psEmail` is a data-mismatch patch and nothing
 * more -- the address PowerSchool still files someone's sections under after a
 * name change, until a registrar corrects the SIS. It is never consulted by
 * authentication.
 *
 * `ownerExists` is whether some staff record signs in as `psEmail`. The caller
 * looks that up; the rule is here so it can be tested against the cases that
 * matter without a database.
 *
 * REFUSED, NOT THROWN. A patch that has gone stale should leave a teacher
 * looking at their own (empty) roster with a note about it, not an error screen
 * in front of a class. The refusal is reported so the caller can log it and the
 * screen can say what happened.
 *
 * The caller must re-run this on EVERY read rather than trusting a check made
 * when the value was written. An address that is unclaimed the day an admin
 * sets it can be claimed later -- a new hire, an old account re-enabled -- and
 * a write-time check cannot see that coming.
 */
export function teacherRosterEmail(
  teacher: { email: string; psEmail?: string | null },
  ownerExists: boolean,
): { email: string; via: string | null; refused: boolean } {
  const own = String(teacher?.email ?? "").trim().toLowerCase();
  const alt = String(teacher?.psEmail ?? "").trim().toLowerCase();

  // No patch, or one that says the same thing: nothing to do.
  if (!alt || alt === own) return { email: own, via: null, refused: false };

  // The address belongs to somebody. It is their identity, not a spare label
  // for a stale SIS row, and reading their roster is not a thing to do quietly.
  if (ownerExists) return { email: own, via: null, refused: true };

  return { email: alt, via: alt, refused: false };
}
