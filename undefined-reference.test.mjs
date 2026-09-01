// Every name exported on `window` must actually exist.
//
// THE OUTAGE THIS EXISTS TO PREVENT. On 2026-08-31 the Firebase removal deleted
// signInStaffWithEntra and signInStudentWithGoogle and left both names listed in
// the `window.wildcatAuth = { ... }` object literal. That literal runs at load
// and threw ReferenceError, so every function declared BELOW it in script.js,
// which is nearly all of them, never came into existence. Students authenticated
// with Google, came back, and looped on the sign-in screen because the app had
// no code left to receive the token.
//
// WHY NOTHING ELSE CATCHES IT.
//   - `node --check` parses; it does not resolve names. The syntax was valid.
//   - The rest of the suite SLICES named regions out of script.js and runs
//     those. Nothing executed the export block.
//   - The browser only fails at runtime, on the real page, after a deploy.
//
// An object literal is the one place a deleted function hides in plain sight:
// it reads as data and executes as code. This file resolves those names the way
// the browser would.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./script.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
};

/**
 * Source with comments and strings blanked out.
 *
 * A comment that MENTIONS a deleted function is not a reference to it, and the
 * comments in this file deliberately name the two that caused the outage. Left
 * in, they would make this test fail on the very fix it is guarding.
 */
function stripNoise(code) {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const two = code.slice(i, i + 2);
    if (two === "//") {
      const end = code.indexOf("\n", i);
      i = end === -1 ? code.length : end;
    } else if (two === "/*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2;
    } else if (code[i] === '"' || code[i] === "'" || code[i] === "`") {
      const quote = code[i];
      i += 1;
      while (i < code.length && code[i] !== quote) i += code[i] === "\\" ? 2 : 1;
      i += 1;
    } else {
      out += code[i];
      i += 1;
    }
  }
  return out;
}

const code = stripNoise(src);

/** Every name script.js declares, by any means the browser would honour. */
const declared = new Set();
for (const re of [
  /\bfunction\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /\bclass\s+([A-Za-z_$][\w$]*)/g,
]) {
  for (const m of code.matchAll(re)) declared.add(m[1]);
}

// Globals the page gets from elsewhere: the browser, another script tag, or a
// CDN. Listing them beats not running the check at all, and each one is a name
// somebody would have to add deliberately.
const AMBIENT = new Set([
  "window", "document", "console", "navigator", "location", "localStorage",
  "sessionStorage", "fetch", "setTimeout", "setInterval", "clearTimeout",
  "clearInterval", "Date", "Math", "JSON", "Object", "Array", "String", "Number",
  "Boolean", "Promise", "Map", "Set", "Error", "RegExp", "Intl", "URL",
  "TextEncoder", "TextDecoder", "CustomEvent", "Event", "Image", "FileReader",
  "Blob", "AbortController", "crypto", "atob", "btoa", "alert", "confirm",
  "prompt", "requestAnimationFrame", "structuredClone", "IntersectionObserver",
  "MutationObserver", "ResizeObserver", "performance", "history", "screen",
  // Loaded by their own <script> tags in index.html.
  "Chart", "JsBarcode", "XLSX", "emailjs", "Capacitor", "WildcatAuth",
  "WildcatMerge", "WildcatStore", "WildcatRoster", "WildcatSaveQueue",
  "WildcatDiscipline", "wcMotion", "wcIcon", "html2canvas", "jspdf", "QRCode",
]);

console.log("\nEvery name exported on window resolves");
{
  // `window.<thing> = { ... }` blocks, and the bare shorthand inside them.
  const exports = [...code.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=\s*\{([\s\S]*?)\n\s*\};/g)];
  check("there are window exports to check", exports.length > 0, String(exports.length));

  const missing = [];
  for (const [, exportName, body] of exports) {
    for (const line of body.split("\n")) {
      // A shorthand property is a bare identifier on its own line. `a: b` is a
      // value reference and `a() {}` is a definition; neither is this shape.
      const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*,?\s*$/);
      if (!m) continue;
      const name = m[1];
      if (declared.has(name) || AMBIENT.has(name)) continue;
      missing.push(`window.${exportName} -> ${name}`);
    }
  }
  check(
    "no export names a function or value that does not exist",
    missing.length === 0,
    missing.join("; ") +
      (missing.length ? "  <- this throws ReferenceError at load and kills every declaration below it" : ""),
  );
}

console.log("\nThe Firebase removal left nothing dangling");
{
  // Named explicitly because these are the symbols the removal deleted, and a
  // reference to any of them is a straight ReferenceError or TypeError.
  const gone = [
    "initFirebase", "firebaseConfig", "firebaseApp", "firebaseDb", "firebaseAuth",
    "firebaseInitialized", "firebaseAuthReady", "signInStaffWithEntra",
    "signInStudentWithGoogle",
  ];
  const live = gone.filter((g) => new RegExp(`\\b${g}\\b`).test(code));
  check("no deleted Firebase symbol is still referenced in code", live.length === 0, live.join(", "));
  check("window.firebaseModules is not read anywhere",
    !/firebaseModules/.test(code),
    "initFirebase set it and nothing sets it now, so every read is a TypeError");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
