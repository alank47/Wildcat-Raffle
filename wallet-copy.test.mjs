// House style for the student wallet's copy.
//
// The app already had a convention and it was easy to break by accident:
// card LABELS are Title Case (Grades, Hall Pass, Student ID) and LEADS are
// sentence case with no full stop (None active, Not issued). A card added
// later shipped "Raffle tickets" sitting next to "Wildcat Jackpot", which is
// the kind of thing nobody notices in review and every student notices.
//
// Asserted rather than proof-read, so the next card added is held to it too.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

// The wallet card builders, bounded by the block they live in.
// Bounded by a function that EXISTS. The first version ended the slice at
// `wpStack`, which does not, so indexOf returned -1 and the slice ran to the
// end of the file — dragging Storage Health's labels into a test about the
// student wallet and failing on copy it was never meant to judge.
const wStart = script.indexOf("const WP_FACE = {");
const wEnd = script.indexOf("function wpClockCaption");
const wallet = script.slice(wStart, wEnd);

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const grab = (re) => [...wallet.matchAll(re)].map((m) => m[1]);

const check0 = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };
check0("the wallet block was located, not the whole file",
  wStart > 0 && wEnd > wStart && wallet.length < 120000);

// Words that stay lowercase inside a Title Case heading.
const SMALL = new Set(["a", "an", "the", "of", "and", "or", "in", "on", "at", "to", "for"]);
const isTitleCase = (s) => s.split(/\s+/).every((w, i) => {
  const bare = w.replace(/[^A-Za-z]/g, "");
  if (!bare) return true;
  if (i > 0 && SMALL.has(bare.toLowerCase())) return true;
  return /^[A-Z]/.test(bare);
});
const isSentenceCase = (s) => /^[A-Z0-9$]/.test(s.trim());

console.log("\nCard labels are Title Case");
{
  const labels = grab(/label: '([^']+)'/g);
  check("labels were found", labels.length >= 6);
  labels.forEach((l) => check(`"${l}"`, isTitleCase(l)));
}

console.log("\nGroup headings are Title Case, and agree with each other");
{
  // BOTH heading classes, and headings passed as ARGUMENTS as well as written
  // inline. "Raffle Tickets" moved into the accordion head when the card became
  // collapsible, where it is a parameter — so a regex reading the markup
  // captured the template expression rather than the words, and the rule
  // stopped covering the very heading that prompted it.
  const titles = grab(/wp-(?:group|acc)-title">([^<]+)</g)
    .filter((t) => !/wpEsc|\+/.test(t))
    .concat(grab(/section\('[a-z]+', '([^']+)'/g));
  check("headings were found, including the ones passed in", titles.length >= 3);
  titles.forEach((t) => check(`"${t}"`, isTitleCase(t)));
  // The specific regression: two headings on one card in different styles.
  check("Raffle Tickets and Wildcat Jackpot match",
    titles.includes("Raffle Tickets") && titles.includes("Wildcat Jackpot"));
}

console.log("\nLeads are sentence case and carry no full stop");
{
  const leads = grab(/lead: '([^']+)'/g);
  // FOUR, NOT FIVE. Schedule and Grades left the wallet when the desk
  // dashboard took them, and they carried a lead each. The number here is
  // only a guard that the regex matched real code rather than nothing; it is
  // not a claim about how many cards the wallet should have.
  check("leads were found", leads.length >= 4);
  leads.forEach((l) => {
    check(`"${l}" starts capitalised`, isSentenceCase(l));
    check(`"${l}" has no trailing period`, !/\.$/.test(l.trim()));
  });
}

console.log("\nRow subtitles are labels, not sentences");
{
  const subs = grab(/sub\('[^']+', '([^']+)'/g);
  check("subtitles were found", subs.length >= 3);
  subs.forEach((t) => {
    check(`"${t}" starts capitalised`, isSentenceCase(t));
    check(`"${t}" has no trailing period`, !/\.$/.test(t.trim()));
  });
}

console.log("\nProse is punctuated, and free of obvious slips");
{
  // Body sentences DO end in a full stop, which is the opposite rule to leads.
  const notes = grab(/wp-groupnote">([^<]+)</g);
  check("group notes were found", notes.length >= 2);
  notes.forEach((n) => {
    check(`"${n.slice(0, 40)}…" ends with a full stop", `, /\.$/.test(n.trim()));
    check(`"${n.slice(0, 40)}…" starts capitalised`, isSentenceCase(n));
  });

  // Cheap slips that survive proof-reading.
  const prose = grab(/'([A-Z][^']{20,160}\.)'/g);
  prose.forEach((t) => {
    check(`no double space in "${t.slice(0, 34)}…"`, !/[a-z]  +[a-z]/.test(t));
    check(`no space before punctuation in "${t.slice(0, 34)}…"`, !/\s[,.;]/.test(t));
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
