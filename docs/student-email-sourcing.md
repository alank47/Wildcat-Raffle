# Student email: where it actually lives

Manifest field 19. Blocked since 2026-08-11. Substantially narrowed 2026-08-12
after seeing the data in the PowerSchool UI.

This is the key that links a student's Google Workspace account to their record.
Without it a signed in student cannot be matched to any data.

---

## Correction: student email is NOT absent

The earlier conclusion, written into the handoff, the go/no-go and the gauntlet
report, was **"student email does not exist in this SIS"**. That is wrong.

It exists, it is populated, and it is visible in two places in the UI:

- **Student Profile > Student Details > Email**, a single "Email Address" field.
- The **New Students** list on the start page, which has an Email column.

The mistake was reasoning from "not on the STUDENTS table" to "not in the SIS".
Absence from one table is not absence from the instance.

## Two domains, not one

This is the more urgent finding and it has already been fixed in code.

Currently enrolled Westbrook Academy students hold addresses on **two** domains:

| Student | Number | Grade | Email |
|---|---|---|---|
| Sierra, Matthew | 10826 | 11 | `ms10826@westbrookacademy.org` |
| Suarez-Lira, Alyson | 11000 | 11 | `as11000@westbrookacademy.org` |
| Agaton Colin, Maria Elizabeth | 10856 | 12 | `magat10856@rwwnms.org` |
| Medina, Linette Savannah | 10775 | 12 | `lmed10775@rwwnms.org` |
| Jackson, Demarco Carey | 11002 | 11 | `djack002@rwwnms.org` |

`rwwnms.org` is Russell Westbrook Why Not? Middle School, which shows up in
enrollment histories as the school students promote **from**. They keep the
address when they arrive at Westbrook.

`convex/identityRules.ts` compared against a single `STUDENT_DOMAIN` constant,
so every student in the second group would have been refused with "Not a student
account". Now `STUDENT_DOMAINS`, still exact equality per entry. The Google
`hd` hint in `wildcat-auth.js` is omitted entirely for the same reason: pinning
the account chooser to either domain hides the other half's account.

## Deriving the address is now definitively ruled out

The format is not one rule, and one row breaks any rule you could write:

- `westbrookacademy.org`: initials plus the full student number.
  `ms10826`, `as11000`, `hm11101`, `sm11140`.
- `rwwnms.org`: first initial plus part of the surname plus the number.
  `magat10856`, `lmed10775`.
- And then **`djack002` for student number 11002**, which truncates the number.

A derived address that is wrong signs a student into another student's record.
This stays declined. The format remains useful as a **verification check** once
the real values are read, never as a source.

## Where it lives: narrowed to two tables

The Phase 0 probe already produced the decisive evidence, in `docs/access-gap.md`.
The status codes are diagnostic and were not read closely enough at the time:

| Probe | Result | What that proves |
|---|---|---|
| `students.student_email` | 400 not a valid column for Students | Column does not exist |
| `students.email` | 400 not a valid column for Students | Column does not exist |
| `u_studentsuserfields.studentsdcid` | **403** lacks permission | **Table AND column exist**, just not granted |
| `u_studentsuserfields.student_email` | 400 not a valid column for U_StudentsUserFields | Table exists, that column does not |
| `studentcorefields.studentsdcid` | **403** lacks permission | **Table AND column exist**, not granted |
| `studentcorefields.student_email` | 400 not a valid column for StudentCoreFields | Table exists, that column does not |

**400 and 403 mean different things and the difference is the whole finding.**
A 400 naming the table proves PowerSchool resolved the table and enumerated its
columns. A 403 proves the column exists too and only permission is missing.

So `U_StudentsUserFields` and `StudentCoreFields` both exist on this instance.
The email column is very likely in one of them under a name nobody has guessed
yet, and the extension tables are exactly where a district puts a field like this.

### The candidate never tried

`STUDENTS.EMAIL_ADDR`. Staff email is `USERS.EMAIL_ADDR`, which exists, is
granted and works. Only `student_email` and `email` were probed on `STUDENTS`;
the spelling that is already proven to exist elsewhere in the schema was not.

Cheap, and it costs one request.

## What to do next, cheapest first

The plugin must be enabled again before any of this can run. Nothing below needs
a new access request.

1. **Probe the untried spelling and enumerate the extension tables.**

   ```
   cd powerschool/sync
   npm run probe          # regenerates docs/access-gap.md
   ```

   Add `students.email_addr`, and then ask the table endpoint for the extension
   tables' shape rather than guessing column names one at a time.

2. **If that does not settle it, ask the SIS administrator.** One question,
   phrased so the answer is a column name and not a yes:

   > On the Student Profile > Email page, which database field backs the "Email
   > Address" box? We need the table and column name, for example
   > `U_StudentsUserFields.<something>`. We have confirmed it is not
   > `Students.Student_Email` or `Students.Email`.

3. **Only then** add fields to `plugin.xml`, in their own version, with a
   PowerQuery that has been run in the query tester first.

## The rule this document exists to enforce

Two uploads have now been rejected for requesting columns that do not exist, and
the second one **disabled the plugin and took the sync down**. Both invalid
spellings are in `KNOWN_INVALID` in `powerschool/sync/scripts/validate-queries.mjs`
and the build refuses to package them.

Nothing goes into `plugin.xml` for this field until the instance has confirmed
the name. Not a third guess.

## What this blocks, and what it does not

**Blocks:** student sign in, and `myStudentView`, which is written and has no way
to identify its caller.

**Does not block:** anything in the 1.1.1 request. Behavior, the roster fix and
the expansion queries are all independent. Staff sign in is unaffected, since it
keys on `USERS.EMAIL_ADDR`.
