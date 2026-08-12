# Gauntlet report

Rollup of four parallel pieces run against the PowerSchool behavior and write
surface on 2026-08-12: `behavior-read`, `write-client`, `access-request-v2`,
`coverage-expansion`. Each ran builder against critic for three rounds.

**Scoreboard: 0 of 4 won. All four hit the round cap.** A capped round is a
loss. Every piece produced real, verified, honest work and none of it reaches a
running system, because all four end at the same place: a plugin upload that
nobody in this repo can perform.

Nothing in this report is applied. The working tree carries five new files and
five new documents; no shared file was edited; no commit, push or checkout was
made.

---

## 1. The two numbers that decide this work

### Manifest coverage: still 15 of 19. No change.

| # | Field | State after this round |
|---|---|---|
| 6 | Teacher | Granted, reads through the PowerQuery, `teachers` still 405s over `/ws/schema/table`. Unchanged. |
| 12 | IEP / Special Ed | Source still unconfirmed. Nobody asked the registrar. Unchanged. |
| 13 | 504 | Source still unconfirmed. Unchanged. |
| 19 | Student Email | Still absent from this instance. The two live leads in `docs/access-gap.md` (`u_studentsuserfields`, `studentcorefields`) were not probed by any piece. Unchanged. |

Four pieces ran and moved this number by zero. That is not an accident of
scope: none of the four was pointed at the outstanding manifest fields. It is
still worth saying plainly, because 15 of 19 is the number this project has been
quoting, and it is the same number it was quoting yesterday.

### Against the honest denominator: still 9 of 52. Still 17 percent.

`docs/sis-coverage.md` measures Wildcat Hub against the 52 distinct capability
units the published PowerSchool reference names, rather than against the 19 item
wish list we wrote ourselves.

| Framing | Before this round | After this round |
|---|---:|---:|
| Capability units consumed, of 52 | 9 (17%) | **9 (17%)** |
| Exercised by the twice daily cron | 4 (8%) | **4 (8%)** |
| Behavior and discipline surface, of 14 | 0 | **0** |
| Write paths, of 8 | 0 by design | **0 by design** |

Zero movement, and the reason is one sentence: **PowerQueries travel inside the
plugin zip, and no new plugin has been built or installed.** Six new PowerQueries
now exist in `powerschool/plugin/queries_root/` (two behavior, four expansion).
All six were called by name against the live instance and all six answered
`404 Query not found`, with the installed `roster` query as a control answering
`400` on a bad argument. They are files, not capabilities.

The count of `<field>` lines in the live `plugin.xml` is **107**, not the 108
that older docs say. The 108th `access="ViewOnly"` string is inside a comment on
line 5. Corrected here so the number stops drifting.

### Has a behavior event been written to PowerSchool and read back unchanged?

**No. Not once. Not attempted, and not possible today.**

The stronger statement is the honest one: **not a single byte of behavior data
has moved in either direction.** Wildcat Hub has never written a log entry, and
it has never read one either.

The block was proven by reading the granted access request, never by sending
anything. Run `node powerschool/sync/src/write-client.ts --explain` from
`powerschool/sync`:

```
Access request read from: powerschool/plugin/plugin.xml
Grant source:             installed (only "installed" can authorise a write)
Plugin version:           1.0.6
Version recorded as installed on the instance: 1.0.6
Source binding:           OK, this is the installed plugin at the pinned version.
Declared fields:          107 across 16 tables (107 ViewOnly, 0 FullAccess)

Grant check for the 10 columns a create would write:
  BLOCK log.StudentID          needs FullAccess, has not requested
  ... 10 of 10 blocked ...

VERDICT: 10 of 10 columns are blocked by the granted access request. Writes are
impossible today, proven by reading plugin.xml, not by sending anything.

Arming: PS_WRITE_ENABLED is not set. The write client refuses every mutating
verb by default.
```

Three independent layers hold, and all three were checked:

1. **The grant.** 107 fields, all `ViewOnly`, zero `FullAccess`. `Log` and `Gen`
   are not in the file at all.
2. **The transport.** `powerschool/sync/src/client.ts:161` throws
   `ReadOnlyViolation` on any verb other than GET, and on any POST whose path
   does not start with `/ws/schema/query/`.
3. **The caller.** `PS_WRITE_ENABLED` appears in exactly one file,
   `write-client.ts`, and is unset. Nothing in `convex/` imports the write
   client. It has no production caller of any kind.

The `6,616,500` in earned Wildcat Cash is untouched and has no SIS counterpart.
No piece proposed mirroring it, and `write-client.ts` builds its payload column
by column rather than by spreading an object, so no balance can enter a request.

