# SIS coverage

What the PowerSchool reference says is reachable, versus what Wildcat Hub
actually consumes. Hand written from a read of `powerschool/plugin/plugin.xml`,
`powerschool/plugin/queries_root/wildcathub.named_queries.xml`,
`powerschool/sync/src/`, and `convex/ps*.ts` / `convex/sis*.ts` on 2026-08-11.

Companion to `docs/access-gap.md`, which is machine generated and answers a
narrower question: "did the fields we asked for get granted?" This file answers
"how much of the SIS did we ask for in the first place?"

---

## The number

**9 of 52 capability units. 17 percent.**

Harsher and more useful: **4 of 52, 8 percent**, is what the twice daily
production sync actually exercises. The other 5 are probe-only or build-time.

Two framings that make the number look better, both stated so nobody has to
reconstruct them:

| Framing | Number | Why it is a fairer or less fair read |
|---|---|---|
| All capability units the reference names | 9 / 52 = **17%** | The headline. Includes write paths we must never use. |
| Excluding the 8 write paths | 9 / 44 = **20%** | Fair: 0 writes is a safety property, not a shortfall. |
| Excluding writes, SSO, and third party PII tables | 9 / 35 = **26%** | The ceiling if we only ever build what this product needs. |
| Exercised by the scheduled sync | 4 / 52 = **8%** | What runs unattended twice a day. |

### Why not "15 of 19 manifest fields"

Because that denominator was written by us. The manifest is a list of 19 fields
somebody wanted; scoring against it measures whether we got what we asked for,
not whether we asked for enough. The reference names 14 tables holding the
school's official behavior record and the manifest does not mention a single
one of them. A 79 percent score against a 19 item wish list, next to 0 percent
against the behavior surface, is the shape of the problem.

### The denominator, itemized

52 distinct capability units, deduplicated from the reference's 43 entries
(the reference lists LOG, GEN, the incident tables, `/ws/schema/table`, the
named query endpoint, the token endpoint and the access request twice each).

| Group | Units | Consumed |
|---|---:|---:|
| A. Behavior and discipline data surface | 14 | **0** |
| B. Read endpoints and their parameters | 13 | 4 |
| C. Write paths | 8 | **0**, by design |
| D. Plugin manifest mechanisms | 17 | 5 |
| **Total** | **52** | **9** |

Excluded from the denominator because the reference itself rules them out:
LOG2 and LOGINS (name collision only, no student behavior), and
developer.powerschool.com (not readable).

---

## A. Behavior and discipline: 0 of 14

This is the finding. Everything else on this page is detail.

| Table | In plugin.xml | In any PowerQuery | Reaches Convex |
|---|---|---|---|
| LOG | no | no | no |
| GEN (Cat='logtype' / 'subtype' / 'consequence') | no | no | no |
| INCIDENT | no | no | no |
| INCIDENT_PERSON_ROLE | no | no | no |
| INCIDENT_LU_CODE | no | no | no |
| INCIDENT_LU_SUB_CODE | no | no | no |
| INCIDENT_DETAIL | no | no | no |
| INCIDENT_PERSON_DETAIL | no | no | no |
| INCIDENT_ACTION | no | no | no |
| INCIDENT_OBJECT | no | no | no |
| INCIDENT_OBJECT_PERSON | no | no | no |
| INCIDENT_OTHER_PERSON | no | no | no |
| INCIDENT_SECURITY_GROUP | no | no | no |
| INCIDENT_CHANGE_RSN_DESC | no | no | no |

Zero of 107 granted fields belong to any of these tables. Not denied. Never
requested.

### And the app runs a full behavior system anyway

`script.js` carries a complete parallel behavior economy that has no connection
to the SIS in either direction:

- `wildcatCashBehaviors`, 8 core behaviors at plus or minus 100 points
  (Be Present, Be Respectful, Be Responsible, Be Safe, and their negatives),
  extensible by staff
- `behaviorReferrals` with `referralIdCounter`, referral date and time
- `detentions` with `detentionLocations` and 8 `detentionReasons`
  (Disrupting Class, Tardiness, Dress Code Violation, Defiance/Disrespect,
  Cell Phone Violation, and so on)
