import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { readReferralSwitch, rebuildDoc } from "./legacyData";
import {
  REFERRAL_SCOPE_KEY, REFERRAL_CLOSE_GUARD_KEY, normalizeEmail, normalizeSwitch,
  seesAllReferrals, canCloseReferrals, ownsReferral, scopeReferralRows, browserRuleOwns,
  planReferralUpdate, planReferralInsert,
} from "./referralAccessRules";

/**
 * THE REFERRAL SWITCHES, FROM THE COMMAND LINE. Every function here is
 * internal: no browser can reach one, and none returns a name, an id or a
 * word of a referral -- counts, booleans and role names only, so a check run
 * against production can be pasted anywhere.
 *
 * TWO SWITCHES (referralAccessRules.ts says why two):
 *
 *   referralScope       loadDoc serves a teacher or campus aide only their own
 *                       referrals, and no detentions. Safe for every open tab,
 *                       so it can be piloted as soon as the server is live.
 *
 *   referralCloseGuard  mergeSlice keeps the close fields on a non-closer's
 *                       copy, skips other people's referrals, and refuses a
 *                       detention made from a referral. Turn it on ONLY after
 *                       the site that hides Close from teachers has reached
 *                       the open tabs (about a school day after that push):
 *                       before then a teacher clicking Close in an old tab
 *                       sees "closed" while the server keeps it open.
 *
 * Absent means OFF, for both. Commands (add --prod for production):
 *
 *   npx convex run referralAccess:status
 *   npx convex run referralAccess:compareScope '{"emails":["a@x","b@x"]}'
 *   npx convex run referralAccess:previewWrites '{"email":"a@x"}'
 *   npx convex run referralAccess:configureScope '{"enabled":true,"pilotEmails":["a@x"]}'
 *   npx convex run referralAccess:configureScope '{"pilotEmails":[]}'      (everyone)
 *   npx convex run referralAccess:configureScope '{"enabled":false}'      (instant off)
 *   npx convex run referralAccess:configureCloseGuard '{"enabled":true}'
 *
 * Against production, pass --codegen disable --typecheck disable (convex/
 * _generated is tracked) and never --push.
 */

async function writeSwitch(
  ctx: MutationCtx, key: string, a: { enabled?: boolean; pilotEmails?: string[] },
) {
  const row = await ctx.db.query("appState").withIndex("by_key", (q) => q.eq("key", key)).first();
  // OVERLAID ON THE PREVIOUS VALUE, like cashAward:configure: narrowing the
  // pilot list must not need retyping `enabled`, and switching off must not
  // forget who the pilot was.
  const prev = normalizeSwitch(row?.value);
  const next = {
    enabled: a.enabled ?? prev.enabled,
    pilotEmails: a.pilotEmails !== undefined
      ? a.pilotEmails.map((e) => normalizeEmail(e)).filter(Boolean)
      : prev.pilotEmails,
  };
  const at = new Date().toISOString();
  if (row) await ctx.db.patch(row._id, { value: next, mirroredAt: at });
  else await ctx.db.insert("appState", { key, value: next, mirroredAt: at });
  return next;
}

const switchArgs = {
  enabled: v.optional(v.boolean()),
  pilotEmails: v.optional(v.array(v.string())),
};

export const configureScope = internalMutation({
  args: switchArgs,
  handler: async (ctx, a) => writeSwitch(ctx, REFERRAL_SCOPE_KEY, a),
});

export const configureCloseGuard = internalMutation({
  args: switchArgs,
  handler: async (ctx, a) => writeSwitch(ctx, REFERRAL_CLOSE_GUARD_KEY, a),
});

/** Both switches, as the server reads them (a malformed row reads as OFF). */
export const status = internalQuery({
  args: {},
  handler: async (ctx) => ({
    referralScope: await readReferralSwitch(ctx, REFERRAL_SCOPE_KEY),
    referralCloseGuard: await readReferralSwitch(ctx, REFERRAL_CLOSE_GUARD_KEY),
  }),
});

const countOf = (x: unknown): number =>
  Array.isArray(x) ? x.length : x && typeof x === "object" ? Object.keys(x).length : 0;

/**
 * TODAY'S READ AND THE SCOPED READ, SIDE BY SIDE, ON THE SAME ROWS.
 *
 * Reads the referrals doc ONCE and runs both rebuilds on that one array, so a
 * difference can only come from the scoping, never from a referral filed
 * between two reads. One entry per email asked about, in the order asked;
 * nothing that names anyone comes back.
 *
 * What a go looks like, before switching on:
 *   - admin and PBIS: identicalToCurrent true;
 *   - each teacher: everyScopedRowOwned true and ownedButMissing 0;
 *   - nameOnlyMatches 0 -- the referrals today's browser shows a teacher by
 *     NAME that the email rule would hide (an admin filing in their name).
 * closedByNonCloserRole sizes the "teachers lose Close" question: closed rows
 * whose closedBy is the name of a teacher or campus aide.
 */
