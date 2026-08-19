// A hall pass from issued to closed, as one trip. Run: npm test
//
// WHAT THIS EXISTS TO PROVE, AND THE NUMBER THAT SAYS IT DOES NOT YET.
//
// The tapEvents table in production holds ZERO rows. Not a few, not only
// refusals: nothing has ever successfully tapped anything. Every piece of the
// loop has its own passing test, and the loop itself has never run once. That is
// the shape of failure this file is aimed at, because it is the shape that
// survives a green suite: hallPassRules.test.mjs proves each transition in
// isolation, and a trip is not a transition, it is the handover between two of
// them plus the record left behind.
//
// A FINISHED LOOP IS TWO ACCEPTED TAPS AND A CLOSED PASS:
//
//   a teacher opens a pass, or a student asks and a teacher approves
//     -> the reach leg is running, timed from APPROVAL
//   the student taps the tag at the destination
//     -> the pass flips to `out` and the return leg starts FRESH from that tap
//   the student taps the tag in the room they left
//     -> the pass closes, `returnedAt` is written, and they are unblocked
//
// The three things a trip can get wrong that no single-transition test sees:
//
// 1. THE HANDOVER EATS THE RETURN LEG. If the return window were timed from
//    approval rather than from the destination tap, a child who took four
//    minutes to walk somewhere would arrive with six minutes of a ten minute
//    window left and be marked overdue for walking at a normal speed.
// 2. A REFUSED TAP MOVES THE PASS ANYWAY. The refusal path and the write path
//    are two branches of one mutation; if the write is not strictly behind the
//    refusal, tapping the wrong tag advances or closes a trip that never
//    happened.
// 3. AN UNTIMED PASS BECOMES AN UNCLOSEABLE ONE. Staff can lift the limit off a
//    pass so it is never overdue and never swept. If "never overdue" also meant
//    "the taps stop working", that is the permanent-live trap the whole state
//    machine exists to make unreachable, reintroduced through a feature.
//
// HOW THIS STAYS HONEST. The state machine is imported from the real
// convex/hallPassRules.ts, and the object a tap WRITES is sliced out of the real
// convex/hallPasses.ts rather than copied here, the same trick
// pass-clock.test.mjs and nfc-tag-decode.test.mjs use on script.js. A simulator
// carrying its own copy of either would keep passing after the shipped code
// changed underneath it, which is exactly how a loop nobody has run ends up with
// a green suite on top of it.
//
// WHAT IT STILL CANNOT PROVE: that a phone read a sticker. See the notes at the
// bottom of this file.

import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  applyTap,
  canApprove,
  canRedeemTapIntent,
  canRequest,
  elapsedMinutes,
  isAbandoned,
  isDuplicateTapEvent,
  isOverdue,
  isTerminal,
  hasLivePass,
  passClock,
  roomsNamedOnPasses,
  withinTapRateLimit,
  DEFAULT_REACH_MINUTES,
  EXPIRY_GRACE_MINUTES,
  TAP_INTENT_TTL_SECONDS,
} from "./convex/hallPassRules.ts";

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

// ===========================================================================
// THE SHIPPED WRITE, LIFTED
//
// `hallPasses.tap` decides nothing itself: applyTap says whether a tap counts
// and which column it lands in, and this object is what gets patched onto the
// row. Sliced out of the real file so a change to what a tap records fails here
// rather than quietly leaving this simulator modelling last week's behaviour.
// ===========================================================================

const mutationSrc = readFileSync(new URL("./convex/hallPasses.ts", import.meta.url), "utf8");

/** The source between two markers, or a loud failure naming the missing one. */
function slice(src, startMarker, endMarker, file) {
  const start = src.indexOf(startMarker);
  if (start === -1) {
    console.log(`\n  FAIL  marker not found in ${file}: ${startMarker}`);
    process.exit(1);
  }
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    console.log(`\n  FAIL  end marker not found in ${file}: ${endMarker}`);
    process.exit(1);
  }
  return src.slice(start, end);
}

const writeForTap = new Function(
  "result",
  "now",
  "location",
  slice(
    mutationSrc,
    "/* ---- what a tap writes ---- */",
    "/* ---- end what a tap writes ---- */",
    "convex/hallPasses.ts",
  ) + "\nreturn written;",
);

