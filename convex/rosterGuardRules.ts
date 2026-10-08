/**
 * THE EMPTY-CLEAR GUARD: may this sync replace the roster it found?
 *
 * WHY IT EXISTS (build spec 4.5, 2026-10-08). The PowerSchool sync replaces
 * psRoster wholesale: it deletes every row, then writes what the roster query
 * returned. That is right when the query is right -- a student who drops a
 * class must disappear -- and catastrophic when it is not. A query that comes
 * back EMPTY (a term id that no longer matches anything after the semester
 * change, a plugin re-install, a PowerSchool answer of zero rows) would empty
 * every teacher's class list, every student's schedule, and the Reflection
 * Room's Power-Up column, and the next sync would do it again.
 *
 * So the sync keeps the roster it has when the new read is empty, or holds
 * fewer than half as many rows as the roster now in place. Half, because a
 * real change never moves that much in one day: the semester change itself
 * replaces sections, not students. The run says so in syncRuns (`rosterKept`
 * and the reason), so a kept roster is a visible event, never a silent one.
 *
 * PURE, so the decision is tested with no database and no PowerSchool.
 */

/** Below this share of the current roster's rows, a new read is not believed. */
export const ROSTER_KEEP_BELOW = 0.5;

export function rosterReplaceVerdict(input: { incomingRows: number; currentRows: number }):
  { replace: true } | { replace: false; reason: string } {
  const incoming = Math.max(0, Math.floor(Number(input.incomingRows) || 0));
  const current = Math.max(0, Math.floor(Number(input.currentRows) || 0));
  if (incoming === 0) {
    return {
      replace: false,
      reason: current > 0
        ? `PowerSchool's roster came back empty, so the ${current} roster rows already here were kept.`
        : "PowerSchool's roster came back empty.",
    };
  }
  if (current > 0 && incoming < ROSTER_KEEP_BELOW * current) {
    return {
      replace: false,
      reason: `PowerSchool's roster came back with ${incoming} rows against ${current} here now `
        + `(under half), so the roster already here was kept.`,
    };
  }
  return { replace: true };
}
