import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ConvexCallError,
  convexQuery,
  convexMutation,
  errorRef,
  errorText,
  isAuthError,
} from "./convex";
import { googleSignOut, tokenExpiry } from "./google";
import { resetArrivals } from "./arrive";
import {
  demoMode,
  fixtureCurrentClass,
  fixtureMe,
  fixturePassCard,
  fixtureStudentView,
  passScenario,
  FIXTURE_REDACTED,
  type DemoMode,
} from "./fixture";

/**
 * Session and data for the whole student surface.
 *
 * FOUR INDEPENDENT READS, NEVER ONE. me:get, passCard:mine,
 * views_app:myStudentView and hallPasses:myCurrentClass are separate functions
 * with separate failure modes: passCard.mine goes through requireStudentSelf
 * and throws for an archived student, myStudentView can refuse for a missing
 * student number, and myCurrentClass answers "no class right now" in twenty
 * different ways that are all normal. Awaiting them together and catching once
 * would let one refusal blank four screens, and the student would have no idea
 * which fact was missing. Each keeps its own loading / ok / error state and
 * each renders its own reason.
 *
 * `tapLocations:listForStudents` USED TO BE THE FOURTH READ and is not called
 * from anywhere now. It fed the room picker on the hall pass screen, and the
 * picker is gone: a pass originates from the class the timetable says the
 * student is sitting in, which the server works out, so there is nothing for a
 * list of rooms to attach a request to. The endpoint still exists for staff
 * screens in the main app; polling it here would be every student's browser
 * fetching a list nothing renders.
 */

export type Async<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; data: T }
  /**
   * `requestId` is Convex's handle on a REDACTED refusal, carried alongside the
   * sentence rather than only inside it. The screen puts it on a chip with a
   * copy button, because a fifteen-year-old reading a hex string off a phone to
   * an adult gets it wrong, and it is the only thing the office can look up.
   * Absent on every other kind of failure. See errorRef in convex.ts.
   */
  | { state: "error"; message: string; requestId?: string | null };

/**
 * WHY THIS IS A SHAPE AND NOT A STRING.
 *
 * A sign-in can fail in five materially different ways, and the only useful
 * screen is one that tells them apart. A single `string` cannot: it flattens
 * "the office has to add you to a group", "your session ran out, press the
 * button again" and "here is a reference number, carry it to the office" into
 * one grey box, and a student is left with no idea which adult to find or
 * whether pressing the button again would even help.
 *
 *   function     the server refused ON PURPOSE and wrote the sentence itself.
 *                Print it verbatim; it usually names who can fix it.
 *   redacted     the server threw a plain Error and Convex hid the reason
 *                behind a request id. The id is the only handle anyone has, so
 *                it goes on screen big enough to copy down.
 *   auth         HTTP 401 — a DIFFERENT envelope from a function error, and the
 *                one that means "press the button again" is the whole fix.
 *   transport    the network, or a reply this app could not read. Retryable.
 *   not-student  Google is happy, the token is valid, and the account is simply
 *                not a student. Never an error box with no way forward.
 *   google       Google Identity Services never loaded or never started.
 */
export type AuthProblemKind =
  | "function"
  | "redacted"
  | "transport"
  | "auth"
  | "not-student"
  | "google";

export type AuthProblem = {
  kind: AuthProblemKind;
  /** The server's own words when it wrote any. Shown verbatim. */
  message: string;
  /** Convex's request id on a redacted refusal. The office's only handle. */
  requestId: string | null;
  /** The address that signed in, when THAT is the useful fact. */
  who?: string | null;
};

function problemFrom(err: unknown): AuthProblem {
  if (err instanceof ConvexCallError) {
    return { kind: err.kind, message: err.message, requestId: err.requestId };
  }
  return { kind: "transport", message: errorText(err), requestId: null };
}

type Me = {
  kind?: string;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  gradeLevel?: string | null;
  hasAppRecord?: boolean;
  schedule?: unknown;
  tickets?: unknown;
};

