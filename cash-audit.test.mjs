// Reading a Wildcat Cash audit entry.
//
// THE BUG. The Audit Log read `log.teacherName` and `log.details`. addToAuditLog
// has never written either -- the entry carries `teacher` and `reason`. So the
// teacher column printed "System" on every row, the student fell back to
// "Student #12345", and the behaviour, amount and notes were recovered by
// running a regular expression over a string that did not exist, producing "-".
// Every column but Date and Action was wrong at once.
//
// Nothing threw. An undefined field renders as its fallback, and a fallback
// looks like data. That is the whole reason it survived to launch week.
//
// These assertions are written against an entry built EXACTLY as addToAuditLog
// builds one, because "the renderer and the writer disagree about field names"
// is the defect, and a fixture invented to suit the reader would reproduce it.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-cashaudit.js", import.meta.url), "utf8");
new Function(src)();
const CA = globalThis.WildcatCashAudit;

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const code = script.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

/** An entry in the exact shape addToAuditLog writes. */
const entry = (over = {}) => ({
  entryId: "a_x", timestamp: "2026-09-05T15:04:00.000Z",
  teacher: "Jazmin Kent", teacherId: "T023",
  action: "cash_award", studentId: "12345",
  studentName: "Nadia Almendares-Castaneda",
  category: "Wildcat Cash", ticketCount: 5,
  reason: "On task all period", week: 2, cycle: 1, ...over,
});

console.log("\nThe fields the writer actually writes");
{
  const d = CA.describe(entry());
  check("the teacher is the teacher, not 'System'", d.teacher === "Jazmin Kent");
  check("the student is named from the entry", d.studentName === "Nadia Almendares-Castaneda");
  check("the amount comes from ticketCount", d.amount === 5);
  check("the behaviour comes from the entry", d.behavior === "On task all period");
  check("the action has a readable label", d.actionLabel === "Cash Awarded");

  // The exact regression: reading a field nobody writes.
  check("nothing depends on teacherName", CA.describe({ ...entry(), teacher: "Alex Rambo" }).teacher === "Alex Rambo");
  check("nothing depends on details",
    CA.describe({ ...entry(), reason: "Helped a classmate" }).behavior === "Helped a classmate");
}

console.log("\nA deduction reads as a deduction");
{
  // The entry stores a POSITIVE 5 with a negative action. Showing it unsigned
  // tells a parent their child gained five dollars they actually lost.
  const d = CA.describe(entry({ action: "cash_deduct", ticketCount: 5 }));
  check("the stored magnitude is still positive", d.amount === 5);
  check("but the signed value is negative", d.signed === -5);
  check("and an award stays positive", CA.describe(entry()).signed === 5);
  check("a redemption is money leaving the account",
    CA.describe(entry({ action: "reward_redemption", ticketCount: 12 })).signed === -12);
}

console.log("\nNo amount is not an amount of zero");
{
  const d = CA.describe(entry({ action: "reset_all_student_cash", ticketCount: undefined }));
  check("a reset has no amount rather than $0", d.amount === null && d.signed === null);
  check("which the app's own rule requires: absent is never rendered as real",
    d.signed !== 0);
}

console.log("\nBehaviour and notes, old entries and new");
{
  // Old entries jammed both into `reason` as "Behaviour, notes".
  const old = CA.describe(entry({ reason: "Disruptive behavior, would not settle after two reminders" }));
  check("a legacy entry splits into behaviour", old.behavior === "Disruptive behavior");
  check("and notes", old.notes === "would not settle after two reminders");

  const plain = CA.describe(entry({ reason: "On task all period" }));
  check("a legacy entry with no notes has none", plain.notes === "" && plain.behavior === "On task all period");

  // New entries carry both as their own fields, so nothing is parsed.
  const fresh = CA.describe(entry({
    reason: "Helped, a classmate, twice",
    behavior: "Helped, a classmate", notes: "twice",
  }));
  check("a structured entry is NOT split on the comma", fresh.behavior === "Helped, a classmate");
  check("and its notes are exact", fresh.notes === "twice");
  check("which is the point: a behaviour name may contain a comma",
    CA.behaviorAndNotes({ reason: "Helped, a classmate, twice" }).behavior === "Helped");
}

console.log("\nOne student's history, for the Accounts screen");
{
  const log = [
    entry({ entryId: "1", studentId: "111", timestamp: "2026-09-01T10:00:00Z" }),
    entry({ entryId: "2", studentId: "222", timestamp: "2026-09-02T10:00:00Z" }),
    entry({ entryId: "3", studentId: "111", timestamp: "2026-09-03T10:00:00Z", action: "cash_deduct" }),
    { entryId: "4", studentId: "111", action: "ticket_award", timestamp: "2026-09-04T10:00:00Z" },
  ];
  const mine = CA.forStudent(log, "111");
  check("only that student's entries", mine.length === 2);
  check("only CASH entries, not raffle tickets", mine.every(e => CA.isCashEntry(e)));
  check("newest first", mine[0].entryId === "3");
  check("an unknown student gets nothing, not everything", CA.forStudent(log, "999").length === 0);
  check("a missing id gets nothing rather than the whole school", CA.forStudent(log, "").length === 0);
}

