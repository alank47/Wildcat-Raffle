/**
 * THE LEADERBOARD'S STORED COPY: when to rebuild it, and whether to keep what
 * a build read. Every rule, pure: no ctx, no database, and the clock is an
 * argument. (Build spec 2026-10-13; leaderboardSnapshot.ts does the reading
 * and writing, leaderboard.ts serves from the copy.)
 *
 * WHY THERE IS A COPY. leaderboard:cash ranked every student on every portal
 * open by reading every student row, and each row carries that child's whole
 * cash history: 4.88 MiB a call on 2026-10-13, growing by about 0.9 MiB a
 * school week towards Convex's 16 MiB wall around January, and about 70 GiB of
 * reads in the next month. The ranking reads nine fields, so a copy of those
 * for the whole school (about 65 KB) gives the same answer for a fraction of
 * the reads, as long as it is rebuilt often enough.
 *
 * REBUILT ON A FIXED TIMETABLE, NOT WHEN CASH MOVES. Knowing when an amount
 * changed would mean a hook in every cash write path (awards, the store, the
 * perfect-day payer, reversals, the recount, the sync), and the standing rule
 * is that this feature touches none of them. A timetable has no blind spots:
 * whatever wrote the change, it reaches the board within one cadence. The
 * viewer's own row is always read live (leaderboardRules.placeViewer), so the
 * figure a child checks first is never old; only other children's can be.
 *
 * IT DOES NOTHING UNTIL IT IS TURNED ON. A missing config row means off, and
 * off means the query ranks live exactly as before.
 */

import {
  cashLeaderboard,
  compactStudent,
  duplicateIds,
  LEADERBOARD_SNAPSHOT_VERSION,
  placeViewer,
  studentIdOf,
  type SnapRow,
} from "./leaderboardRules";
import { localSchoolTime } from "./scheduleRules";

// ===========================================================================
// Keys and constants
// ===========================================================================

/** appState: the switch and the cadence. Absent means OFF. */
export const CONFIG_KEY = "leaderboardSnapshot:config";
/** appState: the lease, the last good build, the mirrors the tick reads. Counts and times only. */
export const STATE_KEY = "leaderboardSnapshot:state";

/** One build at a time. A build reads about 16 pages in seconds; ten minutes is generous. */
export const LEASE_MS = 10 * 60 * 1000;
/** Pages before a build gives up and says so (200 x 50 = 10,000 students). */
export const MAX_PAGES = 200;
/** Students per page. compactPage writes the literal 50; the static test holds the two together. */
export const PAGE = 50;
/** Refused loudly well before Convex's 8,192-element array limit. */
export const MAX_ROWS = 7000;
/** The most students a pilot can name. */
export const PILOT_MAX = 50;
/** A held enrolment drop is re-read at least this long after it was first seen. */
export const DROP_RECHECK_MINUTES = 20;
/** ...and kept when the re-read agrees within this many students. */
export const DROP_AGREE = 2;
/** A logic compare is good enough to switch live for this long. */
export const COMPARE_VALID_HOURS = 72;
/** School hours, local: 06:45 to 16:30. */
export const SCHOOL_FROM_MINUTE = 6 * 60 + 45;
export const SCHOOL_TO_MINUTE = 16 * 60 + 30;
/**
 * The cron fires every 15 minutes, a few seconds late, and a build stamps the
 * time its FIRST page was read. "Every 15" is therefore "at least 10 old":
 * otherwise a board built at :03:05 is 14:58 old at the next :18 and waits for
 * the :33, doubling the cadence.
 */
export const CADENCE_SLACK_MINUTES = 5;

export type Mode = "off" | "shadow" | "pilot" | "live";
export type Serve = "none" | "pilot" | "all";
const MODES: Mode[] = ["off", "shadow", "pilot", "live"];

// ===========================================================================
// The switch
// ===========================================================================

