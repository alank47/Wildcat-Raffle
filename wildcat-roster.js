/**
 * Whose students does this person see, and which period are they in.
 *
 * Pure. No DOM, no globals, no network. Split out for the same reason
 * convex/accessRules.ts is: this decides whether a teacher is shown a child
 * who is not theirs, and it deserves assertions rather than a read-through.
 *
 * THE SOURCE OF TRUTH IS THE SIS, NOT THE TEACHER RECORD.
 *
 * The code this replaces scoped the Wildcat Cash roster with
 * `currentUser.sections`, an array on the teacher's own app record left over
 * from the CSV era. Two problems with that:
 *
 *   1. It is editable app data. convex/accessRules.ts refuses to read it for
 *      exactly this reason: "a teacher who could edit their own profile could
 *      grant themselves the whole school."
 *   2. A teacher whose record has no sections fell through to seeing EVERY
 *      student, because the old filter only applied when sections existed.
 *      Absent data read as unrestricted, which is the wrong default for a
 *      roster.
 *
 * Section membership now comes from psRoster, which the SIS replaces wholesale
 * on every sync, joined to the signed-in identity by teacher email. Convex
 * serves it through views_app:teacherRoster, which does the email match server
 * side, so the browser is never trusted to say whose roster it wants.
 *
 * The join key between the two systems is studentNumber. The app's student.id
 * may still be a legacy CSV id, so matching on id would silently miss every
 * student whose id predates the SIS.
 */
