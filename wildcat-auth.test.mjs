// Tests for the browser sign-in transport. Run: npm test
//
// The case that matters most: Convex answers HTTP 200 with {status:"error"}
// when a function throws. Code that only checks res.ok therefore treats
// "Staff only." as a successful sign-in and lets the user through.
import fs from "node:fs";

const src = fs.readFileSync(new URL("./wildcat-auth.js", import.meta.url), "utf8");
const calls = [];
globalThis.window = { location: { origin: "https://wildcatraffle.com" }, dispatchEvent() {} };
globalThis.document = {
  querySelector: () => null, createElement: () => ({}),
  head: { appendChild() {} }, getElementById: () => null,
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

console.log("\nConfig gating: refuses clearly while unconfigured");
check("entra reports unconfigured", A.configured.entra() === false);
check("google reports unconfigured", A.configured.google() === false);
threw = null;
try { await A.signInStaff(); } catch (e) { threw = e.message; }
check("signInStaff points at its setup doc", /entra-signin-setup/.test(threw));
threw = null;
try { await A.initStudentButton("x"); } catch (e) { threw = e.message; }
check("student button points at its setup doc", /google-signin-setup/.test(threw));
check("status() reports what is missing", !A.status().entraConfigured && !A.status().googleConfigured);
check("convexUrl points at the real deployment", A.status().convexUrl.includes("quick-cassowary-644"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
