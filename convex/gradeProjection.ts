/**
 * What handing in missing work would do to a grade.
 *
 * Pure. No database, no clock. The rule lives here so it can be tested against
 * the cases that matter, because being wrong about a child's grade is worse
 * than saying nothing.
 *
 * THE PROBLEM THIS SOLVES WITHOUT CATEGORY WEIGHTS.
 *
 * A weighted gradebook cannot be projected from point totals: a missing
 * summative in a 70% category and a missing homework in a 10% one move the
 * grade by wildly different amounts. This PowerSchool instance exposes no
 * weight column under any spelling probed, so for a weighted section the
 * honest answer is "we cannot tell you".
 *
 * The trick is that we do not have to be told which sections are weighted. We
 * can work it out. PGFinalGrades already posts the real percent. Compute the
 * total-points percent from earned/possible and compare:
 *
 *   they agree    the section grades by total points, and
 *                 (earned + p) / possible is exact arithmetic
 *   they differ   something else is happening -- weights, drops, curves --
 *                 and the projection would be a guess
 *
 * So the model is validated against PowerSchool's own answer before it is
 * trusted, per student per section, on every sync. A section that starts using
 * weights mid-year stops being projected automatically.
 */

/** How far the computed percent may sit from the posted one and still agree. */
export const TOLERANCE_PCT = 0.5;

export type Projection =
  | { canProject: false; reason: string; computedPercent: number | null }
  | {
      canProject: true;
      currentPercent: number;
      projectedPercent: number;
      gainPercent: number;
      pointsAvailable: number;
    };

/**
 * @param postedPercent  what PowerSchool shows now, from PGFinalGrades
 * @param earned         points the student has, summed over counted work
 * @param possible       points that work was worth
 * @param pointsAvailable what the missing work could still add
 */
export function projectGrade(
  postedPercent: number | null | undefined,
  earned: number | null | undefined,
  possible: number | null | undefined,
  pointsAvailable: number,
): Projection {
  const e = typeof earned === "number" ? earned : null;
  const p = typeof possible === "number" ? possible : null;

  if (e === null || p === null || p <= 0) {
    return {
      canProject: false,
      computedPercent: null,
      reason: "This class has no graded work totals yet.",
    };
  }

  const computed = (e / p) * 100;

  if (typeof postedPercent !== "number") {
    // Nothing to check the model against. Refusing here rather than trusting
    // the arithmetic is the whole point: an unposted grade is exactly when a
    // wrong projection would go unnoticed.
    return {
      canProject: false,
      computedPercent: computed,
      reason: "No posted grade to check against yet.",
    };
  }

  if (Math.abs(computed - postedPercent) > TOLERANCE_PCT) {
    return {
      canProject: false,
      computedPercent: computed,
      reason:
        "This class weights categories differently, so we cannot predict the " +
        "change. Handing the work in still helps.",
    };
  }

  if (pointsAvailable <= 0) {
    return {
      canProject: false,
      computedPercent: computed,
      reason: "Nothing outstanding to add.",
    };
  }

  // The ceiling: every outstanding point earned. The denominator does not grow,
  // because the work is already counted in `possible` -- it is sitting there as
  // a zero. Adding it to both sides would understate the gain.
  const projected = ((e + pointsAvailable) / p) * 100;

  return {
    canProject: true,
    currentPercent: round1(postedPercent),
    projectedPercent: round1(Math.min(projected, 100)),
    gainPercent: round1(Math.min(projected, 100) - postedPercent),
    pointsAvailable,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
