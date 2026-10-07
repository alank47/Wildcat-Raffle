// The referral Excel export says what the record says. Run: npm test
//
// MEASURED IN PRODUCTION, 2026-10-07 (counts only):
//   - 8 of the 9 closed referrals had "Notified parents/guardians promptly"
//     ticked, and the export printed "No" for every one of them. It read
//     r.parentNotified, which only the retired review flow ever wrote.
//   - 0 of 18 referrals carry reviewedBy, ticketsDeducted or cashDeducted, so
//     three columns were always blank or zero.
//   - Date and Time were new Date(r.dateTime). dateTime is just the date when
//     no time was entered; that parses as UTC midnight, which in Los Angeles
//     printed the day BEFORE at 5:00 PM.
//
// The owner's rule for Parent Notified (2026-10-07): Yes when either the
// notification or the mandatory parent conference was ticked, No when a closed
// referral has neither, blank while it is open.
//
// THE SHIPPED CODE RUNS: exportReferralReport is lifted out of script.js and
// run with XLSX and alert stubbed, against the real wildcat-discipline.js.
// Every "TEETH" check breaks the code on purpose and shows the assertion
// catches it.

process.env.TZ = "America/Los_Angeles";

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const discSrc = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");
const D = (() => { const sb = {}; new Function("globalThis", discSrc).call(sb, sb); return sb.WildcatDiscipline; })();

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

