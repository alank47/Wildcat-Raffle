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

export default crons;
