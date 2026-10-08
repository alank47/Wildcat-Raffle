// The Reflection Room list for ONE staff member, until an end date.
// Run: npm test (node --experimental-strip-types)
//
// Build spec 4.6, step 6, modelled on attendance-grant.test.mjs. The list
// names children owing a lunch detention today, so it follows the three
// roles that read the school's discipline record -- admin, superadmin, PBIS
// -- plus a per-person grant an admin gives, for example to the room's
// supervisor or an aide who takes its attendance.
//
// What matters most is what it must NOT do:
//   - open for a teacher or a campus aide who was not given it;
//   - outlive its end date (default: the end of the term), which was review
//     finding B15 -- a grant that never ends is a grant nobody reviews;
//   - open through the Attendance Watch grant, which is a different screen
//     for a different reason (canReadInsights is NOT canReadReflection);
//   - widen into the admin review, the settings, "Read PowerSchool now",
//     the school-day mark, "Room did not run" or uniform logging;
//   - survive a role change, or be set by anyone but an admin, or by anyone
//     on their own record.
//
// TEETH: scripts/reflection-teeth.mjs swaps in canReadInsights, and ignores
// the end date, one at a time, and requires the check named for each to FAIL.
import { readFileSync } from "node:fs";
import { canReadReflection, canAdminReflection, canReadInsights } from "./convex/accessRules.ts";
import { reflectionListVerdict, roleWritePatch, REFLECTION_GRANT_MAX_DAYS } from "./convex/roleChangeRules.ts";
import { clock, loadConvex, makeDb, runtime } from "./fake-convex.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  (" + d + ")" : ""}`); }
};
const J = (x) => JSON.stringify(x);

const TODAY = "2026-10-13";

console.log("\nWho may read the list");
{
  check("admin, superadmin and PBIS, by their role", ["admin", "superadmin", "pbis"].every((r) => canReadReflection({ role: r }, TODAY)));
  check("a teacher is refused, and so is a campus aide", !canReadReflection({ role: "teacher" }, TODAY) && !canReadReflection({ role: "campusaide" }, TODAY));
  check("a campus aide WITH the grant may read it, until its last day",
    canReadReflection({ role: "campusaide", reflectionList: true, reflectionListUntil: "2026-12-18" }, TODAY)
      && canReadReflection({ role: "campusaide", reflectionList: true, reflectionListUntil: TODAY }, TODAY));
  check("expired grant refused: the day after its last day it opens nothing",
    !canReadReflection({ role: "campusaide", reflectionList: true, reflectionListUntil: "2026-10-12" }, TODAY));
  check("a grant with no end date is open (an admin chose that out loud)",
    canReadReflection({ role: "teacher", reflectionList: true }, TODAY));
  check("only a real true counts (not 'true', 1, 'yes')",
    ["true", 1, "yes", {}].every((v) => !canReadReflection({ role: "campusaide", reflectionList: v }, TODAY)));
  check("a malformed end date, or no today to compare it with, fails closed",
    !canReadReflection({ role: "campusaide", reflectionList: true, reflectionListUntil: "12/18/2026" }, TODAY)
      && !canReadReflection({ role: "campusaide", reflectionList: true, reflectionListUntil: "2026-12-18" }, ""));
  check("attendanceWatch alone does not open the list (canReadInsights is not canReadReflection)",
    canReadInsights({ role: "campusaide", attendanceWatch: true })
      && !canReadReflection({ role: "campusaide", attendanceWatch: true }, TODAY));
  check("no row, no access", !canReadReflection(null, TODAY) && !canReadReflection(undefined, TODAY));
  check("the list's ADMIN side is the three roles, never a grant",
    ["admin", "superadmin", "pbis"].every((r) => canAdminReflection({ role: r }))
      && !canAdminReflection({ role: "campusaide", reflectionList: true, reflectionListUntil: "2026-12-18" }));
}

console.log("\nWho may give it, and for how long");
{
  const base = { actorEmail: "leahr@school.test", actorRole: "admin", targetEmail: "aide@school.test", targetRole: "campusaide",
    current: { on: false, until: null }, today: TODAY, defaultUntil: "2026-12-18" };
  const v = (o) => reflectionListVerdict({ ...base, ...o });
  check("an admin may give a campus aide the grant; with no end date given it ends with the term",
    J(v({ requested: true })) === J({ ok: true, on: true, until: "2026-12-18" }), J(v({ requested: true })));
  check("a superadmin may too", v({ actorRole: "superadmin", requested: true }).ok === true);
  for (const r of ["teacher", "campusaide", "pbis"]) check(`a ${r} may not`, v({ actorRole: r, requested: true }).ok === false);
  check("nobody may give it to themselves", v({ actorEmail: "aide@school.test", requested: true }).ok === false);
  check("on/off only: a string is refused, not coerced", ["yes", "true", 1, null].every((q) => v({ requested: q }).ok === false));
  check("pointless for admin or PBIS, who already have it: refused",
    ["admin", "superadmin", "pbis"].every((r) => v({ targetRole: r, requested: true }).ok === false));
  check("but a stray one can always be taken away", v({ targetRole: "pbis", current: { on: true, until: null }, requested: false }).ok === true);
  check("an end date the admin gives is kept", v({ requested: true, until: "2026-11-06" }).until === "2026-11-06");
  check("no end date, said out loud (null), is allowed", J(v({ requested: true, until: null })) === J({ ok: true, on: true, until: null }));
  check("a last day already past is refused", v({ requested: true, until: "2026-10-12" }).ok === false);
  check(`...and so is one more than ${REFLECTION_GRANT_MAX_DAYS} days away, or not a date`,
    v({ requested: true, until: "2028-01-01" }).ok === false && v({ requested: true, until: "2026-02-31" }).ok === false);
  check("no term end known and no date given: it asks for a date rather than granting for ever",
    v({ requested: true, defaultUntil: null }).ok === false && /give an end date/.test(v({ requested: true, defaultUntil: null }).reason));
  check("asking for exactly what they have is refused; a new last day is a change",
    v({ current: { on: true, until: "2026-12-18" }, requested: true }).ok === false
      && v({ current: { on: true, until: "2026-12-18" }, requested: true, until: "2027-01-29" }).ok === true);
  check("taking away what they do not have is refused", v({ requested: false }).ok === false);
}

console.log("\nA role change clears it");
{
  const p = roleWritePatch({ role: "campusaide", reflectionList: true, reflectionListUntil: "2026-12-18" }, "teacher");
  check("the grant is cleared on a role change, end date and all",
    "reflectionList" in p && p.reflectionList === undefined && "reflectionListUntil" in p && p.reflectionListUntil === undefined);
  check("the same role keeps it", !("reflectionList" in roleWritePatch({ role: "campusaide", reflectionList: true }, "campusaide")));
}

console.log("\nThe Discipline tabs: one more, and only while the grant runs");
{
  new Function(read("./wildcat-discipline.js"))();
  const D = globalThis.WildcatDiscipline;
  const g = { role: "campusaide", reflectionList: true, reflectionListUntil: "2026-12-18" };
  check("an aide with the grant: their three tabs plus the Reflection Room",
    D.disciplineTabsFor("campusaide", g, TODAY).join(",") === "submit,review,closed,reflection");
  check("...with Attendance Watch as well: both grants' tabs",
    D.disciplineTabsFor("campusaide", { ...g, attendanceWatch: true }, TODAY).join(",") === "submit,review,closed,attendance,earlyWarning,reflection");
  check("...never uniform logging, the referral history, analytics or detention",
    !["uniform", "history", "analytics", "detention"].some((t) => D.canOpenDisciplineTab("campusaide", t, g, TODAY)));
  check("an expired grant draws no tab", D.disciplineTabsFor("campusaide", g, "2026-12-19").join(",") === "submit,review,closed");
  check("with no school day to compare, an end-dated grant draws no tab (fail closed)",
    D.disciplineTabsFor("campusaide", g).join(",") === "submit,review,closed");
  check("the Attendance Watch grant alone still gets exactly its five",
    D.disciplineTabsFor("campusaide", { attendanceWatch: true }, TODAY).join(",") === "submit,review,closed,attendance,earlyWarning");
  check("the roles are unchanged", D.disciplineTabsFor("pbis", {}, TODAY).length === 10);
}

console.log("\nOn the server: read, print and nothing more");
Object.assign(process.env, { STAFF_DOMAIN: "school.test", ENTRA_TENANT_ID: "tenant-1", PS_TERM_ID: "3601" });
const ISSUER = "https://login.microsoftonline.com/tenant-1/v2.0";
const loaded = await loadConvex(new URL("./", import.meta.url), ["reflectionList", "reflectionRules", "staffInvites", "uniformViolations"]);
try {
  const R = loaded.mods.reflectionRules;
  const la = (date, hhmm) => { const [h, m] = hhmm.split(":").map(Number); return R.laWallToUtc(date, h * 60 + m, "America/Los_Angeles"); };
  const store = makeDb(read("./convex/schema.ts"));
  await store.db.insert("bellSettings", { key: "bell", timeZone: "America/Los_Angeles", updatedAt: "2026-08-17T00:00:00Z" });
  await store.db.insert("appState", { key: "reflection:settings", value: { modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: "2026-10-12", hs: "2026-10-12" } }, mirroredAt: "x" });
  await store.db.insert("appState", { key: "reflection:roster", value: { termEnd: "2026-12-18", termId: "3601", snapDay: TODAY }, mirroredAt: "x" });
  await store.db.insert("students", { studentNumber: "12001", firstName: "Rosa", lastName: "Test", grade: "9" });
  const staff = {
    admin: { email: "admin@school.test", role: "admin", name: "Ada Admin" },
    teacher: { email: "teacher@school.test", role: "teacher", name: "Tom Teacher" },
    aide: { email: "aide@school.test", role: "campusaide", name: "Ana Aide" },
    expired: { email: "expired@school.test", role: "campusaide", name: "Ed Expired", reflectionList: true, reflectionListUntil: "2026-10-12" },
    watch: { email: "watch@school.test", role: "campusaide", name: "Wu Watch", attendanceWatch: true },
  };
  for (const t of Object.values(staff)) await store.db.insert("teachers", { ticketsAwarded: 0, ...t });
  const rt = runtime(store, loaded.mods);
  const as = (who) => { rt.signIn({ issuer: ISSUER, email: staff[who].email }); return rt; };
  const tryRun = (who, path, args) => as(who).run(path, args).then((x) => x, (e) => ({ threw: String(e.message || e) }));
  clock.set(la(TODAY, "10:00"));

  // An admin gives the aide the list. No end date given: the end of the term.
  const given = await tryRun("admin", "staffInvites.setStaffReflectionList", { email: "aide@school.test", on: true });
  const aideRow = store.rows("teachers").find((t) => t.email === "aide@school.test");
  check("an admin gives it; with no date it ends on the term's last day, read from the list's roster record",
    given.on === true && given.until === "2026-12-18" && aideRow.reflectionList === true && aideRow.reflectionListUntil === "2026-12-18"
      && aideRow.reflectionListSetBy === "admin@school.test", J(given));
  const audit = store.rows("appAuditLog").map((r) => r.payload);
  check("written to the audit log, naming staff only (never a student)",
    audit.length === 1 && audit[0].action === "Changed Reflection Room access"
      && audit[0].details === "Ana Aide: Reflection Room list given until 2026-12-18" && !/12001|Rosa/.test(J(audit)), J(audit));
  const byTeacher = await tryRun("teacher", "staffInvites.setStaffReflectionList", { email: "aide@school.test", on: false });
  const bySelf = await tryRun("aide", "staffInvites.setStaffReflectionList", { email: "aide@school.test", on: true, until: "2027-01-29" });
  check("a teacher may not set it, nor the holder on their own record",
    /Only administrators/.test(byTeacher.threw || "") && /Only administrators/.test(bySelf.threw || ""), J([byTeacher, bySelf]));

  const aideList = await tryRun("aide", "reflectionList.listForDay", { day: "today" });
  check("an aide with the grant may read the list", aideList.allowed === true && aideList.ok === true, J(aideList).slice(0, 200));
  check("...and is not shown the roles' banners, prints or the grant panel",
    aideList.roles === false && aideList.review === null && aideList.printsToday === null && aideList.grants === null);
  const aidePrint = await tryRun("aide", "reflectionList.recordPrint", { day: aideList.date, kind: "master", unitIds: [], studentNumbers: [], listVersion: String(aideList.listVersion) });
  check("...and may print it (the print is recorded under their email)",
    aidePrint.ok === true && store.rows("reflectionPrints").some((p) => p.printedByEmail === "aide@school.test"), J(aidePrint));
  for (const who of ["teacher", "expired", "watch"]) {
    const r = await tryRun(who, "reflectionList.listForDay", { day: "today" });
    const p = await tryRun(who, "reflectionList.recordPrint", { day: TODAY, kind: "master", unitIds: [], studentNumbers: [], listVersion: "x" });
    check(`${who === "expired" ? "an EXPIRED grant" : who === "watch" ? "an Attendance Watch grant alone" : "a teacher"}: refused to read and to print`,
      r.allowed === false && p.ok === false, J([r, p]));
  }
  const adminList = await tryRun("admin", "reflectionList.listForDay", { day: "today" });
  check("admins see 'who can see this list': each grant, when and by whom it was given, and its last day",
    J(adminList.grants.map((g) => [g.email, g.until, g.current, g.setBy])) === J([["aide@school.test", "2026-12-18", true, "admin@school.test"],
      ["expired@school.test", "2026-10-12", false, null]]), J(adminList.grants));
  const log = await tryRun("aide", "uniformViolations.log", { studentNumber: "12001", loanerProvided: false, attemptId: "a1" });
  check("the grant holder is refused uniform logging", /limited to administrators and the PBIS team/.test(log.threw || ""), J(log));

  // The aide is made a teacher: the grant goes with the old role.
  const moved = await tryRun("admin", "staffInvites.setStaffRole", { email: "aide@school.test", role: "teacher" });
  const after = store.rows("teachers").find((t) => t.email === "aide@school.test");
  check("the grant is cleared by a role change, and the answer and the audit line say so",
    moved.reflectionListCleared === true && after.reflectionList === undefined && after.reflectionListUntil === undefined
      && /\(Reflection Room list access removed\)/.test(store.rows("appAuditLog").pop().payload.details), J(moved));
  const gone = await tryRun("aide", "reflectionList.listForDay", { day: "today" });
  check("...and the list is closed to them from that moment", gone.allowed === false);
} finally {
  clock.real();
  loaded.cleanup();
}

console.log("\nThe grant is not browser-writable, and the screens are wired");
{
  const shape = read("./convex/appDataShape.ts");
  check("not in TEACHER_WRITABLE", /export const TEACHER_WRITABLE = \["name", "ticketsAwarded"\] as const;/.test(shape));
  check("the browser is told, as a plain boolean and a date", /reflectionList: row\.reflectionList === true,/.test(shape)
    && /reflectionListUntil: typeof row\.reflectionListUntil === "string" \? row\.reflectionListUntil : null,/.test(shape));
  const schema = read("./convex/schema.ts");
  check("the stored values can only be a boolean and a string",
    /reflectionList: v\.optional\(v\.boolean\(\)\),/.test(schema) && /reflectionListUntil: v\.optional\(v\.string\(\)\),/.test(schema));
  const inv = read("./convex/staffInvites.ts");
  const apply = inv.slice(inv.indexOf("async function applyReflectionList"), inv.indexOf("export const setStaffReflectionList ="));
  check("the setter runs the verdict before it writes, and throws on a refusal",
    apply.indexOf("reflectionListVerdict(") > 0 && apply.indexOf("reflectionListVerdict(") < apply.indexOf("ctx.db.patch(")
      && /if \(!verdict\.ok\) throw new ConvexError\(verdict\.reason\)/.test(apply));
  const s = read("./script.js");
  const save = s.slice(s.indexOf("async function saveTeacherEdit()"), s.indexOf("async function deleteTeacher"));
  check("the Edit dialog saves it through the admin-only mutation, before the staff table redraws",
    /convexMutation\('staffInvites:setStaffReflectionList'/.test(save) && save.indexOf("setStaffReflectionList") < save.indexOf("updateTeachersTable();"));
  const html = read("./index.html");
  check("the dialog has the checkbox, the last day and the hint",
    ["editTeacherReflectionList", "editTeacherReflectionListUntil", "editTeacherReflectionListHint"].every((id) => html.includes(`id="${id}"`)));
  check("the staff table shows who holds it, with its last day", /\+ Reflection Room' \+/.test(s) && /t\.reflectionList === true && t\.role !== 'admin'/.test(s));
  check("a cached staff record from before the grant cannot hide it",
    /reflectionList: serverTeacher\.reflectionList === true,/.test(s) && /reflectionListUntil: serverTeacher\.reflectionListUntil \|\| null,/.test(s));
  check("the tabs are drawn against the SCHOOL's today", /disciplineTabsFor\(currentUser && currentUser\.role, currentUser, wcSchoolToday\(\)\)/.test(s)
    && /function wcSchoolToday\(\) \{\s*return new Intl\.DateTimeFormat\('en-CA', \{ timeZone: 'America\/Los_Angeles'/.test(s));
  check("the Discipline tabs are redrawn when the grant changes mid-session", /listChanged \|\| watchBefore !== /.test(s));
  const pkg = JSON.parse(read("./package.json"));
  check("this test runs in npm test", /&& node --experimental-strip-types reflection-access\.test\.mjs\b/.test(pkg.scripts.test));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
