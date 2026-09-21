import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff } from "./identity";
import { readCoverage } from "./psBehavior";

/**
 * THE COURSE-PERFORMANCE COUNTS BEHIND THE COMBINED EARLY WARNING LIST, plus
 * an honest statement of what the behaviour axis does and does not know.
 *
 * WHY THIS RETURNS COUNTS AND NOT STUDENTS, AND NOT TIERS.
 *
 * Same contract as attendanceList.schoolAttendance, for the same two reasons.
 * The browser already holds the roster, so a whole-school risk list can be
 * built without one name, grade or race crossing the wire -- which means this
 * function can never be the thing that leaks a student record, because it
 * never builds one. And the weights, the thresholds and the tiers are display
 * rules the school will argue about, so they live in wildcat-discipline.js
 * where they can be changed and unit-tested without a deploy. Nothing here
 * decides who is at risk; it counts, and says what it could not see.
 *
 * WHY IT IS PAGED, AND WHY ATTENDANCE IS NOT IN IT.
 *
 * Convex allows 4,096 document reads per call. Doing this for all 679 students
 * costs roughly 11,000 -- psGrades alone is 5,569 rows and psMissingWork is
 * 4,928 -- so a single call cannot be correct, and a collect() here is the
 * exact failure that broke clearRoster and the grade sync when psGrades passed
 * the limit. Both were invisible because a run is only recorded on success.
 * The caller pages with `after` until `done`. Attendance is deliberately NOT
 * duplicated here: schoolAttendance already returns exactly the two figures
 * the attendance axis needs, is already role-gated and already tested, and a
 * second attendance path is a second thing to drift.
 *
 * ABSENCE IS NOT ZERO, throughout. A student with no grade rows gets null, not
 * 0 -- "nothing has been posted for this child" and "this child is passing
 * everything" are opposite facts that would render identically. The same rule
 * attendanceList's dayCount() applies, and the same one psBehavior states as
 * its third rule.
 */

/**
 * Admin, superadmin and PBIS. The same three that reach Attendance Watch,
 * Discipline Analytics and Student History.
 *
 * A combined risk ranking is the most sensitive list this app can produce: it
 * names the children the school is most worried about and says why, across
 * attendance, behaviour and grades at once. A classroom teacher who may only
 * file a referral about their own class has no business with it, and campus
 * aides are excluded for the reason they are excluded from referral history.
 */
const RISK_ROLES = ["admin", "superadmin", "pbis"];

/**
 * Students per page, sized for MAY rather than for September.
 *
 * The arithmetic, measured 2026-09-21: 679 students, 5,569 psGrades rows and
 * 4,928 psMissingWork rows, so about 15.5 documents per student plus the
 * anchor read. A 250-student page is roughly 4,126 reads against Convex's
 * limit of 4,096 -- it happens to pass today and would be a coin toss by next
 * week.
 *
 * AND MISSING WORK GROWS ALL YEAR. It is replaced wholesale each sync but the
 * term's assignments accumulate, so the per-student figure that is 7.3 in
 * September is plausibly 20+ by spring. At 100 students a page that is about
 * 3,100 reads at triple today's volume, which still fits. This is the exact
 * failure that broke clearRoster and the grade sync once psGrades passed the
 * limit, and both were invisible because a run is only recorded on success.
 * 679 students is seven round trips, which the screen absorbs.
 */
const PAGE_MAX = 100;

/**
 * Say when a page is getting close to the read limit, rather than waiting for
 * the day it crosses it. Reported on every response so growth is visible on
 * the screen instead of arriving as a dead tab in March.
 */
const READ_WARN_AT = 3000;

/**
 * Per-student read caps, named because their EDGE is a signal.
 *
 * A student at the cap has been under-counted, and an under-counted student is
 * under-ranked -- which on this screen means the child who has handed in
 * nothing all year sinks BELOW children with less owed work. Rule 7 of this
 * codebase: a capped read surfaces a flag to the screen rather than quietly
 * ending early. 26 flagged assignments was the 2026-09-21 maximum and 7.3 the
 * mean, but the term accumulates and 8 sections of nothing handed in reaches
 * 200 during a year.
 */
const MAX_GRADES_PER_STUDENT = 40;
const MAX_MISSING_PER_STUDENT = 200;

/**
 * THE FAILING LINE, AND THE ARTEFACT IT HAS TO STEP AROUND.
 *
 * Below 60 is the line PowerSchool's own letter grades use. But measured on
 * 2026-09-21, a naive count below 60 put 78% of this school on a failing list
 * -- and that is how the earlier per-grade academics feature died, at 66%.
 *
 * The reason is specific and checkable: 721 grade rows sit at EXACTLY 0%, and
 * 709 of them -- 98% -- have no teacher-flagged missing work anywhere in that
 * section. A child genuinely scoring nothing in a real class would have work
 * flagged against them. An empty gradebook looks exactly like this. So an
 * exact zero counts as failing ONLY where that section has flagged missing
 * work, and otherwise it is counted as UNGRADED and reported as such.
 * Low-but-not-zero grades are kept untouched: 341 of 659 have flagged work
 * behind them, so that part of the signal is real.
 *
 * Both counts cross the wire -- `failingCourses` applies this rule and
 * `failingCoursesRaw` does not -- so the screen can show the difference and a
 * future decision can change it without a deploy.
 */
