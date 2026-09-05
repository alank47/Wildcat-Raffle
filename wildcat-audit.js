/**
 * Audit entry identity.
 *
 * Pure. No DOM, no clock unless one is handed in, no globals.
 *
 * THE PROBLEM WITH THE OLD ID. `ensureEntryId` derives an id by hashing the
 * entry's own contents into a 32-bit integer. That is stable, which is what it
 * was for -- the same entry re-sent from two tabs produces the same id and
 * dedupes correctly.
 *
 * It is also only about 2.1 billion values, and the birthday bound is what
 * matters for a dedupe key. At the ~50,000 entries a year this school will
 * write, the chance that SOME pair of different entries collides is better than
 * even. A collision means the second entry is treated as a duplicate of the
 * first and silently dropped -- a cash award that happened, with no record that
 * it did. That is the same failure the referral counter produced, arriving by a
 * different route.
 *
 * So entries written from 2026-09-04 carry a minted id instead: unique by
 * construction, never derived from content, and never colliding with a legacy
 * hashed id because of the prefix.
 *
 * LEGACY IDS ARE NOT REWRITTEN. Every entry already stored carries an `e_`
 * hash, and those ids are the dedupe key for records that exist in the mirror,
 * in browsers' outboxes and in exports. Recomputing them would orphan every one
 * of those. ensureEntryId keeps deriving the old id for old entries; this only
 * changes what a NEW entry is born with.
 */
(function (root) {
  'use strict';

  // Base36 with the pairs a person confuses when reading one out broken up: no
  // 0 and no O, no 1 and no I. 32 symbols, which divides 256 and so keeps the
  // byte modulo below unbiased.
  var ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  var RANDOM_LEN = 10;

  /**
   * A unique id for a new audit entry.
   *
   * `a_` prefix, so it can never be mistaken for -- or collide with -- a
   * legacy `e_` content hash. Then the timestamp in milliseconds, which makes
   * ids sort chronologically and makes two entries in different milliseconds
   * distinct before randomness is even considered. Then ten random symbols:
   * about 10^15 per millisecond, so two teachers awarding the same class in
   * the same instant on different machines still cannot collide.
   *
   * crypto.getRandomValues when it exists. Math.random is seeded per process,
   * and a school's Chromebooks boot together off one image; correlated seeds
   * are exactly the case where two machines produce the same suffix at the same
   * moment. Falls back rather than throwing: refusing to record an award
   * because randomness is unavailable would lose the very thing this protects.
   */
  function newAuditEntryId(now, random) {
    var ms = (now instanceof Date) ? now.getTime()
           : (typeof now === 'number' ? now : Date.now());

    var suffix = '';
    var i;
    if (typeof random === 'function') {
      for (i = 0; i < RANDOM_LEN; i++) {
        suffix += ALPHABET.charAt(Math.floor(random() * ALPHABET.length) % ALPHABET.length);
      }
    } else {
      var g = (typeof crypto !== 'undefined' && crypto && crypto.getRandomValues) ? crypto : null;
      if (g) {
        var bytes = new Uint8Array(RANDOM_LEN);
        g.getRandomValues(bytes);
        for (i = 0; i < RANDOM_LEN; i++) suffix += ALPHABET.charAt(bytes[i] % ALPHABET.length);
      } else {
        for (i = 0; i < RANDOM_LEN; i++) {
          suffix += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length) % ALPHABET.length);
        }
      }
    }

    // ZERO PADDED, so ids sort chronologically as plain strings.
    //
    // Base36 of Date.now() happens to be 8 characters from 2004 until 2059, so
    // unpadded ids would sort correctly for the life of this school and then
    // stop -- and would already sort wrongly for any test or fixture using a
    // small timestamp. A fixed width makes the property true rather than
    // true-for-now. 9 characters covers past the year 5000.
    var stamp = ms.toString(36);
    while (stamp.length < 9) stamp = '0' + stamp;

    return 'a_' + stamp + '_' + suffix;
  }

  /** True for an id this module minted, as opposed to a legacy content hash. */
  function isMintedAuditId(id) {
    return typeof id === 'string' && id.indexOf('a_') === 0;
  }

  /**
   * Split entries into chunks the append mutation will accept.
   *
   * The server caps a batch, and the client must not discover that by having a
   * save rejected: an audit entry that fails to send is a record of something
   * that already happened to a child.
   */
  function chunk(entries, size) {
    var out = [];
    var list = entries || [];
    var n = (typeof size === 'number' && size > 0) ? Math.floor(size) : 500;
    for (var i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
  }

  /**
   * The wire shape: the indexed columns lifted out, the entry kept verbatim.
   *
   * `idOf` is injected rather than imported so this file stays free of the
   * app's globals; script.js passes ensureEntryId, which returns an existing
   * id unchanged and derives the legacy hash for anything older.
   */
  function toRows(entries, idOf) {
    return (entries || []).map(function (e) {
      return {
        entryId: String(idOf(e) || ''),
        timestamp: String((e && e.timestamp) || ''),
        payload: e
      };
    }).filter(function (r) { return r.entryId !== ''; });
  }

  root.WildcatAudit = {
    newAuditEntryId: newAuditEntryId,
    isMintedAuditId: isMintedAuditId,
    chunk: chunk,
    toRows: toRows,
    MAX_APPEND: 500
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
