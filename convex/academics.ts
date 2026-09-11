import { query } from "./_generated/server";
import { requireStaff } from "./identity";
import { reportedCategories } from "./raceRollup";
import { markOf, cellOf, wilson95, intervalsSeparate } from "./academicsRules";

/**
 * Academics: the school's grades, aggregated, and never a child.
 *
 * ADMIN AND SUPERADMIN ONLY. Narrower than the discipline aggregates, which
 * PBIS may also read. The reason is not that grades are more sensitive than
 * discipline -- they are not -- but that this is a NEW purpose and the house
 * rule, stated at wildcat-modes.js:64-68, is against granting by adjacency. If
 * the school decides PBIS should have it, that is a decision to record, not one
 * to inherit.
 *
 * COUNTS LEAVE THIS FUNCTION. ROWS DO NOT. Same property disciplineAggregates
 * and leaderboard already hold: a cell small enough to identify a child never
 * crosses the wire, so "aggregate only" is a fact about the response and not a
 * claim about the interface.
 *
 * RACE IS COMPUTED AT SCHOOL SCOPE ONLY, with no High School / Middle School
 * split, and that is a privacy rule rather than a missing feature. The bands
 * partition the school exactly, so publishing a total alongside two halves lets
 * a withheld cell be recovered by subtraction. Race categories overlap -- a
 * non-Hispanic student with two codes counts under both -- which makes them
 * partly self-protecting, but only while the cut is not also split.
 *
 * COST. psGrades is 5,562 rows and psRestricted 618, so ~6,180 documents -- past
 * the 4,096-per-execution limit for two .collect() calls, which is why the
 * grades side is paged internally and the join is built as a map rather than a
 * per-student lookup. Measured on 2026-09-10; if enrolment grows materially this
 * needs to become a precomputed rollup.
 */
const ACADEMICS_ROLES = ["admin", "superadmin"];

export const raceBreakdown = query({
  args: {},
  handler: async (ctx) => {
    const staff = await requireStaff(ctx);
    if (!ACADEMICS_ROLES.includes(staff.role)) {
      return {
        allowed: false,
        reason:
          "Academics is limited to administrators. Ask an administrator to " +
          "change your access level if you need it.",
        cells: [],
      };
    }

    // ---- grades, paged, reduced to one row per student as we go -------------
    //
    // Reduced during the walk rather than collected: holding 5,562 rows to
    // group them afterwards is the same bytes for no benefit, and this function
    // already sits close to the per-execution ceiling.
    const perStudent = new Map<string, { marks: number; failing: number }>();
    let rows = 0;
    let markedRows = 0;
    // .collect(), NOT a paginate loop. Convex allows exactly ONE paginated
    // query per function execution, so looping paginate throws
    // "ran multiple paginated queries" -- caught here before any screen
    // existed. 5,562 grade rows plus 618 restricted rows is ~6,180 documents in
    // one execution, which is the same order as leaderboard:cash's measured
    // 1,514 and well inside what this deployment has been shown to serve
    // (6,319 documents, measured 2026-09-10). If enrolment grows materially
    // this becomes a precomputed rollup rather than a bigger read.
    {
      const all = await ctx.db.query("psGrades").collect();
      for (const g of all) {
        rows++;
        const mark = markOf(g.currentGrade);
        // Only A-F rows can contribute a D or an F. P/NP and "--" are counted
        // as coverage but never as a denominator for a D/F rate: a pass-fail
        // course has no D to give, and folding it in dilutes the rate with
        // enrolments that could never have produced one.
        if (mark.kind === "grade" || mark.kind === "passfail") markedRows++;
        if (mark.kind !== "grade" && mark.kind !== "passfail") continue;
        const n = String(g.studentNumber ?? "");
        if (!n) continue;
        const e = perStudent.get(n) ?? { marks: 0, failing: 0 };
        if (mark.kind === "grade") e.marks++;
        if (mark.failing) e.failing++;
        perStudent.set(n, e);
      }
    }

    // ---- race, from the rollup that already knows the rules -----------------
    const restricted = await ctx.db.query("psRestricted").collect();

    const byCategory = new Map<string, { students: number; withMarks: number; failing: number }>();
    let studentsOnFile = 0;
    for (const r of restricted) {
      const n = String(r.studentNumber ?? "");
      if (!n) continue;
      studentsOnFile++;
      const p = perStudent.get(n);
      for (const cat of reportedCategories(r as any).categories) {
        const e = byCategory.get(cat) ?? { students: 0, withMarks: 0, failing: 0 };
        e.students++;
        if (p && p.marks > 0) {
          e.withMarks++;
          if (p.failing > 0) e.failing++;
        }
        byCategory.set(cat, e);
      }
    }

    const cells = [...byCategory.entries()]
      .map(([label, v]) =>
        cellOf({
          label,
          students: v.students,
          studentsWithMarks: v.withMarks,
          failingStudents: v.failing,
        }),
      )
      .map((c) => ({
        ...c,
        interval:
          c.failingStudents !== null && c.studentsWithMarks !== null
            ? wilson95(c.failingStudents, c.studentsWithMarks)
            : null,
      }))
      // Biggest first, and a withheld cell still holds its place in the list so
      // a reader can see the group exists.
      .sort((a, b) => (b.students ?? 0) - (a.students ?? 0));

    // Whether ANY pair actually separates. Almost always false at this school,
    // and saying so on the screen is the difference between "no gap" and "no
    // gap this study could see".
    const reportable = cells.filter((c) => c.withheld === null);
    let anySeparate = false;
    for (let i = 0; i < reportable.length; i++) {
      for (let j = i + 1; j < reportable.length; j++) {
        if (intervalsSeparate(reportable[i] as any, reportable[j] as any)) anySeparate = true;
      }
    }

    const withMarks = [...perStudent.values()].filter((p) => p.marks > 0).length;
    const failingAny = [...perStudent.values()].filter((p) => p.failing > 0).length;

    return {
      allowed: true,
      school: {
        studentsOnFile,
        studentsWithMarks: withMarks,
        studentsFailingAny: failingAny,
        rows,
        markedRows,
        coverage: rows > 0 ? markedRows / rows : null,
      },
      cells,
      reportableCount: reportable.length,
      totalCategories: cells.length,
      anySeparate,
    };
  },
});
