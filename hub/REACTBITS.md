# React Bits as a component source

Pull any of 166 animated components into this project from the terminal.

```bash
cd hub
npm run rb:catalog            # browse all 166
npm run rb:catalog -- card    # filter by name
npm run rb -- @react-bits/SplitText-JS-CSS    # install one
```

That is the real CLI. There is **no `reactbits` npm package** — it 404s — and the
`jsrepo` URL you will find in older write-ups now serves the marketing page, so
`jsrepo list` fails with `Invalid JSON: Unexpected token '<'`. React Bits ships
through a shadcn registry, wired up in `components.json`:

```json
"registries": { "@react-bits": "https://reactbits.dev/r/{name}.json" }
```

## Which variant

Every component exists in four: `-TS-TW`, `-TS-CSS`, `-JS-TW`, `-JS-CSS`.

- **`-TS-TW`** for anything staying in `hub/`. That is what this app is built in,
  and it is what the sixteen components already here use.
- **`-JS-CSS`** when you want the component as a *reference* rather than a
  dependency — plain JavaScript and a real `.css` file, no Tailwind classes to
  unpick. This is the variant to reach for when porting an effect into the
  static app at the repo root, which has no build step and cannot import React.
  The CSS file is usually liftable nearly as-is; the JSX is not, but the
  keyframes, curves and layering are the part worth stealing.

Installing both variants of the same component leaves you with `Name.tsx` and
`Name.jsx` side by side. Delete the one you are not using — nothing warns you.

## Read before you install

```bash
curl -s https://reactbits.dev/r/SplitText-TS-TW.json | python3 -m json.tool
```

The registry entry carries the full source, the description, and — the field
that matters most — `dependencies`. Several components pull `gsap`, `motion`, or
both. Four in the catalogue need nothing: **ClickSpark, GlareHover,
SpotlightCard, StarBorder**.

## The alias gotcha

`components.json` writes to `@/components`. The shadcn CLI resolves that alias
from **`tsconfig.json`**, not `tsconfig.app.json`. Vite's React template puts
`paths` in the app config only, so the CLI cannot resolve the alias, gives up
quietly, and creates a literal directory named `@` at the project root. Your
imports still point at `src/`, so the component appears to have installed and is
simply not there.

`tsconfig.json` here carries a `paths` block for exactly this reason. Leave it.

## Check the component before you trust it

These are community components, not a vendored library, and the CLI copies them
into your source tree — which means their bugs are now your bugs, and you can
fix them in place. Four found while building this app, all fixed and marked
`WILDCAT CHANGE` in-file:

- **Counter** called `useSpring` after an early return — a rules-of-hooks
  violation that throws "rendered fewer hooks than expected" the first time a
  value has decimals.
- **ClickSpark** ran a `requestAnimationFrame` loop for the life of the page,
  clearing an empty canvas sixty times a second.
- **AnimatedList** `preventDefault`s Tab at the *window*, taking the key away
  from every other element on the page.
- **AnimatedList** re-fired on every scroll and revealed at 0.5 visibility, so
  the row you scrolled toward was the blank one.

Worth checking on anything new: does it run a rAF loop forever, does it attach
window-level key handlers, does it hardcode a colour (React Bits violet is
`#5227FF`), and does it animate anything other than `transform` and `opacity`.

## Weight

The sixteen components here, plus gsap and motion, come to **541 KB of
JavaScript, 182 KB gzipped, in one chunk**. These are school Chromebooks. Prefer
the dependency-free four, check `dependencies` before adding another animation
library, and split routes before this grows.

## Motion standard

React Bits publishes its own animation standard, and it is stricter than its
components are by default — including a frequency table that says anything used
100+ times a day gets no animation at all.

<https://github.com/DavidHDev/react-bits/blob/main/AGENTS/SKILLS/review-animations/STANDARDS.md>

The static app's `wildcat-motion.css` is built to those exact curves and
durations, so the two surfaces move the same way.

## Licence

MIT + Commons Clause. Free for personal and commercial use; you cannot sell the
components themselves.
