import { QueryCtx, MutationCtx } from "./_generated/server";
import { ConvexError } from "convex/values";
import { classify, normalizeEmail, studentRecordVerdict, Identity } from "./identityRules";

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

/**
 * `.unique()` that explains itself instead of being redacted.
 *
 * `.unique()` throws a PLAIN Error when a second row matches, and Convex redacts
 * a plain Error in production: the caller sees "Server Error" and a request id.
 * Two student records sharing one email therefore locked both children out of
 * every screen in the app with no readable cause anywhere, inside the very
 * boundary whose file header says ConvexError on every throw for exactly this
 * reason.
 *
 * A duplicate here is a real and reachable state: `students.email` has no
 * uniqueness constraint, the SIS writes it, and the migration notes record
 * former students being carried alongside enrolled ones. So this names the
 * table, the address and the fix.
 */
async function uniqueOrExplain<T>(
  q: { unique: () => Promise<T | null> },
  table: string,
  email: string,
): Promise<T | null> {
  try {
    return await q.unique();
  } catch {
    // The only thing .unique() throws is "more than one matching document".
    throw new ConvexError(
      `More than one ${table} record has the address ${email}, so this account ` +
        `cannot be resolved to one person and has been refused rather than ` +
        `guessed at. An admin must merge or archive the duplicate in ${table}.`,
    );
  }
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

  const teacher = await uniqueOrExplain(
    ctx.db.query("teachers").withIndex("by_email", (q) => q.eq("email", id.email)),
    "teachers",
    id.email,
  );

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
 *
 * A valid token is authentication, not enrolment. The archived check below is
 * the same principle requireStaff states above, applied to the side of the app
 * that can now WRITE: a student who left the roster keeps a working Google
 * account, and without this they keep opening hall passes. See
 * studentRecordVerdict in identityRules.ts for why the refusal is worded the way
 * it is.
 */
export async function requireStudentSelf(ctx: QueryCtx | MutationCtx) {
  const id = await requireIdentity(ctx);
  if (id.kind !== "student") throw new ConvexError("Students only.");

  const student = await uniqueOrExplain(
    ctx.db.query("students").withIndex("by_email", (q) => q.eq("email", id.email)),
    "students",
    id.email,
  );

  if (!student) {
    throw new ConvexError(
      `No student record for ${id.email}. Student emails now sync from the ` +
        `Person email model in PowerSchool, so this address either belongs to a ` +
        `student who is not enrolled at this school, or the record has a ` +
        `different address on file. The office can check Student Profile > Email.`,
    );
  }

  const verdict = studentRecordVerdict(student);
  if (!verdict.ok) throw new ConvexError(verdict.reason);

  return student;
}
