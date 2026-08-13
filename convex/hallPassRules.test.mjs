// Hall pass state machine. Run: npm test
//
// These are the rules that decide whether a child may be out of a classroom and
// how long they were gone, so they are tested against the real module rather
// than a copy of the logic.

import {
  applyTap,
  canApprove,
  elapsedMinutes,
  isOverdue,
  isTerminal,
  hasLivePass,
} from "./hallPassRules.ts";

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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
