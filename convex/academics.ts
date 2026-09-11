import { query } from "./_generated/server";
import { requireStaff } from "./identity";
import { reportedCategories } from "./raceRollup";
import {
  markOf, cellOf, wilson95, intervalsSeparate,
  rankScore, aboveSchoolRate, restOfSchoolRate, courseCell, coverageEnvelope,
  collapseDepth, DEPTH_BUCKETS, SMALL_GROUP, MIN_CELL_COUNT, RANKABLE_N,
} from "./academicsRules";
import { subjectOf, isUnratedCohort, classificationCoverage } from "./courseSubject";

/**
 * Academics: the school's grades, aggregated, and never a child.
 *
 * ADMIN AND SUPERADMIN ONLY. Narrower than the discipline aggregates, which
 * PBIS may also read. The reason is not that grades are more sensitive than
 * discipline -- they are not -- but that this is a NEW purpose and the house
 * rule, stated at wildcat-modes.js:64-68, is against granting by adjacency. If
 * the school decides PBIS should have it, that is a decision to record, not one
 * to inherit.
 *
 * COUNTS LEAVE THIS FUNCTION. ROWS DO NOT. Same property disciplineAggregates
 * and leaderboard already hold: a cell small enough to identify a child never
 * crosses the wire, so "aggregate only" is a fact about the response and not a
 * claim about the interface.
 *
 * RACE IS COMPUTED AT SCHOOL SCOPE ONLY, with no High School / Middle School
 * split, and that is a privacy rule rather than a missing feature. The bands
 * partition the school exactly, so publishing a total alongside two halves lets
 * a withheld cell be recovered by subtraction. Race categories overlap -- a
 * non-Hispanic student with two codes counts under both -- which makes them
 * partly self-protecting, but only while the cut is not also split.
 *
 * COST. psGrades is 5,562 rows and psRestricted 618, so ~6,180 documents -- past
 * the 4,096-per-execution limit for two .collect() calls, which is why the
 * grades side is paged internally and the join is built as a map rather than a
 * per-student lookup. Measured on 2026-09-10; if enrolment grows materially this
 * needs to become a precomputed rollup.
 */
const ACADEMICS_ROLES = ["admin", "superadmin"];

