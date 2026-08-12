# Student email: where it actually lives

Manifest field 19. Blocked since 2026-08-11, now with a real lead.

This is the key that links a student's Google Workspace account on
`westbrookacademy.org` to their record. Without it a signed in student cannot
be matched to any data, so student sign in cannot ship.

---

## What was wrong, twice

**Attempt 1, 2026-08-11.** Probed `STUDENTS.STUDENT_EMAIL` through the roster
query. It returned nothing: 0 of 3,805 rows carried a value and the column was
not in the response at all. This was written up as "the column does not exist in
this instance", which was correct, and then as "student email does not exist in
this SIS", which was **wrong**.

**Attempt 2, 2026-08-12.** Requested both `Student_Email` and `Email` on
`STUDENTS`, on the theory that the column name is install specific. PowerSchool
rejected both at upload:

```
STUDENTS  STUDENT_EMAIL   Invalid Column
STUDENTS  EMAIL           Invalid Column
PowerQuery ...roster refers to non-existent core table column STUDENT_EMAIL
```

and **refused to enable the plugin**, which took the sync down. Requesting a
column that does not exist is not a soft failure.

Both are now on the `KNOWN_INVALID` list in
`powerschool/sync/scripts/validate-queries.mjs`, and the build refuses to
package either again.

## The correction

Student email is **real and present in this instance.** It is visible in the UI
at:

```
Student Profile > Student Details > Email
```

The mistake was not "does this data exist" but "which table holds it". A UI tab
is not evidence of a column on the core table, and absence from `STUDENTS` is
not absence from the SIS.

## The lead to follow

Modern PowerSchool stores email addresses in the **Person / Contacts data
model**, not as a column on `STUDENTS`. The join runs through a person record
rather than a student record:

```
STUDENTS  -->  PERSON  -->  PERSONEMAILADDRESSASSOC  -->  EMAILADDRESS
```

Roughly: `STUDENTS` carries a person reference, the association table links a
person to one or more email addresses with a type and a primary flag, and the
address itself lives on `EMAILADDRESS`.

**Every table and column name above is a hypothesis and must be verified against
this instance before it goes anywhere near `plugin.xml`.** That is exactly the
mistake that caused this document to exist.

### Verify in this order, cheapest first

1. **Count endpoint, no grant needed.** It answered for `log` and `incident`
   without any access request, so it should answer here:

   ```
   GET /ws/schema/table/emailaddress/count
   GET /ws/schema/table/personemailaddressassoc/count
   GET /ws/schema/table/person/count
   ```

   A 200 with a plausible count means the table exists and is exposed over the
   table endpoint. A 404 means the name is wrong or the table is not exposed,
   and no access request will change that.

2. **Ask the SIS administrator to run this in the PowerSchool query tester.**
   It costs them one minute and settles the column names exactly, which is
   cheaper than another rejected upload:

   ```sql
   SELECT s.STUDENT_NUMBER, e.EMAILADDRESS, a.EMAILADDRESSPRIORITYORDER
   FROM STUDENTS s
   JOIN PERSON p                    ON p.ID = s.PERSON_ID
   JOIN PERSONEMAILADDRESSASSOC a   ON a.PERSONID = p.ID
   JOIN EMAILADDRESS e              ON e.EMAILADDRESSID = a.EMAILADDRESSID
   WHERE s.STUDENT_NUMBER = '11095'
   ```

   Ask them to correct the column names rather than confirm them, and to say
   which address is the school issued one when a student has more than one.

3. **Only then** add fields to `plugin.xml`, in a version of their own, with a
   PowerQuery that has been run in the tester first.

## The check that already exists

The expected format is known and can be verified without any of the above:
initials plus student number, for example `ar11414@westbrookacademy.org`, and
the student number is already the `id` on all 446 app records.

So once the source is found, every returned address can be checked against a
derived expectation, and any mismatch is a real finding rather than a surprise.
Deriving the addresses instead of reading them was declined deliberately and
that still stands: a derived address that is wrong signs a student into another
student's record.

## What this blocks

- Student sign in. Google returns an address with nothing to join it to.
- `myStudentView`, which is written and has no way to identify its caller.

Staff sign in is unaffected: it keys on `USERS.EMAIL_ADDR`, which exists, is
granted, and works.

## What it does not block

Nothing in the 1.1.1 request. Behavior, the roster fix and the expansion
queries are all independent of this and should not wait for it.
