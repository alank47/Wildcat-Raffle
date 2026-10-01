import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireAdmin } from "./identity";
import { ringPush } from "./appDataShape";
import {
  CASH_ZERO_POINT_KEY, CASH_ARRIVAL_ALERTS_KEY, ALERT_MAX_AGE_MS, ARRIVAL_MAX_AGE_AWARD_MS,
  ZERO_POINT_SLACK_MS, alertsEnabled, zeroPointMs, isCashLedgerCall, isResetRow,
  arrivalRow, twinIndex, hasTwin, planStudentArrival, laterCandidates, candidateSignature, countsByCode,
  zeroPointTimeFor, mayMoveZeroPoint, latestResetMs,
} from "./cashArrivalRules";
import type { ArrivalItem, Candidate } from "./cashArrivalRules";

/**
 * AWARDS THAT ARRIVE WITHOUT THEIR MONEY: recorded, shown to admins, fixed
 * by a person. The owner's choice on 2026-09-30 ("A + C").
 *
 * THE INCIDENT. A teacher awards; the award command fails with HTTP 401 (the
 * Microsoft token expired); the ordinary save fails the same way; the page
 * reloads and the money that lived only in the tab's memory is gone. The
 * LEDGER ROW survives in the browser's outbox and arrives later through
 * legacyData:mergeSlice. Four incidents in one week; 67 awards on 9/29-9/30.
 *
 * WHY NOT PAY IT AUTOMATICALLY. That was built first and reviewed three times.
 * Each round found a way to pay one award twice when a PERSON re-enters it --
 * the teacher who sees no change and awards again, a colleague the child told,
 * an admin. A rule cannot tell a re-entry from an ordinary later award; a
 * person looking at the list can. So:
 *
 *   - mergeSlice calls noteArrivedCash after inserting rows. A new award or
 *     deduction row that NO payer has paid (not in students.cashApplied, not
 *     in cashAwardCommands) is written to cashArrivalAlerts. Nothing else.
 *   - An admin sees "N awards arrived without their money" on the dashboard,
 *     reviews them on the Cash Audit Log tab -- with a warning wherever a
 *     similar award was given later -- and presses Fix or Dismiss.
 *   - fixAlerts pays through the SAME register the command and the save use,
 *     re-checking everything at that moment, so an award paid meanwhile by
 *     any route is recognised and not paid again.
 *
 * Switch (recording only; it moves no money, so it is on unless set off):
 *   npx convex run cashArrival:configureAlerts '{"enabled":false}'
 */

async function readState(ctx: any, key: string) {
  return await ctx.db.query("appState").withIndex("by_key", (q: any) => q.eq("key", key)).first();
}

async function findStudent(ctx: any, key: string) {
  const byLegacy = await ctx.db.query("students")
    .withIndex("by_legacyId", (q: any) => q.eq("legacyId", key)).first();
  if (byLegacy) return byLegacy;
  return await ctx.db.query("students")
    .withIndex("by_studentNumber", (q: any) => q.eq("studentNumber", key)).first();
}

