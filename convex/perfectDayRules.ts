/**
 * THE AUTOMATIC PERFECT-DAY AWARD: every rule, pure. (Build spec 2026-10-12.)
 *
 * Each school morning a server job (perfectDay.ts, perfectDayRead.ts) reads
 * the last school days straight from PowerSchool, works out which students
 * had a PERFECT DAY, records each one in a register, and once a week pays
 * every student one Wildcat Cash movement for that week's perfect days. This
 * file decides everything; those two only gather facts and write what this
 * decides, so every decision below is tested without a database.
 *
 * THE OWNER'S RULE (rule A, 10/12). Every block counts: Promise Time AM and
 * PM, Periods 1-6 and Power-Up. A day is broken by any absence, excused ones
 * included (A, X, I, P), an unexcused tardy (T), ditching (K) and ANY CODE
 * THIS FILE DOES NOT KNOW. It is not broken by Present (a blank code), an
 * excused tardy (D) or a field trip (F). The rule is the list of codes that
 * do NOT break the day, so a code the office adds later breaks it until
 * somebody decides otherwise. $100 a day by default; the amount is a server
 * setting checked here.
 *
 * NO BACK-PAY, EVER (review H2). Nothing before `countFromDate` is decided;
 * every switch from off to on moves it to the day of the switch; and a day is
 * stamped payable or not WHEN IT IS FIRST DECIDED, and that stamp is final.
 * Shadow days, days outside the pilot, days of a control and days of a pause
 * are stamped unpayable or never decided, so no later switch pays them.
 *
 * AND NO SWITCH TAKES BACK WHAT WAS EARNED (2026-10-12 review). A day stamped
 * payable was earned and shown to the student as pending. Payday does NOT
 * re-apply today's start dates to it: a pause (off, then on again), a move
 * from live to pilot, or a pilot student taken out of the pilot never forfeits
 * it. It waits while no money moves (off, shadow) or while the student is a
 * control, and is paid on the next payday after. Cancelling pending days is a
 * decision of its own (perfectDay:forfeitPending, removeDays), never a side
 * effect of the switch. Nor does a switch stop the RE-READ of days already
 * decided: countFromDate fences which days are decided, never which are
 * settled, so a break entered during a pause is applied before payday.
 *
 * NAMES NEVER APPEAR HERE. Student numbers and counts only.
 */

import { MAX_CASH_DELTA, SYSTEM_CASH_KIND } from "./appDataShape";
import { schoolOf } from "./cashAwardRules";
import { localSchoolTime } from "./scheduleRules";

// ===========================================================================
// Keys, names and constants
// ===========================================================================

/** appState: the switch and its settings. Absent means OFF. */
export const SETTINGS_KEY = "perfectDayAward";
/** appState: { lastDoneDate, lastPayWeek, lastRunId }. */
export const STATE_KEY = "perfectDay:state";
/** appState: one run at a time, { runId, startedAt, expiresAt }. */
export const LEASE_KEY = "perfectDay:lease";

/** The reserved behaviour id. appDataShape.isSystemCashRow refuses it from every browser path. */
export const PERFECT_DAY_BEHAVIOR_ID = "system:perfect-day";
/** The reserved kind: every staff analytic leaves it out (script.js isCashBehaviourRow). */
export const PERFECT_DAY_KIND = SYSTEM_CASH_KIND;
/** Who the wallet says gave it. Never a teachers row, so no staff table ever lists it. */
export const SYSTEM_ACTOR = { id: "system:attendance", name: "Wildcat Hub (attendance)" } as const;

export const DEFAULT_AMOUNT = 100;
/** Per perfect day. A week's movement is split at $5,000, so this bound is about sense, not the cap. */
export const MAX_AMOUNT = 1000;
/**
 * School days re-read every run (late marks). Fifteen, not ten: Promise Time
 * PM for 8/28 was bulk-entered about 9/9-9/16, 7 to 12 school days late, and
 * a day held for a block not entered yet expires unpaid once it leaves this.
 */
export const DEFAULT_LOOKBACK = 15;
/** How far back, in calendar days, the run looks for those school days. */
export const CALENDAR_REACH_DAYS = 28;

/**
 * THE MORNING WINDOW, Los Angeles wall clock. The cron fires at :42 past
 * 14-17 UTC; whatever the hour it fires at, the job only acts between 06:30
 * and 11:00 school time, on a weekday. That is 06:42-09:42 in winter and
 * 07:42-10:42 in summer: after the 13:30 UTC attendance rebuild either way,
 * and never in the Reflection Room's 11:15-12:05.
 */
export const MORNING_FROM = 6 * 60 + 30;
export const MORNING_TO = 11 * 60;
/** On a payday Monday, a retried read of last week is waited for until 09:30, then what is settled is paid. */
export const PAY_WAIT_UNTIL = 9 * 60 + 30;

/** An action cannot outlive Convex's 10 minutes, so neither can its lease. */
export const LEASE_MS = 10 * 60 * 1000;
/** PowerSchool reads stop here, leaving the rest of the 10 minutes for the writes. */
export const READ_BUDGET_MS = 5 * 60 * 1000;
/** Students paid per mutation: each one rewrites a whole student row, history included. */
export const PAY_BATCH = 50;

/** THE RULE: the codes that do not break a day. Everything else does. */
export const NOT_BREAKING = new Set(["", "D", "F"]);
/** The codes the school has that do break it (for the counts; any other code is "unknown"). */
export const KNOWN_BREAKING = new Set(["A", "X", "I", "P", "T", "K"]);

/** More than this share of a day's rows outside periods 1-10 and the read is not believed. */
export const UNPLACEABLE_MAX = 0.01;
/** Fewer students with any mark than this share of the usual, and the day looks too perfect to be true. */
export const TOO_PERFECT_RATIO = 0.5;
/** A slot that usually has at least SLOT_MIN_USUAL rows and today has under a quarter of them is incomplete. */
export const SLOT_INCOMPLETE_RATIO = 0.25;
export const SLOT_MIN_USUAL = 20;
/** Reference days needed before "the usual" means anything. */
export const MIN_REFERENCE_DAYS = 3;
/**
 * THE SECOND CHECK HOLDS STUDENTS, NOT THE SCHOOL (review H1). A student the
 * Perfect Attendance screen disagrees about is held on their own. Only when
 * more than this share of the enrolled disagree (at least two students) is
 * the whole date held, because then something is wrong with a source.
 */
export const DISAGREE_DAY_MAX = 0.01;

/** A perfect student held only because the second check could not run. Never expired: an admin releases it (releaseUnchecked). */
export const UNCHECKED = "second-check-unavailable";
/**
 * A day already decided for a student whose CURRENT PowerSchool enrolment
 * starts after it, with no class record on the day either. PowerSchool's
 * students row holds the current span only, so a student who left and came
 * back reads as not enrolled on the days of the earlier span: that is a
 * question for an admin, never a break.
 */
export const ENROLMENT_UNCONFIRMED = "enrolment-unconfirmed";

/** Is there a school day here? The Reflection Room's rule: slot 1 alone, or enough rows across slots. */
export const EVIDENCE_SLOT1_ROWS = 20;
export const EVIDENCE_TOTAL_ROWS = 60;
export const EVIDENCE_MIN_SLOTS = 2;

// ===========================================================================
// Dates
// ===========================================================================

