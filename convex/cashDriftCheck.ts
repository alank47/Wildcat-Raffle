import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { requireStaff, requireAdmin } from "./identity";

/**
 * The nightly answer to "are the cash counters still telling the truth?"
 *
 * WHY THIS EXISTS. On 2026-09-17 a repair brought 223 students' counters back
 * into agreement with their transaction history. On 2026-09-18 -- one school
 * day later -- 28 of them had drifted again, because the cause was still live:
 * a cash ROW is idempotent and a counter DELTA is not, so anything that
 * disturbs a save desynchronises them. The owner found out on the Sunday,
 * because somebody happened to look. That is the part this fixes. A daily
 * report means the worst case is one school day of drift, noticed the next
 * morning, instead of a week of it noticed by a teacher.
 *
 * IT NEVER WRITES A COUNTER, and that refusal is the whole design. It calls
 * cashRecount.recountStudents with `apply: false`, which is the same
 * derivation, the same two-witness check and the same safety rails as the
 * repair -- so the number it reports is exactly what a repair would do. What
 * it must not do is DO it, for a reason that has nothing to do with caution:
 *
 *   `_startNewSchoolYear` writes NO ledger row. Unlike a balance reset, which
 *   records a `system_reset` row that the derivation treats as a zero point,
 *   the year roll simply zeroes the counters and leaves the year's rows in
 *   place. So on the night after a rollover the derivation would find every
 *   student "short" by their entire closed year, both witnesses would agree,
 *   and the change would be an INCREASE -- so the decrease guard would not
 *   fire either. An auto-patching nightly job would resurrect the whole
 *   previous school year, school-wide, in one unattended run.
 *
 * Until the rollover is fixed, this reports and stops. The report is written
 * where a person will meet it: an appState row the dashboard tile reads, and
 * an audit entry on the nights when something is actually wrong.
 */

/** Pages of ledger to read before giving up and saying so. */
const MAX_PAGES = 200;

/** Students compared per call. One week document is re-read per call. */
const SLICE = 25;

/**
 * The ISO-week keys covering a span, matching cashReversalRules.cashWeekKey
 * and the driver script. Pure, so it can be tested without a clock.
 *
 * Bounded by the HISTORY CUTOFF at the caller, never open-ended: rows before
 * the cutoff were deliberately purged, and counting them would report the
 * whole school as short.
 */
export function cashWeekKeys(fromIso: unknown, toIso: unknown): string[] {
  const from = Date.parse(String(fromIso ?? ""));
  const to = Date.parse(String(toIso ?? ""));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const keys: string[] = [];
  // A week past the end, because a row written just after midnight UTC on a
  // Sunday belongs to the next ISO week.
  for (let t = from; t <= to + 7 * 86400000; t += 7 * 86400000) {
    const k = weekKeyOf(t);
    if (k && keys.indexOf(k) < 0) keys.push(k);
  }
  return keys;
}

