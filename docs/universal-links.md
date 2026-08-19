# Universal Links and App Links

How a tag tap stops opening Safari and starts opening the app.

One placeholder value in this repo must still be replaced before Android works.
It is named below with the exact screen it comes from. Nothing here can be
guessed, and guessing produces a build that installs, runs, and silently never
opens on a tap.

---

## The one fact everything follows from

**A tag holds a URL. The OS hands that URL to an app only if the URL is a
Universal Link.** Apple, on background tag reading:

> "The URI record must contain either a universal link or a supported URL
> scheme."
> "Background tag reading doesn't support custom URL schemes. Use universal
> links instead."
> "**If there are no installed apps associated with the universal link, the
> system opens the link in Safari.**"

That last line is the current behaviour at Westbrook. Every tag already mounted
in the school holds `https://wildcatraffle.com/?tap=<slug>`, there is no
association file on the domain, so every tap lands in Safari. The app is not
being ignored, it has never been offered the URL.

**The tag URL has since changed shape.** Per `Grilled.md` decision 24, a tag now
holds `https://wildcatraffle.com/tap/?tap=<slug>`, not `/?tap=<slug>`. The
distinction moved into the path because Android intent filters cannot match on a
query string at all, and both platforms have to agree on one URL. Consequences
worth knowing before reading further: every tag already on a wall has to be
re-encoded, the app is the thing that re-encodes them, and the old tags keep
working as plain web links in the meantime. **Everywhere below, "the tag URL"
means the `/tap/` shape.**

**The association is claimed by a file on the website, not by anything in the
app.** The app declares which domain it wants; the domain declares which app it
trusts. Both halves must agree or the tap goes to the browser with no error
anywhere.

---

## What ships in this repo

| Path | Serves at | Purpose |
|---|---|---|
| `.well-known/apple-app-site-association` | `https://wildcatraffle.com/.well-known/apple-app-site-association` | iOS. **No file extension.** This is the only URL Apple ever requests |
| `apple-app-site-association` (repo root) | `https://wildcatraffle.com/apple-app-site-association` | Insurance only. Apple does not fetch this. Keep it byte identical to the one above |
| `.well-known/assetlinks.json` | `https://wildcatraffle.com/.well-known/assetlinks.json` | Android. **Keeps its `.json` extension** |
| `tap/index.html` | `https://wildcatraffle.com/tap/?tap=<slug>` | **Required, not decorative.** The page every phone *without* the app installed lands on. It forwards to `/?tap=<slug>`, where the portal's existing arrival handling takes over and shows a confirmation. Delete it and an un-installed phone gets a 404 from a tag |
| `_config.yml` `include: [".well-known"]` | n/a | Belt and braces if Jekyll ever runs on this site |

The root copy is insurance in the sense that it costs one file and covers a
documented misconception. It does not currently do anything: the Apple CDN
diagnostic below proves Apple attempts exactly one URL, the `.well-known` one.
If you edit one AASA, edit both:

```bash
diff .well-known/apple-app-site-association apple-app-site-association
```

Silent output means they agree.

### Why the AASA has a `"/"` key, and why it is `/tap/*`

Both components in the entry are specified, so both must match. Apple's rule,
from WWDC19 session 717:

> "For a components dictionary to match a candidate URL, all the specified
> components must match. **If you don't specify a component, the operating
> system's default behavior is to simply ignore that component.**"

The file therefore claims exactly one URL shape: a path under `/tap/` **and** a
non-empty `tap` query item. Nothing else on the domain opens the app.

**iOS on its own would not need the path.** Matching on the query item alone
would already leave `https://wildcatraffle.com/` a website and claim only
`?tap=` URLs. The `"/"` key is here for Android, which cannot see a query string
at all, so the distinction had to live somewhere Android can match on. See the
intent-filter section below: this key and `android:pathPrefix="/tap/"` are two
halves of one decision and have to move together.

