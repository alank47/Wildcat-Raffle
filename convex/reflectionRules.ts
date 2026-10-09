/**
 * THE DAILY REFLECTION ROOM LIST: EVERY RULE THAT DECIDES WHO IS ON IT.
 *
 * PURE, AND ITS OWN FILE. Each decision here puts a named child in a lunch
 * detention, or keeps one off, so all of them are testable with no database,
 * no PowerSchool and no clock in the way. The reader, the tick and the screen
 * (reflection.ts, reflectionRead.ts) only gather facts and call these.
 * Nothing in this file reads the time: every instant arrives as an argument.
 *
 * ONE IMPORT, ON PURPOSE. The Los Angeles wall clock comes from
 * scheduleRules.localSchoolTime, the same conversion hall passes use, so the
 * list and the hall-pass clock can never disagree about what time it is at
 * school. A second copy of that conversion would be a second thing to get
 * wrong at the clock change. The tests load both files together.
 *
 * WHERE THE RULES CAME FROM. The owner's decisions of 2026-10-07 and the
 * owner's answers of 2026-10-08 (the build spec, revision 2). The answers of
 * 10/8 overrode one default: students whose Power-Up-time class is RSP,
 * Designated ELD or course 7002A are PULLED LIKE EVERYONE ELSE. They are not
 * set aside to "serve another way"; their row is flagged with the class and
 * teacher they are actually in at that time, so the runner finds the right
 * room. Several violations picked up by one list are ONE detention, one row,
 * every violation date shown. A student at school who does not come to the
 * room carries over exactly like an absent one.
 *
 * Measured numbers quoted below come from read-only, counts-only probes of
 * PowerSchool this school year, up to 2026-10-07.
 */

import { localSchoolTime } from "./scheduleRules";

// ===========================================================================
// Names and constants
// ===========================================================================

export type Division = "ms" | "hs";
export type Mode = "off" | "shadow" | "live";
export type ScheduleKind = "regular" | "wed" | "minimum" | "stack";
export const SCHEDULE_KINDS: ScheduleKind[] = ["regular", "wed", "minimum", "stack"];

/**
 * PowerSchool's period id minus this is the slot (1..10). Measured on every
 * T row this year: 851..860 map one to one onto the section expression's
 * leading slot. The PERIOD table is not granted (HTTP 403), so this offset is
 * measured, not documented; a row outside it is counted and shown in a
 * banner, never silently dropped.
 */
export const PERIOD_ID_BASE = 850;

/**
 * The order of a school day. Promise Time AM (1), periods 1-4 (slots 2-5),
 * Lunch & Power-Up (8 for HS, 9 for MS), periods 5-6 (slots 6-7), Promise
 * Time PM (10). Slots 2-5 come before Lunch & Power-Up on all five seeded
 * schedules and slots 6-7 after it, so the order needs no weekday logic.
 */
export const SLOT_ORDER: number[] = [1, 2, 3, 4, 5, 8, 9, 6, 7, 10];
/** Class periods 1-6. Only a tardy to one of these is ever listed by default. */
export const CLASS_SLOTS: number[] = [2, 3, 4, 5, 6, 7];
export const POWER_UP_SLOTS: number[] = [8, 9];
/** HS takes Power-Up in slot 8 and MS in slot 9; measured, every student has exactly one row there. */
export const POWER_UP_SLOT: Record<Division, number> = { hs: 8, ms: 9 };

/**
 * A slot "met" on a date when PowerSchool holds at least this many rows of
 * any code in it. Future-dated rows (3 students per date, spread across every
 * slot) cannot reach it; the smallest slot that really met this year held 13.
 */
export const MET_MIN_ROWS = 10;

/** School-day evidence from PowerSchool: slot 1 alone carries about 150 rows a day. */
export const EVIDENCE_SLOT1_ROWS = 20;
export const EVIDENCE_TOTAL_ROWS = 60;
export const EVIDENCE_MIN_SLOTS = 2;
/**
 * A read that shows NO evidence proves "no school today" only if it started
 * at or after 10:30 LA. Promise Time AM attendance is taken from 08:30, so
 * the 07:30 opening read sees nothing on every school day; treating that as
 * "no school" would skip the morning reads every day, and would leave a day
 * on which PowerSchool then went down with no "No list today" banner.
 */
export const EVIDENCE_EXPECTED_MINUTE = 630;

/**
 * THE LEASE. One reader at a time. A read stops reading at 3 minutes and its
 * lease lapses at 4, so a read killed by a deploy blocks the next tick for at
 * most 4 minutes and never for the rest of the day.
 */
export const LEASE_MS = 4 * 60 * 1000;
export const READ_STOP_MS = 3 * 60 * 1000;
/**
 * No fixed read starts in the 5 minutes before the close. With a 4-minute
 * lease, that leaves the lease free, with a minute to spare, for the closing
 * read that starts at the close.
 */
export const PRE_CLOSE_QUIET_MS = 5 * 60 * 1000;
/** A tick that finds the lease held books itself again this much later, at most this many times. */
export const TICK_RETRY_MS = 30 * 1000;
export const MAX_TICK_RETRIES = 8;

/** Direct `id==` reads that may confirm a removal, per read. The rest wait for the next read. */
export const DIRECT_CHECK_CAP = 50;

/**
 * THE OWNER'S TIMES (2026-10-07), minutes after local midnight.
 *
 * Ready by: 12:00 on regular and Stack days, 11:30 on Wednesdays and Minimum
 * days. Lunch & Power-Up starts at 12:31, 11:42, 11:42 and 12:22
 * (seedBellSchedules.ts). The ready time is the owner's, not a setting; the
 * close minute is a setting. The latest a list may ever be made is
 * lastFreezeMarginMin before Lunch & Power-Up, so no list is ever made after
 * students could already be in it.
 */
export const READY_MINUTE: Record<ScheduleKind, number> = { regular: 720, wed: 690, minimum: 690, stack: 720 };
export const POWER_UP_MINUTE: Record<ScheduleKind, number> = { regular: 751, wed: 702, minimum: 702, stack: 742 };
export const DEFAULT_CLOSE_MINUTE: Record<ScheduleKind, number> = { regular: 705, wed: 680, minimum: 680, stack: 710 };
/** Lunch & Power-Up ends (seedBellSchedules.ts): 13:34, 12:45, 12:45, 13:25. The block is 63 minutes. */
export const BLOCK_END_MINUTE: Record<ScheduleKind, number> = { regular: 814, wed: 765, minimum: 765, stack: 805 };

/**
 * THE ROOM RUNS DURING LUNCH (owner, 2026-10-08). MS eats first, so MS
 * serves in the FIRST half of Lunch & Power-Up; HS serves in the SECOND half
 * and is pulled out of Power-Up `hsPullLeadMinutes` (5) before the swap. The
 * swap is a per-schedule setting that defaults to the block's midpoint (the
 * owner confirmed halfway): 13:02 / 12:13 / 12:13 / 12:53, so HS is pulled at
 * 12:57 / 12:08 / 12:08 / 12:48.
 *
 * MS IS PULLED A COUPLE OF MINUTES BEFORE LUNCH BEGINS, FROM THE CLASS THEY
 * ARE IN (owner, 2026-10-09), not from Power-Up: `msPullLeadMinutes` (2)
 * before the block start, so 12:29 regular, 11:40 Wednesday and Minimum,
 * 12:20 Stack. The ready time and the latest freeze do not move: both are
 * well before the MS pull (the lead must stay under the latest-freeze margin,
 * which reflectionSettingsOrDefault enforces).
 */
export function pullTimes(kind: ScheduleKind,
  settings: Pick<ReflectionSettings, "swapMinuteByKind" | "hsPullLeadMinutes" | "msPullLeadMinutes">):
  { msMinute: number; swapMinute: number; hsMinute: number } {
  const start = POWER_UP_MINUTE[kind];
  const swap = settings.swapMinuteByKind?.[kind] ?? Math.floor((start + BLOCK_END_MINUTE[kind]) / 2);
  return { msMinute: start - settings.msPullLeadMinutes, swapMinute: swap, hsMinute: swap - settings.hsPullLeadMinutes };
}

