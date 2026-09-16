/**
 * Pure shape and merge rules for the Convex cutover. No ctx, no database, no
 * I/O, so it can be tested directly rather than through a mirror of itself.
 *
 * Split from appData.ts for the same reason identityRules.ts is split from
 * identity.ts: a test that reimplements the logic it is testing can drift from
 * the real thing and still pass, which is worse than no test.
 */

/**
 * Absence means "the caller does not know about this field", NOT "set it to
 * empty".
 *
 * Only undefined, null and a blank string qualify. Three things that look
 * empty are deliberately NOT absence:
 *
 *   0            a spent-down balance is a real balance. Treating it as
 *                absence would make an account impossible to zero out.
 *   []           a student can lose their last raffle qualification.
 *   false        a real boolean.
 *
 * Getting this boundary wrong in either direction is a data loss bug. Too
 * wide and a stale tab blanks real values, which is what happened to 38 staff
 * emails. Too narrow and a deliberate reset silently does nothing.
 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** Structural equality, so an unchanged array or transaction list is not rewritten. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export type AppStudent = Record<string, unknown> & { id: string; name: string };
export type AppTeacher = Record<string, unknown> & { id: string; name: string };

/**
 * A Convex student row in the shape script.js already expects.
 *
 * The app keys students by `id`, which in the Firestore era was the legacy
 * document id. SIS students have never had one, so they fall back to the
 * student number, which is the SIS key and is stable.
 *
 * Ticket counts default to 0 because the app does arithmetic on them and
 * undefined would produce NaN in a total a teacher reads. Balances do NOT
 * default: undefined there means "this student has no cash record", which is
 * different from "this student has zero", and the UI renders them differently.
 */
export function toAppStudent(row: Record<string, any>): AppStudent {
  return {
    id: String(row.legacyId ?? row.studentNumber ?? row._id ?? ""),
    studentNumber: row.studentNumber,
    name: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim(),
    firstName: row.firstName,
    lastName: row.lastName,
    grade: row.grade,
    // Read by wildcat-discipline's snapshotDemographics as `sex`, which
    // already falls back through `s.sex || s.gender`.
    gender: row.gender,
    school: row.school,
    email: row.email,

    pbisTickets: row.pbisTickets ?? 0,
    attendanceTickets: row.attendanceTickets ?? 0,
    academicTickets: row.academicTickets ?? 0,
    bigRaffleQualified: row.bigRaffleQualified ?? [],
    weeksQualified: row.weeksQualified,

    wildcatCashBalance: row.wildcatCashBalance,
    wildcatCashEarned: row.wildcatCashEarned,
    wildcatCashSpent: row.wildcatCashSpent,
    wildcatCashDeducted: row.wildcatCashDeducted,
    wildcatCashRewardsRedeemed: row.wildcatCashRewardsRedeemed,
    wildcatCashTransactions: row.wildcatCashTransactions,
    cashBalance: row.cashBalance,
    cashTransactions: row.cashTransactions,

    archivedAt: row.archivedAt,
  };
}

/**
 * A Convex teacher row in the app's shape.
 *
 * There is no `username` field on this table and there will not be one: the
 * legacy username and cleartext password pair is what the migration exists to
 * delete. Identity is the Entra email.
 */
export function toAppTeacher(row: Record<string, any>): AppTeacher {
  return {
    id: String(row.legacyId ?? row._id ?? ""),
    name: row.name,
    email: row.email,
    role: row.role,
    ticketsAwarded: row.ticketsAwarded ?? 0,
    sections: row.sections,
  };
}

/**
 * The patch to apply, containing ONLY fields that actually changed.
 *
 * Two rules, in order:
 *   1. An absent incoming value never overwrites a value that is present.
 *   2. An unchanged value is not written at all.
 *
 * Rule 1 is the anti-clobber rule. Rule 2 keeps the audit trail honest: a save
 * that changes nothing should produce no writes, so "1 student changed" in a
 * sync summary means one student actually changed.
 */
export function mergeIncoming(
  existing: Record<string, any>,
  incoming: Record<string, any>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (isAbsent(value)) continue; // never write an absence, in either direction
    if (same(existing[key], value)) continue;
    patch[key] = value;
  }
  return patch;
}

/**
 * The fields a BROWSER may write on a student.
 *
 * An allowlist, because a denylist fails open: the day somebody adds a field,
 * a denylist silently permits the browser to write it. Identity and enrollment
 * are absent on purpose. Those belong to the SIS, and a teacher's browser has
 * no business renaming a child or changing their grade level.
 */
