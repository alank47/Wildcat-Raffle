// The nightly cash-drift check reports and never repairs. Run: npm test
//
// WHY THIS JOB EXISTS. A repair on 2026-09-17 brought 223 students' cash
// counters back into agreement with their transaction history. One school day
// later, 28 had drifted again -- and the owner found out on the Sunday because
// somebody happened to look. The worst case should be one school day of drift,
// noticed the next morning.
//
// WHY IT MUST NOT REPAIR, which is the assertion this file exists for.
// `_startNewSchoolYear` writes NO ledger row: unlike a balance reset, which
// records a `system_reset` row the derivation treats as a zero point, the year
// roll zeroes the counters and leaves the year's rows in place. So on the night
// after a rollover the derivation would find every student short by their whole
// closed year, BOTH witnesses would agree, and the change would be an INCREASE
// -- so neither the two-witness check nor the decrease guard would stop it. An
// auto-patching nightly job would resurrect the previous school year,
// school-wide, unattended. There is an assertion below that `apply` is never
// true in this module.
import { readFileSync } from "node:fs";
import ts from "typescript";

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

const src = readFileSync(new URL("./convex/cashDriftCheck.ts", import.meta.url), "utf8");
const crons = readFileSync(new URL("./convex/crons.ts", import.meta.url), "utf8");
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

