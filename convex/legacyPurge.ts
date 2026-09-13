import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
// Static, because Convex refuses a dynamic import at runtime.
import { isUnratedCohort, isSupportBlock } from "./courseSubject";
import { courseCell } from "./academicsRules";

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

/** What identity the stored cash transactions actually carry. */
export const cashTxIdentities = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc_collection", (q) =>
        q.eq("doc", "cash_tx_2026_W36").eq("collection", "transactions"))
      .take(200);
    const seen: Record<string, number> = {};
    const sample: any[] = [];
    for (const r of rows) {
      const p = r.payload as any;
      const key = `teacherId=${JSON.stringify(p?.teacherId)} teacherUsername=${JSON.stringify(p?.teacherUsername)} teacherName=${JSON.stringify(p?.teacherName)}`;
      seen[key] = (seen[key] || 0) + 1;
      if (sample.length < 2) sample.push({ id: p?.id, teacherId: p?.teacherId, teacherName: p?.teacherName, amount: p?.amount });
    }
    return { rows: rows.length, identities: seen, sample };
  },
});

/** The per-student cash arrays, which Analytics reads, by teacher. */
export const cashTxOnStudents = internalQuery({
  args: {},
  handler: async (ctx) => {
    const students = await ctx.db.query("students").take(2000);
    const byTeacher: Record<string, number> = {};
    let studentsWithAny = 0, total = 0;
    const weeks: Record<string, number> = {};
    for (const s of students) {
      const txs = (s as any).wildcatCashTransactions;
      if (!Array.isArray(txs) || !txs.length) continue;
      studentsWithAny++;
      for (const t of txs) {
        total++;
        const who = `${t?.teacherId ?? "?"} ${t?.teacherName ?? ""}`.trim();
        byTeacher[who] = (byTeacher[who] || 0) + 1;
        const wk = String(t?.timestamp ?? "").slice(0, 7) || "(no date)";
        weeks[wk] = (weeks[wk] || 0) + 1;
      }
    }
    return { studentsWithAny, total, byTeacher, byMonth: weeks };
  },
});

/** How large the payload appData:save ships on every single save is. */
export const savePayloadSize = internalQuery({
  args: {},
  handler: async (ctx) => {
    const students = await ctx.db.query("students").take(2000);
    const teachers = await ctx.db.query("teachers").take(200);
    const WRITABLE = ["pbisTickets","attendanceTickets","academicTickets","bigRaffleQualified",
      "weeksQualified","wildcatCashBalance","wildcatCashEarned","wildcatCashSpent",
      "wildcatCashDeducted","wildcatCashRewardsRedeemed","wildcatCashTransactions",
      "cashBalance","cashTransactions"];
    // What the browser actually sends: the whole student object minus the
    // slices stripped in saveData.
    const shipped = students.map((s: any) => {
      const c: any = { ...s };
      delete c.ticketHistory; delete c.sections;
      delete c.wildcatCashTransactions; delete c.cashTransactions;
      return c;
    });
    const bytes = (v: unknown) => JSON.stringify(v).length;
    return {
      students: students.length,
      teachers: teachers.length,
      studentPayloadKB: Math.round(bytes(shipped) / 1024),
      teacherPayloadKB: Math.round(bytes(teachers) / 1024),
      totalKB: Math.round((bytes(shipped) + bytes(teachers)) / 1024),
      writableFields: WRITABLE.length,
    };
  },
});

/** Would the "quiet kids" metric surface anything useful at current volume? */
export const quietKidsProbe = internalQuery({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => {
    const since = Date.now() - (days ?? 30) * 86400000;

    // Every cash movement, from both stores, deduped by id -- the same union
    // the app takes at load.
    const seen = new Set<string>();
    const moves: Array<{ studentId: string; amount: number }> = [];
    const weekRows = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc_collection", (q) =>
        q.eq("doc", "cash_tx_2026_W36").eq("collection", "transactions"))
      .take(3000);
    for (const r of weekRows) {
      const p = r.payload as any;
      if (!p?.id || seen.has(p.id)) continue;
      if (new Date(p.timestamp ?? 0).getTime() < since) continue;
      seen.add(p.id);
      moves.push({ studentId: String(p.studentId ?? ""), amount: Number(p.amount) || 0 });
    }
    const students = await ctx.db.query("students").take(2000);
    for (const s of students) {
      for (const t of ((s as any).wildcatCashTransactions ?? [])) {
        if (!t?.id || seen.has(t.id)) continue;
        if (new Date(t.timestamp ?? 0).getTime() < since) continue;
        seen.add(t.id);
        moves.push({ studentId: String(t.studentId ?? s.legacyId ?? ""), amount: Number(t.amount) || 0 });
      }
    }

    const per: Record<string, { pos: number; neg: number }> = {};
    for (const m of moves) {
      if (!m.studentId) continue;
      const e = (per[m.studentId] ??= { pos: 0, neg: 0 });
      if (m.amount > 0) e.pos++; else if (m.amount < 0) e.neg++;
    }

    const enrolled = students.filter((s: any) => s.enrolled !== false);
    const counts = enrolled.map((s: any) => {
      const e = per[String(s.legacyId ?? "")] ?? { pos: 0, neg: 0 };
      return e.pos + e.neg;
    });
    const total = counts.reduce((a, b) => a + b, 0);
    const avg = counts.length ? total / counts.length : 0;

    return {
      windowDays: days ?? 30,
      movements: moves.length,
      enrolled: enrolled.length,
      studentsWithAnyInteraction: counts.filter((c) => c > 0).length,
      averageInteractions: Number(avg.toFixed(3)),
      belowAverage: counts.filter((c) => c < avg).length,
      atZero: counts.filter((c) => c === 0).length,
    };
  },
});

/** Login history rows matching a name. The legacy store, not authEvents. */
export const loginHistoryFor = internalQuery({
  args: { needle: v.string() },
  handler: async (ctx, { needle }) => {
    const rows = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc_collection", (q) =>
        q.eq("doc", "secondary").eq("collection", "loginHistory"))
      .take(2000);
    const n = needle.trim().toLowerCase();
    const hits = rows
      .map((r) => r.payload as any)
      .filter((p) => JSON.stringify(p ?? {}).toLowerCase().includes(n));
    return {
      totalRows: rows.length,
      matches: hits.length,
      sample: hits.slice(0, 6),
      // Every distinct person in the store, so a near-miss is visible.
      names: [...new Set(rows.map((r) => (r.payload as any)?.name).filter(Boolean))].sort(),
    };
  },
});

/** What the attendance feed actually holds, and whether it can carry this. */
export const attendanceShape = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("psAttendance").take(2000);
    const num = (v: any) => (typeof v === "number" && isFinite(v) ? v : null);
    const withAbs = rows.filter((r) => num(r.daysAbsentYtd) !== null);
    const withTardy = rows.filter((r) => num(r.daysTardyTerm) !== null);
    const absVals = withAbs.map((r) => r.daysAbsentYtd as number).sort((a, b) => b - a);
    return {
      rows: rows.length,
      withAbsentYtd: withAbs.length,
      withTardyTerm: withTardy.length,
      // attendanceRowsYtd is how many attendance records exist for the
      // student -- a proxy for days enrolled, which a rate needs.
      withRowsYtd: rows.filter((r) => num(r.attendanceRowsYtd) !== null).length,
      termFirstDay: rows[0]?.termFirstDay ?? null,
      termLastDay: rows[0]?.termLastDay ?? null,
      absentTop: absVals.slice(0, 8),
      absentAtLeast: {
        one: absVals.filter((v) => v >= 1).length,
        two: absVals.filter((v) => v >= 2).length,
        three: absVals.filter((v) => v >= 3).length,
        five: absVals.filter((v) => v >= 5).length,
      },
      sample: rows.slice(0, 2).map((r) => ({
        n: r.studentNumber, abs: r.daysAbsentYtd, absTerm: r.daysAbsentTerm,
        tardy: r.daysTardyTerm, rowsYtd: r.attendanceRowsYtd,
        first: r.termFirstDay, last: r.termLastDay,
      })),
    };
  },
});

/** What a 10% rule actually flags today, at each tier. */
export const absenteeismPreview = internalQuery({
  args: { schoolDays: v.number() },
  handler: async (ctx, { schoolDays }) => {
    const rows = await ctx.db.query("psAttendance").take(2000);
    const days = Math.max(1, schoolDays);
    const rate = (a: number) => a / days;
    const abs = rows
      .map((r) => (typeof r.daysAbsentYtd === "number" ? r.daysAbsentYtd : null))
      .filter((v): v is number => v !== null);
    const tardy = rows
      .map((r) => (typeof r.daysTardyTerm === "number" ? r.daysTardyTerm : null))
      .filter((v): v is number => v !== null);

    const tier = (lo: number, hi: number) => abs.filter((a) => rate(a) >= lo && rate(a) < hi).length;
    return {
      schoolDays: days,
      students: abs.length,
      thresholdDays: Number((days * 0.1).toFixed(2)),
      absence: {
        satisfactory_under5: abs.filter((a) => rate(a) < 0.05).length,
        atRisk_5to10: tier(0.05, 0.10),
        chronic_10to20: tier(0.10, 0.20),
        severe_20plus: abs.filter((a) => rate(a) >= 0.20).length,
      },
      chronicTotal: abs.filter((a) => rate(a) >= 0.10).length,
      tardy: {
        none: tardy.filter((t) => t === 0).length,
        oneToTwo: tardy.filter((t) => t >= 1 && t <= 2).length,
        threeToFive: tardy.filter((t) => t >= 3 && t <= 5).length,
        sixPlus: tardy.filter((t) => t >= 6).length,
        max: tardy.length ? Math.max(...tardy) : 0,
      },
    };
  },
});

