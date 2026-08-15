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
  async function waitForTeacherRecord(normalizedEmail, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 20000);
    for (;;) {
      if (typeof teachers !== 'undefined' && Array.isArray(teachers) && teachers.length) {
        const hit = teachers.find(function (t) {
          return (t.email || '').trim().toLowerCase() === normalizedEmail;
        });
        if (hit) return hit;
        // Roster is loaded and the address genuinely is not in it.
        return null;
      }
      if (Date.now() > deadline) return null;
      await new Promise(function (r) { setTimeout(r, 200); });
    }
  }

  /**
   * Runs on page load. If we came back from Microsoft carrying a code, finish
   * the sign-in; otherwise do nothing at all.
   *
   * Guarded on the fragment so a normal visit never pays for loading MSAL:
   * every teacher who signs in with a password, and every student, would
   * otherwise download ~270KB of SDK for nothing.
   */
  /**
   * Re-establish the session on a normal page load, without asking the user.
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
   */
  async function resumeSession() {
    if (session) return session;
    if (!configured.entra()) return null;
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
      const teacher = await waitForTeacherRecord(target);

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

  async function signInStaff() {
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

  async function initStudentButton(containerId) {
    if (!configured.google()) {
      throw new Error('Google is not configured yet. See docs/google-signin-setup.md');
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

  function signOut() {
    session = null;
    if (window.google && window.google.accounts && window.google.accounts.id) {
      window.google.accounts.id.disableAutoSelect();
    }
    if (msalApp) {
      const account = msalApp.getAllAccounts()[0];
      if (account) msalApp.logoutPopup({ account }).catch(() => {});
    }
    emit('wildcat-auth-signout', {});
  }

  /**
   * The button handler on the staff login screen.
   *
   * Order matters here. Convex verifies the Microsoft token FIRST and tells us
   * the email; only then do we look for a local record. Doing it the other way
   * round, matching a record before the token is verified, would let anyone who
   * knows a teacher's address in as that teacher.
   *
   * Hands off to establishTeacherSession(), the same function the password form
   * calls once it has checked a password. One session path, so the two cannot
   * drift apart.
   */
  async function signInWithMicrosoft() {
    const errorEl = document.getElementById('entraSignInError');
    const btn = document.getElementById('entraSignInBtn');
    const setError = (msg) => { if (errorEl) errorEl.textContent = msg; };

    setError('');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }

    try {
      const me = await signInStaff();          // throws unless Convex says staff

      // Match the app's own record by normalized email. Convex has already
      // confirmed the identity; this is only finding the local row that holds
      // role, sections and ticket counts.
      const target = (me.email || '').trim().toLowerCase();
      const teacher =
        typeof teachers !== 'undefined' &&
        teachers.find((t) => (t.email || '').trim().toLowerCase() === target);

      if (!teacher) {
        // Expected for most staff right now: 39 of 40 records have no email,
        // so there is nothing to match even though the sign-in itself worked.
        throw new Error(
          `Signed in as ${target}, but no local staff record carries that ` +
          `email address. An admin needs to add it to your profile.`,
        );
      }

      await establishTeacherSession(teacher);
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

    const errorEl = document.getElementById('googleSignInError');
    const target = (me.email || '').trim().toLowerCase();
    const student =
      typeof students !== 'undefined' &&
      students.find((s) => (s.email || '').trim().toLowerCase() === target);

    if (!student) {
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
    const el = document.getElementById('googleSignInError');
    if (el) el.textContent = d.message || 'Sign-in failed.';
  });

  /**
   * Render the Google button lazily, the first time someone opens the Student
   * tab. Doing it on page load would pull Google's SDK for every teacher who
   * never touches the student side.
   */
  function wireStudentButtonLazily() {
    const tab = document.getElementById('studentLoginBtn');
    if (!tab) return;
    let done = false;
    tab.addEventListener('click', function () {
      if (done || !configured.google()) return;
      done = true;
      initStudentButton('googleSignInButton').catch(function (err) {
        const el = document.getElementById('googleSignInError');
        if (el) el.textContent = err.message;
        console.error('[wildcat-auth] Google button failed to render:', err);
      });
    });
  }

  function onReady() {
    wireStudentButtonLazily();
    // script.js defines establishTeacherSession and the teachers array, and it
    // loads AFTER this file. Defer to the end of the task queue so both exist
    // by the time the redirect is processed.
    setTimeout(function () {
      // Resume first: on a normal load there is no redirect hash and this is
      // the only thing that re-establishes the session. On a redirect return it
      // is a cheap no-op, because completeRedirectSignIn sets `session` and
      // resumeSession returns early when one already exists.
      resumeSession().catch(function () { /* silent by design */ });

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
    signInStaff,
    initStudentButton,
    signOut,
    convexQuery,
    convexMutation,
    getSession: () => session,
    /** Console preflight: what is wired up and what is still missing. */
    status: () => ({
      convexUrl: CONFIG.convexUrl,
      entraConfigured: configured.entra(),
      googleConfigured: configured.google(),
      signedInAs: session ? session.me.kind : null,
    }),
  };
})();
