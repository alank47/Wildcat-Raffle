// The Wildcat Cash leaderboard.
//
// A board of children, shown to children. The assertions that matter most are
// about what does NOT leave the server, and about ties -- which the students
// themselves will check against each other within a minute of it appearing.
//
// Run: npm test

import { cashLeaderboard, gradeNumber, studentIdOf, LEADERBOARD_BANDS } from "./leaderboardRules.ts";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const S = (id, first, last, grade, earned, extra) =>
  Object.assign({ legacyId: id, firstName: first, lastName: last, grade, wildcatCashEarned: earned }, extra || {});

const roster = [
  S("S1", "Ava", "Rogers", "11", 50),
  S("S2", "Kai", "Vega", "9", 50),
  S("S3", "Luz", "Cruz", "7", 80),
  S("S4", "Omar", "Reyes", "12", 20),
  S("S5", "Sam", "Nguyen", "6", 80),
  S("S6", "Nia", "Okafor", "10", null),          // never synced
  S("S7", "Gus", "Diaz", "8", 15, { enrolled: false }), // left
];

console.log("\n-- the three bands --");
{
  const a = cashLeaderboard({ students: roster, band: "academy" });
  const h = cashLeaderboard({ students: roster, band: "hs" });
  const m = cashLeaderboard({ students: roster, band: "ms" });
  check("Academy is everyone with a figure", a.total === 5);
  check("High School is grades 9-12", h.top.every((r) => ["9", "10", "11", "12"].includes(r.grade)));
  check("Middle School is grades 6-8", m.top.every((r) => ["6", "7", "8"].includes(r.grade)));
  check("the bands are labelled for the buttons",
    LEADERBOARD_BANDS.academy.label === "Academy" &&
    LEADERBOARD_BANDS.hs.label === "High School" &&
    LEADERBOARD_BANDS.ms.label === "Middle School");
  check("an unknown band falls back to Academy, never to an empty board",
    cashLeaderboard({ students: roster, band: "nonsense" }).band === "academy");
  check("a missing band is Academy", cashLeaderboard({ students: roster }).band === "academy");
}

console.log("\n-- ties share a place: 1, 2, 2, 4 --");
{
  const r = cashLeaderboard({ students: roster, band: "academy" });
  check("the two on 80 are both first", r.top[0].rank === 1 && r.top[1].rank === 1);
  check("the next pair take third, not second", r.top[2].rank === 3 && r.top[3].rank === 3);
  check("and the one after takes fifth", r.top[4].rank === 5);
  check("ties break by name, so the order is stable between loads",
    r.top[0].name === "Luz Cruz" && r.top[1].name === "Sam Nguyen");
}

console.log("\n-- a student is told their own place --");
{
  const r = cashLeaderboard({ students: roster, band: "academy", viewerId: "S1" });
  check("their rank", r.viewer.rank === 3);
  check("out of how many", r.viewer.of === 5);
  check("their own amount", r.viewer.amount === 50);
  check("and how many they are level with", r.viewer.tiedWith === 1);

  // A middle schooler looking at the High School board is not last -- they are
  // not in it. Rendering that as a rank would be a lie about a child.
  const out = cashLeaderboard({ students: roster, band: "hs", viewerId: "S5" });
  check("a student outside the band has no rank", out.viewer.rank === null);
  check("and is flagged as out of band rather than bottom", out.viewer.inBand === false);
  check("no viewer is returned when none was asked for",
    cashLeaderboard({ students: roster, band: "academy" }).viewer === null);
}

console.log("\n-- ONLY THE TOP ARE NAMED --");
{
  const many = [];
  for (let i = 0; i < 200; i++) many.push(S("X" + i, "First" + i, "Last" + i, "9", 200 - i));
  const r = cashLeaderboard({ students: many, band: "academy", topN: 10, viewerId: "X150" });
  check("ten rows come back, not two hundred", r.top.length === 10);
  check("the total is still reported", r.total === 200);
  check("the viewer deep down the list still learns their place", r.viewer.rank === 151);
  // The whole point: nobody can read the bottom of the board off the response.
  const names = JSON.stringify(r);
  check("a student ranked 151st is not named in the payload", !names.includes("First150"));
  check("nor is anyone below the top ten", !names.includes("First11"));
  check("topN cannot be widened without limit", cashLeaderboard({ students: many, topN: 9999 }).top.length <= 50);
}

console.log("\n-- unknown is not zero --");
{
  const r = cashLeaderboard({ students: roster, band: "academy" });
  check("a student with no earned figure is not ranked", !r.top.some((x) => x.name === "Nia Okafor"));
  check("they are counted separately instead", r.unknownAmount === 1);
  check("and they are not reported as having earned 0",
    !r.top.some((x) => x.amount === 0 && x.name === "Nia Okafor"));
  const v = cashLeaderboard({ students: roster, band: "academy", viewerId: "S6" });
  check("such a student is told they are unranked, not that they are last",
    v.viewer.rank === null && v.viewer.amount === null);
}

console.log("\n-- students who have left are off the board --");
{
  const r = cashLeaderboard({ students: roster, band: "ms" });
  check("an unenrolled student does not appear", !r.top.some((x) => x.name === "Gus Diaz"));
  check("and is not counted in the total", r.total === 2);
}

console.log("\n-- identity --");
{
  check("legacyId wins", studentIdOf({ legacyId: "T1", studentNumber: "9", _id: "z" }) === "T1");
  check("then studentNumber", studentIdOf({ studentNumber: "9", _id: "z" }) === "9");
  check("then the row id", studentIdOf({ _id: "z" }) === "z");
  check("a numeric student number still resolves", studentIdOf({ studentNumber: 12345 }) === "12345");
  check("nothing usable gives an empty string, not a crash", studentIdOf({}) === "");
  // Raw rows out of the database carry no `id` at all. Matching on it alone
  // found nobody, and every student was told they were not ranked.
  check("a raw database row still matches its viewer",
    cashLeaderboard({ students: [S("S1", "A", "B", "9", 10)], viewerId: "S1" }).viewer.rank === 1);
}

console.log("\n-- grades --");
{
  check('"9" is 9', gradeNumber("9") === 9);
  check('" 09 " is 9', gradeNumber(" 09 ") === 9);
  check('"Grade 11" is 11', gradeNumber("Grade 11") === 11);
  check("nothing is null", gradeNumber("") === null && gradeNumber(null) === null);
  check("a student with no grade counts in the Academy",
    cashLeaderboard({ students: [S("N", "No", "Grade", null, 5)], band: "academy" }).total === 1);
  check("but in neither band, rather than being guessed into one",
    cashLeaderboard({ students: [S("N", "No", "Grade", null, 5)], band: "hs" }).total === 0 &&
    cashLeaderboard({ students: [S("N", "No", "Grade", null, 5)], band: "ms" }).total === 0);
}

console.log("\n-- bad input --");
{
  check("no students", cashLeaderboard({ students: [] }).total === 0);
  check("missing students array", cashLeaderboard({}).total === 0);
  check("a negative earned figure is refused, not ranked",
    cashLeaderboard({ students: [S("A", "A", "B", "9", -5)] }).total === 0);
  check("NaN is refused", cashLeaderboard({ students: [S("A", "A", "B", "9", NaN)] }).total === 0);
  check("Infinity is refused", cashLeaderboard({ students: [S("A", "A", "B", "9", Infinity)] }).total === 0);
  check("a zero earner IS ranked -- zero is a real figure", 
    cashLeaderboard({ students: [S("A", "A", "B", "9", 0)] }).total === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
