import { internalMutation, internalQuery, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { CASH_COUNTERS, cashMovementEffect, isSystemCashRow } from "./appDataShape";
import { cashWeekKey } from "./cashReversalRules";
import { doReverse } from "./cashReversal";
import { CASH_ZERO_POINT_KEY } from "./cashArrivalRules";
import * as R from "./perfectDayRules";
import { requireAdmin } from "./identity";

/**
 * THE AUTOMATIC PERFECT-DAY AWARD: the server half that writes.
 * (Build spec 2026-10-12; every decision is a pure rule in perfectDayRules.ts.)
 *
 * HOW A MORNING GOES. The cron fires `tick` at :42 past 14-17 UTC. The tick
 * turns now into the school's wall clock and, on a weekday morning (06:30 to
 * 11:00 school time) when today's run is not done, books ONE run together
 * with a lease (perfectDayRead.run, an action: it needs PowerSchool). The run
 * reads the last fifteen school days, hands each date's verdict to `applyDate`,
 * expires what stayed held past the lookback, and on the first good run on or
 * after Monday pays the week through `payBatch`, fifty students a mutation.
 * Every write re-checks the lease and the switch first, so turning the switch
 * off stops the next batch, and a run Convex killed is simply run again: the
 * register makes every step safe to repeat.
 *
 * THE MONEY IS WRITTEN THE WAY THE STORE PURCHASE WRITES IT (studentStore.ts):
 * in one transaction per student, the four counters move by the movement's
 * own effect from the server's numbers, the row joins the student's history,
 * the ledger row goes into its week WITH NO KEY, and the register rows are
 * marked paid with the movement's id. It does NOT write the settings row
 * (every staff tab would reload), the 24-slot cashApplied list (it would
 * crowd out a stuck teacher's protection) or cashAwardCommands, and it writes
 * no audit entry per student (one summary per payday, and only when switched
 * on: an action the open tabs do not know reaches every teacher's feed).
 *
 * NOTHING HERE CHANGES ANYTHING FROM A BROWSER. Every function that writes is
 * internal, for the cron, the run and the command line. Two things are read
 * from a browser: perfectDaysForStudent, which views_app.myStudentView calls
 * for the student signed in, and adminStatus, the admin card on the Cash
 * Audit Log (requireAdmin, read-only: the same answer as perfectDay:status).
 *
 * THE COMMAND LINE (deploy key only):
 *   npx convex run perfectDay:configure '{"mode":"shadow","actorName":"..."}'
 *   npx convex run perfectDay:configure '{"mode":"pilot","pilotAdd":["..."],"controls":["..."],"actorName":"..."}'
 *   npx convex run perfectDay:configure '{"mode":"off","actorName":"..."}'      <- the kill switch (pending days wait, they are not lost)
 *   npx convex run perfectDay:forfeitPending '{"from":"...","to":"...","reason":"...","actorName":"..."}'   <- counts; add "apply":true to forfeit
 *   npx convex run perfectDay:releaseUnchecked '{"date":"...","reason":"...","actorName":"..."}'   <- counts; add "apply":true to release
 *   npx convex run perfectDay:status
 *   npx convex run perfectDay:correctPayout '{"txnId":"txn_...","removeDates":["2026-10-14"],"reason":"...","actorName":"..."}'
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
/** A register day that still stands: re-read and settled whatever the start date says now. */
const STANDING = ["pending", "held", "broken", "paid"] as const;
export async function loadSettings(ctx: Ctx): Promise<R.Settings> {
  return R.settingsOrDefault(await readState(ctx, R.SETTINGS_KEY));
}
/** The school's time zone, from Settings > Bell Schedule. No zone, no run: the dates would be wrong. */
async function schoolTimeZone(ctx: Ctx): Promise<string | null> {
  const row = await ctx.db.query("bellSettings").withIndex("by_key", (q) => q.eq("key", "bell")).first();
  return row?.timeZone ?? null;
}
const leaseOf = (x: any): R.Lease =>
  x && typeof x === "object" && typeof x.runId === "string" && typeof x.expiresAt === "string"
    ? { runId: x.runId, startedAt: String(x.startedAt ?? ""), expiresAt: x.expiresAt } : null;
async function audit(ctx: MutationCtx, by: string, action: string, detail: unknown): Promise<void> {
  await ctx.db.insert("perfectDayAudit", { at: new Date().toISOString(), by: String(by || "unknown"), action, detail: detail ?? null });
}
const settingsSummary = (s: R.Settings) => ({
  mode: s.mode, amount: s.amount, countFromDate: s.countFromDate, liveFrom: s.liveFrom,
  pilot: s.pilot.length, controls: s.controls.length, lookbackSchoolDays: s.lookbackSchoolDays, auditSummary: s.auditSummary,
});

/**
 * Is `runId` still THE run, and is the switch still on? Asked first by every
 * write the run makes. A run that has lost its lease (a later run took over
 * after it lapsed) or finds the switch off writes nothing.
 */
async function liveRun(ctx: MutationCtx, runId: string): Promise<{ ok: true; settings: R.Settings } | { ok: false; reason: string }> {
  const lease = leaseOf(await readState(ctx, R.LEASE_KEY));
  if (!lease || lease.runId !== runId) return { ok: false, reason: "This run no longer holds the lease." };
  if (Date.parse(lease.expiresAt) <= Date.now()) return { ok: false, reason: "This run's lease has lapsed." };
  const settings = await loadSettings(ctx);
  if (settings.mode === "off") return { ok: false, reason: settings.invalid ?? "Switched off." };
  return { ok: true, settings };
}

// ===========================================================================
// The tick
// ===========================================================================

async function bookRun(ctx: MutationCtx, trigger: string, force: boolean): Promise<Record<string, any>> {
  const settings = await loadSettings(ctx);
  const tz = await schoolTimeZone(ctx);
  const state = (await readState(ctx, R.STATE_KEY)) ?? {};
  const lease = leaseOf(await readState(ctx, R.LEASE_KEY));
  const nowIso = new Date().toISOString();
  const d = R.decideTick({ mode: settings.mode, nowIso, tz, lastDoneDate: state.lastDoneDate ?? null, lease, force });
  if (d.do === "none") return { do: "none", why: settings.invalid ?? d.why };
  const runId = `pd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await writeState(ctx, R.LEASE_KEY, {
    runId, startedAt: nowIso, expiresAt: new Date(Date.parse(nowIso) + R.LEASE_MS).toISOString(),
  });
  await ctx.db.insert("perfectDayRuns", { runId, trigger, today: d.today, startedAt: nowIso });
  await ctx.scheduler.runAfter(0, internal.perfectDayRead.run, { runId, today: d.today, minute: d.minute, startedAt: nowIso, tz: tz! });
  return { do: "run", runId, today: d.today };
}

/**
 * The cron's handler (crons.ts). Switched off -- the repo default, and what a
 * missing settings row means -- it reads one row and stops.
 */
export const tick = internalMutation({
  args: {},
  handler: async (ctx): Promise<Record<string, any>> => bookRun(ctx, "tick", false),
});

/** Run now, whatever the hour (still one run at a time, still nothing when off). CLI only. */
export const runNow = internalMutation({
  args: { actorName: v.optional(v.string()) },
  handler: async (ctx, { actorName }): Promise<Record<string, any>> => {
    const out = await bookRun(ctx, `by hand: ${actorName ?? "cli"}`, true);
    if (out.do === "run") await audit(ctx, actorName ?? "cli", "runNow", { runId: out.runId });
    return out;
  },
});

// ===========================================================================
// What the run needs to know
// ===========================================================================

export const runContext = internalQuery({
  args: { today: v.string() },
  handler: async (ctx, { today }) => {
    const settings = await loadSettings(ctx);
    const state = (await readState(ctx, R.STATE_KEY)) ?? {};
    const from = R.addDays(today, -R.CALENDAR_REACH_DAYS);
    const marks: Record<string, R.Marked> = {};
    for (const m of await ctx.db.query("bellScheduleDays").withIndex("by_date", (q) => q.gte("date", from).lt("date", today)).collect()) {
      marks[m.date] = { noSchool: !!m.noSchool, scheduled: !!m.scheduleId };
    }
    const dates = await ctx.db.query("perfectDayDates").withIndex("by_date", (q) => q.gte("date", from).lt("date", today)).collect();
    // DAYS DECIDED BEFORE THE START (2026-10-12 review). Every switch from off
    // to on moves countFromDate to that day, so a date decided before it is
    // never decided again; but its days that still stand (pending, held,
    // broken, paid) are re-read and settled like any other's, so a known break
    // is applied and a held day released. One index probe per date and status.
    const settleDates: string[] = [];
    const fence = settings.countFromDate && settings.countFromDate < today ? settings.countFromDate : today;
    for (let d = from; d < fence; d = R.addDays(d, 1)) {
      for (const status of STANDING) {
        if (await ctx.db.query("perfectDays").withIndex("by_status_date", (q) => q.eq("status", status).eq("date", d)).first()) {
          settleDates.push(d);
          break;
        }
      }
    }
    return {
      settings,
      lastPayWeek: typeof state.lastPayWeek === "string" ? state.lastPayWeek : null,
      marks,
      adminNoSchool: dates.filter((d) => d.adminNoSchool).map((d) => d.date),
      decideAnyway: dates.filter((d) => d.adminDecideAnyway).map((d) => d.date),
      // Decided by the job's own checks: the blocks those days ran are days the school runs (judgeDay).
      decided: dates.filter((d) => d.state === "school" && !d.adminDecideAnyway).map((d) => d.date),
      settleDates,
    };
  },
});

/** No action outlives Convex's 10 minutes, so a rebuild's write lock older than this is dead. */
const REBUILD_DEAD_AFTER_MS = 10 * 60 * 1000;

/**
 * THE PERFECT ATTENDANCE SCREEN'S VIEW, for the second check: per student,
 * the dates in [from, to] its default rule calls not perfect (any absence,
 * any unexcused tardy -- every tardy for a row the rebuild has not refilled,
 * exactly as wildcat-roster.js perfectVerdict reads it).
 *
 * NEVER READ MID-REBUILD. The rebuild clears and refills psAttendanceMarks
 * across several mutations, holding its write lock throughout; a query sees
 * one snapshot, so the lock and the table are read together. A rebuild that
 * failed while writing since the last good one means the table may be short:
 * no second check. `asOf` is the school date the last good rebuild started on,
 * so the check is only used for days that ended before it.
 *
 * An array, not an object keyed by student: Convex caps an object's fields.
 */
export const screenMarks = internalQuery({
  args: { from: v.string(), to: v.string(), tz: v.string() },
  handler: async (ctx, { from, to, tz }) => {
    const no = (reason: string) => ({ available: false, reason, asOf: null as string | null, rows: [] as Array<{ sn: string; entry: string | null; bad: string[] }> });
    const rb = ((await readState(ctx, "attendanceRebuild")) ?? {}) as Record<string, any>;
    // ANY WRITE LOCK MEANS NO: a live one is a rebuild writing right now; a
    // dead one is a rebuild that died while writing, and its tables may be
    // short until the next good run (the lock is cleared only by a finish, or
    // filed as abandoned by the next run's start).
    const w = rb.writing;
    if (w) {
      return no(Date.now() - Date.parse(String(w.startedAt)) < REBUILD_DEAD_AFTER_MS
        ? "The attendance rebuild is writing its tables right now."
        : "An attendance rebuild stopped while writing, so the screen's tables may be incomplete.");
    }
    const lastOk = rb.lastOk;
    if (!lastOk || !lastOk.startedAt) return no("No good attendance rebuild is on record.");
    const last = rb.last;
    if (last && last.ok !== true && last.stage === "write" && String(last.startedAt ?? "") > String(lastOk.startedAt)) {
      return no("The last attendance rebuild failed while writing, so the screen's tables may be incomplete.");
    }
    const asOf = R.schoolDateOf(String(lastOk.startedAt), tz);
    const rows: Array<{ sn: string; entry: string | null; bad: string[] }> = [];
    for (const r of await ctx.db.query("psAttendanceMarks").take(4000)) {
      const tardies = Array.isArray(r.unexcusedTardyDates) ? r.unexcusedTardyDates : r.tardyDates;
      const bad = [...new Set([...(r.absentDates ?? []), ...(tardies ?? [])])].filter((d) => d >= from && d <= to).sort();
      rows.push({ sn: String(r.studentNumber), entry: r.entryDate ?? null, bad });
    }
    return { available: true, reason: "", asOf, rows };
  },
});

// ===========================================================================
// One date, written
// ===========================================================================

const personArg = v.object({
  sn: v.string(), div: v.optional(v.union(v.string(), v.null())), why: v.optional(v.string()), existingOnly: v.optional(v.boolean()),
});

/**
 * One judged date into the register (perfectDayRules.planDateRows) and its
 * date record. A date before the start is never DECIDED: nothing is inserted
 * for it. But one decided before the switch last came on still has its days
 * that stand settled by its own stamps (existingOnly), so a pause never pays
 * over a known break nor lets a held day expire unread (2026-10-12 review).
 *
 * A DATE ALREADY DECIDED STAYS DECIDED. When its re-read failed (a read or a
 * count that will be tried again), or PowerSchool or the calendar now says no
 * school while days are pending, held or paid for it, its record keeps
 * "decided" with a note and no day changes: a date-level "held" would later
 * expire as "not paid" over days that were paid. Those days stand until an
 * admin takes them out (removeDays, or correctPayout for a paid one); once
 * none is pending, held or paid (markNoSchool's own test), "no school" sticks.
 *
 * A DATE ALREADY DECIDED WHOSE RE-READ IS HELD (too perfect, a block missing,
 * rows out of place, the screen disputing more than 1%) is not paid over
 * (2026-10-12 review): what the read shows that makes a day NOT payable still
 * applies (a disputed student's pending day is held, a pending day the read
 * shows broken is broken, a paid one is flagged), and nothing new becomes
 * payable. Its record stays "decided", with the re-read's reason, because its
 * days stand: a date-level "held" would later expire as "not paid" over days
 * that were paid. A read that FAILED (retryable) knows nothing and changes no
 * day.
 */
export const applyDate = internalMutation({
  args: {
    runId: v.string(), date: v.string(),
    state: v.union(v.literal("school"), v.literal("no-school"), v.literal("held")),
    reason: v.string(), retryable: v.boolean(), checked: v.boolean(),
    perfect: v.array(personArg), held: v.array(personArg), broken: v.array(personArg),
    counts: v.any(), rowCounts: v.any(),
  },
  handler: async (ctx, a) => {
    const live = await liveRun(ctx, a.runId);
    if (!live.ok) return { stopped: true as const, reason: live.reason };
    const settings = live.settings;
    if (!settings.countFromDate) return { skipped: true as const, reason: "Before the start date." };
    const now = new Date().toISOString();
    const existing = await ctx.db.query("perfectDays").withIndex("by_date", (q) => q.eq("date", a.date)).collect();
    const standing = existing.filter((r) => (STANDING as readonly string[]).includes(r.status)).length;
    const beforeStart = a.date < settings.countFromDate;
    if (beforeStart && !standing) return { skipped: true as const, reason: "Before the start date." };
    const rec = await ctx.db.query("perfectDayDates").withIndex("by_date", (q) => q.eq("date", a.date)).first();
    const failed = a.state === "held" && a.retryable;
    // What blocks "no school": the days markNoSchool itself refuses over (a broken or removed day is no money either way).
    const owed = existing.filter((r) => r.status === "pending" || r.status === "held" || r.status === "paid").length;
    if (existing.length && (failed || (a.state === "no-school" && owed))) {
      const why = failed
        ? `This run's re-read failed (${a.reason}); tried again on the next run.`
        : `PowerSchool or the calendar now says no school (${a.reason}), but ${owed} perfect days are pending, held or paid for it. `
          + "They stand until an admin takes them out (perfectDay:removeDays, or correctPayout for a paid one).";
      const note = {
        state: "school" as const, retryable: failed, runId: a.runId, updatedAt: now,
        reason: `Decided on an earlier run. ${why}`,
        counts: { ...((rec?.counts as Record<string, any>) ?? {}), recheck: { at: now, reason: a.reason, register: null } },
      };
      if (rec) await ctx.db.patch(rec._id, note);
      else await ctx.db.insert("perfectDayDates", { date: a.date, firstDecidedAt: now, rowCounts: {}, ...note });
      return { ok: true as const, state: "school" as const, recheckHeld: true, retryable: failed, register: null };
    }
    const state: "school" | "no-school" | "held" = a.state;
    const recheckHeld = a.state === "held" && !a.retryable && existing.length > 0;
    let register: Record<string, number> | null = null;
    if (state === "school" || recheckHeld) {
      const plan = R.planDateRows({
        date: a.date, now, runId: a.runId, settings, existing: existing as unknown as R.RegRow[],
        judgement: {
          perfect: a.perfect.map((p) => ({ sn: p.sn, div: p.div ?? null, ...(p.existingOnly ? { existingOnly: true } : {}) })),
          held: a.held.map((h) => ({ sn: h.sn, why: h.why, div: h.div ?? null, ...(h.existingOnly ? { existingOnly: true } : {}) })),
          broken: a.broken.map((b) => ({ sn: b.sn, why: b.why ?? "marked" })),
          checked: a.checked,
        },
        onlyNotPayable: recheckHeld,
        existingOnly: beforeStart,
      });
      for (const ins of plan.inserts) await ctx.db.insert("perfectDays", ins as any);
      for (const p of plan.patches) await ctx.db.patch(p.id, p.patch as any);
      register = plan.counts;
    }
    if (recheckHeld) {
      // The date's earlier counts stand: this read was not believed, so its figures are not shown as the day's.
      const note = {
        state: "school" as const, retryable: false, runId: a.runId, updatedAt: now,
        reason: `Decided on an earlier run. This run's re-read was held (${a.reason}), so only what makes a day NOT payable was applied.`,
        counts: { ...((rec?.counts as Record<string, any>) ?? {}), recheck: { at: now, reason: a.reason, register } },
      };
      if (rec) await ctx.db.patch(rec._id, note);
      else await ctx.db.insert("perfectDayDates", { date: a.date, firstDecidedAt: now, rowCounts: a.rowCounts ?? {}, ...note });
      return { ok: true as const, state: "school" as const, recheckHeld: true, retryable: false, register };
    }
    const reason = beforeStart && state === "school"
      ? `${a.reason} Decided before the switch last came on: only the days already decided were settled.` : a.reason;
    const fields = {
      state, reason, retryable: a.retryable, runId: a.runId, updatedAt: now,
      counts: { ...(a.counts ?? {}), ...(register ? { register } : {}) }, rowCounts: a.rowCounts ?? {},
    };
    if (rec) await ctx.db.patch(rec._id, fields);
    else await ctx.db.insert("perfectDayDates", { date: a.date, firstDecidedAt: now, ...fields });
    return { ok: true as const, state, recheckHeld: false, retryable: state === "held" && a.retryable, register };
  },
});

