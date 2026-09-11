// Who is told a referral was filed, and what the email says.
//
// THE ASSERTIONS THAT MATTER ARE THE INJECTION ONES. mergeSlice accepts
// `payload: v.any()` behind requireStaff, so every field on an incoming
// referral -- filedByEmail included -- is chosen by whoever called it. If a
// recipient could be read from there, a teacher could edit one value in
// devtools and post a colleague a named child's discipline record.
//
// Run: npm test

import {
  REFERRAL_RECIPIENTS, recipientsFor, mailPlan, esc, shortName, whenText,
  MAX_DESCRIPTION,
} from "./referralMailRules.ts";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const REF = {
  id: "R7k2QmX4",
  studentName: "Jordan Martinez",
  studentId: "S104822",
  studentGrade: "7",
  school: "Middle School",
  date: "2026-09-11",
  dateTime: "2026-09-11T10:42",
  location: "Hallway - B Wing",
  behavior: "Peer Conflict/Confrontation",
  description: "Jordan and another student were arguing loudly outside room 214.",
  interventions: ["Verbal Warning", "One-on-One Conference with Student"],
  severeBypass: false,
  additionalActions: "Called home and left a message.",
  filedByEmail: "laurab@lapromisefund.org",
  submittedAt: "2026-09-11T10:47:00.000Z",
  status: "open",
};
const FILER = { email: "laurab@lapromisefund.org", name: "Laura Baltazar" };

console.log("\n-- the list is the six the owner named, and nothing else --");
{
  const emails = REFERRAL_RECIPIENTS.map((r) => r.email);
  check("six standing recipients", emails.length === 6);
  ["jasonm", "leahr", "ashargm", "laurab", "sammyg", "alank"].forEach((u) =>
    check(`${u}@ is on it`, emails.includes(`${u}@lapromisefund.org`)));
  // Mailing "everyone with an admin role" would have been eleven people,
  // including the app's own developer and a counselor made admin an hour
  // earlier for an unrelated screen.
  check("the developer is NOT on it", !emails.some((e) => e.startsWith("lawrence")));
  check("nor the people who hold a role but were not named",
    !emails.some((e) => e.startsWith("arianan") || e.startsWith("claudia") ||
                        e.startsWith("christine") || e.startsWith("shaqueal")));
  check("every address is on the staff domain",
    emails.every((e) => e.endsWith("@lapromisefund.org")));
}

console.log("\n-- the recipient list cannot be injected --");
{
  // THE ONE THAT WOULD MATTER IN AN INCIDENT.
  const forged = { ...REF, filedByEmail: "someone.else@lapromisefund.org" };
  const plan = mailPlan(forged, FILER);
  check("a forged filedByEmail does NOT become a recipient",
    !plan.to.includes("someone.else@lapromisefund.org"));
  check("the verified filer is the one mailed", plan.to.includes(FILER.email));
  check("and the disagreement is reported rather than swallowed",
    plan.filerMismatch === true && /names a different filer/.test(plan.html));

  // An address that is not staff at all.
  const outside = mailPlan({ ...REF, filedByEmail: "parent@gmail.com" }, FILER);
  check("an off-domain address in the payload reaches nobody",
    !outside.to.some((t) => t.includes("gmail")));

  check("the payload cannot add a seventh recipient",
    mailPlan({ ...REF, recipients: ["x@lapromisefund.org"] }, FILER).to.length ===
    mailPlan(REF, FILER).to.length);
}

console.log("\n-- Laura is not told twice about her own referral --");
{
  // She is on the standing list AND files referrals.
  const plan = mailPlan(REF, FILER);
  check("she appears exactly once",
    plan.to.filter((t) => t === "laurab@lapromisefund.org").length === 1);
  check("so the send is six, not seven", plan.to.length === 6);

  // A filer who is not on the standing list is added.
  const other = mailPlan(REF, { email: "newteacher@lapromisefund.org", name: "New Teacher" });
  check("a teacher not on the list is added as the seventh", other.to.length === 7);
  check("and case does not create a duplicate",
    recipientsFor("LAURAB@LAPROMISEFUND.ORG").length === 6);
  check("nor does surrounding whitespace",
    recipientsFor("  laurab@lapromisefund.org  ").length === 6);
  check("a filer with no address adds nobody", recipientsFor("").length === 6);
  check("nor does a non-string", recipientsFor(undefined).length === 6);
}

