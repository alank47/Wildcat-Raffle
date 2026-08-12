import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { normalizeEmail } from "./identityRules";

/**
 * One-way mirror of the Firestore data into Convex.
 *
 * DELIBERATELY SEPARATE FROM sisSync. That function may not write earned value
 * under any circumstance; this one exists precisely to carry it across. Same
 * table, opposite intent, so they are different functions with different names
 * rather than one function with a flag. A flag would eventually be passed
 * wrongly and spend a child's balance.
 *
 * Idempotent on studentNumber, so the mirror can be re-run as often as needed
 * while the app keeps writing to Firestore. Re-running is the normal case, not
 * an exception: this runs repeatedly during the migration to keep the mirror
 * fresh until the cutover.
 */
export const importStudents = internalMutation({
  args: {
    students: v.array(
      v.object({
        studentNumber: v.string(),
        firstName: v.string(),
        lastName: v.string(),
        grade: v.optional(v.string()),
        email: v.optional(v.string()),
        school: v.optional(v.string()),
        pbisTickets: v.number(),
        attendanceTickets: v.number(),
        academicTickets: v.number(),
        bigRaffleQualified: v.array(v.union(v.string(), v.number())),
        weeksQualified: v.optional(v.number()),
        wildcatCashBalance: v.optional(v.number()),
        wildcatCashEarned: v.optional(v.number()),
        wildcatCashSpent: v.optional(v.number()),
        wildcatCashDeducted: v.optional(v.number()),
        wildcatCashRewardsRedeemed: v.optional(v.array(v.any())),
        wildcatCashTransactions: v.optional(v.array(v.any())),
        cashBalance: v.optional(v.number()),
        cashTransactions: v.optional(v.array(v.any())),
      }),
    ),
  },
  handler: async (ctx, { students }) => {
    const existing = await ctx.db.query("students").collect();
    const byNumber = new Map(existing.map((s) => [s.studentNumber ?? "", s]));

    let created = 0, updated = 0;
    for (const s of students) {
      const doc = {
        legacyId: s.studentNumber,
        studentNumber: s.studentNumber,
        firstName: s.firstName,
        lastName: s.lastName,
        grade: s.grade,
        email: normalizeEmail(s.email) || undefined,
        school: (s.school === "middleschool" || s.school === "highschool"
          ? s.school
          : undefined) as "middleschool" | "highschool" | undefined,
        pbisTickets: s.pbisTickets,
        attendanceTickets: s.attendanceTickets,
        academicTickets: s.academicTickets,
        bigRaffleQualified: s.bigRaffleQualified,
        weeksQualified: s.weeksQualified,
        wildcatCashBalance: s.wildcatCashBalance,
        wildcatCashEarned: s.wildcatCashEarned,
        wildcatCashSpent: s.wildcatCashSpent,
        wildcatCashDeducted: s.wildcatCashDeducted,
        wildcatCashRewardsRedeemed: s.wildcatCashRewardsRedeemed,
        wildcatCashTransactions: s.wildcatCashTransactions,
        cashBalance: s.cashBalance,
        cashTransactions: s.cashTransactions,
      };
      const prior = byNumber.get(s.studentNumber);
      if (prior) { await ctx.db.patch(prior._id, doc); updated++; }
      else { await ctx.db.insert("students", doc); created++; }
    }
    return { created, updated, received: students.length };
  },
});

/**
 * Totals for reconciliation against the source.
 *
 * Counts alone would pass while every balance was wrong, so this sums the
 * money and the tickets too. The migration is only trustworthy if these match
 * Firestore exactly, to the unit.
 */
export const studentTotals = internalMutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("students").collect();
    const sum = (f: (s: (typeof all)[number]) => number) =>
      all.reduce((a, s) => a + (f(s) || 0), 0);
    return {
      count: all.length,
      withEmail: all.filter((s) => (s.email ?? "").includes("@")).length,
      pbisTickets: sum((s) => s.pbisTickets),
      attendanceTickets: sum((s) => s.attendanceTickets),
      academicTickets: sum((s) => s.academicTickets),
      wildcatCashBalance: sum((s) => s.wildcatCashBalance ?? 0),
      wildcatCashEarned: sum((s) => s.wildcatCashEarned ?? 0),
      wildcatCashSpent: sum((s) => s.wildcatCashSpent ?? 0),
      cashBalance: sum((s) => s.cashBalance ?? 0),
      bigRaffleEntries: sum((s) => s.bigRaffleQualified.length),
    };
  },
});