export const STUDENT_WRITABLE = [
  "pbisTickets",
  "attendanceTickets",
  "academicTickets",
  "bigRaffleQualified",
  "weeksQualified",
  "wildcatCashBalance",
  "wildcatCashEarned",
  "wildcatCashSpent",
  "wildcatCashDeducted",
  "wildcatCashRewardsRedeemed",
  "wildcatCashTransactions",
  "cashBalance",
  "cashTransactions",
] as const;

/**
 * Same reasoning for staff. Email and role are NOT writable from a browser.
 *
 * `sections` WAS here and has been removed. It is the legacy CSV field: nothing
 * in the PowerSchool path has ever written it, every staff row carries `[]`,
 * and nothing reads it -- a teacher's classes come from psRoster through
 * views_app:teacherRoster, and accessRules refuses to read this field on
 * purpose, because a teacher who can edit their own profile could otherwise
 * grant themselves the whole school.
 *
 * It was not merely dead. Browsers still holding the CSV-era shape sent
 * sections as an array of OBJECTS, the schema says v.array(v.string()), and a
 * Convex mutation is transactional -- so one stale profile failed the entire
 * appData:save, taking students and settings down with it:
 *
 *   Failed to insert or update a document in table "teachers"
 *   Path: .sections[0]
 *   Value: {courseName: "Multimedia Production 1B", period: "P4", ...}
 *   Validator: v.string()
 *
 * Removing it from the allowlist stops the browser sending it at all. Values
 * already stored are left exactly as they are; nothing reads them.
 */
export const TEACHER_WRITABLE = ["name", "ticketsAwarded"] as const;

function pick(source: Record<string, any>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = source?.[key];
  return out;
}

/**
 * THE CASH COUNTERS ARE INCREMENTED, NOT OVERWRITTEN.
 *
 * A balance is computed in the browser: award ten dollars, the tab adds ten
 * to the number it loaded and sends the sum. Two tabs that loaded the same
 * child at 100 and each award ten both send 110, and the second to land
 * erases the first: the ledger shows two awards and the balance shows one.
 * Until 2026-09-09 the only protection was the staleness guard, a three
 * minute window that forty teachers cross all day.
 *
 * So a record may carry `cashDelta`: for each counter, how much THIS tab
 * changed it since the value it last confirmed with the server. The server
 * adds the delta to what it holds. Both tabs above send +10, and the child
 * ends at 120, which is what happened.
 *
 * A record WITHOUT cashDelta cannot move a counter at all. This sentence used
 * to read "is merged as before, absolute values and all", and on 2026-09-13
 * that is exactly what let one tab re-send its pre-reset view over a
 * server-side reset and restore $4,901,850 across 336 students. A record with
 * no delta is describing its own memory, not a change. Its other writable
 * fields still merge, and planSave names every record this happened to in
 * `countersIgnored`, because the only thing worse than a visible resurrection
 * is an award dropped in silence.
 *
 * A delta is also refused where it would drive a counter below zero. See the
 * clamp in planPatch: after a clear, a stale tab's own reset button sends
 * minus the balance it remembers, which is the same incident with the sign
 * flipped.
 */
/**
 * The most one save may move one counter for one student.
 *
 * The behaviour catalogue tops out at 100 either way and a bulk award applies
 * one behaviour per student, so 5,000 is two orders of magnitude above any
 * real single movement while still being far below a remembered balance -- the
 * largest on record tonight was $78,000 and the total was $4.9M. Chosen to be
 * obviously safe in both directions rather than tight.
 */
export const MAX_CASH_DELTA = 5000;

/**
 * Per-student history arrays: written once per movement, never edited.
 *
 * THE THIRD WRITE PATH, and I missed it. On 2026-09-14 a history cutoff was
 * added to legacyData:mergeSlice so a stale tab could not re-insert last
 * term's rows, and it closed the cash_tx_* ledger and the referrals. These
 * arrays reach the database through appData:save instead -- a different
 * mutation the guard never touched -- so within hours 330 pre-launch rows were
 * back on 348 students, and reconcileCashLedger feeds them straight into the
 * ledger the analytics counts.
 *
 * Guarding two of three write paths is not guarding.
 */
const HISTORY_ARRAY_FIELDS = ["wildcatCashTransactions", "cashTransactions"] as const;

/** How far before the cutoff a row may be dated and still be kept. */
const HISTORY_SLACK_MS = 60 * 60 * 1000;

/**
 * Drop provably pre-cutoff rows from a history array.
 *
 * AN UNDATED ROW IS KEPT. A row whose timestamp will not parse cannot be
 * proved old, and dropping a teacher's award to be tidy is the worse error.
 * A non-array value is returned untouched: this decides nothing about shape.
 */
