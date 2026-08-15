import { useState } from "react";
import ClickSpark from "@/components/ClickSpark";
import StarBorder from "@/components/StarBorder";
import { useSession } from "@/lib/session";
import { useArrival } from "@/lib/arrive";
import { useReducedMotion } from "@/lib/motion";
import { errorRef, errorText } from "@/lib/convex";
import { str } from "@/lib/shapes";
import {
  useHallPassModel,
  type CurrentClassModel,
  type LivePassModel,
  type PassRouting,
} from "@/lib/viewmodel";
import {
  Loaded,
  PageTitle,
  SectionLabel,
  Surface,
  Unavailable,
} from "@/ui/primitives";

/**
 * Asking to leave the room.
 *
 * THE STUDENT PICKS NOTHING, AND THAT IS THE WHOLE SCREEN.
 *
 * A hall pass originates from the class the student is scheduled into at the
 * moment they ask. The app asks the server which class that is —
 * `hallPasses:myCurrentClass`, no arguments — and the request routes to that
 * section's teacher. There is nothing here to choose, and no argument on
 * `requestMine` that could point it anywhere else.
 *
 * WHAT WAS DELETED, AND WHY IT CANNOT COME BACK AS A FALLBACK. This route used
 * to open with a grid of rooms read from `tapLocations:listForStudents` and a
 * three-step Stepper: pick where you are, say why, confirm. So the record said
 * where a fourteen-year-old tapped rather than where they were, and the request
 * landed on every teacher's board instead of on the one teacher who could see
 * them. The picker is gone, the step is gone, and the Stepper went with it: a
 * student asking to leave the room should not be walked through a wizard for
 * one optional field.
 *
 * WHEN THE CLASS CANNOT BE WORKED OUT, NOTHING IS OFFERED IN ITS PLACE. Around
 * twenty distinct refusals can come back — lunch, a passing period, before
 * school, after school, a Saturday, a holiday, no bell schedule, a wrong time
 * zone, a section that meets only on some cycle days with today's letter unset,
 * two candidate sections in one period, no teacher on the section, no wall tag
 * for the room — and each carries its own code and a sentence written for a
 * fourteen-year-old. The screen prints that sentence and disables the request.
 * It never falls back to a picker, never guesses a room, and never lets the
 * student send it anyway. A pass routed to the wrong teacher is worse than no
 * pass, and the way round every one of these is the same and is named in the
 * message: a teacher opens the pass instead.
 *
 * CLICKSPARK IS USED EXACTLY ONCE IN THIS BUILD AND IT IS THIS BUTTON.
 * By the frequency table, a spark belongs on something rare: a student asks for
 * a pass a handful of times a week, there is a server round trip behind the tap,
 * and being let out of class is a small good moment. Every other button in the
 * app gets the 160ms press scale and nothing else. The canvas is mounted only
 * while a request can actually be sent, and the loop is off unless a spark is
 * alive (see the change note in ClickSpark.tsx), so it costs nothing anywhere
 * else — including on every one of the refusals above, where the button is
 * rendered disabled and no spark is mounted at all.
 */

const REASON_CHIPS = ["Restroom", "Water", "Nurse", "Front office", "Locker"];