async function readCutoffMs(ctx: any): Promise<number | null> {
  const row = await readState(ctx, "historyCutoff");
  const iso = (row?.value as Record<string, unknown> | undefined)?.iso;
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Raise the school-wide zero point (never lowers it). Called for an admin's
 * RESET ALL CASH rows, the reset/rollover audit entries, and the command-line
 * zero and clear tools, so a Fix can never pay pre-reset money into the new
 * balances. See zeroPointTimeFor for why the time is capped and server-dated.
 */
export async function raiseZeroPoint(ctx: any, iso: string, source: string): Promise<boolean> {
  const ms = zeroPointTimeFor(iso, Date.now());
  if (!Number.isFinite(ms)) return false;
  const row = await readState(ctx, CASH_ZERO_POINT_KEY);
  if (ms <= zeroPointMs(row?.value)) return false;
  const value = { iso: new Date(ms).toISOString(), source, raisedAt: new Date().toISOString() };
  const at = new Date().toISOString();
  if (row) await ctx.db.patch(row._id, { value, mirroredAt: at });
  else await ctx.db.insert("appState", { key: CASH_ZERO_POINT_KEY, value, mirroredAt: at });
  return true;
}

type NoteArgs = {
  doc: string;
  collection: string;
  dedupeField: string;
  keyed: boolean;
  /** Rows already in the week before this call (mergeSlice's keptStored). */
  stored: Array<{ payload: unknown }>;
  /** Rows this call inserted. */
  inserted: Array<{ payload: unknown }>;
  cutoffMs: number | null;
  /** The TOKEN's email, role and staff id. Never payload fields. */
  actorEmail: string;
  actorRole?: string;
  actorTeacherId?: string;
};

/** At most this many children checked inside one mergeSlice call. */
const NOTE_MAX_STUDENTS = 60;

/**
 * Record new ledger rows whose money no payer has paid. MOVES NO MONEY.
 * Never throws: a row that saved must not be rolled back over a note.
 */
export async function noteArrivedCash(ctx: any, a: NoteArgs) {
  if (!a.inserted.length || !isCashLedgerCall(a)) return null;
  try {
    return await noteInner(ctx, a);
  } catch (e) {
    try {
      await ctx.db.insert("cashFallbackLog", {
        at: new Date().toISOString(), via: "arrival", actorEmail: a.actorEmail || undefined,
        reason: "arrival_note_error", count: a.inserted.length,
        ids: a.inserted.slice(0, 60).map((r: any) => String(r?.payload?.id ?? "")),
        detail: `${a.doc}: ${String((e as Error)?.message ?? e).slice(0, 250)}`,
      });
    } catch { /* best effort */ }
    return { error: true };
  }
}

async function noteInner(ctx: any, a: NoteArgs) {
  // An admin's RESET ALL CASH rows arriving move the zero point, whatever
  // else happens. Any staff token can send a row with any behaviorId.
  let resetIso = "";
  if (mayMoveZeroPoint(a.actorRole)) for (const r of a.inserted) {
    if (!isResetRow(r.payload)) continue;
    const ts = String((r.payload as any)?.timestamp ?? "");
    if (Number.isFinite(Date.parse(ts)) && ts > resetIso) resetIso = ts;
  }
  if (resetIso) await raiseZeroPoint(ctx, resetIso, "reset row");

  if (!alertsEnabled((await readState(ctx, CASH_ARRIVAL_ALERTS_KEY))?.value)) return { recorded: 0, off: true };

  const nowMs = Date.now();
  const zp = zeroPointMs((await readState(ctx, CASH_ZERO_POINT_KEY))?.value);
  const twins = twinIndex(a.stored);
  const all = [...a.stored, ...a.inserted];
  const skipped: Array<{ id: string; code: string }> = [];
  const byStudent = new Map<string, ArrivalItem[]>();
  for (const r of a.inserted) {
    if (isResetRow(r.payload)) continue;
    const id = String((r.payload as any)?.id ?? "(no id)");
    const c = arrivalRow(r.payload, a.doc, { nowMs, cutoffMs: a.cutoffMs, zeroPointMs: zp, maxAgeMs: ALERT_MAX_AGE_MS });
    if (!c.ok) { skipped.push({ id, code: c.code }); continue; }
    const list = byStudent.get(c.award.studentId) ?? [];
    list.push(c);
    byStudent.set(c.award.studentId, list);
  }

  let recorded = 0, paidAlready = 0, n = 0;
  const arrivedAt = new Date(nowMs).toISOString();
  for (const [sid, items] of byStudent) {
    // Past the cap, recorded unchecked: the admin's list re-checks every row
    // live before showing it, so a row paid meanwhile never reaches a person.
    let student: any = null;
    const checked = n++ < NOTE_MAX_STUDENTS;
    if (checked) {
      student = await findStudent(ctx, sid);
      if (student) {
        const cur = student.cashApplied ?? null;
        const known = new Set<string>(((cur && Array.isArray(cur.ids)) ? cur.ids : []).map((e: any) => String(e?.i ?? "")));
        const unpaid: ArrivalItem[] = [];
        for (const it of items) {
          if (known.has(it.award.txnId)) { paidAlready++; continue; }
          const reg = await ctx.db.query("cashAwardCommands")
            .withIndex("by_txnId", (q: any) => q.eq("txnId", it.award.txnId)).first();
          if (reg) { paidAlready++; continue; }
          unpaid.push(it);
        }
        items.splice(0, items.length, ...unpaid);
      }
    }
    for (const it of items) {
      const exists = await ctx.db.query("cashArrivalAlerts")
        .withIndex("by_txnId", (q: any) => q.eq("txnId", it.award.txnId)).first();
      if (exists) continue;
      const flags: string[] = [];
      // Kept on the alert: the week's rows are in hand now and are not read
      // again later (a week is ~2,500 rows).
      const later = laterCandidates([...all, ...((student?.wildcatCashTransactions as unknown[]) ?? [])], it.row);
      if (later.length) flags.push("later_similar");
      if (it.award.kind === "deduct") flags.push("deduction");
      if (hasTwin(twins, it.award)) flags.push("twin");
      if (nowMs - Date.parse(it.award.at) > ARRIVAL_MAX_AGE_AWARD_MS) flags.push("late");
      if (!student) flags.push(checked ? "student_not_found" : "unchecked");
      // Sent from a different account than the one named on the row: a
      // shared computer draining a colleague's outbox is normal, a forged
      // row is not, and a person can tell which. Flagged, never refused.
      const rowTeacher = String((it.row as any).teacherId ?? "");
      if (rowTeacher && a.actorTeacherId && rowTeacher !== a.actorTeacherId) flags.push("delivered_by_other");
      await ctx.db.insert("cashArrivalAlerts", {
        txnId: it.award.txnId, studentId: it.award.studentId,
        studentName: String((it.row as any).studentName ?? "") || undefined,
        amount: it.award.amount, kind: it.award.kind, at: it.award.at, arrivedAt, doc: a.doc,
        teacherName: String((it.row as any).teacherName ?? "") || undefined,
        behaviorName: String((it.row as any).behaviorName ?? "") || undefined,
        notes: it.award.notes || undefined,
        deliveredBy: a.actorEmail || undefined,
        status: "open", flags, later: later.length ? later : undefined, row: it.row,
      });
      recorded++;
    }
  }
  // Logged only when something was recorded: every staff-desk sale and
  // refund is a non-award row, and logging those would bury the fallback
  // diagnostic (review finding).
  if (recorded) {
    await ctx.db.insert("cashFallbackLog", {
      at: arrivedAt, via: "arrival", actorEmail: a.actorEmail || undefined,
      reason: recorded ? "arrived_unpaid" : "arrival_not_recorded",
      count: recorded, ids: [],
      detail: (`${a.doc}: recorded ${recorded}, already paid ${paidAlready}` +
        (skipped.length ? `, not an award row: ${countsByCode(skipped)}` : "")).slice(0, 300),
    });
  }
  return { recorded, paidAlready, skipped: skipped.length };
}

/** Is this alert's movement paid now, by any route? */
function paidNow(student: any, cmd: boolean, txnId: string): boolean {
  if (cmd) return true;
  const cur = student?.cashApplied ?? null;
  return !!cur && Array.isArray(cur.ids) && cur.ids.some((e: any) => String(e?.i ?? "") === txnId);
}

/**
 * EVERYTHING ABOUT AN ALERT THAT CAN CHANGE AFTER IT WAS RECORDED, worked out
 * NOW (review finding, 2026-09-30: the "given again" warning was computed
 * once, on arrival -- but the teacher re-gives the award AFTER the lost row
 * arrives, so the warning could never see it). Read by the list, the tile
 * and the Fix alike, so what the admin is shown is what the Fix checks.
 */
type Live = { paid: boolean; candidates: Candidate[]; sig: string; blocked: string | null; student: any };
async function liveCheck(ctx: any, alert: any, weekRows: Map<string, any[]>,
                         students: Map<string, any>, nowMs: number, cutoffMs: number | null, zp: number): Promise<Live> {
  if (!students.has(alert.studentId)) students.set(alert.studentId, await findStudent(ctx, alert.studentId));
  const st = students.get(alert.studentId);
  const cmd = !!(await ctx.db.query("cashAwardCommands").withIndex("by_txnId", (q: any) => q.eq("txnId", alert.txnId)).first());
  const paid = st ? paidNow(st, cmd, alert.txnId) : false;
  // CANDIDATES FOR "GIVEN AGAIN", from three places (second review):
  //   - the child's own history (the command appends every award there and
  //     every save unions its rows in);
  //   - the child's OTHER open alerts: the re-entry may have been lost too;
  //   - what was seen in the ledger week when this alert was recorded.
  // All later movements up to now, by anyone.
  if (!weekRows.has("open:" + alert.studentId)) {
    const others = await ctx.db.query("cashArrivalAlerts")
      .withIndex("by_student_status", (q: any) => q.eq("studentId", alert.studentId).eq("status", "open")).take(200);
    weekRows.set("open:" + alert.studentId, others.map((o: any) => o.row));
  }
  // A DISMISSED row is not a re-entry: it was never paid (re-review,
  // 2026-10-01). Left out here as the recount leaves it out.
  if (!weekRows.has("dismissed:" + alert.studentId)) {
    const gone = await ctx.db.query("cashArrivalAlerts")
      .withIndex("by_student_status", (q: any) => q.eq("studentId", alert.studentId).eq("status", "dismissed")).take(200);
    weekRows.set("dismissed:" + alert.studentId, gone.map((o: any) => o.txnId));
  }
  const dismissedIds = new Set(weekRows.get("dismissed:" + alert.studentId));
  const stored = Array.isArray(alert.later) ? alert.later : (alert.later ? [alert.later] : []);
  const candidates = laterCandidates([
    ...((st?.wildcatCashTransactions as unknown[]) ?? []),
    ...(weekRows.get("open:" + alert.studentId) ?? []),
    ...stored.map((c: any) => ({ id: c.id ?? `stored:${c.at}`, studentId: alert.studentId, kind: alert.kind, amount: c.amount, timestamp: c.at, teacherName: c.by, behaviorName: c.behavior })),
  ].filter((r: any) => !dismissedIds.has(String(r?.id ?? ""))), alert.row);
  let blocked: string | null = null;
  const c = arrivalRow(alert.row, alert.doc, { nowMs, cutoffMs, zeroPointMs: zp, maxAgeMs: ALERT_MAX_AGE_MS });
  if (!c.ok) blocked = c.code;
  else if (!st) blocked = "student_not_found";
  else {
    const since = st.cashApplied && typeof st.cashApplied.since === "string" ? Date.parse(st.cashApplied.since) : NaN;
    const at = Date.parse(alert.at);
    if (Number.isFinite(since) && at <= since) blocked = "coverage_lost";
    else if (at <= latestResetMs(st.wildcatCashTransactions) + ZERO_POINT_SLACK_MS) blocked = "before_reset";
  }
  return { paid, candidates, sig: candidateSignature(candidates), blocked, student: st };
}

/** Open alerts, NEWEST FIRST, each re-checked live. Admin only. */
export const openAlerts = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db.query("cashArrivalAlerts")
      .withIndex("by_status", (q) => q.eq("status", "open")).order("desc").take(300);
    const nowMs = Date.now();
    const cutoffMs = await readCutoffMs(ctx);
    const zp = zeroPointMs((await readState(ctx, CASH_ZERO_POINT_KEY))?.value);
    const weekRows = new Map<string, any[]>();
    const students = new Map<string, any>();
    const out: any[] = [];
    for (const r of rows) {
      const live = await liveCheck(ctx, r, weekRows, students, nowMs, cutoffMs, zp);
      const st = live.student;
      out.push({
        id: r._id, txnId: r.txnId, studentId: r.studentId,
        studentName: st ? `${st.firstName ?? ""} ${st.lastName ?? ""}`.trim() : (r.studentName ?? ""),
        grade: st?.grade ?? null,
        balance: st ? Number(st.wildcatCashBalance) || 0 : null,
        amount: r.amount, kind: r.kind, at: r.at, arrivedAt: r.arrivedAt,
        teacherName: r.teacherName ?? "", behaviorName: r.behaviorName ?? "", notes: r.notes ?? "",
        deliveredBy: r.deliveredBy ?? "",
        flags: r.flags, candidates: live.candidates, candidateSig: live.sig, blocked: live.blocked,
        paidMeanwhile: live.paid, found: !!st,
      });
    }
    return { alerts: out, capped: rows.length === 300 };
  },
});