export const raceBreakdown = query({
  args: {},
  handler: async (ctx) => {
    const staff = await requireStaff(ctx);
    if (!ACADEMICS_ROLES.includes(staff.role)) {
      return {
        allowed: false,
        reason:
          "Academics is limited to administrators. Ask an administrator to " +
          "change your access level if you need it.",
        cells: [],
      };
    }

    // ---- grades, paged, reduced to one row per student as we go -------------
    //
    // Reduced during the walk rather than collected: holding 5,562 rows to
    // group them afterwards is the same bytes for no benefit, and this function
    // already sits close to the per-execution ceiling.
    const perStudent = new Map<string, { marks: number; failing: number }>();
    let rows = 0;
    let markedRows = 0;
    // .collect(), NOT a paginate loop. Convex allows exactly ONE paginated
    // query per function execution, so looping paginate throws
    // "ran multiple paginated queries" -- caught here before any screen
    // existed. 5,562 grade rows plus 618 restricted rows is ~6,180 documents in
    // one execution, which is the same order as leaderboard:cash's measured
    // 1,514 and well inside what this deployment has been shown to serve
    // (6,319 documents, measured 2026-09-10). If enrolment grows materially
    // this becomes a precomputed rollup rather than a bigger read.
    {
      const all = await ctx.db.query("psGrades").collect();
      for (const g of all) {
        rows++;
        const mark = markOf(g.currentGrade);
        // Only A-F rows can contribute a D or an F. P/NP and "--" are counted
        // as coverage but never as a denominator for a D/F rate: a pass-fail
        // course has no D to give, and folding it in dilutes the rate with
        // enrolments that could never have produced one.
        if (mark.kind === "grade" || mark.kind === "passfail") markedRows++;
        if (mark.kind !== "grade" && mark.kind !== "passfail") continue;
        const n = String(g.studentNumber ?? "");
        if (!n) continue;
        const e = perStudent.get(n) ?? { marks: 0, failing: 0 };
        if (mark.kind === "grade") e.marks++;
        if (mark.failing) e.failing++;
        perStudent.set(n, e);
      }
    }

    // ---- race, from the rollup that already knows the rules -----------------
    const restricted = await ctx.db.query("psRestricted").collect();

    const byCategory = new Map<string, { students: number; withMarks: number; failing: number }>();
    let studentsOnFile = 0;
    for (const r of restricted) {
      const n = String(r.studentNumber ?? "");
      if (!n) continue;
      studentsOnFile++;
      const p = perStudent.get(n);
      for (const cat of reportedCategories(r as any).categories) {
        const e = byCategory.get(cat) ?? { students: 0, withMarks: 0, failing: 0 };
        e.students++;
        if (p && p.marks > 0) {
          e.withMarks++;
          if (p.failing > 0) e.failing++;
        }
        byCategory.set(cat, e);
      }
    }

    const cells = [...byCategory.entries()]
      .map(([label, v]) =>
        cellOf({
          label,
          students: v.students,
          studentsWithMarks: v.withMarks,
          failingStudents: v.failing,
        }),
      )
      .map((c) => ({
        ...c,
        interval:
          c.failingStudents !== null && c.studentsWithMarks !== null
            ? wilson95(c.failingStudents, c.studentsWithMarks)
            : null,
      }))
      // Biggest first, and a withheld cell still holds its place in the list so
      // a reader can see the group exists.
      .sort((a, b) => (b.students ?? 0) - (a.students ?? 0));

    // Whether ANY pair actually separates. Almost always false at this school,
    // and saying so on the screen is the difference between "no gap" and "no
    // gap this study could see".
    const reportable = cells.filter((c) => c.withheld === null);
    let anySeparate = false;
    for (let i = 0; i < reportable.length; i++) {
      for (let j = i + 1; j < reportable.length; j++) {
        if (intervalsSeparate(reportable[i] as any, reportable[j] as any)) anySeparate = true;
      }
    }

    const withMarks = [...perStudent.values()].filter((p) => p.marks > 0).length;
    const failingAny = [...perStudent.values()].filter((p) => p.failing > 0).length;

    return {
      allowed: true,
      school: {
        studentsOnFile,
        studentsWithMarks: withMarks,
        studentsFailingAny: failingAny,
        rows,
        markedRows,
        coverage: rows > 0 ? markedRows / rows : null,
      },
      cells,
      reportableCount: reportable.length,
      totalCategories: cells.length,
      anySeparate,
    };
  },
});

/**
 * WHICH COURSES FAIL THE MOST STUDENTS, AND HOW DEEP EACH STUDENT'S FAILURE
 * GOES. Metrics 1 and 3 of the twelve asked for on 2026-09-10.
 *
 * Same gate as raceBreakdown, and for a blunter reason than privacy: a course
 * has a teacher, and at a school this size naming a course names a colleague.
 * This screen exists to point at where to put an intervention -- a tutoring
 * block, a co-teacher, a curriculum conversation -- and it is not a personnel
 * instrument. The copy on the screen says so, because the number does not.
 *
 * NO PROTECTED FIELD IS READ HERE AT ALL. psRestricted is not opened; this
 * query touches psGrades and nothing else. That is why it needs no extension to
 * the field-sourcing approval: course name and letter grade were already in
 * scope for the academics purpose recorded on 2026-09-10.
 *
 * THREE THINGS THIS DELIBERATELY REFUSES TO DO:
 *
 *   1. It does not split by section. Two sections of the same course differ
 *      mostly by WHO WAS PLACED IN THEM, and the data carries no way to adjust
 *      for that. A section-level list would read as a ranking of teachers while
 *      measuring their rosters.
 *
 *   2. It does not rate special-education or English-learner sections. See
 *      isUnratedCohort in courseSubject.ts: when the roster of a course IS a
 *      protected group, an aggregate over that course is the disclosure, and
 *      the approval record refuses English-learner reporting by name. Those
 *      students still count in every school-wide figure here, where they
 *      identify nobody.
 *
 *   3. It does not claim to know a course's subject. Subject is GUESSED from
 *      the course name, because PowerSchool's own Courses.Credit_Type has not
 *      been granted. The rollup ships the fraction of the catalogue it could
 *      name and the names it could not, so a wrong bucket is visible rather
 *      than silently folded in.
 */
