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
   * The grade-scope block on a roster payload ("middle" = every student in
   * grades 6-8, on top of a teacher's own classes; convex/gradeScopeRead.ts),
   * or null. Anything malformed is ignored rather than guessed at: the block
   * is a list of student NUMBERS the server worked out, and this never parses
   * a grade.
   */
  function gradeBlockOf(roster) {
    var b = roster && roster.gradeScope;
    if (!b || typeof b !== 'object') return null;
    if (!Array.isArray(b.studentNumbers) || typeof b.label !== 'string' || !b.label) return null;
    return b;
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
    // not permission. This is the failure the old code had backwards. A grade
    // scope counts as a roster: a teacher with no classes but Middle School
    // access sees the Middle School.
    var block = gradeBlockOf(roster);
    if (!roster || (!(roster.sections || []).length && !block)) {
      return {
        students: [],
        scope: 'none',
        reason: 'The SIS has no class roster for your email address yet. ' +
                'Ask an administrator to check that your PowerSchool address ' +
                'matches the one you sign in with.'
      };
    }

    var allowed = studentNumbersFor(roster, null);
    if (block) {
      block.studentNumbers.forEach(function (num) {
        var n = trimmed(num);
        if (n) allowed[n] = true;
      });
    }
    var scoped = all.filter(function (s) {
      var n = trimmed(s && s.studentNumber);
      return n && allowed[n] === true;
    });
    var scopeName = block ? 'grade-scope' : 'my-roster';

    if (scoped.length) {
      return { students: scoped, scope: scopeName, reason: null };
    }

    if (block) {
      return {
        students: [],
        scope: scopeName,
        reason: !block.studentNumbers.length && !Object.keys(studentNumbersFor(roster, null)).length
          ? 'PowerSchool lists no students in ' + block.label + ' right now.'
          : 'The ' + block.label + ' students have no records in the app yet. ' +
            'They should appear after the next sync.'
      };
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
    if (result.scope === 'grade-scope' && !sectionId) {
      var gb = gradeBlockOf(roster);
      if (gb) return ((roster && (roster.sections || []).length) ? 'My classes + ' : '') + gb.label;
    }
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
    // ROUNDED to nine places: the average of two one-decimal values is not
    // exact in binary -- (87.1 + 87.3) / 2 is 87.19999999999999 -- and a
    // point of exactly 87.2 must count as ON the median, not above it.
    return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2 * 1e9) / 1e9;
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
  function runChartSignals(points, opts) {
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

    // A FROZEN MEDIAN, when one is given (the attendance-rate run chart). It is
    // used as is and never recalculated from these points -- see
    // runChartAnalysis for why that is the method and not a bug. Without one,
    // the median of the points themselves, as the daily chart has always used.
    var fixed = opts && opts.median !== null && opts.median !== undefined && isFinite(Number(opts.median));
    var med = fixed ? Number(opts.median) : runChartMedian(pts.map(function (p) { return p.value; }));
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
    if (!lim && out.usefulObservations > 40) {
      // BEYOND THE TABLE, THE FORMULA IT WAS BUILT FROM. The published table
      // stops at 40; past it the runs count is judged with the Swed-Eisenhart
      // normal approximation, mean +/- 1.96 standard deviations from the
      // actual counts above and below. It reproduces the table's own limits
      // at 40 (15 to 27 for 20 and 20). A year of weekly points passes 40, and
      // saying "not enough data" there would be the opposite of the truth.
      var up = sides.filter(function (x) { return x.side > 0; }).length;
      var dn = sides.length - up, nn = sides.length;
      var mean = 1 + 2 * up * dn / nn;
      var sd = Math.sqrt(2 * up * dn * (2 * up * dn - nn) / (nn * nn * (nn - 1)));
      if (isFinite(sd) && sd > 0) lim = [Math.ceil(mean - 1.96 * sd), Math.floor(mean + 1.96 * sd)];
      out.runsApproximate = !!lim;
    }
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


  // =====================================================================
  // PERFECT ATTENDANCE
  //
  // "No missed classes and no tardies", the owner's definition, 2026-09-22.
  //
  // THE NUMBERS THIS WAS BUILT AGAINST, measured against production before a
  // line of screen existed, 618 enrolled over 28 school days:
  //
  //            window        perfect     no absences only
  //            last 5 days   183 (30%)   300
  //            September      75 (12%)   172
  //            year to date   36 (6%)    105
  //
  // Two thirds of the year-to-date list is decided by TARDIES: 105 students
  // have no absences at all, and only 36 of those were never once late. That
  // is the whole reason this needed new data rather than a new screen over the
  // old data, and it is why the tardy half must never silently read as zero --
  // a school whose tardy code went unrecognised would hand out three times too
  // many awards and nobody would notice.
  //
  // WHETHER "EXCUSED" COUNTS IS A SWITCH, NOT A CONSTANT. The owner asked for
  // it on the screen: strict by default, forgiving on request, because a
  // school argues about that one every year and it must not need a developer.
  // Year to date the choice is 36 students against 63.
  //
  // EXCUSED TARDIES ARE SETTLED, AND NO LONGER PART OF THAT SWITCH (owner,
  // 2026-10-01: "Can we not count Excused Tardies in Perfect Attendance? And
  // make it retroactive to September?"). An Excused Tardy (code D) never
  // breaks perfect attendance in any window; a plain Tardy (T) always does,
  // even on a day that also had an excused one. The switch now covers excused
  // ABSENCES only. (The 36-against-63 above was measured with tardies in the
  // switch, so it is not today's choice.)
  // =====================================================================

  /** A day, in the school's own calendar terms, from "YYYY-MM-DD". */
  function dayFrom(iso) {
    var s = String(iso || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    var p = s.split('-');
    // UTC, deliberately: these are calendar days, never instants. Building
    // them in local time makes the same string mean a different day either
    // side of midnight, which is the bug that dated referrals to tomorrow.
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  }

  function isoOf(d) {
    return d.toISOString().slice(0, 10);
  }

  function shiftDays(iso, n) {
    var d = dayFrom(iso);
    if (!d) return null;
    d.setUTCDate(d.getUTCDate() + n);
    return isoOf(d);
  }

  /**
   * The three windows, from today.
   *
   * WEEK IS THE LAST COMPLETED MONDAY-TO-FRIDAY, chosen by the owner over a
   * rolling five days and over the current week. An award list has to hold
   * still: a window ending today changes under whoever is reading it out, and
   * "this week" on a Monday morning is a one-day window that almost everyone
   * wins. The last finished week is the same list all week long.
   *
   * MONTH AND YEAR RUN TO TODAY, because those are read as progress rather
   * than as a finished result, and a completed-month rule would show nothing
   * at all for the first week of October.
   */
  /**
   * "LAST WEEK", ONE RULE FOR EVERY SCREEN (2026-10-07): the last Monday to
   * Friday that has finished.
   *
   * ON A WEEKEND, THE WEEK JUST GONE IS ALREADY FINISHED. Stepping back a
   * further week on a Saturday would show the week before last, so a school
   * looking on Friday evening and again on Saturday morning would see the
   * list go BACKWARDS. Monday to Friday has run its course by Saturday; on a
   * weekday it has not, and the last finished week is the one before.
   *
   * WHY ONE FUNCTION. Perfect attendance had this rule and "Who is missing"
   * did not: on a Sunday its "Last week" was the week before, so a PBIS lead
   * preparing on Sunday night for a Monday meeting saw two different weeks
   * under the same name (review, 2026-10-06). Both now ask this.
   */
  function lastFinishedWeek(todayIso) {
    var today = dayFrom(todayIso);
    if (!today) return null;
    var iso = isoOf(today);
    // Back up to the most recent Monday. getUTCDay is 0 for Sunday, so the
    // shift is (dow + 6) % 7 rather than dow - 1.
    var dow = today.getUTCDay();
    var thisMonday = shiftDays(iso, -((dow + 6) % 7));
    var weekend = (dow === 0 || dow === 6);
    var from = weekend ? thisMonday : shiftDays(thisMonday, -7);
    return { from: from, to: shiftDays(from, 4) };
  }

  function perfectWindows(todayIso, yearStartIso) {
    var today = dayFrom(todayIso);
    if (!today) return null;
    var iso = isoOf(today);

    // The same week Week or month calls "Last week" (lastFinishedWeek).
    var lw = lastFinishedWeek(iso);
    var lastMonday = lw.from;
    var lastFriday = lw.to;

    var monthStart = iso.slice(0, 8) + '01';
    var yearStart = /^\d{4}-\d{2}-\d{2}$/.test(String(yearStartIso || ''))
      ? String(yearStartIso).slice(0, 10) : null;

    return {
      // "Last week", the name Week or month uses for the same Monday to
      // Friday (it was "Last full week" until 2026-10-07).
      week: { key: 'week', from: lastMonday, to: lastFriday, label: 'Last week' },
      month: { key: 'month', from: monthStart, to: iso, label: 'This month so far' },
      year: { key: 'year', from: yearStart, to: iso, label: 'Year to date' }
    };
  }

  /** Dates in `list` that fall inside [from, to]. Plain string comparison. */
  function datesInWindow(list, win) {
    var out = [];
    if (!list || !win) return out;
    var from = win.from, to = win.to;
    for (var i = 0; i < list.length; i++) {
      var d = String(list[i] || '').slice(0, 10);
      if (d.length !== 10) continue;
      if (from && d < from) continue;
      if (to && d > to) continue;
      out.push(d);
    }
    return out;
  }

  /** `list` without any date in `drop`. */
  function withoutDates(list, drop) {
    return list.filter(function (d) { return drop.indexOf(d) === -1; });
  }

  /**
   * Was this student perfect over this window, and if not, why not?
   *
   * `countExcused` true means an excused ABSENCE still breaks it -- the
   * strict reading, and the default. It has no say over tardies since
   * 2026-10-01: an excused tardy never breaks it, an unexcused one always
   * does.
   *
   * ELIGIBILITY IS PART OF THE ANSWER, not a filter applied elsewhere. A
   * student who enrolled on 2026-09-15 has no year to be perfect over, and
   * putting them on the same list as somebody with 28 clean days behind them
   * would quietly devalue it for everyone on it. They come back
   * eligible:false with the date, so a screen can say so rather than silently
   * dropping a child from a list their family expects them on.
   */
  function perfectVerdict(row, win, opts) {
    var o = opts || {};
    var countExcused = o.countExcused !== false;
    var r = row || {};

    var absences = datesInWindow(r.absentDates, win);
    var tardies = datesInWindow(r.tardyDates, win);

    // ONLY AN UNEXCUSED TARDY BREAKS IT, in every window (owner, 2026-10-01).
    // unexcusedTardyDates is exact: the rebuild puts a date there when at
    // least one of that day's tardy blocks was not excused, so a plain Tardy
    // still counts on a day that also had an Excused one.
    if (Array.isArray(r.unexcusedTardyDates)) {
      tardies = datesInWindow(r.unexcusedTardyDates, win);
    } else if (!countExcused) {
      // A ROW THE REBUILD HAS NOT REFILLED YET keeps today's rule EXACTLY
      // (review, 2026-10-02): every tardy counts with the box ticked, and with
      // it unticked excused ones are forgiven by subtraction, as they always
      // were. The new rule's subtraction under the ticked box forgave a day
      // with BOTH kinds and put a child late without an excuse on a list that
      // may be printed; this way the switch-over adds nobody, and the exact
      // rule arrives with the rebuild run straight after the deploy.
      tardies = withoutDates(tardies, datesInWindow(r.excusedTardyDates, win));
    }
    //
    // RETROACTIVE BY CONSTRUCTION. Nothing is stored per month or per week:
    // every list is worked out from these marks each time it is drawn, so the
    // rule reaches September, and every other window, with nothing to redo.

    // THE SWITCH IS ABOUT EXCUSED ABSENCES ONLY. Forgiving, a day breaks it
    // only if it had an absence that was not excused -- exactly, from
    // unexcusedAbsentDates, or by the same approximation as above for a row
    // the rebuild has not refilled yet.
    if (!countExcused) {
      absences = Array.isArray(r.unexcusedAbsentDates)
        ? datesInWindow(r.unexcusedAbsentDates, win)
        : withoutDates(absences, datesInWindow(r.excusedAbsentDates, win));
    }

    var entry = String(r.entryDate || '').slice(0, 10);
    var eligible = true, since = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(entry) && win && win.from && entry > win.from) {
      eligible = false;
      since = entry;
    }

    return {
      studentNumber: String(r.studentNumber || ''),
      eligible: eligible,
      enrolledSince: since,
      absentDays: absences.length,
      tardyDays: tardies.length,
      perfect: eligible && absences.length === 0 && tardies.length === 0,
      // What broke it, for a screen that wants to say "one tardy, 16 Sept".
      brokenBy: absences.length && tardies.length ? 'both'
        : absences.length ? 'absence' : tardies.length ? 'tardy' : null,
      firstAbsence: absences.length ? absences[0] : null,
      firstTardy: tardies.length ? tardies[0] : null
    };
  }

  /**
   * The list, and the counts that make it readable.
   *
   * IT RETURNS THE DENOMINATOR TOO. "36 students" means nothing without "of
   * 618"; a perfect attendance screen that shows only the winners cannot tell
   * anyone whether the school is improving, and a list that quietly shrank
   * because a sync broke would look like a bad week.
   */
  function perfectList(rows, win, opts) {
    var o = opts || {};
    var all = rows || [], out = [], counts = {
      considered: 0, eligible: 0, perfect: 0,
      notEligible: 0, brokenByAbsence: 0, brokenByTardy: 0, brokenByBoth: 0
    };
    for (var i = 0; i < all.length; i++) {
      var v = perfectVerdict(all[i], win, o);
      counts.considered++;
      if (!v.eligible) { counts.notEligible++; continue; }
      counts.eligible++;
      if (v.perfect) {
        counts.perfect++;
        out.push({
          studentNumber: v.studentNumber,
          firstName: all[i].firstName || '',
          lastName: all[i].lastName || '',
          gradeLevel: all[i].gradeLevel || '',
          enrolledSince: all[i].entryDate || ''
        });
      } else if (v.brokenBy === 'both') counts.brokenByBoth++;
      else if (v.brokenBy === 'absence') counts.brokenByAbsence++;
      else if (v.brokenBy === 'tardy') counts.brokenByTardy++;
    }
    out.sort(function (a, b) {
      var g = String(a.gradeLevel).localeCompare(String(b.gradeLevel), undefined, { numeric: true });
      if (g) return g;
      var l = String(a.lastName).localeCompare(String(b.lastName));
      return l || String(a.firstName).localeCompare(String(b.firstName));
    });
    counts.pct = counts.eligible ? Math.round((counts.perfect / counts.eligible) * 1000) / 10 : 0;
    return { students: out, counts: counts, window: win };
  }

  // =====================================================================
  // PERFECT ATTENDANCE FOR A CHOSEN MONTH, SORTED, ON PAPER (2026-10-01)
  //
  // The owner, 2026-10-01: "sort/filter by specific month and not just 'this
  // month'", and print the lists by filter. The Month tab now picks any month
  // of this school year; "this month" is just the one it starts on.
  //
  // THE SAME RULES, A DIFFERENT WINDOW. perfectVerdict and perfectList are
  // untouched: a past month is judged exactly the way the current one is, so
  // September read in October gives the list September gave on the 30th --
  // provided nothing was corrected in PowerSchool since, which is the point of
  // reading it from the marks rather than from a saved copy.
  //
  // A MONTH IS CLIPPED AT BOTH ENDS.
  //   - Never before the school year. Eligibility is "enrolled on or before
  //     window.from", so an August window from the 1st would call everybody
  //     who enrolled on the first day of school a late arrival. August is
  //     "from 12 Aug" instead.
  //   - Never after today. A mark entered ahead of time for tomorrow is not a
  //     day anyone has missed yet, and a month still running says "so far".
  //
  // Calendar days in UTC, like dayFrom above, never local time.
  // =====================================================================

  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  /**
   * A REAL day or null. dayFrom rolls "2026-02-30" over to 2 March, which is
   * right for arithmetic and wrong for input: a month list built from a date
   * that does not exist would be built from a different one.
   */
  function realDay(iso) {
    var d = dayFrom(iso);
    if (!d) return null;
    var out = isoOf(d);
    return out === String(iso).slice(0, 10) ? out : null;
  }

  /** "12 Aug", from "YYYY-MM-DD". No locale and no time zone in it. */
  function shortDay(d) {
    return d.getUTCDate() + ' ' + MONTH_NAMES[d.getUTCMonth()].slice(0, 3);
  }

  /** "21 to 25 Sep 2026", "28 Sep to 2 Oct 2026", "29 Dec 2026 to 2 Jan 2027". */
  function dayRange(fromIso, toIso) {
    var a = dayFrom(fromIso), b = dayFrom(toIso);
    if (!a || !b) return '';
    var sameYear = a.getUTCFullYear() === b.getUTCFullYear();
    var sameMonth = sameYear && a.getUTCMonth() === b.getUTCMonth();
    var left = sameMonth ? String(a.getUTCDate())
      : shortDay(a) + (sameYear ? '' : ' ' + a.getUTCFullYear());
    return left + ' to ' + shortDay(b) + ' ' + b.getUTCFullYear();
  }

  function monthName(key) {
    return MONTH_NAMES[+key.slice(5, 7) - 1] + ' ' + key.slice(0, 4);
  }

  /** "October 2026 (so far)", "August 2026 (from 12 Aug)", "September 2026". */
  function monthChoiceLabel(w) {
    var notes = [];
    if (w.clamped) notes.push('from ' + shortDay(dayFrom(w.from)));
    if (w.partial) notes.push('so far');
    return monthName(w.month) + (notes.length ? ' (' + notes.join(', ') + ')' : '');
  }

  /**
   * One month of this school year, as a window perfectVerdict can judge.
   * `monthKey` is "YYYY-MM". Null for a month with no school days in it yet:
   * one after today, or one that ended before the year began.
   */
  function perfectMonthWindow(monthKey, todayIso, yearStartIso) {
    var key = String(monthKey || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return null;
    var today = realDay(todayIso), start = realDay(yearStartIso);
    if (!today || !start) return null;
    var first = key + '-01';
    var last = lastDayOfMonth(first);
    var from = first < start ? start : first;
    var to = last > today ? today : last;
    if (from > to) return null;
    // "SO FAR" UNTIL THE MONTH IS OVER, its last day included (review,
    // 2026-10-01). Today's marks are still coming in all day -- the 06:30
    // rebuild carries yesterday, the 12:30 one half of today -- so a list read
    // on 30 September is not yet September's list. Calling it finished on the
    // 30th printed a child late that afternoon on a sheet headed "September
    // 2026", and the corrected list the next morning carried the same name.
    var partial = last >= today;
    return {
      key: 'month', month: key, from: from, to: to,
      // The screen's sentence reads "October 2026 so far: 1 Oct to 1 Oct".
      label: monthName(key) + (partial ? ' so far' : ''),
      partial: partial, clamped: from > first
    };
  }

  /**
   * Every month the Month tab can offer, NEWEST FIRST, so the month you most
   * likely want is at the top: from this month back to the one the school
   * year started in. [] for bad input or a year that has not started.
   *
   * The 24 is a guard on the loop, not a policy: a school year is never more
   * than thirteen calendar months, and a start date typed with the wrong
   * century must not build a dropdown of a thousand months.
   */
  var PERFECT_MONTHS_MAX = 24;

  function perfectMonths(todayIso, yearStartIso) {
    var today = realDay(todayIso), start = realDay(yearStartIso);
    if (!today || !start || start > today) return [];
    var out = [];
    var y = +today.slice(0, 4), m = +today.slice(5, 7);
    for (var n = 0; n < PERFECT_MONTHS_MAX; n++) {
      var key = String(y) + '-' + (m < 10 ? '0' : '') + m;
      var w = perfectMonthWindow(key, today, start);
      if (!w) break;
      out.push({
        key: key, label: monthChoiceLabel(w), from: w.from, to: w.to,
        partial: w.partial, clamped: w.clamped
      });
      m--;
      if (m === 0) { m = 12; y--; }
    }
    return out;
  }

  /**
   * The period, in the words a printed list is headed with: "September
   * 2026", "October 2026 (so far)", "Week of 21 to 25 Sep 2026", "Year to
   * date, 12 Aug to 1 Oct 2026". A sheet of paper outlives the screen it came
   * from, so the year is always in it.
   */
  function perfectPeriodName(win) {
    if (!win || !win.from || !win.to) return '';
    if (win.key === 'month' && win.month) return monthChoiceLabel(win);
    if (win.key === 'week') return 'Week of ' + dayRange(win.from, win.to);
    if (win.key === 'year') return 'Year to date, ' + dayRange(win.from, win.to);
    return (win.label ? win.label + ', ' : '') + dayRange(win.from, win.to);
  }

  /**
   * The window's exact days, "1 to 29 Sep 2026", for the line under a printed
   * month's heading (review, 2026-10-01). A week and the year to date carry
   * their dates in the heading; "September 2026 (so far)" does not, and a
   * list drawn on the 29th and printed on the 1st would otherwise read as the
   * whole month.
   */
  function perfectPeriodDates(win) {
    return win && win.from && win.to ? dayRange(win.from, win.to) : '';
  }

  /**
   * The orders the list can be read in. "Grade, then last name" is the order
   * the list has always had, so it stays the default.
   */
  var PERFECT_SORTS = [
    { key: 'grade', label: 'Grade, then last name', fields: ['gradeLevel', 'lastName', 'firstName'] },
    { key: 'last', label: 'Last name', fields: ['lastName', 'firstName'] },
    { key: 'first', label: 'First name', fields: ['firstName', 'lastName'] },
    { key: 'id', label: 'Student ID', fields: ['studentNumber'] }
  ];

  /**
   * Case-insensitive, numeric-aware: "diaz" sits with "Diaz", grade 9 before
   * 10, ID 999 before 1001. A BLANK SORTS LAST rather than first, so a list
   * read aloud never opens on a student with no name or grade recorded --
   * the same place the grade filter puts "No grade recorded".
   */
  function compareField(a, b) {
    var x = String(a == null ? '' : a).trim().toLowerCase();
    var y = String(b == null ? '' : b).trim().toLowerCase();
    if (x === y) return 0;
    if (!x) return 1;
    if (!y) return -1;
    return x.localeCompare(y, undefined, { numeric: true });
  }

  /**
   * perfectList's students in the chosen order, as a NEW array. STABLE on
   * purpose, and by position rather than by trusting the engine: two Ana
   * Diazes keep the order they came in, so the screen and the printed sheet
   * built from the same list can never disagree about who is first. An
   * unknown key reads as the default.
   */
  function perfectSort(students, sortKey) {
    var spec = PERFECT_SORTS[0];
    for (var k = 0; k < PERFECT_SORTS.length; k++) {
      if (PERFECT_SORTS[k].key === sortKey) spec = PERFECT_SORTS[k];
    }
    var fields = spec.fields;
    var tagged = (students || []).map(function (s, i) { return { s: s || {}, i: i }; });
    tagged.sort(function (a, b) {
      for (var f = 0; f < fields.length; f++) {
        var c = compareField(a.s[fields[f]], b.s[fields[f]]);
        if (c) return c;
      }
      return a.i - b.i;
    });
    return tagged.map(function (t) { return t.s; });
  }

  // =====================================================================
  // WHO WAS MISSING IN A WEEK OR A MONTH (2026-09-23)
  //
  // Attendance Watch's "Who is missing" ranks the YEAR, against the chronic
  // absence tiers. The owner asked for a week and a month as well -- the
  // question a Monday meeting and a monthly report ask. Two rules differ from
  // the year view, on purpose:
  //
  //   - NO CHRONIC TIERS. "Chronic" and "severe" are year-scale definitions
  //     (10% and 20% of the days in session). In a five-day week one absence
  //     is 20%, so the year's labels would call every absent child severe.
  //     A window gets plain bands instead: every day, half or more, at least
  //     one.
  //   - THE DENOMINATOR IS THE DAYS SCHOOL RAN in the window, per student --
  //     from the day they enrolled, if that falls inside it -- never weekdays.
  // =====================================================================

  function lastDayOfMonth(iso) {
    var d = dayFrom(iso.slice(0, 8) + '01');
    if (!d) return null;
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(0);
    return isoOf(d);
  }

  /**
   * Last school day, last week, this week so far, last month, this month so
   * far -- from today.
   *
   * A WEEK IS MONDAY TO FRIDAY, and "Last week" is lastFinishedWeek: the same
   * week Perfect attendance calls "Last week", weekends included (2026-10-07;
   * before, on a Saturday or Sunday this said the week before). "This week so
   * far" is the week after it, so on a weekend it is the coming week and has
   * no finished day yet -- an empty window, which the screen says in words.
   *
   * LAST SCHOOL DAY (2026-10-07) is the morning question, "who was out
   * yesterday?": `lastSchoolDay` is the newest finished date school ran, from
   * the school-day calendar. Without it, the last finished weekday.
   *
   * ONLY COMPLETED DAYS. `completeThrough` is the last day whose attendance
   * is fully in -- yesterday, at the latest: the 06:30 sync carries yesterday,
   * and the 12:30 one carries a half-taken today, in which every afternoon
   * period not yet reached reads as unrecorded and every absence as partial.
   * Before school, today's only rows are absences entered ahead of time, which
   * would make today a "school day" two children missed. A window that runs
   * past `completeThrough` ends there; one that starts after it is empty.
   */
  function absenceWindows(todayIso, completeThrough, lastSchoolDay) {
    var today = dayFrom(todayIso);
    if (!today) return null;
    var iso = isoOf(today);
    var lw = lastFinishedWeek(iso);
    var lastMonday = lw.from;
    var lastFriday = lw.to;
    var thisMonday = shiftDays(lastMonday, 7);
    var thisFriday = shiftDays(thisMonday, 4);
    var monthStart = iso.slice(0, 8) + '01';
    var prevMonthEnd = shiftDays(monthStart, -1);
    var prevMonthStart = prevMonthEnd.slice(0, 8) + '01';
    var yesterday = shiftDays(iso, -1);
    var through = /^\d{4}-\d{2}-\d{2}$/.test(String(completeThrough || ''))
      ? String(completeThrough).slice(0, 10) : yesterday;
    if (through > yesterday) through = yesterday;
    var mk = function (key, from, to, label) {
      var capped = to > through;
      return { key: key, from: from, to: capped ? through : to, label: label, capped: capped, through: through };
    };
    // Without the calendar, the last WEEKDAY up to `through`: on a Monday
    // that is Friday, not the Sunday before (review, 2026-10-07).
    var lastDay = through;
    for (var back = 0; back < 2 && [0, 6].indexOf(dayFrom(lastDay).getUTCDay()) >= 0; back++) lastDay = shiftDays(lastDay, -1);
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(lastSchoolDay || '')) && String(lastSchoolDay).slice(0, 10) <= through) {
      lastDay = String(lastSchoolDay).slice(0, 10);
    }
    return {
      lastDay: mk('lastDay', lastDay, lastDay, 'Last school day'),
      lastWeek: mk('lastWeek', lastMonday, lastFriday, 'Last week'),
      thisWeek: mk('thisWeek', thisMonday, thisFriday, 'This week so far'),
      lastMonth: mk('lastMonth', prevMonthStart, lastDayOfMonth(prevMonthStart), 'Last month'),
      thisMonth: mk('thisMonth', monthStart, lastDayOfMonth(monthStart), 'This month so far')
    };
  }

  // =====================================================================
  // THE SCHOOL-DAY COUNT (2026-10-07)
  //
  // Every year-to-date percentage on Attendance Watch, Early Warning's
  // attendance points and Student groups divide by "school days so far". It
  // was two boxes on Attendance Watch -- a start date and a holiday count --
  // that were saved nowhere, reset to 12 Aug and 2 on every page load, could
  // be changed by a view-only reader, and went wrong after every holiday
  // unless somebody retyped them.
  //
  // IT IS COUNTED NOW, from psAbsenceDayTotals: one row per date PowerSchool
  // took attendance, written by the twice-daily absence rebuild. The same
  // table already gives Week or month its school days and the referral
  // chaser its calendar, so a holiday drops out by itself.
  //
  // THE RULE: dates before today that have a row, PLUS TODAY ONCE THE YEAR
  // TOTALS HOLD IT. A future date PowerSchool already holds absences for never
  // counts. Measured 2026-10-07: 38 before today, the same as the old boxes'
  // 40 weekdays less 4 Sep and 7 Sep.
  //
  // WHY TODAY JOINS AT LUNCHTIME (review, 2026-10-07). The count is a
  // DIVISOR, and what it divides is PowerSchool's year total
  // (psAttendance.daysAbsentYtd), which counts every absence date on file --
  // today's included. The 12:00 copy of those totals carries today's
  // absences, so from then on a count that left today out divided 39 days of
  // absences by 38 days and over-flagged: replayed on past afternoons whose
  // count was a multiple of 5, Chronic and severe read 334 against 278 (25
  // Sep) and 315 against 188 (26 Aug). So today counts exactly when the
  // totals' own stamp (`totalsAt`, schoolAttendance's lastSyncedAt) is today
  // at or after 10:00 in Los Angeles, and today is a school day: it has a row,
  // or the absence rebuild has not yet copied today (12:00 to 12:30) and it
  // is a weekday -- counting a day there is the safe direction. The old boxes
  // also counted today from noon. Without the stamp, today is not counted.
  //
  // WHEN THE COPY IS LATE, judged by the rebuild's OWN stamp, not a clock
  // rule. Every good rebuild rewrites every row with its time (syncedAt); a
  // refused or failed run writes nothing and leaves the last good copy. A
  // copy taken after 10:00 in Los Angeles has seen that day's attendance
  // (the 12:30 run), one taken before it (the 06:30 run) has only seen the
  // day before. Weekdays after the last day a good copy has seen, up to
  // yesterday, with no row, are the only days nobody can vouch for: they are
  // counted as school days (the safe direction -- a larger divisor flags
  // fewer children, never more) and listed, so the screen says so. In normal
  // running that list is always empty, so nothing moves: a missed morning
  // run changes nothing, and the 18-hour gap overnight is not "late".
  //
  // UNKNOWN IS SAID, NOT GUESSED: a refusal, an empty table (it is emptied
  // and refilled in two writes by each rebuild, and an empty table carries
  // no stamp), a read cut short, no stamp, or far fewer days than weekdays.
  // Each comes back known: false with the reason in words. A good copy with
  // no school day on file up to today (before the first day of school) is
  // KNOWN, and is 0.
  // =====================================================================

  /** A copy stamped at or after this hour (Los Angeles) has seen that day's attendance. */
  var CALENDAR_SEEN_HOUR = 10;

  /** The Los Angeles calendar day and hour of an instant, or null. */
  function laDayHour(ms) {
    if (!isFinite(ms)) return null;
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date(ms));
      var get = function (t) {
        for (var i = 0; i < parts.length; i++) if (parts[i].type === t) return parts[i].value;
        return '';
      };
      var hour = Number(get('hour'));
      return { day: get('year') + '-' + get('month') + '-' + get('day'), hour: hour === 24 ? 0 : hour };
    } catch (e) {
      return null;
    }
  }

  /**
   * The school days so far, from attendanceList:dailyAbsenceSeries (asked
   * with today's date, so nothing after today is in it). PURE.
   *
   * `totalsAt` is the stamp of the year totals the count will divide
   * (schoolAttendance's lastSyncedAt): today counts once they hold it.
   *
   * Returns, always:
   *   known            false when the count cannot be trusted; `reason` says why
   *   status           'ok' | 'estimated' (weekdays counted because the copy is late) | 'unknown'
   *   days             school days before today, plus today when `todayCounted`; null when unknown
   *   todayCounted     true when today is in `days` (the totals' copy holds today)
   *   first            the first school day on file ("YYYY-MM-DD")
   *   weekdays, off    weekdays from `first` to the last day counted, and those that were not school days
   *   estimated        the weekdays counted without a row, oldest first
   *   lastSchoolDay    the newest FINISHED school day (Week or month's "Last school day")
   *   finishedThrough  the last day whose figures are complete: before both today
   *                    and the newest copy's own date (absenceWindow's `through`)
   *   confirmedThrough the last day a good copy has seen
   *   lastGoodRun      the newest copy's stamp
   * { first, weekdays, off, days } is the shape attendanceSchoolDays() always had.
   */
  function schoolCalendar(res, todayIso, totalsAt) {
    var out = {
      known: false, status: 'unknown', days: null, todayCounted: false, first: null, weekdays: 0, off: 0,
      estimated: [], lastSchoolDay: null, finishedThrough: null, confirmedThrough: null,
      lastGoodRun: null, onFile: 0, reason: ''
    };
    var unknown = function (why) { out.reason = why; return out; };
    var today = realDay(todayIso);
    if (!today) return unknown('Today’s date could not be read.');
    if (!res) return unknown('The school days have not loaded yet.');
    if (res.allowed === false) {
      return unknown(String(res.reason || 'The school days are not available to your access level.'));
    }
    if (res.truncated) {
      return unknown('The school-day table is longer than this screen reads, so it cannot be counted. Tell an administrator.');
    }
    var dates = [];
    var seen = {};
    (res.points || []).forEach(function (p) {
      var d = realDay(p && p.date);
      if (d && !seen[d]) { seen[d] = true; dates.push(d); }
    });
    dates.sort();
    var onFile = Number(res.schoolDaysOnFile);
    if (!(isFinite(onFile) && onFile >= 0)) onFile = dates.length;
    var stampMs = Date.parse(String(res.syncedAt || ''));
    var la = laDayHour(stampMs);
    // AN EMPTIED TABLE CARRIES NO STAMP: the server stamps the answer from
    // its rows, and the rebuild deletes them all in one write before it
    // writes them again.
    // NOBODY IS ASKED TO PRESS ANYTHING (review, 2026-10-07): the loader
    // never keeps an emptied read as fresh, so the next draw asks again.
    if (!onFile && !la) {
      return unknown('No school days are on file right now. Before the first day of school that is expected. '
        + 'Otherwise the twice-daily copy from PowerSchool is part-way through, and the count comes back by itself '
        + 'the next time this tab is opened.');
    }
    if (!la) return unknown('The school days carry no copy time, so nothing can vouch for them.');

    var yesterday = shiftDays(today, -1);
    var confirmed = la.hour >= CALENDAR_SEEN_HOUR ? la.day : shiftDays(la.day, -1);
    if (confirmed > yesterday) confirmed = yesterday;
    var finished = shiftDays(la.day, -1);
    if (finished > yesterday) finished = yesterday;
    if (!onFile) {
      // BEFORE THE FIRST DAY OF SCHOOL (review, 2026-10-07): a good, stamped
      // copy with no school day up to today -- its only rows are absences
      // entered ahead. That is a fact, not a fault: 0 school days so far.
      out.known = true;
      out.status = 'ok';
      out.days = 0;
      out.finishedThrough = finished;
      out.confirmedThrough = confirmed;
      out.lastGoodRun = String(res.syncedAt);
      out.reason = 'School has not started yet: PowerSchool has no attendance on file up to today.';
      return out;
    }
    var first = realDay(res.firstDate) || (dates.length && dates.length >= onFile ? dates[0] : null);
    if (!first) return unknown('The first school day could not be read.');

    // Rows dated today or later: never counted as days BEFORE today.
    var notYet = dates.filter(function (d) { return d >= today; }).length;
    var before = Math.max(0, onFile - notYet);
    var estimated = [];
    for (var d = shiftDays(confirmed, 1), n = 0; d && d <= yesterday && n < 400; d = shiftDays(d, 1), n++) {
      var dow = dayFrom(d).getUTCDay();
      if (dow !== 0 && dow !== 6 && !seen[d] && d >= first) estimated.push(d);
    }
    // TODAY, ONCE THE YEAR TOTALS HOLD IT (see THE RULE above): their copy is
    // stamped today at or after 10:00, and today is a school day -- it has a
    // row, or the absence rebuild has not copied today yet and it is a weekday.
    var totals = laDayHour(Date.parse(String(totalsAt || '')));
    var rebuildSawToday = la.day === today && la.hour >= CALENDAR_SEEN_HOUR;
    var todayDow = dayFrom(today).getUTCDay();
    var todayCounted = !!totals && totals.day === today && totals.hour >= CALENDAR_SEEN_HOUR && today >= first
      && (seen[today] === true || (!rebuildSawToday && todayDow !== 0 && todayDow !== 6));
    var days = before + estimated.length + (todayCounted ? 1 : 0);
    var countedTo = todayCounted ? today : yesterday;
    var weekdays = countedTo >= first ? schoolDaysElapsed(first, countedTo) : 0;
    if (weekdays >= 10 && days < weekdays * 0.5) {
      return unknown('Far fewer school days are on file (' + days + ') than weekdays since the first one ('
        + weekdays + '), so the count cannot be trusted. Tell an administrator.');
    }
    var lastSchoolDay = null;
    dates.forEach(function (x) { if (x <= finished) lastSchoolDay = x; });
    out.known = true;
    out.status = estimated.length ? 'estimated' : 'ok';
    out.days = days;
    out.todayCounted = todayCounted;
    out.first = first;
    out.weekdays = weekdays;
    out.off = Math.max(0, weekdays - days);
    out.estimated = estimated;
    out.lastSchoolDay = lastSchoolDay;
    out.finishedThrough = finished;
    out.confirmedThrough = confirmed;
    out.lastGoodRun = String(res.syncedAt);
    out.onFile = before;
    return out;
  }

  /**
   * The daily series cut to FINISHED days (2026-10-07): before both today and
   * the newest copy's own date, the rule Week or month already used. The
   * chart plotted today's half-taken day as a false dip (6 whole-day
   * absences against a median of 42 at the 12:30 copy), and before the 06:30
   * copy yesterday's lunchtime half-day too. `last` most recent, oldest first.
   */
  function finishedSeries(points, cal, last) {
    if (!cal || !cal.finishedThrough) return [];
    var through = cal.finishedThrough;
    var rows = (points || []).filter(function (p) {
      var d = String(p && p.date || '').slice(0, 10);
      return d.length === 10 && d <= through;
    });
    var n = Number(last) > 0 ? Math.floor(Number(last)) : rows.length;
    return rows.slice(-n);
  }

  // =====================================================================
  // THE LISTS: BANDS AND KINDS OF ABSENCE (2026-10-07)
  //
  // Year so far and Week or month each had one row of seven buttons that
  // mixed two questions -- HOW MUCH (chronic and severe, severe only, at risk)
  // and WHAT KIND (full days, never a full day, tardies) -- so only one could
  // be chosen at a time. They are two controls now: band chips (the old tier
  // cards, clickable) and a "Kind of absence" select, and they combine.
  //
  // EVERY OLD LIST IS STILL ONE CHOICE AWAY, with the same students in the
  // same order (attendance-nav.test.mjs runs the old filters against these):
  //   Chronic & severe   band chronicPlus                Severe only   band severe
  //   At risk            band at-risk                    Everyone      band all
  //   Full days          band all + Has whole days       Tardies       band all + Has tardies
  //   Never a full day   band all + Only partial days
  //   (a week or month)  Missed a day / Half or more / Every day = the band chips.
  //
  // A row here is { daysAbsent, daysTardy, whole, splitAbsent, tier | band }:
  // `whole` is the whole days out of school, or null where the
  // period-by-period record cannot say (never a zero for unknown).
  // =====================================================================

  var ATTENDANCE_KINDS = [
    { key: 'any', label: 'Any absence' },
    { key: 'whole', label: 'Has whole days' },
    { key: 'partial', label: 'Only partial days' },
    { key: 'tardy', label: 'Has tardies' }
  ];

  function attendanceKindMatch(kind, row) {
    var r = row || {};
    if (kind === 'whole') return r.whole !== null && r.whole !== undefined && r.whole > 0;
    if (kind === 'partial') {
      return r.whole !== null && r.whole !== undefined && r.whole === 0 && (Number(r.splitAbsent) || 0) > 0;
    }
    if (kind === 'tardy') return (Number(r.daysTardy) || 0) > 0;
    return true;
  }

  /** The year's bands: the chronic tiers, plus "chronic and severe" (the default) and everyone. */
  var YEAR_BANDS = [
    { key: 'chronicPlus', label: 'Chronic and severe', sub: '10% or more' },
    { key: 'severe', label: 'Severe', sub: '20% or more' },
    { key: 'chronic', label: 'Chronic', sub: '10% to 20%' },
    { key: 'at-risk', label: 'At risk', sub: '5% to 10%' },
    { key: 'satisfactory', label: 'Satisfactory', sub: 'under 5%' },
    { key: 'all', label: 'Everyone', sub: '' }
  ];

  function yearBandMatch(band, row) {
    var t = row && row.tier ? (row.tier.key || row.tier) : null;
    if (band === 'all') return true;
    if (band === 'chronicPlus') return t === 'severe' || t === 'chronic';
    return t === band;
  }

  /** A week's or month's "at least" bands: plain words, never the year's chronic labels. */
  var WINDOW_CHIPS = [
    { key: 'some', label: 'Missed a day', one: 'Missed the day' },
    { key: 'half', label: 'Missed half or more' },
    { key: 'every', label: 'Missed every day' },
    { key: 'tardy', label: 'Late at least once', one: 'Late' },
    { key: 'all', label: 'Everyone' }
  ];

  function windowBandMatch(band, row) {
    var r = row || {};
    var b = r.band ? (r.band.key || r.band) : 'none';
    if (band === 'all') return true;
    if (band === 'tardy') return (Number(r.daysTardy) || 0) > 0;
    if (band === 'some') return (Number(r.daysAbsent) || 0) > 0;
    if (band === 'half') return b === 'every' || b === 'half';
    if (band === 'every') return b === 'every';
    return false;
  }

  /**
   * A list's own order before anyone clicks a heading: the order the old
   * button gave, exactly. `rows` arrive in the ranking's order (year:
   * attendanceRanking, worst first; window: windowAbsenceList). A new array.
   *
   *   year   any / partial  as ranked            whole  most whole days first
   *          tardy          most tardies first   (ties keep the ranked order)
   *   window any            out of school first: most days, then whole days,
   *                         then FEWER tardies (a child late every morning is in school)
   *          whole / tardy  most of that, then most days absent
   *          partial        as listed
   */
  function attendanceListOrder(rows, view, kind) {
    var list = (rows || []).slice();
    var num = function (v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; };
    var wholeOr = function (r, dflt) { return (r.whole === null || r.whole === undefined) ? dflt : r.whole; };
    var stable = function (cmp) {
      return list.map(function (r, i) { return { r: r, i: i }; })
        .sort(function (a, b) { return cmp(a.r, b.r) || (a.i - b.i); })
        .map(function (x) { return x.r; });
    };
    if (view === 'window') {
      if (kind === 'whole') return stable(function (a, b) { return (wholeOr(b, 0) - wholeOr(a, 0)) || (num(b.daysAbsent) - num(a.daysAbsent)); });
      if (kind === 'tardy') return stable(function (a, b) { return (num(b.daysTardy) - num(a.daysTardy)) || (num(b.daysAbsent) - num(a.daysAbsent)); });
      if (kind === 'partial') return list;
      return stable(function (a, b) {
        return (num(b.daysAbsent) - num(a.daysAbsent)) || (wholeOr(b, -1) - wholeOr(a, -1))
          || (num(a.daysTardy) - num(b.daysTardy)) || (num(b.rate) - num(a.rate));
      });
    }
    if (kind === 'whole') return stable(function (a, b) { return wholeOr(b, 0) - wholeOr(a, 0); });
    if (kind === 'tardy') return stable(function (a, b) { return num(b.daysTardy) - num(a.daysTardy); });
    return list;
  }

  /**
   * SEARCH LOOKS AT EVERYONE ON THE TAB, not only the chosen band (2026-10-07):
   * a child outside "Chronic and severe" used to answer "No students match
   * this filter" until somebody thought to press Everyone. `rows` is every row
   * in the grade scope; each match says whether it is inside the band and
   * kind on screen, so the table can shade the ones that are not.
   */
  function attendanceSearch(rows, query, inside) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return null;
    var hits = [];
    (rows || []).forEach(function (r) {
      var st = (r && r.student) || {};
      var name = ((st.firstName || '') + ' ' + (st.lastName || '')).toLowerCase();
      var num = String(st.studentNumber || (r && r.studentNumber) || '').toLowerCase();
      if (name.indexOf(q) !== -1 || num.indexOf(q) !== -1) hits.push(r);
    });
    var outside = typeof inside === 'function' ? hits.filter(function (r) { return !inside(r); }).length : 0;
    return { rows: hits, outside: outside };
  }

  /** The band a window row falls in. Plain words, no chronic labels. */
  var WINDOW_BANDS = [
    { key: 'every', label: 'Every day' },
    { key: 'half', label: 'Half or more' },
    { key: 'some', label: 'Missed a day' },
    { key: 'none', label: 'No absences' }
  ];
  function windowBand(daysAbsent, schoolDays) {
    if (!(schoolDays > 0) || !(daysAbsent > 0)) return WINDOW_BANDS[3];
    if (daysAbsent >= schoolDays) return WINDOW_BANDS[0];
    if (daysAbsent * 2 >= schoolDays) return WINDOW_BANDS[1];
    return WINDOW_BANDS[2];
  }

  /**
   * Every student's absences and tardies inside one window.
   *
   * `marks` is attendanceList:attendanceMarks rows (the dates); `schoolDays` is
   * the list of dates school ran in the window (from the server). A date in
   * `marks` that is not a school day in the window -- entered ahead of time, or
   * on a date the per-date rebuild has no record of -- is not counted: the
   * numerator and the denominator come from the same days, so a rate can
   * never pass 100%.
   *
   * ENROLMENT IS PART OF THE ANSWER. A student who arrived on Wednesday had a
   * three-day week, and "3 of 5" would overstate them.
   *
   * RANKED WORST FIRST: most days absent, then the larger share of the
   * window, then FEWER tardies (a child late every morning is in school; the
   * screen adds whole days above this when it has them), then by number for a
   * stable order.
   */
  function windowAbsenceList(marks, schoolDays, win) {
    var days = (schoolDays || []).filter(function (d) {
      return (!win || !win.from || d >= win.from) && (!win || !win.to || d <= win.to);
    }).slice().sort();
    var daySet = {};
    days.forEach(function (d) { daySet[d] = true; });
    var rows = [], counts = { every: 0, half: 0, some: 0, none: 0, tardy: 0, considered: 0 };
    (marks || []).forEach(function (m) {
      if (!m) return;
      var entry = String(m.entryDate || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) entry = '';
      // A RECORDED absence or tardy before the entry date means the student
      // was there to miss it (a re-entry): PowerSchool counts it, so this
      // does too, from the earliest such day.
      if (entry) {
        [].concat(m.absentDates || [], m.tardyDates || []).forEach(function (x) {
          var d = String(x || '').slice(0, 10);
          if (daySet[d] && d < entry) entry = d;
        });
      }
      var mine = entry ? days.filter(function (d) { return d >= entry; }) : days;
      // NOT ENROLLED IN THIS WINDOW AT ALL (arrived after it): not a row, not
      // a count. Listing them as "0 of 0 days" read as a perfect week.
      if (days.length && !mine.length) return;
      var mineSet = {};
      mine.forEach(function (d) { mineSet[d] = true; });
      var uniq = function (list) {
        var seen = {}, out = [];
        (list || []).forEach(function (x) {
          var d = String(x || '').slice(0, 10);
          if (mineSet[d] && !seen[d]) { seen[d] = true; out.push(d); }
        });
        return out.sort();
      };
      var absent = uniq(m.absentDates);
      var tardy = uniq(m.tardyDates);
      var band = windowBand(absent.length, mine.length);
      counts.considered++;
      counts[band.key]++;
      if (tardy.length) counts.tardy++;
      rows.push({
        studentNumber: String(m.studentNumber || ''),
        daysAbsent: absent.length,
        daysTardy: tardy.length,
        schoolDays: mine.length,
        rate: mine.length ? absent.length / mine.length : 0,
        band: band,
        enrolledSince: (entry && mine.length < days.length) ? entry : null,
        absentDates: absent,
        tardyDates: tardy
      });
    });
    rows.sort(function (a, b) {
      return (b.daysAbsent - a.daysAbsent) || (b.rate - a.rate) || (a.daysTardy - b.daysTardy)
        || String(a.studentNumber).localeCompare(String(b.studentNumber));
    });
    return { rows: rows, counts: counts, schoolDays: days, window: win };
  }

  // =====================================================================
  // THE ATTENDANCE-RATE RUN CHART (2026-09-23)
  //
  // The daily chart above plots absence COUNTS. This one plots a RATE that
  // resets every period -- a week, or a month -- against a MEDIAN, per the
  // owner's spec (Provost & Murray, The Health Care Data Guide, ch. 3):
  //
  //   weekly attendance rate  = 1 - whole days out / student-days enrolled
  //   monthly days absent     = whole days out / students enrolled that month
  //   monthly chronic rate    = share of students out 10%+ of THEIR days that month
  //
  // WHY A RATE THAT RESETS: the year-to-date chronic figure cannot be charted.
  // Each week's cumulative number contains nearly all of the week before (the
  // points are not independent, and every rule below assumes they are), and
  // its threshold moves under it -- 10% of days elapsed is 1 absence one week
  // and 2 the next, so students change status with no change in behaviour.
  //
  // The rows come from attendanceRunChartData:series: one per school day per
  // grade band, `members` enrolled that day and the components of their
  // absences. The whole-day threshold is applied HERE, the same way every
  // other screen applies it (absenceSplit).
  // =====================================================================

  /**
   * Whole days out on one day row, at the screen's misrecord threshold --
   * through absenceSplit, the one rule every other screen uses, so this chart
   * can never disagree with the list below it about what a whole day is.
   */
  function runDayFull(row, settings) {
    var sp = absenceSplit(row, settings);
    return sp ? sp.fullDays : 0;
  }

  /** The Monday of a date's week, "YYYY-MM-DD". */
  function weekOf(iso) {
    var d = dayFrom(iso);
    if (!d) return null;
    return shiftDays(isoOf(d), -((d.getUTCDay() + 6) % 7));
  }

  /**
   * The day rows for one series, summed per date. 'all' adds the bands.
   * Returns [{ date, yearid, members, full }] in date order.
   */
  function runSeriesDays(rows, series, settings) {
    var byDate = {};
    (rows || []).forEach(function (r) {
      if (!r || !r.date) return;
      if (series !== 'all' && r.band !== series) return;
      var k = r.date;
      if (!byDate[k]) byDate[k] = { date: k, yearid: r.yearid, members: 0, full: 0, estimated: false };
      byDate[k].members += Number(r.members) || 0;
      byDate[k].full += runDayFull(r, settings);
      if (r.gradeEstimated) byDate[k].estimated = true;
    });
    return Object.keys(byDate).sort().map(function (k) { return byDate[k]; });
  }

  /**
   * THE WEEKS, and which of them are merged.
   *
   * DENOMINATOR CHECK (the owner's rule): a week whose student-days enrolled
   * is more than 25% off the average week of its school year is flagged. A
   * three-day week is noisier for no real reason -- fewer days, not a change.
   *
   * WHAT TO DO WITH ONE is the owner's choice, and the default was chosen for
   * them on 2026-09-23 with reasons: MERGE it into the week after (the week
   * before, if it is the last of its year). Dropping throws away exactly the
   * holiday weeks the baseline exists to capture; deciding week by week
   * invites cherry-picking. `policy` 'separate' keeps them apart and flagged,
   * 'drop' leaves them out.
   *
   * DECIDED ON THE WHOLE-SCHOOL SERIES and applied to every band, so the lines
   * on one chart are the same periods and stay aligned in time. Never merged
   * across school years: the summer is not a week.
   */
  function runWeekGroups(allDays, policy, today) {
    var weeks = [];
    var byKey = {};
    // THE WEEK IN PROGRESS IS LEFT OFF. On a Wednesday it holds two days, so
    // it would read as a short week and be merged into last week -- changing
    // a point that was already settled. It joins the chart once it is over.
    var t = dayFrom(today);
    var openWeek = t && t.getUTCDay() >= 1 && t.getUTCDay() <= 5 ? weekOf(today) : null;
    (allDays || []).forEach(function (d) {
      if (openWeek && weekOf(d.date) >= openWeek) return;
      var k = weekOf(d.date) + '|' + d.yearid;
      if (!byKey[k]) { byKey[k] = { week: weekOf(d.date), yearid: d.yearid, dates: [], memberDays: 0 }; weeks.push(byKey[k]); }
      byKey[k].dates.push(d.date);
      byKey[k].memberDays += d.members;
    });
    weeks.sort(function (a, b) { return a.week < b.week ? -1 : a.week > b.week ? 1 : 0; });
    // THE YARDSTICK IS A FULL WEEK, and it does not move. The first version
    // measured each week against the average week so far, which is dragged
    // down by the holiday weeks themselves and changes every week -- so a
    // week near the line could be merged in October and un-merged in March,
    // rewriting points already read. A full week is five school days of the
    // year's typical enrolment (the median of its daily counts), which only
    // moves as enrolment does. Per school year, so a year with more students
    // is never measured against the other's.
    var full = runYardsticks(allDays);
    weeks.forEach(function (w) {
      var expect = 5 * (full[w.yearid] || 0);
      w.offBy = expect ? (w.memberDays - expect) / expect : 0;
      w.flag = Math.abs(w.offBy) > 0.25 ? (w.offBy < 0 ? 'short' : 'long') : null;
    });
    var lastYear = weeks.reduce(function (m, w) { return w.yearid > m ? w.yearid : m; }, -Infinity);
    var p = policy === 'separate' || policy === 'drop' ? policy : 'merge';
    var groups = [];
    for (var i = 0; i < weeks.length; i++) {
      var w = weeks[i];
      if (w.flag && p === 'drop') continue;
      if (w.flag === 'short' && p === 'merge') {
        var next = weeks[i + 1];
        if (next && next.yearid === w.yearid) {
          // Carried into the next week: that week's group will start here.
          next._carry = (next._carry || []).concat(w._carry || [], [w]);
          continue;
        }
        // THE NEWEST SHORT WEEK OF A YEAR STILL RUNNING WAITS for the week
        // after it. Merged backward now, it would change last week's settled
        // point for a week and then jump forward (found in review: a
        // Thanksgiving week did exactly that). Only a year that is over --
        // a later year is on the chart -- merges its last week backward.
        if (w.yearid === lastYear) { groups.pending = (groups.pending || 0) + 1 + (w._carry || []).length; continue; }
        var prev = groups[groups.length - 1];
        if (prev && prev.yearid === w.yearid) {
          prev.weeks = prev.weeks.concat(w._carry || [], [w]);
          prev.merged = true;
          continue;
        }
      }
      var members = (w._carry || []).concat([w]);
      groups.push({ yearid: w.yearid, weeks: members, merged: members.length > 1,
                    flag: members.length > 1 ? null : w.flag });
    }
    weeks.forEach(function (w) { delete w._carry; });
    var pending = groups.pending || 0;
    var out = groups.map(function (g) {
      var dates = [];
      g.weeks.forEach(function (w) { dates = dates.concat(w.dates); });
      dates.sort();
      return { key: g.weeks[0].week, yearid: g.yearid, from: dates[0], to: dates[dates.length - 1],
               dates: dates, merged: g.merged, flag: g.flag,
               parts: g.weeks.map(function (w) { return { week: w.week, days: w.dates.length, flag: w.flag, offBy: w.offBy }; }) };
    });
    out.pending = pending;
    return out;
  }

  /**
   * A school year's typical enrolment per school day: the MEDIAN of its daily
   * counts, from the whole-school days. The yardstick the denominator check
   * measures a week or a month against. { yearid: members }.
   */
  function runYardsticks(allDays) {
    var by = {};
    (allDays || []).forEach(function (d) { (by[d.yearid] = by[d.yearid] || []).push(d.members); });
    var out = {};
    Object.keys(by).forEach(function (y) { out[y] = runChartMedian(by[y]) || 0; });
    return out;
  }

  /** Monday-to-Friday days in a "YYYY-MM" month. */
  function weekdaysInMonth(month) {
    var d = dayFrom(month + '-01');
    if (!d) return 0;
    var n = 0, m = d.getUTCMonth();
    while (d.getUTCMonth() === m) { var wd = d.getUTCDay(); if (wd >= 1 && wd <= 5) n++; d.setUTCDate(d.getUTCDate() + 1); }
    return n;
  }

  /**
   * The weekly attendance rate for one series, over the given week groups.
   * Each point: { key, from, to, yearid, schoolDays, memberDays, full, value, merged, flag }.
   * `value` is a percentage (0-100), to one decimal.
   */
  function runWeeklyRate(rows, series, groups, settings) {
    var days = runSeriesDays(rows, series, settings);
    var byDate = {};
    days.forEach(function (d) { byDate[d.date] = d; });
    return (groups || []).map(function (g) {
      var md = 0, full = 0, n = 0, est = false;
      g.dates.forEach(function (dt) {
        var d = byDate[dt];
        if (!d) return;
        md += d.members; full += d.full; n++;
        if (d.estimated) est = true;
      });
      return { key: g.key, from: g.from, to: g.to, yearid: g.yearid, schoolDays: n, memberDays: md, full: full,
               value: md ? Math.round((1 - full / md) * 1000) / 10 : null,
               merged: g.merged, flag: g.flag, parts: g.parts || [], estimated: est };
    }).filter(function (p) { return p.value !== null; });
  }

  /**
   * The two monthly measures for one series. `measure` is 'avgAbsent' (whole
   * days out per student) or 'chronic' (% of students out 10%+ of their days).
   * Months whose student-days are more than 25% off their year's average are
   * FLAGGED, and never merged, for a reason in the numbers: a student's month
   * is counted on its own, so "chronic in August" and "chronic in September"
   * cannot be added into one figure -- the same student would be in both.
   * `policy` 'drop' leaves flagged months out; otherwise they stay, marked.
   */
  function runMonthly(months, series, measure, policy, today, dayRows) {
    var by = {};
    // THE MONTH IN PROGRESS IS LEFT OFF, as the week is: a chronic rate over
    // the first six days of a month is a different measure from a month's.
    var openMonth = dayFrom(today) ? String(today).slice(0, 7) : null;
    (months || []).forEach(function (m) {
      if (!m || !m.month) return;
      if (openMonth && m.month >= openMonth) return;
      if (series !== 'all' && m.band !== series) return;
      var k = m.month + '|' + m.yearid;
      if (!by[k]) by[k] = { key: m.month, yearid: m.yearid, students: 0, memberDays: 0, full: 0, chronic: 0, estimated: false };
      by[k].students += Number(m.students) || 0;
      by[k].memberDays += Number(m.memberDays) || 0;
      by[k].full += Number(m.fullDayAbsences) || 0;
      by[k].chronic += Number(m.chronicStudents) || 0;
      if (m.gradeEstimated) by[k].estimated = true;
    });
    var pts = Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
    // THE YARDSTICK, as for weeks: a month's weekdays at the year's typical
    // enrolment, from this series' own days -- fixed, so a month's flag does
    // not change as later months arrive. Without day rows (a caller that has
    // only the month totals), the year's average month instead.
    var sticks = dayRows ? runYardsticks(runSeriesDays(dayRows, series, null)) : null;
    var avg = {};
    pts.forEach(function (p) { var a = avg[p.yearid] || (avg[p.yearid] = { sum: 0, n: 0 }); a.sum += p.memberDays; a.n++; });
    return pts.map(function (p) {
      var a = avg[p.yearid];
      var mean = sticks ? (sticks[p.yearid] || 0) * weekdaysInMonth(p.key) : (a.n ? a.sum / a.n : 0);
      var off = mean ? (p.memberDays - mean) / mean : 0;
      var value = !p.students ? null : measure === 'chronic'
        ? Math.round(p.chronic / p.students * 1000) / 10
        : Math.round(p.full / p.students * 100) / 100;
      return { key: p.key, from: p.key + '-01', to: lastDayOfMonth(p.key + '-01'), yearid: p.yearid, students: p.students,
               memberDays: p.memberDays, full: p.full, chronic: p.chronic, offBy: off, value: value, flag: Math.abs(off) > 0.25 ? (off < 0 ? 'short' : 'long') : null,
               merged: false, estimated: p.estimated };
    }).filter(function (p) { return p.value !== null && !(policy === 'drop' && p.flag); });
  }

  /**
   * SAME WEEK LAST YEAR, for each point: last year's rate over the same
   * calendar weeks, 52 weeks earlier. 364 days, not a year, so a Monday stays
   * a Monday and the seasons line up -- this September against last
   * September, this Thanksgiving week against last Thanksgiving week. A
   * point whose matching weeks had no school last year (a break that fell
   * differently) gets no comparison rather than an invented one.
   *
   * A LINE TO LOOK AT, NEVER A BASELINE. The owner chose (2026-09-24) that no
   * signal rule reads it: warnings come from one normal only, so the chart
   * never says "better" and "worse" about the same week.
   */
  function runLastYearWeekly(rows, series, points, settings, onlyYear) {
    var days = runSeriesDays(rows, series, settings);
    return (points || []).map(function (p) {
      // THE NEWEST YEAR ONLY. With three years on the chart, 2026-27 would
      // otherwise be compared with 2025-26 as well, and those forty weeks
      // would drown the few that the sentence is about (found in review).
      if (onlyYear !== undefined && onlyYear !== null && p.yearid !== onlyYear) return null;
      var start = shiftDays(weekOf(p.from), -364);
      var end = shiftDays(weekOf(p.to), 6 - 364);
      var md = 0, full = 0, n = 0;
      days.forEach(function (d) {
        if (d.yearid !== p.yearid - 1 || d.date < start || d.date > end) return;
        md += d.members; full += d.full; n++;
      });
      return md ? { key: p.key, x: p.x, value: Math.round((1 - full / md) * 1000) / 10, schoolDays: n, from: start, to: end } : null;
    });
  }

  /**
   * The same, by month: this October against last October.
   *
   * ONLY LIKE AGAINST LIKE. A month flagged short on either side is not
   * compared: August had 12 school days last year and 14 this year, and
   * "days absent per student" grows with the days in the month, so the same
   * daily attendance read as "worse" (found in review). For that measure the
   * comparison is also put on this month's footing -- last year's absence
   * per student-day, times this month's enrolled days per student -- so a
   * 21-day month is not judged against a 20-day one. The chronic share is
   * already relative to each student's own days.
   */
  function runLastYearMonthly(months, series, measure, points, days, today, onlyYear) {
    var prev = runMonthly(months, series, measure === 'monthlyChronic' ? 'chronic' : 'avgAbsent', 'merge', today, days);
    var by = {};
    prev.forEach(function (q) { by[q.key + '|' + q.yearid] = q; });
    return (points || []).map(function (p) {
      if (onlyYear !== undefined && onlyYear !== null && p.yearid !== onlyYear) return null;
      var q = by[(Number(p.key.slice(0, 4)) - 1) + p.key.slice(4) + '|' + (p.yearid - 1)];
      if (!q || q.flag || p.flag) return null;
      var value = q.value;
      if (measure === 'monthlyAvgAbsent' && q.students && q.memberDays && p.students && p.memberDays) {
        value = Math.round(q.full / q.memberDays * (p.memberDays / p.students) * 100) / 100;
      }
      return { key: p.key, x: p.x, value: value, raw: q.value, from: q.from, to: q.to, adjusted: value !== q.value };
    });
  }

  /**
   * The plain sentence: how many of this year's periods beat the same period
   * last year, and by how much on average. "Better" follows the measure:
   * higher is better for the attendance rate, lower for days absent and for
   * the chronic share.
   */
  function runVsLastYear(points, ghost, measure) {
    var m = RATE_MEASURES[measure] || RATE_MEASURES.weeklyRate;
    var n = 0, better = 0, worse = 0, same = 0, sum = 0;
    (points || []).forEach(function (p, i) {
      var g = ghost && ghost[i];
      if (!g) return;
      var d = Number(p.value) - Number(g.value);
      n++; sum += d;
      if (Math.abs(d) < 1e-9) same++;
      else if ((d > 0) === m.higherIsBetter) better++;
      else worse++;
    });
    return n ? { n: n, better: better, worse: worse, same: same, avgDiff: Math.round(sum / n * 100) / 100 } : null;
  }

  /** Median absolute deviation, for the astronomical-point prompt. */
  function medianAbsDev(values, med) {
    return runChartMedian((values || []).map(function (v) { return Math.abs(v - med); }));
  }

  /**
   * THE READING OF ONE SERIES, against a frozen or a provisional median.
   *
   * WHY A FROZEN MEDIAN IS NEVER RECALCULATED. This will look like a bug: new
   * points arrive and the median line does not move. It is the method. Once a
   * baseline of 10+ points shows no signal, its median is frozen and extended
   * forward, so every later point is judged against how things WERE. A median
   * recomputed from every point drifts toward any real change -- after enough
   * weeks of better attendance it sits in the middle of them -- and quietly
   * erases the very shift it exists to reveal. To move it, freeze a new
   * baseline on purpose (the old one is kept, with who and why). Do not "fix"
   * this by recomputing the median from `points`.
   *
   * `baseline` is { from, to, median } or null. With it: shift and trend are
   * read over ALL points against the frozen median, and the runs test over the
   * BASELINE points only -- it asks whether the baseline was stable, which is
   * what makes it fit to freeze. Without it: a PROVISIONAL median of every
   * point, said as such; below 10 points nothing is frozen-grade.
   *
   * ASTRONOMICAL POINT: a prompt for judgment, not a rule. Every data set has
   * a highest and a lowest point, and being one of them proves nothing. A
   * point is only offered for a second look when it sits far outside the rest
   * (a robust distance of more than 3.5 median absolute deviations, the
   * Iglewicz-Hoaglin cut-off), and the screen says to ask what happened that
   * week before believing it.
   *
   * `opts.scopeFrom` (optional, used only while nothing is frozen): read the
   * median and every rule from that date on. The owner chose on 2026-09-24
   * that THIS school year is its own normal, and that last year is a
   * comparison to look at -- so last year's points are drawn but not tested,
   * exactly as points before a frozen baseline are not.
   */
  function runChartAnalysis(points, baseline, opts) {
    if (baseline && !isFinite(Number(baseline.median))) baseline = null;
    var pts = (points || []).filter(function (p) { return p && isFinite(Number(p.value)); });
    var frozen = !!(baseline && isFinite(Number(baseline.median)));
    // A POINT BELONGS TO THE BASELINE BY THE DAY IT STARTS. Dates, not keys:
    // a month's key is "2025-10" and would sort before "2025-10-01". And the
    // start alone, so a short week merged one way or the other does not slip
    // a point in or out of a frozen baseline.
    var base = frozen
      ? pts.filter(function (p) { return p.from >= baseline.from && p.from <= baseline.to; })
      : pts;
    // A FROZEN MEDIAN IS CARRIED FORWARD, NEVER BACK. Points before the
    // baseline began are drawn for context but not tested against it: after
    // a re-baseline on a better year, the old year would otherwise read as a
    // "shift below" that is only the reason the baseline was moved. With
    // nothing frozen, `opts.scopeFrom` draws the same line (see above).
    var from = frozen ? baseline.from : (opts && opts.scopeFrom) || null;
    var start = 0;
    if (from) { start = pts.findIndex(function (p) { return p.from >= from; }); if (start < 0) start = pts.length; }
    var median = frozen ? Number(baseline.median) : runChartMedian(pts.slice(start).map(function (p) { return p.value; }));
    var series = pts.slice(start).map(function (p) { return { date: p.key, value: Number(p.value) }; });
    var all = runChartSignals(series, { median: median });
    var shift = function (sp) { return Object.assign({}, sp, { from: sp.from + start, to: sp.to + start }); };
    all.shifts = all.shifts.map(shift);
    all.trends = all.trends.map(shift);
    var runsOn = frozen ? runChartSignals(base.map(function (p) { return { date: p.key, value: Number(p.value) }; }), { median: median }) : all;

    // Against the points' OWN centre, not the frozen median: the question is
    // "far from the rest", and a real, lasting improvement would otherwise
    // make every later point look like a freak. Over the points being read.
    var tested = pts.slice(start);
    var vals = tested.map(function (p) { return Number(p.value); });
    var centre = runChartMedian(vals);
    var mad = medianAbsDev(vals, centre);
    var astronomical = [];
    if (mad && mad > 0) {
      tested.forEach(function (p, i) {
        if (Math.abs(0.6745 * (Number(p.value) - centre) / mad) > 3.5) astronomical.push(i + start);
      });
    }
    var signals = all.signals.filter(function (s) { return s.rule !== 'runs'; });
    if (runsOn.runsVerdict === 'too few' || runsOn.runsVerdict === 'too many') {
      signals = signals.concat(runsOn.signals.filter(function (s) { return s.rule === 'runs'; }).map(function (s) {
        return { rule: 'runs', text: (frozen ? 'In the baseline: ' : '') + s.text };
      }));
    }
    astronomical.forEach(function (i) {
      signals.push({ rule: 'astronomical', text: 'The point for ' + pts[i].key + ' is far outside the rest. '
        + 'Every chart has a highest and a lowest point, so this alone proves nothing: ask what happened that period before believing it.' });
    });
    var flagged = pts.map(function (p, i) { return p.flag ? i : -1; }).filter(function (i) { return i >= 0; });
    return {
      median: median, frozen: frozen,
      status: frozen ? 'frozen' : (pts.length - start >= 10 ? 'provisional' : 'too-few'),
      baselinePoints: base.length, beforeBaseline: frozen ? start : 0,
      // How many points at the start are drawn but not read, and why.
      notTested: start, scope: frozen ? 'baseline' : (start ? 'year' : 'all'),
      shifts: all.shifts, trends: all.trends, astronomical: astronomical, flaggedDenominator: flagged,
      runs: runsOn.runs, runsLimits: runsOn.runsLimits, runsVerdict: runsOn.runsVerdict,
      runsApproximate: runsOn.runsApproximate === true,
      usefulObservations: runsOn.usefulObservations, signals: signals, n: pts.length
    };
  }

  var RATE_MEASURES = {
    weeklyRate:       { label: 'Weekly attendance rate', unit: '%', higherIsBetter: true, period: 'week' },
    monthlyAvgAbsent: { label: 'Whole days absent per student, by month', unit: ' days', higherIsBetter: false, period: 'month' },
    monthlyChronic:   { label: 'Out 10% or more of that month', unit: '%', higherIsBetter: false, period: 'month' }
  };
  var RATE_SERIES = ['all', '6-8', '9-12'];

  /**
   * EVERYTHING THE ATTENDANCE-RATE SCREEN DRAWS, from the server's rows, as
   * plain data -- so the screen only draws and every number is tested here.
   *
   * `res`  what attendanceRunChartData:series returned
   * `opts` { measure, policy, series: [...], settings, today, candidate: {from, to} | null }
   *
   * `candidate` is a range someone is considering as a baseline: each series
   * reports whether THOSE points are signal-free, which is the condition for
   * freezing them (the owner's spec: freeze once the baseline shows no signal).
   */
  function runRateModel(res, opts) {
    var o = opts || {};
    var measure = RATE_MEASURES[o.measure] ? o.measure : 'weeklyRate';
    var policy = o.policy === 'separate' || o.policy === 'drop' ? o.policy : 'merge';
    var shown = (o.series || RATE_SERIES).filter(function (x) { return RATE_SERIES.indexOf(x) !== -1; });
    var days = (res && res.days) || [];
    var months = (res && res.months) || [];
    var groups = null;
    if (measure === 'weeklyRate') {
      groups = runWeekGroups(runSeriesDays(days, 'all', o.settings), policy, o.today);
    }
    var pointsOf = function (sr) {
      return measure === 'weeklyRate'
        ? runWeeklyRate(days, sr, groups, o.settings)
        : runMonthly(months, sr, measure === 'monthlyChronic' ? 'chronic' : 'avgAbsent', policy, o.today, days);
    };

    // THIS SCHOOL YEAR IS ITS OWN NORMAL (the owner, 2026-09-24): while
    // nothing is frozen, the median and the rules read the newest year only.
    var newest = -Infinity;
    var firstOfNewest = null;
    // ONE TIME AXIS for every line, so a week sits at the same x on all three.
    var keyset = {};
    var series = shown.map(function (sr) {
      var pts = pointsOf(sr);
      pts.forEach(function (p) { keyset[p.key] = { key: p.key, from: p.from, to: p.to, yearid: p.yearid }; });
      var baseline = null;
      ((res && res.baselines) || []).forEach(function (b) {
        if (b && b.measure === measure && b.series === sr) baseline = b;
      });
      var analysis = null;          // read below, once the newest year is known
      var cand = null;
      if (o.candidate && o.candidate.from && o.candidate.to) {
        var cpts = pts.filter(function (p) { return p.from >= o.candidate.from && p.from <= o.candidate.to; });
        var ca = runChartAnalysis(cpts, null);
        var blocking = ca.signals.filter(function (x) { return x.rule === 'shift' || x.rule === 'trend' || x.rule === 'runs'; });
        cand = {
          from: cpts.length ? cpts[0].from : null, to: cpts.length ? cpts[cpts.length - 1].from : null,
          n: cpts.length, median: ca.median, blocking: blocking, astronomical: ca.astronomical.length,
          // THE RULE FOR FREEZING, the owner's spec: ten or more points, and
          // no shift, trend or runs signal among them. An astronomical point
          // does not block -- it is a prompt to look -- but it is said.
          canFreeze: cpts.length >= 10 && !blocking.length && ca.median !== null,
          why: cpts.length < 10 ? 'A baseline needs at least 10 points; this range has ' + cpts.length + '.'
            : blocking.length ? 'These points already show a signal, so they are not ordinary variation and cannot be a baseline.'
            : null
        };
      }
      return { series: sr, points: pts, baseline: baseline, analysis: analysis, candidate: cand };
    });
    var axis = Object.keys(keyset).map(function (k) { return keyset[k]; })
      .sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : 0; });
    var indexOf = {};
    axis.forEach(function (a, i) { indexOf[a.key] = i; });
    series.forEach(function (s) { s.points.forEach(function (p) { p.x = indexOf[p.key]; }); });
    // THE NEWEST YEAR COMES FROM THE DATA, not from the finished points. In
    // August the new year has days but no finished week yet; taken from the
    // points, "this year" silently became LAST year, and last year's warnings
    // and a countdown about the wrong year came back (found in review). When
    // this year has nothing finished, nothing is tested yet.
    days.forEach(function (d) { if (d && d.yearid > newest) newest = d.yearid; });
    months.forEach(function (d) { if (d && d.yearid > newest) newest = d.yearid; });
    axis.forEach(function (a) { if (a.yearid > newest) newest = a.yearid; });
    axis.forEach(function (a) { if (a.yearid === newest && firstOfNewest === null) firstOfNewest = a.from; });
    series.forEach(function (s) {
      s.analysis = runChartAnalysis(s.points, s.baseline, { scopeFrom: firstOfNewest || '9999-12-31' });
      s.lastYear = measure === 'weeklyRate'
        ? runLastYearWeekly(days, s.series, s.points, o.settings, newest)
        : runLastYearMonthly(months, s.series, measure, s.points, days, o.today, newest);
      s.vsLastYear = runVsLastYear(s.points, s.lastYear, measure);
    });

    // WHERE A SCHOOL YEAR TURNS OVER: drawn as a line, because the summer is
    // not on the chart and two adjacent points can be ten weeks apart.
    var yearBreaks = [];
    for (var i = 1; i < axis.length; i++) if (axis[i].yearid !== axis[i - 1].yearid) yearBreaks.push(i);

    // A NOTE LANDS ON THE POINT WHOSE PERIOD HOLDS ITS DATE, or the next point
    // when the date fell between them (a weekend, a holiday, the summer).
    var notes = ((res && res.annotations) || []).map(function (n) {
      var at = -1;
      for (var j = 0; j < axis.length; j++) {
        // The Sunday that closes the point's last week, so a note on a
        // weekend lands on the week it ended rather than the next one.
        var end = measure === 'weeklyRate' ? shiftDays(weekOf(axis[j].to), 6) : axis[j].to;
        if (n.date <= end) { at = j; break; }
      }
      return { id: n.id, date: n.date, label: n.label, note: n.note, createdBy: n.createdBy, x: at };
    });

    var ref = series[0] ? series[0].points : [];
    // HOW MANY PERIODS FAILED THE DENOMINATOR CHECK, whatever was then done
    // with them -- so the screen can say "3 short weeks were merged" rather
    // than leaving a merge or a drop invisible.
    var shortPeriods = measure === 'weeklyRate'
      ? runWeekGroups(runSeriesDays(days, 'all', o.settings), 'separate', o.today).filter(function (g) { return g.flag; }).length
      : runMonthly(months, 'all', 'avgAbsent', 'merge', o.today, days).filter(function (p) { return p.flag; }).length;
    // A MONTH WITH NO ROWS inside a year's span is a build that failed (or has
    // not run): named, so the line drawn across it is not read as data.
    var monthsBy = {};
    days.forEach(function (d) { if (d && d.date) (monthsBy[d.yearid] = monthsBy[d.yearid] || {})[d.date.slice(0, 7)] = true; });
    var missingMonths = [];
    Object.keys(monthsBy).forEach(function (y) {
      var have = Object.keys(monthsBy[y]).sort();
      for (var mo = have[0]; mo && mo < have[have.length - 1];) {
        var pp = mo.split('-').map(Number);
        mo = pp[1] === 12 ? (pp[0] + 1) + '-01' : pp[0] + '-' + String(pp[1] + 1).padStart(2, '0');
        if (!monthsBy[y][mo] && mo.slice(5) !== '07') missingMonths.push(mo);
      }
    });
    // The same measure LAST year under the same short-period setting: how
    // many points a whole year gives, which the countdown needs (under
    // "leave off", last year's monthly chart had only 7 -- a tenth month
    // may never come).
    var lastYearPoints = axis.filter(function (a) { return a.yearid === newest - 1; });
    return {
      newestYear: isFinite(newest) ? newest : null, newestFrom: firstOfNewest,
      lastYearAxis: lastYearPoints,
      shortPeriods: shortPeriods, missingMonths: missingMonths,
      pendingWeeks: groups ? (groups.pending || 0) : 0,
      measure: measure, meta: RATE_MEASURES[measure], policy: policy,
      axis: axis, series: series, yearBreaks: yearBreaks, notes: notes,
      flagged: ref.filter(function (p) { return p.flag; }).length,
      merged: ref.filter(function (p) { return p.merged; }).length,
      estimated: ref.some(function (p) { return p.estimated; })
    };
  }

  /**
   * WHAT A SIGNAL ON THIS CHART LIKELY MEANS, in words a person can act on.
   * Kept apart from the rules for the reason absenceSignalBlurb is: a run
   * chart says that something CHANGED and never why, so each reading names
   * what to check, the dull explanation first.
   */
  function rateSignalReading(kind, dirUp, measure) {
    var m = RATE_MEASURES[measure] || RATE_MEASURES.weeklyRate;
    var better = m.higherIsBetter ? dirUp : !dirUp;
    if (kind === 'shift' || kind === 'trend') {
      return better
        ? 'Attendance is better than it was. Before crediting anything, check the calendar: a stretch with no holidays or testing weeks can do this on its own.'
        : 'Attendance is worse than it was. Check the calendar and illness first (a holiday run, flu season), then whether absences started being recorded differently.';
    }
    if (kind === 'runs-few') return 'The measure is drifting rather than bouncing: look for something slow, such as enrolment changing or a policy settling in.';
    if (kind === 'runs-many') return 'Something alternates, which usually means two groups or two recording habits are mixed in one line.';
    return '';
  }

  /**
   * IS THE ATTENDANCE DATA CURRENT? The verdict on the record the rebuild
   * writes after every run (appState "attendanceRebuild"), for the admin card
   * and the dashboard tile (2026-10-02).
   *
   * Levels: 'ok', 'warn', 'bad', and 'unknown' when there is nothing to judge
   * yet. Only 'warn' and 'bad' raise the dashboard tile, so the evening of a
   * deploy, before the first scheduled run, is not an alarm.
   *
   * A COPY IS ONLY AS GOOD AS WHEN IT WAS FETCHED. A dashboard left open over
   * lunch still holds the record from when it loaded: judged against the clock
   * later, a run that was in progress then reads as "did not finish", and a
   * tab left open overnight reads as "hours behind" while every run succeeded.
   * So the rules that depend on time passing -- a run stuck past 15 minutes,
   * the last good run past 19 hours, a retry that has come and gone -- are
   * only applied to a copy fetched in the last few minutes; the page refetches
   * an older one before it trusts it. The longest normal gap is 18 hours
   * (12:30 PM to 6:30 AM), hence 19.
   */
  var REBUILD_LIMITS = {
    staleAfterHours: 19, stuckAfterMinutes: 15, slowSeconds: 300, limitSeconds: 600,
    budgetSeconds: 360, slowReadSeconds: 240,
    singleReadWarnRows: 34000, freshMinutes: 5
  };
  function rebuildHealthVerdict(health, nowIso, limits, fetchedIso) {
    var L = {};
    Object.keys(REBUILD_LIMITS).forEach(function (k) {
      var x = limits && Number(limits[k]);
      L[k] = isFinite(x) && x > 0 ? x : REBUILD_LIMITS[k];
    });
    var now = Date.parse(nowIso || '');
    var fetched = fetchedIso ? Date.parse(fetchedIso) : now;
    var fresh = isFinite(now) && isFinite(fetched) && Math.abs(now - fetched) <= L.freshMinutes * 60000;
    var ms = function (iso) { var t = Date.parse(iso || ''); return isFinite(t) ? t : null; };
    var when = function (iso) {
      var t = ms(iso);
      if (t === null) return 'an unknown time';
      return new Date(t).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      });
    };
    var h = health || null;
    var last = h && h.last ? h.last : null;
    var lastOk = h && h.lastOk ? h.lastOk : null;
    // THE RUNS STILL GOING (review, 2026-10-02): the server now keeps one
    // entry per run, keyed by run id, so a second run starting cannot hide the
    // first. A single marker (the older shape) is read as one.
    var r0 = h && h.running && typeof h.running === 'object' ? h.running : null;
    var live = !r0 ? [] : (typeof r0.runId === 'string' ? [r0] :
      Object.keys(r0).map(function (k) { return r0[k]; }).filter(function (x) { return x && typeof x === 'object'; }));
    var lines = [];
    var readS = lastOk ? Number(lastOk.readSeconds) : NaN;
    if (lastOk) {
      lines.push('Last good rebuild ' + when(lastOk.finishedAt) + ': ' + (Number(lastOk.attendanceRows) || 0) +
        ' rows' + (lastOk.windows ? ', ' + lastOk.windows + ' month pieces' : ', one read') +
        (isFinite(readS) ? ', read ' + readS + ' of ' + L.budgetSeconds + ' s' : '') +
        ', ' + (Number(lastOk.seconds) || 0) + ' s in all.');
    }
    // WHAT THE SCREENS HOLD NOW (review, 2026-10-02). A run that failed while
    // writing, or that Convex stopped while writing, can leave some tables
    // short, and a later refusal that writes nothing does not mend them. So
    // when any run since the last good one may have written part-way, the
    // screens are not "still showing" the last good data. A run stopped while
    // READING cleared nothing, and is not damage.
    var recentRuns = h && Array.isArray(h.recent) ? h.recent : (last ? [last] : []);
    var damage = null;
    for (var i = 0; i < recentRuns.length; i++) {
      var rr = recentRuns[i];
      if (!rr || rr.ok === true) break;
      if (rr.stage === 'write') damage = rr;
    }
    var screens = function () {
      if (damage) {
        return 'Some attendance screens may be incomplete since ' + when(damage.finishedAt || damage.startedAt) +
          ', when a rebuild ' + (damage.code === 'abandoned' ? 'was stopped while writing' : 'failed while writing') + '.';
      }
      // No good run on record is not "no data" (review, 2026-10-02): the
      // record began with this build, and the tables still hold the last
      // rebuild from before it.
      return lastOk
        ? 'Attendance screens still show the data from ' + when(lastOk.finishedAt) + '.'
        : 'Attendance screens still show the last rebuild from before this record began (no good run recorded since).';
    };
    var out = function (level, headline, tile) {
      return { level: level, headline: headline, tile: tile, lines: lines, fresh: fresh };
    };

    if (!h || (!last && !live.length)) return out('unknown', 'No attendance rebuild has been recorded yet.', 'no rebuild recorded yet');

    // 1. A run that never came back: Convex stops an action at 10 minutes.
    if (fresh && live.length) {
      var stuck = live.filter(function (x) {
        var t = ms(x.startedAt);
        return t !== null && now - t > L.stuckAfterMinutes * 60000;
      });
      if (stuck.length) {
        // Stopped while it held the write lock: it was part-way through writing.
        var writer = h.writing ? stuck.filter(function (x) { return x.runId === h.writing.runId; })[0] : null;
        if (!damage && writer) {
          damage = { code: 'abandoned', stage: 'write', startedAt: h.writing.claimedAt || writer.startedAt };
        }
        return out('bad', 'The last attendance rebuild did not finish (probably ran out of time). ' +
          screens(), 'last rebuild did not finish');
      }
    }
    if (!last) return out('unknown', 'The first attendance rebuild is running now.', 'first rebuild running');

    // 2. The last real run did not finish ok.
    if (last.ok === false) {
      var verb = last.code === 'failed' ? 'failed' : last.code === 'abandoned' ? 'did not finish' : 'refused';
      var retryAt = ms(last.retryAt);
      // ITS RETRY IS RUNNING NOW (review, 2026-10-02): a warning, whatever
      // the clock says -- including for a run Convex stopped, whose record
      // carries no retryAt but whose retry was booked when it started.
      var retryRunning = live.some(function (x) { return x.retryOf === last.runId; });
      // A refusal with a retry still to come heals itself: a warning, not an
      // alarm, until the retry has had its chance. On an old copy nobody can
      // tell whether it has, so it is not called an alarm either.
      var retryPending = retryRunning || (retryAt !== null && (!fresh || now < retryAt));
      var what = 'Attendance rebuild ' + verb + ' at ' + when(last.finishedAt || last.startedAt) + ': ' +
        String(last.reason || last.code || 'no reason recorded');
      if (retryPending) {
        return retryRunning
          ? out('warn', what + ' Its retry is running now.', verb + ', retry running')
          : out('warn', what + ' It runs again by itself at ' + when(last.retryAt) + '.',
            verb + ', retrying at ' + when(last.retryAt));
      }
      return out('bad', what + ' ' + screens(),
        verb + ' at ' + when(last.finishedAt || last.startedAt));
    }

    // 3. Too long since the last good run.
    if (fresh) {
      var okAt = lastOk ? ms(lastOk.finishedAt) : null;
      if (okAt === null || now - okAt > L.staleAfterHours * 3600000) {
        var hours = okAt === null ? null : Math.floor((now - okAt) / 3600000);
        return out('bad', hours === null
          ? 'No good attendance rebuild is recorded.'
          : 'Attendance screens are ' + hours + ' hours behind PowerSchool: the last good rebuild was ' +
            when(lastOk.finishedAt) + '.',
          hours === null ? 'no good rebuild recorded' : hours + ' hours behind PowerSchool');
      }
    }

    // 3b. The last good run finished, but said something is wrong with what it
    //     wrote (review, 2026-10-02): no tardy code found, for one. The cron
    //     drops the run's own summary, so this is the only place it is seen.
    if (lastOk && lastOk.warning) {
      return out('warn', 'The last attendance rebuild finished with a warning: ' + String(lastOk.warning),
        'finished with a warning');
    }

    // 4. Still fine, but heading for the READ BUDGET (review, 2026-10-02). A
    //    run refuses once its reading passes budgetSeconds (6 minutes), long
    //    before Convex's 10-minute limit, so the reading time is what is
    //    judged -- the total, writes included, used to be set against 600 and
    //    showed 230 s of room on a run 5 s from refusing.
    if (isFinite(readS) && readS > L.slowReadSeconds) {
      return out('warn', 'The attendance rebuild is getting slow: it read for ' + readS + ' of the ' +
        L.budgetSeconds + ' seconds a run may read before it refuses. It needs splitting across runs before it reaches that.',
        'getting slow: read ' + readS + ' of ' + L.budgetSeconds + ' s');
    }
    //    And the whole run, writes included, against Convex's own limit.
    if (lastOk && Number(lastOk.seconds) > L.slowSeconds) {
      return out('warn', 'The attendance rebuild is getting slow: it took ' + Number(lastOk.seconds) + ' of the ' +
        L.limitSeconds + ' seconds Convex allows a run, in all. It needs splitting across runs before it reaches the limit.',
        'getting slow: ' + Number(lastOk.seconds) + ' of ' + L.limitSeconds + ' s');
    }
    // 5. Still on the old single read, and near its 40,000-row wall.
    if (lastOk && lastOk.readMode === 'single read' && Number(lastOk.attendanceRows) > L.singleReadWarnRows) {
      return out('warn', 'The attendance rebuild still reads the year in one piece, and it is at ' +
        Number(lastOk.attendanceRows) + ' of the 40,000 rows one read can hold. Turn on the month pieces.',
        'near the 40,000-row wall');
    }
    // "CURRENT" ONLY FROM A FRESH COPY (review, 2026-10-02). On an old copy --
    // the card's re-check failed -- the age rules above were skipped, so
    // nothing here knows the data is current; a copy 40 minutes old said so
    // about a run 22 hours old.
    if (!fresh) {
      return out('unknown', 'Could not re-check just now; last rebuilt ' + when(lastOk ? lastOk.finishedAt : null) + '.', '');
    }
    return out('ok', 'Attendance data is current: last rebuilt ' + when(lastOk ? lastOk.finishedAt : null) + '.', '');
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
    runDayFull: runDayFull,
    weekOf: weekOf,
    runSeriesDays: runSeriesDays,
    runWeekGroups: runWeekGroups,
    runWeeklyRate: runWeeklyRate,
    runMonthly: runMonthly,
    runChartAnalysis: runChartAnalysis,
    runLastYearWeekly: runLastYearWeekly,
    runLastYearMonthly: runLastYearMonthly,
    runVsLastYear: runVsLastYear,
    RATE_MEASURES: RATE_MEASURES,
    runRateModel: runRateModel,
    rateSignalReading: rateSignalReading,
    REBUILD_LIMITS: REBUILD_LIMITS,
    rebuildHealthVerdict: rebuildHealthVerdict,
    absenceSeriesValues: absenceSeriesValues,
    absenceSignalBlurb: absenceSignalBlurb,
    perfectWindows: perfectWindows,
    datesInWindow: datesInWindow,
    perfectVerdict: perfectVerdict,
    perfectList: perfectList,
    perfectMonths: perfectMonths,
    perfectMonthWindow: perfectMonthWindow,
    perfectPeriodName: perfectPeriodName,
    perfectPeriodDates: perfectPeriodDates,
    PERFECT_SORTS: PERFECT_SORTS,
    perfectSort: perfectSort,
    absenceWindows: absenceWindows,
    lastFinishedWeek: lastFinishedWeek,
    CALENDAR_SEEN_HOUR: CALENDAR_SEEN_HOUR,
    schoolCalendar: schoolCalendar,
    finishedSeries: finishedSeries,
    ATTENDANCE_KINDS: ATTENDANCE_KINDS,
    attendanceKindMatch: attendanceKindMatch,
    YEAR_BANDS: YEAR_BANDS,
    yearBandMatch: yearBandMatch,
    WINDOW_CHIPS: WINDOW_CHIPS,
    windowBandMatch: windowBandMatch,
    attendanceListOrder: attendanceListOrder,
    attendanceSearch: attendanceSearch,
    WINDOW_BANDS: WINDOW_BANDS,
    windowBand: windowBand,
    windowAbsenceList: windowAbsenceList,
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
    scopeLabel: scopeLabel,
    gradeBlockOf: gradeBlockOf
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