/**
 * What stayed HELD until it left the lookback is not paid: the date and its
 * held students become "expired" (review H3: a hold never lasts for ever).
 *
 * EXCEPT A DAY HELD ONLY FOR THE SECOND CHECK (2026-10-12 review). PowerSchool
 * found it perfect and the check never ran on it (the attendance rebuild was
 * down or writing): that is not a doubt about the day, and an outage longer
 * than the lookback must not forfeit the whole school's oldest days. It stays
 * held, counted on the status, until an admin releases the date in one call
 * (releaseUnchecked) or takes it out (forfeitPending, resolveHeld).
 */
export const expireOld = internalMutation({
  args: { runId: v.string(), before: v.string() },
  handler: async (ctx, { runId, before }) => {
    const live = await liveRun(ctx, runId);
    if (!live.ok) return { stopped: true as const, reason: live.reason };
    const now = new Date().toISOString();
    let dates = 0, rows = 0;
    for (const d of await ctx.db.query("perfectDayDates").withIndex("by_state_date", (q) => q.eq("state", "held").lt("date", before)).take(500)) {
      await ctx.db.patch(d._id, { state: "expired", reason: `Still held when it left the lookback: not paid. (${d.reason})`, updatedAt: now, runId });
      dates++;
    }
    for (const r of await ctx.db.query("perfectDays").withIndex("by_status_date", (q) => q.eq("status", "held").lt("date", before)).take(4000)) {
      if (r.why === R.UNCHECKED) continue;
      await ctx.db.patch(r._id, { status: "expired", why: `held-past-lookback${r.why ? `: ${r.why}` : ""}`, updatedAt: now, runId });
      rows++;
    }
    return { ok: true as const, dates, rows };
  },
});

