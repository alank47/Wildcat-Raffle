"use node";
import { internalAction } from "./_generated/server";

/**
 * Which domains actually exist in the Microsoft tenant, and how many of each.
 *
 * READ ONLY. Counts and nothing else: no addresses, no names, no writes. It
 * exists to answer one question that cannot be answered from the app's data --
 * do STUDENT accounts exist in Entra at all?
 *
 * WHY THAT MATTERS. Student Google accounts are on westbrookacademy.org, and
 * the rendered Google button starts a fresh sign-in that Google hands to
 * Microsoft's SAML endpoint. Microsoft answered "we couldn't find an account
 * with that username", which has two very different explanations:
 *
 *   - the students are not in Entra, so that path can never work for anybody
 *     and the only way a student can sign in is the One Tap route, from a
 *     Google session they are already in; or
 *   - they are in Entra and something else is wrong with the one address that
 *     was tried.
 *
 * entraDirectory cannot answer it: mirrorDirectory filters to STAFF_DOMAIN by
 * design, so the absence of students there is a property of the filter, not of
 * the tenant. I nearly concluded otherwise from that table.
 *
 *   npx convex run --prod entraProbe:domains '{}'
 */
const GRAPH = "https://graph.microsoft.com/v1.0";

async function graphToken(): Promise<string> {
  const tenant = (process.env.ENTRA_TENANT_ID ?? "").trim();
  const clientId = (process.env.ENTRA_GRAPH_CLIENT_ID ?? "").trim();
  const secret = (process.env.ENTRA_GRAPH_CLIENT_SECRET ?? "").trim();
  if (!tenant || !clientId || !secret) {
    throw new Error("Graph credentials are not configured.");
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: secret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`);
  const json: any = await res.json();
  return json.access_token;
}

export const domains = internalAction({
  args: {},
  handler: async () => {
    const token = await graphToken();
    const select = "mail,userPrincipalName,accountEnabled,userType";
    let url: string | null = `${GRAPH}/users?$select=${select}&$top=999`;

    const byDomain: Record<string, { total: number; enabled: number; guests: number }> = {};
    let total = 0, pages = 0;

    while (url && pages < 50) {
      const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Graph /users failed: HTTP ${res.status}`);
      const body: any = await res.json();
      for (const u of body.value ?? []) {
        total++;
        // userPrincipalName as well as mail: a student account may well have no
        // mailbox, and counting only `mail` would report zero for a domain that
        // is fully present.
        const addr = String(u.mail ?? u.userPrincipalName ?? "").trim().toLowerCase();
        const at = addr.lastIndexOf("@");
        const dom = at >= 0 ? addr.slice(at + 1) : "(no address)";
        const row = (byDomain[dom] ??= { total: 0, enabled: 0, guests: 0 });
        row.total++;
        if (u.accountEnabled !== false) row.enabled++;
        if (String(u.userType) === "Guest") row.guests++;
      }
      url = body["@odata.nextLink"] ?? null;
      pages++;
    }

    return {
      tenantUsers: total,
      pages,
      domains: Object.entries(byDomain)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([domain, c]) => ({ domain, ...c })),
    };
  },
});
