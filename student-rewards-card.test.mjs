// The student's Wildcat Cash and raffle ticket card.
//
// THE RULE THIS CARD IS BUILT AROUND. A zero and an unknown are not the same
// number, and this is the card where that matters most: it is a child's money.
// views_app:myStudentView returns the balance as null when there is no record,
// precisely so the app cannot show a student $0 that actually means "we could
// not tell" — indistinguishable, to them, from having spent it.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const views = readFileSync(new URL("./convex/views_app.ts", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

// Run the card builder in isolation, with only the helpers it uses.
const body = script.slice(script.indexOf("function wpRewardsCard"),
                          script.indexOf("function wpMealCard"));
const faces = script.slice(script.indexOf("const WP_FACE = {"),
                           script.indexOf("function wpEmpty"));
const build = new Function(
  "WP_FACE", "wpEsc", "wpEmpty", "wpFoot",
  faces.slice(faces.indexOf("{")) .replace(/^\{/, "const F = {") + ";\n" +
  body.replace(/WP_FACE\./g, "F.") + "\nreturn wpRewardsCard;"
)(null, (x) => String(x == null ? "" : x),
   (t) => `<p class="wp-empty">${t}</p>`,
   (t) => `<p class="wp-foot">${t}</p>`);

console.log("\nA real balance is shown as money");
{
  const c = build({ wildcatCash: { balance: 42 }, points: { pbis: 3, attendance: 2, academic: 1, total: 6, bigRaffleEntries: 2 } });
  check("the lead is the balance", c.lead === "$42");
  check("it is not marked quiet", c.quiet !== true);
  check("tickets are totalled", /Raffle tickets[\s\S]*?>6</.test(c.body));
  check("and broken down, so a student knows what is still earnable",
    /Being a Wildcat[\s\S]*?>3</.test(c.body) &&
    /Attendance[\s\S]*?>2</.test(c.body) &&
    /Academics[\s\S]*?>1</.test(c.body));
  check("jackpot entries appear when there are any", /Jackpot entries/.test(c.body));
  check("no 'nothing yet' note when there is something", !/Nothing yet this cycle/.test(c.body));
}

console.log("\nA MISSING balance is never shown as $0");
{
  // The failure this card exists to prevent.
  const c = build({ wildcatCash: { balance: null }, points: { pbis: 0, attendance: 0, academic: 0, total: 0 } });
  check("the lead does NOT read $0", c.lead !== "$0");
  check("it says the balance is unavailable", /unavailable/i.test(c.lead));
  check("the card goes quiet", c.quiet === true);
  check("and it says so in words, not just by absence",
    /has not reached your account yet/.test(c.body));
  check("explicitly denying the zero reading", /not a balance of \$0/.test(c.body));
}

console.log("\nA REAL zero is shown, and named as real");
{
  const c = build({ wildcatCash: { balance: 0 }, points: { pbis: 0, attendance: 0, academic: 0, total: 0, bigRaffleEntries: 0 } });
  check("a real zero balance shows as $0", c.lead === "$0");
  check("and is not marked unavailable", c.quiet !== true);
  // A screen of zeroes looks identical to a screen that failed to load.
  check("it says the zeroes are real", /Nothing yet this cycle/.test(c.body));
  check("and that they go up", /go up when staff award them/.test(c.body));
}

console.log("\nMissing pieces degrade one at a time");
{
  const c = build({ wildcatCash: { balance: 12 }, points: { pbis: 3, attendance: null, academic: 1, total: null } });
  check("a missing ticket total says so rather than showing 0",
    /Raffle tickets[\s\S]*?is-none/.test(c.body));
  check("but the balance still shows", c.lead === "$12");
  check("and the categories that ARE known still show", /Being a Wildcat[\s\S]*?>3</.test(c.body));

  const none = build(null);
  check("no data at all is an explicit failure, not an empty card",
    none.quiet === true && /could not be loaded/.test(none.body));
  check("and it does not claim a balance", !/\$/.test(none.lead));
}

console.log("\nIt is wired into the student wallet");
{
  check("the card is pushed into the stack", /cards\.push\(wpRewardsCard\(mine\)\);/.test(script));
  check("it reads myStudentView, which the portal already loads",
    /auth\.convexQuery\('views_app:myStudentView'/.test(script));
  // The hall pass and ID barcode are positioned deliberately; inserting before
  // them must not disturb that.
  check("it sits before the hall pass and the ID card",
    script.indexOf("cards.push(wpRewardsCard(mine));") <
    script.indexOf("cards.push(wpHallPassCard(pass.hallPass));"));
  check("it has its own face rather than borrowing another card's",
    /rewards:  '--wp-face/.test(script) && /rewardsOff: '--wp-face/.test(script));
}

console.log("\nThe server already refuses to invent a balance");
{
  // The card's honesty depends on the server keeping this contract.
  check("myStudentView returns the balance as null when absent",
    /balance: student\.wildcatCashBalance \?\? null/.test(views));
  check("and the reason is recorded there too",
    /indistinguishable from having spent it/.test(views));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
