// A Wildcat Cash note is required, not optional.
//
// Asked for on 2026-09-09. The reason it matters is what the note is FOR: a
// cash movement already records the behaviour, the amount and the adult, and
// none of that says what the child actually DID. "Respectful, +5" is a
// category. "held the door for the 6th graders at lunch" is the thing a parent
// can be told and the thing a PBIS review can read six weeks later.
//
// Two things this has to get right:
//   1. all THREE teacher-facing award paths, because a rule enforced on two of
//      three screens is not a rule -- it is a screen people learn to avoid.
//   2. NOT the system-generated movements. A store purchase, a refund and an
//      admin reset write their own notes and have no human to type one.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
new Function(src)();
const R = globalThis.WildcatRoster;

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\n-- the rule --");
{
  check("an empty note is refused", !R.cashNoteVerdict("").ok);
  check("whitespace only is refused", !R.cashNoteVerdict("   ").ok);
  check("null is refused, not treated as a note", !R.cashNoteVerdict(null).ok);
  check("undefined is refused", !R.cashNoteVerdict(undefined).ok);
  // A required field that accepts "." is required in name only. The first
  // person to find that types it every time, and the data is then WORSE than
  // when the field was honestly optional, because it looks filled in.
  check('"." is refused', !R.cashNoteVerdict(".").ok);
  check('"..." is refused -- punctuation is not length', !R.cashNoteVerdict("...").ok);
  check('"!!!!" is refused', !R.cashNoteVerdict("!!!!").ok);
  check('"x" is refused', !R.cashNoteVerdict("x").ok);
  check('"ab" is refused', !R.cashNoteVerdict("ab").ok);

  check('"ran" is accepted -- a short real note must not be blocked', R.cashNoteVerdict("ran").ok);
  check('"sat quietly" is accepted', R.cashNoteVerdict("sat quietly").ok);
  check("a long real note is accepted",
    R.cashNoteVerdict("held the door for the 6th graders at lunch").ok);
  check("the note comes back trimmed", R.cashNoteVerdict("  held the door  ").note === "held the door");
  check("digits count toward length", R.cashNoteVerdict("a1b").ok);
  check("a number-only note is accepted", R.cashNoteVerdict("100").ok);
  check("the threshold is stated, not hidden in a literal", R.CASH_NOTE_MIN === 3);

  check("an empty note and a short one give DIFFERENT reasons",
    R.cashNoteVerdict("").reason !== R.cashNoteVerdict("ab").reason);
  check("the refusal says what to write, not just that it is wrong",
    /what the student did/i.test(R.cashNoteVerdict("").reason));
}

console.log("\n-- all three teacher-facing paths are guarded --");
{
  const fnOf = (name, endMarker) => {
    const a = script.indexOf(name);
    const b = script.indexOf(endMarker, a);
    return a === -1 ? "" : script.slice(a, b > a ? b : a + 4000);
  };
  const bulk   = fnOf("async function awardCashToSelected()", "\n        function ");
  const add    = fnOf("async function confirmAddCash()", "\n        async function confirmRemoveCash");
  const remove = fnOf("async function confirmRemoveCash()", "\n        function ");

  [["Award Cash (bulk)", bulk, "cashNotes"],
   ["Add Cash modal", add, "addCashNotes"],
   ["Remove Cash modal", remove, "removeCashNotes"]].forEach(([label, fn, id]) => {
    check(`${label}: calls the shared rule`, /cashNoteVerdict\(/.test(fn));
    check(`${label}: refuses before writing anything`,
      fn.indexOf("cashNoteVerdict(") < fn.indexOf("recordCashTransaction("));
    check(`${label}: returns rather than continuing`, /if \(!noteVerdict\.ok\) \{[\s\S]{0,220}return;/.test(fn));
    check(`${label}: puts the cursor in the note box`, fn.includes(`getElementById('${id}')`));
  });

  // Three call sites, one rule. Six mentions: three guards, three uses of the
  // verdict object is not required -- what matters is that none is missing.
  check("the rule is referenced at least three times",
    (script.match(/cashNoteVerdict\(/g) || []).length >= 3);
}

console.log("\n-- system-generated movements are NOT blocked --");
{
  // These write their own notes and have no human to type one. Requiring a
  // typed note here would break the store, refunds and the admin reset.
  ["cancelReceipt", "purchaseReward", "resetAllStudentCash", "seedCashTestData"].forEach((name) => {
    const a = script.indexOf(`function ${name}(`);
    const fn = script.slice(a, a + 3000);
    check(`${name} does not demand a typed note`, a !== -1 && !/cashNoteVerdict\(/.test(fn));
  });
}

console.log("\n-- the screens say it is required --");
{
  check("the bulk field no longer says optional", !/id="cashNotes"[^>]*optional/i.test(html));
  check("the bulk field is marked required", /id="cashNotes"[^>]*\brequired\b/.test(html));
  check("its placeholder asks the question", /id="cashNotes"[^>]*What did they do/.test(html));
  check("the panel hint says a note is required", /a note is required/.test(html));

  check("Add Cash no longer says Optional", !/id="addCashNotes"[\s\S]{0,200}Optional/i.test(html));
  check("Add Cash is marked required", /id="addCashNotes"[^>]*\brequired\b/.test(html));
  check("Remove Cash is marked required", /id="removeCashNotes"[^>]*\brequired\b/.test(html));

  // The asterisk convention already used on the referral form.
  const addLabel = html.slice(html.indexOf('id="addCashNotes"') - 260, html.indexOf('id="addCashNotes"'));
  check("Add Cash carries the required asterisk", /class="req"/.test(addLabel));
  const remLabel = html.slice(html.indexOf('id="removeCashNotes"') - 260, html.indexOf('id="removeCashNotes"'));
  check("Remove Cash carries the required asterisk", /class="req"/.test(remLabel));
  check("the bulk input has a label for screen readers", /for="cashNotes"/.test(html));

  // Scoped to the CASH fields. An earlier version of this scanned the whole
  // file and caught the hall-pass encounter-prevention reason box, which is a
  // different feature and was never asked to become required.
  const cashFieldIds = ["cashNotes", "addCashNotes", "removeCashNotes"];
  const optionalNearby = cashFieldIds.filter((id) => {
    const at = html.indexOf(`id="${id}"`);
    return at !== -1 && /optional/i.test(html.slice(Math.max(0, at - 300), at + 300));
  });
  check(
    optionalNearby.length === 0
      ? "no CASH note field still advertises itself as optional"
      : `still says optional: ${optionalNearby.join(", ")}`,
    optionalNearby.length === 0
  );
  check("the hall-pass reason box is left alone -- different feature, not asked for",
    /id="groupReason"/.test(html));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
