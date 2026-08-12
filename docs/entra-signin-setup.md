# Connecting Microsoft Entra ID (O365) sign-in for staff

Companion to `docs/google-signin-setup.md`. Staff sign in with the O365 account
they already have on `lapromisefund.org`. No new accounts, no new passwords, and
this is what finally removes the cleartext passwords stored in the database.

You need to be a **Global Administrator or Application Administrator** on the
`lapromisefund.org` Entra tenant.

---

## Part 1 · Register the application

1. Go to <https://entra.microsoft.com> → **Applications → App registrations → New registration**.
2. **Name:** `Wildcat Hub`
3. **Supported account types:** **Accounts in this organizational directory only
   (Single tenant)**.

   Take this one seriously. Single tenant means Entra will only issue tokens for
   accounts in *your* directory. Multitenant would let any Microsoft work account
   in the world reach the sign-in, and the app would be relying entirely on its
   own domain check to tell them apart.

4. **Redirect URI:** platform **Single-page application (SPA)**, value:
   - `https://wildcatraffle.com`

   Add a second SPA entry for `https://alank47.github.io` if the site is ever
   reached at the Pages origin directly. SPA is the correct platform; picking
   "Web" instead makes Entra demand a client secret that a static site cannot
   keep, and the flow will fail with a confusing error about PKCE.

5. **Register.**

## Part 2 · Collect the two values I need

From the app's **Overview** page:

| Field on the page | What I need it for |
|---|---|
| **Application (client) ID** | `ENTRA_CLIENT_ID`, and the `aud` Convex checks |
| **Directory (tenant) ID** | `ENTRA_TENANT_ID`, which builds the issuer Convex checks |

Neither is a secret. Both appear in every token and in the page source.

**Do not create a client secret.** This flow does not use one. A secret in a
static site is a secret published to the internet, and the repo is public.

## Part 3 · Token configuration, the step that is easy to miss

By default the ID token may not carry an `email` claim, and email is the entire
join key for this system. If it is missing, every teacher signs in successfully
and is then told they have no staff record.

1. In the app registration → **Token configuration → Add optional claim**.
2. Token type: **ID**.
3. Check **email**. Also check **upn** as a fallback for diagnosing mismatches.
4. **Add**. If prompted to turn on the Microsoft Graph profile permission to
   surface these claims, accept.

## Part 4 · Permissions

Under **API permissions** you should need only `User.Read` (delegated), which is
added by default. Nothing else. Every permission beyond sign-in is data the
school then has to justify the app holding.

If your tenant requires admin consent for even the default permission, click
**Grant admin consent for lapromisefund.org**. Note this org has an existing
consent bottleneck: the Overwatch staff console is currently blocked on exactly
this step, so expect it to need an admin rather than assuming it is automatic.

---

## Part 5 · What the code does with it

```js
// MSAL from Microsoft's CDN, no bundler
const msal = new msal.PublicClientApplication({
  auth: {
    clientId: ENTRA_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${ENTRA_TENANT_ID}`,
    redirectUri: window.location.origin,
  },
});
const result = await msal.loginPopup({ scopes: ['openid', 'profile', 'email'] });
const idToken = result.idToken;   // this is what Convex verifies
```

The token then goes to Convex as a bearer token, and `convex/auth.config.ts`
validates it against:

```
domain:        https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0
applicationID: <ENTRA_CLIENT_ID>
```

`domain` must equal the token's `iss`; `applicationID` must equal its `aud`.

### Why the tenant id appears in the issuer, and why that matters

The issuer is **tenant specific**, and that is the only part of it that proves
the token came from *this* school. Convex compares it exactly.

An earlier version of this design matched the issuer by prefix
(`startsWith("https://login.microsoftonline.com/")`). Anyone can create their own
Microsoft tenant, create a user called `attacker@lapromisefund.org` inside it,
and get a genuinely Microsoft-signed token with that email claim. A prefix match
accepts it as staff. Exact issuer comparison is what stops it, and the case is
pinned in `convex/identityRules.test.mjs`.

Google's issuer is the opposite: `https://accounts.google.com` is shared by every
Google account on earth, so for students the issuer proves nothing and the domain
check carries all the weight. The two providers are not symmetrical and the code
should not pretend they are.

---

## What to send me

- Application (client) ID
- Directory (tenant) ID

Then set on the Convex deployment
(<https://dashboard.convex.dev/d/quick-cassowary-644/settings/environment-variables>):

| Variable | Value |
|---|---|
| `ENTRA_CLIENT_ID` | Application (client) ID |
| `ENTRA_TENANT_ID` | Directory (tenant) ID |
| `STAFF_DOMAIN` | `lapromisefund.org` |
| `GOOGLE_CLIENT_ID` | from the Google setup doc |

## The assumption to verify early

Staff match on email, so **the address Entra puts in the token must equal the
address PowerSchool holds in `users.email_addr`**. If the school migrated domains,
or if UPNs differ from mail addresses, every teacher will sign in and be told they
have no record. `npm run probe` in `powerschool/sync` reports the real values
without printing them, the moment sandbox credentials exist.
