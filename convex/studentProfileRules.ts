/**
 * What a teacher's student drill-down is allowed to CLAIM. Pure, no ctx, no
 * database, no Convex imports, so every one of these decisions is asserted in
 * studentProfileRules.test.mjs rather than eyeballed once through a handler this
 * repo cannot run in a test.
 *
 * Split from studentPortalRules.ts on purpose. That file decides what a CHILD
 * may look up about themselves, and its failure mode is one student reading
 * another student's record. This file decides what a TEACHER is told about a
 * child while the child is standing at the desk watching, and its failure mode
 * is different and quieter: a panel that renders a number nobody measured.
 *
 * THE ONE RULE EVERYTHING HERE SERVES: missing is missing.
 *
 * A student with no attendance row has UNKNOWN attendance, not zero absences.
 * A student with no Wildcat Cash record has an UNKNOWN balance, not $0. A
 * schedule that did not sync is not a student with no classes. Each of those
 * three mistakes is invisible on screen, reads as a fact, and is the kind of
 * fact a teacher repeats out loud to a parent.
 *
 * So every panel below returns the same envelope passCard.ts uses,
 *
 *     { available: false, reason: "..." }   nothing may be rendered
 *     { available: true,  reason: null }    the numbers beside it are real
 *
 * and a value that is absent INSIDE an available panel stays null. Never 0,
 * never "", never a dash baked in at this layer: the renderer decides how to
 * say "not on file", this decides whether there is anything to say.
 */

// ---------------------------------------------------------------------------
// Reasons. Written once, here, because a reason string is the entire user
// interface of a missing panel and two copies drift into two different answers
// to "why is this blank".
// ---------------------------------------------------------------------------

/** Staff wording. The student-facing twin lives in studentPortalRules.ts. */
export const NO_NUMBER_REASON =
  "This student has no PowerSchool student number on their app record, so " +
  "attendance, behavior and schedule cannot be looked up. The office can add " +
  "it in PowerSchool.";

export const NO_ATTENDANCE_REASON =
  "No attendance record has synced for this student yet. This is not the same " +
  "as perfect attendance: the SIS sync has not produced a row for them.";

export const NO_SCHEDULE_REASON =
  "No schedule rows have synced for this student yet, so their classes cannot " +
  "be listed. The twice daily SIS sync fills this in.";

export const NO_PROMISE_TIME_REASON =
  "No Promise Time section is on this student's synced schedule. Either they " +
  "are not scheduled into one yet, or the section is named something this " +
  "screen does not recognise as Promise Time.";

export const NO_CASH_REASON =
  "This student has no Wildcat Cash record, so their balance is unknown. An " +
  "unknown balance is not a balance of zero and must not be spent against.";

export const NO_EMAIL_REASON =
  "No school email is on this student's record yet. It syncs from the Person " +
  "email model in PowerSchool, and the office can check Student Profile > Email.";

/** The shape every panel in this file returns. */
export type Panel<T> = ({ available: true; reason: null } & T) | { available: false; reason: string };

// ---------------------------------------------------------------------------
// The join key.
// ---------------------------------------------------------------------------

export type NumberKey =
  | { ok: true; value: string; reason: null }
  | { ok: false; value: null; reason: string };

/**
 * The student number to join psAttendance, psBehaviorLog and psRoster on, or a
 * refusal.
 *
 * Identical in spirit to sisNumberKey in studentPortalRules.ts and deliberately
 * NOT imported from it: that one's refusal text is addressed to a child reading
 * their own portal ("Your student number is not on your account yet"), and this
 * one is read by a teacher who can act on it. Same trap, different audience.
 *
 * The trap: `withIndex("by_studentNumber", q => q.eq("studentNumber", ""))` is
 * NOT a no-op. It is a real bucket lookup that returns every row an upstream
 * import wrote with an empty number, so an unkeyed student would render another
 * child's absences under this child's name and nothing would error.
 */
