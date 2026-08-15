// Hall pass state machine. Run: npm test
//
// These are the rules that decide whether a child may be out of a classroom and
// how long they were gone, so they are tested against the real module rather
// than a copy of the logic.

import { readFileSync } from "node:fs";
import {
  applyTap,
  canApprove,
  canCancel,
  canForceClose,
  canRedeemTapIntent,
  canRequest,
  elapsedMinutes,
  hasCorruptClock,
  isAbandoned,
  isDuplicateTapEvent,
  isOverdue,
  isStaleRequest,
  isTerminal,
  hasLivePass,
  passesTakenOnDay,
  schoolDayKey,
  shouldExpire,
  sortLiveBoard,
  trimReason,
  validatePassMinutes,
  withinTapRateLimit,
  EXPIRY_GRACE_MINUTES,
  MAX_PASSES_PER_SCHOOL_DAY,
  MAX_PASS_MINUTES,
  MAX_REASON_LENGTH,
  MAX_REQUEST_AGE_MINUTES,
  MAX_TAP_INTENTS_PER_WINDOW,
  MIN_PASS_MINUTES,
  PASS_STATES,
  TAP_EVENT_DEDUPE_SECONDS,
  TERMINAL_STATES,
} from "./hallPassRules.ts";

/** A reason good enough to pass the force-close gate. */
const A_REASON = "End of day sweep by the front office.";

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
}

const ROOM = "loc-room-12";
const BATHROOM = "loc-restroom-2";
const OFFICE = "loc-office";
const T = (m) => new Date(Date.UTC(2026, 7, 13, 10, m)).toISOString();

const base = {
  studentId: "s-1",
  originLocationId: ROOM,
  requestedAt: T(0),
  expiresAfterMinutes: 10,
};

console.log("\nApproval");
{
  check("a fresh request can be approved", canApprove({ ...base, state: "requested" }).ok);
  check("an approved pass cannot be approved twice", !canApprove({ ...base, state: "active" }).ok);
  check("a returned pass cannot be re-approved", !canApprove({ ...base, state: "returned" }).ok);
  check(
    "and the refusal says which state it is in",
    /returned/.test(canApprove({ ...base, state: "returned" }).reason),
  );
}

console.log("\nThe tap order is enforced");
{
  const active = { ...base, state: "active", approvedAt: T(1) };

  // The whole point. Tapping the classroom on the way out would close a pass
  // that was never used, and the record would look complete.
  const cheat = applyTap(active, ROOM, T(2));
  check("tapping the origin first is REFUSED", !cheat.ok, JSON.stringify(cheat));
  check("and it says to tap the destination first", /where you are going/i.test(cheat.reason));

  const arrive = applyTap(active, BATHROOM, T(2));
  check("tapping the destination moves it to out", arrive.ok && arrive.nextState === "out");
  check("and records outAt", arrive.field === "outAt");
}

console.log("\nA teacher-assigned destination is the tag that validates the pass");
{
  // A teacher picked the student and the place. "Tap the destination NFC tag in
  // order to validate the pass" is only true if tapping a DIFFERENT tag does
  // not: without this the assignment is decoration, and a student sent to the
  // office could validate at any sticker in the building while the record shows
  // a completed trip to the office.
  const sent = {
    ...base,
    state: "active",
    approvedAt: T(1),
    assignedDestinationLocationId: OFFICE,
  };

  const elsewhere = applyTap(sent, BATHROOM, T(2));
  check("tapping somewhere other than the assigned place is REFUSED", !elsewhere.ok);
  check("and it says to tap the place on the pass", /place on your pass/i.test(elsewhere.reason));

  const arrived = applyTap(sent, OFFICE, T(2));
  check("tapping the assigned place validates it", arrived.ok && arrived.nextState === "out");

  // ORDER STILL HOLDS. The origin refusal comes first, so a student tapping
  // their own classroom on the way out hears about that rather than about the
  // destination, which is the tap that would otherwise close an unused pass.
  const onTheWayOut = applyTap(sent, ROOM, T(2));
  check("and the origin is still refused before anything else", !onTheWayOut.ok);
  check(
    "with the origin message, not the destination one",
    /where you are going/i.test(onTheWayOut.reason),
  );

  // A pass with no assignment is unchanged. This is the student-initiated path
  // and the whole of the behaviour that existed before.
  const free = { ...base, state: "active", approvedAt: T(1) };
  check("an unassigned pass accepts any tag but the origin", applyTap(free, OFFICE, T(2)).ok);
  check("and still refuses the origin", !applyTap(free, ROOM, T(2)).ok);

  // The assignment constrains the FIRST tap only. Coming back is still the
  // classroom, never the place they were sent.
  const outThere = {
    ...sent,
    state: "out",
    outAt: T(2),
    destinationLocationId: OFFICE,
  };
  check(
    "the assigned destination does not close the pass",
    !applyTap(outThere, OFFICE, T(6)).ok,
    "only the classroom of origin ends a trip",
  );
  check("the classroom does", applyTap(outThere, ROOM, T(6)).ok);
}

console.log("\nOnly the origin closes a pass");
{
  const out = { ...base, state: "out", approvedAt: T(1), outAt: T(2), destinationLocationId: BATHROOM };

  const wrong = applyTap(out, OFFICE, T(5));
  check("tapping a third location does NOT close it", !wrong.ok, JSON.stringify(wrong));
  check("and it says to tap the room they left", /classroom you left/i.test(wrong.reason));

  const back = applyTap(out, ROOM, T(6));
  check("tapping the origin closes it", back.ok && back.nextState === "returned");
  check("and records returnedAt", back.field === "returnedAt");
}

