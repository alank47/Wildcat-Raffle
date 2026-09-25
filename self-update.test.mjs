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
import { execSync } from "node:child_process";

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


// ---------------------------------------------------------------------------
// THE FIVE-MINUTE BLIND WINDOW, and the button that could not escape the cache.
//
// Added 2026-09-09 after "is there a way we can make it so no one has to hard
// refresh for any purpose?". Two real gaps, both in the triggering rather than
// the mechanism:
//
//   1. setInterval does not fire on the way in, so the FIRST update check
//      happened five minutes after load. GitHub Pages serves index.html with
//      cache-control: max-age=600, so a teacher opening the app within ten
//      minutes of their last visit was handed the cached html -- old ?v= stamp,
//      old script.js -- and then ran it unchecked for five more minutes.
//
//   2. The "Reload now" button called location.reload(), which for a document
//      inside its max-age window can be answered from cache with the very
//      version the button exists to escape. The AUTOMATIC path already went
//      through reloadUrl and added ?wcv=, which is a URL the cache has never
//      seen. The button did not.
// ---------------------------------------------------------------------------
{
  const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

  check("the update check runs at startup, not only on an interval",
    /setTimeout\(checkForAppUpdate, 3000\)/.test(script));
  check("and again shortly after, in case the first lost the race to sign-in",
    /setTimeout\(checkForAppUpdate, 30000\)/.test(script));
  check("the five-minute interval is still there as the backstop",
    /setInterval\(checkForAppUpdate, 300000\)/.test(script));
  check("returning to the tab still forces a check",
    /window\.addEventListener\('focus', checkForAppUpdate\)/.test(script));

  // The check itself must never be answered from cache, or it would compare
  // the running version against a stale copy of index.html and see no update.
  // 8 checks in the first minute of one real session, each pulling a 367 KB
  // index.html. Focus and visibilitychange both fire it, and neither is rare.
  check("repeat checks are throttled", /now - _lastCheckAt < 20000\) return;/.test(script));
  check("an unchanged page is ruled out by ETag before downloading it",
    /method: 'HEAD', cache: 'no-store'/.test(script) && /_lastIndexEtag === etag\) return/.test(script));
  check("a HEAD failure falls through to the full GET rather than giving up",
    /catch \(e\) \{ \/\* fall through to the GET \*\/ \}/.test(script));
  check("no ETag means the GET still happens", /if \(etag\) \{/.test(script));

  check("the version check bypasses the HTTP cache",
    /fetch\('index\.html\?vcheck=' \+ Date\.now\(\), \{ cache: 'no-store' \}\)/.test(script));

  // The Reload button is gone (see "Nothing is shown" above); the automatic
  // path is the only reload, and it has always gone through reloadUrl.
  check("there is no Reload button left to go through the cache", !/wc-update-reload/.test(script));
  check("the one reload path goes through reloadUrl and falls back to a plain reload",
    /const target = window\.WildcatUpdate\.reloadUrl\(location\.href, pendingUpdateVersion\);\s*if \(target\) location\.replace\(target\); else location\.reload\(\);/.test(script));

  // reloadUrl is what makes any of this cache-proof: a new query parameter is
  // a URL the browser cache has never seen, so max-age cannot answer it.
  const U = globalThis.WildcatUpdate;
  const target = U.reloadUrl("https://wildcatraffle.com/", "20260909b");
  check("reloadUrl produces a URL the cache cannot have", target.includes("wcv=20260909b"));
  check("it preserves an existing query, which carries tap and pass ids",
    U.reloadUrl("https://wildcatraffle.com/?pass=abc", "v2").includes("pass=abc"));
  check("and the stamp is stripped on the way back in",
    U.cleanUrl("https://wildcatraffle.com/?wcv=v2") === "https://wildcatraffle.com/");
}