export type Config = {
  mode: Mode;
  schoolEveryMinutes: number;
  offHoursEveryMinutes: number;
  failGraceMinutes: number;
  maxAgeMinutes: number;
  pilotIds: string[];
  changedAt: string | null;
  changedBy: string | null;
};

/**
 * THE DEFAULTS (owner, 2026-10-13). Every 15 minutes in school hours, because
 * the owner was told the board "updates when cash changes" and 15 is the
 * closer promise (about $0.30-0.60 a month more than 30). Every 6 hours
 * otherwise. After an hour of failed builds, or a board 13 hours old, the
 * tick stops serving the copy and every student is ranked live again.
 */
export const DEFAULT_CONFIG: Config = {
  mode: "off",
  schoolEveryMinutes: 15,
  offHoursEveryMinutes: 360,
  failGraceMinutes: 60,
  maxAgeMinutes: 780,
  pilotIds: [],
  changedAt: null,
  changedBy: null,
};

/** Bounds for each number configure accepts: [lowest, highest]. */
export const MINUTE_BOUNDS = {
  schoolEveryMinutes: [10, 240],
  offHoursEveryMinutes: [30, 1440],
  failGraceMinutes: [15, 1440],
  maxAgeMinutes: [60, 2880],
} as const;

/** A whole number of minutes inside its bounds, or null. */
export function cleanMinutes(key: keyof typeof MINUTE_BOUNDS, n: unknown): number | null {
  const [lo, hi] = MINUTE_BOUNDS[key];
  return typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

/**
 * The stored config, or the defaults. A stored value that is not usable falls
 * back to its default rather than to something guessed, and an unknown mode
 * is off: a switch nobody can read is a switch that is off.
 */
export function configOrDefault(raw: unknown): Config {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG, pilotIds: [] };
  const r = raw as Record<string, any>;
  const minutes = (key: keyof typeof MINUTE_BOUNDS) => cleanMinutes(key, r[key]) ?? DEFAULT_CONFIG[key];
  return {
    mode: MODES.includes(r.mode) ? r.mode : "off",
    schoolEveryMinutes: minutes("schoolEveryMinutes"),
    offHoursEveryMinutes: minutes("offHoursEveryMinutes"),
    failGraceMinutes: minutes("failGraceMinutes"),
    maxAgeMinutes: minutes("maxAgeMinutes"),
    pilotIds: Array.isArray(r.pilotIds)
      ? [...new Set(r.pilotIds.filter((x: unknown) => typeof x === "string" && x.trim()) as string[])].slice(0, PILOT_MAX)
      : [],
    changedAt: typeof r.changedAt === "string" ? r.changedAt : null,
    changedBy: typeof r.changedBy === "string" ? r.changedBy : null,
  };
}

/**
 * WHO THE STORED COPY IS SERVED TO, by mode. Shadow builds and compares but
 * serves nobody; pilot serves the students on its list; live serves everyone.
 */
export function serveFor(mode: Mode): Serve {
  return mode === "live" ? "all" : mode === "pilot" ? "pilot" : "none";
}

// ===========================================================================
// The state row
// ===========================================================================

export type Lease = { runId: string; startedAt: string; expiresAt: string } | null;
/** A held build: when it read, what it counted (rows null in a state row written before 2026-10-13's fix). */
export type PendingDrop = { at: string; enrolled: number; rows: number | null; syncAt: string | null } | null;
export type DayCount = { day: string; builds: number; refusals: number; bytesRead: number };
export type LastOk = {
  at: string;
  startedAt: string;
  buildId: string;
  rows: number;
  enrolled: number;
  leavers: number;
  rankedPerBand: { academy: number; hs: number; ms: number };
  dupIds: number;
  pages: number;
  tookMs: number;
  estBytesRead: number;
  syncAt: string | null;
};
export type State = {
  lease: Lease;
  snapshotId: string | null;
  version: number | null;
  serve: Serve;
  why: string | null;
  builtAt: string | null;
  lastOk: LastOk | null;
  lastAttempt: { at: string; ok: boolean; why: string } | null;
  firstFailAt: string | null;
  pendingDrop: PendingDrop;
  buildsByDay: DayCount[];
  /** The last compare of either kind, as status shows it. */
  lastCompare: Record<string, any> | null;
  /** The last LOGIC compare: what the live switch reads (a fresh one run since must not hide it). */
  lastLogicCompare: Record<string, any> | null;
};