`*` is zero or more characters, so `/tap/*` requires the literal five characters
`/tap/` followed by anything. `https://wildcatraffle.com/?tap=room-16` has the
path `/`, which is not `/tap/`, so **the apex URL does not match this file and
never opens the app.** That is intended. The apex `?tap=` shape is now the web
fallback that `tap/index.html` forwards to, and the portal still handles it.
Check either claim with `swcutil verify` below rather than by reading the
pattern and hoping.

`"?": { "tap": "?*" }` and not `"*"`: `*` matches the empty string too, so a
malformed `https://wildcatraffle.com/tap/?tap=` would match and hand the app an
empty slug. `?*` requires at least one character.

**Do not add `"paths"` alongside `"components"` in the same entry.** Apple, in
TN3155: *"Please avoid mixing formats. Doing so may result in unexpected
behavior."*

---

## The Apple Team ID is already filled in

`SCFGWPBXMF`, the Myind Media team, recorded in `Grilled.md`. Both AASA copies
carry the finished identifier:

```
SCFGWPBXMF.org.westbrookacademy.wildcat
```

That is `<TeamID>.<BundleIdentifier>`. Neither half is a secret: the AASA is
public by design, and every app with universal links publishes both.

Nothing is left to fill in on the Apple side. Confirm:

```bash
grep -rl TEAMID_PENDING . --exclude-dir=node_modules --exclude-dir=.git \
  --exclude-dir=docs
```

Observed 2026-08-18: no output. If that command ever names a file again,
somebody has reverted an AASA to the placeholder and iOS taps have stopped.

**Do not "tidy" this value, and do not guess a replacement if the app ever
moves teams.** A Team ID that does not match the signing team fails with no
diagnostic at all: the app installs, the link opens Safari, and nothing is
logged. See failure 6 below. The real value comes from
<https://developer.apple.com/account> then **Membership details**, the field
labelled **Team ID**, and it changes in both copies on the same day the signing
does.

---

## The one placeholder left: `SHA256_FINGERPRINT_PENDING`

The SHA-256 fingerprint of the certificate that signs the **Android build the
students actually install**.

```
SHA256_FINGERPRINT_PENDING
```

**Where to get it, and this is the part that goes wrong:**

**Play Console** then **Release > Setup > App signing** (on newer consoles,
**App integrity > App signing**). That page shows the fingerprints and it also
shows a ready made Digital Asset Links JSON snippet for the app. **Copy
Google's generated snippet rather than hand building it.**

🚨 **It must be the Play app-signing fingerprint or the upload fingerprint, not
the fingerprint your local keystore prints.** Google, verbatim:

> "If you're using Play App Signing for your app, then the certificate
> fingerprint produced by running `keytool` locally will usually **not** match
> the one on users' devices."

Getting this wrong is the classic silent Android failure. Verification runs,
returns `none` or `legacy_failure`, and neither state says why. The app looks
installed and healthy and simply never opens on a link.

`sha256_cert_fingerprints` is an **array**, so list all three and stop thinking
about it:

| Which key | Why you want it listed |
|---|---|
| Play app-signing key | What real student devices verify against |
| Upload key | Internal testing builds from Play |
| Debug keystore key | `adb install` builds during development |

Local/debug fingerprint, when you need it:

```bash
keytool -list -v -keystore ~/.android/debug.keystore \
  -alias androiddebugkey -storepass android -keypass android
```

Take the line beginning `SHA256:`, colons included, upper case.

Format check: 32 hex byte pairs separated by colons, 95 characters total.

Only `.well-known/assetlinks.json` carries this placeholder. There is no second
copy, because Google requires the file at `.well-known/` and nowhere else:

```bash
grep -rl SHA256_FINGERPRINT_PENDING . --exclude-dir=node_modules --exclude-dir=.git
```

Observed 2026-08-18:

```
.well-known/assetlinks.json
docs/universal-links.md
```

---

## The Associated Domains entitlement (iOS)

Entitlement key: **`com.apple.developer.associated-domains`**

Entitlement string, exactly:

```
applinks:wildcatraffle.com
```

