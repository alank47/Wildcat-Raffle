# Student email: what the data actually looks like

Measured 2026-08-12, immediately after plugin 1.2.0 was installed. The
`student_email` PowerQuery works and returns real addresses.

**Two of these need a person in PowerSchool, not a code change.**

---

## The numbers

| | |
|---|---|
| Rows returned | 437 |
| Students with an address | 437 |
| Students with MORE than one | **0** |
| Enrolled students on the roster | 646 |
| **Students with NO address** | **209** |

The multi address case the query was built to handle does not occur today. The
ordering by `IsPrimaryEmailAddress` stays anyway: the association table is one
to many by design, and the first student to get a second address should not
also be the first to discover the app picks arbitrarily.

## Finding 1: 209 enrolled students cannot sign in

Not a defect in anything built here. Those students have no email address in
PowerSchool at all.

Grouped by student number, the pattern is obvious:

| Prefix | Count |
|---|---|
| `12xxx` | **191** |
| `11xxx` | 18 |

The 12xxx block is the students enrolled **today**, 2026-08-12, the first day of
the 26-27 year. Accounts have not been issued yet. This is expected to shrink on
its own as the school provisions them, and it is worth re-measuring in a week
rather than acting on now.

The 18 students on `11xxx` are the real question: they are returning students
who should already have accounts.

**For the registrar:** are the 18 returning students without an address an
oversight, or are they students who are not meant to have one?

## Finding 2: one address is misspelled in PowerSchool

**Student 11895** carries:

```
ep11895@westrbookacademy.org
```

`westrbook` is a transposition of `westbrook`. The local part `ep11895` matches
the `westbrookacademy.org` convention exactly (initials plus full student
number), so the intended address is almost certainly:

```
ep11895@westbrookacademy.org
```

**This is a data entry error in the SIS, not an application problem.** It
probably breaks anything else keyed on that address, not only this app.

**For the registrar:** correct it at Student Profile > Email for student 11895.

The app refuses this address deliberately rather than accepting it. Admitting
`westrbookacademy.org` to the allowlist would admit every Google account in a
workspace nobody controls. What the app does instead is explain itself:

> The domain "westrbookacademy.org" looks like a misspelling of
> "westbrookacademy.org". This address is almost certainly wrong in PowerSchool
> rather than wrong here. Ask the registrar to correct the student's email on
> Student Profile > Email, then sign in again.

That is in `TYPO_DOMAINS` in `convex/identityRules.ts`, with three assertions on
the message text, because a generic "Not a student account" would send somebody
to debug the auth layer for an address that is simply misspelled.

## Finding 3: nine records carry a retired domain

| Domain | Students | Status |
|---|---:|---|
| `westbrookacademy.org` | 427 | **The only domain used for sign in** |
| `rwwnms.org` | 8 | Retired. Russell Westbrook Why Not? Middle School |
| `rwwnhs.org` | 1 | Retired. Russell Westbrook Why Not? High School |

Confirmed by the user 2026-08-12: the RWWN domains are old and only the
Westbrook address is used. `STUDENT_DOMAINS` is therefore a single entry.

Those nine records are **stale SIS data**, the same class of problem as the
misspelling above, and they get the same treatment: refused, with a refusal that
explains itself and names where to fix it. A student carrying a retired address
is told the record needs updating, not that their account is invalid.

**For the office:** nine students need their email updated to an
`@westbrookacademy.org` address on Student Profile > Email. Eight on
`rwwnms.org`, one on `rwwnhs.org` (student 11306).

Adding a retired domain to the allowlist would have been the sympathetic choice
and the wrong one: admitting a domain admits every Google account in that
workspace, whether or not the organization still controls it.

## Format: still a check, never a source

433 of 437 first addresses contain the student number or its last three digits.
The convention holds most of the time and breaks often enough to be useless as a
source:

- `westbrookacademy.org`: initials plus the full number. `ms10826`, `ep11895`.
- `rwwnms.org`: an initial plus part of the surname. `magat10856`, `lmed10775`.
- `djack002` belongs to student **11002**, which truncates the number.
- `kescobar11306` is a full surname.

Deriving an address stays declined. A derived address that is wrong signs a
student into another student's record.

## What this means for student sign in

It works, for the 437 students who have an address. It cannot work for the other
209 until PowerSchool has one, and no amount of application code changes that.

Any rollout should therefore expect a third of students to be unable to sign in
on day one, and the "no account" message should say so in a way a fourteen year
old can act on, rather than implying they did something wrong.