export const EMPTY_STATE: State = {
  lease: null, snapshotId: null, version: null, serve: "none", why: null, builtAt: null,
  lastOk: null, lastAttempt: null, firstFailAt: null, pendingDrop: null, buildsByDay: [], lastCompare: null,
  lastLogicCompare: null,
};

export function leaseOf(x: unknown): Lease {
  const l = x as any;
  return l && typeof l === "object" && typeof l.runId === "string" && typeof l.expiresAt === "string"
    ? { runId: l.runId, startedAt: String(l.startedAt ?? ""), expiresAt: l.expiresAt } : null;
}

/** The stored state, with every field present. */
export function stateOrEmpty(raw: unknown): State {
  if (!raw || typeof raw !== "object") return { ...EMPTY_STATE, buildsByDay: [] };
  const r = raw as Record<string, any>;
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  return {
    lease: leaseOf(r.lease),
    snapshotId: str(r.snapshotId),
    version: typeof r.version === "number" ? r.version : null,
    serve: r.serve === "pilot" || r.serve === "all" ? r.serve : "none",
    why: str(r.why),
    builtAt: str(r.builtAt),
    lastOk: r.lastOk && typeof r.lastOk === "object" ? r.lastOk : null,
    lastAttempt: r.lastAttempt && typeof r.lastAttempt === "object" ? r.lastAttempt : null,
    firstFailAt: str(r.firstFailAt),
    pendingDrop: r.pendingDrop && typeof r.pendingDrop === "object" && typeof r.pendingDrop.at === "string"
      ? {
          at: r.pendingDrop.at, enrolled: Number(r.pendingDrop.enrolled),
          rows: typeof r.pendingDrop.rows === "number" ? r.pendingDrop.rows : null, syncAt: str(r.pendingDrop.syncAt),
        } : null,
    buildsByDay: Array.isArray(r.buildsByDay) ? r.buildsByDay.filter((d: any) => d && typeof d.day === "string") : [],
    lastCompare: r.lastCompare && typeof r.lastCompare === "object" ? r.lastCompare : null,
    lastLogicCompare: r.lastLogicCompare && typeof r.lastLogicCompare === "object" ? r.lastLogicCompare : null,
  };
}

/** One more build (or refusal) on a day, keeping the last eight days. */
export function bumpDay(days: ReadonlyArray<DayCount>, day: string, add: { builds?: number; refusals?: number; bytesRead?: number }): DayCount[] {
  const out = days.map((d) => ({ day: d.day, builds: d.builds || 0, refusals: d.refusals || 0, bytesRead: d.bytesRead || 0 }));
  let row = out.find((d) => d.day === day);
  if (!row) { row = { day, builds: 0, refusals: 0, bytesRead: 0 }; out.push(row); }
  row.builds += add.builds ?? 0;
  row.refusals += add.refusals ?? 0;
  row.bytesRead += add.bytesRead ?? 0;
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)).slice(-8);
}

// ===========================================================================
// The clock
// ===========================================================================

/**
 * THE SIS SYNC'S WINDOWS, UTC: [13:00, 13:15), [13:25, 14:00), [19:00, 19:15)
 * and [19:25, 20:00). The sync replaces the roster wholesale at 13:00 and
 * 19:00, and the absence rebuild and its retry run at 13:30 and 19:30. A build
 * started inside them reads a half-replaced roster or competes with jobs the
 * whole app depends on. 13:18 and 19:18 stay open so the first board after
 * each sync is at most about 45 minutes old.
 *
 * UTC, NOT SCHOOL TIME, because the jobs it protects are fixed in UTC and
 * drift an hour across the clock change themselves.
 */