Add it in Xcode via target then **Signing & Capabilities** then **+ Capability**
then **Associated Domains**. Doing it in Xcode matters: it writes the
entitlement **and** enables the Associated Domains service on the App ID. Both
are required, and **the provisioning profile must be regenerated afterwards**.
Adding the capability and then building with a stale profile is failure 5
below, and it looks exactly like the file being wrong.

`mobile/ios/App/App/App.entitlements`, merged with the NFC entitlement the app
already needs:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.developer.associated-domains</key>
    <array>
        <string>applinks:wildcatraffle.com</string>
    </array>
    <key>com.apple.developer.nfc.readersession.formats</key>
    <array>
        <string>NDEF</string>
        <string>TAG</string>
    </array>
</dict>
</plist>
```

Format is `<service>:<fully qualified domain>`. Apple: *"Make sure to only
include the desired subdomain and the top-level domain. Don't include path and
query components or a trailing slash (`/`)."* No port number either.

`mobile/ios/` is gitignored and regenerated per machine (see `mobile/SETUP.md`),
so this entitlement has to be re-added after a fresh `npx cap add ios` on a new
machine. That is a real trap: the association silently disappears on a clean
checkout and nothing in the repo notices.

---

## The AndroidManifest intent-filter

Goes inside the existing `<activity>` in
`mobile/android/app/src/main/AndroidManifest.xml`, as a **second, separate
`<intent-filter>`** alongside the `MAIN`/`LAUNCHER` one. Do not merge them.

```xml
<activity
    android:name=".MainActivity"
    android:exported="true"
    android:launchMode="singleTask"
    android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
    android:theme="@style/AppTheme.NoActionBar">

    <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
    </intent-filter>

    <!-- Android App Links: https://wildcatraffle.com/tap/?tap=<slug> -->
    <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="https" android:host="wildcatraffle.com"
              android:pathPrefix="/tap/" />
    </intent-filter>

</activity>
```

`android:autoVerify="true"` is what triggers verification at install time. The
system only inspects filters that carry `VIEW`, both `BROWSABLE` and `DEFAULT`,
and an `http`/`https` scheme, so all five lines are load bearing.

🚨 **Declare `https` only. Never add `android:scheme="http"`.** If you do,
Android must also verify `http://wildcatraffle.com/.well-known/assetlinks.json`,
and that URL 301-redirects to https on this site (observed output below).
Google forbids redirects, so adding `http` **breaks verification for the whole
app**, including the https links that were working.

⚠️ `android:launchMode="singleTask"` matters. Without it Android can spawn a
second activity instance for the link, and the URL arrives in a fresh webview
with no session. Capacitor's template already sets it. Do not change it.

🚨 **`android:pathPrefix="/tap/"` is load bearing, and it is the entire reason
the tag URL carries a path.** Android intent filters ignore the query string:
matching covers `<scheme>://<host>:<port>/<path>` only, and query and fragment
are never compared. Drop the prefix and this filter claims **the whole host**,
so once verified *every* `https://wildcatraffle.com/*` link opens the student
app on Android, including the plain portal URL and any staff page. That is what
`Grilled.md` decision 24 rejected, and why a tag holds `/tap/?tap=<slug>`. The
AASA's `"/": "/tap/*"` is the iOS half of the same decision. Change one and you
must change the other, plus every sticker.

✅ **The prefix carries a trailing slash on purpose, so both platforms scope
identically.** `android:pathPrefix` is a literal string prefix. Written as
`/tap` it would also claim `https://wildcatraffle.com/tap` with no trailing
slash, and would claim a future `/tapestry` page, neither of which the AASA's
`/tap/*` claims. Written as `/tap/` it claims exactly what iOS claims.

That costs nothing and buys the thing that matters: **both platforms now fail
the same way.** Read failure 16 below before changing this back. A sticker
missing its trailing slash would otherwise work on every Android phone in the
building and on no iPhone, which reaches an admin as "iOS is broken" rather than
as a typo, and sends them hunting through entitlements and CDN caches instead of
looking at the tag. A tag that fails everywhere gets noticed in a corridor and
rewritten in a minute. A tag that fails on half the fleet costs a day.

