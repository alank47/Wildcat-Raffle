import { query, mutation, internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireStaff, requireAdmin } from "./identity";
import { normalizeEmail } from "./identityRules";

/**
 * Adding staff by inviting a real directory account, instead of creating one.
 *
 * WHAT THIS REPLACES. The old flow asked an admin to type a name, a username, an
 * email and a CLEARTEXT PASSWORD, then stored the password. That password field
 * is the reason the whole Convex migration exists, and the add-teacher form was
 * the last thing still creating them.
 *
 * There is no account to create here. The person already has one: Entra issued
 * it when the organization employed them. Inviting them means writing the row
 * that says which role they get, and their next Microsoft sign-in matches on
 * email and finds it.
 *
 * So an invite is a GRANT, not a credential. Nothing secret is generated,
 * nothing is emailed that could be intercepted, and there is no reset flow to
 * get wrong.
 */

/**
 * Search the mirrored directory.
 *
 * Staff only: the directory is a copy of colleagues' personal data and is not
 * something an unauthenticated caller may page through.
 *
 * A blank query returns NOTHING rather than everyone. Enumerating 543 people is
 * not a search, and a UI that opens by dumping the whole directory encourages
 * picking the first plausible row rather than the right one.
 */
export const searchDirectory = query({
  args: { q: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { q, limit }) => {
    await requireStaff(ctx);

    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return { results: [], tooShort: true, mirroredAt: null };

    const [rows, existing] = await Promise.all([
      ctx.db.query("entraDirectory").collect(),
      ctx.db.query("teachers").collect(),
    ]);

    const alreadyStaff = new Set(existing.map((t) => normalizeEmail(t.email)));

    const matches = rows
      .filter((r) => r.searchText.includes(needle))
      // Somebody who already has access is still SHOWN, flagged, rather than
      // hidden. Hiding them makes an admin search again for a person they can
      // see in Outlook, and conclude the search is broken.
      .map((r) => ({
        email: r.email,
        name: r.name,
        jobTitle: r.jobTitle ?? "",
        department: r.department ?? "",
        alreadyHasAccess: alreadyStaff.has(r.email),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit ?? 25);

    return {
      results: matches,
      tooShort: false,
      mirroredAt: rows[0]?.mirroredAt ?? null,
      directorySize: rows.length,
    };
  },
});

/**
 * Grant a directory account access at a chosen role.
 *
 * THREE THINGS IT REFUSES, each because the alternative is worse than an error:
 *
 *   1. An email not in the mirrored directory. Typing an address by hand is how
 *      a typo becomes an account nobody can sign into, and how somebody outside
 *      the organization gets granted access.
 *   2. An address outside the staff domain. Students are a different domain and
 *      a different provider; a staff row on the student domain can never sign in.
 *   3. superadmin, unless the caller is already superadmin. Otherwise the lowest
 *      privileged admin can promote themselves in two clicks.
 */
export const inviteStaff = mutation({
  args: {
    email: v.string(),
    role: v.union(
      v.literal("teacher"),
      v.literal("campusaide"),
      v.literal("pbis"),
      v.literal("admin"),
      v.literal("superadmin"),
    ),
  },
  handler: async (ctx, { email, role }) => {
    // requireAdmin returns the caller's teacher row and throws for a teacher or
    // campus aide, so the privilege check is the existing one rather than a
    // second copy that can drift from it.
    const caller = await requireAdmin(ctx);

    // Escalation guard: an admin may grant up to admin, never superadmin.
    // Without this the least privileged admin promotes themselves in two clicks.
    if (role === "superadmin" && caller.role !== "superadmin") {
      throw new ConvexError("Only a superadmin can grant superadmin.");
    }

    const target = normalizeEmail(email);
    const staffDomain = (process.env.STAFF_DOMAIN ?? "").trim().toLowerCase();
    if (!staffDomain) throw new ConvexError("STAFF_DOMAIN is not configured.");
    if (target.slice(target.lastIndexOf("@") + 1) !== staffDomain) {
      throw new ConvexError(
        `Staff sign in with @${staffDomain} addresses. "${target}" is not one.`,
      );
    }

    const inDirectory = await ctx.db
      .query("entraDirectory")
      .withIndex("by_email", (q) => q.eq("email", target))
      .unique();
    if (!inDirectory) {
      throw new ConvexError(
        `${target} is not in the directory mirror. Pick a person from the search ` +
          `results rather than typing an address, or refresh the mirror with ` +
          `npm run staff:mirror.`,
      );
    }

    const existing = await ctx.db
      .query("teachers")
      .withIndex("by_email", (q) => q.eq("email", target))
      .unique();

    if (existing) {
      // Already has access. Change the role rather than refusing, because
      // "invite at a different role" is exactly what an admin means when they
      // invite somebody who is already here.
      if (existing.role === role) {
        return { outcome: "unchanged", email: target, role };
      }
      await ctx.db.patch(existing._id, { role });
      return { outcome: "role-changed", email: target, role, previousRole: existing.role };
    }

    await ctx.db.insert("teachers", {
      name: inDirectory.name || target,
      email: target,
      role,
      ticketsAwarded: 0,
      createdDate: new Date().toISOString(),
    });
    return { outcome: "invited", email: target, role };
  },
});

/** Replace the directory mirror. Called by npm run staff:mirror. */
export const replaceDirectory = internalMutation({
  args: {
    people: v.array(
      v.object({
        email: v.string(),
        name: v.string(),
        jobTitle: v.optional(v.string()),
        department: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { people }) => {
    // Full replace, so somebody who left the organization stops being
    // invitable the moment the mirror refreshes. A merge would keep them
    // forever.
    const old = await ctx.db.query("entraDirectory").collect();
    for (const row of old) await ctx.db.delete(row._id);

    const mirroredAt = new Date().toISOString();
    let written = 0;
    for (const person of people) {
      const email = normalizeEmail(person.email);
      if (!email.includes("@")) continue;
      await ctx.db.insert("entraDirectory", {
        email,
        name: person.name,
        jobTitle: person.jobTitle,
        department: person.department,
        searchText: `${person.name} ${email} ${person.jobTitle ?? ""}`.toLowerCase(),
        mirroredAt,
      });
      written++;
    }
    return { removed: old.length, written, mirroredAt };
  },
});

/**
 * ADMIN ONLY: the address PowerSchool files this person's sections under.
 *
 * WHY THIS EXISTS. A name change gives someone a new address. Entra issues it,
 * the app's staff record follows it, and sign-in works. PowerSchool keeps
 * filing their sections under the old one until a registrar changes it, so
 * `psRoster.teacherEmail` matches nothing and that teacher opens the app to no
 * classes at all -- with every student in the school listed instead, because
 * there is no section to narrow by.
 *
 * The real fix is in the SIS, and this does not replace it. It is the patch
 * that gets a teacher through the week, and it is meant to be cleared.
 *
 * WHAT IT IS NOT. Not an alias, not a second identity, and never consulted by
 * authentication. Sign-in, referral ownership and every permission check read
 * `email` and are untouched. The ONLY thing this changes is which
 * `teacherEmail` the roster lookup uses.
 *
 * TWO REFUSALS, BOTH DELIBERATE:
 *
 *  - An address that belongs to another staff record is refused here, because
 *    pointing one teacher at another's sections is the whole risk.
 *  - It is refused AGAIN on every read, in rosterEmailFor. An address that is
 *    unclaimed today can be claimed tomorrow -- a new hire, or an old account
 *    re-enabled -- and a check that only ran at write time would never see it.
 *
 * INTERNAL, so no browser can reach it under any role. There is no screen that
 * needs this: it is a rare repair for a mismatch between two systems, done
 * deliberately by whoever is holding the deploy key, and a button for it would
 * be a button for pointing one teacher at another teacher's class lists. Run:
 *
 *   npx convex run staffInvites:setPowerSchoolEmail --prod \
 *     '{"email":"them@lapromisefund.org","psEmail":"older@lapromisefund.org"}'
 *
 * Pass an empty psEmail to clear it, which is what to do once the SIS is fixed.
 */
export const setPowerSchoolEmail = internalMutation({
  args: { email: v.string(), psEmail: v.string() },
  handler: async (ctx, { email, psEmail }) => {
    const target = String(email ?? "").trim().toLowerCase();
    const alt = String(psEmail ?? "").trim().toLowerCase();
    if (!target) throw new ConvexError("No staff email given.");

    const staff = await ctx.db
      .query("teachers")
      .withIndex("by_email", (q) => q.eq("email", target))
      .unique();
    if (!staff) throw new ConvexError(`No staff record for ${target}.`);

    if (!alt) {
      await ctx.db.patch(staff._id, { psEmail: undefined });
      console.log(`[roster] cleared psEmail for ${target}`);
      return { email: target, psEmail: null, cleared: true };
    }

    if (alt === target) {
      throw new ConvexError(
        "That is already the sign-in address; clear the field instead.",
      );
    }

    const owner = await ctx.db
      .query("teachers")
      .withIndex("by_email", (q) => q.eq("email", alt))
      .first();
    if (owner) {
      throw new ConvexError(
        `${alt} is another staff member's sign-in address (${owner.name}). ` +
        "Pointing one teacher at another's roster is not something this can do.",
      );
    }

    await ctx.db.patch(staff._id, { psEmail: alt });
    // Written to the log rather than only to the row: this is one person being
    // given another address's sections, and it should be findable afterwards.
    console.log(`[roster] set psEmail for ${target} -> ${alt}`);
    return { email: target, psEmail: alt, cleared: false };
  },
});
