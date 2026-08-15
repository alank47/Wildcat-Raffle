# Design reference: the Notasnet school dashboard

Chosen by the owner, 2026-08-15:
<https://dribbble.com/shots/26704018-School-Dashboard-Redesign-Better-UX-for-Parents-Students>
by Juan Fernando Ramirez.

Captures live in the session scratchpad as `design-ref/notasnet-dashboard-full.jpg`
and `notasnet-dashboard-detail.jpg`. **Look at them before building anything from
this document.** What follows is the system extracted from those images; it is
not a substitute for seeing it.

The instruction was: use this as the reference, keep Westbrook Academy branding.
So this is the *structure and behaviour* to adopt. The colours below are ours.

---

## Why this reference actually fits

The reference is built on blue + a lime accent + near-black on a light field.
Westbrook's palette is already that shape:

| Reference role | Reference | Westbrook token | Ours |
|---|---|---|---|
| Primary identity | royal blue | `--wc-blue` / `--wc-blue-deep` | `#2F67A7` / `#0C447C` |
| Accent, the one loud colour | lime | `--wc-yellow` | `#E6E280` |
| Ink, gauge remainder, dark chips | near-black | `--wc-ink` | `#0E0E0E` |
| Warning / attention figure | red-orange | `--wc-orange` | `#D9742F` |
| Field | light grey | `--wu-paper` | `#F7F8FA` |

So adopting the system does not mean adopting the palette. Ours is deeper and
less saturated, which suits a school run by LA Promise Fund better than a
consumer product blue. **The lime accent is the one to be disciplined about:**
in the reference it appears roughly twice per screen — the gauge arc and one
decorative shape. It is loud because it is rare.

---

## The system

**Everything is a card on a field.** No full-bleed panels, no borders doing the
work of separation. Cards are white, generously rounded (16–20px; ours is
`--wu-r-panel` 14px / `--wu-r-card` 17px), with a soft shadow rather than a
hairline, floating on light grey with real space between them.

**Three columns.** A narrow nav rail, a wide main area, and a right-hand
activity feed. The feed is not decoration: it is where "what happened recently"
lives, which is exactly what an audit log is.

**The nav rail is a card too**, white, with an icon square beside each label and
the active item as a soft blue pill. Not a coloured sidebar with white text.

**Stat tiles are small and quiet.** A label, a small arrow affordance in the top
right, then one large figure. The figure carries the colour, not the tile: 69%
is red because it is bad, not because the tile is themed red.

**One hero figure per screen, as an arc gauge.** Semi-circular, accent-coloured
arc on a near-black remainder, the number large in the middle, two small ringed
sub-figures beneath it (best and worst). This is the screen's headline.

**A timeline down the middle.** Time on the left as plain text, one card per
entry, each with a small icon square, a title and a subtitle. Rest state is
quiet; nothing shouts until it needs to.

**Filter chips as a row**, pill-shaped, one active with a tinted fill, the rest
plain. Categories in the feed repeat those chip colours so a glance sorts them.

**Circular icon buttons** for a card's own action, top right, dark fill.

**A day strip** for date navigation: today as a filled rounded square, the rest
plain, weekday abbreviation above the number.

---

## Mapping onto Wildcat Hub

This is the part that stops it being a skin. Each pattern already has a job here:

| Reference pattern | Teacher portal | Student portal |
|---|---|---|
| Identity card (big blue, school name, person selector) | Which teacher, which section they are viewing | Already exists: the ID card in the wallet stack |
| Arc gauge hero | Jackpot qualification rate, or weekly participation | Term average |
| Stat tiles with arrow | Students, qualified, tickets this week | Tickets, absences, graded |
| Timeline down the middle | Today's sections by period, and open hall passes | Today's schedule |
| Right activity feed | Audit log and recent awards | Recent tickets |
| Filter chips | Roster filters: grade, qualified, section | Grades filter |
| Day strip | Attendance and award history by day | — |

**The hall pass fits the timeline exactly.** A pass is an event with a start, a
duration and a state, and the reference's timeline card — icon square, title,
subtitle, quiet until it matters — is the right shape for "Ana Ruiz, out to the
nurse, 6 minutes".

