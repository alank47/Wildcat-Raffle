import { useMemo } from "react";
import AnimatedList from "@/components/AnimatedList";
import BlurText from "@/components/BlurText";
import { useSession } from "@/lib/session";
import { useReducedMotion } from "@/lib/motion";
import { str, toPanel, type ClassRow } from "@/lib/shapes";
import {
  Loaded,
  Provenance,
  SectionLabel,
  Surface,
  Unavailable,
} from "@/ui/primitives";

/**
 * The timetable.
 *
 * Read off `views_app:myStudentView.schedule`, which arrives in one of two
 * shapes depending on how old the deployment is — see lib/shapes.ts. If that
 * panel refuses (no school email on the student record, which is the live state
 * for a lot of students until PowerSchool manifest field 19 is approved), the
 * rows from `me:get` are offered instead, because me:get joins the SAME roster
 * table on the SAME email key and is simply a second door to it. The provenance
 * line always says which door was used.
 */
export default function Schedule() {
  const { studentView, me } = useSession();
  const reduced = useReducedMotion();

  const fallbackRows = useMemo<ClassRow[]>(() => {
    if (me.state !== "ok") return [];
    const raw = me.data.schedule;
    return Array.isArray(raw) ? (raw as ClassRow[]) : [];
  }, [me]);

  return (
    <div className="space-y-5">
      <header>
        <BlurText
          text="Schedule"
          animateBy="words"
          delay={0}
          stepDuration={reduced ? 0.12 : 0.22}
          threshold={0}
          className="text-[28px] font-bold leading-tight tracking-[-0.02em] text-wp-fg"
        />
        <p className="mt-1.5 text-[13.5px] text-wp-dim">
          Your sections this term, from PowerSchool.
        </p>
      </header>

      <Loaded from={studentView} rows={5}>
        {(view) => {
          const panel = toPanel<ClassRow>(view.schedule, "classes", "schedule");
          const rows = panel.available ? panel.items : fallbackRows;
          const usedFallback = !panel.available && fallbackRows.length > 0;

          return (
            <Surface padded={false}>
              <div className="px-5 pt-5 sm:px-6">
                <SectionLabel>
                  {rows.length} class{rows.length === 1 ? "" : "es"}
                </SectionLabel>
              </div>

              {!panel.available && !usedFallback && (
                <div className="p-5 sm:p-6">
                  <Unavailable reason={panel.reason} tone="warn" />
                </div>
              )}

              {rows.length === 0 && panel.available && (
                <div className="p-5 sm:p-6">
                  <Unavailable
                    reason={
                      panel.unknownWhy
                        ? "The server sent an empty timetable and, in this older " +
                          "response shape, no reason with it. That could mean no " +
                          "sections are on your roster or that the lookup could " +
                          "not run. It should not be read as 'you have no classes'."
                        : "No sections are on your PowerSchool roster for this " +
                          "term yet."
                    }
                  />
                </div>
              )}

              {rows.length > 0 && (
                <div className="px-2.5 pb-2 pt-3 sm:px-3.5">
                  <AnimatedList
                    items={rows.map((row, i) => (
                      <ClassRowView key={i} row={row} />
                    ))}
                    reduceMotion={reduced}
                    /* Tab is not stolen from the rest of the page. See the
                       note on the prop in AnimatedList. */
                    enableArrowNavigation={false}
                    interactive={false}
                    showGradients={false}
                    displayScrollbar={false}
                    itemClassName="mb-1"
                    className=""
                  />
                </div>
              )}

              <div className="px-5 pb-5 sm:px-6">
                <Provenance
                  dataAsOf={str(view.dataAsOf)}
                  panel={panel}
                  extra={usedFallback ? "shown from me:get instead" : undefined}
                />
              </div>
            </Surface>
          );
        }}
      </Loaded>
    </div>
  );
}

function ClassRowView({ row }: { row: ClassRow }) {
  const course = str(row.courseName) ?? str(row.courseNumber) ?? "Unnamed course";
  const period = str(row.period);
  const teacher = str(row.teacher);
  const term = str(row.term);

  return (
    <div className="flex items-center gap-3.5 rounded-[12px] border border-transparent px-3 py-3 transition-colors">
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-wc-blue/20 text-[14px] font-bold tabular-nums text-wc-blue-pale"
        aria-hidden="true"
      >
        {period ? period.replace(/\(.*\)$/, "") : "—"}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-bold text-wp-fg">{course}</p>
        <p className="mt-0.5 truncate text-[12.5px] text-wp-dim">
          {teacher ?? "Teacher not listed"}
          {period ? ` · Period ${period}` : ""}
          {term ? ` · ${term}` : ""}
        </p>
      </div>
    </div>
  );
}
