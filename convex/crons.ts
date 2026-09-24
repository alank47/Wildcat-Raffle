import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * Twice-daily PowerSchool sync.
 *
 * Convex schedules in UTC. Los Angeles is UTC-7 in daylight time and UTC-8 in
 * standard time, so these drift by an hour across the DST boundary. That is
 * accepted deliberately: the alternative is a job that fires at the wrong hour
 * for half the year in exchange for logic nobody maintains. Both runs are well
 * inside the school day either way.
 *
 *   13:00 UTC = 06:00 PDT / 05:00 PST   before first period
 *   19:00 UTC = 12:00 PDT / 11:00 PST   midday, after morning attendance
 */
const crons = cronJobs();

crons.daily(
  "sis morning sync",
  { hourUTC: 13, minuteUTC: 0 },
  internal.sisAction.syncFromPowerSchool,
  { reason: "scheduled: morning" },
);

crons.daily(
  "sis midday sync",
  { hourUTC: 19, minuteUTC: 0 },
  internal.sisAction.syncFromPowerSchool,
  { reason: "scheduled: midday" },
);

// Rebuild the per-date absence picture, half an hour after each SIS sync.
//
// SEPARATE FROM THE SYNC, on purpose. It reads the ATTENDANCE table directly
// -- 155 pages plus 56 for the enrolment slot map -- and a slow read must not
// be able to delay or fail the roster, grades and attendance pull that the
// whole app depends on. It also depends on psAttendanceBySection, which that
// sync writes, so it has to run after it rather than beside it.
crons.daily(
  "absence day rebuild (morning)",
  { hourUTC: 13, minuteUTC: 30 },
  internal.attendanceDays.rebuild,
  {},
);

crons.daily(
  "absence day rebuild (midday)",
  { hourUTC: 19, minuteUTC: 30 },
  internal.attendanceDays.rebuild,
  {},
);

// THE ATTENDANCE RUN CHART'S DAILY TOTALS, at 03:15 Los Angeles (10:15 UTC;
// 02:15 in winter), when yesterday's registers are finished and nobody is
// using PowerSchool. Reads this month (and in a month's first week, the one
// just ended) straight from PowerSchool; see attendanceRunChart.ts.
crons.daily(
  "attendance run chart (nightly)",
  { hourUTC: 10, minuteUTC: 15 },
  internal.attendanceRunChart.refreshCurrent,
  {},
);

// Refresh the Entra directory mirror nightly.
//
// Nightly rather than hourly because the thing it tracks, who works here,
// changes on the timescale of a hiring cycle. The only symptom of a stale
// mirror is a brand new hire not appearing in staff search for a few hours,
// and `npm run staff:mirror` fixes that on demand.
//
// 09:20 UTC is roughly 02:20 in Los Angeles: away from the PowerSchool syncs at
// 13:00 and 19:00, and on a minute nobody else picked.
crons.cron(
  "mirror entra directory",
  "20 9 * * *",
  internal.entraSync.mirrorDirectory,
  { reason: "nightly" },
);

/**
 * Close hall passes nobody is coming back to.
 *
 * WHY THIS HAS TO EXIST. `hasLivePass` counts any non-terminal pass as live, so
 * an approved pass that the student never taps back blocks that child from every
 * future hall pass, and before this nothing in the codebase ever wrote `expired`.
 * A pass approved at 2:50pm on the last day of term would otherwise still be open
 * when that student graduated. hallPasses.forceClose gives a teacher a manual
 * exit; this is the one that catches the passes nobody remembers.
 *
 * HOURLY, not every few minutes, and that is a deliberate pairing with
 * EXPIRY_GRACE_MINUTES. The sweep only touches passes already an hour past their
 * window, so a student who is a few minutes late still gets to tap back in and
 * close their own trip properly. Overdue stays a display state for the teacher's
 * board; this only reaps the abandoned ones.
 *
 * Runs around the clock rather than only in school hours: the passes that need
 * reaping are exactly the ones left open at the end of a day, and a bounded
 * indexed read over three states costs nothing on an empty table.
 *
 * :40 is a minute none of the other jobs use.
 */
crons.cron(
  "expire abandoned hall passes",
  "40 * * * *",
  internal.hallPasses.expireAbandoned,
  { reason: "Closed automatically: never returned." },
);

/**
 * Are the cash counters still telling the truth?
 *
 * WHY NIGHTLY, AND WHY AT ALL. A repair on 2026-09-17 brought 223 students'
 * counters back into agreement with their transaction history. One school day
 * later, 28 had drifted again -- and the owner found out on the Sunday because
 * somebody happened to look. A daily check makes the worst case one school day
 * of drift, noticed the next morning.
 *
 * IT ONLY REPORTS. It must not be turned into an auto-repair until
 * `_startNewSchoolYear` is fixed: the year roll writes no ledger row, so on the
 * night after a rollover the derivation would find every student short by their
 * whole closed year, both witnesses would agree, and the change would be an
 * INCREASE -- so neither the two-witness check nor the decrease guard would
 * stop it. It would resurrect the previous school year in one unattended run.
 * The refusal is written down on cashDriftCheck.nightly as well.
 *
 * 10:10 UTC is roughly 03:10 in Los Angeles: after the day's last awards, well
 * before the 13:00 sync, and on a minute none of the other jobs use (:00, :20,
 * :40).
 */
crons.cron(
  "cash counter drift check",
  "10 10 * * *",
  internal.cashDriftCheck.nightly,
  { reason: "nightly" },
);

/**
 * Chase referrals nobody has closed.
 *
 * WHY. On 2026-09-22, three of the four referrals ever filed were still open
 * -- at four, five and seven school days -- and the oldest was the one flagged
 * too severe for classroom interventions. A fourth was closed and the teacher
 * who filed it had never been told. The filing email goes out once and then
 * the referral's future depends on somebody remembering to open a tab.
 *
 * ONCE A DAY, ON A SCHOOL MORNING. 15:00 UTC is roughly 08:00 in Los Angeles:
 * after the 13:00 sync and the 13:30 absence rebuild that the school-day count
 * is read from, before anyone has started their day, and on an hour none of
 * the other jobs use. Age is counted in school days, so a Saturday firing
 * finds nothing newly due and sends nothing -- running seven days a week costs
 * one bounded read and saves a calendar nobody maintains.
 *
 * IT DOES NOTHING UNTIL IT IS TURNED ON:
 *   npx convex run referralPing:configure '{"enabled":true}'
 */
crons.cron(
  "chase open referrals",
  "0 15 * * *",
  internal.referralPing.sweep,
  {},
);

export default crons;