export const isDay = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
export const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
/** 0 Sunday .. 6 Saturday, from the date itself. */
export const weekdayOf = (d: string): number => new Date(d + "T12:00:00Z").getUTCDay();
/** The Monday of the date's week. */
export function weekStartOf(d: string): string {
  const wd = weekdayOf(d);
  return addDays(d, -((wd + 6) % 7));
}
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Mon 10/12": how the wallet names a day. */
export function shortDay(d: string): string {
  return `${DAY_NAMES[weekdayOf(d)]} ${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
}
/** The school-time date of an instant, or null. */
export function schoolDateOf(iso: unknown, tz: string): string | null {
  if (typeof iso !== "string" || !iso) return null;
  const lt = localSchoolTime(iso, tz);
  return lt.ok ? lt.dateKey : null;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Days sharing a block pattern: Mon/Thu, Tue/Fri, Wed (measured 2026-09-21). */
export function patternOf(d: string): string {
  const wd = weekdayOf(d);
  return wd === 1 || wd === 4 ? "mon-thu" : wd === 2 || wd === 5 ? "tue-fri" : wd === 3 ? "wed" : "other";
}

// ===========================================================================
// The switch
// ===========================================================================

export type Mode = "off" | "shadow" | "pilot" | "live";
export const MODES: Mode[] = ["off", "shadow", "pilot", "live"];
export const paying = (m: Mode): boolean => m === "pilot" || m === "live";
export type PilotEntry = { sn: string; from: string };
export type Settings = {
  mode: Mode;
  amount: number;
  /** Nothing before it is decided or paid. Moved to the day of the switch at every switch from off to on. */
  countFromDate: string | null;
  /** The day the whole school became payable (live). Null unless live. */
  liveFrom: string | null;
  /** Pilot students, each payable from the day money started for them. */
  pilot: PilotEntry[];
  /** Students who must NOT be paid (the pilot's controls). Part of the pilot: cleared when the whole school goes live. */
  controls: string[];
  lookbackSchoolDays: number;
  /** One summary appAuditLog entry per payday. OFF until the browser registers the action (review M6). */
  auditSummary: boolean;
  /** Set when the stored row could not be read as settings: the job treats it as off. */
  invalid?: string;
};

export const DEFAULT_SETTINGS: Settings = {
  mode: "off", amount: DEFAULT_AMOUNT, countFromDate: null, liveFrom: null, pilot: [], controls: [],
  lookbackSchoolDays: DEFAULT_LOOKBACK, auditSummary: false,
};

const validAmount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_AMOUNT;
const cleanSn = (x: unknown) => String(x ?? "").trim();

/**
 * The stored row, read defensively. A row that cannot be read as settings is
 * OFF, never a guess: a corrupt amount must not pay a strange number.
 */
export function settingsOrDefault(raw: unknown): Settings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  const r = raw as Record<string, any>;
  const mode: Mode = MODES.includes(r.mode) ? r.mode : "off";
  const out: Settings = {
    mode,
    amount: r.amount === undefined ? DEFAULT_AMOUNT : r.amount,
    countFromDate: isDay(r.countFromDate) ? r.countFromDate : null,
    liveFrom: isDay(r.liveFrom) ? r.liveFrom : null,
    pilot: Array.isArray(r.pilot)
      ? r.pilot.filter((e: any) => e && cleanSn(e.sn) && isDay(e.from)).map((e: any) => ({ sn: cleanSn(e.sn), from: e.from }))
      : [],
    controls: Array.isArray(r.controls) ? [...new Set(r.controls.map(cleanSn).filter(Boolean) as string[])] : [],
    lookbackSchoolDays: Number.isInteger(r.lookbackSchoolDays) && r.lookbackSchoolDays >= 3 && r.lookbackSchoolDays <= 20
      ? r.lookbackSchoolDays : DEFAULT_LOOKBACK,
    auditSummary: r.auditSummary === true,
  };
  if (!validAmount(out.amount)) return { ...out, mode: "off", invalid: `The stored amount (${String(r.amount)}) is not a whole number from 1 to ${MAX_AMOUNT}.` };
  if (mode !== "off" && !out.countFromDate) return { ...out, mode: "off", invalid: "Switched on with no start date." };
  return out;
}

export type ConfigureInput = {
  mode?: Mode;
  amount?: number;
  pilotAdd?: string[];
  pilotRemove?: string[];
  controls?: string[];
  countFromDate?: string;
  /** Required to start counting before today: back-pay is a decision, never a default. */
  backPay?: boolean;
  auditSummary?: boolean;
  lookbackSchoolDays?: number;
};

/**
 * A change to the switch, decided. `today` is the school date of the change.
 *
 *   off -> anything on:     countFromDate = today (or the date given, which
 *                           may only be before today with backPay: true)
 *   off/shadow -> pilot/live: every pilot student's start moves up to today:
 *                           days decided in shadow were stamped unpayable and
 *                           stay so, and no pilot day before today is paid
 *   -> live:                liveFrom = today; the pilot keeps its own starts;
 *                           the controls are cleared (they belong to the
 *                           pilot: a control left in place would have every
 *                           live day stamped unpayable for good, while the
 *                           admin card read "none paid"). Naming controls
 *                           while live is refused.
 *   live -> pilot/shadow:   liveFrom cleared; nobody outside the pilot is paid
 *                           for a day decided from then on. Days already
 *                           stamped payable stay so and are paid when due
 *                           (no switch takes back what was earned)
 *   amount:                 only days decided after the change use it
 */
export function planConfigure(prev: Settings, input: ConfigureInput, today: string):
  { ok: true; next: Settings; notes: string[] } | { ok: false; reason: string } {
  if (!isDay(today)) return { ok: false, reason: "No school date for the change." };
  const next: Settings = { ...prev, pilot: prev.pilot.map((e) => ({ ...e })), controls: [...prev.controls] };
  delete next.invalid;
  const notes: string[] = [];
  const newMode: Mode = input.mode === undefined ? prev.mode : input.mode;
  if (!MODES.includes(newMode)) return { ok: false, reason: `Mode must be one of ${MODES.join(", ")}.` };

  if (input.amount !== undefined) {
    if (!validAmount(input.amount)) return { ok: false, reason: `The amount must be a whole number from 1 to ${MAX_AMOUNT}.` };
    if (input.amount !== prev.amount) notes.push(`Amount ${prev.amount} -> ${input.amount}: days already decided keep ${prev.amount}.`);
    next.amount = input.amount;
  }
  if (input.lookbackSchoolDays !== undefined) {
    const n = input.lookbackSchoolDays;
    if (!Number.isInteger(n) || n < 3 || n > 20) return { ok: false, reason: "The lookback must be 3 to 20 school days." };
    next.lookbackSchoolDays = n;
  }
  if (input.auditSummary !== undefined) next.auditSummary = input.auditSummary === true;
  if (input.countFromDate !== undefined && !isDay(input.countFromDate)) {
    return { ok: false, reason: "countFromDate must be a YYYY-MM-DD date." };
  }
  const back = input.backPay === true && input.countFromDate !== undefined && input.countFromDate < today;

  const switchingOn = prev.mode === "off" && newMode !== "off";
  if (switchingOn) {
    const from = input.countFromDate ?? today;
    if (from < today && !back) {
      return { ok: false, reason: `Counting from ${from} would decide and pay days before today. That is back-pay: pass backPay: true if it is really meant.` };
    }
    next.countFromDate = from;
    notes.push(`Counting from ${from}.`);
  } else if (input.countFromDate !== undefined && newMode !== "off") {
    const cur = prev.countFromDate ?? today;
    if (input.countFromDate < cur && !input.backPay) {
      return { ok: false, reason: `Moving the start back from ${cur} to ${input.countFromDate} is back-pay: pass backPay: true if it is really meant.` };
    }
    next.countFromDate = input.countFromDate;
  }

  const controls = input.controls !== undefined ? [...new Set(input.controls.map(cleanSn).filter(Boolean))] : next.controls;
  if (newMode === "live" && input.controls !== undefined && controls.length) {
    return { ok: false, reason: "Controls belong to a pilot: the whole school has none. Leave controls out, or pass controls: []." };
  }
  if (newMode === "live" && controls.length) {
    notes.push(`The ${controls.length} control${controls.length === 1 ? " is" : "s are"} cleared: controls belong to the pilot, and the whole school is paid from today.`);
  }
  next.controls = newMode === "live" ? [] : controls;
  const remove = new Set((input.pilotRemove ?? []).map(cleanSn));
  next.pilot = next.pilot.filter((e) => !remove.has(e.sn));
  const floor = back ? (input.countFromDate as string) : today;
  for (const sn of (input.pilotAdd ?? []).map(cleanSn).filter(Boolean)) {
    if (!next.pilot.some((e) => e.sn === sn)) next.pilot.push({ sn, from: floor < today && !back ? today : floor });
  }

  if (!paying(prev.mode) && paying(newMode)) {
    // MONEY STARTS NOW. Whatever the pilot entries said while nothing paid,
    // no pilot student is paid for a day before today.
    next.pilot = next.pilot.map((e) => ({ sn: e.sn, from: e.from < floor ? floor : e.from }));
    notes.push(`Money starts with days from ${floor}.`);
  }
  if (newMode === "live" && prev.mode !== "live") next.liveFrom = floor;
  if (newMode !== "live") next.liveFrom = null;
  if (newMode === "pilot" && next.pilot.length === 0) return { ok: false, reason: "A pilot needs named students (pilotAdd)." };
  const both = next.controls.filter((sn) => next.pilot.some((e) => e.sn === sn));
  if (both.length) return { ok: false, reason: `A control cannot also be a pilot student (${both.length} named as both).` };
  if (newMode !== "off" && !next.countFromDate) next.countFromDate = today;
  if (newMode !== "off" && !validAmount(next.amount)) {
    return { ok: false, reason: `The stored amount (${String(next.amount)}) is not a whole number from 1 to ${MAX_AMOUNT}: set one with it.` };
  }
  next.mode = newMode;
  return { ok: true, next, notes };
}

/** The first day this student can be paid for under these settings, or null for never. */
export function payableFrom(s: Settings, sn: string): string | null {
  if (!paying(s.mode)) return null;
  if (s.controls.includes(sn)) return null;
  const p = s.pilot.find((e) => e.sn === sn)?.from ?? null;
  let from: string | null;
  if (s.mode === "pilot") from = p;
  else from = p && s.liveFrom ? (p < s.liveFrom ? p : s.liveFrom) : (p ?? s.liveFrom);
  if (!from) return null;
  if (s.countFromDate && from < s.countFromDate) from = s.countFromDate;
  return from;
}

/** Can this student's day be paid under these settings, and if not, why not. */
export function scopeOf(s: Settings, sn: string, date: string): { payable: boolean; why: string | null } {
  if (s.mode === "off") return { payable: false, why: "off" };
  if (s.mode === "shadow") return { payable: false, why: "shadow" };
  if (s.controls.includes(sn)) return { payable: false, why: "control" };
  if (s.countFromDate && date < s.countFromDate) return { payable: false, why: "before-start" };
  const from = payableFrom(s, sn);
  if (!from) return { payable: false, why: s.mode === "pilot" ? "outside-pilot" : "not-in-scope" };
  if (date < from) return { payable: false, why: "before-start" };
  return { payable: true, why: null };
}

/**
 * THE SETTINGS A DATE WAS FIRST DECIDED UNDER, as its date record keeps them
 * (`scope`): everything scopeOf reads. Written once, when the date is first
 * decided as a school day, and never changed after.
 */
export type ScopeSnapshot = Pick<Settings, "mode" | "countFromDate" | "liveFrom" | "pilot" | "controls">;
export function scopeSnapshot(s: Settings): ScopeSnapshot {
  return { mode: s.mode, countFromDate: s.countFromDate, liveFrom: s.liveFrom, pilot: s.pilot.map((e) => ({ ...e })), controls: [...s.controls] };
}
/**
 * A stored snapshot read back as settings, or null. Read as defensively as the
 * switch itself: one that cannot be read stamps nothing new (the caller then
 * starts no day on the date, as before the snapshot existed).
 */
export function settingsFromSnapshot(raw: unknown, amount: number): Settings | null {
  if (!raw || typeof raw !== "object") return null;
  const s = settingsOrDefault({ ...(raw as Record<string, unknown>), amount });
  return s.invalid ? null : s;
}

/**
 * CAN THIS DECIDED DAY BE PAID NOW? Null for yes, else why it waits.
 *
 * scopeOf above is asked ONCE, when a day is first decided, and its answer is
 * stamped on the day (`payable`). That stamp is the whole fence against
 * back-pay: a day decided while off, in shadow, outside the pilot, before the
 * start or for a control was stamped unpayable and stays so. Payday and the
 * student's pending line ask only this, and NEVER today's start dates again:
 * re-checking them would forfeit days a student earned and was shown, every
 * time the switch went off and on or the pilot widened or narrowed.
 *
 * A stamped day waits, and is not lost, while no money moves (off, shadow)
 * or while the student is a control.
 */
export function payNowWhy(s: Settings, sn: string, row: { payable: boolean }): string | null {
  if (!row.payable) return "unpayable";
  if (!paying(s.mode)) return s.mode;
  if (s.controls.includes(sn)) return "control";
  return null;
}

// ===========================================================================
// The tick: whether to run, by the school's wall clock
// ===========================================================================

export type Lease = { runId: string; startedAt: string; expiresAt: string } | null;

/**
 * Run now, or not. NEVER TRUSTS THE HOUR THE CRON FIRED AT: it turns now into
 * the school's wall clock, so the 1 November clock change cannot move it.
 */
export function decideTick(input: {
  mode: Mode; nowIso: string; tz: string | null; lastDoneDate: string | null; lease: Lease; force?: boolean;
}): { do: "run"; today: string; minute: number } | { do: "none"; why: string } {
  if (input.mode === "off") return { do: "none", why: "Switched off." };
  if (!input.tz) return { do: "none", why: "No school time zone is set in Settings > Bell Schedule." };
  const lt = localSchoolTime(input.nowIso, input.tz);
  if (!lt.ok) return { do: "none", why: lt.reason };
  const nowMs = Date.parse(input.nowIso);
  if (input.lease && Date.parse(input.lease.expiresAt) > nowMs) {
    return { do: "none", why: `A run (${input.lease.runId}) is still going.` };
  }
  if (!input.force) {
    if (lt.weekday === 0 || lt.weekday === 6) return { do: "none", why: "A weekend." };
    if (lt.minuteOfDay < MORNING_FROM || lt.minuteOfDay >= MORNING_TO) {
      return { do: "none", why: "Outside the morning window (06:30-11:00 school time)." };
    }
    if (input.lastDoneDate === lt.dateKey) return { do: "none", why: "Today's run is done." };
  }
  return { do: "run", today: lt.dateKey, minute: lt.minuteOfDay };
}

// ===========================================================================
// The calendar: which dates to read, which are no school
// ===========================================================================

export type Marked = { noSchool: boolean; scheduled: boolean };

/**
 * The dates worth asking PowerSchool about, newest first. A date marked no
 * school (Settings > Bell Schedule, or an admin's "no school" here) is no
 * school and is not read; an unmarked weekend is never a school day. Every
 * other date is counted, and a count of zero means no school (review H3): a
 * holiday is NOT a failed read, and is never held.
 */
export function calendarCandidates(input: {
  today: string; reachDays: number; marks: Record<string, Marked>; adminNoSchool: string[];
}): { candidates: string[]; noSchool: Array<{ date: string; why: string }> } {
  const candidates: string[] = [];
  const noSchool: Array<{ date: string; why: string }> = [];
  const admin = new Set(input.adminNoSchool);
  for (let k = 1; k <= input.reachDays; k++) {
    const d = addDays(input.today, -k);
    const m = input.marks[d];
    const wd = weekdayOf(d);
    if (m?.noSchool) { noSchool.push({ date: d, why: "Marked no school in Settings > Bell Schedule." }); continue; }
    if (admin.has(d)) { noSchool.push({ date: d, why: "An admin marked it no school for the perfect-day award." }); continue; }
    if ((wd === 0 || wd === 6) && !m?.scheduled) continue;
    candidates.push(d);
  }
  return { candidates, noSchool };
}

/** The last `lookback` dates with any attendance, oldest first, and the dates with none. */
export function windowOf(input: { candidates: string[]; counts: Record<string, number>; lookback: number }):
  { window: string[]; zero: string[] } {
  const withRows = input.candidates.filter((d) => (input.counts[d] ?? 0) > 0).sort().reverse().slice(0, input.lookback);
  const oldest = withRows.length ? withRows[withRows.length - 1] : null;
  const zero = input.candidates.filter((d) => input.counts[d] === 0 && (!oldest || d > oldest)).sort();
  return { window: withRows.sort(), zero };
}

// ===========================================================================
// PowerSchool's rows, read as facts
// ===========================================================================

export type CodeInfo = { code: string; absent: boolean; description: string };
export type CodeBook = { ok: true; byId: Record<string, CodeInfo> } | { ok: false; reason: string };

/** The attendance codes, as read from PowerSchool every run. Never typed into this file. */
export function codeBookOf(rows: unknown): CodeBook {
  const byId: Record<string, CodeInfo> = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = r?.id === null || r?.id === undefined ? "" : String(r.id);
    if (!id) continue;
    byId[id] = {
      code: String(r?.att_code ?? "").trim().toUpperCase(),
      absent: String(r?.presence_status_cd ?? "") === "Absent",
      description: String(r?.description ?? ""),
    };
  }
  if (!Object.keys(byId).length) {
    return { ok: false, reason: "PowerSchool returned no attendance codes, so no mark could be read. Nothing was decided." };
  }
  return { ok: true, byId };
}

/** THE RULE. A code id the book does not know breaks the day too. */
export function breaksDay(info: CodeInfo | undefined): boolean {
  if (!info) return true;
  return !NOT_BREAKING.has(info.code);
}

/** periodid 851..860 -> slot 1..10, anything else null (slot = periodid - 850, measured 25,098 of 25,098). */
export function slotOfPeriodId(periodId: unknown): number | null {
  const n = Number(periodId);
  if (!Number.isInteger(n)) return null;
  const slot = n - 850;
  return slot >= 1 && slot <= 10 ? slot : null;
}
/** The leading slot of a section expression, "8(A-E)" -> 8. */
export function slotOfExpression(expression: unknown): number | null {
  const m = /^\s*(\d{1,2})\(/.exec(String(expression ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 10 ? n : null;
}

export type PsStudent = { psId: string; sn: string; grade: string; entry: string; exit: string };
/** PowerSchool's students rows (leavers included) as the facts a verdict needs. */
export function psStudentsOf(rows: unknown): PsStudent[] {
  const out: PsStudent[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const psId = r?.id === null || r?.id === undefined ? "" : String(r.id);
    const sn = cleanSn(r?.student_number);
    if (!psId || !sn) continue;
    out.push({
      psId, sn, grade: String(r?.grade_level ?? "").trim(),
      entry: String(r?.entrydate ?? "").slice(0, 10), exit: String(r?.exitdate ?? "").slice(0, 10),
    });
  }
  return out;
}

export type CcRow = { id: string; psId: string; section: string; slot: number | null; from: string; to: string };
/** Class enrolments (dropped ones included: their dates still say when the student sat in the class). */
export function ccRowsOf(rows: unknown): CcRow[] {
  const out: CcRow[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = r?.id === null || r?.id === undefined ? "" : String(r.id);
    if (!id) continue;
    out.push({
      id, psId: String(r?.studentid ?? ""), section: String(Math.abs(Number(r?.sectionid)) || String(r?.sectionid ?? "")),
      slot: slotOfExpression(r?.expression), from: String(r?.dateenrolled ?? "").slice(0, 10), to: String(r?.dateleft ?? "").slice(0, 10),
    });
  }
  return out;
}

/** Grades 6-8 are middle school, 9-12 high school. */
export function divisionOfGrade(grade: unknown): "ms" | "hs" | null {
  const g = Number(String(grade ?? "").trim());
  if (!Number.isInteger(g)) return null;
  if (g >= 6 && g <= 8) return "ms";
  if (g >= 9 && g <= 12) return "hs";
  return null;
}

export type RawRow = { id?: unknown; studentid?: unknown; att_date?: unknown; periodid?: unknown; attendance_codeid?: unknown; ccid?: unknown };

export type DayStats = {
  date: string; rows: number; rowCounts: Record<string, number>; studentsWithMarks: number; unplaceable: number; unmatched: number;
};

/** One day's rows counted: per slot, students with any mark, rows outside a period, rows of an unknown student. */
export function dayStats(date: string, rows: RawRow[], knownPsIds: Set<string>): DayStats {
  const rowCounts: Record<string, number> = {};
  const marked = new Set<string>();
  let unplaceable = 0, unmatched = 0;
  for (const r of rows) {
    const slot = slotOfPeriodId(r.periodid);
    if (slot === null) unplaceable++;
    else rowCounts[String(slot)] = (rowCounts[String(slot)] ?? 0) + 1;
    const ps = String(r.studentid ?? "");
    if (knownPsIds.has(ps)) marked.add(ps); else unmatched++;
  }
  return { date, rows: rows.length, rowCounts, studentsWithMarks: marked.size, unplaceable, unmatched };
}

/** PowerSchool shows school in session: slot 1 alone, or enough rows across two or more slots. */
export function hasEvidence(rowCounts: Record<string, number> | null | undefined): boolean {
  const c = rowCounts ?? {};
  if ((c["1"] ?? 0) >= EVIDENCE_SLOT1_ROWS) return true;
  const vals = Object.values(c);
  return vals.reduce((a, n) => a + n, 0) >= EVIDENCE_TOTAL_ROWS && vals.filter((n) => n > 0).length >= EVIDENCE_MIN_SLOTS;
}

// ===========================================================================
// One student, one day
// ===========================================================================

export type StudentVerdict = {
  perfect: boolean;
  why: "not-enrolled" | "no-class" | "ditching" | "unknown-code" | "marked" | typeof ENROLMENT_UNCONFIRMED | null;
  /** Broken only by K: the Perfect Attendance screen counts K as present (the known difference). */
  kOnly: boolean;
  /** Broken only in Promise Time AM (slot 1): late to school. Counted, for the equity review. */
  ptAmOnly: boolean;
  unknownCodes: string[];
};

/**
 * Was this student's day perfect? Enrolled on the day (entry <= D < exit),
 * at least one class that met, and no breaking mark in any block. A class
 * with no mark recorded counts as present, as on the screen: requiring a
 * "taken" record would punish students for teachers (review M5).
 */
export function studentDayVerdict(input: {
  enrolled: boolean; hasClass: boolean; marks: Array<{ slot: number | null; info: CodeInfo | undefined }>;
}): StudentVerdict {
  const none = { kOnly: false, ptAmOnly: false, unknownCodes: [] as string[] };
  if (!input.enrolled) return { perfect: false, why: "not-enrolled", ...none };
  if (!input.hasClass) return { perfect: false, why: "no-class", ...none };
  const breaking = input.marks.filter((m) => breaksDay(m.info));
  if (!breaking.length) return { perfect: true, why: null, ...none };
  const unknown = breaking.filter((m) => !m.info || !KNOWN_BREAKING.has(m.info.code)).map((m) => m.info ? m.info.code || "(blank)" : "(unknown id)");
  const kOnly = breaking.every((m) => m.info?.code === "K");
  return {
    perfect: false,
    why: kOnly ? "ditching" : unknown.length === breaking.length ? "unknown-code" : "marked",
    kOnly,
    ptAmOnly: breaking.every((m) => m.slot === 1),
    unknownCodes: unknown,
  };
}

// ===========================================================================
// The Perfect Attendance screen, as the second check
// ===========================================================================

/**
 * What the screen says, from psAttendanceMarks, only when the morning's
 * attendance rebuild has finished cleanly after the day in question.
 * `asOf` is the school date the rebuild that wrote it started on.
 */
export type ScreenView = {
  available: boolean;
  reason: string;
  asOf: string | null;
  bySn: Record<string, { entry: string | null; bad: string[] }>;
};

/** The screen's verdict for one student and one day: its default (strict) rule, exactly. */
export function screenPerfect(s: { entry: string | null; bad: string[] } | undefined, date: string): boolean | null {
  if (!s) return null;
  if (s.entry && isDay(s.entry) && s.entry > date) return false;
  return !s.bad.includes(date);
}

// ===========================================================================
// One day, judged
// ===========================================================================

export type DayJudgement = {
  date: string;
  state: "school" | "no-school" | "held";
  reason: string;
  /** Held because a read failed: worth trying again within the morning. */
  retryable: boolean;
  /** The second check was applied (else nothing new may become payable). */
  checked: boolean;
  perfect: Array<{ sn: string; div: string | null }>;
  /**
   * Perfect by the marks, but enrolled on the day only by the class records
   * (they entered PowerSchool again after it): a day ALREADY decided for them
   * stands; a new one is never started on that evidence.
   */
  keep: Array<{ sn: string; div: string | null }>;
  /** Perfect by PowerSchool, not by the screen: held, one by one (existingOnly: only a day already decided). */
  held: Array<{ sn: string; why: string; div: string | null; existingOnly?: boolean }>;
  /** Everybody else PowerSchool knows, with why (not enrolled, a mark, ...). */
  broken: Array<{ sn: string; why: string }>;
  counts: Record<string, any>;
  rowCounts: Record<string, number>;
};

/** Makes a decided day not payable by what the read shows (a mark) or by the students table: true of a held read too. */
const MARK_BROKEN = new Set(["marked", "ditching", "unknown-code", "not-enrolled", ENROLMENT_UNCONFIRMED]);

const emptyJudgement = (date: string, state: DayJudgement["state"], reason: string, retryable: boolean,
  extra: Partial<DayJudgement> = {}): DayJudgement => ({
  date, state, reason, retryable, checked: false, perfect: [], keep: [], held: [], broken: [], counts: {}, rowCounts: {}, ...extra,
});

/**
 * THE DAY. In order:
 *   1. a read that was not confirmed is HELD and tried again (retryable);
 *   2. no evidence of school is NO SCHOOL, never held (review H3);
 *   3. a read that cannot be believed is HELD: rows outside the periods, far
 *      fewer students marked than usual ("too perfect"), or a block far below
 *      its usual level for the same weekday pattern (late bulk entry) --
 *      unless an admin said "decide anyway" for the date;
 *   4. every student is judged (a held read too);
 *   5. the screen checks each perfect student; a disagreement holds THAT
 *      STUDENT, and only a disagreement about more than 1% holds the date.
 * `decided` names the dates an earlier run decided by these same checks (not
 * an admin's "decide anyway"): the blocks such a day ran are a kind of day the
 * school runs, so a day that ran exactly those blocks is not short of one.
 * A HELD date makes nobody perfect, but still lists the students the screen
 * disputes and those with a breaking mark: for a date decided on an earlier
 * run, those pending days must stop (applyDate).
 */
export function judgeDay(input: {
  date: string;
  read: { ok: true; rows: RawRow[] } | { ok: false; reason: string };
  codes: Extract<CodeBook, { ok: true }>;
  students: PsStudent[];
  cc: CcRow[];
  reference: DayStats[];
  screen: ScreenView;
  decideAnyway: boolean;
  decided?: string[];
}): DayJudgement {
  const { date } = input;
  if (!input.read.ok) {
    return emptyJudgement(date, "held", `PowerSchool's read of ${date} was not confirmed (${input.read.reason}). Tried again on the next run.`, true);
  }
  const rows = input.read.rows.filter((r) => String(r.att_date ?? "").slice(0, 10) === date);
  if (rows.length !== input.read.rows.length) {
    return emptyJudgement(date, "held", `PowerSchool's read of ${date} held rows from another date. Nothing was taken from it.`, true);
  }
  const psIds = new Set(input.students.map((s) => s.psId));
  const stats = dayStats(date, rows, psIds);
  if (!rows.length || !hasEvidence(stats.rowCounts)) {
    return emptyJudgement(date, "no-school",
      rows.length ? `PowerSchool shows too little attendance for a school day (${rows.length} rows).` : "PowerSchool has no attendance for this date.",
      false, { rowCounts: stats.rowCounts, counts: { rows: stats.rows } });
  }

  // CAN THE READ BE BELIEVED AS COMPLETE? If not, the date is held: nothing
  // becomes payable from it. Every student is still judged below, because a
  // breaking mark the read DOES show is real however incomplete the rest is,
  // and a day already pending must not be paid over it (2026-10-12 review).
  let hold: { reason: string; counts: Record<string, any> } | null = null;
  if (!input.decideAnyway) {
    const ref = input.reference.filter((r) => r.date !== date && hasEvidence(r.rowCounts));
    const usualMarked = ref.length >= MIN_REFERENCE_DAYS ? median(ref.map((r) => r.studentsWithMarks)) : null;
    if (stats.unplaceable > UNPLACEABLE_MAX * stats.rows) {
      hold = { reason: `${stats.unplaceable} of ${stats.rows} rows are not in a known period, so the read is not believed.`, counts: {} };
    } else if (usualMarked !== null && stats.studentsWithMarks < TOO_PERFECT_RATIO * usualMarked) {
      hold = {
        reason: `Only ${stats.studentsWithMarks} students have any mark, against a usual ${usualMarked}: a day that looks too perfect is held, not paid.`,
        counts: { usual: usualMarked },
      };
    } else {
      // A BLOCK NOT ENTERED YET, OR ONE THAT DID NOT MEET: PowerSchool cannot
      // tell them apart, so the question is which blocks a day like this runs.
      //
      // 1. A KIND OF DAY ALREADY VOUCHED FOR. The blocks that met today (each
      //    at a quarter or more of its usual level) are exactly the blocks of
      //    a reference day an earlier run DECIDED by these checks: the school
      //    runs days like it, complete. So a Monday run on the Tue/Fri bell, or
      //    a normal day after stack and minimum days, is not held (2026-10-12
      //    review). A day an admin decided anyway vouches for nothing, and a
      //    day still held cannot vouch, so a block entered late on two days
      //    running is still caught.
      // 2. Otherwise THE SAME WEEKDAY PATTERN: a block is EXPECTED only if it
      //    ran (had any rows) on more than half of those days, its usual level
      //    taken over the days it ran. So one "stack" day where all ten blocks
      //    met (Thu 9/3, Tue 9/8) cannot make a block that never meets on this
      //    pattern look missing (measured: it held 8/27, 8/31, 9/10 and more
      //    against a usual of half the stack day's count).
      const usualAll: number[] = [];
      for (let slot = 1; slot <= 10; slot++) usualAll[slot] = median(ref.map((r) => r.rowCounts[String(slot)] ?? 0).filter((n) => n > 0));
      const shapeOf = (rc: Record<string, number>) => {
        const met: number[] = [];
        for (let slot = 1; slot <= 10; slot++) {
          if (usualAll[slot] >= SLOT_MIN_USUAL && (rc[String(slot)] ?? 0) >= SLOT_INCOMPLETE_RATIO * usualAll[slot]) met.push(slot);
        }
        return met.join(",");
      };
      const decided = new Set(input.decided ?? []);
      const vouched = new Set(ref.filter((r) => decided.has(r.date)).map((r) => shapeOf(r.rowCounts)));
      const today = shapeOf(stats.rowCounts);
      const same = today !== "" && vouched.has(today) ? [] : ref.filter((r) => patternOf(r.date) === patternOf(date));
      for (let slot = 1; slot <= 10 && !hold; slot++) {
        const ran = same.map((r) => r.rowCounts[String(slot)] ?? 0).filter((n) => n > 0);
        if (ran.length * 2 <= same.length) continue;
        const usual = median(ran);
        const now = stats.rowCounts[String(slot)] ?? 0;
        if (usual >= SLOT_MIN_USUAL && now < SLOT_INCOMPLETE_RATIO * usual) {
          hold = {
            reason: `Block ${slot} has ${now} marks against a usual ${usual} on this kind of day: it has not been entered yet, `
              + "or it did not meet that day. Held until it is entered; if it did not meet, an admin decides the date anyway (perfectDay:decideAnyway).",
            counts: { slot, slotNow: now, slotUsual: usual },
          };
        }
      }
    }
  }

  // ---- every student
  const slotsRan = new Set(Object.keys(stats.rowCounts).map(Number));
  const marksByPs = new Map<string, Array<{ slot: number | null; info: CodeInfo | undefined }>>();
  const rowsBySection = new Set<string>();
  const ccById = new Map(input.cc.map((c) => [c.id, c]));
  const counts: Record<string, any> = {
    rows: stats.rows, studentsWithMarks: stats.studentsWithMarks, unplaceable: stats.unplaceable, unmatched: stats.unmatched,
    rowsByCode: {} as Record<string, number>,
  };
  for (const r of rows) {
    const info = input.codes.byId[String(r.attendance_codeid ?? "")];
    const label = info ? (info.code || "(blank)") : "(unknown id)";
    counts.rowsByCode[label] = (counts.rowsByCode[label] ?? 0) + 1;
    const ps = String(r.studentid ?? "");
    const list = marksByPs.get(ps) ?? [];
    list.push({ slot: slotOfPeriodId(r.periodid), info });
    marksByPs.set(ps, list);
    const c = ccById.get(String(r.ccid ?? ""));
    if (c) rowsBySection.add(c.section);
  }
  const ccByPs = new Map<string, CcRow[]>();
  const sectionsMeeting = new Set<string>();
  for (const c of input.cc) {
    if (!(c.from <= date && date < c.to) || c.slot === null || !slotsRan.has(c.slot)) continue;
    const l = ccByPs.get(c.psId) ?? [];
    l.push(c);
    ccByPs.set(c.psId, l);
    sectionsMeeting.add(c.section);
  }
  const enrolledCount = { ms: 0, hs: 0, other: 0 };
  const perfectCount = { ms: 0, hs: 0, other: 0 };
  const perfect: Array<{ sn: string; div: string | null }> = [];
  const keep: Array<{ sn: string; div: string | null }> = [];
  const broken: Array<{ sn: string; why: string }> = [];
  const verdictOf = new Map<string, StudentVerdict>();
  let noClass = 0, kOnly = 0, ptAmOnly = 0, enteredLaterCount = 0;
  const unknownCodes: Record<string, number> = {};
  const seenSn = new Set<string>();
  for (const s of input.students) {
    if (seenSn.has(s.sn)) continue; // one verdict per student number
    seenSn.add(s.sn);
    const enrolled = isDay(s.entry) && isDay(s.exit) && s.entry <= date && date < s.exit;
    // ENTERED AGAIN AFTER THIS DATE (2026-10-12 review). PowerSchool's students
    // row holds the CURRENT enrolment only (earlier spans live in
    // REENROLLMENTS, not granted), so a student who left and came back reads
    // as not enrolled on the days of the earlier span. Their class records,
    // dropped ones included, still say whether they sat a class that day: if
    // so, a day already decided stands (keep), and the marks still break it;
    // if not, it is a question for an admin, never a break. Only an exit on or
    // before the date (a backdated withdrawal) is "not enrolled".
    const enteredLater = !enrolled && isDay(s.entry) && s.entry > date;
    const div = divisionOfGrade(s.grade);
    let v = studentDayVerdict({ enrolled: enrolled || enteredLater, hasClass: (ccByPs.get(s.psId) ?? []).length > 0, marks: marksByPs.get(s.psId) ?? [] });
    if (enteredLater) {
      enteredLaterCount++;
      if (v.perfect) { verdictOf.set(s.sn, v); keep.push({ sn: s.sn, div }); continue; }
      if (v.why === "no-class") v = { ...v, why: ENROLMENT_UNCONFIRMED };
    }
    verdictOf.set(s.sn, v);
    if (enrolled) enrolledCount[div ?? "other"]++;
    if (v.perfect) {
      perfect.push({ sn: s.sn, div });
      perfectCount[div ?? "other"]++;
    } else {
      broken.push({ sn: s.sn, why: v.why ?? "marked" });
      if (v.why === "no-class") noClass++;
      if (v.kOnly) kOnly++;
      if (enrolled && v.ptAmOnly && v.why !== "no-class") ptAmOnly++;
      for (const u of v.unknownCodes) unknownCodes[u] = (unknownCodes[u] ?? 0) + 1;
    }
  }
  Object.assign(counts, {
    enrolled: enrolledCount, perfect: perfectCount, noClass, kOnly, brokenByPromiseTimeAmOnly: ptAmOnly, unknownCodes, enteredLater: enteredLaterCount,
    classesMeeting: sectionsMeeting.size,
    classesNoMarks: [...sectionsMeeting].filter((x) => !rowsBySection.has(x)).length,
  });

  // ---- the second check
  const usable = input.screen.available && !!input.screen.asOf && input.screen.asOf > date;
  const held: Array<{ sn: string; why: string; div: string | null; existingOnly?: boolean }> = [];
  const screenCounts = { checked: usable, reason: usable ? "" : (input.screen.available ? `The Perfect Attendance screen's data is from ${input.screen.asOf ?? "an unknown date"}, not after ${date}.` : input.screen.reason),
    agreedPerfect: 0, heldDisagree: 0, knownDitching: 0, stricterUnknownCode: 0, stricterOther: 0, notOnScreen: 0 };
  let agreed = perfect;
  let kept = keep;
  if (usable) {
    agreed = [];
    for (const p of perfect) {
      const sp = screenPerfect(input.screen.bySn[p.sn], date);
      if (sp === null) { screenCounts.notOnScreen++; agreed.push(p); continue; }
      if (sp) { screenCounts.agreedPerfect++; agreed.push(p); continue; }
      held.push({ sn: p.sn, div: p.div, why: "The Perfect Attendance screen shows an absence or tardy that PowerSchool's read does not." });
    }
    screenCounts.heldDisagree = held.length;
    for (const b of broken) {
      const v = verdictOf.get(b.sn)!;
      if (b.why === "not-enrolled" || b.why === "no-class" || b.why === ENROLMENT_UNCONFIRMED) continue;
      if (screenPerfect(input.screen.bySn[b.sn], date) !== true) continue;
      if (v.kOnly) screenCounts.knownDitching++;
      else if (v.why === "unknown-code") screenCounts.stricterUnknownCode++;
      else screenCounts.stricterOther++;
    }
    const enrolledTotal = enrolledCount.ms + enrolledCount.hs + enrolledCount.other;
    const limit = Math.max(1, Math.floor(DISAGREE_DAY_MAX * enrolledTotal));
    if (held.length > limit && !input.decideAnyway && !hold) {
      hold = {
        reason: `PowerSchool and the Perfect Attendance screen disagree about ${held.length} students (more than ${limit}), so something is wrong with one of them. The date is held.`,
        counts: {},
      };
    }
    // A student kept on their class records: the screen's entry date is their
    // current one, after this day, so only its marks are asked. A dispute holds
    // a day already decided; it never starts one.
    kept = [];
    for (const k of keep) {
      const sv = input.screen.bySn[k.sn];
      if (sv && sv.bad.includes(date)) {
        held.push({ sn: k.sn, div: k.div, existingOnly: true, why: "The Perfect Attendance screen shows an absence or tardy that PowerSchool's read does not." });
      } else kept.push(k);
    }
  }
  counts.screen = screenCounts;
  if (hold) {
    // HELD: nothing is perfect from this read. It still says who the screen
    // disputes and who has a breaking mark, so a day already pending for them
    // is held or broken, never paid over it (applyDate, planDateRows'
    // onlyNotPayable). "No class" is left out: it leans on which blocks the
    // read shows meeting, which is what an incomplete read gets wrong.
    return {
      date, state: "held", reason: hold.reason, retryable: false, checked: usable, perfect: [], keep: [], held,
      broken: broken.filter((b) => MARK_BROKEN.has(b.why)), counts: { ...counts, ...hold.counts }, rowCounts: stats.rowCounts,
    };
  }
  return {
    date, state: "school", reason: usable ? "Decided." : `Decided without the second check (${screenCounts.reason}): nothing new becomes payable until it runs.`,
    retryable: false, checked: usable, perfect: agreed, keep: kept, held, broken, counts, rowCounts: stats.rowCounts,
  };
}

