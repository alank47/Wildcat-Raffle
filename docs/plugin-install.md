# Creating the Wildcat Hub PowerSchool plugin

Explicit, in order. Every step says who does it, because roughly half of them
need a PowerSchool admin and cannot be done from this repo.

Read only throughout. Sandbox only. Nothing here touches production.

---

## What a PowerSchool plugin actually is

A zip file with `plugin.xml` at its root. That XML declares two things:

1. An **access request**: the exact list of tables and fields the plugin may
   read. PowerSchool denies everything not on the list.
2. An **OAuth block**: tells PowerSchool to mint a client id and client secret
   for this plugin when an admin enables it.

Optionally the zip carries **PowerQueries**, which are named SQL queries that
run inside PowerSchool. Those live in `queries_root/`. They are how you do a
join or an aggregate without dragging every row across the network.

Our zip has both. It is already built.

---

## Step 1: Publisher contact (DONE)

`powerschool/plugin/plugin.xml` line 26 is set to
`lawrenceb@lapromisefund.org`. PowerSchool shows this to the admin during
install and records it as the owner. Change it only if ownership moves.

---

## Step 2: Decide on fields 7 and 8 before you build (you plus the requester)

The brief flags this and it is cheaper to answer now than after install.

Federal ethnicity (manifest 7) and federal race codes (manifest 8) are in the
access request right now. Before they load anywhere, get a written answer to:

> What decision does a teacher make differently because they can see a
> student's federal ethnicity or race code on this dashboard?

If nobody can name one, delete the RESTRICTED block in `plugin.xml` (it is
commented and contiguous, from `Students.FedEthnicity` through the
`S_CA_STU_ELA_C` fields), delete the two restricted queries in
`wildcathub.named_queries.xml`, and rebuild. Doing that now saves a second
disable and re-enable cycle later.

Record the answer in `docs/field-sourcing.md`.

Note that IEP (12) and 504 (13) are **deliberately not** in the access request.
Their source is unknown. Guessing a table name here produces a plugin that
installs and silently returns nothing, which is worse than a plugin that
visibly lacks the field. Phase 1 resolves them, then they go in at version
1.1.0.

---

## Step 3: Build the zip (you, 10 seconds)

```bash
cd "powerschool/sync"
npm run build:plugin
```

Output: `powerschool/out/wildcat-hub-sync-1.0.4.zip`

The build refuses to produce a zip if any of these are true:

- Any field requests access other than `ViewOnly`
- A client id or secret appears in `plugin.xml`
- `plugin.xml` is not at the archive root
- An em dash appears in a shipped file

The archive root check matters more than it sounds. Zipping the folder rather
than its contents is the most common install failure, and PowerSchool's error
message for it is unhelpful.

---

## Step 4: Verify the zip before handing it over (you, 30 seconds)

```bash
unzip -l powerschool/out/wildcat-hub-sync-1.0.4.zip
```

You want exactly this shape:

```
queries_root/
queries_root/wildcathub.named_queries.xml
plugin.xml
```

`plugin.xml` at the root with no wrapper directory. If you see
`wildcat-hub-sync/plugin.xml`, the zip is wrong.

---

## Step 5: Install into the SANDBOX instance (PowerSchool admin, 5 minutes)

Send the admin the zip and these instructions verbatim.

1. Sign in to the **sandbox or test** PowerSchool instance. Not production.
2. Go to **System > System Settings > Plugin Management Configuration**.
3. Click **Install**.
4. Choose `wildcat-hub-sync-1.0.4.zip` and click **Import**.
5. PowerSchool shows the **access request** screen listing every table and
   field. Review it. Every line should read view only.
6. Approve the access request.
7. Back on the plugin list, tick the **Enable** checkbox for Wildcat Hub Sync.

The plugin does nothing until step 7. Installed and enabled are separate
states and it is easy to stop after step 6.

---

## Step 6: Get the credentials (PowerSchool admin, 2 minutes)

1. On the plugin list, click **Wildcat Hub Sync**.
2. Click **Data Provider Configuration**.
3. PowerSchool shows a **Client ID** and **Client Secret**.

The secret is shown at generation time. If it is lost, it must be regenerated,
which invalidates the old one.

**How the admin should send these to you:** through the secret store, or a
password manager share, or a call. Not email, not Slack, not a ticket comment.
They are equivalent to a read credential over the entire student body.

---

## Step 7: Wire up locally (you, 2 minutes)

```bash
cd "powerschool/sync"
cp .env.example .env
```

Fill in `.env`:

