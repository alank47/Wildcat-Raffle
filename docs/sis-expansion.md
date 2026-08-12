# SIS coverage expansion

Closing the highest value READ gaps that `docs/sis-coverage.md` found, behavior
excluded because another piece owns LOG, GEN and the INCIDENT family.

Companion to two files that answer narrower questions:

| File | Question it answers |
|---|---|
| `docs/access-gap.md` | Did the 19 fields we asked for get granted? |
| `docs/sis-coverage.md` | How much of the SIS did we ask for in the first place? |
| this file | Of what we did not ask for, what is worth asking for, and what can we build today with no new grant at all? |

---

## Read this first: what shipped, and what did not

Three sentences, because the differences between them are the whole story of
this piece.

**Every reachability claim below was measured against the live instance.** The
probe made 381 requests to `lapf.powerschool.com` in its last run. Nothing here
is inferred from documentation.

**None of the four PowerQueries is installed, so none of them has ever been
executed by Oracle.** They exist in `queries_root/` in this repo and in no
running system.

**Two of the four shipped a defect that silently discarded a third of the
school, inherited by copying the join spine out of the sibling query file.** It
was caught in review, it is fixed, and the same defect is still live in the
sibling file today. It is the first section below because it invalidates numbers
this project has been quoting as facts.

### The queries are not installed. Proven, not assumed

The probe calls all four by name, for real, with POST, which is the one verb the
project's hard rules permit against a named query path (a PowerQuery's SQL is
structurally read only, so the verb cannot mutate anything):

| PowerQuery | Result |
|---|---|
| `attendance_join_health` | 404 `Query ... not found` |
| `attendance_by_section` | 404 `Query ... not found` |
| `enrollment_window` | 404 `Query ... not found` |
| `period_structure` | 404 `Query ... not found` |
| `roster` (control, already installed) | 400, rejected the argument, so it EXISTS |

The control row is what makes the other four meaningful. An installed query on
the same token answers with an argument error, not a 404, so a 404 means the
query is genuinely absent rather than the credential being wrong.

**Consequence, stated plainly.** PowerQueries travel inside the plugin zip.
Until someone rebuilds the plugin, bumps the version, re-uploads the zip and
has a PowerSchool admin disable and re-enable it, these four queries are
unreachable by any caller. Nothing in `run-queries.ts` or `sync-to-app.ts`
references them either. Both of those files are outside this piece's ownership,
so the one line each would need is proposed as a diff, not applied.

**What that means for confidence.** Static analysis proves every column the SQL
touches is granted, that the bind variables are declared, and that the column
count and order match. It cannot prove Oracle parses the statement. The
`GREATEST`/`LEAST`/`NVL` date arithmetic in `enrollment_window` and the `NVL`
inside `period_structure`'s `GROUP BY` are the two places a runtime surprise is
most likely. To close that gap without an install, the join at the heart of the
top ranked query was executed a different way: see section 1.

### How the credential was resolved

Two routes work, and which one answers depends on the 1Password session state of
the machine, so both are recorded.

**Route A, the `.env` as committed.** `config.ts` resolves the `op://` references
in `powerschool/sync/.env` with `op read` at point of use. In this round that
succeeded on the first attempt and no override was needed:

```
cd powerschool/sync
node --env-file=.env src/expansion-probe.ts
```

**Route B, when `op read` cannot answer.** An earlier round of this piece hit
`authorization timeout` from the desktop app fallback, because the only
1Password identity present was a service account scoped to a vault that does not
hold the PowerSchool credential. The same two values are also set as environment
variables on the Convex production deployment `quick-cassowary-644`, which the
local Convex CLI token can read. Node's `--env-file` does not override variables
already present in the parent environment, so they take precedence over the
`op://` placeholders without `.env` changing:

```
export CONVEX_DEPLOYMENT=prod:quick-cassowary-644
cd powerschool/sync
PS_CLIENT_ID="$(cd ../.. && npx convex env get PS_CLIENT_ID)" \
PS_CLIENT_SECRET="$(cd ../.. && npx convex env get PS_CLIENT_SECRET)" \
  node --env-file=.env src/expansion-probe.ts
```

Under either route the values are read at point of use and never written to a
file, a log, this document or a commit. This repo is public.

The probe is GET only apart from those five named query POSTs, it inherits the
`ReadOnlyViolation` guard in `client.ts`, and it rewrites only the section of
this file below the probe marker.

---

## 0. The COURSES join. A defect in this file, and still live in the sibling file

This section is first because it changes numbers the project treats as settled.

### What the predicate does

`roster` and `grades` in `powerschool/plugin/queries_root/wildcathub.named_queries.xml`
both join `COURSES` like this, and the first version of this file copied it into
`attendance_by_section` and `period_structure` without checking it:

```sql
JOIN COURSES C ON C.COURSE_NUMBER = SEC.COURSE_NUMBER
              AND C.SCHOOLID      = SEC.SCHOOLID
```

**130 of the 484 `COURSES` rows in this instance are district level and carry
`SCHOOLID` 0.** Westbrook sections point straight at them. `0 = 1817` is false,
so the inner join on equality throws every one of those enrollments away and
raises nothing.

Measured on live term 3601, the current school year, by replaying both
predicates against real rows:

| Measure | Equality predicate | OR predicate | LEFT JOIN, shipped |
|---|---:|---:|---:|
| `SECTIONS` surviving, of 231 | **146** | 229 | 231 |
| Live `CC` rows surviving, of 5767 | **3805** | 5747 | 5767 |

1962 live enrollments dropped, **34.0 percent**, touching **639 of 641
students**.

### The part that is not about this file

The brief handed this piece "3805 enrollments, 145 sections" as **facts already
established**. Replaying the shipped predicate returns exactly **3805** and
**146**.

**Those established facts are measurements of the defect, not measurements of
the school.** The school has **5767 live enrollments across 231 sections**.
Anything in this project calibrated against 3805 needs revisiting: row counts in
`docs/access-gap.md`, any sync volume expectation, any "did we get everything"
check that compares a Convex table size against 3805 and concludes yes.

The fix for the sibling file is written out as a diff at the bottom of this
document. It is **not applied**, because that file is shared and off limits to
this piece.

### What it would have cost the two capabilities ranked highest

- **Attendance per section, rank 1.** Re-aggregating the same real attendance
  rows under the equality predicate gives 1123 (student, section) pairs and 1779
  section absent days, against 1671 pairs and 2626 on the corrected basis. The
  shipped defect would have **hidden 847 absent days, 32 percent**, for
  essentially every student, on day one. That is worse than not shipping the
  capability, because the number would have looked plausible.
- **Period vocabulary, rank 2.** Period token `9` carries 340 enrollments and
  lives **entirely** inside the dropped set, so the query whose stated job is to
  diff the hand maintained bell schedule against reality could not see an entire
  period of the school day. Every other token would have been under counted by
  20 to 50 percent.

| Period token | Live CC rows | Surviving the equality predicate |
|---|---:|---:|
| `1` | 641 | 301 |
| `2` | 641 | 488 |
| `3` | 641 | 498 |
| `4` | 641 | 405 |
| `5` | 641 | 498 |
| `6` | 639 | 546 |
| `7` | 641 | 487 |
| `8` | 301 | 281 |
| `9` | 340 | **0, invisible** |
| `10` | 641 | 301 |

### Why the fix is an OR *and* a LEFT JOIN

The OR is safe. No `course_number` in this instance exists at both the school and
at `SCHOOLID` 0, and no `course_number` appears twice at the same `SCHOOLID`, so
the OR cannot multiply rows. Both measured, and the probe re-checks the fan out
on every run rather than trusting this paragraph.

The OR alone is still not enough. Two Westbrook sections resolve to no course
even with it, because `course_number` `7002A` ("RSP A") is defined only at school
1818. Those two sections carry 20 students. A missing lookup row is a reason to
render a blank course name; it is never a reason to drop a child's attendance.
So the shipped join is:

```sql
LEFT JOIN COURSES C ON C.COURSE_NUMBER = SEC.COURSE_NUMBER
                   AND (C.SCHOOLID = SEC.SCHOOLID OR C.SCHOOLID = 0)
```

and `course_number` in `attendance_by_section` now comes from `SECTIONS`, which
always has one, so only `course_name` can be null.

### One basis, stated in all three descriptions

The critic that caught this also caught that `enrollment_window.section_count`
had no `COURSES` join at all, so it counted on the 5767 basis while
`attendance_by_section` counted on 3805. Two queries in one file disagreeing
about how many sections a student has is its own bug.

All three now count the same population: **every `CC` row for the term whose
`DATELEFT` is null or in the future.** That required one more change than the
join, which is easy to miss: `enrollment_window`'s `CC` join had no `DATELEFT`
filter, so on any term where a student had dropped a class it would have counted
one more section than `attendance_by_section`. It has one now. The offline
validator asserts all of it, so the three cannot drift apart again silently.

---

## Ranked result

Ranking rule: a capability nobody in a teacher or student dashboard will look at
is not worth a query, however easy it is to fetch. Ties break toward the cheaper
one. Every "reachable" cell below is a measurement, not a guess.

