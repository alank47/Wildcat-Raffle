/**
 * Hall pass lifecycle. Pure rules, no ctx, no database, no clock of its own.
 *
 * Split out for the same reason identityRules.ts and sisMerge.ts are: this
 * decides whether a child is allowed out of a classroom and how long they were
 * gone, and that is worth testing directly rather than through a mirror of
 * itself that can drift and still pass.
 *
 * `now` is always passed in. A state machine that reads the clock cannot be
 * tested for the cases that matter, which are all about elapsed time.
 *
 * THE FLOW, as specified:
 *
 *   requested  student asks from their pass card
 *   active     teacher approves. The timer starts HERE, not at the first tap:
 *              a student who is approved and never leaves is still out of class.
 *   out        tapped the NFC tag at the destination
 *   returned   tapped the tag back at the classroom of origin. Timer stops.
 *
 * And the ways it ends without that: denied, cancelled, expired.
 */

export const PASS_STATES = [
  "requested",
  "active",
  "out",
  "returned",
  "denied",
  "cancelled",
  "expired",
] as const;

export type PassState = (typeof PASS_STATES)[number];

/** A pass stops being usable at these. Nothing may transition out of them. */
export const TERMINAL_STATES: PassState[] = ["returned", "denied", "cancelled", "expired"];

export type Pass = {
  state: PassState;
  studentId: string;
  originLocationId: string;
  destinationLocationId?: string;
  /**
   * Where a TEACHER said to go, when a teacher opened this pass.
   *
   * Deliberately a different field from destinationLocationId, for the same
   * reason closedAt is a different field from returnedAt: this one is an
   * instruction and that one is a measurement. Written at approval, never by a
   * tap, so "went where they were sent" and "went somewhere else" stay
   * separable after the fact, and the second is the interesting one.
   *
   * When set, it is what the first tap has to match. Absent, any tag other than
   * the origin is the destination, exactly as before it existed.
   */
  assignedDestinationLocationId?: string;
  requestedAt: string;
  approvedAt?: string;
  outAt?: string;
  returnedAt?: string;
  /**
   * When a human or the expiry sweep closed this pass WITHOUT a return tap.
   *
   * Deliberately a different field from returnedAt. returnedAt means a tag was
   * tapped in the room of origin, and that is the only thing this whole record
   * is evidence of. If a forced close wrote returnedAt, every downstream reader
   * of that column would silently be mixing a tap with somebody's say-so, and
   * there would be no way afterwards to tell which passes were which.
   */
  closedAt?: string;
  /** Minutes after approval at which an un-returned pass is considered overdue. */
  expiresAfterMinutes: number;
};

export type TapResult =
  | { ok: true; nextState: PassState; field: "outAt" | "returnedAt"; reason: string }
  | { ok: false; reason: string };

const minutes = (fromIso: string, toIso: string) =>
  (Date.parse(toIso) - Date.parse(fromIso)) / 60000;

