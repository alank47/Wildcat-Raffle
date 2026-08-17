import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * Meal card number seeding.
 *
 * The Westbrook ID card ("Westbrook ID 26-27") prints a 4-digit ID that the
 * cafeteria register reads. It is NOT the PowerSchool student_number that Convex
 * stores in students.studentNumber (those are 5-digit here), so the card number
 * cannot be derived from the record — the two are only bridged by the student's
 * name + grade. The match is therefore done OFF-SERVER against `rosterForMatch`,
 * reviewed, and only the confident pairs are written back through `setMealPins`,
 * keyed by studentNumber. No blind name write ever lands on a child's account.
 */

/** A few records with their id fields, to eyeball what number space is stored. */
export const sampleStudentNumbers = internalQuery({
  args: {},
  handler: async (ctx) => {
    const students = await ctx.db.query("students").take(400);
    return {
      totalSampled: students.length,
      withStudentNumber: students.filter((s) => s.studentNumber).length,
      alreadyHaveMealPin: students.filter((s) => s.mealPin).length,
      sample: students.slice(0, 14).map((s) => ({
        studentNumber: s.studentNumber ?? null,
        legacyId: s.legacyId ?? null,
        firstName: s.firstName,
        lastName: s.lastName,
        grade: s.grade ?? null,
        mealPin: s.mealPin ?? null,
      })),
    };
  },
});

/** The whole roster, only the fields needed to match printed cards by name. */
export const rosterForMatch = internalQuery({
  args: {},
  handler: async (ctx) => {
    const students = await ctx.db.query("students").collect();
    return students.map((s) => ({
      studentNumber: s.studentNumber ?? null,
      firstName: s.firstName,
      lastName: s.lastName,
      grade: s.grade ?? null,
      hasMealPin: Boolean(s.mealPin),
    }));
  },
});

/**
 * Write meal PINs from an off-server name match. Each pair is (studentNumber ->
 * mealPin). Matched by studentNumber, which is exact; the risky name step
 * already happened and was reviewed. Skips a pair whose studentNumber resolves
 * to zero or more than one record rather than guessing.
 */
export const setMealPins = internalMutation({
  args: {
    pairs: v.array(
      v.object({ studentNumber: v.string(), mealPin: v.string() }),
    ),
    overwrite: v.optional(v.boolean()),
  },
  handler: async (ctx, { pairs, overwrite }) => {
    let set = 0;
    let skippedNoMatch = 0;
    let skippedAmbiguous = 0;
    let skippedHasPin = 0;
    for (const pair of pairs) {
      const matches = await ctx.db
        .query("students")
        .withIndex("by_studentNumber", (q) =>
          q.eq("studentNumber", pair.studentNumber),
        )
        .take(2);
      if (matches.length === 0) {
        skippedNoMatch++;
        continue;
      }
      if (matches.length > 1) {
        skippedAmbiguous++;
        continue;
      }
      const s = matches[0];
      if (s.mealPin && !overwrite) {
        skippedHasPin++;
        continue;
      }
      await ctx.db.patch(s._id, { mealPin: pair.mealPin });
      set++;
    }
    return {
      requested: pairs.length,
      set,
      skippedNoMatch,
      skippedAmbiguous,
      skippedHasPin,
    };
  },
});