console.log("\n-- what a teacher typed cannot become markup --");
{
  const nasty = mailPlan({
    ...REF,
    description: '<script>alert(1)</script> and <img src=x onerror=alert(2)>',
    studentName: '<b>Bold</b> Student',
    location: '"><a href=evil>click</a>',
  }, FILER);
  check("script tags are escaped, not rendered", !/<script>/.test(nasty.html));
  check("img tags too", !/<img /.test(nasty.html));
  check("an injected anchor cannot open", !/<a href=evil/.test(nasty.html));
  check("the text is still there, visibly escaped", /&lt;script&gt;/.test(nasty.html));
  // Escape FIRST, then newlines to <br>. The other order lets a typed "<br>"
  // through as markup.
  const withBreaks = mailPlan({ ...REF, description: "line one\nline two" }, FILER);
  check("real newlines become breaks", /line one<br>line two/.test(withBreaks.html));
  check("but a typed break does not",
    !/x<br>y/.test(mailPlan({ ...REF, description: "x<br>y" }, FILER).html));
  check("esc handles every dangerous character",
    esc(`<>&"'`) === "&lt;&gt;&amp;&quot;&#39;");
}

console.log("\n-- the body is pure ASCII, the subject deliberately is not --");
{
  // THE BUG THIS CAUGHT. The first render showed "Jordan&#226;&#8364;&#8482;s
  // grandmother" and "Open &#226;&#8364;&#8221; waiting" -- an apostrophe and
  // an em dash arriving as mojibake because nothing told the renderer the bytes
  // were UTF-8. A mail client's charset guess is not ours to control, and the
  // text it guesses about includes students' names.
  const accented = mailPlan({
    ...REF, studentName: "Jos\u00e9 Mu\u00f1oz",
    description: "caf\u00e9 \u2014 and Jordan\u2019s book",
  }, FILER);
  check("no raw non-ASCII survives in the body",
    [...accented.html].every((c) => c.charCodeAt(0) < 128));
  check("an accented name renders as an entity", /Jos&#233;/.test(accented.html));
  check("so does a curly apostrophe", /&#8217;/.test(accented.html));
  check("and an em dash", /&#8212;/.test(accented.html));
  check("my own copy has no raw non-ASCII either",
    [...mailPlan({ id: "R1" }, FILER).html].every((c) => c.charCodeAt(0) < 128));

  // AND NOT BY HAND-WRITING ENTITIES. Every value goes through esc(), which
  // turns "&" into "&amp;" -- so a hand-written "&mdash;" in the source
  // rendered as the visible text "&mdash;" in six inboxes. Write the real
  // character and let esc() encode it.
  const plain = mailPlan({ id: "R1" }, FILER);
  check("no double-escaped entity reaches the reader",
    !/&amp;(mdash|nbsp|amp|#\d)/.test(plain.html));
  check("the em dash arrives as a real dash entity", /&#8212;/.test(plain.html));

  // The opposite rule for the subject: it is a plain-text header, so "&#233;"
  // would render as those six characters rather than as an e-acute.
  check("the subject keeps real characters, not entities",
    accented.subject.includes("Jos\u00e9") && !accented.subject.includes("&#"));
}

console.log("\n-- free text is clamped before it reaches six inboxes --");
{
  const huge = mailPlan({ ...REF, description: "x".repeat(MAX_DESCRIPTION + 5000) }, FILER);
  check("a runaway description is truncated", /truncated/.test(huge.html));
  check("and the mail stays a sane size", huge.html.length < MAX_DESCRIPTION + 6000);
  check("the subject is capped", mailPlan({ ...REF, behavior: "y".repeat(400) }, FILER).subject.length <= 150);
}

console.log("\n-- the subject does not put a full name on a lock screen --");
{
  const plan = mailPlan(REF, FILER);
  check("first name and last initial only", /Jordan M\./.test(plan.subject));
  check("the surname is not in the subject", !/Martinez/.test(plan.subject));
  // Outlook searches the body, so searching the surname still finds it.
  check("but it IS in the body, so search still works", /Martinez/.test(plan.html));
  check("it says what kind of message this is", /Behavior referral/.test(plan.subject));
  check("and carries the grade and behaviour", /Grade 7/.test(plan.subject) && /Peer Conflict/.test(plan.subject));
  check("one name becomes itself", shortName("Cher") === "Cher");
  check("a missing name does not crash the subject", shortName("") === "a student");
  check("three names use the last as the initial", shortName("Ana Maria Lopez") === "Ana L.");
}

console.log("\n-- immediate removal is stated as a fact, not shouted --");
{
  const severe = mailPlan({ ...REF, severeBypass: true, interventions: [] }, FILER);
  check("the subject leads with it", /^Immediate removal/.test(severe.subject));
  // severeBypass records a fact; URGENT is a priority claim the form never made.
  check("and never says URGENT", !/URGENT/i.test(severe.subject) && !/URGENT/i.test(severe.html));
  check("the body explains why no interventions are listed",
    /too severe for classroom/.test(severe.html));
  check("and does not then print an empty interventions block",
    !/tried before this referral/.test(severe.html));

  // Without the bypass, zero interventions is a different fact and is said.
  const none = mailPlan({ ...REF, interventions: [] }, FILER);
  check("zero interventions without the bypass says so",
    /None were recorded on the form/.test(none.html));
}

console.log("\n-- it stands alone for the one reader who has no account --");
{
  const plan = mailPlan(REF, FILER);
  // Jason Marin is Chief of Schools with a Microsoft account and no hub
  // account. He cannot click through to anything.
  check("it says you do not need to open the app", /do not need to open Wildcat Hub/.test(plan.html));
  check("and never tells the reader to log in to view it", !/log in to view/i.test(plan.html));
  ["Jordan Martinez", "S104822", "Middle School", "Hallway - B Wing",
   "Peer Conflict", "arguing loudly", "Verbal Warning", "Called home",
   "Laura Baltazar", "R7k2QmX4"].forEach((bit) =>
    check(`the body carries "${bit.slice(0, 24)}"`, plan.html.includes(esc(bit))));
  check("the status says what happens next", /waiting for an administrator/.test(plan.html));
}

console.log("\n-- and it tells the filer not to file a second one --");
{
  const plan = mailPlan(REF, FILER);
  // A teacher who spots a typo and re-files creates a duplicate discipline
  // record for one incident.
  check("it says not to file again", /do not file a second referral/i.test(plan.html));
  check("and says why", /duplicate record/.test(plan.html));
  check("it refuses to be treated as a receipt",
    /not a receipt/.test(plan.html) && /absence proves nothing/.test(plan.html));
}

console.log("\n-- missing fields degrade, never crash --");
{
  check("an empty referral still produces a plan", (() => {
    const p = mailPlan({}, FILER);
    return p.to.length === 6 && p.subject.length > 0 && p.html.length > 0;
  })());
  check("so does a null one", mailPlan(null, FILER).to.length === 6);
  check("a missing date says so rather than printing Invalid Date",
    whenText("") === "not recorded" && !/Invalid/.test(whenText("")));
  // Convex runs in UTC, so without a pinned zone a referral filed at 10:47 in
  // the morning reached six inboxes reading "5:47 PM".
  check("times are shown on the school's clock, not the server's",
    whenText("2026-09-11T17:47:00.000Z").includes("10:47 AM"));
  check("and the date follows the same clock",
    whenText("2026-09-12T03:00:00.000Z").includes("September 11"));
  check("an unparseable date is passed through as written",
    whenText("sometime tuesday") === "sometime tuesday");
  check("absent fields read as not recorded", /not recorded/.test(mailPlan({}, FILER).html));
  check("an empty additionalActions block is omitted entirely",
    !/Anything else the teacher did/.test(mailPlan({ ...REF, additionalActions: "" }, FILER).html));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
