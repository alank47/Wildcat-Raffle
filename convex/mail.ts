import { internalAction } from "./_generated/server";
import { v } from "convex/values";

/**
 * Send mail through Microsoft 365, from the school's own domain.
 *
 * Replaces EmailJS, which sends from the browser with a public key and cannot
 * send as the school. Weekly ticket summaries arriving from
 * westbrook@lapromisefund.org rather than a third party are the point.
 *
 * ⚠️ SECURITY: THE APPLICATION PERMISSION IS TENANT WIDE.
 *
 * Mail.Send as an application role lets this credential send as ANY mailbox in
 * the organization, including the superintendent's. That is how Graph works;
 * there is no narrower application role.
 *
 * The mitigation is an Exchange application access policy restricting the app
 * to ONE mailbox, and it is not optional. It cannot be applied with `az`, only
 * Exchange Online PowerShell:
 *
 *   Connect-ExchangeOnline
 *   New-ApplicationAccessPolicy -AppId c4c1ce05-71cc-4f6e-a3e7-884a689559f4 `
 *     -PolicyScopeGroupId westbrook@lapromisefund.org `
 *     -AccessRight RestrictAccess `
 *     -Description "Wildcat Hub may send only as Westbrook Academy General"
 *
 * Until that runs, treat this credential as able to impersonate anyone in the
 * tenant and keep it where it is: Convex deployment env, never a file.
 *
 * SENDER is a constant, not an argument. A caller-supplied sender is the whole
 * impersonation surface handed to whoever can call the function.
 */

const SENDER = "westbrook@lapromisefund.org";
const GRAPH = "https://graph.microsoft.com/v1.0";

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set on this Convex deployment.`);
  return value;
}

async function graphToken(): Promise<string> {
  const tenant = need("ENTRA_GRAPH_TENANT_ID");
  const body = new URLSearchParams({
    client_id: need("ENTRA_GRAPH_CLIENT_ID"),
    client_secret: need("ENTRA_GRAPH_CLIENT_SECRET"),
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  // No response body in the error: an auth failure can echo request parameters
  // back, and one of them is the secret.
  if (!res.ok) throw new Error(`Entra token request failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

type SendResult = { sent: number; refused: string[]; sender: string };

export const send = internalAction({
  args: {
    to: v.array(v.string()),
    subject: v.string(),
    html: v.string(),
    /** Set only for a real send. Absent means render and validate, send nothing. */
    live: v.optional(v.boolean()),
  },
  handler: async (ctx, { to, subject, html, live }): Promise<SendResult> => {
    const staffDomain = (process.env.STAFF_DOMAIN ?? "").trim().toLowerCase();
    if (!staffDomain) throw new Error("STAFF_DOMAIN is not configured.");

    // Staff domain only, for now, and deliberately.
    //
    // The first thing this sends is weekly summaries to teachers. Mailing
    // students or families is a different decision with FERPA weight, and it
    // should be made on purpose rather than inherited from a helper that
    // happened to accept any address.
    const refused: string[] = [];
    const allowed = to
      .map((address) => address.trim().toLowerCase())
      .filter((address) => {
        const ok = address.includes("@") && address.endsWith(`@${staffDomain}`);
        if (!ok) refused.push(address);
        return ok;
      });

    if (!live) return { sent: 0, refused: [...refused, ...allowed], sender: SENDER };
    if (allowed.length === 0) return { sent: 0, refused, sender: SENDER };

    const token = await graphToken();
    let sent = 0;

    for (const address of allowed) {
      const res = await fetch(`${GRAPH}/users/${encodeURIComponent(SENDER)}/sendMail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: "HTML", content: html },
            toRecipients: [{ emailAddress: { address } }],
          },
          saveToSentItems: true,
        }),
      });
      if (res.status === 202) {
        sent++;
      } else {
        // 403 here almost always means the application access policy above is
        // in place and does NOT include this sender, which is the good failure.
        refused.push(`${address} (HTTP ${res.status})`);
      }
    }

    return { sent, refused, sender: SENDER };
  },
});
