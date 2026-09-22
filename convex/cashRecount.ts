import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { deriveCounters, recountVerdict } from "./cashRecountRules";

/**
 * Putting the four cash counters back in agreement with the ledger.
 *
 * WHY THIS IS PAGED, and not one call. The cash ledger held 2,066 rows on
 * 2026-09-17 and grows by roughly 450 a school day; the students table holds
 * 763. A single execution that read both would be at 2,829 of Convex's 4,096
 * document reads today and over the limit within the week -- and a repair that
 * works this afternoon and fails silently next Tuesday is worse than no
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

      // WITNESS 1: the weekly ledger, as the driver read it.
      const fromLedger = deriveCounters(entry.rows, deltas);
      // WITNESS 2: the student record's own copy of the same history.
      const cache = Array.isArray((student as any).wildcatCashTransactions)
        ? (student as any).wildcatCashTransactions : [];
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

      if (verdict.action === "already correct") {
        alreadyCorrect++;
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
      if (verdict.action === "held back") {
        heldBack++;
        out.push({
          studentId: entry.studentId, name, action: "held back", why: verdict.why,
          changes: verdict.changes, excluded: fromLedger.excluded,
        });
        continue;
      }

      if (apply) await ctx.db.patch((student as any)._id, verdict.patch);
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
 */
export const rowsForStudents = internalQuery({
  args: { studentIds: v.array(v.string()), doc: v.string() },
  handler: async (ctx, { studentIds, doc }) => {
    const want = new Set(studentIds.map((s) => String(s)));
    const slices = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc", (q) => q.eq("doc", doc))
      .take(4000);
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
          id: String((t as any).id ?? ""),
          balanceAfter: (t as any).balanceAfter ?? null,
        });
      }
    }
    out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
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
      });
    }
    return { rows: out, studentsRead: all.length };
  },
});