export default function HallPass() {
  const { mutate, refresh, demo, currentClass } = useSession();
  const { live, current } = useHallPassModel();

  /**
   * The pass this screen just opened, held until `passCard:mine` catches up.
   *
   * `refresh()` is a round trip, and in the second it takes, a student who has
   * just pressed the button is looking at the screen they pressed it on. The
   * mutation returns the same facts the card will — who it went to, which
   * class, which period, which room — so the waiting panel can be drawn from
   * its answer immediately and then replaced by the identical panel drawn from
   * the server's. `live` wins the moment it exists, so there is never a moment
   * where two disagree.
   */
  const [sent, setSent] = useState<LivePassModel | null>(null);
  const pass = live ?? sent;

  const clearSent = () => {
    setSent(null);
    refresh();
  };

  /* Drawn from the mutation's answer AND re-read from the server, in that
     order. The panel is on screen on the next frame, and the wallet card and
     the banner on /cards — which read passCard:mine, not this state — catch up
     a round trip later. Without the refresh a student who asked for a pass
     here would find "No pass open" printed on their card. */
  const holdSent = (opened: LivePassModel) => {
    setSent(opened);
    refresh();
  };

  return (
    <div className="wc-stagger space-y-5">
      <header>
        <PageTitle>Hall pass</PageTitle>
        <p className="mt-1.5 text-[13.5px] text-wp-dim">
          Ask your teacher for permission to leave the room.
        </p>
      </header>

      {pass ? (
        <OpenPass pass={pass} onChanged={clearSent} mutate={mutate} />
      ) : currentClass.state === "error" ? (
        /* Handled here rather than by <Loaded>, because THIS endpoint is the
           one most likely to be missing from the deployed backend. Probed
           against quick-cassowary-644 while building this: `me:get`,
           `passCard:mine` and `views_app:myStudentView` all answer with a real
           reason, while the student hall-pass functions answer exactly like a
           function that does not exist. So the likeliest cause of an error here
           is a backend that has not caught up, and a student is told that
           instead of being left to conclude the school has taken their hall
           passes away. The request id, when there is one, is the only thing the
           office can look up, so it is rendered as something copyable. */
        <Surface>
          <SectionLabel>Hall passes are not answering</SectionLabel>
          <p className="mt-3 text-[13.5px] leading-[1.55] text-wp-dim">
            The app could not find out which class you are in, so it has nothing
            to attach a request to and will not guess. Ask your teacher to start
            the pass for you.
          </p>
          <div className="mt-4">
            <Unavailable
              reason={currentClass.message}
              tone="warn"
              reference={currentClass.requestId ?? null}
            />
          </div>
        </Surface>
      ) : (
        <Loaded from={current} rows={3}>
          {(data) =>
            data.available ? (
              <RequestPass
                routing={data.routing}
                mutate={mutate}
                onSent={holdSent}
                demo={Boolean(demo)}
              />
            ) : (
              <NotRightNow model={data} />
            )
          }
        </Loaded>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------
   Where it is going / where it went
   ------------------------------------------------------------------ */

/**
 * The three facts under the teacher's name, as labelled rows.
 *
 * LABELLED, NOT A SENTENCE, because two of these can be missing and a missing
 * value has to read as missing. "Biology · Period 3 · Room 114" collapses to
 * "Period 3 · Room 114" when the section has no course name on it, and a line
 * that quietly gets shorter is a line that has told the student nothing about
 * what it left out. A row that says "Class — not named on your timetable" is
 * the same fact, out loud, and it is the one the office can act on.
 */
function Routing({ routing }: { routing: PassRouting }) {
  const rows: Array<{ label: string; value: string; known: boolean }> = [
    {
      label: "Class",
      value: routing.courseName ?? "Not named on your timetable",
      known: routing.courseName !== null,
    },
    {
      label: "Period",
      value: routing.period ?? "Not known",
      known: routing.period !== null,
    },
    {
      label: "Room",
      value: routing.room ?? "No tag registered for this room",
      known: routing.room !== null,
    },
  ];

  return (
    <dl className="mt-4 space-y-2 text-[13.5px]">
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between gap-4">
          <dt className="text-wp-dim">{row.label}</dt>
          <dd
            className={`text-right ${
              row.known ? "font-bold text-wp-fg" : "text-wp-dim italic"
            }`}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * "Sending to Ms Vega", and what to say when the section has no name on it.
 *
 * NEVER A MADE-UP NAME AND NEVER A BLANK. `teacherLabel` on the server returns
 * "" for a roster row with no first or last name, which arrives here as null.
 * The period is still known and the routing is still correct — the request goes
 * to that section's teacher either way — so the honest headline names the
 * period instead of inventing a person.
 */
function teacherPhrase(routing: PassRouting): string {
  if (routing.teacherName) return routing.teacherName;
  if (routing.period) return `your period ${routing.period} teacher`;
  return "your teacher";
}

/* ------------------------------------------------------------------
   Open pass
   ------------------------------------------------------------------ */

/**
 * A pass that exists: waiting on a teacher, approved and walking, or overdue.
 *
 * ONE PANEL FOR ALL OF THEM, including the one this screen has just opened.
 * The alternative — a "request sent" confirmation with its own layout — is a
 * second place to keep the cancel button, and cancel is the control that stops
 * an unanswered request blocking every future pass. It has been missing from
 * one of the two before.
 *
 * THE HERO IS THE TEACHER WHILE WAITING AND THE CLOCK ONCE APPROVED. A pass
 * that has not been approved has no elapsed time — the server sends null,
 * because a request sitting in a queue is not time out of class — and a hero
 * figure reading "—" is a number-shaped hole where the useful fact is "who has
 * this now".
 */
function OpenPass({
  pass,
  onChanged,
  mutate,
}: {
  pass: LivePassModel;
  onChanged: () => void;
  mutate: (path: string, args: Record<string, unknown>) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);

  /* The minutes are the one number on this screen that genuinely changes while
     you watch, so they are the one that should move when they do — and should
     sit still when a re-render arrives carrying the same figure. */
  const reduced = useReducedMotion();
  const ticking = useArrival("pass.elapsed", pass.elapsed);

  const cancel = async () => {
    if (!pass.id) return;
    setBusy(true);
    setError(null);
    try {
      await mutate("hallPasses:cancelMine", { passId: pass.id });
      onChanged();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  };

  const teacher = teacherPhrase(pass.routing);
  const room = pass.routing.room;

  return (
    <>
      <StarBorder
        as="div"
        className="block w-full"
        color={pass.overdue ? "#D9742F" : "#B5D4F4"}
        speed="7s"
        innerClassName={`relative z-1 rounded-[19px] border p-6 ${
          pass.overdue
            ? "border-wc-orange/50 bg-[#2A1A10]"
            : "border-wc-blue/50 bg-[#0E1B2C]"
        }`}
      >
        <div className="text-left">
          <p className="text-[11px] font-bold tracking-[0.09em] text-wc-blue-pale uppercase">
            {pass.overdue
              ? "Overdue"
              : pass.waiting
                ? "Waiting for approval"
                : `Pass ${pass.state}`}
          </p>

          {pass.waiting ? (
            <p className="mt-2 text-[24px] leading-[1.15] font-bold text-wp-fg">
              With {teacher}
            </p>
          ) : (
            <p
              /* Keyed on the figure so the entrance actually RESTARTS when the
                 minute ticks over — a CSS animation only replays on a new
                 element, and re-adding a class React never removed does nothing.
                 `ticking` then decides whether the class is there at all, so
                 coming back to this screen with the same number on it is silent. */
              key={`elapsed-${pass.elapsed}`}
              className={`mt-2 text-[34px] leading-none font-bold tabular-nums text-wp-fg ${
                ticking && !reduced ? "wc-enter" : ""
              }`}
            >
              {pass.elapsed === null ? "—" : pass.elapsed}
              <span className="ml-2 text-[15px] font-normal text-wp-dim">
                {pass.elapsed === null
                  ? "minutes not reported"
                  : `min out${pass.limit !== null ? ` of ${pass.limit}` : ""}`}
              </span>
            </p>
          )}

          {/* Who it went to and from where, on the pass rather than re-derived
              from the timetable — the class a student is in changes every hour
              and this has to keep naming the teacher who was actually asked. */}
          <Routing routing={pass.routing} />

          <p className="mt-4 border-t border-white/10 pt-4 text-[13.5px] leading-[1.5] text-wp-dim">
            {pass.waiting
              ? `${capitalise(teacher)} can see this on their screen now. It stays a request until they approve it.`
              : pass.sentTo
                ? /* A pass a TEACHER opened names where the student was sent,
                     and applyTap refuses every other tag until that one has been
                     reached. "Tap the tag" would be unactionable; the tag has a
                     name and it is printed. */
                  `Go to ${pass.sentTo} and tap the tag there first — the pass does not start until you do. Then tap the tag ${room ? `in ${room}` : "in the classroom you left"} when you get back.`
                : `Tap the tag where you are going, then tap the tag ${room ? `in ${room}` : "in the classroom you left"} when you get back.`}
          </p>

          {pass.openedByTeacher && (
            <p className="mt-2 text-[12.5px] leading-[1.5] text-wc-blue-pale">
              {teacher} opened this pass for you, so there is nothing to
              approve.
            </p>
          )}
        </div>
      </StarBorder>

      {/* The server allows a cancel only while the pass is still `requested`.
          Once a teacher has approved it the way back is a tap on the tag in the
          room you left, and offering a button that will be refused is worse than
          offering nothing.

          IT IS NOT A HIDDEN CONTROL AND MUST NOT BECOME ONE. `hasLivePass`
          counts a request as live, so a request nobody answers blocks this
          student from every future pass until it is cancelled. */}
      {pass.cancellable && (
        <Surface>
          <SectionLabel>Changed your mind?</SectionLabel>
          <p className="mt-2 text-[13.5px] leading-[1.5] text-wp-dim">
            Cancelling now costs you nothing. A request nobody answers would
            otherwise block every later pass, so this is the way out of it.
          </p>
          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            className="wc-press wc-hover-raise mt-4 rounded-full border border-[var(--wp-hair)] bg-white/[0.04] px-5 py-2.5 text-[13.5px] font-bold text-wp-fg disabled:opacity-50"
          >
            {busy ? "Cancelling…" : "Cancel my request"}
          </button>
          {error && (
            <div className="mt-3">
              <Unavailable
                reason={error.message}
                tone="warn"
                reference={error.requestId}
              />
            </div>
          )}
        </Surface>
      )}
    </>
  );
}

/* ------------------------------------------------------------------
   Request
   ------------------------------------------------------------------ */

function RequestPass({
  routing,
  mutate,
  onSent,
  demo,
}: {
  routing: PassRouting;
  mutate: (path: string, args: Record<string, unknown>) => Promise<unknown>;
  onSent: (pass: LivePassModel) => void;
  demo: boolean;
}) {
  const reduced = useReducedMotion();

  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      /* NO ORIGIN ARGUMENT. The server works out which class this student is
         sitting in, from the bell schedule and their own timetable, inside the
         mutation. There is nothing to send but the optional reason, and there
         is deliberately nothing this screen could send that would change where
         the request lands. */
      const result = (await mutate("hallPasses:requestMine", {
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      })) as Record<string, unknown>;

      onSent({
        id: str(result.id),
        state: "requested",
        overdue: false,
        // Null, never 0. The pass has not been approved, so no time has been
        // spent out of class, and 0 would read as a timer that has started.
        elapsed: null,
        limit: null,
        cancellable: str(result.id) !== null,
        waiting: true,
        routing: {
          // The SERVER's answer, not the one this screen was rendering. They
          // are the same fact a second apart, and if the period turned over
          // between the render and the tap, the pass belongs to whoever the
          // mutation actually routed it to.
          teacherName: str(result.teacherName),
          courseName: str(result.courseName),
          period: str(result.period),
          room: str(result.origin),
        },
        sentTo: null,
        openedByTeacher: false,
      });
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* THE REASSURANCE PANEL. It is the answer to the only question the
          deleted picker was ever asked to answer — "does this thing know where
          I am?" — and it is on screen before the button is pressed, not after.
          Same blue as the open-pass card so the two read as one object at two
          moments, but static: StarBorder is the only continuously animating
          element in the signed-in app and it belongs to a pass that exists. */}
      <div className="rounded-[17px] border border-wc-blue/50 bg-[#0E1B2C] p-5 sm:p-6">
        <p className="text-[11px] font-bold tracking-[0.09em] text-wc-blue-pale uppercase">
          Sending to
        </p>
        <p className="mt-2 text-[24px] leading-[1.15] font-bold text-wp-fg">
          {teacherPhrase(routing)}
        </p>
        <Routing routing={routing} />
        <p className="mt-4 border-t border-white/10 pt-4 text-[12.5px] leading-[1.55] text-wp-dim">
          This is the class your timetable says you are in right now, worked out
          from the bell schedule. You cannot send it somewhere else — it has to
          reach the teacher who can see you.
        </p>
      </div>

      <Surface>
        <SectionLabel>Why? (optional)</SectionLabel>
        <p className="mt-2 text-[13px] leading-[1.5] text-wp-dim">
          Your teacher sees this. You can leave it blank.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {REASON_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => setReason(reason === chip ? "" : chip)}
              aria-pressed={reason === chip}
              className={`wc-press wc-hover-raise rounded-full border px-3.5 py-1.5 text-[12.5px] font-bold ${
                reason === chip
                  ? "border-wc-blue-pale/60 bg-wc-blue-pale/15 text-wc-blue-pale"
                  : "border-[var(--wp-hair)] bg-white/[0.03] text-wp-dim"
              }`}
            >
              {chip}
            </button>
          ))}
        </div>
        <label className="mt-4 block">
          <span className="sr-only">Reason</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 120))}
            placeholder="Or type it"
            className="wc-field w-full rounded-[12px] border border-[var(--wp-hair)] bg-white/[0.03] px-4 py-3 text-[14px] text-wp-fg placeholder:text-wp-dim/70"
          />
        </label>

        {demo && (
          <p className="mt-4 text-[12px] leading-[1.5] text-wc-yellow">
            Sample mode: this button will refuse, because there is no signed-in
            student to open a pass for.
          </p>
        )}

        <div className="mt-5">
          <ClickSpark
            sparkColor="#E6E280"
            sparkCount={10}
            sparkRadius={22}
            sparkSize={9}
            duration={420}
            easing="ease-out"
            disabled={reduced}
          >
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="wc-press wc-hover-next w-full rounded-full bg-wc-blue px-5 py-3.5 text-[15px] font-bold text-white disabled:opacity-40"
            >
              {busy ? "Sending…" : "Ask my teacher"}
            </button>
          </ClickSpark>
        </div>

        {error && (
          <div className="mt-4">
            <Unavailable
              reason={error.message}
              tone="warn"
              reference={error.requestId}
            />
          </div>
        )}
      </Surface>
    </>
  );
}