/**
 * Can the browser put a NAME beside each attendance row?
 *
 * attendanceList:schoolAttendance deliberately sends numbers only, and the
 * page joins them to the roster it already holds. That is a real dependency,
 * not a formality: roughly a third of student records have incomplete SIS
 * identity, and a number that matches nothing renders as "Student 12345".
 * Read-only, admin-only, and it returns counts rather than students.
 */
export const attendanceJoinCoverage = internalQuery({
  args: {},
  handler: async (ctx) => {
    const att = await ctx.db.query("psAttendance").take(3000);
    const studs = await ctx.db.query("students").take(3000);
    const byNumber = new Set<string>();
    let studentsWithNumber = 0;
    for (const s of studs) {
      const n = (s as any).studentNumber ? String((s as any).studentNumber) : "";
      if (n) { byNumber.add(n); studentsWithNumber++; }
    }
    let matched = 0, unmatched = 0;
    const sampleUnmatched: string[] = [];
    for (const a of att) {
      const n = String(a.studentNumber || "");
      if (n && byNumber.has(n)) matched++;
      else { unmatched++; if (sampleUnmatched.length < 5) sampleUnmatched.push(n); }
    }
    return {
      attendanceRows: att.length,
      students: studs.length,
      studentsWithNumber,
      matched,
      unmatched,
      sampleUnmatched,
    };
  },
});

/**
 * Is PowerSchool plugin 1.4.1 installed?
 *
 * Not answered by asking PowerSchool -- answered by looking at what the sync
 * actually managed to WRITE. 1.4.1 adds one endpoint (section_points) and
 * widens another (missing_work now returns ISMISSING). If psSectionPoints has
 * rows, the new endpoint answered, and only 1.4.1 serves it.
 *
 * Read-only. Counts and timestamps, no student rows.
 */
export const pluginVersionEvidence = internalQuery({
  args: {},
  handler: async (ctx) => {
    const sp = await ctx.db.query("psSectionPoints").take(2000);
    const mw = await ctx.db.query("psMissingWork").take(2000);
    const gr = await ctx.db.query("psGrades").take(2000);

    const latest = (rows: any[]) => {
      let t: string | null = null;
      for (const r of rows) {
        const s = typeof r.syncedAt === "string" ? r.syncedAt : null;
        if (s && (!t || s > t)) t = s;
      }
      return t;
    };

    // COUNTED, BUT NOT EVIDENCE, and the first read of it was wrong.
    //
    // isMissing looks like a 1.4.1 marker and is not one: sisAction writes
    // `m.is_missing === undefined ? true : ...`, so a 1.3.1 row that carries
    // no is_missing column still lands with isMissing = true. Every row here
    // having the field, all of them flagged and none zero-scored, is the
    // 1.3.1 DEFAULT rather than a teacher's flag. The tell is zeroScored: at
    // 1.4.1 the widened query returns zero-scored work too, so a real 1.4.1
    // sync cannot leave that at 0 across a thousand rows.
    //
    // section_points is the only unambiguous signal, because 1.3.1 has no
    // such query to answer with.
    let withIsMissing = 0, flaggedByTeacher = 0, zeroScored = 0;
    for (const r of mw) {
      if (typeof (r as any).isMissing === "boolean") {
        withIsMissing++;
        if ((r as any).isMissing) flaggedByTeacher++; else zeroScored++;
      }
    }

    return {
      sectionPoints: {
        rows: sp.length,
        students: new Set(sp.map((r) => r.studentNumber)).size,
        lastSyncedAt: latest(sp),
      },
      missingWork: {
        rows: mw.length,
        withIsMissingField: withIsMissing,
        flaggedByTeacher,
        zeroScored,
        lastSyncedAt: latest(mw),
      },
      grades: { rows: gr.length, lastSyncedAt: latest(gr) },
      // The whole point: section_points is served ONLY by 1.4.1.
      verdict: sp.length > 0 ? "1.4.1 IS INSTALLED" : "still 1.3.1 (no section_points data)",
    };
  },
});

/**
 * What did the last few syncs say about the 1.4.x queries?
 *
 * sisAction records sectionPointsError and missingWorkError per run. A 404
 * there is the plugin answering "I do not have that query", which is exactly
 * what 1.3.1 says and exactly what 1.4.1 does not. Read-only.
 */
export const sectionPointsSyncErrors = internalQuery({
  args: {},
  handler: async (ctx) => {
    const runs = await ctx.db.query("syncRuns").withIndex("by_at").order("desc").take(6);
    return runs.map((r) => {
      const sum = (r.summary || {}) as any;
      return {
        at: r.at,
        sectionPointsError: sum.sectionPointsError ?? null,
        missingWorkError: sum.missingWorkError ?? null,
        sectionPoints: sum.sectionPoints ?? null,
        missingWork: sum.missingWork ?? null,
      };
    });
  },
});

/**
 * Find one person across the three places they can exist, before changing
 * anything about them. Read-only, and it takes a name fragment because the
 * whole question is usually "what address are they actually under".
 */
export const findStaff = internalQuery({
  args: { needle: v.string() },
  handler: async (ctx, { needle }) => {
    const q = needle.trim().toLowerCase();
    const hit = (...vals: unknown[]) =>
      vals.some((v) => typeof v === "string" && v.toLowerCase().includes(q));

    const dir = await ctx.db.query("entraDirectory").take(3000);
    const teach = await ctx.db.query("teachers").take(2000);
    const roster = await ctx.db.query("psRoster").take(4000);

    const inDirectory = dir
      .filter((d: any) => hit(d.email, d.displayName, d.givenName, d.surname))
      .map((d: any) => ({
        email: d.email, displayName: d.displayName, jobTitle: d.jobTitle ?? null,
        accountEnabled: d.accountEnabled ?? null,
      }));

    const inTeachers = teach
      .filter((t: any) => hit(t.email, t.name, t.psEmail))
      .map((t: any) => ({
        email: t.email, name: t.name, role: t.role,
        psEmail: t.psEmail ?? null, id: t._id,
      }));

    // Do they have SIS sections at all? That is the difference between "no
    // roster loaded" and "loaded, and it is empty".
    const emails = new Set<string>();
    inTeachers.forEach((t: any) => {
      if (t.email) emails.add(String(t.email).toLowerCase());
      if (t.psEmail) emails.add(String(t.psEmail).toLowerCase());
    });
    inDirectory.forEach((d: any) => { if (d.email) emails.add(String(d.email).toLowerCase()); });

    const sections = new Map<string, number>();
    let rosterRows = 0;
    for (const r of roster as any[]) {
      const te = typeof r.teacherEmail === "string" ? r.teacherEmail.toLowerCase() : "";
      if (te && emails.has(te)) {
        rosterRows++;
        const k = String(r.sectionId ?? "?");
        sections.set(k, (sections.get(k) ?? 0) + 1);
      }
    }

    return {
      inDirectory,
      inTeachers,
      sisRoster: {
        emailsTried: [...emails],
        rows: rosterRows,
        sections: [...sections.entries()].map(([sectionId, students]) => ({ sectionId, students })),
      },
    };
  },
});

/**
 * Which teacher addresses does the SIS actually use, and does one of them
 * belong to a person the app has under a different address?
 *
 * This is the Jazmin case: the app knew jazmink@, PowerSchool wrote jazmina@,
 * and the roster join found nothing. Read-only; it returns staff addresses and
 * section counts, never students.
 */
export const rosterTeacherSearch = internalQuery({
  args: { needle: v.string() },
  handler: async (ctx, { needle }) => {
    const q = needle.trim().toLowerCase();
    const rows = await ctx.db.query("psRoster").take(4000);
    const byTeacher = new Map<string, { name: string | null; sections: Set<string>; rows: number }>();
    for (const r of rows as any[]) {
      const em = typeof r.teacherEmail === "string" ? r.teacherEmail.toLowerCase() : "";
      const nm = typeof r.teacherName === "string" ? r.teacherName : null;
      if (!em && !nm) continue;
      const key = em || `name:${nm}`;
      const e = byTeacher.get(key) ?? { name: nm, sections: new Set<string>(), rows: 0 };
      if (nm && !e.name) e.name = nm;
      e.sections.add(String(r.sectionId ?? "?"));
      e.rows++;
      byTeacher.set(key, e);
    }
    const all = [...byTeacher.entries()].map(([email, v]) => ({
      teacherEmail: email, teacherName: v.name, sections: v.sections.size, rows: v.rows,
    }));
    return {
      matches: all.filter((t) =>
        (t.teacherEmail && t.teacherEmail.includes(q)) ||
        (t.teacherName && t.teacherName.toLowerCase().includes(q))),
      totalTeachersInRoster: all.length,
    };
  },
});

