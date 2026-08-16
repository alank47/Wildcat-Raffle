import type { CSSProperties } from "react";
import CountUp from "@/components/CountUp";
import { useArrival } from "@/lib/arrive";
import { useReducedMotion } from "@/lib/motion";
import {
  useGradesModel,
  type GradeRowModel,
  type GradesModel,
} from "@/lib/viewmodel";
import {
  Loaded,
  PageTitle,
  Provenance,
  SectionLabel,
  StatRow,
  Surface,
  Unavailable,
} from "@/ui/primitives";

/**
 * Grades and attendance.
 *
 * THE RULE THIS SCREEN EXISTS TO OBEY, from convex/studentPortalRules.ts: a
 * student with no gradebook entry must not appear to be failing. `graded` on a
 * row is false for an ungraded section — PowerSchool writes "" for a section
 * that has been created but not marked — and that row renders the words "Not
 * graded yet", never a dash that reads as a zero, never an empty box that reads
 * as a page that failed to load, never a colour that reads as an F, and NEVER a
 * bar of zero length in a column of full ones.
 *
 * That last one is why the bar is drawn from the model's `percent` and skipped
 * entirely when it is null, rather than defaulting to 0. `useGradesModel()`
 * owns the decision; this file only draws it.
 */
export default function Grades() {
  const model = useGradesModel();

  return (
    <div className="wc-stagger space-y-5">
      <header>
        <PageTitle>Grades</PageTitle>
        <p className="mt-1.5 text-[13.5px] text-wp-dim">
          Current marks from the PowerSchool gradebook.
        </p>
      </header>

      <Loaded from={model} rows={5}>
        {(data) => <GradesView model={data} />}
      </Loaded>
    </div>
  );
}

/* ==================================================================
   Presentation
   ================================================================== */

function GradesView({ model }: { model: GradesModel }) {
  return (
    /* A fragment, not a wrapper div, and that is load-bearing. These three
       panels become the 2nd, 3rd and 4th DOM children of the page's
       `wc-stagger`, so they inherit its 45ms beat instead of arriving as one
       block behind the header. It also means they animate in when the query
       RESOLVES — the skeleton is a different element, so replacing it starts
       the entrance again, and the reveal lands on the data rather than on the
       placeholder. */
    <>
      {/* The overview strip. Every number here counts up the first time it
          arrives, and prints flat on every visit after that. */}
      <Surface>
        <SectionLabel>This term</SectionLabel>
        <div className="mt-4">
          <StatRow
            stats={model.summary}
            columns="grid-cols-3"
            accentFirst
          />
        </div>
        <p className="mt-4 text-[11.5px] leading-[1.5] text-wp-dim/85">
          {model.summaryNote}
        </p>
      </Surface>

      <Surface padded={false}>
        <div className="px-5 pt-5 sm:px-6">
          <SectionLabel>Courses</SectionLabel>
        </div>

        {model.emptyReason && (
          <div className="p-5 sm:p-6">
            <Unavailable
              reason={model.emptyReason}
              tone={model.refused ? "warn" : "neutral"}
            />
          </div>
        )}

        {model.rows.length > 0 && (
          /* CSS stagger, not React Bits' AnimatedList — see the long note on
             the same change in Schedule.tsx. The short version: AnimatedList's
             resting state for a row is opacity 0, restored only once a Framer
             `useInView` observer fires, which put a student's gradebook behind
             the same wager that lost the sign-in button. */
          <div
            role="list"
            className="wc-stagger space-y-1 px-2.5 pt-3 pb-2 [--wc-enter-delay:90ms] sm:px-3.5"
          >
            {model.rows.map((row, i) => (
              <GradeRowView key={row.id} row={row} index={i} />
            ))}
          </div>
        )}

        <div className="px-5 pb-5 sm:px-6">
          <Provenance {...model.provenance} />
        </div>
      </Surface>

      <Surface>
        <SectionLabel>Attendance</SectionLabel>
        {model.attendance.available ? (
          <>
            <div className="mt-4">
              <StatRow stats={model.attendance.stats} columns="grid-cols-3" />
            </div>
            <p className="mt-4 text-[11.5px] leading-[1.5] text-wp-dim/85">
              {model.attendance.note}
            </p>
          </>
        ) : (
          <div className="mt-3">
            <Unavailable reason={model.attendance.reason} />
          </div>
        )}
      </Surface>
    </>
  );
}

function GradeRowView({ row, index }: { row: GradeRowModel; index: number }) {
  const reduced = useReducedMotion();
  const arriving = useArrival(row.id, row.percent);
  const delay = Math.min(index * 0.045, 0.36);

  return (
    <div
      role="listitem"
      className="wc-hover-row rounded-[12px] border border-transparent px-3 py-3"
    >
      <div className="flex items-center gap-3.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold text-wp-fg">
            {row.course}
          </p>
          <p className="mt-0.5 truncate text-[12.5px] text-wp-dim">
            {row.courseNumber}
          </p>
        </div>

        {!row.graded ? (
          /* Not a dash, not a blank, not red. Words. */
          <span className="shrink-0 rounded-full border border-[var(--wp-hair)] px-3 py-1 text-[12px] font-medium text-wp-dim">
            Not graded yet
          </span>
        ) : (
          <div className="shrink-0 text-right">
            <p className="text-[20px] leading-none font-bold text-wp-fg">
              {row.letter ?? "—"}
            </p>
            {row.percent !== null && (
              <p className="mt-1 text-[12.5px] text-wc-blue-pale">
                {reduced || !arriving ? (
                  <>{row.percent}</>
                ) : (
                  <CountUp to={row.percent} duration={0.7} delay={delay} />
                )}
                %
              </p>
            )}
          </div>
        )}
      </div>

      {/* THE BAR IS DRAWN ONLY WHERE THERE IS A PERCENT.
          A row with no mark gets no track and no fill — not an empty track,
          which in a column of filled ones is a picture of a zero, and this
          whole screen exists so that an ungraded section cannot look like a
          failed one. It is a scaleX on a pseudo-element, so the growth is a
          composited transform rather than an animated width, and it grows only
          on the visit where the mark actually arrived. */}
      {row.graded && row.percent !== null && (
        <div
          className={`wc-bar mt-2.5 ${reduced || !arriving ? "" : "wc-bar-grow"}`}
          style={
            {
              "--wc-bar": Math.max(0, Math.min(1, row.percent / 100)),
              "--wc-bar-delay": `${delay}s`,
            } as CSSProperties
          }
          aria-hidden="true"
        />
      )}
    </div>
  );
}
