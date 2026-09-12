// What the dashboard's Recent Activity feed calls each thing that happened.
//
// THE BUG THIS CATCHES. The classifier was six regexes over the action text,
// in order, first match wins. That treats the action as prose, and it is not:
// the app writes a fixed, small vocabulary in TWO styles, human ("Awarded
// Tickets") and machine ("cash_deduct"). The regexes were written against the
// human style, so the machine style fell through the cracks -- and a student
// SPENDING their Wildcat Cash writes cash_deduct, which matched /deduct/ and
// came out labelled "Reversed". A parent reading that is told an adult took
// something back from their child, when the child bought something.
//
// MEASURED AGAINST PRODUCTION, 2026-09-11: 12,535 audit entries, 14 distinct
// action strings, 5 of them labelled wrong -- 3 purchases as "Reversed", 249
// ticket deletions as "Tickets", 525 jackpot qualifications and 5 cycle resets
// as "Winner". Every one of those 14 is pinned below by name.
//
// This file exists because a label is not cosmetic. It is the sentence the
// school reads back to a family, and the chip they filter by when they go
// looking for reversals.
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
console.log("\n1. The bug the school reported: a purchase is not a reversal");
{
  // cash_deduct is a student spending what they earned. Three of these were
  // sitting in the feed labelled "Reversed" on the day this was reported.
  check("cash_deduct reads as Wildcat Cash, not Reversed", label("cash_deduct") === "Wildcat Cash", label("cash_deduct"));
  check("...and it is not filed under the reversals chip", wcFeedCat({ action: "cash_deduct" }).key === "cash");

  // The word that did it. Anything ending in _deduct is money moving, not an
  // adult undoing an award, so the fallback must not reach for "Reversed"
  // either -- an action added next year will go through the fallback.
  check("an unlisted *_deduct action still does not read as Reversed",
    label("store_deduct") !== "Reversed", label("store_deduct"));
  check("nor does an unlisted *_deduct read as Tickets",
    label("store_deduct") === "Wildcat Cash", label("store_deduct"));
}

// ---------------------------------------------------------------------------
console.log("\n2. Every action string in production, by name");
{
  // Counts are from the 2026-09-11 mirror, kept here so the next person can
  // see which of these actually matter and which are once-a-year.
  const LIVE = [
    ["Awarded Tickets",               "Tickets",       11461],
    ["Qualified for Wildcat Jackpot", "Jackpot Entry",   525],
    ["Deleted Ticket Entry",          "Reversed",        249],
    ["Raffle Winner",                 "Winner",          143],
    ["Backup Exported",               "System",           59],
    ["Weekly Leaderboard Bonus",      "Tickets",          40],
    ["cash_award",                    "Wildcat Cash",     16],
    ["Wildcat Jackpot Winner",        "Winner",           12],
    ["↩️ UNDID Award",      "Reversed",          9],
    ["reward_redemption",             "Wildcat Cash",      6],
    ["reward_fulfilled",              "Wildcat Cash",      6],
    ["Reset Wildcat Jackpot Cycle",   "System",            5],
    ["cash_deduct",                   "Wildcat Cash",      3],
    ["Admin Correction",              "Correction",        1],
  ];
  LIVE.forEach(([action, want, n]) => {
    check(`${action} -> ${want} (${n} in the log)`, label(action) === want, label(action));
  });

  // Written by the app but not yet fired in production. Untested here they
  // would be the next cash_deduct.
  const UNFIRED = [
    ["Backup Restored",        "System"],
    ["reward_cancelled",       "Reversed"],
    ["reset_all_student_cash", "System"],
    ["school_year_rollover",    "System"],
  ];
  UNFIRED.forEach(([action, want]) => {
    check(`${action} -> ${want} (written, not yet fired)`, label(action) === want, label(action));
  });
}

// ---------------------------------------------------------------------------
console.log("\n3. The table covers everything the app can write");
{
  // The whole point of an exact table is that it is exhaustive. If somebody
  // adds an addToAuditLog call with a new string, this fails -- which is the
  // reminder to file it, rather than letting the fallback guess in the feed.
  const written = new Set();
  for (const m of script.matchAll(/addToAuditLog\(\s*'([^']+)'/g)) written.add(m[1]);
  for (const m of script.matchAll(/\baction:\s*'([^']+)'/g)) written.add(m[1]);
  check("found the audit vocabulary in script.js", written.size >= 15, String(written.size));

  const tableAt = script.indexOf("const FEED_ACTION_CATS = {");
  const table = script.slice(tableAt, blockEnd(script, tableAt));
  const flatten = (a) => a.toLowerCase().replace(/[^a-z0-9_]+/g, " ").trim();
  const unlisted = [...written].filter((a) => !table.includes(`'${flatten(a)}'`));
  check("every action string the app writes is in FEED_ACTION_CATS", unlisted.length === 0, unlisted.join(" | "));
}

// ---------------------------------------------------------------------------
console.log("\n4. The fallback guesses quietly");
{
  // "Reversed" is the only label that accuses an adult of taking something
  // away from a child. A word that merely co-occurs with reversals must not
  // reach it; a word that MEANS it must.
  check("an unknown action is not called Reversed by default", label("Something New Happened") !== "Reversed");
  check("an unknown action lands somewhere", typeof label("Something New Happened") === "string");
  check("'Removed Tickets' is a reversal", label("Removed Tickets") === "Reversed");
  check("'Voided Award' is a reversal", label("Voided Award") === "Reversed");

  // /jackpot/ and /raffle/ used to mean "Winner" all by themselves, which is
  // how 530 entries where nobody won anything came to say somebody had.
  check("the word jackpot alone does not make a winner", label("Jackpot Threshold Changed") !== "Winner", label("Jackpot Threshold Changed"));
  check("the word raffle alone does not make a winner", label("Raffle Settings Saved") !== "Winner", label("Raffle Settings Saved"));
  check("'winner' does", label("Bonus Winner") === "Winner");

  // Underscores have to read as word breaks or every machine-style name
  // falls to the default.
  check("a machine name is split on its underscores", label("hall_pass_issued") === "Claw Pass", label("hall_pass_issued"));
  check("an unlisted referral action is Discipline", label("referral_filed") === "Discipline", label("referral_filed"));
}

// ---------------------------------------------------------------------------
console.log("\n5. Shape: nothing can render blank");
{
  const cats = new Function(slice + "\nreturn FEED_CATS;")();
  const keys = Object.keys(cats);
  check("there are nine categories", keys.length === 9, String(keys.length));
  keys.forEach((k) => {
    const c = cats[k];
    check(`${k} carries key, label, tag and icon`,
      c.key === k && !!c.label && /^wu-tag-[a-z]+$/.test(c.tag) && /^&#\d+;$/.test(c.icon));
    // A tag class with no rule is an unstyled pill: visible, but wrong, and
    // nothing errors.
    check(`${k}'s tag has a rule in wildcat-ui.css`, css.includes("." + c.tag), c.tag);
  });

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
console.log("\n6. Recent Activity, in English");
{
  // "Recently / Activity" -- the eyebrow is an adverb and the title a noun,
  // so the panel read as broken English. Every other panel head on this
  // dashboard is an adjective over a noun phrase.
  const head = html.slice(html.indexOf('<aside class="wu-feed-col">'), html.indexOf('id="dashFeed"'));
  check("the panel says Recent, not Recently", /<p class="wu-eyebrow">Recent<\/p>/.test(head));
  check("over Activity", /<h3 class="wu-panel-title">Activity<\/h3>/.test(head));
  check("nothing says 'Recently Activity' any more", !/>Recently</.test(html));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
