import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SplitText from "@/components/SplitText";
import ShinyText from "@/components/ShinyText";
import {
  clampButtonWidth,
  googleSignOut,
  mountGoogleButton,
  HOSTED_DOMAIN,
} from "@/lib/google";
import {
  useSession,
  type AuthProblem,
  type AuthProblemKind,
} from "@/lib/session";
import { useReducedMotion } from "@/lib/motion";
import { WILDCAT_MARK } from "@/ui/mark";

/**
 * THE WAY IN.
 *
 * One school, one kind of account, one button.
 *
 * STUDENTS ARE GOOGLE. Westbrook Academy students are Google accounts on
 * westbrookacademy.org; staff are Entra accounts on lapromisefund.org, and that
 * is an authorization boundary, not a preference. So this file loads no
 * Microsoft SDK, renders no Microsoft button, shows no Microsoft branding, and
 * offers no "sign in another way" that ends up there. Staff get one line of
 * grey text pointing at the main app, which owns its own sign-in; nothing on
 * this screen initiates it. Every path back here — a refusal, an expired
 * session, a deliberate sign-out — lands on THIS screen, whose one button is
 * Google's.
 *
 * NO PASSWORD FIELD. Not a real one and not a decorative one. There are no
 * passwords in this model: every account comes from PowerSchool or the staff
 * directory. A box that looks like it takes a password on a school sign-in page
 * teaches a fourteen-year-old that typing their password into an unfamiliar
 * form is normal, and that lesson gets used against them later.
 *
 * THE BUTTON IS AN IFRAME. Google renders it and it cannot be restyled from
 * out here, so nothing tries: the design is built around a fixed-size object
 * with somebody else's blue in it, and the only thing this file controls is how
 * wide to ask for. A repainted sign-in button is what a phishing page has;
 * students are entitled to see the button they were taught to look for.
 */

/* ------------------------------------------------------------------
   Ground
   ------------------------------------------------------------------ */

/**
 * The wildcat chevron, enormous and nearly invisible, bled off the top-right.
 *
 * This is the answer to "should there be a background component". All 53 React
 * Bits backgrounds — including the four that pull no dependency at all — are a
 * <canvas> driven by a requestAnimationFrame loop that never stops. On the one
 * screen that loads before anything else on a school Chromebook, ahead of the
 * network round trip to accounts.google.com, that is a permanent frame loop
 * competing with the only thing the student came here to do. This is one
 * static path. It costs nothing to draw, nothing to keep, and it is the
 * school's own mark rather than a shader.
 */
