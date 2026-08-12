# Auth and data architecture: Convex + Entra ID (staff) + Google (students)

Status: design. Decided 2026-08-11, revised the same day from Firebase to Convex.

Supersedes the `Grilled.md` line about Google sign in keyed on `@lapromisefund.org`,
and supersedes the Supabase warehouse line for the app tier. Staff sign in with
**Microsoft Entra ID (O365)**. Students sign in with **Google**, which they already
use daily on their Chromebooks. **Email is the identity key on both sides** and is
what links a signed in person to their record.

## Why Convex, and why Firebase goes away entirely

Firebase was doing two jobs: Firestore was the database, and Firebase Auth was the
thing that verified an identity. Convex does both, so neither Firebase piece stays.

The reason this matters is not preference. It is where authorization runs.

| | Firestore | Convex |
|---|---|---|
| Who talks to the data | The browser, directly | Nothing. The browser calls functions |
| Where rules live | A rules DSL evaluated per request | Plain TypeScript in the function |
| If the client is hostile | It has the DB endpoint and the public config | It has a function endpoint that refuses |

On a public static site the browser is not trustworthy. With Firestore, the client
holds a direct line to the database and security rules are the only thing between a
stranger and every record. That is exactly the hole this app has today. With Convex
there is no direct table access to abuse: a caller can only invoke a named function,
and that function decides what it is willing to return.

That also fixes something a single Firestore collection cannot express. Students must
read their own totals and write nothing. As a rules expression over one `raffle_data`
collection that is not writable. As a function it is four lines.

## No build step required

The app is one static `script.js` served from GitHub Pages with no bundler, and that
does not have to change. Convex exposes a plain HTTP API:

```js
const res = await fetch(`${CONVEX_URL}/api/query`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
  body: JSON.stringify({ path: 'students:getMine', args: {}, format: 'json' })
});
```

**Trade-off, stated plainly:** the HTTP path is stateless. No WebSocket subscriptions,
no live queries, no optimistic updates. That costs nothing today because the app
already polls on a timer (`AUTO_REFRESH_DELAY`, `isSyncing`) rather than subscribing.
The day real-time is wanted, the reactive client needs a bundler, and that is a
deployment-model change to decide on its own merits, not a side effect of this one.

## Auth wiring

Convex accepts **multiple custom OIDC providers** and uses the first that validates
the token, which is what makes the two-provider model clean:

```ts
// convex/auth.config.ts
export default {
  providers: [
    { domain: "https://login.microsoftonline.com/<TENANT_ID>/v2.0", applicationID: "<ENTRA_APP_ID>" },
    { domain: "https://accounts.google.com",                        applicationID: "<GOOGLE_CLIENT_ID>" },
  ],
};
```

`domain` must equal the JWT `iss`, `applicationID` must equal the JWT `aud`.

Token acquisition happens in the browser, both loadable from a CDN as ES modules with
no bundler: **MSAL.js** for Entra, **Google Identity Services** for Google.

### Role is provider plus domain, decided on the server

The classifier already written and tested in `script.js` moves server side, because a
client-side check is advice and a server-side check is a rule. The logic is unchanged
and portable, which is why it was written as pure functions:

```ts
const identity = await ctx.auth.getUserIdentity();
if (!identity?.email) throw new Error("Not authenticated");

const email  = identity.email.trim().toLowerCase();
const domain = email.slice(email.lastIndexOf("@") + 1);
const issuer = identity.issuer;

// Note the EXACT issuer match, including the tenant id.
const isStaff   = issuer === `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`
                  && domain === "lapromisefund.org";
const isStudent = issuer === "https://accounts.google.com"
                  && domain === "westbrookacademy.org";
if (!isStaff && !isStudent) throw new Error("Unrecognized identity");
```

Three rules, each of which was a real bug in an earlier draft of this file:

1. **Provider and domain are checked together.** Either alone is a privilege
   escalation: a Google account on the staff domain would otherwise award tickets.
2. **Domain comparison is exact equality, never `endsWith`**, which accepts
   `a@b.westbrookacademy.org.evil.com`.