| # | Capability | Value | Reachable | Query written | What it costs |
|---|---|---|---|---|---|
| 1 | Attendance per section, not per day | **high** | **yes, verified** | yes, x2 | version bump, zero new grants |
| 2 | Period vocabulary check for ClawPass | **high** | **yes, verified** | yes | version bump, zero new grants |
| 3 | Bell schedule TIMES, to replace the hardcoded table | **high** | no, 403 | no | 7 new ViewOnly grants, diff below |
| 4 | Current enrollment window (denominators) | **low today**, medium later | **yes, verified** | yes | version bump, zero new grants |
| 5 | `accessLevelV1Api`, the capability that opens all of `/ws/v1` | medium | **no, 401** | n/a | **one plugin capability**, not a field grant |
| 6 | Transfer history (`REENROLLMENTS`) | medium | no, 403 | no | 7 new ViewOnly grants, diff below |
| 7 | Cumulative GPA | medium | no, 403 | no | 4 new ViewOnly grants, diff below |
| 8 | Assignment level grades (missing work) | medium, **deferred** | no, 403 | no | 8 new grants, worthless until the gradebook fills |
| 9 | Honor roll | low | **no, absent** | no | cannot be unlocked, the data is not here |
| 10 | Contacts and guardians | **declined** | no, 403 | no | declined on value, not on access |
| 11 | Activities | **declined** | **no, column absent** | no | the column does not exist here |
| 12 | Cafeteria and fee balances | **declined** | no, 403 | no | declined on principle |
| 13 | Health | **declined** | not probed | no | declined without probing, on purpose |

Three rows moved since the last round, each because a measurement contradicted
the argument:

- **Row 6 split off from row 4.** An earlier version sold one row as
  "enrollment history and transfers ... reachable today". That was wrong in a way
  that mattered: what is reachable today is the current enrollment WINDOW, and
  transfer history lives in `REENROLLMENTS`, which is not granted. They are now
  two rows with two different verdicts, and the query is renamed
  `enrollment_window` so its name cannot make the claim again.
- **Row 4 dropped from medium to low-today.** Measured, not assumed: across all
  644 active students there are **2** distinct entry dates, because the whole
  school rolls over on one day and the probe ran before the year opened. The
  query is correct and currently changes nothing on any screen.
- **Row 5 was promoted out of a footnote.** It sat in prose at the bottom of the
  last version as an interesting aside. That hid a cheaper trade from anyone
  reading this table top down: row 6 is priced at seven `REENROLLMENTS` field
  grants, and row 5 is **one capability toggle** that reaches the same subject
  through `/ws/v1` student expansions (`school_enrollment`,
  `initial_enrollment`). A ranking that prices one route and footnotes the other
  is not a ranking. Section 5 states the caveat that keeps it at medium rather
  than high.

Four queries ship, in `powerschool/plugin/queries_root/expansion.named_queries.xml`.
All four read only columns `plugin.xml` already grants. **Zero new `<field>`
lines.** The approval conversation for them is "accept four SELECT statements
over data you already granted", not "widen our access". Rows 3, 5, 6 and 7 are a
different and larger ask, and the request should never bundle them together.

---

## 1. Attendance per section. HIGH, and now verified end to end

### The gap

`attendance_summary` documents its own ceiling in its own comment:

> a student who misses a single period reads as one day absent

That is the difference between the two things a teacher actually distinguishes.
A student who was sick on Tuesday and a student who attended six periods and cut
third are the same number today. Only one is a behavior event, and this app
converts behavior into currency.

### The risk that had to be settled first

`ATTENDANCE.CCID` is granted and had never been read by anything, ever. If this
instance leaves it null, `attendance_by_section` returns a correct zero for every
student for the wrong reason, and the dashboard quietly reports perfect
attendance for a school with real absences. The previous round of this piece
could not settle it, and correctly flagged that the entire ranking rested on it.

**It is settled. CCID is populated on 100 of 100 sampled rows** at
`schoolid==1817`, and the values resolve: 3319 of 4000 sampled attendance rows
matched a `CC` row in the same term.

### The join, executed for real

Because the PowerQuery cannot run, the join it describes was executed a second
way: read `CC` for one term, read `ATTENDANCE` inside that term's own date
window, match on `ATTENDANCE.CCID = CC.ID`, resolve codes through
`ATTENDANCE_CODE`, group by (student, section) and count distinct dates. Same
keys, same grouping, same presence semantics as the SQL.

| Measure | Value |
|---|---:|
| Attendance rows whose CCID matched a CC row in the term | 3319 of 4000 |
| Distinct (student, section) rows produced | 1671 |
| Pairs with at least one absence | 1474 |
| Sum of per SECTION absent days | 2626 |
| Sum of per STUDENT absent days, the metric shipping today | 610 |

**Basis, stated because the previous version of this section did not state one.**
Every figure above is on the shipped basis: every `CC` row for the term, with the
`COURSES` join LEFT and its predicate allowing district level courses. The
previous version quoted the same 4.30 without saying which population it was
computed over, at a moment when the query it described was silently using a
different and smaller one. The replication was right and the query was wrong, and
nothing in the document would have told you which.

**That last pair is the argument for the whole capability.** The same underlying
rows collapse to 610 student absent days and expand to 2626 section absent days,
a factor of **4.30**. That gap is exactly the single period cut
`attendance_summary` cannot see, quantified against real Westbrook rows.

**What the defect would have cost, on the same rows.** Re-aggregating that
identical attendance sample under the equality predicate:

| Aggregation | (student, section) pairs | Section absent days |
|---|---:|---:|
| Shipped: LEFT JOIN, district courses included | 1671 | 2626 |
| Equality predicate, the defect | 1123 | 1779 |
| Absences it would have hidden | 548 | **847** |

This proves the keys join, the codes resolve and the grouping produces rows. The
replication now covers **both** joins in the statement, `ATTENDANCE` to `CC` and
`SECTIONS` to `COURSES`, because covering only the first is precisely how the
`COURSES` defect survived a full round of review. It still does not prove the SQL
parses. Only installing the plugin proves that, and this document says so rather
than blurring the two.

### The literals the SQL hardcodes, checked

`attendance_by_section` hardcodes two strings, both district configuration:
`PRESENCE_STATUS_CD = 'Absent'` and `ATT_CODE = 'T'`. If either spelling differed
here the query would return zeros and no error. Both were read back from
`ATTENDANCE_CODE` at this school: `Absent` on 58 rows, `T` on 10. The previous
round inherited the tardy rule from the sibling query file on trust; it is now
measured.

One thing that check pinned down and the sibling file did not record:
**attendance codes are configured per school AND per year**, 122 rows spanning
ten years at this school alone. A join on a code string would silently cross
years. The query joins on `ATTENDANCE_CODEID`, which is right.

### The trap in the current school year

`schoolid==1817;yearid==36` returns **zero** attendance rows. That is correct, not
broken: the 26-27 year opens 2026-08-12. Everything above was therefore measured
against `yearid==35`, which has 103,564 rows.

A dashboard shipped against the current year must render this as "not started".
Rendered as a rate it becomes 100 percent attendance for every student, which is
the single most plausible way this capability goes wrong in its first week.

---

## 2. The ClawPass period vocabulary. HIGH, and the mismatch is total

### The finding, measured

`script.js` hardcodes the bell schedule ClawPass runs on, as three literal lists
(`normal`, `minimumDay`, `assembly`) of period tokens and clock times.
`detectCurrentPeriod()` finds the period by wall clock, then does
`student.sections.find(s => s.period === currentPeriod)`. If the SIS uses a token
the app does not know, that `find` returns undefined, the code logs
`No matching section found for period` and issues the pass anyway with a null
teacher. Nothing throws.

Reading all 231 sections for this school and term:

| Source | Period tokens |
|---|---|
| PowerSchool, `schoolid==1817;termid==3601` | `1` `2` `3` `4` `5` `6` `7` `8` `9` `10` |
| `script.js` | `A1` `P1` `P2` `P3` `P4` `HPU` `P5` `P6` `A2` |

**The overlap is empty.** Not partial drift: the two lists share nothing.

Two honest caveats, because both cut against the drama:

1. The app matches against a period value from a manual CSV export, not from
   `SECTIONS.EXPRESSION` directly. The CSV may already carry translated tokens.
   What this proves is that the app's period vocabulary and the SIS's period
   vocabulary are not the same strings, and that nothing in the pipeline checks
   the mapping. It does not prove ClawPass is issuing wrong passes today.
2. The same read against the previous year's term returned the identical ten
   tokens and identical ten expressions. The last round of this piece guessed
   from an unfiltered sample that the timetable had changed shape between years.
   **That guess was wrong**, and the probe now reports "tokens added: none,
   dropped: none". The argument for reading the vocabulary from the SIS is that
   nothing checks it, not that it has already moved.

### A scoping bug worth recording, because it produced a confident wrong answer

The previous round read page 1 of `SECTIONS` with no filter and reported the
result as the Westbrook timetable. Every one of those 100 rows belonged to
**school 1818**, a different school in the same district. The conclusion was
about the wrong building. Every read in the probe is now scoped to
`PS_SCHOOL_ID` and the report states the scope it was measured under. This is a
district instance; an unscoped read is a bug, not a shortcut.

### The query that reports this vocabulary was itself under reporting it

The table above is read straight from `SECTIONS`, so it was never affected by the
`COURSES` defect and its headline conclusion stands. `period_structure`, the
query written to deliver that conclusion in production, was affected, and badly.
Counting enrollments per token instead of sections:

| Period token | Live CC rows | Surviving the equality predicate |
|---|---:|---:|
| `1` | 641 | 301 |
| `9` | 340 | **0** |
| `10` | 641 | 301 |

Token `9` sits entirely inside the dropped set. A query whose job is to diff a
hand maintained bell schedule against the SIS cannot be trusted when it cannot
see a whole period, and every other token would have been out by 20 to 50
percent. Fixed in section 0; the offline validator now fails the build if either
half of the fix is removed.

### What ships and what does not

`period_structure` returns the distinct expressions in live use with section,
student and teacher counts behind each, as an aggregate with no student
identifiers. It turns a hand maintained list into something diffable.

It does **not** fix the bell schedule times, which is the next item.

