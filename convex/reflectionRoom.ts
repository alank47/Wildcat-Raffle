import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireStaff } from "./identity";
import { canAdminReflection, canReadReflection } from "./accessRules";
import {
  audit, dayStateOf, ensureDay, getDay, getLease, loadSettings, markedOf, readState, ROSTER_KEY, startRead, unitItemOf, writeState,
} from "./reflection";
import { reviewItems, schoolNow } from "./reflectionList";
import {
  carriedUnit, clockText, dayLabel, dayTimes, LEASE_MS, readNowIntent, roomWindow, rosterAgeBanner, scheduleKindFor,
  schoolDayVerdict, termBanner, type ScheduleKind,
} from "./reflectionRules";

/**
 * WHAT PEOPLE DO TO THE REFLECTION ROOM LIST (build spec 4.7, steps 7b and
 * 8b): the room's own attendance, the admin review queue, the two admin
 * buttons, and the health card.
 *
 * reflection.ts makes the list and is internal; reflectionList.ts reads it
 * and records prints. Every public function here CHECKS WHO IS ASKING FIRST,
 * before it reads a row:
 *   - the room's attendance (Not here, Attendance done): canReadReflection --
 *     the three roles, and a per-person grant, because the room's supervisor
 *     may hold one;
 *   - everything else (the review queue and its decisions, Room did not run,
 *     This is a school day, Read PowerSchool now, the health card):
 *     canAdminReflection, the three roles only -- never a grant.
 *
 * EVERY ACT IS WRITTEN TWICE: on the thing it changes (the detention, the day,
 * the review item), and as an append-only row in reflectionAudit, which only
 * the roles can read. NEVER appAuditLog: every staff browser downloads that
 * table, and a review decision names a child.
 */

const READ_REFUSED = "The Reflection Room list is limited to administrators, the PBIS team and staff an administrator has "
  + "given access to it.";
const ADMIN_REFUSED = "Only administrators and the PBIS team can do that on the Reflection Room list.";
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** "Read PowerSchool now" runs at most this often, whoever presses it. */
const READ_NOW_GAP_MS = 2 * 60 * 1000;
const READ_NOW_KEY = "reflection:readNow";

type Ctx = QueryCtx | MutationCtx;

/** The room-attendance window for day `date`'s list, from what is stored now. */
async function roomStateOf(ctx: Ctx, date: string, nowIso: string, tz: string) {
  const row = await getDay(ctx, date);
  const settings = await loadSettings(ctx);
  const marked = await markedOf(ctx, date);
  const kind = (row?.kind as ScheduleKind | undefined)
    ?? scheduleKindFor({ date, marked, scheduleKinds: settings.scheduleKinds, rowCounts: row?.rowCounts ?? null }).kind;
  const t = dayTimes(date, kind, settings, tz);
  const later = await ctx.db.query("reflectionDays").withIndex("by_date", (q) => q.gt("date", date)).collect();
  const nextMade = later.filter((d) => d.frozenAt).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
  const w = roomWindow({
    nowIso, listMadeAt: row?.frozenAt ?? null, powerUpMs: t.ok ? t.powerUpMs : null, nextListMadeAt: nextMade?.frozenAt ?? null, tz,
  });
  return { row, w };
}

/** On day D's list, for the room: listed, carried or in review from it (released is not pulled). */
const ON_LIST = new Set(["listed", "carried", "review"]);

// ===========================================================================
// THE ROOM'S OWN ATTENDANCE (spec 3.8)
// ===========================================================================

/**
 * Tick (or untick) one detention "Not here".
 *
 * WHY IT MATTERS. Once "Attendance done" is pressed for the day, exactly the
 * rows ticked Not here carry to the next list -- an unticked row was served,
 * whatever PowerSchool says -- and a student at school who did not come
 * carries like an absent one (owner, 10/8). The reader decides the carries
 * from these marks at its after-school read (or the next morning's read of
 * this date), and keeps deciding until the next list claims them.
 *
 * OPEN from Lunch & Power-Up start on the list's day until the next list is
 * made. After that the carries are on paper, and a tick is refused.
 */
