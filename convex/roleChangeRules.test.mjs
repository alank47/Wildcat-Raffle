// Who may change whose role.
//
// Asked for on 2026-09-09: "if a new teacher joins PBIS I'd like the ability to
// just switch their permissions to PBIS within the system."
//
// The Edit Teacher dialog already had a role dropdown, and it did nothing that
// lasted: appDataShape's TEACHER_WRITABLE is ["name", "ticketsAwarded"], so the
// role was dropped by the server and reverted on the next reload. An admin
// would have seen the change apply and believed it.
//
// The assertions that matter here are the refusals. A role is the only thing in
// this app that decides who can read the whole school's discipline record, so
// the ways this must NOT work are the specification.
//
// Run: npm test

import { roleChangeVerdict, canChangeRoles, ASSIGNABLE_ROLES } from "./roleChangeRules.ts";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const req = (o) => Object.assign({
  actorEmail: "admin@x.org", actorRole: "admin",
  targetEmail: "t@x.org", targetRole: "teacher",
  newRole: "pbis", superadminCount: 2,
}, o);

console.log("\n-- the thing that was asked for --");
{
  const v = roleChangeVerdict(req({}));
  check("an admin can move a teacher onto the PBIS team", v.ok && v.newRole === "pbis");
  check("a superadmin can too", roleChangeVerdict(req({ actorRole: "superadmin" })).ok);
  check("and back off it again",
    roleChangeVerdict(req({ targetRole: "pbis", newRole: "teacher" })).ok);
  check("pbis is an assignable role at all", ASSIGNABLE_ROLES.includes("pbis"));
  check("so are the other four",
    ["teacher", "campusaide", "admin", "superadmin"].every((r) => ASSIGNABLE_ROLES.includes(r)));
}

console.log("\n-- who may not --");
{
  check("a teacher cannot", !roleChangeVerdict(req({ actorRole: "teacher" })).ok);
  check("a campus aide cannot", !roleChangeVerdict(req({ actorRole: "campusaide" })).ok);
  // Deliberate. A PBIS member who could hand out roles could make themselves
  // superadmin, which is not the permission that was asked for.
  check("PBIS cannot -- it was not asked for and it is self-promotion",
    !roleChangeVerdict(req({ actorRole: "pbis" })).ok);
  check("canChangeRoles agrees", canChangeRoles("admin") && canChangeRoles("superadmin")
    && !canChangeRoles("pbis") && !canChangeRoles("teacher"));
  check("an empty role cannot", !roleChangeVerdict(req({ actorRole: "" })).ok);
  check("the refusal names administrators, so the reader knows who to ask",
    /administrators/i.test(roleChangeVerdict(req({ actorRole: "teacher" })).reason));
}

console.log("\n-- nobody changes their own role --");
{
  const self = roleChangeVerdict(req({
    actorEmail: "a@x.org", targetEmail: "a@x.org", actorRole: "superadmin", targetRole: "superadmin",
    newRole: "teacher", superadminCount: 3,
  }));
  check("a superadmin cannot demote themselves out of the app", !self.ok);
  check("an admin cannot promote themselves", !roleChangeVerdict(req({
    actorEmail: "a@x.org", targetEmail: "a@x.org", targetRole: "admin", newRole: "superadmin",
  })).ok);
  check("case and whitespace do not defeat the check", !roleChangeVerdict(req({
    actorEmail: "A@X.org ", targetEmail: " a@x.ORG", targetRole: "admin", newRole: "pbis",
  })).ok);
  check("it says to ask another administrator",
    /another administrator/i.test(roleChangeVerdict(req({
      actorEmail: "a@x.org", targetEmail: "a@x.org", newRole: "pbis" })).reason));
}

console.log("\n-- superadmin is granted by superadmins only, both directions --");
{
  check("an admin cannot mint a superadmin",
    !roleChangeVerdict(req({ actorRole: "admin", newRole: "superadmin" })).ok);
  check("an admin cannot demote a superadmin",
    !roleChangeVerdict(req({ actorRole: "admin", targetRole: "superadmin", newRole: "teacher" })).ok);
  check("a superadmin can do both",
    roleChangeVerdict(req({ actorRole: "superadmin", newRole: "superadmin" })).ok &&
    roleChangeVerdict(req({ actorRole: "superadmin", targetRole: "superadmin", newRole: "teacher", superadminCount: 2 })).ok);
}

console.log("\n-- the last superadmin stays --");
{
  const last = roleChangeVerdict(req({
    actorRole: "superadmin", actorEmail: "other@x.org",
    targetRole: "superadmin", newRole: "teacher", superadminCount: 1,
  }));
  check("demoting the only superadmin is refused", !last.ok);
  check("and it explains why", /only super admin/i.test(last.reason));
  check("with two, it is allowed", roleChangeVerdict(req({
    actorRole: "superadmin", actorEmail: "other@x.org",
    targetRole: "superadmin", newRole: "teacher", superadminCount: 2,
  })).ok);
  // A superadmin staying a superadmin is not a demotion.
  check("re-saving the only superadmin as superadmin is not blocked by this rule",
    !/only super admin/i.test(roleChangeVerdict(req({
      actorRole: "superadmin", actorEmail: "other@x.org",
      targetRole: "superadmin", newRole: "superadmin", superadminCount: 1,
    })).reason || ""));
}

console.log("\n-- bad input is refused, never coerced --");
{
  check("an unknown role", !roleChangeVerdict(req({ newRole: "principal" })).ok);
  check("and it lists the real ones",
    /teacher, campusaide, pbis, admin, superadmin/.test(roleChangeVerdict(req({ newRole: "principal" })).reason));
  check("an empty role", !roleChangeVerdict(req({ newRole: "" })).ok);
  check("a missing target", !roleChangeVerdict(req({ targetEmail: "" })).ok);
  check("SUPERADMIN in capitals still resolves", roleChangeVerdict(req({
    actorRole: "SuperAdmin", newRole: "PBIS" })).ok);
  check("a no-op change is refused rather than written",
    !roleChangeVerdict(req({ targetRole: "pbis", newRole: "pbis" })).ok);
  check("and says they already have it",
    /already/i.test(roleChangeVerdict(req({ targetRole: "pbis", newRole: "pbis" })).reason));
}

console.log("\n-- role is still not writable through the whole-app save --");
{
  const shape = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("./appDataShape.ts", import.meta.url), "utf8"));
  check("TEACHER_WRITABLE does not include role", /TEACHER_WRITABLE = \["name", "ticketsAwarded"\]/.test(shape));
  check("nor does it include email", !/TEACHER_WRITABLE[^\]]*email/.test(shape));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
