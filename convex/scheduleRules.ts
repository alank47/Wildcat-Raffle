/**
 * Bell schedules, section expressions, and the one question this file exists to
 * answer: WHICH CLASS IS THIS STUDENT IN RIGHT NOW.
 *
 * Pure. No ctx, no database, no clock of its own, no Convex imports, and no
 * imports at all. The last part is not stylistic: the tests are plain `.mjs`
 * files that import this `.ts` directly, and Node will not resolve an
 * extensionless specifier out of a stripped-types module. views.ts says the
 * same thing beside dayCount. So everything the decision needs arrives as an
 * argument, including the current instant.
 *
 * WHY THIS IS APP-OWNED CONFIGURATION AND NOT SIS DATA. The PowerSchool plugin
 * manifest grants Sections, CC, Courses, Teachers, Terms, Users, Students,
 * Attendance and PGFinalGrades. It does NOT grant a Period table, a
 * BellSchedule table, or Sections.Room. `Sections.Expression` carries the period
 * and the cycle days ("1(A-E)") and never a clock time. So the mapping from a
 * wall clock to a period number does not exist anywhere we can read, and it has
 * to be typed in by an admin exactly like the tap locations are. That is not a
 * workaround; it is the only honest source available.
 *
 * THE RULE THAT SHAPES EVERY FUNCTION BELOW: a pass attributed to the wrong
 * teacher is worse than a pass that asks. Every failure here is returned as a
 * refusal with a code and a sentence a fourteen year old can act on, never as a
 * best guess, never as a default period, and never as a zero. Lunch, passing
 * periods, before school, after school, a weekend and an unmapped cycle day are
 * all REAL STATES that a student can be standing in at the moment they ask, and
 * each one gets its own answer.
 */

// ===========================================================================
// Clock arithmetic. Minutes after local midnight, everywhere.
// ===========================================================================

/** Minutes in a day. A period may end exactly here (23:59 is 1439, 24:00 is 1440). */
export const MINUTES_IN_DAY = 1440;

/** A ceiling on how many rows one schedule may hold. A school day is not 200 periods. */
export const MAX_PERIODS_PER_SCHEDULE = 24;

/** Longest a period label may be. "Advisory" fits; a paragraph does not. */
export const MAX_PERIOD_LABEL_LENGTH = 16;

/** Longest raw expression this will look at, before any regex touches it. */
export const MAX_EXPRESSION_LENGTH = 200;

/** Ceiling on meetings parsed out of one expression, so a hostile string is bounded. */
export const MAX_MEETINGS_PER_EXPRESSION = 40;

export type Verdict = { ok: boolean; reason: string };

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * "08:15" -> 495. Anything that is not a real time of day -> null.
 *
 * NULL, NOT ZERO, and the difference is the whole file. Zero is midnight, a
 * perfectly valid start time, so a parser that returned 0 for "" would place a
 * period at midnight and every student asking at 00:05 would be routed into it.
 * Every caller must test for null.
 *
 * Deliberately strict about the shape. "8" alone is refused: it could be 8am or
 * eight minutes, and picking one silently is how a schedule ends up an hour out
 * with nothing on screen to show it. "24:00" is accepted as the end of the day
 * because a last period that runs to midnight has to be expressible.
 */
export function parseClock(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 5 + 3) return null;
  const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(text);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (minutes > 59) return null;
  const total = hours * 60 + minutes;
  if (total > MINUTES_IN_DAY) return null;
  return total;
}

/** 495 -> "08:15". An unusable value gives "", never "00:00". */
export function formatClock(minuteOfDay: unknown): string {
  if (typeof minuteOfDay !== "number" || !Number.isInteger(minuteOfDay)) return "";
  if (minuteOfDay < 0 || minuteOfDay > MINUTES_IN_DAY) return "";
  return `${pad2(Math.floor(minuteOfDay / 60))}:${pad2(minuteOfDay % 60)}`;
}

// ===========================================================================
// The instant -> the school's own wall clock.
// ===========================================================================

