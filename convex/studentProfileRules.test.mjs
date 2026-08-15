// Can a teacher's student drill-down claim something nobody measured?
//
// Every assertion here is one sentence a teacher could say out loud to a child
// or a parent while reading this modal over a desk. The failure this file exists
// to prevent is not a crash and not a leak: it is a screen that renders "0"
// where the honest answer is "we have never been told", which is not a bug
// anyone reports because it looks exactly like data.
//
// The three that matter most, in the brief's own words: a student with no
// behavior record must not render as a perfect score, no attendance data is not
// zero absences, and an absent Wildcat Cash balance is not $0.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NO_ATTENDANCE_REASON,
  NO_CASH_REASON,
  NO_EMAIL_REASON,
  NO_NUMBER_REASON,
  NO_PROMISE_TIME_REASON,
  NO_SCHEDULE_REASON,
  attendancePanel,
  byPeriod,
  cashPanel,
  emailPanel,
  isPromiseTime,
  periodRank,
  splitSchedule,
  staffNumberKey,
  textOrNull,
} from "./studentProfileRules.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const check = (l, c, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${l}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? `  (${d})` : ""}`); }
};

const OK = { ok: true, value: "12217", reason: null };
const NO_KEY = { ok: false, value: null, reason: NO_NUMBER_REASON };

console.log("\n1. The join key\n");
{
  check("a real number is a key", staffNumberKey({ studentNumber: "12217" }).value === "12217");
  check(
    "legacyId is accepted, because migrate.ts writes the same value into it",
    staffNumberKey({ legacyId: "12217" }).value === "12217");
  check(
    "studentNumber wins when both are present",
    staffNumberKey({ studentNumber: "12217", legacyId: "99999" }).value === "12217");

  // eq("studentNumber", "") is a real bucket, not a no-op. It returns whatever
  // an upstream import wrote with a blank number, under this child's name.
  check("no number is refused, not queried", staffNumberKey({}).ok === false);
  check("an empty string is refused", staffNumberKey({ studentNumber: "" }).ok === false);
  check("a single space is refused", staffNumberKey({ studentNumber: " " }).ok === false);
  check("null is refused", staffNumberKey({ studentNumber: null }).ok === false);
  check(
    "the refusal names who fixes it",
    /office/i.test(staffNumberKey({}).reason) && staffNumberKey({}).reason.length > 40);
  check("a refused key carries no value to query with", staffNumberKey({}).value === null);
  check("surrounding whitespace is trimmed off a real key",
    staffNumberKey({ studentNumber: " 12217 " }).value === "12217");
}

console.log("\n2. Attendance has THREE states, not two\n");
{
  const noKey = attendancePanel(NO_KEY, null);
  check("no student number: the panel refuses and says why", noKey.available === false);
  check("  and the reason is the key's own reason", noKey.reason === NO_NUMBER_REASON);

  const noRow = attendancePanel(OK, null);
  check("looked up, nothing on file: still refused", noRow.available === false);
  check("  and it is a DIFFERENT reason from a missing key",
    noRow.reason === NO_ATTENDANCE_REASON && noRow.reason !== NO_NUMBER_REASON);
  check("  and the reason says in words that this is not perfect attendance",
    /not the same as perfect attendance/i.test(noRow.reason));
  check("  a refused panel carries NO numbers at all",
    !("daysAbsentTerm" in noRow) && !("daysAbsentYtd" in noRow) && !("daysTardyTerm" in noRow));

  // Facts, because the row to facts allowlist is staffAttendanceView in
  // views.ts and views.test.mjs feeds it the restricted column.
  const real = attendancePanel(OK, {
    daysAbsentTerm: 2,
    daysAbsentYtd: 7,
    daysTardyTerm: 0,
    termFirstDay: "2026-01-12",
    termLastDay: "2026-03-20",
    lastSyncedAt: "2026-08-15T06:00:00.000Z",
  });
  check("a synced row is available", real.available === true && real.reason === null);
  check("  days absent this term", real.daysAbsentTerm === 2);
  check("  days absent year to date", real.daysAbsentYtd === 7);
  check("  a measured zero tardies is reported as 0, not hidden", real.daysTardyTerm === 0);
  check("  the term window comes through", real.termFirstDay === "2026-01-12");
  check("  and when it was synced", real.lastSyncedAt === "2026-08-15T06:00:00.000Z");

  const partial = attendancePanel(OK, {
    daysAbsentTerm: 4,
    daysAbsentYtd: null,
    daysTardyTerm: null,
    termFirstDay: null,
    termLastDay: null,
    lastSyncedAt: "2026-08-15T06:00:00.000Z",
  });
  check("a row missing the tardy column is still available", partial.available === true);
  check("  but the missing column is null, NOT 0", partial.daysTardyTerm === null);
  check("  and the column that is there is real", partial.daysAbsentTerm === 4);
}