function pruneHistoryArray(value: unknown, cutoff: number | null): unknown {
  if (cutoff === null || !Array.isArray(value)) return value;
  return value.filter((row) => {
    const t = Date.parse(String((row as any)?.timestamp ?? ""));
    if (!Number.isFinite(t)) return true;
    return t >= cutoff - HISTORY_SLACK_MS;
  });
}

/**
 * The identity of one history row, for unioning two copies of an array.
 *
 * recordCashTransaction (script.js:29139) gives every row a unique id, so the
 * composite below is only for legacy rows that predate it. It deliberately
 * does NOT include the row's position: keying by index means the same row
 * appears under two keys when the two copies order it differently, and a
 * duplicated award on every save is a worse outcome than two identical
 * id-less rows in the same second collapsing into one.
 */
function historyRowKey(row: unknown): string {
  const r = row as Record<string, unknown> | null;
  const id = r?.id ?? r?.entryId;
  if (id !== undefined && id !== null && String(id) !== "") return "id:" + String(id);
  return ["at:", String(r?.timestamp ?? ""), "|", String(r?.amount ?? ""),
    "|", String(r?.behaviorId ?? r?.behaviorName ?? "")].join("");
}

/**
 * Fold a stale tab's pruned array into the rows the server already holds,
 * instead of letting it replace them.
 *
 * WHY THIS IS NOT A PLAIN REPLACE. mergeIncoming writes an array whole, so
 * the last tab to save owns the field. That is fine between tabs that loaded
 * today. It is not fine for a tab whose copy predates a history clear: prune
 * its array and the write becomes "replace today's rows with the two of mine
 * that are recent", or worse, with none at all -- pruning would have turned a
 * resurrection bug into a deletion bug, on the day the owner most needs
 * today's history intact.
 *
 * So the union is applied ONLY to a record that was actually carrying stale
 * rows. Every other save keeps the replace it has always had, which is what
 * the year-end roll-over at script.js:27645 depends on: it empties these
 * arrays deliberately, and an unconditional union would quietly refill them.
 */