export function inSyncWindow(nowIso: string): boolean {
  const t = new Date(Date.parse(nowIso));
  if (!Number.isFinite(t.getTime())) return false;
  const m = t.getUTCHours() * 60 + t.getUTCMinutes();
  const inside = (from: number, to: number) => m >= from && m < to;
  return inside(13 * 60, 13 * 60 + 15) || inside(13 * 60 + 25, 14 * 60) ||
    inside(19 * 60, 19 * 60 + 15) || inside(19 * 60 + 25, 20 * 60);
}

const minutesSince = (iso: string | null, nowMs: number): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? (nowMs - t) / 60000 : null;
};

/**
 * WHETHER THE COPY MUST STOP BEING SERVED, and why. Only in pilot or live, and
 * only while it is being served:
 *   - "failing": builds have failed (or been held) for failGraceMinutes;
 *   - "stale": the board is maxAgeMinutes old.
 * The next good build serves it again. Decided by the tick, never by the
 * query: Convex caches a query's answer until something it read changes, so a
 * clock read inside the query is not a clock anyone can rely on.
 */
export function staleReason(input: { mode: Mode; state: State; config: Config; nowIso: string }): null | "failing" | "stale" {
  const { mode, state, config } = input;
  if (mode !== "pilot" && mode !== "live") return null;
  if (state.serve === "none") return null;
  const nowMs = Date.parse(input.nowIso);
  const failing = minutesSince(state.firstFailAt, nowMs);
  if (failing !== null && failing >= config.failGraceMinutes) return "failing";
  const age = minutesSince(state.builtAt, nowMs);
  if (age === null || age >= config.maxAgeMinutes) return "stale";
  return null;
}

export type TickDecision = { build: boolean; markStale: null | "failing" | "stale"; why: string };

/**
 * BUILD NOW OR NOT, and whether to stop serving. In order:
 *   1. off: nothing.
 *   2. a build holding an unexpired lease: no build ("busy").
 *   3. inside a sync window: no build.
 *   4. no copy yet, or one written by an older compactStudent: build.
 *   5. (force, the CLI's runNow: build.)
 *   6. a held drop (enrolment, or the row count): build once it is
 *      DROP_RECHECK_MINUTES old, in or out of school hours, and not before.
 *   7. otherwise by age: schoolEveryMinutes on a weekday from 06:45 to 16:30
 *      school time, offHoursEveryMinutes otherwise, each less the slack.
 * Age is measured in UTC milliseconds, so the 1 November clock change cannot
 * move it; only which cadence applies is read off the school's wall clock.
 * With no time zone set, the school cadence applies (erring towards a fresher
 * board) and the reason says so.
 *
 * Stopping serving (staleReason) is decided beside all of this, so a sync
 * window or a busy lease never delays it.
 */
export function decideSnapshotTick(input: {
  mode: Mode; nowIso: string; tz: string | null; state: State; config: Config; force?: boolean;
}): TickDecision {
  const { mode, state, config } = input;
  if (mode === "off") return { build: false, markStale: null, why: "off" };
  const markStale = staleReason({ mode, state, config, nowIso: input.nowIso });
  const nowMs = Date.parse(input.nowIso);
  const none = (why: string): TickDecision => ({ build: false, markStale, why });
  const go = (why: string): TickDecision => ({ build: true, markStale, why });
  if (state.lease && Date.parse(state.lease.expiresAt) > nowMs) return none("busy");
  if (inSyncWindow(input.nowIso)) return none("sync-window");
  if (!state.snapshotId || !state.builtAt) return go("no-snapshot");
  if (state.version !== LEADERBOARD_SNAPSHOT_VERSION) return go("version");
  if (input.force) return go("forced");
  if (state.pendingDrop) {
    const held = minutesSince(state.pendingDrop.at, nowMs);
    return held !== null && held >= DROP_RECHECK_MINUTES ? go("drop-recheck") : none("drop-wait");
  }
  let school = true;
  let tzWhy = "";
  const lt = localSchoolTime(input.nowIso, input.tz);
  if (lt.ok) {
    school = lt.weekday >= 1 && lt.weekday <= 5 && lt.minuteOfDay >= SCHOOL_FROM_MINUTE && lt.minuteOfDay < SCHOOL_TO_MINUTE;
  } else {
    tzWhy = `; ${lt.code}, so the school cadence`;
  }
  const every = school ? config.schoolEveryMinutes : config.offHoursEveryMinutes;
  const age = minutesSince(state.builtAt, nowMs);
  const label = school ? "school-hours" : "off-hours";
  if (age === null || age >= every - CADENCE_SLACK_MINUTES) return go(`${label}${tzWhy}`);
  return none(`fresh (${label}${tzWhy})`);
}

