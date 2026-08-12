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

## Finding 3: there are three student domains, not one

| Domain | Students | What it is |
|---|---:|---|
| `westbrookacademy.org` | 427 | Westbrook Academy |
| `rwwnms.org` | 8 | Russell Westbrook Why Not? **Middle** School |
| `rwwnhs.org` | 1 | Russell Westbrook Why Not? **High** School |

Students keep the address from the school they came up through. All three are in
`STUDENT_DOMAINS` in `convex/identityRules.ts`, compared by exact equality per
entry, never a suffix match.

**Worth confirming with whoever runs Google Workspace:** the single student on
`rwwnhs.org` is why that domain is on the allowlist. Adding a domain admits
every account in that workspace, so if `rwwnhs.org` is not a workspace the
organization controls, it should come off the list and that student's SIS record
should be corrected instead.

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