export const compareScope = internalQuery({
  args: { emails: v.array(v.string()) },
  handler: async (ctx, { emails }) => {
    const rows = await ctx.db.query("legacyMirror")
      .withIndex("by_doc", (q) => q.eq("doc", "referrals")).collect();
    const current = rebuildDoc(rows);
    const currentJson = JSON.stringify(current);
    const slice = rows.filter((r) => r.collection === "behaviorReferrals" && typeof r.key !== "string");

    const people = [];
    for (const raw of emails) {
      const t = await ctx.db.query("teachers")
        .withIndex("by_email", (q) => q.eq("email", normalizeEmail(raw))).first();
      if (!t) { people.push({ found: false }); continue; }
      const seesAll = seesAllReferrals(t.role);
      const scopedRows = scopeReferralRows(rows, t);
      const scopedDoc = rebuildDoc(scopedRows) ?? { behaviorReferrals: [] };
      const scopedIds = new Set(scopedRows.map((r) => r._id));
      const owned = slice.filter((r) => ownsReferral(r.payload, t.email));
      const browser = seesAll ? slice.length
        : slice.filter((r) => browserRuleOwns(r.payload, { email: t.email, name: t.name })).length;
      people.push({
        found: true,
        role: t.role,
        seesAll,
        current: countOf(current?.behaviorReferrals),
        scoped: countOf(scopedDoc.behaviorReferrals),
        identicalToCurrent: JSON.stringify(scopedDoc) === currentJson,
        everyScopedRowOwned: seesAll || scopedRows.every((r) => ownsReferral(r.payload, t.email)),
        ownedButMissing: owned.filter((r) => !scopedIds.has(r._id)).length,
        clientRuleWouldShow: browser,
        nameOnlyMatches: seesAll ? 0 : Math.max(0, browser - scopedRows.length),
      });
    }

    // Who closed what, by role, from the stored display names. Names are
    // matched and counted here and never returned.
    const staff = await ctx.db.query("teachers").collect();
    const nonCloserNames = new Set<string>();
    const closerNames = new Set<string>();
    for (const s of staff) {
      const n = String(s.name ?? "").trim().toLowerCase();
      if (!n) continue;
      (canCloseReferrals(s.role) ? closerNames : nonCloserNames).add(n);
    }
    const byNonCloser = (name: unknown) => {
      const n = String(name ?? "").trim().toLowerCase();
      return !!n && nonCloserNames.has(n) && !closerNames.has(n);
    };
    const payloads = slice.map((r) => (r.payload ?? {}) as Record<string, unknown>);
    const closed = payloads.filter((p) => p.status === "closed");
    return {
      rows: slice.length,
      keyedOrOtherRows: rows.length - slice.length,
      people,
      closed: closed.length,
      closedByNonCloserRole: closed.filter((p) => byNonCloser(p.closedBy)).length,
      loopClosed: payloads.filter((p) => p.loopClosed === true).length,
      loopClosedByNonCloserRole: payloads.filter((p) => p.loopClosed === true && byNonCloser(p.loopClosedBy)).length,
    };
  },
});

type Tally = Record<string, number>;
const bump = (t: Tally, k: string) => { t[k] = (t[k] ?? 0) + 1; };

/**
 * WHAT THE CLOSE GUARD WOULD DO TO ONE PERSON'S SAVES, with nothing written.
 *
 * Runs the guard's own plan (planReferralUpdate / planReferralInsert, the
 * functions mergeSlice calls) against every stored referral as if that
 * person's tab sent four edits of it, with the guard FORCED ON for them --
 * which for a closer means not at all, exactly as in mergeSlice. Returns the
 * count of each outcome, and the counts the rules predict from `rows` and
 * `owned`, so the check is one boolean (matchesExpected) and a mismatch shows
 * which reason moved.
 *
 *   close   a Close (status, closedAt, closedBy, notes, actions)
 *   edit    a description edit
 *   claim   a description edit that also names this person as the filer
 *   future  a description edit stamped 9999-01-01
 * plus two inserts: their own new referral sent already closed, and every
 * colleague's referral re-sent as if it had been deleted.
 */
