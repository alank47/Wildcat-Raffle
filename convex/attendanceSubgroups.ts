import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff } from "./identity";
import { reportedCategories, HISPANIC_LABEL } from "./raceRollup";

/**
 * CHRONIC ABSENTEEISM BY SUBGROUP.
 *
 * Asked for on 2026-09-22: Hispanic/Latino, African American, English
 * Learners, socioeconomically disadvantaged. This is the equity report every
 * state dashboard carries, and it is the one legitimate use of protected
 * characteristics in this app: it describes how the SCHOOL is doing by group,
 * and never says anything about a named child.
 *
 * SUPPRESSION HAPPENS HERE, NOT IN THE BROWSER, and that is the whole design
 * rather than a preference. This app's convention is counts on the server and
 * display rules in the browser -- but a small cell is not a display rule, it
 * is the privacy guarantee. disciplineAggregates.ts says it plainly: for
 * "aggregate only" to be a property rather than a claim, a cell small enough
 * to identify a child must never leave the server. Westbrook has 2 Pacific
 * Islander students and 3 Asian students; "50% of Pacific Islander students
 * are chronically absent" is a sentence about one specific child.
 *
 * WHAT THE SCHOOL-WIDE NUMBER DOES TO THIS SCREEN. Measured the same day:
 * 52.4% of all 618 students are chronically absent. So the subgroup rows are
 * not a way to find a smaller group to work with -- every row is roughly half
 * the students in it. The baseline is therefore returned alongside every row
 * and the screen leads with it, because a 55% subgroup rate reads as alarming
 * until you see that the school's own rate is 52%.
 *
 * SOCIOECONOMIC STATUS IS ABSENT AND SAYS SO. `students.lunchstatus` answers
 * HTTP 403 -- the field exists in PowerSchool and the plugin does not request
 * it -- and it was never in the 19-field manifest, so no probe had ever tried.
 * Returning a silent gap would read as "no disparity"; the response carries an
 * explicit `unavailable` entry naming the field and the fix.
 */

/** Below this many ENROLLED students a rate is noise and may identify. */
const SMALL_GROUP = 10;

/**
 * The chronic line: 10% of days in session.
 *
 * MUST MATCH WildcatRoster.ATTENDANCE_TIERS, which Attendance Watch uses, and
 * a test asserts they agree. Two thresholds would let one child be chronic on
 * the ranking and fine on this breakdown, which is the same reason Early
 * Warning reads its denominator off this screen rather than keeping its own.
 */
const CHRONIC = 0.10;
const SEVERE = 0.20;

/** Same three roles as the attendance ranking and the discipline breakdowns. */
const SUBGROUP_ROLES = ["admin", "superadmin", "pbis"];

/** Reporting order: the groups the question named first, then the rest. */
const RACE_ORDER = [
  HISPANIC_LABEL,
  "Black or African American",
  "White",
  "Asian",
  "Native Hawaiian or Other Pacific Islander",
  "American Indian or Alaska Native",
];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Fewer measured students than this and a gap from the average is noise. */
const FRAGILE_GROUP = 60;

const ELA_LABELS: Record<string, string> = {
  EL: "English Learner",
  EO: "English Only",
  RFEP: "Reclassified fluent (RFEP)",
  IFEP: "Initially fluent (IFEP)",
  TBD: "Assessment pending",
};

/**
 * NAMED, NOT OMITTED. A group missing from an equity breakdown reads as a
 * group with no disparity, which is the most misleading way for data to be
 * absent. Each entry says what is missing, why, and what would fix it.
 */
const UNAVAILABLE_GROUPS = [
  {
    group: "Socioeconomically disadvantaged",
    reason:
      "PowerSchool has the meal-eligibility field but the Wildcat Hub plugin does not request it, "
      + "so it answers HTTP 403. It was never in the original 19-field manifest, so it had never been tried.",
    fix: "Add Students.LunchStatus to powerschool/plugin-v2.xml, bump the version, and have the SIS "
      + "administrator re-install the plugin. In California the state definition also counts parent "
      + "education level and foster, homeless or migrant status, which live in separate fields.",
  },
  {
    group: "Students with disabilities (IEP) and 504",
    reason:
      "The source is unconfirmed. docs/access-gap.md records manifest 12 and 13 as UNKNOWN: the data "
      + "could be in the SIS core, a state extension, a local custom field, SEIS, or Special Programs.",
    fix: "The registrar and SIS administrator have to say where it lives before a plugin can ask for it.",
  },
];

type Cell = {
  axis: string; group: string;
  enrolled: number; withAttendance: number; chronic: number; severe: number;
};

