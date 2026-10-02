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
    if (patch && 'campus' in patch && patch.campus != null && patch.campus !== '' &&
        rewardCampusOf({ campus: patch.campus }) === null) {
      errors.push('Campus must be everyone, Middle School or High School.');
    }
    if (patch && typeof patch.purchaseMessage === 'string' &&
        patch.purchaseMessage.trim().length > PURCHASE_MESSAGE_MAX) {
      errors.push('The purchase message must be ' + PURCHASE_MESSAGE_MAX + ' characters or fewer.');
    }
    if (patch && patch.limitPerStudent != null && patch.limitPerStudent !== '') {
      var lim = patch.limitPerStudent;
      if (!isFiniteNumber(lim) || lim < 1 || Math.floor(lim) !== lim) {
        errors.push('Limit per student must be a whole number of 1 or more, or left blank for no limit.');
      }
    }
    return { ok: errors.length === 0, errors: errors };
  }

  // ---------------------------------------------------------------------
  // Campus and per-student limits
  //
  // THE SAME RULES AS convex/studentStoreRules.ts (rewardCampus, studentCampus,
  // rewardLimit, ownedUnits), duplicated because there is no bundler, and
  // pinned against each other by convex/studentStore.test.mjs section 7.
  // Asked for on 2026-09-27 for the Power-Up Pass: "Middle school should only
  // be able to buy Middle school", and one per student.
  // ---------------------------------------------------------------------
  var CAMPUSES = ['all', 'middle', 'high'];

  /** Same cap as convex/studentStoreRules.ts PURCHASE_MESSAGE_MAX. */
  var PURCHASE_MESSAGE_MAX = 500;

  /** 'all' | 'middle' | 'high', or null for a value that is not a campus. */
  function rewardCampusOf(reward) {
    var raw = reward && reward.campus;
    if (raw === undefined || raw === null || raw === '') return 'all';
    var v = String(raw).trim().toLowerCase();
    return CAMPUSES.indexOf(v) !== -1 ? v : null;
  }

  /** Grades 6-8 are the middle school, 9-12 the high school; else unknown. */
  function studentCampusOf(grade) {
    var n = parseInt(String(grade == null ? '' : grade).trim(), 10);
    if (!isFinite(n)) return null;
    if (n >= 9 && n <= 12) return 'high';
    if (n >= 6 && n <= 8) return 'middle';
    return null;
  }

  /** The limit, null for none, or undefined for a value that is not one. */
  function rewardLimitOf(reward) {
    var raw = reward && reward.limitPerStudent;
    if (raw === undefined || raw === null || raw === '') return null;
    var n = Number(raw);
    if (!isFinite(n) || Math.floor(n) !== n || n < 1) return undefined;
    return n;
  }

  /** Units of a reward a student holds on receipts that were not cancelled. */
  function ownedUnits(receipts, studentId, rewardId) {
    var who = String(studentId == null ? '' : studentId);
    var what = String(rewardId == null ? '' : rewardId);
    if (!who || !what) return 0;
    var n = 0;
    (receipts || []).forEach(function (r) {
      if (!r || String(r.studentId == null ? '' : r.studentId) !== who) return;
      if (String(r.rewardId == null ? '' : r.rewardId) !== what) return;
      if (r.status === 'cancelled') return;
      var q = Number(r.quantity);
      n += isFinite(q) && q > 0 ? q : 1;
    });
    return n;
  }

  function campusName(c) {
    return c === 'high' ? 'High School' : c === 'middle' ? 'Middle School' : 'everyone';
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
      // Whether a STUDENT may buy it themselves. Absent is false, the same
      // default as the server's: nothing becomes self-serve by accident.
      studentPurchasable: r.studentPurchasable === true,
      // Stored as the normalised word, or kept as-is when it is not a campus
      // so the server refuses it loudly instead of this quietly "fixing" it.
      campus: rewardCampusOf(r) === null ? r.campus : rewardCampusOf(r),
      limitPerStudent: rewardLimitOf(r) === undefined ? r.limitPerStudent : rewardLimitOf(r),
      // Whether the other campus may SEE a campus-only reward (never buy it).
      showOtherCampus: r.showOtherCampus === true,
      // What a buyer is told after buying. Null when there is none.
      purchaseMessage: (typeof r.purchaseMessage === 'string' && r.purchaseMessage.trim())
        ? r.purchaseMessage.trim() : null,
      // WHEN A PERSON LAST TYPED A STOCK NUMBER. The server keeps its own
      // count for a student-store reward unless this is newer than what it
      // holds (legacyData keepServerStock), so an edit from a tab that loaded
      // hours ago cannot put sold passes back on the shelf.
      stockSetAt: r.stockSetAt || null,
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
    // STOCK ONLY WHEN THE PATCH CARRIES IT, and then it is stamped as a
    // deliberate number. A caller that did not change stock must leave it out
    // of the patch, or it will overrule the server's count. See stockSetAt.
    if (patch && 'stock' in patch) {
      next.stock = patch.stock == null ? null : patch.stock;
      next.stockSetAt = new Date(now).toISOString();
    }
    if (patch && 'available' in patch) next.available = patch.available !== false;
    if (patch && 'studentPurchasable' in patch) next.studentPurchasable = patch.studentPurchasable === true;
    if (patch && 'campus' in patch) {
      next.campus = (patch.campus == null || patch.campus === '') ? 'all' : String(patch.campus).trim().toLowerCase();
    }
    if (patch && 'showOtherCampus' in patch) next.showOtherCampus = patch.showOtherCampus === true;
    if (patch && 'purchaseMessage' in patch) {
      next.purchaseMessage = (typeof patch.purchaseMessage === 'string' && patch.purchaseMessage.trim())
        ? patch.purchaseMessage.trim() : null;
    }
    if (patch && 'limitPerStudent' in patch) {
      next.limitPerStudent = (patch.limitPerStudent == null || patch.limitPerStudent === '')
        ? null : patch.limitPerStudent;
    }

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

    // THE CAMPUS AND THE LIMIT, the same rules the student store enforces on
    // the server, so buying it at the office is not a way around either.
    var forCampus = rewardCampusOf(reward);
    if (forCampus === null) {
      return { allowed: false, reason: 'That reward\'s campus setting is not valid. Edit the reward first.' };
    }
    if (forCampus !== 'all') {
      var theirs = studentCampusOf(student.grade);
      if (theirs === null) {
        return { allowed: false, reason: 'That reward is for ' + campusName(forCampus) +
          ' only, and this student\'s grade does not say which campus they are on.' };
      }
      if (theirs !== forCampus) {
        return { allowed: false, reason: 'That reward is for ' + campusName(forCampus) +
          ' students only. This student is in grade ' + trimmed(student.grade) + '.' };
      }
    }
    var limit = rewardLimitOf(reward);
    if (limit === undefined) {
      return { allowed: false, reason: 'That reward\'s per-student limit is not valid. Edit the reward first.' };
    }
    if (limit !== null) {
      var owned = ownedUnits(o.receipts, student.id, reward.id);
      if (owned + quantity > limit) {
        return {
          allowed: false,
          reason: owned >= limit
            ? 'This student already has ' + (owned === 1 ? 'one' : owned) + '. The limit is ' +
              limit + ' per student.'
            : 'The limit is ' + limit + ' per student; they can have ' + (limit - owned) + ' more.'
        };
      }
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

  /**
   * When a receipt was last changed, by the SERVER'S rule (legacyData
   * touchedAt): the latest of updatedAt / loopClosedAt / closedAt /
   * submittedAt. 0 when none is readable.
   */
  function receiptTouched(r) {
    var best = 0;
    var fields = ['updatedAt', 'loopClosedAt', 'closedAt', 'submittedAt'];
    for (var i = 0; i < fields.length; i++) {
      var t = r && r[fields[i]] ? Date.parse(r[fields[i]]) : NaN;
      if (isFinite(t) && t > best) best = t;
    }
    return best;
  }

  /**
   * updatedAt for a change to `receipt`: ALWAYS NEWER THAN THE COPY BEING
   * CHANGED, whatever this device's clock says (review, 2026-10-02). The
   * server keeps a same-id receipt only if its stamp is later, so a
   * Chromebook running a few minutes slow had its Cancel silently thrown away
   * -- while the refund, a separate ledger row, stayed -- and a second Cancel
   * paid the refund again. retireBehavior learned this first.
   */
  function stampAfter(receipt, now) {
    return new Date(Math.max(now, receiptTouched(receipt) + 1)).toISOString();
  }

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
    next.updatedAt = stampAfter(receipt, now);
    return next;
  }

  // ---------------------------------------------------------------------
  // Taking a handover back (2026-10-02)
  //
  // The owner: "I need a way to unfulfill something in the store. I want to
  // refund a student her money since the power up pass event was cancelled
  // for middle school." A fulfilled receipt is terminal, and canCancel
  // refuses it on purpose -- cancelling a handed-over item would refund money
  // without the item coming back. When the thing bought turns out not to
  // happen at all (a cancelled event), or the receipt was marked handed over
  // by mistake, an admin needs the receipt open again.
  //
  // UNFULFIL ONLY REOPENS. It moves no money and does not cancel: the receipt
  // goes back to 'issued' (Awaiting pickup), and the refund, if one is due,
  // is the existing Cancel -- with its reset-boundary check and its single
  // refund row. One path hands money back, not two.
  //
  // NOTHING IS ERASED. Each undo appends {at, by, reason, wasFulfilledAt,
  // wasFulfilledBy} to `unfulfilled`, so "handed over by X at Y, taken back
  // by Z because ..." stays on the receipt.
  // ---------------------------------------------------------------------

  function canUnfulfill(receipt) {
    if (!receipt) return { allowed: false, reason: 'Receipt not found.' };
    if (receipt.status === 'issued') {
      return { allowed: false, reason: 'That receipt has not been handed over yet, so there is nothing to undo.' };
    }
    if (receipt.status === 'cancelled') {
      return { allowed: false, reason: 'That receipt was cancelled.' };
    }
    if (receipt.status !== 'fulfilled') {
      return { allowed: false, reason: 'That receipt is not marked as handed over.' };
    }
    return { allowed: true };
  }

  /**
   * Reopen a handed-over receipt. Returns a NEW receipt; the caller replaces.
   * updatedAt moves with it for the reason applyFulfill gives -- a state change
   * on a row saved by id that does not bump updatedAt is silently undone by
   * the server's merge on the next load -- and is always later than the copy
   * it replaces (stampAfter).
   */
  function applyUnfulfill(receipt, now, actor, reason) {
    var next = {};
    for (var k in receipt) if (Object.prototype.hasOwnProperty.call(receipt, k)) next[k] = receipt[k];
    var at = new Date(now).toISOString();
    var history = Array.isArray(receipt.unfulfilled) ? receipt.unfulfilled.slice() : [];
    history.push({
      at: at,
      by: trimmed(actor && (actor.name || actor.username)) || 'Unknown',
      reason: trimmed(reason) || 'No reason given',
      wasFulfilledAt: receipt.fulfilledAt || null,
      wasFulfilledBy: receipt.fulfilledBy || null
    });
    next.unfulfilled = history;
    next.status = 'issued';
    next.fulfilledAt = null;
    next.fulfilledBy = null;
    next.updatedAt = stampAfter(receipt, now);
    return next;
  }

  /**
   * The receipt list a tab should hold, from the server's and its own: union
   * by id, and where both hold a receipt, THE SERVER'S RULE (final review,
   * 2026-10-02) -- a cancelled copy beats any copy that is not, whatever the
   * stamps say; otherwise the later-touched copy, the server's on a tie. The
   * server refuses to reopen a cancelled receipt, but a tab that merged by
   * stamp alone kept its own later "fulfilled" copy for ever, and from that
   * tab Unfulfil then Cancel refunded the purchase a second time.
   */
  function mergeReceipts(server, local) {
    var byId = {}, order = [], loose = [];
    function take(rows, isServer) {
      (rows || []).forEach(function (r) {
        if (!r) return;
        var id = trimmed(r.id);
        if (!id) { loose.push(r); return; }
        if (!Object.prototype.hasOwnProperty.call(byId, id)) { byId[id] = r; order.push(id); return; }
        var have = byId[id];
        var haveC = have.status === 'cancelled', newC = r.status === 'cancelled';
        if (haveC !== newC) { if (newC) byId[id] = r; return; }
        // Same terminal-ness: the later-touched copy; the server's on a tie
        // (the server's copies are taken first).
        if (receiptTouched(r) > receiptTouched(have)) byId[id] = r;
      });
    }
    take(server, true);
    take(local, false);
    return order.map(function (id) { return byId[id]; }).concat(loose);
  }

  /**
   * The refund already made for a receipt, if any, from ledger rows (final
   * review, 2026-10-02). A cancel's refund is its own ledger row and sticks
   * even when the cancelled receipt does not -- two admins at once, a desk
   * handing over at the same moment -- so the receipt's status alone cannot
   * say whether the money already went back. buildCancel writes the row as
   * behaviorId 'reward-refund:<reward>' with notes 'Cancelled receipt <id>. ...'.
   */
  function existingReceiptRefund(receiptId, rows) {
    var id = trimmed(receiptId);
    if (!id) return null;
    var prefix = 'Cancelled receipt ' + id + '.';
    var list = rows || [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t) continue;
      if (String(t.behaviorId || '').indexOf('reward-refund:') !== 0) continue;
      if (String(t.notes || '').indexOf(prefix) !== 0) continue;
      return { id: t.id || null, at: t.timestamp || null, amount: t.amount };
    }
    return null;
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
    next.updatedAt = stampAfter(receipt, now);

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

  /**
   * The newest purchases for the Rewards Store's "Recent Redemptions" box,
   * newest first.
   *
   * FROM THE RECEIPTS, which every sale writes -- office and student store
   * alike. The box used to read each student's wildcatCashRewardsRedeemed,
   * which only an office sale writes (studentStore.ts never has), so on
   * 2026-09-29 it showed none of the 25 Power-Up Pass sales and read as
   * though they had not gone through. Older office sales that predate
   * receipts still appear, from that list, when no receipt carries the same
   * id. Cancelled receipts stay, marked refunded or NOT refunded, because
   * that is part of what happened.
   */
  function recentRedemptions(receipts, students, limit) {
    var max = isFiniteNumber(limit) && limit > 0 ? limit : 20;
    var out = [];
    var seen = {};
    (receipts || []).forEach(function (r) {
      if (!r || !r.id) return;
      seen[r.id] = true;
      out.push({
        id: r.id,
        studentName: r.studentName || '',
        rewardName: r.rewardName || '',
        quantity: isFiniteNumber(r.quantity) ? r.quantity : 1,
        cost: isFiniteNumber(r.totalCost) ? r.totalCost : 0,
        at: r.purchasedAt || '',
        by: r.channel === 'student' ? 'Student store' : ((r.purchasedBy && r.purchasedBy.name) || ''),
        cancelled: r.status === 'cancelled',
        // A cancel does not always refund (before a reset, undated, no
        // matching student, or a refund later withdrawn), and refundTxId is
        // the only thing that says one happened.
        refunded: r.status === 'cancelled' && !!r.refundTxId
      });
    });
    (students || []).forEach(function (s) {
      var list = s && Array.isArray(s.wildcatCashRewardsRedeemed) ? s.wildcatCashRewardsRedeemed : [];
      list.forEach(function (x) {
        if (!x || (x.receiptId && seen[x.receiptId])) return;
        out.push({
          id: x.receiptId || '',
          studentName: ((s.firstName || '') + ' ' + (s.lastName || '')).trim(),
          rewardName: x.rewardName || '',
          quantity: isFiniteNumber(x.quantity) ? x.quantity : 1,
          cost: isFiniteNumber(x.cost) ? x.cost : 0,
          at: x.timestamp || '',
          by: x.redeemedBy || '',
          cancelled: false,
          refunded: false
        });
      });
    });
    var time = function (e) { var t = Date.parse(e.at); return isFinite(t) ? t : 0; };
    out.sort(function (a, b) { return time(b) - time(a); });
    return out.slice(0, max);
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
    rewardCampusOf: rewardCampusOf,
    studentCampusOf: studentCampusOf,
    rewardLimitOf: rewardLimitOf,
    ownedUnits: ownedUnits,
    campusName: campusName,
    PURCHASE_MESSAGE_MAX: PURCHASE_MESSAGE_MAX,
    canPurchase: canPurchase,
    buildPurchase: buildPurchase,
    canFulfill: canFulfill,
    applyFulfill: applyFulfill,
    canUnfulfill: canUnfulfill,
    mergeReceipts: mergeReceipts,
    existingReceiptRefund: existingReceiptRefund,
    receiptTouched: receiptTouched,
    applyUnfulfill: applyUnfulfill,
    canCancel: canCancel,
    buildCancel: buildCancel,
    cancelRefundVerdict: cancelRefundVerdict,
    rewardPopularity: rewardPopularity,
    recentRedemptions: recentRedemptions,
    receiptSummary: receiptSummary,
    findReceipt: findReceipt
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
