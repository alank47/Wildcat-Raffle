# Behavior sourcing

Where Westbrook's official behavior record lives in PowerSchool, what Wildcat
Hub is allowed to read of it today (nothing), and the exact change that would
let it read the part worth reading.

Companion to `docs/field-sourcing.md`, which does the same job for the 19 field
manifest. Behavior was never in that manifest, which is why none of it is
granted.

## Read this before anything else: what is NOT here

**Zero bytes of behavior data are in Convex, and none will land until a SIS
admin grants `Log` and `Gen`.** Everything below is a design, two queries that
cannot execute yet, and an exact ordered handoff.

**The brief asked for a table of the log entry types this school actually uses,
read from the instance rather than assumed. That table is empty at the bottom of
this document and it is UNMEETABLE before the grant, not merely unfinished.**
Every path to it is closed by the same missing grant. What was actually
measured, and nothing beyond it:

- `GET /ws/schema/table/gen?projection=id` answers
  `403 {"errors":[{"code":"NoAccess","field":"id","resource":"Gen"}]}`. No
  column of `Gen` can be read, so the type names cannot be listed.
- `GET /ws/schema/table/log/count?q=schoolid==1817` answers `403 NoAccess` on
  `SchoolID`. A filtered count needs a granted column and `Log` has none, so
  the counts cannot be split by school, and by the same rule not by type.
- The `behavior_types` PowerQuery would answer both questions in one call and
  cannot run: it is not installed, and installing it before the grant is the
  packaging hazard below.

Not measured, and therefore not claimed: no probe was issued that returns a 403
naming `LogTypeID` specifically. `q=logtypeid=ge=2020-01-01` answers `400
"Invalid number '2020-01-01' passed for comparison to number field LogTypeID"`,
which proves the column exists and is numeric and says nothing about permission,
because the value type is checked first.

What IS known without a grant is which of PowerSchool's two behavior models this
district uses, because the unfiltered count endpoint answers ungranted: `LOG`
holds 16987 rows and `INCIDENT` holds 13. That is the one load bearing premise,
and it was measured rather than assumed. It is not the type table.

**After the grant, five things stand between it and a behavior row on a screen,
and three of them are in files this change was not permitted to edit**
(`convex/schema.ts`, `convex/sisAction.ts`, `convex/studentDetail.ts`). They are
written out exactly, in order, under "Proposed diffs" below. The plugin grant is
not the last mile.

## The headline

Westbrook runs two behavior records that do not know about each other.

- PowerSchool holds the official one: log entries in `LOG`, classified by
  district defined types in `GEN`, plus the heavier Incident Management module
  in twelve `INCIDENT_*` tables.
- `script.js` runs a parallel one: eight core behaviors at plus or minus 100
  points, `behaviorReferrals`, `detentions`, `hallPasses`, a discipline mode.
  `convex/schema.ts` parks all of it verbatim in `legacyMirror`.

Wildcat Hub reads zero of PowerSchool's fourteen behavior tables, has zero of
them in `plugin.xml`, and names zero of them in any PowerQuery. A teacher
deducting Wildcat Cash for defiance right now cannot see that the same student
already has three log entries this week, or that the child was serving a
suspension that day. Because the write path is correctly closed, the two
records will keep diverging, permanently.

This piece closes the read direction only. There is no reverse path in anything
below and there must not be one.

## PowerSchool has TWO behavior models. This one measured which is in use.

The reference is explicit that PowerSchool keeps two independent behavior
records, and that Incident Management, not log entries, is the administrator
side and the state reporting source. If Westbrook tracked behavior through
Incident Management, every artifact in this piece would be pointed at the wrong
table and the whole thing would be void.

That question was answered on 2026-08-11 against `lapf.powerschool.com`, with
`GET` requests only, and **before** any SIS admin was asked to approve anything:

```
GET /ws/schema/table/log/count                   -> 200  {"count":16987}
GET /ws/schema/table/gen/count                   -> 200  {"count":1164}
GET /ws/schema/table/incident/count              -> 200  {"count":13}
GET /ws/schema/table/incident_person_role/count  -> 200  {"count":10}
GET /ws/schema/table/incident_detail/count       -> 200  {"count":75}
GET /ws/schema/table/incident_action/count       -> 200  {"count":9}
GET /ws/schema/table/incident_lu_sub_code/count  -> 200  {"count":160}
GET /ws/schema/table/students/count              -> 200  {"count":2089}
```

**Westbrook's behavior record lives in `LOG`, by 16987 to 13.**

Incident Management is configured here and essentially unused: the district has
built out 160 incident subcodes and has filed thirteen incidents, ever,
involving ten participants, with nine resulting actions. Log entries are where
day to day behavior actually lives, exactly as the reference predicts for a
school that uses both.

### Why this was free

`/ws/schema/table/{table}/count` **answers without a grant.** `LOG`, `GEN` and
every `INCIDENT_*` table returned a count while `plugin.xml` grants nothing on
any of them. That is what made the load bearing premise checkable before
spending the SIS admin's one cheap approval, rather than after.

A **filtered** count does not work without a grant, and this is the honest limit
of the finding:

```
GET /ws/schema/table/log/count?q=schoolid==1817
  -> 403 {"message":"At least one column lacks sufficient permission",
          "errors":[{"code":"NoAccess","field":"SchoolID","resource":"Log"}]}
```