---

## 2. What now works that did not before

Read "works" narrowly: it runs on this machine and produces a checkable result.
Nothing below runs in production.

### 2.1 The write block is now provable without sending a request

Before, the claim "we cannot write" rested on nobody having written the code.
Now it rests on a check that reads the installed access request and refuses.
`powerschool/sync/src/write-client.ts` (2493 lines) implements POST and PUT to
`/ws/schema/table/log` behind four gates, refuses DELETE and PATCH outright,
and pins itself to the installed plugin version so a working-tree edit cannot
fake a grant.

Evidence: `node src/write-client.test.mjs` gives **403 assertions, 0 failed,
exit 0**. `--explain` output above. The critic independently attempted origin
attacks (userinfo, prefix sharing, path traversal, percent encoded separator)
and got zero sockets opened.

**Named defect, unfixed.** The grant gate is vacuous on an empty column set. A
request declaring `columns: []` with body `{"tables":{"log":{}}}` yields
`preflight.ok = true` with zero blocks against the real installed `plugin.xml`,
and `send()` puts the POST on the wire. The gate maps over `columns`, so zero
columns means zero checks. No real row could land, because PowerSchool would
403 the ungranted table, but that is the SIS saving the client rather than the
client saving itself. **Fix this before anyone sets `PS_WRITE_ENABLED`.**

### 2.2 Which behavior model Westbrook uses is now measured, not assumed

`GET /ws/schema/table/log/count` returns `{"count":16987}`. `INCIDENT` returns
13. The count endpoint answers without a grant, so this was readable today.

Westbrook's behavior record is **`LOG`, by 16987 to 13**. Every design decision
downstream follows from that, and it was measured rather than inferred.

Still unknown: whether those 16987 rows are Westbrook's or district wide, and
whether they are recent. See 2.9.

### 2.3 Two behavior PowerQueries and a Convex ingest module exist

`powerschool/plugin/queries_root/behavior.named_queries.xml` (357 lines) holds
`behavior_log` and `behavior_types`. `convex/psBehavior.ts` (966 lines) holds
the ingest, the audience gate and the coverage record.

Evidence: `node convex/psBehavior.test.mjs` gives **300 assertions, 0 failed**.
The earned value guard is structural rather than asserted: the only `db.insert`
targets in the file are the behavior table and `appState`, and no student
balance path exists in either direction.

**What it does not do.** Nothing calls either query. `run-queries.ts` does not
know they exist. `psBehaviorLog` is not in `convex/schema.ts`. The brief's one
instance derived deliverable, the table of log entry types Westbrook actually
uses, is **blank**, at `docs/behavior-sourcing.md:855`.

### 2.4 The blank log-type table is now blocked by measurement, not by inference

This is new in this rollup. The critic's rejection turned on the builder having
declared the type table unreachable without ever issuing the one GET that would
settle it. I issued it. GET only, four requests:

```
/ws/schema/table/log/count                    -> 200  {"count":16987}
/ws/schema/table/log/count?q=logtypeid==404   -> 403  NoAccess, field LogTypeID, resource Log
/ws/schema/table/log/count?q=logtypeid==-100000 -> 403 NoAccess, field LogTypeID, resource Log
/ws/schema/table/log/count?q=schoolid==1817   -> 403  NoAccess, field SchoolID, resource Log
```

A filtered count on `LogTypeID` is refused. The candidate-integer sweep the
critic proposed cannot run. The log type vocabulary is genuinely unreadable
before the grant, and that is now a measurement rather than an argument.

### 2.5 Gate B is closed, 21 of 21. New in this rollup

`docs/write-access-request.md` shipped with five column spellings unconfirmed,
and named one bad name as the thing that rejects a whole plugin upload. Five
GETs plus a control settle it:

```
q=dcid==1          -> 403 NoAccess, field dcid,       resource Log   EXISTS
q=teacherid==1     -> 403 NoAccess, field TeacherID,  resource Log   EXISTS
q=subject==x       -> 403 NoAccess, field Subject,    resource Log   EXISTS
q=entry==x         -> 400 "Querying not supported against clob or blob field types"  EXISTS
q=entry_time==x    -> 400 "Invalid number 'x' passed for comparison to number field Entry_Time"  EXISTS
q=nosuchcolumn==x  -> 400 "Invalid field nosuchcolumn"                CONTROL, a bad name is detectable
```

The control row is what makes the other five mean anything: a wrong spelling
answers `400 Invalid field`, so a `403 NoAccess` or a type complaint is proof
the column exists.