type SessionValue = {
  idToken: string | null;
  demo: DemoMode;
  signedIn: boolean;
  /** Sign-in is in flight (token received, me:get running). */
  authBusy: boolean;
  authError: AuthProblem | null;
  /**
   * True when a credential from this page load is still in hand, so "try again"
   * can re-post it instead of sending a student back through the account
   * picker for what was a flaky network.
   */
  canRetry: boolean;
  retrySignIn: () => void;
  me: Async<Me>;
  passCard: Async<Record<string, unknown>>;
  studentView: Async<Record<string, unknown>>;
  /** hallPasses:myCurrentClass — the class this student is scheduled into NOW. */
  currentClass: Async<Record<string, unknown>>;
  acceptCredential: (jwt: string) => Promise<void>;
  signOut: () => void;
  refresh: () => void;
  /** For mutations from the hall pass screen. */
  mutate: (path: string, args: Record<string, unknown>) => Promise<unknown>;
};

const Ctx = createContext<SessionValue | null>(null);

const TOKEN_KEY = "wildcat.hub.idToken";

function readStoredToken(): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const exp = tokenExpiry(raw);
    // A token that expired while the lid was shut would otherwise produce
    // "Not authenticated." on four panels at once, which reads as an outage.
    if (exp !== null && exp <= Date.now() + 30_000) {
      sessionStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const demo = useMemo(() => demoMode(window.location.search), []);
  /**
   * `?pass=<code>` picks which sample hall-pass state the fixture returns.
   *
   * Sixteen-odd ways of having no class to send a request to, and every one of
   * them is a real sentence a student can be looking at. They cannot be reached
   * by waiting — several need a Saturday, a holiday or a broken time zone — so
   * the only way to review the screen that renders them is to ask for it.
   * Display only, demo only, and the sample banner is on screen throughout.
   */
  const scenario = useMemo(() => passScenario(window.location.search), []);
  const [idToken, setIdToken] = useState<string | null>(() =>
    demo ? null : readStoredToken(),
  );
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<AuthProblem | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [nonce, setNonce] = useState(0);
  /** The last credential Google handed over, for a retry that skips the picker. */
  const lastCredential = useRef<string | null>(null);

  const [me, setMe] = useState<Async<Me>>({ state: "idle" });
  const [passCard, setPassCard] = useState<Async<Record<string, unknown>>>({
    state: "idle",
  });
  const [studentView, setStudentView] = useState<
    Async<Record<string, unknown>>
  >({ state: "idle" });
  const [currentClass, setCurrentClass] = useState<
    Async<Record<string, unknown>>
  >({ state: "idle" });

  // Guards a late reply from a token that has since been replaced or cleared.
  const runIdRef = useRef(0);

  useEffect(() => {
    if (demo) {
      setMe({ state: "ok", data: fixtureMe() });
      setPassCard({ state: "ok", data: fixturePassCard(scenario) });
      setStudentView({ state: "ok", data: fixtureStudentView(demo) });
      // The one sample state that is a FAILED read rather than a returned
      // refusal, because on the deployed backend today it is the likely one.
      setCurrentClass(
        scenario === "redacted"
          ? { state: "error", ...FIXTURE_REDACTED }
          : { state: "ok", data: fixtureCurrentClass(scenario) },
      );
      return;
    }

    if (!idToken) {
      setMe({ state: "idle" });
      setPassCard({ state: "idle" });
      setStudentView({ state: "idle" });
      setCurrentClass({ state: "idle" });
      return;
    }

    const run = ++runIdRef.current;
    const fresh = () => runIdRef.current === run;

    const load = <T,>(
      path: string,
      set: (v: Async<T>) => void,
      onAuthFailure?: () => void,
    ) => {
      set({ state: "loading" });
      convexQuery(path, {}, idToken).then(
        (value) => {
          if (!fresh()) return;
          set({ state: "ok", data: value as T });
        },
        (err) => {
          if (!fresh()) return;
          if (isAuthError(err)) onAuthFailure?.();
          set({
            state: "error",
            message: errorText(err),
            requestId: errorRef(err),
          });
        },
      );
    };

    load<Me>("me:get", setMe, () => {
      // The token is dead, not the endpoint. Drop it so the sign-in screen
      // comes back instead of four identical refusals.
      try {
        sessionStorage.removeItem(TOKEN_KEY);
      } catch {
        /* private mode */
      }
      // AND SAY SO. Dropping the token alone bounced a student back to a
      // sign-in screen that looked exactly like a fresh one, with no hint that
      // anything had happened or that they had been signed in a second ago.
      // The 401 envelope is the one failure a student can clear themselves, so
      // it is the one that must never arrive silently.
      setCanRetry(false);
      lastCredential.current = null;
      setAuthError({
        kind: "auth",
        message:
          "You were signed in, and the school server has stopped accepting " +
          "that sign-in.",
        requestId: null,
      });
      setIdToken(null);
    });
    load("passCard:mine", setPassCard);
    load("views_app:myStudentView", setStudentView);
    load("hallPasses:myCurrentClass", setCurrentClass);
  }, [idToken, demo, nonce, scenario]);

  const acceptCredential = useCallback(async (jwt: string) => {
    setAuthBusy(true);
    setAuthError(null);
    lastCredential.current = jwt;
    setCanRetry(true);
    try {
      // The token is handed to Convex FIRST and Convex says who this is. The
      // browser never decides. `me:get` is the only endpoint that answers for
      // both kinds of user, so it is also the one that can say "you are staff".
      const who = (await convexQuery("me:get", {}, jwt)) as Me;

      if (who?.kind !== "student") {
        // NOT a throw. This is not a malfunction: Google is happy, the token is
        // valid, and the account is simply the wrong kind. It gets its own kind
        // so the screen can offer the two things that actually help — pick a
        // different account, or go to the app that staff sign in on — instead
        // of a red box.
        setAuthError({
          kind: "not-student",
          message:
            `That account signed in as ` +
            `${who?.kind ?? "a kind of user this app does not recognise"}.`,
          requestId: null,
          who: who?.email ?? null,
        });
        return;
      }

      try {
        sessionStorage.setItem(TOKEN_KEY, jwt);
      } catch {
        /* private mode: the session simply will not survive a refresh */
      }

      // Proof that federated sign-in worked. The cutover that deletes the
      // cleartext passwords counts these rows, so a failure is logged loudly
      // and still never fails a sign-in that has already succeeded.
      convexMutation("authEvents:record", {}, jwt).catch((err) => {
        console.error("[hub] failed to record sign-in proof:", errorText(err));
      });

      setIdToken(jwt);
      setMe({ state: "ok", data: who });
    } catch (err) {
      setAuthError(problemFrom(err));
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const retrySignIn = useCallback(() => {
    const jwt = lastCredential.current;
    if (!jwt) return;
    void acceptCredential(jwt);
  }, [acceptCredential]);

  const signOut = useCallback(() => {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    googleSignOut();
    // Shared Chromebook. The next student's balance and tickets are new
    // figures and have to be allowed to count; without this they would be
    // compared against the last student's and sit still. See lib/arrive.ts.
    resetArrivals();
    runIdRef.current++;
    lastCredential.current = null;
    setCanRetry(false);
    setIdToken(null);
    // Signing out lands on the STUDENT entrance with nothing red on it. A
    // student who left on purpose has not hit an error.
    setAuthError(null);
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const mutate = useCallback(
    (path: string, args: Record<string, unknown>) => {
      if (demo) {
        return Promise.reject(
          new Error(
            "This is sample data. Sign in with your school account to request " +
              "a real hall pass.",
          ),
        );
      }
      return convexMutation(path, args, idToken);
    },
    [idToken, demo],
  );

  const value = useMemo<SessionValue>(
    () => ({
      idToken,
      demo,
      signedIn: Boolean(idToken) || Boolean(demo),
      authBusy,
      authError,
      canRetry,
      retrySignIn,
      me,
      passCard,
      studentView,
      currentClass,
      acceptCredential,
      signOut,
      refresh,
      mutate,
    }),
    [
      idToken,
      demo,
      authBusy,
      authError,
      canRetry,
      retrySignIn,
      me,
      passCard,
      studentView,
      currentClass,
      acceptCredential,
      signOut,
      refresh,
      mutate,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}
