/**
 * FROM POWERSCHOOL'S PERIOD RECORDS TO A DAILY ATTENDANCE RATE, per grade band.
 *
 * The owner's run chart (2026-09-23) plots an attendance RATE that resets
 * every period -- weekly, and monthly for two secondary measures -- because a
 * cumulative year-to-date figure cannot go on a run chart: each point contains
 * nearly all of the one before (the points are not independent, and the rules
 * assume they are), and the chronic threshold moves under it (measured here:
 * 120 students "stopped being chronic" in one day because the bar crossed one
 * whole absence).
 *
 * This module turns one stretch of PowerSchool's own records into, for each
 * school day and each grade band:
 *
 *   members   students ENROLLED that day -- the denominator
 *   absent    of those, how many had any absent period, split into whole days
 *             and partial days with the app's one rule (absenceDayRules.ts)
 *
 * and, per month per band, the per-student measures a daily total cannot give
 * (average days absent per student; the share who missed 10%+ of THEIR days).
 *
 * PURE: no database, no network. The action in attendanceRunChart.ts fetches
 * and writes; everything that decides a number is here and is tested.
 *
 * THE OWNER'S DECISIONS, 2026-09-23, each one a choice this file encodes:
 *   - ABSENT MEANS A WHOLE DAY OUT. A day missing some periods counts as
 *     attended; the partial days are still counted, separately, for honesty.
 *   - ENROLLED ON A DAY means scheduled in at least one class that MET that
 *     day (the class's dateenrolled <= day < dateleft, and its period ran).
 *     This is how PowerSchool itself derives membership for period-by-period
 *     attendance, and it is the only definition last year's data supports.
 *   - LAST YEAR'S GRADE is ESTIMATED as today's grade minus one for a student
 *     whose record was rolled into a later year (PowerSchool's enrolment
 *     history is not readable), and taken as recorded for anyone else.
 *     Wrong only for a student who repeated a grade; the rows say estimated.
 *   - GRADE BANDS are 6-8 and 9-12. A student in neither is still counted in
 *     the whole school, through an "other" row that no band line reads.
 */
import { addAbsenceDay, emptyAbsenceSplit, type AbsenceSplit } from "./absenceDayRules";

export type Band = "6-8" | "9-12";
export const BANDS: Band[] = ["6-8", "9-12"];
/**
 * A student enrolled that day whose grade falls in neither band (a repeating
 * 6th grader estimated as grade 5, a record with no grade). Stored as its own
 * row so the WHOLE-SCHOOL line still counts them -- that line must not depend
 * on the grade estimate -- while neither band line does.
 */
export const OTHER = "other";
export type RowBand = Band | typeof OTHER;

/** The grade band, or null for a grade outside 6-12 (kept out, and counted). */
export function bandOfGrade(grade: unknown): Band | null {
  const g = parseInt(String(grade ?? "").trim(), 10);
  if (!Number.isFinite(g)) return null;
  if (g >= 6 && g <= 8) return "6-8";
  if (g >= 9 && g <= 12) return "9-12";
  return null;
}

/**
 * The grade a student was in during the year being built.
 *
 * For the CURRENT year it is what PowerSchool records. For a PAST year it is
 * estimated (the owner's decision above): a student whose record was ROLLED
 * INTO A LATER YEAR has moved up one; anyone else keeps the grade recorded.
 *
 * ROLLED OVER MEANS THE RECORD STARTS AFTER THAT YEAR ENDED. PowerSchool's
 * end-of-year run gives every continuing student a new entrydate in the next
 * year, and promotes them. The exit date cannot say this: an exit date is the
 * FIRST DAY NOT ENROLLED, so a student who stayed to the last day (2026-06-10)
 * and left carries 2026-06-11 -- after the year -- while never having been
 * promoted. Keying on the exit date put them a grade too low (a 6th grader
 * into no band at all); caught in review 2026-09-24.
 */
export function gradeForYear(
  student: { grade_level?: unknown; enroll_status?: unknown; entrydate?: unknown },
  isCurrentYear: boolean,
  yearLastDay: string,
): { grade: number | null; estimated: boolean } {
  const g = parseInt(String(student.grade_level ?? "").trim(), 10);
  if (!Number.isFinite(g)) return { grade: null, estimated: false };
  // A GRADUATE IS RECORDED AS GRADE 99 (enroll_status 3), so the year they sat
  // classes here was their senior year. Measured 2025-10: 36 of last year's
  // seniors, enrolled every day and in no band, until this line.
  if (g === 99 || String(student.enroll_status) === "3") return { grade: 12, estimated: true };
  if (isCurrentYear) return { grade: g, estimated: false };
  const entry = String(student.entrydate ?? "").slice(0, 10);
  const rolledOver = entry.length === 10 && entry > yearLastDay;
  return rolledOver ? { grade: g - 1, estimated: true } : { grade: g, estimated: false };
}

