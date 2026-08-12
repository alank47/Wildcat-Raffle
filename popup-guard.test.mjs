// If this file runs inside an auth popup, MSAL is being asked to open a popup
// from within a popup and fails with block_nested_popups.
//
// That happened for real. The redirect target is auth-redirect.html, but the
// bare origin is also a registered redirect URI, and a browser holding a cached
// index.html keeps using the OLD redirect until that cache expires. The popup
// then loaded the whole app, this file ran inside it, and sign-in dead-ended.
//
// The guard: when we are clearly an auth landing (opened by another window AND
// carrying an auth fragment), do nothing. The opener reads the fragment off the
// URL; it never needed us to run.
import fs from "node:fs";

const src = fs.readFileSync(new URL("./wildcat-auth.js", import.meta.url), "utf8");

/** Loads wildcat-auth.js under a simulated window; true if it initialized. */
function initializesUnder({ hash, opener }) {
  const w = {
    location: { origin: "https://wildcatraffle.com", hash },
    addEventListener() {}, dispatchEvent() {},
    sessionStorage: null, localStorage: null,
  };
  w.opener = opener === undefined ? undefined : opener === "self" ? w : {};
  globalThis.window = w;
  globalThis.document = {
    readyState: "complete", querySelector: () => null, createElement: () => ({}),
    head: { appendChild() {} }, addEventListener() {}, getElementById: () => null,
  };
  globalThis.CustomEvent = class { constructor(n, o) { this.detail = o && o.detail; } };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "success", value: {} }) });
  new Function(src)();
  return Boolean(w.WildcatAuth);
}

let pass = 0, fail = 0;
const check = (l, c) => { c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l}`)); };

console.log("\nAuth-popup landing guard");
check("normal page load initializes", initializesUnder({ hash: "", opener: undefined }) === true);
check("popup with #code does NOT initialize", initializesUnder({ hash: "#code=1.AVoAbc", opener: {} }) === false);
check("popup with #error does NOT initialize", initializesUnder({ hash: "#error=access_denied", opener: {} }) === false);
check("popup with #id_token does NOT initialize", initializesUnder({ hash: "#id_token=xyz", opener: {} }) === false);

console.log("\nAnd does not over-trigger");
check("popup with a non-auth fragment still initializes", initializesUnder({ hash: "#dashboard", opener: {} }) === true);
check("main window with #code still initializes", initializesUnder({ hash: "#code=abc", opener: undefined }) === true);
check("opener === self is not a popup, still initializes", initializesUnder({ hash: "#code=abc", opener: "self" }) === true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
