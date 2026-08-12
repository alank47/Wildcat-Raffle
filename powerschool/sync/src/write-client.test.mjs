// Can the PowerSchool write client put a byte on the wire that it should not?
//
// Every test here runs against a local fake: either an injected fetch that
// records what it was handed, or a node:http server bound to 127.0.0.1. No test
// in this file can reach lapf.powerschool.com, and the tests that matter most
// assert that the client did not even try.
//
// Run:  node src/write-client.test.mjs
//
// The three claims under test, in order of how much damage a failure does:
//   1. Disarmed by default. No environment variable, no request, no exception
//      to that.
//   2. The current plugin grant blocks every write, proven by reading
//      powerschool/plugin/plugin.xml rather than by sending anything.
//   3. A behavior entry a human edited in PowerSchool is never silently
//      overwritten by the app, and the watermark that decides it is stored
//      rather than assumed.
//   4. The grant check cannot be answered with a file of the caller's
//      choosing. A reviewer opened every gate against lapf.powerschool.com by
//      passing grantsPath: powerschool/plugin/plugin-v2.xml; section 24
//      reproduces that exact attack and asserts it now fails.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_WRITE_VERBS,
  COLUMN_MAX_LENGTH,
  assertWritableColumns,
  assertWritableTable,
  DEFAULT_WRITE_CEILING,
  ForbiddenTarget,
  GrantMissing,
  LOG_WRITABLE_COLUMNS,
  PayloadRejected,
  PowerSchoolWriteClient,
  ProductionHostBlocked,
  WRITABLE_TABLES,
  WRITE_ENABLE_VALUE,
  WRITE_ENABLE_VAR,
  WRITE_PRODUCTION_HOST_VAR,
  WriteCeilingReached,
  WriteDisarmed,
  armingState,
  buildLogRow,
  checkWriteGrant,
  disciplineColumnsPresent,
  findEarnedValueText,
  FileWatermarkStore,
  findProvenanceId,
  fingerprintRow,
  formatEntryDate,
  formatEntryTime,
  grantSourceProblems,
  INSTALLED_PLUGIN_VERSION,
  INSTALLED_PLUGIN_XML,
  installedGrant,
  loadAccessRequest,
  makeWatermark,
  MemoryWatermarkStore,
  parseAccessRequest,
  planCreate,
  planUpdate,
  parseTarget,
  provenanceMarker,
  renderCreate,
  renderRetract,
  renderUpdate,
  resolveConsequence,
  resolveGenValue,
  resolveLogType,
  resolveSubtype,
  WRITE_PATH_PREFIX,
} from "./write-client.ts";

let pass = 0;
let fail = 0;
const check = (label, condition, detail = "") => {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
};

function throws(label, fn, type) {
  try {
    fn();
    check(label, false, "did not throw");
    return null;
  } catch (error) {
    check(label, error instanceof type, `threw ${error?.constructor?.name}: ${error?.message?.slice(0, 90)}`);
    return error;
  }
}

