import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { pingsDue, pingRecipients, pingMailPlan, pingSettingsOrDefault, SCHOOL_DAY_SOURCE } from "./referralPingRules";

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
    const day = String(today || new Date().toISOString().slice(0, 10)).slice(0, 10);

    const dayRows = await ctx.db.query("psAbsenceDayTotals").withIndex("by_date").take(400);
    const schoolDays = dayRows.map((d) => String(d.date).slice(0, 10)).filter((d) => d.length === 10).sort();

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
    for (const r of referrals) if (r?.id) byId.set(String(r.id), r);

    const plans = res.due
      .filter((d) => d.ageSchoolDays <= MAX_AGE_SCHOOL_DAYS)
      .map((d) => ({ ...d, to: pingRecipients(d.stage), referral: byId.get(d.referralId) ?? null }));

    return {
      today: day,
      enabled: settings.enabled,
      settings,
      schoolDaysKnown: schoolDays.length,
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

/** The address for a display name, via the staff table. Loop stage only. */
export const emailForName = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const want = String(name || "").trim().toLowerCase();
    if (!want) return null;
    const staff = await ctx.db.query("teachers").take(300);
    const hit = staff.find((t) => String(t.name || "").trim().toLowerCase() === want);
    return hit?.email ? String(hit.email) : null;
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
    if (!plan.schoolDaysKnown) {
      return { ...summarise(plan), sent: 0, note: "no school-day list; nothing sent" };
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
        // The reminder goes to whoever closed it, and the record stores a
        // display name rather than an address, so it has to be looked up.
        const email: string | null = d.closedBy
          ? await ctx.runQuery(internal.referralPing.emailForName, { name: d.closedBy })
          : null;
        if (email) to = [email];
        else skipReason = d.closedBy
          ? `no staff account matches the name that closed it (${String(d.closedBy).slice(0, 80)})`
          : "the record does not say who closed it";
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
      try {
        const res: any = await ctx.runAction(internal.mail.send, {
          to: mail.to, subject: mail.subject, html: mail.html, live: true,
        });
        await ctx.runMutation(internal.referralPing.finish, {
          referralId: d.referralId, stage: d.stage, state: "sent",
          sent: res?.sent ?? 0, recipients: mail.to.length, refused: res?.refused ?? [],
        });
        results.push({ referralId: d.referralId, stage: d.stage, state: "sent", recipients: mail.to.length });
      } catch (err: any) {
        await ctx.runMutation(internal.referralPing.finish, {
          referralId: d.referralId, stage: d.stage, state: "failed",
          recipients: mail.to.length, error: String(err?.message ?? err).slice(0, 400),
        });
        results.push({ referralId: d.referralId, stage: d.stage, state: "failed", error: String(err?.message ?? err).slice(0, 200) });
      }
    }

    return { ...summarise(plan), dryRun: Boolean(dryRun), sent: sends, results };
  },
});

function summarise(plan: any) {
  return {
    today: plan.today, enabled: plan.enabled, settings: plan.settings,
    schoolDaysKnown: plan.schoolDaysKnown, referrals: plan.referrals,
    due: plan.due.length, agedOut: plan.agedOut, skippedWhy: plan.skippedWhy,
  };
}

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
        .map((r) => ({ referralId: r.referralId, stage: r.stage, at: r.at, error: r.error })),
      skipped: rows.filter((r) => r.state === "skipped")
        .map((r) => ({ referralId: r.referralId, stage: r.stage, reason: r.reason })),
    };
  },
});