export type LocalTime = {
  /** YYYY-MM-DD in the school's time zone. The key a day override is stored under. */
  dateKey: string;
  /** 0 Sunday .. 6 Saturday, in the school's time zone. */
  weekday: number;
  /** Minutes after local midnight. */
  minuteOfDay: number;
};

export type LocalTimeResult =
  | ({ ok: true } & LocalTime)
  | { ok: false; code: string; reason: string };

/**
 * The instant, as the wall clock on the wall of the school reads it.
 *
 * TIMESTAMPS ARE STORED AS UTC ISO STRINGS and the school is not in UTC, so
 * every function below would be wrong by a fixed offset without this, and wrong
 * by a DIFFERENT offset for half the year. hallPassRules.SCHOOL_DAY_ROLLOVER
 * accepts an hour of DST drift because its boundary is 4am and nobody is on
 * site; a period boundary is at 09:47 and an hour of drift routes a request to
 * the teacher of the period before. So this goes through the time zone database
 * rather than an offset somebody typed.
 *
 * The zone is a SETTING, not a constant, and an unusable one is refused rather
 * than swapped for a guess: a silently defaulted zone is the same wrong-teacher
 * failure with nothing on screen to explain it.
 */
export function localSchoolTime(iso: unknown, timeZone: unknown): LocalTimeResult {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) {
    return {
      ok: false,
      code: "unreadable-clock",
      reason: "The server could not read the current time, so no period can be worked out.",
    };
  }
  if (typeof timeZone !== "string" || !timeZone.trim()) {
    return {
      ok: false,
      code: "no-timezone",
      reason:
        "No school time zone is set, so the app cannot tell what time it is here. " +
        "An admin sets it in Settings > Bell Schedule.",
    };
  }

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(t));
  } catch {
    return {
      ok: false,
      code: "bad-timezone",
      reason:
        `"${timeZone}" is not a time zone this app can read. Use a name like ` +
        `America/Los_Angeles, in Settings > Bell Schedule.`,
    };
  }

  const value = (type: string) => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : NaN;
  };
  const year = value("year");
  const month = value("month");
  const day = value("day");
  const rawHour = value("hour");
  const minute = value("minute");

  if (![year, month, day, rawHour, minute].every((n) => Number.isFinite(n))) {
    return {
      ok: false,
      code: "unreadable-clock",
      reason: "The server could not read the current time, so no period can be worked out.",
    };
  }

  // Some ICU builds render midnight as hour 24 under hour12:false. Left
  // unhandled it produces minuteOfDay 1440, which is past every period, so
  // every student asking at midnight would be told school is over rather than
  // that it has not started.
  const hour = rawHour % 24;

  return {
    ok: true,
    dateKey: `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`,
    // Computed from the LOCAL date rather than read out of a locale string, so
    // it cannot depend on which language the runtime happens to format in.
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    minuteOfDay: hour * 60 + minute,
  };
}

/** A YYYY-MM-DD key, or "" when the input is not one. Never a guessed date. */
export function normalizeDateKey(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return "";
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  // Round-tripped, so 2026-02-30 is refused rather than silently rolling into March.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return "";
  return text;
}

// ===========================================================================
// The bell schedule itself.
// ===========================================================================

export type BellPeriod = { label: string; startMinute: number; endMinute: number };

export type BellSchedule = {
  name: string;
  periods: BellPeriod[];
  /** 0 Sunday .. 6 Saturday. Which days this schedule is used on at all. */
  weekdays: number[];
};

/**
 * Normalize a period label so "01", " 1 " and "1" are one period.
 *
 * A section expression is typed by whoever built the master schedule in
 * PowerSchool and a bell schedule is typed by an admin in this app. They are
 * two humans typing the same number into two systems, so the comparison between
 * them has to survive a leading zero and a stray space. Without this, every
 * student in a section written "01(A-E)" is told they have no class, forever,
 * on a screen that looks fine.
 */
