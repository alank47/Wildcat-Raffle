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

  /**
   * Subtabs a role may open, in display order.
   *
   * ATTENDANCE SITS ON THE PRIVILEGED SIDE. It is a whole-school ranking that
   * names the children the school is most worried about, which is the same
   * kind of record as the referral history beside it. A teacher who may only
   * file a referral about their own class has no business with the list, and
   * convex/attendanceList.ts refuses them independently of this.
   *
   * EARLY WARNING SITS THERE FOR A STRONGER VERSION OF THE SAME REASON. It is
   * the most sensitive list this app can produce: it ranks children across
   * attendance, behaviour and grades at once and says which the school is most
   * worried about this week. convex/earlyWarning.ts refuses the other roles
   * independently, so this list and that one have to agree.
   */
  function disciplineTabsFor(role) {
    return seesAllReferrals(role)
      ? ['submit', 'review', 'closed', 'detention', 'attendance', 'earlyWarning', 'uniform', 'history', 'analytics']
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


  /**
   * Union a freshly-fetched referral list into the one this tab is holding.
   *
   * WHY A PULL EXISTS AT ALL. Referrals reach a tab exactly once, at page
   * load. The background auto-refresh is gated on FIVE MINUTES of inactivity,
   * so an admin who opens Open Referrals looking for a colleague's new
   * referral, does not find it, and clicks around looking harder, resets that
   * timer on every click and never gets the pull. Reported twice: a referral
   * filed on one computer was invisible on another until a full reload.
   *
   * NEITHER SIDE IS AUTHORITATIVE, and that is the whole design:
   *
   *   in both      the later updatedAt wins. A tab open for an hour must not
   *                push a stale copy over a colleague's edit, and a fetch must
   *                not undo an edit this tab made a second ago.
   *   local only   KEPT. It is almost certainly a referral just filed here and
   *                still in the save queue. Absence from the server is not a
   *                deletion -- treating it as one is how a refresh destroys
   *                the referral a teacher is in the middle of writing.
   *   server only  ADDED. This is the whole point.
   *
   * Returns the merged array plus what changed, so the screen can say "2 new"
   * rather than redrawing silently and leaving the reader to wonder.
   */
  function mergeReferrals(local, server) {
    var localRows = Array.isArray(local) ? local : [];
    var serverRows = Array.isArray(server) ? server : [];

    function stamp(r) {
      // updatedAt is written on every edit; submittedAt only at filing. Either
      // is a string ISO date, and string comparison is correct for those.
      var u = r && (r.updatedAt || r.submittedAt);
      return typeof u === 'string' ? u : '';
    }

    var byId = {};
    var order = [];
    function put(r, from) {
      if (!r) return;
      var id = trimmed(r.id);
      // A referral with no id cannot be deduped, so it is kept as its own row
      // rather than colliding every other id-less referral into one.
      if (!id) { order.push({ id: null, row: r, from: from }); return; }
      if (!Object.prototype.hasOwnProperty.call(byId, id)) {
        byId[id] = { row: r, from: from };
        order.push({ id: id, row: null, from: from });
        return;
      }
      var have = byId[id];
      if (stamp(r) > stamp(have.row)) byId[id] = { row: r, from: from };
    }

    localRows.forEach(function (r) { put(r, 'local'); });
    var beforeIds = {};
    Object.keys(byId).forEach(function (k) { beforeIds[k] = true; });
    serverRows.forEach(function (r) { put(r, 'server'); });

    var added = 0, updated = 0;
    Object.keys(byId).forEach(function (id) {
      if (!beforeIds[id]) added += 1;
      else if (byId[id].from === 'server') updated += 1;
    });

    var out = [];
    var seen = {};
    order.forEach(function (o) {
      if (o.id === null) { out.push(o.row); return; }
      if (seen[o.id]) return;
      seen[o.id] = true;
      out.push(byId[o.id].row);
    });

    return { referrals: out, added: added, updated: updated, changed: added + updated > 0 };
  }

  // =====================================================================
  // UNIFORM VIOLATIONS — the repeat rule
  //
  // TWO NUMBERS, NOT ONE, and this is the owner's correction rather than the
  // first design. The obvious rule was "three in a school week", and he asked
  // the question that killed it: "if it resets weekly, does that mean the
  // previous week isn't getting considered when punishment is taken into
  // account?" No, it does not — and worse, a resetting week is blind to the
  // pattern that matters most. A student out of uniform twice every week,
  // forever, never reaches three-in-a-week and never flags, while running up
  // sixty violations a year.
  //
  // So the flag runs off a ROLLING window counted backwards from today, which
  // never resets on a Monday and decays on its own as clean days pass; and the
  // TERM TOTAL is carried beside it, never reset, so nobody decides a
  // consequence without seeing every prior week. A student at four last month
  // and clean for two weeks reads rolling 0, total 4: no flag, full history.
  //
  // THE TIERS ARE HIS LADDER, in his words: "1's an accident, 2 is concerning,
  // 3 is a habit."
  //
  // THE TIERS ARE NOT DECORATION, and the reason is measured. A single flat
  // line put 54% of this school on one attendance list on 2026-09-08. A flat
  // "two or more violations" line on a daily dress-code log would do the same
  // by week two. Tiers plus a default filter to the top one make the screen a
  // queue rather than a roll call.
  //
  // WHY THE WORD "severe" IS NOT USED HERE even though the request says
  // "severe offenders": `severeBypass` already means one incident too serious
  // for the intervention ladder, with its own test and its own export column.
  // Two different severes in one mode is how an analytics screen ends up
  // counting the wrong thing. The UI says "Repeat list".
  // =====================================================================

  var UNIFORM_TIERS = [
    { key: 'habit',      label: 'Habit',      min: 3 },
    { key: 'concerning', label: 'Concerning', min: 2 },
    { key: 'accident',   label: 'One-off',    min: 1 },
    { key: 'clean',      label: 'Clear',      min: 0 }
  ];

  /**
   * Defaults, and the justification, next to each other on purpose.
   *
   * `windowDays` 14 rather than 7: a fortnight spans two of a student's weekly
   * cycles, so "twice a week every week" reaches the habit tier instead of
   * hiding under a weekly reset. Both numbers are owner-editable settings —
   * these are only what it ships with.
   */
  var DEFAULT_UNIFORM_SETTINGS = { windowDays: 14, concerningAt: 2, habitAt: 3 };

  /**
   * Coerce a stored settings blob. Absent falls back; 0 is a real value; a
   * string, a negative or a non-number is refused rather than trusted.
   *
   * The rule takes its settings as an ARGUMENT and never reads a global, so a
   * test can vary the thresholds without touching the app's state.
   */
  function uniformSettingsOrDefault(raw) {
    var d = DEFAULT_UNIFORM_SETTINGS;
    var s = (raw && typeof raw === 'object') ? raw : {};
    function n(v, fallback, min) {
      if (typeof v !== 'number' || !isFinite(v)) return fallback;
      if (v < min) return fallback;
      return Math.round(v);
    }
    var windowDays = n(s.windowDays, d.windowDays, 1);
    var concerningAt = n(s.concerningAt, d.concerningAt, 1);
    var habitAt = n(s.habitAt, d.habitAt, 1);
    // A habit cannot be easier to reach than a concern. If someone inverts
    // them, the stricter one wins rather than the tiers silently overlapping.
    if (habitAt < concerningAt) habitAt = concerningAt;
    return { windowDays: windowDays, concerningAt: concerningAt, habitAt: habitAt };
  }

  /** The tier for a rolling count, under these thresholds. */
  function uniformTier(count, settings) {
    if (typeof count !== 'number' || !isFinite(count)) return null;
    var s = uniformSettingsOrDefault(settings);
    if (count >= s.habitAt) return UNIFORM_TIERS[0];
    if (count >= s.concerningAt) return UNIFORM_TIERS[1];
    if (count >= 1) return UNIFORM_TIERS[2];
    return UNIFORM_TIERS[3];
  }

  /**
   * Rank the counted rows worst-first, and count each tier.
   *
   * `rows` are what convex/uniformViolations.ts:counts returns —
   * { studentNumber, studentName, studentGrade, count, days, loaners,
   *   loanersOutstanding, lastDay }. `count` is the rolling window; `total`
   *   is optional and only decorates the row.
   *
   * A row whose count cannot be read is reported in `noData` rather than
   * sorted in as though it were clean — the same refusal attendanceRanking
   * makes, for the same reason: absent data must never render as a good
   * result.
   */
  function uniformRanking(rows, settings) {
    var s = uniformSettingsOrDefault(settings);
    var ranked = [];
    var noData = [];
    (rows || []).forEach(function (r) {
      var c = (r && typeof r.count === 'number' && isFinite(r.count)) ? r.count : null;
      if (c === null) { noData.push({ row: r, count: null, tier: null }); return; }
      ranked.push({
        studentNumber: (r && r.studentNumber) || '',
        studentName: (r && r.studentName) || '',
        studentGrade: (r && r.studentGrade) || '',
        count: c,
        total: (r && typeof r.total === 'number' && isFinite(r.total)) ? r.total : null,
        days: (r && typeof r.days === 'number') ? r.days : null,
        loaners: (r && typeof r.loaners === 'number') ? r.loaners : 0,
        loanersOutstanding: (r && typeof r.loanersOutstanding === 'number') ? r.loanersOutstanding : 0,
        lastDay: (r && r.lastDay) || null,
        tier: uniformTier(c, s)
      });
    });

    ranked.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      // Then the more recent, because a habit that is still going matters
      // more than one that has stopped.
      var d = String(b.lastDay || '').localeCompare(String(a.lastDay || ''));
      if (d) return d;
      return String(a.studentName).localeCompare(String(b.studentName));
    });

    var counts = { habit: 0, concerning: 0, accident: 0, clean: 0 };
    ranked.forEach(function (r) { if (r.tier) counts[r.tier.key] += 1; });

    return { ranked: ranked, noData: noData, counts: counts, settings: s, tiers: UNIFORM_TIERS };
  }

  // =====================================================================
  // THE COMBINED EARLY WARNING INDICATOR -- attendance, behaviour, course
  // performance, ranked worst-first.
  //
  // WHY A SCORE RATHER THAN A RULE, and the measurements that forced it.
  //
  // Every single-axis threshold at this school names a roster rather than a
  // queue, and this has now been measured three times. A flat chronic-absence
  // line put 54% of the school on one list on 2026-09-08. A flat "failing a
  // class" line put 66% on another, and that feature was dropped for it.
  // Measured again across all 679 students on 2026-09-21: 50% are chronically
  // absent or worse, 49% have a genuinely failing course, 56% owe work due in
  // the last fortnight. There is no line on any ONE axis that yields a list a
  // person can work.
  //
  // What separates students is how many axes they are failing at once and how
  // hard. So each axis contributes points, the points are summed, and the
  // tiers sit where the measured distribution puts a workable number of
  // children in the top one. The boundaries below are not taste: they came
  // from running THIS function over the whole school and reading the
  // histogram. Re-run scripts/calibrate-early-warning.mjs when the shape
  // moves, which it will.
  //
  // ABSENCE IS NOT ZERO, AND IT IS NOT SAFETY. A missing figure never scores
  // 0 points as though the child were fine. An axis that cannot be read is
  // named in `unknown` on the row, and a student with nothing readable at all
  // goes to `noData` rather than being ranked clear -- the same refusal
  // attendanceRanking and uniformRanking both make.
  //
  // THE BEHAVIOUR AXIS IS DARK TODAY, ON PURPOSE AND IN WORDS. PowerSchool
  // holds 16,987 behaviour log entries for this district and none of them are
  // in this system: psBehaviorLog is not declared, nothing calls
  // psBehavior.replaceWindow, and there is no coverage record. The app's own
  // referral corpus is 4 rows. So behaviour contributes nothing to anybody and
  // the screen says so. The one thing that must not happen is a dark axis
  // rendering as "no incidents", which is a claim about a child that nobody
  // made. The owner chose this on 2026-09-21 over using cash deductions as a
  // proxy, because a deduction is a teacher's discretionary act and that axis
  // would partly rank teachers.
  //
  // UNIFORM VIOLATIONS ARE NOT AN INPUT AND MUST NEVER BECOME ONE. The
  // owner's decision of 2026-09-18, recorded in schema.ts: "uniform
  // violations are a SEPARATE log. They do not appear in discipline
  // analytics, do not trigger parent email, and are not part of a child's
  // formal discipline record." A dress-code note inside a risk ranking is the
  // same wrong number about children that keeping it out of the
  // disproportionality index exists to avoid.
  // =====================================================================

  var RISK_TIERS = [
    { key: 'act',   label: 'Act now',    min: 7 },
    { key: 'watch', label: 'Watch',      min: 6 },
    { key: 'some',  label: 'Some signs', min: 1 },
    { key: 'clear', label: 'Clear',      min: 0 }
  ];

  /**
   * Defaults, with the measured reason for each beside it.
   *
   * The attendance cuts are the same three Attendance Watch already uses, so a
   * child is not "chronic" on one screen and something else on another.
   *
   * The course cuts sit where the 2026-09-21 distribution actually bends: 49%
   * of students have one genuinely failing course but only 15% have three,
   * and 31% owe work from the last fortnight but only 8% owe five or more. So
   * "some" is ordinary here and "many" is not, which is what makes them worth
   * different points.
   *
   * `actAt` 7 and `watchAt` 6 were not chosen, they were READ OFF the
   * histogram of this function's own output over all 679 students on
   * 2026-09-21. The scores run 0-8 and the counts at or above each cut were:
   * 8 pts 7 students, 7 pts 31, 6 pts 80, 5 pts 139, 4 pts 205, 3 pts 322.
   * Only one cut lands on a list a team can actually finish, and 7 is it --
   * 31 children, against the 30-40 the interventionist team said it can work.
   * watchAt 6 puts the next 49 beside them, so the default view is the 80
   * students who are flagged on BOTH axes that currently hold data. At the
   * next cut down, 5, the list is 139 and on its way back to being a roster.
   *
   * Every one of these is an owner-editable setting. They are only what it
   * ships with.
   */
  var DEFAULT_RISK_SETTINGS = {
    recentDays: 14,
    absSevereAt: 0.20, absChronicAt: 0.10, absAtRiskAt: 0.05,
    tardyManyAt: 10,
    failManyAt: 3, failSomeAt: 1,
    missManyAt: 5, missSomeAt: 2,
    actAt: 7, watchAt: 6,
    /** Hold back students whose SIS row has not refreshed since this date. */
    staleBefore: ''
  };

  /**
   * Coerce a stored settings blob. Absent falls back; a string, a negative or
   * a non-number is refused rather than trusted. Settings arrive as an
   * ARGUMENT and are never read from a global, so a test can vary every
   * threshold without touching app state.
   */
  function riskSettingsOrDefault(raw) {
    var d = DEFAULT_RISK_SETTINGS;
    var s = (raw && typeof raw === 'object') ? raw : {};
    function num(v, fallback, min) {
      if (typeof v !== 'number' || !isFinite(v)) return fallback;
      if (v < min) return fallback;
      return v;
    }
    function int(v, fallback, min) { return Math.round(num(v, fallback, min)); }
    var out = {
      recentDays: int(s.recentDays, d.recentDays, 1),
      absSevereAt: num(s.absSevereAt, d.absSevereAt, 0),
      absChronicAt: num(s.absChronicAt, d.absChronicAt, 0),
      absAtRiskAt: num(s.absAtRiskAt, d.absAtRiskAt, 0),
      tardyManyAt: int(s.tardyManyAt, d.tardyManyAt, 1),
      failManyAt: int(s.failManyAt, d.failManyAt, 1),
      failSomeAt: int(s.failSomeAt, d.failSomeAt, 1),
      missManyAt: int(s.missManyAt, d.missManyAt, 1),
      missSomeAt: int(s.missSomeAt, d.missSomeAt, 1),
      actAt: int(s.actAt, d.actAt, 1),
      watchAt: int(s.watchAt, d.watchAt, 1),
      staleBefore: (typeof s.staleBefore === 'string') ? s.staleBefore.slice(0, 10) : d.staleBefore
    };
    // A LADDER CANNOT INVERT. If someone sets "many" below "some", or the act
    // tier below the watch tier, the stricter one wins rather than two bands
    // silently overlapping and meaning the same thing.
    if (out.absChronicAt > out.absSevereAt) out.absChronicAt = out.absSevereAt;
    if (out.absAtRiskAt > out.absChronicAt) out.absAtRiskAt = out.absChronicAt;
    if (out.failManyAt < out.failSomeAt) out.failManyAt = out.failSomeAt;
    if (out.missManyAt < out.missSomeAt) out.missManyAt = out.missSomeAt;
    // A TIER THAT CANNOT HOLD ANYBODY IS NOT A TIER, and the old clamp allowed
    // two of them. `actAt = watchAt` made "Watch" unreachable, because riskTier
    // tests actAt first -- and the card then rendered its band as
    // "6-5 points" above a count permanently stuck at 0. `watchAt = 1` did the
    // same to "Some signs", printing "1-0 points". So the bands are forced
    // apart rather than merely ordered: Watch starts at 2 or higher, and Act
    // now is strictly above Watch.
    if (out.watchAt < 2) out.watchAt = 2;
    if (out.actAt <= out.watchAt) out.actAt = out.watchAt + 1;
    return out;
  }

  /**
   * The attendance axis. The same tiers Attendance Watch uses, scored.
   *
   * A rate is REFUSED rather than guessed when there are no school days yet or
   * no figure on file: dividing by zero would put every child at 0% and absent
   * data would render as perfect attendance, which is the worst possible way
   * to be wrong about this.
   *
   * Tardies earn a separate point rather than being folded into the rate,
   * because a student who is present but always late never appears on an
   * absence ranking at all.
   */
  function riskAttendance(daysAbsent, daysTardy, schoolDays, settings) {
    var s = riskSettingsOrDefault(settings);
    var days = (typeof schoolDays === 'number' && isFinite(schoolDays) && schoolDays > 0) ? schoolDays : null;
    var abs = (typeof daysAbsent === 'number' && isFinite(daysAbsent) && daysAbsent >= 0) ? daysAbsent : null;
    var tardy = (typeof daysTardy === 'number' && isFinite(daysTardy) && daysTardy >= 0) ? daysTardy : null;
    if (days === null || abs === null) {
      return { known: false, points: 0, rate: null, tier: null, daysAbsent: abs, daysTardy: tardy,
               why: days === null ? 'No school days counted yet' : 'No attendance figure on file' };
    }
    var rate = abs / days;
    var points = 0, tier = 'satisfactory';
    if (rate >= s.absSevereAt) { points = 3; tier = 'severe'; }
    else if (rate >= s.absChronicAt) { points = 2; tier = 'chronic'; }
    else if (rate >= s.absAtRiskAt) { points = 1; tier = 'at-risk'; }
    var tardyFlag = (tardy !== null && tardy >= s.tardyManyAt);
    if (tardyFlag) points += 1;
    return { known: true, points: points, rate: rate, tier: tier,
             daysAbsent: abs, daysTardy: tardy, tardyFlag: tardyFlag, why: null };
  }

  /**
   * The course-performance axis: how much is genuinely failing, and how much
   * work is owed FROM THE LAST FORTNIGHT.
   *
   * RECENCY IS THE POINT. With half the school failing something, a total
   * count of owed work separates nobody. But psMissingWork carries a due date
   * on every row -- measured, 0 of 4,928 undated -- so one snapshot still
   * contains time. Five assignments owed from the last two weeks is a child
   * coming apart now; the same five spread since August is not, and shows up
   * as `missingOlder`, carried but unscored. That is also what lets this
   * screen show a student IMPROVING before any history table exists: older
   * work owed, nothing recent.
   *
   * `failingCourses` has already had the zero-percent artefact removed by the
   * server, which is a data-correctness rule rather than a display one. The
   * raw count rides along so the screen can show both.
   */
  function riskCourse(row, settings) {
    var s = riskSettingsOrDefault(settings);
    var r = row || {};
    var failing = (typeof r.failingCourses === 'number' && isFinite(r.failingCourses)) ? r.failingCourses : null;
    var recent = (typeof r.missingRecent === 'number' && isFinite(r.missingRecent)) ? r.missingRecent : null;
    var older = (typeof r.missingOlder === 'number' && isFinite(r.missingOlder)) ? r.missingOlder : null;
    if (failing === null && recent === null) {
      return { known: false, points: 0, failing: null, missingRecent: null, missingOlder: older,
               gradesKnown: false, missingKnown: false,
               missingTruncated: r.missingTruncated === true, gradesTruncated: r.gradesTruncated === true,
               ungraded: null, failingRaw: null, why: 'No grades or assignment data on file' };
    }
    var points = 0;
    if (failing !== null) {
      if (failing >= s.failManyAt) points += 2;
      else if (failing >= s.failSomeAt) points += 1;
    }
    if (recent !== null) {
      if (recent >= s.missManyAt) points += 2;
      else if (recent >= s.missSomeAt) points += 1;
    }
    // GRADES AND OWED WORK ARE TRACKED SEPARATELY, and the calibration run of
    // 2026-09-21 is why. 62 students have no psGrades rows at all. Missing work
    // is a presence-only feed, so those same students read missingRecent 0 --
    // a genuine zero -- and an earlier version of this function therefore
    // scored them known-and-fine on course performance when their grades were
    // simply not on file. That is the "absence is not zero" failure this
    // module refuses everywhere else, so `gradesKnown` is carried and the row
    // is marked instead of quietly reading as passing.
    return {
      known: true, points: points, failing: failing,
      gradesKnown: failing !== null,
      missingKnown: recent !== null,
      missingRecent: recent, missingOlder: older,
      ungraded: (typeof r.ungradedCourses === 'number') ? r.ungradedCourses : null,
      failingRaw: (typeof r.failingCoursesRaw === 'number') ? r.failingCoursesRaw : null,
      // AT THE READ CAP MEANS UNDER-COUNTED, so the score is a floor rather
      // than a total and the screen has to be able to say so. Otherwise the
      // student who has handed in nothing all year sinks below students with
      // less owed work.
      missingTruncated: r.missingTruncated === true,
      gradesTruncated: r.gradesTruncated === true,
      why: failing === null ? 'No grades on file' : null
    };
  }

  /**
   * The behaviour axis, which today knows nothing and says so.
   *
   * `coverage` is what convex/earlyWarning.ts returns: status "unknown" until
   * a behaviour window has really been pulled. Unknown scores ZERO POINTS FOR
   * EVERYONE -- it cannot differentiate, so it must not pretend to -- and
   * returns known:false so the row and the screen both carry the gap.
   */
  function riskBehaviour(coverage) {
    var c = coverage || {};
    if (c.status !== 'covered') {
      return { known: false, points: 0, entries: null, status: c.status || 'unknown',
               why: 'No behaviour data is loaded, so nobody is scored on it' };
    }
    return { known: true, points: 0, entries: null, status: 'covered', why: null };
  }

  /** The tier for a total, under these thresholds. */
  function riskTier(points, settings) {
    if (typeof points !== 'number' || !isFinite(points)) return null;
    var s = riskSettingsOrDefault(settings);
    if (points >= s.actAt) return RISK_TIERS[0];
    if (points >= s.watchAt) return RISK_TIERS[1];
    if (points >= 1) return RISK_TIERS[2];
    return RISK_TIERS[3];
  }

  /**
   * Score one student across all three axes.
   *
   * `row` is an academicCounts row merged with the two attendance figures:
   * { studentNumber, daysAbsent, daysTardy, failingCourses, failingCoursesRaw,
   *   ungradedCourses, gradedCourses, missingRecent, missingOlder, sisAsOf }.
   */
  function riskScore(row, schoolDays, coverage, settings) {
    var r = row || {};
    var a = riskAttendance(r.daysAbsent, r.daysTardy, schoolDays, settings);
    var b = riskBehaviour(coverage);
    var c = riskCourse(r, settings);
    var unknown = [];
    if (!a.known) unknown.push('attendance');
    if (!b.known) unknown.push('behaviour');
    if (!c.known) unknown.push('course');
    else {
      // Named separately from 'course' so a student whose grades are simply not
      // on file is visibly a gap rather than a quiet pass.
      if (c.gradesKnown === false) unknown.push('grades');
      // And the same for owed work. A caller that cannot see the missing-work
      // feed passes null rather than 0, and this is what makes those children
      // reachable on the screen instead of merely absent from the top tier.
      if (c.missingKnown === false) unknown.push('missing');
    }
    return {
      studentNumber: (r.studentNumber === 0 || r.studentNumber) ? String(r.studentNumber) : '',
      points: a.points + b.points + c.points,
      tier: riskTier(a.points + b.points + c.points, settings),
      attendance: a, behaviour: b, course: c,
      unknown: unknown,
      // Readable on at least one of the two axes that hold data today.
      scorable: a.known || c.known,
      sisAsOf: r.sisAsOf || null
    };
  }

  /**
   * Rank the whole school worst-first, and count each tier.
   *
   * A student readable on NO axis goes to `noData`, never into the ranking as
   * though they were clear. A student readable on one but not the other is
   * ranked on what is known and carries `unknown`, so the screen marks the row
   * rather than quietly under-scoring them.
   *
   * A student whose SIS row has not refreshed since `staleBefore` goes to
   * `stale` -- 61 of the 679 on file were last seen as far back as August and
   * have almost certainly withdrawn. They are held back and COUNTED, not
   * dropped: silently removing children from a risk list is how a child who
   * is still enrolled disappears from it.
   *
   * TIES BREAK ON THE WORST SINGLE AXIS, then days absent, then student
   * number. Without a deterministic tail the list reorders itself between
   * renders and a person loses their place in it.
   */
  function riskRanking(rows, schoolDays, coverage, settings) {
    var s = riskSettingsOrDefault(settings);
    var ranked = [], noData = [], stale = [];
    (rows || []).forEach(function (row) {
      var scored = riskScore(row, schoolDays, coverage, s);
      if (!scored.scorable) { noData.push(scored); return; }
      if (s.staleBefore && scored.sisAsOf && scored.sisAsOf < s.staleBefore) { stale.push(scored); return; }
      ranked.push(scored);
    });
    ranked.sort(function (x, y) {
      if (y.points !== x.points) return y.points - x.points;
      if (y.attendance.points !== x.attendance.points) return y.attendance.points - x.attendance.points;
      var xd = x.attendance.daysAbsent || 0, yd = y.attendance.daysAbsent || 0;
      if (yd !== xd) return yd - xd;
      return String(x.studentNumber) < String(y.studentNumber) ? -1 : 1;
    });
    var counts = { act: 0, watch: 0, some: 0, clear: 0 };
    ranked.forEach(function (r) { if (r.tier && counts[r.tier.key] !== undefined) counts[r.tier.key] += 1; });
    return {
      ranked: ranked, noData: noData, stale: stale, counts: counts,
      settings: s, schoolDays: schoolDays, tiers: RISK_TIERS,
      behaviourKnown: Boolean(coverage && coverage.status === 'covered'),
      actOrWatch: counts.act + counts.watch
    };
  }

  root.WildcatDiscipline = {
    mergeReferrals: mergeReferrals,
    UNIFORM_TIERS: UNIFORM_TIERS,
    DEFAULT_UNIFORM_SETTINGS: DEFAULT_UNIFORM_SETTINGS,
    uniformSettingsOrDefault: uniformSettingsOrDefault,
    uniformTier: uniformTier,
    uniformRanking: uniformRanking,
    RISK_TIERS: RISK_TIERS,
    DEFAULT_RISK_SETTINGS: DEFAULT_RISK_SETTINGS,
    riskSettingsOrDefault: riskSettingsOrDefault,
    riskAttendance: riskAttendance,
    riskBehaviour: riskBehaviour,
    riskCourse: riskCourse,
    riskTier: riskTier,
    riskScore: riskScore,
    riskRanking: riskRanking,
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
