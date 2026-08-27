// The severity escape hatch on a referral.
//
// A three-intervention expectation that cannot be bypassed for violence is one
// that gets faked. A teacher who removed a student mid-fight will tick three
// boxes to make the form go away, and the record then says interventions were
// attempted when they were not — which corrupts the one number the expectation
// exists to measure.
//
// Zero interventions used to be ambiguous: "skipped the step" and "student was
// violent, removed immediately" produced identical records and the analytics
// counted both as "filed with none logged". They are different facts and only
// one of them is a practice problem.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\nThe teacher can say it was too severe");
{
  check("the form has the control", /id="referralSevereBypass"/.test(html));
  check("it sits with the interventions it replaces",
    html.indexOf('id="referralSevereBypass"') < html.indexOf('id="interventionCount"'));
  check("it repaints the banner when ticked",
    /id="referralSevereBypass"[\s\S]{0,120}onchange="updateInterventionCount\(\)"/.test(html));
  check("and it names what qualifies, rather than leaving it to judgement",
    /violence, a threat to safety, or similar/.test(html));
}

console.log("\nThe banner stops nagging, and says why");
{
  const fn = script.slice(script.indexOf("function updateInterventionCount"),
                          script.indexOf("function clearReferralForm"));
  check("severity short-circuits the counter", /if \(severe\) \{/.test(fn));
  check("it reads as satisfied, not failed", /Immediate removal recorded/.test(fn));
  check("and it returns before the 'more expected' branch",
    fn.indexOf("Immediate removal recorded") < fn.indexOf("more expected before referring"));
  // A teacher who removed a student AND tried something still gets credit.
  check("interventions logged alongside a severe removal are still counted",
    /intervention\$\{n === 1 \? '' : 's'\} also logged/.test(fn));
}

console.log("\nIt is recorded as its own fact");
{
  check("the referral carries severeBypass", /severeBypass: severeBypass,/.test(script));
  check("read from the checkbox at submit time",
    /const severeBypass = !!\(document\.getElementById\('referralSevereBypass'\) \|\| \{\}\)\.checked;/.test(script));
  check("and cleared with the rest of the form",
    /if \(severeBox\) severeBox\.checked = false;/.test(script));
  check("the reason is written down next to the field",
    /Zero used to be ambiguous/.test(script));
}

console.log("\nAnalytics stops counting an emergency as a failure");
{
  const block = script.slice(script.indexOf("Intervention practice"),
                             script.indexOf("DETENTION TRACKER FUNCTIONS"));
  check("severe removals are excluded from the denominator",
    /const eligible = all\.filter\(r => !r\.severeBypass\)/.test(block));
  check("the percentage is computed over eligible referrals only",
    /withThree \/ eligible\.length/.test(block));
  check("'none logged' no longer includes them",
    /const none = eligible\.filter/.test(block));
  check("they get their own tile instead of vanishing",
    /Too severe for interventions/.test(block));
  // An all-severe week must not read as 0% compliance.
  check("an empty eligible set shows a dash, not a fabricated 0%",
    /eligible\.length \? Math\.round/.test(block) && /pct === null \? '—'/.test(block));
}

console.log("\nA reader of the referral sees it, not a bare zero");
{
  check("the detail view flags it", /Too severe for classroom interventions\./.test(script));
  check("and explains the empty list rather than saying 'None recorded'",
    /None attempted, by design\./.test(script));
  check("the open-referrals table shows 'severe' instead of 0",
    /count-pill-severe/.test(script));
  check("styled apart from a normal count", /\.count-pill-severe/.test(css));
  // The export is what leaves the building.
  check("the export carries it as its own column",
    /'Too Severe For Interventions': r\.severeBypass \? 'Yes' : 'No',/.test(script));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