---

## What NOT to take

- **The upsell card.** There is no plan to upgrade; this is a school system.
- **Payment surfaces.** "Próximo Pago" has no equivalent here and never should.
- **Spanish labels and the Notasnet mark.** Obviously. Westbrook Academy's
  wordmark and the LA Promise Fund line stay exactly as they are.
- **The decorative background shapes** on the presentation slide. They are shot
  dressing, not part of the product.
- **Avatar photographs of students.** The reference leans on them; we do not
  have student photos, and putting a child's face on a shared classroom screen
  is a decision nobody has made. Initials in a tinted square, as the app already
  does.

---

## The rules that outrank the reference

If the reference and these conflict, these win. They were each paid for in this
codebase:

1. **A missing value never renders as a real one.** No zero for an absent grade,
   no `$0` for an unknown balance, no `0 min` for a pass that was never
   approved. The reference has no concept of missing data; ours does.
2. **Animation never decides whether something is visible.** Resting state
   visible, animation on top.
3. **Hover only behind `@media (hover: hover) and (pointer: fine)`.**
4. **Anything a teacher does hundreds of times a day gets no animation** — see
   the frequency table in the React Bits standard.
5. **Density beats decoration on the roster.** 623 rows is the real test, not a
   dashboard with six cards. Where the reference's generous spacing would push
   a teacher's most-used table below the fold, the table wins.

---

# REVISION, 2026-08-15 — five annotated references, and a decision reversed

The owner supplied five annotated images and named each after the screen it is
for. The names are the mapping; use them.

| File | The screen it specifies |
|---|---|
| `01-side-nav-layout.webp` | The sidebar |
| `02-teacher-dashboard.webp` | The teacher dashboard, whole |
| `03-events-timeline.webp` | Events / timeline panel |
| `04-student-pass-and-cash.webp` | Student pass + Wildcat Cash view |
| `05-student-detail-staff-view.webp` | Student detail, seen by staff |

They live in the session scratchpad under `design-ref/`. **Look at them.** The
notes below are what to check yourself against, not a replacement for seeing it.

## The decision that is reversed

I previously ruled that the teacher app should take the student portal's INK
chrome — near-black sidebar and topbar — and keep a light content field. The
owner's response to that build: *"I don't like the basic changes you made, looks
cleaner but I want a full UI overhaul... get as close as possible to layout and
look and feel to the images."*

The reference sidebar is a **white rounded card on a pale field**, with a pale
blue pill for the active item and a blue-filled icon square inside it. Not ink.
So the ink chrome goes, and the whole app moves to the reference's airier,
lighter, much more rounded world.

Ink survives in exactly two places, both of which the reference itself uses as
punctuation rather than as ground: the gauge's remaining arc, and the small
circular action buttons at the top right of a panel.

## What "as close as possible" means concretely

- **Radii are much larger than what we shipped.** Panels read at roughly 20–24px,
  the identity card larger still. Our 14px panel radius is the main reason the
  first attempt reads as "cleaner" rather than as this.
- **Cards are white with a hairline and a soft shadow**, and the timeline's cards
  are outlined rather than filled — lighter than a panel, so a list of eight does
  not read as eight slabs.
- **The field is pale and slightly cool**, close to white, not a grey card deck.
- **Air.** The spacing between cards is generous and consistent. Density is not
  the aesthetic here; the roster is the one screen where our density rule still
  wins over the reference.
- **Tag pills** are small, rounded, and colour-coded by category, some outlined
  and some filled. They are how the eye sorts a feed at a glance.
- **Circular dark action buttons** (an arrow, top right) sit on panels that lead
  somewhere.
- **The identity card** is a large blue panel with a subtle wave pattern, a
  two-line display title, and a white person-selector pill carrying an avatar and
  a chevron. A circular badge overlaps its top-left corner.
- **The day strip**: today is a filled blue rounded square with a word above the
  number; the rest are outlined.
- **The timeline** is a true vertical line with dots, the time above each card,
  and quiet inline rows for breaks.
