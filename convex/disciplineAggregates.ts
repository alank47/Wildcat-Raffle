import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff, requireAdmin } from "./identity";
import { reportedCategories, classifyEthnicity, HISPANIC_LABEL } from "./raceRollup";

/**
 * Discipline breakdowns by protected characteristic. COUNTS ONLY, NEVER ROWS.
 *
 * WHY THIS EXISTS RATHER THAN WIDENING ALLOWED_BY_ROLE.
 *
 * "PBIS can see counts by race" and "PBIS can see a child's race" are
 * different permissions, and only the first was asked for. The app owner was
 * explicit on 2026-08-19: "I am not looking to see an individual child's race,
 * I just want data to show what races are being hit with referrals."
 *
 * So restrictedPolicy.ts stays empty for PBIS, studentDetail still cannot
 * return raceCodes to them, and this function serves the aggregate separately.
 * It reads psRestricted, joins it to referrals in memory, and returns tallies.
 * There is no argument that could make it return a student to PBIS, because
 * for PBIS it never builds one.
 *
 * SUPPRESSION HAPPENS HERE, NOT IN THE BROWSER.
 *
 * The UI already withholds small cells, but that is cosmetic: anyone can read
 * the network response. For "aggregate only" to be a property rather than a
 * claim, a cell small enough to identify a child must never leave the server.
 *
 * THE CATEGORIES COME FROM raceRollup, NOT FROM raceCodes ALONE.
 *
 * An earlier revision of this file mapped race codes directly and ignored
 * fedEthnicity. In California that reports a predominantly Hispanic school as
 * White, because Hispanic students still answer the race question and very
 * commonly answer it 700. See raceRollup.ts for the rule and the bug.
 */

/** Below this many ENROLLED students, a rate is noise and may identify. */
const SMALL_GROUP = 10;

/** Roles that may see discipline aggregates by protected characteristic. */
const AGGREGATE_ROLES = ["admin", "superadmin", "pbis"];

export const byRace = query({
  args: {
    /**
     * The student numbers that received referrals, from the caller.
     *
     * NOT read from the database, because referrals are still in Firestore
     * and race is in Convex: the join has to happen somewhere, and the
     * browser is the only place holding both handles. An earlier revision
     * read an appState key "referrals" that nothing has ever written, so this
     * always returned zero and the panel looked broken.
     *
     * This does not weaken the guarantee. The caller sends student NUMBERS,
     * which it already has, and receives COUNTS. No race value crosses back.
     */
    studentNumbers: v.array(v.string()),
    // Optional window, so a review can ask about a term rather than all time.
    sinceIso: v.optional(v.string()),
  },
  handler: async (ctx, { studentNumbers }) => {
    const staff = await requireStaff(ctx);
    if (!AGGREGATE_ROLES.includes(staff.role)) {
      // Named plainly. A PBIS member who has not been given the role should
      // be told that, not left wondering whether the data is missing.
      return {
        allowed: false,
        reason:
          "Discipline breakdowns by race are limited to administrators and the PBIS team. " +
          "Ask an administrator to set your access level to PBIS Team.",
        rows: [],
      };
    }

    // THE INFERENCE GUARD.
    //
    // Sending one student number would return that student's categories, which
    // is a way to read an individual's race through an aggregate. Admins may
    // see individual race anyway (approved 2026-08-19), so the guard costs
    // them nothing. For PBIS it is the difference between the permission they
    // were given and the one they were not.
    const distinct = new Set(studentNumbers.filter(Boolean));
    if (staff.role === "pbis" && distinct.size > 0 && distinct.size < SMALL_GROUP) {
      return {
        allowed: true,
        loaded: true,
        tooFew: true,
        reason:
          `A breakdown over ${distinct.size} student(s) can identify them. ` +
          `This appears once at least ${SMALL_GROUP} students have referrals.`,
        rows: [],
      };
    }

    const restricted = await ctx.db.query("psRestricted").collect();
    if (!restricted.length) {
      return {
        allowed: true,
        loaded: false,
        reason:
          "Race data has not been loaded yet. PowerSchool grants it and the query works; " +
          "the sync has not populated psRestricted.",
        rows: [],
      };
    }

    // studentNumber -> the reporting categories for that student.
    //
    // Hispanic or Latino collapses to a single category (ethnicity wins).
    // A non-Hispanic student with codes in two categories counts under BOTH
    // and is never collapsed into "Two or more races": that is a reporting
    // decision this school has not made, and it hides exactly the students it
    // claims to describe.
    const catsByNumber = new Map<string, string[]>();
    const unmappedCodes = new Set<string>();
    let unknownEthnicity = 0;
    for (const r of restricted) {
      const rep = reportedCategories(r);
      for (const c of rep.unmapped) unmappedCodes.add(c);
      // Counted, not corrected. A pile of unknowns is a sync gap, and saying
      // so is the difference between a broken feed and a finding about kids.
      if (rep.ethnicity === "unknown") unknownEthnicity += 1;
      if (rep.categories.length) catsByNumber.set(r.studentNumber, rep.categories);
    }

    // Enrolment denominator, from the current roster.
    const roster = await ctx.db.query("psRoster").collect();
    const enrolledNumbers = new Set(roster.map((r) => r.studentNumber));
    const enrolledBy: Record<string, number> = {};
    for (const num of enrolledNumbers) {
      for (const code of catsByNumber.get(num) ?? []) {
        enrolledBy[code] = (enrolledBy[code] ?? 0) + 1;
      }
    }

    const referralsBy: Record<string, number> = {};
    let counted = 0;
    let unmatched = 0;
    for (const num of studentNumbers) {
      const codes = catsByNumber.get(String(num ?? ""));
      if (!codes || !codes.length) { unmatched += 1; continue; }
      counted += 1;
      for (const code of codes) referralsBy[code] = (referralsBy[code] ?? 0) + 1;
    }

    let enrolTotal = 0;
    for (const k of Object.keys(enrolledBy)) enrolTotal += enrolledBy[k];

    let withheld = 0;
    const rows = Object.keys({ ...enrolledBy, ...referralsBy }).map((code) => {
      const enrolled = enrolledBy[code] ?? 0;
      const count = referralsBy[code] ?? 0;
      const suppressed = enrolled > 0 && enrolled < SMALL_GROUP;
      if (suppressed) withheld += 1;

      const shareOfReferrals = counted ? count / counted : 0;
      const shareOfEnrollment = enrolTotal ? enrolled / enrolTotal : 0;

      return {
        code,
        // A suppressed group reports NOTHING that could locate a child: not
        // the count, not the enrolment, not the rate. Only that it exists and
        // is withheld, so the totals still reconcile.
        count: suppressed ? null : count,
        enrolled: suppressed ? null : enrolled,
        shareOfReferrals: suppressed ? null : shareOfReferrals,
        shareOfEnrollment: suppressed ? null : shareOfEnrollment,
        index:
          suppressed || !shareOfEnrollment ? null : shareOfReferrals / shareOfEnrollment,
        suppressed,
      };
    }).sort((a, b) => (b.count ?? -1) - (a.count ?? -1));

    return {
      allowed: true,
      loaded: true,
      rows,
      counted,
      // Referrals whose student has no race record. Reported so a small
      // denominator is visible rather than quietly shrinking every rate.
      unmatched,
      groupsWithheld: withheld,
      // Students whose ethnicity question never synced. Surfaced because they
      // fall through to race, which is exactly the path that produced the
      // wrong chart, and a reader should be able to see how many.
      unknownEthnicity,
      unmappedCodes: [...unmappedCodes],
      unmappedStudents: restricted.filter((r) =>
        reportedCategories(r).unmapped.length > 0).length,
      smallGroupThreshold: SMALL_GROUP,
      hispanicLabel: HISPANIC_LABEL,
      viewedAs: { role: staff.role },
    };
  },
});