/** A top-level function in script.js: eight spaces in, up to the first eight-space "}". */
function liftFn(src, name) {
  const m = new RegExp("\\n        (?:async )?function " + name + "\\(").exec(src);
  if (!m) throw new Error("missing function " + name);
  const start = m.index + 1;
  const end = src.indexOf("\n        }\n", start);
  if (end < 0) throw new Error("unterminated function " + name);
  return src.slice(start, end + 10);
}
function breakOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`teeth "${label}": anchor not found exactly once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}

// 6:30pm in Los Angeles on the 7th, when UTC is already the 8th.
const NOW = Date.parse("2026-10-07T18:30:00-07:00");

/** Run the export as `role`. Returns the rows written, the file name and any alerts. */
function runExport(src, { role = "admin", email = "admin@x.org", referrals = [], students = [] } = {}) {
  const out = { data: null, filename: null, alerts: [] };
  const XLSX = {
    utils: {
      book_new: () => ({}),
      json_to_sheet: (rows) => { out.data = rows; return {}; },
      book_append_sheet: () => {},
    },
    writeFile: (_wb, name) => { out.filename = name; },
  };
  // The real module, with "now" pinned for the file name.
  const WD = Object.assign({}, D, { schoolToday: (now) => D.schoolToday(now == null ? NOW : now) });
  const body = `
    const window = { WildcatDiscipline: WD };
    let currentUser = G.currentUser;
    let behaviorReferrals = G.referrals;
    let students = G.students;
    ${liftFn(src, "visibleReferrals")}
    ${liftFn(src, "referralStudentNumber")}
    ${liftFn(src, "wcClock")}
    ${liftFn(src, "exportReferralReport")}
    exportReferralReport();
  `;
  new Function("G", "XLSX", "alert", "WD", body)(
    { currentUser: { role, email, name: "Staff" }, referrals, students },
    XLSX, (m) => out.alerts.push(String(m)), WD);
  return out;
}

const N = "Notified parents/guardians promptly";
const C = "Scheduled a mandatory Parent-Conference";
const ref = (over) => Object.assign({
  id: "REF-1", studentId: "S1", studentNumber: "100001", studentName: "Student A",
  studentGrade: "9", school: "High School", date: "2026-10-05", time: "14:05",
  dateTime: "2026-10-05T14:05", behaviorType: "Defiance", behavior: "Defiance",
  location: "Hallway", description: "x", referredBy: "Teacher T", filedByEmail: "t@x.org",
  referredByEmail: "t@x.org", status: "open", submittedAt: "2026-10-05T21:10:00.000Z",
  resolutionType: "", closingActions: [], adminNotes: "", closedBy: "", closedAt: "",
  loopClosed: false, interventions: [],
}, over);

const REFS = [
  ref({ id: "OPEN", closingActions: [N] }),
  ref({ id: "TOLD", status: "closed", resolutionType: "action_taken", closingActions: [N, "Isolated and de-escalated the situation"],
        closedBy: "Admin A", closedAt: "2026-10-08T01:30:00.000Z" }),
  ref({ id: "CONF", status: "closed", resolutionType: "action_taken", closingActions: [C],
        closedBy: "Admin A", closedAt: "2026-10-06T17:00:00.000Z" }),
  ref({ id: "NOTTOLD", status: "closed", resolutionType: "no_action", closingActions: [],
        closedBy: "Admin B", closedAt: "2026-10-06T17:00:00.000Z" }),
  ref({ id: "DATEONLY", date: "2026-10-05", time: "", dateTime: "2026-10-05" }),
  ref({ id: "NONUMBER", studentNumber: "", studentId: "S9" }),
];
const STUDENTS = [{ id: "S9", studentNumber: "100009" }];
const row = (out, id) => (out.data || []).find((r) => r["Referral ID"] === id) || {};

console.log("\n-- Parent Notified comes from what the closer ticked --");
{
  const out = runExport(script, { referrals: REFS, students: STUDENTS });
  check("closed with the notification ticked: Yes", row(out, "TOLD")["Parent Notified"] === "Yes");
  check("closed with the parent conference ticked: Yes", row(out, "CONF")["Parent Notified"] === "Yes");
  check("closed with neither: No", row(out, "NOTTOLD")["Parent Notified"] === "No");
  check("open: blank, even with the action ticked, because nothing is recorded yet",
    row(out, "OPEN")["Parent Notified"] === "");
}

console.log("\n-- the columns --");
{
  const out = runExport(script, { referrals: REFS, students: STUDENTS });
  const head = Object.keys((out.data || [])[0] || {});
  ["Student Number", "Grade", "Campus", "Closed By", "Closed Date"].forEach((c) =>
    check(`has ${c}`, head.includes(c)));
  ["Reviewed By", "Tickets Deducted", "Cash Deducted"].forEach((c) =>
    check(`drops ${c} (only the retired review flow wrote it)`, !head.includes(c)));
  check("Student Number, Grade and Campus are the snapshot on the referral",
    row(out, "TOLD")["Student Number"] === "100001" && row(out, "TOLD")["Grade"] === "9" &&
    row(out, "TOLD")["Campus"] === "High School");
  check("a referral without a student number falls back to the roster's",
    row(out, "NONUMBER")["Student Number"] === "100009");
  check("Resolution is in words", row(out, "TOLD")["Resolution"] === "Action taken" &&
    row(out, "NOTTOLD")["Resolution"] === "No action required");
  check("and blank while open, not 'Not recorded'", row(out, "OPEN")["Resolution"] === "");
  check("Closed By is who closed it", row(out, "TOLD")["Closed By"] === "Admin A");
  check("Closed Date is the Los Angeles day of closedAt (01:30 UTC on the 8th is the 7th)",
    row(out, "TOLD")["Closed Date"] === "2026-10-07", row(out, "TOLD")["Closed Date"]);
  check("an open referral has no Closed By or Closed Date",
    row(out, "OPEN")["Closed By"] === "" && row(out, "OPEN")["Closed Date"] === "");
}

console.log("\n-- the date is the date the teacher entered --");
{
  const out = runExport(script, { referrals: REFS, students: STUDENTS });
  check("a date-only referral on Oct 5 exports 2026-10-05, not the 4th",
    row(out, "DATEONLY")["Date"] === "2026-10-05", row(out, "DATEONLY")["Date"]);
  check("and no invented 5:00 PM", row(out, "DATEONLY")["Time"] === "", row(out, "DATEONLY")["Time"]);
  check("a time that was entered reads on a 12-hour clock", row(out, "TOLD")["Time"] === "2:05 PM");
  check("the file is named for the school's today, not UTC's tomorrow",
    out.filename === "Behavior_Referrals_2026-10-07.xlsx", out.filename);
  // Code only: the comment above the columns names the old expression on purpose.
  const fn = liftFn(script, "exportReferralReport").replace(/\/\/.*$/gm, "");
  check("nothing in the export parses dateTime or reads a UTC day",
    !/new Date\(r\.dateTime\)/.test(fn) && !/toISOString\(\)/.test(fn));
}

console.log("\n-- who may export --");
{
  ["teacher", "campusaide"].forEach((role) => {
    const out = runExport(script, { role, email: "t@x.org", referrals: REFS, students: STUDENTS });
    check(`a ${role} exports nothing, even their own referrals`, out.filename === null && out.data === null);
    check(`and is told why`, out.alerts.some((a) => /administrators and PBIS/.test(a)));
  });
  ["admin", "superadmin", "pbis"].forEach((role) => {
    const out = runExport(script, { role, referrals: REFS, students: STUDENTS });
    check(`${role} exports every referral`, out.filename !== null && (out.data || []).length === REFS.length);
  });
}

console.log("\n-- TEETH --");
{
  const old = breakOnce(script, "'Parent Notified': D.parentNotified(r),",
    "'Parent Notified': r.parentNotified ? 'Yes' : 'No',", "parent notified");
  check("TEETH: the old r.parentNotified read fails the closed-and-told case",
    row(runExport(old, { referrals: REFS, students: STUDENTS }), "TOLD")["Parent Notified"] !== "Yes");

  const oldDate = breakOnce(script, "'Date': r.date || D.incidentDay(r) || '',",
    "'Date': new Date(r.dateTime).toLocaleDateString(),", "date");
  check("TEETH: parsing dateTime puts a date-only referral on the wrong day",
    row(runExport(oldDate, { referrals: REFS, students: STUDENTS }), "DATEONLY")["Date"] !== "2026-10-05");

  const open = breakOnce(script, "if (!D.seesAllReferrals(currentUser && currentUser.role)) {",
    "if (false) {", "role check");
  check("TEETH: without the role check a teacher gets a file",
    runExport(open, { role: "teacher", email: "t@x.org", referrals: REFS, students: STUDENTS }).filename !== null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
