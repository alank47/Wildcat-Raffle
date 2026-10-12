"use node";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { countRows, MAX_PAGES, PAGE, psGet, token } from "./attendanceDays";
import { dayQuery, readConfirmed } from "./reflectionRead";
import * as R from "./perfectDayRules";

/**
 * THE PERFECT-DAY RUN: PowerSchool read, every date judged, the week paid.
 *
 * Booked by perfectDay.tick (or runNow) together with the lease, and only
 * ever by them. It READS PowerSchool and the job's own context; it WRITES only
 * through perfectDay's internal mutations, each of which refuses a run that
 * no longer holds the lease or finds the switch off. Every decision is a pure
 * rule in perfectDayRules.ts.
 *
 * EVERY DAY'S READ IS CONFIRMED (reflectionRead.readConfirmed): accepted only
 * when two reads in a row are each steady against PowerSchool's own count AND
 * hold the same row ids. A day whose read is not confirmed is HELD and tried
 * again by the next tick; nothing is believed from it. A date with no
 * attendance at all is NO SCHOOL (one count, no read), never held: a holiday
 * is not a failed read.
 *
 * WHAT IS READ, per run: the attendance codes; the students table INCLUDING
 * LEAVERS (exitdate on or after the window: enrolment on a day is
 * entrydate <= D < exitdate, not "on the roster today"); class enrolments
 * with their dates (at least one class must have met); and each of the last
 * ten school days in full. Logs carry counts only.
 */

const CC_FIELDS = "id,studentid,sectionid,expression,termid,dateenrolled,dateleft";
const READ_CONCURRENCY = 3;

/** A table, paged to exhaustion. Paging out is an error, never a short read that looks complete. */
async function pagedRows(host: string, tok: string, table: string, q: string, projection: string, deadline: number): Promise<any[]> {
  const rows: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://${host}/ws/schema/table/${table}?q=${encodeURIComponent(q)}`
      + `&projection=${encodeURIComponent(projection)}&pagesize=${PAGE}&page=${page}`;
    const b = await psGet(url, tok, deadline, `${table} page ${page}`);
    const batch = (b?.record ?? []).map((r: any) => r.tables?.[table] ?? r);
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
  throw new Error(`${table} paged out at ${MAX_PAGES} pages, so it would be read short. Nothing was decided.`);
}

