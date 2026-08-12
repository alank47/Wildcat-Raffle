#!/usr/bin/env node
/**
 * Mirror the Entra directory into Convex so the app can search it.
 *
 *   npm run staff:mirror
 *
 * WHY A MIRROR AND NOT A LIVE QUERY. The app cannot call Microsoft Graph. That
 * needs application permissions and a client secret, and the Wildcat Hub
 * registration is a SPA that holds neither; adding one is an admin consent
 * cycle. This runs as a signed-in human through `az`, which needs nothing new.
 * When a secret exists, this becomes a Convex action on a cron and the table it
 * writes does not change.
 *
 * WHAT IT WRITES, and what it deliberately does not:
 *
 *   included   name, email, job title, department
 *   excluded   everything else. A mirror is a copy of colleagues' personal data
 *              and every extra column is a copy somebody has to justify.
 *
 * FILTERED BEFORE IT LEAVES THIS SCRIPT:
 *   - staff domain only
 *   - enabled accounts only, so somebody who left cannot be invited
 *   - no Guest accounts. The tenant holds 123 of them and none is staff here.
 *
 * Full replace, so a departure disappears on the next run rather than lingering
 * as an invitable name forever.
 */

import { execFileSync } from "node:child_process";

const STAFF_DOMAIN = (process.env.STAFF_DOMAIN || "lapromisefund.org").toLowerCase();

function run(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function convex(fn, args) {
  try {
    return JSON.parse(run("npx", ["convex", "run", fn, JSON.stringify(args)]));
  } catch (error) {
    const detail = String(error.stderr ?? "").trim() || String(error.message ?? error);
    throw new Error(`convex run ${fn} failed.\n${detail}`);
  }
}

console.log(`\nEntra directory mirror  ${new Date().toISOString()}`);
console.log("=".repeat(64));
console.log(`  staff domain  ${STAFF_DOMAIN}\n`);

let users;
try {
  users = JSON.parse(
    run("az", [
      "rest",
      "--method", "get",
      "--uri",
      "https://graph.microsoft.com/v1.0/users?$select=mail,userPrincipalName,displayName,accountEnabled,userType,jobTitle,department&$top=999",
    ]),
  ).value;
} catch (error) {
  console.error("Could not read the directory. Run `az login` and try again.\n");
  console.error(String(error.message ?? error).slice(0, 300));
  process.exit(1);
}

const norm = (v) => String(v ?? "").trim().toLowerCase();

const people = users
  .map((u) => ({
    // mail, NOT userPrincipalName: they differ for 147 of 543 users here, and
    // the email is what a token carries and what teachers rows are keyed by.
    email: norm(u.mail),
    name: u.displayName || "",
    jobTitle: u.jobTitle || undefined,
    department: u.department || undefined,
    enabled: u.accountEnabled !== false,
    guest: String(u.userType) === "Guest",
  }))
  .filter((u) => u.email.endsWith(`@${STAFF_DOMAIN}`) && u.enabled && !u.guest)
  .map(({ email, name, jobTitle, department }) => ({ email, name, jobTitle, department }));

console.log(`  tenant users     ${users.length}`);
console.log(`  mirrored         ${people.length}  (staff domain, enabled, not guests)`);

const result = convex("staffInvites:replaceDirectory", { people });
console.log(`\n  removed ${result.removed}, wrote ${result.written}`);
console.log(`  mirroredAt ${result.mirroredAt}\n`);
