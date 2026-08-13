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
  requestedAt: string;
  approvedAt?: string;
  outAt?: string;
  returnedAt?: string;
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
 * How long a pass has been running, in minutes.
 *
 * Measured from APPROVAL, because that is when the student is permitted to be
 * out of class, and to the return tap once it exists so a closed pass stops
 * counting up forever in the UI.
 *
 * Returns null before approval: a request sitting in a teacher's queue is not
 * time out of class and showing it as such would make every unanswered request
 * look like a truancy.
 */
export function elapsedMinutes(pass: Pass, now: string): number | null {
  if (!pass.approvedAt) return null;
  const end = pass.returnedAt ?? now;
  return Math.max(0, minutes(pass.approvedAt, end));
}

/** Past its window and not yet back. Overdue is a display state, not a terminal one. */
export function isOverdue(pass: Pass, now: string): boolean {
  if (pass.state !== "active" && pass.state !== "out") return false;
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
    if (locationId === pass.originLocationId) {
      return {
        ok: false,
        reason: "Tap the tag at where you are going first, then tap back here when you return.",
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
