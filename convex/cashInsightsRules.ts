/**
 * THE BEHAVIOUR-CHANGE CHECK'S ATTENDANCE LINES, as weekly totals per campus.
 * Pure: no ctx, no clock, no database. cashInsights.ts reads the two tables;
 * this decides every number, so the rules can be tested without either.
 *
 * WHY THESE TWO LINES (the owner, 2026-10-06: recommendation #4, "an outcome
 * adults don't control, beside cash"). Every cash figure counts what ADULTS
 * did. Whether praise is changing anything has to be read off something the
 * students do and the adults cannot award: arriving late without an excuse,
 * and missing part of a day. Referrals join later; ten had been entered since
 * 9/14, too few to be a line.
 *
 * WHAT THE BROWSER GETS: weekly sums per campus (grades 6-8, grades 9-12),
 * the school-day dates, and nothing about any one student. The browser
 * applies the whole-day rule (WildcatRoster.absenceSplit, the one every
 * attendance screen uses) and does the per-100 arithmetic, so the misrecord
 * threshold stays a display rule that can change without a deploy.
 *
 * TWO SOURCES, NOT QUITE ONE POPULATION, and the screen says so:
 *   part-day absences  attendanceRunDays: students enrolled THAT day, leavers
 *                      included, built nightly at 03:15 Los Angeles from
 *                      PowerSchool. The same rows as the attendance-rate chart.
 *   unexcused tardies  psAttendanceMarks: one row per student enrolled NOW,
 *                      rebuilt twice a day (06:30 and 12:30 Los Angeles).
 *
 * THE FRESHNESS FENCES (review, 2026-10-06). The two tables are refilled by
 * separate jobs. If the marks rebuild stops -- the 40,000-row wall it hit in
 * testing, a PowerSchool outage -- the run table keeps adding school days the
 * marks know nothing about, and every one of those days would read as nobody
 * late: a sudden "improvement" made of missing data, landing just as the
 * ten-week reading falls due. So:
 *   - tardies are counted only on school days on or before `marksThrough`,
 *     the last day the marks were complete for (the day before their newest
 *     sync, in Los Angeles: the midday rebuild sees only half of its own day);
 *     a week reaching past it is `tardyStale`, never a rate;
 *   - a week is "in" only once the run table was BUILT after its Friday
 *     (`runBuiltThrough`, from the rows' own syncedAt). Before that it is
 *     "pending" -- attendance not yet in -- rather than a short week. Read off
 *     the build time and not off the last date present, so a holiday Friday
 *     is not mistaken for a failed night.
 */

export const OUTCOME_BANDS = ["6-8", "9-12"] as const;

/**
 * THE WEEKS WITHOUT THEIR ATTENDANCE, for a viewer the attendance screens
 * refuse (review, 2026-10-06). The same campus sums the attendance run chart
 * returns only to administrators, the PBIS team and Attendance Watch
 * (accessRules.canReadInsights), so trendsContext returns them only to the
 * same people. Everyone else keeps the calendar -- the weeks, their school
 * days and whether they are in -- for the praise columns beside them.
 */
export function withoutAttendance<W extends { monday: string; friday: string; status: string; dates: string[]; tardyStale: boolean }>(weeks: ReadonlyArray<W>) {
  return weeks.map((w) => ({ monday: w.monday, friday: w.friday, status: w.status, dates: w.dates, tardyStale: w.tardyStale, bands: null }));
}
export type OutcomeBand = (typeof OUTCOME_BANDS)[number];

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" in Los Angeles for a timestamp, or null when it is not one. */
export function laDayOf(iso: unknown): string | null {
  const ms = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ms));
}

/** Calendar arithmetic on "YYYY-MM-DD", at noon UTC so no clock change can move it. */
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The Monday on or before a calendar day. */
export function mondayOf(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
}

/** Grades 6-8 and 9-12, the app's campus rule (WildcatStore.studentCampusOf). Anything else is neither. */
export function bandOfGrade(grade: unknown): OutcomeBand | null {
  const n = parseInt(String(grade ?? "").trim(), 10);
  if (!Number.isFinite(n)) return null;
  if (n >= 6 && n <= 8) return "6-8";
  if (n >= 9 && n <= 12) return "9-12";
  return null;
}

