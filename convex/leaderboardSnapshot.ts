import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  cashLeaderboard,
  compactStudent,
  duplicateIds,
  LEADERBOARD_SNAPSHOT_VERSION,
  studentIdOf,
  type SnapRow,
} from "./leaderboardRules";
import * as R from "./leaderboardSnapshotRules";
import { rosterHit } from "./leaderboard";

/**
 * THE LEADERBOARD'S STORED COPY: the server half that reads and writes it.
 * (Build spec 2026-10-13; every decision is a pure rule in
 * leaderboardSnapshotRules.ts, and leaderboard.ts serves from the copy.)
 *
 * WHY. leaderboard:cash read every student row, cash history and all, on every
 * portal open: 4.88 MiB a call on 2026-10-13, growing towards Convex's 16 MiB
 * wall around January. A copy of just what the ranking reads is about 65 KB.
 *
 * HOW A BUILD GOES. The cron fires `tick` at :03, :18, :33 and :48 (never in
 * the sync windows). The tick reads the switch and the state row -- never the
 * copy itself -- and when the board is old enough books ONE build under a
 * lease. The build (an action) reads the roster fingerprint, pages through
 * every student fifty at a time (compactPage: each row through compactStudent,
 * so no cash history ever leaves the page), reads the fingerprint again, and
 * hands the rows to `write`, which re-checks the lease and the switch, decides
 * whether to keep the read (acceptBuild) and replaces the one stored row.
 *
 * WHY AN ACTION AND PAGES, NOT ONE MUTATION. A mutation that collected every
 * student would carry the same 16 MiB wall as the query it replaces, and every
 * award that committed while it ran would force Convex to re-run it. Pages are
 * read-only queries, so they conflict with nothing; `write` reads only the
 * copy and two appState rows no cash path touches, so an award can never be
 * retried or blocked because of this file.
 *
 * NOTHING HERE IS REACHABLE FROM A BROWSER. Every function is internal, for
 * the cron and the command line, and none is ever run from a public function
 * (read-walls.test.mjs would see a public path to the whole-table pages). It
 * writes only `leaderboardSnapshots` and the two appState rows, which
 * leaderboard-snapshot.test.mjs checks by running every mutation.
 *
 * NAMES NEVER LEAVE IT. Names cross internal arguments only; status, compare
 * and every log line carry counts, times and reason codes.
 *
 * THE COMMAND LINE (deploy key only):
 *   npx convex run --prod leaderboardSnapshot:configure '{"mode":"shadow","actorName":"..."}'
 *   npx convex run --prod leaderboardSnapshot:runNow '{"actorName":"..."}'
 *   npx convex run --prod leaderboardSnapshot:compare '{"kind":"logic"}'    <- counts; must find 0 differences
 *   npx convex run --prod leaderboardSnapshot:configure '{"mode":"pilot","pilotEmails":["..."],"actorName":"..."}'
 *   npx convex run --prod leaderboardSnapshot:configure '{"mode":"live","actorName":"..."}'    <- needs a clean logic compare
 *   npx convex run --prod leaderboardSnapshot:configure '{"mode":"off","actorName":"..."}'     <- THE KILL SWITCH
 *   npx convex run --prod leaderboardSnapshot:status
 * The kill switch sets the copy's `serve` to "none" in the same transaction,
 * so the next call from every open tab ranks live: no deploy, no refresh.
 */

type Ctx = QueryCtx | MutationCtx;

async function readState(ctx: Ctx, key: string): Promise<any> {
  const row = await ctx.db.query("appState").withIndex("by_key", (q) => q.eq("key", key)).first();
  return row?.value ?? null;
}
async function writeState(ctx: MutationCtx, key: string, value: any): Promise<void> {
  const row = await ctx.db.query("appState").withIndex("by_key", (q) => q.eq("key", key)).first();
  const at = new Date().toISOString();
  if (row) await ctx.db.patch(row._id, { value, mirroredAt: at });
  else await ctx.db.insert("appState", { key, value, mirroredAt: at });
}
async function loadConfig(ctx: Ctx): Promise<R.Config> {
  return R.configOrDefault(await readState(ctx, R.CONFIG_KEY));
}
async function loadState(ctx: Ctx): Promise<R.State> {
  return R.stateOrEmpty(await readState(ctx, R.STATE_KEY));
}
/** The school's time zone, from Settings > Bell Schedule (the same row perfectDay reads). */
async function schoolTimeZone(ctx: Ctx): Promise<string | null> {
  const row = await ctx.db.query("bellSettings").withIndex("by_key", (q) => q.eq("key", "bell")).first();
  return row?.timeZone ?? null;
}
async function snapshotDoc(ctx: Ctx) {
  return await ctx.db.query("leaderboardSnapshots").withIndex("by_name", (q) => q.eq("name", "cash")).first();
}
function sizeOf(doc: unknown): number {
  try { return doc ? JSON.stringify(doc).length : 0; } catch { return 0; }
}