/**
 * ADMIN ONLY. The per-student rows behind the chart, so the numbers can be
 * checked rather than trusted.
 *
 * WHY THIS IS ALLOWED TO RETURN A CHILD'S RACE, WHEN NOTHING ELSE IS.
 *
 * The app owner asked for it on 2026-08-20, for one stated reason: an
 * aggregate nobody can audit is not trustworthy, and the first version of the
 * chart WAS wrong. They spotted it because they know the school ("I am fairly
 * certain that my school has no white students") and had no way to confirm.
 * Verification is the reason this exists, and it is the only reason.
 *
 * requireAdmin, NOT requireStaff with a role list. PBIS was given counts and
 * only counts, and this is precisely the permission they were not given, so
 * the check is the strict one and cannot drift by editing an array.
 *
 * It returns what the SIS holds AND what the rollup decided, side by side,
 * because "is this number right" cannot be answered by the number alone. The
 * `basis` field says which question drove the answer, which is what makes a
 * surprising row explainable instead of just surprising.
 */
export const raceVerification = query({
  args: { studentNumbers: v.array(v.string()) },
  handler: async (ctx, { studentNumbers }) => {
    const staff = await requireAdmin(ctx);

    const wanted = new Set(studentNumbers.filter(Boolean).map(String));
    if (!wanted.size) return { allowed: true, rows: [], viewedAs: { role: staff.role } };

    const restricted = await ctx.db.query("psRestricted").collect();
    const byNumber = new Map(restricted.map((r) => [r.studentNumber, r]));

    // Names, so an admin can check a row against a student they know. One
    // roster row per section, so collapse to the first for each student.
    const roster = await ctx.db.query("psRoster").collect();
    const nameByNumber = new Map<string, { firstName: string; lastName: string; gradeLevel?: string }>();
    for (const r of roster) {
      if (!nameByNumber.has(r.studentNumber)) {
        nameByNumber.set(r.studentNumber, {
          firstName: r.firstName, lastName: r.lastName, gradeLevel: r.gradeLevel,
        });
      }
    }

    const rows = [...wanted].map((num) => {
      const rec = byNumber.get(num);
      const name = nameByNumber.get(num);
      // A student with no restricted record is RETURNED, not dropped. Missing
      // rows are the usual reason a chart's total is lower than the referral
      // count, and hiding them makes that impossible to find.
      const rep = rec ? reportedCategories(rec) : null;
      return {
        studentNumber: num,
        firstName: name?.firstName ?? "",
        lastName: name?.lastName ?? "",
        gradeLevel: name?.gradeLevel ?? "",
        onRoster: !!name,
        hasRecord: !!rec,
        ethnicity: rec ? classifyEthnicity(rec.fedEthnicity) : "unknown",
        fedEthnicityRaw: rec?.fedEthnicity ?? "",
        raceCodes: rec?.raceCodes ?? [],
        raceLabels: rep?.raceLabels ?? [],
        reported: rep?.categories ?? [],
        basis: rep?.basis ?? "none",
        unmapped: rep?.unmapped ?? [],
      };
    }).sort((a, b) => (a.lastName || "~").localeCompare(b.lastName || "~"));

    return { allowed: true, rows, viewedAs: { role: staff.role } };
  },
});