console.log("\nTaps that should do nothing, and say so");
{
  const requested = { ...base, state: "requested" };
  const early = applyTap(requested, BATHROOM, T(1));
  check("an unapproved pass cannot be tapped", !early.ok);
  check(
    "and the student is told why, not left guessing",
    /not approved|has not approved/i.test(early.reason),
    early.reason,
  );

  for (const state of ["returned", "denied", "cancelled", "expired"]) {
    const result = applyTap({ ...base, state }, BATHROOM, T(9));
    check(`a ${state} pass refuses taps`, !result.ok);
    check(`and names the state (${state})`, result.reason.includes(state));
  }
}

console.log("\nElapsed time");
{
  const p = { ...base, state: "active", approvedAt: T(0) };
  check("counts from APPROVAL, not from the request", elapsedMinutes(p, T(5)) === 5);
  check(
    "a request nobody answered has no elapsed time",
    elapsedMinutes({ ...base, state: "requested" }, T(30)) === null,
    "otherwise every unanswered request looks like a truancy",
  );
  const closed = { ...base, state: "returned", approvedAt: T(0), returnedAt: T(7) };
  check("a closed pass stops counting", elapsedMinutes(closed, T(90)) === 7);
  check("elapsed never goes negative", elapsedMinutes({ ...p, approvedAt: T(10) }, T(5)) === 0);
}

console.log("\nOverdue");
{
  const p = { ...base, state: "out", approvedAt: T(0), outAt: T(1) };
  check("not overdue inside the window", !isOverdue(p, T(9)));
  check("overdue past it", isOverdue(p, T(11)));
  check(
    "a returned pass is never overdue, however long it took",
    !isOverdue({ ...base, state: "returned", approvedAt: T(0), returnedAt: T(90) }, T(200)),
  );
  check("a pass nobody approved is not overdue", !isOverdue({ ...base, state: "requested" }, T(200)));
}

console.log("\nOne live pass at a time");
{
  check("no passes means none live", !hasLivePass([]));
  check("a returned pass is not live", !hasLivePass([{ state: "returned" }]));
  check("an active one is", hasLivePass([{ state: "returned" }, { state: "active" }]));
  check("so is a request waiting on a teacher", hasLivePass([{ state: "requested" }]));
  check("terminal states are terminal", ["returned", "denied", "cancelled", "expired"].every(isTerminal));
  check("live states are not", !["requested", "active", "out"].some(isTerminal));
}

// ---------------------------------------------------------------------------
// The student-initiated half. These are the adversarial cases: the states a
// student can put themselves into and then cannot get out of, and the states
// they can reach by naming a record that is not theirs.
// ---------------------------------------------------------------------------

const OPEN_ROOM = { active: true };
const RETIRED_ROOM = { active: false };

/** "now" for the request rules, and a helper for a pass actually TAKEN today. */
const NOW = T(30);
const doneToday = (n) =>
  Array.from({ length: n }, () => ({
    state: "returned",
    requestedAt: T(0),
    // Approval is what makes it count. See passesTakenOnDay.
    approvedAt: T(1),
  }));

console.log("\nA student asking for their own pass");
{
  check("a student with no history may ask", canRequest([], OPEN_ROOM, NOW).ok);
  check(
    "a student whose passes are all closed may ask",
    canRequest(
      [
        { state: "returned", requestedAt: T(0) },
        { state: "denied", requestedAt: T(0) },
        { state: "cancelled", requestedAt: T(0) },
        { state: "expired", requestedAt: T(0) },
      ],
      OPEN_ROOM,
      NOW,
    ).ok,
  );

  // THE STUCK REQUEST. A teacher who never answers leaves `requested`, which
  // hasLivePass counts as live, so this student is blocked from every future
  // pass until something writes a terminal state. If this check ever passes,
  // the escape hatch below is the only thing standing between a child and a
  // year with no hall passes.
  const stuck = canRequest([{ state: "requested", requestedAt: T(0) }], OPEN_ROOM, NOW);
  check("an unanswered request BLOCKS a new one", !stuck.ok, JSON.stringify(stuck));
  check(
    "and the refusal names the way out rather than only refusing",
    /cancel/i.test(stuck.reason),
    stuck.reason,
  );

  // A second concurrent pass. Two open timers cannot be reconciled from the
  // taps afterwards, so the record becomes unreadable exactly when it matters.
  check(
    "a second request while one is active is refused",
    !canRequest([{ state: "active", requestedAt: T(0) }], OPEN_ROOM, NOW).ok,
  );
  check(
    "a second request while already out is refused",
    !canRequest([{ state: "out", requestedAt: T(0) }], OPEN_ROOM, NOW).ok,
  );
  check(
    "one live pass among many closed ones still blocks",
    !canRequest(
      [
        { state: "returned", requestedAt: T(0) },
        { state: "active", requestedAt: T(0) },
        { state: "denied", requestedAt: T(0) },
      ],
      OPEN_ROOM,
      NOW,
    ).ok,
  );

  check("a room with no tag is refused", !canRequest([], null, NOW).ok);
  check("a retired tag is refused", !canRequest([], RETIRED_ROOM, NOW).ok);
  check(
    "a retired tag and an unknown one read identically to a student",
    canRequest([], null, NOW).reason === canRequest([], RETIRED_ROOM, NOW).reason,
    "otherwise the picker becomes a way to enumerate tags that used to exist",
  );

  // Ordering. The live pass is the blocker that will still be there after they
  // pick a different room, so it is the one they must be told about.
  check(
    "a stuck pass is reported before a bad room",
    /already have/i.test(
      canRequest([{ state: "requested", requestedAt: T(0) }], null, NOW).reason,
    ),
  );
}