// ===========================================================================
// The register: what one judged date does to it
// ===========================================================================

export type Status = "pending" | "unpayable" | "held" | "broken" | "paid" | "removed" | "expired";
export type RegRow = {
  _id?: any;
  studentNumber: string; date: string; status: Status; payable: boolean; amount: number;
  /** Why the day was stamped unpayable when first decided (shadow, outside-pilot, before-start, control). */
  stampWhy?: string;
  division?: string; why?: string; decidedAt: string; updatedAt: string; runId: string;
  paidTxnId?: string; paidAt?: string; afterPayBroken?: boolean; afterPayWhy?: string; afterPayAt?: string;
};

/**
 * THE REGISTER, PLANNED. One row per student per date, inserted the first
 * time the student is found perfect (or held). `payable` and `amount` are
 * stamped then and never change.
 *
 * Before payday a day settles freely in either direction (pending <-> broken).
 * A PAID day is never taken back here: one that later breaks is flagged for
 * an admin (afterPayBroken) and only an admin acts on it (review M1). A
 * removed or expired day is final. A change that would make a day payable
 * needs the second check; without it the day is held, while a change that
 * makes a day NOT payable (pending -> broken) always applies.
 *
 * ONLY NOT PAYABLE (`onlyNotPayable`): a date decided on an earlier run whose
 * re-read is HELD as a whole. Nothing is inserted and nothing becomes pending,
 * but a pending day the screen now disputes is held, one the read shows
 * broken is broken, and a paid one it shows broken is flagged: the same
 * direction that "always applies", so a hold never pays over a known break.
 *
 * ONLY DAYS ALREADY DECIDED (`existingOnly`, and per person `existingOnly`): a
 * date before countFromDate, decided before the switch last came on, or a
 * student kept only on their class records. Nothing is inserted, so a pause
 * never decides a new day; the rows that exist settle by their own stamps
 * exactly as on any other date, so a known break is applied (or flagged once
 * paid) and a held day is released once the second check agrees.
 *
 * ENROLMENT UNCONFIRMED (a broken entry with that why) is not a break: a
 * pending day becomes held for an admin, a paid one is flagged.
 *
 * A HELD DAY KEEPS ITS REASON WHEN THE SECOND CHECK CANNOT RUN (2026-10-12
 * final review). Held because the screen disagrees, or as enrolment
 * unconfirmed, it is not relabelled "second-check-unavailable" by a run that
 * has no check: that label never expires and releaseUnchecked releases it,
 * so one run during a rebuild outage would turn a disputed day into one an
 * admin pays in bulk. Only a new day or a broken one becomes held for the check.
 *
 * STAMPED AS THE DATE WAS (`stampSettings`, 2026-10-12 final review). A date
 * decided before the switch last came on is stamped by the settings it was
 * first decided under, not today's: a student a correction makes perfect
 * there is stamped exactly as they would have been had the mark been right
 * the first time. So two students with the same final record for a day get
 * the same money whatever order the marks arrived in, and a date first
 * decided in shadow, or outside the pilot, stays unpayable (no back-pay).
 */
