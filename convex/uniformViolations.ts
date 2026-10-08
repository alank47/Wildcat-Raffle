import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { requireStaff } from "./identity";
import {
  mayLogUniform,
  mayReadUniform,
  UNIFORM_ACCESS_REASON,
  duplicateVerdict,
  windowStart,
  dayToEpoch,
  dayMinus,
} from "./uniformRules";
import { admitState, divisionOfGrade, observedAtVerdict, wallClock } from "./reflectionRules";
import { loadSettings, recheckRelease } from "./reflection";

/**
 * The Uniform Violations log: a Behavior Interventionist standing at a door,
 * every school day, logging students out of uniform.
 *
 * EFFICIENCY IS THE REQUIREMENT, in the owner's words: "I want this to be as
 * easy as possible for the interventionists as this is a daily task, so
 * efficiency is a must in order to maintain fidelity." Everything here is
 * shaped by that.
 *
 * WHICH IS WHY IT DOES NOT GO THROUGH saveData(). A browser save in this app
 * writes students, teachers, settings, referrals, ticket histories, the audit
 * log, every cash week and the secondary document, and it self-guards with a
 * wait of up to twenty seconds on an in-flight save. Twenty to sixty times a
 * morning that is not a log, it is a queue. Every direct-mutation feature here
 * -- hall passes, purchases, cash reversals, tap locations -- deliberately
 * avoids it, and so does this.
 *
 * Each mutation RETURNS THE UPDATED FACTS so the screen can redraw from the
 * answer rather than re-reading the table. One round trip per student, not
 * three.
 */

/**
 * Ceiling on rows read in one window query.
 *
 * At twenty to sixty rows a school day this table reaches a few thousand rows
 * a year, and Convex allows 4,096 document reads per call. The cap is not
 * about the limit, it is about noticing: `truncated` says so on screen rather
 * than the repeat list quietly ending early and a child who is out of uniform
 * every day never appearing on it.
 */
const MAX_ROWS = 3000;

/** A row as the browser wants it. No Convex ids leak except the row's own. */
function toRow(r: any) {
  return {
    id: r._id,
    studentNumber: r.studentNumber,
    studentName: r.studentName,
    studentGrade: r.studentGrade,
    day: r.day,
    at: r.at,
    loanerProvided: r.loanerProvided === true,
    loanerOutstanding: r.loanerOutstanding === true,
    loanerReturnedAt: r.loanerReturnedAt ?? null,
    note: r.note ?? "",
    loggedByName: r.loggedByName,
    loggedByEmail: r.loggedByEmail,
    voidedAt: r.voidedAt ?? null,
    voidReason: r.voidReason ?? null,
    // ON A REFLECTION ROOM LIST ALREADY MADE: undoing it now needs a reason,
    // and it shows on every earlier print as removed after the list was made.
    onList: !!r.unitId,
    // Saved more than 10 minutes after it was observed (a queued entry): the
    // list shows "Saved late (observed Tue 7:52)".
    savedAt: r.savedAt ?? null,
  };
}

/**
 * THE SCHOOL'S TIME ZONE, from Settings > Bell Schedule, or Los Angeles.
 *
 * Not refused when the setting is blank, unlike the Reflection Room list
 * itself: a door at 7:50 must never stop working because a setting is empty,
 * and the school is in Los Angeles (bellSchedules.SUGGESTED_TIME_ZONE).
 */
async function schoolZone(ctx: any): Promise<string> {
  const row = await ctx.db.query("bellSettings").withIndex("by_key", (q: any) => q.eq("key", "bell")).first();
  return (row && row.timeZone) || "America/Los_Angeles";
}

/** Today in the school's time, never the browser's and never UTC. */
async function schoolToday(ctx: any): Promise<string> {
  const lt = wallClock(new Date().toISOString(), await schoolZone(ctx));
  return lt.ok ? lt.dateKey : new Date().toISOString().slice(0, 10);
}