// ---------------------------------------------------------------------------
// The write ceiling. requestMine is a mutation any signed-in child can call in
// a loop, and nothing in this repo deletes a hallPasses row. Convex allows
// 4,096 reads per execution; psSync.ts records this codebase already breaking
// at 5,812 rows. Without a cap the failure is the teacher live board throwing
// for everybody, permanently, with no delete path to recover with.
// ---------------------------------------------------------------------------
console.log("\nThe daily write ceiling");
{
  const atLimit = doneToday(MAX_PASSES_PER_SCHOOL_DAY);
  const belowLimit = doneToday(MAX_PASSES_PER_SCHOOL_DAY - 1);

  check("under the limit is allowed", canRequest(belowLimit, OPEN_ROOM, NOW).ok);

  const capped = canRequest(atLimit, OPEN_ROOM, NOW);
  check("at the limit is refused", !capped.ok, JSON.stringify(capped));
  check("and one over is refused", !canRequest(doneToday(50), OPEN_ROOM, NOW).ok);
  check(
    "the refusal tells the student the count and points at a teacher",
    /\d/.test(capped.reason) && /teacher/i.test(capped.reason),
    capped.reason,
  );

  // A loop cannot walk past it: every attempt adds a row, and every row counts.
  check(
    "1000 passes today is still refused, not wrapped around",
    !canRequest(doneToday(1000), OPEN_ROOM, NOW).ok,
  );

  // Yesterday's passes must not consume today's allowance.
  const yesterday = Array.from({ length: 50 }, () => ({
    state: "returned",
    requestedAt: "2026-08-01T18:00:00.000Z",
  }));
  check("yesterday's passes do not count against today", canRequest(yesterday, OPEN_ROOM, NOW).ok);

  // Ordering: the cap is reported before the room, so a student who is out of
  // passes is not sent off to pick a different room first.
  check(
    "the cap is reported before a bad room",
    /limit/i.test(canRequest(atLimit, null, NOW).reason),
  );
  // But a live pass still outranks it, because that one has an escape hatch.
  check(
    "a live pass is still reported before the cap",
    /already have/i.test(
      canRequest([...atLimit, { state: "requested", requestedAt: T(0) }], OPEN_ROOM, NOW).reason,
    ),
  );

  check(
    "a corrupt timestamp is not counted into today",
    passesTakenOnDay([{ requestedAt: "nonsense", approvedAt: T(1) }], NOW) === 0,
  );
  check("nor can it be used to exhaust an allowance", canRequest(
    Array.from({ length: 99 }, () => ({ state: "returned", requestedAt: "nonsense", approvedAt: T(1) })),
    OPEN_ROOM,
    NOW,
  ).ok);
}

// ---------------------------------------------------------------------------
// USING THE ESCAPE HATCH MUST NOT COST AN ALLOWANCE.
//
// The cap counted every row, so eight cancelled requests burned the whole day
// and the ninth attempt was refused with "You have already had 8 hall passes
// today" to a student who had been out of class exactly zero times. Cancel is
// documented as the way out of a request a teacher never answered, so counting
// it turned the fix into a punishment; denied was worse, because the student did
// not even choose it.
// ---------------------------------------------------------------------------
console.log("\nOnly passes actually TAKEN count against the cap");
{
  const many = (n, extra) =>
    Array.from({ length: n }, () => ({ requestedAt: T(0), ...extra }));

  check(
    "eight cancelled requests cost nothing",
    canRequest(many(MAX_PASSES_PER_SCHOOL_DAY, { state: "cancelled" }), OPEN_ROOM, NOW).ok,
    "cancelling is the escape hatch; charging for it makes it a trap",
  );
  check(
    "eight denied requests cost nothing",
    canRequest(many(MAX_PASSES_PER_SCHOOL_DAY, { state: "denied" }), OPEN_ROOM, NOW).ok,
  );
  check(
    "requests that expired unanswered cost nothing",
    canRequest(many(MAX_PASSES_PER_SCHOOL_DAY, { state: "expired" }), OPEN_ROOM, NOW).ok,
    "the teacher ignored them; the student was never out of class",
  );
  check(
    "but an approved pass that was later force-closed DOES count",
    !canRequest(
      many(MAX_PASSES_PER_SCHOOL_DAY, { state: "expired", approvedAt: T(1) }),
      OPEN_ROOM,
      NOW,
    ).ok,
    "they were out of class; how the pass ended does not change that",
  );
  check(
    "and a returned one counts",
    !canRequest(
      many(MAX_PASSES_PER_SCHOOL_DAY, { state: "returned", approvedAt: T(1) }),
      OPEN_ROOM,
      NOW,
    ).ok,
  );

  // The mixed day a real student has.
  const mixed = [
    ...many(3, { state: "returned", approvedAt: T(1) }),
    ...many(9, { state: "cancelled" }),
    ...many(4, { state: "denied" }),
  ];
  check("three taken plus thirteen refused is still under the cap", canRequest(mixed, OPEN_ROOM, NOW).ok);
  check("and the count reported is the taken one", passesTakenOnDay(mixed, NOW) === 3);
}

