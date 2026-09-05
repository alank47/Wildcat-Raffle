import { action, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { requireAdmin } from "./identity";

/**
 * "Sync now", for an admin who has just changed something in PowerSchool.
 *
 * WHY IT EXISTS. The scheduled syncs run at 13:00 and 19:00 UTC. A teacher who
 * ticks Missing on an assignment waits up to six hours to see it, which is fine
 * for the weekly rhythm and useless for "I just flagged it, show me". On
 * 2026-09-05 the owner flagged two assignments, saw nothing, and reasonably
 * concluded the feature was broken; it was not, the sync simply had not run.
 *
 * WHAT IT IS NOT. Not a different sync. It runs the SAME internal action the
 * cron runs, so there is one code path and no second thing to keep correct.
 *
 * THREE GUARDS, because this reaches out to the school's live SIS:
 *
 *  1. requireAdmin. A sync is a whole-school operation.
 *  2. A cooldown. The sync takes about a minute and pulls the full roster,
 *     grades, attendance and gradebook. Two people pressing the button in the
 *     same minute must not become two concurrent pulls.
 *  3. It reports the result rather than firing and forgetting, so the person
 *     who pressed it learns whether it worked.
 */

/** No second sync inside this window. Roughly twice the observed duration. */
const COOLDOWN_MS = 2 * 60 * 1000;

/** Where the last manual run is recorded, so the cooldown survives a reload. */
const STATE_KEY = "sis:lastManualSync";

export const status = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const row = await ctx.db
      .query("appState")
      .withIndex("by_key", (q) => q.eq("key", STATE_KEY))
      .first();
    const last = (row?.value as any) ?? null;
    const readyIn = last?.at
      ? Math.max(0, COOLDOWN_MS - (Date.now() - new Date(last.at).getTime()))
      : 0;
    return { last, readyInMs: readyIn, cooldownMs: COOLDOWN_MS };
  },
});

/** Claim the cooldown slot. Separate from the action, which cannot write. */
export const claim = mutation({
  args: {},
  handler: async (ctx) => {
    const admin = await requireAdmin(ctx);
    const row = await ctx.db
      .query("appState")
      .withIndex("by_key", (q) => q.eq("key", STATE_KEY))
      .first();
    const last = (row?.value as any) ?? null;

    if (last?.at) {
      const since = Date.now() - new Date(last.at).getTime();
      if (since < COOLDOWN_MS) {
        return {
          ok: false,
          readyInMs: COOLDOWN_MS - since,
          reason: `A sync ran ${Math.round(since / 1000)}s ago. ` +
                  "Give it a moment before running another.",
        };
      }
    }

    const value = { at: new Date().toISOString(), by: admin.email, state: "running" };
    const mirroredAt = new Date().toISOString();
    if (row) await ctx.db.patch(row._id, { value, mirroredAt });
    else await ctx.db.insert("appState", { key: STATE_KEY, value, mirroredAt });
    return { ok: true, readyInMs: 0, by: admin.email };
  },
});

/** Record how it went, so `status` can show it and the next caller can see it. */
export const finish = mutation({
  args: { ok: v.boolean(), summary: v.optional(v.any()), error: v.optional(v.string()) },
  handler: async (ctx, { ok, summary, error }) => {
    const admin = await requireAdmin(ctx);
    const row = await ctx.db
      .query("appState")
      .withIndex("by_key", (q) => q.eq("key", STATE_KEY))
      .first();
    const value = {
      at: new Date().toISOString(),
      by: admin.email,
      state: ok ? "ok" : "failed",
      summary: summary ?? null,
      error: error ?? null,
    };
    const mirroredAt = new Date().toISOString();
    if (row) await ctx.db.patch(row._id, { value, mirroredAt });
    else await ctx.db.insert("appState", { key: STATE_KEY, value, mirroredAt });
    return value;
  },
});

/**
 * Run the sync the cron runs, now.
 *
 * The cooldown is claimed in a MUTATION first, because an action cannot write
 * and two callers racing an action would both proceed. The claim is the lock.
 */
export const runNow = action({
  args: {},
  handler: async (ctx): Promise<any> => {
    const claimed: any = await ctx.runMutation(api.sisManual.claim, {});
    if (!claimed.ok) return { started: false, ...claimed };

    try {
      const summary: any = await ctx.runAction(
        internal.sisAction.syncFromPowerSchool,
        { reason: `manual: ${claimed.by}` },
      );
      await ctx.runMutation(api.sisManual.finish, { ok: true, summary });
      return { started: true, ok: true, summary };
    } catch (err: any) {
      const message = String(err?.message ?? err);
      await ctx.runMutation(api.sisManual.finish, { ok: false, error: message });
      return { started: true, ok: false, error: message };
    }
  },
});
