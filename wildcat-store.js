/**
 * Wildcat Cash rewards store: what a reward IS, what a purchase IS, and which
 * state changes are legal.
 *
 * Pure. No DOM, no globals, no database, and no clock of its own: `now` is
 * always passed in. Split out for the same reason convex/hallPassRules.ts and
 * convex/sisMerge.ts are split out, and for the reason wildcat-auth.js gives:
 * script.js is ~1MB and is hand-edited through the GitHub web UI, so every
 * line added there is conflict surface. This decides where a child's money
 * goes, so it is worth asserting directly rather than eyeballing through a
 * handler no test can run.
 *
 * THE RULES THIS FILE EXISTS TO HOLD
 *
 * 1. A receipt records what was PAID, not what the reward costs today.
 *    Rewards are editable, so the name and cost are snapshotted onto the
 *    receipt at purchase. Reading a price back off the reward would rewrite
 *    history every time an admin changed it.
 *
 * 2. Rewards are RETIRED, never deleted. Every receipt points at a rewardId,
 *    and deleting the reward orphans a term of purchases. Same principle the
 *    roster work settled on for students who leave.
 *
 * 3. A cancellation never edits the original transaction. It issues a REFUND
 *    transaction, so the ledger reads forward and the audit trail survives.
 *
 * 4. Money moves in exactly one place. This file never touches a balance: it
 *    returns a transaction REQUEST for the caller to hand to
 *    recordCashTransaction, which is the single writer. The bug this replaces
 *    had reward redemptions building their own transaction objects and pushing
 *    them into an array nothing persisted.
 */
