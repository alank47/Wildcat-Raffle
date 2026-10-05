/**
 * Missing work: is this psMissingWork row missing work, for the student it
 * names?
 *
 * Pure and dependency-free so a plain-node test reaches it, for the same
 * reason academicsRules.ts and accessRules.ts are. Every reader that lists or
 * counts missing work asks THIS file, so the student portal, Early Warning and
 * the senior screens cannot give three answers about one assignment.
 *
 * THE OWNER'S FINAL RULE, 2026-10-05, in their words:
 *
 *   "If an assignment is above 0% and marked as missing, then consider it
 *    missing until the teacher removes the designation.
 *    If it's set to 50% or 59% without the missing designation, then it
 *    should not be considered missing.
 *    0% and missing designation = missing. 0% and no missing designation =
 *    missing."
 *
 * So, as a table:
 *
 *   Missing box ticked, any score or none      MISSING
 *   Missing box NOT ticked, scored exactly 0   MISSING
 *   Missing box NOT ticked, scored above 0     not missing
 *   Missing box NOT ticked, no score           not missing
 *
 * WHAT THIS REPLACES. Two earlier rules, both now superseded:
 *
 *   - 2026-09-05, "the flag decides, not the score": a ticked box was missing
 *     and an unticked zero was a SEPARATE kind, "scored zero -- ask about a
 *     retake". The owner's final rule folds that kind into missing.
 *
 *   - earlier on 2026-10-05, "anything above 0% is turned in", which dropped a
 *     ticked box carrying a score. Never deployed. The final rule reverses it:
 *     the box outranks the score, and the fix for a box left ticked on scored
 *     work is the teacher unticking it in PowerSchool, which the next sync
 *     carries across on its own.
 *
 * WHY THE RULE IS APPLIED AT READ TIME, NOT AT THE SYNC. psMissingWork keeps
 * exactly what PowerSchool returned -- flag and score as given -- so a later
 * change of rule is a deploy, not a resync, and nothing about a row is lost
 * on the way in.
 *
 * WHAT THE QUERY RETURNS, AND SO WHAT THIS ACTUALLY FILTERS. missing_work
 * returns ISMISSING = 1 OR SCOREPOINTS = 0, so under this rule EVERY row it
 * sends is missing work. The two "not missing" lines above are for rows that
 * arrive some other way -- a future query, a hand-run writer -- and must not
 * reach a child as work they owe. Nothing is guessed about them.
 *
 * WHAT "EXACTLY 0" MEANS:
 *
 *   - The number zero (0 or -0). 0.5 is above zero and is not.
 *
 *   - pointsPossible plays no part. A recorded 0 is the teacher's entry
 *     whether the work is worth 10, worth nothing, or has no point value on
 *     file, and dividing by it to get "0%" would make the last two
 *     undecidable for no gain.
 *
 *   - NO SCORE IS NOT ZERO. An unscored, unticked assignment may be ungraded
 *     yet, excused, or not collected; telling a child they owe it is worse
 *     than saying nothing. The query excludes it for the same reason (NULL = 0
 *     is NULL in Oracle).
 *
 *   - A negative score is not zero either, and falls to the box.
 *
 *   - isMissing ABSENT reads as ticked: rows written by plugin 1.3.x carry no
 *     such column, and that query returned ticked work only.
 */

/** The fields this rule reads. Every psMissingWork row has this shape. */
export type MissingWorkFields = {
  isMissing?: boolean | null;
  scorePoints?: number | null;
};

/** Did a teacher tick PowerSchool's Missing box? Absent reads as ticked. */
export function teacherMarkedMissing(row: MissingWorkFields): boolean {
  return row.isMissing !== false;
}

/** Is the recorded score exactly zero? No score is not zero. */
export function scoredExactlyZero(scorePoints: unknown): boolean {
  return typeof scorePoints === "number" && scorePoints === 0;
}

/**
 * THE RULE. Missing when the box is ticked, at any score including none, or
 * when the score is exactly zero, ticked or not.
 */
export function isMissingWork(row: MissingWorkFields): boolean {
  return teacherMarkedMissing(row) || scoredExactlyZero(row.scorePoints);
}

/** The rows that are missing work, in their original order, same objects. */
export function onlyMissingWork<T extends MissingWorkFields>(rows: readonly T[]): T[] {
  return rows.filter(isMissingWork);
}

/**
 * Missing ONLY because the box is still ticked: there is a score above zero
 * on it. Missing by the rule "until the teacher removes the designation", so
 * staff screens name it -- it is the row a teacher can clear in PowerSchool.
 */
export function markedMissingButScored(row: MissingWorkFields): boolean {
  const p = row.scorePoints;
  return teacherMarkedMissing(row) && typeof p === "number" && Number.isFinite(p) && p > 0;
}
