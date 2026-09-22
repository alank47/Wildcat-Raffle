// A referral nobody closed is chased once, in school days. Run: npm test
//
// WHY THIS EXISTS. On 2026-09-22 the school had filed four behavior referrals
// in total. THREE were still open -- at four, five and seven days -- and the
// oldest carried severeBypass, the flag a teacher sets when an incident is too
// severe for classroom interventions. A fourth had been closed a week earlier
// and the teacher who filed it had never been told the outcome. The filing
// email fires once on insert and nothing after it ever speaks again.
//
// THE TWO WAYS THIS FEATURE FAILS, and every assertion below is about one of
// them:
//
//   1. IT MAILS TOO MUCH. Six named school leaders get the same child's
//      referral every morning, learn to filter it, and then the escalation
//      that matters lands in a folder nobody opens. So: each stage fires once,
//      the claim is taken BEFORE the send, a failure is not retried blindly,
//      and one referral yields at most one mail per run.
//   2. IT COUNTS WRONG. A referral filed on a Friday afternoon "escalates"
//      over a weekend nobody was working. So: age is school days read from
//      attendance, and with no school-day list the answer is to send nothing
//      rather than to guess.
//
// IT RUNS THE REAL HANDLERS. The uniform-violations miss on 2026-09-18 was a
// crash that 98 text-matching assertions all walked past, because reading
// source as a string cannot execute it. Both modules below are transpiled and
// INVOKED against an in-memory database, and the load-bearing assertions are
// proved to have teeth by re-breaking the shipped code.
import { readFileSync } from "node:fs";
import ts from "typescript";