export const markRoom = mutation({
  args: { unitId: v.id("reflectionUnits"), notHere: v.boolean() },
  handler: async (ctx, { unitId, notHere }) => {
    const staff = await requireStaff(ctx);
    const { tz, nowIso, today } = await schoolNow(ctx);
    if (!canReadReflection(staff, today)) return { ok: false as const, reason: READ_REFUSED };
    if (!tz) return { ok: false as const, reason: "No school time zone is set in Settings > Bell Schedule." };
    const u = await ctx.db.get(unitId);
    if (!u || !u.serveDay || !ON_LIST.has(u.state)) {
      return { ok: false as const, reason: "That detention is not on a list the room is taking attendance for." };
    }
    const { w } = await roomStateOf(ctx, u.serveDay, nowIso, tz);
    if (!w.tick) return { ok: false as const, reason: w.why ?? "Room attendance is closed for that day." };
    if (!!u.roomNotHere === notHere) return { ok: true as const, already: true, notHere };
    await ctx.db.patch(u._id, { roomNotHere: notHere ? true : undefined, roomMarkedBy: staff.email, roomMarkedAt: nowIso });
    await audit(ctx, { byEmail: staff.email, action: notHere ? "room-not-here" : "room-here", day: u.serveDay, unitId: u._id });
    return { ok: true as const, already: false, notHere };
  },
});

/**
 * "Attendance done": the room took attendance for day D (or, with
 * done: false, a press made by mistake is taken back). From then on only the
 * rows ticked Not here carry. Same window as the ticks.
 */
export const roomAttendanceDone = mutation({
  args: { day: v.string(), done: v.optional(v.boolean()) },
  handler: async (ctx, { day, done }) => {
    const staff = await requireStaff(ctx);
    const { tz, nowIso, today } = await schoolNow(ctx);
    if (!canReadReflection(staff, today)) return { ok: false as const, reason: READ_REFUSED };
    if (!tz) return { ok: false as const, reason: "No school time zone is set in Settings > Bell Schedule." };
    if (!DAY_KEY.test(day)) return { ok: false as const, reason: `Not a day: "${day}".` };
    const { row, w } = await roomStateOf(ctx, day, nowIso, tz);
    if (!w.tick || !row) return { ok: false as const, reason: w.why ?? "Room attendance is closed for that day." };
    const want = done !== false;
    if (!!row.roomAttendanceDoneAt === want) return { ok: true as const, already: true, done: want };
    await ctx.db.patch(row._id, want
      ? { roomAttendanceDoneAt: nowIso, roomAttendanceDoneBy: staff.email, updatedAt: nowIso }
      : { roomAttendanceDoneAt: undefined, roomAttendanceDoneBy: undefined, updatedAt: nowIso });
    await audit(ctx, { byEmail: staff.email, action: want ? "room-attendance-done" : "room-attendance-undone", day });
    return { ok: true as const, already: false, done: want };
  },
});

/**
 * "Room did not run today" (the roles only), with a reason: every detention
 * on D's list carries, tagged "room closed", and the carry does NOT count
 * toward the carry limit -- the students did nothing wrong. done: false takes
 * a mistaken press back. Open from D's list being made until the next list.
 */
export const roomDidNotRun = mutation({
  args: { day: v.string(), reason: v.optional(v.string()), undo: v.optional(v.boolean()) },
  handler: async (ctx, { day, reason, undo }) => {
    const staff = await requireStaff(ctx);
    if (!canAdminReflection(staff)) return { ok: false as const, reason: ADMIN_REFUSED };
    const { tz, nowIso } = await schoolNow(ctx);
    if (!tz) return { ok: false as const, reason: "No school time zone is set in Settings > Bell Schedule." };
    if (!DAY_KEY.test(day)) return { ok: false as const, reason: `Not a day: "${day}".` };
    const { row, w } = await roomStateOf(ctx, day, nowIso, tz);
    if (!w.closeRoom || !row) return { ok: false as const, reason: w.why ?? "That day's list cannot be changed now." };
    if (undo === true) {
      if (!row.roomClosed) return { ok: true as const, already: true, closed: false };
      await ctx.db.patch(row._id, { roomClosed: undefined, updatedAt: nowIso });
      await audit(ctx, { byEmail: staff.email, action: "room-did-run", day, reason: "Room did not run: taken back" });
      return { ok: true as const, already: false, closed: false };
    }
    const why = String(reason ?? "").trim().slice(0, 300);
    if (!why) return { ok: false as const, reason: "Say why the room did not run (for example: supervisor out, assembly)." };
    if (row.roomClosed) return { ok: true as const, already: true, closed: true };
    await ctx.db.patch(row._id, { roomClosed: { by: staff.email, at: nowIso, reason: why }, updatedAt: nowIso });
    await audit(ctx, { byEmail: staff.email, action: "room-did-not-run", day, reason: why });
    return { ok: true as const, already: false, closed: true };
  },
});

