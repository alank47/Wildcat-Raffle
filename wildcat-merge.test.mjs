// Merging a stale tab's list against what is already stored.
//
// THE SCENARIO THIS PINS, reported from real use:
//
//   Teacher A files a referral. Teacher B has had the app open since the
//   morning, so B's copy predates it. B does anything that triggers a save,
//   and the whole-document write replaces the stored list with B's older one.
//   A's referral is gone, with no error, because B's browser was simply
//   confident about a list that was out of date.
//
// The app used to reload every tab every five minutes to keep that window
// small. That narrowed the problem instead of closing it, and cost a
// submitted referral when a reload landed mid-save.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-merge.js", import.meta.url), "utf8");
new Function(src)();
const M = globalThis.WildcatMerge;

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

const ref = (id, over = {}) =>
  Object.assign({ id, status: "open", submittedAt: "2026-08-19T09:00:00.000Z" }, over);

console.log("\nThe stale tab scenario");
{
  // Stored has A's new referral. B's tab predates it.
  const stored = [ref("REF1"), ref("REF2"), ref("REF3")];
  const staleLocal = [ref("REF1"), ref("REF2")];

  const merged = M.mergeById(stored, staleLocal);
  check("the referral the stale tab never saw SURVIVES", merged.length === 3);
  check("and it is the right one", merged.some((r) => r.id === "REF3"));

  const report = M.mergeReport(stored, staleLocal, merged);
  check("the report names what a whole-document write would have destroyed",
    report.wouldHaveLost.join() === "REF3");
  check("and counts it", report.keptFromStorage === 1);
}

console.log("\nThe submitting tab's new row still lands");
{
  const stored = [ref("REF1")];
  const local = [ref("REF1"), ref("REF2")];
  const merged = M.mergeById(stored, local);
  check("a newly filed referral is added", merged.length === 2);
  check("the report counts it as added by this tab",
    M.mergeReport(stored, local, merged).addedByThisTab === 1);
}

console.log("\nBoth sides changed: the newer edit wins");
{
  // An admin closed REF1. A stale tab still holds it open.
  const closed = ref("REF1", { status: "closed", closedAt: "2026-08-19T15:00:00.000Z" });
  const stillOpen = ref("REF1");

  check("a closure beats an older open copy",
    M.mergeById([closed], [stillOpen])[0].status === "closed");
  check("regardless of which side it arrives on",
    M.mergeById([stillOpen], [closed])[0].status === "closed");

  // And the reverse: this tab did the closing, storage has the old one.
  const local = [ref("REF1", { status: "closed", updatedAt: "2026-08-19T16:00:00.000Z" })];
  check("this tab's newer close is not discarded",
    M.mergeById([stillOpen], local)[0].status === "closed");
}

console.log("\nTimestamp resolution");
{
  check("updatedAt is preferred over older stamps",
    M.lastTouched({ submittedAt: "2026-08-19T09:00:00Z", updatedAt: "2026-08-19T17:00:00Z" }) ===
      Date.parse("2026-08-19T17:00:00Z"));
  check("a row with only submittedAt still orders",
    M.lastTouched({ submittedAt: "2026-08-19T09:00:00Z" }) === Date.parse("2026-08-19T09:00:00Z"));
  check("a row with no stamps at all is zero, not NaN",
    M.lastTouched({}) === 0);
  check("an unparseable stamp is zero, not NaN",
    M.lastTouched({ updatedAt: "not a date" }) === 0);

  // Rows predating updatedAt must not all collapse to zero and let order decide.
  const older = ref("REF1", { closedAt: "2026-08-19T10:00:00.000Z" });
  const newer = ref("REF1", { closedAt: "2026-08-19T14:00:00.000Z", adminNotes: "later" });
  check("legacy rows still resolve by their closedAt",
    M.mergeById([older], [newer])[0].adminNotes === "later");
}

console.log("\nStability and safety");
{
  const rows = [ref("REF1"), ref("REF2")];
  check("merging a list with itself changes nothing", M.mergeById(rows, rows).length === 2);
  check("a tie keeps what is already stored, so repeat saves are stable",
    M.mergeById([ref("REF1", { adminNotes: "stored" })], [ref("REF1", { adminNotes: "local" })])[0]
      .adminNotes === "stored");

  check("neither input is mutated",
    (() => { const s = [ref("REF1")], l = [ref("REF2")]; M.mergeById(s, l); return s.length === 1 && l.length === 1; })());

  check("an empty stored list accepts everything local", M.mergeById([], rows).length === 2);
  check("an empty local list preserves everything stored", M.mergeById(rows, []).length === 2);
  check("null inputs do not throw", M.mergeById(null, null).length === 0);

  // Dropping a malformed row is the same outcome this function prevents.
  const malformed = [{ status: "open", submittedAt: "2026-08-19T09:00:00Z" }];
  check("a row with no id is KEPT rather than silently dropped",
    M.mergeById([], malformed).length === 1);
  check("and does not collide with another id-less row",
    M.mergeById(malformed, [{ status: "closed" }]).length === 2);
}

console.log("\nOrder");
{
  const stored = [ref("REF1"), ref("REF2")];
  const local = [ref("REF3")];
  const merged = M.mergeById(stored, local);
  check("stored rows keep their order, new ones append",
    merged.map((r) => r.id).join() === "REF1,REF2,REF3");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
