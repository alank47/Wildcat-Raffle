import { internalQuery } from "./_generated/server";

/**
 * Each student's enrolled period slots, from psAttendanceBySection.
 *
 * SEPARATE FILE because attendanceDays.ts is "use node" for Buffer, and a
 * Convex query cannot live in a Node action module. Read here rather than
 * pulled from PowerSchool again: the app already syncs this table, and a
 * second source for the same fact is a second thing to drift.
 *
 * PAGED, never collect(): ~5,563 rows against Convex's 4,096 reads per call is
 * the exact shape that broke the grade sync.
 */
export const enrolledSlots = internalQuery({
  args: {},
  handler: async (ctx): Promise<Record<string, string[]>> => {
    const out: Record<string, string[]> = {};
    let after = "";
    for (let page = 0; page < 20; page++) {
      const rows = await ctx.db
        .query("psAttendanceBySection")
        .withIndex("by_studentNumber", (q) => q.gt("studentNumber", after))
        .take(2000);
      if (!rows.length) break;
      for (const r of rows) {
        const n = String(r.studentNumber || "");
        const e = String(r.sectionExpression || "").trim();
        if (!n || !e) continue;
        if (!out[n]) out[n] = [];
        if (out[n].indexOf(e) === -1) out[n].push(e);
      }
      const last = String(rows[rows.length - 1].studentNumber || "");
      if (!last || last === after) break;
      after = last;
      if (rows.length < 2000) break;
    }
    return out;
  },
});

/**
 * Name and grade for every student, keyed by student number.
 *
 * SNAPSHOTTED ONTO psAttendanceMarks by the rebuild, so that the perfect
 * attendance screen is ONE indexed table read instead of a roster join at
 * query time. `students` rather than `psRoster` because psRoster holds a row
 * per student-per-section -- 5,563 of them -- and this needs one per student.
 *
 * PAGED for the same reason as its neighbour above: collect() on a table that
 * grows with the school is the shape that broke clearRoster.
 */
export const studentNames = internalQuery({
  args: {},
  handler: async (ctx): Promise<Record<string, { firstName: string; lastName: string; grade: string }>> => {
    const out: Record<string, { firstName: string; lastName: string; grade: string }> = {};
    let after = "";
    for (let page = 0; page < 20; page++) {
      const rows = await ctx.db
        .query("students")
        .withIndex("by_studentNumber", (q) => q.gt("studentNumber", after))
        .take(1000);
      if (!rows.length) break;
      for (const r of rows) {
        const n = String(r.studentNumber || "").trim();
        if (!n) continue;
        // An archived student is off the roster and cannot win an award.
        if (r.archivedAt) continue;
        out[n] = {
          firstName: String(r.firstName || ""),
          lastName: String(r.lastName || ""),
          grade: String(r.grade || ""),
        };
      }
      const last = String(rows[rows.length - 1].studentNumber || "");
      if (!last || last === after) break;
      after = last;
      if (rows.length < 1000) break;
    }
    return out;
  },
});
