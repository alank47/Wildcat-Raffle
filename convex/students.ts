import { query } from "./_generated/server";
import { requireStudentSelf, requireStaff } from "./identity";

/**
 * What a signed-in student can see: their own totals, and nothing else.
 *
 * Note there is no `studentId` argument. That is the point. If the caller could
 * name a student, they could name any student, and we would be back to the
 * current situation where typing a name is enough to become that person. The
 * only student this can return is the one the Google token proves you are.
 *
 * This is the query the sign-in button calls. See docs/google-signin-setup.md.
 */
export const getMine = query({
  args: {},
  handler: async (ctx) => {
    const student = await requireStudentSelf(ctx);

    // Explicit field list, not the whole row. The record will eventually carry
    // PowerSchool fields including restricted ones (IEP, 504, English Learner,
    // federal race and ethnicity), and a student response must never widen to
    // include them just because someone added a column upstream.
    return {
      firstName: student.firstName,
      lastName: student.lastName,
      grade: student.grade,
      pbisTickets: student.pbisTickets,
      attendanceTickets: student.attendanceTickets,
      academicTickets: student.academicTickets,
      totalTickets:
        student.pbisTickets + student.attendanceTickets + student.academicTickets,
      bigRaffleQualified: student.bigRaffleQualified,
    };
  },
});

/**
 * Roster for staff. Deliberately separate from getMine rather than one function
 * that branches on role: a single function that returns "your record or everyone
 * depending on who you are" is one bad condition away from leaking the roster.
 */
export const listForStaff = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    const students = await ctx.db.query("students").collect();
    return students.map((s) => ({
      _id: s._id,
      firstName: s.firstName,
      lastName: s.lastName,
      grade: s.grade,
      school: s.school,
      pbisTickets: s.pbisTickets,
      attendanceTickets: s.attendanceTickets,
      academicTickets: s.academicTickets,
    }));
  },
});