// ===========================================================================
// THE ADMIN REVIEW QUEUE (spec 3.9, step 7b)
// ===========================================================================

/**
 * The queue for the resolve screen (the roles only): very late entries,
 * collisions, carries that hit the limit or could not be decided, and days
 * whose room attendance was not recorded -- each with its age in SCHOOL days,
 * because the control is "nothing older than 2 school days". Student numbers
 * only; the screen adds names from the records it already holds.
 */
export const reviewQueue = query({
  args: {},
  handler: async (ctx) => {
    const staff = await requireStaff(ctx);
    if (!canAdminReflection(staff)) return { allowed: false as const, reason: ADMIN_REFUSED };
    const { tz, today } = await schoolNow(ctx);
    const items = await reviewItems(ctx, today, tz);
    return {
      allowed: true as const, today, count: items.length, oldest: items[0]?.date ?? null,
      overdue: items.filter((i) => i.ageSchoolDays > 2).length, items,
    };
  },
});

/**
 * One review decision (the roles only):
 *   - "add": put it on the NEXT list. A very late or colliding tardy becomes
 *     countable and the next freeze claims it; a detention that could not
 *     carry (the limit, left school, attendance unknown, Power-Up did not
 *     meet) carries now, tagged as added by review, without counting toward
 *     the limit -- a person decided it;
 *   - "dismiss": close it, never listed. A REASON IS REQUIRED.
 * A day-level item ("room attendance not recorded") can only be dismissed:
 * there is nothing to add.
 *
 * Written on the item itself (resolvedBy, resolvedAt, resolution,
 * resolutionReason) and in reflectionAudit. The reader respects the decision:
 * a resolved tardy is not sent back to review by a collision, nor re-judged
 * as an arrival; a resolved detention's carry is not re-decided.
 */
