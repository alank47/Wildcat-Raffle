import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { mailPlan } from "./referralMailRules";

/**
 * Tell six people, and the teacher, that a referral was filed.
 *
 * THE TRIGGER IS AN INSERT, NOT A BROWSER CALL, and that is the whole security
 * design rather than a detail. There is no public function here: no argument
 * names a referral, no argument names a recipient, and no argument carries
 * content. A browser cannot ask for an email at all. The only input from
 * outside is which rows a transaction happened to insert, which is not a value
 * a caller chooses.
 *
 * The alternative -- a public action taking { referralId } -- would have let
 * any of the fifty-eight signed-in staff mail any referral to the Chief of
 * Schools on demand, and would have needed the tab to survive one more round
 * trip: the exact assumption that lost a referral on 2026-09-08.
 *
 * IDEMPOTENCY COMES FROM MACHINERY THAT ALREADY EXISTS. The referrals slice is
 * re-sent whole on every save from every tab forever, and a referral already
 * stored matches by id and falls into mergeSlice's update branch, never the
 * insert one. The insert IS the once-only moment. referralMailLog is the belt
 * over that brace.
 */

/** Older than this when it first reaches the server, and nobody is mailed. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** More inserts than this in one save is a restore, not a teacher filing. */
const MAX_MAILS_PER_SAVE = 3;

/**
 * Called from legacyData:mergeSlice, inside the transaction that inserted the
 * rows. A plain helper rather than a mutation, the same shape requireStaff is
 * used in there.
 *
 * NEVER THROWS. A referral that saved must not be rolled back because an email
 * could not be scheduled; the referral is the record and the mail is a
 * courtesy. Everything it decides is written to referralMailLog, so a silent
 * skip is still a visible one.
 */
export async function notifyNewReferrals(
  ctx: MutationCtx,
  me: { email?: string; name?: string },
  payloads: unknown[],
): Promise<void> {
  try {
    const filer = { email: String(me?.email ?? ""), name: String(me?.name ?? "") };
    if (!filer.email.includes("@")) return;

    // A BULK RESTORE IS NOT SIXTY TEACHERS FILING. legacyPurge and a
    // first-sync from an old tab both insert many referrals at once, and
    // mailing all of them would be the loudest possible way to discover that.
    const bulk = payloads.length > MAX_MAILS_PER_SAVE;
    const now = Date.now();

    for (const payload of payloads) {
      const r = payload as any;
      const id = String(r?.id ?? "").trim();
      if (!id) continue;

      // IN THE SAME TRANSACTION AS THE INSERT, so two tabs racing cannot both
      // schedule. Whichever commits first owns the row.
      const already = await ctx.db
        .query("referralMailLog")
        .withIndex("by_referral", (q) => q.eq("referralId", id))
        .first();
      if (already) continue;

      const submitted = Date.parse(String(r?.submittedAt ?? ""));
      const stale = Number.isFinite(submitted) && now - submitted > MAX_AGE_MS;
      const skip = bulk ? "bulk" : stale ? "old" : null;

      // The skip is LOGGED, not just taken. A referral nobody was told about
      // should be findable afterwards.
      await ctx.db.insert("referralMailLog", {
        referralId: id,
        state: skip ? "skipped" : "queued",
        reason: skip === "bulk"
          ? `${payloads.length} referrals arrived in one save; treated as a restore, not a filing`
          : skip === "old"
            ? "submitted more than 24 hours before it reached the server"
            : undefined,
        filedByEmail: filer.email,
        at: new Date().toISOString(),
      });
      if (skip) continue;

      // Scheduled, not awaited: part of this transaction, so if the referral
      // commits the send is durably queued server-side and runs whether or not
      // the browser is still there.
      await ctx.scheduler.runAfter(0, internal.referralMail.deliver, {
        referralId: id,
        payload: r,
        filerEmail: filer.email,
        filerName: filer.name,
      });
    }
  } catch {
    // Deliberately swallowed. See the contract above.
  }
}

export const finish = internalMutation({
  args: {
    referralId: v.string(),
    state: v.union(v.literal("sent"), v.literal("failed")),
    sent: v.optional(v.number()),
    recipients: v.optional(v.number()),
    refused: v.optional(v.array(v.string())),
    error: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const row = await ctx.db
      .query("referralMailLog")
      .withIndex("by_referral", (q) => q.eq("referralId", a.referralId))
      .first();
    if (!row) return;
    await ctx.db.patch(row._id, {
      state: a.state,
      sent: a.sent,
      recipients: a.recipients,
      refused: a.refused,
      error: a.error,
      finishedAt: new Date().toISOString(),
    });
  },
});

export const deliver = internalAction({
  args: {
    referralId: v.string(),
    payload: v.any(),
    filerEmail: v.string(),
    filerName: v.optional(v.string()),
  },
  handler: async (ctx, { referralId, payload, filerEmail, filerName }) => {
    const plan = mailPlan(payload, { email: filerEmail, name: filerName });
    try {
      const res: any = await ctx.runAction(internal.mail.send, {
        to: plan.to,
        subject: plan.subject,
        html: plan.html,
        live: true,
      });
      await ctx.runMutation(internal.referralMail.finish, {
        referralId,
        state: "sent",
        sent: res?.sent ?? 0,
        recipients: plan.to.length,
        refused: res?.refused ?? [],
      });
    } catch (err: any) {
      // NOT RETRIED HERE. mail:send sets saveToSentItems, so a send that
      // reached Graph is visible in the Westbrook mailbox; a blind retry is
      // how six people get the same child's referral twice. The row says
      // "failed" and a human decides.
      await ctx.runMutation(internal.referralMail.finish, {
        referralId,
        state: "failed",
        recipients: plan.to.length,
        error: String(err?.message ?? err).slice(0, 400),
      });
    }
  },
});

/** What has been mailed lately. Counts and states; no student, no body. */
export const recent = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("referralMailLog").collect();
    const byState: Record<string, number> = {};
    for (const r of rows) byState[r.state] = (byState[r.state] ?? 0) + 1;
    return {
      total: rows.length,
      byState,
      // The ones a human should look at: queued means scheduled and never
      // finished, which is the one failure this design cannot self-heal.
      stuck: rows.filter((r) => r.state === "queued").map((r) => ({ referralId: r.referralId, at: r.at })),
      failed: rows.filter((r) => r.state === "failed")
        .map((r) => ({ referralId: r.referralId, at: r.at, error: r.error })),
    };
  },
});
