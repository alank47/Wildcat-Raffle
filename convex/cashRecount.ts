import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { deriveCounters, recountVerdict } from "./cashRecountRules";
import { ringPush } from "./appDataShape";
import { laterCandidates, ZERO_POINT_SLACK_MS } from "./cashArrivalRules";

/**
 * Putting the four cash counters back in agreement with the ledger.
 *
 * WHY THIS IS PAGED, and not one call. The cash ledger grows by roughly 450
 * rows a school day (6,954 rows, ~3.9 MiB on 2026-10-05) and every one of the
 * 763 student rows carries its own copy of its cash history (~3.2 MiB). The
 * limit a single execution reading both runs into is Convex's 16 MiB of data
 * read (the others: 32,000 documents scanned, 4,096 index ranges, 8,192 array
 * elements) -- this comment used to say "4,096 document reads", which is the
 * index-range limit and is not what one collect() counts against. Either way
 * a repair that works this afternoon and fails next month is worse than no
 * repair. So the ledger is read a page at a time by `ledgerPage`, the driver
 * groups it by student, and `recountStudents` reads only the students in its
 * own slice, by index, one read each.
 *
 * WHY THE DRIVER NEVER DECIDES ANYTHING. It transports rows; every rule lives
 * in cashRecountRules.ts and runs here, server-side, once. A plan computed in
 * a script is a second implementation of the derivation, and two
 * implementations of a money rule disagree eventually.
 *
 * TWO WITNESSES BEFORE ANY MONEY MOVES. Each student's counters are derived
 * twice -- from the weekly `cash_tx_*` ledger, and again from the student
 * record's own `wildcatCashTransactions` -- and a student whose two histories
 * disagree is held back and reported, never patched. On 2026-09-17 all 509
 * students with cash history agreed on both, to the row and to the dollar,
 * which is what made the stored counters the odd one out rather than the
 * ledger. But `distributeCashTransactions` overwrites that cache from whatever
 * a single tab holds, and on 2026-09-16 it wrote a 306-row view over a
 * 1,094-row ledger, so the agreement has to be checked and not assumed.
 *
 * internalQuery / internalMutation: reachable only with the deploy key, never
 * from a browser. Rewriting the balances of the whole school is not something
 * a signed-in teacher should be one call away from.
 */

/** A ledger payload, whatever it was stored as. */
function payloadOf(raw: unknown): Record<string, any> | null {
  let p: any = raw;
  if (typeof p === "string") {
    try { p = JSON.parse(p); } catch { return null; }
  }
  return p && typeof p === "object" ? p : null;
}

/** Only the fields the derivation reads. Keeps the page small. */
function compactRow(p: Record<string, any>): Record<string, any> {
  const amount = Number(p.amount);
  return {
    id: String(p.id ?? ""),
    studentId: String(p.studentId ?? ""),
    // Null rather than NaN: NaN is not valid JSON, and the derivation
    // excludes a row whose amount is not a finite number anyway.
    amount: Number.isFinite(amount) ? amount : null,
    kind: String(p.kind ?? ""),
    behaviorId: String(p.behaviorId ?? ""),
    notes: String(p.notes ?? ""),
    timestamp: String(p.timestamp ?? ""),
  };
}

