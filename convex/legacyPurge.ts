import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Reading and removing a legacy document, in pages.
 *
 * WHY PAGED. legacyData:loadDoc collects a whole document in one execution, and
 * the three ticket-history documents are past Convex's 4,096-read limit -- which
 * is the whole reason they can be neither read nor written. Anything that
 * touches them has to work in pages or it hits the same wall.
 *
 * internalQuery / internalMutation: reachable only with the deploy key, never
 * from a browser. Deleting a document is not something a signed-in teacher
 * should be one call away from.
 */

/** One page of a document's rows, for taking a backup before removing it. */
export const dumpDoc = internalQuery({
  args: { doc: v.string(), cursor: v.optional(v.union(v.string(), v.null())), numItems: v.optional(v.number()) },
  handler: async (ctx, { doc, cursor, numItems }) => {
    const page = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc", (q) => q.eq("doc", doc))
      .paginate({ cursor: cursor ?? null, numItems: Math.min(numItems ?? 500, 1000) });
    return {
      rows: page.page.map((r) => ({ collection: r.collection, key: r.key, payload: r.payload })),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Delete up to `limit` rows of one document. Call until `remaining` is 0.
 *
 * Deliberately NOT "delete everything for this doc" in one call: 7,663 rows is
 * past both the read and the write limit, so a single-shot version would fail
 * having deleted an arbitrary prefix -- the worst possible outcome for a
 * destructive operation. Paged, each call either fully succeeds or changes
 * nothing, and re-running it is safe.
 */
export const purgeDocPage = internalMutation({
  args: { doc: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { doc, limit }) => {
    const take = Math.min(limit ?? 500, 1000);
    const rows = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc", (q) => q.eq("doc", doc))
      .take(take);
    for (const r of rows) await ctx.db.delete(r._id);
    // One more than we deleted tells the caller whether to come back.
    const more = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc", (q) => q.eq("doc", doc))
      .take(1);
    return { doc, deleted: rows.length, hasMore: more.length > 0 };
  },
});

/** How many rows a document holds, up to a cap. For checking the result. */
export const countDoc = internalQuery({
  args: { doc: v.string() },
  handler: async (ctx, { doc }) => {
    const rows = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc", (q) => q.eq("doc", doc))
      .take(4000);
    return { doc, atLeast: rows.length, capped: rows.length === 4000 };
  },
});

/** Does auditLog:list actually return rows? Read-only probe. */
export const probeAuditList = internalQuery({
  args: {},
  handler: async (ctx) => {
    const page = await ctx.db
      .query("appAuditLog")
      .withIndex("by_timestamp", (ix) => ix)
      .order("asc")
      .paginate({ cursor: null, numItems: 5 });
    const any = await ctx.db.query("appAuditLog").take(3);
    return {
      pagedRows: page.page.length,
      isDone: page.isDone,
      tableRows: any.length,
      sample: page.page.slice(0, 1).map((r) => ({ entryId: r.entryId, timestamp: r.timestamp })),
    };
  },
});

/** Newest audit entries in the table, to see whether awards are arriving. */
export const recentAudit = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("appAuditLog").order("desc").take(400);
    const byDay: Record<string, number> = {};
    for (const r of rows) byDay[String(r.timestamp).slice(0, 10)] = (byDay[String(r.timestamp).slice(0, 10)] || 0) + 1;
    return {
      sampled: rows.length,
      newest: rows.slice(0, 6).map((r) => ({
        ts: r.timestamp,
        action: (r.payload as any)?.action,
        teacher: (r.payload as any)?.teacher,
        student: (r.payload as any)?.studentName,
        amount: (r.payload as any)?.ticketCount,
      })),
      byDay,
    };
  },
});

/** Shape of the missing-work feed, for diagnosing why the screen is empty. */
export const missingWorkSummary = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("psMissingWork").take(4000);
    const students = new Set<string>();
    const courses: Record<string, number> = {};
    const cats: Record<string, number> = {};
    let late = 0, noCategory = 0, noDue = 0, noPoints = 0;
    let newest = "", oldest = "zzzz";
    for (const r of rows) {
      students.add(r.studentNumber);
      const c = r.courseName ?? "(none)";
      courses[c] = (courses[c] || 0) + 1;
      const k = r.categoryName ?? "(blank)";
      cats[k] = (cats[k] || 0) + 1;
      if (r.isLate) late++;
      if (!r.categoryName) noCategory++;
      if (!r.dueDate) noDue++;
      if (r.pointsPossible == null) noPoints++;
      if (r.syncedAt > newest) newest = r.syncedAt;
      if (r.syncedAt < oldest) oldest = r.syncedAt;
    }
    const top = (o: Record<string, number>, n: number) =>
      Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
    return {
      rows: rows.length, distinctStudents: students.size,
      late, noCategory, noDue, noPoints,
      syncedNewest: newest, syncedOldest: oldest,
      topCourses: top(courses, 6), categories: top(cats, 8),
    };
  },
});

