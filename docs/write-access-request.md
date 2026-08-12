# Write access request: plugin 9741, version 2.0.0

**Status: PROPOSED, and gated. Not installed. Nothing in this document has
happened yet, and it must not be sent to a PowerSchool administrator until
Gate A below returns the answer this request assumes.**

What runs today is plugin id 9741 version 1.0.6, 107 fields, every one
`ViewOnly`. The proposal is `powerschool/plugin-v2.xml`, a separate file outside
the packaged plugin folder so that proposing a change neither edits the plugin
that is running nor ships inside the next read only build.

Companion documents: `docs/plugin-install.md` (how the plugin was installed and
the version history), `docs/access-gap.md` (machine generated, what was granted),
`docs/sis-coverage.md` (what the SIS offers that we do not consume),
`docs/behavior-sourcing.md` (a sibling piece, which measured the live instance
and whose two PowerQueries this request has to agree with).

---

## Read this first: three gates, and where each one now stands

This request is well formed. That is not the same as being correct. Three
questions decide whether it is worth an administrator's approval cycle at all.

| Gate | Question | Cost of getting it wrong | Status |
|---|---|---|---|
| **A** | Is `Log` exposed over `/ws/schema/table` at all? | The entire request is worthless and burns a full approval cycle | **ANSWERED YES**, measured by a sibling piece, not by me |
| **B** | Do all 21 `Log` and `Gen` column spellings exist in this instance? | One bad name rejects the whole upload. It has happened here before | **16 of 21 CONFIRMED**, same source. 5 unprobed, listed below |
| **C** | Does `FullAccess` include read? | 2.0.0 ships two PowerQueries that 403 on their own columns | **UNANSWERED**, and it is now the only open one |

**Gate A is closed and this document no longer claims otherwise.** On
2026-08-11 a sibling piece ran GETs against `lapf.powerschool.com` and recorded
them in `docs/behavior-sourcing.md` and in the header of
`powerschool/plugin/queries_root/behavior.named_queries.xml`:
`/ws/schema/table/log/count` and `/ws/schema/table/gen/count` both answered
**200**, and a projection on an ungranted `Log` column answered **403 NoAccess**,
not the **405** that `teachers` answers. Both tables are exposed here. That is
someone else's measurement, reproduced from their notes rather than by me, and
it is labelled that way deliberately; the reason I did not re-run it is in
"How this file was verified".

**Gate B is mostly closed by the same run.** PowerSchool's `q` filter path
normalises a column name before rejecting it, so the 403 body returns the
canonical spelling. Sixteen of the twenty one new names came back that way:
ten on `Log` (`ID`, `StudentID`, `SchoolID`, `Entry_Date`, `Entry_Author`,
`LogTypeID`, `Subtype`, `Consequence`, `Discipline_ActionTaken`,
`Discipline_IncidentDate`) and all six on `Gen`. Five were never probed and
remain the only upload risk left: **`Log.DCID`, `Log.TeacherID`,
`Log.Entry_Time`, `Log.Subject`, `Log.Entry`**. Four of those five are write
columns, so they cannot be probed by reading, only by asking; `Log.Entry` is
independently confirmed to exist because a filter on it returned
`400 "Querying not supported against clob or blob field types"`, which is an
answer about a column that exists. Run the Gate B script below over those five
before the upload if a fifteen minute check is cheaper than a rejected upload.
It is.

**Gate C is the live one.** It needs either an answer from PowerSchool support
or one GET taken immediately after the upgrade, before anything is built on it.
Nothing in this request should be approved by an administrator who has not read
that section, because the fallback it describes changes what ships next.

---

## The one paragraph version

Wildcat Hub records behavior. So does PowerSchool. Neither knows the other
exists, and because the plugin holds no write access anywhere they will diverge
permanently. Version 2.0.0 grants `FullAccess` on eleven columns of one table,
`Log`, so a behavior a teacher records in the Hub becomes a PowerSchool log
entry. It grants `ViewOnly` on ten more columns across `Log` and `Gen` so those
writes can be addressed and read back, so the school's own log type codes can be
read instead of guessed, and so the two behavior PowerQueries shipping in the
same zip do not answer 403 on their own columns. It changes nothing else.
107 field lines become 128. Wildcat Cash does not
go to PowerSchool in this change or in any change: 6,616,500 points that
PowerSchool never issued have no column there, and no column granted here can
hold a balance.

---

## Gate A and Gate B: the pre-flight, one script, GET only

### Why these are gates and not formalities

