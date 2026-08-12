# Administrator request: Wildcat Hub Sync 1.1.0

Prepared 2026-08-12. Read only. No write access anywhere in this request.

This is Path 1 from `docs/gauntlet-report.md` section 4. Write access is a
separate, later, riskier ask that is **not ready** and is not being made here.

---

## The ask, in one paragraph

Wildcat Hub Sync (plugin id **9741**) is installed and running at version 1.0.6.
Version 1.1.0 adds **16 read only fields** so the dashboard can see the behavior
record the SIS already holds, and fixes a defect in the existing roster query
that is currently hiding about a third of the school's enrollments. Upgrading
takes five to ten minutes and needs an administrator, because PowerSchool
requires a human to approve any change to a plugin's access request.

**File to install:** `powerschool/out/wildcat-hub-sync-1.1.0.zip`

---

## What changes

| | 1.0.6, installed now | 1.1.0 |
|---|---|---|
| Field lines | 107 | **123** |
| Access level | all ViewOnly | **all ViewOnly, zero FullAccess** |
| PowerQueries | 7 | **9** |
| Tables | 16 | **18** (adds `Log`, `Gen`) |

### The 16 new fields

Ten on `Log`: `ID`, `StudentID`, `SchoolID`, `Entry_Date`, `Entry_Author`,
`LogTypeID`, `Subtype`, `Consequence`, `Discipline_ActionTaken`,
`Discipline_IncidentDate`.

Six on `Gen`: `ID`, `Cat`, `Name`, `Value`, `SchoolID`, `SortOrder`.

`Gen` is not extra scope. It holds the school configured log type vocabulary.
Without it a `LogTypeID` is an integer with no meaning and the app would show a
teacher a number instead of "Defiance" or "Positive Referral".

### What is deliberately NOT requested, and why

- **`Log.Entry`**, the narrative text. A log entry narrative routinely names a
  second child or carries a medical detail. Nothing in this product reads free
  text, so asking for it would be scope nobody uses and exposure nobody wants.
- **`Log.Subject`**, the title. Same reasoning, weaker but still true.
- **32 of the 34 `Discipline_` columns.** Only the two above inform a teacher
  facing view. The rest are state reporting.
- **Any write access at all.** Every one of the 123 lines is `ViewOnly`.

---

## Why `Log` and not Incident Management

PowerSchool ships two independent behavior models and a school uses one of them.
Which one Westbrook uses was **measured, not assumed**, on 2026-08-12, using the
count endpoint, which answers without a grant:

```
GET /ws/schema/table/log/count       -> {"count":16987}
GET /ws/schema/table/incident/count  -> {"count":13}
```

16,987 to 13. Westbrook's behavior record is `Log`. Guessing the other way would
have spent this entire approval cycle on the wrong table.

## We checked whether this request is avoidable. It is not.

Before asking for an administrator's time, the cheap route was tried: the count
endpoint answers without a grant, so if it also accepted a filter on
`LogTypeID`, the log type vocabulary could be enumerated by sweeping integers
with no plugin change at all. That would have made this request unnecessary.

It does not. Run 2026-08-12, `npm run probe:logtypes`:

```
GET /ws/schema/table/log/count                  -> 200  {"count":16987}
GET /ws/schema/table/log/count?q=logtypeid==1   -> 403
    {"message":"At least one column lacks sufficient permission",
     "errors":[{"code":"NoAccess","field":"LogTypeID","resource":"Log"}]}
```

PowerSchool names the field and the resource. The unfiltered count is readable
because it touches no column; the moment a column is referenced, the access
request decides. `SchoolID` and `Entry_Date` answer 403 the same way.

So the 16 field lines below are the minimum that unblocks this, and there is no
route to the same data that skips the approval.

---

## Why this matters to the school

The Hub runs a complete behavior economy of its own: eight core behaviors at
plus or minus 100 points, referrals, detentions, hall passes, Wildcat Cash.
PowerSchool holds 16,987 log entries. **Neither can see the other.**

A teacher deducting Wildcat Cash for defiance right now cannot tell that the
student already has three log entries this week, or was serving a suspension
that day. This request is what makes those two records aware of each other.

---

## Also in this version: a roster defect fix

Independent of the behavior work, and arguably more urgent.

The existing `roster` and `grades` queries join courses on
`C.SCHOOLID = SEC.SCHOOLID`. **130 of 484 course rows are district level and
carry `SCHOOLID` 0**, so that equality silently discards every enrollment
pointing at them.