---

## 3. Bell schedule TIMES. HIGH, and here is the exact ask

`SECTIONMEETING` is genuinely absent from this instance: 404, and the probe's
control against a table nobody could have also returns 404, so that reading is
calibrated rather than assumed. The 1.0.0 validation that rejected it was right.

But the tables around it do exist. Probed column by column, `403` meaning the
column exists and the grant is missing:

| Table | Reachability |
|---|---|
| `SECTIONMEETING` | **404, absent.** Do not ask for it again. |
| `PERIOD` | exists, ungranted |
| `CYCLE_DAY` | exists, ungranted |
| `BELL_SCHEDULE` | exists, ungranted |
| `BELL_SCHEDULE_ITEMS` | exists, ungranted |

**A schema correction worth more than the grant itself.** `PERIOD` has no
`start_time` and no `end_time` in this instance; both returned 400
`is not valid column for table: Period`. The clock times live on
`BELL_SCHEDULE_ITEMS.START_TIME` and `.END_TIME`, which do exist. An access
request built on the obvious guess would have been rejected for naming columns
that are not there. Every spelling below returned 403, not 400, so this block is
already validated against the instance:

```xml
      <!-- Bell schedule. Replaces the period table hardcoded in script.js.
           PERIOD carries the vocabulary; the clock times are on
           BELL_SCHEDULE_ITEMS, not on PERIOD. Verified column by column
           against this instance on 2026-08-12: every field below answered 403
           (exists, not granted), never 400 (no such column). -->
      <field table="Period"              field="ID"               access="ViewOnly"/>
      <field table="Period"              field="Period_Number"    access="ViewOnly"/>
      <field table="Period"              field="Abbreviation"     access="ViewOnly"/>
      <field table="Period"              field="SchoolID"         access="ViewOnly"/>
      <field table="Bell_Schedule_Items" field="Period_ID"        access="ViewOnly"/>
      <field table="Bell_Schedule_Items" field="Start_Time"       access="ViewOnly"/>
      <field table="Bell_Schedule_Items" field="End_Time"         access="ViewOnly"/>
```

`CYCLE_DAY` is deliberately not in that block. It would be needed to know which
days a `(A-E)` expression actually meets, which matters for a timetable view and
does not matter for "what period is it right now". Ask for it separately if a
timetable view is ever built. Note `CYCLE_DAY.NAME` returned 400 here;
`ABBREVIATION` and `LETTER` are the columns that exist.

---

## 4. The current enrollment window. LOW today, and named accordingly

Renamed from `enrollment_history` to `enrollment_window`, because the old name
made a claim the query cannot support. `STUDENTS` holds the CURRENT enrollment
only. Prior spans at this school, which is what "transfer history" means, are in
`REENROLLMENTS`, section 6.

### What it is worth, measured rather than argued

| Population | Distinct `STUDENTS.ENTRYDATE` values |
|---|---:|
| 644 currently active students | **2** |
| all 1490 students on file, active and inactive | **103** |

`CC.DATEENROLLED` is a single value across all 5767 section enrollments in the
current term.

So the honest reading, and it points both ways:

- **Against.** Today this query returns the same window for essentially every
  student and changes no number on any screen. Anyone told it fixes skewed
  denominators would be right to ask where. It ran the day before the school year
  opened, and Westbrook rolls the whole school over together.
- **For.** It costs no new grant, and it is not measuring a column that is
  meaningless here: across every student on file that same column holds 103
  distinct entry dates. The variation arrives with the students who arrive after
  day one. The day someone enrols in October the query is already correct rather
  than needing a retrofit.

Ship it as a correct guard that is currently inert, and do not let it be sold as
a fix for a visible problem.

One naming decision worth defending: the column is
`calendar_days_enrolled_in_term`, not `days_enrolled`. School days need the
school calendar, in `CALENDAR_DAY`, which this plugin does not grant. Calling it
calendar days stops a caller dividing by it as though it were instruction days.

---

## 5. `accessLevelV1Api`. MEDIUM. One capability, not a field grant

`GET /ws/v1/district/school` returns **401** on a token that reads
`/ws/schema/table` all day:

```
{"errorMessage":{"message":"Plugin is missing required accessLevelV1Api READ permission"}}
```

Reproduced on every `/ws/v1` resource path the probe tries, including
`/ws/v1/school/{id}/student` and both expansion forms.

**Why this is a ranked row and not a footnote.** It is a plugin level capability
that gates the entire `/ws/v1` surface at once, and with it the twelve documented
student expansions: `demographics`, `addresses`, `alerts`, `phones`,
`school_enrollment`, `ethnicity_race`, `contact`, `contact_info`,
`initial_enrollment`, `schedule_setup`, `fees`, `lunch`. Section 6 prices
transfer history at seven `REENROLLMENTS` field grants. This is one toggle that
reaches the same subject through `school_enrollment` and `initial_enrollment`.
Anyone reading the ranking top down deserves to see both prices next to each
other.

**Why it stays at medium rather than replacing section 6.** Three reasons, and
the first is decisive:

1. Nobody has read a byte through it here. The expansions list is documented,
   not measured, because the 401 stops the measurement. Section 6's seven columns
   were each probed individually and returned 403, which is a stronger claim than
   anything on this row.
2. It is not a `<field>` line, so it cannot ride along in the same request as the
   grants in sections 3, 6 and 7. It is a separate conversation with whoever
   administers the plugin, and possibly with PowerSchool.
3. It arrives with `contact`, `contact_info`, `fees` and `lunch` attached.
   Sections 10 and 12 decline all four on value and on child privacy, and that
   decision does not change just because a capability made them cheap. Widening
   access to things this project has decided not to use is a cost, not a
   feature.

**One trap worth more than the row itself.** `/ws/v1/metadata` answers **200** on
the same token that gets 401 everywhere else under `/ws/v1`. A metadata call is
therefore **not** a valid smoke test for `/ws/v1` access. The next person
debugging this will try exactly that first.

---

## 6. Transfer history. MEDIUM, and the exact ask

`REENROLLMENTS` exists in this instance and is not granted. This is where a mid
year arrival is actually recorded, and it is the only source for it.

Column spellings probed one at a time. Four plausible guesses turned out to be
wrong here and must **not** appear in a request, because a request naming a
column the instance does not have is a rejected request: `yearid`, `school_year`,
`entry_comment`, `exit_comment` all returned 400. Everything below returned 403.

```xml
      <!-- Transfer history. STUDENTS carries only the CURRENT enrollment, so a
           mid year arrival or a prior span at this school is invisible without
           this table. Verified column by column on 2026-08-12: all 403.
           ReEnrollments has NO yearid and NO school_year column in this
           instance; scope by SchoolID and the date columns instead. -->
      <field table="ReEnrollments" field="StudentID"   access="ViewOnly"/>
      <field table="ReEnrollments" field="SchoolID"    access="ViewOnly"/>
      <field table="ReEnrollments" field="EntryDate"   access="ViewOnly"/>
      <field table="ReEnrollments" field="ExitDate"    access="ViewOnly"/>
      <field table="ReEnrollments" field="EntryCode"   access="ViewOnly"/>
      <field table="ReEnrollments" field="ExitCode"    access="ViewOnly"/>
      <field table="ReEnrollments" field="Grade_Level" access="ViewOnly"/>
```

Ranked below the bell schedule because a wrong hall pass happens every day and a
mid year transfer happens a few times a year.

---

## 7. Cumulative GPA. MEDIUM. Not reachable, and the ask is now validated

A raffle and rewards product has an obvious eligibility question, and GPA is the
number a school already trusts to answer it. It is also the one number here a
student would look at unprompted.

GPA is not a column on `STUDENTS`. It is computed from `STOREDGRADES`. We hold
`StoredGrades.Grade` and `.Percent`, the display values, and none of the
arithmetic columns.

**Do not compute GPA from `Percent`.** It would produce a number that disagrees
with the transcript, in a system a parent can compare against the transcript.
Either read the columns the SIS uses or do not show GPA.

All four below returned 403, so the spellings are confirmed:

```xml
      <!-- Cumulative GPA. StoredGrades.Grade and .Percent are display values;
           these four are the arithmetic the SIS itself uses. Verified column by
           column on 2026-08-12: all 403 (exist, not granted). -->
      <field table="StoredGrades" field="GPA_Points"      access="ViewOnly"/>
      <field table="StoredGrades" field="EarnedCrHrs"     access="ViewOnly"/>
      <field table="StoredGrades" field="PotentialCrHrs"  access="ViewOnly"/>
      <field table="StoredGrades" field="ExcludeFromGPA"  access="ViewOnly"/>
```

Ask for those four and nothing else. `GRADESCALEITEM` would only be needed to
recompute grade points from letters, which is the thing just ruled out, and the
probe found its two key columns absent here anyway: `grade` and `gpa_value` both
returned 400. `GRADESCALE` returned 404. That whole branch is a dead end in this
instance, which is useful to know before anyone spends a request on it.

---

## 8. Assignment level grades. MEDIUM value, DEFERRED

A missing assignment count is the most actionable number a teacher dashboard can
carry, and it is precisely what a term percent hides: 78 percent with everything
turned in and 78 percent with four zeros are different conversations.

**Deferred deliberately.** No grades exist yet; the 26-27 year opens 2026-08-12.
Spending a re-approval conversation on eight new columns before a single
assignment exists is a bad use of the scarcest resource this project has, which
is the SIS admin's willingness to re-enable the plugin.

Spellings are now checked, which is the part worth keeping from this round.
`AssignmentSection.PointsPossible` returned 400 and is **not** a column here.
`PGAssignments.DueDate` returned 400 as well, and `PGASSIGNMENTSCORES` returned
404, so the legacy PowerGrade pair is not the route. Everything below returned
403:

