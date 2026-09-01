// Finding a staff record after a Microsoft sign-in.
//
// THE BUG. waitForTeacherRecord gave up the moment `teachers` had any rows in
// it: "the roster is loaded and the address genuinely is not in it". That held
// while Firestore served the roster WITHOUT a sign-in, so a non-empty array had
// come from the server.
//
// Retiring Firestore broke it. loadData now needs a Convex session, so on a
// redirect return it fails with "Not signed in to Convex" and falls back to
// localStorage. The array is then a STALE LOCAL CACHE, and it is non-empty, so
// the search missed and reported a missing staff record SECONDS BEFORE the real
// roster arrived. It only bit staff added since that machine last cached a
// roster, which is why it presented as two specific people with bad email
// addresses. The addresses were correct throughout.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-auth.js", import.meta.url), "utf8");
const fn = src.slice(src.indexOf("async function waitForTeacherRecord"),
                     src.indexOf("// ---------------------------------------------------------------------\n  // The shared Chromebook guard."));

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

/** Build the function with its two dependencies injected. */
function build({ roster, meGet }) {
  // `teachers` is read as a bare global by the real code, so the test provides
  // one. Reassigning globalThis.teachers mid-test is exactly what the roster
  // refresh does in the browser.
  globalThis.teachers = roster;
  const make = new Function("convexQuery", "console", fn + "\nreturn waitForTeacherRecord;");
  return make(meGet, { warn() {} });
}

const ROSTER_STALE = [
  { email: "old@lapromisefund.org", name: "Someone Older" },
  { email: "other@lapromisefund.org", name: "Also Older" },
];
const HER = { email: "ashargm@lapromisefund.org", name: "A Shargm" };

console.log("\nA stale local roster is not proof the person is missing");
{
  // The reported case, in order: cache present and wrong, real roster lands.
  const wait = build({
    roster: ROSTER_STALE,
    meGet: async () => ({ hasAppRecord: true }),
  });
  setTimeout(() => { globalThis.teachers = ROSTER_STALE.concat([HER]); }, 300);

  const started = Date.now();
  const found = await wait("ashargm@lapromisefund.org", 5000, "tok");
  check("the record is found once the real roster arrives", !!found);
  check("and it is the right person", found && found.name === "A Shargm");
  check("it waited rather than answering from the cache",
    Date.now() - started >= 250);
}

console.log("\nA genuinely absent person is told quickly, not after a timeout");
{
  globalThis.teachers = ROSTER_STALE;
  const wait = build({
    roster: ROSTER_STALE,
    // The server is authoritative and says no.
    meGet: async () => ({ hasAppRecord: false }),
  });
  const started = Date.now();
  const found = await wait("nobody@lapromisefund.org", 5000, "tok");
  check("returns null", found === null);
  check("without waiting out the timeout", Date.now() - started < 500);
}

console.log("\nAn already-correct roster still resolves immediately");
{
  globalThis.teachers = ROSTER_STALE.concat([HER]);
  const wait = build({
    roster: ROSTER_STALE.concat([HER]),
    meGet: async () => ({ hasAppRecord: true }),
  });
  const started = Date.now();
  const found = await wait("ashargm@lapromisefund.org", 5000, "tok");
  check("found", !!found);
  check("with no added delay", Date.now() - started < 400);
}

console.log("\nThe server check can never be what blocks a sign-in");
{
  globalThis.teachers = ROSTER_STALE.concat([HER]);
  const wait = build({
    roster: ROSTER_STALE.concat([HER]),
    meGet: async () => { throw new Error("network down"); },
  });
  const found = await wait("ashargm@lapromisefund.org", 3000, "tok");
  check("a failing me:get falls through to polling and still finds them", !!found);

  // And with no token at all, the old behaviour must still work.
  globalThis.teachers = ROSTER_STALE.concat([HER]);
  const wait2 = build({
    roster: ROSTER_STALE.concat([HER]),
    meGet: async () => { throw new Error("should not be called"); },
  });
  const found2 = await wait2("ashargm@lapromisefund.org", 3000, undefined);
  check("no token means no server check, and the local search still works", !!found2);
}

console.log("\nBoth sign-in paths share the fix");
{
  // Fixing the redirect path alone would leave the bug alive on the resumed
  // session route, which is the one a returning teacher hits every morning.
  check("the redirect path passes its token",
    /waitForTeacherRecord\(target, undefined, redirectResult\.idToken\)/.test(src));
  check("adoptStaffRecord goes through the same function, not a bare find",
    /const teacher = await waitForTeacherRecord\(\s*\n\s*target, undefined, \(session \|\| \{\}\)\.idToken\);/.test(src));
  check("and no bare teachers.find survives in adoptStaffRecord",
    !/adoptStaffRecord[\s\S]{0,400}teachers\.find/.test(src));
  check("the reason is written where the next reader will be",
    /A NON-EMPTY `teachers` ARRAY IS NOT PROOF OF ANYTHING/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
