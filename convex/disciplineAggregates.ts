import { query, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireStaff, requireAdmin } from "./identity";
import { reportedCategories, classifyEthnicity, HISPANIC_LABEL } from "./raceRollup";
import type { RestrictedRow } from "./raceRollup";
import { SCHOOL_TZ } from "./referralMailRules";

/**
 * Discipline breakdowns by protected characteristic. COUNTS ONLY, NEVER ROWS.
 *
 * WHY THIS EXISTS RATHER THAN WIDENING ALLOWED_BY_ROLE.
 *
 * "PBIS can see counts by race" and "PBIS can see a child's race" are
 * different permissions, and only the first was asked for. The app owner was
 * explicit on 2026-08-19: "I am not looking to see an individual child's race,
 * I just want data to show what races are being hit with referrals."
 *
 * So restrictedPolicy.ts stays empty for PBIS, studentDetail still cannot
 * return raceCodes to them, and this function serves the aggregate separately.
 * It reads psRestricted, joins it in memory to the referrals the SERVER stores
 * (legacyMirror; never a list a browser sends, since 2026-10-07), and returns
 * tallies. There is no argument that could make it return a student to PBIS,
 * because for PBIS it never builds one -- and no argument at all now decides
 * which students are counted.
 *
 * SUPPRESSION HAPPENS HERE, NOT IN THE BROWSER.
 *
 * The UI already withholds small cells, but that is cosmetic: anyone can read
 * the network response. For "aggregate only" to be a property rather than a
 * claim, a cell small enough to identify a child must never leave the server.
 *
 * THE CATEGORIES COME FROM raceRollup, NOT FROM raceCodes ALONE.
 *
 * An earlier revision of this file mapped race codes directly and ignored
 * fedEthnicity. In California that reports a predominantly Hispanic school as
 * White, because Hispanic students still answer the race question and very
 * commonly answer it 700. See raceRollup.ts for the rule and the bug.
 */

/**
 * Below this many ENROLLED students, a rate is noise and may identify. For
 * PBIS the same ten also applies to REFERRED students in a cell, and to the
 * steps the PBIS snapshot moves in (see pbisSnapshot and suppressSmallCells).
 */
const SMALL_GROUP = 10;

/**
 * Minimum REFERRALS in a group before a disproportionality index is computed.
 *
 * A DIFFERENT RULE FROM SMALL_GROUP, GUARDING A DIFFERENT AXIS.
 *
 * SMALL_GROUP withholds a whole row when few students are ENROLLED, because a
 * cell that small can identify a child. That is privacy. This is statistics:
 * it withholds only the ratio when a group has few REFERRALS, because a ratio
 * built on one or two incidents is noise reported to two decimal places.
 *
 * WHY IT HAD TO EXIST. With six referrals in the system and one going to a
 * group that is 7% of the school, this returned 2.38. With zero it returns
 * 0.00. There is no value in between, so the group cannot score near 1.0 no
 * matter what is true. The index was reporting the resolution limit of the
 * data as a finding about children, and "referred at 2.4x their share" is
 * exactly the sentence that leaves a slide without its caveat attached.
 *
 * 10 matches the enrolment threshold and the usual floor in federal IDEA
 * disproportionality work. California uses 30 for its own determinations, so
 * this is the permissive end of defensible rather than the strict end.
 *
 * COUNTS AND SHARES ARE STILL RETURNED. Those are facts. Only the ratio, which
 * is an inference, is withheld.
 */
const MIN_REFERRALS_FOR_INDEX = 10;

/** Roles that may see discipline aggregates by protected characteristic. */
const AGGREGATE_ROLES = ["admin", "superadmin", "pbis"];

/**
 * How many stored referrals one breakdown reads. A school year holds a few
 * hundred at most (18 in its first month); this is a ceiling, not a page.
 */
const REFERRAL_READ_CAP = 5000;

