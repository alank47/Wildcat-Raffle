/**
 * Convex over the HTTP API. No bundler plugin, no generated client, no npm
 * package: the same transport wildcat-auth.js uses, so there is one contract
 * with the backend rather than two.
 *
 * THE TRAP THIS FILE EXISTS TO CLOSE. Convex answers a function that THREW with
 * HTTP 200 and a body of {status:"error"}. `if (!res.ok)` therefore treats
 * "Students only." as a successful response and hands `undefined` to the screen,
 * which renders as an empty panel. An empty panel is indistinguishable from a
 * student who has no grades, and that ambiguity is the bug this project has
 * shipped twice. Every read goes through here.
 */

/**
 * Production unless a build is told otherwise. The override exists so this
 * bundle can be pointed at a dev deployment, or at a stub that reproduces a
 * failure shape, without editing a constant and risking that edit shipping.
 * Unset in every normal build, including the published one.
 */
export const CONVEX_URL =
  import.meta.env.VITE_CONVEX_URL || "https://quick-cassowary-644.convex.cloud";

/**
 * `kind` is what the screen needs to know to say something useful:
 *
 *   function   the server refused ON PURPOSE and wrote the sentence itself.
 *              Print it verbatim — it usually names who can fix it.
 *   redacted   the server threw a PLAIN Error, which Convex replaces in
 *              production with "Server Error" and a request id. Nothing is
 *              known about the cause. THIS IS ALSO WHAT A FUNCTION THAT IS NOT
 *              DEPLOYED LOOKS LIKE, which is not hypothetical here: as of this
 *              build, `tapLocations:listForStudents` and
 *              `hallPasses:requestMine` return exactly this shape on
 *              quick-cassowary-644 while `me:get`, `passCard:mine` and
 *              `views_app:myStudentView` all answer with a real reason. So the
 *              student hall-pass path is not on the deployed backend yet.
 *   transport  the network, or a reply this app could not read.
 *   auth       the token is missing, malformed or expired. The caller drops it.
 */
export type ConvexErrorKind = "function" | "redacted" | "transport" | "auth";

export class ConvexCallError extends Error {
  readonly kind: ConvexErrorKind;
  /** Convex's request id, when there is one. The only handle support has. */
  readonly requestId: string | null;
  constructor(message: string, kind: ConvexErrorKind, requestId: string | null = null) {
    super(message);
    this.name = "ConvexCallError";
    this.kind = kind;
    this.requestId = requestId;
  }
}

type Body = {
  status?: string;
  value?: unknown;
  errorData?: unknown;
  errorMessage?: string;
};

/**
 * A ConvexError thrown server side arrives in `errorData` and keeps its text: it
 * is a sentence written for a student ("Your student number is not on your
 * account yet..."). A PLAIN Error is redacted by Convex in production to
 * "Server Error" plus a request id, so errorMessage is only the fallback.
 */
function requestIdOf(body: Body): string | null {
  const match = /\[Request ID: ([0-9a-f]+)\]/i.exec(body.errorMessage ?? "");
  return match ? match[1] : null;
}

function readError(body: Body): { message: string; kind: ConvexErrorKind } {
  const data = body.errorData;
  if (typeof data === "string" && data.trim())
    return { message: data, kind: "function" };
  if (data && typeof data === "object") {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.trim())
      return { message, kind: "function" };
  }

  // No errorData. Convex redacted a plain Error, OR the function is not on this
  // deployment at all — the two are indistinguishable from out here, and both
  // are true of some endpoints on production today. Saying "Server Error" and a
  // hex string at a fifteen-year-old is useless; this says what is actually
  // known, which is nothing, and hands over the only thing an adult can act on.
  const id = requestIdOf(body);
  return {
    kind: "redacted",
    message:
      "The school server could not answer this, and the reason was hidden " +
      "before it reached your screen. Nothing here means your record is empty. " +
      (id
        ? `Show the office this reference: ${id}.`
        : "Tell the office you saw this."),
  };
}

async function call(
  endpoint: "query" | "mutation",
  path: string,
  args: Record<string, unknown>,
  idToken: string | null,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${CONVEX_URL}/api/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      body: JSON.stringify({ path, args, format: "json" }),
    });
  } catch (err) {
    throw new ConvexCallError(
      `Could not reach the school server. Check the Wi-Fi and try again. (${
        err instanceof Error ? err.message : String(err)
      })`,
      "transport",
    );
  }

  // A NON-200 does NOT use the {status, errorData} envelope. A bad or expired
  // token comes back as HTTP 401 with {code:"InvalidAuthHeader", message:"..."},
  // and throwing a bare "HTTP 401" here would turn "your sign-in ran out" into
  // an unexplained failure on four panels at once.
  if (!res.ok) {
    let detail = "";
    try {
      const raw = (await res.json()) as { code?: string; message?: string };
      detail = raw?.message ?? "";
    } catch {
      /* not JSON */
    }
    if (res.status === 401 || res.status === 403) {
      throw new ConvexCallError(
        "Your sign-in is no longer valid. Sign in again." +
          (detail ? ` (${detail})` : ""),
        "auth",
      );
    }
    throw new ConvexCallError(
      `The school server answered with HTTP ${res.status}.` +
        (detail ? ` ${detail}` : ""),
      "transport",
    );
  }

  let body: Body;
  try {
    body = (await res.json()) as Body;
  } catch {
    throw new ConvexCallError(
      "The school server sent a reply this app could not read.",
      "transport",
    );
  }

  // HTTP 200 AND status:"error" is the normal shape of a refusal here.
  if (body.status === "error") {
    const { message, kind } = readError(body);
    throw new ConvexCallError(
      message,
      /^not authenticated\.?$/i.test(message) ? "auth" : kind,
      requestIdOf(body),
    );
  }

  // A 200 that is neither success nor error is a contract change, not data.
  // Returning body.value regardless would hand `undefined` to a panel.
  if (body.status !== "success") {
    throw new ConvexCallError(
      `The school server sent an unexpected reply for ${path}.`,
      "transport",
    );
  }

  return body.value;
}

export function convexQuery(
  path: string,
  args: Record<string, unknown>,
  idToken: string | null,
): Promise<unknown> {
  return call("query", path, args, idToken);
}

export function convexMutation(
  path: string,
  args: Record<string, unknown>,
  idToken: string | null,
): Promise<unknown> {
  return call("mutation", path, args, idToken);
}

export function errorText(err: unknown): string {
  if (err instanceof ConvexCallError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** True when the token, not the request, is the problem. */
export function isAuthError(err: unknown): boolean {
  return err instanceof ConvexCallError && err.kind === "auth";
}
