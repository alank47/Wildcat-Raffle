// The hall pass clock as a student reads it. Run: npm test
//
// WHAT THIS PINS IS A TIMER THAT LIES TO A CHILD, and there are four separate
// ways it can:
//
// 1. THE DUE TIME DISAGREES WITH THE COUNTDOWN. The card now prints an absolute
//    "back by 10:42" beside the digits. If that is computed from anything other
//    than the anchor the digits tick against, a phone with a wrong clock makes
//    the two drift apart, and the card is arguing with itself in front of a
//    student who has to decide whether to run.
// 2. THE OPEN-ENDED PASS IS DRAWN AS A COUNTDOWN. A pass staff took the limit
//    off is never overdue and is never swept. Showing it counting down towards
//    a deadline invents one, and then the child is late for something nobody
//    ever set.
// 3. THE WARNING LANDS TOO LATE TO BE USEABLE, or so early it is the normal
//    state of the card. Both make it worthless; the second is worse, because a
//    state a student spends most of the trip inside stops being a state.
// 4. THE NUMBER REVERSES IN SILENCE. At zero the same digits in the same place
//    stop meaning "left" and start meaning "over". That inversion is the
//    documented design tell on the category leader's own card, and it is the
//    one thing this clock must not inherit.
//
// The arithmetic is lifted out of the shipped script.js rather than copied, so
// this cannot pass against a version of the code that is no longer the one
// students run. script.js is a browser file with no build step and no exports;
// the slice below is the same trick nfc-tag-decode.test.mjs uses.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./script.js", import.meta.url), "utf8");

/** The source between two markers, or a loud failure naming the missing one. */
function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) {
    console.log(`\n  FAIL  marker not found in script.js: ${startMarker}`);
    process.exit(1);
  }
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    console.log(`\n  FAIL  end marker not found in script.js: ${endMarker}`);
    process.exit(1);
  }
  return src.slice(start, end);
}

const {
  wpMMSS,
  wpPassStartMs,
  wpClockWindow,
  wpDueAtMs,
  wpDueClockLabel,
  wpWarnLeadSeconds,
  wpClockFace,
  wpDueLead,
  wpPhaseFlag,
} = new Function(
  slice("/* ---- pass clock arithmetic ---- */", "/* ---- end pass clock arithmetic ---- */") +
    "\nreturn { wpMMSS, wpPassStartMs, wpClockWindow, wpDueAtMs, wpDueClockLabel," +
    " wpWarnLeadSeconds, wpClockFace, wpDueLead, wpPhaseFlag };",
)();

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

/* The device's clock, under our control. wpPassStartMs and wpClockFace both
   read Date.now(); a test that could not move it could not test the one thing
   they exist for, which is a phone whose clock is wrong. */
const REAL_NOW = Date.now;
let deviceNow = Date.UTC(2026, 7, 18, 17, 30, 0);
Date.now = () => deviceNow;
process.on("exit", () => {
  Date.now = REAL_NOW;
});

const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();

/** A live pass payload as convex/passCard.ts sends it. */
function payload({ startedAgoMs = 0, limit = 10, skewMs = 0 }) {
  // The server's clock is the truth. The device is skewMs ahead of it, which is
  // exactly the case wpPassStartMs corrects for.
  const serverNow = deviceNow - skewMs;
  return {
    clockStartAt: iso(serverNow - startedAgoMs),
    clockLimitMinutes: limit,
    serverTime: iso(serverNow),
  };
}