// ===========================================================================
// Whether a build is kept
// ===========================================================================

export type BuildVerdict =
  | { verdict: "accept"; why: "first" | "steady" | "drop-confirmed" | "drop-new-sync" | "rows-confirmed" }
  | { verdict: "refuse"; code: "roster-moved" | "no-rows" | "too-many-rows" }
  | { verdict: "hold"; code: "drop-held" | "rows-held"; pendingDrop: NonNullable<PendingDrop> };

/**
 * KEEP WHAT A BUILD READ, OR NOT. A refused or held build leaves the last
 * good copy serving (until failGraceMinutes), so a doubtful read costs a
 * slightly older board, never a wrong one.
 *
 *   - THE ROSTER MOVED DURING THE BUILD (the two-row fingerprint changed): the
 *     sync's clearRoster deletes oldest-first and upsertRoster inserts new
 *     rows, so a replace in progress changes the oldest or newest roster row,
 *     and half the school would read as having left.
 *   - NO ROWS: refused (every viewer would read as new and be ranked alone).
 *   - FEWER ROWS THAN LAST TIME: no code deletes students (the sync archives
 *     nobody), so a fall is first taken for a paging fault and HELD; it is
 *     kept when a build at least 20 minutes later reads the same count (and
 *     enrolment within 2). Refusing it outright, as the first version did,
 *     meant one student row deleted by hand in the dashboard (the duplicate
 *     behind a dupIds entry, say) wedged the copy for good: every build
 *     refused, the copy stopped after the grace, and the tick rebuilt every
 *     15 minutes round the clock. Found by review, 2026-10-13.
 *   - MORE THAN 7,000 ROWS: refused loudly, far before the 8,192 array limit.
 *   - ENROLMENT FELL BY MORE THAN max(15, 3%) WITH NO NEWER SYNC: a half-
 *     cleared roster left by a sync that died. Held, and kept only when a
 *     build at least 20 minutes later agrees within 2 students, or when a
 *     newer sync has landed. (Today's live board serves that half roster at
 *     once; the copy waits.)
 *   - Anything else, including the first build, a small drop and any rise,
 *     is kept.
 *
 * `nowIso` is when this build started reading; `pendingDrop.at` is when the
 * build that first saw the drop started.
 */
