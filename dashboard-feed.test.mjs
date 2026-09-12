// What the dashboard's Recent Activity feed calls each thing that happened.
//
// THE BUG THIS CATCHES. The classifier was six regexes over the action text,
// in order, first match wins. That treats the action as prose, and it is not:
// the app writes a fixed, small vocabulary in TWO styles, human ("Awarded
// Tickets") and machine ("cash_deduct"). The regexes were written against the
// human style, so the machine style fell through the cracks -- and cash_deduct
// matched /deduct/ and came out labelled "Reversed".
//
// A cash deduction is an adult taking money off a child for a behaviour, with
// a note the app refuses to save without. A reversal is somebody undoing an
// award. Those are different events: one is a disciplinary record a parent may
// ask about, the other is a data fix. The school reported it the plain way --
// a staff member deducted from a student, and the feed said it was reversed.
//
// MEASURED AGAINST PRODUCTION, 2026-09-11: 12,535 audit entries, 14 distinct
// action strings, 5 of them labelled wrong.
//
// AND THE SECOND LESSON, which is why this file is written the way it is: the
// first fix was built by reading the action NAMES, and got cash_deduct wrong
// AGAIN in the other direction (filed as a purchase -- it is not, the purchase
// is reward_redemption) and Weekly Leaderboard Bonus wrong too (it buys a
// jackpot entry, not a ticket; its own category field says 'Bonus Jackpot
// Entry'). So every expectation below was read off the addToAuditLog CALL
// SITE. If you add a row, open the call site. The names mislead.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./wildcat-ui.css", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  (" + d + ")" : ""}`); }
};

/** The closing brace matching the `{` at or after `from`. */
function blockEnd(src, from) {
  let i = src.indexOf("{", from), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return i + 1;
  }
  throw new Error("unbalanced from " + from);
}

// Run the real classifier rather than a copy of it. Sliced by brace matching,
// not by a character window: a distance-based slice passes for the wrong
// reason the moment somebody adds a line.
const start = script.indexOf("const FEED_CATS = {");
const fnAt = script.indexOf("function wcFeedCat(entry) {", start);
const slice = script.slice(start, blockEnd(script, fnAt));
const wcFeedCat = new Function(slice + "\nreturn wcFeedCat;")();
const label = (action) => wcFeedCat({ action }).label;

// ---------------------------------------------------------------------------
console.log("\n1. The bug the school reported: a deduction is not a reversal");
{
  // script.js:8498 -- staff pick a negative behaviour, write a required note,
  // and the student's balance goes down. Nobody undid anything.
  check("cash_deduct does not read as Reversed", label("cash_deduct") !== "Reversed", label("cash_deduct"));
  check("it says what it is", label("cash_deduct") === "Cash Deducted", label("cash_deduct"));
  check("...and it is not filed under the reversals chip", wcFeedCat({ action: "cash_deduct" }).key === "deduct");

  // And it is not the same thing as earning, which is what a single shared
  // "Wildcat Cash" label made it look like -- the amount is stored with
  // Math.abs(), so "5" for a deduction and "5" for an award render alike.
  check("earning and deducting are not the same label",
    label("cash_award") !== label("cash_deduct"), label("cash_award"));
  check("cash_award reads as Cash Earned", label("cash_award") === "Cash Earned", label("cash_award"));

  // The word that started it. Anything ending in _deduct is money out, and
  // the fallback must not reach for "Reversed" either.
  check("an unlisted *_deduct action still does not read as Reversed",
    label("store_deduct") !== "Reversed", label("store_deduct"));
  check("it lands on the deduction label", label("store_deduct") === "Cash Deducted", label("store_deduct"));
}

