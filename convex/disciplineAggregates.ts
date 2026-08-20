import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff } from "./identity";

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
 * So restrictedPolicy.ts stays empty for every role, studentDetail still
 * cannot return raceCodes to anybody, and this function serves the aggregate
 * separately. It reads psRestricted, joins it to referrals in memory, and
 * returns tallies. There is no argument that could make it return a student,
 * because it never builds one.
 *
 * SUPPRESSION HAPPENS HERE, NOT IN THE BROWSER.
 *
 * The UI already withholds small cells, but that is cosmetic: anyone can read
 * the network response. For "aggregate only" to be a property rather than a
 * claim, a cell small enough to identify a child must never leave the server.
 * A group below SMALL_GROUP is returned with its enrolment and rate stripped.
 *
 * Even the counts are floored: a group of 3 enrolled students with 1 referral
 * is still 1 referral attached to a nearly identifiable person, so groups
 * under SMALL_GROUP report `suppressed: true` and no rate, and the caller is
 * told how many groups were withheld so the total still reconciles.
 */

/** Below this many ENROLLED students, a rate is noise and may identify. */
const SMALL_GROUP = 10;

/**
 * CALPADS race codes to the federal reporting categories.
 *
 * The codes in this instance are the California three digit set, confirmed by
 * looking: 700, 600, 100, 400, 800 and a spread of 2xx and 3xx.
 *
 * MAPPED BY GROUP, NOT BY SUBCODE, on purpose.
 *
 * CALPADS distinguishes 201 Asian Indian from 203 Chinese from 207 Korean, and
 * so on. Two reasons not to surface that here:
 *
 *  1. Federal disproportionality reporting uses the seven categories below.
 *     That is the comparison a discipline review makes, and it is what the
 *     index in this file is for.
 *  2. Every subcode in this school has a handful of students. Labelling a
 *     group of one or two by a specific national origin, on a discipline
 *     chart, identifies that child to anyone who knows the school. Rolling up
 *     is both the correct reporting unit AND the safer one.
 *
 * The prefixes are the part I am confident of. If the school wants the
 * detailed breakdown, the subcode labels should be taken from the CALPADS code
 * set or PowerSchool's own table rather than from memory: a wrong race name on
 * a chart about children is worse than a code.
 *
 * An unrecognised code is NEVER guessed. It is returned as itself and flagged,
 * so it is visible and correctable rather than silently mislabelled.
 */
function raceLabel(code: string): { label: string; mapped: boolean } {
  const c = String(code ?? "").trim();
  if (c === "100") return { label: "American Indian or Alaska Native", mapped: true };
  if (c === "400") return { label: "Filipino", mapped: true };
  if (c === "600") return { label: "Black or African American", mapped: true };
  if (c === "700") return { label: "White", mapped: true };
  if (/^2\d\d$/.test(c)) return { label: "Asian", mapped: true };
  if (/^3\d\d$/.test(c)) return { label: "Native Hawaiian or Other Pacific Islander", mapped: true };
  return { label: "Code " + c, mapped: false };
}

/** Roles that may see discipline aggregates by protected characteristic. */
const AGGREGATE_ROLES = ["admin", "superadmin", "pbis"];

export const byRace = query({
  args: {
    // Optional window, so a review can ask about a term rather than all time.
    sinceIso: v.optional(v.string()),
  },
  handler: async (ctx, { sinceIso }) => {
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

    const restricted = await ctx.db.query("psRestricted").collect();
    if (!restricted.length) {
      return {
        allowed: true,
        loaded: false,
        reason:
          "Race data has not been loaded yet. PowerSchool grants it and the query works; " +
          "the sync does not populate psRestricted yet.",
        rows: [],
      };
    }

    // studentNumber -> the federal categories for that student.
    //
    // Multi-race students are NEVER collapsed into a single "Two or more":
    // that is a reporting decision the school has not made, and it hides
    // exactly the students it claims to describe. A student with codes in two
    // categories counts under both, and the UI says so.
    //
    // Deduplicated per student AFTER rolling up, so a student carrying 203 and
    // 207 counts once under Asian rather than twice.
    const codesByNumber = new Map<string, string[]>();
    const unmappedCodes = new Set<string>();
    for (const r of restricted) {
      const labels = new Set<string>();
      for (const code of (r.raceCodes ?? []).filter(Boolean)) {
        const { label, mapped } = raceLabel(code);
        if (!mapped) unmappedCodes.add(code);
        labels.add(label);
      }
      if (labels.size) codesByNumber.set(r.studentNumber, [...labels]);
    }

    // Enrolment denominator, from the current roster.
    const roster = await ctx.db.query("psRoster").collect();
    const enrolledNumbers = new Set(roster.map((r) => r.studentNumber));
    const enrolledBy: Record<string, number> = {};
    for (const num of enrolledNumbers) {
      for (const code of codesByNumber.get(num) ?? []) {
        enrolledBy[code] = (enrolledBy[code] ?? 0) + 1;
      }
    }

    // Referrals live in the app blob, not their own table yet, so they arrive
    // through appState rather than a query here.
    const state = await ctx.db
      .query("appState")
      .withIndex("by_key", (q) => q.eq("key", "referrals"))
      .unique();
    const referrals: any[] = (state?.value as any)?.behaviorReferrals ?? [];
    const since = sinceIso ? Date.parse(sinceIso) : null;

    const referralsBy: Record<string, number> = {};
    let counted = 0;
    let unmatched = 0;
    for (const ref of referrals) {
      if (since !== null) {
        const t = Date.parse(ref?.submittedAt ?? "");
        if (!isFinite(t) || t < since) continue;
      }
      const num = String(ref?.studentNumber ?? ref?.studentId ?? "");
      const codes = codesByNumber.get(num);
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
      // Codes the mapping did not recognise, shown as themselves. Reported so
      // a new or district specific code is visible rather than quietly
      // becoming its own unlabelled bar.
      unmappedCodes: [...unmappedCodes],
      smallGroupThreshold: SMALL_GROUP,
      viewedAs: { role: staff.role },
    };
  },
});