export function normalizePeriodLabel(raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  const text = String(raw).trim().toUpperCase().replace(/\s+/g, " ");
  if (!text) return "";
  if (/^\d+$/.test(text)) {
    // Leading zeros only. Not parsed as a number: "007" must become "7", and a
    // label of 400 digits must not become Infinity.
    const stripped = text.replace(/^0+(?=\d)/, "");
    return stripped;
  }
  return text;
}

/**
 * Check a schedule an admin just typed, before it can route a single request.
 *
 * OVERLAPS ARE REFUSED rather than resolved. Two periods covering 10:05 means
 * the answer to "which class is this student in" depends on the order rows
 * happen to be stored in, which is a coin flip performed on a child's record.
 * The refusal names both rows so the person fixing it does not have to hunt.
 */
export function validatePeriods(
  raw: unknown,
): Verdict & { periods?: BellPeriod[] } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: "A bell schedule needs at least one period." };
  }
  if (raw.length > MAX_PERIODS_PER_SCHEDULE) {
    return {
      ok: false,
      reason: `A bell schedule can hold at most ${MAX_PERIODS_PER_SCHEDULE} periods.`,
    };
  }

  const cleaned: BellPeriod[] = [];
  for (const row of raw as Array<Record<string, unknown>>) {
    const label = typeof row?.label === "string" ? row.label.trim().replace(/\s+/g, " ") : "";
    if (!label) return { ok: false, reason: "Every period needs a name, for example 1 or Advisory." };
    if (label.length > MAX_PERIOD_LABEL_LENGTH) {
      return {
        ok: false,
        reason: `"${label.slice(0, 20)}..." is too long for a period name. Keep it under ${MAX_PERIOD_LABEL_LENGTH} characters.`,
      };
    }

    const start = row?.startMinute;
    const end = row?.endMinute;
    for (const [which, n] of [["start", start], ["end", end]] as const) {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MINUTES_IN_DAY) {
        return {
          ok: false,
          reason: `Period "${label}" needs a real ${which} time, between 00:00 and 24:00.`,
        };
      }
    }
    if ((start as number) >= (end as number)) {
      return {
        ok: false,
        reason:
          `Period "${label}" ends at or before it starts ` +
          `(${formatClock(start as number)} to ${formatClock(end as number)}).`,
      };
    }

    cleaned.push({ label, startMinute: start as number, endMinute: end as number });
  }

  const seen = new Set<string>();
  for (const p of cleaned) {
    const key = normalizePeriodLabel(p.label);
    if (seen.has(key)) {
      return {
        ok: false,
        reason:
          `Two periods are both called "${p.label}". A period name is what a ` +
          `section's expression is matched against, so it has to be unique.`,
      };
    }
    seen.add(key);
  }

  const sorted = [...cleaned].sort((a, b) => a.startMinute - b.startMinute);
  for (let i = 1; i < sorted.length; i++) {
    const before = sorted[i - 1];
    const now = sorted[i];
    if (now.startMinute < before.endMinute) {
      return {
        ok: false,
        reason:
          `"${before.label}" (${formatClock(before.startMinute)}-${formatClock(before.endMinute)}) ` +
          `and "${now.label}" (${formatClock(now.startMinute)}-${formatClock(now.endMinute)}) ` +
          `overlap. Two periods covering the same minute means the app would have to ` +
          `guess which teacher a request belongs to.`,
      };
    }
  }

  return { ok: true, reason: "", periods: sorted };
}

/** 0..6, unique, at least one. A schedule that covers no days can never be used. */
export function validateWeekdays(raw: unknown): Verdict & { weekdays?: number[] } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      reason: "Say which days of the week this schedule is used on.",
    };
  }
  const out = new Set<number>();
  for (const d of raw) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6) {
      return { ok: false, reason: "Days of the week are 0 (Sunday) to 6 (Saturday)." };
    }
    out.add(d);
  }
  return { ok: true, reason: "", weekdays: [...out].sort((a, b) => a - b) };
}

