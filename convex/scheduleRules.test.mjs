// Which class is a student in right now. Run: npm test
//
// WHY THIS FILE IS LONG. Every assertion here stands in for a hall pass sent to
// the wrong teacher, and a hall pass sent to the wrong teacher is not a display
// bug: it is a record saying a child was let out of a room they were never in,
// signed by somebody who never saw them.
//
// The arithmetic is all clock arithmetic, which is exactly the kind that looks
// right and is off by an hour for half the year, or off by a day either side of
// midnight, or right until the first assembly. So the cases below are the
// boundaries, midnight, a period that has not started, a day the schedule does
// not cover, and the two DST sides of the same wall-clock time.

import {
  MINUTES_IN_DAY,
  MAX_PERIODS_PER_SCHEDULE,
  MAX_EXPRESSION_LENGTH,
  parseClock,
  formatClock,
  normalizePeriodLabel,
  normalizeDateKey,
  validatePeriods,
  validateWeekdays,
  validateCycleDays,
  localSchoolTime,
  periodAt,
  parseSectionExpression,
  classifySection,
  resolveCurrentSection,
  teacherLabel,
  pickClassroomTag,
  scheduleForDay,
} from "./scheduleRules.ts";

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`); }
}

const LA = "America/Los_Angeles";
const at = (h, m = 0) => h * 60 + m;

/** A plain five period day, 08:00 to 14:00, Monday to Friday. */
const REGULAR = {
  name: "Regular",
  weekdays: [1, 2, 3, 4, 5],
  periods: [
    { label: "1", startMinute: at(8), endMinute: at(8, 55) },
    { label: "2", startMinute: at(9), endMinute: at(9, 55) },
    { label: "3", startMinute: at(10), endMinute: at(10, 55) },
    // The lunch gap is deliberately NOT a period. 11:55 to 12:40 is a real
    // state a student can be standing in and it has no teacher.
    { label: "4", startMinute: at(11), endMinute: at(11, 55) },
    { label: "5", startMinute: at(12, 40), endMinute: at(13, 35) },
  ],
};

console.log("\nparseClock: null is not zero, and zero is midnight");
{
  check("a normal time parses", parseClock("08:15") === 495);
  check("a single digit hour parses", parseClock("8:15") === 495);
  check("midnight is 0, not null", parseClock("00:00") === 0);
  check("the end of the day is expressible", parseClock("24:00") === MINUTES_IN_DAY);
  check("whitespace is trimmed", parseClock("  13:05  ") === 785);

  // Every one of these must be null. A parser that answered 0 would put a
  // period at midnight, and every student asking at 00:05 would be routed into
  // it with a real teacher's name attached.
  for (const [label, input] of [
    ["an empty string", ""],
    ["a bare hour", "8"],
    ["a bare number", "815"],
    ["minutes over 59", "08:75"],
    ["a time past midnight", "24:01"],
    ["words", "morning"],
    ["a number", 495],
    ["null", null],
    ["undefined", undefined],
    ["a negative", "-1:00"],
    ["a payload", "0".repeat(5000)],
  ]) {
    check(`${label} is null, never 0`, parseClock(input) === null);
  }

  check("formatClock round trips", formatClock(parseClock("08:15")) === "08:15");
  check("formatClock pads", formatClock(65) === "01:05");
  check("formatClock refuses a non-integer", formatClock(65.5) === "");
  check("formatClock refuses out of range", formatClock(MINUTES_IN_DAY + 1) === "");
}

console.log("\nnormalizePeriodLabel: two humans typed the same period into two systems");
{
  // The master schedule says "01(A-E)" and the admin typed "1". Without this,
  // every student in that section is told they have no class, forever, on a
  // screen that looks perfectly healthy.
  check("a leading zero is stripped", normalizePeriodLabel("01") === "1");
  check("several leading zeros go", normalizePeriodLabel("007") === "7");
  check("a bare zero survives", normalizePeriodLabel("0") === "0");
  check("case is folded", normalizePeriodLabel("hr") === "HR");
  check("space is collapsed", normalizePeriodLabel(" Period  1 ") === "PERIOD 1");
  check("a number is accepted", normalizePeriodLabel(3) === "3");
  check("nothing yields empty", normalizePeriodLabel("   ") === "");
  check("null yields empty", normalizePeriodLabel(null) === "");
  check(
    "a 400 digit label does not become Infinity",
    normalizePeriodLabel("0".repeat(399) + "1") === "1",
  );
}

console.log("\nnormalizeDateKey: a date that does not exist is not a date");
{
  check("a real date survives", normalizeDateKey("2026-08-15") === "2026-08-15");
  check("the 30th of February is refused", normalizeDateKey("2026-02-30") === "");
  check("month 13 is refused", normalizeDateKey("2026-13-01") === "");
  check("a slashed date is refused", normalizeDateKey("2026/08/15") === "");
  check("an ISO instant is refused", normalizeDateKey("2026-08-15T00:00:00Z") === "");
  check("a leap day in a leap year is kept", normalizeDateKey("2028-02-29") === "2028-02-29");
  check("a leap day in a common year is refused", normalizeDateKey("2026-02-29") === "");
}

console.log("\nvalidatePeriods: an overlap is a coin flip performed on a child's record");
{
  check("the plain schedule is accepted", validatePeriods(REGULAR.periods).ok);
  check("and comes back sorted", validatePeriods([
    { label: "2", startMinute: at(9), endMinute: at(10) },
    { label: "1", startMinute: at(8), endMinute: at(9) },
  ]).periods[0].label === "1");

  check("an empty list is refused", !validatePeriods([]).ok);
  check("a non-list is refused", !validatePeriods("1,2,3").ok);
  check("a nameless period is refused", !validatePeriods([
    { label: "  ", startMinute: at(8), endMinute: at(9) },
  ]).ok);
  check("a backwards period is refused", !validatePeriods([
    { label: "1", startMinute: at(9), endMinute: at(8) },
  ]).ok);
  check("a zero length period is refused", !validatePeriods([
    { label: "1", startMinute: at(9), endMinute: at(9) },
  ]).ok);
  check("a non-integer minute is refused", !validatePeriods([
    { label: "1", startMinute: 480.5, endMinute: at(9) },
  ]).ok);
  check("a minute past midnight is refused", !validatePeriods([
    { label: "1", startMinute: at(8), endMinute: MINUTES_IN_DAY + 1 },
  ]).ok);

  // The two that matter. Either one makes "which teacher" depend on row order.
  const overlap = validatePeriods([
    { label: "1", startMinute: at(8), endMinute: at(9, 10) },
    { label: "2", startMinute: at(9), endMinute: at(10) },
  ]);
  check("an overlap is refused", !overlap.ok);
  check("and the refusal names both periods", /1/.test(overlap.reason) && /2/.test(overlap.reason));

  check("a duplicate label is refused", !validatePeriods([
    { label: "1", startMinute: at(8), endMinute: at(9) },
    { label: "01", startMinute: at(9), endMinute: at(10) },
  ]).ok, "01 and 1 are the same period as far as an expression is concerned");

  // Touching is not overlapping. A bell at 09:00 ends one and starts the next.
  check("periods that touch are fine", validatePeriods([
    { label: "1", startMinute: at(8), endMinute: at(9) },
    { label: "2", startMinute: at(9), endMinute: at(10) },
  ]).ok);

  const tooMany = [];
  for (let i = 0; i <= MAX_PERIODS_PER_SCHEDULE; i++) {
    tooMany.push({ label: `P${i}`, startMinute: i, endMinute: i + 1 });
  }
  check("past the ceiling is refused", !validatePeriods(tooMany).ok);
}

console.log("\nvalidateWeekdays and validateCycleDays");
{
  check("weekdays are accepted", validateWeekdays([1, 2, 3, 4, 5]).ok);
  check("duplicates collapse", validateWeekdays([1, 1, 2]).weekdays.length === 2);
  check("an empty list is refused", !validateWeekdays([]).ok);
  check("day 7 is refused", !validateWeekdays([7]).ok);
  check("a string day is refused", !validateWeekdays(["Monday"]).ok);

  check("no cycle at all is fine", validateCycleDays(undefined).cycleDays.length === 0);
  check("letters are uppercased", validateCycleDays(["a", "b"]).cycleDays[0] === "A");
  check("duplicates collapse", validateCycleDays(["A", "a"]).cycleDays.length === 1);
  check("a long label is refused", !validateCycleDays(["Monday-A"]).ok);
}

console.log("\nlocalSchoolTime: the same wall clock on both sides of daylight saving");
{
  // THE TEST THIS FILE EXISTS FOR. 17:00Z in January and 16:00Z in July are the
  // same wall clock in Los Angeles. A fixed offset gets exactly one of them
  // right, and the wrong half of the year routes every request one period out.
  const winter = localSchoolTime("2026-01-15T17:00:00Z", LA);
  const summer = localSchoolTime("2026-07-15T16:00:00Z", LA);
  check("winter reads 09:00 local", winter.ok && winter.minuteOfDay === at(9));
  check("summer reads 09:00 local", summer.ok && summer.minuteOfDay === at(9));
  check("and both agree", winter.minuteOfDay === summer.minuteOfDay);

  check("the local date is the local date", winter.ok && winter.dateKey === "2026-01-15");
  check("the weekday is the local weekday", winter.ok && winter.weekday === 4, "2026-01-15 is a Thursday");

  // MIDNIGHT, from both sides. 07:30Z on the 15th is 00:30 local on the 15th;
  // 06:59Z is 23:59 local on the 14th. A naive UTC read calls both the 15th and
  // files a late night pass under the wrong school day.
  const justAfter = localSchoolTime("2026-08-15T07:30:00Z", LA);
  const justBefore = localSchoolTime("2026-08-15T06:59:00Z", LA);
  check("half past midnight is minute 30 of the 15th",
    justAfter.ok && justAfter.minuteOfDay === 30 && justAfter.dateKey === "2026-08-15");
  check("a minute before midnight is still the 14th",
    justBefore.ok && justBefore.minuteOfDay === at(23, 59) && justBefore.dateKey === "2026-08-14");
  check("and the weekday rolls with the local date",
    justBefore.ok && justBefore.weekday === 5 && justAfter.weekday === 6,
    "2026-08-14 is a Friday, the 15th a Saturday",
  );

  check("UTC is a time zone like any other",
    localSchoolTime("2026-01-15T17:00:00Z", "UTC").minuteOfDay === at(17));

  // Refusals, never a guess.
  check("an unreadable instant is refused", !localSchoolTime("not a date", LA).ok);
  check("a missing zone is refused", !localSchoolTime("2026-01-15T17:00:00Z", "").ok);
  check("a nonsense zone is refused", !localSchoolTime("2026-01-15T17:00:00Z", "Mars/Olympus").ok);
  check("and the refusal says where to set it",
    /Settings/.test(localSchoolTime("2026-01-15T17:00:00Z", "").reason));
  check("a null zone is refused", !localSchoolTime("2026-01-15T17:00:00Z", null).ok);
}

console.log("\nperiodAt: the boundaries, and every way of being in no period");
{
  const on = (weekday, minuteOfDay) => ({ dateKey: "2026-08-12", weekday, minuteOfDay });
  const WED = 3;

  // HALF OPEN. 09:00 ends period 1 and starts period 2, and it belongs to 2.
  check("the first minute of a period is in it",
    periodAt(REGULAR, on(WED, at(8))).period.label === "1");
  check("the last minute of a period is in it",
    periodAt(REGULAR, on(WED, at(8, 54))).period.label === "1");
  check("the end minute is NOT in it",
    periodAt(REGULAR, on(WED, at(8, 55))).ok === false,
    "08:55 to 09:00 is a passing period and has no teacher");
  check("the next period starts on its own start minute",
    periodAt(REGULAR, on(WED, at(9))).period.label === "2");
  check("minutes left is counted to the bell",
    periodAt(REGULAR, on(WED, at(9, 45))).minutesLeft === 10);

  // MIDNIGHT. Minute 0 is before the school day, not after it.
  const midnight = periodAt(REGULAR, on(WED, 0));
  check("midnight is before school, not after", !midnight.ok && midnight.code === "before-school");
  check("and it says when the day starts", /08:00/.test(midnight.reason));

  const early = periodAt(REGULAR, on(WED, at(7, 59)));
  check("a minute before the first bell is before-school",
    !early.ok && early.code === "before-school");

  const late = periodAt(REGULAR, on(WED, at(13, 35)));
  check("the minute the last period ends is after-school",
    !late.ok && late.code === "after-school");
  check("and so is 23:59", periodAt(REGULAR, on(WED, at(23, 59))).code === "after-school");

  // LUNCH. The real 12:15 case: a student genuinely has no scheduled class.
  const lunch = periodAt(REGULAR, on(WED, at(12, 15)));
  check("lunch is between-periods, not a class", !lunch.ok && lunch.code === "between-periods");
  check("and the message offers the fallback", /teacher/i.test(lunch.reason));

  const passing = periodAt(REGULAR, on(WED, at(8, 57)));
  check("a passing period is between-periods", !passing.ok && passing.code === "between-periods");

  // A DAY THE SCHEDULE DOES NOT COVER.
  const saturday = periodAt(REGULAR, on(6, at(9, 30)));
  check("Saturday is not a school day here", !saturday.ok && saturday.code === "day-not-covered");
  const sunday = periodAt(REGULAR, on(0, at(9, 30)));
  check("nor is Sunday", !sunday.ok && sunday.code === "day-not-covered");
  check("and the refusal names the schedule", /Regular/.test(saturday.reason));

  check("a schedule with no days at all covers every day",
    periodAt({ ...REGULAR, weekdays: [] }, on(6, at(9, 30))).ok);

  // NO SCHEDULE. Missing is missing.
  check("no schedule is refused", !periodAt(null, on(WED, at(9, 30))).ok);
  check("an empty schedule is refused",
    !periodAt({ name: "Empty", weekdays: [1], periods: [] }, on(1, at(9, 30))).ok);

  // A minimum day is a different schedule, not the same one shifted.
  const MINIMUM = {
    name: "Minimum day",
    weekdays: [1, 2, 3, 4, 5],
    periods: [
      { label: "1", startMinute: at(8), endMinute: at(8, 35) },
      { label: "2", startMinute: at(8, 40), endMinute: at(9, 15) },
    ],
  };
  check("11:00 is period 4 on a regular day",
    periodAt(REGULAR, on(WED, at(11))).period.label === "4");
  check("and school is over at 11:00 on a minimum day",
    periodAt(MINIMUM, on(WED, at(11))).code === "after-school",
    "this is the whole reason a second named schedule exists");
}

console.log("\nparseSectionExpression: the pairing of period and cycle day is the point");
{
  const one = parseSectionExpression("1(A-E)");
  check("one period and a day range is ONE meeting", one.meetings.length === 1,
    "a meeting is a period with its days, not a period repeated per day");
  check("the period is carried", one.meetings[0].period === "1");
  check("A-E is five days", one.meetings[0].days.join(",") === "A,B,C,D,E");

  check("a bare period has no day constraint",
    parseSectionExpression("3").meetings[0].days.length === 0);
  check("a leading zero is normalized here too",
    parseSectionExpression("01(A)").meetings[0].period === "1");
  check("a lettered period survives", parseSectionExpression("HR(A-E)").meetings[0].period === "HR");
  check("a comma separated period list applies the same days",
    parseSectionExpression("1,2(A-E)").meetings.filter((m) => m.period === "2").length === 1);
  check("a numeric period range expands",
    parseSectionExpression("4-5(A)").meetings.map((m) => m.period).join(",") === "4,5");

  // THE ONE THAT MATTERS. Flattening this to periods [1,3] and days [A,B] says
  // the section meets at period 3 on an A day. It does not, and that is a
  // request routed to a teacher who is not in front of the child.
  const paired = parseSectionExpression("1(A),3(B)");
  const p1 = paired.meetings.find((m) => m.period === "1");
  const p3 = paired.meetings.find((m) => m.period === "3");
  check("period 1 keeps only its own day", p1.days.join(",") === "A");
  check("period 3 keeps only its own day", p3.days.join(",") === "B");

  const spaced = parseSectionExpression("1(A) 2(B)");
  check("space separated pairs parse", spaced.meetings.length === 2);
  check("and stay paired",
    spaced.meetings.find((m) => m.period === "2").days.join(",") === "B");

  check("a semicolon separates bare periods",
    parseSectionExpression("1;2").meetings.length === 2);
  check("an explicit day list parses",
    parseSectionExpression("3(A,C,E)").meetings[0].days.join(",") === "A,C,E");

  // Hostile and awkward input is bounded and never throws.
  check("an empty expression is not understood", !parseSectionExpression("").understood);
  check("a null expression is not understood", !parseSectionExpression(null).understood);
  check("a number is not understood", !parseSectionExpression(7).understood);
  check("an over-length expression is refused rather than scanned",
    !parseSectionExpression("1(A-E)".repeat(MAX_EXPRESSION_LENGTH)).understood);
  check("an unbalanced paren does not lose the period",
    parseSectionExpression("1(A-E").meetings.length > 0);
  check("junk is not understood", !parseSectionExpression("()").understood);
  check("a backwards day range is kept verbatim rather than expanded wrongly",
    parseSectionExpression("1(E-A)").meetings[0].days.join(",") === "E-A");
}

console.log("\nresolveCurrentSection: nothing is picked when the answer is not singular");
{
  const math = {
    sectionId: "S1", courseName: "Algebra", sectionExpression: "3(A-E)",
    teacherEmail: "vega@school.org", teacherFirstName: "Ana", teacherLastName: "Vega",
  };
  const band = {
    sectionId: "S2", courseName: "Band", sectionExpression: "3(A,C)",
    teacherEmail: "reid@school.org", teacherFirstName: "Sam", teacherLastName: "Reid",
  };
  const art = {
    sectionId: "S3", courseName: "Art", sectionExpression: "3(B,D)",
    teacherEmail: "kerr@school.org", teacherFirstName: "Jo", teacherLastName: "Kerr",
  };
  const english = {
    sectionId: "S4", courseName: "English", sectionExpression: "4(A-E)",
    teacherEmail: "diaz@school.org",
  };
  const CYCLE = ["A", "B", "C", "D", "E"];

  const found = resolveCurrentSection([math, english], { period: "3", schoolCycleDays: CYCLE });
  check("the one class at this period is found", found.ok && found.section.courseName === "Algebra");
  check("and its teacher comes with it", found.teacherEmail === "vega@school.org");

  check("a class at another period is not it",
    resolveCurrentSection([english], { period: "3", schoolCycleDays: CYCLE }).code === "no-class-this-period");
  check("no classes at all is refused, not defaulted",
    resolveCurrentSection([], { period: "3" }).code === "no-class-this-period");
  check("an empty period is refused",
    resolveCurrentSection([math], { period: "" }).code === "no-period");

  // A-E covers the whole cycle, so today's letter cannot change the answer.
  check("a section meeting every cycle day needs no cycle day",
    resolveCurrentSection([math], { period: "3", schoolCycleDays: CYCLE }).ok);
  check("and still resolves when the cycle is not configured at all",
    resolveCurrentSection([math], { period: "3" }).ok === false,
    "without the school cycle, (A-E) is a constraint we cannot evaluate",
  );
  check("which is reported as unknown-cycle-day, not as no class",
    resolveCurrentSection([math], { period: "3" }).code === "unknown-cycle-day");

  // THE WRONG TEACHER CASE. Band on A/C and Art on B/D both sit at period 3.
  const ambiguous = resolveCurrentSection([band, art], { period: "3", schoolCycleDays: CYCLE });
  check("two conditional classes with no cycle day is refused",
    !ambiguous.ok && ambiguous.code === "unknown-cycle-day");
  check("and the refusal offers the fallback", /teacher/i.test(ambiguous.reason));

  const onA = resolveCurrentSection([band, art], { period: "3", cycleDay: "A", schoolCycleDays: CYCLE });
  check("told the cycle day, the right one is chosen", onA.ok && onA.section.courseName === "Band");
  const onB = resolveCurrentSection([band, art], { period: "3", cycleDay: "b", schoolCycleDays: CYCLE });
  check("and the case of the cycle day does not matter", onB.ok && onB.section.courseName === "Art");
  const onE = resolveCurrentSection([band, art], { period: "3", cycleDay: "E", schoolCycleDays: CYCLE });
  check("a day neither meets on is no class, not a guess",
    !onE.ok && onE.code === "no-class-this-period");

  const clash = resolveCurrentSection([math, { ...band, sectionExpression: "3(A-E)" }], {
    period: "3", schoolCycleDays: CYCLE,
  });
  check("two classes that both definitely meet is refused",
    !clash.ok && clash.code === "ambiguous-section");
  check("and never silently takes the first row", clash.section === undefined);

  const orphan = resolveCurrentSection([{ ...math, teacherEmail: "" }], {
    period: "3", schoolCycleDays: CYCLE,
  });
  check("a section with no teacher email is refused",
    !orphan.ok && orphan.code === "no-teacher-for-section");
  check("a section with a null teacher email is refused",
    resolveCurrentSection([{ ...math, teacherEmail: null }], { period: "3", schoolCycleDays: CYCLE })
      .code === "no-teacher-for-section");
  check("the teacher email is normalized",
    resolveCurrentSection([{ ...math, teacherEmail: " Vega@School.org " }], {
      period: "3", schoolCycleDays: CYCLE,
    }).teacherEmail === "vega@school.org");

  // The sync writes `period` as a copy of the expression, so a row missing the
  // expression must still resolve rather than silently matching nothing.
  check("the period column stands in for a missing expression",
    resolveCurrentSection([{ ...math, sectionExpression: undefined, period: "3(A-E)" }], {
      period: "3", schoolCycleDays: CYCLE,
    }).ok);

  check("teacherLabel joins what is there", teacherLabel(math) === "Ana Vega");
  check("and returns empty rather than a stray space", teacherLabel({}) === "");
  check("and survives null", teacherLabel(null) === "");

  check("classifySection reports a miss as none",
    classifySection(english, "3", CYCLE).kind === "none");
  check("classifySection reports an unconstrained meeting as definite",
    classifySection({ sectionExpression: "3" }, "3").kind === "definite");
}

console.log("\npickClassroomTag: a pass with no room to close in cannot be honest");
{
  const roomA = { slug: "room-12", name: "Room 12", kind: "classroom", active: true,
    sectionId: "S1", teacherEmail: "vega@school.org" };
  const roomB = { slug: "room-14", name: "Room 14", kind: "classroom", active: true,
    teacherEmail: "reid@school.org" };
  const retired = { slug: "room-99", name: "Room 99", kind: "classroom", active: false,
    sectionId: "S1", teacherEmail: "vega@school.org" };

  check("a tag tied to the section wins",
    pickClassroomTag([roomA, roomB], { sectionId: "S1", teacherEmail: "reid@school.org" }).tag.slug === "room-12");
  check("a tag tied to the teacher is the fallback",
    pickClassroomTag([roomA, roomB], { sectionId: "S9", teacherEmail: "reid@school.org" }).tag.slug === "room-14");
  check("an unassigned building is refused, never guessed",
    pickClassroomTag([{ slug: "restroom-2", kind: "restroom", active: true }], {
      sectionId: "S1", teacherEmail: "vega@school.org",
    }).code === "no-classroom-tag");
  check("a retired tag does not count",
    pickClassroomTag([retired], { sectionId: "S1" }).code === "no-classroom-tag");
  check("two tags for one teacher is refused rather than resolved",
    pickClassroomTag([roomB, { ...roomB, slug: "room-15" }], { teacherEmail: "reid@school.org" })
      .code === "ambiguous-classroom-tag");
  check("two tags for one section is refused too",
    pickClassroomTag([roomA, { ...roomA, slug: "room-13" }], { sectionId: "S1" })
      .code === "ambiguous-classroom-tag");
  check("nothing at all is refused", pickClassroomTag([], { sectionId: "S1" }).ok === false);
  check("a non-list is refused", pickClassroomTag(null, { sectionId: "S1" }).ok === false);
  check("no target at all is refused", pickClassroomTag([roomA], {}).ok === false);
}

console.log("\nscheduleForDay: which schedule today runs on is a choice, never an inference");
{
  const regular = { _id: "sched1", ...REGULAR };
  const minimum = { _id: "sched2", name: "Minimum day", weekdays: [1, 2, 3, 4, 5], periods: REGULAR.periods };
  const all = [regular, minimum];

  check("an unmarked day falls to the chosen usual schedule",
    scheduleForDay(null, all, "sched1").schedule.name === "Regular");
  check("and says it came from the default",
    scheduleForDay(null, all, "sched1").source === "default");
  check("a marked day wins",
    scheduleForDay({ scheduleId: "sched2" }, all, "sched1").schedule.name === "Minimum day");
  check("and says it was an override",
    scheduleForDay({ scheduleId: "sched2" }, all, "sched1").source === "override");

  const holiday = scheduleForDay({ noSchool: true }, all, "sched1");
  check("a day marked no school is its own answer",
    !holiday.ok && holiday.code === "no-school-today");
  check("no school beats the override id",
    !scheduleForDay({ noSchool: true, scheduleId: "sched2" }, all, "sched1").ok);

  const unset = scheduleForDay(null, all, null);
  check("no usual schedule chosen is refused, not guessed",
    !unset.ok && unset.code === "no-schedule-today");
  check("and points at the setting", /Settings/.test(unset.reason));
  check("a default pointing at a deleted schedule is refused",
    !scheduleForDay(null, all, "gone").ok);
  check("an override pointing at a deleted schedule is refused with its own code",
    scheduleForDay({ scheduleId: "gone" }, all, "sched1").code === "missing-schedule",
    "falling back to the default here would silently run an assembly day on the regular bells");
  check("no schedules at all is refused", !scheduleForDay(null, [], "sched1").ok);
}

console.log("\nEnd to end: an instant, a schedule, a timetable, one teacher");
{
  const CYCLE = ["A", "B", "C", "D", "E"];
  const roster = [
    { sectionId: "S1", courseName: "Algebra", sectionExpression: "1(A-E)",
      teacherEmail: "vega@school.org", teacherFirstName: "Ana", teacherLastName: "Vega" },
    { sectionId: "S2", courseName: "Biology", sectionExpression: "5(A-E)",
      teacherEmail: "diaz@school.org", teacherFirstName: "Rob", teacherLastName: "Diaz" },
  ];

  // 2026-08-12 is a Wednesday. 15:20Z is 08:20 PDT, inside period 1.
  const local = localSchoolTime("2026-08-12T15:20:00Z", LA);
  check("the local clock lands inside period 1", local.ok && local.minuteOfDay === at(8, 20));
  const chosen = scheduleForDay(null, [{ _id: "s", ...REGULAR }], "s");
  const period = periodAt(chosen.schedule, local);
  check("which the bell schedule agrees is period 1", period.ok && period.period.label === "1");
  const section = resolveCurrentSection(roster, {
    period: period.period.label, schoolCycleDays: CYCLE,
  });
  check("and the timetable names exactly one teacher",
    section.ok && section.teacherEmail === "vega@school.org");
  check("and the class the student is sitting in", section.section.courseName === "Algebra");

  // The same student, ninety minutes later, at lunch. Nothing is invented.
  const atLunch = localSchoolTime("2026-08-12T19:15:00Z", LA);
  check("12:15 local is lunch", atLunch.ok && atLunch.minuteOfDay === at(12, 15));
  const noPeriod = periodAt(chosen.schedule, atLunch);
  check("and lunch has no period", !noPeriod.ok && noPeriod.code === "between-periods");
  check("so there is no teacher, and none is invented",
    noPeriod.period === undefined && noPeriod.reason.length > 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
