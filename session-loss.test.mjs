// Signed out, but the screen says otherwise.
//
// DIAGNOSED 2026-09-05 from wcDiagnoseData, which reported:
//
//   signedInNow: false
//   loadAttempts: [ started (signedIn:false), failed (signedIn:false) ]
//
// One load attempt, no session. The app was showing a teacher their own name,
// their own students and yesterday's numbers, on a session that could neither
// read nor write -- and saveData was logging "Saved to localStorage" as though
// that were success.
//
// currentUser and MSAL's cache both live in sessionStorage, so they die
// together when a tab closes. What comes apart is their lifetime INSIDE one
// tab: currentUser survives until the 30-minute inactivity timeout, while a
// Microsoft ID token lasts about an hour, after which acquireTokenSilent can
// need a prompt it cannot show and returns null. The boot code swallowed that
// in an empty catch.
//
// Run: npm test

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const raw = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const code = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

console.log("\nBoot refuses a session that only half came back");
{
  check("it checks for a real Convex session, not just a restored user",
    /const staffNeedsReauth =[\s\S]{0,300}WildcatAuth\.getSession\(\)\)/.test(code));
  check("and requires BOTH a restored user and a missing session",
    /hasSession && currentUser && currentUser\.role &&\s*\n\s*!\(window\.WildcatAuth/.test(code));
  check("the app is hidden rather than shown half-working",
    /staffNeedsReauth[\s\S]{0,700}mainApp'\)\.classList\.add\('hidden'\)/.test(code));
  check("and the login screen is shown instead",
    /staffNeedsReauth[\s\S]{0,800}loginScreen'\)\.classList\.remove\('hidden'\)/.test(code));
  check("the stale local user is cleared, not left to be re-restored",
    /staffNeedsReauth[\s\S]{0,600}currentUser = null;/.test(code));
  check("with a reason a teacher can act on",
    /did not carry over to this tab/.test(code));
  check("a healthy session still boots normally",
    /\} else if \(hasSession\) \{/.test(code));
}

console.log("\nA save that reached only this browser does not report success");
{
  check("saveData checks for a session after writing localStorage",
    /Saved to localStorage'\);[\s\S]{0,400}reportSessionLost/.test(code));
  check("reportSessionLost exists", /function reportSessionLost\(/.test(code));

  const i = code.indexOf("function reportSessionLost(");
  const fn = code.slice(i, code.indexOf("\n        }", i));
  // The commonest false alarm: a network blip while a session is perfectly fine.
  check("it says nothing when a session actually exists",
    /if \(auth && auth\.getSession && auth\.getSession\(\)\) return;/.test(fn));
  check("it shows once, not on every save", /if \(_sessionLostShown\) return;/.test(fn));
  check("it offers the one action that fixes it",
    /signInWithMicrosoft\(\)/.test(fn));
  check("and warns against the one action that loses the work",
    /Do not close this tab/.test(code));
}

console.log("\nIt clears itself when the session comes back");
{
  check("a successful sign-in removes the bar",
    /wildcat-auth-signin'[\s\S]{0,300}wcSessionLost'\)[\s\S]{0,80}remove\(\)/.test(code));
  check("and re-arms it, so a second expiry is reported too",
    /wildcat-auth-signin'[\s\S]{0,200}_sessionLostShown = false/.test(code));
}

console.log("\nThe bar cannot be missed or dismissed");
{
  check("it is fixed to the viewport", /\.wc-session-lost \{[^}]*position: fixed/.test(css));
  check("above everything, including the dialog at 9999",
    /\.wc-session-lost \{[^}]*z-index: 10000/.test(css));
  check("in the colour the app uses for a stop",
    /\.wc-session-lost \{[^}]*background: #B3392F/.test(css));
  check("and has no dismiss control at all -- only sign in",
    !/wc-session-dismiss|wc-session-later/.test(code));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
