# Restricted field access: approvals on record

`convex/restrictedPolicy.ts` requires that widening access records WHO approved
it and WHAT decision it informs. This file is that record.

---

## Federal Race codes (manifest 8) and Federal Ethnicity (manifest 7)

**Approved for AGGREGATE use only, 2026-08-19, by Alan K (app owner).**

**The decision it informs:** discipline disproportionality monitoring. Whether
referrals fall disproportionately on any racial group relative to enrolment.
This is the standard analysis a PBIS team and administration run, and it is the
answer to the brief's closing question, which `restrictedPolicy.ts` had recorded
as unanswered.

**What was granted, precisely:**

> "I am not looking to see an individual child's race, I just want data to show
> what races are being hit with referrals and the data just gives us an
> aggregate. so we will never see that a specific child is a specific race."

### Amended 2026-09-10: extended to ACADEMIC outcomes

**Approved 2026-09-10 by Alan K (app owner), in response to a measured
feasibility report rather than in the abstract.**

The 2026-08-19 grant above names its purpose as *discipline disproportionality
monitoring*. Academic outcomes are a different decision, so the extension is
recorded separately rather than read into the original.

**The decision it informs:** whether course failure falls disproportionately on
any racial group. The same disproportionality question as discipline, asked of
grades.

**What was shown before approving.** The complete measurement, all 5,562 grade
rows, students carrying at least one D or F among their posted A-F marks:

| Category | Students | Failing 1+ | Rate | 95% interval |
|---|---:|---:|---:|---|
| Hispanic or Latino | 566 | 395 | 69.8% | 66–73% |
| Black or African American | 47 | 34 | 72.3% | 58–83% |
| White | 7 | — | — | withheld |
| American Indian or Alaska Native | 4 | — | — | withheld |
| Asian | 3 | — | — | withheld |
| Native Hawaiian or Other Pacific Islander | 2 | — | — | withheld |

**Three limits stated at the time of approval, so nobody later reads more into
the chart than it can carry:**

1. **Four of six categories can never be reported at this school.** They hold
   between two and seven children. That is the `SMALL_GROUP` floor working, not
   a gap in the data.
2. **The two that can be reported show no detectable difference.** The
   intervals overlap heavily.
3. **This analysis has limited power.** At n=47, only a very large gap — on the
   order of fifteen points — would be visible. "No difference visible" is NOT
   "no difference", and the screen says so.

#### Added 2026-09-10: course-level failure, and three kinds of course it refuses

Course failure rates and the multi-course failure distribution (metrics 1 and 3
of the twelve) were built the same day. **They read no protected field at all** —
`convex/academics.ts`'s `courseFailure` opens `psGrades` and nothing else, never
`psRestricted` — so they need no extension of the grant above. They are recorded
here anyway, because they introduced a refusal that is not obvious from the code.

**Three kinds of course are dropped from the ranking and from the subject
rollup**, listed in `isUnratedCohort` in `convex/courseSubject.ts`:

| Kind | Example | Why |
|---|---|---|
| Special education | `RSP A` (course 7002A, two sections, 20 students) | Enrolment is disability status. Never requested, never granted. |
| English-learner programme | `ELD 1A`, newcomer sections | EL status is recorded below as **NOT approved**. |
| Heritage language | `Spanish for Spanish Speakers` | Enrolment is the language spoken at home, a proxy for national origin. |

**The reasoning, which is the part worth keeping.** Each of these is an
aggregate, and an aggregate is normally the safe form. But when the ROSTER OF
THE COURSE IS THE PROTECTED GROUP, the aggregate is the disclosure — "68% of
students in RSP A are failing" is a sentence about students with disabilities
wearing a course label. Publishing it because the field was never technically
read would be routing around the refusal rather than honouring it.

Those students are **not** removed from the school-wide figures, where they
identify nobody: they count in coverage, in students failing anything, and in
the depth distribution. Only the per-course row and the subject rollup exclude
them, and the screen prints how many were left out rather than silently
shrinking.

