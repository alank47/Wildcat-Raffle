// The Student Rewards Store card, announced before the store exists.
//
// Students already see a balance, a leaderboard and a list of what they have
// earned, and nothing anywhere says what the money is FOR. This card is the
// answer until the store ships.
//
// It is static on purpose. The portal loads four queries in a Promise.allSettled
// and the student-facing lesson from the leaderboard was that a panel which can
// fail is a panel that must SAY it failed. This one cannot fail, so it needs
// none of that -- and the tests below pin that it stays that way.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const fn = script.slice(script.indexOf("function wpStoreSoonPanel()"),
                        script.indexOf("function wpDashboard(mine, sched, grades, pass)"));

console.log("\n-- the card exists and is in the portal --");
{
  check("wpStoreSoonPanel is defined", fn.length > 100);
  check("it is rendered into the dashboard", /\+ wpStoreSoonPanel\(\) \+/.test(script));
  // Next to the balance, which is what provokes the question it answers.
  // The end marker is searched FROM the return statement, not from the top of
  // the file. Searching from 0 found an earlier "attendance;" and produced a
  // backwards slice, so both order assertions failed while the code was right.
  const order = (() => {
    // Anchored on wpDashboard's own return statement rather than on the first
    // panel named in it. This was "return tiles + passPanel", and the tile row
    // was removed on 2026-09-10 -- so a locator naming the first term broke
    // while the code was fine. Twice, in two files.
    // The render list is the return that names the panels -- NOT the first
    // return in the function, which is the early-out for missing data, and not
    // one identified by its first term, which broke when the tile row was
    // removed. Found by what it contains.
    const dStart = script.indexOf("function wpDashboard(");
    let at = dStart, found = "";
    for (;;) {
      const r = script.indexOf("return ", at);
      if (r === -1) break;
      const stmt = script.slice(r, script.indexOf(";", r) + 1);
      if (stmt.includes("passPanel") && stmt.includes("attendance")) { found = stmt; break; }
      at = r + 7;
    }
    return found;
  })();
  check("the render order line was located", order.length > 40 && order.length < 400);
  check("it sits after the Wildcat Cash balance panel",
    order.indexOf("money") < order.indexOf("wpStoreSoonPanel"));
  check("and before the schedule and attendance panels",
    order.indexOf("wpStoreSoonPanel") < order.indexOf("schedule"));
}

console.log("\n-- it says what was asked for --");
{
  check("the title names the store", /'Student Rewards Store'/.test(fn));
  check("it says coming soon", /'Coming soon'/.test(fn));
  check("the body explains what the money is for",
    /use your Wildcat Cash to purchase/.test(fn));
  check("and it says stay tuned", /Stay tuned!/.test(fn));
  check("it is filed under Wildcat Cash, like the balance and the board",
    /wpPanel\(\s*'Wildcat Cash'/.test(fn));
  // A typographic apostrophe, not a straight one, matching the rest of the
  // portal's copy.
  check("the apostrophe is the curly one the portal uses elsewhere",
    /\\u2019ll be able/.test(fn));
}

console.log("\n-- it cannot break the portal --");
{
  // The portal's four boot queries are in a Promise.allSettled; a panel that
  // reads none of them has no failure state to render and no load to wait on.
  check("it takes no arguments", /function wpStoreSoonPanel\(\)/.test(fn));
  check("it makes no network call", !/convexQuery|convexMutation|fetch\(/.test(fn));
  check("it reads no live data", !/mine\.|cash\.|grades\.|sched\.|_wp[A-Z]/.test(fn));
  check("it holds no state", !/let |const _|= null/.test(fn.replace(/\/\*[\s\S]*?\*\//g, "")));
  check("it has no failure or loading branch", !/catch|Loading|could not/.test(fn));
  check("it was NOT added to the portal's boot queries",
    !/allSettled[\s\S]{0,400}wpStoreSoonPanel/.test(script));
}

console.log("\n-- styled --");
{
  check(".wp-soon is styled", css.includes(".wp-soon"));
  // --wp-dim, the PORTAL's dim token, not the staff app's --wc-gray-text.
  // The portal has its own theme and flips between dark and light; the staff
  // tokens do not, so they render as unreadable grey on the dark layout. This
  // assertion originally pinned the wrong one, which is how it got shipped.
  check("it is quieter than live content", /\.wp-soon \{[\s\S]{0,300}color: var\(--wp-dim/.test(css));
  // Checked against the DECLARATION, not any mention: the comment inside the
  // rule names --wc-gray-text while explaining why it is not used, and a bare
  // string search cannot tell a citation from a use. Third time this exact
  // trap has cost a red test today.
  const soon = css.slice(css.indexOf(".wp-soon {"), css.indexOf("}", css.indexOf(".wp-soon {")));
  const decls = soon.replace(/\/\*[\s\S]*?\*\//g, "");
  check("and its colour declaration does not use the staff app's token",
    !/--wc-gray-text/.test(decls));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