So **16987 is district wide, not Westbrook scoped, and its recency is not
established.** Both remain open questions below. What is settled is the
direction of the ask: `LOG` and `GEN`, not the incident family.

## Every table and column in the ask was verified against production

PowerSchool validates a column name **before** it checks permission. On an
ungranted table a real column answers `403 NoAccess` and a made up one answers
`400 ... is not valid column for table`. Calibrated both ways, because a 403
proves nothing without the matching 400:

```
GET /ws/schema/table/students?projection=zzz_definitely_not_a_column
  -> 400 {"message":"Invalid field specified: zzz_definitely_not_a_column is not valid column for table: Students"}
GET /ws/schema/table/log?projection=zzz_definitely_not_a_column
  -> 400 {"message":"Invalid field specified: zzz_definitely_not_a_column is not valid column for table: Log"}
GET /ws/schema/table/log?projection=entry_date
  -> 403 {"errors":[{"code":"NoAccess","field":"entry_date","resource":"Log"}]}
```

Better still, the `q` filter path normalises the column name before rejecting
it, so **PowerSchool itself supplied the canonical spelling** of every column in
the access request:

```
GET /ws/schema/table/log/count?q=entry_date=ge=2020-01-01
  -> 403 {"errors":[{"code":"NoAccess","field":"Entry_Date","resource":"Log"}]}
GET /ws/schema/table/log/count?q=discipline_actiontaken==1
  -> 403 {"errors":[{"code":"NoAccess","field":"Discipline_ActionTaken","resource":"Log"}]}
GET /ws/schema/table/gen/count?q=sortorder==1
  -> 403 {"errors":[{"code":"NoAccess","field":"SortOrder","resource":"Gen"}]}
```

The `<field>` lines below are copied from those responses, not transcribed from
a data dictionary PDF. A typo in the ask would have cost a second trip to the
SIS admin, and there is no second cheap trip.

Two findings worth carrying forward:

- `log.entry` answers `400 "Querying not supported against clob or blob field
  types"`. **`LOG.Entry` is a CLOB**, confirmed by the instance rather than by
  documentation. That is the free text narrative this piece refuses to touch.
- `Log` and `Gen` answer 403, **not** the 405 that `teachers` answers. Both
  tables are exposed over `/ws/schema/table` here. The earlier worry that `LOG`
  might be unreachable the way `teachers` is has been retired by measurement.
  The queries below are still PowerQueries, because they need joins.

## Two leads from the reference are dead, both measured

### 1. The `/ws/v1/student?expansions=alerts` route does not exist for us

The reference calls the alerts expansion the cheapest possible behavior read.
It is unreachable here for two independent reasons.

**The whole `/ws/v1` resource surface is closed to plugin 9741:**

```
GET /ws/v1/metadata            -> 200  (server capabilities, works)
GET /ws/v1/school/1817/student -> 401  {"errorMessage":{"message":"Plugin is missing required accessLevelV1Api READ permission"}}
GET /ws/v1/district            -> 401  same
GET /ws/v1/student/1           -> 401  same
```

`accessLevelV1Api` is a plugin level permission, not a field grant, so no
amount of `<field>` lines opens it. Every `/ws/v1` expansion, alerts included,
is behind that one 401.

**And the alert columns are not in this instance at all:**

```
GET /ws/schema/table/students?projection=alert_disciplinestr
  -> 400 {"message":"Invalid field specified: alert_disciplinestr is not valid column for table: Students"}
```

Same for `alert_discipline_expdate`, `alert_medicalstr`, `alert_guardianstr`
and `alert_otherstr`. All five **do not exist**, exactly the way `student_email`
turned out to be absent rather than denied. This is settled, not deferred.

### 2. The twelve `INCIDENT_*` tables are not worth the ask

Not requested, and now for a measured reason rather than a predicted one: 13
rows. The rest of the argument still holds and is recorded so nobody
rediscovers it:

- Pinning one coded behavior on one student needs a four table join minimum
  (`INCIDENT_PERSON_ROLE` to `INCIDENT_PERSON_DETAIL` to `INCIDENT_DETAIL` to
  `INCIDENT_LU_CODE` where `CODE_TYPE='behaviorcode'`).
- `INCIDENT_OTHER_PERSON` holds third party PII that must never leave the SIS.
- `IS_STATE_REPORTABLE_FLG` and `RESTRICTED` mark rows a student facing app must
  not surface, and `INCIDENT_SECURITY_GROUP` exists because some incident types
  are hidden from most staff. Honouring three separate visibility mechanisms is
  a project, not a column.

If severity weighting is ever wanted, `INCIDENT_LU_SUB_CODE.SEVERITY` exists
here (403, verified) and is the one numeric field in the discipline model that
could carry it. That is a separate decision with a separate review, and on
current volumes it would weight thirteen rows.

## Status, as of 2026-08-11

