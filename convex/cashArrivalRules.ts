/**
 * THE ARRIVAL CREDIT: pay an award whose ledger row reached the server
 * without its money. Pure; convex/cashArrival.ts does the database part.
 *
 * WHY IT EXISTS. Measured 2026-09-29/30: four incidents in a week, about
 * seventy movements lost in one morning. A teacher awards; the award command
 * (cashAward:award) fails with HTTP 401 because the Microsoft token expired;
 * the ordinary save fails the same way; the page reloads (the "Sign in again"
 * redirect, or a manual reload) and the money that lived only in the tab's
 * memory is gone. The LEDGER ROW survives in the browser's outbox and arrives
 * on the next load, through legacyData:mergeSlice, but nothing moves the
 * counters. The nightly check finds it next morning and a person repairs it.
 *
 * THE RULE, IN ONE SENTENCE: when mergeSlice inserts a cash row that is NEW to
 * its week, the server pays exactly what cashAward:award would have paid had
 * it arrived on time -- through the same register (students.cashApplied), so
 * the command, the save and this can never pay one movement twice.
 *
 * WHAT IT MUST NOT DO, from the attack on the design (2026-09-30):
 *   - pay money from before a reset or a clear (the ZERO POINT below);
 *   - pay a late original twice when a person has since repaired or re-entered
 *     it (short age limits; the restored-twin check);
 *   - pay a refund, a reset or a store sale (validateAward's kind and
 *     reserved-behaviour rules);
 *   - take money off a child long after the fact (deductions get a shorter
 *     window than awards).
 * Anything refused is left exactly as today: the nightly check lists it and a
 * person decides.
 */

import { CASH_COUNTERS, cashMovementEffect, ringPush } from "./appDataShape";
import type { CashApplied } from "./appDataShape";
import { validateAward } from "./cashAwardRules";
import type { AwardInput } from "./cashAwardRules";
import { cashWeekKey } from "./cashReversalRules";

/** appState row holding the (retired) auto-pay switch. ABSENT MEANS OFF. */
export const CASH_ARRIVAL_SWITCH_KEY = "cashArrivalCredit";

/**
 * THE OWNER'S CHOICE, 2026-09-30 ("A + C"): nothing is paid automatically.
 * Three review rounds each found a way auto-paying could pay one award twice
 * when a person re-enters it. So an award whose ledger row arrives without
 * its money is RECORDED (cashArrivalAlerts) and an admin sees it the same day
 * with a Fix button; the Fix pays through the same register, once.
 *
 * Recording moves no money, so the switch is ON unless set off:
 *   npx convex run cashArrival:configureAlerts '{"enabled":false}'
 */
export const CASH_ARRIVAL_ALERTS_KEY = "cashArrivalAlerts";
export function alertsEnabled(value: unknown): boolean {
  return !(value && typeof value === "object" && (value as Record<string, unknown>).enabled === false);
}

/** How far back a recorded row may be dated (older ones are the nightly check's). */
export const ALERT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * appState row holding the school-wide ZERO POINT: no row dated at or before
 * it is ever paid by arrival. Raised (never lowered) by RESET ALL CASH's rows
 * arriving, by the reset and year-rollover audit entries, and by the
 * command-line zero and clear tools. RESET ALL CASH writes a reset row only
 * for children whose balance the admin's tab showed as non-zero, so a
 * per-child marker would miss exactly the children with nothing -- and pay
 * their pre-reset money into the new year.
 */
export const CASH_ZERO_POINT_KEY = "cashZeroPoint";

/**
 * Rows dated before this are never paid by arrival. Before the stale-tab
 * brake (c964a87, 2026-09-23) the server could apply money without
 * registering it, so an older row cannot be proved unpaid.
 */
export const CASH_ARRIVAL_EPOCH_MS = Date.parse("2026-09-24T00:00:00.000Z");

const HOUR = 60 * 60 * 1000;
/**
 * How late a row may arrive and still be paid. The longest measured delay is
 * about 20 hours (a teacher's rows from one afternoon arriving the next
 * morning). Longer than that and a person may already have noticed and
 * re-entered it, so a late original would pay twice: those are left to the
 * nightly check. Deductions get less, because taking money needs more care.
 */
export const ARRIVAL_MAX_AGE_AWARD_MS = 72 * HOUR;
export const ARRIVAL_MAX_AGE_DEDUCT_MS = 24 * HOUR;

