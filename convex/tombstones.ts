import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff } from "./identity";

/**
 * Tombstones: the record of what was deliberately deleted.
 *
 * WHY THIS EXISTS AT ALL. Ticket and audit entries are removed by hand
 * (a mis-award, a duplicate). The stores they live in are rebuilt from
 * whatever a tab happens to hold, so a deletion that is only an absence gets
 * undone by the next save from a tab that still has the entry, or by any
 * restored backup. Recording the deletion is what makes it stick: every load
 * filters against this list. `applyTombstonesToLocalState` in script.js is the
 * consumer.
 *
 * WHY IT MOVED. It lived in the Firestore document `raffle_data/tombstones`,
 * written through an arrayUnion. That document is world readable and world
 * writable to anyone holding the project id, which ships in the page source,
 * so an entry could be resurrected by a stranger. Here the browser cannot
 * reach the table: it calls these two functions and both authenticate first.
 *
 * WHY entryId IS THE IDENTITY AND NOT THE ROW. The Firestore write was an
 * arrayUnion on one document, which de-duplicates by whole-object equality:
 * deleting the same entry twice with a different reason wrote TWO tombstones,
 * and the array grew without bound. Here `record` upserts on entryId, so the
 * list holds one row per deleted entry no matter how many times it is deleted.
 * The later reason wins, which matches what an admin re-deleting something
 * means.
 */

/**
 * Record one deletion. Idempotent on entryId, so a retry after a dropped
 * connection cannot double-write.
 */
export const record = mutation({
  args: {
    entryId: v.string(),
    type: v.string(),
    deletedBy: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireStaff(ctx);

    const existing = await ctx.db
      .query("tombstones")
      .withIndex("by_entryId", (q) => q.eq("entryId", args.entryId))
      .unique();

    const row = {
      entryId: args.entryId,
      type: args.type,
      deletedBy: args.deletedBy,
      reason: args.reason,
      deletedAt: new Date().toISOString(),
    };

    if (existing) {
      // Keep the ORIGINAL deletedAt. When the entry first disappeared is the
      // fact worth having; re-deleting it is not a new event.
      await ctx.db.patch(existing._id, {
        type: row.type,
        deletedBy: row.deletedBy,
        reason: row.reason,
      });
      return { entryId: args.entryId, created: false };
    }

    await ctx.db.insert("tombstones", row);
    return { entryId: args.entryId, created: true };
  },
});

/**
 * Every tombstone, for the filter that runs on load.
 *
 * Returned as plain objects in the shape script.js already expects from the
 * Firestore document, so `applyTombstonesToLocalState` is unchanged.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);

    const rows = await ctx.db.query("tombstones").collect();
    return rows.map((r) => ({
      entryId: r.entryId,
      type: r.type,
      deletedBy: r.deletedBy ?? null,
      reason: r.reason ?? null,
      deletedAt: r.deletedAt,
    }));
  },
});