| Thing | State |
|---|---|
| Which behavior model Westbrook uses | **ANSWERED: `LOG`.** 16987 log entries against 13 incidents, measured live. |
| Column names and spellings in the ask | **VERIFIED against production**, read only, no grant needed. |
| `powerschool/plugin/queries_root/behavior.named_queries.xml` | Written. Two queries. NOT installed. |
| `convex/psBehavior.ts` | Written. Every `psBehaviorLog` access fails **loudly** until diff 1 lands: the read returns `unknown` with a reason naming the unapplied diff, the write throws a `ConvexError` saying the same thing. |
| `convex/psBehavior.test.mjs` | 300 assertions, all passing. **Not wired into `npm test`** (diff 5) and there is no CI, so nothing runs them yet. |
| `plugin.xml` grant for `Log` and `Gen` | ABSENT. The first blocker, and **not the last one**: diffs 1, 2 and 3 are still unapplied after it. |
| Bytes of behavior data in Convex | **ZERO**, and zero until the grant AND diffs 1 to 3 land. Nothing here pretends otherwise. |
| Which log types this school uses | **UNKNOWN and unmeetable before the grant.** See the top of this document. `behavior_types` reads it. Do not assume, and do not paste another district's integers. |
| Whether the 16987 entries are recent, or Westbrook's | UNKNOWN. The filter that would answer it is itself blocked. |
| The raw shape of an Oracle date from this instance | UNKNOWN and never recorded anywhere in this repo. `canonicalDate` reads four shapes and reports any fifth by literal on the first sync. |

## The two queries

Both live in `powerschool/plugin/queries_root/behavior.named_queries.xml`.

### 1. `com.lapromisefund.wildcathub.behavior_types`

Reads `GEN` where `CAT` is `logtype`, `subtype` or `consequence`, left joined to
a count of `LOG` rows per type.

**Run this one first.** It carries no student data at all. It answers, per
school, what the district wide count above cannot: which types are configured,
which are actually used, and between which dates.

### 2. `com.lapromisefund.wildcathub.behavior_log`

One row per log entry for one school over an explicit, required date window.
Keyed on `STUDENTS.STUDENT_NUMBER`, the same key `psRoster`, `psAttendance` and
`psGrades` already use.

Returns: `student_number`, `log_entry_id`, `entry_date`, `log_type_id`,
`log_type_name`, `subtype`, `consequence`, `action_taken`, `incident_date`,
`entry_author`, `school_id`.

## What is deliberately NOT read, and why

### `LOG.Entry` and `LOG.Subject`, the free text

Not selected, not granted, not stored, not viewable. A log entry narrative is a
sentence a teacher wrote about a child and it routinely names a second child,
or carries a medical or family detail. The instance itself confirms `LOG.Entry`
is a CLOB. Date, type, subtype, consequence, action taken and author fully
answer "does PowerSchool already know something about this student's behavior".
The narrative stays in PowerSchool, behind the access controls that already
govern it and the audit trail that records the reading.

This is also why the ask is small. A SIS admin asked for sixteen columns on two
tables has a decision to make. Asked for forty three including free text and the
whole federal discipline block, the honest answer is no, and it should be.

### 32 of the 34 `Discipline_*` columns

Two are requested. `Discipline_ActionTaken` and `Discipline_IncidentDate` are
the only two the 5.2 data dictionary describes as live; it marks the other 32
"no longer used by application". Both were verified to exist here.

They earn their place because they answer the single most decision relevant
question this app can ask about a child's behavior record: **was this student
suspended, and when.** Deducting Wildcat Cash from a child who was serving a
suspension that day is the concrete mistake this prevents, and no other column
in the ask can prevent it.

The other 32 stay out. `Discipline_Reporter` alone names a third party.

### The one qualifier on the free text claim, stated because it was wrong before

An earlier version of this document, of the query file, of `psBehavior.ts` and
of the proposed `schema.ts` comment all claimed, in capitals and without
qualification, that **no free text of any kind left the SIS on this path**. That
was false, and it was false in the one place it mattered most: the schema
comment is what a SIS admin reads while deciding whether to approve the access
request. The exact phrasing is deliberately not repeated here, so that a search
for it across the repo returns nothing.

`Discipline_ActionTaken` is a `String 79` described as a code "such as
S=Suspend", and a district *can* type prose into a code field. The guard was a
79 character cap, and **a length cap cannot exclude prose shorter than the cap**.
`Suspended for fighting with Jose in the cafeteria` is 49 characters, names a
second child, and passed it unchanged.

The guard is now a **shape**, not a length. `isActionCode` in
`convex/psBehavior.ts` admits a value only if it is a single token, optionally a
second after one `=`, drawn from letters, digits and `. _ / + -`. **No
whitespace of any kind.** That sentence now dies on its first space, and so does
every other sentence, at any length. Real codes still land: `S`, `OSS`, `ISS`,
`S=Suspend`, `ISS-3`.

**The limit a shape guard cannot fix**, named here rather than smoothed over: a
single bare token still passes, and a token can be a person's name. Nothing can
distinguish `OSS` from `Jose` by shape. So:

- Every refused value is **counted** in the sync summary as
  `nonCodeActionTaken`, and never echoed, because reporting the value would move
  exactly the prose it refused.
- If that count is anything but 0 on the first sync, Westbrook uses the column
  as a notes field and **it comes back out of the access request**, which is a
  one line change to the ask and to the query and nothing else.
- Dropping it from the ask entirely, up front, remains a legitimate call for
  whoever approves the request. It is the only column here that carries the
  risk at all, and open question 4 is exactly that decision.

`convex/psBehavior.test.mjs` section 2 keeps the leaking sentence verbatim as a
regression, and section 19 checks all four places that make the claim so the
absolute cannot creep back into one of them.

### Any write, in either direction

