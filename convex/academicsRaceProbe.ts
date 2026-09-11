import { internalQuery } from "./_generated/server";
import { reportedCategories } from "./raceRollup";
import { markOf, cellOf, wilson95, intervalsSeparate } from "./academicsRules";

/**
 * The same reduction academics:raceBreakdown performs, reachable from the CLI.
 *
 * EXISTS BECAUSE THE REAL QUERY IS STAFF-GATED and cannot be called without a
 * signed-in administrator, so there would otherwise be no way to check what it
 * returns against production before showing it to anyone. It imports the same
 * rules rather than restating them; if these two ever disagree it is because
 * someone changed one and not the other, which is exactly what it is for.
 *
 * Counts only. No student number, no name, no individual leaves this function.
 */
export const mirror = internalQuery({
  args: {},
  handler: async (ctx) => {
    const perStudent = new Map<string, { marks: number; failing: number }>();
    let rows = 0, markedRows = 0;
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

    const restricted = await ctx.db.query("psRestricted").collect();
    const byCategory = new Map<string, { students: number; withMarks: number; failing: number }>();
    for (const r of restricted) {
      const n = String(r.studentNumber ?? "");
      if (!n) continue;
      const p = perStudent.get(n);
      for (const cat of reportedCategories(r as any).categories) {
        const e = byCategory.get(cat) ?? { students: 0, withMarks: 0, failing: 0 };
        e.students++;
        if (p && p.marks > 0) { e.withMarks++; if (p.failing > 0) e.failing++; }
        byCategory.set(cat, e);
      }
    }

    const cells = [...byCategory.entries()]
      .map(([label, v]) => cellOf({
        label, students: v.students, studentsWithMarks: v.withMarks, failingStudents: v.failing,
      }))
      .map((c) => ({
        ...c,
        interval: c.failingStudents !== null && c.studentsWithMarks !== null
          ? wilson95(c.failingStudents, c.studentsWithMarks) : null,
      }))
      .sort((a, b) => (b.students ?? 0) - (a.students ?? 0));

    const reportable = cells.filter((c) => c.withheld === null);
    let anySeparate = false;
    for (let i = 0; i < reportable.length; i++)
      for (let j = i + 1; j < reportable.length; j++)
        if (intervalsSeparate(reportable[i] as any, reportable[j] as any)) anySeparate = true;

    return {
      documentsRead: rows + restricted.length,
      school: {
        studentsWithMarks: [...perStudent.values()].filter((p) => p.marks > 0).length,
        studentsFailingAny: [...perStudent.values()].filter((p) => p.failing > 0).length,
        rows, markedRows, coverage: rows > 0 ? markedRows / rows : null,
      },
      cells, reportableCount: reportable.length, totalCategories: cells.length, anySeparate,
    };
  },
});