// ===========================================================================
// THE BUILDING
// ===========================================================================

const ROOM = "loc-room-16";
const LIBRARY = "loc-library";
const RESTROOM = "loc-restroom-2";
const SLUG = { [ROOM]: "room-16", [LIBRARY]: "library", [RESTROOM]: "restroom-2" };

const ME = "s-sahilyn";

/** 09:30 plus m minutes and s seconds, as an ISO string. */
const T = (m, s = 0) => new Date(Date.UTC(2026, 7, 18, 9, 30 + m, s)).toISOString();

// ===========================================================================
// THE TRIP
//
// One student, one pass, and the tapEvents rows the trip leaves behind. Every
// decision inside comes from hallPassRules or from the sliced write above;
// nothing here re-implements a rule. It is the parts of `hallPasses.tap` that
// need a database, standing in for the database.
// ===========================================================================

function trip(pass0) {
  return {
    pass: { ...pass0 },
    /** tapEvents rows, in the order they were written. */
    events: [],
    /** tapIntents rows. A tap with no redeemable intent does nothing at all. */
    intents: [],

    /**
     * beginTap. Mints a single-use token bound to one student and one slug.
     * Rate limited, because minting is what bounds every downstream write.
     */
    begin(studentId, slug, now) {
      const allowed = withinTapRateLimit(this.intents, now);
      if (!allowed.ok) return { ok: false, reason: allowed.reason };
      const intent = {
        studentId,
        locationSlug: slug,
        createdAt: now,
        expiresAt: new Date(Date.parse(now) + TAP_INTENT_TTL_SECONDS * 1000).toISOString(),
      };
      this.intents.push(intent);
      return { ok: true, intent };
    },

    /**
     * hallPasses.tap, minus auth. The order is the shipped order and it matters:
     * the intent is checked and burned BEFORE anything is read or written, an
     * unusable one changes nothing and records nothing, and the pass is patched
     * only on an accepted tap.
     */
    tap(studentId, locationId, now, intent) {
      const redeemable = canRedeemTapIntent(intent ?? null, studentId, SLUG[locationId], now);
      if (!redeemable.ok) return { ok: false, reason: redeemable.reason, recorded: false };
      intent.usedAt = now;

      const result = applyTap(this.pass, locationId, now);

      // Every tap at a real tag is recorded, accepted or refused, unless it is
      // an identical repeat inside the dedupe window (one sticker read three
      // times as a phone moves away is one event, not three).
      const previous = this.events.length ? this.events[this.events.length - 1] : null;
      const candidate = { locationSlug: SLUG[locationId], outcome: result.reason };
      const deduped = isDuplicateTapEvent(previous, candidate, now);
      if (!deduped) {
        this.events.push({ ...candidate, at: now, accepted: result.ok, passId: "pass-1" });
      }

      if (!result.ok) return { ok: false, reason: result.reason, recorded: !deduped };

      // The real object, from the real file.
      Object.assign(this.pass, writeForTap(result, now, { _id: locationId }));
      return { ok: true, reason: result.reason, state: result.nextState, recorded: !deduped };
    },
  };
}

/** A pass as hallPasses.openForStudent writes it: a teacher sent this child. */
const teacherIssued = {
  state: "active",
  studentId: ME,
  originLocationId: ROOM,
  assignedDestinationLocationId: LIBRARY,
  requestedAt: T(0),
  approvedAt: T(0),
  expiresAfterMinutes: 10,
  reachMinutes: DEFAULT_REACH_MINUTES,
};

// ===========================================================================