| Variable | Where it comes from |
|---|---|
| `PS_HOST` | Sandbox hostname, no `https://`, no trailing slash |
| `PS_CLIENT_ID` | Already set to a 1Password reference. Leave it |
| `PS_CLIENT_SECRET` | Already set to a 1Password reference. Leave it |
| `PS_SCHOOL_ID` | `Schools.ID` for Westbrook Academy. Ask the admin |
| `PS_YEAR_ID` | PowerSchool year id. The terms query confirms it |

**Secrets are not pasted anywhere.** `.env` holds 1Password references, not
values:

```
PS_CLIENT_ID="op://Employee/WildCats Hub/SIS Client ID"
PS_CLIENT_SECRET="op://Employee/WildCats Hub/SIS Client Secret"
```

`src/config.ts` resolves each reference with `op read` at process start. The
value is held in memory, never written to disk, and never printed. Requires an
`op` session (`op whoami`).

Note it does NOT use `op run --env-file`. That command scans the whole
inherited environment for `op://` references and fails the run if any
unrelated one cannot be resolved. On a machine with other projects' references
already exported, that breaks. Per reference `op read` does not.

If a 1Password service account token is present but cannot reach the vault,
the resolver retries once using the desktop app session.

`.env` is covered by `powerschool/sync/.gitignore`. Confirm that:

```bash
git check-ignore -v powerschool/sync/.env
```

If that prints nothing, stop and fix the gitignore first.

Note: this working copy is not currently a git repository (it is an unpacked
`-main` download), so that command will report "not a git repository" rather
than confirming anything. Re-run it once the work is in a real checkout, and
do not paste a real secret into `.env` in a directory that syncs to Dropbox
without checking whether that is acceptable first. This folder is under
`Dropbox-MyindSound`, which means anything written here syncs to cloud
storage.

---

## Step 8: Prove the plumbing offline (you, 5 seconds)

```bash
npm test
```

No network, no credentials. Verifies the read only guard, the production host
guard, the redaction allowlist, and the manifest. 26 assertions. If any fail,
do not continue.

---

## Step 9: Authenticate (you, 10 seconds)

```bash
npm run auth
```

Expected: a token, a stated expiry, and the server metadata block including
`max_page_size`.

Common failures:

| Symptom | Cause |
|---|---|
| `Refusing to run` | `PS_HOST` has no sandbox marker. This is the guard working. Confirm the host is really not production before overriding |
| Token request failed with 401 | Client id or secret wrong, or the plugin is installed but not enabled |
| Token request failed with 404 | Wrong hostname, or the instance does not expose `/oauth/access_token` |
| `fetch failed` | Hostname does not resolve |

---

## Step 10: Run the Phase 0 probe (you, 1 to 3 minutes)

```bash
npm run probe
```

This asks PowerSchool for one row of one column, once per field in the
manifest. That is an empirical read of what the plugin was actually granted,
rather than a restatement of what we asked for. It pulls no bulk data.

It writes `docs/access-gap.md` with:

- Fields granted
- Fields missing, with the exact `table.field` strings to add to `plugin.xml`
- Fields whose source is still unconfirmed (12, 13, 18)
- Which PowerQueries are installed and callable

**Stop here.** This is the Phase 0 gate.

---

## Step 11: One amendment pass, not three

If `docs/access-gap.md` lists missing fields:

1. Add all of them to `plugin.xml` in one edit.
2. Bump the version attribute on the `<plugin>` element. PowerSchool rejects a
   re-upload at the same version.
3. `npm run build:plugin`
4. The admin must **disable** the plugin, **install** the new zip, **approve**
   the amended access request, and **enable** it again.
5. Re-run `npm run probe`.

Step 4 is why the gate exists. It is a manual admin cycle every time, so
resolve the entire list in one pass.

Existing client id and secret survive a version upgrade. They do not survive a
delete and reinstall.

---

## Step 12: Run the queries (Phase 2)

Only after the gate is cleared.

```bash
npm run queries -- terms
```

That returns every term for the school year with `first_day` and `last_day`.
Use it to fill in `PS_TERM_ID` and `PS_YEAR_TERM_ID` in `.env`, plus
`PS_FINAL_GRADE_NAME` and `PS_STORE_CODE` for the current reporting term.

Then:

```bash
npm run queries
```

Runs all seven queries. Per query it reports row count, page count, elapsed
time, targeted assertions, and one redacted sample payload.

---

## The queries and what they cover

| Short name | Query | Manifest fields |
|---|---|---|
| `terms` | `com.lapromisefund.wildcathub.terms` | calendar helper |
| `roster` | `...wildcathub.roster` | 1, 2, 3, 4, 5, 6, 9 |
| `attendance` | `...wildcathub.attendance_summary` | 10 |
| `grades` | `...wildcathub.grades` | 11 |
| `staff` | `...wildcathub.staff` | 15, 16, 17, 18 |
| `race` | `...wildcathub.student_race_restricted` | 8 |
| `restricted` | `...wildcathub.student_restricted` | 7, 14 |

