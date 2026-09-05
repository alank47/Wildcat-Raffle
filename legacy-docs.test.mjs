// Loading the legacy mirror.
//
// legacyData:load did `.collect()` over the whole legacyMirror table. The
// table crossed Convex's 16 MiB per-execution read limit, so EVERY load in
// production threw "Too many bytes read in a single function execution" and
// fell through to the localStorage copy. On a machine with no localStorage
// copy that meant no schedules, no referrals, no cash and no audit log for the
// whole session -- and no error on screen, because the fallback is not an
// error path.
//
// The documents are now fetched by name through the by_doc index, one
// execution each. These assertions are the two ways that can go wrong: a name
// left off the list (loads as absent, reads as "no ticket history"), and a
// partial result being accepted as a whole one.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
/** Comments stripped, so an assertion cannot pass on prose describing the bug. */
const code = script.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

// ---- Extract the loader and run it for real, against a fake Convex. --------
const start = script.indexOf("const LEGACY_FIXED_DOCS = [");
const endMark = "            return { docs: out, failed: failures.map(f => f.doc), errors: failures };\n        }";
const end = script.indexOf(endMark, start) + endMark.length;
if (start < 0 || end < endMark.length) {
  console.log("  FAIL  could not extract the loader from script.js");
  process.exit(1);
}
const mod = new Function("window", script.slice(start, end) +
  "\n; return { LEGACY_FIXED_DOCS, LEGACY_LOAD_CONCURRENCY, loadLegacyDocsFromConvex };");

/** A Convex stand-in that records what was asked for and can be made to fail. */
function fakeAuth(store, opts = {}) {
  const asked = [];
  let inFlight = 0, peak = 0;
  return {
    asked,
    peak: () => peak,
    api: {
      getSession: () => (opts.noSession ? null : { idToken: "tok" }),
      convexQuery: async (name, args) => {
        if (name !== "legacyData:loadDoc") throw new Error(`unexpected query ${name}`);
        asked.push(args.doc);
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        if (opts.failOn && opts.failOn.includes(args.doc)) {
          throw new Error(`Server Error on ${args.doc}`);
        }
        return Object.prototype.hasOwnProperty.call(store, args.doc) ? store[args.doc] : null;
      },
    },
  };
}

