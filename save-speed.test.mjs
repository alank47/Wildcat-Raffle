// Making a save fast enough for thirty-four teachers at once.
//
// THE TWO COSTS. saveData wrote every slice on every save, and wrote ten of
// them one at a time. A teacher awarding Wildcat Cash therefore paid for five
// ticket-history documents -- about 9,600 stored rows the server must read to
// merge -- plus ten sequential network round trips for `secondary`. Nearly all
// of it re-sending data byte-identical to what was already stored, for a Raffle
// mode nobody is running.
//
// WHY SKIPPING IS SAFE AND NOT A GUESS. The fingerprint is of the exact payload
// that would be sent. If it matches one already written successfully, sending
// it again cannot change stored state: mergeSlice is a union deduped by id, so
// identical input inserts nothing. The risk is not "might be stale" -- it is
// recording a write that never landed, and that is what these assertions are
// mostly about.
//
// Run: npm test

import { readFileSync } from "node:fs";

const dirtySrc = readFileSync(new URL("./wildcat-dirty.js", import.meta.url), "utf8");
new Function(dirtySrc)();
const D = globalThis.WildcatDirty;

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const code = script.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\nUnchanged data is not sent twice");
{
  const t = D.create();
  const rows = [{ id: 1, v: "a" }, { id: 2, v: "b" }];
  check("the first time, it must be sent", t.changed("k", rows) === true);
  t.markWritten("k", rows);
  check("the identical payload is not sent again", t.changed("k", rows) === false);
  check("an equal-but-separate object is also recognised",
    t.changed("k", [{ id: 1, v: "a" }, { id: 2, v: "b" }]) === false);
  check("a changed value is sent", t.changed("k", [{ id: 1, v: "CHANGED" }]) === true);
  check("an added row is sent",
    t.changed("k", [{ id: 1, v: "a" }, { id: 2, v: "b" }, { id: 3 }]) === true);
  check("a removed row is sent", t.changed("k", [{ id: 1, v: "a" }]) === true);
  check("REORDERING is a change, because the stored order would differ",
    t.changed("k", [{ id: 2, v: "b" }, { id: 1, v: "a" }]) === true);
  check("keys do not bleed into each other", t.changed("other", rows) === true);
}

console.log("\nA write that did not land is never recorded as one");
{
  // THE FAILURE THAT WOULD LOSE DATA. Marking before the write resolves means a
  // failed write is never retried, and the change is gone.
  const t = D.create();
  const rows = [{ id: 1 }];
  t.changed("k", rows);
  // ...write rejects, so markWritten is never called...
  check("a failed write leaves the slice dirty", t.changed("k", rows) === true);

  t.markWritten("k", rows);
  check("and once it lands, it is clean", t.changed("k", rows) === false);
  t.forget("k");
  check("forget makes it dirty again", t.changed("k", rows) === true);

  check("the code marks written only INSIDE .then, after it resolves",
    /\.then\(r => \{ saveDirty\.markWritten\('secondary:' \+ key, value\); return r; \}\)/.test(code));
  check("and for ticket history, only after the await",
    /await mergeLegacySlice\(docName, 'histories', outgoing, 'entryId'\);\s*saveDirty\.markWritten\('hist:' \+ docName, outgoing\);/.test(code));
  check("nothing is marked before its write is issued",
    !/saveDirty\.markWritten\([^)]*\);\s*await mergeLegacySlice/.test(code));
}

console.log("\nA load resets it, because the data underneath changed");
{
  check("loadData forgets everything", /saveDirty\.forget\(\);/.test(code));
  const t = D.create();
  t.markWritten("a", [1]); t.markWritten("b", [2]);
  t.forget();
  check("forget with no key clears every slice",
    t.changed("a", [1]) === true && t.changed("b", [2]) === true);
}