3. **The Entra issuer is matched exactly, including the tenant id, never by prefix.**
   This one is the least obvious and the most dangerous. Anyone can create their own
   Microsoft tenant and mint `attacker@lapromisefund.org` inside it. A prefix match on
   `https://login.microsoftonline.com/` accepts that token as staff. The tenant id is
   the only thing in the issuer that identifies *this* organization.

Google's issuer, by contrast, is shared by every Google account in existence, so for
students the issuer proves nothing on its own and the domain check carries all the
weight. That asymmetry is why the two branches are not symmetrical.

21 cases pass in `convex/identityRules.test.mjs`, including cross-tenant, both
escalation directions, suffix spoofing, and malformed or missing claims. The tests
import the real module rather than a copy, because a copy can drift and still pass.

### Email normalization on both sides of every compare

Entra issues the email claim with directory casing, frequently `First.Last@domain`,
while records hold `first.last@domain`. An exact compare then fails and the user is
bounced with no error. This exact bug already cost real debugging time on this
organization's Overwatch console. Normalize at write time and at read time, and store
the normalized value so the index can be used.

## Still blocked: students have no email to join to

Google will return `student@westbrookacademy.org`. Nothing on the record side matches
it yet:

1. App student records have no `email` field.
2. The PowerSchool manifest had Staff Email (field 17) and no student email.

**Manifest field 19, Student Email** is added and pushed, but it amends the plugin
access request and needs PowerSchool admin re-approval before it delivers anything.
The Chromebook detail confirms the Google accounts exist; it does not confirm
PowerSchool stores the same address. Those must be verified to be equal, or field 19
is the wrong key.

Until then: ship staff Entra auth, which is unblocked, and leave student sign in off.
The current name-matching student path is removed either way, because typing a name
is not a login.

## Migration shape

47 `firebaseDb` call sites, 51 Firestore operations, 11 documents in one
`raffle_data` collection. Bounded. The 11 documents map to Convex tables rather than
one blob, which is a correctness gain on its own: `main`, `tombstones`, `secondary`,
`schedules`, `referrals`, `audit_log`, and the five `ticket_history*` splits.

Order that keeps a system in daily use working:

1. Stand up the Convex deployment and schema. Nothing in the live app changes.
2. Entra app registration, Google OAuth client, `auth.config.ts`.
3. Port reads behind a flag, dual-read against Firestore, compare.
4. Port writes. Firestore becomes the mirror, then read-only, then off.
5. Delete the `password` field from every staff record once sign in no longer reads it.

## Cleartext passwords

This change removes the reason the `password` field exists. It does not delete the
data. Until the field is gone it is a live exposure. Tracked in the local
`docs/firestore-lockdown.md`, which is deliberately not in this public repo.

## Compliance note, not legal advice

K-12 student records with authentication is FERPA territory, and the roster carries
restricted fields (IEP, 504, English Learner, federal race and ethnicity) already
isolated in their own PowerQueries. Convex helps here: per-function authorization can
keep restricted fields out of any student-facing response, which one shared collection
could not. Entra and Google are both already school controlled, so no new vendor
enters the protected data path. Convex itself does become a processor, which is a
vendor review, not a blocker.

## Open questions

1. **Did alank47 already build a Convex schema?** Reported as pushed, but it is not in
   `alank47/Wildcat-Raffle` (no Convex files, no branches, no forks, no open PRs).
   Find it before writing a competing schema.
2. **RESOLVED: staff domain is `lapromisefund.org`.** Students are on
   `westbrookacademy.org`. Two distinct domains with no overlap, so neither side can
   be mistaken for the other. Lives in `STAFF_DOMAIN` on the deployment, not in code,
   so a wrong value is a config change rather than a commit. PowerSchool
   `teacher_email` values must be on this domain for the join to work, which is
   question 3.
3. **Do Entra UPNs equal PowerSchool `users.email_addr`?** If they diverge the join
   needs an alias map, which is a schema change.
4. **Do students' Google addresses equal what PowerSchool stores?** Field 19 is the
   wrong key if not.
5. **Is the Entra tenant already consented for this app?** The Overwatch staff console
   for this org is currently blocked on admin consent; the same tenant likely gates
   this.