console.log("\nA teacher-issued pass, all the way round");
{
  const t = trip(teacherIssued);

  check("it opens already approved, so the reach leg is running", t.pass.state === "active");
  check(
    "and the clock the card ticks is the reach window from approval",
    passClock(t.pass).startAt === T(0) && passClock(t.pass).limitMinutes === DEFAULT_REACH_MINUTES,
    JSON.stringify(passClock(t.pass)),
  );

  // --- leg one: walk there and tap ---
  const mint1 = t.begin(ME, SLUG[LIBRARY], T(2));
  assert.ok(mint1.ok, "the mint must succeed or the rest of this proves nothing");
  const out = t.tap(ME, LIBRARY, T(2), mint1.intent);

  check("the destination tap is accepted", out.ok, out.reason);
  check("and the pass is now out", t.pass.state === "out");
  check("outAt is stamped at the tap", t.pass.outAt === T(2));
  check(
    "and where they ACTUALLY went is recorded separately from where they were sent",
    t.pass.destinationLocationId === LIBRARY &&
      t.pass.assignedDestinationLocationId === LIBRARY,
  );
  check("returnedAt is untouched by an arrival", t.pass.returnedAt === undefined);

  // --- the handover, which is the whole point ---
  check(
    "the return leg is anchored at the destination tap, not at approval",
    passClock(t.pass).startAt === T(2),
    String(passClock(t.pass).startAt),
  );
  check(
    "and it is the RETURN window, not the reach one",
    passClock(t.pass).limitMinutes === 10,
  );

  // THE FRESHNESS TEST. Twelve minutes after approval is two minutes past a
  // single ten-minute window timed from approval, and it is ten minutes into a
  // return leg that started at T(2). A pass that is overdue here is a pass whose
  // return clock inherited the walk.
  check(
    "so at twelve minutes out, ten of them on the return leg, it is NOT overdue",
    !isOverdue(t.pass, T(12)),
  );
  check(
    "and it goes overdue one minute later, judged on the return leg",
    isOverdue(t.pass, T(13)),
  );
  check(
    "while total time out of class still counts from approval, for the teacher",
    elapsedMinutes(t.pass, T(12)) === 12,
    String(elapsedMinutes(t.pass, T(12))),
  );

  // --- leg two: come back and close it ---
  const mint2 = t.begin(ME, SLUG[ROOM], T(9));
  assert.ok(mint2.ok);
  const back = t.tap(ME, ROOM, T(9), mint2.intent);

  check("the tap back in the room they left is accepted", back.ok, back.reason);
  check("the pass is closed", t.pass.state === "returned");
  check("and closed by a TAP, so returnedAt is what stopped it", t.pass.returnedAt === T(9));
  check(
    "closedAt stays empty, because nobody closed this by hand",
    t.pass.closedAt === undefined,
  );
  check("a closed pass is terminal", isTerminal(t.pass.state));
  check("a closed pass is never overdue", !isOverdue(t.pass, T(9000)));
  check(
    "and its elapsed time stops at the return rather than counting forever",
    elapsedMinutes(t.pass, T(9000)) === 9,
    String(elapsedMinutes(t.pass, T(9000))),
  );

  // --- and the student is free again, which is the other half of "finished" ---
  check(
    "the student no longer holds a live pass",
    !hasLivePass([t.pass]),
  );
  check(
    "so they may ask for another one",
    canRequest([t.pass], { active: true }, T(30)).ok,
    canRequest([t.pass], { active: true }, T(30)).reason,
  );

  // --- the record the trip leaves ---
  const accepted = t.events.filter((e) => e.accepted);
  check("the trip left exactly two accepted taps", accepted.length === 2, JSON.stringify(t.events));
  check(
    "the first is the destination and the second is the room of origin",
    accepted[0] && accepted[0].locationSlug === SLUG[LIBRARY] &&
      accepted[1] && accepted[1].locationSlug === SLUG[ROOM],
  );
  check(
    "both are attributed to the pass they belong to",
    accepted.every((e) => e.passId === "pass-1"),
  );
  check(
    "and the dedupe rule did not collapse the round trip into one row",
    !isDuplicateTapEvent(
      { locationSlug: SLUG[LIBRARY], outcome: "Arrived at destination.", at: T(2) },
      { locationSlug: SLUG[ROOM], outcome: "Back in class. Pass closed." },
      T(9),
    ),
  );
  check(
    "a round trip costs two mints, well inside the rate limit",
    t.intents.length === 2 && withinTapRateLimit(t.intents, T(9)).ok,
  );
}

