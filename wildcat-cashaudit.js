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
    'reset_all_student_cash'
  ];

  var LABELS = {
    cash_award:             { label: 'Cash Awarded',    icon: '💰', cls: 'act-award',  sign: 1 },
    cash_deduct:            { label: 'Cash Deducted',   icon: '⚠️', cls: 'act-deduct', sign: -1 },
    reward_redemption:      { label: 'Reward Redeemed', icon: '🎁', cls: 'act-redeem', sign: -1 },
    reward_fulfilled:       { label: 'Reward Given',    icon: '✅', cls: 'act-redeem', sign: 0 },
    reward_cancelled:       { label: 'Reward Cancelled',icon: '↩️', cls: 'act-other',  sign: 1 },
    reset_all_student_cash: { label: 'System Reset',    icon: '🔄', cls: 'act-reset',  sign: 0 }
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

  root.WildcatCashAudit = {
    CASH_ACTIONS: CASH_ACTIONS.slice(),
    isCashEntry: isCashEntry,
    behaviorAndNotes: behaviorAndNotes,
    describe: describe,
    forStudent: forStudent,
    searchText: searchText
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
