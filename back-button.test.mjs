// The Back button, and the Microsoft error at the end of it.
//
// Sign-in is a REDIRECT flow, so Microsoft's authorize endpoint really is in
// the tab's history. Walking back into it re-requests a POST-only endpoint with
// a GET, and Microsoft answers:
//
//   AADSTS900561: The endpoint only accepts POST requests. Received a GET request
//
// which a teacher reads as the app being broken. Reported from Analytics ->
// Flagged for Intervention, where "View Details" threw the user onto another
// tab and Back was the natural way to get back to the list they were reading.
//
// Two fixes, and the assertions that keep them:
//   - that button no longer navigates at all; it opens the student's history
//   - MSAL's second navigation is off, and a dialog gives Back something of
//     ours to land on
//
// Run: npm test

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const strip = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const script = strip(readFileSync(new URL("./script.js", import.meta.url), "utf8"));
const auth = strip(readFileSync(new URL("./wildcat-auth.js", import.meta.url), "utf8"));

console.log("\nView Details opens the student, instead of moving the user");
{
  const i = script.indexOf("function viewStudentCashDetails(");
  const body = script.slice(i, script.indexOf("\n        }", i));
  check("the function exists", i > 0);
  check("it opens the cash history", /showStudentCashHistory\(studentId\)/.test(body));
  check("and does NOT switch tabs", !/switchTab\(/.test(body));

  // It hunted for rows in #studentAccountsTableBody. Accounts renders a GRID
  // OF CARDS into #studentAccountsGrid, so that selector matched nothing and
  // the highlight and scroll were both silently dead.
  check("nothing looks for the table body Accounts does not have",
    !/studentAccountsTableBody/.test(script));
  check("Accounts still renders into the grid it actually has",
    /getElementById\('studentAccountsGrid'\)/.test(script));
}

console.log("\nMSAL does not add a history entry it does not need");
{
  check("the second navigation after a redirect is switched off",
    /navigateToLoginRequestUrl:\s*false/.test(auth));
  check("it is set inside the auth block, where MSAL reads it",
    /auth:\s*\{[\s\S]{0,600}navigateToLoginRequestUrl:\s*false/.test(auth));
  check("the redirect flow is still what is used",
    /redirectUri:\s*window\.location\.origin/.test(auth));
  check("and the fragment is still stripped after a sign-in",
    /replaceState\(\{\}, document\.title, window\.location\.pathname/.test(auth));
}

console.log("\nBack closes a dialog rather than leaving the app");
{
  check("a dialog pushes one history entry when it opens",
    /history\.pushState\(\{ wcDialogOpen: true \}/.test(script));
  check("closing it normally consumes that entry again",
    /if \(history\.state && history\.state\.wcDialogOpen\) history\.back\(\);/.test(script));

  const i = script.indexOf("(function backClosesDialogs() {");
  const handler = script.slice(i, script.indexOf("})();", i));
  check("there is a popstate handler", i > 0);
  check("it does nothing unless a dialog is actually open",
    /if \(!open\) return;/.test(handler));
  check("it closes the dialog", /host\.innerHTML = '';/.test(handler));
  check("and re-pushes the entry it consumed, so the stack is where it was",
    /history\.pushState\(\{ wcDialogClosed: true \}/.test(handler));

  // A trap is worse than the bad entry it protects against.
  check("it never blocks Back when no dialog is open",
    handler.indexOf("if (!open) return;") < handler.indexOf("pushState"));
  check("every history call is guarded, so a blocked history API cannot break a dialog",
    (script.match(/try \{[^}]*history\.(pushState|back)/g) || []).length >= 3);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
