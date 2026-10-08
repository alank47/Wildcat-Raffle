"use node";
import { countRows, readWindow, sameList } from "./attendanceDays";

/**
 * THE REFLECTION ROOM'S POWERSCHOOL READ: one school day, CONFIRMED.
 *
 * WHY A COUNT IS NOT ENOUGH. Teachers are typing attendance while the list
 * is read. A teacher marking one child present and another absent mid-read
 * is a delete plus an insert: PowerSchool's count before and after both come
 * out right, the read keeps the deleted row, and the page shift skips a row
 * that existed the whole time. The attendance rebuild demonstrated exactly
 * this ("the run said ok and wrote both mistakes") and answered it for its
 * live piece by requiring a second read with the very same row ids
 * (attendanceDays.ts readPiece). This is that rule, for one day's query:
 *
 *   a read is STEADY when PowerSchool's count before it and after it both
 *   equal the rows it held, with no row served twice and no paging out;
 *
 *   the read is ACCEPTED only when two reads in a row are each steady AND
 *   hold the same sorted list of row ids.
 *
 * At most CONFIRM_MAX_READS reads per call. If none is accepted, the read
 * did not succeed: nothing is believed, and the next tick tries again. An
 * unconfirmed read must never make the list, clear a tardy, or turn an
 * arrival into a counted tardy -- that is the whole point of this file.
 *
 * It reuses the rebuild's own psGet / countRows / readWindow (exported for
 * this, unchanged), so the retries on 429 and 5xx, the per-request deadline,
 * the page-size cap and the "a row without an id stops the read" guard are
 * the proven ones, not a second copy.
 */

/** Reads per call, at most. Two is the minimum that can confirm anything. */
export const CONFIRM_MAX_READS = 4;

export type ConfirmedRead =
  | { ok: true; rows: Map<string, any>; ids: string[]; count: number; reads: number; pages: number; ms: number }
  | { ok: false; reason: string; reads: number; pages: number; ms: number };

/**
 * The attendance query for one school day, optionally one code only (the
 * T-only lookback reads). PowerSchool rejects OR clauses, so one code per
 * query. schoolid and yearid stay in every query, as in the rebuild.
 */
export function dayQuery(input: { schoolid: string; yearid: string; date: string; codeId?: string | null }): string {
  const q = [`schoolid==${input.schoolid}`, `yearid==${input.yearid}`, `att_date==${input.date}`];
  if (input.codeId) q.push(`attendance_codeid==${input.codeId}`);
  return q.join(";");
}

/**
 * Read `q` until two steady reads in a row agree on every row id.
 *
 * `expectDate`: every row must carry this att_date. A PowerSchool that
 * ignored the date filter would otherwise hand back another day's rows as
 * today's, and the count endpoint would not necessarily say so.
 */
export async function readConfirmed(
  host: string, tok: string, q: string, deadline: number,
  opts: { maxReads?: number; abort?: { stop: boolean }; expectDate?: string } = {},
): Promise<ConfirmedRead> {
  const maxReads = Math.max(2, opts.maxReads ?? CONFIRM_MAX_READS);
  const abort = opts.abort ?? { stop: false };
  let reads = 0, pages = 0, ms = 0;
  // The ids of the previous read -- kept only when that read was steady, so
  // a match always means two steady reads in a row.
  let previous: string[] | null = null;
  let why = "";
  try {
    for (let k = 0; k < maxReads; k++) {
      const before = await countRows(host, tok, "attendance", q, deadline);
      const r = await readWindow(host, tok, q, deadline, abort);
      const after = await countRows(host, tok, "attendance", q, deadline);
      reads++;
      pages += r.pages;
      ms += r.ms;
      if (opts.expectDate) {
        for (const row of r.rows.values()) {
          const d = String(row?.att_date ?? "").slice(0, 10);
          if (d !== opts.expectDate) {
            return { ok: false, reason: `PowerSchool did not apply the date filter: the read of ${opts.expectDate} `
              + `came back with a row dated "${d}". Nothing was taken from it.`, reads, pages, ms };
          }
        }
      }
      const ids = [...r.rows.keys()].sort();
      const steady = before === after && after === r.rows.size && r.duplicates === 0 && !r.pagedOut;
      if (steady && previous !== null && sameList(previous, ids)) {
        return { ok: true, rows: r.rows, ids, count: after, reads, pages, ms };
      }
      why = !steady
        ? `PowerSchool counted ${before} rows before a read and ${after} after it, and the read held ${r.rows.size}`
          + (r.duplicates ? ` (${r.duplicates} served twice)` : "") + (r.pagedOut ? " (paged out)" : "")
        : previous === null
          ? "only one steady read"
          : "two steady reads in a row held different rows";
      previous = steady ? ids : null;
    }
  } catch (e: any) {
    return { ok: false, reason: String(e?.message || e), reads, pages, ms };
  }
  return {
    ok: false,
    reason: `The read did not hold still in ${reads} reads (${why}): probably somebody is entering attendance `
      + `right now. Nothing was taken from it; the next read tries again.`,
    reads, pages, ms,
  };
}