/* ------------------------------------------------------------------
   No class to send it to
   ------------------------------------------------------------------ */

/**
 * The way round every refusal on this screen, and the only one there is.
 *
 * `openForStudent` reads no bell schedule and no timetable: the teacher is
 * standing there, they pick the child and the destination, and their own
 * classroom tag is the origin. So it is a real answer to a broken time zone and
 * to an unset cycle day alike — which is why every server sentence that can
 * name it already does, and why this line is suppressed when the sentence has.
 */
const ASK_TEACHER =
  "A teacher can open a pass for you from their own screen. It works the same " +
  "way — you tap the tag where you are going, and tap back in when you return.";

/** For the states where there is no teacher to ask, because nobody is here. */
const COME_BACK =
  "Nothing is wrong with your account, and nothing here needs fixing. Ask " +
  "again during a lesson.";

type Note = { title: string; then?: string };

/**
 * A HEADING PER CODE, and nothing else per code.
 *
 * The sentence under it is always the server's own — printed verbatim, never
 * paraphrased, because it is the one that names the period, the schedule, the
 * clock time or the setting an admin has to change. This map only supplies the
 * three or four words a student reads first, and the one line about what to do
 * when the server's sentence does not already say it.
 *
 * AN UNKNOWN CODE STILL RENDERS. A code added to the server tomorrow falls to
 * the default heading and prints its reason, which is the entire contract of
 * this screen. Nothing here decides whether the request is allowed; the server
 * already did, and `available: false` is the whole of it.
 */
