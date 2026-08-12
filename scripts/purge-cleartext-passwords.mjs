#!/usr/bin/env node
/**
 * Step 6: delete the cleartext passwords from Firestore.
 *
 * This is the last step of the migration and the only irreversible one. Forty
 * staff passwords are stored in plaintext in a world-readable document; that is
 * the hole this whole effort exists to close. But deleting them also removes
 * the only way into the system that does not depend on Entra, so running it
 * early locks out the entire staff of a system in daily use.
 *
 * THE GATE IS MECHANICAL, NOT ADVISORY. This refuses to run until enough
 * DISTINCT staff have actually completed a federated sign-in, proven by rows
 * in the authEvents table that only Convex-authenticated callers can write.
 * A runbook step gets skipped under pressure; an interlock does not.
 *
 *   CONVEX_DEPLOY_KEY=$(op read 'op://Employee/Westbrook WildCats Hub/Convex wildcat-hub-ci Deploy Key') \
 *     node scripts/purge-cleartext-passwords.mjs          # dry run, always safe
 *
 *   ... node scripts/purge-cleartext-passwords.mjs --commit
 *
 * A full backup is written before any change.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const REQUIRED_STAFF_SIGNINS = 3;
const FIRESTORE =
  "https://firestore.googleapis.com/v1/projects/wildcat-hub-94025/databases/(default)/documents/raffle_data/main";

const commit = process.argv.includes("--commit");

function run(fn, args = {}) {
  return JSON.parse(
    execFileSync("npx", ["convex", "run", fn, JSON.stringify(args)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
    }),
  );
}

console.log(`\nPurge cleartext passwords  ${commit ? "(COMMIT)" : "(dry run)"}\n${"=".repeat(58)}`);

// ---- THE GATE -----------------------------------------------------------
if (!process.env.CONVEX_DEPLOY_KEY) {
  console.error("CONVEX_DEPLOY_KEY is not set.");
  process.exit(1);
}
const readiness = run("authEvents:readiness");
console.log(`\n  distinct staff who have signed in with Entra: ${readiness.distinctStaff}`);
console.log(`  required before purging:                     ${REQUIRED_STAFF_SIGNINS}`);
console.log(`  last federated sign-in:                      ${readiness.lastAt ?? "never"}`);

if (readiness.distinctStaff < REQUIRED_STAFF_SIGNINS) {
  console.log(`\n${"=".repeat(58)}`);
  console.log("REFUSING TO PURGE.");
  console.log(
    `\nOnly ${readiness.distinctStaff} of ${REQUIRED_STAFF_SIGNINS} required staff have proven that\n` +
    "Entra sign-in works. Deleting the passwords now would remove the only\n" +
    "other way in, for everyone, on a system used every day.\n\n" +
    "Have staff sign in at https://wildcatraffle.com with Microsoft, then\n" +
    "re-run this. Nothing has been changed.\n",
  );
  process.exit(2);
}

// ---- backup, then purge --------------------------------------------------
const res = await fetch(FIRESTORE);
if (!res.ok) { console.error(`Firestore read failed: HTTP ${res.status}`); process.exit(1); }
const doc = await res.json();

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `/tmp/BACKUP-before-password-purge-${stamp}.json`;
writeFileSync(backup, JSON.stringify(doc));
console.log(`\n  backup written: ${backup}`);

const teachers = doc.fields.teachers;
let withPassword = 0;
for (const entry of teachers.arrayValue.values ?? []) {
  const f = entry.mapValue.fields ?? {};
  if ("password" in f) { withPassword++; if (commit) delete f.password; }
}
console.log(`  teacher records carrying a password: ${withPassword}`);

if (!commit) {
  console.log(`\n${"=".repeat(58)}`);
  console.log("DRY RUN. Nothing changed. Re-run with --commit to purge.\n");
  process.exit(0);
}

// updateMask so only `teachers` is written; students are never in the request.
const patch = await fetch(`${FIRESTORE}?updateMask.fieldPaths=teachers`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ fields: { teachers } }),
});
console.log(`  PATCH: HTTP ${patch.status}`);

const verify = await (await fetch(FIRESTORE)).json();
const left = (verify.fields.teachers.arrayValue.values ?? []).filter(
  (e) => "password" in (e.mapValue.fields ?? {}),
).length;
console.log(`  passwords remaining after purge: ${left}`);
console.log(`\n${"=".repeat(58)}`);
console.log(left === 0 ? "PURGED. No cleartext passwords remain.\n"
                       : `INCOMPLETE: ${left} still present. Restore from ${backup} if needed.\n`);
