# Grilled: Wildcat Hub PowerSchool pipeline

Alignment record. Survives sessions. Updated 2026-08-07.

## Goal

Stand up and prove a read only PowerSchool SIS data pipeline feeding the
Wildcat Hub teacher and admin dashboard for LA Promise Fund / Westbrook
Academy. Staging and validation only. No deployment, no production data.

## Scope

Driven by `/Users/myindsound/Downloads/wildcat-hub-staging-test-prompt.md`,
which defines an 18 field manifest and eight phases with a hard stop after
each. That document is authoritative for requirements.

In scope this session: Phase 0 groundwork. The PowerSchool plugin package,
the PowerQueries, a local extraction harness, and the Phase 0 and Phase 1
documents.

Out of scope this session: Phases 3 through 7. Nothing is loaded anywhere.

## Target users

Classroom teachers (own roster only) and school administrators (explicitly
enumerated wider scope, never "everything"). Students see their own totals.

**Auth and data, decided 2026-08-11 (supersedes "Google sign in keyed on
`@lapromisefund.org`"):** **Convex** replaces Firebase for both the database and
identity verification. Staff sign in with **Microsoft Entra ID (O365)**; students
sign in with **Google**, which they already use on their Chromebooks. Convex
accepts both as custom OIDC providers and validates the tokens itself, so no auth
broker is needed. **Email is the identity key on both sides** and is what links a
signed in person to their record. Role comes from provider plus email domain,
checked server side, never from a client settable field. The browser never touches
the database; it calls functions. No build step: Convex's HTTP API is reachable by
plain fetch. Full design in `docs/auth-architecture.md`.

## Stack

- Source: PowerSchool SIS REST API, OAuth 2.0 client credentials, via an
  installed plugin
- Extraction: Node 22.18+ with native TypeScript type stripping. Zero runtime
  dependencies on purpose, so the harness runs with no install step
- Current app: static HTML, CSS, and a single `script.js`, backed by Firebase
  (project `wildcat-hub-94025`)
- Warehouse per the brief: Supabase, `staging` schema, row level security.
  App tier is **Convex** as of 2026-08-11, see open question 3

## Constraints

1. Read only. The plugin requests `ViewOnly` on every field. The client blocks
   any verb other than GET, and POST only to named query paths.
2. Sandbox only. The config layer refuses a host that looks like production
   unless someone deliberately sets an escape hatch.
3. Restricted fields (7 federal ethnicity, 8 federal race, 12 IEP, 13 504,
   14 English Learner) get separate queries, separate tables, separate access
   tests, and their own go / no go line.
4. Secrets never enter a file, a log, a commit, or a fixture.
5. Hard stop at every phase gate.
6. No em dashes in any produced file.

## Non-goals

- ~~Writing anything back to PowerSchool~~ **SUPERSEDED 2026-08-12, see below**
- Pulling production student records
- Loading data anywhere before the Phase 0 gate is cleared
- Adding manifest fields opportunistically

## Scope change 2026-08-12: two way sync

Directed by the user, twice, in their own words: "sync powerschool 2 way for
updating student behavioral, and point data", and "any uploaded or updated info
from the app should sync on demand back to sis". This reverses the first
non-goal above. Recorded here rather than done quietly.

Also directed: pull "every feature we can get from SIS". The measuring stick is
the published API reference at `developer.powerschool.com`, not a summary of it.
Two numbers decide the work: manifest coverage, 15 of 19 today, and a behavior
event written to PowerSchool and read back unchanged.

### What does not change

Constraint 4 (secrets never enter a file) and constraint 6 (no em dashes) hold
unchanged. Constraint 1 (read only) is now **read only until the access request
is amended and re-approved**, which is a gate, not a permanent state.

**New hard rule.** A sync must never write earned student value in either
direction. Balances hold 6,616,500 in Wildcat Cash and PowerSchool knows nothing
about any of it, so any value the SIS appears to offer for a balance is absence,
not zero. Enforced by the allowlist in `convex/sisMerge.ts`. The write half needs
its own mirror of that guard: the app is authoritative for points, PowerSchool is
authoritative for enrollment, and neither may overwrite the other's truth.

### The gate this ends at

The plugin holds `ViewOnly` on all 108 fields, so the write path cannot close
without: new fields and write access in `plugin.xml`, a version bump, and **a
PowerSchool admin disabling and re-enabling plugin 9741**. Everything up to that
line is buildable and provable now. Build to the line, prove it fails with a 403
today, and stop there.

### Scope addition 2026-08-13: student pass wallet and NFC hall pass

Directed by the user. NOT rolling out immediately; building the functions now.

### What it is

A **web app**, not an Apple Wallet pass. Students open a link and swipe through
cards. Decided after establishing that a `.pkpass` renders exactly ONE barcode
(the `barcodes` array is format fallback, not multiple payloads), that ChromeOS
cannot install a pkpass at all, and that signing requires a paid Apple Developer
certificate. A web app needs none of that and reaches every device.

Three cards:
1. **Hall pass** with a running timer
2. **Clever QR**, scanned by a classroom computer to log the student in
3. **Lunch ID barcode**, a different number from the student number

### NFC: what actually works

Tags encode a **URL**, not an app payload. iOS 14+ background tag reading opens
the link with no app installed; Android Chrome does the same. The Web NFC API
(`NDEFReader`) is Chrome-on-Android only and is deliberately NOT depended on.

**A static tag is a deterrent, not proof of presence.** The URL can be
photographed or shared and replayed from anywhere. Accepted knowingly. Software
mitigations: taps only count inside an active pass window, destination must be
tapped before origin, every tap is attributed to the signed-in student, and the
sequence is visible to the teacher. Real proof needs rotating or powered tags,
which is a hardware decision nobody has made.

### Hall pass lifecycle, as specified

1. Student **requests** a pass from their card.
2. Teacher **approves** it. The pass becomes active and the timer starts.
3. Student taps the NFC tag **at the destination** (restroom, office, nurse).
4. Student taps the NFC tag **back at the classroom of origin**. The timer stops
   and the pass closes.

A pass is only active between approval and the return tap. Anything else, an
unapproved request or a student who never taps back, is a state a teacher can
see rather than a silent gap.

### Open questions for this scope

15. **Clever QR payload.** Clever Badges are QR codes, but static-per-student
    versus rotating changes whether one may be stored and re-rendered at all. If
    rotating, the card has to fetch it live and it cannot be cached.
16. **Lunch ID source.** `students.lunch_id` EXISTS on this instance and answered
    403, so it needs one field line in the access request. Confirmed present, not
    yet granted.
17. **Student sign-in is still blocked.** These cards identify a student, and
    student sign-in does not work yet: 209 of 646 have no email, and the roster
    read requires a session. The pass surface cannot ship before that does.
18. **Tag hardware and placement.** Who buys, encodes and mounts the tags, and
    what happens when one is peeled off a wall.

## Open questions this raises, not yet answered

12. **What object does a behavior event become in PowerSchool?** The `Log` table
    is the likely home, but that is an assumption to check against the real API
    reference, not a decision. Log entry type, subtype, and consequence codes are
    school configured and have to be read from the instance.
13. **Does point data go back at all, or only behavior?** Points are an app
    invention. PowerSchool has no native field for them, so writing them means a
    custom field, an extension table, or a Log entry body. Cheapest honest answer
    may be that behavior events go back and balances stay in the app.
14. **What is authoritative on a conflict?** If a Log entry is edited in
    PowerSchool after the app wrote it, does the next sync overwrite it or leave
    it? Needs a stated rule before any write ships.

## Scope addition 2026-08-13: student pass wallet and NFC hall pass

Directed by the user. NOT rolling out immediately; building the functions now.

### What it is

A **web app**, not an Apple Wallet pass. Students open a link and swipe through
cards. Decided after establishing that a `.pkpass` renders exactly ONE barcode
(the `barcodes` array is format fallback, not multiple payloads), that ChromeOS
cannot install a pkpass at all, and that signing requires a paid Apple Developer
certificate. A web app needs none of that and reaches every device.

Three cards:
1. **Hall pass** with a running timer
2. **Clever QR**, scanned by a classroom computer to log the student in
3. **Lunch ID barcode**, a different number from the student number

### NFC: what actually works

Tags encode a **URL**, not an app payload. iOS 14+ background tag reading opens
the link with no app installed; Android Chrome does the same. The Web NFC API
(`NDEFReader`) is Chrome-on-Android only and is deliberately NOT depended on.

**A static tag is a deterrent, not proof of presence.** The URL can be
photographed or shared and replayed from anywhere. Accepted knowingly. Software
mitigations: taps only count inside an active pass window, destination must be
tapped before origin, every tap is attributed to the signed-in student, and the
sequence is visible to the teacher. Real proof needs rotating or powered tags,
which is a hardware decision nobody has made.

### Hall pass lifecycle, as specified

1. Student **requests** a pass from their card.
2. Teacher **approves** it. The pass becomes active and the timer starts.
3. Student taps the NFC tag **at the destination** (restroom, office, nurse).
4. Student taps the NFC tag **back at the classroom of origin**. The timer stops
   and the pass closes.

A pass is only active between approval and the return tap. Anything else, an
unapproved request or a student who never taps back, is a state a teacher can
see rather than a silent gap.

### Open questions for this scope

15. **Clever QR payload.** Clever Badges are QR codes, but static-per-student
    versus rotating changes whether one may be stored and re-rendered at all. If
    rotating, the card has to fetch it live and it cannot be cached.
16. **Lunch ID source.** `students.lunch_id` EXISTS on this instance and answered
    403, so it needs one field line in the access request. Confirmed present, not
    yet granted.
17. **Student sign-in is still blocked.** These cards identify a student, and
    student sign-in does not work yet: 209 of 646 have no email, and the roster
    read requires a session. The pass surface cannot ship before that does.
18. **Tag hardware and placement.** Who buys, encodes and mounts the tags, and
    what happens when one is peeled off a wall.

## Open questions

1. **Sandbox hostname.** The brief leaves `[TEST/SANDBOX HOSTNAME]` blank.
   Everything past plugin build is blocked on it. If no sandbox exists, that
   is an escalation, not a workaround.
2. **Credentials.** Needs a PowerSchool admin to install and enable the
   plugin, then hand over the client id and secret through the secret store.
3. **RESOLVED 2026-08-11: Convex.** The brief specified Supabase and the app ran
   on Firebase. Neither won. Convex is the app tier because authorization runs in
   server side functions rather than a rules DSL, so the browser never gets a
   direct line to the data, and "students read only their own row" is expressible
   at all. Whether the PowerSchool warehouse also moves to Convex or stays
   Postgres per the brief is still open and does not block the app tier.
4. **Fields 12 and 13.** Source unknown. Deliberately absent from the access
   request rather than guessed. See `docs/field-sourcing.md`.
5. **Field 18.** `SchoolStaff` probably cannot separate an assigning admin
   from a classroom teacher. Likely fallback is Entra ID group membership.
6. **Fields 7 and 8.** No stated use case yet. Recommendation is descope
   unless someone names the decision they inform.
7. **Secret store.** The brief says `[secret store]` without naming one. `.env`
   is a local sandbox stopgap only.
8. **Retention.** No retention policy exists yet for the warehouse copy of
   student records. It is a go / no go line.
9. **Student email is not in the manifest.** Format confirmed as initials plus
   student number, e.g. `ar11414@westbrookacademy.org`, and the student number is
   already the `id` on all 446 records. Deriving them was declined in favour of
   waiting for the authoritative source; the format is kept as a verification
   check against field 19 when it lands. The 18 field manifest has Staff
   Email (17) and no student email, and app student records have no email
   field. Google sign in returns an address with nothing to join it to, so
   student auth is blocked on a **new field 19, Student Email**, which amends
   the access request and needs PowerSchool admin re-approval. Deliberate scope
   change, recorded here rather than added quietly against constraint 4.
10. **RESOLVED 2026-08-11: staff domain is `lapromisefund.org`.** Students are
   on `westbrookacademy.org`. The two are different domains with no overlap,
   so a staff address can never be mistaken for a student one or the reverse.
   Set as `STAFF_DOMAIN` on the Convex deployment, not in code. The org's GAM
   tooling uses `laspromise.org` for a different purpose; it is not this.
11. **Do Entra UPNs match PowerSchool `email_addr`?** If they diverge the email
   join needs an alias map, which is a schema change.

## Where things are

| Path | What |
|---|---|
| `powerschool/plugin/plugin.xml` | Access request, read only, 18 field manifest |
| `powerschool/plugin/queries_root/...` | Seven PowerQueries |
| `powerschool/sync/` | Local extraction harness, zero dependencies |
| `powerschool/out/` | Built plugin zip, gitignored |
| `docs/plugin-install.md` | Step by step install and first run |
| `docs/field-sourcing.md` | Phase 1 unknowns and the questions to send |
| `docs/access-gap.md` | Generated by `npm run probe` |

## Scope addition 2026-08-17: native iOS + Android student app (Capacitor)

Directed by the user, this session. Reverses the "web app, not native" decision
above (lines 109 to 113) FOR A STUDENT APP ONLY. The web app stays and remains
the reach-every-device surface; the native app WRAPS the same student portal so
it can reach device hardware the browser cannot.

### Why native, and why now

The one thing the web cannot do on iPhone: NFC. iOS Safari and an iOS PWA have no
Web NFC, so on iPhone the portal can neither scan a tag in-app nor program one. A
native app gets Core NFC (read AND write) plus native camera and native push. That
is the whole reason to build it. Android web already has Web NFC, so the app mainly
buys iOS parity plus a home-screen presence on both.

### Decisions locked

1. Approach: Capacitor wrapper around the EXISTING student portal. No UI rewrite,
   one web codebase, iOS and Android projects generated from it. Chosen over
   SwiftUI and Expo/React Native because both of those rebuild the student UI.
2. NFC via `@capacitor-community/nfc` (read and write NDEF, both platforms). Camera
   via `@capacitor/camera`. Push via `@capacitor/push-notifications`.
3. NFC bridge: a shim keyed on `Capacitor.isNativePlatform()`. Native app calls the
   plugin; browser falls back to Web NFC or the URL tap. The existing
   `wcStudentNfcScan` is the seam.
4. Distribution: PRIVATE to the school (TestFlight, or Apple School Manager custom
   distribution). NOT the public App Store, which for a minors and student-data app
   is the strictest, slowest review. NFC works the same on private distribution.
5. Branch: `ios-student-app`. Scaffold and a simulator build need no Apple account;
   real-device NFC, TestFlight and signing do.

### Open questions for this scope

19. Apple Developer account: does one exist, individual or organization? Org
    accounts need a D-U-N-S number. Unanswered.
20. Camera use case: what does the student camera do? Scan a QR or a tag fallback,
    a profile photo, something else? Named as a hardware need, purpose not stated.
21. Android distribution channel: Play Console internal testing, or a signed APK
    handed to the school directly?
22. Which portal surfaces ship in the app: the whole student portal, or only the
    pass wallet and tap flow?
23. iOS NFC entitlement and provisioning profile, which gate any real-device tap.

### Update 2026-08-17: open question 19 resolved

Apple Developer account exists: `lawrenceb@myindmedia.org` (Myind Media). The app
distributes under that team. Bundle id stays `org.westbrookacademy.wildcat`
(reverse-DNS is just an identifier, registered under the Myind Media account). This
unblocks device NFC verification and TestFlight (scope piece 05).

### Update 2026-08-18: Apple Team ID, and two decisions the NFC scope did not cover

**Apple Team ID: `SCFGWPBXMF`.** Full app identifier for entitlements and for the
Universal Links association file: `SCFGWPBXMF.org.westbrookacademy.wildcat`. Not a
secret; it ships in `.well-known/apple-app-site-association`, which is public by
design. This answers the last unknown blocking the association file.

**Decision 24: the tag URL gains a path. Tags now hold
`https://wildcatraffle.com/tap/?tap=<slug>`, not `/?tap=<slug>`.**

Forced by a platform asymmetry, not by taste. Android intent filters match only
scheme, host, port and path; they cannot see a query string at all. A filter on
`wildcatraffle.com` therefore claims EVERY link on the host, so once App Links
verified, a staff member tapping any portal link on an Android phone would be
thrown into the student app. Apple can match a query item and does not need this,
but both platforms have to agree on one URL, so the distinction had to move into
the path where Android can see it. `android:pathPrefix="/tap/"` then scopes it. The trailing slash on that prefix is
deliberate: `pathPrefix` is a literal string prefix, so a bare `/tap` would also
claim `/tap` with no slash and any future `/tap*` page, which iOS would not. With
the slash the two platforms claim exactly the same set, so a mistyped sticker
fails on both rather than working on every Android phone and no iPhone, which is
the version of that bug that costs a day to diagnose.

Consequences, in the order they matter:

1. Every tag already programmed with the old URL keeps working as a plain web
   link but stops opening the app once the path filter ships. Mounted tags need
   rewriting, and the native app is the thing that can rewrite them, so the app
   has to reach a device before the tags can be migrated.
2. `tap/index.html` now exists: a forwarding page for the phone with no app
   installed, which sends `/tap/?tap=<slug>` on to `/?tap=<slug>` where the
   portal's existing arrival handling takes over. GitHub Pages cannot issue
   redirects, so it is done in the page. Apple's no-redirect rule governs the
   association file, not the tag URL, so this is safe.
3. `wcTapUrl()` in `script.js` is the single writer of tag URLs and is what makes
   the new shape real for anyone programming a tag.

**Decision 25: the NFC plugin is swapped, not bought.**

`@capawesome-team/capacitor-nfc`, which `mobile/package.json` had declared since
the scaffold, is paid sponsorware: 404 on the public npm registry, closed source,
private registry plus licence key, 990 dollars a year. There is no lockfile and no
`node_modules` in `mobile/`, which confirms `npm install` there had never once
succeeded, and is why every NFC call in `script.js` carried a `TODO-VERIFY`.

Replaced with `@exxili/capacitor-nfc`: MIT, public, real NDEF read and write on
both platforms, compatible with the pinned Capacitor 6. Two costs accepted: it is
version 0.0.13 with a single maintainer, and it cannot customise the iOS scan
sheet, so students see Apple's generic wording instead of ours.

**Constraint added: the iOS tap is two actions, and cannot be one.**

Apple shows an unconditional notification banner on a background tag read; a
Universal Link changes what the banner opens, not whether there is one. Direct
launch is Android behaviour. So the doorway cost is 2 actions on iPhone XS and
later, 3 if locked, and the background path does not exist at all on iPhone 7, 8
or X without the student first enabling NFC Tag Reader in Control Center. The
in-app scan session is therefore the primary flow and the banner is the fallback,
which is the opposite of how the scope was originally imagined.

This also constrains the anti-forgery design: on the banner path the app receives
only a URL, which a student can forward to a friend, and no proof a tag was
physically present. The existing gesture requirement in `confirmTapCheckIn` is
what keeps that honest, so the deep-link handler routes into the same confirmation
screen and never taps on its own.

### Update 2026-08-18: the native shell is real, and one dispute is closed

Built and run. Xcode 26.3, CocoaPods 1.17.0 via Homebrew (no sudo; the system
Ruby 2.6 is untouched), Node 22 from the keg. `npm install` in `mobile/`
completes cleanly, which is the practical proof of decision 25: the paid plugin
404s for anyone without a licence key, and `@exxili/capacitor-nfc@0.0.13`
installs. Capacitor wired all five native plugins, the simulator build succeeded,
and the app launched.

**Closed: does a no-build Capacitor app need `registerPlugin`?** No. Two critics
in the round 3 gauntlet asserted with high confidence that nothing calls
`Capacitor.registerPlugin`, so `Capacitor.Plugins` must be empty on device and
the whole native block was unreachable. A probe in the running app disproved it:
`registerPlugin` is indeed `undefined`, and `Plugins.NFC`, `.App` and `.Haptics`
are all live objects with callable methods, injected natively by `JSExport.swift`
before any page script runs. The lesson worth keeping is that a bundled-app
mental model gives the wrong answer for this project, confidently, and the only
way to settle it was to run it.

**Constraint added: `console.log` is not a debugging channel on device.** The
bridge registers a Console plugin, but webview logs did not reach
`xcrun simctl spawn booted log stream`. Use Safari Web Inspector, or render the
value on screen and screenshot it.

**Dropbox hazard, learned the hard way.** `mobile/.dropboxignore` now exists and
is committed. Marking a generated folder ignored by xattr AFTER Dropbox has begun
syncing it makes Dropbox remove the local copy: a freshly generated `ios/` became
an empty directory plus an `ios 2` conflict folder within a minute. The rule has
to exist before the folder does.

### Decision 26 (2026-08-18): Capacitor 6 to 8, because students could not sign in

Found by running the app, not by reading it. The native shell built and launched,
and the student sign-in screen showed `Failed to load
https://accounts.google.com/gsi/client`. Diagnosed in the simulator:

```
origin: capacitor://localhost   (then capacitor://wildcatraffle.com)
wildcatraffle.com fetch: HTTP 200      <- network is fine
XHR accounts.google.com/gsi/client: status 0, CORS
script tag: onerror                    <- what the student sees
```

Google Identity Services will not serve to a `capacitor://` origin, and iOS
cannot give a locally served webview an `https://` origin: setting
`server.iosScheme: 'https'` is silently ignored, because WKWebView reserves http
and https for real network loads. Tested and reverted. So the web sign-in the
browser portal uses cannot work inside the app, at all, on any iPhone.

The fix is native Google sign-in. The only maintained Capacitor plugin for it,
`@capgo/capacitor-social-login`, needs Capacitor >= 8, so the project moves to
**Capacitor 8.5.0**. Chosen over the one Capacitor 6 option
(`@codetrix-studio/capacitor-google-auth@3.4.0-rc.4`) because putting a release
candidate on the authentication path of an app used by 623 children is a worse
trade than an upgrade done now, while the native project is one command to
regenerate and nothing is on a student's phone yet. Capacitor 6 was also two
majors old and its no-bundler escape hatch is already deprecated.

Consequences:

1. **CocoaPods is no longer used.** Capacitor 8 builds iOS through Swift Package
   Manager. There is no `.xcworkspace`; every `xcodebuild` command becomes
   `-project ios/App/App.xcodeproj`.
2. **`@capacitor-community/barcode-scanner` is dropped, not upgraded.** Its peer
   range is `^5.0.0`, so it never worked on 6 either: `cap add ios` reported five
   plugins where package.json listed six, and nothing in the codebase referenced
   it. The maintained replacement is `@capacitor-mlkit/barcode-scanning`, and it
   waits until open question 20 says what the student camera is for.
3. **The backend is untouched.** `convex/auth.config.ts` checks a token's `aud`
   against a specific Google client ID, and the plugin's `serverClientId` option
   requests an ID token audienced to that same existing web client. The two
   provider entries and the server-side domain check in `identity.ts` all stand.

### Open question 26: the Google iOS OAuth client

Native sign-in needs an **iOS OAuth client** created in Google Cloud Console for
bundle id `org.westbrookacademy.wildcat`, in the same project as the existing web
client. The web client id stays the `serverClientId` so the token audience does
not change. Nobody has created the iOS client yet, and it cannot be created from
this repo. Unanswered.

### Verified 2026-08-18: Capacitor 8 native shell builds and runs

`BUILD SUCCEEDED`, app installed and launched in the simulator, and a probe in the
running app reports the full native surface live:

```
platform: ios   PluginHeaders: 11   WC_NATIVE: true
keys: CapacitorHttp, Console, WebView, CapacitorCookies, SystemBars,
      SocialLogin, NFC, Haptics, App, Camera, PushNotifications
NFC.startScan: function    NFC.writeNDEF: function    SocialLogin: object
```

Two hazards cost most of that time and are now written into `mobile/SETUP.md`:

1. **Dropbox produced 269 conflicted copies inside `node_modules`** despite both
   `.dropboxignore` and the ignore xattr, including a conflicted `.swift` file
   that SPM compiled, giving `Unable to find module dependency: 'IONCameraLib'`.
   That message names a module and reads like a dependency bug; it is Dropbox.
   `mobile/node_modules` is now a symlink to `~/.wildcat-build/`, outside Dropbox.
2. **Capacitor 8 derives SPM product names from the NPM package name** and gets
   `@exxili/capacitor-nfc` wrong, because that plugin declares its library as
   `CapacitorNfc`. `scripts/configure-ios.mjs` now repairs this generically after
   every sync.

### Decision 27 (2026-08-18): the native build is staged OUTSIDE Dropbox

Four escape hatches were tried and all four failed. `xattr com.dropbox.ignored`
on a populated `ios/` made Dropbox delete it into an `ios 2` conflict folder. The
same xattr on an empty `node_modules` before install did not prevent 269
conflicted copies during that install. A committed `.dropboxignore` was ignored.
Replacing `node_modules` with a symlink to a folder outside Dropbox lasted
minutes before Dropbox restored its own directory over the symlink, with 314
conflicted copies in it.

So `mobile/` in the repo now holds SOURCE ONLY: `capacitor.config.ts`,
`package.json`, `scripts/`, `SETUP.md`. `npm run stage` copies those plus the web
portal to `~/.wildcat-build/mobile`, and every native command runs there. A
`.wildcat-repo-root` pointer keeps the staged `sync-web` reading the real portal,
so the app still ships exactly what the website serves.

The reason this matters more than tidiness: the failures are silent and they
impersonate dependency bugs. A conflicted `.swift` file compiles beside the real
one and Swift reports `invalid redeclaration of 'AppPlugin'` or `Unable to find
module dependency: 'IONCameraLib'`. Nobody would look at Dropbox.

`typescript` was added to `mobile/devDependencies`: outside the repo there is no
parent `node_modules` to borrow it from, and the Capacitor CLI needs it to read a
`.ts` config.

### Native student sign-in is written, and waiting on one value

`wildcat-auth.js` now branches: in the app it renders its own Google button and
signs in through `@capgo/capacitor-social-login`, then hands the resulting ID
token to the SAME `finishSignIn` the web flow uses, so `me:get` and the
server-side domain check in `identity.ts` are unchanged. Verified in the
simulator: the red "Failed to load accounts.google.com/gsi/client" is gone and
the button renders.

**Correction to an earlier claim in this file.** It is NOT yet established that
the backend needs no change. `convex/auth.config.ts` pins `applicationID` to a
single `GOOGLE_CLIENT_ID`, and whether the native token's `aud` is the web client
or the iOS client depends on runtime behaviour nobody here has measured. The
sign-in path therefore decodes the returned token and emits
`wildcat-auth-native-token-audience` with `aud`, `azp` and whether it matches the
web client. Read that on the first real device sign-in. If it reports the iOS
client, the fix is a second Google provider entry in `auth.config.ts`, not a
client change.

### RESOLVED 2026-08-18 on real hardware: native student sign-in works

Open question 26 is closed. The iOS OAuth client exists
(`718452352756-9gvjcrk7t7qd8k27d4fpp76qabhvko1r.apps.googleusercontent.com`,
bundle `org.westbrookacademy.wildcat`, same Google project as the web client),
the app is signed and installed on a physical iPhone 17 Pro Max (iOS 26.6.1,
UDID `00008150-001674513408401C`, registered to team SCFGWPBXMF), and a student
signed in through the native flow and **reached the student portal**.

**That last fact settles the audience question, which this file previously left
open and which I had flagged as unproven.** The portal only loads if
`finishSignIn` got a successful `me:get`, and `me:get` only succeeds if Convex
validated the token. Convex pins `applicationID` to a single
`GOOGLE_CLIENT_ID`, so the token's `aud` must have been the WEB client, not the
iOS one. `iOSServerClientId` behaves as documented.

**`convex/auth.config.ts` needs no change.** No second Google provider entry, no
new environment variable. The two-provider model and the server-side domain check
in `identity.ts` stand exactly as they were.

Two supporting details that were needed to get there, both scripted in
`mobile/scripts/configure-ios.mjs` so a fresh clone cannot lose them:

- The **reversed client id URL scheme**
  (`com.googleusercontent.apps.718452352756-9gvjcrk7t7qd8k27d4fpp76qabhvko1r`),
  derived from the client id rather than pasted, so they cannot drift. Without
  it the sign-in sheet opens, the student authenticates, and nothing happens,
  because iOS has nowhere to deliver the result.
- **`CFBundleName` set to "Wildcat Hub".** Capacitor leaves it as
  `$(PRODUCT_NAME)`, and several system prompts use it rather than the display
  name, so the consent sheet read: *"App" Wants to Use "google.com" to Sign In*.
  A child has every reason to distrust that.

Signed entitlements on the installed binary, confirmed with `codesign -d`:
`com.apple.developer.nfc.readersession.formats` = [NDEF, TAG], and
`com.apple.developer.associated-domains` = [applinks:wildcatraffle.com].

### Still unproven: every NFC path, and the tag-opens-app path

NFC has still never actually run. The simulator has no radio, and on device the
functions are present and callable but no tag has been read or written.

Separately, `.well-known/apple-app-site-association` is **still uncommitted**, so
`https://wildcatraffle.com/.well-known/apple-app-site-association` returns 404
and Apple's CDN reports `SWCERR00101 Bad HTTP Response: 404`. Until those files
are on `main`, an iPhone reading a tag opens Safari. After they ship, Apple's CDN
can take up to 24 hours before the first tap works.

### Requirement added 2026-08-18: teachers AND IT program tags, on iPhone too

Stated by the user this session. Programming a tag is not a developer task; it is
something teachers and the IT team do so students have somewhere to check in.
Devices they will actually hold: **iPhone, Android phone, and a desktop with the
ACR122U reader**, all three.

Two of those already worked and needed nothing: Chrome on Android has Web NFC, so
a teacher signs in on wildcatraffle.com as staff and programs from the website;
and the desktop reader path is the natural fit for IT doing a batch. Chromebooks
can never do it, having no NFC radio, which is worth knowing when deciding who
owns the job.

The iPhone could not, and that is the gap this closes. `wildcat-auth.js` built the
Microsoft reply URL from `window.location.origin`, which is `capacitor://localhost`
in the app, so Entra would refuse it and MSAL's redirect could not run anyway.
Staff sign-in was therefore impossible in the app, and the tag programmer is
staff-only, so **the app could not write a tag at all** despite Core NFC write on
iPhone being a headline reason for building it.

Now: `signInStaff()` branches on native and uses the generic OAuth2 provider that
`@capgo/capacitor-social-login` already ships, pointed at Entra's OIDC discovery
document, authorization-code flow with PKCE (a public client, and this repo is
public, so there is no secret and never will be). Same client id and same
`openid profile email` scopes as the web flow, so the token's `aud` is unchanged
and `convex/auth.config.ts` stays untouched.

**Open action, and it is not mine.** The reply URL
`msauth.org.westbrookacademy.wildcat://auth` must be added to the Wildcat Hub app
registration (client `0f22dd11-7c0a-4356-93d7-0abf07642001`, tenant
`afc1d09c-9f9b-4d45-9643-198f7dc264c4`) under Mobile and desktop applications.
The matching `CFBundleURLSchemes` entry is already scripted in
`configure-ios.mjs`. Both halves are required and neither works alone.

## Scope addition 2026-08-26: one iOS app for staff AND students

Directed by the user: "lets make an iOS app of this too so both staff and
students can download; alternatively android can use the url for now. We need
iOS to have access to the NFC functions writing and reading. Students are read
only. Staff can read and write."

### What this changes, and what it does not

- The `mobile/` Capacitor shell (scope addition 2026-08-17) was described as
  the STUDENT app. It never was only that: it wraps `index.html`, which holds
  both sign-ins (Microsoft for staff, Google for students), so one install
  serves both roles. The app is now understood and named as the Wildcat Hub
  app for everyone on iOS. No second app.
- NFC roles need no new gate. Reading (a scan session that resolves a tag to a
  check-in) is the student flow and is what a signed-in student can reach.
  Writing (the tag programmer) lives in the staff portal behind the staff
  session and `tapLocations` mutations are `requireStaff` on the server, so a
  student cannot reach a write path even by hand. The native plugin exposes
  both; the page decides who sees which.
- Android stays on the URL (Chrome has Web NFC for reading; programming from
  Android Chrome already works). The Android project is not built now.

### Decisions

27. The app icon is `assets/app-icon-source.png` (the Westbrook mark on black),
    supplied 2026-08-26. `configure-ios` writes it into the regenerated catalog
    at 1024x1024 with no alpha; nothing is placed in `ios/` by hand.
28. `sync-web` reads the file list off `index.html` rather than keeping one,
    because the hand-kept list had fallen six scripts behind and the staff
    portal would have 404'd inside the bundle.
29. Distribution stays private (TestFlight, then Apple School Manager if the
    school wants managed installs). Public App Store review for a minors app
    is not the plan.

### Open questions

30. TestFlight needs an Apple Distribution certificate; this Mac has only
    Apple Development identities. Xcode can create one from the signed-in
    account; that is a click in Xcode, not a script.
31. Nothing has read or written a physical tag yet, on any platform. The
    first device install is where that gets proven, with one blank NTAG sticker.