/**
 * THE REFERRALS THE SERVER HOLDS, not a list a browser sends (2026-10-07).
 *
 * This query used to take its referred students from the caller, because
 * referrals were in Firestore and race was in Convex and only the browser
 * held both. Referrals have been in legacyMirror since 2026-08-31, and a list
 * from the browser was the hole: PBIS could send [one child, 'x1'..'x9'], pass
 * the ten-student guard with nine numbers that belong to nobody, and read that
 * one child's race off the single row with a count of 1. Unkeyed rows only,
 * the same slice loadDoc serves.
 */
async function readStoredReferrals(ctx: Pick<QueryCtx, "db">) {
  const rows = await ctx.db.query("legacyMirror")
    .withIndex("by_doc_collection", (q) => q.eq("doc", "referrals").eq("collection", "behaviorReferrals"))
    .take(REFERRAL_READ_CAP);
  return rows.filter((r) => typeof r.key !== "string");
}

/** A real calendar date written YYYY-MM-DD, or null. */
export function isoDay(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? raw : null;
}

/** The Los Angeles calendar day an instant falls on, or null. */
export function laDay(raw: unknown): string | null {
  const ms = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHOOL_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ms));
}

/**
 * The day the incident happened: the date the teacher entered on the form,
 * else the Los Angeles day it was filed. NOT submittedAt first: a fight on
 * Friday filed on Monday belongs to Friday's week.
 */
export function incidentDay(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return isoDay(p.date) ?? laDay(p.submittedAt);
}

/** A window start as a Los Angeles day: a bare date as written, an instant converted. */
export function sinceDay(sinceIso: unknown): string | null {
  return isoDay(sinceIso) ?? laDay(sinceIso);
}

/**
 * The student number a referral is counted under, EXACTLY as the browser
 * picked it (script.js referralStudentNumber): the number snapshotted at
 * filing, as a string, or nothing. The browser also looked a missing number
 * up on its roster; the server does not, and counts those referrals instead
 * (withoutNumber, in compareByRace). Production has none.
 */
export function referralNumber(payload: unknown): string {
  const n = payload && typeof payload === "object" ? (payload as Record<string, unknown>).studentNumber : "";
  return n ? String(n) : "";
}

/** The referred student numbers, one per referral, in an optional incident-day window. */
export function numbersSince(referrals: Array<{ payload: unknown }>, sinceIso?: unknown) {
  const from = sinceIso === undefined || sinceIso === null || sinceIso === "" ? null : sinceDay(sinceIso);
  const numbers: string[] = [];
  let withoutNumber = 0, outsideWindow = 0;
  for (const r of referrals) {
    if (from !== null) {
      const day = incidentDay(r.payload);
      // An incident with no readable day cannot be shown to be in the window.
      if (day === null || day < from) { outsideWindow++; continue; }
    }
    const n = referralNumber(r.payload);
    if (!n) { withoutNumber++; continue; }
    numbers.push(n);
  }
  return { numbers, withoutNumber, outsideWindow, windowFrom: from };
}

/**
 * PBIS SEES A FROZEN PICTURE THAT MOVES TEN STUDENTS AT A TIME (2026-10-07).
 *
 * PBIS reads every referral by name. If the race breakdown moved with every
 * filing, then the moment a referral for one named child appeared, the cell
 * that changed would be that child's race. So PBIS is shown only the referrals
 * the server stored up to a snapshot instant: the server-set _creationTime of
 * the referral that last brought the count of distinct referred students to a
 * multiple of ten. The picture advances only when ten more students have been
 * referred, and which ten is not something one filing reveals.
 *
 * _creationTime, NEVER payload.date or submittedAt: those come from the
 * caller, and PBIS can file referrals. A referral backdated into the past is
 * still created now, so it waits for the next snapshot like any other.
 *
 * Deterministic and read-only: the same rows give the same snapshot, and
 * nothing is written to compute it. Null until ten students have referrals.
 *
 * WHAT THIS DOES NOT HIDE (review, 2026-10-07; an owner decision, not fixed
 * here). PBIS knows which students each step added, and the counts are exact,
 * so comparing two pictures shows the make-up of the step: a step in which
 * all ten students fall in one group says that group for each of them. Any
 * exact, deterministic picture has this property, and choosing the step by
 * its make-up would leak through WHEN it moves instead. Closing it means
 * coarser figures (rounded counts or bands, or term reports) or keyed noise,
 * each of which changes what PBIS sees; that choice belongs to the owner.
 *
 * NOR A WITHDRAWAL (review, 2026-10-07; also the owner's to decide). Only the
 * referrals are frozen. Race comes from psRestricted, which every sync
 * replaces with the students enrolled that day, so when a referred child
 * leaves, their referrals stop matching a race record: one cell drops by one
 * and `unmatched` rises by one, and PBIS, who can see who left, learns that
 * child's group. The enrolment figures move the same way for any child who
 * joins or leaves. Today every PBIS cell is withheld (the snapshot holds ten
 * students), so it shows nothing yet; it starts to once a cell is shown.
 * Closing it means keeping a withdrawn child's race (a retained copy of the
 * race fields, or the categories stamped on the referral row when it is
 * stored) and freezing or dropping the enrolment figures for PBIS -- a
 * decision to hold a protected field after the SIS has let it go, which the
 * full-replace sync was built not to do (sisStats.ts replaceRestricted).
 */