- `hallPasses` / ClawPass with a hall monitor and bell schedule
- a `disciplineModeEnabled` toggle with its own UI

`convex/schema.ts` parks all of it in `legacyMirror` as verbatim payload,
explicitly deferring the decision on shape.

So Westbrook has two behavior records. PowerSchool's is the one that follows a
child through the district and feeds state reporting. Wildcat Hub's is the one
teachers touch every day. Neither knows the other exists, and because the write
path is closed (correctly, see section C) they will diverge permanently.

Reading LOG does not merge them. It does let one screen show both, which is the
difference between a teacher checking two systems and a teacher checking one.

---

## B. Read endpoints: 4 of 13

| Endpoint or parameter set | Consumed | Where |
|---|---|---|
| `POST /oauth/access_token` | **yes** | `client.ts:92`, `sisAction.ts:57` |
| `POST /ws/schema/query/{name}` | **yes** | `client.ts:283`, `sisAction.ts:69`, all 7 queries |
| `GET /ws/v1/metadata` | **yes**, probe only | `client.ts:259` |
| `GET /ws/schema/table/{table}` | **partial**, probe only | `probe.ts:57`, `client.ts:267` |
| `GET /ws/schema/table/{table}/{id}` (pk) | no | |
| `GET /ws/schema/table/{table}/count` | no | |
| `GET /ws/v1/student/{id}` and district/school variants | no | |
| `GET /ws/v1/staff/{id}` | no | |
| `GET /ws/v1/school/{id}/course` and `/section` | no | |
| `GET /ws/contacts/contact/{id}` | no | |
| `/ws/v1` expansions (12 named) | **0 of 12** | |
| `/ws/v1` extensions (`s_*_x`, `u_*`, `studentcorefields`) | no | |
| PowerQuery DAT / Data Export Manager delivery | no | |

Notes that matter:

- The table endpoint is used **only** by `probe.ts`, and only with `projection`
  and `pagesize`. `q` (FIQL filtering), `sort`, `sortdescending` and `count` are
  never sent. The production sync never touches this endpoint at all.
- The 12 `/ws/v1` student expansions are entirely unexplored. One of them,
  `alerts`, is where PowerSchool's **discipline alert** lives per the reference,
  which means there may be a behavior signal reachable without LOG. Untested.
- The `lunch` and `fees` expansions are also unconsumed. Deliberately not ranked
  as a gap below: cafeteria balances do nothing for this product.

---

## C. Write paths: 0 of 8, and that is the correct number

| Write path | State |
|---|---|
| `POST /ws/schema/table/{table}` | blocked |
| `PUT /ws/schema/table/{table}/{id}` | blocked |
| `DELETE /ws/schema/table/{table}/{id}` | blocked |
| `PATCH /ws/schema/table/{table}/{id}` | blocked (and unverified as supported) |
| `POST /ws/v1/{resource}` INSERT envelope | blocked |
| `PUT /ws/v1/{resource}/{id}` UPDATE envelope | blocked |
| `DELETE /ws/v1/{resource}/{id}` | blocked |
| `access="FullAccess"` on any column | never declared |

Blocked at three independent layers, verified by reading the code and the
granted access request rather than by attempting a verb:

1. **plugin.xml**: 107 `<field>` elements, `access="ViewOnly"` on all 107. The
   XSD enum has exactly two values and `FullAccess` appears zero times. Nothing
   can be written because nothing was granted.
2. **`client.ts:161-168`**: the single network chokepoint throws
   `ReadOnlyViolation` on any verb other than GET, and on any POST whose path
   does not start with `/ws/schema/query/`.
3. **`sisAction.ts`**: the scheduled action has exactly two fetch call sites,
   the token request and the named query POST. No third exists.

Per the reference, PowerQuery SQL "only allows SELECT (or WITH . . . SELECT);
read only", so the one permitted POST is structurally incapable of mutation.

**This 0 is counted against us in the headline anyway.** It should not be
raised. It is the property that keeps 6,616,500 in Wildcat Cash out of a system
that never generated it.

---

## D. Plugin manifest mechanisms: 5 of 17