**And it found a defect in the write client.** PowerSchool types `Log.Entry_Time`
as a **number** on this instance. `write-client.ts:1029` sends it as the string
`"15:15:00"`, with an honest `UNVERIFIED` comment at line 905 saying the wire
format was an assumption. The assumption is very likely wrong. PowerSchool's
convention for this column is seconds past midnight. The exact encoding is still
unconfirmed, because reading the column is 403, so an administrator has to read
one real row. Do that before 2.0.0 is approved, not after.

### 2.6 Four expansion PowerQueries and a live probe harness exist

`powerschool/plugin/queries_root/expansion.named_queries.xml` (447 lines):
`attendance_join_health`, `attendance_by_section`, `enrollment_window`,
`period_structure`. `powerschool/sync/src/expansion-probe.ts` (2514 lines) made
381 GET requests against the live instance to establish reachability.

Every number the builder reported reproduced exactly under the critic's own
independent script: 484 `COURSES` rows, 231 sections, 5767 live `CC` rows, 639
students affected, 1962 lost at 34.0 percent.

**Named defect, unfixed and shipped.** All three CC-touching queries carry
`AND (CC.DATELEFT IS NULL OR CC.DATELEFT >= TRUNC(SYSDATE))`
(`expansion.named_queries.xml` lines 246, 364, 440). Measured: term 3502 holds
3989 `CC` rows and 64,938 attendance rows, and the predicate drops all 3989. The
only term it passes, 3601, has zero attendance rows. **`attendance_by_section`,
the top ranked capability of that piece, cannot return a single non-zero absence
in any term.** Worse, `expansion-probe.ts:2364` asserts the predicate, so fixing
it fails the validator.

### 2.7 A live defect in the shipped roster query was found

This is the most consequential thing the round produced, and it is a discovery
rather than a fix.

`roster` and `grades` in the live `wildcathub.named_queries.xml` join `COURSES`
on `C.SCHOOLID = SEC.SCHOOLID`. **130 of 484 `COURSES` rows are district level
and carry `SCHOOLID` 0.** The equality throws every enrollment pointing at them
away and raises nothing.

| Measure | Shipped equality join | LEFT JOIN with the fix |
|---|---:|---:|
| `SECTIONS` surviving, of 231 | 146 | 231 |
| Live `CC` rows surviving, of 5767 | **3805** | 5767 |

**1962 live enrollments dropped, 34.0 percent, touching 639 of 641 students.**
The familiar 3805 enrollment figure this project quotes everywhere is that
defect's output, not the school's roster. The fix is proposed diff A below and
is not applied.

### 2.8 The `/ws/v1` surface is closed at the plugin level, and that is now known

`GET /ws/v1/district/school` returns
`401 {"errorMessage":{"message":"Plugin is missing required accessLevelV1Api READ permission"}}`
on a token that reads `/ws/schema/table` all day, reproduced on every `/ws/v1`
path tried.

This closes a ranked gap. `docs/sis-coverage.md` listed
`GET /ws/v1/student?expansions=alerts` as a cheap untried probe for discipline
alerts. It is not cheap. It needs a plugin capability that gates all twelve
documented student expansions at once, which is a separate ask from a field
grant.

### 2.9 A 2.0.0 access request proposal exists and is XSD valid

`powerschool/plugin-v2.xml` (432 lines): 128 field lines, exactly 21 additions,
zero removals, zero downgrades, exactly 11 `FullAccess` all on `Log`, exactly 2
`Discipline_` columns and both `ViewOnly`. Validates against the real PowerSchool
XSD. The critic re-derived every one of those numbers and all held.

**Three things stop it being a deliverable:**

1. **It contradicts its own companion doc.** Lines 26 to 39 carry a banner
   reading `DO NOT SEND THIS TO AN ADMINISTRATOR YET` because Gate A "has not
   been run". `docs/write-access-request.md` says Gate A is `ANSWERED YES`, and
   the doc is right. The banner is stale and points at the document that refutes
   it. Fix the banner before anyone reads the file.
2. **It cannot be packaged.** `build-plugin.mjs` refuses any `access=` value
   other than `ViewOnly` and fails with
   `FAILED: plugin.xml requests non read access: access="FullAccess"`. No 2.0.0
   zip exists or can be produced today.
3. **Gate C is open.** Nothing public states whether `FullAccess` includes read.
   Both the builder and the critic tried and failed to settle it. If it excludes
   read, both behavior PowerQueries 403 on first call the moment 2.0.0 is
   approved, because 7 of the columns `behavior_log` reads and 3 of the columns
   `behavior_types` reads are granted `FullAccess` only in that file.