/** The school's own cycle letters, e.g. A..E. Empty means the school has no cycle. */
export function validateCycleDays(raw: unknown): Verdict & { cycleDays?: string[] } {
  if (raw === undefined || raw === null) return { ok: true, reason: "", cycleDays: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "Cycle days are a list, for example A, B, C, D, E." };
  }
  if (raw.length > 26) {
    return { ok: false, reason: "A day cycle longer than 26 days is not a day cycle." };
  }
  const out: string[] = [];
  for (const d of raw) {
    const text = typeof d === "string" ? d.trim().toUpperCase() : "";
    if (!text || text.length > 4) {
      return { ok: false, reason: "Each cycle day is a short label like A or Day1." };
    }
    if (!out.includes(text)) out.push(text);
  }
  return { ok: true, reason: "", cycleDays: out };
}

export type PeriodResult =
  | { ok: true; period: BellPeriod; minutesLeft: number }
  | { ok: false; code: string; reason: string };

/**
 * Which period the clock is in.
 *
 * THE INTERVAL IS HALF OPEN, [start, end). A bell at 09:00 that ends period 1
 * and starts period 2 belongs to period 2. Closed intervals would put 09:00 in
 * both, and "both" is the same coin flip validatePeriods refuses to store.
 *
 * EVERY WAY OF BEING IN NO PERIOD GETS ITS OWN CODE, because they are different
 * facts about a child standing in a corridor and the honest message differs:
 * before school and after school are not the same as lunch, and a Saturday is
 * not the same as either. A single "unknown" would make all four read as a bug.
 */
export function periodAt(schedule: BellSchedule | null, local: LocalTime): PeriodResult {
  if (!schedule || !Array.isArray(schedule.periods) || schedule.periods.length === 0) {
    return {
      ok: false,
      code: "no-schedule",
      reason:
        "No bell schedule is set up, so the app cannot tell which class you are in. " +
        "An admin adds one in Settings > Bell Schedule.",
    };
  }

  const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays : [];
  if (weekdays.length > 0 && !weekdays.includes(local.weekday)) {
    return {
      ok: false,
      code: "day-not-covered",
      reason:
        `Today is not a day the ${schedule.name} schedule covers, so there is no ` +
        `class period to send this to.`,
    };
  }

  const inside = schedule.periods.find(
    (p) => local.minuteOfDay >= p.startMinute && local.minuteOfDay < p.endMinute,
  );
  if (inside) {
    return { ok: true, period: inside, minutesLeft: inside.endMinute - local.minuteOfDay };
  }

  const earliest = schedule.periods.reduce(
    (min, p) => Math.min(min, p.startMinute),
    MINUTES_IN_DAY + 1,
  );
  const latest = schedule.periods.reduce((max, p) => Math.max(max, p.endMinute), -1);

  if (local.minuteOfDay < earliest) {
    return {
      ok: false,
      code: "before-school",
      reason: `The school day has not started yet. The first period begins at ${formatClock(earliest)}.`,
    };
  }
  if (local.minuteOfDay >= latest) {
    return {
      ok: false,
      code: "after-school",
      reason: `The school day is over. The last period ended at ${formatClock(latest)}.`,
    };
  }
  return {
    ok: false,
    code: "between-periods",
    reason:
      "You are between periods right now, so there is no class to send this to. " +
      "Ask a teacher to start the pass for you.",
  };
}

// ===========================================================================
// Sections.Expression: the period and the cycle days, and never a clock time.
// ===========================================================================

/** One "this section meets at THIS period on THESE cycle days" pair. */
export type Meeting = {
  period: string;
  /** Empty means the expression named no days, which is "every day it runs". */
  days: string[];
};

export type ParsedExpression = { meetings: Meeting[]; understood: boolean };