// ===========================================================================
// Payday
// ===========================================================================

/** The students with a pending day before this week. Student numbers only. */
export const payPlan = internalQuery({
  args: { before: v.string() },
  handler: async (ctx, { before }) => {
    const rows = await ctx.db.query("perfectDays").withIndex("by_status_date", (q) => q.eq("status", "pending").lt("date", before)).take(20000);
    return { students: [...new Set(rows.map((r) => r.studentNumber))].sort(), rows: rows.length, capped: rows.length === 20000 };
  },
});

async function studentByNumber(ctx: MutationCtx, sn: string): Promise<{ student: any | null; why: "none" | "ambiguous" | null }> {
  const rows = await ctx.db.query("students").withIndex("by_studentNumber", (q) => q.eq("studentNumber", sn)).take(2);
  if (rows.length > 1) return { student: null, why: "ambiguous" };
  if (!rows.length) return { student: null, why: "none" };
  return { student: rows[0], why: null };
}

/**
 * WRITE ONE MOVEMENT FOR ONE STUDENT, the way the store purchase does: the
 * counters from the server's own numbers, the history row appended, the
 * ledger row into the week its own timestamp belongs to (NO `key`), the
 * payout record, and every register row it pays marked paid. The caller
 * patches the student once with the counters and history this returns.
 */
