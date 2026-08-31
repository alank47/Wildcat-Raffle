# Where the gradebook actually lives

Measured 2026-08-31 against `lapf.powerschool.com` (production, read only) by
three probes in `powerschool/sync/src/`: `probe-gradebook.ts` (columns on the
PSM_ names), `probe-gradebook-tables.ts` (a wide row-count sweep, which is what
found the real tables), and `probe-gradebook-columns.ts` (columns on those).
GET only throughout; no score or student record was read.

Re-run with:

```
cd powerschool/sync
env -u OP_SERVICE_ACCOUNT_TOKEN -u X_BEARER_TOKEN -u X_API_KEY \
    -u X_API_SECRET -u X_ACCESS_TOKEN -u X_ACCESS_TOKEN_SECRET \
    npm run probe:gradebook
```

(The `env -u` list is not optional and has nothing to do with PowerSchool. See
"Why `op run` fails" at the bottom.)

## The answer

**The gradebook is fully populated and the card IS buildable.** The first two
probes asked the wrong tables.

| Table | Rows | |
|---|---:|---|
| `AssignmentScore` | **1,374,093** | the scores, with both keys |
| `AssignmentSection` | 79,880 | name, due date, point value |
| `Assignment` | 44,237 | nearly bare here; key only |
| `AssignmentCategoryAssoc` | 79,880 | work to category |
| `TeacherCategory` | 937 | category names |
| `GradeCalculationType` | 2,032 | total-points vs weighted |
| `PSM_AssignmentScore` | **0** | empty stub — do not use |
| `PSM_Assignment` | **0** | empty stub — do not use |
| `PSM_AssignmentSection` | absent | — |

### The trap, written down so nobody falls in it a third time

This instance carries **both** schema generations. The `PSM_`-prefixed tables
exist and are **empty**; the real gradebook is in the **singular, unprefixed**
tables.

Two separate probes concluded "this school does not use assignments":

1. The first asked `PSM_Assignment` / `PSM_AssignmentScore` — both real, both 0 rows.
2. The same probe also tried the unprefixed names as **`Assignments`** and
   **`AssignmentScores`** — plural, and both 404.

`Assignment` and `AssignmentScore` are singular. **One letter separated "this
school has no gradebook data" from 1.37 million scores.**

The lesson: a 0-row count on a table that exists is evidence about *that table*,
not about what the school does. Ask what else could hold the data before
reporting an absence.

### The three facts a missing-work card needs

| Need | Column | Confirmed |
|---|---|---|
| Which work is missing | `AssignmentScore.IsMissing` | 403 |
| Whose it is | `AssignmentScore.StudentsDCID` | 403 |
| What it is worth | `AssignmentSection.ScoreEntryPoints` | 403 |

`PointsPossible` does **not** exist on `AssignmentSection` (400). The column is
`ScoreEntryPoints`, with `TotalPointValue` beside it.

The join:

```
AssignmentScore.STUDENTSDCID        -> Students.DCID
AssignmentScore.ASSIGNMENTSECTIONID -> AssignmentSection.ASSIGNMENTSECTIONID
AssignmentSection.SECTIONSDCID      -> Sections.DCID
```

`AssignmentSection`, not `Assignment`, carries the readable content — name,
description, due date, point value. The `Assignment` table is nearly bare in
this instance (`AssignmentID`, `YearID`, two audit columns).

### The half that is still not answerable

**No weight column exists on `TeacherCategory` under any spelling probed.**
`GradeCalculationType.Type` says whether a section is total-points or weighted,
but carries no key back to a section, so it cannot be joined.

So for a **total-points** section the projection is exact arithmetic. For a
**weighted** section this data says which work is missing but not what handing
it in would do to the grade. The card must refuse to project there and say why,
rather than guess. That is a product decision, not a data-access one.

## Shipped at plugin 1.3.0

`powerschool/out/wildcat-hub-sync-1.3.0.zip` — 165 fields, all `ViewOnly`, plus
the `com.lapromisefund.wildcathub.missing_work` PowerQuery. Every field
answered 403 first; nothing on a 400 was written.

## The earlier correction, kept

An earlier session concluded the card was blocked because `PSM_ASSIGNMENTSCORE`
has no student key. I argued that was an artifact of probing an ungranted
table. **Both of us were wrong, in different directions.**

The 403/400 distinction *does* work on an ungranted table — `PSM_AssignmentScore`
returned 403 for `id` and 400 for `studentsdcid` in one run, so my objection was
unfounded. But the original conclusion was also wrong, because that table is an
empty stub. `AssignmentScore` carries `StudentsDCID` and `AssignmentSectionID`
and 1.37 million rows.

## What the SIS admin still needs to confirm

Only one thing, and it is narrow. **Category weights.** No weight column was
found on `TeacherCategory`, and `GradeCalculationType` carries no key back to a
section. Either the weights live somewhere not yet probed, or this instance
stores them outside the tables the API exposes.

Everything else is settled: teachers do create and score assignments, 1.37
million scores prove it, and `IsMissing` is populated.

## Why `op run` fails, and why it is not a PowerSchool problem

Two unrelated traps on this machine, both of which cost time on 2026-08-31:

1. `~/.zshrc:6` exports `OP_SERVICE_ACCOUNT_TOKEN` for a service account that
   has been **deleted**. Every `op` call returns
   `(403) Forbidden (Service Account Deleted)` while it is set.
2. With that unset, `op run` still failed with
   `could not find item X in vault …`. The cause is five inherited environment
   variables — `X_BEARER_TOKEN`, `X_API_KEY`, `X_API_SECRET`,
   `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` — that reference
   `op://Employee/X/...`, an item that no longer exists. **`op run` resolves
   every reference it can see, including inherited ones**, so it dies on those
   before it ever reads `.env`. The PowerSchool references were always fine.

The durable fix is to remove the stale token from `~/.zshrc` and the five `X_*`
exports from wherever they are set. Until then, the `env -u` list above is
required for any `op run` in this repo.