| Mechanism | Consumed |
|---|---|
| `<oauth/>` | **yes** |
| `access_request` with `ViewOnly` | **yes**, 107 fields, 16 tables |
| `queries_root/*.named_queries.xml` | **yes**, 7 queries |
| `<publisher>` | **yes** |
| Plugin zip root layout | **yes**, `scripts/build-plugin.mjs` |
| `access_request` with `FullAccess` | no, by design |
| `user_schema_root/` (a U_ table the plugin owns) | no |
| `permissions_root/*.permission_mappings.xml` | no |
| `web_root/` page customizations | no |
| `<links>` / `<ui_contexts>` | no |
| `<openid>` | no |
| `<saml>` incl. `inline_authentication` | no |
| `<registration>` | no |
| `<autoinstall>` | no |
| `<identityAttribute>` | no |
| Data Access Requests review screen (admin grant verification) | no |
| Regenerate Client ID and Secret | no, correctly (breaks the sync) |

---

## Inside our own 107 field grant

Coverage is not just narrow against the reference. It is loose against itself.

**16 tables granted. 11 read by the scheduled sync.**

| Table | Fields granted | Read by the cron | Note |
|---|---:|---|---|
| Students | 15 | yes | |
| CC | 9 | yes | |
| Courses | 4 | yes | |
| Sections | 8 | yes | |
| Teachers | 8 | yes | via PowerQuery only, table endpoint 405s |
| Users | 5 | yes | only `Email_Addr` reaches the sync |
| Attendance | 9 | yes | |
| Attendance_Code | 6 | yes | |
| PGFinalGrades | 7 | yes | |
| StoredGrades | 9 | yes | |
| Terms | 9 | yes | |
| SchoolStaff | 6 | **no** | `staff` query exists, sync never calls it |
| StudentRace | 3 | **no** | restricted, deliberately gated |
| S_CA_STU_X | 2 | **no** | restricted, deliberately gated |
| S_CA_STU_ELA_C | 3 | **no** | restricted, deliberately gated |
| Schools | 4 | **no** | selected by no SQL anywhere |

**28 of 107 granted columns land in a Convex row.** The rest are join keys,
filters, or unused.

**6 granted columns appear in no query at all:**
`Students.EntryDate`, `Students.ExitDate`, `CC.DateEnrolled`,
`Attendance.CCID`, `Attendance.PeriodID`, `S_CA_STU_ELA_C.ELAStatusStartDate`.

**3 of 7 PowerQueries are called by production.** `roster`,
`attendance_summary`, `grades` run twice daily. `staff` and `terms` are called
only by `probe.ts` and the manual `run-queries` diagnostic. The two restricted
queries are gated on purpose.

**`psRestricted` is dead shape.** Defined in `convex/schema.ts:226`, no writer,
no reader, referenced nowhere else in the codebase.

---

## Gaps, ranked by value to a teacher and student dashboard

Ranking rule, from the brief: behavior beats cafeteria balances. Where two gaps
unlock the same thing, the cheaper one ranks higher.

### 1. LOG and GEN read, the SIS behavior record. HIGH value, MEDIUM effort

**What it unlocks.** The school's official behavior log: Entry_Date,
Entry_Time, Entry_Author, LogType, Subtype, Consequence, Subject, Entry, keyed
to `LOG.StudentID` which is the same `STUDENTS.ID` the roster PowerQuery
already joins on. That is a per student behavior timeline the teacher dashboard
currently cannot show at all, and it is the closest thing PowerSchool has to
the positive-and-negative model the app already runs.

**Why it matters most.** The app has behaviors, referrals and detentions, and
knows nothing about the record the district considers authoritative. A teacher
awarding a Wildcat Cash deduction for defiance has no idea whether that student
already has three log entries this week.

**Blocked by.** LOG and GEN are absent from `plugin.xml`. Needs new `<field>`
lines, a version bump to 1.1.0, a re-upload, and a PowerSchool admin disabling
and re-enabling the plugin. All `ViewOnly`.

**Two constraints the reference is explicit about.** Nothing states that
PowerSchool exposes LOG over `/ws/schema/table`, so plan the read as a
PowerQuery joining LOG to GEN, the same shape the existing queries use. And
`LOG.LogTypeID` values are arbitrary district-defined integers with no default
set, so the query must map by `GEN.Name` where `GEN.Cat = 'logtype'` and never
hardcode an id.

