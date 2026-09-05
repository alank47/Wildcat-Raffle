import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff } from "./identity";

/**
 * The audit log, as a table.
 *
 * WHAT THIS REPLACES. Entries lived as rows inside weekly `legacyMirror`
 * documents and were saved with `legacyData:mergeSlice`, which reads the whole
 * stored slice to merge it. Convex counts a delete as a read, so appending one
 * entry to a week holding 1,278 cost 2,556 reads against a 4,096 limit: a
 * ceiling near 2,048 entries a week, and the client re-sent the entire month on
 * every save regardless.
 *
 * One entry is written per student per cash award. Thirty-four teachers
 * awarding whole classes cross 2,048 mid-week, and the failure is the quiet
 * kind -- cash awards keep working because balances live elsewhere, while the
 * record of who gave what stops being written.
 *
 * Here an append is one indexed lookup and one insert per entry. The cost is
 * proportional to what is being SENT, never to what is already stored, so the
 * log can grow for years without the write path changing shape.
 *
 * WHAT IS DELIBERATELY UNCHANGED. The entry payload is stored verbatim, in the
 * exact shape the app has written since the Firestore era. Every analytics
 * screen, export and PBIS report reads that shape. Moving the transport and
 * rewriting the records at the same time would mean a wrong number afterwards
 * could not be attributed to either.
 */

/** One append may carry this many entries. The client chunks to match. */
const MAX_APPEND = 500;

/** A window may return this many entries per page, well under the read limit. */
const PAGE = 1000;

/**
 * Append entries, skipping any already stored.
 *
 * IDEMPOTENT BY entryId, which is what makes it safe to call from two tabs, to
 * retry after a failure, and to replay the browser's outbox without producing
 * duplicates. An entry already present is left exactly as it is: the stored
 * copy wins, the same rule mergeSlice has always used, because the incoming one
 * may come from a tab that has been open for hours.
 *
 * Returns what it actually did rather than a bare success, so the client can
 * report honestly and so a replay that writes nothing is visible as such.
 */
export const append = mutation({
  args: {
    entries: v.array(v.object({
      entryId: v.string(),
      timestamp: v.string(),
      payload: v.any(),
    })),
  },
  handler: async (ctx, { entries }) => {
    await requireStaff(ctx);

    if (entries.length > MAX_APPEND) {
      throw new Error(
        `auditLog:append refused ${entries.length} entries; the cap is ${MAX_APPEND}. ` +
        "Send them in chunks.",
      );
    }

    let inserted = 0;
    let alreadyStored = 0;
    let skipped = 0;

    // Within-batch duplicates are dropped here rather than costing a second
    // lookup. Two tabs sending the same entry is normal; the same entry twice
    // in one payload means the caller built it wrong, and inserting both would
    // put a duplicate in a table whose whole purpose is not having them.
    const seenInBatch = new Set<string>();

    for (const e of entries) {
      const id = String(e.entryId ?? "").trim();
      // An entry with no id cannot be deduped, and inserting it would create a
      // row nothing can ever match again -- so every replay would insert
      // another. Refusing one entry is better than an unbounded duplicate.
      if (!id) { skipped++; continue; }
      if (seenInBatch.has(id)) { skipped++; continue; }
      seenInBatch.add(id);

      const existing = await ctx.db
        .query("appAuditLog")
        .withIndex("by_entryId", (q) => q.eq("entryId", id))
        .first();
      if (existing) { alreadyStored++; continue; }

      await ctx.db.insert("appAuditLog", {
        entryId: id,
        timestamp: String(e.timestamp ?? ""),
        payload: e.payload,
      });
      inserted++;
    }

    return { inserted, alreadyStored, skipped, received: entries.length };
  },
});

/**
 * A window of the log, oldest first, paged.
 *
 * `since` bounds the read; without one this would grow into the same read-limit
 * wall the documents hit, just further away. The client asks for the range it
 * intends to show and pages until done, so a single execution never reads more
 * than PAGE rows however large the log becomes.
 *
 * Oldest first because that is the order the app has always held `auditLog` in,
 * and several screens assume it.
 */
export const list = query({
  args: {
    since: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { since, cursor, limit }) => {
    await requireStaff(ctx);

    const numItems = Math.min(Math.max(1, limit ?? PAGE), PAGE);
    const q = ctx.db
      .query("appAuditLog")
      .withIndex("by_timestamp", (ix) => (since ? ix.gte("timestamp", since) : ix))
      .order("asc");

    const page = await q.paginate({ cursor: cursor ?? null, numItems });
    return {
      entries: page.page.map((r) => r.payload),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Move entries out of the legacyMirror documents and into this table.
 *
 * internalMutation: run from the migration script with the deploy key, never
 * from a browser. Idempotent on entryId like `append`, so it can be run again
 * after a partial failure without duplicating anything.
 *
 * IT DOES NOT DELETE THE SOURCE. The legacyMirror rows stay exactly where they
 * are until the table has been read back and verified. A migration that
 * destroys its own input has no way back if the destination is wrong.
 */
export const importEntries = internalMutation({
  args: {
    entries: v.array(v.object({
      entryId: v.string(),
      timestamp: v.string(),
      payload: v.any(),
    })),
  },
  handler: async (ctx, { entries }) => {
    let inserted = 0;
    let alreadyStored = 0;
    let skipped = 0;
    const seen = new Set<string>();

    for (const e of entries) {
      const id = String(e.entryId ?? "").trim();
      if (!id || seen.has(id)) { skipped++; continue; }
      seen.add(id);

      const existing = await ctx.db
        .query("appAuditLog")
        .withIndex("by_entryId", (q) => q.eq("entryId", id))
        .first();
      if (existing) { alreadyStored++; continue; }

      await ctx.db.insert("appAuditLog", {
        entryId: id,
        timestamp: String(e.timestamp ?? ""),
        payload: e.payload,
      });
      inserted++;
    }
    return { inserted, alreadyStored, skipped, received: entries.length };
  },
});
