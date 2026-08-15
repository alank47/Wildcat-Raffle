import AnimatedList from "@/components/AnimatedList";
import BlurText from "@/components/BlurText";
import CountUp from "@/components/CountUp";
import { useSession } from "@/lib/session";
import { useReducedMotion } from "@/lib/motion";
import { count, str, toPanel, type GradeCell } from "@/lib/shapes";
import {
  Loaded,
  Provenance,
  SectionLabel,
  Stat,
  Surface,
  Unavailable,
} from "@/ui/primitives";

/**
 * Grades and attendance.
 *
 * THE RULE THIS SCREEN EXISTS TO OBEY, from convex/studentPortalRules.ts: a
 * student with no gradebook entry must not appear to be failing. `available` on
 * a grade row is false for an ungraded section — PowerSchool writes "" for a
 * section that has been created but not marked — and that row renders the words
 * "Not graded yet", never a dash that reads as a zero, never an empty box that
 * reads as a page that failed to load, and never a colour that reads as an F.
 */
export default function Grades() {
  const { studentView } = useSession();
  const reduced = useReducedMotion();

  return (
    <div className="space-y-5">
      <header>
        <BlurText
          text="Grades"
          animateBy="words"
          delay={0}
          stepDuration={reduced ? 0.12 : 0.22}
          threshold={0}
          className="text-[28px] font-bold leading-tight tracking-[-0.02em] text-wp-fg"
        />
        <p className="mt-1.5 text-[13.5px] text-wp-dim">
          Current marks from the PowerSchool gradebook.
        </p>
      </header>

      <Loaded from={studentView} rows={5}>
        {(view) => {
          const panel = toPanel<GradeCell>(view.grades, "courses", "grades");
          const graded = panel.items.filter((row) => row.available);
          const percents = graded
            .map((row) => count(row.currentPercent))
            .filter((n): n is number => n !== null);
          const average =
            percents.length > 0
              ? percents.reduce((a, b) => a + b, 0) / percents.length
              : null;

          return (
            <>
              {/* The overview strip. Every number here counts up because every
                  number here came off the wire. */}
              <Surface>
                <SectionLabel>This term</SectionLabel>
                <div className="mt-4 grid grid-cols-3 gap-4">
                  <Stat
                    value={average === null ? null : Math.round(average * 10) / 10}
                    label="Average of graded"
                    suffix="%"
                    missing="Nothing graded"
                    accent="text-wc-blue-pale"
                    delay={0.05}
                  />
                  <Stat
                    value={panel.available ? graded.length : null}
                    label="Graded"
                    missing="Unknown"
                    size="text-[24px]"
                    delay={0.12}
                  />
                  <Stat
                    value={
                      panel.available ? panel.items.length - graded.length : null
                    }
                    label="Not graded yet"
                    missing="Unknown"
                    size="text-[24px]"
                    delay={0.19}
                  />
                </div>
                <p className="mt-4 text-[11.5px] leading-[1.5] text-wp-dim/85">
                  The average is across sections that actually have a mark. A
                  section with no mark is not counted as a zero.
                </p>
              </Surface>

              <Surface padded={false}>
                <div className="px-5 pt-5 sm:px-6">
                  <SectionLabel>Courses</SectionLabel>
                </div>

                {!panel.available && (
                  <div className="p-5 sm:p-6">
                    <Unavailable reason={panel.reason} tone="warn" />
                  </div>
                )}

                {panel.available && panel.items.length === 0 && (
                  <div className="p-5 sm:p-6">
                    <Unavailable
                      reason={
                        panel.unknownWhy
                          ? "The server sent an empty grade list and, in this " +
                            "older response shape, no reason with it. That could " +
                            "mean nothing has been graded or that the lookup " +
                            "could not run. It must not be read as a set of zeros."
                          : "No gradebook rows have been synced for you yet."
                      }
                    />
                  </div>
                )}

                {panel.items.length > 0 && (
                  <div className="px-2.5 pb-2 pt-3 sm:px-3.5">
                    <AnimatedList
                      items={panel.items.map((row, i) => (
                        <GradeRowView key={i} row={row} index={i} />
                      ))}
                      reduceMotion={reduced}
                      enableArrowNavigation={false}
                      interactive={false}
                      showGradients={false}
                      displayScrollbar={false}
                      itemClassName="mb-1"
                    />
                  </div>
                )}

                <div className="px-5 pb-5 sm:px-6">
                  <Provenance dataAsOf={str(view.dataAsOf)} panel={panel} />
                </div>
              </Surface>

              <AttendancePanel view={view} />
            </>
          );
        }}
      </Loaded>
    </div>
  );
}

function GradeRowView({ row, index }: { row: GradeCell; index: number }) {
  const reduced = useReducedMotion();
  const course = str(row.courseName) ?? str(row.courseNumber) ?? "Unnamed course";
  const percent = count(row.currentPercent);
  const letter = str(row.currentGrade);

  return (
    <div className="flex items-center gap-3.5 rounded-[12px] px-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-bold text-wp-fg">{course}</p>
        <p className="mt-0.5 truncate text-[12.5px] text-wp-dim">
          {str(row.courseNumber) ?? "No course number"}
        </p>
      </div>

      {!row.available ? (
        /* Not a dash, not a blank, not red. Words. */
        <span className="shrink-0 rounded-full border border-[var(--wp-hair)] px-3 py-1 text-[12px] font-medium text-wp-dim">
          Not graded yet
        </span>
      ) : (
        <div className="shrink-0 text-right">
          <p className="text-[20px] font-bold leading-none text-wp-fg">
            {letter ?? "—"}
          </p>
          {percent !== null && (
            <p className="mt-1 text-[12.5px] text-wc-blue-pale">
              {reduced ? (
                <>{Math.round(percent * 10) / 10}</>
              ) : (
                <CountUp
                  to={Math.round(percent * 10) / 10}
                  duration={0.7}
                  delay={Math.min(index * 0.045, 0.36)}
                />
              )}
              %
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function AttendancePanel({ view }: { view: Record<string, unknown> }) {
  const attendance = (view.attendance ?? {}) as Record<string, unknown>;

  return (
    <Surface>
      <SectionLabel>Attendance</SectionLabel>
      {attendance.available === false ? (
        <div className="mt-3">
          <Unavailable reason={str(attendance.reason)} />
        </div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <Stat
              value={count(attendance.daysAbsentTerm)}
              label="Absent, term"
              missing="Not on file"
              size="text-[24px]"
              delay={0.05}
            />
            <Stat
              value={count(attendance.daysAbsentYtd)}
              label="Absent, year"
              missing="Not on file"
              size="text-[24px]"
              delay={0.12}
            />
            <Stat
              value={count(attendance.daysTardyTerm)}
              label="Tardy, term"
              missing="Not on file"
              size="text-[24px]"
              delay={0.19}
            />
          </div>
          <p className="mt-4 text-[11.5px] leading-[1.5] text-wp-dim/85">
            "Not on file" means the school has not sent this figure. It is not a
            count of zero.
          </p>
        </>
      )}
    </Surface>
  );
}