---

## Verifying the files are served

Run these from anywhere. The output below is what these commands **actually
returned on 2026-08-18**, before the files were merged to `main`. That is the
baseline. Re-run them after the merge and compare.

### Are the two files live?

```bash
curl -sS -o /dev/null -w "status=%{http_code} ctype=%{content_type}\n" \
  https://wildcatraffle.com/.well-known/apple-app-site-association

curl -sS -o /dev/null -w "status=%{http_code} ctype=%{content_type}\n" \
  https://wildcatraffle.com/.well-known/assetlinks.json
```

Observed 2026-08-18, before merge:

```
status=404 ctype=text/html; charset=utf-8
status=404 ctype=text/html; charset=utf-8
```

After merge to `main` you want `200` on both. Expect
`application/octet-stream` on the AASA and
`application/json; charset=utf-8` on `assetlinks.json`.

**The AASA content-type is not a bug and must not be "fixed".** GitHub Pages
allows no custom headers at all: no `_headers`, no `netlify.toml` equivalent,
no `.htaccess`. An extension-less file is served as `application/octet-stream`
and there is no way to change it. Apple accepts it. Observed today, on a live
third-party GitHub Pages site with the same `.nojekyll` plus `_config.yml`
shape as this repo:

```bash
curl -sS -o /dev/null -w "status=%{http_code} ctype=%{content_type}\n" \
  https://navadmin-viewer.github.io/.well-known/apple-app-site-association
# status=200 ctype=application/octet-stream

curl -sS -o /dev/null -w "status=%{http_code}\n" \
  https://app-site-association.cdn-apple.com/a/v1/navadmin-viewer.github.io
# status=200
```

Apple's CDN ingested a GitHub Pages AASA served as `application/octet-stream`.
That settles it. Do not spend an afternoon on the header.

`assetlinks.json` is the opposite case, and here the extension works in your
favour: Google **does** require `application/json`, and GitHub Pages serves
`.json` correctly. Observed today:

```bash
curl -sS -o /dev/null -w "status=%{http_code} ctype=%{content_type}\n" \
  https://wildcatraffle.com/package.json
# status=200 ctype=application/json; charset=utf-8
```

### Are dot-directories served at all, and is Jekyll off?

```bash
curl -sS -o /dev/null -w "status=%{http_code} ctype=%{content_type}\n" \
  https://wildcatraffle.com/.nojekyll
# observed: status=200 ctype=application/octet-stream

curl -sS -o /dev/null -w "status=%{http_code} ctype=%{content_type}\n" \
  https://wildcatraffle.com/_config.yml
# observed: status=200 ctype=text/yaml
```

Both matter. The first proves GitHub Pages serves dotfiles, so `.well-known/`
will publish. The second proves Jekyll is **not** running: a Jekyll build never
emits an underscore-prefixed file, and `_config.yml` lists `docs` and `*.md` as
excluded yet those are served too. The site is raw files straight off `main`.

If either of those ever returns 404, `.well-known/` has probably been stripped
and every tap in the school has quietly reverted to Safari.

---

## Has Apple's CDN ingested it?

This is the single most useful command in this document.

```bash
curl -sD - https://app-site-association.cdn-apple.com/a/v1/wildcatraffle.com
```

Observed 2026-08-18, before merge:

```
HTTP/1.1 404 Not Found
Apple-Failure-Details: {"status":"404 Not Found"}
Apple-Failure-Reason: SWCERR00101 Bad HTTP Response: 404 Not Found
Apple-From: https://wildcatraffle.com/.well-known/apple-app-site-association
Apple-Try-Direct: false
Cache-Control: max-age=3600,public
```

Read it line by line, because it is telling you three things:

1. `Apple-Failure-Reason` names the exact reason. Right now: the file does not
   exist yet, which is correct, it has not been merged.