/** How complete is the mirrored Entra directory, and how old? Read-only. */
export const directoryHealth = internalQuery({
  args: {},
  handler: async (ctx) => {
    const dir = await ctx.db.query("entraDirectory").take(4000);
    const teach = await ctx.db.query("teachers").take(2000);
    const emails = new Set(dir.map((d: any) => String(d.email || "").toLowerCase()));
    const missing = teach
      .filter((t: any) => !emails.has(String(t.email || "").toLowerCase()))
      .map((t: any) => ({ email: t.email, name: t.name, role: t.role }));
    let newest: string | null = null, oldest: string | null = null;
    for (const d of dir as any[]) {
      const s = typeof d.syncedAt === "string" ? d.syncedAt : null;
      if (!s) continue;
      if (!newest || s > newest) newest = s;
      if (!oldest || s < oldest) oldest = s;
    }
    return {
      directoryRows: dir.length,
      teacherRows: teach.length,
      teachersNotInDirectory: missing.length,
      missing,
      mirrorNewest: newest,
      mirrorOldest: oldest,
    };
  },
});

/**
 * Every referral on the server, summarised. Read-only.
 *
 * Answers "was it saved at all" separately from "can the reader see it",
 * which are the two halves of a missing-referral report and need opposite
 * fixes. Names of STAFF, not students -- the student is reduced to whether a
 * name is present, so this probe cannot itself become a student export.
 */
export const referralAudit = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc", (q) => q.eq("doc", "referrals"))
      .collect();

    const refs = rows
      .filter((r) => r.collection === "behaviorReferrals")
      .map((r) => r.payload as any);

    const byId = new Map<string, number>();
    for (const r of refs) {
      const id = String(r?.id ?? "(none)");
      byId.set(id, (byId.get(id) ?? 0) + 1);
    }

    const summarise = (r: any) => ({
      id: r?.id ?? null,
      status: r?.status ?? null,
      date: r?.date ?? r?.timestamp ?? r?.createdAt ?? null,
      referredBy: r?.referredBy ?? null,
      filedByEmail: r?.filedByEmail ?? null,
      referredByEmail: r?.referredByEmail ?? null,
      filedByUsername: r?.filedByUsername ?? null,
      hasStudent: !!(r?.studentName || r?.studentId || r?.studentNumber),
    });

    const statuses = new Map<string, number>();
    for (const r of refs) statuses.set(String(r?.status ?? "(none)"), (statuses.get(String(r?.status ?? "(none)")) ?? 0) + 1);

    // Newest last, so the tail is what was just filed.
    const sorted = refs.slice().sort((a, b) =>
      String(a?.date ?? "").localeCompare(String(b?.date ?? "")));

    return {
      storedRows: rows.length,
      referrals: refs.length,
      duplicateIds: [...byId.entries()].filter(([, n]) => n > 1).map(([id, n]) => ({ id, count: n })),
      statusCounts: [...statuses.entries()].map(([status, count]) => ({ status, count })),
      newest: sorted.slice(-12).map(summarise),
    };
  },
});

/** Recent sign-ins for one address. Read-only. */
export const signInsFor = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const e = email.trim().toLowerCase();
    const rows = await ctx.db
      .query("authEvents")
      .withIndex("by_email", (q) => q.eq("email", e))
      .collect();
    const sorted = rows.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return {
      email: e,
      signIns: sorted.length,
      first: sorted[0]?.at ?? null,
      recent: sorted.slice(-8).map((r) => ({ at: r.at, provider: r.provider, kind: r.kind })),
    };
  },
});

/**
 * One referral's ATTRIBUTION fields in full, plus every sign-in today.
 * Read-only. The student is reduced to a yes/no; this is about which adult
 * the record was written against, not about the child.
 */
export const referralAttribution = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const rows = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc", (q) => q.eq("doc", "referrals"))
      .collect();
    const hit = rows
      .filter((r) => r.collection === "behaviorReferrals")
      .map((r) => r.payload as any)
      .find((r) => String(r?.id) === id);

    const scrubbed: Record<string, unknown> = {};
    if (hit) {
      for (const [k, v] of Object.entries(hit)) {
        if (/^student|^demographics$|name$/i.test(k) && k !== "referredBy") {
          scrubbed[k] = v === null || v === undefined ? v : "(present)";
        } else {
          scrubbed[k] = v;
        }
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const auth = await ctx.db.query("authEvents").collect();
    const todays = auth
      .filter((a) => String(a.at).slice(0, 10) === today)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .map((a) => ({ at: a.at, email: a.email }));

    return { found: !!hit, referral: scrubbed, signInsToday: todays };
  },
});

/** Full staff records, field by field, for comparison. Read-only. */
export const staffRecordShape = internalQuery({
  args: { emails: v.array(v.string()) },
  handler: async (ctx, { emails }) => {
    const want = new Set(emails.map((e) => e.trim().toLowerCase()));
    const rows = await ctx.db.query("teachers").take(2000);
    const hits = rows.filter((t: any) => want.has(String(t.email || "").toLowerCase()));
    const allKeys = new Set<string>();
    rows.forEach((t: any) => Object.keys(t).forEach((k) => allKeys.add(k)));
    return {
      records: hits.map((t: any) => {
        const o: Record<string, unknown> = {};
        Object.keys(t).sort().forEach((k) => { o[k] = t[k]; });
        return o;
      }),
      // What fields do OTHER staff records carry that these might lack?
      fieldsSeenAcrossAllStaff: [...allKeys].sort(),
    };
  },
});

/**
 * Who has been active since a given moment, and what did they do?
 * Read-only. Staff addresses and counts; no student rows.
 */
export const activitySince = internalQuery({
  args: { sinceIso: v.string() },
  handler: async (ctx, { sinceIso }) => {
    const since = sinceIso;

    const auth = await ctx.db.query("authEvents").collect();
    const signIns = auth.filter((a) => String(a.at) >= since);
    const byPerson = new Map<string, number>();
    for (const a of signIns) byPerson.set(a.email, (byPerson.get(a.email) ?? 0) + 1);

    // Audit entries -- who awarded/deducted what.
    const audit = await ctx.db.query("appAuditLog").withIndex("by_timestamp").order("desc").take(1200);
    const recent = audit.filter((r: any) => String(r.timestamp ?? "") >= since);
    const byActor = new Map<string, number>();
    for (const r of recent as any[]) {
      const who = String(r.teacherName ?? r.teacher ?? r.userId ?? "(unknown)");
      byActor.set(who, (byActor.get(who) ?? 0) + 1);
    }

    const syncs = await ctx.db.query("syncRuns").withIndex("by_at").order("desc").take(20);

    return {
      since,
      signIns: [...byPerson.entries()].map(([email, n]) => ({ email, n }))
        .sort((a, b) => b.n - a.n),
      auditEntries: recent.length,
      auditByActor: [...byActor.entries()].map(([who, n]) => ({ who, n }))
        .sort((a, b) => b.n - a.n).slice(0, 15),
      syncRuns: syncs.filter((r) => String(r.at) >= since).length,
    };
  },
});

/**
 * Size of ONE legacy document, read in bounded pages so the probe itself
 * cannot hit the 16 MiB limit it is measuring. Read-only.
 */
export const legacyDocSize = internalQuery({
  args: { doc: v.string(), cap: v.optional(v.number()) },
  handler: async (ctx, { doc, cap }) => {
    const limit = Math.min(cap ?? 3000, 6000);
    const rows = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc", (q) => q.eq("doc", doc))
      .take(limit);
    let bytes = 0;
    const byCollection = new Map<string, number>();
    for (const r of rows as any[]) {
      try { bytes += JSON.stringify(r.payload ?? "").length; } catch { /* skip */ }
      const c = String(r.collection);
      byCollection.set(c, (byCollection.get(c) ?? 0) + 1);
    }
    return {
      doc,
      rowsRead: rows.length,
      hitCap: rows.length >= limit,
      approxMB: Number((bytes / 1048576).toFixed(2)),
      avgRowKB: rows.length ? Number((bytes / rows.length / 1024).toFixed(1)) : 0,
      collections: [...byCollection.entries()].map(([c, n]) => ({ collection: c, rows: n })),
    };
  },
});

/**
 * Which staff can actually see students, and which cannot?
 *
 * The launch-day question behind "she says she cannot see her rosters".
 * A classroom teacher with no psRoster rows sees NOBODY -- deliberately, since
 * absent data must not read as unrestricted access. So this counts, per staff
 * member, how many roster rows join to their address. Staff addresses and
 * counts only; no student rows.
 */
export const rosterCoverageByStaff = internalQuery({
  args: {},
  handler: async (ctx) => {
    const staff = await ctx.db.query("teachers").take(2000);
    const roster = await ctx.db.query("psRoster").take(4000);

    const sectionsByEmail = new Map<string, Set<string>>();
    for (const r of roster as any[]) {
      const em = typeof r.teacherEmail === "string" ? r.teacherEmail.toLowerCase() : "";
      if (!em) continue;
      const set = sectionsByEmail.get(em) ?? new Set<string>();
      set.add(String(r.sectionId ?? "?"));
      sectionsByEmail.set(em, set);
    }

    const rows = (staff as any[]).map((t) => {
      const em = String(t.email || "").toLowerCase();
      const ps = String(t.psEmail || "").toLowerCase();
      const sections = (sectionsByEmail.get(em)?.size ?? 0) || (sectionsByEmail.get(ps)?.size ?? 0);
      return { name: t.name, email: t.email, role: t.role, sections };
    });

    // Roster addresses that match no staff record at all -- vacancies and
    // teachers PowerSchool knows under a name the app has never seen.
    const staffEmails = new Set(rows.map((r) => String(r.email || "").toLowerCase()));
    const orphanRoster = [...sectionsByEmail.entries()]
      .filter(([em]) => !staffEmails.has(em))
      .map(([em, set]) => ({ teacherEmail: em, sections: set.size }));

    const seesAll = ["admin", "superadmin", "campusaide", "pbis"];
    return {
      staff: rows.length,
      withSections: rows.filter((r) => r.sections > 0).length,
      blockedTeachers: rows
        .filter((r) => r.sections === 0 && !seesAll.includes(String(r.role)))
        .map((r) => ({ name: r.name, email: r.email, role: r.role })),
      unaffectedBecauseTheySeeEveryone: rows.filter((r) => r.sections === 0 && seesAll.includes(String(r.role))).length,
      orphanRoster,
    };
  },
});