const FAIL_BELOW = 60;

/** Default recency window for missing work, in days. Overridable by the caller. */
const RECENT_DAYS = 14;


/**
 * ONE STUDENT'S COURSE-PERFORMANCE COUNTS. Exported because the calibration
 * tool in earlyWarningProfile.ts measures THIS, not a restatement of it: the
 * tier boundaries in wildcat-discipline.js were chosen from a histogram of
 * these numbers, and a second copy of the counting would let the screen and
 * its own justification drift apart.
 *
 * `anchor` is the student's psAttendance row -- the enrolment anchor, already
 * read by the caller, which is where studentNumber and SIS freshness come
 * from. `cutoff` is the recency boundary as a "YYYY-MM-DD" string, compared as
 * a string: an SIS date parsed into a JS Date in one timezone and
 * re-serialized in another is how a Friday becomes a Thursday.
 *
 * Returns null for a row with no student number. NEVER QUERIES AN EMPTY KEY --
 * q.eq("studentNumber", "") is not a no-op, it matches every unkeyed row, and
 * would render another child's grades under this child's name with nothing
 * erroring.
 */
export async function countsForStudent(
  ctx: { db: any },
  anchor: { studentNumber?: string; syncedAt?: string },
  cutoff: string,
): Promise<{ row: Record<string, any>; docs: number } | null> {
  const studentNumber = String(anchor.studentNumber || "");
  if (!studentNumber) return null;

  const grades = await ctx.db
    .query("psGrades")
    .withIndex("by_studentNumber", (q: any) => q.eq("studentNumber", studentNumber))
    .take(MAX_GRADES_PER_STUDENT);
  const missing = await ctx.db
    .query("psMissingWork")
    .withIndex("by_studentNumber", (q: any) => q.eq("studentNumber", studentNumber))
    .take(MAX_MISSING_PER_STUDENT);

  // isMissing ABSENT READS AS TRUE. Rows written by plugin 1.3.x carry no such
  // column and every one of those was teacher-flagged by definition.
  const flaggedBySection = new Map<string, number>();
  let missingRecent = 0, missingOlder = 0, missingUndated = 0;
  for (const m of missing) {
    if (m.isMissing === false) continue;
    const sec = String(m.sectionId || m.assignmentSectionId || "");
    if (sec) flaggedBySection.set(sec, (flaggedBySection.get(sec) || 0) + 1);
    const due = String(m.dueDate || "").slice(0, 10);
    if (!due || !cutoff) missingUndated++;
    else if (due >= cutoff) missingRecent++;
    else missingOlder++;
  }

  let graded = 0, failing = 0, failingRaw = 0, ungraded = 0;
  for (const g of grades) {
    const p =
      typeof g.currentPercent === "number" && isFinite(g.currentPercent) ? g.currentPercent : null;
    if (p === null) { ungraded++; continue; }
    graded++;
    if (p >= FAIL_BELOW) continue;
    failingRaw++;
    if (p === 0 && !(flaggedBySection.get(String(g.sectionId || "")) || 0)) { ungraded++; continue; }
    failing++;
  }

  return { docs: grades.length + missing.length, row: {
    studentNumber,
    // null, not 0: no grade rows at all is a gap, not a clean record.
    gradedCourses: grades.length ? graded : null,
    failingCourses: grades.length ? failing : null,
    failingCoursesRaw: grades.length ? failingRaw : null,
    ungradedCourses: grades.length ? ungraded : null,
    // Missing work is a presence-only feed: a student with no rows genuinely
    // owes nothing, so 0 is a real answer HERE, per student.
    //
    // BUT AN EMPTY TABLE IS NOT AN EMPTY STUDENT, and the caller has to be able
    // to tell the difference. sisAction.ts clears psMissingWork unconditionally
    // before it inserts ("The clear runs even when there is nothing to write"),
    // and this very feed returned HTTP 200 with zero rows for the whole of
    // plugin 1.3.0 -- so a wiped or half-written table is a state this has
    // really been in. When it happens every student reads "owes nothing" as a
    // KNOWN fact, the score ceiling falls from 8 to 6, and the top tier at 7
    // becomes mathematically empty while the screen says nothing is wrong.
    // `hasMissingFeed` is what lets the caller see that, aggregated below.
    missingRecent, missingOlder, missingUndated,
    hasMissingFeed: missing.length > 0,
    // AT THE CAP MEANS UNDER-COUNTED. Reported so the child who has handed in
    // nothing cannot sink below children with less owed work.
    missingTruncated: missing.length >= MAX_MISSING_PER_STUDENT,
    gradesTruncated: grades.length >= MAX_GRADES_PER_STUDENT,
    // So staleness is visible rather than silent. A student whose SIS row has
    // not refreshed in weeks has probably withdrawn, and must not be silently
    // dropped OR silently ranked.
    sisAsOf: String(anchor.syncedAt || "").slice(0, 10) || null,
  } };
}

