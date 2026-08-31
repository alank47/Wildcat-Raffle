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
  check("tickets are totalled", /Raffle Tickets<\/span><span class="wp-acc-num">6</.test(c.body));
  check("and broken down, so a student knows what is still earnable",
    /Being a Wildcat[\s\S]*?>3</.test(c.body) &&
    /Attendance[\s\S]*?>2</.test(c.body) &&
    /Academics[\s\S]*?>1</.test(c.body));
  check("the jackpot is its own group, not a fourth ticket source",
    /wp-group-title">Wildcat Jackpot/.test(c.body));
  check("with entries counted", /Wildcat Jackpot[\s\S]*?wp-group-num">2/.test(c.body));
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
    /Raffle Tickets<\/span><span class="wp-acc-num"><span class="is-none">/.test(c.body));
  check("but the balance still shows", c.lead === "$12");
  check("and the categories that ARE known still show", /Being a Wildcat[\s\S]*?>3</.test(c.body));

  const none = build(null);
  check("no data at all is an explicit failure, not an empty card",
    none.quiet === true && /could not be loaded/.test(none.body));
  check("and it does not claim a balance", !/\$/.test(none.lead));
}

console.log("\nThe three sources read as parts of one total, not as peers");
{
  // The complaint this restructure answers: five sibling rows made a
  // hierarchy look like five unrelated balances, and a student could come away
  // thinking "Academics" was its own currency.
  const c = build({ wildcatCash: { balance: 5 },
    points: { pbis: 3, attendance: 2, academic: 1, total: 6, bigRaffleEntries: 2 } });

  check("the total is a heading, not a row", /wp-acc-head/.test(c.body));
  check("the three sources are nested under it",
    (c.body.match(/wp-row-nested/g) || []).length === 3);
  check("and they sit inside the raffle group, before the jackpot one",
    c.body.indexOf("wp-row-nested") < c.body.indexOf("Wildcat Jackpot"));
  check("the arithmetic is stated in words too",
    /Three ways to earn one thing/.test(c.body));
  check("and the jackpot's relationship to tickets is explained",
    /One entry for every week your tickets qualified you/.test(c.body));

  // Singular/plural, because "1 entries" on a child's card is sloppy.
  const one = build({ wildcatCash: { balance: 5 },
    points: { pbis: 1, attendance: 0, academic: 0, total: 1, bigRaffleEntries: 1 } });
  check("one entry reads 'entry'", /wp-group-unit">entry</.test(one.body));
  check("two read 'entries'", /wp-group-unit">entries</.test(c.body));

  // The nesting must be structural, not just indentation in the copy.
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  check("the indent is carried by CSS, so it survives a copy edit",
    /\.wp-row-nested \{[\s\S]*?border-left/.test(css));
}

console.log("\nOne half open at a time");
{
  const c = build({ wildcatCash: { balance: 42, recent: [] },
    points: { pbis: 3, attendance: 2, academic: 1, total: 6, bigRaffleEntries: 2 } });

  check("both halves are rendered", (c.body.match(/wp-acc-sec/g) || []).length === 2);
  check("cash is the one open by default", /data-open="cash"/.test(c.body));
  check("each heading is a real button, not a div",
    (c.body.match(/<button type="button" class="wp-acc-head"/g) || []).length === 2);
  check("and carries aria-expanded",
    /aria-expanded="true"[^>]*onclick="wpRewardsOpen\('cash'\)"/.test(c.body) &&
    /aria-expanded="false"[^>]*onclick="wpRewardsOpen\('tickets'\)"/.test(c.body));
  // Hiding is CSS on the container, so it survives a re-render and does not
  // depend on JS state that a refresh would drop.
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  // Rewritten when closing BOTH became possible: the rule is now "hide every
  // body, show the one that matches", which "hide the other half" could not
  // express. Still CSS on the container, still survives a re-render.
  check("the closed half is hidden by CSS, not by omitting it",
    /\.wp-acc-body \{ display: none; \}/.test(css) &&
    /\.wp-acc\[data-open="cash"\][\s\S]{0,200}display: block;/.test(css));
  check("both headings stay visible when closed",
    /Wildcat Cash/.test(c.body) && /Raffle Tickets/.test(c.body));
}

console.log("\nThe headings behave like buttons");
{
  // Run the toggle against a minimal DOM stand-in, so the behaviour is tested
  // rather than the markup that hints at it.
  const toggleSrc = script.slice(script.indexOf("function wpRewardsOpen"),
                                 script.indexOf("function wpMealCard"));
  const el = {
    attrs: { "data-open": "cash" },
    getAttribute(k) { return this.attrs[k]; },
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelectorAll() { return []; },
  };
  const doc = { getElementById: (id) => (id === "wpRewardsAcc" ? el : null) };
  const toggle = new Function("document", toggleSrc + "\nreturn wpRewardsOpen;")(doc);

  toggle("tickets");
  check("clicking the closed half opens it", el.attrs["data-open"] === "tickets");
  toggle("tickets");
  check("clicking it AGAIN closes it", el.attrs["data-open"] === "none");
  toggle("tickets");
  check("and clicking once more reopens it", el.attrs["data-open"] === "tickets");
  toggle("cash");
  check("opening the other half swaps, it does not stack",
    el.attrs["data-open"] === "cash");
  toggle("cash");
  check("so both can be closed at once", el.attrs["data-open"] === "none");
  toggle("nonsense");
  check("an unknown key falls back to cash rather than breaking",
    el.attrs["data-open"] === "cash");

  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  // "Hide the other one" cannot express both-closed; "show the match" can.
  check("bodies are hidden by default and shown by match",
    /\.wp-acc-body \{ display: none; \}/.test(css) &&
    /data-sec="cash"\]    \.wp-acc-body,[\s\S]{0,120}display: block;/.test(css));
  check("the heading is filled and bordered, so it reads as pressable",
    /\.wp-acc-head \{[\s\S]*?background: var\(--wp-pill/.test(css) &&
    /\.wp-acc-head \{[\s\S]*?border-radius: 12px;/.test(css));
  check("and it gives on press", /\.wp-acc-head:active \{ transform: translateY\(1px\); \}/.test(css));
  check("the open half is distinguished from the closed one",
    /data-open="none"\] \.wp-acc-head[\s\S]{0,200}background: transparent;/.test(css));
}

console.log("\nThe cash half explains the balance");
{
  const c = build({
    wildcatCash: { balance: 42, recent: [
      { at: "2026-08-27T15:00:00Z", kind: "award", amount: 5,
        reason: "Being Responsible", note: "helped a new student find C wing",
        by: "Ms Rivera", balanceAfter: 42 },
      { at: "2026-08-26T15:00:00Z", kind: "redeem", amount: -10,
        reason: null, note: null, by: "Front Office", balanceAfter: 37 },
    ] },
    points: { pbis: 1, attendance: 0, academic: 0, total: 1, bigRaffleEntries: 0 } });

  check("movements are listed", (c.body.match(/wp-tx"/g) || []).length === 2);
  check("an award reads as a plus", /is-plus">\+\$5</.test(c.body));
  check("a purchase reads as a minus", /is-minus">-\$10</.test(c.body));
  check("the reason is shown", /Being Responsible/.test(c.body));
  check("the adult's note is shown as theirs",
    /wp-tx-note">helped a new student find C wing/.test(c.body));
  check("who did it is shown", /Ms Rivera/.test(c.body));
  // A movement with no typed reason must still say what it was.
  check("a purchase with no reason falls back to its kind",
    /Reward purchase/.test(c.body));
}

console.log("\nAn empty history says which kind of empty it is");
{
  // A balance with no history means the ledger has not reached the account.
  // No balance and no history means nothing has happened. Different sentences.
  const withBal = build({ wildcatCash: { balance: 30, recent: [] },
    points: { pbis: 0, attendance: 0, academic: 0, total: 0 } });
  check("a balance with no history says the history is missing",
    /history has not reached your account yet/.test(withBal.body));
  check("and reassures that the balance is still right",
    /balance above is current/.test(withBal.body));

  const fresh = build({ wildcatCash: { balance: 0, recent: [] },
    points: { pbis: 0, attendance: 0, academic: 0, total: 0 } });
  check("a genuinely new student is told nothing has happened yet",
    /No activity yet/.test(fresh.body));
  check("and not told their history is missing",
    !/has not reached your account/.test(fresh.body.replace(/not a balance of \$0[^<]*/g, "")));
}

console.log("\nThe server hands over a movement field by field");
{
  check("recent is returned to the student", /recent: \(student\.wildcatCashTransactions/.test(views));
  check("newest first", /\.reverse\(\)/.test(views));
  check("and capped", /slice\(-RECENT_CASH\)/.test(views));
  // The stored row carries teacherId, teacherUsername, studentGrade, school.
  // None of those belong in a student's own view.
  const block = views.slice(views.indexOf("recent: (student.wildcatCashTransactions"),
                            views.indexOf("grades: {"));
  check("teacherId is not passed through", !/teacherId/.test(block));
  check("nor teacherUsername", !/teacherUsername/.test(block));
  check("but the teacher's NAME is, because they will ask", /by: t\?\.teacherName/.test(block));
}

console.log("\nThe ledger reaches Convex even though it is stripped from main");
{
  // `main` is one Firestore document against a 1MB ceiling; Convex stores each
  // student as a row. Stripping for one must not starve the other.
  check("a Convex-specific payload is built",
    /const studentsForConvex = mainTransactionResult\.studentsToSave/.test(script));
  check("it re-attaches the cash ledger",
    /wildcatCashTransactions: tx\.slice\(-40\)/.test(script));
  check("and appData:save is sent that, not the stripped list",
    /appData:save', \{\s*\n\s*students: studentsForConvex,/.test(script));
  // The stripped list is what the save payload is built from. This asserted
  // `delete studentData.…` while three separate paths each stripped their own
  // copy; the Firestore transaction went to Convex on 2026-08-31 and the one
  // remaining path names its variable `c`. The property under test is unchanged:
  // the ledger is stripped from the student records the save sends, and
  // re-attached only for Convex.
  check("the save payload is still built without it",
    /delete c\.wildcatCashTransactions;/.test(script));
  check("the reason both are true is recorded",
    /Convex stores each student as a ROW, so\n\s*\/\/ that ceiling does not apply/.test(script));
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