| Measure | Currently installed | After 1.1.0 |
|---|---:|---:|
| Live enrollment rows | 3,805 | **5,767** |
| Sections visible, of 231 | 146 | **231** |
| Students affected | | **639 of 641** |

**1,962 enrollments, 34.0 percent, are missing from teacher rosters today.**
The fix requests no new grant: `SECTIONS.COURSE_NUMBER` is already granted.

---

## What the administrator clicks

Sign in to `lapf.powerschool.com` as an administrator.

1. **System > System Settings > Plugin Management Configuration.**
2. Find **Wildcat Hub Sync**. **Untick Enable.** The sync stops here.
3. **Install**, choose `wildcat-hub-sync-1.1.0.zip`, then **Import**.
   This is an upgrade over the existing plugin, not a fresh install.
4. On the access request screen, confirm it reads **123 lines, all view only,
   zero full access**. **If any line says full access, stop and tell us.**
5. **Approve** the access request.
6. Back on the plugin list, **tick Enable.**

Step 6 is easy to miss. Installed and enabled are separate states, and it is
common to stop after approving.

### Do not do these

- **Do not click Delete, and do not uninstall then reinstall.** The client id
  and secret survive a version upgrade. They do not survive a delete.
- **Do not click Regenerate Client ID and Secret.** Nothing here needs it and it
  breaks the running sync immediately.

---

## When to do it

Pick a time between **19:10 and 12:50 UTC**, which is roughly 12:10 in the
afternoon to 05:50 the next morning in Los Angeles. The syncs run at 13:00 and
19:00 UTC.

No user sees an outage. The dashboard reads Convex, not PowerSchool, and both
sign-in flows go to Entra and Google. Roster data just stops getting fresher for
the length of the window.

**One thing to know:** if the window overlaps a sync run, the failure is
**silent**. `syncFromPowerSchool` records its run only on success, so a throw
writes no row at all and the "data as of" timestamp keeps showing the last good
run and looks healthy. Do not use the dashboard to confirm the sync recovered.
Re-run it by hand and read the Convex function log.

---

## Verify afterwards

```
export CONVEX_DEPLOY_KEY=$(op read 'op://Employee/Westbrook WildCats Hub/Convex wildcat-hub-ci Deploy Key')

cd powerschool/sync
npm run probe                       # regenerates docs/access-gap.md, expect Log and Gen granted
npm run queries -- behavior_log     # one redacted sample, expect rows
npm run sync -- --dry               # expect roster near 5767, not 3805
```

Then a real sync: `npx convex run sisAction:syncFromPowerSchool '{"reason":"post 1.1.0"}'`.

**Expect the enrollment count to jump from 3,805 to about 5,767.** That is the
roster fix landing, not a bug. Any Convex side check comparing against 3,805
will start failing, correctly.

---

## What is still open after this lands

This request does not resolve any of the following, and none of them blocks it:

1. **Write access.** Path 2, version 2.0.0. Four separate things block it,
   including an unanswered question about whether `FullAccess` implies read.
   Not ready, not being asked for.
2. **IEP and 504 status**, manifest fields 12 and 13. Source still unconfirmed.
   This is a question for the registrar, not for the SIS administrator.
3. **Student email.** Absent from this instance entirely. Not an approval
   problem; the column does not exist. Student sign-in cannot key off the SIS.
4. **The expansion queries.** Held back from this zip on purpose: their date
   predicate returns zero rows on every term that has attendance data, so
   shipping them would install a capability that cannot answer.

---

## Verification of this package

| Claim | How it was checked |
|---|---|
| 123 fields, all ViewOnly | `grep -c '<field ' plugin.xml`, and the access level counts |
| No write access anywhere | `build-plugin.mjs` refuses to package a non ViewOnly access level |
| XML is well formed | `xmllint --noout` on plugin.xml and both query files |
| Queries agree with the grant | `npm run validate:queries`, 13 queries checked against 123 granted fields |
| Zip layout is correct | `plugin.xml` at the archive root, verified by the build |
| Expansion queries excluded | Named in the build output |

**Still a human gate:** neither new query's SQL has been parsed by Oracle. Paste
each `<sql>` body into the PowerSchool query tester and run it once before the
upload. The validator checks the four failure modes that are mechanical; it
cannot check whether Oracle likes the SQL.