/**
 * Exactly what me:get would return for one teacher, run through the SAME
 * index. Read-only, and it counts students rather than naming them.
 *
 * The previous version of this probe scanned psRoster with .take(4000) and
 * reported 0 sections for a teacher who has 8, because her rows sit past the
 * cap in a 5,564 row table. That is the difference between "the SIS does not
 * know her" and "my probe could not see her", and they lead to opposite
 * conclusions about a teacher standing in front of a class.
 */
export const sectionsForTeacher = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const want = email.trim().toLowerCase();
    const rows = await ctx.db
      .query("psRoster")
      .withIndex("by_teacherEmail", (q) => q.eq("teacherEmail", want))
      .collect();

    const bySection = new Map<string, { course: string | null; period: string | null; students: number }>();
    for (const r of rows as any[]) {
      const id = String(r.sectionId ?? `${r.courseNumber}-${r.sectionNumber}`);
      const e = bySection.get(id) ?? { course: r.courseName ?? null, period: r.period ?? null, students: 0 };
      e.students += 1;
      bySection.set(id, e);
    }
    return {
      email: want,
      rows: rows.length,
      sectionCount: bySection.size,
      sections: [...bySection.entries()].map(([sectionId, v]) => ({ sectionId, ...v })),
    };
  },
});

export const jobTitlesFor = internalQuery({
  args: { emails: v.array(v.string()) },
  handler: async (ctx, { emails }) => {
    const want = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
    const dir = await ctx.db.query("entraDirectory").take(3000);
    const hits = new Map<string, string | null>();
    for (const d of dir as any[]) {
      const em = String(d.email || "").toLowerCase();
      if (want.has(em)) hits.set(em, d.jobTitle ?? null);
    }
    return [...want].map((email) => ({
      email,
      jobTitle: hits.has(email) ? hits.get(email) : "(not in directory)",
    }));
  },
});

/**
 * psRoster, one page at a time, summarised per teacher.
 *
 * PAGINATED BECAUSE .take(4000) LIED. psRoster holds 5,564 rows, so every
 * probe that read it with a cap saw a PREFIX, and the conclusions drawn from
 * those -- "only 25 teachers have sections", "18 teachers are blocked" -- were
 * artefacts of the cap rather than facts about the school. The caller
 * aggregates across pages.
 */
export const rosterPage = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("psRoster").paginate({
      cursor: cursor ?? null, numItems: 1000,
    });
    const byTeacher: Record<string, string[]> = {};
    for (const r of page.page as any[]) {
      const em = typeof r.teacherEmail === "string" ? r.teacherEmail.toLowerCase() : "";
      if (!em) continue;
      (byTeacher[em] ??= []).push(String(r.sectionId ?? "?"));
    }
    return { byTeacher, rows: page.page.length, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/** Staff records, paged, so this comparison is not capped either. */
export const staffPage = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("teachers").paginate({
      cursor: cursor ?? null, numItems: 500,
    });
    return {
      staff: (page.page as any[]).map((t) => ({
        name: t.name, email: String(t.email || "").toLowerCase(),
        psEmail: String(t.psEmail || "").toLowerCase(), role: t.role,
      })),
      cursor: page.continueCursor, isDone: page.isDone,
    };
  },
});

/**
 * Do one teacher's SIS students join to the app's student records?
 *
 * scopeStudents matches psRoster rows to the students array on studentNumber.
 * A teacher can have eight perfectly good sections and still see NOBODY if the
 * numbers on those rows match no student record -- which looks identical, from
 * the teacher's chair, to having no roster at all. Counts only.
 */
export const rosterJoinForTeacher = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const want = email.trim().toLowerCase();
    const rows = await ctx.db
      .query("psRoster")
      .withIndex("by_teacherEmail", (q) => q.eq("teacherEmail", want))
      .collect();

    let matched = 0, unmatched = 0, noNumber = 0;
    const sampleUnmatched: string[] = [];
    const enrolledMatched = new Set<string>();
    for (const r of rows as any[]) {
      const num = r.studentNumber ? String(r.studentNumber) : "";
      if (!num) { noNumber++; continue; }
      const st = await ctx.db
        .query("students")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", num))
        .first();
      if (st) {
        matched++;
        if ((st as any).enrolled !== false) enrolledMatched.add(num);
      } else {
        unmatched++;
        if (sampleUnmatched.length < 5) sampleUnmatched.push(num);
      }
    }
    return {
      email: want,
      rosterRows: rows.length,
      matchedToAppStudent: matched,
      matchedAndEnrolled: enrolledMatched.size,
      unmatched,
      rowsWithNoStudentNumber: noNumber,
      sampleUnmatched,
    };
  },
});

/**
 * Duplicate studentNumbers, which .unique() answers by THROWING.
 *
 * views_app:teacherRoster looks each of a teacher's students up with
 * .unique(). Two records sharing a number is a data fault, and .unique()
 * reports a data fault by throwing a plain Error, which Convex redacts to
 * "Server Error" in production -- taking down that teacher's WHOLE roster
 * fetch, not just the one student. From her chair that is indistinguishable
 * from having no classes at all. Paged, so this probe is not itself capped.
 */
