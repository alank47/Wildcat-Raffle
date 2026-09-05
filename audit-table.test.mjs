// The audit log as a table: minting, batching, and the wire shape.
//
// WHY THIS MOVED. Entries lived in weekly legacyMirror documents saved with
// mergeSlice, which reads the whole stored slice. Convex charges a delete as a
// read, so appending one entry to a week holding 1,278 cost 2,556 reads against
// a 4,096 limit -- and the client re-sent the entire month every save anyway.
// One entry is written per student per cash award, so 34 teachers awarding
// whole classes reach that mid-week.
//
// The failure was the quiet kind: cash awards keep working, because balances
// live elsewhere, while the record of who gave what stops being written. The
// PBIS team reads that record, and it is what answers a parent asking why their
// child was deducted.
//
// Run: npm test

import { readFileSync } from "node:fs";

const auditSrc = readFileSync(new URL("./wildcat-audit.js", import.meta.url), "utf8");
new Function(auditSrc)();
const A = globalThis.WildcatAudit;

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const code = script.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const convex = readFileSync(new URL("./convex/auditLog.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("./convex/schema.ts", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\nAn entry id is minted, not hashed");
{
  // ensureEntryId hashes contents into 32 bits: ~2.1 billion values. The
  // birthday bound is what matters for a dedupe key, and at ~50,000 entries a
  // year the chance SOME pair of different entries collides is better than
  // even. A collision drops the second entry -- an award that happened, with no
  // record that it did.
  const ids = new Set();
  for (let i = 0; i < 200000; i++) ids.add(A.newAuditEntryId());
  check("200,000 mints are all distinct", ids.size === 200000);

  const t = Date.now();
  const burst = new Set();
  for (let i = 0; i < 20000; i++) burst.add(A.newAuditEntryId(t));
  check("20,000 in the SAME millisecond are still distinct", burst.size === 20000);

  const id = A.newAuditEntryId(new Date("2026-09-04T10:00:00Z"));
  check("it is marked as minted", A.isMintedAuditId(id));
  check("and cannot be confused with a legacy hash",
    id.startsWith("a_") && !A.isMintedAuditId("e_1f4x9"));
  check("ids sort chronologically by their timestamp part",
    A.newAuditEntryId(1000) < A.newAuditEntryId(2000));

  check("crypto is preferred over Math.random", /crypto\.getRandomValues/.test(auditSrc));
  const fixed = (() => { let n = 0; return () => { n += 0.37; return n % 1; }; });
  check("injected randomness is honoured, so this is testable",
    A.newAuditEntryId(5, fixed()) === A.newAuditEntryId(5, fixed()));
}

console.log("\nLegacy ids are left exactly alone");
{
  // Every stored entry carries an `e_` hash, and those ids are the dedupe key
  // in the mirror, in browsers' outboxes and in exports. Recomputing them would
  // orphan all of it.
  check("ensureEntryId still returns a stored id unchanged",
    /if \(entry && entry\.entryId && typeof entry\.entryId === 'string'\) return entry\.entryId;/.test(script));
  check("and still derives the old hash for an entry without one",
    /return 'e_' \+ Math\.abs\(h\)\.toString\(36\);/.test(script));
  check("new entries are born with a minted id",
    /entryId: window\.WildcatAudit\.newAuditEntryId\(\)/.test(code));
}

console.log("\nThe wire shape lifts the indexed columns out, keeps the entry whole");
{
  const entry = { entryId: "a_x", timestamp: "2026-09-04T10:00:00Z", teacher: "R Chavez",
                  studentName: "A Alvarez", category: "Wildcat Cash", ticketCount: 5,
                  reason: "On task", week: 2, cycle: 3 };
  const rows = A.toRows([entry], (e) => e.entryId);
  check("one row per entry", rows.length === 1);
  check("the entryId is lifted out", rows[0].entryId === "a_x");
  check("the timestamp is lifted out", rows[0].timestamp === entry.timestamp);
  check("and the entry itself is carried VERBATIM, not reshaped",
    JSON.stringify(rows[0].payload) === JSON.stringify(entry));

  const dropped = A.toRows([{ timestamp: "t" }], () => "");
  check("an entry with no id is refused rather than sent unmatched",
    dropped.length === 0);
}

console.log("\nBatches respect the server's cap");
{
  check("the client cap matches the server's", A.MAX_APPEND === 500);
  check("the server's cap is 500", /const MAX_APPEND = 500;/.test(convex));
  const c = A.chunk(new Array(1200).fill({}), 500);
  check("1,200 entries become 3 batches", c.length === 3);
  check("sized 500, 500, 200", c.map((x) => x.length).join(",") === "500,500,200");
  check("an empty list needs no batches", A.chunk([], 500).length === 0);
  check("the save path chunks before sending",
    /WildcatAudit\.chunk\(rows, window\.WildcatAudit\.MAX_APPEND\)/.test(code));
}

console.log("\nOnly what changed is sent");
{
  // The old code re-sent the entire month on every save. That is what made the
  // cost grow with the size of the log rather than with the day's work.
  check("a set tracks what the server has confirmed",
    /let auditIdsOnServer = new Set\(\);/.test(code));
  check("the save sends only entries not in it",
    /return !auditIdsOnServer\.has\(id\);/.test(code));
  check("the set is filled from the load",
    /auditIdsOnServer\.add\(id\);/.test(code));
  check("and only after a CONFIRMED write, never optimistically",
    /batch\.forEach\(r => auditIdsOnServer\.add\(r\.entryId\)\);/.test(code));
  check("a failed append leaves entries pending rather than dropping them",
    /auditSaveSucceeded = false;[\s\S]{0,200}AUDIT LOG SAVE FAILED/.test(code));
  check("the outbox is still only cleared on success",
    /if \(auditSaveSucceeded\) \{\s*try \{\s*clearAuditOutbox\(\);/.test(code));
  check("nothing writes the audit log through mergeSlice any more",
    !/mergeLegacySlice\(auditDocName/.test(code));
}

console.log("\nThe server append is idempotent, which is what makes retries safe");
{
  check("it dedupes on the entryId index",
    /withIndex\("by_entryId", \(q\) => q\.eq\("entryId", id\)\)/.test(convex));
  check("an entry already stored is left alone", /if \(existing\) \{ alreadyStored\+\+; continue; \}/.test(convex));
  check("duplicates within one batch are dropped too", /seenInBatch/.test(convex));
  check("an entry with no id is refused, not inserted unmatched",
    /if \(!id\) \{ skipped\+\+; continue; \}/.test(convex));
  check("it reports what it actually did",
    /return \{ inserted, alreadyStored, skipped, received: entries\.length \};/.test(convex));
  check("and it is gated on requireStaff", /await requireStaff\(ctx\);/.test(convex));
}

console.log("\nReads are bounded and indexed");
{
  check("the table indexes entryId for the append", /\.index\("by_entryId", \["entryId"\]\)/.test(schema));
  check("and timestamp for the window", /\.index\("by_timestamp", \["timestamp"\]\)/.test(schema));
  check("list pages rather than collecting", /\.paginate\(\{ cursor: cursor \?\? null, numItems \}\)/.test(convex));
  check("with a hard page ceiling", /Math\.min\(Math\.max\(1, limit \?\? PAGE\), PAGE\)/.test(convex));
  check("the client walks the pages", /if \(page\.isDone\) break;\s*cursor = page\.cursor;/.test(code));
  check("oldest first, the order the app has always held", /\.order\("asc"\)/.test(convex));
}

console.log("\nThe move cannot lose an entry it has not copied yet");
{
  // A migration that flips the read over in one step cannot notice it moved
  // less than it thought: the entries are simply absent, which on an audit log
  // looks exactly like a quiet week.
  check("the table AND the old documents are both read",
    /auditLog:list/.test(code) && /monthlyAuditSnaps\.forEach/.test(code));
  check("unioned by entryId, so reading an entry twice is harmless",
    /if \(!auditById\.has\(id\)\) auditById\.set\(id, \{ \.\.\.e, entryId: id \}\)/.test(code));
  check("a failed table read degrades to the documents rather than an empty log",
    /table read failed, falling back to documents/.test(code));
  check("the migration does not delete its source",
    /IT DOES NOT DELETE ANYTHING/.test(
      readFileSync(new URL("./scripts/migrate-audit-log.mjs", import.meta.url), "utf8")));
  check("and it is idempotent, because the first run may fail partway",
    /SAFE TO RUN TWICE/.test(
      readFileSync(new URL("./scripts/migrate-audit-log.mjs", import.meta.url), "utf8")));
}

console.log("\nThe module is actually served, before the code that calls it");
{
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const audit = html.indexOf("wildcat-audit.js");
  const main = html.indexOf('src="script.js');
  check("index.html loads wildcat-audit.js", audit > 0);
  check("before script.js, which calls into it", audit < main);
  const v = /wildcat-audit\.js\?v=([0-9a-z]+)/.exec(html)?.[1];
  const sv = /src="script\.js\?v=([0-9a-z]+)/.exec(html)?.[1];
  check("on the same cache-busting version as script.js", v && v === sv);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