async function throwsAsync(label, fn, type) {
  try {
    await fn();
    check(label, false, "did not throw");
    return null;
  } catch (error) {
    check(label, error instanceof type, `threw ${error?.constructor?.name}: ${error?.message?.slice(0, 90)}`);
    return error;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-12T22:20:00Z");
const READ_JUST_NOW = new Date("2026-08-12T22:19:30Z").toISOString();

const LOG_TYPE = {
  id: 404,
  name: "Merits",
  cat: "logtype",
  schoolId: 3,
  readAtIso: "2026-08-12T20:00:00Z",
};

/**
 * GEN as a district would return it. Subtype and Consequence are configured
 * menu fields, not free strings, so the fixtures resolve them the same way the
 * log type is resolved.
 */
const GEN_ROWS = [
  { id: 404, name: "Merits", cat: "logtype", schoolid: 3 },
  { id: 461, name: "Contact", cat: "logtype", schoolid: 3 },
  { id: 7, name: "Suspend", cat: "consequence", value: "SUSP", schoolid: 3 },
  { id: 12, name: "Respect", cat: "subtype", value: "RESPECT", schoolid: 3 },
  { id: 13, name: "Effort", cat: "subtype", value: "EFFORT", schoolid: 3 },
  { id: 31, name: "None", cat: "consequence", value: "NONE", schoolid: 3 },
];

const SUBTYPE = resolveSubtype(GEN_ROWS, "Respect", LOG_TYPE.readAtIso, LOG_TYPE);
const CONSEQUENCE = resolveConsequence(GEN_ROWS, "None", LOG_TYPE.readAtIso, LOG_TYPE);

const INPUT = {
  appEntryId: "wh-000123",
  studentId: 4021,
  schoolId: 3,
  logType: LOG_TYPE,
  subject: "Positive behavior",
  entry: "Helped a classmate reset the lab bench without being asked.",
  author: "Wildcat Hub (app)",
  occurredAt: new Date("2026-08-12T22:15:00Z"),
  subtype: SUBTYPE,
  teacherId: 91,
};

/** A grant file that DOES permit the write. Used to test past gate 2. */
const OPEN_GRANT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<plugin name="fake" version="9.9.9">
  <access_request>
${LOG_WRITABLE_COLUMNS.map((c) => `    <field table="LOG" field="${c}" access="FullAccess"/>`).join("\n")}
  </access_request>
</plugin>`;
const OPEN_GRANT = parseAccessRequest(OPEN_GRANT_XML, "(fake open grant)");

const SANDBOX_CONFIG = {
  host: "wildcat-sandbox.powerschool.com",
  clientId: "fake-id",
  clientSecret: "fake-secret",
};
const PROD_CONFIG = { host: "lapf.powerschool.com", clientId: "fake-id", clientSecret: "fake-secret" };

const ARMED_ENV = { [WRITE_ENABLE_VAR]: WRITE_ENABLE_VALUE };

// Any client that is allowed to reach `send()` in this file is bound to a
// loopback base, because a grant override is honoured for a loopback target
// only. That is the point of section 24: against a real host the client reads
// the installed plugin.xml and nothing the test hands it can change that.
const LOOPBACK = "http://127.0.0.1:9999";

/**
 * The sibling access-request piece's PROPOSED grant, wherever it put it. It has
 * moved between powerschool/plugin/ and powerschool/ across rounds, so both are
 * checked rather than hardcoding one and silently skipping the cross-check.
 * Returns null when the sibling has produced nothing.
 */
function proposedGrantPath() {
  for (const candidate of ["../../plugin/plugin-v2.xml", "../../plugin-v2.xml"]) {
    const resolved = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(resolved)) return resolved;
  }
  return null;
}
const renderLoopback = (input = INPUT) =>
  renderCreate(SANDBOX_CONFIG.host, input, { grants: OPEN_GRANT, now: NOW, baseUrl: LOOPBACK });

/** A fetch that fails the test if it is ever called. */
function refusingFetch(label) {
  return async (url) => {
    throw new Error(`${label}: the client opened a socket to ${url}. It must not.`);
  };
}

/** A fetch that records and answers. Never touches a network. */
function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    return handler(String(url), init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

const tokenResponse = () =>
  new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

// ---------------------------------------------------------------------------

console.log("\n1. The real plugin grant blocks every write, read not attempted");
{
  const grants = loadAccessRequest();
  check("plugin.xml parses", grants.counts.total > 0, `${grants.counts.total}`);
  // The working tree carries 1.1.1, which adds Log and Gen at ViewOnly and
  // removes the two STUDENTS email columns PowerSchool rejected. It is
  // NOT installed on the instance yet: that needs an administrator. The version
  // pin below is what keeps those two facts from being confused.
  check("plugin version is 1.1.1", grants.pluginVersion === "1.1.1", String(grants.pluginVersion));
  check("121 fields declared", grants.counts.total === 121, String(grants.counts.total));
  check("every one of them is ViewOnly", grants.counts.viewOnly === 121, String(grants.counts.viewOnly));
  check("ZERO FullAccess grants exist", grants.counts.fullAccess === 0, String(grants.counts.fullAccess));
  check("18 tables declared", grants.counts.tables === 18, String(grants.counts.tables));

  const rows = checkWriteGrant(grants, "log", [...LOG_WRITABLE_COLUMNS]);
  // 1.1.0 grants six of these at ViewOnly. Read access is not write access, so
  // every one of them must still fail the write check. This is the assertion
  // that would catch somebody "fixing" a 403 by widening the wrong axis.
  check("no LOG column is granted at FullAccess", rows.every((r) => r.current !== "FullAccess"));
  check("some LOG columns are now readable", rows.some((r) => r.current === "ViewOnly"));
  check("every LOG column fails the write check", rows.every((r) => !r.ok));
  check(
    "the check names FullAccess as the requirement",
    rows.every((r) => r.required === "FullAccess"),
  );

  // A read-side column IS granted, which proves the parser is reading real data
  // rather than returning "not requested" for everything.
  const students = checkWriteGrant(grants, "students", ["STUDENT_NUMBER"]);
  check("students.STUDENT_NUMBER is granted ViewOnly", students[0].current === "ViewOnly", students[0].current);
  check("and still fails a write check", !students[0].ok);
}

console.log("\n2. The grant parser cannot be fooled");
{
  const commented = parseAccessRequest(`<plugin version="1.0.0"><access_request>
    <!-- <field table="LOG" field="Entry" access="FullAccess"/> -->
    <field table="LOG" field="Subject" access="ViewOnly"/>
  </access_request></plugin>`);
  check("a commented-out field is not a grant", !commented.fields.has("log.entry"));
  check("the live field beside it still parses", commented.fields.get("log.subject") === "ViewOnly");
  check("counts reflect only real fields", commented.counts.total === 1, String(commented.counts.total));

  const outside = parseAccessRequest(`<plugin version="1"><field table="LOG" field="Entry" access="FullAccess"/>
    <access_request><field table="LOG" field="Subject" access="ViewOnly"/></access_request></plugin>`);
  check("a field outside access_request is not a grant", !outside.fields.has("log.entry"));

  const junk = parseAccessRequest(`<plugin version="1"><access_request>
    <field table="LOG" field="Entry" access="Full"/>
    <field table="LOG" field="Subject"/>
  </access_request></plugin>`);
  check("an unrecognised access value degrades to ViewOnly", junk.fields.get("log.entry") === "ViewOnly");
  check("a missing access attribute degrades to ViewOnly", junk.fields.get("log.subject") === "ViewOnly");

  check("lookup is case insensitive", OPEN_GRANT.fields.get("log.studentid") === "FullAccess");
  check("the fake open grant really is open", OPEN_GRANT.counts.fullAccess === LOG_WRITABLE_COLUMNS.length);
}

console.log("\n3. Arming: the default is refuse");
{
  check("empty environment is disarmed", armingState({}).armed === false);
  check("empty string is disarmed", armingState({ [WRITE_ENABLE_VAR]: "" }).armed === false);
  check("'1' is disarmed", armingState({ [WRITE_ENABLE_VAR]: "1" }).armed === false);
  check("'true' is disarmed", armingState({ [WRITE_ENABLE_VAR]: "true" }).armed === false);
  check("'yes' is disarmed", armingState({ [WRITE_ENABLE_VAR]: "yes" }).armed === false);
  check("'YES' is disarmed", armingState({ [WRITE_ENABLE_VAR]: "YES" }).armed === false);
  check("a near miss is disarmed", armingState({ [WRITE_ENABLE_VAR]: "enable-powerschool-write" }).armed === false);
  check("the exact literal arms", armingState(ARMED_ENV).armed === true);
  check("surrounding whitespace still arms", armingState({ [WRITE_ENABLE_VAR]: ` ${WRITE_ENABLE_VALUE} ` }).armed === true);
  check("the real process env is disarmed right now", armingState(process.env).armed === false);
}

console.log("\n4. Disarmed: renders fine, sends nothing");
{
  const client = new PowerSchoolWriteClient({
    config: SANDBOX_CONFIG,
    grants: OPEN_GRANT,
    env: {},
    fetchImpl: refusingFetch("disarmed create"),
    log: () => {},
  });
  const request = renderCreate(SANDBOX_CONFIG.host, INPUT, { grants: OPEN_GRANT, now: NOW });
  check("rendering works while disarmed", request.method === "POST");
  check("the rendered URL is the table endpoint", request.url.endsWith("/ws/schema/table/log"));
  check("the rendered Authorization header is redacted", request.headers.Authorization === "Bearer [redacted]");
  check("the rendered body carries no secret", !JSON.stringify(request).includes("fake-secret"));

  const report = client.preflight(request);
  check("preflight reports not ok", report.ok === false);
  check("preflight names arming as a block", report.blocks.some((b) => b.startsWith("arming:")));
  // The open grant is an override and the target is not loopback, so it is
  // ignored and the installed plugin.xml decides. Three blocks, not one.
  check("the injected open grant is reported as ignored", report.blocks.some((b) => b.startsWith("grant-override:")));
  check("and the installed plugin still blocks the columns", report.blocks.some((b) => b.startsWith("grant:")));
  // Four now, not three: the working tree at 1.1.0 has moved ahead of the 1.0.6
  // recorded as installed, so the version pin fires as well.
  check("exactly those four blocks", report.blocks.length === 4, report.blocks.join(" | "));
  check(
    "the grant block cites the installed plugin, not the override",
    report.blocks.find((b) => b.startsWith("grant:"))?.includes(INSTALLED_PLUGIN_XML) === true,
    report.blocks.find((b) => b.startsWith("grant:")),
  );

  // Against a real host the grant-source refusal outranks arming, so this is
  // the error a caller sees. The arming block is still in the report above.
  await throwsAsync("send() throws GrantMissing on a real host", () => client.send(request), GrantMissing);
  check("no request was recorded", client.sent.length === 0);

  // Isolate the arming gate: loopback target, so gate 2 is satisfied by the
  // injected grant and arming is the only thing left standing.
  const local = new PowerSchoolWriteClient({
    config: SANDBOX_CONFIG,
    grants: OPEN_GRANT,
    env: {},
    loopbackBaseUrl: LOOPBACK,
    fetchImpl: refusingFetch("disarmed loopback"),
    log: () => {},
  });
  const localRequest = renderLoopback();
  const localReport = local.preflight(localRequest);
  check("on loopback, arming is the only block left", localReport.blocks.length === 1 && localReport.blocks[0].startsWith("arming:"), localReport.blocks.join(" | "));
  await throwsAsync("send() throws WriteDisarmed", () => local.send(localRequest), WriteDisarmed);
  check("still nothing sent", local.sent.length === 0);
}

console.log("\n5. Armed but ungranted: still refuses, still local");
{
  const client = new PowerSchoolWriteClient({
    config: SANDBOX_CONFIG,
    env: ARMED_ENV, // armed
    fetchImpl: refusingFetch("armed but ungranted"),
    log: () => {},
    // no grants override, so the REAL plugin.xml decides
  });
  const request = renderCreate(SANDBOX_CONFIG.host, INPUT, { now: NOW });
  const error = await throwsAsync("send() throws GrantMissing", () => client.send(request), GrantMissing);
  check("the error names the blocked columns", String(error?.message).includes("log.Entry"), "");
  check("the error says nothing was sent", String(error?.message).includes("Nothing was sent"));
  check("no request was recorded", client.sent.length === 0);
}

console.log("\n6. The production host gate, and what opening it does NOT do");
{
  // A reviewer found gate 3 was DEAD CODE in both directions: on a real host
  // the grant block outranked it in the refusal precedence, and on a loopback
  // bound client hostBlock() returned null before it could run. `throw new
  // ProductionHostBlocked` could not fire under any reachable configuration.
  // Gate 3 now sits in tier 2 of the precedence, above arming and above the
  // grant, so the most alarming true statement is the one a human reads first.
  const client = new PowerSchoolWriteClient({
    config: PROD_CONFIG,
    grants: OPEN_GRANT,
    env: ARMED_ENV,
    fetchImpl: refusingFetch("production host"),
    log: () => {},
  });
  const request = renderCreate(PROD_CONFIG.host, INPUT, { grants: OPEN_GRANT, now: NOW });
  const before = client.preflight(request);
  check("the production host is named as a block", before.blocks.some((b) => b.startsWith("host:")));
  check("so is the ignored grant override", before.blocks.some((b) => b.startsWith("grant-override:")));

  // GATE 3 FIRES. Not "is exported", not "would fire one day": thrown, here,
  // by send(), with the grant gate also shut behind it.
  const hostError = await throwsAsync(
    "send() throws ProductionHostBlocked, so gate 3 is reachable",
    () => client.send(request),
    ProductionHostBlocked,
  );
  check("the refusal names the production host", String(hostError?.message).includes("lapf.powerschool.com"));
  check("and names the variable that would open it", String(hostError?.message).includes(WRITE_PRODUCTION_HOST_VAR));
  check("nothing was sent while gate 3 refused", client.sent.length === 0);

  // And it outranks arming: a disarmed client pointed at production reports the
  // host first, because "you are aimed at the SIS" beats "you forgot a flag".
  const disarmedAtProd = new PowerSchoolWriteClient({
    config: PROD_CONFIG,
    grants: OPEN_GRANT,
    env: {},
    fetchImpl: refusingFetch("disarmed at production"),
    log: () => {},
  });
  await throwsAsync(
    "a disarmed client aimed at production reports the host, not the arming",
    () => disarmedAtProd.send(request),
    ProductionHostBlocked,
  );

  const allowed = new PowerSchoolWriteClient({
    config: PROD_CONFIG,
    grants: OPEN_GRANT,
    env: { ...ARMED_ENV, [WRITE_PRODUCTION_HOST_VAR]: "yes" },
    fetchImpl: refusingFetch("production host, allowed"),
    log: () => {},
  });
  const after = allowed.preflight(request);
  check("the environment variable removes the host block", !after.blocks.some((b) => b.startsWith("host:")));
  check("and removes nothing else", after.blocks.some((b) => b.startsWith("grant:")) && after.blocks.some((b) => b.startsWith("grant-override:")));
  check("so environment variables alone never open the path", after.ok === false, after.blocks.join(" | "));
  await throwsAsync("send() refuses on the grant, not on the host", () => allowed.send(request), GrantMissing);
  check("nothing was sent", allowed.sent.length === 0);
}

console.log("\n7. Verb and table allowlists");
{
  check("only POST and PUT are writable verbs", ALLOWED_WRITE_VERBS.join(",") === "POST,PUT");
  check("exactly one writable table", WRITABLE_TABLES.length === 1 && WRITABLE_TABLES[0] === "log");

  const client = new PowerSchoolWriteClient({
    config: SANDBOX_CONFIG,
    grants: OPEN_GRANT,
    env: ARMED_ENV,
    fetchImpl: refusingFetch("verb/table allowlist"),
    log: () => {},
  });

  const base = renderCreate(SANDBOX_CONFIG.host, INPUT, { grants: OPEN_GRANT, now: NOW });

  const del = { ...base, method: "DELETE", url: `https://${SANDBOX_CONFIG.host}/ws/schema/table/log/998877` };
  await throwsAsync("a hand-built DELETE is refused even fully armed", () => client.send(del), ForbiddenTarget);

  const patch = { ...base, method: "PATCH" };
  await throwsAsync("a hand-built PATCH is refused", () => client.send(patch), ForbiddenTarget);

  for (const table of ["students", "cc", "sections", "u_wildcatcash", "u_studentsuserfields", "pgfinalgrades"]) {
    const hijacked = {
      ...base,
      table,
      url: `https://${SANDBOX_CONFIG.host}/ws/schema/table/${table}`,
      columns: ["Entry"],
    };
    // eslint-disable-next-line no-await-in-loop
    await throwsAsync(`table ${table} is refused`, () => client.send(hijacked), ForbiddenTarget);
  }

  const offBase = { ...base, url: "https://evil.example.test/ws/schema/table/log" };
  await throwsAsync("a URL outside the client base is refused", () => client.send(offBase), ForbiddenTarget);
  check("still nothing sent", client.sent.length === 0);
}

console.log("\n8. Column allowlist: behavior notes yes, discipline records never");
{
  check(
    "no Discipline_ column is on the write allowlist",
    LOG_WRITABLE_COLUMNS.every((c) => !c.toLowerCase().startsWith("discipline_")),
  );
  check("DCID is not writable", !LOG_WRITABLE_COLUMNS.includes("DCID"));
  check("ID is not writable", !LOG_WRITABLE_COLUMNS.includes("ID"));

  // Two separate guarantees, asserted separately.
  // (a) The column guard rejects a discipline column outright.
  for (const bad of ["Discipline_ActionTaken", "Discipline_IncidentDate", "Discipline_PoliceInvolvedFlag"]) {
    const error = throws(`${bad} is rejected by the column guard`, () => assertWritableColumns(["Entry", bad]), ForbiddenTarget);
    check(`and the refusal names ${bad}`, String(error?.message).includes(bad));
  }
  let disciplineReason = "";
  try {
    assertWritableColumns(["Discipline_ActionTaken"]);
  } catch (error) {
    disciplineReason = String(error.message);
  }
  check("the refusal explains the discipline reasoning", disciplineReason.includes("never discipline records"));
  // (b) buildLogRow reads only known keys, so an unknown key on the input can
  //     never reach the wire in the first place.
  const row = buildLogRow({ ...INPUT, Discipline_ActionTaken: "S", wildcatCashBalance: 1250 }, { now: NOW });
  check("an unknown input key never reaches the row", !("Discipline_ActionTaken" in row));
  check("an earned-value key never reaches the row", !("wildcatCashBalance" in row));
  check("the row only contains allowlisted columns", Object.keys(row).every((k) => LOG_WRITABLE_COLUMNS.includes(k)));

  for (const bad of ["students", "cc", "sections", "u_wildcatcash", "pgfinalgrades", "u_studentsuserfields"]) {
    throws(`the table guard refuses ${bad}`, () => assertWritableTable(bad), ForbiddenTarget);
  }
  check("the table guard permits log", assertWritableTable("LOG") === undefined);
}

console.log("\n9. Earned value never crosses into the SIS");
{
  check("no amount parameter exists on the input type", !("amount" in INPUT) && !("points" in INPUT));

  const blocked = [
    "Deducted 100 Wildcat Cash for defiance",
    "Awarded 25 points",
    "Balance is now 1,250",
    "Gave 3 tickets",
    "Charged $12 for the shirt",
    "wildcat cash: 40",
    "Lost 50 wildcatcash",
  ];
  for (const text of blocked) {
    check(`text guard catches ${JSON.stringify(text)}`, findEarnedValueText(text) !== null);
    throws(
      `buildLogRow refuses entry ${JSON.stringify(text.slice(0, 24))}`,
      () => buildLogRow({ ...INPUT, entry: text }, { now: NOW }),
      PayloadRejected,
    );
  }

  // False positives matter too. A guard that refuses ordinary sentences gets
  // switched off by the first teacher who hits it.
  const allowed = [
    "Helped a classmate reset the lab bench without being asked.",
    "Reminded the class about the Wildcat Cash store rules.",
    "Left class during period three without a pass.",
    "Missed 2 appointments with the counselor.",
    "On time for all 5 classes today.",
    "Third referral this month.",
  ];
  for (const text of allowed) {
    check(`text guard permits ${JSON.stringify(text.slice(0, 34))}`, findEarnedValueText(text) === null, String(findEarnedValueText(text)));
    check(`and buildLogRow accepts it`, typeof buildLogRow({ ...INPUT, entry: text }, { now: NOW }).Entry === "string");
  }

  throws(
    "the subject is scanned too",
    () => buildLogRow({ ...INPUT, subject: "Deducted 100 points" }, { now: NOW }),
    PayloadRejected,
  );
}

console.log("\n10. Log type ids are resolved from GEN, never hardcoded");
{
  const gen = [
    { id: 404, name: "Merits", cat: "logtype", schoolid: 3 },
    { id: 461, name: "Contact", cat: "logtype", schoolid: 3 },
    { id: 7, name: "Suspend", cat: "consequence", schoolid: 3 },
  ];
  const resolved = resolveLogType(gen, "merits", NOW.toISOString());
  check("resolves by name, case insensitively", resolved.id === 404);
  check("carries the logtype category", resolved.cat === "logtype");
  check("carries the school scope", String(resolved.schoolId) === "3");

  throws("an unknown name throws", () => resolveLogType(gen, "Merit", NOW.toISOString()), PayloadRejected);
  throws(
    "a consequence row cannot masquerade as a log type",
    () => resolveLogType(gen, "Suspend", NOW.toISOString()),
    PayloadRejected,
  );
  throws(
    "an ambiguous name throws rather than picking one",
    () => resolveLogType([...gen, { id: 999, name: "Merits", cat: "logtype", schoolid: 4 }], "Merits", NOW.toISOString()),
    PayloadRejected,
  );

  throws(
    "a bare integer log type is refused",
    () => buildLogRow({ ...INPUT, logType: 404 }, { now: NOW }),
    PayloadRejected,
  );
  throws(
    "a log type from the wrong GEN category is refused",
    () => buildLogRow({ ...INPUT, logType: { ...LOG_TYPE, cat: "consequence" } }, { now: NOW }),
    PayloadRejected,
  );
  throws(
    "a stale log type read is refused",
    () => buildLogRow({ ...INPUT, logType: { ...LOG_TYPE, readAtIso: "2026-08-01T00:00:00Z" } }, { now: NOW }),
    PayloadRejected,
  );
  check(
    "a fresh log type read is accepted",
    buildLogRow({ ...INPUT, logType: { ...LOG_TYPE, readAtIso: "2026-08-12T18:00:00Z" } }, { now: NOW }).LogTypeID === 404,
  );
}

console.log("\n11. Column limits and required fields");
{
  check("the documented caps are the ones enforced", COLUMN_MAX_LENGTH.Subject === 40 && COLUMN_MAX_LENGTH.Entry_Author === 30);
  throws("an over-long subject is refused, not truncated", () => buildLogRow({ ...INPUT, subject: "x".repeat(41) }, { now: NOW }), PayloadRejected);
  check("a subject at the cap is accepted", buildLogRow({ ...INPUT, subject: "x".repeat(40) }, { now: NOW }).Subject.length === 40);
  throws("an over-long author is refused", () => buildLogRow({ ...INPUT, author: "x".repeat(31) }, { now: NOW }), PayloadRejected);
  const longSubtype = resolveSubtype(
    [{ id: 99, name: "Long", cat: "subtype", value: "x".repeat(21), schoolid: 3 }],
    "Long",
    LOG_TYPE.readAtIso,
    LOG_TYPE,
  );
  throws("an over-long subtype is refused", () => buildLogRow({ ...INPUT, subtype: longSubtype }, { now: NOW }), PayloadRejected);
  const longConsequence = resolveConsequence(
    [{ id: 98, name: "Long", cat: "consequence", value: "y".repeat(21), schoolid: 3 }],
    "Long",
    LOG_TYPE.readAtIso,
    LOG_TYPE,
  );
  throws("an over-long consequence is refused", () => buildLogRow({ ...INPUT, consequence: longConsequence }, { now: NOW }), PayloadRejected);
  throws("an empty entry is refused", () => buildLogRow({ ...INPUT, entry: "   " }, { now: NOW }), PayloadRejected);
  throws("a zero studentId is refused", () => buildLogRow({ ...INPUT, studentId: 0 }, { now: NOW }), PayloadRejected);
  throws("a negative studentId is refused", () => buildLogRow({ ...INPUT, studentId: -4021 }, { now: NOW }), PayloadRejected);
  throws("a non-integer studentId is refused", () => buildLogRow({ ...INPUT, studentId: "4021abc" }, { now: NOW }), PayloadRejected);
  throws("an unparseable occurredAt is refused", () => buildLogRow({ ...INPUT, occurredAt: "not a date" }, { now: NOW }), PayloadRejected);
  check("optional columns are omitted, not blanked", buildLogRow({ ...INPUT, subtype: undefined, consequence: undefined, teacherId: undefined }, { now: NOW }).Subtype === undefined);
}

console.log("\n12. Provenance markers");
{
  check("marker shape", provenanceMarker("wh-000123") === "[wildcat-hub:wh-000123]");
  throws("a marker id with a bracket is refused", () => provenanceMarker("wh]x[wildcat-hub:other"), PayloadRejected);
  throws("a marker id with a space is refused", () => provenanceMarker("wh 000123"), PayloadRejected);
  check("round trips out of entry text", findProvenanceId("blah\n[wildcat-hub:wh-000123]") === "wh-000123");
  check("absent marker reads as null", findProvenanceId("no marker here") === null);

  const row = buildLogRow(INPUT, { now: NOW });
  check("the row's entry carries exactly one marker", (row.Entry.match(/\[wildcat-hub:/g) ?? []).length === 1);
  check("the behavior text survives ahead of it", row.Entry.startsWith(INPUT.entry));
  throws(
    "a caller cannot smuggle a second marker in",
    () => buildLogRow({ ...INPUT, entry: "text [wildcat-hub:someone-else]" }, { now: NOW }),
    PayloadRejected,
  );
}

console.log("\n13. Entry_Date is the school's date, not UTC's");
{
  // 22:15Z on the 12th is 15:15 on the 12th in Los Angeles.
  check("afternoon PT", formatEntryDate(new Date("2026-08-12T22:15:00Z")) === "2026-08-12");
  // 03:30Z on the 13th is 20:30 on the 12th in Los Angeles. A UTC format here
  // would file an after-school entry on the wrong day.
  check("evening PT lands on the previous UTC day", formatEntryDate(new Date("2026-08-13T03:30:00Z")) === "2026-08-12");
  check("and its time", formatEntryTime(new Date("2026-08-13T03:30:00Z")) === "20:30:00");
  // Midnight must be 00:00:00, not 24:00:00.
  check("PT midnight formats as 00:00:00", formatEntryTime(new Date("2026-08-13T07:00:00Z")) === "00:00:00");
  check("winter, standard time", formatEntryDate(new Date("2026-01-15T04:30:00Z")) === "2026-01-14");
  check("an explicit zone is honoured", formatEntryDate(new Date("2026-08-13T03:30:00Z"), "UTC") === "2026-08-13");

  const row = buildLogRow({ ...INPUT, occurredAt: new Date("2026-08-13T03:30:00Z") }, { now: NOW });
  check("buildLogRow uses the school zone", row.Entry_Date === "2026-08-12" && row.Entry_Time === "20:30:00");
}

console.log("\n14. The conflict rule: a human edit in PowerSchool always wins");
{
  const row = buildLogRow(INPUT, { now: NOW });
  const watermark = makeWatermark("998877", row, INPUT.appEntryId, NOW);
  const remoteAsWritten = { DCID: "998877", ...row, Discipline_ActionTaken: "" };

  const clean = planUpdate({
    host: SANDBOX_CONFIG.host,
    watermark,
    remote: { readAtIso: READ_JUST_NOW, projection: "*", row: remoteAsWritten },
    desired: { ...INPUT, entry: `${INPUT.entry} Parent contacted.` },
    now: NOW,
    render: { grants: OPEN_GRANT },
  });
  check("an untouched row is safe to update", clean.action === "write", JSON.stringify(clean).slice(0, 120));
  check("the update is a PUT to the row's DCID", clean.action === "write" && clean.request.url.endsWith("/log/998877"));

  const identical = planUpdate({
    host: SANDBOX_CONFIG.host,
    watermark,
    remote: { readAtIso: READ_JUST_NOW, projection: "*", row: remoteAsWritten },
    desired: INPUT,
    now: NOW,
    render: { grants: OPEN_GRANT },
  });
  check("no change means no write", identical.action === "noop", identical.action);

  // THE case this rule exists for.
  const edited = { ...remoteAsWritten, Subject: "Reviewed with dean", Consequence: "DETENTION" };
  const conflict = planUpdate({
    host: SANDBOX_CONFIG.host,
    watermark,
    remote: { readAtIso: READ_JUST_NOW, projection: "*", row: edited },
    desired: { ...INPUT, entry: `${INPUT.entry} Parent contacted.` },
    now: NOW,
    render: { grants: OPEN_GRANT },
  });
  check("a row edited in PowerSchool is a conflict, not a write", conflict.action === "conflict", conflict.action);
  check("the conflict names Subject", conflict.action === "conflict" && conflict.changedColumns.includes("Subject"));
  check("the conflict names Consequence", conflict.action === "conflict" && conflict.changedColumns.includes("Consequence"));
  check(
    "the conflict says an overwrite would discard the edit",
    conflict.action === "conflict" && conflict.reason.includes("discard"),
  );

  const promoted = planUpdate({
    host: SANDBOX_CONFIG.host,
    watermark,
    remote: { readAtIso: READ_JUST_NOW, projection: "*", row: { ...remoteAsWritten, Discipline_ActionTaken: "S" } },
    desired: INPUT,
    now: NOW,
    render: { grants: OPEN_GRANT },
  });
  check("a row promoted to a discipline record is untouchable", promoted.action === "conflict", promoted.action);
  check(
    "and the reason says why",
    promoted.action === "conflict" && promoted.reason.includes("discipline record"),
  );

  const gone = planUpdate({
    host: SANDBOX_CONFIG.host,
    watermark,
    remote: { readAtIso: READ_JUST_NOW, projection: "*", row: null },
    desired: INPUT,
    now: NOW,
    render: { grants: OPEN_GRANT },
  });
  check("a deleted row is not recreated", gone.action === "abort", gone.action);

  const stale = planUpdate({
    host: SANDBOX_CONFIG.host,
    watermark,
    remote: { readAtIso: "2026-08-12T20:00:00Z", projection: "*", row: remoteAsWritten },
    desired: INPUT,
    now: NOW,
    render: { grants: OPEN_GRANT },
  });
  check("a stale read cannot authorise a write", stale.action === "abort", stale.action);
  check("and it says to re-read", stale.action === "abort" && stale.reason.includes("Re-read"));

  const future = planUpdate({
    host: SANDBOX_CONFIG.host,
    watermark,
    remote: { readAtIso: "2027-01-01T00:00:00Z", projection: "*", row: remoteAsWritten },
    desired: INPUT,
    now: NOW,
    render: { grants: OPEN_GRANT },
  });
  check("a read timestamped in the future is refused", future.action === "abort", future.action);

  const otherRow = planUpdate({
    host: SANDBOX_CONFIG.host,
    watermark,
    remote: { readAtIso: READ_JUST_NOW, projection: "*", row: { ...remoteAsWritten, Entry: "someone else's note entirely" } },
    desired: INPUT,
    now: NOW,
    render: { grants: OPEN_GRANT },
  });
  check("a row with the wrong provenance is a conflict", otherRow.action === "conflict", otherRow.action);

  const tampered = planUpdate({
    host: SANDBOX_CONFIG.host,
    watermark: { ...watermark, columns: { ...watermark.columns, Subject: "Rewritten" } },
    remote: { readAtIso: READ_JUST_NOW, projection: "*", row: remoteAsWritten },
    desired: INPUT,
    now: NOW,
    render: { grants: OPEN_GRANT },
  });
  check("a watermark whose fingerprint no longer matches is refused", tampered.action === "abort", tampered.action);

  check("the four plan actions are the only outcomes", ["write", "noop", "conflict", "abort"].includes(clean.action));

  // A narrow read-back would find no Discipline_* column and no provenance
  // marker, and would sail through steps 3 and 4 having proven nothing.
  for (const projection of ["Subject,Entry", "", "Entry"]) {
    const partial = planUpdate({
      host: SANDBOX_CONFIG.host,
      watermark,
      remote: { readAtIso: READ_JUST_NOW, projection, row: remoteAsWritten },
      desired: INPUT,
      now: NOW,
      render: { grants: OPEN_GRANT },
    });
    check(`a read projected as ${JSON.stringify(projection)} cannot authorise a write`, partial.action === "abort", partial.action);
  }
  const partialCreate = planCreate({
    host: SANDBOX_CONFIG.host,
    desired: INPUT,
    existing: [{ readAtIso: READ_JUST_NOW, projection: "DCID", row: { DCID: "5" } }],
    existingReadAtIso: READ_JUST_NOW,
    now: NOW,
    render: { grants: OPEN_GRANT },
  });
  check("a projected duplicate check aborts rather than duplicating", partialCreate.action === "abort", partialCreate.action);
}

console.log("\n15. Fingerprints ignore columns the app never writes");
{
  const row = buildLogRow(INPUT, { now: NOW });
  const base = fingerprintRow(row);
  check("adding an untouched server column does not change it", fingerprintRow({ ...row, DCID: "998877", ID: 7 }) === base);
  check("case of the column name does not change it", fingerprintRow({ studentid: row.StudentID, ...lowercased(row) }) === base);
  check("number vs string does not change it", fingerprintRow({ ...row, StudentID: "4021" }) === base);
  check("a real content change does change it", fingerprintRow({ ...row, Subject: "Different" }) !== base);
  check("an empty value is treated as absent", fingerprintRow({ ...row, Consequence: "" }) === base);
  check(
    "discipline columns are detected separately",
    disciplineColumnsPresent({ ...row, Discipline_ActionTaken: "S", Discipline_ActionDate: "" }).join() === "Discipline_ActionTaken",
  );
}

function lowercased(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) out[key.toLowerCase()] = value;
  return out;
}

console.log("\n16. Create is made idempotent by hand, since the endpoint offers nothing");
{
  const row = buildLogRow(INPUT, { now: NOW });

  const fresh = planCreate({
    host: SANDBOX_CONFIG.host,
    desired: INPUT,
    existing: [{ readAtIso: READ_JUST_NOW, projection: "*", row: { DCID: "1", Entry: "unrelated note" } }],
    existingReadAtIso: READ_JUST_NOW,
    now: NOW,
    render: { grants: OPEN_GRANT },
  });
  check("a new entry is a write", fresh.action === "write", fresh.action);

  const already = planCreate({
    host: SANDBOX_CONFIG.host,
    desired: INPUT,
    existing: [{ readAtIso: READ_JUST_NOW, projection: "*", row: { DCID: "998877", Entry: row.Entry } }],
    existingReadAtIso: READ_JUST_NOW,
    now: NOW,
    render: { grants: OPEN_GRANT },
  });
  check("a retry after a lost response does not duplicate", already.action === "noop", already.action);
  check("and it returns the existing DCID", already.action === "noop" && already.existingDcid === "998877");

  const staleCheck = planCreate({
    host: SANDBOX_CONFIG.host,
    desired: INPUT,
    existing: [],
    existingReadAtIso: "2026-08-12T18:00:00Z",
    now: NOW,
    render: { grants: OPEN_GRANT },
  });
  check("a stale duplicate check aborts rather than duplicating", staleCheck.action === "abort", staleCheck.action);
}

console.log("\n17. Retraction is an edit, never a delete");
{
  const retract = renderRetract(SANDBOX_CONFIG.host, "998877", INPUT, "Logged against the wrong student", {
    grants: OPEN_GRANT,
    now: NOW,
  });
  check("retraction is a PUT", retract.method === "PUT");
  const entry = retract.body.tables.log.Entry;
  check("the original text survives", entry.startsWith(INPUT.entry));
  check("the retraction is dated and attributed", entry.includes("RETRACTED 2026-08-12") && entry.includes("Wildcat Hub (app)"));
  check("the reason is recorded", entry.includes("wrong student"));
  check("provenance survives", findProvenanceId(entry) === INPUT.appEntryId);
  check("no DELETE is produced anywhere", retract.method !== "DELETE");
}

console.log("\n18. Wire format, against a real local HTTP fake");
{
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === "/oauth/access_token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "998877" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const store = new MemoryWatermarkStore();
  const client = new PowerSchoolWriteClient({
    config: SANDBOX_CONFIG,
    grants: OPEN_GRANT,
    env: ARMED_ENV,
    loopbackBaseUrl: baseUrl,
    watermarkStore: store,
    log: () => {},
  });

  const created = await client.createBehaviorEntry({
    desired: INPUT,
    existing: [],
    existingReadAtIso: READ_JUST_NOW,
    now: NOW,
  });

  check("the create landed", created.plan.action === "write" && created.result.status === 200);
  check("two requests total: token then write", received.length === 2, String(received.length));

  const token = received[0];
  check("the token request is a POST to /oauth/access_token", token.method === "POST" && token.url === "/oauth/access_token");
  check("it uses HTTP Basic", String(token.headers.authorization).startsWith("Basic "));
  check("its body is the client credentials grant", token.body === "grant_type=client_credentials");

  const write = received[1];
  check("the write is a POST", write.method === "POST");
  check("to /ws/schema/table/log", write.url === "/ws/schema/table/log");
  check("bearing the token", write.headers.authorization === "Bearer fake-token");
  check("declaring JSON", write.headers["content-type"] === "application/json");

  const parsed = JSON.parse(write.body);
  check("the body wraps columns under tables.log", typeof parsed.tables?.log === "object");
  check("a create carries no id key", parsed.id === undefined);
  check("StudentID is on the wire as a number", parsed.tables.log.StudentID === 4021);
  check("LogTypeID came from the GEN ref", parsed.tables.log.LogTypeID === 404);
  check("Entry_Date is the school-local date", parsed.tables.log.Entry_Date === "2026-08-12");
  check("the provenance marker is on the wire", findProvenanceId(parsed.tables.log.Entry) === "wh-000123");
  check("no column outside the allowlist is on the wire", Object.keys(parsed.tables.log).every((k) => LOG_WRITABLE_COLUMNS.includes(k)));
  check("the client secret is not in the write body", !write.body.includes("fake-secret"));

  check("a watermark came back", created.watermark !== null && created.watermark.logDcid === "998877");
  check("the watermark fingerprint matches what was sent", created.watermark.fingerprint === fingerprintRow(parsed.tables.log));

  // Now update through the same fake, with a read-back that matches.
  const update = await client.updateBehaviorEntry({
    watermark: created.watermark,
    remote: { readAtIso: READ_JUST_NOW, projection: "*", row: { DCID: "998877", ...parsed.tables.log } },
    desired: { ...INPUT, subject: "Positive behavior (2)" },
    now: NOW,
  });
  check("the update landed", update.plan.action === "write" && update.result.status === 200);
  const putBody = JSON.parse(received[2].body);
  check("the update is a PUT", received[2].method === "PUT");
  check("addressed by DCID in the path", received[2].url === "/ws/schema/table/log/998877");
  check("carrying id and name in the body", putBody.id === "998877" && putBody.name === "log");
  check("the token was reused, not refetched", received.length === 3, String(received.length));

  // And the conflict case reaches no socket at all.
  const before = received.length;
  const conflicted = await client.updateBehaviorEntry({
    watermark: created.watermark,
    remote: { readAtIso: READ_JUST_NOW, projection: "*", row: { DCID: "998877", ...parsed.tables.log, Subject: "A human changed this" } },
    desired: { ...INPUT, subject: "App wants this" },
    now: NOW,
  });
  check("a conflict returns without sending", conflicted.plan.action === "conflict" && received.length === before);

  await new Promise((resolve) => server.close(resolve));
}

console.log("\n19. A 405 is read as 'the table is not exposed', not as a permission problem");
{
  const client = new PowerSchoolWriteClient({
    config: SANDBOX_CONFIG,
    grants: OPEN_GRANT,
    env: ARMED_ENV,
    loopbackBaseUrl: LOOPBACK,
    fetchImpl: recordingFetch((url) =>
      url.endsWith("/oauth/access_token")
        ? tokenResponse()
        : new Response("GET, POST and PUT are not allowed on table", { status: 405 }),
    ),
    log: () => {},
  });
  const request = renderLoopback();
  const error = await throwsAsync("a 405 throws ForbiddenTarget", () => client.send(request), ForbiddenTarget);
  check("and explains no grant can fix it", String(error?.message).includes("no plugin"), "");
}

console.log("\n20. The ceiling stops a runaway loop");
{
  const client = new PowerSchoolWriteClient({
    config: SANDBOX_CONFIG,
    grants: OPEN_GRANT,
    env: { ...ARMED_ENV, PS_WRITE_CEILING: "2" },
    loopbackBaseUrl: LOOPBACK,
    fetchImpl: recordingFetch((url) =>
      url.endsWith("/oauth/access_token") ? tokenResponse() : new Response(JSON.stringify({ id: "1" }), { status: 200 }),
    ),
    log: () => {},
  });
  check("the ceiling is read from the environment", client.writeCeiling === 2);
  const request = renderLoopback();
  await client.send(request);
  await client.send(request);
  await throwsAsync("the third write is refused", () => client.send(request), WriteCeilingReached);
  check("exactly two writes were recorded", client.sent.length === 2, String(client.sent.length));

  // The ceiling counts ATTEMPTS. A fetch that throws may still have landed at
  // PowerSchool, so it has to consume budget or a failing network becomes an
  // unbounded retry loop against a child's file.
  const flaky = new PowerSchoolWriteClient({
    config: SANDBOX_CONFIG,
    grants: OPEN_GRANT,
    env: { ...ARMED_ENV, PS_WRITE_CEILING: "2" },
    loopbackBaseUrl: LOOPBACK,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/oauth/access_token")) return tokenResponse();
      throw new Error("socket hang up");
    },
    log: () => {},
  });
  for (let i = 0; i < 2; i += 1) {
    try {
      await flaky.send(request);
    } catch {
      // the simulated network failure, not the assertion under test
    }
  }
  check("no response was ever recorded", flaky.sent.length === 0);
  await throwsAsync(
    "two failed attempts still exhaust the ceiling",
    () => flaky.send(request),
    WriteCeilingReached,
  );

  const defaulted = new PowerSchoolWriteClient({
    config: SANDBOX_CONFIG,
    grants: OPEN_GRANT,
    env: ARMED_ENV,
    fetchImpl: refusingFetch("ceiling default"),
    log: () => {},
  });
  check("the default ceiling applies when unset", defaulted.writeCeiling === DEFAULT_WRITE_CEILING);
  const negative = new PowerSchoolWriteClient({
    config: SANDBOX_CONFIG,
    grants: OPEN_GRANT,
    env: { ...ARMED_ENV, PS_WRITE_CEILING: "-5" },
    fetchImpl: refusingFetch("ceiling negative"),
    log: () => {},
  });
  check("a nonsense ceiling falls back to the default", negative.writeCeiling === DEFAULT_WRITE_CEILING);
}