async function writeMovement(ctx: MutationCtx, input: {
  student: any; appStudentId: string; counters: Record<string, number>; history: any[];
  sn: string; payWeek: string; part: number; payoutKey: string; ms: number; nowIso: string; runId: string;
  rows: Array<{ _id?: any; date: string; amount: number }>; replaces?: string;
}): Promise<{ txnId: string; amount: number }> {
  const at = new Date(input.ms).toISOString();
  const dates = input.rows.map((r) => r.date).sort();
  const amount = input.rows.reduce((s, r) => s + r.amount, 0);
  const txnId = R.payoutTxnId(input.ms, input.sn, input.replaces ? `${input.payWeek}>${input.replaces}` : input.payWeek, input.part);
  const effect = cashMovementEffect(amount, R.PERFECT_DAY_KIND);
  for (const f of CASH_COUNTERS) input.counters[f] = (input.counters[f] || 0) + (effect[f] || 0);
  const row = R.buildPayoutRow({
    txnId, at, appStudentId: input.appStudentId, student: input.student, amount, dates, balanceAfter: input.counters.wildcatCashBalance,
  });
  input.history.push(row);
  const weekKey = cashWeekKey(at);
  await ctx.db.insert("legacyMirror", { doc: "cash_tx_" + weekKey, collection: "transactions", payload: row, mirroredAt: input.nowIso });
  await ctx.db.insert("perfectDayPayouts", {
    payoutKey: input.payoutKey, studentNumber: input.sn, payWeek: input.payWeek, part: input.part, txnId, weekKey,
    amount, dates, status: "paid", paidAt: at, runId: input.runId, ...(input.replaces ? { replaces: input.replaces } : {}),
  });
  for (const r of input.rows) {
    await ctx.db.patch(r._id, { status: "paid", why: undefined, paidTxnId: txnId, paidAt: at, updatedAt: input.nowIso, runId: input.runId });
  }
  return { txnId, amount };
}

const countersOf = (student: any): Record<string, number> => {
  const c: Record<string, number> = {};
  for (const f of CASH_COUNTERS) { const n = Number(student?.[f]); c[f] = Number.isFinite(n) ? n : 0; }
  return c;
};

/**
 * PAY UP TO FIFTY STUDENTS. Per student, in this one transaction: their
 * pending days before this week that were stamped payable when decided, not
 * a control (perfectDayRules.planPayout); one movement (split only past $5,000); the
 * register rows marked paid. ONCE PER STUDENT-WEEK: a movement already
 * recorded for (student, payWeek) means a day that became pending since then
 * waits for next week. A student number with no Hub record, or with two, is
 * never paid a guess: the days stay pending and are counted (review M3).
 * Days from before a cash reset or the history cutoff are dropped, counted.
 */
export const payBatch = internalMutation({
  args: { runId: v.string(), payWeek: v.string(), students: v.array(v.string()), tz: v.string() },
  handler: async (ctx, a) => {
    const live = await liveRun(ctx, a.runId);
    if (!live.ok) return { stopped: true as const, reason: live.reason };
    const settings = live.settings;
    if (!R.paying(settings.mode)) return { stopped: true as const, reason: `No money moves in ${settings.mode} mode.` };
    const cutoffDate = R.schoolDateOf((await readState(ctx, "historyCutoff"))?.iso, a.tz);
    const zeroPointDate = R.schoolDateOf((await readState(ctx, CASH_ZERO_POINT_KEY))?.iso, a.tz);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    let tick = 0;
    const out = {
      ok: true as const, students: 0, movements: 0, days: 0, amount: 0,
      alreadyPaidThisWeek: 0, noHubRecord: 0, ambiguous: 0, dropped: 0, skipped: {} as Record<string, number>,
    };
    for (const sn of a.students.slice(0, R.PAY_BATCH)) {
      const rows = (await ctx.db.query("perfectDays").withIndex("by_student_date", (q) => q.eq("studentNumber", sn).lt("date", a.payWeek)).collect()) as unknown as R.RegRow[];
      const plan = R.planPayout({ sn, rows, settings, before: a.payWeek, zeroPointDate, cutoffDate });
      for (const s of plan.skipped) {
        out.skipped[s.why] = (out.skipped[s.why] ?? 0) + 1;
        if (s.why === "before-reset" || s.why === "before-cutoff") {
          await ctx.db.patch(s.row._id, { status: "expired", why: s.why, updatedAt: nowIso, runId: a.runId });
          out.dropped++;
        }
      }
      if (!plan.parts.length) continue;
      const already = await ctx.db.query("perfectDayPayouts").withIndex("by_payoutKey", (q) => q.eq("payoutKey", R.payoutKeyOf(sn, a.payWeek, 0))).first();
      if (already) { out.alreadyPaidThisWeek++; continue; }
      const found = await studentByNumber(ctx, sn);
      if (!found.student) { if (found.why === "ambiguous") out.ambiguous++; else out.noHubRecord++; continue; }
      const student = found.student;
      const appStudentId = String(student.legacyId ?? student.studentNumber ?? student._id);
      const counters = countersOf(student);
      const history = Array.isArray(student.wildcatCashTransactions) ? [...student.wildcatCashTransactions] : [];
      for (const part of plan.parts) {
        const w = await writeMovement(ctx, {
          student, appStudentId, counters, history, sn, payWeek: a.payWeek, part: part.part,
          payoutKey: R.payoutKeyOf(sn, a.payWeek, part.part), ms: nowMs + tick++, nowIso, runId: a.runId, rows: part.rows,
        });
        out.movements++;
        out.days += part.dates.length;
        out.amount += w.amount;
      }
      await ctx.db.patch(student._id, { ...counters, wildcatCashTransactions: history });
      out.students++;
    }
    return out;
  },
});

/**
 * The week is paid: remember it, so the next run this week does not pay again.
 * And, ONLY WHEN SWITCHED ON (settings.auditSummary), one summary entry in
 * the audit log for the whole payday, counts only (review M6: an action the
 * open tabs do not yet know would show on every teacher's home feed).
 */
