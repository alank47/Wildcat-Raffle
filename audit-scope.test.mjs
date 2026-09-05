// The audit log's two halves, and the scope mistake that broke both.
//
// Awards made from a teacher's account showed on her own screen and nowhere
// else. The newest row in appAuditLog was sixteen hours old while awards were
// still being made, and every diagnostic reported knownOnServer: 0.
//
// One cause, twice. Both the audit READ and the audit APPEND used `auth` and
// `session` borrowed from a const pair declared inside a DIFFERENT block that
// had already closed. Each threw ReferenceError on first use; each was wrapped
// in a try/catch that turned it into a console line nobody had open.
//
//   read broken  -> an account saw only the legacy documents, never the table
//   append broken -> nothing new ever reached the table
//
// Together: an award existed in one browser's memory and in no other place.
//
// Run: npm test

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const raw = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const lines = raw.split("\n");

/**
 * Every bare `auth.convex*` / `session.idToken` must have a declaration of that
 * name at an indent that can enclose it, inside the same top-level function.
 *
 * This is the check that would have caught it. `ctx.auth.…` is a different
 * object and is deliberately not matched.
 */
function outOfScopeUses() {
  const useRe = /(?<![.\w])(auth\.convex|session\.idToken)/;
  const declRe = /(?<![.\w])(?:const|let|var)\s+(auth|session)\s*=/;
  const fnRe = /^\s*(async )?function /;
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!useRe.test(l)) continue;
    const ind = l.length - l.trimStart().length;
    let found = false;
    for (let j = i - 1; j >= 0; j--) {
      const pl = lines[j];
      if (!pl.trim()) continue;
      const pind = pl.length - pl.trimStart().length;
      if (declRe.test(pl) && pind <= ind) { found = true; break; }
      if (pind === 8 && fnRe.test(pl)) break;   // left the enclosing function
    }
    if (!found) bad.push(`line ${i + 1}: ${l.trim().slice(0, 70)}`);
  }
  return bad;
}

console.log("\nNo Convex call borrows a session from a block that has closed");
{
  const bad = outOfScopeUses();
  if (bad.length) bad.forEach((b) => console.log("        " + b));
  check(`every bare auth/session use has an enclosing declaration (${bad.length} bad)`,
    bad.length === 0);
}

console.log("\nBoth halves of the audit log declare their own");
{
  const readIdx = raw.indexOf("auditIdsOnServer = new Set();");
  const readBlock = raw.slice(readIdx, raw.indexOf("monthlyAuditSnaps.forEach", readIdx));
  check("the table READ declares auth", /const auth = window\.WildcatAuth;/.test(readBlock));
  check("and session", /const session = auth && auth\.getSession && auth\.getSession\(\);/.test(readBlock));
  check("and refuses to run without one",
    /if \(!auth \|\| !session\) throw new Error\('Not signed in to Convex\.'\);/.test(readBlock));

  const apIdx = raw.indexOf("let auditSaveSucceeded = true;");
  const apBlock = raw.slice(apIdx, raw.indexOf("Clear the outbox only when", apIdx));
  check("the APPEND declares auth", /const auth = window\.WildcatAuth;/.test(apBlock));
  check("and session", /const session = auth && auth\.getSession && auth\.getSession\(\);/.test(apBlock));
  check("and refuses to run without one", /throw new Error\('Not signed in to Convex\.'\);/.test(apBlock));
  check("it still calls auditLog:append", /'auditLog:append'/.test(apBlock));
  check("and only marks entries stored AFTER the server confirms",
    apBlock.indexOf("convexMutation") < apBlock.indexOf("auditIdsOnServer.add"));
}

console.log("\nThe failure is reported, not just swallowed");
{
  check("a failed append is logged loudly",
    /AUDIT LOG SAVE FAILED/.test(raw));
  check("a failed table read says it fell back to documents",
    /table read failed, falling back to documents/.test(raw));
  check("and the read's outcome reaches the diagnostic, not just the console",
    /_wcAuditTableRead/.test(raw));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
