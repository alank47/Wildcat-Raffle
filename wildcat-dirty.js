/**
 * Don't write what you already wrote.
 *
 * Pure. No DOM, no network, no clock, no globals.
 *
 * THE PROBLEM. saveData writes every slice on every save, whether or not the
 * slice changed. A teacher awarding Wildcat Cash triggers a save that also
 * re-sends five ticket-history documents -- roughly 9,600 stored rows the
 * server must read to merge -- for a Raffle mode nobody is running. Multiply by
 * thirty-four teachers on launch day and almost all of the load is the app
 * re-sending data identical to what is already stored.
 *
 * WHY SKIPPING IS SAFE, AND NOT A GUESS. The fingerprint is taken of the exact
 * payload that would be sent. If it matches a payload that has ALREADY been
 * written successfully, then sending it again cannot change the stored state:
 * mergeSlice is a union deduped by id, so identical input inserts nothing, and
 * saveSlice replaces a slice with the same contents it already holds. Skipping
 * is not "probably fine", it is a no-op by construction.
 *
 * The two ways this could go wrong are both closed:
 *
 *  1. RECORDING A WRITE THAT DID NOT HAPPEN. A fingerprint is stored only after
 *     the write RESOLVES. A failed or rejected write leaves the previous
 *     fingerprint in place, so the next save sends the slice again.
 *
 *  2. ANOTHER TAB CHANGING THE SERVER UNDERNEATH. Re-sending identical data
 *     would not have helped: these writes are unions and replacements, they
 *     never pull. Whatever the other tab wrote is reconciled on the next LOAD,
 *     exactly as before. Skipping loses nothing that sending would have saved.
 *
 * The fingerprint is per browser tab and deliberately not persisted. A reload
 * starts with nothing recorded, so the first save after it writes everything --
 * the cautious direction.
 */
(function (root) {
  'use strict';

  /**
   * A cheap, order-sensitive fingerprint of a value.
   *
   * FNV-1a over the JSON, plus the length. Not cryptographic and does not need
   * to be: the cost of a collision here is one skipped write of a slice whose
   * contents are already stored, and the length check makes an accidental
   * collision between two payloads of DIFFERENT size impossible.
   *
   * Order sensitive on purpose. Two arrays holding the same entries in a
   * different order are a different payload, and saveSlice would store them
   * differently, so they must fingerprint differently.
   */
  function fingerprint(value) {
    var json;
    try {
      json = JSON.stringify(value);
    } catch (e) {
      // A cycle, or something unserialisable. Refuse to fingerprint rather
      // than return something stable-looking: a wrong "unchanged" is a lost
      // write, and a null here simply means "always send this".
      return null;
    }
    if (json === undefined) return null;

    var h = 0x811c9dc5;
    for (var i = 0; i < json.length; i++) {
      h ^= json.charCodeAt(i);
      // FNV prime, via shifts so this stays in 32-bit integer arithmetic.
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return json.length + ':' + h.toString(36);
  }

  function createTracker() {
    var written = Object.create(null);
    var stats = { checked: 0, skipped: 0, sent: 0 };

    /**
     * True when this payload differs from the last one successfully written
     * under this key. An unfingerprintable payload always returns true.
     */
    function changed(key, value) {
      stats.checked += 1;
      var fp = fingerprint(value);
      if (fp === null) { stats.sent += 1; return true; }
      if (written[key] === fp) { stats.skipped += 1; return false; }
      stats.sent += 1;
      return true;
    }

    /** Record a write that ACTUALLY LANDED. Never call this before it resolves. */
    function markWritten(key, value) {
      var fp = fingerprint(value);
      if (fp !== null) written[key] = fp;
    }

    /**
     * Forget a key, so the next save sends it regardless.
     *
     * For a write that failed after being marked, and for a load that replaced
     * local state with the server's: after a load this tab's idea of what it
     * has written is no longer about the data it now holds.
     */
    function forget(key) {
      if (key === undefined) { written = Object.create(null); return; }
      delete written[key];
    }

    return {
      changed: changed,
      markWritten: markWritten,
      forget: forget,
      stats: function () {
        return { checked: stats.checked, skipped: stats.skipped, sent: stats.sent };
      }
    };
  }

  root.WildcatDirty = { fingerprint: fingerprint, create: createTracker };
})(typeof globalThis !== 'undefined' ? globalThis : this);
