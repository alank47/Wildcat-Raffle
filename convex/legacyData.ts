import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff } from "./identity";
import { notifyNewReferrals } from "./referralMail";

/**
 * The app-facing half of the legacy mirror.
 *
 * WHY THIS FILE EXISTS. The 2026-08-11 migration copied every remaining
 * Firestore document into `legacyMirror` — 10,456 rows, reconciled to the
 * unit — and then stopped. The only functions that could reach that table
 * were `mirror:putSlice` and friends, which are internalMutations and need
 * the deploy key, so the data was in Convex and the browser could not read a
 * byte of it. That is the whole reason the app still talked to Firestore for
 * ticket history, the audit log, referrals, schedules and `secondary`: not a
 * missing table, a missing function.
 *
 * WHY IT MIRRORS THE DOCUMENT SHAPE INSTEAD OF MODELLING IT. `load` rebuilds
 * the exact object each Firestore document used to hand back, so the merge
 * logic in loadData — the entryId dedupe across six ticket-history partitions,
 * the monthly-plus-legacy audit merge — is untouched. A cutover that changes
 * the transport AND the shape at the same time cannot tell a transport bug
 * from a shape bug, and this data is student ticket history and an audit log:
 * the failure mode is silent double-counting, not an exception.
 *
 * Modelling these into real tables (`ticketHistory` and `auditLog` already
 * exist and are empty) is the NEXT job, and it is safe to do once this one is
 * proven, because by then Firestore is no longer the thing being compared to.
 *
 * THE INVERSE OF mirror-refresh.mjs. That script writes one row per array
 * element, with `key` set when the source was a map rather than a list. So a
 * slice whose rows carry a key rebuilds as an object, and one whose rows do
 * not rebuilds as an array. Getting this backwards turns a histories map into
 * a list and every student's history disappears without an error.
 */

/**
 * WHERE `load` WENT.
 *
 * There was a `load` query here that rebuilt EVERY mirrored document in one
 * call, with `.collect()` over the whole legacyMirror table. It exceeded
 * Convex's read limit in production on or before 2026-09-04:
 *
 *   Uncaught Error: Too many bytes read in a single function execution
 *   (limit: 16777216 bytes)
 *
 * That table is every student's ticket history and every week of the audit
 * log, so it only grows and the query was never coming back. While it failed,
 * every load in the app fell through to its localStorage copy without
 * surfacing anything, because the fallback is not an error path -- a machine
 * that had never run the app showed no schedules, no referrals, no cash and no
 * audit log for the whole session, silently.
 *
 * `loadDoc` below is the replacement, called once per document by
 * loadLegacyDocsFromConvex in script.js. It reads through the by_doc index, so
 * an execution is bounded by ONE document rather than by the whole school's
 * history, and no chunk size has to be tuned against a table that grows every
 * week. Do not reintroduce a whole-table read here.
 */

/**
 * One document, for the read-modify-write paths.
 *
 * The ticket and audit correction screens rewrite a single entry inside a
 * single document. Handing them the whole mirror to do it would pull every
 * ticket in the school across the wire so one row can change, on a screen an
 * admin uses several times a day.
 *
 * Returns null rather than {} when the document has no rows, because the
 * callers branch on existence: "this document is empty" and "this document is
 * not there" lead to different code, and collapsing them writes a fresh
 * document over a missing one without anybody deciding to.
 */
export const loadDoc = query({
  args: { doc: v.string() },
  handler: async (ctx, { doc }) => {
    await requireStaff(ctx);

    const rows = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc", (q) => q.eq("doc", doc))
      .collect();
    if (rows.length === 0) return null;

    const collections: Record<string, Array<{ key?: string; payload: unknown }>> = {};
    for (const r of rows) (collections[r.collection] ??= []).push({ key: r.key, payload: r.payload });

    const out: Record<string, unknown> = {};
    for (const [collection, slice] of Object.entries(collections)) {
      const keyed = slice.some((r) => typeof r.key === "string");
      if (keyed) {
        const map: Record<string, unknown> = {};
        for (const r of slice) if (typeof r.key === "string") map[r.key] = r.payload;
        out[collection] = map;
      } else {
        out[collection] = slice.map((r) => r.payload);
      }
    }
    return out;
  },
});