(function (root) {
  'use strict';

  /**
   * Roles that legitimately see every student rather than a class list.
   *
   * campusaide is here for the reason recorded in convex/accessRules.ts: an
   * aide covers hallways, lunch and the yard, so they are the teacher of
   * record for nobody, and scoping them to a roster scopes them to nothing.
   *
   * pbis is here for the same reason: a PBIS reviewer reads referrals across
   * the school. Neither gains any admin power from being on this list.
   */
  var ALL_STUDENT_ROLES = ['admin', 'superadmin', 'campusaide', 'pbis'];

  /**
   * THE DAY, BY EXPRESSION SLOT.
   *
   * psRoster.period is not a period number. sync-to-app.ts fills it from
   * Sections.Expression, e.g. "2(A-E)", and that leading number is the SLOT in
   * the day, not what the school calls the period. Promise Time occupies slot
   * 1, so every core class sits one slot higher than its name: Newscasting is
   * "Period 1" on the timetable and reports as expression 2.
   *
   * Reading the slot as the period number is what made every period read one
   * too high.
   *
   * Measured, not assumed. From a real teacher's roster on 2026-08-18:
   *
   *     8(A-E)   Power Up 11A
   *     1(A-E)   Promise Time 12A
   *     2(A-E)   Newscasting A               <- the timetable's Period 1
   *     5(A-E)   Multimedia Production 1A    <- Period 4
   *     4(A-E)   Multimedia Production 2A    <- Period 3
   *     3(A-E)   Multimedia Production 3A    <- Period 2
   *    10(A-E)   Promise Time 12A
   *
   * Slots 6 and 7 carry Periods 5 and 6. This began as a deduction and is now
   * CONFIRMED TWICE OVER, so the hedge that used to sit here is gone.
   *
   * Measured 2026-09-21 against every section in the term: slots 2 to 7 each
   * hold academic courses for all 618 students -- slot 6 e.g. Enrichment,
   * Spanish 1, Art 1; slot 7 e.g. World History & Geography, Integrated
   * Science -- while slot 8 (Power Up, 280 students) and slot 9 (Power Up for
   * the lower grades plus Designated ELD and RSP, 338 students) are not core
   * periods and do not cover the whole school. That rules out the one way the
   * deduction could have failed: no non-class block sits at 6 or 7, so no
   * period is pushed out to slot 9.
   *
   * The owner's own timetable confirms it independently: Monday and Thursday
   * run Periods 1, 3 and 5, which are slots 2, 4 and 6; Tuesday and Friday run
   * Periods 2, 4 and 6, which are slots 3, 5 and 7. Odd periods on odd slots
   * and even on even is only consistent with this mapping.
   *
   * SLOT 9 IS STILL DELIBERATELY NOT MAPPED, for a different reason than
   * before: it is observed, and what it holds is not a period. Anything
   * landing there shows its course name with no period attached, which the
   * NAMED_BLOCKS fallback handles correctly for Power Up and honestly for ELD
   * and RSP. The raw slot stays on every section regardless, so a mapping that
   * ever does go wrong is visible to the first teacher who opens the tab.
   *
   * AM VERSUS PM PROMISE TIME IS ONLY KNOWABLE FROM THE SLOT. Both rows above
   * carry the identical course name "Promise Time 12A", so a name-based rule
   * would label them the same and a teacher would see two entries that look
   * like duplicates.
   */
  var SLOT_MAP = {
    1:  { kind: 'promise',    label: 'Promise Time (AM)' },
    2:  { kind: 'core', period: 1 },
    3:  { kind: 'core', period: 2 },
    4:  { kind: 'core', period: 3 },
    5:  { kind: 'core', period: 4 },
    6:  { kind: 'core', period: 5 },
    7:  { kind: 'core', period: 6 },
    8:  { kind: 'powerup',    label: 'Power Up' },
    10: { kind: 'promise-pm', label: 'Promise Time (PM)' }
  };

  /**
   * Fallback only, for a section whose slot is not in the map above. Checked in
   * order; first match wins, so the PM variant is tested before the AM one.
   */
  var NAMED_BLOCKS = [
    { kind: 'promise-pm', label: 'Promise Time (PM)', match: /promise\s*time\s*(pm|afternoon)/i },
    { kind: 'promise',    label: 'Promise Time (AM)', match: /promise\s*time/i },
    { kind: 'powerup',    label: 'Power Up',          match: /power\s*up/i },
    { kind: 'nutrition',  label: 'Nutrition',         match: /nutrition|breakfast/i },
    { kind: 'lunch',      label: 'Lunch',             match: /lunch/i }
  ];

  // Core classes first in timetable order, then the named blocks in the order
  // the day runs them, then anything unrecognised. Nothing is ever hidden.
  var KIND_ORDER = ['core', 'promise', 'powerup', 'promise-pm', 'nutrition', 'lunch', 'other'];

  function trimmed(s) {
    return String(s == null ? '' : s).trim();
  }

  function seesEveryStudent(role) {
    return ALL_STUDENT_ROLES.indexOf(trimmed(role)) !== -1;
  }

  /** The bare number in a period value, or null. "P3", "3", "Period 3" -> 3. */
  function periodNumber(period) {
    var m = /(\d+)/.exec(trimmed(period));
    if (!m) return null;
    var n = parseInt(m[1], 10);
    return isFinite(n) ? n : null;
  }

  /**
   * What kind of block is this, what should it be called, and where does it
   * sort. Returns { kind, label, order, period, slot }.
   *
   * `slot` is the raw expression number. `period` is what the timetable calls
   * it, and exists only for a core class.
   */
  function classifySection(section) {
    var s = section || {};
    var course = trimmed(s.courseName);
    var slot = periodNumber(s.period);

    var mapped = slot !== null ? SLOT_MAP[slot] : null;
    if (mapped) {
      if (mapped.kind === 'core') {
        return {
          kind: 'core',
          label: 'Period ' + mapped.period + (course ? ' - ' + course : ''),
          order: KIND_ORDER.indexOf('core'),
          period: mapped.period,
          slot: slot
        };
      }
      return {
        kind: mapped.kind,
        label: mapped.label,
        order: KIND_ORDER.indexOf(mapped.kind),
        period: null,
        slot: slot
      };
    }

    // Slot not in the map. Fall back to the course name so a block the school
    // adds later is still named sensibly rather than called a period.
    for (var i = 0; i < NAMED_BLOCKS.length; i++) {
      if (NAMED_BLOCKS[i].match.test(course)) {
        return {
          kind: NAMED_BLOCKS[i].kind,
          label: NAMED_BLOCKS[i].label,
          order: KIND_ORDER.indexOf(NAMED_BLOCKS[i].kind),
          period: null,
          slot: slot
        };
      }
    }

    // Neither a mapped slot nor a recognised name. Shown as itself, never
    // relabelled into a period it does not occupy.
    return {
      kind: 'other',
      label: course || (slot !== null ? 'Slot ' + slot : 'Unscheduled'),
      order: KIND_ORDER.indexOf('other'),
      period: null,
      slot: slot
    };
  }

  /**
   * Sections in the order the school day runs: core periods 1 to 6 first, then
   * the named blocks, then anything unrecognised. Each carries the label and
   * kind the UI should use, so no caller re-derives them.
   */
  function sectionsFrom(roster) {
    var sections = (roster && roster.sections) || [];
    return sections.map(function (section) {
      var meta = classifySection(section);
      var out = {};
      for (var k in section) if (Object.prototype.hasOwnProperty.call(section, k)) out[k] = section[k];
      out.kind = meta.kind;
      out.label = meta.label;
      out.period = meta.period;   // timetable period, core classes only
      out.slot = meta.slot;       // raw expression slot
      out._order = meta.order;
      return out;
    }).sort(function (a, b) {
      if (a._order !== b._order) return a._order - b._order;
      // Within core, by period number. Within a named block, by course name,
      // because a teacher may hold two sections of the same block.
      if (a.kind === 'core' && b.kind === 'core') {
        return (a.period || 0) - (b.period || 0);
      }
      return trimmed(a.courseName).localeCompare(trimmed(b.courseName));
    });
  }

  /**
   * The student numbers this person may award to.
   *
   * sectionId null means "all of my sections". Returns a Set so the caller
   * does an O(1) test per student rather than a scan per student.
   */
  function studentNumbersFor(roster, sectionId) {
    var out = {};
    sectionsFrom(roster).forEach(function (section) {
      if (sectionId && trimmed(section.sectionId) !== trimmed(sectionId)) return;
      (section.students || []).forEach(function (s) {
        var n = trimmed(s && s.studentNumber);
        if (n) out[n] = true;
      });
    });
    return out;
  }

  /**
   * Filter an app student list to what this person should see.
   *
   * Returns { students, scope, reason }. `reason` is populated only when the
   * result is empty, so an empty table can say WHY rather than just being
   * blank: "no students in that period" and "the SIS has no roster for you"
   * send a teacher to two completely different people.
   */
  function scopeStudents(opts) {
    var o = opts || {};
    var all = o.students || [];
    var role = trimmed(o.role);
    var roster = o.roster;
    var sectionId = o.sectionId ? trimmed(o.sectionId) : null;

    // A CHOSEN SECTION ALWAYS WINS, FOR EVERY ROLE.
    //
    // This used to sit after the seesEveryStudent check, so an admin who
    // picked "Period 3" was handed the whole school instead: the selection was
    // read, then silently discarded. Picking a period means that period,
    // whoever is asking.
    if (sectionId) {
      var picked = studentNumbersFor(roster, sectionId);
      var inSection = all.filter(function (s) {
        var n = trimmed(s && s.studentNumber);
        return n && picked[n] === true;
      });
      if (inSection.length) {
        return { students: inSection, scope: 'section', reason: null };
      }
      return {
        students: [],
        scope: 'section',
        reason: !Object.keys(picked).length
          ? 'That class has no students in the SIS.'
          : 'The students in that class have no records in the app yet. ' +
            'They should appear after the next sync.'
      };
    }

    if (seesEveryStudent(role)) {
      return {
        students: all,
        scope: 'all',
        reason: all.length ? null : 'No students are enrolled yet.'
      };
    }

    // A teacher with no roster is NOT shown everyone. Absent data is absent,
    // not permission. This is the failure the old code had backwards.
    if (!roster || !(roster.sections || []).length) {
      return {
        students: [],
        scope: 'none',
        reason: 'The SIS has no class roster for your email address yet. ' +
                'Ask an administrator to check that your PowerSchool address ' +
                'matches the one you sign in with.'
      };
    }

    var allowed = studentNumbersFor(roster, null);
    var scoped = all.filter(function (s) {
      var n = trimmed(s && s.studentNumber);
      return n && allowed[n] === true;
    });

    if (scoped.length) {
      return { students: scoped, scope: 'my-roster', reason: null };
    }

    // Distinguish "your roster is empty" from "none of your students have app
    // records", which look identical on screen and need different fixes.
    return {
      students: [],
      scope: 'my-roster',
      reason: !Object.keys(allowed).length
        ? 'Your SIS roster is empty.'
        : 'Your students are on the SIS roster but have no records in the app yet. ' +
          'They should appear after the next sync.'
    };
  }

  /** A label for the roster header, so a teacher can see what they are looking at. */
  function scopeLabel(result, roster, sectionId) {
    if (!result) return '';
    if (result.scope === 'all') return 'All students';
    if (result.scope === 'none') return 'No roster';
    if (sectionId) {
      var hit = sectionsFrom(roster).filter(function (s) {
        return trimmed(s.sectionId) === trimmed(sectionId);
      })[0];
      // sectionsFrom already worked out the right name for this block, so the
      // header cannot disagree with the dropdown the user chose from.
      if (hit) return hit.label;
    }
    return 'My students';
  }


  /**
   * The students nobody is noticing.
   *
   * THE PROBLEM, in the school's own words: quiet, well-behaved children do not
   * earn as many points. They are never a problem, so they are never the reason
   * an adult opens the app, and the reward system quietly passes them by. The
   * school already had a definition -- below the average number of teacher
   * interactions, but above the 5:1 positivity ratio -- and this is that,
   * with one addition it needs to work at both ends of the volume range.
   *
   * TWO GROUPS, NOT ONE.
   *
   *   never    no interactions at all in the window
   *   quiet    below average interactions AND at least 83% positive
   *
   * The strict definition cannot include the first group: a student with zero
   * interactions has no positivity ratio to be above. But that student is the
   * most invisible child in the room, and measured against production on
   * 2026-09-07 -- 64 movements across 754 students, an average of 0.085 --
   * "below average" WAS "has zero", so the strict rule returned nobody at all.
   * At launch volume the second group fills out and the first shrinks. Both are
   * reported, labelled, so the list is useful on day one and still correct in
   * March.
   *
   * THE AVERAGE IS THE SCHOOL'S, NOT THIS TEACHER'S. That is a correction:
   * measuring a teacher's students against that teacher's own average
   * self-calibrates, and self-calibration rewards doing nothing. A teacher who
   * awards nobody has an average of zero, so no student is below it and the
   * panel falls silent for exactly the person who most needs it. Against the
   * staff-wide average, the same teacher sees their whole class flagged --
   * which is the wake-up call, and the school's reason for asking.
   *
   * `average` may be passed in. When it is absent the rule falls back to the
   * group's own mean, which is right for a school-wide view where the group IS
   * the school.
   *
   * 83% is 5 positives to 1 correction, the same ratio the dashboard gauge and
   * the sidebar tips use. One number, three places.
   */
  var POSITIVITY_FLOOR = 5 / 6;   // 5:1, to the same precision everywhere

  function quietStudents(opts) {
    var o = opts || {};
    var roster = o.students || [];
    var byStudent = o.interactions || {};   // id -> { positive, negative }
    var limit = typeof o.limit === 'number' ? o.limit : 8;

    if (!roster.length) return { never: [], quiet: [], average: 0, considered: 0 };

    var rows = roster.map(function (s) {
      var e = byStudent[String(s && s.id)] || {};
      var pos = Number(e.positive) || 0;
      var neg = Number(e.negative) || 0;
      var total = pos + neg;
      return {
        student: s,
        positive: pos,
        negative: neg,
        total: total,
        // null, not 0: no interactions is no ratio. A 0 here would read as
        // "entirely negative", which is the opposite of the truth.
        positivity: total ? pos / total : null
      };
    });

    var sum = rows.reduce(function (n, r) { return n + r.total; }, 0);
    var average = (typeof o.average === 'number' && isFinite(o.average) && o.average >= 0)
      ? o.average
      : sum / rows.length;

    var never = rows.filter(function (r) { return r.total === 0; });
    var quiet = rows.filter(function (r) {
      return r.total > 0 && r.total < average && r.positivity >= POSITIVITY_FLOOR;
    });

    // Least noticed first in both, so the top of the list is the child who has
    // had the least attention rather than whoever sorts first alphabetically.
    var byNeed = function (a, b) {
      if (a.total !== b.total) return a.total - b.total;
      var an = ((a.student && a.student.lastName) || '') + ((a.student && a.student.firstName) || '');
      var bn = ((b.student && b.student.lastName) || '') + ((b.student && b.student.firstName) || '');
      return an.localeCompare(bn);
    };
    never.sort(byNeed);
    quiet.sort(byNeed);

    return {
      average: average,
      // What this group actually does, so a caller can show it beside the
      // threshold rather than making the teacher take it on trust.
      groupAverage: sum / rows.length,
      considered: rows.length,
      neverCount: never.length,
      quietCount: quiet.length,
      never: never.slice(0, limit),
      quiet: quiet.slice(0, limit)
    };
  }


  /**
   * The middle value, not the mean.
   *
   * A handful of very active staff pull a mean upward and put most of the room
   * "below average", which is arithmetically true and useless as a prompt: a
   * target nobody typical reaches reads as noise within a week. The median is
   * what the TYPICAL member of staff does, so half the room is at or above it
   * and the other half has something reachable to aim at.
   */
  function median(values) {
    // typeof first, deliberately. Number(null) is 0, so a .map(Number) turns a
    // missing value into a real zero and drags the median down -- which for a
    // staff count means a colleague who does not exist voting for a lower goal.
    var xs = (values || [])
      .filter(function (n) { return typeof n === 'number' && isFinite(n); })
      .slice()
      .sort(function (a, b) { return a - b; });
    if (!xs.length) return 0;
    var mid = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  }

  /**
   * Today's interaction goal, from what the typical member of staff does.
   *
   * DERIVED, NOT DECREED. A number I chose would be a number I made up, and
   * staff can tell. This is the median colleague's daily rate, so it rises as
   * the school takes the system up and never asks for more than half the room
   * is already managing.
   *
   * FLOORED AT ONE. Before launch the median is zero, and a goal of zero is
   * both unreachable-by-definition and an insult. One is honest at low volume
   * and is quickly overtaken by the real figure.
   *
   * Rounded UP, so a median of 2.3 asks for 3. A goal below what the typical
   * person already does is not a goal.
   */
  function dailyGoal(perStaffCounts, windowDays) {
    var days = (typeof windowDays === 'number' && windowDays > 0) ? windowDays : 30;
    var perDay = median(perStaffCounts) / days;
    return Math.max(1, Math.ceil(perDay));
  }


  /**
   * Chronic absenteeism, by the definition the school already uses.
   *
   * Chronic is missing 10% or more of the days school has been in session --
   * not 10% of the whole year, which would flag nobody until spring. So the
   * denominator grows daily and the threshold with it.
   *
   * THE TIERS ARE NOT DECORATION. A single "chronic / not chronic" line put 54%
   * of this school on one list on 2026-09-08, because at 19 days in, 10% is 1.9
   * days and half the school had missed two. The tiers are the ones districts
   * actually intervene on, and they are what makes the list a queue rather than
   * a roll call:
   *
   *   satisfactory   under 5%
   *   at risk        5% to under 10%     watch
   *   chronic        10% to under 20%    the state's definition
   *   severe         20% and over        act now
   *
   * EARLY IN THE YEAR THIS IS NOISY AND THAT IS NOT A BUG. Two absences in
   * August genuinely is 10% of August. The rate settles as the denominator
   * grows, and a student who is severe in week three is worth a conversation
   * even if they will not be by December.
   *
   * A RATE IS REFUSED, NOT GUESSED, when there are no school days yet or no
   * attendance on file. Dividing by zero would put every child at 0% and
   * absent data would render as perfect attendance, which is the worst
   * possible way to be wrong about this.
   */
  var ATTENDANCE_TIERS = [
    { key: 'severe',       label: 'Severe',       min: 0.20 },
    { key: 'chronic',      label: 'Chronic',      min: 0.10 },
    { key: 'at-risk',      label: 'At risk',      min: 0.05 },
    { key: 'satisfactory', label: 'Satisfactory', min: 0 }
  ];

  function attendanceTier(rate) {
    if (rate === null || rate === undefined || !isFinite(rate)) return null;
    for (var i = 0; i < ATTENDANCE_TIERS.length; i++) {
      if (rate >= ATTENDANCE_TIERS[i].min) return ATTENDANCE_TIERS[i];
    }
    return ATTENDANCE_TIERS[ATTENDANCE_TIERS.length - 1];
  }

  /**
   * School days elapsed, counting weekdays from the first day to today.
   *
   * HOLIDAYS ARE NOT SUBTRACTED, and the direction of that error is the reason
   * it is acceptable: a denominator that is too LARGE makes every rate too
   * SMALL, so the list under-flags rather than over-flags. Being wrong in the
   * other direction means telling a family their child is chronically absent
   * when they are not.
   *
   * The count is shown on screen so it can be checked rather than trusted.
   */
  function schoolDaysElapsed(firstDay, today) {
    var start = (firstDay instanceof Date) ? firstDay : new Date(String(firstDay) + 'T12:00:00');
    var end = (today instanceof Date) ? today : (today ? new Date(String(today) + 'T12:00:00') : new Date());
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return 0;
    var n = 0;
    var d = new Date(start.getTime());
    while (d <= end) {
      var wd = d.getDay();
      if (wd !== 0 && wd !== 6) n++;
      d.setDate(d.getDate() + 1);
    }
    return n;
  }

  /**
   * HOW MANY FULL DAYS HAS A STUDENT MISSED? Bounds, never a count, and the
   * reason that is the honest answer rather than a cop-out.
   *
   * The per-section figures are MARGINALS: each says how many distinct dates a
   * student was absent from that one section. Marginals cannot be intersected,
   * so "how many days did they miss everything" has no exact answer from them.
   * A student absent five times in Period 1 and five times in Period 3 might
   * have missed both on five days or one of them on ten.
   *
   * TWO THINGS ARE RIGOROUS, though, and together they are most of what a
   * person needs.
   *
   * FIRST, PROMISE TIME MEETS EVERY DAY. Both blocks are (A-E), both carry all
   * 618 students, and both appear in all three of the school's day patterns --
   * Monday and Thursday, Tuesday and Friday, and Wednesday. A full day absence
   * must therefore include both, so the smaller of the two Promise Time counts
   * is a HARD CEILING on full days. Its complement is just as solid: on
   * absentDays minus that ceiling, the student sat through a block that meets
   * every day, so those days were partial. Measured across the school on
   * 2026-09-21: of 2,421 absent days, at most 1,275 can be full and at least
   * 1,146 are provably partial.
   *
   * SECOND, THE TOTALS GIVE AN INDEPENDENT CEILING. A full day costs b
   * period-absences and a partial day costs at least one, so with P
   * period-absences over D absent days, P >= f*b + (D - f), which rearranges
   * to f <= (P - D) / (b - 1). b is 6 on the four block days and more on
   * Wednesday, and the SMALLEST b gives the largest and therefore safest
   * ceiling, so 6 is the default. Neither bound dominates: over 431 students
   * Promise Time was tighter 119 times, the totals 91 times, and they agreed
   * 221 times, so both are computed and the tighter wins.
   *
   * SILENCE IS NOT PRESENCE. If attendance was never taken in a Promise Time
   * block -- attendanceRows of 0, which 1,631 of 5,563 rows are -- its zero
   * says nothing about the child, and using it would claim they attended a
   * class nobody registered. Then there is no anchor and `anchored` is false:
   * no bound is offered at all rather than a wrong one. 137 of 679 students
   * are in that position.
   *
   * `sections` are what convex/attendanceList.ts studentPeriods returns:
   * { sectionExpression, courseName, daysAbsent, daysTardy, attendanceRows }.
   */
  function absenceDayBounds(absentDays, sections, opts) {
    var o = (opts && typeof opts === 'object') ? opts : {};
    var blocks = (typeof o.blocksPerDay === 'number' && isFinite(o.blocksPerDay) && o.blocksPerDay > 1)
      ? Math.round(o.blocksPerDay) : 6;
    var D = (typeof absentDays === 'number' && isFinite(absentDays) && absentDays >= 0) ? absentDays : null;
    var rows = sections || [];

    var out = {
      absentDays: D, blocksPerDay: blocks,
      anchored: false, reason: null,
      fullDayCeiling: null, partialDayFloor: null,
      promiseCeiling: null, totalsCeiling: null, tighter: null,
      periodDaysMissed: 0
    };
    if (D === null) { out.reason = 'No absence figure on file'; return out; }

    var periodDays = 0;
    rows.forEach(function (r) {
      var v = r && typeof r.daysAbsent === 'number' && isFinite(r.daysAbsent) ? r.daysAbsent : 0;
      if (v > 0) periodDays += v;
    });
    out.periodDaysMissed = periodDays;

    if (D === 0) {
      out.anchored = true;
      out.fullDayCeiling = 0; out.partialDayFloor = 0;
      return out;
    }

    // The two every-day anchors, identified through the rules module that
    // already owns the slot-to-block mapping rather than by a second one here.
    var am = null, pm = null;
    rows.forEach(function (r) {
      var cls = classifySection({ courseName: r && r.courseName, period: r && r.sectionExpression });
      // attendanceRows of 0 is silence, not presence.
      if (r && Number(r.attendanceRows) === 0) return;
      var v = (r && typeof r.daysAbsent === 'number' && isFinite(r.daysAbsent) && r.daysAbsent >= 0)
        ? r.daysAbsent : null;
      if (v === null) return;
      if (cls.kind === 'promise' && (am === null || v < am)) am = v;
      if (cls.kind === 'promise-pm' && (pm === null || v < pm)) pm = v;
    });

    if (am === null || pm === null) {
      out.reason = 'Attendance was not taken in Promise Time, which is the only block that meets every '
        + 'day, so full days cannot be bounded for this student.';
      return out;
    }

    out.anchored = true;
    out.promiseCeiling = Math.min(am, pm);
    out.totalsCeiling = Math.max(0, Math.floor((periodDays - D) / (blocks - 1)));
    var ceiling = Math.min(out.promiseCeiling, out.totalsCeiling, D);
    out.fullDayCeiling = ceiling;
    out.partialDayFloor = Math.max(0, D - ceiling);
    out.tighter = out.promiseCeiling < out.totalsCeiling ? 'promise'
      : (out.totalsCeiling < out.promiseCeiling ? 'totals' : 'equal');
    return out;
  }

  /**
   * The sentence a person should read, built from the bounds above.
   *
   * It says AT MOST and AT LEAST, never a bare number, because a bare number
   * would be a claim the data cannot support -- and this sentence is read out
   * loud with the student in the room.
   */
  function absenceDaySentence(b) {
    if (!b || b.anchored !== true) {
      return (b && b.reason) || 'Full days cannot be worked out for this student.';
    }
    if (b.absentDays === 0) return 'No absences on record this term.';
    if (b.fullDayCeiling === 0) {
      return 'NONE of these ' + b.absentDays + ' absent days can be a full day: on every one of them '
        + 'the student attended a block that meets every day.';
    }
    if (b.partialDayFloor === 0) {
      return 'Up to all ' + b.absentDays + ' of these days could be full days out of school.';
    }
    return 'At most ' + b.fullDayCeiling + ' of these ' + b.absentDays + ' days were full days out of '
      + 'school, and at least ' + b.partialDayFloor + ' were partial -- the student was in school for '
      + 'part of the day.';
  }

  /**
   * WAS THIS DATE A FULL DAY ABSENCE, A PARTIAL ONE, OR NOT AN ABSENCE?
   *
   * The owner's rule, 2026-09-21: look at one date, look at every block
   * recorded on it, and tabulate what kind of day it was -- because
   * attendance_summary counts a date as absent if ANY period is missed, and
   * measured across the school roughly 47% of absent days are provably
   * partial.
   *
   * THE COUNTS COME FROM THE SERVER, THE VERDICT IS DECIDED HERE, which is
   * this codebase's standing split: a threshold the school will argue about
   * belongs somewhere it can be changed and unit-tested without a deploy.
   * The server stores, per student per date, how many of their blocks ran,
   * how many carried an ABSENT code, how many carried an explicit PRESENT
   * code, and how many carried no record at all.
   *
   * UNRECORDED BLOCKS COUNT AS PRESENT. That is the owner's decision, taken
   * knowing the alternative: PowerSchool stores a row only for exceptions --
   * 606 rows covering 224 of 618 students on 2026-09-14 -- so no record means
   * either present or nobody took it, and those are opposite facts. Assuming
   * present UNDERSTATES absence, which is the safe direction for a claim about
   * a child. The count is still carried on every day so the gap stays visible
   * and so classes where attendance is not being taken can be found, even
   * though it does not move the verdict.
   *
   * ONE STRAY PRESENT AMONG A DAY OF ABSENCES IS A FULL DAY, FLAGGED. Also the
   * owner's decision, and their reasoning: a student marked present for one
   * period and absent for every other is more likely a misrecord than a child
   * who attended exactly one class. So it reads as a full day AND carries
   * `flagged`, so the single present mark is visible and checkable rather than
   * silently overridden. `misrecordAt` is how many explicit present blocks
   * still allow that reading; at 2 or more the day is a genuine partial.
   */
  var DAY_KINDS = {
    full:    { key: 'full',    label: 'Full day absent' },
    partial: { key: 'partial', label: 'Partial day' },
    none:    { key: 'none',    label: 'Not an absence' },
    unknown: { key: 'unknown', label: 'No blocks ran' }
  };

  var DEFAULT_DAY_SETTINGS = { misrecordAt: 1 };

  function daySettingsOrDefault(raw) {
    var d = DEFAULT_DAY_SETTINGS;
    var s = (raw && typeof raw === 'object') ? raw : {};
    var n = s.misrecordAt;
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return { misrecordAt: d.misrecordAt };
    return { misrecordAt: Math.round(n) };
  }

  /**
   * `day` is what the server stores for one student on one date:
   * { date, blocksThatDay, absentBlocks, presentBlocks, unrecordedBlocks }
   * where presentBlocks counts EXPLICIT present-coded records only and
   * blocksThatDay is how many of this student's blocks actually ran.
   */
  function classifyAbsenceDay(day, settings) {
    var s = daySettingsOrDefault(settings);
    var d = day || {};
    var num = function (v) {
      return (typeof v === 'number' && isFinite(v) && v >= 0) ? Math.round(v) : null;
    };
    var blocks = num(d.blocksThatDay);
    var absent = num(d.absentBlocks);
    var present = num(d.presentBlocks);
    var unrecorded = num(d.unrecordedBlocks);

    var out = {
      date: (d.date === 0 || d.date) ? String(d.date) : null,
      blocksThatDay: blocks, absentBlocks: absent,
      presentBlocks: present, unrecordedBlocks: unrecorded,
      kind: null, flagged: false, reason: null
    };
    if (blocks === null || absent === null) {
      out.reason = 'No block record for this date';
      return out;
    }
    // A date on which none of this student's blocks ran is not an absence and
    // not a school day for them; it must not be ranked either way.
    if (blocks === 0) {
      out.kind = DAY_KINDS.unknown;
      out.reason = 'None of the blocks this student is enrolled in ran on this date';
      return out;
    }
    if (absent === 0) { out.kind = DAY_KINDS.none; return out; }

    if (absent >= blocks) { out.kind = DAY_KINDS.full; return out; }

    // Everything they did not miss is accounted for. Unrecorded blocks read as
    // present, so the only thing that can make this a PARTIAL rather than a
    // flagged full day is an explicit present mark.
    var notAbsent = blocks - absent;
    var explicit = present === null ? 0 : present;
    if (explicit > 0 && explicit <= s.misrecordAt && notAbsent <= s.misrecordAt) {
      out.kind = DAY_KINDS.full;
      out.flagged = true;
      out.reason = 'Absent for every block except ' + explicit + ', which was marked present. '
        + 'Counted as a full day and flagged, because one present mark among a day of absences '
        + 'is more likely a misrecord than a student attending one class.';
      return out;
    }
    // Absent for everything except blocks nobody recorded. Those read as
    // present by decision, so this is a partial day -- but say which it is,
    // because it rests on an assumption rather than an observation.
    if (explicit === 0 && (unrecorded === null ? 0 : unrecorded) >= notAbsent) {
      out.kind = DAY_KINDS.partial;
      out.reason = 'Absent for ' + absent + ' of ' + blocks + ' blocks. The other ' + notAbsent
        + ' had no attendance recorded and are counted as present.';
      return out;
    }
    out.kind = DAY_KINDS.partial;
    return out;
  }

  /**
   * Tabulate a student's dates into the three counts the owner asked for.
   *
   * `days` are the server's per-date rows. Returns the totals plus the flagged
   * and assumed-present subsets, because both rest on a judgement and a person
   * should be able to see how much of the answer depends on it.
   */
  function absenceDayTally(days, settings) {
    var s = daySettingsOrDefault(settings);
    var out = {
      settings: s, kinds: DAY_KINDS,
      full: 0, partial: 0, none: 0, noBlocks: 0, unreadable: 0,
      flagged: 0, restingOnAssumedPresent: 0,
      blocksMissed: 0, blocksUnrecorded: 0,
      dates: []
    };
    (days || []).forEach(function (d) {
      var c = classifyAbsenceDay(d, s);
      out.dates.push(c);
      if (!c.kind) { out.unreadable += 1; return; }
      if (c.kind.key === 'full') out.full += 1;
      else if (c.kind.key === 'partial') out.partial += 1;
      else if (c.kind.key === 'none') out.none += 1;
      else out.noBlocks += 1;
      if (c.flagged) out.flagged += 1;
      if (c.absentBlocks) out.blocksMissed += c.absentBlocks;
      if (c.unrecordedBlocks) out.blocksUnrecorded += c.unrecordedBlocks;
      // How much of the tally depends on reading "no record" as present.
      if (c.kind.key === 'partial' && (c.presentBlocks || 0) === 0 && (c.unrecordedBlocks || 0) > 0) {
        out.restingOnAssumedPresent += 1;
      }
    });
    // Worst first, then by date, so the list is stable between renders.
    var rank = { full: 0, partial: 1, none: 2, unknown: 3 };
    out.dates.sort(function (a, b) {
      var ka = a.kind ? rank[a.kind.key] : 4, kb = b.kind ? rank[b.kind.key] : 4;
      if (ka !== kb) return ka - kb;
      return String(b.date || '').localeCompare(String(a.date || ''));
    });
    out.absentDays = out.full + out.partial;
    return out;
  }

  /**
   * Turn the stored per-student components into full and partial day counts.
   *
   * WHY THE SERVER DOES NOT DO THIS. `fullDaysStrict` needs no interpretation
   * -- every block that ran was missed. The misrecord days do: they are days
   * whose only non-absent blocks were explicitly marked present, and whether
   * that reads as a full day is the owner's threshold, which belongs somewhere
   * it can be changed and unit-tested without a deploy. So the server buckets
   * them by gap size and this adds whichever buckets the threshold admits.
   *
   * At the shipped threshold of one, measured across the school on 2026-09-21,
   * that is 5 days of 2,577 -- so the setting matters far less than the
   * distinction it protects.
   *
   * NULL IN, NULL OUT. A student the per-date rebuild has not covered has no
   * split, and reporting zero full days for them would be the good news read
   * off missing data.
   */
  function absenceSplit(split, settings) {
    var s = daySettingsOrDefault(settings);
    if (!split || typeof split !== 'object') return null;
    var n = function (v) {
      return (typeof v === 'number' && isFinite(v) && v >= 0) ? Math.round(v) : null;
    };
    var strict = n(split.fullDaysStrict);
    var partial = n(split.partialDays);
    var absent = n(split.absentDays);
    if (strict === null || partial === null || absent === null) return null;

    var gaps = Array.isArray(split.misrecordDaysByGap) ? split.misrecordDaysByGap : [];
    var counted = 0, uncounted = 0;
    for (var i = 0; i < gaps.length; i++) {
      var c = n(gaps[i]) || 0;
      // Bucket i holds days with a gap of i+1, and the last bucket is "or
      // more" -- so it can only be admitted by a threshold at least that big.
      if ((i + 1) <= s.misrecordAt) counted += c; else uncounted += c;
    }
    var full = strict + counted;
    return {
      absentDays: absent,
      fullDays: full,
      partialDays: Math.max(0, absent - full),
      flaggedDays: counted,
      assumedPresentDays: n(split.assumedPresentDays) || 0,
      misrecordDaysNotCounted: uncounted,
      // The share of this student's absence that was a whole day out of
      // school. Not a percentage OF THE YEAR -- that is the attendance rate,
      // which is a different figure and lives on the tier.
      fullShare: absent > 0 ? full / absent : null
    };
  }

  // =====================================================================
  // RUN CHART RULES
  //
  // A run chart is a measure in time order against its MEDIAN, read with a
  // small set of signal rules. Its whole value is telling a real change apart
  // from the bouncing every measure does anyway -- so that an intervention is
  // judged on evidence rather than on whether last week felt better.
  //
  // THE MEDIAN, NOT THE MEAN, and that is not a preference. Absence counts are
  // skewed by the odd very bad day, and a mean chases those while a median
  // does not. The median is also what the published rules below are built on.
  //
  // WHAT IS EXACT AND WHAT IS A TABLE, stated because they differ in
  // confidence. SHIFT and TREND are exact combinatorial rules and are
  // implemented exactly. The RUNS test compares the observed number of runs
  // against published limits (Swed and Eisenhart, as tabulated for run charts
  // by Perla, Provost and Murray) -- a table reproduced here rather than
  // derived, so it is reported as informational and never as the only signal.
  // =====================================================================

  /** Points NOT on the median are the "useful observations" every rule counts. */
  function runChartMedian(values) {
    // Number(null) IS 0, and 0 is finite. So a null slipped through as a real
    // zero and dragged the median down -- the same trap the cash recount hit
    // with an unreadable amount. Absent has to be refused explicitly.
    var v = (values || [])
      .filter(function (x) { return x !== null && x !== undefined && x !== ''; })
      .map(function (x) { return Number(x); })
      .filter(function (x) { return isFinite(x); })
      .sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  /**
   * Published limits for the number of runs, by useful observations.
   *
   * Outside 10 to 40 the test is NOT applied: below ten there is not enough to
   * say anything, and above forty this table stops. Saying "not enough data"
   * is the honest answer and is what `runsVerdict` returns.
   */
  var RUNS_LIMITS = {
    10: [3, 9],   11: [3, 10],  12: [3, 11],  13: [4, 11],  14: [4, 12],
    15: [5, 12],  16: [5, 13],  17: [5, 13],  18: [6, 14],  19: [6, 15],
    20: [6, 16],  21: [7, 16],  22: [7, 17],  23: [7, 17],  24: [8, 18],
    25: [8, 18],  26: [9, 19],  27: [9, 20],  28: [10, 20], 29: [10, 21],
    30: [11, 22], 31: [11, 22], 32: [11, 23], 33: [11, 24], 34: [12, 24],
    35: [12, 25], 36: [13, 25], 37: [13, 26], 38: [14, 26], 39: [14, 27],
    40: [15, 27]
  };

  /**
   * Every signal in one pass.
   *
   * `points` are { date, value } in time order. Returns the median, the runs
   * count with its verdict, and the exact index spans of any shift or trend so
   * a chart can mark them rather than merely announce them.
   *
   * A POINT EXACTLY ON THE MEDIAN IS SKIPPED for shift and runs, which is the
   * published rule: it is on neither side, so it neither extends nor breaks a
   * run. It is NOT skipped for the trend rule, which reads the raw sequence.
   */
  function runChartSignals(points) {
    var pts = (points || []).filter(function (p) {
      return p && isFinite(Number(p.value));
    }).map(function (p) {
      return { date: p.date, value: Number(p.value) };
    });

    var out = {
      points: pts, n: pts.length, median: null,
      usefulObservations: 0, runs: 0, runsLimits: null, runsVerdict: 'not enough data',
      shifts: [], trends: [], signals: []
    };
    if (pts.length < 2) return out;

    var med = runChartMedian(pts.map(function (p) { return p.value; }));
    out.median = med;

    // --- runs, and the shift rule, over points off the median -------------
    var sides = [];   // { i, side } for every point not on the median
    pts.forEach(function (p, i) {
      if (p.value === med) return;
      sides.push({ i: i, side: p.value > med ? 1 : -1 });
    });
    out.usefulObservations = sides.length;

    var runs = 0, runStart = 0;
    for (var k = 0; k < sides.length; k++) {
      if (k === 0 || sides[k].side !== sides[k - 1].side) {
        // A run just ended; check the one before it for length.
        if (k > 0 && (k - runStart) >= 6) {
          out.shifts.push({ from: sides[runStart].i, to: sides[k - 1].i, length: k - runStart,
                            side: sides[runStart].side > 0 ? 'above' : 'below' });
        }
        runs++; runStart = k;
      }
    }
    if (sides.length && (sides.length - runStart) >= 6) {
      out.shifts.push({ from: sides[runStart].i, to: sides[sides.length - 1].i,
                        length: sides.length - runStart,
                        side: sides[runStart].side > 0 ? 'above' : 'below' });
    }
    out.runs = runs;

    var lim = RUNS_LIMITS[out.usefulObservations];
    if (lim) {
      out.runsLimits = { low: lim[0], high: lim[1] };
      out.runsVerdict = runs < lim[0] ? 'too few'
        : runs > lim[1] ? 'too many' : 'as expected';
    }

    // --- the trend rule, over the raw sequence ---------------------------
    //
    // FIVE OR MORE POINTS ALL MOVING ONE WAY. Equal consecutive values break
    // neither direction and are skipped, which is the published handling: a
    // repeated value is no evidence either way, and treating it as a break
    // would hide a genuine climb that happens to plateau for a day.
    var dir = 0, start = 0, count = 1;
    for (var j = 1; j < pts.length; j++) {
      var d = pts[j].value > pts[j - 1].value ? 1 : pts[j].value < pts[j - 1].value ? -1 : 0;
      if (d === 0) continue;
      if (d === dir) { count++; }
      else { dir = d; start = j - 1; count = 2; }
      if (count >= 5) {
        var last = out.trends[out.trends.length - 1];
        if (last && last.from === start) { last.to = j; last.length = count; }
        else out.trends.push({ from: start, to: j, length: count, direction: dir > 0 ? 'up' : 'down' });
      }
    }

    // --- what a person should read ---------------------------------------
    out.shifts.forEach(function (s) {
      out.signals.push({
        rule: 'shift',
        text: s.length + ' points in a row ' + s.side + ' the median. That is a real change, not noise.'
      });
    });
    out.trends.forEach(function (t) {
      out.signals.push({
        rule: 'trend',
        text: t.length + ' points in a row moving ' + t.direction + '. That is a real change, not noise.'
      });
    });
    if (out.runsVerdict === 'too few') {
      out.signals.push({ rule: 'runs',
        text: 'Only ' + out.runs + ' runs where ' + out.runsLimits.low + ' to ' + out.runsLimits.high
          + ' would be expected: the measure is drifting rather than bouncing.' });
    } else if (out.runsVerdict === 'too many') {
      out.signals.push({ rule: 'runs',
        text: out.runs + ' runs where ' + out.runsLimits.low + ' to ' + out.runsLimits.high
          + ' would be expected: something is alternating, which usually means two things are mixed together.' });
    }
    return out;
  }

  /**
   * Turn the server's per-day rows into the one series a run chart plots.
   *
   * `which` is 'full', 'partial' or 'all'. The misrecord threshold is applied
   * HERE rather than on the server, for the same reason it is everywhere else:
   * it is a display rule the school will argue about, and it belongs where it
   * can be changed without a deploy.
   *
   * ONE SERIES AT A TIME, on purpose. A run chart reads against ONE median;
   * two lines sharing a chart leave it ambiguous which median the signal rules
   * are testing, which is how a run chart quietly becomes decoration.
   */
  function absenceSeriesValues(rows, settings, which) {
    var s = daySettingsOrDefault(settings);
    var pick = String(which || 'full');
    return (rows || []).map(function (r) {
      var strict = Number(r && r.fullDaysStrict) || 0;
      var gaps = (r && Array.isArray(r.misrecordDaysByGap)) ? r.misrecordDaysByGap : [];
      var counted = 0;
      for (var i = 0; i < gaps.length; i++) {
        if ((i + 1) <= s.misrecordAt) counted += Number(gaps[i]) || 0;
      }
      var full = strict + counted;
      var total = Number(r && r.studentsAbsent) || 0;
      var value = pick === 'all' ? total
        : pick === 'partial' ? Math.max(0, total - full)
        : full;
      return {
        date: (r && r.date) || '', value: value,
        // The WHOLE day carried on every point, not only the plotted series, so
        // a tooltip can answer "and what were the other two" without a second
        // pass over the rows.
        studentsAbsent: total, full: full, partial: Math.max(0, total - full)
      };
    });
  }

  /**
   * What a signal on an ABSENCE chart likely means, in words a person can act
   * on.
   *
   * SEPARATE FROM runChartSignals ON PURPOSE. Those rules are generic
   * statistics and know nothing about schools; this is the domain reading, and
   * keeping them apart is what stops the maths quietly acquiring opinions.
   *
   * IT SAYS "LIKELY" AND MEANS IT. A run chart establishes that something
   * CHANGED. It cannot say why, and a chart that implies otherwise is worse
   * than no chart -- so every reading below names what to check rather than
   * what happened, and the downward ones name the boring explanation first.
   */
  function absenceSignalBlurb(signal, which) {
    var s = signal || {};
    var pick = String(which || 'full');
    var series = pick === 'all' ? 'absence overall'
      : pick === 'partial' ? 'partial-day absence' : 'whole-day absence';

    if (s.rule === 'shift') {
      var up = /above/.test(String(s.text));
      if (!up) {
        // THE BORING EXPLANATION FIRST. A fall in recorded absence and a fall
        // in RECORDING look identical on a chart, and 1,631 of 5,563 class
        // registers currently carry no attendance at all.
        return 'Fewer than usual, sustained. Worth confirming before celebrating: '
          + 'absence falls on this chart both when more students attend and when fewer '
          + 'teachers take the register. Check that attendance is still being recorded '
          + 'in the same classes before reading it as a win.';
      }
      if (pick === 'partial') {
        return 'More students than usual are missing PART of the day, sustained rather than a bad week. '
          + 'That is usually arriving late rather than staying away, so the things to check are the '
          + 'morning routine, transport, and what is scheduled first.';
      }
      if (pick === 'full') {
        return 'More students than usual are missing WHOLE days, sustained rather than a bad week. '
          + 'Check illness, a community event and the weather before reading it as disengagement -- '
          + 'this says something changed, not what.';
      }
      return 'Absence is running above its usual level, sustained rather than a bad week.';
    }

    if (s.rule === 'trend') {
      var down = /moving down/.test(String(s.text));
      if (down) {
        return 'A steady fall in ' + series + ' rather than a step. If something was changed '
          + 'deliberately, this is the shape of it working -- and it is worth writing down WHAT '
          + 'changed and WHEN, because a chart cannot tell you later.';
      }
      return 'A steady climb in ' + series + ' rather than a step. Gradual causes look like this: '
        + 'illness building through a season, or engagement slipping week by week. A one-off event '
        + 'would show as a jump instead, so it is worth checking what began around the start of the '
        + 'climb rather than looking for a single bad day.';
    }

    if (s.rule === 'runs') {
      if (/Only /.test(String(s.text))) {
        return 'The measure is drifting rather than settling around one level. That usually means it '
          + 'moved from one level to another during this window -- so the useful question is WHEN, '
          + 'and what changed around then.';
      }
      // THE DAY-OF-WEEK TRAP, named because it is the likeliest cause here and
      // because a reader would otherwise hunt for a cause that is not there.
      return 'Something is alternating rather than varying. At this school the first thing to rule '
        + 'out is the day of the week: Mondays and Fridays run higher than midweek, and a daily '
        + 'chart mixes them together. Looking at one weekday at a time, or at weekly totals, '
        + 'separates them.';
    }
    return '';
  }

  /**
   * Rank students by attendance, worst first.
   *
   * `rows` are { student, daysAbsent, daysTardy }. A student with no
   * attendance on file keeps a null rate and is reported separately rather
   * than sorted in as though they had perfect attendance.
   */
  function attendanceRanking(rows, schoolDays) {
    var days = Number(schoolDays);
    var usable = (typeof days === 'number' && isFinite(days) && days > 0) ? days : null;

    var ranked = [];
    var noData = [];
    (rows || []).forEach(function (r) {
      var abs = (r && typeof r.daysAbsent === 'number' && isFinite(r.daysAbsent)) ? r.daysAbsent : null;
      var tardy = (r && typeof r.daysTardy === 'number' && isFinite(r.daysTardy)) ? r.daysTardy : null;
      if (abs === null || usable === null) { noData.push({ student: r && r.student, daysAbsent: abs, daysTardy: tardy, rate: null, tier: null }); return; }
      var rate = abs / usable;
      ranked.push({
        student: r.student,
        daysAbsent: abs,
        daysTardy: tardy,
        rate: rate,
        tier: attendanceTier(rate)
      });
    });

    ranked.sort(function (a, b) {
      if (b.rate !== a.rate) return b.rate - a.rate;
      var at = (b.daysTardy || 0) - (a.daysTardy || 0);
      if (at) return at;
      var an = ((a.student && a.student.lastName) || '') + ((a.student && a.student.firstName) || '');
      var bn = ((b.student && b.student.lastName) || '') + ((b.student && b.student.firstName) || '');
      return an.localeCompare(bn);
    });

    var counts = { severe: 0, chronic: 0, 'at-risk': 0, satisfactory: 0 };
    ranked.forEach(function (r) { if (r.tier) counts[r.tier.key] += 1; });

    return {
      schoolDays: usable,
      thresholdDays: usable === null ? null : usable * 0.10,
      ranked: ranked,
      noData: noData,
      counts: counts,
      chronicOrWorse: counts.severe + counts.chronic
    };
  }


  /**
   * Is this Wildcat Cash note good enough to save?
   *
   * The note was optional and is now required, asked for on 2026-09-09. The
   * reason it matters is what the note is FOR: a cash movement already records
   * the behaviour, the amount and the adult, and none of that says what the
   * child actually did. "Respectful" plus five dollars is a category; "held the
   * door for the 6th graders at lunch" is the thing a parent can be told and
   * the thing a PBIS review can read six weeks later.
   *
   * MINIMUM LENGTH, NOT JUST NON-EMPTY, and this is the part to argue with. A
   * required field that accepts "." is a required field in name only -- the
   * first person to find that types it every time and the data is worse than
   * when the field was honestly optional, because now it looks filled in.
   * Three characters stops "." and "x" without standing between a teacher and
   * a legitimate short note: "ran" and "sat" both pass.
   *
   * Punctuation and whitespace alone do not count as characters, so "..." and
   * "   " are refused for the same reason "" is.
   *
   * Lives here, with quietStudents and the attendance rules, because this file
   * is loaded on every screen and imports nothing -- the property that makes
   * these rules testable in plain node.
   */
  var CASH_NOTE_MIN = 3;

  function cashNoteVerdict(note) {
    var text = (note === null || note === undefined) ? '' : String(note).trim();
    if (!text) {
      return { ok: false, reason: 'Add a note saying what the student did.' };
    }
    // Letters and digits only, so punctuation cannot pad a note to length.
    var meaningful = text.replace(/[^a-z0-9]/gi, '');
    if (meaningful.length < CASH_NOTE_MIN) {
      return {
        ok: false,
        reason: 'That note is too short. Say what the student did, in a few words.'
      };
    }
    return { ok: true, note: text };
  }


  root.WildcatRoster = {
    CASH_NOTE_MIN: CASH_NOTE_MIN,
    cashNoteVerdict: cashNoteVerdict,
    ATTENDANCE_TIERS: ATTENDANCE_TIERS,
    attendanceTier: attendanceTier,
    schoolDaysElapsed: schoolDaysElapsed,
    attendanceRanking: attendanceRanking,
    absenceDayBounds: absenceDayBounds,
    absenceDaySentence: absenceDaySentence,
    DAY_KINDS: DAY_KINDS,
    DEFAULT_DAY_SETTINGS: DEFAULT_DAY_SETTINGS,
    daySettingsOrDefault: daySettingsOrDefault,
    classifyAbsenceDay: classifyAbsenceDay,
    absenceDayTally: absenceDayTally,
    absenceSplit: absenceSplit,
    runChartMedian: runChartMedian,
    runChartSignals: runChartSignals,
    absenceSeriesValues: absenceSeriesValues,
    absenceSignalBlurb: absenceSignalBlurb,
    RUNS_LIMITS: RUNS_LIMITS,
    median: median,
    dailyGoal: dailyGoal,
    quietStudents: quietStudents,
    POSITIVITY_FLOOR: POSITIVITY_FLOOR,
    ALL_STUDENT_ROLES: ALL_STUDENT_ROLES,
    SLOT_MAP: SLOT_MAP,
    classifySection: classifySection,
    periodNumber: periodNumber,
    seesEveryStudent: seesEveryStudent,
    sectionsFrom: sectionsFrom,
    studentNumbersFor: studentNumbersFor,
    scopeStudents: scopeStudents,
    scopeLabel: scopeLabel
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