The plugin holds 108 ViewOnly grants and zero FullAccess. Nothing below changes
that, and the ask keeps every new field ViewOnly.

More specifically: behavior counts must never become tickets or Wildcat Cash.
The app holds 6,616,500 in Wildcat Cash that PowerSchool has never heard of. A
log entry filed by a substitute must not be able to spend a child's money, and
an app ticket must not appear in a child's permanent record. `psBehavior.ts`
contains no quoted reference to the student table for that reason, and
`psBehavior.test.mjs` asserts it against the module's own source so the
guarantee survives an edit that forgets the reason.

## `LOG.Subtype` is a code, and this piece refuses to guess its join

`LOG.Subtype` is a `String 20`. The admin documentation says a subtype is
configured as a **code plus a description**, and does not say which `GEN` column
holds which. `GEN.Name` and `GEN.Value` both exist here (403, verified) and
either could be the code.

Guessing would produce a join that looks right and silently resolves nothing.
So:

- `behavior_types` selects **both** `GEN.Name` and `GEN.Value`.
- `buildSubtypeIndex` in `convex/psBehavior.ts` keys the index on both, so
  whichever column Westbrook actually uses, the lookup succeeds.
- `resolveSubtype` returns `{ code, name, resolved }`. When nothing matches it
  returns `resolved: false` with a null name rather than handing a teacher a
  bare code styled as a label.
- `staffBehaviorView` returns that object, not a string, so a caller cannot
  print a raw code by accident: rendering it means reading `resolved`.

**Once the grant lands, one look at the `behavior_types` output settles which
column it is**, and the resolution can collapse into the SQL join. Until then
the app says "unknown" out loud, which is the same rule as absence not being
zero.

## THE ASK: the amended access request

Add to `powerschool/plugin/plugin.xml` inside `<access_request>`, bump the
plugin `version` attribute to `1.1.0`, re-upload, and have a PowerSchool admin
disable and re-enable the plugin.

Sixteen fields across two tables. Every one ViewOnly. No free text, no incident
table, and 32 of the 34 discipline columns left out.

**Every table name, field name and capitalisation below was read back from
`lapf.powerschool.com` on 2026-08-11.** None of it is transcribed from
documentation.

```xml
      <!-- ================================================================
           BEHAVIOR. Log entries and the district defined vocabulary that
           classifies them. Added 2026-08-11 for the behavior read path.

           Log holds one row per log entry: 16987 of them in this instance,
           against 13 rows in Incident Management. Gen is PowerSchool's
           catchall lookup table; log types are its rows where Cat = 'logtype',
           with subtypes and consequences alongside. Log.LogTypeID points at
           Gen.ID, and the integers are arbitrary per district, so nothing may
           hardcode one.

           DELIBERATELY ABSENT: Log.Entry (a CLOB, the narrative) and
           Log.Subject (the title), and 32 of the 34 Discipline_ columns. The
           two that are here are the only two the data dictionary calls live,
           and they answer "was this child suspended, and when". See
           docs/behavior-sourcing.md.

           Still ViewOnly. There is no write anywhere in this file.
           ================================================================ -->
      <field table="Log" field="ID"                      access="ViewOnly"/>
      <field table="Log" field="StudentID"               access="ViewOnly"/>
      <field table="Log" field="SchoolID"                access="ViewOnly"/>
      <field table="Log" field="Entry_Date"              access="ViewOnly"/>
      <field table="Log" field="Entry_Author"            access="ViewOnly"/>
      <field table="Log" field="LogTypeID"               access="ViewOnly"/>
      <field table="Log" field="Subtype"                 access="ViewOnly"/>
      <field table="Log" field="Consequence"             access="ViewOnly"/>
      <field table="Log" field="Discipline_ActionTaken"  access="ViewOnly"/>
      <field table="Log" field="Discipline_IncidentDate" access="ViewOnly"/>

      <field table="Gen" field="ID"        access="ViewOnly"/>
      <field table="Gen" field="Cat"       access="ViewOnly"/>
      <field table="Gen" field="Name"      access="ViewOnly"/>
      <field table="Gen" field="Value"     access="ViewOnly"/>
      <field table="Gen" field="SchoolID"  access="ViewOnly"/>
      <field table="Gen" field="SortOrder" access="ViewOnly"/>
```

`STUDENTS.Student_Number`, `STUDENTS.ID`, `STUDENTS.SchoolID` and
`STUDENTS.Enroll_Status` are used by `behavior_log` and are all granted already.

`psBehavior.test.mjs` section 11 mechanically checks that this block covers
every column the two queries declare, and that it asks for nothing they do not
touch. If someone adds a column to a query and forgets the grant line, that test
fails before anyone hits a 403 on a live instance.

## BLOCKING GATE: run both SQL bodies through the query tester first

Do this **before** bumping the plugin version, not after.

`psBehavior.test.mjs` section 15 measures every SQL construct in the two new
queries against the seven already working on this instance and prints the table.
Its result today:

```
        flattened="true"             live=yes new=yes
        coreTable="schools"          live=yes new=yes
        coreTable="students"         live=yes new=yes
        NVL(                         live=yes new=yes
        LEFT JOIN a derived table    live=yes new=yes
        COUNT( with GROUP BY         live=yes new=yes
        TRUNC(SYSDATE)               live=yes new=no
        TO_CHAR(                     live=no  new=no
        TO_DATE(                     live=no  new=yes   <-- NO LIVE PRECEDENT
        string concatenation ||      live=no  new=no
```

