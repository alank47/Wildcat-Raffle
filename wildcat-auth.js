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
  // CONFIG. All four values are public: they ship in the page and appear in
  // every token. The Entra client SECRET and the Google client SECRET are NOT
  // used by these flows and must never appear here. This repo is public.
  // ---------------------------------------------------------------------
  const CONFIG = {
    convexUrl: 'https://quick-cassowary-644.convex.cloud',

    entra: {
      clientId: '65fe084a-1eb2-4fed-8df8-8607f8c4c225',  // Application (client) ID
      tenantId: 'afc1d09c-9f9b-4d45-9643-198f7dc264c4',  // Directory (tenant) ID
    },

    google: {
      clientId: '718452352756-cclr7dbvucal375vrj5m9fg25fn3eh3s.apps.googleusercontent.com',
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

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(el);
    });
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

  async function entraClient() {
    if (msalApp) return msalApp;
    if (!configured.entra()) {
      throw new Error('Entra is not configured yet. See docs/entra-signin-setup.md');
    }
    await loadScript(MSAL_CDN);
    msalApp = new window.msal.PublicClientApplication({
      auth: {
        clientId: CONFIG.entra.clientId,
        authority: `https://login.microsoftonline.com/${CONFIG.entra.tenantId}`,
        redirectUri: window.location.origin,
      },
      cache: { cacheLocation: 'sessionStorage' },
    });
    if (msalApp.initialize) await msalApp.initialize();
    return msalApp;
  }

  async function signInStaff() {
    const app = await entraClient();
    // 'email' is requested explicitly because the join key is the email claim.
    // If the optional claim was not configured on the app registration, the
    // token arrives without it and Convex refuses with a clear message rather
    // than guessing at identity.
    const result = await app.loginPopup({
      scopes: ['openid', 'profile', 'email'],
      prompt: 'select_account',
    });
    if (!result || !result.idToken) throw new Error('Entra returned no ID token.');
    return finishSignIn(result.idToken, 'staff');
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
      // A UX hint that picks the account chooser. NOT a security control:
      // anyone can call the endpoint with a token from another domain, which is
      // why the domain is checked again server side on the verified claims.
      hd: CONFIG.google.hostedDomain,
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
    establishStudentSession(student);
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireStudentButtonLazily);
  } else {
    wireStudentButtonLazily();
  }

  window.WildcatAuth = {
    CONFIG,
    configured,
    signInWithMicrosoft,
    signInStaff,
    initStudentButton,
    signOut,
    convexQuery,
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