/**
 * THE ONLY WAY THIS FILE LOGS: numbers, or it throws. A log line that could
 * take a string could one day take a name, and Convex keeps logs where
 * nobody audits who reads them.
 */
function logCounts(counts: Record<string, number>): void {
  for (const [k, n] of Object.entries(counts)) {
    if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`logCounts: ${k} is not a number`);
  }
  console.log(`[leaderboardSnapshot] ${JSON.stringify(counts)}`);
}

/** A reason code: lower-case words and dashes, never free text (it may be an error message). */
const codeOf = (why: unknown) => (typeof why === "string" && /^[a-z0-9-]{1,40}$/.test(why) ? why : "error");

const snapRow = v.object({
  id: v.string(),
  enrolled: v.optional(v.literal(false)),
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
  grade: v.optional(v.string()),
  wildcatCashEarned: v.optional(v.union(v.number(), v.null())),
});

/**
 * WHO THE COPY IS SERVED TO, written to the document and mirrored in the
 * state row, which is what the tick reads instead of the 65 KB document.
 */
async function setServe(ctx: MutationCtx, state: R.State, serve: R.Serve, why: string | null, pilotIds?: string[]): Promise<void> {
  state.serve = serve;
  state.why = why;
  if (!state.snapshotId) return;
  const fields: Record<string, unknown> = { serve, why: why ?? undefined };
  if (pilotIds) fields.pilotIds = pilotIds;
  try {
    await ctx.db.patch(state.snapshotId as any, fields);
  } catch {
    // The row is gone (removed by hand): forget it, and the next tick builds.
    state.snapshotId = null;
    state.builtAt = null;
  }
}

/** A build that was not kept, for whatever reason: counted, and the grace clock starts. */
function noteRefusal(state: R.State, nowIso: string, why: string, bytesRead: number): void {
  state.lastAttempt = { at: nowIso, ok: false, why };
  state.firstFailAt = state.firstFailAt ?? nowIso;
  state.buildsByDay = R.bumpDay(state.buildsByDay, nowIso.slice(0, 10), { refusals: 1, bytesRead });
  state.lease = null;
}

// ===========================================================================
// The tick
// ===========================================================================

