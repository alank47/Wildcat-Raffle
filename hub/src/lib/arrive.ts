import { useEffect, useRef } from "react";

/**
 * WHICH NUMBERS ARE ALLOWED TO COUNT.
 *
 * The rule is: a number counts up when it ARRIVES, and never again.
 *
 * That is not what a mount-triggered count-up does. Every count-up in this app
 * — CountUp, Counter, the grade bar — starts when its element mounts, and an
 * element mounts far more often than a value arrives:
 *
 *   - navigating away and back re-mounts the whole route (the route frame is
 *     keyed on the path, deliberately, so the entrance replays);
 *   - `refresh()` after a hall-pass mutation re-runs all four queries and
 *     re-renders every panel;
 *   - React 19 StrictMode mounts everything twice in development.
 *
 * So a student who taps Cards, Grades, Cards has watched their balance roll up
 * from zero three times, and the motion has stopped meaning "this is fresh from
 * the server" — which was the only reason it was there. Worse, on the balance
 * card the roll starts at $0, so a wallet that says nothing-then-money is
 * something a student sees several times an hour.
 *
 * This module remembers, for the life of the page, the last value each named
 * figure was seen holding. `useArrival` returns true only when the value in
 * hand differs from that — i.e. the server actually told us something new.
 *
 * IT IS DELIBERATELY NOT PERSISTED. sessionStorage would mean the first paint
 * of a fresh tab has no entrance at all, and the first paint is the one time
 * the count is doing its job.
 */

const seen = new Map<string, number>();

/**
 * Shared Chromebook. The next student's figures are new figures, so the record
 * of what was on screen has to go when the session does — otherwise the second
 * student of the morning gets a wallet that never moves.
 */
export function resetArrivals(): void {
  seen.clear();
}

/**
 * @param key   a stable name for this figure, unique across the app. Two
 *              components sharing a key would silence each other.
 * @param value the number in hand, or null when the server has not sent it.
 * @returns     true if this value is new and should be animated in.
 */
export function useArrival(key: string, value: number | null): boolean {
  /**
   * Decided once per (key, value) pair and then held. It must NOT be
   * recomputed on every render: the moment the effect below records the value,
   * a plain read would flip the answer to false and cut a count-up off
   * mid-roll.
   */
  const decision = useRef<{ key: string; value: number | null; animate: boolean } | null>(
    null,
  );

  if (
    decision.current === null ||
    decision.current.key !== key ||
    decision.current.value !== value
  ) {
    decision.current = {
      key,
      value,
      // A missing value never animates: there is nothing to count to, and
      // "Not on file" is a sentence, not a figure.
      animate: value !== null && seen.get(key) !== value,
    };
  }

  useEffect(() => {
    if (value === null) seen.delete(key);
    else seen.set(key, value);
  }, [key, value]);

  return decision.current.animate;
}
