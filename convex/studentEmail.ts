import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { normalizeEmail, STUDENT_DOMAINS } from "./identityRules";

/**
 * Write school issued email addresses onto student records.
 *
 * This is the join key for student sign in: Google returns an address and the
 * only way to know whose record it is, is this column. Until it was populated,
 * PowerSchool held 622 addresses and Convex held zero, so student sign in could
 * not have worked no matter how correct the auth rules were.
 *
 * SEPARATE FROM sisSync ON PURPOSE. Identity is not enrollment, it comes from a
 * different query, and mixing it into the roster sync would mean a failure in
 * one silently affects the other.
 *
 * REFUSES ADDRESSES THAT COULD NEVER SIGN IN. A record on a retired domain
 * (rwwnms.org, rwwnhs.org) or a misspelled one is stored as NOTHING rather than
 * stored and rejected later at the sign-in screen. A student whose record holds
 * an address the system will never accept looks like a broken account; a
 * student with no address at all is a known gap with a number attached.
 *
 * NEVER writes an empty string over a present address. The by_email index would
 * then match every student who also has none, and .unique() throws for all of
 * them rather than reporting a clean miss.
 */
export const setStudentEmails = internalMutation({
  args: {
    rows: v.array(
      v.object({
        studentNumber: v.string(),
        email: v.string(),
        isPrimary: v.optional(v.union(v.string(), v.number(), v.null())),
      }),
    ),
  },
  handler: async (ctx, { rows }) => {
    let updated = 0;
    let unchanged = 0;
    let noStudent = 0;
    const refusedDomain: string[] = [];

    // One student can hold several addresses. The query returns them primary
    // first, so the first one seen per student wins and the rest are ignored.
    const seen = new Set<string>();

    for (const row of rows) {
      const number = String(row.studentNumber).trim();
      if (!number || seen.has(number)) continue;

      const email = normalizeEmail(row.email);
      if (!email.includes("@")) continue;

      const domain = email.slice(email.lastIndexOf("@") + 1);
      if (!STUDENT_DOMAINS.some((d) => d === domain)) {
        refusedDomain.push(domain);
        continue;
      }
      seen.add(number);

      const student = await ctx.db
        .query("students")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", number))
        .unique();

      if (!student) {
        noStudent++;
        continue;
      }
      if (student.email === email) {
        unchanged++;
        continue;
      }
      await ctx.db.patch(student._id, { email });
      updated++;
    }

    const all = await ctx.db.query("students").collect();
    return {
      updated,
      unchanged,
      noStudent,
      refusedDomains: [...new Set(refusedDomain)],
      studentsWithEmail: all.filter((s) => (s.email ?? "").includes("@")).length,
      totalStudents: all.length,
    };
  },
});
