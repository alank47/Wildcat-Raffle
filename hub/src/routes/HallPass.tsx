import { useState } from "react";
import Stepper, { Step } from "@/components/Stepper";
import ClickSpark from "@/components/ClickSpark";
import StarBorder from "@/components/StarBorder";
import { useSession } from "@/lib/session";
import { useArrival } from "@/lib/arrive";
import { useReducedMotion } from "@/lib/motion";
import { errorText } from "@/lib/convex";
import { str } from "@/lib/shapes";
import {
  useHallPassModel,
  type LivePassModel,
  type RequestModel,
} from "@/lib/viewmodel";
import {
  Loaded,
  PageTitle,
  SectionLabel,
  Surface,
  Unavailable,
  friendlyTime,
} from "@/ui/primitives";

/**
 * Asking to leave the room.
 *
 * `Stepper` is the right component here for a reason that is not visual: a hall
 * pass request has three decisions in it (where you are, why, and are you sure),
 * the second one is optional, and the third is a mutation that a teacher then
 * sees. Putting all three on one screen is how a student sends a request with
 * the wrong room attached, and the room is the thing the whole tap-back-in flow
 * depends on.
 *
 * CLICKSPARK IS USED EXACTLY ONCE IN THIS BUILD AND IT IS THIS BUTTON.
 * By the frequency table, a spark belongs on something rare: a student asks for
 * a pass a handful of times a week, there is a server round trip behind the tap,
 * and being let out of class is a small good moment. Every other button in the
 * app gets the 160ms press scale and nothing else. The canvas is mounted only on
 * the confirm step and the loop is off unless a spark is alive (see the change
 * note in ClickSpark.tsx), so it costs nothing on the other screens.
 *
 * THE STEPPER ITSELF NEEDED THREE FIXES before it could be trusted with this,
 * all marked in Stepper.tsx: its slide direction was inverted so "Next" moved
 * the form backwards, its content box opened from height 0 on every visit, and
 * its progress connector animated `width`. See the notes there.
 */

const REASON_CHIPS = ["Restroom", "Water", "Nurse", "Front office", "Locker"];

