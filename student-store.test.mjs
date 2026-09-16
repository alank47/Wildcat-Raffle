// The Student Rewards Store panel.
//
// WHAT THIS REPLACES. store-coming-soon.test.mjs pinned a static card reading
// "Coming soon", and pinned it hard: no arguments, no network call, no live
// data, because "a panel which can fail is a panel that must SAY it failed"
// and that one could not fail. The store has now shipped, so the panel reads
// live data and CAN fail -- which means the old file's central assertion is
// exactly backwards for the thing that replaced it, and the guarantees have to
// be restated rather than relaxed.
//
// THE MEASUREMENT THAT SHAPED IT. Against production on 2026-09-16: 29 of 620
// students could afford the cheapest reward and nobody could afford five of
// the six; median balance $100, highest in the school $900. The owner then
// switched five rewards off, leaving one at $2,500 that nobody can afford yet,
// and sets prices from the balance distribution shortly before a release. So
// the panel must read correctly when NOTHING is affordable -- that is the
// normal case, not the edge case -- and it must never hide what it cannot
// sell, because 591 of 620 would open an empty room.
//
// Run: npm test

import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const server = readFileSync(new URL("./convex/studentStore.ts", import.meta.url), "utf8");
// Comments stripped before any "this does not appear" assertion.
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  (" + d + ")" : ""}`); }
};

const fn = code.slice(code.indexOf("function wpStorePanel()"),
                      code.indexOf("let _wpBuyInFlight"));