console.log("\nThe due time comes off the same anchor as the digits");
{
  // Zero skew first, so the plain arithmetic is nailed before the hard case.
  const hp = payload({ startedAgoMs: 0, limit: 10, skewMs: 0 });
  const start = wpPassStartMs(hp);
  check("a fresh pass starts now", start === deviceNow, String(start - deviceNow));
  check(
    "and is due exactly one window later",
    wpDueAtMs(start, 10) === deviceNow + 10 * MIN,
  );

  // THE INVARIANT. Whatever the device clock is doing, the seconds between now
  // and the printed due time have to be the seconds the card is counting down.
  // This is the whole reason the due time is derived from wpPassStartMs.
  for (const skewMs of [-13 * MIN, -90000, 0, 7 * MIN, 41 * MIN]) {
    const p = payload({ startedAgoMs: 3 * MIN, limit: 10, skewMs });
    const s = wpPassStartMs(p);
    const due = wpDueAtMs(s, 10);
    const face = wpClockFace(s, 10);
    const secondsToDue = Math.round((due - deviceNow) / 1000);
    const secondsOnCard = wpMMSS(secondsToDue);
    check(
      `at ${skewMs / MIN} min of device skew the due time and the countdown agree`,
      face.value === secondsOnCard,
      `${face.value} vs ${secondsOnCard}`,
    );
  }

  // And the skew correction is doing something, rather than the test agreeing
  // with itself because both sides ignore serverTime.
  const fast = wpPassStartMs(payload({ startedAgoMs: 0, limit: 10, skewMs: 6 * MIN }));
  const none = wpPassStartMs(payload({ startedAgoMs: 0, limit: 10, skewMs: 0 }));
  check("a device six minutes fast still reads the pass as starting now", fast === none);
  check(
    "so its due time is not six minutes early either",
    wpDueAtMs(fast, 10) === wpDueAtMs(none, 10),
  );

  // Without serverTime (a payload from before the field shipped) the raw stamp
  // stands. Nothing is invented; it is simply the pre-skew behaviour.
  const legacy = wpPassStartMs({ clockStartAt: iso(deviceNow - 4 * MIN), clockLimitMinutes: 10 });
  check("a payload with no serverTime falls back to the raw stamp", legacy === deviceNow - 4 * MIN);

  check("no start means no due time", wpDueAtMs(null, 10) === null);
  check("and no due time means no label rather than a blank clock", wpDueClockLabel(null) === null);
  check(
    "a label is a readable time",
    /^\d{1,2}[:.]\d{2}/.test(wpDueClockLabel(deviceNow)),
    String(wpDueClockLabel(deviceNow)),
  );
  check(
    "and moving the due instant moves the label",
    wpDueClockLabel(deviceNow) !== wpDueClockLabel(deviceNow + 7 * MIN),
  );
}

console.log("\nThe pass with no limit is never counted down");
{
  const start = deviceNow - 22 * MIN;

  check("an explicit null window is no window", wpClockWindow(null) === null);
  check("an undefined window is no window", wpClockWindow(undefined) === null);
  check("NaN is no window", wpClockWindow(NaN) === null);
  check("Infinity is no window", wpClockWindow(Infinity) === null);
  check("zero is no window", wpClockWindow(0) === null);
  check("a negative window is no window", wpClockWindow(-5) === null);
  // The trap this exists for: "no limit" encoded as an enormous number.
  check("a year-long window is no window", wpClockWindow(525600) === null);
  check("a day is already no window", wpClockWindow(24 * 60) === null);

  // And it does not eat a real pass. MAX_PASS_MINUTES is 240.
  check("the longest pass a teacher can write is still a window", wpClockWindow(240) === 240);
  check("so is the shortest", wpClockWindow(1) === 1);

  const open = wpClockFace(start, null);
  check("an open-ended pass counts UP", open.value === "22:00", open.value);
  check("and says out, not left", open.unit === "out");
  check("and is phase open", open.phase === "open");
  check("and has no due time to print", wpDueAtMs(start, null) === null);
  check("and none for the enormous-number spelling either", wpDueAtMs(start, 525600) === null);

  // Twelve hours in, still not late. This is the point: the server will not call
  // it overdue and will not sweep it, so the card must not either.
  const later = wpClockFace(deviceNow - 12 * 60 * MIN, null);
  check("twelve hours in it is still not over", later.phase === "open");
  check("and still says out", later.unit === "out");
  check("and its digits carry no overtime sign", later.value.indexOf("+") === -1);

  // An open pass has no warning either. There is nothing to warn about.
  check("an open pass never warns", wpWarnLeadSeconds(null) === 0);
  check("nor does the enormous-number spelling", wpWarnLeadSeconds(999999) === 0);

  // No start at all is a different nothing, and reads as one.
  const blank = wpClockFace(null, 10);
  check("an unreadable clock shows dashes rather than a number", blank.value === "--:--");
  check("and claims no phase", blank.phase === "none");
}