export const duplicateStudentNumbers = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("students").paginate({
      cursor: cursor ?? null, numItems: 500,
    });
    const seen: Record<string, number> = {};
    for (const s of page.page as any[]) {
      const n = s.studentNumber ? String(s.studentNumber) : "";
      if (!n) continue;
      seen[n] = (seen[n] ?? 0) + 1;
    }
    return { counts: seen, rows: page.page.length, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/** How many 11th graders, and what SIS data exists for them? Read-only, counts. */
export const gradeElevenShape = internalQuery({
  args: {},
  handler: async (ctx) => {
    const students = await ctx.db.query("students").take(2000);
    const eleven = (students as any[]).filter(
      (s) => String(s.grade ?? "").trim() === "11" && s.enrolled !== false,
    );
    const numbers = new Set(eleven.map((s) => String(s.studentNumber ?? "")).filter(Boolean));
    const grades = await ctx.db.query("psGrades").take(4000);
    const withGrades = new Set(
      (grades as any[]).map((g) => String(g.studentNumber ?? "")).filter((n) => numbers.has(n)),
    );
    const courses = new Set(
      (grades as any[])
        .filter((g) => numbers.has(String(g.studentNumber ?? "")))
        .map((g) => String(g.courseName ?? "")),
    );
    return {
      enrolledGrade11: eleven.length,
      withStudentNumber: numbers.size,
      withAnyGradeRow: withGrades.size,
      distinctCoursesSeen: [...courses].filter(Boolean).slice(0, 25),
    };
  },
});

/**
 * What do audit entries actually look like, and is the ACTOR recorded?
 *
 * "Who gave what" is the question the PBIS team opens this log to answer, so
 * an entry with no attributable adult is worse than a missing entry: it looks
 * like a record. Read-only; staff names and field names, no student rows.
 */
export const auditShape = internalQuery({
  args: { sinceIso: v.optional(v.string()) },
  handler: async (ctx, { sinceIso }) => {
    const rows = await ctx.db
      .query("appAuditLog")
      .withIndex("by_timestamp")
      .order("desc")
      .take(1500);
    const recent = sinceIso ? rows.filter((r) => String(r.timestamp) >= sinceIso) : rows;

    const keyCounts: Record<string, number> = {};
    const actorFields = ["teacher", "teacherName", "userId", "user", "awardedBy", "staff", "by"];
    const withActor: Record<string, number> = {};
    let noActorAtAll = 0;
    const actionCounts: Record<string, number> = {};

    for (const r of recent) {
      const p = (r as any).payload ?? {};
      for (const k of Object.keys(p)) keyCounts[k] = (keyCounts[k] ?? 0) + 1;
      const act = String(p.action ?? "(none)");
      actionCounts[act] = (actionCounts[act] ?? 0) + 1;
      let found = false;
      for (const f of actorFields) {
        const v = p[f];
        if (typeof v === "string" && v.trim()) { withActor[f] = (withActor[f] ?? 0) + 1; found = true; }
      }
      if (!found) noActorAtAll++;
    }

    return {
      scanned: rows.length,
      inWindow: recent.length,
      payloadKeys: Object.entries(keyCounts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`),
      actorFieldsPresent: Object.entries(withActor).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`),
      entriesWithNoActorAtAll: noActorAtAll,
      actions: Object.entries(actionCounts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`),
    };
  },
});

/** Audit entries whose shape differs from the app's own. Read-only. */
export const auditOddities = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("appAuditLog").withIndex("by_timestamp").order("desc").take(600);
    const odd: any[] = [];
    for (const r of rows) {
      const p = (r as any).payload ?? {};
      const missing = !p.entryId || !p.reason;
      if (missing) {
        odd.push({
          rowEntryId: (r as any).entryId ?? null,
          payloadEntryId: p.entryId ?? null,
          action: p.action ?? null,
          teacher: p.teacher ?? null,
          hasReason: typeof p.reason === "string",
          hasDetails: typeof p.details === "string",
          timestamp: r.timestamp,
        });
      }
    }
    return { scanned: rows.length, oddCount: odd.length, odd: odd.slice(0, 10) };
  },
});

/** Every "Changed access level" entry, to see whether they multiply. Read-only. */
export const roleAuditGrowth = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("appAuditLog").withIndex("by_timestamp").order("desc").take(2000);
    const hits = rows.filter((r) => String(((r as any).payload ?? {}).action ?? "") === "Changed access level");
    const byTimestamp: Record<string, number> = {};
    for (const h of hits) byTimestamp[String(h.timestamp)] = (byTimestamp[String(h.timestamp)] ?? 0) + 1;
    return {
      total: hits.length,
      distinctMoments: Object.keys(byTimestamp).length,
      copiesPerMoment: Object.entries(byTimestamp).map(([t, n]) => ({ at: t, rows: n })),
      withoutPayloadEntryId: hits.filter((h) => !((h as any).payload ?? {}).entryId).length,
      details: hits.slice(0, 6).map((h) => ({
        rowEntryId: (h as any).entryId,
        payloadEntryId: ((h as any).payload ?? {}).entryId ?? null,
        details: ((h as any).payload ?? {}).details ?? null,
      })),
    };
  },
});

/**
 * Give any audit entry whose payload lacks an entryId the one from its column.
 *
 * NOT a delete. An audit row is a record of something that happened, and the
 * fix for a badly shaped one is to shape it correctly, not to remove it. The
 * only change is adding the id the row already has, which is what stops a
 * browser deriving its own and uploading the event a second time.
 *
 * Idempotent: an entry that already carries one is left alone, so this can be
 * re-run safely. Paged, because a delete-or-patch loop over the whole log is
 * past the read limit.
 */
export const repairAuditPayloadIds = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const take = Math.min(limit ?? 400, 800);
    const rows = await ctx.db
      .query("appAuditLog").withIndex("by_timestamp").order("desc").take(take);

    let patched = 0, alreadyFine = 0, noColumnId = 0;
    const examples: string[] = [];
    for (const r of rows) {
      const p = ((r as any).payload ?? {}) as Record<string, unknown>;
      if (typeof p.entryId === "string" && p.entryId) { alreadyFine++; continue; }
      const id = (r as any).entryId;
      if (typeof id !== "string" || !id) { noColumnId++; continue; }
      await ctx.db.patch(r._id, { payload: { ...p, entryId: id } });
      patched++;
      if (examples.length < 5) examples.push(`${id} (${String(p.action ?? "?")})`);
    }
    return { scanned: rows.length, patched, alreadyFine, noColumnId, examples };
  },
});

/** How heavy is a full students read? Paged so the probe cannot blow the limit. */
export const studentsTableSize = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("students").paginate({
      cursor: cursor ?? null, numItems: 200,
    });
    let bytes = 0, txBytes = 0;
    for (const s of page.page as any[]) {
      try { bytes += JSON.stringify(s).length; } catch { /* skip */ }
      try { txBytes += JSON.stringify(s.wildcatCashTransactions ?? []).length; } catch { /* skip */ }
    }
    return { rows: page.page.length, bytes, txBytes, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/** What the leaderboard actually counts, versus what the roster says. Read-only. */
export const leaderboardCounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("students").collect();
    const enrolledTrue = all.filter((s: any) => s.enrolled === true).length;
    const enrolledFalse = all.filter((s: any) => s.enrolled === false).length;
    const enrolledMissing = all.filter((s: any) => s.enrolled === undefined || s.enrolled === null).length;

    // The rule the leaderboard uses.
    const pool = all.filter((s: any) => s.enrolled !== false);
    const withEarned = pool.filter(
      (s: any) => typeof s.wildcatCashEarned === "number" &&
                  Number.isFinite(s.wildcatCashEarned) && s.wildcatCashEarned >= 0,
    ).length;
    const zeroEarned = pool.filter((s: any) => s.wildcatCashEarned === 0).length;

    return {
      studentsTable: all.length,
      enrolledTrue,
      enrolledFalse,
      enrolledMissingField: enrolledMissing,
      leaderboardPool: pool.length,
      rankedOnTheBoard: withEarned,
      unknownEarned: pool.length - withEarned,
      ofWhichZero: zeroEarned,
    };
  },
});

/** The leaderboard pool with enrolment DERIVED, as appData does it. Read-only. */
export const leaderboardCountsFixed = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rosterRows = await ctx.db.query("psRoster").collect();
    const enrolledNumbers = new Set(rosterRows.map((r) => r.studentNumber).filter(Boolean));
    const all = await ctx.db.query("students").collect();
    const enrolled = all.filter((s: any) => s.studentNumber && enrolledNumbers.has(s.studentNumber));
    const ranked = enrolled.filter(
      (s: any) => typeof s.wildcatCashEarned === "number" &&
                  Number.isFinite(s.wildcatCashEarned) && s.wildcatCashEarned >= 0,
    );
    return {
      docsRead: rosterRows.length + all.length,
      studentsTable: all.length,
      enrolledDerived: enrolled.length,
      former: all.length - enrolled.length,
      rankedOnBoard: ranked.length,
      unknownEarned: enrolled.length - ranked.length,
    };
  },
});

/** Same answer, per-student index lookups instead of a full psRoster scan. */
export const leaderboardCostProbe = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("students").collect();
    let enrolled = 0, lookups = 0;
    for (const s of all as any[]) {
      if (!s.studentNumber) continue;
      const hit = await ctx.db
        .query("psRoster")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", s.studentNumber))
        .first();
      lookups++;
      if (hit) enrolled++;
    }
    return {
      studentsTable: all.length,
      indexLookups: lookups,
      approxDocsRead: all.length + lookups,
      enrolledDerived: enrolled,
    };
  },
});

/** What calendar data the app actually holds right now. Read-only. */
export const calendarStateToday = internalQuery({
  args: {},
  handler: async (ctx) => {
    const bell = await ctx.db.query("bellSchedules").take(200);
    const att = await ctx.db.query("psAttendance").take(5);
    const terms = new Set<string>();
    let first: string | null = null, last: string | null = null;
    for (const a of att as any[]) {
      if (a.termId) terms.add(String(a.termId));
      if (a.termFirstDay && !first) first = a.termFirstDay;
      if (a.termLastDay && !last) last = a.termLastDay;
    }
    return {
      bellScheduleRows: bell.length,
      bellScheduleSample: bell.slice(0, 2).map((b: any) => Object.keys(b)),
      termIdsSeen: [...terms],
      termFirstDay: first,
      termLastDay: last,
    };
  },
});

/** Every distinct course/period pair that looks like Promise Time. Read-only. */
export const promiseTimeShape = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("psRoster").paginate({
      cursor: cursor ?? null, numItems: 1000,
    });
    const pairs: Record<string, number> = {};
    const allPeriods: Record<string, number> = {};
    for (const r of page.page as any[]) {
      const course = String(r.courseName ?? "");
      const period = String(r.period ?? "?");
      allPeriods[period] = (allPeriods[period] ?? 0) + 1;
      if (/promise/i.test(course)) {
        const k = course + " || " + period;
        pairs[k] = (pairs[k] ?? 0) + 1;
      }
    }
    return { pairs, allPeriods, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/** The actual contents of the hand-entered bell schedules. Read-only. */
export const bellScheduleContents = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("bellSchedules").take(50);
    return rows.map((r: any) => ({
      name: r.name,
      active: r.active,
      weekdays: r.weekdays,
      periodCount: Array.isArray(r.periods) ? r.periods.length : 0,
      periods: Array.isArray(r.periods) ? r.periods.slice(0, 14) : null,
    }));
  },
});

/** Can enrolled students actually sign in? Counts only, no addresses. Read-only. */
export const studentSignInReadiness = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("students").collect();
    let enrolled = 0, withEmail = 0, noEmail = 0, badDomain = 0;
    const domains: Record<string, number> = {};
    for (const s of all as any[]) {
      if (!s.studentNumber) continue;
      const hit = await ctx.db
        .query("psRoster")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", s.studentNumber))
        .first();
      if (!hit) continue;
      enrolled++;
      const em = String(s.email || "").trim().toLowerCase();
      if (!em) { noEmail++; continue; }
      withEmail++;
      const d = em.split("@")[1] || "(none)";
      domains[d] = (domains[d] ?? 0) + 1;
      if (d !== "westbrookacademy.org") badDomain++;
    }
    return { enrolled, withEmail, noEmail, badDomain, domains };
  },
});

/**
 * Sign-in readiness, with the few problem cases named so the office can fix
 * them. Student NUMBERS and grades only -- no names, no addresses beyond the
 * domain, because this is a diagnostic and not an export.
 */
export const signInReadinessDetail = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("students").collect();
    const missing: any[] = [];
    const oddDomain: any[] = [];
    let enrolled = 0, ok = 0;
    const domains: Record<string, number> = {};
    for (const s of all as any[]) {
      if (!s.studentNumber) continue;
      const hit = await ctx.db
        .query("psRoster")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", s.studentNumber))
        .first();
      if (!hit) continue;
      enrolled++;
      const em = String(s.email || "").trim().toLowerCase();
      if (!em) {
        missing.push({ studentNumber: s.studentNumber, grade: s.grade ?? null });
        continue;
      }
      const d = em.split("@")[1] || "(malformed)";
      domains[d] = (domains[d] ?? 0) + 1;
      if (d !== "westbrookacademy.org") {
        oddDomain.push({ studentNumber: s.studentNumber, grade: s.grade ?? null, domain: d });
      } else ok++;
    }
    // Real-world proof: distinct students who have actually signed in.
    const auth = await ctx.db.query("authEvents").collect();
    const studentSignIns = new Set(
      auth.filter((a: any) => a.kind === "student").map((a: any) => a.email),
    );
    return {
      enrolled,
      readyToSignIn: ok,
      noEmail: missing.length,
      missing,
      oddDomain,
      domains,
      distinctStudentsWhoHaveActuallySignedIn: studentSignIns.size,
    };
  },
});

/**
 * Could a reward be gated on "C or better in every class"? Counts only.
 *
 * The question is not whether the data exists but whether it is COMPLETE
 * enough to refuse a child with. A student blocked because a teacher has not
 * posted grades yet has been punished for an adult's paperwork.
 */
export const gradeGateFeasibility = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("psGrades").paginate({
      cursor: cursor ?? null, numItems: 1000,
    });
    const byStudent: Record<string, { rows: number; withLetter: number; withPct: number; letters: string[]; pcts: number[] }> = {};
    for (const g of page.page as any[]) {
      const n = String(g.studentNumber ?? "");
      if (!n) continue;
      const e = byStudent[n] ?? { rows: 0, withLetter: 0, withPct: 0, letters: [], pcts: [] };
      e.rows++;
      const L = typeof g.currentGrade === "string" ? g.currentGrade.trim() : "";
      const P = typeof g.currentPercent === "number" && Number.isFinite(g.currentPercent) ? g.currentPercent : null;
      if (L) { e.withLetter++; e.letters.push(L); }
      if (P !== null) { e.withPct++; e.pcts.push(P); }
      byStudent[n] = e;
    }
    return { byStudent, rows: page.page.length, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/** What Academics Mode could actually compute today. Counts only. Read-only. */
export const academicsDataAudit = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("psGrades").paginate({
      cursor: cursor ?? null, numItems: 1000,
    });
    let withLetter = 0, withPercent = 0, both = 0, neither = 0;
    const sources: Record<string, number> = {};
    const courses: Record<string, Set<string>> = {};   // course -> sectionIds
    const bubble: Record<string, number> = {};
    for (const g of page.page as any[]) {
      const L = typeof g.currentGrade === "string" && g.currentGrade.trim() && g.currentGrade !== "--";
      const P = typeof g.currentPercent === "number" && Number.isFinite(g.currentPercent);
      if (L) withLetter++;
      if (P) withPercent++;
      if (L && P) both++;
      if (!L && !P) neither++;
      const src = String(g.gradeSource ?? "(none)");
      sources[src] = (sources[src] ?? 0) + 1;
      const cn = String(g.courseName ?? "(none)");
      (courses[cn] ??= new Set()).add(String(g.sectionId ?? "?"));
      if (P) {
        const v = g.currentPercent as number;
        if (v >= 55 && v < 65) bubble["55-65"] = (bubble["55-65"] ?? 0) + 1;
        if (v >= 65 && v < 70) bubble["65-70"] = (bubble["65-70"] ?? 0) + 1;
      }
    }
    return {
      rows: page.page.length,
      withLetter, withPercent, both, neither, sources, bubble,
      coursesToSections: Object.fromEntries(
        Object.entries(courses).map(([c, set]) => [c, [...set]]),
      ),
      cursor: page.continueCursor, isDone: page.isDone,
    };
  },
});

/** How many courses have enough graded students to report a rate? Counts only. */
export const courseFailureShape = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("psGrades").collect();
    const byCourse = new Map<string, { name: string; graded: number; df: number }>();
    let pct = 0, band5565 = 0, band6570 = 0;
    const letters: Record<string, number> = {};
    for (const g of all as any[]) {
      const L = typeof g.currentGrade === "string" ? g.currentGrade.trim().toUpperCase() : "";
      if (L) letters[L] = (letters[L] ?? 0) + 1;
      const P = typeof g.currentPercent === "number" && Number.isFinite(g.currentPercent) ? g.currentPercent : null;
      if (P !== null) { pct++; if (P >= 55 && P < 65) band5565++; if (P >= 65 && P < 70) band6570++; }
      if (!["A","B","C","D","F"].includes(L)) continue;
      const key = String(g.courseNumber ?? g.courseName ?? "?");
      const e = byCourse.get(key) ?? { name: String(g.courseName ?? key), graded: 0, df: 0 };
      e.graded++; if (L === "D" || L === "F") e.df++;
      byCourse.set(key, e);
    }
    const rows = [...byCourse.values()];
    return {
      coursesWithAnyGrades: rows.length,
      coursesWith10PlusGraded: rows.filter((r) => r.graded >= 10).length,
      coursesWith20PlusGraded: rows.filter((r) => r.graded >= 20).length,
      worstFew: rows.filter((r) => r.graded >= 20).sort((a, b) => (b.df / b.graded) - (a.df / a.graded))
        .slice(0, 6).map((r) => ({ course: r.name, graded: r.graded, df: r.df, rate: Math.round((r.df / r.graded) * 100) })),
      rowsWithPercent: pct, band5565, band6570, letters,
    };
  },
});

/** Every distinct course name with its graded count. Counts only; no student. */
export const courseNameCatalogue = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("psGrades").collect();
    const byCourse = new Map<string, { name: string; number: string; rows: number; graded: number; df: number }>();
    for (const g of all as any[]) {
      const name = String(g.courseName ?? "").trim();
      const num = String(g.courseNumber ?? "").trim();
      const key = num || name || "?";
      const e = byCourse.get(key) ?? { name: name || "(unnamed)", number: num, rows: 0, graded: 0, df: 0 };
      e.rows++;
      const L = typeof g.currentGrade === "string" ? g.currentGrade.trim().toUpperCase() : "";
      if (["A", "B", "C", "D", "F"].includes(L)) { e.graded++; if (L === "D" || L === "F") e.df++; }
      byCourse.set(key, e);
    }
    return {
      total: byCourse.size,
      courses: [...byCourse.values()].sort((a, b) => b.rows - a.rows),
    };
  },
});

/**
 * Can a senior-eligibility screen be built from what is synced? Counts only.
 *
 * Read-only. Returns no student number, no name and no assignment title: only
 * how many of each thing exists, so the question "is the data there" can be
 * answered without pulling a single child's record onto a terminal.
 */
export const seniorEligibilityFeasibility = internalQuery({
  args: {},
  handler: async (ctx) => {
    const roster = await ctx.db.query("psRoster").collect();
    const byGrade: Record<string, number> = {};
    const seniors = new Set<string>();
    for (const r of roster as any[]) {
      const g = String(r.gradeLevel ?? "?").trim() || "?";
      byGrade[g] = (byGrade[g] ?? 0) + 1;
      if (g === "12") seniors.add(String(r.studentNumber ?? ""));
    }

    const grades = await ctx.db.query("psGrades").collect();
    let seniorGradeRows = 0, seniorFailingRows = 0;
    const letters: Record<string, number> = {};
    const seniorsWithAnyMark = new Set<string>();
    const seniorsFailing = new Set<string>();
    const seniorsFailingFOnly = new Set<string>();
    const seniorsWithADOnly = new Set<string>();
    for (const g of grades as any[]) {
      const sn = String(g.studentNumber ?? "");
      if (!seniors.has(sn)) continue;
      const L = typeof g.currentGrade === "string" ? g.currentGrade.trim().toUpperCase() : "";
      if (!L || L === "--") continue;
      seniorGradeRows++;
      seniorsWithAnyMark.add(sn);
      letters[L] = (letters[L] ?? 0) + 1;
      if (L === "D" || L === "F" || L === "NP") { seniorFailingRows++; seniorsFailing.add(sn); }
      if (L === "F" || L === "NP") { seniorsFailingFOnly.add(sn); }
      if (L === "D") { seniorsWithADOnly.add(sn); }
    }

    const missing = await ctx.db.query("psMissingWork").collect();
    let seniorMissingRows = 0, flagged = 0, scoredZero = 0, withName = 0, withDue = 0;
    const seniorsWithMissing = new Set<string>();
    for (const m of missing as any[]) {
      const sn = String(m.studentNumber ?? "");
      if (!seniors.has(sn)) continue;
      seniorMissingRows++;
      seniorsWithMissing.add(sn);
      if (m.isMissing !== false) flagged++; else scoredZero++;
      if (m.assignmentName) withName++;
      if (m.dueDate) withDue++;
    }

    const points = await ctx.db.query("psSectionPoints").collect();
    const seniorPointRows = (points as any[]).filter((p) => seniors.has(String(p.studentNumber ?? ""))).length;

    return {
      rosterRows: roster.length,
      byGrade,
      seniors: seniors.size,
      seniorGradeRows,
      seniorsWithAnyMark: seniorsWithAnyMark.size,
      seniorFailingRows,
      seniorLetters: letters,
      seniorsFailingAtLeastOne: seniorsFailing.size,
      seniorsWithAtLeastOneF: seniorsFailingFOnly.size,
      seniorsWhoseWorstIsADOnly: [...seniorsWithADOnly].filter((s2) => !seniorsFailingFOnly.has(s2)).length,
      missingWorkTableRows: missing.length,
      seniorMissingRows,
      seniorsWithMissing: seniorsWithMissing.size,
      missingFlagged: flagged,
      missingScoredZero: scoredZero,
      missingWithName: withName,
      missingWithDueDate: withDue,
      sectionPointsTableRows: points.length,
      seniorPointRows,
    };
  },
});

/**
 * Do the two places that know a student's grade level agree?
 *
 * `students.grade` is the app's own roster, adopted in place from PowerSchool.
 * `psRoster.gradeLevel` is the raw sync mirror, one row per enrolment. A senior
 * screen has to pick one, and picking the wrong one silently drops or adds
 * eighteen-year-olds from an eligibility list. Counts and overlaps only; no
 * name, no student number.
 */
export const seniorSourceAgreement = internalQuery({
  args: {},
  handler: async (ctx) => {
    const students = await ctx.db.query("students").collect();
    const roster = await ctx.db.query("psRoster").collect();

    const appSeniors = new Set<string>();
    let appNoNumber = 0, appSeniorsMissingName = 0;
    for (const s of students as any[]) {
      const n = String(s.studentNumber ?? "").trim();
      if (!n) { appNoNumber++; continue; }
      if (String(s.grade ?? "").trim() === "12") {
        appSeniors.add(n);
        if (!String(s.firstName ?? "").trim() || !String(s.lastName ?? "").trim()) appSeniorsMissingName++;
      }
    }

    const sisSeniors = new Set<string>();
    for (const r of roster as any[]) {
      if (String(r.gradeLevel ?? "").trim() === "12") sisSeniors.add(String(r.studentNumber ?? "").trim());
    }
    sisSeniors.delete("");

    const inBoth = [...appSeniors].filter((n) => sisSeniors.has(n)).length;
    return {
      studentsTableRows: students.length,
      studentsWithNoNumber: appNoNumber,
      seniorsByAppRoster: appSeniors.size,
      seniorsBySisMirror: sisSeniors.size,
      inBoth,
      onlyInAppRoster: appSeniors.size - inBoth,
      onlyInSisMirror: sisSeniors.size - inBoth,
      appSeniorsMissingAName: appSeniorsMissingName,
    };
  },
});

/**
 * Does the senior list actually work against live data?
 *
 * REDACTED ON PURPOSE. The real query is admin-gated and returns names, which
 * is right for a browser and wrong for a terminal transcript. This mirrors its
 * logic and returns SHAPE AND COUNTS ONLY: how many rows, how many of each
 * kind, and whether the fields a screen needs are populated. No name, no
 * student number, no course, no assignment title.
 */
export const seniorListShape = internalQuery({
  args: {},
  handler: async (ctx) => {
    const enrolments = await ctx.db
      .query("psRoster")
      .withIndex("by_gradeLevel", (q) => q.eq("gradeLevel", "12"))
      .collect();
    const keys = new Set<string>();
    let noNumber = 0;
    for (const r of enrolments as any[]) {
      const k = String(r.studentNumber ?? "").trim();
      if (!k) { noNumber++; continue; }
      keys.add(k);
    }

    let named = 0, withGrades = 0, withMissing = 0, withPoints = 0;
    let failingAny = 0, noMarkAtAll = 0, someUnposted = 0;
    let periodsPresent = 0, teacherEmailsPresent = 0, lastUpdatePresent = 0;
    const failingCounts: Record<string, number> = {};
    for (const k of keys) {
      const nm = await ctx.db.query("students")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", k)).take(1);
      if (nm[0] && String(nm[0].firstName ?? "").trim()) named++;

      const g = await ctx.db.query("psGrades")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", k)).collect();
      const m = await ctx.db.query("psMissingWork")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", k)).collect();
      const p = await ctx.db.query("psSectionPoints")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", k)).collect();
      if (g.length) withGrades++;
      if (m.length) withMissing++;
      if (p.length) withPoints++;
      if (g.some((r: any) => r.lastGradeUpdate)) lastUpdatePresent++;

      let fails = 0, unposted = 0, marks = 0;
      for (const row of g as any[]) {
        const L = typeof row.currentGrade === "string" ? row.currentGrade.trim().toUpperCase() : "";
        if (!L || L === "--" || L === "-") { unposted++; continue; }
        marks++;
        if (L === "NP" || L.charAt(0) === "F" || L.charAt(0) === "D") fails++;
      }
      if (marks === 0) noMarkAtAll++;
      else if (fails > 0) failingAny++;
      if (unposted > 0) someUnposted++;
      const bucket = marks === 0 ? "no marks" : String(fails);
      failingCounts[bucket] = (failingCounts[bucket] ?? 0) + 1;
    }

    for (const r of enrolments as any[]) {
      if (r.period) periodsPresent++;
      if (r.teacherEmail) teacherEmailsPresent++;
    }

    return {
      indexWorked: true,
      enrolmentRows: enrolments.length,
      seniors: keys.size,
      enrolmentsWithNoStudentNumber: noNumber,
      seniorsWithAName: named,
      seniorsWithGradeRows: withGrades,
      seniorsWithMissingWork: withMissing,
      seniorsWithSectionPoints: withPoints,
      seniorsWithLastGradeUpdate: lastUpdatePresent,
      failingAny,
      noMarkAtAll,
      someUnposted,
      failingCountHistogram: failingCounts,
      enrolmentsWithPeriod: periodsPresent,
      enrolmentsWithTeacherEmail: teacherEmailsPresent,
    };
  },
});

/** Does the class/support split still account for every course? Counts only. */
export const courseSplitAddsUp = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("psGrades").collect();
    const byCourse = new Map<string, { name: string; rows: number; marked: number; graded: number; failing: number }>();
    for (const g of all as any[]) {
      const name = String(g.courseName ?? "").trim();
      const key = String(g.courseNumber ?? "") || name || "(unnamed)";
      const e = byCourse.get(key) ?? { name, rows: 0, marked: 0, graded: 0, failing: 0 };
      e.rows++;
      const L = typeof g.currentGrade === "string" ? g.currentGrade.trim().toUpperCase() : "";
      if (L && L !== "--" && L !== "-") e.marked++;
      if (["A", "B", "C", "D", "F"].includes(L)) { e.graded++; if (L === "D" || L === "F") e.failing++; }
      byCourse.set(key, e);
    }
    let unrated = 0, withheld = 0, notRanked = 0, cls = 0, sup = 0;
    const schoolCoverage = 0.774, floor = Math.max(0.5, schoolCoverage - 0.15);
    for (const c of byCourse.values()) {
      if (isUnratedCohort(c.name)) { unrated++; continue; }
      const cell = courseCell({ label: c.name, graded: c.graded, failing: c.failing, rows: c.rows, markedRows: c.marked });
      if (cell.withheld !== null) { withheld++; continue; }
      if (!cell.rankable || (cell.coverage ?? 0) < floor) { notRanked++; continue; }
      if (isSupportBlock(c.name)) sup++; else cls++;
    }
    const total = byCourse.size;
    return {
      total, classesRanked: cls, supportRanked: sup, notRanked, withheld, unrated,
      sum: cls + sup + notRanked + withheld + unrated,
      addsUp: cls + sup + notRanked + withheld + unrated === total,
    };
  },
});

/** Which legacyMirror docs/collections exist, so a probe can aim at the right one. */
export const mirrorShape = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("legacyMirror").collect();
    const counts: Record<string, number> = {};
    for (const r of rows as any[]) {
      const k = `${r.doc} / ${r.collection}`;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return { total: rows.length, buckets: counts };
  },
});

/**
 * Every distinct audit action string, and how many entries carry it.
 *
 * The browser's `auditLog` array comes from legacyMirror, not from the Convex
 * `auditLog` table, which is empty. This is the question to ask before
 * touching the dashboard feed's classifier or the Audit Log's filters: the
 * vocabulary is fixed and small (eighteen strings at the time of writing) and
 * both of those read it, so "what is actually in the log" is answerable and
 * worth answering rather than guessing at. dashboard-feed.test.mjs pins the
 * answer; run this when the test's list and reality might have drifted.
 */
export const auditActionCatalogue = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = (await ctx.db.query("legacyMirror").collect())
      .filter((r: any) => r.collection === "auditLog");
    const counts: Record<string, number> = {};
    for (const r of rows as any[]) {
      const a = String(r.payload?.action ?? "(none)");
      counts[a] = (counts[a] ?? 0) + 1;
    }
    return {
      totalEntries: rows.length,
      distinctActions: Object.keys(counts).length,
      actions: Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([action, n]) => ({ action, n })),
    };
  },
});

/**
 * Receipts whose stored status disagrees with the audit log. Read-only.
 *
 * applyFulfill and buildCancel used to change a receipt without setting
 * updatedAt, so legacyData.touchedAt scored the change 0, tied with the stored
 * copy, and lost. The audit entry for the same action DID persist (it carries
 * its own id and is an insert), so the log is the record of what really
 * happened and the receipt row is the one that reverted. This names the gap so
 * the desk can be told which receipts were actually handed over.
 */
export const receiptStatusDrift = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("legacyMirror").collect();
    const receipts = rows
      .filter((r: any) => r.collection === "cashReceipts")
      .map((r: any) => r.payload)
      .filter(Boolean);
    const audit = rows.filter((r: any) => r.collection === "auditLog");

    // "Handed over X, receipt R" / "Cancelled X, receipt R. reason"
    const idsIn = (action: string) => {
      const out = new Set<string>();
      for (const a of audit as any[]) {
        if (String(a.payload?.action ?? "") !== action) continue;
        const m = String(a.payload?.reason ?? "").match(/receipt ([A-Za-z0-9_-]+)/);
        if (m) out.add(m[1]);
      }
      return out;
    };
    const fulfilled = idsIn("reward_fulfilled");
    const cancelled = idsIn("reward_cancelled");

    const drift: any[] = [];
    for (const r of receipts as any[]) {
      const id = String(r.id ?? "");
      const status = String(r.status ?? "");
      const saysFulfilled = fulfilled.has(id);
      const saysCancelled = cancelled.has(id);
      if (saysFulfilled && status !== "fulfilled") {
        drift.push({ id, storedStatus: status, auditSays: "fulfilled", hasUpdatedAt: !!r.updatedAt });
      } else if (saysCancelled && status !== "cancelled") {
        drift.push({ id, storedStatus: status, auditSays: "cancelled", hasUpdatedAt: !!r.updatedAt });
      }
    }
    const byStatus: Record<string, number> = {};
    for (const r of receipts as any[]) {
      const k = String(r.status ?? "(none)");
      byStatus[k] = (byStatus[k] ?? 0) + 1;
    }
    // A receipt the log says was fulfilled but that is not stored AT ALL is a
    // different failure from one whose status reverted, and the loop above
    // cannot see it because it walks the stored rows. Missing rows are the old
    // bug fixed at script.js:3958 -- receipts were written to localStorage only
    // and came back as an empty array on every load -- not this one. Counting
    // them as "no drift" would have read as "nothing to repair".
    const storedIds = new Set((receipts as any[]).map((r) => String(r.id ?? "")));
    const goneFulfilled = [...fulfilled].filter((id) => !storedIds.has(id));
    const goneCancelled = [...cancelled].filter((id) => !storedIds.has(id));
    return {
      receipts: receipts.length,
      byStatus,
      withUpdatedAt: (receipts as any[]).filter((r) => !!r.updatedAt).length,
      auditSaysFulfilled: fulfilled.size,
      auditSaysCancelled: cancelled.size,
      drift,
      notStoredAtAll: { fulfilled: goneFulfilled, cancelled: goneCancelled },
      // When the fulfilments happened matters: cashReceipts only started going
      // through legacyData:mergeSlice on 2026-08-31 (see script.js:3958). A
      // fulfilment before that date was not exposed to this bug.
      fulfilTimes: (audit as any[])
        .filter((a) => String(a.payload?.action ?? "") === "reward_fulfilled")
        .map((a) => a.payload?.timestamp)
        .sort(),
    };
  },
});

/** The raw receipt rows and the fulfil/cancel audit lines, to check the match by eye. Read-only. */
export const receiptRawPeek = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("legacyMirror").collect();
    const receipts = rows
      .filter((r: any) => r.collection === "cashReceipts")
      .map((r: any) => ({
        id: r.payload?.id, status: r.payload?.status,
        purchasedAt: r.payload?.purchasedAt, fulfilledAt: r.payload?.fulfilledAt,
        cancelledAt: r.payload?.cancelledAt, updatedAt: r.payload?.updatedAt ?? null,
        reward: r.payload?.rewardName, doc: r.doc,
      }));
    const lines = rows
      .filter((r: any) => r.collection === "auditLog" &&
        /^reward_(fulfilled|cancelled|redemption)$/.test(String(r.payload?.action ?? "")))
      .map((r: any) => ({
        action: r.payload?.action, reason: r.payload?.reason,
        at: r.payload?.timestamp, doc: r.doc,
      }));
    return { receipts, lines };
  },
});

/**
 * For a named handful of students, every place the hub could hold an email.
 *
 * studentSignInReadiness reads students.email. The SIS writes
 * psRoster.studentEmail (manifest field 19). Those are two different fields and
 * "missing" in one is not missing in the other -- a student who signs in to a
 * Chromebook every morning HAS an address, so a null here is a pipeline
 * question, not a fact about the child. Read-only, and scoped to the numbers
 * passed in so it is a diagnostic and not an export.
 */
export const emailSources = internalQuery({
  args: { studentNumbers: v.array(v.string()) },
  handler: async (ctx, { studentNumbers }) => {
    const want = new Set(studentNumbers.map((n) => String(n).trim()));
    const students = (await ctx.db.query("students").collect())
      .filter((s: any) => want.has(String(s.studentNumber ?? "").trim()));
    const out: any[] = [];
    for (const s of students as any[]) {
      const num = String(s.studentNumber ?? "").trim();
      const roster = await ctx.db
        .query("psRoster")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", num))
        .collect();
      const rosterEmails = [
        ...new Set(roster.map((r: any) => r.studentEmail ?? null).filter(Boolean)),
      ];
      out.push({
        studentNumber: num,
        name: `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim(),
        grade: s.grade ?? null,
        studentsTable_email: s.email ?? null,
        psRoster_studentEmail: rosterEmails.length ? rosterEmails : null,
        rosterRows: roster.length,
      });
    }
    return out;
  },
});

