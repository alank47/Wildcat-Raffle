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
   * Slots 6 and 7 carry Periods 5 and 6. No section was observed in either,
   * because they are that teacher's prep, but they are not a guess: slots 2 to
   * 5 are confirmed as Periods 1 to 4, slot 8 is confirmed as Power Up and is
   * not a period, and the school has exactly six core periods. That leaves two
   * periods and exactly two slots between the last confirmed class and Power
   * Up, in an order that cannot flip.
   *
   * The one way that deduction fails is if a non-class block sits at 6 or 7 and
   * pushes a period out to slot 9. Slot 9 has never been observed, so it is
   * deliberately NOT mapped: anything landing there shows its course name with
   * no period attached, which is visible and correctable rather than silently
   * wrong. A teacher who does teach Periods 5 or 6 confirms or refutes all of
   * this the moment they open the tab, which is why it is worth leaving the raw
   * slot on every section.
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

  root.WildcatRoster = {
    ATTENDANCE_TIERS: ATTENDANCE_TIERS,
    attendanceTier: attendanceTier,
    schoolDaysElapsed: schoolDaysElapsed,
    attendanceRanking: attendanceRanking,
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
