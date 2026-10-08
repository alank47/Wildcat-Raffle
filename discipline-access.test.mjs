// Who sees what in Discipline mode.
//
// Before this there was NO role gating here at all. switchDisciplineTab had no
// role check, and getOpenReferrals / getClosedReferrals returned every
// referral in the school — so any teacher could read the whole school's
// discipline record, every student's history, and the demographic breakdowns
// built from them.
//
// The rule, set by the app owner on 2026-08-25:
//   teacher     submit a referral, and see their OWN open and closed ones
//   admin/PBIS  every referral, plus history, detention and analytics
//
// Added 2026-09-30: a per-person Attendance Watch grant (teachers.attendanceWatch,
// set by an admin) adds the Attendance Watch and Early Warning tabs, read only,
// and nothing else. convex/accessRules.ts canReadInsights is the real check.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");
new Function(src)();
const D = globalThis.WildcatDiscipline;
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const teacher = { role: "teacher", email: "rivera@westbrook.org", name: "A Rivera", username: "arivera" };
const admin = { role: "admin", email: "boss@westbrook.org", name: "The Boss" };
const pbis = { role: "pbis", email: "pbis@westbrook.org", name: "PBIS Lead" };

const mine = { id: "R1", status: "open", filedByEmail: "rivera@westbrook.org" };
const alsoMine = { id: "R2", status: "closed", referredBy: "A Rivera" };
const legacyMine = { id: "R3", status: "open", filedByUsername: "arivera" };
const theirs = { id: "R4", status: "open", filedByEmail: "someone@westbrook.org" };
const alsoTheirs = { id: "R5", status: "closed", referredBy: "Someone Else" };
const ALL = [mine, alsoMine, legacyMine, theirs, alsoTheirs];

console.log("\nA teacher sees only their own referrals");
{
  const seen = D.visibleReferrals(ALL, teacher).map((r) => r.id);
  check("their own filed referral", seen.includes("R1"));
  check("one raised in their name", seen.includes("R2"));
  check("and a legacy one keyed by username", seen.includes("R3"));
  check("but NOT another teacher's", !seen.includes("R4") && !seen.includes("R5"));
  check("three of five", seen.length === 3);
}

console.log("\nAdmin and PBIS see the whole school");
{
  check("admin sees every referral", D.visibleReferrals(ALL, admin).length === 5);
  check("PBIS sees every referral", D.visibleReferrals(ALL, pbis).length === 5);
  check("superadmin too", D.visibleReferrals(ALL, { role: "superadmin" }).length === 5);
  check("seesAllReferrals is the single predicate",
    D.seesAllReferrals("admin") && D.seesAllReferrals("pbis") &&
    D.seesAllReferrals("superadmin") && !D.seesAllReferrals("teacher"));
}

console.log("\nA broken match shows too little, never everything");
{
  // The failure mode matters: if identifiers are missing, a teacher must end up
  // with nothing, not with the school's discipline record.
  check("a user with no identifiers sees nothing",
    D.visibleReferrals(ALL, { role: "teacher" }).length === 0);
  check("a null user sees nothing", D.visibleReferrals(ALL, null).length === 0);
  check("and an unknown role is treated as restricted",
    D.visibleReferrals(ALL, { role: "custodian", email: "x@y.z" }).length === 0);
  // Case and whitespace must not decide whether a teacher sees their own work.
  check("matching is case-insensitive",
    D.ownsReferral({ filedByEmail: "RIVERA@WESTBROOK.ORG" }, teacher) === true);
  check("and tolerates padding",
    D.ownsReferral({ filedByEmail: "  rivera@westbrook.org " }, teacher) === true);
  check("an empty field never matches an empty key",
    D.ownsReferral({ filedByEmail: "" }, { role: "teacher", email: "" }) === false);
}