/** appState key: how often a browser's idea of the day was not believed. Counts only. */
const DAY_MISMATCH_KEY = "uniform:dayMismatch";

/**
 * Count a disagreement, never act on it: a browser that sent a different day
 * (an old tab, or a Chromebook on the wrong zone), or an observedAt outside
 * [now - 72 h, now + 5 min] (a clock that is badly wrong). The health card
 * reads the totals; no student is named.
 */
async function countDayMismatch(ctx: any, w: { clientDayMismatch: boolean; outOfWindow: boolean }, nowIso: string) {
  if (!w.clientDayMismatch && !w.outOfWindow) return;
  const row = await ctx.db.query("appState").withIndex("by_key", (q: any) => q.eq("key", DAY_MISMATCH_KEY)).first();
  const prev = (row && row.value) || {};
  const value = {
    clientDay: Number(prev.clientDay || 0) + (w.clientDayMismatch ? 1 : 0),
    outOfWindow: Number(prev.outOfWindow || 0) + (w.outOfWindow ? 1 : 0),
    lastAt: nowIso,
  };
  if (row) await ctx.db.patch(row._id, { value, mirroredAt: nowIso });
  else await ctx.db.insert("appState", { key: DAY_MISMATCH_KEY, value, mirroredAt: nowIso });
}

const live = (r: any) => !r.voidedAt;

/** That student's own numbers, from their own rows. Bounded by one child. */
async function summaryFor(ctx: any, studentNumber: string, sinceDay: string | null) {
  const rows = (await ctx.db
    .query("uniformViolations")
    .withIndex("by_student", (q: any) => q.eq("studentNumber", studentNumber))
    .take(MAX_ROWS)) as any[];
  const mine = rows.filter(live);
  const sinceT = sinceDay ? dayToEpoch(sinceDay) : null;
  const inWindow = sinceT === null
    ? mine
    : mine.filter((r) => { const t = dayToEpoch(r.day); return t !== null && t >= sinceT; });
  const days = [...new Set(mine.map((r) => r.day))].sort();
  return {
    studentNumber,
    countInWindow: inWindow.length,
    countTotal: mine.length,
    lastDay: days.length ? days[days.length - 1] : null,
    loanersOutstanding: mine.filter((r) => r.loanerOutstanding === true).length,
    loanersEver: mine.filter((r) => r.loanerProvided === true).length,
  };
}

/**
 * Log one violation.
 *
 * `attemptId` identifies the BUTTON PRESS, not the intent. A dropped response,
 * a flaky Chromebook and an impatient second tap all resolve to the same row
 * rather than three. That is what makes it safe for the client to retry at all,
 * and it is the studentPurchases rule verbatim. The Uniform Tracker's send
 * queue (step 5) leans on exactly this: it re-sends the same press, with the
 * same attemptId, until the server answers.
 *
 * THE SERVER SETS THE DAY (step 5). `observedAt` is the moment the adult
 * pressed Enter, in epoch ms, from the queue. Believed inside [now - 72 h,
 * now + 5 min] (reflectionRules.observedAtVerdict): the row is filed under the
 * Los Angeles day of that moment, with `at` = that moment, so a Tuesday entry
 * that could only be sent on Wednesday is a Tuesday violation -- and does not
 * block a Wednesday one. More than 10 minutes late, the row also records
 * `savedAt` and the list says "Saved late (observed Tue 7:52)". Outside the
 * window, or with no observedAt (a tab on older code), it is filed now. The
 * `day` a browser sends is accepted so old tabs keep working, and IGNORED:
 * a disagreement is only counted (appState uniform:dayMismatch).
 *
 * The same-day rule is a different question answered at a different layer: see
 * duplicateVerdict. A second sighting returns the row that already exists,
 * flagged, so the screen can offer to add a loaner to it instead of arguing
 * with the person holding the tablet.
 *
 * A REFUSAL THE QUEUE CAN READ. A press that can never land (no such student,
 * two records, no access) is ANSWERED as { ok: false, refused: true, reason }
 * to the send queue, which sends an observedAt -- so it stops retrying and
 * says why, rather than retrying forever and holding every update back. A tab
 * on older code (no observedAt) still gets the thrown error it understands.
 */
