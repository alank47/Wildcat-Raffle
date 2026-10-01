/**
 * Reading a Wildcat Cash audit entry.
 *
 * Pure. No DOM, no clock, no globals.
 *
 * WHY THIS EXISTS. The cash Audit Log screen read fields that addToAuditLog has
 * never written. It asked for `log.teacherName` (the entry carries `teacher`)
 * and for `log.details` (the entry carries `reason`), then tried to recover the
 * behaviour and the amount by running a regular expression over that missing
 * string. So every column except Date and Action was wrong at once: the teacher
 * read "System" for every row, the student fell back to "Student #12345", and
 * the behaviour, amount and notes were all "-".
 *
 * Nothing errored, which is why it survived. Undefined fields render as
 * fallbacks, and a fallback looks like data.
 *
 * The rules live here, in one place, because the Audit Log and the per-student
 * account history are two views of the same entry. Two renderers formatting the
 * same record independently is how they end up disagreeing about what a
 * transaction was, and this screen is what a parent dispute is settled with.
 */
(function (root) {
  'use strict';

  /** Actions that belong to Wildcat Cash. */
  var CASH_ACTIONS = [
    'cash_award',
    'cash_deduct',
    'reward_redemption',
    'reward_fulfilled',
    'reward_cancelled',
    'reset_all_student_cash',
    'cash_recount',
    'cash_drift_detected',
    'cash_refund_withdrawn',
    'cash_reversal_credit',
    'cash_reversal_debit'
  ];

  var LABELS = {
    cash_award:             { label: 'Cash Awarded',    icon: '💰', cls: 'act-award',  sign: 1 },
    cash_deduct:            { label: 'Cash Deducted',   icon: '⚠️', cls: 'act-deduct', sign: -1 },
    reward_redemption:      { label: 'Reward Redeemed', icon: '🎁', cls: 'act-redeem', sign: -1 },
    reward_fulfilled:       { label: 'Reward Given',    icon: '✅', cls: 'act-redeem', sign: 0 },
    reward_cancelled:       { label: 'Reward Cancelled',icon: '↩️', cls: 'act-other',  sign: 1 },
    reset_all_student_cash: { label: 'System Reset',    icon: '🔄', cls: 'act-reset',  sign: 0 },
    // A counter correction, not a movement: the recount derives the four cash
    // counters from transactions that were already there. sign 0 because no
    // money changed hands -- a signed amount here would read as an award.
    cash_recount:           { label: 'Balances Recounted', icon: '🧮', cls: 'act-reset', sign: 0 },
    // The nightly check found counters disagreeing with the ledger. It only
    // REPORTS -- no money moved -- so sign 0, and the figure in `details` is a
    // count of students rather than an amount.
    cash_drift_detected:    { label: 'Balances Drifted', icon: '⚠️', cls: 'act-reset', sign: 0 },
    // A refund that minted money and has been taken back out of the ledger.
    // sign 0: the student's balance does NOT move, because the refund never
    // reached their counter in the first place -- which is the whole reason
    // withdrawing it is safe. See legacyPurge:reverseRefund.
    cash_refund_withdrawn:  { label: 'Refund Withdrawn', icon: '🚫', cls: 'act-other', sign: 0 },
    // A REVERSAL, IN TWO ACTIONS, and the split is what makes the money render.
    // `describe()` computes `signed = meta.sign * Math.abs(amount)` off this
    // static map, so one action would need sign 0 and every reversal would read
    // "+$0" -- the same trap the `null, never 0` note above warns about.
    // Which one is written is decided from the ORIGINAL's sign, server-side:
    // reversing a deduction hands money back (credit), reversing an award takes
    // it back (debit).
    cash_reversal_credit:   { label: 'Reversed (refunded)', icon: '↩️', cls: 'act-award',  sign: 1 },
    cash_reversal_debit:    { label: 'Reversed (taken back)', icon: '↩️', cls: 'act-deduct', sign: -1 }
  };

  function str(v) { return String(v == null ? '' : v).trim(); }

  function isCashEntry(entry) {
    return Boolean(entry) && CASH_ACTIONS.indexOf(str(entry.action)) !== -1;
  }

  /**
   * Behaviour and notes, which older entries hold jammed into one string.
   *
   * The award screens built `reason` as "Behaviour name, whatever the teacher
   * typed", so the two can only be separated by splitting on the first comma --
   * and a behaviour name containing a comma would split in the wrong place.
   * That is why entries written from 2026-09-05 carry `behavior` and `notes` as
   * their own fields; this splitting is the fallback for everything already
   * stored, not the way forward.
   */
  function behaviorAndNotes(entry) {
    var e = entry || {};
    if (str(e.behavior) || str(e.notes)) {
      return { behavior: str(e.behavior), notes: str(e.notes), split: false };
    }
    var reason = str(e.reason);
    if (!reason) return { behavior: '', notes: '', split: false };
    var at = reason.indexOf(', ');
    if (at === -1) return { behavior: reason, notes: '', split: true };
    return {
      behavior: reason.slice(0, at).trim(),
      notes: reason.slice(at + 2).trim(),
      split: true
    };
  }

  /**
   * One entry, as the screen needs it.
   *
   * `amount` is the magnitude the entry stored; `signed` applies the direction
   * the action implies. A deduction is stored as a positive number with a
   * negative action, and showing it unsigned is how a screen tells a parent
   * their child GAINED five dollars they actually lost.
   *
   * `studentName` falls back to a lookup only when the entry has none. Entries
   * snapshot the name at the time, deliberately: a student who leaves drops off
   * the roster, and their audit history must stay readable.
   */
  function describe(entry, lookupStudentName) {
    var e = entry || {};
    var action = str(e.action);
    var meta = LABELS[action] || { label: action || 'Activity', icon: '📝', cls: 'act-other', sign: 0 };
    var bn = behaviorAndNotes(e);

    var raw = Number(e.ticketCount);
    var amount = isFinite(raw) ? Math.abs(raw) : null;

    var name = str(e.studentName);
    if (!name && typeof lookupStudentName === 'function') name = str(lookupStudentName(e.studentId));

    return {
      entryId: str(e.entryId),
      timestamp: str(e.timestamp),
      action: action,
      actionLabel: meta.label,
      actionIcon: meta.icon,
      actionClass: meta.cls,
      teacher: str(e.teacher) || 'Unknown',
      studentId: str(e.studentId),
      studentName: name || (str(e.studentId) ? 'Student #' + str(e.studentId) : 'Unknown'),
      behavior: bn.behavior,
      notes: bn.notes,
      amount: amount,
      sign: meta.sign,
      // null, never 0: an entry with no amount (a reset) must not read as $0.
      signed: amount == null ? null : meta.sign * amount
    };
  }

  /** Cash entries for one student, newest first. */
  function forStudent(auditLog, studentId) {
    var want = str(studentId);
    if (!want) return [];
    return (auditLog || [])
      .filter(function (e) { return isCashEntry(e) && str(e.studentId) === want; })
      .slice()
      .sort(function (a, b) {
        return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
      });
  }

  /** What a row must match to survive a search, as one lowercase string. */
  function searchText(described) {
    var d = described || {};
    return [d.teacher, d.studentName, d.studentId, d.actionLabel,
            d.behavior, d.notes, d.amount == null ? '' : String(d.amount)]
      .join(' ').toLowerCase();
  }

  // =====================================================================
  // THE "AWARDS THAT ARRIVED WITHOUT THEIR MONEY" LIST: which rows are
  // ticked, and which "given again" warnings the admin has acknowledged.
  // Pure, so the rules are tested by running them, not by reading them.
  //
  // THE RULE THE SECOND REVIEW (2026-09-30) FORCED: an acknowledgement is
  // made by a CLICK, while the warning is on screen, and is bound to the
  // exact set of candidates shown (candidateSig). A default tick is never an
  // acknowledgement, and when the candidates change the tick and the
  // acknowledgement are both dropped, so the admin has to look again.
  // =====================================================================

  function arrivalPlain(a) {
    if (!a || a.paidMeanwhile || !a.found || a.blocked) return false;
    if (a.kind === 'deduct') return false;
    if (a.candidates && a.candidates.length) return false;
    var worry = ['delivered_by_other', 'twin', 'late', 'unchecked', 'later_similar'];
    return !(a.flags || []).some(function (f) { return worry.indexOf(f) !== -1; });
  }

  /**
   * The picks after a (re)load. state = { picks: {id:true}, seen: {id: sig},
   * acks: {id: sig} }; returns a new state. Kept for a row already seen with
   * the SAME candidates; dropped when its candidates changed, when it became
   * paid or blocked; a new row is ticked only when plain.
   */
  function arrivalReload(state, list) {
    var st = state || {};
    var picks = {}, seen = {}, acks = {}, hand = {};
    (list || []).forEach(function (a) {
      if (!a || !a.id) return;
      var sig = str(a.candidateSig);
      var before = st.seen ? st.seen[a.id] : undefined;
      seen[a.id] = sig;
      if (a.paidMeanwhile) return;
      if (before === undefined) {
        if (arrivalPlain(a)) picks[a.id] = true;
        return;
      }
      if (before !== sig) return;                 // new candidates: look again
      if (st.picks && st.picks[a.id]) picks[a.id] = true;
      if (st.acks && st.acks[a.id] === sig && sig) acks[a.id] = sig;
      if (st.hand && st.hand[a.id] && picks[a.id]) hand[a.id] = true;
    });
    return { picks: picks, seen: seen, acks: acks, hand: hand };
  }

  /**
   * A row the app cannot check -- too old for the register, or for the panel
   * -- is left for the cash recount, which compares the whole ledger with the
   * counters (final re-review, 2026-10-01). Neither button acts on it, so it
   * cannot be ticked. Must match LEFT_FOR_THE_RECOUNT in convex/cashArrival.ts.
   */
  function arrivalLeftForRecount(a) {
    return Boolean(a && (a.blocked === 'coverage_lost' || a.blocked === 'stale' || a.blocked === 'before_reset'));
  }

  /** A click on one row. Ticking a warned row acknowledges what it shows. */
  function arrivalToggle(state, a) {
    if (arrivalLeftForRecount(a)) return state;
    var picks = Object.assign({}, state.picks), acks = Object.assign({}, state.acks);
    var hand = Object.assign({}, state.hand);
    if (picks[a.id]) { delete picks[a.id]; delete acks[a.id]; delete hand[a.id]; }
    else {
      picks[a.id] = true;
      hand[a.id] = true;
      if (str(a.candidateSig)) acks[a.id] = str(a.candidateSig);
    }
    return { picks: picks, seen: state.seen, acks: acks, hand: hand };
  }

  /**
   * What Dismiss acts on: ONLY rows the admin ticked by hand (final review,
   * 2026-10-01). Plain lost awards arrive pre-ticked for Give back; a Dismiss
   * aimed at one warned row must never take them along with it.
   */
  function arrivalDismissRequest(state, list) {
    var ids = [];
    (list || []).forEach(function (a) {
      if (a && state.hand && state.hand[a.id] && state.picks[a.id] && !a.paidMeanwhile && !arrivalLeftForRecount(a)) ids.push(a.id);
    });
    return ids;
  }

  /** What Give back sends: payable picks, and the acknowledgements for them. */
  function arrivalFixRequest(state, list) {
    var ids = [], acknowledged = [];
    (list || []).forEach(function (a) {
      if (!state.picks[a.id] || a.paidMeanwhile || a.blocked) return;
      ids.push(a.id);
      if (state.acks[a.id]) acknowledged.push({ id: a.id, sig: state.acks[a.id] });
    });
    return { ids: ids, acknowledged: acknowledged };
  }

  root.WildcatCashAudit = {
    arrivalPlain: arrivalPlain,
    arrivalReload: arrivalReload,
    arrivalToggle: arrivalToggle,
    arrivalFixRequest: arrivalFixRequest,
    arrivalDismissRequest: arrivalDismissRequest,
    arrivalLeftForRecount: arrivalLeftForRecount,
    CASH_ACTIONS: CASH_ACTIONS.slice(),
    isCashEntry: isCashEntry,
    behaviorAndNotes: behaviorAndNotes,
    describe: describe,
    forStudent: forStudent,
    searchText: searchText
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
