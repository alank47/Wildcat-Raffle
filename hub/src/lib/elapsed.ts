import * as React from "react";

/* ============================================================
   How long a student has been out, as a clock.

   The server sends elapsed minutes as a float, which is right
   for arithmetic and wrong for a person: "0.22198333333333334
   min" is not a length of time anybody reads. And a number
   computed on the server is frozen the moment it arrives, so
   the screen sat there until someone pulled to refresh.

   Both are fixed the same way: take the approval timestamp,
   which the pass already carries, and count from it locally.
   ============================================================ */

/** `M:SS`, or `H:MM:SS` once an hour has gone by. */
export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** The same span in words, for a sentence rather than a readout. */
export function formatSpokenDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  if (safe < 60) return `${safe} second${safe === 1 ? "" : "s"}`;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  const head = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return seconds === 0 ? head : `${head} ${seconds}s`;
}

/**
 * Seconds since a timestamp, recomputed every second.
 *
 * Ticks locally rather than waiting on the server, because a pass that only
 * moves when you pull to refresh is not a timer. The server stays the
 * authority on whether the pass is open and whether it is overdue; this only
 * answers "how long has it been", which the clock on the device can do.
 *
 * Returns null when there is nothing to count from - a request that has not
 * been approved has no start - so callers can tell "not started" from "zero
 * seconds", which are different things.
 */
export function useElapsedSeconds(
  startedAt: string | null | undefined,
  /*
   * The server's frozen figure, used only to work out where to start counting
   * from when no timestamp came back. An older server, or a payload that never
   * carried the approval time, would otherwise leave this showing a dash -
   * which is worse than the wrong-looking number it replaced.
   */
  fallbackMinutes?: number | null,
): number | null {
  const startMs = React.useMemo(() => {
    if (startedAt) {
      const parsed = Date.parse(startedAt);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (typeof fallbackMinutes === "number" && Number.isFinite(fallbackMinutes)) {
      return Date.now() - fallbackMinutes * 60_000;
    }
    return null;
    // Deliberately not re-deriving on every fallback change: that number moves
    // on each poll, and re-basing the clock to it would make the seconds jump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt]);

  const [seconds, setSeconds] = React.useState<number | null>(() =>
    startMs === null ? null : Math.max(0, Math.floor((Date.now() - startMs) / 1000)),
  );

  React.useEffect(() => {
    if (startMs === null) {
      setSeconds(null);
      return;
    }
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - startMs) / 1000)));
    tick();

    /*
     * Align to the wall clock so the display changes ON the second rather
     * than a drifting fraction after it, and re-sync when the tab wakes:
     * a phone that slept for ten minutes must not resume counting from
     * where it dozed off.
     */
    let interval: number | undefined;
    const start = () => {
      window.clearInterval(interval);
      interval = window.setInterval(tick, 1000);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        tick();
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [startMs]);

  return seconds;
}
