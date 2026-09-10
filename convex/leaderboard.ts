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
 * COST, measured 2026-09-10: 757 student rows plus one indexed psRoster lookup
 * each, about 1,514 documents and well under a megabyte. Written down so the
 * next person can tell whether there still is room -- this runs every time a
 * student opens their portal.
 */
export const cash = query({
  args: {
    band: v.optional(v.string()),
    topN: v.optional(v.number()),
  },
  handler: async (ctx, { band, topN }) => {
    const me = await requireStudentSelf(ctx);

    // ENROLMENT IS DERIVED, NOT STORED, and reading the students table alone
    // got this wrong on the first attempt.
    //
    // No student row carries an `enrolled` field -- all 757 have it undefined.
    // appData.ts computes it: a student is enrolled if their studentNumber
    // appears in psRoster, which is replaced wholesale on every SIS sync. So
    // `enrolled !== false` passed every record, and the board ranked 757
    // students including 139 who have left the school. Former students on a
    // board their old classmates can read is not a cosmetic mistake.
    //
    // The same DEFINITION as appData.ts, deliberately: two definitions of
    // "enrolled" is how the dashboard and the leaderboard come to disagree,
    // which is exactly how this was noticed.
    //
    // A DIFFERENT METHOD, though, because the two need different things.
    // appData collects all 5,564 psRoster rows because it uses them; this only
    // needs to know whether a row EXISTS for each student. Scanning the table
    // to answer that read 6,319 documents on every portal load. One indexed
    // lookup per student answers the same question in 1,514 -- measured, both
    // returning 618. Four times cheaper, on a query that runs every time a
    // child opens their page.
    const rows = await ctx.db.query("students").collect();
    const students: any[] = [];
    for (const row of rows) {
      const hit = row.studentNumber
        ? await ctx.db
            .query("psRoster")
            .withIndex("by_studentNumber", (q) => q.eq("studentNumber", row.studentNumber!))
            .first()
        : null;
      students.push({ ...row, enrolled: Boolean(hit) });
    }

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
