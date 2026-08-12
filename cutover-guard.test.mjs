// Guards for the Convex cutover that cannot be unit tested through an import,
// because script.js is a 20,000 line browser file with no module boundary.
//
// These read the source. That is a weak form of test and it is the right one
// here: both failures below are SILENT in a browser. Losing the fallback shows
// up as an empty roster in front of a class, and a stale cache buster shows up
// as a teacher running last week's code with no indication anything is wrong.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
}

console.log("\nConvex cutover switches");
{
  const source = script.match(/const DATA_SOURCE = '(\w+)'/);
  const write = script.match(/const DATA_WRITE = '(\w+)'/);
  check("DATA_SOURCE is declared", Boolean(source), "the read switch is missing");
  check("DATA_WRITE is declared", Boolean(write), "the write switch is missing");
  check(
    "DATA_SOURCE is one of the two known values",
    ["convex", "firestore"].includes(source?.[1]),
    source?.[1],
  );
  check(
    "DATA_WRITE is one of the three known values",
    ["convex", "firestore", "both"].includes(write?.[1]),
    write?.[1],
  );
}

console.log("\nThe fallback is intact");
{
  // The Convex read must be inside a try with a catch that does NOT rethrow.
  // If it rethrows, or the catch is removed, a Convex outage stops being a
  // degraded roster and becomes a blank one.
  const branch = script.slice(
    script.indexOf("if (DATA_SOURCE === 'convex')"),
    script.indexOf("if (DATA_SOURCE === 'convex')") + 900,
  );
  check("the Convex read is guarded by try", /try\s*\{/.test(branch));
  check("and has a catch", /catch\s*\(/.test(branch), branch.slice(0, 80));
  check(
    "the catch does not rethrow, so Firestore still answers",
    !/catch\s*\([^)]*\)\s*\{[^}]*\bthrow\b/.test(branch),
  );
  check(
    "the failure is reported rather than swallowed silently",
    /console\.(error|warn)/.test(branch),
  );
}

console.log("\nloadRosterFromConvex refuses to fake success");
{
  const fn = script.slice(
    script.indexOf("async function loadRosterFromConvex"),
    script.indexOf("async function loadRosterFromConvex") + 900,
  );
  check("it throws when not signed in", /throw new Error\('Not signed in/.test(fn));
  check(
    "it throws rather than returning an empty roster",
    /throw new Error\('appData:load returned no students/.test(fn),
    "an empty array and a failed request must not look the same",
  );
  check("it passes the id token", /session\.idToken/.test(fn));
}

console.log("\nCache busters");
{
  const tags = [...html.matchAll(/(script|wildcat-auth)\.js\?v=([\w-]+)/g)].map((m) => m[2]);
  check("both script tags carry a version", tags.length >= 2, JSON.stringify(tags));
  check(
    "and they match, so one cannot ship without the other",
    new Set(tags).size === 1,
    JSON.stringify(tags),
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