console.log("\nThe school day rolls over at night, not during a lesson");
{
  // 12:00 UTC is 05:00 PDT / 04:00 PST. Both are hours before anybody arrives.
  check(
    "09:00Z and 13:00Z on one UTC date are DIFFERENT school days",
    schoolDayKey("2026-08-13T09:00:00.000Z") !== schoolDayKey("2026-08-13T13:00:00.000Z"),
  );
  // THE case the offset exists for: an after-school session that crosses UTC
  // midnight. A raw UTC date would hand that student a fresh allowance at 5pm.
  check(
    "16:00 and 19:00 Los Angeles time are the SAME school day, across UTC midnight",
    schoolDayKey("2026-08-13T23:00:00.000Z") === schoolDayKey("2026-08-14T02:00:00.000Z"),
    "otherwise the cap silently doubles for anyone still on site after 5pm",
  );
  check(
    "a whole school day maps to one key",
    schoolDayKey("2026-08-13T15:00:00.000Z") === schoolDayKey("2026-08-13T22:00:00.000Z"),
  );
  check("an unparseable timestamp has no day", schoolDayKey("nonsense") === "");
  check("and undefined has no day", schoolDayKey(undefined) === "");
}

console.log("\nCancelling a pass: the escape hatch, and its limits");
{
  const MINE = "s-1";
  const THEIRS = "s-2";
  const owned = (state, studentId = MINE) => ({ ...base, state, studentId });

  check("a student may cancel their own unanswered request", canCancel(owned("requested"), MINE).ok);

  // Which is the whole point: this is what unsticks the case above.
  check(
    "cancelling clears the block, so the student can ask again",
    canRequest([{ state: "cancelled", requestedAt: T(0) }], OPEN_ROOM, NOW).ok,
  );

  const approved = canCancel(owned("active"), MINE);
  check("a student may NOT cancel a pass their teacher approved", !approved.ok, JSON.stringify(approved));
  check(
    "and is told to tap back in instead of being left stuck",
    /tap the tag/i.test(approved.reason),
    approved.reason,
  );
  check("nor one they are already out on", !canCancel(owned("out"), MINE).ok);

  for (const state of ["returned", "denied", "cancelled", "expired"]) {
    const result = canCancel(owned(state), MINE);
    check(`a ${state} pass cannot be cancelled again`, !result.ok);
    check(`and the refusal names the state (${state})`, result.reason.includes(state));
  }

  // Somebody else's pass. The id is the only thing the caller supplies, and it
  // must not become a way to reach another child's record or learn about it.
  const notMine = canCancel(owned("requested", THEIRS), MINE);
  check("a student may NOT cancel somebody else's pass", !notMine.ok, JSON.stringify(notMine));
  check(
    "and the refusal does not disclose that pass's state",
    !/requested|active|out|returned|denied|expired/.test(notMine.reason),
    notMine.reason,
  );
  check(
    "ownership is checked BEFORE state, so every state of theirs refuses identically",
    ["requested", "active", "out", "returned", "denied", "cancelled", "expired"].every(
      (state) => canCancel(owned(state, THEIRS), MINE).reason === notMine.reason,
    ),
    "otherwise the refusal reports whether that child is currently out of class",
  );
}

console.log("\nThe reason a student types");
{
  check("an absent reason stays absent", trimReason(undefined) === undefined);
  check("a null reason stays absent", trimReason(null) === undefined);
  check("a blank reason becomes absent, not a stored empty line", trimReason("   ") === undefined);
  check("400 spaces is empty, not a truncated blank", trimReason(" ".repeat(400)) === undefined);
  check("whitespace is collapsed", trimReason("  need   the\n restroom ") === "need the restroom");
  check(
    "a long reason is capped so one student cannot fill the teacher's board",
    trimReason("x".repeat(500)).length === MAX_REASON_LENGTH,
  );
  check("a normal reason survives unchanged", trimReason("restroom") === "restroom");
}

// ---------------------------------------------------------------------------
// EVERY LIVE STATE MUST HAVE A WAY OUT.
//
// The previous version of this file proved the trap and called it "its limits":
// canCancel freed `requested` and a return tap freed `out`, nothing wrote
// `expired`, no cron swept, and no staff mutation could close a pass. So a
// teacher approving at 2:50pm on a Friday left that child blocked from every
// future hall pass for the rest of their time at the school, and the invisible
// version was worse: `tap` refuses an inactive tag before it looks at the pass,
// so retiring a room's tag stranded every student currently `out` from it with
// no error anywhere.
//
// This section does not test a state, it tests the GRAPH: from every reachable
// live state, following only transitions the deployed code can actually make,
// a terminal state must be reachable. Tightening any rule below in a way that
// closes the last exit out of a state fails here rather than in a corridor.
// ---------------------------------------------------------------------------
console.log("\nStaff can close a pass that will never close itself");
{
  for (const state of ["requested", "active", "out"]) {
    check(`staff may force-close a ${state} pass`, canForceClose({ state }, A_REASON).ok);
  }
  for (const state of TERMINAL_STATES) {
    const v = canForceClose({ state }, A_REASON);
    check(`a ${state} pass cannot be force-closed again`, !v.ok);
    check(`and the refusal names the state (${state})`, v.reason.includes(state));
  }

  // The reason gate is INSIDE the rule, not in the handler. While it sat in the
  // handler, canForceClose was exactly !isTerminal, which made the reachability
  // search below a tautology.
  for (const [label, reason] of [
    ["no reason", undefined],
    ["a null reason", null],
    ["an empty reason", ""],
    ["a whitespace-only reason", "     "],
    ["a reason of 400 spaces", " ".repeat(400)],
  ]) {
    const v = canForceClose({ state: "active" }, reason);
    check(`force-close with ${label} is refused`, !v.ok, JSON.stringify(v));
    check(`and it says what to write instead (${label})`, /say why/i.test(v.reason));
  }
  check(
    "canForceClose is NOT merely !isTerminal",
    !canForceClose({ state: "active" }, "").ok && canForceClose({ state: "active" }, A_REASON).ok,
    "if it were, the reachability search below would prove nothing",
  );
}

