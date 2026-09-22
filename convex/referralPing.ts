import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  pingsDue, pingRecipients, pingMailPlan, pingSettingsOrDefault, schoolDay,
  loopRecipientFor, SCHOOL_DAY_SOURCE,
} from "./referralPingRules";

/**
 * NOBODY CLOSED THE REFERRAL. Say so, once, to the people who can.
 *
 * WHY THIS EXISTS. On 2026-09-22 the school had filed four behavior referrals
 * in total. Three were still open -- at four, five and seven days -- and the
 * oldest carried `severeBypass`, the flag a teacher sets when an incident is
 * too serious for the intervention ladder. A fourth had been closed a week
 * earlier and the teacher who filed it had never been told the outcome.
 *
 * Nothing in the app said any of that. The filing mail goes out once, lands in
 * seven inboxes, and then the referral's whole future depends on somebody
 * remembering to open a tab. This is the part that remembers.
 *
 * IT IS OFF UNTIL SOMEBODY TURNS IT ON. Mail to named school leaders about
 * named children is not a thing to enable by deploying. See `configure`.
 *
 * THE SHAPE, and why it is three functions rather than one:
 *
 *   due()      a query. Reads, decides, returns. No writes, no mail, so it is
 *              safe to run by hand to see exactly what would be sent.
 *   claim()    a mutation. Inserts the "queued" row and returns false if one
 *              already exists. This is where "once" actually lives.
 *   sweep()    the action the cron calls: due -> claim -> send -> finish.
 *
 * The claim is taken BEFORE the send, not after. Two cron runs overlapping, a
 * redeploy mid-run, a retry -- all of them lose the race at the insert rather
 * than in a mail client.
 */

const STATE_KEY = "referralPings";

/** Nothing older than this is chased. A referral from last term is history. */
const MAX_AGE_SCHOOL_DAYS = 60;

/** Per run. A backlog arrives over days, not in one morning's mail flood. */
const MAX_SENDS_PER_SWEEP = 12;

/**
 * How far behind the school-day calendar may fall before the sweep refuses.
 *
 * Four days clears a three-day weekend with a day in hand, and still catches
 * a rebuild that has been failing since the week before.
 */
const MAX_CALENDAR_LAG_DAYS = 4;
/* Four clears a three-day weekend with a day to spare, and still catches a
 * rebuild that has been failing since the week before. It applies to both the
 * age of the last write and the gap between the last school day and today. */

/** A "queued" row older than this never finished; a sweep takes seconds. */
const STUCK_QUEUED_MS = 6 * 60 * 60 * 1000;

type Settings = ReturnType<typeof pingSettingsOrDefault>;

async function readSettings(ctx: any): Promise<Settings> {
  const row = await ctx.db.query("appState").withIndex("by_key", (q: any) => q.eq("key", STATE_KEY)).first();
  return pingSettingsOrDefault(row?.value);
}

/**
 * Turn it on, or change a threshold. CLI only.
 *
 *   npx convex run referralPing:configure '{"enabled":true}'
 *
 * A MUTATION AND NOT AN ENV VAR because the thresholds are the part a school
 * will want to move -- "two days is too jumpy, make it three" is a Tuesday
 * conversation, and it should not need a developer, a deploy, or a restart.
 * Who may call it is answered by `internalMutation`: no browser reaches this.
 */
export const configure = internalMutation({
  args: {
    enabled: v.optional(v.boolean()),
    nudgeAfterSchoolDays: v.optional(v.number()),
    escalateAfterSchoolDays: v.optional(v.number()),
    severeAfterSchoolDays: v.optional(v.number()),
    loopAfterSchoolDays: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("appState").withIndex("by_key", (q) => q.eq("key", STATE_KEY)).first();
    const current: Record<string, unknown> = { ...pingSettingsOrDefault(row?.value) };
    for (const [k, val] of Object.entries(a)) if (val !== undefined) current[k] = val;
    const next = pingSettingsOrDefault(current);
    const at = new Date().toISOString();
    if (row) await ctx.db.patch(row._id, { value: next, mirroredAt: at });
    else await ctx.db.insert("appState", { key: STATE_KEY, value: next, mirroredAt: at });
    return next;
  },
});