console.log("\n3. Wildcat Cash. Spendable, so the strictest panel here.\n");
{
  const none = cashPanel({});
  check("no cash record: refused", none.available === false);
  check("  and the reason says an unknown balance is not zero",
    none.reason === NO_CASH_REASON && /not a balance of zero/i.test(none.reason));
  check("  and no balance is carried on a refused panel", !("balance" in none));

  check("undefined is not $0", cashPanel({ wildcatCashBalance: undefined }).available === false);
  check("null is not $0", cashPanel({ wildcatCashBalance: null }).available === false);
  check("NaN is not $0", cashPanel({ wildcatCashBalance: NaN }).available === false);
  check("a numeric string is not a balance", cashPanel({ wildcatCashBalance: "25" }).available === false);

  const spentDown = cashPanel({ wildcatCashBalance: 0 });
  check("a REAL zero is available, or an account could never be spent down",
    spentDown.available === true && spentDown.balance === 0);

  // Deductions exist in this app. Hiding an overdrawn account hides the one
  // number the student most needs to be told.
  const overdrawn = cashPanel({ wildcatCashBalance: -15 });
  check("an overdrawn balance is shown, not suppressed",
    overdrawn.available === true && overdrawn.balance === -15);

  const full = cashPanel({ wildcatCashBalance: 40, wildcatCashEarned: 100, wildcatCashSpent: 60 });
  check("balance, earned and spent all come through",
    full.balance === 40 && full.earned === 100 && full.spent === 60);

  const balanceOnly = cashPanel({ wildcatCashBalance: 40 });
  check("a balance with no lifetime totals stays available", balanceOnly.available === true);
  check("  and the totals are null, not derived from the balance",
    balanceOnly.earned === null && balanceOnly.spent === null);
}

console.log("\n4. Promise Time. Recognised by course name, and only by that.\n");
{
  // The shape on record in this repo's own roster fixture.
  check('"Promise Time 9A" is Promise Time', isPromiseTime({ courseName: "Promise Time 9A" }));
  check("casing does not matter", isPromiseTime({ courseName: "PROMISE TIME 10B" }));
  check("a missing space does not matter", isPromiseTime({ courseName: "PromiseTime" }));
  check("extra spacing does not matter", isPromiseTime({ courseName: "Promise  Time" }));
  check("it can sit inside a longer name",
    isPromiseTime({ courseName: "Grade 9 Promise Time Advisory" }));

  check('"Promise Timeline" is NOT Promise Time', !isPromiseTime({ courseName: "Promise Timeline" }));
  check('"Promises" alone is not', !isPromiseTime({ courseName: "Broken Promises" }));
  check("Algebra is not", !isPromiseTime({ courseName: "Algebra I" }));
  check("no course name is not", !isPromiseTime({}));
  check("a null course name is not", !isPromiseTime({ courseName: null }));
  // The teacher's employer is lapromisefund.org. A match on the wrong field
  // would make every class in the school Promise Time.
  check("the teacher's address is not consulted",
    !isPromiseTime({ courseName: "Biology", teacher: "sam@lapromisefund.org" }));
}

