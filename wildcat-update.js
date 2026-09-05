/**
 * Getting a new version onto a screen nobody is going to reload.
 *
 * Pure. No DOM, no clock, no globals: everything it needs is passed in.
 *
 * THE PROBLEM. index.html is served with cache-control: max-age=600, and a tab
 * left open never re-fetches it at all. Teachers keep this app open all day, so
 * a fix shipped at nine in the morning reaches nobody. On 2026-09-04 two people
 * reported a bug as unfixed from tabs running code five versions old, and the
 * time went into diagnosing code they were not running.
 *
 * The existing answer was a bar saying "a new version is available" with a
 * Reload button. That is a prompt, not a system: it can be dismissed, missed,
 * or simply ignored by somebody teaching a class.
 *
 * WHY NOT JUST RELOAD. A reload throws away whatever is on screen. Do it while
 * a teacher is halfway through a referral and they lose the referral; do it
 * while a save is in flight and the save is what you lose. The bar exists
 * because an earlier automatic reload ate in-flight saves.
 *
 * So the rule is not "reload when there is an update", it is "reload at the
 * first moment when losing this screen costs nothing". Those moments are
 * common: the tab is in the background, or the teacher has not touched it for
 * a couple of minutes. Both happen many times an hour in a classroom.
 *
 * THE LOOP IS THE DANGER. If a reload does not actually produce the new
 * version -- which is exactly what happens inside the ten minute cache window
 * -- an unguarded rule reloads again, and again, forever, on every teacher's
 * screen at once. That is far worse than a stale version. Hence
 * `attemptedVersion`: one automatic attempt per version, and if the attempt
 * does not change what is running, it stops and leaves the bar for a human.
 */
(function (root) {
  'use strict';

  /** How long a teacher must have been idle before a reload counts as free. */
  var IDLE_MS = 120000;

  /**
   * Should this tab reload itself right now?
   *
   * Returns a reason either way. The reason is logged rather than discarded,
   * because "why has this tab not updated" is a question somebody will ask on
   * a morning when it matters.
   */
  function shouldAutoReload(state) {
    var s = state || {};

    if (!s.hasUpdate) return { reload: false, reason: 'up to date' };

    // ONE ATTEMPT PER VERSION. If a reload already happened for this version
    // and the version on screen still is not it, reloading again will not help
    // -- the browser is serving the cached index.html and will keep doing so
    // until it expires. Stop, and let the bar ask a person.
    if (s.attemptedVersion && s.attemptedVersion === s.newVersion) {
      return { reload: false, reason: 'already tried this version; leaving it to the bar' };
    }

    // NEVER OVER UNSAVED WORK. This is the failure that got automatic reloads
    // removed the first time.
    if (s.savePending) return { reload: false, reason: 'a save is still pending' };

    // A dialog, a half-typed referral, students ticked ready to award. All are
    // work that exists only on screen.
    if (s.busy) return { reload: false, reason: 'the screen has unfinished work on it' };

    // The best moment there is: nobody is looking. They come back to the new
    // version and never see a flicker.
    if (s.hidden) return { reload: true, reason: 'tab is in the background' };

    var idle = typeof s.idleMs === 'number' ? s.idleMs : 0;
    var threshold = typeof s.idleThresholdMs === 'number' ? s.idleThresholdMs : IDLE_MS;
    if (idle >= threshold) {
      return { reload: true, reason: 'idle for ' + Math.round(idle / 1000) + 's' };
    }

    return { reload: false, reason: 'someone is using it' };
  }

  /**
   * The URL to reload to, cache-busted, with the existing query preserved.
   *
   * A plain location.reload() may be answered from the browser cache, which
   * inside the ten minute window returns the SAME index.html and achieves
   * nothing. A query parameter the cache has not seen forces a real fetch.
   *
   * `tap` and `pass` are carried in the query string and mean something to the
   * app, so this adds a parameter rather than replacing the query. The app
   * strips wcv on the way back in, so it does not accumulate.
   */
  function reloadUrl(href, version) {
    var url;
    try {
      url = new URL(String(href));
    } catch (e) {
      return null;
    }
    url.searchParams.set('wcv', String(version || Date.now()));
    return url.toString();
  }

  /** Remove the cache-buster, so the address bar does not collect them. */
  function cleanUrl(href) {
    var url;
    try {
      url = new URL(String(href));
    } catch (e) {
      return null;
    }
    if (!url.searchParams.has('wcv')) return null;
    url.searchParams.delete('wcv');
    return url.toString();
  }

  root.WildcatUpdate = {
    IDLE_MS: IDLE_MS,
    shouldAutoReload: shouldAutoReload,
    reloadUrl: reloadUrl,
    cleanUrl: cleanUrl
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
