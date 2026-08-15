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

## Pro components (`@reactbits-pro`)

Pro is a separate, token-gated registry. It is configured in `components.json`,
but **both** the base URL and the token are read from the environment:

```json
"@reactbits-pro": {
  "url": "${REACTBITS_PRO_REGISTRY}/{name}.json",
  "headers": { "Authorization": "Bearer ${REACTBITS_PRO_TOKEN}" }
}
```

To use it, copy `env.local.example` to `.env.local` and fill in both values from
your React Bits Pro dashboard. Then:

```bash
npm run rb -- @reactbits-pro/auth-5
```

**This repository is public.** A Pro token in `components.json` is a Pro token
published to the internet, which is why nothing is hardcoded there — `.env.local`
is covered by the `*.local` rule in `.gitignore` and must stay that way.

The base URL lives in the environment too, rather than being hardcoded, so a
stale or wrong URL fails on the machine that has it rather than 404ing quietly
for everyone who clones the repo. `https://pro.reactbits.dev/r` was tried and
returns "not found" for `auth-5`, so the real base path has to come from the
dashboard.

Note the example file is `env.local.example`, with no leading dot: `.gitignore`
line 7 is `.env.*`, which silently swallows anything named `.env.local.example`.

### Two Pro namespaces, one key

Per pro.reactbits.dev/docs/installation:

- `@reactbits-starter` — components and the setup skill. All plans.
- `@reactbits-pro` — blocks, Application UI and the Agent Kit. Pro and Ultimate only.

`auth-5` is a block, so it needs the Pro namespace. Both are configured and both
read the same two environment variables.

### Check the key before you debug anything else

```bash
npm run rb:check            # checks auth-5
npm run rb:check -- hero-3  # checks something else
```

Every Pro failure looks identical coming out of the shadcn CLI — "not found" —
whether the base URL is wrong, the key is missing, the licence has lapsed, or
the item simply is not in your plan. `rb:check` separates them by reading the
status and the content type before anything interprets the body, and it prints
only the last four characters of the key.

Note it checks HTML **before** status: pro.reactbits.dev is a single-page app
that answers unknown paths with a styled 404, so a wrong base URL arrives as
`404` and sends you hunting for a component name that was never the problem.