function expandPeriodToken(token: string): string[] {
  const text = token.trim();
  if (!text) return [];
  const range = /^(\d{1,3})\s*-\s*(\d{1,3})$/.exec(text);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    // A range that runs backwards, or 1-99, is not a period range anybody meant.
    if (to < from || to - from > 20) return [normalizePeriodLabel(text)].filter(Boolean);
    const out: string[] = [];
    for (let n = from; n <= to; n++) out.push(String(n));
    return out;
  }
  const label = normalizePeriodLabel(text);
  return label ? [label] : [];
}

function expandDayToken(token: string): string[] {
  const text = token.trim().toUpperCase();
  if (!text) return [];
  const range = /^([A-Z])\s*-\s*([A-Z])$/.exec(text);
  if (range) {
    const from = range[1].charCodeAt(0);
    const to = range[2].charCodeAt(0);
    if (to < from) return [text];
    const out: string[] = [];
    for (let c = from; c <= to; c++) out.push(String.fromCharCode(c));
    return out;
  }
  return [text];
}

/**
 * Parse `Sections.Expression` into period/cycle-day pairs.
 *
 * THE PAIRING IS THE POINT. "1(A),3(B)" is period 1 on A days and period 3 on B
 * days. Flattening that into periods [1,3] and days [A,B] says the section meets
 * at period 3 on an A day, which it does not, and that is a request routed to a
 * teacher who is not in front of the child.
 *
 * Tolerant on the way in because this string is typed by whoever built the
 * master schedule: "1(A-E)", "1,2(A-E)", "4-5(A-E)", "HR(A-E)", "1(A) 2(B)" and
 * a bare "3" all parse. Anything it cannot make sense of comes back with
 * understood:false rather than as an empty schedule, because "this section meets
 * nowhere" and "nobody could read this" are different facts and only one of them
 * is the section's fault.
 */
export function parseSectionExpression(raw: unknown): ParsedExpression {
  if (typeof raw !== "string") return { meetings: [], understood: false };
  const text = raw.trim();
  // Length capped before any regex touches it, for the reason tapSlug.ts caps a
  // slug: this string arrives from an upstream system and is not a wall label.
  if (!text || text.length > MAX_EXPRESSION_LENGTH) {
    return { meetings: [], understood: false };
  }

  const meetings: Meeting[] = [];
  let buffer = "";

  const emit = (periodPart: string, dayPart: string | null) => {
    const periods = periodPart
      .split(",")
      .flatMap(expandPeriodToken)
      .filter(Boolean);
    if (periods.length === 0) return;
    const days =
      dayPart === null
        ? []
        : [...new Set(dayPart.split(",").flatMap(expandDayToken).filter(Boolean))];
    for (const period of periods) {
      if (meetings.length >= MAX_MEETINGS_PER_EXPRESSION) return;
      meetings.push({ period, days });
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") {
      const close = text.indexOf(")", i + 1);
      if (close === -1) {
        // Unbalanced. Treat the rest as periods rather than dropping it.
        buffer += text.slice(i + 1);
        i = text.length;
        break;
      }
      emit(buffer, text.slice(i + 1, close));
      buffer = "";
      i = close;
      continue;
    }
    if (ch === ";") {
      emit(buffer, null);
      buffer = "";
      continue;
    }
    buffer += ch;
  }
  if (buffer.trim()) emit(buffer, null);

  return { meetings, understood: meetings.length > 0 };
}

// ===========================================================================
// Meal periods. The three meals — breakfast, nutrition, lunch — are read off
// the CURRENT bell period's LABEL, not a separate table, so "which meal is it"
// always agrees with the schedule actually running today. A period whose label
// names a meal is that meal; a class, Promise Time or a passing gap is no meal.
// ===========================================================================
export type MealKind = "breakfast" | "nutrition" | "lunch";

export function mealFromPeriodLabel(label: unknown): MealKind | null {
  const s = String(label ?? "").toLowerCase();
  if (/breakfast/.test(s)) return "breakfast";
  if (/nutrition/.test(s)) return "nutrition";
  if (/lunch/.test(s)) return "lunch";
  return null;
}

