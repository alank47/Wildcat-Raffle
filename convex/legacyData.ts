import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff } from "./identity";

/**
 * The app-facing half of the legacy mirror.
 *
 * WHY THIS FILE EXISTS. The 2026-08-11 migration copied every remaining
 * Firestore document into `legacyMirror` — 10,456 rows, reconciled to the
 * unit — and then stopped. The only functions that could reach that table
 * were `mirror:putSlice` and friends, which are internalMutations and need
 * the deploy key, so the data was in Convex and the browser could not read a
 * byte of it. That is the whole reason the app still talked to Firestore for
 * ticket history, the audit log, referrals, schedules and `secondary`: not a
 * missing table, a missing function.
 *
 * WHY IT MIRRORS THE DOCUMENT SHAPE INSTEAD OF MODELLING IT. `load` rebuilds
 * the exact object each Firestore document used to hand back, so the merge
 * logic in loadData — the entryId dedupe across six ticket-history partitions,
 * the monthly-plus-legacy audit merge — is untouched. A cutover that changes
 * the transport AND the shape at the same time cannot tell a transport bug
 * from a shape bug, and this data is student ticket history and an audit log:
 * the failure mode is silent double-counting, not an exception.
 *
 * Modelling these into real tables (`ticketHistory` and `auditLog` already
 * exist and are empty) is the NEXT job, and it is safe to do once this one is
 * proven, because by then Firestore is no longer the thing being compared to.
 *
 * THE INVERSE OF mirror-refresh.mjs. That script writes one row per array
 * element, with `key` set when the source was a map rather than a list. So a
 * slice whose rows carry a key rebuilds as an object, and one whose rows do
 * not rebuilds as an array. Getting this backwards turns a histories map into
 * a list and every student's history disappears without an error.
 */

/** Rebuild every mirrored document as the object the app used to read. */
export const load = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);

    const rows = await ctx.db.query("legacyMirror").collect();

    // doc -> collection -> rows, preserving insertion order within a slice.
    const grouped: Record<string, Record<string, Array<{ key?: string; payload: unknown }>>> = {};
    for (const r of rows) {
      const doc = (grouped[r.doc] ??= {});
      (doc[r.collection] ??= []).push({ key: r.key, payload: r.payload });
    }

    const out: Record<string, Record<string, unknown>> = {};
    for (const [docName, collections] of Object.entries(grouped)) {
      const rebuilt: Record<string, unknown> = {};
      for (const [collection, slice] of Object.entries(collections)) {
        // A keyed slice was a map (histories keyed by student id); an unkeyed
        // slice was a list (auditLog, tombstones). Mixed cannot happen: the
        // writer decides per slice, not per row. If it ever did, treating it
        // as a map loses the unkeyed rows silently, so the list wins and the
        // keys are preserved as a fallback field nobody reads.
        const keyed = slice.some((r) => typeof r.key === "string");
        if (keyed) {
          const map: Record<string, unknown> = {};
          for (const r of slice) {
            if (typeof r.key === "string") map[r.key] = r.payload;
          }
          rebuilt[collection] = map;
        } else {
          rebuilt[collection] = slice.map((r) => r.payload);
        }
      }
      out[docName] = rebuilt;
    }

    return out;
  },
});

/**
 * One document, for the read-modify-write paths.
 *
 * The ticket and audit correction screens rewrite a single entry inside a
 * single document. Handing them the whole mirror to do it would pull every
 * ticket in the school across the wire so one row can change, on a screen an
 * admin uses several times a day.
 *
 * Returns null rather than {} when the document has no rows, because the
 * callers branch on existence: "this document is empty" and "this document is
 * not there" lead to different code, and collapsing them writes a fresh
 * document over a missing one without anybody deciding to.
 */
export const loadDoc = query({
  args: { doc: v.string() },
  handler: async (ctx, { doc }) => {
    await requireStaff(ctx);

    const rows = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc", (q) => q.eq("doc", doc))
      .collect();
    if (rows.length === 0) return null;

    const collections: Record<string, Array<{ key?: string; payload: unknown }>> = {};
    for (const r of rows) (collections[r.collection] ??= []).push({ key: r.key, payload: r.payload });

    const out: Record<string, unknown> = {};
    for (const [collection, slice] of Object.entries(collections)) {
      const keyed = slice.some((r) => typeof r.key === "string");
      if (keyed) {
        const map: Record<string, unknown> = {};
        for (const r of slice) if (typeof r.key === "string") map[r.key] = r.payload;
        out[collection] = map;
      } else {
        out[collection] = slice.map((r) => r.payload);
      }
    }
    return out;
  },
});

/**
 * Replace one (doc, collection) slice.
 *
 * Replace, not append, for the same reason `mirror:putSlice` replaces: the app
 * saves whole arrays, and appending would double every entry on every save.
 * The caller sends the array (or map) it wants the slice to BE.
 *
 * `rows` is capped because these are the two documents that outgrew Firestore
 * in the first place. A save larger than this is a bug in the caller — the
 * whole audit log being re-sent as one slice, say — and failing loudly here is
 * better than writing a million rows and finding out on the bill.
 */
const MAX_ROWS_PER_SLICE = 20000;

export const saveSlice = mutation({
  args: {
    doc: v.string(),
    collection: v.string(),
    rows: v.array(v.object({ key: v.optional(v.string()), payload: v.any() })),
  },
  handler: async (ctx, { doc, collection, rows }) => {
    await requireStaff(ctx);

    if (rows.length > MAX_ROWS_PER_SLICE) {
      throw new Error(
        `legacyData:saveSlice refused ${rows.length} rows for ${doc}.${collection}; the cap is ${MAX_ROWS_PER_SLICE}.`,
      );
    }

    const old = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc_collection", (q) =>
        q.eq("doc", doc).eq("collection", collection),
      )
      .collect();
    for (const r of old) await ctx.db.delete(r._id);

    const mirroredAt = new Date().toISOString();
    for (const r of rows) {
      await ctx.db.insert("legacyMirror", {
        doc,
        collection,
        key: r.key,
        payload: r.payload,
        mirroredAt,
      });
    }

    return { doc, collection, wrote: rows.length, replaced: old.length };
  },
});
