/**
 * What counts as failing a class, for senior privileges.
 *
 * Pure and dependency-free so a plain-node test reaches it, same as
 * academicsRules.ts and courseSubject.ts.
 *
 * THIS FILE IS SEPARATE FROM academicsRules.ts ON PURPOSE. That file answers a
 * statistical question -- what share of posted grades are a D or an F -- and
 * its answer moves a chart. This one answers whether a named eighteen-year-old
 * goes to an event, and it has to be defensible to that student and to their
 * parent. Same arithmetic, different stakes, different place to change it.
 */

/**
 * THE SCHOOL'S RULE, AND THE ONLY LINE THAT MOVES IF IT CHANGES.
 *
 * Set to "DF" on 2026-09-11 by the app owner, asked directly and answered with
 * the real numbers in front of him: four of the forty-one seniors sit between
 * the two readings, their worst mark being a D.
 *
 * NOT A SETTING, and that is deliberate. A privilege rule that two
 * administrators can have set differently in two browsers is worse than either
 * answer, and the moment it is a toggle it is a thing somebody flips to make
 * one particular senior eligible. It changes in a commit, with a line in
 * docs/field-sourcing-approval.md naming who decided and when.
 */
export const FAILING_THRESHOLD: "DF" | "F" = "DF";

export type Threshold = "DF" | "F";
export type Band = "fails" | "passes" | "unposted";

/**
 * Which band a posted mark falls in.
 *
 * THREE BANDS, NOT A BOOLEAN, and the third is the one that matters. A class
 * nobody has marked is not a pass and not a fail: four weeks into the term,
 * treating an unposted class as "passing" clears a student by silence, and
 * treating it as "failing" punishes them for a teacher's data entry. It is
 * counted as unknown and said out loud on the screen.
 *
 * NOTHING IN THE UNPOSTED SET CAN EVER BECOME "fails". That is the property
 * the test pins, because it is the one that would quietly withdraw a privilege.
 */
export function bandOf(raw: unknown, threshold: Threshold = FAILING_THRESHOLD): Band {
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!s || s === "--" || s === "-") return "unposted";
  // An Incomplete is a deferral, not a mark. It is not a fail.
  if (s === "I" || s === "INC" || s === "NG") return "unposted";
  if (s === "P") return "passes";
  if (s === "NP") return "fails";
  const head = s.charAt(0);
  if (head === "F") return "fails";
  if (head === "D") return threshold === "DF" ? "fails" : "passes";
  if (head === "A" || head === "B" || head === "C") return "passes";
  // An unrecognised mark is not evidence of failure.
  return "unposted";
}

/** The failing letter, normalised for display: "F", "D" or "NP". */
export function failingLetterOf(raw: unknown, threshold: Threshold = FAILING_THRESHOLD): string | null {
  if (bandOf(raw, threshold) !== "fails") return null;
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (s === "NP") return "NP";
  return s.charAt(0);
}

/** Worst first, so a row reading "F · F · D" leads with the worst mark. */
const SEVERITY: Record<string, number> = { F: 0, NP: 1, D: 2 };
export function sortFailingLetters(letters: readonly string[]): string[] {
  return [...letters].sort((a, b) => (SEVERITY[a] ?? 9) - (SEVERITY[b] ?? 9));
}

/**
 * BOTH ANSWERS, ALWAYS, whatever the threshold is set to.
 *
 * The screen prints the rule in force and what the other reading would have
 * cost, generated from this rather than typed: "Counting D and F as failing.
 * 4 seniors have a D as their worst grade -- if only F counted, those 4 would
 * show 0 failing classes."
 *
 * So the rule the school is applying is visible on the screen it governs, in
 * front of the person who has to defend it to a parent, and flipping the
 * constant rewrites the sentence instead of stranding it.
 */
export function countUnderBothRules(marks: readonly unknown[]): {
  failingDF: number;
  failingF: number;
  unposted: number;
  passing: number;
  /** True when this student's answer depends on which rule is in force. */
  turnsOnTheRule: boolean;
} {
  let failingDF = 0, failingF = 0, unposted = 0, passing = 0;
  for (const m of marks) {
    const df = bandOf(m, "DF");
    const f = bandOf(m, "F");
    if (df === "fails") failingDF++;
    if (f === "fails") failingF++;
    if (df === "unposted") unposted++;
    else if (df === "passes") passing++;
  }
  return {
    failingDF,
    failingF,
    unposted,
    passing,
    turnsOnTheRule: failingDF > 0 && failingF === 0,
  };
}