```xml
      <field table="AssignmentSection" field="AssignmentSectionID" access="ViewOnly"/>
      <field table="AssignmentSection" field="SectionsDCID"        access="ViewOnly"/>
      <field table="AssignmentSection" field="Name"                access="ViewOnly"/>
      <field table="AssignmentSection" field="DueDate"             access="ViewOnly"/>
      <field table="AssignmentScore"   field="AssignmentSectionID" access="ViewOnly"/>
      <field table="AssignmentScore"   field="StudentsDCID"        access="ViewOnly"/>
      <field table="AssignmentScore"   field="IsMissing"           access="ViewOnly"/>
      <field table="AssignmentScore"   field="IsExempt"            access="ViewOnly"/>
```

`ScorePoints` is deliberately absent. A missing-work count needs the flag, not
the score, and the score is the more sensitive of the two.

---

## 9 to 13. Not available, or declined, with the reason

**Honor roll. Not in this instance.** Both `HONOR_ROLL` and `STUDENTHONORROLL`
returned 404 against a probe calibrated by a control table. PowerSchool only
populates an honor roll table when a district configures honor roll methods, and
this district has not. Not a gap to close; a door with nothing behind it.

**Activities. The column does not exist here.** `STUDENTS.ACTIVITIES` returned
400 `is not valid column for table: Students`. The legacy bitmask this project
would have had to decode is simply not present, which settles the question more
cheaply than deciding whether to decode it.

**Contacts and guardians. Declined on value.** `STUDENTCONTACTASSOC` and
`PERSON` both exist and are ungranted. A teacher calling home is a real workflow;
it is not this product's workflow. The tables carry third party adult PII, the
largest new data exposure this project could take on, and they buy a points
dashboard nothing. Probed for existence only so the answer is on record. No
query, no grant requested.

**Cafeteria and fee balances. Declined on principle.** `FEE` exists and is
ungranted (`FEE.AMOUNT` is not the column name here; it returned 400).
`STUDENTFEE` returned 404. Independent of reachability: a cafeteria balance is a
debt a child cannot pay, and surfacing it inside a rewards app is a bad idea.

**Health. Not probed, on purpose.** A points and raffle dashboard has no decision
that consumes health data, and probing it against a production instance holding
real children's records would put a health table name in a request log for no
benefit anyone can name. If a use case is ever named, that conversation starts
with the registrar, not with a probe.

---

## Proposed diffs. NOT applied

Every file below is outside this piece's ownership. Each diff is written out in
full so the owner can apply it without re-deriving it, and none of them has been
touched. Ordered by consequence.

### Diff 1. The `COURSES` join in the shared query file. **Highest priority**

`powerschool/plugin/queries_root/wildcathub.named_queries.xml`. This is the live
defect described in section 0, in the `roster` and `grades` queries, on
production data, today.

```diff
--- a/powerschool/plugin/queries_root/wildcathub.named_queries.xml
+++ b/powerschool/plugin/queries_root/wildcathub.named_queries.xml
@@ -68,8 +68,8 @@ roster: <columns>
       <column column="SECTIONS.EXPRESSION">section_expression</column>
       <column column="CC.EXPRESSION">cc_expression</column>
-      <column column="COURSES.COURSE_NUMBER">course_number</column>
+      <column column="SECTIONS.COURSE_NUMBER">course_number</column>
       <column column="COURSES.COURSE_NAME">course_name</column>
       <column column="TEACHERS.ID">teacher_id</column>
@@ -101,8 +101,8 @@ roster: SELECT list
           SEC.EXPRESSION          AS section_expression,
           CC.EXPRESSION           AS cc_expression,
-          C.COURSE_NUMBER         AS course_number,
+          SEC.COURSE_NUMBER       AS course_number,
           C.COURSE_NAME           AS course_name,
           TCH.ID                  AS teacher_id,
@@ -114,8 +114,8 @@ roster: FROM clause
         JOIN CC              ON CC.STUDENTID = S.ID
         JOIN SECTIONS SEC    ON SEC.ID = CC.SECTIONID
-        JOIN COURSES C       ON C.COURSE_NUMBER = SEC.COURSE_NUMBER
-                            AND C.SCHOOLID      = SEC.SCHOOLID
+        LEFT JOIN COURSES C  ON C.COURSE_NUMBER = SEC.COURSE_NUMBER
+                            AND (C.SCHOOLID = SEC.SCHOOLID OR C.SCHOOLID = 0)
         JOIN TERMS T         ON T.ID       = CC.TERMID
                             AND T.SCHOOLID = CC.SCHOOLID
@@ -238,8 +238,8 @@ grades: <columns>
       <column column="STUDENTS.STUDENT_NUMBER">student_number</column>
       <column column="SECTIONS.ID">section_id</column>
-      <column column="COURSES.COURSE_NUMBER">course_number</column>
+      <column column="SECTIONS.COURSE_NUMBER">course_number</column>
       <column column="COURSES.COURSE_NAME">course_name</column>
       <column column="PGFINALGRADES.GRADE">current_grade</column>
@@ -252,8 +252,8 @@ grades: SELECT list
           S.STUDENT_NUMBER AS student_number,
           SEC.ID           AS section_id,
-          C.COURSE_NUMBER  AS course_number,
+          SEC.COURSE_NUMBER AS course_number,
           C.COURSE_NAME    AS course_name,
           COALESCE(PGF.GRADE,   SG.GRADE)   AS current_grade,
@@ -265,8 +265,8 @@ grades: FROM clause
         JOIN CC           ON CC.STUDENTID = S.ID
         JOIN SECTIONS SEC ON SEC.ID = CC.SECTIONID
-        JOIN COURSES C    ON C.COURSE_NUMBER = SEC.COURSE_NUMBER
-                         AND C.SCHOOLID      = SEC.SCHOOLID
+        LEFT JOIN COURSES C ON C.COURSE_NUMBER = SEC.COURSE_NUMBER
+                           AND (C.SCHOOLID = SEC.SCHOOLID OR C.SCHOOLID = 0)
         LEFT JOIN PGFINALGRADES PGF
           ON PGF.STUDENTID      = S.ID
```

`SECTIONS.COURSE_NUMBER` is already granted (`plugin.xml` line 80), so this
requests nothing new. The `<column>` attribute has to move with the `SELECT`
item because it drives permission mapping.

**Read this before applying it.** The diff is correct and it is not free:

- `roster` goes from **3805 rows to 5767**, a 52 percent increase. Whatever
  consumes `psRoster` needs to expect that. Any Convex side check that compares a
  table size against 3805 and concludes "complete" will start failing, correctly.
- `course_number` stops being null-free by accident and starts being null-free by
  construction (it comes from `SECTIONS` now); `course_name` becomes nullable for
  the 2 sections whose course lives at another school. A UI that assumes a course
  name is present needs a fallback.
- **This changes SIS sourced roster rows and nothing else.** It must not be taken
  as a reason to touch `convex/sisMerge.ts`. The allowlist there is what keeps
  6,616,500 in earned Wildcat Cash out of the SIS merge path, and 1962 extra
  roster rows is not an argument for widening it. If applying this diff appears
  to require an edit to `sisMerge.ts`, stop.
- `grades` returns no rows at all right now (the 26-27 year opened 2026-08-12
  with no grades stored), so the grades half is free to apply today and will
  never be cheaper.

### Diff 2. `plugin.xml` version bump, so the queries can ship

`powerschool/plugin/plugin.xml`. Nothing in this piece's four queries needs a new
`<field>` line; the version bump is the entire cost, because PowerQueries travel
inside the plugin zip and PowerSchool will not accept a re-upload at the same
version.

```diff
--- a/powerschool/plugin/plugin.xml
+++ b/powerschool/plugin/plugin.xml
@@ -19,7 +19,7 @@
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://plugin.powerschool.pearson.com plugin.xsd"
         name="Wildcat Hub Sync"
-        version="1.0.6"
+        version="1.1.0"
         description="Read only student and staff data sync for the Wildcat Hub teacher and admin dashboard at Westbrook Academy.">
```

Then, from `powerschool/sync`:

```
npm run build:plugin
```

`queries_root/expansion.named_queries.xml` needs no packaging change: the build
script zips the plugin directory recursively. Verified with the script's own zip
invocation rather than assumed, and the archive listing is in the verification
notes. The install itself is a PowerSchool admin action: upload, then disable and
re-enable the plugin.

### Diff 3. Wire the queries into the runner

`powerschool/sync/src/run-queries.ts`. Without this the queries are installed and
still called by nothing.

```diff
--- a/powerschool/sync/src/run-queries.ts
+++ b/powerschool/sync/src/run-queries.ts
@@ -74,6 +74,31 @@
   {
     short: "restricted",
     name: `${QUERY_PREFIX}.student_restricted`,
     args: (c) => ({ schoolid: c.schoolId }),
     covers: [7, 14],
     restricted: true,
   },
+  // Coverage expansion set. See docs/sis-expansion.md. These cover no manifest
+  // field, because the manifest predates them; `covers: []` is deliberate.
+  {
+    short: "attendance_join_health",
+    name: `${QUERY_PREFIX}.attendance_join_health`,
+    args: (c) => ({ schoolid: c.schoolId, yearid: c.yearId }),
+    covers: [],
+    restricted: false,
+  },
+  {
+    short: "attendance_by_section",
+    name: `${QUERY_PREFIX}.attendance_by_section`,
+    args: (c) => ({ schoolid: c.schoolId, termid: c.termId }),
+    covers: [],
+    restricted: false,
+  },
+  {
+    short: "enrollment_window",
+    name: `${QUERY_PREFIX}.enrollment_window`,
+    args: (c) => ({ schoolid: c.schoolId, termid: c.termId }),
+    covers: [],
+    restricted: false,
+  },
+  {
+    short: "period_structure",
+    name: `${QUERY_PREFIX}.period_structure`,
+    args: (c) => ({ schoolid: c.schoolId, termid: c.termId }),
+    covers: [],
+    restricted: false,
+  },
 ];
```