export function isTerminal(state: PassState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * A pass whose own clock cannot be read.
 *
 * WHY THIS IS NOT PARANOIA. elapsedMinutes used to return NaN for an
 * unparseable approvedAt. NaN serializes to null over the wire, and null on that
 * field has a specific meaning here: "not approved yet". So a corrupt APPROVED
 * pass rendered on the teacher's board as a pending request, sorted to the
 * bottom, and was simultaneously invisible to the expiry sweep, because every
 * comparison against NaN is false. A child out of the building, in a state
 * nothing could close, displayed as a request nobody had answered.
 *
 * Treated as an exception rather than as missing data: isOverdue and isAbandoned
 * both return true for one, so it sorts to the TOP of the board where a human
 * sees it, and the sweep can close it.
 */
export function hasCorruptClock(pass: Pass): boolean {
  const stamp = pass.approvedAt ?? pass.requestedAt;
  return !Number.isFinite(Date.parse(stamp));
}

/**
 * How long a pass has been running, in minutes.
 *
 * Measured from APPROVAL, because that is when the student is permitted to be
 * out of class, and to the return tap once it exists so a closed pass stops
 * counting up forever in the UI.
 *
 * Returns null before approval: a request sitting in a teacher's queue is not
 * time out of class and showing it as such would make every unanswered request
 * look like a truancy.
 *
 * closedAt stops the clock as surely as returnedAt does. Without it, a pass that
 * a teacher force-closed or the nightly sweep expired keeps counting up in every
 * history screen forever, and a trip from last October reads as 47,000 minutes
 * out of class.
 */
export function elapsedMinutes(pass: Pass, now: string): number | null {
  if (!pass.approvedAt) return null;
  const end = pass.returnedAt ?? pass.closedAt ?? now;
  const value = minutes(pass.approvedAt, end);
  // NEVER NaN. See hasCorruptClock: NaN becomes null on the wire, and null here
  // means "not approved yet", so returning it for a corrupt approved pass makes
  // that pass read as a pending request. Callers get null and must ask
  // hasCorruptClock rather than infer a meaning from the absence.
  if (!Number.isFinite(value)) return null;
  return Math.max(0, value);
}

/**
 * Past its window and not yet back. Overdue is a display state, not a terminal
 * one.
 *
 * A pass with an unreadable clock is reported OVERDUE. It is the one thing a
 * teacher must not miss: the pass cannot be timed, so it cannot be judged safe,
 * and the board sorts overdue to the top. Reporting false would hide it.
 */
export function isOverdue(pass: Pass, now: string): boolean {
  if (pass.state !== "active" && pass.state !== "out") return false;
  if (hasCorruptClock(pass)) return true;
  const elapsed = elapsedMinutes(pass, now);
  return elapsed !== null && elapsed > pass.expiresAfterMinutes;
}

/**
 * Decide what a tap at `locationId` does.
 *
 * THE ORDER IS ENFORCED. Destination before origin. Without that, a student can
 * tap the classroom tag on the way out and close a pass they never used, which
 * makes the whole record meaningless while looking perfectly complete.
 *
 * A tap on a pass that is not active is refused rather than ignored, and the
 * reason is returned, because "nothing happened" at a wall-mounted tag is
 * indistinguishable from a broken tag.
 */
export function applyTap(pass: Pass, locationId: string, now: string): TapResult {
  if (isTerminal(pass.state)) {
    return { ok: false, reason: `This pass is already ${pass.state}.` };
  }

  if (pass.state === "requested") {
    return {
      ok: false,
      reason: "Your teacher has not approved this pass yet.",
    };
  }

  if (pass.state === "active") {
    // First tap. It must be somewhere other than the room they started in:
    // tapping the origin tag while still in the room is not an arrival.
    //
    // THIS CHECK STAYS FIRST. A student who taps their own classroom tag on the
    // way out has to hear about that, not about the destination, because it is
    // the thing that would otherwise close a pass they never took.
    if (locationId === pass.originLocationId) {
      return {
        ok: false,
        reason: "Tap the tag at where you are going first, then tap back here when you return.",
      };
    }
    // A pass a TEACHER opened names where the student was sent, and validating
    // it means tapping THAT tag. Without this the assigned destination is
    // decoration: a student sent to the office could tap any tag in the building
    // and the record would show a completed, validated trip.
    //
    // Only applies when a destination was assigned. A student-initiated pass has
    // none, and behaves exactly as it did before this existed.
    if (
      pass.assignedDestinationLocationId &&
      locationId !== pass.assignedDestinationLocationId
    ) {
      return {
        ok: false,
        reason:
          "This is not where you were sent. Tap the tag at the place on your pass to " +
          "start it, then tap back in your classroom when you return.",
      };
    }
    return {
      ok: true,
      nextState: "out",
      field: "outAt",
      reason: "Arrived at destination.",
    };
  }

  if (pass.state === "out") {
    // Second tap. Only the room of origin closes the pass. Tapping a third
    // location is a real event worth recording, but it does not end the trip.
    if (locationId !== pass.originLocationId) {
      return {
        ok: false,
        reason: "Tap the tag in the classroom you left to end your pass.",
      };
    }
    return {
      ok: true,
      nextState: "returned",
      field: "returnedAt",
      reason: "Back in class. Pass closed.",
    };
  }

  return { ok: false, reason: `A pass in state "${pass.state}" cannot be tapped.` };
}

/**
 * Whether a teacher may approve this request.
 *
 * Separated from the tap rules because approval is a different question with a
 * different actor, and folding it in makes both harder to read.
 */
export function canApprove(pass: Pass): { ok: boolean; reason: string } {
  if (pass.state === "requested") return { ok: true, reason: "" };
  if (isTerminal(pass.state)) {
    return { ok: false, reason: `This request is already ${pass.state}.` };
  }
  return { ok: false, reason: "This pass is already approved." };
}

/**
 * At most one live pass per student.
 *
 * A second concurrent pass means two open timers and no way to tell which tap
 * belongs to which, so the honest record becomes impossible to reconstruct.
 */
export function hasLivePass(passes: Array<{ state: PassState }>): boolean {
  return passes.some((p) => !isTerminal(p.state));
}

/**
 * The longest free-text reason a student may attach to a request.
 *
 * A reason is written by a child and rendered on a teacher's live board next to
 * six other names. Unbounded, one student can push every other row off the
 * screen, which is a denial of the one screen that shows who is out of class.
 */
export const MAX_REASON_LENGTH = 120;

/**
 * Normalize the optional reason on a request.
 *
 * Whitespace is collapsed before the length is measured, so 400 spaces is an
 * empty reason rather than a truncated one, and an all-whitespace reason becomes
 * undefined rather than a stored blank that renders as a mysterious empty line.
 */
export function trimReason(raw: string | undefined | null): string | undefined {
  const clean = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.slice(0, MAX_REASON_LENGTH);
}

export type Verdict = { ok: boolean; reason: string };

/**
 * How many passes one student may open in a school day.
 *
 * THIS IS A WRITE CEILING, not a discipline policy. `requestMine` is a mutation
 * any signed-in child can call in a loop, and nothing in this repo deletes a
 * hallPasses row. Convex allows 4,096 document reads per function execution, and
 * this codebase has already hit that ceiling once: psSync.ts:83-85 records the
 * roster clear breaking when a correctness fix pushed the table from 3,805 rows
 * to 5,812. When hallPasses crosses it, liveBoard, the only screen showing which
 * children are out of the building, throws for every teacher at once and there is
 * no delete path to recover with.
 *
 * Eight is above any honest school day (restroom, nurse, office, and room to
 * spare) and 646 students at eight is a bounded worst case rather than an open
 * one. A student who genuinely needs a ninth asks a teacher, who can still open
 * one through the staff path.
 */
export const MAX_PASSES_PER_SCHOOL_DAY = 8;

/**
 * Minutes to shift a timestamp back before taking its date, so the daily counter
 * rolls over in the middle of the night rather than in the middle of a lesson.
 *
 * Timestamps are stored as UTC ISO strings. Taking the UTC date directly would
 * reset every student's counter at 17:00 in Los Angeles during daylight time,
 * which is to say during after-school programmes, so the cap would be silently
 * doubled for anyone still on site. Twelve hours puts the boundary at 04:00 PST
 * / 05:00 PDT.
 *
 * The one-hour DST drift is accepted for the same reason crons.ts accepts it:
 * both sides of the boundary are hours before anybody arrives, and the
 * alternative is timezone logic nobody maintains.
 */
export const SCHOOL_DAY_ROLLOVER_MINUTES = 12 * 60;

/**
 * The school day an instant belongs to, as a YYYY-MM-DD key.
 *
 * A key rather than a range so counting is a string compare and needs no clock
 * of its own. An unparseable timestamp returns "", which matches no other key,
 * so a corrupt row can never be counted into today's total and can never be used
 * to exhaust somebody's allowance.
 */
export function schoolDayKey(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t - SCHOOL_DAY_ROLLOVER_MINUTES * 60000).toISOString().slice(0, 10);
}

