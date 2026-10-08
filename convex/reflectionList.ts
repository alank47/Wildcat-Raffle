import { internalQuery, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireStaff } from "./identity";
import { canAdminReflection, canReadReflection } from "./accessRules";
import {
  claimInputs, dayStateOf, getDay, loadSettings, MAPS_KEY, markedOf, readState, ROSTER_KEY, rosterFor, schoolTimeZone,
  tardyItemOf, uniformItemOf, unitItemOf,
} from "./reflection";
import {
  beforeLunchClass, claimAtFreeze, clockText, dayLabel, dayTimes, freezeBanner, idSetHash, lastReadBanner, nextSchoolDayGuess, noListBanner,
  provesNoSchool, pullTimes, QUEUED_TAG, roomWindow, rosterAgeBanner, scheduleKindFor, schoolDayVerdict, studentMap, tardyKey, tardyLine,
  termBanner, uniformLine, unitReleased, wallClock,
  type ClaimResult, type Division, type Mode, type ReflectionSettings, type RosterMeta, type RosterSnap, type ScheduleKind, type UnitItem,
} from "./reflectionRules";
import { countingDivision } from "./reflectionDemoRules";

/**
 * THE DAILY REFLECTION ROOM LIST, AS STAFF SEE IT AND PRINT IT (build spec
 * 4.7, step 7a).
 *
 * The only browser-reachable part of the list. reflection.ts makes the list
 * and is internal; this file reads it for the Discipline > Reflection Room
 * screen and records each print. EVERY PUBLIC FUNCTION HERE CHECKS WHO IS
 * ASKING FIRST, by a direct role test (accessRules.canReadReflection: admin,
 * superadmin, PBIS, or an unexpired per-person grant), before it reads a
 * single row.
 *
 * NO NAMES LEAVE THIS FILE. Rows carry student numbers and grades; the
 * screen adds names from the student records the browser already holds, as
 * Attendance Watch does. reflectionPrints keeps ids and student numbers only.
 * Nothing here writes appAuditLog, which every staff browser downloads.
 *
 * Detentions appear ONLY on this list -- not on Student History, Early
 * Warning, analytics or parent email (owner, 2026-10-08).
 */

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** On the day's list: listed, carried from it afterwards, or sent to review afterwards. Released is shown, but not to pull. */
const ON_LIST = new Set(["listed", "carried", "review"]);
/** A print records at most this many ids: about ten times the largest list measured (46). */
const PRINT_MAX = 600;

const REFUSED = "The Reflection Room list is limited to administrators, the PBIS team and staff an administrator has "
  + "given access to it.";

/**
 * What a tab that has not said it can mark a TEST list as TEST is told on a
 * day that has only a TEST list (listForDay, without `demoOk`). That is every
 * tab still running a screen from before the TEST list existed: it would
 * draw the rows as an ordinary pilot list, names and all, with no TEST
 * anywhere on screen or on paper. So it is sent no row at all. Nobody is
 * asked to do anything: the tab updates itself and then shows the TEST list,
 * marked TEST.
 */
export const DEMO_NEEDS_UPDATE = "This day has only a TEST list. It shows, marked TEST, once the Hub updates itself.";

/** Why a print of a TEST list is never recorded (recordPrint). */
export const DEMO_PRINT_REFUSED = "This is a TEST list, not a real one, so no print of it is recorded and no slips or "
  + "changes-only sheet are printed from it. Print on the Reflection Room screen prints the TEST copy, marked "
  + "\u201cTEST \u2014 not for assignment\u201d on every page.";

type Ctx = QueryCtx;

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/** Now, today, and the zone, in the school's time. No zone means no list day can be placed. */
export async function schoolNow(ctx: Ctx): Promise<{ tz: string | null; nowIso: string; today: string; minute: number | null }> {
  const tz = await schoolTimeZone(ctx);
  const nowIso = new Date().toISOString();
  const lt = tz ? wallClock(nowIso, tz) : null;
  return {
    tz, nowIso,
    today: lt && lt.ok ? lt.dateKey : nowIso.slice(0, 10),
    minute: lt && lt.ok ? lt.minuteOfDay : null,
  };
}

/** The school day after `date`: the next weekday not marked no school in Settings > Bell Schedule. */
export async function nextSchoolDay(ctx: Ctx, date: string): Promise<string> {
  const marks = await ctx.db.query("bellScheduleDays").withIndex("by_date", (q) => q.gt("date", date)).take(120);
  return nextSchoolDayGuess(date, marks.filter((m) => m.noSchool).map((m) => m.date));
}

// ===========================================================================
// One row of the list, as the screen draws it
// ===========================================================================

export type ListRowOut = {
  /** The detention's id, or "new:<studentNumber>" for one the next freeze would make. */
  key: string;
  unitId: string | null;
  studentNumber: string;
  grade: string;
  division: Division;
  mode: Mode;
  /** listed | carried | review | released (on a list already made), or so-far (a preview). */
  state: string;
  pu: { teacher: string | null; course: string | null; flag: string | null; check: boolean } | null;
  /** No row in the roster snapshot (a uniform entry for a student PowerSchool does not list now). */
  notOnRoster: boolean;
  /** Every violation, each with its date: "Mon 10/12: Tardy P5 (Ms Diaz)". */
  lines: string[];
  tags: string[];
  owes: number;
  /** Every class that met before the close, and that the student is enrolled in, has an absence. */
  absentMorning: boolean;
  /** Released after the list was made: every violation on it was cleared. */
  released: { at: string | null; reason: string } | null;
  /** Violations cleared after the list was made (the list record itself is never rewritten). */
  cleared: Array<{ line: string; reason: string; at: string | null }>;
  /** Uniform entries voided after the list was made. */
  voided: Array<{ line: string; at: string }>;
  /** What happened afterwards: "Carries to the next list (absent)". */
  after: string | null;
  /** The room ticked this student Not here (screen only, never printed). */
  notHere: boolean;
  /**
   * Who the pull slip goes to when the division's slips are addressed to the
   * class right before lunch (setting slipAddresseeByDivision); null means the
   * Power-Up teacher, the default.
   */
  slipTo: { teacher: string | null; label: string } | null;
};

function puOf(snap: RosterSnap | null | undefined, frozen?: Doc<"reflectionUnits">["puSnapshot"]): ListRowOut["pu"] {
  if (frozen) {
    return { teacher: frozen.teacherName ?? null, course: frozen.course ?? null, flag: frozen.flag ?? null, check: !!frozen.check };
  }
  if (!snap || (!snap.puTeacherName && !snap.puCourse)) return null;
  return { teacher: snap.puTeacherName, course: snap.puCourse, flag: snap.puFlag, check: snap.puCheck };
}