export const finishPayday = internalMutation({
  args: { runId: v.string(), payWeek: v.string(), summary: v.any() },
  handler: async (ctx, a) => {
    const live = await liveRun(ctx, a.runId);
    if (!live.ok) return { stopped: true as const, reason: live.reason };
    const state = (await readState(ctx, R.STATE_KEY)) ?? {};
    await writeState(ctx, R.STATE_KEY, { ...state, lastPayWeek: a.payWeek, lastPaidAt: new Date().toISOString() });
    const s = a.summary ?? {};
    let audited = false;
    if (live.settings.auditSummary && Number(s.movements) > 0) {
      const at = new Date().toISOString();
      const entryId = `a_perfectday_${a.payWeek.replace(/-/g, "")}_${a.runId}`;
      const exists = await ctx.db.query("appAuditLog").withIndex("by_entryId", (q) => q.eq("entryId", entryId)).first();
      if (!exists) {
        const reason = `Perfect attendance paid for the week before ${R.shortDay(a.payWeek)}: ${Number(s.students) || 0} students, `
          + `${Number(s.days) || 0} perfect days.`;
        await ctx.db.insert("appAuditLog", {
          entryId, timestamp: at,
          // NO ticketCount (2026-10-12, the browser half). Every audit screen
          // reads money off that field, and this entry carries none: absent, it
          // reads as a dash; 0 read as "+$0". behavior and notes as their own
          // fields, so no screen splits the sentence at its first comma.
          payload: {
            entryId, timestamp: at, action: "perfect_day_paid", category: "Wildcat Cash",
            studentId: "all", studentName: "All students",
            teacher: R.SYSTEM_ACTOR.name, teacherName: R.SYSTEM_ACTOR.name, teacherId: R.SYSTEM_ACTOR.id,
            behavior: "Perfect attendance (automatic)", notes: reason,
            reason, details: reason,
          },
        });
        audited = true;
      }
    }
    return { ok: true as const, audited };
  },
});

/** Every run ends here, however it ended: the run record, the lease released, today marked done. */
export const finishRun = internalMutation({
  args: { runId: v.string(), today: v.string(), ok: v.boolean(), done: v.boolean(), reason: v.string(), summary: v.any() },
  handler: async (ctx, a) => {
    const now = new Date().toISOString();
    const run = await ctx.db.query("perfectDayRuns").withIndex("by_runId", (q) => q.eq("runId", a.runId)).first();
    if (run) await ctx.db.patch(run._id, { finishedAt: now, ok: a.ok, reason: a.reason, summary: a.summary ?? null });
    const lease = leaseOf(await readState(ctx, R.LEASE_KEY));
    const mine = !!lease && lease.runId === a.runId;
    if (mine) {
      await writeState(ctx, R.LEASE_KEY, null);
      const state = (await readState(ctx, R.STATE_KEY)) ?? {};
      await writeState(ctx, R.STATE_KEY, {
        ...state, lastRunId: a.runId, lastRunAt: now, lastRunOk: a.ok,
        ...(a.ok && a.done ? { lastDoneDate: a.today } : {}),
      });
    }
    return { ok: true, releasedLease: mine };
  },
});

// ===========================================================================
// The admin's tools (command line first)
// ===========================================================================

/**
 * THE SWITCH. Every rule about what a change means is perfectDayRules.planConfigure:
 * {"mode":"off"} is the kill switch, instant, no deploy; switching on counts
 * from today; back-pay needs countFromDate AND backPay: true. Server-side by
 * construction (an internal function: no browser can reach it).
 */
export const configure = internalMutation({
  args: {
    actorName: v.string(),
    mode: v.optional(v.union(v.literal("off"), v.literal("shadow"), v.literal("pilot"), v.literal("live"))),
    amount: v.optional(v.number()),
    pilotAdd: v.optional(v.array(v.string())),
    pilotRemove: v.optional(v.array(v.string())),
    controls: v.optional(v.array(v.string())),
    countFromDate: v.optional(v.string()),
    backPay: v.optional(v.boolean()),
    auditSummary: v.optional(v.boolean()),
    lookbackSchoolDays: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const actor = String(a.actorName ?? "").trim();
    if (actor.length < 2) return { ok: false as const, reason: "Say who is changing it (actorName)." };
    const tz = await schoolTimeZone(ctx);
    const today = tz ? R.schoolDateOf(new Date().toISOString(), tz) : null;
    if (!today) return { ok: false as const, reason: "No school time zone is set in Settings > Bell Schedule." };
    const prev = await loadSettings(ctx);
    const { actorName: _ignored, ...input } = a;
    const plan = R.planConfigure(prev, input, today);
    if (!plan.ok) return plan;
    const changedAt = new Date().toISOString();
    await writeState(ctx, R.SETTINGS_KEY, { ...plan.next, changedAt, changedBy: actor });
    await audit(ctx, actor, "configure", { from: settingsSummary(prev), to: settingsSummary(plan.next), notes: plan.notes });
    return { ok: true as const, settings: settingsSummary(plan.next), notes: plan.notes };
  },
});

async function dateRecord(ctx: MutationCtx, date: string) {
  return ctx.db.query("perfectDayDates").withIndex("by_date", (q) => q.eq("date", date)).first();
}

/**
 * "There was no school that day." Nothing for the date is read or decided
 * from the next run on. REFUSED while any perfect day is already pending,
 * held or paid for it: the mark would stop the reads but not the money, so
 * those are taken out first, on purpose (removeDays, or correctPayout for a
 * paid one). `undo` takes the mark off.
 */
export const markNoSchool = internalMutation({
  args: { date: v.string(), reason: v.string(), actorName: v.string(), undo: v.optional(v.boolean()) },
  handler: async (ctx, a) => {
    if (!R.isDay(a.date)) return { ok: false as const, reason: "date must be YYYY-MM-DD." };
    if (!a.undo && a.reason.trim().length < 3) return { ok: false as const, reason: "Say why." };
    if (!a.undo) {
      const decided = (await ctx.db.query("perfectDays").withIndex("by_date", (q) => q.eq("date", a.date)).collect())
        .filter((r) => r.status === "pending" || r.status === "held" || r.status === "paid");
      if (decided.length) {
        return {
          ok: false as const, decided: decided.length,
          reason: `${decided.length} perfect days are already pending, held or paid for ${a.date}. Take them out first `
            + "(perfectDay:removeDays, or perfectDay:correctPayout for a paid one), then mark the date.",
        };
      }
    }
    const now = new Date().toISOString();
    const rec = await dateRecord(ctx, a.date);
    const mark = a.undo ? undefined : { by: a.actorName, at: now, reason: a.reason.trim() };
    if (rec) await ctx.db.patch(rec._id, { adminNoSchool: mark, ...(a.undo ? {} : { state: "no-school" as const, reason: `An admin: ${a.reason.trim()}` }), updatedAt: now });
    else if (!a.undo) {
      await ctx.db.insert("perfectDayDates", {
        date: a.date, state: "no-school", reason: `An admin: ${a.reason.trim()}`, runId: "admin", firstDecidedAt: now, updatedAt: now, adminNoSchool: mark,
      });
    }
    await audit(ctx, a.actorName, a.undo ? "unmarkNoSchool" : "markNoSchool", { date: a.date, reason: a.reason });
    return { ok: true as const };
  },
});

