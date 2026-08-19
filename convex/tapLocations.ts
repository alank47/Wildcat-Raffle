import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireStaff, requireAdmin, requireStudentSelf, normalizeEmail } from "./identity";
import { normalizeSlug } from "./tapSlug";
import { roomsNamedOnPasses } from "./hallPassRules";

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
          // Which classroom this is, when it is one. Null, never "", so the
          // screen can tell "not assigned" from "assigned to an empty string",
          // which is what an unchecked form field writes.
          teacherEmail: r.teacherEmail ?? null,
          sectionId: r.sectionId ?? null,
          // /tap/, not the apex. Android intent filters cannot match a query
          // string, so the tag URL carries the distinction in its PATH; the
          // association file lists "/": "/tap/*" and Apple requires every listed
          // component to match. This string is what the admin copies onto a
          // sticker, so it has to be the shape the app will actually claim.
          // Mirrors wcTapUrl() in script.js. See Grilled.md decision 24.
          url: `https://wildcatraffle.com/tap/?tap=${r.slug}`,
          // Absent means nobody knows: either it predates this column, or the
          // card was never successfully programmed. The screen says so rather
          // than implying a sticker exists on a wall somewhere.
          writtenAt: r.writtenAt ?? null,
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    };
  },
});

/**
 * The staff a tag can be assigned to, and the sections they teach.
 *
 * Exists so the tag screen is a PICKER rather than a box to type an address
 * into. teacherEmail is a join key: one typo and the tag belongs to nobody, the
 * lookup silently returns nothing, and a student is told their classroom has no
 * tag while looking straight at one. A list of real addresses cannot be
 * mistyped.
 *
 * Staff only, and it is the staff directory this app already shows on the
 * teachers screen, so it discloses nothing new.
 */
