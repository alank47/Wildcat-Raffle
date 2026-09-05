import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * Reader half of the audit migration.
 *
 * Separate file because the action half declares "use node", and a Convex
 * module in the Node runtime may only export actions. Queries live here.
 */
/**
 * One page of legacyMirror rows.
 *
 * Paged because the whole table is megabytes and a single execution would hit
 * the same byte limit that broke `legacyData:load`.
 */
export const legacyAuditPage = internalQuery({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, { cursor, numItems }) => {
    const page = await ctx.db
      .query("legacyMirror")
      .paginate({ cursor: cursor ?? null, numItems: numItems ?? 300 });

    // Only the audit slices. No index expresses "collection = auditLog across
    // every doc", so the page is filtered here; pages are small and this runs
    // once.
    const rows = page.page
      .filter((r) => r.collection === "auditLog")
      .map((r) => ({ doc: r.doc, payload: r.payload }));

    return { rows, cursor: page.continueCursor, isDone: page.isDone };
  },
});

