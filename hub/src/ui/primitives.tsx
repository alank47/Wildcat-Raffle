import { useCallback, useState, type ReactNode } from "react";
import SpotlightCard from "@/components/SpotlightCard";
import CountUp from "@/components/CountUp";
import { useArrival } from "@/lib/arrive";
import { useFinePointer, useReducedMotion } from "@/lib/motion";
import type { Panel as PanelShape } from "@/lib/shapes";
import type { StatModel } from "@/lib/viewmodel";
import type { Async } from "@/lib/session";

/* ------------------------------------------------------------------
   Surface
   ------------------------------------------------------------------ */

/**
 * The one card surface for the whole app. SpotlightCard does the work — a
 * pointer-following wash of school blue, which is cheap (one radial gradient,
 * no per-frame layout) and only ever runs on a device that has a pointer.
 *
 * NO LIFT ON THE PANEL ITSELF. Every one of these holds something that already
 * answers to a pointer — a row, a tile, a chip — and two things moving under
 * one cursor makes the smaller one, which is the one carrying the information,
 * harder to read. The panel's hover response is the wash and nothing else.
 */
export function Surface({
  children,
  className = "",
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  const fine = useFinePointer();
  return (
    <SpotlightCard
      enabled={fine}
      spotlightColor="rgba(181, 212, 244, 0.10)"
      className={`rounded-[17px] border border-[var(--wp-hair)] bg-wp-raise ${
        padded ? "p-5 sm:p-6" : ""
      } ${className}`}
    >
      {children}
    </SpotlightCard>
  );
}

/**
 * The heading at the top of a route. A plain <h1>.
 *
 * IT USED TO BE React Bits' `BlurText`, AND THAT WAS THE SAME BUG A FOURTH
 * TIME. BlurText splits the string into words, renders each as a `motion.span`
 * whose `initial` is `{opacity: 0, filter: 'blur(10px)', y: -50}`, and only
 * animates toward opacity 1 once an IntersectionObserver reports the paragraph
 * on screen. So "Hi, Jordan", "Schedule", "Grades" and "Hall pass" all rested
 * at invisible and needed both an observer and a Framer tween to appear. It
 * also animated `filter`, which is neither transform nor opacity, and left
 * `will-change: transform, filter, opacity` on every word for the life of the
 * page.
 *
 * AND IT SHOULD NOT HAVE BEEN ANIMATED SEPARATELY AT ALL. rb-standards'
 * frequency table: something seen tens of times a day gets its animation
 * "removed or drastically reduced". The sign-in screen is opened once a morning
 * and earns its per-character reveal; these four are opened all day. The
 * heading now rides the page's own `wc-stagger` as part of its <header>, which
 * is one 260ms rise it shares with everything else on the screen.
 */
export function PageTitle({
  children,
  size = "text-[28px]",
}: {
  children: ReactNode;
  size?: string;
}) {
  return (
    <h1
      className={`${size} leading-[1.06] font-bold tracking-[-0.022em] text-wp-fg`}
    >
      {children}
    </h1>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-bold uppercase tracking-[0.09em] text-wp-dim">
      {children}
    </p>
  );
}

/* ------------------------------------------------------------------
   Absence
   ------------------------------------------------------------------ */

/**
 * Convex's request id, big enough to copy onto a piece of paper.
 *
 * IT LIVES HERE RATHER THAN ON THE SIGN-IN SCREEN because it is needed in two
 * places now: a redacted refusal from `hallPasses:myCurrentClass` leaves a
 * signed-in student with exactly as little to go on as a redacted refusal from
 * `me:get` leaves a student who never got in, and both hand the office the same
 * single handle. Two copies of a chip whose whole job is to be transcribed
 * correctly is two chips that can disagree about what they are transcribing.
 */
export function Reference({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(id);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      } catch {
        /* No clipboard permission. The text is select-all, so it is still
           gettable by hand, and it is on screen to write down either way. */
      }
    })();
  }, [id]);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <code className="wc-scroll max-w-full overflow-x-auto rounded-[8px] border border-[var(--wp-hair)] bg-black/35 px-2.5 py-1.5 font-mono text-[13.5px] tracking-[0.04em] text-wp-fg select-all">
        {id}
      </code>
      <button
        type="button"
        onClick={copy}
        className="wc-press rounded-full border border-[var(--wp-hair)] px-3 py-1.5 text-[12px] font-bold text-wp-dim"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * The redacted message ends by telling the student to show the office a
 * reference, and the reference is then rendered underneath as a chip with a
 * copy button. Left alone that is the same instruction twice in three lines.
 * The chip is the better carrier — it can be copied — so the sentence comes off
 * the end of the prose whenever the chip is going to appear. When there is NO
 * id, the sentence is the only thing standing and it stays.
 */
