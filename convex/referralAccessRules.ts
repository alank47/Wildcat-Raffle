/**
 * WHO MAY SEE A DISCIPLINE REFERRAL, AND WHO MAY CLOSE ONE, ON THE SERVER.
 *
 * Pure, and it imports NOTHING -- not convex/values, not identityRules. The
 * tests run it with `node --experimental-strip-types`, whose loader cannot
 * resolve an extensionless import, so a single import here would turn every
 * check into ERR_MODULE_NOT_FOUND. Where this needs something another module
 * owns (normalizeEmail, touchedAt), it keeps an identical copy and a test pins
 * the two together, the same arrangement accessRules.ts and roleChangeRules.ts
 * use for their grade-scope lists.
 *
 * WHY THE SERVER NEEDS THIS AT ALL (2026-10-07). "A teacher sees their own
 * referrals" has been enforced only in the browser, by visibleReferrals in
 * wildcat-discipline.js. legacyData:loadDoc handed every staff member the whole
 * school's referrals -- named children, descriptions, administrator notes -- and
 * the browser politely drew only some of them. Anyone could read the rest in
 * the developer console or in localStorage. On the write side, legacyData:
 * mergeSlice accepted any staff member's copy of any referral, so a teacher
 * could close a colleague's referral, rewrite who filed it, or stamp it a year
 * into the future so no admin's close could ever land.
 *
 * THE RULES, as the owner set them (2026-08-25, 2026-10-07):
 *   - admin, superadmin and PBIS see every referral, and may close one;
 *   - teachers and campus aides see only their OWN, and may not close;
 *   - per-person grants (gradeScope, attendanceWatch) never widen referrals.
 * Measured on 10/7 before deciding: all 9 closed referrals were closed by
 * admins, none by a teacher, none loop-closed. Taking Close away from teachers
 * therefore changes nothing anybody actually does.
 */

/**
 * Roles that see every referral. MUST equal DISCIPLINE_ALL_ROLES in
 * wildcat-discipline.js (the screens) -- referral-access-rules.test.mjs
 * compares the two, because a role the server serves everything to and the
 * page draws nothing for (or the reverse) is a bug either way.
 */
export const REFERRAL_ALL_ROLES: readonly string[] = ["admin", "superadmin", "pbis"];

/**
 * Roles that may close a referral or close its loop. The same three: PBIS may
 * close today and the owner kept it (10/7). Separate from REFERRAL_ALL_ROLES
 * because they are two different permissions that happen to agree today.
 */
export const REFERRAL_CLOSE_ROLES: readonly string[] = ["admin", "superadmin", "pbis"];

/**
 * The two switches. Each is one appState row; a MISSING row means OFF, so the
 * deploy itself changes nothing and turning a switch off needs no deploy.
 *
 * TWO, NOT ONE (critique, 10/7). The scoped read is safe for every tab that is
 * already open -- it only hands a teacher fewer rows -- so it can be piloted
 * the day the server ships. The close guard is NOT: a teacher clicking Close
 * in a tab that predates the new site would see "closed" while the server
 * kept it open. One switch for both would hold the privacy fix hostage to the
 * site rollout, and any rollback of the guard would hand every referral back
 * to every teacher.
 */
export const REFERRAL_SCOPE_KEY = "referralScope";
export const REFERRAL_CLOSE_GUARD_KEY = "referralCloseGuard";

/**
 * Identical to identityRules.ts normalizeEmail. A copy, not an import, for
 * the reason at the top of this file; the test asserts the two agree.
 */
export function normalizeEmail(email: string | undefined | null): string {
  return (email ?? "").trim().toLowerCase();
}

/** An email read off a payload, where the field may be anything at all. */
function emailOf(x: unknown): string {
  return typeof x === "string" ? normalizeEmail(x) : "";
}

