import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Mirror the Entra directory on a schedule, so inviting staff does not depend on
 * a laptop being awake with `az` logged in.
 *
 * This replaces scripts/mirror-entra-directory.mjs, which was the right tool
 * while no client secret existed. The app registration "Wildcat Hub Directory
 * Sync" is a CONFIDENTIAL client, separate from the SPA that users sign in
 * with, because mixing a public client with a secret is how secrets end up in a
 * browser bundle.
 *
 * It holds exactly one Graph permission, User.Read.All (application), which is
 * read only and the narrowest thing that can list users. It cannot write to the
 * directory, cannot read mail, and cannot act as a user.
 *
 * WHAT IS MIRRORED, and what is filtered out BEFORE it is stored:
 *   staff domain only, enabled accounts only, no Guests.
 * The tenant holds 543 users and only about 290 survive that. Filtering here
 * rather than at read time means a departed colleague stops being invitable
 * when the mirror refreshes, rather than depending on every caller to remember.
 *
 * Name, email, job title and department. Nothing else: this is a copy of
 * colleagues' personal data and every extra column is a copy somebody has to
 * justify.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set on this Convex deployment.`);
  return value;
}

/** Client credentials. The secret never leaves this function. */
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
  if (!res.ok) {
    // Deliberately does NOT include the response body: an auth error response
    // can echo request parameters back, and one of those is the secret.
    throw new Error(`Entra token request failed: HTTP ${res.status}`);
  }
  return (await res.json()).access_token;
}

/**
 * Explicit, because TypeScript otherwise infers this handler's type through
 * ctx.runMutation and back into itself, and reports the whole thing as
 * implicitly any. Annotating the boundary breaks the cycle.
 */
type MirrorResult = {
  reason: string;
  tenantUsers: number;
  pages: number;
  mirrored: number;
  removed: number;
  written: number;
  durationMs: number;
};

export const mirrorDirectory = internalAction({
  args: { reason: v.optional(v.string()) },
  handler: async (ctx, { reason }): Promise<MirrorResult> => {
    const started = Date.now();
    const staffDomain = (process.env.STAFF_DOMAIN ?? "").trim().toLowerCase();
    if (!staffDomain) throw new Error("STAFF_DOMAIN is not configured.");

    const token = await graphToken();

    // Graph pages at 999 and hands back an @odata.nextLink. Following it
    // matters: a tenant that grows past one page would otherwise silently
    // mirror only the first slice, and the symptom is "some colleagues cannot
    // be found in search" rather than an error.
    const select = "mail,userPrincipalName,displayName,accountEnabled,userType,jobTitle,department";
    let url: string | null = `${GRAPH}/users?$select=${select}&$top=999`;
    const raw: any[] = [];
    let pages = 0;

    while (url && pages < 50) {
      const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Graph /users failed: HTTP ${res.status}`);
      const body: any = await res.json();
      raw.push(...(body.value ?? []));
      url = body["@odata.nextLink"] ?? null;
      pages++;
    }

    const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

    const people = raw
      .map((u) => ({
        // mail, NOT userPrincipalName. They differ for 147 of 543 users here,
        // and mail is what a token carries and what teachers rows are keyed by.
        email: norm(u.mail),
        name: String(u.displayName ?? ""),
        jobTitle: u.jobTitle || undefined,
        department: u.department || undefined,
        enabled: u.accountEnabled !== false,
        guest: String(u.userType) === "Guest",
      }))
      .filter((u) => u.email.endsWith(`@${staffDomain}`) && u.enabled && !u.guest)
      .map(({ email, name, jobTitle, department }) => ({ email, name, jobTitle, department }));

    const result: { removed: number; written: number; mirroredAt: string } =
      await ctx.runMutation(internal.staffInvites.replaceDirectory, { people });

    return {
      reason: reason ?? "scheduled",
      tenantUsers: raw.length,
      pages,
      mirrored: people.length,
      removed: result.removed,
      written: result.written,
      durationMs: Date.now() - started,
    };
  },
});
