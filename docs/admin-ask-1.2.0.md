# Administrator request: Wildcat Hub Sync 1.2.0

Prepared 2026-08-12. Read only. No write access anywhere in this request.

1.1.1 is installed and working. This is the **next** request, and it is not
urgent: nothing is broken without it. It unblocks student sign in, which is
currently impossible.

**File to install:** `powerschool/out/wildcat-hub-sync-1.2.0.zip`

---

## The ask

Nine new read only fields so the Hub can read the school issued email address
for each student. That address is the only thing that can link a student's
Google sign in to their record, so without it students cannot sign in at all.

| | 1.1.1, installed now | 1.2.0 |
|---|---|---|
| Field lines | 121 | **130** |
| Access level | all ViewOnly | **all ViewOnly, zero FullAccess** |
| PowerQueries | 13 | **14** |
| Tables | 18 | **21** |

### The nine fields

| Table | Fields |
|---|---|
| `Students` | `Person_Id` |
| `Person` | `ID`, `DCID` |
| `PersonEmailAddressAssoc` | `PersonID`, `EmailAddressID`, `IsPrimaryEmailAddress`, `EmailAddressPriorityOrder` |
| `EmailAddress` | `EmailAddressID`, `EmailAddress` |

Student email is not a column on `STUDENTS`. It lives in the Person email
model, which is why this needs four tables rather than one:

```
STUDENTS.PERSON_ID -> PERSON.ID
                   -> PERSONEMAILADDRESSASSOC.PERSONID
                   -> PERSONEMAILADDRESSASSOC.EMAILADDRESSID
                   -> EMAILADDRESS.EMAILADDRESSID -> EMAILADDRESS.EMAILADDRESS
```

`IsPrimaryEmailAddress` and `EmailAddressPriorityOrder` are not extra scope. A
person can hold several addresses, and choosing one arbitrarily would hand a
student an address that is not theirs to sign in with.

### What is deliberately NOT requested

- **No name, phone, or address fields** from `Person`, even though they are
  right there. `ID` and `DCID` only, purely to complete the join.
- **No contact or guardian data.** The Person model is shared with contacts.
  This request touches only the association rows reachable from a student.
- **Any write access at all.** Every one of the 130 lines is `ViewOnly`.

---

## Every field here was verified to exist before it was requested

This matters because **the 1.1.0 upload was rejected for requesting columns
that do not exist, and that disabled the plugin and took the sync down.**

The table endpoint distinguishes the two failures, and the difference is the
whole method:

| Response | Meaning |
|---|---|
| `400 not a valid column for table X` | The table exists. The column does not. |
| `403 lacks sufficient permission` | Both exist. Only the grant is missing. |

Every one of the nine fields above answered **403** on 2026-08-12. None is a
guess. The build now also refuses to package any column this instance has
already rejected.

Row counts confirming the tables are real and populated: `emailaddress` 3,022,
`personemailaddressassoc` 4,048, `person` 10,546.

---

## What the administrator clicks

Sign in to `lapf.powerschool.com` as an administrator.

1. **System > System Settings > Plugin Management Configuration.**
2. Find **Wildcat Hub Sync**. **Untick Enable.** The sync stops here.
3. **Install**, choose `wildcat-hub-sync-1.2.0.zip`, then **Import**.
   This is an upgrade, not a fresh install.
4. On the access request screen, confirm it reads **130 lines, all view only,
   zero full access.** **If any line says full access, stop and tell us.**
5. **Approve** the access request.
6. Back on the plugin list, **tick Enable.**

Step 6 is easy to miss. Installed and enabled are separate states.

### Do not do these

- **Do not click Delete, and do not uninstall then reinstall.** The client id
  and secret survive a version upgrade. They do not survive a delete.
- **Do not click Regenerate Client ID and Secret.**

---

## When to do it

Between **19:10 and 12:50 UTC**, roughly 12:10 in the afternoon to 05:50 the
next morning in Los Angeles. The syncs run at 13:00 and 19:00 UTC.

No user sees an outage. If the window overlaps a sync run the failure is
**silent**, so confirm recovery by re-running the sync by hand rather than by
looking at the dashboard.

---

## Before uploading: one human gate

`student_email` in `queries_root/identity.named_queries.xml` has never been
parsed by Oracle. Paste its `<sql>` body into the PowerSchool query tester and
run it once with `schoolid` set. A failure there is a five minute fix; a failure
after approval costs another approval cycle.

## Verify afterwards

```
cd powerschool/sync
npm run probe                        # expect Person and EmailAddress granted
npm run queries -- student_email     # expect roughly one row per student
```

Two domains are expected and both are correct: students who came up through
Russell Westbrook Why Not? Middle School hold `@rwwnms.org`, the rest hold
`@westbrookacademy.org`.
