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

- Writing anything back to PowerSchool
- Pulling production student records
- Loading data anywhere before the Phase 0 gate is cleared
- Adding manifest fields opportunistically

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
9. **Student email is not in the manifest.** The 18 field manifest has Staff
   Email (17) and no student email, and app student records have no email
   field. Google sign in returns an address with nothing to join it to, so
   student auth is blocked on a **new field 19, Student Email**, which amends
   the access request and needs PowerSchool admin re-approval. Deliberate scope
   change, recorded here rather than added quietly against constraint 4.
10. **Staff email domain is unconfirmed.** This doc says `@lapromisefund.org`,
   the org's GAM tooling uses `laspromise.org`, and students are on
   `westbrookacademy.org`. The staff domain constant is set from real
   PowerSchool `teacher_email` values, never guessed.
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
