import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin } from "./identity";
import {
  FAILING_THRESHOLD, bandOf, failingLetterOf, sortFailingLetters,
  countUnderBothRules,
} from "./seniorEligibility";
import { projectGrade } from "./gradeProjection";

/**
 * Named twelfth-graders and the classes they are failing.
 *
 * THE ONLY SCREEN IN ACADEMICS THAT NAMES A CHILD, and it is a different kind
 * of thing from everything else in that mode. Every other card there is
 * whole-school, suppressed below ten students, and its subtitle promises
 * exactly that. This one prints a student's name, their failing grades and
 * their unfinished homework.
 *
 * WHY THAT IS LEGITIMATE. The school uses grades as the incentive for senior
 * privileges and a failing grade withdraws them. That decision is ABOUT a
 * named child and cannot be made from an aggregate -- asking "how many seniors
 * are failing" cannot tell you whether Maria goes to the breakfast. Looking at
 * a student's own record to decide something about that student is the
 * ordinary use of a school's own records, not a research question.
 *
 * WHY IT IS STILL FENCED. Approved 2026-09-11 by the app owner for that
 * purpose and no other, recorded in docs/field-sourcing-approval.md. Grade 12
 * only, admin and superadmin only, no export, no stored decision, and no
 * demographic field anywhere in either response.
 *
 * requireAdmin, NOT requireStaff with a role array. The two express the same
 * set today, and that is exactly the trap: the obvious future edit is
 * appending "pbis" when PBIS asks for the aggregate dashboard. On an aggregate
 * that hands over counts. Here the same one-word edit would hand over
 * forty-one named seniors' failing grades and their homework. Same argument
 * disciplineAggregates.ts makes for the one other per-student disclosure in
 * this codebase, at higher stakes. Widening this means editing identity.ts.
 */
const SENIOR_GRADE = "12";

/** How stale a gradebook must be before the screen says so. */
const STALE_DAYS = 7;
/** Below this many graded points, one assignment moves a grade a long way. */
const THIN_POINTS = 100;

type Detected = "ok" | "in-flight" | "no-grades";

/**
 * IS A SYNC RUNNING RIGHT NOW?
 *
 * THE HAZARD THIS EXISTS FOR, AND IT IS SPECIFIC TO THIS SCREEN. sisStats
 * replaceGrades DELETES psGrades and refills it chunk by chunk, and a run is
 * recorded in syncRuns only on success. So for the length of a sync the table
 * holds a PREFIX of the truth: nothing errors, every query succeeds, and the
 * page renders perfectly -- with a senior who is failing three classes showing
 * zero, because their rows have not been re-inserted yet.
 *
 * On every other screen in this app that is a stale number. On this one an
 * undercount GRANTS A PRIVILEGE, which is the direction that does not get
 * caught later.
 *
 * The detector: any row whose syncedAt is NEWER than the last recorded
 * successful run means a sync has written since that run finished, i.e. one is
 * in flight (or one died part-way, which is the same warning for the same
 * reason -- the data really is partial). Costs one document.
 */
function detectInFlight(maxSyncedAt: string | null, lastRunAt: string | null): boolean {
  if (!maxSyncedAt) return false;
  if (!lastRunAt) return true;
  return maxSyncedAt > lastRunAt;
}

