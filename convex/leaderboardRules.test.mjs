// The Wildcat Cash leaderboard.
//
// A board of children, shown to children. The assertions that matter most are
// about what does NOT leave the server, and about ties -- which the students
// themselves will check against each other within a minute of it appearing.
//
// Run: npm test

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  cashLeaderboard, gradeNumber, studentIdOf, LEADERBOARD_BANDS,
  compactStudent, duplicateIds, placeViewer, LEADERBOARD_SNAPSHOT_VERSION,
} from "./leaderboardRules.ts";

let pass = 0, fail = 0;
const check = (n, c, why) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`)); };

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
  // THIS ASSERTION USED TO READ "a zero earner IS ranked -- zero is a real
  // figure", and it was defensible in isolation: zero IS a real figure, and
  // distinguishing it from "no total yet" is a distinction this file is
  // careful about everywhere else.
  //
  // It was still wrong, and launch eve is when it showed. The school reset
  // every balance on 2026-09-13, so wildcatCashEarned was 0 for all 759
  // students. Every one of them was therefore ranked, all tied at place 1, and
  // the portal would have told all 619 "You are #1 of 619 with $0.00 -- level
  // with 618 others" above ten named classmates on a gold podium at $0.00 --
  // the same ten on every screen, chosen by surname, because the sort falls
  // through to last name on a tie.
  //
  // Zero is not a rank. It is the absence of one. It is counted, so the panel
  // can still say how big the group is.
  const zeroOnly = cashLeaderboard({ students: [S("A", "A", "B", "9", 0)] });
  check("a zero earner is NOT ranked -- zero is the absence of a rank",
    zeroOnly.total === 0 && zeroOnly.top.length === 0);
  check("but is counted, not discarded", zeroOnly.notYetEarned === 1);
  check("and is kept apart from a student with no figure at all",
    zeroOnly.unknownAmount === 0);

  // THE LAUNCH-MORNING SHAPE: a whole school on zero produces a board with
  // nobody on it, which is what the panel's empty state was written for.
  const wholeSchoolZero = cashLeaderboard({
    students: Array.from({ length: 20 }, (_, i) => S("s" + i, "F" + i, "L" + i, "9", 0)),
    viewerId: "s7",
  });
  check("a school that has earned nothing has an EMPTY board",
    wholeSchoolZero.total === 0 && wholeSchoolZero.top.length === 0);
  check("and nobody is told they are number one",
    wholeSchoolZero.viewer && wholeSchoolZero.viewer.rank === null);
  check("and no child is named on a podium for having earned nothing",
    wholeSchoolZero.top.every((r) => r.amount > 0));
  check("the group size is still known", wholeSchoolZero.notYetEarned === 20);

  // AND THE MOMENT ONE CHILD EARNS, the board appears with one name on it.
  const firstEarner = cashLeaderboard({
    students: [S("a", "Ada", "A", "9", 5), S("b", "Bo", "B", "9", 0), S("c", "Cy", "C", "9", 0)],
    viewerId: "b",
  });
  check("one earner makes a board of one", firstEarner.total === 1);
  check("and it is the earner", firstEarner.top[0].name === "Ada A" && firstEarner.top[0].rank === 1);
  check("a zero-earning viewer is told they are not ranked, not that they are last",
    firstEarner.viewer.rank === null);
  // AND IS TOLD THE RIGHT REASON. inBand stays TRUE for a child who is in this
  // group and has simply earned nothing -- it used to be false for both that
  // and "you are in another band", so the panel sent them to the Academy board
  // to be told the same thing. On launch morning that would have been all 619.
  check("and is not told they are in the wrong group", firstEarner.viewer.inBand === true);
  const otherBand = cashLeaderboard({
    students: [S("a", "Ada", "A", "9", 5), S("m", "Mo", "M", "7", 3)],
    band: "hs", viewerId: "m",
  });
  check("a viewer genuinely in another band still reads as out of band",
    otherBand.viewer.rank === null && otherBand.viewer.inBand === false);
}

// ===========================================================================
// THE STORED COPY (2026-10-13). leaderboard:cash now ranks from a copy of
// what the ranking reads (compactStudent), with the viewer's own row read
// live (placeViewer). Every assertion below compares the copy's answer with
// the answer the live read gives on the same rows: the copy is only allowed
// to be OLD, never different.
// ===========================================================================

// A school built to break a copy: ties on amount and on name, every kind of
// bad figure, leavers, a missing studentNumber, odd grades, padded ids, a
// shared id, and identity through each of legacyId, studentNumber and _id.
// Invented names only.
let made = 0;
const SCHOOL = [];
const raw = (o) => { made++; SCHOOL.push({ _id: "k" + made, _creationTime: 1000 + made, firstName: "F" + made, lastName: "L" + made, ...o }); };
{
  const amts = [50, 50, 80, 20, 80, 0, 0, null, undefined, NaN, -5, Infinity, 15, 15, 15, 1e-9, 3.3333333];
  const grades = ["9", "11", "7", "6", " 09 ", "Grade 9", "K", undefined, "12", "8", "10"];
  for (let i = 0; i < 200; i++) {
    const o = { wildcatCashEarned: amts[i % amts.length], grade: grades[i % grades.length] };
    if (i % 3 === 0) o.legacyId = "LG" + i;
    if (i % 4 !== 1) o.studentNumber = "SN" + i;
    if (i % 17 === 0) { o.firstName = "Same"; o.lastName = "Name"; }
    if (i % 29 === 0) o.legacyId = "  LG" + i + " ";
    raw(o);
  }
  raw({ legacyId: "DUP", studentNumber: "SNd1", wildcatCashEarned: 40, grade: "9" });
  raw({ legacyId: "DUP", studentNumber: "SNd2", wildcatCashEarned: 40, grade: "9" });
  for (let i = 0; i < 150; i++) raw({ legacyId: "D" + i, studentNumber: "SND" + i, wildcatCashEarned: 1 + (i % 7), grade: String(6 + (i % 7)) });
}
// Enrolment as the live read derives it: a roster row for the studentNumber.
const enrolledOf = (r) => Boolean(r.studentNumber) && !/7$/.test(r.studentNumber);
const LIVE = SCHOOL.map((r) => ({ ...r, enrolled: enrolledOf(r) }));
const ROWS = SCHOOL.map((r) => compactStudent(r, enrolledOf(r)));
const SNAP = { rows: ROWS, dupIds: duplicateIds(ROWS), newestCreationTime: SCHOOL[SCHOOL.length - 1]._creationTime };
const viewerOf = (r, over) => {
  const me = { ...r, ...(over || {}) };
  return { id: studentIdOf(me), row: compactStudent(me, over && "enrolled" in over ? over.enrolled : enrolledOf(r)), creationTime: me._creationTime };
};
const J = (x) => JSON.stringify(x);

console.log("\n-- the copy ranks every viewer exactly as the live read does --");
{
  const BANDS = ["academy", "hs", "ms", "HS", "", undefined, "bogus"];
  const TOPS = [undefined, 0, -1, 1, 2.5, 10, 50, 51, Infinity, NaN];
  let comparisons = 0, mismatches = 0, fallbacks = 0, firstBad = "";
  for (const me of SCHOOL) {
    const placed = placeViewer(SNAP, viewerOf(me));
    if (!placed.ok) { fallbacks++; continue; }
    for (const band of BANDS) for (const topN of TOPS) {
      const a = cashLeaderboard({ students: placed.students, band, topN: topN ?? 10, viewerId: studentIdOf(me) });
      const b = cashLeaderboard({ students: LIVE, band, topN: topN ?? 10, viewerId: studentIdOf(me) });
      comparisons++;
      if (J(a) !== J(b)) { mismatches++; firstBad = firstBad || `band ${String(band)} topN ${String(topN)}`; }
    }
  }
  check("THE COPY RANKS EVERY VIEWER EXACTLY AS THE LIVE READ: every band and topN",
    comparisons > 20000 && mismatches === 0, `${mismatches} of ${comparisons} differ; first at ${firstBad}`);
  check("  ...and only the two students who share an id are ranked live instead", fallbacks === 2, String(fallbacks));
  check("the shared id is found", J(SNAP.dupIds) === J(["DUP"]));
}

console.log("\n-- the viewer's own row is always live --");
{
  // A change to the viewer since the build: their answer must be the one the
  // live read gives with that change, whatever the copy says about them.
  const changes = [
    ["earned more", (r) => ({ wildcatCashEarned: 999 })],
    ["earned dropped to zero", () => ({ wildcatCashEarned: 0 })],
    ["left the school", () => ({ enrolled: false })],
    ["moved to grade 10", () => ({ grade: "10" })],
    ["renamed", () => ({ firstName: "Renamed", lastName: "Aaa" })],
  ];
  let compared = 0, bad = 0, why = "";
  for (const [label, change] of changes) {
    for (const me of SCHOOL.slice(0, 80)) {
      const over = change(me);
      const v = viewerOf(me, over);
      const placed = placeViewer(SNAP, v);
      if (!placed.ok) continue;
      const liveNow = SCHOOL.map((r) => r === me
        ? { ...r, ...over, enrolled: "enrolled" in over ? over.enrolled : enrolledOf(r) }
        : { ...r, enrolled: enrolledOf(r) });
      for (const band of ["academy", "hs", "ms"]) {
        compared++;
        if (J(cashLeaderboard({ students: placed.students, band, topN: 10, viewerId: v.id })) !==
            J(cashLeaderboard({ students: liveNow, band, topN: 10, viewerId: v.id }))) { bad++; why = why || label; }
      }
    }
  }
  check("the viewer's own changes since the build give the live answer (earned, zeroed, left, regraded, renamed)",
    compared > 1000 && bad === 0, `${bad} of ${compared}; first: ${why}`);

  const NEW = { _id: "new1", _creationTime: SNAP.newestCreationTime + 5, legacyId: "NEW", studentNumber: "SNnew",
    firstName: "Nu", lastName: "Ew", grade: "9", wildcatCashEarned: 15 };
  const placedNew = placeViewer(SNAP, { id: "NEW", row: compactStudent(NEW, true), creationTime: NEW._creationTime });
  check("a student added since the build joins at the end, which is their live place",
    placedNew.ok && J(cashLeaderboard({ students: placedNew.students, band: "hs", topN: 50, viewerId: "NEW" })) ===
      J(cashLeaderboard({ students: [...LIVE, { ...NEW, enrolled: true }], band: "hs", topN: 50, viewerId: "NEW" })));
  const old = SCHOOL[5];
  const renumbered = placeViewer(SNAP, { id: "CHANGED", row: compactStudent({ ...old, legacyId: "CHANGED" }, true), creationTime: old._creationTime });
  check("an old viewer the copy does not know (their id changed) is ranked live: viewer-unplaced",
    !renumbered.ok && renumbered.why === "viewer-unplaced");
  const dup = SCHOOL.find((r) => r.legacyId === "DUP");
  const d1 = placeViewer(SNAP, viewerOf(dup));
  check("a viewer whose id two rows share is ranked live: viewer-duplicated", !d1.ok && d1.why === "viewer-duplicated");
  const late = placeViewer(SNAP, { id: studentIdOf(SCHOOL[3]), row: ROWS[3], creationTime: SNAP.newestCreationTime + 1 });
  check("a new row carrying an id the copy already holds is ranked live too", !late.ok && late.why === "viewer-duplicated");
  const placedSame = placeViewer(SNAP, viewerOf(SCHOOL[10]));
  check("the viewer's row is replaced where it stood, so ties break as they do live",
    placedSame.ok && placedSame.students.length === ROWS.length && placedSame.students[10] !== ROWS[10] &&
    J(placedSame.students[10]) === J(ROWS[10]));
}

console.log("\n-- the copy holds only what the ranking reads --");
{
  // THE FIELD-ACCESS RATCHET. Every field cashLeaderboard reads off a student
  // must be one the copy keeps (or one studentIdOf only falls back to when
  // `id` is missing, which in the copy it never is). A rule that starts
  // reading a new field would silently rank from a copy that lacks it.
  const ALLOWED = ["_id", "enrolled", "firstName", "grade", "id", "lastName", "legacyId", "studentNumber", "wildcatCashEarned"];
  const seen = new Set();
  const watched = LIVE.map((r) => new Proxy(r, { get(o, k) { if (typeof k === "string") seen.add(k); return o[k]; } }));
  for (const band of ["academy", "hs", "ms"]) {
    cashLeaderboard({ students: watched, band, topN: 50, viewerId: "LG3" });
    cashLeaderboard({ students: watched, band, topN: 50, viewerId: "nobody" });
  }
  const extra = [...seen].filter((k) => !ALLOWED.includes(k));
  check("cashLeaderboard reads only the fields the copy keeps",
    extra.length === 0 && seen.has("wildcatCashEarned") && seen.has("grade"),
    `it now reads ${extra.join(", ")}: add it to compactStudent and bump the version`);

  // THE VERSION PIN. A copy written by an older compactStudent is never
  // served, but only if the version moves when compactStudent does. The pin
  // is the source text of compactStudent and the two helpers whose output it
  // stores, with the version; editing one without the other fails here.
  const src = readFileSync(new URL("./leaderboardRules.ts", import.meta.url), "utf8");
  const fnText = (name) => {
    const at = src.search(new RegExp(`export function ${name}\\(`));
    if (at < 0) return "";
    const open = src.indexOf("{", src.indexOf(")", at));
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
    }
    return "";
  };
  const body = ["compactStudent", "earnedOf", "studentIdOf"].map(fnText);
  const hash = createHash("sha256").update(body.map((b) => b.replace(/\s+/g, " ")).join("\n")).digest("hex").slice(0, 16);
  const PINNED = { version: 1, hash: "595a47853a3a4f41" };
  check("the copy's version is pinned to compactStudent: change one, change both",
    body.every(Boolean) && LEADERBOARD_SNAPSHOT_VERSION === PINNED.version && hash === PINNED.hash,
    `version ${LEADERBOARD_SNAPSHOT_VERSION}, hash ${hash}. If compactStudent changed on purpose, bump ` +
    `LEADERBOARD_SNAPSHOT_VERSION and pin { version, hash } here`);

  const shape = ROWS.every((r) => Object.keys(r).every((k) => ["id", "enrolled", "firstName", "lastName", "grade", "wildcatCashEarned"].includes(k)));
  check("no row holds a field outside the stored validator", shape);
  const leavers = ROWS.filter((r) => r.enrolled === false);
  check("a student who has left is held as { id, enrolled: false } and nothing else",
    leavers.length > 20 && leavers.every((r) => J(Object.keys(r).sort()) === J(["enrolled", "id"])));
  const unranked = ROWS.filter((r) => r.enrolled !== false && !(r.wildcatCashEarned > 0));
  check("rows with zero or unknown earnings hold no names",
    unranked.length > 20 && unranked.every((r) => !("firstName" in r) && !("lastName" in r)));
  check("  ...while every earner keeps both names", ROWS.filter((r) => r.wildcatCashEarned > 0).every((r) => r.firstName && r.lastName));
  check("an unknown figure is stored as null, never as zero",
    compactStudent({ legacyId: "U", wildcatCashEarned: NaN }, true).wildcatCashEarned === null &&
    compactStudent({ legacyId: "U", wildcatCashEarned: -5 }, true).wildcatCashEarned === null &&
    compactStudent({ legacyId: "U" }, true).wildcatCashEarned === null);
  check("every row is known by an id, and the copy's id is the raw row's", ROWS.every((r, i) => r.id && r.id === studentIdOf(SCHOOL[i])));
  check("the grade is kept as written (bands read the raw string)", compactStudent({ legacyId: "G", grade: " 09 ", wildcatCashEarned: 3 }, true).grade === " 09 ");
}

console.log("\n-- ONLY THE TOP ARE NAMED, through the copy too --");
{
  const many = [];
  for (let i = 0; i < 200; i++) many.push(S("X" + i, "First" + i, "Last" + i, "9", 200 - i, { _creationTime: i + 1 }));
  const rows = many.map((r) => compactStudent(r, true));
  const snap = { rows, dupIds: duplicateIds(rows), newestCreationTime: 200 };
  const me = many[150];
  const placed = placeViewer(snap, { id: "X150", row: compactStudent(me, true), creationTime: me._creationTime });
  const r = cashLeaderboard({ students: placed.students, band: "academy", topN: 10, viewerId: "X150" });
  const names = JSON.stringify(r);
  check("through the copy, the viewer deep down still learns their place", placed.ok && r.viewer.rank === 151 && r.top.length === 10);
  check("and a student ranked 151st is not named in the payload", !names.includes("First150"));
  check("nor is anyone below the top ten", !names.includes("First11"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
