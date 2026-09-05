/**
 * Which modes a role may enter.
 *
 * Pure. No DOM, no storage, no globals: a role goes in, a list of modes comes
 * out. Everything that decides what to draw or what to restore asks this one
 * function, so the answer cannot differ between the dropdown, the saved
 * preference and the tab switcher.
 *
 * WHAT IT DECIDES NOW. Westbrook opens on 2026-09-09 running Wildcat Cash and
 * Discipline only. Raffle and Claw Pass are built and working; they are not
 * what the school is starting with, and a teacher handed four modes on day one
 * will pick the wrong one in front of a class. Admins keep all four because
 * they are the ones testing.
 *
 * WHAT IT WAS BUILT FOR, WHICH STILL APPLIES.
 *
 * The sidebar offered all four modes to everyone -- switchSystemMode still
 * carries the comment "All roles may switch modes" -- while switchTab refused
 * every Wildcat Cash tab to anyone who is not a superadmin. A teacher who
 * picked Wildcat Cash landed on Award Cash with an empty student table and
 * "Wildcat Cash is limited to super admins" where the roster should be. (Cash
 * is now open to all staff, so that particular pairing is gone; the shape of
 * the mistake is not, and this file is what stops it recurring.)
 *
 * What made it permanent is that switchSystemMode writes the choice to
 * localStorage under `systemMode_u<id>`, and initSidebarShell restores it on
 * every later sign-in, AFTER the role branch in establishTeacherSessionCore
 * has forced the account somewhere else. So one curious click during a demo
 * left that teacher staring at a dead screen on every subsequent login.
 *
 * A preference is not an entitlement. A saved mode the role may no longer use
 * is discarded rather than restored -- which is also what moves every teacher
 * off Raffle at launch without anyone touching their browser.
 *
 * THIS IS NOT THE AUTHORIZATION BOUNDARY, and must not be mistaken for one.
 * Hiding a menu item has never stopped anybody reading the data underneath it.
 * Enforcement is server side, in convex/identity.ts and convex/accessRules.ts,
 * plus the tab-level refusal in switchTab that this file now shares a rule
 * with. Because this is navigation courtesy rather than a gate, callers are
 * expected to fail OPEN when the file has not loaded: a missing script should
 * cost a stale menu entry, never lock every teacher out of every mode.
 */
(function (root) {
  'use strict';

  /** Order matters: this is the order the mode dropdown renders in. */
  var ALL_MODES = ['raffle', 'cash', 'hallpass', 'discipline'];

  /**
   * The modes the school is actually running from launch, 2026-09-09.
   *
   * Wildcat Cash and Discipline. Raffle and Claw Pass are built and working;
   * they are simply not what Westbrook is opening with, and a teacher offered
   * four modes on day one will pick the wrong one in front of a class. This is
   * a launch decision, not a capability judgement -- widen the list when the
   * school starts running them.
   */
  var LAUNCH_MODES = ['cash', 'discipline'];

  /**
   * Roles that keep every mode regardless.
   *
   * Admins and superadmins are the ones testing features, so they need to
   * reach the modes staff are not being shown yet. Deliberately NOT `pbis`:
   * PBIS is a staff role with wide DISCIPLINE rights, which is a different
   * question from which modes appear in the switcher, and treating the two as
   * the same is how a role quietly acquires screens nobody decided to give it.
   */
  var ALL_MODE_ROLES = ['admin', 'superadmin'];

  /**
   * Where somebody lands when they have no saved preference.
   *
   * Cash, because that is what launch day is. Falls back to the first mode the
   * role may use if Cash is ever taken off the list, so this cannot strand
   * anyone on a mode they are not allowed to open.
   */
  var DEFAULT_MODE = 'cash';

  function normalise(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  /** Every mode this role may enter, in dropdown order. */
  function modesFor(role) {
    if (ALL_MODE_ROLES.indexOf(normalise(role)) !== -1) return ALL_MODES.slice();
    return ALL_MODES.filter(function (mode) {
      return LAUNCH_MODES.indexOf(mode) !== -1;
    });
  }

  /** True when this role may enter this mode. Unknown modes are refused. */
  function canUseMode(role, mode) {
    return modesFor(role).indexOf(normalise(mode)) !== -1;
  }

  /**
   * The mode to open when there is no stored preference, or when a stored one
   * is no longer allowed. Never returns a mode the role cannot enter.
   */
  function defaultModeFor(role) {
    var allowed = modesFor(role);
    return allowed.indexOf(DEFAULT_MODE) !== -1 ? DEFAULT_MODE : (allowed[0] || 'raffle');
  }

  root.WildcatModes = {
    modesFor: modesFor,
    canUseMode: canUseMode,
    defaultModeFor: defaultModeFor,
    ALL_MODES: ALL_MODES.slice(),
    LAUNCH_MODES: LAUNCH_MODES.slice()
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