Run `attendance_join_health` first. Against the current `yearid` it returns zeros
because the year has not started; that is the expected reading, not a failure.

`sync-to-app.ts` is deliberately **not** in this diff. Writing these results into
Convex needs a table in `convex/schema.ts`, which is shared and off limits, and
it needs a decision about where per section attendance renders. Installing and
running the queries is the step that can be taken now.

### Diff 4. The em dash guard misses two files

`powerschool/sync/scripts/build-plugin.mjs` enforces the no em dash rule on
`plugin.xml` and on `wildcathub.named_queries.xml` by name. Two more query files
exist in `queries_root/` now, this piece's and the behavior piece's, and neither
is checked. A glob does not go stale.

```diff
--- a/powerschool/sync/scripts/build-plugin.mjs
+++ b/powerschool/sync/scripts/build-plugin.mjs
@@ -12,7 +12,7 @@
 import { execFileSync } from "node:child_process";
-import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
+import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
 import { dirname, resolve } from "node:path";
@@ -74,8 +74,12 @@
 const EM_DASH = "-";
 const emDashFiles = [];
-for (const file of [PLUGIN_XML, resolve(PLUGIN_DIR, "queries_root", "wildcathub.named_queries.xml")]) {
+const queriesDir = resolve(PLUGIN_DIR, "queries_root");
+const queryFiles = existsSync(queriesDir)
+  ? readdirSync(queriesDir).filter((n) => n.endsWith(".xml")).map((n) => resolve(queriesDir, n))
+  : [];
+for (const file of [PLUGIN_XML, ...queryFiles]) {
   if (existsSync(file) && readFileSync(file, "utf8").includes(EM_DASH)) {
     emDashFiles.push(file);
   }
 }
```

The `EM_DASH` line in that diff shows a plain hyphen. The real file holds the
actual character; it is written that way here so this document stays inside the
rule it is describing.

---

## What is left undone, stated rather than buried

1. **The four queries have never been executed by Oracle, so zero running
   capability has been delivered.** Everything about their SQL is verified
   statically and by replicating both of the top query's joins in JavaScript. A
   syntax error, a `GROUP BY` the optimiser rejects, or a legal join that returns
   nothing would all survive every check in this repo. Three things stand between
   these queries and a row, and only the first is inside this piece's reach: the
   file is written and validated (done), `plugin.xml` needs a version bump and a
   rebuild (diff 2, not applied, shared file), and a PowerSchool admin has to
   upload the zip and disable and re-enable the plugin (nobody in this repo can
   do that). Diffs 2 and 3 exist so the remaining two steps are mechanical.
2. **The plugin has not been rebuilt or version bumped.** `plugin.xml` is a
   shared file this piece does not own. What was verified instead is that the new
   query file would actually ship: running the build script's own `zip`
   invocation against `powerschool/plugin` produces an archive containing
   `plugin.xml` at the root and all three `queries_root/*.xml` files, this
   piece's included. That was worth checking, because the build script's em dash
   guard names one query file by hand and would have quietly skipped this one
   (diff 4).
3. **Nothing consumes these queries.** `run-queries.ts` still dispatches only
   `terms`, `roster`, `grades` and `staff`. Both it and `sync-to-app.ts` are
   outside this piece's ownership. Diff 3 covers the runner; `sync-to-app.ts`
   deliberately is not covered, because persisting these results needs a table in
   `convex/schema.ts`, which is shared and off limits.
4. **`attendance_join_health` has never returned a row**, for the same reason as
   the rest. Its purpose stands: run it first, before anyone builds a screen on
   `attendance_by_section`. What this round did instead was answer its central
   question by another route, and the answer was yes.
5. **The 681 unmatched attendance rows** in the join replication (17 percent) are
   rows inside the term's date window whose CCID points at a `CC` row in a
   different term, most likely the full year term. Harmless for a per term query,
   but it means "attendance rows in the window" and "attendance rows for this
   term's sections" are not the same set, and a caller totalling across terms
   could double count. Worth a second look before anyone aggregates.
6. **The `COURSES` defect is fixed in this file and still live in the sibling
   file.** Diff 1 is written and not applied, because that file is off limits
   here. Until someone applies it, `roster` and `grades` keep returning 3805 of
   5767 enrollments in production and reporting no error.
7. **The offline validator still cannot see everything.** It now rejects bare
   unqualified columns, which is the hole a critic walked through with
   `MIN(ROOM)`, and it fault injects both that shape and an ungranted column on
   every alias in every query. It cannot check semantics: a join predicate that
   is granted, qualified, syntactically fine and simply wrong is exactly what
   this round shipped last time, and no static check would have caught it. The
   thing that caught it was replaying the predicate against live rows, which the
   probe now does on every run.

---


<!-- PROBE OUTPUT BELOW. Everything under this line is regenerated. -->

# Probe output

Generated by `powerschool/sync/src/expansion-probe.ts`. Do not hand edit this section.
Re-run with `node --env-file=.env src/expansion-probe.ts` from `powerschool/sync`.

- Generated: 2026-08-12T06:25:33.495Z
- Instance: `lapf.powerschool.com`
- Requests this run: 381 (ceiling 3000)
- Verbs used: GET only. Zero POSTs, including named queries.

Behavior tables (LOG, GEN, INCIDENT_*) are deliberately absent. Another piece owns them.

## How to read a status code on this instance

Control probe against a table that cannot exist:

- `GET /ws/schema/table/wildcat_probe_no_such_table?projection=wildcat_probe_canary_column`
  -> **404** Resource not found

| Status | Meaning here | Fixable by editing plugin.xml |
|---|---|---|
| 200 | column exists and is granted | already done |
| 403 | table and column exist, grant missing | **yes** |
| 400 naming the table | table exists, that column does not | no, guess again |
| 405 | table exists, endpoint closed by PowerSchool | no, use a PowerQuery |
| 404 | table not reachable at this endpoint | no |

## Ranked result

| # | Capability | Value | Verdict | Cost to unlock |
|---|---|---|---|---|
| 1 | Attendance at period level rather than daily | high | REACHABLE NOW | nothing, columns already granted |
| 2 | Section meeting and period structure (bell schedule) | high | NEEDS A GRANT | plugin.xml version bump plus admin re-enable |
| 3 | Transfer history (REENROLLMENTS), and the current enrollment clip | medium | PARTLY REACHABLE | plugin.xml version bump plus admin re-enable |
| 4 | accessLevelV1Api, the plugin capability that unlocks /ws/v1 | medium | NOT PROBED | not a field grant, see the detail below |
| 5 | Cumulative GPA and credit history | medium | PARTLY REACHABLE | plugin.xml version bump plus admin re-enable |
| 6 | Assignment level and standards level grades | medium | NEEDS A GRANT | plugin.xml version bump plus admin re-enable |
| 7 | Honor roll | low | NOT IN THIS INSTANCE | cannot be unlocked, data is not here |
| 8 | Contacts and guardians | declined | NEEDS A GRANT | plugin.xml version bump plus admin re-enable |
| 9 | Activities and groups | low | TABLE EXISTS, COLUMNS UNKNOWN | unknown |
| 10 | Cafeteria and fee balances | declined | NEEDS A GRANT | plugin.xml version bump plus admin re-enable |
| 11 | Health | declined | NOT PROBED | declined |

## Evidence from real rows

Reachability is not usefulness. A granted column that is null on every row buys nothing.

### Are the four expansion PowerQueries callable on this instance?

Each name below was called for real with POST, the one verb the hard rules permit against a named query path. This is not a dry run and not a simulation.

| PowerQuery | Result |
|---|---|
| `attendance_join_health` | 404, `Query ... not found` |
| `attendance_by_section` | 404, `Query ... not found` |
| `enrollment_window` | 404, `Query ... not found` |
| `period_structure` | 404, `Query ... not found` |
| `roster` (control, already installed) | 400, rejected the argument, so the query EXISTS |

**None of the four are installed.** They live in `queries_root/` in this repo and in no running system. PowerQueries ship inside the plugin zip, so until the plugin is rebuilt, version bumped, re-uploaded and re-enabled by a PowerSchool admin, every one of them answers 404 and NO caller can reach them. The control row is the proof that a 404 means the query is absent rather than the token being wrong: an installed query on the same token answers with an argument error, not a 404.

### The COURSES join predicate, and what the equality version silently drops

Read the whole COURSES table, unscoped on purpose: 484 rows. Scoping this one read to the school would hide the finding, which is the same mistake the SQL makes.

| COURSES.SCHOOLID | Rows | Meaning |
|---|---:|---|
| `0` | 130 | **district level, invisible to an equality join** |
| `1817` | 188 | this school |
| `1818` | 166 | another school in the district |

Replayed both predicates against live rows for the configured term `3601`, in JavaScript, over the same keys the SQL joins on.

| Measure | Equality predicate (sibling file) | OR predicate (this file) | LEFT JOIN (this file, shipped) |
|---|---:|---:|---:|
| SECTIONS surviving, of 231 | 146 | 229 | 231 |
| Live CC rows surviving, of 5767 | 3805 | 5747 | 5767 |

**The equality predicate drops 1962 of 5767 live enrollments, 34.0 percent, touching 639 of 641 students.**