console.log("\n-- the panel is in the portal, where the balance provokes the question --");
{
  check("wpStorePanel is defined", fn.length > 400);
  check("it is rendered into the dashboard", /\+ wpStorePanel\(\) \+/.test(code));
  // The store sits with the cash panels rather than at the bottom: it answers
  // "what is this money for", which is what the balance above it provokes.
  // Forward from the return, for the same reason as the buy slice below:
  // "attendance;" occurs earlier in the file, so slicing TO it ran backwards.
  const orderAt = code.indexOf("return passPanel + money +");
  const order = code.slice(orderAt, orderAt + 200);
  check("it sits after the Wildcat Cash balance panel",
    order.indexOf("money") < order.indexOf("wpStorePanel"));
  check("and before the schedule and attendance panels",
    order.indexOf("wpStorePanel") < order.indexOf("schedule"));
  check("it is filed under Wildcat Cash, like the balance and the board",
    /wpPanel\('Wildcat Cash', 'Student Rewards Store'/.test(fn));
  check("it takes no arguments, reading the module's last answer instead",
    /function wpStorePanel\(\)/.test(fn));
}

console.log("\n-- a panel that can fail must say it failed --");
{
  // The old card could not fail, so it needed none of this. This one loads in
  // the portal's Promise.allSettled beside the leaderboard, whose lesson was
  // that rendering empty states "there are no rewards" -- a different and
  // wrong claim from "this did not load".
  check("a load error is its own state", /_wpStoreError/.test(fn));
  check("and it says the rest of the page is unaffected",
    /balance and\s*\n?\s*'?\s*'?cards above are unaffected/.test(fn) || /unaffected/.test(fn));
  check("a missing answer renders as loading, not as empty",
    /if \(!_wpStore\) \{/.test(fn) && /Loading the store/.test(fn));
  check("the loader captures both the value and the rejection",
    /_wpStore = results\[4\]\.status === 'fulfilled'/.test(code)
    && /_wpStoreError = results\[4\]\.status === 'rejected'/.test(code));
  check("and it asks the server for the student's own store",
    /convexQuery\('studentStore:myStore', \{\}, token\)/.test(code));
}

console.log("\n-- a closed store is not an empty one --");
{
  check("closed is its own state", /if \(!_wpStore\.storeOpen\)/.test(fn));
  check("and the server's reason is shown when it set one",
    /_wpStore\.closedReason/.test(fn));
  check("an open store with nothing flagged says so rather than rendering blank",
    /if \(!forSale\.length\)/.test(fn) && /No rewards are in the student store yet/.test(fn));
  check("and points them at a person", /ask in the office|at the office/i.test(fn));
}

console.log("\n-- it shows what a student cannot afford --");
{
  // THE NORMAL CASE. Hiding the unaffordable would show most of the school an
  // empty room, and "you need $400 more" is a goal where a missing row is
  // nothing at all.
  check("every flagged reward is listed, affordable or not",
    /items\.filter\(function \(it\) \{ return it\.inStudentStore; \}\)/.test(fn));
  check("the refusal reason is rendered where the button would be",
    /wp-buy-why/.test(fn) && /it\.why/.test(fn));
  check("progress toward the cost is shown", /wp-store-bar/.test(fn) && /it\.progress/.test(fn));
  check("and the bar is clamped, so a bad figure cannot overflow it",
    /Math\.max\(0, Math\.min\(1,/.test(fn));
  check("remaining stock is shown when the reward is limited",
    /it\.stock == null/.test(fn) && /wp-stock/.test(fn));

  // A hairline rather than dimming the rest: a greyed-out list of things you
  // cannot have is a worse screen than a plain one.
  check("the affordable row is marked, not the others dimmed",
    /is-afford/.test(fn) && /\.wp-store-row\.is-afford/.test(css));
  check("the styles it needs exist",
    [".wp-store", ".wp-store-row", ".wp-store-bar", ".wp-store-cost",
     ".wp-buy-why", ".wp-stock", ".wp-store-foot"].every((c) => css.includes(c)));

  // THE ROW STACKS AT EVERY WIDTH, and this pins the reason. A .wp-dash panel
  // is repeat(auto-fit, minmax(268px, 1fr)) -- narrow BECAUSE the viewport is
  // wide -- so three columns beside each other left the reward name running
  // down the card one word per line. My first version stacked them only under
  // max-width: 999px, a query that never fires where the panel is narrowest.
  const rowRule = css.slice(css.indexOf(".wp-store-row {"), css.indexOf(".wp-store-foot"));
  check("the row is one column by default",
    /grid-template-columns: 1fr;/.test(rowRule), rowRule.replace(/\s+/g, " "));
  check("and nothing re-columns it in a viewport query",
    !/\.wp-store-row \{ grid-template-columns: 1fr auto/.test(css));
  check("the cost and the action share a line beneath the name",
    /wp-store-foot/.test(fn));
  // Six rewards with prices and bars are the widest thing on the page; one
  // column of a five-column grid is what made the layout hard to begin with.
  check("and the panel spans the whole dash row, as the tiles already do",
    /\.wp-dash > \.wp-panel:has\(\.wp-store\) \{ grid-column: 1 \/ -1; \}/.test(css));
}

console.log("\n-- a child reads this, so everything is escaped --");
{
  const interps = fn.match(/\+ [^+;]*\+/g) || [];
  const rawText = interps.filter((x) =>
    /\bit\.(name|description|why)\b|closedReason/.test(x) && !/wpEsc/.test(x));
  check("no reward name, description or reason is rendered unescaped",
    rawText.length === 0, rawText.join(" | "));
  check("and the balance in the eyebrow is escaped too",
    /wpEsc\(String\(_wpStore\.balance/.test(fn));
}

console.log("\n-- buying: one token per press, and no price from the browser --");
{
  // Sliced FORWARD from the handler, not to a landmark that sits earlier in the
  // file: wpBoardPanel is at ~17785 and this handler at ~17995, so slicing
  // between them produced an empty string and thirteen assertions "failed"
  // against nothing. A slice whose end precedes its start is not a test.
  const buyAt = code.indexOf("let _wpBuyInFlight");
  const buy = code.slice(buyAt, buyAt + 4000);
  check("the buy button is delegated, so a re-render keeps working",
    /closest\('\[data-wp-buy\]'\)/.test(buy));
  check("a second press while one is in flight is refused",
    /if \(_wpBuyInFlight\) return;/.test(buy) && /_wpBuyInFlight = true;/.test(buy));
  check("and the flag is released on every path", /\} finally \{[\s\S]{0,200}_wpBuyInFlight = false;/.test(buy));
  check("it confirms with the name and the price before spending",
    /showConfirm\('Buy ' \+ name \+ ' for \$' \+ cost/.test(buy));

  // ONE TOKEN PER PRESS. The server keys idempotency on it, so a double-tap
  // returns the first receipt rather than charging twice.
  check("an attempt token is minted per press", /const attemptId =/.test(buy));
  check("preferring crypto.randomUUID", /crypto\.randomUUID/.test(buy));
  check("the mutation gets the reward, a quantity and the token",
    /\{ rewardId: id, quantity: 1, attemptId: attemptId \}/.test(buy));
  check("and NO cost, total or balance",
    !/cost:/.test(buy.slice(buy.indexOf("convexMutation"), buy.indexOf("convexMutation") + 260))
    && !/total:/.test(buy.slice(buy.indexOf("convexMutation"), buy.indexOf("convexMutation") + 260)));

  check("an already-bought answer reads as done, not failed", /res\.alreadyBought/.test(buy));
  check("a refusal is shown rather than swallowed", /res\.ok !== true/.test(buy) && /showAlert/.test(buy));
  check("the receipt code is shown, since that is what they take to the office",
    /res\.receiptId/.test(buy));
  check("and the portal re-renders through its one drawing path",
    /wpPollPassOnce\(true\)/.test(buy));
}

console.log("\n-- the server side a student can reach --");
{
  check("myStore resolves the student from their own token",
    /export const myStore = query\(\{[\s\S]{0,200}requireStudentSelf\(ctx\)/.test(server));
  check("purchase does too", /export const purchase = mutation\(\{[\s\S]{0,400}requireStudentSelf\(ctx\)/.test(server));
  const pArgs = server.slice(server.indexOf("export const purchase = mutation({"),
                             server.indexOf("handler", server.indexOf("export const purchase = mutation({")));
  check("and it accepts no student id, so nobody can buy as somebody else",
    !/studentNumber|studentId/.test(pArgs), pArgs.replace(/\s+/g, " "));
  check("nor a price", !/cost|total|balance/i.test(pArgs));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