console.log("\nTabs: a teacher gets three, admin and PBIS get the rest");
{
  check("teacher tabs are exactly submit, review, closed",
    D.disciplineTabsFor("teacher").join(",") === "submit,review,closed");
  ["detention", "attendance", "uniform", "history", "analytics"].forEach((t) => {
    check(`a teacher cannot open ${t}`, D.canOpenDisciplineTab("teacher", t) === false);
    check(`PBIS can open ${t}`, D.canOpenDisciplineTab("pbis", t) === true);
    check(`an admin can open ${t}`, D.canOpenDisciplineTab("admin", t) === true);
  });
  check("but a teacher can still submit", D.canOpenDisciplineTab("teacher", "submit") === true);
  check("and see their own open referrals", D.canOpenDisciplineTab("teacher", "review") === true);
  check("and their own closed ones", D.canOpenDisciplineTab("teacher", "closed") === true);
  // campusaide was not named either way; the narrow default is deliberate.
  check("campusaide defaults to the narrow set",
    D.canOpenDisciplineTab("campusaide", "analytics") === false);
  check("and that choice is written down",
    /campusaide is treated as a teacher here/.test(src));
}

console.log("\nDemographics is unreachable for a teacher");
{
  // Demographics lives inside Analytics, so the tab gate is what keeps a
  // child's race, sex and grade breakdown away from someone who may only file.
  check("analytics is not in a teacher's tabs",
    !D.disciplineTabsFor("teacher").includes("analytics"));
  // The calls now also pass currentUser so a per-person Attendance Watch grant
  // is seen; the role is still the first argument, so a teacher without the
  // grant gets exactly the three tabs pinned above.
  check("the pane refuses as well as the button being hidden",
    /canOpenDisciplineTab\(currentUser && currentUser\.role, subtab, currentUser, wcSchoolToday\(\)\)/.test(script));
  check("and it falls back to submit rather than a blank screen",
    /switchDisciplineTab\('submit'\);\s*\n\s*return;/.test(script));
  check("the sidebar filters the buttons too",
    /disciplineTabsFor\(currentUser && currentUser\.role, currentUser, wcSchoolToday\(\)\)/.test(script));
  check("analytics stays closed to a teacher even with the Attendance Watch grant",
    !D.disciplineTabsFor("teacher", { role: "teacher", attendanceWatch: true }).includes("analytics") &&
    D.canOpenDisciplineTab("teacher", "analytics", { role: "teacher", attendanceWatch: true }) === false);
}