console.log("\nAn unfingerprintable payload is always sent");
{
  // Refusing to fingerprint must mean "send it", never "skip it". A wrong
  // 'unchanged' is a lost write.
  const cyclic = {}; cyclic.self = cyclic;
  check("a cyclic value cannot be fingerprinted", D.fingerprint(cyclic) === null);
  const t = D.create();
  check("and is therefore always sent", t.changed("k", cyclic) === true);
  t.markWritten("k", cyclic);
  check("marking it does not make it look clean", t.changed("k", cyclic) === true);
  check("undefined is also always sent", t.changed("u", undefined) === true);
}

console.log("\nThe fingerprint distinguishes what it must");
{
  check("length is part of it, so different sizes cannot collide",
    D.fingerprint([1, 2]).split(":")[0] !== D.fingerprint([1, 2, 3]).split(":")[0]);
  check("equal values fingerprint equally",
    D.fingerprint({ a: 1, b: [2, 3] }) === D.fingerprint({ a: 1, b: [2, 3] }));
  check("nested changes are caught",
    D.fingerprint({ a: { b: 1 } }) !== D.fingerprint({ a: { b: 2 } }));
  check("empty is stable", D.fingerprint([]) === D.fingerprint([]));
  check("empty array and empty object differ",
    D.fingerprint([]) !== D.fingerprint({}));

  // A rough spread check: near-identical payloads must not share a fingerprint.
  const seen = new Set();
  for (let i = 0; i < 20000; i++) seen.add(D.fingerprint([{ id: i, v: "x" }]));
  check("20,000 near-identical payloads fingerprint distinctly", seen.size === 20000);
}

console.log("\nThe ten sequential writes are issued together");
{
  check("secondary writes are collected, not awaited in the loop",
    /secondaryWrites\.push\(/.test(code));
  check("and there is no await inside the secondary loops any more",
    !/for \(const key of Object\.keys\(secondaryLists\)\) \{\s*await mergeLegacySlice/.test(code) &&
    !/for \(const key of Object\.keys\(secondaryWholeValue\)\) \{\s*await saveLegacySlice/.test(code));
  check("they are settled together", /await Promise\.allSettled\(secondaryWrites\)/.test(code));
  check("allSettled, so one failure does not abandon the other nine",
    /secondaryResults\.forEach\(\(res, i\) => \{\s*if \(res\.status === 'rejected'\)/.test(code));
  check("and a failure is reported by name",
    /secondary\.\$\{secondaryNames\[i\]\} save failed/.test(code));
}

console.log("\nThe expensive slices are the ones that get skipped");
{
  check("ticket history is skipped when unchanged",
    /if \(!saveDirty\.changed\('hist:' \+ docName, outgoing\)\)/.test(code));
  check("secondary slices are skipped when unchanged",
    /if \(!saveDirty\.changed\('secondary:' \+ key, value\)\) continue;/.test(code));
  check("schedules are skipped when unchanged",
    /const schedulesChanged = saveDirty\.changed\('schedules', sectionsToSave\);/.test(code));
  check("and a skipped schedules write is not reported as saved",
    /\.\.\.\(schedulesChanged \? \['schedules'\] : \[\]\)/.test(code));

  // Cash and the audit log are NOT skipped by fingerprint: cash changes on
  // every award, and the audit log has its own send-only-what-is-new path.
  check("the audit log still sends only entries not confirmed stored",
    /return !auditIdsOnServer\.has\(id\);/.test(code));
}

console.log("\nA missing module degrades to saving everything");
{
  // Failing to load wildcat-dirty.js must cost speed, never correctness.
  check("the fallback answers 'changed' to everything",
    /\{ changed: \(\) => true, markWritten: \(\) => \{\}, forget: \(\) => \{\},/.test(code));
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  check("index.html serves it", html.includes("wildcat-dirty.js"));
  check("before script.js",
    html.indexOf("wildcat-dirty.js") < html.indexOf('src="script.js'));
  const v = /wildcat-dirty\.js\?v=([0-9a-z]+)/.exec(html)?.[1];
  const sv = /src="script\.js\?v=([0-9a-z]+)/.exec(html)?.[1];
  check("on the same cache-busting version", v && v === sv);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
