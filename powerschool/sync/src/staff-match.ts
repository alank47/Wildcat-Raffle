/**
 * Keep Wildcat Hub staff matched to the people who actually work at Westbrook.
 *
 *   npm run staff:match           report only
 *   npm run staff:match -- --apply   also create rows for unmatched staff
 *
 * THREE SOURCES, EACH AUTHORITATIVE FOR EXACTLY ONE THING
 *
 *   PowerSchool  WHO works at this school.   SchoolStaff at school 1817.
 *   Entra ID     WHETHER the account is real and still enabled.
 *   Convex       WHETHER the app knows about them, and at what role.
 *
 * Getting that split wrong is not academic. The first version of this script
 * asked Entra alone "who is staff" and got 256 people who would supposedly be
 * locked out. That list included a CONFERENCE ROOM (westbrook-conf@), two
 * shared mailboxes, a council distribution address, three vacancy placeholders,
 * and every LA Promise Fund employee at every other site. Provisioning it would
 * have handed app access, including the ability to move a child's balance, to
 * most of the organization.
 *
 * The directory cannot answer the question. `department` is empty for 456 of
 * 543 users, including four of six known Westbrook staff, and the tenant holds
 * 123 Guest accounts. PowerSchool knows exactly who works here, because
 * somebody employs them.
 *
 * WHY NOT A SCHEDULED SERVER SIDE SYNC
 *
 * Graph application permissions need a client secret and an admin consent
 * cycle. The Wildcat Hub app registration is a SPA and holds no secret. This
 * runs as a signed in human via `az`, which needs nothing new. When a secret
 * exists this logic moves into a Convex action unchanged; the matching rules
 * are the hard part and they are here.
 *
 * MATCH ON `mail`, NOT `userPrincipalName`. They differ for 147 of 543 users in
 * this tenant, and matching on the wrong one silently fails to find people who
 * are present, which is indistinguishable from them not existing.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.ts";
import { PowerSchoolClient } from "./client.ts";
import { QUERY_PREFIX } from "./manifest.ts";

const APPLY = process.argv.includes("--apply");

/** Repo root. This path contains spaces, so .pathname would percent-encode them. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function convex(fn: string, args: unknown = {}): any {
  try {
    const out = execFileSync("npx", ["convex", "run", fn, JSON.stringify(args)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      cwd: REPO_ROOT,
    });
    return JSON.parse(out);
  } catch (error: any) {
    const detail = String(error.stderr ?? "").trim() || String(error.message ?? error);
    throw new Error(`convex run ${fn} failed.\n${detail}`);
  }
}

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

const config: Config = await loadConfig();
const client = new PowerSchoolClient(config, () => {});

console.log(`\nStaff match  ${new Date().toISOString()}`);
console.log("=".repeat(72));
console.log(`  mode  ${APPLY ? "APPLY, will create rows for unmatched staff" : "report only"}\n`);

// ---- 1. PowerSchool: who works here ---------------------------------------
// staff_status 1 is active AT THIS SCHOOL. The query returns 81 rows because it
// includes people attached to the school who are no longer active, and counting
// those as staff is how a departed employee keeps their access.
const { rows: allStaff } = await client.namedQuery(`${QUERY_PREFIX}.staff`, {
  schoolid: config.schoolId,
});
const employed = allStaff
  .filter((r: any) => String(r.staff_status) === "1")
  .map((r: any) => ({
    email: norm(r.email_addr),
    name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
    teacherNumber: String(r.teacher_number ?? ""),
    hasSections: Number(r.section_count) > 0,
  }))
  .filter((r) => r.email.includes("@"));

console.log(`  PowerSchool   ${allStaff.length} attached to the school, ${employed.length} active with an email`);

// ---- 2. Entra: is the account real and enabled? ----------------------------
let directory: Array<Record<string, any>> = [];
try {
  directory = JSON.parse(
    execFileSync(
      "az",
      [
        "rest",
        "--method",
        "get",
        "--uri",
        "https://graph.microsoft.com/v1.0/users?$select=mail,userPrincipalName,displayName,accountEnabled,userType&$top=999",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    ),
  ).value;
} catch {
  console.log("  Entra         UNAVAILABLE. Run `az login` to include the directory check.\n");
}

const entra = new Map<string, { enabled: boolean; guest: boolean; name: string }>();
for (const u of directory) {
  const key = norm(u.mail) || norm(u.userPrincipalName);
  if (!key) continue;
  entra.set(key, {
    enabled: u.accountEnabled !== false,
    guest: String(u.userType) === "Guest",
    name: u.displayName ?? "",
  });
}
if (directory.length) console.log(`  Entra         ${directory.length} users in the tenant`);

// ---- 3. Convex: what the app knows ----------------------------------------
const teachers = convex("seed:exportStaffEmails");
const known = new Set(teachers.map((t: any) => norm(t.email)));
console.log(`  App           ${teachers.length} staff rows with an email\n`);

// ---- the three questions ---------------------------------------------------
const missing = employed.filter((s) => !known.has(s.email));
const employedEmails = new Set(employed.map((s) => s.email));
const notEmployed = teachers.filter((t: any) => !employedEmails.has(norm(t.email)));
const noDirectoryAccount = employed.filter(
  (s) => directory.length > 0 && !entra.has(s.email),
);
const disabled = employed.filter((s) => entra.get(s.email)?.enabled === false);

function section(title: string, why: string, rows: string[]) {
  console.log(title);
  console.log(`  ${why}\n`);
  if (rows.length === 0) console.log("    none\n");
  else {
    for (const line of rows) console.log(`    ${line}`);
    console.log("");
  }
}

section(
  "EMPLOYED HERE, NO APP ROW",
  "These people can authenticate and are then refused. After the Convex\n  cutover that refusal locks them out of the whole app, not one endpoint.",
  missing.map((s) => `${s.email.padEnd(38)} ${s.name}${s.hasSections ? "  (teaches)" : ""}`),
);

section(
  "HAS AN APP ROW, NOT ACTIVE STAFF HERE",
  "Usually somebody who left. Their row is NOT deleted by this script: a\n  departed teacher still appears in ticket history and audit records.",
  notEmployed.map((t: any) => `${norm(t.email).padEnd(38)} ${t.legacyId}`),
);

if (directory.length) {
  section(
    "EMPLOYED HERE, NO DIRECTORY ACCOUNT",
    "PowerSchool says they work here but Entra has no such address, so they\n  cannot sign in at all. Usually a typo in one system or the other.",
    noDirectoryAccount.map((s) => `${s.email.padEnd(38)} ${s.name}`),
  );
  section(
    "EMPLOYED HERE, DIRECTORY ACCOUNT DISABLED",
    "Employed on paper, account switched off. Do not provision these.",
    disabled.map((s) => `${s.email.padEnd(38)} ${s.name}`),
  );
}

console.log("=".repeat(72));
console.log(`  matched                 ${employed.length - missing.length}`);
console.log(`  would be locked out     ${missing.length}`);
console.log(`  rows for non staff      ${notEmployed.length}`);
if (directory.length) {
  console.log(`  no directory account    ${noDirectoryAccount.length}`);
  console.log(`  directory disabled      ${disabled.length}`);
}

// ---- provisioning ----------------------------------------------------------
// Only people PowerSchool says are employed here AND Entra says have a live,
// non guest account. Both gates, because either alone admits the wrong people.
const provisionable = missing.filter((s) => {
  if (directory.length === 0) return false; // no directory, no provisioning
  const account = entra.get(s.email);
  return Boolean(account?.enabled) && !account?.guest;
});

if (!APPLY) {
  console.log(`\nReport only. Nothing was written.`);
  if (provisionable.length) {
    console.log(`Re-run with --apply to create ${provisionable.length} row(s) at role "teacher".`);
  }
  console.log("");
  process.exit(0);
}

if (provisionable.length === 0) {
  console.log("\nNothing to provision.\n");
  process.exit(0);
}

const result = convex("seed:provisionStaff", {
  staff: provisionable.map((s) => ({ email: s.email, name: s.name })),
});
console.log(`\nCreated ${result.created} staff row(s) at role "teacher". ${result.skipped} already existed.`);
console.log("Roles are NOT taken from any directory. An admin assigns them.\n");