/**
 * The recency cutoff as a date string, `window` days before `today`.
 * Exported so the calibration tool cannot compute it differently.
 */
export function recencyCutoff(today: string, window: number): string {
  const day = String(today || "").slice(0, 10);
  const base = Date.parse(day + "T00:00:00Z");
  if (!Number.isFinite(base)) return "";
  return new Date(base - window * 86400000).toISOString().slice(0, 10);
}

export const academicCounts = query({
  args: {
    /** "YYYY-MM-DD" from the browser. Never clock-read here: a server-side UTC
     *  date rolls over at 5pm Pacific and would put an afternoon in tomorrow. */
    today: v.string(),
    recentDays: v.optional(v.number()),
    after: v.optional(v.string()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, { today, recentDays, after, pageSize }) => {
    const staff = await requireStaff(ctx);
    if (!RISK_ROLES.includes(staff.role)) {
      // A refusal, returned rather than thrown, so the screen can say which it
      // is. Same shape as schoolAttendance.
      return {
        allowed: false as const,
        reason:
          "The early warning list is available to administrators and the PBIS team. " +
          "It is a whole-school record of the children the school is most worried about.",
        rows: [], done: true as const, last: "", behaviour: null,
      };
    }

    const take = Math.min(Math.max(1, Number(pageSize) || PAGE_MAX), PAGE_MAX);
    const window = Math.min(Math.max(1, Number(recentDays) || RECENT_DAYS), 120);

    // A DATE STRING, COMPARED AS A STRING. ISO dates sort lexicographically,
    // so no parse is needed beyond working out the cutoff once.
    const cutoff = recencyCutoff(today, window);

    // psAttendance is the enrolment anchor: one row per student the SIS is
    // sending us. Walked in studentNumber order so a student is never split
    // across two pages.
    // ALWAYS gt(), EVEN ON THE FIRST PAGE, and that is a correctness fix
    // rather than a tidy-up. Every real student number is non-empty and the
    // empty string sorts first in the index, so gt("") skips exactly the rows
    // this loop would skip anyway -- which means `last` can never come back
    // empty. The alternative, starting unbounded, had a stall: a page whose
    // final row carried an empty studentNumber returned last:"" , the caller
    // read that as "no cursor", and paging either stopped early or restarted
    // from the top forever. attendanceList.ts filters the same empty rows out,
    // so they demonstrably occur in this table's design even though production
    // holds none today.
    const anchors = await ctx.db
      .query("psAttendance")
      .withIndex("by_studentNumber", (q) => q.gt("studentNumber", after || ""))
      .take(take + 1);
    const done = anchors.length <= take;
    const page = done ? anchors : anchors.slice(0, take);

    const rows: Array<Record<string, any>> = [];
    let docsRead = anchors.length;
    // HOW MANY STUDENTS THE OWED-WORK FEED ACTUALLY COVERS. Summed by the
    // caller across pages: zero for the whole school means the feed is dark,
    // not that the school owes nothing.
    let withMissingFeed = 0, truncatedRows = 0;
    for (const a of page) {
      const got = await countsForStudent(ctx, a, cutoff);
      if (!got) continue;
      docsRead += got.docs;
      if (got.row.hasMissingFeed) withMissingFeed++;
      if (got.row.missingTruncated || got.row.gradesTruncated) truncatedRows++;
      rows.push(got.row);
    }

    // THE BEHAVIOUR AXIS, STATED RATHER THAN SCORED.
    //
    // Measured 2026-09-21: PowerSchool's behaviour log holds 16,987 entries
    // for this district and NONE of them are here -- psBehaviorLog is not
    // declared in schema.ts, nothing calls psBehavior.replaceWindow, and there
    // is no coverage record. The app's own referral corpus is 4 rows. So there
    // is no behaviour axis to compute, and the one thing that must not happen
    // is rendering that as "0 incidents", which is a claim about a child
    // nobody made. readCoverage() returns null until a window is really
    // pulled, and this passes that straight through.
    const coverage = await readCoverage(ctx);
    return {
      allowed: true as const,
      reason: null,
      rows, done, last: page.length ? String(page[page.length - 1].studentNumber || "") : (after || ""),
      recentDays: window, cutoff, failBelow: FAIL_BELOW,
      // NO SILENT CAP. Convex allows 4,096 document reads per call; this says
      // what it actually spent, so a page that is creeping toward the ceiling
      // shows up on the screen while there is still time to shrink it.
      docsRead, nearReadLimit: docsRead >= READ_WARN_AT, pageSize: take,
      // Coverage, not a verdict. The caller adds these up across pages and
      // decides; a single page cannot know whether the whole feed is dark.
      withMissingFeed, truncatedRows,
      behaviour: coverage
        ? { status: "covered" as const, window: { start: coverage.windowStart, end: coverage.windowEnd },
            syncedAt: coverage.syncedAt, entriesLoaded: coverage.entriesLoaded }
        : { status: "unknown" as const, window: null, syncedAt: null, entriesLoaded: null },
    };
  },
});