// ---------------------------------------------------------------------------
console.log("\n2. Every action string in production, by name");
{
  // Counts from the 2026-09-11 mirror. Every label here was read off the
  // addToAuditLog call at the line given, not inferred from the string.
  const LIVE = [
    ["Awarded Tickets",               "Tickets",        11461, "14383 tickets for a behaviour"],
    ["Qualified for Wildcat Jackpot", "Jackpot Entry",    525, "15280 reached the weekly threshold"],
    ["Deleted Ticket Entry",          "Reversed",         249, "7908 an award record deleted"],
    ["Raffle Winner",                 "Winner",           143, "14692 drawn"],
    ["Backup Exported",               "System",            59, "4297 manual backup"],
    ["Weekly Leaderboard Bonus",      "Jackpot Entry",     40, "15311 category 'Bonus Jackpot Entry'"],
    ["cash_award",                    "Cash Earned",       16, "8387 positive behaviour"],
    ["Wildcat Jackpot Winner",        "Winner",            12, "15115 grand prize"],
    ["↩️ UNDID Award",      "Reversed",           9, "14575 the undo button"],
    ["reward_redemption",             "Purchase",           6, "27150 'Purchased X, receipt Y'"],
    ["reward_fulfilled",              "Purchase",           6, "26728 'Handed over X'"],
    ["Reset Wildcat Jackpot Cycle",   "System",             5, "15428 cycle N to N+1"],
    ["cash_deduct",                   "Cash Deducted",      3, "8498 negative behaviour, note required"],
    ["Admin Correction",              "Correction",         1, "5924 re-tag, 6007 remove"],
  ];
  LIVE.forEach(([action, want, n, where]) => {
    check(`${action} -> ${want}  [${where}]`, label(action) === want, `got ${label(action)}, ${n} in the log`);
  });

  // Written by the app but not yet fired in production. Untested here they
  // would be the next cash_deduct.
  const UNFIRED = [
    ["Backup Restored",        "System",   "4367"],
    ["reward_cancelled",       "Reversed", "26765 cancelled and refunded"],
    ["reset_all_student_cash", "System",   "27395"],
    ["school_year_rollover",   "System",   "27308 year-end close"],
  ];
  UNFIRED.forEach(([action, want, where]) => {
    check(`${action} -> ${want}  [${where}, not yet fired]`, label(action) === want, label(action));
  });
}

