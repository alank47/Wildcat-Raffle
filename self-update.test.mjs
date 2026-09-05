// A tab nobody reloads must still get new code.
//
// index.html is served with cache-control: max-age=600 and a tab left open
// never re-fetches it. Teachers keep this app open all day, so a fix shipped in
// the morning reaches nobody. On 2026-09-04 two people reported a bug as
// unfixed from tabs running code five versions old.
//
// The old answer was a bar with a Reload button. That is a prompt, not a
// system. The new rule is: reload at the first moment when losing the screen
// costs nothing.
//
// TWO WAYS THIS GOES BADLY, AND THEY ARE WHAT THIS FILE IS ABOUT.
//
//   Reloading over work destroys it. A half-typed referral, ticked students, a
//   save in flight. An earlier automatic reload was removed for eating saves.
//
//   Reloading in a loop is far worse than a stale version. Inside the ten
//   minute cache window a reload can return the SAME index.html, so an
//   unguarded rule reloads forever, on every teacher's screen at once.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-update.js", import.meta.url), "utf8");
new Function(src)();
const U = globalThis.WildcatUpdate;

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const code = script.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const decide = (s) => U.shouldAutoReload({ hasUpdate: true, newVersion: "NEW", ...s });

console.log("\nIt takes the free moments, which is the whole point");
{
  check("a backgrounded tab reloads", decide({ hidden: true }).reload === true);
  check("and says why", /background/.test(decide({ hidden: true }).reason));
  check("an idle tab reloads", decide({ idleMs: 180000 }).reload === true);
  check("exactly at the threshold", decide({ idleMs: U.IDLE_MS }).reload === true);
  check("but not a second before", decide({ idleMs: U.IDLE_MS - 1 }).reload === false);
  check("the threshold is two minutes, not seconds", U.IDLE_MS === 120000);
  check("someone actively using it is left alone",
    decide({ idleMs: 5000 }).reload === false);
  check("and told so in the reason", /someone is using it/.test(decide({ idleMs: 5000 }).reason));
  check("no update means no reload, whatever else is true",
    U.shouldAutoReload({ hasUpdate: false, hidden: true, idleMs: 999999 }).reload === false);
}

console.log("\nIt never reloads over work");
{
  // Each of these outranks even the best moment.
  check("not while a save is pending, even on a hidden tab",
    decide({ hidden: true, savePending: true }).reload === false);
  check("not over a busy screen, even on a hidden tab",
    decide({ hidden: true, busy: true }).reload === false);
  check("not over work even after an hour idle",
    decide({ idleMs: 3600000, busy: true }).reload === false);
  check("a pending save outranks everything",
    decide({ hidden: true, idleMs: 999999, savePending: true }).reload === false);
  check("and the reason names it",
    /save is still pending/.test(decide({ hidden: true, savePending: true }).reason));
}

console.log("\nIt cannot loop, which would be worse than being stale");
{
  // Inside the ten minute cache window a reload can return the same file.
  // Without this guard every teacher's screen reloads forever.
  check("one automatic attempt per version",
    decide({ hidden: true, attemptedVersion: "NEW" }).reload === false);
  check("and it hands over to the bar rather than retrying",
    /leaving it to the bar/.test(decide({ hidden: true, attemptedVersion: "NEW" }).reason));
  check("a DIFFERENT version is still attempted",
    decide({ hidden: true, attemptedVersion: "OLDER" }).reload === true);

  check("the attempt is recorded BEFORE the reload, not after",
    /sessionStorage\.setItem\('wcUpdateAttempt', pendingUpdateVersion\);[\s\S]{0,400}location\.replace/.test(code));
  check("and read back into the decision",
    /attemptedVersion: sessionStorage\.getItem\('wcUpdateAttempt'\)/.test(code));
}