**Open question a probe cannot answer yet.** Whether LOG is actually populated
at Westbrook. The 34 `Discipline_*` columns are marked "no longer used" in the
5.2 dictionary while current admin docs still list them as configurable, so
which are live here is empirical. Ask the SIS admin before requesting all 40
plus columns; request the 8 fixed-label fields first.

### 2. Wire the `staff` query into the sync. HIGH value, SMALL effort

**What it unlocks.** Authoritative staff identity. Manifest fields 15 through
18 are granted, and the `staff` PowerQuery is installed and returning 81 rows
on page 1 per `docs/access-gap.md`.

**The problem.** No sync path calls it. Not `sisAction.ts`, not
`sync-to-app.ts`. The Convex `teachers` table, which `convex/identity.ts:53`
reads to authorize every staff sign-in, is populated by `convex/seed.ts` from
the legacy Firestore import. Staff email, the Entra join key, is legacy data.

**Consequence today.** A teacher hired this August cannot sign in until a human
hand-adds them, even though PowerSchool has known about them since their first
day and the query to fetch them is already live and granted.

**Blocked by.** Nothing. Pure omission. This is the cheapest real win on the
page.

**Caveat to carry into the build.** `role_hint` is named a hint on purpose: it
is derived from whether a person teaches any section, so a dean who teaches one
section reads as a teacher. Role still has to come from Entra group membership.
Use the query for identity and roster linkage, not for authorization.

### 3. Wire the `terms` query into the sync. MEDIUM-HIGH value, SMALL effort

**What it unlocks.** Term resolution at run time. The `terms` query exists
specifically so that, in the named queries file's own words, "no query
hardcodes a term id."

**The problem.** Production hardcodes four constants as Convex environment
variables: `PS_TERM_ID`, `PS_YEAR_TERM_ID`, `PS_FINAL_GRADE_NAME`,
`PS_STORE_CODE` (`sisAction.ts:110-115, 194-195`).

**Failure mode.** Silent, not loud. When a term rolls over, the roster query
still returns rows, they are just the previous term's rows. `docs/runbook.md`
line 107 already documents this as a manual fix. The query that would remove
the manual step is installed and never called.

**Blocked by.** Nothing.

### 4. A working student identity key. HIGH value, MEDIUM effort

**What it unlocks.** The entire student half of the product. Without a key
linking a Google Workspace account to a student record, no student can sign in,
so the student dashboard cannot exist.

**Where it stands.** Manifest field 19 is the wrong source and this is settled:
`student_email` is absent from this instance, not denied, and 0 of 3805 roster
rows carry one. The on-disk roster query still selects `S.STUDENT_EMAIL` and
`sync-to-app.ts:83` correctly drops the always-null result.

**The unexplored lead, straight out of `docs/access-gap.md`.** Two probes
returned **403 "At least one column lacks sufficient permission"** on
`studentsdcid`, not 404 table-not-found:

- `u_studentsuserfields.studentsdcid` 403
- `studentcorefields.studentsdcid` 403

A 403 on the key column means **those tables exist in this instance and were
simply never requested.** Only the guessed column name `student_email` returned
400. Nobody has asked what columns those two tables actually carry.

**Next action.** Ask the SIS admin to list the columns on `U_StudentsUserFields`
and `StudentCoreFields`, and separately confirm what address Google Workspace
issues on westbrookacademy.org. The reference also names `contact_info` as a
`/ws/v1/student` expansion, which is a third untried path.

**Blocked by.** A plugin version bump once a real column name is known, plus
one conversation.

### 5. Per section absence detail. MEDIUM value, SMALL effort

**What it unlocks.** Attendance a teacher can act on. `attendance_summary`
counts `COUNT(DISTINCT ATT_DATE)` because this school records attendance per
period, and its own comment states the consequence: "a student who misses a
single period reads as one day absent."

**Why it is cheap.** `Attendance.CCID` and `Attendance.PeriodID` are
**already granted** and used by nothing. A per section absence count is a new
PowerQuery over columns we already hold. No plugin version bump. No admin
re-approval.