Two numbers above deserve to be read twice. This project's established facts are "3805 enrollments, 145 sections". The equality predicate leaves 3805 enrollments and 146 sections. Those established facts are measurements of the defect, not measurements of the school. The school has 5767 live enrollments across 231 sections.

Fan out check, because an OR that matched twice would be worse than the bug it fixes: 0 sections resolve to more than one COURSES row under the OR predicate. The OR cannot duplicate a row here.

Period tokens, counted as live CC rows. `period_structure` itself reports distinct students and distinct sections rather than raw rows, so these are the population behind those counts rather than the counts themselves.

| Period token | Live CC rows | Surviving the equality predicate |
|---|---:|---:|
| `1` | 641 | 301 |
| `2` | 641 | 488 |
| `3` | 641 | 498 |
| `4` | 641 | 405 |
| `5` | 641 | 498 |
| `6` | 639 | 546 |
| `7` | 641 | 487 |
| `8` | 301 | 281 |
| `9` | 340 | 0 **invisible** |
| `10` | 641 | 301 |

**Period `9` exists only inside the dropped set.** A period vocabulary query built on the equality predicate cannot see an entire period of the school day, and would report the rest under counted by 20 to 50 percent.

**And the OR alone is still not enough, which is why the shipped join is a LEFT JOIN.** 2 sections in this term resolve to no course even with the OR, because course number `7002A` is defined only at another school in the district. Those sections carry 20 enrollments. An INNER JOIN would drop them for a missing lookup row; a LEFT JOIN shows a blank course name and keeps the child.

### ATTENDANCE.CCID and .PERIODID are populated at this school

Scope: `schoolid==1817`. Row counts straight from the count endpoint.

| Scope | ATTENDANCE rows |
|---|---:|
| `yearid==34` | 83248 |
| `yearid==35` | 103564 |
| `yearid==36` (current) | 0 |

The CURRENT year has zero attendance rows, which is expected rather than broken: the 26-27 school year begins after this was run. Population is therefore measured against `yearid==35`, the most recent year that has data. A dashboard built on the current year must render this as "not started", never as a 100 percent attendance rate.

Sampled 100 ATTENDANCE rows at `schoolid==1817;yearid==35`.

| Column | Rows | Non null | Rate | Distinct values |
|---|---:|---:|---:|---:|
| `id` | 100 | 100 | 100% | 100 |
| `studentid` | 100 | 100 | 100% | 76 |
| `att_date` | 100 | 100 | 100% | 1 |
| `ccid` | 100 | 100 | 100% | 100 |
| `periodid` | 100 | 100 | 100% | 3 |
| `attendance_codeid` | 100 | 100 | 100% | 4 |
| `att_mode_code` | 100 | 100 | 100% | 1 |
| `yearid` | 100 | 100 | 100% | 1 |

**CCID is populated: 100 of 100 sampled rows carry one.** A per section absence count is buildable from columns already granted.

### The attendance code literals the SQL hardcodes actually exist here

122 ATTENDANCE_CODE rows at `schoolid==1817`, spanning 10 school years. Codes are configured per school AND per year, so the join must be on ATTENDANCE_CODEID and never on a code string.

| PRESENCE_STATUS_CD | Rows |
|---|---:|
| `Present` | 64 |
| `Absent` | 58 |

| ATT_CODE | Rows |
|---|---:|
| `(empty)` | 10 |
| `A` | 10 |
| `X` | 10 |
| `T` | 10 |
| `D` | 10 |
| `I` | 10 |
| `S` | 10 |
| `H` | 7 |
| `C` | 6 |
| `N` | 6 |
| `P` | 6 |
| `Q` | 6 |
| `R` | 6 |
| `U` | 6 |
| `K` | 5 |
| `F` | 4 |

`PRESENCE_STATUS_CD = 'Absent'` matches something here: **yes**
`ATT_CODE = 'T'` matches something here: **yes**

Note the semantics this pins down: `T` carries PRESENCE_STATUS_CD `Present`, so a tardy is not an absence in this instance. Counting them separately, as the query does, is correct rather than merely tidy.

### The attendance_by_section join, executed against real rows

Executed against the most recent term that has both: term `3502` (S2, yearid 35, 2026-01-12 to 2026-06-10), 3989 CC rows and 64938 ATTENDANCE rows inside the term's own date window.

| Measure | Value |
|---|---:|
| ATTENDANCE rows read (capped at 4000) | 4000 |
| CC rows read for the term | 3989 |
| ATTENDANCE_CODE rows for this school | 122 |
| Attendance rows whose CCID matched a CC row in this term | 3319 |
| Attendance rows whose CCID belonged to another term | 681 |
| Distinct (student, section) pairs produced | 1671 |
| Pairs with at least one absence | 1474 |
| Pairs with at least one tardy | 311 |
| Sum of per SECTION absent days | 2626 |
| Sum of per STUDENT absent days, the metric shipping today | 610 |

**Basis, stated because the last round did not state one.** Every number above is on the shipped basis: every CC row for the term, with the COURSES join LEFT and its predicate allowing district level courses at SCHOOLID 0. The row below is the same rows re-aggregated under the equality predicate the sibling query file ships, which is what this file would have returned before the fix.

| Aggregation | (student, section) pairs | Section absent days |
|---|---:|---:|
| Shipped: LEFT JOIN, district courses included | 1671 | 2626 |
| Equality predicate, the defect | 1123 | 1779 |
| Absences the defect would have hidden | 548 | 847 |

**The join works and returns real rows.** 3319 of 4000 sampled attendance rows resolved through CCID into a section enrollment, producing 1671 distinct (student, section) rows. This is the shape `attendance_by_section` would return.

**And it measures something the current metric cannot.** On the shipped basis the same rows collapse to 610 student absent days but expand to 2626 section absent days, a factor of 4.30. That gap IS the single period cut that `attendance_summary` cannot see, quantified. A student missing one class shows up in the section number and is invisible in the daily one.

Caveat, stated rather than buried: this is the join executed in JavaScript over paged table reads, NOT the PowerQuery executed by Oracle. It now covers both joins in the statement, ATTENDANCE to CC and SECTIONS to COURSES, because covering only the first is exactly how the COURSES defect survived a round. It proves the keys join, the codes resolve and the grouping produces rows. It does not prove the SQL parses. Only installing the plugin proves that.

### SIS period tokens versus the bell schedule hardcoded in script.js

Read 231 SECTIONS rows scoped to `schoolid==1817;termid==3601`. Distinct schoolid values in the result: 1817.
The scope matters. An earlier run of this probe read page 1 of SECTIONS with no filter, got 100 rows that all belonged to a different school in the same district, and reported them as the Westbrook timetable. Everything below is filtered.

Distinct SECTIONS.EXPRESSION values: 10.

| SECTIONS.EXPRESSION | Sections | Leading token | In the script.js bell schedule |
|---|---:|---|---|
| `1(A-E)` | 27 | `1` | **NO** |
| `10(A-E)` | 27 | `10` | **NO** |
| `2(A-E)` | 26 | `2` | **NO** |
| `5(A-E)` | 26 | `5` | **NO** |
| `7(A-E)` | 24 | `7` | **NO** |
| `3(A-E)` | 24 | `3` | **NO** |
| `4(A-E)` | 24 | `4` | **NO** |
| `6(A-E)` | 23 | `6` | **NO** |
| `8(A-E)` | 15 | `8` | **NO** |
| `9(A-E)` | 15 | `9` | **NO** |

Tokens the SIS uses that script.js does not know: `1`, `10`, `2`, `5`, `7`, `3`, `4`, `6`, `8`, `9`
Tokens script.js hardcodes that this term never shows: `A1`, `P1`, `P2`, `P3`, `P4`, `HPU`, `P5`, `P6`, `A2`

Same read against the previous year's term `3501` (221 sections, 10 distinct expressions).

| | Previous year | This year |
|---|---|---|
| Leading tokens | `1`, `10`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `9` | `1`, `10`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `9` |
| Full expressions | `1(A-E)`, `10(A-E)`, `2(A-E)`, `3(A-E)`, `4(A-E)`, `5(A-E)`, `6(A-E)`, `7(A-E)`, `8(A-E)`, `9(A-E)` | `1(A-E)`, `10(A-E)`, `2(A-E)`, `3(A-E)`, `4(A-E)`, `5(A-E)`, `6(A-E)`, `7(A-E)`, `8(A-E)`, `9(A-E)` |

Tokens added: none. Tokens dropped: none.
Whole expressions added: 0. Whole expressions dropped: 0.

### Do the granted enrollment dates carry any per student signal?

Every active student at `schoolid==1817` (644 rows) and every CC row for term `3601` (5767 rows). Not a sample.

| Table | Column | Rows | Non null | Rate | **Distinct values** |
|---|---|---:|---:|---:|---:|
| STUDENTS | `entrydate` | 644 | 644 | 100% | **2** |
| STUDENTS | `exitdate` | 644 | 644 | 100% | **2** |
| STUDENTS | `enroll_status` | 644 | 644 | 100% | **1** |
| CC | `dateenrolled` | 5767 | 5767 | 100% | **1** |
| CC | `dateleft` | 5767 | 5767 | 100% | **2** |
| CC | `expression` | 5767 | 5767 | 100% | **10** |

Most common STUDENTS.ENTRYDATE: `2026-08-12` on 643 of 644 students. Most common CC.DATEENROLLED: `2026-08-12` on 5767 of 5767 rows.

Same two columns across EVERY student on file at this school, active and inactive (1490 rows):

| Column | Rows | Distinct values |
|---|---:|---:|
| STUDENTS.`entrydate` | 1490 | 103 |
| STUDENTS.`exitdate` | 1490 | 267 |

