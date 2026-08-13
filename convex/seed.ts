import { internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
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

/**
 * Create staff rows for people who exist in Entra but not here.
 *
 * ALWAYS at role "teacher", the lowest privilege. Role is a human decision and
 * the directory cannot make it: a jobTitle of "Principal" is not the same
 * statement as "may zero out a child's balance". An admin promotes afterwards.
 *
 * Only creates. An existing row is never touched, so running this cannot
 * change somebody's role, rename them, or reset their ticket count.
 *
 * Matched and deduplicated on normalized email, because Entra issues the claim
 * with directory casing (First.Last@domain) while records hold first.last.
 */
export const provisionStaff = internalMutation({
  args: {
    staff: v.array(v.object({ email: v.string(), name: v.string() })),
  },
  handler: async (ctx, { staff }) => {
    let created = 0;
    let skipped = 0;
    const wrongDomain: string[] = [];
    const now = new Date().toISOString();

    // Staff and students are on SEPARATE domains, and that separation is the
    // whole identity model: staff are @lapromisefund.org via Entra, students
    // are @westbrookacademy.org via Google.
    //
    // PowerSchool holds at least one staff record carrying a STUDENT domain
    // address (sub1@westbrookacademy.org, a vacancy), so this is not
    // hypothetical. Such a row could never sign in as staff, because classify()
    // requires the Entra issuer AND the staff domain together, so it is not a
    // privilege escalation. It is worse in a quieter way: a permanently
    // unusable staff row that looks like an account somebody has.
    //
    // Refused here rather than in the script, because the script is one caller
    // and this is the only place that writes.
    const staffDomain = (process.env.STAFF_DOMAIN ?? "").trim().toLowerCase();
    if (!staffDomain) {
      throw new ConvexError("STAFF_DOMAIN is not configured on this deployment.");
    }

    for (const person of staff) {
      const email = person.email.trim().toLowerCase();
      if (!email.includes("@")) {
        skipped++;
        continue;
      }
      if (email.slice(email.lastIndexOf("@") + 1) !== staffDomain) {
        wrongDomain.push(email);
        skipped++;
        continue;
      }
      const existing = await ctx.db
        .query("teachers")
        .withIndex("by_email", (q) => q.eq("email", email))
        .unique();
      if (existing) {
        skipped++;
        continue;
      }
      await ctx.db.insert("teachers", {
        name: person.name || email,
        email,
        role: "teacher",
        ticketsAwarded: 0,
        createdDate: now,
      });
      created++;
    }

    return {
      created,
      skipped,
      // Named, not just counted. A staff record on the student domain is a
      // data error in PowerSchool that somebody has to go and fix, and a
      // silent skip is how it stays broken for a year.
      refusedWrongDomain: wrongDomain,
    };
  },
});

/**
 * Change one person's role.
 *
 * internalMutation, so it needs the deploy key and is unreachable from a
 * browser. That is the point: the in-app invite flow deliberately refuses to
 * grant superadmin unless the caller is already one, so an admin cannot promote
 * themselves through the UI. Bootstrapping a second superadmin has to happen
 * out of band, by somebody holding deployment credentials.
 *
 * Changes ONLY the role. Not the name, not the email, not ticketsAwarded, so a
 * promotion cannot quietly rewrite anything else about a person.
 *
 * Returns the previous role rather than just succeeding, because "it was
 * already superadmin" and "it was a teacher a moment ago" are different facts
 * and only one of them is worth telling somebody about.
 */
export const setStaffRole = internalMutation({
  args: {
    email: v.string(),
    role: v.union(
      v.literal("teacher"),
      v.literal("campusaide"),
      v.literal("admin"),
      v.literal("superadmin"),
    ),
  },
  handler: async (ctx, { email, role }) => {
    const target = normalizeEmail(email);
    const teacher = await ctx.db
      .query("teachers")
      .withIndex("by_email", (q) => q.eq("email", target))
      .unique();

    if (!teacher) {
      throw new ConvexError(
        `No staff record for ${target}. Invite them first, or check the address.`,
      );
    }

    const previousRole = teacher.role;
    if (previousRole === role) {
      return { outcome: "unchanged", email: target, role, previousRole };
    }

    await ctx.db.patch(teacher._id, { role });

    // A superadmin count of zero locks everyone out of the settings that only a
    // superadmin can reach, and a count of one means a single person leaving
    // does exactly that. Returned so the caller sees it rather than finding out
    // later.
    const all = await ctx.db.query("teachers").collect();
    const superadmins = all.filter((t) => t.role === "superadmin").length;

    return { outcome: "changed", email: target, previousRole, role, superadmins };
  },
});