**Blocked by.** Nothing.

### 6. `/ws/v1/student?expansions=alerts`, the discipline alert. MEDIUM value, SMALL effort to test

**What it unlocks.** Possibly a behavior signal without touching LOG at all.
The reference flags that PowerSchool's discipline alert is a student level
alert exposed as a `/ws/v1` expansion rather than a LOG row.

**Status.** Unverified. It is a GET, so it is cheap and safe to probe.

**Handle with care.** An alert is exactly the kind of flag that must never
reach the student view. If it works it is staff only, and it belongs behind the
same allowlist discipline as `convex/views.ts`, not in `psRoster`.

### 7. Enrollment dates. LOW-MEDIUM value, SMALL effort

**What it unlocks.** Correct denominators. `Students.EntryDate`,
`Students.ExitDate` and `CC.DateEnrolled` are granted, in no query, and reach
nothing. Without them a student enrolled three weeks ago is compared against a
full term, and a mid-year transfer's attendance rate is wrong in the student's
disfavor.

**Blocked by.** Nothing.

### 8. Close `psRestricted`. LOW value, SMALL effort. Not a gap to fill

Defined in schema, no writer, no reader. Either delete it or leave a comment
saying it is a parked shape pending the go/no-go in `docs/go-no-go.md` line 5.
A table that exists but is never written invites someone to assume it holds
data.

### 9. The INCIDENT family. MEDIUM value, LARGE effort. Deliberately ranked below LOG

**What it unlocks.** The heavyweight discipline model with severity weighting
(`INCIDENT_LU_SUB_CODE.SEVERITY` is the one numeric field in the whole
discipline surface) and suspension durations.

**Why it ranks here.** Pinning one coded behavior on one student needs a four
table join minimum (`INCIDENT_PERSON_ROLE` to `INCIDENT_PERSON_DETAIL` to
`INCIDENT_DETAIL` to `INCIDENT_LU_CODE where CODE_TYPE='behaviorcode'`), plus
`INCIDENT_LU_SUB_CODE` for names. Per the reference, incidents are
administrator only, take "several minutes to much longer" to file, and are the
state discipline reporting source. LOG is where the day to day teacher behavior
actually lives. LOG gets most of the value for a fraction of the work.

**Hard exclusions if this is ever built.** `INCIDENT_OTHER_PERSON` holds third
party PII and must never leave the SIS. `IS_STATE_REPORTABLE_FLG` and
`RESTRICTED` mark rows a student facing app must not surface.
`INCIDENT_SECURITY_GROUP` exists precisely because some incident types are
hidden from most staff, and any query must honor it.

### 10. A plugin owned U_ table. Named only to rule it out

The reference is right that `user_schema_root` is the only write target a third
party can create from scratch, and it is the only place app owned data could
live in the SIS. **Do not build it for Wildcat Cash.** 6,616,500 of earned value
has no SIS counterpart; mirroring it creates a second authority for a number
PowerSchool never generated, and the reference says so itself. Recorded here so
the next person does not have to rediscover why it was declined.

### Explicitly not ranked

`/ws/v1` `lunch` and `fees` expansions, `/ws/contacts`, Data Export Manager
scheduling, `web_root` page customizations, `<saml>` / `<openid>` (auth already
runs through Entra and Google), and every write verb.

---

## Two housekeeping notes found while counting

1. **Field count.** This file counts **107** `<field>` elements in
   `plugin.xml`, all `ViewOnly`. The project brief and prior docs say 108. The
   difference is one element, not a class of access. Worth reconciling before
   the next version bump so the re-approval request states a true number.

2. **Working tree drifts from installed 1.0.6 by one character.** The shipped
   `powerschool/out/wildcat-hub-sync-1.0.6.zip` carries
   `<contact email="lawrencb@lapromisefund.org"/>`; the working tree has
   `lawrenceb@`. The queries file is byte identical. So the plugin currently
   installed as 1.0.6 is not the 1.0.6 on disk. Harmless today (publisher
   contact only), but it means "1.0.6" no longer identifies one artifact. Fold
   the fix into the next version bump rather than re-uploading 1.0.6.