console.log("\n5. Period order, so the schedule does not reshuffle between loads\n");
{
  check("a plain period", periodRank("3") === 3);
  check("a padded period", periodRank("03") === 3);
  check("a prefixed period", periodRank("P4") === 4);
  check("a period with a section letter", periodRank("3(A)") === 3);
  check("a period with no number sorts last", periodRank("HR") === Number.MAX_SAFE_INTEGER);
  check("no period at all sorts last", periodRank(undefined) === Number.MAX_SAFE_INTEGER);
  check("10 sorts after 9, which a string sort would get wrong",
    periodRank("10") > periodRank("9"));

  const sorted = byPeriod([
    { period: "10", courseName: "Ten" },
    { period: "2", courseName: "Two" },
    { period: "HR", courseName: "Homeroom" },
    { period: "1", courseName: "One" },
  ]);
  check("periods come out in reading order",
    sorted.map((r) => r.courseName).join(",") === "One,Two,Ten,Homeroom",
    sorted.map((r) => r.courseName).join(","));

  const input = [{ period: "2" }, { period: "1" }];
  byPeriod(input);
  check("the caller's array is not mutated", input[0].period === "2");
}

console.log("\n6. Splitting a schedule\n");
{
  const rows = [
    { courseName: "Algebra I", period: "2" },
    { courseName: "Promise Time 9A", period: "4" },
    { courseName: "Biology", period: "1" },
  ];
  const split = splitSchedule(OK, rows);

  check("Promise Time is found", split.promiseTime.available === true);
  check("  and there is exactly one of it", split.promiseTime.sections.length === 1);
  check("  and it is the right row", split.promiseTime.sections[0].courseName === "Promise Time 9A");

  check("the class list is available", split.classes.available === true);
  check("  and it is ordered by period",
    split.classes.rows.map((r) => r.period).join(",") === "1,2,4");
  // An emphasis, not a filter. A teacher who counts six classes and knows there
  // are seven has no reason to trust the rest of the panel.
  check("  and Promise Time is STILL in it, not moved out",
    split.classes.rows.some((r) => r.courseName === "Promise Time 9A"));
  check("  and the count matches the rows", split.classes.count === split.classes.rows.length);

  const noPromise = splitSchedule(OK, [{ courseName: "Algebra I", period: "2" }]);
  check("a schedule with no advisory refuses the Promise Time card",
    noPromise.promiseTime.available === false);
  check("  and the reason admits the section may just be named something else",
    noPromise.promiseTime.reason === NO_PROMISE_TIME_REASON &&
      /named something this screen does not recognise/i.test(noPromise.promiseTime.reason));
  check("  while the rest of the schedule still renders",
    noPromise.classes.available === true);

  const empty = splitSchedule(OK, []);
  check("an unsynced schedule is refused, not shown as no classes",
    empty.classes.available === false && empty.classes.reason === NO_SCHEDULE_REASON);
  check("  and no rows are carried", !("rows" in empty.classes));
  check("  and Promise Time is refused too", empty.promiseTime.available === false);

  const noKey = splitSchedule(NO_KEY, rows);
  check("no student number refuses BOTH panels with the key's reason",
    noKey.classes.available === false && noKey.classes.reason === NO_NUMBER_REASON &&
      noKey.promiseTime.reason === NO_NUMBER_REASON);

  const twoTerms = splitSchedule(OK, [
    { courseName: "Promise Time 9A", period: "4", term: "S1" },
    { courseName: "Promise Time 9A", period: "4", term: "S2" },
  ]);
  check("two Promise Time rows are both shown rather than picked between",
    twoTerms.promiseTime.sections.length === 2);
}

console.log("\n7. Text and email\n");
{
  check("a real string survives", textOrNull(" Ana ") === "Ana");
  check('"" is absence, not a value', textOrNull("") === null);
  check("whitespace is absence", textOrNull("   ") === null);
  check("undefined is absence", textOrNull(undefined) === null);
  check("a number is not a name", textOrNull(12217) === null);

  const has = emailPanel({ email: "ana.lopez@westbrookacademy.org" });
  check("a synced address is available",
    has.available === true && has.address === "ana.lopez@westbrookacademy.org");
  const none = emailPanel({});
  check("no address is refused with a reason", none.available === false);
  check("  and the reason names where the office looks",
    none.reason === NO_EMAIL_REASON && /Student Profile > Email/.test(none.reason));
  check("a blank address is refused, not rendered as an empty line",
    emailPanel({ email: "  " }).available === false);
}

