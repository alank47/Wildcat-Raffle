import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireStaff, requireAdmin, requireStudentSelf } from "./identity";
import { applyTap, canApprove, elapsedMinutes, isOverdue, hasLivePass } from "./hallPassRules";

/**
 * Hall passes, backed by NFC tags on walls.
 *
 * The rules live in hallPassRules.ts and are unit tested without a database.
 * This file does the parts that need one: who is asking, which pass is theirs,
 * and writing the record down.
 *
 * WHAT A TAP CAN AND CANNOT PROVE. A tag holds a static URL, so a tap proves
 * somebody opened that URL, not that a body was in that room. It can be
 * photographed and replayed. The mitigations are all in software and all
 * partial: a tap only counts against an approved pass, the destination must be
 * tapped before the origin, and every tap is attributed and visible to a
 * teacher. Real proof needs rotating tags, which is hardware nobody has bought.
 * This is written down so nobody later mistakes the record for certainty.
 */

const DEFAULT_MINUTES = 10;

/** A student's own live pass, plus the running timer. */
export const myPass = query({
  args: { studentId: v.id("students") },
  handler: async (ctx, { studentId }) => {
    // Staff-gated for now. When student sign-in works this becomes "the caller's
    // own record" and the argument disappears, because an endpoint that takes a
    // student id and trusts it is an endpoint that reads any child's record.
    await requireStaff(ctx);

    const passes = await ctx.db
      .query("hallPasses")
      .withIndex("by_student", (q) => q.eq("studentId", studentId))
      .collect();

    const live = passes.find((p) => !["returned", "denied", "cancelled", "expired"].includes(p.state));
    if (!live) return { pass: null };

    const now = new Date().toISOString();
    return {
      pass: {
        ...live,
        elapsedMinutes: elapsedMinutes(live as any, now),
        overdue: isOverdue(live as any, now),
      },
    };
  },
});

export const request = mutation({
  args: {
    studentId: v.id("students"),
    originSlug: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { studentId, originSlug, reason }) => {
    await requireStaff(ctx);

    const existing = await ctx.db
      .query("hallPasses")
      .withIndex("by_student", (q) => q.eq("studentId", studentId))
      .collect();

    // One live pass at a time. Two open timers cannot be reconciled from the
    // taps afterwards, so the record would be unreadable exactly when it matters.
    if (hasLivePass(existing as any)) {
      throw new ConvexError("This student already has a pass open.");
    }

    const origin = await ctx.db
      .query("tapLocations")
      .withIndex("by_slug", (q) => q.eq("slug", originSlug))
      .unique();
    if (!origin || !origin.active) {
      throw new ConvexError(`No active location with the tag "${originSlug}".`);
    }

    const student = await ctx.db.get(studentId);
    const id = await ctx.db.insert("hallPasses", {
      studentId,
      studentNumber: student?.studentNumber,
      originLocationId: origin._id,
      state: "requested",
      reason,
      requestedAt: new Date().toISOString(),
      expiresAfterMinutes: DEFAULT_MINUTES,
    });
    return { id, state: "requested" };
  },
});

export const approve = mutation({
  args: { passId: v.id("hallPasses"), minutes: v.optional(v.number()) },
  handler: async (ctx, { passId, minutes }) => {
    const teacher = await requireStaff(ctx);
    const pass = await ctx.db.get(passId);
    if (!pass) throw new ConvexError("No such pass.");

    const verdict = canApprove(pass as any);
    if (!verdict.ok) throw new ConvexError(verdict.reason);

    // The timer starts at APPROVAL, not at the first tap. A student who is
    // approved and never leaves is still out of class as far as the record goes.
    await ctx.db.patch(passId, {
      state: "active",
      approvedAt: new Date().toISOString(),
      approvedByEmail: teacher.email,
      ...(minutes ? { expiresAfterMinutes: minutes } : {}),
    });
    return { state: "active" };
  },
});

export const deny = mutation({
  args: { passId: v.id("hallPasses") },
  handler: async (ctx, { passId }) => {
    await requireStaff(ctx);
    const pass = await ctx.db.get(passId);
    if (!pass) throw new ConvexError("No such pass.");
    if (pass.state !== "requested") throw new ConvexError(`Already ${pass.state}.`);
    await ctx.db.patch(passId, { state: "denied" });
    return { state: "denied" };
  },
});

