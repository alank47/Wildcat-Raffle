// Both period pickers read the same source.
//
// THE BUG. updatePeriodFilter (Raffle → Award Tickets) gated on
// currentUser.sections and hid the whole control when it was empty:
//
//   if (!currentUser || !currentUser.sections || currentUser.sections.length === 0) {
//       periodFilterSection.style.display = 'none';
//
// That field is written by exactly one thing, the legacy CSV import, which
// matched teachers to schedules BY NAME. Nothing in the PowerSchool path has
// ever written it. So it has been empty for everybody since the CSV era ended
// and the control was hidden on every load, for every user.
//
// It went unnoticed for so long because hiding leaves nothing on screen to
// report. Award Cash had the identical bug and was caught only because it
// degraded to a visible "All students" instead of vanishing.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const rosterSrc = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
new Function(rosterSrc)();
const R = globalThis.WildcatRoster;

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

// Bounded by the NEXT sibling declaration rather than the first `}` at that
// indent, which truncated updateCashPeriodFilter part way through its body and
// failed an assertion about code that was present.
const fn = (name) => {
  const start = script.indexOf(`function ${name}(`);
  if (start < 0) return "";
  const next = script.indexOf("\n        function ", start + 10);
  return script.slice(start, next < 0 ? script.length : next);
};

// Comments STRIPPED. The fix's own comment names the array it deleted, so a
// plain text search reports it as still in use — the same way the CSS test
// failed on itself earlier.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

console.log("\nThe dead field is gone from the raffle picker");
{
  const f = fn("updatePeriodFilter");
  check("the function was found", f.length > 0);
  check("it no longer gates on currentUser.sections",
    !/currentUser\.sections\.length === 0/.test(f));
  check("and no longer hides itself",
    !/periodFilterSection\.style\.display = 'none'/.test(f.replace(/campusaide[\s\S]*?return;/, "")));
  check("the control is shown instead",
    /periodFilterSection\.style\.display = 'block'/.test(f));
  check("the reason is recorded, since the field looks alive",
    /written by exactly one thing: the legacy CSV/.test(script));
}

console.log("\nBoth pickers read the same source and the same helpers");
{
  const raffle = fn("updatePeriodFilter");
  const cash = fn("updateCashPeriodFilter");
  ["sectionsFrom(activeTeacherRoster())", "seesEveryStudent"].forEach((bit) => {
    check(`raffle uses ${bit}`, raffle.includes(bit));
    check(`cash uses ${bit}`, cash.includes(bit));
  });
  // Two screens disagreeing about what a period is was the original complaint.
  check("neither hand-rolls its own period ordering",
    !/periodOrder/.test(code(raffle)) && !/periodOrder/.test(code(cash)));
  check("comment stripping actually removed something",
    code(raffle).length < raffle.length);
}

console.log("\nIt loads the roster itself, because Raffle mode never did");
{
  const f = fn("updatePeriodFilter");
  check("a missing roster triggers a fetch",
    /if \(!activeTeacherRoster\(\)/.test(f));
  check("and repaints when it lands",
    /loadTeacherRosterFromSIS\(true\)\.then\(\(\) => updatePeriodFilter\(\)\)/.test(f));
  // The retry rule itself is asserted below, where it is described.
}

console.log("\nThe labels come from the shared classifier");
{
  // The replaced code sorted against ['A1','P1','HPU',...], codes the SIS does
  // not emit, so every section fell to the end of the list unsorted.
  check("Promise Time is not called a period",
    R.classifySection({ period: "1" }).kind === "promise");
  check("Power Up is not called a period",
    R.classifySection({ period: "8" }).kind === "powerup");
  check("slot 2 is Period 1, the off-by-one that was reported",
    R.classifySection({ period: "2" }).period === 1);
  check("an empty roster yields no sections rather than throwing",
    Array.isArray(R.sectionsFrom(null)) && R.sectionsFrom(null).length === 0);
}

console.log("\nEvery helper these screens call is actually defined");
{
  // THE BUG THIS EXISTS FOR. A revert removed activeTeacherRoster's definition
  // while later work kept calling it from three places, so both period pickers
  // threw ReferenceError in production. Nothing failed, because the tests that
  // covered the definition were removed by the same revert. "Called implies
  // defined" survives that, because the call sites are what remain.
  ["activeTeacherRoster", "isPreviewingTeacher", "periodFilterNote",
   "loadPreviewRoster", "loadTeacherRosterFromSIS", "resetPeriodFilterFetch"]
    .forEach((name) => {
      const defined = new RegExp(`function ${name}\\s*\\(`).test(script);
      const withoutDefs = script.replace(new RegExp(`function ${name}\\s*\\(`, "g"), "");
      const called = new RegExp(`[^A-Za-z0-9_.]${name}\\s*\\(`).test(withoutDefs);
      check(`${name}: not called unless defined`, !called || defined);
      check(`${name} is defined`, defined);
    });
}

console.log("\nEveryone gets the whole school AND their own classes");
{
  const raffle = fn("updatePeriodFilter");
  const cash = fn("updateCashPeriodFilter");
  // The either/or is what left a superadmin who teaches with no way to narrow
  // to their own sections.
  check("the raffle picker no longer branches on seesAll for its options",
    !/innerHTML = seesAll/.test(code(raffle)));
  check("nor does the cash picker",
    !/innerHTML = seesAll/.test(code(cash)));
  check("both always offer the whole school",
    /All Students \(\$\{totalStudents\}\)/.test(raffle) &&
    /All students<\/option>'/.test(cash));
  check("and both append the caller's own sections unconditionally",
    /sections\.forEach/.test(raffle) && /sections\.forEach/.test(cash));
  // scopeStudents honours a chosen section for every role, which is what makes
  // offering it correct rather than decorative.
  check("a chosen section wins for every role",
    /A CHOSEN SECTION ALWAYS WINS, FOR EVERY ROLE/.test(rosterSrc));
}

console.log("\nAn empty list says which of the three it is");
{
  const note = fn("periodFilterNote");
  check("loading is distinguished", /Loading your classes/.test(note));
  check("a failed lookup reports its error", /Classes unavailable: /.test(note));
  check("and no classes names who it looked for",
    /No classes in PowerSchool for/.test(note));
  check("the previewed person is named, not 'you'",
    /isPreviewingTeacher\(\)\s*\n?\s*\?/.test(note));
  check("a non-empty list adds nothing", /if \(sections && sections\.length\) return '';/.test(note));
}

console.log("\nA failed roster is retried, once");
{
  const f = fn("updatePeriodFilter");
  check("a failed lookup is retried, not only an idle one",
    /sisRosterState !== 'loading'/.test(f) && !/sisRosterState === 'idle'/.test(f));
  check("but only once per context, so a repaint cannot loop",
    /!periodFilterFetchTried/.test(f) && /periodFilterFetchTried = true;/.test(f));
  check("and the budget resets when the roster context changes",
    (script.match(/resetPeriodFilterFetch\(\);/g) || []).length >= 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
