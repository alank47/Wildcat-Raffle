import type { QueryCtx } from "./_generated/server";
import { activeGradeScope, GRADE_SCOPES } from "./accessRules";

/**
 * The students a teacher's grade scope adds, as student NUMBERS, for the
 * roster payload (views_app teacherRoster / teacherRosterFor).
 *
 * Returns null for every teacher without a scope -- zero extra reads for them.
 * With one, reads psRoster by_gradeLevel for each grade in the scope (about
 * 3,000 rows for grades 6-8, measured 2026-09-29: 337 students) and returns
 * the distinct student numbers. No `students` reads: the browser already has
 * names and balances from appData.load, and it compares NUMBERS, so it never
 * has to parse a grade ("10" sorting below "8" is not a bug it can have).
 */
export async function readGradeScopeBlock(
  ctx: QueryCtx,
  row: { role?: unknown; gradeScope?: unknown } | null | undefined,
) {
  const key = activeGradeScope(row);
  if (!key) return null;
  const scope = GRADE_SCOPES[key];
  const numbers = new Set<string>();
  for (const grade of scope.grades) {
    const rows = await ctx.db
      .query("psRoster")
      .withIndex("by_gradeLevel", (q) => q.eq("gradeLevel", grade))
      .collect();
    for (const r of rows) {
      const n = String(r.studentNumber ?? "").trim();
      if (n) numbers.add(n);
    }
  }
  const studentNumbers = [...numbers].sort();
  return {
    key,
    label: scope.label,
    grades: [...scope.grades],
    studentNumbers,
    studentCount: studentNumbers.length,
  };
}