export function mealLabel(kind: MealKind): string {
  return kind === "breakfast"
    ? "Breakfast"
    : kind === "nutrition"
      ? "Nutrition"
      : "Lunch";
}

// ===========================================================================
// Section -> "is this the class the student is sitting in right now".
// ===========================================================================

/** Only the columns this decision reads. Everything else on a roster row is none of its business. */
export type SectionLike = {
  sectionId?: string | null;
  sectionNumber?: string | null;
  sectionExpression?: string | null;
  period?: string | null;
  courseName?: string | null;
  courseNumber?: string | null;
  teacherEmail?: string | null;
  teacherFirstName?: string | null;
  teacherLastName?: string | null;
  termAbbreviation?: string | null;
};

export type SectionMatch =
  /** Meets at this period no matter what today's cycle day is. */
  | { kind: "definite"; section: SectionLike }
  /** Meets at this period only on certain cycle days, and we were not told today's. */
  | { kind: "conditional"; section: SectionLike; days: string[] }
  | { kind: "none" };

/**
 * Does this section meet at `period`, and does the answer depend on the cycle day.
 *
 * `schoolCycleDays` is what turns "(A-E)" from a constraint into no constraint:
 * a section that meets on every day of the school's own cycle meets every day,
 * so today's letter is irrelevant and the answer is DEFINITE. Without that
 * knowledge every section at a school with a five day cycle would be
 * conditional, and every student would be told to go and find a teacher.
 */
export function classifySection(
  section: SectionLike,
  period: string,
  schoolCycleDays: string[] = [],
): SectionMatch {
  const wanted = normalizePeriodLabel(period);
  if (!wanted) return { kind: "none" };

  // sectionExpression is the real column. `period` is written by the sync as a
  // copy of it (sisAction.ts), so it is the same string and is used only when
  // the expression is missing.
  const parsed = parseSectionExpression(section.sectionExpression ?? section.period ?? "");
  const matching = parsed.meetings.filter((m) => normalizePeriodLabel(m.period) === wanted);
  if (matching.length === 0) return { kind: "none" };

  const cycle = schoolCycleDays.map((d) => String(d).trim().toUpperCase()).filter(Boolean);

  // Any one unconstrained meeting is enough: the section is at this period today.
  if (matching.some((m) => m.days.length === 0)) return { kind: "definite", section };

  if (cycle.length > 0) {
    const coversWholeCycle = matching.some((m) => {
      const days = new Set(m.days);
      return cycle.every((d) => days.has(d));
    });
    if (coversWholeCycle) return { kind: "definite", section };
  }

  const days = [...new Set(matching.flatMap((m) => m.days))];
  return { kind: "conditional", section, days };
}

export type CurrentSectionResult =
  | {
      ok: true;
      section: SectionLike;
      teacherEmail: string;
      period: string;
    }
  | { ok: false; code: string; reason: string };

/**
 * The class this student is scheduled into at `period`, or an honest refusal.
 *
 * NOTHING IS PICKED WHEN THE ANSWER IS NOT SINGULAR. Two candidate sections and
 * no way to choose between them produces a refusal, not the first row: a hall
 * pass names one teacher, and naming the wrong one is exactly the outcome this
 * whole rewrite exists to prevent.
 *
 * A SECTION WITH NO TEACHER EMAIL IS A REFUSAL TOO. The address is the routing
 * key, so a section that has none cannot receive a request; a pass created
 * anyway would sit in a queue nobody owns until the sweep expired it, and the
 * student would have waited two hours to find out.
 */
