/**
 * Discipline analytics: what the referral data says, broken down.
 *
 * Pure. No DOM, no network, no clock of its own. Split out for the same reason
 * convex/restrictedPolicy.ts is: some of this concerns protected student
 * characteristics, and a number that is wrong here is a number somebody makes
 * a decision about a child with.
 *
 * ============================================================
 * THE ONE THING THAT MATTERS MOST: RATES, NOT COUNTS.
 * ============================================================
 *
 * A count of referrals by race is not a finding. If 62% of the school is
 * Hispanic, then 62% of referrals being Hispanic is exactly proportionate, and
 * a bar chart of raw counts would show a tall bar and invite the reader to
 * conclude something that is not there. That mistake is worse than showing
 * nothing, because it is a confident wrong answer about children.
 *
 * Every demographic breakdown here therefore reports THREE numbers:
 *
 *   share of referrals    what fraction of referrals this group received
 *   share of enrolment    what fraction of the school this group is
 *   representation index  the first divided by the second
 *
 * An index of 1.0 is exactly proportionate. 2.0 means a group is referred at
 * twice the rate its enrolment would predict. That is the number a discipline
 * review actually acts on, and it is what OCR-style disproportionality
 * reporting asks for.
 *
 * Without an enrolment denominator this file REFUSES to compute an index and
 * says so, rather than falling back to counts and letting them read as rates.
 *
 * ============================================================
 * SMALL NUMBERS
 * ============================================================
 *
 * A group of 4 students with 2 referrals produces an index that swings wildly
 * on a single incident, and in a small group a rate can also identify an
 * individual. Every row carries `suppressed` when the group is below a
 * threshold, so the UI can show the count and withhold the ratio rather than
 * publishing noise about a handful of identifiable children.
 */
