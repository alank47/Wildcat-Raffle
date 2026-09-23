/**
 * Pure shape and merge rules for the Convex cutover. No ctx, no database, no
 * I/O, so it can be tested directly rather than through a mirror of itself.
 *
 * Split from appData.ts for the same reason identityRules.ts is split from
 * identity.ts: a test that reimplements the logic it is testing can drift from
 * the real thing and still pass, which is worse than no test.
 *
 * NO IMPORTS, and that is load-bearing rather than tidy: convex/appDataShape.test.mjs
 * imports this file directly under Node, which cannot resolve an extensionless
 * `.ts` specifier. That is why the movement-keying rules below live HERE rather
 * than in a module of their own -- they are pure save-shape rules and this is
 * the pure save-shape module.
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
    /**
     * THE REGISTER, READ ONLY, so the browser can tell a movement the server
     * has already applied from one it has not.
     *
     * Without it, a tab that records an award and then RELOADS before the save
     * confirms keeps the movement in its pending list while both sides of the
     * delta forget it -- the fresh student row and the freshly seeded base are
     * both the server's pre-movement numbers, so the delta is zero while the
     * movement is still listed. That self-contradictory payload is what cost
     * 38 students an award on 2026-09-22.
     *
     * NOT WRITABLE. STUDENT_WRITABLE does not list it, so a client echo is
     * dropped on the way back in. That matters more than it looks: a stale tab
     * able to overwrite this register could erase the record of what had
     * already been applied and make every one of those movements land twice.
     */
    cashApplied: row.cashApplied,
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


// =========================================================================
// MOVEMENT-KEYED COUNTERS
//
// Everything below exists because a cash ROW is idempotent and a cash
// COUNTER was not. Full account on planCashMovements.
// =========================================================================

/**
 * How many applied movement ids are remembered per student.
 *
 * O(1) per student forever, independent of the ledger's size: ~60 bytes an
 * entry, ~1.5KB worst case, on the row it guards.
 *
 * WHY 24 IS ENOUGH, and what would make it wrong. A movement leaves the
 * client's pending list the moment ANY save confirms it, so the window a
 * retry has to survive is one save, not 24 movements. 24 is therefore many
 * multiples of the real exposure. It is reasoned rather than measured, and the
 * measurement is now available: `cashMovementsAbsorbed` counts real
 * absorptions and a `coverage_lost` refusal counts an eviction that went too
 * far. If evictions ever appear, raise this -- the cost is linear and small.
 */
export const CASH_APPLIED_MAX = 24;


export type CashMovement = { id: string; at: string; amount: number; kind: string };
export type CashApplied = { ids: Array<{ i: string; at: string }>; since?: string };

/**
 * Which counters one movement moves, and by how much.
 *
 * THIS MUST STAY IDENTICAL TO recordCashTransaction, which is the only place a
 * movement's local effect is computed. They are two expressions of one rule and
 * a divergence between them is money. The client has the same function under
 * the same name for exactly that reason, and a test compares the two.
 *
 * Reading the SIGN is not enough -- a redemption and a deduction are both
 * negative and must bucket differently.
 */
export function cashMovementEffect(amount: unknown, kind: unknown): Record<string, number> {
  const a = Number(amount) || 0;
  const k = String(kind ?? "");
  return {
    wildcatCashBalance: a,
    wildcatCashEarned: (k !== "redeem" && a > 0) ? a : 0,
    wildcatCashSpent: (k === "redeem") ? Math.abs(a) : 0,
    wildcatCashDeducted: (k !== "redeem" && a <= 0) ? Math.abs(a) : 0,
  };
}

/**
 * Append to the register, evicting the oldest past the cap.
 *
 * THE WATERMARK IS THE WHOLE POINT. Every eviction moves `since` forward to
 * the evicted entry's timestamp, and it never moves back. So the register's
 * invariant holds by induction: every movement this student's counters have
 * had applied whose `at` is strictly after `since` is in `ids`. A movement
 * older than the watermark cannot be proved unseen, so it is refused rather
 * than guessed at -- which is the direction that loses a movement rather than
 * paying twice.
 */
