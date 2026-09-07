// Every element this code dereferences has to exist.
//
// THREE TIMES NOW. getElementById returns null for an element that is not
// there, and reading .classList / .value / .style off null throws -- taking out
// the rest of the function, which is always the part that matters:
//
//   2026-08-14  #studentLoginId removed  -> logout stopped switching screens
//   2026-09-07  #loginUsername removed   -> caught before shipping
//   2026-09-07  #createAdminScreen removed -> SHIPPED. Sign-in completed server
//               side and then threw on the handoff, one line before mainApp was
//               shown, so every member of staff was left on the login screen.
//
// The pattern is identical every time: markup is deleted, a caller that reached
// for it by id survives, and the failure lands somewhere unrelated. Neither a
// syntax check nor undefined-names can see it -- the name is a string.
//
// This flags an UNGUARDED dereference of an id that is neither in index.html
// nor created by the app at runtime. Guarded uses are fine and common; the
// codebase does that deliberately for optional surfaces.
//
// Run: npm test

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const rawJs = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const js = rawJs.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

/** Ids the served markup actually has. */
const inHtml = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/**
 * Ids the app builds at runtime: `id="x"` inside a template string it injects,
 * `el.id = 'x'`, or `id: 'x'`. These are real elements that simply are not in
 * index.html, and they are the reason a bare "not in the HTML" sweep reports
 * eighty false positives.
 */
const madeAtRuntime = new Set([
  ...[...js.matchAll(/\bid=\\?["']([A-Za-z][\w-]*)\\?["']/g)].map((m) => m[1]),
  ...[...js.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
  ...[...js.matchAll(/\bid:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
  ...[...js.matchAll(/id=\$\{[^}]*\}|sideSub_/g)].map(() => "__dynamic__"),
]);

console.log("\nNo unguarded reach for an element that is not there");
{
  // getElementById('x').something -- dereferenced on the spot, no guard.
  const direct = [...js.matchAll(
    /document\.getElementById\(\s*['"]([A-Za-z][\w-]*)['"]\s*\)\s*\.\s*(\w+)/g)];

  const orphans = [];
  for (const m of direct) {
    const [, id, prop] = m;
    if (inHtml.has(id) || madeAtRuntime.has(id)) continue;
    const line = js.slice(0, m.index).split("\n").length;
    orphans.push({ id, prop, line });
  }

  for (const o of orphans) {
    console.log(`        #${o.id} .${o.prop}  -- line ~${o.line} of the stripped file`);
  }
  check(`every dereferenced id exists (${orphans.length} orphaned)`, orphans.length === 0);
}

console.log("\nThe three that actually shipped are gone");
{
  // Named individually: each one broke a different critical path, and a
  // regression on any of them is worth failing by name rather than by count.
  check("logout no longer reaches for #studentApp",
    !/getElementById\(['"]studentApp['"]\)\s*\./.test(js));
  check("sign-in no longer reaches for #createAdminScreen",
    !/getElementById\(['"]createAdminScreen['"]\)\s*\./.test(js));
  check("nothing reaches for #loginUsername or #loginPassword",
    !/getElementById\(['"]login(Username|Password)['"]\)\s*\./.test(js));
  check("nor #changePasswordModal",
    !/getElementById\(['"]changePasswordModal['"]\)\s*\./.test(js));

  // The paths those three broke, still wired.
  check("sign-in still reveals the app",
    /getElementById\('mainApp'\)\.classList\.remove\('hidden'\)/.test(js));
  check("logout still returns to the login screen",
    /getElementById\('loginScreen'\)\.classList\.remove\('hidden'\)/.test(js));
  check("and the history of it is written where it happened",
    /has been throwing on every logout/.test(rawJs));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
