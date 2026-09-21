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
