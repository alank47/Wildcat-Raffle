/**
 * A TEST LIST, FOR SHOWING STAFF WHAT THE REFLECTION ROOM LIST WILL LOOK LIKE
 * (owner, 2026-10-08): the pure half.
 *
 * WHY THIS EXISTS. The real list counts from Friday 10/9 (a shadow pilot) and
 * goes live on Monday 10/12, but the owner wanted to show administrators a
 * list in the real Hub on Thursday 10/8, built from that day's real
 * PowerSchool marks. Thursday's real list cannot be made any more (its
 * latest time had passed when the switch went on), and making it by hand
 * would write tardies, detentions and a frozen day into the tables the real
 * list runs on. So a TEST list is worked out on the side, stored in its own
 * table, and shown -- clearly marked TEST ONLY -- only on a day that has no
 * real list.
 *
 * THE SAME RULES AS THE REAL LIST, NOT A COPY OF THEM. Everything that
 * decides who is on it comes from reflectionRules.ts, exactly as the real
 * reader and freeze call it: summarizeDay, tardyCandidates (the arrival
 * rule, the codes and the slots), reconcileDate (two marks for one period go
 * to review, never onto a list), initialTardyState, and claimAtFreeze (one
 * row per student, every violation dated, every tag). Only the inputs are
 * different, and each difference is written down here:
 *
 *   - AS IF THE LIST CLOSED NOW. Today's marks are judged as a closing read
 *     judges them (not final: a tardy whose earlier class has no marks yet is
 *     held, not listed).
 *   - AS IF YESTERDAY'S LIST HAD BEEN MADE. The previous school day's
 *     tardies before Power-Up would have been on its own list, so only the
 *     ones that never serve the same day (P5 and P6, and Power-Up when that
 *     is counted) come forward, judged with that day's marks as final, and
 *     tagged "From Wed 10/7 P5 (after Power-Up)" as the real list tags them.
 *   - BOTH DIVISIONS SHOWN, counting from the previous school day, whatever
 *     the real switch says: the real settings would park every one of these
 *     tardies (they are dated before the pilot starts).
 *   - TARDIES ONLY. No uniform entries, no carries, no queued detentions:
 *     the banner says "built from today's PowerSchool marks", and nothing of
 *     the real list's own records is read or changed.
 *
 * NO NAMES. A row carries student numbers and grades, as the real list's
 * rows do; the browser adds names from the records it already holds.
 */
import {
  absentThisMorning, admitState, claimAtFreeze, divisionOfGrade, hasEvidence, initialTardyState, PERIOD_ID_BASE, reconcileDate,
  scheduleKindFor, servesSameDay, summarizeDay, tardyCandidates, weekdayOf,
  type AttRow, type CodeBook, type Division, type Marked, type ReflectionSettings, type RosterSnap, type ScheduleKind,
  type TardyItem,
} from "./reflectionRules";

const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/**
 * One row of the TEST list: the very shape reflectionList.listForDay returns
 * for a row of a list already made, so the screen and the printed sheet draw
 * it with the code that draws a real list. Nothing on it can change after it
 * is built (no release, no clear, no carry, no room tick).
 */
export type DemoRow = {
  key: string;
  unitId: null;
  studentNumber: string;
  grade: string;
  division: Division;
  mode: "shadow";
  state: "listed";
  pu: { teacher: string | null; course: string | null; flag: string | null; check: boolean } | null;
  notOnRoster: boolean;
  lines: string[];
  tags: string[];
  owes: number;
  absentMorning: boolean;
  released: null;
  cleared: Array<{ line: string; reason: string; at: string | null }>;
  voided: Array<{ line: string; at: string }>;
  after: null;
  notHere: boolean;
  slipTo: null;
};

/** The only keys a stored TEST row may have: numbers, grades and the list's own words, never a name. */
export const DEMO_ROW_KEYS = [
  "key", "unitId", "studentNumber", "grade", "division", "mode", "state", "pu", "notOnRoster", "lines", "tags", "owes",
  "absentMorning", "released", "cleared", "voided", "after", "notHere", "slipTo",
];

/**
 * The weekday before `day` that is not marked no school: the school day
 * whose P5 and P6 tardies a list on `day` would carry. The build checks it
 * against PowerSchool (a day with no attendance in it is stepped past).
 */
export function previousWeekday(day: string, noSchool: Set<string> | string[]): string {
  const off = noSchool instanceof Set ? noSchool : new Set(noSchool);
  let d = addDays(day, -1);
  for (let i = 0; i < 60; i++, d = addDays(d, -1)) {
    const wd = weekdayOf(d);
    if (wd !== 0 && wd !== 6 && !off.has(d)) return d;
  }
  return d;
}

/** PowerSchool shows attendance being taken on this date: a school day (the reader's own test). */
export function readShowsSchool(date: string, rows: AttRow[], codes: Extract<CodeBook, { ok: true }>): boolean {
  return hasEvidence(summarizeDay(date, rows, codes, {}).rowCounts);
}

/**
 * The real settings, with both divisions shown and counting from the oldest
 * date the TEST list reads. Every other setting (counting ditching, counting
 * Power-Up tardies, holding the first class, the late-entry limit) is the
 * real one, so the TEST list follows whatever the owner has set.
 */
export function demoSettings(settings: ReflectionSettings, fromDate: string): ReflectionSettings {
  return {
    ...settings,
    modeByDivision: { ms: "shadow", hs: "shadow" },
    countFromDateByDivision: { ms: fromDate, hs: fromDate },
  };
}