/**
 * A tap at a wall tag.
 *
 * EVERY tap is recorded, accepted or not. A refused tap is the interesting one:
 * a student tapping the classroom tag on the way out, or tapping with no
 * approved pass, is precisely what a teacher wants to see. Recording only the
 * successful ones would erase the behaviour the system exists to notice.
 */
/**
 * A tap at a wall tag, BY THE STUDENT WHO TAPPED IT.
 *
 * No studentId argument. The student is whoever the verified Google token says
 * they are. The earlier version took an id and required staff, which is the
 * shape of a kiosk, not of a child holding a phone at a restroom door: it would
 * have let anyone with a staff session close anyone's pass.
 *
 * EVERY TAP IS RECORDED, accepted or not. A refused tap is the interesting one:
 * a student tapping the classroom tag on the way out, or tapping with no
 * approved pass, is precisely what a teacher wants to see. Storing only
 * successes would erase the behaviour this exists to notice.
 *
 * A tap proves somebody opened a URL, not that a body was in a room. See
 * docs/nfc-tap-map.md.
 */
export const tap = mutation({
  args: { locationSlug: v.string() },
  handler: async (ctx, { locationSlug }) => {
    const student = await requireStudentSelf(ctx);
    const now = new Date().toISOString();
    const slug = locationSlug.trim().toLowerCase();

    const location = await ctx.db
      .query("tapLocations")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();

    if (!location || !location.active) {
      await ctx.db.insert("tapEvents", {
        studentId: student._id,
        locationSlug: slug,
        at: now,
        accepted: false,
        outcome: location ? "Retired tag." : "Unknown tag.",
      });
      return { ok: false, reason: "This tag is not set up yet. Tell your teacher.", location: null };
    }

    const passes = await ctx.db
      .query("hallPasses")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .collect();
    const live = passes.find(
      (p) => !["returned", "denied", "cancelled", "expired"].includes(p.state),
    );

    if (!live) {
      await ctx.db.insert("tapEvents", {
        studentId: student._id,
        locationSlug: slug,
        at: now,
        accepted: false,
        outcome: "No open pass.",
      });
      return {
        ok: false,
        reason: "You do not have a pass open. Ask your teacher first.",
        location: location.name,
      };
    }

    const result = applyTap(live as any, location._id, now);

    await ctx.db.insert("tapEvents", {
      passId: live._id,
      studentId: student._id,
      locationSlug: slug,
      at: now,
      accepted: result.ok,
      outcome: result.reason,
    });

    if (!result.ok) return { ok: false, reason: result.reason, location: location.name };

    await ctx.db.patch(live._id, {
      state: result.nextState,
      [result.field]: now,
      ...(result.field === "outAt" ? { destinationLocationId: location._id } : {}),
    } as any);

    return { ok: true, state: result.nextState, reason: result.reason, location: location.name };
  },
});

/** Everything currently out, for a teacher's screen. Overdue first. */
export const liveBoard = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    const now = new Date().toISOString();
    const all = await ctx.db.query("hallPasses").collect();
    const live = all.filter((p) => ["requested", "active", "out"].includes(p.state));

    const rows = await Promise.all(
      live.map(async (p) => {
        const student = await ctx.db.get(p.studentId);
        return {
          id: p._id,
          state: p.state,
          studentName: student ? `${student.firstName} ${student.lastName}`.trim() : "(unknown)",
          studentNumber: p.studentNumber,
          elapsedMinutes: elapsedMinutes(p as any, now),
          overdue: isOverdue(p as any, now),
          requestedAt: p.requestedAt,
        };
      }),
    );

    // Overdue first, then longest out. A teacher scanning this wants the
    // exception at the top, not alphabetical order.
    rows.sort((a, b) =>
      Number(b.overdue) - Number(a.overdue) || (b.elapsedMinutes ?? -1) - (a.elapsedMinutes ?? -1),
    );
    return { passes: rows, generatedAt: now };
  },
});