/** What a detention dismissed in admin review says on the list, to everyone: never the admin's reason. */
const DISMISSED_RELEASE = "Dismissed in admin review";

/**
 * The rows of a list already made (or given up), from its detentions.
 *
 * ADMIN REVIEW IS THE ROLES' ALONE (spec 4.6, B3; review, 2026-10-08). A
 * detention sent to review after its list was made shows why ("In admin
 * review: attendance unknown at Power-Up"), and once decided, the decision
 * and the reason the admin typed. Only `roles` (admin, superadmin, PBIS) get
 * those words. A grant holder -- and any sheet they print -- gets neutral
 * ones, never reviewReason or resolutionReason. A detention DISMISSED in
 * review is off the list, like a released one: not counted, not printed, no
 * Not here box, no slip, and "release this student" on every earlier print.
 */
async function rowsOfMadeList(ctx: Ctx, date: string, tz: string, gradeOf: Record<string, string>, frozenAt: string | null,
  roles: boolean, slips?: { settings: ReflectionSettings; rowCounts: Record<string, number> | null }): Promise<ListRowOut[]> {
  const units = await ctx.db.query("reflectionUnits").withIndex("by_serveDay", (q) => q.eq("serveDay", date)).collect();
  const roster = await rosterFor(ctx, units.map((u) => u.studentNumber));
  const out: ListRowOut[] = [];
  for (const u of units) {
    if (!ON_LIST.has(u.state) && u.state !== "released") continue;
    const tardies = (await Promise.all(u.tardyIds.map((id) => ctx.db.get(id)))).filter(Boolean) as Doc<"reflectionTardies">[];
    const uniforms = (await Promise.all(u.uniformIds.map((id) => ctx.db.get(id)))).filter(Boolean) as Doc<"uniformViolations">[];
    const cleared = tardies.filter((t) => t.state !== "countable").map((t) => ({
      line: tardyLine(tardyItemOf(t)), reason: t.reason ?? "no longer counted", at: t.clearedAt ?? t.lastSeenAt ?? null,
    }));
    const voided = uniforms.filter((x) => !!x.voidedAt && (!frozenAt || x.voidedAt! >= frozenAt))
      .map((x) => ({ line: uniformLine(uniformItemOf(x), tz), at: x.voidedAt! }));
    // Released by the reader, or (a uniform entry voided, which the reader
    // does not watch) every violation gone all the same: either way the
    // student is not to be pulled, and every earlier print says so.
    const allGone = unitReleased([
      ...tardies.map((t) => ({ cleared: t.state !== "countable" })),
      ...uniforms.map((x) => ({ cleared: !!x.voidedAt })),
    ]) && (tardies.length + uniforms.length === u.tardyIds.length + u.uniformIds.length);
    const dismissed = u.state === "review" && u.resolution === "dismissed";
    const released = u.state === "released"
      ? { at: u.releasedAt ?? null, reason: u.releaseReason ?? "every violation was cleared" }
      : dismissed ? { at: u.resolvedAt ?? null, reason: DISMISSED_RELEASE }
        : allGone ? { at: [...cleared.map((c) => c.at), ...voided.map((x) => x.at)].filter(Boolean).sort().pop() ?? null, reason: "every violation was cleared" }
          : null;
    let after: string | null = null;
    if (u.state === "carried" && u.carriedToUnitId) {
      const carry = await ctx.db.get(u.carriedToUnitId);
      // A pilot list's carry is the pilot's record only: it never reaches a
      // live list (reflection.decideCarries, setMode).
      if (carry) {
        after = carry.state === "before-start"
          ? `Not carried to a later list: it is from before the list started counting${carry.tags?.[0] ? ` (${carry.tags[0]})` : ""}`
          : carry.tags?.[0] ? `Carries to the next list: ${carry.tags[0]}` : "Carries to the next list";
      }
    } else if (u.state === "review") {
      after = !roles
        ? (u.resolvedAt ? "Decided by an administrator" : "Waiting for an administrator's decision")
        : u.resolvedAt
          ? `Review closed (${u.resolution ?? "decided"}): ${u.resolutionReason ?? u.reviewReason ?? ""}`.replace(/: $/, "")
          : `In admin review: ${u.reviewReason ?? "waiting for a decision"}`;
    }
    const snap = roster[u.studentNumber] ?? null;
    const lunch = slips && slips.settings.slipAddresseeByDivision[u.division] === "before-lunch"
      ? beforeLunchClass(snap, slips.rowCounts) : null;
    out.push({
      key: u._id, unitId: u._id, studentNumber: u.studentNumber,
      grade: snap?.grade || gradeOf[u.studentNumber] || uniforms[0]?.studentGrade || "",
      division: u.division, mode: u.mode,
      state: released ? "released" : u.state,
      pu: puOf(snap, u.puSnapshot), notOnRoster: !snap,
      lines: u.lines, tags: u.tags, owes: u.owes ?? 1, absentMorning: !!u.absentMorning,
      released, cleared, voided, after,
      notHere: !!u.roomNotHere,
      slipTo: lunch ? { teacher: lunch.teacher, label: lunch.label } : null,
    });
  }
  return out;
}

/** Rows of a list the next freeze would make, from a claim worked out read-only. */
function rowsOfClaim(claim: ClaimResult, roster: Record<string, RosterSnap>, gradeOf: Record<string, string>,
  uniformGrade: Record<string, string>): ListRowOut[] {
  return claim.rows.map((r) => {
    const snap = roster[r.studentNumber] ?? null;
    return {
      key: r.serve === "new" ? `new:${r.studentNumber}` : r.serve,
      unitId: r.serve === "new" ? null : r.serve,
      studentNumber: r.studentNumber,
      grade: snap?.grade || gradeOf[r.studentNumber] || uniformGrade[r.studentNumber] || "",
      division: r.division, mode: r.mode, state: "so-far",
      pu: puOf(snap), notOnRoster: !snap,
      lines: r.lines, tags: r.tags, owes: r.owes, absentMorning: false,
      released: null, cleared: [], voided: [], after: null, notHere: false, slipTo: null,
    };
  });
}