console.log("\n8. The wiring, asserted rather than remembered\n");
{
  const detail = readFileSync(resolve(HERE, "studentDetail.ts"), "utf8");

  // The gate that decides staff-yes/students-no for SIS behavior already
  // exists. A second copy of it here is the copy that drifts.
  check("studentDetail reads behavior through readBehaviorForStudent",
    /readBehaviorForStudent\(/.test(detail));
  check("  and passes the classified identity, not a literal",
    /readBehaviorForStudent\(\s*ctx,\s*id,/.test(detail) &&
      !/readBehaviorForStudent\(\s*ctx,\s*["'{]/.test(detail));
  // Named in a comment is fine and is the point. CALLED here would be the
  // second copy of the staff-yes/students-no decision, and the second copy is
  // the one that drifts.
  check("  and the audience gate is not re-implemented here",
    !/behaviorAudienceFor\s*\(/.test(detail));

  check("attendance goes through the tested panel", /attendancePanel\(/.test(detail));
  check("cash goes through the tested panel", /cashPanel\(/.test(detail));
  check("the schedule goes through the tested split", /splitSchedule\(/.test(detail));
  check("the join key is checked before any indexed read", /staffNumberKey\(/.test(detail));

  // The exact mistake this whole file is about, in the file it used to live in.
  check("no cash value is defaulted to zero in the drill-down",
    !/wildcatCash\w*\s*(\?\?|\|\|)\s*0/.test(detail),
    "an absent Wildcat Cash balance is not $0");
  check("no attendance value is defaulted to zero in the drill-down",
    !/days(Absent|Tardy)\w*\s*(\?\?|\|\|)\s*0/.test(detail));

  const rules = readFileSync(resolve(HERE, "studentProfileRules.ts"), "utf8");
  check("the rules module imports nothing, so it stays testable",
    !/^\s*import\s/m.test(rules));

  const EM_DASH = String.fromCharCode(8212);
  for (const [label, path] of [
    ["studentProfileRules.ts", resolve(HERE, "studentProfileRules.ts")],
    ["studentProfileRules.test.mjs", resolve(HERE, "studentProfileRules.test.mjs")],
    ["studentDetail.ts", resolve(HERE, "studentDetail.ts")],
  ]) {
    check(`${label} contains no em dash`, !readFileSync(path, "utf8").includes(EM_DASH));
  }
}

console.log("\n9. The modal itself\n");
{
  const REPO = resolve(HERE, "..");
  const html = readFileSync(resolve(REPO, "index.html"), "utf8");
  const script = readFileSync(resolve(REPO, "script.js"), "utf8");

  check("the modal has two tabs", /id="spTabPoints"/.test(html) && /id="spTabProfile"/.test(html));
  check("and two panes", /id="spPanePoints"/.test(html) && /id="spPaneProfile"/.test(html));
  check("the switcher is a global, because there are no modules here",
    /function switchStudentProfileTab\(/.test(script));

  // Everything the modal showed before still has somewhere to be rendered. The
  // brief is explicit that the Points tab moves rather than gets redesigned.
  for (const id of [
    "profileHeader", "profileBadges", "profileTotalTickets",
    "profileWeeksQualified", "profileLifetimeTickets", "profileTicketHistory",
  ]) {
    check(`${id} survived the move`, new RegExp(`id="${id}"`).test(html));
  }

  check("the Profile tab reads the staff-gated drill-down",
    /studentDetail:get/.test(script));
  check("and refuses to look a student up with no number",
    /studentNumber/.test(script) && /renderStudentProfileTab|loadStudentProfileTab/.test(script));

  const tags = [...html.matchAll(/(script|wildcat-auth)\.js\?v=([\w-]+)/g)].map((m) => m[2]);
  const css = [...html.matchAll(/styles\.css\?v=([\w-]+)/g)].map((m) => m[1]);
  check("the stylesheet carries a version too", css.length === 1, JSON.stringify(css));
  check("and every asset stamp is in step, so none can ship without the others",
    new Set([...tags, ...css]).size === 1,
    JSON.stringify([...tags, ...css]));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