/** "12:29 PM" from minutes after local midnight. */
export function minuteText(minute: number): string {
  const h = Math.floor(minute / 60), m = minute % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

/**
 * WHEN AND FROM WHERE EACH DIVISION IS PULLED, as the section heading, the
 * printed page and the slips say it:
 *   MS  "pull at 12:29 PM from the class before lunch"
 *   HS  "pull at 12:57 PM, 5 minutes before the end of Power-Up"
 */
export function pullWords(kind: ScheduleKind, division: Division,
  settings: Pick<ReflectionSettings, "swapMinuteByKind" | "hsPullLeadMinutes" | "msPullLeadMinutes">): string {
  const p = pullTimes(kind, settings);
  if (division === "ms") return `pull at ${minuteText(p.msMinute)} from the class before lunch`;
  const lead = settings.hsPullLeadMinutes;
  return `pull at ${minuteText(p.hsMinute)}, ${lead} minute${lead === 1 ? "" : "s"} before the end of Power-Up`;
}

/**
 * THE SEEDED BELL SCHEDULES (seedBellSchedules.ts, the office's printed
 * 2026-27 schedule), as the list needs them: the schedule type the list
 * gives each one (scheduleKindFor matches these names), the weekdays it runs
 * on, and its LAST CLASS PERIOD BEFORE LUNCH & POWER UP:
 *   Regular Mon/Thu    1, Nutrition, 3, Lunch & Power Up   -> P3 (slot 4)
 *   Regular Tue/Fri    2, Nutrition, 4, Lunch & Power Up   -> P4 (slot 5)
 *   Regular Wednesday  1, 2, Nutrition, 3, 4, Lunch & ...  -> P4 (slot 5)
 *   Stack Day          1, 2, Nutrition, 3, 4, Lunch & ...  -> P4 (slot 5)
 *   Minimum Day        the Wednesday clock                 -> P4 (slot 5)
 * Copied, not imported, because this file imports nothing but the school
 * clock. reflectionRules.test.mjs reads seedBellSchedules.ts itself and
 * requires every value here to match what it derives from the periods there,
 * so a change to the printed schedule that is not made here fails npm test.
 */
export const SEEDED_SCHEDULES: ReadonlyArray<{
  name: string; kind: ScheduleKind; weekdays: number[]; lastPeriodBeforeLunch: number;
}> = [
  { name: "Regular · Mon/Thu", kind: "regular", weekdays: [1, 4], lastPeriodBeforeLunch: 3 },
  { name: "Regular · Tue/Fri", kind: "regular", weekdays: [2, 5], lastPeriodBeforeLunch: 4 },
  { name: "Regular · Wednesday", kind: "wed", weekdays: [3], lastPeriodBeforeLunch: 4 },
  { name: "Stack Day / Return from Holiday", kind: "stack", weekdays: [], lastPeriodBeforeLunch: 4 },
  { name: "Minimum Day", kind: "minimum", weekdays: [], lastPeriodBeforeLunch: 4 },
];

/** The fixed reads of a day (LA minutes). Closing, fallback and latest-freeze are windows, not items. */
export const OPENING_MINUTE = 450;              // 07:30
export const ROUTINE_MINUTES = [510, 570, 630]; // 08:30, 09:30, 10:30
export const PRE_CLOSE_OFFSETS = [40, 30, 20, 10];
export const AFTER_CLOSE_MINUTES = [780, 840, 900]; // 13:00, 14:00, 15:00
export const AFTER_SCHOOL_MINUTE = 945;          // 15:45
/** On a weekday PowerSchool shows to be no school, only these two fixed reads still run. */
export const NO_EVIDENCE_READS = ["routine@630", "after-school"];

// ===========================================================================
// Settings
// ===========================================================================

export type ReflectionSettings = {
  modeByDivision: Record<Division, Mode>;
  countFromDateByDivision: Record<Division, string | null>;
  closeMinuteByKind: Record<ScheduleKind, number>;
  lastFreezeMarginMin: number;
  scheduleKinds: Record<string, ScheduleKind>;
  lateEntryLists: number;
  maxCarries: number;
  countDitching: boolean;
  countPowerUpTardies: boolean;
  holdFirstClassOnPtNoRow: boolean;
  capacity: Record<Division, number | null>;
  /** The minute MS and HS swap halves of Lunch & Power-Up; null = the block's midpoint. */
  swapMinuteByKind: Record<ScheduleKind, number | null>;
  hsPullLeadMinutes: number;
  /** MS is pulled from the class before lunch this many minutes before Lunch & Power-Up starts (owner, 10/9). */
  msPullLeadMinutes: number;
};

/** The repo default: OFF for both divisions. Turning it on is a command-line act. */
export const DEFAULT_REFLECTION_SETTINGS: ReflectionSettings = {
  modeByDivision: { ms: "off", hs: "off" },
  countFromDateByDivision: { ms: null, hs: null },
  closeMinuteByKind: { ...DEFAULT_CLOSE_MINUTE },
  lastFreezeMarginMin: 10,
  scheduleKinds: {},
  lateEntryLists: 5,
  maxCarries: 5,
  countDitching: false,
  countPowerUpTardies: false,
  holdFirstClassOnPtNoRow: false,
  capacity: { ms: null, hs: null },
  swapMinuteByKind: { regular: null, wed: null, minimum: null, stack: null },
  hsPullLeadMinutes: 5,
  msPullLeadMinutes: 2,
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (s: unknown): s is string => typeof s === "string" && DAY_RE.test(s);
const asMode = (m: unknown): Mode => (m === "shadow" || m === "live" ? m : "off");
const asKind = (k: unknown): ScheduleKind | null =>
  (SCHEDULE_KINDS as string[]).includes(String(k)) ? (k as ScheduleKind) : null;

/**
 * Whatever is stored, a usable set of settings. A value that does not make
 * sense falls back to the default rather than being trusted.
 *
 * CLOSE MINUTES are whole 5-minute steps, because the tick runs every 5
 * minutes; and every close leaves room for at least one closing read to start
 * and finish its lease before the ready time (close + 4 min <= ready). A close
 * at or after the ready time would mean no closing read could ever run.
 */
export function reflectionSettingsOrDefault(raw: unknown): ReflectionSettings {
  const d = DEFAULT_REFLECTION_SETTINGS;
  const s = raw && typeof raw === "object" ? (raw as Record<string, any>) : {};
  const int = (v: unknown, lo: number, hi: number, fallback: number) => {
    const x = Number(v);
    return Number.isInteger(x) && x >= lo && x <= hi ? x : fallback;
  };
  const close = {} as Record<ScheduleKind, number>;
  for (const k of SCHEDULE_KINDS) {
    const x = Number(s.closeMinuteByKind?.[k]);
    const ok = Number.isInteger(x) && x % 5 === 0 && x >= 540 && x + LEASE_MS / 60000 <= READY_MINUTE[k];
    close[k] = ok ? x : d.closeMinuteByKind[k];
  }
  const kinds: Record<string, ScheduleKind> = {};
  for (const [id, k] of Object.entries(s.scheduleKinds ?? {})) {
    const kk = asKind(k);
    if (kk) kinds[String(id)] = kk;
  }
  const cap = (v: unknown) => {
    const x = Number(v);
    return v !== null && v !== undefined && Number.isInteger(x) && x > 0 ? x : null;
  };
  // A swap minute must fall strictly inside the block, or it is the midpoint.
  const swap = {} as Record<ScheduleKind, number | null>;
  for (const k of SCHEDULE_KINDS) {
    const x = s.swapMinuteByKind?.[k];
    swap[k] = Number.isInteger(x) && x > POWER_UP_MINUTE[k] && x < BLOCK_END_MINUTE[k] ? x : null;
  }
  const margin = int(s.lastFreezeMarginMin, 5, 30, d.lastFreezeMarginMin);
  return {
    swapMinuteByKind: swap,
    hsPullLeadMinutes: int(s.hsPullLeadMinutes, 0, 30, d.hsPullLeadMinutes),
    // The MS pull stays after the latest a list may be made (Lunch &
    // Power-Up less the margin): a lead that reaches it would pull students
    // before their list could exist.
    msPullLeadMinutes: int(s.msPullLeadMinutes, 0, margin - 1, d.msPullLeadMinutes),
    modeByDivision: { ms: asMode(s.modeByDivision?.ms), hs: asMode(s.modeByDivision?.hs) },
    countFromDateByDivision: {
      ms: isDay(s.countFromDateByDivision?.ms) ? s.countFromDateByDivision.ms : null,
      hs: isDay(s.countFromDateByDivision?.hs) ? s.countFromDateByDivision.hs : null,
    },
    closeMinuteByKind: close,
    lastFreezeMarginMin: margin,
    scheduleKinds: kinds,
    lateEntryLists: int(s.lateEntryLists, 1, 30, d.lateEntryLists),
    maxCarries: int(s.maxCarries, 1, 30, d.maxCarries),
    countDitching: s.countDitching === true,
    countPowerUpTardies: s.countPowerUpTardies === true,
    holdFirstClassOnPtNoRow: s.holdFirstClassOnPtNoRow === true,
    capacity: { ms: cap(s.capacity?.ms), hs: cap(s.capacity?.hs) },
  };
}

// ===========================================================================
// 3.1 What counts: slots, codes, labels
// ===========================================================================

/** periodid -> slot 1..10, or null for anything outside 851..860 (including 0). */
export function slotOfPeriodId(periodId: unknown): number | null {
  const n = Number(periodId);
  if (!Number.isInteger(n)) return null;
  const slot = n - PERIOD_ID_BASE;
  return slot >= 1 && slot <= 10 ? slot : null;
}

/**
 * How staff name a slot. Bell labels are NOT used: they sit one off from the
 * slots ("1" is slot 2), which is exactly the confusion this avoids.
 */
export function slotLabel(slot: number): string {
  if (slot === 1) return "Promise Time AM";
  if (slot === 8 || slot === 9) return "Power-Up";
  if (slot === 10) return "Promise Time PM";
  if (slot >= 2 && slot <= 7) return `P${slot - 1}`;
  return `slot ${slot}`;
}

/** The leading slot of a section expression, "8(A-E)" -> 8. */
export function slotOfExpression(expression: unknown): number | null {
  const m = /^\s*(\d{1,2})\(/.exec(String(expression ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 10 ? n : null;
}

export type CodeInfo = { code: string; absent: boolean; description: string };
export type CodeBook =
  | { ok: true; byId: Record<string, CodeInfo>; tIds: string[] }
  | { ok: false; reason: string };

/**
 * The attendance codes, read from PowerSchool's attendance_code table every
 * day and never typed into this file.
 *
 * "ABSENT" IS PRESENCE STATUS, NOT A LETTER. presence_status_cd === "Absent"
 * is what the attendance rebuild uses, and it matters: Ditching (K) is coded
 * Present, and Suspended is coded Absent.
 *
 * NO T, NO READ. If the Tardy code cannot be found, every T row would be
 * unrecognisable and the list would come out empty while looking normal. So
 * the read is refused and the screen says why.
 */
export function buildCodeBook(rows: unknown): CodeBook {
  const byId: Record<string, CodeInfo> = {};
  const tIds: string[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = r?.id === null || r?.id === undefined ? "" : String(r.id);
    if (!id) continue;
    const code = String(r?.att_code ?? "").trim().toUpperCase();
    byId[id] = { code, absent: String(r?.presence_status_cd ?? "") === "Absent", description: String(r?.description ?? "") };
    if (code === "T") tIds.push(id);
  }
  if (!tIds.length) {
    return {
      ok: false,
      reason: "PowerSchool's attendance codes have no Tardy (T) code, so no tardy could be recognised. "
        + "Nothing was read into the list.",
    };
  }
  return { ok: true, byId, tIds };
}

/**
 * The codes that put a student on the list. Only T, unexcused Tardy: the
 * owner's decision, and PowerSchool's own term tardy count uses T alone.
 * Excused Tardy (D) never counts; that is a decision, not a setting.
 * Ditching (K) counts only if the countDitching setting is on.
 */
export function countedCodes(settings: Pick<ReflectionSettings, "countDitching">): string[] {
  const codes = ["T"];
  if (settings.countDitching) codes.push("K");
  return codes;
}

/**
 * The slots whose tardy can be listed. Promise Time AM (1) and PM (10) never:
 * the owner excluded Promise Time. Power-Up (8, 9) only if
 * countPowerUpTardies is on.
 */
export function listableSlot(slot: number, settings: Pick<ReflectionSettings, "countPowerUpTardies">): boolean {
  if (CLASS_SLOTS.includes(slot)) return true;
  return settings.countPowerUpTardies && POWER_UP_SLOTS.includes(slot);
}

/** The position of a slot in the day. Unknown slots sort last. */
export function orderOf(slot: number): number {
  const i = SLOT_ORDER.indexOf(slot);
  return i < 0 ? SLOT_ORDER.length : i;
}

/**
 * A tardy in this slot happened before Lunch & Power-Up, so it can be served
 * the same day. P5 and P6 (and Power-Up itself) cannot: they happen after the
 * list is made, so they always go on the next list.
 */
export function servesSameDay(slot: number): boolean {
  return orderOf(slot) < orderOf(POWER_UP_SLOTS[0]);
}

/** The natural key of a tardy. A re-entered mark gets a new PowerSchool id and keeps this. */
export function tardyKey(studentNumber: string, attDate: string, periodId: number | string): string {
  return `${studentNumber}|${attDate}|${Number(periodId)}`;
}

/** Grades 6-8 are middle school, 9-12 high school. Anything else has no division. */
export function divisionOfGrade(grade: unknown): Division | null {
  const g = Number(String(grade ?? "").trim());
  if (!Number.isInteger(g)) return null;
  if (g >= 6 && g <= 8) return "ms";
  if (g >= 9 && g <= 12) return "hs";
  return null;
}

// ===========================================================================
// The roster snapshot and the Power-Up row (4.5, 3.7)
// ===========================================================================

export type RosterSnap = {
  studentNumber: string;
  grade: string;
  division: Division | null;
  puSlot: number | null;
  puSectionId: string | null;
  puTeacherName: string | null;
  puTeacherEmail: string | null;
  puCourse: string | null;
  /** RSP, ELD or 7002A: flagged so the runner knows the room. Pulled like everyone else (owner, 10/8). */
  puFlag: string | null;
  /** Two Power-Up-time rows: the list says "Check PowerSchool" rather than picking one. */
  puCheck: boolean;
  enrolledSlots: number[];
  sectionBySlot: Record<string, string>;
  teacherBySlot: Record<string, string>;
  /**
   * The class in each slot, whole: section, teacher, course, flag, and how
   * many different sections the student has in that slot (two means
   * PowerSchool must be checked, never one of them guessed). Added 10/9 for
   * the MS class before lunch; a snapshot taken before then has none until
   * the next opening read takes a new one.
   */
  classBySlot?: Record<string, SlotClass>;
};

export type SlotClass = { sectionId: string | null; teacher: string | null; course: string | null; flag: string | null; sections: number };

const teacherName = (r: any) => [r?.teacherFirstName, r?.teacherLastName]
  .map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");

/**
 * The class's name as staff see it, and its flag: RSP, Designated ELD and
 * course 7002A are flagged so the runner knows the room (those students are
 * pulled like everyone else, owner 10/8). 7002A's name is blank in every
 * synced table (the COURSES join misses it), so it is named by its number.
 */
function courseAndFlag(r: any): { course: string | null; flag: string | null } {
  const course = String(r?.courseName ?? "").trim();
  const number = String(r?.courseNumber ?? "").trim();
  let flag: string | null = null;
  if (/\bRSP\b/i.test(course)) flag = "RSP";
  else if (/\bELD\b/i.test(course)) flag = "ELD";
  else if (number.toUpperCase() === "7002A") flag = "7002A";
  return { course: course || (number ? `Course ${number}` : null), flag };
}

/**
 * What the student is in at Power-Up time.
 *
 * THE SLOT, NEVER THE COURSE NAME. Every one of the 607 students has exactly
 * one row in slot 8 (HS) or slot 9 (MS), but 50 of those rows are not named
 * Power Up: 27 'RSP A', 7 'Designated ELD 3A', and 16 course 7002A whose name
 * is blank because the roster query's COURSES join misses it. A name match
 * would leave those 50 with no teacher. Owner, 10/8: they are pulled like
 * everyone else, and the row is flagged with the class they are actually in.
 */
export function powerUpFrom(rows: any[]): Pick<RosterSnap,
  "puSlot" | "puSectionId" | "puTeacherName" | "puTeacherEmail" | "puCourse" | "puFlag" | "puCheck"> {
  const pu = (rows || [])
    .map((r) => ({ r, slot: slotOfExpression(r?.period ?? r?.sectionExpression) }))
    .filter((x) => x.slot !== null && POWER_UP_SLOTS.includes(x.slot))
    .sort((a, b) => String(a.r?.sectionId ?? "").localeCompare(String(b.r?.sectionId ?? "")));
  if (!pu.length) {
    return { puSlot: null, puSectionId: null, puTeacherName: null, puTeacherEmail: null, puCourse: null, puFlag: null, puCheck: false };
  }
  const { r, slot } = pu[0];
  const { course, flag } = courseAndFlag(r);
  return {
    puSlot: slot,
    puSectionId: r?.sectionId ? String(r.sectionId) : null,
    puTeacherName: teacherName(r) || null,
    puTeacherEmail: r?.teacherEmail ? String(r.teacherEmail) : null,
    puCourse: course,
    puFlag: flag,
    puCheck: pu.length > 1,
  };
}

/**
 * psRoster rows -> one snapshot row per student: the Power-Up row, every slot
 * they are enrolled in, and the section and teacher in each. The list uses
 * the snapshot, never psRoster live, because the 19:00 UTC sync wipes and
 * rebuilds psRoster in several writes and a reader in that window sees half a
 * school.
 */
export function rosterSnapshotRows(psRosterRows: any[]): RosterSnap[] {
  const bySn = new Map<string, any[]>();
  for (const r of psRosterRows || []) {
    const sn = String(r?.studentNumber ?? "").trim();
    if (!sn) continue;
    if (!bySn.has(sn)) bySn.set(sn, []);
    bySn.get(sn)!.push(r);
  }
  const out: RosterSnap[] = [];
  for (const [sn, rows] of [...bySn.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sectionBySlot: Record<string, string> = {};
    const teacherBySlot: Record<string, string> = {};
    const classBySlot: Record<string, SlotClass> = {};
    const sectionsIn: Record<string, Set<string>> = {};
    const slots = new Set<number>();
    const sorted = rows.slice().sort((a, b) => String(a?.sectionId ?? "").localeCompare(String(b?.sectionId ?? "")));
    sorted.forEach((r, i) => {
      const slot = slotOfExpression(r?.period ?? r?.sectionExpression);
      if (slot === null) return;
      const k = String(slot);
      slots.add(slot);
      if (!(k in sectionBySlot) && r?.sectionId) sectionBySlot[k] = String(r.sectionId);
      const t = teacherName(r);
      if (!(k in teacherBySlot) && t) teacherBySlot[k] = t;
      // A row with no section id is a class of its own: it can never be
      // folded into another and hide a second class in the slot.
      (sectionsIn[k] ??= new Set()).add(r?.sectionId ? String(r.sectionId) : `row:${i}`);
      if (!(k in classBySlot)) {
        classBySlot[k] = { sectionId: r?.sectionId ? String(r.sectionId) : null, teacher: t || null, ...courseAndFlag(r), sections: 0 };
      }
    });
    for (const k of Object.keys(classBySlot)) classBySlot[k].sections = sectionsIn[k].size;
    const grade = String(rows.find((r) => r?.gradeLevel)?.gradeLevel ?? "").trim();
    out.push({
      studentNumber: sn,
      grade,
      division: divisionOfGrade(grade),
      ...powerUpFrom(rows),
      enrolledSlots: [...slots].sort((a, b) => a - b),
      sectionBySlot,
      teacherBySlot,
      classBySlot,
    });
  }
  return out;
}

/**
 * Take a new roster snapshot, or keep yesterday's?
 *
 * Only a clean, whole roster replaces the snapshot: the latest sync finished
 * ok, every row carries ONE syncedAt (a mixture means a sync was mid-run), and
 * the student count is at least 90% of the previous snapshot's. Otherwise the
 * old snapshot stays and the list says how old it is. A short roster would
 * leave students with no Power-Up teacher, which reads as "not enrolled".
 */
export function rosterSnapshotVerdict(input: {
  syncOk: boolean; syncedAts: string[]; studentCount: number; previousCount: number | null;
}): { take: boolean; reason: string } {
  const distinct = [...new Set((input.syncedAts || []).filter(Boolean))];
  if (!input.syncOk) return { take: false, reason: "The latest roster sync did not finish cleanly." };
  if (!input.studentCount) return { take: false, reason: "The roster is empty." };
  if (distinct.length !== 1) {
    return { take: false, reason: `The roster holds rows from ${distinct.length} different syncs, so a sync was mid-run.` };
  }
  const prev = Number(input.previousCount ?? 0);
  if (prev > 0 && input.studentCount < 0.9 * prev) {
    return { take: false, reason: `The roster has ${input.studentCount} students against ${prev} in the last snapshot (under 90%).` };
  }
  return { take: true, reason: "" };
}

/** What the list knows about its roster snapshot (appState "reflection:roster"). */
export type RosterMeta = {
  snapAt?: string | null;
  snapDay?: string | null;
  rosterSyncedAt?: string | null;
  studentCount?: number | null;
  termId?: string | null;
  termEnd?: string | null;
  termName?: string | null;
  lastRefusal?: { at: string; reason: string } | null;
};

const monthDay = (dateKey: string) => {
  const d = new Date(dateKey + "T12:00:00Z");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

/**
 * "Power-Up teachers from the 10/13 roster": shown whenever the list is not
 * working from today's snapshot (today's could not be taken, so yesterday's or
 * older is in use). Null when the snapshot is today's.
 */
export function rosterAgeBanner(meta: RosterMeta | null | undefined, today: string): string | null {
  if (!meta || !meta.snapDay) return "No roster snapshot yet, so no Power-Up teacher can be shown.";
  if (meta.snapDay >= today) return null;
  return `Power-Up teachers from the ${monthDay(meta.snapDay)} roster.`;
}

/**
 * THE SEMESTER CHANGE (go-live requirement). PS_TERM_ID is pinned to one term
 * (S1, 3601, ends 12/18; S2 starts 1/11). Until somebody switches it, the sync
 * keeps reading S1's sections after S2 has begun, and every Power-Up teacher on
 * the list is S1's. So from the day after the snapshot term's last day, for as
 * long as PS_TERM_ID still names that same term, the list and the admin
 * dashboard say so. Nothing is shown when the term's end is unknown: the
 * January runbook step and the developer's calendar reminder cover that.
 */
export function termBanner(input: {
  today: string; termEnd?: string | null; termName?: string | null;
  snapshotTermId?: string | null; currentTermId?: string | null;
}): string | null {
  if (!isDay(input.termEnd) || !(input.today > input.termEnd)) return null;
  if (!input.snapshotTermId || String(input.currentTermId ?? "") !== String(input.snapshotTermId)) return null;
  const name = input.termName ? `${input.termName} roster` : "The roster's term";
  return `${name} ended ${monthDay(input.termEnd)}: Power-Up teachers may be out of date until `
    + `PS_TERM_ID is switched to the next term.`;
}

// ===========================================================================
// 3.2 One day's attendance, summarised
// ===========================================================================

export type AttRow = { id: string; studentNumber: string; attDate: string; periodId: number; codeId: string };
export type Mark = { id: string; code: string; absent: boolean };
export type DaySummary = {
  date: string;
  /** Rows per slot, every code. */
  rowCounts: Record<string, number>;
  /** Slots with at least MET_MIN_ROWS rows. */
  met: number[];
  /** Per student, per slot, the marks. PowerSchool stores exceptions, so most students have few. */
  marks: Record<string, Record<string, Mark[]>>;
  /** Per slot, the sections (by the roster snapshot) in which at least one student has a mark. */
  sectionsWithMarks: Record<string, string[]>;
  /** Rows whose period is outside 851..860 (including 0): counted for the banner, never dropped silently. */
  unmappedRows: number;
  unmappedPeriodIds: number[];
  /** Keys with more than one row (any code). */
  collisions: string[];
};

/**
 * PowerSchool rows (with PowerSchool's internal student id) -> rows keyed by
 * student number. A row whose student cannot be matched is counted, never
 * guessed: it reaches the review queue as "marks that could not be matched".
 */
export function normalizeRows(raw: any[], studentNumberOfPsId: Record<string, string>): { rows: AttRow[]; unmatched: number } {
  const rows: AttRow[] = [];
  let unmatched = 0;
  for (const r of raw || []) {
    const sn = studentNumberOfPsId[String(r?.studentid ?? "")];
    if (!sn) { unmatched++; continue; }
    rows.push({
      id: String(r?.id ?? ""),
      studentNumber: String(sn),
      attDate: String(r?.att_date ?? "").slice(0, 10),
      periodId: Number(r?.periodid),
      codeId: String(r?.attendance_codeid ?? ""),
    });
  }
  return { rows, unmatched };
}

/**
 * THE READER'S WIRE FORMAT. A confirmed day is up to about 900 rows, and one
 * read can hand several days to applyRead at once, so each row crosses as one
 * short string, "id|studentNumber|periodId|codeId", grouped under its date.
 */
export function encodeRow(r: Pick<AttRow, "id" | "studentNumber" | "periodId" | "codeId">): string {
  return `${r.id}|${r.studentNumber}|${r.periodId}|${r.codeId}`;
}
export function decodeRows(date: string, rows: string[]): AttRow[] {
  return (rows || []).map((s) => {
    const [id, studentNumber, periodId, codeId] = String(s).split("|");
    return { id, studentNumber, attDate: date, periodId: Number(periodId), codeId };
  });
}

/**
 * A fingerprint of one date's T row ids (FNV-1a over the sorted ids, with the
 * count). The lookback re-reads a past date IN FULL only when its tardies
 * changed since its last full read, so a quiet week costs a few short T-only
 * reads instead of a full day each.
 */
export function idSetHash(ids: string[]): string {
  const sorted = [...new Set((ids || []).map(String))].sort();
  let h = 0x811c9dc5;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= 0x2c; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${sorted.length}:${h.toString(16).padStart(8, "0")}`;
}

/**
 * PowerSchool's internal student id -> student number, and the grade by
 * student number, from the stored map ("psId|studentNumber|grade" per
 * student: an array, because Convex caps an object's fields and the school
 * has about 700 students).
 */
export function studentMap(entries: unknown): { snOf: Record<string, string>; gradeOf: Record<string, string> } {
  const snOf: Record<string, string> = {};
  const gradeOf: Record<string, string> = {};
  for (const e of Array.isArray(entries) ? entries : []) {
    const [psId, sn, grade] = String(e).split("|");
    if (!psId || !sn) continue;
    snOf[psId] = sn;
    if (grade) gradeOf[sn] = grade;
  }
  return { snOf, gradeOf };
}

export function summarizeDay(
  date: string, rows: AttRow[], codes: Extract<CodeBook, { ok: true }>, rosterBySn: Record<string, RosterSnap>,
): DaySummary {
  const rowCounts: Record<string, number> = {};
  const marks: Record<string, Record<string, Mark[]>> = {};
  const sections: Record<string, Set<string>> = {};
  const unmappedIds = new Set<number>();
  const perKey = new Map<string, number>();
  let unmapped = 0;
  for (const r of rows) {
    if (r.attDate !== date) continue;
    const slot = slotOfPeriodId(r.periodId);
    if (slot === null) {
      unmapped++;
      unmappedIds.add(Number.isFinite(r.periodId) ? r.periodId : 0);
      continue;
    }
    const k = String(slot);
    rowCounts[k] = (rowCounts[k] ?? 0) + 1;
    const info = codes.byId[r.codeId] ?? { code: "?", absent: false, description: "" };
    ((marks[r.studentNumber] ??= {})[k] ??= []).push({ id: r.id, code: info.code, absent: info.absent });
    const section = rosterBySn[r.studentNumber]?.sectionBySlot?.[k];
    if (section) (sections[k] ??= new Set()).add(section);
    const key = tardyKey(r.studentNumber, r.attDate, r.periodId);
    perKey.set(key, (perKey.get(key) ?? 0) + 1);
  }
  const sectionsWithMarks: Record<string, string[]> = {};
  for (const [k, set] of Object.entries(sections)) sectionsWithMarks[k] = [...set].sort();
  return {
    date,
    rowCounts,
    met: Object.keys(rowCounts).map(Number).filter((s) => rowCounts[String(s)] >= MET_MIN_ROWS).sort((a, b) => a - b),
    marks,
    sectionsWithMarks,
    unmappedRows: unmapped,
    unmappedPeriodIds: [...unmappedIds].sort((a, b) => a - b),
    collisions: [...perKey.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort(),
  };
}

/** Did the slot meet school-wide on this date? */
export function slotMet(summary: Pick<DaySummary, "rowCounts">, slot: number): boolean {
  return (summary.rowCounts[String(slot)] ?? 0) >= MET_MIN_ROWS;
}

/** Has the student's own section in this slot got any marks today? */
export function sectionHasMarks(summary: Pick<DaySummary, "sectionsWithMarks">, slot: number, section: string | null | undefined): boolean {
  return !!section && (summary.sectionsWithMarks[String(slot)] ?? []).includes(section);
}

/**
 * Sections in a slot with NO marks yet: the "Promise Time AM attendance not in
 * yet for N sections" banner. Only meaningful once the slot has met.
 */
export function blankSections(summary: DaySummary, rosterBySn: Record<string, RosterSnap>, slot: number): string[] {
  if (!slotMet(summary, slot)) return [];
  const all = new Set<string>();
  for (const snap of Object.values(rosterBySn)) {
    const s = snap.sectionBySlot?.[String(slot)];
    if (s) all.add(s);
  }
  return [...all].filter((s) => !sectionHasMarks(summary, slot, s)).sort();
}

// ===========================================================================
// 3.3 "Arrived late to school": detected and skipped
// ===========================================================================

type SlotReading = "present" | "absent" | "unknown";

/**
 * Was the student in the building during this slot?
 *
 * A MARK DECIDES. Any mark whose code is not Absent-status means the student
 * was there: T, D, K and a blank Present code all say so. Promise Time AM is
 * stricter: a Tardy (or Excused Tardy) there means the student ARRIVED LATE
 * TO SCHOOL (owner decision), so only a Present-status code other than T or D
 * counts as present.
 *
 * NO MARK IS PRESENT ONLY WHEN THE SECTION HAS MARKS. PowerSchool stores
 * exceptions, so a student with no row was there -- but only once the
 * teacher has taken attendance. Until the student's own section has at least
 * one mark that day, no row means nobody knows yet ("unknown"), and the
 * tardy is held rather than guessed. After school (`final`) a section that
 * still has no marks is taken as everyone present.
 *
 * NO SECTION KNOWN (no snapshot row for that slot): the slot is only kept at
 * all because it met school-wide, which is the same evidence one level up,
 * so no row reads as present.
 */
function readSlot(summary: DaySummary, sn: string, snap: RosterSnap | null, slot: number, final: boolean): {
  reading: SlotReading; noRow: boolean;
} {
  const marks = summary.marks[sn]?.[String(slot)] ?? [];
  if (marks.length) {
    if (slot === 1) {
      return { reading: marks.some((m) => !m.absent && m.code !== "T" && m.code !== "D") ? "present" : "absent", noRow: false };
    }
    return { reading: marks.some((m) => !m.absent) ? "present" : "absent", noRow: false };
  }
  const section = snap?.sectionBySlot?.[String(slot)];
  if (!section) return { reading: "present", noRow: true };
  if (sectionHasMarks(summary, slot, section)) return { reading: "present", noRow: true };
  return { reading: final ? "present" : "unknown", noRow: true };
}

/**
 * The slots a verdict looks at: before `slot` in the day, met today, and the
 * student's own by the roster snapshot. With no snapshot rows the enrolment
 * filter is skipped -- except for the two Power-Up slots, because without a
 * roster nobody knows which of them is the student's, and the other
 * division's Power-Up always meets.
 */
function keptSlotsBefore(summary: DaySummary, snap: RosterSnap | null, slot: number): number[] {
  const enrolled = snap && snap.enrolledSlots?.length ? new Set(snap.enrolledSlots) : null;
  return SLOT_ORDER.filter((s) => orderOf(s) < orderOf(slot) && slotMet(summary, s)
    && (enrolled ? enrolled.has(s) : !POWER_UP_SLOTS.includes(s)));
}

export type ArrivalVerdict = {
  verdict: "counted" | "held" | "arrival";
  reason: string;
  /** Slots whose section had no marks yet: what a hold is waiting for. */
  unknownSlots: number[];
};

/**
 * Is a T in class slot `slot` a tardy BETWEEN periods (counted), a student
 * ARRIVING late to school (skipped), or not yet knowable (held)?
 *
 * THE RULE: counted if the student has a Present reading in any earlier slot
 * that met today and that they are enrolled in; held if none is present but
 * at least one is unknown (its section has no marks yet); an arrival
 * otherwise, including when there is no earlier slot at all.
 *
 * WHY THIS RULE, with numbers (1,789 class T rows this year): counting every
 * class T gives a median list of 42 and a max of 122, three quarters of it
 * students arriving late. Skipping only the first class when Promise Time AM
 * was A or T (the owner's words taken literally) still lists about 260
 * tardies from students who arrived during a later class. Skipping the whole
 * day drops 128 real between-period tardies from students who arrived late
 * and were then late again. "No Present mark earlier" is the rule that
 * matches "between periods only": median 15, max 46.
 */
export function arrivalVerdict(
  summary: DaySummary, sn: string, slot: number, snap: RosterSnap | null,
  opts: { final?: boolean; holdFirstClassOnPtNoRow?: boolean } = {},
): ArrivalVerdict {
  const final = !!opts.final;
  const kept = keptSlotsBefore(summary, snap, slot);
  const present: Array<{ slot: number; noRow: boolean }> = [];
  const unknown: number[] = [];
  for (const s of kept) {
    const r = readSlot(summary, sn, snap, s, final);
    if (r.reading === "present") present.push({ slot: s, noRow: r.noRow });
    else if (r.reading === "unknown") unknown.push(s);
  }
  if (present.length) {
    // THE FALLBACK SETTING (off by default). A first-class T whose ONLY
    // evidence of being in school is "no row at Promise Time AM" waits for
    // the after-school read, when Promise Time marks are surely in. Measured:
    // 139 of 702 counted tardies (about 3.7 a day) would move a day later.
    const onlyPtNoRow = present.length === 1 && present[0].slot === 1 && present[0].noRow;
    if (opts.holdFirstClassOnPtNoRow && onlyPtNoRow && !final) {
      return { verdict: "held", reason: "Waiting for Promise Time AM attendance (after-school read)", unknownSlots: [1] };
    }
    return { verdict: "counted", reason: `In school earlier (${slotLabel(present[0].slot)})`, unknownSlots: [] };
  }
  if (unknown.length) {
    return {
      verdict: "held",
      reason: `Waiting for ${unknown.map(slotLabel).join(", ")} attendance`,
      unknownSlots: unknown,
    };
  }
  return { verdict: "arrival", reason: "Arrived late to school", unknownSlots: [] };
}

/**
 * "Absent this morning: check if arrived". Every class that met before the
 * list closes, and that the student is enrolled in, carries an Absent mark.
 * Measured on 4.2% of listed students. The slip STILL goes out: if the
 * student is not there, the room ticks Not here and the detention carries.
 */
export function absentThisMorning(summary: DaySummary, sn: string, snap: RosterSnap | null): boolean {
  const before = keptSlotsBefore(summary, snap, POWER_UP_SLOTS[0]);
  if (!before.length) return false;
  return before.every((s) => {
    const marks = summary.marks[sn]?.[String(s)] ?? [];
    return marks.length > 0 && marks.every((m) => m.absent);
  });
}

export type TardyCandidate = {
  key: string;
  studentNumber: string;
  attDate: string;
  periodId: number;
  slot: number;
  psRowIds: string[];
  code: string;
  verdict: ArrivalVerdict["verdict"];
  reason: string;
  unknownSlots: number[];
  /** From the roster snapshot. A missing teacher never holds a tardy back. */
  classTeacher: string | null;
};

/**
 * Every listable tardy of one date, each with its arrival verdict. Only
 * counted codes in listable slots; everything else only goes into counts.
 */
export function tardyCandidates(
  summary: DaySummary, rosterBySn: Record<string, RosterSnap>, settings: ReflectionSettings,
  opts: { final?: boolean } = {},
): TardyCandidate[] {
  const counted = countedCodes(settings);
  const out: TardyCandidate[] = [];
  for (const [sn, bySlot] of Object.entries(summary.marks)) {
    const snap = rosterBySn[sn] ?? null;
    for (const [k, marks] of Object.entries(bySlot)) {
      const slot = Number(k);
      if (!listableSlot(slot, settings)) continue;
      const hit = marks.filter((m) => counted.includes(m.code));
      if (!hit.length) continue;
      const v = arrivalVerdict(summary, sn, slot, snap, {
        final: opts.final, holdFirstClassOnPtNoRow: settings.holdFirstClassOnPtNoRow,
      });
      out.push({
        key: tardyKey(sn, summary.date, slot + PERIOD_ID_BASE),
        studentNumber: sn,
        attDate: summary.date,
        periodId: slot + PERIOD_ID_BASE,
        slot,
        psRowIds: hit.map((m) => m.id).sort(),
        code: hit[0].code,
        verdict: v.verdict,
        reason: v.reason,
        unknownSlots: v.unknownSlots,
        classTeacher: snap?.teacherBySlot?.[k] ?? null,
      });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

// ===========================================================================
// 3.4 Uniform: the server sets the day
// ===========================================================================

export const OBSERVED_PAST_MS = 72 * 3600 * 1000;
export const OBSERVED_FUTURE_MS = 5 * 60 * 1000;
export const SAVED_LATE_MS = 10 * 60 * 1000;

/**
 * Which day is a uniform entry filed under?
 *
 * THE SERVER DECIDES, from `observedAt`: the epoch time the adult pressed
 * Enter, sent by the browser's send queue. An epoch time has no time zone,
 * so a Chromebook with the wrong zone still files correctly; the server turns
 * it into the LA day. A queued Tuesday entry sent on Wednesday is filed under
 * Tuesday, so it does not block a Wednesday entry for the same student.
 *
 * A time outside [now - 72 h, now + 5 min] is not believed: the entry is
 * filed now and the disagreement is counted. The day the browser sends is
 * accepted but ignored (old tabs keep working) and also only counted.
 */
export function observedAtVerdict(input: {
  observedAt: unknown; nowIso: string; tz: string; clientDay?: unknown;
}): {
  ok: boolean; reason?: string; at: string; day: string; source: "observed" | "now";
  savedAt: string | null; outOfWindow: boolean; clientDayMismatch: boolean;
} {
  const now = Date.parse(input.nowIso);
  const obs = typeof input.observedAt === "number" ? input.observedAt : Number(input.observedAt);
  const given = input.observedAt !== undefined && input.observedAt !== null && input.observedAt !== "";
  const inWindow = given && Number.isFinite(obs) && obs >= now - OBSERVED_PAST_MS && obs <= now + OBSERVED_FUTURE_MS;
  const atMs = inWindow ? obs : now;
  const at = new Date(atMs).toISOString();
  const lt = wallClock(at, input.tz);
  const day = lt.ok ? lt.dateKey : "";
  const client = typeof input.clientDay === "string" ? input.clientDay : "";
  return {
    ok: lt.ok,
    reason: lt.ok ? undefined : lt.reason,
    at,
    day,
    source: inWindow ? "observed" : "now",
    savedAt: inWindow && now - obs > SAVED_LATE_MS ? new Date(now).toISOString() : null,
    outOfWindow: given && !inWindow,
    clientDayMismatch: !!client && client !== day,
  };
}

// ===========================================================================
// 3.5 School day, schedule type, close / ready / latest times
// ===========================================================================

/**
 * THE ONE PLACE AN INSTANT BECOMES SCHOOL TIME. Every comparison in this file
 * that depends on the time of day goes through here, so the clock change on
 * 1 November cannot be handled in one place and missed in another.
 */
export function wallClock(iso: string, tz: string) {
  return localSchoolTime(iso, tz);
}

/**
 * An LA wall-clock time on a date -> the UTC instant.
 *
 * Tries UTC-7 (daylight) and UTC-8 (standard) and keeps the one whose wall
 * clock reads back the same date and minute. That is the whole DST argument:
 * 11:45 on 2026-10-30 is 18:45Z and on 2026-11-02 is 19:45Z, and a fixed UTC
 * hour would be an hour early all winter.
 */
export function laWallToUtc(dateKey: string, minute: number, tz: string): string | null {
  if (!isDay(dateKey) || !Number.isInteger(minute)) return null;
  const [y, m, d] = dateKey.split("-").map(Number);
  for (const offsetHours of [7, 8]) {
    const iso = new Date(Date.UTC(y, m - 1, d, 0, minute) + offsetHours * 3600 * 1000).toISOString();
    const lt = wallClock(iso, tz);
    if (lt.ok && lt.dateKey === dateKey && lt.minuteOfDay === minute) return iso;
  }
  return null;
}

/** 0 Sunday .. 6 Saturday, from the date itself. */
export function weekdayOf(dateKey: string): number {
  return new Date(dateKey + "T12:00:00Z").getUTCDay();
}

export type Marked = { scheduleId?: string | null; scheduleName?: string | null; noSchool?: boolean } | null | undefined;

/** Does PowerSchool show school in session? Slot 1 alone, or enough rows across two or more slots. */
export function hasEvidence(rowCounts: Record<string, number> | null | undefined): boolean {
  const counts = rowCounts ?? {};
  if ((counts["1"] ?? 0) >= EVIDENCE_SLOT1_ROWS) return true;
  const slots = Object.values(counts).filter((n) => n > 0).length;
  const total = Object.values(counts).reduce((a, n) => a + n, 0);
  return total >= EVIDENCE_TOTAL_ROWS && slots >= EVIDENCE_MIN_SLOTS;
}

export type SchoolDayVerdict = {
  verdict: "yes" | "no" | "unknown";
  basis: "no-school" | "marked" | "weekend" | "admin" | "evidence" | "no-evidence" | "not-read";
  reason: string;
};

/**
 * Is this date a school day?
 *
 * Yes when it is marked with a schedule (and not noSchool); or it is Monday
 * to Friday, not marked noSchool, and either an admin pressed "This is a
 * school day" or PowerSchool shows it in session. noSchool is never a school
 * day, and Saturday and Sunday never are unless marked with a schedule.
 *
 * UNIFORM ENTRIES ARE NOT EVIDENCE. One entry logged on a weekend or a
 * holiday used to be enough to make that date a school day, and a list for
 * it (review A6). `uniformRows` is taken only so the reason can mention it:
 * a uniform entry on a day with no school is claimed by the next school
 * day's list.
 *
 * "unknown" means no PowerSchool read has worked yet today: not proved
 * either way.
 */
export function schoolDayVerdict(input: {
  date: string; marked?: Marked; rowCounts?: Record<string, number> | null;
  adminMarked?: boolean; readSucceeded?: boolean; uniformRows?: number;
}): SchoolDayVerdict {
  const m = input.marked;
  if (m?.noSchool) return { verdict: "no", basis: "no-school", reason: "Marked no school in Settings > Bell Schedule." };
  if (m?.scheduleId) return { verdict: "yes", basis: "marked", reason: "Marked with a schedule in Settings > Bell Schedule." };
  const wd = weekdayOf(input.date);
  if (wd === 0 || wd === 6) return { verdict: "no", basis: "weekend", reason: "A weekend that is not marked with a schedule." };
  if (input.adminMarked) return { verdict: "yes", basis: "admin", reason: "An admin pressed This is a school day." };
  if (hasEvidence(input.rowCounts)) return { verdict: "yes", basis: "evidence", reason: "PowerSchool shows attendance being taken." };
  if (input.readSucceeded) {
    const u = Number(input.uniformRows ?? 0);
    return {
      verdict: "no", basis: "no-evidence",
      reason: "PowerSchool shows no attendance today, so this is not a school day"
        + (u > 0 ? ` (the ${u} uniform ${u === 1 ? "entry" : "entries"} logged today go on the next school day's list).` : "."),
    };
  }
  return { verdict: "unknown", basis: "not-read", reason: "No PowerSchool read has worked yet today." };
}

/**
 * Which schedule type is this date? The first rule that applies wins:
 *   1. a marked schedule, mapped by settings.scheduleKinds, else by its name
 *      (/wednesday/, /minimum/, /stack/, else regular; the seeded names match);
 *   2. Wednesday is `wed`;
 *   3. an unmarked weekday that is not a Wednesday where PowerSchool shows at
 *      least 10 rows in both slot 2 and slot 3, or both 4 and 5, is a
 *      SIX-PERIOD DAY and is treated as `minimum`: it closes earlier, which is
 *      the safe side. Measured over the year it flagged exactly 9/3 and 9/8,
 *      the two unmarked stack days;
 *   4. otherwise `regular`.
 */
export function scheduleKindFor(input: {
  date: string; marked?: Marked; scheduleKinds?: Record<string, ScheduleKind>; rowCounts?: Record<string, number> | null;
}): { kind: ScheduleKind; source: "marked" | "weekday" | "detected"; sixPeriodDetected: boolean } {
  const m = input.marked;
  if (m?.scheduleId) {
    const mapped = input.scheduleKinds?.[String(m.scheduleId)];
    if (mapped) return { kind: mapped, source: "marked", sixPeriodDetected: false };
    const name = String(m.scheduleName ?? "");
    const kind: ScheduleKind = /wednesday/i.test(name) ? "wed" : /minimum/i.test(name) ? "minimum" : /stack/i.test(name) ? "stack" : "regular";
    return { kind, source: "marked", sixPeriodDetected: false };
  }
  if (weekdayOf(input.date) === 3) return { kind: "wed", source: "weekday", sixPeriodDetected: false };
  const c = input.rowCounts ?? {};
  const met = (s: number) => (c[String(s)] ?? 0) >= MET_MIN_ROWS;
  if ((met(2) && met(3)) || (met(4) && met(5))) return { kind: "minimum", source: "detected", sixPeriodDetected: true };
  return { kind: "regular", source: "weekday", sixPeriodDetected: false };
}

export type DayTimes =
  | {
    ok: true; kind: ScheduleKind;
    closeMinute: number; readyMinute: number; lastFreezeMinute: number; powerUpMinute: number;
    closeMs: number; readyMs: number; lastFreezeMs: number; powerUpMs: number;
    close: string; ready: string; lastFreeze: string; powerUp: string;
  }
  | { ok: false; reason: string };

/**
 * The three times of a list day, as instants:
 *   close       - the closing read may start (a setting, per type);
 *   ready       - the owner's "list ready by" (12:00, or 11:30 Wed/Minimum);
 *   lastFreeze  - Lunch & Power-Up minus the margin (12:21 / 11:32 / 12:12):
 *                 from here on, nothing may make the day's list.
 */
export function dayTimes(dateKey: string, kind: ScheduleKind, settings: ReflectionSettings, tz: string): DayTimes {
  const closeMinute = settings.closeMinuteByKind[kind];
  const readyMinute = READY_MINUTE[kind];
  const powerUpMinute = POWER_UP_MINUTE[kind];
  const lastFreezeMinute = powerUpMinute - settings.lastFreezeMarginMin;
  const close = laWallToUtc(dateKey, closeMinute, tz);
  const ready = laWallToUtc(dateKey, readyMinute, tz);
  const lastFreeze = laWallToUtc(dateKey, lastFreezeMinute, tz);
  const powerUp = laWallToUtc(dateKey, powerUpMinute, tz);
  if (!close || !ready || !lastFreeze || !powerUp) {
    return { ok: false, reason: `The list times for ${dateKey} could not be placed on the school's clock (${tz}).` };
  }
  return {
    ok: true, kind, closeMinute, readyMinute, lastFreezeMinute, powerUpMinute,
    closeMs: Date.parse(close), readyMs: Date.parse(ready), lastFreezeMs: Date.parse(lastFreeze), powerUpMs: Date.parse(powerUp),
    close, ready, lastFreeze, powerUp,
  };
}

/**
 * A read starting at `startMs` is a CLOSING read: it starts at or after the
 * close, and its lease ends no later than the ready time. So a closing read
 * can never still be running when the list is due.
 */
export function inClosingWindow(startMs: number, t: Extract<DayTimes, { ok: true }>): boolean {
  return startMs >= t.closeMs && startMs + LEASE_MS <= t.readyMs;
}

/** A LATE closing read: after the ready time, with its lease ending by the latest time. */
export function inLateWindow(startMs: number, t: Extract<DayTimes, { ok: true }>): boolean {
  return startMs >= t.readyMs && startMs + LEASE_MS <= t.lastFreezeMs;
}

// ===========================================================================
// 4.2 The tick: what to do now
// ===========================================================================

/** What the tick knows about today (a reflectionDays row, or a blank one). */
export type DayState = {
  date: string;
  marked?: Marked;
  /** Rows per slot from the latest successful read of today. */
  rowCounts?: Record<string, number> | null;
  adminMarkedSchoolDay?: boolean;
  uniformRows?: number;
  readsDone?: string[];
  lastGoodReadAt?: string | null;
  lastReadError?: string | null;
  frozenAt?: string | null;
  freezeKind?: "closing" | "fallback" | "late" | null;
  /** Recorded by the latest freeze, with the last good read AS OF THEN (the banner's "since"). */
  noList?: { reason: string; at: string; lastGoodReadAt?: string | null } | null;
  closingReadStartedAt?: string | null;
  modeByDivision?: Partial<Record<Division, Mode>>;
};

export type Lease = { runId: string; kind: string; startedAt: string; expiresAt: string } | null | undefined;

/** A lease held by a read that may make the day's list: a closing or a late closing read. */
export function closingLease(lease: Lease): boolean {
  return !!lease && (lease.kind === "closing" || lease.kind === "late-closing");
}

export type ReadPlan = { maps: boolean; roster: boolean; today: boolean; lookback: boolean; sweep: boolean; final: boolean };
export type TickDecision =
  | { do: "none"; why: string }
  | { do: "retry"; afterMs: number; why: string }
  | { do: "read"; key: string; kind: string; reads: ReadPlan; freeze: "closing" | "late" | null; leaseUntil: string }
  | { do: "fallback-freeze"; why: string }
  | { do: "latest-freeze"; noList: { reason: string; lastGoodReadAt: string | null } };

type Item = { key: string; kind: string; minute: number; reads: ReadPlan };
const plan = (p: Partial<ReadPlan>): ReadPlan => ({ maps: false, roster: false, today: true, lookback: false, sweep: false, final: false, ...p });

/** The fixed reads of a day, in time order. */
export function scheduleItems(closeMinute: number): Item[] {
  const items: Item[] = [
    { key: "opening", kind: "opening", minute: OPENING_MINUTE, reads: plan({ maps: true, roster: true, lookback: true }) },
    ...ROUTINE_MINUTES.map((m) => ({ key: `routine@${m}`, kind: "routine", minute: m, reads: plan({}) })),
    ...PRE_CLOSE_OFFSETS.map((o) => ({ key: `pre-close@${o}`, kind: "pre-close", minute: closeMinute - o, reads: plan({}) })),
    ...AFTER_CLOSE_MINUTES.map((m) => ({ key: `after-close@${m}`, kind: "after-close", minute: m, reads: plan({}) })),
    { key: "after-school", kind: "after-school", minute: AFTER_SCHOOL_MINUTE, reads: plan({ lookback: true, sweep: true, final: true }) },
  ];
  return items.sort((a, b) => a.minute - b.minute);
}

/** The latest good read of the day started late enough for "no evidence" to mean no school. */
export function provesNoSchool(day: DayState, tz: string): boolean {
  if (!day.lastGoodReadAt) return false;
  const lt = wallClock(day.lastGoodReadAt, tz);
  return lt.ok && lt.dateKey === day.date && lt.minuteOfDay >= EVIDENCE_EXPECTED_MINUTE;
}

/**
 * Why there is no list, in the words the screen shows: "PowerSchool
 * unreadable 07:30-12:21" or the like.
 */
export function noListReason(day: DayState, t: Extract<DayTimes, { ok: true }>, tz: string): string {
  const since = day.lastGoodReadAt ? `since the ${clockText(day.lastGoodReadAt, tz)} read` : "all morning";
  return `No PowerSchool read could make the list by ${clockText(t.lastFreeze, tz)} (unreadable ${since}).`;
}

/**
 * THE TICK. Runs every 5 minutes; decides, from the LA wall clock and what
 * today already holds, the one thing to do now. It never trusts the UTC hour
 * the cron fired at.
 *
 * In order:
 *   - from lastFreeze on, an unmade day that is or may be a school day gets
 *     NO LIST (its items roll to the next freeze). Nothing freezes it after;
 *   - from ready, a known school day is made by the FALLBACK freeze, with no
 *     PowerSchool read; a day not yet known to be a school day keeps trying
 *     LATE closing reads while their lease would end by lastFreeze;
 *   - from close until ready - lease, a CLOSING read on every tick until one
 *     succeeds;
 *   - otherwise the latest fixed read that is due and not done. A fixed read
 *     before the close never starts so near the close that its lease would
 *     still be held at the close.
 */
export function decideTick(input: {
  nowIso: string; tz: string; day: DayState | null; settings: unknown; lease?: Lease; retry?: number;
}): TickDecision {
  const s = reflectionSettingsOrDefault(input.settings);
  if (s.modeByDivision.ms === "off" && s.modeByDivision.hs === "off") return { do: "none", why: "Switched off for both divisions." };
  const lt = wallClock(input.nowIso, input.tz);
  if (!lt.ok) return { do: "none", why: lt.reason };
  const date = lt.dateKey;
  const day: DayState = input.day && input.day.date === date ? input.day : { date };
  const sd = schoolDayVerdict({
    date, marked: day.marked, rowCounts: day.rowCounts, adminMarked: day.adminMarkedSchoolDay,
    readSucceeded: provesNoSchool(day, input.tz), uniformRows: day.uniformRows,
  });
  if (sd.basis === "no-school" || sd.basis === "weekend") return { do: "none", why: sd.reason };
  const kind = scheduleKindFor({ date, marked: day.marked, scheduleKinds: s.scheduleKinds, rowCounts: day.rowCounts });
  const t = dayTimes(date, kind.kind, s, input.tz);
  if (!t.ok) return { do: "none", why: t.reason };

  const now = Date.parse(input.nowIso);
  const leaseHeld = !!input.lease && Date.parse(input.lease.expiresAt) > now;
  const retries = Number(input.retry ?? 0);
  const made = !!day.frozenAt || !!day.noList;
  const done = new Set(day.readsDone ?? []);
  const iso = (ms: number) => new Date(ms).toISOString();
  const waitOr = (windowEndMs: number, what: string): TickDecision =>
    retries < MAX_TICK_RETRIES && now + TICK_RETRY_MS <= windowEndMs
      ? { do: "retry", afterMs: TICK_RETRY_MS, why: `${what}: another read holds the lease.` }
      : { do: "none", why: `${what}: another read holds the lease and the window has closed.` };
  const read = (key: string, kindName: string, reads: ReadPlan, freeze: "closing" | "late" | null): TickDecision =>
    ({ do: "read", key, kind: kindName, reads, freeze, leaseUntil: iso(now + LEASE_MS) });

  if (!made && sd.verdict !== "no") {
    // THE LATEST FREEZE. Ten minutes before Lunch & Power-Up nothing may
    // make the list any more: a list made later would name students who are
    // already sitting in Power-Up. The day gets "No list today" and every
    // item rolls to the next school day's freeze, tagged "List not made".
    if (now >= t.lastFreezeMs) {
      return { do: "latest-freeze", noList: { reason: noListReason(day, t, input.tz), lastGoodReadAt: day.lastGoodReadAt ?? null } };
    }
    if (now >= t.readyMs) {
      if (sd.verdict === "yes") {
        // THE FALLBACK. No closing read worked, but the day is known to be
        // a school day: make the list now from the last good read, at the
        // owner's ready time. It takes the lease, so a straggling read is
        // fenced out and its items become pending for the next list.
        // It waits only for a CLOSING read (one that may itself make the
        // list). Any other read still holding the lease -- "Read PowerSchool
        // now" pressed just before the ready time is an after-close read --
        // can never make the list, so waiting on it could only run the clock
        // to the latest time and leave the day with no list (review,
        // 2026-10-08). The fallback fences it out instead.
        if (leaseHeld && closingLease(input.lease)) return waitOr(t.lastFreezeMs, "Fallback freeze");
        return { do: "fallback-freeze", why: "No closing read worked by the ready time." };
      }
      if (inLateWindow(now, t) && !done.has("closing")) {
        if (leaseHeld) return waitOr(t.lastFreezeMs - LEASE_MS, "Late closing read");
        return read("late-closing", "late-closing", plan({ lookback: true }), "late");
      }
      return { do: "none", why: "Waiting for the latest time." };
    }
  }
  if (!made && now >= t.closeMs && now < t.readyMs) {
    if (done.has("closing")) return { do: "none", why: "The closing read found no school today." };
    if (inClosingWindow(now, t)) {
      if (leaseHeld) return waitOr(t.readyMs - LEASE_MS, "Closing read");
      return read("closing", "closing", plan({ lookback: true }), "closing");
    }
    return { do: "none", why: "Too close to the ready time to start a closing read." };
  }

  const items = scheduleItems(t.closeMinute);
  let at = -1;
  for (let i = 0; i < items.length; i++) if (items[i].minute <= lt.minuteOfDay) at = i;
  if (at < 0) return { do: "none", why: "Before the opening read." };
  const item = items[at];
  if (done.has(item.key)) return { do: "none", why: `The ${item.kind} read is done.` };
  if (sd.verdict === "no" && !NO_EVIDENCE_READS.includes(item.key)) {
    return { do: "none", why: "PowerSchool shows no school today; only the 10:30 and after-school reads run." };
  }
  const beforeClose = item.minute < t.closeMinute;
  if (beforeClose && now + PRE_CLOSE_QUIET_MS > t.closeMs) return { do: "none", why: "No read starts this close to the close." };
  const nextMinute = at + 1 < items.length ? items[at + 1].minute : 24 * 60;
  const nextIso = laWallToUtc(date, nextMinute === 24 * 60 ? 1439 : nextMinute, input.tz);
  let windowEnd = nextIso ? Date.parse(nextIso) : now;
  if (beforeClose) windowEnd = Math.min(windowEnd, t.closeMs - PRE_CLOSE_QUIET_MS);
  if (leaseHeld) return waitOr(windowEnd, `The ${item.kind} read`);
  return read(item.key, item.kind, item.reads, null);
}

/**
 * May this read, now that it has finished, make the day's list?
 *
 * Checked again inside the transaction that would write it, because the
 * clock has moved on since the read started: never once the list is made or
 * has no list, never at or after lastFreeze, never on a day not proved to be
 * a school day, and only for a read that STARTED inside its own window.
 */
export function freezeVerdict(input: {
  nowIso: string; startedAt: string; intent: "closing" | "late" | null; day: DayState; settings: unknown; tz: string;
}): { freeze: true; kind: "closing" | "late" } | { freeze: false; why: string } {
  if (!input.intent) return { freeze: false, why: "Not a closing read." };
  const day = input.day;
  if (day.frozenAt) return { freeze: false, why: "The list is already made." };
  if (day.noList) return { freeze: false, why: "The day already has no list." };
  const s = reflectionSettingsOrDefault(input.settings);
  const sd = schoolDayVerdict({
    date: day.date, marked: day.marked, rowCounts: day.rowCounts, adminMarked: day.adminMarkedSchoolDay,
    readSucceeded: true, uniformRows: day.uniformRows,
  });
  if (sd.verdict !== "yes") return { freeze: false, why: sd.reason };
  const kind = scheduleKindFor({ date: day.date, marked: day.marked, scheduleKinds: s.scheduleKinds, rowCounts: day.rowCounts });
  const t = dayTimes(day.date, kind.kind, s, input.tz);
  if (!t.ok) return { freeze: false, why: t.reason };
  if (Date.parse(input.nowIso) >= t.lastFreezeMs) return { freeze: false, why: "Past the latest time for this list." };
  const start = Date.parse(input.startedAt);
  if (input.intent === "closing" && inClosingWindow(start, t)) return { freeze: true, kind: "closing" };
  if (input.intent === "late" && inLateWindow(start, t)) return { freeze: true, kind: "late" };
  return { freeze: false, why: "The read started outside its window." };
}

/**
 * "Read PowerSchool now" (admin, superadmin, pbis): which read it counts as.
 * Before close a routine read; from close until ready - lease a closing read;
 * after that an after-close read, which may make the list only inside the
 * late-closing window and never after lastFreeze.
 */
export function readNowIntent(input: { nowIso: string; day: DayState; settings: unknown; tz: string }):
  { kind: "routine" | "closing" | "late-closing" | "after-close"; freeze: "closing" | "late" | null } {
  const s = reflectionSettingsOrDefault(input.settings);
  const kind = scheduleKindFor({ date: input.day.date, marked: input.day.marked, scheduleKinds: s.scheduleKinds, rowCounts: input.day.rowCounts });
  const t = dayTimes(input.day.date, kind.kind, s, input.tz);
  const now = Date.parse(input.nowIso);
  if (!t.ok || now < t.closeMs) return { kind: "routine", freeze: null };
  const made = !!input.day.frozenAt || !!input.day.noList;
  if (!made && inClosingWindow(now, t)) return { kind: "closing", freeze: "closing" };
  if (!made && inLateWindow(now, t)) return { kind: "late-closing", freeze: "late" };
  return { kind: "after-close", freeze: null };
}

// ===========================================================================
// 4.3 Lookback dates
// ===========================================================================

export type DayVerdictRow = { date: string; schoolDay?: boolean | null; noSchool?: boolean };

const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/**
 * The dates the lookback re-reads: the last `n` SCHOOL days before today by
 * the stored verdicts, plus any weekday since the newest of them that has no
 * verdict yet (the reader was off, or failed all day) and is not marked
 * noSchool.
 *
 * SCHOOL DAYS, NOT CALENDAR DAYS. On the first day back from a ten-day break
 * the last five calendar days are all holiday, and the tardies entered on the
 * day before the break would never be read again. Counting school days
 * reaches straight back to it. Never before `notBefore` (countFromDate):
 * anything earlier is before-start anyway.
 */
export function lookbackDates(input: {
  today: string; days: DayVerdictRow[]; n: number; notBefore?: string | null; horizonDays?: number;
}): string[] {
  const byDate = new Map(input.days.map((d) => [d.date, d]));
  const horizon = addDays(input.today, -(input.horizonDays ?? 45));
  const floor = input.notBefore && input.notBefore > horizon ? input.notBefore : horizon;
  const school: string[] = [];
  for (let d = addDays(input.today, -1); d >= floor && school.length < input.n; d = addDays(d, -1)) {
    if (byDate.get(d)?.schoolDay === true) school.push(d);
  }
  // With no school day found at all, the floor itself is the oldest date that
  // may still have no verdict (the first counted day, read by nobody because
  // PowerSchool was down that day, say), so it is included.
  const newest = school[0] ?? addDays(floor, -1);
  const unverified: string[] = [];
  for (let d = addDays(input.today, -1); d > newest && d >= floor; d = addDays(d, -1)) {
    const row = byDate.get(d);
    const wd = weekdayOf(d);
    if (wd === 0 || wd === 6) continue;
    if (row?.noSchool) continue;
    if (row && row.schoolDay !== null && row.schoolDay !== undefined) continue;
    unverified.push(d);
  }
  return [...new Set([...school, ...unverified])].sort();
}

/**
 * Where the after-school T-only sweep starts: the 10th school day before
 * today or 30 calendar days back, whichever is EARLIER (it reaches further).
 */
export function sweepFrom(input: { today: string; days: DayVerdictRow[] }): string {
  const thirty = addDays(input.today, -30);
  const school = input.days.filter((d) => d.schoolDay === true && d.date < input.today).map((d) => d.date).sort().reverse();
  const tenth = school[9] ?? null;
  return tenth && tenth < thirty ? tenth : thirty;
}

// ===========================================================================
// 3.9 Switching on, and very late entries
// ===========================================================================

/**
 * Is an item from this date admitted at all? A date before its division's
 * countFromDate is "before-start": stored, never listed. That is what stops
 * switching on (or back on after a pause) from flooding the first list with
 * weeks of old tardies.
 *
 * A DIVISION SWITCHED OFF DECIDES NOTHING YET (third review, 2026-10-08).
 * Stamped before-start while off, an item stayed before-start for good: a
 * tardy seen at 08:30 with HS off, HS switched on at 09:00 counting from
 * today, was never listed -- nor was one handled during a rollback that was
 * switched back on the same day. Off, an item is stored as it reads
 * (countable, held or an arrival), no list claims it (claimAtFreeze skips an
 * off division), and switching on decides: setMode parks everything still
 * waiting from before its countFromDate, and the rest counts.
 */
export function admitState(date: string, division: Division | null, settings: ReflectionSettings): "before-start" | null {
  if (!division) return null;
  if (settings.modeByDivision[division] === "off") return null;
  const from = settings.countFromDateByDivision[division];
  if (!from || date < from) return "before-start";
  return null;
}

/**
 * LATENESS IS COUNTED IN LISTS, NOT DAYS (review A2). The number of lists
 * made for this division, serving a day after the tardy's date, before the
 * tardy was first seen. A break makes no lists, so a Friday P6 tardy entered
 * at 16:30 before Thanksgiving counts 0 and serves on the first day back,
 * instead of looking "ten days late" and going to admin review.
 */
export function listsBeforeSeen(input: {
  attDate: string; firstSeenAt: string; division: Division;
  days: Array<{ date: string; frozenAt?: string | null; modeByDivision?: Partial<Record<Division, Mode>> }>;
}): number {
  const seen = Date.parse(input.firstSeenAt);
  const lists = input.days.filter((d) => {
    const mode = d.modeByDivision?.[input.division];
    return !!d.frozenAt && (mode === "shadow" || mode === "live") && d.date > input.attDate && Date.parse(d.frozenAt) < seen;
  });
  return lists.length;
}

/**
 * The state a newly seen tardy starts in. Before-start wins; then a tardy
 * PowerSchool showed only after `lateEntryLists` lists had already been made
 * goes to ADMIN REVIEW, never silently onto a list or off it; otherwise its
 * arrival verdict decides. Only ever called for a tardy seen for the first
 * time: one already seen and pending is never re-judged as late.
 */
export function initialTardyState(input: {
  verdict: ArrivalVerdict["verdict"]; admit: "before-start" | null; listsBeforeSeen: number; lateEntryLists: number;
}): { state: TardyState; reason?: string } {
  if (input.admit) return { state: "before-start" };
  if (input.listsBeforeSeen >= input.lateEntryLists) {
    return { state: "review", reason: `Entered very late: ${input.listsBeforeSeen} lists were made before PowerSchool showed it` };
  }
  if (input.verdict === "arrival") return { state: "arrival", reason: "Arrived late to school" };
  return { state: input.verdict === "held" ? "held" : "countable" };
}

// ===========================================================================
// 3.10 Keys and corrections
// ===========================================================================

export type TardyState = "countable" | "held" | "arrival" | "cleared" | "before-start" | "review";

export type TardyItem = {
  id: string;
  studentNumber: string;
  attDate: string;
  periodId: number;
  slot: number;
  psRowIds: string[];
  state: TardyState;
  reason?: string | null;
  unitId?: string | null;
  /** When the read that first saw it STARTED (the moment PowerSchool was asked). */
  firstSeenAt: string;
  firstCountableAt?: string | null;
  /** Ever held for attendance. */
  wasHeld?: boolean;
  /** When a hold was released into counting: the "Held for attendance" tag. */
  heldReleasedAt?: string | null;
  classTeacher?: string | null;
};

/**
 * What a code change on a row we still see does to a tardy. Applies on ANY
 * read, the closing read included: seeing the row with a new code is positive
 * evidence, unlike a row that merely did not come back.
 */
export function codeChangeVerdict(code: CodeInfo, settings: Pick<ReflectionSettings, "countDitching">):
  { clear: false } | { clear: true; reason: string } {
  if (countedCodes(settings).includes(code.code)) return { clear: false };
  if (code.code === "D") return { clear: true, reason: "now Excused Tardy" };
  if (code.absent) return { clear: true, reason: "now Absent" };
  if (code.code === "K") return { clear: true, reason: "now Ditching" };
  return { clear: true, reason: code.description ? `now ${code.description}` : "no longer Tardy" };
}

export type Reconcile = {
  /** New keys with a counted code in a listable slot. */
  add: TardyCandidate[];
  /** Same key, different PowerSchool id: deleted and entered again. The record is updated, not doubled. */
  repoint: Array<{ itemId: string; psRowIds: string[] }>;
  /** Same PowerSchool id under a different period: the key moves and keeps its list assignment. */
  move: Array<{ itemId: string; toKey: string; periodId: number; slot: number; psRowIds: string[] }>;
  /** The key's row is still there with a code that does not count. */
  codeChange: Array<{ itemId: string; reason: string }>;
  /** More than one row for one key: admin review, "PowerSchool has 2 marks for this period". */
  collisions: Array<{ key: string; psRowIds: string[] }>;
  /** Not in a CONFIRMED read: a candidate for removal, pending a direct id read. */
  missing: Array<{ itemId: string; psRowIds: string[] }>;
  /**
   * New tardy keys seen in a T-ONLY read. A T-only read has none of the
   * day's other marks, so it cannot say whether the student arrived late;
   * the date needs a full confirmed read before these are classified.
   */
  needFullRead: string[];
};

/**
 * One date's read against the tardies already stored for it.
 *
 * THE KEY IS (student, date, period). Keying on PowerSchool's row id would
 * make one tardy serve twice: a mark deleted and entered again gets a new
 * id, so it would be "removed" from today's list and "entered late" on
 * tomorrow's. The row id is kept as an attribute, and the SAME id seen under
 * a different period is a move, not a new tardy.
 *
 * MISSING IS NOT REMOVED. A row missing from a read is only a candidate, and
 * only a CONFIRMED read (two matching reads) can even nominate it; the
 * removal itself needs a direct `id==` read as well (removalVerdict).
 * `fullRead` false (a T-only read) cannot see code changes, because the
 * changed row is filtered out; there a T->D row simply goes missing.
 */
export function reconcileDate(input: {
  date: string; candidates: TardyCandidate[]; rows: AttRow[]; codes: Extract<CodeBook, { ok: true }>;
  items: TardyItem[]; confirmed: boolean; fullRead: boolean; settings: ReflectionSettings;
}): Reconcile {
  const out: Reconcile = { add: [], repoint: [], move: [], codeChange: [], collisions: [], missing: [], needFullRead: [] };
  const counted = countedCodes(input.settings);
  const listed = (r: AttRow) => {
    const slot = slotOfPeriodId(r.periodId);
    return slot !== null && listableSlot(slot, input.settings) && counted.includes(input.codes.byId[r.codeId]?.code ?? "");
  };
  const rowsByKey = new Map<string, AttRow[]>();
  const rowById = new Map<string, AttRow>();
  for (const r of input.rows) {
    if (r.attDate !== input.date) continue;
    const k = tardyKey(r.studentNumber, r.attDate, r.periodId);
    if (!rowsByKey.has(k)) rowsByKey.set(k, []);
    rowsByKey.get(k)!.push(r);
    rowById.set(r.id, r);
  }
  const candByKey = new Map(input.candidates.map((c) => [c.key, c]));
  const itemByKey = new Map(input.items.filter((i) => i.attDate === input.date).map((i) => [tardyKey(i.studentNumber, i.attDate, i.periodId), i]));
  const handledKeys = new Set<string>();

  for (const [k, item] of itemByKey) {
    const rows = rowsByKey.get(k) ?? [];
    if (rows.length > 1) {
      out.collisions.push({ key: k, psRowIds: rows.map((r) => r.id).sort() });
      handledKeys.add(k);
      continue;
    }
    if (rows.length === 1) {
      handledKeys.add(k);
      const r = rows[0];
      const code = input.codes.byId[r.codeId];
      if (code) {
        const v = codeChangeVerdict(code, input.settings);
        if (v.clear) { out.codeChange.push({ itemId: item.id, reason: v.reason }); continue; }
      }
      if (!item.psRowIds.includes(r.id)) out.repoint.push({ itemId: item.id, psRowIds: [r.id] });
      continue;
    }
    // Not under its own key. The same row id under another period, still a
    // tardy, is a move. (Moved to a slot that is never listed, it is not a
    // move: it goes missing, and the direct id read says why.)
    const moved = item.psRowIds.map((id) => rowById.get(id)).find((r) => r && r.studentNumber === item.studentNumber);
    if (moved && listed(moved)) {
      const toKey = tardyKey(moved.studentNumber, moved.attDate, moved.periodId);
      const slot = slotOfPeriodId(moved.periodId)!;
      if (!itemByKey.has(toKey) && (rowsByKey.get(toKey) ?? []).length === 1) {
        out.move.push({ itemId: item.id, toKey, periodId: moved.periodId, slot, psRowIds: [moved.id] });
        handledKeys.add(toKey);
        continue;
      }
    }
    if (input.confirmed) out.missing.push({ itemId: item.id, psRowIds: item.psRowIds.slice() });
  }
  for (const [k, rows] of rowsByKey) {
    if (handledKeys.has(k) || itemByKey.has(k) || !rows.some(listed)) continue;
    if (rows.length > 1) { out.collisions.push({ key: k, psRowIds: rows.map((r) => r.id).sort() }); continue; }
    if (!input.fullRead) { out.needFullRead.push(k); continue; }
    const c = candByKey.get(k);
    if (c) out.add.push(c);
  }
  return out;
}

/**
 * Was a tardy really removed in PowerSchool?
 *
 * BOTH must hold: a CONFIRMED read of its date does not contain its key, and
 * a direct `id==<psRowId>` read returns no row, or a row for a different
 * student, date or code. The closing read never removes anything: it only
 * adds, applies code changes and makes the list. A direct read that failed
 * proves nothing either way.
 */
export function removalVerdict(input: {
  readKind: string; confirmed: boolean; keyInRead: boolean;
  direct: { status: "none" } | { status: "error" }
    | { status: "row"; studentNumber: string; attDate: string; code: string; periodId: number };
  item: Pick<TardyItem, "studentNumber" | "attDate">; settings: Pick<ReflectionSettings, "countDitching" | "countPowerUpTardies">;
}): { remove: boolean; reason: string } {
  if (input.readKind === "closing" || input.readKind === "late-closing") return { remove: false, reason: "The closing read never removes." };
  if (!input.confirmed) return { remove: false, reason: "Only a confirmed read can show a mark is gone." };
  if (input.keyInRead) return { remove: false, reason: "Still in PowerSchool." };
  const d = input.direct;
  if (d.status === "error") return { remove: false, reason: "The direct check did not answer." };
  if (d.status === "none") return { remove: true, reason: "removed in PowerSchool" };
  if (d.studentNumber !== input.item.studentNumber || d.attDate !== input.item.attDate) return { remove: true, reason: "moved to another student or date in PowerSchool" };
  if (!countedCodes(input.settings).includes(d.code)) return { remove: true, reason: "no longer Tardy" };
  const slot = slotOfPeriodId(d.periodId);
  if (slot === null || !listableSlot(slot, input.settings)) {
    return { remove: true, reason: `moved to ${slot === null ? "a period the list does not know" : slotLabel(slot)}` };
  }
  return { remove: false, reason: "The direct check still finds the tardy." };
}

/** At most DIRECT_CHECK_CAP direct id reads per read; the rest wait for the next one. */
export function pickDirectChecks<T>(missing: T[], cap = DIRECT_CHECK_CAP): { now: T[]; later: T[] } {
  return { now: missing.slice(0, cap), later: missing.slice(cap) };
}

/**
 * A stored tardy, re-classified by a CONFIRMED FULL read of its date. Only
 * such a read may move a tardy between counted, held and arrival: a delete
 * plus an insert during one read could otherwise turn an arrival into a
 * counted tardy. Cleared, before-start and review items are left alone.
 *
 * On a list already made, the list record is never rewritten: the item
 * changes state, and the screen marks it "cleared after the list was made".
 * A tardy that becomes countable after its own list was made goes pending
 * and lands on the next list.
 */
export function reclassify(item: TardyItem, verdict: ArrivalVerdict, ctx: { confirmedFull: boolean }):
  { state: TardyState; reason: string | null; changed: boolean; afterList: boolean } {
  const keep = { state: item.state, reason: item.reason ?? null, changed: false, afterList: false };
  if (!ctx.confirmedFull) return keep;
  if (!["countable", "held", "arrival"].includes(item.state)) return keep;
  const state: TardyState = verdict.verdict === "counted" ? "countable" : verdict.verdict === "held" ? "held" : "arrival";
  if (state === item.state) return keep;
  return {
    state,
    reason: state === "arrival" ? "Arrived late to school" : state === "held" ? verdict.reason : null,
    changed: true,
    afterList: !!item.unitId,
  };
}

/** Every violation in a detention cleared: the detention is released ("release this student"). */
export function unitReleased(sourceStates: Array<{ cleared: boolean }>): boolean {
  return sourceStates.length > 0 && sourceStates.every((s) => s.cleared);
}

// ===========================================================================
// 3.6 The freeze: which list a violation goes on
// ===========================================================================

export type UniformItem = {
  id: string; studentNumber: string; day: string; at: string; voided: boolean;
  unitId?: string | null; reflectionState?: string | null; loaner?: boolean;
  savedAt?: string | null; observedAt?: string | null;
  /** When the server saved it (absent on rows from before 2026-10-08: savedAt, else at). */
  recordedAt?: string | null;
};

export type UnitState = "pending" | "listed" | "carried" | "queued-forward" | "released" | "review" | "expired" | "before-start";
export type UnitItem = {
  id: string; studentNumber: string; division: Division; kind: "new" | "carry" | "queued";
  state: UnitState; serveDay?: string | null; recordedAt: string; carryCount: number; tags?: string[]; lines?: string[];
  /** The mode of the list it came from (a carry keeps its list's mode). */
  mode?: Mode;
  /** For a carry: the day of the list it carries from. */
  carriedFromDay?: string | null;
  /** For a carry: when the detention it carries was first made. Absent: recordedAt. */
  originAt?: string | null;
};

export type ListRow = {
  studentNumber: string;
  division: Division;
  mode: Mode;
  /** The detention served today: an existing unit id, or "new" (created by this freeze). */
  serve: string;
  /** Detentions owed beyond one: they move to the next list tagged "Queued: 2nd detention". */
  queued: string[];
  owes: number;
  /** The violations this freeze picked up, as ONE new detention (null when there were none). */
  newUnit: { tardyIds: string[]; uniformIds: string[]; lines: string[]; tags: string[] } | null;
  /** What the row shows: the served detention's violations and tags. */
  lines: string[];
  tags: string[];
};

/** The tag on a detention moved to the next list because the student already owes one. */
export const QUEUED_TAG = "Queued: 2nd detention";

export type ClaimResult = {
  rows: ListRow[];
  claimedTardyIds: string[];
  claimedUniformIds: string[];
  claimedUnitIds: string[];
  /** Students whose division is unknown (no roster row and no grade): reported, never guessed. */
  unplaced: string[];
  /**
   * Waiting, but from before the division started counting in its current
   * mode (claimParking): never listed. The freeze marks them before-start.
   */
  parked: { tardyIds: string[]; uniformIds: string[]; unitIds: string[] };
};

/**
 * Can D's freeze claim this tardy? Countable, not yet on a list, dated on or
 * before D -- and if dated D itself, from a slot BEFORE Power-Up. P5 and P6
 * (and Power-Up) happen after the list is made, so they never serve the day
 * they happened.
 */
export function tardyClaimable(t: TardyItem, day: string): boolean {
  if (t.state !== "countable" || t.unitId) return false;
  if (t.attDate > day) return false;
  if (t.attDate === day && !servesSameDay(t.slot)) return false;
  return true;
}

export function uniformClaimable(u: UniformItem, day: string): boolean {
  if (u.voided || u.unitId) return false;
  if (u.reflectionState === "review" || u.reflectionState === "before-start") return false;
  return u.day <= day;
}

/**
 * FROM BEFORE THE START, ASKED AGAIN AT THE MOMENT OF CLAIMING (review,
 * 2026-10-08). setMode parks what is waiting at the moment a division is
 * switched on, or goes from shadow to live -- but only what is waiting THEN.
 * Three things become claimable later and would have reached the first live
 * list: a pilot detention whose carry is decided after the switch (a shadow
 * carry), a Friday arrival that Monday's re-read of Friday turns into a
 * counted tardy, and a Friday uniform entry queued on a Chromebook that
 * reaches the server on Monday. So every freeze asks once more, item by item:
 *   - a tardy or uniform entry dated before its division's countFromDate is
 *     before-start (one of a division switched OFF is left alone: setMode
 *     decides when the division is switched on);
 *   - a waiting detention made under another mode than the division's now (a
 *     shadow carry once the division is live), or carried from a list dated
 *     before countFromDate, is before-start.
 * Such an item is never listed. The freeze marks it, so it stops waiting.
 */
export function beforeStartAtClaim(
  item: { date?: string | null; mode?: Mode; carriedFromDay?: string | null },
  division: Division | null | undefined, settings: ReflectionSettings,
): boolean {
  if (!division) return false;
  const mode = settings.modeByDivision[division];
  // Off: neither claimed nor parked -- left waiting for setMode to decide
  // when the division is switched on (admitState). Parked here, a uniform
  // entry still waiting when the OTHER division's list was made was lost.
  if (mode === "off") return false;
  if (item.mode && item.mode !== mode) return true;
  const from = settings.countFromDateByDivision[division];
  const date = item.date ?? item.carriedFromDay ?? null;
  return !!date && (!from || date < from);
}

/** "Tue 10/13" from a date key. */
export function dayLabel(dateKey: string): string {
  const d = new Date(dateKey + "T12:00:00Z");
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  return `${wd} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** "11:52" in the school's time, from an instant. */
export function clockText(iso: string, tz: string, ampm = false): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true })
    .formatToParts(new Date(t));
  const h = parts.find((p) => p.type === "hour")?.value ?? "";
  const m = parts.find((p) => p.type === "minute")?.value ?? "";
  const ap = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  return ampm ? `${h}:${m} ${ap}` : `${h}:${m}`;
}

/** "Mon 10/12: Tardy P5 (Lee)". Times and dates in LA. */
export function tardyLine(t: Pick<TardyItem, "attDate" | "slot" | "classTeacher">): string {
  const who = t.classTeacher ? ` (${t.classTeacher})` : "";
  return `${dayLabel(t.attDate)}: Tardy ${slotLabel(t.slot)}${who}`;
}
export function uniformLine(u: Pick<UniformItem, "day" | "at" | "loaner">, tz: string): string {
  return `${dayLabel(u.day)}: Uniform ${clockText(u.at, tz, true)}${u.loaner ? " (loaner)" : ""}`;
}

/** When a tardy began to count: the later of first seen and (last) became countable. */
function countsSince(t: Pick<TardyItem, "firstSeenAt" | "firstCountableAt">): number {
  return Math.max(Date.parse(t.firstSeenAt), t.firstCountableAt ? Date.parse(t.firstCountableAt) : 0);
}

/** The tags a tardy brings to its row (3.6), from what happened to its own date. */
export function tardyTags(t: TardyItem, serveDay: string, days: Record<string, DayState>, tz: string): string[] {
  const tags: string[] = [];
  const own = days[t.attDate];
  const when = `${dayLabel(t.attDate)} ${slotLabel(t.slot)}`;
  if (!servesSameDay(t.slot) && t.attDate < serveDay) tags.push(`From ${when} (after Power-Up)`);
  if (servesSameDay(t.slot) && t.attDate < serveDay && own) {
    const fallbackAt = own.freezeKind === "fallback" && own.frozenAt ? Date.parse(own.frozenAt) : null;
    const found = `Found after the list was made (PowerSchool unreadable at close, ${dayLabel(t.attDate)})`;
    if (own.noList) tags.push(`List not made ${dayLabel(t.attDate)}`);
    else if (fallbackAt !== null && Date.parse(t.firstSeenAt) > fallbackAt) {
      tags.push(found);
    } else if (own.frozenAt && t.heldReleasedAt && Date.parse(t.heldReleasedAt) > Date.parse(own.frozenAt)) {
      // HELD is judged by when the HOLD was released, never by "was ever
      // held" (third review, 2026-10-08): a hold released before the list,
      // then an arrival at the close and counted again after it, missed the
      // list as an arrival -- "Entered late", below.
      tags.push(`Held for attendance (${when})`);
    } else if (fallbackAt !== null && countsSince(t) > fallbackAt) {
      // A FALLBACK DAY has no closing read to be late for (third review,
      // 2026-10-08): seen before the list but counting only after it (an
      // arrival re-judged), it was found after the list all the same.
      tags.push(found);
    } else if (own.closingReadStartedAt && countsSince(t) > Date.parse(own.closingReadStartedAt)) {
      // ENTERED LATE is judged by when it began to COUNT, not when it was
      // first seen (second review, 2026-10-08): an arrival re-judged as
      // counted, or a T changed to D before the close and back after it,
      // was seen before the closing read and still missed the list.
      tags.push(`Entered late in PowerSchool (${when})`);
    }
  }
  return tags;
}

export function uniformTags(u: UniformItem, serveDay: string, days: Record<string, DayState>, tz: string): string[] {
  const tags: string[] = [];
  const own = days[u.day];
  // Judged by when it was SAVED (third review, 2026-10-08): a list claims
  // what was saved before it was made. Seen at 11:40 and saved at 11:50 (a
  // queued send), an entry misses the 11:45 list though `at` is before it.
  // The time shown is when it was seen if that is after the list, else when
  // it was saved.
  const saved = u.recordedAt ?? u.savedAt ?? u.at;
  if (u.day < serveDay && own?.noList) tags.push(`List not made ${dayLabel(u.day)}`);
  else if (own?.frozenAt && Date.parse(saved) >= Date.parse(own.frozenAt)) {
    const shown = Date.parse(u.at) >= Date.parse(own.frozenAt) ? u.at : saved;
    tags.push(`Uniform logged after the list closed (${dayLabel(u.day)} ${clockText(shown, tz)})`);
  }
  if (u.savedAt) tags.push(`Saved late (observed ${dayLabel(u.day).split(" ")[0]} ${clockText(u.at, tz)})`);
  return tags;
}

/**
 * THE FREEZE CLAIMS, in one transaction, everything countable and not yet on
 * a list as of the moment it commits: tardies dated on or before D (P5/P6 of
 * D excepted), live uniform entries dated on or before D, and pending carries
 * and queued detentions. Anything recorded after it commits is claimed by the
 * next school day's freeze. Nothing is assigned ahead of time, so nothing can
 * be missed or listed twice.
 *
 * ONE DETENTION PER LIST (owner, 10/8): everything a student's new
 * violations bring onto one list is one detention, one row, every date
 * shown. A student can still owe two on one list -- a carried detention plus
 * new violations: the row says "Owes 2", the OLDEST is served, and the rest
 * move to the next list tagged "Queued: 2nd detention" (queued moves do not
 * count toward the carry limit).
 */
export function claimAtFreeze(input: {
  day: string; tz: string; settings: ReflectionSettings;
  divisionOf: Record<string, Division | null | undefined>;
  tardies: TardyItem[]; uniforms: UniformItem[]; units: UnitItem[];
  days: Record<string, DayState>;
}): ClaimResult {
  const { day, tz, settings } = input;
  const per = new Map<string, { tardies: TardyItem[]; uniforms: UniformItem[]; units: UnitItem[] }>();
  const slot = (sn: string) => {
    if (!per.has(sn)) per.set(sn, { tardies: [], uniforms: [], units: [] });
    return per.get(sn)!;
  };
  const parked: ClaimResult["parked"] = { tardyIds: [], uniformIds: [], unitIds: [] };
  for (const t of input.tardies) {
    if (!tardyClaimable(t, day)) continue;
    if (beforeStartAtClaim({ date: t.attDate }, input.divisionOf[t.studentNumber], settings)) parked.tardyIds.push(t.id);
    else slot(t.studentNumber).tardies.push(t);
  }
  for (const u of input.uniforms) {
    if (!uniformClaimable(u, day)) continue;
    if (beforeStartAtClaim({ date: u.day }, input.divisionOf[u.studentNumber], settings)) parked.uniformIds.push(u.id);
    else slot(u.studentNumber).uniforms.push(u);
  }
  for (const u of input.units) {
    if (u.state !== "pending" || u.serveDay) continue;
    if (beforeStartAtClaim({ mode: u.mode, carriedFromDay: u.carriedFromDay }, u.division, settings)) parked.unitIds.push(u.id);
    else slot(u.studentNumber).units.push(u);
  }

  const out: ClaimResult = { rows: [], claimedTardyIds: [], claimedUniformIds: [], claimedUnitIds: [], unplaced: [], parked };
  for (const [sn, got] of [...per.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const division = got.units[0]?.division ?? input.divisionOf[sn] ?? null;
    if (!division) { out.unplaced.push(sn); continue; }
    const mode = settings.modeByDivision[division];
    if (mode === "off") continue;
    const when = (t: TardyItem) => t.attDate + String(orderOf(t.slot)).padStart(2, "0");
    const tardies = got.tardies.slice().sort((a, b) => when(a).localeCompare(when(b)));
    const uniforms = got.uniforms.slice().sort((a, b) => a.at.localeCompare(b.at));
    // THE OLDEST IS SERVED (spec 2.4) -- by the age of the detention each
    // stands for (third review, 2026-10-08). A carry is recorded when it is
    // decided, after the queued detention the same day's list made, though
    // it carries an older one: ordered by recordedAt, the queued one was
    // served first and the older carry pushed back again.
    const age = (u: UnitItem) => u.originAt ?? u.recordedAt;
    const units = got.units.slice().sort((a, b) => age(a).localeCompare(age(b)) || a.recordedAt.localeCompare(b.recordedAt));
    const hasNew = tardies.length > 0 || uniforms.length > 0;
    const owed = [...units.map((u) => u.id), ...(hasNew ? ["new"] : [])];
    if (!owed.length) continue;
    const newLines = [
      ...tardies.map((t) => ({ k: t.attDate + "0" + when(t).slice(10), line: tardyLine(t) })),
      ...uniforms.map((u) => ({ k: u.day + "1" + u.at, line: uniformLine(u, tz) })),
    ].sort((a, b) => a.k.localeCompare(b.k)).map((x) => x.line);
    const newTags = [
      ...tardies.flatMap((t) => tardyTags(t, day, input.days, tz)),
      ...uniforms.flatMap((u) => uniformTags(u, day, input.days, tz)),
    ];
    const serve = owed[0];
    const served = units.find((u) => u.id === serve);
    const tags = served ? [...(served.tags ?? [])] : newTags;
    if (owed.length > 1) tags.push(`Owes ${owed.length}`);
    out.rows.push({
      studentNumber: sn,
      division,
      mode,
      serve,
      queued: owed.slice(1),
      owes: owed.length,
      newUnit: hasNew
        ? { tardyIds: tardies.map((t) => t.id), uniformIds: uniforms.map((u) => u.id), lines: newLines, tags: [...new Set(newTags)] }
        : null,
      lines: served ? (served.lines ?? []) : newLines,
      tags: [...new Set(tags)],
    });
    out.claimedTardyIds.push(...tardies.map((t) => t.id));
    out.claimedUniformIds.push(...uniforms.map((u) => u.id));
    out.claimedUnitIds.push(...units.map((u) => u.id));
  }
  return out;
}

// ===========================================================================
// 3.8 Room attendance, absence at Power-Up and carry-over
// ===========================================================================

export type CarryVerdict =
  | { verdict: "carry"; basis: "room" | "powerschool" | "whole-day" | "room-closed"; tag: string; countsTowardLimit: boolean }
  | { verdict: "served"; basis: "room" | "powerschool" | "whole-day"; why: string }
  | { verdict: "review"; reason: string }
  | { verdict: "undecided"; why: string };

/** Absent-status mark in this slot, or not (no row, once marks are final, is present). */
function absentIn(summary: DaySummary, sn: string, slot: number): boolean {
  const marks = summary.marks[sn]?.[String(slot)] ?? [];
  return marks.length > 0 && marks.every((m) => m.absent);
}

/** The student's own class slots that met today, in the day's order. */
function ownMetSlots(summary: DaySummary, snap: RosterSnap): number[] {
  const enrolled = new Set(snap.enrolledSlots ?? []);
  return SLOT_ORDER.filter((s) => enrolled.has(s) && slotMet(summary, s));
}

/**
 * The slots the whole-day test can read: the student's own, met today, and
 * whose section TOOK attendance. A section with no marks at all says nothing
 * about anyone in it -- that is exactly the Power-Up section that sends a
 * detention to this test -- so counting its "no row" as present would mean
 * the test could never carry.
 */
function wholeDaySlots(summary: DaySummary, snap: RosterSnap): number[] {
  return ownMetSlots(summary, snap).filter((s) => {
    const section = snap.sectionBySlot?.[String(s)];
    return !section || sectionHasMarks(summary, s, section);
  });
}

/**
 * Does a detention listed for D carry to the next list? The first rule that
 * applies wins.
 *
 *  1. ROOM CLOSED: "Room did not run today" was pressed. Everything on D's
 *     list carries, tagged "room closed", and the carry does not count
 *     toward the limit -- the student did nothing wrong.
 *  2. ROOM ATTENDANCE RECORDED: "Attendance done" was pressed. Exactly the
 *     rows ticked Not here carry; an unticked row was served, whatever its
 *     Power-Up mark says. A student at school who did not come carries like
 *     an absent one (owner, 10/8).
 *  3. NOTHING RECORDED BY THE AFTER-SCHOOL READ: PowerSchool decides (and
 *     always in shadow mode, where no room runs). A pulled student is
 *     usually marked ABSENT by the Power-Up teacher, so "absent at Power-Up"
 *     alone would make the very students who served carry and serve twice
 *     (review A1/B1). So the detention carries only when the Power-Up mark is
 *     Absent AND the student was not present both in the last class before
 *     Power-Up and the first class after it. Measured on history: 38 listed
 *     student-days were absent at Power-Up; this carries 36 and never carries
 *     a student who was in class on both sides, which is exactly a pulled
 *     student.
 *
 * Then the limit: the carry after `maxCarries` goes to review, and a
 * student no longer enrolled goes to review as "left school".
 *
 * (RSP, ELD and 7002A students are pulled like everyone else since the
 * owner's answer of 10/8, so they carry like everyone else too.)
 */
export function carryVerdict(input: {
  unit: Pick<UnitItem, "carryCount">;
  studentNumber: string;
  division: Division;
  serveDay: string;
  room: { closed?: boolean; attendanceDone?: boolean; notHere?: boolean };
  /** The after-school read has happened: PowerSchool's marks are final for D. */
  final: boolean;
  summary: DaySummary | null;
  snap: RosterSnap | null;
  enrolled: boolean;
  maxCarries: number;
}): CarryVerdict {
  const from = dayLabel(input.serveDay);
  const limit = (v: CarryVerdict): CarryVerdict => {
    if (v.verdict !== "carry") return v;
    if (!input.enrolled) return { verdict: "review", reason: "Left school" };
    if (v.countsTowardLimit && input.unit.carryCount >= input.maxCarries) {
      return { verdict: "review", reason: `Carried ${input.unit.carryCount} times` };
    }
    return v;
  };
  if (input.room.closed) {
    return limit({ verdict: "carry", basis: "room-closed", tag: `Carried over from ${from} (room closed)`, countsTowardLimit: false });
  }
  const summary = input.summary;
  const snap = input.snap;
  const puSlot = snap?.puSlot ?? POWER_UP_SLOT[input.division];
  if (input.room.attendanceDone) {
    if (!input.room.notHere) return { verdict: "served", basis: "room", why: "In the room (not ticked Not here)." };
    // The tag says why, as far as PowerSchool can tell: absent at Power-Up,
    // or at school and did not come (a Power-Up mark that is not Absent, or
    // no row in a section that took attendance). Otherwise just "not in the room".
    let why = "not in the room";
    if (summary && snap?.puSlot) {
      const marks = summary.marks[input.studentNumber]?.[String(snap.puSlot)] ?? [];
      if (marks.length) why = marks.every((m) => m.absent) ? "absent" : "at school: did not come";
      else if (sectionHasMarks(summary, snap.puSlot, snap.puSectionId)) why = "at school: did not come";
    }
    return limit({ verdict: "carry", basis: "room", tag: `Carried over from ${from} (${why})`, countsTowardLimit: true });
  }
  if (!input.final || !summary) return { verdict: "undecided", why: "Waiting for room attendance or the after-school read." };

  // The PowerSchool fallback.
  if (!slotMet(summary, puSlot)) return { verdict: "review", reason: "Power-Up did not meet: was the room run?" };
  if (!snap || !(snap.enrolledSlots ?? []).length) return { verdict: "review", reason: "Attendance unknown at Power-Up" };
  const carryTag = `Carried over from ${from} (absent)`;
  const wholeDay = (): CarryVerdict => {
    const mine = wholeDaySlots(summary, snap);
    if (!mine.length) return { verdict: "review", reason: "Attendance unknown at Power-Up" };
    return mine.every((s) => absentIn(summary, input.studentNumber, s))
      ? limit({ verdict: "carry", basis: "whole-day", tag: carryTag, countsTowardLimit: true })
      : { verdict: "served", basis: "whole-day", why: "In school today." };
  };
  if (!snap.puSlot || !snap.puSectionId) return wholeDay();
  if (!sectionHasMarks(summary, snap.puSlot, snap.puSectionId)) return wholeDay();

  const puAbsent = absentIn(summary, input.studentNumber, snap.puSlot);
  const mine = ownMetSlots(summary, snap);
  const before = mine.filter((s) => orderOf(s) < orderOf(snap.puSlot!) && CLASS_SLOTS.includes(s)).pop();
  const after = mine.find((s) => orderOf(s) > orderOf(snap.puSlot!) && CLASS_SLOTS.includes(s));
  // A missing side counts as not present.
  const presentBefore = before !== undefined && !absentIn(summary, input.studentNumber, before);
  const presentAfter = after !== undefined && !absentIn(summary, input.studentNumber, after);
  if (puAbsent && !(presentBefore && presentAfter)) {
    return limit({ verdict: "carry", basis: "powerschool", tag: carryTag, countsTowardLimit: true });
  }
  return { verdict: "served", basis: "powerschool", why: puAbsent ? "In class before and after Power-Up." : "Present at Power-Up." };
}

/**
 * WHICH CLASS PERIOD COMES RIGHT BEFORE LUNCH & POWER UP on day D (owner,
 * 2026-10-09: an MS student is pulled from it a couple of minutes before
 * lunch begins). Read off the seeded bell schedules (SEEDED_SCHEDULES), never
 * guessed from the slot order alone, because it is a different period on
 * different days: P3 (slot 4) on a regular Monday or Thursday, P4 (slot 5)
 * on a regular Tuesday or Friday, and P4 on a Wednesday, a Minimum Day, a
 * Stack Day and a six-period day the list detected (treated as Minimum).
 *
 *   1. A day marked in Settings > Bell Schedule with one of the seeded
 *      schedules: that schedule, by name -- so a Monday marked with the
 *      Tue/Fri schedule says P4.
 *   2. Otherwise the seeded schedules of the day's type (the type the list
 *      already uses for its times, scheduleKindFor): the one that runs on
 *      D's weekday, or, if none does, the one answer they all agree on.
 *   3. Otherwise null: the list says the class was not found and to check
 *      PowerSchool, rather than guess (a regular-type day marked with a
 *      schedule of the office's own, on a weekday no regular schedule runs).
 */
export function beforeLunchSlot(input: { date: string; kind: ScheduleKind; marked?: Marked }):
  { slot: number; period: string; schedule: string } | null {
  const pick = (s: (typeof SEEDED_SCHEDULES)[number]) => {
    const slot = s.lastPeriodBeforeLunch + 1;
    return { slot, period: slotLabel(slot), schedule: s.name };
  };
  const named = input.marked?.scheduleId
    ? SEEDED_SCHEDULES.find((s) => s.name === String(input.marked?.scheduleName ?? "").trim()) : undefined;
  if (named) return pick(named);
  const ofKind = SEEDED_SCHEDULES.filter((s) => s.kind === input.kind);
  const today = ofKind.find((s) => s.weekdays.includes(weekdayOf(input.date)));
  if (today) return pick(today);
  const answers = [...new Set(ofKind.map((s) => s.lastPeriodBeforeLunch))];
  return answers.length === 1 ? pick(ofKind[0]) : null;
}

/** What the list says when it cannot name the class before lunch. Never a blank, never a guess. */
export const LUNCH_NOT_FOUND = "Class before lunch not found — check PowerSchool";

/**
 * AN MS STUDENT'S CLASS BEFORE LUNCH on day D, from the roster snapshot:
 * the period, the teacher, the course and the RSP/ELD/7002A flag of their
 * section in that slot. `problem` instead, never a guess, when:
 *   - the day's period is not known, or the student has no section in it
 *     (or no roster row at all): LUNCH_NOT_FOUND;
 *   - the student has two sections in it: "Check PowerSchool: 2 classes in
 *     P3", with neither teacher named.
 * A snapshot taken before 10/9 knows only each slot's section and teacher
 * (no course, and not whether there are two); the next opening read takes a
 * whole one.
 */
export type LunchClass = {
  slot: number | null; period: string | null; sectionId: string | null;
  teacher: string | null; course: string | null; flag: string | null; problem: string | null;
};
export function lunchClassOf(snap: RosterSnap | null | undefined, at: { slot: number; period: string } | null): LunchClass {
  const none = { sectionId: null, teacher: null, course: null, flag: null };
  if (!at) return { slot: null, period: null, ...none, problem: LUNCH_NOT_FOUND };
  const k = String(at.slot);
  const base = { slot: at.slot, period: at.period };
  if (!snap) return { ...base, ...none, problem: LUNCH_NOT_FOUND };
  if (snap.classBySlot) {
    const c = snap.classBySlot[k];
    if (!c) return { ...base, ...none, problem: LUNCH_NOT_FOUND };
    if (c.sections > 1) return { ...base, ...none, problem: `Check PowerSchool: ${c.sections} classes in ${at.period}` };
    return { ...base, sectionId: c.sectionId, teacher: c.teacher, course: c.course, flag: c.flag, problem: null };
  }
  const sectionId = snap.sectionBySlot?.[k] ?? null;
  if (!sectionId) return { ...base, ...none, problem: LUNCH_NOT_FOUND };
  return { ...base, sectionId, teacher: snap.teacherBySlot?.[k] ?? null, course: null, flag: null, problem: null };
}

/**
 * WHEN THE ROOM'S OWN ATTENDANCE MAY BE TAKEN for the list of day D (build
 * spec 3.8, step 8b): a Not here tick and "Attendance done" from Lunch &
 * Power-Up start on D -- nobody can be not-here before the room has run --
 * until the next list is made, because that freeze CLAIMS the carries, and
 * after that a tick would change a list already on paper. "Room did not run
 * today" may be pressed as soon as D's list is made (the room may be known to
 * be closed before lunch), until the same next freeze. A day with no list
 * has nothing to take attendance for.
 */
export function roomWindow(input: {
  nowIso: string; listMadeAt: string | null | undefined; powerUpMs: number | null; nextListMadeAt: string | null | undefined; tz: string;
}): { tick: boolean; closeRoom: boolean; why: string | null } {
  if (!input.listMadeAt) return { tick: false, closeRoom: false, why: "No list was made for this day." };
  if (input.nextListMadeAt) {
    return {
      tick: false, closeRoom: false,
      why: `The next list was made at ${clockText(input.nextListMadeAt, input.tz, true)} and has claimed this day's carries, so its room attendance is closed.`,
    };
  }
  const now = Date.parse(input.nowIso);
  if (input.powerUpMs !== null && now < input.powerUpMs) {
    return { tick: false, closeRoom: true, why: `Room attendance opens at Lunch & Power-Up (${clockText(new Date(input.powerUpMs).toISOString(), input.tz, true)}).` };
  }
  return { tick: true, closeRoom: true, why: null };
}

/**
 * WHEN A DIVISION IS PULLED on day D, as an instant: MS from the class
 * before lunch, its lead before the block start; HS at the swap minus its
 * lead (pullTimes). On the Los Angeles clock, whatever the season.
 */
export function pullInstant(dateKey: string, kind: ScheduleKind, division: Division, settings: ReflectionSettings, tz: string): string | null {
  const p = pullTimes(kind, settings);
  return laWallToUtc(dateKey, division === "ms" ? p.msMinute : p.hsMinute, tz);
}

/**
 * A TARDY THAT COUNTS AGAIN after its detention was released -- a mark
 * deleted and typed back, D changed back to T, a counted tardy re-judged an
 * arrival and then counted again: does it go back on that detention, or on
 * the next list? (review, 2026-10-08)
 *
 * BACK ON IT when the release came at or after the student's pull time on
 * the detention's day. The student was on the list when the room ran, so
 * they served it (or it carried); putting the same PowerSchool mark on the
 * next list would serve it twice, and spec 3.10 says a mark deleted and
 * entered again "is updated, not doubled". Released BEFORE the pull, the
 * student was told not to come, so the detention is still owed and the
 * tardy goes on the next list.
 */
export function rejoinsReleasedDetention(input: { releasedAt: string | null | undefined; pullAt: string | null }): boolean {
  if (!input.releasedAt || !input.pullAt) return false;
  return Date.parse(input.releasedAt) >= Date.parse(input.pullAt);
}

/** A scheduled read later than this is overdue, and the last-read banner turns red. */
export const READ_OVERDUE_MIN = 15;

/**
 * THE LAST-READ BANNER, judged against the reader's own schedule (review,
 * 2026-10-08). The reads run hourly in the morning (07:30, 08:30, 09:30,
 * 10:30), then 40 to 10 minutes before the close, at the close, and at 13:00,
 * 14:00, 15:00 and 15:45. A flat "older than 15 minutes" was red for most of
 * a healthy day -- all of 12:00 to 13:00, while the room supervisor uses the
 * screen -- so a real outage looked just like an ordinary 10:50, and staff
 * learn to ignore red. Now it is red only when a read that should have run
 * is more than 15 minutes overdue, or the latest read failed; otherwise it
 * is information, with the time of the next read. School hours only.
 */
export function lastReadBanner(input: {
  nowIso: string; tz: string; date: string; closeMinute: number;
  lastGoodReadAt: string | null | undefined; lastReadErrorAt: string | null | undefined;
}): { level: "alert" | "info"; text: string } | null {
  const lt = wallClock(input.nowIso, input.tz);
  if (!lt.ok || lt.dateKey !== input.date) return null;
  const minute = lt.minuteOfDay;
  if (minute < OPENING_MINUTE || minute > AFTER_SCHOOL_MINUTE) return null;
  const minutes = [...new Set([...scheduleItems(input.closeMinute).map((i) => i.minute), input.closeMinute])].sort((a, b) => a - b);
  const due = minutes.filter((m) => m <= minute - READ_OVERDUE_MIN).pop();
  const dueAt = due === undefined ? null : laWallToUtc(input.date, due, input.tz);
  const last = input.lastGoodReadAt ?? null;
  const failed = !!input.lastReadErrorAt && (!last || Date.parse(input.lastReadErrorAt) > Date.parse(last));
  const overdue = !!dueAt && (!last || Date.parse(last) < Date.parse(dueAt));
  const next = minutes.find((m) => m > minute);
  const nextAt = next === undefined ? null : laWallToUtc(input.date, next, input.tz);
  const nextText = nextAt ? ` Next read ${clockText(nextAt, input.tz)}.` : "";
  if (!last) {
    return failed || overdue
      ? { level: "alert", text: "No PowerSchool read has worked yet today." }
      : { level: "info", text: `No PowerSchool read yet today.${nextText}` };
  }
  const lastText = `Last good PowerSchool read ${clockText(last, input.tz)}`;
  if (failed) return { level: "alert", text: `${lastText}: the latest read failed.` };
  if (overdue) return { level: "alert", text: `${lastText}: the ${clockText(dueAt!, input.tz)} read is overdue.` };
  return { level: "info", text: `${lastText}.${nextText}` };
}

/**
 * In live mode, a day whose carries PowerSchool had to decide (the room
 * recorded nothing) also raises one day-level review item, so somebody
 * notices the room is not taking attendance.
 */
export function fallbackDayReview(input: {
  mode: Mode; serveDay: string; attendanceDone: boolean; roomClosed: boolean; decidedByPowerSchool: number;
}): { reason: string } | null {
  if (input.mode !== "live" || input.attendanceDone || input.roomClosed || input.decidedByPowerSchool < 1) return null;
  return {
    reason: `Room attendance not recorded ${dayLabel(input.serveDay)} (${input.decidedByPowerSchool} `
      + `detention${input.decidedByPowerSchool === 1 ? "" : "s"} decided from PowerSchool)`,
  };
}

/** The carried detention, pending for the next list. It keeps its violations and gains a carry. */
export function carriedUnit(unit: UnitItem, verdict: Extract<CarryVerdict, { verdict: "carry" }>, recordedAt: string): Omit<UnitItem, "id"> {
  return {
    studentNumber: unit.studentNumber,
    division: unit.division,
    kind: "carry",
    state: "pending",
    serveDay: null,
    recordedAt,
    carryCount: unit.carryCount + (verdict.countsTowardLimit ? 1 : 0),
    tags: [verdict.tag],
    lines: unit.lines ?? [],
  };
}

// ===========================================================================
// Banners
// ===========================================================================

/** The next weekday not marked noSchool: where "No list today" says the violations will go. */
export function nextSchoolDayGuess(date: string, noSchool: Set<string> | string[]): string {
  const off = noSchool instanceof Set ? noSchool : new Set(noSchool);
  let d = addDays(date, 1);
  for (let i = 0; i < 60; i++, d = addDays(d, 1)) {
    const wd = weekdayOf(d);
    if (wd !== 0 && wd !== 6 && !off.has(d)) return d;
  }
  return d;
}

export function noListBanner(day: DayState, nextDay: string, tz: string): string {
  const last = day.noList ? day.noList.lastGoodReadAt ?? null : day.lastGoodReadAt ?? null;
  const since = last ? `since ${clockText(last, tz)}` : "all morning";
  return `No list today: PowerSchool unreachable ${since}. Today's violations will be on ${dayLabel(nextDay)}'s list.`;
}

export function freezeBanner(day: DayState, tz: string): string | null {
  if (!day.frozenAt) return null;
  if (day.freezeKind === "fallback") {
    const last = day.lastGoodReadAt ? ` (last good read ${clockText(day.lastGoodReadAt, tz)})` : " (no PowerSchool read worked today)";
    return `Made at ${clockText(day.frozenAt, tz)} without a final PowerSchool read${last}.`;
  }
  if (day.freezeKind === "late") return `Made late at ${clockText(day.frozenAt, tz)}. Check the time before pulling.`;
  return null;
}