export const chronicBySubgroup = query({
  args: {
    /**
     * Days in session, from the same two fields Attendance Watch uses.
     *
     * AN ARGUMENT, NOT A SERVER CONSTANT, so the two screens cannot disagree
     * about who is chronic. The browser owns that number because a person
     * corrects it for holidays there.
     */
    schoolDays: v.number(),
  },
  handler: async (ctx, { schoolDays }) => {
    const staff = await requireStaff(ctx);
    if (!SUBGROUP_ROLES.includes(staff.role)) {
      return {
        allowed: false,
        reason:
          "Attendance breakdowns by student group are limited to administrators and the PBIS team. " +
          "Ask an administrator to set your access level to PBIS Team.",
        rows: [], baseline: null, unavailable: [], suppressedGroups: 0,
      };
    }

    const days = Math.max(0, Math.round(Number(schoolDays) || 0));
    if (!days) {
      return {
        allowed: true, notYet: true,
        reason: "No school days counted yet, so no rate can be worked out. Check the start date.",
        rows: [], baseline: null, unavailable: [], suppressedGroups: 0,
      };
    }

    const restricted = await ctx.db.query("psRestricted").take(2000);
    if (!restricted.length) {
      return {
        allowed: true, notYet: true,
        reason:
          "Student group data has not been loaded. PowerSchool grants it and the query works; " +
          "the sync has not populated psRestricted.",
        rows: [], baseline: null, unavailable: [], suppressedGroups: 0,
      };
    }

    const att = await ctx.db.query("psAttendance").take(2000);
    const absentOf = new Map<string, number>();
    for (const a of att) {
      const n = String(a.studentNumber || "");
      const d = Number(a.daysAbsentYtd);
      if (n && Number.isFinite(d)) absentOf.set(n, d);
    }

    const cells = new Map<string, Cell>();
    const bump = (axis: string, group: string, absent: number | undefined) => {
      const key = axis + "|" + group;
      let c = cells.get(key);
      if (!c) { c = { axis, group, enrolled: 0, withAttendance: 0, chronic: 0, severe: 0 }; cells.set(key, c); }
      c.enrolled++;
      // ABSENCE IS NOT ZERO. A student with no attendance row has not been
      // measured, and counting them as present would dilute every rate on
      // this screen with children nobody has data for.
      if (absent === undefined) return;
      c.withAttendance++;
      const rate = absent / days;
      if (rate >= CHRONIC) c.chronic++;
      if (rate >= SEVERE) c.severe++;
    };

    let unknownEthnicity = 0, unclassified = 0;
    const unmappedCodes = new Set<string>();

    for (const r of restricted) {
      const absent = absentOf.get(String(r.studentNumber || ""));

      // The California rule, reused rather than restated: Hispanic ethnicity
      // wins and race codes are not reported separately for those students.
      // Ignoring it reported this predominantly Hispanic school as White.
      const rep = reportedCategories({ fedEthnicity: r.fedEthnicity, raceCodes: r.raceCodes });
      for (const code of rep.unmapped) unmappedCodes.add(code);
      if (rep.ethnicity === "unknown") unknownEthnicity++;
      if (!rep.categories.length) unclassified++;
      for (const cat of rep.categories) bump("race", cat, absent);

      const ela = String(r.elaStatus || "").trim().toUpperCase();
      // The grouping a school acts on first: currently an EL, or not.
      bump("el", ela === "EL" ? "Current English Learner" : "Not currently an English Learner", absent);
      // ...and the full four-way status, because RFEP is the interesting one.
      bump("ela", ELA_LABELS[ela] ?? (ela ? ela : "Not recorded"), absent);
    }

    // The baseline every row is read against.
    let allEnrolled = 0, allMeasured = 0, allChronic = 0, allSevere = 0;
    for (const r of restricted) {
      allEnrolled++;
      const absent = absentOf.get(String(r.studentNumber || ""));
      if (absent === undefined) continue;
      allMeasured++;
      const rate = absent / days;
      if (rate >= CHRONIC) allChronic++;
      if (rate >= SEVERE) allSevere++;
    }
    const baseline = {
      group: "Every student", enrolled: allEnrolled, withAttendance: allMeasured,
      chronic: allChronic, severe: allSevere,
      chronicPct: allMeasured ? round1((allChronic / allMeasured) * 100) : null,
      severePct: allMeasured ? round1((allSevere / allMeasured) * 100) : null,
    };

    const all = [...cells.values()];
    // THE SUPPRESSED ROWS NEVER BECOME ROWS. Only their number crosses.
    const kept = all.filter((c) => c.enrolled >= SMALL_GROUP);
    const suppressed = all.length - kept.length;

    const rows = kept.map((c) => {
      const pct = c.withAttendance ? round1((c.chronic / c.withAttendance) * 100) : null;
      return {
        axis: c.axis, group: c.group,
        enrolled: c.enrolled, withAttendance: c.withAttendance,
        chronic: c.chronic, severe: c.severe,
        chronicPct: pct,
        severePct: c.withAttendance ? round1((c.severe / c.withAttendance) * 100) : null,
        /** Points above or below the school's own rate. The only comparison worth making. */
        vsSchool: pct !== null && baseline.chronicPct !== null ? round1(pct - baseline.chronicPct) : null,
        /**
         * TOO FEW TO READ A DIFFERENCE INTO, even though the group is large
         * enough to report. Black or African American is 47 students: one
         * child moving changes the rate by two points, so a three-point gap
         * from the school average is not a finding. Reported so the screen can
         * say so rather than inviting the reader to over-read it.
         */
        fragile: c.withAttendance < FRAGILE_GROUP,
      };
    }).sort((a, b) => {
      if (a.axis !== b.axis) return a.axis.localeCompare(b.axis);
      if (a.axis === "race") {
        const ia = RACE_ORDER.indexOf(a.group), ib = RACE_ORDER.indexOf(b.group);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      }
      return b.enrolled - a.enrolled;
    });

    return {
      allowed: true,
      schoolDays: days,
      chronicAt: CHRONIC, severeAt: SEVERE,
      baseline,
      rows,
      suppressedGroups: suppressed,
      smallGroupFloor: SMALL_GROUP,
      fragileFloor: FRAGILE_GROUP,
      /** Students whose ethnicity question was never answered. A sync gap, not a fact. */
      unknownEthnicity,
      unclassified,
      unmappedRaceCodes: [...unmappedCodes],
      /** Groups the school asked for that this app cannot answer, and why. */
      unavailable: UNAVAILABLE_GROUPS,
      lastSyncedAt: restricted.reduce(
        (a: string | null, r) => (!a || String(r.syncedAt) > a ? String(r.syncedAt) : a), null),
    };
  },
});
