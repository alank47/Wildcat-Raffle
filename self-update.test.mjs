// A tab nobody reloads must still get new code.
//
// index.html is served with cache-control: max-age=600 and a tab left open
// never re-fetches it. Teachers keep this app open all day, so a fix shipped in
// the morning reaches nobody. On 2026-09-04 two people reported a bug as
// unfixed from tabs running code five versions old.
//
// The old answer was a bar with a Reload button. That is a prompt, not a
// system. The new rule is: reload at the first moment when losing the screen
// costs nothing. And since 2026-09-08 it is SILENT: no bar, no mascot, and the
// person comes back to the scroll position they left. The wildcat animation
// is for signing in, not for a refresh.
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
  // Without this guard every teacher's screen reloads forever. But parking
  // the version for the whole session left a bar on screen for a human; now
  // the tab simply tries again once the cache window has passed.
  const NOW = 1_800_000_000_000;
  check("the same version is not retried thirty seconds later",
    decide({ hidden: true, attemptedVersion: "NEW", attemptedAt: NOW - 30000, now: NOW }).reload === false);
  check("and the reason says the cache may still hold the old one",
    /cache/.test(decide({ hidden: true, attemptedVersion: "NEW", attemptedAt: NOW - 30000, now: NOW }).reason));
  check("nor one second before the window closes",
    decide({ hidden: true, attemptedVersion: "NEW", attemptedAt: NOW - U.RETRY_MS + 1000, now: NOW }).reload === false);
  check("it IS retried once the cache window has passed",
    decide({ hidden: true, attemptedVersion: "NEW", attemptedAt: NOW - U.RETRY_MS, now: NOW }).reload === true);
  check("the window is the ten minutes index.html is cached for", U.RETRY_MS === 600000);
  check("an attempt with no timestamp (recorded by older code) gets one more try",
    decide({ hidden: true, attemptedVersion: "NEW", now: NOW }).reload === true);
  check("a DIFFERENT version is still attempted straight away",
    decide({ hidden: true, attemptedVersion: "OLDER", attemptedAt: NOW - 1000, now: NOW }).reload === true);

  check("the attempt is recorded BEFORE the reload, not after",
    /sessionStorage\.setItem\('wcUpdateAttempt', pendingUpdateVersion\);[\s\S]{0,1200}location\.replace/.test(code));
  check("with the time it was made",
    /sessionStorage\.setItem\('wcUpdateAttemptAt', String\(Date\.now\(\)\)\)/.test(code));
  check("and both read back into the decision",
    /attemptedVersion: sessionStorage\.getItem\('wcUpdateAttempt'\)/.test(code) &&
    /attemptedAt: Number\(sessionStorage\.getItem\('wcUpdateAttemptAt'\)\)/.test(code) &&
    /now: Date\.now\(\)/.test(code.slice(code.indexOf("async function maybeApplyUpdate()"), code.indexOf("async function maybeApplyUpdate()") + 2000)));
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
    /await flushSaves\(\);[\s\S]{0,1000}location\.replace\(target\)/.test(code));
}

