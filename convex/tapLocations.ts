import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireStaff, requireAdmin } from "./identity";

/**
 * Managing the NFC tags on walls.
 *
 * A tag holds a URL ending in a slug. The slug is PRINTED ON THE TAG and
 * encoded into it, so it is chosen by a person and never generated: changing it
 * means peeling a sticker off a wall and re-encoding it.
 *
 * Tags are RETIRED, never deleted. Every tapEvent refers to a slug, and deleting
 * a location orphans a term of records. `active: false` stops it working and
 * keeps its history readable.
 */

/** Normalized the same way everywhere, so a tag typed in caps still matches. */
function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    const rows = await ctx.db.query("tapLocations").collect();
    const events = await ctx.db.query("tapEvents").take(2000);

    // Last seen per slug, so a tag that stopped working is visible as a tag
    // nobody has tapped since Tuesday rather than as a row that looks fine.
    const lastSeen = new Map<string, string>();
    for (const e of events) {
      const prior = lastSeen.get(e.locationSlug);
      if (!prior || e.at > prior) lastSeen.set(e.locationSlug, e.at);
    }

    return {
      locations: rows
        .map((r) => ({
          id: r._id,
          slug: r.slug,
          name: r.name,
          kind: r.kind,
          active: r.active,
          createdAt: r.createdAt,
          lastTapAt: lastSeen.get(r.slug) ?? null,
          url: `https://wildcatraffle.com/?tap=${r.slug}`,
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    };
  },
});

/**
 * Create or update a tag. Admin only: a tag is an access point into the record,
 * and a teacher inventing one would create places students can check in to that
 * nobody agreed on.
 */
export const upsert = mutation({
  args: {
    slug: v.string(),
    name: v.string(),
    kind: v.union(
      v.literal("classroom"),
      v.literal("restroom"),
      v.literal("office"),
      v.literal("nurse"),
      v.literal("other"),
    ),
  },
  handler: async (ctx, { slug, name, kind }) => {
    await requireAdmin(ctx);
    const clean = normalizeSlug(slug);
    if (!clean) throw new ConvexError("A tag needs a slug, for example restroom-2.");
    if (!name.trim()) throw new ConvexError("A tag needs a name people will recognise.");

    const existing = await ctx.db
      .query("tapLocations")
      .withIndex("by_slug", (q) => q.eq("slug", clean))
      .unique();

    if (existing) {
      // Re-registering a retired tag reactivates it, which is what somebody
      // means when they scan a sticker they just put back on a wall.
      await ctx.db.patch(existing._id, { name: name.trim(), kind, active: true });
      return { outcome: existing.active ? "updated" : "reactivated", slug: clean };
    }

    await ctx.db.insert("tapLocations", {
      slug: clean,
      name: name.trim(),
      kind,
      active: true,
      createdAt: new Date().toISOString(),
    });
    return { outcome: "created", slug: clean };
  },
});

export const retire = mutation({
  args: { id: v.id("tapLocations") },
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(id);
    if (!row) throw new ConvexError("No such tag.");
    // Never delete. tapEvents refer to this slug and deleting it orphans them.
    await ctx.db.patch(id, { active: false });
    return { retired: row.slug };
  },
});

/**
 * What a scanned slug is, before anybody commits to it.
 *
 * Used by the admin screen when a tag is tapped: an unknown slug is an
 * opportunity to register it, and a known one should say so rather than
 * silently creating a duplicate.
 */
export const lookup = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    await requireStaff(ctx);
    const clean = normalizeSlug(slug);
    const row = await ctx.db
      .query("tapLocations")
      .withIndex("by_slug", (q) => q.eq("slug", clean))
      .unique();
    return {
      slug: clean,
      known: Boolean(row),
      active: row?.active ?? false,
      name: row?.name ?? null,
      kind: row?.kind ?? null,
    };
  },
});