/**
 * How many are waiting, for the dashboard tile. Admin only. Not counted:
 * anything paid meanwhile, anything that cannot be fixed here (blocked: it is
 * left for the recount, or can never be paid), and anything under two minutes
 * old (a row can legitimately arrive a moment before the save that carries
 * its money).
 */
/**
 * Blocked rows whose payment only the recount can judge -- too old for the
 * register or for the panel, or dated near a reset row the recount itself
 * reads (fourth re-review, 2026-10-01: closing one "can never be paid" while
 * the recount counted it was a contradiction). Neither Give back nor Dismiss
 * touches them. The other blocked rows can never be paid.
 */
const LEFT_FOR_THE_RECOUNT = new Set(["coverage_lost", "stale", "before_reset"]);

export const alertSummary = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db.query("cashArrivalAlerts")
      .withIndex("by_status", (q) => q.eq("status", "open")).order("desc").take(300);
    const nowMs = Date.now();
    const cutoffMs = await readCutoffMs(ctx);
    const zp = zeroPointMs((await readState(ctx, CASH_ZERO_POINT_KEY))?.value);
    const young = new Date(nowMs - 2 * 60 * 1000).toISOString();
    const weekRows = new Map<string, any[]>();
    const students = new Map<string, any>();
    let waiting = 0;
    for (const r of rows) {
      if (r.arrivedAt > young) continue;
      const live = await liveCheck(ctx, r, weekRows, students, nowMs, cutoffMs, zp);
      if (live.paid || live.blocked) continue;
      waiting++;
    }
    return { waiting };
  },
});