function roleOf(role: unknown): string {
  return String(role ?? "").trim().toLowerCase();
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function hasOwn(o: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/**
 * A DIRECT ROLE CHECK, NOTHING ELSE. Not canViewStudent (which puts campus
 * aides with PBIS for student look-ups) and not canReadInsights (which an
 * Attendance Watch grant satisfies). A campus aide or a teacher with a grant
 * still sees only their own referrals.
 */
export function seesAllReferrals(role: unknown): boolean {
  return REFERRAL_ALL_ROLES.includes(roleOf(role));
}

export function canCloseReferrals(role: unknown): boolean {
  return REFERRAL_CLOSE_ROLES.includes(roleOf(role));
}

/**
 * Is this referral this person's? EMAIL ONLY.
 *
 * The browser's rule also matches the display name (`referredBy`) and a
 * username. Neither is safe on the server:
 *   - a teacher's `name` is staff-writable (appDataShape.ts TEACHER_WRITABLE),
 *     so matching on it would let anyone read a colleague's referrals by
 *     renaming themselves;
 *   - username was removed with the cleartext passwords and is never written.
 * The client copies the filer's verified email into BOTH filedByEmail and
 * referredByEmail at filing; production has both on 18 of 18 rows, always
 * equal. The cost, measured before switching on by referralAccess:compareScope
 * (nameOnlyMatches): a referral an admin files in a teacher's name will not
 * reach that teacher. Production has none.
 */
export function ownsReferral(payload: unknown, email: unknown): boolean {
  const me = emailOf(email);
  if (!me || !isObj(payload)) return false;
  return emailOf(payload.filedByEmail) === me || emailOf(payload.referredByEmail) === me;
}

export type ReferralViewer = { email?: unknown; role?: unknown };

/**
 * The stored rows a viewer may be served from doc 'referrals'.
 *
 * ONLY UNKEYED behaviorReferrals ROWS, for everyone. A keyed row in this doc
 * would turn loadDoc's rebuild into a map of just the keyed rows, and every
 * browser would show zero referrals; no real tab writes one (legacyData's
 * mergeSlice refuses them), so dropping them here costs nothing and closes
 * the trick for any row that predates that refusal.
 *
 * A viewer with no email gets nothing rather than everything: the failure of
 * a broken match must be too little, never the whole school.
 */
export function scopeReferralRows<T extends { collection: string; key?: string | null; payload: unknown }>(
  rows: T[], viewer: ReferralViewer,
): T[] {
  const slice = rows.filter((r) => r.collection === "behaviorReferrals" && typeof r.key !== "string");
  if (seesAllReferrals(viewer.role)) return slice;
  if (!emailOf(viewer.email)) return [];
  return slice.filter((r) => ownsReferral(r.payload, viewer.email));
}

/**
 * TODAY'S BROWSER RULE, kept here only so the CLI comparison can measure what
 * moving to email-only would hide (wildcat-discipline.js ownsReferral). Never
 * used to decide access: it matches on the staff-writable display name.
 */
export function browserRuleOwns(payload: unknown, viewer: { email?: unknown; name?: unknown; username?: unknown; id?: unknown }): boolean {
  if (!isObj(payload) || !viewer) return false;
  const keys = new Set<string>();
  for (const k of [viewer.username, viewer.email, viewer.name, viewer.id]) {
    const s = String(k ?? "").trim().toLowerCase();
    if (s) keys.add(s);
  }
  if (!keys.size) return false;
  for (const f of [payload.filedByUsername, payload.referredByUsername,
    payload.filedByEmail, payload.referredByEmail, payload.referredBy]) {
    const s = String(f ?? "").trim().toLowerCase();
    if (s && keys.has(s)) return true;
  }
  return false;
}

/**
 * Written once, at filing, and never again by anyone. Pinned to the stored
 * value on every update, so nobody can claim a colleague's referral (and so
 * be served it by the email scoping above) by sending a copy that names them.
 */
export const OWNER_FIELDS: readonly string[] = ["id", "filedByEmail", "referredByEmail", "submittedAt"];

/**
 * WHICH CHILD A REFERRAL IS ABOUT is written once too (review, 2026-10-07).
 * No screen ever changes the student on a referral after filing. But the
 * race breakdown PBIS reads (disciplineAggregates.ts) counts the stored
 * referrals by studentNumber, and PBIS, as a closer, is never guarded: a
 * newer copy of any referral with studentNumber set to one chosen child moved
 * that child into the picture and out again, and the cell that moved was the
 * child's race. Pinned for everyone, admins included -- nothing legitimate
 * sends a different student.
 */
export const SUBJECT_FIELDS: readonly string[] = ["studentId", "studentNumber", "studentName"];

/** Everything pinOwnerFields keeps at its stored value. */
export const WRITE_ONCE_FIELDS: readonly string[] = [...OWNER_FIELDS, ...SUBJECT_FIELDS];

/**
 * Everything closing a referral or closing its loop writes (script.js
 * confirmCloseReferral and confirmCloseLoop; updatedAt aside). The test greps
 * those two functions and fails if one starts writing a field missing here,
 * because a close field this list does not know about would slip past the
 * guard unnoticed.
 */
export const CLOSE_FIELDS: readonly string[] = [
  "status", "resolutionType", "closingActions", "adminNotes", "closedBy", "closedAt",
  "consequence", "detentionDays", "loopClosed", "loopClosedBy", "loopClosedAt", "forwardedTo",
];

/**
 * What submitBehaviorReferral (script.js) writes into the close fields at
 * filing. consequence and detentionDays are not written until a close, so a
 * filing has them absent. A function, so no two referrals share an array.
 */
export function filingDefaults(): Record<string, unknown> {
  return {
    status: "open", resolutionType: "", closingActions: [], adminNotes: "",
    closedBy: "", closedAt: "", loopClosed: false, loopClosedBy: "", loopClosedAt: "",
    forwardedTo: [],
  };
}

/**
 * The owner fields and the student fields (WRITE_ONCE_FIELDS) go back to what
 * is stored; a key the stored row does not have is removed. Anything else in
 * `merged` is left exactly as it is.
 */
export function pinOwnerFields(stored: unknown, merged: unknown): unknown {
  if (!isObj(stored) || !isObj(merged)) return merged;
  const out: Record<string, unknown> = { ...merged };
  for (const k of WRITE_ONCE_FIELDS) {
    if (hasOwn(stored, k)) out[k] = stored[k];
    else delete out[k];
  }
  return out;
}

/** The four stamps a merge orders copies by, latest wins. */
export const STAMP_FIELDS: readonly string[] = ["updatedAt", "loopClosedAt", "closedAt", "submittedAt"];

function stampMs(raw: unknown): number {
  return typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
}

/**
 * Identical to touchedAt in legacyData.ts: the LATEST of the four stamps, zero
 * when none parses. A copy, for the reason at the top; the test runs both on
 * the same rows.
 */
export function referralTouchedAt(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const p = payload as Record<string, unknown>;
  let best = 0;
  for (const field of STAMP_FIELDS) {
    const t = stampMs(p[field]);
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best;
}

/**
 * How far ahead of the server's clock a stamp may be and still be believed.
 * A school Chromebook can be a few minutes off; one a year off is either a
 * broken clock or somebody locking a referral so no later edit can beat it.
 */
export const FUTURE_SLACK_MS = 5 * 60 * 1000;

/** Any stamp later than now + slack becomes the server's now. */
export function clampStamps(payload: Record<string, unknown>, nowMs: number): { payload: Record<string, unknown>; clamped: number } {
  const out: Record<string, unknown> = { ...payload };
  let clamped = 0;
  for (const f of STAMP_FIELDS) {
    const t = stampMs(out[f]);
    if (Number.isFinite(t) && t > nowMs + FUTURE_SLACK_MS) {
      out[f] = typeof out[f] === "number" ? nowMs : new Date(nowMs).toISOString();
      clamped++;
    }
  }
  return { payload: out, clamped };
}

/** Order-independent equality for the JSON-ish values a referral holds. */
function canon(x: unknown): string {
  if (Array.isArray(x)) return "[" + x.map(canon).join(",") + "]";
  if (isObj(x)) {
    return "{" + Object.keys(x).sort().map((k) => JSON.stringify(k) + ":" + canon(x[k])).join(",") + "}";
  }
  return JSON.stringify(x) ?? "undefined";
}

function onlyUpdatedAtDiffers(stored: Record<string, unknown>, merged: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(stored), ...Object.keys(merged)]);
  for (const k of keys) {
    if (k === "updatedAt") continue;
    if (canon(stored[k]) !== canon(merged[k])) return false;
  }
  return true;
}

function triedToChangeCloseFields(incoming: Record<string, unknown>, base: Record<string, unknown>): boolean {
  return CLOSE_FIELDS.some((k) => hasOwn(incoming, k) && canon(incoming[k]) !== canon(base[k]));
}

export type UpdatePlan =
  | { write: false; reason: "notYours" | "stale" | "keptCloseFields" | "noChange"; clamped: number }
  | { write: true; payload: unknown; clamped: number; keptCloseFields: boolean };

export type InsertPlan =
  | { write: false; reason: "notYours"; clamped: number }
  | { write: true; payload: unknown; clamped: number; keptCloseFields: boolean };

/**
 * What to do with an incoming copy of a referral that is already stored.
 *
 * GUARD OFF (the switch, or a closer): today's rule exactly -- the copy lands
 * only if it was touched later than the stored one, as {...stored, ...incoming}
 * -- plus the owner and student pin, which is always on.
 *
 * GUARD ON, caller not a closer:
 *   - someone else's referral: not written ('notYours'). An old tab re-sends
 *     every row it holds on every save; those rows are simply skipped;
 *   - the stored copy is as new or newer: not written ('stale'). Counted apart
 *     from a close attempt, because it is what every tab that has not pulled
 *     since an admin closed one of its referrals sends on every save;
 *   - otherwise the filer's own edit lands WITHOUT the close, owner and
 *     student fields, which keep their stored values, with stamps clamped to
 *     the server's clock. If that leaves nothing but updatedAt changed,
 *     nothing is written:
 *     'keptCloseFields' when the copy tried to change a close field (a teacher
 *     clicking Close in an old tab), else 'noChange'. So an unchanged row is
 *     not rewritten on every save.
 *
 * NEVER THROWS, by design: a refusal here is one row skipped, never a whole
 * save rolled back. A throw would also take down the teacher's own new
 * referral in the same batch.
 */
export function planReferralUpdate(
  stored: unknown, incoming: unknown, viewer: ReferralViewer,
  opts: { guard: boolean; nowMs: number },
): UpdatePlan {
  if (!opts.guard) {
    if (!(referralTouchedAt(incoming) > referralTouchedAt(stored))) {
      return { write: false, reason: "stale", clamped: 0 };
    }
    const merged = isObj(stored) && isObj(incoming) ? { ...stored, ...incoming } : incoming;
    return { write: true, payload: pinOwnerFields(stored, merged), clamped: 0, keptCloseFields: false };
  }
  if (!ownsReferral(stored, viewer.email)) return { write: false, reason: "notYours", clamped: 0 };
  if (!isObj(stored) || !isObj(incoming)) return { write: false, reason: "noChange", clamped: 0 };

  const { payload: timed, clamped } = clampStamps(incoming, opts.nowMs);
  if (!(referralTouchedAt(timed) > referralTouchedAt(stored))) {
    return { write: false, reason: "stale", clamped };
  }
  const editable: Record<string, unknown> = { ...timed };
  for (const k of CLOSE_FIELDS) delete editable[k];
  for (const k of WRITE_ONCE_FIELDS) delete editable[k];
  const merged: Record<string, unknown> = { ...stored, ...editable };
  const triedClose = triedToChangeCloseFields(incoming, stored);
  if (onlyUpdatedAtDiffers(stored, merged)) {
    return { write: false, reason: triedClose ? "keptCloseFields" : "noChange", clamped };
  }
  return { write: true, payload: merged, clamped, keptCloseFields: triedClose };
}

/**
 * What to do with a referral id the server has never stored.
 *
 * GUARD OFF: inserted as sent, which is today.
 *
 * GUARD ON, caller not a closer:
 *   - the copy must carry the caller's own email as filedByEmail or
 *     referredByEmail, and neither may name anyone else; otherwise it is
 *     refused ('notYours'). A real filing always does: submitBehaviorReferral
 *     writes the signed-in email into both. Anything else is an old tab
 *     bringing back a referral an admin deleted -- a colleague's, or one from
 *     before emails were recorded -- and stamping it with this teacher's email
 *     would hand them a child's record that was never theirs;
 *   - what passes is filed as the caller: both emails become theirs, the
 *     close fields are reset to what a filing writes (so a referral cannot be
 *     filed already closed, which would also stop the reminder emails), and
 *     the stamps are clamped.
 */
export function planReferralInsert(
  incoming: unknown, viewer: ReferralViewer,
  opts: { guard: boolean; nowMs: number },
): InsertPlan {
  if (!opts.guard) return { write: true, payload: incoming, clamped: 0, keptCloseFields: false };
  const me = emailOf(viewer.email);
  // Not an object: it cannot be shown to be anybody's, so it is not filed.
  if (!me || !isObj(incoming)) return { write: false, reason: "notYours", clamped: 0 };
  const filed = emailOf(incoming.filedByEmail);
  const referred = emailOf(incoming.referredByEmail);
  if ((filed && filed !== me) || (referred && referred !== me) || (filed !== me && referred !== me)) {
    return { write: false, reason: "notYours", clamped: 0 };
  }
  const defaults = filingDefaults();
  const triedClose = triedToChangeCloseFields(incoming, defaults);
  const filing: Record<string, unknown> = { ...incoming, ...defaults, filedByEmail: me, referredByEmail: me };
  for (const k of CLOSE_FIELDS) if (!hasOwn(defaults, k)) delete filing[k];
  const { payload, clamped } = clampStamps(filing, opts.nowMs);
  return { write: true, payload, clamped, keptCloseFields: triedClose };
}

export type ReferralSwitch = { enabled: boolean; pilotEmails: string[] };

/**
 * A switch row's value, read defensively. ON only for a real `true`; a pilot
 * list of emails, normalised; an empty list means everyone (the cashAward
 * convention). A pilotEmails that is present but not a list is a hand-edited
 * row nobody can read the intent of, and it reads as OFF -- today's behaviour
 * -- rather than as "everyone", which an empty list would mean.
 *
 * So does a list that NAMED someone but holds no usable email (review,
 * 2026-10-07): [""] from a pilot command whose shell variable was unset, or
 * [123, null]. Read as "the pilot list is empty", either turned the switch on
 * for the whole school, and the non-pilot teacher who must not change would
 * have changed without anybody noticing. writeSwitch refuses to store one.
 */
export function normalizeSwitch(value: unknown): ReferralSwitch {
  if (!isObj(value)) return { enabled: false, pilotEmails: [] };
  const raw = value.pilotEmails;
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) return { enabled: false, pilotEmails: [] };
  const pilotEmails = Array.isArray(raw) ? raw.map(emailOf).filter(Boolean) : [];
  if (Array.isArray(raw) && raw.length > 0 && pilotEmails.length === 0) return { enabled: false, pilotEmails: [] };
  return { enabled: value.enabled === true, pilotEmails };
}

/** On, and either open to everyone or naming this caller. */
export function switchAllows(sw: ReferralSwitch | null | undefined, email: unknown): boolean {
  if (!sw || sw.enabled !== true) return false;
  if (!sw.pilotEmails.length) return true;
  const me = emailOf(email);
  return !!me && sw.pilotEmails.includes(me);
}
