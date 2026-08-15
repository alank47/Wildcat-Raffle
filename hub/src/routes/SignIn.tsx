import { useEffect, useRef, useState } from "react";
import SplitText from "@/components/SplitText";
import ShinyText from "@/components/ShinyText";
import FadeContent from "@/components/FadeContent";
import { mountGoogleButton } from "@/lib/google";
import { useSession } from "@/lib/session";
import { useReducedMotion } from "@/lib/motion";
import { WILDCAT_MARK } from "@/ui/mark";
import { Unavailable } from "@/ui/primitives";

/**
 * The way in.
 *
 * This is the only screen a student sees once, so it is the only screen that
 * gets a generous entrance: SplitText on the wordmark and a single ShinyText
 * pass on the line under it. Everything past this point is a tool somebody uses
 * between classes and is tuned accordingly.
 */
export default function SignIn() {
  const { acceptCredential, authBusy, authError } = useSession();
  const buttonRef = useRef<HTMLDivElement>(null);
  const [mountError, setMountError] = useState<string | null>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const el = buttonRef.current;
    if (!el) return;
    let cancelled = false;
    mountGoogleButton(el, (jwt) => {
      void acceptCredential(jwt);
    }).catch((err: unknown) => {
      if (!cancelled) {
        setMountError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [acceptCredential]);

  return (
    <main className="wp-lift relative flex min-h-dvh flex-col items-center justify-center px-5 py-12">
      <div className="relative z-1 w-full max-w-[414px]">
        <img
          src={WILDCAT_MARK}
          alt=""
          width={56}
          height={56}
          className="mb-7 block"
        />

        <SplitText
          tag="h1"
          text="Wildcat Hub"
          textAlign="left"
          className="text-[44px] font-bold leading-[1.03] tracking-[-0.028em] text-wp-fg"
          splitType="chars"
          /* 22ms between characters and 0.5s each. React Bits ships 50ms and
             1.25s, which on an eleven-character wordmark is nearly two seconds
             of a student waiting to be allowed to sign in. */
          delay={reduced ? 0 : 22}
          duration={reduced ? 0.2 : 0.5}
          ease="power3.out"
          from={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }}
          to={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
          threshold={0}
          rootMargin="0px"
        />

        <p className="mt-3 text-[16px] leading-[1.5]">
          <ShinyText
            text="Your ID, your timetable, your grades and a hall pass."
            /* One pass, slow, and it stops for reduced motion. This is the only
               continuously animating thing in the build and it lives on the one
               screen a student is not trying to get past quickly. */
            disabled={reduced}
            speed={4}
            delay={1.2}
            color="#8E9199"
            shineColor="#B5D4F4"
          />
        </p>

        <FadeContent
          duration={reduced ? 150 : 320}
          delay={reduced ? 0 : 260}
          threshold={0}
          className="mt-9"
        >
          <p className="mb-3 text-[13px] font-medium text-wp-dim">
            Sign in with your westbrookacademy.org account.
          </p>

          {/* Google renders its own button in here. It is not restyled: a
              sign-in button that has been repainted is the thing a phishing page
              does, and a student is entitled to see the button they were taught
              to look for. */}
          <div ref={buttonRef} className="min-h-[44px]" />

          {authBusy && (
            <p className="mt-4 text-[13px] text-wc-blue-pale">
              Checking with the school server…
            </p>
          )}

          {(authError || mountError) && (
            <div className="mt-4">
              <Unavailable reason={authError ?? mountError} tone="warn" />
              {mountError && (
                <p className="mt-2 text-[11.5px] leading-[1.5] text-wp-dim">
                  If this says <code>origin_mismatch</code>, the page is being
                  served from an address Google has not been told about. The
                  authorised ones are localhost:8000, 127.0.0.1:8000 and
                  wildcatraffle.com.
                </p>
              )}
            </div>
          )}

          <div className="mt-10 border-t border-[var(--wp-hair)] pt-5">
            <p className="text-[11.5px] leading-[1.6] text-wp-dim">
              Not a student, or just looking at the screens? Open{" "}
              <a
                className="text-wc-blue-pale underline underline-offset-2"
                href="?demo=panel#/cards"
              >
                sample data
              </a>{" "}
              — nothing real is loaded and every screen says so.
            </p>
          </div>
        </FadeContent>
      </div>
    </main>
  );
}
