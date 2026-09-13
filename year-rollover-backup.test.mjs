// The backup behind the one action that cannot be undone.
//
// THE BUG THIS CATCHES, found 2026-09-13 while answering "is there a button to
// reset all the balances". There is: startNewSchoolYear zeroes every balance,
// empties cashTransactions and cashReceipts, and tells the operator on screen
// that "a full backup is written first". It took that backup by awaiting
// createAutomaticBackup().
//
// createAutomaticBackup had been a no-op since automatic Firebase backups
// outgrew the 1MB document limit: two console lines and an early `return`. It
// did not throw. So the rollover's try/catch never fired, it set
// backupRef = "backups/<date>_cash" for a document that had never been
// written, it wiped the year, and it filed that invented path in the permanent
// audit record. A function that SUCCEEDS at doing nothing is worse than one
// that fails, because every caller concludes it worked.
//
// And the manual export it should have been using did not carry the cash data
// at all -- not cashTransactions, not cashReceipts, not the reward catalogue.
// Balances were recoverable because they live inside `students`; the record of
// how the money moved was not, and that record is what answers a parent asking
// why their child was deducted.
//
// Two failures pointing the same way: the rollover was safe to run only in the
// sense that nothing told you otherwise.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  (" + d + ")" : ""}`); }
};

/** The closing brace matching the `{` at or after `from`. */
function blockEnd(s, from) {
  let i = s.indexOf("{", from), depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i + 1;
  }
  throw new Error("unbalanced");
}
const fn = (decl) => {
  const a = src.indexOf(decl);
  if (a === -1) throw new Error("not found: " + decl);
  return src.slice(a, blockEnd(src, a));
};
// Comments are the institutional record here, but an assertion that matches
// prose explaining why the code does NOT do a thing passes for the wrong
// reason. These strip them.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("\n1. The export carries what the rollover deletes");
{
  const exp = code(fn("function exportBackup() {"));
  // These four are exactly what startNewSchoolYear empties.
  ["cashTransactions", "cashReceipts", "wildcatCashRewards", "cashYearArchives"].forEach((f) =>
    check(`${f} is in the backup file`, new RegExp("\\b" + f + ",").test(exp)));
  // Balances ride inside the student records, which were always here. Said
  // out loud so nobody "tidies" students out of the list.
  check("students are in it, which is where balances live", /\bstudents,/.test(exp));
  check("and it really does write a file", /link\.download|\.click\(\)/.test(exp));
}