export default function HallPass() {
  const { mutate, refresh, demo, tapLocations } = useSession();
  const { live, request } = useHallPassModel();

  return (
    <div className="wc-stagger space-y-5">
      <header>
        <PageTitle>Hall pass</PageTitle>
        <p className="mt-1.5 text-[13.5px] text-wp-dim">
          Ask your teacher for permission to leave the room.
        </p>
      </header>

      {live ? (
        <LivePass pass={live} onChanged={refresh} mutate={mutate} />
      ) : tapLocations.state === "error" ? (
        /* Handled here rather than by <Loaded>, because THIS endpoint is the one
           that is missing from the deployed backend. Probed against
           quick-cassowary-644 while building this: `me:get`, `passCard:mine` and
           `views_app:myStudentView` all answer with a real reason, while
           `tapLocations:listForStudents` and `hallPasses:requestMine` answer
           exactly like a function that does not exist. So the likeliest cause of
           an error here is a backend that has not caught up, and a student is
           told that instead of being left to conclude the school has taken their
           hall passes away. */
        <Surface>
          <SectionLabel>Hall passes are not available here yet</SectionLabel>
          <p className="mt-3 text-[13.5px] leading-[1.55] text-wp-dim">
            The list of rooms could not be loaded, so there is nothing to attach
            a request to. Ask your teacher to start the pass for you.
          </p>
          <div className="mt-4">
            <Unavailable reason={tapLocations.message} />
          </div>
        </Surface>
      ) : (
        <Loaded from={request} rows={3}>
          {(data) => (
            <RequestFlow
              model={data}
              mutate={mutate}
              onSent={refresh}
              demo={Boolean(demo)}
            />
          )}
        </Loaded>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------
   Open pass
   ------------------------------------------------------------------ */

function LivePass({
  pass,
  onChanged,
  mutate,
}: {
  pass: LivePassModel;
  onChanged: () => void;
  mutate: (path: string, args: Record<string, unknown>) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

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
            {pass.overdue ? "Overdue" : `Pass ${pass.state}`}
          </p>
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
          <p className="mt-3 text-[13.5px] leading-[1.5] text-wp-dim">
            {pass.waiting
              ? "Waiting for your teacher to approve it."
              : "Tap the tag in the room you left to close this pass."}
          </p>
        </div>
      </StarBorder>

      {/* The server allows a cancel only while the pass is still `requested`.
          Once a teacher has approved it the way back is a tap on the tag in the
          room you left, and offering a button that will be refused is worse than
          offering nothing. */}
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
              <Unavailable reason={error} tone="warn" />
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

function RequestFlow({
  model,
  mutate,
  onSent,
  demo,
}: {
  model: RequestModel;
  mutate: (path: string, args: Record<string, unknown>) => Promise<unknown>;
  onSent: () => void;
  demo: boolean;
}) {
  const reduced = useReducedMotion();

  const [step, setStep] = useState(1);
  const [slug, setSlug] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<string, unknown> | null>(null);

  const chosen = model.locations.find((l) => l.slug === slug);

  const submit = async () => {
    if (!slug) return;
    setBusy(true);
    setError(null);
    try {
      const result = (await mutate("hallPasses:requestMine", {
        originSlug: slug,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      })) as Record<string, unknown>;
      setSent(result);
      onSent();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <Surface>
        <SectionLabel>Request sent</SectionLabel>
        <p className="mt-3 text-[19px] font-bold text-wp-fg">
          Your teacher has it.
        </p>
        <p className="mt-2 text-[13.5px] leading-[1.5] text-wp-dim">
          Asked from {str(sent.origin) ?? "your room"}
          {str(sent.requestedAt)
            ? ` at ${friendlyTime(str(sent.requestedAt)!)}`
            : ""}
          . It stays as a request until they approve it.
        </p>
      </Surface>
    );
  }

  if (model.locations.length === 0) {
    return (
      <Surface>
        <SectionLabel>Nowhere to ask from</SectionLabel>
        <div className="mt-3">
          <Unavailable
            reason={
              "No tap locations are set up for students on this deployment yet, " +
              "so there is no room to attach a request to. Ask your teacher to " +
              "start the pass instead."
            }
          />
        </div>
        {model.scheduleNote && (
          <p className="mt-3 text-[11.5px] leading-[1.5] text-wp-dim/85">
            {model.scheduleNote}
          </p>
        )}
      </Surface>
    );
  }

  const isLast = step === 3;

  return (
    <Surface padded={false} className="overflow-visible">
      <Stepper
        initialStep={1}
        onStepChange={setStep}
        backButtonText="Back"
        nextButtonText="Next"
        disableStepIndicators={false}
        /* Stepper ships a white card with a green button. Every one of those
           surfaces is replaced here; nothing of React Bits' palette survives. */
        stepCircleContainerClassName="!rounded-[17px] !shadow-none !border-0 w-full max-w-none bg-transparent"
        stepContainerClassName="!px-5 !pt-5 !pb-0 sm:!px-6"
        /* Deliberately NOT padding: the wrapper this styles cannot pad an
           absolutely positioned step. The gutter is set on each <Step>. */
        contentClassName=""
        footerClassName="!px-5 !pb-5 sm:!px-6"
        className="!p-0 !aspect-auto sm:!aspect-auto md:!aspect-auto"
        backButtonProps={{
          className:
            "wc-press wc-hover-raise rounded-full border border-transparent px-4 py-2 text-[13.5px] font-bold text-wp-dim",
        }}
        nextButtonProps={{
          className: isLast
            ? "hidden"
            : "wc-press wc-hover-next rounded-full bg-wc-blue px-5 py-2.5 text-[13.5px] font-bold text-white disabled:opacity-40",
          disabled: step === 1 && !slug,
        }}
        renderStepIndicator={({ step: n, currentStep }) => (
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-full text-[13px] font-bold tabular-nums transition-colors duration-[200ms] ${
              n === currentStep
                ? "bg-wc-blue text-white"
                : n < currentStep
                  ? "bg-wc-blue/25 text-wc-blue-pale"
                  : "border border-[var(--wp-hair)] text-wp-dim"
            }`}
            aria-current={n === currentStep ? "step" : undefined}
          >
            {n}
          </div>
        )}
      >
        <Step className="px-5 sm:px-6">
          <h2 className="text-[17px] font-bold text-wp-fg">
            Where are you right now?
          </h2>
          <p className="mt-1.5 text-[13px] leading-[1.5] text-wp-dim">
            This is the room you are leaving, not where you are going.
          </p>
          {/* The rooms are the one grid in the app that stagger in: this is the
              first thing a student has to read on the screen, there are five to
              nine of them, and 45ms apart makes it a list to scan rather than a
              wall that appeared. */}
          <div className="wc-stagger mt-4 grid gap-2 sm:grid-cols-2">
            {model.locations.map((loc) => {
              const active = loc.slug !== null && loc.slug === slug;
              return (
                <button
                  key={loc.slug ?? loc.name}
                  type="button"
                  onClick={() => setSlug(loc.slug)}
                  aria-pressed={active}
                  className={`wc-press wc-hover-raise rounded-[12px] border px-4 py-3 text-left text-[14px] font-bold ${
                    active
                      ? "border-wc-blue-pale/60 bg-wc-blue-pale/15 text-wc-blue-pale"
                      : "border-[var(--wp-hair)] bg-white/[0.03] text-wp-fg"
                  }`}
                >
                  {loc.name}
                  <span className="mt-0.5 block text-[11.5px] font-normal text-wp-dim capitalize">
                    {loc.kind}
                  </span>
                </button>
              );
            })}
          </div>
          {model.scheduleNote && (
            <p className="mt-4 text-[11.5px] leading-[1.5] text-wp-dim/85">
              {model.scheduleNote}
            </p>
          )}
          {model.truncated && (
            <p className="mt-2 text-[11.5px] leading-[1.5] text-wc-orange">
              This list was cut short by the server, so a room you are looking
              for may be missing.
            </p>
          )}
        </Step>

        <Step className="px-5 sm:px-6">
          <h2 className="text-[17px] font-bold text-wp-fg">Why? (optional)</h2>
          <p className="mt-1.5 text-[13px] leading-[1.5] text-wp-dim">
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
        </Step>

        <Step className="px-5 sm:px-6">
          <h2 className="text-[17px] font-bold text-wp-fg">Send it?</h2>
          <dl className="mt-4 space-y-2 text-[14px]">
            <div className="flex justify-between gap-4">
              <dt className="text-wp-dim">Leaving from</dt>
              <dd className="text-right font-bold text-wp-fg">
                {chosen?.name ?? "Not chosen"}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-wp-dim">Reason</dt>
              <dd className="text-right font-bold text-wp-fg">
                {reason.trim() || "Not given"}
              </dd>
            </div>
          </dl>

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
                disabled={busy || !slug}
                className="wc-press wc-hover-next w-full rounded-full bg-wc-blue px-5 py-3.5 text-[15px] font-bold text-white disabled:opacity-40"
              >
                {busy ? "Sending…" : "Ask my teacher"}
              </button>
            </ClickSpark>
          </div>

          {error && (
            <div className="mt-4">
              <Unavailable reason={error} tone="warn" />
            </div>
          )}
        </Step>
      </Stepper>
    </Surface>
  );
}