export function ringPush(cur: CashApplied | null | undefined, add: readonly CashMovement[]): CashApplied {
  const ids = ((cur && Array.isArray(cur.ids)) ? cur.ids.slice() : [])
    .filter((e) => e && typeof e.i === "string");
  let since = (cur && typeof cur.since === "string") ? cur.since : undefined;
  const have = new Set(ids.map((e) => e.i));
  // Appended in `at` order so eviction is oldest-first regardless of the order
  // a payload happened to list them in.
  [...add].sort((x, y) => String(x.at).localeCompare(String(y.at))).forEach((m) => {
    if (have.has(m.id)) return;
    have.add(m.id);
    ids.push({ i: m.id, at: String(m.at) });
  });
  while (ids.length > CASH_APPLIED_MAX) {
    const dropped = ids.shift();
    if (!dropped) break;
    if (!since || String(dropped.at) > since) since = String(dropped.at);
  }
  return since === undefined ? { ids } : { ids, since };
}

export type MovementPlan = {
  /** Per counter, what to add to the stored value. Already cap-filtered. */
  net: Record<string, number>;
  /** Counters refused for magnitude. */
  capped: string[];
  /**
   * Counters where a real movement was cancelled to zero by the residual.
   *
   * The payload contradicted itself: it listed a movement and stated a delta
   * that does not include it. Nothing is applied and nothing is registered, so
   * the next save re-sends it rather than the money vanishing.
   */
  cancelled: string[];
  /** Movements applied on this call, to be registered. */
  applied: CashMovement[];
  /** Ids this student's counters had already had applied. */
  absorbed: string[];
  /** Movements not applied, with the reason. */
  refused: Array<{ id: string; why: string }>;
  /** The register to write, or null when nothing was applied. */
  nextApplied: CashApplied | null;
  /** Movements recovered from an older client's own history, and registered. */
  legacyKeyed?: number;
  /** True when an older client re-sent a delta its history no longer explains. */
  legacyRepeat?: boolean;
  /** True when any counter moved without a movement id behind it. */
  hasResidual: boolean;
};

/**
 * What one record's counters should become.
 *
 * `cutoffMs` is the history cutoff, or null when none is set. The counters have
 * never had a cutoff guard -- the rows and the per-student arrays both do --
 * which is the "guarding a subset guards nothing" rule finally applied to the
 * fourth store.
 */
