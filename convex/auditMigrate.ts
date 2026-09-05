"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Move the audit log out of legacyMirror documents and into appAuditLog.
 *
 * SAFE TO RUN TWICE. importEntries dedupes on entryId, so a second run inserts
 * nothing. That matters because the first run may fail partway through.
 *
 * IT DOES NOT DELETE ANYTHING. The legacyMirror rows stay exactly where they
 * are, and the app reads BOTH and unions them by entryId until somebody decides
 * the table has been verified. A migration that destroys its own input has no
 * way back if the destination turns out wrong -- and this is the record that
 * answers a parent asking why their child was deducted.
 *
 *   npx convex run --prod auditMigrate:run '{}'                # dry run
 *   npx convex run --prod auditMigrate:run '{"write": true}'   # import
 *
 * internal, so it needs the CLI's credentials and no browser can reach it.
 */

/** ensureEntryId from script.js, character for character. Do not "improve" it. */
function ensureEntryId(entry: any): string {
  if (entry && entry.entryId && typeof entry.entryId === "string") return entry.entryId;
  const parts = [
    entry.timestamp || "", entry.studentId || "", entry.teacher || "",
    entry.category || "", entry.action || "",
    String(entry.tickets || entry.amount || entry.ticketCount || ""),
    entry.reason || "",
  ].join("|");
  let h = 0;
  for (let i = 0; i < parts.length; i++) {
    h = ((h << 5) - h) + parts.charCodeAt(i);
    h |= 0;
  }
  return "e_" + Math.abs(h).toString(36);
}

export const run = internalAction({
  args: { write: v.optional(v.boolean()) },
  handler: async (ctx, { write }) => {
    const doWrite = write === true;

    let cursor: string | null = null;
    let collected = 0, inserted = 0, already = 0, skipped = 0;
    const seen = new Set<string>();
    const payloadById = new Map<string, any>();
    let redundantCopies = 0;
    const realCollisions: Array<any> = [];
    const collisions: Array<{ id: string; timestamp: string; teacher: string }> = [];
    let batch: Array<{ entryId: string; timestamp: string; payload: any }> = [];

    const flush = async () => {
      if (!batch.length) return;
      if (doWrite) {
        const res: any = await ctx.runMutation(
          internal.auditLog.importEntries, { entries: batch });
        inserted += res.inserted; already += res.alreadyStored; skipped += res.skipped;
      }
      batch = [];
    };

    for (let guard = 0; guard < 3000; guard++) {
      const page: any = await ctx.runQuery(
        internal.auditMigrateRead.legacyAuditPage, { cursor, numItems: 300 });

      for (const row of page.rows) {
        const e = row.payload;
        if (!e || typeof e !== "object") { skipped++; continue; }
        const id = ensureEntryId(e);

        // A content hash is only 32 bits. Two DIFFERENT entries landing on one
        // id means the second is dropped as a duplicate -- the silent loss this
        // move exists to end. Reported rather than hidden: the OLD storage
        // collapsed these too, so the move reveals the problem, it does not
        // create it.
        if (seen.has(id)) {
          // IS THIS THE SAME ENTRY TWICE, OR TWO DIFFERENT ONES?
          //
          // The distinction is everything. The same entry stored in two
          // documents is harmless redundancy -- the app has always unioned by
          // entryId, so it only ever showed one. Two DIFFERENT entries sharing
          // a 32-bit hash is a record that was silently dropped.
          const firstSeen = payloadById.get(id);
          const sameEntry = JSON.stringify(firstSeen) === JSON.stringify(e);
          if (sameEntry) {
            redundantCopies++;
          } else {
            realCollisions.push({
              id,
              a: { timestamp: String(firstSeen?.timestamp || ""), teacher: String(firstSeen?.teacher || ""),
                   student: String(firstSeen?.studentName || ""), reason: String(firstSeen?.reason || "") },
              b: { timestamp: String(e.timestamp || ""), teacher: String(e.teacher || ""),
                   student: String(e.studentName || ""), reason: String(e.reason || "") },
            });
          }
          continue;
        }
        seen.add(id);
        payloadById.set(id, e);
        collected++;
        batch.push({ entryId: id, timestamp: String(e.timestamp || ""), payload: e });
        if (batch.length >= 200) await flush();
      }

      if (page.isDone) break;
      cursor = page.cursor;
    }
    await flush();

    return {
      mode: doWrite ? "IMPORTED" : "DRY RUN (nothing written)",
      legacyEntriesFound: collected,
      duplicateIdsSeen: collisions.length,
      // The two are NOT the same thing. See the comment at the check.
      redundantCopiesOfTheSameEntry: redundantCopies,
      REAL_COLLISIONS_DIFFERENT_ENTRIES: realCollisions.length,
      firstRealCollisions: realCollisions.slice(0, 5),
      inserted, alreadyInTable: already, skipped,
      firstCollisions: collisions.slice(0, 10),
    };
  },
});
