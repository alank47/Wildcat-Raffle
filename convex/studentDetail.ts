import { query } from "./_generated/server";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { requireStaff } from "./identity";
import { canViewStudent } from "./accessRules";
import { studentSisView } from "./views";

/**
 * Drill-down on one student: who they are, what they earned, and their SIS
 * schedule.
 *
 * Access follows Grilled.md: classroom teachers see their OWN roster only,
 * administrators see wider scope. "Wider" is deliberately expressed as a role
 * check rather than "everything", so the day the brief enumerates a narrower
 * admin scope there is one place to put it.
 *
 * The roster relationship is derived from psRoster, which is SIS truth, rather
 * than from anything a teacher can edit about themselves.
 */
export const get = query({
  args: { studentNumber: v.string() },
  handler: async (ctx, { studentNumber }) => {
    const teacher = await requireStaff(ctx);

    const student = await ctx.db
      .query("students")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", studentNumber))
      .unique();

    if (!student) throw new ConvexError(`No student with number ${studentNumber}.`);

    // Every roster row for this student, used both for the access decision and
    // for the schedule itself. One read, two purposes.
    const rows = await ctx.db
      .query("psRoster")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", studentNumber))
      .collect();

    const verdict = canViewStudent(
      { email: teacher.email, role: teacher.role },
      rows.map((r) => ({ teacherEmail: r.teacherEmail })),
    );
    if (!verdict.allowed) throw new ConvexError(verdict.reason);

    return {
      identity: {
        studentNumber: student.studentNumber ?? student.legacyId ?? null,
        firstName: student.firstName,
        lastName: student.lastName,
        grade: student.grade ?? null,
        school: student.school ?? null,
        email: student.email ?? null,
        archivedAt: student.archivedAt ?? null,
      },

      // Earned value, read only in this view. Nothing here is editable through
      // a drill-down; awarding and deducting are their own audited actions.
      earned: {
        pbisTickets: student.pbisTickets,
        attendanceTickets: student.attendanceTickets,
        academicTickets: student.academicTickets,
        totalTickets:
          student.pbisTickets + student.attendanceTickets + student.academicTickets,
        weeksQualified: student.weeksQualified ?? 0,
        bigRaffleQualified: student.bigRaffleQualified,
        wildcatCashBalance: student.wildcatCashBalance ?? 0,
        wildcatCashEarned: student.wildcatCashEarned ?? 0,
        wildcatCashSpent: student.wildcatCashSpent ?? 0,
      },

      // SIS data, through an allowlist. psRoster deliberately holds no
      // restricted field (federal ethnicity, federal race, IEP, 504, English
      // Learner), so a drill-down cannot surface one even by accident.
      sis: {
        scheduleCount: rows.length,
        schedule: rows.map(studentSisView),
        lastSyncedAt: rows[0]?.syncedAt ?? null,
      },

      viewedAs: { role: teacher.role, scope: verdict.scope },
    };
  },
});