// ---------------------------------------------------------------------------
// EVERY STAMP IN index.html AGREES.
//
// 2026-09-09: after a merge and two version bumps in one morning, the service
// worker was still registered as sw.js?v=20260909f while every other asset was
// on ...h. Harmless that day because sw.js had not changed -- but the stamp is
// the only thing that makes the browser look again, so a worker that HAD
// changed would have been served from the ten-minute cache instead.
//
// The bump is a sed across the file. Anything the sed misses is a file frozen
// at an old version with nothing to say so.
// ---------------------------------------------------------------------------
{
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const stamps = [...html.matchAll(/\?v=([0-9a-z]+)/g)].map((m) => m[1]);
  const distinct = [...new Set(stamps)];
  check("index.html carries version stamps at all", stamps.length > 5);
  check(
    distinct.length === 1
      ? "every ?v= stamp in index.html is the same version"
      : `stamps disagree: ${distinct.join(", ")}`,
    distinct.length === 1
  );
  // The service worker is the one that gets missed, because it is registered
  // from inline script rather than sitting in a <script src>.
  // THE STAMP MUST MOVE WHEN THE CODE DOES, and nothing checked that until
  // 2026-09-16, when a deploy was one pre-flight check away from being served
  // to tabs that already held the stamp. Each would have fetched
  // script.js?v=20260915a from its cache, compared it to its own APP_VERSION,
  // found them equal, logged "up to date" and never armed again -- so a whole
  // day's fixes would have reached nobody, silently, after a green push.
  //
  // Asked of git rather than of a hardcoded date: the question is not "is this
  // stamp today's" but "has script.js changed since the stamp last did".
  // Skipped where git is unavailable, because a check that cannot run must not
  // fail a build for it.
  {
    let stampAt = null, scriptAt = null;
    try {
      const run = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      // -G, NOT -S. The pickaxe -S reports commits where the NUMBER OF
      // OCCURRENCES of a string changed, and a stamp bump leaves the count of
      // "script.js?v=" exactly as it was -- so -S skipped every bump ever made
      // and pointed at the day the line was first written. -G matches a commit
      // whose diff contains the pattern, which is what "the stamp moved" means.
      stampAt = run(`git log -1 --format=%ct -G'script\\.js\\?v=' -- index.html`);
      scriptAt = run(`git log -1 --format=%ct -- script.js`);
    } catch (e) { /* no git, or a shallow clone: skipped below */ }

    if (stampAt && scriptAt) {
      check("the ?v= stamp moved no earlier than script.js last changed",
        Number(stampAt) >= Number(scriptAt),
        `stamp last moved ${new Date(Number(stampAt) * 1000).toISOString()}, ` +
        `script.js last changed ${new Date(Number(scriptAt) * 1000).toISOString()} ` +
        `-- bump all 26 stamps in index.html or open tabs will never fetch this`);
    } else {
      console.log("  SKIP  stamp freshness (git not available here)");
    }
  }

  const sw = html.match(/sw\.js\?v=([0-9a-z]+)/);
  check("the service worker is stamped", !!sw);
  check("and on the same version as everything else", sw && sw[1] === distinct[0]);
}

