// The class-period pickers must survive the roster refusing once.
//
// THE REGRESSION, 2026-09-04. loadTeacherRosterFromSIS refuses without a Convex
// session and records `failed`. Every landing screen paints before the
// wildcat-auth-signin event fires, so on sign-in the roster ALWAYS refuses at
// least once.
//
// Award Tickets survived that: updatePeriodFilter retries a failed roster on
// its next repaint. Award Cash never retried at all -- it fetched once from
// switchTab and that was the whole visit. That was harmless while everyone
// landed in Raffle. Moving the school to Cash and Discipline for launch made
// Cash the landing screen for every role, and one early refusal became no
// class periods for the rest of the session, for teachers and admins alike.
//
// The asymmetry is the bug. These assertions hold the two screens to the same
// behaviour, and check the sign-in path no longer depends on lucky ordering.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const code = script.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const bodyOf = (n) => {
  const i = code.indexOf(`function ${n}(`);
  return i < 0 ? "" : code.slice(i, code.indexOf("\n        }", i));
};

console.log("\nBoth pickers retry a roster that refused");
{
  for (const [fn, guard] of [["updatePeriodFilter", "periodFilterFetchTried"],
                             ["updateCashPeriodFilter", "cashFilterFetchTried"]]) {
    const body = bodyOf(fn);
    check(`${fn} retries when there is no roster`,
      /if \(!activeTeacherRoster\(\) && sisRosterState !== 'loading'/.test(body));
    check(`${fn} forces the refetch, so a 'failed' state is not sticky`,
      /loadTeacherRosterFromSIS\(true\)/.test(body));
    check(`${fn} repaints itself once it lands`, new RegExp(`${fn}\\(\\)`).test(body));
    check(`${fn} retries at most once per context (${guard})`,
      new RegExp(`!${guard}`).test(body) && new RegExp(`${guard} = true;`).test(body));
    check(`${fn} does not retry while previewing another teacher`,
      /!isPreviewingTeacher\(\)/.test(body));
  }
}

console.log("\nThe guards reset when the screen is opened again");
{
  check("raffle resets its guard", /function resetPeriodFilterFetch\(\)/.test(code));
  check("cash resets its guard", /function resetCashFilterFetch\(\)/.test(code));
  check("opening Award Cash resets it, so a later visit tries again",
    /resetCashFilterFetch\(\);\s*updateCashPeriodFilter\(\);/.test(code));
}

console.log("\nSign-in refreshes the roster instead of hoping it already ran");
{
  // The event fires AFTER the landing screen has painted. Waiting for a click
  // to fix it is what left the pickers empty for a whole session.
  check("the sign-in listener fetches the SIS roster", /await loadTeacherRosterFromSIS\(true\);/.test(code));
  check("forced, because a null-and-failed roster is otherwise refetched only by luck",
    /resetPeriodFilterFetch\(\);\s*resetReferralRosterFetch\(\);\s*await loadTeacherRosterFromSIS\(true\);/.test(code));
  check("and repaints rather than leaving it for the next click",
    /repaintRosterPickers\('sign-in'\);/.test(code));
  check("a failure there does not break the rest of sign-in",
    /catch \(e\) \{\s*console\.warn\('\[signin\] SIS roster refresh failed:'/.test(code));
  check("it still happens AFTER loadData and the roster refresh",
    /await refreshRosterFromConvex\('sign-in'\);[\s\S]{0,1200}await loadTeacherRosterFromSIS\(true\)/.test(code));
}

console.log("\nOne repaint function, so a new screen cannot quietly miss it");
{
  // Award Cash missing the retry Award Tickets had is exactly the shape of
  // mistake this prevents.
  const body = bodyOf("repaintRosterPickers");
  check("it exists", body.length > 0);
  for (const fn of ["updatePeriodFilter", "updateCashPeriodFilter", "updateCashTable",
                    "updateTicketsTable", "populateReferralStudentDropdown"]) {
    check(`it repaints ${fn}`, body.includes(fn));
  }
  check("each call is guarded, so one broken screen does not stop the others",
    /const safely = \(fn\) => \{ try \{ if \(typeof fn === 'function'\) fn\(\); \} catch \(e\) \{\} \};/.test(body));
  check("and it says what it found, so an empty roster is visible in the console",
    /section\(s\)/.test(body));
}

console.log("\nThe landing mode is still Cash, which is why this mattered");
{
  const modes = readFileSync(new URL("./wildcat-modes.js", import.meta.url), "utf8");
  new Function(modes)();
  const M = globalThis.WildcatModes;
  check("every role lands on Cash", ["teacher", "campusaide", "pbis", "admin", "superadmin"]
    .every((r) => M.defaultModeFor(r) === "cash"));
  check("so Award Cash is the first screen a roster failure would hit",
    /if \(tabName === 'awardCash'\)/.test(code));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
