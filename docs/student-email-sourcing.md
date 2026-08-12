# Student email: where it actually lives

Manifest field 19. **SOLVED 2026-08-12.** The source is confirmed, every column
name is verified against the instance, and plugin 1.2.0 requests them.

Blocked since 2026-08-11, twice on a wrong assumption, and the second wrong
assumption disabled the plugin. The method that finally worked is at the bottom
and is worth more than the answer.

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

## The answer

```
STUDENTS.PERSON_ID -> PERSON.ID
                   -> PERSONEMAILADDRESSASSOC.PERSONID
                   -> PERSONEMAILADDRESSASSOC.EMAILADDRESSID
                   -> EMAILADDRESS.EMAILADDRESSID -> EMAILADDRESS.EMAILADDRESS
```

Confirmed on the live instance 2026-08-12. Row counts: `emailaddress` 3,022,
`personemailaddressassoc` 4,048, `person` 10,546.

Every column below answered **403, exists but not granted**, before it was
written into `plugin.xml`:

| Table | Columns confirmed to exist |
|---|---|
| `Students` | `Person_Id` |
| `Person` | `ID`, `DCID` |
| `PersonEmailAddressAssoc` | `PersonID`, `EmailAddressID`, `IsPrimaryEmailAddress`, `EmailAddressPriorityOrder` |
| `EmailAddress` | `EmailAddressID`, `EmailAddress` |

And these answered **400, does not exist**, so nobody retries them:
`Students.Student_Email`, `Students.Email`, `Students.Email_Addr`,
`PersonEmailAddressAssoc.EmailTypeID`, `EmailAddress.ID`, `EmailAddress.DCID`,
`U_StudentsUserFields.*`, `StudentCoreFields.*`, and `U_Def_Ext_Students.email`
(that table exists with 623 rows and `StudentsDCID`, but has no email column).

**A person can hold several addresses**, which is why the association table
carries `IsPrimaryEmailAddress` and `EmailAddressPriorityOrder`. Picking one
arbitrarily would hand a student an address that is not theirs to sign in with.
`queries_root/identity.named_queries.xml` returns every address per student and
orders primary first, leaving the choice to the application.

## How it was found, which is the reusable part

**The table endpoint distinguishes two failures, and the difference is the whole
method:**

| Response | Meaning |
|---|---|
| `400 not a valid column for table X` | The table exists. The column does not. |
| `403 lacks sufficient permission` | Both exist. Only the grant is missing. |

So an ungranted table can still be mapped, one column at a time, without any
access request and without asking anyone. That is how nine column names were
confirmed and nine more were eliminated in a single pass of GETs.

It also means the earlier probe already held the answer's shape and it was not
read closely enough: `u_studentsuserfields.studentsdcid` answered 403 on
2026-08-11, which proved that table existed, and that was recorded as a failure.

## What is left

1. **Install plugin 1.2.0.** Nine new fields, all ViewOnly, all confirmed to
   exist. `docs/admin-ask-1.2.0.md` is the request.
2. **Run the query once in the PowerSchool query tester** before the upload.
   Oracle has not parsed it, and that gate is not automatable.
3. **Wire it up.** `student_email` is not in `run-queries.ts` or in any sync
   action yet, and `students` in Convex has no email field. The query returns
   several addresses per student, so the app picks primary first and stores one.
4. **Check the values against the expected format** as a sanity pass, never as a
   source: two domains, and `djack002` belongs to student 11002.

## The rule this document exists to enforce

Two uploads were rejected for requesting columns that do not exist, and the
second one **disabled the plugin and took the sync down**. Every invalid
spelling found so far is in `KNOWN_INVALID` in
`powerschool/sync/scripts/validate-queries.mjs`, and the build refuses to
package any of them.

Nothing goes into `plugin.xml` until the instance has answered 403 for it.
That standard is what produced 1.2.0, and it cost one pass of GETs.

## What this blocks, and what it does not

**Blocks until 1.2.0 is installed:** student sign in, and `myStudentView`, which
is written and has no way to identify its caller.

**Does not block:** anything already installed. Staff sign in is unaffected,
since it keys on `USERS.EMAIL_ADDR`.
