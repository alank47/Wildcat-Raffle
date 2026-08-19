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
   */
  var ALL_STUDENT_ROLES = ['admin', 'superadmin', 'campusaide'];

  /**
   * WHY A SECTION IS CLASSIFIED BY COURSE NAME, NOT BY PERIOD NUMBER.
   *
   * At Westbrook the core teaching periods are 1 to 6. Promise Time and Power
   * Up are not periods at all, but PowerSchool still has to put them somewhere
   * in the day, so they come back sitting in numbered slots: Promise Time
   * reports as period 1 and period 10. Ordering or labelling on that number
   * puts Promise Time first and calls it "Period 1", which collides with the
   * real first period and is what made the list look jumbled.
   *
   * The bell schedule this app already owns says the same thing from the other
   * direction: convex/seedBellSchedules.ts labels class periods with a bare
   * number and everything else descriptively, precisely so the named blocks
   * match no section.
   *
   * So: the course name decides what a block IS, and the number is only
   * trusted once a section is known to be a core class.
   */
  var CORE_MIN = 1;
  var CORE_MAX = 6;

  // Checked in order; first match wins. Promise Time PM before Promise Time,
  // or "Promise Time PM" classifies as the morning block.
  var NAMED_BLOCKS = [
    { kind: 'promise-pm', label: 'Promise Time PM', match: /promise\s*time\s*(pm|afternoon)/i },
    { kind: 'promise',    label: 'Promise Time',    match: /promise\s*time/i },
    { kind: 'powerup',    label: 'Power Up',        match: /power\s*up/i },
    { kind: 'nutrition',  label: 'Nutrition',       match: /nutrition|breakfast/i },
    { kind: 'lunch',      label: 'Lunch',           match: /lunch/i }
  ];

  // Core classes first in bell order, then the named blocks in the order the
  // day runs them, then anything unrecognised. Nothing is ever hidden.
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
   * sort. Returns { kind, label, order, periodNumber }.
   */
  function classifySection(section) {
    var s = section || {};
    var course = trimmed(s.courseName);
    var num = periodNumber(s.period);

    for (var i = 0; i < NAMED_BLOCKS.length; i++) {
      if (NAMED_BLOCKS[i].match.test(course)) {
        return {
          kind: NAMED_BLOCKS[i].kind,
          // Named for what it is. The period number it reports is an artefact
          // of where PowerSchool had to put it in the day.
          label: NAMED_BLOCKS[i].label,
          order: KIND_ORDER.indexOf(NAMED_BLOCKS[i].kind),
          periodNumber: num
        };
      }
    }

    if (num !== null && num >= CORE_MIN && num <= CORE_MAX) {
      return {
        kind: 'core',
        label: 'Period ' + num + (course ? ' - ' + course : ''),
        order: KIND_ORDER.indexOf('core'),
        periodNumber: num
      };
    }

    // Neither a recognised block nor a core period number. Shown as itself
    // rather than forced into a period it does not belong to.
    return {
      kind: 'other',
      label: course || (num !== null ? 'Period ' + num : 'Unscheduled'),
      order: KIND_ORDER.indexOf('other'),
      periodNumber: num
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
      out.periodNumber = meta.periodNumber;
      out._order = meta.order;
      return out;
    }).sort(function (a, b) {
      if (a._order !== b._order) return a._order - b._order;
      // Within core, by period number. Within a named block, by course name,
      // because a teacher may hold two sections of the same block.
      if (a.kind === 'core' && b.kind === 'core') {
        return (a.periodNumber || 0) - (b.periodNumber || 0);
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

  root.WildcatRoster = {
    ALL_STUDENT_ROLES: ALL_STUDENT_ROLES,
    CORE_MIN: CORE_MIN,
    CORE_MAX: CORE_MAX,
    classifySection: classifySection,
    periodNumber: periodNumber,
    seesEveryStudent: seesEveryStudent,
    sectionsFrom: sectionsFrom,
    studentNumbersFor: studentNumbersFor,
    scopeStudents: scopeStudents,
    scopeLabel: scopeLabel
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
