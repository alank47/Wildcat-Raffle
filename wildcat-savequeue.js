/**
 * Coalescing save queue.
 *
 * Pure. No DOM, no network, no clock, no globals: the clock, the timer and the
 * save itself are all injected. This is a data-durability boundary and it
 * deserves assertions rather than a read-through.
 *
 * THE PROBLEM.
 *
 * `saveData()` is called from 102 places and writes the whole `main` document
 * (713KB) inside a transaction. Firestore sustains roughly ONE write per second
 * to a single document. With five staff that is invisible. With fifty teachers
 * awarding tickets in the same assembly on launch day, `main` becomes a
 * contended hotspot: transactions retry, some fail, and saves stop sticking
 * under exactly the load you most want to survive.
 *
 * Coalescing is the fix that does not require moving any data: five awards in
 * ten seconds become one write instead of five.
 *
 * WHY THIS IS NOT A setTimeout DEBOUNCE.
 *
 * A three line debounce trades a contention bug for a data-loss bug. Each of
 * the following is a way the naive version silently loses a teacher's work, and
 * each is a named guarantee below:
 *
 *  1. STARVATION. A pure debounce resets its timer on every call, so a teacher
 *     awarding a ticket every two seconds for five minutes never triggers a
 *     save at all. There is a hard ceiling (`maxWaitMs`) after which a save
 *     happens regardless of how much is still arriving.
 *
 *  2. THE LOST UPDATE. A request that arrives while a save is already in
 *     flight is NOT covered by that save: its data was not in the snapshot the
 *     writer took. Swallowing it loses the change. The dirty flag is cleared
 *     when a save STARTS, not when it finishes, so anything arriving during
 *     flight re-arms it and schedules another pass.
 *
 *  3. THE LYING PROMISE. `saveInBackground` reports "persisted" to the user
 *     from the promise it gets back. A debounce that returns immediately makes
 *     that toast a lie. Every caller gets a promise that settles only when a
 *     save which ACTUALLY INCLUDED THEIR CHANGE has completed.
 *
 *  4. THE ABANDONED WRITE. If a coalesced save fails, the changes are still
 *     unsaved. Failure re-arms the dirty flag, so the work is retried rather
 *     than dropped on the floor, and the waiters are still told it failed so
 *     the existing warning toast fires.
 *
 *  5. THE CLOSED TAB. Deferring a write means there is a window where work
 *     exists only in memory. `flush()` exists for the page to call on
 *     visibilitychange and pagehide, and it is the reason those handlers are
 *     wired up in script.js rather than this being fire and forget.
 *
 *  6. THE OVERLAPPING WRITE. Two saves in flight at once against the same
 *     document is the contention this exists to prevent. Exactly one save runs
 *     at a time, always.
 *
 * BACKOFF. Repeated failure usually means contention or a network problem, and
 * retrying at the same cadence makes both worse. Consecutive failures widen the
 * window, capped, and a single success resets it.
 */
