// A server-written audit entry must look like the app's own.
//
// FOUND 2026-09-10 while checking the audit log after launch. One role change
// had produced TWO rows:
//
//   rowEntryId "role_1788977222949_kl9t4i2lil"  payload.entryId null
//   rowEntryId "e_dyrrzu"                       payload.entryId "e_dyrrzu"
//
// setStaffRole wrote entryId as a COLUMN but not inside `payload`. The browser
// reads entries out of payload and runs ensureEntryId on each, which trusts a
// string payload.entryId and otherwise DERIVES one from the contents. So the
// entry arrived looking unidentified, the client minted its own id, and
// uploaded the same event back as a second row.
//
// Bounded -- the derived id is a content hash, so every client agrees on it and
// append dedupes the rest -- but bounded is not harmless in a log whose whole
// job is answering "who did this, once". The PBIS team reads this log.
//
// Run: npm test

import { readFileSync } from "node:fs";

const server = readFileSync(new URL("./convex/staffInvites.ts", import.meta.url), "utf8");
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const fn = server.slice(server.indexOf("export const setStaffRole"));

console.log("\n-- the id is in both places --");
{
  check("an entryId is minted once into a variable", /const entryId = `role_/.test(fn));
  check("the column uses it", /\n\s*entryId,\n\s*timestamp: now,/.test(fn));
  check("and the payload repeats it", /payload: \{[\s\S]{0,200}\n\s*entryId,/.test(fn));
  // The exact failure: an id in the column only.
  check("the old column-only shape is gone",
    !/entryId: `role_\$\{Date\.now\(\)\}_\$\{Math\.random/.test(fn));
}

console.log("\n-- the client will now trust it rather than re-derive --");
{
  const ensure = script.slice(script.indexOf("function ensureEntryId"), script.indexOf("function ensureEntryId") + 700);
  check("ensureEntryId trusts a string entryId",
    /if \(entry && entry\.entryId && typeof entry\.entryId === 'string'\) return entry\.entryId;/.test(ensure));
  // If it ever became random rather than derived, one duplicate per client
  // would become one per load. Worth pinning.
  check("the fallback id is DERIVED from contents, not random",
    /entry\.timestamp \|\| ''/.test(ensure) && !/crypto|Math\.random/.test(ensure));
  check("it hashes the fields that identify an entry",
    /entry\.studentId/.test(ensure) && /entry\.teacher/.test(ensure) && /entry\.action/.test(ensure));
}

console.log("\n-- the entry reads correctly in the tables --");
{
  // The app's own entries carry `reason`, and the audit tables render that.
  // `details` alone showed as a blank cell.
  check("the payload carries reason", /reason: `\$\{targetRow\.name/.test(fn));
  check("and keeps details for anything reading that", /details: `\$\{targetRow\.name/.test(fn));
  check("it records who made the change", /teacher: actor\.name \|\| actor\.email/.test(fn));
  check("and what it was before", /previousRole/.test(fn));
  // Bounded to the payload block itself rather than a character window. The
  // first version used {0,400} and failed because the comments inside the
  // payload are longer than that -- a test that measures distance breaks on
  // an edit that changes nothing.
  const payload = fn.slice(fn.indexOf("payload: {"), fn.indexOf("\n    });", fn.indexOf("payload: {")));
  check("the payload block was located", payload.length > 100 && payload.length < 2000);
  check("with a timestamp inside the payload as well as the column",
    /\btimestamp: now,/.test(payload));
  check("and the actor's email, so the entry survives a rename",
    /userId: actor\.email/.test(payload));
}

console.log("\n-- the dedupe this depends on is still in place --");
{
  const audit = readFileSync(new URL("./convex/auditLog.ts", import.meta.url), "utf8");
  check("append looks an entry up by entryId before inserting",
    /withIndex\("by_entryId", \(q\) => q\.eq\("entryId", id\)\)/.test(audit));
  check("and skips one it already has", /if \(existing\) \{ alreadyStored\+\+; continue; \}/.test(audit));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