So the untested surface is **exactly one function**, `TO_DATE`, in the window
predicate of `behavior_log`.

`TO_CHAR` used to be the second, and it was self inflicted. Three columns on
this instance already come back as **raw Oracle dates** from live queries,
`TERMS.FIRSTDAY`, `TERMS.LASTDAY` and `PGFINALGRADES.LASTGRADEUPDATE`, and
`convex/sisAction.ts:181` and `:206` carry them as plain strings today.
`canonicalDate` was written to absorb exactly those shapes. Formatting the date
in SQL therefore bought nothing and spent the only thing worth conserving here,
which is how much a human has to test by hand before a production plugin can be
re-uploaded. **The four date columns now come back raw**, like the three that
already work.

Everything else is proven: repeated bind variables (the live
`attendance_summary` binds `:schoolid` three times), `flattened="true"` (all
seven), `coreTable="schools"` (the live `terms` query), and the derived table
plus `NVL(U.COL, 0)` shape (the live `staff` query). String concatenation was
removed from `behavior_log` rather than shipped untested: the `UNMAPPED_LOGTYPE_`
marker is now built only in `psBehavior.ts`, which also removes a literal that
previously existed in two languages at once.

**The step:** paste each `<sql>` body into the PowerSchool query tester (System
Report Queries, or DDA), substituting literals for the binds, and run it. While
you are there, **copy one raw `entry_date` value into open question 6 below.**
That is the shape `canonicalDate` has to read, and it is currently the one thing
about the date path nobody has seen.

**If `TO_DATE` is rejected**, replace the window predicate with arithmetic on
`TRUNC(SYSDATE)`, which is proven live, and pass a day count instead of two
dates:

```sql
AND L.ENTRY_DATE >= TRUNC(SYSDATE) - :lookbackdays
```

That changes the `<args>` block and the sync call site, and nothing else.

## OPEN HAZARD: do not run `npm run build:plugin` yet

`powerschool/sync/scripts/build-plugin.mjs` packages the plugin with
`zip -r -q <out> .` from `powerschool/plugin`, so it picks up
`queries_root/behavior.named_queries.xml` automatically. Re-verified 2026-08-11
by running the script's own zip command with the output redirected outside the
repo:

```
    18390  queries_root/expansion.named_queries.xml
    22080  queries_root/wildcathub.named_queries.xml
    13069  queries_root/behavior.named_queries.xml
    14178  plugin.xml
```

Plugin 1.0.6 is authenticating to a production SIS for 641 students right now.
Two outcomes are possible:

- PowerSchool rejects the upload during validation, the way it rejected
  `SECTIONMEETING` in 1.0.0. That breaks the entire plugin upload.
- PowerSchool accepts it and both queries answer 403, which is useless but
  harmless.

The first is **less likely than it looked before the probe**: `SECTIONMEETING`
was rejected because it is not a real table, and `Log` and `Gen` are real tables
in this instance, measured above. Less likely is not ruled out, and the blast
radius is the whole plugin.

This change may not edit `build-plugin.mjs`, so the fix is proposed diff 4
below, and it is **escalated as a blocker in the handoff** rather than encoded
as a test that fails on purpose. The previous round did the latter and it was
worse than the comment it replaced: `package.json`'s `test` script does not run
`convex/psBehavior.test.mjs`, and there is no `.github/workflows` directory, so
nobody runs that assertion. A red test nobody runs is inert and makes the suite
look broken at the same time. **Section 17 now REPORTS the live state of the
hazard on every run** and asserts only what this piece can actually control,
which is that the exclusion diff exists here and is exact.

`zip -r .` takes the whole directory, so it does not matter that neither file is
named anywhere in the build script. The archive also carries
`queries_root/expansion.named_queries.xml`, which belongs to a different change
and is under the same hazard; diff 4 excludes this change's file, and whoever
owns that one has the same one line to write.

## Proposed diffs to files this change does not own

None of these are applied. Each is exact. **Apply diff 4 first**, because it is
the one that protects a live production plugin.

### 1. `convex/schema.ts`, the one new table

