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
import { convexQuery, convexMutation, errorText, isAuthError } from "./convex";
import { googleSignOut, tokenExpiry } from "./google";
import {
  demoMode,
  fixtureMe,
  fixturePassCard,
  fixtureStudentView,
  fixtureTapLocations,
  type DemoMode,
} from "./fixture";

/**
 * Session and data for the whole student surface.
 *
 * FOUR INDEPENDENT READS, NEVER ONE. me:get, passCard:mine,
 * views_app:myStudentView and tapLocations:listForStudents are separate
 * functions with separate failure modes: passCard.mine goes through
 * requireStudentSelf and throws for an archived student, myStudentView can
 * refuse for a missing student number, tapLocations can be empty. Awaiting them
 * together and catching once would let one refusal blank four screens, and the
 * student would have no idea which fact was missing. Each keeps its own
 * loading / ok / error state and each renders its own reason.
 */

export type Async<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; data: T }
  | { state: "error"; message: string };

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
  authError: string | null;
  me: Async<Me>;
  passCard: Async<Record<string, unknown>>;
  studentView: Async<Record<string, unknown>>;
  tapLocations: Async<Record<string, unknown>>;
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
  const [idToken, setIdToken] = useState<string | null>(() =>
    demo ? null : readStoredToken(),
  );
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const [me, setMe] = useState<Async<Me>>({ state: "idle" });
  const [passCard, setPassCard] = useState<Async<Record<string, unknown>>>({
    state: "idle",
  });
  const [studentView, setStudentView] = useState<
    Async<Record<string, unknown>>
  >({ state: "idle" });
  const [tapLocations, setTapLocations] = useState<
    Async<Record<string, unknown>>
  >({ state: "idle" });

  // Guards a late reply from a token that has since been replaced or cleared.
  const runIdRef = useRef(0);

  useEffect(() => {
    if (demo) {
      setMe({ state: "ok", data: fixtureMe() });
      setPassCard({ state: "ok", data: fixturePassCard() });
      setStudentView({ state: "ok", data: fixtureStudentView(demo) });
      setTapLocations({ state: "ok", data: fixtureTapLocations() });
      return;
    }

    if (!idToken) {
      setMe({ state: "idle" });
      setPassCard({ state: "idle" });
      setStudentView({ state: "idle" });
      setTapLocations({ state: "idle" });
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
          set({ state: "error", message: errorText(err) });
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
      setIdToken(null);
    });
    load("passCard:mine", setPassCard);
    load("views_app:myStudentView", setStudentView);
    load("tapLocations:listForStudents", setTapLocations);
  }, [idToken, demo, nonce]);

  const acceptCredential = useCallback(async (jwt: string) => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      // The token is handed to Convex FIRST and Convex says who this is. The
      // browser never decides. `me:get` is the only endpoint that answers for
      // both kinds of user, so it is also the one that can say "you are staff".
      const who = (await convexQuery("me:get", {}, jwt)) as Me;

      if (who?.kind !== "student") {
        throw new Error(
          `This is the student hub, and that account signed in as ` +
            `${who?.kind ?? "an unknown kind of user"}. Staff use the main app.`,
        );
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
      setAuthError(errorText(err));
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const signOut = useCallback(() => {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    googleSignOut();
    runIdRef.current++;
    setIdToken(null);
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
      me,
      passCard,
      studentView,
      tapLocations,
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
      me,
      passCard,
      studentView,
      tapLocations,
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
