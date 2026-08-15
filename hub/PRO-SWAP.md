# Swapping in React Bits Pro

Pro has been bought. The licence key is not here yet, so no Pro block can be
installed and nothing in this document has been run. Everything else is ready:
both Pro namespaces are already wired up in `components.json` with their real
endpoints, and the four screens have been restructured so that a Pro block
replaces **one presentational component that takes a model** rather than being
grafted into the code that decides what a student's record actually says.

This file is the swap procedure. It is meant to be mechanical.

---

## 0. When the key arrives

```bash
cd hub
cp env.local.example .env.local     # paste REACTBITS_LICENSE_KEY
npm run rb:check                    # MUST print 200 before you install anything
npm run rb:check -- CountUp starter # and once against the starter namespace
```

`rb:check` exists because every Pro failure looks identical coming out of the
shadcn CLI — "not found" — whether the key is missing, the licence has lapsed,
the item is not in your plan, or you asked the wrong namespace. Do not debug an
install until this prints 200.

Then, and only then:

```bash
npm run rb -- @reactbits-pro/<block>        # blocks, Application UI, Agent Kit
npm run rb -- @reactbits-starter/<Name>     # components
```

**The block names below are described, not quoted.** The Pro catalogue is
behind the same 401 as the components, so it has not been read. When the key
lands, list the registry first and match a real name to the description; the
shape each one has to satisfy is the part that is fixed, and it is specified
here.

---

## 1. The seam, in one paragraph

Every route is now:

```
useXModel()      lib/viewmodel.ts   reads the session, normalises the two wire
                                    shapes, decides what is missing and what
                                    the words for that are. Plain data out.
<XView model />  routes/X.tsx       draws the model. Imports no session, calls
                                    no query, derives no availability.
```

A Pro block replaces `<XView>` or a named piece of it. It receives the model —
or props mapped from the model at the call site — and nothing else. The rule
that keeps this honest is in the model types: **absence is `null` plus a
`reason` string, never `0`.** A block that renders the model faithfully cannot
invent a value. The worst it can do is fail to render one, which is visible.

---

## 2. Cards — the wallet

**File** `src/routes/Cards.tsx` · **Model** `useCardsModel()` → `CardsModel`

| Section | Component today | What a Pro block would be |
| --- | --- | --- |
| The deck | `<Wallet model={WalletModel}>` (React Bits free `Stack`) | a card-stack / wallet / carousel block |
| The figures | `<StatRow stats={StatModel[]}>` | a stats or metrics block |
| The open-pass banner | `<LivePassBanner pass={LivePassSummary}>` | an alert / status-banner block |

### What the deck block must accept

```ts
WalletModel = { cards: WalletCard[]; initialTop: string }

WalletCard = {
  key: string
  chip: string          // the selector-chip label under the deck
  label: string         // printed on the card face
  tint: string          // face colour — school palette only
  identity?: { name: string; school: string; grade: string } | null
  body:
    | { kind: "barcode"; value: string; glare: boolean }
    | { kind: "cash"; balance: number; earned: number | null; spent: number | null }
    | { kind: "pass"; open: boolean; overdue: boolean; elapsed: number | null }
    | { kind: "missing"; reason: string | null }
}
```

Four requirements the block has to meet, and they are not negotiable:

1. **`kind: "missing"` must render `reason` as a sentence.** It is the server's
   own words, written for a student, and it usually names who can fix it. A
   block that renders an empty card, a placeholder image or a skeleton for this
   case is wrong.
2. **Any card must reach the front in one action.** The barcode is held up at a
   lunch till with a queue behind it. If the block only fans a deck and expects
   a drag, keep the chip row.
3. **A tap must not reshuffle.** `sendToBackOnClick` is off and
   `mobileClickOnly` is on today for this reason: a card that reorders because a
   student touched it to read it has moved the thing they were reading.
4. **`earned` / `spent` of `null` print "Not synced", not `$0`.** A card that
   says "$0 spent" to a child who has spent money is the same class of lie as a
   missing grade rendered as an F.

### Verify after the swap

- **Weight** — `npm run build` and read the JS figure. It is 546 KB / 183 KB
  gzipped in one chunk today, on school Chromebooks. Check the block's
  `dependencies` in the registry JSON *before* installing: `three`, `ogl` and
  `postprocessing` are all disqualifying on their own.
