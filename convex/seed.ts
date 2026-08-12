import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { normalizeEmail } from "./identityRules";

/**
 * Seed staff records from the existing Firestore data.
 *
 * `internalMutation`: reachable only with a deploy key, never from a browser.
 *
 * THE PASSWORD FIELD IS NOT CARRIED ACROSS. The Firestore teacher records hold
 * cleartext passwords, and that field is the reason this whole migration
 * exists. There is no argument on this mutation that could carry one, so it
 * cannot be imported by accident.
 *
 * Idempotent: matches on legacyId and updates in place, so re-running after a
 * backfill of missing emails does not create duplicates.
 */
export const seedTeachers = internalMutation({
  args: {
    teachers: v.array(
      v.object({
        legacyId: v.string(),
        name: v.string(),
        email: v.optional(v.string()),
        role: v.union(
          v.literal("teacher"),
          v.literal("admin"),
          v.literal("superadmin"),
          v.literal("campusaide"),
        ),
        ticketsAwarded: v.optional(v.number()),
        sections: v.optional(v.array(v.string())),
        createdDate: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { teachers }) => {
    let inserted = 0;
    let updated = 0;
    let withEmail = 0;
    let withoutEmail = 0;

    const existing = await ctx.db.query("teachers").collect();
    const byLegacyId = new Map(existing.map((t) => [t.legacyId, t]));

    for (const t of teachers) {
      // Empty string must not become an index key: "" would match every other
      // teacher who also has no email, and .unique() would then throw for all
      // of them rather than reporting a clean "no record".
      const email = normalizeEmail(t.email) || undefined;
      if (email) withEmail++;
      else withoutEmail++;

      const doc = {
        legacyId: t.legacyId,
        name: t.name,
        email: email ?? "",
        role: t.role,
        ticketsAwarded: t.ticketsAwarded ?? 0,
        sections: t.sections ?? [],
        createdDate: t.createdDate ?? new Date(0).toISOString(),
      };

      const prior = byLegacyId.get(t.legacyId);
      if (prior) {
        await ctx.db.patch(prior._id, doc);
        updated++;
      } else {
        await ctx.db.insert("teachers", doc);
        inserted++;
      }
    }

    // withoutEmail is the number of staff who CANNOT sign in with Entra yet,
    // because the email is the only thing linking a token to a record. It is
    // returned rather than logged so the caller has to look at it.
    return { inserted, updated, withEmail, withoutEmail };
  },
});

/** Counts only, never addresses. Safe to run any time to check readiness. */
export const staffAuthReadiness = internalMutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("teachers").collect();
    const withEmail = all.filter((t) => (t.email ?? "").includes("@"));
    return {
      totalStaff: all.length,
      canSignIn: withEmail.length,
      cannotSignIn: all.length - withEmail.length,
      byRole: all.reduce<Record<string, number>>((acc, t) => {
        acc[t.role] = (acc[t.role] ?? 0) + 1;
        return acc;
      }, {}),
    };
  },
});

/** Staff names for the one-time Entra email backfill. Internal only. */
export const listStaffForMatching = internalMutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("teachers").collect();
    return all.map((t) => ({
      legacyId: t.legacyId ?? "",
      name: t.name,
      role: t.role,
      hasEmail: Boolean((t.email ?? "").includes("@")),
    }));
  },
});

/**
 * One-time backfill of staff emails matched from the Entra directory.
 *
 * Sets the email field and NOTHING else. Deliberately narrower than
 * seedTeachers: a backfill that can also rewrite role or ticketsAwarded is a
 * backfill that can silently demote someone or zero their counts.
 *
 * Refuses to overwrite an email that is already set, so re-running cannot
 * clobber a correction made by hand afterwards.
 */
export const backfillEmails = internalMutation({
  args: {
    matches: v.array(v.object({ legacyId: v.string(), email: v.string() })),
  },
  handler: async (ctx, { matches }) => {
    const all = await ctx.db.query("teachers").collect();
    const byLegacyId = new Map(all.map((t) => [t.legacyId, t]));

    let filled = 0, skippedAlreadySet = 0, notFound = 0, rejected = 0;
    for (const m of matches) {
      const t = byLegacyId.get(m.legacyId);
      if (!t) { notFound++; continue; }
      if ((t.email ?? "").includes("@")) { skippedAlreadySet++; continue; }

      const email = normalizeEmail(m.email);
      // Guard: only addresses on the staff domain. A directory match on a
      // stale account from another domain must not become a sign-in identity.
      const domain = email.slice(email.lastIndexOf("@") + 1);
      if (!email.includes("@") || domain !== (process.env.STAFF_DOMAIN ?? "").toLowerCase()) {
        rejected++;
        continue;
      }
      await ctx.db.patch(t._id, { email });
      filled++;
    }
    return { filled, skippedAlreadySet, notFound, rejected };
  },
});

/** legacyId -> email, for pushing the backfill back into the app's own store. */
export const exportStaffEmails = internalMutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("teachers").collect();
    return all
      .filter((t) => (t.email ?? "").includes("@"))
      .map((t) => ({ legacyId: t.legacyId ?? "", email: t.email }));
  },
});