console.log("\n21. The loopback escape hatch cannot address a real instance");
{
  for (const bad of [
    "https://lapf.powerschool.com",
    "http://127.0.0.1.evil.test",
    "http://localhost:8080",
    "http://10.0.0.1:80",
    "http://127.0.0.1:80/ws",
  ]) {
    throws(
      `loopbackBaseUrl ${JSON.stringify(bad)} is refused`,
      () =>
        new PowerSchoolWriteClient({
          config: SANDBOX_CONFIG,
          grants: OPEN_GRANT,
          env: ARMED_ENV,
          loopbackBaseUrl: bad,
          log: () => {},
        }),
      ForbiddenTarget,
    );
  }
  const ok = new PowerSchoolWriteClient({
    config: SANDBOX_CONFIG,
    grants: OPEN_GRANT,
    env: ARMED_ENV,
    loopbackBaseUrl: "http://127.0.0.1:9999",
    log: () => {},
  });
  check("a bare loopback base is accepted", ok.renderBaseUrl === "http://127.0.0.1:9999");
}

console.log("\n22. No secret is ever rendered or logged");
{
  const lines = [];
  const client = new PowerSchoolWriteClient({
    config: { host: SANDBOX_CONFIG.host, clientId: "id-abc123", clientSecret: "secret-xyz789" },
    grants: OPEN_GRANT,
    env: ARMED_ENV,
    loopbackBaseUrl: LOOPBACK,
    fetchImpl: recordingFetch((url) =>
      url.endsWith("/oauth/access_token") ? tokenResponse() : new Response(JSON.stringify({ id: "1" }), { status: 200 }),
    ),
    log: (line) => lines.push(line),
  });
  const request = renderLoopback();
  await client.send(request);
  const printed = lines.join("\n");
  check("the log line does not carry the secret", !printed.includes("secret-xyz789"));
  check("the log line does not carry the client id", !printed.includes("id-abc123"));
  check("the log line does not carry the bearer token", !printed.includes("fake-token"));
  check("the rendered request never carries a live token", JSON.stringify(request).includes("[redacted]"));
}

