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
