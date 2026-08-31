// Every server function has a caller, and every call names a real function.
// Run: npm test
//
// THE BUG CLASS THIS EXISTS FOR, which has now shipped three times.
//
// The seam between this app and Convex is two strings — 'module:function' in a
// browser file, `export const function` in a TypeScript one — and nothing
// checks that they meet. Nothing type-checks it, because script.js is a 27k
// line file with no build step; nothing tests it, because a unit test of a
// server rule passes whether or not a screen calls the rule.
//
// So a feature can be complete on both sides and joined on neither, and it
// looks EXACTLY like a working feature from every angle a test used to look:
//
//   - Four Claw Pass screens read `hallPasses`, the pre-Convex array in the
//     browser, for months after the kiosk that filled it was deleted. Each
//     rendered without error, on an empty array. (PR #12)
//   - `studentDetail:setPassLimit`, the mutation behind Set Pass Limit, had
//     twenty-one passing tests and no caller at all. A teacher could set a cap,
//     watch it save, and watch the child walk past it. (PR #13)
//   - `push:unsubscribe` shipped with the push feature and was never called,
//     so signing out of a shared Chromebook left it receiving that school's
//     hall-pass alerts.
//
// Two directions, because they fail differently. An uncalled function is a
// feature nobody can reach; a call to a function that does not exist is a
// screen that throws the moment somebody opens it.

import { readFileSync, readdirSync } from "node:fs";

let passed = 0, failed = 0;
const check = (n, ok, detail) => {
  if (ok) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; console.log(`  FAIL  ${n}${detail ? "\n        " + detail : ""}`); }
};

// ---------------------------------------------------------------------------
// What the server offers.
// ---------------------------------------------------------------------------
const KINDS = "query|mutation|action|internalQuery|internalMutation|internalAction|httpAction";
const server = new Map(); // "module:name" -> kind
for (const f of readdirSync("convex")) {
  if (!f.endsWith(".ts") || f.endsWith(".d.ts") || f.includes(".test.")) continue;
  const src = readFileSync(`convex/${f}`, "utf8");
  const mod = f.replace(/\.ts$/, "");
  for (const m of src.matchAll(new RegExp(`export const (\\w+)\\s*=\\s*(${KINDS})\\s*\\(`, "g"))) {
    server.set(`${mod}:${m[1]}`, m[2]);
  }
}

// ---------------------------------------------------------------------------
// What the clients ask for. Three dialects: the no-build app passes the name as
// a string, the React app and the crons use the generated `api.` object.
// ---------------------------------------------------------------------------
function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...walk(p)); }
    else if (/\.(ts|tsx|js|jsx|html)$/.test(e.name)) out.push(p);
  }
  return out;
}
const clientFiles = readdirSync(".")
  .filter((f) => /\.(js|html)$/.test(f) && !f.includes(".test."))
  .concat(walk("hub/src"));
const clientSrc = clientFiles.map((f) => readFileSync(f, "utf8")).join("\n");
const serverSrc = readdirSync("convex").filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(`convex/${f}`, "utf8")).join("\n");

// A call site as the no-build app writes it: convexQuery('module:fn', ...).
const stringCalls = new Map(); // "module:fn" -> how it was called
for (const m of clientSrc.matchAll(/convex(Query|Mutation|Action)\(\s*['"`](\w+):(\w+)['"`]/g)) {
  stringCalls.set(`${m[2]}:${m[3]}`, m[1].toLowerCase());
}
const called = new Set(stringCalls.keys());
for (const src of [clientSrc, serverSrc]) {
  for (const m of src.matchAll(/\b(?:api|internal)\.(\w+)\.(\w+)\b/g)) called.add(`${m[1]}.${m[2]}`.replace(".", ":"));
}

// ---------------------------------------------------------------------------
// Reached by a person, not by code. Each one needs a reason, and the reason has
// to name where the invocation is written down, so this list cannot quietly
// become the place dead functions go to hide.
// ---------------------------------------------------------------------------
const CLI_ONLY = {
  "syncLog:latest": "docs/runbook.md — `npx convex run syncLog:latest` when checking a sync",
};

console.log("\n1. Every public server function is reachable");
const publicFns = [...server].filter(([, kind]) => !/^internal/.test(kind)).map(([name]) => name);
const unreachable = publicFns.filter((n) => !called.has(n) && !CLI_ONLY[n]);
check(
  "nothing is exported to the world and called by nobody",
  unreachable.length === 0,
  unreachable.length
    ? `no caller for: ${unreachable.join(", ")}\n        ` +
      `Wire it, delete it, or add it to CLI_ONLY with where a person runs it.`
    : "",
);
check("every CLI-only exception still exists", Object.keys(CLI_ONLY).every((n) => server.has(n)),
  Object.keys(CLI_ONLY).filter((n) => !server.has(n)).join(", "));

console.log("\n2. Every call names a function that exists");
const missing = [...stringCalls.keys()].filter((n) => !server.has(n));
check("no call points at a function the server does not have", missing.length === 0,
  missing.length ? `called but not exported: ${missing.join(", ")}` : "");

console.log("\n3. A query is called as a query, and a mutation as a mutation");
// Convex routes these to different endpoints, so the mismatch is a runtime
// failure on the screen that does it, never a load-time one.
const misrouted = [...stringCalls].filter(([name, how]) => {
  const kind = server.get(name);
  if (!kind) return false;
  const want = kind === "query" ? "query" : kind === "mutation" ? "mutation" : "action";
  return how !== want;
});
check("no query is posted to /api/mutation, or the reverse", misrouted.length === 0,
  misrouted.map(([n, how]) => `${n} is a ${server.get(n)} called with convex${how}`).join("; "));

console.log("\n4. The rules the pass flow depends on are actually called");
// Named individually because these are the ones that have gone quiet before,
// and a general count would not notice one of them going missing.
const mustBeCalled = [
  "hallPasses:history",
  "hallPasses:liveBoard",
  "hallPasses:requestMine",
  "studentDetail:setPassLimit",
  "push:unsubscribe",
];
for (const n of mustBeCalled) {
  check(`${n} has a caller`, called.has(n), server.has(n) ? "exported, never called" : "not exported at all");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