/** How many enrolled students have an email in psRoster but not in students. Read-only. */
export const emailAdoptionGap = internalQuery({
  args: {},
  handler: async (ctx) => {
    const students = await ctx.db.query("students").collect();
    let enrolled = 0, bothHave = 0, rosterOnly = 0, studentsOnly = 0, neither = 0, differ = 0;
    const rosterOnlyNumbers: string[] = [];
    for (const s of students as any[]) {
      const num = String(s.studentNumber ?? "").trim();
      if (!num) continue;
      const row = await ctx.db
        .query("psRoster")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", num))
        .first();
      if (!row) continue;
      enrolled++;
      const hub = String(s.email ?? "").trim().toLowerCase();
      const sis = String((row as any).studentEmail ?? "").trim().toLowerCase();
      if (hub && sis) { bothHave++; if (hub !== sis) differ++; }
      else if (!hub && sis) { rosterOnly++; if (rosterOnlyNumbers.length < 25) rosterOnlyNumbers.push(num); }
      else if (hub && !sis) studentsOnly++;
      else neither++;
    }
    return { enrolled, bothHave, differ, rosterOnly, rosterOnlyNumbers, studentsOnly, neither };
  },
});

/**
 * The SHAPE of student addresses, as counts per pattern. No addresses returned.
 *
 * Four enrolled students have no email in PowerSchool, so the office has to
 * find or issue one. Knowing the convention the other 615 follow turns that
 * from a guess into a check. Classifies each local part against patterns built
 * from that student's OWN name and number, so the answer is the rule and not a
 * roster. Read-only.
 */