export type DayBand = AbsenceSplit & { date: string; band: RowBand; members: number };
export type MonthBand = {
  month: string; band: RowBand;
  students: number; memberDays: number; fullDayAbsences: number; chronicStudents: number;
};

/**
 * The misrecord threshold the month measures use: the app's shipped default
 * (WildcatRoster.DEFAULT_DAY_SETTINGS.misrecordAt). A day whose only non-absent
 * block was explicitly marked present counts as a whole day out. The DAY rows
 * keep the components, so the weekly chart applies whatever the screen uses.
 */
export const MONTH_MISRECORD_AT = 1;

export type BuildInput = {
  /** [{ studentid, att_date, attendance_codeid, ccid }] -- every record in range. */
  attendance: Array<Record<string, unknown>>;
  /** [{ id, studentid, expression, dateenrolled, dateleft }] -- the year's schedules. */
  cc: Array<Record<string, unknown>>;
  /** [{ id, grade_level, enroll_status, entrydate }] -- students of EVERY status. */
  students: Array<Record<string, unknown>>;
  /** attendance_code ids whose presence status is Absent, for that year. */
  absentCodeIds: Set<string>;
  from: string;
  to: string;
  isCurrentYear: boolean;
  yearLastDay: string;
};

export function buildRunDays(input: BuildInput) {
  const { from, to } = input;
  const inRange = (d: string) => d.length === 10 && d >= from && d <= to;

  // --- the schedule: each class's period slot and its enrolment span -------
  type Seat = { slot: string; start: string; end: string };
  const seatsOf = new Map<string, Seat[]>();       // studentid -> classes
  const slotOfCc = new Map<string, string>();       // ccid -> slot
  for (const c of input.cc) {
    const slot = String(c.expression ?? "").trim();
    const sid = String(c.studentid ?? "");
    const id = String(c.id ?? "");
    if (!slot || !sid) continue;
    // A DROPPED class is still read (the fetch asks for the negated term range
    // too, which is how PowerSchool marks a drop): its dates say when the
    // student sat in it, and its attendance happened.
    if (id) slotOfCc.set(id, slot);
    const start = String(c.dateenrolled ?? "").slice(0, 10);
    const end = String(c.dateleft ?? "").slice(0, 10);
    if (start.length !== 10 || end.length !== 10) continue;
    // dateleft is the first day NOT in the class; equal dates mean never sat.
    if (end <= start) continue;
    const list = seatsOf.get(sid) || [];
    list.push({ slot, start, end });
    seatsOf.set(sid, list);
  }

  // --- the records: which periods ran each day, and each student's marks ---
  const slotsRan = new Map<string, Set<string>>();
  type Cell = { absent: Set<string>; present: Set<string> };
  const cells = new Map<string, Cell>();             // studentid|date
  let unmappedCc = 0, considered = 0;
  for (const r of input.attendance) {
    const date = String(r.att_date ?? "").slice(0, 10);
    if (!inRange(date)) continue;
    considered++;
    const slot = slotOfCc.get(String(r.ccid ?? ""));
    if (!slot) { unmappedCc++; continue; }
    if (!slotsRan.has(date)) slotsRan.set(date, new Set());
    slotsRan.get(date)!.add(slot);
    const key = String(r.studentid ?? "") + "|" + date;
    let cell = cells.get(key);
    if (!cell) { cell = { absent: new Set(), present: new Set() }; cells.set(key, cell); }
    if (input.absentCodeIds.has(String(r.attendance_codeid ?? ""))) cell.absent.add(slot);
    else cell.present.add(slot);
  }
  const schoolDays = [...slotsRan.keys()].sort();

  // --- students: band for this year ----------------------------------------
  const bandOf = new Map<string, Band>();
  const rawOf = new Map<string, string>();
  let estimatedGrades = 0, outsideBands = 0, keptGrade = 0;
  for (const s of input.students) {
    const sid = String(s.id ?? "");
    if (!sid) continue;
    rawOf.set(sid, `grade ${String(s.grade_level ?? "?")}, status ${String(s.enroll_status ?? "?")}`);
    const g = gradeForYear(s, input.isCurrentYear, input.yearLastDay);
    if (!input.isCurrentYear && !g.estimated) keptGrade++;
    const band = bandOfGrade(g.grade);
    if (!band) { outsideBands++; continue; }
    bandOf.set(sid, band);
    if (g.estimated) estimatedGrades++;
  }

  // --- assemble, day by day ---------------------------------------------------
  const days = new Map<string, DayBand>();           // date|band
  const dayRow = (date: string, band: RowBand) => {
    const k = date + "|" + band;
    let row = days.get(k);
    if (!row) { row = Object.assign({ date, band, members: 0 }, emptyAbsenceSplit()); days.set(k, row); }
    return row;
  };
  // per student per month: member days, whole days out
  const tally = new Map<string, { band: RowBand; month: string; memberDays: number; fullDays: number }>();
  let membersWithoutBand = 0;
  // WHO FELL OUTSIDE BOTH BANDS, as grade/status counts only, so a gap in the
  // estimate is visible rather than silently shrinking the denominator.
  const unbanded = new Map<string, Set<string>>();

  for (const [sid, seats] of seatsOf) {
    const known = bandOf.get(sid);
    const band: RowBand = known ?? OTHER;
    for (const date of schoolDays) {
      const ran = slotsRan.get(date)!;
      // THE STUDENT'S CLASSES THAT MET THAT DAY: enrolled in the class on that
      // date, AND the period actually ran school-wide.
      const blocks = new Set<string>();
      for (const s of seats) if (s.start <= date && date < s.end && ran.has(s.slot)) blocks.add(s.slot);
      if (!blocks.size) continue;                  // not enrolled in anything that met
      if (!known) {
        // Counted in the "other" row (the whole school), and reported.
        membersWithoutBand++;
        const k = rawOf.get(sid) ?? "no student record";
        if (!unbanded.has(k)) unbanded.set(k, new Set());
        unbanded.get(k)!.add(sid);
      }
      const row = dayRow(date, band);
      row.members++;
      const month = date.slice(0, 7);
      const tk = sid + "|" + month;
      let t = tally.get(tk);
      if (!t) { t = { band, month, memberDays: 0, fullDays: 0 }; tally.set(tk, t); }
      t.memberDays++;

      const cell = cells.get(sid + "|" + date);
      if (!cell) continue;
      let absentBlocks = 0, presentBlocks = 0;
      for (const b of blocks) {
        if (cell.absent.has(b)) absentBlocks++;
        else if (cell.present.has(b)) presentBlocks++;
      }
      if (!absentBlocks) continue;
      const blocksThatDay = blocks.size;
      const unrecordedBlocks = Math.max(0, blocksThatDay - absentBlocks - presentBlocks);
      const day = { blocksThatDay, absentBlocks, presentBlocks, unrecordedBlocks };
      addAbsenceDay(row, day);
      // THE MONTH MEASURES USE THE APP'S DEFAULT THRESHOLD: strict, or a gap
      // made only of explicit presents no larger than MONTH_MISRECORD_AT.
      const gap = blocksThatDay - absentBlocks;
      if (gap <= 0 || (presentBlocks >= gap && gap <= MONTH_MISRECORD_AT)) t.fullDays++;
    }
  }

  const months = new Map<string, MonthBand>();
  for (const t of tally.values()) {
    const k = t.month + "|" + t.band;
    let m = months.get(k);
    if (!m) { m = { month: t.month, band: t.band, students: 0, memberDays: 0, fullDayAbsences: 0, chronicStudents: 0 }; months.set(k, m); }
    m.students++;
    m.memberDays += t.memberDays;
    m.fullDayAbsences += t.fullDays;
    // CHRONIC FOR THAT MONTH: whole days out at 10% or more of the days THAT
    // STUDENT was enrolled in it. Resets every month, so it can be charted.
    if (t.fullDays > 0 && t.fullDays * 10 >= t.memberDays) m.chronicStudents++;
  }

  return {
    schoolDays,
    days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.band < b.band ? -1 : 1)),
    months: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.band < b.band ? -1 : 1)),
    diagnostics: {
      recordsConsidered: considered, unmappedCc,
      unmappedShare: considered ? unmappedCc / considered : 0,
      studentsWithClasses: seatsOf.size, estimatedGrades, keptGrade, outsideBands, membersWithoutBand,
      unbandedStudents: Object.fromEntries([...unbanded.entries()].map(([k, set]) => [k, set.size])),
    },
  };
}