// ---------------------------------------------------------------------------
console.log("\n3. The table covers everything the app can write");
{
  // The whole point of an exact table is that it is exhaustive. If somebody
  // adds an addToAuditLog call with a new string, this fails -- which is the
  // reminder to go and read that call site, rather than letting the fallback
  // guess in the feed. It is how school_year_rollover was found.
  const written = new Set();
  for (const m of script.matchAll(/addToAuditLog\(\s*'([^']+)'/g)) written.add(m[1]);
  for (const m of script.matchAll(/\baction:\s*'([^']+)'/g)) written.add(m[1]);
  check("found the audit vocabulary in script.js", written.size >= 18, String(written.size));

  const tableAt = script.indexOf("const FEED_ACTION_CATS = {");
  const table = script.slice(tableAt, blockEnd(script, tableAt));
  const flatten = (a) => a.toLowerCase().replace(/[^a-z0-9_]+/g, " ").trim();
  const unlisted = [...written].filter((a) => !table.includes(`'${flatten(a)}'`));
  check("every action string the app writes is in FEED_ACTION_CATS", unlisted.length === 0, unlisted.join(" | "));
}

// ---------------------------------------------------------------------------
console.log("\n4. The fallback guesses quietly");
{
  // "Reversed" says an award was undone. A word that merely co-occurs with
  // reversals must not reach it; a word that MEANS it must.
  check("an unknown action is not called Reversed by default", label("Something New Happened") !== "Reversed");
  check("an unknown action lands somewhere", typeof label("Something New Happened") === "string");
  check("'Removed Tickets' is a reversal", label("Removed Tickets") === "Reversed");
  check("'Voided Award' is a reversal", label("Voided Award") === "Reversed");
  check("a refund is a reversal", label("cash_refunded") === "Reversed", label("cash_refunded"));

  // /jackpot/ and /raffle/ used to mean "Winner" all by themselves, which is
  // how 565 entries where nobody won anything came to say somebody had.
  check("the word jackpot alone does not make a winner", label("Jackpot Threshold Changed") !== "Winner", label("Jackpot Threshold Changed"));
  check("the word raffle alone does not make a winner", label("Raffle Settings Saved") !== "Winner", label("Raffle Settings Saved"));
  check("'winner' does", label("Bonus Winner") === "Winner");

  // Underscores have to read as word breaks or every machine-style name
  // falls to the default.
  check("a machine name is split on its underscores", label("hall_pass_issued") === "Claw Pass", label("hall_pass_issued"));
  check("an unlisted referral action is Discipline", label("referral_filed") === "Discipline", label("referral_filed"));
  check("an unlisted purchase is a Purchase", label("store_purchase") === "Purchase", label("store_purchase"));
}

// ---------------------------------------------------------------------------
console.log("\n5. A deduction shows its minus sign");
{
  // addToAuditLog is called with Math.abs(amount) at both deduct sites, so
  // the stored record does not carry its own sign: "5" off a child renders
  // identically to "5" given to one. The category knows the direction.
  const render = script.slice(script.indexOf("const cat = wcFeedCat(e);"));
  const body = render.slice(0, render.indexOf("</div>`;"));
  check("the count is signed by category, not by the stored number",
    /cat\.key === 'deduct'[\s\S]{0,60}&minus;/.test(body));
  check("and only when the stored number is positive, so it cannot double up",
    /Number\(n\) > 0/.test(body));

  // Both writers really do strip the sign -- if that ever changes, the
  // renderer would be adding a second minus and this is the warning.
  const deductCall = script.slice(script.indexOf("addToAuditLog('cash_deduct'"));
  check("the deduct writer still stores an absolute amount",
    /Math\.abs\(amount\)/.test(deductCall.slice(0, 300)));
}

// ---------------------------------------------------------------------------
console.log("\n6. Shape: nothing can render blank");
{
  const cats = new Function(slice + "\nreturn FEED_CATS;")();
  const keys = Object.keys(cats);
  check("there are eleven categories", keys.length === 11, String(keys.length));
  keys.forEach((k) => {
    const c = cats[k];
    check(`${k} carries key, label, tag and icon`,
      c.key === k && !!c.label && /^wu-tag-[a-z]+$/.test(c.tag) && /^&#\d+;$/.test(c.icon));
    // A tag class with no rule is an unstyled pill: visible, but wrong, and
    // nothing errors.
    check(`${k}'s tag has a rule in wildcat-ui.css`, css.includes("." + c.tag), c.tag);
  });

  // Two categories share .wu-tag-cash deliberately. Every LABEL must still be
  // distinct, or a chip and a tag stop agreeing about what they select.
  const labels = keys.map((k) => cats[k].label);
  check("no two categories share a label", new Set(labels).size === labels.length, labels.join(","));

  // A missing/empty/odd action must not throw inside a render loop.
  [undefined, null, "", 0, {}, [], "   "].forEach((a, i) => {
    let ok = false;
    try { ok = !!wcFeedCat({ action: a }).label; } catch (e) { ok = false; }
    check(`a junk action (#${i}) still classifies without throwing`, ok);
  });
  let noEntry = false;
  try { noEntry = !!wcFeedCat(undefined).label; } catch (e) { noEntry = false; }
  check("no entry at all still classifies", noEntry);
}

// ---------------------------------------------------------------------------
console.log("\n7. Recent Activity, in English");
{
  // "Recently / Activity" -- the eyebrow is an adverb and the title a noun,
  // so the panel read as broken English. Every other head on this dashboard
  // is an adjective over a noun phrase.
  const head = html.slice(html.indexOf('<aside class="wu-feed-col">'), html.indexOf('id="dashFeed"'));
  check("the panel says Recent, not Recently", /<p class="wu-eyebrow">Recent<\/p>/.test(head));
  check("over Activity", /<h3 class="wu-panel-title">Activity<\/h3>/.test(head));
  check("nothing says 'Recently Activity' any more", !/>Recently</.test(html));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