export const studentEmailPattern = internalQuery({
  args: {},
  handler: async (ctx) => {
    const students = await ctx.db.query("students").collect();
    const clean = (v: unknown) =>
      String(v ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]/g, "");
    const counts: Record<string, number> = {};
    const domains: Record<string, number> = {};
    let examined = 0;
    for (const s of students as any[]) {
      const em = String(s.email ?? "").trim().toLowerCase();
      if (!em.includes("@")) continue;
      const [local, domain] = em.split("@");
      domains[domain] = (domains[domain] ?? 0) + 1;
      examined++;
      const f = clean(s.firstName), l = clean(s.lastName), n = clean(s.studentNumber);
      const lp = clean(local);
      let label = "other";
      // The actual convention, read off a sample and then verified against all
      // 646: first initial + last initial + student number, lower case.
      if (f && l && n && lp === f[0] + l[0] + n) label = "finitial+linitial+number";
      else if (n && lp === n) label = "studentNumber";
      else if (f && l && lp === f + l) label = "firstlast";
      else if (f && l && lp === f[0] + l) label = "finitial+last";
      else if (f && l && lp === l + f) label = "lastfirst";
      else if (f && l && lp === f + l[0]) label = "first+linitial";
      else if (f && l && n && lp === f[0] + l + n) label = "finitial+last+number";
      else if (f && l && n && lp === f + l + n) label = "firstlast+number";
      else if (f && l && lp.startsWith(f[0] + l)) label = "finitial+last+suffix";
      else if (f && l && lp.startsWith(f + l)) label = "firstlast+suffix";
      counts[label] = (counts[label] ?? 0) + 1;
    }
    return { examined, patterns: counts, domains };
  },
});