/**
 * Close alerts some other route has paid meanwhile, so they stop taking room.
 * Admin only; the list calls it when it sees them. Pays nothing.
 */
export const settlePaid = mutation({
  args: { ids: v.array(v.id("cashArrivalAlerts")) },
  handler: async (ctx, { ids }) => {
    const admin = await requireAdmin(ctx);
    const nowIso = new Date().toISOString();
    let n = 0;
    for (const id of [...new Set(ids)].slice(0, 300)) {
      const alert = await ctx.db.get(id);
      if (!alert || alert.status !== "open") continue;
      const st = await findStudent(ctx, alert.studentId);
      const cmd = !!(await ctx.db.query("cashAwardCommands").withIndex("by_txnId", (q) => q.eq("txnId", alert.txnId)).first());
      if (!st || !paidNow(st, cmd, alert.txnId)) continue;
      await ctx.db.patch(id, { status: "settled", resolvedAt: nowIso, resolvedBy: admin.email, resolution: "paid by another route" });
      n++;
    }
    return { settled: n };
  },
});

/**
 * Pay the chosen alerts. Admin only. Everything is re-checked NOW, in this
 * transaction, through the same register the command and the save use, so
 * an award paid meanwhile by any route is recognised and marked settled
 * rather than paid again.
 *
 * "GIVEN AGAIN" IS CHECKED HERE TOO, live, and REFUSES unless the admin
 * ticked that row while its warning was on screen (`acknowledged`). A
 * warning the admin never saw is not a decision the admin made.
 */