console.log("\nA tap that is refused leaves the trip exactly where it was");
{
  // Each case taps the WRONG tag first, then the right one, and checks that the
  // wrong tap moved nothing. The refusal path and the write path are two
  // branches of one mutation; this is the only test that they are ordered.
  const t = trip(teacherIssued);

  const early = t.begin(ME, SLUG[ROOM], T(1));
  const cheat = t.tap(ME, ROOM, T(1), early.intent);
  check("tapping the room you are still standing in is refused", !cheat.ok);
  check("and it says to tap the destination first", /where you are going/i.test(cheat.reason));
  check("the pass has not moved", t.pass.state === "active");
  check("nothing was stamped on it", t.pass.outAt === undefined && t.pass.returnedAt === undefined);
  check("but the refusal WAS recorded, because a teacher wants to see it", t.events.length === 1);
  check("and recorded as refused, not as an arrival", t.events[0].accepted === false);

  const wrong = t.begin(ME, SLUG[RESTROOM], T(2));
  const elsewhere = t.tap(ME, RESTROOM, T(2), wrong.intent);
  check("tapping somewhere other than where you were SENT is refused", !elsewhere.ok);
  check("and it says so in those terms", /not where you were sent/i.test(elsewhere.reason));
  check("the pass still has not moved", t.pass.state === "active");

  // The trip still completes afterwards. A refusal is not a punishment.
  const m1 = t.begin(ME, SLUG[LIBRARY], T(3));
  check("the assigned destination still works after two refusals", t.tap(ME, LIBRARY, T(3), m1.intent).ok);
  const m2 = t.begin(ME, SLUG[ROOM], T(8));
  check("and the pass still closes", t.tap(ME, ROOM, T(8), m2.intent).ok);
  check("state is returned", t.pass.state === "returned");
}

console.log("\nA tap with no redeemable intent does nothing and records nothing");
{
  const t = trip(teacherIssued);

  const none = t.tap(ME, LIBRARY, T(1), null);
  check("no intent, no tap", !none.ok);
  check("and nothing at all was written", t.events.length === 0 && t.pass.state === "active");

  // The forwarded-link case: a token minted by somebody else, in somebody
  // else's session. This is the whole reason a bare slug is not proof.
  const theirs = t.begin("s-someone-else", SLUG[LIBRARY], T(1));
  const stolen = t.tap(ME, LIBRARY, T(1), theirs.intent);
  check("another student's token cannot move my pass", !stolen.ok);
  check("and still nothing was written", t.events.length === 0 && t.pass.state === "active");

  // Replay: the same token twice. Single use is what stops a screenshotted or
  // forwarded link working a second time.
  const mine = t.begin(ME, SLUG[LIBRARY], T(1));
  check("my own token works once", t.tap(ME, LIBRARY, T(1), mine.intent).ok);
  const replay = t.tap(ME, ROOM, T(2), mine.intent);
  check("and cannot be redeemed again to close the pass", !replay.ok);
  check("so the pass is still out", t.pass.state === "out");

  // Expiry: two minutes is long enough to walk to a tag and no longer.
  const stale = t.begin(ME, SLUG[ROOM], T(3));
  const late = t.tap(ME, ROOM, T(6), stale.intent);
  check("a token older than its window is refused", !late.ok);
  check("and the pass is STILL closeable with a fresh one", t.tap(ME, ROOM, T(6), t.begin(ME, SLUG[ROOM], T(6)).intent).ok);
  check("which closes it", t.pass.state === "returned");
}