(function (root) {
  'use strict';

  var RECEIPT_STATES = ['issued', 'fulfilled', 'cancelled'];
  var TERMINAL_RECEIPT_STATES = ['fulfilled', 'cancelled'];

  // No O/0/I/1: a student reads this off a screen and a staff member types it
  // back in. Ambiguous glyphs turn a lookup into a support conversation.
  var CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

  function isFiniteNumber(n) {
    return typeof n === 'number' && isFinite(n);
  }

  function trimmed(s) {
    return String(s == null ? '' : s).trim();
  }

  /** Deterministic when a generator is supplied, so tests are not flaky. */
  function makeReceiptCode(rand) {
    var pick = typeof rand === 'function' ? rand : Math.random;
    var out = '';
    for (var i = 0; i < 6; i++) {
      out += CODE_ALPHABET.charAt(Math.floor(pick() * CODE_ALPHABET.length) % CODE_ALPHABET.length);
    }
    return 'WC-' + out;
  }

  // ---------------------------------------------------------------------
  // Rewards
  // ---------------------------------------------------------------------

  /**
   * What a reward must satisfy to be saved. Returned as a list rather than a
   * single message so a form can mark every bad field at once.
   */
  function validateReward(patch) {
    var errors = [];
    var name = trimmed(patch && patch.name);
    if (!name) errors.push('Name is required.');
    if (name.length > 80) errors.push('Name must be 80 characters or fewer.');

    var cost = patch && patch.cost;
    if (!isFiniteNumber(cost)) errors.push('Cost must be a number.');
    else if (cost <= 0) errors.push('Cost must be greater than zero.');
    else if (Math.floor(cost) !== cost) errors.push('Cost must be a whole number.');

    if (patch && patch.stock != null) {
      if (!isFiniteNumber(patch.stock) || patch.stock < 0 || Math.floor(patch.stock) !== patch.stock) {
        errors.push('Stock must be a whole number of zero or more, or left blank for unlimited.');
      }
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /** Fill in every field the rest of the code assumes, without mutating input. */
  function normalizeReward(raw, now, actor) {
    var r = raw || {};
    var actorName = trimmed(actor && (actor.name || actor.username)) || 'system';
    return {
      id: trimmed(r.id) || ('reward_' + now),
      name: trimmed(r.name),
      cost: isFiniteNumber(r.cost) ? r.cost : 0,
      description: trimmed(r.description),
      category: trimmed(r.category) || 'General',
      // null means unlimited. 0 means genuinely out of stock, which is why
      // this is not collapsed with a falsy check anywhere below.
      stock: isFiniteNumber(r.stock) ? r.stock : null,
      available: r.available !== false,
      createdAt: r.createdAt || new Date(now).toISOString(),
      createdBy: r.createdBy || actorName,
      updatedAt: r.updatedAt || null,
      updatedBy: r.updatedBy || null,
      retiredAt: r.retiredAt || null,
      retiredBy: r.retiredBy || null
    };
  }

  /** Returns a NEW reward. Callers replace, never mutate, so undo stays possible. */
  function applyRewardEdit(reward, patch, now, actor) {
    var base = normalizeReward(reward, now, actor);
    var next = {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) next[k] = base[k];

    if (patch && 'name' in patch) next.name = trimmed(patch.name);
    if (patch && 'cost' in patch) next.cost = patch.cost;
    if (patch && 'description' in patch) next.description = trimmed(patch.description);
    if (patch && 'category' in patch) next.category = trimmed(patch.category) || 'General';
    if (patch && 'stock' in patch) next.stock = patch.stock == null ? null : patch.stock;
    if (patch && 'available' in patch) next.available = patch.available !== false;

    next.updatedAt = new Date(now).toISOString();
    next.updatedBy = trimmed(actor && (actor.name || actor.username)) || 'system';
    return next;
  }

  function retireReward(reward, now, actor) {
    var next = applyRewardEdit(reward, { available: false }, now, actor);
    var stamp = new Date(now).toISOString();
    next.retiredAt = stamp;
    // updatedAt TOO, and not for tidiness. legacyData.touchedAt only reads
    // updatedAt / loopClosedAt / closedAt / submittedAt when deciding which
    // copy of a row wins a merge. retiredAt is not on that list, so a
    // retirement that set only retiredAt scored zero, tied with the stored
    // un-retired copy, and lost -- the reward would come back on the next
    // load. Same reason applyRewardEdit sets it.
    next.retiredBy = trimmed(actor && (actor.name || actor.username)) || 'system';
    return next;
  }

  // ---------------------------------------------------------------------
  // Cash behaviours: the list staff award from and deduct against
  //
  // THE REWARD BUG, A SECOND TIME, found 2026-09-24. An admin added a
  // behaviour in Cash Settings, was told it saved, and nobody else ever saw
  // it. wildcatCashBehaviors was a hardcoded list that no save carried and no
  // load read: an addition lived only in the tab that made it and was gone
  // on its next load. It is now saved beside the rewards, merged by id, and
  // these rules decide what a stored behaviour may look like.
  //
  // RETIRED, NEVER DELETED, for the reason rewards are: the server unions by
  // id, so a behaviour deleted in one tab came straight back from any other
  // tab's next save. A retired one leaves every menu and stays on record, and
  // past awards keep the name they were given under.
  // ---------------------------------------------------------------------

  // An id goes into an onclick attribute on the settings screen, and every
  // behaviour now comes back from the server as data another person wrote --
  // so only a plain token is accepted as an id.
  var BEHAVIOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

  // The server refuses any single cash movement larger than this
  // (convex/appDataShape.ts MAX_CASH_DELTA). A behaviour worth more could be
  // created but never awarded: every award would be held, re-sent and never
  // land. Kept equal to the server's number; if that cap is lifted, lift this.
  var BEHAVIOR_MAX_AMOUNT = 5000;

  function validateBehavior(patch) {
    var errors = [];
    var name = trimmed(patch && patch.name);
    if (!name) errors.push('Please enter a behavior name.');
    if (name.length > 60) errors.push('The name must be 60 characters or fewer.');
    var type = patch && patch.type;
    if (type !== 'positive' && type !== 'negative') errors.push('Choose positive or negative.');
    var points = patch && patch.points;
    if (!isFiniteNumber(points) || Math.floor(points) !== points || points === 0) {
      errors.push('Enter a whole-dollar amount (not zero).');
    } else if (Math.abs(points) > BEHAVIOR_MAX_AMOUNT) {
      errors.push('A single award or deduction cannot be more than $' + BEHAVIOR_MAX_AMOUNT
        + ' right now: the server refuses bigger ones.');
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /**
   * Fill in every field the rest of the code reads, without mutating input.
   * Returns null for a row that cannot be a behaviour (no usable id, no
   * name, or no amount), which the merge drops rather than guesses at.
   * The sign always follows the type: an award is never negative.
   */
  function normalizeBehavior(raw, now, actor) {
    var r = raw || {};
    var id = trimmed(r.id);
    var name = trimmed(r.name);
    var pts = Number(r.points);
    if (!BEHAVIOR_ID.test(id) || !name || !isFiniteNumber(pts) || pts === 0) return null;
    var type = r.type === 'positive' || r.type === 'negative' ? r.type : (pts > 0 ? 'positive' : 'negative');
    var actorName = trimmed(actor && (actor.name || actor.username)) || 'system';
    return {
      id: id,
      name: name.slice(0, 60),
      points: type === 'negative' ? -Math.abs(pts) : Math.abs(pts),
      type: type,
      active: r.active !== false && !r.retiredAt,
      custom: r.custom === true,
      // NOT MINTED when absent. A fresh "now" here made every merge produce a
      // different list, so every idle pull looked like a change and re-sent the
      // whole list (found in review). The caller that creates one stamps it.
      createdAt: r.createdAt || null,
      createdBy: r.createdBy || (actor ? actorName : null),
      updatedAt: r.updatedAt || null,
      updatedBy: r.updatedBy || null,
      retiredAt: r.retiredAt || null,
      retiredBy: r.retiredBy || null
    };
  }

  /**
   * Retire a behaviour. updatedAt TOO: the server keeps whichever copy of a
   * row has the newer updatedAt, and a retirement that did not move it would
   * tie with the stored active copy and lose (the reward lesson, retireReward).
   */
  function retireBehavior(b, now, actor) {
    var next = normalizeBehavior(b, now, actor);
    if (!next) return null;
    var stamp = new Date(now).toISOString();
    var who = trimmed(actor && (actor.name || actor.username)) || 'system';
    next.active = false;
    next.retiredAt = stamp;
    next.retiredBy = who;
    // ALWAYS NEWER THAN THE COPY BEING RETIRED, whatever this device's clock
    // says. A Chromebook running five minutes slow stamped a retirement older
    // than the stored active copy, the server kept the active one, and the
    // behaviour came back while the admin was told it was removed.
    var prev = behaviorTouched(b);
    next.updatedAt = new Date(Math.max(now, prev + 1)).toISOString();
    next.updatedBy = who;
    return next;
  }

  function behaviorTouched(b) {
    var t = b && b.updatedAt ? Date.parse(b.updatedAt) : NaN;
    return isFinite(t) ? t : 0;
  }

  /**
   * The list a tab should hold, from what it has and what the server has.
   *
   * THE SAME RULE AS THE SERVER'S MERGE, so a tab and the database never
   * disagree about which copy of a behaviour wins: union by id, and where
   * both hold one, the server's copy unless this tab's was changed later.
   * A behaviour only this tab knows (added, save not yet landed) is kept.
   *
   * THE CORE BEHAVIOURS ARE ALWAYS THERE AND ALWAYS ACTIVE -- the four "Be"
   * awards and their four deductions, which the settings screen offers no way
   * to remove -- so a partial or damaged server list can never take away the
   * buttons every teacher uses.
   *
   * Order: the core list in its own order, then the school's own additions
   * oldest first, so the award menus do not reshuffle between loads.
   */
  function mergeBehaviorLists(local, server, core, now) {
    var byId = {};
    var order = [];
    var take = function (raw, fromServer) {
      var b = normalizeBehavior(raw, now, null);
      if (!b) return;
      var have = byId[b.id];
      if (!have) { byId[b.id] = { b: b, server: fromServer }; order.push(b.id); return; }
      if (fromServer) {
        if (behaviorTouched(have.b) > behaviorTouched(b)) return;   // this tab's is newer
        byId[b.id] = { b: b, server: true };
      } else if (behaviorTouched(b) > behaviorTouched(have.b)) {
        byId[b.id] = { b: b, server: false };
      }
    };
    (server || []).forEach(function (r) { take(r, true); });
    (local || []).forEach(function (r) { take(r, false); });

    var out = [];
    var coreIds = {};
    (core || []).forEach(function (c) {
      // THE CORE EIGHT COME FROM THE CODE, entirely. Their name, amount and
      // type are never taken from a stored copy, so no saved row -- damaged,
      // stale, or edited by hand -- can change "Be Present" for every
      // teacher, and a core behaviour can never be retired.
      var base = normalizeBehavior(c, now, null);
      if (!base) return;
      coreIds[base.id] = true;
      base.active = true;
      base.custom = false;
      out.push(base);
    });
    var extras = order.filter(function (id) { return !coreIds[id]; }).map(function (id) { return byId[id].b; });
    extras.sort(function (a, b) {
      return String(a.createdAt) < String(b.createdAt) ? -1 : String(a.createdAt) > String(b.createdAt) ? 1 : 0;
    });
    return out.concat(extras);
  }

  function isRewardPurchasable(reward) {
    if (!reward) return false;
    if (reward.retiredAt) return false;
    if (reward.available === false) return false;
    return true;
  }

  // ---------------------------------------------------------------------
  // Purchasing
  // ---------------------------------------------------------------------

  function balanceOf(student) {
    return isFiniteNumber(student && student.wildcatCashBalance) ? student.wildcatCashBalance : 0;
  }

  /**
   * Refusals are specific on purpose. "Cannot purchase" sends a staff member
   * to debug the store; "needs $250 more" sends them to the student.
   */
  function canPurchase(opts) {
    var o = opts || {};
    var student = o.student;
    var reward = o.reward;
    var quantity = isFiniteNumber(o.quantity) ? o.quantity : 1;

    if (!student) return { allowed: false, reason: 'Student not found.' };
    if (!reward) return { allowed: false, reason: 'Reward not found.' };
    if (quantity < 1 || Math.floor(quantity) !== quantity) {
      return { allowed: false, reason: 'Quantity must be a whole number of one or more.' };
    }
    if (reward.retiredAt) return { allowed: false, reason: 'That reward has been retired.' };
    if (reward.available === false) {
      return { allowed: false, reason: 'That reward is not currently available.' };
    }
    if (reward.stock != null && reward.stock < quantity) {
      return {
        allowed: false,
        reason: reward.stock === 0
          ? 'That reward is out of stock.'
          : 'Only ' + reward.stock + ' left in stock.'
      };
    }

    var total = reward.cost * quantity;
    var balance = balanceOf(student);
    if (balance < total) {
      return {
        allowed: false,
        reason: 'Not enough Wildcat Cash. Balance is $' + balance +
                ', this costs $' + total + '. Short by $' + (total - balance) + '.',
        shortfall: total - balance
      };
    }
    return { allowed: true, total: total };
  }

  /**
   * Builds the receipt and the transaction request for a purchase.
   *
   * Returns { ok, receipt, transactionRequest, stockAfter } or { ok:false, reason }.
   * Deliberately does NOT apply anything: the caller hands transactionRequest
   * to recordCashTransaction so that every movement of money still goes
   * through the one writer, and the receipt is appended by the caller.
   */
  function buildPurchase(opts) {
    var o = opts || {};
    var verdict = canPurchase(o);
    if (!verdict.allowed) return { ok: false, reason: verdict.reason, shortfall: verdict.shortfall };

    var student = o.student;
    var reward = o.reward;
    var quantity = isFiniteNumber(o.quantity) ? o.quantity : 1;
    var now = isFiniteNumber(o.now) ? o.now : Date.now();
    var actor = o.actor || {};
    var channel = o.channel === 'student' ? 'student' : 'staff';
    var total = reward.cost * quantity;
    var iso = new Date(now).toISOString();
    var grade = trimmed(student.grade);
    var gradeNum = parseInt(grade, 10);

    var receipt = {
      id: makeReceiptCode(o.rand),
      studentId: student.id,
      studentName: trimmed(student.firstName + ' ' + student.lastName),
      studentGrade: grade,
      school: gradeNum >= 9 ? 'High School' : 'Middle School',

      rewardId: reward.id,
      // Snapshot. The reward may be renamed or repriced tomorrow; this
      // receipt must always say what was actually bought and paid.
      rewardName: reward.name,
      rewardCategory: reward.category || 'General',
      unitCost: reward.cost,
      quantity: quantity,
      totalCost: total,

      purchasedAt: iso,
      purchasedBy: {
        id: trimmed(actor.id),
        name: trimmed(actor.name || actor.username) || 'Unknown',
        username: trimmed(actor.username),
        role: trimmed(actor.role)
      },
      channel: channel,

      status: 'issued',
      fulfilledAt: null,
      fulfilledBy: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      // The merge stamp. Null on a new receipt because an insert has nothing
      // to beat; every LATER change to this row must set it. See applyFulfill.
      updatedAt: null,
      // Filled in by the caller once recordCashTransaction returns, so the
      // receipt and the ledger row can always be matched to each other.
      txId: null,
      refundTxId: null
    };

    var transactionRequest = {
      student: student,
      amount: -total,
      behaviorId: 'reward:' + reward.id,
      behaviorName: reward.name,
      notes: 'Reward purchase ' + receipt.id +
             (quantity > 1 ? ' (x' + quantity + ')' : '') +
             (channel === 'student' ? ' [self-serve]' : ''),
      kind: 'redeem'
    };

    return {
      ok: true,
      receipt: receipt,
      transactionRequest: transactionRequest,
      stockAfter: reward.stock == null ? null : reward.stock - quantity
    };
  }

  // ---------------------------------------------------------------------
  // Fulfillment
  // ---------------------------------------------------------------------

  function canFulfill(receipt) {
    if (!receipt) return { allowed: false, reason: 'Receipt not found.' };
    if (receipt.status === 'fulfilled') {
      return { allowed: false, reason: 'That receipt was already fulfilled on ' + receipt.fulfilledAt + '.' };
    }
    if (receipt.status === 'cancelled') {
      return { allowed: false, reason: 'That receipt was cancelled and cannot be fulfilled.' };
    }
    if (receipt.status !== 'issued') {
      return { allowed: false, reason: 'That receipt is not open.' };
    }
    return { allowed: true };
  }

  /**
   * Hand the item over. Returns a NEW receipt; the caller replaces.
   *
   * THE BUG THIS FIXES. This set status, fulfilledAt and fulfilledBy, and the
   * fulfilment then silently did not persist -- the receipt was back to
   * "issued" on the next load, so the desk was told to hand over an item it
   * had already handed over.
   *
   * cashReceipts is saved with mergeLegacySlice(..., 'id'), and
   * legacyData.touchedAt decides a same-id collision from the LATEST of
   * updatedAt / loopClosedAt / closedAt / submittedAt only. fulfilledAt is
   * not on that list. So the incoming fulfilled row scored 0, the stored
   * issued row scored 0, `incoming > stored` was false, and the server kept
   * the issued copy. Then the loader's union takes the server's copy for any
   * id it already has, and the fulfilment was gone with no error anywhere.
   *
   * This is the second time this exact bug has been written here: retireReward
   * set only retiredAt and rewards un-retired themselves on reload. Any new
   * field that records a state change on a row saved by id needs updatedAt
   * set alongside it, or it does not survive the trip.
   */
  function applyFulfill(receipt, now, actor) {
    var next = {};
    for (var k in receipt) if (Object.prototype.hasOwnProperty.call(receipt, k)) next[k] = receipt[k];
    next.status = 'fulfilled';
    next.fulfilledAt = new Date(now).toISOString();
    next.fulfilledBy = trimmed(actor && (actor.name || actor.username)) || 'Unknown';
    next.updatedAt = next.fulfilledAt;
    return next;
  }

  function canCancel(receipt) {
    if (!receipt) return { allowed: false, reason: 'Receipt not found.' };
    if (TERMINAL_RECEIPT_STATES.indexOf(receipt.status) !== -1) {
      return {
        allowed: false,
        reason: receipt.status === 'fulfilled'
          ? 'That receipt was already fulfilled. Cancelling it would not return the item.'
          : 'That receipt was already cancelled.'
      };
    }
    return { allowed: true };
  }

  /**
   * How far before the cutoff a purchase may be dated and still be refunded.
   * Matches CUTOFF_SLACK_MS in convex/cashReversalRules.ts and
   * HISTORY_CUTOFF_SLACK_MS in script.js: a device with a slightly wrong clock
   * must not cost a student a refund they are actually owed.
   */
  var REFUND_CUTOFF_SLACK_MS = 3600000;

  /**
   * May cancelling this receipt hand the money back?
   *
   * THE INCIDENT, and it is the reason this function exists. Receipt
   * WC-XPSGVE was a $1,000 Homework Pass bought 2026-09-10. Every balance in
   * the school was cleared on 2026-09-13, so that $1,000 was no longer
   * deducted from anybody. Cancelling the receipt on 2026-09-14 refunded the
   * full $1,000 regardless -- money that had never been taken. The owner's
   * account of it is the plainest statement of the bug: "I made that refund by
   * cancelling a receipt from a test. The refund should not have been
   * processed to her."
   *
   * convex/cashReversalRules.ts ALREADY refuses to reverse a row from before
   * the cutoff, in almost these words and for exactly this reason. The rule
   * was not missing -- it had only ever been applied to ONE of the two paths
   * that hand money back. This is the other one.
   *
   * THE CANCELLATION IS STILL ALLOWED. A receipt that should not stand must
   * not be forced to stay open just because its refund is refused, and the
   * item genuinely was not collected. The caller is told instead, so a screen
   * can say "cancelled, not refunded, and here is why" rather than claiming a
   * refund that never happened -- which is the mistake the toast below this
   * one was already written to avoid.
   */
  function cancelRefundVerdict(receipt, historyCutoffMs) {
    if (!receipt) return { allowed: false, code: 'no_receipt', reason: 'Receipt not found.' };
    var total = Number(receipt.totalCost);
    if (!isFiniteNumber(total) || total === 0) {
      return {
        allowed: false, code: 'nothing_to_refund',
        reason: 'That receipt records no cost, so there is nothing to refund.'
      };
    }
    // An UNKNOWN cutoff permits the refund, which is the same call
    // cashReversalRules makes: with no boundary there is nothing to compare a
    // date against, and refusing every refund in the school because one
    // setting is absent would be a worse fault than the one being guarded.
    if (!isFiniteNumber(historyCutoffMs)) return { allowed: true };
    var t = Date.parse(String(receipt.purchasedAt || ''));
    // An UNDATED receipt cannot be proved to be on the safe side of the
    // boundary. Unlike pruning -- where keeping an undated row is the cautious
    // choice -- here the cautious choice is to refuse: pruning wrongly loses a
    // record, refunding wrongly invents money.
    if (!isFinite(t)) {
      return {
        allowed: false, code: 'undated',
        reason: 'That receipt has no usable purchase date, so it cannot be shown to be ' +
                'from after the last balance reset. Refunding it might hand back money ' +
                'that was never taken.'
      };
    }
    if (t < historyCutoffMs - REFUND_CUTOFF_SLACK_MS) {
      return {
        allowed: false, code: 'before_reset',
        reason: 'That purchase is from before the last balance reset, so its cost is no ' +
                'longer deducted from any balance. Refunding it would add money that was ' +
                'never taken.'
      };
    }
    return { allowed: true };
  }

  /**
   * Cancelling optionally refunds. The refund is a NEW transaction request,
   * never an edit of the original: the ledger reads forward, and "this was
   * bought then refunded" stays visible instead of becoming "never happened".
   *
   * `opts.historyCutoffMs` is the last balance reset. Pass it: without it the
   * refund cannot be checked against the boundary, and cancelRefundVerdict
   * says why that matters.
   */
  function buildCancel(opts) {
    var o = opts || {};
    var receipt = o.receipt;
    var verdict = canCancel(receipt);
    if (!verdict.allowed) return { ok: false, reason: verdict.reason };

    var now = isFiniteNumber(o.now) ? o.now : Date.now();
    var actor = o.actor || {};
    // Wanted, then allowed. The two are different: a caller asking for a
    // refund that the reset boundary forbids must be told, not quietly obeyed
    // and not quietly ignored.
    var refundWanted = o.refund !== false;
    var refundVerdict = refundWanted
      ? cancelRefundVerdict(receipt, o.historyCutoffMs)
      : { allowed: false, code: 'not_requested', reason: 'No refund was requested.' };
    var refund = refundWanted && refundVerdict.allowed;

    var next = {};
    for (var k in receipt) if (Object.prototype.hasOwnProperty.call(receipt, k)) next[k] = receipt[k];
    next.status = 'cancelled';
    next.cancelledAt = new Date(now).toISOString();
    next.cancelledBy = trimmed(actor.name || actor.username) || 'Unknown';
    next.cancelReason = trimmed(o.reason) || 'No reason given';
    // Same reason as applyFulfill, and the stakes are higher here: the refund
    // is a separate ledger row carrying its own id, so it inserts and sticks
    // whatever happens to this one. A cancellation that did not persist left
    // the student refunded AND the receipt still open to collect against.
    next.updatedAt = next.cancelledAt;

    var transactionRequest = null;
    if (refund && o.student) {
      transactionRequest = {
        student: o.student,
        amount: receipt.totalCost,
        behaviorId: 'reward-refund:' + receipt.rewardId,
        behaviorName: 'Refund: ' + receipt.rewardName,
        notes: 'Cancelled receipt ' + receipt.id + '. ' + next.cancelReason,
        kind: 'award'
      };
    }
    return {
      ok: true, receipt: next, transactionRequest: transactionRequest,
      refunded: !!transactionRequest,
      // Non-null ONLY when a refund was asked for and refused, so a caller can
      // tell "refused, and here is why" from "nobody asked" and from "asked,
      // allowed, but no student record matched".
      refundRefused: (refundWanted && !refundVerdict.allowed) ? refundVerdict : null
    };
  }

  // ---------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------

  /**
   * Which rewards actually move. Cancelled receipts are excluded by default:
   * a purchase that was refunded is not evidence of demand.
   */
  function rewardPopularity(receipts, opts) {
    var o = opts || {};
    var includeCancelled = o.includeCancelled === true;
    var byReward = {};

    (receipts || []).forEach(function (r) {
      if (!r) return;
      if (!includeCancelled && r.status === 'cancelled') return;
      var key = r.rewardId || r.rewardName;
      if (!byReward[key]) {
        byReward[key] = {
          rewardId: r.rewardId,
          rewardName: r.rewardName,
          category: r.rewardCategory || 'General',
          purchases: 0, units: 0, revenue: 0,
          fulfilled: 0, outstanding: 0, cancelled: 0,
          students: {}
        };
      }
      var e = byReward[key];
      e.purchases += 1;
      e.units += isFiniteNumber(r.quantity) ? r.quantity : 1;
      e.revenue += isFiniteNumber(r.totalCost) ? r.totalCost : 0;
      if (r.status === 'fulfilled') e.fulfilled += 1;
      else if (r.status === 'issued') e.outstanding += 1;
      else if (r.status === 'cancelled') e.cancelled += 1;
      if (r.studentId) e.students[r.studentId] = true;
    });

    return Object.keys(byReward).map(function (k) {
      var e = byReward[k];
      e.uniqueStudents = Object.keys(e.students).length;
      delete e.students;
      return e;
    }).sort(function (a, b) {
      // Units first: two purchases of five beats five purchases of one for
      // "what do we need to stock". Revenue breaks the tie.
      if (b.units !== a.units) return b.units - a.units;
      return b.revenue - a.revenue;
    });
  }

  /** Everything a fulfillment desk needs in one pass over the receipts. */
  function receiptSummary(receipts) {
    var out = { total: 0, issued: 0, fulfilled: 0, cancelled: 0, outstandingValue: 0, spentValue: 0 };
    (receipts || []).forEach(function (r) {
      if (!r) return;
      out.total += 1;
      if (r.status === 'issued') {
        out.issued += 1;
        out.outstandingValue += isFiniteNumber(r.totalCost) ? r.totalCost : 0;
      } else if (r.status === 'fulfilled') {
        out.fulfilled += 1;
      } else if (r.status === 'cancelled') {
        out.cancelled += 1;
      }
      if (r.status !== 'cancelled') out.spentValue += isFiniteNumber(r.totalCost) ? r.totalCost : 0;
    });
    return out;
  }

  function findReceipt(receipts, idOrCode) {
    var needle = trimmed(idOrCode).toUpperCase();
    if (!needle) return null;
    var hit = null;
    (receipts || []).forEach(function (r) {
      if (!hit && r && trimmed(r.id).toUpperCase() === needle) hit = r;
    });
    return hit;
  }

  // ---------------------------------------------------------------------
  // Start of year rollover
  // ---------------------------------------------------------------------

  /**
   * The school year a date falls in, as "2026-2027".
   *
   * Rolls in July, not January: a year that flipped on 1 January would put the
   * autumn and spring halves of one school year in different buckets.
   *
   * LOCAL time, deliberately. A school year boundary is a calendar fact about
   * where the school is, not a UTC instant. Reading UTC months here would put
   * an evening in late June into the next school year for anywhere behind UTC,
   * which includes this one.
   */
  function schoolYearOf(now) {
    var d = new Date(now);
    var y = d.getFullYear();
    // Month is 0-based; 6 is July.
    return d.getMonth() >= 6 ? y + '-' + (y + 1) : (y - 1) + '-' + y;
  }

  /**
   * What closing the year does, computed but NOT applied.
   *
   * Returns { summary, studentPatches, counts }. The caller applies the
   * patches, archives what it wants and clears the live arrays, so this stays
   * testable and so nothing is destroyed by asking what would happen.
   *
   * WHY A SUMMARY RATHER THAN THE WHOLE LEDGER.
   *
   * The full transactions and receipts go to the dated backup the app already
   * writes. Keeping a second full copy inside the live document would grow it
   * without bound, one school year at a time, and that document is read on
   * every page load. What stays in the app is a per-student closing balance,
   * which is what anybody actually asks for later: "what did this child end
   * the year with". It is small, and it is the answer.
   *
   * OUTSTANDING RECEIPTS ARE COUNTED, NOT SILENTLY DROPPED. A receipt is a
   * promise of an item. If eleven of them are unfulfilled when the year
   * closes, somebody should see that number before agreeing to close, not
   * discover it when a student turns up in September with a code.
   */
  function buildYearEndRollover(opts) {
    var o = opts || {};
    var students = o.students || [];
    var transactions = o.transactions || [];
    var receipts = o.receipts || [];
    var now = isFiniteNumber(o.now) ? o.now : Date.now();
    var actor = o.actor || {};
    var year = trimmed(o.schoolYear) || schoolYearOf(now);

    var totals = {
      students: 0,
      studentsWithBalance: 0,
      totalBalance: 0,
      totalEarned: 0,
      totalSpent: 0,
      totalDeducted: 0,
      transactions: transactions.length,
      receiptsOutstanding: 0,
      receiptsFulfilled: 0,
      receiptsCancelled: 0
    };

    var closingBalances = [];
    var studentPatches = [];

    students.forEach(function (s) {
      if (!s) return;
      var bal = isFiniteNumber(s.wildcatCashBalance) ? s.wildcatCashBalance : 0;
      var earned = isFiniteNumber(s.wildcatCashEarned) ? s.wildcatCashEarned : 0;
      var spent = isFiniteNumber(s.wildcatCashSpent) ? s.wildcatCashSpent : 0;
      var deducted = isFiniteNumber(s.wildcatCashDeducted) ? s.wildcatCashDeducted : 0;

      totals.students += 1;
      if (bal !== 0) totals.studentsWithBalance += 1;
      totals.totalBalance += bal;
      totals.totalEarned += earned;
      totals.totalSpent += spent;
      totals.totalDeducted += deducted;

      // Recorded for EVERY student, including those ending on zero. A student
      // missing from the record is indistinguishable from one who was never
      // looked at.
      closingBalances.push({
        studentId: s.id,
        studentNumber: s.studentNumber || null,
        name: trimmed((s.firstName || '') + ' ' + (s.lastName || '')),
        grade: s.grade || null,
        balance: bal, earned: earned, spent: spent, deducted: deducted
      });

      studentPatches.push({
        studentId: s.id,
        wildcatCashBalance: 0,
        wildcatCashEarned: 0,
        wildcatCashSpent: 0,
        wildcatCashDeducted: 0,
        wildcatCashTransactions: [],
        wildcatCashRewardsRedeemed: []
      });
    });

    receipts.forEach(function (r) {
      if (!r) return;
      if (r.status === 'issued') totals.receiptsOutstanding += 1;
      else if (r.status === 'fulfilled') totals.receiptsFulfilled += 1;
      else if (r.status === 'cancelled') totals.receiptsCancelled += 1;
    });

    return {
      summary: {
        schoolYear: year,
        closedAt: new Date(now).toISOString(),
        closedBy: trimmed(actor.name || actor.username) || 'Unknown',
        backupRef: o.backupRef || null,
        totals: totals,
        closingBalances: closingBalances
      },
      studentPatches: studentPatches,
      counts: totals
    };
  }

  root.WildcatStore = {
    schoolYearOf: schoolYearOf,
    buildYearEndRollover: buildYearEndRollover,
    RECEIPT_STATES: RECEIPT_STATES,
    TERMINAL_RECEIPT_STATES: TERMINAL_RECEIPT_STATES,
    makeReceiptCode: makeReceiptCode,
    validateReward: validateReward,
    normalizeReward: normalizeReward,
    applyRewardEdit: applyRewardEdit,
    retireReward: retireReward,
    isRewardPurchasable: isRewardPurchasable,
    validateBehavior: validateBehavior,
    normalizeBehavior: normalizeBehavior,
    retireBehavior: retireBehavior,
    mergeBehaviorLists: mergeBehaviorLists,
    canPurchase: canPurchase,
    buildPurchase: buildPurchase,
    canFulfill: canFulfill,
    applyFulfill: applyFulfill,
    canCancel: canCancel,
    buildCancel: buildCancel,
    cancelRefundVerdict: cancelRefundVerdict,
    rewardPopularity: rewardPopularity,
    receiptSummary: receiptSummary,
    findReceipt: findReceipt
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
