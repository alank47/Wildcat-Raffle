/**
 * Wildcat Hub federated sign-in.
 *
 *   staff    -> Microsoft Entra ID (O365) via MSAL
 *   students -> Google via Google Identity Services
 *
 * Both produce an OIDC ID token. The token goes to Convex, which verifies the
 * signature and the claims and decides who the caller is. Nothing in this file
 * is a security control: it is the part that ASKS for a token. Everything that
 * DECIDES lives in convex/identity.ts, because this file runs in a browser that
 * anyone can open devtools on and edit.
 *
 * Deliberately its own file rather than more lines in script.js: script.js is
 * ~1MB and is hand-edited through the GitHub web UI by the repo owner, so every
 * line added there is conflict surface.
 *
 * Setup: docs/entra-signin-setup.md and docs/google-signin-setup.md
 * No build step. Both SDKs load from their vendors' CDNs.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Are we the app, or are we an auth popup that landed on the app by
  // mistake?
  //
  // The redirect target is auth-redirect.html, a near-empty page. But the bare
  // origin is also still a registered redirect URI, and any browser holding a
  // cached index.html keeps using the OLD redirect for as long as that cache
  // lives. When that happens the popup loads the whole app, this file runs
  // inside the popup, and MSAL refuses with block_nested_popups: it is being
  // asked to open a popup from within a popup.
  //
  // If we are clearly an auth landing (opened by another window, carrying an
  // auth fragment), do nothing at all. MSAL's parent reads the fragment off
  // this window's URL; it does not need us to run, and running is what breaks
  // it. Stopping here turns a confusing nested-popup error into a normal
  // successful sign-in.
  // ---------------------------------------------------------------------
  try {
    const hash = String(window.location.hash || '');
    const isAuthLanding = /[#&](code|error|id_token|access_token)=/.test(hash);
    if (window.opener && window.opener !== window && isAuthLanding) {
      return; // let the opener collect the fragment
    }
  } catch (_) {
    /* cross-origin opener access can throw; fall through and behave normally */
  }

  // ---------------------------------------------------------------------
  // CONFIG. All four values are public: they ship in the page and appear in
  // every token. The Entra client SECRET and the Google client SECRET are NOT
  // used by these flows and must never appear here. This repo is public.
  // ---------------------------------------------------------------------
  const CONFIG = {
    convexUrl: 'https://quick-cassowary-644.convex.cloud',

    entra: {
      clientId: '0f22dd11-7c0a-4356-93d7-0abf07642001',  // Application (client) ID -- app registration "Wildcat Hub"
      tenantId: 'afc1d09c-9f9b-4d45-9643-198f7dc264c4',  // Directory (tenant) ID
    },

    google: {
      clientId: '718452352756-cclr7dbvucal375vrj5m9fg25fn3eh3s.apps.googleusercontent.com',

      // NATIVE APP ONLY. The browser never reads this.
      //
      // Google Identity Services refuses to load under the `capacitor://` origin
      // a locally served webview has, and iOS cannot give that webview an https
      // origin: `iosScheme: 'https'` is ignored, because WKWebView reserves http
      // and https for real network loads. Measured, not assumed. So inside the
      // app the web sign-in above cannot work at all and native sign-in takes
      // over, which needs its own OAuth client of type iOS, created in the SAME
      // Google project as the web client above, for bundle id
      // org.westbrookacademy.wildcat.
      //
      // Until that exists this stays the placeholder and the app says so plainly
      // rather than failing with a Google error nobody can act on. See
      // Grilled.md open question 26.
      iosClientId: '718452352756-9gvjcrk7t7qd8k27d4fpp76qabhvko1r.apps.googleusercontent.com',

      // RESTORED 2026-08-14. It was unset while students appeared to be on two
      // domains; the RWWN ones turned out to be retired, so STUDENT_DOMAINS is a
      // single entry and pinning the chooser hides nobody. On a shared
      // Chromebook with several Google accounts signed in, this is the
      // difference between one tap and picking the wrong account.
      //
      // Still not a security control. `hd` is a filter the client asks for and
      // cannot enforce; the real check is server side in identityRules.ts,
      // comparing the verified token's issuer AND domain by exact equality.
      hostedDomain: 'westbrookacademy.org',
    },
  };

  const configured = {
    entra: () => Boolean(CONFIG.entra.clientId && CONFIG.entra.tenantId),
    google: () => Boolean(CONFIG.google.clientId),
  };

  // ---------------------------------------------------------------------
  // Convex transport. The HTTP API needs no bundler and no npm package.
  // ---------------------------------------------------------------------

  /**
   * Convex returns HTTP 200 with {status:"error"} for a function that threw, so
   * checking res.ok alone silently treats "you are not staff" as success.
   */
  async function convexQuery(path, args, idToken) {
    const res = await fetch(`${CONFIG.convexUrl}/api/query`, {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        idToken ? { Authorization: `Bearer ${idToken}` } : {},
      ),
      body: JSON.stringify({ path, args: args || {}, format: 'json' }),
    });

    if (!res.ok) throw new Error(`Convex HTTP ${res.status}`);

    const body = await res.json();
    if (body.status === 'error') {
      // A ConvexError thrown server side arrives in errorData and keeps its
      // text. A plain Error is REDACTED by Convex in production to
      // "Server Error" plus a request id, so errorData is the one worth
      // showing a person and errorMessage is only a fallback.
      const detail =
        (typeof body.errorData === 'string' && body.errorData) ||
        (body.errorData && body.errorData.message) ||
        body.errorMessage ||
        'Convex function failed';
      throw new Error(detail);
    }
    return body.value;
  }

  /** Same contract as convexQuery, against the mutation endpoint. */
  async function convexMutation(path, args, idToken) {
    const res = await fetch(`${CONFIG.convexUrl}/api/mutation`, {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        idToken ? { Authorization: `Bearer ${idToken}` } : {},
      ),
      body: JSON.stringify({ path, args: args || {}, format: 'json' }),
    });
    if (!res.ok) throw new Error(`Convex HTTP ${res.status}`);
    const body = await res.json();
    if (body.status === 'error') {
      throw new Error(
        (typeof body.errorData === 'string' && body.errorData) ||
        body.errorMessage || 'Convex mutation failed',
      );
    }
    return body.value;
  }

  // One promise per URL, resolved when the script has actually EXECUTED.
  //
  // The previous version returned early if a tag with this src was already in
  // the DOM: `if (document.querySelector(...)) return resolve()`. A tag exists
  // the instant it is appended, long before 270KB of MSAL has arrived, so the
  // second caller was told "loaded" while window.msal was still undefined and
  // then read PublicClientApplication off it.
  //
  // That is the "Cannot read properties of undefined (reading
  // 'PublicClientApplication')" report, and the race is real on a cold cache:
  // resumeSession() starts this download on page load, and the sign-in button
  // is clickable immediately. Clicking during the download hit it every time.
  // Clicking again worked, which is why it looked intermittent.
  const scriptLoads = new Map();

  function loadScript(src) {
    const inFlight = scriptLoads.get(src);
    if (inFlight) return inFlight;

    const p = new Promise((resolve, reject) => {
      const fail = () => reject(new Error(`Failed to load ${src}`));

      // A tag from a previous page render, or one this function added before
      // the map existed. Attach to it rather than assuming it finished.
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset && existing.dataset.wcLoaded === 'true') return resolve();
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', fail);
        return;
      }

      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => {
        if (el.dataset) el.dataset.wcLoaded = 'true';
        resolve();
      };
      el.onerror = fail;
      document.head.appendChild(el);
    });

    // A failed load must not be cached, or one flaky download would poison
    // every retry for the life of the page. Success stays cached.
    p.catch(() => scriptLoads.delete(src));
    scriptLoads.set(src, p);
    return p;
  }

  // ---------------------------------------------------------------------
  // Staff: Microsoft Entra ID
  // ---------------------------------------------------------------------
  // Microsoft's own CDN (alcdn.msauth.net / alcdn.msftauth.net) 404s on every
  // version of this path now, which is what broke the first attempt: the script
  // never loaded, so the popup never opened. jsdelivr serves the npm package.
  //
  // Pinned to an EXACT version on purpose. A floating major like @5 would let a
  // breaking change land in a login page nobody redeployed, and the failure
  // would look like "sign-in is broken" with no correlating commit.
  const MSAL_VERSION = '5.18.0';
  const MSAL_CDN =
    `https://cdn.jsdelivr.net/npm/@azure/msal-browser@${MSAL_VERSION}/lib/msal-browser.min.js`;
  let msalApp = null;
  let msalAppPromise = null;

  // Callers race each other as well as the download. resumeSession() runs on
  // page load and signInStaff() runs on the click, and both used to see
  // msalApp === null and build their own PublicClientApplication against the
  // same sessionStorage. Everything after the first await is therefore held in
  // one shared promise, so concurrent callers wait on the same construction
  // instead of duplicating it.
  function entraClient() {
    if (msalApp) return Promise.resolve(msalApp);
    if (!configured.entra()) {
      return Promise.reject(
        new Error('Entra is not configured yet. See docs/entra-signin-setup.md'),
      );
    }
    if (msalAppPromise) return msalAppPromise;

    msalAppPromise = buildEntraClient();
    // A failed build must not be cached, or one dropped download would leave
    // sign-in permanently broken until a reload.
    msalAppPromise.catch(() => { msalAppPromise = null; });
    return msalAppPromise;
  }

  async function buildEntraClient() {
    await loadScript(MSAL_CDN);

    // loadScript resolving is not proof the global exists: a CDN can answer 200
    // with something that is not this library. Say which of the two went wrong
    // rather than throwing "cannot read properties of undefined".
    if (!window.msal || !window.msal.PublicClientApplication) {
      throw new Error(
        'The Microsoft sign-in library loaded but did not register itself. ' +
        'Reload the page, and if it persists check that ' + MSAL_CDN + ' is reachable.',
      );
    }

    msalApp = new window.msal.PublicClientApplication({
      auth: {
        clientId: CONFIG.entra.clientId,
        authority: `https://login.microsoftonline.com/${CONFIG.entra.tenantId}`,
        // REDIRECT flow, so this is the app itself: the browser comes back
        // here with the code and the app processes it on load.
        //
        // The popup flow was tried first and abandoned. It depends on the
        // opener polling the popup's URL for the fragment, which failed in
        // ways that were slow to diagnose (timed_out, then block_nested_popups
        // from cached HTML). Redirect has no cross-window handshake to go
        // wrong, and popups are blocked by default on mobile Safari anyway,
        // which matters for Chromebooks and phones.
        redirectUri: window.location.origin + '/',
        // NO SECOND NAVIGATION AFTER THE REDIRECT.
        //
        // Default true, which makes MSAL navigate a second time -- back to
        // whatever URL started the sign-in -- once it has processed the
        // response. That extra hop pushes another entry onto the history
        // stack, so a Back press later in the session walks into Microsoft's
        // authorize endpoint and gets:
        //
        //   AADSTS900561: The endpoint only accepts POST requests.
        //                 Received a GET request
        //
        // which a teacher reads as the app being broken. The app already puts
        // itself in the right place after sign-in, so the second navigation
        // buys nothing and costs that.
        navigateToLoginRequestUrl: false,
      },
      cache: { cacheLocation: 'sessionStorage' },
    });
    if (msalApp.initialize) await msalApp.initialize();

    // This is the return leg of the redirect flow: it parses the code out of
    // the URL and exchanges it for tokens. It also clears any interaction MSAL
    // still believes is outstanding, so a sign-in abandoned halfway does not
    // block the next attempt with interaction_in_progress.
    if (msalApp.handleRedirectPromise) {
      redirectResult = await msalApp.handleRedirectPromise().catch(function (err) {
        console.error('[wildcat-auth] redirect handling failed:', err);
        return null;
      });
    }
    return msalApp;
  }

  let redirectResult = null;

  /**
   * Polls until the app's roster is loaded, then returns the matching record.
   *
   * Bounded, so a genuinely missing record still reports as missing rather than
   * hanging forever on a spinner. Resolves as soon as the roster appears, so
   * the normal case costs one tick, not the whole timeout.
   */
  async function waitForTeacherRecord(normalizedEmail, timeoutMs, idToken) {
    const deadline = Date.now() + (timeoutMs || 20000);

    // A NON-EMPTY `teachers` ARRAY IS NOT PROOF OF ANYTHING.
    //
    // This used to give up the moment the array had rows in it, on the
    // reasoning that "the roster is loaded and the address genuinely is not in
    // it". That was true while Firestore served the roster WITHOUT a sign-in:
    // whatever was in the array had come from the server.
    //
    // Retiring Firestore broke it. loadData now needs a Convex session, so on
    // a redirect return it fails with "Not signed in to Convex" and falls back
    // to localStorage. The array is then a STALE LOCAL CACHE from this
    // machine's last good load, and it is non-empty, so this function searched
    // it, missed, and reported a missing staff record — seconds before the
    // real roster arrived from Convex.
    //
    // It only bit staff added since that machine last cached a roster, which
    // is why it looked like two specific people with bad email addresses. The
    // addresses were correct the whole time.

    // Ask the SERVER first, because it is the only authoritative answer.
    // me:get runs on requireIdentity rather than requireStaff, so it answers
    // for exactly the people this function exists to judge.
    if (idToken) {
      try {
        const me = await convexQuery('me:get', {}, idToken);
        if (me && me.hasAppRecord === false) {
          // Genuinely absent. Say so now rather than making them wait out the
          // timeout for an answer that will not change.
          return null;
        }
      } catch (e) {
        // Unreachable server, an expired token, anything: fall through to
        // polling. A diagnostic must never be the thing that blocks a sign-in.
        console.warn('[wildcat-auth] me:get check skipped:', (e && e.message) || e);
      }
    }

    for (;;) {
      if (typeof teachers !== 'undefined' && Array.isArray(teachers) && teachers.length) {
        const hit = teachers.find(function (t) {
          return (t.email || '').trim().toLowerCase() === normalizedEmail;
        });
        if (hit) return hit;
        // NOT a conclusion. The post-sign-in refresh may still be in flight,
        // and it replaces this array wholesale when it lands.
      }
      if (Date.now() > deadline) return null;
      await new Promise(function (r) { setTimeout(r, 200); });
    }
  }

  // ---------------------------------------------------------------------
  // The shared Chromebook guard.
  //
  // THE FAILURE THIS PREVENTS. These machines are shared: a teacher signs in
  // during first period and a student picks the same one up at lunch. MSAL
  // caches the teacher's account, so ANY call to acquireTokenSilent on that
  // machine hands back a valid staff token with nobody having clicked
  // anything. resumeSession() used to run from onReady(), on every page load,
  // for everyone. So the student who opened the app after the teacher was
  // silently signed in AS that teacher, holding the teacher's roster and the
  // teacher's power to award tickets and Wildcat Cash. No prompt, no click,
  // nothing on screen to notice, and it is Microsoft running on the student
  // path, which the owner has said must never happen.
  //
  // Two conditions now have to hold before anything silent is attempted, and
  // both are about the PERSON standing there rather than what the browser
  // remembers:
  //
  //   1. staffSignInRequested -- a member of staff pressed the staff sign-in
  //      button in this page view. Page load cannot set it. This is what
  //      makes the old bug structurally unreachable rather than merely
  //      removed: re-adding a resumeSession() call to onReady() would still
  //      resume nothing.
  //   2. staffEntranceActive() -- the student portal is not on screen and the
  //      login screen is not showing its Student tab.
  //
  // The cost of being wrong in the safe direction is a teacher pressing "Sign
  // in with Microsoft" once more than before. The cost of being wrong in the
  // other direction is a fourteen year old holding an award button. Every
  // ambiguous case resolves toward the first one.
  // ---------------------------------------------------------------------

  let staffSignInRequested = false;

  function staffEntranceActive() {
    const onScreen = (id) => {
      const el = document.getElementById(id);
      if (!el) return false;
      const cl = el.classList;
      return !(cl && cl.contains && cl.contains('hidden'));
    };

    // Somebody is using the app AS a student, right now.
    if (onScreen('studentPassView')) return false;
    const body = document.body;
    if (body && body.classList && body.classList.contains &&
        body.classList.contains('wp-open')) return false;

    // The login screen is showing its Student tab. Whoever is standing here
    // walked up to the student entrance, whatever this browser remembers
    // about the last person who used it.
    if (onScreen('studentLoginForm')) return false;

    return true;
  }

  /**
   * Drop the cached Microsoft account, WITHOUT loading MSAL to do it.
   *
   * Called the moment a student successfully signs in. After that point this
   * device has demonstrably passed to a student, and leaving the previous
   * teacher's account sitting in storage is the whole shared-Chromebook
   * problem in one object: it is what acquireTokenSilent reads, and it is what
   * would let one stray press of the Microsoft button restore a session that
   * belongs to somebody else.
   *
   * Deliberately implemented as key removal rather than msalApp.logout(): the
   * student path must not load, initialise or run the Microsoft SDK, and
   * calling into MSAL to forget Microsoft would do exactly that. MSAL's cache
   * is plain, namespaced storage keys, so this needs no library.
   */
  function forgetCachedStaffAccount() {
    for (const store of [window.sessionStorage, window.localStorage]) {
      if (!store) continue;
      const doomed = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith('msal.')) doomed.push(k);
      }
      doomed.forEach((k) => { try { store.removeItem(k); } catch (_) {} });
    }
    msalApp = null;
    msalAppPromise = null;
    staffSignInRequested = false;
  }

  /**
   * Re-establish the session without asking the user for credentials again.
   *
   * THE BUG THIS FIXES. completeRedirectSignIn() returns immediately unless the
   * URL hash carries a redirect response, so the session existed for exactly
   * ONE page load: the one returning from Microsoft. Every reload after that
   * had `session` null, `appData:load` refused, and the app silently fell back
   * to the old Firestore roster. A teacher would sign in, see the right data,
   * refresh, and see the wrong data with nothing to explain it.
   *
   * MSAL caches the account in sessionStorage, so it survives a reload in the
   * same tab. It was simply never asked. acquireTokenSilent uses that cached
   * account and returns a fresh id token with no user interaction.
   *
   * Silent means silent: a failure here is NOT an error. It means nobody is
   * signed in, or the cached token cannot be renewed without a prompt, and the
   * correct response is to leave the sign-in button where it is.
   *
   * finishSignIn emits `wildcat-auth-signin`, so the app's roster refresh
   * happens through exactly the same path as an interactive sign-in.
   *
   * NO LONGER RUNS ON PAGE LOAD. It is now the first step of
   * signInWithMicrosoft(), so it only ever runs because a member of staff
   * pressed the staff button. See the shared Chromebook guard above for why
   * that move matters more than anything else in this file.
   */
  async function resumeSession(opts) {
    if (session) return session;
    if (!configured.entra()) return null;

    // The shared Chromebook guard. Both conditions are documented above; the
    // short version is that a page load is not a person and the student
    // entrance is not the staff entrance.
    //
    // BYPASSED when the caller passes { knownStaff: true }. That is only done on
    // boot, and only when the app has already restored a STAFF currentUser from
    // sessionStorage — proof that this same tab signed a staff member in. MSAL's
    // cache is per-tab sessionStorage, so there is no other person's session to
    // hand over: a genuinely new session has no cached account and the
    // acquireTokenSilent below simply returns null. Without this, a staff member
    // keeps their dashboard across a reload (currentUser survives) but loses the
    // Microsoft token, so every Convex write says "sign in" — the reported bug.
    const knownStaff = opts && opts.knownStaff === true;
    if (!knownStaff) {
      if (!staffSignInRequested) {
        console.debug('[wildcat-auth] not resuming: no staff sign-in was requested');
        return null;
      }
      if (!staffEntranceActive()) {
        console.debug('[wildcat-auth] not resuming: the student entrance is on screen');
        return null;
      }
    }

    try {
      const app = await entraClient();
      const accounts = app.getAllAccounts ? app.getAllAccounts() : [];
      if (!accounts.length) return null;

      const result = await app.acquireTokenSilent({
        account: accounts[0],
        scopes: ['openid', 'profile', 'email'],
      });
      if (!result || !result.idToken) return null;

      await finishSignIn(result.idToken, 'staff');
      console.log('[wildcat-auth] session resumed silently');
      return session;
    } catch (err) {
      // Expected whenever the token needs a real prompt. Logged at debug level
      // rather than as an error, because "nobody is signed in" is the normal
      // state of a login screen.
      console.debug('[wildcat-auth] no session to resume:', err && err.message);
      return null;
    }
  }

  /**
   * Runs on page load. If we came back from Microsoft carrying a code, finish
   * the sign-in; otherwise do nothing at all.
   *
   * Guarded on the fragment BEFORE entraClient() is touched, so a normal visit
   * never pays for loading MSAL and, more to the point, never runs a line of
   * Microsoft code. A fragment only exists here because somebody pressed the
   * staff button a moment ago and Microsoft sent them back, which is the one
   * page load that genuinely is a staff action in flight.
   */
  async function completeRedirectSignIn() {
    const hash = String(window.location.hash || '');
    if (!/[#&](code|error|id_token|access_token)=/.test(hash)) return;
    if (!configured.entra()) return;

    const errorEl = document.getElementById('entraSignInError');
    try {
      await entraClient();                      // processes the response
      if (!redirectResult || !redirectResult.idToken) return;

      const me = await finishSignIn(redirectResult.idToken, 'staff');

      // WAIT for the app to finish loading its roster before deciding a record
      // is missing. script.js fills `teachers` asynchronously from Firestore,
      // and on a redirect return this code runs first, so the array is still
      // empty. Reporting "no staff record" then is not a lookup failure, it is
      // a race, and it looked exactly like a real data problem.
      const target = (me.email || '').trim().toLowerCase();
      const teacher = await waitForTeacherRecord(target, undefined, redirectResult.idToken);

      if (!teacher) {
        throw new Error(
          `Signed in as ${target}, but no local staff record carries that ` +
          `email address. An admin needs to add it to your profile.`,
        );
      }
      await establishTeacherSession(teacher);
    } catch (err) {
      if (errorEl) errorEl.textContent = String((err && err.message) || err);
      console.error('[wildcat-auth] redirect sign-in failed:', err);
    } finally {
      // Strip the fragment either way, so a refresh does not replay a consumed
      // code and so the address bar is not left holding an auth artifact.
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
      }
    }
  }

  /**
   * MSAL records "an interaction is happening" in storage and refuses to start
   * another while it is set. A popup that dies before completing never clears
   * it, so the user is locked out of retrying by a flag rather than by
   * anything real. Clearing it is safe precisely because no interaction is
   * actually running: the popup is gone.
   */
  function clearStaleInteractionLock() {
    for (const store of [window.sessionStorage, window.localStorage]) {
      if (!store) continue;
      const doomed = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith('msal.') && k.includes('interaction.status')) doomed.push(k);
      }
      doomed.forEach((k) => store.removeItem(k));
    }
  }

  /**
   * Sign a teacher or IT admin in through the native OAuth flow.
   *
   * WHY THIS EXISTS. MSAL.js signs in by NAVIGATING to Microsoft and coming back
   * to `redirectUri`, which this file builds from `window.location.origin`.
   * Inside the app that origin is `capacitor://localhost`, which Entra will not
   * accept as a reply URL and could not reach anyway. So the whole redirect
   * dance is unavailable in the app, exactly as Google's script is.
   *
   * WHY IT MATTERS MORE THAN IT LOOKS. Programming a tag is a staff action, and
   * Core NFC WRITE on an iPhone is the one capability no browser on earth has.
   * Without staff sign-in in the app, a teacher holding an iPhone cannot make a
   * tag at all, and the ability to write tags was a large part of why this app
   * exists. Teachers here carry iPhones, Android phones and desktops; the other
   * two already work through the website.
   *
   * The same client id and the same scopes as the web flow on purpose. Convex
   * checks the token's `aud` against ENTRA_CLIENT_ID, so reusing the
   * registration keeps `convex/auth.config.ts` untouched. All that differs is
   * the doorway.
   */
  async function nativeStaffSignIn() {
    const SocialLogin = window.Capacitor.Plugins.SocialLogin;

    await SocialLogin.initialize({
      oauth2: {
        clientId: CONFIG.entra.clientId,
        // Discovery rather than hand-written endpoints, so a tenant or endpoint
        // change on Microsoft's side does not need a code change here.
        discoveryUrl:
          'https://login.microsoftonline.com/' + CONFIG.entra.tenantId +
          '/v2.0/.well-known/openid-configuration',
        // Must be registered on the Wildcat Hub app registration as a mobile
        // reply URL, or Entra refuses before the sheet even renders. The scheme
        // half is also registered in Info.plist by configure-ios.mjs; both are
        // required and neither is sufficient alone.
        redirectUrl: 'msauth.org.westbrookacademy.wildcat://auth',
        // Authorization code with PKCE. Entra requires PKCE for a public client,
        // and there is no secret in this app, nor should there ever be: the repo
        // is public.
        responseType: 'code',
        pkceEnabled: true,
        // 'email' explicitly, because the email claim is the join key. Without
        // the optional claim configured on the registration the token arrives
        // without it and Convex refuses with a clear message rather than
        // guessing at identity. Same reasoning as the web request below.
        scopes: ['openid', 'profile', 'email'],
        additionalParameters: { prompt: 'select_account' },
      },
    });

    const res = await SocialLogin.login({ provider: 'oauth2' });
    const idToken = res && res.result && res.result.idToken;
    if (!idToken) {
      throw new Error('Microsoft did not return a sign-in token. Try again.');
    }

    // Same measurement the student path takes, for the same reason: `aud` is the
    // only thing that decides whether Convex accepts this, and reading it once
    // on a real device beats reasoning about it.
    try {
      const claims = JSON.parse(
        decodeURIComponent(
          atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
            .split('')
            .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join(''),
        ),
      );
      emit('wildcat-auth-native-token-audience', {
        kind: 'staff',
        aud: claims.aud,
        matchesEntraClient: claims.aud === CONFIG.entra.clientId,
      });
    } catch (e) {
      /* diagnostic only; never block a sign-in on it */
    }

    await finishSignIn(idToken, 'staff');
  }

  async function signInStaff() {
    // In the app there is no redirect to make. Nothing after this returns.
    if (nativeSignInAvailable()) {
      return nativeStaffSignIn();
    }

    const app = await entraClient();
    // 'email' is requested explicitly because the join key is the email claim.
    // If the optional claim was not configured on the app registration, the
    // token arrives without it and Convex refuses with a clear message rather
    // than guessing at identity.
    const request = {
      scopes: ['openid', 'profile', 'email'],
      prompt: 'select_account',
    };

    // Navigates away. Nothing after this runs; the browser leaves the page and
    // comes back to redirectUri, where completeRedirectSignIn() picks it up.
    try {
      await app.loginRedirect(request);
    } catch (err) {
      const code = (err && (err.errorCode || err.message)) || '';
      if (!/interaction_in_progress/i.test(String(code))) throw err;
      clearStaleInteractionLock();
      await app.loginRedirect(request);
    }
    return new Promise(() => {});   // never resolves; the navigation takes over
  }

  // ---------------------------------------------------------------------
  // Students: Google Identity Services
  // ---------------------------------------------------------------------
  const GIS_CDN = 'https://accounts.google.com/gsi/client';

  /** Is this the native shell, with the native sign-in plugin actually present? */
  function nativeSignInAvailable() {
    return Boolean(
      window.WC_NATIVE &&
      window.Capacitor &&
      window.Capacitor.Plugins &&
      window.Capacitor.Plugins.SocialLogin,
    );
  }

  /**
   * Sign a student in through the native Google SDK.
   *
   * WHY THIS EXISTS AT ALL. Everything above this line is the web flow, and the
   * web flow cannot run inside the app. Google will not serve
   * accounts.google.com/gsi/client to a `capacitor://` origin, and iOS will not
   * let a locally served webview claim an https one. That is not a
   * configuration problem to be worked around; it is the platform. So in the app
   * the student signs in through the native SDK, which opens a real
   * ASWebAuthenticationSession that Google does permit, and hands back an ID
   * token in the same shape the web callback produces.
   *
   * finishSignIn is deliberately shared. Whatever the doorway, the token is
   * verified the same way, `me:get` decides who the person is, and the domain
   * check in identity.ts is still the thing that proves they belong to this
   * school. Nothing about the trust model changes here.
   */
  async function nativeStudentSignIn() {
    const SocialLogin = window.Capacitor.Plugins.SocialLogin;

    if (!CONFIG.google.iosClientId || CONFIG.google.iosClientId.endsWith('_PENDING')) {
      throw new Error(
        'This app has not been given its Google iOS sign-in ID yet. ' +
        'Tell the office, and use the website on a Chromebook until then.',
      );
    }

    await SocialLogin.initialize({
      google: {
        iOSClientId: CONFIG.google.iosClientId,
        // Both point at the WEB client on purpose. Google issues the ID token
        // audienced to the server client rather than the iOS one when it is
        // told there is a server, which is what keeps the token acceptable to
        // convex/auth.config.ts without a second provider entry. That behaviour
        // is asserted here and MEASURED below, because it decides whether the
        // backend needs changing and no amount of reading settles it.
        iOSServerClientId: CONFIG.google.clientId,
        webClientId: CONFIG.google.clientId,
      },
    });

    const res = await SocialLogin.login({
      provider: 'google',
      options: {
        scopes: ['email', 'profile'],
        ...(CONFIG.google.hostedDomain ? { hostedDomain: CONFIG.google.hostedDomain } : {}),
      },
    });

    const idToken = res && res.result && res.result.idToken;
    if (!idToken) {
      throw new Error('Google did not return a sign-in token. Try again.');
    }

    // THE MEASUREMENT. `aud` is the only thing that decides whether Convex will
    // accept this token, because auth.config.ts pins applicationID to one client
    // id. If this logs the iOS client rather than the web client, the fix is a
    // second Google entry in that file, NOT a change here. Read once, on the
    // first real device sign-in, then this can go.
    try {
      const claims = JSON.parse(
        decodeURIComponent(
          atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
            .split('')
            .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join(''),
        ),
      );
      emit('wildcat-auth-native-token-audience', {
        aud: claims.aud,
        azp: claims.azp,
        matchesWebClient: claims.aud === CONFIG.google.clientId,
      });
    } catch (e) {
      /* the decode is diagnostic only; never block a sign-in on it */
    }

    await finishSignIn(idToken, 'student');
  }

  async function initStudentButton(containerId) {
    if (!configured.google()) {
      throw new Error('Google is not configured yet. See docs/google-signin-setup.md');
    }

    // The app renders its own button, because Google's rendered button is part
    // of the script that will not load here.
    if (nativeSignInAvailable()) {
      const host = document.getElementById(containerId);
      if (host) {
        host.innerHTML =
          '<button type="button" id="wcNativeGoogleBtn" class="wc-native-google">' +
          'Sign in with Google</button>';
        const btn = document.getElementById('wcNativeGoogleBtn');
        if (btn) {
          btn.addEventListener('click', () => {
            btn.disabled = true;
            nativeStudentSignIn()
              .catch((err) => {
                emit('wildcat-auth-error', { kind: 'student', message: err.message });
              })
              .finally(() => { btn.disabled = false; });
          });
        }
      }
      return;
    }

    await loadScript(GIS_CDN);
    window.google.accounts.id.initialize({
      client_id: CONFIG.google.clientId,
      // `hd` is a UX hint that filters the account chooser. NOT a security
      // control: anyone can call the endpoint with a token from another domain,
      // which is why the domain is checked again server side on the verified
      // claims. It is omitted entirely when unset rather than passed as null,
      // because Westbrook students are on two domains and pinning either one
      // hides the other half's account. See the CONFIG comment.
      ...(CONFIG.google.hostedDomain ? { hd: CONFIG.google.hostedDomain } : {}),
      auto_select: false,
      // Use FedCM for the One Tap prompt. Beyond surviving the third-party
      // cookie shutdown, FedCM's prompt hands back the credential from the
      // session the student is ALREADY in on their Chromebook, without a fresh
      // interactive sign-in.
      use_fedcm_for_prompt: true,
      callback: (response) => {
        finishSignIn(response.credential, 'student').catch((err) => {
          emit('wildcat-auth-error', { kind: 'student', message: err.message });
        });
      },
    });
    const el = document.getElementById(containerId);
    if (el) {
      window.google.accounts.id.renderButton(el, {
        theme: 'outline',
        size: 'large',
        text: 'signin_with',
        width: 280,
      });
    }
    // WHY One Tap runs alongside the button. The rendered button starts a FRESH
    // sign-in (prompt=select_account). For a westbrookacademy.org account that
    // Google still has bound to the SAML profile, a fresh sign-in is exactly
    // what makes Google hand the student to Microsoft's SAML endpoint. One Tap
    // does the opposite: it returns an ID token from the session the student is
    // ALREADY signed into on their Chromebook, so there is no re-authentication
    // and therefore no SAML redirect. This is the same reason opening
    // accounts.google.com directly lands on the account instead of Microsoft.
    // The button stays as the manual fallback (e.g. no active session, or a
    // student who dismissed One Tap). auto_select is left false so a shared
    // Chromebook never signs in the previous student without a tap.
    try {
      window.google.accounts.id.prompt();
    } catch (e) {
      // Non-fatal: the button still works. One Tap can be unavailable (a recent
      // dismissal cooldown, an unsupported browser); the fallback covers it.
      console.warn('[wildcat-auth] One Tap prompt unavailable:', e && e.message);
    }
  }

  // ---------------------------------------------------------------------
  // Shared tail: hand the token to Convex and let it say who this is.
  // ---------------------------------------------------------------------

  /**
   * Note what is NOT here: any decision about staff vs student. This function
   * does not inspect the token, because a value the browser computed is a value
   * the browser can lie about. `expected` is used only to make a mismatch a
   * clear error instead of a confusing one.
   */
  async function finishSignIn(idToken, expected) {
    const me = await convexQuery('me:get', {}, idToken);

    if (me.kind !== expected) {
      throw new Error(
        `Signed in as ${me.kind}, but this is the ${expected} entrance.`,
      );
    }

    session = { idToken, me };

    // Persist a STUDENT token so a reload does not drop the session. Google gives
    // no silent token refresh the way MSAL does for staff, so the token itself is
    // stashed — in sessionStorage, which is same-origin and cleared when the tab
    // closes, so a shared Chromebook never hands it to the next student. Staff
    // restore through MSAL's own cache and need nothing here.
    try {
      if (me.kind === 'student' && window.sessionStorage) {
        window.sessionStorage.setItem('wc_student_idtoken', idToken);
      }
    } catch (e) { /* storage unavailable — the session just will not survive a reload */ }

    // Record that federated sign-in actually worked. The cutover script that
    // deletes the cleartext passwords refuses to run until enough distinct
    // staff appear in this table, so this is what unlocks the last step of the
    // migration. Best effort: a failure here must never break a sign-in that
    // has already succeeded.
    // Awaited, not fire-and-forget. This row is what unlocks the final step of
    // the migration, so a failure here needs to be loud rather than a warning
    // nobody reads. It still cannot fail the sign-in itself.
    try {
      await convexMutation('authEvents:record', {}, idToken);
      console.log('[wildcat-auth] sign-in recorded for', me.email);
    } catch (err) {
      console.error('[wildcat-auth] FAILED to record sign-in proof:', err && err.message);
      window.__wildcatAuthRecordError = String((err && err.message) || err);
    }

    emit('wildcat-auth-signin', me);
    return me;
  }

  let session = null;

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function clearStudentToken() {
    try {
      if (window.sessionStorage) window.sessionStorage.removeItem('wc_student_idtoken');
    } catch (e) { /* nothing to clear */ }
  }

  /**
   * Restore a student's session after a reload, from the token stashed at
   * sign-in. Convex re-verifies the token (signature AND expiry) inside me:get,
   * so an expired or tampered token is simply refused here and the app falls
   * back to the login screen — this is why storing the token is safe: it is not
   * trusted, it is re-checked. Only ever resumes a STUDENT; a token that comes
   * back as anything else is dropped.
   */
  async function resumeStudentSession() {
    if (session) return session;
    let token = null;
    try {
      token = window.sessionStorage && window.sessionStorage.getItem('wc_student_idtoken');
    } catch (e) { token = null; }
    if (!token) return null;
    try {
      const me = await convexQuery('me:get', {}, token);
      if (me.kind !== 'student') { clearStudentToken(); return null; }
      session = { idToken: token, me };
      emit('wildcat-auth-signin', me);
      return session;
    } catch (e) {
      // Expired or invalid — drop it so the app shows login instead of retrying
      // a token that will never work again.
      clearStudentToken();
      return null;
    }
  }

  function signOut() {
    // Captured before it is cleared, so the app can put the login screen back
    // on the tab the person actually came in through. A student who signs out
    // and is handed the Teacher tab is looking at a "Sign in with Microsoft"
    // button, which is the screen the owner saw and reported.
    const kind = (session && session.me && session.me.kind) || null;

    session = null;
    clearStudentToken();
    if (window.google && window.google.accounts && window.google.accounts.id) {
      window.google.accounts.id.disableAutoSelect();
    }
    if (msalApp) {
      const account = msalApp.getAllAccounts()[0];
      if (account) msalApp.logoutPopup({ account }).catch(() => {});
    }
    // Whether or not MSAL was ever loaded in this page view, leave nothing
    // behind that acquireTokenSilent could pick up. A sign-out that leaves a
    // resumable staff account in storage is the shared Chromebook problem
    // wearing a different hat.
    forgetCachedStaffAccount();

    emit('wildcat-auth-signout', { kind });
  }

  /**
   * Everything that happens once Convex has said "this token is staff".
   *
   * Match the app's own record by normalized email. Convex has already
   * confirmed the identity; this is only finding the local row that holds
   * role, sections and ticket counts.
   *
   * Hands off to establishTeacherSession(), the same function the password
   * form calls once it has checked a password. One session path, so the two
   * cannot drift apart. Shared by the resumed and the interactive routes for
   * the same reason.
   */
  async function adoptStaffRecord(me) {
    const target = (me.email || '').trim().toLowerCase();

    // THROUGH waitForTeacherRecord, not a bare find. This searched `teachers`
    // once and threw if it missed, which on a cold load reads a stale
    // localStorage roster and rejects staff who are in Convex but were added
    // after this machine last cached one. Same fault as the redirect path had;
    // fixing one and not the other would leave the bug alive on the resumed
    // session route.
    const teacher = await waitForTeacherRecord(
      target, undefined, (session || {}).idToken);

    if (!teacher) {
      throw new Error(
        `Signed in as ${target}, but no local staff record carries that ` +
        `email address. An admin needs to add it to your profile.`,
      );
    }

    await establishTeacherSession(teacher);
  }

  /**
   * The button handler on the staff login screen.
   *
   * Order matters here. Convex verifies the Microsoft token FIRST and tells us
   * the email; only then do we look for a local record. Doing it the other way
   * round, matching a record before the token is verified, would let anyone who
   * knows a teacher's address in as that teacher.
   *
   * This is also the ONLY place that unlocks silent resumption, and it is
   * where the convenience that used to run on page load now lives: a teacher
   * coming back to a tab that still holds their cached account presses this
   * once and is in, with no round trip to login.microsoftonline.com. A student
   * who never presses it never loads a byte of Microsoft SDK.
   */
  async function signInWithMicrosoft() {
    const errorEl = document.getElementById('entraSignInError');
    const btn = document.getElementById('entraSignInBtn');
    const setError = (msg) => { if (errorEl) errorEl.textContent = msg; };

    setError('');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }

    // A person pressed the staff button. Nothing else in this file may set
    // this, and page load in particular cannot.
    staffSignInRequested = true;

    try {
      // The cached account first. resumeSession() re-checks the guard itself,
      // so this is a no-op on a device that has passed to a student.
      const resumed = await resumeSession();
      if (resumed) {
        await adoptStaffRecord(resumed.me);
        return;
      }

      const me = await signInStaff();          // throws unless Convex says staff
      await adoptStaffRecord(me);
    } catch (err) {
      // Popup dismissal is a normal thing a person does, not an error worth
      // shouting about.
      const msg = String((err && err.message) || err);
      if (/user_cancelled|popup_window_error|user_closed/i.test(msg)) {
        setError('');
      } else {
        setError(msg);
        console.error('[wildcat-auth] staff sign-in failed:', err);
      }
    } finally {
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
    }
  }

  window.signInWithMicrosoft = signInWithMicrosoft;

  /**
   * Student side of the same pattern: Convex verifies the Google token first
   * and returns the email, then the local record is looked up. Never the other
   * way round, or knowing a classmate's address would be enough to become them.
   *
   * Until PowerSchool manifest field 19 (Student Email) lands, no student
   * record carries an email, so the expected outcome here is a clear
   * "no record matches" rather than a successful sign-in.
   */
  window.addEventListener('wildcat-auth-signin', function (ev) {
    const me = ev.detail;
    if (!me || me.kind !== 'student') return;

    // This device has demonstrably passed to a student. Drop whatever
    // Microsoft account the last teacher left cached on it, so there is
    // nothing here for a later silent resume, or a stray press of the
    // Microsoft button, to restore. Done with storage keys rather than an
    // MSAL call: the student path must not load the Microsoft SDK, and
    // calling into MSAL to forget Microsoft would load it.
    forgetCachedStaffAccount();

    const errorEl = document.getElementById('googleSignInError');
    const target = (me.email || '').trim().toLowerCase();
    const student =
      typeof students !== 'undefined' &&
      students.find((s) => (s.email || '').trim().toLowerCase() === target);

    if (!student) {
      // A failed student sign-in must land back on the Student tab, for the
      // same reason as the error handler below: the login screen defaults to
      // Teacher, and a student should never be handed a Microsoft button.
      const login = document.getElementById('loginScreen');
      if (login && login.classList) login.classList.remove('hidden');
      if (typeof window.showStudentLogin === 'function') window.showStudentLogin();

      if (errorEl) {
        errorEl.textContent =
          `Signed in as ${target}, but no student record is linked to that ` +
          `address yet. Student accounts are still being connected.`;
      }
      return;
    }
    if (errorEl) errorEl.textContent = '';

    // Opens the student PORTAL. This used to call establishStudentSession(),
    // which revealed the legacy #studentDashboard and hid #loginScreen. The
    // pass cards were a child of #loginScreen, so this line was what blanked
    // them and put a white card that looks like a login screen in their place.
    // It only bit once the Convex roster refresh had landed and given the
    // students array real email addresses, which is why it presented as an
    // intermittent "dropped back to login" rather than a plain bug.
    //
    // openStudentPortal is defined in script.js, which loads after this file
    // but always before a person can click a sign in button.
    if (typeof window.openStudentPortal === 'function') {
      window.openStudentPortal(student);
    } else if (typeof establishStudentSession === 'function') {
      establishStudentSession(student);
    }
  });

  window.addEventListener('wildcat-auth-error', function (ev) {
    const d = ev.detail || {};
    if (d.kind !== 'student') return;

    // Put the student back at the STUDENT entrance to read the message. The
    // login screen defaults to the Teacher tab, so a failure that only wrote
    // an error string could leave a student looking at a screen whose main
    // button says "Sign in with Microsoft", with their own error hidden on the
    // tab behind it. The message and the button it belongs to have to be on
    // screen together.
    const login = document.getElementById('loginScreen');
    if (login && login.classList) login.classList.remove('hidden');
    if (typeof window.showStudentLogin === 'function') window.showStudentLogin();

    const el = document.getElementById('googleSignInError');
    if (el) el.textContent = d.message || 'Sign-in failed.';
  });

  /**
   * Render the Google button exactly once. Idempotent: the flag guards against
   * the eager-on-load path and a later tab click both firing.
   *
   * The Student tab is now the DEFAULT view, so the button is rendered eagerly
   * on page load (see onReady) — pulling Google's SDK immediately is correct
   * when the student entrance is what everyone lands on. The lazy click below
   * only covers the teacher-then-switches-to-student case, where the eager
   * render was skipped because the teacher form was showing.
   */
  let studentButtonRendered = false;
  function renderStudentButton() {
    if (studentButtonRendered || !configured.google()) return;
    studentButtonRendered = true;
    initStudentButton('googleSignInButton').catch(function (err) {
      studentButtonRendered = false; // let a retry (tab click) try again
      const el = document.getElementById('googleSignInError');
      if (el) el.textContent = err.message;
      console.error('[wildcat-auth] Google button failed to render:', err);
    });
  }

  function wireStudentButtonLazily() {
    const tab = document.getElementById('studentLoginBtn');
    if (!tab) return;
    tab.addEventListener('click', renderStudentButton);
  }

  // True only when the student login is the one actually on screen. Used to
  // decide whether to render Google eagerly on load: the default is now the
  // student tab, but a returning teacher's tab state must still be honoured.
  function studentFormVisible() {
    const f = document.getElementById('studentLoginForm');
    // classList is guarded, not assumed: this runs at boot inside onReady, before
    // the rest of the app has touched the DOM, and a stub or a half-built element
    // with no classList must make this answer "not visible" rather than throw and
    // take the whole sign-in bootstrap down with it.
    return !!(f && f.classList && !f.classList.contains('hidden'));
  }

  function onReady() {
    wireStudentButtonLazily();
    // Eager render when the student entrance is the visible default, so a
    // student never sees an empty box waiting on a click that a teacher's tab
    // used to require.
    if (studentFormVisible()) renderStudentButton();
    // script.js defines establishTeacherSession and the teachers array, and it
    // loads AFTER this file. Defer to the end of the task queue so both exist
    // by the time the redirect is processed.
    setTimeout(function () {
      // resumeSession() USED TO RUN HERE, on every page load, for everyone.
      // That single line is what loaded 270KB of Microsoft SDK into every
      // student's browser and, far worse, handed a student the previous
      // teacher's session on a shared Chromebook without a click. It is gone
      // on purpose. Silent resumption now happens inside signInWithMicrosoft(),
      // where a member of staff has actually asked for it, and the guard on
      // resumeSession() refuses even if this call ever comes back.
      //
      // completeRedirectSignIn stays, and still touches nothing unless the URL
      // carries a redirect response. That fragment only exists because
      // somebody pressed the Microsoft button moments ago, so it is the one
      // page load that genuinely is a staff action already in flight.
      completeRedirectSignIn().catch(function (err) {
        console.error('[wildcat-auth] redirect completion error:', err);
      });
    }, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }

  window.WildcatAuth = {
    CONFIG,
    configured,
    signInWithMicrosoft,
    resumeSession,
    resumeStudentSession,
    signInStaff,
    initStudentButton,
    nativeSignInAvailable,
    nativeStaffSignIn,
    renderStudentButton,
    signOut,
    staffEntranceActive,
    forgetCachedStaffAccount,
    convexQuery,
    convexMutation,
    getSession: () => session,
    /** Console preflight: what is wired up and what is still missing. */
    status: () => ({
      convexUrl: CONFIG.convexUrl,
      entraConfigured: configured.entra(),
      googleConfigured: configured.google(),
      signedInAs: session ? session.me.kind : null,
      // The acceptance check for the student entrance. `msalLoaded` must be
      // false on any page where only the Student tab has been opened: it is
      // the observable form of "Microsoft does not exist on the student path".
      msalLoaded: typeof window.msal === 'object' && window.msal !== null,
      staffSignInRequested,
      staffEntranceActive: staffEntranceActive(),
    }),
  };
})();
