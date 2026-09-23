import { mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff } from "./identity";
import { CASH_COUNTERS, ringPush } from "./appDataShape";
import { cashWeekKey } from "./cashReversalRules";
import {
  CASH_AWARD_SWITCH_KEY, CASH_AWARD_MAX_BATCH,
  CASH_AWARD_MAX_AGE_MS, CASH_AWARD_FUTURE_SKEW_MS,
  cashAwardAuditId, validateAward, buildLedgerRow, buildAuditPayload,
  smallInt, cashMovementEffect,
} from "./cashAwardRules";

/**
 * A WILDCAT CASH AWARD, AS ONE SERVER COMMAND. See cashAwardRules.ts for why.
 *
 * WHAT HAPPENS IN THE ONE TRANSACTION, for each award in the call:
 *
 *   1. The receipt register is checked by index. A receipt already recorded is
 *      answered from the register and nothing moves -- a retry, a double tap
 *      and a lost response all end here.
 *   2. The student is found BY INDEX, exactly as appData:save finds them
 *      (legacyId, then studentNumber). Never a collect(): reading all ~760
 *      students would put every award in conflict with every save, which is
 *      the 2026-09-08 "saves slow or never landed" shape.
 *   3. If the student's `cashApplied` list already holds the receipt, the
 *      browser's ordinary save got there first and moved the money. That is
 *      recorded and nothing moves again.
 *   4. The week's RECENT ledger rows are checked for the receipt. The ordinary
 *      save's ledger write can land before this command does; if it has, the
 *      row is not inserted a second time. A receipt the ledger holds for a
 *      DIFFERENT child is refused outright.
 *   5. Otherwise the counters move from the SERVER'S numbers by the award's
 *      effect, the receipt joins `cashApplied` (so the ordinary save that
 *      follows is recognised and absorbed), the row is appended to the
 *      student's own history (the child's wallet reads that copy), the row is
 *      inserted into the week's ledger unless step 4 found it, and the audit
 *      entry is written.
 *   6. The receipt is registered.
 *
 * A refusal for one student is that student's refusal, returned in the result,
 * never a throw: one bad row must not roll a whole class's awards back.
 *
 * OFF UNLESS SWITCHED ON. The switch is an appState row, absent means off, and
 * it is checked here on every call -- so turning it off takes effect on the
 * next award in every open tab, with no deploy and nobody refreshing. While it
 * is off this answers {ok:false, code:"disabled"} and moves nothing, and the
 * browser's ordinary save delivers the award exactly as it did before today.
 */

type Switch = { enabled: boolean; pilotEmails: string[] };

async function readSwitch(ctx: any): Promise<Switch> {
  const row = await ctx.db.query("appState")
    .withIndex("by_key", (q: any) => q.eq("key", CASH_AWARD_SWITCH_KEY)).first();
  const v0 = (row?.value ?? {}) as Record<string, unknown>;
  const pilot = Array.isArray(v0.pilotEmails)
    ? (v0.pilotEmails as unknown[]).map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean)
    : [];
  return { enabled: v0.enabled === true, pilotEmails: pilot };
}

/** On, and either open to everyone or naming this caller. */
export function switchAllows(sw: Switch, email: string): boolean {
  if (!sw.enabled) return false;
  if (!sw.pilotEmails.length) return true;
  return sw.pilotEmails.includes(String(email ?? "").trim().toLowerCase());
}