/**
 * Replace one (doc, collection) slice.
 *
 * Replace, not append, for the same reason `mirror:putSlice` replaces: the app
 * saves whole arrays, and appending would double every entry on every save.
 * The caller sends the array (or map) it wants the slice to BE.
 *
 * `rows` is capped because these are the two documents that outgrew Firestore
 * in the first place. A save larger than this is a bug in the caller — the
 * whole audit log being re-sent as one slice, say — and failing loudly here is
 * better than writing a million rows and finding out on the bill.
 */
const MAX_ROWS_PER_SLICE = 20000;

/**
 * Union an incoming slice into the stored one, inside a single transaction.
 *
 * WHAT THIS REPLACES, AND WHY IT IS NOT `saveSlice`. Four Firestore
 * `runTransaction` blocks did read-modify-write on referrals, ticket history,
 * the audit months and `secondary`. Firestore retried them on conflict, and
 * that retry is the only reason two teachers saving at the same moment did not
 * erase each other. Rewriting them as a client-side read followed by
 * `saveSlice` would look identical and quietly drop that guarantee: the tab
 * merges against what it fetched, so a write that lands in between is gone.
 *
 * A Convex mutation IS the transaction, so doing the merge in here restores
 * the property rather than approximating it. The handler reads the row it is
 * about to replace.
 *
 * UNION, NEVER REPLACE. Entries are deduped on `dedupeField` (entryId for
 * history and audit, id for referrals) and the STORED copy wins a collision,
 * because the incoming one comes from a tab that may have been open for hours.
 * An entry present on the server and absent locally is not a deletion — that is
 * what tombstones are for, and treating absence as intent is exactly how a
 * stale tab deletes another teacher's work.
 */
/**
 * When a row was last touched, as a number, from the same stamps the client's
 * wildcat-merge.js reads: the LATEST of updatedAt, loopClosedAt, closedAt and
 * submittedAt. Zero for a row with no usable stamp, so such rows never win a
 * collision and the stored-wins rule holds for them unchanged.
 */