console.log("\nIt reads one document at a time, through the index");
{
  check("nothing calls legacyData:load any more",
    !/convexQuery\(\s*'legacyData:load'/.test(script));
  check("the loader asks for legacyData:loadDoc",
    /convexQuery\(\s*\n?\s*'legacyData:loadDoc'/.test(script));

  const f = fakeAuth({ main: { a: 1 }, secondary: { b: 2 } });
  const m = mod({ WildcatAuth: f.api });
  const docs = (await m.loadLegacyDocsFromConvex(["main", "secondary", "referrals"])).docs;
  check("every named document is requested", f.asked.length === 3);
  check("each by name", f.asked.sort().join(",") === "main,referrals,secondary");
  check("the documents that exist come back", docs.main.a === 1 && docs.secondary.b === 2);
}

console.log("\nAn empty document is absent, not present-and-null");
{
  // snapOf does Boolean(d). A key set to null would still be a key, but
  // exists() would read false either way -- what must NOT happen is `main`
  // arriving as null and being spread. Absence is how the whole-table query
  // expressed it, so absence is what is preserved.
  const f = fakeAuth({ main: { a: 1 } });
  const m = mod({ WildcatAuth: f.api });
  const docs = (await m.loadLegacyDocsFromConvex(["main", "audit_log_2026_W99"])).docs;
  check("a document with no rows is left off entirely",
    !("audit_log_2026_W99" in docs));
  check("and Boolean() on it reads false, as snapOf expects",
    Boolean(docs["audit_log_2026_W99"]) === false);
}

console.log("\nA failed document does not sink the other 144");
{
  // THE REGRESSION THIS REPLACES. This used to throw, so one unreadable
  // document discarded every other document and dropped the whole app to its
  // localStorage copy -- which renders as zeros indistinguishable from real
  // ones. On 2026-09-05 three ticket-history documents were over Convex's read
  // limit and took 142 good documents down with them, on a school that is not
  // using raffle at all.
  const f = fakeAuth({ main: { a: 1 }, secondary: { b: 2 }, ticket_history_ms: { h: {} } },
                     { failOn: ["ticket_history_ms"] });
  const m = mod({ WildcatAuth: f.api });
  const res = await m.loadLegacyDocsFromConvex(["main", "secondary", "ticket_history_ms"]);

  check("the documents that loaded are returned", res.docs.main.a === 1 && res.docs.secondary.b === 2);
  check("the one that failed is NOT present as empty", !("ticket_history_ms" in res.docs));
  check("and is named, so the caller knows it is unknown rather than absent",
    res.failed.length === 1 && res.failed[0] === "ticket_history_ms");
  check("with the reason attached", /Server Error/.test(res.errors[0].message));
  check("nothing throws, so the load completes", true);
}

console.log("\nWhat could not be READ is never WRITTEN");
{
  // The reason the old strictness existed, kept without the collateral damage.
  // A document that failed to load is unknown, not empty. Writing this tab's
  // idea of it over a document it never saw is how a read error becomes data
  // loss -- and saveSlice REPLACES, so it would delete what it could not see.
  check("mergeLegacySlice refuses an unread document",
    /async function mergeLegacySlice[\s\S]{0,500}unreadLegacyDocs\.has\(docName\)[\s\S]{0,200}throw new Error/.test(code));
  check("saveLegacySlice refuses one too",
    /async function saveLegacySlice[\s\S]{0,500}unreadLegacyDocs\.has\(docName\)[\s\S]{0,200}throw new Error/.test(code));
  check("the ticket-history writer checks before building a request",
    /unreadLegacyDocs\.has\(docName\)[\s\S]{0,300}not writing it/.test(code));
  check("the set is filled from the load's failures",
    /unreadLegacyDocs = new Set\(_legacyResult\.failed \|\| \[\]\)/.test(code));
  check("and it starts empty, so a tab that has not loaded blocks nothing",
    /let unreadLegacyDocs = new Set\(\);/.test(code));
  check("the diagnostic reports which documents those are",
    /out\.unreadableDocuments/.test(code));
}

console.log("\nIt does not stampede Convex");
{
  const store = {};
  const names = [];
  for (let i = 0; i < 40; i++) { names.push(`doc_${i}`); store[`doc_${i}`] = { i }; }
  const f = fakeAuth(store);
  const m = mod({ WildcatAuth: f.api });
  const docs = (await m.loadLegacyDocsFromConvex(names)).docs;
  check("all 40 documents load", Object.keys(docs).length === 40);
  check("but never more than the concurrency limit at once",
    f.peak() <= m.LEGACY_LOAD_CONCURRENCY);
  check("and it does not serialise them one by one either", f.peak() > 1);
}

console.log("\nNo session is an error, not an empty result");
{
  const f = fakeAuth({}, { noSession: true });
  const m = mod({ WildcatAuth: f.api });
  let threw = null;
  try { await m.loadLegacyDocsFromConvex(["main"]); } catch (e) { threw = e; }
  check("it throws rather than returning {}", threw !== null);
  check("with the signed-out reason", /Not signed in/.test(threw.message));
  check("and asks Convex for nothing", f.asked.length === 0);
}

console.log("\nEvery document loadData reads is on the list");
{
  // A NAME LEFT OFF DOES NOT RAISE ANYTHING. It loads as an absent document,
  // which downstream reads as "this school has no ticket history". This is the
  // assertion that catches it.
  const m = mod({ WildcatAuth: fakeAuth({}).api });
  const fixed = m.LEGACY_FIXED_DOCS;

  const literals = [...script.matchAll(/snapOf\('([a-z_0-9]+)'\)/g)].map((x) => x[1]);
  check("loadData names at least the ten known documents", literals.length >= 10);
  for (const name of [...new Set(literals)]) {
    check(`snapOf('${name}') is covered`, fixed.includes(name));
  }
  check("and `main`, which is read by property access rather than snapOf",
    fixed.includes("main"));

  // The two date-keyed families are added at the CALL SITE from the same
  // arrays the snapshots are read back with. Building them inside the loader
  // from a second clock reading could fetch a week under one key and look for
  // it under another across a boundary.
  check("audit months are added from monthKeys at the call site",
    /loadLegacyDocsFromConvex\(\s*\n?\s*LEGACY_FIXED_DOCS[\s\S]{0,200}monthKeys\.map\(auditDocName\)/.test(script));
  check("cash weeks are added from the same _cashWeekKeys array",
    /_cashWeekKeys\.map\(wk => `cash_tx_\$\{wk\}`\)/.test(script));
  check("neither family is hardcoded into LEGACY_FIXED_DOCS",
    !fixed.some((d) => /^audit_log_\d|^cash_tx_/.test(d)));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
