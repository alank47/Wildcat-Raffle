// Changing a staff member's access level from inside the app.
//
// Asked for on 2026-09-09: "if a new teacher joins PBIS I'd like the ability to
// just switch their permissions to PBIS within the system."
//
// The dialog already existed and already had a role dropdown. Two things were
// wrong with it, and the first is the dangerous one:
//
//   1. The change never persisted. saveTeacherEdit assigned teacher.role and
//      called saveData(), but appDataShape's TEACHER_WRITABLE is
//      ["name", "ticketsAwarded"], so the server dropped it. The admin saw the
//      new role on screen and it reverted on the next reload.
//   2. "PBIS Team" was not even an option, which is why the only route onto the
//      PBIS team was a developer running a command.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("./convex/staffInvites.ts", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const start = script.indexOf("async function saveTeacherEdit()");
const end = script.indexOf("\n        async function deleteTeacher", start);
const fn = script.slice(start, end);

console.log("\n-- located --");
check("saveTeacherEdit found and bounded", start !== -1 && end > start && fn.length > 800);

console.log("\n-- every role is offered, PBIS included --");
{
  const sel = html.slice(html.indexOf('id="editTeacherRole"'), html.indexOf("</select>", html.indexOf('id="editTeacherRole"')));
  ["teacher", "campusaide", "pbis", "admin", "superadmin"].forEach((r) =>
    check(`${r} is selectable`, sel.includes(`value="${r}"`)));
  check("each option says what it grants, not just its name", /every student, all referrals/.test(sel));
}

console.log("\n-- the change actually reaches the server --");
{
  check("it calls the dedicated mutation", /convexMutation\('staffInvites:setStaffRole'/.test(fn));
  check("it passes the target's email and the new role", /email: teacher\.email \|\| '', role: role/.test(fn));
  check("and the caller's token", /session\.idToken/.test(fn));
  check("the function is async so it can await it", /^async function saveTeacherEdit\(\)/.test(fn));
  // The whole-app save must NOT be the thing carrying the role.
  check("it does not rely on saveData to persist the role",
    fn.indexOf("convexMutation('staffInvites:setStaffRole'") < fn.indexOf("saveData();"));
  check("nothing is sent when the role did not change", /if \(role !== previousRole\)/.test(fn));
}

console.log("\n-- the screen never shows a role the server refused --");
{
  check("the local role is reverted before asking", /teacher\.role = previousRole;/.test(fn));
  check("and only adopted from the server's answer", /teacher\.role = roleResult\.role;/.test(fn));
  check("a failure is reported, not swallowed", /did NOT change/.test(fn));
  check("the dropdown is put back to the real role on failure",
    /getElementById\('editTeacherRole'\)\.value = previousRole/.test(fn));
  check("the dialog stays open on failure so it is not missed",
    fn.indexOf("did NOT change") < fn.indexOf("closeEditTeacherModal()"));
  check("a username session is told why rather than failing silently",
    /needs a Microsoft sign-in/.test(fn));
  check("success says they must sign in again for it to take effect",
    /sign out and back in/.test(fn));
}

console.log("\n-- the server decides, and writes it down --");
{
  check("the mutation exists", /export const setStaffRole = mutation/.test(server));
  check("it requires staff identity", /await requireStaff\(ctx\)/.test(server.slice(server.indexOf("setStaffRole"))));
  check("every decision comes from the tested rule", /roleChangeVerdict\(\{/.test(server));
  check("a refusal throws rather than patching", /if \(!verdict\.ok\) throw new ConvexError/.test(server));
  check("the superadmin count is measured, not assumed",
    /filter\(\(t\) => t\.role === "superadmin"\)\.length/.test(server));
  check("the change is written to the audit log", /appAuditLog/.test(server));
  check("the audit entry records who did it and what changed",
    /previousRole/.test(server) && /Changed access level/.test(server));
  check("the audit entry uses the payload shape the reader expects",
    /payload: \{/.test(server.slice(server.indexOf("setStaffRole"))));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
