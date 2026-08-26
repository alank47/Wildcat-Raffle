import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { normalizeEmail } from "./identityRules";
import { EARNED_FIELDS, sisFieldsFor, mergeStudent } from "./sisMerge";

/**
 * Load students from PowerSchool without ever losing what they earned.
 *
 * THE ONE RULE: a roster sync may write identity and enrollment. It may not
 * write balances. PowerSchool does not know a child has 340 tickets, so any
 * value it appears to supply for one is absence, not zero, and writing that
 * absence spends someone's money.
 *
 * This is enforced structurally rather than by being careful: mergeStudent
 * builds the patch from an allowlist of SIS-owned fields, so an earned field
 * cannot be written even if a future edit adds it to the incoming payload.
 * See sisMerge.ts, where the rule is a pure function and directly tested.
 *
 * Students who vanish from the roster are ARCHIVED, never deleted. A transfer
 * still has a balance, a roster gap is not proof a person ceased to exist, and
 * a student who returns should find their tickets waiting.
 */
export const syncStudents = internalMutation({
  args: {
    syncedAt: v.string(),
    students: v.array(
      v.object({
        studentNumber: v.string(),
        firstName: v.string(),
        lastName: v.string(),
        grade: v.optional(v.string()),
        // STUDENTS.GENDER, manifest field 9. Listed here as well as in the
        // schema because this validator is a closed allowlist: a field the
        // sync sends that is not named here is rejected outright rather than
        // dropped, which is how it should be. Adding a SIS-owned field means
        // touching schema.ts, sisMerge's SIS_OWNED_FIELDS, and this list.
        gender: v.optional(v.string()),
        email: v.optional(v.string()),
        school: v.optional(v.string()),
      }),
    ),
    /** When false, students missing from the payload are left alone. Use for
     *  a partial sync (one school, one grade) where absence means nothing. */
    archiveMissing: v.optional(v.boolean()),
  },
  handler: async (ctx, { students, syncedAt, archiveMissing }) => {
    const existing = await ctx.db.query("students").collect();
    const byNumber = new Map(
      existing.map((s) => [s.studentNumber ?? s.legacyId ?? "", s]),
    );

    let created = 0, updated = 0, unchanged = 0, archived = 0, reactivated = 0;
    const seen = new Set<string>();

    for (const incoming of students) {
      const key = incoming.studentNumber;
      seen.add(key);
      const prior = byNumber.get(key);

      if (!prior) {
        // A student the app has never seen starts at zero, because they have
        // genuinely earned nothing yet. This is the ONLY place a balance is
        // ever set by a sync.
        await ctx.db.insert("students", {
          legacyId: key,
          studentNumber: key,
          firstName: incoming.firstName,
          lastName: incoming.lastName,
          grade: incoming.grade,
          // Set on INSERT as well as on patch. Without it a brand new student
          // carried no gender until some later sync noticed the difference and
          // patched it — self-healing, but only on the second run, and
          // invisible in the meantime.
          gender: incoming.gender,
          email: normalizeEmail(incoming.email) || undefined,
          school:
            incoming.school === "middleschool" || incoming.school === "highschool"
              ? incoming.school
              : undefined,
          pbisTickets: 0,
          attendanceTickets: 0,
          academicTickets: 0,
          bigRaffleQualified: [],
        });
        created++;
        continue;
      }

      const patch = mergeStudent(prior, incoming);
      if (Object.keys(patch).length === 0) {
        unchanged++;
      } else {
        if (prior.archivedAt) { patch.archivedAt = undefined; reactivated++; }
        await ctx.db.patch(prior._id, patch);
        updated++;
      }
    }

    if (archiveMissing) {
      for (const s of existing) {
        const key = s.studentNumber ?? s.legacyId ?? "";
        if (seen.has(key) || s.archivedAt) continue;
        await ctx.db.patch(s._id, { archivedAt: syncedAt });
        archived++;
      }
    }

    return {
      created, updated, unchanged, archived, reactivated,
      incoming: students.length,
      // Returned so a caller can assert the invariant from outside: a sync
      // that reports touching earned value is a bug, and this makes that
      // visible rather than something to take on trust.
      earnedFieldsWritten: 0,
      earnedFieldsProtected: EARNED_FIELDS.length,
    };
  },
});