export type RunDay = {
  date: string;
  band: string;
  members: number;
  absentDays: number;
  fullDaysStrict: number;
  misrecordDaysByGap: number[];
  partialDays: number;
  assumedPresentDays: number;
  syncedAt?: string;
};

export type MarksRow = {
  gradeLevel?: string | null;
  entryDate?: string | null;
  absentDates?: string[] | null;
  tardyDates?: string[] | null;
  unexcusedTardyDates?: string[] | null;
  syncedAt?: string | null;
};

export type BandWeek = {
  /** School days this band has a row for. */
  days: number;
  members: number;
  absentDays: number;
  fullDaysStrict: number;
  misrecordDaysByGap: number[];
  partialDays: number;
  assumedPresentDays: number;
  /** (student, school day) pairs late without an excuse; null when the marks do not reach this week. */
  unexcusedTardyDays: number | null;
  /** The matching student-days: each school day, the students enrolled by then. Null with the above. */
  tardyMemberDays: number | null;
};

export type OutcomeWeek = {
  monday: string;
  friday: string;
  /** "in": the run table was built after this Friday. "pending": attendance not yet in. */
  status: "in" | "pending";
  dates: string[];
  tardyStale: boolean;
  bands: Record<OutcomeBand, BandWeek>;
};

/**
 * The first day a student could have been marked: the entry date, moved back
 * to any earlier SCHOOL day they were recorded absent or late on (a
 * re-entry). The same rule as WildcatRoster.windowAbsenceList, so the
 * numerator and the denominator use one entry and a rate cannot pass 100%.
 * "" when there is no usable entry date: counted on every day.
 */
export function effectiveEntry(row: MarksRow, schoolDays: ReadonlySet<string>): string {
  let entry = String(row.entryDate ?? "").slice(0, 10);
  if (!ISO.test(entry)) return "";
  for (const x of [...(row.absentDates ?? []), ...(row.tardyDates ?? [])]) {
    const d = String(x ?? "").slice(0, 10);
    if (schoolDays.has(d) && d < entry) entry = d;
  }
  return entry;
}

const blankBand = (gaps: number): BandWeek => ({
  days: 0, members: 0, absentDays: 0, fullDaysStrict: 0, misrecordDaysByGap: new Array(gaps).fill(0),
  partialDays: 0, assumedPresentDays: 0, unexcusedTardyDays: null, tardyMemberDays: null,
});

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/**
 * The finished weeks of the current school year, per campus.
 *
 *   runDays  this year's attendanceRunDays rows (any order)
 *   marks    psAttendanceMarks rows
 *   today    the browser's calendar day, "YYYY-MM-DD"
 *
 * A FINISHED WEEK is a Monday-to-Friday week whose Friday is before today.
 * The week in progress is never returned: on a Wednesday it would be a
 * two-day week standing beside full ones.
 */
