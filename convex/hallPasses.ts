import {
  query,
  mutation,
  internalMutation,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { requireStaff, requireAdmin, requireStudentSelf } from "./identity";
import { bellContext } from "./bellSchedules";
import { sisEmailKey } from "./studentPortalRules";
import {
  pickClassroomTag,
  resolveCurrentSection,
  teacherLabel,
} from "./scheduleRules";
import {
  applyTap,
  canApprove,
  canCancel,
  canForceClose,
  canRedeemTapIntent,
  canRequest,
  elapsedMinutes,
  isDuplicateTapEvent,
  isOverdue,
  isTerminal,
  hasLivePass,
  shouldExpire,
  sortLiveBoard,
  trimReason,
  validatePassMinutes,
  withinTapRateLimit,
  DEFAULT_REACH_MINUTES,
  TAP_INTENT_TTL_SECONDS,
  MAX_TAP_INTENTS_PER_WINDOW,
  canNotePass,
  summarizeNotes,
  type NoteLevel,
  passClock,
  passLimitFor,
  passesTakenOnDay,
} from "./hallPassRules";
import { normalizeSlug } from "./tapSlug";

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

/**
 * The schoolId marker seedTestRoster.ts stamps on every test roster row. A
 * student whose ENTIRE timetable carries it is a test account, and
 * resolveScheduledOrigin lets that account request a pass at any time, bypassing
 * the "no bell period right now" cutoff so the request flow can be exercised
 * off-hours. Kept in sync with seedTestRoster.ts by hand; those are the only two
 * readers, and clearing the seed removes every row that carries it.
 */
const TEST_ROSTER_MARKER = "TESTROSTER";

/**
 * How many of a student's most recent passes any handler reads.
 *
 * NOBODY NEEDS THE WHOLE HISTORY, and reading it is an outage on a timer. Every
 * one of these handlers used `.collect()` on `by_student`, which grows without
 * bound for as long as a child attends the school, and Convex allows 4,096
 * document reads per execution. psSync.ts:83-85 is this codebase's own record of
 * hitting that ceiling and of how it presents: not as an error anybody reads,
 * but as a screen that stops working.
 *
 * A window is sound for both questions asked of it. A live pass blocks every
 * later request, so at most one exists and it is always the newest row. The
 * daily cap only counts today, and the cap itself is 8, so 40 covers a week even
 * if every day were maxed out.
 *
 * `.order("desc")` is what makes it the NEWEST 40 rather than the oldest. Without
 * it the window would be the student's first 40 passes from two years ago and
 * every check against it would be wrong in the direction of permissive.
 */
const PASS_HISTORY_WINDOW = 40;

/**
 * Per state, on the teacher's live board. Three live states, so at most 3x this
 * many rows and one student lookup each, which keeps the whole execution an
 * order of magnitude under the 4,096 read ceiling. A school with 200 children
 * simultaneously out of one state has a bigger problem than pagination.
 */
const LIVE_BOARD_LIMIT_PER_STATE = 200;

/** The states a pass can be in and still matter to a teacher right now. */
const LIVE_STATES = ["requested", "active", "out"] as const;

/** How long a spent tap intent is kept before the sweep deletes it. */
const TAP_INTENT_RETENTION_DAYS = 7;

/**
 * How many of one student's roster rows are read to find the class they are in.
 *
 * BOUNDED, like every other read a signed-in child can cause in a loop. A real
 * timetable is six to eight rows and this is a whole year's worth even if every
 * term is carried; the alternative is `.collect()` on a table written by a sync
 * from a system nobody here controls, which is fine until the day it is not.
 */
const ROSTER_WINDOW = 60;

/** How many tags may claim one section or one teacher before it is a mistake. */
const CLASSROOM_TAG_WINDOW = 8;

/** Newest passes read for one teacher's own board. */
const CLASS_BOARD_WINDOW = 200;

export type OriginResult =
  | {
      ok: true;
      tag: Doc<"tapLocations">;
      sectionId: string | null;
      teacherEmail: string;
      teacherName: string;
      courseName: string | null;
      period: string;
      scheduleName: string | null;
    }
  | { ok: false; code: string; reason: string };

/**
 * WHERE THIS STUDENT IS SUPPOSED TO BE, RIGHT NOW, AND WHOSE ROOM IT IS.
 *
 * This is the whole model. A hall pass originates from the class a student is
 * scheduled into at the moment they ask, so the teacher who receives the request
 * is the teacher standing in front of them. The student never names a room, and
 * there is no argument here that could let them.
 *
 * THE CHAIN, and every link can break honestly:
 *
 *   the instant           -> the school's own wall clock   (bellSettings.timeZone)
 *   the wall clock + date -> today's bell schedule         (bellScheduleDays, or the usual one)
 *   the schedule + clock  -> a period                      (or lunch, or Saturday, or 15:40)
 *   the period + timetable-> one section                   (psRoster, via their own email)
 *   the section           -> a teacher and a classroom tag (tapLocations)
 *
 * NOTHING IS INVENTED WHEN A LINK BREAKS. Each step returns a refusal carrying
 * the sentence for that specific break, and the caller shows it and offers the
 * fallback, which is a teacher opening the pass instead. A pass attributed to
 * the wrong teacher is worse than a pass that asks, and every default anywhere
 * in this chain is a wrong attribution waiting for the first assembly.
 *
 * A PLAIN FUNCTION, not a query, because requestMine has to ask this inside a
 * mutation and myCurrentClass has to ask it in a query. Two copies would be two
 * answers, and the student would be shown one teacher and routed to another.
 */
export async function resolveScheduledOrigin(
  ctx: QueryCtx,
  student: Doc<"students">,
  nowIso: string,
): Promise<OriginResult> {
  const bells = await bellContext(ctx, nowIso);

  // The SAME join key the rest of the portal uses: the address the token
  // actually proves, never a number derived from the app's own record. See
  // views_app.myStudentView for what the other key did.
  //
  // Resolved BEFORE the bell period is judged, because whether a missing period
  // may be overridden depends on whose timetable this is.
  const email = sisEmailKey(student);
  if (!email.ok) {
    return { ok: false, code: "no-student-email", reason: email.reason };
  }

  const rows = await ctx.db
    .query("psRoster")
    .withIndex("by_studentEmail", (q) => q.eq("studentEmail", email.value))
    .take(ROSTER_WINDOW);

  if (rows.length === 0) {
    return {
      ok: false,
      code: "no-timetable",
      reason:
        "There is no class timetable on your account yet, so the app cannot tell whose " +
        "room you are in. Ask a teacher to start the pass for you.",
    };
  }

  // The period a request resolves against. Normally the live bell period.
  //
  // TEST-ACCOUNT BYPASS. A student whose WHOLE timetable is the TESTROSTER seed
  // exists to exercise the request flow, not to be governed by the wall clock.
  // For them, when there is no live bell period (after school, a weekend, an
  // untimed moment), fall back to the lowest seeded period so a request always
  // resolves to the test teacher. This fires ONLY when every roster row carries
  // the test marker, so a real student is never affected, and it disappears the
  // moment the seed is cleared (seedTestRoster:clearLawrencebTest).
  let period: string;
  if (bells.ok && bells.period) {
    period = bells.period.label;
  } else if (rows.every((r) => r.schoolId === TEST_ROSTER_MARKER)) {
    const testPeriods = rows
      .map((r) => String(r.period ?? "").trim())
      .filter(Boolean)
      .sort();
    period = testPeriods[0] || "1";
  } else {
    return { ok: false, code: bells.code, reason: bells.reason };
  }

  const section = resolveCurrentSection(rows, {
    period,
    cycleDay: bells.cycleDay,
    schoolCycleDays: bells.schoolCycleDays,
  });
  if (!section.ok) return { ok: false, code: section.code, reason: section.reason };

  const sectionId = String(section.section.sectionId ?? "").trim();

  // Two bounded indexed reads rather than a scan of every tag in the building.
  // Both are consulted because a tag may be tied to the exact section or, far
  // more usually, to the teacher who has one room.
  const bySection = sectionId
    ? await ctx.db
        .query("tapLocations")
        .withIndex("by_sectionId", (q) => q.eq("sectionId", sectionId))
        .take(CLASSROOM_TAG_WINDOW)
    : [];
  const byTeacher = await ctx.db
    .query("tapLocations")
    .withIndex("by_teacherEmail", (q) => q.eq("teacherEmail", section.teacherEmail))
    .take(CLASSROOM_TAG_WINDOW);

  const seen = new Set<string>();
  const candidates = [...bySection, ...byTeacher].filter((t) => {
    const key = String(t._id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const tag = pickClassroomTag(candidates, {
    sectionId: sectionId || null,
    teacherEmail: section.teacherEmail,
  });
  if (!tag.ok) return { ok: false, code: tag.code, reason: tag.reason };

  return {
    ok: true,
    tag: tag.tag as Doc<"tapLocations">,
    sectionId: sectionId || null,
    teacherEmail: section.teacherEmail,
    teacherName: teacherLabel(section.section),
    courseName: section.section.courseName ?? null,
    period: section.period,
    scheduleName: bells.scheduleName,
  };
}

/**
 * "Which class am I in, and who would this go to." For the signed-in student.
 *
 * NO ARGUMENTS, and there will never be any. The student is whoever the verified
 * Google token says they are, and every fact below is derived from that. An
 * argument naming a person here would be an endpoint for reading which room any
 * child in the school is sitting in right now, which is a worse disclosure than
 * their grades.
 *
 * The refusal is returned as data rather than thrown, because this is a screen
 * being rendered, not an action being refused: the card has to say "you are
 * between periods" and offer the way round it, and an exception would render as
 * a broken panel.
 */
export const myCurrentClass = query({
  args: {},
  handler: async (ctx) => {
    const student = await requireStudentSelf(ctx);
    const now = new Date().toISOString();
    const origin = await resolveScheduledOrigin(ctx, student, now);

    if (!origin.ok) {
      return {
        available: false,
        code: origin.code,
        reason: origin.reason,
        teacherName: null,
        courseName: null,
        period: null,
        room: null,
        serverTime: now,
      };
    }

    // An allowlist, field by field. Never the tag row: it carries the encode URL
    // and the last-tap time, which together describe which corridors are watched.
    return {
      available: true,
      code: "ok",
      reason: "",
      teacherName: origin.teacherName || null,
      courseName: origin.courseName,
      period: origin.period,
      room: origin.tag.name,
      serverTime: now,
    };
  },
});

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
      .order("desc")
      .take(PASS_HISTORY_WINDOW);

    // isTerminal, not a fourth copy of the same literal array. Three of these had
    // drifted apart already; the list of terminal states belongs in one place,
    // beside the state machine that owns it, or adding a state means finding
    // every filter that hard-codes the old four.
    const live = passes.find((p) => !isTerminal(p.state));
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
      .order("desc")
      .take(PASS_HISTORY_WINDOW);

    // One live pass at a time. Two open timers cannot be reconciled from the
    // taps afterwards, so the record would be unreadable exactly when it matters.
    if (hasLivePass(existing as any)) {
      throw new ConvexError("This student already has a pass open.");
    }

    // Through the shared normalizer, like every other slug read. This one used
    // the raw argument, so a teacher opening a pass for a room stored as
    // `restroom-2` by typing `Restroom 2` got "no active location" for a tag
    // that was on the wall in front of them.
    const slug = normalizeSlug(originSlug);
    const origin = slug
      ? await ctx.db
          .query("tapLocations")
          .withIndex("by_slug", (q) => q.eq("slug", slug))
          .unique()
      : null;
    if (!origin || !origin.active) {
      throw new ConvexError(`No active location with the tag "${slug}".`);
    }

    // Deliberately NOT staff-capped by MAX_PASSES_PER_SCHOOL_DAY. The cap exists
    // to bound what an unattended browser can write; a teacher opening a ninth
    // pass has looked at the child and decided, which is the escape valve the
    // student-facing refusal points them at.

    const student = await ctx.db.get(studentId);
    const clean = trimReason(reason);
    const id = await ctx.db.insert("hallPasses", {
      studentId,
      studentNumber: student?.studentNumber,
      originLocationId: origin._id,
      state: "requested",
      // Through trimReason like the student path. The reason lands on the same
      // live board either way, and an unbounded string typed by a teacher pushes
      // the other children off that screen just as effectively as one typed by a
      // student.
      ...(clean ? { reason: clean } : {}),
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

    // VALIDATED, and note the `!== undefined`. The old guard was
    // `...(minutes ? ... : {})`, which silently treats 0 as absent and hands
    // back the default; in this codebase zero and missing are never the same
    // thing. Anything unusable is refused rather than coerced, because an
    // unchecked value here recreates the trap this whole branch removes: a pass
    // of 1e12 minutes is never overdue, never swept, and permanently live, so
    // the student can never have another pass. See validatePassMinutes.
    let expiresAfterMinutes: number | undefined;
    if (minutes !== undefined) {
      const checked = validatePassMinutes(minutes);
      if (!checked.ok) throw new ConvexError(checked.reason);
      expiresAfterMinutes = checked.minutes;
    }

    // The timer starts at APPROVAL, not at the first tap. A student who is
    // approved and never leaves is still out of class as far as the record goes.
    await ctx.db.patch(passId, {
      state: "active",
      approvedAt: new Date().toISOString(),
      approvedByEmail: teacher.email,
      // The reach leg starts now: 5 minutes to tap the destination. The return
      // leg (expiresAfterMinutes) is timed fresh from that tap.
      reachMinutes: DEFAULT_REACH_MINUTES,
      ...(expiresAfterMinutes !== undefined ? { expiresAfterMinutes } : {}),
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
 * A student asking for a pass, FOR THEMSELVES, FROM THE CLASS THEY ARE IN.
 *
 * NO STUDENT ARGUMENT, and there will never be one. `request` above takes a
 * studentId and is staff-gated for exactly that reason: an endpoint that accepts
 * an id and trusts it is an endpoint that opens a pass in any child's name, and
 * "who asked" is the only thing a hall pass record is evidence of. The caller is
 * whoever the verified Google token says they are.
 *
 * `originSlug` IS GONE, AND THAT IS THE POINT OF THIS REWRITE. The student used
 * to name the room they were leaving off a list, which meant the record said
 * where a fourteen year old typed rather than where they were, and the request
 * went to every teacher's board rather than to the one teacher who could see
 * them. The origin is now DERIVED from their timetable and the clock, so the
 * request reaches the teacher whose lesson they are actually sitting in, and
 * there is no argument left that could point it anywhere else.
 *
 * WHEN THE CLASS CANNOT BE WORKED OUT, THE REQUEST IS REFUSED WITH THE REASON.
 * Lunch, a passing period, before school, after school, a weekend, a day marked
 * as a holiday, an assembly nobody marked, a section that only meets on B days
 * with no cycle day set, a classroom whose tag was never registered: all real,
 * all distinct, all answered in their own words, and none of them papered over
 * with a default teacher. The way round every one of them is the same and is
 * named in the message: ask a teacher to open the pass instead.
 *
 * The decisions are canRequest in hallPassRules.ts and resolveScheduledOrigin
 * above, not inline here, so the cases that matter can be tested without a
 * database.
 */
export const requestMine = mutation({
  args: {
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { reason }) => {
    const student = await requireStudentSelf(ctx);
    const now = new Date().toISOString();

    // Indexed by this student AND bounded. A signed-in child can call this in a
    // loop; an unbounded collect() here reads their whole history every time,
    // and that history is what the loop is adding to.
    const existing = await ctx.db
      .query("hallPasses")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .order("desc")
      .take(PASS_HISTORY_WINDOW);

    const origin = await resolveScheduledOrigin(ctx, student, now);

    if (!origin.ok) {
      // THE STUDENT-SIDE REFUSALS COME FIRST, exactly as canRequest orders them
      // and for the reason it documents: a student holding a stuck request needs
      // to hear about the stuck request, because it is still blocking them
      // wherever they happen to be standing, and being told "it is lunchtime"
      // three times before being told "you already have a pass open" is being
      // sent on an errand. Asked with a present origin so that those two checks
      // are what it answers.
      const studentSide = canRequest(existing, { active: true }, now, passLimitFor(student));
      if (!studentSide.ok) throw new ConvexError(studentSide.reason);
      throw new ConvexError(origin.reason);
    }

    // The same rule again, now with the real tag, so a retired classroom tag or
    // a future edit to canRequest cannot be skipped by this call site.
    const verdict = canRequest(existing, origin.tag, now, passLimitFor(student));
    if (!verdict.ok) throw new ConvexError(verdict.reason);

    const clean = trimReason(reason);
    const id = await ctx.db.insert("hallPasses", {
      studentId: student._id,
      studentNumber: student.studentNumber,
      originLocationId: origin.tag._id,
      state: "requested",
      ...(clean ? { reason: clean } : {}),
      requestedAt: now,
      expiresAfterMinutes: DEFAULT_MINUTES,

      // WHO THIS WENT TO, recorded on the pass rather than re-derived on every
      // read. The timetable changes, and a record that re-derived its own
      // routing would silently rewrite who was asked every time a schedule was
      // edited. This has to keep saying who was asked AT THE TIME.
      originTeacherEmail: origin.teacherEmail,
      ...(origin.sectionId ? { originSectionId: origin.sectionId } : {}),
      originPeriod: origin.period,
      ...(origin.courseName ? { originCourseName: origin.courseName } : {}),
      requestedVia: "student-schedule" as const,
    });

    // Push the origin teacher's device(s), so the request reaches them even when
    // the app is closed. Scheduled, never awaited: a slow or down push service
    // must not make the student's request hang or fail. No-ops when that teacher
    // has no subscriptions or VAPID is unset.
    try {
      await ctx.scheduler.runAfter(0, internal.pushSend.sendToTeacher, {
        teacherEmail: origin.teacherEmail,
        title: "Hall pass request",
        body:
          `${student.firstName} ${student.lastName} is asking to leave ` +
          `${origin.courseName || "class"}.`,
        url: "/?source=push",
      });
    } catch (e) {
      console.error("[push] could not schedule notification:", e);
    }

    // An allowlist, field by field, like every other response here. Never the
    // stored row: hallPasses gains columns (approvedByEmail already), and a
    // spread ships each new one to a student the day it lands.
    return {
      id,
      state: "requested" as const,
      origin: origin.tag.name,
      teacherName: origin.teacherName || null,
      courseName: origin.courseName,
      period: origin.period,
      requestedAt: now,
    };
  },
});

/**
 * A TEACHER opening a pass for a student they can see, with a destination.
 *
 * The second half of the model, and the fallback for every way the first half
 * can honestly fail. The teacher picks the child in front of them and picks
 * where they are going; the child's phone then shows the pass, and they still
 * have to tap the destination tag to validate it and the classroom tag to close
 * it. The physical proof is identical either way, which is the point: a pass a
 * teacher opened is not a pass that skips the walking.
 *
 * OPENED ACTIVE, NOT REQUESTED. There is nobody left to approve it: the approval
 * IS the teacher's action. Leaving it in `requested` would put the teacher's own
 * pass in the teacher's own approval queue, and the timer, which starts at
 * approval because a student approved and not yet gone is still out of class,
 * would not be running while they walked.
 *
 * `assignedDestinationLocationId`, NOT `destinationLocationId`. The first is
 * where the teacher SAID to go and the second is where the student actually
 * tapped, and they are kept apart for the same reason closedAt is kept apart
 * from returnedAt: one is an instruction and the other is a measurement, and
 * "went somewhere else" is the interesting case that folding them would erase.
 *
 * The origin is the teacher's OWN classroom tag, derived the same way the
 * student path derives it. `originSlug` is accepted as an override for the
 * teacher who has no tag registered, or who is not in their own room.
 */
export const openForStudent = mutation({
  args: {
    // THE SIS NUMBER, not a row id, because that is what the teacher's own
    // roster carries and a teacher picks a name off it. Staff-gated, so naming a
    // child is exactly what this is for; nothing a student can reach takes an
    // argument naming a person.
    studentNumber: v.string(),
    destinationSlug: v.string(),
    originSlug: v.optional(v.string()),
    minutes: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { studentNumber, destinationSlug, originSlug, minutes, reason }) => {
    const teacher = await requireStaff(ctx);
    const now = new Date().toISOString();

    const key = String(studentNumber ?? "").trim();
    // NO KEY, NO QUERY. eq("studentNumber", "") is a real bucket lookup that
    // returns whichever rows carry an empty number, and opening a pass against
    // one of those puts a trip out of class on a child nobody named. See
    // studentPortalRules.ts for the same trap on the read side.
    if (!key) throw new ConvexError("Which student is this pass for?");

    // .take(2), not .unique(): a duplicate student number is a real state in
    // this data (the migration notes record former students carried alongside
    // enrolled ones), and .unique() answers it by throwing a plain Error, which
    // Convex redacts to "Server Error" with no way to tell what happened.
    const matches = await ctx.db
      .query("students")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", key))
      .take(2);
    if (matches.length === 0) {
      throw new ConvexError(
        `No student in this app has the number ${key}, so a pass cannot be opened for them.`,
      );
    }
    if (matches.length > 1) {
      throw new ConvexError(
        `More than one student record has the number ${key}, so this pass has been ` +
          `refused rather than opened against a guess. An admin must merge or archive ` +
          `the duplicate.`,
      );
    }
    const student = matches[0];
    const studentId = student._id;

    const existing = await ctx.db
      .query("hallPasses")
      .withIndex("by_student", (q) => q.eq("studentId", studentId))
      .order("desc")
      .take(PASS_HISTORY_WINDOW);
    if (hasLivePass(existing as any)) {
      throw new ConvexError("This student already has a pass open.");
    }
    // THE CHILD'S OWN DAILY CAP APPLIES TO A TEACHER-OPENED PASS TOO, because a
    // cap any adult can walk past by using a different screen is not a cap. It
    // refuses and says the number; a school that means to override raises the
    // number on the student, which leaves a record of the decision.
    {
      const own = passLimitFor(student);
      const takenToday = passesTakenOnDay(existing as any, now);
      if (typeof own === "number" && takenToday >= own) {
        throw new ConvexError(
          own === 0
            ? `${student.firstName} ${student.lastName} is set to no hall passes. Change the limit on their Student Snapshot to open one.`
            : `${student.firstName} ${student.lastName} has used their ${own} pass${own === 1 ? "" : "es"} for today. Raise the limit on their Student Snapshot to open another.`,
        );
      }
    }

    // Validated before anything is written, for the reason validatePassMinutes
    // exists: an unchecked value here makes a pass that is never overdue, never
    // swept and permanently live, which blocks that child from every future pass.
    let expiresAfterMinutes = DEFAULT_MINUTES;
    if (minutes !== undefined) {
      const checked = validatePassMinutes(minutes);
      if (!checked.ok) throw new ConvexError(checked.reason);
      expiresAfterMinutes = checked.minutes!;
    }

    const destSlug = normalizeSlug(destinationSlug);
    const destination = destSlug
      ? await ctx.db
          .query("tapLocations")
          .withIndex("by_slug", (q) => q.eq("slug", destSlug))
          .unique()
      : null;
    if (!destination || !destination.active) {
      throw new ConvexError(`No active tag for "${destSlug}". Register it in Settings > NFC Tags.`);
    }

    // The teacher's own room. Explicit slug wins, because a teacher covering
    // somebody else's class knows where they are and the app does not.
    let origin: Doc<"tapLocations"> | null = null;
    if (originSlug !== undefined) {
      const slug = normalizeSlug(originSlug);
      origin = slug
        ? await ctx.db
            .query("tapLocations")
            .withIndex("by_slug", (q) => q.eq("slug", slug))
            .unique()
        : null;
      if (!origin || !origin.active) {
        throw new ConvexError(`No active tag for "${slug}". Register it in Settings > NFC Tags.`);
      }
    } else {
      const mine = await ctx.db
        .query("tapLocations")
        .withIndex("by_teacherEmail", (q) => q.eq("teacherEmail", teacher.email))
        .take(CLASSROOM_TAG_WINDOW);
      const picked = pickClassroomTag(mine, { teacherEmail: teacher.email });
      if (!picked.ok) {
        // Named rather than defaulted. A pass with no classroom to close at
        // cannot be closed by a tap at all, and applyTap's ordering rule, which
        // is the only thing stopping a student closing a pass on the way out,
        // has nothing to compare against without it.
        throw new ConvexError(
          `${picked.reason} Or say which room this pass starts from.`,
        );
      }
      origin = picked.tag as Doc<"tapLocations">;
    }

    if (origin._id === destination._id) {
      throw new ConvexError(
        "The destination is the same room the pass starts in, so there would be nowhere " +
          "to tap. Pick somewhere else.",
      );
    }

    const clean = trimReason(reason);
    const id = await ctx.db.insert("hallPasses", {
      studentId,
      studentNumber: student.studentNumber,
      originLocationId: origin._id,
      assignedDestinationLocationId: destination._id,
      state: "active",
      ...(clean ? { reason: clean } : {}),
      requestedAt: now,
      approvedAt: now,
      approvedByEmail: teacher.email,
      originTeacherEmail: teacher.email,
      requestedVia: "teacher" as const,
      expiresAfterMinutes,
      // Opened active, so the reach leg starts immediately: 5 minutes to tap the
      // assigned destination, then expiresAfterMinutes to return.
      reachMinutes: DEFAULT_REACH_MINUTES,
    });

    return {
      id,
      state: "active" as const,
      origin: origin.name,
      destination: destination.name,
      expiresAfterMinutes,
    };
  },
});

/**
 * A student cancelling their OWN request.
 *
 * THIS IS THE ESCAPE HATCH, and it is not optional. hasLivePass counts
 * `requested` as live, so a request a teacher never answers, at the end of a
 * period, on a Friday, blocks that student from every future pass forever, with
 * nothing on screen explaining it. Nothing in this codebase had ever written
 * `cancelled`, so before this there was no way out of that state at all.
 * Shipping the request path without this ships a trap.
 *
 * The argument is a PASS id, not a student id. It names one record, ownership is
 * checked against the token-resolved caller in canCancel, and the refusal for
 * somebody else's pass reveals nothing about it, not even its state.
 */
export const cancelMine = mutation({
  args: { passId: v.id("hallPasses") },
  handler: async (ctx, { passId }) => {
    const student = await requireStudentSelf(ctx);

    const pass = await ctx.db.get(passId);
    if (!pass) throw new ConvexError("No such pass.");

    const verdict = canCancel(pass, student._id);
    if (!verdict.ok) throw new ConvexError(verdict.reason);

    // Cancelled, never deleted. The pass is the record of what was asked for and
    // what happened to it; a student who could delete a request could delete the
    // evidence of asking to leave class nine times in a morning.
    await ctx.db.patch(passId, { state: "cancelled" });
    return { state: "cancelled" as const };
  },
});

/**
 * Staff closing a pass that is never going to close itself.
 *
 * THE MISSING EXIT. There was no mutation anywhere in this codebase that could
 * end an `active` or `out` pass except a return tap by the student, and nothing
 * ever wrote `expired`. So a pass approved at 2:50pm that the student never
 * tapped back stayed live forever, and because hasLivePass counts it, that child
 * was blocked from every future hall pass for the rest of their time here. The
 * only tool a teacher had was to tell them to go and tap a tag, which does not
 * work once the buses have gone.
 *
 * The invisible version of the same trap: `tap` refuses an inactive tag before
 * it looks at the pass at all, so an admin calling `tapLocations.retire` on a
 * room stranded every student currently `out` from it, with no error raised and
 * no way for the admin to know. This is the only thing that unsticks them.
 *
 * WRITES `expired`, NOT `returned`, and never sets returnedAt. A forced close
 * must not be indistinguishable from a child actually tapping back in: that tap
 * is the entire evidentiary value of the record. The reason is REQUIRED, and
 * stored with the closer's address, so "somebody closed this" is never the whole
 * answer.
 */
export const forceClose = mutation({
  args: { passId: v.id("hallPasses"), reason: v.string() },
  handler: async (ctx, { passId, reason }) => {
    const staff = await requireStaff(ctx);

    const pass = await ctx.db.get(passId);
    if (!pass) throw new ConvexError("No such pass.");

    // The reason gate lives INSIDE canForceClose now, not here. While it sat in
    // the handler, canForceClose was exactly !isTerminal, and the reachability
    // test's force-close edge therefore fired out of every live state
    // unconditionally, which made that whole test a tautology.
    const verdict = canForceClose(pass, reason);
    if (!verdict.ok) throw new ConvexError(verdict.reason);

    const clean = trimReason(reason);
    const now = new Date().toISOString();
    await ctx.db.patch(passId, {
      state: "expired",
      closedAt: now,
      closedByEmail: staff.email,
      closedReason: clean,
    });
    return { state: "expired" as const, closedAt: now };
  },
});

/**
 * Staff RESETS the timer on a live pass: restart the current leg's clock so the
 * student gets a fresh window, and lift any cleared-timer flag.
 *
 * On the reach leg (active, not yet tapped out) that is a fresh reachMinutes from
 * now; on the return leg (out) a fresh return window from the moment of reset.
 * The pass stays in the same state, at the same origin and destination; only its
 * clock moves. Refused on a pass that is not live, because there is no running
 * timer to reset on one that is requested, denied, cancelled, expired or returned.
 */
export const resetTimer = mutation({
  args: { passId: v.id("hallPasses") },
  handler: async (ctx, { passId }) => {
    await requireStaff(ctx);
    const pass = await ctx.db.get(passId);
    if (!pass) throw new ConvexError("No such pass.");
    if (pass.state !== "active" && pass.state !== "out") {
      throw new ConvexError(
        `This pass is ${pass.state}, so there is no running timer to reset.`,
      );
    }
    const now = new Date().toISOString();
    // undefined UNSETS the field in Convex, which is how a reset also lifts a
    // prior clearTimer: the pass goes back to being timed from now.
    const patch: Record<string, unknown> = { timerCleared: undefined };
    if (pass.state === "active") {
      patch.approvedAt = now;
      patch.reachMinutes = DEFAULT_REACH_MINUTES;
    } else {
      patch.outAt = now;
    }
    await ctx.db.patch(passId, patch as any);
    return { ok: true as const, state: pass.state };
  },
});

/**
 * Staff CLEARS the timer on a live pass: it stays open and closeable but is never
 * overdue and never taken by the nightly sweep. For a trip whose length is
 * nobody's to predict, a nurse visit or an office call. Undo with resetTimer, or
 * close it with forceClose; a return tap still closes it normally. Refused on a
 * pass that is not live.
 */
export const clearTimer = mutation({
  args: { passId: v.id("hallPasses") },
  handler: async (ctx, { passId }) => {
    await requireStaff(ctx);
    const pass = await ctx.db.get(passId);
    if (!pass) throw new ConvexError("No such pass.");
    if (pass.state !== "active" && pass.state !== "out") {
      throw new ConvexError(
        `This pass is ${pass.state}, so there is no timer to clear.`,
      );
    }
    await ctx.db.patch(passId, { timerCleared: true });
    return { ok: true as const, state: pass.state };
  },
});

/**
 * The nightly sweep. Closes passes nobody is coming back to.
 *
 * `internalMutation`, so it is reachable from crons.ts and from nothing a
 * browser can call: this writes a terminal state onto a child's record with no
 * human looking, and that authority does not belong on a public endpoint.
 *
 * BOUNDED, AND THROUGH by_state. It reads only the three live states, only a
 * batch at a time, and reports whether more remain, for the reason psSync.ts
 * documents at length: a full collect() over a growing table works right up
 * until it silently does not, and a cron that throws leaves no trace anybody
 * reads.
 *
 * The predicate is shouldExpire, which is deliberately NOT isOverdue. Overdue
 * goes true the minute a pass runs long and is the signal a teacher wants at the
 * top of the board; expiring at that instant would close the pass of a student
 * who is two minutes late and walking back, and their return tap would then be
 * refused. See EXPIRY_GRACE_MINUTES.
 */
export const expireAbandoned = internalMutation({
  args: { limit: v.optional(v.number()), reason: v.optional(v.string()) },
  handler: async (ctx, { limit, reason }) => {
    const now = new Date().toISOString();
    const batch = Math.min(limit ?? 500, 1000);

    let scanned = 0;
    let expired = 0;
    const truncatedStates: string[] = [];

    for (const state of LIVE_STATES) {
      const rows = await ctx.db
        .query("hallPasses")
        .withIndex("by_state", (q) => q.eq("state", state))
        .take(batch);
      scanned += rows.length;

      for (const p of rows) {
        if (!shouldExpire(p as any, now)) continue;
        await ctx.db.patch(p._id, {
          state: "expired",
          closedAt: now,
          // No closedByEmail: absence is how a reader tells the sweep from a
          // person, without a flag that could be set wrongly.
          closedReason: reason ?? "Closed automatically: never returned.",
        });
        expired++;
      }

      // A full batch means there may be more of this state than we looked at.
      if (rows.length === batch) truncatedStates.push(state);
    }

    // Spent tap intents, oldest first. One row is minted per check-in press and
    // nothing else ever deletes them, so at a few per student per day this table
    // is the fastest-growing thing on the deployment and the only reader wants
    // the newest 24. Kept a week, which is long enough for "which check-in
    // produced this tap" to still be answerable while the tapEvents row, the
    // durable record, is unaffected.
    //
    // The default query order is oldest first, so a bounded take is exactly the
    // candidates, and anything still in date short-circuits the loop.
    const purgeBefore = Date.parse(now) - TAP_INTENT_RETENTION_DAYS * 86400000;
    let purged = 0;
    if (Number.isFinite(purgeBefore)) {
      const oldest = await ctx.db.query("tapIntents").take(batch);
      for (const intent of oldest) {
        const created = Date.parse(intent.createdAt);
        if (!Number.isFinite(created) || created >= purgeBefore) break;
        await ctx.db.delete(intent._id);
        purged++;
      }
    }

    const summary = { scanned, expired, purged, truncatedStates, at: now };

    // RECORDED, not just returned. The return value of a cron goes nowhere by
    // definition: nothing awaits it and nothing reads it, which is the same
    // blind spot psSync.ts documents, where a sync that stopped working left the
    // dashboard showing the last good timestamp. A row in syncRuns is the only
    // way anybody finds out this swept 400 passes last night, or that it hit its
    // batch ceiling and is falling behind.
    //
    // Written only when something happened. An idle row every hour would bury
    // the two rows a day that matter under 24 that do not.
    if (expired > 0 || purged > 0 || truncatedStates.length > 0) {
      await ctx.db.insert("syncRuns", {
        at: now,
        summary: { job: "expireAbandoned", ...summary },
      });
    }

    return summary;
  },
});

/**
 * Write a tap event, unless it is an exact repeat of the one before it.
 *
 * ONE PLACE, so every branch of `tap` gets the same de-duplication and the same
 * lastTapAt update, and so adding a branch cannot quietly skip either. Four call
 * sites had four copies of the insert.
 *
 * The de-dupe is what protects the tag-health screen: without it, a valid slug
 * tapped in a loop writes one row per call, and 2,000 of them at one slug pushed
 * every other tag out of the window tapLocations.list used to read, so every
 * sticker in the building reported as never tapped. It also fixes the honest
 * case, where a phone reads the same tag three times as it is moved away.
 *
 * lastTapAt is stamped on the LOCATION for the same reason: a column on the row
 * cannot be crowded out by another row's traffic.
 */
async function recordTapEvent(
  ctx: MutationCtx,
  studentId: Id<"students">,
  slug: string,
  locationId: Id<"tapLocations">,
  now: string,
  accepted: boolean,
  outcome: string,
  passId?: Id<"hallPasses">,
) {
  const [previous] = await ctx.db
    .query("tapEvents")
    .withIndex("by_student", (q) => q.eq("studentId", studentId))
    .order("desc")
    .take(1);

  if (isDuplicateTapEvent(previous ?? null, { locationSlug: slug, outcome }, now)) {
    return;
  }

  await ctx.db.insert("tapEvents", {
    ...(passId ? { passId } : {}),
    studentId,
    locationSlug: slug,
    at: now,
    accepted,
    outcome,
  });

  // Stamped for every recorded tap, accepted or refused. A tag that is being
  // tapped and refusing is emphatically not a tag nobody has touched, and the
  // health screen's question is "is this sticker alive". The id is passed in
  // rather than looked up again: every caller already holds the row.
  await ctx.db.patch(locationId, { lastTapAt: now });
}

/**
 * Step one of a tap: the student says, from their own session, that they are
 * about to check in at a specific tag.
 *
 * CALL THIS ONLY FROM A REAL USER GESTURE HANDLER. That sentence is the entire
 * remaining client obligation and it cannot be enforced here: the server has no
 * way to see a button press, so a page that called this on load and immediately
 * redeemed the token would put the forgery back exactly as it was. Everything
 * below is built so that this one reviewable line is all that is left to get
 * right.
 *
 * What the token does buy, on the server, without trusting the client at all:
 * a tap can no longer be caused by a link. `?tap=<slug>` on its own now produces
 * nothing, so a forwarded link, a bookmarked one, a texted one and a blank NFC
 * sticker a student encoded themselves are all inert. The token is bound to one
 * student and one slug, expires in two minutes, and is single use, so it cannot
 * be minted by an attacker, handed to a victim, redeemed twice, or redeemed at a
 * different tag than the one it was minted for.
 */
export const beginTap = mutation({
  args: { locationSlug: v.string() },
  handler: async (ctx, { locationSlug }) => {
    const student = await requireStudentSelf(ctx);
    const now = new Date().toISOString();
    const slug = normalizeSlug(locationSlug);

    const location = slug
      ? await ctx.db
          .query("tapLocations")
          .withIndex("by_slug", (q) => q.eq("slug", slug))
          .unique()
      : null;

    // Refused before anything is written, same as `tap`. An unknown slug is an
    // arbitrary string from an untrusted caller and must not create a row.
    if (!location || !location.active) {
      throw new ConvexError("This tag is not set up yet. Tell your teacher.");
    }

    // The rate limit lives HERE, on minting, because a tap now requires a mint.
    // Bounding this bounds tapEvents, which is what protects the tag-health
    // screen from being flooded blind by one student at one slug.
    const recent = await ctx.db
      .query("tapIntents")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .order("desc")
      .take(MAX_TAP_INTENTS_PER_WINDOW * 2);

    const allowed = withinTapRateLimit(recent, now);
    if (!allowed.ok) throw new ConvexError(allowed.reason);

    // Minted server-side and never derived from anything the client sent. A
    // token the client could compute is a token the client could forge.
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.parse(now) + TAP_INTENT_TTL_SECONDS * 1000).toISOString();

    await ctx.db.insert("tapIntents", {
      studentId: student._id,
      locationSlug: slug,
      token,
      createdAt: now,
      expiresAt,
    });

    return { token, expiresAt, location: location.name, slug };
  },
});

/**
 * A tap at a wall tag, BY THE STUDENT WHO TAPPED IT.
 *
 * No studentId argument. The student is whoever the verified Google token says
 * they are. The earlier version took an id and required staff, which is the
 * shape of a kiosk, not of a child holding a phone at a restroom door: it would
 * have let anyone with a staff session close anyone's pass.
 *
 * EVERY TAP AT A REAL TAG IS RECORDED, accepted or not. A refused tap is the
 * interesting one: a student tapping the classroom tag on the way out, or
 * tapping with no approved pass, is precisely what a teacher wants to see.
 * Storing only successes would erase the behaviour this exists to notice.
 *
 * AN UNKNOWN SLUG IS THE ONE EXCEPTION, and it is a change from what
 * docs/nfc-tap-map.md describes. That branch used to insert a tapEvents row for
 * any string at all and return, with no pass required and no tag required, which
 * made this mutation a write channel: a signed-in student could loop it with a
 * slug of any length and grow a table nothing in this repo deletes. The slug is
 * now length-capped by normalizeSlug and an unknown one is refused BEFORE
 * anything is written.
 *
 * A RETIRED tag still records the refusal, deliberately. That tag physically
 * exists on a wall, a child really is standing in front of it, and "the sticker
 * outside room 12 is dead" is exactly the thing the tap history is for.
 *
 * A SLUG ALONE IS NO LONGER PROOF OF ANYTHING. This required only a slug, and
 * the page fires it straight from `?tap=` on load, so any student could send a
 * classmate a link and cause a tap in the victim's name: closing a trip the
 * victim was still on by writing returnedAt, forging their destination, or
 * filing a refused-tap row under their name at a location of the attacker's
 * choosing. A tap now also requires an intent token minted by beginTap from the
 * victim's own session, for that slug, in the last two minutes, and never used
 * before. See the tap intent section of hallPassRules.ts.
 *
 * A tap proves somebody opened a URL, not that a body was in a room. See
 * docs/nfc-tap-map.md.
 */
export const tap = mutation({
  args: {
    locationSlug: v.string(),
    // OPTIONAL IN THE VALIDATOR, REQUIRED BY THE HANDLER, and the difference
    // matters only for the message. A missing token is refused either way; as
    // v.string() the refusal is an argument-validation error, which reaches the
    // student as unreadable text about types. As optional, canRedeemTapIntent
    // answers it with "press the button on your pass", which is what a child
    // holding a phone at a door can act on. The security property is unchanged:
    // there is no path below that acts without a redeemable intent.
    intentToken: v.optional(v.string()),
  },
  handler: async (ctx, { locationSlug, intentToken }) => {
    const student = await requireStudentSelf(ctx);
    const now = new Date().toISOString();

    // The shared normalizer, which also refuses anything over MAX_RAW_SLUG_LENGTH
    // in constant time before any regex touches it. This argument comes straight
    // off a URL the student controls.
    const slug = normalizeSlug(locationSlug);

    // THE TOKEN IS CHECKED FIRST, before the tag is even looked up and before
    // anything at all is written. Every harm in the forgery was a write made in
    // the victim's name, so the fix has to land ahead of all of them: an
    // unauthorised tap now changes nothing and records nothing.
    const intent = intentToken
      ? await ctx.db
          .query("tapIntents")
          .withIndex("by_token", (q) => q.eq("token", intentToken))
          .unique()
      : null;

    const redeemable = canRedeemTapIntent(intent, student._id, slug, now);
    if (!redeemable.ok) {
      return { ok: false, reason: redeemable.reason, location: null };
    }
    // canRedeemTapIntent already refused a null intent; TypeScript cannot follow
    // that across the call and a `!` here would let a future edit redeem nothing.
    if (!intent) {
      return { ok: false, reason: redeemable.reason, location: null };
    }

    // SPENT BEFORE THE WORK, not after. If it were marked used at the end, two
    // requests arriving together could both pass the check and both act; Convex
    // would serialize them, but the second would find the token unspent. Burning
    // it first makes single use mean single use.
    await ctx.db.patch(intent._id, { usedAt: now });

    const location = slug
      ? await ctx.db
          .query("tapLocations")
          .withIndex("by_slug", (q) => q.eq("slug", slug))
          .unique()
      : null;

    // NOTHING IS WRITTEN for a slug that is not a tag in this building. An
    // unknown slug is an arbitrary string from an untrusted caller, and storing
    // one row per attempt is the whole exploit.
    if (!location) {
      return {
        ok: false,
        reason: "This tag is not set up yet. Tell your teacher.",
        location: null,
      };
    }

    if (!location.active) {
      await recordTapEvent(ctx, student._id, slug, location._id, now, false, "Retired tag.");
      return { ok: false, reason: "This tag is not set up yet. Tell your teacher.", location: null };
    }

    const passes = await ctx.db
      .query("hallPasses")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .order("desc")
      .take(PASS_HISTORY_WINDOW);
    const live = passes.find((p) => !isTerminal(p.state));

    if (!live) {
      await recordTapEvent(ctx, student._id, slug, location._id, now, false, "No open pass.");
      return {
        ok: false,
        reason: "You do not have a pass open. Ask your teacher first.",
        location: location.name,
      };
    }

    const result = applyTap(live as any, location._id, now);

    await recordTapEvent(ctx, student._id, slug, location._id, now, result.ok, result.reason, live._id);

    // NOTHING IS PATCHED ON A REFUSAL. The tapEvents row above is the record
    // that somebody tapped here and was turned away; the pass itself is left
    // exactly as it was, so a student tapping the wrong tag cannot advance,
    // close, or re-stamp a trip.
    if (!result.ok) return { ok: false, reason: result.reason, location: location.name };

    /* ---- what a tap writes ---- */
    // Hoisted out of the patch call so the round-trip test can lift THIS object
    // rather than keep its own copy of it. A test that models what a tap writes
    // is a test that keeps passing after a tap starts writing something else;
    // hall-pass-round-trip.test.mjs slices between these two markers and runs
    // the real expression. Same trick pass-clock.test.mjs uses on script.js.
    const written = {
      state: result.nextState,
      // outAt on the first tap, returnedAt on the second. applyTap owns which,
      // because the ordering rule and the field are the same decision.
      [result.field]: now,
      // WHERE THEY ACTUALLY WENT, recorded only on the leg that has an arrival.
      // Kept apart from assignedDestinationLocationId, which is where a teacher
      // SENT them: one is a measurement and one is an instruction, and folding
      // them erases "went somewhere else".
      ...(result.field === "outAt" ? { destinationLocationId: location._id } : {}),
    };
    /* ---- end what a tap writes ---- */

    await ctx.db.patch(live._id, written as any);

    return { ok: true, state: result.nextState, reason: result.reason, location: location.name };
  },
});

/**
 * Everything currently out, for a teacher's screen. Overdue first.
 *
 * THROUGH by_state, WHICH IS WHY THE INDEX EXISTS. This read used to be
 * `.query("hallPasses").collect()` followed by a filter in JavaScript: it read
 * every pass ever issued in order to display the handful that are open right now.
 * Convex allows 4,096 document reads per execution, hallPasses only ever grows,
 * and nothing in this repo deletes from it. 646 students at a few passes a week
 * crosses that inside a term with no attacker involved at all.
 *
 * What that failure looks like matters, because it is why this is the first fix
 * and not the tidiest one: the ONLY screen showing which children are out of the
 * building throws for every teacher simultaneously, permanently, with no delete
 * path in the repo to recover with. psSync.ts:83-85 is the same failure already
 * having happened here once.
 */
/**
 * The notes on a set of passes, as the one line a board shows for each.
 * Bounded per pass; a pass with more than a screen of notes is a pass being
 * used as a chat, and the board shows the newest and the count either way.
 */
const NOTES_PER_PASS = 50;
// One page of history, and the widest walk behind it. The scan cap is the
// bound that keeps this a query rather than a table read: it is generous
// enough that a day's filtering is exact, and it says so when it truncates
// rather than quietly reporting a short year.
const HISTORY_PAGE_MAX = 200;
const HISTORY_SCAN_MAX = 2000;
async function noteSummaries(
  ctx: QueryCtx,
  passIds: Id<"hallPasses">[],
): Promise<Map<string, { count: number; highest: NoteLevel | null; latest: { level: NoteLevel; text: string; authorName: string; at: string } | null }>> {
  const out = new Map();
  for (const id of passIds) {
    const notes = await ctx.db
      .query("hallPassNotes")
      .withIndex("by_pass", (q) => q.eq("passId", id))
      .take(NOTES_PER_PASS);
    const sum = summarizeNotes(notes);
    out.set(String(id), {
      count: sum.count,
      highest: sum.highest,
      latest: sum.latest
        ? { level: sum.latest.level, text: sum.latest.text, authorName: sum.latest.authorName, at: sum.latest.at }
        : null,
    });
  }
  return out;
}

/** Staff names for a set of emails, one bounded read per distinct address. */
async function teacherNames(ctx: QueryCtx, emails: Array<string | null | undefined>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const raw of emails) {
    const email = String(raw ?? "").trim().toLowerCase();
    if (!email || out.has(email)) continue;
    const t = await ctx.db
      .query("teachers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (t) out.set(email, t.name);
  }
  return out;
}

export const liveBoard = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    const now = new Date().toISOString();

    // One bounded indexed read per live state. Terminal passes are never read at
    // all, which is the whole point: they are the part that grows forever.
    //
    // .order("asc") IS DELIBERATE, and it is the opposite of the windowed reads
    // elsewhere in this file. Those want the newest row because they are looking
    // for a student's live pass. This wants the OLDEST, because if the cap is
    // ever reached the rows that must survive are the longest-running ones: they
    // are the overdue children, and the sort below puts them at the top. Taking
    // the newest 200 would drop exactly the children a teacher needs to see, and
    // leave a board full of trips that started a minute ago looking healthy.
    const live = [];
    const truncatedStates: string[] = [];
    for (const state of LIVE_STATES) {
      const rows = await ctx.db
        .query("hallPasses")
        .withIndex("by_state", (q) => q.eq("state", state))
        .order("asc")
        .take(LIVE_BOARD_LIMIT_PER_STATE);
      // Per state, not one flag for three buckets: "some of this board is
      // missing" is not actionable, "200 students are showing as out" is.
      if (rows.length === LIVE_BOARD_LIMIT_PER_STATE) truncatedStates.push(state);
      live.push(...rows);
    }

    // THE CAMPUS BOARD READS THIS TOO, and an aide acting on a row needs what
    // a teacher's own board already carries: where the pass came from and who
    // owns it, by name, where it was sent, and whether anyone has written on
    // it. One bounded read per distinct teacher and per pass, never a scan.
    const names = await teacherNames(ctx, live.map((p) => p.originTeacherEmail));
    const notes = await noteSummaries(ctx, live.map((p) => p._id));
    const rows = await Promise.all(
      live.map(async (p) => {
        const student = await ctx.db.get(p.studentId);
        const origin = p.originLocationId ? await ctx.db.get(p.originLocationId) : null;
        const destination = p.assignedDestinationLocationId
          ? await ctx.db.get(p.assignedDestinationLocationId)
          : null;
        const teacherEmail = p.originTeacherEmail ?? null;
        return {
          id: p._id,
          state: p.state,
          studentName: student ? `${student.firstName} ${student.lastName}`.trim() : "(unknown)",
          studentNumber: p.studentNumber,
          grade: student?.grade ?? null,
          elapsedMinutes: elapsedMinutes(p as any, now),
          overdue: isOverdue(p as any, now),
          reason: p.reason ?? null,
          origin: origin?.name ?? null,
          assignedDestination: destination?.name ?? null,
          teacherName: teacherEmail ? (names.get(teacherEmail) ?? null) : null,
          timerCleared: p.timerCleared ?? false,
          expiresAfterMinutes: p.expiresAfterMinutes,
          notes: notes.get(String(p._id)) ?? { count: 0, highest: null, latest: null },
          requestedAt: p.requestedAt,
          /*
           * The timestamps the board COUNTS from. elapsedMinutes is correct
           * the instant it is computed and frozen from then on, so a board
           * built on it sits still between polls. Given these, the browser
           * ticks its own clocks and the server is asked rarely.
           */
          approvedAt: p.approvedAt ?? null,
          outAt: p.outAt ?? null,
          // Who it was routed to and from which lesson. Null on passes written
          // before requests came from a timetable, and null is the honest answer
          // for those: nobody recorded it, and back-filling a teacher onto an old
          // record would be inventing the one fact the record is evidence of.
          teacherEmail: p.originTeacherEmail ?? null,
          period: p.originPeriod ?? null,
          courseName: p.originCourseName ?? null,
          requestedVia: p.requestedVia ?? null,
        };
      }),
    );

    // Overdue first, then longest out. A teacher scanning this wants the
    // exception at the top, not alphabetical order. The comparator is a pure
    // function in hallPassRules so the one piece of judgement on this screen is
    // testable: a board that sorts wrongly puts the wrong child in the top row.
    const sorted = sortLiveBoard(rows);

    // Told, not hidden. A board that silently stops at the cap is a board that
    // is missing a child who is out of the building, which is the one thing it
    // exists to never do.
    return { passes: sorted, generatedAt: now, truncatedStates };
  },
});

/**
 * MY OWN CLASSES' PASSES. The board a teacher actually acts on.
 *
 * The whole reason requests now carry a teacher: `liveBoard` shows every live
 * pass in the school to every member of staff, which is right for the front
 * office and useless in a classroom. A teacher with 34 children in front of them
 * needs the three requests that are theirs, at the top, not one screen with the
 * whole building on it.
 *
 * THROUGH by_originTeacherEmail, WHICH IS WHY THAT INDEX EXISTS. Filtering the
 * school-wide board in JavaScript would read every live pass to show one
 * teacher's three, which is the shape liveBoard itself had to be rescued from.
 *
 * Passes written before requests came from a timetable have no
 * originTeacherEmail and therefore appear on NOBODY's class board. That is
 * deliberate and it is not a gap: they are still on liveBoard, which is where
 * they always were, and inventing a teacher for them would be inventing the one
 * fact a hall pass record exists to hold.
 */
export const myClassBoard = query({
  args: {},
  handler: async (ctx) => {
    const teacher = await requireStaff(ctx);
    const now = new Date().toISOString();

    // Newest first and bounded. A live pass blocks every later request for that
    // student, so live rows are always among the newest; this window is a few
    // days of one teacher's traffic even if every child asked every period.
    const rows = await ctx.db
      .query("hallPasses")
      .withIndex("by_originTeacherEmail", (q) => q.eq("originTeacherEmail", teacher.email))
      .order("desc")
      .take(CLASS_BOARD_WINDOW);

    const live = rows.filter((p) => !isTerminal(p.state));
    // What an aide has written on these, so the badge is on the row the
    // teacher already looks at rather than on a screen they would have to
    // know to open.
    const notes = await noteSummaries(ctx, live.map((p) => p._id));

    const decorated = await Promise.all(
      live.map(async (p) => {
        const student = await ctx.db.get(p.studentId);
        const destination = p.assignedDestinationLocationId
          ? await ctx.db.get(p.assignedDestinationLocationId)
          : null;
        return {
          id: p._id,
          state: p.state,
          notes: notes.get(String(p._id)) ?? { count: 0, highest: null, latest: null },
          studentName: student ? `${student.firstName} ${student.lastName}`.trim() : "(unknown)",
          studentNumber: p.studentNumber ?? null,
          reason: p.reason ?? null,
          period: p.originPeriod ?? null,
          courseName: p.originCourseName ?? null,
          // Where they were SENT, when a teacher said. Null on a student-opened
          // pass, where the destination is not known until they tap.
          assignedDestination: destination?.name ?? null,
          elapsedMinutes: elapsedMinutes(p as any, now),
          overdue: isOverdue(p as any, now),
          requestedAt: p.requestedAt,
          /*
           * The timestamps the board COUNTS from. elapsedMinutes is correct
           * the instant it is computed and frozen from then on, so a board
           * built on it sits still between polls. Given these, the browser
           * ticks its own clocks and the server is asked rarely.
           */
          approvedAt: p.approvedAt ?? null,
          outAt: p.outAt ?? null,
          expiresAfterMinutes: p.expiresAfterMinutes,
          // Staff cleared the limit: the board shows "no limit" and offers to
          // restore rather than reset, and overdue is already false above.
          timerCleared: p.timerCleared ?? false,
        };
      }),
    );

    return {
      teacher: { name: teacher.name, email: teacher.email },
      // Overdue first, then longest out. Same comparator as the school-wide
      // board, because "which row does a human look at first" has one answer.
      passes: sortLiveBoard(decorated),
      // Told rather than hidden, for the same reason liveBoard reports its cap.
      truncated: rows.length === CLASS_BOARD_WINDOW,
      generatedAt: now,
    };
  },
});

/**
 * ONE PASS, IN FULL, FOR THE STAFF SCREEN THAT OPENS IT.
 *
 * The boards carry a row; this carries the pass: who, where from and to, who
 * approved it and when, both clocks, and every note written on it, oldest
 * first so it reads as what happened. Any member of staff may open any live
 * pass, which is the same rule liveBoard already applies to the row, and the
 * student fields are the ones the row already shows: a name, a number, a
 * grade. Nothing restricted, nothing from the student record the pass did
 * not already name.
 */
/**
 * EVERY PASS, NEWEST FIRST: the record, for the screens that read it rather
 * than act on it (Pass History, a student's snapshot, the pattern analysis).
 *
 * THIS EXISTS BECAUSE THOSE SCREENS WERE READING A TABLE NOTHING WRITES ANY
 * MORE. Hall Monitor, Pass History, Student Snapshot and Encounter Prevention
 * all read the pre-Convex `hallPasses` ARRAY in the browser, which was filled
 * by the Student Kiosk. The kiosk is gone, so those screens have been showing
 * a graveyard of pre-migration rows (all of them permanently "overtime",
 * because their duration expired months ago) or nothing at all, while every
 * real pass since the migration lived in this table unseen.
 *
 * PAGED, AND BOUNDED. A school year is tens of thousands of passes and this is
 * a query, so it takes a window and says whether it filled it. `before` is the
 * creation time of the last row of the previous page, which is stable under
 * inserts in a way an offset is not: new passes arrive at the top and cannot
 * shuffle a page the caller has already read.
 *
 * The optional filters are applied HERE rather than in the browser so a search
 * across a year does not have to ship a year to the client to find one child.
 */
export const history = query({
  args: {
    limit: v.optional(v.number()),
    before: v.optional(v.number()),
    studentNumber: v.optional(v.string()),
    search: v.optional(v.string()),
    state: v.optional(v.string()),
    sinceIso: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireStaff(ctx);
    const now = new Date().toISOString();
    const limit = Math.max(1, Math.min(args.limit ?? 100, HISTORY_PAGE_MAX));
    const needle = String(args.search ?? "").trim().toLowerCase();
    const wantState = String(args.state ?? "").trim().toLowerCase();
    const sinceMs = args.sinceIso ? Date.parse(args.sinceIso) : NaN;

    // One student's own history reads through by_student, which is an indexed
    // walk of that child's rows rather than a scan of the school's.
    //
    // WHEN IT IS ONE CHILD, THE CAP COMES BACK WITH THEM. Student Snapshot
    // shows "2 of 3 passes today" beside a Set Pass Limit button, and it used
    // to derive both halves in the browser: the limit off the appData roster
    // (which does not carry the field) and the count off the pre-Convex array
    // (which nothing writes), so the row was two zeroes wearing a number's
    // clothes. Both are computed HERE now, by the same two functions canRequest
    // uses, so the figure a teacher reads and the rule a child hits cannot
    // disagree. `passesTakenOnDay` counts approved passes on the school day,
    // which is not the same as "rows since midnight" — the rollover minutes and
    // the approval test both live in that function and nowhere else.
    let rows: Doc<"hallPasses">[];
    let cap: { limit: number | null; takenToday: number } | null = null;
    if (args.studentNumber) {
      const student = await ctx.db
        .query("students")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", args.studentNumber!))
        .unique();
      if (!student) {
        return {
          passes: [],
          more: false,
          cursor: null,
          scanned: 0,
          truncated: false,
          cap: null,
          generatedAt: now,
        };
      }
      rows = await ctx.db
        .query("hallPasses")
        .withIndex("by_student", (q) => q.eq("studentId", student._id))
        .order("desc")
        .take(HISTORY_SCAN_MAX);
      cap = { limit: passLimitFor(student), takenToday: passesTakenOnDay(rows, now) };
    } else {
      let q = ctx.db.query("hallPasses").order("desc");
      rows = await q.take(HISTORY_SCAN_MAX);
    }

    // The page window, then the filters. Filtering after the cursor keeps the
    // cursor meaning "where the last page ended" rather than "where the last
    // page ended for these filters", which is what makes changing a filter
    // safe mid-browse.
    const windowed = rows.filter((p) => (args.before ? p._creationTime < args.before : true));
    const matched = windowed.filter((p) => {
      if (wantState && String(p.state).toLowerCase() !== wantState) return false;
      if (!Number.isNaN(sinceMs) && Date.parse(p.requestedAt) < sinceMs) return false;
      return true;
    });

    const page = matched.slice(0, limit + 1);
    const more = page.length > limit;
    const take = more ? page.slice(0, limit) : page;

    const names = await teacherNames(ctx, take.map((p) => p.originTeacherEmail));
    const decorated = await Promise.all(
      take.map(async (p) => {
        const student = await ctx.db.get(p.studentId);
        const origin = p.originLocationId ? await ctx.db.get(p.originLocationId) : null;
        const assigned = p.assignedDestinationLocationId
          ? await ctx.db.get(p.assignedDestinationLocationId)
          : null;
        const tapped = p.destinationLocationId ? await ctx.db.get(p.destinationLocationId) : null;
        const teacherEmail = p.originTeacherEmail ?? null;
        return {
          id: p._id,
          at: p._creationTime,
          state: p.state,
          terminal: isTerminal(p.state),
          studentName: student ? `${student.firstName} ${student.lastName}`.trim() : "(unknown)",
          studentNumber: p.studentNumber ?? student?.studentNumber ?? null,
          grade: student?.grade ?? null,
          origin: origin?.name ?? null,
          // Where they were SENT, or failing that where they actually tapped.
          // A student-requested pass has no assigned destination until the tap.
          destination: assigned?.name ?? tapped?.name ?? null,
          reason: p.reason ?? null,
          period: p.originPeriod ?? null,
          courseName: p.originCourseName ?? null,
          teacherName: teacherEmail ? (names.get(teacherEmail) ?? null) : null,
          requestedAt: p.requestedAt,
          approvedAt: p.approvedAt ?? null,
          outAt: p.outAt ?? null,
          returnedAt: p.returnedAt ?? null,
          closedAt: p.closedAt ?? null,
          closedReason: p.closedReason ?? null,
          expiresAfterMinutes: p.expiresAfterMinutes,
          timerCleared: p.timerCleared ?? false,
          // Minutes the pass RAN, which for a closed pass is its whole life and
          // for a live one is how long it has been going. Null when it never
          // started, and null is not zero: see elapsedMinutes.
          elapsedMinutes: elapsedMinutes(p as any, now),
          overdue: isOverdue(p as any, now),
        };
      }),
    );

    // The name search is applied last, on the decorated rows, because the name
    // lives on the student record rather than on the pass.
    const found = needle
      ? decorated.filter(
          (r) =>
            r.studentName.toLowerCase().includes(needle) ||
            String(r.studentNumber ?? "").toLowerCase().includes(needle),
        )
      : decorated;

    return {
      passes: found,
      more,
      // The cursor for the next page: the creation time of the last row READ,
      // not the last row shown, or a page whose rows were all filtered out
      // would hand back the cursor it was given and loop for ever.
      cursor: take.length ? take[take.length - 1]._creationTime : null,
      scanned: rows.length,
      truncated: rows.length === HISTORY_SCAN_MAX,
      // Null when the caller asked for the whole school: there is no one
      // child's cap to report, and a zero here would read as one.
      cap,
      generatedAt: now,
    };
  },
});

export const passDetail = query({
  args: { passId: v.id("hallPasses") },
  handler: async (ctx, { passId }) => {
    const me = await requireStaff(ctx);
    const pass = await ctx.db.get(passId);
    if (!pass) throw new ConvexError("No such pass.");
    const now = new Date().toISOString();
    const student = await ctx.db.get(pass.studentId);
    const origin = pass.originLocationId ? await ctx.db.get(pass.originLocationId) : null;
    const destination = pass.assignedDestinationLocationId
      ? await ctx.db.get(pass.assignedDestinationLocationId)
      : null;
    const tapped = pass.destinationLocationId ? await ctx.db.get(pass.destinationLocationId) : null;
    const names = await teacherNames(ctx, [pass.originTeacherEmail, pass.approvedByEmail, pass.closedByEmail]);
    const notes = await ctx.db
      .query("hallPassNotes")
      .withIndex("by_pass", (q) => q.eq("passId", passId))
      .take(NOTES_PER_PASS);
    notes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const clock = passClock(pass as any);
    return {
      id: pass._id,
      state: pass.state,
      terminal: isTerminal(pass.state),
      student: student
        ? { name: `${student.firstName} ${student.lastName}`.trim(), number: student.studentNumber ?? pass.studentNumber ?? null, grade: student.grade ?? null }
        : { name: "(unknown)", number: pass.studentNumber ?? null, grade: null },
      reason: pass.reason ?? null,
      requestedVia: pass.requestedVia ?? null,
      origin: origin?.name ?? null,
      assignedDestination: destination?.name ?? null,
      tappedDestination: tapped?.name ?? null,
      courseName: pass.originCourseName ?? null,
      period: pass.originPeriod ?? null,
      teacherEmail: pass.originTeacherEmail ?? null,
      teacherName: pass.originTeacherEmail ? (names.get(pass.originTeacherEmail) ?? null) : null,
      approvedByName: pass.approvedByEmail ? (names.get(pass.approvedByEmail) ?? pass.approvedByEmail) : null,
      closedByName: pass.closedByEmail ? (names.get(pass.closedByEmail) ?? pass.closedByEmail) : null,
      closedReason: pass.closedReason ?? null,
      requestedAt: pass.requestedAt,
      approvedAt: pass.approvedAt ?? null,
      outAt: pass.outAt ?? null,
      returnedAt: pass.returnedAt ?? null,
      closedAt: pass.closedAt ?? null,
      expiresAfterMinutes: pass.expiresAfterMinutes,
      reachMinutes: pass.reachMinutes ?? null,
      timerCleared: pass.timerCleared ?? false,
      clockStartAt: clock.startAt,
      clockLimitMinutes: clock.limitMinutes,
      elapsedMinutes: elapsedMinutes(pass as any, now),
      overdue: isOverdue(pass as any, now),
      notes: notes.map((n) => ({
        id: n._id,
        level: n.level,
        text: n.text,
        authorName: n.authorName,
        authorRole: n.authorRole,
        mine: n.authorEmail === me.email,
        at: n.at,
      })),
      // Whether the caller is the teacher this pass belongs to, so the screen
      // can say "your class" rather than name them to themselves.
      isOwnClass: !!pass.originTeacherEmail && pass.originTeacherEmail === me.email,
      serverTime: now,
    };
  },
});

/**
 * A NOTE FROM WHOEVER MET THE CHILD, TO THE TEACHER WHO LET THEM GO.
 *
 * Any member of staff may write one; a campus aide is the reason it exists. It
 * is stored against the pass, shows on the owning teacher's board and on the
 * pass itself, and is pushed to the teacher's device unless the author IS that
 * teacher, who does not need telling what they just wrote. A pass with no
 * origin teacher (one opened before requests carried a teacher) still takes
 * the note, for the record and for whoever opens the pass next; there is
 * nobody to push to and the caller is told so rather than left to assume.
 */
export const addNote = mutation({
  args: {
    passId: v.id("hallPasses"),
    level: v.string(),
    text: v.string(),
  },
  handler: async (ctx, { passId, level, text }) => {
    const me = await requireStaff(ctx);
    const pass = await ctx.db.get(passId);
    if (!pass) throw new ConvexError("No such pass.");
    const verdict = canNotePass(pass, level, text);
    if (!verdict.ok || !verdict.level || !verdict.text) throw new ConvexError(verdict.reason);
    const now = new Date().toISOString();
    const student = await ctx.db.get(pass.studentId);
    const studentName = student ? `${student.firstName} ${student.lastName}`.trim() : "A student";
    const teacherEmail = pass.originTeacherEmail ?? undefined;

    const id = await ctx.db.insert("hallPassNotes", {
      passId,
      studentId: pass.studentId,
      ...(teacherEmail ? { teacherEmail } : {}),
      authorEmail: me.email,
      authorName: me.name,
      authorRole: me.role,
      level: verdict.level,
      text: verdict.text,
      at: now,
    });

    let notified = false;
    if (teacherEmail && teacherEmail !== me.email) {
      try {
        const lead = verdict.level === "urgent" ? "URGENT: " : verdict.level === "concern" ? "Concern: " : "";
        await ctx.scheduler.runAfter(0, internal.pushSend.sendToTeacher, {
          teacherEmail,
          title: `${lead}${studentName}'s hall pass`,
          body: `${me.name}: ${verdict.text}`,
          url: `/?source=push&pass=${String(passId)}`,
        });
        notified = true;
      } catch (e) {
        console.error("[push] could not schedule note notification:", e);
      }
    }
    return {
      id,
      at: now,
      notified,
      teacherEmail: teacherEmail ?? null,
      note: teacherEmail
        ? (notified ? "Sent to the teacher's device." : "Stored on the pass; you wrote it on your own class.")
        : "Stored on the pass. This pass has no teacher on it, so nobody was pushed; the note is here for whoever opens it.",
    };
  },
});