2. `Apple-From` shows **Apple attempted exactly one URL**, the `.well-known`
   one. That is live proof that modern iOS does not fall back to a bare-root
   path, whatever older blog posts say. The root copy in this repo is insurance
   against a mistake, not a second chance.
3. `Cache-Control: max-age=3600` means **the CDN caches failures for an hour
   too**. A fix is not visible immediately. Append a junk query to force a
   fresh origin fetch:

```bash
curl -sD - "https://app-site-association.cdn-apple.com/a/v1/wildcatraffle.com?bust=1"
```

**When that command returns your JSON with `Apple-Origin-Format: json`, Apple
has it, and not before.** Until then, no amount of reinstalling the app will
make a single tap work.

### How long you wait

Apple, verbatim:

> "Apple's content delivery network requests the `apple-app-site-association`
> file for your domain **within 24 hours**. Devices check for updates
> approximately **once per week** after app installation."

| Situation | Wait |
|---|---|
| File just merged to `main` | Up to **24 hours** before Apple's CDN holds it |
| A failed fetch you just fixed | **1 hour** of cached failure, or use `?bust=1` |
| Device has an old association | **Reinstall the app.** That forces a fresh check on that device |
| Waiting for a device to notice on its own | Roughly **a week**. Do not do this |

Reinstalling the app is the iteration loop. It is not "wait a week".

### On a Mac, before you commit

```bash
# The real tag URL. This one must match.
sudo swcutil verify -d wildcatraffle.com \
  -j ./.well-known/apple-app-site-association \
  -u "https://wildcatraffle.com/tap/?tap=room-16"
# expect: Pattern "https://wildcatraffle.com/tap/?tap=room-16" matched.

# The old apex shape. This one must NOT match, and that is the point.
sudo swcutil verify -d wildcatraffle.com \
  -j ./.well-known/apple-app-site-association \
  -u "https://wildcatraffle.com/?tap=room-16"
# expect: reported as not matching. Path is "/", pattern needs "/tap/".

# The missing trailing slash. Also must NOT match. See failure 16.
sudo swcutil verify -d wildcatraffle.com \
  -j ./.well-known/apple-app-site-association \
  -u "https://wildcatraffle.com/tap?tap=room-16"
# expect: reported as not matching. Path is "/tap", pattern needs "/tap/".

sudo swcutil dl -d wildcatraffle.com
```

`swcutil verify` validates the candidate file against a real URL without
touching the CDN, so it catches a wrong path or a wrong `?tap` pattern in
seconds. **Run all three.** A file that matches the first and also matches
either of the other two has been loosened by somebody, and the loosening is
invisible in the app until a staff member gets thrown into the student portal.
`swcutil` cannot catch a wrong Team ID.

On the device: **Settings > Developer > Associated Domains Development >
Diagnostics**, then type the full URL.

---

## Verifying Android on a device

```bash
# Current verification state for the package
adb shell pm get-app-links org.westbrookacademy.wildcat

# During testing, scope to the current user
adb shell pm get-app-links --user cur org.westbrookacademy.wildcat

# Force a re-verification
adb shell pm verify-app-links --re-verify org.westbrookacademy.wildcat

# Reset the link state entirely
adb shell pm set-app-links --package org.westbrookacademy.wildcat 0 all

# Fire a test intent
adb shell am start -a android.intent.action.VIEW \
    -c android.intent.category.BROWSABLE \
    -d "https://wildcatraffle.com/tap/?tap=room-16"
```

| State | Meaning |
|---|---|
| `verified` | Domain successfully verified. This is the goal |
| `none` | Nothing recorded. The verifier has not finished, or had no network |
| `approved` / `denied` | Force-set via shell. Testing only |
| `migrated` / `restored` | Carried over from legacy verification or a data restore |
| `legacy_failure` | Rejected by the legacy verifier, reason not reported |
| `system_configured` | Auto-approved by device configuration |
| `1024`+ | Custom error code from the device's verifier |

`none` and `legacy_failure` are the two you will actually see on failure, **and
neither tells you why**. That is the whole problem in one line.

---

