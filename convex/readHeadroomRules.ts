/**
 * HOW CLOSE IS EACH HEAVY READ TO CONVEX'S 16 MiB WALL? Pure: no ctx, no
 * clock, no database. readHeadroom.ts measures; this decides what the
 * measurements mean, so the arithmetic and the bands are testable.
 *
 * WHY THIS EXISTS (2026-10-05). Convex stops one query or mutation at 16 MiB
 * of data read (also 32,000 documents scanned, 4,096 index ranges, 8,192 array
 * elements). Several reads in this app grow with the cash ledger, because the
 * ledger is stored as whole week documents with no per-row index and every
 * student row carries its own copy of its cash history. Measured that day the
 * nearest walls were weeks away, and one of them -- the staff page load,
 * appData:load -- fails SILENTLY: the browser falls back to its local copy and
 * nobody is told. A nightly number, written where a person can find it, is
 * what turns "it broke in December" into "it was amber in November".
 *
 * WHAT IT IS NOT. It does not measure a function's real read; it estimates it
 * from the whole-row size of what that function reads (JSON of each document,
 * which measured within 1% of Convex's own count for ledger rows and ~7-10%
 * high for student and roster rows on 2026-10-05). The bands are set low --
 * amber at 40%, red at 70% -- to absorb that uncertainty, plus up to 20%.
 */

export const LIMIT_MIB = 16;
export const AMBER_PCT = 40;
export const RED_PCT = 70;

export type Band = "green" | "amber" | "red";

export function bandOf(pct: number): Band {
  if (!Number.isFinite(pct)) return "red";
  if (pct >= RED_PCT) return "red";
  if (pct >= AMBER_PCT) return "amber";
  return "green";
}

const RANK: Record<Band, number> = { green: 0, amber: 1, red: 2 };

const MiB = 1048576;
const toMiB = (bytes: number) => Math.round((bytes / MiB) * 100) / 100;

/** What readHeadroom.ts measures, in bytes. */
export type HeadroomMeasure = {
  nowIso: string;
  cutoffIso: string | null;
  students: {
    rows: number;
    bytes: number;
    /** Of which, the per-student cash-history copies. */
    cashCopyBytes: number;
    largestRowBytes: number;
    /** The first psRoster row per student, which is what an enrolment lookup reads. */
    rosterLookupBytes: number;
    rosterLookupHits: number;
  };
  psRoster: { rows: number; bytes: number };
  teachers: { rows: number; bytes: number };
  /** The appState rows appData:load reads (settings, history cutoff). */
  loadSettingsBytes: number;
  mirror: {
    rows: number;
    bytes: number;
    docs: Array<{ doc: string; rows: number; bytes: number }>;
  };
};

export type Reader = {
  name: string;
  what: string;
  reachedBy: string;
  estMiB: number;
  pct: number;
  band: Band;
  /** How it grows, in MiB per school week, or null when it does not. */
  growthMiBPerWeek: number | null;
  /** Where the reader stops short on purpose instead of failing, if it does. */
  degradesAtMiB?: number;
};

