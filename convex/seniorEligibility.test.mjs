// What counts as failing a class, for senior privileges.
//
// This file exists because the rule decides whether a named eighteen-year-old
// goes to an event. The assertions that matter are the ones about what can
// NEVER be read as failing -- an unmarked class, an incomplete, a blank -- and
// the ones that prove flipping FAILING_THRESHOLD is safe.
//
// The suite deliberately does NOT encode which reading is currently in force.
// Answering the owner's question must never be the thing that turns a green
// suite red.
//
// Run: npm test

import {
  bandOf, failingLetterOf, sortFailingLetters, countUnderBothRules,
  FAILING_THRESHOLD,
} from "./seniorEligibility.ts";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\n-- an unmarked class is never a fail, under either rule --");
{
  // THE PROPERTY THAT WOULD QUIETLY WITHDRAW A PRIVILEGE. Four weeks in, most
  // gradebooks are incomplete; if a blank could read as failing, a student
  // loses an event because a teacher has not typed anything yet.
  const blanks = ["", "   ", "--", "-", "I", "INC", "NG", null, undefined, 0, {}, []];
  check("blanks, dashes, incompletes and non-strings are all 'unposted'",
    blanks.every((v) => bandOf(v, "DF") === "unposted" && bandOf(v, "F") === "unposted"));
  check("and not one of them can ever be 'fails'",
    blanks.every((v) => bandOf(v, "DF") !== "fails" && bandOf(v, "F") !== "fails"));
  check("nor can an unrecognised mark", bandOf("Z", "DF") === "unposted");
  check("an unposted mark yields no failing letter", failingLetterOf("--") === null);
}

console.log("\n-- an F fails under both rules --");
{
  check("F", bandOf("F", "DF") === "fails" && bandOf("F", "F") === "fails");
  check("lower case f", bandOf("f", "DF") === "fails" && bandOf("f", "F") === "fails");
  check("F+ and F- follow F",
    bandOf("F+", "F") === "fails" && bandOf("F-", "F") === "fails");
  check("NP fails under both", bandOf("NP", "DF") === "fails" && bandOf("NP", "F") === "fails");
  check("but P never fails", bandOf("P", "DF") === "passes" && bandOf("P", "F") === "passes");
  check("NP keeps its own letter, not its first character",
    failingLetterOf("NP") === "NP");
}

console.log("\n-- a D is the whole question --");
{
  check("D fails when the rule is D-and-F", bandOf("D", "DF") === "fails");
  check("and passes when the rule is F-only", bandOf("D", "F") === "passes");
  check("D+ and D- follow D",
    bandOf("D+", "DF") === "fails" && bandOf("D-", "DF") === "fails" &&
    bandOf("D+", "F") === "passes");
  check("A, B and C pass under both",
    ["A", "B+", "C-"].every((g) => bandOf(g, "DF") === "passes" && bandOf(g, "F") === "passes"));
}

console.log("\n-- the threshold is a constant, not a setting --");
{
  // A privilege rule two administrators could have set differently in two
  // browsers is worse than either answer.
  check("it is one of exactly two values", FAILING_THRESHOLD === "DF" || FAILING_THRESHOLD === "F");
  // Deliberately does NOT assert WHICH. Changing the school's rule is a
  // one-line commit plus a line in the approval doc, not a test failure.
  check("bandOf defaults to it",
    bandOf("D") === bandOf("D", FAILING_THRESHOLD));
}

console.log("\n-- both answers are computed, so the screen can print the other one --");
{
  // One F, one D, one unmarked class, four passes.
  const hand = ["F", "D", "--", "A", "B", "C", "P"];
  const c = countUnderBothRules(hand);
  check("D and F counts two failing", c.failingDF === 2);
  check("F only counts one", c.failingF === 1);
  check("the unmarked class is counted as unknown", c.unposted === 1);
  check("and is not counted as passing", c.passing === 4);
  check("this student's answer does not turn on the rule", c.turnsOnTheRule === false);

  // The four seniors the owner was asked about: worst mark is a D.
  const dOnly = countUnderBothRules(["D", "A", "B"]);
  check("a student whose worst mark is a D fails one under D-and-F",
    dOnly.failingDF === 1);
  check("and none under F-only", dOnly.failingF === 0);
  check("and is flagged as turning on the rule", dOnly.turnsOnTheRule === true);

  const clean = countUnderBothRules(["A", "B", "C"]);
  check("a clean student turns on nothing", clean.turnsOnTheRule === false);
  const empty = countUnderBothRules([]);
  check("no marks at all is not a failure", empty.failingDF === 0 && empty.failingF === 0);
}

console.log("\n-- the worst mark leads the row --");
{
  check("F before NP before D",
    sortFailingLetters(["D", "NP", "F"]).join("") === "FNPD");
  check("it does not mutate its input", (() => {
    const src = ["D", "F"];
    sortFailingLetters(src);
    return src[0] === "D";
  })());
  check("an unknown letter sorts last", sortFailingLetters(["X", "F"])[0] === "F");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