## Never `www.wildcatraffle.com`

**`www.wildcatraffle.com` must never appear in the entitlement, on a tag, or in
`assetlinks.json`.** Not as a convenience, not as a second entry, not on one
sticker somebody printed early.

It 301-redirects. Observed 2026-08-18:

```bash
curl -sI https://www.wildcatraffle.com/ | head -4
```

```
HTTP/2 301
server: GitHub.com
content-type: text/html
location: https://wildcatraffle.com/
```

Both platforms forbid a redirect on this fetch:

- Apple: *"You must host the file using `https://` with a valid certificate and
  **with no redirects**."*
- Google: *"The `assetlinks.json` file must be accessible **without any
  redirects** (no 301 or 302 redirects)."*

So `applinks:www.wildcatraffle.com` in the entitlement fails, silently. A tag
written with a `www.` URL fails, silently, and it is a sticker on a wall that
somebody has to peel off and re-encode.

The same trap applies to `http`. Observed 2026-08-18:

```bash
curl -sI http://wildcatraffle.com/.well-known/assetlinks.json | head -2
```

```
HTTP/1.1 301 Moved Permanently
Server: GitHub.com
```

That redirect is why the Android manifest above declares `https` only.

Apple also confirms each subdomain needs its own entitlement entry and its own
association file, so `www.` is not a shortcut even in principle. **Write every
tag with the bare apex host.**

---

## Every way this fails SILENTLY: iOS

No error, no log, no banner. The link just opens Safari and everyone assumes
the app is broken.

1. **The file has an extension.** `apple-app-site-association.json` is served
   happily at a URL Apple never requests. Apple asks for the extension-less
   name only.
2. **The file is not in `/.well-known/`.** A root-level copy alone is no longer
   the documented location, and the `Apple-From` header above proves Apple only
   tries `.well-known`.
3. **Any redirect on the fetch.** `www.` to apex, or http to https if anything
   ever requests the http URL. See the section above.
4. **Apple's CDN has not fetched it yet, or holds a stale copy.** Up to 24
   hours, and failures are cached for an hour. Diagnose with the
   `cdn-apple.com` command, never by guessing.
5. **The entitlement is missing from the provisioning profile.** Adding the
   capability in Xcode is not enough if you then build with a stale profile.
   Regenerate it. This looks identical to a broken AASA.
6. **The Team ID is wrong** in `appIDs`. A mismatch between the file and the
   actual signing team fails with **no diagnostic whatsoever**. The shipped
   value is `SCFGWPBXMF`, read off the account rather than guessed. Anyone
   editing it is editing a line with no error path.
7. **Jekyll strips `.well-known/`.** Not a risk today (proved above), but it
   becomes one the moment somebody deletes `.nojekyll`, or GitHub migrates this
   site to the Actions build path. `include: [".well-known"]` is now in
   `_config.yml` for exactly this. Two further hazards on that path:
   `actions/jekyll-build-pages` runs Jekyll unconditionally and never checks
   `.nojekyll`, and `actions/upload-pages-artifact` defaults
   `include-hidden-files: false`, which strips `.well-known` by a completely
   different mechanism and needs `include-hidden-files: true`. If anyone ever
   migrates the build, handle both.
8. **Somebody typed the URL into Safari's address bar to test it.** Apple, in
   TN3155: *"**Entering the URL directly into the web browser's address bar
   will never open the app**, as this is direct navigation within the web
   browser."* This invalidates the most obvious way anyone will try to check
   your work. Test by tapping a link in Notes or Messages, or with `swcutil`.
9. **The student previously chose "open in Safari"** from the breadcrumb
   banner. TN3155 documents this as a sticky per-device default: *"The option
   you choose will set the default behavior for your device when following
   universal links from this domain in the future."* **This is the number one
   cause of "it worked yesterday."** Reinstalling the app resets it. It shows
   as `User Approval:` in a sysdiagnose.
