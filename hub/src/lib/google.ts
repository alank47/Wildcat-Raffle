/**
 * Google Identity Services, the account students already have on their
 * Chromebooks.
 *
 * The four public values here are the same ones wildcat-auth.js ships: they
 * appear in every token and in the page source. The client SECRET is not part of
 * this flow and must never enter this repo.
 *
 * `hd` is a UX hint that filters the account chooser on a shared Chromebook with
 * several accounts signed in. It is NOT a security control — anyone can post a
 * token from another domain — and the real check is server side in
 * identityRules.ts against the verified claims.
 *
 * AUTHORIZED JS ORIGINS: http://localhost:8000, http://127.0.0.1:8000,
 * https://wildcatraffle.com and the Pages origin. Vite's dev server on :5173 is
 * NOT one of them and will fail with origin_mismatch — build and serve on 8000
 * to test signed in.
 */

export const GOOGLE_CLIENT_ID =
  "718452352756-cclr7dbvucal375vrj5m9fg25fn3eh3s.apps.googleusercontent.com";
export const HOSTED_DOMAIN = "westbrookacademy.org";
const GIS_CDN = "https://accounts.google.com/gsi/client";

type GoogleId = {
  initialize: (opts: Record<string, unknown>) => void;
  renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
  disableAutoSelect: () => void;
  prompt: () => void;
};

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleId } };
  }
}

/**
 * One promise per URL, resolved when the script has EXECUTED.
 *
 * Not "when a tag with this src exists": a tag exists the instant it is
 * appended, long before the script has arrived, and the second caller was then
 * told "loaded" while window.google was still undefined. That race is written up
 * at wildcat-auth.js:141 and it is the same race here.
 */
let gisLoad: Promise<void> | null = null;

export function loadGis(): Promise<void> {
  if (gisLoad) return gisLoad;

  const p = new Promise<void>((resolve, reject) => {
    const fail = () =>
      reject(
        new Error(
          "Google sign-in could not be loaded. If you are offline or the " +
            "school network blocks accounts.google.com, this will not work.",
        ),
      );

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GIS_CDN}"]`,
    );
    if (existing) {
      if (existing.dataset.wcLoaded === "true") return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", fail);
      return;
    }

    const el = document.createElement("script");
    el.src = GIS_CDN;
    el.async = true;
    el.onload = () => {
      el.dataset.wcLoaded = "true";
      resolve();
    };
    el.onerror = fail;
    document.head.appendChild(el);
  });

  // A failed load must not be cached, or one flaky download poisons every retry
  // for the life of the page.
  p.catch(() => {
    gisLoad = null;
  });
  gisLoad = p;
  return p;
}

let initialized = false;

/** Renders Google's own button into `el`. `onCredential` gets the JWT. */
export async function mountGoogleButton(
  el: HTMLElement,
  onCredential: (credential: string) => void,
): Promise<void> {
  await loadGis();
  const id = window.google?.accounts?.id;
  if (!id) throw new Error("Google sign-in loaded but did not start.");

  // initialize() is global and must run once; the callback is re-pointed via a
  // ref held by the caller rather than by re-initializing.
  if (!initialized) {
    id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      hd: HOSTED_DOMAIN,
      auto_select: false,
      callback: (response: { credential?: string }) => {
        if (response?.credential) currentCallback?.(response.credential);
      },
    });
    initialized = true;
  }
  currentCallback = onCredential;

  el.innerHTML = "";
  id.renderButton(el, {
    theme: "filled_blue",
    size: "large",
    shape: "pill",
    text: "signin_with",
    logo_alignment: "left",
    width: 280,
  });
}

let currentCallback: ((credential: string) => void) | null = null;

export function googleSignOut(): void {
  window.google?.accounts?.id?.disableAutoSelect();
}

/**
 * The JWT's `exp`, so a token that expired while the laptop lid was shut is
 * discarded on the client instead of producing a bare "Not authenticated" on
 * every panel at once. Signature is NOT checked here and must not be: the only
 * verification that counts happens server side.
 */
export function tokenExpiry(jwt: string): number | null {
  try {
    const payload = JSON.parse(
      atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