export const resolveReview = mutation({
  args: {
    kind: v.union(v.literal("tardy"), v.literal("detention"), v.literal("day")),
    id: v.string(),
    action: v.union(v.literal("add"), v.literal("dismiss")),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const staff = await requireStaff(ctx);
    if (!canAdminReflection(staff)) return { ok: false as const, reason: ADMIN_REFUSED };
    const now = new Date().toISOString();
    const why = String(a.reason ?? "").trim().slice(0, 300);
    if (a.action === "dismiss" && !why) return { ok: false as const, reason: "Give a reason for dismissing it." };
    const done = (resolution: string) => ({ resolvedBy: staff.email, resolvedAt: now, resolution, resolutionReason: why || undefined });

    if (a.kind === "tardy") {
      const t = await ctx.db.get(a.id as Id<"reflectionTardies">);
      if (!t || t.state !== "review" || t.resolvedAt) return { ok: false as const, reason: "That item is no longer waiting in review." };
      if (a.action === "add") {
        await ctx.db.patch(t._id, {
          state: "countable", reason: undefined, unitId: undefined, firstCountableAt: t.firstCountableAt ?? now, ...done("added"),
        });
      } else {
        await ctx.db.patch(t._id, done("dismissed"));
      }
      await audit(ctx, { byEmail: staff.email, action: `review-${a.action}`, day: t.attDate, tardyId: t._id, reason: why || t.reason });
      return { ok: true as const, resolution: a.action === "add" ? "added" : "dismissed" };
    }

    if (a.kind === "detention") {
      const u = await ctx.db.get(a.id as Id<"reflectionUnits">);
      if (!u || u.state !== "review" || u.resolvedAt) return { ok: false as const, reason: "That item is no longer waiting in review." };
      if (a.action === "add") {
        const from = u.serveDay ? dayLabel(u.serveDay) : "review";
        const fresh = carriedUnit(unitItemOf(u), {
          verdict: "carry", basis: "room", tag: `Added to the next list by review (from ${from})`, countsTowardLimit: false,
        }, now);
        const carryId = await ctx.db.insert("reflectionUnits", {
          studentNumber: u.studentNumber, division: u.division, kind: "carry",
          tardyIds: u.tardyIds, uniformIds: u.uniformIds, lines: fresh.lines ?? u.lines,
          recordedAt: now, state: "pending", mode: u.mode,
          carryFromUnitId: u._id, carriedFromDay: u.serveDay, carryCount: fresh.carryCount, carryBasis: "review",
          tags: fresh.tags ?? [],
        });
        await ctx.db.patch(u._id, { state: "carried", carriedToUnitId: carryId, carryBasis: "review", carryDecidedAt: now, ...done("added") });
      } else {
        await ctx.db.patch(u._id, done("dismissed"));
      }
      await audit(ctx, { byEmail: staff.email, action: `review-${a.action}`, day: u.serveDay, unitId: u._id, reason: why || u.reviewReason });
      return { ok: true as const, resolution: a.action === "add" ? "added" : "dismissed" };
    }

    // A day-level item.
    if (a.action !== "dismiss") return { ok: false as const, reason: "A day's item can only be dismissed, with a reason." };
    const d = await ctx.db.get(a.id as Id<"reflectionDays">);
    if (!d || !d.fallbackReview || d.fallbackReview.resolvedAt) return { ok: false as const, reason: "That item is no longer waiting in review." };
    await ctx.db.patch(d._id, {
      fallbackReview: { ...d.fallbackReview, resolvedBy: staff.email, resolvedAt: now, resolutionReason: why },
      updatedAt: now,
    });
    await audit(ctx, { byEmail: staff.email, action: "review-dismiss", day: d.date, reason: why });
    return { ok: true as const, resolution: "dismissed" };
  },
});

// ===========================================================================
// THE ADMIN BUTTONS (spec 4.2)
// ===========================================================================

/**
 * "This is a school day" (the roles only): evidence for TODAY when
 * PowerSchool cannot give it (for example, it has been unreadable all
 * morning). Pressed before the latest time on a day whose list is not made,
 * it lets the fallback make the list at the next tick; pressed later, it
 * changes only the record. Never on a weekend or a day marked no school --
 * those are changed in Settings > Bell Schedule.
 */
export const markSchoolDay = mutation({
  args: {},
  handler: async (ctx) => {
    const staff = await requireStaff(ctx);
    if (!canAdminReflection(staff)) return { ok: false as const, reason: ADMIN_REFUSED };
    const { tz, nowIso, today } = await schoolNow(ctx);
    if (!tz) return { ok: false as const, reason: "No school time zone is set in Settings > Bell Schedule." };
    const marked = await markedOf(ctx, today);
    const sd = schoolDayVerdict({ date: today, marked });
    if (sd.basis === "no-school" || sd.basis === "weekend") {
      return { ok: false as const, reason: `${sd.reason} Change it in Settings > Bell Schedule if school is in session.` };
    }
    const row = await ensureDay(ctx, today, nowIso);
    if (row.adminMarkedSchoolDay) return { ok: true as const, already: true, note: null };
    const settings = await loadSettings(ctx);
    const kind = (row.kind as ScheduleKind | undefined)
      ?? scheduleKindFor({ date: today, marked, scheduleKinds: settings.scheduleKinds, rowCounts: row.rowCounts ?? null }).kind;
    const t = dayTimes(today, kind, settings, tz);
    await ctx.db.patch(row._id, {
      adminMarkedSchoolDay: true, schoolDayMarkedBy: staff.email,
      schoolDay: true, schoolDayBasis: "admin", schoolDayReason: "An admin pressed This is a school day.", updatedAt: nowIso,
    });
    await audit(ctx, { byEmail: staff.email, action: "mark-school-day", day: today });
    const late = t.ok && Date.parse(nowIso) >= t.lastFreezeMs;
    return {
      ok: true as const, already: false,
      note: row.frozenAt || row.noList || late
        ? "Recorded. Today's list can no longer be made, so this changes only the record."
        : "Recorded. If no PowerSchool read makes today's list, it will be made at the ready time without one.",
    };
  },
});