/** One page of a weekly cash document, reduced to what the derivation needs. */
export const ledgerPage = internalQuery({
  args: {
    doc: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, { doc, cursor, numItems }) => {
    const page = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc", (q) => q.eq("doc", doc))
      .paginate({ cursor: cursor ?? null, numItems: Math.min(numItems ?? 500, 1000) });
    const rows: Record<string, any>[] = [];
    let unreadable = 0;
    for (const r of page.page) {
      if (r.collection !== "transactions") continue;
      const p = payloadOf(r.payload);
      if (!p) { unreadable++; continue; }
      rows.push(compactRow(p));
    }
    return { doc, rows, unreadable, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/**
 * Every reversal's recorded `counterDelta`, by the reversal row's own id.
 *
 * This is the authoritative statement of which counter a reversal un-counted.
 * `capped` is returned rather than swallowed: a derivation missing a reversal
 * would bucket it by sign and inflate `deducted`.
 */
export const reversalDeltas = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const take = Math.min(limit ?? 2000, 4000);
    const rows = await ctx.db.query("cashReversals").take(take);
    const byTxnId: Record<string, any> = {};
    for (const r of rows as any[]) {
      const id = String(r.reversalTxnId ?? "");
      if (!id) continue;
      byTxnId[id] = r.counterDelta ?? null;
    }
    return { byTxnId, count: rows.length, capped: rows.length === take };
  },
});

/** The student this ledger id belongs to, by the same key toAppStudent uses. */
async function findStudent(ctx: any, studentId: string) {
  const byLegacy = await ctx.db
    .query("students")
    .withIndex("by_legacyId", (q: any) => q.eq("legacyId", studentId))
    .first();
  if (byLegacy) return byLegacy;
  return await ctx.db
    .query("students")
    .withIndex("by_studentNumber", (q: any) => q.eq("studentNumber", studentId))
    .first();
}

/**
 * The latest reset row EXACTLY as deriveCounters reads one (behaviorId
 * "system_reset", no prefix match), or -Infinity; Infinity if one is undated.
 * Kept identical so the doubtful hold and the derivation agree on which rows
 * a reset wipes (fourth re-review, 2026-10-01).
 */
function derivationResetMs(rows: any[]): number {
  let best = -Infinity;
  for (const r of rows || []) {
    if (String(r && r.behaviorId ? r.behaviorId : "") !== "system_reset") continue;
    const t = Date.parse(String(r && r.timestamp ? r.timestamp : ""));
    if (!Number.isFinite(t)) return Infinity;
    if (t > best) best = t;
  }
  return best;
}

/**
 * Recount one slice of students. DRY RUN unless `apply` is true.
 *
 * Idempotent by construction: it writes a value derived from history, so a
 * second run over an already-repaired student finds nothing to change and
 * reports "already correct".
 */
export const recountStudents = internalMutation({
  args: {
    students: v.array(v.object({
      studentId: v.string(),
      rows: v.array(v.any()),
    })),
    reversalDeltas: v.optional(v.any()),
    apply: v.optional(v.boolean()),
    includeDecreases: v.optional(v.boolean()),
    maxChange: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const deltas = (args.reversalDeltas || {}) as Record<string, any>;
    const apply = args.apply === true;
    const out: any[] = [];
    let repaired = 0;
    let heldBack = 0;
    let alreadyCorrect = 0;
    let notFound = 0;
    let balanceMoved = 0;

    for (const entry of args.students) {
      const student = await findStudent(ctx, entry.studentId);
      if (!student) {
        notFound++;
        out.push({ studentId: entry.studentId, action: "not found", why: "no student record matches this ledger id" });
        continue;
      }
      const name = `${(student as any).firstName ?? ""} ${(student as any).lastName ?? ""}`.trim();

      // A LOST AWARD AN ADMIN DISMISSED is not counted (second review,
      // 2026-09-30): "do not give this back" has to survive the recount, or
      // the next morning's repair pays exactly what a person decided not to.
      // Left out of BOTH witnesses so they still agree, and reported.
      //
      // Only a row the app COULD check is ever dismissed: one it cannot check
      // stays open and is this recount's to settle (final re-review,
      // 2026-10-01), counted against the ledger like any other row.
      const dismissed = new Set((await ctx.db.query("cashArrivalAlerts")
        .withIndex("by_student_status", (q: any) => q.eq("studentId", entry.studentId).eq("status", "dismissed"))
        .take(200)).map((a: any) => a.txnId));
      const keep = (r: any) => !dismissed.has(String(r?.id ?? ""));
      const ledgerRows = dismissed.size ? entry.rows.filter(keep) : entry.rows;

      // WITNESS 1: the weekly ledger, as the driver read it.
      const fromLedger = deriveCounters(ledgerRows, deltas);
      // WITNESS 2: the student record's own copy of the same history.
      const cacheAll = Array.isArray((student as any).wildcatCashTransactions)
        ? (student as any).wildcatCashTransactions : [];
      const cache = dismissed.size ? cacheAll.filter(keep) : cacheAll;
      const fromCache = deriveCounters(cache, deltas);

      const disagree = ["wildcatCashBalance", "wildcatCashEarned", "wildcatCashSpent", "wildcatCashDeducted"]
        .filter((f) => Math.abs((fromLedger.counters[f] ?? 0) - (fromCache.counters[f] ?? 0)) >= 0.005);
      if (disagree.length) {
        heldBack++;
        out.push({
          studentId: entry.studentId, name, action: "held back",
          why: "the ledger and this student's own history cache disagree on " + disagree.join(", "),
          ledger: fromLedger.counters, cache: fromCache.counters,
          ledgerRows: entry.rows.length, cacheRows: cache.length,
        });
        continue;
      }

      const verdict = recountVerdict(student as any, fromLedger.counters, {
        includeDecreases: args.includeDecreases === true,
        maxChange: args.maxChange,
      });

      // AWARDS WAITING FOR AN ADMIN'S "GIVE BACK" THAT THIS COUNT INCLUDES
      // (review finding, 2026-09-30). Once the counters equal the ledger, a
      // lost award whose row is in that ledger is paid -- by this recount, or
      // it already was. Its open alert is settled and its id REGISTERED, in
      // the same patch, so neither Give back nor a late save can pay it again.
      // (The recount never registered what it paid before; for these rows it
      // now does.)
      const rowIds = new Set(ledgerRows.map((r: any) => String(r?.id ?? "")));
      const waiting = (await ctx.db.query("cashArrivalAlerts")
        .withIndex("by_student_status", (q: any) => q.eq("studentId", entry.studentId).eq("status", "open"))
        .take(200)).filter((a: any) => rowIds.has(a.txnId));
      const settleWaiting = async () => {
        if (!apply || !waiting.length) return;
        const at = new Date().toISOString();
        for (const a of waiting) {
          await ctx.db.patch(a._id, { status: "settled", resolvedAt: at, resolvedBy: "recount", resolution: "counted by the recount" });
        }
      };
      const registerWaiting = (cur: any) => ringPush(cur ?? null, waiting.map((a: any) => ({ id: a.txnId, at: a.at, amount: a.amount, kind: a.kind })));
      // A WAITING AWARD THAT MAY HAVE BEEN GIVEN AGAIN IS A PERSON'S CALL
      // (final review, 2026-10-01). If a similar award was given later, paying
      // this one could pay the child twice. So the recount holds the child
      // back rather than paying and settling it out of sight, and names the
      // alerts; cashArrival:resolveForRecount records the person's decision.
      //
      // Re-reviews, same day:
      //   - a DISMISSED row is not a re-entry (it was never paid), so the
      //     candidates come from the copies with dismissed rows left out;
      //   - a row at or before the latest RESET ROW holds nothing: the
      //     derivation starts again at the reset, so it cannot change this
      //     count (an undated reset reads as Infinity and exempts nothing; an
      //     unreadable time is never exempt);
      //   - a row dated within the slack AFTER a reset may really be from
      //     before it (a fast clock), which is why the panel calls it
      //     "before a cash reset": a person decides, never this count;
      //   - a person's "count" is honoured only while nothing similar is
      //     dated after that decision: a re-entry made since is new doubt.
      const resetMs = Math.max(derivationResetMs(cacheAll), derivationResetMs(entry.rows));
      const candidatesOf = (a: any) => laterCandidates([...cache, ...ledgerRows], a.row ?? {});
      const doubtful = waiting.filter((a: any) => {
        const at = Date.parse(a.at);
        if (resetMs !== Infinity && at <= resetMs) return false;
        const decided = a.recountDecision && a.recountDecision.decision === "count"
          ? Date.parse(String(a.recountDecision.at ?? "")) : NaN;
        if (Number.isFinite(decided)) return candidatesOf(a).some((c: any) => !(Date.parse(c.at) <= decided));
        if (Number.isFinite(resetMs) && !(at > resetMs + ZERO_POINT_SLACK_MS)) return true;
        return candidatesOf(a).length > 0;
      });

      if (verdict.action === "already correct") {
        alreadyCorrect++;
        if (apply && waiting.length) {
          await ctx.db.patch((student as any)._id, { cashApplied: registerWaiting((student as any).cashApplied) });
          await settleWaiting();
        }
        // The excluded rows travel even here. A student whose counters happen
        // to be right can still have a row the derivation refused to count --
        // Nadia Almendares-Castaneda is exactly that -- and reporting it only
        // on the paths that change something is how a $1,000 exclusion goes
        // unmentioned.
        out.push({
          studentId: entry.studentId, name, action: "already correct",
          ...(fromLedger.excluded.length ? { excluded: fromLedger.excluded } : {}),
        });
        continue;
      }
      if (doubtful.length) {
        heldBack++;
        out.push({
          studentId: entry.studentId, name, action: "held back",
          why: `${doubtful.length} lost award${doubtful.length === 1 ? " is" : "s are"} waiting for a person: a similar award was given later (possibly given again), or it is dated just after a cash reset (possibly from before it). Decide with cashArrival:resolveForRecount, "count" or "leave_out"`,
          alerts: doubtful.map((a: any) => ({ id: String(a._id), txnId: a.txnId, amount: a.amount, at: a.at })),
          changes: verdict.changes,
        });
        continue;
      }
      if (verdict.action === "held back") {
        heldBack++;
        out.push({
          studentId: entry.studentId, name, action: "held back", why: verdict.why,
          changes: verdict.changes, excluded: fromLedger.excluded,
        });
        continue;
      }

      if (apply) {
        await ctx.db.patch((student as any)._id, waiting.length
          ? { ...verdict.patch, cashApplied: registerWaiting((student as any).cashApplied) }
          : verdict.patch);
        await settleWaiting();
      }
      repaired++;
      verdict.changes.forEach((c: any) => {
        if (c.field === "wildcatCashBalance") balanceMoved += c.delta;
      });
      out.push({
        studentId: entry.studentId, name,
        action: apply ? "repaired" : "would repair",
        changes: verdict.changes,
        excluded: fromLedger.excluded,
        rows: entry.rows.length,
      });
    }

    return {
      applied: apply,
      seen: args.students.length,
      repaired, heldBack, alreadyCorrect, notFound,
      balanceMoved,
      details: out,
      note: apply ? "Written." : "Dry run. Nothing was written. Pass apply: true.",
    };
  },
});

/**
 * WHEN did the movements that never reached a counter happen?
 *
 * Timing is what cracked this the last two times. On 2026-09-20 the seven
 * double-applied students were EXACTLY the seven in one teacher's 17:35:57
 * save batch, which proved it was one save applied twice rather than seven
 * independent faults -- and told us an attempt-id fix would not work, because
 * a retry recomputes the payload. A per-student total cannot say any of that;
 * only the timestamps can.
 *
 * Takes the student ids the recount flagged and returns their cash rows with
 * timestamps, amounts and the behaviour that caused them. NO NAMES: the caller
 * already has them and this is a diagnostic, not a roster.
 *
 * THE CAP IS SAID OUT LOUD (2026-10-05). It reads at most 4,000 rows of the
 * week, and used to stop there in silence -- so past 4,000 rows a week the
 * rows it did not reach were simply absent, and "no rows for this student" was
 * indistinguishable from "did not look". Now a cut-off read returns
 * `truncated: true` and a `warning`: what it returns is only part of the week,
 * and an absence in it proves nothing. Unchanged when the week fits.
 */
const ROWS_FOR_STUDENTS_CAP = 4000;

export const rowsForStudents = internalQuery({
  args: { studentIds: v.array(v.string()), doc: v.string() },
  handler: async (ctx, { studentIds, doc }) => {
    const want = new Set(studentIds.map((s) => String(s)));
    const read = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc", (q) => q.eq("doc", doc))
      .take(ROWS_FOR_STUDENTS_CAP + 1);
    const truncated = read.length > ROWS_FOR_STUDENTS_CAP;
    const slices = truncated ? read.slice(0, ROWS_FOR_STUDENTS_CAP) : read;
    const out: Array<Record<string, any>> = [];
    for (const r of slices) {
      if (r.collection !== "transactions") continue;
      const p: any = r.payload;
      // ONE TRANSACTION PER MIRROR ROW is the shape here, not an array of
      // them. Treating the payload as a container turned its own FIELDS into
      // candidate transactions, which matched nothing and returned a confident
      // empty answer -- the most expensive kind of wrong.
      const list: any[] = Array.isArray(p)
        ? p
        : (p && typeof p === "object"
            ? (p.studentId !== undefined || p.amount !== undefined ? [p] : Object.values(p))
            : []);
      for (const t of list as any[]) {
        if (!t || typeof t !== "object") continue;
        const sid = String((t as any).studentId ?? "");
        if (!want.has(sid)) continue;
        out.push({
          studentId: sid,
          at: String((t as any).timestamp ?? ""),
          amount: Number((t as any).amount),
          kind: String((t as any).kind ?? ""),
          behaviorId: String((t as any).behaviorId ?? ""),
          by: String((t as any).teacherName ?? (t as any).by ?? ""),
          // WHAT THE TEACHER TYPED. A deduction that reduces a child's balance
          // should not be applied on the strength of a row's existence alone;
          // the note is what says a person did it on purpose.
          notes: String((t as any).notes ?? ""),
          id: String((t as any).id ?? ""),
          balanceAfter: (t as any).balanceAfter ?? null,
        });
      }
    }
    out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    if (truncated) {
      return {
        rows: out, slicesRead: slices.length,
        truncated: true,
        warning: `${doc} holds more than ${ROWS_FOR_STUDENTS_CAP} rows and only the first ` +
          `${ROWS_FOR_STUDENTS_CAP} were read. These rows are PART of the week: a student or a ` +
          `movement missing from them may still be in the ledger. Do not conclude anything from an absence.`,
      };
    }
    return { rows: out, slicesRead: slices.length };
  },
});

/**
 * DID THE SERVER THINK IT HAD ALREADY APPLIED THE MOVEMENT THAT IS MISSING?
 *
 * This is the question that separates the two possible causes, and nothing
 * else does. `cashApplied` on the students row is the register the
 * movement-keyed delta logic writes when it moves a counter: ids plus a
 * monotone `since` watermark.
 *
 *   If the missing movement's id IS in cashApplied, the server registered it
 *   as applied and the counter still did not move -- a server-side fault, and
 *   the movement is lost permanently because every later save will absorb it.
 *
 *   If it is NOT in cashApplied and its timestamp is at or before `since`, the
 *   watermark swallowed it: the ring holds 24 ids and once one is evicted the
 *   watermark advances past it, so a movement that arrives late looks like a
 *   retry of something already done.
 *
 *   If it is NOT in cashApplied and is AFTER `since`, the server never saw it
 *   -- the ledger write landed and the counter write did not, which is the
 *   two-mutation split doing exactly what it structurally can.
 *
 * Reports the verdict per student. Counters and ids only.
 */
export const appliedRegisterFor = internalQuery({
  args: { studentNumbers: v.array(v.string()) },
  handler: async (ctx, { studentNumbers }) => {
    const want = new Set(studentNumbers.map((s) => String(s)));
    const all = await ctx.db.query("students").take(2000);
    const out: Array<Record<string, any>> = [];
    for (const s of all) {
      const num = String((s as any).studentNumber ?? (s as any).legacyId ?? "");
      if (!want.has(num)) continue;
      const applied: any = (s as any).cashApplied ?? null;
      const ids: any[] = applied && Array.isArray(applied.ids) ? applied.ids : [];
      out.push({
        studentNumber: num,
        balance: (s as any).wildcatCashBalance ?? null,
        earned: (s as any).wildcatCashEarned ?? null,
        deducted: (s as any).wildcatCashDeducted ?? null,
        hasRegister: Boolean(applied),
        registeredCount: ids.length,
        since: applied ? applied.since ?? null : null,
        newestRegistered: ids.length
          ? ids.map((x) => Number(x?.at ?? 0)).sort((a, b) => b - a)[0]
          : null,
        registeredIds: ids.map((x) => String(x?.i ?? "")).filter(Boolean),
        // Registered on purpose with NO money moved: an admin dismissed them
        // (2026-10-01). Not a server fault, though they look like one here.
        dismissedIds: (await ctx.db.query("cashArrivalAlerts")
          .withIndex("by_student_status", (q: any) => q.eq("studentId", num).eq("status", "dismissed"))
          .take(200)).map((a: any) => a.txnId),
      });
    }
    return { rows: out, studentsRead: all.length };
  },
});