/**
 * "Decide this date anyway": the next runs skip the completeness checks (too
 * few marks, a block below its usual level) and the whole-date disagreement
 * hold for it. Each student is still judged and still checked one by one.
 */
export const decideAnyway = internalMutation({
  args: { date: v.string(), reason: v.string(), actorName: v.string(), undo: v.optional(v.boolean()) },
  handler: async (ctx, a) => {
    if (!R.isDay(a.date)) return { ok: false as const, reason: "date must be YYYY-MM-DD." };
    if (!a.undo && a.reason.trim().length < 3) return { ok: false as const, reason: "Say why." };
    const now = new Date().toISOString();
    const rec = await dateRecord(ctx, a.date);
    const mark = a.undo ? undefined : { by: a.actorName, at: now, reason: a.reason.trim() };
    if (rec) await ctx.db.patch(rec._id, { adminDecideAnyway: mark, updatedAt: now });
    else if (!a.undo) {
      await ctx.db.insert("perfectDayDates", {
        date: a.date, state: "held", reason: "Waiting for the next run (an admin said decide anyway).", runId: "admin",
        firstDecidedAt: now, updatedAt: now, adminDecideAnyway: mark,
      });
    }
    await audit(ctx, a.actorName, a.undo ? "undoDecideAnyway" : "decideAnyway", { date: a.date, reason: a.reason });
    return { ok: true as const };
  },
});

/**
 * A HELD student-day, settled by a person: "pay" makes it pending (if it was
 * stamped payable) and the next payday pays it; "drop" removes it for good.
 */
export const resolveHeld = internalMutation({
  args: { studentNumber: v.string(), date: v.string(), decision: v.union(v.literal("pay"), v.literal("drop")), reason: v.string(), actorName: v.string() },
  handler: async (ctx, a) => {
    if (a.reason.trim().length < 3) return { ok: false as const, reason: "Say why." };
    const row = await ctx.db.query("perfectDays").withIndex("by_student_date", (q) => q.eq("studentNumber", a.studentNumber).eq("date", a.date)).first();
    if (!row || row.status !== "held") return { ok: false as const, reason: "That student has no held day on that date." };
    const now = new Date().toISOString();
    const status = a.decision === "drop" ? "removed" as const : row.payable ? "pending" as const : "unpayable" as const;
    await ctx.db.patch(row._id, { status, why: `admin: ${a.reason.trim()}`, updatedAt: now, runId: "admin" });
    await audit(ctx, a.actorName, "resolveHeld", { studentNumber: a.studentNumber, date: a.date, decision: a.decision, reason: a.reason });
    return { ok: true as const, status };
  },
});

/**
 * RELEASE A DATE'S DAYS HELD ONLY FOR THE SECOND CHECK, in one call
 * (2026-10-12 review). After an attendance-rebuild outage longer than the
 * lookback, those days are never checked by a run and never expire: an admin
 * who is satisfied PowerSchool's verdict stands releases them here. Each
 * becomes pending (if it was stamped payable when decided) and is paid on the
 * next payday; a held day the screen disputed is NOT touched (resolveHeld,
 * one by one). Without apply: true it only counts. Recorded in perfectDayAudit.
 */
export const releaseUnchecked = internalMutation({
  args: { date: v.string(), reason: v.string(), actorName: v.string(), apply: v.optional(v.boolean()) },
  handler: async (ctx, a) => {
    if (!R.isDay(a.date)) return { ok: false as const, reason: "date must be YYYY-MM-DD." };
    const reason = a.reason.trim();
    if (reason.length < 3) return { ok: false as const, reason: "Say why." };
    const rows = (await ctx.db.query("perfectDays").withIndex("by_status_date", (q) => q.eq("status", "held").eq("date", a.date)).collect())
      .filter((r) => r.why === R.UNCHECKED);
    const counted = { days: rows.length, payable: rows.filter((r) => r.payable).length };
    if (a.apply !== true) return { ok: true as const, applied: false, wouldRelease: counted };
    const now = new Date().toISOString();
    for (const r of rows) {
      await ctx.db.patch(r._id, { status: r.payable ? "pending" : "unpayable", why: `admin: released without the second check: ${reason}`, updatedAt: now, runId: "admin" });
    }
    await audit(ctx, a.actorName, "releaseUnchecked", { date: a.date, days: counted.days, payable: counted.payable, reason });
    return { ok: true as const, applied: true, released: counted };
  },
});

/**
 * FORFEIT PENDING DAYS, ON PURPOSE. The switch never takes back a pending day:
 * switched off and on again, it is paid on the next payday it is on for. When
 * the days themselves are wrong (the job decided badly, and was switched off
 * for that), an admin forfeits them here: every pending or held day from
 * `from` to `to` becomes removed, never paid automatically again. Without
 * apply: true it only counts what it would do. At most 4,000 days a call
 * (`more` says run it again). Recorded in perfectDayAudit, counts only.
 */
export const forfeitPending = internalMutation({
  args: { from: v.string(), to: v.string(), reason: v.string(), actorName: v.string(), apply: v.optional(v.boolean()) },
  handler: async (ctx, a) => {
    if (!R.isDay(a.from) || !R.isDay(a.to) || a.from > a.to) return { ok: false as const, reason: "from and to must be YYYY-MM-DD dates, from first." };
    const reason = a.reason.trim();
    if (reason.length < 3) return { ok: false as const, reason: "Say why." };
    const CAP = 4000;
    const rows: any[] = [];
    for (const status of ["pending", "held"] as const) {
      if (rows.length >= CAP) break;
      rows.push(...await ctx.db.query("perfectDays")
        .withIndex("by_status_date", (q) => q.eq("status", status).gte("date", a.from).lte("date", a.to)).take(CAP - rows.length));
    }
    const counted = { days: rows.length, students: new Set(rows.map((r) => r.studentNumber)).size, dates: [...new Set(rows.map((r) => r.date))].sort() };
    if (a.apply !== true) return { ok: true as const, applied: false, wouldForfeit: counted };
    const now = new Date().toISOString();
    for (const r of rows) await ctx.db.patch(r._id, { status: "removed", why: `admin: forfeited: ${reason}`, updatedAt: now, runId: "admin" });
    await audit(ctx, a.actorName, "forfeitPending", { from: a.from, to: a.to, days: counted.days, students: counted.students, reason });
    return { ok: true as const, applied: true, forfeited: counted, more: rows.length >= CAP };
  },
});

/** Take unpaid days out for good (pending, held, unpayable or broken). A paid day needs correctPayout. */
export const removeDays = internalMutation({
  args: { studentNumber: v.string(), dates: v.array(v.string()), reason: v.string(), actorName: v.string() },
  handler: async (ctx, a) => {
    if (a.reason.trim().length < 3) return { ok: false as const, reason: "Say why." };
    const now = new Date().toISOString();
    const done: string[] = [], refused: Array<{ date: string; why: string }> = [];
    for (const date of [...new Set(a.dates)]) {
      const row = await ctx.db.query("perfectDays").withIndex("by_student_date", (q) => q.eq("studentNumber", a.studentNumber).eq("date", date)).first();
      if (!row) { refused.push({ date, why: "no such day" }); continue; }
      if (row.status === "paid") { refused.push({ date, why: "already paid: use correctPayout" }); continue; }
      if (row.status === "removed") { done.push(date); continue; }
      await ctx.db.patch(row._id, { status: "removed", why: `admin: ${a.reason.trim()}`, updatedAt: now, runId: "admin" });
      done.push(date);
    }
    await audit(ctx, a.actorName, "removeDays", { studentNumber: a.studentNumber, dates: done, refused: refused.length, reason: a.reason });
    return { ok: refused.length === 0, removed: done, refused };
  },
});