const NOTES: Record<string, Note> = {
  // The app has not been set up, or has been set up wrongly. A student can do
  // nothing about any of these, and must not be left thinking otherwise.
  "not-configured": { title: "Hall passes are not set up yet", then: ASK_TEACHER },
  "no-timezone": {
    title: "The app does not know what time it is here",
    then: ASK_TEACHER,
  },
  "bad-timezone": {
    title: "The school's time zone is wrong",
    then: ASK_TEACHER,
  },
  "unreadable-clock": {
    title: "The server could not read the clock",
    then: ASK_TEACHER,
  },
  "missing-schedule": {
    title: "Today's bell schedule is missing",
    then: ASK_TEACHER,
  },
  "no-schedule-today": {
    title: "No bell schedule for today",
    then: ASK_TEACHER,
  },
  "no-schedule": { title: "No bell schedule is set up", then: ASK_TEACHER },

  // Real states of the calendar and the clock. Normal, not faults.
  "no-school-today": { title: "No classes today", then: COME_BACK },
  "day-not-covered": { title: "Not a school day", then: COME_BACK },
  "before-school": { title: "School has not started yet", then: COME_BACK },
  "after-school": { title: "School is over for today", then: COME_BACK },
  "between-periods": { title: "You are between periods" },

  // This student's own record.
  "no-student-email": {
    title: "Your record has no school email on it",
    then: ASK_TEACHER,
  },
  "no-timetable": { title: "There is no timetable on your account" },

  // The timetable, at this period.
  "no-period": { title: "No period could be worked out", then: ASK_TEACHER },
  "no-class-this-period": { title: "No class on your timetable right now" },
  "unknown-cycle-day": { title: "Today's cycle day has not been set" },
  "ambiguous-section": { title: "Two classes at once on your timetable" },
  "no-teacher-for-section": { title: "No teacher on this class" },

  // The wall tag the pass would have to be closed at.
  "ambiguous-classroom-tag": {
    title: "Two wall tags for this room",
    then: ASK_TEACHER,
  },
  "no-classroom-tag": { title: "This room has no wall tag yet" },
};

