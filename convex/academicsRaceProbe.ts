import { internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { reportedCategories } from "./raceRollup";

/**
 * Would a race breakdown of academics survive suppression, and would it say
 * anything? Counts only. No student number, no name, no individual anywhere.
 *
 * The question is not whether the data exists -- it does -- but whether the
 * cells are big enough to report. disciplineAggregates.ts withholds any group
 * with fewer than SMALL_GROUP = 10 ENROLLED students, and the equity review
 * added a second requirement this probe also measures: a small NUMERATOR must
 * be withheld too, because academics failure counts are dense where discipline
 * referral counts were scarce.
 *
 * Categories come from reportedCategories, not from raceCodes directly:
 * Hispanic or Latino collapses to one category because ethnicity wins, and a
 * non-Hispanic student with two race codes counts under BOTH. So these rows do
 * NOT sum to 618, which is deliberate and is also what makes race partly
 * self-protecting against the subtraction attack that defeats a partitioning
 * cut like English-learner status.
 */
const SMALL_GROUP = 10;
const MIN_CELL_COUNT = 10;

export const cellSizes = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const restricted = await ctx.db.query("psRestricted").collect();
    // PAGED. .take(4000) covered only 72% of the 5,562 grade rows, and a
    // partial scan of children's outcomes by race is exactly the number not to
    // quote. The caller accumulates across pages.
    const page = await ctx.db.query("psGrades").paginate({
      cursor: cursor ?? null, numItems: 1000,
    });
    const grades = page.page;

    // studentNumber -> reporting categories
    const cats = new Map<string, string[]>();
    for (const r of restricted as any[]) {
      const n = String(r.studentNumber ?? "");
      if (!n) continue;
      cats.set(n, reportedCategories(r as any).categories);
    }

    // studentNumber -> { graded, df }
    const perStudent = new Map<string, { graded: number; df: number }>();
    for (const g of grades as any[]) {
      const n = String(g.studentNumber ?? "");
      if (!n) continue;
      const L = typeof g.currentGrade === "string" ? g.currentGrade.trim() : "";
      if (!L || L === "--" || L === "P" || L === "NP") continue;
      const e = perStudent.get(n) ?? { graded: 0, df: 0 };
      e.graded++;
      if (L === "D" || L === "F") e.df++;
      perStudent.set(n, e);
    }

    const byCat: Record<string, { students: number; withGrades: number; failingStudents: number }> = {};
    for (const [num, list] of cats) {
      for (const c of list) {
        const e = byCat[c] ?? { students: 0, withGrades: 0, failingStudents: 0 };
        e.students++;
        const p = perStudent.get(num);
        if (p && p.graded > 0) {
          e.withGrades++;
          if (p.df > 0) e.failingStudents++;
        }
        byCat[c] = e;
      }
    }

    const rows = Object.entries(byCat)
      .map(([category, v]) => ({
        category,
        ...v,
        clearsPrivacyFloor: v.students >= SMALL_GROUP,
        numeratorReportable: v.failingStudents >= MIN_CELL_COUNT,
        // Reported ONLY when both hold. Anything else is a cell that either
        // identifies a child or is a ratio over too few of them.
        reportable: v.students >= SMALL_GROUP && v.failingStudents >= MIN_CELL_COUNT,
      }))
      .sort((a, b) => b.students - a.students);

    return {
      studentsWithRaceOnFile: cats.size,
      gradeRowsScanned: grades.length,
      perStudent: [...perStudent.entries()].map(([n, v]) => [n, v.graded, v.df]),
      catsOf: [...cats.entries()].map(([n, list]) => [n, list]),
      categories: rows,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});
