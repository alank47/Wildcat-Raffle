import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import {
  rosterAgeBanner, rosterSnapshotVerdict, termBanner, wallClock,
  type RosterMeta,
} from "./reflectionRules";

/**
 * THE DAILY REFLECTION ROOM LIST: the server side that reads and writes.
 *
 * Every decision is a pure function in reflectionRules.ts; this file only
 * gathers the facts for them and writes what they decide. PowerSchool itself
 * is read by reflectionRead.ts (an action: it needs the network and Node).
 *
 * NOTHING HERE IS REACHABLE FROM A BROWSER. Every function is internal: the
 * cron, the reader and the command line call them. The screen arrives in a
 * later step, through its own access-checked query.
 */

/** appState keys. The repo default for the switch is OFF: a missing row is off. */
export const SETTINGS_KEY = "reflection:settings";
export const ROSTER_KEY = "reflection:roster";

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