**Two further limits recorded at the same time.** A course-level rate is a
statement about an adult as well as about children — at 618 students a course
resolves to one or two teachers — so the query refuses to split by section, and
the card says in its own copy that it is a list of courses and not of teachers.
And **subject is guessed from the course name**, because `Courses.Credit_Type`
has never been granted; the screen prints what share of the gradebook it could
name and lists the names it could not.

**What was granted:** nothing new. No role gains a field. `restrictedPolicy.ts`
is untouched, and `ALLOWED_BY_ROLE` still gives `teacher`, `campusaide` and
`pbis` nothing. This extends only the PURPOSE for which the existing
aggregate-only grant may be computed, and academics aggregates are gated to
`admin` and `superadmin`.

**Not granted, and explicitly still refused:** English-learner status, which
remains "NOT approved" below, and special-education status, which this system
does not hold and must not infer from course enrolment.

**Confirmed by Alan K on 2026-09-10, after reading this entry back.** The
purpose above is his, the access scope is his, and both were checked against
the written record rather than assumed from the instruction that started the
work. `pbis` was offered and declined: PBIS holds wide discipline rights, and
extending them to academic outcomes by race is a separate grant that has not
been asked for.

**REVIEW DUE 2027-09-10.** The first review date in this file, set at the
owner's request.

Why it matters more than the other entries: this one rests on numbers that were
true in September 2026 and will not stay true. Four categories are withheld
today because they hold between two and seven children, and an intake could
change that. The two reportable groups show no detectable difference at
coverage of 77%, and that figure climbs every week. A decision made against
week-four data deserves to be looked at again against a full year of it.

What the review should ask: are the same four categories still too small; does
the gap finding still hold once coverage is complete; is the purpose above
still the decision this informs; and has anyone asked for `pbis` since.

A date in a file is not a reminder. If this should actually happen, it wants a
calendar entry owned by a person — the file can only record that it was agreed.

### Amended the same day: admin verification access

**Approved 2026-08-19 by Alan K (app owner).**

`admin` and `superadmin` now hold `fedEthnicity` and `raceCodes` in
`ALLOWED_BY_ROLE`, so an administrator can see an individual student's race.

**The decision it informs:** confirming the aggregate is counting and
displaying correctly. An aggregate that cannot be checked against its source is
a number taken on faith, and this one is used to make claims about how the
school disciplines children by race.

This is genuinely wider than the aggregate-only grant above, and is recorded as
such rather than folded into it.

**It stops there.** `teacher`, `campusaide` and `pbis` remain empty. PBIS asked
for counts and gets counts; the gap between PBIS and admin is deliberate, and
`convex/pbisRole.test.mjs` asserts it in both directions.

**Not extended to IEP, 504 or English Learner** for any role.

Aggregates are served by `convex/disciplineAggregates.ts:byRace`, which reads
`psRestricted`, tallies, and returns counts. It never constructs a student row,
so there is no argument that could make it return one.

**Who may see the aggregate:** `admin`, `superadmin`, `pbis`.

**Suppression:** groups under 10 enrolled are withheld SERVER SIDE, with count,
enrolment and rate all returned as null. Suppressing in the browser would be
cosmetic: the network response would still carry the cell. The number of
withheld groups is reported so totals reconcile.

**Multi-race students are never collapsed** into "Two or more". That is a
reporting decision the school has not made, and collapsing hides the students
it claims to describe.

**PowerSchool access was already granted.** `docs/access-gap.md`, generated by
probing the live instance on 2026-08-12, records fields 7 and 8 as granted with
all probes returning 200, and the `student_race_restricted` PowerQuery
returning 100 rows. No new request to PowerSchool was needed.

**Still outstanding:** the sync does not populate `psRestricted` yet, so the
aggregate returns `loaded: false` until it does.

---

## IEP (manifest 12) and Section 504 (manifest 13)

**NOT approved. Not requested. Not available.**

Neither has a confirmed source in this PowerSchool instance, so neither is in
the access request. The registrar has to say where IEP status lives before this
can be revisited. See `docs/field-sourcing.md`.

---

## English Learner (manifest 14)

**NOT approved.** No decision has been named that it informs. Default deny
stands.