console.log("\nThe warning threshold, and both sides of its boundary");
{
  // Two minutes, or a quarter of the leg, whichever is shorter, floor of thirty.
  check("a ten minute leg warns with two minutes left", wpWarnLeadSeconds(10) === 120);
  check("a twenty minute leg still warns with two minutes left", wpWarnLeadSeconds(20) === 120);
  check("the five minute reach leg warns with 75 seconds left", wpWarnLeadSeconds(5) === 75);
  check("an eight minute leg warns at exactly two minutes", wpWarnLeadSeconds(8) === 120);
  check("a one minute pass gets the thirty second floor", wpWarnLeadSeconds(1) === 30);
  check("and so does a two minute pass", wpWarnLeadSeconds(2) === 30);

  // The warning must never be the whole pass. Every window a teacher can set.
  let swallowed = 0;
  for (let m = 1; m <= 240; m++) {
    if (wpWarnLeadSeconds(m) > m * 60) swallowed++;
  }
  check("no legal pass spends its whole life in the warning", swallowed === 0, `${swallowed} did`);

  // The boundary itself, on a ten minute return leg: lead is 120 seconds.
  const at = (secondsLeft) => wpClockFace(deviceNow - (10 * 60 - secondsLeft) * 1000, 10);
  check("121 seconds left is still running", at(121).phase === "live");
  check("120 seconds left is the warning", at(120).phase === "warn");
  check("119 seconds left is still the warning", at(119).phase === "warn");
  check("one second left is still the warning", at(1).phase === "warn");

  // The warning does NOT change what the number means. It is a state change, not
  // a relabel: the digits still count down and still say "left".
  check("the warning still counts down", at(119).unit === "left");
  check("and its digits carry no sign", at(119).value.indexOf("+") === -1);
  check("and the flag on the ring says what to do", wpPhaseFlag("warn") === "Head back");
  check("while a running pass flies no flag at all", wpPhaseFlag("live") === "");
  check("and neither does an open-ended one", wpPhaseFlag("open") === "");

  // Same rule on the five minute reach leg, where the lead is proportional.
  const reach = (secondsLeft) => wpClockFace(deviceNow - (5 * 60 - secondsLeft) * 1000, 5);
  check("76 seconds left on the reach leg is still running", reach(76).phase === "live");
  check("75 seconds left on the reach leg is the warning", reach(75).phase === "warn");
}

console.log("\nThe crossover, which must not be silent");
{
  const at = (secondsLeft) => wpClockFace(deviceNow - (10 * 60 - secondsLeft) * 1000, 10);

  // ONE SECOND EITHER SIDE OF ZERO. Everything about the number changes.
  const before = at(1);
  const on = at(0);
  const after = at(-1);

  check("one second left still says left", before.unit === "left");
  check("and is not yet over", before.phase === "warn");

  // Exactly at the limit is NOT over, matching isOverdue's `elapsed > window` on
  // the server. An off-by-one here is a child told they are late by a card the
  // teacher's board disagrees with.
  check("exactly at the limit is not over", on.phase !== "over");
  check("and still says left", on.unit === "left");
  check("and reads zero rather than jumping", on.value === "00:00");

  check("one second past is over", after.phase === "over");
  check("and the word changes from left to overtime", after.unit === "overtime");
  check("and the digits take a sign so the direction is visible", after.value === "+00:01");
  check("and the ring flies the overtime flag", wpPhaseFlag("over") === "Overtime");

  // The relabel is the whole point: the same digits must never mean two things
  // under the same word.
  check("the unit word before and after are different words", before.unit !== after.unit);
  check("and the sign only appears on one side", (before.value.indexOf("+") === -1) && after.value[0] === "+");

  // And it keeps counting up from there.
  const late = wpClockFace(deviceNow - (10 * 60 + 154) * 1000, 10);
  check("overtime counts up", late.value === "+02:34", late.value);
  check("and stays overtime", late.phase === "over");

  // The due line relabels with it, and names the right errand for the leg.
  check("heading out, the line reads get there by", wpDueLead("live", "reach") === "Get there by");
  check("heading back, the line reads back by", wpDueLead("live", "back") === "Back by");
  check("the warning does not change the errand", wpDueLead("warn", "back") === "Back by");
  check("overtime on the way back reads was due back at", wpDueLead("over", "back") === "Was due back at");
  check("overtime on the way there reads was due there at", wpDueLead("over", "reach") === "Was due there at");
  check(
    "so the line is not the same sentence before and after",
    wpDueLead("warn", "back") !== wpDueLead("over", "back"),
  );

  // mm:ss, and h:mm:ss only past an hour, on both sides of zero.
  check("under an hour is mm:ss", wpMMSS(154) === "02:34");
  check("past an hour grows an hours field", wpMMSS(3754) === "1:02:34");
  check("and negative seconds never print a stray minus", wpMMSS(-5) === "00:00");
}