/** Which sections report missing work, joined to the teacher who owns them. */
export const missingWorkByTeacher = internalQuery({
  args: {},
  handler: async (ctx) => {
    const mw = await ctx.db.query("psMissingWork").take(4000);
    const bySection: Record<string, { course: string; items: number; students: Set<string> }> = {};
    for (const r of mw) {
      const k = r.sectionId ?? "(none)";
      const e = (bySection[k] ??= { course: r.courseName ?? "?", items: 0, students: new Set() });
      e.items++; e.students.add(r.studentNumber);
    }
    // psRoster carries the teacher for each section.
    const out: Array<{ sectionId: string; course: string; teacher: string; items: number; students: number }> = [];
    for (const [sectionId, e] of Object.entries(bySection)) {
      out.push({ sectionId, course: e.course, teacher: "", items: e.items, students: e.students.size });
    }

    // psRoster has no by_section index, so the map is built from one scan
    // rather than a lookup per section.
    const roster = await ctx.db.query("psRoster").take(6000);
    const teacherOf = new Map<string, string>();
    for (const r of roster) {
      if (r.sectionId && !teacherOf.has(r.sectionId)) {
        teacherOf.set(r.sectionId, `${r.teacherFirstName ?? ""} ${r.teacherLastName ?? ""}`.trim());
      }
    }
    for (const o of out) o.teacher = teacherOf.get(o.sectionId) || "(unknown)";
    out.sort((a, b) => b.items - a.items);

    const allSections = new Set(roster.map((r) => r.sectionId).filter(Boolean));
    const teachers = new Set(roster.map((r) => r.teacherEmail).filter(Boolean));
    return {
      sectionsReporting: out.length,
      sectionsTotal: allSections.size,
      teachersTotal: teachers.size,
      detail: out,
    };
  },
});

/** One student, end to end: do they have missing work, and would it reach them? */
export const studentMissingWork = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const needle = name.trim().toLowerCase();
    const students = await ctx.db.query("students").take(2000);
    const hits = students.filter((s) =>
      `${s.firstName ?? ""} ${s.lastName ?? ""}`.toLowerCase().includes(needle));
    if (!hits.length) return { found: 0, note: "no student matches that name" };

    const out = [];
    for (const s of hits) {
      const num = String(s.studentNumber ?? "");
      const mw = num
        ? await ctx.db.query("psMissingWork")
            .withIndex("by_studentNumber", (q) => q.eq("studentNumber", num))
            .collect()
        : [];
      const grades = num
        ? await ctx.db.query("psGrades")
            .withIndex("by_studentNumber", (q) => q.eq("studentNumber", num))
            .collect()
        : [];
      const roster = num
        ? await ctx.db.query("psRoster")
            .withIndex("by_studentNumber", (q) => q.eq("studentNumber", num))
            .collect()
        : [];
      out.push({
        name: `${s.firstName} ${s.lastName}`,
        studentNumber: num || "(none)",
        enrolled: (s as any).enrolled !== false,
        // Sign-in needs an email on the record.
        hasEmail: Boolean(s.email),
        missingWorkItems: mw.length,
        missingWork: mw.slice(0, 10).map((r) => ({
          course: r.courseName, assignment: r.assignmentName,
          due: r.dueDate, points: r.pointsPossible,
        })),
        gradeRows: grades.length,
        sectionsOnRoster: new Set(roster.map((r) => r.sectionId)).size,
      });
    }
    return { found: hits.length, students: out };
  },
});

/** One student's classes, and whether each teacher flags missing work at all. */
export const studentTeacherFlagUse = internalQuery({
  args: { studentNumber: v.string() },
  handler: async (ctx, { studentNumber }) => {
    const mine = await ctx.db
      .query("psRoster")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", studentNumber))
      .collect();

    // Sections anywhere in the school that report missing work.
    const mw = await ctx.db.query("psMissingWork").take(4000);
    const reporting = new Set(mw.map((r) => r.sectionId).filter(Boolean));

    const seen = new Set<string>();
    const rows = [];
    for (const r of mine) {
      const k = r.sectionId ?? "";
      if (!k || seen.has(k)) continue;
      seen.add(k);
      rows.push({
        course: r.courseName ?? "?",
        period: r.period ?? "?",
        teacher: `${r.teacherFirstName ?? ""} ${r.teacherLastName ?? ""}`.trim(),
        flagsMissingWork: reporting.has(k),
      });
    }
    rows.sort((a, b) => String(a.period).localeCompare(String(b.period)));
    return { sections: rows.length, usingFlag: rows.filter((r) => r.flagsMissingWork).length, rows };
  },
});

/** Every gradebook category name in use, with how much work sits under it. */
export const categoryNames = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("psMissingWork").take(4000);
    const cats: Record<string, { items: number; sections: Set<string> }> = {};
    for (const r of rows) {
      const k = r.categoryName ?? "(none recorded)";
      const e = (cats[k] ??= { items: 0, sections: new Set() });
      e.items++; if (r.sectionId) e.sections.add(r.sectionId);
    }
    return Object.entries(cats)
      .map(([name, e]) => ({ name, items: e.items, sections: e.sections.size }))
      .sort((a, b) => b.items - a.items);
  },
});

/** How much of the missing work now carries a score, and how many are zeros. */
export const scoreShape = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("psMissingWork").take(4000);
    let withScore = 0, zeros = 0, positive = 0, noScore = 0, withTotal = 0;
    for (const r of rows) {
      if (typeof r.scorePoints === "number") {
        withScore++;
        if (r.scorePoints === 0) zeros++; else positive++;
      } else noScore++;
      if (typeof r.totalPointValue === "number") withTotal++;
    }
    return { rows: rows.length, withScore, zeros, positive, noScore, withTotal };
  },
});