export function acceptBuild(input: {
  prev: { rows: number; enrolled: number; syncAt: string | null } | null;
  pendingDrop: PendingDrop;
  rows: number;
  enrolled: number;
  rosterSteady: boolean;
  syncAtNow: string | null;
  nowIso: string;
}): BuildVerdict {
  const { prev, rows, enrolled } = input;
  if (!input.rosterSteady) return { verdict: "refuse", code: "roster-moved" };
  if (rows <= 0) return { verdict: "refuse", code: "no-rows" };
  if (rows > MAX_ROWS) return { verdict: "refuse", code: "too-many-rows" };
  if (!prev) return { verdict: "accept", why: "first" };
  const p = input.pendingDrop;
  const heldEnough = (q: NonNullable<PendingDrop>) => {
    const held = minutesSince(q.at, Date.parse(input.nowIso));
    return held !== null && held >= DROP_RECHECK_MINUTES;
  };
  // A new hold starts from this build; a re-read that agrees too soon keeps
  // the first one's time, so the wait is never restarted by agreeing.
  const hold = (code: "drop-held" | "rows-held"): BuildVerdict =>
    ({ verdict: "hold", code, pendingDrop: { at: input.nowIso, enrolled, rows, syncAt: input.syncAtNow } });
  if (rows < prev.rows) {
    if (p && p.rows === rows && Math.abs(enrolled - p.enrolled) <= DROP_AGREE) {
      return heldEnough(p) ? { verdict: "accept", why: "rows-confirmed" } : { verdict: "hold", code: "rows-held", pendingDrop: p };
    }
    return hold("rows-held");
  }
  const drop = prev.enrolled - enrolled;
  if (drop <= Math.max(15, 0.03 * prev.enrolled)) return { verdict: "accept", why: "steady" };
  const newerSync = input.syncAtNow !== null && (prev.syncAt === null || input.syncAtNow > prev.syncAt);
  if (newerSync) return { verdict: "accept", why: "drop-new-sync" };
  if (p && Math.abs(enrolled - p.enrolled) <= DROP_AGREE) {
    return heldEnough(p) ? { verdict: "accept", why: "drop-confirmed" } : { verdict: "hold", code: "drop-held", pendingDrop: p };
  }
  return hold("drop-held");
}

// ===========================================================================
// Switching live
// ===========================================================================

/**
 * NOT LIVE WITHOUT A CLEAN COMPARE ON RECORD: a "logic" compare (every student
 * as viewer, every band, topN 10 and 50, the copy against the live ranking on
 * the same read) that found no difference in at least one comparison, within
 * the last 72 hours, made by this version of compactStudent. Null when
 * switching is allowed, else the reason.
 *
 * Given the last LOGIC compare (state.lastLogicCompare), not the last compare
 * of any kind: the runbook runs fresh compares after the logic one, and they
 * used to overwrite it, so following it to the letter was refused. And a
 * compare of the old format says nothing about a copy a deploy has changed.
 * (Review, 2026-10-13.)
 */
export function liveRefusal(lastLogicCompare: Record<string, any> | null, nowIso: string): string | null {
  const c = lastLogicCompare;
  if (!c) return "No logic compare is on record. Run leaderboardSnapshot:compare with kind logic first.";
  if (c.kind !== "logic") return "The compare on record is not a logic compare.";
  if (c.version !== LEADERBOARD_SNAPSHOT_VERSION) {
    return "The last logic compare was made by another version of the copy. Run leaderboardSnapshot:compare with kind logic again.";
  }
  if (!(typeof c.comparisons === "number" && c.comparisons > 0)) return "The last compare compared nothing.";
  if (c.differ !== 0) return `The last logic compare found ${Number(c.differ)} difference(s).`;
  const age = minutesSince(typeof c.at === "string" ? c.at : null, Date.parse(nowIso));
  if (age === null || age > COMPARE_VALID_HOURS * 60) return `The last logic compare is more than ${COMPARE_VALID_HOURS} hours old.`;
  return null;
}

/**
 * N PILOT STUDENTS, spread evenly through the enrolled rows of the copy:
 * deterministic, so the same command picks the same students, and spread so
 * they are not all from one year group (rows are in the order students were
 * added). Duplicated ids are left out: they are always ranked live.
 */
export function spreadSample(rows: ReadonlyArray<{ id: string; enrolled?: false }>, dupIds: ReadonlyArray<string>, n: number): string[] {
  const pool = rows.filter((r) => r.enrolled !== false && r.id && !dupIds.includes(r.id)).map((r) => r.id);
  const k = Math.max(0, Math.min(Math.floor(n), pool.length));
  const out: string[] = [];
  for (let i = 0; i < k; i++) out.push(pool[Math.floor((i * pool.length) / k)]);
  return [...new Set(out)];
}

// ===========================================================================
// The compare: does the copy give the answer the live read gives?
// ===========================================================================