export function pbisSnapshot<T extends { payload: unknown; _creationTime: number }>(referrals: T[]) {
  const ordered = referrals.slice().sort((a, b) => a._creationTime - b._creationTime);
  const seen = new Set<string>();
  let instant: number | null = null;
  let students = 0;
  for (const r of ordered) {
    const n = referralNumber(r.payload);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (seen.size % SMALL_GROUP === 0) { instant = r._creationTime; students = seen.size; }
  }
  if (instant === null) return null;
  const at = instant;
  return { rows: ordered.filter((r) => r._creationTime <= at), students };
}

/**
 * THE REFERRALS PBIS'S PICTURE IS BUILT FROM: every stored referral except
 * the ones PBIS filed (review, 2026-10-07).
 *
 * PBIS may file referrals, and nothing guards a closer's insert. So PBIS
 * could file one for a chosen child and nine for made-up numbers: ten new
 * "students" move the snapshot, nine match nobody, and the one cell that
 * moves is that child's race -- the same attack the browser-sent list
 * allowed, by another door. legacyData:mergeSlice records the inserting
 * account's role on the row, outside the payload where no browser can reach
 * it, and PBIS's ladder and table leave PBIS-filed rows out. Admins still see
 * them. (Which child a stored referral is about cannot be changed afterwards
 * either: referralAccessRules.ts SUBJECT_FIELDS.)
 *
 * The cost: a referral a PBIS member files is in the admins' breakdown and
 * not in PBIS's. Rows stored before the role was recorded carry none and are
 * counted, as they always were.
 *
 * NOT "only numbers on the roster". Filtering by today's roster would let a
 * withdrawal shift the snapshot by one student, and the step between two
 * pictures would then be a single named child.
 */
export function pbisCountable<T extends { insertedByRole?: string }>(referrals: T[]): T[] {
  return referrals.filter((r) => String(r.insertedByRole ?? "").trim().toLowerCase() !== "pbis");
}

type RosterRow = { studentNumber: string };
type RestrictedRecord = RestrictedRow & { studentNumber: string };

/**
 * The breakdown itself, over whatever student list it is given. Pure. This is
 * the body byRace always ran, moved out unchanged so the server-derived list
 * and the old browser list can be run through the SAME code and compared.
 */