(function (root) {
  'use strict';

  /** Below this many enrolled students, a rate is noise and may identify. */
  var SMALL_GROUP = 10;

  /**
   * Minimum REFERRALS in a group before a disproportionality index is computed.
   *
   * A DIFFERENT RULE FROM SMALL_GROUP, GUARDING A DIFFERENT AXIS.
   *
   * SMALL_GROUP withholds a whole row when few students are ENROLLED, because
   * a cell that small can identify a child. That is a privacy rule. This one
   * is a statistical rule: it withholds only the ratio when the group has few
   * REFERRALS, because a ratio built on one or two incidents is noise reported
   * to two decimal places.
   *
   * WHY IT HAD TO EXIST. With six referrals in the system and one going to a
   * group that is 7% of the school, the index reads 2.38. With zero it reads
   * 0.00. There is no value in between: the group cannot score near 1.0 no
   * matter what is true, because one referral is 17% of all referrals. The
   * number was reporting the resolution limit of the data as a finding about
   * children, and "referred at 2.4x their share" is exactly the sentence that
   * gets photographed off a slide and repeated without its caveat.
   *
   * 10 matches the enrolment threshold and the usual floor in federal IDEA
   * disproportionality work. California uses 30 for its own determinations, so
   * this is the permissive end of defensible, not the strict end.
   *
   * COUNTS AND SHARES ARE STILL REPORTED. Those are facts. Only the ratio,
   * which is an inference, is withheld.
   */
  var MIN_REFERRALS_FOR_INDEX = 10;

  /**
   * The dimensions a referral can be broken down by, and what each needs.
   *
   * `restricted` marks the fields convex/restrictedPolicy.ts denies to every
   * role today. They are listed rather than hidden: a reader should know the
   * breakdown exists and is withheld, not conclude the school does not track
   * it. The `unblock` text is what a person has to do, not a code change.
   */
  var DIMENSIONS = {
    grade: {
      key: 'grade', label: 'Grade', restricted: false,
      unblock: null
    },
    school: {
      key: 'school', label: 'School', restricted: false,
      unblock: null
    },
    sex: {
      key: 'sex', label: 'Sex', restricted: false,
      // Students.Gender is already ViewOnly in plugin.xml and in the manifest.
      // It is simply not carried onto the app's student record yet, so this
      // needs a sync field, not an approval.
      unblock: 'PowerSchool grants Students.Gender and the sync now carries it onto ' +
               'the student record. If this is empty, the twice-daily sync has not run ' +
               'since that change. It fills in on the next run. Referrals filed before ' +
               'then keep whatever was recorded at the time, which is nothing.'
    },
    race: {
      key: 'race', label: 'Race / Ethnicity', restricted: true,
      // Served by the SERVER, not derived from referral snapshots, so this
      // panel asks convex/disciplineAggregates.ts:byRace rather than looking
      // for a value the browser is deliberately never given.
      serverAggregate: 'disciplineAggregates:byRace',
      unblock: 'Race breakdowns are served by the server so no child\'s race reaches ' +
               'this browser. If this is empty, either the sync has not loaded psRestricted ' +
               'yet or your role is not admin, superadmin or PBIS.'
    },
    iep: {
      key: 'iep', label: 'IEP Status', restricted: true,
      unblock: 'Not available at any level yet. Manifest field 12 has no confirmed source ' +
               'in this PowerSchool instance, so it is not requested and not pulled. ' +
               'The registrar has to say where IEP status lives before it can be.'
    }
  };

  function trimmed(v) {
    return String(v == null ? '' : v).trim();
  }

  function isBlank(v) {
    return trimmed(v) === '';
  }

  // ---------------------------------------------------------------------
  // Capture
  // ---------------------------------------------------------------------

  /**
   * The demographic snapshot to store ON a referral when it is filed.
   *
   * SNAPSHOTTED, not looked up later, for the same reason a receipt records
   * the price paid: a student's grade changes every year, and a referral is a
   * record of an incident on a date. Reading grade off the student record in
   * September would silently relabel last spring's referrals.
   *
   * Only fields actually present are written. A missing value is left ABSENT
   * rather than stored as "Unknown", so coverage can be measured later and a
   * gap never masquerades as a category.
   */
  function snapshotDemographics(student) {
    var s = student || {};
    var out = {};
    if (!isBlank(s.grade)) out.grade = trimmed(s.grade);
    if (!isBlank(s.school)) out.school = trimmed(s.school);
    if (!isBlank(s.sex || s.gender)) out.sex = trimmed(s.sex || s.gender);

    // RACE AND IEP ARE DELIBERATELY NOT SNAPSHOTTED HERE.
    //
    // An earlier revision copied them if present. That would write a child's
    // race into behaviorReferrals, which is the app blob: saved to Firestore,
    // loaded into every staff browser, and readable by anyone who can read a
    // referral. It would take restricted data that lives in one guarded table
    // and scatter copies of it through unguarded storage, which is precisely
    // what the aggregate-only design exists to prevent.
    //
    // Race breakdowns come from convex/disciplineAggregates.ts:byRace, which
    // joins referrals to psRestricted SERVER SIDE, returns counts, and never
    // builds a student row. The browser is never given the value at all.
    return out;
  }

  /**
   * How a stored value is SHOWN. Display only; nothing is rewritten.
   *
   * PowerSchool stores sex as a single letter. "M" on a chart about children
   * is a code, not a label, and a reader has to already know the convention
   * to read the row. The referral still records exactly what the SIS holds.
   *
   * A value outside the known set is passed through UNCHANGED rather than
   * bucketed or relabelled. Districts record more than two values, and
   * collapsing a child into a category the school did not choose is the same
   * class of mistake as reading race codes without asking about ethnicity.
   */
  var SEX_LABELS = { M: 'Male', F: 'Female' };
  function displayValue(dimension, value) {
    var v = trimmed(value);
    if (dimension === 'sex') {
      var hit = SEX_LABELS[v.toUpperCase()];
      if (hit) return hit;
    }
    return v;
  }

  // =====================================================================
  // WHO SEES WHAT IN DISCIPLINE MODE
  //
  // Before this there was NO role gating here at all. Every role reached
  // every tab, and getOpenReferrals returned every referral in the school, so
  // any teacher could read the whole school's discipline record and the
  // demographic breakdowns built from it.
  //
  // The rule, set by the app owner on 2026-08-25:
  //   teacher      submit a referral, and see their OWN open and closed ones
  //   admin/PBIS   every referral, plus history, detention and analytics
  //
  // campusaide is treated as a teacher here. They were not named either way,
  // and the safe default for a discipline record is the narrower one; say so
  // and it changes in one line.
  // =====================================================================

  var DISCIPLINE_ALL_ROLES = ['admin', 'superadmin', 'pbis'];

  /** Roles that read the whole school's discipline record. */
  function seesAllReferrals(role) {
    return DISCIPLINE_ALL_ROLES.indexOf(trimmed(role).toLowerCase()) !== -1;
  }

  /** Subtabs a role may open, in display order. */
  function disciplineTabsFor(role) {
    return seesAllReferrals(role)
      ? ['submit', 'review', 'closed', 'detention', 'history', 'analytics']
      : ['submit', 'review', 'closed'];
  }

  function canOpenDisciplineTab(role, subtab) {
    return disciplineTabsFor(role).indexOf(trimmed(subtab)) !== -1;
  }

  /**
   * Is this referral this person's?
   *
   * MATCHED ON SEVERAL KEYS, NOT ONE, and that is not belt-and-braces.
   * Referrals record `referredByUsername` and `filedByUsername`, and the
   * Convex teacher record HAS NO USERNAME FIELD — deliberately, it is what the
   * migration away from cleartext passwords removed. So for anyone who signs
   * in with Microsoft, which is now everyone, those fields were written as
   * undefined. Matching on username alone would hide a teacher's own referrals
   * from them, which is the opposite of the requirement.
   *
   * `referredBy` is included because it is the ATTRIBUTED staff member, chosen
   * from a dropdown, and may be someone other than whoever typed it. A teacher
   * should see a referral raised in their name as well as one they filed.
   */
  function ownsReferral(referral, user) {
    if (!referral || !user) return false;
    var keys = {};
    [user.username, user.email, user.name, user.id].forEach(function (k) {
      var v = trimmed(k).toLowerCase();
      if (v) keys[v] = true;
    });
    if (!Object.keys(keys).length) return false;
    var fields = [
      referral.filedByUsername, referral.referredByUsername,
      referral.filedByEmail, referral.referredByEmail,
      referral.referredBy
    ];
    for (var i = 0; i < fields.length; i++) {
      var f = trimmed(fields[i]).toLowerCase();
      if (f && keys[f] === true) return true;
    }
    return false;
  }

  /**
   * The referrals this person may see. Admin and PBIS get everything.
   *
   * A teacher with no identifiers at all gets NOTHING rather than everything:
   * the failure mode of a broken match must be too little, never the whole
   * school's discipline record.
   */
  function visibleReferrals(referrals, user) {
    var rows = referrals || [];
    if (user && seesAllReferrals(user.role)) return rows.slice();
    return rows.filter(function (r) { return ownsReferral(r, user); });
  }

  /** Read a dimension off a referral, preferring the snapshot taken at filing. */
  function valueOf(referral, dimension) {
    var r = referral || {};
    var d = r.demographics || {};
    if (!isBlank(d[dimension])) return trimmed(d[dimension]);
    // Referrals filed before the snapshot existed still carry these two.
    if (dimension === 'grade' && !isBlank(r.studentGrade)) return trimmed(r.studentGrade);
    if (dimension === 'school' && !isBlank(r.school)) return trimmed(r.school);
    return null;
  }

  /**
   * How much of the data actually carries this dimension.
   *
   * Availability is measured from the DATA, never hardcoded, so a breakdown
   * lights up on its own the day the field starts arriving instead of waiting
   * for somebody to remember to flip a flag.
   */
  function availability(referrals, dimension) {
    var rows = referrals || [];
    var meta = DIMENSIONS[dimension] || { key: dimension, label: dimension, restricted: false };
    var withValue = 0;
    rows.forEach(function (r) { if (valueOf(r, dimension) !== null) withValue += 1; });

    return {
      key: meta.key,
      label: meta.label,
      restricted: !!meta.restricted,
      total: rows.length,
      covered: withValue,
      coverage: rows.length ? withValue / rows.length : 0,
      available: withValue > 0,
      unblock: meta.unblock || null
    };
  }

  // ---------------------------------------------------------------------
  // Breakdowns
  // ---------------------------------------------------------------------

  function countBy(referrals, dimension) {
    var counts = {};
    var missing = 0;
    (referrals || []).forEach(function (r) {
      var v = valueOf(r, dimension);
      if (v === null) { missing += 1; return; }
      counts[v] = (counts[v] || 0) + 1;
    });
    return { counts: counts, missing: missing };
  }

  /**
   * Referrals by a demographic dimension, with rates where a denominator
   * exists.
   *
   * `enrollment` is an object of value -> number of enrolled students, e.g.
   * { '9': 180, '10': 165 }. Without it, `index` is null on every row and
   * `hasDenominator` is false: the caller must not render a proportionality
   * claim it was never given the data to make.
   */
  function breakdownBy(referrals, dimension, enrollment) {
    var rows = referrals || [];
    var tally = countBy(rows, dimension);
    var counted = 0;
    Object.keys(tally.counts).forEach(function (k) { counted += tally.counts[k]; });

    var enrolTotal = 0;
    var hasDenominator = !!enrollment && Object.keys(enrollment).length > 0;
    if (hasDenominator) {
      Object.keys(enrollment).forEach(function (k) { enrolTotal += Number(enrollment[k]) || 0; });
    }
    if (!enrolTotal) hasDenominator = false;

    var out = Object.keys(tally.counts).map(function (value) {
      var count = tally.counts[value];
      var shareOfReferrals = counted ? count / counted : 0;
      var enrolled = hasDenominator ? (Number(enrollment[value]) || 0) : 0;
      var shareOfEnrollment = hasDenominator && enrolTotal ? enrolled / enrolTotal : null;

      // An index needs a denominator, a group big enough for a rate to mean
      // anything, AND enough referrals for the ratio to be measuring something.
      // Any of the three missing yields null, never a fabricated 0 or 1.
      var suppressed = hasDenominator && enrolled > 0 && enrolled < SMALL_GROUP;
      var tooFewReferrals = count < MIN_REFERRALS_FOR_INDEX;
      var index = null;
      if (hasDenominator && shareOfEnrollment > 0 && !suppressed && !tooFewReferrals) {
        index = shareOfReferrals / shareOfEnrollment;
      }

      return {
        value: value,
        count: count,
        shareOfReferrals: shareOfReferrals,
        enrolled: hasDenominator ? enrolled : null,
        shareOfEnrollment: shareOfEnrollment,
        index: index,
        suppressed: suppressed,
        // Reported separately from `suppressed` because they mean different
        // things to a reader: one is "we will not show you this", the other is
        // "there is not enough here to say".
        tooFewReferrals: tooFewReferrals
      };
    }).sort(function (a, b) { return b.count - a.count; });

    return {
      dimension: dimension,
      label: (DIMENSIONS[dimension] || {}).label || dimension,
      rows: out,
      counted: counted,
      missing: tally.missing,
      hasDenominator: hasDenominator,
      smallGroupThreshold: SMALL_GROUP,
      minReferralsForIndex: MIN_REFERRALS_FOR_INDEX
    };
  }

  /** Which behaviours are being referred, most first. */
  function behaviorBreakdown(referrals) {
    var rows = referrals || [];
    var counts = {};
    var students = {};
    rows.forEach(function (r) {
      var b = trimmed(r && (r.behavior || r.behaviorType)) || 'Unspecified';
      counts[b] = (counts[b] || 0) + 1;
      if (!students[b]) students[b] = {};
      if (r && r.studentId) students[b][r.studentId] = true;
    });
    var total = rows.length;
    return Object.keys(counts).map(function (b) {
      return {
        behavior: b,
        count: counts[b],
        share: total ? counts[b] / total : 0,
        uniqueStudents: Object.keys(students[b]).length
      };
    }).sort(function (a, b) { return b.count - a.count; });
  }

  // ---------------------------------------------------------------------
  // Trends
  // ---------------------------------------------------------------------

  /** Monday-based ISO week key, e.g. "2026-W34". Local, like the school day. */
  function weekKey(date) {
    var d = new Date(date);
    if (isNaN(d.getTime())) return null;
    var day = (d.getDay() + 6) % 7;          // Monday = 0
    var monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
    var jan1 = new Date(monday.getFullYear(), 0, 1);
    var week = Math.floor((monday - jan1) / 6048e5) + 1;
    return monday.getFullYear() + '-W' + (week < 10 ? '0' + week : week);
  }

  function monthKey(date) {
    var d = new Date(date);
    if (isNaN(d.getTime())) return null;
    var m = d.getMonth() + 1;
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m);
  }

  /**
   * Referrals per period, oldest first, with EMPTY PERIODS INCLUDED.
   *
   * A trend that silently omits a quiet week draws a straight line between
   * two busy ones and hides the quiet week entirely, which is the opposite of
   * what a trend is for.
   */
  function trend(referrals, grain) {
    var keyOf = grain === 'month' ? monthKey : weekKey;
    var rows = (referrals || []).filter(function (r) { return r && r.submittedAt; });
    if (!rows.length) return { grain: grain === 'month' ? 'month' : 'week', points: [] };

    var counts = {};
    var times = [];
    rows.forEach(function (r) {
      var t = new Date(r.submittedAt);
      if (isNaN(t.getTime())) return;
      times.push(t);
      var k = keyOf(t);
      if (k) counts[k] = (counts[k] || 0) + 1;
    });
    if (!times.length) return { grain: grain === 'month' ? 'month' : 'week', points: [] };

    times.sort(function (a, b) { return a - b; });
    var cursor = new Date(times[0]);
    var end = times[times.length - 1];
    var points = [];
    var guard = 0;

    while (cursor <= end && guard++ < 600) {
      var k = keyOf(cursor);
      if (k && !points.some(function (p) { return p.key === k; })) {
        points.push({ key: k, count: counts[k] || 0 });
      }
      if (grain === 'month') cursor.setMonth(cursor.getMonth() + 1);
      else cursor.setDate(cursor.getDate() + 7);
    }
    // The final period can be missed when the step overshoots it.
    var lastKey = keyOf(end);
    if (lastKey && !points.some(function (p) { return p.key === lastKey; })) {
      points.push({ key: lastKey, count: counts[lastKey] || 0 });
    }
    return { grain: grain === 'month' ? 'month' : 'week', points: points };
  }

  // ---------------------------------------------------------------------
  // Headline
  // ---------------------------------------------------------------------

  function summary(referrals, now) {
    var rows = referrals || [];
    var at = typeof now === 'number' ? now : Date.now();
    var weekAgo = at - 7 * 864e5;
    var open = rows.filter(function (r) { return r && r.status !== 'closed'; });
    var closed = rows.filter(function (r) { return r && r.status === 'closed'; });
    var thisWeek = rows.filter(function (r) {
      var t = r && r.submittedAt ? new Date(r.submittedAt).getTime() : NaN;
      return !isNaN(t) && t >= weekAgo;
    });
    var students = {};
    rows.forEach(function (r) { if (r && r.studentId) students[r.studentId] = true; });

    // Repeat referrals concentrate: knowing that 12 referrals came from 3
    // students is a different problem from 12 students with one each.
    var perStudent = {};
    rows.forEach(function (r) { if (r && r.studentId) perStudent[r.studentId] = (perStudent[r.studentId] || 0) + 1; });
    var repeat = Object.keys(perStudent).filter(function (k) { return perStudent[k] > 1; }).length;

    return {
      total: rows.length,
      open: open.length,
      closed: closed.length,
      thisWeek: thisWeek.length,
      uniqueStudents: Object.keys(students).length,
      repeatStudents: repeat
    };
  }

  /**
   * A referral id that two computers cannot both mint.
   *
   * WHAT THIS REPLACES, AND WHAT IT COST. Ids came from `REF${referralIdCounter++}`
   * -- a single counter, held per browser and reconciled between tabs only when
   * a save happened to land. Two teachers filing at the same time both read
   * counter 12 and both produced REF12.
   *
   * That was not a cosmetic clash. The save path is
   * mergeLegacySlice(..., 'id'), which dedupes on the id and lets the STORED
   * copy win -- correct when the two are the same record arriving twice, and
   * catastrophic when they are different children. On 2026-09-04 a referral for
   * Nadia Almendares-Castaneda was minted as REF12, collided with an existing
   * REF12 for Milachi Isidro Rogers filed by another teacher, and was discarded
   * by the merge. It appeared to save, appeared in Open Referrals, and was gone
   * on the next reload -- where View then showed the other teacher's referral
   * about the other child. Production also carried a duplicate REF2.
   *
   * A referral is a disciplinary record about a named child. Losing one
   * silently, or showing one under another child's name, is the worst failure
   * this app has.
   *
   * SHAPE: REF-YYMMDD-XXXXXXX. Still short enough to read down a column and
   * say over a phone, which the old ids were and which is why this is not a
   * UUID -- the id is printed in the referral table and the audit log. The date
   * makes it sortable and human; the seven random characters are what make it
   * unique.
   *
   * Seven, not five. Five gave 33 million combinations a day, and the birthday
   * bound -- not the naive one -- is what matters: at 50 referrals a day that
   * is roughly a 1 in 27,000 chance of a clash, which over a few school years
   * is not a number to be relaxed about for a record like this. Seven gives 34
   * billion and a chance around 1 in 28 million. Two characters is a cheap
   * price for the difference.
   *
   * crypto.getRandomValues when the browser has it. Math.random is seeded per
   * process, and a school's machines boot together and are imaged identically;
   * correlated seeds are exactly the case where two computers mint the same
   * suffix in the same second. Falls back to Math.random rather than throwing,
   * because refusing to file a referral is worse than a weaker id.
   */
  function newReferralId(now, random) {
    var d = now instanceof Date ? now : new Date(typeof now === 'number' ? now : Date.now());
    var yy = String(d.getFullYear()).slice(2);
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');

    // Base36 with the pairs a person confuses out loud broken up: no 0 and no
    // O, no 1 and no I. L stays, and so does the count -- 32 divides 256, which
    // is what makes the modulo below unbiased. Dropping L for 31 characters
    // would skew the first few letters of every id to buy nothing: with 0, 1
    // and I all absent there is nothing left for L to be mistaken for.
    var ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    var LEN = 7;
    var suffix = '';

    if (typeof random === 'function') {
      for (var i = 0; i < LEN; i++) {
        suffix += ALPHABET.charAt(Math.floor(random() * ALPHABET.length) % ALPHABET.length);
      }
      return 'REF-' + yy + mm + dd + '-' + suffix;
    }

    var g = (typeof crypto !== 'undefined' && crypto && crypto.getRandomValues)
      ? crypto : null;
    if (g) {
      var bytes = new Uint8Array(LEN);
      g.getRandomValues(bytes);
      // ALPHABET.length is 32, which divides 256, so the modulo is unbiased.
      for (var j = 0; j < LEN; j++) suffix += ALPHABET.charAt(bytes[j] % ALPHABET.length);
    } else {
      for (var k = 0; k < LEN; k++) {
        suffix += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length) % ALPHABET.length);
      }
    }
    return 'REF-' + yy + mm + dd + '-' + suffix;
  }

  /**
   * Ids appearing more than once in a referral list.
   *
   * Returns them rather than throwing: the caller decides whether a duplicate
   * is worth a console warning or a screen. Exists because the counter era left
   * real duplicates in stored data, and because a merge that silently keeps one
   * of two different records must never again be invisible.
   */
  function duplicateReferralIds(referrals) {
    var seen = {};
    var dupes = [];
    (referrals || []).forEach(function (r) {
      var id = String((r && r.id) || '').trim();
      if (!id) return;
      if (seen[id] === true && dupes.indexOf(id) === -1) dupes.push(id);
      seen[id] = true;
    });
    return dupes;
  }

  root.WildcatDiscipline = {
    newReferralId: newReferralId,
    duplicateReferralIds: duplicateReferralIds,
    SMALL_GROUP: SMALL_GROUP,
    MIN_REFERRALS_FOR_INDEX: MIN_REFERRALS_FOR_INDEX,
    DIMENSIONS: DIMENSIONS,
    snapshotDemographics: snapshotDemographics,
    displayValue: displayValue,
    DISCIPLINE_ALL_ROLES: DISCIPLINE_ALL_ROLES,
    seesAllReferrals: seesAllReferrals,
    disciplineTabsFor: disciplineTabsFor,
    canOpenDisciplineTab: canOpenDisciplineTab,
    ownsReferral: ownsReferral,
    visibleReferrals: visibleReferrals,
    valueOf: valueOf,
    availability: availability,
    breakdownBy: breakdownBy,
    behaviorBreakdown: behaviorBreakdown,
    trend: trend,
    weekKey: weekKey,
    monthKey: monthKey,
    summary: summary
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