export function trimReferenceSentence(
  message: string,
  hasChip: boolean,
): string {
  if (!hasChip) return message;
  return message
    .replace(/\s*Show the office this reference:[^.]*\.\s*$/i, "")
    .trim();
}

/**
 * THE MOST IMPORTANT COMPONENT IN THIS APP.
 *
 * Everything the backend cannot answer comes back as {available:false, reason}
 * and lands here. Never a 0, never an F, never a blank box, never "$0.00".
 * The reason is the server's own sentence — written for a student, and usually
 * naming who can fix it — so it is printed rather than paraphrased.
 *
 * `reference` is Convex's request id on a REDACTED refusal, where the server
 * wrote no sentence of its own and this box would otherwise be the app
 * apologising with nothing attached. It is the only thing the office can look
 * up, so it is rendered as something copyable rather than left inside the
 * prose. Null on every other kind of failure; see errorRef in lib/convex.ts.
 */
export function Unavailable({
  reason,
  tone = "neutral",
  reference = null,
}: {
  reason: string | null;
  tone?: "neutral" | "warn";
  reference?: string | null;
}) {
  const text =
    reason ??
    "This is not available yet, and the server did not say why. Ask the " +
      "front office to check your record in PowerSchool.";

  return (
    <div
      className={`rounded-[12px] border px-4 py-3 text-[13.5px] leading-[1.45] ${
        tone === "warn"
          ? "border-wc-orange/40 bg-wc-orange/10 text-[#F3C9A6]"
          : "border-[var(--wp-hair)] bg-white/[0.03] text-wp-dim"
      }`}
    >
      {trimReferenceSentence(text, Boolean(reference))}
      {reference && <Reference id={reference} />}
    </div>
  );
}

/** A value that is simply not on file. Distinct from a value of zero. */
export function NotOnFile({ what }: { what: string }) {
  return (
    <span className="text-[15px] font-normal text-wp-dim">
      No {what} on file
    </span>
  );
}

/* ------------------------------------------------------------------
   Numbers
   ------------------------------------------------------------------ */

/**
 * A number ARRIVING from the server counts up. A number that was already there
 * does not.
 *
 * The count is explanatory motion — it is what tells a student the figure is
 * theirs and freshly fetched rather than a placeholder. That meaning survives
 * exactly as long as the count is rare. Every count-up in React Bits starts on
 * MOUNT, and a mount is not an arrival: the route frame is keyed on the path so
 * the whole screen re-mounts on every navigation, `refresh()` re-renders all
 * four panels after a hall-pass mutation, and StrictMode mounts twice. Tapping
 * Cards, Grades, Cards used to roll the same four figures up from zero three
 * times, and by the third the motion means nothing except that the app is
 * fidgeting.
 *
 * `useArrival` decides, per named figure, whether this value is new to the page.
 * When it is not, the number is simply printed. See lib/arrive.ts.
 *
 * `value === null` NEVER renders 0 and never counts. It renders what is
 * missing, in words.
 */