/**
 * How many passes this student actually TOOK today.
 *
 * APPROVAL IS THE TEST, not existence. Counting every row meant a cancelled or
 * denied request burned the allowance, and that turns the escape hatch into a
 * punishment: cancel is documented as the way out of a request a teacher never
 * answered, and a child whose teacher ignored eight requests before lunch could
 * not get to the restroom at 1pm having been out of class exactly zero times.
 * Denied is worse still, since the student did not even choose it.
 *
 * `approvedAt` rather than a list of states, because it is the same fact under
 * every later state: an approved pass that was returned, force-closed or swept
 * all count, and a request that was cancelled, denied, or expired while still
 * unanswered all do not. A state list would have to be re-derived every time a
 * state is added, and would silently start counting the new one.
 */
export function passesTakenOnDay(
  passes: Array<{ requestedAt: string; approvedAt?: string }>,
  now: string,
): number {
  const today = schoolDayKey(now);
  if (!today) return 0;
  return passes.filter(
    (p) => Boolean(p.approvedAt) && schoolDayKey(p.requestedAt) === today,
  ).length;
}

/**
 * Grace beyond `expiresAfterMinutes` before the sweep may close a pass.
 *
 * NOT zero, and the difference matters. `isOverdue` goes true the minute a pass
 * runs past its window, and that is the signal a teacher wants at the top of the
 * board. If the sweep expired a pass at the same instant, a student who is two
 * minutes late and walking back would find their return tap refused with "this
 * pass is already expired", and the trip would end with no close and no record
 * of them returning. Overdue is for the teacher to see; expiry is for passes
 * nobody is coming back to.
 */