export function resolveCurrentSection(
  candidates: SectionLike[],
  opts: { period: string; cycleDay?: string | null; schoolCycleDays?: string[] },
): CurrentSectionResult {
  const period = normalizePeriodLabel(opts.period);
  if (!period) {
    return {
      ok: false,
      code: "no-period",
      reason: "No period was worked out, so there is no class to send this to.",
    };
  }

  const rows = Array.isArray(candidates) ? candidates : [];
  const classified = rows.map((s) => classifySection(s, period, opts.schoolCycleDays ?? []));
  const definite = classified.filter((c) => c.kind === "definite") as Array<{
    kind: "definite";
    section: SectionLike;
  }>;
  const conditional = classified.filter((c) => c.kind === "conditional") as Array<{
    kind: "conditional";
    section: SectionLike;
    days: string[];
  }>;

  if (definite.length === 0 && conditional.length === 0) {
    return {
      ok: false,
      code: "no-class-this-period",
      reason:
        `Your timetable does not show a class in period ${period} right now. ` +
        `Ask a teacher to start the pass for you.`,
    };
  }

  const cycleDay = typeof opts.cycleDay === "string" ? opts.cycleDay.trim().toUpperCase() : "";

  let meeting: SectionLike[];
  if (cycleDay) {
    meeting = [
      ...definite.map((c) => c.section),
      ...conditional.filter((c) => c.days.includes(cycleDay)).map((c) => c.section),
    ];
    if (meeting.length === 0) {
      return {
        ok: false,
        code: "no-class-this-period",
        reason:
          `Your period ${period} class does not meet on a ${cycleDay} day, and today is ` +
          `a ${cycleDay} day. Ask a teacher to start the pass for you.`,
      };
    }
  } else if (conditional.length > 0) {
    // We cannot tell whether these meet today, and picking one anyway is the
    // wrong-teacher failure. Named precisely so an admin can fix it once.
    return {
      ok: false,
      code: "unknown-cycle-day",
      reason:
        `Your period ${period} class only meets on certain days of the cycle, and ` +
        `today's cycle day has not been set in the app. Ask a teacher to start the ` +
        `pass for you.`,
    };
  } else {
    meeting = definite.map((c) => c.section);
  }

  if (meeting.length > 1) {
    return {
      ok: false,
      code: "ambiguous-section",
      reason:
        `Your timetable shows more than one class in period ${period} right now, so ` +
        `the app cannot tell whose room you are in. Ask a teacher to start the pass ` +
        `for you.`,
    };
  }

  const section = meeting[0];
  const teacherEmail = String(section.teacherEmail ?? "").trim().toLowerCase();
  if (!teacherEmail) {
    return {
      ok: false,
      code: "no-teacher-for-section",
      reason:
        `Your period ${period} class has no teacher email on file, so there is nobody ` +
        `to send this to. Ask a teacher to start the pass for you.`,
    };
  }

  return { ok: true, section, teacherEmail, period };
}