export function raceTable(restricted: RestrictedRecord[], roster: RosterRow[], studentNumbers: string[]) {
  // studentNumber -> the reporting categories for that student.
  //
  // Hispanic or Latino collapses to a single category (ethnicity wins).
  // A non-Hispanic student with codes in two categories counts under BOTH
  // and is never collapsed into "Two or more races": that is a reporting
  // decision this school has not made, and it hides exactly the students it
  // claims to describe.
  const catsByNumber = new Map<string, string[]>();
  const unmappedCodes = new Set<string>();
  let unknownEthnicity = 0;
  for (const r of restricted) {
    const rep = reportedCategories(r);
    for (const c of rep.unmapped) unmappedCodes.add(c);
    // Counted, not corrected. A pile of unknowns is a sync gap, and saying
    // so is the difference between a broken feed and a finding about kids.
    if (rep.ethnicity === "unknown") unknownEthnicity += 1;
    if (rep.categories.length) catsByNumber.set(r.studentNumber, rep.categories);
  }

  // Enrolment denominator, from the current roster.
  const enrolledNumbers = new Set(roster.map((r) => r.studentNumber));
  const enrolledBy: Record<string, number> = {};
  for (const num of enrolledNumbers) {
    for (const code of catsByNumber.get(num) ?? []) {
      enrolledBy[code] = (enrolledBy[code] ?? 0) + 1;
    }
  }

  const referralsBy: Record<string, number> = {};
  let counted = 0;
  let unmatched = 0;
  for (const num of studentNumbers) {
    const codes = catsByNumber.get(String(num ?? ""));
    if (!codes || !codes.length) { unmatched += 1; continue; }
    counted += 1;
    for (const code of codes) referralsBy[code] = (referralsBy[code] ?? 0) + 1;
  }

  let enrolTotal = 0;
  for (const k of Object.keys(enrolledBy)) enrolTotal += enrolledBy[k];

  let withheld = 0;
  const rows = Object.keys({ ...enrolledBy, ...referralsBy }).map((code) => {
    const enrolled = enrolledBy[code] ?? 0;
    const count = referralsBy[code] ?? 0;
    const suppressed = enrolled > 0 && enrolled < SMALL_GROUP;
    if (suppressed) withheld += 1;
    const tooFewReferrals = count < MIN_REFERRALS_FOR_INDEX;

    const shareOfReferrals = counted ? count / counted : 0;
    const shareOfEnrollment = enrolTotal ? enrolled / enrolTotal : 0;

    return {
      code,
      // A suppressed group reports NOTHING that could locate a child: not
      // the count, not the enrolment, not the rate. Only that it exists and
      // is withheld, so the totals still reconcile.
      count: suppressed ? null : count,
      enrolled: suppressed ? null : enrolled,
      shareOfReferrals: suppressed ? null : shareOfReferrals,
      shareOfEnrollment: suppressed ? null : shareOfEnrollment,
      index:
        suppressed || tooFewReferrals || !shareOfEnrollment
          ? null
          : shareOfReferrals / shareOfEnrollment,
      suppressed,
      // Distinct from `suppressed` because the two say different things to a
      // reader: one is "we will not show you this", the other is "there is
      // not enough here yet to say anything". A suppressed row reports false
      // rather than leaking a second fact about how small it is.
      tooFewReferrals: suppressed ? false : tooFewReferrals,
    };
  }).sort((a, b) => (b.count ?? -1) - (a.count ?? -1));

  return {
    rows, counted, unmatched, withheld, unknownEthnicity,
    unmappedCodes: [...unmappedCodes],
    unmappedStudents: restricted.filter((r) => reportedCategories(r).unmapped.length > 0).length,
    catsByNumber,
  };
}

type RaceRow = ReturnType<typeof raceTable>["rows"][number];

/**
 * PBIS CELLS: FEWER THAN TEN REFERRED STUDENTS, AND ZERO, LOOK THE SAME.
 *
 * Suppressing on enrolment alone (above) leaves a cell of one referred child
 * readable, and PBIS knows who was referred. So for PBIS a category with
 * fewer than SMALL_GROUP distinct referred students is withheld -- INCLUDING
 * zero, or a 0 next to a withheld cell says the withheld one is not empty.
 *
 * COMPLEMENTARY SUPPRESSION. Withholding one cell is not enough when the
 * total is shown: it is then the total minus everything else. So while only
 * one cell is withheld, or the withheld cells together hold fewer than
 * SMALL_GROUP students, the next-smallest shown cell is withheld too. Every
 * withheld row looks identical (countSuppressed: true) and they are listed
 * after the shown ones in name order, so neither the label nor the position
 * says which was small.
 *
 * Admins are not put through this: they are approved for individual race
 * (2026-08-19) and keep the enrolment rule exactly as before.
 */