```diff
@@ psRestricted: defineTable({ ... }).index("by_studentNumber", ["studentNumber"]),
+
+  /**
+   * PowerSchool behavior log entries, one row per LOG entry, exactly as the
+   * `wildcathub.behavior_log` PowerQuery returns it.
+   *
+   * NO NARRATIVE FREE TEXT, AND ONE SHAPE CHECKED CODE FIELD. LOG.Entry (a
+   * CLOB, the narrative) and LOG.Subject (the title) are not selected by the
+   * query, not requested in the access request, and not in this table. A log
+   * entry narrative routinely names a second child or carries a medical or
+   * family detail.
+   *
+   * The qualifier, because the absolute version of this claim was false:
+   * actionTaken below holds LOG.Discipline_ActionTaken, a String 79 a
+   * district CAN type prose into. It is admitted only if it is code SHAPED
+   * (isActionCode in convex/psBehavior.ts: one token, optional =VALUE, no
+   * whitespace at all), because the length cap it replaced could not exclude
+   * a 49 character sentence naming a second child. A single bare token still
+   * passes, which no shape can fix, so every refusal is counted in the sync
+   * summary and the column comes out of the access request if that count is
+   * ever nonzero.
+   *
+   * TWO DISCIPLINE COLUMNS, NAMED. actionTaken and incidentDate are the only
+   * two of the 34 Discipline_ columns the data dictionary calls live, and
+   * together they answer "was this child suspended, and when", which is the
+   * question that stops a teacher deducting Wildcat Cash from a student who
+   * was serving a suspension that day.
+   *
+   * ABSENCE IS NOT ZERO. A student with no row here has either no log entries
+   * or no sync, and those are different facts. The coverage record in
+   * `appState` under key `psBehaviorCoverage` is what separates them; without
+   * it, `psBehavior.behaviorSummaryFor` returns status "unknown" with a null
+   * count rather than "0 incidents", which would be a claim about a child
+   * that nobody checked. Same rule as psAttendance above.
+   *
+   * THIS TABLE NEVER FEEDS THE student TABLE. A behavior count is a fact
+   * from the SIS; a ticket is something a person gave a child. See
+   * convex/psBehavior.ts.
+   */
+  psBehaviorLog: defineTable({
+    studentNumber: v.string(),
+    logEntryId: v.string(),
+    entryDate: v.string(),        // YYYY-MM-DD, canonicalized, never re-parsed
+    logTypeName: v.string(),      // GEN.Name, or UNMAPPED_LOGTYPE_<id>
+    logTypeId: v.optional(v.string()),
+    subtype: v.optional(v.string()),      // a CODE. Resolve via psBehaviorTypes.
+    consequence: v.optional(v.string()),
+    actionTaken: v.optional(v.string()),  // Discipline_ActionTaken, code shaped only
+    incidentDate: v.optional(v.string()), // Discipline_IncidentDate, YYYY-MM-DD
+    entryAuthor: v.optional(v.string()),
+    schoolId: v.optional(v.string()),
+    windowStart: v.string(),
+    windowEnd: v.string(),
+    syncedAt: v.string(),
+  })
+    .index("by_studentNumber", ["studentNumber"])
+    .index("by_entryDate", ["entryDate"]),
```

Once this lands, delete the `WidenedDb` helper and `behaviorDb()` from
`convex/psBehavior.ts` and use `ctx.db` directly. Nothing else in that file
changes.

### 2. `convex/sisAction.ts`, wiring the pull into the scheduled sync

Fail soft and off by default. Until the grant lands both queries 403, and an
unconditional call would make every scheduled sync throw and take the roster
with it.

```diff
@@     for (let i = 0; i < gradeRows.length; i += 200) {
@@       await ctx.runMutation(internal.sisStats.replaceGrades, {
@@         syncedAt, rows: gradeRows.slice(i, i + 200), clearFirst: i === 0,
@@       });
@@     }
+
+    // ---- behavior: off until plugin.xml grants Log and Gen ----
+    //
+    // Gated on an env var rather than a try/catch alone, because a 403 on
+    // every run twice a day is noise that trains people to ignore the log.
+    // Set PS_BEHAVIOR_ENABLED=yes only after the 1.1.0 plugin is enabled.
+    let behavior: Record<string, unknown> = { enabled: false };
+    if (process.env.PS_BEHAVIOR_ENABLED === "yes") {
+      const lookback = Number(process.env.PS_BEHAVIOR_LOOKBACK_DAYS ?? 120);
+      const end = new Date();
+      const start = new Date(end.getTime() - lookback * 86400000);
+      const day = (d: Date) => d.toISOString().slice(0, 10);
+      const windowStart = day(start);
+      const windowEnd = day(end);
+      try {
+        // Types FIRST. It carries no student data and it is what turns a
+        // subtype code into something a teacher can act on.
+        const types = await namedQuery(host, tok, `${prefix}.behavior_types`, { schoolid });
+        const typeRows = types.rows
+          .map((t) => normalizeTypeRow(t))
+          .filter((t): t is NonNullable<typeof t> => t !== null);
+        const typeSummary = await ctx.runMutation(internal.psBehavior.putTypes, {
+          syncedAt, types: typeRows,
+        });
+
+        const log = await namedQuery(host, tok, `${prefix}.behavior_log`, {
+          schoolid, startdate: windowStart, enddate: windowEnd,
+        });
+        // One call, one report. Counted, not thrown on: a surprising column
+        // loses the review it should have had, not the rows that were fine.
+        const report = ingestReport(log.rows);
+
+        for (let i = 0; i < report.rows.length; i += 200) {
+          await ctx.runMutation(internal.psBehavior.replaceWindow, {
+            syncedAt, windowStart, windowEnd,
+            rows: report.rows.slice(i, i + 200), clearFirst: i === 0,
+          });
+        }
+        // Coverage is written LAST, after the rows. A run that dies halfway
+        // leaves the previous coverage in place rather than claiming a window
+        // it did not finish loading.
+        await ctx.runMutation(internal.psBehavior.recordCoverage, {
+          windowStart, windowEnd, syncedAt, entriesLoaded: report.rows.length,
+        });
+
+        behavior = {
+          enabled: true, windowStart, windowEnd,
+          entriesLoaded: report.rows.length,
+          rowsDropped: report.dropped,
+          freeTextKeysRejected: report.freeTextKeys,
+          // If this is not 0, Westbrook types prose into Discipline_ActionTaken
+          // and the column should come back out of the access request. A count,
+          // never the values: reporting them would move the prose they refused.
+          nonCodeActionTaken: report.nonCodeActionTaken,
+          // The SQL no longer formats dates, so this is where the raw Oracle
+          // shape shows itself. Empty on a healthy run. If it is not empty,
+          // canonicalDate needs one more branch and the literals are right here
+          // rather than being reconstructed from a pile of dropped rows.
+          unreadableDateSamples: report.unreadableDateSamples,
+          ...typeSummary,
+        };
+      } catch (error) {
+        // The roster is the reason the cron exists. Behavior must never be
+        // able to take it down.
+        behavior = { enabled: true, failed: String(error).slice(0, 200) };
+      }
+    }
```

