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
  // To the END of the listener, not a fixed width: the handler grew on
  // 2026-09-28 (retry with the same token, the receipt dialog) and a fixed
  // window silently stopped reaching the finally block.
  const buyAt = code.indexOf("let _wpBuyInFlight");
  const buy = code.slice(buyAt, code.indexOf("function wpDashboard(", buyAt));
  // THE BUTTON MUST LOOK PRESSABLE ON A WHITE CARD. .wp-btn is the wallet's
  // button -- rgba(255,255,255,0.16) with color:inherit -- which on the light
  // desk view is dark text on white with no chrome at all: the word "Buy",
  // indistinguishable from the text beside it. A control nobody can see is a
  // control nobody clicks, which is how "clicking buy does nothing" starts.
  check("the buy button does not wear the dark wallet's button class",
    !/class="wp-btn wp-buy"/.test(code));
  check("and .wp-buy carries its own visible chrome",
    /\.wp-buy \{[^}]*background: #2E7D52/.test(css) && /\.wp-buy \{[^}]*color: #fff/.test(css));
  check("with a focus ring, since it is reachable by keyboard",
    /\.wp-buy:focus-visible/.test(css));

  check("the buy button is delegated, so a re-render keeps working",
    /closest\('\[data-wp-buy\]'\)/.test(buy));

  // REGISTERED FROM THE RENDER PATH, NOT AT LOAD. "Clicking buy does nothing"
  // survived two fixes with the button proven present (the owner ran
  // querySelectorAll('[data-wp-buy]').length and got 1), proven visible, and
  // the handler proven to log any throw -- and nothing in the portal swallows
  // the click. That leaves a listener that never registered: a bare
  // document.addEventListener at the top level of a 34,000-line file runs only
  // if evaluation reaches that line, and this file has a documented history of
  // a load-time throw killing every statement below it.
  check("the wiring is a function, not a bare top-level statement",
    /function wpWireBuyButtons\(\)/.test(code));
  check("called from the one path the portal is drawn by",
    /_wpStoreError = results\[4\][\s\S]{0,200}wpWireBuyButtons\(\);/.test(code));
  check("and it is idempotent, or the watch timer stacks a listener a minute",
    /if \(_wpBuyWired\) return;/.test(code) && /_wpBuyWired = true;/.test(code));
  check("it says so in the console, so the next report is conclusive",
    /buy buttons wired/.test(code));

  // CAPTURE PHASE. A bubble listener on document is last in line: anything
  // calling stopPropagation on an ancestor wins, and the portal has tap and
  // swipe handlers on the card shell. Reported as "clicking buy does nothing"
  // with the button and its attribute rendering correctly.
  check("the listener is registered on the capture phase",
    /\}, true\);/.test(buy));

  // AND IT CANNOT FAIL IN SILENCE. An async listener that throws produces an
  // unhandled rejection: no error on screen, the button just sits there, and
  // neither a child nor the owner can report anything more useful than
  // "nothing happened".
  check("every failure is surfaced to the student",
    /catch \(e\) \{[\s\S]{0,400}console\.error\('\[store\] buy failed:'/.test(buy));
  check("and it says nothing was charged, which is true at that point",
    /Nothing was charged/.test(buy));
  check("a second press while one is in flight is refused",
    /if \(_wpBuyInFlight\) return;/.test(buy) && /_wpBuyInFlight = true;/.test(buy));
  check("and the flag is released on every path", /\} finally \{[\s\S]{0,200}_wpBuyInFlight = false;/.test(buy));
  check("it confirms with the name and the price before spending",
    /showConfirm\('Buy ' \+ name \+ ' for \$' \+ cost/.test(buy));

  // ONE TOKEN PER PRESS. The server keys idempotency on it, so a double-tap
  // returns the first receipt rather than charging twice.
  check("an attempt token is minted per press", /const attemptId =/.test(buy));
  check("preferring crypto.randomUUID", /crypto\.randomUUID/.test(buy));
  // And the price the button SHOWED, which the server only ever uses to
  // refuse (price_changed) -- never to charge. See studentStoreRules.
  check("the mutation gets the reward, a quantity, the token and the price it showed",
    /\{ rewardId: id, quantity: 1, attemptId: attemptId, seenPrice: seenPrice \}/.test(buy));
  check("a retry after no answer reuses the same token",
    /_wpPendingBuy && _wpPendingBuy\.rewardId === id\)\s*\?\s*_wpPendingBuy\.attemptId/.test(buy)
    && /kind === 'unknown'/.test(buy));
  check("an expired sign-in is told so, and that nothing was charged",
    /kind === 'signin'[\s\S]{0,300}Nothing was charged/.test(buy));
  check("the receipt stays on screen in a dialog, not a toast",
    /wpShowPurchaseReceipt\(res\);/.test(buy) && /_wcDialog\(\{/.test(buy));
  check("and NO cost, total or balance",
    !/\bcost:/.test(buy.slice(buy.indexOf("convexMutation"), buy.indexOf("convexMutation") + 260))
    && !/total:/.test(buy.slice(buy.indexOf("convexMutation"), buy.indexOf("convexMutation") + 260))
    && !/balance:/i.test(buy.slice(buy.indexOf("convexMutation"), buy.indexOf("convexMutation") + 260)));

  check("an already-bought answer reads as done, not failed", /res\.alreadyBought/.test(buy));
  check("a refusal is shown rather than swallowed", /res\.ok !== true/.test(buy) && /showAlert/.test(buy));
  check("the receipt code is shown, since that is what they take to the office",
    /res\.receiptId/.test(buy));
  // loadStudentPortal, NOT wpPollPassOnce. The poll only redraws when the HALL
  // PASS changed, so after a purchase nothing redrew: the button sat on
  // "Buying..." and the balance and stock stayed as they were.
  check("and the portal re-renders through its one drawing path",
    /\} finally \{[\s\S]{0,400}await loadStudentPortal\(\);/.test(buy)
    && !/wpPollPassOnce\(true\)/.test(buy));
}

console.log("\n-- what the review found (2026-09-28) --");
{
  const buyAt = code.indexOf("let _wpBuyInFlight");
  const buy = code.slice(buyAt, code.indexOf("function wpDashboard(", buyAt));
  check("a retry token is forgotten on sign-out, so the next child cannot send it",
    /wpStoreOpenSeen = null;[\s\S]{0,120}_wpPendingBuy = null;/.test(code));
  check("a button the redraw did not replace is put back, not left on 'Buying'",
    /if \(btn && btn\.isConnected\) \{\s*btn\.disabled = false;\s*btn\.textContent = 'Buy';/.test(buy));
  check("Convex's 560 (the function ran and threw) means nothing was charged",
    /if \(\/Convex HTTP 560\\b\/\.test\(msg\)\) return 'refused';/.test(buy)
    && buy.indexOf("Convex HTTP 560") < buy.indexOf("Convex HTTP 5\\d\\d"));
  check("a failed load is retried by the poll instead of leaving a blank page",
    /if \(_wpLoadFailed\) \{\s*await loadStudentPortal\(\);/.test(code) && /_wpLoadFailed = true;/.test(code));
  const panel = code.slice(code.indexOf("function wpStorePanel()"), code.indexOf("let _wpBuyInFlight"));
  check("their purchases are listed whether the store is open or closed",
    /_wpStore\.myPurchases/.test(panel) && /'<\/p>' \+ heldHtml\)/.test(panel) && /'<\/ul>' \+ heldHtml\)/.test(panel));
  check("and every code and name in it is escaped",
    /wpEsc\(String\(p\.id\)\)/.test(panel) && /wpEsc\(String\(p\.rewardName\)\)/.test(panel));
  check("a dry-run tester is told it is a test", /_wpStore\.testing/.test(panel) && /Test mode/.test(panel));
}

console.log("\n-- the second review (2026-09-28) --");
{
  const buyAt = code.indexOf("let _wpBuyInFlight");
  const buy = code.slice(buyAt, code.indexOf("function wpDashboard(", buyAt));
  check("after a network failure the portal is NOT fully reloaded, which would blank the cards",
    /let redrawAfter = true;/.test(buy) && /kind === 'unknown'\) \{[\s\S]{0,600}redrawAfter = false;/.test(buy)
    && /if \(redrawAfter && typeof loadStudentPortal === 'function'\) await loadStudentPortal\(\);/.test(buy));
  const panel = code.slice(code.indexOf("function wpStorePanel()"), code.indexOf("let _wpBuyInFlight"));
  check("their purchases show even when nothing is for sale",
    /if \(!forSale\.length\) \{[\s\S]{0,400}\+ heldHtml\);/.test(panel));
}

console.log("\n-- the buyer message (2026-09-28) --");
{
  const multiline = new Function(
    code.slice(code.indexOf("function wpEsc("), code.indexOf("}", code.indexOf("function wpEsc(")) + 1) + "\n" +
    code.slice(code.indexOf("function wpMultiline("), code.indexOf("}", code.indexOf("function wpMultiline(")) + 1) +
    "\nreturn wpMultiline;")();
  const out = multiline('Gym <b>door</b>\nOct 1 & lunch');
  check("the message is escaped and keeps its line breaks",
    out === 'Gym &lt;b&gt;door&lt;/b&gt;<br>Oct 1 &amp; lunch', out);
  const buyAt = code.indexOf("let _wpBuyInFlight");
  const buy = code.slice(buyAt, code.indexOf("function wpDashboard(", buyAt));
  check("the receipt dialog shows it", /res\.purchaseMessage[\s\S]{0,120}wpMultiline\(res\.purchaseMessage\)/.test(buy));
  const panel = code.slice(code.indexOf("function wpStorePanel()"), code.indexOf("let _wpBuyInFlight"));
  check("and 'Your purchases' keeps it under the code", /p\.message \? '<div class="wp-store-held-msg">' \+ wpMultiline\(p\.message\)/.test(panel));
}

console.log("\n-- the Wildcat Digital Store (the shop scene, 2026-09-28) --");
{
  const lift = (name) => {
    const i = raw.indexOf("function " + name + "(");
    let d = 0, k = raw.indexOf("{", i);
    for (; k < raw.length; k++) { if (raw[k] === "{") d++; else if (raw[k] === "}") { d--; if (d === 0) break; } }
    return raw.slice(i, k + 1);
  };
  const shopSrc = ["wpEsc", "wpMultiline", "wdsMoney", "wdsTileState", "wdsBuyAttrs", "wdsTile", "wdsRow", "wdsMood", "wdsShopHtml"]
    .map(lift).join("\n");
  const draw = new Function("_wpStore", "_wpStoreError", shopSrc + "\nreturn wdsShopHtml();");
  const EVIL = '<img src=x onerror=alert(1)>';
  const item = (o) => Object.assign({ id: "pup_ms", name: "Power-Up Pass (Middle School)", cost: 1500, stock: 75,
    inStudentStore: true, campus: "middle", limitPerStudent: 1, myReceipts: [], canBuy: true, code: "ok", progress: 1 }, o);
  const open = draw({ storeOpen: true, balance: 1850, items: [item({})], myPurchases: [] }, null);
  check("a buyable pass gets a Buy button with the SAME attributes the panel uses, so one handler buys",
    /class="wds-buy" data-wp-buy="pup_ms" data-wp-buy-name="Power-Up Pass \(Middle School\)" data-wp-buy-cost="1500">Buy</.test(open));
  check("the shop has a way out", /data-wp-shop-close>Leave store</.test(open));
  check("the clerk is the presenting pose when something can be bought", /assets\/wildcat-clerk-2\.png/.test(open));
  check("it goes on the middle shelf, at eye level", /wds-row-2">[^]*?data-wp-buy="pup_ms"/.test(open)
    && !/wds-row-1"><div class="wds-item/.test(open));

  const short = draw({ storeOpen: true, balance: 600, items: [item({ canBuy: false, code: "cannot_afford", shortfall: 900, progress: 0.4 })], myPurchases: [] }, null);
  check("not enough yet: no Buy attribute anywhere, and how much more", !/data-wp-buy=/.test(short) && /\$900 more/.test(short));
  const other = draw({ storeOpen: true, balance: 5000, items: [item({ canBuy: false, code: "wrong_campus", otherCampus: true, campus: "high" })], myPurchases: [] }, null);
  check("the other campus's pass says so and cannot be bought", /High School Only/.test(other) && !/data-wp-buy=/.test(other));
  const closed = draw({ storeOpen: false, opensSoon: true, closedReason: "Opens Tuesday. Keep earning!", balance: 50,
    items: [item({ canBuy: false, code: "store_closed" })], myPurchases: [] }, null);
  const ended = draw({ storeOpen: false, opensSoon: false, closedReason: "Power-Up Pass sales have ended.", balance: 50,
    items: [item({ canBuy: false, code: "store_closed" })], myPurchases: [] }, null);
  check("after the sale the shelf says Closed, not Opens Soon", /disabled>Closed</.test(ended) && !/Opens Soon/.test(ended));
  const soldOut = draw({ storeOpen: false, opensSoon: false, closedReason: "Ended.", balance: 50,
    items: [item({ canBuy: false, code: "store_closed", stock: 0 })], myPurchases: [] }, null);
  check("a sold-out item says Sold Out even once the store is shut", /disabled>Sold Out</.test(soldOut));
  // The owner's after-close message has no full stop; the clerk's own
  // sentence after it must not run into it.
  const endedHeld = draw({ storeOpen: false, opensSoon: false, closedReason: "Power-Up Pass sales have ended", balance: 50,
    items: [], myPurchases: [{ id: "WC-7KQ2MX", rewardName: "Power-Up Pass (MS)", status: "issued" }] }, null);
  check("an admin message with no full stop gets one before the clerk adds his",
    /Power-Up Pass sales have ended\. Your purchases are saved below\./.test(endedHeld));
  const endedDot = draw({ storeOpen: false, opensSoon: false, closedReason: "All done!", balance: 50,
    items: [], myPurchases: [{ id: "WC-7KQ2MX", rewardName: "X", status: "issued" }] }, null);
  check("and one that already ends is left alone", /All done! Your purchases/.test(endedDot));
  const again = draw({ storeOpen: true, balance: 5000, items: [item({ limitPerStudent: 3, canBuy: true,
    myReceipts: [{ id: "WC-AAAAAA", status: "issued" }] })], myPurchases: [] }, null);
  check("an item they may buy again keeps its Buy button, with the code they hold",
    /data-wp-buy="pup_ms"/.test(again) && /WC-AAAAAA/.test(again));
  check("before it opens: 'Opens Soon', the admin's words, said once", /Opens Soon/.test(closed)
    && (closed.match(/Keep earning/g) || []).length === 2 /* scene bubble + phone bubble */ && !/data-wp-buy=/.test(closed));
  const owned = draw({ storeOpen: true, balance: 350, items: [item({ canBuy: false, code: "limit_reached",
    myReceipts: [{ id: "WC-7KQ2MX", status: "issued" }] })],
    myPurchases: [{ id: "WC-7KQ2MX", rewardName: "Power-Up Pass (Middle School)", status: "issued", message: "Gym\nlunch" }] }, null);
  check("after buying: the code on the shelf, thumbs up, and their purchase with the message below",
    /WC-7KQ2MX/.test(owned) && /wildcat-clerk-4\.png/.test(owned) && /wds-held-msg">Gym<br>lunch</.test(owned));

  const nasty = draw({ storeOpen: false, closedReason: EVIL, balance: 1, items: [item({ name: EVIL, id: '"><x', canBuy: true })],
    myPurchases: [{ id: EVIL, rewardName: EVIL, status: "issued", message: EVIL }] }, null);
  check("nothing an admin or a receipt can hold is drawn as markup", !/<img src=x/.test(nasty) && !/"><x/.test(nasty));
  check("an unloaded store says so, not an empty shop", /Loading the store/.test(draw(null, null))
    && /could not be loaded/.test(draw(null, "boom")));

  const panel = code.slice(code.indexOf("function wpStorePanel()"), code.indexOf("let _wpBuyInFlight"));
  check("the door is in the store panel unless the look is plain",
    /_wpStore\.look === 'plain' \? '' :/.test(panel) && /data-wp-shop-open/.test(panel));
  const wire = code.slice(code.indexOf("function wpWireBuyButtons()"), code.indexOf("function wpDashboard("));
  check("the doors are wired on the capture phase, beside Buy",
    /closest\('\[data-wp-shop-open\]'\)\) \{ ev\.preventDefault\(\); wpOpenShop\(\);/.test(wire)
    && /closest\('\[data-wp-shop-close\]'\)\) \{ ev\.preventDefault\(\); wpCloseShop\(\);/.test(wire));
  check("Escape leaves the shop, but not while a dialog is open over it",
    /ev\.key === 'Escape' && _wpShopOpen && !document\.getElementById\('wcDialogBackdrop'\)/.test(wire));
  // As soon as the store answer lands -- BEFORE the early return on a failed
  // pass card, so a partly failed reload cannot leave a stale Buy in the shop.
  const loadAt = code.indexOf("async function loadStudentPortal(");
  const load = code.slice(loadAt, code.indexOf("\n        }\n", code.indexOf("dash.innerHTML = wpDashboard(mine", loadAt)));
  check("the shop redraws after every portal load, so a purchase shows at once",
    /if \(_wpShopOpen\) wpRenderShop\(\);/.test(load)
    && load.indexOf("if (_wpShopOpen) wpRenderShop();") < load.indexOf("if (!pass) {"));
  check("switching to the plain list reaches open pages, and sees a student out of the shop",
    /version\.storeLook === 'scene' \|\| version\.storeLook === 'plain'/.test(code)
    && /nextLook !== wpStoreLookSeen\) \{\s*wpStoreLookSeen = nextLook;\s*await loadStudentPortal\(\);/.test(code)
    && /if \(_wpStore && _wpStore\.look === 'plain'\) \{ wpCloseShop\(\); return; \}/.test(code));
  check("a running hall pass closes the shop, so it is never hidden behind it",
    /if \(typeof _wpShopOpen !== 'undefined' && _wpShopOpen\) wpCloseShop\(\);\s*full\.hidden = false;/.test(code));
  check("the page behind is out of reach while the shop is open, and focus returns to the door",
    /behind\.inert = true;/.test(code) && /behind\.inert = false;/.test(code)
    && /querySelector\('\[data-wp-shop-open\]'\);\s*if \(door && door\.focus\) door\.focus\(\);/.test(code));
  check("and closes on sign-out, so the next child does not walk into it",
    /_wpLoadFailed = false;\s*wpCloseShop\(\);/.test(code));
  const zRoot = Number((css.match(/\.wds-root \{[^}]*z-index: (\d+)/) || [])[1]);
  check("the shop sits over the portal and under the dialog", zRoot > 9500 && zRoot < 10050, String(zRoot));
  check("the art ships with the site", ["store-bg.jpg", "store-register.png", "wildcat-clerk-1.png",
    "wildcat-clerk-2.png", "wildcat-clerk-3.png", "wildcat-clerk-4.png"]
    .every((f) => { try { return readFileSync(new URL("./assets/" + f, import.meta.url)).length > 1000; } catch { return false; } }));
}

console.log("\n-- the dialog has to out-rank every view --");
{
  // THE ACTUAL CAUSE of "clicking buy does nothing", found after four rounds of
  // looking elsewhere. .wc-dialog-backdrop was z-index 5000; .wp-root -- the
  // student portal -- is 9000. So the confirm opened BEHIND the page:
  // invisible, unclickable, and since _wcDialog only resolves when one of its
  // own buttons is pressed, its promise never settled. The handler awaited a
  // confirm forever. The console showed "[store] buy clicked" and then
  // nothing, which is exactly what an unresolved await looks like.
  //
  // A modal that a view can cover is not a modal.
  const zOf = (sel) => {
    const at = css.indexOf(sel + " {");
    if (at < 0) return null;
    const block = css.slice(at, css.indexOf("}", at));
    const m = block.match(/z-index:\s*(\d+)/);
    return m ? Number(m[1]) : null;
  };
  const dialog = zOf(".wc-dialog-backdrop");
  check("the dialog backdrop has a z-index at all", dialog !== null);

  // Every fixed VIEW in the app, by the values they actually hold.
  const views = [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]))
    // 2147483000 is wildcat-ui.css's own nuclear overlay and is not a view.
    .filter((n) => n < 2000000 && n !== dialog);
  const highestView = Math.max(...views);
  check("and it sits above every other stacked thing in the sheet",
    dialog > highestView, `dialog ${dialog} vs highest other ${highestView}`);

  // Named explicitly, because these are the ones that bit.
  check("above the student portal", dialog > 9000);
  check("above the tap result view", dialog > 9500);
  check("above the pass takeover and the toast row", dialog > 10000);
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
  // seenPrice is the one number allowed through, and it can only REFUSE: the
  // charge is always the catalogue's cost (student-store-sale.test.mjs runs
  // the purchase and proves the seen price is never what is charged).
  check("nor a price", !/cost|total|balance/i.test(pArgs.replace(/seenPrice/g, "")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