console.log("\nThe sweep only reaps what nobody is coming back to");
{
  const active = { ...base, state: "active", approvedAt: T(0) };

  check("not swept inside its window", !isAbandoned(active, T(5)));
  // THE distinction that protects a real child: overdue is a teacher's signal,
  // expiry is a write to a record with nobody looking. A student two minutes
  // late is overdue and must NOT be expired, or their return tap is refused and
  // the trip ends with no close at all.
  check("overdue the moment it runs long", isOverdue(active, T(11)));
  check("but NOT swept while merely overdue", !isAbandoned(active, T(11)));
  check(
    "swept only past the grace period",
    isAbandoned(active, T(10 + EXPIRY_GRACE_MINUTES + 1)),
  );
  check(
    "the grace period is not zero",
    EXPIRY_GRACE_MINUTES > 0,
    "a zero grace closes the pass of a student who is walking back",
  );

  // `requested` needed its own clock: it has no approvedAt, so elapsedMinutes is
  // null for it and isAbandoned can never fire. Left out, an unanswered request
  // is live forever and sits on the board until the board is only residue.
  const req = { ...base, state: "requested" };
  check("a fresh request is not stale", !isStaleRequest(req, T(10)));
  check("an ancient request is stale", isStaleRequest(req, T(MAX_REQUEST_AGE_MINUTES + 1)));
  check("isAbandoned alone would never catch it", !isAbandoned(req, T(100000)));
  check("shouldExpire does", shouldExpire(req, T(100000)));

  for (const state of TERMINAL_STATES) {
    check(`the sweep never touches a ${state} pass`, !shouldExpire({ ...base, state, approvedAt: T(0) }, T(100000)));
  }
}

console.log("\nEvery live state has a path to a terminal state");
{
  const MINE = "s-1";
  const LIVE = PASS_STATES.filter((s) => !isTerminal(s));
  check("there are exactly three live states", LIVE.length === 3, LIVE.join(","));

  /**
   * Every transition the deployed code can perform out of `state`, each gated by
   * calling the REAL rule that gates it in its handler.
   *
   * `enabled` lets a caller DELETE mechanisms and re-run the search. That is the
   * point: the previous version of this test passed with cancel, deny, the taps
   * and the cron all removed, because canForceClose was `!isTerminal` and its
   * edge fired unconditionally out of everything. A reachability test that
   * cannot report "no path" is not testing reachability.
   */
  function exitsFrom(state, enabled = {}) {
    const {
      cancel = true, approve = true, deny = true,
      taps = true, forceClose = true, sweep = true,
    } = enabled;

    const p = {
      ...base,
      state,
      studentId: MINE,
      approvedAt: state === "requested" ? undefined : T(1),
    };
    const found = [];

    if (cancel && canCancel(p, MINE).ok) found.push("cancelled");
    if (approve && canApprove(p).ok) found.push("active");
    // hallPasses.deny, gated in its handler on state === "requested"
    if (deny && state === "requested") found.push("denied");
    if (taps) {
      for (const loc of [ROOM, BATHROOM, OFFICE]) {
        const r = applyTap(p, loc, T(5));
        if (r.ok) found.push(r.nextState);
      }
    }
    // A staff force-close is only an exit if a staff member actually supplies a
    // reason, which is what canForceClose now requires.
    if (forceClose && canForceClose(p, A_REASON).ok) found.push("expired");
    if (sweep && shouldExpire({ ...p, approvedAt: T(0), requestedAt: T(0) }, T(100000))) {
      found.push("expired");
    }

    return [...new Set(found)];
  }

  function reaches(start, enabled) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      for (const s of exitsFrom(queue.shift(), enabled)) {
        if (isTerminal(s)) return s;
        if (!seen.has(s)) { seen.add(s); queue.push(s); }
      }
    }
    return null;
  }

  for (const start of LIVE) {
    check(`${start} can reach a terminal state (via ${reaches(start, {})})`, reaches(start, {}) !== null);
  }

  // THE ANTI-TAUTOLOGY ASSERTION. Construct a world with no way out and confirm
  // the search REPORTS it. If this ever passes, every check above is worthless.
  const stranded = { taps: false, forceClose: false, sweep: false };
  check(
    "with taps, force-close and the sweep all removed, active is STUCK",
    reaches("active", stranded) === null,
    "the search must be able to detect a trap, or it is not detecting anything",
  );
  check(
    "and out is STUCK too",
    reaches("out", stranded) === null,
  );
  check(
    "but requested still escapes, because cancel and deny are still there",
    reaches("requested", stranded) !== null,
  );

  // Now the ablations that must NOT strand anybody. Each one deletes a whole
  // mechanism and the graph has to survive on the others.
  const ABLATIONS = [
    ["with force-close deleted", { forceClose: false }],
    ["with the cron sweep deleted", { sweep: false }],
    ["with cancel deleted", { cancel: false }],
    ["with every tap refused (the retired-tag case)", { taps: false }],
    ["with taps refused AND force-close deleted", { taps: false, forceClose: false }],
    ["with taps refused AND the sweep deleted", { taps: false, sweep: false }],
  ];
  for (const [label, enabled] of ABLATIONS) {
    check(
      `every live state still reaches a terminal state ${label}`,
      LIVE.every((s) => reaches(s, enabled) !== null),
      LIVE.map((s) => `${s}->${reaches(s, enabled)}`).join(" "),
    );
  }

  // The specific hole that existed, asserted WITHOUT leaning on force-close:
  // a student who has left the building, or whose origin tag was retired while
  // they were out, cannot tap. The cron alone has to be able to free them.
  for (const start of ["active", "out"]) {
    check(
      `${start} is freed by the sweep ALONE, with no tap and no staff action`,
      reaches(start, { taps: false, forceClose: false, cancel: false, approve: false, deny: false }) !== null,
    );
  }
  check(
    "and a stale request is freed by the sweep alone too",
    reaches("requested", { taps: false, forceClose: false, cancel: false, approve: false, deny: false }) !== null,
  );

  check("every live state has at least one exit", LIVE.every((s) => exitsFrom(s).length > 0));
}