export const failingList = query({
  args: {},
  handler: async (ctx) => {
    const staff = await requireAdmin(ctx);

    // ---- who is a senior, from the LIVE SYNC and not the app's own table ---
    //
    // MEASURED 2026-09-11 AND IT IS NOT A CLOSE CALL. students.grade === "12"
    // returns 80 people; psRoster.gradeLevel === "12" returns 41, and every
    // one of the 41 is in the 80. The other 39 are in the app's table and in
    // no PowerSchool enrolment -- last year's class, who graduated and left.
    // The students table holds 757 rows for a school of 618.
    //
    // Those 39 carry no current grades, so had this been built on the obvious
    // source every one of them would have appeared at the top of an
    // eligibility list showing zero failing classes.
    const enrolments = await ctx.db
      .query("psRoster")
      .withIndex("by_gradeLevel", (q) => q.eq("gradeLevel", SENIOR_GRADE))
      .collect();

    const seniors = new Map<string, { sections: Set<string> }>();
    let enrolmentsWithNoStudentNumber = 0;
    for (const r of enrolments) {
      const key = String(r.studentNumber ?? "").trim();
      // FAIL CLOSED. eq("studentNumber", "") is a real bucket lookup, not a
      // no-op: it returns whichever rows carry an empty number, which is a
      // different child's grades rendered under this name.
      if (!key) { enrolmentsWithNoStudentNumber++; continue; }
      const e = seniors.get(key) ?? { sections: new Set<string>() };
      const sec = String(r.sectionId ?? "").trim();
      if (sec) e.sections.add(sec);
      seniors.set(key, e);
    }

    // ---- names, from the app's roster, which is where they live ------------
    const names = new Map<string, { firstName: string; lastName: string }>();
    for (const key of seniors.keys()) {
      const rows = await ctx.db
        .query("students")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", key))
        .take(1);
      const s = rows[0];
      if (s) names.set(key, { firstName: String(s.firstName ?? ""), lastName: String(s.lastName ?? "") });
    }

    let maxSyncedAt: string | null = null;
    const bump = (at: unknown) => {
      const s = typeof at === "string" ? at : "";
      if (s && (maxSyncedAt === null || s > maxSyncedAt)) maxSyncedAt = s;
    };

    const students: any[] = [];
    let withAnyFailing = 0, withNoGradeRow = 0, withUnpostedClass = 0, wouldDropIfFOnly = 0;

    for (const [key, info] of seniors) {
      const gradeRows = await ctx.db
        .query("psGrades")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", key))
        .collect();
      const missing = await ctx.db
        .query("psMissingWork")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", key))
        .collect();
      gradeRows.forEach((g) => bump(g.syncedAt));
      missing.forEach((m) => bump(m.syncedAt));

      const marks = gradeRows.map((g) => g.currentGrade);
      const counts = countUnderBothRules(marks);

      const failingSections = new Set<string>();
      const letters: string[] = [];
      let lastPostedAt: string | null = null;
      for (const g of gradeRows) {
        if (bandOf(g.currentGrade) === "fails") {
          const sec = String(g.sectionId ?? "").trim();
          if (sec) failingSections.add(sec);
          const L = failingLetterOf(g.currentGrade);
          if (L) letters.push(L);
        }
        const up = typeof g.lastGradeUpdate === "string" ? g.lastGradeUpdate : "";
        if (up && (lastPostedAt === null || up > lastPostedAt)) lastPostedAt = up;
      }

      // Outstanding work in the FAILING classes only: this number means
      // distance-from-clear, and work owed in a class they are passing is not
      // what the decision is about. The popup shows all of it regardless.
      let notHandedIn = 0, scoredZero = 0;
      for (const m of missing) {
        const sec = String(m.sectionId ?? "").trim();
        if (!failingSections.has(sec)) continue;
        if (m.isMissing !== false) notHandedIn++; else scoredZero++;
      }

      // NULL, NOT ZERO, when nothing has been posted at all. "We did not look"
      // must never wear the costume of "nothing wrong" on the one screen where
      // that grants a privilege.
      const anyMark = marks.some((m) => bandOf(m) !== "unposted");
      const failingCount = anyMark ? counts.failingDF : null;

      if (failingCount === null) withNoGradeRow++;
      else if (failingCount > 0) withAnyFailing++;
      if (counts.unposted > 0) withUnpostedClass++;
      if (counts.turnsOnTheRule) wouldDropIfFOnly++;

      const n = names.get(key);
      students.push({
        studentNumber: key,
        firstName: n?.firstName ?? "",
        lastName: n?.lastName ?? "",
        failingCount,
        letters: sortFailingLetters(letters),
        dCount: marks.filter((m) => failingLetterOf(m, "DF") === "D").length,
        fCount: marks.filter((m) => failingLetterOf(m, "DF") === "F").length,
        npCount: marks.filter((m) => failingLetterOf(m, "DF") === "NP").length,
        sectionsEnrolled: info.sections.size,
        sectionsMarked: gradeRows.filter((g) => bandOf(g.currentGrade) !== "unposted").length,
        notHandedIn,
        scoredZero,
        lastPostedAt,
      });
    }

    // Unanswerable rows first, then most failing, then fewest posted, then name.
    students.sort((a, b) => {
      if ((a.failingCount === null) !== (b.failingCount === null)) return a.failingCount === null ? -1 : 1;
      if ((b.failingCount ?? 0) !== (a.failingCount ?? 0)) return (b.failingCount ?? 0) - (a.failingCount ?? 0);
      if (a.sectionsMarked !== b.sectionsMarked) return a.sectionsMarked - b.sectionsMarked;
      return `${a.lastName}, ${a.firstName}`.toLowerCase()
        .localeCompare(`${b.lastName}, ${b.firstName}`.toLowerCase());
    });

    const lastRun = await ctx.db.query("syncRuns").withIndex("by_at").order("desc").take(1);
    const lastRunAt = lastRun[0] ? String(lastRun[0].at) : null;
    const inFlight = detectInFlight(maxSyncedAt, lastRunAt);
    const dataState: Detected =
      students.length === 0 || students.every((s) => s.failingCount === null)
        ? "no-grades"
        : inFlight ? "in-flight" : "ok";

    return {
      allowed: true,
      rule: {
        threshold: FAILING_THRESHOLD,
        label: FAILING_THRESHOLD === "DF" ? "D and F" : "F only",
      },
      dataState,
      asOf: { gradesSyncedAt: maxSyncedAt, lastSuccessfulRunAt: lastRunAt },
      totals: {
        seniors: students.length,
        withAnyFailing,
        withNoGradeRow,
        withUnpostedClass,
        wouldDropIfFOnly,
        enrolmentsWithNoStudentNumber,
      },
      students,
      viewedBy: { role: staff.role, email: staff.email ?? null },
    };
  },
});

