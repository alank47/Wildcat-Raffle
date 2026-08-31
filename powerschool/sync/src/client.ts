/**
 * PowerSchool REST client.
 *
 * Responsibilities, all of which are staging requirements rather than
 * conveniences:
 *   - OAuth 2.0 client credentials token fetch, cached until near expiry,
 *     with a single automatic refresh and retry on a 401.
 *   - Read only. Any verb other than GET, or a POST to anything other than
 *     the token endpoint or a named query, throws before it reaches the
 *     network.
 *   - Retry with exponential backoff and jitter on 429 and 5xx, honouring
 *     Retry-After when the server sends one.
 *   - Request counting per run, with a hard ceiling so a runaway loop cannot
 *     burn the per plugin hourly quota.
 *   - Per call row count and elapsed time logging.
 */

import type { Config } from "./config.ts";

export type RequestStat = {
  method: string;
  path: string;
  status: number;
  ms: number;
  rows: number | null;
  attempts: number;
};

type Token = { value: string; expiresAtMs: number };

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
/** Refresh this far ahead of stated expiry so a long page loop cannot straddle it. */
const TOKEN_SKEW_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
  }
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  // Full jitter. Avoids a fleet of retries landing on the same millisecond.
  return Math.floor(Math.random() * exponential);
}

export class ReadOnlyViolation extends Error {}
export class RequestCeilingReached extends Error {}

export class PowerSchoolClient {
  readonly stats: RequestStat[] = [];

  private token: Token | null = null;
  private tokenFetches = 0;

  // Declared as fields rather than constructor parameter properties. Node's
  // strip-only TypeScript mode rejects parameter properties, and this harness
  // is meant to run with no build step and no dependencies.
  private readonly config: Config;
  private readonly log: (line: string) => void;

  constructor(config: Config, log: (line: string) => void = (line) => console.log(line)) {
    this.config = config;
    this.log = log;
  }

  get requestCount(): number {
    return this.stats.length + this.tokenFetches;
  }

  private get base(): string {
    return `https://${this.config.host}`;
  }

  /**
   * OAuth 2.0 client credentials. The Basic credential is built here and
   * never stored, never logged, and never returned.
   */
  private async fetchToken(): Promise<Token> {
    const basic = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString("base64");

    const started = Date.now();
    const response = await fetch(`${this.base}/oauth/access_token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    this.tokenFetches += 1;

    const elapsed = Date.now() - started;

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Token request failed with ${response.status} after ${elapsed}ms. ` +
          `Body: ${body.slice(0, 400)}`,
      );
    }

    const json = (await response.json()) as {
      access_token?: string;
      expires_in?: string | number;
    };

    if (!json.access_token) {
      throw new Error("Token response contained no access_token.");
    }

    const expiresInSeconds = Number(json.expires_in ?? 3600);
    this.log(
      `[auth] token acquired in ${elapsed}ms, expires_in=${expiresInSeconds}s`,
    );

