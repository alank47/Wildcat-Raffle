import { mutation, internalMutation } from "./_generated/server";
import { requireIdentity } from "./identity";

/**
 * Records that a real person completed a federated sign-in.
 *
 * PUBLIC mutation, but it takes no arguments and derives everything from the
 * verified token, so the only thing a caller can assert is that they
 * themselves just signed in. There is nothing here to forge.
 *
 * It exists to make the cutover gate mechanical: the script that deletes the
 * cleartext passwords refuses to run until enough distinct staff appear here.
 * A runbook step gets skipped; an interlock does not.
 */
export const record = mutation({
  args: {},
  handler: async (ctx) => {
    const id = await requireIdentity(ctx);
    await ctx.db.insert("authEvents", {
      email: id.email,
      provider: id.kind === "staff" ? "microsoft.com" : "google.com",
      kind: id.kind,
      at: new Date().toISOString(),
    });
    return { recorded: true, kind: id.kind };
  },
});

/** How many DISTINCT people have proven federated sign-in works. */
export const readiness = internalMutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("authEvents").collect();
    const staff = new Set(all.filter((e) => e.kind === "staff").map((e) => e.email));
    const students = new Set(all.filter((e) => e.kind === "student").map((e) => e.email));
    return {
      totalEvents: all.length,
      distinctStaff: staff.size,
      distinctStudents: students.size,
      lastAt: all.map((e) => e.at).sort().pop() ?? null,
    };
  },
});