**The honest reading: this query is correct and, today, a no-op.** Among the 644 currently active students it returns the same window for almost all of them (2 distinct entry dates, 1 distinct section enrollment dates), because this ran before the school year started and the whole school rolls over on one day. It is NOT that the column is meaningless here: across every student on file it holds 103 distinct entry dates. The variation appears as students arrive and leave during the year, not on day one.

Two consequences, and they point in opposite directions, which is why the row is ranked in the middle rather than at either end. Against it: nobody should expect a visible change on a dashboard from shipping this today, and a reviewer told it fixes skewed denominators would be right to ask where. For it: it costs no new grant, and the day a student does arrive in October it is already correct rather than needing a retrofit.

Either way it is NOT transfer history. STUDENTS holds the CURRENT enrolment only, so a student's prior spans at this school are invisible to it. Those live in REENROLLMENTS, which the reachability table above shows EXISTS here and is not granted. The ranking names the two separately for that reason.

### /ws/v1 enrollment expansions

`GET /ws/v1/district/school` -> 401
  {"errorMessage":{"message":"Plugin is missing required accessLevelV1Api READ permission"}}
  school id discovered: none

## Per capability detail

### Attendance at period level rather than daily

**Value: high.** attendance_summary counts COUNT(DISTINCT ATT_DATE), so a student who cuts one period reads identically to a student who missed the whole day. A teacher can only act on the first. ATTENDANCE.CCID and ATTENDANCE.PERIODID are already granted and used by nothing.

**Verdict: REACHABLE NOW**

| Table | Exists | Column | Reach | Status | Detail |
|---|---|---|---|---|---|
| `attendance` | yes | `ccid` | GRANTED | 200 | one row read succeeded |
| `attendance` | yes | `periodid` | GRANTED | 200 | one row read succeeded |
| `attendance` | yes | `att_date` | GRANTED | 200 | one row read succeeded |
| `attendance` | yes | `studentid` | GRANTED | 200 | one row read succeeded |
| `attendance` | yes | `attendance_codeid` | GRANTED | 200 | one row read succeeded |
| `attendance` | yes | `yearid` | GRANTED | 200 | one row read succeeded |
| `attendance` | yes | `att_mode_code` | GRANTED | 200 | one row read succeeded |
| `cc` | yes | `id` | GRANTED | 200 | one row read succeeded |
| `cc` | yes | `sectionid` | GRANTED | 200 | one row read succeeded |
| `cc` | yes | `expression` | GRANTED | 200 | one row read succeeded |
| `cc` | yes | `dateenrolled` | GRANTED | 200 | one row read succeeded |
| `cc` | yes | `dateleft` | GRANTED | 200 | one row read succeeded |

### Section meeting and period structure (bell schedule)

**Value: high.** ClawPass in script.js matches a student's section period against a bell schedule that is hardcoded in the file (A1, P1..P6, HPU, A2 with literal start and end times). If the SIS period tokens or the bell times ever move, ClawPass names the wrong teacher on a hall pass and nothing errors. A structured period source replaces a hand maintained table.

**Verdict: NEEDS A GRANT**

| Table | Exists | Column | Reach | Status | Detail |
|---|---|---|---|---|---|
| `sectionmeeting` | no | (canary only) | - | 404 | Resource not found |
| `period` | yes | `id` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `period` | yes | `dcid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `period` | yes | `period_number` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `period` | yes | `name` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `period` | yes | `abbreviation` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `period` | yes | `sort_order` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `period` | yes | `schoolid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `cycle_day` | yes | `id` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `cycle_day` | yes | `dcid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `cycle_day` | yes | `abbreviation` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `cycle_day` | yes | `letter` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `cycle_day` | yes | `day_number` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `cycle_day` | yes | `schoolid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `bell_schedule` | yes | `id` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `bell_schedule` | yes | `dcid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `bell_schedule` | yes | `name` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `bell_schedule` | yes | `schoolid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `bell_schedule_items` | yes | `id` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `bell_schedule_items` | yes | `dcid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `bell_schedule_items` | yes | `bell_schedule_id` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `bell_schedule_items` | yes | `period_id` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `bell_schedule_items` | yes | `start_time` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `bell_schedule_items` | yes | `end_time` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `calendar_day` | yes | `id` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `calendar_day` | yes | `date_value` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `calendar_day` | yes | `bell_schedule_id` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `calendar_day` | yes | `cycle_day_id` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `calendar_day` | yes | `insession` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `calendar_day` | yes | `schoolid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |

### Transfer history (REENROLLMENTS), and the current enrollment clip

**Value: medium.** Two different things share this row and the difference decides the value. The CURRENT enrollment clip (STUDENTS.ENTRYDATE, STUDENTS.EXITDATE, CC.DATEENROLLED) is already granted and in no query, but the evidence section shows it carries almost no per student variation at this school, so a denominator built from it is the same number for every student. Actual transfer history, which is what a mid year arrival looks like, lives in REENROLLMENTS, and that table is NOT granted. Do not read a delivered clip as a delivered history.

**Verdict: PARTLY REACHABLE**

| Table | Exists | Column | Reach | Status | Detail |
|---|---|---|---|---|---|
| `students` | yes | `entrydate` | GRANTED | 200 | one row read succeeded |
| `students` | yes | `exitdate` | GRANTED | 200 | one row read succeeded |
| `students` | yes | `enroll_status` | GRANTED | 200 | one row read succeeded |
| `students` | yes | `schoolid` | GRANTED | 200 | one row read succeeded |
| `reenrollments` | yes | `id` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `reenrollments` | yes | `dcid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `reenrollments` | yes | `studentid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `reenrollments` | yes | `schoolid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `reenrollments` | yes | `entrydate` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `reenrollments` | yes | `exitdate` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `reenrollments` | yes | `entrycode` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `reenrollments` | yes | `exitcode` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `reenrollments` | yes | `grade_level` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `reenrollments` | yes | `fteid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `reenrollments` | yes | `track` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |

### accessLevelV1Api, the plugin capability that unlocks /ws/v1

**Value: medium.** One capability, not a field grant, and it gates the whole /ws/v1 surface at once: the core resources and with them the twelve documented student expansions, which include school_enrollment, initial_enrollment, contact, contact_info, fees and lunch. It is ranked here rather than mentioned in prose because pricing transfer history at 7 REENROLLMENTS field grants while leaving this in a footnote hides the cheaper trade from anyone reading the ranking top down. This project would still decline contacts, fees and lunch on value grounds after the capability landed. The honest reason to want it is enrollment history.

**Not probed.** Not a table, so the table endpoint cannot probe it. It is measured instead by the /ws/v1 evidence section, which is the authority for this row: every /ws/v1 resource path answers 401 `Plugin is missing required accessLevelV1Api READ permission` on this token, while /ws/v1/metadata answers 200 on the same token. Unlocking it is a plugin capability change an admin makes, not a <field> line, so it cannot be bundled into a field grant request.

### Cumulative GPA and credit history

**Value: medium.** A raffle and rewards product has an obvious eligibility question, and GPA is the field a school already trusts for it. GPA is not a stored column on STUDENTS: it is computed from STOREDGRADES.GPA_POINTS against GRADESCALEITEM. We hold STOREDGRADES.GRADE and .PERCENT but not the GPA arithmetic columns.

**Verdict: PARTLY REACHABLE**

| Table | Exists | Column | Reach | Status | Detail |
|---|---|---|---|---|---|
| `storedgrades` | yes | `gpa_points` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `storedgrades` | yes | `earnedcrhrs` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `storedgrades` | yes | `potentialcrhrs` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `storedgrades` | yes | `excludefromgpa` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `storedgrades` | yes | `grade_level` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `storedgrades` | yes | `termid` | GRANTED | 200 | one row read succeeded |
| `gradescaleitem` | yes | `id` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `gradescaleitem` | yes | `grade` | COLUMN ABSENT | 400 | Invalid field specified: grade is not valid column for table: GradeScaleItem |
| `gradescaleitem` | yes | `gpa_value` | COLUMN ABSENT | 400 | Invalid field specified: gpa_value is not valid column for table: GradeScaleItem |
| `gradescaleitem` | yes | `cutoffpercentage` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `gradescaleitem` | yes | `gradescaleid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `gradescale` | no | (canary only) | - | 404 | Resource not found |

### Assignment level and standards level grades

**Value: medium.** A missing assignment count is the single most actionable number a teacher dashboard can show, and it is the one thing a term percent hides. PowerTeacher Pro keeps it on ASSIGNMENTSCORE.ISMISSING.

**Verdict: NEEDS A GRANT**

| Table | Exists | Column | Reach | Status | Detail |
|---|---|---|---|---|---|
| `assignmentsection` | yes | `assignmentsectionid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `assignmentsection` | yes | `sectionsdcid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `assignmentsection` | yes | `name` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `assignmentsection` | yes | `duedate` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `assignmentsection` | yes | `pointspossible` | COLUMN ABSENT | 400 | Invalid field specified: pointspossible is not valid column for table: AssignmentSection |
| `assignmentsection` | yes | `iscountedinfinalgrade` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `assignmentscore` | yes | `assignmentscoreid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `assignmentscore` | yes | `assignmentsectionid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `assignmentscore` | yes | `studentsdcid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `assignmentscore` | yes | `scorepoints` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `assignmentscore` | yes | `islate` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `assignmentscore` | yes | `ismissing` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `assignmentscore` | yes | `isexempt` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `pgassignments` | yes | `id` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `pgassignments` | yes | `sectionid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `pgassignments` | yes | `name` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `pgassignments` | yes | `pointspossible` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `pgassignments` | yes | `duedate` | COLUMN ABSENT | 400 | Invalid field specified: duedate is not valid column for table: PGAssignments |
| `pgassignmentscores` | no | (canary only) | - | 404 | Resource not found |

### Honor roll

**Value: low.** Named in the brief as a candidate. Would be a ready made reward trigger if the school already computes it. PowerSchool computes honor roll into its own table when the district has set up honor roll methods; many never do.

**Verdict: NOT IN THIS INSTANCE**

| Table | Exists | Column | Reach | Status | Detail |
|---|---|---|---|---|---|
| `honor_roll` | no | (canary only) | - | 404 | Resource not found |
| `studenthonorroll` | no | (canary only) | - | 404 | Resource not found |

### Contacts and guardians

**Value: declined.** A teacher wanting to call home is a real workflow, but it is not THIS product's workflow: Wildcat Hub awards and spends Wildcat Cash. Probed for existence only so the answer is on record, and ranked as declined below regardless of the result. Third party adult PII is the single largest new exposure this project could take on and it buys a points dashboard nothing.

**Verdict: NEEDS A GRANT**

| Table | Exists | Column | Reach | Status | Detail |
|---|---|---|---|---|---|
| `studentcontactassoc` | yes | `studentcontactassocid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `studentcontactassoc` | yes | `studentdcid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `studentcontactassoc` | yes | `personid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `person` | yes | `id` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `person` | yes | `firstname` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `person` | yes | `lastname` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `person` | yes | `isactive` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `personemailaddress` | no | (canary only) | - | 404 | Resource not found |