async function bookBuild(ctx: MutationCtx, trigger: string, force: boolean): Promise<Record<string, any>> {
  const config = await loadConfig(ctx);
  const state = await loadState(ctx);
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  let changed = false;

  // SWITCHED OFF, the repo default: nothing is built, and a copy still marked
  // as served is put right (configure off does this in its own transaction;
  // this catches a state row edited by hand).
  if (config.mode === "off") {
    if (state.serve !== "none") {
      await setServe(ctx, state, "none", "off");
      await writeState(ctx, R.STATE_KEY, state);
      return { do: "none", why: "off", healed: true };
    }
    return { do: "none", why: "off" };
  }

  // A LEASE THAT LAPSED is a build that never wrote (Convex stopped the
  // action, or it threw before it could say so). Counted as a failure, so a
  // build that keeps dying runs out the grace like one that keeps failing.
  if (state.lease && Date.parse(state.lease.expiresAt) <= nowMs) {
    noteRefusal(state, nowIso, "lapsed", 0);
    changed = true;
  }

  const tz = await schoolTimeZone(ctx);
  const d = R.decideSnapshotTick({ mode: config.mode, nowIso, tz, state, config, force });
  if (d.markStale) {
    await setServe(ctx, state, "none", d.markStale);
    changed = true;
  }
  let runId: string | null = null;
  if (d.build) {
    runId = `lb_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    state.lease = { runId, startedAt: nowIso, expiresAt: new Date(nowMs + R.LEASE_MS).toISOString() };
    changed = true;
    await ctx.scheduler.runAfter(0, internal.leaderboardSnapshot.build, { runId });
  }
  if (changed) await writeState(ctx, R.STATE_KEY, state);
  return { do: d.build ? "build" : "none", why: d.why, markStale: d.markStale, trigger };
}

/**
 * The cron's handler (crons.ts). Switched off -- the repo default, and what a
 * missing config row means -- it reads two small rows and stops.
 */
export const tick = internalMutation({
  args: {},
  handler: async (ctx): Promise<Record<string, any>> => bookBuild(ctx, "tick", false),
});

/**
 * Build now, whatever the board's age. Still nothing when off, still one
 * build at a time, still never inside a sync window. CLI only.
 */
export const runNow = internalMutation({
  args: { actorName: v.optional(v.string()) },
  handler: async (ctx): Promise<Record<string, any>> => bookBuild(ctx, "runNow", true),
});

// ===========================================================================
// The switch
// ===========================================================================

/**
 * Change the mode, the cadence or the pilot. CLI only. Returns counts, never
 * ids or names.
 *
 *   - THE COPY'S `serve` MOVES IN THE SAME TRANSACTION as the config, so off
 *     is off on the very next call from every tab. Switching on is served only
 *     if the copy is fresh enough; otherwise it waits for the next good build.
 *   - pilotEmails are turned into student ids here, by the indexed email
 *     lookup; an address that matches no student, or two, is counted and left
 *     out. pilotSample picks that many enrolled students from the copy. At
 *     most 50 in all. The ids are stored, never returned.
 *   - LIVE NEEDS A CLEAN LOGIC COMPARE from the last 72 hours (liveRefusal),
 *     unless acceptWithoutCompare says otherwise on purpose.
 *   - Switching on from off books a build straight away.
 */
export const configure = internalMutation({
  args: {
    mode: v.optional(v.union(v.literal("off"), v.literal("shadow"), v.literal("pilot"), v.literal("live"))),
    schoolEveryMinutes: v.optional(v.number()),
    offHoursEveryMinutes: v.optional(v.number()),
    failGraceMinutes: v.optional(v.number()),
    maxAgeMinutes: v.optional(v.number()),
    pilotEmails: v.optional(v.array(v.string())),
    pilotSample: v.optional(v.number()),
    acceptWithoutCompare: v.optional(v.boolean()),
    actorName: v.string(),
  },
  handler: async (ctx, a): Promise<Record<string, any>> => {
    const prev = await loadConfig(ctx);
    const state = await loadState(ctx);
    const nowIso = new Date().toISOString();
    const refuse = (code: string, why: string) => ({ ok: false, code, why });
    const actor = a.actorName.trim();
    if (!actor) return refuse("no-actor", "Say who is changing it: actorName.");

    const next: R.Config = { ...prev, pilotIds: [...prev.pilotIds] };
    if (a.mode !== undefined) next.mode = a.mode;
    for (const key of Object.keys(R.MINUTE_BOUNDS) as Array<keyof typeof R.MINUTE_BOUNDS>) {
      if (a[key] === undefined) continue;
      const n = R.cleanMinutes(key, a[key]);
      if (n === null) {
        const [lo, hi] = R.MINUTE_BOUNDS[key];
        return refuse("bad-minutes", `${key} must be a whole number from ${lo} to ${hi}.`);
      }
      next[key] = n;
    }

    let pilot: Record<string, number> = { ids: next.pilotIds.length };
    if (a.pilotEmails !== undefined || a.pilotSample !== undefined) {
      const ids: string[] = [];
      let fromEmails = 0, unmatched = 0, ambiguous = 0, sampled = 0;
      for (const raw of a.pilotEmails ?? []) {
        // Normalised as identityRules.normalizeEmail does, which is how the
        // students table stores the address.
        const email = String(raw ?? "").trim().toLowerCase();
        const found = email
          ? await ctx.db.query("students").withIndex("by_email", (q) => q.eq("email", email)).take(2)
          : [];
        if (found.length === 1) { ids.push(studentIdOf(found[0] as any)); fromEmails++; }
        else if (found.length > 1) ambiguous++;
        else unmatched++;
      }
      if (a.pilotSample !== undefined && a.pilotSample !== 0) {
        if (!Number.isInteger(a.pilotSample) || a.pilotSample < 0 || a.pilotSample > R.PILOT_MAX) {
          return refuse("bad-sample", `pilotSample must be a whole number from 0 to ${R.PILOT_MAX}.`);
        }
        const snap = await snapshotDoc(ctx);
        if (!snap) return refuse("no-snapshot", "pilotSample picks from the stored copy, and there is none yet: run shadow until a build is kept.");
        const picked = R.spreadSample(snap.rows, snap.dupIds, a.pilotSample);
        ids.push(...picked);
        sampled = picked.length;
      }
      const unique = [...new Set(ids)];
      if (unique.length > R.PILOT_MAX) return refuse("pilot-too-big", `A pilot names at most ${R.PILOT_MAX} students.`);
      next.pilotIds = unique;
      pilot = { ids: unique.length, fromEmails, unmatched, ambiguous, sampled };
    }

    if (next.mode === "live" && prev.mode !== "live" && a.acceptWithoutCompare !== true) {
      const why = R.liveRefusal(state.lastCompare, nowIso);
      if (why) return refuse("no-clean-compare", why);
    }

    next.changedAt = nowIso;
    next.changedBy = actor;
    await writeState(ctx, R.CONFIG_KEY, next);

    let serve = R.serveFor(next.mode);
    let why: string | null = next.mode === "off" ? "off" : next.mode === "shadow" ? "shadow" : null;
    if (serve !== "none") {
      const stale = R.staleReason({ mode: next.mode, state: { ...state, serve }, config: next, nowIso });
      if (stale) { serve = "none"; why = stale; }
    }
    await setServe(ctx, state, serve, why, next.pilotIds);
    await writeState(ctx, R.STATE_KEY, state);

    let build: string | null = null;
    if (prev.mode === "off" && next.mode !== "off") build = (await bookBuild(ctx, "configure", true)).do;

    return {
      ok: true, mode: next.mode, serve, why, pilot, build,
      schoolEveryMinutes: next.schoolEveryMinutes, offHoursEveryMinutes: next.offHoursEveryMinutes,
      failGraceMinutes: next.failGraceMinutes, maxAgeMinutes: next.maxAgeMinutes,
    };
  },
});

// ===========================================================================
// The build
// ===========================================================================

/**
 * THE ROSTER'S TWO ENDS AND THE LAST SYNC. The sync's clearRoster deletes the
 * oldest rows first and upsertRoster inserts new ones, so a roster replace
 * that overlaps a build changes the oldest or the newest row. Read before and
 * after; a build whose two readings differ is not kept.
 */
export const rosterFingerprint = internalQuery({
  args: {},
  handler: async (ctx) => {
    const oldest = await ctx.db.query("psRoster").order("asc").first();
    const newest = await ctx.db.query("psRoster").order("desc").first();
    const run = await ctx.db.query("syncRuns").withIndex("by_at").order("desc").first();
    return {
      oldest: oldest?._id ?? null,
      newest: newest?._id ?? null,
      syncAt: run?.at ?? null,
      bytes: sizeOf(oldest) + sizeOf(newest) + sizeOf(run),
    };
  },
});

/**
 * FIFTY STUDENTS, AS THE COPY HOLDS THEM. Each row goes through
 * compactStudent here, inside the query, so no cash history, email or other
 * field ever reaches the action. Enrolment is the same roster lookup the live
 * read makes (leaderboard.rosterHit). Never logs.
 */
export const compactPage = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    // Fifty a page, like readHeadroom.studentsPage: a page with its fifty
    // roster lookups stays far inside the limit the copy exists to avoid.
    const page = await ctx.db.query("students").paginate({ cursor: cursor ?? null, numItems: 50 });
    const rows: SnapRow[] = [];
    let newest = 0, bytes = 0, lookupBytes = 0, enrolled = 0;
    for (const raw of page.page as any[]) {
      bytes += sizeOf(raw);
      newest = Math.max(newest, Number(raw._creationTime) || 0);
      const hit = await rosterHit(ctx, raw.studentNumber);
      if (hit) { enrolled++; lookupBytes += sizeOf(hit); }
      rows.push(compactStudent(raw, Boolean(hit)));
    }
    return { rows, newest, bytes, lookupBytes, enrolled, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/**
 * One build: fingerprint, every page, fingerprint, write. Any error is
 * recorded as a failed build with a short code, never the error's text.
 */
export const build = internalAction({
  args: { runId: v.string() },
  handler: async (ctx, { runId }): Promise<Record<string, any>> => {
    const t0 = Date.now();
    const startedAt = new Date(t0).toISOString();
    let stage = "fingerprint";
    let estBytesRead = 0;
    let pages = 0;
    let out: Record<string, any>;
    try {
      const fp0: any = await ctx.runQuery(internal.leaderboardSnapshot.rosterFingerprint, {});
      estBytesRead += fp0.bytes;
      stage = "page";
      const rows: SnapRow[] = [];
      let cursor: string | null = null;
      let newest = 0, enrolled = 0;
      for (;;) {
        if (pages >= R.MAX_PAGES) throw new Error("too-many-pages");
        const p: any = await ctx.runQuery(internal.leaderboardSnapshot.compactPage, { cursor });
        pages++;
        for (const r of p.rows as SnapRow[]) rows.push(r);
        newest = Math.max(newest, p.newest);
        enrolled += p.enrolled;
        estBytesRead += p.bytes + p.lookupBytes;
        if (p.isDone) break;
        cursor = p.cursor;
      }
      stage = "fingerprint";
      const fp1: any = await ctx.runQuery(internal.leaderboardSnapshot.rosterFingerprint, {});
      estBytesRead += fp1.bytes;
      const rosterSteady = fp0.oldest === fp1.oldest && fp0.newest === fp1.newest && fp0.syncAt === fp1.syncAt;
      stage = "write";
      const w: any = await ctx.runMutation(internal.leaderboardSnapshot.write, {
        runId, startedAt, rows, newestCreationTime: newest, enrolled, rosterSteady, syncAt: fp1.syncAt,
        pages, tookMs: Date.now() - t0, estBytesRead,
      });
      out = { ok: w.ok === true, why: w.why, rows: rows.length, enrolled, pages, estBytesRead };
    } catch (e) {
      const why = stage === "page" && String((e as any)?.message) === "too-many-pages" ? "too-many-pages" : `${stage}-threw`;
      await ctx.runMutation(internal.leaderboardSnapshot.recordFailure, { runId, why, estBytesRead });
      out = { ok: false, why, rows: 0, enrolled: 0, pages, estBytesRead };
    }
    logCounts({
      ok: out.ok ? 1 : 0, rows: out.rows, enrolled: out.enrolled, pages: out.pages,
      tookMs: Date.now() - t0, estKiBRead: Math.round(out.estBytesRead / 1024),
    });
    return out;
  },
});

/**
 * KEEP THE BUILD, OR SAY WHY NOT. Writes nothing for a run that no longer
 * holds the lease, and keeps nothing once the lease has lapsed or the switch
 * is off -- so the kill switch beats a build already under way.
 */
export const write = internalMutation({
  args: {
    runId: v.string(),
    startedAt: v.string(),
    rows: v.array(snapRow),
    newestCreationTime: v.number(),
    enrolled: v.number(),
    rosterSteady: v.boolean(),
    syncAt: v.union(v.string(), v.null()),
    pages: v.number(),
    tookMs: v.number(),
    estBytesRead: v.number(),
  },
  handler: async (ctx, a): Promise<Record<string, any>> => {
    const config = await loadConfig(ctx);
    const state = await loadState(ctx);
    const nowIso = new Date().toISOString();
    const lease = state.lease;
    if (!lease || lease.runId !== a.runId) return { ok: false, why: "not-the-lease" };
    if (Date.parse(lease.expiresAt) <= Date.parse(nowIso)) {
      noteRefusal(state, nowIso, "lease-expired", a.estBytesRead);
      await writeState(ctx, R.STATE_KEY, state);
      return { ok: false, why: "lease-expired" };
    }
    if (config.mode === "off") {
      state.lease = null;
      state.lastAttempt = { at: nowIso, ok: false, why: "off" };
      await writeState(ctx, R.STATE_KEY, state);
      return { ok: false, why: "off" };
    }

    const verdict = R.acceptBuild({
      prev: state.lastOk ? { rows: state.lastOk.rows, enrolled: state.lastOk.enrolled, syncAt: state.lastOk.syncAt ?? null } : null,
      pendingDrop: state.pendingDrop,
      rows: a.rows.length,
      enrolled: a.enrolled,
      rosterSteady: a.rosterSteady,
      syncAtNow: a.syncAt,
      nowIso: a.startedAt,
    });
    if (verdict.verdict !== "accept") {
      const why = verdict.verdict === "hold" ? "drop-held" : verdict.code;
      if (verdict.verdict === "hold") state.pendingDrop = verdict.pendingDrop;
      noteRefusal(state, nowIso, why, a.estBytesRead);
      await writeState(ctx, R.STATE_KEY, state);
      return { ok: false, why };
    }

    const serve = R.serveFor(config.mode);
    const why = config.mode === "shadow" ? "shadow" : null;
    const dupIds = duplicateIds(a.rows);
    const doc = {
      name: "cash" as const,
      version: LEADERBOARD_SNAPSHOT_VERSION,
      serve,
      ...(why ? { why } : {}),
      pilotIds: config.pilotIds,
      builtAt: a.startedAt,
      buildId: a.runId,
      newestCreationTime: a.newestCreationTime,
      dupIds,
      rows: a.rows,
    };
    // ONE ROW. A second one (two writes racing past the lease) is removed, so
    // leaderboard:cash's .first() can only ever find this build.
    const existing = await ctx.db.query("leaderboardSnapshots").withIndex("by_name", (q) => q.eq("name", "cash")).take(10);
    let id: string;
    if (existing.length) {
      await ctx.db.replace(existing[0]._id, doc);
      for (const extra of existing.slice(1)) await ctx.db.delete(extra._id);
      id = existing[0]._id;
    } else {
      id = await ctx.db.insert("leaderboardSnapshots", doc);
    }

    const ranked = (band: string) => cashLeaderboard({ students: a.rows, band }).total;
    const leavers = a.rows.filter((r) => r.enrolled === false).length;
    state.lastOk = {
      at: nowIso, startedAt: a.startedAt, buildId: a.runId, rows: a.rows.length, enrolled: a.enrolled, leavers,
      rankedPerBand: { academy: ranked("academy"), hs: ranked("hs"), ms: ranked("ms") },
      dupIds: dupIds.length, pages: a.pages, tookMs: a.tookMs, estBytesRead: a.estBytesRead, syncAt: a.syncAt,
    };
    state.snapshotId = id;
    state.version = LEADERBOARD_SNAPSHOT_VERSION;
    state.serve = serve;
    state.why = why;
    state.builtAt = a.startedAt;
    state.firstFailAt = null;
    state.pendingDrop = null;
    state.lease = null;
    state.lastAttempt = { at: nowIso, ok: true, why: verdict.why };
    state.buildsByDay = R.bumpDay(state.buildsByDay, nowIso.slice(0, 10), { builds: 1, bytesRead: a.estBytesRead });
    await writeState(ctx, R.STATE_KEY, state);
    return { ok: true, why: verdict.why, rows: a.rows.length, enrolled: a.enrolled, serve, dupIds: dupIds.length };
  },
});

/** A build that threw: the same bookkeeping as a refusal, for the run holding the lease only. */
export const recordFailure = internalMutation({
  args: { runId: v.string(), why: v.string(), estBytesRead: v.optional(v.number()) },
  handler: async (ctx, a): Promise<Record<string, any>> => {
    const state = await loadState(ctx);
    if (!state.lease || state.lease.runId !== a.runId) return { recorded: false, why: "not-the-lease" };
    noteRefusal(state, new Date().toISOString(), codeOf(a.why), a.estBytesRead ?? 0);
    await writeState(ctx, R.STATE_KEY, state);
    return { recorded: true };
  },
});

// ===========================================================================
// The compare
// ===========================================================================

/**
 * FIFTY STUDENT ROWS FOR THE COMPARE: each row's scalar fields (anything that
 * is not an object or a list, so no cash history) plus `enrolled`, exactly
 * the shape the live read ranks. Deliberately NOT compactStudent, so the
 * compare checks it rather than repeating it.
 */
export const comparePage = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("students").paginate({ cursor: cursor ?? null, numItems: 50 });
    const rows: Array<Record<string, unknown>> = [];
    for (const raw of page.page as any[]) {
      const hit = await rosterHit(ctx, raw.studentNumber);
      const scalars: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(raw)) if (val === null || typeof val !== "object") scalars[k] = val;
      scalars.enrolled = Boolean(hit);
      rows.push(scalars);
    }
    return { rows, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/** The stored copy, for the compare only. */
export const storedSnapshot = internalQuery({
  args: {},
  handler: async (ctx) => {
    const doc = await snapshotDoc(ctx);
    return doc ? { rows: doc.rows, dupIds: doc.dupIds, newestCreationTime: doc.newestCreationTime } : null;
  },
});

/**
 * Does the copy rank every student the way the live read does? Reads every
 * student once (about one build's worth). Counts only. See
 * leaderboardSnapshotRules.compareSnapshot for "logic" and "fresh".
 */
export const compare = internalAction({
  args: { kind: v.union(v.literal("logic"), v.literal("fresh")) },
  handler: async (ctx, { kind }): Promise<Record<string, any>> => {
    const live: Array<Record<string, any>> = [];
    let cursor: string | null = null;
    for (let i = 0; ; i++) {
      if (i >= R.MAX_PAGES) return { ok: false, why: "too-many-pages" };
      const p: any = await ctx.runQuery(internal.leaderboardSnapshot.comparePage, { cursor });
      for (const r of p.rows) live.push(r);
      if (p.isDone) break;
      cursor = p.cursor;
    }
    let stored = null;
    if (kind === "fresh") {
      stored = await ctx.runQuery(internal.leaderboardSnapshot.storedSnapshot, {});
      if (!stored) return { ok: false, why: "no-snapshot" };
    }
    const counts = R.compareSnapshot(live, kind, stored);
    const result = { kind, at: new Date().toISOString(), ...counts };
    await ctx.runMutation(internal.leaderboardSnapshot.recordCompare, { result });
    return { ok: true, ...result };
  },
});

/** Keep the compare's counts in the state row: the live switch reads them. */
export const recordCompare = internalMutation({
  args: { result: v.any() },
  handler: async (ctx, { result }): Promise<Record<string, any>> => {
    const state = await loadState(ctx);
    const r = (result ?? {}) as Record<string, any>;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    const counts = (o: unknown) => Object.fromEntries(Object.entries((o ?? {}) as Record<string, unknown>)
      .filter(([k]) => /^[a-zA-Z-]{1,40}$/.test(k)).map(([k, x]) => [k, n(x)]));
    state.lastCompare = {
      kind: r.kind === "logic" ? "logic" : "fresh",
      at: typeof r.at === "string" ? r.at : new Date().toISOString(),
      viewers: n(r.viewers), enrolledViewers: n(r.enrolledViewers), comparisons: n(r.comparisons),
      identical: n(r.identical), differ: n(r.differ), byField: counts(r.byField),
      fallbacksByReason: counts(r.fallbacksByReason), rowsChangedSinceBuild: n(r.rowsChangedSinceBuild), dupIds: n(r.dupIds),
    };
    await writeState(ctx, R.STATE_KEY, state);
    return { recorded: true };
  },
});

// ===========================================================================
// Status
// ===========================================================================

/** Where it stands: the switch, the last builds, the copy's size. Counts and times only. */
export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const config = await loadConfig(ctx);
    const state = await loadState(ctx);
    const doc = await snapshotDoc(ctx);
    const built = state.builtAt ? Date.parse(state.builtAt) : NaN;
    return {
      config: {
        mode: config.mode,
        schoolEveryMinutes: config.schoolEveryMinutes,
        offHoursEveryMinutes: config.offHoursEveryMinutes,
        failGraceMinutes: config.failGraceMinutes,
        maxAgeMinutes: config.maxAgeMinutes,
        pilot: config.pilotIds.length,
        changedAt: config.changedAt,
        changedBy: config.changedBy,
      },
      state: {
        building: state.lease ? { startedAt: state.lease.startedAt, expiresAt: state.lease.expiresAt } : null,
        serve: state.serve,
        why: state.why,
        version: state.version,
        builtAt: state.builtAt,
        ageMinutes: Number.isFinite(built) ? Math.round((Date.now() - built) / 60000) : null,
        lastOk: state.lastOk,
        lastAttempt: state.lastAttempt,
        firstFailAt: state.firstFailAt,
        pendingDrop: state.pendingDrop,
        buildsByDay: state.buildsByDay,
        lastCompare: state.lastCompare,
      },
      snapshot: doc
        ? {
            exists: true,
            bytes: sizeOf(doc),
            rows: doc.rows.length,
            enrolled: doc.rows.filter((r) => r.enrolled !== false).length,
            serve: doc.serve,
            why: doc.why ?? null,
            version: doc.version,
            currentVersion: LEADERBOARD_SNAPSHOT_VERSION,
            dupIds: doc.dupIds.length,
            pilot: doc.pilotIds.length,
            builtAt: doc.builtAt,
          }
        : { exists: false, currentVersion: LEADERBOARD_SNAPSHOT_VERSION },
    };
  },
});