export function outcomeWeeks(input: { runDays: ReadonlyArray<RunDay>; marks: ReadonlyArray<MarksRow>; today: string; serverDay?: string | null }) {
  // NO FURTHER AHEAD THAN THE SERVER'S OWN TOMORROW (review, 2026-10-06).
  // `today` is the browser's: a Chromebook a year fast added 52 empty
  // "not yet in" weeks, and 9999-12-31 -- which any staff member can send --
  // built 416,031 of them and failed the query. The caller passes its own Los
  // Angeles day; without one the browser's day stands.
  const asked = String(input.today ?? "");
  const serverDay = String(input.serverDay ?? "");
  const today = ISO.test(serverDay) && ISO.test(asked) && asked > addDays(serverDay, 1) ? addDays(serverDay, 1) : asked;
  const runDays = (input.runDays ?? []).filter((r) => r && ISO.test(String(r.date)) && String(r.date) < today &&
    (OUTCOME_BANDS as readonly string[]).includes(String(r.band)));
  const gaps = runDays.reduce((m, r) => Math.max(m, Array.isArray(r.misrecordDaysByGap) ? r.misrecordDaysByGap.length : 0), 0);

  const schoolDates = [...new Set(runDays.map((r) => r.date))].sort();
  const schoolDaySet = new Set(schoolDates);
  const through = schoolDates.length ? schoolDates[schoolDates.length - 1] : null;

  // WHEN THE RUN TABLE WAS LAST BUILT. The nightly run writes every school
  // day up to the one before it ran, so a build on the 6th covers the 5th.
  let newestRunSync: string | null = null;
  for (const r of runDays) {
    const s = String(r.syncedAt ?? "");
    if (s && (!newestRunSync || s > newestRunSync)) newestRunSync = s;
  }
  const builtDay = laDayOf(newestRunSync);
  let runBuiltThrough = builtDay ? addDays(builtDay, -1) : through;
  if (through && (!runBuiltThrough || runBuiltThrough < through)) runBuiltThrough = through;

  // THE MARKS: who counts, and how far they reach.
  let marksMissingUnexcused = 0, marksOutsideBands = 0, newestMarksSync: string | null = null;
  const usable: Array<{ band: OutcomeBand; entry: string; late: Set<string> }> = [];
  for (const m of input.marks ?? []) {
    if (!m) continue;
    const s = String(m.syncedAt ?? "");
    if (s && (!newestMarksSync || s > newestMarksSync)) newestMarksSync = s;
    const band = bandOfGrade(m.gradeLevel);
    if (!band) { marksOutsideBands++; continue; }
    // NULL IS NOT "NEVER LATE". A row the rebuild has not refilled since the
    // field arrived has no answer, and counting it as zero tardies would be
    // the good news read off missing data.
    if (!Array.isArray(m.unexcusedTardyDates)) { marksMissingUnexcused++; continue; }
    usable.push({ band, entry: effectiveEntry(m, schoolDaySet),
                  late: new Set(m.unexcusedTardyDates.map((d) => String(d ?? "").slice(0, 10))) });
  }
  const marksDay = laDayOf(newestMarksSync);
  const marksThrough = marksDay ? addDays(marksDay, -1) : null;

  // EVERY MONDAY from the year's first school day to the last finished week,
  // so a week the nightly run never wrote shows as pending, not as missing.
  const byDate = new Map<string, RunDay[]>();
  for (const r of runDays) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }
  const weeks: OutcomeWeek[] = [];
  if (schoolDates.length && ISO.test(today)) {
    for (let mon = mondayOf(schoolDates[0]); addDays(mon, 4) < today; mon = addDays(mon, 7)) {
      const friday = addDays(mon, 4);
      const dates = schoolDates.filter((d) => d >= mon && d <= addDays(mon, 6));
      const status: "in" | "pending" = runBuiltThrough && friday <= runBuiltThrough ? "in" : "pending";
      // A week with no school day that the run table has already passed is a
      // holiday week: nothing to show, and nothing missing.
      if (!dates.length && status === "in") continue;
      const tardyStale = !marksThrough || dates.some((d) => d > marksThrough);
      const bands = { "6-8": blankBand(gaps), "9-12": blankBand(gaps) } as Record<OutcomeBand, BandWeek>;
      for (const d of dates) {
        for (const r of byDate.get(d) ?? []) {
          const b = bands[r.band as OutcomeBand];
          b.days += 1;
          b.members += num(r.members);
          b.absentDays += num(r.absentDays);
          b.fullDaysStrict += num(r.fullDaysStrict);
          b.partialDays += num(r.partialDays);
          b.assumedPresentDays += num(r.assumedPresentDays);
          (r.misrecordDaysByGap ?? []).forEach((c, i) => { b.misrecordDaysByGap[i] += num(c); });
        }
      }
      if (!tardyStale) {
        const late: Record<string, number> = { "6-8": 0, "9-12": 0 };
        const memberDays: Record<string, number> = { "6-8": 0, "9-12": 0 };
        for (const u of usable) {
          for (const d of dates) {
            // ONE ENTRY RULE FOR BOTH SIDES: a day before it is in neither.
            if (u.entry && d < u.entry) continue;
            memberDays[u.band] += 1;
            if (u.late.has(d)) late[u.band] += 1;
          }
        }
        for (const band of OUTCOME_BANDS) {
          bands[band].unexcusedTardyDays = late[band];
          bands[band].tardyMemberDays = memberDays[band];
        }
      }
      weeks.push({ monday: mon, friday, status, dates, tardyStale, bands });
    }
  }

  return {
    through,
    runBuiltThrough,
    marksThrough,
    schoolDates,
    weeks,
    marksRows: (input.marks ?? []).length,
    marksMissingUnexcused,
    marksOutsideBands,
  };
}