/**
 * A row dated within this of a reset is refused too: the reset and the row
 * carry two different machines' clocks, and validateAward already accepts a
 * clock up to 15 minutes fast (CASH_AWARD_FUTURE_SKEW_MS). Wider than that,
 * so a fast-clock tab's pre-reset award cannot read as post-reset (review
 * finding, 2026-09-30). Refusing is the safe direction -- it is today's
 * behaviour.
 */
export const ZERO_POINT_SLACK_MS = 20 * 60 * 1000;

/**
 * THE ZERO POINT NEVER COMES FROM THE FUTURE, and a fresh reset is dated by
 * the SERVER. A reset row or audit entry carries the admin's clock; one set
 * a year ahead would switch the arrival credit off silently for a year (the
 * zero point only rises). So the time is capped at the server's now, and a
 * reset that has only just happened is dated at the server's receipt time --
 * a reset cannot arrive before it happened, so that is always at or after the
 * real one. An OLD entry re-sent by a stale tab keeps its own (older) time,
 * so it cannot drag the zero point forward.
 */
export const ZERO_POINT_FRESH_MS = 60 * 60 * 1000;
export function zeroPointTimeFor(clientIso: unknown, nowMs: number): number {
  const ms = Date.parse(String(clientIso ?? ""));
  if (!Number.isFinite(ms)) return NaN;
  const capped = Math.min(ms, nowMs);
  return nowMs - capped < ZERO_POINT_FRESH_MS ? nowMs : capped;
}

/** Roles whose reset rows and audit entries may move the zero point. */
export function mayMoveZeroPoint(role: unknown): boolean {
  const r = String(role ?? "");
  return r === "admin" || r === "superadmin";
}

/**
 * Same child, same amount, this close in time, under a different id: the
 * same movement. Covers a row rebuilt from an audit entry (cashRestore, a
 * txn_rb_ id) whose original then arrives. Wider than cashMovementKey's
 * one-second bucket, which two stamps can straddle.
 */
export const TWIN_WINDOW_MS = 2000;

/** At most this many students paid inside mergeSlice; the rest are scheduled. */
export const ARRIVAL_INLINE_MAX_STUDENTS = 60;

export type ArrivalMode = "off" | "shadow" | "on";
export type ArrivalSwitch = { mode: ArrivalMode; pilotEmails: string[] };

export function readArrivalSwitchValue(value: unknown): ArrivalSwitch {
  const v0 = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const mode: ArrivalMode = v0.mode === "on" || v0.mode === "shadow" ? v0.mode : "off";
  const pilotEmails = Array.isArray(v0.pilotEmails)
    ? (v0.pilotEmails as unknown[]).map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean)
    : [];
  return { mode, pilotEmails };
}

/** Whether a delivery by this token actually pays (vs. only logs). */
export function arrivalPays(sw: ArrivalSwitch, actorEmail: string): boolean {
  if (sw.mode !== "on") return false;
  if (!sw.pilotEmails.length) return true;
  return sw.pilotEmails.includes(String(actorEmail ?? "").trim().toLowerCase());
}

/** The zero point in ms, or -Infinity when none is set. */
export function zeroPointMs(value: unknown): number {
  const iso = (value && typeof value === "object") ? (value as Record<string, unknown>).iso : undefined;
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
}

const CASH_DOC_RE = /^cash_tx_\d{4}_W\d{2}$/;

/** The cheap gate: is this mergeSlice call a cash ledger week at all? */
export function isCashLedgerCall(a: { doc: string; collection: string; dedupeField: string; keyed: boolean }): boolean {
  return CASH_DOC_RE.test(a.doc) && a.collection === "transactions" && a.dedupeField === "id" && !a.keyed;
}

/** True for a row RESET ALL CASH wrote. */
export function isResetRow(p: unknown): boolean {
  return !!p && typeof p === "object" &&
    /^system_reset/.test(String((p as Record<string, unknown>).behaviorId ?? ""));
}

export type ArrivalRefusal = { ok: false; code: string };
export type ArrivalItem = { ok: true; award: AwardInput; row: Record<string, unknown> };

/**
 * Everything decidable about one arriving row without the database.
 * The award rules are cashAward:award's own (validateAward), with a longer age
 * limit; then the rules only a late arrival needs.
 */