/**
 * "Read PowerSchool now" (the roles only). It respects the lease -- never
 * two readers -- and runs at most once every 2 minutes, whoever presses it.
 * Which read it is depends on the clock (reflectionRules.readNowIntent):
 * before the close a routine read; from the close until ready - 4 minutes a
 * CLOSING read, which makes the list; after that an after-close read, which
 * may make the list only inside the late window and never after the latest
 * time (the reader checks again before it freezes).
 */
export const readNow = mutation({
  args: {},
  handler: async (ctx) => {
    const staff = await requireStaff(ctx);
    if (!canAdminReflection(staff)) return { ok: false as const, reason: ADMIN_REFUSED };
    const settings = await loadSettings(ctx);
    if (settings.modeByDivision.ms === "off" && settings.modeByDivision.hs === "off") {
      return { ok: false as const, reason: "The Reflection Room list is switched off for both divisions." };
    }
    const { tz, nowIso, today } = await schoolNow(ctx);
    if (!tz) return { ok: false as const, reason: "No school time zone is set in Settings > Bell Schedule." };
    const row = await getDay(ctx, today);
    const marked = await markedOf(ctx, today);
    const st = dayStateOf(today, row, marked);
    const sd = schoolDayVerdict({ date: today, marked });
    if (sd.basis === "no-school" || sd.basis === "weekend") return { ok: false as const, reason: `${sd.reason} There is nothing to read.` };
    const now = Date.parse(nowIso);
    const lease = await getLease(ctx);
    if (lease && Date.parse(lease.expiresAt) > now) {
      return { ok: false as const, reason: `A PowerSchool read is already running (since ${clockText(lease.startedAt, tz, true)}). Try again in a minute.` };
    }
    const last = await readState(ctx, READ_NOW_KEY);
    if (last && typeof last.at === "string" && now - Date.parse(last.at) < READ_NOW_GAP_MS) {
      return {
        ok: false as const,
        reason: `Read PowerSchool now runs at most once every 2 minutes. Try again at ${clockText(new Date(Date.parse(last.at) + READ_NOW_GAP_MS).toISOString(), tz, true)}.`,
      };
    }
    const intent = readNowIntent({ nowIso, day: st, settings, tz });
    const minute = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(now));
    const key = intent.kind === "closing" ? "closing" : intent.kind === "late-closing" ? "late-closing" : `manual@${minute}`;
    const lookback = intent.freeze !== null;
    await startRead(ctx, {
      key, kind: intent.kind, date: today, nowIso, leaseUntil: new Date(now + LEASE_MS).toISOString(), freeze: intent.freeze,
      reads: { maps: false, roster: false, today: true, lookback, sweep: false, final: false },
    });
    await writeState(ctx, READ_NOW_KEY, { at: nowIso, by: staff.email, kind: intent.kind });
    await audit(ctx, { byEmail: staff.email, action: "read-now", day: today, reason: intent.kind });
    return { ok: true as const, kind: intent.kind, makesList: intent.freeze !== null };
  },
});

// ===========================================================================
// THE HEALTH CARD (Settings > Integrations, beside the attendance rebuild)
// ===========================================================================

/**
 * The list's health at a glance, for the roles: today's state, the last good
 * read and any error, whether a read is running, the review queue's size and
 * age, holds, what is waiting for the next list, the roster snapshot and the
 * term, the last sync's roster guard, the uniform log's day disagreements,
 * and the last school days' lists. COUNTS, TIMES AND REASONS ONLY: no student
 * is named.
 */