    return {
      value: json.access_token,
      expiresAtMs: Date.now() + expiresInSeconds * 1000,
    };
  }

  private async accessToken(forceRefresh = false): Promise<string> {
    const expired =
      this.token === null || Date.now() >= this.token.expiresAtMs - TOKEN_SKEW_MS;
    if (forceRefresh || expired) {
      this.token = await this.fetchToken();
    }
    return this.token.value;
  }

  /** Proves the credential works. Used by the auth smoke test. */
  async authenticate(): Promise<{ expiresInSeconds: number }> {
    const token = await this.accessToken(true);
    if (this.token === null) throw new Error("Token missing after fetch.");
    return {
      expiresInSeconds: Math.round((this.token.expiresAtMs - Date.now()) / 1000),
    };
  }

  /**
   * The single network chokepoint. Everything else goes through here so the
   * read only guard, the ceiling, the backoff, and the logging cannot be
   * bypassed by accident.
   */
  private async request(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; query?: Record<string, string | number> } = {},
  ): Promise<{ status: number; json: any; text: string }> {
    if (method !== "GET" && method !== "POST") {
      throw new ReadOnlyViolation(`Blocked ${method}. This harness is read only.`);
    }
    if (method === "POST" && !path.startsWith("/ws/schema/query/")) {
      throw new ReadOnlyViolation(
        `Blocked POST to ${path}. POST is only permitted for named queries.`,
      );
    }
    if (this.requestCount >= this.config.hourlyRequestCeiling) {
      throw new RequestCeilingReached(
        `Request ceiling ${this.config.hourlyRequestCeiling} reached. ` +
          `Stopping before the per plugin quota is at risk.`,
      );
    }

    const url = new URL(path, this.base);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    let attempt = 0;
    let lastStatus = 0;

    while (attempt < MAX_ATTEMPTS) {
      const started = Date.now();
      const token = await this.accessToken();

      // TRANSPORT ERRORS ARE RETRIED, NOT JUST HTTP STATUSES.
      //
      // fetch() THROWS on a dropped connection; it does not return a status.
      // Unwrapped, that throw escapes this whole retry loop, so a socket the
      // server closed killed a sync that had already done its work. Seen on
      // 2026-08-31: PowerSchool closed the keep-alive connection after about
      // 2.6MB, the student_email query threw UND_ERR_SOCKET "other side
      // closed", and the run ended with no sync recorded, even though the same
      // query succeeds on its own in seven pages.
      //
      // A dropped connection is the textbook retryable failure: the next
      // attempt opens a new socket. Retrying it here is what makes a long sync
      // survive a connection the server recycles under it.
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        });
      } catch (error: unknown) {
        if (attempt < MAX_ATTEMPTS - 1) {
          const cause = (error as { cause?: { code?: string } })?.cause?.code ?? "unknown";
          const wait = backoffMs(attempt, null);
          this.log(
            `[retry] transport ${cause} on ${path}, attempt ${attempt + 1}, waiting ${wait}ms`,
          );
          await sleep(wait);
          attempt += 1;
          continue;
        }
        // Out of attempts. Rethrow rather than returning a status, because a
        // transport failure is NOT an empty result and a caller that treats it
        // as one writes an empty slice over real data.
        throw error;
      }

      const elapsed = Date.now() - started;
      lastStatus = response.status;
      const text = await response.text();

      // An expired token must trigger a refresh and a retry, never a silent
      // empty result. One forced refresh, then give up on that path.
      if (response.status === 401 && attempt === 0) {
        this.log(`[auth] 401 on ${path}, forcing token refresh and retrying`);
        await this.accessToken(true);
        attempt += 1;
        continue;
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
        const wait = backoffMs(attempt, response.headers.get("retry-after"));
        this.log(
          `[retry] ${response.status} on ${path}, attempt ${attempt + 1}, waiting ${wait}ms`,
        );
        await sleep(wait);
        attempt += 1;
        continue;
      }

      let json: any = null;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }

      const rows = countRows(json);
      this.stats.push({
        method,
        path: url.pathname,
        status: response.status,
        ms: elapsed,
        rows,
        attempts: attempt + 1,
      });
      this.log(
        `[req] ${method} ${url.pathname} status=${response.status} ` +
          `rows=${rows === null ? "n/a" : rows} ${elapsed}ms attempts=${attempt + 1}`,
      );

      return { status: response.status, json, text };
    }

    throw new Error(`Gave up on ${path} after ${MAX_ATTEMPTS} attempts. Last status ${lastStatus}.`);
  }

  async get(
    path: string,
    query: Record<string, string | number> = {},
  ): Promise<{ status: number; json: any; text: string }> {
    return this.request("GET", path, { query });
  }

  /** Server capabilities. Also the cheapest proof the host and token work. */
  async metadata(): Promise<any> {
    const { json } = await this.get("/ws/v1/metadata");
    return json?.metadata ?? json;
  }

  /**
   * Flat single table read. Used only for probing and for tables that need no
   * join. Anything with a join or an aggregate belongs in a named query.
   */
  async tableRead(
    table: string,
    projection: string[],
    query: Record<string, string | number> = {},
  ): Promise<{ status: number; json: any; text: string }> {
    return this.get(`/ws/schema/table/${table}`, {
      projection: projection.join(","),
      pagesize: this.config.pageSize,
      ...query,
    });
  }

  /**
   * Named query, paged to exhaustion. Returns every record and reports the
   * total row count and elapsed time for the whole set.
   */
  async namedQuery(
    name: string,
    args: Record<string, string | number>,
    options: { maxPages?: number } = {},
  ): Promise<{ rows: any[]; pages: number; ms: number }> {
    const started = Date.now();
    const rows: any[] = [];
    let page = 1;
    const maxPages = options.maxPages ?? 500;

    while (page <= maxPages) {
      const { status, json, text } = await this.request(
        "POST",
        `/ws/schema/query/${name}`,
        { body: args, query: { pagesize: this.config.pageSize, page } },
      );

      if (status !== 200) {
        throw new Error(
          `Named query ${name} failed on page ${page} with ${status}. ` +
            `Body: ${text.slice(0, 400)}`,
        );
      }

      const record = Array.isArray(json?.record) ? json.record : [];
      rows.push(...record);

      if (record.length < this.config.pageSize) break;
      page += 1;
    }

    const ms = Date.now() - started;
    this.log(`[query] ${name} rows=${rows.length} pages=${page} ${ms}ms`);
    return { rows, pages: page, ms };
  }

  /** Per run summary. Emit this at the end of every run. */
  summary(): {
    requests: number;
    tokenFetches: number;
    totalMs: number;
    slowest: RequestStat | null;
    errors: number;
  } {
    const totalMs = this.stats.reduce((sum, stat) => sum + stat.ms, 0);
    const slowest =
      this.stats.length === 0
        ? null
        : this.stats.reduce((worst, stat) => (stat.ms > worst.ms ? stat : worst));
    return {
      requests: this.requestCount,
      tokenFetches: this.tokenFetches,
      totalMs,
      slowest,
      errors: this.stats.filter((stat) => stat.status >= 400).length,
    };
  }
}

function countRows(json: any): number | null {
  if (json === null || typeof json !== "object") return null;
  if (Array.isArray(json.record)) return json.record.length;
  if (Array.isArray(json.students?.student)) return json.students.student.length;
  if (Array.isArray(json)) return json.length;
  return null;
}
