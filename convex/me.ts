import { query } from "./_generated/server";
import { requireIdentity } from "./identity";
import { studentView, staffRosterView } from "./views";

/**
 * "Who am I, and what is my PowerSchool data?"
 *
 * One endpoint for both kinds of user. The caller does not say which they are
 * and cannot ask about anybody else: the answer is derived entirely from the
 * verified token, and the email in that token is the join key into PowerSchool.
 *
 *   staff   -> matched on psRoster.teacherEmail  -> the sections they teach
 *   student -> matched on psRoster.studentEmail  -> their own schedule
 *
 * The same denormalized roster table answers both, in one indexed lookup each.
 */

export const get = query({
  args: {},
  handler: async (ctx) => {
    const id = await requireIdentity(ctx);

    if (id.kind === "staff") {
      const teacher = await ctx.db
        .query("teachers")
        .withIndex("by_email", (q) => q.eq("email", id.email))
        .unique();

      const rows = await ctx.db
        .query("psRoster")
        .withIndex("by_teacherEmail", (q) => q.eq("teacherEmail", id.email))
        .collect();

      // Distinct sections, each with the students in it.
      const sections = new Map<string, ReturnType<typeof staffRosterView>[]>();
      for (const row of rows) {
        const key = row.sectionId ?? `${row.courseNumber}-${row.sectionNumber}`;
        const list = sections.get(key) ?? [];
        list.push(staffRosterView(row));
        sections.set(key, list);
      }

      return {
        kind: "staff" as const,
        email: id.email,
        name: teacher?.name ?? null,
        role: teacher?.role ?? null,
        // No app record yet is not an error worth hiding: it tells an admin
        // exactly what to fix, and the PowerSchool match still works because it
        // keys on the token email rather than on the record.
        hasAppRecord: teacher !== null,
        sectionCount: sections.size,
        studentCount: rows.length,
        sections: [...sections.entries()].map(([sectionId, students]) => ({
          sectionId,
          students,
        })),
      };
    }

    // Student. Resolves only to themselves; there is no argument to abuse.
    const rows = await ctx.db
      .query("psRoster")
      .withIndex("by_studentEmail", (q) => q.eq("studentEmail", id.email))
      .collect();

    const student = await ctx.db
      .query("students")
      .withIndex("by_email", (q) => q.eq("email", id.email))
      .unique();

    return {
      kind: "student" as const,
      email: id.email,
      firstName: rows[0]?.firstName ?? student?.firstName ?? null,
      lastName: rows[0]?.lastName ?? student?.lastName ?? null,
      gradeLevel: rows[0]?.gradeLevel ?? null,
      hasAppRecord: student !== null,
      // Empty until PowerSchool manifest field 19 (Student Email) is approved
      // and syncing. A signed-in student with no rows is the expected state
      // today, not a failure.
      schedule: rows.map(studentView),
      tickets: student
        ? {
            pbis: student.pbisTickets,
            attendance: student.attendanceTickets,
            academic: student.academicTickets,
            total:
              student.pbisTickets +
              student.attendanceTickets +
              student.academicTickets,
          }
        : null,
    };
  },
});
