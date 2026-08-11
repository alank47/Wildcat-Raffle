# Field sourcing

Phase 1 working document. Three manifest fields have no confirmed source, and
one open question must be answered before Phase 3 loads anything.

Each section below has a **Finding** line that is currently empty. Fill it in
as answers arrive. Do not delete the questions once answered, because the
answer plus the question is the audit trail.

---

## 12. IEP / Special Ed status

**Status:** UNRESOLVED. Deliberately absent from `plugin.xml`.

**Why it is not guessed:** In California districts this lives in at least four
different places depending on how the district is set up:

1. A PowerSchool core field on `Students`
2. A state reporting extension table (`S_CA_STU_X` or similar)
3. A locally created custom field, which lands in `S_CUS_STU_X` or a custom
   field table with a district specific name
4. Not in the SIS at all, and instead in SEIS (the California special
   education data system) or PowerSchool Special Programs

Adding a guessed table name produces a plugin that installs cleanly and
returns null forever. That is worse than a visible gap.

**Narrowed empirically on 2026-08-07.** A table existence probe against
`lapf.powerschool.com` ruled most of the guesses out. The probe reads status
codes only: 404 means the table is absent from this instance, 403 means it
exists but this plugin was not granted it.

| Table | Result | Meaning |
|---|---|---|
| `SPENROLLMENTS` | 403 | EXISTS. PowerSchool Special Programs enrollments |
| `GEN` | 403 | EXISTS. Where Special Programs definitions live |
| `S_CA_STU_X` | 403 | EXISTS. CA state reporting extension |
| `S_STU_X` | 403 | EXISTS. Core student extension |
| `STUDENTCOREFIELDS` | 403 | EXISTS |
| `SPPROGRAM`, `SPPROGRAMS`, `SPECPROG`, `STUDENTSPECPROG`, `SPECIALPROGRAMS` | 404 | absent, ruled out |
| `S_CA_STU_SPED_X`, `S_CA_STU_SPED_C`, `S_CA_STU_IPP_X` | 404 | absent, ruled out |
| `PLAN504`, `S_STU_504_X`, `S_CA_STU_504_X` | 404 | absent, ruled out |

So option 4 is live: this instance runs **PowerSchool Special Programs**
(`SPENROLLMENTS` + `GEN`). There is no dedicated special education or 504
extension table to point at.

This does NOT resolve the field. Column names cannot be read without being
granted the table first, so the question below still needs a human answer, but
it is now a narrow one: which Special Programs entries in `GEN` represent IEP
and which represent 504, and does the school actually maintain them there.

**Requires a human.** Send this to the registrar and the SIS admin together:

> For Westbrook Academy in PowerSchool, where is a student's special education
> or IEP status recorded?
>
> a) Is it a field on the student record in PowerSchool, and if so what is the
> field labelled in the UI and which page is it on?
> b) Is it a state reporting field that comes from CALPADS, or something staff
> enter directly?
> c) Or is IEP status maintained in SEIS or PowerSchool Special Programs
> rather than in the SIS? We can see this instance HAS Special Programs
> (`SPENROLLMENTS` and `GEN` both exist). If IEP lives there, we need the
> exact program name as it appears in the Special Programs setup screen.
>
> If it is in PowerSchool, we also need to know whether it is a core field, a
> state extension field, or a custom field your team created, because that
> changes which table we request access to.
>
> Context: we are building a read only staging pipeline for the Wildcat Hub
> dashboard. We are not changing anything in PowerSchool.

**Finding:**

**Resolved by:**

**Date:**

---

## 13. 504 status

**Status:** UNRESOLVED. Deliberately absent from `plugin.xml`.

**Why it is a separate question:** 504 plans are not special education and are
frequently tracked in a completely different place from IEP status, often a
locally created custom field or a spreadsheet outside the SIS entirely. Do not
assume the answer to 12 covers this.

**Requires a human.** Same recipients, sent as a separate question:

> Separately from IEP status, where is a student's Section 504 plan status
> recorded for Westbrook Academy?
>
> a) A field on the PowerSchool student record. If so, what is it labelled and
> where does it appear?
> b) A custom field your team created?
> c) Somewhere outside PowerSchool entirely?
>
> If it is outside PowerSchool, we need to know where before we can decide
> whether the Hub can show it at all.

**Finding:**

**Resolved by:**

**Date:**

---

## 18. Role / Title

**Status:** UNRESOLVED. `SchoolStaff` is requested in `plugin.xml`, but it is
likely insufficient.

**The problem:** The Hub needs to tell an assigning admin apart from a
classroom teacher, because that distinction decides what each person sees.
`SchoolStaff.StaffStatus` is a coarse code and in most instances it separates
teacher from staff from lunch staff, not admin from teacher.

The `staff` PowerQuery currently returns a column named `role_hint` with
values `HAS_SECTIONS` and `NO_SECTIONS`, derived from whether the person is
assigned to any section. It is named a hint on purpose. It is a proxy, not an
answer. A dean who also teaches one section reads as a teacher, and an admin
with no sections reads the same as a counsellor.

**Requires a human.** Send to the SIS admin:

> In PowerSchool for Westbrook Academy, is there a field that reliably
> distinguishes an administrator from a classroom teacher? We can see
> SchoolStaff.StaffStatus but we do not think it separates those two roles.
> Is there a title, job code, or security group we should be reading instead?

**The likely fallback.** If PowerSchool cannot answer this, derive role from
Entra ID group membership instead. The Hub already authenticates with Google
sign in keyed on `@lapromisefund.org`, so identity is established; only the
role lookup moves.

Proposed mapping, to be confirmed with whoever owns the tenant:

| Entra ID group | Wildcat Hub role | Scope |
|---|---|---|
| TBD | `admin` | Explicitly enumerated. Not "everything" |
| TBD | `teacher` | Own sections only |
| (no matching group) | rejected | No implicit default role |

The last row matters. An unmatched account must be rejected, not defaulted to
the narrower role, because a silent default hides a misconfigured group.

**Finding:**

**Resolved by:**

**Date:**

---

## Open question: federal ethnicity (7) and federal race codes (8)

**Status:** UNRESOLVED. Currently in `plugin.xml`. Must be answered before
Phase 3 loads them.

Both are on the request list. Before they are loaded anywhere, the requester
needs to answer:

> What decision does a teacher make differently because they can see a
> student's federal ethnicity or federal race codes on this dashboard?

**Recommendation if no specific use case can be named: descope both.**

The reasoning is not squeamishness. These fields carry real exposure. They are
federally reported demographic categories attached to named minors, and once
they are in a second system they are in scope for every access review,
retention question, and breach assessment that system ever has. Absent a
stated equity reporting purpose with a named owner, they add exposure and no
operational value.

If they are descoped:

1. Delete the RESTRICTED block in `powerschool/plugin/plugin.xml` (contiguous
   and commented, from `Students.FedEthnicity` through `S_CA_STU_ELA_C`)
2. Delete `student_race_restricted` and the ethnicity column from
   `student_restricted` in the named queries file
3. Bump the plugin version and re-run the install cycle
4. Record the decision and its owner below

If they are kept, they need a named owner who approved teacher level
visibility. That is a line on the go / no go checklist and it cannot be signed
by the person building the pipeline.

**Note on English Learner status (14):** this is in the same restricted block
but is a different case. EL status has an obvious instructional use for a
classroom teacher. It still needs its own visibility decision in Phase 5, but
it does not need the same "why does this exist" justification.

**Finding:**

**Decided by:**

**Date:**

---

## Answered questions

Move items here once resolved, with the answer and who gave it. Nothing has
been answered yet.