console.log("\n23. Cross-check against the proposed plugin v2, if a sibling piece produced one");
{
  // powerschool/plugin/plugin-v2.xml is NOT owned by this piece. It is the
  // access-request piece's proposed grant. If it exists, the two must agree:
  // a write client whose column allowlist is wider than the grant would 403 in
  // production, and one that is narrower means the grant asks for more than the
  // code will ever use. Skipped rather than failed when the file is absent, so
  // this suite does not break when a sibling renames its own artifact.
  const v2 = proposedGrantPath();
  if (v2 === null) {
    console.log("  SKIP  plugin-v2.xml not present, nothing to cross-check");
  } else {
    console.log(`  (found the sibling's proposal at ${v2})`);
    const grants = loadAccessRequest(v2);
    const rows = checkWriteGrant(grants, "log", [...LOG_WRITABLE_COLUMNS]);
    check("every column this client writes is FullAccess in the proposed v2", rows.every((r) => r.ok), rows.filter((r) => !r.ok).map((r) => r.field).join());
    check(
      "the proposed v2 grants no MORE FullAccess than this client uses",
      grants.counts.fullAccess === LOG_WRITABLE_COLUMNS.length,
      `${grants.counts.fullAccess} vs ${LOG_WRITABLE_COLUMNS.length}`,
    );
    const fullAccessOutsideLog = [...grants.fields.entries()].filter(
      ([key, level]) => level === "FullAccess" && !key.startsWith("log."),
    );
    check("no FullAccess grant exists outside the log table", fullAccessOutsideLog.length === 0, fullAccessOutsideLog.map(([k]) => k).join());
  }
}