console.log("\nNothing is shown. The update is a system, not a prompt");
{
  // 2026-09-08: the bar came back after Later on every five minute check, and
  // stayed for the whole session once the cache had handed back the old
  // version. Teachers asked for it to go. It has gone: an update is applied at
  // the next free moment and nobody is asked.
  check("there is no update bar in the code", !/wcUpdateBar/.test(code) && !/wc-update-bar/.test(code));
  check("and no Reload now button", !/Reload now/.test(code));
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  check("nor its styling", !/\.wc-update-bar/.test(css));
  check("a detected update arms the automatic path",
    /function noteUpdateAvailable\(newVersion\)[\s\S]{0,400}pendingUpdateVersion = newVersion;[\s\S]{0,200}maybeApplyUpdate\(\);/.test(code));
  check("which is what the checker calls",
    /if \(m && m\[1\] && m\[1\] !== APP_VERSION\) \{\s*noteUpdateAvailable\(m\[1\]\);/.test(code));
  check("the diagnostic still says whether an update is waiting",
    /updatePending: pendingUpdateVersion/.test(code));
}

console.log("\nIt comes back to the same place");
{
  // The tab is already remembered (view-restore.test.mjs). The scroll
  // position was not, so a silent reload landed at the top of the screen and
  // gave the game away.
  const NOW = 1_800_000_000_000;
  const snap = U.resumeSnapshot({ version: "NEW", scrollY: 1234.6, now: NOW });
  check("a snapshot carries the scroll position, rounded", snap.y === 1235);
  check("the version it was reloading to", snap.v === "NEW");
  check("and when it was taken", snap.at === NOW);
  check("it round-trips through JSON",
    U.resumeFrom(JSON.stringify(snap), { now: NOW + 3000 }).scrollY === 1235);
  check("a snapshot older than two minutes is ignored: that tab never reloaded",
    U.resumeFrom(JSON.stringify(snap), { now: NOW + 121000 }) === null);
  check("exactly two minutes still counts",
    U.resumeFrom(JSON.stringify(snap), { now: NOW + 120000 }) !== null);
  check("garbage is ignored rather than thrown", U.resumeFrom("{not json", { now: NOW }) === null);
  check("so is nothing", U.resumeFrom(null, { now: NOW }) === null);
  check("and a negative or missing position", U.resumeFrom(JSON.stringify({ v: "x", y: -4, at: NOW }), { now: NOW }) === null);

  check("the snapshot is stashed AFTER the flush and BEFORE the reload",
    /await flushSaves\(\);[\s\S]{0,600}sessionStorage\.setItem\('wcResume'[\s\S]{0,400}location\.replace\(target\)/.test(code));
  check("boot restores it after the tab, since the tab decides the page height",
    /wcRestoreTab\(\);[\s\S]{0,300}wcRestoreScroll\(\);/.test(code));
  const restore = code.slice(code.indexOf("function wcRestoreScroll()"), code.indexOf("function wcRestoreScroll()") + 1500);
  check("the restore reads it through the tested helper", /WildcatUpdate\.resumeFrom\(/.test(restore));
  check("and forgets it, so a later manual refresh does not jump",
    /sessionStorage\.removeItem\('wcResume'\)/.test(restore));
}

console.log("\nA warm refresh shows no wildcat");
{
  // The loader arms 260ms into boot and then holds a 4s minimum, so every
  // refresh with a live session, including the silent update, ran the mascot
  // for four seconds. The animation is for signing in. A refresh gets a quiet
  // cover: same overlay, no mascot, no message, no minimum, so the login
  // screen never flashes and nothing runs across the screen.
  const bootStart = code.indexOf("const _isRedirectReturn");
  const boot = code.slice(bootStart, code.indexOf("await loadData();", bootStart));
  check("boot puts up the quiet cover the moment a session marker is found",
    /showLoader\(''?, \{ quiet: true, minMs: 0 \}\)/.test(boot));
  check("synchronously, not on a timer", !/setTimeout/.test(boot));
  const loader = code.slice(code.indexOf("function showLoader(message, opts)"), code.indexOf("function hideLoader()"));
  check("showLoader knows the quiet variant", /is-quiet/.test(loader));
  check("and does not fetch the 1.9MB gif for it",
    /if \(img && !quiet && !img\.getAttribute\('src'\)\)/.test(loader));
  const ui = readFileSync(new URL("./wildcat-ui.css", import.meta.url), "utf8");
  check("the stylesheet hides the mascot and message for the quiet cover",
    /\.wildcat-loader\.is-quiet \.wildcat-loader__inner\s*\{\s*display:\s*none/.test(ui));
  check("the sign-in paths still get the animation",
    /showLoader\('Signing you in…'\)/.test(code));
}

console.log("\nThe module is served, on the same version as the app");
{
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  check("wildcat-update.js is served", html.includes("wildcat-update.js"));
  check("before script.js", html.indexOf("wildcat-update.js") < html.indexOf('src="script.js'));
  const v = /wildcat-update\.js\?v=([0-9a-z]+)/.exec(html)?.[1];
  const sv = /src="script\.js\?v=([0-9a-z]+)/.exec(html)?.[1];
  check("on the same version as script.js", v && v === sv);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