- **Hover on touch** — after the swap,
  `grep -o "@media (hover:hover)[^{]*{" ../app/assets/*.css | sort -u` must
  still print exactly one line, and it must be
  `@media (hover:hover) and (pointer:fine){`. A Tailwind `hover:` class inside
  a block compiles to a bare `(hover: hover)` block, which is one test instead
  of two: true of a stylus and of a touchscreen laptop.
- **Reduced motion** — the deck must not be the only way to see a card. Any
  spring or drag physics has to survive `prefers-reduced-motion` with the cards
  still reachable.
- **Invented values** — open `?demo=panel#/cards` and confirm the Lunch and
  Clever cards still show their two reason sentences. Those two are
  `available: false` in the fixture precisely so this is checkable on screen.
- **Visibility** — search the installed source for `opacity: 0`, `autoAlpha`,
  `visibility`, `invisible`, `useInView`, `IntersectionObserver`. If the
  block's resting state is invisible and a JS library restores it, reject it:
  that is the defect this app has now found four times (`FadeContent` on the
  sign-in button, `AnimatedContent` around every route, `AnimatedList` on the
  timetable rows, `BlurText` on every heading).

---

## 3. Schedule — the timetable

**File** `src/routes/Schedule.tsx` · **Model** `useScheduleModel()` → `Async<ScheduleModel>`

| Section | Component today | What a Pro block would be |
| --- | --- | --- |
| The list | `<ScheduleView model>` and its `ClassRowView` | a list / timeline / agenda block |

### What it must accept

```ts
ScheduleModel = {
  rows: { course: string; periodShort: string; detail: string }[]
  emptyReason: string | null   // present ⇒ there is nothing to list, and this says why
  refused: boolean             // the panel itself refused: louder styling
  provenance: { dataAsOf, panel, extra }
}
```

Requirements:

1. **`emptyReason` is not "No results".** Three different things produce an
   empty timetable — the panel refused, the legacy wire shape returned an empty
   array with no reason attached, or the roster genuinely has no sections — and
   the model has already written the correct sentence for each. Print it. A
   block with a hardcoded empty state must have that state replaced.
2. **Nothing on a row is clickable**, so nothing on a row may look clickable.
   No `cursor: pointer`, no chevron, no "View".
3. **The provenance line stays.** It reports which wire shape the server
   actually sent. Production is still on the older one, and an empty panel from
   a misparse looks exactly like a student with no classes — this project has
   shipped that bug twice.

### Verify after the swap

- Weight, hover gating, reduced motion, resting visibility: as §2.
- **Long list** — a student with twelve sections. Any per-row entrance must be
  capped; the CSS stagger here tops out at eight steps (~315ms) by design.
- **Keyboard** — `AnimatedList`, which this replaced, called `preventDefault()`
  on Tab at the **window**, taking the key away from every other control on the
  page. Tab through the whole screen after installing anything list-shaped.
- **`?demo=legacy#/schedule`** must still say "server sent the older list-only
  shape" and must still list six classes.

---

## 4. Grades

**File** `src/routes/Grades.tsx` · **Model** `useGradesModel()` → `Async<GradesModel>`

| Section | Component today | What a Pro block would be |
| --- | --- | --- |
| The term strip | `<StatRow stats={model.summary}>` | a stats / KPI block |
| The course list | the `role="list"` block and `GradeRowView` | a data-list or table block |
| Attendance | `<StatRow stats={model.attendance.stats}>` | a stats block |

### What it must accept

```ts
GradeRowModel = {
  id: string
  course: string
  courseNumber: string
  graded: boolean          // false ⇒ the words "Not graded yet"
  letter: string | null
  percent: number | null   // null ⇒ NO BAR IS DRAWN
}
```

**This is the screen with the rule that cannot be broken.** From
`convex/studentPortalRules.ts`: a student with no gradebook entry must not
appear to be failing. PowerSchool writes `""` for a section that exists but has
not been marked, and `graded: false` is that. It renders as words. Never a
dash, never an empty box, never a colour that reads as an F, and **never a bar
of zero length in a column of full ones** — which is why the bar is skipped
entirely rather than drawn at 0%.

Any Pro list or table block that ships a progress bar, a rating, a badge colour
or a sparkline has to be checked against exactly this. A block that defaults a
missing number to zero and draws it is a block that tells a fourteen-year-old
they are failing a class nobody has marked yet.

### Verify after the swap

- Weight, hover gating, reduced motion, resting visibility: as §2.
- **The Studio Art row.** `?demo=panel#/grades` — the fixture has one ungraded
  section on purpose. It must read "Not graded yet", have no bar, and have no
  colour that differs from the graded rows in a way that reads as worse.