- **The gauge** is a thick rounded arc with a large centred number and two small
  ringed sub-figures beneath.

## What still outranks the reference

Unchanged from above: a missing value never renders as a real one; animation
never decides visibility; hover stays gated; anything done hundreds of times a
day gets no animation; the roster stays dense.

And the branding rule the owner restated: **Westbrook Academy across the app.**
The reference's Notasnet mark, its Spanish labels, its payment surfaces and its
upsell card do not come with it. The banner slot at the bottom of the sidebar is
worth keeping as a school announcement space rather than an upsell.

---

# WHAT WAS BUILT, 2026-08-15

## Measured off the reference, not eyeballed

Sampled out of `02-teacher-dashboard.webp` after cropping away the blue
presentation backdrop — that bright blue is the slide, not the UI.

| Role | Reference | Ours | Why they differ |
|---|---|---|---|
| Card / panel surface | `#FFFFFF` | `#FFFFFF` | same; no tint on any card |
| Field | pale, cool | `--wu-paper #F2F6FB` | same character |
| Identity card | `#0074E3` | `--wc-blue #2F67A7` | branding outranks fidelity |
| Gauge accent arc | `#ECF869` | `--wc-yellow #E6E280` | branding outranks fidelity |
| Gauge remainder | `#333333` | `--wu-gauge-rest #333333` | **not ink.** A charcoal recedes behind the accent; `--wc-ink` competes with it |

Ours reads softer than the image and that is correct. The punch is bought
back with radius, air, shadow and the size of the identity card, never by
drifting the blue or the yellow toward the reference's.

## Tokens that moved

| Token | Was | Now |
|---|---|---|
| `--wu-r-card` | 17px | 28px |
| `--wu-r-panel` | 14px | 22px |
| `--wu-r-inner` | — | 16px (timeline / feed cards) |
| `--wu-r-control` | 10px | 14px |
| `--wu-r-chip` | 7px | 999px |
| `--wu-paper` | `#F7F8FA` | `#F2F6FB` |
| `--wu-shadow-1` | 1px+3px blur | 2px+22px blur |
| `--wu-s5` / `--wu-s6` | 24 / 32 | 20 / 28 (+ `--wu-s7` 36) |
| `--wc-topbar-h` | 58px | 66px |
| `--wp-radius` (portal) | 17 / 15 / 20 | 20 / 17 / 26 |

`--wp-strip`, `--wp-card-h` and `--wp-tuck` are UNTOUCHED. The portal's
stack geometry was measured against Wallet and none of it moved.

## The two compositions per view

|  | Desktop | Phone | Switches at |
|---|---|---|---|
| Teacher dashboard | three columns: identity + tiles + gauge / events timeline / activity feed | one column re-ordered: identity, **award actions**, the day, tiles, gauge, feed | 1240px to two columns, 900px to one — 900 is where the sidebar becomes a drawer, so it is where the page stops being a desk |
| Student detail (staff) | two columns: figures left, ticket history right | 05's own single column | 760px, where two columns stop being readable inside a modal |
| Student portal | stack left, the open card's **body moved** into a detail panel right | the Wallet stack, unchanged | 1000px, the width at which a 430px stack plus a readable detail panel both fit |

The teacher phone layout leads with Award Tickets because that is what a
teacher opens a phone for while standing in front of a class. It is always
in the markup and switched by a media query; no script decides whether it
is visible.

## Where we deliberately diverge

- **Day strip runs backwards.** The reference's runs forward from today
  because its events are lessons still to come. Ours looks back because
  what is recorded on a day is what happened on it. Today is still the
  filled cell and still first.
- **No person photographs anywhere**, on either side of the app.
- **No chevron without a destination.** The reference's person pill has a
  selector chevron; ours only carries one because the pill goes somewhere
  real (My Activity on the dashboard, the Profile tab in the modal).
- **Filter chips are built from what is in the log**, so a chip can never
  select an empty result.
- **The roster keeps its density.** 13 rows above the fold at 1280x800 is
  the number; the overhaul cost two and they were bought back above the
  table, never inside a row.