function Watermark() {
  return (
    <svg
      className="pointer-events-none fixed -top-[16vmin] -right-[20vmin] h-[84vmin] w-[84vmin] text-wc-blue opacity-[0.07]"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M13 20 L22 46 L32 29 L42 46 L51 20"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------
   Failure
   ------------------------------------------------------------------ */

/**
 * One heading and one instruction per way this can fail.
 *
 * The rule for every line below: name the thing that went wrong in words a
 * fourteen-year-old can repeat to an adult, and say who fixes it. "Something
 * went wrong" and "Error: 401" both fail that test. Where the server wrote its
 * own sentence it is printed verbatim underneath rather than paraphrased,
 * because the server's sentence is the one that names the missing field.
 */
const COPY: Record<AuthProblemKind, { title: string; fix: string }> = {
  auth: {
    title: "Your sign-in ran out",
    fix: "This is normal — it happens when the Chromebook has been shut for a while. Nothing is wrong with your account. Press the Google button again.",
  },
  "not-student": {
    title: "That is not a student account",
    fix: "Wildcat Hub only opens for student accounts. On a shared Chromebook this usually means somebody else is still signed in.",
  },
  function: {
    title: "The school server would not let that account in",
    fix: "Nothing you can do on this Chromebook will change this. Show this screen to the front office — the line above tells them exactly what is missing from your record.",
  },
  redacted: {
    title: "The server would not say what went wrong",
    fix: "This is not your fault, and it does not mean your record is empty. Take this reference to the front office — it is the only way anyone can look up what happened.",
  },
  transport: {
    title: "Cannot reach the school server",
    fix: "Check that you are on the school Wi-Fi and try again. If the whole page is slow, this will clear on its own.",
  },
  google: {
    title: "Google sign-in did not load",
    fix: "The page could not reach Google. That is the network, not you or your account.",
  },
};

/** Convex's request id, big enough to copy onto a piece of paper. */
function Reference({ id }: { id: string }) {
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
 * copy button. Left alone that is the same instruction three times in six
 * lines. The chip is the better carrier — it can be copied — so the sentence
 * comes off the end of the prose whenever the chip is going to appear. When
 * there is NO id, the sentence is the only thing standing and it stays.
 */
function trimReferenceSentence(message: string, hasChip: boolean): string {
  if (!hasChip) return message;
  return message
    .replace(/\s*Show the office this reference:[^.]*\.\s*$/i, "")
    .trim();
}

function ProblemNote({
  problem,
  canRetry,
  onRetry,
  onDifferentAccount,
}: {
  problem: AuthProblem;
  canRetry: boolean;
  onRetry: () => void;
  onDifferentAccount: () => void;
}) {
  const { title, fix } = COPY[problem.kind];
  const showChip = problem.kind === "redacted" && Boolean(problem.requestId);
  const retryable =
    canRetry &&
    (problem.kind === "transport" ||
      problem.kind === "redacted" ||
      problem.kind === "function");

  return (
    <div
      /* role=alert, because this appears after the student has already
         committed to an action and looked away from the button. */
      role="alert"
      className="mt-5 rounded-[12px] border border-wc-orange/40 bg-wc-orange/10 px-4 py-3.5"
    >
      <p className="text-[13.5px] font-bold text-[#F3C9A6]">{title}</p>

      {/* The server's own words, when it wrote any. Never paraphrased: this is
          the sentence that names the field the office has to fill in. */}
      <p className="mt-1.5 text-[13.5px] leading-[1.5] text-[#F3C9A6]/90">
        {problem.who ? `${problem.who} — ` : ""}
        {trimReferenceSentence(problem.message, showChip)}
      </p>

      <p className="mt-2.5 text-[13px] leading-[1.55] text-wp-dim">{fix}</p>

      {showChip && problem.requestId && <Reference id={problem.requestId} />}

      {(retryable || problem.kind === "not-student") && (
        <div className="mt-3.5 flex flex-wrap gap-2">
          {retryable && (
            <button
              type="button"
              onClick={onRetry}
              className="wc-press wc-hover-raise rounded-full border border-[var(--wp-hair-strong)] bg-white/[0.06] px-4 py-2 text-[12.5px] font-bold text-wp-fg"
            >
              Try again
            </button>
          )}
          {problem.kind === "not-student" && (
            <button
              type="button"
              onClick={onDifferentAccount}
              className="wc-press wc-hover-raise rounded-full border border-[var(--wp-hair-strong)] bg-white/[0.06] px-4 py-2 text-[12.5px] font-bold text-wp-fg"
            >
              Use a different account
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The failure this screen can never detect.
 *
 * If a student's Google account is not in a grade OU, Google refuses inside its
 * own window and this app is never told — no callback, no error, nothing to
 * render. It is also the single most common way a real student is locked out on
 * day one. So the explanation cannot wait for an error state: it has to be
 * sitting on the screen already, folded away, for the student who is stuck and
 * has nothing to show for it.
 *
 * A native <details>. No JavaScript, no animation, keyboard-operable, and it
 * opens instantly on the tap of a student who is already frustrated.
 */
function Help() {
  return (
    <details className="mt-4 rounded-[12px] border border-[var(--wp-hair)] bg-white/[0.02] px-4 py-3">
      <summary className="cursor-pointer list-none text-[13px] font-bold text-wp-fg marker:hidden">
        It will not let me in
        <span
          className="wc-disclosure float-right text-[15px] leading-none text-wp-dim"
          aria-hidden="true"
        />
      </summary>

      <div className="mt-3 space-y-3.5 text-[12.5px] leading-[1.6] text-wp-dim">
        <p>
          <strong className="font-bold text-wp-fg">
            Google says your account can’t be used, and this page never changes.
          </strong>{" "}
          Your account has not been put in your grade’s group yet. Only the
          office can do that. Tell them your full name and grade — there is
          nothing to fix on the Chromebook.
        </p>
        <p>
          <strong className="font-bold text-wp-fg">
            It signs you in, then says there is no record for you.
          </strong>{" "}
          The school system does not have this email address on your student
          record. The office can add it, and you are usually back in the same
          day.
        </p>
        <p>
          <strong className="font-bold text-wp-fg">
            You get a reference code.
          </strong>{" "}
          Copy it exactly, or write it on paper, and take it to the office. That
          code is how they find out what happened.
        </p>
        <p className="border-t border-[var(--wp-hair)] pt-3">
          Wildcat Hub never asks you for a password. Google is the only thing
          that should ever ask you for yours — if any other page asks, close it
          and tell a teacher.
        </p>
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------
   The screen
   ------------------------------------------------------------------ */

/** Screenshot / demonstration states. See the note by `probe` below. */
const PROBES: Record<string, AuthProblem> = {
  function: {
    kind: "function",
    message:
      "Your student number is not on your account yet, so we cannot find your record. Ask the front office to check PowerSchool.",
    requestId: null,
  },
  redacted: {
    kind: "redacted",
    message:
      "The school server could not answer this, and the reason was hidden before it reached your screen. Nothing here means your record is empty. Show the office this reference: 4f1c9a2be7d0.",
    requestId: "4f1c9a2be7d0",
  },
  auth: {
    kind: "auth",
    message:
      "You were signed in, and the school server has stopped accepting that sign-in.",
    requestId: null,
  },
  transport: {
    kind: "transport",
    message:
      "Could not reach the school server. Check the Wi-Fi and try again. (Failed to fetch)",
    requestId: null,
  },
  "not-student": {
    kind: "not-student",
    message: "That account signed in as staff.",
    requestId: null,
    who: "a.lopez@lapromisefund.org",
  },
  google: {
    kind: "google",
    message:
      "Google sign-in could not be loaded. If you are offline or the school network blocks accounts.google.com, this will not work.",
    requestId: null,
  },
};

export default function SignIn() {
  const { acceptCredential, authBusy, authError, canRetry, retrySignIn } =
    useSession();
  const slotRef = useRef<HTMLDivElement>(null);
  const [mountError, setMountError] = useState<string | null>(null);
  const [buttonWidth, setButtonWidth] = useState(0);
  const [remount, setRemount] = useState(0);
  const reduced = useReducedMotion();

  /**
   * `?probe=redacted` renders a failure state without one having happened.
   *
   * These states are rare, they are the ones nobody sees until a student is
   * already stuck at a desk, and they are exactly the ones worth reviewing. It
   * is display only: it cannot sign anyone in, cannot sign anyone out, and
   * touches no token. Same shape as the existing `?demo=` switch.
   */
  const probe = useMemo(() => {
    const value = new URLSearchParams(window.location.search).get("probe");
    return value && value in PROBES ? PROBES[value] : null;
  }, []);
  const probeBusy = useMemo(
    () => new URLSearchParams(window.location.search).get("probe") === "busy",
    [],
  );

  /**
   * Ask Google for a button the width of the space it is being given.
   *
   * `width` is the only dimension of that iframe this app can influence, and
   * Google ignores anything outside 200–400. Measured rather than hardcoded so
   * the button fills its card on a laptop and still fits a 320px phone.
   */
  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const measure = () => {
      const next = clampButtonWidth(el.clientWidth);
      // A dead band, or a ResizeObserver and a re-render chase each other by a
      // pixel for the rest of the page's life.
      setButtonWidth((prev) => (Math.abs(prev - next) >= 8 ? next : prev));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = slotRef.current;
    // Width 0 is "not measured yet". Mounting at a guessed width first would
    // render Google's button twice and visibly resize it under the pointer.
    if (!el || !buttonWidth) return;
    let cancelled = false;
    mountGoogleButton(
      el,
      (jwt) => {
        void acceptCredential(jwt);
      },
      buttonWidth,
    ).catch((err: unknown) => {
      if (!cancelled) {
        setMountError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [acceptCredential, buttonWidth, remount]);

  /** Shared Chromebook: drop Google's remembered choice and ask again. */
  const chooseDifferentAccount = useCallback(() => {
    googleSignOut();
    setRemount((n) => n + 1);
  }, []);

  const busy = authBusy || probeBusy;
  const problem: AuthProblem | null =
    probe ??
    authError ??
    (mountError
      ? { kind: "google", message: mountError, requestId: null }
      : null);

  return (
    <main className="wp-lift relative flex min-h-dvh flex-col justify-center px-5 py-10 sm:py-14">
      <Watermark />

      <div className="relative z-1 mx-auto grid w-full max-w-[400px] gap-9 lg:max-w-[880px] lg:grid-cols-[minmax(0,1fr)_minmax(0,384px)] lg:items-center lg:gap-16">
        {/* ---------------- who and what ---------------- */}
        <div className="wc-enter">
          <div className="mb-6 flex items-center gap-2.5">
            <img src={WILDCAT_MARK} alt="" width={30} height={30} />
            <p className="text-[11px] font-bold tracking-[0.14em] text-wc-blue-pale uppercase">
              Westbrook Academy
            </p>
          </div>

          <SplitText
            tag="h1"
            text="Wildcat Hub"
            textAlign="left"
            className="text-[42px] leading-[1.03] font-bold tracking-[-0.028em] text-wp-fg sm:text-[52px]"
            splitType="chars"
            /* 22ms between characters and 0.5s each. React Bits ships 50ms and
               1.25s, which on an eleven-character wordmark is nearly two
               seconds of a student waiting to be allowed to sign in. */
            delay={reduced ? 0 : 22}
            duration={reduced ? 0.2 : 0.5}
            ease="power3.out"
            from={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }}
            to={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
            threshold={0}
            rootMargin="0px"
          />

          <p className="mt-3.5 text-[16px] leading-[1.5]">
            <ShinyText
              text="Your ID, your timetable, your grades and a hall pass."
              /* ONE pass, then the component stops and the frame loop with it.
                 As published this runs rAF forever; `cycles` was added for this
                 screen. It is the only decorative motion in the build, it is
                 over 2.3 seconds after first paint, and it never touches the
                 button. */
              disabled={reduced}
              cycles={1}
              startDelay={0.55}
              speed={1.7}
              color="#8E9199"
              shineColor="#B5D4F4"
            />
          </p>

          {/* Desktop only: on a phone this is four lines between the student
              and the button they came for. */}
          <ul className="mt-7 hidden flex-wrap gap-2 lg:flex">
            {["ID card", "Timetable", "Grades", "Hall pass"].map((item) => (
              <li
                key={item}
                className="rounded-full border border-[var(--wp-hair)] px-3 py-1.5 text-[12px] font-medium text-wp-dim"
              >
                {item}
              </li>
            ))}
          </ul>
        </div>

        {/* ---------------- the way in ---------------- */}
        <div className="wc-enter [--wc-enter-delay:60ms]">
          <section className="wc-panel rounded-[17px] border border-[var(--wp-hair)] p-5 sm:p-6">
            <h2 className="text-[15px] font-bold text-wp-fg">
              Sign in to continue
            </h2>
            <p className="mt-1.5 text-[13px] leading-[1.5] text-wp-dim">
              Use the Google account the school gave you — the one that ends in{" "}
              <span className="font-medium whitespace-nowrap text-wc-blue-pale">
                @{HOSTED_DOMAIN}
              </span>
              .
            </p>

            {/* Google renders its own button in here, in an iframe, at the
                width measured above. It is not restyled and not imitated.
                min-h reserves the space so nothing below it jumps when the
                script lands. `inert` while busy, so a second press cannot
                start a second sign-in over the top of the first. */}
            <div
              ref={slotRef}
              className="mt-5 min-h-[44px] transition-opacity duration-200 ease-out"
              style={{ opacity: busy ? 0.45 : 1 }}
              inert={busy || undefined}
            />

            {busy && (
              <p
                role="status"
                className="mt-4 flex items-center gap-2.5 text-[13px] text-wc-blue-pale"
              >
                <span className="wc-spin" aria-hidden="true" />
                Checking with the school server…
              </p>
            )}

            {problem && !busy && (
              <ProblemNote
                problem={problem}
                /* A probe has no credential behind it, so it would otherwise
                   draw the one state a real student never sees: the retryable
                   failures WITHOUT their retry button. retrySignIn() with
                   nothing in hand is a no-op, so showing it is safe and the
                   screenshot is honest. */
                canRetry={probe ? true : canRetry}
                onRetry={retrySignIn}
                onDifferentAccount={chooseDifferentAccount}
              />
            )}

            {!busy &&
              problem?.kind === "google" &&
              /origin_mismatch/i.test(problem.message) && (
                <p className="mt-3 text-[11.5px] leading-[1.5] text-wp-dim">
                  <code>origin_mismatch</code> means the page is being served
                  from an address Google has not been told about. The authorised
                  ones are localhost:8000, 127.0.0.1:8000 and wildcatraffle.com.
                </p>
              )}
          </section>

          <Help />

          <div className="mt-5 border-t border-[var(--wp-hair)] pt-4">
            <p className="text-[11.5px] leading-[1.6] text-wp-dim">
              Staff and teachers sign in on the{" "}
              <a
                className="text-wc-blue-pale underline underline-offset-2"
                href="../"
              >
                main Wildcat app
              </a>
              , not here.
            </p>
            <p className="mt-2 text-[11.5px] leading-[1.6] text-wp-dim">
              Just looking at the screens? Open{" "}
              <a
                className="text-wc-blue-pale underline underline-offset-2"
                href="?demo=panel#/cards"
              >
                sample data
              </a>{" "}
              — nothing real is loaded and every screen says so.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