---

## 3. Every proposed diff to a shared file, in one place. NOT APPLIED

Nine diffs across seven files. None is applied. Two pairs conflict with each
other and must be reconciled by a person before anything is edited.

### The conflicts, first

**Three pieces each propose a different next version of `plugin.xml`, and they
are mutually exclusive.**

| Proposal | Version | Fields | Purpose | Source |
|---|---|---|---|---|
| coverage-expansion | 1.1.0 | 107, unchanged | ship the four expansion queries | `docs/sis-expansion.md:786` |
| behavior-read | 1.1.0 | 107 + 16 ViewOnly | ship the two behavior queries and read `Log` and `Gen` | `docs/behavior-sourcing.md:600` |
| access-request-v2 | 2.0.0 | 128, 11 FullAccess | everything above plus write | `powerschool/plugin-v2.xml` |

Two of them claim the same version number for different content. Somebody has to
pick one path. See section 5, decision 1.

**Two pieces propose different edits to `build-plugin.mjs`.** They compose
without conflict if applied in the order given below, but they were written
independently and neither is aware of the third one that section 2.9 requires.

### Ordering, if the decision is "read only behavior first"

1. Diff F (package.json test wiring). Free, no risk.
2. Diff D (em dash glob) then diff E (behavior exclusion guard). Protects the
   plugin that is in production today.
3. Diff A (the COURSES fix). Highest value, and it changes roster row counts.
4. Diff B (version bump) plus diff C (runner registry).
5. Diffs G, H, I only after a plugin carrying the behavior queries is installed
   and returning rows.

---

### Diff A. `powerschool/plugin/queries_root/wildcathub.named_queries.xml`. HIGHEST PRIORITY

Fixes the live 34 percent enrollment loss described in 2.7. Source:
`docs/sis-expansion.md:707`. Requests no new grant:
`SECTIONS.COURSE_NUMBER` is already granted at `plugin.xml` line 80.

```diff
@@ roster: <columns>
-      <column column="COURSES.COURSE_NUMBER">course_number</column>
+      <column column="SECTIONS.COURSE_NUMBER">course_number</column>
@@ roster: SELECT list
-          C.COURSE_NUMBER         AS course_number,
+          SEC.COURSE_NUMBER       AS course_number,
@@ roster: FROM clause
-        JOIN COURSES C       ON C.COURSE_NUMBER = SEC.COURSE_NUMBER
-                            AND C.SCHOOLID      = SEC.SCHOOLID
+        LEFT JOIN COURSES C  ON C.COURSE_NUMBER = SEC.COURSE_NUMBER
+                            AND (C.SCHOOLID = SEC.SCHOOLID OR C.SCHOOLID = 0)
@@ grades: <columns>
-      <column column="COURSES.COURSE_NUMBER">course_number</column>
+      <column column="SECTIONS.COURSE_NUMBER">course_number</column>
@@ grades: SELECT list
-          C.COURSE_NUMBER  AS course_number,
+          SEC.COURSE_NUMBER AS course_number,
@@ grades: FROM clause
-        JOIN COURSES C    ON C.COURSE_NUMBER = SEC.COURSE_NUMBER
-                         AND C.SCHOOLID      = SEC.SCHOOLID
+        LEFT JOIN COURSES C ON C.COURSE_NUMBER = SEC.COURSE_NUMBER
+                           AND (C.SCHOOLID = SEC.SCHOOLID OR C.SCHOOLID = 0)
```

**Read before applying.** `roster` goes from 3805 rows to 5767, a 52 percent
increase. Any Convex side check comparing a table size against 3805 will start
failing, correctly. `course_name` becomes nullable for the 2 sections whose
course lives at another school. **This is not a reason to touch
`convex/sisMerge.ts`.** If applying it appears to require widening that
allowlist, stop.

### Diff B. `powerschool/plugin/plugin.xml`, version only

Source: `docs/sis-expansion.md:786`. PowerSchool will not accept a re-upload at
the same version, and PowerQueries only travel inside the zip.

```diff
-        version="1.0.6"
+        version="1.1.0"
```

Then `npm run build:plugin` from `powerschool/sync`. Do not apply this in
isolation if the chosen path is 2.0.0.

### Diff C. `powerschool/sync/src/run-queries.ts`, register the new queries

Source: `docs/sis-expansion.md:817`. Without it the queries install and are
called by nothing. The full block adds four entries to the `QUERIES` registry:

