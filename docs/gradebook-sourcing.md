# Where the gradebook is, and why the missing-work card is not buildable

Measured 2026-08-31 against `lapf.powerschool.com` (production, read only) with
`powerschool/sync/src/probe-gradebook.ts`. 39 requests, GET only.

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

**The card cannot be built, and the blocker is not permissions.** There are no
assignments in this PowerSchool instance.

| Table | Rows | Verdict |
|---|---:|---|
| `PSM_AssignmentScore` | **0** | exists, empty |
| `PSM_Assignment` | **0** | exists, empty |
| `PSM_AssignmentCategory` | 428 | exists, populated |
| `PSM_AssignmentSection` | — | **no such table** |
| `PSM_SectionGradeWeighting` | — | **no such table** |
| `PSM_CategoryWeighting` | — | **no such table** |
| `PSM_TermWeighting` | — | **no such table** |
| `PSM_SectionGradeCalcFormula` | — | **no such table** |
| `Assignments` / `AssignmentScores` / `AssignmentCategory` (classic gradebook) | — | **no such table** |

Counts come from `/ws/schema/table/<t>/count`, which answers **without** a
grant. The parser was validated in the same run against tables whose size is
known independently: `students` 2,107, `sections` 3,456, `PGFinalGrades`
166,495. So the zeroes are real readings, not a parse failure or a permission
artifact.

428 categories exist with nothing filed under them. Teachers have set up their
gradebook structure; the assignments themselves are not in the SIS.

## The correction this doc exists to record

An earlier session concluded the card was blocked because
`PSM_ASSIGNMENTSCORE` returns a score with no student key and no assignment
key. A later session (mine) pushed back on that, arguing the 400s were an
artifact of probing a table with **zero** grants in `plugin.xml`, since the
400-versus-403 rule was established for tables inside the access request, and
`docs/access-gap.md` already records the table endpoint lying about `TEACHERS`.

**That pushback was wrong, and the probe is what settles it.** On the same
ungranted table, in the same run:

```
EXISTS/no grant  id                    (403)
EXISTS/no grant  ismissing             (403)
no such column   studentsdcid          (400)
no such column   studentid             (400)
no such column   assignmentsectionid   (400)
no such column   scorepoints           (400)
```

403 and 400 both appear on one ungranted table, so the endpoint **does**
distinguish there. The original finding was right: `PSM_AssignmentScore` really
does carry no student key and no assignment key. The `TEACHERS` precedent is a
405 (endpoint closed for the whole table), which is a different signal and does
not generalise to this case.

## What IS grantable, and why it was not granted

These answered 403 — they exist and are simply not in the access request:

- `PSM_AssignmentScore`: `id`, `ismissing`
- `PSM_Assignment`: `id`, `name`, `abbreviation`, `description`,
  `assignmentcategoryid`, `pointspossible`
- `PSM_AssignmentCategory`: `id`, `name`, `abbreviation`

**Nothing was added to `plugin.xml`.** Granting them would buy read access to
student assignment scores and return zero rows, because the tables are empty.
The access request's own rule is that a field needs a named operational use
case or it comes out; access with no working feature behind it is the thing
that rule exists to prevent. When assignments start appearing in the SIS, these
nine fields are pre-confirmed and the edit is mechanical.

Note also that `PSM_AssignmentScore.ismissing` exists, which is the exact flag
a missing-work card would key on. The shape of the feature is fine. The data is
not there.

## Two things to settle before anyone tries again

1. **Do Westbrook teachers enter assignments in PowerTeacher Pro at all?**
   428 categories and zero assignments suggests the gradebook was configured
   and then not used, or that grades are entered directly as final percentages.
   `PGFinalGrades` holds 166,495 rows, so final grades ARE being recorded. Ask
   the SIS admin which workflow teachers actually follow.
2. **There is no weighting table in this instance, under any spelling tried.**
   Even with assignments present, "how much would handing this in help" is not
   computable from the SIS: nothing says whether a section is total-points or
   category-weighted, or what any category is worth. A projection engine would
   have to refuse rather than guess for every weighted gradebook. That is a
   product decision, not a data-access one.

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
