import {
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { v } from "convex/values";
import { requireStaff } from "./identity";

/**
 * Web Push subscription plumbing. A staff member's browser subscribes once,
 * saves the endpoint + keys here against their email, and a hall-pass request
 * then schedules an action (pushSend.ts) that pushes to every device on file.
 * Nothing stored is a secret — see the schema note.
 */

export const subscribe = mutation({
  args: {
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireStaff(ctx); // teacher record; .email is normalized
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .unique();
    const doc = {
      endpoint: args.endpoint,
      p256dh: args.p256dh,
      auth: args.auth,
      teacherEmail: me.email,
      userAgent: args.userAgent,
      createdAt: new Date().toISOString(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return { ok: true, updated: true };
    }
    await ctx.db.insert("pushSubscriptions", doc);
    return { ok: true, created: true };
  },
});

export const unsubscribe = mutation({
  args: { endpoint: v.string() },
  handler: async (ctx, { endpoint }) => {
    const row = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return { ok: true };
  },
});

/** Every device on file for a teacher, keys included, for the send action. */
export const listForTeacher = internalQuery({
  args: { teacherEmail: v.string() },
  handler: async (ctx, { teacherEmail }) => {
    const rows = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_teacherEmail", (q) => q.eq("teacherEmail", teacherEmail))
      .take(50);
    return rows.map((r) => ({
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
    }));
  },
});

/** Drop endpoints the push service reported as gone (404/410). */
export const removeEndpoints = internalMutation({
  args: { endpoints: v.array(v.string()) },
  handler: async (ctx, { endpoints }) => {
    let removed = 0;
    for (const ep of endpoints) {
      const row = await ctx.db
        .query("pushSubscriptions")
        .withIndex("by_endpoint", (q) => q.eq("endpoint", ep))
        .unique();
      if (row) {
        await ctx.db.delete(row._id);
        removed++;
      }
    }
    return { removed };
  },
});