function weekKeyOf(ms: number): string | null {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = u.getUTCDay() || 7;
  u.setUTCDate(u.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(u.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((u.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${u.getUTCFullYear()}_W${String(week).padStart(2, "0")}`;
}

/**
 * Shape what the batches found into the one line a person reads.
 *
 * `diverged` counts students a repair WOULD change; `heldBack` counts those it
 * would refuse -- a balance that would go DOWN, or two witnesses that
 * disagree. Both are drift and both are reported, because a held-back student
 * is not a student who is fine. Pure, so the wording is testable.
 */
export function driftSummary(batches: readonly any[], extra?: Record<string, unknown>): Record<string, any> {
  let checked = 0, diverged = 0, heldBack = 0, alreadyCorrect = 0, netOwed = 0, notFound = 0;
  for (const b of batches || []) {
    if (!b) continue;
    checked += Number(b.seen) || 0;
    diverged += Number(b.repaired) || 0;
    heldBack += Number(b.heldBack) || 0;
    alreadyCorrect += Number(b.alreadyCorrect) || 0;
    notFound += Number(b.notFound) || 0;
    netOwed += Number(b.balanceMoved) || 0;
  }
  const wrong = diverged + heldBack;
  return {
    ok: true,
    checked, diverged, heldBack, alreadyCorrect, notFound,
    netOwed: Math.round(netOwed),
    clean: wrong === 0,
    headline: wrong === 0
      ? `All ${checked} students with cash history agree with their records.`
      : `${wrong} of ${checked} students' balances disagree with their records` +
        (netOwed ? ` (${netOwed > 0 ? "+" : "-"}$${Math.abs(Math.round(netOwed)).toLocaleString("en-US")} net)` : "") +
        (heldBack ? `, ${heldBack} of them needing a person to look` : "") + ".",
    ...(extra || {}),
  };
}

/**
 * WHICH students, not just how many.
 *
 * THE GAP THIS CLOSES, in the owner's words: "i clicked and it sent to the
 * audit log but how am i supposed to know the balances that need attention".
 * A count is an alarm; it is not something a person can act on. The only way
 * to see the list was to run a script from a laptop, which is no use to
 * somebody standing in a school.
 *
 * Each row carries what is STORED against what the records SAY, because the
 * difference is the whole question, and a held-back student carries the reason
 * they were held back -- those are the ones that need a decision rather than a
 * correction.
 *
 * Worst first, capped, and `rowsTruncated` says so rather than the list
 * quietly ending. Pure, so the shaping is testable.
 */
export function driftRows(
  batches: readonly any[],
  cap = 200,
): { rows: any[]; rowsTruncated: boolean } {
  const out: any[] = [];
  for (const b of batches || []) {
    for (const d of (b && b.details) || []) {
      const act = String((d && d.action) || "");
      if (act !== "would repair" && act !== "held back") continue;
      const changes = (d && d.changes) || [];
      const bal = changes.find((c: any) => c && c.field === "wildcatCashBalance") || null;
      out.push({
        studentId: String((d && d.studentId) || ""),
        name: String((d && d.name) || ""),
        heldBack: act === "held back",
        why: d && d.why ? String(d.why) : null,
        storedBalance: bal ? bal.was : null,
        recordsSay: bal ? bal.now : null,
        difference: bal ? Number(bal.now) - Number(bal.was) : 0,
        // Named plainly, because "wildcatCashDeducted" is not a word anybody
        // outside this repo uses.
        alsoWrong: changes
          .filter((c: any) => c && c.field !== "wildcatCashBalance")
          .map((c: any) => String(c.field).replace("wildcatCash", "").toLowerCase()),
      });
    }
  }
  out.sort((a, b) =>
    Math.abs(Number(b.difference) || 0) - Math.abs(Number(a.difference) || 0) ||
    String(a.name).localeCompare(String(b.name)));
  return { rows: out.slice(0, cap), rowsTruncated: out.length > cap };
}

/** Where the dashboard reads the last result from. */
const STATE_KEY = "cashDriftCheck";

export const recordResult = internalMutation({
  args: { result: v.any() },
  handler: async (ctx, { result }) => {
    const at = new Date().toISOString();
    const value = { ...(result || {}), at };

    const row = await ctx.db
      .query("appState")
      .withIndex("by_key", (q) => q.eq("key", STATE_KEY))
      .unique();
    if (row) await ctx.db.patch(row._id, { value, mirroredAt: at });
    else await ctx.db.insert("appState", { key: STATE_KEY, value, mirroredAt: at });

    // AN AUDIT ENTRY ONLY ON THE NIGHTS SOMETHING IS WRONG.
    //
    // One every night would be 180 rows a year saying nothing happened, in the
    // feed a person reads to find what did. "Did it run?" is answered by the
    // appState row above, which is overwritten and always current. "Was
    // anything wrong?" is answered here, where it will be found.
    const wrong = (Number(value.diverged) || 0) + (Number(value.heldBack) || 0);
    if (value.ok === false || wrong > 0) {
      const entryId = `a_drift_${at.replace(/[^0-9]/g, "")}`;
      await ctx.db.insert("appAuditLog", {
        entryId,
        timestamp: at,
        payload: {
          action: "cash_drift_detected",
          entryId, timestamp: at,
          // "All students", not "": describe() renders an entry with no name
          // as "Student #" + studentId, so an empty name and studentId "all"
          // read as a child called "Student #all".
          studentId: "all", studentName: "All students",
          category: "Wildcat Cash",
          teacher: "System (nightly check)",
          teacherName: "System (nightly check)",
          teacherId: "",
          details: value.ok === false
            ? `The nightly cash check could not run: ${String(value.why || "unknown")}`
            : `${value.headline} Nothing was changed: this check only reports. ` +
              `Run scripts/recount-cash-counters.mjs --prod to see the list, ` +
              `and --apply to correct it.`,
          reason: "Stored cash counters disagree with the transaction ledger",
        },
      });
    }
    return { recorded: true, at, wrong };
  },
});

/**
 * Run the check. Scheduled nightly; safe to run by hand any time.
 *
 * An ACTION rather than a mutation because it has to page: the ledger and the
 * students table together are already past a third of Convex's 4,096 reads per
 * call and they grow every school day. An action holds no transaction of its
 * own, so it can call a bounded query as many times as it needs.
 */
export const nightly = internalAction({
  args: { reason: v.optional(v.string()) },
  // The return type is annotated because this action returns the result of
  // recordResult, which lives in this same module -- TypeScript cannot infer
  // through that cycle and reports the handler as implicitly `any`.
  handler: async (ctx, { reason }): Promise<Record<string, any>> => {
    const started = Date.now();

    const cut: any = await ctx.runQuery(internal.legacyPurge.historyCutoff, {});
    const cutoffIso = cut && cut.value ? cut.value.iso : null;
    if (!cutoffIso || !Number.isFinite(Date.parse(String(cutoffIso)))) {
      // REFUSED, NOT GUESSED. Without the cutoff there is no way to tell a
      // post-reset row from a purged one, and a check that reports the whole
      // school as short is worse than no check.
      return await ctx.runMutation(internal.cashDriftCheck.recordResult, {
        result: { ok: false, why: "no history cutoff is set", reason: reason ?? null },
      });
    }

    const nowIso = new Date().toISOString();
    const today = nowIso.slice(0, 10);
    const weeks = cashWeekKeys(cutoffIso, nowIso);

    const byStudent = new Map<string, any[]>();
    let pages = 0, unreadable = 0, capped = false, rowCount = 0;
    for (const w of weeks) {
      let cursor: string | null = null;
      let done = false;
      while (!done) {
        if (pages >= MAX_PAGES) { capped = true; break; }
        pages++;
        const page: any = await ctx.runQuery(internal.cashRecount.ledgerPage, {
          doc: `cash_tx_${w}`, cursor, numItems: 500,
        });
        for (const r of page.rows || []) {
          const id = String(r.studentId || "");
          if (!id) continue;
          const list = byStudent.get(id);
          if (list) list.push(r); else byStudent.set(id, [r]);
          rowCount++;
        }
        unreadable += Number(page.unreadable) || 0;
        cursor = page.cursor;
        done = page.isDone === true;
      }
      if (capped) break;
    }

    const rev: any = await ctx.runQuery(internal.cashRecount.reversalDeltas, {});
    if (rev && rev.capped) {
      return await ctx.runMutation(internal.cashDriftCheck.recordResult, {
        result: { ok: false, why: "the reversal register came back capped", reason: reason ?? null },
      });
    }

    const entries = [...byStudent.entries()].map(([studentId, rows]) => ({ studentId, rows }));
    const batches: any[] = [];
    for (let i = 0; i < entries.length; i += SLICE) {
      // apply:false -- this is the repair's own derivation, asked and not told.
      batches.push(await ctx.runMutation(internal.cashRecount.recountStudents, {
        students: entries.slice(i, i + SLICE),
        reversalDeltas: rev ? rev.byTxnId : {},
        apply: false,
      }));
    }

    const result = driftSummary(batches, {
      // The list itself, so the screen can name the students rather than
      // leaving somebody to run a script to find out who they are.
      ...driftRows(batches),
      reason: reason ?? null,
      cutoff: cutoffIso,
      today,
      weeks: weeks.length,
      ledgerRows: rowCount,
      unreadableRows: unreadable,
      // Said out loud rather than swallowed: a capped read means the answer
      // below is over part of the ledger, which is exactly how a check quietly
      // stops checking.
      capped,
      tookMs: Date.now() - started,
    });
    return await ctx.runMutation(internal.cashDriftCheck.recordResult, { result });
  },
});

/**
 * Run the check now, rather than waiting for tonight.
 *
 * ADMIN ONLY, and scheduled rather than awaited: the action pages the whole
 * ledger, so a browser must not sit on an open request for it. The screen
 * polls `latest` for the new timestamp.
 */
export const recheckNow = mutation({
  args: {},
  handler: async (ctx) => {
    const staff = await requireAdmin(ctx);
    await ctx.scheduler.runAfter(0, internal.cashDriftCheck.nightly, {
      reason: `by hand: ${String(staff.email ?? "")}`,
    });
    return { scheduled: true, at: new Date().toISOString() };
  },
});

/** The last result, for the dashboard tile. Read-only. */
export const latest = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);
    const row = await ctx.db
      .query("appState")
      .withIndex("by_key", (q) => q.eq("key", STATE_KEY))
      .unique();
    return { found: Boolean(row), value: row ? (row.value as any) : null };
  },
});
