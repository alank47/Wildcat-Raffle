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

    // studentNumber -> the codes for that student. Multi-race students carry
    // several, and they are NEVER collapsed into a single "Two or more":
    // doing that is a reporting decision the school has not made, and it
    // hides exactly the students it claims to describe.
    const codesByNumber = new Map<string, string[]>();
    for (const r of restricted) {
      const codes = (r.raceCodes ?? []).filter(Boolean);
      if (codes.length) codesByNumber.set(r.studentNumber, codes);
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
      smallGroupThreshold: SMALL_GROUP,
      viewedAs: { role: staff.role },
    };
  },
});
