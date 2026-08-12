# Connecting Google Sign-In (GIS) for students on westbrookacademy.org

Step by step. Students already have Google accounts on their Chromebooks, so this
adds no accounts and no passwords. It lets them press one button and have the app
know, provably, which student they are.

Read the security note at the bottom before you wire the button. One detail there
is the difference between this being real authentication and being decoration.

---

## Part 1 · Google Cloud Console (about 10 minutes)

You need to be signed in as a **Google Workspace admin for westbrookacademy.org**,
not a personal Google account. If you are in the wrong account the consent screen
will not offer the Internal option in step 3, which is the tell.

### 1. Create or pick the project

1. Go to <https://console.cloud.google.com/>.
2. Top left project dropdown → **New Project**.
3. Name: `Wildcat Hub`. Under **Location**, pick the `westbrookacademy.org`
   organization, not "No organization". This is what makes step 3 possible.
4. **Create**, then make sure the project is selected in the dropdown.

### 2. Enable the API

The sign-in button itself needs no API enabled. If you later read anything else
from Google, enable it here under **APIs & Services → Library**. For sign-in only,
skip ahead.

### 3. Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. User Type: **Internal**. Take this seriously. Internal means only
   `westbrookacademy.org` accounts can ever complete this flow, enforced by
   Google. External would let any Google account on earth reach the button.
3. **Create**, then fill in:
   - App name: `Wildcat Hub` (students see this on the consent prompt)
   - User support email: your admin address
   - App logo: optional
   - Developer contact: your admin address
4. **Save and Continue**.
5. Scopes: add nothing. Sign-in returns identity with no scopes, and every scope
   you add is data you then have to justify holding. **Save and Continue**.
6. **Back to Dashboard**.

### 4. Create the OAuth client ID

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Name: `Wildcat Hub Web`.
4. **Authorized JavaScript origins** — add each of these exactly, scheme included,
   no trailing slash:
   - `https://wildcatraffle.com`
   - `https://alank47.github.io` (the Pages origin, in case the site is reached
     there directly)
   - `http://localhost:8000` (only if you test locally)
5. **Authorized redirect URIs**: leave empty. The button uses the ID token flow,
   which does not redirect.
6. **Create**.

Google shows a **Client ID** ending in `.apps.googleusercontent.com`. Copy it.

**The Client ID is not a secret.** It ships in the page source and that is fine and
expected. The client *secret* on the same screen is a secret, and this flow does
not use it. Do not put the secret in the repo; the repo is public.

### 5. Send me the Client ID

Paste it in chat. It goes in exactly two places, both non-secret:
- `convex/auth.config.ts` as `applicationID`, so Convex accepts tokens minted for it
- `script.js` as the `client_id` the button initializes with

---

## Part 2 · Google Workspace Admin (only if sign-in is blocked)

Usually nothing is needed here. If students hit "access blocked" or an admin
approval wall, it is app access control:

1. <https://admin.google.com> → **Security → Access and data control → API controls**.
2. **Manage third-party app access**.
3. Find `Wildcat Hub` → set to **Trusted**.

Because the app is Internal and first-party to your own org, this is usually
already permitted. Check it only if a real student account is refused.

If students are in OUs, confirm the OU they are in is not blocking third-party
app sign-in. That is the usual cause when it works for staff and fails for kids.

---

## Part 3 · What the code does with it

Two pieces. Loading the library, and verifying what it returns.

### The button (browser, no build step)

```html
<script src="https://accounts.google.com/gsi/client" async defer></script>
```

```js
google.accounts.id.initialize({
  client_id: '<CLIENT_ID>.apps.googleusercontent.com',
  callback: handleStudentCredential,
  hd: 'westbrookacademy.org',   // hint only, see the security note
  auto_select: false,
});
google.accounts.id.renderButton(
  document.getElementById('googleSignInButton'),
  { theme: 'outline', size: 'large', text: 'signin_with' }
);
```

The callback receives a **JWT ID token**:

```js
async function handleStudentCredential(response) {
  const idToken = response.credential;      // signed by Google
  // Send to Convex. Convex verifies the signature and the claims itself.
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ path: 'students:getMine', args: {}, format: 'json' }),
  });
}
```

### The verification (Convex, server side)

`convex/auth.config.ts` tells Convex to trust Google tokens minted for your client:

```ts
{ domain: "https://accounts.google.com", applicationID: "<CLIENT_ID>.apps.googleusercontent.com" }
```

`domain` must equal the token's `iss`. `applicationID` must equal its `aud`. Convex
then validates the signature against Google's public keys and hands the claims to
`ctx.auth.getUserIdentity()`, where the email is checked against the record.

---

## Security note. Read this one.

**`hd: 'westbrookacademy.org'` in the browser is a hint, not a control.** It changes
which account chooser Google shows. It does not stop anyone from calling your
endpoint with a token from a different domain, because the browser is not
trustworthy and anyone can open devtools.

The domain has to be checked **server side, on the claims, every time**. That check
lives in the Convex function, and it is why this design puts authorization there
rather than in the page:

```ts
const identity = await ctx.auth.getUserIdentity();
const email = (identity?.email ?? '').trim().toLowerCase();
const domain = email.slice(email.lastIndexOf('@') + 1);
if (identity.issuer !== 'https://accounts.google.com') throw new Error('wrong provider');
if (domain !== 'westbrookacademy.org') throw new Error('wrong domain');
```

Three details that are easy to get wrong:

1. **Exact equality on the domain, never `endsWith`.** `endsWith` accepts
   `a@b.westbrookacademy.org.evil.com`.
2. **Check provider and domain together.** A Google token carrying a staff address
   must not be accepted as staff, or a student with a forwarding address becomes a
   teacher who can award tickets.
3. **Lowercase both sides of every comparison.** Directory casing differs from
   stored casing, and an exact compare then fails silently and bounces the user
   with no error message.

---

## Still blocked after this works

Google will return `student@westbrookacademy.org`. **There is currently nothing to
match it to.** App student records have no email field, and the PowerSchool manifest
had staff email only. Manifest field 19 (Student Email) is written and pushed but
**needs PowerSchool admin re-approval** before it delivers anything.

So this setup can be completed now and student sign-in still cannot go live until
field 19 lands. Also confirm the address Google issues is the same string
PowerSchool stores, or field 19 is the wrong key and the join needs a mapping.