export function planCashMovements(
  row: Record<string, any>,
  record: Record<string, any>,
  stated: Record<string, number>,
  opts: { cutoffMs: number | null; maxDelta: number },
): MovementPlan {
  const cutoffMs = opts ? opts.cutoffMs : null;
  const maxDelta = (opts && Number.isFinite(opts.maxDelta)) ? opts.maxDelta : 5000;
  const refused: Array<{ id: string; why: string }> = [];
  const absorbed: string[] = [];

  // --- accept the list -------------------------------------------------
  const raw = Array.isArray(record?.cashMovements) ? record.cashMovements : [];
  const accepted: CashMovement[] = [];
  const seenInRecord = new Set<string>();
  for (const m of raw) {
    const id = String((m && m.id) || "");
    const amount = Number(m && m.amount);
    if (!id || !Number.isFinite(amount) || typeof (m && m.kind) !== "string") {
      refused.push({ id: id || "(no id)", why: "bad_shape" });
      continue;
    }
    // A distributeCashTransactions rebuild, or a client bug, could list one
    // movement twice in the same record. First occurrence wins.
    if (seenInRecord.has(id)) { refused.push({ id, why: "duplicate_in_record" }); continue; }
    seenInRecord.add(id);
    accepted.push({ id, at: String((m && m.at) || ""), amount, kind: String(m.kind) });
  }

  // --- the register, read before anything decides ----------------------
  const cur: CashApplied | null = (row && row.cashApplied) || null;
  const known = new Set(((cur && Array.isArray(cur.ids)) ? cur.ids : []).map((e: any) => String(e && e.i)));
  const sinceMs = (cur && typeof cur.since === "string") ? Date.parse(cur.since) : NaN;

  /**
   * A CLIENT THAT SENDS NO MOVEMENT KEYS STILL SENDS ITS HISTORY.
   *
   * THE HOLE THIS CLOSES, measured on production 2026-09-23. `residual` is
   * `stated - claimed`, and a record with no `cashMovements` has claimed = 0,
   * so its whole stated delta is applied with NO dedupe whatsoever. Re-send
   * that save -- a retry, a reconnect, a second save before the tab clears its
   * pending list -- and the same money lands again. 83 students were holding
   * $21,300 more than their ledger supports, one of them at exactly twice,
   * and every one of them had a complete and correct ledger.
   *
   * Every tab opened before the movement-keyed client shipped at 09:23 on
   * 2026-09-22 is such a client, and staff do not close tabs. Waiting for
   * them to reload is not a fix -- it is the thing this project has a standing
   * rule against.
   *
   * `wildcatCashTransactions` IS in STUDENT_WRITABLE, so those same tabs
   * already send the student's own transaction list on every save. That is
   * enough to dedupe on without changing a single browser: if the list holds
   * nothing this register has not already counted, the delta is a repeat of a
   * save already applied, and applying it again is how money appears from
   * nowhere.
   *
   * IT FAILS TOWARDS SHORT, NOT OVER. If a tab somehow states a delta before
   * its own history carries the row, this refuses and the counter ends up
   * BEHIND the ledger -- which the nightly check reports and the recount
   * repairs, because increases need no decision about any child. The opposite
   * failure is money that cannot be taken back without telling a student their
   * balance was wrong.
   */
  const legacyUnkeyed: CashMovement[] = [];
  let legacyRepeat = false;
  if (!raw.length) {
    // ONLY ON EVIDENCE. A record that carries no transaction list at all
    // cannot be judged either way, and refusing it would stop a legitimate
    // award from a client this server has never seen the shape of. The repeat
    // verdict therefore needs the list to be PRESENT and non-empty: that is
    // the case where the student demonstrably has history and none of it is
    // new, which is the shape a re-sent save actually takes.
    const txs = Array.isArray(record?.wildcatCashTransactions)
      ? (record.wildcatCashTransactions as any[]) : null;
    // ELIGIBLE means a row recent enough to explain a delta being stated now:
    // dated, after the history cutoff, and after the register's watermark. A
    // student whose every row is older than that has no recent history to
    // judge against -- pruned rows are exactly that case -- so the verdict is
    // "cannot tell" and the delta goes through as it always did.
    let eligible = 0;
    for (const t of (txs ?? [])) {
      const id = String((t && (t as any).id) || "");
      if (!id) continue;
      const at = String((t && (t as any).timestamp) || "");
      const ms = Date.parse(at);
      if (!Number.isFinite(ms)) continue;
      if (Number.isFinite(sinceMs) && ms <= sinceMs) continue;
      if (cutoffMs !== null && Number.isFinite(cutoffMs) && ms < cutoffMs - HISTORY_SLACK_MS) continue;
      eligible++;
      if (known.has(id)) continue;
      const amount = Number((t as any).amount);
      if (!Number.isFinite(amount)) continue;
      legacyUnkeyed.push({ id, at, amount, kind: String((t as any).kind ?? "") });
    }
    // Recent history exists, the register has already counted all of it, and
    // the client still claims a change: that is a save being applied twice.
    legacyRepeat = eligible > 0 && legacyUnkeyed.length === 0 &&
      CASH_COUNTERS.some((f) => (Number(stated[f]) || 0) !== 0);
  }

  // --- claimed and residual -------------------------------------------
  // `claimed` covers the WHOLE accepted list, seen or not: that is what makes
  // the residual independent of server history, and therefore order-safe.
  const claimed: Record<string, number> = {};
  CASH_COUNTERS.forEach((f) => { claimed[f] = 0; });
  accepted.forEach((m) => {
    const e = cashMovementEffect(m.amount, m.kind);
    CASH_COUNTERS.forEach((f) => { claimed[f] += e[f] || 0; });
  });

  // A PAYLOAD THAT LISTS MOVEMENTS AND STATES NO CHANGE IS NOT BELIEVED.
  //
  // `residual` is `stated - claimed`, and the whole order-independence
  // argument rests on `stated` including every movement the record lists. A
  // tab that lists a +100 award and states a delta of zero breaks that: the
  // residual becomes -100 and SUBTRACTS a real movement, whether that movement
  // is fresh (net cancels to zero, and it used to be registered anyway) or
  // already absorbed (net goes negative and takes the money back off).
  //
  // Both shapes end the same way and both were on production 2026-09-22: 38
  // students short exactly one movement, every one of those movements
  // registered as applied while the counter had not moved.
  //
  // An all-zero delta is otherwise completely normal -- the first save after
  // every load ships every student that way -- but always with NO movements.
  // All-zero WITH movements listed is self-contradictory, so nothing is
  // applied, nothing is registered, and the next save re-sends it. The
  // alternative is guessing which half of the payload is true and writing the
  // guess down.
  const statesNothing = CASH_COUNTERS.every((f) => (Number(stated[f]) || 0) === 0);
  const incoherent = statesNothing && accepted.length > 0;

  const residual: Record<string, number> = {};
  let hasResidual = false;
  CASH_COUNTERS.forEach((f) => {
    // READ WITH A DEFAULT, never by iterating the delta's keys: cashDeltaOf
    // drops zero-valued fields, so a delta that nets a counter to zero would
    // otherwise skip its own correction or compute `undefined - 100` = NaN.
    const r = (incoherent || legacyRepeat) ? 0 : (Number(stated[f]) || 0) - claimed[f];
    residual[f] = r;
    if (r !== 0) hasResidual = true;
  });

  // --- classify each movement -----------------------------------------
  const fresh: CashMovement[] = [];
  for (const m of accepted) {
    if (known.has(m.id)) { absorbed.push(m.id); continue; }
    const at = Date.parse(m.at);
    if (!Number.isFinite(at)) { refused.push({ id: m.id, why: "undated" }); continue; }
    if (cutoffMs !== null && Number.isFinite(cutoffMs) && at < cutoffMs - HISTORY_SLACK_MS) {
      refused.push({ id: m.id, why: "before_cutoff" });
      continue;
    }
    // Past the watermark the register can no longer prove this is unseen.
    // `at === since` refuses too: conservative, and reported.
    if (Number.isFinite(sinceMs) && at <= sinceMs) {
      refused.push({ id: m.id, why: "coverage_lost" });
      continue;
    }
    fresh.push(m);
  }

  const keyed: Record<string, number> = {};
  CASH_COUNTERS.forEach((f) => { keyed[f] = 0; });
  fresh.forEach((m) => {
    const e = cashMovementEffect(m.amount, m.kind);
    CASH_COUNTERS.forEach((f) => { keyed[f] += e[f] || 0; });
  });

  // --- the cap, per field, exactly as before ---------------------------
  const net: Record<string, number> = {};
  const capped: string[] = [];
  CASH_COUNTERS.forEach((f) => {
    const n = keyed[f] + residual[f];
    if (Math.abs(n) > maxDelta) { net[f] = 0; capped.push(f); return; }
    net[f] = n;
  });

  // --- a field whose movement was CANCELLED by the residual --------------
  //
  // MEASURED ON PRODUCTION 2026-09-22: 38 students were short exactly one
  // movement, and every one of those movements was REGISTERED as applied
  // while the counter had not moved. That is this, and it is the worst shape
  // a cash bug can take -- registered means never re-sent, so the money is
  // gone permanently rather than recoverably.
  //
  // HOW IT HAPPENS. `residual` is `stated - claimed`: the part of the client's
  // own stated delta that its listed movements do not explain. When a tab
  // states a delta of zero while still LISTING a movement -- which happens
  // whenever its cash base was refreshed after the movement was recorded
  // locally -- claimed is +100, residual is -100, and net is zero. Nothing is
  // capped, so the old code registered the movement and planPatch then skipped
  // the counter because the delta was zero.
  //
  // WHAT IS RIGHT HERE. The server cannot tell which half of a
  // self-contradictory payload is true, so it must not guess -- but it must
  // not RECORD a guess either. Leaving the movement unregistered makes the
  // next save re-send it, which turns a permanent loss into a retry, and the
  // nightly drift check sees anything that never resolves.
  const cancelled: string[] = [];
  CASH_COUNTERS.forEach((f) => {
    if (keyed[f] !== 0 && net[f] === 0) cancelled.push(f);
  });
  // An incoherent payload blocks every counter, so a listed movement cannot be
  // recorded as done on the strength of a delta that contradicts it.
  if (incoherent) CASH_COUNTERS.forEach((f) => {
    if (cancelled.indexOf(f) === -1) cancelled.push(f);
  });

  // APPLY AND REGISTER MOVE TOGETHER, OR NEITHER. A first draft of this guard
  // zeroed the residual and left `net` at +100 while refusing to register --
  // which applies the movement and then lets the NEXT save apply it again,
  // turning a loss into a double-credit. A blocked field therefore moves
  // nothing, exactly as a capped one does.
  cancelled.forEach((f) => { net[f] = 0; });

  // --- registration is CONTINGENT on the movement actually landing -----
  // Without this a capped or cancelled field swallows a movement
  // permanently: registered, so never re-sent, but never applied either.
  const blocked = new Set([...capped, ...cancelled]);
  const cappedSet = new Set(capped);
  const applied = fresh.filter((m) => {
    const e = cashMovementEffect(m.amount, m.kind);
    return !CASH_COUNTERS.some((f) => (e[f] || 0) !== 0 && blocked.has(f));
  });
  fresh.forEach((m) => {
    if (applied.includes(m)) return;
    const e = cashMovementEffect(m.amount, m.kind);
    const why = CASH_COUNTERS.some((f) => (e[f] || 0) !== 0 && cappedSet.has(f))
      ? "capped"
      : incoherent ? "stated_no_change" : "cancelled_by_residual";
    refused.push({ id: m.id, why });
  });

  // A LEGACY DELTA THAT LANDED MUST BE REGISTERED TOO, or the next save from
  // that same tab finds its history "new" again and pays twice -- which is
  // the whole failure this path exists to stop. It is registered only when
  // something actually moved, exactly as a keyed movement is: apply and
  // register move together, or neither.
  const legacyApplied = (!raw.length && !legacyRepeat &&
      CASH_COUNTERS.some((f) => (net[f] || 0) !== 0))
    ? legacyUnkeyed : [];
  if (legacyRepeat) {
    refused.push({ id: "(no movement keys)", why: "legacy_repeat_nothing_new_in_history" });
  }
  const toRegister = applied.concat(legacyApplied);

  return {
    net, capped, cancelled, applied, absorbed, refused,
    legacyKeyed: legacyApplied.length,
    legacyRepeat,
    // NOT WRITTEN WHEN NOTHING WAS APPLIED. The first save after every load
    // ships every student with an all-zero delta and no movements; a version
    // that touched the register unconditionally would turn that into ~700 row
    // writes.
    nextApplied: toRegister.length ? ringPush(cur, toRegister) : null,
    hasResidual,
  };
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

  // MOVEMENT-KEYED FROM 2026-09-21, so the same award cannot move a counter
  // twice. On 2026-09-18 a bulk award of seven students was applied twice and
  // every one ended $100 above their own ledger, against seven ledger rows --
  // the rows deduped and the counters did not. See cashMovementRules.ts for
  // the key, and for why an idempotency key per save ATTEMPT fails here.
  //
  // `stated` is read WITH A DEFAULT per counter rather than by iterating the
  // delta's keys, because cashDeltaOf drops zero-valued fields: a delta that
  // nets a counter to zero would otherwise skip its own correction, or compute
  // `undefined - 100` and write NaN into a balance.
  const stated: Record<string, number> = {};
  for (const f of CASH_COUNTERS) stated[f] = Number(delta[f]) || 0;
  const mv = planCashMovements(row, record, stated, {
    cutoffMs: historyCutoff,
    maxDelta: MAX_CASH_DELTA,
  });
  for (const field of CASH_COUNTERS) {
    const d = mv.net[field] || 0;
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
    // The cap still applies, per field and at the same value -- it now lives in
    // planCashMovements, which hands a capped field back as 0. That is what
    // still stops the stale-reset shape, because such a delta arrives as a
    // RESIDUAL with no movement id behind it, and the residual is what the cap
    // sees.
    if (d === 0) continue;
    patch[field] = (Number(row[field]) || 0) + d;
  }
  // THE REGISTER TRAVELS INSIDE THE WRITE IT GUARDS. One ctx.db.patch, one
  // transaction. A register in its own table would be a second store under a
  // second guarantee, which is the exact shape of the bug it exists to close.
  // Absent when nothing was applied, so the first save after every load -- all
  // zero deltas and no movements -- does not become ~700 row writes.
  if (mv.nextApplied) patch.cashApplied = mv.nextApplied;
  return patch;
}

