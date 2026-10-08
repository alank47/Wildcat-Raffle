import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  absentThisMorning, admitState, blankSections, buildCodeBook, carriedUnit, carryVerdict, claimAtFreeze,
  dayTimes, decideTick, decodeRows, divisionOfGrade, fallbackDayReview, freezeBanner, freezeVerdict, idSetHash,
  initialTardyState, LEASE_MS, listsBeforeSeen, nextSchoolDayGuess, noListBanner, provesNoSchool, pullInstant, QUEUED_TAG,
  reclassify, reconcileDate, reflectionSettingsOrDefault, rejoinsReleasedDetention, removalVerdict, rosterAgeBanner,
  rosterSnapshotVerdict, SCHEDULE_KINDS, scheduleKindFor, schoolDayVerdict, studentMap, summarizeDay, tardyCandidates,
  tardyKey, termBanner, unitReleased, wallClock,
  type CarryVerdict, type DayState, type DaySummary, type Division, type Marked, type ReflectionSettings,
  type RosterMeta, type RosterSnap, type ScheduleKind, type TardyItem, type UniformItem, type UnitItem,
} from "./reflectionRules";

/**
 * THE DAILY REFLECTION ROOM LIST: the server side that reads and writes.
 *
 * Every decision is a pure function in reflectionRules.ts; this file only
 * gathers the facts for them and writes what they decide. PowerSchool itself
 * is read by reflectionRead.ts (an action: it needs the network and Node).
 *
 * NOTHING HERE IS REACHABLE FROM A BROWSER. Every function is internal: the
 * cron, the reader and the command line call them. The screen reads through
 * reflectionList.ts, whose every public function checks who is asking first.
 */

/** appState keys. The repo default for the switch is OFF: a missing row is off. */
export const SETTINGS_KEY = "reflection:settings";
export const ROSTER_KEY = "reflection:roster";
/** One reader at a time: {runId, kind, key, date, startedAt, expiresAt}, or null. */
export const LEASE_KEY = "reflection:lease";
/** PowerSchool's attendance codes and its student ids, read by the opening read. */
export const MAPS_KEY = "reflection:maps";

type Ctx = QueryCtx | MutationCtx;

export async function readState(ctx: Ctx, key: string): Promise<any> {
  const row = await ctx.db.query("appState").withIndex("by_key", (q) => q.eq("key", key)).first();
  return row?.value ?? null;
}

export async function writeState(ctx: MutationCtx, key: string, value: any): Promise<void> {
  const row = await ctx.db.query("appState").withIndex("by_key", (q) => q.eq("key", key)).first();
  const at = new Date().toISOString();
  if (row) await ctx.db.patch(row._id, { value, mirroredAt: at });
  else await ctx.db.insert("appState", { key, value, mirroredAt: at });
}

/** The school's time zone, from Settings > Bell Schedule. No zone, no list: the times would be wrong. */
export async function schoolTimeZone(ctx: Ctx): Promise<string | null> {
  const row = await ctx.db.query("bellSettings").withIndex("by_key", (q) => q.eq("key", "bell")).first();
  return row?.timeZone ?? null;
}

const or = <T>(x: T | null | undefined): T | undefined => (x === null ? undefined : x);

// ===========================================================================
// THE ROSTER SNAPSHOT (build spec 4.5)
// ===========================================================================

/**
 * One page of psRoster, only the columns the list needs: no student names.
 * The opening read pages through it from reflectionRead.ts, because the table
 * is bigger than one execution should read.
 */