function touchedAt(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const p = payload as Record<string, unknown>;
  let best = 0;
  for (const field of ["updatedAt", "loopClosedAt", "closedAt", "submittedAt"]) {
    const raw = p[field];
    const t = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best;
}

/**
 * Union incoming cash rows into what is stored, by transaction id. Stored rows
 * are never deleted; a row is inserted only if its id is not already there. A
 * row with no id cannot be compared and is kept rather than dropped.
 *
 * Pure, so it can be tested against the exact shape of the incident: a tab
 * that loaded the week an hour ago sending back its snapshot after a
 * colleague's award landed.
 */
export function unionCashRows(
  existing: Array<{ payload: unknown }>,
  rows: Array<{ key?: string; payload: unknown }>,
): Array<{ key?: string; payload: unknown }> {
  const idOf = (p: unknown) =>
    p && typeof p === "object" ? (p as Record<string, unknown>).id : undefined;
  const seen = new Set<string>();
  for (const r of existing) {
    const id = idOf(r.payload);
    if (id !== undefined && id !== null) seen.add(String(id));
  }
  const out: Array<{ key?: string; payload: unknown }> = [];
  for (const r of rows) {
    const id = idOf(r.payload);
    if (id !== undefined && id !== null) {
      const token = String(id);
      if (seen.has(token)) continue;
      seen.add(token);
    }
    out.push(r);
  }
  return out;
}

export const mergeSlice = mutation({
  args: {
    doc: v.string(),
    collection: v.string(),
    rows: v.array(v.object({ key: v.optional(v.string()), payload: v.any() })),
    dedupeField: v.string(),
  },
  handler: async (ctx, { doc, collection, rows, dedupeField }) => {
    // KEPT, NOT DISCARDED, and that one token is a security control.
    //
    // `payload` is v.any(), so every field on an incoming referral -- including
    // filedByEmail -- is chosen by whoever called this. The referral
    // confirmation email must never take a recipient from there: a teacher
    // could edit one value in devtools and post a colleague a named child's
    // discipline record. `me` is the account the token actually proves, and it
    // is the only thing notifyNewReferrals will mail.
    const me = await requireStaff(ctx);

    if (rows.length > MAX_ROWS_PER_SLICE) {
      throw new Error(
        `legacyData:mergeSlice refused ${rows.length} rows for ${doc}.${collection}; the cap is ${MAX_ROWS_PER_SLICE}.`,
      );
    }

    const existing = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc_collection", (q) =>
        q.eq("doc", doc).eq("collection", collection),
      )
      .collect();

    const idOf = (p: unknown) =>
      p && typeof p === "object" ? (p as Record<string, unknown>)[dedupeField] : undefined;

    // Keyed slices (histories, keyed by student) merge WITHIN a key; unkeyed
    // slices merge across the whole list. Mixing the two loses rows silently.
    const keyed = existing.some((r) => typeof r.key === "string")
      || rows.some((r) => typeof r.key === "string");

    // A ROW THAT SURVIVES IS LEFT WHERE IT IS.
    //
    // This used to delete every stored row and re-insert the merged set. The
    // result was correct and the cost was not: appending one audit entry to a
    // week that already held 1,278 rewrote all 1,279.
    //
    // Convex counts a delete as a READ, so that doubled the read budget: 2n
    // against a 4,096 limit, a ceiling of ~2,048 rows per document. The audit
    // log is partitioned weekly and takes one entry per student per cash award,
    // so a launch week with 34 teachers awarding whole classes would have
    // crossed it mid-week -- and the PBIS team reads that log to see who is
    // giving what. Ticket history had already crossed it and was failing on
    // every save.
    //
    // Keeping survivors in place makes an append cost n reads and as many
    // writes as there are genuinely new rows -- usually a handful, often none.
    //
    // The MERGE RULE IS UNCHANGED: stored still wins a collision, the same
    // tokens are compared in the same order, and the final set is identical
    // row for row. Only the number of database operations differs. Survivors
    // also keep their original `mirroredAt`, which nothing reads and which now
    // honestly means "when this row was written" rather than "when a save last
    // touched this slice".
    const seen = new Set<string>();
    const keptStored: typeof existing = [];
    const storedByToken = new Map<string, (typeof existing)[number]>();
    const toInsert: Array<{ key?: string; payload: unknown }> = [];
    // A stored row whose incoming copy was touched more recently. Added
    // 2026-09-09: "stored wins" was written for rows that never change once
    // written (audit entries, ticket history). Referrals DO change: closing
    // one, or closing its loop, sets updatedAt on the client and re-sends the
    // list through this merge, and stored-wins threw the edit away every
    // time while the tab logged "Referrals saved". Newer wins now, judged by
    // the same stamps the client uses (wildcat-merge.js lastTouched). Rows
    // without any stamp keep the old rule exactly.
    const toUpdate: Array<{ id: (typeof existing)[number]["_id"]; payload: unknown }> = [];
    let anonymous = 0;

    const tokenFor = (r: { key?: string; payload: unknown }) => {
      const id = idOf(r.payload);
      // A row with no dedupe value cannot be compared, so it is kept rather
      // than dropped. Losing an entry because it lacks an id is worse than
      // keeping a duplicate an admin can see and remove.
      return id === undefined || id === null
        ? `__nokey__${anonymous++}`
        : `${keyed ? r.key ?? "" : ""} ${String(id)}`;
    };

    for (const r of existing) {
      const token = tokenFor(r);
      if (seen.has(token)) continue;   // a duplicate ALREADY in storage
      seen.add(token);
      keptStored.push(r);
      storedByToken.set(token, r);
    }
    for (const r of rows) {
      const token = tokenFor(r);
      if (seen.has(token)) {
        // Stored wins, unless the incoming copy is the same row touched later.
        const stored = storedByToken.get(token);
        if (stored && touchedAt(r.payload) > touchedAt(stored.payload)) {
          toUpdate.push({ id: stored._id, payload: r.payload });
        }
        continue;
      }
      seen.add(token);
      toInsert.push(r);
    }

    // Only rows that did NOT survive the merge are touched.
    const survivors = new Set(keptStored.map((r) => r._id));
    let deleted = 0;
    for (const r of existing) {
      if (survivors.has(r._id)) continue;
      await ctx.db.delete(r._id);
      deleted++;
    }

    const mirroredAt = new Date().toISOString();
    for (const r of toInsert) {
      await ctx.db.insert("legacyMirror", {
        doc,
        collection,
        key: r.key,
        payload: r.payload,
        mirroredAt,
      });
    }
    for (const u of toUpdate) {
      await ctx.db.patch(u.id, { payload: u.payload, mirroredAt });
    }

    // EMAIL ON A NEW REFERRAL, AND ONLY HERE.
    //
    // toInsert is the only place in this system that knows a referral is NEW.
    // That is not a convenience, it IS the idempotency: the referrals slice is
    // re-sent whole on every save from every tab forever, and a referral
    // already stored matches by id above and lands in toUpdate, never here. A
    // trigger anywhere else would mail every referral on every save.
    //
    // It cannot throw -- a referral that saved must not be rolled back because
    // an email could not be scheduled.
    if (doc === "referrals" && collection === "behaviorReferrals" && toInsert.length) {
      await notifyNewReferrals(ctx, me, toInsert.map((r) => r.payload));
    }

    return {
      doc,
      collection,
      stored: keptStored.length + toInsert.length,
      incoming: rows.length,
      // So a caller can see that a re-send of unchanged data wrote nothing.
      inserted: toInsert.length,
      updated: toUpdate.length,
      deleted,
    };

  },
});