export const assignableClassrooms = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);

    const teachers = await ctx.db.query("teachers").take(600);

    // One row per section, from the roster, so a tag can be tied to an exact
    // section when a teacher has more than one room. Bounded: this is a picker,
    // not a report.
    const rosterRows = await ctx.db.query("psRoster").take(4000);
    const sections = new Map<
      string,
      { sectionId: string; courseName: string | null; period: string | null; teacherEmail: string | null }
    >();
    for (const r of rosterRows) {
      const id = String(r.sectionId ?? "").trim();
      if (!id || sections.has(id)) continue;
      sections.set(id, {
        sectionId: id,
        courseName: r.courseName ?? null,
        period: r.period ?? r.sectionExpression ?? null,
        teacherEmail: r.teacherEmail ?? null,
      });
    }

    return {
      teachers: teachers
        .map((t) => ({ email: t.email, name: t.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      sections: [...sections.values()].sort((a, b) =>
        String(a.courseName ?? "").localeCompare(String(b.courseName ?? "")),
      ),
      // Told rather than silently short, for the same reason every other capped
      // read in this codebase says so.
      truncated: rosterRows.length === 4000,
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
const OWN_ROOM_LOOKBACK = 40;

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
 * destinations above, plus only the rooms this caller's own passes name: the
 * room they were let out of, the room a teacher sent them to, and the room they
 * already tapped. That is their own history and tells them nothing new.
 *
 * ALL THREE, not just the origin. Origins alone made the teacher-issued pass
 * unusable end to end, because the tag a teacher sends a child to is very often
 * an `other` kind that is neither common nor anybody's origin: the student was
 * told the library tag was not registered while standing in front of it. See
 * roomsNamedOnPasses in hallPassRules.ts.
 *
 * NO LONGER THE ORIGIN PICKER. A student used to choose the room they were
 * leaving from this list, and that was the wrong model: the record said where a
 * fourteen year old typed rather than where they were. The origin is now derived
 * from their timetable by hallPasses.resolveScheduledOrigin, and this list is
 * only ever the places a student may be told about.
 *
 * PowerSchool still supplies no room per section. What closed the gap is not new
 * SIS data but a column an admin fills in: tapLocations.sectionId and
 * .teacherEmail tie a wall tag to a classroom, entered on the tag screen exactly
 * as the slug is. `classroomsFromSchedule` says so rather than leaving a caller
 * to infer it.
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

    // The caller's own recent rooms. Indexed and bounded, and it is their own
    // data: every one of these is a room they have been let out of, sent to, or
    // already tapped.
    const passes = await ctx.db
      .query("hallPasses")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .order("desc")
      .take(OWN_ROOM_LOOKBACK);

    // ORIGINS ALONE WAS A DEAD LOOP. This used to be
    // `new Set(passes.map((p) => p.originLocationId))`, so the only rooms a
    // student could see beyond restrooms, the office and the nurse were rooms
    // they had already left from. A teacher's pass names a DESTINATION, and the
    // staff picker offers every active non-classroom tag, `other` included. So a
    // child sent to the library was shown "this tag is not set up yet" at the
    // library tag, the pass never left `active`, and the trip could not be
    // started or finished. roomsNamedOnPasses reads all three columns; see the
    // note on it in hallPassRules.ts.
    const ownRooms = roomsNamedOnPasses(passes);

    const visible = rows.filter(
      (r) =>
        (COMMON_DESTINATION_KINDS as readonly string[]).includes(r.kind) ||
        ownRooms.has(r._id),
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
          "You do not pick the room you are leaving any more. A pass now starts from " +
          "the class you are timetabled into at that moment, and goes to that teacher. " +
          "If the app cannot work out which class that is, it says so and a teacher " +
          "can start the pass instead.",
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
    // WHOSE CLASSROOM THIS IS. Both optional, and both are how a return tap
    // finds its way home now that a pass originates from a section rather than
    // from a room somebody picked.
    //
    // OPTIONAL IS LOAD BEARING, not laziness. A restroom tag, an office tag and
    // every tag registered before this existed have neither, and must go on
    // working exactly as they did: they are destinations, not classrooms, and a
    // required field here would have meant answering "which teacher owns the
    // second floor restroom".
    //
    // An EMPTY STRING is stored as absent, never as "". teacherEmail is an index
    // key, and eq("teacherEmail", "") is a real bucket lookup that would return
    // every tag anybody left blank, which is how one teacher's classroom becomes
    // several and pickClassroomTag starts refusing them all.
    teacherEmail: v.optional(v.string()),
    sectionId: v.optional(v.string()),
    // Did a physical card actually get programmed in this same press?
    // Only ever set true by the writer when the hardware confirmed it. Absent
    // on every older client, which is why the column is optional.
    written: v.optional(v.boolean()),
  },
  handler: async (ctx, { slug, name, kind, teacherEmail, sectionId, written }) => {
    await requireAdmin(ctx);
    const clean = normalizeSlug(slug);
    if (!clean) throw new ConvexError("A tag needs a slug, for example restroom-2.");
    if (!name.trim()) throw new ConvexError("A tag needs a name people will recognise.");

    // Normalized on the way in, like every other address in this schema. Entra
    // and PowerSchool both hand back directory casing and an index lookup is
    // byte-exact, so a tag stored as `A.Vega@school.org` joins to nothing and
    // says nothing about why.
    const owner = normalizeEmail(teacherEmail) || undefined;
    const section = String(sectionId ?? "").trim() || undefined;

    // A tag pointed at a teacher who is not in this app can never be resolved,
    // and the failure is silent: the student is told their classroom has no tag
    // while standing in front of one. Checked here, once, rather than discovered
    // at a doorway.
    if (owner) {
      const teacher = await ctx.db
        .query("teachers")
        .withIndex("by_email", (q) => q.eq("email", owner))
        .first();
      if (!teacher) {
        throw new ConvexError(
          `No staff record has the address ${owner}, so a pass could never be routed ` +
            `to this room. Pick a teacher from the list.`,
        );
      }
    }

    const existing = await ctx.db
      .query("tapLocations")
      .withIndex("by_slug", (q) => q.eq("slug", clean))
      .unique();

    if (existing) {
      // Re-registering a retired tag reactivates it, which is what somebody
      // means when they scan a sticker they just put back on a wall.
      //
      // The assignment is written EVERY TIME, including when it is being
      // cleared. `...(owner ? {owner} : {})` would make unassigning a tag
      // impossible: the field would stick to whatever it was last set to and an
      // admin correcting a mistake would watch nothing happen.
      await ctx.db.patch(existing._id, {
        name: name.trim(),
        kind,
        active: true,
        teacherEmail: owner,
        sectionId: section,
        // Only ever set forward, never cleared. A successful write is a fact
        // about a physical object that stays true; a later failed attempt to
        // rewrite the same sticker does not un-write the one already on the
        // wall, and blanking this would send somebody to re-do a tag that was
        // fine.
        ...(written ? { writtenAt: new Date().toISOString() } : {}),
      });
      return { outcome: existing.active ? "updated" : "reactivated", slug: clean };
    }

    await ctx.db.insert("tapLocations", {
      slug: clean,
      name: name.trim(),
      kind,
      active: true,
      createdAt: new Date().toISOString(),
      ...(owner ? { teacherEmail: owner } : {}),
      ...(section ? { sectionId: section } : {}),
      ...(written ? { writtenAt: new Date().toISOString() } : {}),
    });
    return { outcome: "created", slug: clean };
  },
});

/**
 * Delete a tag outright, for the ones that should never have existed.
 *
 * WHY THIS IS NOT SIMPLY `ctx.db.delete`. The comment on retire below is right:
 * tapEvents carry a locationSlug and nothing else, so deleting a slug that has
 * been tapped orphans every event that named it, and the hall-pass history
 * quietly starts referring to a place that cannot be looked up. That history is
 * the record of where children were, which is the last thing in this system that
 * should develop holes.
 *
 * So the two cases are separated rather than merged:
 *
 *   never tapped  ->  delete it. It is a typo, a test, a duplicate. Nothing
 *                     refers to it and nothing ever will.
 *   ever tapped   ->  refuse, and say to retire instead. Retiring stops the tag
 *                     working while leaving the history intact.
 *
 * The check is O(1) rather than a scan of tapEvents, which has no index on
 * locationSlug: `lastTapAt` is already denormalized onto this row for exactly
 * the question "has anybody ever tapped this".
 */
export const remove = mutation({
  args: { id: v.id("tapLocations") },
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(id);
    if (!row) throw new ConvexError("No such tag.");
    if (row.lastTapAt) {
      throw new ConvexError(
        `"${row.name}" has been tapped before, so deleting it would orphan the ` +
          `hall-pass history that names it. Retire it instead: it stops working ` +
          `immediately and the record stays readable.`,
      );
    }
    await ctx.db.delete(id);
    return { deleted: row.slug };
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
      teacherEmail: row?.teacherEmail ?? null,
      sectionId: row?.sectionId ?? null,
    };
  },
});
