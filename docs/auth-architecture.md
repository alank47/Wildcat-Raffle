# Auth architecture: Entra ID for staff, Google Workspace for students

Status: design, not yet implemented. Written 2026-08-11.

Supersedes the line in `Grilled.md` that says auth is Google sign in keyed on
`@lapromisefund.org`. Staff move to Microsoft Entra ID (O365). Students move to
Google Workspace on `westbrookacademy.org`. **Email is the identity key on both
sides**, and it is what links a signed in person to their record.

## What this replaces

Both current paths are unauthenticated in practice.

| Who | Today | Problem |
|---|---|---|
| Staff | `username` + `password` compared in JS against a Firestore doc | Passwords are stored and compared in cleartext. `login()` does `teachers.find(t => t.username === username && t.password === password)` in the browser. |
| Students | Types a student ID **or just a name** | `studentLogin()` matches on `firstName`, `lastName`, or full name. Typing "John Smith" makes you John Smith. There is no credential at all. |

Neither can be fixed by hardening the form. The credential has to come from an
identity provider the school already controls.

## Target design

One identity layer, two providers, because the app is a static site on GitHub
Pages with no server to run a session on:

```
Staff    --> Microsoft Entra ID (OIDC)  --\
                                            >-- Firebase Auth --> ID token
Students --> Google Workspace (OIDC)     --/                       |
                                                                   v
                                              Firestore rules read token.email
                                                                   |
                                                                   v
                                          record lookup joins on normalized email
```

Firebase Auth is already a dependency (`firebase-auth.js` ships today for the
anonymous sign in floor), it supports both providers natively, and it produces
the `request.auth.token.email` claim that `firestore.rules` is already written
to consume. No new backend.

### Provider to role mapping

Role is derived from **which provider issued the token plus the email domain**,
never from a field the client can set:

| Provider | Domain | Role |
|---|---|---|
| `microsoft.com` | staff domain (from PowerSchool `users.email_addr`) | staff, then admin/superadmin by record |
| `google.com` | `westbrookacademy.org` | student |

A Google token from the staff domain, or a Microsoft token from the student
domain, is rejected. Mixing them is how a student ends up with a teacher's
ticket-awarding rights.

### The email is the join key

- **Staff:** PowerSchool manifest field 17 (`USERS.EMAIL_ADDR`, exposed as
  `teacher_email`) is already in the access request and already flows through
  the sync harness. The Entra `email` claim joins directly to it. No new field.
- **Students:** nothing to join to. See the blocker below.

### Email normalization is mandatory on both sides

Entra ID issues the email claim with the casing stored in the directory, which
is frequently `First.Last@domain` while the record holds `first.last@domain`.
An exact string compare then fails and the user is bounced to the login screen
with no error. This exact bug cost real debugging time on the Overwatch console
for this same organization.

Every comparison goes through one function, applied on **both** sides of the
compare, at write time and at read time:

```js
const normalizeEmail = e => (e || '').trim().toLowerCase();
```

Firestore rules compare against the stored normalized value, and the rules use
`.lower()` on the token claim so the two can never drift.

## BLOCKER: students have no email anywhere

Google sign in will return `student@westbrookacademy.org`. There is currently
nothing on either side to match it to:

1. The app's student records have no `email` field. Confirmed by inspection.
2. The 18 field PowerSchool manifest has **Staff Email** (field 17) and no
   student email. Field 1 is Student ID / SSID, field 2 is First / Last Name.

So the student half of this goal cannot be completed by writing app code. It
needs a new manifest field, which means amending the plugin access request and
getting it re-approved by a PowerSchool admin. `Grilled.md` constraint 4 says
manifest fields are not added opportunistically, so this is recorded as a
deliberate scope change rather than a quiet addition.

**Proposed field 19: Student Email.** Probe order, most to least likely:

| Table | Column | Notes |
|---|---|---|
| `students` | `student_email` | Most common in CA districts |
| `students` | `email` | Older installs |
| `u_studentsuserfields` | `student_email` | Custom field, install specific |
| `studentcorefields` | `student_email` | Extension table |

Until that lands, students cannot be authenticated by email. Two interim
options, neither of which should be confused with a fix:

- **Recommended: leave student sign in disabled.** Ship staff Entra auth,
  which is unblocked and closes the cleartext password hole, and turn on
  student sign in when field 19 is approved and synced. The current
  name-matching path is removed either way; it is not a login.
- Fallback if students must have access before then: derive the address from
  first/last name (`first.last@westbrookacademy.org`) and verify the derived
  address actually exists in Google Workspace before trusting it. This breaks
  on duplicate names, hyphenated names, and preferred names. Treat as
  temporary.

## Firestore rules after this lands

The rule swap already stubbed in `firestore.rules` becomes two clauses:

```
allow read, write: if request.auth != null
  && request.auth.token.email_verified == true
  && (
       request.auth.token.firebase.sign_in_provider == 'microsoft.com'
         && request.auth.token.email.lower().matches('.*@STAFF_DOMAIN$')
    || request.auth.token.firebase.sign_in_provider == 'google.com'
         && request.auth.token.email.lower().matches('.*@westbrookacademy[.]org$')
     );
```

Students must not keep write access to `raffle_data`; they read their own
totals. Splitting student reads from staff writes is a follow up once the
collection is split by document, and is not attempted in the same change as
the provider swap.

### Deploy order, again

Same trap as the anonymous auth floor, one step larger. Rules that require a
verified domain claim deny everything until the sign in path issuing that claim
is live AND both providers are enabled in Firebase Console. Order:

1. Enable Microsoft and Google providers in Firebase Console.
2. Ship the sign in code.
3. Confirm `window.wildcatAuthReady === true` and that a real staff account
   gets a `microsoft.com` token with the expected email claim.
4. Only then deploy rules.

## Cleartext passwords

This change removes the reason the `password` field exists. It does not delete
the data. Once staff sign in no longer reads it, the field must be deleted from
every teacher record in `raffle_data`, because it is still a live exposure
until it is gone. Tracked in the local `docs/firestore-lockdown.md`.

## Compliance note, not legal advice

Student records plus authentication in a K-12 context puts this in FERPA
territory, and the roster data carries restricted fields (IEP, 504, English
Learner, federal race and ethnicity) that are already isolated in their own
PowerQueries. Two constraints follow directly:

- Restricted fields must never be readable by a student token, only by staff
  with an explicit need. The current single `raffle_data` collection cannot
  express that, which is another reason to split the collection.
- Google Workspace and Entra ID are both already school controlled, so no new
  vendor enters the protected data path with this change. Adding one later
  (analytics, an email service that receives student addresses) needs its own
  review before it is wired in.

## Open questions

1. **Staff email domain.** `Grilled.md` says `@lapromisefund.org`; the GAM
   tooling for this org uses `laspromise.org`. Do not hardcode a guess. The
   staff domain is read from the PowerSchool `teacher_email` values, and the
   constant is set once from real data.
2. **Are students actually licensed in Google Workspace?** The goal says Google
   admin for `westbrookacademy.org`. Field 19 is pointless if student accounts
   do not exist yet or are not issued to every grade level.
3. **Do staff sign in with the same address PowerSchool holds?** Entra UPN and
   the PowerSchool `email_addr` are frequently different, especially where a
   district migrated domains. If they diverge, the join needs an alias map and
   that is a schema change.
4. **Students who change name or email.** The email is the join key, so a
   changed address orphans a record unless the PowerSchool sync is the
   authority and re-links on student ID.
