import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Generic mirror writer. One row per source array element, payload verbatim.
 *
 * Replaces the whole (doc, collection) slice each run rather than appending,
 * so re-running is safe and cannot double-count. Re-running is expected: the
 * mirror is refreshed repeatedly while the app keeps writing to Firestore.
 */
export const putSlice = internalMutation({
  args: {
    doc: v.string(),
    collection: v.string(),
    mirroredAt: v.string(),
    rows: v.array(v.object({ key: v.optional(v.string()), payload: v.any() })),
    replace: v.optional(v.boolean()),
  },
  handler: async (ctx, { doc, collection, rows, mirroredAt, replace }) => {
    let deleted = 0;
    if (replace) {
      const old = await ctx.db
        .query("legacyMirror")
        .withIndex("by_doc_collection", (q) =>
          q.eq("doc", doc).eq("collection", collection),
        )
        .collect();
      for (const r of old) { await ctx.db.delete(r._id); deleted++; }
    }
    for (const r of rows) {
      await ctx.db.insert("legacyMirror", {
        doc, collection, key: r.key, payload: r.payload, mirroredAt,
      });
    }
    return { doc, collection, inserted: rows.length, deleted };
  },
});

/** App settings from raffle_data/main. Upserted by key. */
export const putAppState = internalMutation({
  args: {
    mirroredAt: v.string(),
    entries: v.array(v.object({ key: v.string(), value: v.any() })),
  },
  handler: async (ctx, { entries, mirroredAt }) => {
    const existing = await ctx.db.query("appState").collect();
    const byKey = new Map(existing.map((e) => [e.key, e]));
    let created = 0, updated = 0;
    for (const e of entries) {
      const prior = byKey.get(e.key);
      if (prior) { await ctx.db.patch(prior._id, { value: e.value, mirroredAt }); updated++; }
      else { await ctx.db.insert("appState", { key: e.key, value: e.value, mirroredAt }); created++; }
    }
    return { created, updated };
  },
});

/** Row counts per slice, for reconciliation against the source. */
export const counts = internalMutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("legacyMirror").collect();
    const out: Record<string, number> = {};
    for (const r of all) out[`${r.doc}.${r.collection}`] = (out[`${r.doc}.${r.collection}`] ?? 0) + 1;
    const state = await ctx.db.query("appState").collect();
    return { slices: out, totalRows: all.length, appStateKeys: state.length };
  },
});