export const fixAlerts = mutation({
  args: {
    ids: v.array(v.id("cashArrivalAlerts")),
    // Each warned row the admin ticked BY HAND while its warning was on
    // screen, with the exact set of candidates they saw.
    acknowledged: v.optional(v.array(v.object({ id: v.id("cashArrivalAlerts"), sig: v.string() }))),
  },
  handler: async (ctx, { ids, acknowledged }) => {
    const admin = await requireAdmin(ctx);
    const unique = [...new Set(ids)];
    if (unique.length > 200) throw new ConvexError("At most 200 at a time.");
    const ack = new Map((acknowledged ?? []).map((a) => [String(a.id), String(a.sig)]));
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const cutoffMs = await readCutoffMs(ctx);
    const zp = zeroPointMs((await readState(ctx, CASH_ZERO_POINT_KEY))?.value);
    const weekRows = new Map<string, any[]>();
    const students = new Map<string, any>();

    const byStudent = new Map<string, Array<{ alert: any; item: ArrivalItem }>>();
    const results: Array<{ id: string; outcome: string; reason?: string }> = [];
    for (const id of unique) {
      const alert = await ctx.db.get(id);
      if (!alert || alert.status !== "open") { results.push({ id, outcome: "skipped", reason: "not open" }); continue; }
      const live = await liveCheck(ctx, alert, weekRows, students, nowMs, cutoffMs, zp);
      if (live.blocked) { results.push({ id, outcome: "refused", reason: live.blocked }); continue; }
      // Refused unless the admin acknowledged EXACTLY the candidates there
      // are now. A new one since they looked means they have not seen it.
      if (live.candidates.length && !live.paid && ack.get(String(id)) !== live.sig) {
        results.push({ id, outcome: "refused", reason: "given_again" });
        continue;
      }
      const c = arrivalRow(alert.row, alert.doc, { nowMs, cutoffMs, zeroPointMs: zp, maxAgeMs: ALERT_MAX_AGE_MS });
      if (!c.ok) { results.push({ id, outcome: "refused", reason: c.code }); continue; }
      const list = byStudent.get(c.award.studentId) ?? [];
      list.push({ alert, item: c });
      byStudent.set(c.award.studentId, list);
    }

    let paidCount = 0, paidTotal = 0;
    const names: string[] = [];
    for (const [sid, entries] of byStudent) {
      const student = await findStudent(ctx, sid);
      if (!student) {
        for (const e of entries) results.push({ id: e.alert._id, outcome: "refused", reason: "student_not_found" });
        continue;
      }
      const cmd = new Set<string>();
      for (const e of entries) {
        const reg = await ctx.db.query("cashAwardCommands")
          .withIndex("by_txnId", (q) => q.eq("txnId", e.item.award.txnId)).first();
        if (reg) cmd.add(e.item.award.txnId);
      }
      // The broader "given again" check ran above, live; the narrower
      // same-teacher rule inside the plan would only repeat it.
      const plan = planStudentArrival(student, entries.map((e) => e.item), cmd, { ignoreReentry: true });
      if (plan.patch) await ctx.db.patch(student._id, plan.patch);
      const byTxn = new Map(entries.map((e) => [e.item.award.txnId, e]));
      for (const vd of plan.verdicts) {
        const e = byTxn.get(vd.id);
        if (!e) continue;
        if (vd.v === "credit") {
          await ctx.db.patch(e.alert._id, { status: "fixed", resolvedAt: nowIso, resolvedBy: admin.email, resolution: "paid" });
          results.push({ id: e.alert._id, outcome: "paid" });
          paidCount++; paidTotal += e.item.award.amount;
          names.push(`${student.firstName ?? ""} ${student.lastName ?? ""}`.trim() + ` ${e.item.award.amount > 0 ? "+" : ""}$${e.item.award.amount}`);
        } else if (vd.v === "absorbed") {
          await ctx.db.patch(e.alert._id, { status: "settled", resolvedAt: nowIso, resolvedBy: admin.email, resolution: "already paid by another route" });
          results.push({ id: e.alert._id, outcome: "already_paid" });
        } else {
          results.push({ id: e.alert._id, outcome: "refused", reason: vd.v });
        }
      }
    }

    if (paidCount) {
      const entryId = `arrfix_${nowMs}_${Math.random().toString(36).slice(2, 10)}`;
      const line = `Restored ${paidCount} cash movement${paidCount === 1 ? "" : "s"} that arrived without their money (net $${paidTotal}): ` +
        names.slice(0, 40).join(", ") + (names.length > 40 ? `, and ${names.length - 40} more` : "");
      await ctx.db.insert("appAuditLog", {
        entryId, timestamp: nowIso,
        payload: {
          entryId, action: "Restored lost cash awards",
          teacher: admin.name || admin.email, teacherName: admin.name || admin.email,
          details: line, reason: line, userId: admin.email, timestamp: nowIso,
        },
      });
    }
    return { paid: paidCount, net: paidTotal, results };
  },
});

