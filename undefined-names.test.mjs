// Does every name in the browser code actually exist?
//
// WHY THIS EXISTS. On 2026-09-05 two blocks used `auth` and `session` borrowed
// from a const pair in a block that had already closed. Both threw
// ReferenceError, both sat in a forgiving try/catch, and the audit log silently
// stopped leaving the browser it was written in. The suite had ~3,700 passing
// assertions at the time and could not have caught it: almost all of them match
// STRINGS IN THE SOURCE, which are just as present when the code is broken.
//
// The same day: a function was called after its definition was deleted, a
// dialog helper was called by a name that did not exist, and two CSS classes
// were used without being defined. All the same shape -- a name that is not
// there -- and all invisible to a text search.
//
// This runs the TypeScript compiler over the real files in checkJs mode and
// reports TS2304 "Cannot find name". Anything genuinely global is declared in
// KNOWN_GLOBALS below, so the list stays honest: adding a name there is a
// deliberate statement that it exists at runtime, not a way to silence a bug.
//
// Run: npm test

import ts from "typescript";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

/**
 * Names that genuinely exist at runtime but are not declared in these files.
 *
 * Third-party libraries loaded by <script> tags, and the app's own modules,
 * which attach themselves to window. Everything DOM- or JS-standard comes from
 * the lib settings and is not listed.
 */
const KNOWN_GLOBALS = new Set([
  // Loaded by index.html as <script> tags.
  "XLSX", "Chart", "emailjs", "firebase", "msal", "google", "Papa", "html2canvas", "jspdf",
  // The app's own pure modules, each attached to window/globalThis.
  "WildcatStore", "WildcatRoster", "WildcatMerge", "WildcatDiscipline",
  "WildcatSaveQueue", "WildcatModes", "WildcatAudit", "WildcatCashAudit",
  "WildcatAuth", "WildcatDirty",
  // Build/host globals.
  "process", "globalThis", "self",
  // Attached to window by other files this app serves. Each verified present:
  //   wcIcon              wildcat-icons.js, `window.wcIcon = wcIcon`
  //   signInWithMicrosoft wildcat-auth.js,  `window.signInWithMicrosoft = ...`
  //   JsBarcode           CDN <script> in index.html
  //   NDEFReader          Web NFC, a real browser global TypeScript's DOM lib
  //                       does not declare
  "wcIcon", "signInWithMicrosoft", "JsBarcode", "NDEFReader",
  // wildcat-auth.js deliberately reaches into script.js's globals; its own
  // header documents that these are defined there.
  "teachers", "establishTeacherSession", "establishStudentSession",
]);

function undefinedNamesIn(fileName) {
  const program = ts.createProgram([fileName], {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: [],
    skipLibCheck: true,
  });
  const src = program.getSourceFile(fileName);
  const found = [];
  for (const d of program.getSemanticDiagnostics(src)) {
    // TS2304: Cannot find name 'x'. The only code this test is about.
    if (d.code !== 2304) continue;
    const text = ts.flattenDiagnosticMessageText(d.messageText, " ");
    const name = /Cannot find name '([^']+)'/.exec(text)?.[1];
    if (!name || KNOWN_GLOBALS.has(name)) continue;
    const { line } = src.getLineAndCharacterOfPosition(d.start);
    found.push({ name, line: line + 1 });
  }
  return found;
}

for (const file of ["script.js", "wildcat-auth.js"]) {
  console.log(`\n${file}`);
  // fileURLToPath, NOT URL.pathname. This project's path contains a space,
  // which pathname percent-encodes -- TypeScript then opens nothing, the
  // program is empty, and the check reports a clean bill of health for a file
  // it never read. This test was written with that bug and only found because
  // it was verified against a known defect before being trusted.
  const bad = undefinedNamesIn(fileURLToPath(new URL(`./${file}`, import.meta.url)));

  // Group, so one missing helper used ten times reads as one problem.
  const byName = new Map();
  for (const b of bad) {
    if (!byName.has(b.name)) byName.set(b.name, []);
    byName.get(b.name).push(b.line);
  }
  for (const [name, lines] of [...byName].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`        ${name}  ->  line${lines.length > 1 ? "s" : ""} ${lines.slice(0, 6).join(", ")}${lines.length > 6 ? ` and ${lines.length - 6} more` : ""}`);
  }
  check(`every name resolves (${bad.length} unresolved, ${byName.size} distinct)`, bad.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
