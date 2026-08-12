import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Load attendance and grade statistics from the SIS.
 *
 * Both are full replacements per sync run rather than merges. A student who
 * drops a section must lose that section's grade row, and a merge cannot
 * express a deletion. Attendance is one row per student per term, so it is
 * upserted by student number.
 *
 * NOTHING HERE TOUCHES EARNED VALUE. These write their own tables; the
 * students table with its balances is not referenced.
 */
export const putAttendance = internalMutation({
  args: {
    syncedAt: v.string(),
    rows: v.array(
      v.object({
        studentNumber: v.string(),
        daysAbsentTerm: v.optional(v.number()),
        daysAbsentYtd: v.optional(v.number()),
        daysTardyTerm: v.optional(v.number()),
        attendanceRowsYtd: v.optional(v.number()),
        termFirstDay: v.optional(v.string()),
        termLastDay: v.optional(v.string()),
        termId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { rows, syncedAt }) => {
    const existing = await ctx.db.query("psAttendance").collect();
    const byNumber = new Map(existing.map((r) => [r.studentNumber, r]));
    let created = 0, updated = 0;
    for (const r of rows) {
      const prior = byNumber.get(r.studentNumber);
      if (prior) { await ctx.db.patch(prior._id, { ...r, syncedAt }); updated++; }
      else { await ctx.db.insert("psAttendance", { ...r, syncedAt }); created++; }
    }
    return { created, updated, received: rows.length };
  },
});

export const replaceGrades = internalMutation({
  args: {
    syncedAt: v.string(),
    clearFirst: v.optional(v.boolean()),
    rows: v.array(
      v.object({
        studentNumber: v.string(),
        sectionId: v.optional(v.string()),
        courseNumber: v.optional(v.string()),
        courseName: v.optional(v.string()),
        currentGrade: v.optional(v.string()),
        currentPercent: v.optional(v.number()),
        gradeSource: v.optional(v.string()),
        lastGradeUpdate: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { rows, syncedAt, clearFirst }) => {
    let deleted = 0;
    if (clearFirst) {
      const old = await ctx.db.query("psGrades").collect();
      for (const r of old) { await ctx.db.delete(r._id); deleted++; }
    }
    for (const r of rows) await ctx.db.insert("psGrades", { ...r, syncedAt });
    return { inserted: rows.length, deleted };
  },
});

/** Coverage report. Counts only, never a value. */
export const stats = internalMutation({
  args: {},
  handler: async (ctx) => {
    const roster = await ctx.db.query("psRoster").collect();
    const att = await ctx.db.query("psAttendance").collect();
    const grades = await ctx.db.query("psGrades").collect();
    const students = await ctx.db.query("students").collect();
    return {
      rosterRows: roster.length,
      rosterStudents: new Set(roster.map((r) => r.studentNumber)).size,
      rosterSections: new Set(roster.map((r) => r.sectionId)).size,
      rosterTeachers: new Set(roster.map((r) => r.teacherEmail).filter(Boolean)).size,
      attendanceRows: att.length,
      gradeRows: grades.length,
      // A grade row with no percent is a known gap, not a zero. Counted so the
      // gap is visible rather than rendered as 0%.
      gradeRowsMissingPercent: grades.filter((g) => g.currentPercent === undefined).length,
      appStudents: students.length,
      lastSyncedAt: roster[0]?.syncedAt ?? null,
    };
  },
});