/**
 * TAKE ONE DAY BACK OUT OF A PAID WEEK (review M1). Reverse undoes a whole
 * row, and a negative attendance row would read as a behaviour deduction, so
 * in ONE transaction: the weekly movement is reversed with the admin Reverse
 * button's own body (cashReversal.doReverse), the days that stand are paid
 * again as a new movement at their own stamped amounts, the removed days are
 * marked removed (never paid automatically again), and the payout records
 * point at each other. If the week was already reversed with the button,
 * only the re-payment happens. Refused, with nothing changed, if the reversal
 * is refused.
 */
export const correctPayout = internalMutation({
  args: { txnId: v.string(), removeDates: v.array(v.string()), reason: v.string(), actorName: v.string(), actorEmail: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const reason = a.reason.trim();
    if (reason.length < 3) return { ok: false as const, code: "reason_required", reason: "Say why." };
    const payout = await ctx.db.query("perfectDayPayouts").withIndex("by_txnId", (q) => q.eq("txnId", a.txnId)).first();
    if (!payout) return { ok: false as const, code: "not_found", reason: "No perfect-day payment has that id." };
    if (payout.status !== "paid") return { ok: false as const, code: "already_corrected", reason: `Already corrected (now ${payout.replacedBy ?? "nothing"}).` };
    const remove = [...new Set(a.removeDates)];
    if (!remove.length || remove.some((d) => !payout.dates.includes(d))) {
      return { ok: false as const, code: "bad_dates", reason: `Name one or more of the days this payment paid: ${payout.dates.join(", ")}.` };
    }
    const prior = await ctx.db.query("cashReversals").withIndex("by_originalTxnId", (q) => q.eq("originalTxnId", a.txnId)).first();
    if (!prior) {
      const r: any = await doReverse(ctx, { originalTxnId: a.txnId, reason: `Perfect attendance corrected: ${reason}`, weekHint: payout.weekKey },
        { name: a.actorName, id: "", email: a.actorEmail ?? "" });
      if (!r.ok) return { ok: false as const, code: String(r.code ?? "reversal_refused"), reason: String(r.reason ?? "The reversal was refused.") };
    }
    const now = new Date();
    const nowIso = now.toISOString();
    const rows: any[] = [];
    for (const d of payout.dates) {
      const row = await ctx.db.query("perfectDays").withIndex("by_student_date", (q) => q.eq("studentNumber", payout.studentNumber).eq("date", d)).first();
      if (row && row.paidTxnId === a.txnId) rows.push(row);
    }
    for (const row of rows.filter((r) => remove.includes(r.date))) {
      await ctx.db.patch(row._id, { status: "removed", why: `admin: ${reason}`, afterPayBroken: false, updatedAt: nowIso, runId: "admin" });
    }
    const keep = rows.filter((r) => !remove.includes(r.date));
    let replacedBy: string | null = null;
    if (keep.length) {
      const found = await studentByNumber(ctx, payout.studentNumber);
      if (!found.student) throw new Error(`No single Hub record for this student (${found.why}); nothing was changed.`);
      const student = found.student;
      const counters = countersOf(student);
      const history = Array.isArray(student.wildcatCashTransactions) ? [...student.wildcatCashTransactions] : [];
      const w = await writeMovement(ctx, {
        student, appStudentId: String(student.legacyId ?? student.studentNumber ?? student._id), counters, history,
        sn: payout.studentNumber, payWeek: payout.payWeek, part: payout.part, payoutKey: `${payout.payoutKey}>${a.txnId}`,
        ms: now.getTime() + 1, nowIso, runId: "admin", rows: keep, replaces: a.txnId,
      });
      await ctx.db.patch(student._id, { ...counters, wildcatCashTransactions: history });
      replacedBy = w.txnId;
    }
    await ctx.db.patch(payout._id, {
      status: "corrected", correctedBy: a.actorName, correctedAt: nowIso, correctionReason: reason, ...(replacedBy ? { replacedBy } : {}),
    });
    await audit(ctx, a.actorName, "correctPayout", { txnId: a.txnId, removed: remove, kept: keep.map((r) => r.date), replacedBy, reason });
    return { ok: true as const, reversed: !prior, removed: remove, repaid: keep.map((r) => r.date), replacedBy };
  },
});

// ===========================================================================
// Reading it back
// ===========================================================================

/**
 * WHAT A STUDENT SEES: their perfect days that will be paid, and the Monday
 * they arrive -- exactly what payday pays. Null when no money moves for them
 * (off, shadow, a control, or outside the pilot with nothing earned still to
 * come): nothing is promised that will not come.
 */
export async function perfectDaysForStudent(ctx: QueryCtx, studentNumber: string) {
  const settings = await loadSettings(ctx);
  if (!R.paying(settings.mode) || !studentNumber) return null;
  const rows = await ctx.db.query("perfectDays").withIndex("by_student_date", (q) => q.eq("studentNumber", studentNumber)).order("desc").take(20);
  return R.pendingForStudent({ settings, sn: studentNumber, rows: rows as unknown as R.RegRow[] });
}

/**
 * EVERY ATTENDANCE ROW HAS ITS PAYMENT, AND EVERY PAYMENT ITS ROW (review M2).
 * Read over the given cash weeks (default this week and last): a ledger row
 * carrying the perfect-day marks with no payout record behind it did not come
 * from this job. Counts, and the first few ids.
 */
export const ledgerCheck = internalQuery({
  args: { weeks: v.optional(v.array(v.string())) },
  handler: async (ctx, { weeks }) => {
    const now = Date.now();
    const list = weeks && weeks.length ? weeks : [...new Set([cashWeekKey(new Date(now).toISOString()), cashWeekKey(new Date(now - 7 * 86400000).toISOString())])];
    let rows = 0, attendanceRows = 0;
    const orphanIds: string[] = [];
    let orphans = 0;
    const seen = new Set<string>();
    for (const w of list) {
      const docs = await ctx.db.query("legacyMirror").withIndex("by_doc_collection", (q) => q.eq("doc", `cash_tx_${w}`).eq("collection", "transactions")).take(8000);
      for (const d of docs) {
        rows++;
        let p: any = d.payload;
        if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = null; } }
        if (!isSystemCashRow(p)) continue;
        attendanceRows++;
        const id = String(p?.id ?? "");
        seen.add(id);
        const payout = id ? await ctx.db.query("perfectDayPayouts").withIndex("by_txnId", (q) => q.eq("txnId", id)).first() : null;
        if (!payout) {
          orphans++;
          if (orphanIds.length < 20) orphanIds.push(id || "(no id)");
        }
      }
    }
    let payoutsWithoutRow = 0;
    for (const w of list) {
      // The payouts filed into this ledger week: every one must have its row.
      const monday = mondayOfWeekKey(w);
      if (!monday) continue;
      for (const p of await ctx.db.query("perfectDayPayouts").withIndex("by_payWeek", (q) => q.eq("payWeek", monday)).take(5000)) {
        if (p.weekKey === w && !seen.has(p.txnId)) payoutsWithoutRow++;
      }
    }
    return { weeks: list, rows, attendanceRows, withoutPayout: orphans, withoutPayoutIds: orphanIds, payoutsWithoutRow, ok: orphans === 0 && payoutsWithoutRow === 0 };
  },
});

