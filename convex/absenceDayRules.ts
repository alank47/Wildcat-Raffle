/**
 * HOW ONE ABSENT DAY IS CLASSIFIED: whole day, possible misrecord, or partial.
 *
 * ONE COPY OF THE RULE. It used to live inline in the per-date rebuild
 * (attendanceDays.ts), which writes the year's per-student totals Attendance
 * Watch ranks on. On 2026-09-23 the same screen gained week and month windows,
 * which have to classify the same per-date rows at read time -- and two copies
 * of a rule about a child are two answers waiting to disagree. Both now call
 * this.
 *
 * COMPONENTS, NOT A VERDICT. `fullDaysStrict` needs no interpretation: every
 * block that ran was missed. A day whose only non-absent blocks were EXPLICITLY
 * marked present is a candidate misrecord (the owner's case: absent all day but
 * one period ticked present), bucketed by how many such blocks -- index 0 a gap
 * of one, 1 a gap of two, 2 three or more -- so the browser can apply whatever
 * threshold the school settles on. A gap made of unrecorded blocks is a partial
 * day, because unrecorded reads as present by the owner's decision of
 * 2026-09-21; `assumedPresentDays` counts the partial days that rest on that.
 */

export type AbsenceDayRow = {
  blocksThatDay: number;
  absentBlocks: number;
  presentBlocks: number;
  unrecordedBlocks: number;
};

export type AbsenceSplit = {
  absentDays: number;
  fullDaysStrict: number;
  misrecordDaysByGap: number[];
  partialDays: number;
  assumedPresentDays: number;
};

export function emptyAbsenceSplit(): AbsenceSplit {
  return { absentDays: 0, fullDaysStrict: 0, misrecordDaysByGap: [0, 0, 0], partialDays: 0, assumedPresentDays: 0 };
}

/**
 * THE MISRECORD THRESHOLD, read the way the browser reads it
 * (WildcatRoster.daySettingsOrDefault): anything that is not a finite number
 * of 0 or more is the shipped default of 1, and a fraction rounds.
 */
export const DEFAULT_MISRECORD_AT = 1;
export function misrecordAtOrDefault(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return DEFAULT_MISRECORD_AT;
  return Math.round(raw);
}

/**
 * WHOLE DAYS OUT in a stored split, at a misrecord threshold: the strict days
 * plus every misrecord bucket the threshold admits (bucket i holds days with a
 * gap of i+1; the last is "or more"). The SAME ANSWER AS THE BROWSER'S
 * WildcatRoster.absenceSplit(split, { misrecordAt }).fullDays -- and 0 where
 * that returns null -- for every threshold; a test runs both. It exists so a
 * server that serves a RATE (the group run charts, 2026-10-12) applies the
 * screen's threshold without sending the components that make it.
 */
export function fullDaysAt(split: Partial<AbsenceSplit> | null | undefined, misrecordAt: unknown): number {
  if (!split || typeof split !== "object") return 0;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  const strict = n(split.fullDaysStrict);
  if (strict === null || n(split.partialDays) === null || n(split.absentDays) === null) return 0;
  const at = misrecordAtOrDefault(misrecordAt);
  const gaps = Array.isArray(split.misrecordDaysByGap) ? split.misrecordDaysByGap : [];
  let counted = 0;
  for (let i = 0; i < gaps.length; i++) if (i + 1 <= at) counted += n(gaps[i]) || 0;
  return strict + counted;
}

/** Add one absent day to a running split. Mutates and returns `t`. */
export function addAbsenceDay(t: AbsenceSplit, r: AbsenceDayRow): AbsenceSplit {
  t.absentDays++;
  const gap = r.blocksThatDay - r.absentBlocks;
  if (gap <= 0) { t.fullDaysStrict++; return t; }
  // A day is only a candidate misrecord when EVERY non-absent block was
  // explicitly marked present. A gap made of unrecorded blocks is a partial
  // day, because unrecorded reads as present by decision.
  if (r.presentBlocks >= gap) {
    const i = gap <= 1 ? 0 : gap === 2 ? 1 : 2;
    t.misrecordDaysByGap[i]++;
  } else {
    t.partialDays++;
    if (r.presentBlocks === 0 && r.unrecordedBlocks > 0) t.assumedPresentDays++;
  }
  return t;
}