/**
 * WHAT THE NEXT FREEZES WOULD CLAIM, worked out read-only: the same reads as
 * the freeze (reflection.claimInputs) and the same rule (claimAtFreeze).
 *
 * `first` is today when today's list is still to be made: its claim is taken
 * out first, as the real freeze will take it, and a second detention it
 * would queue joins the next day's preview. So "Tomorrow so far" never shows
 * a student who is about to serve today for the same thing.
 */
async function soFar(ctx: Ctx, f: {
  first: string | null; target: string; tz: string; settings: Awaited<ReturnType<typeof loadSettings>>;
  gradeOf: Record<string, string>; nowIso: string;
}): Promise<{ rows: ListRowOut[]; roster: Record<string, RosterSnap> }> {
  const inp = await claimInputs(ctx, { upTo: f.target, gradeOf: f.gradeOf });
  const uniformGrade = Object.fromEntries(inp.uniforms.map((u) => [u.studentNumber, u.studentGrade]));
  let tardies = inp.tardies.map(tardyItemOf);
  let uniforms = inp.uniforms.map(uniformItemOf);
  let units: UnitItem[] = inp.pending.map(unitItemOf);
  if (f.first && f.first !== f.target) {
    const first = claimAtFreeze({
      day: f.first, tz: f.tz, settings: f.settings, divisionOf: inp.divisionOf, tardies, uniforms, units, days: inp.days,
    });
    const tGone = new Set(first.claimedTardyIds), uGone = new Set(first.claimedUniformIds);
    const served = new Set(first.rows.map((r) => r.serve));
    tardies = tardies.filter((t) => !tGone.has(t.id));
    uniforms = uniforms.filter((u) => !uGone.has(u.id));
    units = units.filter((u) => !served.has(u.id));
    for (const r of first.rows) {
      // New violations behind an older detention: the freeze makes them a
      // queued detention, waiting for the next list.
      if (r.newUnit && r.serve !== "new") {
        units.push({
          id: `queued:${r.studentNumber}`, studentNumber: r.studentNumber, division: r.division, kind: "queued", state: "pending",
          serveDay: null, recordedAt: f.nowIso, carryCount: 0, tags: [...r.newUnit.tags, QUEUED_TAG], lines: r.newUnit.lines,
        });
      }
    }
  }
  const claim = claimAtFreeze({
    day: f.target, tz: f.tz, settings: f.settings, divisionOf: inp.divisionOf, tardies, uniforms, units, days: inp.days,
  });
  const rows = rowsOfClaim(claim, inp.roster, f.gradeOf, uniformGrade)
    // A queued detention worked out above has no id yet.
    .map((r) => (r.unitId && r.unitId.startsWith("queued:") ? { ...r, key: `new:${r.studentNumber}`, unitId: null } : r));
  return { rows, roster: inp.roster };
}

// ===========================================================================
// What changed since a print (per print, per person)
// ===========================================================================

export type PrintChanges = {
  added: string[];
  release: Array<{ studentNumber: string; reason: string }>;
  cleared: Array<{ studentNumber: string; line: string; reason: string }>;
  voided: Array<{ studentNumber: string; line: string }>;
};

/**
 * WHAT A PRINT NO LONGER SAYS, worked out against ONE print -- each person's
 * own -- never only against the newest print of the day (review B6). A
 * supervisor who printed at 11:31 needs every change since 11:31, even if a
 * colleague printed at 11:50.
 *
 * By student number, so a print of the list "so far" (before the freeze, when
 * its detentions had no ids yet) is compared just as well: a student on the
 * list now and not on the paper is ADDED; one on the paper and not on the list
 * now (released, or never on the final list) is RELEASE THIS STUDENT; a
 * violation cleared, or a uniform entry voided, since the print is listed too.
 */
export function changesSince(print: { at: string; studentNumbers: string[] }, rows: ListRowOut[]): PrintChanges {
  const onNow = new Map(rows.filter((r) => r.state !== "released").map((r) => [r.studentNumber, r]));
  const byStudent = new Map(rows.map((r) => [r.studentNumber, r]));
  const printed = new Set(print.studentNumbers);
  const out: PrintChanges = { added: [], release: [], cleared: [], voided: [] };
  for (const sn of onNow.keys()) if (!printed.has(sn)) out.added.push(sn);
  for (const sn of printed) {
    if (onNow.has(sn)) continue;
    const r = byStudent.get(sn);
    out.release.push({ studentNumber: sn, reason: r?.released?.reason ?? "Not on the list now" });
  }
  for (const r of onNow.values()) {
    if (!printed.has(r.studentNumber)) continue;
    for (const c of r.cleared) if (c.at && c.at > print.at) out.cleared.push({ studentNumber: r.studentNumber, line: c.line, reason: c.reason });
    for (const x of r.voided) if (x.at > print.at) out.voided.push({ studentNumber: r.studentNumber, line: x.line });
  }
  return out;
}

const changeCount = (c: PrintChanges) => c.added.length + c.release.length + c.cleared.length + c.voided.length;

function changeWords(c: PrintChanges): string {
  const parts: string[] = [];
  if (c.added.length) parts.push(`+${c.added.length} added`);
  if (c.release.length) parts.push(`release ${c.release.length}`);
  if (c.cleared.length) parts.push(`${c.cleared.length} violation${c.cleared.length === 1 ? "" : "s"} cleared`);
  if (c.voided.length) parts.push(`${c.voided.length} uniform entr${c.voided.length === 1 ? "y" : "ies"} voided`);
  return parts.join(", ");
}

// ===========================================================================
// The admin review queue: its data (the resolve screen is build step 7b)
// ===========================================================================

export type ReviewItem = {
  kind: "tardy" | "detention" | "day";
  id: string;
  studentNumber: string | null;
  date: string;
  reason: string;
  ageSchoolDays: number;
  /** The violations it is about, each with its date. */
  lines: string[];
  /** What the resolve screen may do with it: "add" (to the next list) and/or "dismiss" (with a reason). */
  actions: Array<"add" | "dismiss">;
};

/**
 * Everything waiting for an admin, PBIS or superadmin decision (spec 3.9):
 * very late entries and natural-key collisions (tardies in review),
 * detentions whose carry could not be decided or hit the limit (units in
 * review), and days whose room attendance was not recorded in live mode.
 * Each with its age in SCHOOL days, because the control is "nothing older
 * than 2 school days".
 */