```diff
+  // Coverage expansion set. See docs/sis-expansion.md. These cover no manifest
+  // field, because the manifest predates them; `covers: []` is deliberate.
+  { short: "attendance_join_health", name: `${QUERY_PREFIX}.attendance_join_health`,
+    args: (c) => ({ schoolid: c.schoolId, yearid: c.yearId }), covers: [], restricted: false },
+  { short: "attendance_by_section", name: `${QUERY_PREFIX}.attendance_by_section`,
+    args: (c) => ({ schoolid: c.schoolId, termid: c.termId }), covers: [], restricted: false },
+  { short: "enrollment_window", name: `${QUERY_PREFIX}.enrollment_window`,
+    args: (c) => ({ schoolid: c.schoolId, termid: c.termId }), covers: [], restricted: false },
+  { short: "period_structure", name: `${QUERY_PREFIX}.period_structure`,
+    args: (c) => ({ schoolid: c.schoolId, termid: c.termId }), covers: [], restricted: false },
```

The two behavior queries are **not** in this diff and have no equivalent
proposed anywhere. `run-queries.ts` will still not know they exist.

### Diff D. `powerschool/sync/scripts/build-plugin.mjs`, em dash glob

Source: `docs/sis-expansion.md:874`. The guard names one query file by hand and
there are now three in `queries_root/`.

```diff
-import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
+import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
@@
-for (const file of [PLUGIN_XML, resolve(PLUGIN_DIR, "queries_root", "wildcathub.named_queries.xml")]) {
+const queriesDir = resolve(PLUGIN_DIR, "queries_root");
+const queryFiles = existsSync(queriesDir)
+  ? readdirSync(queriesDir).filter((n) => n.endsWith(".xml")).map((n) => resolve(queriesDir, n))
+  : [];
+for (const file of [PLUGIN_XML, ...queryFiles]) {
```

### Diff E. `powerschool/sync/scripts/build-plugin.mjs`, exclude ungranted behavior queries

Source: `docs/behavior-sourcing.md:736`. **This is the one diff that protects
something currently in production.** Today, `npm run build:plugin` at 1.0.6 would
package `behavior.named_queries.xml`, whose columns are not granted. That either
fails validation on upload, the way `SECTIONMEETING` did in 1.0.0 and broke the
whole plugin, or ships two queries that 403 on every call.

```diff
+const zipExcludes = [".DS_Store", "__MACOSX/*", "*/.DS_Store"];
+const grantsBehavior =
+  /<field\s+table="Log"/i.test(xml) && /<field\s+table="Gen"/i.test(xml);
+if (existsSync(BEHAVIOR_QUERIES) && !grantsBehavior) {
+  zipExcludes.push("queries_root/behavior.named_queries.xml");
+  console.warn("EXCLUDED queries_root/behavior.named_queries.xml from this zip.");
+}
@@
-  ["-r", "-q", zipPath, ".", "-x", ".DS_Store", "-x", "__MACOSX/*", "-x", "*/.DS_Store"],
+  ["-r", "-q", zipPath, ".", ...zipExcludes.flatMap((p) => ["-x", p])],
```

The exclusion switches itself off automatically once `plugin.xml` grants both
tables. Full text at `docs/behavior-sourcing.md:736`.

### Diff F. `package.json`, run the assertions that exist

Source: `docs/behavior-sourcing.md:785`. 300 assertions exist and nothing runs
them. There is no CI in this repo, so `package.json` is the only place that can.

```diff
-...node convex/restrictedPolicy.test.mjs && node wildcat-auth.test.mjs...
+...node convex/restrictedPolicy.test.mjs && node convex/psBehavior.test.mjs && node wildcat-auth.test.mjs...
```

**Two more orphaned suites have no proposed diff at all.**
`powerschool/sync/src/write-client.test.mjs` (403 assertions) and the 127
assertion validator inside `expansion-probe.ts` are referenced by no npm script
in either `package.json`. They run only when a human types the command.

### Diff G. `convex/schema.ts`, `psBehaviorLog` table

Source: `docs/behavior-sourcing.md:530`, roughly 60 lines including the comment
block. Fourteen fields, two indexes (`by_studentNumber`, `by_entryDate`). Holds
no narrative free text: `LOG.Entry` and `LOG.Subject` are deliberately absent
from the query, the access request and the table. Absence is recorded as
"unknown", never as zero.

### Diff H. `convex/schema.ts`, `psWriteWatermarks` table