- **Off-screen numbers.** Scroll to the top, hard-reload, then read the
  attendance tiles WITHOUT scrolling:
  ```js
  Array.from(document.querySelectorAll('.wc-hover-tile')).map(n => n.innerText.split('\n')[0])
  ```
  must be `["91.6%","5","1","2","5","1"]`. React Bits' `CountUp` as published
  renders `0` and stays there until an IntersectionObserver fires, so every
  figure below the fold read as a hard zero — a student with five absences was
  shown "Absent, year: 0". It is patched here; a Pro block bringing its own
  counter can reintroduce it.
- **Decimals settle.** The average must end at `91.6%`, not `90.9%`. The
  count-up spring is overdamped and comes to rest short of its target; only a
  figure with a decimal place shows it.

---

## 5. Hall Pass — the stepper

**File** `src/routes/HallPass.tsx` · **Model** `useHallPassModel()`

| Section | Component today | What a Pro block would be |
| --- | --- | --- |
| The three-step request | `<RequestFlow model={RequestModel}>` (free `Stepper`) | a multi-step form / wizard / onboarding block |
| The open-pass panel | `<LivePass pass={LivePassModel}>` | a status / alert block |

### What it must accept

```ts
RequestModel = {
  locations: { slug: string | null; name: string; kind: string }[]
  scheduleNote: string | null   // why the timetable could not supply classrooms
  truncated: boolean            // the server cut the list short — say so
}

LivePassModel = {
  id, state, overdue, elapsed: number | null, limit: number | null,
  cancellable: boolean,   // the server refuses a cancel once approved
  waiting: boolean
}
```

Requirements:

1. **Three steps, in order, with step 1 gated.** "Next" is disabled until a
   room is chosen. The room is what the whole tap-back-in flow depends on, and
   a one-screen form is how a student sends a request with the wrong room on
   it.
2. **The submit is a mutation with a server round trip.** Keep the busy state,
   keep the disabled state, and keep the error rendered as the server's own
   sentence.
3. **`elapsed: null` is not `0`.** An unapproved pass has no elapsed time. It
   renders "—" and "minutes not reported".
4. **`cancellable: false` shows no cancel button.** Offering a button the
   server will refuse is worse than offering nothing.

### Verify after the swap

- Weight, hover gating, reduced motion, resting visibility: as §2.
- **Direction.** Press Next: the new step must come in from the RIGHT and the
  old one leave to the LEFT. The free `Stepper` shipped these inverted, so
  going forward looked like going back; on a three-step form the slide is the
  only thing telling a student which way they just moved.
- **No open-from-zero.** The free `Stepper` animated its content box from
  `height: 0` on every visit, which is both a layout-animating property and a
  visible unfold on first paint. Watch the first frame after a hard reload.
- **The palette.** React Bits ships this component with `#5227FF` circles, a
  `#5227FF` connector and a green submit button. Every one of those is replaced
  here. After any reinstall: `grep -rn "5227FF\|green-500\|green-600" src/`
  must come back empty.
- **`?demo=panel#/pass`** — the "Sample mode: this button will refuse" line and
  the classrooms-not-listed note must both survive.

---

## 6. The checklist, condensed

Run all six against any Pro block, on every route it touches:

```bash
# 1. weight — one chunk, school Chromebooks. 546 KB / 183 KB gz is the baseline.
npm run build

# 2. no new animation library, no forever-rAF, no window key handlers
grep -rn "three\|ogl\|postprocessing" src/components/<New>.tsx
grep -rn "requestAnimationFrame\|useAnimationFrame" src/components/<New>.tsx
grep -rn "window.addEventListener('keydown'\|preventDefault" src/components/<New>.tsx

# 3. resting state must be VISIBLE — this is the four-time bug
grep -rn "autoAlpha\|invisible\|visibility\|opacity: 0\|useInView\|IntersectionObserver" src/components/<New>.tsx

# 4. palette — no React Bits violet, no green
grep -rn "5227FF\|green-500\|green-600\|#84  0\|132, 0, 255" src/

# 5. hover double-gated — must print exactly one line, with `and (pointer:fine)`
grep -o "@media (hover:hover)[^{]*{" ../app/assets/*.css | sort -u

# 6. only transform and opacity animate
grep -rn "animate={{\|transition:" src/components/<New>.tsx   # then read for width/height/top/left/margin/padding/filter
```

Then open all four routes at `?demo=panel` and `?demo=legacy`, at desktop and
at 390px, and confirm nothing that was a sentence has become a number.