function unionHistoryRows(stored: unknown, pruned: unknown[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  const add = (rows: unknown[]) => {
    rows.forEach((row) => {
      const key = historyRowKey(row);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(row);
    });
  };
  add(Array.isArray(stored) ? stored : []);
  add(pruned);
  return out;
}

export const CASH_COUNTERS = [
  "wildcatCashBalance",
  "wildcatCashEarned",
  "wildcatCashSpent",
  "wildcatCashDeducted",
] as const;

/** The usable deltas on a record: finite, non-zero numbers only. Null when none was sent. */
export function cashDeltaOf(record: Record<string, any>): Record<string, number> | null {
  const d = record?.cashDelta;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const out: Record<string, number> = {};
  for (const field of CASH_COUNTERS) {
    const v = Number((d as Record<string, unknown>)[field]);
    if (Number.isFinite(v) && v !== 0) out[field] = v;
  }
  return out;
}

/**
 * The counters a record tried to SET rather than MOVE, or tried to drive below
 * zero. Named so a refusal is reported rather than swallowed.
 *
 * Quiet for the ordinary case on purpose. A current client sends its absolute
 * counters ALONGSIDE its delta, so a record is only named here when it would
 * actually have changed a stored balance without being able to say by how
 * much. A staff record can never appear: TEACHER_WRITABLE holds no counters.
 *
 * The zero-delta case is treated as no delta. A record claiming it moved
 * nothing while naming a different balance is making the same mistake as one
 * with no delta at all -- it is reporting a remembered number -- and that is
 * the shape a tab seated from cache takes.
 */
export function refusedCashCounters(
  row: Record<string, any>,
  record: Record<string, any>,
  writable: readonly string[],
): string[] {
  // `stated` DISTINGUISHES "this client speaks deltas" FROM "this counter did
  // not move". cashDeltaOf drops zero movements, so a current tab that moved
  // only the balance and the deducted counter sends nothing for earned -- and
  // the branch below would then judge earned by the ABSOLUTE the tab loaded
  // with, against what the server holds now.
  //
  // That is a false refusal, and it was going to fire for most of 40 staff on
  // launch morning. script.js clears the save fingerprints on every load and
  // the first save ships every student with an all-zero cashDelta, so any
  // award by any OTHER teacher since this tab loaded tripped it: the teacher
  // got "This tab was out of date, so some money was not saved. Reloading to
  // get current." and had the page reload under them mid-lesson. The money had
  // saved. The warning was wrong.
  //
  // A record that states ANY delta is a client that speaks deltas, and its
  // absolutes are not a claim about the server -- planPatch already ignores
  // them. A record with NO cashDelta at all is an old build, and that is still
  // reported, which is the case this function exists for.
  const stated = cashDeltaOf(record);
  const delta = stated ?? {};
  const fields = pick(record, writable);
  const refused: string[] = [];
  for (const f of CASH_COUNTERS) {
    const d = delta[f];
    if (d === undefined) {
      if (stated) continue;
      // No movement stated by a client that states none at all. Named only if
      // it would have changed the row.
      //
      // COMPARED AS NUMBERS, and an absent stored value counts as zero. This
      // used to call same(), which is JSON.stringify equality -- and
      // JSON.stringify(undefined) is undefined, not a string, so a student row
      // with no cash fields never equalled the 0 the client sends. sisSync
      // inserts rows without them, so ONE such student was enough to make the
      // first save from every tab report a refusal, warn the teacher their tab
      // was out of date, and force a reload -- with nothing actually wrong.
      if (isAbsent(fields[f])) continue;
      const incoming = Number(fields[f]);
      if (Number.isFinite(incoming) && incoming !== (Number(row[f]) || 0)) refused.push(f);
      continue;
    }
    // Movement stated, but implausibly large for one action. See the cap.
    if (Math.abs(d) > MAX_CASH_DELTA) refused.push(f);
  }
  return refused;
}

/**
 * The patch for one record. Counters go by delta when the record carries one
 * (their absolute values are then ignored, because they describe the tab's
 * view and not the server's); everything else goes through mergeIncoming
 * exactly as before.
 */
export function planPatch(
  row: Record<string, any>,
  record: Record<string, any>,
  writable: readonly string[],
  /**
   * The server's history cutoff, or null for none. OPTIONAL so the existing
   * three-argument call sites and the assertion that pins this signature keep
   * working; absent means no pruning, which is the behaviour before this.
   */
  historyCutoff: number | null = null,
): Record<string, unknown> {
  const fields = pick(record, writable);
  // THE THIRD WRITE PATH. See HISTORY_ARRAY_FIELDS: the ledger and the
  // referrals are guarded in legacyData:mergeSlice, and these arrays arrive
  // here instead.
  for (const f of HISTORY_ARRAY_FIELDS) {
    const incoming = fields[f];
    if (!Array.isArray(incoming)) continue;
    const pruned = pruneHistoryArray(incoming, historyCutoff) as unknown[];

    // A NON-EMPTY HISTORY IS UNIONED, NEVER REPLACED. THE COUNTERS' RULE,
    // APPLIED TO HISTORY: a browser may ADD to a student's history and may not
    // decide what it consists of.
    //
    // I scoped this to "only when something stale was pruned" on 2026-09-15 and
    // wrote that every other save "keeps the plain replace it has always had".
    // That was wrong, and it was measured wrong within the day.
    // distributeCashTransactions (script.js:29765) rebuilds every student's
    // array from whatever `cashTransactions` the saving tab holds -- on load and
    // after every save -- so one tab with a short ledger rewrites all 620
    // records. On 2026-09-16 the arrays were repaired to 1,094 rows at 17:48 and
    // were down to SIX by 18:14: not "can be undone by a stale tab" but undone
    // continuously, while a teacher watched the dashboard fall.
    //
    // NOTHING SHRINKS A STORED HISTORY. NOT EVEN TO EMPTY.
    //
    // I exempted the empty array this afternoon, reasoning that the year-end
    // roll-over (script.js:27645) clears these deliberately and sends an empty
    // array to say so -- "emptiness is a decision, brevity is an accident".
    // That sentence was wrong within three hours. A FAILED LOAD PRODUCES
    // EMPTINESS: a tab that could not read cash_tx_* at all has an empty
    // `cashTransactions`, distributeCashTransactions writes `[]` onto all 620
    // students from it, and my exception honoured that as a decision. The
    // arrays went from 1,096 rows to SEVEN while the ledger grew normally to
    // 1,469. The one shape I exempted is the exact shape the bug takes.
    //
    // So a browser may only ever ADD. Clearing a history is an administrative
    // act with a backup step, and it belongs in a server mutation that says so
    // -- legacyPurge:zeroAllStudentCash already does exactly this, counters and
    // arrays together, and the year-end roll should call it rather than asking
    // a save to infer intent from an absence.
    if (!Array.isArray(row[f]) || (row[f] as unknown[]).length === 0) {
      // Nothing stored yet: the incoming rows are all there is.
      fields[f] = pruned;
      continue;
    }
    fields[f] = unionHistoryRows(row[f], pruned);
  }
  // NO DELTA, NO COUNTERS. A record that cannot say how much IT moved a
  // counter is describing a balance it remembers, not a change it made. On
  // 2026-09-13 one such tab re-sent its pre-reset view over a server-side
  // reset and put $4,901,850 back across 336 students, through a
  // `delta === null` early return that used to sit on this line and hand
  // `fields` -- absolute counters and all -- straight to mergeIncoming.
  //
  // The branch is DELETED rather than special-cased, so there is no longer any
  // path on which a browser-supplied absolute counter reaches the database.
  // An empty delta already behaved this way.
  const delta: Record<string, number> = cashDeltaOf(record) ?? {};
  const counters = new Set<string>(CASH_COUNTERS);
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) if (!counters.has(key)) rest[key] = value;
  const patch = mergeIncoming(row, rest);
  for (const [field, d] of Object.entries(delta)) {
    // A CAP ON ONE MOVEMENT, not a floor at zero. This is the second attempt
    // and the first was wrong in a way that mattered.
    //
    // The danger is a stale tab after a clear: its own reset button computes
    // the delta against the balance IT remembers, sends 0 - 30500 = -30500
    // against a server holding 0, and lands the child at -$30,500 -- $4.9M of
    // phantom debt across the school, the 2026-09-13 incident with the sign
    // flipped.
    //
    // I first stopped that by clamping the result at zero. That broke the
    // product: every balance is $0 tonight, so the NEXT legitimate deduction
    // any teacher made would have been clamped, reported as a refusal, and
    // would have force-reloaded their tab mid-lesson. Deductions are a launch
    // feature, and debt is a state this school uses deliberately -- the
    // deduct screen says so, and six students were in debt before the reset.
    //
    // Magnitude is what actually separates the two. The behaviour catalogue
    // tops out at 100 either way (script.js:1372), and a bulk award applies
    // one behaviour per student, so no single student's counter legitimately
    // moves by thousands in one save. A stale reset always does, because it
    // carries a whole remembered balance. So one movement is capped, the
    // balance is free to go negative as the school intends, and the cap is
    // reported through the same channel rather than applied silently.
    if (Math.abs(d) > MAX_CASH_DELTA) continue;
    patch[field] = (Number(row[field]) || 0) + d;
  }
  return patch;
}

