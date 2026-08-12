// Are the third-party SDK URLs the login page depends on actually reachable?
//
// This exists because they were not. The first Entra attempt pointed at
// Microsoft's own alcdn.msauth.net, which 404s on every version of that path
// now. Nothing in a unit test caught it: the URL is a string, the code around
// it is correct, and the failure only appears when a real person clicks the
// button and the script tag fails to load.
//
// Network test on purpose. Skips cleanly when offline so it cannot produce a
// false failure on a plane, but a 404 is reported as a real failure.
import fs from "node:fs";

const src = fs.readFileSync(new URL("./wildcat-auth.js", import.meta.url), "utf8");

// Pull the URLs straight out of the shipped file rather than restating them,
// so editing the file and forgetting the test cannot pass.
const msalVersion = /const MSAL_VERSION = '([^']+)'/.exec(src)?.[1];
const urls = [
  msalVersion &&
    `https://cdn.jsdelivr.net/npm/@azure/msal-browser@${msalVersion}/lib/msal-browser.min.js`,
  /const GIS_CDN = '([^']+)'/.exec(src)?.[1],
  /convexUrl: '([^']+)'/.exec(src)?.[1],
].filter(Boolean);

let pass = 0, fail = 0, skipped = 0;

console.log("\nThird-party SDK endpoints");
if (!msalVersion) { fail++; console.log("  FAIL  MSAL_VERSION not found in wildcat-auth.js"); }

for (const url of urls) {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(20000) });
    // What this test is for is a DEAD url, not an unauthorized one. Google's
    // gsi/client answers 403 to any non-browser request, which is correct
    // behavior and not a problem; a 404 or 410 means the path is gone, which
    // is exactly the failure that shipped once already.
    const dead = res.status === 404 || res.status === 410 || res.status >= 500;
    if (!dead) { pass++; console.log(`  PASS  ${res.status}  ${url}`); }
    else { fail++; console.log(`  FAIL  ${res.status} (dead)  ${url}`); }
  } catch (e) {
    skipped++;
    console.log(`  SKIP  (offline?)  ${url}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
process.exit(fail ? 1 : 0);