export async function reviewItems(ctx: Ctx, today: string, tz: string | null): Promise<ReviewItem[]> {
  const items: Omit<ReviewItem, "ageSchoolDays">[] = [];
  const tardies = await ctx.db.query("reflectionTardies").withIndex("by_state_attDate", (q) => q.eq("state", "review")).collect();
  for (const t of tardies) {
    if (t.resolvedAt) continue;
    items.push({
      kind: "tardy", id: t._id, studentNumber: t.studentNumber, date: t.attDate, reason: t.reason ?? "Review",
      lines: [tardyLine(tardyItemOf(t))], actions: ["add", "dismiss"],
    });
  }
  const units = await ctx.db.query("reflectionUnits").withIndex("by_state", (q) => q.eq("state", "review")).collect();
  for (const u of units) {
    if (u.resolvedAt) continue;
    const lt = tz ? wallClock(u.recordedAt, tz) : null;
    const date = u.serveDay ?? (lt && lt.ok ? lt.dateKey : u.recordedAt.slice(0, 10));
    items.push({
      kind: "detention", id: u._id, studentNumber: u.studentNumber, date, reason: u.reviewReason ?? "Review",
      lines: u.lines, actions: ["add", "dismiss"],
    });
  }
  const from = addDays(today, -60);
  const days = await ctx.db.query("reflectionDays").withIndex("by_date", (q) => q.gte("date", from).lte("date", today)).collect();
  for (const d of days) {
    if (d.fallbackReview && !d.fallbackReview.resolvedAt) {
      items.push({ kind: "day", id: d._id, studentNumber: null, date: d.date, reason: d.fallbackReview.reason, lines: [], actions: ["dismiss"] });
    }
  }
  const schoolDays = days.filter((d) => d.schoolDay === true).map((d) => d.date);
  return items
    .map((it) => ({ ...it, ageSchoolDays: schoolDays.filter((d) => d > it.date && d <= today).length }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

// ===========================================================================
// listForDay: the screen's one read
// ===========================================================================

type Banner = { id: string; level: "alert" | "warn" | "info"; text: string };

function modeWords(m: Record<Division, Mode>): string {
  return `ms:${m.ms} hs:${m.hs}`;
}

const hhmm = (m: number) => `${Math.floor(m / 60) % 12 || 12}:${String(m % 60).padStart(2, "0")}`;

/** Power-Up teacher, then student number: the order every list starts in (the screen may re-sort it). */
function sortRows(rows: ListRowOut[]): void {
  rows.sort((a, b) => (a.pu?.teacher ?? "\uffff").localeCompare(b.pu?.teacher ?? "\uffff") || a.studentNumber.localeCompare(b.studentNumber));
}

/** A fingerprint of what the list says now: a print records it, and a later read tells it apart. */
function versionOf(rows: ListRowOut[]): string {
  return idSetHash(rows.map((r) => [
    r.key, r.state, r.lines.join(";"), r.tags.join(";"), r.cleared.length, r.voided.length, r.after ?? "",
  ].join("|")));
}

/**
 * The sections: MS first (pulled at the block start), then HS, each with its
 * count against the room's capacity for that sitting and its pull time.
 */
function sectionsOf(rows: ListRowOut[], modes: Record<Division, Mode>, settings: ReflectionSettings,
  pull: { msMinute: number; hsMinute: number }) {
  const capacity = settings.capacity;
  return (["ms", "hs"] as Division[]).map((division) => {
    const mine = rows.filter((r) => r.division === division);
    const count = mine.filter((r) => r.state !== "released").length;
    const pullMinute = division === "ms" ? pull.msMinute : pull.hsMinute;
    return {
      division,
      label: division === "ms" ? "Middle school (grades 6-8)" : "High school (grades 9-12)",
      mode: modes[division],
      pullAt: hhmm(pullMinute),
      count,
      capacity: capacity[division],
      // More students than the room holds at this division's sitting: shown,
      // never decided here (an over-capacity rule is the owner's, later).
      overCapacity: capacity[division] !== null && count > (capacity[division] as number),
      slipTo: settings.slipAddresseeByDivision[division],
      rows: mine,
    };
  });
}

/**
 * THE TEST LIST FOR A DAY, if one was built (reflectionDemo.ts, owner
 * 2026-10-08). THE ONLY READ OF reflectionDemoLists outside the file that
 * writes it, and it is called from two places only: listForDay, which shows
 * it on a day with no real list, and recordPrint, which refuses to record a
 * print of it. Nothing that makes, carries, reviews, verifies or reports on
 * the real list reads it.
 *
 * NONE ON A DAY THE REAL LIST COUNTS, even one built before the switch was
 * moved to count it (setMode allows counting from today): the real "so far"
 * list is shown and printed as ever, rather than hidden behind the TEST one
 * until the real list is made.
 */
async function demoListOf(ctx: Ctx, day: string, settings: ReflectionSettings): Promise<Doc<"reflectionDemoLists"> | null> {
  if (countingDivision(settings, day)) return null;
  return ctx.db.query("reflectionDemoLists").withIndex("by_day", (q) => q.eq("day", day)).first();
}

/**
 * THE TEST LIST, AS listForDay ANSWERS WITH IT: the rows as built (the shape
 * of a list already made), MS then HS, and `demo: true` with the time it was
 * built, which the screen turns into its red TEST ONLY banner and every
 * printed page into "TEST — not for assignment". Nothing else of the real
 * list rides along: no PILOT or NOT FINAL banner, no room attendance, no
 * prints, no review count, no buttons -- nobody acts on a TEST list.
 */
function demoAnswer(f: {
  demo: Doc<"reflectionDemoLists">; date: string; today: string; next: string; nowIso: string; roles: boolean;
  settings: ReflectionSettings;
}) {
  const rows: ListRowOut[] = f.demo.rows.map((r) => ({ ...r, pu: r.pu ? { ...r.pu } : null }));
  sortRows(rows);
  const modes: Record<Division, Mode> = { ms: "shadow", hs: "shadow" };
  const kind: ScheduleKind = f.demo.kind ?? "regular";
  return {
    allowed: true as const,
    ok: true as const,
    roles: f.roles,
    date: f.date,
    dayLabel: dayLabel(f.date),
    isToday: f.date === f.today,
    isNext: f.date === f.next && f.date !== f.today,
    today: f.today,
    asOf: f.nowIso,
    view: "demo" as const,
    frozen: false,
    frozenAt: null,
    freezeKind: null,
    noList: null,
    lastGoodReadAt: null,
    kind,
    times: null,
    mode: modes,
    sections: sectionsOf(rows, modes, f.settings, pullTimes(kind, f.settings)),
    listVersion: versionOf(rows),
    banners: [] as Banner[],
    review: null,
    myPrintChanges: null,
    printsToday: null,
    grants: null,
    room: null,
    controls: null,
    demo: true as const,
    demoBuiltAt: f.demo.builtAt,
  };
}

/**
 * THE LIST FOR ONE DAY, for Discipline > Reflection Room.
 *
 * `day`: "today", "next" (the next school day: "Tomorrow so far"), or a
 * past date. Today before its list is made, and the next day, are "so far":
 * exactly what the next freeze would claim if it ran now -- never final,
 * and every printed page says so.
 *
 * Returns the MS and HS sections (MS first: MS serves in the first half of
 * Lunch & Power-Up, so it is pulled first), the day's facts, every banner,
 * the viewer's own changes since their own last print of this day, and for
 * the roles each print of the day with its change counts (staff emails
 * only). Student numbers and grades only: names are the browser's.
 *
 * A TEST LIST (reflectionDemo.ts) is answered for a day ONLY when that day
 * has no real list made and the real list does not count it, and only after
 * the same check of who is asking: real data always wins. And only to a
 * screen that says it marks it as TEST (`demoOk`); any other is told so in
 * words, with no row (DEMO_NEEDS_UPDATE).
 */
export const listForDay = query({
  args: {
    day: v.string(),
    // Sent by the screen from 2026-10-08 on, which says TEST ONLY over a TEST
    // list and on every page of it. A screen from before never sends it.
    demoOk: v.optional(v.boolean()),
  },
  handler: async (ctx, { day, demoOk }) => {
    const staff = await requireStaff(ctx);
    const { tz, nowIso, today } = await schoolNow(ctx);
    // THE CHECK COMES FIRST: nothing below is read for someone refused.
    if (!canReadReflection(staff, today)) return { allowed: false as const, reason: REFUSED };
    if (!tz) {
      return { allowed: true as const, ok: false as const, reason: "No school time zone is set in Settings > Bell Schedule, so no list day can be placed." };
    }
    const roles = canAdminReflection(staff);
    const settings = await loadSettings(ctx);
    const next = await nextSchoolDay(ctx, today);
    let date: string;
    if (day === "today") date = today;
    else if (day === "next") date = next;
    else if (DAY_KEY.test(day) && day <= today) date = day;
    else if (DAY_KEY.test(day) && day === next) date = next;
    else return { allowed: true as const, ok: false as const, reason: "Only today, the next school day and past days can be shown." };

    const maps = await readState(ctx, MAPS_KEY);
    const gradeOf = studentMap(maps?.students).gradeOf;
    const row = await getDay(ctx, date);
    if (!row?.frozenAt) {
      const demo = await demoListOf(ctx, date, settings);
      if (demo && demoOk !== true) return { allowed: true as const, ok: false as const, reason: DEMO_NEEDS_UPDATE };
      if (demo) return demoAnswer({ demo, date, today, next, nowIso, roles, settings });
    }
    const marked = await markedOf(ctx, date);
    const st = dayStateOf(date, row, marked);
    const kind = (row?.kind as ScheduleKind | undefined)
      ?? scheduleKindFor({ date, marked, scheduleKinds: settings.scheduleKinds, rowCounts: row?.rowCounts ?? null }).kind;
    const times = dayTimes(date, kind, settings, tz);
    const pull = pullTimes(kind, settings);

    // Is today's list still to be made? Not if made, given up, not a school
    // day, or past the latest time a list may be made.
    const todayRow = date === today ? row : await getDay(ctx, today);
    const todayMarked = date === today ? marked : await markedOf(ctx, today);
    const todaySt = dayStateOf(today, todayRow, todayMarked);
    const todaySd = schoolDayVerdict({
      date: today, marked: todayMarked, rowCounts: todayRow?.rowCounts ?? null,
      adminMarked: !!todayRow?.adminMarkedSchoolDay, readSucceeded: provesNoSchool(todaySt, tz),
    });
    const todayKind = (todayRow?.kind as ScheduleKind | undefined)
      ?? scheduleKindFor({ date: today, marked: todayMarked, scheduleKinds: settings.scheduleKinds, rowCounts: todayRow?.rowCounts ?? null }).kind;
    const todayTimes = dayTimes(today, todayKind, settings, tz);
    const pastLatest = todayTimes.ok && Date.parse(nowIso) >= todayTimes.lastFreezeMs;
    const todayOpen = !todayRow?.frozenAt && !todayRow?.noList && todaySd.verdict !== "no" && !pastLatest;

    let rows: ListRowOut[] = [];
    let view: "made" | "so-far" | "no-list" | "no-school" | "not-made";
    if (row?.frozenAt) {
      view = "made";
      rows = await rowsOfMadeList(ctx, date, tz, gradeOf, row.frozenAt, roles, { settings, rowCounts: row.rowCounts ?? null });
    } else if (date === today && todayOpen) {
      view = "so-far";
      rows = (await soFar(ctx, { first: null, target: today, tz, settings, gradeOf, nowIso })).rows;
    } else if (date === next && date !== today) {
      view = "so-far";
      rows = (await soFar(ctx, { first: todayOpen ? today : null, target: next, tz, settings, gradeOf, nowIso })).rows;
    } else if (row?.noList || (date === today && pastLatest && todaySd.verdict !== "no")) {
      view = "no-list";
    } else if (date === today && todaySd.verdict === "no") {
      view = "no-school";
    } else {
      view = "not-made";
      // A past day the reader never made a list for may still hold a released
      // or carried detention (never), so this is simply empty.
    }
    const frozen = view === "made";
    const modes: Record<Division, Mode> = frozen && row?.modeByDivision ? row.modeByDivision : settings.modeByDivision;
    sortRows(rows);
    const listVersion = versionOf(rows);

    // ---- The sections: MS first (pulled at the block start), then HS.
    const sections = sectionsOf(rows, modes, settings, pull);

    // ---- The room's own attendance for this day (build step 8b): Not here
    // and Attendance done from Lunch & Power-Up start until the next list is
    // made; Room did not run (roles) from this list's freeze until then.
    // Only a LIVE division's detentions are the room's: a division in shadow
    // is decided by PowerSchool (reflection.decideCarries), so its rows get
    // no Not here box, and a list with no live division has no room bar.
    let room: Record<string, any> | null = null;
    if (frozen && (modes.ms === "live" || modes.hs === "live")) {
      const later = await ctx.db.query("reflectionDays").withIndex("by_date", (q) => q.gt("date", date)).collect();
      const nextMade = later.filter((d) => d.frozenAt).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
      const w = roomWindow({
        nowIso, listMadeAt: row?.frozenAt ?? null, powerUpMs: times.ok ? times.powerUpMs : null,
        nextListMadeAt: nextMade?.frozenAt ?? null, tz,
      });
      room = {
        tick: w.tick, closeRoom: w.closeRoom && roles, why: w.why,
        doneAt: row?.roomAttendanceDoneAt ?? null, doneBy: row?.roomAttendanceDoneBy ?? null,
        closed: row?.roomClosed ?? null,
        notHere: rows.filter((r) => r.notHere && r.state !== "released" && r.mode === "live").length,
      };
    }

    // ---- The roles' buttons for today: "Read PowerSchool now" and "This is a
    // school day". Never for a grant holder; the server checks again.
    let controls: Record<string, any> | null = null;
    if (roles && date === today) {
      const switchedOn = settings.modeByDivision.ms !== "off" || settings.modeByDivision.hs !== "off";
      const noSchool = todaySd.basis === "no-school" || todaySd.basis === "weekend";
      controls = {
        readNow: switchedOn && !noSchool,
        markSchoolDay: switchedOn && !noSchool && todaySd.verdict !== "yes",
        schoolDayMarked: !!todayRow?.adminMarkedSchoolDay,
      };
    }

    // ---- Changes since a print: the viewer's own newest print of this day.
    const mine = await ctx.db.query("reflectionPrints").withIndex("by_day_email", (q) => q.eq("day", date).eq("printedByEmail", staff.email)).order("desc").first();
    let myPrintChanges: Record<string, any> | null = null;
    if (mine) {
      const c = changesSince(mine, rows);
      const beforeFreeze = frozen && !!row?.frozenAt && mine.at < row.frozenAt;
      myPrintChanges = {
        printAt: mine.at, kind: mine.kind, final: mine.final, ...c,
        count: changeCount(c), outOfDate: changeCount(c) > 0 || beforeFreeze,
      };
    }
    let printsToday: Array<Record<string, any>> | null = null;
    if (roles) {
      const prints = await ctx.db.query("reflectionPrints").withIndex("by_day", (q) => q.eq("day", date)).collect();
      // OUT OF DATE IS SAID THE SAME WAY HERE AS TO THE PERSON WHO PRINTED
      // (review, 2026-10-08): a print taken before the list was made is out
      // of date even when the final list holds the same students, because
      // that paper says NOT FINAL -- the printer's own banner tells them to
      // print again, and the PBIS lead must not read "still current" here.
      printsToday = prints.map((p) => {
        const c = changesSince(p, rows);
        const beforeFreeze = frozen && !!row?.frozenAt && p.at < row.frozenAt;
        return {
          by: p.printedByEmail, at: p.at, kind: p.kind, final: p.final, students: p.studentNumbers.length,
          changes: { added: c.added.length, release: c.release.length, cleared: c.cleared.length, voided: c.voided.length },
          beforeFreeze, outOfDate: changeCount(c) > 0 || beforeFreeze,
        };
      });
    }

    // ---- Banners. Role-only ones (review, holds, PowerSchool oddities) are
    // added only for the roles: a grant holder prints and ticks, nothing more.
    const banners: Banner[] = [];
    const clock = (iso: string | null | undefined) => (iso ? clockText(iso, tz) : "");
    for (const d of ["ms", "hs"] as Division[]) {
      if (modes[d] === "shadow") {
        banners.push({ id: `pilot-${d}`, level: "warn", text: `PILOT (${d.toUpperCase()}): do not assign. This list is a trial run; nobody is pulled from it.` });
      }
    }
    if (modes.ms === "off" && modes.hs === "off") {
      banners.push({ id: "off", level: "info", text: "The Reflection Room list is switched off for both divisions." });
    }
    if (view === "no-list") {
      const text = noListBanner(st, await nextSchoolDay(ctx, date), tz);
      // The same words, about the day shown: a past day is not "today".
      banners.push({
        id: "no-list", level: "alert",
        text: date === today ? text : text.replace(/^No list today/, `No list on ${dayLabel(date)}`).replace("Today's violations", "That day's violations"),
      });
    }
    if (view === "no-school") {
      banners.push({ id: "no-school", level: "info", text: `No school today (${todaySd.reason}) Today's violations go on ${dayLabel(next)}'s list.` });
    }
    if (view === "not-made") {
      banners.push({ id: "not-made", level: "info", text: `No list was made for ${dayLabel(date)}.` });
    }
    const fb = frozen ? freezeBanner(st, tz) : null;
    if (fb) banners.push({ id: "made-how", level: "warn", text: fb });
    if (view === "so-far") {
      banners.push({
        id: "not-final", level: "warn",
        text: date === today
          ? `NOT FINAL: do not pull from this. The list is made at ${times.ok ? clock(times.close) : "the close"} `
            + `and is ready by ${times.ok ? clock(times.ready) : "the ready time"}.`
          : `NOT FINAL: ${dayLabel(date)} so far. Violations recorded before its list is made still join it.`,
      });
    }
    if (date === today && todaySd.verdict !== "no" && times.ok) {
      // Red only when a scheduled read is overdue or the latest one failed
      // (reflectionRules.lastReadBanner), never merely for the gap between
      // two reads on a healthy day.
      const lr = lastReadBanner({
        nowIso, tz, date, closeMinute: times.closeMinute,
        lastGoodReadAt: row?.lastGoodReadAt ?? null, lastReadErrorAt: row?.lastReadErrorAt ?? null,
      });
      if (lr) banners.push({ id: "last-read", level: lr.level, text: lr.text });
    }
    if (myPrintChanges?.outOfDate) {
      const at = clock(myPrintChanges.printAt);
      const words = changeWords(myPrintChanges as PrintChanges);
      banners.push({
        id: "print-out-of-date", level: "alert",
        text: frozen && row?.frozenAt && myPrintChanges.printAt < row.frozenAt
          ? `The final list was made at ${clock(row.frozenAt)}. Your ${at} print is out of date${words ? ` (${words})` : ""}: print the list again.`
          : `Since your ${at} print: ${words}.`,
      });
    }
    if (date === today && row?.sixPeriodDetected) {
      banners.push({ id: "six-period", level: "warn", text: "Today looks like a six-period day. Mark it Stack or Minimum in Settings > Bell Schedule." });
    }
    const meta: RosterMeta | null = await readState(ctx, ROSTER_KEY);
    for (const [id, text] of [
      ["roster-age", rosterAgeBanner(meta, today)],
      ["term", termBanner({ today, termEnd: meta?.termEnd, termName: meta?.termName, snapshotTermId: meta?.termId, currentTermId: process.env.PS_TERM_ID ?? null })],
    ] as Array<[string, string | null]>) {
      if (text) banners.push({ id, level: "warn", text });
    }
    // ---- "Who can see this list" (roles only): every per-person grant, with
    // when it was given, by whom, and its last day. Staff names only.
    let grants: Array<Record<string, any>> | null = null;
    if (roles) {
      const staffRows = await ctx.db.query("teachers").collect();
      grants = staffRows.filter((t: any) => t.reflectionList === true).map((t: any) => ({
        name: t.name || t.email, email: t.email, setAt: t.reflectionListSetAt ?? null, setBy: t.reflectionListSetBy ?? null,
        until: t.reflectionListUntil ?? null, current: canReadReflection(t, today),
      })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }

    let review: { count: number; oldest: string | null } | null = null;
    if (roles) {
      const items = await reviewItems(ctx, today, tz);
      review = { count: items.length, oldest: items[0]?.date ?? null };
      if (items.length) {
        banners.push({ id: "review", level: items.some((i) => i.ageSchoolDays > 2) ? "alert" : "warn",
          text: `${items.length} waiting in review, oldest ${dayLabel(items[0].date)}.` });
      }
      if (date === today && !frozen && (row?.ptBlankSections ?? 0) > 0) {
        banners.push({ id: "pt-blank", level: "info", text: `Promise Time AM attendance not in yet for ${row!.ptBlankSections} section${row!.ptBlankSections === 1 ? "" : "s"}.` });
      }
      // ROOM ATTENDANCE NOT RECORDED on the last list (build step 8b): the
      // room ran without ticking Not here, so its carries were left to
      // PowerSchool. Until someone acknowledges it in the review queue.
      if (date === today) {
        const before = await ctx.db.query("reflectionDays").withIndex("by_date", (q) => q.lt("date", today)).order("desc").take(10);
        const lastList = before.find((d) => d.frozenAt);
        if (lastList?.fallbackReview && !lastList.fallbackReview.resolvedAt) {
          banners.push({ id: "room-not-recorded", level: "warn", text: `${lastList.fallbackReview.reason}. Tick Not here and press Attendance done each day.` });
        }
      }
      if (date === today && (row?.heldCount ?? 0) > 0) {
        banners.push({ id: "held", level: "info", text: `${row!.heldCount} tard${row!.heldCount === 1 ? "y is" : "ies are"} held until the class's attendance is in.` });
      }
      const n = (x: number | undefined) => x ?? 0;
      if (n(row?.unmappedRows) > 0) banners.push({ id: "unmapped", level: "warn", text: `${row!.unmappedRows} PowerSchool mark${row!.unmappedRows === 1 ? "" : "s"} had a period the list does not know.` });
      if (n(row?.collisions) > 0) banners.push({ id: "collisions", level: "warn", text: `${row!.collisions} period${row!.collisions === 1 ? " has" : "s have"} 2 marks in PowerSchool for one student (in review).` });
      if (n(row?.unmatchedMarks) > 0) banners.push({ id: "unmatched", level: "warn", text: `${row!.unmatchedMarks} PowerSchool mark${row!.unmatchedMarks === 1 ? "" : "s"} could not be matched to a student.` });
      if (n(row?.unplacedStudents) > 0) banners.push({ id: "unplaced", level: "warn", text: `${row!.unplacedStudents} student${row!.unplacedStudents === 1 ? "" : "s"} could not be placed in middle or high school.` });
    }

    return {
      allowed: true as const,
      ok: true as const,
      roles,
      date,
      dayLabel: dayLabel(date),
      isToday: date === today,
      isNext: date === next && date !== today,
      today,
      asOf: nowIso,
      view,
      frozen,
      frozenAt: row?.frozenAt ?? null,
      freezeKind: row?.freezeKind ?? null,
      noList: row?.noList ?? null,
      lastGoodReadAt: row?.lastGoodReadAt ?? null,
      kind,
      times: times.ok ? { close: clock(times.close), ready: clock(times.ready), lastFreeze: clock(times.lastFreeze), powerUp: clock(times.powerUp) } : null,
      mode: modes,
      sections,
      listVersion,
      banners,
      review,
      myPrintChanges,
      printsToday,
      grants,
      room,
      controls,
      demo: false as const,
      demoBuiltAt: null,
    };
  },
});

// ===========================================================================
// recordPrint: each print, ids and numbers only
// ===========================================================================

/**
 * A PRINT IS RECORDED BEFORE THE SHEET IS DRAWN, so "what changed since your
 * print" has something to compare with. IDS AND STUDENT NUMBERS ONLY: never a
 * name, so this table is not a second copy of the list.
 *
 * Final or not is the SERVER's call (the day's list is made, or it is not),
 * never the browser's. Slips (a later step) are refused until the list is
 * final: a slip sends a runner to a classroom, and a list still moving must
 * not send anyone.
 *
 * A TEST LIST IS NEVER A RECORD (owner, 2026-10-08). A day showing one (no
 * real list made, the real list not counting it, and a TEST list built for
 * it) records no print of any kind: the screen prints its TEST copy without
 * one, and slips and "Print changes only" are off for it.
 */
export const recordPrint = mutation({
  args: {
    day: v.string(),
    kind: v.union(v.literal("master"), v.literal("slips"), v.literal("changes")),
    unitIds: v.array(v.id("reflectionUnits")),
    studentNumbers: v.array(v.string()),
    listVersion: v.string(),
  },
  handler: async (ctx, a) => {
    const staff = await requireStaff(ctx);
    const { nowIso, today } = await schoolNow(ctx);
    if (!canReadReflection(staff, today)) return { ok: false as const, reason: REFUSED };
    if (!DAY_KEY.test(a.day)) return { ok: false as const, reason: `Not a day: "${a.day}".` };
    if (a.unitIds.length > PRINT_MAX || a.studentNumbers.length > PRINT_MAX) {
      return { ok: false as const, reason: `A print records at most ${PRINT_MAX} students.` };
    }
    if (!a.studentNumbers.every((sn) => /^[0-9A-Za-z-]{1,20}$/.test(sn)) || a.listVersion.length > 40) {
      return { ok: false as const, reason: "A print records student numbers and the list's version only." };
    }
    const row = await getDay(ctx, a.day);
    const final = !!row?.frozenAt;
    const settings = await loadSettings(ctx);
    if (!final && await demoListOf(ctx, a.day, settings)) return { ok: false as const, reason: DEMO_PRINT_REFUSED };
    if (a.kind === "slips" && !final) {
      return { ok: false as const, reason: "Slips print only once the list is final. Print the master list, which is marked NOT FINAL." };
    }
    const modes = final && row?.modeByDivision ? row.modeByDivision : settings.modeByDivision;
    const id = await ctx.db.insert("reflectionPrints", {
      day: a.day, kind: a.kind, final, printedByEmail: staff.email, at: nowIso, mode: modeWords(modes),
      unitIds: [...new Set(a.unitIds)] as Id<"reflectionUnits">[], studentNumbers: [...new Set(a.studentNumbers)], listVersion: a.listVersion,
    });
    return { ok: true as const, id, final, at: nowIso };
  },
});

// ===========================================================================
// Command line only (internal): the review queue, the audit trail, the export
// ===========================================================================

/**
 * The admin review queue, oldest first, each with its age in school days:
 *   npx convex run --prod reflectionList:adminReview '{}'
 * The resolve screen is build step 7b; until then the queue is read here and
 * its size is on the screen as the review banner (roles only).
 */
export const adminReview = internalQuery({
  args: {},
  handler: async (ctx) => {
    const { tz, today } = await schoolNow(ctx);
    const items = await reviewItems(ctx, today, tz);
    return { today, count: items.length, oldest: items[0]?.date ?? null, items };
  },
});

/**
 * Every human act on the list (reflectionAudit), newest first:
 *   npx convex run --prod reflectionList:auditTrail '{"day":"2026-10-13"}'
 * Staff emails, actions and reasons. Never in appAuditLog.
 */
export const auditTrail = internalQuery({
  args: { day: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { day, limit }) => {
    const n = Math.max(1, Math.min(500, Math.floor(limit ?? 100)));
    const rows = day
      ? await ctx.db.query("reflectionAudit").withIndex("by_day", (q) => q.eq("day", day)).order("desc").take(n)
      : await ctx.db.query("reflectionAudit").withIndex("by_at").order("desc").take(n);
    return rows.map((r) => ({ at: r.at, by: r.byEmail, action: r.action, day: r.day ?? null, reason: r.reason ?? null }));
  },
});

/**
 * FOR scripts/reflection-verify.mjs ONLY, never a browser: what the system
 * holds for list day D and the dates its list could have drawn on (D and the
 * 40 days before it), as keys and states. The verify script reads this
 * through `npx convex run` into its own memory and prints counts only.
 */
export const verifyExport = internalQuery({
  args: { day: v.string() },
  handler: async (ctx, { day }) => {
    if (!DAY_KEY.test(day)) throw new Error(`Not a day: "${day}".`);
    const settings = await loadSettings(ctx);
    const row = await getDay(ctx, day);
    const marked = await markedOf(ctx, day);
    const from = addDays(day, -40);
    const units = await ctx.db.query("reflectionUnits").withIndex("by_serveDay", (q) => q.eq("serveDay", day)).collect();
    const tardies = await ctx.db.query("reflectionTardies").withIndex("by_attDate", (q) => q.gte("attDate", from).lte("attDate", day)).collect();
    const unitDay = new Map<string, { serveDay: string | null; state: string }>();
    for (const u of units) unitDay.set(u._id, { serveDay: u.serveDay ?? null, state: u.state });
    for (const t of tardies) {
      if (t.unitId && !unitDay.has(t.unitId)) {
        const u = await ctx.db.get(t.unitId);
        unitDay.set(t.unitId, { serveDay: u?.serveDay ?? null, state: u?.state ?? "missing" });
      }
    }
    const listDays = await ctx.db.query("reflectionDays").withIndex("by_date", (q) => q.gte("date", from).lte("date", day)).collect();
    const uniformsOnList: Array<Record<string, any>> = [];
    for (const u of units) {
      for (const id of u.uniformIds) {
        const x = await ctx.db.get(id);
        if (x) uniformsOnList.push({ id: x._id, unitId: u._id, day: x.day, voidedAt: x.voidedAt ?? null });
      }
    }
    return {
      day,
      settings: {
        modeByDivision: settings.modeByDivision, countFromDateByDivision: settings.countFromDateByDivision,
        lateEntryLists: settings.lateEntryLists, countDitching: settings.countDitching,
      },
      marked: marked ?? null,
      dayRow: row ? {
        schoolDay: row.schoolDay ?? null, schoolDayBasis: row.schoolDayBasis ?? null, kind: row.kind ?? null,
        closeInstant: row.closeInstant ?? null, readyInstant: row.readyInstant ?? null, lastFreezeInstant: row.lastFreezeInstant ?? null,
        frozenAt: row.frozenAt ?? null, freezeKind: row.freezeKind ?? null, closingReadStartedAt: row.closingReadStartedAt ?? null,
        noList: row.noList ?? null, modeByDivision: row.modeByDivision ?? null,
        roomAttendanceDone: !!row.roomAttendanceDoneAt, roomClosed: !!row.roomClosed,
      } : null,
      days: listDays.map((d) => ({ date: d.date, schoolDay: d.schoolDay ?? null, frozenAt: d.frozenAt ?? null })),
      list: units.map((u) => ({
        unitId: u._id, studentNumber: u.studentNumber, division: u.division, kind: u.kind, state: u.state, mode: u.mode,
        carryBasis: u.carryBasis ?? null, carryCount: u.carryCount, tardyIds: u.tardyIds, uniformIds: u.uniformIds,
      })),
      tardies: tardies.map((t) => ({
        id: t._id, key: tardyKey(t.studentNumber, t.attDate, t.periodId), studentNumber: t.studentNumber, attDate: t.attDate,
        periodId: t.periodId, slot: t.slot, code: t.code, division: t.division ?? null, state: t.state,
        reason: t.reason ?? null, firstSeenAt: t.firstSeenAt, firstCountableAt: t.firstCountableAt ?? null, wasHeld: !!t.wasHeld,
        listsBeforeSeen: t.listsBeforeSeen, unitId: t.unitId ?? null,
        unitServeDay: t.unitId ? unitDay.get(t.unitId)?.serveDay ?? null : null,
        unitState: t.unitId ? unitDay.get(t.unitId)?.state ?? null : null,
      })),
      uniformsOnList,
    };
  },
});
