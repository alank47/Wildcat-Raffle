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
