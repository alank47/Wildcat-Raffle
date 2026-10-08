// Attendance Watch + Early Warning for ONE staff member, read only.
//
// Asked 2026-09-30: "can we give Gabriela Avalos access to Attendance Watch?"
// then, choosing between the options: "Attendance Watch and Early Warning for
// Avalos". She is a campus aide. Making her PBIS would also have handed her
// every discipline referral (see, close, export), uniform, analytics and the
// school-wide settings, so the grant is per person and covers these two
// screens only, to VIEW.
//
// What matters most is what it must NOT do: widen the referral history,
// analytics, detention or uniform; let the grant change school-wide settings;
// apply to anyone an admin did not name; or be set by anyone but an admin.
//
// Run: npm test (node --experimental-strip-types)
import { readFileSync } from "node:fs";
import { canReadInsights, INSIGHT_ROLES } from "./convex/accessRules.ts";
import { attendanceWatchVerdict, roleWritePatch } from "./convex/roleChangeRules.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  (" + d + ")" : ""}`); }
};

console.log("\nWho may read Attendance Watch and Early Warning");
{
  check("admin, superadmin and PBIS, as before", ["admin", "superadmin", "pbis"].every((r) => canReadInsights({ role: r })));
  check("a campus aide without the grant: no", !canReadInsights({ role: "campusaide" }));
  check("a teacher without the grant: no", !canReadInsights({ role: "teacher" }));
  check("a campus aide WITH the grant: yes", canReadInsights({ role: "campusaide", attendanceWatch: true }));
  check("only a real true counts (not 'true', 1, 'yes')",
    ["true", 1, "yes", {}].every((v) => !canReadInsights({ role: "campusaide", attendanceWatch: v })));
  check("no row, no access", !canReadInsights(null) && !canReadInsights(undefined));
  check("the role list itself is unchanged", JSON.stringify(INSIGHT_ROLES) === JSON.stringify(["admin", "superadmin", "pbis"]));
}

console.log("\nWho may give it");
{
  const base = { actorEmail: "leahr@lapromisefund.org", actorRole: "admin", targetEmail: "gabriela@lapromisefund.org",
                 targetRole: "campusaide", current: false };
  check("an admin may give a campus aide the grant", attendanceWatchVerdict({ ...base, requested: true }).ok === true);
  check("a superadmin may too", attendanceWatchVerdict({ ...base, actorRole: "superadmin", requested: true }).ok === true);
  for (const r of ["teacher", "campusaide", "pbis"]) {
    check(`a ${r} may not`, attendanceWatchVerdict({ ...base, actorRole: r, requested: true }).ok === false);
  }
  check("nobody may give it to themselves",
    attendanceWatchVerdict({ ...base, actorEmail: "gabriela@lapromisefund.org", requested: true }).ok === false);
  check("on/off only: a string is refused, not coerced",
    ["yes", "true", 1, null].every((q) => attendanceWatchVerdict({ ...base, requested: q }).ok === false));
  check("pointless for admin or PBIS, who already have it: refused",
    ["admin", "superadmin", "pbis"].every((r) => attendanceWatchVerdict({ ...base, targetRole: r, requested: true }).ok === false));
  check("but a stray one can always be taken away",
    attendanceWatchVerdict({ ...base, targetRole: "pbis", current: true, requested: false }).ok === true);
  check("asking for what they already have is refused",
    attendanceWatchVerdict({ ...base, current: true, requested: true }).ok === false);
  check("a teacher can be given it too (an admin's call)",
    attendanceWatchVerdict({ ...base, targetRole: "teacher", requested: true }).ok === true);
}

console.log("\nA role change clears it");
{
  const p = roleWritePatch({ role: "campusaide", attendanceWatch: true }, "teacher");
  check("campus aide -> teacher clears the grant", "attendanceWatch" in p && p.attendanceWatch === undefined);
  const same = roleWritePatch({ role: "campusaide", attendanceWatch: true }, "campusaide");
  check("the same role keeps it", !("attendanceWatch" in same));
  const both = roleWritePatch({ role: "teacher", attendanceWatch: true, gradeScope: "middle" }, "pbis");
  check("and clears Middle School access alongside it", both.attendanceWatch === undefined && both.gradeScope === undefined && "gradeScope" in both);
}

console.log("\nEvery READ is widened; every WRITE is not");
{
  const list = read("./convex/attendanceList.ts");
  check("all five attendance list queries check canReadInsights",
    (list.match(/if \(!canReadInsights\(staff\)\) \{/g) || []).length === 5
      && !/ATTENDANCE_ROLES\.includes\(staff\.role\)/.test(list));
  const rc = read("./convex/attendanceRunChartData.ts");
  const series = rc.slice(rc.indexOf("export const series = query"), rc.indexOf("export const freezeBaseline"));
  check("the run chart READ checks canReadInsights", /if \(!canReadInsights\(staff\)\)/.test(series));
  const gate = rc.slice(rc.indexOf("async function gate("), rc.indexOf("async function gate(") + 400);
  check("the run chart CHANGES (freeze, unfreeze, notes) still check the ROLE only",
    /if \(!ROLES\.includes\(staff\.role\)\)/.test(gate) && !/canReadInsights/.test(gate));
  for (const fn of ["freezeBaseline", "retireBaseline", "addAnnotation", "removeAnnotation"]) {
    const body = rc.slice(rc.indexOf(`export const ${fn} = mutation`), rc.indexOf(`export const ${fn} = mutation`) + 700);
    check(`...${fn} goes through gate()`, /await gate\(ctx\)/.test(body));
  }
  // Review finding 2026-09-30: the breakdown is by race/ethnicity, and the
  // approval record limits race aggregates to admin, superadmin and PBIS.
  const sub = read("./convex/attendanceSubgroups.ts");
  check("the race/ethnicity breakdown stays with the ROLES, not the grant",
    /if \(!SUBGROUP_ROLES\.includes\(staff\.role\)\)/.test(sub) && !/canReadInsights/.test(sub));
  check("Early Warning's READ checks canReadInsights", /if \(!canReadInsights\(staff\)\)/.test(read("./convex/earlyWarning.ts")));
  const shape = read("./convex/appDataShape.ts");
  check("the grant is NOT browser-writable (TEACHER_WRITABLE unchanged)",
    /export const TEACHER_WRITABLE = \["name", "ticketsAwarded"\] as const;/.test(shape));
  check("the browser is told, as a plain boolean", /attendanceWatch: row\.attendanceWatch === true,/.test(shape));
  const inv = read("./convex/staffInvites.ts");
  const apply = inv.slice(inv.indexOf("async function applyAttendanceWatch"), inv.indexOf("export const setStaffAttendanceWatch ="));
  check("the setter runs the verdict before it writes",
    apply.indexOf("attendanceWatchVerdict(") > 0 && apply.indexOf("attendanceWatchVerdict(") < apply.indexOf("ctx.db.patch("));
  check("...throws on a refusal and writes the audit log",
    /if \(!verdict\.ok\) throw new ConvexError\(verdict\.reason\)/.test(apply) && /"Changed attendance access"/.test(apply));
  const pub = inv.slice(inv.indexOf("export const setStaffAttendanceWatch ="), inv.indexOf("export const setStaffAttendanceWatchFromCli"));
  check("...identifies the caller from their sign-in, takes no role argument",
    /await requireStaff\(ctx\)/.test(pub) && /args: \{ email: v\.string\(\), on: v\.boolean\(\) \}/.test(pub));
  check("the stored value can only be a boolean", /attendanceWatch: v\.optional\(v\.boolean\(\)\)/.test(read("./convex/schema.ts")));
}

console.log("\nThe screens: two tabs, view only");
{
  new Function(read("./wildcat-discipline.js"))();
  const D = globalThis.WildcatDiscipline;
  const aide = D.disciplineTabsFor("campusaide", { role: "campusaide" });
  const granted = D.disciplineTabsFor("campusaide", { role: "campusaide", attendanceWatch: true });
  check("a campus aide without it: submit, review, closed", aide.join(",") === "submit,review,closed");
  check("with it: those plus Attendance Watch and Early Warning", granted.join(",") === "submit,review,closed,attendance,earlyWarning");
  check("...and NOT the referral history, analytics, detention or uniform",
    !["history", "analytics", "detention", "uniform"].some((t) => granted.includes(t)));
  check("...and it does not make them see every referral", D.seesAllReferrals("campusaide") === false);
  check("the pane check agrees", D.canOpenDisciplineTab("campusaide", "earlyWarning", { attendanceWatch: true })
    && !D.canOpenDisciplineTab("campusaide", "analytics", { attendanceWatch: true })
    && !D.canOpenDisciplineTab("campusaide", "attendance", {}));
  // Ten since 2026-10-08: the roles gained the Reflection Room list, which
  // this grant does not open (accessRules.canReadReflection is its own check).
  check("PBIS unchanged", D.disciplineTabsFor("pbis", {}).length === 10
    && !D.disciplineTabsFor("campusaide", { attendanceWatch: true }).includes("reflection"));
  check("the grant cannot change the school's settings", !D.canEditInsightSettings("campusaide") && D.canEditInsightSettings("pbis"));

  const s = read("./script.js");
  check("the sidebar and the pane both pass the signed-in user",
    /disciplineTabsFor\(currentUser && currentUser\.role, currentUser\)/.test(s)
    && /canOpenDisciplineTab\(currentUser && currentUser\.role, subtab, currentUser\)/.test(s));
  check("run-chart freeze/unfreeze/notes are drawn only for the roles",
    /const arCanEdit = window\.WildcatDiscipline\.canEditInsightSettings\(/.test(s)
    && /if \(c\.canFreeze && arCanEdit\)/.test(s) && /baseHtml \+= arCanEdit \? \('<div class="wc-ar-addnote">'/.test(s)
    // Since 2026-10-07 the From/To range pickers (they exist only to freeze)
    // and the "the range above" lines are not drawn for the grant either.
    && /if \(arCanEdit\) \{\s*baseHtml \+= '<div class="wc-ar-range">'/.test(s) && /if \(c && arCanEdit\) \{/.test(s));
  check("Early Warning thresholds are greyed out and unsaveable for the grant",
    /el\.disabled = !canEdit;/.test(s) && /async function saveRiskSettings\(\) \{\s*if \(!window\.WildcatDiscipline\.canEditInsightSettings/.test(s));
  const save = s.slice(s.indexOf("async function saveTeacherEdit()"), s.indexOf("async function deleteTeacher"));
  check("the Edit dialog saves it through the admin-only mutation",
    /convexMutation\('staffInvites:setStaffAttendanceWatch'/.test(save) && /teacher\.attendanceWatch = watchResult\.on === true/.test(save));
  check("...before the staff table redraws", save.indexOf("setStaffAttendanceWatch") < save.indexOf("updateTeachersTable();"));
  check("the dialog has the checkbox", /id="editTeacherAttendanceWatch"/.test(read("./index.html")));
  const view = s.slice(s.indexOf("function setAttendanceView(view)"), s.indexOf("function setAttendanceView(view)") + 900);
  check("the 'By student group' view is hidden and refused for a grant holder",
    /if \(_attView === 'subgroup' && !groupsOk\) _attView = 'watch';/.test(view) && /b\.hidden = !groupsOk;/.test(view));
  check("thresholds are locked on EVERY render, not only the first",
    /if \(!_ewSettingsHydrated\) hydrateRiskSettingsInputs\(settings\);\s*applyRiskSettingsLock\(\);/.test(s));
  check("a cached pre-grant staff record cannot hide the grant",
    /attendanceWatch: serverTeacher\.attendanceWatch === true,/.test(s));
  check("the Discipline tabs are redrawn when the grant arrives mid-session",
    /watchBefore !== \(fresh\.attendanceWatch === true\)[\s\S]{0,160}renderModeSubnav\('discipline'\)/.test(s));
}

console.log("\nTeeth");
{
  const src = read("./wildcat-discipline.js");
  const broken = src.replace("return ['submit', 'review', 'closed', 'attendance', 'earlyWarning'];",
    "return ['submit', 'review', 'closed', 'detention', 'attendance', 'earlyWarning', 'uniform', 'history', 'analytics'];");
  new Function(broken)();
  const B = globalThis.WildcatDiscipline;
  check("TEETH: a grant widened to every tab would be caught",
    ["history", "analytics"].some((t) => B.disciplineTabsFor("campusaide", { attendanceWatch: true }).includes(t)));
  new Function(src)();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
