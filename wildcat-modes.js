/**
 * Which modes a role may enter.
 *
 * Pure. No DOM, no storage, no globals: a role goes in, a list of modes comes
 * out. Everything that decides what to draw or what to restore asks this one
 * function, so the answer cannot differ between the dropdown, the saved
 * preference and the tab switcher.
 *
 * THE PROBLEM THIS EXISTS TO FIX.
 *
 * The sidebar offered all four modes to everyone -- switchSystemMode still
 * carries the comment "All roles may switch modes" -- while switchTab refused
 * every Wildcat Cash tab to anyone who is not a superadmin. A teacher who
 * opened the mode dropdown and picked Wildcat Cash therefore landed on Award
 * Cash with an empty student table and "Wildcat Cash is limited to super
 * admins" where the roster should be.
 *
 * That alone would be a bad afternoon. What made it permanent is that
 * switchSystemMode writes the choice to localStorage under
 * `systemMode_u<id>`, and initSidebarShell restores it on every later sign-in,
 * AFTER the role branch in establishTeacherSessionCore has forced the account
 * back to Raffle. So one curious click during a demo left that teacher staring
 * at a dead screen on every subsequent login, with the app's own sign-in
 * handling silently overruled a few milliseconds later.
 *
 * A preference is not an entitlement. A saved mode the role may no longer use
 * is discarded rather than restored, which is why this returns a list the
 * caller can filter a stored value against, not just a yes/no on the mode
 * somebody is currently clicking.
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
   * Modes not open to every role, and the roles that may enter them.
   *
   * Only Wildcat Cash is restricted. Raffle is the school's default economy,
   * Claw Pass is a teacher tool, and Discipline is deliberately open to
   * teachers so they can submit referrals -- its own narrowing (a teacher sees
   * only their own referrals) lives in wildcat-discipline.js and is a
   * different question from whether the mode opens at all.
   *
   * Cash is superadmin-only because it is still in beta, which is the same
   * answer switchTab has always given; it is written down once here instead of
   * being spelled out in three places that could drift.
   */
  var RESTRICTED = {
    cash: ['superadmin']
  };

  function normalise(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  /** Every mode this role may enter, in dropdown order. */
  function modesFor(role) {
    var r = normalise(role);
    return ALL_MODES.filter(function (mode) {
      var allowed = RESTRICTED[mode];
      return !allowed || allowed.indexOf(r) !== -1;
    });
  }

  /** True when this role may enter this mode. Unknown modes are refused. */
  function canUseMode(role, mode) {
    return modesFor(role).indexOf(normalise(mode)) !== -1;
  }

  root.WildcatModes = {
    modesFor: modesFor,
    canUseMode: canUseMode,
    ALL_MODES: ALL_MODES.slice()
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