and in the `summary` object:

```diff
       gradeRowsMissingPercent: gradeRows.filter((g) => g.currentPercent === undefined).length,
+      behavior,
       durationMs: Date.now() - started,
```

and at the top of the file:

```diff
 import { internalAction } from "./_generated/server";
 import { internal } from "./_generated/api";
 import { v } from "convex/values";
+import { ingestReport, normalizeTypeRow } from "./psBehavior";
```

### 3. `convex/studentDetail.ts`, the gated read

The access decision already exists here. `psBehavior.ts` deliberately exposes no
public query so there is only ever one copy of it.

**The principal is the real one.** An earlier draft of this diff passed a string
literal, which made the audience gate return allowed unconditionally while a
test certified that students were denied. `behaviorAudienceFor` now takes an
object, so that mistake is a compile error rather than a comment.

```diff
-import { requireStaff } from "./identity";
+import { requireStaff, requireIdentity } from "./identity";
 import { canViewStudent } from "./accessRules";
 import { studentSisView } from "./views";
+import { readBehaviorForStudent } from "./psBehavior";
@@   handler: async (ctx, { studentNumber }) => {
     const teacher = await requireStaff(ctx);
+    // The classified identity, not a literal. requireStaff has already thrown
+    // for anyone who is not staff; this is the value that lets the behavior
+    // gate be a real check rather than a decoration.
+    const id = await requireIdentity(ctx);
@@       sis: {
         scheduleCount: rows.length,
         schedule: rows.map(studentSisView),
         lastSyncedAt: rows[0]?.syncedAt ?? null,
       },
+
+      // SIS behavior. Staff only, and only after canViewStudent above has
+      // already said this caller may look at this child. Three distinct
+      // states: "denied", "unknown" (no sync has covered a window) and
+      // "covered". Only the third one may ever be rendered as a number.
+      behavior: await readBehaviorForStudent(ctx, id, studentNumber),
```

### 4. `powerschool/sync/scripts/build-plugin.mjs`, the packaging guard

**Apply this one first.** It is the only diff here that protects something
currently in production.

First, extend the existing em dash guard to cover the new file. Replace its
`for (const file of [...])` line, leaving the `EM_DASH` constant line above it
untouched (this doc cannot quote that character):

```diff
-for (const file of [PLUGIN_XML, resolve(PLUGIN_DIR, "queries_root", "wildcathub.named_queries.xml")]) {
+const QUERIES_DIR = resolve(PLUGIN_DIR, "queries_root");
+const BEHAVIOR_QUERIES = resolve(QUERIES_DIR, "behavior.named_queries.xml");
+for (const file of [
+  PLUGIN_XML,
+  resolve(QUERIES_DIR, "wildcathub.named_queries.xml"),
+  BEHAVIOR_QUERIES,
+]) {
```

Then, after the `if (emDashFiles.length > 0) { ... }` block:

```diff
 
+// Guard: behavior.named_queries.xml reads Log and Gen. Packaging it before the
+// access request grants them either fails the upload during validation, the way
+// SECTIONMEETING did in 1.0.0, or ships two queries that 403 on every call.
+// The first would break the whole plugin, so the file is EXCLUDED rather than
+// shipped, loudly, until the grant exists.
+const zipExcludes = [".DS_Store", "__MACOSX/*", "*/.DS_Store"];
+const grantsBehavior =
+  /<field\s+table="Log"/i.test(xml) && /<field\s+table="Gen"/i.test(xml);
+if (existsSync(BEHAVIOR_QUERIES) && !grantsBehavior) {
+  zipExcludes.push("queries_root/behavior.named_queries.xml");
+  console.warn(
+    "\nEXCLUDED queries_root/behavior.named_queries.xml from this zip.\n" +
+      "It reads Log and Gen and plugin.xml grants neither. See\n" +
+      "docs/behavior-sourcing.md for the access request that unblocks it.\n",
+  );
+}
+
 mkdirSync(OUT_DIR, { recursive: true });
@@ execFileSync(
   "zip",
-  ["-r", "-q", zipPath, ".", "-x", ".DS_Store", "-x", "__MACOSX/*", "-x", "*/.DS_Store"],
+  ["-r", "-q", zipPath, ".", ...zipExcludes.flatMap((p) => ["-x", p])],
   { cwd: PLUGIN_DIR, stdio: "inherit" },
 );
```

### 5. `package.json`, so the assertions run rather than being remembered

**Apply this one now.** It no longer depends on diff 4: section 17 reports the
packaging hazard rather than asserting on it, so the suite is green today and
this diff can land immediately. Until it does, 300 assertions exist and nothing
runs them. There is no `.github/workflows` directory in this repo, so
`package.json` is the only place that can make them run at all.