console.log("\nA student-requested pass reaches the same closed state");
{
  // The other entry point. A student asks, a teacher approves, and from the
  // approval onwards it is the same trip: same legs, same taps, same close.
  // There is no assigned destination on this one, so any tag but the origin
  // starts it.
  const t = trip({
    state: "requested",
    studentId: ME,
    originLocationId: ROOM,
    requestedAt: T(0),
    expiresAfterMinutes: 10,
  });

  check("a request cannot be tapped into life", !applyTap(t.pass, RESTROOM, T(1)).ok);
  check(
    "and the refusal names the teacher rather than the tag",
    /not approved/i.test(applyTap(t.pass, RESTROOM, T(1)).reason),
  );
  check("it is not being timed yet", passClock(t.pass).startAt === null);
  check("and elapsed time is null, not zero", elapsedMinutes(t.pass, T(5)) === null);

  // hallPasses.approve: the timer starts HERE, and the reach leg with it.
  check("a fresh request can be approved", canApprove(t.pass).ok);
  Object.assign(t.pass, {
    state: "active",
    approvedAt: T(4),
    reachMinutes: DEFAULT_REACH_MINUTES,
  });
  check(
    "approval starts the reach leg, timed from approval and not from the request",
    passClock(t.pass).startAt === T(4),
  );

  const m1 = t.begin(ME, SLUG[RESTROOM], T(5));
  check("with no assigned destination, any tag but the origin starts it", t.tap(ME, RESTROOM, T(5), m1.intent).ok);
  check("the pass is out", t.pass.state === "out");
  check("and the return leg is fresh from that tap", passClock(t.pass).startAt === T(5));
  check(
    "so the four minutes it waited for a teacher never touch the walk back",
    !isOverdue(t.pass, T(14)),
  );

  const m2 = t.begin(ME, SLUG[ROOM], T(9));
  check("only the room of origin closes it", !applyTap(t.pass, LIBRARY, T(9)).ok);
  check("tapping a third room says which room ends the pass", /classroom you left/i.test(applyTap(t.pass, LIBRARY, T(9)).reason));
  check("and the origin closes it", t.tap(ME, ROOM, T(9), m2.intent).ok);
  check("state is returned", t.pass.state === "returned");
  check("returnedAt is the tap", t.pass.returnedAt === T(9));
  check("total time out of class is measured from approval", elapsedMinutes(t.pass, T(60)) === 5);
}

console.log("\nA pass that can never be overdue can still be closed");
{
  // Staff lifted the limit: a nurse visit, an office call, something nobody can
  // put a number on. It must never be overdue and never swept. It must ALSO
  // still complete, because "never overdue" plus "never closeable" is the
  // permanent-live trap that blocks a child from every future pass, and it is
  // reachable through a feature rather than through a bug.
  const t = trip({ ...teacherIssued, timerCleared: true });

  check("it is not overdue on the reach leg, ever", !isOverdue(t.pass, T(100000)));
  check("and the sweep will not take it", !isAbandoned(t.pass, T(100000)));
  check(
    "the card is given an anchor but no window, so it counts UP",
    passClock(t.pass).startAt === T(0) && passClock(t.pass).limitMinutes === null,
    JSON.stringify(passClock(t.pass)),
  );

  const m1 = t.begin(ME, SLUG[LIBRARY], T(40));
  check("the destination tap still works forty minutes later", t.tap(ME, LIBRARY, T(40), m1.intent).ok);
  check("the pass is out", t.pass.state === "out");
  check(
    "the handover still happens, so the anchor moves to the tap",
    passClock(t.pass).startAt === T(40),
  );
  check("still no window", passClock(t.pass).limitMinutes === null);
  check("still not overdue on the return leg", !isOverdue(t.pass, T(100000)));
  check(
    "and still not abandoned, well past the grace the sweep uses",
    !isAbandoned(t.pass, T(40 + 10 + EXPIRY_GRACE_MINUTES + 1)),
  );

  const m2 = t.begin(ME, SLUG[ROOM], T(95));
  check("and the return tap closes it like any other pass", t.tap(ME, ROOM, T(95), m2.intent).ok);
  check("state is returned", t.pass.state === "returned");
  check("the student is unblocked", !hasLivePass([t.pass]));
  check(
    "which is the point: an untimed pass is not an unclosable one",
    canRequest([t.pass], { active: true }, T(120)).ok,
  );
}

console.log("\nA pass that ran late still closes rather than stranding the student");
{
  // Overdue is a display state, not a terminal one. A child who is eight
  // minutes late walking back has to be able to tap back in, or the trip ends
  // with no close, no record of the return, and a student blocked from asking
  // again.
  const t = trip(teacherIssued);

  // Nine minutes after approval on a five minute reach window: this pass is on
  // the teacher's board in red BEFORE the tap, which is the state the tap has to
  // be accepted in.
  check("it is overdue on the reach leg before the tap", isOverdue(t.pass, T(9)));

  const m1 = t.begin(ME, SLUG[LIBRARY], T(9));
  check("a destination tap four minutes past the REACH window is still accepted", t.tap(ME, LIBRARY, T(9), m1.intent).ok);
  check("and the arrival clears the overdue flag, because the leg changed", !isOverdue(t.pass, T(9)));
  check("the return leg starts fresh anyway", passClock(t.pass).startAt === T(9));
  check(
    "so arriving late does not eat the walk back",
    !isOverdue(t.pass, T(18)),
  );

  check("past the return window it goes overdue", isOverdue(t.pass, T(21)));
  check("but the sweep holds off, because overdue is for a teacher to see", !isAbandoned(t.pass, T(21)));

  const m2 = t.begin(ME, SLUG[ROOM], T(25));
  const back = t.tap(ME, ROOM, T(25), m2.intent);
  check("and an overdue pass still accepts the tap that closes it", back.ok, back.reason);
  check("state is returned", t.pass.state === "returned");
  check("the lateness is legible afterwards, at fifteen minutes past approval", elapsedMinutes(t.pass, T(60)) === 25);
}