console.log("\n24. REGRESSION: the grant check cannot be answered with a file of the caller's choosing");
{
  // A reviewer defeated the previous round exactly this way: point grantsPath
  // at powerschool/plugin/plugin-v2.xml, a proposed grant with 11 FullAccess
  // lines sitting in the working tree, set two environment variables, and
  // preflight against lapf.powerschool.com returned ok:true with an empty
  // block list. The client then opened a socket to /oauth/access_token and
  // only an injected throwing fetch stopped it. This section is that attack.
  const v2 = proposedGrantPath();
  const wideOpenEnv = {
    ...ARMED_ENV,
    [WRITE_PRODUCTION_HOST_VAR]: "yes",
    PS_WRITE_CEILING: "100",
  };

  if (v2 !== null) {
    throws(
      "grantsPath pointing at the real plugin-v2.xml is refused at construction",
      () =>
        new PowerSchoolWriteClient({
          config: PROD_CONFIG,
          grantsPath: v2,
          env: wideOpenEnv,
          fetchImpl: refusingFetch("v2 bypass"),
          log: () => {},
        }),
      ForbiddenTarget,
    );
    // And the file really would have opened it, so the refusal is load bearing
    // rather than a check against an already-closed door.
    const v2Grant = loadAccessRequest(v2);
    check("plugin-v2.xml really does grant FullAccess", v2Grant.counts.fullAccess > 0, String(v2Grant.counts.fullAccess));
    check("but it is not the installed plugin", v2Grant.source === "override");
  } else {
    console.log("  SKIP  plugin-v2.xml not present; the basename rule is still tested below");
  }

  for (const bad of ["/tmp/plugin-v2.xml", "/tmp/not-plugin.xml", "/tmp/plugin.xml.bak", "plugin.XML"]) {
    throws(
      `grantsPath ${JSON.stringify(bad)} is refused`,
      () =>
        new PowerSchoolWriteClient({
          config: PROD_CONFIG,
          grantsPath: bad,
          env: wideOpenEnv,
          fetchImpl: refusingFetch("basename"),
          log: () => {},
        }),
      ForbiddenTarget,
    );
  }

  // The obvious next move once the basename rule exists: copy the proposed
  // grant to a file that IS called plugin.xml and point at that. Refused by
  // path, not by name, so renaming buys nothing.
  {
    const dir = mkdtempSync(join(tmpdir(), "wildcat-fake-plugin-"));
    try {
      const decoy = join(dir, "plugin.xml");
      writeFileSync(
        decoy,
        `<plugin version="${INSTALLED_PLUGIN_VERSION}"><access_request>` +
          LOG_WRITABLE_COLUMNS.map((c) => `<field table="LOG" field="${c}" access="FullAccess"/>`).join("") +
          `</access_request></plugin>`,
        "utf8",
      );
      const decoyed = new PowerSchoolWriteClient({
        config: PROD_CONFIG,
        grantsPath: decoy,
        env: wideOpenEnv,
        fetchImpl: refusingFetch("renamed decoy"),
        log: () => {},
      });
      const decoyReport = decoyed.preflight(renderCreate(PROD_CONFIG.host, INPUT, { now: NOW }));
      check("a decoy named plugin.xml at another path is still refused", decoyReport.ok === false);
      check("and the refusal names the source, not the columns", decoyReport.blocks.some((b) => b.startsWith("grant-override:")), decoyReport.blocks.join(" | "));
      await throwsAsync("send() refuses the decoy", () => decoyed.send(renderCreate(PROD_CONFIG.host, INPUT, { now: NOW })), GrantMissing);
      check("no socket was opened for the decoy", decoyed.sent.length === 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // The second, independent stop: even an in-memory index that never touched
  // the filesystem cannot authorise a write to a real host.
  const smuggled = new PowerSchoolWriteClient({
    config: PROD_CONFIG,
    grants: OPEN_GRANT,
    env: wideOpenEnv,
    fetchImpl: refusingFetch("in-memory grant bypass"),
    log: () => {},
  });
  const request = renderCreate(PROD_CONFIG.host, INPUT, { grants: OPEN_GRANT, now: NOW });
  const report = smuggled.preflight(request);
  check("every externally settable gate is open", report.blocks.every((b) => !b.startsWith("arming:") && !b.startsWith("host:") && !b.startsWith("ceiling:")), report.blocks.join(" | "));
  check("and preflight is still not ok", report.ok === false);
  check("because the grant index was overridden", report.blocks.some((b) => b.startsWith("grant-override:")));
  check("and the installed plugin grants nothing", report.blocks.some((b) => b.startsWith("grant:")));
  await throwsAsync("send() refuses", () => smuggled.send(request), GrantMissing);
  check("no socket was opened", smuggled.sent.length === 0);

  // Third stop: the version pin. Even the installed file stops being evidence
  // if it has moved ahead of what a human recorded as enabled on the instance.
  const bumped = parseAccessRequest(
    `<plugin version="9.9.9"><access_request>${LOG_WRITABLE_COLUMNS.map((c) => `<field table="LOG" field="${c}" access="FullAccess"/>`).join("")}</access_request></plugin>`,
    INSTALLED_PLUGIN_XML,
  );
  const pinned = { ...bumped, source: "installed" };
  check("a version mismatch is refused even from the installed path", grantSourceProblems(pinned).some((p) => p.startsWith("grant-version:")), grantSourceProblems(pinned).join(" | "));
  // The pin currently FIRES, and that is correct. plugin.xml says 1.1.0; the
  // instance is still running 1.0.6 because no administrator has installed the
  // new zip. Until they do, the working tree is not evidence of what PowerSchool
  // granted, and the client refuses on exactly that basis.
  //
  // AFTER the administrator installs 1.1.1: set INSTALLED_PLUGIN_VERSION to
  // "1.1.1" in write-client.ts and flip these two assertions back to expecting
  // no problems. Do not do it before, and do not do it to make a test pass.
  check(
    "the pin fires, because 1.1.0 is not installed on the instance yet",
    grantSourceProblems(installedGrant()).some((p) => p.startsWith("grant-version:")),
    grantSourceProblems(installedGrant()).join(" | "),
  );
  check("the recorded installed version is still 1.0.6", INSTALLED_PLUGIN_VERSION === "1.0.6", INSTALLED_PLUGIN_VERSION);
  check("the working tree has moved ahead of it", installedGrant().pluginVersion === "1.1.1", String(installedGrant().pluginVersion));

  // And the loopback carve-out is genuinely narrow: an override is honoured
  // only for a target that cannot be a PowerSchool instance.
  const local = new PowerSchoolWriteClient({
    config: SANDBOX_CONFIG,
    grants: OPEN_GRANT,
    env: ARMED_ENV,
    loopbackBaseUrl: LOOPBACK,
    fetchImpl: refusingFetch("loopback preflight"),
    log: () => {},
  });
  check("the override IS honoured against a local fake", local.preflight(renderLoopback()).ok === true);
}

console.log("\n25. The watermark is stored, not assumed");
{
  const dir = mkdtempSync(join(tmpdir(), "wildcat-watermark-"));
  try {
    const path = join(dir, "nested", "watermarks.json");
    const store = new FileWatermarkStore(path);
    check("an empty store returns null", (await store.get("wh-nothing")) === null);

    const row = buildLogRow(INPUT, { now: NOW });
    await store.put(makeWatermark("998877", row, INPUT.appEntryId, NOW));

    // A DIFFERENT store object over the same file: this is the whole point.
    // The fingerprint has to survive the process that produced it or clause 3
    // degrades to an unconditional overwrite on the next run.
    const reopened = new FileWatermarkStore(path);
    const loaded = await reopened.get(INPUT.appEntryId);
    check("a watermark survives a new store over the same file", loaded !== null);
    check("and its fingerprint still matches the row", loaded.fingerprint === fingerprintRow(row));
    check("and it names the row", loaded.logDcid === "998877");

    // Clause 3 is disabled, not degraded, when there is nowhere to store it.
    const storeless = new PowerSchoolWriteClient({
      config: SANDBOX_CONFIG,
      grants: OPEN_GRANT,
      env: ARMED_ENV,
      loopbackBaseUrl: LOOPBACK,
      fetchImpl: refusingFetch("no store"),
      log: () => {},
    });
    await throwsAsync(
      "createBehaviorEntry refuses with no store",
      () => storeless.createBehaviorEntry({ desired: INPUT, existing: [], existingReadAtIso: READ_JUST_NOW, now: NOW }),
      PayloadRejected,
    );
    check("nothing was sent", storeless.sent.length === 0);

    // The end to end path a real caller uses: create persists, update reads back.
    const memory = new MemoryWatermarkStore();
    const client = new PowerSchoolWriteClient({
      config: SANDBOX_CONFIG,
      grants: OPEN_GRANT,
      env: ARMED_ENV,
      loopbackBaseUrl: LOOPBACK,
      watermarkStore: memory,
      fetchImpl: recordingFetch((url) =>
        url.endsWith("/oauth/access_token") ? tokenResponse() : new Response(JSON.stringify({ id: "998877" }), { status: 200 }),
      ),
      log: () => {},
    });
    const created = await client.createBehaviorEntry({
      desired: INPUT,
      existing: [],
      existingReadAtIso: READ_JUST_NOW,
      now: NOW,
    });
    check("the create landed", created.plan.action === "write");
    check("the watermark was persisted by the client itself", (await memory.get(INPUT.appEntryId))?.logDcid === "998877");

    const sentRow = created.plan.request.body.tables.log;
    const remoteAsWritten = { readAtIso: READ_JUST_NOW, projection: "*", row: { DCID: "998877", ...sentRow } };
    const updated = await client.updateBehaviorEntryByAppEntryId({
      appEntryId: INPUT.appEntryId,
      remote: remoteAsWritten,
      desired: { ...INPUT, entry: `${INPUT.entry} Parent contacted.` },
      now: NOW,
    });
    check("an update by app entry id finds its own watermark", updated.plan.action === "write", JSON.stringify(updated.plan).slice(0, 140));
    check("and the stored fingerprint advanced to what was just written", (await memory.get(INPUT.appEntryId)).fingerprint === updated.watermark.fingerprint);

    const unknown = await client.updateBehaviorEntryByAppEntryId({
      appEntryId: "wh-never-written",
      remote: remoteAsWritten,
      desired: INPUT,
      now: NOW,
    });
    check("an unknown app entry id aborts rather than overwriting", unknown.plan.action === "abort", JSON.stringify(unknown.plan).slice(0, 120));

    // A create whose DCID never came back records an unaddressable row rather
    // than nothing, and the next update refuses instead of guessing an id.
    const blindStore = new MemoryWatermarkStore();
    const blind = new PowerSchoolWriteClient({
      config: SANDBOX_CONFIG,
      grants: OPEN_GRANT,
      env: ARMED_ENV,
      loopbackBaseUrl: LOOPBACK,
      watermarkStore: blindStore,
      fetchImpl: recordingFetch((url) =>
        url.endsWith("/oauth/access_token") ? tokenResponse() : new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
      log: () => {},
    });
    const blindCreate = await blind.createBehaviorEntry({
      desired: INPUT,
      existing: [],
      existingReadAtIso: READ_JUST_NOW,
      now: NOW,
    });
    check("a create with no DCID back still records a watermark", blindCreate.watermark !== null && blindCreate.watermark.logDcid === null);
    const blindUpdate = await blind.updateBehaviorEntryByAppEntryId({
      appEntryId: INPUT.appEntryId,
      remote: remoteAsWritten,
      desired: INPUT,
      now: NOW,
    });
    check("and the update aborts rather than guessing an id", blindUpdate.plan.action === "abort" && blindUpdate.plan.reason.includes("no DCID"), JSON.stringify(blindUpdate.plan).slice(0, 140));
    check("with nothing further sent", blind.sent.length === 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n26. REGRESSION: the base URL check is an ORIGIN comparison, not a string prefix");
{
  // A reviewer defeated the previous round here. preflight() tested
  // `request.url.startsWith(this.baseUrl)`. On a client bound to
  // http://127.0.0.1 the URL http://127.0.0.1@lapf.powerschool.com/... passes
  // that test, because everything before the "@" is USERINFO and the host is
  // what follows it. Every other gate then agreed it was talking to a local
  // fake, because all of them derived "am I on loopback" from this.baseUrl:
  // hostBlock() returned null immediately and the grant override was honoured.
  // preflight returned ok:true with an EMPTY block list and the client handed
  // fetch() a POST addressed to the production SIS. Reproduced before fixing.
  //
  // Two independent defects, so two independent assertions below: the origin
  // must be compared parsed, AND every gate must judge the URL on the wire.

  check("parseTarget refuses a non-absolute URL", parseTarget("/ws/schema/table/log").ok === false);
  check(
    "parseTarget sees through userinfo",
    parseTarget("http://127.0.0.1@lapf.powerschool.com/x").hostname === "lapf.powerschool.com",
  );
  check(
    "and flags the credentials",
    parseTarget("http://127.0.0.1@lapf.powerschool.com/x").credentials === true,
  );
  check("a clean loopback URL carries no credentials", parseTarget(`${LOOPBACK}/x`).credentials === false);

  // ---- part A: the loopback bound client, the exact configuration section 24
  //      blesses with "the override IS honoured against a local fake".
  const handedToFetch = [];
  const recordAndRefuse = async (url, init = {}) => {
    handedToFetch.push(`${init.method ?? "GET"} ${String(url)}`);
    throw new Error(`the client opened a socket to ${url}. It must not.`);
  };

  const loopbackClient = () =>
    new PowerSchoolWriteClient({
      config: PROD_CONFIG, // configured for production, bound to a fake
      grants: OPEN_GRANT,
      env: { ...ARMED_ENV, PS_WRITE_CEILING: "100" },
      loopbackBaseUrl: LOOPBACK,
      fetchImpl: recordAndRefuse,
      log: () => {},
    });

  // The lie the reviewer used, plus the neighbours that share the base as a
  // string prefix without sharing its origin. None of these is caught by
  // startsWith; the suite's only previous off-base case, https://evil.example.test,
  // fails startsWith trivially and proved nothing about any of them.
  const prefixSharingLies = [
    `${LOOPBACK}@lapf.powerschool.com/ws/schema/table/log`,
    "http://127.0.0.1@lapf.powerschool.com/ws/schema/table/log",
    "http://127.0.0.1.lapf.powerschool.com/ws/schema/table/log",
    `${LOOPBACK}.evil.test/ws/schema/table/log`,
    // U+3002 IDEOGRAPHIC FULL STOP. new URL() normalises it to a real dot, so
    // the hostname is 127.0.0.1.lapf.powerschool.com. Written as an escape to
    // keep this file ASCII.
    "http://127.0.0.1\u3002lapf.powerschool.com/ws/schema/table/log",
    `${LOOPBACK}0/ws/schema/table/log`, // port 99990, a different origin
    "http://127.0.0.1:9999.evil/ws/schema/table/log", // does not parse at all
    "https://127.0.0.1:9999/ws/schema/table/log", // protocol differs
    "https://127.0.0.1/ws/schema/table/log", // protocol and port differ
    "http://127.0.0.1:9998/ws/schema/table/log", // port differs
    "http://127.0.0.1/ws/schema/table/log", // no port, base has one
    "http://127.0.0.2:9999/ws/schema/table/log", // hostname differs
  ];

  for (const url of prefixSharingLies) {
    const client = loopbackClient();
    const request = { ...renderLoopback(), url };
    const report = client.preflight(request);
    check(`refused: ${url}`, report.ok === false, report.blocks.join(" | "));
    check(`  and the reason names the target`, report.blocks.some((b) => b.startsWith("url:")), report.blocks.join(" | "));
    // eslint-disable-next-line no-await-in-loop
    await throwsAsync(`  send() throws ForbiddenTarget for ${url}`, () => client.send(request), ForbiddenTarget);
    check(`  nothing recorded as sent`, client.sent.length === 0);
  }

  check("fetch() was never called for any of them", handedToFetch.length === 0, handedToFetch.join(" | "));

  // The second defect, asserted on its own: every gate judged the wire URL, not
  // the base. If gates 2 and 3 still read this.baseUrl these two would be absent.
  {
    const client = loopbackClient();
    const request = { ...renderLoopback(), url: "http://127.0.0.1@lapf.powerschool.com/ws/schema/table/log" };
    const report = client.preflight(request);
    check(
      "gate 3 ran against the wire URL, not the loopback base",
      report.blocks.some((b) => b.startsWith("host:")),
      report.blocks.join(" | "),
    );
    check(
      "gate 2 consulted the installed plugin instead of honouring the override",
      report.blocks.some((b) => b.startsWith("grant-override:")) && report.blocks.some((b) => b.startsWith("grant:")),
      report.blocks.join(" | "),
    );
    check("five blocks, not zero", report.blocks.length === 5, String(report.blocks.length));
  }

  // ---- part B: the same trick on a production bound client. startsWith let
  //      this through too: "https://lapf.powerschool.com.evil.test/..."
  //      startsWith("https://lapf.powerschool.com") is true.
  {
    const prod = new PowerSchoolWriteClient({
      config: PROD_CONFIG,
      env: { ...ARMED_ENV, [WRITE_PRODUCTION_HOST_VAR]: "yes", PS_WRITE_CEILING: "100" },
      fetchImpl: refusingFetch("prod prefix lie"),
      log: () => {},
    });
    const base = renderCreate(PROD_CONFIG.host, INPUT, { now: NOW });
    for (const url of [
      "https://lapf.powerschool.com.evil.test/ws/schema/table/log",
      "https://lapf.powerschool.com@evil.test/ws/schema/table/log",
      "https://lapf.powerschool.com:8443/ws/schema/table/log",
      "http://lapf.powerschool.com/ws/schema/table/log",
    ]) {
      const report = prod.preflight({ ...base, url });
      check(`prod-bound client refuses ${url}`, report.blocks.some((b) => b.startsWith("url:")), report.blocks.join(" | "));
      // eslint-disable-next-line no-await-in-loop
      await throwsAsync(`  and send() throws`, () => prod.send({ ...base, url }), ForbiddenTarget);
    }
    check("the honest production URL clears the target gate", !prod.preflight(base).blocks.some((b) => b.startsWith("url:")));
    check("prod client sent nothing", prod.sent.length === 0);
  }

  // ---- part C: the path is pinned too, so a same-origin URL pointing at some
  //      other endpoint is not a write this client built.
  {
    const client = loopbackClient();
    const request = { ...renderLoopback(), url: `${LOOPBACK}/ws/v1/student/4021` };
    check("a same-origin non-table path is refused", client.preflight(request).blocks.some((b) => b.startsWith("url:")));
    check("the prefix is the table endpoint", WRITE_PATH_PREFIX === "/ws/schema/table/");
    await throwsAsync("send() refuses it", () => client.send(request), ForbiddenTarget);
  }

  // ---- part D: the honest loopback request still works, so the fix did not
  //      simply refuse everything.
  {
    const ok = new PowerSchoolWriteClient({
      config: SANDBOX_CONFIG,
      grants: OPEN_GRANT,
      env: ARMED_ENV,
      loopbackBaseUrl: LOOPBACK,
      fetchImpl: refusingFetch("honest loopback preflight"),
      log: () => {},
    });
    check("the honest loopback request still preflights ok", ok.preflight(renderLoopback()).ok === true, ok.preflight(renderLoopback()).blocks.join(" | "));
  }
}

console.log("\n26b. What preflight JUDGES is what the wire CARRIES");
{
  // send() takes a plain object, and this suite hand-builds them, so
  // request.table and request.columns are CLAIMS. Every gate above reads those
  // claims; the socket reads the URL and the body. Closing the gap found while
  // fixing the origin check: nothing else was proving the two agreed.
  const client = new PowerSchoolWriteClient({
    config: SANDBOX_CONFIG,
    grants: OPEN_GRANT,
    env: { ...ARMED_ENV, PS_WRITE_CEILING: "100" },
    loopbackBaseUrl: LOOPBACK,
    fetchImpl: refusingFetch("payload gate"),
    log: () => {},
  });
  const base = renderLoopback();

  // The attack this gate exists for: declare log/Entry, write students with a
  // discipline column. Every previous gate passes it.
  const smuggled = {
    ...base,
    body: { tables: { students: { Discipline_ActionTaken: "S", Last_Name: "Doe" } } },
  };
  const report = client.preflight(smuggled);
  check("a body writing another table is refused", report.blocks.some((b) => b.startsWith("body:")), report.blocks.join(" | "));
  await throwsAsync("send() throws ForbiddenTarget", () => client.send(smuggled), ForbiddenTarget);

  const extraColumn = {
    ...base,
    body: { tables: { log: { ...base.body.tables.log, Discipline_ActionTaken: "S" } } },
  };
  check(
    "a discipline column added to the body after rendering is refused",
    client.preflight(extraColumn).blocks.some((b) => b.startsWith("body:")),
    client.preflight(extraColumn).blocks.join(" | "),
  );
  await throwsAsync("and send() refuses it", () => client.send(extraColumn), ForbiddenTarget);

  const undeclared = { ...base, body: { tables: { log: { ...base.body.tables.log, TeacherID: 91, Consequence: "NONE" } } } };
  check(
    "a body column the grant check never saw is refused",
    client.preflight(undeclared).blocks.some((b) => b.startsWith("body:")),
  );

  const shrunk = { ...base, columns: [...base.columns, "Consequence"] };
  check(
    "a declared column absent from the body is refused",
    client.preflight(shrunk).blocks.some((b) => b.startsWith("body:")),
  );

  const pathLie = { ...base, url: `${LOOPBACK}/ws/schema/table/students` };
  check(
    "a URL naming a different table than the request declares is refused",
    client.preflight(pathLie).blocks.some((b) => b.startsWith("url:") || b.startsWith("body:") || b.startsWith("table:")),
  );

  for (const shape of [null, "a string", { tables: null }, { tables: {} }, { tables: { log: "not a map" } }, {}]) {
    check(
      `a malformed body ${JSON.stringify(shape)} is refused`,
      client.preflight({ ...base, body: shape }).blocks.some((b) => b.startsWith("body:")),
    );
  }

  check("the honest rendered request still passes the payload gate", client.preflight(base).ok === true, client.preflight(base).blocks.join(" | "));
  check("nothing was sent by any of it", client.sent.length === 0);

  // TIME OF CHECK / TIME OF USE. A RenderedRequest is a plain object, so its
  // url and body can be getters that answer one thing while the gates look and
  // another when fetch() looks. send() materialises the request once, before
  // any gate runs, and reads only that snapshot afterwards.
  const handed = [];
  const toctouClient = new PowerSchoolWriteClient({
    config: SANDBOX_CONFIG,
    grants: OPEN_GRANT,
    env: { ...ARMED_ENV, PS_WRITE_CEILING: "100" },
    loopbackBaseUrl: LOOPBACK,
    fetchImpl: async (url, init = {}) => {
      handed.push(`${init.method ?? "GET"} ${String(url)} ${String(init.body ?? "")}`);
      return String(url).endsWith("/oauth/access_token")
        ? tokenResponse()
        : new Response(JSON.stringify({ id: "1" }), { status: 200 });
    },
    log: () => {},
  });

  let urlReads = 0;
  const shifty = {
    ...base,
    get url() {
      urlReads += 1;
      // Honest on the first read, which is the one the gates would see if the
      // request were not snapshotted. Production on every read after that.
      return urlReads === 1 ? `${LOOPBACK}/ws/schema/table/log` : "https://lapf.powerschool.com/ws/schema/table/log";
    },
  };
  await toctouClient.send(shifty);
  const wireUrls = handed.filter((line) => !line.includes("/oauth/access_token")).map((line) => line.split(" ")[1]);
  check("the URL the gates checked is the URL fetch() received", wireUrls.every((u) => u.startsWith(LOOPBACK)), wireUrls.join(" | "));
  check("no request reached a powerschool.com host", handed.every((line) => !line.includes("powerschool.com")), handed.join(" | "));

  let bodyReads = 0;
  const shiftyBody = {
    ...base,
    url: `${LOOPBACK}/ws/schema/table/log`,
    get body() {
      bodyReads += 1;
      return bodyReads === 1
        ? { tables: { log: base.body.tables.log } }
        : { tables: { students: { Discipline_ActionTaken: "S" } } };
    },
  };
  const beforeBody = handed.length;
  await toctouClient.send(shiftyBody);
  const sentBody = handed[handed.length - 1];
  check("the body the payload gate checked is the body fetch() received", sentBody.includes('"log"') && !sentBody.includes("Discipline_ActionTaken"), sentBody.slice(0, 120));
  check("exactly one further request was made", handed.length === beforeBody + 1);
}

console.log("\n26c. A redirect is refused, not followed");
{
  // Every gate judged an origin. fetch() follows 3xx by DEFAULT, which would
  // carry this POST, its bearer token and its body to a host nothing checked,
  // and following a redirect on a POST can also replay a write.
  //
  // Two loopback servers, so the test discriminates rather than passing by
  // accident: A redirects to B, and B is a real listening server that RECORDS
  // what it receives and answers 200. If the client followed the redirect, B
  // would hold the write and the send would succeed. Both destinations are
  // 127.0.0.1, so a failure of this assertion still cannot reach a real host.
  const landed = [];
  const decoy = createServer((req, res) => {
    landed.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "998877" }));
  });
  await new Promise((resolve) => decoy.listen(0, "127.0.0.1", resolve));
  const decoyPort = decoy.address().port;

  const server = createServer((req, res) => {
    if (req.url === "/oauth/access_token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }));
      return;
    }
    res.writeHead(302, { Location: `http://127.0.0.1:${decoyPort}/ws/schema/table/log` });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  // The control: a bare fetch with the default redirect mode DOES follow it,
  // so the assertion below is testing the client's choice, not the platform's.
  const control = await fetch(`http://127.0.0.1:${port}/ws/schema/table/log`, { method: "POST", body: "{}" });
  check("control: default fetch follows the redirect to the decoy", control.status === 200 && landed.length === 1, `${control.status} / ${landed.length}`);

  const client = new PowerSchoolWriteClient({
    config: SANDBOX_CONFIG,
    grants: OPEN_GRANT,
    env: ARMED_ENV,
    loopbackBaseUrl: `http://127.0.0.1:${port}`,
    log: () => {},
  });
  const request = renderCreate(SANDBOX_CONFIG.host, INPUT, {
    grants: OPEN_GRANT,
    now: NOW,
    baseUrl: `http://127.0.0.1:${port}`,
  });
  const landedBefore = landed.length;
  let refused = null;
  try {
    await client.send(request);
  } catch (error) {
    refused = error;
  }
  check("the client rejects the 302 instead of following it", refused !== null, "the send succeeded");
  check("and names the redirect as the cause", String(refused?.cause?.message ?? refused?.message).includes("redirect"), String(refused?.cause?.message ?? refused?.message));
  check("the decoy received nothing from the client", landed.length === landedBefore, landed.join(" | "));
  check("and no response was recorded as sent", client.sent.length === 0);

  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => decoy.close(resolve));
}

console.log("\n27. Subtype and Consequence are resolved from GEN, like the log type");
{
  // The reviewer's other finding: LogTypeID got the full GEN treatment while
  // Subtype and Consequence were free strings capped at 20 characters, so the
  // client could file an entry under a classification this district never
  // configured. Both are documented as configured menu fields.
  check("a resolved subtype carries the wire value", SUBTYPE.value === "RESPECT");
  check("and records which GEN column supplied it", SUBTYPE.valueColumn === "value");
  check("and the category it came from", SUBTYPE.cat === "subtype");
  check("and the log type it hangs off", SUBTYPE.logTypeId === 404 && SUBTYPE.logTypeName === "Merits");
  check("a resolved consequence carries its own category", CONSEQUENCE.cat === "consequence" && CONSEQUENCE.value === "NONE");

  check("the row carries the resolved value", buildLogRow(INPUT, { now: NOW }).Subtype === "RESPECT");
  check(
    "and the consequence when one is given",
    buildLogRow({ ...INPUT, consequence: CONSEQUENCE }, { now: NOW }).Consequence === "NONE",
  );

  // Free strings, the thing that used to work.
  for (const bad of ["RESPECT", "respect", "anything at all", 12]) {
    const error = throws(
      `a free ${typeof bad} subtype ${JSON.stringify(bad)} is refused`,
      () => buildLogRow({ ...INPUT, subtype: bad }, { now: NOW }),
      PayloadRejected,
    );
    check("  and the refusal points at resolveSubtype", String(error?.message).includes("resolveSubtype"));
    throws(
      `a free consequence ${JSON.stringify(bad)} is refused`,
      () => buildLogRow({ ...INPUT, consequence: bad }, { now: NOW }),
      PayloadRejected,
    );
  }

  // Resolution refuses the same three ways resolveLogType does.
  throws("an unknown subtype name throws", () => resolveSubtype(GEN_ROWS, "Punctuality", NOW.toISOString(), LOG_TYPE), PayloadRejected);
  throws("an unknown consequence name throws", () => resolveConsequence(GEN_ROWS, "Expulsion", NOW.toISOString(), LOG_TYPE), PayloadRejected);
  throws(
    "a logtype row cannot masquerade as a subtype",
    () => resolveSubtype(GEN_ROWS, "Merits", NOW.toISOString(), LOG_TYPE),
    PayloadRejected,
  );
  throws(
    "a subtype row cannot masquerade as a consequence",
    () => resolveConsequence(GEN_ROWS, "Respect", NOW.toISOString(), LOG_TYPE),
    PayloadRejected,
  );
  throws(
    "an ambiguous subtype throws rather than picking one",
    () =>
      resolveSubtype(
        [...GEN_ROWS, { id: 77, name: "Respect", cat: "subtype", value: "RESPECT-B", schoolid: 3 }],
        "Respect",
        NOW.toISOString(),
        LOG_TYPE,
      ),
    PayloadRejected,
  );
  throws(
    "resolveSubtype refuses to run without a log type",
    () => resolveSubtype(GEN_ROWS, "Respect", NOW.toISOString(), undefined),
    PayloadRejected,
  );
  throws(
    "a GEN row with no usable value is refused rather than invented",
    () => resolveSubtype([{ id: 5, cat: "subtype", name: "" , value: "" }], "", NOW.toISOString(), LOG_TYPE),
    PayloadRejected,
  );

  // School scoping: another school's configuration is not borrowed.
  throws(
    "a subtype scoped to another school is refused",
    () => resolveSubtype([{ id: 12, name: "Respect", cat: "subtype", value: "RESPECT", schoolid: 4 }], "Respect", NOW.toISOString(), LOG_TYPE),
    PayloadRejected,
  );
  check(
    "a district-level row with no school is accepted",
    resolveSubtype([{ id: 12, name: "Respect", cat: "subtype", value: "RESPECT" }], "Respect", NOW.toISOString(), LOG_TYPE).value === "RESPECT",
  );

  // Freshness, same 24h bound as the log type.
  throws(
    "a stale subtype read is refused",
    () => buildLogRow({ ...INPUT, subtype: { ...SUBTYPE, readAtIso: "2026-08-01T00:00:00Z" } }, { now: NOW }),
    PayloadRejected,
  );
  throws(
    "a subtype ref with an unparseable read time is refused",
    () => buildLogRow({ ...INPUT, subtype: { ...SUBTYPE, readAtIso: "whenever" } }, { now: NOW }),
    PayloadRejected,
  );

  // The binding that a free string could never express: a subtype resolved
  // under Merits cannot be attached to an entry filed under Contact.
  const contact = resolveLogType(GEN_ROWS, "Contact", LOG_TYPE.readAtIso);
  const error = throws(
    "a subtype from another log type is refused",
    () => buildLogRow({ ...INPUT, logType: contact, subtype: SUBTYPE }, { now: NOW }),
    PayloadRejected,
  );
  check("  and the refusal names both log types", String(error?.message).includes("Merits") && String(error?.message).includes("Contact"));
  throws(
    "a hand-built subtype ref with no logTypeId is refused",
    () => buildLogRow({ ...INPUT, subtype: { ...SUBTYPE, logTypeId: undefined } }, { now: NOW }),
    PayloadRejected,
  );

  // resolveGenValue is the shared engine, exported so a caller can reach a GEN
  // category this client does not model yet without hand-rolling the discipline.
  check(
    "resolveGenValue is the same engine",
    resolveGenValue(GEN_ROWS, "consequence", "Suspend", NOW.toISOString()).value === "SUSP",
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
