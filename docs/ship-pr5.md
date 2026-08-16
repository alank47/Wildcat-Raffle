# Shipping PR #5

Thirteen commits against an app that 623 students and 56 staff use on a school
day. This is the order to ship it in, and the reason each step comes where it
does. Read the whole thing before starting: two of these steps are irreversible
in the sense that mattering, and one of them breaks NFC taps for the length of a
Pages build.

**Do not ship this during the school day.** Not because it is fragile — the
suite is green and every claim below was measured — but because two of the
steps have a window between them where a tap is refused, and the cost of doing
it at 07:30 is a corridor full of children whose passes will not close.

---

## What is in it

| | |
|---|---|
| Commits | 13 |
| New Convex tables | `bellSchedules`, `bellScheduleDays`, `bellSettings`, `tapIntents` |
| Changed response shape | `views_app:myStudentView` |
| Removed argument | `hallPasses:requestMine` no longer takes `originSlug` |
| New requirement | `hallPasses:tap` now requires `intentToken` |
| Test suites | 20, all green |

---

## Order

### 1. Deploy Convex FIRST

```bash
CONVEX_DEPLOY_KEY=$(env -u OP_SERVICE_ACCOUNT_TOKEN op read \
  "op://Employee/Westbrook WildCats Hub/Convex wildcat-hub-ci Deploy Key") \
  npx convex deploy --yes
```

All four table additions are additive, so nothing existing breaks on arrival.

**The window this opens:** `hallPasses:tap` starts requiring an intent token the
moment this lands, and the frontend that mints one is not live until step 2. So
between step 1 and step 2, **an NFC tap is refused** with "press the button on
your pass to check in here". Passes already open stay open; nobody is stranded,
because the sweep and the staff force-close both still work. But the tap that
closes a pass will not work until step 2 finishes.

That window is a Pages build, about a minute. Do 1 and 2 back to back.

### 2. Merge PR #5

```bash
gh pr merge 5 --merge --delete-branch
```

Pages builds from `main`, so this is the deploy. It also supersedes PR #4 (the
Wildcat Hub rename) — that branch is contained in this one, so #4 can be closed
rather than merged.

**Do not merge without step 1.** `myStudentView` returns a new shape on this
branch, and the deployed backend returns the old one; the new frontend reads
`grades.courses` off what would still be a bare array and shows **every student
an empty gradebook**. It would look exactly like a school where nobody has
posted grades.

### 3. Configure the bell schedule, before anyone tries a hall pass

Settings → 🔔 Bell Schedule.

Hall passes derive the origin from the timetable, which needs to know what time
period 3 runs. Until this is filled in, `myCurrentClass` refuses with
`not-configured` and the request button stays disabled — which is the correct
behaviour, and also means **the feature is inert until somebody does this.**

1. Set the time zone. The screen shows the time the app believes it is; if that
   is not the time on the wall, stop and fix it before anything else. Every
   period boundary is computed from it.
2. Enter the usual day's periods. Minutes, start and end, in local time.
3. Add the minimum day / assembly schedule as a second named schedule.
4. Set the cycle days if sections meet on some days and not others. If your
   sections all meet daily, leave it — `1(A-E)` is then not a constraint.

Get this wrong in the direction of "too narrow" and students are told there is
no class right now. Get it wrong in the direction of "too wide" and a request
routes to the teacher whose period just ended.

### 4. Assign classroom tags

Settings → NFC Tags. Each classroom tag gets a teacher or a section. Unassigned
classroom tags show "not assigned" in red.

A pass needs a classroom tag to be tappable on return. Without the assignment
the student is told `no-classroom-tag` and cannot request — again correct, again
inert until done.

### 5. Decide who can open a pass for a student

The teacher-initiated half — pick a student, pick a destination — currently sits
behind the superadmin beta gate, so **no ordinary teacher can reach it.** Built
and unreachable. Widening that gate is a decision about who may send a child out
of a room, which is yours, not a code change.

---

## Verify, in this order

1. **A student signs in.** Portal renders, schedule and grades populate. If
   grades are empty for a student who has them, step 1 did not happen.
2. **`npm run rb:check`** — unrelated to this deploy, but it is the two-second
   confirmation of the Pro licence key if you have pasted one.
3. **Ask for a hall pass as the test student.** Either it names the teacher and
   the class, or it refuses with a sentence. Both are correct answers; a picker
   appearing is not.
4. **Tap a tag.** It must ask for a press first. A tap arriving from a link,
   with no press, must do nothing at all — that is the fix for a classmate being
   able to close your pass by texting you a URL.
5. **Teachers page, Students page.** Total should read 623, not 738.

---

## Rolling back

Convex has no down-migration here and does not need one: every schema change is
additive, so the previous function set runs against the new tables unharmed.
Reverting is therefore a frontend concern — revert the merge commit on `main`,
let Pages rebuild, and redeploy the previous Convex functions if you want the
old `myStudentView` shape back.

The one thing that does not roll back cleanly is the tap intent requirement: old
frontends do not mint tokens. If you revert the frontend, revert Convex too, in
that order, or taps stay refused.

---

## Still outstanding after this ships

- `hub/` and `/app/` are a second surface, not a replacement. 545KB in one
  chunk; it is a design study until somebody decides otherwise.
- No behavior data exists — PowerSchool has granted neither `Log` nor `Gen`.
- No room data on sections, which is why tags are assigned by hand in step 4.
- The React Bits Pro licence key, if the Pro components are still wanted.
- Rotate the test student's Google password; it is in the session transcript.
- Drop Test Student from Warren's Promise Time section when testing ends.