10. **Navigating within the same domain.** Apple: *"When a user browses your
    website in Safari and taps a universal link in the same domain, the system
    opens that link in Safari."* ⚠️ **This is a live hazard for this project,
    not a footnote.** If the student portal at `wildcatraffle.com` ever renders
    a link to `https://wildcatraffle.com/tap/?tap=...`, tapping it will never
    open the app. The same applies to opening the link from inside the app.
    Apple's own workaround is a separate subdomain for tap URLs, which would
    then need its own AASA and its own entitlement entry.
11. **The server blocks unknown user agents or non-US traffic.** TN3155
    requires direct access to the AASA *"in all geographical locations, from any
    IP address"* and *"your server should accept all user agent requests."* Not
    a risk on GitHub Pages, but it is why a hand-rolled origin often fails.
12. **A port number in the entitlement domain.** TN3155: domains in `applinks`
    cannot contain one.
13. **A third-party browser.** TN3155: *"It is up to third-party web browsers
    to enable universal links functionality."* Chrome and Firefox on iOS may
    not honour them.
14. **`AppDelegate.swift` lost its `continue userActivity:` method.** The OS
    opens the app, but the URL never reaches the webview and the app opens to a
    blank home screen. Looks like an app bug, is a native-shell bug.
15. **`paths` and `components` mixed in the same `details` entry.** Apple says
    this "may result in unexpected behavior", which in practice means one of
    them is ignored and you cannot tell which.
16. **The tag URL is missing the trailing slash after `tap`.**
    `https://wildcatraffle.com/tap?tap=room-16` has the path `/tap`. The shipped
    pattern is `/tap/*`, and `*` is zero or more characters, so the pattern
    requires the literal five characters `/tap/`. `/tap` is not `/tap/`, the
    path component does not match, every specified component must match, and
    iOS hands the URL to Safari. **Android fails the same way, on purpose.**
    `android:pathPrefix` is a literal string prefix, so a bare `/tap` would have
    matched both spellings and claimed the mistyped tag anyway; this repo ships
    `/tap/` precisely so it does not. If you ever see a sticker work on Android
    and fail on iPhone, somebody has dropped that trailing slash from the
    manifest, and the platforms have drifted apart again.

    GitHub Pages hides the typo further, because `tap/index.html` is served as a
    directory index, so a browser reaching `/tap` arrives at the portal by a
    redirect and the student still ends up in the right place. The tag looks
    like it works. Catch it with the third `swcutil verify` above, before a
    batch of tags is written.

---

## Every way this fails SILENTLY: Android

1. **The wrong fingerprint.** Local `keytool` output instead of the Play
   app-signing fingerprint. The single most common cause. State reads `none` or
   `legacy_failure` and neither says why.
2. **Any redirect** on `https://wildcatraffle.com/.well-known/assetlinks.json`.
   Same rule as Apple, same `www.` trap.
3. **`application/json` missing** on the response. Not a risk on GitHub Pages
   for a `.json` file, verified above, but it is a hard requirement.
4. **`autoVerify` on the wrong intent-filter**, or a filter missing `VIEW`,
   `BROWSABLE`, `DEFAULT`, or the scheme. Verification simply never runs.
5. **`android:scheme="http"` declared.** Forces Android to verify the http URL,
   which 301-redirects, which breaks verification **for the whole app**.
6. **Verification has not run yet.** It is asynchronous after install and can be
   delayed on a metered or offline connection. On school Wi-Fi with a captive
   portal, assume it has not run.
7. **The student set "Open supported links: don't allow"** in Settings > Apps >
   Wildcat Hub > Open by default. Sticky, per device, invisible to you. The
   Android twin of iOS failure 9.
8. **Android 12+ changed the default.** An app targeting API 31 or higher whose
   verification failed loses its links entirely rather than showing a chooser.
   Before Android 12 a failure at least produced a disambiguation dialog, so
   somebody noticed. Now nothing happens.

---

## Ship checklist

1. Replace `SHA256_FINGERPRINT_PENDING` in `.well-known/assetlinks.json`, with
   the Play app-signing fingerprint, ideally by pasting Google's own snippet.
   The Apple Team ID needs nothing: it is already `SCFGWPBXMF` in both AASA
   copies.