// Lifted from the shipped source, including the private helper cashWeekKeys
// closes over, so the test cannot drift from a copy.
function lift(name, exported) {
  const needle = exported ? `export function ${name}(` : `function ${name}(`;
  const start = src.indexOf(needle);
  if (start < 0) throw new Error(`${name} not found in convex/cashDriftCheck.ts`);
  const end = src.indexOf("\n}\n", start) + 3;
  return src.slice(start, end).replace("export function", "function");
}
const js = ts.transpileModule(
  [lift("cashWeekKeys", true), lift("weekKeyOf", false),
   lift("driftSummary", true), lift("driftRows", true)].join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText;
const [cashWeekKeys, driftSummary, driftRows] =
  new Function(js + "\nreturn [cashWeekKeys, driftSummary, driftRows];")();

console.log("\nThe weeks it reads are bounded by the history cutoff");
{
  // Bounded at BOTH ends on purpose. Rows before the cutoff were deliberately
  // purged, so counting them would report the whole school as short -- the
  // mistake that made one measurement read 449 movements and $32,000 instead
  // of 101 and $10,400.
  const w = cashWeekKeys("2026-09-14T15:30:00Z", "2026-09-20T12:00:00Z");
  check("it covers the cutoff's own week", w.includes("2026_W38"));
  check("and the current one", w.includes("2026_W39"));
  check("it does not reach back before the cutoff", !w.includes("2026_W37"));
  check("a one-day span still yields its week",
    cashWeekKeys("2026-09-15T00:00:00Z", "2026-09-15T23:59:00Z").length >= 1);
  check("a school year is a plausible number of weeks, not thousands",
    cashWeekKeys("2026-08-12T00:00:00Z", "2027-06-12T00:00:00Z").length < 60);
  check("no duplicates", (() => {
    const k = cashWeekKeys("2026-08-12T00:00:00Z", "2026-12-12T00:00:00Z");
    return k.length === new Set(k).size;
  })());
  check("junk in is an empty list, never an unbounded loop", cashWeekKeys("nope", "also nope").length === 0);
  check("an absent cutoff yields nothing to read", cashWeekKeys(null, "2026-09-20T00:00:00Z").length === 0);
  check("a backwards span yields nothing", cashWeekKeys("2026-09-20T00:00:00Z", "2026-09-01T00:00:00Z").length === 0);
}

console.log("\nThe summary says what a person needs, and counts held-back as wrong");
{
  const clean = driftSummary([
    { seen: 250, repaired: 0, heldBack: 0, alreadyCorrect: 250, balanceMoved: 0 },
    { seen: 267, repaired: 0, heldBack: 0, alreadyCorrect: 267, balanceMoved: 0 },
  ]);
  check("a clean night is clean", clean.clean === true && clean.diverged === 0);
  check("it counts every student checked", clean.checked === 517);
  check("and says so plainly", /All 517 students/.test(clean.headline));

  const dirty = driftSummary([
    { seen: 250, repaired: 21, heldBack: 0, alreadyCorrect: 229, balanceMoved: 2300 },
    { seen: 267, repaired: 0, heldBack: 7, alreadyCorrect: 260, balanceMoved: 0 },
  ]);
  // The real 2026-09-18 figures.
  check("a dirty night is not clean", dirty.clean === false);
  check("diverged and held-back are separate numbers", dirty.diverged === 21 && dirty.heldBack === 7);
  // A HELD-BACK STUDENT IS NOT A STUDENT WHO IS FINE. The repair refuses them
  // precisely because they need a person, so the headline must count them.
  check("the headline counts both", /28 of 517/.test(dirty.headline), dirty.headline);
  check("it names the money", /\+\$2,300/.test(dirty.headline), dirty.headline);
  check("and says some need a person to look", /needing a person to look/.test(dirty.headline));
  check("net is rounded to whole dollars", Number.isInteger(dirty.netOwed));

  const negative = driftSummary([{ seen: 10, repaired: 2, heldBack: 0, balanceMoved: -400 }]);
  check("money owed the other way is signed, not hidden", /-\$400/.test(negative.headline), negative.headline);
  check("no batches at all is still a well-formed answer",
    driftSummary([]).checked === 0 && driftSummary([]).clean === true);
  check("a null batch is skipped rather than throwing",
    driftSummary([null, { seen: 3, repaired: 1 }]).checked === 3);
  check("extras are carried onto the record", driftSummary([], { capped: true }).capped === true);
}

console.log("\nIt reports and never repairs");
{
  // The assertion this file exists for. See the header.
  check("the module never passes apply: true", !/apply:\s*true/.test(src));
  check("it calls the repair's own derivation with apply: false",
    /recountStudents,\s*\{[\s\S]{0,200}apply:\s*false/.test(src));
  check("nothing in it patches a student", !/db\.patch\([\s\S]{0,40}students/.test(src));
  check("the refusal to auto-repair is written down, with the reason",
    /_startNewSchoolYear/.test(src) && /resurrect/.test(src));
  check("and again on the cron, where someone would change it",
    /_startNewSchoolYear/.test(crons) && /only reports/i.test(crons));
}

console.log("\nIt refuses rather than guessing when it cannot trust its inputs");
{
  check("no history cutoff means it does not run",
    /no history cutoff is set/.test(src) && /ok: false/.test(src));
  check("a capped reversal register means it does not run",
    /reversal register came back capped/.test(src));
  check("a capped ledger read is reported, not swallowed",
    /capped,/.test(src) && /stops checking/.test(src));
  check("there is a page ceiling at all", /const MAX_PAGES = \d+/.test(src));
}

console.log("\nThe result reaches a person");
{
  check("it is scheduled nightly", /"cash counter drift check"/.test(crons) &&
    /internal\.cashDriftCheck\.nightly/.test(crons));
  check("on a minute no other job uses", /"10 10 \* \* \*"/.test(crons) &&
    !/"10 10 \* \* \*"[\s\S]*"10 10 \* \* \*"/.test(crons));
  check("the latest result is stored where the dashboard can read it",
    /const STATE_KEY = "cashDriftCheck"/.test(src));
  // An entry every night would be 180 rows a year saying nothing happened, in
  // the feed a person reads to find what did.
  check("an audit entry is written ONLY when something is wrong",
    /if \(value\.ok === false \|\| wrong > 0\)/.test(src));
  check("the entry says nothing was changed, so nobody thinks it was fixed",
    /Nothing was changed: this check only reports/.test(src));
  check("and tells them the command that shows the list",
    /recount-cash-counters\.mjs/.test(src));
}

console.log("\nThe dashboard tile is silent when there is nothing to say");
{
  check("the client reads the stored result", /'cashDriftCheck:latest'/.test(script));
  // Once per page, EXCEPT when a re-check explicitly forces it -- otherwise
  // pressing "Re-check now" could never show its own answer.
  check("it is asked for once per page, not per redraw",
    /if \(_cashDriftAsked && force !== true\) return;/.test(script));
  check("but a re-check can force a fresh read", /fetchCashDrift\(true\)/.test(script));
  check("the tile only appears for people who see the whole school",
    /seesAll && _cashDrift &&/.test(script));
  check("and only when something is wrong",
    /\(\(Number\(_cashDrift\.diverged\) \|\| 0\) \+ \(Number\(_cashDrift\.heldBack\) \|\| 0\)\) > 0/.test(script));
  check("a failed check shows as absent rather than as zero",
    /absent: 'the nightly check could not run'/.test(script));
  check("the fetch never blocks the first paint", /Never awaited/.test(script));
  check("the audit action has a label, so it does not render as a raw string",
    /'cash_drift_detected':\s*'system'/.test(script) &&
    /cash_drift_detected:\s*\{ label: 'Balances Drifted'/.test(
      readFileSync(new URL("./wildcat-cashaudit.js", import.meta.url), "utf8")));
}

console.log("\nIt records WHICH students, not just how many");
{
  // THE GAP THIS CLOSES, in the owner's words on 2026-09-20: "i clicked and it
  // sent to the audit log but how am i supposed to know the balances that need
  // attention". A count is an alarm; it is not something a person can act on.
  const batches = [{
    details: [
      { studentId: "1", name: "Owed Small", action: "would repair",
        changes: [{ field: "wildcatCashBalance", was: 400, now: 500 },
                  { field: "wildcatCashEarned", was: 400, now: 500 }] },
      { studentId: "2", name: "Owed Big", action: "would repair",
        changes: [{ field: "wildcatCashBalance", was: 200, now: 1400 }] },
      { studentId: "3", name: "Fine", action: "already correct" },
      { studentId: "4", name: "Needs A Look", action: "held back",
        why: "this would REDUCE the balance by $100",
        changes: [{ field: "wildcatCashBalance", was: 700, now: 600 }] },
    ],
  }];
  const r = driftRows(batches);
  check("only the students who need attention are listed", r.rows.length === 3);
  check("a correct student is not among them", !r.rows.some((x) => x.name === "Fine"));
  check("worst first, by size of the difference", r.rows[0].name === "Owed Big");
  check("it says what is stored and what the records say",
    r.rows[0].storedBalance === 200 && r.rows[0].recordsSay === 1400);
  check("and the difference, signed", r.rows[0].difference === 1200);
  check("a held-back student is flagged as such",
    r.rows.find((x) => x.name === "Needs A Look").heldBack === true);
  check("with the reason carried through, not summarised away",
    /REDUCE the balance/.test(r.rows.find((x) => x.name === "Needs A Look").why));
  check("a student owed money is not flagged as held back",
    r.rows.find((x) => x.name === "Owed Big").heldBack === false);
  check("other wrong counters are named in words a person uses",
    r.rows.find((x) => x.name === "Owed Small").alsoWrong.join(",") === "earned");
  check("the balance itself is not repeated in that list",
    !r.rows[0].alsoWrong.includes("balance"));

  const many = driftRows([{ details: Array.from({ length: 250 }, (_, i) => ({
    studentId: String(i), name: "S" + i, action: "would repair",
    changes: [{ field: "wildcatCashBalance", was: 0, now: i + 1 }] })) }], 200);
  check("the list is capped", many.rows.length === 200);
  check("and says so rather than ending quietly", many.rowsTruncated === true);
  check("an uncapped list does not claim to be truncated", r.rowsTruncated === false);
  check("no batches is an empty list, not a throw", driftRows([]).rows.length === 0);
  check("a null detail is skipped", driftRows([{ details: [null] }]).rows.length === 0);
  check("the rows ride along on the recorded result",
    /\.\.\.driftRows\(batches\),/.test(src));
}

console.log("\nThe list is on the screen the tile sends you to");
{
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  check("the panel has a home in the cash audit tab",
    /id="cashDriftPanel"/.test(html) &&
    html.indexOf('id="cashDriftPanel"') > html.indexOf('id="cashAuditTab"') &&
    html.indexOf('id="cashDriftPanel"') < html.indexOf('id="cashAuditLogTable"'));
  check("the cash audit renderer draws it", /renderCashDriftPanel\(\);\s*\n\s*const tbody/.test(script));
  check("it is empty when nothing is wrong",
    /if \(!d \|\| \(d\.ok !== false && wrong === 0\)\) \{ host\.innerHTML = ''; return; \}/.test(script));
  check("it says nothing has been changed, so nobody reads it as fixed",
    /<strong>Nothing has been changed<\/strong>/.test(script));
  check("it explains what Owed and Needs a decision mean, in plain words",
    /records add up to more than their balance shows/.test(script) &&
    /would take money off them/.test(script));
  check("it says WHEN it was checked, because this is last night's answer",
    /Checked ' \+ escapeHtml\(when\)/.test(script));
  check("a failed check says so instead of showing an empty list",
    /could not run<\/h4>/.test(script));
  check("re-checking is admin-only: it pages the whole ledger",
    /class="wc-uv-mini admin-only"/.test(script));
  check("and it is a public mutation gated on requireAdmin",
    /export const recheckNow = mutation/.test(src) && /requireAdmin\(ctx\)/.test(src));
  check("it schedules rather than making a browser wait on the whole ledger",
    /scheduler\.runAfter\(0, internal\.cashDriftCheck\.nightly/.test(src));
  // Both of the last two bugs were a reference that existed and did not
  // resolve. Checked here rather than assumed.
  const block = script.slice(script.indexOf("function renderCashDriftPanel"),
                             script.indexOf("function updateCashAuditLogTable"));
  const ids = [...new Set([...block.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))];
  const missing = ids.filter((id) => !new RegExp(`id="${id}"`).test(html));
  check(`every id it reaches for exists (${ids.length})`, missing.length === 0, missing.join(", "));
  const fns = [...new Set([...block.matchAll(/onclick="([A-Za-z_]+)\(/g)].map((m) => m[1]))];
  const undef = fns.filter((f) => !new RegExp(`function ${f}\\s*\\(`).test(script));
  check("every function it wires up is defined", undef.length === 0, undef.join(", "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