/** The Power-Up class as a list already made shows it: copied from the roster row, or nothing without one. */
function puOfSnap(snap: RosterSnap | null): DemoRow["pu"] {
  if (!snap) return null;
  return { teacher: snap.puTeacherName ?? null, course: snap.puCourse ?? null, flag: snap.puFlag ?? null, check: !!snap.puCheck };
}

export type DemoCounts = {
  ms: number; hs: number; total: number;
  /** Tardies on the TEST list from the day itself, and from the previous day's P5 and P6. */
  dayTardies: number; previousDayTardies: number;
  /** Not on it: held for an earlier class's attendance, arrived late to school, two marks for one period (review). */
  held: number; arrivals: number; collisions: number;
  /** Students with no division (no roster row and no grade), and marks whose student PowerSchool's map does not know. */
  unplaced: number; unmatched: number;
};

/**
 * THE TEST LIST: the rows the real freeze would make if `day`'s list closed
 * at `builtAt`, from confirmed reads of `day` and of `previousDay`.
 */
export function demoListRows(input: {
  day: string; previousDay: string | null; tz: string; builtAt: string; settings: ReflectionSettings;
  codes: Extract<CodeBook, { ok: true }>; roster: Record<string, RosterSnap>; gradeOf: Record<string, string>;
  marked: Marked; dayRows: AttRow[]; previousRows: AttRow[] | null; unmatched?: number;
}): { rows: DemoRow[]; counts: DemoCounts; kind: ScheduleKind } {
  const { day, previousDay, roster, gradeOf, codes } = input;
  const settings = demoSettings(input.settings, previousDay ?? day);
  const divisionOf = (sn: string): Division | null => roster[sn]?.division ?? divisionOfGrade(gradeOf[sn]);
  const counts: DemoCounts = {
    ms: 0, hs: 0, total: 0, dayTardies: 0, previousDayTardies: 0, held: 0, arrivals: 0, collisions: 0, unplaced: 0,
    unmatched: input.unmatched ?? 0,
  };

  const tardies: TardyItem[] = [];
  const reads: Array<{ date: string; rows: AttRow[]; final: boolean }> = [
    ...(previousDay && input.previousRows ? [{ date: previousDay, rows: input.previousRows, final: true }] : []),
    { date: day, rows: input.dayRows, final: false },
  ];
  const daySummary = summarizeDay(day, input.dayRows, codes, roster);
  for (const r of reads) {
    const summary = r.date === day ? daySummary : summarizeDay(r.date, r.rows, codes, roster);
    const candidates = tardyCandidates(summary, roster, settings, { final: r.final });
    // Nothing stored, so every listable key is new: two marks for one period
    // come back as a collision (admin review in the real list), the rest as
    // additions with their arrival verdict.
    const rec = reconcileDate({ date: r.date, candidates, rows: r.rows, codes, items: [], confirmed: true, fullRead: true, settings });
    // The previous day's tardies before Power-Up were that day's list's.
    const ours = (slot: number) => r.date === day || !servesSameDay(slot);
    counts.collisions += rec.collisions.filter((x) => ours(Number(x.key.split("|")[2]) - PERIOD_ID_BASE)).length;
    for (const c of rec.add) {
      if (!ours(c.slot)) continue;
      const division = divisionOf(c.studentNumber);
      const init = initialTardyState({
        verdict: c.verdict, admit: admitState(c.attDate, division, settings), listsBeforeSeen: 0, lateEntryLists: settings.lateEntryLists,
      });
      if (init.state === "held") { counts.held++; continue; }
      if (init.state === "arrival") { counts.arrivals++; continue; }
      if (init.state !== "countable") continue;
      tardies.push({
        id: c.key, studentNumber: c.studentNumber, attDate: c.attDate, periodId: c.periodId, slot: c.slot, psRowIds: c.psRowIds,
        state: "countable", reason: null, unitId: null, firstSeenAt: input.builtAt, firstCountableAt: input.builtAt,
        wasHeld: false, heldReleasedAt: null, classTeacher: c.classTeacher,
      });
    }
  }

  const divisionByStudent: Record<string, Division | null> = {};
  for (const t of tardies) divisionByStudent[t.studentNumber] = divisionOf(t.studentNumber);
  const claim = claimAtFreeze({
    day, tz: input.tz, settings, divisionOf: divisionByStudent, tardies, uniforms: [], units: [], days: {},
  });
  counts.unplaced = claim.unplaced.length;
  const claimed = new Set(claim.claimedTardyIds);
  for (const t of tardies) {
    if (!claimed.has(t.id)) continue;
    if (t.attDate === day) counts.dayTardies++;
    else counts.previousDayTardies++;
  }

  const rows: DemoRow[] = claim.rows.map((r) => {
    const snap = roster[r.studentNumber] ?? null;
    if (r.division === "ms") counts.ms++;
    else counts.hs++;
    return {
      key: `demo:${r.studentNumber}`,
      unitId: null,
      studentNumber: r.studentNumber,
      grade: snap?.grade || gradeOf[r.studentNumber] || "",
      division: r.division,
      mode: "shadow",
      state: "listed",
      pu: puOfSnap(snap),
      notOnRoster: !snap,
      lines: r.lines,
      tags: r.tags,
      owes: r.owes,
      absentMorning: absentThisMorning(daySummary, r.studentNumber, snap),
      released: null,
      cleared: [],
      voided: [],
      after: null,
      notHere: false,
      slipTo: null,
    };
  });
  counts.total = rows.length;
  const kind = scheduleKindFor({ date: day, marked: input.marked, scheduleKinds: input.settings.scheduleKinds, rowCounts: daySummary.rowCounts }).kind;
  return { rows, counts, kind };
}