Source: `docs/write-path.md:802`. Six fields, two indexes. Stores the fingerprint
of what the app last wrote so an update can be refused when a human has edited
the SIS row since. Only relevant if the decision in section 5 is to write.

**Note for whoever applies these two:** they are separate diffs to the same
shared file from two different pieces. Apply together and read both comment
blocks; neither piece was aware the other was editing this file.

### Diff I. `convex/sisAction.ts` and `convex/studentDetail.ts`, the behavior wiring

Source: `docs/behavior-sourcing.md:596` and `:677`. The action diff is gated on
`PS_BEHAVIOR_ENABLED=yes` and wrapped in try/catch so a behavior 403 can never
take the roster sync down. The detail diff adds a staff-only, per-student gated
read. Until both land, no behavior row can reach a screen no matter what the
plugin grants.

### Diff J. `powerschool/sync/scripts/build-plugin.mjs`, the write allowlist

**This diff's exact text was never written down.** `docs/write-access-request.md`
describes it in prose at line 622 and reports exercising it in a scratch copy
against four cases, but the document contains no `diff` block anywhere. What
follows is a **reconstruction from that prose and those four outcomes, not the
builder's tested patch.** Treat it as a starting point and re-run all four cases
after applying.

```diff
-// Guard: the brief forbids write access anywhere in the access request.
-const writeAccess = xml.match(/access="(?!ViewOnly")([^"]+)"/g);
-if (writeAccess) {
-  fail(
-    `plugin.xml requests non read access: ${[...new Set(writeAccess)].join(", ")}. ` +
-      `This plugin is scoped to read only.`,
-  );
-}
+// Guard: writes are permitted on exactly eleven Log columns and nowhere else.
+// An allowlist, never a denylist: a twelfth column must fail the build.
+const WRITE_ALLOWLIST = new Set([
+  "log.studentid", "log.schoolid", "log.teacherid", "log.entry_date",
+  "log.entry_time", "log.entry_author", "log.logtypeid", "log.subtype",
+  "log.consequence", "log.subject", "log.entry",
+]);
+for (const m of xml.matchAll(/<field\s+table="([^"]+)"\s+field="([^"]+)"\s+access="([^"]+)"/g)) {
+  const [, table, field, access] = m;
+  if (access !== "ViewOnly" && access !== "FullAccess") {
+    fail(`plugin.xml uses an access value the PowerSchool schema does not define: ` +
+         `${access}. Only ViewOnly and FullAccess exist.`);
+  }
+  if (access === "FullAccess" && !WRITE_ALLOWLIST.has(`${table}.${field}`.toLowerCase())) {
+    fail(`plugin.xml requests write access on ${table.toLowerCase()}.${field.toLowerCase()}, ` +
+         `which is not on this script's eleven column write allowlist.`);
+  }
+}
```

The four cases the builder reported passing, which any replacement must
reproduce:

1. `plugin-v2.xml` as `plugin.xml` builds 2.0.0 and prints
   `128 fields requested, 11 FullAccess, 117 ViewOnly`.
2. One extra `FullAccess` line on `Students.Grade_Level` fails by name.
3. **The live 1.0.6 file still builds, exit 0.** This case matters as much as
   case 2.
4. `access="WriteOnly"` fails as an undefined schema value.

The final `console.log` line saying `all ViewOnly` also needs updating; it will
lie the moment a `FullAccess` line exists.

---

## 4. Blocked on a PowerSchool administrator

**Nothing can be asked of an administrator yet.** Every path needs an engineering
step first, and for two of the three paths that step has not been taken. This
section states the ask so it is ready, not so it is sent today.

### The plugin

- **Name:** Wildcat Hub Sync
- **Plugin id:** 9741
- **Currently installed:** version 1.0.6, enabled, authenticating
- **Location:** System > System Settings > Plugin Management Configuration on
  `lapf.powerschool.com`

### Path 1, read only behavior. Version 1.1.0. RECOMMENDED FIRST

**What changed:** 16 new `<field>` lines, all `ViewOnly`. Ten on `Log`
(`ID`, `StudentID`, `SchoolID`, `Entry_Date`, `Entry_Author`, `LogTypeID`,
`Subtype`, `Consequence`, `Discipline_ActionTaken`, `Discipline_IncidentDate`)
and six on `Gen` (`ID`, `Cat`, `Name`, `Value`, `SchoolID`, `SortOrder`). Plus
two new PowerQueries in the zip. **No write anywhere. 123 lines, all ViewOnly.**

**Deliberately absent:** `Log.Entry` (the narrative CLOB) and `Log.Subject` (the
title), because a log entry narrative routinely names a second child or carries
a medical detail. Also 32 of the 34 `Discipline_` columns.

**Engineering steps that must happen first, none of them administrator work:**

1. Apply diffs D, E and F.
2. Apply the 16 field lines and bump `plugin.xml` to 1.1.0.
3. Paste both new `<sql>` bodies into the PowerSchool query tester and run them.
   This is the syntax gate. Neither has ever been parsed by Oracle.
4. Run `npm run build:plugin` and confirm `behavior.named_queries.xml` is now
   IN the listing (the exclusion guard switches off once the grant exists).

**What the administrator clicks:**

1. Sign in to `lapf.powerschool.com` as an administrator.
2. System > System Settings > Plugin Management Configuration.
3. Find Wildcat Hub Sync. **Untick Enable.** The sync stops here.
4. **Install**, choose `wildcat-hub-sync-1.1.0.zip`, then **Import**. This is an
   upgrade over the existing plugin, not a fresh install.
5. On the access request screen, confirm it reads **123 lines, all view only,
   zero full access.** If any line says full access, stop.
6. **Approve** the access request.
7. Back on the plugin list, **tick Enable.** Installed and enabled are separate
   states and it is easy to stop after approving.

### Path 2, write. Version 2.0.0. NOT READY TO SEND

Same click sequence, different numbers: **128 lines, of which exactly 11 are
full access and all 11 are on `Log`.** Four things block it, all engineering or
decision work:

1. `plugin-v2.xml`'s own banner says do not send it (section 2.9, item 1).
2. The zip cannot be built (diff J).
3. Gate C is unanswered (section 5, decision 3).
4. `Log.Entry_Time` is a number field and the client sends a string (2.5).

### Path 3, expansion queries only. Version 1.1.0, no new fields

Cheapest of the three, and it ships a query that cannot return a row on any term
with attendance data (2.6). **Fix the `DATELEFT` predicate and its validator
assertion first**, or this path installs a dead capability.

### Timing, and what breaks during the window, for any path

Pick a time between **19:10 UTC and 12:50 UTC**, which is roughly 12:10 in the
afternoon to 05:50 the next morning in Los Angeles. The crons fire at 13:00 and
19:00 UTC (`convex/crons.ts`).

The window is step 3 to step 7, realistically five to ten minutes. No user sees
an outage: the dashboard reads Convex, not PowerSchool, and both sign-in flows
go to Entra and Google. Roster data just stops getting fresher.

**The one thing to know:** if the window overlaps a cron run, the failure is
**silent**. `syncFromPowerSchool` has zero try/catch blocks and exactly one call
to `syncLog.record`, at `convex/sisAction.ts:227`, at the very end. A throw means
no `syncRuns` row is written at all, so the "data as of" timestamp keeps showing
the last successful run and looks healthy. Do not use the dashboard to confirm
the sync recovered. Re-run the sync by hand and read the Convex function log.

### Do not do these, on any path

- **Do not click Delete, and do not uninstall and reinstall.** The client id and
  secret survive a version upgrade. They do not survive a delete.
- **Do not click Regenerate Client ID and Secret.** Nothing here requires it and
  it breaks the running sync immediately.
- **Do not skip the Enable step.**

---

## 5. Blocked on a human decision rather than a commit

### Decide before anything else

**1. Which plugin version ships next.** Three pieces propose three different
next versions of the same shared file, two of them both numbered 1.1.0. Nobody
can apply any of them until somebody picks. The engineering recommendation is
path 1 first, because it is read only, it needs no new decision about whether
the app may write, and it unblocks the deliverable that is actually missing.

**2. Whether Wildcat Hub should ever write to PowerSchool at all.** This has
never been decided, only designed around. `docs/write-path.md` clause 1 already
commits that the SIS never learns a point balance, and clause 3 commits that a
human edit in PowerSchool always beats the app. If the answer is no, the write
client stays as a documented refusal and `plugin-v2.xml` is deleted rather than
carried. That is a legitimate outcome and it is cheaper than the alternative.

**3. Gate C: does `FullAccess` include read?** Needs an answer from PowerSchool
support, or acceptance of the documented fallback (a duplicate field line, one
`FullAccess` and one `ViewOnly` for the same column, which validates against the
XSD but whose behavior in the plugin importer is untestable from here). Only
matters if decision 2 is yes.

**4. `Log.Discipline_ActionTaken`: keep it or drop it.** It is the only column in
either request that carries any free text risk. The shape check that admits it
allows any whitespace-free string up to 79 characters, so
`Suspended_for_fighting_with_Jose` passes. Dropping it before approval is
entirely defensible and costs one line.

**5. Whether a student may ever see their own log entries.** Currently no, by
`behaviorAudienceFor` in `convex/psBehavior.ts`. That is school policy, not
engineering. Changing it needs a named person.

### Decide before the roster fix lands

**6. Accept the roster going from 3805 rows to 5767.** Diff A is correct and it
is not free. Somebody has to own the downstream consequences: 52 percent more
rows, a nullable `course_name`, and any check that treats 3805 as "complete"
starting to fail.

### Still open from `docs/go-no-go.md`, untouched by this round

**7. The registrar**, for manifest 12 (IEP) and 13 (504).
**8. Whoever requested federal race and ethnicity**, for the brief's own closing
question: what decision do they inform in a teacher-facing dashboard? Descope is
the default if no answer comes.
**9. Whoever owns data governance**, for the retention policy and for naming
Wildcat Hub in the governance documentation. There is now a copy of 641 students
and 6,315 audit entries in Convex with no stated retention period.
**10. A sandbox instance, or a decision to proceed without one.** `PS_HOST` is
`lapf.powerschool.com` with `PS_ALLOW_PRODUCTION=yes`. Every probe in this round,
including the ten GETs in this report, ran against production student records.
**11. A second reader for `docs/runbook.md`.** Still only its author.

### Repo mechanics

**12. How any of this reaches `main`.** `alank47` owns the repo and edits `main`
through the GitHub web UI, and merges to `main` deploy straight to
`wildcatraffle.com`. Nothing here has been committed. Somebody has to decide
whether these land as a branch and PR, and who reviews a 34 percent roster change
before it deploys to production.

---

## 6. The single biggest remaining gap

**Wildcat Hub still cannot see a single behavior record, and everything built to
change that is stuck behind one plugin upload that nobody in this repo can
perform.**

The shape of it, in numbers that are all measured:

- PowerSchool holds **16,987** log entries. Wildcat Hub reads **0**.
- The reference names **14** tables holding the school's behavior record.
  `plugin.xml` names **0** of them, and no PowerQuery touches **0** of them.
- `script.js` runs a complete parallel behavior economy, eight core behaviors at
  plus or minus 100 points, referrals, detentions, hall passes, and
  `convex/schema.ts` parks all of it verbatim in `legacyMirror`.
- So Westbrook runs **two behavior records that do not know about each other**,
  and a teacher deducting Wildcat Cash for defiance still cannot see that the
  student already has three log entries this week, or that the child was serving
  a suspension that day.

Four pieces ran for three rounds each and closed none of it. What they produced
is real: the queries are written, the ingest is written with 300 passing
assertions, the access request is written and XSD valid, the write path is
written and provably refused. What none of them could produce is the one thing
that turns any of it on.

**The gap is one plugin upload wide.** Path 1 in section 4 is the whole of it:
16 read only field lines, a version bump, a zip, and an administrator clicking
disable, install, approve, enable. Until that happens, the honest number stays
9 of 52, and the behavior column stays 0 of 14.

---

## Appendix: verification for this report

Everything in this file was checked on 2026-08-12 rather than copied forward.

| Claim | How it was checked |
|---|---|
| 107 field lines, 0 FullAccess | `grep -c '<field ' powerschool/plugin/plugin.xml`, and the access counts. The 108th ViewOnly string is a comment on line 5. |
| Writes impossible | `node src/write-client.ts --explain`, 10 of 10 blocked |
| Repo suite green | `npm test`: 9 suites, 140 assertions, 0 failed |
| Behavior suite green but orphaned | `node convex/psBehavior.test.mjs`: 300 passed. Absent from `package.json`. |
| Write suite green but orphaned | `node src/write-client.test.mjs`: 403 passed, exit 0. Absent from both `package.json` files. |
| Production calls 3 queries | `convex/sisAction.ts` lines 119, 171, 192: `roster`, `attendance_summary`, `grades` |
| `DATELEFT` defect still shipped | `expansion.named_queries.xml` lines 246, 364, 440 |
| Log type table unreadable | 4 GETs, section 2.4 |
| Gate B closed 21 of 21 | 6 GETs including a bad-name control, section 2.5 |
| No writes attempted | Ten GET requests total, all through `client.ts`'s `ReadOnlyViolation` chokepoint, which permits GET and permits POST only to `/ws/schema/query/`. No POST of any kind was issued while producing this report. |

No secret appears in this file. The PowerSchool client id and secret were read
at point of use through `op read` and never echoed.