export const previewWrites = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const t = await ctx.db.query("teachers")
      .withIndex("by_email", (q) => q.eq("email", normalizeEmail(email))).first();
    if (!t) return { found: false };
    const rows = (await ctx.db.query("legacyMirror")
      .withIndex("by_doc_collection", (q) => q.eq("doc", "referrals").eq("collection", "behaviorReferrals"))
      .collect()).filter((r) => typeof r.key !== "string");

    const guard = !canCloseReferrals(t.role);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const opts = { guard, nowMs };
    const viewer = { email: t.email, role: t.role };
    const PREVIEW = " (preview)";

    const attempts = {
      close: (p: Record<string, unknown>) => ({ ...p, status: "closed", closedAt: now, closedBy: t.name,
        resolutionType: "action_taken", closingActions: [PREVIEW], adminNotes: PREVIEW, updatedAt: now }),
      edit: (p: Record<string, unknown>) => ({ ...p, description: String(p.description ?? "") + PREVIEW, updatedAt: now }),
      claim: (p: Record<string, unknown>) => ({ ...p, filedByEmail: t.email, referredByEmail: t.email,
        description: String(p.description ?? "") + PREVIEW, updatedAt: now }),
      future: (p: Record<string, unknown>) => ({ ...p, description: String(p.description ?? "") + PREVIEW,
        updatedAt: "9999-01-01T00:00:00.000Z" }),
    };
    const out: Record<string, Tally> = {};
    let owned = 0;
    for (const r of rows) {
      const p = (r.payload && typeof r.payload === "object" ? r.payload : {}) as Record<string, unknown>;
      if (ownsReferral(p, t.email)) owned++;
      for (const [name, make] of Object.entries(attempts)) {
        const tally = (out[name] ??= { written: 0, notYours: 0, stale: 0, keptCloseFields: 0, noChange: 0 });
        const plan = planReferralUpdate(p, make(p), viewer, opts);
        if (!plan.write) { bump(tally, plan.reason); continue; }
        bump(tally, "written");
        const w = plan.payload as Record<string, unknown>;
        if (name === "close" && w.status === "closed") bump(tally, "closeLanded");
        if (name === "claim" && w.filedByEmail === p.filedByEmail && w.referredByEmail === p.referredByEmail) bump(tally, "ownerKept");
        if (name === "future" && plan.clamped > 0) bump(tally, "clamped");
        if (name === "future" && String(w.updatedAt ?? "").startsWith("9999")) bump(tally, "futureStored");
      }
    }
    const ownClosed = planReferralInsert({ id: "PREVIEW", status: "closed", closedBy: t.name, adminNotes: PREVIEW,
      filedByEmail: t.email, referredByEmail: t.email, submittedAt: now, updatedAt: now }, viewer, opts);
    let colleaguesRefiled = 0, colleaguesRefused = 0;
    for (const r of rows) {
      if (ownsReferral(r.payload, t.email)) continue;
      if (planReferralInsert(r.payload, viewer, opts).write) colleaguesRefiled++; else colleaguesRefused++;
    }

    // What the rules say each count should be, from rows and owned alone.
    const n = rows.length, k = owned, others = n - owned;
    const zero = { stale: 0, noChange: 0 };
    const expected: Record<string, Tally> = guard ? {
      close: { written: 0, notYours: others, keptCloseFields: k, ...zero },
      edit: { written: k, notYours: others, keptCloseFields: 0, ...zero },
      claim: { written: k, notYours: others, keptCloseFields: 0, ownerKept: k, ...zero },
      future: { written: k, notYours: others, keptCloseFields: 0, clamped: k, ...zero },
    } : {
      close: { written: n, notYours: 0, keptCloseFields: 0, closeLanded: n, ...zero },
      edit: { written: n, notYours: 0, keptCloseFields: 0, ...zero },
      claim: { written: n, notYours: 0, keptCloseFields: 0, ownerKept: n, ...zero },
      // Closers' clocks are believed: an admin's far-future stamp is NOT
      // clamped (outside this change; it is counted so it stays visible).
      future: { written: n, notYours: 0, keptCloseFields: 0, futureStored: n, ...zero },
    };
    const matchesExpected = Object.entries(expected).every(([name, want]) =>
      Object.entries(want).every(([key, value]) => (out[name]?.[key] ?? 0) === value))
      && (guard ? colleaguesRefused === others && colleaguesRefiled === 0 : colleaguesRefiled === others);

    return {
      found: true,
      role: t.role,
      guardApplies: guard,
      rows: n,
      owned,
      attempts: out,
      expected,
      inserts: {
        ownClosedFiledOpen: ownClosed.write && (ownClosed.payload as Record<string, unknown>).status === "open",
        colleaguesRefiled,
        colleaguesRefused,
      },
      matchesExpected,
    };
  },
});
