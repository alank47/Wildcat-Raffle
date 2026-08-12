// Tests for the browser sign-in transport. Run: npm test
//
// The case that matters most: Convex answers HTTP 200 with {status:"error"}
// when a function throws. Code that only checks res.ok therefore treats
// "Staff only." as a successful sign-in and lets the user through.
import fs from "node:fs";

const src = fs.readFileSync(new URL("./wildcat-auth.js", import.meta.url), "utf8");
const calls = [];
const els = {};
const listeners = {};
globalThis.window = {
  location: { origin: "https://wildcatraffle.com" },
  addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); },
  dispatchEvent: (e) => { (listeners[e.type] || []).forEach((f) => f(e)); },
};
globalThis.document = {
  readyState: "complete",
  querySelector: () => null,
  createElement: () => ({}),
  head: { appendChild() {} },
  addEventListener() {},
  getElementById: (id) =>
    els[id] || (els[id] = { id, textContent: "", addEventListener() {}, style: {} }),
};
globalThis.CustomEvent = class { constructor(n, o) { this.type = n; this.detail = o && o.detail; } };
globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return globalThis.__next; };
new Function(src)();
const A = window.WildcatAuth;

let pass = 0, fail = 0;
const check = (l, c) => { c ? (pass++, console.log("  PASS  " + l)) : (fail++, console.log("  FAIL  " + l)); };

console.log("\nConvex transport");
globalThis.__next = { ok: true, status: 200, json: async () => ({ status: "error", errorMessage: "Staff only." }) };
let threw = null;
try { await A.convexQuery("me:get", {}, "tok"); } catch (e) { threw = e.message; }
check("HTTP 200 + {status:error} is a FAILURE, not a successful sign-in", threw === "Staff only.");

globalThis.__next = { ok: true, status: 200, json: async () => ({ status: "success", value: { kind: "staff" } }) };
const ok = await A.convexQuery("me:get", {}, "tok");
check("success unwraps .value", ok && ok.kind === "staff");
check("Authorization: Bearer is attached", calls[1].opts.headers.Authorization === "Bearer tok");

globalThis.__next = { ok: false, status: 401, json: async () => ({}) };
threw = null;
try { await A.convexQuery("me:get", {}, "t"); } catch (e) { threw = e.message; }
check("non-2xx surfaces as an error", /401/.test(threw));

console.log("\nConfig");
check("entra is configured (tenant + client id present)", A.configured.entra() === true);
check("google is configured (client id present)", A.configured.google() === true);
check("convexUrl points at the real deployment", A.status().convexUrl.includes("quick-cassowary-644"));
// `hd` is deliberately UNSET. Westbrook students are on two domains
// (@westbrookacademy.org and @rwwnms.org, the latter carried up from Russell
// Westbrook Why Not? Middle School), and `hd` pins the account chooser to one
// workspace, hiding the other half's account. It was never a security control:
// the real check is server side in convex/identityRules.ts against
// STUDENT_DOMAINS. Asserting it stays unset, because setting it again would
// silently lock out real students.
check("google hosted domain is NOT pinned to one domain", !A.CONFIG.google.hostedDomain);
check(
  "no client SECRET is present anywhere in config",
  !JSON.stringify(A.CONFIG).toLowerCase().includes("secret"),
);

console.log("\nConfig gating: refuses clearly when a provider is NOT configured");
{
  const saved = A.CONFIG.google.clientId;
  A.CONFIG.google.clientId = null;
  check("google reports unconfigured once its id is removed", A.configured.google() === false);
  let threw = null;
  try { await A.initStudentButton("x"); } catch (e) { threw = e.message; }
  check("student button points at its setup doc", /google-signin-setup/.test(threw));
  A.CONFIG.google.clientId = saved;
  check("restored", A.configured.google() === true);
}

console.log("\nStudent sign-in bridge");
{
  const fire = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }));
  const err = () => document.getElementById("googleSignInError").textContent;

  fire("wildcat-auth-signin", { kind: "student", email: "AR11414@WestbrookAcademy.org" });
  check("unmatched student -> clear message, no crash", /no student record is linked/.test(err()));
  check("message echoes the NORMALIZED address", err().includes("ar11414@westbrookacademy.org"));

  document.getElementById("googleSignInError").textContent = "";
  fire("wildcat-auth-signin", { kind: "staff", email: "x@lapromisefund.org" });
  check("a staff sign-in is ignored by the student handler", err() === "");

  fire("wildcat-auth-error", { kind: "student", message: "popup blocked" });
  check("student errors surface to the UI", err() === "popup blocked");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