export const EXPIRY_GRACE_MINUTES = 60;

/**
 * Nobody is coming back to this one. Safe for the sweep to close.
 *
 * Distinct from isOverdue on purpose: overdue is a display state, this is a
 * licence to write a terminal state to a child's record without a human looking.
 */
export function isAbandoned(
  pass: Pass,
  now: string,
  graceMinutes: number = EXPIRY_GRACE_MINUTES,
): boolean {
  if (pass.state !== "active" && pass.state !== "out") return false;
  // A pass nobody can time is a pass nobody can close by any other route: every
  // comparison against an unparseable date is false, so without this branch the
  // sweep skips it forever and the student stays blocked for good.
  if (hasCorruptClock(pass)) return true;
  const elapsed = elapsedMinutes(pass, now);
  return elapsed !== null && elapsed > pass.expiresAfterMinutes + graceMinutes;
}

/**
 * How long a request may sit unanswered before the sweep closes it.
 *
 * `requested` needed its own clock because it has no approvedAt, so
 * elapsedMinutes is null for it by design and isAbandoned can never fire. Left
 * out, an unanswered request is live forever: it blocks that student, and it
 * sits on the teacher's live board until the board is nothing but the residue of
 * every request anyone ignored. Two hours is longer than a period, so a teacher
 * who answers late still answers a real request.
 */
export const MAX_REQUEST_AGE_MINUTES = 120;

/** A request nobody answered, old enough that nobody is going to. */
export function isStaleRequest(
  pass: Pass,
  now: string,
  maxAgeMinutes: number = MAX_REQUEST_AGE_MINUTES,
): boolean {
  if (pass.state !== "requested") return false;
  // Same reasoning as isAbandoned: an unreadable requestedAt otherwise makes the
  // row permanently un-sweepable, and it is blocking a child the whole time.
  if (hasCorruptClock(pass)) return true;
  const age = minutes(pass.requestedAt, now);
  return Number.isFinite(age) && age > maxAgeMinutes;
}

/**
 * The single predicate the expiry sweep uses.
 *
 * One function rather than two call sites, so "which passes may be closed
 * without a human looking" has exactly one answer, and so the reachability test
 * has one edge to follow out of each live state.
 */
export function shouldExpire(pass: Pass, now: string): boolean {
  return isAbandoned(pass, now) || isStaleRequest(pass, now);
}

/**
 * Whether staff may force this pass closed.
 *
 * THIS IS THE MISSING EXIT. Before it existed, `canCancel` freed `requested` and
 * a return tap freed `out`, and that was all: a pass a teacher approved at 2:50pm
 * that the student never tapped back stayed live forever, and because hasLivePass
 * counts it, that child was blocked from every future hall pass for the rest of
 * their time at the school. There was no staff mutation that could close one and
 * nothing wrote `expired`.
 *
 * The second way in was worse because it is invisible: `tap` refuses an inactive
 * tag before it ever looks at the pass, so an admin calling `tapLocations.retire`
 * on a room stranded every student currently `out` from it, with no error
 * anywhere and no way for the admin to know they had done it.
 *
 * Terminal passes are refused rather than re-closed, so a closure reason and a
 * closedAt cannot be overwritten after the fact.
 */
export function canForceClose(
  pass: { state: PassState },
  reason: string | undefined | null,
): Verdict {
  if (isTerminal(pass.state)) {
    return { ok: false, reason: `This pass is already ${pass.state}.` };
  }
  // The reason gate is PART OF THE RULE, not a separate check in the handler.
  // It lived in the handler, which made canForceClose exactly !isTerminal, and
  // that made the reachability test below a tautology: the force-close edge
  // fired unconditionally out of every live state, so the search proved only
  // that a non-terminal state is not terminal. It passed with the cron, the
  // taps, cancel and deny all deleted.
  if (!trimReason(reason)) {
    return {
      ok: false,
      reason:
        `Say why this pass is being closed, in up to ${MAX_REASON_LENGTH} characters. ` +
        `It is stored with the pass and is the only account of what happened.`,
    };
  }
  return { ok: true, reason: "" };
}