export function Stat({
  id,
  value,
  label,
  suffix = "",
  missing,
  accent = "text-wp-fg",
  size = "text-[30px]",
  duration = 0.7,
  delay = 0,
}: {
  /** Unique app-wide. Two Stats sharing an id would silence each other. */
  id: string;
  value: number | null;
  label: string;
  suffix?: string;
  missing: string;
  accent?: string;
  size?: string;
  duration?: number;
  delay?: number;
}) {
  const reduced = useReducedMotion();
  const arriving = useArrival(id, value);

  return (
    <div className="wc-hover-tile">
      {/* THE WHOLE TILE IS HIDDEN FROM ASSISTIVE TECH and replaced by one
          sentence below.

          Not fussiness: CountUp animates by writing `textContent` every frame,
          so a screen reader pointed at the visible element reads whatever
          number happens to be passing — a student on a screen reader was being
          told their ticket total was 11, then 43, then 68. The one sentence is
          the final value, printed once, and it carries the label with it so
          "74" is heard as "Total, 74" rather than as a loose number. */}
      <div aria-hidden="true">
        {/* Deliberately NOT tabular-nums. Tabular figures give the thousands
            comma a full digit cell, so "1,040" renders as "1 , 040". The
            count-up changes width for half a second either way; a readable
            number for the rest of the time is the better trade. */}
        <div className={`${size} font-bold leading-none ${accent}`}>
          {value === null ? (
            <span className="text-[15px] font-normal text-wp-dim">
              {missing}
            </span>
          ) : reduced || !arriving ? (
            <>
              {formatNumber(value)}
              {suffix}
            </>
          ) : (
            <>
              <CountUp
                to={value}
                duration={duration}
                delay={delay}
                separator=","
              />
              {suffix}
            </>
          )}
        </div>
        <p className="wc-tile-label mt-1.5 text-[12px] font-medium tracking-[0.02em] text-wp-dim transition-colors duration-[160ms]">
          {label}
        </p>
      </div>
      <span className="sr-only">
        {label}:{" "}
        {value === null ? missing : `${formatNumber(value)}${suffix}`}
      </span>
    </div>
  );
}

/**
 * A row of figures from a model. The only thing it adds over mapping Stat by
 * hand is the stagger: 70ms apart, so a row of four reads left to right instead
 * of arriving as one block. Capped, because the last one still has to land
 * inside the count.
 */
export function StatRow({
  stats,
  columns,
  size,
  accentFirst = false,
}: {
  stats: StatModel[];
  columns: string;
  size?: string;
  /** The headline figure of the group, in school blue. */
  accentFirst?: boolean;
}) {
  return (
    <div className={`grid ${columns} gap-y-6 gap-x-4`}>
      {stats.map((stat, i) => (
        <Stat
          key={stat.id}
          id={stat.id}
          value={stat.value}
          label={stat.label}
          suffix={stat.suffix}
          missing={stat.missing}
          accent={accentFirst && i === 0 ? "text-wc-blue-pale" : "text-wp-fg"}
          size={accentFirst && i === 0 ? undefined : (size ?? "text-[24px]")}
          delay={Math.min(i * 0.07, 0.28)}
        />
      ))}
    </div>
  );
}

export function formatNumber(n: number): string {
  return Intl.NumberFormat("en-US", {
    maximumFractionDigits: Number.isInteger(n) ? 0 : 1,
  }).format(n);
}

/* ------------------------------------------------------------------
   Route transition
   ------------------------------------------------------------------ */

/**
 * The route transition. 10px of rise over 260ms, keyed on the path so it
 * replays on navigation.
 *
 * IT USED TO BE `AnimatedContent`, AND THAT WAS THE SIGN-IN BUTTON BUG WITH THE
 * WHOLE APP INSIDE IT.
 *
 * AnimatedContent renders its wrapper as `<div className="invisible ...">` —
 * Tailwind's `visibility: hidden` — and the ONLY thing that ever restores it is
 * `gsap.set(el, { visibility: 'visible' })` inside a useEffect, behind a
 * ScrollTrigger that has to fire `onEnter` before the timeline plays. So the
 * resting state of every signed-in screen was invisible, and three separate
 * things had to go right — gsap parses and registers, the effect runs, the
 * trigger fires — before a student saw their timetable. A backgrounded tab on a
 * cold Chromebook is exactly the case that broke the sign-in button, and this
 * was the same wager for four screens instead of one.
 *
 * It is now a CSS keyframe that only ever takes opacity and position AWAY from
 * a visible resting state. The worst case of a failed animation here is no
 * animation. Nothing has to load for the schedule to be on screen.
 */
