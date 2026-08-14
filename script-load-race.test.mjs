// loadScript must resolve when a script has EXECUTED, not when a tag exists.
//
// The bug this pins: `if (document.querySelector(...)) return resolve()`. A tag
// is in the DOM the instant it is appended, so the second caller was told the
// library was ready while it was still downloading, then read
// PublicClientApplication off an undefined window.msal.
//
// The race is not hypothetical. resumeSession() begins the 270KB MSAL download
// on page load and the sign-in button is live immediately, so any click during
// the download hit it. Clicking again worked, which made it look intermittent
// and made it survive review.
//
// msal-recovery.test.mjs cannot catch this: it stubs document.querySelector to
// return a truthy object unconditionally, so loadScript there always takes the
// early return and real loading is never exercised.
//
// This test drives the real loadScript out of the shipped file against a fake
// DOM whose scripts load asynchronously, the way a browser behaves.

import fs from "node:fs";

const src = fs.readFileSync(new URL("./wildcat-auth.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

// Lift loadScript and its promise cache out of the IIFE, without executing the
// rest of the module (which wants a browser).
const start = src.indexOf("const scriptLoads = new Map();");
const end = src.indexOf("// ---------------------------------------------------------------------", start);
if (start === -1) {
  console.log("\n  FAIL  loadScript's promise cache not found in wildcat-auth.js");
  process.exit(1);
}
const loadScriptSrc = src.slice(start, end === -1 ? src.length : end);

/** A DOM where appending a script starts a load that completes LATER. */
function makeDom(loadDelayMs, { failLoad = false } = {}) {
  const tags = [];
  const doc = {
    querySelector(sel) {
      const m = /script\[src="(.+)"\]/.exec(sel);
      if (!m) return null;
      return tags.find((t) => t.src === m[1]) ?? null;
    },
    createElement() {
      return {
        dataset: {}, src: "", async: false,
        onload: null, onerror: null,
        _listeners: { load: [], error: [] },
        addEventListener(type, fn) { this._listeners[type].push(fn); },
      };
    },
    head: {
      appendChild(el) {
        tags.push(el);
        setTimeout(() => {
          if (failLoad) {
            if (el.onerror) el.onerror();
            el._listeners.error.forEach((f) => f());
          } else {
            if (el.onload) el.onload();
            el._listeners.load.forEach((f) => f());
          }
        }, loadDelayMs);
      },
    },
  };
  return { doc, tags };
}

function instantiate(dom) {
  const factory = new Function("document", `${loadScriptSrc}; return loadScript;`);
  return factory(dom.doc);
}

console.log("\nloadScript waits for the script to execute");

{
  // THE BUG. Caller A starts the download; caller B arrives mid-flight.
  const dom = makeDom(50);
  const loadScript = instantiate(dom);
  let aDone = false, bDone = false;
  const a = loadScript("https://cdn/msal.js").then(() => { aDone = true; });
  const b = loadScript("https://cdn/msal.js").then(() => { bDone = true; });

  await new Promise((r) => setTimeout(r, 5));
  check("a second caller does NOT resolve while the script is still loading",
    aDone === false && bDone === false);

  await Promise.all([a, b]);
  check("both callers resolve once it has loaded", aDone === true && bDone === true);
  check("only ONE tag was created for the same url", dom.tags.length === 1);
}

{
  // A tag already in the DOM from an earlier render, still in flight.
  const dom = makeDom(50);
  const loadScript = instantiate(dom);
  const first = loadScript("https://cdn/msal.js");
  await new Promise((r) => setTimeout(r, 5));

  const fresh = instantiate(dom);   // a caller with no shared cache
  let done = false;
  const second = fresh("https://cdn/msal.js").then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 5));
  check("an unrelated caller attaches to an in-flight tag instead of resolving early",
    done === false);

  await Promise.all([first, second]);
  check("and resolves when that tag finishes", done === true);
}

{
  const dom = makeDom(20, { failLoad: true });
  const loadScript = instantiate(dom);
  let rejected = false;
  await loadScript("https://cdn/msal.js").catch(() => { rejected = true; });
  check("a failed load rejects", rejected === true);

  // A cached rejection would leave sign-in broken until a full reload.
  const dom2 = makeDom(20);
  const retry = instantiate(dom2);
  let ok = false;
  await retry("https://cdn/msal.js").then(() => { ok = true; }).catch(() => {});
  check("a failure is not cached, so a retry can still succeed", ok === true);
}

console.log("\nentraClient shares one construction");
{
  check("entraClient returns a shared promise rather than rebuilding",
    /msalAppPromise/.test(src) && /if \(msalAppPromise\) return msalAppPromise;/.test(src));
  check("a failed build clears the cached promise",
    /msalAppPromise\.catch\(\(\) => \{ msalAppPromise = null; \}\)/.test(src));
  check("a missing global is reported as itself, not as a property read on undefined",
    /did not register itself/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