const DEFAULT_NOTE: Note = {
  title: "You cannot ask for a pass right now",
  then: ASK_TEACHER,
};

function NotRightNow({
  model,
}: {
  model: Extract<CurrentClassModel, { available: false }>;
}) {
  const note = NOTES[model.code] ?? DEFAULT_NOTE;

  /* Suppressed when the server has already said it. Most of these sentences end
     with "Ask a teacher to start the pass for you", and printing the same
     instruction twice in four lines is how a student learns to skip the box. */
  const then =
    note.then && /ask (a|your) teacher/i.test(model.reason ?? "")
      ? null
      : (note.then ?? null);

  return (
    <Surface>
      <SectionLabel>{note.title}</SectionLabel>

      {/* The server's own words. Never paraphrased, never summarised: this is
          the sentence that names the period, the time or the setting, and it is
          written for a student to repeat to an adult. */}
      <div className="mt-3">
        <Unavailable reason={model.reason} />
      </div>

      {then && (
        <p className="mt-3 text-[13px] leading-[1.55] text-wp-dim">{then}</p>
      )}

      {/* DISABLED, NOT ABSENT. A screen with no button on it looks like a
          feature that has been taken away; a button that is plainly off says
          "this exists, and not right now", which is the true thing. It is
          `disabled` rather than merely styled, so a keyboard cannot reach it
          and no spark canvas is mounted behind it. */}
      <button
        type="button"
        disabled
        className="mt-5 w-full cursor-not-allowed rounded-full bg-wc-blue px-5 py-3.5 text-[15px] font-bold text-white opacity-40"
      >
        Ask my teacher
      </button>
    </Surface>
  );
}

/* ------------------------------------------------------------------
   Failures from a mutation
   ------------------------------------------------------------------ */

/**
 * A refusal, and the reference when the server refused to say why.
 *
 * `requestMine` throws real sentences a student can act on — "You already have
 * a hall pass open", "You have already had 6 hall passes today" — and those are
 * printed verbatim. A redacted throw carries no sentence at all, and then the
 * request id is the only thing anyone can look up.
 */
type Failure = { message: string; requestId: string | null };

function failure(err: unknown): Failure {
  return { message: errorText(err), requestId: errorRef(err) };
}

/** "your period 3 teacher" -> "Your period 3 teacher". Never touches a name. */
function capitalise(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