export const log = mutation({
  args: {
    studentNumber: v.string(),
    // Accepted, never used: tabs on older code still send it (see above).
    day: v.optional(v.string()),
    observedAt: v.optional(v.number()),
    loanerProvided: v.boolean(),
    attemptId: v.string(),
    note: v.optional(v.string()),
    sinceDay: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const staff = await requireStaff(ctx);
    const fromQueue = args.observedAt !== undefined;
    const refuse = (reason: string) => {
      if (fromQueue) return { ok: false as const, refused: true as const, reason };
      throw new ConvexError(reason);
    };
    if (!mayLogUniform(staff.role)) return refuse(UNIFORM_ACCESS_REASON);

    const attemptId = String(args.attemptId ?? "").trim();
    if (!attemptId) return refuse("attemptId is required.");

    const nowIso = new Date().toISOString();
    const when = observedAtVerdict({
      observedAt: args.observedAt, nowIso, tz: await schoolZone(ctx), clientDay: args.day,
    });
    if (!when.ok || !when.day) return refuse(when.reason ?? "The school day could not be worked out.");
    const day = when.day;

    const number = String(args.studentNumber ?? "").trim();
    if (!number) return refuse("No student was chosen.");

    // Already done, under this same press. Return it unchanged.
    const priorAttempt = await ctx.db
      .query("uniformViolations")
      .withIndex("by_attemptId", (q) => q.eq("attemptId", attemptId))
      .first();
    if (priorAttempt) {
      return {
        ok: true, deduped: true, duplicate: false,
        row: toRow(priorAttempt),
        summary: await summaryFor(ctx, priorAttempt.studentNumber, args.sinceDay ?? null),
      };
    }

    // NOT .unique(): a duplicated student number is a data problem to report,
    // not an exception to throw in somebody's face at a door.
    const matches = await ctx.db
      .query("students")
      .withIndex("by_studentNumber", (q) => q.eq("studentNumber", number))
      .take(2);
    if (matches.length === 0) {
      return refuse(`No student has number ${number}.`);
    }
    if (matches.length > 1) {
      return refuse(
        `Two student records share number ${number}. An admin needs to merge them ` +
          `before a violation can be logged against it.`,
      );
    }
    const student: any = matches[0];

    // One per student per day -- the SERVER's day.
    const sameDay = await ctx.db
      .query("uniformViolations")
      .withIndex("by_student_day", (q) => q.eq("studentNumber", number).eq("day", day))
      .collect();
    const existing = sameDay.find(live) ?? null;
    const dup = duplicateVerdict(existing);
    if (dup.duplicate && existing) {
      return {
        ok: true, deduped: false, duplicate: true,
        canAddLoaner: dup.canAddLoaner,
        row: toRow(existing),
        summary: await summaryFor(ctx, number, args.sinceDay ?? null),
      };
    }

    await countDayMismatch(ctx, when, nowIso);
    // BEFORE THE LIST STARTED COUNTING, it never will (review, 2026-10-08).
    // A queued Friday entry that reaches the server on Monday is filed under
    // Friday; if the student's division only counts from Monday (switched on,
    // or gone from the pilot to live, over the weekend), it is stored
    // before-start, exactly as a Friday tardy first seen on Monday is, and no
    // list ever claims it.
    // NOT WHILE THE DIVISION IS OFF (second review, 2026-10-08). Switched on
    // later that same morning, counting from today, the division must take
    // that morning's entries, as it takes that day's tardies (first seen
    // after the switch); a stamp made while it was off was never lifted. An
    // entry is left unstamped then: setMode parks it if it is dated before
    // the day counting starts, and each freeze asks again as it claims
    // (reflectionRules.beforeStartAtClaim).
    const division = divisionOfGrade(student.grade);
    const settings = await loadSettings(ctx);
    const beforeStart = division && settings.modeByDivision[division] === "off" ? null : admitState(day, division, settings);
    const loaner = args.loanerProvided === true;
    const id = await ctx.db.insert("uniformViolations", {
      studentId: student._id,
      studentNumber: number,
      // SNAPSHOTS. A student who withdraws must still read correctly on a list
      // of who was out of uniform in October.
      studentName: `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim(),
      studentGrade: String(student.grade ?? ""),
      day,
      // When it was SEEN, if that is believable; otherwise now.
      at: when.at,
      ...(when.source === "observed" ? { observedAt: args.observedAt } : {}),
      ...(when.savedAt ? { savedAt: when.savedAt } : {}),
      loanerProvided: loaner,
      loanerOutstanding: loaner,
      loanerReturnedAt: null,
      loanerReturnedByEmail: null,
      note: String(args.note ?? "").trim(),
      // From the session, never from the arguments.
      loggedByEmail: String(staff.email ?? ""),
      loggedByName: String(staff.name ?? staff.email ?? ""),
      loggedByRole: String(staff.role ?? ""),
      attemptId,
      voidedAt: null,
      voidedByEmail: null,
      voidReason: null,
      ...(beforeStart ? { reflectionState: beforeStart } : {}),
    });

    const row = await ctx.db.get(id);
    return {
      ok: true, deduped: false, duplicate: false,
      row: toRow(row),
      summary: await summaryFor(ctx, number, args.sinceDay ?? null),
    };
  },
});

/** Add or remove the loaner flag on an entry that already exists. */
export const setLoaner = mutation({
  args: { id: v.id("uniformViolations"), loanerProvided: v.boolean(), sinceDay: v.optional(v.string()) },
  handler: async (ctx, { id, loanerProvided, sinceDay }) => {
    const staff = await requireStaff(ctx);
    if (!mayLogUniform(staff.role)) throw new ConvexError(UNIFORM_ACCESS_REASON);
    const r = await ctx.db.get(id);
    if (!r) throw new ConvexError("That entry no longer exists.");
    if (r.voidedAt) throw new ConvexError("That entry was undone.");
    await ctx.db.patch(id, {
      loanerProvided,
      // Turning the flag off clears the loan with it; there is no loan to
      // return if one was never given.
      loanerOutstanding: loanerProvided ? r.loanerReturnedAt == null : false,
    });
    const row = await ctx.db.get(id);
    return { ok: true, row: toRow(row), summary: await summaryFor(ctx, r.studentNumber, sinceDay ?? null) };
  },
});

/**
 * Mark a loaner as handed back.
 *
 * The owner's decision, 2026-09-18: loaners are tracked to return, not just
 * recorded as given. This is the closing half, and it is deliberately NOT part
 * of the daily logging flow -- it happens later, from the outstanding list,
 * so that nothing about returning a shirt slows down the morning door pass.
 */
export const returnLoaner = mutation({
  args: { id: v.id("uniformViolations") },
  handler: async (ctx, { id }) => {
    const staff = await requireStaff(ctx);
    if (!mayLogUniform(staff.role)) throw new ConvexError(UNIFORM_ACCESS_REASON);
    const r = await ctx.db.get(id);
    if (!r) throw new ConvexError("That entry no longer exists.");
    if (r.loanerProvided !== true) throw new ConvexError("No loaner was given on that entry.");
    if (r.loanerReturnedAt) return { ok: true, already: true, row: toRow(r) };
    await ctx.db.patch(id, {
      loanerOutstanding: false,
      loanerReturnedAt: new Date().toISOString(),
      loanerReturnedByEmail: String(staff.email ?? ""),
    });
    return { ok: true, already: false, row: toRow(await ctx.db.get(id)) };
  },
});

/**
 * Undo an entry. A soft void, never a delete.
 *
 * This is what buys the right to log with one keystroke and no confirmation
 * dialog: a mistake costs one tap to reverse. The row stays readable, so a
 * correction is on the record rather than a gap in it.
 *
 * ONCE ITS REFLECTION ROOM LIST IS MADE, A REASON IS REQUIRED (step 5). The
 * entry is then on paper in a supervisor's hand; taking it off shows on every
 * earlier print as "removed after the list was made", and the reason is what
 * that line can say. A detention left with nothing on it is released, as a
 * cleared tardy releases one. Before that, Undo is still one tap, and the
 * default reason names who undid it -- not "the person who logged it", which
 * it said even when someone else had.
 */
export const voidEntry = mutation({
  args: { id: v.id("uniformViolations"), reason: v.optional(v.string()), sinceDay: v.optional(v.string()) },
  handler: async (ctx, { id, reason, sinceDay }) => {
    const staff = await requireStaff(ctx);
    if (!mayLogUniform(staff.role)) throw new ConvexError(UNIFORM_ACCESS_REASON);
    const r = await ctx.db.get(id);
    if (!r) throw new ConvexError("That entry no longer exists.");
    if (r.voidedAt) return { ok: true, already: true, row: toRow(r) };
    const why = String(reason ?? "").trim().slice(0, 300);
    if (r.unitId && !why) {
      throw new ConvexError(
        "This entry is on a Reflection Room list that has already been made. Give a reason for removing it: " +
          "it will show as removed after the list was made.",
      );
    }
    const now = new Date().toISOString();
    await ctx.db.patch(id, {
      voidedAt: now,
      voidedByEmail: String(staff.email ?? ""),
      voidReason: why || `Undone by ${String(staff.name || staff.email || "staff")}`,
      // A voided entry holds no loaner open.
      loanerOutstanding: false,
    });
    // Nothing left on its detention: released ("release this student").
    if (r.unitId) await recheckRelease(ctx, r.unitId, now);
    return {
      ok: true, already: false,
      row: toRow(await ctx.db.get(id)),
      summary: await summaryFor(ctx, r.studentNumber, sinceDay ?? null),
    };
  },
});

/**
 * Everything logged on one day, newest first.
 *
 * NO DAY, OR "today": the SERVER's school day (step 5), returned as `day`, so
 * the Today view and its "Logging for" line never read the Chromebook's clock.
 * A tab on older code still sends its own date and gets that day.
 */
export const forDay = query({
  args: { day: v.optional(v.string()) },
  handler: async (ctx, { day }) => {
    const staff = await requireStaff(ctx);
    if (!mayReadUniform(staff.role)) {
      return { allowed: false, reason: UNIFORM_ACCESS_REASON, rows: [], truncated: false, day: null };
    }
    const which = !day || day === "today" ? await schoolToday(ctx) : String(day);
    const raw = await ctx.db
      .query("uniformViolations")
      .withIndex("by_day", (q) => q.eq("day", which))
      .take(MAX_ROWS + 1);
    const truncated = raw.length > MAX_ROWS;
    const rows = (truncated ? raw.slice(0, MAX_ROWS) : raw)
      .filter(live)
      .map(toRow)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { allowed: true, reason: null, rows, truncated, day: which };
  },
});

/**
 * Per-student counts across a window, for the repeat list and the badges.
 *
 * COUNTED ON THE SERVER, TIERED IN THE BROWSER. A Chromebook at a door cannot
 * hold and rescan a year of daily logs, so the count is an indexed read. But
 * how many violations make a repeat offender is a rule the school will argue
 * about, so it stays in wildcat-discipline.js where a test can vary it and no
 * deploy is needed to change it. attendanceList.ts already draws exactly this
 * line.
 */
export const counts = query({
  // `today` and `sinceDay` from a tab on older code; a current tab sends only
  // `windowDays`, and the window is counted back from the SERVER's school day.
  args: { sinceDay: v.optional(v.string()), today: v.optional(v.string()), windowDays: v.optional(v.number()) },
  handler: async (ctx, { sinceDay, today: asked, windowDays }) => {
    const staff = await requireStaff(ctx);
    if (!mayReadUniform(staff.role)) {
      return { allowed: false, reason: UNIFORM_ACCESS_REASON, rows: [], truncated: false, sinceDay: null };
    }
    const today = asked ?? await schoolToday(ctx);
    const days = Number.isInteger(windowDays) && (windowDays as number) > 0 ? (windowDays as number) : null;
    const from = windowStart(sinceDay ?? (days ? dayMinus(today, days - 1) : null), today);
    if (!from) {
      return { allowed: true, reason: null, rows: [], truncated: false, sinceDay: null, today };
    }
    const raw = await ctx.db
      .query("uniformViolations")
      .withIndex("by_day", (q) => q.gte("day", from).lte("day", String(today)))
      .take(MAX_ROWS + 1);
    const truncated = raw.length > MAX_ROWS;
    const rows = (truncated ? raw.slice(0, MAX_ROWS) : raw).filter(live);

    const by = new Map<string, any>();
    for (const r of rows as any[]) {
      let e = by.get(r.studentNumber);
      if (!e) {
        e = {
          studentNumber: r.studentNumber, studentName: r.studentName,
          studentGrade: r.studentGrade, count: 0, days: new Set<string>(),
          loaners: 0, loanersOutstanding: 0, lastDay: "",
        };
        by.set(r.studentNumber, e);
      }
      e.count++;
      e.days.add(r.day);
      if (r.loanerProvided === true) e.loaners++;
      if (r.loanerOutstanding === true) e.loanersOutstanding++;
      if (r.day > e.lastDay) e.lastDay = r.day;
      // The newest snapshot wins, so a renamed or promoted student reads right.
      if (r.day >= e.lastDay) { e.studentName = r.studentName; e.studentGrade = r.studentGrade; }
    }
    return {
      allowed: true, reason: null, sinceDay: from, today, truncated,
      rows: [...by.values()].map((e) => ({
        studentNumber: e.studentNumber, studentName: e.studentName,
        studentGrade: e.studentGrade, count: e.count, days: e.days.size,
        loaners: e.loaners, loanersOutstanding: e.loanersOutstanding, lastDay: e.lastDay,
      })),
    };
  },
});

/** One student's numbers, for the badge the moment they are picked. */
export const studentSummary = query({
  args: { studentNumber: v.string(), sinceDay: v.optional(v.string()) },
  handler: async (ctx, { studentNumber, sinceDay }) => {
    const staff = await requireStaff(ctx);
    if (!mayReadUniform(staff.role)) {
      return { allowed: false, reason: UNIFORM_ACCESS_REASON, summary: null };
    }
    return {
      allowed: true, reason: null,
      summary: await summaryFor(ctx, String(studentNumber), sinceDay ?? null),
    };
  },
});

/** Loaners handed out and not yet back. One indexed read. */
export const outstandingLoaners = query({
  args: {},
  handler: async (ctx) => {
    const staff = await requireStaff(ctx);
    if (!mayReadUniform(staff.role)) {
      return { allowed: false, reason: UNIFORM_ACCESS_REASON, rows: [], truncated: false };
    }
    const raw = await ctx.db
      .query("uniformViolations")
      .withIndex("by_loanerOutstanding", (q) => q.eq("loanerOutstanding", true))
      .take(MAX_ROWS + 1);
    const truncated = raw.length > MAX_ROWS;
    const rows = (truncated ? raw.slice(0, MAX_ROWS) : raw)
      .filter(live)
      .map(toRow)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return { allowed: true, reason: null, rows, truncated };
  },
});

/**
 * THERE IS DELIBERATELY NO `history` QUERY YET.
 *
 * A paged per-student history is obviously wanted -- an interventionist
 * standing with a child will ask "when were the others?" -- and it is a short
 * function over the `by_student` index. It is not here because there is no
 * screen for it, and an exported server function with no caller is the exact
 * bug class convex-wiring.test.mjs exists to catch: it has shipped three times
 * in this repo, each time looking like a working feature from every angle.
 *
 * Add it WITH the screen that reads it, not before.
 */