console.log("\nThe tag the student has to tap is one the app will let them see");
{
  // THE BUG THAT MADE THE LOOP UNREACHABLE. script.js refuses to offer the
  // check-in button for a slug that is not in tapLocations.listForStudents, and
  // that list was the common kinds plus the rooms this student had used as an
  // ORIGIN. A teacher's pass names a DESTINATION, and the staff picker offers
  // every active non-classroom tag, `other` included. So a child sent to the
  // library was told the library tag was not registered, the pass never left
  // `active`, and no tap was ever recorded.
  const live = { ...teacherIssued };
  const rooms = roomsNamedOnPasses([live]);

  check("the room the pass starts in is visible", rooms.has(ROOM));
  check(
    "and so is the room a teacher SENT them to, which is the tag that starts the trip",
    rooms.has(LIBRARY),
  );
  check("a room nobody named is not", !rooms.has(RESTROOM));

  // After the arrival, where they actually tapped is on the row too. It is the
  // room they are standing in when the list is next read.
  const arrived = { ...live, state: "out", outAt: T(2), destinationLocationId: LIBRARY };
  check("after the arrival the same rooms are still visible", roomsNamedOnPasses([arrived]).has(LIBRARY));
  check("including the origin, which is the one that CLOSES the pass", roomsNamedOnPasses([arrived]).has(ROOM));

  // The old rule, written out, so the regression is named rather than implied.
  const originsOnly = new Set([live.originLocationId]);
  check(
    "the origin-only rule this replaced could not see the assigned destination",
    !originsOnly.has(LIBRARY),
  );

  // A pass with no destination at all must not publish the whole tag table.
  const bare = { state: "requested", originLocationId: ROOM, requestedAt: T(0) };
  const bareRooms = roomsNamedOnPasses([bare]);
  check("a pass naming one room yields exactly one room", bareRooms.size === 1 && bareRooms.has(ROOM));
  check(
    "and an absent column is skipped rather than added as undefined",
    !bareRooms.has(undefined),
  );
  check("no passes, no rooms", roomsNamedOnPasses([]).size === 0);
}

