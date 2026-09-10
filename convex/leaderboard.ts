import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireStudentSelf } from "./identity";
import { cashLeaderboard, LEADERBOARD_BANDS, studentIdOf } from "./leaderboardRules";

/**
 * The Wildcat Cash board a student sees on their portal.
 *
 * STUDENTS ONLY, resolved from their own token. requireStudentSelf refuses
 * staff, refuses an unknown address and refuses a student who has left, and it
 * returns the record itself -- so the viewer is never an argument this function
 * accepts. If the caller could name whose rank to look up, they could name
 * anyone's.
 *
 * WHAT LEAVES THE SERVER: the top ten with names, plus the caller's own place.
 * Nothing else. Every other child's earnings stay here, which is what makes
 * this a leaderboard rather than a list of who has the least.
 *
 * The whole students table is read: 757 rows, 0.51 MB measured on 2026-09-10,
 * against limits of 4,096 documents and 16 MiB. There is room, and the numbers
 * are written down so the next person can tell whether there still is.
 */
export const cash = query({
  args: {
    band: v.optional(v.string()),
    topN: v.optional(v.number()),
  },
  handler: async (ctx, { band, topN }) => {
    const me = await requireStudentSelf(ctx);

    const students = await ctx.db.query("students").collect();

    const result = cashLeaderboard({
      students: students as any[],
      band,
      topN: topN ?? 10,
      // Resolved through the SAME helper the ranking uses, so the viewer is
      // compared against the identity every ranked row carries.
      viewerId: studentIdOf(me as any),
    });

    return {
      ...result,
      bands: Object.values(LEADERBOARD_BANDS).map((b) => ({ key: b.key, label: b.label })),
    };
  },
});