export const saveSlice = mutation({
  args: {
    doc: v.string(),
    collection: v.string(),
    rows: v.array(v.object({ key: v.optional(v.string()), payload: v.any() })),
  },
  handler: async (ctx, { doc, collection, rows }) => {
    await requireStaff(ctx);

    if (rows.length > MAX_ROWS_PER_SLICE) {
      throw new Error(
        `legacyData:saveSlice refused ${rows.length} rows for ${doc}.${collection}; the cap is ${MAX_ROWS_PER_SLICE}.`,
      );
    }

    const old = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc_collection", (q) =>
        q.eq("doc", doc).eq("collection", collection),
      )
      .collect();

    // THE CASH LEDGER IS NEVER REPLACED. Added 2026-09-09, launch morning.
    //
    // The app sends each cash_tx_<week> document as the whole array it holds
    // in memory, and this handler deleted every stored row before writing it.
    // Two teachers awarding cash in the same week from tabs loaded at
    // different times: whichever save landed second deleted the other's
    // award, because its snapshot had never seen it. That is the one write
    // path in the app where concurrency destroyed work rather than delaying
    // it, and forty teachers award in the same week every week.
    //
    // A cash movement is only ever added, never edited, and carries a unique
    // id, so the correct operation is a union by id. Done HERE, on the doc
    // name, so a tab still running the old client is protected the moment
    // this deploys; the client stops sending rows it knows are stored in the
    // same change.
    if (doc.startsWith("cash_tx_")) {
      const fresh = unionCashRows(old, rows);
      const mirroredAt = new Date().toISOString();
      for (const r of fresh) {
        await ctx.db.insert("legacyMirror", {
          doc,
          collection,
          key: r.key,
          payload: r.payload,
          mirroredAt,
        });
      }
      return { doc, collection, wrote: fresh.length, replaced: 0, unioned: true };
    }

    for (const r of old) await ctx.db.delete(r._id);

    const mirroredAt = new Date().toISOString();
    for (const r of rows) {
      await ctx.db.insert("legacyMirror", {
        doc,
        collection,
        key: r.key,
        payload: r.payload,
        mirroredAt,
      });
    }

    return { doc, collection, wrote: rows.length, replaced: old.length };
  },
});
