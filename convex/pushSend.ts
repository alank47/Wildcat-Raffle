"use node";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import webpush from "web-push";

/**
 * Send a Web Push to every device a teacher has enabled. Runs in the Node
 * runtime (web-push signs a VAPID JWT and encrypts the payload with Node
 * crypto). Scheduled from hallPasses.requestMine, never awaited inline, so a
 * slow or failing push service can never make a student's request fail or hang.
 *
 * VAPID keys come from Convex env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and
 * VAPID_SUBJECT (a mailto: the push services can reach). The private key lives
 * ONLY here in the deployment env, never in the repo.
 */
export const sendToTeacher = internalAction({
  args: {
    teacherEmail: v.string(),
    title: v.string(),
    body: v.string(),
    url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const pub = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT || "mailto:notify@westbrookacademy.org";
    if (!pub || !priv) {
      console.error("[push] VAPID keys not set; skipping send.");
      return { sent: 0, error: "no-vapid" };
    }
    webpush.setVapidDetails(subject, pub, priv);

    const subs = await ctx.runQuery(internal.push.listForTeacher, {
      teacherEmail: args.teacherEmail,
    });
    if (!subs.length) return { sent: 0, none: true };

    const payload = JSON.stringify({
      title: args.title,
      body: args.body,
      url: args.url || "/?source=push",
      tag: "hall-pass",
    });

    let sent = 0;
    const dead: string[] = [];
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
        sent++;
      } catch (e: any) {
        const code = e && e.statusCode;
        // 404/410 mean the subscription is gone — prune it so it is not retried.
        if (code === 404 || code === 410) dead.push(s.endpoint);
        else console.error("[push] send failed:", code, e && e.body);
      }
    }
    if (dead.length) {
      await ctx.runMutation(internal.push.removeEndpoints, { endpoints: dead });
    }
    return { sent, dead: dead.length };
  },
});
