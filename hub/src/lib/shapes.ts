/**
 * THE TWO RESPONSE SHAPES.
 *
 * `views_app:myStudentView` is deployed on production in an OLDER form than the
 * one on this branch:
 *
 *   deployed (legacy)   grades:   GradeCell[]          schedule: ClassRow[]
 *   this branch (panel) grades:   {available, reason, courses: GradeCell[]}
 *                       schedule: {available, reason, classes:  ClassRow[]}
 *
 * Both are handled, here and nowhere else, so there is one place to delete when
 * the backend catches up. Every caller receives a Panel<T> and never sees the
 * difference.
 *
 * WHY THIS IS THE MOST DANGEROUS FILE IN THE APP. Reading `.courses` off the
 * legacy array yields `undefined`; `?? []` then renders an empty grades panel.
 * A student with no grades and a broken parse look identical on screen, which is
 * the exact bug this project has shipped twice. So:
 *
 *   - The shape that was actually seen is recorded on every panel (`shape`) and
 *     shown on screen in the provenance line.
 *   - A shape that is NEITHER array NOR panel is `available:false` with a reason
 *     that says the app could not read the reply — never an empty list.
 *   - A LEGACY EMPTY ARRAY IS NOT REPORTED AS "no grades". The legacy shape
 *     carries no availability flag, so "no rows" and "we could not look you up"
 *     are the same value. It is reported as `unknownWhy: true` and the screen
 *     says so, because the honest answer is that the server did not say.
 */

export type Panel<T> = {
  /** false means DO NOT render a list. Render `reason`. */
  available: boolean;
  /** Server's words when it has them, ours when it does not. Never invented. */
  reason: string | null;
  items: T[];
  /** Which wire shape produced this, for the provenance line. */
  shape: "panel" | "legacy-array" | "unreadable";
  /**
   * True when the list is empty AND the shape could not tell us why. Only the
   * legacy array can produce this. The screen must not say "no grades yet".
   */
  unknownWhy: boolean;
};

export type GradeCell = {
  courseName: string | null;
  courseNumber: string | null;
  currentGrade: string | null;
  currentPercent: number | null;
  available: boolean;
};

export type ClassRow = {
  courseName: string | null;
  courseNumber: string | null;
  period: string | null;
  teacher: string | null;
  term: string | null;
};

function unreadable<T>(what: string): Panel<T> {
  return {
    available: false,
    reason:
      `The server's reply did not contain a ${what} panel this app can read. ` +
      `This is an app problem, not something missing from your record — ` +
      `nothing here should be taken as "you have none".`,
    items: [],
    shape: "unreadable",
    unknownWhy: true,
  };
}

/**
 * @param raw     the field as it came off the wire
 * @param key     the panel-shape key for the list ("courses" | "classes")
 * @param what    human name, used only in the app's own reason text
 */
export function toPanel<T>(raw: unknown, key: string, what: string): Panel<T> {
  if (raw === null || raw === undefined) return unreadable<T>(what);

  // ---- Legacy: the deployed backend returns the bare array. ----
  if (Array.isArray(raw)) {
    return {
      available: true,
      reason: null,
      items: raw as T[],
      shape: "legacy-array",
      // An empty legacy array cannot distinguish "nothing on file" from
      // "we could not look you up". Say so rather than pick one.
      unknownWhy: raw.length === 0,
    };
  }

  if (typeof raw !== "object") return unreadable<T>(what);

  const obj = raw as Record<string, unknown>;

  // ---- Panel: this branch's {available, reason, courses|classes}. ----
  if (typeof obj.available === "boolean") {
    const list = obj[key];
    const items = Array.isArray(list) ? (list as T[]) : [];

    // available:true with a non-array list is a contract break, not an empty
    // record. Refuse it rather than render zero rows.
    if (obj.available && !Array.isArray(list)) return unreadable<T>(what);

    return {
      available: obj.available,
      reason: typeof obj.reason === "string" ? obj.reason : null,
      items,
      shape: "panel",
      unknownWhy: false,
    };
  }

  return unreadable<T>(what);
}

/** A number the SIS may simply not have. Never 0, never NaN, never negative. */
export function count(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

/** Money. Same rule, and it matters more: a missing balance is not $0. */
export function money(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

export function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * `{available, value, reason}` — the shape passCard.mine uses for the student
 * number, the lunch id and the Clever badge. Unlike the grades panel this one
 * has never had a second form, but it is normalized here anyway so a missing
 * field cannot reach a card as `undefined`.
 */
export type Slot = {
  available: boolean;
  value: string | null;
  reason: string | null;
  format: string | null;
};

export function toSlot(raw: unknown, what: string): Slot {
  if (!raw || typeof raw !== "object") {
    return {
      available: false,
      value: null,
      reason: `The server did not send the ${what} for this card.`,
      format: null,
    };
  }
  const obj = raw as Record<string, unknown>;
  const value = str(obj.value);
  return {
    // available AND a value. A card that claims to be available and has nothing
    // to draw renders as a blank rectangle, which reads as broken.
    available: obj.available === true && value !== null,
    value,
    reason:
      str(obj.reason) ??
      (obj.available === true && value === null
        ? `The server marked the ${what} as available but sent no value.`
        : null),
    format: str(obj.format),
  };
}