2. Run the three `swcutil verify` commands above against the local file. One
   match, two non-matches. Do this before the merge, not after.
3. Merge to `main`. On this repo, merging to `main` deploys to production.
4. `curl` both association files. Expect 200 on each. `curl` the forwarding page
   at `https://wildcatraffle.com/tap/?tap=room-16` as well. Expect 200 and HTML,
   because that is what an un-installed phone gets.
5. `curl -sD - https://app-site-association.cdn-apple.com/a/v1/wildcatraffle.com`
   until it returns your JSON. Up to 24 hours.
6. Add the Associated Domains capability with `applinks:wildcatraffle.com`, then
   **regenerate the provisioning profile**.
7. Add the `autoVerify` intent-filter **including `android:pathPrefix="/tap/"`**,
   build, then `adb shell pm get-app-links org.westbrookacademy.wildcat` until
   `verified`.
8. Write tags with `https://wildcatraffle.com/tap/?tap=<slug>`. **The trailing
   slash after `tap` is not optional**, see failure 16. Never `www.`, never
   `http`, never the old apex `/?tap=` shape.
   🚨 **Check what the in-app tag programmer actually writes before trusting
   it.** `wcTapUrl()` in `script.js` is the single writer of tag URLs, and as of
   2026-08-18 it still returns `'https://wildcatraffle.com/?tap=' + slug`, the
   apex shape. Until that function emits `/tap/`, every tag the app writes is a
   tag that opens Safari.
9. Re-encode the tags already mounted on the walls. They hold the old apex URL,
   and they stop opening the app the moment the path filter ships. They keep
   working as plain web links throughout, so this can be done room by room.
10. Test by tapping a real tag, or a link in Messages. **Not** by typing the URL
    into Safari, which can never work.

---

## Optional: Android 15 query matching

Android 15 added query matching that mirrors Apple's `components`, which would
narrow the `/tap` prefix capture described above to `?tap=` URLs only. It is
**additive, not a fix**: older devices ignore it and fall back to path-level
matching, so the small residual asymmetry with iOS remains for most of the
school's phones. The large one, host-wide capture, is already handled by
`android:pathPrefix="/tap/"`.

It is deliberately **not** in the shipped `assetlinks.json`, because adding it
changes behaviour on new devices only and that is a product decision, not a
config detail. If it is wanted, it goes in the statement file, not the
manifest:

```json
"relation_extensions": {
  "delegate_permission/common.handle_all_urls": {
    "dynamic_app_link_components": [
      { "?": { "tap": "?*" } },
      { "/": "*", "exclude": true }
    ]
  }
}
```

Same wildcard grammar as Apple: `*` is zero or more, `?` is exactly one, `?*`
is one or more. Android evaluates rules in order until it finds a match, so
declare the specific rule before the general one.

---

## Things that will bite you

**The whole failure mode is silence.** There is no error banner, no console
warning, no crash. A student taps a tag, Safari opens, and the only signal you
get is a teenager saying "it doesn't work". Every check in this document exists
because the system will not tell you.

**`mobile/ios/` and `mobile/android/` are gitignored.** The entitlement and the
intent-filter are not in this repo. A fresh checkout on a new machine
regenerates both native projects without them, and the association silently
disappears. Re-apply both after any `npx cap add`.

**Merging to `main` deploys to production**, immediately, to 623 students and
56 staff. The association files and `tap/index.html` are additive, live at paths
nothing currently serves, and cannot affect the existing portal, but the
`_config.yml` change is on the same deploy path as everything else.

**The AASA is public.** It publishes the Team ID and bundle identifier to
anybody who fetches it. That is normal and unavoidable, every app with
universal links does it, but do not treat either value as a secret afterwards.

**iOS still costs two taps.** Universal Links fix *which app opens*, not the
tap count. Background tag reading puts up a notification the student must tap
before the app opens. Nothing in this document changes that.
