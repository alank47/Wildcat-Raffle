import { query } from "./_generated/server";
import { requireStudentSelf } from "./identity";
import { elapsedMinutes, isOverdue } from "./hallPassRules";

/**
 * Everything the student pass cards need, for the signed-in student only.
 *
 * NO ARGUMENTS. The student is whoever the verified Google token says they are.
 * A function that takes a student id and trusts it is a function that reads any
 * child's record, and a pass card is exactly the screen somebody would try that
 * on.
 *
 * WHAT IS MISSING IS RETURNED AS MISSING, with the reason. A card that renders
 * a blank barcode looks broken; a card that says "your lunch number is not
 * available yet" is a fact a student can act on, and it tells the office what
 * to fix.
 */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const student = await requireStudentSelf(ctx);
    const now = new Date().toISOString();

    const passes = await ctx.db
      .query("hallPasses")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .collect();

    const live = passes.find(
      (p) => !["returned", "denied", "cancelled", "expired"].includes(p.state),
    );

    return {
      student: {
        firstName: student.firstName,
        lastName: student.lastName,
        grade: student.grade,
        studentNumber: student.studentNumber ?? null,
        email: student.email ?? null,
      },

      // Card 1. The student number is the barcode payload. It exists for every
      // enrolled student and is what most scanners here already expect.
      studentId: {
        available: Boolean(student.studentNumber),
        value: student.studentNumber ?? null,
        format: "code128",
      },

      // Card 2. A DIFFERENT number from the student number, used by nutrition
      // services. STUDENTS.LUNCH_ID exists on the instance and answered 403, so
      // it is one field line in the next access request away, not missing.
      lunchId: {
        available: false,
        value: null,
        format: "code128",
        reason:
          "Lunch numbers are not synced yet. The field exists in PowerSchool " +
          "and needs one line added to the plugin's access request.",
      },

      // Card 3. Clever badges are QR codes, but whether this district issues a
      // static per-student badge or a rotating one decides whether a payload may
      // be stored at all. Unanswered, so nothing is invented.
      cleverBadge: {
        available: false,
        value: null,
        format: "qr",
        reason:
          "Clever badge sign in is not connected yet. Whether the badge is " +
          "static or rotating decides how it can be shown.",
      },

      // Card 4. The live one.
      hallPass: live
        ? {
            available: true,
            id: live._id,
            state: live.state,
            elapsedMinutes: elapsedMinutes(live as any, now),
            overdue: isOverdue(live as any, now),
            expiresAfterMinutes: live.expiresAfterMinutes,
          }
        : { available: false, state: "none" },

      serverTime: now,
    };
  },
});