console.log("\n-- the busy deadline: a weekend tab cannot hold write access forever --");
{
  // THE INCIDENT, 2026-09-13. `busy` blocked a reload indefinitely, and it is
  // true of a tab with a modal left open, a half-typed referral, one ticked
  // checkbox, or ANY exception inside screenHasUnfinishedWork, which fails to
  // "assume busy". A tab backgrounded on Friday with a dialog open therefore
  // never updated -- and a four-day-stale tab re-sent its pre-reset view over
  // a server-side cash reset, restoring $4,901,850 across 336 students.
  //
  // The school has 40+ staff. "Ask everyone to refresh" is not a mechanism,
  // which is what the owner said and was right about.
  const HOUR = 3600000;
  const at = (s) => U.shouldAutoReload({ hasUpdate: true, newVersion: "NEW", now: 1e9, ...s });

  // UNCONFIRMED MONEY (2026-09-25). A hidden tab that could not save all
  // morning was reloaded at the busy deadline and nine awards were lost.
  check("unconfirmed money blocks an update even on a hidden tab past the busy deadline",
    at({ unconfirmedMoney: true, unconfirmedMoneyAgeMs: 3 * HOUR, busy: true, hidden: true, pendingForMs: 99 * HOUR }).reload === false);
  check("...and says why", /cash the server has not confirmed/.test(at({ unconfirmedMoney: true, hidden: true }).reason));
  check("...and on an idle visible tab too", at({ unconfirmedMoney: true, unconfirmedMoneyAgeMs: 60000, idleMs: 999999 }).reload === false);
  check("but money stuck for a day is a fault, and the update goes ahead",
    at({ unconfirmedMoney: true, unconfirmedMoneyAgeMs: 25 * HOUR, hidden: true }).reload === true
      && U.MONEY_HOLD_MAX_MS === 24 * HOUR);
  check("no unconfirmed money: the ordinary rules, unchanged", at({ unconfirmedMoney: false, hidden: true }).reload === true);
  check("TEETH: the hold must be checked before the busy deadline's override",
    src.indexOf("if (s.unconfirmedMoney)") < src.indexOf("if (s.busy && !(s.hidden && overdue))"));
  // A movement the server held as 'capped' can never land on a retry, so it
  // must not pin the tab to an old build for a day (review, 2026-09-25).
  {
    const lift = (name) => {
      const i = script.indexOf("function " + name + "(");
      let d = 0, k = script.indexOf("{", i);
      for (; k < script.length; k++) { if (script[k] === "{") d++; else if (script[k] === "}") { d--; if (d === 0) break; } }
      return script.slice(i, k + 1);
    };
    const f = new Function("_pendingCashMovements", "_cashLastHeldCapped",
      lift("unconfirmedCashForUpdate") + "\n" + lift("oldestUnconfirmedCashAgeMs") + "\nreturn { unconfirmedCashForUpdate, oldestUnconfirmedCashAgeMs };");
    const pending = new Map([["12101", [{ id: "txn_big", at: new Date(Date.now() - 3 * HOUR).toISOString(), amount: -6000, kind: "redeem" }]]]);
    const capped = new Set(["txn_big"]);
    const api = f(pending, capped);
    check("a movement last held as 'capped' does NOT hold the update", api.unconfirmedCashForUpdate().length === 0);
    const api2 = f(pending, new Set());
    check("...while the same movement NOT capped does", api2.unconfirmedCashForUpdate().length === 1 && api2.oldestUnconfirmedCashAgeMs() >= 3 * HOUR - 1000);
    check("the save records which held movements were capped, and clears any the server answered otherwise",
      /heldWhy\.forEach\(\(why, id\) => \{\s*if \(why === 'capped'\) _cashLastHeldCapped\.add\(String\(id\)\);\s*else _cashLastHeldCapped\.delete\(String\(id\)\);/.test(script));
  }
  check("the tab passes its pending list, not a screen flag",
    /unconfirmedMoney: unconfirmedCashForUpdate\(\)\.length > 0,/.test(script)
      && /unconfirmedMoneyAgeMs: oldestUnconfirmedCashAgeMs\(\),/.test(script));

  // UNCHANGED: politeness while somebody is actually looking at the screen.
  check("busy and visible still waits, however long it has waited",
    at({ busy: true, hidden: false, pendingForMs: 99 * HOUR }).reload === false);
  // UNCHANGED: a hidden tab with a clean screen reloads at once.
  check("hidden and not busy reloads immediately",
    at({ busy: false, hidden: true, pendingForMs: 0 }).reload === true);

  // THE FIX.
  check("hidden and busy still waits inside the deadline",
    at({ busy: true, hidden: true, pendingForMs: HOUR }).reload === false);
  const overdue = at({ busy: true, hidden: true, pendingForMs: 3 * HOUR });
  check("a hidden tab overdue past the deadline reloads", overdue.reload === true);
  check("and says why, because somebody will ask", /unfinished screen work/.test(overdue.reason));
  check("the weekend case: hidden, busy, three days",
    at({ busy: true, hidden: true, pendingForMs: 72 * HOUR }).reload === true);

  // UNSAVED WORK IS NOT SCREEN WORK, and the deadline must never reach it.
  // This is the failure that got automatic reloads removed the first time.
  check("a pending save blocks regardless of the deadline",
    at({ savePending: true, busy: true, hidden: true, pendingForMs: 99 * HOUR }).reload === false);
  check("and the reason still names the save",
    /save is still pending/.test(at({ savePending: true, hidden: true, pendingForMs: 99 * HOUR }).reason));

  // Overridable, so a test need not wait two hours and the window can be
  // tightened without touching the module.
  check("the deadline can be set by the caller",
    at({ busy: true, hidden: true, pendingForMs: 60000, busyDeadlineMs: 1000 }).reload === true);
  // A caller that does not send pendingForMs must keep the politer behaviour
  // rather than being read as overdue.
  check("no pendingForMs means not overdue, so busy still blocks",
    at({ busy: true, hidden: true }).reload === false);

  // The client has to actually measure it, or the deadline is decorative.
  check("script.js stamps when the pending version was first seen",
    /_pendingUpdateSince = Date\.now\(\)/.test(script));
  check("and feeds the elapsed time to the decision",
    /pendingForMs: _pendingUpdateSince \? Date\.now\(\) - _pendingUpdateSince : 0/.test(script));

  // And the refusal path that gets a proven-stale tab current at once.
  check("a refused cash counter forces a reload", /wcForceReload\('cash counters refused'\)/.test(script));
  check("the force reload is rate limited, so a cached reload cannot loop",
    /wcForceReloadAt/.test(script) && /force reload suppressed/.test(script));
  check("and the save sends the build asking, so the server can tell",
    /clientVersion: \(typeof APP_VERSION/.test(script));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
