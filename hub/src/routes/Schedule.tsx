import {
  useScheduleModel,
  type ClassRowModel,
  type ScheduleModel,
} from "@/lib/viewmodel";
import {
  Loaded,
  PageTitle,
  Provenance,
  SectionLabel,
  Surface,
  Unavailable,
} from "@/ui/primitives";

/**
 * The timetable.
 *
 * The data half is `useScheduleModel()` in lib/viewmodel.ts, and it is doing
 * more than it looks: `views_app:myStudentView.schedule` arrives in one of two
 * shapes depending on how old the deployment is, and if that panel refuses (no
 * school email on the student record, which is the live state for a lot of
 * students until PowerSchool manifest field 19 is approved) the rows from
 * `me:get` are offered instead, because me:get joins the SAME roster table on
 * the SAME email key and is simply a second door to it. The provenance line
 * always says which door was used.
 *
 * None of that is visible from here, which is the point. This file draws
 * `ScheduleModel` and nothing else, so the list can be replaced wholesale.
 */
export default function Schedule() {
  const model = useScheduleModel();
  return (
    <div className="wc-stagger space-y-5">
      <header>
        <PageTitle>Schedule</PageTitle>
        <p className="mt-1.5 text-[13.5px] text-wp-dim">
          Your sections this term, from PowerSchool.
        </p>
      </header>

      <Loaded from={model} rows={5}>
        {(data) => <ScheduleView model={data} />}
      </Loaded>
    </div>
  );
}

/* ==================================================================
   Presentation
   ================================================================== */

function ScheduleView({ model }: { model: ScheduleModel }) {
  return (
    <Surface padded={false}>
      <div className="px-5 pt-5 sm:px-6">
        <SectionLabel>
          {model.rows.length} class{model.rows.length === 1 ? "" : "es"}
        </SectionLabel>
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
        /**
         * THIS USED TO BE React Bits' `AnimatedList`, AND IT WAS THE SIGN-IN
         * BUTTON BUG A THIRD TIME.
         *
         * AnimatedList wraps every row in a `motion.div` whose `initial` is
         * `{opacity: 0}` and whose `animate` only reaches `{opacity: 1}` once
         * motion's `useInView` reports the row on screen. So the resting state
         * of a student's timetable was invisible, and a Framer observer had to
         * fire before any of it existed. Three components in this app shipped
         * that same wager; this was the one holding the actual data.
         *
         * The replacement is `wc-stagger`: the rows are in the document,
         * opaque, and hit-testable from the first frame, and the CSS animation
         * only ever takes that away for 260ms. It also drops a `motion`
         * dependency, the window-level Tab handler that had to be disabled by
         * hand, and a scroll listener on a list that does not scroll.
         *
         * role=list rather than <ul>: the row is a flex box with a chip in it,
         * and `li` with `display:flex` loses its list semantics in Safari
         * anyway. The roles say it plainly.
         *
         * The 90ms head start lets the panel land before its contents do.
         */
        <div
          role="list"
          className="wc-stagger space-y-1 px-2.5 pt-3 pb-2 [--wc-enter-delay:90ms] sm:px-3.5"
        >
          {model.rows.map((row, i) => (
            <ClassRowView key={i} row={row} />
          ))}
        </div>
      )}

      <div className="px-5 pb-5 sm:px-6">
        <Provenance {...model.provenance} />
      </div>
    </Surface>
  );
}

function ClassRowView({ row }: { row: ClassRowModel }) {
  return (
    /* wc-hover-row: a 2px school-blue edge appears at the left and the row
       tints. Gated on (hover: hover) and (pointer: fine) in index.css, so a
       thumb on a phone never leaves one row looking picked.

       No cursor change and no lift, because nothing opens. The treatment says
       "this is one row and it is the one your pointer is on" — which on a
       six-line timetable read across a 14" screen is the whole job. The edge
       marker is also drawn on :focus-within, OUTSIDE the hover gate, so a
       student tabbing through on a Chromebook gets the same mark. */
    <div
      role="listitem"
      className="wc-hover-row flex items-center gap-3.5 rounded-[12px] border border-transparent px-3 py-3"
    >
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-wc-blue/20 text-[14px] font-bold tabular-nums text-wc-blue-pale"
        aria-hidden="true"
      >
        {row.periodShort}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-bold text-wp-fg">{row.course}</p>
        <p className="mt-0.5 truncate text-[12.5px] text-wp-dim">{row.detail}</p>
      </div>
    </div>
  );
}