export type PlannedPatch = { key: string; rowId: unknown; patch: Record<string, unknown> };
export type SavePlan = { patches: PlannedPatch[]; skipped: string[]; countersIgnored: string[] };

/**
 * Decide what a save WOULD write, without writing anything.
 *
 * Pulled out of the mutation so the dangerous path is unit testable. Proving
 * the mutation refuses a hostile payload otherwise means removing its auth
 * gate to call it, and a gate that gets commented out to test it is a gate
 * that eventually ships commented out.
 *
 * `matchKeys` maps every key a row can be addressed by (legacy id and student
 * number) to that row. An incoming record matching nothing is SKIPPED, never
 * inserted: the SIS owns the roster, and inserting on a key miss is how a typo
 * becomes a phantom child with a balance.
 */
export function planSave(
  rows: Array<Record<string, any>>,
  incoming: Array<Record<string, any>>,
  writable: readonly string[],
  keysOf: (row: Record<string, any>) => string[],
  /** The server's history cutoff, or null. Optional, as on planPatch. */
  historyCutoff: number | null = null,
): SavePlan {
  const byKey = new Map<string, Record<string, any>>();
  for (const row of rows) {
    for (const key of keysOf(row)) if (key) byKey.set(key, row);
  }

  const patches: PlannedPatch[] = [];
  const skipped: string[] = [];
  const countersIgnored: string[] = [];
  for (const record of incoming ?? []) {
    const key = String(record?.id ?? record?.studentNumber ?? "");
    const row = key ? byKey.get(key) : undefined;
    if (!row) {
      if (key) skipped.push(key);
      continue;
    }
    const patch = planPatch(row, record, writable, historyCutoff);
    // BEFORE the emptiness guard below, deliberately. A record carrying
    // nothing but refused counters produces an EMPTY patch and would
    // otherwise vanish from the save's answer entirely -- which is the exact
    // shape of failure the `skipped` report above exists to prevent.
    if (refusedCashCounters(row, record, writable).length) countersIgnored.push(key);
    if (Object.keys(patch).length > 0) patches.push({ key, rowId: row._id, patch });
  }
  return { patches, skipped, countersIgnored };
}
