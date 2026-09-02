// What has to happen when a session finally appears.
//
// THE BUG, seen with eight people on their own devices for the first time.
// loadData() runs BEFORE any session exists, so every Convex read in it refuses
// with "Not signed in to Convex" and it falls back to localStorage. On a
// machine that has never run the app that fallback is EMPTY.
//
// The wildcat-auth-signin listener then refreshed ONLY students and teachers.
// Schedules, referrals, cash transactions, the audit log and the settings block
// stayed empty for the whole session. Aides opened "All students" and saw
// nothing; teachers had no class periods.
//
// Worse, refreshRosterFromConvex carries sections and ticket history across
// from the PREVIOUS students array. Run against an empty array it does not
// preserve them, it REPLACES them with []. So even the roster refresh actively
// wiped the class lists it was supposed to rescue.
//
// Run: npm test

import { readFileSync } from "node:fs";
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const listener = script.slice(
  script.indexOf("window.addEventListener('wildcat-auth-signin'"),
  script.indexOf("window.addEventListener('wildcat-auth-signin'") + 1800);

console.log("\nSigning in re-runs the whole load, not just the roster");
{
  check("loadData is called", /await loadData\(\);/.test(listener));
  check("and the roster refresh still runs after it",
    /await refreshRosterFromConvex\('sign-in'\)/.test(listener));
  check("loadData comes FIRST",
    listener.indexOf("await loadData()") < listener.indexOf("refreshRosterFromConvex"));
  check("the ordering requirement is written down",
    /Ordering matters\. loadData\(\) first/.test(listener));
}

console.log("\nA failing reload does not cost the roster too");
{
  // The roster refresh is what rescues the student list. It must run even if
  // the full load throws, or a transient failure leaves an empty screen.
  check("loadData is wrapped", /try \{\s*\n\s*await loadData\(\);\s*\n\s*\} catch/.test(listener));
  check("and the refresh sits outside that catch",
    listener.indexOf("catch (e)") < listener.indexOf("await refreshRosterFromConvex"));
}

console.log("\nThe sections carry-across is documented as order-dependent");
{
  // This line silently wipes class lists if it runs against an empty array,
  // which is precisely what happened.
  const fn = script.slice(script.indexOf("async function refreshRosterFromConvex"),
                          script.indexOf("window.addEventListener('wildcat-auth-signin'"));
  check("it still carries sections across", /sections: \(prior && prior\.sections\) \|\| \[\]/.test(fn));
  check("with the precondition stated at the line",
    /Only correct when `students` is ALREADY populated/.test(fn));
  check("and the consequence named, not just the rule",
    /replaces real sections\n\s*\/\/ with nothing/.test(fn));
}

console.log("\nThe stale comment that hid this is corrected");
{
  // loadData's own comment asserted the listener re-ran everything. It did not,
  // and that sentence is why nobody looked here.
  const around = script.slice(script.indexOf("Server load error:") - 900,
                              script.indexOf("Server load error:"));
  check("it no longer claims the whole load is re-run",
    !/re-runs the whole load/.test(around));
  check("it names what actually re-runs", /re-runs THIS function/.test(around));
  check("and is honest that a fresh machine starts empty",
    /it carries\n\s*\/\/ nothing/.test(around));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
