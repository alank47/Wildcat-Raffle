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