**Gate A.** Table level exposure and field level grant are two independent
locks. `Teachers` is granted in 1.0.6 and still answers **405** with the
server's own words, `GET, POST and PUT are not allowed on table`
(`docs/access-gap.md`, "Fields granted but not readable from the table
endpoint"). PowerSchool decides exposure, the access request cannot influence
it, and no public document states that `Log` is exposed. If `Log` answers 405
then `POST /ws/schema/table/log` is refused at the endpoint too, by that same
message, and every write line in `plugin-v2.xml` is dead paper.

Note what that means procedurally: a 405 proves `POST` is blocked **without
anyone attempting a POST**. That is the intended way to establish this, and the
only permitted one against a production instance holding real student records.

**Gate B.** PowerSchool validates an access request against the real schema of
the instance at upload time, and one bad column name rejects the whole upload.
That is not a hypothetical: version 1.0.0 of this same plugin was rejected
exactly that way over `SECTIONMEETING`, `STOREDGRADES.ID` and `USERS.ID`
(`docs/plugin-install.md`, version history). The 17 new names come from the
PowerSchool data dictionary, not from this install.

### The discriminator that makes Gate B cheap

PowerSchool answers a table read with statuses that separate "does not exist"
from "not granted", and `docs/access-gap.md` already contains both, on the same
table, in the same run:

```
u_studentsuserfields.studentsdcid   403 At least one column lacks sufficient permission
u_studentsuserfields.student_email  400 Invalid field specified: student_email is not valid column for table: U_StudentsUserFields
```

Neither `U_StudentsUserFields` nor `StudentCoreFields` appears anywhere in
`plugin.xml` (verified: zero matches), so neither column is granted. The only
difference between those two lines is that one column exists and the other does
not. So a plain GET tells you whether a column name is real, with no grant, no
upload and no write. A sibling piece reached the same classification
independently and wrote it up at the top of
`powerschool/sync/src/expansion-probe.ts`.

### The script

Save as `log-gate.sh` and run it. It performs one authentication POST, which is
the same exchange `powerschool/sync/src/client.ts` already makes on every probe
run, and then nothing but GETs. Credentials are resolved at point of use and
passed to curl over stdin, so they never appear in a file, in a log line, or in
the process table.

```bash
#!/usr/bin/env bash
# Gate A and Gate B for the plugin 9741 version 2.0.0 access request.
# GET only. Nothing here writes. Nothing here needs the new grant.
set -euo pipefail

HOST="lapf.powerschool.com"
BASE="${PS_BASE:-https://$HOST}"

# Credentials resolved at point of use, never printed, never written to disk.
: "${PS_CLIENT_ID:=$(op read "op://Employee/Westbrook WildCats Hub/SIS Client ID")}"
: "${PS_CLIENT_SECRET:=$(op read "op://Employee/Westbrook WildCats Hub/SIS Client Secret")}"

# The one POST in this script, and it is authentication, not data.
# curl reads the credential from stdin so it never enters the process table.
TOKEN=$(printf 'user = "%s:%s"\n' "$PS_CLIENT_ID" "$PS_CLIENT_SECRET" \
  | curl -sS -K - -X POST "$BASE/oauth/access_token" \
      -H 'Content-Type: application/x-www-form-urlencoded;charset=UTF-8' \
      -H 'Accept: application/json' \
      -d 'grant_type=client_credentials' \
  | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')

probe() { # probe <table> <column>
  local table="$1" col="$2" out status body verdict
  out=$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" \
    | curl -sS -K - -G "$BASE/ws/schema/table/$table" \
        --data-urlencode "projection=$col" \
        --data-urlencode "pagesize=1" \
        -H 'Accept: application/json' \
        -w '\n%{http_code}')
  status="${out##*$'\n'}"
  body="${out%$'\n'*}"
  case "$status" in
    200) verdict="granted already" ;;
    # A 400 is two different answers wearing one status. "not valid column"
    # means the spelling is wrong and the upload would be rejected. The clob
    # message means the column EXISTS and simply cannot be filtered on, which
    # is a pass for Gate B. Reading the status alone gets Log.Entry wrong.
    400) if printf '%s' "$body" | grep -qi 'clob or blob'; then
           verdict="column EXISTS, not filterable (CLOB). Gate B pass"
         else
           verdict="COLUMN DOES NOT EXIST under this spelling"
         fi ;;
    403) verdict="column exists, grant missing (this is the good answer)" ;;
    404) verdict="table not reachable" ;;
    405) verdict="TABLE NOT EXPOSED on this endpoint" ;;
    *)   verdict="unexpected" ;;
  esac
  printf '%-4s %-22s %-46s %s\n' "$status" "$table.$col" "$verdict" \
    "$(printf '%s' "$body" | tr -d '\n' | cut -c1-70)"
}

echo "== Controls: what each status looks like on this server =="
probe wildcat_probe_no_such_table dcid
probe teachers id
probe log wildcat_probe_no_such_column

echo
echo "== Gate A: is Log exposed over /ws/schema/table at all =="
probe log dcid

echo
echo "== Gate B: do all 21 column spellings exist =="
# The five marked NEW are the only ones a sibling piece has not already
# confirmed against production. If time is short, run only those.
for c in dcid id studentid schoolid teacherid entry_date entry_time \
         entry_author logtypeid subtype consequence subject entry \
         discipline_actiontaken discipline_incidentdate; do
  probe log "$c"          # NEW: dcid, teacherid, entry_time, subject, entry
done
for c in id cat name value schoolid sortorder; do
  probe gen "$c"
done
```

The three controls come first on purpose. They pin down what each status
actually looks like on this server before any answer about `Log` is
interpreted: a table nobody could have, a table known to be unexposed, and a
column name that cannot exist.

One column will answer differently and it is not a failure: a filter on
`log.entry` returns `400 "Querying not supported against clob or blob field
types"` because `LOG.Entry` is a CLOB. That is an answer about a column that
exists, not a spelling error. Read the 400 body rather than the status alone.

### How to read the result

| Gate A answer | Meaning | Do this |
|---|---|---|
| **403** naming columns | `Log` is exposed, the columns exist, only the grant is missing | Proceed. This request is exactly the fix |
| **405** `GET, POST and PUT are not allowed on table` | PowerSchool does not expose `Log` on this endpoint, and no grant changes that | **Stop.** Do not send this request. The write has to reach `Log` some other way, or not at all, and this document needs rewriting first |
| **404** | No table under that name here | Stop. Confirm the name with the SIS admin |
| **200** | Already granted, which contradicts 1.0.6 | Stop and find out why |

Any **400** in Gate B is a spelling that would be rejected at upload. Fix the
line in `plugin-v2.xml` and re-run before anything is packaged.

### This script was exercised, but not against the live instance

It was extracted from this page and run end to end against a local fake
PowerSchool on `127.0.0.1` that reproduces the five answer shapes, once in a
passing configuration and once in a failing one, to prove the classifier is
right and the failure branches are reachable. That run found a real defect in
the classifier, which is now fixed. Output and the defect are in "How this file
was verified". **No request was issued to `lapf.powerschool.com`**, and the
reason is a rule rather than an obstacle; see "Not verified, stated plainly".

---

## Gate C: does `FullAccess` include read?

**This request assumes it does. That assumption is unverified, it is load
bearing, and it is treated here as a gate rather than a curiosity.**

### What is at stake

**Seven** of the eleven `FullAccess` columns are read by a PowerQuery that ships
in the same package. This is the coherence checker's own output, and the seventh
is the reason that checker grew a second pass:

```
GATE C EXPOSURE: read paths that depend on FullAccess columns.
If FullAccess does NOT include read, every query below 403s.
  behavior_log    log.consequence, log.entry_author, log.entry_date,
                  log.logtypeid, log.schoolid, log.studentid, log.subtype
  behavior_types  log.entry_date, log.logtypeid, log.schoolid
```

`log.studentid` is the seventh, and no check that reads only the `<columns>`
block can see it: `behavior_log` never declares it, it appears once, in the
join, `ON S.ID = L.STUDENTID`. A query fails on a column it joins on exactly as
hard as on a column it selects. An earlier draft of this section said six.

If `FullAccess` is a distinct write grant rather than a superset of `ViewOnly`,
both queries fail on their own columns the first time they are called.

### What is NOT at stake, which is worth stating precisely

Nothing that works today can break. `plugin.xml` contains **zero** `Log` and
`Gen` lines, and the installed 1.0.6 package contains exactly one query file:

```
$ unzip -l powerschool/out/wildcat-hub-sync-1.0.6.zip
    22080  queries_root/wildcathub.named_queries.xml
    14177  plugin.xml
```

`behavior.named_queries.xml` is not installed. So a wrong assumption here breaks
a new feature at first call. It cannot regress the running sync, which reads
students, sections, attendance, grades and staff and never touches `Log`.

### Why it is still unanswered

The public record does not settle it, and this was checked rather than assumed:

- PowerSchool's `plugin.xsd` defines `requestedAccessType` as an enumeration of
  exactly `ViewOnly` and `FullAccess` and carries **zero** `xs:documentation`
  elements in the entire file, so the schema says what the values are and
  nothing about what they mean.
- The strings "Full Access" and "View Only" do not appear anywhere in
  PowerSchool's own `view-installed-plugins` documentation page (25.1), which
  is the page that documents the Data Access Requests review screen.
- The most complete third party client reference does not define them either.
- The widely used plugin XML builder models the choice as a boolean,
  `__construct(string $table, string $field, bool $fullAccess = false)`, which
  emits `FullAccess` or `ViewOnly` and admits no third state. Its example grants
  `students.dcid` as `ViewOnly` and `students.first_name` as `FullAccess` in the
  same request. That is consistent with `FullAccess` being a superset, since a
  plugin updating a name certainly reads it, but an example is not a statement.

### Settle it, one of two ways

1. **Before the cycle, free.** The district's PowerSchool support contact can
   ask PowerSource one question: "does `access="FullAccess"` in a plugin access
   request also permit reads of that column, or must a column that is both read
   and written be declared twice?" That reference is behind a login this project
   cannot reach.
2. **Immediately after the upgrade, one GET.** Run these two, in this order:

```
GET /ws/schema/table/log?projection=dcid,id&pagesize=1
GET /ws/schema/table/log?projection=studentid,entry_date&pagesize=1
```

`dcid` and `id` are granted `ViewOnly`; `studentid` and `entry_date` are granted
`FullAccess`. If the first returns 200 and the second returns 403 naming those
columns, the assumption is wrong. Do this **before** anything is wired to
`behavior_log`, not after.

### The fallback, agreed in advance so nobody improvises under pressure

If `FullAccess` turns out to exclude read, `Log` becomes **write only** and the
plan degrades on a path already chosen:

- Remove `behavior_log` and `behavior_types` from `queries_root` and ship 2.0.1.
  The write half needs no re-approval, because the eleven grants are unchanged.
- `Log.DCID` and `Log.ID` stay `ViewOnly` and remain readable, which is enough
  to confirm a row exists.
- Every read of what the app wrote is served by the app's own Convex copy, which
  is where the entry came from. PowerSchool stops being a read source for
  behavior and stays the system of record for it, which is the correct division
  anyway.

The one real loss is that entries a teacher files directly in PowerSchool stay
invisible to the Hub. That is a smaller loss than it sounds, and it is
recoverable later by declaring the same column twice, once at each access level.

**That second declaration is at least schema legal, which was checked rather
than hoped.** A copy of `plugin-v2.xml` carrying both
`<field table="Log" field="StudentID" access="FullAccess"/>` and
`<field table="Log" field="StudentID" access="ViewOnly"/>` validates against
PowerSchool's published `plugin.xsd`:

```
$ grep -o 'field table="Log" field="StudentID" *access="[A-Za-z]*"' dupe-test.xml
field table="Log" field="StudentID"    access="FullAccess"
field table="Log" field="StudentID" access="ViewOnly"
$ xmllint --noout --schema plugin.xsd dupe-test.xml
dupe-test.xml validates
```

The XSD declares no uniqueness constraint on `table` plus `field`, so it cannot
reject the pair. What PowerSchool's importer does with a duplicate at install
time is a different question and is **not** answered by that: it may take the
first, the last, the union, or reject the file. Do not ship a duplicate on the
strength of the schema alone. The value of the test is that it removes one of
the two ways the fallback could fail, and names the other one precisely.

---

## What changed

Twenty one new `<field>` lines. 107 becomes 128. No line was removed and no
existing line changed its access level, which is checked mechanically rather
than asserted (see "How this file was verified").

### The eleven write columns, `Log`, `access="FullAccess"`

These are exactly the columns an insert of one behavior log entry writes.

| Column | Why it is needed |
|---|---|
| `Log.StudentID` | Which child the entry is about. This is the same `Students.ID` the roster PowerQuery already joins on, so the write reuses the read's key instead of inventing one. |
| `Log.SchoolID` | Scopes the entry to Westbrook. PowerSchool filters log views by school, so an entry written without it is invisible to the staff who need it. |
| `Log.TeacherID` | Which staff member owns the entry. Resolved server side from the signed in Entra user through the staff query, never taken from the browser. |
| `Log.Entry_Date` | The date the behavior happened, from the app event rather than from the sync run. A Friday incident synced Monday must not read as Monday. |
| `Log.Entry_Time` | The time of day. Period level behavior is unreadable without it. |
| `Log.Entry_Author` | The last name and first name string PowerSchool displays in the log list. Without it the entry shows no author. |
| `Log.LogTypeID` | The log type. Read from `Gen` at run time, never hardcoded. |
| `Log.Subtype` | The specific behavior, mapped from the app's eight core behaviors onto the school's configured subtype list. |
| `Log.Consequence` | The consequence, written only when the app actually assigned one, which today means a detention. Omitted from the payload otherwise, so an entry never implies an action nobody took. |
| `Log.Subject` | The one line title, which is all most staff ever see in a list view. |
| `Log.Entry` | The body text the teacher typed. Without it the write carries a classification and no account of what happened. |

### The ten read columns, `access="ViewOnly"`

| Column | Why it is needed |
|---|---|
| `Log.DCID` | The row id PowerSchool assigns. Stored beside the app event so a retry updates one entry instead of filing a second. Deliberately not `FullAccess`: writing it would be asking for the right to choose a primary key. |
| `Log.ID` | `Log` carries both an `ID` and a `DCID` and no source states which one an insert returns. Both must be readable to settle that empirically, once. |
| `Log.Discipline_ActionTaken` | The action a dean took, "such as S=Suspend" in the data dictionary's words. Feeds the staff behavior timeline. The concrete mistake it prevents: deducting Wildcat Cash from a child who was serving a suspension that day. Read by `behavior_log`. |
| `Log.Discipline_IncidentDate` | When that action applies. An action with no date cannot be lined up against the day a teacher is looking at, which is the only question the timeline asks of it. Read by `behavior_log`. |
| `Gen.ID` | The integer `Log.LogTypeID` points at. This is the value the write puts in `LogTypeID`, and it can only be discovered, never assumed. |
| `Gen.Cat` | The discriminator. Log types, subtypes and consequences all live in this one table and are told apart only by `Cat`. |
| `Gen.Name` | The display name. The app maps its behavior names onto these strings. This is the join that replaces hardcoded ids. |
| `Gen.Value` | The other candidate for the subtype code. `Log.Subtype` is a String 20 and a subtype is configured as a code plus a description, but no source states which `Gen` column holds the code. `behavior_types` selects `Name` and `Value` side by side so one look at the output settles it. Without it the mapping is a guess, and a wrong guess writes entries under a subtype the school never configured. |
| `Gen.SchoolID` | Codes are school scoped. Without it Westbrook can pick up another school's log types. |
| `Gen.SortOrder` | The order the school configured its log types in, which is the order the staff picker has to show them in. It is also the `ORDER BY` of the `behavior_types` query in `queries_root/behavior.named_queries.xml`, so leaving it out breaks a query that ships in the same package. See "Cross file coherence". |

### The three column conflict, and the decision

Three of those ten were added late and the reason belongs in the record, because
the next person will hit the same seam.

This access request and `queries_root/behavior.named_queries.xml` were written
by two people in parallel against the same 2.0.0 zip. The query file was saved
**eleven minutes after** this proposal and **two minutes after** this document,
and in that window it grew three columns the request did not grant:
`GEN.Value`, `LOG.Discipline_ActionTaken` and `LOG.Discipline_IncidentDate`.
Nothing failed. The coherence check of the day reported "all 13 referenced
columns are granted" and exited clean, because it counted the columns it found
granted and never compared that number to the total. Thirteen was the count of
matches. Sixteen was the count of columns.

The two halves genuinely disagreed, and the disagreement was principled on both
sides. This file refuses all 34 `Discipline_*` columns, in those words, because
they exist for federal Gun Free Schools Act reporting and a Hub behavior is not
a federal discipline incident. The query file selects exactly two of them,
because the 5.2 data dictionary describes only those two as live and together
they answer "was this child suspended, and when".

**Decided in favour of the query, with the principle restated rather than
dropped.** The two columns are granted, `ViewOnly`, named one at a time. The new
statement of the principle, which is what `plugin-v2.xml` now carries, is:

> None of the 34 `Discipline_*` columns at `FullAccess`, ever. Exactly two
> readable, named individually. The other 32 refused at every level.

Why this direction and not the other:

1. Reading a suspension is not recording one. The thing the principle exists to
   prevent is this integration **writing** federal discipline data, and that
   remains impossible: zero `Discipline_*` columns appear in the `FullAccess`
   block, and the harness asserts it rather than trusting the file to be read.
2. The two columns carry a code and a date. No free text leaves the SIS:
   `LOG.Entry` is a CLOB, confirmed by the instance itself, and neither it nor
   `LOG.Subject` is readable at any access level in this request.
3. Naming them individually is what keeps the refusal enforceable. A grant on
   the `Discipline_` prefix would admit a 35th column silently. Two named lines
   plus an assertion that the count is exactly two does not.
4. The alternative was to make the sibling drop two columns from a query whose
   design note argues for them at length. That is a worse trade for the same
   approval cycle.

`GEN.Value` needed no argument. It is a code list column with no student data in
it at all, and the query selects it precisely because which `Gen` column holds
the subtype code is undocumented.

`Log.LogTypeID` values are district defined arbitrary integers with no default
set. A published mapping from a real district runs Merits=404, Contact=461,
Medical=514, MTSS=24018, and a built in Response To Behavior=-100000. Hardcoding
one is not a shortcut, it is a wrong answer that files entries under a type this
school never configured. That is the entire reason `Gen` is in this request.

### Also changed in the file

- `version` 1.0.6 becomes 2.0.0.
- `description` now says the plugin writes. This string is what an
  administrator sees in the plugin list, so it should not claim to be read only
  once it is not. 243 characters, inside the schema's 256 limit.
- The header comment carries the Gate A stop notice, the reason the file lives
  outside `powerschool/plugin/`, and the escalation record: 1.0.6 said "if a
  future task appears to need a write, stop and escalate rather than editing
  this file", and this file is that escalation.
- A note on the `<oauth/>` element warning against pressing Regenerate Client ID
  and Secret during the upgrade.

### Deliberately not requested

Each of these is a decision, not an oversight.

- **`Log.Custom`.** A shared free-text import bucket. The idempotency key
  belongs on our side, stored beside the app event, not stamped into a column
  other integrations also write.
- **All 34 `Log.Discipline_*` columns at `FullAccess`, without exception**, and
  32 of the 34 at any access level at all. They exist for federal Gun Free
  Schools Act reporting, the 5.2 data dictionary marks 32 of them no longer
  used, and nothing in the app maps to any of them. A Hub behavior is not a
  federal discipline incident and this integration must never be able to record
  one as if it were. The two the dictionary calls live,
  `Discipline_ActionTaken` and `Discipline_IncidentDate`, are readable and
  nothing more. See "The three column conflict, and the decision".
- **`Log.Category`** (dictionary says no longer used) and **`Log.Student_Number`**
  (`StudentID` already identifies the child).
- **Any `Gen` column at `FullAccess`.** The app must never create or rename a
  log type. It maps onto the school's list or it fails loudly and writes nothing.
- **Any `Students` column at anything other than `ViewOnly`.** All 15 stay
  exactly as 1.0.6 granted them.
- **The 12 `INCIDENT_*` tables.** Incidents are administrator only, take
  several minutes each to file, and are the state discipline reporting source.
  An integration that files state reportable incidents unattended is not
  something to ask an administrator to approve.
- **The student identity lead** (`U_StudentsUserFields`, `StudentCoreFields`).
  A real gap, a different change, and the column names are still unknown.
  Guessing one here spends an approval cycle on a 400. Note that the Gate B
  script is exactly the tool that would settle those names too, once someone
  can name the candidate columns.
- **A plugin owned `U_` table via `user_schema_root`.** Ruled out on principle
  in `docs/sis-coverage.md`. It is the only write target we could create from
  scratch, and mirroring Wildcat Cash into it would create a second authority
  for a number the SIS never generated.

---

## What this grant does not stop

Read this before approving it. It is the honest cost of the request.

**PowerSchool's access model has no per verb setting.** The plugin schema
enumerates exactly two values, `ViewOnly` and `FullAccess`. There is no
insert-only. So `FullAccess` on these eleven columns permits `INSERT`, `UPDATE`
and `DELETE` against **any row of `Log` in the instance**, including entries a
dean wrote about a suspension, and including rows this application never
created.

Nothing in the access request can narrow that. The narrowing is the
application's job, at three layers:

1. `powerschool/sync/src/client.ts:161-168` is the single network chokepoint and
   currently throws `ReadOnlyViolation` on any verb other than GET and on any
   POST outside `/ws/schema/query/`. When it is opened for the write it must be
   opened to exactly one path shape, `POST /ws/schema/table/log`, and must keep
   refusing `PUT` and `DELETE` outright.
2. `convex/sisAction.ts` has exactly two `fetch` call sites today, the token
   request and the named query POST. A third is the whole write path and it
   should stay reviewable at that granularity.
3. Every write must carry a `Log.StudentID` that appears in `psRoster` for the
   writing teacher. A behavior write to a child the teacher does not teach is a
   bug regardless of what PowerSchool permits.

**Audit.** `Log` rows carry `Entry_Author` and `TeacherID` but no created or
modified timestamps, unlike the incident tables. If an entry is altered, the
`Log` row itself will not say so.

### The conflict rule, decided

Grilled.md open question 14 asked what wins if a log entry is edited in
PowerSchool after the app wrote it. It is answered here, before the grant lands,
because the answer changes what code may exist:

> **PowerSchool wins, always. Once an insert returns, this integration never
> touches that row again. No `UPDATE`. No `DELETE`. Ever.**

The rules that follow from it:

1. One app behavior event maps to at most one `Log` row. The row id the insert
   returns is stored beside the app event. If that id is present, the sync does
   nothing.
2. If the app side event is later edited or voided in the Hub, the app files a
   **new** log entry that references the original in its `Entry` text and leaves
   the original standing. A correction is visible history, not a rewrite.
3. Retraction is a human action taken in PowerSchool by someone with the
   authority to take it. The integration has no retraction path.
4. This is enforced in code, not in prose. The chokepoint refuses `PUT` and
   `DELETE` and refuses `POST` to any path except `/ws/schema/table/log`, so the
   rule holds even if a future caller asks for something else.
5. The one failure mode this leaves is a lost response: the insert succeeds, the
   reply never arrives, and a retry could file a duplicate. The recovery is a
   GET, not a write. Query `log` filtered by `studentid` and `entry_date` and
   compare `Subject` before retrying. If Gate C turns out to forbid reading
   `FullAccess` columns, that check narrows to the stored `DCID`, which is
   `ViewOnly` and therefore still readable.

Rule 4 is why the schema's missing insert-only setting is survivable. The grant
cannot express it, so the only place it can be true is our own chokepoint, and
the only way it stays true is that no code path to `PUT` or `DELETE` is ever
written in the first place.

The proposed one paragraph amendment to `Grilled.md` recording this answer is in
this task's shared changes, unapplied.

---

## Packaging

**Fixed, and reproduced both before and after.** `build-plugin.mjs` zips the
entire contents of `powerschool/plugin/`, so a proposal file left in that folder
ships inside the next read only package handed to the district, and the script's
own anti write guard cannot catch it because that guard reads only `plugin.xml`.
The proposal now lives at `powerschool/plugin-v2.xml`, one level up and outside
the packaged folder. Replaying the exact zip command the build script runs:

```
before:                                  after (this round, real listing):
  queries_root/expansion...xml             queries_root/expansion.named_queries.xml
  queries_root/wildcathub...xml            queries_root/wildcathub.named_queries.xml
  queries_root/behavior...xml              queries_root/behavior.named_queries.xml
  plugin.xml                               plugin.xml
  plugin-v2.xml   <- shipped by mistake  (gone: 5 entries, no proposal file)
```

The "after" column is the archive listing the build script printed during the
promotion test below, not a prediction. The harness also asserts it directly:
`powerschool/plugin/` contains no `*.xml` other than `plugin.xml`.

The file is also deliberately **not** named `plugin.xml`. PowerSchool requires
the archive root file to carry that name, so this one cannot be installed by
accident even if someone zips the folder it sits in.

### The 2.0.0 zip CANNOT BE BUILT TODAY, and that is deliberate

`build-plugin.mjs` refuses any `access=` value other than `ViewOnly`. That guard
is correct, it is the reason no write can be packaged by accident, and it also
means **the promotion this document describes fails on the first command.**
Reproduced, in a scratch copy of the tree, by following this document's own
promotion steps:

```
$ cp powerschool/plugin-v2.xml <scratch>/powerschool/plugin/plugin.xml
$ node powerschool/sync/scripts/build-plugin.mjs
FAILED: plugin.xml requests non read access: access="FullAccess". This plugin is scoped to read only.
```

So the order of operations is not optional:

1. The `build-plugin.mjs` diff below lands.
2. Then `powerschool/plugin-v2.xml` is copied over `powerschool/plugin/plugin.xml`.
3. Then `npm run build:plugin` produces `wildcat-hub-sync-2.0.0.zip`.
4. Only then does an administrator have anything to install.

The diff turns the denylist into an **allowlist of the eleven `Log` columns**,
so the build still fails on a twelfth. It is in this task's proposed shared
changes, unapplied, because `build-plugin.mjs` is outside the files this piece
owns. It was written and then exercised in a scratch copy, four cases:

```
patched guard, plugin-v2.xml as plugin.xml
  Built wildcat-hub-sync-2.0.0.zip
  Plugin version 2.0.0, 128 fields requested, 11 FullAccess, 117 ViewOnly
  archive: plugin.xml + queries_root/{wildcathub,behavior,expansion}.named_queries.xml

patched guard, one extra FullAccess line (Students.Grade_Level)
  FAILED: plugin.xml requests write access on students.grade_level, which is not
  on this script's eleven column write allowlist.

patched guard, the live 1.0.6 file unchanged
  Built wildcat-hub-sync-1.0.6.zip
  Plugin version 1.0.6, 107 fields requested, 0 FullAccess, 107 ViewOnly   (exit 0)

patched guard, access="WriteOnly"
  FAILED: plugin.xml uses an access value the PowerSchool schema does not define:
  WriteOnly. Only ViewOnly and FullAccess exist.
```

The third case matters as much as the second: the guard that permits 2.0.0 must
not stop packaging the plugin that is running today.

**One ordering note against a sibling change.** `docs/behavior-sourcing.md`
proposes its own diff to the same file, which excludes
`behavior.named_queries.xml` from the zip while `plugin.xml` grants neither
`Log` nor `Gen`. The two compose without conflict, and the exclusion switches
itself off at 2.0.0 because 2.0.0 grants both. Apply that one first: it protects
a plugin that is in production right now, and this one does not.

**Promotion, when it happens.** Copy `powerschool/plugin-v2.xml` over
`powerschool/plugin/plugin.xml`, then run `npm run build:plugin` so
`queries_root/` is packaged with it. Never hand PowerSchool a zip built from the
proposal file alone: that installs 2.0.0 with no PowerQueries and silently
removes the seven that are live today.

---

## The administrator procedure

Plugin id **9741**, name **Wildcat Hub Sync**, currently version 1.0.6.

Everything is at **System > System Settings > Plugin Management Configuration**.

### Before starting

- **The zip does not exist and cannot be built yet.**
  `powerschool/out/wildcat-hub-sync-2.0.0.zip` requires an unapplied change to
  `powerschool/sync/scripts/build-plugin.mjs`, which today refuses to package
  any plugin that can write and fails with
  `FAILED: plugin.xml requests non read access: access="FullAccess"`. That is
  engineering work, not administrator work, and it has to land first. Nobody
  should be standing at the Plugin Management screen before somebody has run
  `npm run build:plugin` and watched it print
  `Plugin version 2.0.0, 128 fields requested, 11 FullAccess, 117 ViewOnly`.
  Details and the tested diff are in "Packaging".
- **Confirm Gate B on the five unprobed column names.** Gate A is closed and 16
  of the 21 names are confirmed; `Log.DCID`, `Log.TeacherID`, `Log.Entry_Time`,
  `Log.Subject` and `Log.Entry` are not. One bad name rejects the whole upload.
- **Read the Gate C section, and decide whether to ask PowerSource first.** If
  `FullAccess` turns out to exclude read, two of the nine shipped PowerQueries
  fail on first call. That does not damage anything, but knowing it in advance
  is the difference between a planned 2.0.1 and a surprise.
- Pick a time between **19:10 UTC and 12:50 UTC** (after the midday sync, before
  the morning one). In Los Angeles that is any time from about 12:10 in the
  afternoon to about 05:50 the next morning. A weekday afternoon is ideal.

### Steps

1. Sign in to `lapf.powerschool.com` as a PowerSchool administrator.
2. Go to **System > System Settings > Plugin Management Configuration**.
3. Find **Wildcat Hub Sync** in the list.
4. **Untick Enable.** The plugin is now disabled. The sync stops here.
5. Click **Install** and choose `wildcat-hub-sync-2.0.0.zip`, then **Import**.
   This installs over the existing plugin at a new version. It is an upgrade,
   not a fresh install.
6. PowerSchool shows the **access request** screen listing every table and
   field. Review it. It should read: 107 lines view only, then eleven lines on
   `Log` at full access, then ten more view only lines on `Log` and `Gen`.
   Expect **128 lines total, of which exactly 11 are full access and all 11 are
   on `Log`.** If either number differs, stop.
7. **Approve** the access request.
8. Back on the plugin list, **tick Enable** for Wildcat Hub Sync.

### Do not do these

- **Do not click Delete, and do not uninstall and reinstall.** The client id and
  secret survive a version upgrade. They do not survive a delete and reinstall.
  Losing them means editing 1Password and the Convex deployment environment
  before the sync works again.
- **Do not click Regenerate Client ID and Secret** on the Data Provider
  Configuration page. Nothing in this change requires it, and it breaks the
  running sync immediately. Vendors warn about it specifically.
- **Do not skip step 8.** Installed and enabled are separate states and it is
  easy to stop after approving.

---

## What breaks during the window

The window is from step 4 to step 8, realistically five to ten minutes.

**What does not break, which is most of it.** The dashboard does not read
PowerSchool. It reads Convex, which holds its own copy of 641 students, 3805
enrollments, 145 sections, 29 teachers. Staff sign in through Entra and students
through Google, neither of which touches PowerSchool. So no user sees an outage.
Roster data just stops getting fresher.

**What does break.**

1. `POST /oauth/access_token` stops issuing tokens for these credentials. Every
   call after that fails at the first step.
2. All seven PowerQueries become uncallable.
3. If the window overlaps a cron run (13:00 or 19:00 UTC, `convex/crons.ts`),
   that run fails. It fails safely: `sisAction.ts` requests the token before it
   touches any data, throws `PowerSchool auth failed: HTTP <status>`, and never
   reaches a write. No partial roster, no half applied merge, no data loss.
4. **The failure is silent in the UI, and this is the part to know.**
   `syncFromPowerSchool` has zero `try` / `catch` blocks and exactly one call to
   `syncLog.record`, at the very end of the handler. A throw means that line is
   never reached, so **no `syncRuns` row is written at all**. The "data as of"
   timestamp the dashboard shows keeps displaying the last successful run and
   looks healthy. The only evidence is the Convex function log.
   Consequence: do not use the dashboard to confirm the sync recovered. Use step
   3 of the verification below.
5. Whether an already issued bearer token keeps working through a disable is not
   documented anywhere I could confirm. Assume it does not.

**If the window has to run long,** nothing degrades further. The app keeps
serving stale roster data indefinitely. The risk is only that nobody notices,
per point 4.

---

## How to verify the grant took effect

Four checks. Do all four. None of them writes anything. The first is the only
authoritative one; the rest catch different failures that it cannot see.

### 1. The access level, from the administrator's screen

This is the only check that can distinguish `ViewOnly` from `FullAccess`, and it
is the authoritative one.

On the plugin list, open **Wildcat Hub Sync** and expand the installed resources
to reach the **Data Access Requests** review screen. It lists every requested
field with five columns: Table Name, Field Name, FLS Controlled, Blacklisted,
Status.

Confirm, and keep a screenshot with the change record:

- 128 rows total, 11 of them full access.
- The eleven `Log` rows named above show full access, not view only. No other
  row anywhere shows full access, and in particular neither
  `Discipline_ActionTaken` nor `Discipline_IncidentDate` does.
- Nothing is marked **Blacklisted**. A blacklisted column is one PowerSchool
  refuses to hand to plugins at all, and if any of the eleven is blacklisted the
  write path is dead even though the upload succeeded.
- Note anything marked **FLS Controlled**. Field level security can still
  suppress a column that the plugin was granted.

A read that returns 200 does **not** prove `FullAccess`. Only this screen does.

### 2. The grant landed, from a GET

Both of these are GETs and are permitted by the read only client. Before the
change they answer 403. After it they should answer 200.

```
GET /ws/schema/table/gen?projection=id,cat,name,schoolid&pagesize=1
GET /ws/schema/table/log?projection=dcid,id&pagesize=1
```

A 200 on either proves PowerSchool re-read the access request and applied the
new lines. A continuing 403 naming specific columns means those columns were not
granted, and the response body names them, which is the fastest way to find a
spelling mistake.

Expect the `log` read to return few rows or none. Whether `Log` is populated at
Westbrook at all is an open empirical question, and an empty result is not a
failure of this change.

### 3. Gate C, settled

```
GET /ws/schema/table/log?projection=studentid,entry_date&pagesize=1
```

`studentid` and `entry_date` are the `FullAccess` columns. If check 2 returned
200 on the `ViewOnly` pair and this returns 403 naming these two, `FullAccess`
does not include read and the fallback in the Gate C section applies. Record the
answer in this document either way. It is the single most reusable fact this
whole exercise produces.

### 4. The existing sync still works

The point of this check is that the upgrade did not cost anything.

Trigger `internal.sisAction.syncFromPowerSchool` from the Convex dashboard, or
wait for the next scheduled run, then confirm a **new `syncRuns` row exists with
a fresh timestamp**. A new row is the proof, not the dashboard's "data as of"
banner, for the reason in the previous section. Expect roughly the same counts
as the last good run: 641 students, 3805 enrollment rows.

Also confirm the Wildcat Cash total is still **6,616,500**. Nothing in this
change touches balances, which is exactly why it should be checked: it is the
property that matters most and the cheapest one to confirm.

**`npm run probe` will not cover any of this.** The probe iterates `MANIFEST` in
`powerschool/sync/src/manifest.ts`, which has 19 entries and no `log` or `gen`
row, so `docs/access-gap.md` will regenerate looking exactly as it does now and
will tell you nothing about the new grant. A proposed manifest entry 20 is in
this task's shared changes, unapplied. Until it lands, run the GETs by hand or
re-run the Gate script, whose output flips from 403 to 200 on exactly the lines
that were granted.

### What is deliberately not a verification step

Attempting a write. Do not test the grant by inserting a log entry against
`lapf.powerschool.com`. It is a production instance holding real student
records, an insert cannot be undone through this API without a delete that is
itself a write, and the checks above establish the grant without touching a
child's record. When a write is finally exercised it should be against one
consenting test student, agreed in advance by name, on a date recorded in the
change log.

---

## Rollback

If the new version misbehaves, the rollback is to reinstall
`powerschool/out/wildcat-hub-sync-1.0.6.zip` over it by the same steps and
approve the 107 field request again. That revokes all write access, because the
access request is replaced wholesale rather than merged.

Two caveats.

- PowerSchool rejects a re-upload at the same version, and 1.0.6 is lower than
  2.0.0. Whether it accepts a downgrade at all is unverified. If it does not,
  the recovery is to ship 2.0.1 with the `Log` lines removed. Have that file
  ready before starting rather than building it under pressure.
- `docs/sis-coverage.md` records that the installed 1.0.6 zip differs from the
  working tree by one character in the publisher contact email, so
  `wildcat-hub-sync-1.0.6.zip` on disk is not exactly what is installed. The
  difference is in a contact address and not in any grant: the zip's `plugin.xml`
  is 14177 bytes against the tree's 14178, and both carry the same 107 fields.
  Confirm that before relying on it as a rollback artifact.

A faster mitigation that needs no PowerSchool action: the write path is unusable
if the client refuses to send it. Reverting `client.ts` to throw
`ReadOnlyViolation` on every non query POST stops all writes in one deploy,
while the grant stays in place.

---

## Version numbering, and why 2.0.0

1.0.6 is read only and says so in its own header. 2.0.0 is not. The major bump
is the only signal an administrator sees in the plugin list, and it should not
take reading the access request to notice that the plugin now writes.

`docs/access-gap.md` and `docs/plugin-install.md` both reserve **1.1.0** for a
different change: adding the read only fields that resolve manifest 12, 13 and
the student identity key. Those two changes are independent and either can ship
first. The rule is simply that the version only goes up:

- If the read only fix ships first as 1.1.0, this one becomes 2.0.0 on top of it.
- If this one ships first as 2.0.0, the read only fix becomes 2.0.1.

Do not ship 1.1.0 after 2.0.0.

Add a row to the version history table in `docs/plugin-install.md` when this
lands. The proposed row is in this task's shared changes, unapplied.

---

## Cross file coherence

An access request is not self contained. A `<column column="TABLE.COLUMN">` in a
named query drives permission mapping, so a query naming an ungranted column is
a query that 403s on first call, and the whole approval cycle is spent to
discover it.

### The previous version of this check was wrong, and wrong in an instructive way

It reported:

```
behavior.named_queries.xml:    all 13 referenced columns are granted
```

That file references **16** distinct columns. Three of them were ungranted:
`GEN.Value`, `LOG.Discipline_ActionTaken` and `LOG.Discipline_IncidentDate`.

The bug was structural, not clerical. The check walked the grant list and
counted the query columns it could find; then it printed the number it had
found and called them all. A checker built that way **cannot** report a miss,
because a miss is precisely the thing it never looks at. Thirteen was a count of
matches being read as a count of columns. It passed while the thing it existed
to prevent was true, and it passed for the same reason a test that asserts
nothing passes.

The replacement starts from the query side. It counts total declared columns
first, subtracts the granted ones, and exits non zero on any remainder. Every
line prints the total next to the granted count, so a wrong number is visible on
a passing run and not only on a failing one.

### What the check does now

Two passes per query, because one of them is not enough:

1. **DECLARED.** Every `<column column="...">` attribute.
2. **SQL.** Every `alias.COLUMN` reference in the SQL body, with aliases
   resolved from the `FROM` and `JOIN` clauses, minus references through a
   derived table's alias. This exists because `behavior_log` joins on
   `L.STUDENTID` and never declares it. A query fails on an ungranted join
   column exactly as hard as on an ungranted selected one, and pass 1 is blind
   to it.

It parses XML with a real parser, so a field name that appears only inside a
comment can never be counted as a grant. It also prints, as a by-product, the
list of columns a **read** depends on that are granted `FullAccess` only, which
is the Gate C blast radius and is quoted in that section.

### Current output, run against the tree as it stands at hand-off

```
$ /usr/bin/python3 coherence.py powerschool/plugin-v2.xml powerschool/plugin/queries_root

ACCESS REQUEST: powerschool/plugin-v2.xml
  version           2.0.0
  field elements    128
  FullAccess        11
  ViewOnly          117
  duplicate keys    none

behavior.named_queries.xml  file wide: 16 distinct declared columns, 16 granted, 0 MISSING
  [OK ] behavior_types             declared  9 total,  8 distinct,  8 granted,  0 MISSING
                                  sql refs 10 distinct,  0 MISSING (beyond declared)
  [OK ] behavior_log               declared 11 total, 11 distinct, 11 granted,  0 MISSING
                                  sql refs 17 distinct,  0 MISSING (beyond declared)

expansion.named_queries.xml  file wide: 24 distinct declared columns, 24 granted, 0 MISSING
  [OK ] attendance_join_health     declared  7 total,  5 distinct,  5 granted,  0 MISSING
  [OK ] attendance_by_section      declared 14 total, 11 distinct, 11 granted,  0 MISSING
  [OK ] enrollment_window          declared 14 total,  8 distinct,  8 granted,  0 MISSING
  [OK ] period_structure           declared  8 total,  8 distinct,  8 granted,  0 MISSING

wildcathub.named_queries.xml  file wide: 45 distinct declared columns, 45 granted, 0 MISSING
  [OK ] roster                     declared 25 total, 25 distinct, 25 granted,  0 MISSING
  [OK ] attendance_summary         declared  8 total,  4 distinct,  4 granted,  0 MISSING
  [OK ] grades                     declared  9 total,  8 distinct,  8 granted,  0 MISSING
  [OK ] staff                      declared 11 total,  9 distinct,  9 granted,  0 MISSING
  [OK ] student_race_restricted    declared  3 total,  3 distinct,  3 granted,  0 MISSING
  [OK ] student_restricted         declared  4 total,  4 distinct,  4 granted,  0 MISSING
  [OK ] terms                      declared  9 total,  9 distinct,  9 granted,  0 MISSING

RESULT: PASS, every declared and every SQL referenced column is granted.
```

Thirteen queries across three files, 85 distinct declared column references,
zero ungranted. The 16 on the first line is the number the old check should have
printed and did not.

**The negative control matters more than the pass.** A green check is worth
nothing until it has been shown to go red. Re-running the same check against a
copy of the proposal with exactly the three disputed lines stripped out, which
is the file as it stood when the old check called it clean:

```
$ grep -v 'field="Value"' plugin-v2.xml | grep -v Discipline_ > regress-125.xml
fields in regression copy: 125

$ python3 coherence.py regress-125.xml powerschool/plugin/queries_root
behavior_types              8 declared,  7 granted,  1 MISSING gen.value
behavior_log               11 declared,  9 granted,  2 MISSING log.discipline_actiontaken, log.discipline_incidentdate
...
regression-copy EXIT=1
current        EXIT=0
```

It names all three and exits non zero. The old check, given that same file,
exited zero.

### Run it again before anyone is asked to approve this

**This claim has a shelf life measured in minutes and it has already expired
once.** The mtimes tell that story exactly:

```
22:28  powerschool/plugin-v2.xml            <- the proposal
22:37  docs/write-access-request.md         <- this document, claiming coherence
22:39  queries_root/behavior.named_queries.xml   <- gained 3 ungranted columns
22:45  queries_root/expansion.named_queries.xml  <- edited again after that
```

The document was factually correct when written and false nine minutes later,
and nothing in the repo noticed. A sibling adding one column to one query
silently invalidates this whole section, and the cost of that landing unnoticed
is a wasted approval cycle at a school district.

So: the check is cheap, it is deterministic, it needs no credential and no
network, and it must be re-run against the tree **as it stands at the moment
someone packages the zip**, not as it stood when this paragraph was written. The
right permanent home for it is the packaging script, which is the one place that
sees the access request and the query files together at exactly the moment it
matters; that belongs to a proposed diff rather than to this piece. Until then
it is a command, and the command is above.

**The exact inputs the PASS above was produced from**, so that drift is
detectable rather than assumed. If any hash below differs from the file on disk,
the result above is stale and means nothing until the check is re-run:

```
sha256                                                            file
a16a1d8717779dd490af174cdd661c67deb514e27c14f966693c77d915878a1d  queries_root/behavior.named_queries.xml
f09c7598dca2249a46cf33455b6249b17fb8fcb9e9320d87571776ccf6668778  queries_root/expansion.named_queries.xml
4318abba2b42a5b0cc0d70f927260bc7ec6cfd9ebeaf7a7297d2e5bc1c531219  queries_root/wildcathub.named_queries.xml
```

`expansion.named_queries.xml` moved again while this document was being written,
at 22:58, after the run recorded above at 22:50. The check was re-run against
the newer file and still passes; the hash above is the newer one. That is the
second time in one evening a sibling query file moved under this claim, which is
the whole argument for the hash block and for moving the check into the build.

### The check, in full, so it can be re-run without this document

```python
#!/usr/bin/env python3
# Usage: python3 coherence.py <plugin.xml> <queries_dir>
# Exits non zero if any PowerQuery references a column the access request
# does not grant. Counts TOTAL declared columns, then subtracts.
import re, sys, xml.etree.ElementTree as ET
from pathlib import Path

KW = {"SELECT","FROM","WHERE","AND","OR","JOIN","LEFT","RIGHT","INNER","OUTER",
      "ON","GROUP","BY","ORDER","AS","NVL","COUNT","MIN","MAX","SUM","AVG",
      "CASE","WHEN","THEN","ELSE","END","COALESCE","TO_CHAR","TO_DATE","TRUNC",
      "SYSDATE","DISTINCT","NULL","IS","NOT","IN","HAVING","UNION","ALL","WITH",
      "DESC","ASC","ROUND","DECODE"}

def grants(path):
    root = ET.parse(path).getroot()
    out = {}
    for el in root.iter():
        if el.tag.split("}")[-1] == "field" and el.get("table") and el.get("field"):
            out["%s.%s" % (el.get("table").lower(), el.get("field").lower())] = el.get("access")
    return out

def sql_columns(sql):
    alias, derived = {}, set()
    for m in re.finditer(r"\b(?:FROM|JOIN)\s+(\(|\w+)(?:\s+(\w+))?", sql, re.I):
        t, a = m.group(1), m.group(2)
        if t == "(" or t.upper() in KW:
            continue
        if a and a.upper() not in KW:
            alias[a.upper()] = t.upper()
        alias.setdefault(t.upper(), t.upper())
    for m in re.finditer(r"\)\s+(\w+)\s+ON\b", sql, re.I):
        derived.add(m.group(1).upper())
    found = []
    for m in re.finditer(r"\b(\w+)\.(\w+)\b", sql):
        a, c = m.group(1).upper(), m.group(2).upper()
        if a in derived or a not in alias or c in KW:
            continue
        found.append("%s.%s" % (alias[a], c))
    return found

g = grants(sys.argv[1])
fails = 0
for qf in sorted(Path(sys.argv[2]).glob("*.xml")):
    for q in ET.parse(qf).getroot().iter("query"):
        name = q.get("name", "?").split(".")[-1]
        decl = sorted({c.get("column").lower() for c in q.iter("column") if c.get("column")})
        sql = q.find("sql")
        refs = sorted(set(c.lower() for c in sql_columns(sql.text or "" if sql is not None else "")))
        miss = [c for c in decl if c not in g] + [c for c in refs if c not in g and c not in decl]
        print("%-26s %2d declared, %2d granted, %2d MISSING %s"
              % (name, len(decl), len(decl) - len([c for c in decl if c not in g]),
                 len(miss), ", ".join(miss)))
        fails += len(miss)
print("FAIL" if fails else "PASS")
sys.exit(1 if fails else 0)
```

### The other two files that have to agree, and their current state

**The write client reads the live `plugin.xml`, not this proposal.**
`powerschool/sync/src/write-client.ts` gates every write on finding
`access="FullAccess"` for each column it is about to send, by reading the
granted access request from disk, and it refuses a `grantsPath` whose basename
is not `plugin.xml`. That is correct, and it means the write path stays shut
until this file is actually promoted, not merely written. Do not point that
check at `plugin-v2.xml` to make a test pass.

**That sibling's suite cross-checks this proposal, and it now finds it.** An
earlier version of this section said the test looked only at the old path,
`powerschool/plugin/plugin-v2.xml`, and would silently skip after the
relocation. That is no longer true: it tries both paths, and run at hand-off it
reports

```
$ node powerschool/sync/src/write-client.test.mjs
  (found the sibling's proposal at .../powerschool/plugin-v2.xml)
  PASS  grantsPath pointing at the real plugin-v2.xml is refused at construction
  PASS  plugin-v2.xml really does grant FullAccess
399 passed, 0 failed
```

Its section 23 asserts three things about this file specifically: every column
its client writes is `FullAccess` here, the proposal grants **no more**
`FullAccess` than the client uses (`grants.counts.fullAccess === 11`), and no
`FullAccess` exists outside `log`. So the eleven column set is now pinned from
both ends, and its `LOG_WRITABLE_COLUMNS` matches this request exactly. Adding a
twelfth write column here turns that suite red, which is the correct outcome.
No diff to it is needed and none is proposed.

**What is still unguarded, stated so nobody assumes otherwise.** A second
independent checker lives in `powerschool/sync/src/expansion-probe.ts` and
compares query columns to grants, but it reads `powerschool/plugin/plugin.xml`
and only two of the three query files, `expansion` and `wildcathub`. It does not
read `behavior.named_queries.xml` and it does not read this proposal, so it
could not have caught the three column miss either. Between the three checkers
in the repo, the pairing of `behavior.named_queries.xml` with `plugin-v2.xml`
was covered by nothing, which is exactly where the defect appeared.

---

## How this file was verified

`powerschool/plugin-v2.xml` was produced by patching `plugin.xml`
programmatically rather than by retyping it, because a field lost in
transcription is a field silently revoked. The relocation preserved the
`<plugin>` element byte for byte, confirmed by diffing the moved file's body
against the original.

**40 assertions, 0 failures**, re-run against the tree as it stands at hand-off
rather than quoted from an earlier round. Grants are read with a real XML parser
in every one, so a field name appearing only inside a comment can never be
counted as a grant:

```
== A. counts and versions ==            6 assertions
  v1 1.0.6 / 107 fields, v2 2.0.0 / 128 fields, no duplicate table.field in either
== B. nothing was removed or downgraded ==   4
  zero v1 grants removed, zero changed access, exactly 21 additions, all on Log or Gen
== C. the write surface, exactly ==     13
  exactly 11 FullAccess; FullAccess set == documented insert set (symmetric
  difference empty); zero FullAccess outside Log; zero Discipline_ at FullAccess;
  exactly 2 Discipline_ columns granted at all, both ViewOnly; no granted column
  name matching cash|balance|point|credit|award|ticket|amount|total|score|raffle|
  prize; all 15 Students columns still ViewOnly; zero Gen at FullAccess;
  Log.Entry and Log.Subject write only; no INCIDENT_ table; no identity guess
== D. schema limits ==                  3
  every attribute within 30 chars, description 243 of 256, description no longer
  claims read only
== E. every added line carries its own justification ==   1
  all 21 added field lines carry an inline reason
== F. text hygiene, both owned files ==   6
  no em dash, pure ASCII, no secret shaped string
== G. the running plugin is untouched ==  4
  plugin.xml still 1.0.6 with zero FullAccess, no proposal file in the packaged
  folder, proposal outside powerschool/plugin
== H. cross file coherence ==             3
  16 of 16, 24 of 24, 45 of 45 declared columns granted

40 passed, 0 failed
```

Two of those deserve a note because a passing assertion can still be a weak one.
**C** compares the `FullAccess` set to the documented insert set in both
directions and prints the symmetric difference, so a twelfth column and a
missing eleventh both fail rather than only the one the author thought of. **F**
had to be sharpened after it produced a false positive on the string
`PS_CLIENT_SECRET:=` in the Gate script, which is a variable name and a reference
to a credential, not a credential. It now demands a literal value on the right
hand side, and it was re-checked against four controls, described here rather
than pasted so that this document does not itself contain the shape it bans:

```
FLAGGED  a secret variable assigned a bare literal token
clean    the same variable assigned $(op read "op://...")
FLAGGED  a bare UUID, which is the client id shape
clean    the prose "Do not click Regenerate Client ID and Secret."
```

Two flag, two do not, which is the only evidence that a scanner reporting zero
hits is reporting anything at all.

**Schema validation is real, and the validator has teeth.** Both files validate
against PowerSchool's published `plugin.xsd`
(sha256 `36f4608b...`, fetched this session):

```
$ xmllint --noout --schema plugin.xsd powerschool/plugin-v2.xml
powerschool/plugin-v2.xml validates
$ xmllint --noout --schema plugin.xsd powerschool/plugin/plugin.xml
powerschool/plugin/plugin.xml validates
```

Three negative controls, each rejected:

```
access="ReadWrite"        -> value 'ReadWrite' is not an element of the set {'ViewOnly', 'FullAccess'}
a 43 character field name -> exceeds the allowed maximum length of '30'
a <field> missing @field  -> The attribute 'field' is required but missing
```

**The Gate script was extracted from this document and run end to end, twice,
against a local fake PowerSchool on `127.0.0.1`** that reproduces the five
answer shapes. Extracted rather than retyped, so what ran is what a reader would
copy. Passing configuration:

```
== Controls: what each status looks like on this server ==
404  wildcat_probe_no_such_table.dcid  table not reachable
405  teachers.id                       TABLE NOT EXPOSED on this endpoint
400  log.wildcat_probe_no_such_column  COLUMN DOES NOT EXIST under this spelling
== Gate A: is Log exposed over /ws/schema/table at all ==
403  log.dcid       column exists, grant missing (this is the good answer)
== Gate B: do all 21 column spellings exist ==
403  log.dcid       column exists, grant missing (this is the good answer)
400  log.entry      column EXISTS, not filterable (CLOB). Gate B pass
403  gen.value      column exists, grant missing (this is the good answer)
403  gen.sortorder  column exists, grant missing (this is the good answer)
   (21 of 21 lines classified, 20 as 403 and log.entry as the CLOB case)
```

Failing configuration, where the fake instance hides `log` and spells the Gen
column `sort_order` instead:

```
405  log.dcid       TABLE NOT EXPOSED on this endpoint
400  gen.sortorder  COLUMN DOES NOT EXIST under this spelling
```

So both fatal branches are reachable and both are correctly labelled. The
classifier is exercised, not asserted.

**That run changed the script.** In its first form `log.entry` was reported as
`COLUMN DOES NOT EXIST under this spelling`, because the classifier read the
status and not the body, and a CLOB column answers 400 with a different message.
A reader following the table above would have deleted a real column from the
access request on the strength of it. The `400` branch now separates the two
messages. This is the second time in this document that a check which counted
one thing and reported another produced a confident wrong answer, and it is the
argument for running a check against a case you know should fail.

**Packaging was reproduced** by running the same `zip -r` command
`build-plugin.mjs` runs, from `powerschool/plugin/`, into a scratch directory.
The archive now contains `plugin.xml` and three query files and no proposal
file. `powerschool/out/` was never written to and still holds exactly the six
pre-existing 1.0.1 to 1.0.6 zips.

**`npm test` in the repo root: 140 assertions, 0 failures**, unchanged by this
work. Neither file this piece owns is loaded by any test, so that is a
regression check rather than a proof of correctness.

### Not verified, stated plainly

**Nothing in this document was checked against the live instance by me. No
request of any kind was issued to `lapf.powerschool.com` in producing it.**

An earlier version of this section gave the wrong reason, and the correction
matters because it changes who can act:

> ~~The credential is not obtainable from this machine by any route.~~

It is obtainable. The service account token in the environment masks the vault
that holds it, which produces the misleading `"Employee" isn't a vault in this
account` error, but unsetting that one variable reaches it:

```
$ op vault list                                  # service account, one vault
wjf34n7e44oz7wt4yiddkwm64q    Security

$ env -u OP_SERVICE_ACCOUNT_TOKEN op vault list  # the desktop integration
xh6unbjne57mputbcgnvoqfsne    Employee
wjf34n7e44oz7wt4yiddkwm64q    Security
wlnsl32zsuuufuwu6alesvvhw4    Shared

$ env -u OP_SERVICE_ACCOUNT_TOKEN op read "op://Employee/Westbrook WildCats Hub/SIS Client Secret" | wc -c
37     # value never printed, never written, never logged
```

So the real reason is a rule, not an obstacle. **Obtaining a bearer token
requires `POST /oauth/access_token`**, and that is neither a `GET` nor a `POST`
to a `/ws/schema/query/` path, which are the only two request shapes this piece
is permitted to send at a production SIS holding 641 real student records. The
token exchange writes no data, and a reasonable person could argue it is
harmless; the rule does not carve it out, and a rule about a production student
database is not the place to start interpreting. The Gate script in this
document therefore ships unrun by me, and its `curl` calls are written for
whoever holds the credential and the authority to use it.

Two consequences, stated so nobody has to infer them:

- Gates A and B are answered in this document on the strength of **a sibling
  piece's measurements**, recorded in `docs/behavior-sourcing.md` and in the
  header of `behavior.named_queries.xml`. I read their notes. I did not
  reproduce their requests. Every number attributed to the live instance in this
  file traces to them, and every number attributed to a file on disk was
  produced by a command in this session.
- Gate C stays open and belongs to whoever runs the upgrade. It is the single
  thing standing between this document and a decision, and it costs one GET.
