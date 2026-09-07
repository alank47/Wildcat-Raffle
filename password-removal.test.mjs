// There is no password login, and nothing may pretend there is.
//
// The teachers table has carried no `password` and no `username` column since
// the Convex migration deleted them -- that deletion is the reason the
// migration exists. Everything built on those columns therefore could not work:
//
//   login()               compared undefined against whatever was typed, so it
//                         refused every attempt and could only ever say
//                         "Invalid username or password"
//   changePassword()      compared against currentUser.password, undefined for
//                         everyone
//   resetTeacherPassword  set teacher.password, which appDataShape does not
//                         list as writable so nothing persisted it, then told
//                         the admin "Password reset successfully / New
//                         password: X / share this with the teacher securely"
//
// That last one is why this file exists rather than a comment. An admin could
// hand somebody a password that had never existed, for a login that does not
// exist, and be told it worked.
//
// All 400 recorded sign-ins are microsoft.com or google.com.
//
// Run: npm test

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const strip = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const code = strip(readFileSync(new URL("./script.js", import.meta.url), "utf8"));
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8")
  .replace(/<!--[\s\S]*?-->/g, "");
const schema = readFileSync(new URL("./convex/schema.ts", import.meta.url), "utf8");
const shape = readFileSync(new URL("./convex/appDataShape.ts", import.meta.url), "utf8");

console.log("\nThe columns it all rested on do not exist");
{
  const t = schema.slice(schema.indexOf("teachers: defineTable"),
                         schema.indexOf("students: defineTable"));
  check("the teachers table has no password column", !/^\s*password:/m.test(t));
  check("and no username column", !/^\s*username:/m.test(t));
  check("the deletion is recorded as deliberate, not accidental",
    /no `password` field, deliberately/.test(schema));
  check("and a browser cannot write one either",
    !/["']password["']/.test(shape.slice(shape.indexOf("TEACHER_WRITABLE"),
                                         shape.indexOf("TEACHER_WRITABLE") + 200)));
}

console.log("\nNothing offers a password on screen");
{
  for (const id of ["loginUsername", "loginPassword", "currentPasswordInput",
                    "newPasswordInput", "adminUsername", "adminPassword"]) {
    check(`#${id} is gone`, !html.includes(id));
  }
  check("no Change Password control", !/showChangePassword|changePasswordModal/.test(html));
  check("no Create Admin control", !/createAdminAccount|showCreateAdmin/.test(html));
  check("and no password input of any kind on the login screen",
    !/<input[^>]*type="password"/.test(html));
}

console.log("\nAnd nothing behind the screen either");
{
  for (const fn of ["login", "showChangePassword", "changePassword",
                    "resetTeacherPassword", "createAdminAccount", "showCreateAdmin"]) {
    const called = new RegExp(`(?<![A-Za-z0-9_.$])${fn}\\s*\\(`);
    check(`${fn} is neither defined nor called`,
      !called.test(code) && !called.test(html));
  }
  // The one that lied. Named separately so a search for the message finds this.
  check("nothing tells an admin a password was reset",
    !/Password reset successfully/.test(code));
  check("and nothing prints a password into an alert",
    !/New password: \$\{/.test(code));
}

console.log("\nThe federated routes are untouched");
{
  check("the Microsoft button is still there", /id="entraSignInBtn"/.test(html));
  check("the Google container is still there", /id="googleSignInButton"/.test(html));
  check("establishTeacherSession survives -- it is the shared session path",
    /async function establishTeacherSession\(/.test(code));
  check("and both federated routes still reach it",
    /establishTeacherSession\(teacher\)/.test(
      readFileSync(new URL("./wildcat-auth.js", import.meta.url), "utf8")));

  // Logout cleared #loginUsername and #loginPassword. Reading .value off null
  // throws, and the comment on that line records the last time exactly that
  // happened there -- with #studentLoginId, removed the same way.
  check("logout does not touch the removed inputs",
    !/getElementById\('loginUsername'\)|getElementById\('loginPassword'\)/.test(code));
  check("the repeat of that mistake is written down where it happened",
    /second removal to nearly break logout/.test(
      readFileSync(new URL("./script.js", import.meta.url), "utf8")));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