export function planDateRows(input: {
  date: string; now: string; runId: string; settings: Settings; existing: RegRow[];
  judgement: { perfect: Array<{ sn: string; div: string | null; existingOnly?: boolean }>;
    held: Array<{ sn: string; why?: string; div?: string | null; existingOnly?: boolean }>;
    broken: Array<{ sn: string; why: string }>; checked: boolean };
  onlyNotPayable?: boolean;
  existingOnly?: boolean;
  /** What a NEW row is stamped by, when not today's settings: the date's own, from its first decision. */
  stampSettings?: Settings;
}): { inserts: RegRow[]; patches: Array<{ id: any; patch: Partial<RegRow> }>; counts: Record<string, number> } {
  const { date, now, runId, settings } = input;
  const stampWith = input.stampSettings ?? settings;
  const inserts: RegRow[] = [];
  const patches: Array<{ id: any; patch: Partial<RegRow> }> = [];
  const counts: Record<string, number> = {
    inserted: 0, nowPending: 0, nowUnpayable: 0, nowHeld: 0, nowBroken: 0, paidThenBroken: 0, paidRestored: 0, duplicates: 0,
  };
  const bySn = new Map<string, RegRow>();
  for (const r of input.existing) {
    if (r.date !== date) continue;
    if (bySn.has(r.studentNumber)) { counts.duplicates++; continue; }
    bySn.set(r.studentNumber, r);
  }
  const base = { updatedAt: now, runId };
  const settle = (r: RegRow, status: Status, why?: string) => {
    if (r.status === status && (r.why ?? undefined) === why) return;
    patches.push({ id: r._id, patch: { status, why, ...base } });
  };
  const newRow = (sn: string, div: string | null, status: Status, stamp: { payable: boolean; why: string | null }, why?: string): RegRow => ({
    studentNumber: sn, date, status, payable: stamp.payable, amount: settings.amount,
    ...(stamp.why ? { stampWhy: stamp.why } : {}), ...(div ? { division: div } : {}),
    ...(why ? { why } : {}), decidedAt: now, ...base,
  });

  for (const p of input.onlyNotPayable ? [] : input.judgement.perfect) {
    const r = bySn.get(p.sn);
    if (!r && (input.existingOnly || p.existingOnly)) continue;
    if (r && (r.status === "removed" || r.status === "expired")) continue;
    if (r && r.status === "paid") {
      if (r.afterPayBroken) {
        patches.push({ id: r._id, patch: { afterPayBroken: false, afterPayWhy: undefined, afterPayAt: undefined, ...base } });
        counts.paidRestored++;
      }
      continue;
    }
    if (r && (r.status === "pending" || r.status === "unpayable")) continue;
    // Held, and no second check to settle it with: it keeps its own reason.
    if (r && r.status === "held" && !input.judgement.checked) continue;
    // No row yet, or held or broken: THE MONEY DIRECTION. The stamp is the
    // row's own when it has one, and never the settings of today.
    const stamp = r ? { payable: r.payable, why: r.stampWhy ?? null } : scopeOf(stampWith, p.sn, date);
    const status: Status = !stamp.payable ? "unpayable" : !input.judgement.checked ? "held" : "pending";
    const why = status === "held" ? UNCHECKED : undefined;
    if (!r) {
      inserts.push(newRow(p.sn, p.div, status, stamp, why));
      counts.inserted++;
    } else {
      settle(r, status, why);
    }
    counts[status === "pending" ? "nowPending" : status === "unpayable" ? "nowUnpayable" : "nowHeld"]++;
  }

  for (const h of input.judgement.held) {
    const r = bySn.get(h.sn);
    if (r && (r.status === "removed" || r.status === "expired" || r.status === "paid")) continue;
    // An admin already settled this disagreement (perfectDay.resolveHeld): it stays settled.
    if (r && (r.status === "pending" || r.status === "unpayable") && String(r.why ?? "").startsWith("admin:")) continue;
    if (!r && (input.onlyNotPayable || input.existingOnly || h.existingOnly)) continue;
    if (!r) {
      inserts.push(newRow(h.sn, h.div ?? null, "held", scopeOf(stampWith, h.sn, date), "screen-disagrees"));
      counts.inserted++;
    } else {
      settle(r, "held", "screen-disagrees");
    }
    counts.nowHeld++;
  }

  for (const b of input.judgement.broken) {
    const r = bySn.get(b.sn);
    if (!r) continue;
    if (r.status === "removed" || r.status === "expired") continue;
    if (r.status === "paid") {
      if (!r.afterPayBroken) {
        patches.push({ id: r._id, patch: { afterPayBroken: true, afterPayWhy: b.why, afterPayAt: now, ...base } });
        counts.paidThenBroken++;
      }
      continue;
    }
    if (r.status === "broken") continue;
    if (b.why === ENROLMENT_UNCONFIRMED) {
      // A question for an admin (resolveHeld), never a break; one an admin already answered stays answered.
      if (r.status === "unpayable" || (r.status === "held" && r.why === ENROLMENT_UNCONFIRMED) || String(r.why ?? "").startsWith("admin:")) continue;
      settle(r, "held", ENROLMENT_UNCONFIRMED);
      counts.nowHeld++;
      continue;
    }
    settle(r, "broken", b.why);
    counts.nowBroken++;
  }
  return { inserts, patches, counts };
}