/** "2026_W43" -> the Monday of that ISO week. */
function mondayOfWeekKey(w: string): string | null {
  const m = /^(\d{4})_W(\d{2})$/.exec(w);
  if (!m) return null;
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4.getTime() + ((Number(m[2]) - 1) * 7 - (day - 1)) * 86400000);
  return monday.toISOString().slice(0, 10);
}

/**
 * THE ADMIN STATUS, counts first. Shared so a future admin card can wrap it
 * in a public query with requireAdmin in one line. Student numbers appear
 * only in the held and paid-then-broken lists (an admin acts on those); no
 * names, and no dollar figure for any student or group -- only the school's
 * next payday total.
 */
export async function statusFor(ctx: QueryCtx, nDates = 10) {
  const settings = await loadSettings(ctx);
  const state = (await readState(ctx, R.STATE_KEY)) ?? {};
  const lease = leaseOf(await readState(ctx, R.LEASE_KEY));
  const tz = await schoolTimeZone(ctx);
  const today = tz ? R.schoolDateOf(new Date().toISOString(), tz) : null;
  const runs = await ctx.db.query("perfectDayRuns").withIndex("by_startedAt").order("desc").take(5);
  const dates = await ctx.db.query("perfectDayDates").withIndex("by_date").order("desc").take(Math.max(1, Math.min(40, nDates)));

  const held = await ctx.db.query("perfectDays").withIndex("by_status_date", (q) => q.eq("status", "held")).take(2000);
  // Every held DATE, however old, so one that will expire (a block missing, too perfect) is seen before it does.
  const heldDates = await ctx.db.query("perfectDayDates").withIndex("by_state_date", (q) => q.eq("state", "held")).take(50);
  const broke = await ctx.db.query("perfectDays").withIndex("by_afterPayBroken", (q) => q.eq("afterPayBroken", true)).take(2000);
  const paidThenBroken: Array<{ studentNumber: string; date: string; txnId: string | null; why: string | null }> = [];
  let handled = 0;
  for (const r of broke) {
    const txn = r.paidTxnId ?? null;
    const payout = txn ? await ctx.db.query("perfectDayPayouts").withIndex("by_txnId", (q) => q.eq("txnId", txn)).first() : null;
    const reversed = txn ? await ctx.db.query("cashReversals").withIndex("by_originalTxnId", (q) => q.eq("originalTxnId", txn)).first() : null;
    if ((payout && payout.status === "corrected") || reversed) { handled++; continue; }
    paidThenBroken.push({ studentNumber: r.studentNumber, date: r.date, txnId: txn, why: r.afterPayWhy ?? null });
  }

  // THE NEXT PAYDAY: every pending day before its week that payday would pay (the same rule, payNowWhy).
  const thisWeek = today ? R.weekStartOf(today) : null;
  const nextPayWeek = thisWeek ? (state.lastPayWeek && state.lastPayWeek >= thisWeek ? R.addDays(thisWeek, 7) : thisWeek) : null;
  const pending = nextPayWeek
    ? await ctx.db.query("perfectDays").withIndex("by_status_date", (q) => q.eq("status", "pending").lt("date", nextPayWeek)).take(20000) : [];
  const willPay = new Set<string>();
  let payDays = 0, payTotal = 0;
  const notPaid: Record<string, number> = {};
  for (const r of pending) {
    const wait = R.payNowWhy(settings, r.studentNumber, r);
    if (!wait) { willPay.add(r.studentNumber); payDays++; payTotal += r.amount; }
    else notPaid[wait] = (notPaid[wait] ?? 0) + 1;
  }

  // THE CONTROLS: none of them may ever have been paid.
  let controlsPaid = 0;
  for (const sn of settings.controls) {
    const pays = await ctx.db.query("perfectDayPayouts").withIndex("by_student_week", (q) => q.eq("studentNumber", sn)).take(5);
    controlsPaid += pays.length;
  }

  return {
    settings: settingsSummary(settings), invalid: settings.invalid ?? null, today,
    lease: lease && Date.parse(lease.expiresAt) > Date.now() ? lease : null,
    lastDoneDate: state.lastDoneDate ?? null, lastPayWeek: state.lastPayWeek ?? null,
    runs: runs.map((r) => ({ runId: r.runId, trigger: r.trigger, startedAt: r.startedAt, finishedAt: r.finishedAt ?? null, ok: r.ok ?? null, reason: r.reason ?? null,
      decided: r.summary?.decided ?? null, held: r.summary?.held ?? null, pay: r.summary?.pay ?? null, ledgerCheck: r.summary?.ledgerCheck ?? null })),
    dates: dates.map((d) => ({
      date: d.date, state: d.state, reason: d.reason, retryable: d.retryable ?? false,
      enrolled: d.counts?.enrolled ?? null, perfect: d.counts?.perfect ?? null, register: d.counts?.register ?? null,
      classesNoMarks: d.counts?.classesNoMarks ?? null, screen: d.counts?.screen ?? null,
      rowsByCode: d.counts?.rowsByCode ?? null, brokenByPromiseTimeAmOnly: d.counts?.brokenByPromiseTimeAmOnly ?? null,
      adminNoSchool: !!d.adminNoSchool, adminDecideAnyway: !!d.adminDecideAnyway,
    })),
    held: { count: held.length, list: held.slice(0, 100).map((r) => ({ studentNumber: r.studentNumber, date: r.date, why: r.why ?? null })) },
    heldDates: heldDates.map((d) => ({ date: d.date, reason: d.reason, retryable: d.retryable ?? false })),
    paidThenBroken: { count: paidThenBroken.length, handled, list: paidThenBroken.slice(0, 100) },
    nextPayday: { payWeek: nextPayWeek, students: willPay.size, days: payDays, total: payTotal, earnedNotPaid: notPaid },
    controls: { count: settings.controls.length, paidMovements: controlsPaid },
  };
}

/** The admin status, from the command line: npx convex run perfectDay:status */
export const status = internalQuery({
  args: { dates: v.optional(v.number()) },
  handler: async (ctx, { dates }) => statusFor(ctx, dates ?? 10),
});

/**
 * THE SAME STATUS, FOR THE ADMIN CARD on the Cash Audit Log (2026-10-12).
 * Admins and superadmins only, asked first: a teacher's tab gets a refusal,
 * never a count. Read-only. Student numbers appear only in the held and
 * paid-then-broken lists, and the browser joins them to names from the
 * roster it already holds, so no name travels in this answer.
 */
export const adminStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return statusFor(ctx, 10);
  },
});
