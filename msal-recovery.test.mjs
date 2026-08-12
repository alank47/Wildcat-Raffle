// MSAL sets an "interaction in progress" flag in storage while a sign-in is
// running and refuses to start another while it is set. A sign-in that dies
// before completing never clears it, so every later attempt fails with
// interaction_in_progress and the user is locked out by a leftover flag rather
// than by anything real.
//
// This happened for real, in the popup flow: an AADSTS50011 failure left the
// lock set and the next click could not start at all. The flow is now redirect
// based, but the lock and the failure mode are the same, so the recovery still
// matters and is still tested.
import fs from "node:fs";

const src = fs.readFileSync(new URL("./wildcat-auth.js", import.meta.url), "utf8");

function mkStore(seed) {
  const m = { ...seed };
  return {
    get length() { return Object.keys(m).length; },
    key: (i) => Object.keys(m)[i],
    removeItem: (k) => { delete m[k]; },
    getItem: (k) => m[k] ?? null,
    setItem: (k, v) => { m[k] = v; },
    _m: m,
  };
}

const ss = mkStore({
  "msal.0f22dd11.interaction.status": "interaction_in_progress",
  "msal.0f22dd11.some.token": "KEEP-ME",
  "unrelated.key": "KEEP-ME",
});
const ls = mkStore({ "msal.old-client.interaction.status": "interaction_in_progress" });

let signInCalls = 0;
globalThis.window = {
  location: { origin: "https://wildcatraffle.com" },
  addEventListener() {}, dispatchEvent() {},
  sessionStorage: ss, localStorage: ls,
  msal: {
    PublicClientApplication: class {
      async initialize() {}
      async handleRedirectPromise() { return null; }
      async loginRedirect() {
        signInCalls++;
        if (signInCalls === 1) {
          const e = new Error("interaction_in_progress");
          e.errorCode = "interaction_in_progress";
          throw e;
        }
        return undefined;   // a real redirect navigates away and returns nothing
      }
      getAllAccounts() { return []; }
    },
  },
};
globalThis.document = {
  readyState: "complete", querySelector: () => ({}), createElement: () => ({}),
  head: { appendChild() {} }, addEventListener() {},
  getElementById: () => ({ textContent: "", addEventListener() {}, style: {} }),
};
globalThis.CustomEvent = class { constructor(n, o) { this.type = n; this.detail = o && o.detail; } };
globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ status: "success", value: { kind: "staff", email: "a@b.c" } }),
});

new Function(src)();

let pass = 0, fail = 0;
const check = (l, c) => { c ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l}`)); };

console.log("\nRecovery from a stale interaction lock");
// signInStaff never resolves in redirect flow: the browser leaves the page.
// Race it against a tick so the test can assert on what happened before that.
await Promise.race([
  window.WildcatAuth.signInStaff(),
  new Promise((r) => setTimeout(r, 50)),
]);
check("retries exactly once, never loops", signInCalls === 2);
check("clears the stale sessionStorage lock", !("msal.0f22dd11.interaction.status" in ss._m));
check("clears the stale localStorage lock", !("msal.old-client.interaction.status" in ls._m));
check("leaves other msal keys alone (tokens survive)", ss._m["msal.0f22dd11.some.token"] === "KEEP-ME");
check("leaves unrelated keys alone", ss._m["unrelated.key"] === "KEEP-ME");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