/** Six real student addresses beside their names, to infer the convention by eye. Read-only. */
export const studentEmailSample = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const students = await ctx.db.query("students").collect();
    const out: any[] = [];
    for (const s of students as any[]) {
      const em = String(s.email ?? "").trim().toLowerCase();
      if (!em.includes("@")) continue;
      out.push({
        first: s.firstName, last: s.lastName, grade: s.grade ?? null,
        studentNumber: s.studentNumber, local: em.split("@")[0],
      });
      if (out.length >= (limit ?? 6)) break;
    }
    return out;
  },
});

/** The student addresses that do NOT follow the convention, so the exceptions are known. Read-only. */
export const studentEmailOutliers = internalQuery({
  args: {},
  handler: async (ctx) => {
    const students = await ctx.db.query("students").collect();
    const clean = (v: unknown) =>
      String(v ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]/g, "");
    const out: any[] = [];
    for (const s of students as any[]) {
      const em = String(s.email ?? "").trim().toLowerCase();
      if (!em.includes("@")) continue;
      const lp = clean(em.split("@")[0]);
      const f = clean(s.firstName), l = clean(s.lastName), n = clean(s.studentNumber);
      if (f && l && n && lp === f[0] + l[0] + n) continue;
      out.push({
        first: s.firstName, last: s.lastName, studentNumber: s.studentNumber,
        local: em.split("@")[0], grade: s.grade ?? null,
        expected: f && l && n ? f[0] + l[0] + n : "(cannot build)",
      });
    }
    return out;
  },
});
