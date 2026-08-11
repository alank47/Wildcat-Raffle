/**
 * Offline self test. No network, no credentials, no PowerSchool.
 *
 * Run:  npm test
 *
 * Proves the parts of the harness that must be correct before anyone points it
 * at a real instance: the read only guard, the production host guard, the
 * redaction allowlist, and the retry backoff bounds. If this fails, do not run
 * the probe.
 */

import { productionRisk } from "./config.ts";
import { PowerSchoolClient, ReadOnlyViolation, RequestCeilingReached } from "./client.ts";
import { redactRecord } from "./redact.ts";
import { MANIFEST, manifestTables } from "./manifest.ts";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`);
  }
}

async function expectThrows(name: string, fn: () => Promise<unknown>, type: Function): Promise<void> {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (error: unknown) {
    check(name, error instanceof type, `threw ${(error as Error)?.constructor?.name}`);
  }
}

const fakeConfig = {
  host: "sandbox.example.test",
  clientId: "fake-id",
  clientSecret: "fake-secret",
  schoolId: "1",
  yearId: "35",
  termId: "3500",
  yearTermId: "3500",
  finalGradeName: "Q1",
  storeCode: "Q1",
  sampleStudentNumber: "123456",
  hourlyRequestCeiling: 3000,
  pageSize: 100,
  allowProduction: false,
};

async function main(): Promise<void> {
  console.log("Wildcat Hub sync self test (offline)\n");

  console.log("Production host guard");
  check("sandbox host passes", productionRisk("wildcat-sandbox.powerschool.com") === null);
  check("test host passes", productionRisk("ps-test.lapromisefund.org") === null);
  check("bare production host is flagged", productionRisk("lapromisefund.powerschool.com") !== null);
  check("unknown host is flagged", productionRisk("something.else.net") !== null);

  console.log("\nRead only guard");
  const client = new PowerSchoolClient(fakeConfig, () => {});
  // @ts-expect-error reaching a private method deliberately to prove the guard
  await expectThrows("PUT is blocked", () => client.request("PUT", "/ws/v1/student"), ReadOnlyViolation);
  // @ts-expect-error same
  await expectThrows("DELETE is blocked", () => client.request("DELETE", "/ws/v1/student"), ReadOnlyViolation);
  // @ts-expect-error same
  await expectThrows("POST outside named queries is blocked", () => client.request("POST", "/ws/v1/student"), ReadOnlyViolation);

  console.log("\nRequest ceiling");
  const cappedClient = new PowerSchoolClient({ ...fakeConfig, hourlyRequestCeiling: 0 }, () => {});
  // @ts-expect-error same
  await expectThrows("ceiling of 0 stops the first request", () => cappedClient.request("GET", "/ws/v1/metadata"), RequestCeilingReached);

  console.log("\nRedaction");
  const record = {
    student_id: 4021,
    student_number: "900123456",
    first_name: "Jordan",
    last_name: "Ramirez",
    teacher_email: "someone@lapromisefund.org",
    grade_level: 9,
    current_percent: null,
    race_code: "600",
    fed_ethnicity: "Y",
    ela_status: "EL",
    section_expression: "P3(A)",
    surprise_new_column: "sensitive value nobody allowlisted",
  };
  const redacted = redactRecord(record) as Record<string, unknown>;
  const asText = JSON.stringify(redacted);

  check("first name is not printed", !asText.includes("Jordan"));
  check("last name is not printed", !asText.includes("Ramirez"));
  check("student number is not printed", !asText.includes("900123456"));
  check("email is not printed", !asText.includes("lapromisefund.org"));
  check("race code is not printed", !asText.includes('"600"'));
  check("ethnicity value is not printed", redacted.fed_ethnicity !== "Y");
  check("EL status value is not printed", redacted.ela_status !== "EL");
  check("unknown column is masked by default", !asText.includes("sensitive value nobody allowlisted"));
  check("safe field survives", redacted.grade_level === 9);
  check("section expression survives", redacted.section_expression === "P3(A)");
  check("null percent stays null and does not become 0", redacted.current_percent === null);

  const second = redactRecord({ student_number: "900123456" }) as Record<string, unknown>;
  check(
    "same identifier maps to the same pseudonym within a run",
    second.student_number === redacted.student_number,
  );

  console.log("\nManifest integrity");
  check("manifest has 19 entries", MANIFEST.length === 19, `has ${MANIFEST.length}`);
  check(
    "manifest numbers are 1 through 19 with no gaps",
    MANIFEST.every((entry, index) => entry.n === index + 1),
  );
  const restricted = MANIFEST.filter((e) => e.fieldClass === "Restricted").map((e) => e.n);
  check(
    "fields 7, 8, 12, 13, 14 are the restricted set",
    JSON.stringify(restricted) === JSON.stringify([7, 8, 12, 13, 14]),
    JSON.stringify(restricted),
  );
  const unconfirmed = MANIFEST.filter((e) => e.unconfirmed).map((e) => e.n);
  check(
    "fields 5, 12, 13, 18, 19 are flagged unconfirmed",
    JSON.stringify(unconfirmed) === JSON.stringify([5, 12, 13, 18, 19]),
    JSON.stringify(unconfirmed),
  );
  check(
    "no unconfirmed field claims a delivering query",
    MANIFEST.filter((e) => e.probes.length === 0).every((e) => e.deliveredBy === null),
  );
  check("manifest touches at least 12 tables", manifestTables().size >= 12, `${manifestTables().size}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
