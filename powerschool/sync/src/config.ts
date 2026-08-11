/**
 * Configuration loading and safety rails.
 *
 * Two rules enforced here and nowhere else:
 *   1. A client id or client secret never leaves this module as a printable
 *      value. Anything that wants to log config gets the redacted view.
 *   2. The harness refuses to talk to anything that looks like a production
 *      PowerSchool instance unless someone deliberately set the escape hatch.
 */

import { execFileSync } from "node:child_process";

export type Config = {
  host: string;
  clientId: string;
  clientSecret: string;
  schoolId: string;
  yearId: string;
  termId: string;
  yearTermId: string;
  finalGradeName: string;
  storeCode: string;
  sampleStudentNumber: string;
  hourlyRequestCeiling: number;
  pageSize: number;
  allowProduction: boolean;
};

/** Hostname fragments that mean "this is probably the real thing". */
const PRODUCTION_MARKERS = ["powerschool.com", "ps.", "sis."];

/** Hostname fragments that positively identify a non production instance. */
const SANDBOX_MARKERS = ["sandbox", "test", "staging", "stage", "dev", "qa", "training"];

/**
 * Resolves a 1Password secret reference to its value.
 *
 * We call `op read` on the single reference rather than wrapping the process
 * in `op run --env-file`. `op run` scans the entire inherited environment for
 * op:// references and fails the whole run if any unrelated one cannot be
 * resolved, which is a real problem on a machine with other projects'
 * references already exported.
 *
 * If a 1Password service account token is present but lacks access to the
 * vault, we retry once without it so desktop app authentication can answer.
 * The resolved value is returned and never logged.
 */
function resolveSecretReference(name: string, reference: string): string {
  const attempts: Array<{ label: string; env: NodeJS.ProcessEnv }> = [
    { label: "current 1Password session", env: process.env },
  ];

  if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
    const withoutToken = { ...process.env };
    delete withoutToken.OP_SERVICE_ACCOUNT_TOKEN;
    attempts.push({ label: "desktop app session", env: withoutToken });
  }

  const failures: string[] = [];

  for (const attempt of attempts) {
    try {
      const value = execFileSync("op", ["read", reference], {
        encoding: "utf8",
        env: attempt.env,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (value !== "") return value;
      failures.push(`${attempt.label}: returned empty`);
    } catch (error: unknown) {
      const stderr = (error as { stderr?: Buffer | string })?.stderr;
      const detail = String(stderr ?? (error as Error)?.message ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      failures.push(`${attempt.label}: ${detail || "failed"}`);
    }
  }

  throw new Error(
    [
      `Could not resolve ${name} from 1Password.`,
      `Reference: ${reference}`,
      ...failures.map((line) => `  ${line}`),
      "",
      "Check that you are signed in (op whoami) and that the reference points",
      "at a vault you can read (op vault list).",
    ].join("\n"),
  );
}

function required(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (value === "") {
    throw new Error(
      `Missing ${name}. Copy powerschool/sync/.env.example to .env and fill it in.`,
    );
  }
  // Secrets live in .env as op:// references, never as values.
  if (value.startsWith("op://")) {
    return resolveSecretReference(name, value);
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return (process.env[name] ?? "").trim() || fallback;
}

function normalizeHost(raw: string): string {
  return raw
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .trim()
    .toLowerCase();
}

/**
 * Returns a warning string when the host does not look like a sandbox, or
 * null when it does. Callers decide whether that is fatal.
 */
export function productionRisk(host: string): string | null {
  const looksSandbox = SANDBOX_MARKERS.some((marker) => host.includes(marker));
  if (looksSandbox) return null;
  const looksProduction = PRODUCTION_MARKERS.some((marker) => host.includes(marker));
  if (!looksProduction) {
    return `Host "${host}" carries no sandbox marker. Confirm it is not production before pulling.`;
  }
  return `Host "${host}" looks like a production PowerSchool instance.`;
}

export function loadConfig(): Config {
  const host = normalizeHost(required("PS_HOST"));
  const allowProduction = optional("PS_ALLOW_PRODUCTION").toLowerCase() === "yes";

  const risk = productionRisk(host);
  if (risk !== null && !allowProduction) {
    throw new Error(
      [
        "Refusing to run.",
        risk,
        "",
        "The staging brief says: no production student records in staging.",
        "If only a production instance exists, stop and agree a de-identification",
        "approach before pulling anything. Only then set PS_ALLOW_PRODUCTION=yes.",
      ].join("\n"),
    );
  }

  return {
    host,
    clientId: required("PS_CLIENT_ID"),
    clientSecret: required("PS_CLIENT_SECRET"),
    schoolId: optional("PS_SCHOOL_ID"),
    yearId: optional("PS_YEAR_ID"),
    termId: optional("PS_TERM_ID"),
    yearTermId: optional("PS_YEAR_TERM_ID"),
    finalGradeName: optional("PS_FINAL_GRADE_NAME"),
    storeCode: optional("PS_STORE_CODE"),
    sampleStudentNumber: optional("PS_SAMPLE_STUDENT_NUMBER"),
    hourlyRequestCeiling: Number(optional("PS_HOURLY_REQUEST_CEILING", "3000")),
    pageSize: Number(optional("PS_PAGE_SIZE", "100")),
    allowProduction,
  };
}

/** Safe to print. Secrets are replaced, not truncated. */
export function redactedConfig(config: Config): Record<string, string> {
  return {
    host: config.host,
    clientId: config.clientId ? "[set]" : "[missing]",
    clientSecret: config.clientSecret ? "[set]" : "[missing]",
    schoolId: config.schoolId || "[unset]",
    yearId: config.yearId || "[unset]",
    termId: config.termId || "[unset]",
    yearTermId: config.yearTermId || "[unset]",
    finalGradeName: config.finalGradeName || "[unset]",
    storeCode: config.storeCode || "[unset]",
    sampleStudentNumber: config.sampleStudentNumber ? "[set]" : "[unset]",
    hourlyRequestCeiling: String(config.hourlyRequestCeiling),
    pageSize: String(config.pageSize),
    allowProduction: config.allowProduction ? "YES (escalated)" : "no",
  };
}