console.log("\n2. The disabled backup cannot be mistaken for a backup");
{
  const auto = fn("async function createAutomaticBackup() {");
  const body = code(auto);
  check("createAutomaticBackup throws", /throw new Error\(/.test(body));
  check("it does NOT return quietly", !/^\s*return;\s*$/m.test(body),
    "a silent return is what made every caller conclude a backup existed");
  check("and the error says what to do instead", /Export Backup/.test(auto));

  // The page-load caller wanted a backup opportunistically. It must not now
  // break a load, and it must not be the shape the rollover uses.
  const chk = code(fn("async function checkAutomaticBackup() {"));
  check("the page-load caller swallows the throw", /try \{[\s\S]*createAutomaticBackup\(\)[\s\S]*catch/.test(chk));
}

console.log("\n3. The rollover takes a real backup, or does not run");
{
  // THE INNER function. startNewSchoolYear is now the error wrapper; the work
  // lives in _startNewSchoolYear. Slicing the wrapper found none of these and
  // reported nine guarantees missing from code that still had all nine.
  const roll = fn("async function _startNewSchoolYear() {");
  const body = code(roll);
  check("it no longer relies on the disabled backup", !/createAutomaticBackup/.test(body),
    "this is the exact call that returned without throwing");
  check("it calls the export that writes a file", /exportBackup\(\)/.test(body));
  check("the recorded reference is the file's real name, not an invented path",
    /wildcat-backup-\$\{/.test(body) && !/backups\/\$\{/.test(body));

  // A download can be blocked or cancelled and none of that throws, so the
  // only way to know the operator has the file is to ask.
  check("it asks whether the file actually arrived", /Do you have the file\?/.test(roll));
  const askAt = body.indexOf("haveIt");
  const wipeAt = body.indexOf("wildcatCashBalance = 0");
  check("and it asks BEFORE anything is zeroed", askAt !== -1 && wipeAt !== -1 && askAt < wipeAt);
  check("answering no changes nothing", /Nothing was changed/.test(roll));

  // The guarantees that were already right, pinned so they stay.
  check("it still needs a typed confirmation", /START NEW YEAR/.test(roll));
  check("it still warns about receipts awaiting pickup", /awaiting pickup/.test(roll));
  check("it still keeps each closing balance", /cashYearArchives\.push/.test(body));
}

console.log("\n4. The two buttons are still different, and both reachable");
{
  // resetAllStudentCash zeroes balances and nothing else. That is a legitimate
  // separate tool -- it must not quietly grow into a year rollover, and the
  // rollover must not be the only way to zero a balance.
  const reset = fn("async function _resetAllStudentCash() {");
  check("the plain reset still exists", reset.length > 200);
  check("it still demands the typed phrase", /RESET ALL CASH/.test(reset));
  check("it does NOT archive or clear the ledger", !/cashYearArchives/.test(code(reset)));
  check("it writes each zero through the ledger, so a reconcile cannot undo it",
    /recordCashTransaction\(/.test(code(reset)));

  check("both buttons are in the markup", /onclick="startNewSchoolYear\(\)"/.test(html) &&
    /onclick="resetAllStudentCash\(\)"/.test(html));
  // The rollover is the routine one and sits outside the Danger Zone; the bare
  // reset is the emergency lever and sits inside it.
  // The HEADING, not any mention of it: the first match for "Danger Zone" in
  // this file is the comment on the rollover panel saying it is deliberately
  // separate from the Danger Zone, so matching the phrase put the boundary in
  // the wrong place and failed on correct markup.
  const dangerAt = html.indexOf(">&#9888;&#65039; Danger Zone<") >= 0
    ? html.indexOf(">&#9888;&#65039; Danger Zone<")
    : html.search(/<h4[^>]*>[^<]*Danger Zone<\/h4>/);
  check("the Danger Zone heading was located", dangerAt > 0);
  check("the rollover is not in the Danger Zone",
    html.indexOf('onclick="startNewSchoolYear()"') < dangerAt);
  check("the bare reset is", dangerAt < html.indexOf('onclick="resetAllStudentCash()"'));
}

console.log("\n5. Neither destructive button can fail silently");
{
  // THE BUG: "I pressed the blue button but don't see anything happening."
  // Both of these are async functions wired to inline onclick attributes, so
  // nothing awaits them and nothing catches them. Every throw inside became an
  // unhandled promise rejection -- no dialog, no toast, no message -- which is
  // indistinguishable from a dead control on the one button that closes a
  // school year.
  const roll = fn("async function startNewSchoolYear() {");
  check("the rollover wrapper catches", /catch \(e\)/.test(roll));
  check("and says the year was NOT closed", /The year was NOT closed/.test(roll));
  check("and names the error", /e\.message/.test(roll));
  check("and says nothing was changed", /Nothing was changed/.test(roll));
  check("the work moved into an inner function", /_startNewSchoolYear\(\)/.test(roll));

  const inner = fn("async function _startNewSchoolYear() {");
  // The specific shape of the report: index.html current, wildcat-store.js
  // answered from cache from before the rollover existed. An undefined method
  // call there is a TypeError with nowhere to go.
  check("a stale tab is detected by name, not left as a TypeError",
    /typeof window\.WildcatStore\.buildYearEndRollover !== 'function'/.test(inner));
  check("and it tells the operator to hard reload", /Ctrl-Shift-R/.test(inner));
  const guardAt = inner.indexOf("buildYearEndRollover !== 'function'");
  const useAt = inner.indexOf("WildcatStore.buildYearEndRollover({");
  check("the guard runs BEFORE the call it protects",
    guardAt !== -1 && useAt !== -1 && guardAt < useAt);

  const reset = fn("async function resetAllStudentCash() {");
  check("the red button is wrapped too", /catch \(e\)/.test(reset));
  check("and says balances were NOT reset", /Balances were NOT reset/.test(reset));
  check("its work moved into an inner function too", /_resetAllStudentCash\(\)/.test(reset));

  // The net under everything else. This app had no handler of either kind, so
  // every rejected promise nothing awaited went nowhere at all.
  check("unhandled rejections reach the console", /addEventListener\('unhandledrejection'/.test(src));
  check("so do uncaught errors", /addEventListener\('error'/.test(src));
  // Console, not a banner: some rejections are benign and a toast on each
  // would be launch-day noise.
  const net = src.slice(src.indexOf("window.addEventListener('unhandledrejection'"));
  check("the global net is quiet on screen", !/showToast|alert\(/.test(net.slice(0, 400)));
}

console.log("\n6. A reset of ALL balances means all of them");
{
  // MEASURED AGAINST PRODUCTION 2026-09-13, right after the owner pressed the
  // red button. The roster is split in two at load -- `students` is who is
  // enrolled now, `nonEnrolledStudents` is everyone who has left -- and both
  // buttons walked `students` only.
  //
  // 440 students held $6,633,000. The reset cleared 336 and left 104 holding
  // $1,731,150, the largest $46,250. Every one of the 104 had left the school.
  // It looked like it worked, because the only screens that show a balance
  // show the enrolled -- and a student who re-enrols comes back holding it.
  const both = /\(students \|\| \[\]\)\.concat\(nonEnrolledStudents \|\| \[\]\)/;

  const reset = code(fn("async function _resetAllStudentCash() {"));
  check("the reset builds a list of every student", both.test(reset));
  check("and iterates that, not the enrolled array",
    /everyStudent\.forEach\(/.test(reset) && !/^\s*students\.forEach\(/m.test(reset));

  const roll = code(fn("async function _startNewSchoolYear() {"));
  check("the rollover builds the same list", both.test(roll));
  check("the preview counts every student", /students: everyStudent/.test(roll));
  check("and the patches apply to every student", /everyStudent\.forEach\(/.test(roll));
  check("the rollover no longer passes the enrolled-only array",
    !/\{\s*\n\s*students,\s*\n\s*transactions: cashTransactions/.test(roll));

  // THE SUCCESS MESSAGE HAS TO BE TRUE. It was `saveData();` with no await,
  // then an immediate "Successfully reset N accounts" -- announcing a save
  // still in flight, with a count of in-memory edits rather than rows that
  // landed. A half-finished save said nothing at all.
  const resetRaw = fn("async function _resetAllStudentCash() {");
  check("the save is awaited", /await saveData\(\)/.test(resetRaw));
  check("a failed save is reported, not celebrated", /did NOT complete/.test(resetRaw));
  check("and it tells the operator not to trust the balances yet",
    /Check the balances again/.test(resetRaw));
  const awaitAt = resetRaw.indexOf("await saveData()");
  const okAt = resetRaw.indexOf("Reset ${resetCount}");
  check("the claim of success comes AFTER the save", awaitAt !== -1 && okAt !== -1 && awaitAt < okAt);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