/** At most `n` at once; each item's failure is the item's own. */
async function atMost<T, U>(n: number, items: T[], fn: (x: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

type RunArgs = { runId: string; today: string; minute: number; startedAt: string; tz: string };
type Body = { ok: boolean; done: boolean; reason?: string };

async function body(ctx: ActionCtx, a: RunArgs, summary: Record<string, any>): Promise<Body> {
  const deadline = Date.parse(a.startedAt) + R.READ_BUDGET_MS;
  const host = process.env.PS_HOST, id = process.env.PS_CLIENT_ID, secret = process.env.PS_CLIENT_SECRET;
  const schoolid = process.env.PS_SCHOOL_ID, yearid = process.env.PS_YEAR_ID, termid = process.env.PS_TERM_ID;
  if (!host || !id || !secret || !schoolid || !yearid || !termid) {
    return { ok: false, done: false, reason: "PowerSchool settings are not all present in this deployment." };
  }
  const c = await ctx.runQuery(internal.perfectDay.runContext, { today: a.today });
  const settings: R.Settings = c.settings;
  if (settings.mode === "off") return { ok: true, done: true, reason: "Switched off." };
  const decidable = (d: string) => !!settings.countFromDate && d >= settings.countFromDate;

  const tok = await token(host, id, secret);
  const codes = R.codeBookOf(await pagedRows(host, tok, "attendance_code", `schoolid==${schoolid};yearid==${yearid}`,
    "id,att_code,description,presence_status_cd", deadline));
  if (!codes.ok) return { ok: false, done: false, reason: codes.reason };

  // 1. THE CALENDAR: which dates are worth reading, by one count each.
  const cal = R.calendarCandidates({ today: a.today, reachDays: R.CALENDAR_REACH_DAYS, marks: c.marks, adminNoSchool: c.adminNoSchool });
  const counted = await atMost(READ_CONCURRENCY, cal.candidates, async (d) => {
    try { return await countRows(host, tok, "attendance", dayQuery({ schoolid, yearid, date: d }), deadline); } catch { return -1; }
  });
  const counts: Record<string, number> = {};
  cal.candidates.forEach((d, i) => { counts[d] = counted[i]; });
  const failedCount = cal.candidates.filter((d) => counts[d] < 0);
  const { window, zero } = R.windowOf({ candidates: cal.candidates.filter((d) => counts[d] >= 0), counts, lookback: settings.lookbackSchoolDays });
  const windowStart = window[0] ?? R.addDays(a.today, -R.CALENDAR_REACH_DAYS);
  summary.window = { from: window[0] ?? null, to: window[window.length - 1] ?? null, days: window.length };

  const results: Array<{ date: string; state: string; retryable: boolean }> = [];
  const apply = async (args: Record<string, any>) => {
    const r: any = await ctx.runMutation(internal.perfectDay.applyDate, {
      checked: false, perfect: [], held: [], broken: [], counts: {}, rowCounts: {}, retryable: false, ...args,
    } as any);
    if (r?.stopped) throw new Stopped(String(r.reason));
    if (!r?.skipped) results.push({ date: args.date, state: r.state, retryable: args.retryable === true && r.state === "held" });
    return r;
  };

  // 2. THE READS, only when a date in the window can be decided.
  if (window.some(decidable)) {
    const students = R.psStudentsOf(await pagedRows(host, tok, "students", `schoolid==${schoolid};exitdate=ge=${windowStart}`,
      "id,student_number,grade_level,entrydate,exitdate", deadline));
    if (!students.length) return { ok: false, done: false, reason: "PowerSchool returned no students, so nobody can be judged. Nothing was decided." };
    const tb = Math.floor(Number(termid) / 100) * 100;
    const cc = R.ccRowsOf([
      ...await pagedRows(host, tok, "cc", `schoolid==${schoolid};termid=ge=${tb};termid=le=${tb + 99};dateleft=ge=${windowStart}`, CC_FIELDS, deadline),
      // Dropped enrolments carry the negative of their term: they still say when the student sat in the class.
      ...await pagedRows(host, tok, "cc", `schoolid==${schoolid};termid=ge=${-(tb + 99)};termid=le=${-tb};dateleft=ge=${windowStart}`, CC_FIELDS, deadline),
    ]);
    summary.students = students.length;
    summary.classEnrolments = cc.length;
    summary.reads = 0;
    summary.pages = 0;
    const reads = await atMost(READ_CONCURRENCY, window, async (d) => {
      const r = await readConfirmed(host, tok, dayQuery({ schoolid, yearid, date: d }), deadline, { expectDate: d });
      summary.reads += r.reads;
      summary.pages += r.pages;
      return r.ok ? { ok: true as const, rows: [...r.rows.values()] } : { ok: false as const, reason: r.reason };
    });
    const psIds = new Set(students.map((s) => s.psId));
    const reference: R.DayStats[] = [];
    window.forEach((d, i) => {
      const r = reads[i];
      if (r.ok) reference.push(R.dayStats(d, r.rows, psIds));
    });
    const raw: any = await ctx.runQuery(internal.perfectDay.screenMarks, { from: windowStart, to: R.addDays(a.today, -1), tz: a.tz });
    const screen: R.ScreenView = {
      available: raw.available === true, reason: String(raw.reason ?? ""), asOf: raw.asOf ?? null,
      bySn: Object.fromEntries((raw.rows ?? []).map((x: any) => [x.sn, { entry: x.entry ?? null, bad: x.bad ?? [] }])),
    };
    summary.screen = { available: screen.available, asOf: screen.asOf, reason: screen.reason || null };
    for (let i = 0; i < window.length; i++) {
      const d = window[i];
      if (!decidable(d)) continue;
      const j = R.judgeDay({
        date: d, read: reads[i], codes, students, cc, reference, screen, decideAnyway: c.decideAnyway.includes(d),
      });
      await apply({
        runId: a.runId, date: d, state: j.state, reason: j.reason, retryable: j.retryable, checked: j.checked,
        perfect: j.perfect.map((p) => ({ sn: p.sn, div: p.div })),
        held: j.held.map((h) => ({ sn: h.sn, div: h.div, why: h.why })),
        broken: j.broken.map((b) => ({ sn: b.sn, why: b.why })),
        counts: j.counts, rowCounts: j.rowCounts,
      });
    }
  }

  // 3. NO SCHOOL, and dates that could not even be counted.
  for (const d of zero) if (decidable(d)) await apply({ runId: a.runId, date: d, state: "no-school", reason: "PowerSchool has no attendance for this date." });
  for (const n of cal.noSchool) if (decidable(n.date) && n.date >= windowStart) await apply({ runId: a.runId, date: n.date, state: "no-school", reason: n.why });
  for (const d of failedCount) {
    if (decidable(d) && d >= windowStart) {
      await apply({ runId: a.runId, date: d, state: "held", retryable: true, reason: "PowerSchool could not count this date's attendance. Tried again on the next run." });
    }
  }
  summary.decided = results.filter((r) => r.state === "school").map((r) => r.date);
  summary.held = results.filter((r) => r.state === "held").map((r) => r.date);
  summary.noSchool = results.filter((r) => r.state === "no-school").map((r) => r.date);

  // 4. WHAT STAYED HELD PAST THE LOOKBACK EXPIRES.
  const exp: any = await ctx.runMutation(internal.perfectDay.expireOld, { runId: a.runId, before: windowStart });
  if (exp?.stopped) throw new Stopped(String(exp.reason));
  summary.expired = { dates: exp.dates, rows: exp.rows };

  // 5. PAYDAY: the first good run on or after Monday.
  const payWeek = R.weekStartOf(a.today);
  const retryableHeldBefore = results.some((r) => r.retryable && r.date < payWeek);
  const pv = R.paydayVerdict({ today: a.today, minute: a.minute, mode: settings.mode, lastPayWeek: c.lastPayWeek, retryableHeldBefore });
  summary.payday = { due: pv.due, payWeek: pv.payWeek, why: pv.why };
  if (pv.due) {
    const plan: any = await ctx.runQuery(internal.perfectDay.payPlan, { before: pv.payWeek });
    const pay = { students: 0, movements: 0, days: 0, amount: 0, alreadyPaidThisWeek: 0, noHubRecord: 0, ambiguous: 0, dropped: 0, skipped: {} as Record<string, number>, batches: 0 };
    for (let i = 0; i < plan.students.length; i += R.PAY_BATCH) {
      const r: any = await ctx.runMutation(internal.perfectDay.payBatch, {
        runId: a.runId, payWeek: pv.payWeek, students: plan.students.slice(i, i + R.PAY_BATCH), tz: a.tz,
      });
      if (r?.stopped) throw new Stopped(`Payday stopped: ${r.reason}`);
      pay.batches++;
      for (const k of ["students", "movements", "days", "amount", "alreadyPaidThisWeek", "noHubRecord", "ambiguous", "dropped"] as const) pay[k] += Number(r[k]) || 0;
      for (const [k, n] of Object.entries(r.skipped ?? {})) pay.skipped[k] = (pay.skipped[k] ?? 0) + Number(n);
    }
    summary.pay = pay;
    const fin: any = await ctx.runMutation(internal.perfectDay.finishPayday, { runId: a.runId, payWeek: pv.payWeek, summary: pay });
    if (fin?.stopped) throw new Stopped(String(fin.reason));
  }

  // 6. EVERY ATTENDANCE ROW HAS ITS PAYMENT (review M2).
  summary.ledgerCheck = await ctx.runQuery(internal.perfectDay.ledgerCheck, {});

  const waiting = !pv.due && pv.why.startsWith("Waiting");
  return { ok: true, done: !results.some((r) => r.retryable) && !waiting };
}

class Stopped extends Error {}

export const run = internalAction({
  args: { runId: v.string(), today: v.string(), minute: v.number(), startedAt: v.string(), tz: v.string() },
  handler: async (ctx, a): Promise<Record<string, any>> => {
    const summary: Record<string, any> = { today: a.today };
    let out: Body;
    try {
      out = await body(ctx, a, summary);
    } catch (e: any) {
      out = { ok: false, done: false, reason: String(e?.message || e).slice(0, 300) };
    }
    console.log(`[perfectDay] ${a.runId} ok=${out.ok} done=${out.done} decided=${(summary.decided ?? []).length} held=${(summary.held ?? []).length}`
      + (summary.pay ? ` paid=${summary.pay.students}` : ""));
    await ctx.runMutation(internal.perfectDay.finishRun, {
      runId: a.runId, today: a.today, ok: out.ok, done: out.done, reason: out.reason ?? "", summary,
    });
    return { ...out, summary };
  },
});