/** Floor and ceiling on how long a teacher may make a pass. */
export const MIN_PASS_MINUTES = 1;
export const MAX_PASS_MINUTES = 240;

/**
 * Validate the `minutes` a teacher sets when approving.
 *
 * IT WAS UNVALIDATED, AND THAT REINTRODUCED THIS BRANCH'S OWN TRAP. Any number
 * went straight into expiresAfterMinutes, so `1e12` produced a pass that is
 * never overdue, never abandoned, never swept, and still counts as live: the
 * child is blocked from every future hall pass, permanently, which is precisely
 * the state all the work here exists to make unreachable. One unchecked argument
 * put it back.
 *
 * Zero was the other half. `...(minutes ? { expiresAfterMinutes: minutes } : {})`
 * treats 0 as absent, so a teacher asking for a zero-minute pass silently got
 * the ten-minute default. In this codebase absence and zero are never the same
 * thing; here 0 is refused outright rather than reinterpreted.
 *
 * Non-integers are refused rather than rounded, because a rounded value is a
 * different answer than the one a person typed and nothing tells them so.
 */
export function validatePassMinutes(minutes: unknown): Verdict & { minutes?: number } {
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) {
    return { ok: false, reason: "How many minutes should this pass last? Give a whole number." };
  }
  if (!Number.isInteger(minutes)) {
    return { ok: false, reason: "Give a whole number of minutes, not a fraction." };
  }
  if (minutes < MIN_PASS_MINUTES) {
    return {
      ok: false,
      reason: `A pass has to last at least ${MIN_PASS_MINUTES} minute. Deny it instead of setting ${minutes}.`,
    };
  }
  if (minutes > MAX_PASS_MINUTES) {
    return {
      ok: false,
      reason:
        `${MAX_PASS_MINUTES} minutes is the longest a pass can be. A longer one is never ` +
        `overdue and is never closed by the nightly sweep, which leaves the student ` +
        `unable to ask for another pass at all.`,
    };
  }
  return { ok: true, reason: "", minutes };
}

/**
 * The teacher's live board order: exceptions first.
 *
 * Pure and separate so the one piece of judgement in liveBoard is testable. A
 * board that sorts wrongly is not a cosmetic bug: the top row is the child a
 * teacher acts on, and the whole screen exists to surface the exception.
 */
export function sortLiveBoard<T extends { overdue: boolean; elapsedMinutes: number | null }>(
  rows: T[],
): T[] {
  return [...rows].sort(
    (a, b) =>
      Number(b.overdue) - Number(a.overdue) ||
      (b.elapsedMinutes ?? -1) - (a.elapsedMinutes ?? -1),
  );
}

/**
 * Whether THIS student may open a new request right now.
 *
 * Lives here rather than inside the mutation for the same reason canApprove
 * does: a rule inside a handler cannot be run in this repo's test setup, so it
 * is only ever verified by clicking, and the cases worth verifying are the ones
 * nobody clicks.
 *
 * ORDER MATTERS, and the live-pass check is first on purpose. A student holding
 * a stuck request who also picks a dead tag needs to hear about the stuck
 * request, because that is the one that will still be blocking them after they
 * pick a different room. The message names the way out (cancel, or tap back in)
 * rather than only stating the refusal, because "you already have a pass open"
 * with no next step is how a student ends up unable to ask for a pass for the
 * rest of the year.
 *
 * `origin` is the room they say they are leaving, or null when no such tag
 * exists. A retired tag and an unknown tag get the SAME answer: which one it is
 * is a fact about the building that a student cannot act on, and telling them
 * apart turns the picker into a way to enumerate tags that used to exist.
 *
 * `existing` is the caller's RECENT passes, not their whole history. The handler
 * reads a bounded window; both checks below stay correct on one because a live
 * pass blocks every later request, so a live pass is always among the newest
 * rows, and the day count only ever looks at today.
 */