export function arrivalRow(
  payload: unknown,
  doc: string,
  o: { nowMs: number; cutoffMs: number | null; zeroPointMs: number; maxAgeMs?: number },
): ArrivalItem | ArrivalRefusal {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, code: "bad_shape" };
  const p = payload as Record<string, unknown>;
  // No cutoff means nobody has said where this year's money starts. Same
  // stance as the nightly check: refused, not guessed.
  if (o.cutoffMs === null) return { ok: false, code: "no_cutoff" };
  const kind = String(p.kind ?? "");
  const c = validateAward({
    txnId: p.id as string, studentId: p.studentId as string, at: p.timestamp as string,
    amount: p.amount as number, kind, behaviorId: p.behaviorId as string,
    behaviorName: p.behaviorName as string, notes: p.notes as string,
  }, {
    nowMs: o.nowMs, cutoffMs: o.cutoffMs,
    maxAgeMs: typeof o.maxAgeMs === "number" && o.maxAgeMs > 0 ? o.maxAgeMs
      : kind === "deduct" ? ARRIVAL_MAX_AGE_DEDUCT_MS : ARRIVAL_MAX_AGE_AWARD_MS,
  });
  if (!c.ok) return { ok: false, code: c.code };
  const atMs = Date.parse(c.award.at);
  if (atMs < CASH_ARRIVAL_EPOCH_MS) return { ok: false, code: "before_epoch" };
  if (atMs <= o.zeroPointMs + ZERO_POINT_SLACK_MS) return { ok: false, code: "before_zero_point" };
  // Every writer files a row under its own week, and this is what makes "new
  // to this document" mean "new to the ledger": the same id re-filed in
  // another week is refused here rather than paid again.
  if (doc !== "cash_tx_" + cashWeekKey(c.award.at)) return { ok: false, code: "wrong_week" };
  return { ok: true, award: c.award, row: p };
}

/**
 * An index of stored rows by child and amount, for the twin check. Built once
 * per call from the rows mergeSlice already holds, so it costs no reads.
 */
export function twinIndex(stored: Array<{ payload: unknown }>): Map<string, Array<{ id: string; ms: number }>> {
  const out = new Map<string, Array<{ id: string; ms: number }>>();
  for (const r of stored) {
    const p = r && r.payload && typeof r.payload === "object" ? r.payload as Record<string, unknown> : null;
    if (!p) continue;
    const ms = Date.parse(String(p.timestamp ?? ""));
    const amt = Number(p.amount);
    if (!Number.isFinite(ms) || !Number.isFinite(amt)) continue;
    const k = `${String(p.studentId ?? "")}|${amt}`;
    (out.get(k) ?? out.set(k, []).get(k)!).push({ id: String(p.id ?? ""), ms });
  }
  return out;
}

/** Another row, under another id, for the same child and amount within the window. */
export function hasTwin(
  idx: Map<string, Array<{ id: string; ms: number }>>, a: AwardInput,
): boolean {
  const list = idx.get(`${a.studentId}|${a.amount}`);
  if (!list) return false;
  const ms = Date.parse(a.at);
  return list.some((e) => e.id !== a.txnId && Math.abs(e.ms - ms) <= TWIN_WINDOW_MS);
}

/**
 * THE RE-ENTRY SHAPE (review finding, 2026-09-30). After a reload the teacher
 * sees the balance did not move and gives the award again; that second award
 * is paid by the command at once. When the lost original arrives afterwards,
 * paying it would pay twice. So an arriving row is NOT paid when a LATER row
 * already exists for the same child, amount, kind and behaviour, by the same
 * teacher. It is held and left to the nightly check, exactly as today. A
 * genuine repeat of the same award by the same teacher is held too -- the
 * safe direction.
 */
export function reentryKey(p: unknown): string | null {
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  const who = String(r.teacherId ?? r.teacherUsername ?? r.teacherName ?? "").trim().toLowerCase();
  const sid = String(r.studentId ?? "").trim();
  const amt = Number(r.amount);
  if (!sid || !who || !Number.isFinite(amt)) return null;
  return `${sid}|${amt}|${String(r.kind ?? "")}|${String(r.behaviorId ?? "")}|${who}`;
}

/** Latest time per re-entry key, over any rows (a week, a history). */
export function reentryIndex(rows: unknown[]): Map<string, Array<{ id: string; ms: number }>> {
  const out = new Map<string, Array<{ id: string; ms: number }>>();
  for (const raw of rows ?? []) {
    const p = raw && typeof raw === "object" && "payload" in (raw as any) ? (raw as any).payload : raw;
    const k = reentryKey(p);
    if (!k) continue;
    const ms = Date.parse(String((p as any)?.timestamp ?? ""));
    if (!Number.isFinite(ms)) continue;
    (out.get(k) ?? out.set(k, []).get(k)!).push({ id: String((p as any)?.id ?? ""), ms });
  }
  return out;
}