/** Close alerts without paying (e.g. the teacher already re-gave it). Admin only. */
export const dismissAlerts = mutation({
  args: { ids: v.array(v.id("cashArrivalAlerts")), reason: v.string() },
  handler: async (ctx, { ids, reason }) => {
    const admin = await requireAdmin(ctx);
    const why = reason.trim();
    if (why.replace(/[^a-z0-9]/gi, "").length < 3) throw new ConvexError("Say why, in a few words.");
    if (ids.length > 200) throw new ConvexError("At most 200 at a time.");
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const cutoffMs = await readCutoffMs(ctx);
    const zp = zeroPointMs((await readState(ctx, CASH_ZERO_POINT_KEY))?.value);
    const weekRows = new Map<string, any[]>();
    const students = new Map<string, any>();
    let n = 0, closed = 0, left = 0;
    for (const id of [...new Set(ids)]) {
      const alert = await ctx.db.get(id);
      if (!alert || alert.status !== "open") continue;
      const live = await liveCheck(ctx, alert, weekRows, students, nowMs, cutoffMs, zp);
      // PAID MEANWHILE IS SETTLED, NOT DISMISSED: the recount leaves a
      // dismissed row out of the count, and leaving out money the child
      // really has would read as the balance being too high.
      if (live.paid) {
        await ctx.db.patch(id, { status: "settled", resolvedAt: nowIso, resolvedBy: admin.email, resolution: "paid by another route" });
        continue;
      }
      // A ROW THE APP CANNOT CHECK STAYS WITH THE RECOUNT (final re-review,
      // 2026-10-01). Too old for the register to say whether it was paid,
      // any decision taken here can be wrong: leaving it out under-pays a
      // child it was in fact paid to, counting it after a re-entry pays
      // twice, and a deduction goes wrong the same two ways. The recount
      // compares the whole ledger with the counters: it pays such a row only
      // when the counters lack it, and holds the student for a person when a
      // similar movement followed it. So Dismiss leaves it open, untouched.
      if (live.blocked && LEFT_FOR_THE_RECOUNT.has(live.blocked)) { left++; continue; }
      // A row that can never be paid -- from before the zero point, or for a
      // student who is gone -- is simply closed. Nothing is registered, and
      // the recount sees its ledger row exactly as it would with no alert.
      if (live.blocked || !live.student) {
        await ctx.db.patch(id, { status: "closed_unverified", resolvedAt: nowIso, resolvedBy: admin.email,
          resolution: `${why.slice(0, 250)} (closed without a decision: ${live.blocked ?? "student not found"})` });
        closed++;
        continue;
      }
      // DISMISS IS BINDING (final review): the id goes into the child's
      // register in the same transaction, WITHOUT moving any money, so a
      // stuck tab's later save or award command for it is recognised and
      // pays nothing -- exactly as if it had been paid.
      const st = live.student;
      await ctx.db.patch(st._id, {
        cashApplied: ringPush(st.cashApplied ?? null, [{ id: alert.txnId, at: alert.at, amount: alert.amount, kind: alert.kind }]),
      });
      students.set(alert.studentId, await ctx.db.get(st._id));
      await ctx.db.patch(id, { status: "dismissed", resolvedAt: nowIso, resolvedBy: admin.email, resolution: why.slice(0, 300) });
      n++;
    }
    if (n || closed) {
      const entryId = `arrdis_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const line = `Dismissed ${n} cash movement${n === 1 ? "" : "s"} that arrived without their money` +
        (closed ? ` and closed ${closed} that can never be paid` : "") + `: ${why.slice(0, 200)}`;
      await ctx.db.insert("appAuditLog", {
        entryId, timestamp: nowIso,
        payload: { entryId, action: "Dismissed lost cash awards", teacher: admin.name || admin.email,
          teacherName: admin.name || admin.email, details: line, reason: line, userId: admin.email, timestamp: nowIso },
      });
    }
    return { dismissed: n, closed, left };
  },
});

/** Turn the recording off or on. CLI only. It never moves money either way. */
export const configureAlerts = internalMutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }) => {
    const row = await readState(ctx, CASH_ARRIVAL_ALERTS_KEY);
    const at = new Date().toISOString();
    if (row) await ctx.db.patch(row._id, { value: { enabled }, mirroredAt: at });
    else await ctx.db.insert("appState", { key: CASH_ARRIVAL_ALERTS_KEY, value: { enabled }, mirroredAt: at });
    return { enabled };
  },
});

/**
 * Set, lower or clear the zero point deliberately. CLI only.
 *   npx convex run cashArrival:setZeroPoint '{"iso":"2026-09-30T20:00:00Z"}'
 *   npx convex run cashArrival:setZeroPoint '{"iso":null}'
 */
export const setZeroPoint = internalMutation({
  args: { iso: v.union(v.string(), v.null()) },
  handler: async (ctx, { iso }) => {
    if (iso !== null && !Number.isFinite(Date.parse(iso))) throw new Error(`"${iso}" is not a date.`);
    const row = await readState(ctx, CASH_ZERO_POINT_KEY);
    const at = new Date().toISOString();
    const value = iso === null ? { iso: null, source: "cleared by hand", raisedAt: at }
      : { iso: new Date(Date.parse(iso)).toISOString(), source: "set by hand", raisedAt: at };
    if (row) await ctx.db.patch(row._id, { value, mirroredAt: at });
    else await ctx.db.insert("appState", { key: CASH_ZERO_POINT_KEY, value, mirroredAt: at });
    return value;
  },
});

/**
 * A PERSON'S DECISION ON A ROW THE RECOUNT HELD (final re-review, 2026-10-01).
 *
 * The recount holds a student when an open lost award -- usually one the app
 * cannot check, which neither panel button touches -- has a similar movement
 * after it: "possibly given again". Its held-back line names the alerts.
 * This records what a person decided after looking at the student's history:
 *   - "count": it was NOT given again. The recount may count it -- paying it
 *     only if the counters lack it, then settling it -- despite the later one.
 *   - "leave_out": it was given again, or should not be paid. Dismissed and
 *     registered, exactly as a Dismiss in the panel, so the recount and every
 *     payer leave it out. Settled instead for one the register shows paid.
 *     For a row the app cannot check, the register cannot see a payment, and
 *     leaving out an award that WAS paid takes that money back -- so it needs
 *     `notPaid: true`, said by the person who checked the history.
 * Moves no money itself. CLI only:
 *   npx convex run cashArrival:resolveForRecount \
 *     '{"ids":["<alert id>"],"decision":"leave_out","notPaid":true,"reason":"Re-given at 2pm","by":"<email>"}'
 */
export const resolveForRecount = internalMutation({
  args: {
    ids: v.array(v.id("cashArrivalAlerts")),
    decision: v.union(v.literal("count"), v.literal("leave_out")),
    reason: v.string(),
    by: v.string(),
    notPaid: v.optional(v.boolean()),
  },
  handler: async (ctx, { ids, decision, reason, by, notPaid }) => {
    const why = reason.trim();
    const who = by.trim();
    if (why.replace(/[^a-z0-9]/gi, "").length < 3) throw new Error("Say why, in a few words.");
    if (!who) throw new Error("Say who decided.");
    if (decision === "leave_out" && notPaid !== true) {
      throw new Error("leave_out takes the award OUT of the count: if it was in fact paid, that takes the money back. " +
        "Check the student's history, then pass notPaid: true.");
    }
    const nowIso = new Date().toISOString();
    const results: any[] = [];
    for (const id of [...new Set(ids)]) {
      const alert = await ctx.db.get(id);
      if (!alert || alert.status !== "open") {
        results.push({ id, outcome: "not open", status: alert ? alert.status : null });
        continue;
      }
      const decided = { decision, by: who, at: nowIso, reason: why.slice(0, 300) };
      if (decision === "count") {
        await ctx.db.patch(id, { recountDecision: decided });
        results.push({ id, txnId: alert.txnId, outcome: "the recount may count it" });
        continue;
      }
      const st = await findStudent(ctx, alert.studentId);
      const cmd = !!(await ctx.db.query("cashAwardCommands").withIndex("by_txnId", (q: any) => q.eq("txnId", alert.txnId)).first());
      if (st && paidNow(st, cmd, alert.txnId)) {
        await ctx.db.patch(id, { status: "settled", recountDecision: decided, resolvedAt: nowIso, resolvedBy: who, resolution: "already paid" });
        results.push({ id, txnId: alert.txnId, outcome: "already paid: settled, not left out" });
        continue;
      }
      if (st) {
        await ctx.db.patch(st._id, {
          cashApplied: ringPush(st.cashApplied ?? null, [{ id: alert.txnId, at: alert.at, amount: alert.amount, kind: alert.kind }]),
        });
      }
      await ctx.db.patch(id, { status: "dismissed", recountDecision: decided, resolvedAt: nowIso, resolvedBy: who, resolution: why.slice(0, 300) });
      results.push({ id, txnId: alert.txnId, outcome: "left out" });
    }
    const changed = results.filter((r) => r.outcome !== "not open").length;
    if (changed) {
      const entryId = `arrdec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const line = `Decided ${changed} lost cash movement${changed === 1 ? "" : "s"} the recount held (${decision}): ${why.slice(0, 200)}`;
      await ctx.db.insert("appAuditLog", {
        entryId, timestamp: nowIso,
        payload: { entryId, action: "Decided lost cash awards", teacher: who, teacherName: who,
          details: line, reason: line, userId: who, timestamp: nowIso },
      });
    }
    return { results };
  },
});

/** What has been recorded and resolved. Counts only. CLI only. */
export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const zp = (await readState(ctx, CASH_ZERO_POINT_KEY))?.value ?? null;
    const enabled = alertsEnabled((await readState(ctx, CASH_ARRIVAL_ALERTS_KEY))?.value);
    const byStatus: Record<string, number> = {};
    for (const s of ["open", "fixed", "settled", "dismissed", "closed_unverified"]) {
      byStatus[s] = (await ctx.db.query("cashArrivalAlerts").withIndex("by_status", (q) => q.eq("status", s)).take(2000)).length;
    }
    return { enabled, zeroPoint: zp, byStatus, zeroPointSlackMin: ZERO_POINT_SLACK_MS / 60000 };
  },
});