export function canRequest(
  existing: Array<{ state: PassState; requestedAt: string; approvedAt?: string }>,
  origin: { active: boolean } | null,
  now: string,
): Verdict {
  if (hasLivePass(existing)) {
    return {
      ok: false,
      reason:
        "You already have a hall pass open. Cancel it, or tap back in at your " +
        "classroom, before asking for another one.",
    };
  }

  // Checked before the room, because this one is still true after they pick a
  // different room, and a student who is told "wrong room" three times before
  // being told "you are out of passes" has been sent on an errand.
  //
  // Only passes that were APPROVED count. A request the student cancelled or a
  // teacher denied cost them no time out of class and must not cost them an
  // allowance, or cancelling, the documented escape hatch, becomes a penalty.
  const today = passesTakenOnDay(existing, now);
  if (today >= MAX_PASSES_PER_SCHOOL_DAY) {
    return {
      ok: false,
      reason:
        `You have already had ${today} hall passes today, which is the limit. ` +
        `Ask your teacher if you need another one.`,
    };
  }

  if (!origin || !origin.active) {
    return {
      ok: false,
      reason: "That room is not set up in the app yet. Tell your teacher.",
    };
  }

  return { ok: true, reason: "" };
}

/**
 * Whether this student may cancel this pass.
 *
 * THE ESCAPE HATCH. hasLivePass counts `requested` as live, so a request a
 * teacher never answers blocks that student from every future pass, silently
 * and permanently, with nothing in the UI to explain it. Nothing in this
 * codebase has ever written `cancelled` or `expired`, so before this existed
 * there was no way out of that state at all. Removing this reintroduces it.
 *
 * OWNERSHIP IS CHECKED BEFORE STATE, deliberately. If state came first, the
 * refusal on somebody else's pass would report THEIR pass's state, and a
 * student holding a pass id they should not have would learn whether that child
 * is currently out of class. The ownership refusal says nothing except that the
 * pass is not theirs.
 *
 * An APPROVED pass cannot be cancelled by the student. Once a teacher has said
 * yes the timer is running and the record is the point: letting the student
 * cancel it would let them erase the fact that they were out, at precisely the
 * moment it matters. They close it by tapping back in, or a teacher closes it.
 */
// ===========================================================================
// TAP INTENTS: making a tap something a link cannot cause on its own.
//
// THE ATTACK THIS EXISTS FOR. The page fires a tap from `?tap=<slug>` in the
// URL. So a slug alone was treated as proof that a body was in a room, and any
// student could send a classmate a link, in chat, by AirDrop, or on a blank NFC
// sticker they encoded themselves, and cause a tap ATTRIBUTED TO THE VICTIM:
//
//   victim is `out`, slug is their origin  -> writes returnedAt. A child is
//     recorded back in class while standing in a corridor, in the one column
//     schema.ts says must never be written on anybody's say-so.
//   victim is `active`, slug is anywhere   -> forges their destination.
//   victim has no pass at all              -> writes an accepted:false tapEvent
//     under their name at a location of the attacker's choosing, which is the
//     row a teacher reads as evidence of misbehaviour.
//
// WHAT THE SERVER CAN AND CANNOT DO. It cannot see a gesture. A page that
// auto-minted an intent and auto-redeemed it on load would defeat everything
// below, so the gesture guarantee is the CLIENT'S and cannot be moved here.
//
// What the server can do, and what these rules do, is refuse to accept a bare
// slug as proof. A tap now needs a token that was minted by a separate,
// authenticated call from the victim's own session, is bound to one student and
// one slug, expires in two minutes, and works exactly once. That kills the
// forwarded link, the replayed link, the encoded sticker and the reused token,
// and it reduces the client's remaining obligation to a single reviewable
// sentence: beginTap must be called only from a real user gesture handler.
// ===========================================================================

/** How long a minted intent stays redeemable. Long enough to walk to the tag. */
export const TAP_INTENT_TTL_SECONDS = 120;

export type TapIntent = {
  studentId: string;
  locationSlug: string;
  expiresAt: string;
  usedAt?: string;
};

/**
 * Whether this intent may be redeemed as a tap by this caller at this slug.
 *
 * A MISSING INTENT AND SOMEBODY ELSE'S INTENT GET THE SAME ANSWER, deliberately.
 * Distinguishing them turns the endpoint into an oracle for whether a given
 * token exists, which is a way to learn that another student is mid-trip.
 */