```diff
-    "test": "node convex/identityRules.test.mjs && node convex/views.test.mjs && node convex/sisMerge.test.mjs && node convex/accessRules.test.mjs && node convex/restrictedPolicy.test.mjs && node wildcat-auth.test.mjs && node msal-recovery.test.mjs && node popup-guard.test.mjs && node cdn-reachable.test.mjs",
+    "test": "node convex/identityRules.test.mjs && node convex/views.test.mjs && node convex/sisMerge.test.mjs && node convex/accessRules.test.mjs && node convex/restrictedPolicy.test.mjs && node convex/psBehavior.test.mjs && node wildcat-auth.test.mjs && node msal-recovery.test.mjs && node popup-guard.test.mjs && node cdn-reachable.test.mjs",
```

## Reproducing the probe

Every number in this document came from `GET` requests through the repo's own
`PowerSchoolClient`, so each one passed the `ReadOnlyViolation` chokepoint at
`powerschool/sync/src/client.ts:161` that permits `GET` and permits `POST` only
to `/ws/schema/query/`. No `POST` to any data path was issued at any point. The
counts endpoint and the column probes need no grant, so this is repeatable by
anyone with the plugin credentials:

```
cd powerschool/sync
op signin
node --env-file=.env --input-type=module -e '
  const {loadConfig} = await import("./src/config.ts");
  const {PowerSchoolClient} = await import("./src/client.ts");
  const c = new PowerSchoolClient(loadConfig(), () => {});
  for (const t of ["log", "gen", "incident"]) {
    const r = await c.get(`/ws/schema/table/${t}/count`);
    console.log(t, r.status, r.text);
  }
'
```

## Open questions, in the order they should be asked

1. **Are the 16987 log entries Westbrook's, and are they recent?** The count is
   district wide because `?q=schoolid==1817` is itself blocked by the missing
   grant. `behavior_types` answers both the moment the grant lands: it is school
   scoped and it returns `first_entry_date` and `last_entry_date` per type.
2. **Which log types does Westbrook configure, and what are their integers?**
   UNKNOWN, deliberately. `GEN` ids are arbitrary per district and a published
   real district has Merits=404, Contact=461, MTSS=24018 and a negative built-in
   at -100000. Read them; do not paste another district's table here.
3. **Is the subtype code in `GEN.Name` or `GEN.Value`?** Both are requested and
   both are indexed. One look at the `behavior_types` output settles it.
4. **Does Westbrook type prose into `Discipline_ActionTaken`?** The first sync
   reports `nonCodeActionTaken`. If it is not 0, take that column back out. It
   is also entirely defensible to take it out **before** approving the request:
   it is the only column in the ask that carries any free text risk at all.
5. **Should a student ever see their own log entries?** Currently no, by
   `behaviorAudienceFor`. That is a school policy decision, not an engineering
   one, and changing it needs a named person and a line in this file.
6. **What shape is a raw Oracle date on this instance?** Not recorded anywhere
   in this repo, for any query, including the three live ones that already
   return raw dates. `canonicalDate` reads `YYYY-MM-DD`, that plus a time,
   `YYYY/MM/DD` and `DD-MON-YY`. Anything else drops the row, and the first sync
   reports up to three of the literals it could not read. Paste one here when
   the query tester step runs, because it takes five seconds there and an
   afternoon later:

   ```
   entry_date raw value seen in the query tester: ______________________
   ```

## Log types in use at Westbrook

**UNKNOWN, and not knowable before the grant.** This table is what the brief
asked for and it is the one requirement this piece cannot meet: every path to it
is a `403` today, as measured at the top of this document. It is left empty
rather than filled with a plausible looking guess or another district's
integers, both of which would be worse than a blank.

Fill it from the `behavior_types` output, which is the first thing to run after
the grant lands and carries no student data at all.

| GEN.ID | Cat | Name | Value | Entries | First | Last |
|---|---|---|---|---|---|---|
| | | | | | | |

## Go / no go

Steps 1 and 2 can be done today. Step 3 onward needs the SIS admin.

1. [ ] Apply proposed diff 5. The 300 assertions currently run only when
       somebody remembers to type `node convex/psBehavior.test.mjs`.
2. [ ] Apply proposed diff 4. It protects a plugin that is live in production,
       and it is the only diff here that protects something that already exists.
       Then run `npm run build:plugin` and confirm `behavior.named_queries.xml`
       is NOT in the listing.
3. [ ] Paste both `<sql>` bodies into the PowerSchool query tester and run
       them. This is the `TO_DATE` gate. Copy one raw `entry_date` value into
       open question 6 while you are there.
4. [ ] Add the sixteen `<field>` lines, bump `plugin.xml` to 1.1.0, re-upload,
       disable and re-enable the plugin.
5. [ ] Run `behavior_types` alone. Fill in the table above. If
       `entries_all_time` is 0 across every row for school 1817, stop: the
       district wide 16987 belongs to another school and this piece parks.
6. [ ] Apply proposed diff 1, then diff 2, then diff 3. Set
       `PS_BEHAVIOR_ENABLED=yes`. **Until all three land, no behavior row can
       reach a screen no matter what the plugin grants.**
7. [ ] Read the first sync summary. Check `freeTextKeysRejected` is empty,
       `nonCodeActionTaken` is 0, and `unreadableDateSamples` is empty.
