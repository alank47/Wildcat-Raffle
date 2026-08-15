import type { ReactNode } from "react";
import SpotlightCard from "@/components/SpotlightCard";
import CountUp from "@/components/CountUp";
import AnimatedContent from "@/components/AnimatedContent";
import { useFinePointer, useReducedMotion } from "@/lib/motion";
import type { Panel as PanelShape } from "@/lib/shapes";
import type { Async } from "@/lib/session";

/* ------------------------------------------------------------------
   Surface
   ------------------------------------------------------------------ */

/**
 * The one card surface for the whole app. SpotlightCard does the work — a
 * pointer-following wash of school blue, which is cheap (one radial gradient,
 * no per-frame layout) and only ever runs on a device that has a pointer.
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
 * THE MOST IMPORTANT COMPONENT IN THIS APP.
 *
 * Everything the backend cannot answer comes back as {available:false, reason}
 * and lands here. Never a 0, never an F, never a blank box, never "$0.00".
 * The reason is the server's own sentence — written for a student, and usually
 * naming who can fix it — so it is printed rather than paraphrased.
 */
export function Unavailable({
  reason,
  tone = "neutral",
}: {
  reason: string | null;
  tone?: "neutral" | "warn";
}) {
  return (
    <div
      className={`rounded-[12px] border px-4 py-3 text-[13.5px] leading-[1.45] ${
        tone === "warn"
          ? "border-wc-orange/40 bg-wc-orange/10 text-[#F3C9A6]"
          : "border-[var(--wp-hair)] bg-white/[0.03] text-wp-dim"
      }`}
    >
      {reason ??
        "This is not available yet, and the server did not say why. Ask the " +
          "front office to check your record in PowerSchool."}
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
 * Every number that arrives from the server counts up on arrival. This is the
 * one place motion is spent generously: it is reveal-on-load, it happens once
 * per screen visit, and it is explanatory — the count is what tells a student
 * the figure is theirs and freshly fetched rather than a placeholder.
 *
 * `value === null` NEVER renders 0. It renders what is missing, in words.
 */
export function Stat({
  value,
  label,
  suffix = "",
  missing,
  accent = "text-wp-fg",
  size = "text-[30px]",
  duration = 0.7,
  delay = 0,
}: {
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
  return (
    <div>
      {/* Deliberately NOT tabular-nums. Tabular figures give the thousands
          comma a full digit cell, so "1,040" renders as "1 , 040". The count-up
          changes width for half a second either way; a readable number for the
          rest of the time is the better trade. */}
      <div
        className={`${size} font-bold leading-none ${accent}`}
        aria-label={value === null ? missing : `${value}${suffix}`}
      >
        {value === null ? (
          <span className="text-[15px] font-normal text-wp-dim">{missing}</span>
        ) : reduced ? (
          <>
            {formatNumber(value)}
            {suffix}
          </>
        ) : (
          <>
            <CountUp to={value} duration={duration} delay={delay} separator="," />
            {suffix}
          </>
        )}
      </div>
      <p className="mt-1.5 text-[12px] font-medium tracking-[0.02em] text-wp-dim">
        {label}
      </p>
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
 * The route transition. AnimatedContent, keyed on the path so it replays on
 * navigation, and deliberately restrained: 10px of rise (the --wcm-rise token)
 * over 260ms, which is the app's existing pane-swap band. React Bits' default is
 * 100px over 800ms, which on a nav a student uses all day would feel like the
 * page is being winched into place.
 */
export function RouteFrame({
  routeKey,
  children,
}: {
  routeKey: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  return (
    <AnimatedContent
      key={routeKey}
      distance={reduced ? 0 : 10}
      duration={reduced ? 0.15 : 0.26}
      ease="power2.out"
      threshold={0}
      initialOpacity={0}
      scale={1}
    >
      {children}
    </AnimatedContent>
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
    return <Unavailable reason={from.message} tone="warn" />;
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