console.log("\nAnd the phone asks for that list again every time it is needed");
{
  // THE SAME DEAD LOOP, ONE LAYER UP, AND THE SERVER FIX ALONE DID NOT REACH A
  // STUDENT. roomsNamedOnPasses made listForStudents return the tag that closes
  // the pass. script.js then cached the answer for the life of the page with
  // `if (wpLocations) return;`, and the list it froze is a function of the
  // student's CURRENT passes: hallPasses.requestMine derives the origin from the
  // class they are timetabled into right now, so it changes at every bell.
  //
  // What a child saw: tap once at period 2 out of Room 16, and the cache holds
  // Room 16 and the common kinds. At period 5, a pass out of Room 21, a walk to
  // the restroom (a common kind, so that tap worked and the pass went `out`), a
  // walk back, and the Room 21 tag answered from a three-period-old cache with
  // "this tag is not set up yet". No check-in button is drawn at all. The server
  // would have taken that tap; the ring ran to zero instead.
  //
  // A SOURCE GUARD, and the right kind of test here for the same reason the ones
  // in pass-clock.test.mjs are: the failure is invisible in a browser, there is
  // no module boundary to import through, and nothing else in this suite touches
  // the client's copy of the room list at all.
  const clientSrc = readFileSync(new URL("./script.js", import.meta.url), "utf8");

  /** The body of a top-level function in script.js, by brace matching. */
  function fnBody(source, name) {
    const start = source.indexOf(name);
    if (start === -1) return "";
    const open = source.indexOf("{", start);
    if (open === -1) return "";
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    return source.slice(start);
  }

  const loader = fnBody(clientSrc, "async function wpLoadLocations(");
  check("the client still has a room list loader", loader.length > 200);
  check(
    "and it does not return early on a list it already has",
    !/if \(wpLocations\)\s*return/.test(loader),
    "a per-page memo freezes the list at the periods the student had already tapped in",
  );
  check(
    "it clears the old list before fetching, so a failed load cannot be answered from the last tap",
    /wpLocations = null;[\s\S]*convexQuery/.test(loader),
  );
  check("and it is the student-scoped query, never the admin one", /tapLocations:listForStudents/.test(loader));
  check("never the staff list, which is a map of the building", !/tapLocations:list'/.test(loader));

  // The one caller. If a second one appears, the cost of dropping the memo
  // changes and somebody has to think about it again.
  const callers = (clientSrc.match(/wpLoadLocations\(\)/g) || []).length;
  check("it is called from one place, the doorway confirm screen", callers === 2, String(callers));
  const confirm = fnBody(clientSrc, "async function showTapConfirm(");
  check("which is where it is called from", /wpLoadLocations\(\)/.test(confirm));
  check(
    "and that screen still refuses to invent a room when the list did not load",
    /unsure = true/.test(confirm),
  );
}

console.log("\nThe simulator is the shipped mutation, not a memory of it");
{
  // writeForTap is the object convex/hallPasses.ts patches, evaluated. These
  // pin that the slice really is that object and really does branch, so a change
  // to what a tap records lands here instead of quietly passing.
  const arrival = writeForTap(
    { ok: true, nextState: "out", field: "outAt", reason: "" },
    T(2),
    { _id: LIBRARY },
  );
  check("an arrival writes the state", arrival.state === "out");
  check("stamps outAt", arrival.outAt === T(2));
  check("and records where they actually went", arrival.destinationLocationId === LIBRARY);
  check("and touches nothing else", Object.keys(arrival).length === 3, Object.keys(arrival).join());

  const closing = writeForTap(
    { ok: true, nextState: "returned", field: "returnedAt", reason: "" },
    T(9),
    { _id: ROOM },
  );
  check("a return writes the state", closing.state === "returned");
  check("stamps returnedAt", closing.returnedAt === T(9));
  check(
    "and does NOT write destinationLocationId, which would overwrite where they went",
    closing.destinationLocationId === undefined,
  );
  check(
    "and never writes closedAt, which means somebody closed it without a tap",
    closing.closedAt === undefined && Object.keys(closing).length === 2,
  );
}

// ===========================================================================
// WHAT THIS FILE STILL CANNOT PROVE
//
// Every tap above is a function call. None of it says a phone read a sticker.
//
// TWO OF THESE GENUINELY NEED A STICKER ON A WALL:
//
//   - that an encoded NTAG actually opens https://wildcatraffle.com/tap/?tap=<slug>
//   - that a slug printed on a sticker matches the row an admin registered
//
// AND TWO DO NOT, WHICH THIS FILE USED TO CLAIM. Both were listed here as
// blocked on hardware and neither is. Saying so is the point: an item wearing a
// "needs a physical tag" label is an item nobody tries, and these two are the
// reason the tapEvents table still holds zero rows.
//
//   - that iOS hands the URL to the installed app rather than to Safari. That is
//     an installed build, a device, and the URL typed into Notes or Messages, or
//     `xcrun simctl openurl` against a simulator. The apple-app-site-association
//     file is sitting in the repo root and can be curled from the live host right
//     now. No sticker is involved in any of it.
//   - that tapEvents gains its first row. handleTapArrival reads the slug off the
//     query string, so typing https://wildcatraffle.com/tap/?tap=<slug> by hand
//     reaches showTapConfirm, confirmTapCheckIn, beginTap and tap, with two
//     registered tags and no hardware at all. Running it by hand is also what
//     would have caught the frozen room list guarded a few blocks up this file,
//     which no amount of rules-level testing was ever going to surface.
//
// So: two blocked, two unrun. This suite is silent about all four rather than
// pretending to cover them, but only two of them have an excuse.
// ===========================================================================

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