export function staffNumberKey(student: {
  studentNumber?: string | null;
  legacyId?: string | null;
}): NumberKey {
  // Trimmed before it is tested, so a record carrying a single space is treated
  // as the missing key it is rather than queried as " ".
  const value = String(student?.studentNumber ?? student?.legacyId ?? "").trim();
  if (!value) return { ok: false, value: null, reason: NO_NUMBER_REASON };
  return { ok: true, value, reason: null };
}

// ---------------------------------------------------------------------------
// Attendance.
//
// The day-count guard that decides "absent is not zero" is `dayCount` in
// views.ts, beside the allowlist that applies it and the test that feeds that
// allowlist a NaN, a negative and a numeric string. It is not imported here:
// both this module and views.ts are loaded directly by plain-node tests, and
// node will not resolve an extensionless specifier between two `.ts` files, so
// each stays import free.
// ---------------------------------------------------------------------------

export type AttendanceFacts = {
  daysAbsentTerm: number | null;
  daysAbsentYtd: number | null;
  daysTardyTerm: number | null;
  termFirstDay: string | null;
  termLastDay: string | null;
  lastSyncedAt: string | null;
};

/**
 * The attendance panel, in THREE states rather than two.
 *
 *   key missing   we cannot look this student up at all
 *   no row        we looked, the SIS has never sent one
 *   row present   these numbers are real, and a null inside is "not on file"
 *
 * Collapsing the first two into one empty panel is how a teacher concludes a
 * child has no absences when the truth is that nobody knows. views_app.ts gets
 * two of these three right for the student's own portal; this is the third.
 *
 * Takes FACTS, not a stored row. The row to facts allowlist is
 * staffAttendanceView in views.ts, beside every other allowlist in this repo and
 * beside the test that feeds it a restricted column and asserts what comes out.
 * Splitting them keeps this module import free, which is why its decisions can
 * be tested at all.
 */
export function attendancePanel(
  key: NumberKey,
  facts: AttendanceFacts | null | undefined,
): Panel<AttendanceFacts> {
  if (!key.ok) return { available: false, reason: key.reason };
  if (!facts) return { available: false, reason: NO_ATTENDANCE_REASON };
  return { available: true, reason: null, ...facts };
}

// ---------------------------------------------------------------------------
// Wildcat Cash.
// ---------------------------------------------------------------------------

export type CashFacts = {
  balance: number;
  earned: number | null;
  spent: number | null;
};

/**
 * Spendable money, so this is the strictest panel in the file.
 *
 * `wildcatCashBalance` is OPTIONAL in schema.ts and 0 is a REAL balance a
 * student spent down to, which is exactly why absence cannot borrow that value:
 * `student.wildcatCashBalance ?? 0` shows an unrecorded student a balance
 * indistinguishable from one they earned and spent, and a teacher standing at
 * the desk would tell them so.
 *
 * A negative balance is NOT rejected the way a negative day count is. Money can
 * legitimately go below zero here: deductions exist in this app, and refusing
 * to show an overdrawn account would hide the one number the student most needs
 * to be told.
 */
export function cashPanel(student: {
  wildcatCashBalance?: number | null;
  wildcatCashEarned?: number | null;
  wildcatCashSpent?: number | null;
}): Panel<CashFacts> {
  const balance = student?.wildcatCashBalance;
  if (typeof balance !== "number" || !Number.isFinite(balance)) {
    return { available: false, reason: NO_CASH_REASON };
  }
  const side = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  return {
    available: true,
    reason: null,
    balance,
    // Earned and spent are separate optional columns. A student can have a real
    // balance and no lifetime totals, and the totals must not be invented from
    // the balance.
    earned: side(student.wildcatCashEarned),
    spent: side(student.wildcatCashSpent),
  };
}

// ---------------------------------------------------------------------------
// Schedule, and Promise Time inside it.
// ---------------------------------------------------------------------------