console.log("\nA per-person Attendance Watch grant opens two tabs, read only");
{
  const granted = { ...teacher, attendanceWatch: true };
  const aide = { role: "campusaide", email: "aide@westbrook.org" };
  const grantedAide = { ...aide, attendanceWatch: true };

  // (a) Without the grant nothing changed: teacher and campus aide are refused.
  ["attendance", "earlyWarning"].forEach((t) => {
    check(`a teacher without the grant cannot open ${t}`,
      D.canOpenDisciplineTab("teacher", t, teacher) === false);
    check(`nor with the grant explicitly off (${t})`,
      D.canOpenDisciplineTab("teacher", t, { ...teacher, attendanceWatch: false }) === false);
    check(`a campus aide without the grant cannot open ${t}`,
      D.canOpenDisciplineTab("campusaide", t, aide) === false);
    check(`nor with no user record at all (${t})`,
      D.canOpenDisciplineTab("teacher", t, null) === false);
  });
  check("a teacher without the grant still gets exactly three tabs",
    D.disciplineTabsFor("teacher", teacher).join(",") === "submit,review,closed");
  // Only a real boolean true grants; a stray string or number does not.
  check("a truthy non-boolean is not a grant",
    D.canOpenDisciplineTab("teacher", "attendance", { ...teacher, attendanceWatch: "true" }) === false &&
    D.canOpenDisciplineTab("teacher", "attendance", { ...teacher, attendanceWatch: 1 }) === false);

  // (b) With attendanceWatch:true those two tabs open, for a teacher or an aide.
  ["attendance", "earlyWarning"].forEach((t) => {
    check(`a teacher with the grant can open ${t}`,
      D.canOpenDisciplineTab("teacher", t, granted) === true);
    check(`a campus aide with the grant can open ${t}`,
      D.canOpenDisciplineTab("campusaide", t, grantedAide) === true);
  });
  check("the grant adds exactly those two tabs",
    D.disciplineTabsFor("teacher", granted).join(",") === "submit,review,closed,attendance,earlyWarning");

  // And nothing else: referral history, analytics, detention and uniform stay
  // with the role, and the teacher still sees only their own referrals.
  ["detention", "uniform", "history", "analytics"].forEach((t) => {
    check(`the grant does not open ${t}`,
      D.canOpenDisciplineTab("teacher", t, granted) === false &&
      D.canOpenDisciplineTab("campusaide", t, grantedAide) === false);
  });
  check("the grant does not widen the referral list",
    D.visibleReferrals(ALL, granted).length === 3);

  // Read only: the settings on those tabs stay with admin, superadmin and PBIS.
  check("the roles may change the insight settings",
    D.canEditInsightSettings("admin") && D.canEditInsightSettings("superadmin") &&
    D.canEditInsightSettings("pbis"));
  check("a teacher may not, grant or no grant",
    D.canEditInsightSettings("teacher") === false &&
    D.canEditInsightSettings("teacher", granted) === false &&
    D.canEditInsightSettings("campusaide", grantedAide) === false);
  // The app decides editing from the role alone, never from the user record.
  const editCalls = script.match(/canEditInsightSettings\([^)]*\)/g) || [];
  check("every settings gate in the app passes the role only",
    editCalls.length >= 3 &&
    editCalls.every((c) => c === "canEditInsightSettings(currentUser && currentUser.role)"));
}

console.log("\nThe app routes every referral table through one scope");
{
  check("getOpenReferrals is scoped", /function getOpenReferrals\(\)\s*\{ return visibleReferrals\(\)/.test(script));
  check("getClosedReferrals is scoped", /function getClosedReferrals\(\)\s*\{ return visibleReferrals\(\)/.test(script));
  check("neither reads behaviorReferrals directly any more",
    !/getOpenReferrals\(\)\s*\{ return \(behaviorReferrals/.test(script));
  // Username is gone from the teacher record, so email has to be recorded.
  check("new referrals record the filer's email",
    /filedByEmail: \(currentUser\.email \|\| ''\)/.test(script));
  check("and the reason is written down",
    /that is what the\n\s*\/\/ migration off cleartext passwords removed/.test(script));
}

console.log("\nWho may close a referral (owner, 2026-10-07)");
{
  // Measured first: all 9 closed referrals were closed by admins, none by a
  // teacher, none loop-closed. So Close and Close-the-loop go to the three
  // roles that see everything, and to nobody else.
  const table = [
    ["teacher", false], ["campusaide", false], ["pbis", true], ["admin", true], ["superadmin", true],
    ["PBIS", true], [" Admin ", true], ["", false], [null, false], [undefined, false], ["custodian", false],
  ];
  for (const [role, want] of table) {
    check(`canCloseReferrals(${JSON.stringify(role)}) is ${want}`, D.canCloseReferrals(role) === want);
  }
  check("a per-person grant never makes a closer (the role decides)",
    D.canCloseReferrals("teacher") === false && D.disciplineTabsFor("teacher", { attendanceWatch: true }).length === 5);
  check("closers are exactly the roles that see every referral",
    ["teacher", "campusaide", "pbis", "admin", "superadmin"].every((r) => D.canCloseReferrals(r) === D.seesAllReferrals(r)));
  // The R2 (name-only) and R3 (username-only) fixtures above still count as a
  // teacher's own on SCREEN, inside whatever list the server sends; the
  // server's own scope is email only (convex/referralAccessRules.ts).
  check("the display rule is unchanged by the close rule", D.visibleReferrals(ALL, teacher).length === 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