/**
 * One senior's classes, grades and the work behind them.
 *
 * THE GRADE LEVEL IS RE-DERIVED HERE, SERVER SIDE, ON EVERY OPEN. This query
 * takes a caller-supplied student number, so without a subject check it is a
 * general "any named student's complete academic record" endpoint that merely
 * happens to be called from the senior tab. The grant is bounded to
 * twelfth-graders by this code, not by which button the browser drew.
 */
export const detail = query({
  args: { studentNumber: v.string() },
  handler: async (ctx, { studentNumber }) => {
    const staff = await requireAdmin(ctx);
    const key = String(studentNumber ?? "").trim();
    if (!key) {
      return {
        allowed: true, found: false,
        reason:
          "This student has no student number on their roster record, so their " +
          "grades cannot be looked up. The office can add it in PowerSchool.",
      };
    }

    const enrolments = await ctx.db
      .query("psRoster")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", key))
      .collect();
    if (!enrolments.length) {
      return { allowed: true, found: false, reason: "No PowerSchool enrolment for that student number." };
    }
    if (!enrolments.some((r) => String(r.gradeLevel ?? "").trim() === SENIOR_GRADE)) {
      return {
        allowed: true, found: false,
        reason:
          "That student is not in twelfth grade. This screen was approved for " +
          "deciding senior privileges and shows nobody else.",
      };
    }

    const gradeRows = await ctx.db
      .query("psGrades")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", key))
      .collect();
    const missing = await ctx.db
      .query("psMissingWork")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", key))
      .collect();
    const points = await ctx.db
      .query("psSectionPoints")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", key))
      .collect();

    const nameRows = await ctx.db
      .query("students")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", key))
      .take(1);
    const who = nameRows[0];

    const bySection = new Map<string, { period: string | null; teacherEmail: string | null }>();
    for (const r of enrolments) {
      const sec = String(r.sectionId ?? "").trim();
      if (sec) bySection.set(sec, {
        period: (r as any).period ? String((r as any).period) : null,
        teacherEmail: (r as any).teacherEmail ? String((r as any).teacherEmail) : null,
      });
    }

    const pointsBySection = new Map<string, { earned: number; possible: number }>();
    for (const p of points) {
      const sec = String(p.sectionId ?? "").trim();
      if (sec) pointsBySection.set(sec, { earned: p.pointsEarned, possible: p.pointsPossible });
    }

    const workBySection = new Map<string, any[]>();
    const orphanWork: any[] = [];
    const enrolledSections = new Set([...bySection.keys()]);
    for (const m of missing) {
      const sec = String(m.sectionId ?? "").trim();
      const row = {
        assignmentName: m.assignmentName ?? null,
        dueDate: m.dueDate ?? null,
        pointsPossible: typeof m.pointsPossible === "number" ? m.pointsPossible : null,
        scorePoints: typeof (m as any).scorePoints === "number" ? (m as any).scorePoints : null,
        categoryName: m.categoryName ?? null,
        isLate: m.isLate === true,
        // ABSENT READS AS FLAGGED. Rows written by plugin 1.3.x carry no such
        // column and every one of those was flagged by definition.
        flaggedMissing: m.isMissing !== false,
        courseName: m.courseName ?? null,
      };
      if (sec && enrolledSections.has(sec)) {
        const arr = workBySection.get(sec) ?? [];
        arr.push(row);
        workBySection.set(sec, arr);
      } else {
        // psMissingWork rows whose section matches no enrolment. Shown rather
        // than dropped: an administrator counting rows against a total should
        // find them, not a discrepancy nobody can chase.
        orphanWork.push(row);
      }
    }

    // Flagged before zeros, then oldest due date first, undated LAST. The
    // sentinel, not `dueDate || ""` -- an empty string sorts above real dates
    // and puts undated work in front of things genuinely overdue. Same
    // comparator the student's own view uses, deliberately: a student holding
    // up their phone and an administrator reading this popup must see the same
    // items in the same order.
    const UNDATED = "￿";
    const sortWork = (a: any, b: any) => {
      if (a.flaggedMissing !== b.flaggedMissing) return a.flaggedMissing ? -1 : 1;
      return (a.dueDate ?? UNDATED).localeCompare(b.dueDate ?? UNDATED);
    };

    const failing: any[] = [], unposted: any[] = [], passing: any[] = [];
    for (const g of gradeRows) {
      const sec = String(g.sectionId ?? "").trim();
      const meta = bySection.get(sec) ?? { period: null, teacherEmail: null };
      const work = (workBySection.get(sec) ?? []).sort(sortWork);
      const pointsAvailable = work.reduce(
        (sum, w) => sum + Math.max(0, (w.pointsPossible ?? 0) - (w.scorePoints ?? 0)), 0);
      const pts = pointsBySection.get(sec) ?? null;
      const pct = typeof g.currentPercent === "number" && Number.isFinite(g.currentPercent)
        ? g.currentPercent : null;

      const row = {
        sectionId: sec,
        courseName: g.courseName ?? null,
        courseNumber: g.courseNumber ?? null,
        period: meta.period,
        teacherEmail: meta.teacherEmail,
        letter: typeof g.currentGrade === "string" ? g.currentGrade.trim() : null,
        percent: pct,
        lastGradeUpdate: g.lastGradeUpdate ?? null,
        failingLetter: failingLetterOf(g.currentGrade),
        work,
        notHandedIn: work.filter((w) => w.flaggedMissing).length,
        scoredZero: work.filter((w) => !w.flaggedMissing).length,
        flaggedButScored: work.filter((w) => w.flaggedMissing && (w.scorePoints ?? 0) > 0).length,
        pointsAvailable,
        pointsGraded: pts ? pts.possible : null,
        thinGradebook: pts !== null && pts.possible > 0 && pts.possible < THIN_POINTS,
        projection: projectGrade(pct, pts?.earned ?? null, pts?.possible ?? null, pointsAvailable),
      };

      const band = bandOf(g.currentGrade);
      if (band === "fails") failing.push(row);
      else if (band === "unposted") unposted.push(row);
      else passing.push(row);
    }

    // Lowest percent first; no percent last; ties by period.
    failing.sort((a, b) => {
      if ((a.percent === null) !== (b.percent === null)) return a.percent === null ? 1 : -1;
      if (a.percent !== b.percent) return (a.percent ?? 0) - (b.percent ?? 0);
      return String(a.period ?? "").localeCompare(String(b.period ?? ""));
    });

    const counts = countUnderBothRules(gradeRows.map((g) => g.currentGrade));

    return {
      allowed: true,
      found: true,
      student: {
        studentNumber: key,
        firstName: who ? String(who.firstName ?? "") : "",
        lastName: who ? String(who.lastName ?? "") : "",
      },
      rule: { threshold: FAILING_THRESHOLD, label: FAILING_THRESHOLD === "DF" ? "D and F" : "F only" },
      summary: {
        failing: failing.length,
        marked: failing.length + passing.length,
        unposted: unposted.length,
        letters: sortFailingLetters(failing.map((f) => f.failingLetter).filter(Boolean)),
        turnsOnTheRule: counts.turnsOnTheRule,
      },
      failing,
      unposted,
      passing,
      orphanWork: orphanWork.sort(sortWork),
      staleDays: STALE_DAYS,
      asOf: {
        gradesSyncedAt: gradeRows.map((g) => String(g.syncedAt)).sort().pop() ?? null,
        missingSyncedAt: missing.map((m) => String(m.syncedAt)).sort().pop() ?? null,
      },
      viewedBy: { role: staff.role, email: staff.email ?? null },
    };
  },
});