// ===========================================================================
// Payday
// ===========================================================================

/**
 * Is today a payday? The first run on or after Monday pays (review L2): a
 * failed Monday does not slip a week, and nor does a PowerSchool outage, since
 * paying reads nothing from it (the run counts a failed read as a retried read
 * of last week). On the Monday itself it waits until 09:30 for a retried read
 * of last week, then pays what is settled; a day settled later is paid the
 * next week.
 */
export function paydayVerdict(input: {
  today: string; minute: number; mode: Mode; lastPayWeek: string | null; retryableHeldBefore: boolean;
}): { due: boolean; payWeek: string; why: string } {
  const payWeek = weekStartOf(input.today);
  if (!paying(input.mode)) return { due: false, payWeek, why: `No money moves in ${input.mode} mode.` };
  if (input.lastPayWeek && input.lastPayWeek >= payWeek) return { due: false, payWeek, why: "This week's payday is done." };
  if (input.retryableHeldBefore && input.today === payWeek && input.minute < PAY_WAIT_UNTIL) {
    return { due: false, payWeek, why: "Waiting for a retried read of last week before paying." };
  }
  return { due: true, payWeek, why: "Payday." };
}

export type PayoutPart = { part: number; dates: string[]; amount: number; rows: RegRow[] };

/**
 * One student's payday: which pending days are paid, and in how many
 * movements. A day is paid only if it is pending, was stamped payable when it
 * was decided, is before this week (`before`), money moves in this mode and
 * the student is not a control (payNowWhy: today's start dates are NOT asked
 * again), and it is after the last cash reset and the history cutoff.
 * Everything else is counted with why and left.
 *
 * Split so no movement passes MAX_CASH_DELTA, which Reverse refuses (L2).
 */