/* ---------------------------------------------------------------
   Source guards. Weak tests, and the right ones here: both failures
   below are invisible in a browser and neither can be reached through
   an import, because the card is built as a string inside a 20,000
   line file with no module boundary.
   --------------------------------------------------------------- */

/** The body of a top-level function, by brace matching. */
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

console.log("\nThe words on the card");
{
  const card = fnBody(src, "function wpHallPassCard(");
  check("the hall pass card exists to be read", card.length > 500);

  // Apple's NFC guidance is explicit: a device only has to come CLOSE to a tag,
  // never touch it, so "tap" and "touch" teach a child to press a phone against
  // a wall and then wonder why nothing happened.
  const taps = card.match(/[Tt]ap (the|your|it)/g) || [];
  check("no student-facing string tells a child to tap", taps.length === 0, taps.join(" / "));
  const touches = card.match(/[Tt]ouch (the|your|it)/g) || [];
  check("nor to touch", touches.length === 0, touches.join(" / "));
  check("and the card says hold near instead", /[Hh]old (your phone )?near/.test(card));

  // Same page: do not say NFC to a user.
  const shouted = card.match(/"[^"']*NFC[^"']*"|'[^"']*NFC[^"']*'/g) || [];
  check("and never says NFC in a string a student reads", shouted.length === 0, shouted.join(" / "));

  // THE DOCUMENTED EXCEPTION. A staff member deliberately programming a tag
  // needs the word: they are holding the thing, and "hold the sticker near the
  // reader" would not tell them which of the two objects on the desk is which.
  const admin = fnBody(src, "function openNfcProgrammer(");
  check("the admin tag writer exists", admin.length > 500);
  check("and still says NFC to staff", /NFC tag/.test(admin));
  check("and still tells staff to hold the tag to the phone", /Hold the (NFC )?tag/.test(admin));

  // THE DOORWAY CONFIRM SCREEN IS HELD TO THE SAME RULE. It is the very next
  // thing the same student reads after the card, at the same doorway, and it
  // was still greeting them with "You tapped" and telling them to tap a tag
  // again. Getting the card right and leaving this wrong teaches the wrong
  // gesture at exactly the moment they are performing it.
  const confirm = fnBody(src, "async function showTapConfirm(");
  check("the doorway confirm screen exists to be read", confirm.length > 500);
  const confirmTaps = confirm.match(/[Tt]apped|[Tt]ap (the|your|it|this)/g) || [];
  check("nor does the doorway screen say tap", confirmTaps.length === 0, confirmTaps.join(" / "));
  check("it says scanned instead", /You scanned/.test(confirm));
  check("and asks for a hold near, not a press", /hold your phone near this tag/.test(confirm));
}