async function readCutoffMs(ctx: any): Promise<number | null> {
  const row = await ctx.db.query("appState")
    .withIndex("by_key", (q: any) => q.eq("key", "historyCutoff")).first();
  const iso = (row?.value as Record<string, unknown> | undefined)?.iso;
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * HOW FAR BACK IN A WEEK'S LEDGER THE COMMAND LOOKS FOR ITS OWN RECEIPT.
 *
 * THE RACE, found by review 2026-09-23. The ordinary save writes the ledger
 * row (legacyData:mergeSlice) and moves the counter (appData:save) in two
 * separate mutations. If the row lands first and the counter's save has not,
 * the command finds no receipt in `cashApplied`, rightly moves the money --
 * and used to insert a second row with the same id beside the first. The
 * ledger then showed the award twice until some later merge deleted one.
 *
 * WHY NOT READ THE WHOLE WEEK, which is what mergeSlice does: this week held
 * 928 rows by Wednesday morning, and every award would pay for all of them.
 * A row carrying THIS receipt cannot predate the award, so only rows created
 * in the last hour can hold it: the award is at most CASH_AWARD_MAX_AGE_MS old
 * by its own clock, that clock may run CASH_AWARD_FUTURE_SKEW_MS fast, and the
 * rest is slack. `_creationTime` is the implicit last field of every index, so
 * this is an index range read of the week's tail, not a scan.
 *
 * THE READ IS ALSO THE LOCK. Convex serialises two mutations when one writes
 * inside a range the other read. mergeSlice inserts at the week's tail, which
 * is exactly this range, so if the two race, one of them is retried and then
 * sees the other's row. Without the read nothing tied them together.
 */
const LEDGER_LOOKBACK_MS = CASH_AWARD_MAX_AGE_MS + CASH_AWARD_FUTURE_SKEW_MS + 15 * 60 * 1000;
/** Far above an hour of this school's awards (928 in the first 2.5 days of a week). */
const LEDGER_LOOKBACK_MAX_ROWS = 4000;

/** A ledger payload, whether it was stored as an object or a JSON string. */
function ledgerPayload(raw: unknown): Record<string, any> | null {
  let p: any = raw;
  if (typeof p === "string") {
    try { p = JSON.parse(p); } catch { return null; }
  }
  return p && typeof p === "object" ? p : null;
}

/** Receipt id -> the student it was written for, over the week's recent tail. */
async function recentLedgerReceipts(ctx: any, doc: string, sinceMs: number): Promise<Map<string, string>> {
  const rows = await ctx.db.query("legacyMirror")
    .withIndex("by_doc_collection", (q: any) =>
      q.eq("doc", doc).eq("collection", "transactions").gte("_creationTime", sinceMs))
    .take(LEDGER_LOOKBACK_MAX_ROWS);
  const out = new Map<string, string>();
  for (const r of rows) {
    const p = ledgerPayload(r.payload);
    if (p && p.id !== undefined && p.id !== null) out.set(String(p.id), String(p.studentId ?? ""));
  }
  return out;
}

/** The same resolution appData:save uses, so both paths land on one child. */
async function findStudent(ctx: any, key: string) {
  const byLegacy = await ctx.db.query("students")
    .withIndex("by_legacyId", (q: any) => q.eq("legacyId", key)).first();
  if (byLegacy) return byLegacy;
  return await ctx.db.query("students")
    .withIndex("by_studentNumber", (q: any) => q.eq("studentNumber", key)).first();
}

const awardArg = v.object({
  studentId: v.string(),
  txnId: v.string(),
  at: v.string(),
  amount: v.number(),
  kind: v.string(),
  behaviorId: v.string(),
  behaviorName: v.string(),
  notes: v.string(),
});

export const award = mutation({
  args: {
    awards: v.array(awardArg),
    // Display metadata for the audit entry only; see buildAuditPayload.
    week: v.optional(v.union(v.number(), v.null())),
    cycle: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const teacher = await requireStaff(ctx);
    // THE ACTOR IS THE TOKEN, never the payload. The browser does not say who
    // is awarding; the verified sign-in does.
    //
    // PRECISELY: the id and the email are the token's. The display NAME is read
    // from the teachers row, which appData:save lets staff edit, so it is only
    // as trustworthy as that row -- the same as every other path that writes a
    // teacher's name onto a record. When attribution matters, the register's
    // actorEmail and the row's teacherId are the evidence, not the name.
    const actor = {
      id: String((teacher as any).legacyId ?? teacher._id ?? ""),
      name: String(teacher.name ?? "Unknown"),
      email: String(teacher.email ?? ""),
    };

    const sw = await readSwitch(ctx);
    if (!switchAllows(sw, actor.email)) {
      return { ok: false as const, code: "disabled", results: [] as any[] };
    }
    if (args.awards.length > CASH_AWARD_MAX_BATCH) {
      return {
        ok: false as const, code: "too_many",
        reason: `At most ${CASH_AWARD_MAX_BATCH} awards per call.`,
        results: [] as any[],
      };
    }

    const cutoffMs = await readCutoffMs(ctx);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const week = smallInt(args.week, 60);
    const cycle = smallInt(args.cycle, 500);

    const results: any[] = [];
    const seen = new Set<string>();
    // One read of each week's tail per call, however many awards share it: a
    // class award of 30 must not read the same rows 30 times.
    const ledgerByWeek = new Map<string, Map<string, string>>();
    const ledgerSinceMs = nowMs - LEDGER_LOOKBACK_MS;

    for (const raw of args.awards) {
      const checked = validateAward(raw, { nowMs, cutoffMs });
      if (!checked.ok) {
        results.push({
          txnId: String(raw.txnId ?? ""), studentId: String(raw.studentId ?? ""),
          status: "refused", code: checked.code, reason: checked.reason, wroteRecords: false,
        });
        continue;
      }
      const a = checked.award;
      const entryId = cashAwardAuditId(a.txnId);

      if (seen.has(a.txnId)) {
        results.push({ txnId: a.txnId, studentId: a.studentId, status: "refused",
          code: "duplicate_in_call", reason: "The same receipt appeared twice in one call.", wroteRecords: false });
        continue;
      }
      seen.add(a.txnId);

      // 1. THE REGISTER. One indexed read; the whole idempotency story for
      //    this command, and never a scan of a ledger week.
      const reg = await ctx.db.query("cashAwardCommands")
        .withIndex("by_txnId", (q) => q.eq("txnId", a.txnId)).first();
      if (reg) {
        results.push({ txnId: a.txnId, studentId: reg.studentId, status: "alreadyApplied",
          via: reg.status, wroteRecords: reg.wroteRecords, entryId });
        continue;
      }

      // 2. THE STUDENT, by index.
      const student = await findStudent(ctx, a.studentId);
      if (!student) {
        results.push({ txnId: a.txnId, studentId: a.studentId, status: "refused",
          code: "student_not_found", reason: "No student matches that id.", wroteRecords: false });
        continue;
      }
      const appStudentId = String(student.legacyId ?? student.studentNumber ?? student._id);

      // 3. ALREADY APPLIED BY THE ORDINARY SAVE? Then it moved the money, and
      //    it will also deliver the ledger row and audit entry, so this writes
      //    nothing but the register -- and says so, so the browser does not
      //    treat those records as already on the server.
      const cur = (student as any).cashApplied ?? null;
      const known = new Set<string>(
        ((cur && Array.isArray(cur.ids)) ? cur.ids : []).map((e: any) => String(e?.i ?? "")));
      if (known.has(a.txnId)) {
        await ctx.db.insert("cashAwardCommands", {
          txnId: a.txnId, studentId: appStudentId, status: "absorbed", wroteRecords: false,
          amount: a.amount, kind: a.kind, actorEmail: actor.email, at: a.at, recordedAt: nowIso,
        });
        results.push({ txnId: a.txnId, studentId: appStudentId, status: "alreadyApplied",
          via: "absorbed", wroteRecords: false, entryId });
        continue;
      }
      // Older than the register can vouch for. The ordinary save refuses the
      // same movement for the same reason, so neither path pays it twice.
      const sinceMs = (cur && typeof cur.since === "string") ? Date.parse(cur.since) : NaN;
      if (Number.isFinite(sinceMs) && Date.parse(a.at) <= sinceMs) {
        results.push({ txnId: a.txnId, studentId: appStudentId, status: "refused",
          code: "coverage_lost", reason: "The award predates what the register can vouch for.",
          wroteRecords: false });
        continue;
      }

      // 4. THE WEEK'S RECENT LEDGER. See LEDGER_LOOKBACK_MS.
      const weekDoc = "cash_tx_" + cashWeekKey(a.at);
      let ledger = ledgerByWeek.get(weekDoc);
      if (!ledger) {
        ledger = await recentLedgerReceipts(ctx, weekDoc, ledgerSinceMs);
        ledgerByWeek.set(weekDoc, ledger);
      }
      const ledgerOwner = ledger.get(a.txnId);
      if (ledgerOwner !== undefined && ledgerOwner !== ""
          && ledgerOwner !== appStudentId && ledgerOwner !== a.studentId) {
        // A real receipt, named for a different child. Every ledger id is
        // visible to staff, so this is the one way to aim an existing receipt
        // at someone else; nothing moves.
        results.push({ txnId: a.txnId, studentId: appStudentId, status: "refused",
          code: "receipt_in_use", reason: "That receipt already belongs to another student's award.",
          wroteRecords: false });
        continue;
      }
      const ledgerHasRow = ledgerOwner !== undefined;

      // 5. THE MONEY, FROM THE SERVER'S OWN NUMBERS.
      const effect = cashMovementEffect(a.amount, a.kind);
      const patch: Record<string, any> = {};
      for (const f of CASH_COUNTERS) {
        const base = Number((student as any)[f]);
        patch[f] = (Number.isFinite(base) ? base : 0) + (effect[f] || 0);
      }
      const balanceAfter = patch.wildcatCashBalance;
      const row = buildLedgerRow({ award: a, student, appStudentId, actor, balanceAfter });

      // The child's own copy: the wallet, the recount's second witness and the
      // nightly drift check all read it. Appended, never replaced.
      const history = Array.isArray((student as any).wildcatCashTransactions)
        ? (student as any).wildcatCashTransactions : [];
      if (!history.some((r: any) => String(r?.id ?? "") === a.txnId)) {
        patch.wildcatCashTransactions = [...history, row];
      }
      // THE RECEIPT JOINS THE LIST appData:save CHECKS. This is what makes the
      // ordinary save that follows a second later a harmless duplicate rather
      // than a second award. The ring entry is dated by the award's own time,
      // so the register's watermark means the same thing on both paths.
      patch.cashApplied = ringPush(cur, [{ id: a.txnId, at: a.at, amount: a.amount, kind: a.kind }]);
      await ctx.db.patch(student._id, patch);

      // The ledger row, into the week its own timestamp belongs to. NO `key`:
      // one keyed row makes loadDoc return only the keyed rows and every
      // client's ledger empties (cashReversal.ts records the day it happened).
      // Not when the ordinary save's copy is already there (step 4).
      if (!ledgerHasRow) {
        await ctx.db.insert("legacyMirror", {
          doc: weekDoc,
          collection: "transactions",
          payload: row,
          mirroredAt: nowIso,
        });
        ledger.set(a.txnId, appStudentId);
      }

      // The audit entry, under the id the browser derives the same way, so its
      // own copy -- still sent by the ordinary save -- is refused as a
      // duplicate by auditLog:append rather than appearing twice.
      const existingAudit = await ctx.db.query("appAuditLog")
        .withIndex("by_entryId", (q) => q.eq("entryId", entryId)).first();
      if (!existingAudit) {
        await ctx.db.insert("appAuditLog", {
          entryId,
          timestamp: a.at,
          payload: buildAuditPayload({
            award: a, entryId, appStudentId, studentName: String(row.studentName ?? ""),
            actor, week, cycle,
          }),
        });
      }

      // 6. THE REGISTER, last, in the same transaction as everything above.
      await ctx.db.insert("cashAwardCommands", {
        txnId: a.txnId, studentId: appStudentId, status: "applied", wroteRecords: true,
        amount: a.amount, kind: a.kind, actorEmail: actor.email, at: a.at, recordedAt: nowIso,
      });

      results.push({
        txnId: a.txnId, studentId: appStudentId, status: "applied", wroteRecords: true, entryId,
        balanceAfter,
        counters: {
          wildcatCashBalance: patch.wildcatCashBalance,
          wildcatCashEarned: patch.wildcatCashEarned,
          wildcatCashSpent: patch.wildcatCashSpent,
          wildcatCashDeducted: patch.wildcatCashDeducted,
        },
      });
    }

    return { ok: true as const, results };
  },
});

/**
 * Turn the command on or off, or restrict it to named staff. CLI only.
 *
 *   npx convex run cashAward:configure '{"enabled":true}'
 *   npx convex run cashAward:configure '{"enabled":true,"pilotEmails":["a@b.org"]}'
 *   npx convex run cashAward:configure '{"enabled":false}'
 *
 * An internalMutation, so no browser can reach it.
 */
export const configure = internalMutation({
  args: {
    enabled: v.optional(v.boolean()),
    pilotEmails: v.optional(v.array(v.string())),
  },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("appState")
      .withIndex("by_key", (q) => q.eq("key", CASH_AWARD_SWITCH_KEY)).first();
    const prev = (row?.value ?? {}) as Record<string, unknown>;
    const next = {
      enabled: a.enabled ?? (prev.enabled === true),
      pilotEmails: a.pilotEmails ?? (Array.isArray(prev.pilotEmails) ? prev.pilotEmails : []),
    };
    const at = new Date().toISOString();
    if (row) await ctx.db.patch(row._id, { value: next, mirroredAt: at });
    else await ctx.db.insert("appState", { key: CASH_AWARD_SWITCH_KEY, value: next, mirroredAt: at });
    return next;
  },
});