export const courseFailure = query({
  args: {},
  handler: async (ctx) => {
    const staff = await requireStaff(ctx);
    if (!ACADEMICS_ROLES.includes(staff.role)) {
      return {
        allowed: false,
        reason:
          "Academics is limited to administrators. Ask an administrator to " +
          "change your access level if you need it.",
        courses: [],
        notRanked: [],
        subjects: [],
        depth: [],
      };
    }

    // ONE .collect(), same as raceBreakdown and for the same reason: Convex
    // allows exactly one paginated query per execution, so a paginate loop
    // throws. 5,562 grade rows in one read, measured 2026-09-10.
    const all = await ctx.db.query("psGrades").collect();

    type CourseAcc = {
      name: string;
      subject: string;
      unrated: boolean;
      rows: number;        // enrolments, marked or not
      markedRows: number;  // carrying any mark at all, including P/NP
      graded: number;      // carrying an A-F letter: the rate's denominator
      failing: number;     // carrying a D or an F
    };
    const byCourse = new Map<string, CourseAcc>();

    // SUBJECT IS RESOLVED ONCE PER COURSE, NOT ONCE PER ROW. Seventy names, not
    // 5,562 -- the matcher is cheap but not free, and caching it on the course
    // is the difference between a rounding error and a visible cost.
    type SubjectAcc = {
      rows: number; marked: number; graded: number; failingRows: number;
      courses: Set<string>;
      // DISTINCT STUDENTS, which is what the privacy floors must be checked
      // against. Summing enrolment rows across a subject counts a student
      // taking three maths courses three times, and then compares that
      // inflated number to a floor meant to count children.
      withMarks: Set<string>;
      failing: Set<string>;
    };
    const bySubject = new Map<string, SubjectAcc>();

    // Metric 3 works per student: how many DISTINCT courses is each failing?
    // A Set, not a counter, because a student repeating a course in two
    // sections is failing one course twice, not two courses.
    const failedCourses = new Map<string, Set<string>>();
    const hasAnyMark = new Set<string>();

    let schoolGraded = 0;
    let schoolFailing = 0;
    let rows = 0;
    let markedRows = 0;

    for (const g of all) {
      rows++;
      const name = String(g.courseName ?? "").trim();
      const key = String(g.courseNumber ?? "") || name || "(unnamed)";
      const mark = markOf(g.currentGrade);
      const marked = mark.kind === "grade" || mark.kind === "passfail";
      if (marked) markedRows++;

      let acc = byCourse.get(key);
      if (!acc) {
        acc = {
          name: name || "Course " + key,
          subject: String(subjectOf(name)),
          unrated: isUnratedCohort(name),
          rows: 0, markedRows: 0, graded: 0, failing: 0,
        };
        byCourse.set(key, acc);
      }
      acc.rows++;
      if (marked) acc.markedRows++;
      // ONLY A-F ROWS CARRY A D/F RATE. A pass-fail course has no D to give,
      // so folding its enrolments into the denominator dilutes the rate with
      // rows that could never have contributed to it.
      if (mark.kind === "grade") {
        acc.graded++;
        schoolGraded++;
        if (mark.failing) {
          acc.failing++;
          schoolFailing++;
        }
      }

      const student = String(g.studentNumber ?? "");
      if (student && marked) {
        hasAnyMark.add(student);
        // NP counts as a course not passed here even though it carries no D/F
        // rate: for a student, "you did not pass this" is the same fact. The
        // two cards therefore count slightly different things, and both say so.
        if (mark.failing) {
          const set = failedCourses.get(student) ?? new Set<string>();
          set.add(key);
          failedCourses.set(student, set);
        }
      }

      if (!acc.unrated) {
        let sa = bySubject.get(acc.subject);
        if (!sa) {
          sa = {
            rows: 0, marked: 0, graded: 0, failingRows: 0,
            courses: new Set(), withMarks: new Set(), failing: new Set(),
          };
          bySubject.set(acc.subject, sa);
        }
        sa.rows++;
        sa.courses.add(key);
        if (marked) {
          sa.marked++;
          if (student) sa.withMarks.add(student);
        }
        if (mark.kind === "grade") {
          sa.graded++;
          if (mark.failing) {
            sa.failingRows++;
            if (student) sa.failing.add(student);
          }
        }
      }
    }

    const schoolRate = schoolGraded > 0 ? schoolFailing / schoolGraded : 0;
    const schoolCoverage = rows > 0 ? markedRows / rows : 0;

    // RELATIVE, NOT ABSOLUTE, because school coverage is 77% and climbing. A
    // fixed gate excludes a third of the catalogue today and nothing in
    // November. This one means "far behind the school", which stays true as
    // the school moves.
    const coverageFloor = Math.max(0.5, schoolCoverage - 0.15);

    // ---- metric 1: the course list ------------------------------------------
    const rated = [...byCourse.values()].filter((c) => !c.unrated);
    const cohortExcluded = byCourse.size - rated.length;

    const built = rated.map((c) => {
      const cell = courseCell({
        label: c.name,
        graded: c.graded,
        failing: c.failing,
        rows: c.rows,
        markedRows: c.markedRows,
      });
      const comparator = restOfSchoolRate(schoolFailing, schoolGraded, c.failing, c.graded);
      const envelope = coverageEnvelope(c.failing, c.graded, c.rows);
      const coverageOk = (cell.coverage ?? 0) >= coverageFloor;
      return {
        ...cell,
        subject: c.subject,
        interval:
          cell.failingStudents !== null && cell.studentsWithMarks !== null
            ? wilson95(cell.failingStudents, cell.studentsWithMarks)
            : null,
        // The sort key, and it is NOT the rate. See rankScore.
        score:
          cell.failingStudents !== null && cell.studentsWithMarks !== null
            ? rankScore(cell.failingStudents, cell.studentsWithMarks)
            : null,
        // NEVER BADGE A COURSE THE COVERAGE GATE HAS NOT CLEARED. A course at
        // half a gradebook is not a course with a problem; it is a course
        // nobody can see yet.
        aboveSchool:
          coverageOk && comparator !== null &&
          cell.failingStudents !== null && cell.studentsWithMarks !== null
            ? aboveSchoolRate(cell.failingStudents, cell.studentsWithMarks, comparator)
            : false,
        envelope,
        // A WIDE ENVELOPE MEANS THE POINT ESTIMATE SHOULD NOT BE READ AS ONE.
        envelopeWide: envelope !== null && envelope.width > 0.15,
        notRankedReason:
          cell.withheld !== null
            ? null
            : !coverageOk
              ? "Not ranked: only " + Math.round((cell.coverage ?? 0) * 100) +
                "% of this class's grades are posted yet."
              : !cell.rankable
                ? "Not ranked: fewer than " + RANKABLE_N + " students have a grade yet."
                : null,
      };
    });

    const courses = built
      .filter((c) => c.withheld === null && c.notRankedReason === null)
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.studentsWithMarks ?? 0) - (a.studentsWithMarks ?? 0));
    // Listed, never ranked, and told why. A course is not hidden for being
    // behind on its gradebook -- it is just not put in an order it cannot earn.
    const notRanked = built.filter((c) => c.withheld === null && c.notRankedReason !== null);
    const withheldCourses = built.filter((c) => c.withheld !== null).length;

    // ---- the subject rollup, and the five things that must be true first ----
    const naming = classificationCoverage(rated.map((c) => ({ name: c.name, weight: c.graded })));
    const unclassifiedCourses = rated.filter((c) => c.subject === "Not categorised");

    const subjects = [...bySubject.entries()]
      .map(([label, v]) => {
        const students = v.withMarks.size;
        const failingStudents = v.failing.size;
        const coverage = v.rows > 0 ? v.marked / v.rows : null;
        const rate = v.graded > 0 ? v.failingRows / v.graded : null;

        // SINGLE-COURSE SENSITIVITY. If one course we could not name could move
        // this subject's rate by more than five points just by belonging to it,
        // the rate is a statement about the guesser and not about the subject.
        let swing = 0;
        if (rate !== null) {
          for (const u of unclassifiedCourses) {
            const g = v.graded + u.graded;
            if (g <= 0) continue;
            swing = Math.max(swing, Math.abs((v.failingRows + u.failing) / g - rate));
          }
        }

        const thin =
          students < 30 || v.graded < 100 || v.courses.size < 4;
        const belowCoverage = (coverage ?? 0) < coverageFloor;
        const fragile = swing > 0.05;
        const privacy = students < SMALL_GROUP || failingStudents < MIN_CELL_COUNT;

        const withheld = privacy
          ? ("privacy" as const)
          : thin || belowCoverage || fragile
            ? ("too-few-failing" as const)
            : null;

        return {
          label,
          courses: v.courses.size,
          students: withheld === "privacy" ? null : students,
          studentsWithMarks: withheld ? null : students,
          failingStudents: withheld ? null : failingStudents,
          gradedRows: withheld ? null : v.graded,
          failingRows: withheld ? null : v.failingRows,
          rate: withheld ? null : rate,
          interval: withheld ? null : wilson95(v.failingRows, v.graded),
          coverage,
          withheld,
          reason: !withheld
            ? null
            : privacy
              ? `Not shown: too few students to report without naming them.`
              : fragile
                ? `Not shown: one class we could not name could move this figure by ` +
                  `${Math.round(swing * 100)} points, so it would say more about our guess ` +
                  `than about the subject.`
                : belowCoverage
                  ? `Not shown: only ${Math.round((coverage ?? 0) * 100)}% of these grades ` +
                    `are posted.`
                  : `Not shown: ${v.courses.size} class${v.courses.size === 1 ? "" : "es"} ` +
                    `and ${students} students is too little to speak for a whole subject.`,
        };
      })
      // A FIXED ORDER, BY CATALOGUE SIZE, AND NEVER BY RATE. A guessed taxonomy
      // must not be allowed to produce an ordinal claim about departments.
      .sort((a, b) => b.courses - a.courses || (b.gradedRows ?? 0) - (a.gradedRows ?? 0));

    // The whole rollup stands or falls on how much of the GRADEBOOK it could
    // name, not how many course titles it recognised.
    const rollupOk = (naming.weightedFraction ?? 0) >= 0.8;

    // ---- metric 3: how deep -------------------------------------------------
    const raw = DEPTH_BUCKETS.map((b) => ({
      min: b.min,
      max: b.max,
      students: [...failedCourses.values()].filter(
        (set) => set.size >= b.min && (b.max === null || set.size <= b.max),
      ).length,
    }));
    const depth = collapseDepth(raw);

    return {
      allowed: true,
      school: {
        rows,
        markedRows,
        coverage: schoolCoverage,
        coverageFloor,
        studentsWithMarks: hasAnyMark.size,
        studentsFailingAny: failedCourses.size,
        rate: schoolRate,
        graded: schoolGraded,
        failing: schoolFailing,
      },
      courses,
      notRanked,
      coursesTotal: byCourse.size,
      coursesReportable: courses.length,
      withheldCourses,
      cohortExcluded,
      rankableN: RANKABLE_N,
      subjects: rollupOk ? subjects : [],
      rollupOk,
      naming: {
        total: naming.total,
        classified: naming.classified,
        fraction: naming.fraction,
        weightedFraction: naming.weightedFraction,
        weightedClassified: naming.weightedClassified,
        weightedTotal: naming.weightedTotal,
        // Capped: this is a prompt to fix courseSubject.ts, not a catalogue
        // dump, and the screen shows it as a hint.
        unclassified: naming.unclassified.slice(0, 12),
      },
      depth,
      depthDenominator: hasAnyMark.size,
    };
  },
});