/**
 * What would be sent right now, and to whom. Reads only.
 *
 * SCHOOL DAYS COME FROM ATTENDANCE, not a calendar somebody transcribed.
 * psAbsenceDayTotals holds one row per date the school actually took
 * attendance, rebuilt twice daily beside the PowerSchool sync -- so a minimum
 * day, a staff development day and Labor Day all take care of themselves, and
 * nobody has to remember to update a holiday list in August.
 *
 * IT REFUSES RATHER THAN GUESSING. If that table is empty the answer is "no
 * school day list" and nothing is sent, because the fallback -- counting
 * weekdays -- would mail the Chief of Schools about a referral that had been
 * open for one working day over a long weekend. The first wrong escalation is
 * the one that gets the whole feature switched off.
 */
export const due = internalQuery({
  args: { today: v.optional(v.string()) },
  handler: async (ctx, { today }) => {
    const settings = await readSettings(ctx);
    // THE SCHOOL'S DAY, NOT THE SERVER'S. Convex runs UTC. The cron fires at
    // 15:00 UTC, which is the same date in Los Angeles, but a human running
    // this by hand at 5pm Pacific is already on tomorrow's UTC date, and every
    // age would come out a day too large.
    const day = schoolDay(today || new Date().toISOString()) || "";

    const dayRows = await ctx.db.query("psAbsenceDayTotals").withIndex("by_date").take(400);
    const schoolDays = dayRows.map((d) => String(d.date).slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    const newestSchoolDay = schoolDays.length ? schoolDays[schoolDays.length - 1] : null;

    // WHEN WAS THE CALENDAR LAST WRITTEN, not what dates it happens to hold.
    //
    // The obvious freshness test -- how far the newest school day is behind
    // today -- is the wrong measurement here, and production said so within
    // minutes of shipping it. PowerSchool holds attendance dated into the
    // FUTURE: on 2026-09-22 the newest row was 2026-10-09, seventeen days
    // ahead. So "newest date vs today" was permanently negative, and a rebuild
    // that died this morning would not have looked stale until October.
    //
    // syncedAt is what the rebuild stamps every time it writes, so it answers
    // the question actually being asked: is that job still running? It is
    // immune to whatever dates the data contains.
    let newestSync: string | null = null;
    for (const r of dayRows) {
      const t = String(r.syncedAt ?? "");
      if (t && (newestSync === null || t > newestSync)) newestSync = t;
    }

    // HOW STALE IS THE CALENDAR? Emptiness was the only thing checked, and it
    // is the rarer fault. attendanceDays:rebuild clears psAbsenceDayTotals and
    // rewrites it; if it starts failing -- a PowerSchool outage, a credential
    // expiring, the read paging out -- the table keeps yesterday's rows and
    // every referral filed after that date scores an age of zero, forever.
    // Chasing would stop dead while every diagnostic still read healthy, which
    // is the worst failure this feature has and the one it would report as
    // success. Days, not rows: a long weekend is three.
    const syncedAgeMs = newestSync !== null && Number.isFinite(Date.parse(newestSync))
      ? Date.now() - Date.parse(newestSync)
      : null;
    const syncAgeDays = syncedAgeMs === null ? null
      : Math.floor(syncedAgeMs / 86400000);

    // Two different faults, so two checks.
    //   the rebuild has stopped running   -> syncAgeDays
    //   it runs but the data stops short  -> dateLagDays, kept because a
    //                                        truncated read is a real failure
    //                                        mode and stamps a fresh syncedAt
    //                                        over a short calendar.
    const dateLagDays = newestSchoolDay && day
      ? Math.floor((Date.parse(day + "T00:00:00Z") - Date.parse(newestSchoolDay + "T00:00:00Z")) / 86400000)
      : null;
    const staleDays = syncAgeDays;
    const calendarStale =
      (syncAgeDays !== null && syncAgeDays > MAX_CALENDAR_LAG_DAYS) ||
      (dateLagDays !== null && dateLagDays > MAX_CALENDAR_LAG_DAYS) ||
      // No stamp at all means nothing can vouch for this calendar.
      (newestSync === null && schoolDays.length > 0);

    const mirror = await ctx.db
      .query("legacyMirror").withIndex("by_doc", (q) => q.eq("doc", "referrals")).take(2000);

    const already = new Set<string>();
    const pingRows = await ctx.db.query("referralPingLog").take(4000);
    for (const p of pingRows) {
      // A FAILED SEND STILL COUNTS AS SENT for this purpose. mail:send sets
      // saveToSentItems, so a "failed" row may well mean the mail reached
      // Graph and the bookkeeping afterwards did not. Re-firing on failure is
      // how six leaders get the same child's referral twice; the row says
      // failed and a person decides, exactly as referralMail:deliver does.
      already.add(p.referralId + "|" + p.stage);
    }

    const referrals = mirror
      .map((m) => m.payload as any)
      .filter((p) => p && typeof p === "object");

    const res = pingsDue(referrals, { today: day, schoolDays, settings, alreadySent: already });

    // Attach what the sender needs, and drop anything too old to chase.
    const byId = new Map<string, any>();
    // TRIMMED THE SAME WAY pingsDue TRIMS IT. Keying one map on the raw id and
    // the other on the trimmed one means a payload id with a stray space never
    // matches, and sweep then writes a permanent "no longer in the mirror"
    // skip -- a slot blocked forever, with a reason that is not true.
    for (const r of referrals) if (r?.id) byId.set(String(r.id).trim(), r);

    const plans = res.due
      .filter((d) => d.ageSchoolDays <= MAX_AGE_SCHOOL_DAYS)
      .map((d) => ({ ...d, to: pingRecipients(d.stage), referral: byId.get(d.referralId) ?? null }));

    return {
      today: day,
      enabled: settings.enabled,
      settings,
      schoolDaysKnown: schoolDays.length,
      newestSchoolDay,
      newestSync,
      syncAgeDays,
      dateLagDays,
      staleDays,
      calendarStale,
      schoolDaySource: SCHOOL_DAY_SOURCE,
      referrals: referrals.length,
      due: plans,
      agedOut: res.due.length - plans.length,
      skipped: res.skipped.length,
      skippedWhy: res.skipped.reduce((a: Record<string, number>, s) => {
        a[s.why] = (a[s.why] || 0) + 1; return a;
      }, {}),
    };
  },
});

/**
 * Take the slot for one (referral, stage), or report that it is taken.
 *
 * THE INSERT IS THE LOCK. Convex mutations are serializable, so of two callers
 * racing on the same pair exactly one sees no row and writes one.
 */
export const claim = internalMutation({
  args: {
    referralId: v.string(),
    stage: v.union(v.literal("nudge"), v.literal("escalation"), v.literal("severe"), v.literal("loop")),
    ageSchoolDays: v.optional(v.number()),
    recipients: v.optional(v.number()),
    skipReason: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const existing = await ctx.db
      .query("referralPingLog")
      .withIndex("by_stage", (q) => q.eq("referralId", a.referralId).eq("stage", a.stage))
      .first();
    if (existing) return { claimed: false as const };
    await ctx.db.insert("referralPingLog", {
      referralId: a.referralId,
      stage: a.stage,
      // A skip is WRITTEN, not just taken -- and it holds the slot, so a
      // reminder that could not be addressed is not retried every morning
      // forever. It is findable in the log instead.
      state: a.skipReason ? "skipped" : "queued",
      reason: a.skipReason,
      ageSchoolDays: a.ageSchoolDays,
      recipients: a.recipients,
      at: new Date().toISOString(),
    });
    return { claimed: !a.skipReason };
  },
});

export const finish = internalMutation({
  args: {
    referralId: v.string(),
    stage: v.union(v.literal("nudge"), v.literal("escalation"), v.literal("severe"), v.literal("loop")),
    state: v.union(v.literal("sent"), v.literal("failed")),
    sent: v.optional(v.number()),
    recipients: v.optional(v.number()),
    refused: v.optional(v.array(v.string())),
    error: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const row = await ctx.db
      .query("referralPingLog")
      .withIndex("by_stage", (q) => q.eq("referralId", a.referralId).eq("stage", a.stage))
      .first();
    if (!row) return;
    await ctx.db.patch(row._id, {
      state: a.state, sent: a.sent, recipients: a.recipients,
      refused: a.refused, error: a.error, finishedAt: new Date().toISOString(),
    });
  },
});

/**
 * The cron entry. Decide, claim, send, record.
 *
 * `dryRun` renders and addresses everything and sends nothing, which is how
 * this should be run the first few mornings.
 */
export const sweep = internalAction({
  args: { today: v.optional(v.string()), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { today, dryRun }) => {
    const plan: any = await ctx.runQuery(internal.referralPing.due, { today });

    if (!plan.enabled && !dryRun) {
      return { ...summarise(plan), sent: 0, note: "disabled; run referralPing:configure '{\"enabled\":true}' to turn it on" };
    }
    if (!plan.today) {
      return { ...summarise(plan), sent: 0, note: "could not determine the school's date; nothing sent" };
    }
    if (!plan.schoolDaysKnown) {
      return { ...summarise(plan), sent: 0, note: "no school-day list; nothing sent" };
    }
    if (plan.calendarStale) {
      // Refused for the same reason the empty list is refused, and said out
      // loud for the same reason: a stale calendar makes every age too small,
      // so the failure mode is silence.
      return {
        ...summarise(plan), sent: 0,
        note: plan.newestSync === null
          ? `the school-day calendar carries no syncedAt stamp, so nothing can vouch for it. Nothing sent.`
          : (plan.syncAgeDays !== null && plan.syncAgeDays > MAX_CALENDAR_LAG_DAYS)
            ? `the school-day calendar was last written ${plan.syncAgeDays} days ago `
              + `(${plan.newestSync}); attendanceDays:rebuild is probably failing. Nothing sent.`
            : `the school-day calendar stops at ${plan.newestSchoolDay}, ${plan.dateLagDays} days `
              + `before ${plan.today}, so the read behind attendanceDays:rebuild is truncated. `
              + `Nothing sent.`,
      };
    }

    const results: any[] = [];
    let sends = 0;

    for (const d of plan.due) {
      if (sends >= MAX_SENDS_PER_SWEEP) {
        // A CAP THAT SAYS SO. Silent truncation reads as "nothing else was
        // due", which is the opposite of true.
        results.push({ referralId: d.referralId, stage: d.stage, state: "deferred", reason: "per-run cap" });
        continue;
      }

      let to: string[] = d.to;
      let skipReason: string | undefined;

      if (d.stage === "loop") {
        // NEVER AN ADDRESS THE PAYLOAD CHOSE. `closedBy` is a display name a
        // browser wrote through mergeSlice behind requireStaff and nothing
        // more, so all fifty-eight staff can set it. Resolving it against the
        // whole `teachers` table -- whose name column is itself staff-writable
        // -- would have let any of them pick which colleague receives a named
        // child's full discipline record, by typing a name. That is the exact
        // capability referralMailRules.ts exists to make impossible.
        //
        // So the name is matched against the STANDING LIST, and nothing else.
        // If it names one of the six, the reminder goes to them alone; if it
        // does not, it goes to the five who can action it anyway, with the
        // recorded closer printed in the body. Either way the address set is a
        // constant in this repository and the payload cannot move it.
        const direct = loopRecipientFor(d.closedBy);
        to = direct ? [direct] : pingRecipients("nudge");
      }
      if (!skipReason && !to.length) skipReason = "no recipients for this stage";
      if (!skipReason && !d.referral) skipReason = "the referral is no longer in the mirror";

      // THE DRY RUN CLAIMS NOTHING. Claiming first and discovering the dry
      // run afterwards would leave a "queued" row that no mail matches, and
      // the real send would then find the slot taken and never happen -- a
      // rehearsal that silently cancels the performance.
      if (dryRun) {
        const preview = pingMailPlan(d.referral, {
          stage: d.stage, ageSchoolDays: d.ageSchoolDays, to, settings: plan.settings,
        });
        results.push({
          referralId: d.referralId, stage: d.stage,
          state: skipReason ? "would-skip" : "dry-run",
          reason: skipReason, to: preview.to, subject: preview.subject,
        });
        continue;
      }

      const claimed: any = await ctx.runMutation(internal.referralPing.claim, {
        referralId: d.referralId, stage: d.stage,
        ageSchoolDays: d.ageSchoolDays, recipients: to.length,
        skipReason,
      });
      if (!claimed.claimed) {
        results.push({ referralId: d.referralId, stage: d.stage, state: skipReason ? "skipped" : "already", reason: skipReason });
        continue;
      }

      const mail = pingMailPlan(d.referral, {
        stage: d.stage, ageSchoolDays: d.ageSchoolDays, to, settings: plan.settings,
      });

      sends++;
      // ONLY THE SEND IS INSIDE THE TRY. With finish() in here too, a failure
      // of the bookkeeping mutation was caught by the same catch and written
      // down as a send failure -- describing mail that had already left the
      // tenant as undelivered, which is the one thing a person must be able
      // to trust this log about.
      let res: any = null;
      let sendError: string | null = null;
      try {
        res = await ctx.runAction(internal.mail.send, {
          to: mail.to, subject: mail.subject, html: mail.html, live: true,
        });
      } catch (err: any) {
        sendError = String(err?.message ?? err).slice(0, 400);
      }

      if (sendError !== null) {
        // NOT RETRIED, and the row says why it cannot be. mail:send now
        // records each address's own outcome rather than throwing part-way
        // through, so reaching here means the send never started -- but the
        // delivered count is still written as unknown rather than zero, and
        // retryFailed refuses to re-arm a row whose count is unknown.
        await ctx.runMutation(internal.referralPing.finish, {
          referralId: d.referralId, stage: d.stage, state: "failed",
          recipients: mail.to.length, error: sendError,
        });
        results.push({ referralId: d.referralId, stage: d.stage, state: "failed", error: sendError.slice(0, 200) });
        continue;
      }

      {
        const delivered = Number(res?.sent ?? 0);
        const refused: string[] = Array.isArray(res?.refused) ? res.refused : [];

        // A SEND THAT DELIVERED TO NOBODY IS NOT A SEND.
        //
        // mail:send does not throw when it delivers nothing. Two live paths
        // reach zero without an exception: the STAFF_DOMAIN filter emptying
        // the allowed list (it returns { sent: 0 } and never calls Graph at
        // all), and Graph answering 403 to every address, which is what a
        // tenant-wide application access policy that omits this sender looks
        // like. Recording either as "sent" would put four referrals in a log
        // that reads byState: { sent: 4 } while nobody had been told anything
        // -- and because the slot is claimed, they would never be chased
        // again. A silent permanent stop is the worst failure this feature
        // has, so it is made loud here.
        if (delivered === 0) {
          await ctx.runMutation(internal.referralPing.finish, {
            referralId: d.referralId, stage: d.stage, state: "failed",
            sent: 0, recipients: mail.to.length, refused,
            error: `delivered to nobody: ${refused.length} of ${mail.to.length} refused` +
              (refused.length ? ` (${refused.slice(0, 3).join(", ")})` : ""),
          });
          results.push({
            referralId: d.referralId, stage: d.stage, state: "failed",
            delivered: 0, recipients: mail.to.length, refused,
          });
          continue;
        }

        await ctx.runMutation(internal.referralPing.finish, {
          referralId: d.referralId, stage: d.stage, state: "sent",
          sent: delivered, recipients: mail.to.length, refused,
          // A PARTIAL DELIVERY IS STILL A DELIVERY, so it stays "sent" and is
          // never retried -- some of these people already have it, and a
          // retry is how they get a child's referral twice. The count is on
          // the row so referralPing:history can surface the shortfall.
          error: delivered < mail.to.length
            ? `partial: ${delivered} of ${mail.to.length} delivered`
            : undefined,
        });
        results.push({
          referralId: d.referralId, stage: d.stage, state: "sent",
          delivered, recipients: mail.to.length,
          ...(refused.length ? { refused } : {}),
        });
      }
    }

    return { ...summarise(plan), dryRun: Boolean(dryRun), sent: sends, results };
  },
});

function summarise(plan: any) {
  return {
    today: plan.today, enabled: plan.enabled, settings: plan.settings,
    // THE CALENDAR'S HEALTH IS PART OF THE ANSWER, not a detail. Every wrong
    // age this thing can compute comes from the school-day list, so a dry run
    // that does not show how current it is cannot be used to check the sweep.
    schoolDaysKnown: plan.schoolDaysKnown,
    newestSchoolDay: plan.newestSchoolDay ?? null,
    calendarWrittenAt: plan.newestSync ?? null,
    calendarWrittenDaysAgo: plan.syncAgeDays ?? null,
    calendarDateLagDays: plan.dateLagDays ?? null,
    calendarStale: plan.calendarStale ?? null,
    referrals: plan.referrals,
    due: plan.due.length, agedOut: plan.agedOut, skippedWhy: plan.skippedWhy,
  };
}

/**
 * Let a FAILED stage be attempted again. CLI only, and a human decides.
 *
 *   npx convex run referralPing:retryFailed '{}'
 *   npx convex run referralPing:retryFailed '{"referralId":"REF-260914-ZTX9D4W"}'
 *
 * WHY THIS IS MANUAL. referralMail:deliver refuses to retry for a reason
 * worth repeating: mail:send sets saveToSentItems, so a send that reached
 * Graph is already visible in the Westbrook mailbox, and a blind automatic
 * retry is how six school leaders get the same child's referral twice. But a
 * stage that delivered to NOBODY -- the domain gate emptying the list, or a
 * tenant policy answering 403 to every address -- must not be stuck forever
 * either. So the retry exists, and a person runs it after fixing the cause.
 *
 * IT ONLY EVER TOUCHES "failed" ROWS. A "sent" row is somebody's inbox and is
 * never reopened; a "skipped" row is a decision, not an error.
 */
export const retryFailed = internalMutation({
  args: { referralId: v.optional(v.string()) },
  handler: async (ctx, { referralId }) => {
    const rows = referralId
      ? await ctx.db.query("referralPingLog")
          .withIndex("by_referral", (q) => q.eq("referralId", referralId)).take(50)
      : await ctx.db.query("referralPingLog").take(2000);
    const now = Date.now();
    const cleared: Array<{ referralId: string; stage: string; why: string; error?: string }> = [];
    const kept: Array<{ referralId: string; stage: string; why: string }> = [];

    for (const r of rows) {
      // A ROW IS ONLY RE-ARMED IF IT PROVABLY REACHED NOBODY.
      //
      // "failed" means two different things. The delivered-to-nobody path
      // writes sent: 0 explicitly. A send that could not even be attempted
      // writes no count at all -- and an unknown count is not zero. Clearing
      // the second kind would re-send a stage that may already be sitting in
      // some of those inboxes, which is precisely the duplicate this whole
      // design refuses elsewhere. Unknown stays put and stays visible.
      if (r.state === "failed") {
        if (Number(r.sent ?? -1) === 0) {
          cleared.push({ referralId: r.referralId, stage: r.stage, why: "delivered to nobody", error: r.error });
          await ctx.db.delete(r._id);
        } else {
          kept.push({
            referralId: r.referralId, stage: r.stage,
            why: "the send never reported a delivered count, so it may have reached some of them",
          });
        }
        continue;
      }

      // A "queued" ROW THAT NEVER FINISHED. claim() writes it before the send
      // so two runs cannot race; a crash in between leaves it with no
      // finishedAt and nothing else could ever clear it, which made the
      // recovery schema.ts promises impossible. Hours, not minutes: a sweep
      // takes seconds, so nothing in flight is anywhere near this old.
      if (r.state === "queued" && !r.finishedAt) {
        const at = Date.parse(String(r.at ?? ""));
        if (Number.isFinite(at) && now - at > STUCK_QUEUED_MS) {
          cleared.push({ referralId: r.referralId, stage: r.stage, why: "queued and never finished" });
          await ctx.db.delete(r._id);
        }
      }
      // "sent" is somebody's inbox and "skipped" is a decision. Neither moves.
    }

    return {
      cleared: cleared.length,
      rows: cleared,
      keptBecauseDeliveryUnknown: kept,
      note: cleared.length
        ? "the next sweep will re-decide these; run referralPing:sweep '{\"dryRun\":true}' first"
        : "nothing was safe to re-arm",
    };
  },
});

/** What has been chased, and what is stuck. Counts and states; no student. */
export const history = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("referralPingLog").take(2000);
    const byStage: Record<string, number> = {};
    const byState: Record<string, number> = {};
    for (const r of rows) {
      byStage[r.stage] = (byStage[r.stage] ?? 0) + 1;
      byState[r.state] = (byState[r.state] ?? 0) + 1;
    }
    return {
      total: rows.length, byStage, byState,
      stuck: rows.filter((r) => r.state === "queued")
        .map((r) => ({ referralId: r.referralId, stage: r.stage, at: r.at })),
      failed: rows.filter((r) => r.state === "failed")
        .map((r) => ({
          referralId: r.referralId, stage: r.stage, at: r.at, error: r.error,
          // Zero means provably nobody, and retryFailed will re-arm it. null
          // means the send never reported, and it will not.
          delivered: r.sent ?? null,
          retryable: Number(r.sent ?? -1) === 0,
        })),
      // A "sent" row that reached fewer inboxes than it addressed. Not an
      // error -- it is not retried and must not be -- but not silence either.
      partial: rows.filter((r) => r.state === "sent" &&
        Number(r.sent ?? 0) < Number(r.recipients ?? 0))
        .map((r) => ({ referralId: r.referralId, stage: r.stage,
          delivered: r.sent ?? 0, addressed: r.recipients ?? 0, refused: r.refused ?? [] })),
      skipped: rows.filter((r) => r.state === "skipped")
        .map((r) => ({ referralId: r.referralId, stage: r.stage, reason: r.reason })),
    };
  },
});