### Activities and groups

**Value: low.** STUDENTS.ACTIVITIES is a legacy bitmask whose meaning lives in GEN rows with Cat='activity'. GEN belongs to the behavior piece, so this probe only asks whether the STUDENTS column exists and stops there.

**Verdict: TABLE EXISTS, COLUMNS UNKNOWN**

| Table | Exists | Column | Reach | Status | Detail |
|---|---|---|---|---|---|
| `students` | yes | `activities` | COLUMN ABSENT | 400 | Invalid field specified: activities is not valid column for table: Students |

### Cafeteria and fee balances

**Value: declined.** Explicitly deranked in docs/sis-coverage.md and deranked again here. A cafeteria balance is a debt a child cannot pay; surfacing it inside a rewards app is a bad idea independent of whether it is reachable. Existence probe only, one column, so the answer is on record.

**Verdict: NEEDS A GRANT**

| Table | Exists | Column | Reach | Status | Detail |
|---|---|---|---|---|---|
| `fee` | yes | `id` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `fee` | yes | `studentid` | EXISTS, NOT GRANTED | 403 | At least one column lacks sufficient permission |
| `fee` | yes | `amount` | COLUMN ABSENT | 400 | Invalid field specified: amount is not valid column for table: Fee |
| `studentfee` | no | (canary only) | - | 404 | Resource not found |

### Health

**Value: declined.** Named in the brief as a candidate. Declined without a probe, on purpose.

**Not probed.** Not probed at all. Health data is the most sensitive category in the SIS, a points and raffle dashboard has no decision that consumes it, and probing it against a PRODUCTION instance holding real children's records would put a health table name in a request log for no benefit anyone can name. If a use case is ever named, that conversation starts with the registrar, not with a probe.

## Grants that would have to be requested

Each line below is a table and column that EXISTS in this instance and returned 403.
A `<field ... access="ViewOnly"/>` line, a version bump and an admin re-enable unlock it.

| Capability | Table | Column |
|---|---|---|
| Section meeting and period structure (bell schedule) | `period` | `id` |
| Section meeting and period structure (bell schedule) | `period` | `dcid` |
| Section meeting and period structure (bell schedule) | `period` | `period_number` |
| Section meeting and period structure (bell schedule) | `period` | `name` |
| Section meeting and period structure (bell schedule) | `period` | `abbreviation` |
| Section meeting and period structure (bell schedule) | `period` | `sort_order` |
| Section meeting and period structure (bell schedule) | `period` | `schoolid` |
| Section meeting and period structure (bell schedule) | `cycle_day` | `id` |
| Section meeting and period structure (bell schedule) | `cycle_day` | `dcid` |
| Section meeting and period structure (bell schedule) | `cycle_day` | `abbreviation` |
| Section meeting and period structure (bell schedule) | `cycle_day` | `letter` |
| Section meeting and period structure (bell schedule) | `cycle_day` | `day_number` |
| Section meeting and period structure (bell schedule) | `cycle_day` | `schoolid` |
| Section meeting and period structure (bell schedule) | `bell_schedule` | `id` |
| Section meeting and period structure (bell schedule) | `bell_schedule` | `dcid` |
| Section meeting and period structure (bell schedule) | `bell_schedule` | `name` |
| Section meeting and period structure (bell schedule) | `bell_schedule` | `schoolid` |
| Section meeting and period structure (bell schedule) | `bell_schedule_items` | `id` |
| Section meeting and period structure (bell schedule) | `bell_schedule_items` | `dcid` |
| Section meeting and period structure (bell schedule) | `bell_schedule_items` | `bell_schedule_id` |
| Section meeting and period structure (bell schedule) | `bell_schedule_items` | `period_id` |
| Section meeting and period structure (bell schedule) | `bell_schedule_items` | `start_time` |
| Section meeting and period structure (bell schedule) | `bell_schedule_items` | `end_time` |
| Section meeting and period structure (bell schedule) | `calendar_day` | `id` |
| Section meeting and period structure (bell schedule) | `calendar_day` | `date_value` |
| Section meeting and period structure (bell schedule) | `calendar_day` | `bell_schedule_id` |
| Section meeting and period structure (bell schedule) | `calendar_day` | `cycle_day_id` |
| Section meeting and period structure (bell schedule) | `calendar_day` | `insession` |
| Section meeting and period structure (bell schedule) | `calendar_day` | `schoolid` |
| Transfer history (REENROLLMENTS), and the current enrollment clip | `reenrollments` | `id` |
| Transfer history (REENROLLMENTS), and the current enrollment clip | `reenrollments` | `dcid` |
| Transfer history (REENROLLMENTS), and the current enrollment clip | `reenrollments` | `studentid` |
| Transfer history (REENROLLMENTS), and the current enrollment clip | `reenrollments` | `schoolid` |
| Transfer history (REENROLLMENTS), and the current enrollment clip | `reenrollments` | `entrydate` |
| Transfer history (REENROLLMENTS), and the current enrollment clip | `reenrollments` | `exitdate` |
| Transfer history (REENROLLMENTS), and the current enrollment clip | `reenrollments` | `entrycode` |
| Transfer history (REENROLLMENTS), and the current enrollment clip | `reenrollments` | `exitcode` |
| Transfer history (REENROLLMENTS), and the current enrollment clip | `reenrollments` | `grade_level` |
| Transfer history (REENROLLMENTS), and the current enrollment clip | `reenrollments` | `fteid` |
| Transfer history (REENROLLMENTS), and the current enrollment clip | `reenrollments` | `track` |
| Cumulative GPA and credit history | `storedgrades` | `gpa_points` |
| Cumulative GPA and credit history | `storedgrades` | `earnedcrhrs` |
| Cumulative GPA and credit history | `storedgrades` | `potentialcrhrs` |
| Cumulative GPA and credit history | `storedgrades` | `excludefromgpa` |
| Cumulative GPA and credit history | `storedgrades` | `grade_level` |
| Cumulative GPA and credit history | `gradescaleitem` | `id` |
| Cumulative GPA and credit history | `gradescaleitem` | `cutoffpercentage` |
| Cumulative GPA and credit history | `gradescaleitem` | `gradescaleid` |
| Assignment level and standards level grades | `assignmentsection` | `assignmentsectionid` |
| Assignment level and standards level grades | `assignmentsection` | `sectionsdcid` |
| Assignment level and standards level grades | `assignmentsection` | `name` |
| Assignment level and standards level grades | `assignmentsection` | `duedate` |
| Assignment level and standards level grades | `assignmentsection` | `iscountedinfinalgrade` |
| Assignment level and standards level grades | `assignmentscore` | `assignmentscoreid` |
| Assignment level and standards level grades | `assignmentscore` | `assignmentsectionid` |
| Assignment level and standards level grades | `assignmentscore` | `studentsdcid` |
| Assignment level and standards level grades | `assignmentscore` | `scorepoints` |
| Assignment level and standards level grades | `assignmentscore` | `islate` |
| Assignment level and standards level grades | `assignmentscore` | `ismissing` |
| Assignment level and standards level grades | `assignmentscore` | `isexempt` |
| Assignment level and standards level grades | `pgassignments` | `id` |
| Assignment level and standards level grades | `pgassignments` | `sectionid` |
| Assignment level and standards level grades | `pgassignments` | `name` |
| Assignment level and standards level grades | `pgassignments` | `pointspossible` |
| Contacts and guardians | `studentcontactassoc` | `studentcontactassocid` |
| Contacts and guardians | `studentcontactassoc` | `studentdcid` |
| Contacts and guardians | `studentcontactassoc` | `personid` |
| Contacts and guardians | `person` | `id` |
| Contacts and guardians | `person` | `firstname` |
| Contacts and guardians | `person` | `lastname` |
| Contacts and guardians | `person` | `isactive` |
| Cafeteria and fee balances | `fee` | `id` |
| Cafeteria and fee balances | `fee` | `studentid` |

## Run summary

```
{
  "requests": 381,
  "tokenFetches": 2,
  "totalMs": 61148,
  "slowest": {
    "method": "GET",
    "path": "/ws/schema/table/courses",
    "status": 200,
    "ms": 415,
    "rows": 100,
    "attempts": 1
  },
  "errors": 111
}
```
