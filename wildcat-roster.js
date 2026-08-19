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

  // Bell order, not alphabetical: a teacher scanning for "third period" wants
  // it third. Anything unrecognised sorts to the end rather than being hidden.
  var PERIOD_ORDER = ['A1', 'P1', 'P2', 'P3', 'P4', 'HPU', 'P5', 'P6', 'A2'];

  function trimmed(s) {
    return String(s == null ? '' : s).trim();
  }

  function seesEveryStudent(role) {
    return ALL_STUDENT_ROLES.indexOf(trimmed(role)) !== -1;
  }

  function periodRank(period) {
    var i = PERIOD_ORDER.indexOf(trimmed(period));
    return i === -1 ? PERIOD_ORDER.length : i;
  }

  /** Sections from a views_app:teacherRoster payload, in bell order. */
  function sectionsFrom(roster) {
    var sections = (roster && roster.sections) || [];
    return sections.slice().sort(function (a, b) {
      var d = periodRank(a && a.period) - periodRank(b && b.period);
      if (d !== 0) return d;
      return trimmed(a && a.courseName).localeCompare(trimmed(b && b.courseName));
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

    var allowed = studentNumbersFor(roster, sectionId);
    var scoped = all.filter(function (s) {
      var n = trimmed(s && s.studentNumber);
      return n && allowed[n] === true;
    });

    if (scoped.length) {
      return { students: scoped, scope: sectionId ? 'section' : 'my-roster', reason: null };
    }

    // Distinguish "that period is empty" from "none of your students have app
    // records", which look identical on screen and need different fixes.
    var anyAllowed = Object.keys(allowed).length;
    return {
      students: [],
      scope: sectionId ? 'section' : 'my-roster',
      reason: !anyAllowed
        ? (sectionId ? 'That class has no students in the SIS.' : 'Your SIS roster is empty.')
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
      if (hit) {
        return (hit.period ? 'Period ' + hit.period + ' — ' : '') + (hit.courseName || 'Class');
      }
    }
    return 'My students';
  }

  root.WildcatRoster = {
    ALL_STUDENT_ROLES: ALL_STUDENT_ROLES,
    PERIOD_ORDER: PERIOD_ORDER,
    seesEveryStudent: seesEveryStudent,
    sectionsFrom: sectionsFrom,
    studentNumbersFor: studentNumbersFor,
    scopeStudents: scopeStudents,
    scopeLabel: scopeLabel
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