export const rosterPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<{ rows: any[]; isDone: boolean; continueCursor: string }> => {
    const page = await ctx.db.query("psRoster").withIndex("by_studentNumber").paginate({ numItems: 1000, cursor });
    return {
      rows: page.page.map((r) => ({
        studentNumber: r.studentNumber, gradeLevel: r.gradeLevel ?? null, period: r.period ?? null,
        sectionExpression: r.sectionExpression ?? null, sectionId: r.sectionId ?? null,
        courseName: r.courseName ?? null, courseNumber: r.courseNumber ?? null,
        teacherFirstName: r.teacherFirstName ?? null, teacherLastName: r.teacherLastName ?? null,
        teacherEmail: r.teacherEmail ?? null, termId: r.termId ?? null, syncedAt: r.syncedAt,
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

const snapRow = v.object({
  studentNumber: v.string(),
  grade: v.string(),
  division: v.union(v.literal("ms"), v.literal("hs"), v.null()),
  puSlot: v.union(v.number(), v.null()),
  puSectionId: v.union(v.string(), v.null()),
  puTeacherName: v.union(v.string(), v.null()),
  puTeacherEmail: v.union(v.string(), v.null()),
  puCourse: v.union(v.string(), v.null()),
  puFlag: v.union(v.string(), v.null()),
  puCheck: v.boolean(),
  enrolledSlots: v.array(v.number()),
  sectionBySlot: v.record(v.string(), v.string()),
  teacherBySlot: v.record(v.string(), v.string()),
});

/**
 * Replace the list's roster snapshot -- or refuse, and keep yesterday's.
 *
 * Only a clean, whole roster is taken (reflectionRules.rosterSnapshotVerdict):
 *   - the sync that wrote it FINISHED: syncRuns has a run with that very
 *     syncedAt that did not keep an older roster. A sync records its run only
 *     at the end, so a roster mid-rebuild has no such run;
 *   - every row carries ONE syncedAt (a mixture means a sync was mid-run);
 *   - at least 90% as many students as the last snapshot.
 * Otherwise the old snapshot stays, the refusal is recorded, and the list
 * says "Power-Up teachers from the 10/13 roster" (rosterAgeBanner).
 *
 * THE VERDICT IS TAKEN HERE, in the transaction that writes, so the syncRuns
 * row it trusts and the snapshot it replaces are read at the same moment.
 */
export const writeRosterSnapshot = internalMutation({
  args: {
    rows: v.array(snapRow),
    syncedAts: v.array(v.string()),
    studentCount: v.number(),
    termId: v.optional(v.string()),
    termEnd: v.optional(v.string()),
    termName: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<{ taken: boolean; reason: string; students: number }> => {
    const now = new Date().toISOString();
    const tz = await schoolTimeZone(ctx);
    const lt = tz ? wallClock(now, tz) : null;
    const today = lt && lt.ok ? lt.dateKey : now.slice(0, 10);
    const meta: RosterMeta = (await readState(ctx, ROSTER_KEY)) ?? {};
    const distinct = [...new Set(a.syncedAts.filter(Boolean))].sort();
    // The sync that wrote the NEWEST rows must have finished. (Two syncs that
    // overlap -- the cron and a "Sync now" -- can both finish and still leave
    // a doubled roster; that is the mixed-syncedAt refusal, decided below.)
    const rosterSyncedAt = distinct.length ? distinct[distinct.length - 1] : null;
    const runs = await ctx.db.query("syncRuns").withIndex("by_at").order("desc").take(10);
    const syncOk = !!rosterSyncedAt && runs.some((r) => r.summary?.syncedAt === rosterSyncedAt && r.summary?.rosterKept !== true);
    const verdict = rosterSnapshotVerdict({
      syncOk, syncedAts: distinct, studentCount: a.studentCount, previousCount: meta.studentCount ?? null,
    });
    if (!verdict.take) {
      await writeState(ctx, ROSTER_KEY, { ...meta, lastRefusal: { at: now, reason: verdict.reason } });
      return { taken: false, reason: verdict.reason, students: meta.studentCount ?? 0 };
    }
    const existing = await ctx.db.query("reflectionRoster").withIndex("by_studentNumber").collect();
    const bySn = new Map(existing.map((r) => [r.studentNumber, r]));
    const keep = new Set<string>();
    for (const r of a.rows) {
      keep.add(r.studentNumber);
      const doc = {
        studentNumber: r.studentNumber, grade: r.grade, division: or(r.division),
        puSlot: or(r.puSlot), puSectionId: or(r.puSectionId), puTeacherName: or(r.puTeacherName),
        puTeacherEmail: or(r.puTeacherEmail), puCourse: or(r.puCourse), puFlag: or(r.puFlag), puCheck: r.puCheck,
        enrolledSlots: r.enrolledSlots, sectionBySlot: r.sectionBySlot, teacherBySlot: r.teacherBySlot,
        snapAt: now, rosterSyncedAt: rosterSyncedAt!, termId: a.termId,
      };
      const old = bySn.get(r.studentNumber);
      if (old) await ctx.db.replace(old._id, doc);
      else await ctx.db.insert("reflectionRoster", doc);
    }
    for (const old of existing) if (!keep.has(old.studentNumber)) await ctx.db.delete(old._id);
    await writeState(ctx, ROSTER_KEY, {
      snapAt: now, snapDay: today, rosterSyncedAt, studentCount: a.studentCount,
      termId: a.termId ?? null,
      // A term end that could not be read this morning keeps yesterday's.
      termEnd: a.termEnd ?? meta.termEnd ?? null,
      termName: a.termName ?? meta.termName ?? null,
      lastRefusal: null,
    } satisfies RosterMeta);
    return { taken: true, reason: "", students: a.studentCount };
  },
});

/**
 * The snapshot's age and the term banner, for the command line now and the
 * list screen and admin dashboard later:
 *   npx convex run --prod reflection:rosterStatus '{}'
 * Counts and dates only.
 */
export const rosterStatus = internalQuery({
  args: {},
  handler: async (ctx): Promise<Record<string, any>> => {
    const meta: RosterMeta | null = await readState(ctx, ROSTER_KEY);
    const tz = await schoolTimeZone(ctx);
    const now = new Date().toISOString();
    const lt = tz ? wallClock(now, tz) : null;
    const today = lt && lt.ok ? lt.dateKey : now.slice(0, 10);
    return {
      today,
      snapshot: meta,
      banners: [
        rosterAgeBanner(meta, today),
        termBanner({
          today, termEnd: meta?.termEnd, termName: meta?.termName,
          snapshotTermId: meta?.termId, currentTermId: process.env.PS_TERM_ID ?? null,
        }),
      ].filter(Boolean),
    };
  },
});

// ===========================================================================
// Shared helpers
// ===========================================================================

type LeaseValue = { runId: string; kind: string; key: string; date: string; startedAt: string; expiresAt: string };

export async function getLease(ctx: Ctx): Promise<LeaseValue | null> {
  const value = await readState(ctx, LEASE_KEY);
  return value && typeof value === "object" && typeof value.runId === "string" ? (value as LeaseValue) : null;
}

export async function loadSettings(ctx: Ctx): Promise<ReflectionSettings> {
  return reflectionSettingsOrDefault(await readState(ctx, SETTINGS_KEY));
}

export async function getDay(ctx: Ctx, date: string): Promise<Doc<"reflectionDays"> | null> {
  return ctx.db.query("reflectionDays").withIndex("by_date", (q) => q.eq("date", date)).first();
}

export async function ensureDay(ctx: MutationCtx, date: string, now: string): Promise<Doc<"reflectionDays">> {
  const row = await getDay(ctx, date);
  if (row) return row;
  const id = await ctx.db.insert("reflectionDays", { date, readsDone: [], updatedAt: now });
  return (await ctx.db.get(id))!;
}

/** What Settings > Bell Schedule says about a date: a schedule, no school, or nothing. */
export async function markedOf(ctx: Ctx, date: string): Promise<Marked> {
  const m = await ctx.db.query("bellScheduleDays").withIndex("by_date", (q) => q.eq("date", date)).first();
  if (!m) return null;
  const schedule = m.scheduleId ? await ctx.db.get(m.scheduleId) : null;
  return { scheduleId: m.scheduleId ? String(m.scheduleId) : null, scheduleName: schedule?.name ?? null, noSchool: m.noSchool };
}

export function dayStateOf(date: string, row: Doc<"reflectionDays"> | null, marked: Marked): DayState {
  return {
    date,
    marked,
    rowCounts: row?.rowCounts ?? null,
    adminMarkedSchoolDay: !!row?.adminMarkedSchoolDay,
    readsDone: row?.readsDone ?? [],
    lastGoodReadAt: row?.lastGoodReadAt ?? null,
    lastReadError: row?.lastReadError ?? null,
    frozenAt: row?.frozenAt ?? null,
    freezeKind: row?.freezeKind ?? null,
    noList: row?.noList ?? null,
    closingReadStartedAt: row?.closingReadStartedAt ?? null,
    modeByDivision: row?.modeByDivision,
  };
}

const rosterSnapOf = (r: Doc<"reflectionRoster">): RosterSnap => ({
  studentNumber: r.studentNumber, grade: r.grade, division: r.division ?? null,
  puSlot: r.puSlot ?? null, puSectionId: r.puSectionId ?? null, puTeacherName: r.puTeacherName ?? null,
  puTeacherEmail: r.puTeacherEmail ?? null, puCourse: r.puCourse ?? null, puFlag: r.puFlag ?? null,
  puCheck: r.puCheck, enrolledSlots: r.enrolledSlots, sectionBySlot: r.sectionBySlot, teacherBySlot: r.teacherBySlot,
});

export async function loadRoster(ctx: Ctx): Promise<Record<string, RosterSnap>> {
  const rows = await ctx.db.query("reflectionRoster").withIndex("by_studentNumber").collect();
  return Object.fromEntries(rows.map((r) => [r.studentNumber, rosterSnapOf(r)]));
}

export const tardyItemOf = (t: Doc<"reflectionTardies">): TardyItem => ({
  id: t._id, studentNumber: t.studentNumber, attDate: t.attDate, periodId: t.periodId, slot: t.slot,
  psRowIds: t.psRowIds, state: t.state, reason: t.reason ?? null, unitId: t.unitId ?? null,
  firstSeenAt: t.firstSeenAt, firstCountableAt: t.firstCountableAt ?? null, wasHeld: !!t.wasHeld,
  heldReleasedAt: t.heldReleasedAt ?? null, classTeacher: t.classTeacher ?? null,
});

export const uniformItemOf = (u: Doc<"uniformViolations">): UniformItem => ({
  id: u._id, studentNumber: u.studentNumber, day: u.day, at: u.at, voided: !!u.voidedAt,
  unitId: u.unitId ?? null, reflectionState: u.reflectionState ?? null, loaner: u.loanerProvided,
  savedAt: u.savedAt ?? null, observedAt: u.observedAt ? new Date(u.observedAt).toISOString() : null,
  recordedAt: u.recordedAt ?? null,
});

export const unitItemOf = (u: Doc<"reflectionUnits">): UnitItem => ({
  id: u._id, studentNumber: u.studentNumber, division: u.division, kind: u.kind, state: u.state,
  serveDay: u.serveDay ?? null, recordedAt: u.recordedAt, carryCount: u.carryCount, tags: u.tags, lines: u.lines,
  mode: u.mode, carriedFromDay: u.carriedFromDay ?? null, originAt: u.originAt ?? null,
});

export function puSnapshotOf(snap: RosterSnap | null): Doc<"reflectionUnits">["puSnapshot"] {
  if (!snap) return undefined;
  return {
    slot: or(snap.puSlot), sectionId: or(snap.puSectionId), teacherName: or(snap.puTeacherName),
    teacherEmail: or(snap.puTeacherEmail), course: or(snap.puCourse), flag: or(snap.puFlag), check: snap.puCheck,
  };
}

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/** Append-only record of a human act (or a command-line one). Never appAuditLog: every browser downloads that. */
export async function audit(ctx: MutationCtx, row: {
  byEmail: string; action: string; day?: string; unitId?: Id<"reflectionUnits">; tardyId?: Id<"reflectionTardies">; reason?: string;
}): Promise<void> {
  await ctx.db.insert("reflectionAudit", { at: new Date().toISOString(), ...row });
}

// ===========================================================================
// THE FREEZE (build spec 3.6): making D's list
// ===========================================================================

/**
 * EVERYTHING A FREEZE OF ANY DATE UP TO `upTo` COULD CLAIM, as of this
 * moment: countable tardies on no list yet dated on or before it, live
 * uniform entries on no list yet, and pending detentions (carries and queued
 * second detentions), with the day rows their tags are read from and each
 * student's division. reflectionRules.claimAtFreeze picks from these.
 *
 * ONE READ FOR THE FREEZE AND FOR THE SCREEN. The list screen's "so far"
 * views (reflectionList.ts) run exactly this and exactly claimAtFreeze, read
 * only, so what the screen says the list will be and what the freeze then
 * makes cannot drift apart.
 */
export async function claimInputs(ctx: Ctx, f: {
  upTo: string; roster?: Record<string, RosterSnap>; gradeOf: Record<string, string>;
}): Promise<{
  tardies: Doc<"reflectionTardies">[]; uniforms: Doc<"uniformViolations">[]; pending: Doc<"reflectionUnits">[];
  days: Record<string, DayState>; divisionOf: Record<string, Division | null>; roster: Record<string, RosterSnap>;
}> {
  const tardies = await ctx.db.query("reflectionTardies")
    .withIndex("by_unit", (q) => q.eq("unitId", undefined).eq("state", "countable").lte("attDate", f.upTo)).collect();
  const uniforms = await ctx.db.query("uniformViolations")
    .withIndex("by_unit", (q) => q.eq("unitId", undefined).lte("day", f.upTo)).collect();
  const pending = await ctx.db.query("reflectionUnits").withIndex("by_state", (q) => q.eq("state", "pending")).collect();
  // The freeze has the whole snapshot in hand already; the screen looks up
  // only the students it is about to show.
  const roster = f.roster ?? await rosterFor(ctx, [...tardies, ...uniforms, ...pending].map((x) => x.studentNumber));

  const days: Record<string, DayState> = {};
  for (const d of new Set([...tardies.map((t) => t.attDate), ...uniforms.map((u) => u.day)])) {
    const row = await getDay(ctx, d);
    if (row) days[d] = dayStateOf(d, row, null);
  }
  const divisionOf: Record<string, Division | null> = {};
  for (const t of tardies) {
    divisionOf[t.studentNumber] = t.division ?? roster[t.studentNumber]?.division ?? divisionOfGrade(f.gradeOf[t.studentNumber]);
  }
  for (const u of uniforms) {
    divisionOf[u.studentNumber] ??= roster[u.studentNumber]?.division ?? divisionOfGrade(u.studentGrade);
  }
  return { tardies, uniforms, pending, days, divisionOf, roster };
}

/** The snapshot rows of just these students, one index lookup each. */
export async function rosterFor(ctx: Ctx, studentNumbers: string[]): Promise<Record<string, RosterSnap>> {
  const out: Record<string, RosterSnap> = {};
  for (const sn of [...new Set(studentNumbers)]) {
    const r = await ctx.db.query("reflectionRoster").withIndex("by_studentNumber", (q) => q.eq("studentNumber", sn)).first();
    if (r) out[sn] = rosterSnapOf(r);
  }
  return out;
}

/**
 * MAKE D'S LIST, inside the transaction that calls this (the closing read's
 * applyRead, or the tick's fallback).
 *
 * It claims, as of this moment, everything countable and on no list yet:
 * tardies dated on or before D (P5 and P6 of D excepted: they happen after
 * the list), live uniform entries dated on or before D, and pending carries
 * and queued detentions. reflectionRules.claimAtFreeze decides the rows; this
 * writes them. Convex runs this transaction serializably, so a uniform entry
 * saved at the same moment lands either before it (on this list) or after it
 * (on the next), never on neither and never on both.
 *
 * The Power-Up class is COPIED onto each detention now, so a past list still
 * names the right teacher after the semester changes.
 */
async function freezeDay(ctx: MutationCtx, f: {
  date: string; kind: "closing" | "fallback" | "late"; nowIso: string; closingReadStartedAt: string | null;
  settings: ReflectionSettings; tz: string; roster: Record<string, RosterSnap>; summary: DaySummary | null;
  gradeOf: Record<string, string>;
}): Promise<{ rows: number; ms: number; hs: number; unplaced: number }> {
  const { date, nowIso } = f;
  const { tardies, uniforms, pending, days, divisionOf } = await claimInputs(ctx, { upTo: date, roster: f.roster, gradeOf: f.gradeOf });
  const claim = claimAtFreeze({
    day: date, tz: f.tz, settings: f.settings, divisionOf,
    tardies: tardies.map(tardyItemOf), uniforms: uniforms.map(uniformItemOf), units: pending.map(unitItemOf), days,
  });

  let ms = 0, hs = 0;
  for (const row of claim.rows) {
    const snap = f.roster[row.studentNumber] ?? null;
    const shown = {
      puSnapshot: puSnapshotOf(snap),
      absentMorning: f.summary ? absentThisMorning(f.summary, row.studentNumber, snap) : undefined,
      listedAt: nowIso,
      owes: row.owes > 1 ? row.owes : undefined,
    };
    if (row.newUnit) {
      const serves = row.serve === "new";
      const id = await ctx.db.insert("reflectionUnits", {
        studentNumber: row.studentNumber,
        division: row.division,
        kind: serves ? "new" : "queued",
        tardyIds: row.newUnit.tardyIds as Id<"reflectionTardies">[],
        uniformIds: row.newUnit.uniformIds as Id<"uniformViolations">[],
        lines: row.newUnit.lines,
        recordedAt: nowIso,
        state: serves ? "listed" : "pending",
        serveDay: serves ? date : undefined,
        mode: row.mode === "live" ? "live" : "shadow",
        carryCount: 0,
        // A second detention owed on this list waits for the next one.
        tags: serves ? row.tags : [...row.newUnit.tags, QUEUED_TAG],
        ...(serves ? shown : {}),
      });
      for (const tid of row.newUnit.tardyIds) await ctx.db.patch(tid as Id<"reflectionTardies">, { unitId: id });
      for (const uid of row.newUnit.uniformIds) {
        await ctx.db.patch(uid as Id<"uniformViolations">, { unitId: id, reflectionState: "listed" });
      }
    }
    if (row.serve !== "new") {
      await ctx.db.patch(row.serve as Id<"reflectionUnits">, { state: "listed", serveDay: date, tags: row.tags, ...shown });
    }
    for (const q of row.queued) {
      const u = pending.find((p) => p._id === q);
      if (u && !u.tags.includes(QUEUED_TAG)) await ctx.db.patch(u._id, { tags: [...u.tags, QUEUED_TAG] });
    }
    if (row.division === "ms") ms++;
    else hs++;
  }
  // FROM BEFORE THE START (reflectionRules.beforeStartAtClaim): waiting, but
  // dated before its division started counting, or made under another mode
  // (a pilot carry once the division is live). Never listed; marked, so it
  // stops waiting.
  const parkWhy = "Dated before the list started counting in its current mode";
  for (const id of claim.parked.tardyIds) await ctx.db.patch(id as Id<"reflectionTardies">, { state: "before-start", reason: parkWhy });
  for (const id of claim.parked.uniformIds) await ctx.db.patch(id as Id<"uniformViolations">, { reflectionState: "before-start" });
  for (const id of claim.parked.unitIds) await ctx.db.patch(id as Id<"reflectionUnits">, { state: "before-start", reviewReason: parkWhy });
  const day = await ensureDay(ctx, date, nowIso);
  await ctx.db.patch(day._id, {
    frozenAt: nowIso,
    freezeKind: f.kind,
    closingReadStartedAt: f.closingReadStartedAt ?? undefined,
    modeByDivision: { ...f.settings.modeByDivision },
    listCount: { ms, hs },
    unplacedStudents: claim.unplaced.length,
    updatedAt: nowIso,
  });
  return { rows: claim.rows.length, ms, hs, unplaced: claim.unplaced.length };
}

// ===========================================================================
// THE TICK (build spec 4.2)
// ===========================================================================

/**
 * BOOK A READ, TOGETHER WITH THE LEASE, in the caller's transaction: the tick,
 * and "Read PowerSchool now" (reflectionRoom.readNow). Because the lease is
 * written in the same transaction that schedules the reader, two callers can
 * never start two readers; applyRead writes only for the run that still
 * holds it.
 */
export async function startRead(ctx: MutationCtx, r: {
  key: string; kind: string; date: string; nowIso: string; leaseUntil: string; freeze: "closing" | "late" | null;
  reads: { maps: boolean; roster: boolean; today: boolean; lookback: boolean; sweep: boolean; final: boolean };
}): Promise<string> {
  const runId = `rr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await writeState(ctx, LEASE_KEY, {
    runId, kind: r.kind, key: r.key, date: r.date, startedAt: r.nowIso, expiresAt: r.leaseUntil,
  } satisfies LeaseValue);
  await ensureDay(ctx, r.date, r.nowIso);
  await ctx.scheduler.runAfter(0, internal.reflectionRead.read, {
    runId, key: r.key, kind: r.kind, date: r.date, startedAt: r.nowIso, reads: r.reads, freeze: r.freeze,
  });
  return runId;
}

/**
 * Every 5 minutes, 14:00-23:55 UTC (crons.ts). It never trusts the hour the
 * cron fired at: it turns NOW into the Los Angeles wall clock and asks
 * reflectionRules.decideTick for the one thing to do.
 *
 * SWITCHED OFF FOR BOTH DIVISIONS (the repo default, and what a missing
 * settings row means) it reads that one row and stops: no PowerSchool, no
 * writes.
 *
 * THE LEASE. A read is booked only together with the lease, in this same
 * transaction, so two ticks can never start two readers. The lease lapses
 * after 4 minutes, so a read killed by a deploy blocks the next tick for at
 * most that long. A tick that finds the lease held books itself again 30
 * seconds later, at most 8 times and never past the item's window.
 */
export const tick = internalMutation({
  args: { retry: v.optional(v.number()) },
  handler: async (ctx, { retry }): Promise<{ do: string; why?: string; key?: string }> => {
    const settings = await loadSettings(ctx);
    if (settings.modeByDivision.ms === "off" && settings.modeByDivision.hs === "off") {
      return { do: "none", why: "Switched off for both divisions." };
    }
    const tz = await schoolTimeZone(ctx);
    if (!tz) return { do: "none", why: "No school time zone is set in Settings > Bell Schedule." };
    const nowIso = new Date().toISOString();
    const lt = wallClock(nowIso, tz);
    if (!lt.ok) return { do: "none", why: lt.reason };
    const date = lt.dateKey;
    const row = await getDay(ctx, date);
    const marked = await markedOf(ctx, date);
    const lease = await getLease(ctx);
    const decision = decideTick({ nowIso, tz, day: dayStateOf(date, row, marked), settings, lease, retry });

    if (decision.do === "retry") {
      await ctx.scheduler.runAfter(decision.afterMs, internal.reflection.tick, { retry: (retry ?? 0) + 1 });
      return { do: "retry", why: decision.why };
    }
    if (decision.do === "read") {
      await startRead(ctx, {
        key: decision.key, kind: decision.kind, date, nowIso, reads: decision.reads, freeze: decision.freeze, leaseUntil: decision.leaseUntil,
      });
      return { do: "read", key: decision.key };
    }
    if (decision.do === "fallback-freeze") {
      // THE FENCE. The fallback takes the lease from whatever read last held
      // it (its lease has lapsed, or decideTick would have waited). A
      // straggling closing read that finishes after this finds another runId
      // and writes nothing; what it saw is read again at 13:00 and goes on
      // the next list. Released at once (expiresAt now): the fallback reads
      // nothing, so it must not block the after-close reads.
      await writeState(ctx, LEASE_KEY, {
        runId: `fallback_${Date.now().toString(36)}`, kind: "fallback", key: "fallback", date, startedAt: nowIso, expiresAt: nowIso,
      } satisfies LeaseValue);
      const maps = await readState(ctx, MAPS_KEY);
      const made = await freezeDay(ctx, {
        date, kind: "fallback", nowIso, closingReadStartedAt: null, settings, tz,
        roster: await loadRoster(ctx), summary: null, gradeOf: studentMap(maps?.students).gradeOf,
      });
      return { do: "fallback-freeze", why: `${decision.why} ${made.rows} on the list.` };
    }
    if (decision.do === "latest-freeze") {
      // From 10 minutes before Lunch & Power-Up, nothing may make this list.
      // Every item stays unclaimed and the next school day's freeze takes it,
      // tagged "List not made".
      const day = await ensureDay(ctx, date, nowIso);
      await ctx.db.patch(day._id, {
        noList: { reason: decision.noList.reason, at: nowIso, lastGoodReadAt: decision.noList.lastGoodReadAt ?? undefined },
        updatedAt: nowIso,
      });
      return { do: "latest-freeze", why: decision.noList.reason };
    }
    return { do: "none", why: decision.why };
  },
});

// ===========================================================================
// THE READER'S HALF THAT WRITES (build spec 4.3)
// ===========================================================================

/** What the reader action needs before it reads: settings, maps, which dates are open. Counts and ids only. */
export const readContext = internalQuery({
  args: { date: v.string() },
  handler: async (ctx, { date }): Promise<{
    settings: ReflectionSettings; tz: string | null; maps: any; rosterMeta: RosterMeta | null;
    days: Array<{ date: string; schoolDay: boolean | null; noSchool: boolean; frozenAt: string | null; tHash: string | null }>;
    held: string[]; pending: string[]; carryOpen: string | null;
  }> => {
    const from = addDays(date, -60);
    const rows = await ctx.db.query("reflectionDays").withIndex("by_date", (q) => q.gte("date", from).lt("date", date)).collect();
    const marks = await ctx.db.query("bellScheduleDays").withIndex("by_date", (q) => q.gte("date", from).lt("date", date)).collect();
    const byDate = new Map<string, { date: string; schoolDay: boolean | null; noSchool: boolean; frozenAt: string | null; tHash: string | null }>();
    for (const r of rows) {
      byDate.set(r.date, { date: r.date, schoolDay: r.schoolDay ?? null, noSchool: false, frozenAt: r.frozenAt ?? null, tHash: r.tHashAtFullRead ?? null });
    }
    for (const m of marks) {
      const e = byDate.get(m.date) ?? { date: m.date, schoolDay: null, noSchool: false, frozenAt: null, tHash: null };
      // A date marked no school is never a school day; one marked with a
      // schedule is one even if the reader never ran on it.
      if (m.noSchool) { e.noSchool = true; e.schoolDay = false; }
      else if (m.scheduleId && e.schoolDay === null) e.schoolDay = true;
      byDate.set(m.date, e);
    }
    const held = await ctx.db.query("reflectionTardies")
      .withIndex("by_state_attDate", (q) => q.eq("state", "held").gte("attDate", from).lt("attDate", date)).collect();
    const pending = await ctx.db.query("reflectionTardies")
      .withIndex("by_unit", (q) => q.eq("unitId", undefined).eq("state", "countable").gte("attDate", from).lt("attDate", date)).collect();
    // The newest list before today: a Power-Up mark entered late can still
    // change its carries, so that date is read in full until its carries are
    // claimed by today's list.
    const lastList = rows.filter((r) => r.frozenAt).map((r) => r.date).sort().pop() ?? null;
    let carryOpen: string | null = null;
    if (lastList) {
      const units = await ctx.db.query("reflectionUnits").withIndex("by_serveDay", (q) => q.eq("serveDay", lastList)).collect();
      if (units.some((u) => u.state === "listed" || u.state === "carried" || u.state === "review")) carryOpen = lastList;
    }
    const settings = await loadSettings(ctx);
    // A DIVISION SWITCHED OFF keeps its tardies as they read (admitState),
    // waiting on no list. Their dates earn no full re-read: switching the
    // division on parks everything dated before its countFromDate, which is
    // never before that day, and today is read in full anyway. Counted, they
    // would crowd the three full re-reads a read allows (FULL_REREAD_CAP).
    const counts = (t: Doc<"reflectionTardies">) => !t.division || settings.modeByDivision[t.division] !== "off";
    return {
      settings,
      tz: await schoolTimeZone(ctx),
      maps: await readState(ctx, MAPS_KEY),
      rosterMeta: await readState(ctx, ROSTER_KEY),
      days: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
      held: [...new Set(held.filter(counts).map((t) => t.attDate))].sort(),
      pending: [...new Set(pending.filter(counts).map((t) => t.attDate))].sort(),
      carryOpen,
    };
  },
});

/** The stored tardies of some dates, for the reader's "which rows went missing" pass. No names. */
export const itemsForDates = internalQuery({
  args: { dates: v.array(v.string()) },
  handler: async (ctx, { dates }): Promise<TardyItem[]> => {
    const out: TardyItem[] = [];
    for (const d of [...new Set(dates)]) {
      const rows = await ctx.db.query("reflectionTardies").withIndex("by_attDate", (q) => q.eq("attDate", d)).collect();
      out.push(...rows.map(tardyItemOf));
    }
    return out;
  },
});

/** Why a tardy re-judged into counting is still never listed. */
const BEFORE_START_AGAIN = "Counts now, but is dated before the list started counting";

/** A tardy that is no longer on any list's terms: cleared, and its detention released if nothing is left on it. */
async function clearTardy(ctx: MutationCtx, t: Doc<"reflectionTardies">, reason: string, now: string, touched: Set<Id<"reflectionUnits">>): Promise<boolean> {
  if (t.state === "cleared") return false;
  await ctx.db.patch(t._id, { state: "cleared", reason, clearedAt: now, missingSince: undefined });
  if (t.unitId) touched.add(t.unitId);
  return true;
}

/**
 * Every violation on a detention cleared: the detention is RELEASED ("release
 * this student" on every earlier print). The list record is never rewritten.
 * A carry made from it shares its violations, so it goes too. Exported for
 * uniformViolations.voidEntry: a uniform entry voided after its list was made
 * can leave a detention with nothing on it, and the reader never watches
 * uniform entries.
 */
export async function recheckRelease(ctx: MutationCtx, unitId: Id<"reflectionUnits">, now: string, seen = new Set<string>()): Promise<number> {
  if (seen.has(unitId)) return 0;
  seen.add(unitId);
  const u = await ctx.db.get(unitId);
  if (!u) return 0;
  let n = 0;
  if (u.state !== "released" && u.state !== "expired" && u.state !== "before-start") {
    const tardies = await Promise.all(u.tardyIds.map((id) => ctx.db.get(id)));
    const uniforms = await Promise.all(u.uniformIds.map((id) => ctx.db.get(id)));
    const states = [
      ...tardies.map((t) => ({ cleared: !t || t.state !== "countable" })),
      ...uniforms.map((x) => ({ cleared: !x || !!x.voidedAt })),
    ];
    if (unitReleased(states)) {
      const voided = uniforms.find((x) => x && x.voidedAt);
      // A VOID'S OWN REASON STAYS ON THE UNIFORM ROW (review, 2026-10-08).
      // Whatever an admin typed when voiding ("medical exemption on file")
      // is read there only by the uniform roles; the release reason goes to
      // every viewer of the list, grant holders included, and onto paper
      // ("Release this student: ... -- <reason>"). So it says only what
      // happened, in fixed words.
      const why = tardies.find((t) => t && t.state !== "countable")?.reason
        ?? (voided ? UNIFORM_VOID_RELEASE : "every violation was cleared");
      // The state it was released from is kept, so a tardy that counts again
      // after the room ran can put the detention back as it was
      // (rejoinDetention).
      await ctx.db.patch(u._id, { state: "released", releasedAt: now, releaseReason: why, releasedFromState: u.state });
      n++;
    }
  }
  if (u.carriedToUnitId) n += await recheckRelease(ctx, u.carriedToUnitId, now, seen);
  return n;
}

/** The release reason of a detention whose uniform entry was voided after its list was made. */
export const UNIFORM_VOID_RELEASE = "uniform entry removed after the list was made";

const RESTORABLE = new Set(["pending", "listed", "carried", "review", "queued-forward"]);

/** Put back a detention released at `releasedAt`, and the carry released with it, as each was. */
async function unrelease(ctx: MutationCtx, unitId: Id<"reflectionUnits">, releasedAt: string, seen = new Set<string>()): Promise<void> {
  if (seen.has(unitId)) return;
  seen.add(unitId);
  const u = await ctx.db.get(unitId);
  if (!u || u.state !== "released" || u.releasedAt !== releasedAt) return;
  const was = u.releasedFromState && RESTORABLE.has(u.releasedFromState) ? u.releasedFromState : "listed";
  await ctx.db.patch(u._id, {
    state: was as Doc<"reflectionUnits">["state"], releasedAt: undefined, releaseReason: undefined, releasedFromState: undefined,
  });
  if (u.carriedToUnitId) await unrelease(ctx, u.carriedToUnitId, releasedAt, seen);
}

/**
 * WHAT A TARDY THAT COUNTS AGAIN RIDES ON (review, 2026-10-08). Its own
 * detention, if that still stands. If that detention was RELEASED at or after
 * the student's pull time (reflectionRules.rejoinsReleasedDetention), the
 * room had already run with the student on its list: the detention is put
 * back as it was, and the tardy stays on it -- one PowerSchool mark is never
 * served on two lists. Released before the pull, or with no detention at
 * all: none, and the next list claims it.
 */
async function rejoinDetention(ctx: MutationCtx, unitId: Id<"reflectionUnits"> | undefined, settings: ReflectionSettings, tz: string):
  Promise<"kept" | "restored" | "none"> {
  const u = unitId ? await ctx.db.get(unitId) : null;
  if (!u) return "none";
  if (u.state !== "released") return "kept";
  if (!u.serveDay || !u.releasedAt) return "none";
  // JUDGED BY THE DETENTION THE STUDENT WAS RELEASED FROM (fourth review,
  // 2026-10-08). A tardy points at its first detention, never at the carry
  // a later list claimed; released with it, that carry is the one the
  // student was told not to come to. The last one released at the same
  // moment that is on a list is the one whose pull counts. Judged by the
  // first detention's (always earlier) pull, a carry released before its
  // own pull was put back on its list, and the after-school read called it
  // served.
  let last: Doc<"reflectionUnits"> = u;
  const seen = new Set<string>([u._id]);
  for (let next = u.carriedToUnitId ? await ctx.db.get(u.carriedToUnitId) : null;
    next && !seen.has(next._id) && next.state === "released" && next.releasedAt === u.releasedAt;
    next = next.carriedToUnitId ? await ctx.db.get(next.carriedToUnitId) : null) {
    seen.add(next._id);
    if (next.serveDay) last = next;
  }
  const serveDay = last.serveDay!;
  const dRow = await getDay(ctx, serveDay);
  const kind = (SCHEDULE_KINDS as string[]).includes(String(dRow?.kind)) ? dRow!.kind as ScheduleKind
    : scheduleKindFor({ date: serveDay, marked: await markedOf(ctx, serveDay), scheduleKinds: settings.scheduleKinds, rowCounts: dRow?.rowCounts ?? null }).kind;
  const pullAt = pullInstant(serveDay, kind, last.division, settings, tz);
  if (rejoinsReleasedDetention({ releasedAt: u.releasedAt, pullAt })) {
    await unrelease(ctx, u._id, u.releasedAt);
    return "restored";
  }
  // Released before the pull of its own first list: none, and the next list
  // claims the tardy.
  if (last._id === u._id) return "none";
  // Released before the pull of a LATER list's carry: the detentions before
  // it stand as they were (the room ran with the student on them), and the
  // carry, never served, waits again for the next list -- without that
  // list's row details.
  await unrelease(ctx, u._id, u.releasedAt);
  await ctx.db.patch(last._id, {
    state: "pending", serveDay: undefined, listedAt: undefined, owes: undefined, puSnapshot: undefined, absentMorning: undefined,
    tags: last.tags.filter((tag) => !/^Owes \d+$/.test(tag)),
  });
  return "restored";
}

/** Why a carry decided after its division changed mode waits for nothing. */
const CARRY_OTHER_MODE = "Carried from a list made in another mode (a pilot list); never moves into the new mode";

/**
 * CARRIES for the detentions on date `d`'s list, once d's marks are final
 * (its after-school read, or any later read of it). reflectionRules.carryVerdict
 * decides; this writes. The verdict is recomputed whenever the date is read
 * in full, and STANDS once the next list has claimed the carry: after that a
 * changed input only notes the change.
 */
async function decideCarries(ctx: MutationCtx, c: {
  d: string; summary: DaySummary; roster: Record<string, RosterSnap>; settings: ReflectionSettings;
  now: string; enrolled: (sn: string) => boolean;
}): Promise<{ carried: number; served: number; review: number }> {
  const out = { carried: 0, served: 0, review: 0 };
  const dRow = await getDay(ctx, c.d);
  if (!dRow?.frozenAt) return out;
  const units = await ctx.db.query("reflectionUnits").withIndex("by_serveDay", (q) => q.eq("serveDay", c.d)).collect();
  let decidedByPowerSchool = 0;
  let live = false;
  for (const u of units) {
    if (u.state !== "listed" && u.state !== "carried" && u.state !== "review") continue;
    if (u.resolvedAt) continue;
    if (u.mode === "live") live = true;
    const carry = u.carriedToUnitId ? await ctx.db.get(u.carriedToUnitId) : null;
    const snap = c.roster[u.studentNumber] ?? null;
    // THE ROOM DECIDES ONLY THE DETENTIONS IT RUNS FOR (second review,
    // 2026-10-08). "Attendance done", "Room did not run" and the Not here
    // ticks are pressed once for the day, but no room runs for a division in
    // shadow: its carries are PowerSchool's (spec 3.8 rule 3). In the MS live
    // week, with HS in shadow as the control, the MS room's presses decided
    // every HS carry -- an HS student absent at Power-Up and after it was
    // "served", and Room did not run carried HS students who were in class.
    const roomRuns = u.mode === "live";
    const verdict: CarryVerdict = carryVerdict({
      unit: { carryCount: u.carryCount }, studentNumber: u.studentNumber, division: u.division, serveDay: c.d,
      room: roomRuns ? { closed: !!dRow.roomClosed, attendanceDone: !!dRow.roomAttendanceDoneAt, notHere: !!u.roomNotHere } : {},
      final: true, summary: c.summary, snap, enrolled: c.enrolled(u.studentNumber), maxCarries: c.settings.maxCarries,
    });
    if (verdict.verdict === "undecided") continue;
    // The day's review says the ROOM recorded nothing: only its own detentions count.
    if (roomRuns && (verdict.verdict === "carry" || verdict.verdict === "served") && (verdict.basis === "powerschool" || verdict.basis === "whole-day")) {
      decidedByPowerSchool++;
    }
    const puMarks = snap?.puSlot ? c.summary.marks[u.studentNumber]?.[String(snap.puSlot)] ?? [] : [];
    const puAbsent = puMarks.length > 0 && puMarks.every((m) => m.absent);
    // Claimed by a later list: it stands.
    if (carry && carry.state !== "pending" && carry.state !== "expired") {
      if (verdict.verdict !== "carry") await ctx.db.patch(u._id, { carryInputsChangedAt: c.now, puAbsent });
      continue;
    }
    if (verdict.verdict === "carry") {
      let carryId = carry && carry.state === "pending" ? carry._id : null;
      // A PILOT DETENTION NEVER CARRIES INTO LIVE (spec 3.9; review,
      // 2026-10-08). Decided after the division changed mode -- a Friday
      // shadow list whose Power-Up absences are entered on Monday, once MS
      // is live -- the carry is recorded, as the pilot's own record, but
      // made before-start: nothing from the pilot is pulled.
      // A DIVISION SWITCHED OFF DECIDES NOTHING HERE EITHER (fourth review,
      // 2026-10-08), as in admitState: decided by the after-school read while
      // the division was rolled back, the carry was made before-start for
      // good, and switching back on counting from that day never brought it
      // back. It waits with its list's mode; switching on (setMode) and the
      // freeze (beforeStartAtClaim) park it if it is from before the start.
      const nowMode = c.settings.modeByDivision[u.division];
      const otherMode = nowMode !== "off" && u.mode !== nowMode;
      // A CARRY WITHDRAWN BY AN EARLIER RE-READ COMES BACK (fourth review,
      // 2026-10-08). A re-read that said "served" expired it; when a later
      // one says "carry" again, a fresh carry lost the "Queued: 2nd
      // detention" an earlier list had put on it -- the list that printed
      // "Owes 2". The withdrawn carry waits again instead, with its tags,
      // recordedAt and originAt.
      const withdrawn = carryId ? null : (await ctx.db.query("reflectionUnits")
        .withIndex("by_student", (q) => q.eq("studentNumber", u.studentNumber)).collect())
        .filter((x) => x.kind === "carry" && x.carryFromUnitId === u._id && x.state === "expired")
        .sort((x, y) => y.recordedAt.localeCompare(x.recordedAt))[0] ?? null;
      const same = carryId ? carry! : withdrawn;
      if (same) {
        const fresh = carriedUnit(unitItemOf(u), verdict, same.recordedAt);
        carryId = same._id;
        await ctx.db.patch(same._id, {
          // The carry tag is decided again; "Queued: 2nd detention", put on
          // by a list that served an older detention first, stays (third
          // review, 2026-10-08: every read re-reads this date while the
          // carry waits, and dropped it).
          tags: [...(fresh.tags ?? []), ...(same.tags.includes(QUEUED_TAG) ? [QUEUED_TAG] : [])],
          carryCount: fresh.carryCount, carryBasis: verdict.basis,
          ...(withdrawn ? { state: "pending" as const, expiredAt: undefined, expireReason: undefined } : {}),
          ...(otherMode ? { state: "before-start" as const, reviewReason: CARRY_OTHER_MODE } : {}),
        });
      } else {
        const fresh = carriedUnit(unitItemOf(u), verdict, c.now);
        carryId = await ctx.db.insert("reflectionUnits", {
          studentNumber: u.studentNumber, division: u.division, kind: "carry",
          tardyIds: u.tardyIds, uniformIds: u.uniformIds, lines: fresh.lines ?? u.lines,
          recordedAt: c.now, originAt: u.originAt ?? u.recordedAt, state: otherMode ? "before-start" : "pending", mode: u.mode,
          ...(otherMode ? { reviewReason: CARRY_OTHER_MODE } : {}),
          carryFromUnitId: u._id, carriedFromDay: c.d, carryCount: fresh.carryCount, carryBasis: verdict.basis,
          tags: fresh.tags ?? [],
        });
      }
      await ctx.db.patch(u._id, {
        state: "carried", carriedToUnitId: carryId, carryBasis: verdict.basis, carryDecidedAt: c.now, puAbsent, reviewReason: undefined,
      });
      out.carried++;
      continue;
    }
    // Served, or for review: a pending carry made earlier is withdrawn.
    if (carry && carry.state === "pending") {
      await ctx.db.patch(carry._id, {
        state: "expired", expiredAt: c.now,
        expireReason: verdict.verdict === "served" ? `No longer carried: ${verdict.why}` : `Sent to review: ${verdict.reason}`,
      });
    }
    if (verdict.verdict === "served") {
      await ctx.db.patch(u._id, {
        state: "listed", carriedToUnitId: undefined, carryBasis: verdict.basis, carryDecidedAt: c.now, puAbsent, reviewReason: undefined,
      });
      out.served++;
    } else {
      await ctx.db.patch(u._id, { state: "review", reviewReason: verdict.reason, carriedToUnitId: undefined, carryDecidedAt: c.now, puAbsent });
      out.review++;
    }
  }
  const fr = fallbackDayReview({
    mode: live ? "live" : "shadow", serveDay: c.d, attendanceDone: !!dRow.roomAttendanceDoneAt,
    roomClosed: !!dRow.roomClosed, decidedByPowerSchool,
  });
  await ctx.db.patch(dRow._id, {
    carriesDecidedAt: c.now,
    // Re-decided on every read of the date; an admin's acknowledgement of the
    // item (reflectionRoom.resolveReview) is kept with it.
    fallbackReview: fr ? { ...(dRow.fallbackReview ?? {}), reason: fr.reason, at: dRow.fallbackReview?.at ?? c.now } : undefined,
    updatedAt: c.now,
  });
  return out;
}

type DirectAnswer = Parameters<typeof removalVerdict>[0]["direct"];
/** The reader's direct id read, as removalVerdict takes it. No read (capped, or a closing read) proves nothing. */
function directAnswer(d: { status: "none" | "row" | "error"; studentNumber?: string; attDate?: string; code?: string; periodId?: number } | undefined): DirectAnswer {
  if (!d) return { status: "error" };
  if (d.status !== "row") return { status: d.status };
  return { status: "row", studentNumber: d.studentNumber ?? "", attDate: d.attDate ?? "", code: d.code ?? "", periodId: d.periodId ?? 0 };
}

const directRow = v.object({
  psRowId: v.string(),
  status: v.union(v.literal("none"), v.literal("row"), v.literal("error")),
  studentNumber: v.optional(v.string()),
  attDate: v.optional(v.string()),
  code: v.optional(v.string()),
  periodId: v.optional(v.number()),
});

/**
 * WHAT ONE READ SAW, WRITTEN -- if this read still holds the lease.
 *
 * THE FENCE FIRST. A read whose lease lapsed and was taken over (by the next
 * tick, or by the fallback freeze) writes nothing at all: the run that holds
 * the lease now is the only one allowed to. Whatever happens below, this
 * run's lease is released.
 *
 * Then, in one transaction:
 *   - a read that did not succeed changes nothing but the day's error;
 *   - today's facts: row counts, school-day evidence, schedule type, times;
 *   - each date read: new tardies (first state decided once: before-start,
 *     review if very late, arrival, held or countable), re-entered and moved
 *     marks, code changes, collisions, and removals -- only with a direct id
 *     read behind them, and never on a closing read; a CONFIRMED FULL read
 *     also re-classifies (arrival / held / countable) and resolves holds;
 *   - detentions whose every violation was cleared are released;
 *   - carries for earlier dates read in full, BEFORE any freeze, so a
 *     closing read never claims a carry its own read has just undone;
 *   - a closing or late-closing read makes the list if freezeVerdict still
 *     says so NOW (the clock moved while it read);
 *   - today's carries, at the after-school read.
 * On a day already made (or with no list) new items simply wait, unclaimed,
 * for the next list.
 */
export const applyRead = internalMutation({
  args: {
    runId: v.string(),
    key: v.string(),
    kind: v.string(),
    date: v.string(),
    startedAt: v.string(),
    freeze: v.union(v.literal("closing"), v.literal("late"), v.null()),
    ok: v.boolean(),
    reason: v.optional(v.string()),
    maps: v.optional(v.object({
      codes: v.array(v.object({ id: v.string(), att_code: v.string(), description: v.string(), presence_status_cd: v.string() })),
      students: v.array(v.string()),
      readAt: v.string(),
      unresolved: v.optional(v.array(v.string())),
    })),
    dates: v.array(v.object({ date: v.string(), full: v.boolean(), rows: v.array(v.string()), unmatched: v.number() })),
    direct: v.array(directRow),
    stats: v.optional(v.any()),
  },
  handler: async (ctx, a): Promise<Record<string, any>> => {
    const lease = await getLease(ctx);
    if (!lease || lease.runId !== a.runId) {
      return {
        applied: false,
        why: "Fenced out: this read no longer holds the lease (it lapsed and another run took over, or the list "
          + "was made without it). Nothing was written; what it saw is read again by the next read.",
      };
    }
    const now = new Date().toISOString();
    await writeState(ctx, LEASE_KEY, null);
    const tz = await schoolTimeZone(ctx);
    const settings = await loadSettings(ctx);
    const today = a.date;
    let day = await ensureDay(ctx, today, now);

    // A READ THAT DID NOT SUCCEED CHANGES NOTHING: no tardy, no list, no
    // removal. An unconfirmed read is exactly the one that could hold a
    // deleted row and miss a real one. The next tick reads again.
    if (!a.ok || !tz) {
      await ctx.db.patch(day._id, { lastReadError: a.reason ?? "No school time zone is set.", lastReadErrorAt: now, updatedAt: now });
      return { applied: true, ok: false, why: a.reason };
    }
    if (a.maps) await writeState(ctx, MAPS_KEY, a.maps);
    const maps = a.maps ?? (await readState(ctx, MAPS_KEY));
    const codes = buildCodeBook(maps?.codes);
    if (!codes.ok) {
      await ctx.db.patch(day._id, { lastReadError: codes.reason, lastReadErrorAt: now, updatedAt: now });
      return { applied: true, ok: false, why: codes.reason };
    }
    const sm = studentMap(maps?.students);
    const enrolledSn = new Set(Object.values(sm.snOf));
    const roster = await loadRoster(ctx);
    const divisionOf = (sn: string): Division | null => roster[sn]?.division ?? divisionOfGrade(sm.gradeOf[sn]);

    const reads = a.dates.map((d) => ({ ...d, rows: decodeRows(d.date, d.rows) }));
    const summaries: Record<string, DaySummary> = {};
    for (const d of reads) if (d.full) summaries[d.date] = summarizeDay(d.date, d.rows, codes, roster);
    const tIds = new Set(codes.tIds);
    const tHashOf = (rows: Array<{ id: string; codeId: string }>) => idSetHash(rows.filter((r) => tIds.has(r.codeId)).map((r) => r.id));

    // ---- 1. Today's facts.
    const marked = await markedOf(ctx, today);
    const todayRead = reads.find((d) => d.date === today && d.full) ?? null;
    const patch: Partial<Doc<"reflectionDays">> = {
      readsDone: [...new Set([...day.readsDone, a.key])],
      lastGoodReadAt: a.startedAt,
      lastReadError: undefined,
      lastReadErrorAt: undefined,
      updatedAt: now,
    };
    if (todayRead) {
      const s = summaries[today];
      Object.assign(patch, {
        rowCounts: s.rowCounts, unmappedRows: s.unmappedRows, refusedPeriodIds: s.unmappedPeriodIds,
        collisions: s.collisions.length, unmatchedMarks: todayRead.unmatched,
        ptBlankSections: blankSections(s, roster, 1).length,
        tHashAtFullRead: tHashOf(todayRead.rows), lastFullReadAt: a.startedAt,
      });
    }
    const st = { ...dayStateOf(today, day, marked), rowCounts: patch.rowCounts ?? day.rowCounts ?? null, lastGoodReadAt: a.startedAt };
    const sd = schoolDayVerdict({
      date: today, marked, rowCounts: st.rowCounts, adminMarked: !!day.adminMarkedSchoolDay, readSucceeded: provesNoSchool(st, tz),
    });
    const kind = scheduleKindFor({ date: today, marked, scheduleKinds: settings.scheduleKinds, rowCounts: st.rowCounts });
    const times = dayTimes(today, kind.kind, settings, tz);
    Object.assign(patch, {
      schoolDay: sd.verdict === "yes" ? true : sd.verdict === "no" ? false : null,
      schoolDayBasis: sd.basis, schoolDayReason: sd.reason,
      kind: kind.kind, kindSource: kind.source, sixPeriodDetected: kind.sixPeriodDetected,
      ...(times.ok ? { closeInstant: times.close, readyInstant: times.ready, lastFreezeInstant: times.lastFreeze } : {}),
    });
    await ctx.db.patch(day._id, patch);

    // ---- 2. Each date read: new tardies, corrections, re-classification.
    const touched = new Set<Id<"reflectionUnits">>();
    const directById = new Map(a.direct.map((d) => [d.psRowId, d]));
    const afterCache = new Map<string, Array<{ date: string; frozenAt?: string | null; modeByDivision?: any }>>();
    const daysAfter = async (attDate: string) => {
      if (!afterCache.has(attDate)) {
        const rows = await ctx.db.query("reflectionDays").withIndex("by_date", (q) => q.gt("date", attDate)).collect();
        afterCache.set(attDate, rows.map((r) => ({ date: r.date, frozenAt: r.frozenAt ?? null, modeByDivision: r.modeByDivision })));
      }
      return afterCache.get(attDate)!;
    };
    const counts = { added: 0, repointed: 0, moved: 0, cleared: 0, reclassified: 0, review: 0, missing: 0 };

    for (const d of reads) {
      const stored = await ctx.db.query("reflectionTardies").withIndex("by_attDate", (q) => q.eq("attDate", d.date)).collect();
      const byId = new Map(stored.map((t) => [t._id as string, t]));
      const handled = new Set<string>();
      const summary = summaries[d.date] ?? null;
      // Marks are final once the date's after-school read has passed.
      const final = d.date < today || a.kind === "after-school";
      const candidates = summary ? tardyCandidates(summary, roster, settings, { final }) : [];
      const rec = reconcileDate({
        date: d.date, candidates, rows: d.rows, codes, items: stored.map(tardyItemOf), confirmed: true, fullRead: d.full, settings,
      });

      for (const c of rec.codeChange) {
        handled.add(c.itemId);
        if (await clearTardy(ctx, byId.get(c.itemId)!, c.reason, now, touched)) counts.cleared++;
      }
      for (const r of rec.repoint) {
        // A cleared tardy entered again is judged afresh below, so it is not
        // marked handled; any other just follows its new PowerSchool id.
        if (byId.get(r.itemId)?.state !== "cleared") handled.add(r.itemId);
        await ctx.db.patch(r.itemId as Id<"reflectionTardies">, { psRowIds: r.psRowIds, lastSeenAt: a.startedAt, missingSince: undefined });
        counts.repointed++;
      }
      for (const m of rec.move) {
        handled.add(m.itemId);
        const t = byId.get(m.itemId)!;
        await ctx.db.patch(t._id, {
          periodId: m.periodId, slot: m.slot, psRowIds: m.psRowIds, lastSeenAt: a.startedAt, missingSince: undefined,
          classTeacher: roster[t.studentNumber]?.teacherBySlot?.[String(m.slot)] ?? undefined,
        });
        counts.moved++;
      }
      for (const col of rec.collisions) {
        const [sn, , pid] = col.key.split("|");
        const existing = stored.find((t) => tardyKey(t.studentNumber, t.attDate, t.periodId) === col.key);
        const reason = "PowerSchool has 2 marks for this period";
        if (existing) {
          handled.add(existing._id);
          // ALREADY ON A LIST (review, 2026-10-08): a second PowerSchool row
          // for a tardy whose detention stands does not take the tardy off
          // it. Sent to review, an "Add to next list" would put the same
          // tardy on a second list. It stays where it is; the collision is
          // noted on it, and counted on the day's banner.
          const onList = existing.unitId ? await ctx.db.get(existing.unitId) : null;
          if (existing.state === "countable" && onList && onList.state !== "released" && onList.state !== "expired") {
            await ctx.db.patch(existing._id, { psRowIds: col.psRowIds, collisionSeenAt: existing.collisionSeenAt ?? a.startedAt });
            continue;
          }
          // An admin's review decision stands: a collision already resolved
          // ("Add to next list") is not sent back to the queue.
          if (existing.state !== "review" && existing.state !== "cleared" && !existing.resolvedAt) {
            await ctx.db.patch(existing._id, { state: "review", reason, psRowIds: col.psRowIds });
            counts.review++;
          }
        } else {
          await ctx.db.insert("reflectionTardies", {
            studentNumber: sn, attDate: d.date, periodId: Number(pid), slot: Number(pid) - 850, psRowIds: col.psRowIds, code: "T",
            division: divisionOf(sn) ?? undefined, state: "review", reason, firstSeenAt: a.startedAt, listsBeforeSeen: 0,
            lastSeenAt: a.startedAt,
          });
          counts.review++;
        }
      }
      for (const c of rec.add) {
        // UPSERT BY KEY. reconcileDate only adds a key it has not stored, so
        // this lookup should find nothing; if it ever does, the mark is
        // re-pointed, never stored twice.
        const same = await ctx.db.query("reflectionTardies")
          .withIndex("by_key", (q) => q.eq("studentNumber", c.studentNumber).eq("attDate", c.attDate).eq("periodId", c.periodId)).first();
        if (same) {
          await ctx.db.patch(same._id, { psRowIds: c.psRowIds, lastSeenAt: a.startedAt });
          continue;
        }
        const division = divisionOf(c.studentNumber);
        const admit = admitState(c.attDate, division, settings);
        const lbs = division
          ? listsBeforeSeen({ attDate: c.attDate, firstSeenAt: a.startedAt, division, days: await daysAfter(c.attDate) })
          : 0;
        const init = initialTardyState({ verdict: c.verdict, admit, listsBeforeSeen: lbs, lateEntryLists: settings.lateEntryLists });
        await ctx.db.insert("reflectionTardies", {
          studentNumber: c.studentNumber, attDate: c.attDate, periodId: c.periodId, slot: c.slot, psRowIds: c.psRowIds,
          code: c.code, division: division ?? undefined, state: init.state,
          reason: init.reason ?? (init.state === "held" ? c.reason : undefined),
          holdReason: init.state === "held" ? c.reason : undefined,
          wasHeld: init.state === "held" ? true : undefined,
          firstSeenAt: a.startedAt, listsBeforeSeen: lbs,
          firstCountableAt: init.state === "countable" ? a.startedAt : undefined,
          lastSeenAt: a.startedAt, classTeacher: c.classTeacher ?? undefined,
        });
        counts.added++;
      }
      for (const m of rec.missing) {
        handled.add(m.itemId);
        const t = byId.get(m.itemId)!;
        if (t.state === "cleared") continue;
        // A MARK THAT DID NOT COME BACK IS NOT YET GONE. Only a direct id read
        // can say it was removed (or changed to another student, date or
        // code); without one -- capped, failed, or a closing read, which never
        // removes -- it is only noted, and the next read asks again.
        const direct = directAnswer(m.psRowIds.map((id) => directById.get(id)).find(Boolean));
        const verdict = removalVerdict({ readKind: a.kind, confirmed: true, keyInRead: false, direct, item: t, settings });
        if (verdict.remove) {
          if (await clearTardy(ctx, t, verdict.reason, now, touched)) counts.cleared++;
        } else if (!t.missingSince) {
          await ctx.db.patch(t._id, { missingSince: a.startedAt });
          counts.missing++;
        }
      }

      // A mark that went missing and is back (same id, same key): no longer missing.
      const present = new Set(d.rows.map((r) => tardyKey(r.studentNumber, r.attDate, r.periodId)));
      for (const t of stored) {
        if (!handled.has(t._id) && t.missingSince && t.state !== "cleared" && present.has(tardyKey(t.studentNumber, t.attDate, t.periodId))) {
          await ctx.db.patch(t._id, { missingSince: undefined, lastSeenAt: a.startedAt });
        }
      }

      // RE-CLASSIFY, from a confirmed FULL read only: an earlier absence
      // entered after the tardy turns a counted tardy into an arrival, and a
      // section's marks arriving releases a hold.
      if (d.full) {
        const candByKey = new Map(candidates.map((c) => [c.key, c]));
        for (const t of stored) {
          if (handled.has(t._id)) continue;
          // Added to a list by an admin's review decision: not re-judged
          // (a code change above still clears it -- that is new evidence).
          if (t.resolvedAt) continue;
          const c = candByKey.get(tardyKey(t.studentNumber, t.attDate, t.periodId));
          if (!c) continue;
          if (t.state === "cleared") {
            // TARDY AGAIN IN POWERSCHOOL (deleted and entered again after the
            // deletion was confirmed, or changed back from D): judged afresh,
            // never lost. It stays on its detention if that still stands, or
            // was released only after the room ran with the student on it
            // (rejoinDetention: never served twice); otherwise it waits for
            // the next list -- unless its date is before its division started
            // counting (admitState), when it is before-start.
            let state: Doc<"reflectionTardies">["state"] = c.verdict === "counted" ? "countable" : c.verdict === "held" ? "held" : "arrival";
            // HELD OR AN ARRIVAL, IT KEEPS ITS DETENTION (second review,
            // 2026-10-08), exactly as the re-classify below does: the
            // detention may still stand on another violation, and if this
            // tardy counts again later, rejoinDetention decides then. Dropped
            // here, it came back unit-less and the next list served it again.
            const rides = state === "countable" ? await rejoinDetention(ctx, t.unitId, settings, tz) : t.unitId ? "kept" : "none";
            if (rides === "none" && (state === "countable" || state === "held") && admitState(t.attDate, t.division ?? divisionOf(t.studentNumber), settings)) {
              state = "before-start";
            }
            await ctx.db.patch(t._id, {
              state, reason: state === "countable" ? undefined : state === "before-start" ? BEFORE_START_AGAIN : c.reason,
              holdReason: state === "held" ? c.reason : undefined,
              // Counting AGAIN, from now: a tag judged by when it counts
              // says it was entered late if its own list is already made.
              clearedAt: undefined, firstCountableAt: state === "countable" ? a.startedAt : t.firstCountableAt,
              lastSeenAt: a.startedAt, ...(rides === "none" ? { unitId: undefined } : {}),
            });
            counts.reclassified++;
            continue;
          }
          const r = reclassify(tardyItemOf(t), { verdict: c.verdict, reason: c.reason, unknownSlots: c.unknownSlots }, { confirmedFull: true });
          if (!r.changed) {
            if (t.state === "held" && t.holdReason !== c.reason) await ctx.db.patch(t._id, { holdReason: c.reason });
            continue;
          }
          const next: Partial<Doc<"reflectionTardies">> = {
            state: r.state, reason: r.reason ?? undefined, lastSeenAt: a.startedAt,
            holdReason: r.state === "held" ? c.reason : undefined,
          };
          if (r.state === "held") next.wasHeld = true;
          // When it began to count (again): an arrival or a hold that counts
          // only after its list was made is tagged as such (tardyTags).
          if (r.state === "countable") next.firstCountableAt = a.startedAt;
          // A hold released: the "Held for attendance" tag's own time.
          if (r.state === "countable" && t.state === "held") next.heldReleasedAt = a.startedAt;
          // Its detention was released while it did not count: back on it if
          // the room had already run with the student on it, otherwise off it
          // and on to the next list (rejoinDetention).
          const rides = r.state === "countable" && t.unitId ? await rejoinDetention(ctx, t.unitId, settings, tz) : t.unitId ? "kept" : "none";
          if (rides === "none") next.unitId = undefined;
          // NOW COUNTABLE, OR HELD, AND WAITING: dated before its division
          // started counting, it is before-start, exactly as if it had been
          // seen like this the first time (review, 2026-10-08: a Friday
          // arrival re-judged on Monday must not reach a list that starts
          // on Monday).
          if (rides === "none" && (r.state === "countable" || r.state === "held")
            && admitState(t.attDate, t.division ?? divisionOf(t.studentNumber), settings)) {
            next.state = "before-start";
            next.reason = BEFORE_START_AGAIN;
            next.holdReason = undefined;
          }
          await ctx.db.patch(t._id, next);
          if (r.afterList && t.unitId) touched.add(t.unitId);
          counts.reclassified++;
        }
        if (d.date !== today) {
          const dRow = await ensureDay(ctx, d.date, now);
          await ctx.db.patch(dRow._id, { tHashAtFullRead: tHashOf(d.rows), lastFullReadAt: a.startedAt, updatedAt: now });
        }
      }
    }

    // ---- 3. Detentions with nothing left on them.
    let released = 0;
    for (const u of touched) released += await recheckRelease(ctx, u, now);

    // ---- 4. Carries for EARLIER dates read in full, BEFORE the freeze
    // (review, 2026-10-08). A Power-Up mark or a room tick for yesterday
    // changes yesterday's carry until today's list claims it. A closing read
    // that saw such a change must decide the carry first, and only then make
    // today's list -- the other way round it claims the stale carry, and the
    // decision after it can only note that the carry "stands".
    const carries = { carried: 0, served: 0, review: 0 };
    const carriesDecided = new Set<string>();
    const decideFor = async (d: { date: string }) => {
      const r = await decideCarries(ctx, {
        d: d.date, summary: summaries[d.date], roster, settings, now,
        enrolled: (sn) => !!roster[sn] || enrolledSn.has(sn),
      });
      carries.carried += r.carried; carries.served += r.served; carries.review += r.review;
      carriesDecided.add(d.date);
    };
    for (const d of reads) {
      if (!d.full || d.date >= today) continue;
      await decideFor(d);
    }

    // ---- 5. The freeze. Re-checked NOW: the read took time, and the list
    // may have been made (fallback), given up (latest freeze), or passed its
    // latest time while it ran.
    let froze: Record<string, any> | null = null;
    if (a.freeze) {
      day = (await ctx.db.get(day._id))!;
      const fv = freezeVerdict({ nowIso: now, startedAt: a.startedAt, intent: a.freeze, day: dayStateOf(today, day, marked), settings, tz });
      froze = fv.freeze
        ? await freezeDay(ctx, {
          date: today, kind: fv.kind, nowIso: now, closingReadStartedAt: a.startedAt, settings, tz, roster,
          summary: summaries[today] ?? null, gradeOf: sm.gradeOf,
        })
        : { why: fv.why };
    }

    // ---- 6. "Absent this morning", for today's detentions (display only).
    if (summaries[today]) {
      const listed = await ctx.db.query("reflectionUnits").withIndex("by_serveDay", (q) => q.eq("serveDay", today)).collect();
      for (const u of listed) {
        const am = absentThisMorning(summaries[today], u.studentNumber, roster[u.studentNumber] ?? null);
        if (u.state === "listed" && u.absentMorning !== am) await ctx.db.patch(u._id, { absentMorning: am });
      }
    }

    // ---- 7. Carries for the rest read in full whose marks are final: today's,
    // at the after-school read.
    for (const d of reads) {
      if (!d.full || carriesDecided.has(d.date) || !(d.date < today || a.kind === "after-school")) continue;
      await decideFor(d);
    }

    // ---- 8. Today's hold count, for the banner: a division switched off
    // keeps its tardies as they read, held ones too, but no list is waiting
    // on them.
    const held = (await ctx.db.query("reflectionTardies")
      .withIndex("by_state_attDate", (q) => q.eq("state", "held").eq("attDate", today)).collect())
      .filter((t) => !t.division || settings.modeByDivision[t.division] !== "off");
    await ctx.db.patch(day._id, { heldCount: held.length, updatedAt: now });

    // Counts only, as attendanceDays logs.
    console.log(`[reflection] ${a.key} ${today}: ${JSON.stringify({ ...counts, released, carries, froze: froze ? (froze.rows ?? 0) : null })}`);
    return { applied: true, ok: true, ...counts, released, carries, froze };
  },
});

// ===========================================================================
// THE SWITCH AND THE SETTINGS (command line only)
// ===========================================================================

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turn one division off, to shadow, or live:
 *   npx convex run --prod reflection:setMode '{"division":"ms","mode":"shadow","countFromDate":"2026-10-21"}'
 *
 * SWITCHING ON NEVER FLOODS A LIST. `countFromDate` (default: the next school
 * day; never before today) is the first date whose violations count; anything
 * earlier is stored as before-start and never listed. A change of mode -- on
 * after off, or shadow to live -- also parks what is still waiting from
 * before: that division's tardies, uniform entries and detentions on no list
 * yet, dated before the new date, become before-start, and so does a waiting
 * detention made under another mode. So a paused week is never served on the
 * first day back, and shadow carries never move into live. What a later date
 * parked and the new one admits (dated on or after it) waits again.
 * Switching off clears the date, so switching on again sets a fresh one.
 */
export const setMode = internalMutation({
  args: {
    division: v.union(v.literal("ms"), v.literal("hs")),
    mode: v.union(v.literal("off"), v.literal("shadow"), v.literal("live")),
    countFromDate: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<Record<string, any>> => {
    const now = new Date().toISOString();
    const tz = await schoolTimeZone(ctx);
    if (!tz) return { ok: false, reason: "No school time zone is set in Settings > Bell Schedule, so no list day can be placed. Nothing was changed." };
    const lt = wallClock(now, tz);
    const today = lt.ok ? lt.dateKey : now.slice(0, 10);
    const raw = (await readState(ctx, SETTINGS_KEY)) ?? {};
    const s = reflectionSettingsOrDefault(raw);
    const prev = s.modeByDivision[a.division];
    const prevFrom = s.countFromDateByDivision[a.division];
    let from: string | null = null;
    if (a.mode !== "off") {
      if (a.countFromDate !== undefined) {
        if (!DAY_KEY.test(a.countFromDate)) return { ok: false, reason: `countFromDate must be YYYY-MM-DD, not "${a.countFromDate}". Nothing was changed.` };
        if (a.countFromDate < today) {
          return { ok: false, reason: `countFromDate ${a.countFromDate} is before today (${today}): switching on never reaches back. Nothing was changed.` };
        }
        from = a.countFromDate;
      } else if (prev === a.mode && prevFrom) {
        from = prevFrom;
      } else {
        const marks = await ctx.db.query("bellScheduleDays").withIndex("by_date", (q) => q.gt("date", today)).take(120);
        from = nextSchoolDayGuess(today, marks.filter((m) => m.noSchool).map((m) => m.date));
      }
    }
    await writeState(ctx, SETTINGS_KEY, {
      ...raw,
      modeByDivision: { ...s.modeByDivision, [a.division]: a.mode },
      countFromDateByDivision: { ...s.countFromDateByDivision, [a.division]: from },
    });

    let parked = 0, revived = 0;
    if (a.mode !== "off" && from && (prev !== a.mode || prevFrom !== from)) {
      const why = `Dated before the list started counting for ${a.division.toUpperCase()} (${from})`;
      for (const state of ["countable", "held"] as const) {
        const rows = await ctx.db.query("reflectionTardies")
          .withIndex("by_unit", (q) => q.eq("unitId", undefined).eq("state", state).lt("attDate", from!)).collect();
        for (const t of rows) {
          if ((t.division ?? null) !== a.division) continue;
          await ctx.db.patch(t._id, { state: "before-start", reason: why });
          parked++;
        }
      }
      // A WAITING DETENTION IS PARKED ONLY IF IT IS FROM BEFORE THE START
      // (fourth review, 2026-10-08), the same test the freeze asks
      // (beforeStartAtClaim): made under another mode, or dated before the
      // new date -- a carry by the list it carries from, a queued detention
      // by the list that queued it. Parked whatever its date, a rollback
      // switched back on that afternoon counting from today lost today's
      // queued second detentions and carries.
      const units = await ctx.db.query("reflectionUnits").withIndex("by_state", (q) => q.eq("state", "pending")).collect();
      for (const u of units) {
        if (u.division !== a.division) continue;
        const made = wallClock(u.recordedAt, tz);
        const listDay = u.carriedFromDay ?? (made.ok ? made.dateKey : u.recordedAt.slice(0, 10));
        if (u.mode === a.mode && listDay >= from) continue;
        await ctx.db.patch(u._id, { state: "before-start", reviewReason: why });
        parked++;
      }
      const uniforms = await ctx.db.query("uniformViolations")
        .withIndex("by_unit", (q) => q.eq("unitId", undefined).lt("day", from!)).collect();
      for (const u of uniforms) {
        if (u.voidedAt || u.reflectionState || divisionOfGrade(u.studentGrade) !== a.division) continue;
        await ctx.db.patch(u._id, { reflectionState: "before-start" });
        parked++;
      }
      // A DATE MOVED EARLIER GIVES BACK WHAT THE LATER ONE PARKED (fourth
      // review, 2026-10-08). Only what is dated before countFromDate is
      // before-start. Switched on in the morning with no date (counting from
      // tomorrow), then corrected to today, the tardies and uniform entries
      // seen in between were stamped before-start for good -- and staff could
      // not log the entry again (one per student per day). Each one of this
      // division's, dated on or after the new date and on no detention, waits
      // again: a uniform entry as it was logged, a tardy as countable, which
      // the next full read of its date (today: every read) re-judges.
      // Detentions parked for being from another mode stay parked.
      const stamped = await ctx.db.query("reflectionTardies")
        .withIndex("by_state_attDate", (q) => q.eq("state", "before-start").gte("attDate", from!)).collect();
      for (const t of stamped) {
        if (t.unitId || (t.division ?? null) !== a.division) continue;
        await ctx.db.patch(t._id, { state: "countable", reason: undefined });
        revived++;
      }
      const stampedU = await ctx.db.query("uniformViolations")
        .withIndex("by_unit", (q) => q.eq("unitId", undefined).gte("day", from!)).collect();
      for (const u of stampedU) {
        if (u.voidedAt || u.reflectionState !== "before-start" || divisionOfGrade(u.studentGrade) !== a.division) continue;
        await ctx.db.patch(u._id, { reflectionState: undefined });
        revived++;
      }
    }
    await audit(ctx, {
      byEmail: "command line", action: "set-mode",
      reason: `${a.division.toUpperCase()}: ${prev} -> ${a.mode}${from ? `, counting from ${from}` : ""}${parked ? ` (${parked} parked)` : ""}${revived ? ` (${revived} counting again)` : ""}`,
    });
    return { ok: true, division: a.division, mode: a.mode, previous: prev, countFromDate: from, parked, revived };
  },
});

/**
 * Every other setting, from the command line (no settings screen in v1):
 *   npx convex run --prod reflection:saveSettings '{"holdFirstClassOnPtNoRow":true}'
 * The mode and the count-from dates are NOT changed here: only setMode moves
 * those, because only it parks what must not be listed. A value that does not
 * make sense (a close that is not a 5-minute step, or leaves no room for a
 * closing read before the ready time) falls back to the default, and the
 * answer says which.
 */
export const saveSettings = internalMutation({
  args: {
    closeMinuteByKind: v.optional(v.object({
      regular: v.optional(v.number()), wed: v.optional(v.number()), minimum: v.optional(v.number()), stack: v.optional(v.number()),
    })),
    lastFreezeMarginMin: v.optional(v.number()),
    scheduleKinds: v.optional(v.record(v.string(), v.string())),
    lateEntryLists: v.optional(v.number()),
    maxCarries: v.optional(v.number()),
    countDitching: v.optional(v.boolean()),
    countPowerUpTardies: v.optional(v.boolean()),
    holdFirstClassOnPtNoRow: v.optional(v.boolean()),
    capacity: v.optional(v.object({ ms: v.optional(v.union(v.number(), v.null())), hs: v.optional(v.union(v.number(), v.null())) })),
    // The owner's 10/8 answers: the room runs during lunch, MS first.
    swapMinuteByKind: v.optional(v.object({
      regular: v.optional(v.union(v.number(), v.null())), wed: v.optional(v.union(v.number(), v.null())),
      minimum: v.optional(v.union(v.number(), v.null())), stack: v.optional(v.union(v.number(), v.null())),
    })),
    hsPullLeadMinutes: v.optional(v.number()),
    slipAddresseeByDivision: v.optional(v.object({
      ms: v.optional(v.union(v.literal("powerup"), v.literal("before-lunch"))),
      hs: v.optional(v.union(v.literal("powerup"), v.literal("before-lunch"))),
    })),
  },
  handler: async (ctx, a): Promise<Record<string, any>> => {
    const raw = (await readState(ctx, SETTINGS_KEY)) ?? {};
    const current = reflectionSettingsOrDefault(raw);
    const next: Record<string, any> = { ...raw };
    const NESTED = ["closeMinuteByKind", "capacity", "swapMinuteByKind", "slipAddresseeByDivision"];
    for (const [k, val] of Object.entries(a)) {
      if (val === undefined) continue;
      next[k] = NESTED.includes(k) ? { ...(current as any)[k], ...(val as object) } : val;
    }
    next.modeByDivision = current.modeByDivision;
    next.countFromDateByDivision = current.countFromDateByDivision;
    const settled = reflectionSettingsOrDefault(next);
    const refused = Object.keys(a).filter((k) => (a as any)[k] !== undefined
      && JSON.stringify((settled as any)[k]) !== JSON.stringify(NESTED.includes(k) ? next[k] : (a as any)[k]));
    await writeState(ctx, SETTINGS_KEY, settled);
    await audit(ctx, { byEmail: "command line", action: "save-settings", reason: `Changed: ${Object.keys(a).join(", ")}` });
    return { ok: true, settings: settled, refused };
  },
});

/**
 * Today at a glance, for the command line (and the health card later):
 *   npx convex run --prod reflection:status '{}'
 * Counts, times and reasons only: no student is named.
 */
export const status = internalQuery({
  args: { date: v.optional(v.string()) },
  handler: async (ctx, { date }): Promise<Record<string, any>> => {
    const settings = await loadSettings(ctx);
    const tz = await schoolTimeZone(ctx);
    const now = new Date().toISOString();
    const lt = tz ? wallClock(now, tz) : null;
    const d = date ?? (lt && lt.ok ? lt.dateKey : now.slice(0, 10));
    const row = await getDay(ctx, d);
    const lease = await getLease(ctx);
    const marked = await markedOf(ctx, d);
    const st = dayStateOf(d, row, marked);
    const units = await ctx.db.query("reflectionUnits").withIndex("by_serveDay", (q) => q.eq("serveDay", d)).collect();
    const offDays = await ctx.db.query("bellScheduleDays").withIndex("by_date", (q) => q.gt("date", d)).take(60);
    const pendingUnits = await ctx.db.query("reflectionUnits").withIndex("by_state", (q) => q.eq("state", "pending")).collect();
    const waiting = await ctx.db.query("reflectionTardies")
      .withIndex("by_unit", (q) => q.eq("unitId", undefined).eq("state", "countable").lte("attDate", d)).collect();
    return {
      date: d,
      modeByDivision: settings.modeByDivision,
      countFromDateByDivision: settings.countFromDateByDivision,
      schoolDay: row?.schoolDay ?? null, schoolDayReason: row?.schoolDayReason ?? null,
      kind: row?.kind ?? null, close: row?.closeInstant ?? null, ready: row?.readyInstant ?? null, lastFreeze: row?.lastFreezeInstant ?? null,
      readsDone: row?.readsDone ?? [], lastGoodReadAt: row?.lastGoodReadAt ?? null, lastReadError: row?.lastReadError ?? null,
      frozenAt: row?.frozenAt ?? null, freezeKind: row?.freezeKind ?? null, listCount: row?.listCount ?? null,
      heldCount: row?.heldCount ?? 0, ptBlankSections: row?.ptBlankSections ?? 0,
      banner: row?.noList && tz
        ? noListBanner(st, nextSchoolDayGuess(d, offDays.filter((m) => m.noSchool).map((m) => m.date)), tz)
        : tz ? freezeBanner(st, tz) : null,
      onTheList: units.filter((u) => u.state === "listed" || u.state === "carried").length,
      releasedFromTheList: units.filter((u) => u.state === "released").length,
      waitingForTheNextList: { tardies: waiting.length, detentions: pendingUnits.length },
      lease: lease ? { kind: lease.kind, startedAt: lease.startedAt, expiresAt: lease.expiresAt, held: Date.parse(lease.expiresAt) > Date.now() } : null,
      leaseMs: LEASE_MS,
    };
  },
});