/** The ISO week key ("2026_W38") a date falls in. Mirrors cashWeekKey. */
export function weekKeyOf(iso: unknown): string | null {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((d.getTime() - ys.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}_W${String(w).padStart(2, "0")}`;
}

/** The weekly cash documents since the cutoff, newest first. */
export function cashWeeksSince(measure: HeadroomMeasure): Array<{ week: string; rows: number; bytes: number }> {
  const from = measure.cutoffIso ? weekKeyOf(measure.cutoffIso) : null;
  return measure.mirror.docs
    .map((d) => ({ m: /^cash_tx_(\d{4}_W\d{2})$/.exec(d.doc), d }))
    .filter((x) => x.m && (!from || x.m[1] >= from))
    .map((x) => ({ week: x.m![1], rows: x.d.rows, bytes: x.d.bytes }))
    .sort((a, b) => (a.week < b.week ? 1 : a.week > b.week ? -1 : 0));
}

/**
 * How fast the ledger and the student copies grow, per SCHOOL week.
 *
 * The ledger: the average size of the COMPLETED cash weeks since the cutoff
 * (this week is still filling, so it is left out). The student copies: every
 * ledger row is also appended to its student's copy, so they grow in
 * proportion -- the ratio of the copies to the ledger since the cutoff
 * (about 0.7 on 2026-10-05). Null when there is no completed week to go on.
 */
export function growthOf(measure: HeadroomMeasure): {
  ledgerMiBPerWeek: number | null;
  studentsMiBPerWeek: number | null;
  completedWeeks: number;
} {
  const nowWeek = weekKeyOf(measure.nowIso);
  const weeks = cashWeeksSince(measure);
  const done = weeks.filter((w) => w.week !== nowWeek && (!nowWeek || w.week < nowWeek));
  if (!done.length) return { ledgerMiBPerWeek: null, studentsMiBPerWeek: null, completedWeeks: 0 };
  const ledgerPerWeek = done.reduce((a, w) => a + w.bytes, 0) / done.length;
  const ledgerSince = weeks.reduce((a, w) => a + w.bytes, 0);
  const ratio = ledgerSince > 0 ? measure.students.cashCopyBytes / ledgerSince : 0;
  return {
    ledgerMiBPerWeek: toMiB(ledgerPerWeek),
    studentsMiBPerWeek: toMiB(ledgerPerWeek * ratio),
    completedWeeks: done.length,
  };
}

/** The reversible list's window, budget and per-row read ceiling. Mirrors cashReversal.ts. */
export const LIST_WEEKS = 14;
export const LIST_BUDGET_MIB = 12;
export const LIST_ROW_BYTES_CEILING = 1200;

/**
 * HOW MANY MORE BYTES THE REVERSIBLE LIST CAN TAKE BEFORE IT LEAVES A WEEK
 * OUT, by the rule it really stops on (cashReversalRules.readWeeksWithinBudget),
 * not by its 12 MiB budget.
 *
 * That rule reads a week only while the week's rows fit in the room left AT
 * THE CEILING of 1,200 bytes a row -- about twice the measured 588 -- so a
 * week of 2,500 rows needs ~2.9 MiB of room, and the list stops well short of
 * 12 MiB (on 2026-10-05's weeks: at about 10.5 MiB, about a week earlier than
 * a 12 MiB line projects). Growth arrives as
 * new NEWEST weeks, which are read first, so it adds to the bytes read before
 * every week already there; the week that drops out first is the one with the
 * least of this room. Negative: it is already leaving a week out.
 *
 * `weeks` newest first, as the list reads them.
 */
export function listRoomBytes(weeks: ReadonlyArray<{ rows: number; bytes: number }>): number {
  const budget = LIST_BUDGET_MIB * MiB;
  let before = 0;
  let room = Infinity;
  for (const w of weeks) {
    room = Math.min(room, budget - LIST_ROW_BYTES_CEILING * Math.max(1, w.rows) - before);
    before += w.bytes;
  }
  return Number.isFinite(room) ? room : budget;
}

/**
 * EVERY HEAVY SINGLE-CALL READER, ESTIMATED. Each is the sum of what that one
 * function reads in one execution. Ordered nearest-the-wall first.
 */
export function estimateReaders(measure: HeadroomMeasure): Reader[] {
  const g = growthOf(measure);
  const weeks = cashWeeksSince(measure);
  const listWeeks = weeks.slice(0, LIST_WEEKS);
  const listBytes = listWeeks.reduce((a, w) => a + w.bytes, 0);
  const top3 = [...weeks].sort((a, b) => b.bytes - a.bytes).slice(0, 3)
    .reduce((a, w) => a + w.bytes, 0);
  const largestWeek = weeks.reduce((a, w) => Math.max(a, w.bytes), 0);
  const S = measure.students;
  const ledger = g.ledgerMiBPerWeek;
  const studs = g.studentsMiBPerWeek;
  const plus = (...xs: Array<number | null>) => (xs.some((x) => x === null) ? null
    : Math.round(xs.reduce((a: number, x) => a + (x as number), 0) * 100) / 100);

  const make = (r: Omit<Reader, "pct" | "band" | "estMiB"> & { bytes: number }): Reader => {
    const estMiB = toMiB(r.bytes);
    const pct = Math.round((estMiB / LIMIT_MIB) * 1000) / 10;
    const { bytes: _b, ...rest } = r;
    return { ...rest, estMiB, pct, band: bandOf(pct) };
  };

  const readers: Reader[] = [
    make({
      name: "appData:load",
      what: "every student row (with its cash-history copy), one roster row per enrolled student, every teacher",
      reachedBy: "every staff page load; a failure is SILENT (the tab falls back to its local copy)",
      bytes: S.bytes + S.rosterLookupBytes + measure.teachers.bytes + measure.loadSettingsBytes,
      growthMiBPerWeek: studs,
    }),
    make({
      name: "leaderboard:cash",
      what: "every student row, one roster row per enrolled student",
      reachedBy: "every student-portal open",
      bytes: S.bytes + S.rosterLookupBytes,
      growthMiBPerWeek: studs,
    }),
    make({
      name: "sisSync:syncStudents",
      what: "every student row, per sync batch",
      reachedBy: "the PowerSchool sync, twice a day (a failure is quiet: runs are recorded only on success)",
      bytes: S.bytes,
      growthMiBPerWeek: studs,
    }),
    make({
      name: "cashReversal:reversibleForStudent",
      what: `the newest ${LIST_WEEKS} cash weeks since the cutoff, one student row`,
      reachedBy: "the admin reversal panel; at degradesAtMiB (well under its 12 MiB budget: see " +
        "listRoomBytes) it lists fewer weeks and says so instead of failing",
      bytes: listBytes + S.largestRowBytes,
      growthMiBPerWeek: ledger,
      degradesAtMiB: toMiB(listBytes + S.largestRowBytes + listRoomBytes(listWeeks)),
    }),
    make({
      name: "cashReversal:reverse",
      what: "at most three cash weeks (worst case: the three largest, on a miss), one student row",
      reachedBy: "the admin Reverse button",
      bytes: top3 + S.largestRowBytes,
      growthMiBPerWeek: null,
    }),
    make({
      name: "legacyData:loadDoc (one cash week)",
      what: "the largest single cash week",
      reachedBy: "every staff page load, once per week document; about 28,000 rows a week before it fails",
      bytes: largestWeek,
      growthMiBPerWeek: null,
    }),
    make({
      name: "whole-mirror tools",
      what: "the whole legacyMirror table (legacyPurge:mirrorShape, cashByDay, receiptAndRefunds, ...)",
      reachedBy: "deploy-key diagnostics and cleanup only (loud, nobody's screen)",
      bytes: measure.mirror.bytes,
      growthMiBPerWeek: ledger,
    }),
    make({
      name: "whole-mirror + students tools",
      what: "the whole legacyMirror table and every student row (cashSinceCutoff, exportCashBefore, clearCashHistoryBefore, ...)",
      reachedBy: "deploy-key incident and year-end tools only (loud, nobody's screen)",
      bytes: measure.mirror.bytes + S.bytes,
      growthMiBPerWeek: plus(ledger, studs),
    }),
  ];
  return readers.sort((a, b) => b.pct - a.pct);
}

/**
 * When each reader reaches amber, red and the limit, at today's growth.
 *
 * Counted in CALENDAR weeks at SCHOOL-week growth, so a holiday (which adds no
 * rows) only ever makes the real date later than this one. "now" when it is
 * already there; null when the reader does not grow or there is no growth yet.
 */
export function projectDates(readers: readonly Reader[], nowIso: string): Record<string, {
  amber: string | null; red: string | null; limit: string | null;
}> {
  const now = Date.parse(nowIso);
  const out: Record<string, { amber: string | null; red: string | null; limit: string | null }> = {};
  for (const r of readers) {
    const at = (pctTarget: number): string | null => {
      const targetMiB = (pctTarget / 100) * LIMIT_MIB;
      if (r.estMiB >= targetMiB) return "now";
      if (!r.growthMiBPerWeek || r.growthMiBPerWeek <= 0 || !Number.isFinite(now)) return null;
      const weeks = (targetMiB - r.estMiB) / r.growthMiBPerWeek;
      return new Date(now + weeks * 7 * 86400000).toISOString().slice(0, 10);
    };
    const limitPct = typeof r.degradesAtMiB === "number" ? (r.degradesAtMiB / LIMIT_MIB) * 100 : 100;
    out[r.name] = { amber: at(AMBER_PCT), red: at(RED_PCT), limit: at(limitPct) };
  }
  return out;
}

/**
 * WHICH READERS GOT WORSE since the last record. Only a band that moved UP
 * counts: green to amber, amber to red, green to red.
 *
 * THE FIRST RECORD IS A BASELINE, not a change: with nothing before it, an
 * amber reader is reported only once it turns red, so the first night does not
 * raise an alarm about a state the measurements already wrote down. A reader
 * new to the list is treated the same way.
 */
export function worsenedReaders(
  previous: { readers?: ReadonlyArray<{ name: string; band: Band }> } | null | undefined,
  next: { readers: ReadonlyArray<{ name: string; band: Band; pct: number; estMiB: number }> },
): Array<{ name: string; from: Band | null; to: Band; pct: number; estMiB: number }> {
  const before = new Map<string, Band>();
  for (const r of previous?.readers ?? []) before.set(r.name, r.band);
  const out: Array<{ name: string; from: Band | null; to: Band; pct: number; estMiB: number }> = [];
  for (const r of next.readers) {
    const was = before.has(r.name) ? before.get(r.name)! : null;
    const baseline: Band = was ?? "amber";
    if (RANK[r.band] > RANK[baseline]) out.push({ name: r.name, from: was, to: r.band, pct: r.pct, estMiB: r.estMiB });
  }
  return out;
}

/**
 * WHAT HAS BEEN ANNOUNCED, after tonight: the comparison point for tomorrow's
 * `worsenedReaders` (2026-10-05's review).
 *
 * Comparing night to night lost every change that happened while the audit
 * entry was switched OFF: the new band became the comparison point the same
 * night, so once the switch went on, a reader that had gone green to amber in
 * the meantime was "amber, was amber" -- not news -- and the first entry it
 * could ever raise was amber to red, about when the wall itself arrives. So
 * the comparison point moves UP only when an entry is written:
 *
 *   - announcing (switch on, a good night): every reader's band tonight --
 *     the entry, if any, was written in the same mutation;
 *   - not announcing: a band may move DOWN (an improvement is not news, and a
 *     later worsening from there should be), never up, so a worsening waits
 *     for the switch. A reader with nothing before it starts from the same
 *     baseline worsenedReaders gives it: amber, so red is the news.
 */
export function announcedBands(
  previous: { readers?: ReadonlyArray<{ name: string; band: Band }> } | null | undefined,
  next: { readers: ReadonlyArray<{ name: string; band: Band }> },
  announcing: boolean,
): Record<string, Band> {
  const before = new Map<string, Band>();
  for (const r of previous?.readers ?? []) before.set(r.name, r.band);
  const out: Record<string, Band> = {};
  for (const r of next.readers) {
    if (announcing) { out[r.name] = r.band; continue; }
    const was: Band = before.get(r.name) ?? "amber";
    out[r.name] = RANK[r.band] < RANK[was] ? r.band : was;
  }
  return out;
}

/** An announced-bands map in the shape worsenedReaders compares against. */
export function bandsAsRecord(
  m: Record<string, Band> | null | undefined,
): { readers: Array<{ name: string; band: Band }> } | null {
  return m && typeof m === "object"
    ? { readers: Object.entries(m).map(([name, band]) => ({ name, band })) }
    : null;
}

/** The sentence an admin reads, in plain words. */
export function headroomHeadline(readers: readonly Reader[]): string {
  const worst = readers[0];
  if (!worst) return "No readers were measured.";
  const red = readers.filter((r) => r.band === "red");
  const amber = readers.filter((r) => r.band === "amber");
  if (!red.length && !amber.length) {
    return `Every heavy read is under ${AMBER_PCT}% of Convex's ${LIMIT_MIB} MiB limit; the closest is ` +
      `${worst.name} at ${worst.pct}%.`;
  }
  const list = (rs: Reader[]) => rs.map((r) => `${r.name} ${r.pct}%`).join(", ");
  return [
    red.length ? `RED (70%+ of the ${LIMIT_MIB} MiB read limit): ${list(red)}.` : "",
    amber.length ? `Amber (40%+): ${list(amber)}.` : "",
  ].filter(Boolean).join(" ");
}
