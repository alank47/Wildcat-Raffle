/**
 * Merging a stale tab's copy of a list against what is already stored.
 *
 * Pure. No DOM, no network, no clock. Split out because this is a data-loss
 * boundary and deserves assertions rather than a read-through.
 *
 * THE PROBLEM THIS EXISTS FOR.
 *
 * Referrals were written with a whole-document setDoc:
 *
 *     setDoc(doc(db, 'raffle_data', 'referrals'), { behaviorReferrals, ... })
 *
 * which is last-write-wins against whatever that tab happens to hold in memory.
 * Teacher A files a referral. Teacher B has had the app open since this
 * morning, so their copy predates it. B does anything that triggers a save and
 * A's referral is gone, with no error anywhere: B's browser was simply
 * confident about a list that was out of date.
 *
 * The app previously mitigated this by reloading every tab every five minutes,
 * which narrowed the window rather than closing it, and cost a submitted
 * referral when a reload landed mid-save.
 *
 * THE RULE.
 *
 * Union by id. A row present on either side survives. A row on both sides
 * resolves to whichever was touched more recently, so an admin closing a
 * referral still beats an older open copy of the same one.
 *
 * NEVER "the local list wins because it is mine". A tab that has been open all
 * day is the LEAST likely to be right about a list other people are editing.
 */
(function (root) {
  'use strict';

  function trimmed(v) {
    return String(v == null ? '' : v).trim();
  }

  function timeOf(value) {
    if (!value) return 0;
    var t = new Date(value).getTime();
    return isFinite(t) ? t : 0;
  }

  /**
   * When a row was last meaningfully touched.
   *
   * Falls back through the stamps a referral actually carries, newest concept
   * first, so rows written before `updatedAt` existed still order sensibly
   * rather than all collapsing to zero and letting order decide.
   */
  function lastTouched(row, stampFields) {
    var fields = stampFields || ['updatedAt', 'loopClosedAt', 'closedAt', 'submittedAt'];
    var best = 0;
    for (var i = 0; i < fields.length; i++) {
      var t = timeOf(row && row[fields[i]]);
      if (t > best) best = t;
    }
    return best;
  }

  /**
   * Union two lists by id, preferring the more recently touched copy.
   *
   * `stored` is what is already saved, `local` is this tab's version. Returns
   * a new array; neither input is mutated.
   *
   * Rows with no usable id are KEPT rather than dropped. Losing a referral
   * because it is malformed is the same outcome this function exists to
   * prevent, and a duplicate is recoverable where a deletion is not.
   */
  function mergeById(stored, local, opts) {
    var o = opts || {};
    var idField = o.idField || 'id';
    var stamps = o.stampFields;

    var byId = {};
    var order = [];
    var unidentified = [];

    function absorb(rows) {
      (rows || []).forEach(function (row) {
        if (!row) return;
        var id = trimmed(row[idField]);
        if (!id) { unidentified.push(row); return; }
        if (!Object.prototype.hasOwnProperty.call(byId, id)) {
          byId[id] = row;
          order.push(id);
          return;
        }
        // Seen on both sides. Keep whichever was touched later; on a tie keep
        // what is already there, so a save that changes nothing writes nothing
        // new and repeated saves are stable.
        if (lastTouched(row, stamps) > lastTouched(byId[id], stamps)) byId[id] = row;
      });
    }

    absorb(stored);
    absorb(local);

    return order.map(function (id) { return byId[id]; }).concat(unidentified);
  }

  /**
   * What merging would change, for a log line worth reading.
   *
   * "referrals saved (4 records)" told nobody that a fifth had just been
   * dropped. This makes the interesting cases nameable.
   */
  function mergeReport(stored, local, merged, opts) {
    var idField = (opts || {}).idField || 'id';
    var ids = function (rows) {
      var out = {};
      (rows || []).forEach(function (r) { if (r && trimmed(r[idField])) out[trimmed(r[idField])] = true; });
      return out;
    };
    var s = ids(stored), l = ids(local), m = ids(merged);
    var addedByThisTab = Object.keys(l).filter(function (k) { return !s[k]; });
    // The ones that would have been destroyed by a whole-document write.
    var keptFromStorage = Object.keys(s).filter(function (k) { return !l[k]; });
    return {
      stored: Object.keys(s).length,
      local: Object.keys(l).length,
      merged: Object.keys(m).length,
      addedByThisTab: addedByThisTab.length,
      keptFromStorage: keptFromStorage.length,
      wouldHaveLost: keptFromStorage
    };
  }

  root.WildcatMerge = {
    mergeById: mergeById,
    mergeReport: mergeReport,
    lastTouched: lastTouched
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