const rulesSrc = readFileSync(new URL("./convex/referralPingRules.ts", import.meta.url), "utf8");
const mailRulesSrc = readFileSync(new URL("./convex/referralMailRules.ts", import.meta.url), "utf8");
const pingSrc = readFileSync(new URL("./convex/referralPing.ts", import.meta.url), "utf8");
const schemaSrc = readFileSync(new URL("./convex/schema.ts", import.meta.url), "utf8");
const cronsSrc = readFileSync(new URL("./convex/crons.ts", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

// Multi-line imports and all. A single-line regex left the middle of a
// braced import behind as a syntax error.
const strip = (s) => s
  .replace(/^import\b[\s\S]*?from\s*"[^"]*";[ \t]*\n/gm, "")
  .replace(/^export (const|function|type) /gm, "$1 ");

// ---------------------------------------------------------------- the harness
// Nothing is copied. A change to either shipped module changes what runs here.
// referralMailRules goes first because the ping rules import REFERRAL_RECIPIENTS
// and esc from it, and the recipient split is DEFINED as a filter of that real
// list -- so a name added to the standing six lands in these tests by itself.
function loadRules(transform) {
  let body = strip(mailRulesSrc) + "\n" + strip(rulesSrc);
  if (transform) body = transform(body);
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const names = ["REFERRAL_RECIPIENTS", "recipientsFor", "pingsDue", "pingRecipients", "pingMailPlan",
    "pingSettingsOrDefault", "schoolDaysBetween", "isOpen", "loopIsOpen", "filedOn",
    "DEFAULT_PING_SETTINGS", "PING_STAGES", "ESCALATION_ONLY"];
  return new Function(`${js}\nreturn {${names.join(",")}};`)();
}

// The ping module calls its rules by bare name once imports are stripped, so
// the real rules are compiled into the same scope rather than re-implemented.
function loadPing(transformPing, transformRules) {
  let rulesBody = strip(mailRulesSrc) + "\n" + strip(rulesSrc);
  if (transformRules) rulesBody = transformRules(rulesBody);
  let pingBody = strip(pingSrc);
  if (transformPing) pingBody = transformPing(pingBody);
  const stubs = `
    const internalMutation = (d) => d;
    const internalQuery = (d) => d;
    const internalAction = (d) => d;
    const v = new Proxy({}, { get: () => (...a) => ({ _v: true, a }) });
    const internal = new Proxy({}, { get: (_, mod) =>
      new Proxy({}, { get: (_2, fn) => ({ _ref: String(mod) + ":" + String(fn) }) }) });
  `;
  const js = ts.transpileModule(stubs + rulesBody + "\n" + pingBody, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(
    `${js}\nreturn { due, claim, finish, sweep, configure, emailForName, history, retryFailed };`)();
}

// --------------------------------------------------------- the fake database
// Indexed reads walk the columns the SCHEMA declares, read out of it rather
// than restated here, so a test that walks an index walks it as production will.
function tableBlock(head) {
  const i = schemaSrc.indexOf(head);
  if (i < 0) return "";
  const next = schemaSrc.indexOf("defineTable({", i + head.length);
  return schemaSrc.slice(i, next < 0 ? schemaSrc.length : schemaSrc.lastIndexOf("\n", next));
}
const PING_TABLE = tableBlock("referralPingLog: defineTable({");
const PING_INDEXES = Object.fromEntries(
  [...PING_TABLE.matchAll(/\.index\("([^"]+)",\s*\[([^\]]*)\]\)/g)].map(([, name, cols]) => [
    name, cols.split(",").map((c) => c.trim().replace(/"/g, "")).filter(Boolean),
  ]),
);
const INDEXES = {
  referralPingLog: PING_INDEXES,
  appState: { by_key: ["key"] },
  psAbsenceDayTotals: { by_date: ["date"] },
  legacyMirror: { by_doc: ["doc"] },
};

function makeDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed || {}));
  for (const t of Object.keys(tables)) tables[t].forEach((r, i) => { r._id = `${t}:${i}`; });
  let n = 0;
  const q = (name) => {
    let rows = (tables[name] || []).slice();
    const api = {
      withIndex(idx, fn) {
        const cols = (INDEXES[name] || {})[idx] || [];
        if (fn) {
          const eqs = {};
          const chain = { eq: (c, val) => { eqs[c] = val; return chain; } };
          fn(chain);
          rows = rows.filter((r) => Object.entries(eqs).every(([c, val]) => r[c] === val));
        }
        rows.sort((a, b) => cols.reduce((acc, c) =>
          acc || String(a[c] ?? "").localeCompare(String(b[c] ?? "")), 0));
        return api;
      },
      async take(k) { return rows.slice(0, k); },
      async first() { return rows[0] ?? null; },
      async collect() { return rows.slice(); },
    };
    return api;
  };
  return {
    tables,
    db: {
      query: q,
      async insert(name, doc) {
        tables[name] = tables[name] || [];
        const row = { ...doc, _id: `${name}:new${n++}` };
        tables[name].push(row);
        return row._id;
      },
      async delete(id) {
        for (const t of Object.values(tables)) {
          const i = t.findIndex((x) => x._id === id);
          if (i >= 0) t.splice(i, 1);
        }
      },
      async patch(id, fields) {
        for (const t of Object.values(tables)) {
          const r = t.find((x) => x._id === id);
          if (r) Object.assign(r, fields);
        }
      },
    },
  };
}

console.log("\nREFERRAL PING RULES\n");
const R = loadRules();

// ------------------------------------------------- school days, not calendar days
{
  // A real week with the weekend simply ABSENT -- which is how
  // psAbsenceDayTotals stores it. A row exists only for a date the school took
  // attendance, so Saturday, a staff development day and Labor Day are not
  // special cases in this code: they are rows that do not exist.
  const week = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22"];
  check("Friday to Monday is ONE school day, not three",
    R.schoolDaysBetween("2026-09-18", "2026-09-21", week) === 1,
    `got ${R.schoolDaysBetween("2026-09-18", "2026-09-21", week)}`);
  check("Monday to the next Monday is five",
    R.schoolDaysBetween("2026-09-14", "2026-09-21", week) === 5,
    `got ${R.schoolDaysBetween("2026-09-14", "2026-09-21", week)}`);
  check("the filing day itself does not count",
    R.schoolDaysBetween("2026-09-22", "2026-09-22", week) === 0);
  check("no school-day list REFUSES rather than guessing weekdays",
    R.schoolDaysBetween("2026-09-14", "2026-09-22", null) === null &&
    R.schoolDaysBetween("2026-09-14", "2026-09-22", []) === null);
  check("a malformed date refuses",
    R.schoolDaysBetween("nonsense", "2026-09-22", week) === null);

  // THE FRIDAY TRAP, end to end. Filed Friday afternoon, chased Monday
  // morning: one school day has passed and the nudge threshold is two.
  const friday = [{ id: "F", submittedAt: "2026-09-18T15:40:00Z", status: "open" }];
  const mon = R.pingsDue(friday, { today: "2026-09-21", schoolDays: week });
  check("filed Friday afternoon, Monday morning is NOT due", mon.due.length === 0,
    JSON.stringify(mon.due));
  const tue = R.pingsDue(friday, { today: "2026-09-22", schoolDays: week });
  check("...and Tuesday, at two school days, is",
    tue.due.length === 1 && tue.due[0].stage === "nudge");
}

// ------------------------------------------------------------------- the ladder
{
  const days = Array.from({ length: 20 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
  const open = (extra) => ({ id: "X", submittedAt: "2026-09-01T09:00:00Z", status: "open", ...extra });

  check("two school days open is a nudge",
    R.pingsDue([open()], { today: "2026-09-03", schoolDays: days }).due[0]?.stage === "nudge");

  const at5 = R.pingsDue([open()], { today: "2026-09-06", schoolDays: days });
  check("five school days open escalates", at5.due[0]?.stage === "escalation");
  check("...and yields ONE mail, not a nudge as well", at5.due.length === 1);

  // A referral that crossed both thresholds while the feature was switched
  // off gets ONE mail -- the escalation -- and never the quieter nudge after
  // it. The reverse is how five leaders learn to filter the whole thread.
  const at5done = R.pingsDue([open()], {
    today: "2026-09-06", schoolDays: days, alreadySent: new Set(["X|escalation"]),
  });
  check("an escalation already sent does NOT fall back to a nudge",
    at5done.due.length === 0, JSON.stringify(at5done.due));
  const bothDone = R.pingsDue([open()], {
    today: "2026-09-06", schoolDays: days, alreadySent: new Set(["X|escalation", "X|nudge"]),
  });
  check("both stages sent means nothing is due, ever again", bothDone.due.length === 0);

  check("severeBypass is chased after ONE school day",
    R.pingsDue([open({ severeBypass: true })], { today: "2026-09-02", schoolDays: days })
      .due[0]?.stage === "severe");
  check("...and an ordinary referral is not",
    R.pingsDue([open()], { today: "2026-09-02", schoolDays: days }).due.length === 0);
  check("a severe referral still escalates at five days",
    R.pingsDue([open({ severeBypass: true })], {
      today: "2026-09-06", schoolDays: days, alreadySent: new Set(["X|severe"]),
    }).due[0]?.stage === "escalation");
}

// ------------------------------------------------------------- open and closed
{
  const days = Array.from({ length: 20 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
  const base = { id: "C", submittedAt: "2026-09-01T09:00:00Z" };
  const today = "2026-09-10";

  check("closedAt closes it even when status still says open",
    !R.isOpen({ ...base, status: "open", closedAt: "2026-09-05T00:00:00Z" }));
  check("status closed closes it even with no closedAt",
    !R.isOpen({ ...base, status: "closed" }));

  const fully = R.pingsDue([{ ...base, status: "closed", closedAt: "2026-09-05T00:00:00Z", loopClosed: true }],
    { today, schoolDays: days });
  check("a fully closed referral is never chased",
    fully.due.length === 0 && fully.skipped[0]?.why === "fully_closed");

  const loop = R.pingsDue([{ ...base, status: "closed", closedAt: "2026-09-05T00:00:00Z", closedBy: "Leah Ruiz" }],
    { today, schoolDays: days });
  check("closed with the loop still open is a loop reminder", loop.due[0]?.stage === "loop");
  check("...addressed from whoever closed it", loop.due[0]?.closedBy === "Leah Ruiz");

  // A referral that sat open three weeks and was closed this morning is not
  // overdue for a loop reminder. Dating the loop from the FILING would have
  // sent one the same afternoon.
  const justClosed = R.pingsDue([{ ...base, status: "closed", closedAt: "2026-09-10T16:00:00Z" }],
    { today, schoolDays: days });
  check("the loop clock starts at the CLOSURE, not the filing",
    justClosed.due.length === 0, JSON.stringify(justClosed.due));
  check("...and the age it reports is measured from there",
    loop.due[0]?.clockFrom === "2026-09-05" && loop.due[0]?.ageSchoolDays === 5,
    JSON.stringify(loop.due[0]));

  check("loopClosedAt alone counts as closed",
    R.pingsDue([{ ...base, status: "closed", closedAt: "2026-09-05T00:00:00Z", loopClosedAt: "2026-09-06T00:00:00Z" }],
      { today, schoolDays: days }).due.length === 0);

  const undated = R.pingsDue([{ id: "U", status: "open" }], { today, schoolDays: days });
  check("an undated referral is skipped and NAMED, not chased",
    undated.due.length === 0 && undated.skipped[0]?.why === "undated");

  const noList = R.pingsDue([{ ...base, status: "open" }], { today, schoolDays: null });
  check("with no school-day list nothing is due and the reason says so",
    noList.due.length === 0 && noList.skipped[0]?.why === "no_school_day_list");
}

// -------------------------------------------------------------------- ordering
{
  const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
  const res = R.pingsDue([
    { id: "new", submittedAt: "2026-09-20T09:00:00Z", status: "open" },
    { id: "oldest", submittedAt: "2026-09-01T09:00:00Z", status: "open" },
    { id: "mid", submittedAt: "2026-09-10T09:00:00Z", status: "open" },
  ], { today: "2026-09-25", schoolDays: days });
  check("the longest-ignored referral is first, so a capped run does it first",
    res.due[0]?.referralId === "oldest" && res.due[res.due.length - 1]?.referralId === "new",
    res.due.map((d) => d.referralId).join(","));
}

// -------------------------------------------------------------------- settings
{
  const d = R.pingSettingsOrDefault(undefined);
  check("it is OFF by default -- mail to real people is opt-in", d.enabled === false);
  check("defaults are the owner's 2 / 5 / 1",
    d.nudgeAfterSchoolDays === 2 && d.escalateAfterSchoolDays === 5 && d.severeAfterSchoolDays === 1);
  const inverted = R.pingSettingsOrDefault({ nudgeAfterSchoolDays: 6, escalateAfterSchoolDays: 2 });
  check("an escalation cannot fire before its own nudge",
    inverted.escalateAfterSchoolDays >= inverted.nudgeAfterSchoolDays);
  const junk = R.pingSettingsOrDefault({ nudgeAfterSchoolDays: "soon", escalateAfterSchoolDays: -4 });
  check("junk thresholds fall back rather than becoming zero",
    junk.nudgeAfterSchoolDays === 2 && junk.escalateAfterSchoolDays === 5);
  check("enabled must be literally true",
    R.pingSettingsOrDefault({ enabled: "yes" }).enabled === false);
}

console.log("\nWHO IS MAILED\n");
{
  const standing = R.REFERRAL_RECIPIENTS.map((r) => r.email);
  const chief = R.REFERRAL_RECIPIENTS.filter((r) => R.ESCALATION_ONLY.includes(r.why)).map((r) => r.email);
  check("the standing list is six", standing.length === 6, `got ${standing.length}`);
  check("exactly one of them is escalation-only", chief.length === 1, chief.join(","));

  // THE SEVEN. recipientsFor adds the filer, which is why every filing mail on
  // record shows recipients: 7 rather than 6. A chase is not that mail.
  check("the FILING mail is seven: the standing six plus the filer",
    R.recipientsFor("teacher@lapromisefund.org").length === 7,
    `got ${R.recipientsFor("teacher@lapromisefund.org").length}`);
  check("...and six when the filer is already on the standing list",
    R.recipientsFor("laurab@lapromisefund.org").length === 6);

  const nudge = R.pingRecipients("nudge");
  check("a nudge goes to five: the people who can close it", nudge.length === 5, nudge.join(","));
  check("...and NOT to the Chief of Schools", !nudge.some((e) => chief.includes(e)));
  check("...and not to the filing teacher, who cannot close it",
    !nudge.includes("teacher@lapromisefund.org"));

  const esc = R.pingRecipients("escalation");
  check("an escalation goes to all six, Chief included",
    esc.length === 6 && chief.every((c) => esc.includes(c)), esc.join(","));
  check("severe uses the escalation list from day one",
    R.pingRecipients("severe").length === 6);
  check("the loop reminder is addressed by the caller, not from the list",
    R.pingRecipients("loop").length === 0);

  // A chase must never reach anyone the filing mail would not have.
  for (const stage of ["nudge", "escalation", "severe"]) {
    check(`no ${stage} recipient is outside the standing list`,
      R.pingRecipients(stage).every((e) => standing.includes(e)));
  }
}

console.log("\nTHE MAIL ITSELF\n");
{
  const referral = {
    id: "R-1", studentName: "José Ramírez-O'Neill", studentGrade: "9", studentId: "12345",
    behavior: "Defiance", description: "Refused to leave <script>alert(1)</script> the room.\nSecond time.",
    submittedAt: "2026-09-14T17:40:00Z", dateTime: "2026-09-14T15:10:00Z",
    filedBy: "Rosa Lopez", filedByEmail: "rosal@lapromisefund.org",
  };
  const m = R.pingMailPlan(referral, { stage: "nudge", ageSchoolDays: 4, to: R.pingRecipients("nudge") });

  check("the subject carries the short name and the age",
    m.subject.includes("José R.") && /\b4d\b/.test(m.subject), m.subject);
  check("the subject says it is still open", /Still open/.test(m.subject), m.subject);
  check("the subject is a mail HEADER, so it holds no html entities",
    !/&#\d+;|&amp;|&lt;/.test(m.subject), m.subject);
  check("the body is pure ASCII, so no client's charset guess can mangle a name",
    !/[-￿]/.test(m.html));
  check("an accented name survives as an entity rather than as mojibake",
    m.html.includes("&#233;") && m.html.includes("&#237;"));
  check("a pasted script tag is escaped, not markup",
    !m.html.includes("<script>") && m.html.includes("&lt;script&gt;"));
  check("a typed newline survives", m.html.includes("Second time."));

  check("it says what would make the reminder stop", /What ends this reminder/.test(m.html));
  check("it names the screen and the action, not just the problem",
    /Referral Review/.test(m.html) && /close/i.test(m.html));
  check("it says the mail is once-per-stage, so nobody braces for a daily one",
    /sent once/i.test(m.html));
  check("it says the clock is school days",
    /school day/i.test(m.html) && /weekends/i.test(m.html));
  check("the whole referral travels with it -- one recipient has no account to click into",
    m.html.includes("Defiance") && m.html.includes("12345") && m.html.includes("Refused to leave"));

  const nudgeWarn = R.pingMailPlan(referral, { stage: "nudge", ageSchoolDays: 2, to: ["a@b.org"] });
  check("a nudge says how long until the Chief of Schools is told",
    /Chief of Schools/.test(nudgeWarn.html) && /3 school days/.test(nudgeWarn.html), "");

  const sev = R.pingMailPlan({ ...referral, severeBypass: true },
    { stage: "severe", ageSchoolDays: 1, to: R.pingRecipients("severe") });
  check("a severe chase says why it arrived on day one",
    /Immediate removal was recorded/.test(sev.html));
  check("'1 school day' is singular and '4 school days' is plural",
    /1 school day[^s]/.test(sev.html) && /4 school days/.test(m.html));

  const escMail = R.pingMailPlan(referral, { stage: "escalation", ageSchoolDays: 5, to: R.pingRecipients("escalation") });
  check("an escalation says a first reminder already went out",
    /first reminder/i.test(escMail.html) && /2 school days/.test(escMail.html));

  // THE LEAK THE FIRST REAL DRY RUN FOUND. The severe stage only fires while
  // a referral is one to four school days old. Past five it crosses the
  // escalation threshold instead -- and a referral flagged too serious for
  // classroom interventions was arriving as an ordinary escalation with no
  // sign of what it was.
  const severeEsc = R.pingMailPlan({ ...referral, severeBypass: true },
    { stage: "escalation", ageSchoolDays: 6, to: R.pingRecipients("escalation") });
  check("a SEVERE referral that reaches escalation still says it is a removal",
    /Immediate removal was recorded/.test(severeEsc.html), "");
  check("...in the subject too, which is all a lock screen shows",
    /immediate removal/i.test(severeEsc.subject), severeEsc.subject);
  check("...and it still says it escalated", /first reminder/i.test(severeEsc.html));
  check("...without claiming the day-one threshold is why it arrived",
    !/rather than 2 school days/.test(severeEsc.html));
  check("an ordinary escalation carries no removal banner",
    !/Immediate removal/i.test(escMail.html) && !/immediate removal/i.test(escMail.subject));

  const loop = R.pingMailPlan({
    ...referral, status: "closed", closedBy: "Leah Ruiz", closedAt: "2026-09-16T20:00:00Z",
    resolutionType: "action_taken", consequence: "Parent contact",
  }, { stage: "loop", ageSchoolDays: 3, to: ["leahr@lapromisefund.org"] });
  check("the loop reminder names the teacher still waiting", /Rosa Lopez/.test(loop.html));
  check("...and points at Closed Referrals, not the open queue",
    /Closed Referrals/.test(loop.html) && !/Referral Review/.test(loop.html));
  check("...and does not re-send the incident description to the closer",
    !loop.html.includes("Refused to leave"));
  check("...and carries the resolution, so it can be repeated to the teacher",
    loop.html.includes("Parent contact"));
  check("...and its footer does not claim the referral is still open",
    !/still open after/.test(loop.html) && /has still not been told/.test(loop.html));

  check("a non-address in the recipient list is dropped",
    R.pingMailPlan(referral, { stage: "nudge", ageSchoolDays: 2, to: ["not-an-address", "ok@x.org"] })
      .to.join(",") === "ok@x.org");
}

console.log("\nTHE SWEEP, AGAINST A DATABASE\n");

// September 2026's real weekdays. The 5th/6th, 12th/13th and 19th/20th are
// weekends and are simply not rows, exactly as psAbsenceDayTotals stores it.
const SEPT_SCHOOL_DAYS = ["01", "02", "03", "04", "07", "08", "09", "10", "11",
  "14", "15", "16", "17", "18", "21", "22", "23", "24", "25"].map((d) => `2026-09-${d}`);

function seedWith(referrals, opts = {}) {
  const dayList = opts.noSchoolDays ? [] : (opts.schoolDays || SEPT_SCHOOL_DAYS);
  return {
    appState: [{
      key: "referralPings",
      value: { ...(opts.settings || {}), enabled: opts.enabled !== false },
      mirroredAt: "x",
    }],
    psAbsenceDayTotals: dayList.map((date) => ({
      date, studentsAbsent: 30, fullDaysStrict: 5, misrecordDaysByGap: [], partialDays: 10, syncedAt: "x",
    })),
    legacyMirror: referrals.map((r) => ({
      doc: "referrals", collection: "behaviorReferrals", key: r.id, payload: r,
    })),
    referralPingLog: opts.log || [],
    teachers: [
      { name: "Leah Ruiz", email: "leahr@lapromisefund.org", role: "admin" },
      { name: "Rosa Lopez", email: "rosal@lapromisefund.org", role: "teacher" },
    ],
  };
}

// One wiring, reused: the sweep drives due/claim/finish/emailForName through
// ctx exactly as Convex does, and mail:send is the only thing faked.
function wire(P, seed, opts = {}) {
  const { db, tables } = makeDb(seed);
  const sentMail = [];
  const ctx = {
    db,
    async runQuery(ref, args) {
      const name = String(ref?._ref || "");
      if (name.endsWith(":due")) return P.due.handler(ctx, args || {});
      if (name.endsWith(":emailForName")) return P.emailForName.handler(ctx, args);
      throw new Error("unexpected query " + name);
    },
    async runMutation(ref, args) {
      const name = String(ref?._ref || "");
      if (name.endsWith(":claim")) return P.claim.handler(ctx, args);
      if (name.endsWith(":finish")) return P.finish.handler(ctx, args);
      throw new Error("unexpected mutation " + name);
    },
    async runAction(ref, args) {
      if (opts.mailThrows) throw new Error("Graph said no");
      sentMail.push(args);
      // mail:send does NOT throw when it delivers nothing -- it returns
      // { sent: 0 }. Let a test say so.
      if (opts.mailResult) return opts.mailResult(args);
      return { sent: args.to.length, refused: [] };
    },
  };
  return { ctx, tables, sentMail };
}

async function runSweep(referrals, opts = {}) {
  const P = loadPing();
  const w = wire(P, seedWith(referrals, opts), opts);
  const out = await P.sweep.handler(w.ctx, { today: opts.today || "2026-09-16", dryRun: opts.dryRun });
  return { out, ...w, P };
}

const OPEN = {
  id: "R-open", studentName: "Ana Diaz", studentGrade: "9", behavior: "Defiance",
  submittedAt: "2026-09-14T16:00:00Z", status: "open",
  filedBy: "Rosa Lopez", filedByEmail: "rosal@lapromisefund.org",
};

// ---------------------------------------------------- it sends, once, correctly
{
  const { out, sentMail, tables } = await runSweep([OPEN]);
  check("an open referral past the threshold produces exactly one mail",
    sentMail.length === 1, JSON.stringify(out));
  check("...to the five who can close it",
    sentMail[0]?.to.length === 5, JSON.stringify(sentMail[0]?.to));
  check("...sent live, not left as a rehearsal", sentMail[0]?.live === true);
  check("...and the log records it sent", tables.referralPingLog[0]?.state === "sent");
  check("...with the school-day age it was at the time",
    tables.referralPingLog[0]?.ageSchoolDays === 2,
    String(tables.referralPingLog[0]?.ageSchoolDays));

  // THE ONE THAT MATTERS. Run the whole sweep again, same day, same referral,
  // carrying yesterday's log forward.
  const P2 = loadPing();
  const w2 = wire(P2, { ...seedWith([OPEN]), referralPingLog: tables.referralPingLog });
  const again = await P2.sweep.handler(w2.ctx, { today: "2026-09-16" });
  check("a second sweep sends the SAME referral nothing",
    w2.sentMail.length === 0, JSON.stringify(again));

  // Three school days later it crosses the escalation threshold, and THAT is
  // new mail -- to six now, the Chief of Schools included.
  const P3 = loadPing();
  const w3 = wire(P3, { ...seedWith([OPEN]), referralPingLog: tables.referralPingLog });
  await P3.sweep.handler(w3.ctx, { today: "2026-09-21" });
  check("...and escalates once it crosses the second threshold",
    w3.sentMail.length === 1 && w3.sentMail[0].to.length === 6,
    JSON.stringify(w3.sentMail.map((m) => m.to.length)));
  check("...to the Chief of Schools, who was not on the first one",
    w3.sentMail[0]?.to.includes("jasonm@lapromisefund.org"));
  check("...and that is the last rung, so a third sweep is silent",
    (await (async () => {
      const P4 = loadPing();
      const w4 = wire(P4, { ...seedWith([OPEN]), referralPingLog: w3.tables.referralPingLog });
      await P4.sweep.handler(w4.ctx, { today: "2026-09-25" });
      return w4.sentMail.length;
    })()) === 0);
}

// --------------------------------------------------------- the claim is a lock
{
  const P = loadPing();
  const { db, tables } = makeDb(seedWith([OPEN]));
  const ctx = { db };
  const a = await P.claim.handler(ctx, { referralId: "R-1", stage: "nudge", recipients: 5 });
  const b = await P.claim.handler(ctx, { referralId: "R-1", stage: "nudge", recipients: 5 });
  check("the first claim on a (referral, stage) wins", a.claimed === true);
  check("...and the second is refused", b.claimed === false);
  check("...leaving one row, not two", tables.referralPingLog.length === 1);
  check("a different stage of the same referral is still claimable",
    (await P.claim.handler(ctx, { referralId: "R-1", stage: "escalation", recipients: 6 })).claimed === true);
}

// ---------------------------------------- a failed send does not re-fire tomorrow
{
  const { tables } = await runSweep([OPEN], { mailThrows: true });
  check("a send that throws is recorded as failed, not lost",
    tables.referralPingLog[0]?.state === "failed" &&
    /Graph said no/.test(String(tables.referralPingLog[0]?.error)));
  // mail:send sets saveToSentItems, so "failed" can mean the mail reached
  // Graph and the bookkeeping after it did not. A blind retry is how five
  // leaders get the same child's referral twice.
  const P2 = loadPing();
  const w2 = wire(P2, { ...seedWith([OPEN]), referralPingLog: tables.referralPingLog });
  await P2.sweep.handler(w2.ctx, { today: "2026-09-16" });
  check("a FAILED send is not retried blindly the next morning", w2.sentMail.length === 0);
}

// ------------------------------------------------------------------ the off switch
{
  const { out, sentMail } = await runSweep([OPEN], { enabled: false });
  check("disabled sends nothing", sentMail.length === 0);
  check("...and says how to turn it on", /configure/.test(String(out.note)), String(out.note));

  const dry = await runSweep([OPEN], { dryRun: true });
  check("a dry run addresses and renders but sends nothing",
    dry.sentMail.length === 0 && dry.out.results[0]?.state === "dry-run" &&
    dry.out.results[0]?.to.length === 5, JSON.stringify(dry.out.results));
  check("...and shows the subject a human would read", /Still open/.test(String(dry.out.results[0]?.subject)));
  // A rehearsal that claims the slot silently cancels the performance.
  check("...and CLAIMS NOTHING, so the real send still happens afterwards",
    dry.tables.referralPingLog.length === 0, JSON.stringify(dry.tables.referralPingLog));
  const after = await runSweep([OPEN]);
  check("...proved: a live sweep after a dry run still mails", after.sentMail.length === 1);
}

// --------------------------------------------- no school-day list means no mail
{
  const { out, sentMail } = await runSweep([OPEN], { noSchoolDays: true });
  check("an empty attendance calendar sends nothing rather than counting weekdays",
    sentMail.length === 0);
  check("...and says so out loud", /school-day list/.test(String(out.note)), String(out.note));
}

// --------------------------------------------------------------- the loop reminder
{
  const closed = {
    ...OPEN, id: "R-closed", status: "closed", closedAt: "2026-09-10T20:00:00Z",
    closedBy: "Leah Ruiz", resolutionType: "action_taken", consequence: "Parent contact",
  };
  const { sentMail, tables } = await runSweep([closed]);
  check("a closed referral with an open loop reminds ONE person",
    sentMail.length === 1 && sentMail[0].to.length === 1, JSON.stringify(sentMail[0]?.to));
  check("...the admin who closed it, resolved from their display name",
    sentMail[0]?.to[0] === "leahr@lapromisefund.org");
  check("...and it is quieter: no leadership on the thread",
    !sentMail[0]?.to.includes("jasonm@lapromisefund.org"));
  check("...logged as the loop stage", tables.referralPingLog[0]?.stage === "loop");

  const o = await runSweep([{ ...closed, closedBy: "Somebody Who Left" }]);
  check("a closer with no staff account is skipped, not guessed at",
    o.sentMail.length === 0 && o.tables.referralPingLog[0]?.state === "skipped");
  check("...and the skip names the account that could not be matched",
    /Somebody Who Left/.test(String(o.tables.referralPingLog[0]?.reason)),
    String(o.tables.referralPingLog[0]?.reason));
  check("...and holds the slot, so it is not retried every morning forever",
    o.tables.referralPingLog.length === 1);

  check("a fully closed referral is left alone",
    (await runSweep([{ ...closed, loopClosed: true }])).sentMail.length === 0);
}

// --------------------------------------------------------------- volume and age
{
  const many = Array.from({ length: 20 }, (_, i) => ({ ...OPEN, id: `R-${i}` }));
  const { out, sentMail } = await runSweep(many);
  check("a backlog is capped per run rather than flooding inboxes",
    sentMail.length === 12, String(sentMail.length));
  check("...and the ones held back are REPORTED, not silently dropped",
    out.results.filter((r) => r.state === "deferred").length === 8,
    String(out.results.filter((r) => r.state === "deferred").length));

  // A full year of school days, so the age guard has room to bite.
  const year = [];
  for (let m = 9; m <= 12; m++) {
    for (let d = 1; d <= 28; d++) {
      const dow = new Date(Date.UTC(2025, m - 1, d)).getUTCDay();
      if (dow !== 0 && dow !== 6) year.push(`2025-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
  }
  year.push(...SEPT_SCHOOL_DAYS);
  const old = await runSweep([{ ...OPEN, id: "R-old", submittedAt: "2025-09-08T16:00:00Z", status: "open" }],
    { schoolDays: year });
  check("a referral from last school year is history, not a queue item",
    old.sentMail.length === 0 && old.out.agedOut === 1, JSON.stringify(old.out.agedOut));
}

// ------------------------------------------ a send that reached nobody is not a send
{
  // mail:send returns { sent: 0 } WITHOUT throwing in two live cases: the
  // STAFF_DOMAIN filter emptying the allowed list, and Graph answering 403 to
  // every address, which is what a tenant policy that omits this sender looks
  // like. Recording either as "sent" would leave four referrals in a log
  // reading byState: { sent: 4 } while nobody had been told anything.
  const dead = await runSweep([OPEN], {
    mailResult: (a) => ({ sent: 0, refused: a.to.map((x) => `${x} (HTTP 403)`) }),
  });
  const row = dead.tables.referralPingLog[0];
  check("delivered to nobody is recorded as FAILED, not sent", row?.state === "failed",
    JSON.stringify(row));
  check("...and says so in words a person can act on",
    /delivered to nobody/.test(String(row?.error)) && /403/.test(String(row?.error)),
    String(row?.error));
  check("...and history does not count it as a success",
    (await (async () => {
      const P = loadPing();
      const { db } = makeDb({ ...seedWith([OPEN]), referralPingLog: dead.tables.referralPingLog });
      const h = await P.history.handler({ db }, {});
      return (h.byState.sent ?? 0) === 0 && h.failed.length === 1;
    })()));

  // A PARTIAL delivery is still a delivery. Some of those inboxes have it,
  // so it must never be retried -- but it must not be silent either.
  const part = await runSweep([OPEN], {
    mailResult: (a) => ({ sent: 3, refused: a.to.slice(3).map((x) => `${x} (HTTP 403)`) }),
  });
  const prow = part.tables.referralPingLog[0];
  check("a partial delivery stays SENT, so nobody gets it twice", prow?.state === "sent");
  check("...with the shortfall on the row", prow?.sent === 3 && prow?.recipients === 5);
  check("...and history surfaces it separately from a clean send",
    (await (async () => {
      const P = loadPing();
      const { db } = makeDb({ ...seedWith([OPEN]), referralPingLog: part.tables.referralPingLog });
      const h = await P.history.handler({ db }, {});
      return h.partial.length === 1 && h.partial[0].delivered === 3 && h.partial[0].addressed === 5;
    })()));
  check("...and a later sweep does not re-send it",
    (await (async () => {
      const P = loadPing();
      const w = wire(P, { ...seedWith([OPEN]), referralPingLog: part.tables.referralPingLog });
      await P.sweep.handler(w.ctx, { today: "2026-09-16" });
      return w.sentMail.length;
    })()) === 0);
}

// ------------------------------------------------- the operator's escape hatch
{
  const dead = await runSweep([OPEN], { mailResult: () => ({ sent: 0, refused: ["all"] }) });
  check("a failed stage is stuck until a person says otherwise",
    (await (async () => {
      const P = loadPing();
      const w = wire(P, { ...seedWith([OPEN]), referralPingLog: dead.tables.referralPingLog });
      await P.sweep.handler(w.ctx, { today: "2026-09-16" });
      return w.sentMail.length;
    })()) === 0);

  const P = loadPing();
  const w = wire(P, { ...seedWith([OPEN]), referralPingLog: dead.tables.referralPingLog });
  const cleared = await P.retryFailed.handler(w.ctx, {});
  check("retryFailed clears exactly the failed rows", cleared.cleared === 1,
    JSON.stringify(cleared));
  check("...and the next sweep then re-sends", (await (async () => {
    await P.sweep.handler(w.ctx, { today: "2026-09-16" });
    return w.sentMail.length;
  })()) === 1);

  // It must never reopen somebody's inbox.
  const P2 = loadPing();
  const ok = await runSweep([OPEN]);
  const w2 = wire(P2, { ...seedWith([OPEN]), referralPingLog: ok.tables.referralPingLog });
  const none = await P2.retryFailed.handler(w2.ctx, {});
  check("a SENT row is never reopened by retryFailed", none.cleared === 0,
    JSON.stringify(none));
  const skipped = await runSweep([{ ...OPEN, id: "R-x", status: "closed",
    closedAt: "2026-09-10T20:00:00Z", closedBy: "Nobody At All" }]);
  const P3 = loadPing();
  const w3 = wire(P3, { ...seedWith([OPEN]), referralPingLog: skipped.tables.referralPingLog });
  check("a SKIPPED row is a decision, not an error, and is left alone",
    (await P3.retryFailed.handler(w3.ctx, {})).cleared === 0);
}

console.log("\nDO THE ASSERTIONS HAVE TEETH?\n");

// Re-break the shipped code and require the guard to notice. An assertion that
// still passes against broken source is decoration.
{
  const broken = loadRules((body) => {
    const before = body;
    body = body.replace('if (!sent.has(id + "|" + stage)) picked = stage;', "picked = stage;");
    if (body === before) throw new Error("teeth 1: anchor moved");
    return body;
  });
  const days = Array.from({ length: 10 }, (_, i) => `2026-09-0${i + 1}`);
  const res = broken.pingsDue([{ id: "X", submittedAt: "2026-09-01T09:00:00Z", status: "open" }],
    { today: "2026-09-09", schoolDays: days, alreadySent: new Set(["X|escalation", "X|nudge"]) });
  check("TEETH: with the sent-check removed, the 'never twice' guard fires", res.due.length > 0);
}
{
  const broken = loadRules((body) => {
    const before = body;
    body = body.replace("if (!schoolDays || !schoolDays.length) return null;",
      "if (!schoolDays || !schoolDays.length) return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);");
    if (body === before) throw new Error("teeth 2: anchor moved");
    return body;
  });
  check("TEETH: with a calendar fallback, the refusal assertion fires",
    broken.schoolDaysBetween("2026-09-14", "2026-09-22", null) !== null);
}
{
  const broken = loadRules((body) => {
    const before = body;
    body = body.replace('const leadershipOnly = stage === "escalation" || stage === "severe";',
      "const leadershipOnly = true;");
    if (body === before) throw new Error("teeth 3: anchor moved");
    return body;
  });
  check("TEETH: with the nudge widened to the Chief, the recipient assertion fires",
    broken.pingRecipients("nudge").length !== 5);
}
{
  // The loop clock, re-pointed at the filing date.
  const broken = loadRules((body) => {
    const before = body;
    body = body.replace("const clockFrom = open ? filed : (closedOn.length === 10 ? closedOn : filed);",
      "const clockFrom = filed;");
    if (body === before) throw new Error("teeth 4: anchor moved");
    return body;
  });
  const days = Array.from({ length: 20 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
  const res = broken.pingsDue([{ id: "C", submittedAt: "2026-09-01T09:00:00Z", status: "closed", closedAt: "2026-09-10T16:00:00Z" }],
    { today: "2026-09-10", schoolDays: days });
  check("TEETH: dating the loop from the filing mails a closer the same afternoon",
    res.due.length > 0);
}
{
  // The dry run, claiming the slot it is only rehearsing.
  const P = loadPing((body) => {
    const before = body;
    body = body.replace("      if (dryRun) {", "      if (false) {");
    if (body === before) throw new Error("teeth 5: anchor moved");
    return body;
  });
  const w = wire(P, seedWith([OPEN]));
  await P.sweep.handler(w.ctx, { today: "2026-09-16", dryRun: true });
  check("TEETH: a dry run that claims the slot is caught",
    w.tables.referralPingLog.length > 0);
}

{
  // Zero delivered, logged as a clean send -- the silent permanent stop.
  const P = loadPing((body) => {
    const before = body;
    body = body.replace("        if (delivered === 0) {", "        if (false) {");
    if (body === before) throw new Error("teeth 6: anchor moved");
    return body;
  });
  const w = wire(P, seedWith([OPEN]), { mailResult: () => ({ sent: 0, refused: ["all"] }) });
  await P.sweep.handler(w.ctx, { today: "2026-09-16" });
  check("TEETH: a zero-delivery logged as sent is caught",
    w.tables.referralPingLog[0]?.state === "sent");
}

console.log("\nWIRING\n");
{
  check("the cron is registered", /internal\.referralPing\.sweep/.test(cronsSrc));
  check("...once a day, not hourly -- hourly is how a mailbox rule gets written",
    /crons\.cron\(\s*"chase open referrals",\s*"\d+ \d+ \* \* \*"/.test(cronsSrc));
  check("...after the 13:30 absence rebuild it reads its school days from",
    (() => {
      const m = cronsSrc.match(/"chase open referrals",\s*"\d+ (\d+) \* \* \*"/);
      return m ? Number(m[1]) > 13 : false;
    })());
  check("the ping log is its OWN table, leaving referralMailLog's .first() unambiguous",
    /referralPingLog: defineTable\(/.test(schemaSrc));
  check("...indexed by (referral, stage), which is what makes 'once' a lookup",
    JSON.stringify(PING_INDEXES.by_stage) === JSON.stringify(["referralId", "stage"]),
    JSON.stringify(PING_INDEXES));
  check("no public function reaches any of it -- a browser cannot ask for mail",
    !/\bexport const \w+ = (mutation|query|action)\(/.test(pingSrc));
  check("no recipient is ever taken from an argument",
    !/to: v\.array|recipients: v\.array\(v\.string/.test(pingSrc));
  check("it is off by default in the shipped source", /enabled: false/.test(rulesSrc));
  check("every stage in PING_STAGES is one the schema will accept",
    R.PING_STAGES.every((s) => PING_TABLE.includes(`v.literal("${s}")`)), R.PING_STAGES.join(","));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