export function planPayout(input: {
  sn: string; rows: RegRow[]; settings: Settings; before: string; zeroPointDate: string | null; cutoffDate: string | null;
}): { parts: PayoutPart[]; skipped: Array<{ date: string; why: string; row: RegRow }> } {
  const pay: RegRow[] = [];
  const skipped: Array<{ date: string; why: string; row: RegRow }> = [];
  const seen = new Set<string>();
  for (const r of [...input.rows].sort((a, b) => a.date.localeCompare(b.date))) {
    if (r.studentNumber !== input.sn || r.status !== "pending" || r.date >= input.before) continue;
    if (seen.has(r.date)) { skipped.push({ date: r.date, why: "duplicate", row: r }); continue; }
    seen.add(r.date);
    const wait = payNowWhy(input.settings, input.sn, r);
    if (wait) { skipped.push({ date: r.date, why: wait, row: r }); continue; }
    if (input.zeroPointDate && r.date <= input.zeroPointDate) { skipped.push({ date: r.date, why: "before-reset", row: r }); continue; }
    if (input.cutoffDate && r.date < input.cutoffDate) { skipped.push({ date: r.date, why: "before-cutoff", row: r }); continue; }
    if (!validAmount(r.amount)) { skipped.push({ date: r.date, why: "bad-amount", row: r }); continue; }
    pay.push(r);
  }
  const parts: PayoutPart[] = [];
  let cur: PayoutPart | null = null;
  for (const r of pay) {
    if (!cur || cur.amount + r.amount > MAX_CASH_DELTA) {
      cur = { part: parts.length, dates: [], amount: 0, rows: [] };
      parts.push(cur);
    }
    cur.dates.push(r.date);
    cur.amount += r.amount;
    cur.rows.push(r);
  }
  return { parts, skipped };
}