console.log("\nThe ticker owns the crossing");
{
  const tick = fnBody(src, "function wpTickClocks(");
  check("the ticker exists", tick.length > 200);

  // The bug this guards: the pass watch polls on id, state and destination, and
  // going overdue changes none of the three. Before this the digits reversed and
  // nothing else on the card ever acknowledged it. If the ticker stops writing
  // the phase, the card goes silent again and nothing else fails.
  check("the ticker writes the phase", /data-wp-phase/.test(tick));
  check("and rewrites the flag on the ring", /wp-ring-flag/.test(tick));
  check("and rewrites the words in front of the due time", /wp-due-lead/.test(tick));
  check("and only buzzes on an actual crossing", /prevPhase && prevPhase !== face\.phase/.test(tick));

  // THE FROZEN HEADER. The strip's mm:ss is written once, at deal time, from
  // this same wpClockFace, and the pass watch will not re-deal the card on a
  // warn or an overtime crossing. A ticker that moved only the ring left one
  // card saying "09:58 left" on its strip and "+02:14 overtime" in its ring at
  // the same instant, and the strip is the half a student sees without opening
  // anything. Four surfaces are fed from the card, so all four move together.
  check("and rewrites the header strip", /\.wp-lead/.test(tick));
  check("off the same face as the ring", /face\.value \+ ' ' \+ face\.unit/.test(tick));
  check("and the data-lead the wide panel reads from", /dataset\.lead = stripLead/.test(tick));
  check("and the aria-label VoiceOver announces", /setAttribute\('aria-label'/.test(tick));
  check("and the wide detail line while that card is the open one", /wpDetailLead/.test(tick));
  check("and fills the ring at overtime rather than emptying it", /phase === 'over'\) frac = 1/.test(tick));
  // A card DEALT overdue never crosses anything. If the body's phase were only
  // written on a transition, that card's due line would sit in the running
  // colour saying "was due back at" as though nothing were wrong.
  check(
    "and the card body's phase is compared every tick, not only on a crossing",
    /host\.getAttribute\('data-wp-phase'\) !== face\.phase/.test(tick),
  );

  // The card has to hand the ticker the leg, or the due line names the wrong
  // errand for every student still walking to where they were sent.
  const card = fnBody(src, "function wpHallPassCard(");
  check("the card stamps which leg is running", /data-leg="/.test(card));
  check("and prints the due time beside the digits", /wp-due-lead/.test(card));
  check("and says so plainly when there is no limit", /No time limit on this pass/.test(card));
  // A student who is already `out` has arrived. "When you get there" is an
  // instruction for a walk they have finished, and at a doorway a child follows
  // the sentence rather than working out it is not addressed to them.
  check(
    "and the footer on the return leg is about getting back",
    /state === 'out'\s*\?\s*'When you are back in class/.test(card),
  );
}

/* ============================================================
   THE WATCH SIGNATURE.

   The card is re-dealt only when this string changes. That makes it the thing
   that decides whether a student ever SEES a change staff made, and it shipped
   omitting the clock, which is a bug with a child on the end of it:

   A teacher clears the timer on a nurse pass. hallPasses:clearTimer patches
   `timerCleared` and nothing else, so id, state and destination are all
   identical. The signature matched, the poll discarded the fresh payload, and
   the card went on ticking the window that had just been deleted: it crossed
   zero, turned red, printed an overtime figure and buzzed a warning haptic at a
   child on a pass the server says can never be late. The staff board looked
   fine. Nobody could see it but the student.

   The opposite failure is just as real and is why serverTime must stay out:
   it moves on every poll, so including it would re-deal the card every 15
   seconds and close whatever the student had open mid-read.
   ============================================================ */
console.log("\nThe watch signature");
{
  const wpPassSignature = new Function(
    fnBody(src, "function wpPassSignature(") + "\nreturn wpPassSignature;",
  )();

  const live = {
    available: true,
    id: "hp1",
    state: "out",
    sentTo: "restroom-2",
    clockStartAt: "2026-08-18T17:20:00.000Z",
    clockLimitMinutes: 10,
    timerCleared: false,
    serverTime: "2026-08-18T17:30:00.000Z",
  };
  const sig = wpPassSignature(live);

  check("a pass that has not changed keeps one signature", sig === wpPassSignature({ ...live }));

  // The bug, pinned. passClock() returns limitMinutes: null once timerCleared,
  // so this is exactly the payload the server sends after clearTimer.
  check(
    "clearing the timer changes it",
    wpPassSignature({ ...live, clockLimitMinutes: null, timerCleared: true }) !== sig,
    "staff cleared the timer and the card would never have been re-dealt",
  );

  check(
    "resetting the timer changes it",
    wpPassSignature({ ...live, clockStartAt: "2026-08-18T17:29:00.000Z" }) !== sig,
    "a fresh anchor must reach the card",
  );

  check(
    "the reach leg handing over to the return leg changes it",
    wpPassSignature({
      ...live,
      clockStartAt: "2026-08-18T17:28:00.000Z",
      clockLimitMinutes: 10,
    }) !== sig,
  );

  check(
    "a shortened window changes it",
    wpPassSignature({ ...live, clockLimitMinutes: 5 }) !== sig,
  );

  // The re-deal-every-poll trap.
  check(
    "but the server's clock ticking does NOT change it",
    wpPassSignature({ ...live, serverTime: "2026-08-18T17:31:00.000Z" }) === sig,
    "including serverTime would re-deal the card every 15 seconds",
  );

  check(
    "and no pass is still 'none'",
    wpPassSignature(null) === "none" && wpPassSignature({ available: false }) === "none",
  );

  // A null limit and a missing limit are the same fact to a student: no
  // deadline. They must not produce two different signatures, or the card
  // re-deals for a change that did not happen.
  check(
    "a null limit and an absent limit agree",
    wpPassSignature({ ...live, clockLimitMinutes: null }) ===
      wpPassSignature({ ...live, clockLimitMinutes: undefined }),
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