export type PlannedPatch = { key: string; rowId: unknown; patch: Record<string, unknown> };
export type SavePlan = {
  patches: PlannedPatch[];
  skipped: string[];
  countersIgnored: string[];
  /** Movements whose effect this save applied for the first time. */
  movementsApplied: number;
  /** Movement ids already registered -- a re-send, correctly absorbed. */
  movementsAbsorbed: string[];
  /**
   * Movements NOT applied, with the student and the reason. The client keeps
   * these pending and re-sends them, so a held movement is never lost quietly.
   */
  movementsRefused: Array<{ key: string; id: string; why: string }>;
  /**
   * Students whose counters moved with no movement id behind the change: an
   * old client, or the reset / rollover / starting-balance paths. The measure
   * of how much of the fleet is still unkeyed.
   */
  unkeyedResidual: string[];
};

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
  let movementsApplied = 0;
  const movementsAbsorbed: string[] = [];
  const movementsRefused: Array<{ key: string; id: string; why: string }> = [];
  const unkeyedResidual: string[] = [];
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

    // ASKED A SECOND TIME, purely for the report -- the same shape
    // refusedCashCounters is already called in twice. planPatch does not return
    // its reasoning, and a refusal nobody is told about is how a held movement
    // becomes a lost one: the client keeps a movement pending only because this
    // names it.
    {
      const d = cashDeltaOf(record) ?? {};
      const st: Record<string, number> = {};
      for (const f of CASH_COUNTERS) st[f] = Number(d[f]) || 0;
      const mv = planCashMovements(row, record, st, {
        cutoffMs: historyCutoff,
        maxDelta: MAX_CASH_DELTA,
      });
      movementsApplied += mv.applied.length;
      mv.absorbed.forEach((id) => movementsAbsorbed.push(id));
      mv.refused.forEach((r) => movementsRefused.push({ key, id: r.id, why: r.why }));
      if (mv.hasResidual) unkeyedResidual.push(key);
    }

    if (Object.keys(patch).length > 0) patches.push({ key, rowId: row._id, patch });
  }
  return {
    patches, skipped, countersIgnored,
    movementsApplied, movementsAbsorbed, movementsRefused, unkeyedResidual,
  };
}