/** "Ms Vega" out of the roster columns, or "" rather than a stray space. */
export function teacherLabel(section: SectionLike | null | undefined): string {
  if (!section) return "";
  return [section.teacherFirstName, section.teacherLastName]
    .map((n) => String(n ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

// ===========================================================================
// The classroom tag: what a return tap has to land on.
// ===========================================================================

export type TagLike = {
  _id?: unknown;
  slug?: string;
  name?: string;
  kind?: string;
  active?: boolean;
  sectionId?: string | null;
  teacherEmail?: string | null;
};

export type TagResult =
  | { ok: true; tag: TagLike }
  | { ok: false; code: string; reason: string };

/**
 * Which wall tag is the classroom this pass has to be closed at.
 *
 * WHY A PASS CANNOT EXIST WITHOUT ONE. applyTap decides a tap by comparing it
 * against the pass's origin: the first tap must NOT be the origin, and the
 * second must be. That ordering is the only thing stopping a student tapping
 * the classroom tag on the way out and closing a pass they never took. With no
 * origin there is nothing to compare against and the property is gone, so a
 * section with no tag is refused at request time and told so, rather than
 * issuing a pass that cannot be closed honestly.
 *
 * SECTION FIRST, TEACHER SECOND. A tag tied to the exact section is the precise
 * answer; a tag tied to the teacher is the useful one for a teacher who has one
 * room. Two tags claiming the same teacher is a configuration mistake and is
 * refused rather than resolved, because "whichever came back first" is not a
 * room.
 */
export function pickClassroomTag(
  tags: TagLike[],
  target: { sectionId?: string | null; teacherEmail?: string | null },
): TagResult {
  const rows = (Array.isArray(tags) ? tags : []).filter((t) => t && t.active !== false);

  const sectionId = String(target.sectionId ?? "").trim();
  if (sectionId) {
    const bySection = rows.filter((t) => String(t.sectionId ?? "").trim() === sectionId);
    if (bySection.length === 1) return { ok: true, tag: bySection[0] };
    if (bySection.length > 1) {
      return {
        ok: false,
        code: "ambiguous-classroom-tag",
        reason:
          "More than one wall tag is registered to this class, so the app cannot tell " +
          "which one ends the pass. An admin fixes it in Settings > NFC Tags.",
      };
    }
  }

  const teacherEmail = String(target.teacherEmail ?? "").trim().toLowerCase();
  if (teacherEmail) {
    const byTeacher = rows.filter(
      (t) => String(t.teacherEmail ?? "").trim().toLowerCase() === teacherEmail,
    );
    if (byTeacher.length === 1) return { ok: true, tag: byTeacher[0] };
    if (byTeacher.length > 1) {
      return {
        ok: false,
        code: "ambiguous-classroom-tag",
        reason:
          "More than one wall tag is registered to this teacher, so the app cannot tell " +
          "which room ends the pass. An admin fixes it in Settings > NFC Tags.",
      };
    }
  }

  return {
    ok: false,
    code: "no-classroom-tag",
    reason:
      "There is no wall tag registered for this classroom yet, and the pass has to be " +
      "tapped back in somewhere. Ask your teacher to start the pass, and ask an admin " +
      "to register the room's tag.",
  };
}

/**
 * Which named schedule today runs on.
 *
 * AN EXPLICIT CHOICE, NEVER AN INFERENCE. Every school has a minimum day and an
 * assembly day, and there is nothing in any table that says which one today is.
 * So a day is either marked, or it falls to the schedule an admin has named as
 * the usual one, or it is UNKNOWN, and unknown is an answer this returns rather
 * than papering over. A guessed schedule is a guessed period is a guessed
 * teacher.
 *
 * `override` is the row for today's date, if somebody set one. `noSchool` on it
 * is a first class answer: a holiday is not the same as a schedule nobody chose.
 */
export function scheduleForDay(
  override: { noSchool?: boolean; scheduleId?: unknown; note?: string } | null,
  schedules: Array<{ _id?: unknown; name: string; periods: BellPeriod[]; weekdays: number[] }>,
  defaultScheduleId: unknown,
):
  | { ok: true; schedule: { _id?: unknown; name: string; periods: BellPeriod[]; weekdays: number[] }; source: "override" | "default" }
  | { ok: false; code: string; reason: string } {
  const rows = Array.isArray(schedules) ? schedules : [];

  if (override && override.noSchool === true) {
    return {
      ok: false,
      code: "no-school-today",
      reason:
        "Today is marked as a day with no classes, so there is no teacher to send a " +
        "pass request to.",
    };
  }

  if (override && override.scheduleId !== undefined && override.scheduleId !== null) {
    const found = rows.find((s) => String(s._id) === String(override.scheduleId));
    if (found) return { ok: true, schedule: found, source: "override" };
    return {
      ok: false,
      code: "missing-schedule",
      reason:
        "Today is set to a bell schedule that no longer exists. An admin fixes it in " +
        "Settings > Bell Schedule.",
    };
  }

  if (defaultScheduleId !== undefined && defaultScheduleId !== null) {
    const found = rows.find((s) => String(s._id) === String(defaultScheduleId));
    if (found) return { ok: true, schedule: found, source: "default" };
  }

  return {
    ok: false,
    code: "no-schedule-today",
    reason:
      "No bell schedule has been chosen for today, so the app cannot tell which class " +
      "you are in. An admin sets the usual schedule in Settings > Bell Schedule.",
  };
}
