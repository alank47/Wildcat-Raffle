import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff } from "./identity";

/** Per-run summary. Brief Phase 7 point 2: rows in, rows changed, duration. */
export const record = internalMutation({
  args: { summary: v.any() },
  handler: async (ctx, { summary }) => {
    await ctx.db.insert("syncRuns", { at: new Date().toISOString(), summary });
    // Keep the last 200. A sync log that grows forever becomes the largest
    // table in the database and nobody reads past the first page anyway.
    const all = await ctx.db.query("syncRuns").withIndex("by_at").collect();
    if (all.length > 200) {
      for (const r of all.slice(0, all.length - 200)) await ctx.db.delete(r._id);
    }
  },
});

/** "Data as of" for the UI. Brief Phase 6 point 2. */
export const latest = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    const runs = await ctx.db.query("syncRuns").withIndex("by_at").order("desc").take(5);
    return {
      lastRun: runs[0] ?? null,
      recent: runs,
    };
  },
});
