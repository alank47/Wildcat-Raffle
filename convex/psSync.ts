import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { normalizeEmail } from "./identityRules";

/**
 * Ingest for the PowerSchool roster.
 *
 * `internalMutation`, not `mutation`: this is reachable only from the sync
 * harness holding a deploy key, never from a browser. The roster is upstream
 * truth and nothing signed in from a Chromebook should be able to rewrite it.
 *
 * THE ONE THING THAT MATTERS HERE: emails are normalized on the way in.
 * Sign-in matches the token claim (lowercased) against these columns. If a raw
 * `First.Last@lapromisefund.org` from PowerSchool is stored as-is, the index
 * lookup misses, the user is told they have no record, and nothing in the logs
 * says why. Normalizing at write time and at read time is what prevents that.
 */
export const upsertRoster = internalMutation({
  args: {
    syncedAt: v.string(),
    rows: v.array(
      v.object({
        studentNumber: v.string(),
        studentEmail: v.optional(v.string()),
        firstName: v.string(),
        lastName: v.string(),
        gradeLevel: v.optional(v.string()),
        sectionId: v.optional(v.string()),
        sectionNumber: v.optional(v.string()),
        sectionExpression: v.optional(v.string()),
        courseNumber: v.optional(v.string()),
        courseName: v.optional(v.string()),
        period: v.optional(v.string()),
        teacherEmail: v.optional(v.string()),
        teacherFirstName: v.optional(v.string()),
        teacherLastName: v.optional(v.string()),
        teacherNumber: v.optional(v.string()),
        termId: v.optional(v.string()),
        termAbbreviation: v.optional(v.string()),
        schoolId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { rows, syncedAt }) => {
    let inserted = 0;
    let missingStudentEmail = 0;
    let missingTeacherEmail = 0;

    for (const row of rows) {
      // Empty string is not a valid key and must not become one: an index entry
      // of "" would match every record whose email is also blank.
      const studentEmail = normalizeEmail(row.studentEmail) || undefined;
      const teacherEmail = normalizeEmail(row.teacherEmail) || undefined;
      if (!studentEmail) missingStudentEmail++;
      if (!teacherEmail) missingTeacherEmail++;

      await ctx.db.insert("psRoster", {
        ...row,
        studentEmail,
        teacherEmail,
        syncedAt,
      });
      inserted++;
    }

    // Returned rather than logged. These counts are the health signal for the
    // whole identity join: if missingStudentEmail equals the row count, manifest
    // field 19 has not landed and no student can sign in yet. Counts only, never
    // addresses, because this is student PII.
    return { inserted, missingStudentEmail, missingTeacherEmail };
  },
});

/**
 * Clears the roster. The sync is a full replace rather than a diff, because a
 * student who drops a class must disappear from their teacher's roster, and a
 * merge cannot express a deletion. Call immediately before upsertRoster in the
 * same sync run.
 */
/**
 * Delete a BATCH of roster rows, and say whether more remain.
 *
 * It used to collect() the whole table and delete it in one execution. That
 * worked at 3,805 rows and broke at 5,812, because Convex allows 4,096 reads
 * per function execution and collect() reads every row.
 *
 * The failure mode is what makes this worth the comment: syncFromPowerSchool
 * records a run only on success, so a throw here writes no syncRuns row at all.
 * The dashboard keeps showing the last good timestamp and looks healthy while
 * the roster silently stops updating. It broke the moment the COURSES join fix
 * pushed the row count past the limit, which is to say a correctness fix
 * created a capacity bug two layers away.
 *
 * The caller loops until `remaining` is 0. Batched rather than paginated with a
 * cursor because each call is its own transaction, so a cursor from the
 * previous one would point into a table that has already changed.
 */
export const clearRoster = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    // Well under the 4,096 read ceiling, leaving room for the delete writes and
    // anything else in the same execution.
    const batch = Math.min(limit ?? 2000, 3000);

    const rows = await ctx.db.query("psRoster").take(batch);
    for (const row of rows) await ctx.db.delete(row._id);

    // One extra read to answer "is there more", rather than assuming a short
    // batch means empty. A short batch can also mean a concurrent write.
    const more = await ctx.db.query("psRoster").take(1);
    return { deleted: rows.length, remaining: more.length > 0 ? "some" : "none" };
  },
});