/** A later row of the same shape, under another id, within the award window. */
export function isReentered(idx: Map<string, Array<{ id: string; ms: number }>>, row: unknown): boolean {
  const k = reentryKey(row);
  if (!k) return false;
  const list = idx.get(k);
  if (!list) return false;
  const id = String((row as any)?.id ?? "");
  const ms = Date.parse(String((row as any)?.timestamp ?? ""));
  if (!Number.isFinite(ms)) return false;
  return list.some((e) => e.id !== id && e.ms > ms && e.ms - ms <= ARRIVAL_MAX_AGE_AWARD_MS);
}

/**
 * FOR THE ADMIN'S EYES: a LATER movement for the same child, of the same
 * kind, at least as large, by ANYONE, within three days. It may be a person
 * re-entering the lost award (a colleague, a different behaviour, a lump
 * sum), or it may be an ordinary later award -- which is exactly why a
 * person decides rather than a rule. Returns what to show, or null.
 */
export type LaterSimilar = { at: string; amount: number; by: string; behavior: string };
export function laterSimilar(rows: unknown[], row: Record<string, unknown>): LaterSimilar | null {
  const sid = String(row.studentId ?? "");
  const kind = String(row.kind ?? "");
  const amt = Math.abs(Number(row.amount));
  const ms = Date.parse(String(row.timestamp ?? ""));
  const id = String(row.id ?? "");
  if (!sid || !Number.isFinite(ms) || !Number.isFinite(amt)) return null;
  let best: LaterSimilar | null = null;
  let bestMs = Infinity;
  for (const raw of rows ?? []) {
    const p: any = raw && typeof raw === "object" && "payload" in (raw as any) ? (raw as any).payload : raw;
    if (!p || String(p.id ?? "") === id) continue;
    if (String(p.studentId ?? "") !== sid || String(p.kind ?? "") !== kind) continue;
    if (!(Math.abs(Number(p.amount)) >= amt)) continue;
    const t = Date.parse(String(p.timestamp ?? ""));
    if (!Number.isFinite(t) || t <= ms || t - ms > ARRIVAL_MAX_AGE_AWARD_MS) continue;
    if (t < bestMs) {
      bestMs = t;
      best = { at: String(p.timestamp), amount: Number(p.amount), by: String(p.teacherName ?? ""), behavior: String(p.behaviorName ?? p.behaviorId ?? "") };
    }
  }
  return best;
}

/**
 * EVERY later movement that could be this award given again (second review,
 * 2026-09-30): same child, same kind, at least as large, by ANYONE, from the
 * award's time up to NOW -- not the first match, not a 3-day window. The
 * admin sees all of them, and an acknowledgement is bound to exactly this set
 * (candidateSignature), so a candidate that appears later is never waved
 * through by an earlier OK.
 */
export type Candidate = { id: string; at: string; amount: number; by: string; behavior: string };
export function laterCandidates(rows: unknown[], row: Record<string, unknown>): Candidate[] {
  const sid = String(row.studentId ?? "");
  const kind = String(row.kind ?? "");
  const amt = Math.abs(Number(row.amount));
  const ms = Date.parse(String(row.timestamp ?? ""));
  const id = String(row.id ?? "");
  if (!sid || !Number.isFinite(ms) || !Number.isFinite(amt)) return [];
  const out = new Map<string, Candidate>();
  for (const raw of rows ?? []) {
    const p: any = raw && typeof raw === "object" && "payload" in (raw as any) ? (raw as any).payload : raw;
    if (!p) continue;
    const pid = String(p.id ?? "");
    if (!pid || pid === id || out.has(pid)) continue;
    if (String(p.studentId ?? "") !== sid || String(p.kind ?? "") !== kind) continue;
    if (!(Math.abs(Number(p.amount)) >= amt)) continue;
    const t = Date.parse(String(p.timestamp ?? p.at ?? ""));
    if (!Number.isFinite(t) || t <= ms) continue;
    out.set(pid, { id: pid, at: String(p.timestamp ?? p.at), amount: Number(p.amount), by: String(p.teacherName ?? p.by ?? ""), behavior: String(p.behaviorName ?? p.behaviorId ?? p.behavior ?? "") });
  }
  return [...out.values()].sort((a, b) => a.at.localeCompare(b.at));
}
export function candidateSignature(c: Candidate[]): string {
  return c.map((x) => x.id).sort().join(",");
}