/** The key that makes a payment once per student-week. */
export const payoutKeyOf = (sn: string, payWeek: string, part: number) => `${sn}|${payWeek}|${part}`;

/**
 * txn_<13-digit ms>_pd<base36>: the shape Reverse finds by index (its
 * milliseconds name the ledger week), and inside the award command's id
 * pattern. Each movement gets its own millisecond.
 */
export function payoutTxnId(ms: number, sn: string, payWeek: string, part: number): string {
  let h = 0x811c9dc5;
  for (const ch of payoutKeyOf(sn, payWeek, part)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return `txn_${String(Math.floor(ms)).padStart(13, "0")}_pd${h.toString(36)}`;
}

/** What the wallet shows: "Perfect attendance — 4 days", and the days. */
export function payoutLabel(dates: string[]): { behaviorName: string; notes: string } {
  const n = dates.length;
  return { behaviorName: `Perfect attendance — ${n} day${n === 1 ? "" : "s"}`, notes: dates.map(shortDay).join(", ") };
}

/**
 * The ledger row, field for field the shape every reader expects (see
 * cashAwardRules.buildLedgerRow), with the three reserved marks. ALWAYS a
 * kind: a kindless row would fall back to its sign and count as an award.
 */
export function buildPayoutRow(input: {
  txnId: string; at: string; appStudentId: string;
  student: { firstName?: unknown; lastName?: unknown; grade?: unknown };
  amount: number; dates: string[]; balanceAfter: number;
}): Record<string, unknown> {
  const label = payoutLabel(input.dates);
  return {
    id: input.txnId,
    timestamp: input.at,
    studentId: input.appStudentId,
    studentName: `${input.student.firstName ?? ""} ${input.student.lastName ?? ""}`.trim(),
    studentGrade: String(input.student.grade ?? ""),
    school: schoolOf(input.student.grade),
    teacherId: SYSTEM_ACTOR.id,
    teacherUsername: "",
    teacherName: SYSTEM_ACTOR.name,
    kind: PERFECT_DAY_KIND,
    type: "positive",
    behaviorId: PERFECT_DAY_BEHAVIOR_ID,
    behaviorName: label.behaviorName,
    amount: input.amount,
    notes: label.notes,
    balanceAfter: input.balanceAfter,
  };
}

/** The day this pending day's money arrives: the Monday after its week. */
export const paydayFor = (date: string): string => addDays(weekStartOf(date), 7);

/** The cron's firings (crons.ts, "perfect day award"): :42 past these hours, UTC, every day. */
export const TICK_UTC_HOURS = [14, 15, 16, 17];
export const TICK_UTC_MINUTE = 42;

/**
 * THE NEXT PAYDAY, AS THE ADMIN CARD SAYS IT: the school date the money will
 * actually move, and the week it pays up to (every pending day before
 * `payWeek`). It is the first cron firing decideTick would run at (a weekday
 * morning whose run is not done) in a week whose payday has not run yet.
 * Never a date gone by: a Monday whose payday did not happen (the switch came
 * on midweek) is the next run, not that Monday. Only for a mode that pays.
 */
export function nextPaydayOf(input: { nowIso: string; tz: string; lastDoneDate: string | null; lastPayWeek: string | null }):
  { date: string; payWeek: string } | null {
  const now = Date.parse(input.nowIso);
  if (!Number.isFinite(now)) return null;
  const day0 = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  for (let k = 0; k <= 16; k++) {
    for (const h of TICK_UTC_HOURS) {
      const at = day0 + k * 86400000 + (h * 60 + TICK_UTC_MINUTE) * 60000;
      if (at <= now) continue;
      const d = decideTick({ mode: "live", nowIso: new Date(at).toISOString(), tz: input.tz, lastDoneDate: input.lastDoneDate, lease: null });
      if (d.do !== "run") continue;
      const payWeek = weekStartOf(d.today);
      if (input.lastPayWeek && payWeek <= input.lastPayWeek) continue;
      return { date: d.today, payWeek };
    }
  }
  return null;
}

/**
 * WHAT THE STUDENT SEES: their perfect days that WILL be paid, and when --
 * exactly the days payday pays (payNowWhy). Null when no money moves for them
 * at all (off, shadow, a control, or outside the pilot with nothing earned
 * still to come), so nothing is promised that will not arrive (review H2).
 */
export function pendingForStudent(input: { settings: Settings; sn: string; rows: RegRow[] }):
  null | { days: string[]; amount: number; payday: string | null } {
  const { settings, sn } = input;
  const days = input.rows
    .filter((r) => r.studentNumber === sn && r.status === "pending" && payNowWhy(settings, sn, r) === null)
    .sort((a, b) => a.date.localeCompare(b.date));
  // No day to pay, and none can come (off, shadow, a control, outside the pilot): promise nothing.
  if (!days.length && !payableFrom(settings, sn)) return null;
  return {
    days: days.map((r) => r.date),
    amount: days.reduce((a, r) => a + r.amount, 0),
    payday: days.length ? paydayFor(days[0].date) : null,
  };
}
