import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireStaff, requireAdmin, requireStudentSelf } from "./identity";
import { normalizeSlug } from "./tapSlug";

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

// normalizeSlug now lives in tapSlug.ts and is imported above. It was private
// here, so the read side (hallPasses.tap, hallPasses.requestMine) had its own
// weaker version and the two disagreed: a tag registered as `Restroom_2` was
// stored `restroom-2` and could never be matched by a tap of `restroom_2`. A
// write-side and a read-side normalizer for the same key have to be one
// function, or they are a silent lookup miss with a healthy-looking admin screen
// on top of it.

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    const rows = await ctx.db.query("tapLocations").collect();

    // lastTapAt COMES OFF THE ROW NOW. It used to be derived by scanning a
    // window of tapEvents, and that window was both a correctness bug and an
    // exploit. Without .order("desc") it held the OLDEST 2,000 events, so past
    // 2,000 rows every tag reported "never tapped" forever. Adding .order("desc")
    // fixed the ordering and left the flood: any student could write 2,000 events
    // at one slug and push every other tag out of the window, producing exactly
    // the same wrong screen on purpose. A column on the location row cannot be
    // crowded out by another row's traffic, so the whole class of failure goes
    // away rather than being re-bounded. hallPasses.recordTapEvent stamps it.
    return {
      locations: rows
        .map((r) => ({
          id: r._id,
          slug: r.slug,
          name: r.name,
          kind: r.kind,
          active: r.active,
          createdAt: r.createdAt,
          lastTapAt: r.lastTapAt ?? null,
          url: `https://wildcatraffle.com/?tap=${r.slug}`,
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    };
  },
});

/**
 * A hard ceiling on the student picker. One row per physical NFC tag, so a real
 * school is in the tens; 500 is far above that and still bounded. Reaching it
 * means somebody is generating tags, which is worth noticing rather than
 * serving.
 */
const STUDENT_PICKER_LIMIT = 500;

/**
 * Kinds every student may be shown, regardless of their schedule.
 *
 * These are the places anybody is entitled to need: a restroom, the office, the
 * nurse. Naming them is not a disclosure, because a student who needs the nurse
 * already knows where the nurse is. `classroom` and `other` are deliberately NOT
 * here: the full classroom list is a map of the building, and that is what turns
 * guessing a slug into reading one off a list.
 */
const COMMON_DESTINATION_KINDS = ["restroom", "office", "nurse"] as const;

/** How many of the caller's own recent passes are consulted for their rooms. */
const OWN_ORIGIN_LOOKBACK = 40;

/**
 * The rooms a student may name as the one they are leaving.
 *
 * A SEPARATE, NARROWER FUNCTION rather than a loosened `list`. `list` is for the
 * admin tag screen: it returns creation dates, last-tap times and the encoded
 * URL, which together are a map of which corridors are watched and which tag
 * nobody has touched since Tuesday. That is a description of the building's
 * surveillance coverage and it does not belong in a student's browser.
 *
 * NARROWED TO THIS STUDENT. It used to return every active tag in the school,
 * which handed anybody a complete slug list. Now it returns the common
 * destinations above, plus only the rooms this caller has themselves used as an
 * origin before, which is their own history and tells them nothing new.
 *
 * WHAT IS MISSING AND WHY, stated rather than quietly dropped: the intended
 * scoping was "the rooms on this student's own timetable", and IT CANNOT BE
 * BUILT FROM THE DATA THAT EXISTS. psRoster has sectionId, sectionNumber,
 * sectionExpression, period, course and teacher, and NO room or location column
 * at all, so there is nothing to join a tag to. PowerSchool's Sections.Room
 * would supply it and is not in the manifest, exactly like the lunch id in
 * passCard.ts. Until that field is approved this returns the honest subset and
 * says so in `classroomsFromSchedule`, rather than guessing a join or shipping
 * the whole building.
 *
 * NAME, SLUG AND KIND ONLY, built field by field. No id, no createdAt, no
 * lastTapAt, no URL. Retired tags are absent, because a picker offering a room
 * that will refuse the request is a bug report waiting to happen.
 */
export const listForStudents = query({
  args: {},
  handler: async (ctx) => {
    const student = await requireStudentSelf(ctx);

    const rows = await ctx.db
      .query("tapLocations")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(STUDENT_PICKER_LIMIT);

    // The caller's own recent origins. Indexed and bounded, and it is their own
    // data: every one of these is a room they have already been let out of.
    const passes = await ctx.db
      .query("hallPasses")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .order("desc")
      .take(OWN_ORIGIN_LOOKBACK);
    const ownOrigins = new Set(passes.map((p) => p.originLocationId));

    const visible = rows.filter(
      (r) =>
        (COMMON_DESTINATION_KINDS as readonly string[]).includes(r.kind) ||
        ownOrigins.has(r._id),
    );

    return {
      locations: visible
        .map((r) => ({ slug: r.slug, name: r.name, kind: r.kind }))
        .sort((a, b) => a.name.localeCompare(b.name)),

      // Absent, with the reason, in the shape passCard.mine uses for the lunch
      // id and the Clever badge. A student whose classroom is not offered can
      // still have a teacher open the pass through the staff path, and this is
      // what tells the office why.
      classroomsFromSchedule: {
        available: false,
        reason:
          "Classrooms are not listed from your timetable yet. The PowerSchool " +
          "roster does not include a room for each section, so there is nothing " +
          "to match a tag against. Ask your teacher to start the pass if the room " +
          "you are in is not here.",
      },

      // Told rather than silently truncated. A picker that quietly stops at 500
      // looks complete and is missing the room the student is standing in.
      truncated: rows.length === STUDENT_PICKER_LIMIT,
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