export function suppressSmallCells(rows: RaceRow[], studentsBy: Map<string, Set<string>>) {
  const size = (code: string) => studentsBy.get(code)?.size ?? 0;
  const withheld = new Set(rows.filter((r) => r.suppressed || size(r.code) < SMALL_GROUP).map((r) => r.code));
  const studentsIn = () => {
    const all = new Set<string>();
    for (const code of withheld) for (const n of studentsBy.get(code) ?? []) all.add(n);
    return all.size;
  };
  while (withheld.size > 0) {
    const shown = rows.filter((r) => !withheld.has(r.code));
    if (!shown.length) break;
    if (withheld.size >= 2 && studentsIn() >= SMALL_GROUP) break;
    shown.sort((a, b) => size(a.code) - size(b.code) || (a.count ?? 0) - (b.count ?? 0) || a.code.localeCompare(b.code));
    withheld.add(shown[0].code);
  }
  const shownRows = rows.filter((r) => !withheld.has(r.code)).map((r) => ({ ...r, countSuppressed: false }));
  const hiddenRows = rows.filter((r) => withheld.has(r.code))
    .map((r) => ({
      code: r.code, count: null, enrolled: null, shareOfReferrals: null, shareOfEnrollment: null,
      index: null, suppressed: true, tooFewReferrals: false, countSuppressed: true,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
  return { rows: [...shownRows, ...hiddenRows], withheld: hiddenRows.length };
}

export const byRace = query({
  args: {
    /**
     * IGNORED, AND STILL ACCEPTED (2026-10-07). Tabs already open send the
     * student numbers they hold, as every build before this one did; Convex
     * rejects a call carrying an argument the validator does not list, so
     * removing this would break the Demographics panel in every one of them.
     * The breakdown is built from the referrals the server stores (see
     * readStoredReferrals), whatever a caller sends here.
     */
    studentNumbers: v.optional(v.array(v.string())),
    // Optional window, so a review can ask about a term rather than all
    // time. Honoured for admins, by the day of the incident; PBIS always
    // sees the whole year (see pbisSnapshot).
    sinceIso: v.optional(v.string()),
  },
  handler: async (ctx, { sinceIso }) => {
    const staff = await requireStaff(ctx);
    if (!AGGREGATE_ROLES.includes(staff.role)) {
      // Named plainly. A PBIS member who has not been given the role should
      // be told that, not left wondering whether the data is missing.
      return {
        allowed: false,
        reason:
          "Discipline breakdowns by race are limited to administrators and the PBIS team. " +
          "Ask an administrator to set your access level to PBIS Team.",
        rows: [],
      };
    }

    const referrals = await readStoredReferrals(ctx);
    const isPbis = staff.role === "pbis";

    // THE INFERENCE GUARD, on the SERVER's referrals now. For PBIS the
    // breakdown is the frozen snapshot, which does not exist until ten
    // students have been referred. Admins may see individual race anyway
    // (approved 2026-08-19), so they get the referrals in their window as is.
    let studentNumbers: string[];
    let snapshotStudents = 0;
    if (isPbis) {
      const snap = pbisSnapshot(pbisCountable(referrals));
      if (!snap) {
        return {
          allowed: true,
          loaded: true,
          tooFew: true,
          windowApplied: false,
          reason:
            `A breakdown over fewer than ${SMALL_GROUP} students can identify them. ` +
            `This appears once at least ${SMALL_GROUP} students have referrals.`,
          rows: [],
        };
      }
      studentNumbers = numbersSince(snap.rows).numbers;
      snapshotStudents = snap.students;
    } else {
      studentNumbers = numbersSince(referrals, sinceIso).numbers;
    }

    const restricted = await ctx.db.query("psRestricted").collect();
    if (!restricted.length) {
      return {
        allowed: true,
        loaded: false,
        reason:
          "Race data has not been loaded yet. PowerSchool grants it and the query works; " +
          "the sync has not populated psRestricted.",
        rows: [],
      };
    }
    const roster = await ctx.db.query("psRoster").collect();
    const table = raceTable(restricted, roster, studentNumbers);
    const { counted, unmatched, unknownEthnicity, unmappedCodes, unmappedStudents } = table;
    let { rows, withheld } = table;
    if (isPbis) {
      const studentsBy = new Map<string, Set<string>>();
      for (const num of new Set(studentNumbers)) {
        for (const code of table.catsByNumber.get(num) ?? []) {
          if (!studentsBy.has(code)) studentsBy.set(code, new Set());
          studentsBy.get(code)!.add(num);
        }
      }
      ({ rows, withheld } = suppressSmallCells(rows, studentsBy));
    }

    return {
      allowed: true,
      loaded: true,
      rows,
      counted,
      // Referrals whose student has no race record. Reported so a small
      // denominator is visible rather than quietly shrinking every rate.
      unmatched,
      groupsWithheld: withheld,
      // Students whose ethnicity question never synced. Surfaced because they
      // fall through to race, which is exactly the path that produced the
      // wrong chart, and a reader should be able to see how many.
      unknownEthnicity,
      unmappedCodes,
      unmappedStudents,
      smallGroupThreshold: SMALL_GROUP,
      minReferralsForIndex: MIN_REFERRALS_FOR_INDEX,
      hispanicLabel: HISPANIC_LABEL,
      viewedAs: { role: staff.role },
      // PBIS only: always the whole year, as of the snapshot.
      ...(isPbis ? { windowApplied: false, snapshotStudents } : {}),
    };
  },
});

/**
 * THE SERVER'S LIST AGAINST THE BROWSER'S, ON PRODUCTION ROWS. CLI only,
 * counts and booleans only:
 *
 *   npx convex run --prod --codegen disable --typecheck disable disciplineAggregates:compareByRace
 *
 * The browser's list is rebuilt the way script.js built it: each referral's
 * own studentNumber, else that student's number on the roster. An admin's
 * breakdown is unchanged by this release exactly when listsIdentical is true
 * (resultsIdentical then follows, and is reported as the proof). The PBIS
 * block says how much of the year the snapshot covers and how many cells it
 * withholds, so the owner can see what PBIS will see before anyone opens it.
 */
export const compareByRace = internalQuery({
  args: {},
  handler: async (ctx) => {
    const referrals = await readStoredReferrals(ctx);
    const server = numbersSince(referrals);

    const browser: string[] = [];
    let resolvedByLookup = 0, unresolved = 0;
    for (const r of referrals) {
      const own = referralNumber(r.payload);
      if (own) { browser.push(own); continue; }
      const sid = (r.payload as Record<string, unknown> | null)?.studentId;
      const s = sid === undefined || sid === null || sid === "" ? null
        : await ctx.db.query("students").withIndex("by_legacyId", (q) => q.eq("legacyId", String(sid))).first();
      if (s && s.studentNumber) { browser.push(String(s.studentNumber)); resolvedByLookup++; }
      else unresolved++;
    }

    const countable = pbisCountable(referrals);
    const snap = pbisSnapshot(countable);
    const restricted = await ctx.db.query("psRestricted").collect();
    const base = {
      referrals: referrals.length,
      withoutNumber: server.withoutNumber,
      resolvedByLookup,
      unresolved,
      listsIdentical: JSON.stringify(server.numbers) === JSON.stringify(browser),
      pbisRowsFiledByPbis: referrals.length - countable.length,
      pbisSnapshotStudents: snap ? snap.students : 0,
      pbisRowsInSnapshot: snap ? snap.rows.length : 0,
      pbisRowsAfterSnapshot: snap ? countable.length - snap.rows.length : countable.length,
    };
    if (!restricted.length) return { ...base, loaded: false };

    const roster = await ctx.db.query("psRoster").collect();
    const strip = (t: ReturnType<typeof raceTable>) => JSON.stringify({ ...t, catsByNumber: undefined });
    const fromServer = raceTable(restricted, roster, server.numbers);
    const fromBrowser = raceTable(restricted, roster, browser);
    let pbisCellsShown = 0, pbisCellsWithheld = 0;
    if (snap) {
      const nums = numbersSince(snap.rows).numbers;
      const t = raceTable(restricted, roster, nums);
      const studentsBy = new Map<string, Set<string>>();
      for (const num of new Set(nums)) {
        for (const code of t.catsByNumber.get(num) ?? []) {
          if (!studentsBy.has(code)) studentsBy.set(code, new Set());
          studentsBy.get(code)!.add(num);
        }
      }
      const out = suppressSmallCells(t.rows, studentsBy);
      pbisCellsWithheld = out.withheld;
      pbisCellsShown = out.rows.length - out.withheld;
    }
    return {
      ...base,
      loaded: true,
      resultsIdentical: strip(fromServer) === strip(fromBrowser),
      categories: fromServer.rows.length,
      pbisCellsShown,
      pbisCellsWithheld,
    };
  },
});

/**
 * ADMIN ONLY. The per-student rows behind the chart, so the numbers can be
 * checked rather than trusted.
 *
 * WHY THIS IS ALLOWED TO RETURN A CHILD'S RACE, WHEN NOTHING ELSE IS.
 *
 * The app owner asked for it on 2026-08-20, for one stated reason: an
 * aggregate nobody can audit is not trustworthy, and the first version of the
 * chart WAS wrong. They spotted it because they know the school ("I am fairly
 * certain that my school has no white students") and had no way to confirm.
 * Verification is the reason this exists, and it is the only reason.
 *
 * requireAdmin, NOT requireStaff with a role list. PBIS was given counts and
 * only counts, and this is precisely the permission they were not given, so
 * the check is the strict one and cannot drift by editing an array.
 *
 * It returns what the SIS holds AND what the rollup decided, side by side,
 * because "is this number right" cannot be answered by the number alone. The
 * `basis` field says which question drove the answer, which is what makes a
 * surprising row explainable instead of just surprising.
 */
export const raceVerification = query({
  args: { studentNumbers: v.array(v.string()) },
  handler: async (ctx, { studentNumbers }) => {
    const staff = await requireAdmin(ctx);

    const wanted = new Set(studentNumbers.filter(Boolean).map(String));
    if (!wanted.size) return { allowed: true, rows: [], viewedAs: { role: staff.role } };

    const restricted = await ctx.db.query("psRestricted").collect();
    const byNumber = new Map(restricted.map((r) => [r.studentNumber, r]));

    // Names, so an admin can check a row against a student they know. One
    // roster row per section, so collapse to the first for each student.
    const roster = await ctx.db.query("psRoster").collect();
    const nameByNumber = new Map<string, { firstName: string; lastName: string; gradeLevel?: string }>();
    for (const r of roster) {
      if (!nameByNumber.has(r.studentNumber)) {
        nameByNumber.set(r.studentNumber, {
          firstName: r.firstName, lastName: r.lastName, gradeLevel: r.gradeLevel,
        });
      }
    }

    const rows = [...wanted].map((num) => {
      const rec = byNumber.get(num);
      const name = nameByNumber.get(num);
      // A student with no restricted record is RETURNED, not dropped. Missing
      // rows are the usual reason a chart's total is lower than the referral
      // count, and hiding them makes that impossible to find.
      const rep = rec ? reportedCategories(rec) : null;
      return {
        studentNumber: num,
        firstName: name?.firstName ?? "",
        lastName: name?.lastName ?? "",
        gradeLevel: name?.gradeLevel ?? "",
        onRoster: !!name,
        hasRecord: !!rec,
        ethnicity: rec ? classifyEthnicity(rec.fedEthnicity) : "unknown",
        fedEthnicityRaw: rec?.fedEthnicity ?? "",
        raceCodes: rec?.raceCodes ?? [],
        raceLabels: rep?.raceLabels ?? [],
        reported: rep?.categories ?? [],
        basis: rep?.basis ?? "none",
        unmapped: rep?.unmapped ?? [],
      };
    }).sort((a, b) => (a.lastName || "~").localeCompare(b.lastName || "~"));

    return { allowed: true, rows, viewedAs: { role: staff.role } };
  },
});