export function canRedeemTapIntent(
  intent: TapIntent | null,
  callerStudentId: string,
  slug: string,
  now: string,
): Verdict {
  const unusable = {
    ok: false,
    reason: "Open Wildcat Hub and press the button on your pass to check in here.",
  };

  if (!intent) return unusable;
  if (intent.studentId !== callerStudentId) return unusable;

  if (intent.usedAt) {
    // Single use is what stops a forwarded or screenshotted link from working
    // a second time, including in somebody else's hands.
    return { ok: false, reason: "That check-in was already used. Press the button again." };
  }

  const expiry = Date.parse(intent.expiresAt);
  const at = Date.parse(now);
  if (!Number.isFinite(expiry) || !Number.isFinite(at)) return unusable;
  if (at > expiry) {
    return { ok: false, reason: "That check-in expired. Press the button on your pass again." };
  }

  if (intent.locationSlug !== slug) {
    // Bound to ONE slug at mint time, so a token minted for the restroom cannot
    // be redeemed as a tap in the classroom, which is the difference between
    // recording a trip and closing one.
    return { ok: false, reason: "That check-in was for a different tag." };
  }

  return { ok: true, reason: "" };
}

/** Per-student ceiling on minting intents, which is what bounds tap writes. */
export const MAX_TAP_INTENTS_PER_WINDOW = 12;
export const TAP_INTENT_WINDOW_MINUTES = 5;

/**
 * Rate limit on minting.
 *
 * Bounding the MINT bounds everything downstream, because a tap now requires
 * one. Without it, the valid-slug branch of `tap` still wrote a tapEvents row
 * per call: two thousand calls with one slug pushed every other tag out of the
 * window that tapLocations.list reads, and the tag-health screen reported every
 * sticker in the building as never tapped. That is the exact failure the
 * `.order("desc")` fix was supposed to have ended.
 */
export function withinTapRateLimit(
  recent: Array<{ createdAt: string }>,
  now: string,
  limit: number = MAX_TAP_INTENTS_PER_WINDOW,
  windowMinutes: number = TAP_INTENT_WINDOW_MINUTES,
): Verdict {
  const at = Date.parse(now);
  if (!Number.isFinite(at)) return { ok: true, reason: "" };

  const inWindow = recent.filter((r) => {
    const t = Date.parse(r.createdAt);
    return Number.isFinite(t) && at - t <= windowMinutes * 60000;
  }).length;

  if (inWindow >= limit) {
    return {
      ok: false,
      reason: "You are checking in too quickly. Wait a moment and try again.",
    };
  }
  return { ok: true, reason: "" };
}

/** How close together two identical tap events are treated as one. */
export const TAP_EVENT_DEDUPE_SECONDS = 60;

/**
 * Whether this tap event is a repeat of the one before it and should not be
 * stored again.
 *
 * Second line of defence behind the rate limit, and the one that handles the
 * honest case: a phone that reads a tag three times as it is moved away should
 * leave one row, not three. Only an IDENTICAL event collapses, same student,
 * same slug, same outcome, within the window, so a genuinely different tap is
 * never lost.
 */
export function isDuplicateTapEvent(
  previous: { locationSlug: string; outcome: string; at: string } | null,
  candidate: { locationSlug: string; outcome: string },
  now: string,
  windowSeconds: number = TAP_EVENT_DEDUPE_SECONDS,
): boolean {
  if (!previous) return false;
  if (previous.locationSlug !== candidate.locationSlug) return false;
  if (previous.outcome !== candidate.outcome) return false;
  const before = Date.parse(previous.at);
  const at = Date.parse(now);
  if (!Number.isFinite(before) || !Number.isFinite(at)) return false;
  return at - before <= windowSeconds * 1000;
}

export function canCancel(
  pass: { state: PassState; studentId: string },
  callerStudentId: string,
): Verdict {
  if (pass.studentId !== callerStudentId) {
    return { ok: false, reason: "This pass is not yours." };
  }

  if (pass.state === "requested") return { ok: true, reason: "" };

  if (isTerminal(pass.state)) {
    return { ok: false, reason: `This pass is already ${pass.state}.` };
  }

  return {
    ok: false,
    reason:
      "Your teacher has already approved this pass. Tap the tag in the " +
      "classroom you left to close it.",
  };
}