/**
 * The switch, and what the command has done lately. Counts only. CLI only.
 *
 * NEWEST FIRST, and says when it stopped counting. It used to read the OLDEST
 * 2000 rows, so once the command had been on for a while, the "last" it showed
 * during a rollout watch was weeks stale and the counts were silently partial.
 */
const STATUS_MAX_ROWS = 2000;
export const status = internalQuery({
  args: { sinceIso: v.optional(v.string()) },
  handler: async (ctx, { sinceIso }) => {
    const sw = await readSwitch(ctx);
    const rows = await ctx.db.query("cashAwardCommands")
      .withIndex("by_recordedAt", (q) => sinceIso ? q.gte("recordedAt", sinceIso) : q)
      .order("desc")
      .take(STATUS_MAX_ROWS);
    const byStatus: Record<string, number> = {};
    const byActor: Record<string, number> = {};
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      byActor[r.actorEmail] = (byActor[r.actorEmail] || 0) + 1;
    }
    return {
      switch: sw, commands: rows.length, capped: rows.length === STATUS_MAX_ROWS,
      since: sinceIso ?? null, byStatus, byActor,
      last: rows.slice(0, 5).map((r) => ({ at: r.recordedAt, status: r.status, amount: r.amount, who: r.actorEmail })),
    };
  },
});