/** The latest RESET ALL CASH row in a child's own history, or -Infinity. */
export function latestResetMs(history: unknown): number {
  let best = -Infinity;
  if (!Array.isArray(history)) return best;
  for (const r of history) {
    if (!isResetRow(r)) continue;
    const t = Date.parse(String((r as Record<string, unknown>).timestamp ?? ""));
    // An undated reset cannot be placed, so nothing is paid across it.
    if (!Number.isFinite(t)) return Infinity;
    if (t > best) best = t;
  }
  return best;
}

export type StudentVerdict = { id: string; v: "credit" | "absorbed" | "coverage_lost" | "before_reset" | "reentered" };

/**
 * The decision for one child, and the patch that carries it out -- the four
 * counters, the child's own history copy and the register, in ONE patch, so
 * it lands with the ledger row or not at all.
 *
 * A movement is paid only when no payer has registered it (not in
 * cashApplied, not in cashAwardCommands) and it is newer than what the
 * register can vouch for. Every payer (the command, the save, this) checks and
 * registers inside a transaction on this same document, so they are totally
 * ordered and at most one pays.
 */
export function planStudentArrival(
  student: Record<string, any>,
  items: ArrivalItem[],
  commandIds: Set<string>,
  opts?: { ignoreReentry?: boolean },
): { verdicts: StudentVerdict[]; patch: Record<string, any> | null } {
  const cur: CashApplied | null = student.cashApplied ?? null;
  const known = new Set<string>(((cur && Array.isArray(cur.ids)) ? cur.ids : []).map((e) => String(e?.i ?? "")));
  const since = cur && typeof cur.since === "string" ? Date.parse(cur.since) : NaN;
  const reset = latestResetMs(student.wildcatCashTransactions);
  // The child's own copy holds what the command paid, so a re-entered award
  // shows up here even when it was filed in another week.
  const histIdx = reentryIndex(Array.isArray(student.wildcatCashTransactions) ? student.wildcatCashTransactions : []);

  const verdicts: StudentVerdict[] = [];
  const pay: ArrivalItem[] = [];
  const sorted = [...items].sort((x, y) => String(x.award.at).localeCompare(String(y.award.at)));
  const inCall = new Set<string>();
  for (const it of sorted) {
    const id = it.award.txnId;
    const at = Date.parse(it.award.at);
    if (known.has(id) || commandIds.has(id) || inCall.has(id)) { verdicts.push({ id, v: "absorbed" }); continue; }
    if (Number.isFinite(since) && at <= since) { verdicts.push({ id, v: "coverage_lost" }); continue; }
    if (at <= reset + ZERO_POINT_SLACK_MS) { verdicts.push({ id, v: "before_reset" }); continue; }
    // An admin's Fix has already looked at the possible re-entry and chosen.
    if (!opts?.ignoreReentry && isReentered(histIdx, it.row)) { verdicts.push({ id, v: "reentered" }); continue; }
    inCall.add(id);
    pay.push(it);
    verdicts.push({ id, v: "credit" });
  }
  if (!pay.length) return { verdicts, patch: null };

  const patch: Record<string, any> = {};
  for (const f of CASH_COUNTERS) {
    const b = Number(student[f]);
    patch[f] = Number.isFinite(b) ? b : 0;
  }
  for (const it of pay) {
    const e = cashMovementEffect(it.award.amount, it.award.kind);
    for (const f of CASH_COUNTERS) patch[f] += e[f] || 0;
  }
  // The child's own copy is the recount's second witness and the wallet's
  // source. Appended when missing, never replaced.
  const hist: any[] = Array.isArray(student.wildcatCashTransactions) ? student.wildcatCashTransactions : [];
  const have = new Set(hist.map((r) => String(r?.id ?? "")));
  const add = pay.filter((it) => !have.has(it.award.txnId)).map((it) => it.row);
  if (add.length) patch.wildcatCashTransactions = [...hist, ...add];
  patch.cashApplied = ringPush(cur, pay.map((it) => ({
    id: it.award.txnId, at: it.award.at, amount: it.award.amount, kind: it.award.kind,
  })));
  return { verdicts, patch };
}

/** "code:n, code:n" for a log line, most common first. */
export function countsByCode(held: Array<{ code: string }>): string {
  const c: Record<string, number> = {};
  for (const h of held) c[h.code] = (c[h.code] ?? 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(", ");
}