Restricted fields are in their own queries so they can be deleted as a unit,
tested separately in Phase 5, and loaded into separate staging tables.

---

## Things that will bite you

**Attendance presence codes.** `attendance_summary` maps
`Presence_Status_CD` values `Absent` to 1 and `Half_Day_Absent` to 0.5. If
this instance uses different values, the totals will be silently wrong rather
than erroring. Check the distinct values before trusting any number:

```bash
npm run queries -- attendance
```

then reconcile against the SIS attendance report for the same term. This is
manifest field 10 and it is the field most likely to look right and be wrong.

**The Teachers to Users join.** `Sections.Teacher` points at `Teachers.ID`, but
staff email lives on `Users.Email_Addr`. The bridge is `Teachers.Users_DCID`
to `Users.DCID`. This holds on current PowerSchool versions and should be
confirmed on this instance rather than assumed. If `roster` returns rows with
a teacher name but no teacher email, this join is the reason.

**Null percent is not zero.** `grades` returns `grade_source` of `NONE` when
neither `PGFinalGrades` nor `StoredGrades` has a row. That must reach the UI
as "not available". A student with no gradebook percent must never appear to
have 0%.

**Multi race students.** The race query returns one row per code on purpose.
Anything downstream that keys on `student_id` alone will silently keep the
first code and drop the rest.

**Page size.** PowerSchool enforces its own maximum. `npm run auth` prints it
and warns if `PS_PAGE_SIZE` exceeds it. Exceeding it truncates rather than
erroring.

---

## Version history

| Version | Change |
|---|---|
| 1.0.0 | Initial access request. Rejected by PowerSchool validation. The PowerQuery file declared a namespace on its root element, and SECTIONMEETING, STOREDGRADES.ID and USERS.ID are invalid in this instance |
| 1.0.1 | Fixed the PowerQuery schema (no namespace, real TABLE.COLUMN references, no summary or args elements). Removed SECTIONMEETING, PERIOD and CYCLE_DAY. STOREDGRADES.ID becomes DCID. USERS.ID removed. 105 fields, all ViewOnly |

### What the 1.0.0 rejection taught us

Two separate classes of error, both worth remembering.

**PowerQuery schema.** The root element is `<queries>` with no namespace and
no `xsi:schemaLocation`. Adding the Pearson namespace produces "Cannot find
the declaration of element 'queries'". There is no `<summary>` element and no
`<args>` element. Each `<column column="TABLE.COLUMN">alias</column>` must
name a real granted table and column, and the count must match the SQL output
exactly. For a computed column, point the attribute at `STUDENTS.ID` and let
the alias carry the real name.

**Invalid tables and columns.** PowerSchool validates the access request
against the actual schema of the instance:

| Requested | Verdict | Resolution |
|---|---|---|
| `SECTIONMEETING.*` | Invalid Table | Removed. Period now parses from `SECTIONS.EXPRESSION` and `CC.EXPRESSION` |
| `PERIOD.*`, `CYCLE_DAY.*` | Valid, but orphaned | Removed. With SECTIONMEETING gone there is no join path, and unusable granted access is unnecessary exposure |
| `STOREDGRADES.ID` | Invalid Column | Changed to `STOREDGRADES.DCID` |
| `USERS.ID` | Invalid Column | Removed. `USERS.DCID` is the key |

---

## Open blockers

These are not code problems and cannot be resolved from this repo.

1. **No sandbox hostname supplied.** The brief has `[TEST/SANDBOX HOSTNAME]`
   unfilled. Everything from step 5 onward is blocked on it. If no sandbox
   instance exists, that is a stop and escalate, not a workaround.
2. **Credentials are in place.** `op://Employee/WildCats Hub/SIS Client ID`
   and `.../SIS Client Secret` both resolve. Nothing else is needed here.
3. **Warehouse mismatch.** The brief specifies Supabase with a `staging`
   schema and row level security. This app currently runs on Firebase
   (`script.js`, project `wildcat-hub-94025`). Phase 3 needs a decision:
   stand up Supabase alongside Firebase, or restate Phase 3 and 5 in Firestore
   security rules. The access control requirements in Phase 5 are expressible
   in both, but the migration file requirement in Phase 3 point 5 assumes
   Postgres.
4. **Fields 12 and 13 unsourced.** See `docs/field-sourcing.md`.
5. **Field 5 (Period) has no structured source.** SECTIONMEETING is invalid in
   this instance. Period must be parsed from the expression strings. Ask the
   SIS admin whether a section meeting table exists under another name before
   committing to a parser.