/**
 * How a Promise Time section is recognised: by COURSE NAME, nothing else.
 *
 * Westbrook's synced roster names it in the course, "Promise Time 9A" being the
 * shape on record. There is no advisory flag, no course number convention and
 * no period constant to key on, and inventing one of those would be a guess
 * that fails silently the first time a section is renamed.
 *
 * `\s*` between the words so "PromiseTime" matches. A trailing word boundary so
 * "Promise Timeline" does not. Deliberately NOT anchored, because the real
 * value carries a section suffix after it.
 *
 * WHEN THIS IS WRONG IT IS WRONG LOUDLY: a schedule that syncs with no matching
 * course produces the NO_PROMISE_TIME_REASON panel, which says in as many words
 * that the section may simply be named something this screen does not know.
 * That is a sentence a teacher can act on. A silently absent card is not.
 */
export const PROMISE_TIME_PATTERN = /\bpromise\s*time\b/i;

export function isPromiseTime(row: { courseName?: string | null }): boolean {
  const name = typeof row?.courseName === "string" ? row.courseName : "";
  return PROMISE_TIME_PATTERN.test(name);
}

/**
 * Sort key for a period label.
 *
 * `period` is free text from the SIS: "3", "03", "P4", "3(A)", "HR" all occur in
 * PowerSchool installs. The first integer in the string is the period, rows with
 * no integer sort after every numbered one, and ties fall back to the label so
 * the order is stable across two loads of the same screen.
 *
 * Returned as a number rather than sorting inline because "which class is first"
 * is the ordering a teacher reads down the page, and a schedule that reshuffles
 * between refreshes is a screen nobody trusts.
 */
export function periodRank(period: unknown): number {
  const match = /\d+/.exec(typeof period === "string" ? period : "");
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[0]);
}

export function byPeriod<T extends { period?: string | null }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const ra = periodRank(a.period);
    const rb = periodRank(b.period);
    if (ra !== rb) return ra - rb;
    return String(a.period ?? "").localeCompare(String(b.period ?? ""));
  });
}

export type SchedulePanels<T> = {
  promiseTime: Panel<{ sections: T[] }>;
  classes: Panel<{ count: number; rows: T[] }>;
};

/**
 * Splits a synced schedule into the Promise Time card and everything else.
 *
 * Promise Time sections are ALSO left in `classes`, not moved out of it. The
 * card is an emphasis, not a filter: a teacher who counts six classes on the
 * schedule and knows the student has seven would be right to distrust the whole
 * panel, and hiding a row to decorate another one earns that distrust.
 *
 * More than one match is returned as more than one, rather than picked between.
 * Two Promise Time rows means two terms or a data fault, and both are things a
 * teacher should see rather than have chosen for them.
 */
export function splitSchedule<T extends { courseName?: string | null; period?: string | null }>(
  key: NumberKey,
  rows: readonly T[],
): SchedulePanels<T> {
  if (!key.ok) {
    return {
      promiseTime: { available: false, reason: key.reason },
      classes: { available: false, reason: key.reason },
    };
  }

  const ordered = byPeriod(rows);
  const promise = ordered.filter(isPromiseTime);

  return {
    promiseTime:
      promise.length > 0
        ? { available: true, reason: null, sections: promise }
        : { available: false, reason: NO_PROMISE_TIME_REASON },
    classes:
      ordered.length > 0
        ? { available: true, reason: null, count: ordered.length, rows: ordered }
        : { available: false, reason: NO_SCHEDULE_REASON },
  };
}

// ---------------------------------------------------------------------------
// Identity.
// ---------------------------------------------------------------------------

/**
 * A displayable string, or null.
 *
 * "" is absence here. A blank name field rendered as a blank line looks like a
 * layout bug; rendered through this it becomes a panel that says what is not on
 * file. Same argument as gradeCell in studentPortalRules.ts, where `available`
 * was once `!== undefined` and "" therefore counted as a grade.
 */
export function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export type EmailPanel = Panel<{ address: string }>;

/** The school address, or the reason there is not one. */
export function emailPanel(student: { email?: string | null }): EmailPanel {
  const address = textOrNull(student?.email);
  if (!address) return { available: false, reason: NO_EMAIL_REASON };
  return { available: true, reason: null, address };
}