console.log("\nThe reload actually fetches a new file");
{
  // A plain location.reload() can be answered from cache, which inside the ten
  // minute window returns the same index.html and achieves nothing.
  const u = U.reloadUrl("https://wildcatraffle.com/", "20260904m");
  check("a cache-busting parameter is added", /wcv=20260904m/.test(u));
  check("existing query parameters survive",
    /tap=room12/.test(U.reloadUrl("https://wildcatraffle.com/?tap=room12", "v2")));
  check("and so does a pass link",
    /pass=abc/.test(U.reloadUrl("https://wildcatraffle.com/?pass=abc", "v2")));
  check("a malformed href returns null rather than a broken URL",
    U.reloadUrl("not a url", "v") === null);

  check("the parameter is stripped once the app is running",
    U.cleanUrl("https://wildcatraffle.com/?tap=room12&wcv=v2") === "https://wildcatraffle.com/?tap=room12");
  check("stripping preserves the rest of the query",
    /tap=room12/.test(U.cleanUrl("https://wildcatraffle.com/?tap=room12&wcv=v2")));
  check("nothing to strip returns null, so history is not rewritten pointlessly",
    U.cleanUrl("https://wildcatraffle.com/?tap=room12") === null);
  check("the app strips it via replaceState", /stripUpdateParam/.test(code));
}

console.log("\nThe app asks at the moments that are not throttled");
{
  // Chrome throttles setInterval hard in a background tab -- which is exactly
  // the tab this feature exists for. Timers alone are not enough.
  check("it still checks on a timer", /setInterval\(checkForAppUpdate, 300000\)/.test(code));
  check("it looks for a free moment far more often than that",
    /setInterval\(maybeApplyUpdate, 20000\)/.test(code));
  check("it acts the moment the tab is hidden",
    /if \(document\.visibilityState === 'hidden'\) \{\s*maybeApplyUpdate\(\);/.test(code));
  check("and re-checks when the tab comes back",
    /\} else \{[\s\S]{0,200}checkForAppUpdate\(\);/.test(code));
  check("and on window focus", /window\.addEventListener\('focus', checkForAppUpdate\)/.test(code));
}

console.log("\nUnfinished work is defined by what is actually on screen");
{
  const body = code.slice(code.indexOf("function screenHasUnfinishedWork()"),
                          code.indexOf("async function maybeApplyUpdate()"));
  check("an open modal counts", /\.modal:not\(\.hidden\)/.test(body));
  check("a dialog counts", /wcDialogRoot/.test(body));
  check("a typed referral description counts", /referralDescription/.test(body));
  check("a chosen referral student counts", /referralStudentSelect/.test(body));
  check("ticked students count", /checkbox"\]:checked/.test(body));
  check("typed cash notes count", /cashNotes/.test(body));
  check("and if it cannot tell, it assumes busy rather than reloading",
    /catch \(e\) \{ return true; \}/.test(body));
}

console.log("\nSaves are flushed before the page goes");
{
  check("flushSaves is awaited first", /await flushSaves\(\);/.test(code));
  check("and a failed flush CANCELS the reload rather than proceeding",
    /flush before reload failed; not reloading[\s\S]{0,80}return;/.test(code));
  check("the reload only happens after that", 
    /await flushSaves\(\);[\s\S]{0,400}location\.replace\(target\)/.test(code));
}

console.log("\nThe manual bar still exists for anyone who wants it now");
{
  check("showUpdateBar still runs", /function showUpdateBar\(newVersion\)/.test(code));
  check("and now also arms the automatic path",
    /pendingUpdateVersion = newVersion;\s*maybeApplyUpdate\(\);/.test(code));
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  check("wildcat-update.js is served", html.includes("wildcat-update.js"));
  check("before script.js", html.indexOf("wildcat-update.js") < html.indexOf('src="script.js'));
  const v = /wildcat-update\.js\?v=([0-9a-z]+)/.exec(html)?.[1];
  const sv = /src="script\.js\?v=([0-9a-z]+)/.exec(html)?.[1];
  check("on the same version as script.js", v && v === sv);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
