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

export default crons;