export const health = query({
  args: {},
  handler: async (ctx) => {
    const staff = await requireStaff(ctx);
    if (!canAdminReflection(staff)) return { allowed: false as const, reason: ADMIN_REFUSED };
    const settings = await loadSettings(ctx);
    const { tz, nowIso, today } = await schoolNow(ctx);
    const clock = (iso: string | null | undefined) => (iso && tz ? clockText(iso, tz, true) : null);
    const row = await getDay(ctx, today);
    const lease = await getLease(ctx);
    const items = await reviewItems(ctx, today, tz);
    const held = await ctx.db.query("reflectionTardies").withIndex("by_state_attDate", (q) => q.eq("state", "held")).collect();
    const waiting = await ctx.db.query("reflectionTardies")
      .withIndex("by_unit", (q) => q.eq("unitId", undefined).eq("state", "countable").lte("attDate", today)).collect();
    const pending = await ctx.db.query("reflectionUnits").withIndex("by_state", (q) => q.eq("state", "pending")).collect();
    const meta = await readState(ctx, ROSTER_KEY);
    const lastSync = await ctx.db.query("syncRuns").withIndex("by_at").order("desc").first();
    const mismatch = await readState(ctx, "uniform:dayMismatch");
    const recent = (await ctx.db.query("reflectionDays").withIndex("by_date", (q) => q.lte("date", today)).order("desc").take(12))
      .filter((d: Doc<"reflectionDays">) => d.frozenAt || d.noList || d.schoolDay === true);
    return {
      allowed: true as const,
      today,
      asOf: nowIso,
      modes: settings.modeByDivision,
      countFrom: settings.countFromDateByDivision,
      day: row ? {
        schoolDay: row.schoolDay ?? null, schoolDayReason: row.schoolDayReason ?? null, kind: row.kind ?? null,
        close: clock(row.closeInstant), ready: clock(row.readyInstant), lastFreeze: clock(row.lastFreezeInstant),
        readsDone: row.readsDone.length, lastGoodRead: clock(row.lastGoodReadAt), lastReadError: row.lastReadError ?? null,
        lastReadErrorAt: clock(row.lastReadErrorAt),
        made: clock(row.frozenAt), freezeKind: row.freezeKind ?? null, noList: row.noList?.reason ?? null,
        closingReadStarted: clock(row.closingReadStartedAt),
        closingSeconds: row.frozenAt && row.closingReadStartedAt ? Math.round((Date.parse(row.frozenAt) - Date.parse(row.closingReadStartedAt)) / 1000) : null,
        listCount: row.listCount ?? null, heldToday: row.heldCount ?? 0, ptBlankSections: row.ptBlankSections ?? 0,
      } : null,
      readRunning: lease && Date.parse(lease.expiresAt) > Date.parse(nowIso) ? { kind: lease.kind, since: clock(lease.startedAt) } : null,
      review: { count: items.length, oldest: items[0]?.date ?? null, olderThanTwoSchoolDays: items.filter((i) => i.ageSchoolDays > 2).length },
      held: held.length,
      waitingForNextList: { tardies: waiting.length, detentions: pending.length },
      roster: {
        snapDay: meta?.snapDay ?? null, students: meta?.studentCount ?? null, lastRefusal: meta?.lastRefusal?.reason ?? null,
        banners: [rosterAgeBanner(meta, today), termBanner({
          today, termEnd: meta?.termEnd, termName: meta?.termName, snapshotTermId: meta?.termId, currentTermId: process.env.PS_TERM_ID ?? null,
        })].filter(Boolean),
      },
      lastSync: lastSync ? {
        at: clock(lastSync.at), rosterKept: lastSync.summary?.rosterKept === true, rosterKeptReason: lastSync.summary?.rosterKeptReason ?? null,
      } : null,
      uniformDayMismatch: mismatch ? { clientDay: Number(mismatch.clientDay || 0), outOfWindow: Number(mismatch.outOfWindow || 0) } : null,
      recent: recent.map((d: Doc<"reflectionDays">) => ({
        date: d.date, label: dayLabel(d.date), made: clock(d.frozenAt), freezeKind: d.freezeKind ?? null,
        noList: d.noList ? true : false, listCount: d.listCount ?? null,
        closingSeconds: d.frozenAt && d.closingReadStartedAt ? Math.round((Date.parse(d.frozenAt) - Date.parse(d.closingReadStartedAt)) / 1000) : null,
        roomAttendanceDone: !!d.roomAttendanceDoneAt, roomClosed: !!d.roomClosed,
      })),
    };
  },
});