console.log("\nA student with no name on the entry is still identifiable");
{
  const d = CA.describe({ action: "cash_award", studentId: "777", ticketCount: 1 },
                        (id) => (id === "777" ? "Milachi Rogers" : ""));
  check("it falls back to a lookup", d.studentName === "Milachi Rogers");
  const none = CA.describe({ action: "cash_award", studentId: "777", ticketCount: 1 });
  check("and to the id when there is no lookup", none.studentName === "Student #777");
  check("teacher unknown is stated, not blank", none.teacher === "Unknown");
}

console.log("\nBoth screens read through the same rules");
{
  check("the audit table uses the shared module",
    /function updateCashAuditLogTable[\s\S]{0,900}WildcatCashAudit/.test(code));
  check("the accounts screen uses it too",
    /function updateStudentAccounts[\s\S]{0,1200}WildcatCashAudit/.test(code));
  check("the per-student history uses it as well",
    /function showStudentCashHistory[\s\S]{0,600}CA\.forStudent/.test(code));
  check("no renderer reads log.details any more", !/log\.details/.test(code));
  check("no renderer reads log.teacherName any more", !/log\.teacherName/.test(code));
  check("and nothing regex-parses a reason string for an amount",
    !/details\.match\(/.test(code));

  check("the award sites record behaviour and notes as their own fields",
    (code.match(/\{ behavior: behavior\.name, notes:/g) || []).length >= 3);
  check("addToAuditLog stores them when given",
    /if \(extra && typeof extra === 'object'\)[\s\S]{0,200}logEntry\.behavior/.test(code));
  check("while still writing reason, which every stored entry has",
    /reason: reason,/.test(code));
}

console.log("\nAccounts is scoped like Award Cash");
{
  check("it scopes through the shared roster helper",
    /function updateStudentAccounts[\s\S]{0,1200}WildcatRoster\.scopeStudents\(\{/.test(code));
  check("it starts from enrolled students, not the raw array",
    /function updateStudentAccounts[\s\S]{0,900}enrolledStudents\(\)/.test(code));
  check("its class filter is built from the live SIS roster",
    /function updateAccountPeriodFilter[\s\S]{0,400}sectionsFrom\(activeTeacherRoster\(\)\)/.test(code));
  check("and the tab fetches the roster then repaints, as Award Cash does",
    /studentAccounts'\)[\s\S]{0,400}loadTeacherRosterFromSIS\(\)\.then/.test(code));
  check("an empty result says which filter emptied it",
    /function updateStudentAccounts[\s\S]{0,2000}scoped\.reason/.test(code));
}


console.log("\nThe history fits without dragging sideways");
{
  // Six columns -- when, staff, action, behaviour, amount, notes -- do not fit
  // a dialog. The first version put them in a table inside a horizontal
  // scroller, so a teacher checking WHY a child lost five dollars had to drag
  // sideways to reach the reason, which is the column they opened it for.
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

  check("the history is a list, not a table in a scroller",
    /function showStudentCashHistory[\s\S]{0,1500}<ul class="cash-history">/.test(code));
  check("nothing in it uses the horizontal scroller",
    !/function showStudentCashHistory[\s\S]{0,2500}wu-scroll-x/.test(code));

  check("the dialog opens wide for this one screen", /wide: true/.test(code));
  check("and _wcDialog knows how to be wide", /wc-dialog-wide/.test(code));
  check("860px, up from the 460px a confirmation uses",
    /\.wc-dialog\.wc-dialog-wide \{ max-width: 860px; \}/.test(css));
  check("the icon gutter is reclaimed for reading width",
    /\.wc-dialog-wide \.wc-dialog-body \{ padding-left: 22px/.test(css));

  // min-width:0 is the line that makes the wrapping work: without it a long
  // note refuses to wrap and pushes the amount off the right edge.
  check("long text wraps instead of pushing the amount out of the row",
    /\.chr-main \{ min-width: 0;/.test(css));
  check("and words too long to wrap are broken rather than overflowing",
    (css.match(/overflow-wrap: anywhere/g) || []).length >= 2);
  check("the amount never wraps mid-figure", /\.chr-amount \{[^}]*white-space: nowrap/.test(css));

  check("on a phone the row becomes a single column",
    /@media \(max-width: 620px\)[\s\S]{0,400}\.cash-history-row \{ grid-template-columns: 1fr; \}/.test(css));
  check("and the totals go two-up rather than shrinking to fit four",
    /@media \(max-width: 620px\)[\s\S]{0,200}\.cash-history-totals \{ grid-template-columns: repeat\(2, 1fr\); \}/.test(css));

  // A reset shared the deduction's red, which reads as "something went wrong"
  // for a routine start-of-year action.
  check("a system reset is neutral, not error red",
    /\.cash-action-badge\.act-reset\s+\{ background: #6E7885; \}/.test(css));
  check("each row's left border matches its badge colour",
    /\.cash-history-row\.act-redeem \{ border-left-color: #6D4AB8; \}/.test(css));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
