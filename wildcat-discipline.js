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

      // An index needs a denominator AND a group big enough for a rate to
      // mean anything. Either missing yields null, never a fabricated 0 or 1.
      var suppressed = hasDenominator && enrolled > 0 && enrolled < SMALL_GROUP;
      var index = null;
      if (hasDenominator && shareOfEnrollment > 0 && !suppressed) {
        index = shareOfReferrals / shareOfEnrollment;
      }

      return {
        value: value,
        count: count,
        shareOfReferrals: shareOfReferrals,
        enrolled: hasDenominator ? enrolled : null,
        shareOfEnrollment: shareOfEnrollment,
        index: index,
        suppressed: suppressed
      };
    }).sort(function (a, b) { return b.count - a.count; });

    return {
      dimension: dimension,
      label: (DIMENSIONS[dimension] || {}).label || dimension,
      rows: out,
      counted: counted,
      missing: tally.missing,
      hasDenominator: hasDenominator,
      smallGroupThreshold: SMALL_GROUP
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

  root.WildcatDiscipline = {
    SMALL_GROUP: SMALL_GROUP,
    DIMENSIONS: DIMENSIONS,
    snapshotDemographics: snapshotDemographics,
    displayValue: displayValue,
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
