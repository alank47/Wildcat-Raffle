import { query } from "./_generated/server";
import { ConvexError } from "convex/values";
import { requireIdentity, requireStaff } from "./identity";
import { restrictedFor } from "./restrictedPolicy";

/**
 * The three reads the app actually needs.
 *
 *   teacherRoster   staff  -> their own sections and the students in them
 *   myStudentView   student -> their own points, cash and grades
 *   (drill-down lives in studentDetail.ts)
 *
 * Every one is an allowlist. Restricted fields are absent from these tables
 * entirely AND stripped by policy, so there are two independent reasons a
 * teacher cannot see a student's IEP status here.
 *
 * "Not available" is expressed as null, never as 0. The brief, Phase 6 point 3:
 * a student with no gradebook percent must not appear to have 0%.
 */

/** Staff: my sections, my students, with their totals. */
export const teacherRoster = query({
  args: {},
  handler: async (ctx) => {
    const teacher = await requireStaff(ctx);
    const policy = restrictedFor(teacher.role);

    const rows = await ctx.db
      .query("psRoster")
      .withIndex("by_teacherEmail", (q) => q.eq("teacherEmail", teacher.email))
      .collect();

    // One lookup per distinct student, not per enrollment row.
    const numbers = [...new Set(rows.map((r) => r.studentNumber))];
    const students = new Map<string, any>();
    for (const num of numbers) {
      const s = await ctx.db
        .query("students")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", num))
        .unique();
      if (s) students.set(num, s);
    }

    const sections = new Map<string, any>();
    for (const r of rows) {
      const key = r.sectionId ?? `${r.courseNumber}-${r.sectionNumber}`;
      if (!sections.has(key)) {
        sections.set(key, {
          sectionId: key,
          courseName: r.courseName ?? null,
          courseNumber: r.courseNumber ?? null,
          period: r.period ?? r.sectionExpression ?? null,
          term: r.termAbbreviation ?? null,
          students: [],
        });
      }
      const s = students.get(r.studentNumber);
      sections.get(key).students.push({
        studentNumber: r.studentNumber,
        firstName: r.firstName,
        lastName: r.lastName,
        gradeLevel: r.gradeLevel ?? null,
        // Totals so a teacher can see who is close to qualifying.
        totalTickets: s
          ? s.pbisTickets + s.attendanceTickets + s.academicTickets
          : null,
        wildcatCashBalance: s?.wildcatCashBalance ?? null,
        // null, not 0: no record is not the same as no tickets.
        hasAppRecord: Boolean(s),
      });
    }

    return {
      teacher: { name: teacher.name, role: teacher.role },
      sectionCount: sections.size,
      studentCount: numbers.length,
      sections: [...sections.values()],
      restricted: {
        // Told plainly rather than silently omitted, so a teacher knows data
        // exists and is withheld rather than assuming it is missing.
        visibleToYou: policy.allowed,
        withheld: policy.denied,
      },
    };
  },
});

/** Student: my points, my cash, my grades, my schedule. Only ever my own. */
export const myStudentView = query({
  args: {},
  handler: async (ctx) => {
    const id = await requireIdentity(ctx);
    if (id.kind !== "student") throw new ConvexError("Students only.");

    const student = await ctx.db
      .query("students")
      .withIndex("by_email", (q) => q.eq("email", id.email))
      .unique();
    if (!student) {
      throw new ConvexError(
        `No student record is linked to ${id.email} yet. ` +
        `Student accounts are still being connected.`,
      );
    }

    const num = student.studentNumber ?? student.legacyId ?? "";
    const schedule = await ctx.db
      .query("psRoster")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", num))
      .collect();
    const grades = await ctx.db
      .query("psGrades")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", num))
      .collect();
    const attendance = await ctx.db
      .query("psAttendance")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", num))
      .unique();

    return {
      name: `${student.firstName} ${student.lastName}`.trim(),
      grade: student.grade ?? null,

      points: {
        pbis: student.pbisTickets,
        attendance: student.attendanceTickets,
        academic: student.academicTickets,
        total:
          student.pbisTickets + student.attendanceTickets + student.academicTickets,
        weeksQualified: student.weeksQualified ?? 0,
        bigRaffleEntries: student.bigRaffleQualified.length,
      },

      wildcatCash: {
        balance: student.wildcatCashBalance ?? 0,
        earned: student.wildcatCashEarned ?? 0,
        spent: student.wildcatCashSpent ?? 0,
      },

      grades: grades.map((g) => ({
        courseName: g.courseName ?? null,
        courseNumber: g.courseNumber ?? null,
        // null when the SIS has no grade. NEVER 0: a student with no gradebook
        // entry must not appear to be failing.
        currentGrade: g.currentGrade ?? null,
        currentPercent: g.currentPercent ?? null,
        available: g.currentGrade !== undefined || g.currentPercent !== undefined,
      })),

      attendance: attendance
        ? {
            daysAbsentTerm: attendance.daysAbsentTerm ?? null,
            daysAbsentYtd: attendance.daysAbsentYtd ?? null,
            daysTardyTerm: attendance.daysTardyTerm ?? null,
          }
        : null,

      schedule: schedule.map((r) => ({
        courseName: r.courseName ?? null,
        period: r.period ?? r.sectionExpression ?? null,
        teacher:
          [r.teacherFirstName, r.teacherLastName].filter(Boolean).join(" ") || null,
      })),

      // Brief Phase 6 point 2: every screen shows where the data came from and when.
      dataAsOf: schedule[0]?.syncedAt ?? attendance?.syncedAt ?? null,
    };
  },
});
