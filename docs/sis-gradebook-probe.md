# Gradebook probe, 28 August 2026

Run against `lapf.powerschool.com`, plugin 1.2.0, read only, GET only, status
codes and column names only. No student record was fetched: every request asked
for one column with `pagesize=1`, and a 400 or 403 returns no rows at all.

Reproduce with:

```
cd powerschool/sync
node src/probe-assignments.ts          # which tables exist
node src/probe-assignment-columns.ts   # which columns each one exposes
node src/probe-gradebook-shape.ts      # the join keys and the weights
```

## The headline

**The access request as drafted would be approved and still not deliver the
feature.** Granting the assignment tables gets you assignment names and scores
that cannot be tied to a student, to a course, or to a due date, because the
REST table endpoint does not expose those columns at any permission level.

This is not a permission finding. It is a shape finding, and it is cheaper to
learn now than after a trip through the admin queue.

## Which gradebook this instance runs

The request assumed a coin flip: "one of these two models will exist, not both."
Measured, it is neither cleanly.

| Table | Code | Reading |
|---|---|---|
| `ASSIGNMENTS` | 404 | **Absent.** The older gradebook's parent table is gone. |
| `ASSIGNMENTSCORE` | 400 | Exists. A remnant: its parent does not. |
| `PSM_ASSIGNMENT` | 400 | **Exists.** PowerTeacher Pro. |
| `PSM_ASSIGNMENTSCORE` | 400 | **Exists.** |
| `PSM_ASSIGNMENTCATEGORY` | 400 | **Exists.** |
| `PGCATEGORIES` | 400 | Exists. |
| `PGFINALGRADES` | 400 | Exists (positive control, already granted). |

400 is the informative answer, not a failure: PowerSchool can only say "not a
valid column for table X" about a table it has. A control against
`wildcat_probe_no_such_table` answered 404, which is what genuinely missing
looks like on this server.

**So: PowerTeacher Pro.** Do not ask for `ASSIGNMENTS`, `ASSIGNMENTCATEGORY`,
`GRADEBOOK_CATEGORY` or `PSM_SECTIONCATEGORY`. All four are absent.

## What those tables will actually give you

Every column below was asked for individually. 403 means the column exists and
is not granted; 400 means this instance does not have it at this endpoint.

| Table | Reachable | **Not reachable** |
|---|---|---|
| `PSM_ASSIGNMENT` | `id`, `name`, `description`, `pointspossible`, `weight`, `assignmentcategoryid` | **`sectionid`**, **`duedate`**, `extracredit`, `iscountedinfinalgrade` |
| `PSM_ASSIGNMENTSCORE` | `id`, `score`, `actualscoreentered`, `ismissing` | **`studentid`**, **`assignmentid`**, `assignmentsectionid`, `studentsdcid`, `scorepoints`, `percent`, `islate`, `isexempt` |
| `PSM_ASSIGNMENTCATEGORY` | `id`, `name`, `abbreviation` | **`weight`**, `categoryweight`, `pointspossible`, `isweightedbypoints` |

Read the right-hand column. A score table with a score and no student is not a
schema; it is a whitelist. The columns being withheld are exactly the join keys
and exactly the weights.

### The middle table, and why it is not the answer

PowerTeacher Pro normally splits an assignment across three tables, with
`PSM_ASSIGNMENTSECTION` in the middle carrying the due date, the points possible
and the section link. That would have explained the two broken ends.

It answered **404**. So did every candidate home for the category weight:

`PSM_SECTIONSCORECONFIG`, `PSM_CATEGORYWEIGHT`, `PSM_SECTIONCATEGORYWEIGHT`,
`PSM_TERMBIN`, `PSM_SECTIONTERMWEIGHT`, `PSM_SCORECONFIG`. All 404.

## What this means for the two halves of the feature

**The join is missing.** Nothing reachable connects a score to a child or an
assignment to a course. "What would raise my grade" needs both.

**The weights are missing.** No reachable column anywhere says what a category
is worth. The request already set the rule for this case: without the weighting
model the card refuses to project rather than guess, because a missing summative
in a category worth 70% and a missing homework in one worth 10% are not the same
answer, and being wrong about a child's grade is worse than staying quiet.

Taken together: `<field access="ViewOnly">` grants on these three tables buy a
list of assignment names and a bag of unattributed scores.

## The route that is left

A **PowerQuery**, which is arbitrary SELECT over the real schema rather than the
REST endpoint's projection whitelist, and which this repo already ships four of
(`powerschool/plugin/queries_root/`). The join happens server-side, so the
columns the table endpoint refuses to project are not automatically out of
reach.

That is a claim this probe cannot finish testing on its own, because a
PowerQuery ships inside the plugin zip and cannot be called until an admin has
installed it. Two things have to be true and only the SIS admin can confirm
them:

1. Whether `PSM_ASSIGNMENTSCORE.studentid` (or whatever this instance calls the
   student key) can be **granted in plugin.xml** even though the table endpoint
   will not project it. `queries_root` requires every `<column>` to name a
   granted field: it drives permission mapping.
2. Where the category weight lives in this instance, given all six candidate
   tables are absent. If PowerTeacher Pro is configured to weight by total
   points rather than by category, there may be no weight table at all and the
   percentage is simply points over points possible, which is a *better*
   outcome: it makes the ceiling computable from data already listed above.

Both are questions for the same conversation the IEP question needs, which is
an argument for asking them together rather than in two trips.

## Not done, deliberately

`plugin.xml` is **not** bumped to 1.3.0 in this change. The field list is not
yet knowable, and shipping a version with a guessed list means either a second
version bump or an approval screen that names fields this instance does not
have. Bump it once, when both questions above are answered and the IEP program
name is in hand.