export function RouteFrame({
  routeKey,
  children,
}: {
  routeKey: string;
  children: ReactNode;
}) {
  return (
    <div key={routeKey} className="wc-enter">
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------
   Loading and failure
   ------------------------------------------------------------------ */

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2.5" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-[52px] animate-pulse rounded-[12px] bg-white/[0.045]"
          style={{ animationDelay: `${i * 90}ms` }}
        />
      ))}
    </div>
  );
}

/**
 * One place that turns an Async<T> into something on screen. The error branch
 * shows the server's sentence, because a Convex refusal here is written for the
 * student ("Your student number is not on your account yet...") and turning that
 * into "Something went wrong" throws away the only actionable thing on the page.
 *
 * And when the server wrote NO sentence — a redacted refusal, which is also
 * what a function that is not deployed looks like from out here — the request id
 * carried on the error state goes on screen as a copyable chip. That is the one
 * failure where the app has nothing useful to say, so it must at least hand over
 * the handle somebody else can act on.
 */
export function Loaded<T>({
  from,
  rows = 3,
  children,
}: {
  from: Async<T>;
  rows?: number;
  children: (data: T) => ReactNode;
}) {
  if (from.state === "idle" || from.state === "loading")
    return <Skeleton rows={rows} />;
  if (from.state === "error")
    return (
      <Unavailable
        reason={from.message}
        tone="warn"
        reference={from.requestId ?? null}
      />
    );
  return <>{children(from.data)}</>;
}

/* ------------------------------------------------------------------
   Provenance
   ------------------------------------------------------------------ */

/**
 * "Where did this come from and when." Brief Phase 6 point 2.
 *
 * It also prints WHICH WIRE SHAPE the panel arrived in. That is not decoration:
 * production is running an older `myStudentView` that returns bare arrays, this
 * branch returns {available, reason, courses}, and the failure mode of getting
 * that wrong is an empty panel that looks exactly like a student with no grades.
 * If the line says "legacy array" and the list is empty, that is a fact about
 * the deployment, and it is on screen instead of in a console nobody opens.
 */
export function Provenance({
  dataAsOf,
  panel,
  extra,
}: {
  dataAsOf?: string | null;
  panel?: PanelShape<unknown>;
  extra?: string;
}) {
  const bits: string[] = [];
  if (dataAsOf) bits.push(`PowerSchool data as of ${friendlyTime(dataAsOf)}`);
  if (panel) {
    bits.push(
      panel.shape === "panel"
        ? "server sent an availability panel"
        : panel.shape === "legacy-array"
          ? "server sent the older list-only shape"
          : "server sent a shape this app could not read",
    );
  }
  if (extra) bits.push(extra);
  if (!bits.length) return null;

  return (
    <p className="mt-3 text-[11.5px] leading-[1.5] text-wp-dim/80">
      {bits.join(" · ")}
    </p>
  );
}

export function friendlyTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/* ------------------------------------------------------------------
   Demo banner
   ------------------------------------------------------------------ */

export function DemoBanner({ mode }: { mode: "panel" | "legacy" }) {
  return (
    <div className="mb-4 rounded-[12px] border border-wc-yellow/45 bg-wc-yellow/10 px-4 py-2.5 text-[12.5px] leading-[1.45] text-wc-yellow">
      <strong className="font-bold">Sample data.</strong> Nobody is signed in.
      These figures are invented, and are here to show the screens
      {mode === "legacy"
        ? " against the OLDER response shape that production still returns (bare arrays, no reason field)."
        : " against the response shape this branch returns ({available, reason, courses})."}
    </div>
  );
}