export const COMPARE_BANDS = ["academy", "hs", "ms"] as const;
export const COMPARE_TOP_N = [10, 50] as const;
const RESULT_FIELDS = ["top", "total", "unknownAmount", "notYetEarned", "viewer", "band", "bandLabel"] as const;

export type CompareCounts = {
  viewers: number;
  enrolledViewers: number;
  comparisons: number;
  identical: number;
  differ: number;
  byField: Record<(typeof RESULT_FIELDS)[number], number>;
  fallbacksByReason: Record<string, number>;
  rowsChangedSinceBuild: number;
  dupIds: number;
};

/**
 * EVERY STUDENT AS THE VIEWER, every band, the top 10 and the top 50: the
 * board leaderboard:cash would serve from the copy against the board the live
 * read gives, on the same read of the students table. COUNTS ONLY: which
 * field differed, never whose board or what it said.
 *
 * `live` is each student row's scalar fields plus `enrolled`, read by
 * comparePage, which does NOT go through compactStudent. That independence is
 * the point: the compare tests compactStudent rather than repeating it.
 *
 *   - "logic": the copy is built from these same rows, so nothing is out of
 *     date and any difference is a fault in the copy. The switch to live
 *     requires one of these with no difference (liveRefusal).
 *   - "fresh": the stored copy, as served. Differences are how many answers
 *     staleness touches, and rowsChangedSinceBuild says how many students
 *     moved since it was built. A fresh compare on a copy left over from the
 *     morning must find differences; that proves the compare can see drift.
 *
 * A viewer the copy cannot place is counted by reason and not compared:
 * leaderboard:cash ranks that viewer live, so their answer is live by
 * construction.
 */
export function compareSnapshot(
  live: ReadonlyArray<Record<string, any>>,
  kind: "logic" | "fresh",
  stored: { rows: ReadonlyArray<SnapRow>; dupIds: ReadonlyArray<string>; newestCreationTime: number } | null,
): CompareCounts {
  const compactLive = live.map((r) => compactStudent(r, r.enrolled === true));
  const snap = kind === "logic" || !stored
    ? {
        rows: compactLive,
        dupIds: duplicateIds(compactLive),
        newestCreationTime: live.reduce((a, r) => Math.max(a, Number(r._creationTime) || 0), 0),
      }
    : stored;
  let rowsChangedSinceBuild = 0;
  if (kind === "fresh" && stored) {
    compactLive.forEach((row, i) => {
      if (i >= stored.rows.length || JSON.stringify(row) !== JSON.stringify(stored.rows[i])) rowsChangedSinceBuild++;
    });
  }
  const byField = Object.fromEntries(RESULT_FIELDS.map((f) => [f, 0])) as CompareCounts["byField"];
  const fallbacksByReason: Record<string, number> = {};
  let comparisons = 0, identical = 0, differ = 0, enrolledViewers = 0;
  for (const me of live) {
    if (me.enrolled === true) enrolledViewers++;
    const id = studentIdOf(me);
    const placed = placeViewer(snap, { id, row: compactStudent(me, me.enrolled === true), creationTime: Number(me._creationTime) || 0 });
    if (!placed.ok) {
      fallbacksByReason[placed.why] = (fallbacksByReason[placed.why] || 0) + 1;
      continue;
    }
    for (const band of COMPARE_BANDS) {
      for (const topN of COMPARE_TOP_N) {
        const a = cashLeaderboard({ students: placed.students, band, topN, viewerId: id }) as Record<string, unknown>;
        const b = cashLeaderboard({ students: live as any[], band, topN, viewerId: id }) as Record<string, unknown>;
        comparisons++;
        let same = true;
        for (const f of RESULT_FIELDS) {
          if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) { byField[f]++; same = false; }
        }
        if (same) identical++; else differ++;
      }
    }
  }
  return {
    viewers: live.length, enrolledViewers, comparisons, identical, differ, byField, fallbacksByReason,
    rowsChangedSinceBuild, dupIds: snap.dupIds.length,
  };
}