(function (root) {
  'use strict';

  function createSaveQueue(opts) {
    var o = opts || {};

    if (typeof o.save !== 'function') {
      throw new Error('createSaveQueue requires a save function.');
    }

    var save = o.save;
    var now = o.now || function () { return Date.now(); };
    var setTimer = o.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = o.clearTimer || function (h) { clearTimeout(h); };
    var onError = o.onError || function () {};

    /** Quiet period. A burst of awards inside this window becomes one write. */
    var QUIET_MS = o.quietMs == null ? 1200 : o.quietMs;
    /** Hard ceiling from the OLDEST unsaved change. Defeats starvation (1). */
    var MAX_WAIT_MS = o.maxWaitMs == null ? 5000 : o.maxWaitMs;
    var BACKOFF_MS = o.backoffMs == null ? 2000 : o.backoffMs;
    var MAX_BACKOFF_MS = o.maxBackoffMs == null ? 30000 : o.maxBackoffMs;

    // `dirty` means: there are changes NOT included in any started save.
    var dirty = false;
    // When the oldest currently-unsaved change was requested. Drives the
    // ceiling, so a steady trickle cannot postpone a write forever.
    var oldestRequestAt = null;
    var timer = null;
    var inFlight = null;          // promise of the running save, or null
    var waiters = [];             // settle when a save covering them completes
    var consecutiveFailures = 0;

    var stats = { requested: 0, saves: 0, coalesced: 0, failures: 0, flushes: 0 };

    function backoffMs() {
      if (!consecutiveFailures) return 0;
      var ms = BACKOFF_MS * Math.pow(2, consecutiveFailures - 1);
      return Math.min(ms, MAX_BACKOFF_MS);
    }

    function schedule() {
      // A save is already running. Whatever is dirty will be picked up when it
      // settles; starting a second one now is the overlap this prevents (6).
      if (inFlight) return;
      if (!dirty) return;

      if (timer !== null) { clearTimer(timer); timer = null; }

      var elapsed = oldestRequestAt == null ? 0 : Math.max(0, now() - oldestRequestAt);
      // Whichever comes first: the quiet period, or the ceiling measured from
      // the oldest unsaved change.
      var wait = Math.min(QUIET_MS, Math.max(0, MAX_WAIT_MS - elapsed));
      var back = backoffMs();
      if (back > wait) wait = back;

      timer = setTimer(fire, wait);
    }

    function fire() {
      timer = null;
      if (!dirty || inFlight) return;
      run();
    }

    function run() {
      // THE SNAPSHOT BOUNDARY.
      //
      // Everything requested up to this line is covered by the save about to
      // start. `dirty` is cleared HERE, not on completion, so a request that
      // lands while the write is in flight re-arms it and gets its own pass (2).
      var covered = waiters;
      waiters = [];
      dirty = false;
      oldestRequestAt = null;
      stats.saves += 1;

      var settled;
      try {
        settled = Promise.resolve(save());
      } catch (err) {
        // A save that throws synchronously must not leave inFlight set, or the
        // queue wedges and never writes again.
        settled = Promise.reject(err);
      }

      inFlight = settled.then(function (result) {
        inFlight = null;
        consecutiveFailures = 0;
        for (var i = 0; i < covered.length; i++) covered[i].resolve(result);
        schedule();
        return result;
      }, function (err) {
        inFlight = null;
        consecutiveFailures += 1;
        stats.failures += 1;
        // The changes were NOT written. Re-arm rather than abandon them (4).
        dirty = true;
        if (oldestRequestAt == null) oldestRequestAt = now();
        for (var i = 0; i < covered.length; i++) covered[i].reject(err);
        try { onError(err, consecutiveFailures); } catch (e) { /* reporting must not break the queue */ }
        schedule();
        // Swallowed here so an unhandled rejection is not raised on the
        // internal promise; every caller already received the rejection above.
        return null;
      });

      return inFlight;
    }

    /**
     * Ask for a save. Returns a promise that settles when a save INCLUDING
     * this request has completed (3), so a caller may honestly report it.
     */
    function request(reason) {
      stats.requested += 1;
      if (dirty) stats.coalesced += 1;

      dirty = true;
      if (oldestRequestAt == null) oldestRequestAt = now();

      var w = {};
      var p = new Promise(function (resolve, reject) {
        w.resolve = resolve;
        w.reject = reject;
      });
      w.reason = reason || '';
      waiters.push(w);

      schedule();
      return p;
    }

    /**
     * Write everything outstanding NOW, skipping the quiet window.
     *
     * For the page closing (5) and for actions that must not be deferred: a
     * year rollover, a balance reset, a role change. Resolves once nothing is
     * outstanding, including work that arrived while a save was already running.
     */
    function flush() {
      stats.flushes += 1;
      if (timer !== null) { clearTimer(timer); timer = null; }

      if (inFlight) {
        // Wait for the running save, then take another pass if anything
        // arrived while it was going.
        return inFlight.then(function () {
          return dirty ? flush() : null;
        });
      }
      if (!dirty) return Promise.resolve(null);
      return run().then(function (r) {
        // A failed run re-arms `dirty`. Do not loop forever on a broken
        // connection: one flush is one honest attempt, and the caller was
        // already rejected.
        return r;
      });
    }

    return {
      request: request,
      flush: flush,
      /** True when work exists only in memory. Read by the unload handler. */
      isPending: function () { return dirty || inFlight !== null; },
      /** For tests and diagnostics only. */
      stats: function () {
        return {
          requested: stats.requested, saves: stats.saves,
          coalesced: stats.coalesced, failures: stats.failures,
          flushes: stats.flushes, pending: dirty,
          inFlight: inFlight !== null, consecutiveFailures: consecutiveFailures
        };
      }
    };
  }

  root.WildcatSaveQueue = { create: createSaveQueue };
})(typeof globalThis !== 'undefined' ? globalThis : this);
