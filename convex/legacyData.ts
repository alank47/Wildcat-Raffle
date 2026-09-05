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

/**
 * WHERE `load` WENT.
 *
 * There was a `load` query here that rebuilt EVERY mirrored document in one
 * call, with `.collect()` over the whole legacyMirror table. It exceeded
 * Convex's read limit in production on or before 2026-09-04:
 *
 *   Uncaught Error: Too many bytes read in a single function execution
 *   (limit: 16777216 bytes)
 *
 * That table is every student's ticket history and every week of the audit
 * log, so it only grows and the query was never coming back. While it failed,
 * every load in the app fell through to its localStorage copy without
 * surfacing anything, because the fallback is not an error path -- a machine
 * that had never run the app showed no schedules, no referrals, no cash and no
 * audit log for the whole session, silently.
 *
 * `loadDoc` below is the replacement, called once per document by
 * loadLegacyDocsFromConvex in script.js. It reads through the by_doc index, so
 * an execution is bounded by ONE document rather than by the whole school's
 * history, and no chunk size has to be tuned against a table that grows every
 * week. Do not reintroduce a whole-table read here.
 */

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

/**
 * Union an incoming slice into the stored one, inside a single transaction.
 *
 * WHAT THIS REPLACES, AND WHY IT IS NOT `saveSlice`. Four Firestore
 * `runTransaction` blocks did read-modify-write on referrals, ticket history,
 * the audit months and `secondary`. Firestore retried them on conflict, and
 * that retry is the only reason two teachers saving at the same moment did not
 * erase each other. Rewriting them as a client-side read followed by
 * `saveSlice` would look identical and quietly drop that guarantee: the tab
 * merges against what it fetched, so a write that lands in between is gone.
 *
 * A Convex mutation IS the transaction, so doing the merge in here restores
 * the property rather than approximating it. The handler reads the row it is
 * about to replace.
 *
 * UNION, NEVER REPLACE. Entries are deduped on `dedupeField` (entryId for
 * history and audit, id for referrals) and the STORED copy wins a collision,
 * because the incoming one comes from a tab that may have been open for hours.
 * An entry present on the server and absent locally is not a deletion — that is
 * what tombstones are for, and treating absence as intent is exactly how a
 * stale tab deletes another teacher's work.
 */
export const mergeSlice = mutation({
  args: {
    doc: v.string(),
    collection: v.string(),
    rows: v.array(v.object({ key: v.optional(v.string()), payload: v.any() })),
    dedupeField: v.string(),
  },
  handler: async (ctx, { doc, collection, rows, dedupeField }) => {
    await requireStaff(ctx);

    if (rows.length > MAX_ROWS_PER_SLICE) {
      throw new Error(
        `legacyData:mergeSlice refused ${rows.length} rows for ${doc}.${collection}; the cap is ${MAX_ROWS_PER_SLICE}.`,
      );
    }

    const existing = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc_collection", (q) =>
        q.eq("doc", doc).eq("collection", collection),
      )
      .collect();

    const idOf = (p: unknown) =>
      p && typeof p === "object" ? (p as Record<string, unknown>)[dedupeField] : undefined;

    // Keyed slices (histories, keyed by student) merge WITHIN a key; unkeyed
    // slices merge across the whole list. Mixing the two loses rows silently.
    const keyed = existing.some((r) => typeof r.key === "string")
      || rows.some((r) => typeof r.key === "string");

    const seen = new Set<string>();
    const keep: Array<{ key?: string; payload: unknown }> = [];
    const push = (r: { key?: string; payload: unknown }) => {
      const id = idOf(r.payload);
      // A row with no dedupe value cannot be compared, so it is kept rather
      // than dropped. Losing an entry because it lacks an id is worse than
      // keeping a duplicate an admin can see and remove.
      const token = id === undefined || id === null
        ? `__nokey__${keep.length}`
        : `${keyed ? r.key ?? "" : ""} ${String(id)}`;
      if (seen.has(token)) return;
      seen.add(token);
      keep.push({ key: r.key, payload: r.payload });
    };

    for (const r of existing) push({ key: r.key, payload: r.payload }); // stored wins
    for (const r of rows) push(r);

    for (const r of existing) await ctx.db.delete(r._id);
    const mirroredAt = new Date().toISOString();
    for (const r of keep) {
      await ctx.db.insert("legacyMirror", {
        doc,
        collection,
        key: r.key,
        payload: r.payload,
        mirroredAt,
      });
    }

    return { doc, collection, stored: keep.length, incoming: rows.length };
  },
});

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
