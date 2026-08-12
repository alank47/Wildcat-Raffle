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
export const clearRoster = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("psRoster").collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return { deleted: rows.length };
  },
});
