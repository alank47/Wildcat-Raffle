import { QueryCtx, MutationCtx } from "./_generated/server";
import { ConvexError } from "convex/values";
import { classify, normalizeEmail, Identity } from "./identityRules";

/**
 * Server-side identity. This is the whole security boundary of the app.
 *
 * The browser cannot be trusted: it is a public static page and anyone can open
 * devtools. So nothing here reads a field the client supplies. Every value comes
 * from the verified token claims that Convex hands us after checking Google's or
 * Microsoft's signature.
 *
 * The decision logic itself lives in identityRules.ts, with no Convex imports,
 * so it can be tested directly rather than through a mirror that can drift.
 */

export { normalizeEmail } from "./identityRules";
export type { Identity } from "./identityRules";

/** Not guessed. Grilled.md says lapromisefund.org, the org's GAM tooling uses
 *  laspromise.org. Both come from deployment env vars, set from real
 *  PowerSchool users.email_addr values before staff sign-in is enabled. */
function staffOpts() {
  const staffDomain = process.env.STAFF_DOMAIN;
  const tenant = process.env.ENTRA_TENANT_ID;
  if (!staffDomain) throw new ConvexError("STAFF_DOMAIN is not configured on this deployment.");
  if (!tenant) throw new ConvexError("ENTRA_TENANT_ID is not configured on this deployment.");
  return {
    staffDomain,
    staffIssuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
  };
}

export async function requireIdentity(ctx: QueryCtx | MutationCtx): Promise<Identity> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new ConvexError("Not authenticated.");
  return classify(identity.issuer, identity.email, staffOpts());
}

/**
 * Staff only, resolved to their record.
 *
 * A valid token from the right domain is authentication, not authorization: it
 * proves who someone is, not that they belong in this system. A staff member
 * with no record is refused rather than created, so appearing here stays a
 * deliberate act by an admin.
 */
export async function requireStaff(ctx: QueryCtx | MutationCtx) {
  const id = await requireIdentity(ctx);
  if (id.kind !== "staff") throw new ConvexError("Staff only.");

  const teacher = await ctx.db
    .query("teachers")
    .withIndex("by_email", (q) => q.eq("email", id.email))
    .unique();

  if (!teacher) {
    throw new ConvexError(
      `No staff record for ${id.email}. An admin must add it, or the Entra ` +
        `address does not match the PowerSchool teacher_email.`,
    );
  }
  return teacher;
}

/** Admin-level staff, for the actions that change other people's data. */
export async function requireAdmin(ctx: QueryCtx | MutationCtx) {
  const teacher = await requireStaff(ctx);
  if (teacher.role !== "admin" && teacher.role !== "superadmin") {
    throw new ConvexError("Admins only.");
  }
  return teacher;
}

/**
 * Students resolve ONLY to themselves. There is no argument for which student to
 * fetch, on purpose: if the caller could name one, they could name any of them.
 */
export async function requireStudentSelf(ctx: QueryCtx | MutationCtx) {
  const id = await requireIdentity(ctx);
  if (id.kind !== "student") throw new ConvexError("Students only.");

  const student = await ctx.db
    .query("students")
    .withIndex("by_email", (q) => q.eq("email", id.email))
    .unique();

  if (!student) {
    throw new ConvexError(
      `No student record for ${id.email}. Student email arrives from ` +
        `PowerSchool manifest field 19, which is pending admin approval.`,
    );
  }
  return student;
}