// The sweep only frees anybody if it is actually scheduled. Asserted against the
// SOURCE because crons.ts imports the Convex server runtime and the generated
// api, neither of which loads in plain Node. Crude, and it fails if somebody
// deletes the registration, which is the failure worth catching: every "the
// student can always get out" claim above depends on this line existing.
console.log("\nThe sweep is actually registered");
{
  const crons = readFileSync(new URL("./crons.ts", import.meta.url), "utf8");
  check("crons.ts registers a job", /crons\.(cron|daily|interval|hourly)\(/.test(crons));
  check(
    "and it is the hall pass expiry sweep",
    /internal\.hallPasses\.expireAbandoned/.test(crons),
    "without this, active and out have no automatic exit at all",
  );
  check("it runs at least hourly", /"\d+ \* \* \* \*"/.test(crons), "a daily sweep leaves a child blocked all day");

  const handlers = readFileSync(new URL("./hallPasses.ts", import.meta.url), "utf8");
  check("the function the cron names exists", /export const expireAbandoned = internalMutation/.test(handlers));
  check("and it is internal, not callable from a browser", !/export const expireAbandoned = mutation/.test(handlers));
  check("staff force-close exists as a real mutation", /export const forceClose = mutation/.test(handlers));
}

console.log("\nA forced close stops the clock");
{
  // Without closedAt in elapsedMinutes, a swept pass counts up forever and a
  // trip from last October reads as 47,000 minutes out of class.
  const closed = { ...base, state: "expired", approvedAt: T(0), closedAt: T(9) };
  check("elapsed stops at closedAt", elapsedMinutes(closed, T(90000)) === 9);
  check(
    "a real return tap still wins over a forced close",
    elapsedMinutes({ ...closed, returnedAt: T(4) }, T(90000)) === 4,
    "returnedAt is a measurement, closedAt is somebody's say-so",
  );
  check(
    "an expired pass with no closedAt still degrades to counting, not to null",
    elapsedMinutes({ ...base, state: "expired", approvedAt: T(0) }, T(30)) === 30,
  );
  check("and it is never overdue once terminal", !isOverdue(closed, T(90000)));
}

// ---------------------------------------------------------------------------
// An unvalidated `minutes` on approve put the trap back. 1e12 makes a pass that
// is never overdue, never swept and permanently live, so the student can never
// have another pass: exactly the state this branch exists to make unreachable,
// reintroduced through one argument nobody checked.
// ---------------------------------------------------------------------------
console.log("\nHow long a teacher may make a pass");
{
  check("a normal value is accepted", validatePassMinutes(15).minutes === 15);
  check("the floor is accepted", validatePassMinutes(MIN_PASS_MINUTES).ok);
  check("the ceiling is accepted", validatePassMinutes(MAX_PASS_MINUTES).ok);

  const huge = validatePassMinutes(1e12);
  check("1e12 is REFUSED", !huge.ok);
  check(
    "and the refusal explains that it would strand the student",
    /never|unable to ask/i.test(huge.reason),
    huge.reason,
  );
  // Prove the claim rather than asserting it: a pass that long really is
  // untouchable by the sweep.
  const forever = { ...base, state: "active", approvedAt: T(0), expiresAfterMinutes: 1e12 };
  check("a 1e12-minute pass is never overdue", !isOverdue(forever, T(500000)));
  check("and the sweep will never take it", !shouldExpire(forever, T(500000)));
  check("which is why the ceiling exists", MAX_PASS_MINUTES < 1e12);
  const capped = { ...forever, expiresAfterMinutes: MAX_PASS_MINUTES };
  check(
    "at the ceiling the sweep still reaches it",
    shouldExpire(capped, T(MAX_PASS_MINUTES + EXPIRY_GRACE_MINUTES + 2)),
  );

  check("zero is refused, not silently treated as absent", !validatePassMinutes(0).ok);
  check("negative is refused", !validatePassMinutes(-5).ok);
  check("a fraction is refused rather than rounded", !validatePassMinutes(10.5).ok);
  check("and the fraction refusal says whole number", /whole number/i.test(validatePassMinutes(10.5).reason));
  check("NaN is refused", !validatePassMinutes(NaN).ok);
  check("Infinity is refused", !validatePassMinutes(Infinity).ok);
  check("a string is refused", !validatePassMinutes("15").ok);
  check("undefined is refused", !validatePassMinutes(undefined).ok);
  check("one over the ceiling is refused", !validatePassMinutes(MAX_PASS_MINUTES + 1).ok);
  check("no refusal ever hands back a value", [0, -5, 10.5, NaN, 1e12, "15", undefined].every(
    (m) => validatePassMinutes(m).minutes === undefined,
  ));
}

// ---------------------------------------------------------------------------
// TAP FORGERY. The page fires a tap from `?tap=<slug>` on load, so a slug alone
// was proof of presence and any student could make a classmate tap by sending
// them a link: writing returnedAt on a trip the victim was still on, forging
// their destination, or filing a refused-tap row under their name.
// ---------------------------------------------------------------------------
console.log("\nA tap needs an intent token, not just a slug");
{
  const VICTIM = "s-victim";
  const ATTACKER = "s-attacker";
  const SLUG = "restroom-2";
  const fresh = {
    studentId: VICTIM,
    locationSlug: SLUG,
    expiresAt: T(2),
  };

  check("a fresh intent for me, at this tag, redeems", canRedeemTapIntent(fresh, VICTIM, SLUG, T(1)).ok);

  // THE attack. A link carries a slug and nothing else.
  const bare = canRedeemTapIntent(null, VICTIM, SLUG, T(1));
  check("a tap with NO intent is refused", !bare.ok);
  check(
    "and the refusal tells the student to use the button",
    /press the button/i.test(bare.reason),
    bare.reason,
  );

  // An attacker cannot mint one and hand it over.
  const stolen = canRedeemTapIntent(fresh, ATTACKER, SLUG, T(1));
  check("somebody else's intent is refused", !stolen.ok);
  check(
    "and it is refused with the SAME words as a missing one",
    stolen.reason === bare.reason,
    "otherwise the endpoint tells an attacker that a given token is real",
  );

  // Replay: a screenshotted or forwarded link that worked once must not work
  // again, in anybody's hands.
  const used = { ...fresh, usedAt: T(1) };
  check("a used intent is refused", !canRedeemTapIntent(used, VICTIM, SLUG, T(2)).ok);
  check("and says so", /already used/i.test(canRedeemTapIntent(used, VICTIM, SLUG, T(2)).reason));
  check("a used intent is refused for the attacker too", !canRedeemTapIntent(used, ATTACKER, SLUG, T(2)).ok);

  check("an expired intent is refused", !canRedeemTapIntent(fresh, VICTIM, SLUG, T(30)).ok);
  check("and says so", /expired/i.test(canRedeemTapIntent(fresh, VICTIM, SLUG, T(30)).reason));
  check("exactly at the expiry instant it still works", canRedeemTapIntent(fresh, VICTIM, SLUG, T(2)).ok);

  // Bound to ONE slug: a token minted for the restroom must not close a trip by
  // being redeemed at the classroom.
  const wrongTag = canRedeemTapIntent(fresh, VICTIM, "room-12", T(1));
  check("an intent for another tag is refused", !wrongTag.ok);
  check("and says it was for a different tag", /different tag/i.test(wrongTag.reason));

  check("a corrupt expiry is refused rather than treated as forever", !canRedeemTapIntent(
    { ...fresh, expiresAt: "nonsense" }, VICTIM, SLUG, T(1),
  ).ok);
  check("an empty slug matches nothing", !canRedeemTapIntent(fresh, VICTIM, "", T(1)).ok);
}

console.log("\nThe tap flood, which erased the tag-health screen");
{
  const at = (m) => ({ createdAt: T(m) });
  check("a first check-in is allowed", withinTapRateLimit([], T(10)).ok);
  check(
    "a handful in the window is allowed",
    withinTapRateLimit([at(9), at(8)], T(10)).ok,
  );
  const flood = Array.from({ length: MAX_TAP_INTENTS_PER_WINDOW }, () => at(9));
  check("at the limit it is refused", !withinTapRateLimit(flood, T(10)).ok);
  check("and the refusal is readable", /too quickly/i.test(withinTapRateLimit(flood, T(10)).reason));
  check(
    "old check-ins fall out of the window",
    withinTapRateLimit(Array.from({ length: 100 }, () => at(0)), T(600)).ok,
  );
  check(
    "corrupt timestamps do not count toward the limit",
    withinTapRateLimit(Array.from({ length: 100 }, () => ({ createdAt: "nonsense" })), T(10)).ok,
  );

  // Second line: identical repeats collapse to one row.
  const prev = { locationSlug: "restroom-2", outcome: "No open pass.", at: T(10) };
  check(
    "an identical repeat seconds later is a duplicate",
    isDuplicateTapEvent(prev, { locationSlug: "restroom-2", outcome: "No open pass." }, T(10)),
  );
  check(
    "a different tag is NOT a duplicate",
    !isDuplicateTapEvent(prev, { locationSlug: "room-12", outcome: "No open pass." }, T(10)),
  );
  check(
    "a different outcome is NOT a duplicate",
    !isDuplicateTapEvent(prev, { locationSlug: "restroom-2", outcome: "Arrived at destination." }, T(10)),
    "the second tap of a real trip must never be swallowed",
  );
  check(
    "the same tap much later is NOT a duplicate",
    !isDuplicateTapEvent(prev, { locationSlug: "restroom-2", outcome: "No open pass." }, T(10 + TAP_EVENT_DEDUPE_SECONDS)),
  );
  check("with no previous event nothing is a duplicate", !isDuplicateTapEvent(null, prev, T(10)));
}

// ---------------------------------------------------------------------------
// A corrupt approvedAt made elapsedMinutes return NaN, which serializes to
// null, which on this field means "not approved yet". So a corrupt APPROVED
// pass rendered on the teacher board as a pending request, and every comparison
// against NaN being false made it invisible to the sweep at the same time.
// ---------------------------------------------------------------------------
console.log("\nA pass whose clock cannot be read");
{
  const broken = { ...base, state: "active", approvedAt: "not-a-date" };

  check("it is recognised as corrupt", hasCorruptClock(broken));
  check("a normal pass is not", !hasCorruptClock({ ...base, state: "active", approvedAt: T(0) }));
  check("nor an unapproved one with a good requestedAt", !hasCorruptClock({ ...base, state: "requested" }));

  check("elapsed is never NaN", !Number.isNaN(elapsedMinutes(broken, T(10))));
  check("it reports OVERDUE so it sorts to the top of the board", isOverdue(broken, T(10)));
  check("and the sweep can take it", shouldExpire(broken, T(10)));
  check(
    "a corrupt requestedAt on a request is swept too",
    shouldExpire({ ...base, state: "requested", requestedAt: "nonsense" }, T(10)),
  );
  check(
    "a corrupt terminal pass is left alone",
    !shouldExpire({ ...base, state: "returned", approvedAt: "nonsense" }, T(10)),
  );
  check("a corrupt end timestamp does not produce NaN either", !Number.isNaN(
    elapsedMinutes({ ...base, state: "returned", approvedAt: T(0), returnedAt: "nonsense" }, T(10)),
  ));
}

console.log("\nThe live board puts the exception at the top");
{
  const row = (name, overdue, elapsed) => ({ name, overdue, elapsedMinutes: elapsed });
  const input = [
    row("fresh", false, 1),
    row("long overdue", true, 90),
    row("waiting", false, null),
    row("just overdue", true, 11),
    row("out a while", false, 40),
  ];
  const order = input.map((r) => r.name);
  const sorted = sortLiveBoard(input);
  check("overdue comes first", sorted[0].overdue && sorted[1].overdue);
  check("longest overdue is top", sorted[0].name === "long overdue");
  check("then the longest non-overdue", sorted[2].name === "out a while");
  check("a pass with no elapsed time sinks", sorted[sorted.length - 1].name === "waiting");
  check("nothing is lost in the sort", sorted.length === 5);
  check(
    "the caller's array is not reordered underneath them",
    input.map((r) => r.name).join() === order.join(),
  );
  check("an empty board sorts to an empty board", sortLiveBoard([]).length === 0);
}

// ---------------------------------------------------------------------------
// THE INVARIANT FIVE WINDOWED READS DEPEND ON.
//
// requestMine, tap, passCard.mine, listForStudents and myPass all read only the
// student's newest N passes and then look for a live one. That is sound ONLY if
// at most one live pass exists and it is always the newest row. If either half
// is ever false, those reads silently miss a live pass, and missing it means
// letting a second one open.
//
// So this simulates the real write paths, each gated by the real rule, and
// asserts the invariant after every single step.
// ---------------------------------------------------------------------------
console.log("\nAt most one live pass, always the newest row");
{
  const MINE = "s-1";
  // Deterministic pseudo-random, so a failure is reproducible. xorshift32 with
  // int32 ops throughout: an LCG here silently lost precision past 2^53, the
  // masked result went constant, and the simulation ran the same operation 4000
  // times while still reporting a pass. Hence the "did something" assertion.
  let seed = 20260814;
  const rand = (n) => {
    seed ^= seed << 13; seed |= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed |= 0;
    return Math.abs(seed) % n;
  };

  let passes = [];
  let clock = 0;
  let violations = 0;
  let opened = 0;
  let closed = 0;

  const now = () => T(clock);
  const live = () => passes.filter((p) => !isTerminal(p.state));

  function invariant(step) {
    const open = live();
    if (open.length > 1) { violations++; return; }
    if (open.length === 1 && passes[passes.length - 1] !== open[0]) {
      violations++;
      console.log(`  ...live pass was not the newest row after ${step}`);
    }
  }

  const OPS = ["request", "approve", "deny", "cancel", "tapOut", "tapBack", "sweep", "force"];

  for (let i = 0; i < 4000; i++) {
    clock += 1 + rand(30);
    const op = OPS[rand(OPS.length)];
    // The handlers read only the newest window; the simulation does the same,
    // so a bug that only shows up outside the window would show up here.
    const window = passes.slice(-40);
    const current = live()[0];

    if (op === "request") {
      if (canRequest(window, { active: true }, now()).ok) {
        passes.push({ ...base, state: "requested", studentId: MINE, requestedAt: now() });
        opened++;
      }
    } else if (op === "approve" && current) {
      if (canApprove(current).ok) current.state = "active", current.approvedAt = now();
    } else if (op === "deny" && current) {
      if (current.state === "requested") current.state = "denied", closed++;
    } else if (op === "cancel" && current) {
      if (canCancel(current, MINE).ok) current.state = "cancelled", closed++;
    } else if (op === "tapOut" && current) {
      const r = applyTap(current, BATHROOM, now());
      if (r.ok) current.state = r.nextState, current[r.field] = now();
    } else if (op === "tapBack" && current) {
      const r = applyTap(current, ROOM, now());
      if (r.ok) current.state = r.nextState, current[r.field] = now(), closed++;
    } else if (op === "sweep" && current) {
      if (shouldExpire(current, now())) current.state = "expired", current.closedAt = now(), closed++;
    } else if (op === "force" && current) {
      if (canForceClose(current, A_REASON).ok) current.state = "expired", current.closedAt = now(), closed++;
    }

    invariant(op);
  }

  check(`the invariant held across 4000 operations (${opened} opened, ${closed} closed)`, violations === 0);
  check("the simulation actually did something", opened > 50 && closed > 50, `${opened}/${closed}`);
  check("it ends with at most one live pass", live().length <= 1);

  // And the window itself is sound: the live pass is always inside the newest 40.
  check(
    "any live pass is inside the read window",
    live().length === 0 || passes.slice(-40).includes(live()[0]),
  );

  // The invariant checker must be capable of failing, or it proves nothing.
  passes.push({ ...base, state: "requested", studentId: MINE, requestedAt: now() });
  passes.push({ ...base, state: "active", studentId: MINE, requestedAt: now(), approvedAt: now() });
  const before = violations;
  invariant("deliberately corrupted state");
  check("and the checker detects two live passes when they exist", violations > before);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
