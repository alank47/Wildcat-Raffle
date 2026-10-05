// What counts as missing work, and every screen agreeing about it. Run: npm test
//
// THE OWNER'S FINAL RULE, 2026-10-05, in their words:
//
//   "If an assignment is above 0% and marked as missing, then consider it
//    missing until the teacher removes the designation.
//    If it's set to 50% or 59% without the missing designation, then it
//    should not be considered missing.
//    0% and missing designation = missing. 0% and no missing designation =
//    missing."
//
// It replaces "the flag decides, not the score" (2026-09-05), under which an
// unticked zero was a separate "scored zero -- ask about a retake" kind, and an
// earlier same-day draft, "anything above 0% is turned in", which was never
// deployed.
//
// WHY THE ASSERTIONS LOOK LIKE THIS. The rule is lifted and run; then every
// server reader that lists or counts missing work is TRANSPILED AND INVOKED
// against an in-memory database holding the same twelve rows, with the real
// pure modules bound and only Convex's wrappers stubbed. A text match would
// pass for a filter applied to the wrong variable; these fail if a row the
// rule calls missing is hidden, relabelled or uncounted anywhere, or a row it
// calls not missing reaches a child.
//
// The twelve rows, one student, one section:
//
//   A  ticked, no score                       missing
//   B  ticked, 0 of 20                        missing
//   C  ticked, 10 of 10       (the report)    missing, until the box is unticked
//   D  ticked, 0.5 of 10                      missing, until the box is unticked
//   E  NOT ticked, 0 of 5                     missing   (was "scored zero")
//   F  NOT ticked, 5 of 10    ("50%")         not missing
//   G  no flag column (1.3.x), 3 of 8         missing   (absent reads as ticked)
//   H  no flag column (1.3.x), no score       missing
//   I  NOT ticked, no score                   not missing (unscored is not zero)
//   J  NOT ticked, -1 of 10                   not missing (negative falls to the box)
//   K  ticked, 4, no point value              missing, until the box is unticked
//   L  NOT ticked, 5.9 of 10  ("59%")         not missing

import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import * as rules from "./missingWorkRules.ts";
import * as gradeProjection from "./gradeProjection.ts";
import * as studentPortalRules from "./studentPortalRules.ts";
import * as views from "./views.ts";
import * as seniorEligibility from "./seniorEligibility.ts";
import * as accessRules from "./accessRules.ts";
import * as identityRules from "./identityRules.ts";
import * as rosterEmail from "./rosterEmail.ts";
import * as raceRollup from "./raceRollup.ts";

const { isMissingWork, onlyMissingWork, teacherMarkedMissing, scoredExactlyZero, markedMissingButScored } = rules;

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
// Comments out, so an assertion about code never matches the prose about it.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
// A region of the SHIPPED script.js, lifted verbatim so the browser's own
// renderer runs here over the server's own output.
const SCRIPT_RAW = readFileSync(new URL("../script.js", import.meta.url), "utf8");
const between = (a, b) => {
  const i = SCRIPT_RAW.indexOf(a);
  const j = SCRIPT_RAW.indexOf(b, i + a.length);
  if (i === -1 || j === -1) throw new Error(`script.js marker not found: ${i === -1 ? a : b}`);
  return SCRIPT_RAW.slice(i, j);
};

const SN = "1001";
const row = (id, o) => ({
  studentNumber: SN, assignmentSectionId: id, assignmentName: `Assignment ${id}`,
  sectionId: "S1", courseName: "English", dueDate: "2026-09-25", syncedAt: "2026-10-05T13:00:00.000Z", ...o,
});
const ROWS = [
  row("A", { isMissing: true, pointsPossible: 10 }),
  row("B", { isMissing: true, scorePoints: 0, pointsPossible: 20 }),
  row("C", { isMissing: true, scorePoints: 10, pointsPossible: 10 }),
  row("D", { isMissing: true, scorePoints: 0.5, pointsPossible: 10 }),
  row("E", { isMissing: false, scorePoints: 0, pointsPossible: 5 }),
  row("F", { isMissing: false, scorePoints: 5, pointsPossible: 10 }),
  row("G", { scorePoints: 3, pointsPossible: 8 }),
  row("H", { pointsPossible: 4 }),
  row("I", { isMissing: false, pointsPossible: 7 }),
  row("J", { isMissing: false, scorePoints: -1, pointsPossible: 10 }),
  row("K", { isMissing: true, scorePoints: 4 }),
  row("L", { isMissing: false, scorePoints: 5.9, pointsPossible: 10 }),
];
const MISSING = "ABCDEGHK";
const MARKED_BUT_SCORED = "CDGK";
const ids = (rows) => rows.map((r) => r.assignmentSectionId ?? r.id).join("");
// What the missing rows still have on the table: max(0, worth - got).
// A 10, B 20, C 0, D 9.5, E 5, G 5, H 4, K 0 (no point value).
const POINTS_ON_TABLE = 53.5;

console.log("\n-- the owner's four sentences --");
{
  check("'above 0% and marked as missing' is missing", isMissingWork({ isMissing: true, scorePoints: 10 }));
  check("...however small the score", isMissingWork({ isMissing: true, scorePoints: 0.5 }));
  check("'50% without the missing designation' is NOT missing", !isMissingWork({ isMissing: false, scorePoints: 5 }));
  check("'59% without the missing designation' is NOT missing", !isMissingWork({ isMissing: false, scorePoints: 5.9 }));
  check("'0% and missing designation' is missing", isMissingWork({ isMissing: true, scorePoints: 0 }));
  check("'0% and no missing designation' is missing", isMissingWork({ isMissing: false, scorePoints: 0 }));
}

console.log("\n-- the edges the sentences do not name --");
{
  check("ticked with no score is missing", isMissingWork({ isMissing: true }));
  // Rows written by plugin 1.3.x carry no flag column; that query returned
  // ticked work only, so absent reads as ticked -- at any score.
  check("no flag column, no score: missing", isMissingWork({}));
  check("no flag column, scored 3: missing (absent is ticked)", isMissingWork({ scorePoints: 3 }));
  check("flag null reads as ticked too", isMissingWork({ isMissing: null, scorePoints: 7 }));
  // Ungraded, excused or not collected: never told to a child as owed.
  check("NOT ticked and NO score is not missing", !isMissingWork({ isMissing: false }));
  check("NOT ticked, score null is not missing", !isMissingWork({ isMissing: false, scorePoints: null }));
  check("-0 is zero", isMissingWork({ isMissing: false, scorePoints: -0 }));
  check("a negative score is not zero and falls to the box",
    !isMissingWork({ isMissing: false, scorePoints: -1 }) && isMissingWork({ isMissing: true, scorePoints: -1 }));
  check("NaN is not zero", !isMissingWork({ isMissing: false, scorePoints: NaN }));
  check("the smallest positive score is not zero", !isMissingWork({ isMissing: false, scorePoints: Number.MIN_VALUE }));
  // The table stores numbers. A string here means something upstream stopped
  // parsing, and guessing "0" means zero is how a row silently changes kind.
  check("the STRING '0' is not a zero", !scoredExactlyZero("0") && !isMissingWork({ isMissing: false, scorePoints: "0" }));
  check("nor is false", !scoredExactlyZero(false));
  // pointsPossible plays no part.
  check("pointsPossible cannot make a zero missing or not",
    isMissingWork({ isMissing: false, scorePoints: 0, pointsPossible: 0 }) &&
    isMissingWork({ isMissing: false, scorePoints: 0 }));
  check("teacherMarkedMissing reads absent and null as ticked, only false as not",
    teacherMarkedMissing({}) && teacherMarkedMissing({ isMissing: null }) && teacherMarkedMissing({ isMissing: true }) &&
    !teacherMarkedMissing({ isMissing: false }));
  check("the fixture classifies as documented",
    ROWS.filter(isMissingWork).map((r) => r.assignmentSectionId).join("") === MISSING,
    ROWS.filter(isMissingWork).map((r) => r.assignmentSectionId).join(""));
}

console.log("\n-- onlyMissingWork --");
{
  const before = JSON.stringify(ROWS);
  const out = onlyMissingWork(ROWS);
  check("keeps exactly the missing rows, in their original order", ids(out) === MISSING, ids(out));
  check("the same objects, not copies with fields lost", out[0] === ROWS[0] && out[4] === ROWS[4]);
  check("does not touch its input", JSON.stringify(ROWS) === before && ROWS.length === 12);
  check("an empty list stays empty", onlyMissingWork([]).length === 0);
}

console.log("\n-- markedMissingButScored: the row a teacher can clear --");
{
  check("ticked with a score above zero, and only those",
    ROWS.filter(markedMissingButScored).map((r) => r.assignmentSectionId).join("") === MARKED_BUT_SCORED,
    ROWS.filter(markedMissingButScored).map((r) => r.assignmentSectionId).join(""));
  check("every one of them is still missing by the rule", ROWS.filter(markedMissingButScored).every(isMissingWork));
  check("a ticked zero is not 'scored'", !markedMissingButScored({ isMissing: true, scorePoints: 0 }));
  check("an unticked score is not 'marked'", !markedMissingButScored({ isMissing: false, scorePoints: 9 }));
  check("Infinity is not a score anybody entered", !markedMissingButScored({ isMissing: true, scorePoints: Infinity }));
}

// ---------------------------------------------------------------------------
// The server, transpiled and invoked. require() hands each module what the
// shipped file imports: the REAL pure modules, and stubs only for Convex's own
// wrappers and the auth/IO helpers. An import nobody mapped throws, so a new
// dependency cannot be silently stubbed as undefined.
// ---------------------------------------------------------------------------
const vStub = new Proxy({}, { get: () => (...a) => ({ _v: true, a }) });
const wrappers = { query: (d) => d, mutation: (d) => d, internalQuery: (d) => d, internalMutation: (d) => d, internalAction: (d) => d };
function load(file, map) {
  const out = ts.transpileModule(read(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  const req = (id) => {
    if (!(id in map)) throw new Error(`${file} imports ${id}, which this harness does not map`);
    return map[id];
  };
  new Function("exports", "require", "module", out)(mod.exports, req, mod);
  return mod.exports;
}

function makeDb(tables) {
  const inserted = [];
  const chain = (rows) => {
    const c = {
      withIndex(_i, fn) {
        const eqs = {}, gts = {};
        const q = { eq(f, val) { eqs[f] = val; return q; }, gt(f, val) { gts[f] = val; return q; } };
        if (fn) fn(q);
        return chain(rows.filter((r) => Object.entries(eqs).every(([k, val]) => r[k] === val)
          && Object.entries(gts).every(([k, val]) => String(r[k]) > String(val))));
      },
      order() { return c; },
      async collect() { return rows.slice(); },
      async take(n) { return rows.slice(0, n); },
      async first() { return rows[0] ?? null; },
      async unique() { return rows[0] ?? null; },
    };
    return c;
  };
  return {
    inserted,
    ctx: {
      db: {
        query: (name) => chain(tables[name] || []),
        insert: async (name, doc) => { inserted.push({ name, doc }); return `id${inserted.length}`; },
        delete: async () => {},
      },
    },
  };
}

console.log("\n-- the write keeps what PowerSchool sent: sisStats.replaceMissingWork --");
{
  const sisStats = load("./sisStats.ts", { "./_generated/server": wrappers, "convex/values": { v: vStub } });
  const db = makeDb({ psMissingWork: [] });
  const res = await sisStats.replaceMissingWork.handler(db.ctx, { syncedAt: "2026-10-05T13:00:00.000Z", rows: ROWS, clearFirst: false });
  const written = db.inserted.filter((x) => x.name === "psMissingWork").map((x) => x.doc);
  // The rule is applied when the table is READ. A write-time filter would
  // make a change of rule a resync instead of a deploy, and lose the raw row.
  check("every row it is sent is written, missing or not", ids(written) === "ABCDEFGHIJKL", ids(written));
  check("and it says so", res.inserted === 12, String(res.inserted));
  check("flag and score are stored exactly as given",
    written.every((d, i) => d.isMissing === ROWS[i].isMissing && d.scorePoints === ROWS[i].scorePoints));
  check("an absent flag stays absent, not defaulted at the write", !("isMissing" in written[6]) && !("isMissing" in written[7]));
}

console.log("\n-- the student's own card: views_app.myStudentView --");
const student = {
  firstName: "Test", lastName: "Student", studentNumber: SN, email: "student@example.org",
  pbisTickets: 0, attendanceTickets: 0, academicTickets: 0, bigRaffleQualified: [],
};
{
  const stub = () => { throw new Error("not expected in myStudentView"); };
  const viewsApp = load("./views_app.ts", {
    "./_generated/server": wrappers, "convex/values": { v: vStub },
    "./identity": { requireStudentSelf: async () => student, requireStaff: stub, requireAdmin: stub },
    "./restrictedPolicy": { restrictedFor: stub },
    "./studentPortalRules": studentPortalRules,
    "./rosterEmail": { teacherRosterEmail: stub },
    "./views": views,
    "./gradeProjection": gradeProjection,
    "./studentStore": { storeSignal: stub },
    "./gradeScopeRead": { readGradeScopeBlock: stub },
    "./missingWorkRules": rules,
  });
  const db = makeDb({
    psMissingWork: ROWS,
    psGrades: [{ studentNumber: SN, sectionId: "S1", courseName: "English", currentGrade: "F", currentPercent: 50, syncedAt: "x" }],
    psSectionPoints: [{ studentNumber: SN, sectionId: "S1", pointsEarned: 50, pointsPossible: 100 }],
  });
  const out = await viewsApp.myStudentView.handler(db.ctx, {});
  const mw = out.grades.missingWork;
  const items = mw.bySection.S1 || [];
  check("the card lists exactly the missing rows", ids(items) === MISSING, ids(items));
  check("the unticked zero is on it", items.some((m) => m.assignmentSectionId === "E"));
  check("the 10 of 10 still ticked is on it, until the teacher unticks it", items.some((m) => m.assignmentSectionId === "C"));
  check("the unticked 50% and 59% are not", !items.some((m) => ["F", "L"].includes(m.assignmentSectionId)));
  check("nor the unticked, unscored row, nor the unticked negative",
    !items.some((m) => ["I", "J"].includes(m.assignmentSectionId)));
  check("the total counts what is listed", mw.total === MISSING.length, String(mw.total));
  // The deployed card words a row from isMissing alone: true is "Missing
  // work" / "ask if you can still turn it in" / "worth N pts"; false is
  // "Scored zero" / "ask about a retake" / "scored 0 of N". Every listed row
  // must take the first, the unticked zero included.
  check("EVERY listed row is sent as missing, so the card says 'Missing work' over all of them",
    items.length === MISSING.length && items.every((m) => m.isMissing === true),
    items.filter((m) => m.isMissing !== true).map((m) => m.assignmentSectionId).join(""));
  check("the score rides along as PowerSchool holds it, null when there is none",
    items.find((m) => m.assignmentSectionId === "C").scorePoints === 10 &&
    items.find((m) => m.assignmentSectionId === "E").scorePoints === 0 &&
    items.find((m) => m.assignmentSectionId === "A").scorePoints === null);
  // "Up to N points back" comes from here: missing work only, less what is
  // already recorded against it.
  const expected = gradeProjection.projectGrade(50, 50, 100, POINTS_ON_TABLE);
  check("the projection is built from missing work only, less recorded points",
    JSON.stringify(mw.projection.S1) === JSON.stringify(expected),
    `${JSON.stringify(mw.projection.S1)} vs ${JSON.stringify(expected)}`);

  // The browser half of the same contract. script.js's ROW wording is not
  // changed by this fix, so it must still decide from isMissing exactly as
  // above; only the heading note and the staff wording changed (below).
  const script = code(readFileSync(new URL("../script.js", import.meta.url), "utf8"));
  check("the card's row wording still turns on isMissing alone",
    /const flagged = m\.isMissing !== false;/.test(script));
  check("and so does its heading count",
    /const nMissing = items\.filter\(function \(m\) \{ return m\.isMissing !== false; \}\)\.length;/.test(script));
  check("and the all-missing heading is 'Missing work'", /'Missing work &middot; ' \+ nMissing/.test(script));

  // RENDERED, NOT MATCHED. This server output is fed through the REAL
  // wpSection and wpGradeOpen lifted from script.js, the way the portal does,
  // and the student's own modal is read. Every row arrives as missing, so the
  // card always takes its all-missing heading note -- over a 0 the teacher
  // typed in without ticking the box as well. That note used to say "Your
  // teacher marked these as not handed in ... not a score you were given",
  // and both halves are false of an entered 0.
  const desk = new Function(`
    const wpEsc = (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const wpEmpty = (t) => '<p class="wp-empty">' + wpEsc(t) + '</p>';
    const wpFoot = (t) => '<p class="wp-foot">' + wpEsc(t) + '</p>';
    const wpPeriodRank = (p) => { const n = parseInt(String(p ?? ""), 10); return isNaN(n) ? 999 : n; };
    const __modal = { innerHTML: "", classList: { add() {}, remove() {} } };
    const __dash = { innerHTML: "", classList: { add() {}, remove() {} } };
    const wpById = (id) => (id === "wpGradeModal" ? __modal : id === "wpDash" ? __dash : null);
    const __store = new Map();
    const localStorage = { getItem: (k) => (__store.has(k) ? __store.get(k) : null), setItem: (k, v) => __store.set(k, String(v)) };
    ${between("function wpSection(node, rowsKey, carry) {", "/* ---- the desk dashboard ---")}
    ${between("/* ---- the desk dashboard ---", "/* ---- end desk dashboard ---- */")}
    return { wpSection, wpDashboard, wpGradeOpen, modal: () => __modal.innerHTML };
  `)();
  desk.wpDashboard({ points: {}, wildcatCash: {}, attendance: {} }, { rows: [], available: true, reason: null },
    desk.wpSection(out.grades, "courses", ["missingWork"]));
  desk.wpGradeOpen("S1");
  const modal = desk.modal();
  const note = (/<span class="wp-missing-note">([\s\S]*?)<\/span>/.exec(modal) || [])[1] || "";
  check("the student's modal opens over this server output", /wp-modal-title">English</.test(modal), modal.slice(0, 200));
  check("headed 'Missing work' over all eight, the entered 0 among them",
    /Missing work &middot; 8 assignments/.test(modal) && /Assignment E/.test(modal));
  check("the heading note never says the teacher marked an entered 0 'not handed in'",
    note !== "" && !/marked these as not handed in/i.test(note), note);
  check("nor that its 0 is 'not a score you were given'", !/not a score you were given/i.test(note), note);
  check("it names both ways work counts as missing: marked missing, or a 0 entered",
    /marked each one missing/.test(note) && /entered a 0/.test(note), note);
  check("and no row asks about a retake", !/ask about a retake/.test(modal));
}

console.log("\n-- Early Warning: earlyWarning.countsForStudent --");
{
  const ew = load("./earlyWarning.ts", {
    "./_generated/server": wrappers, "convex/values": { v: vStub },
    "./identity": { requireStaff: async () => ({ role: "admin" }) },
    "./accessRules": accessRules,
    "./psBehavior": { readCoverage: async () => null },
    "./missingWorkRules": rules,
  });
  const db = makeDb({
    psMissingWork: [
      ...ROWS,
      // A 0% section whose only work is an UNTICKED ZERO. That is a teacher
      // grading, and by the rule it is missing work, so the zero is real.
      row("M", { sectionId: "S2", isMissing: false, scorePoints: 0, pointsPossible: 10 }),
      // A 0% section whose only row is an unticked 6 of 10: not missing, so it
      // corroborates nothing, and the 0% stays "ungraded".
      row("N", { sectionId: "S3", isMissing: false, scorePoints: 6, pointsPossible: 10 }),
    ],
    psGrades: [
      { studentNumber: SN, sectionId: "S1", currentPercent: 0, syncedAt: "x" },
      { studentNumber: SN, sectionId: "S2", currentPercent: 0, syncedAt: "x" },
      { studentNumber: SN, sectionId: "S3", currentPercent: 0, syncedAt: "x" },
    ],
  });
  const got = await ew.countsForStudent(db.ctx, { studentNumber: SN, syncedAt: "x" }, "2026-09-21");
  const r = got.row;
  const owed = r.missingRecent + r.missingOlder + r.missingUndated;
  check("owed work is exactly the rule's missing rows, the unticked zeros included",
    owed === MISSING.length + 1, String(owed));
  check("all of them are recent against the cutoff", r.missingRecent === MISSING.length + 1, String(r.missingRecent));
  check("a 0% section with missing work counts as failing", r.failingCoursesRaw === 3);
  check("an unticked zero corroborates a 0%, a ticked box is not needed",
    r.failingCourses === 2, `failing ${r.failingCourses}`);
  check("an unticked score above zero corroborates nothing: that 0% is ungraded",
    r.ungradedCourses === 1, `ungraded ${r.ungradedCourses}`);
  check("the feed is still seen as alive", r.hasMissingFeed === true);

  // A DROPPED CLASS IS NOT OWED WORK. Same student, plus missing rows in a
  // section no grade row names (the class was dropped): they must not count,
  // while a row with no section at all still does.
  const dropDb = makeDb({
    psMissingWork: [
      ...ROWS,
      row("P", { sectionId: "DROPPED", isMissing: true, pointsPossible: 10 }),
      row("Q", { sectionId: "DROPPED", isMissing: false, scorePoints: 0, pointsPossible: 10 }),
      row("R", { sectionId: "", isMissing: true, pointsPossible: 10 }),
    ],
    psGrades: [{ studentNumber: SN, sectionId: "S1", currentPercent: 50, syncedAt: "x" }],
  });
  const dropped = (await ew.countsForStudent(dropDb.ctx, { studentNumber: SN, syncedAt: "x" }, "2026-09-21")).row;
  const droppedOwed = dropped.missingRecent + dropped.missingOlder + dropped.missingUndated;
  check("missing work in a dropped class is not counted; a row with no section still is",
    droppedOwed === MISSING.length + 1, String(droppedOwed));
  const noGradesDb = makeDb({
    psMissingWork: [row("P", { sectionId: "DROPPED", isMissing: true, pointsPossible: 10 })],
    psGrades: [],
  });
  const noGrades = (await ew.countsForStudent(noGradesDb.ctx, { studentNumber: SN, syncedAt: "x" }, "2026-09-21")).row;
  check("a student with no grade rows at all keeps every missing row (a gap, not a dropped class)",
    noGrades.missingRecent + noGrades.missingOlder + noGrades.missingUndated === 1);

  // And the calibration tool measures the same owed work the screen counts.
  const prof = load("./earlyWarningProfile.ts", {
    "./_generated/server": wrappers, "convex/values": { v: vStub },
    "./earlyWarning": ew, "./raceRollup": raceRollup, "./missingWorkRules": rules,
  });
  const pdb = makeDb({ psAttendance: [{ studentNumber: SN, daysAbsentYtd: 0, daysTardyTerm: 0 }], psMissingWork: ROWS, psGrades: [] });
  const cal = await prof.calibrate.handler(pdb.ctx, { schoolDays: 30, today: "2026-10-05" });
  check("earlyWarningProfile.calibrate counts owed work by the same rule",
    cal.missRecent[String(MISSING.length)] === 1, JSON.stringify(cal.missRecent));
  const pr = await prof.profile.handler(pdb.ctx, { schoolDays: 30 });
  check("and so does earlyWarningProfile.profile", pr.missCount[String(MISSING.length)] === 1, JSON.stringify(pr.missCount));

  // corroboration buckets each below-60 grade by the missing work in the SAME
  // section. Invoked, because the reader-coverage check further down passes
  // for this file as long as ANY of its queries calls the rule: corroboration
  // could drop unticked zeros and still pass it.
  const cdb = makeDb({
    psAttendance: [{ studentNumber: SN }],
    psSectionPoints: [],
    psMissingWork: [
      ...ROWS,
      // S2: a 0% whose only work is an UNTICKED ZERO -- missing by the rule.
      row("M", { sectionId: "S2", isMissing: false, scorePoints: 0, pointsPossible: 10 }),
      // S3: a 0% whose only row is an unticked 6 of 10 -- not missing.
      row("N", { sectionId: "S3", isMissing: false, scorePoints: 6, pointsPossible: 10 }),
      // S4: a 40% whose only row is TICKED with 7 of 10 -- missing until unticked.
      row("O", { sectionId: "S4", isMissing: true, scorePoints: 7, pointsPossible: 10 }),
    ],
    psGrades: [
      { studentNumber: SN, sectionId: "S1", currentPercent: 0 },
      { studentNumber: SN, sectionId: "S2", currentPercent: 0 },
      { studentNumber: SN, sectionId: "S3", currentPercent: 0 },
      { studentNumber: SN, sectionId: "S4", currentPercent: 40 },
    ],
  });
  const cor = await prof.corroboration.handler(cdb.ctx, {});
  const z = cor.zeroPercentRows, lo = cor.lowButNotZeroRows;
  check("earlyWarningProfile.corroboration: an unticked zero corroborates a 0%",
    z["flagged1-2"] === 1, JSON.stringify(z));
  check("the section with eight missing rows reads 3+", z["flagged3+"] === 1, JSON.stringify(z));
  check("an unticked 6 of 10 corroborates nothing", z.noFlaggedWorkInThatSection === 1, JSON.stringify(z));
  check("a ticked box carrying a score still corroborates a low grade",
    lo["flagged1-2"] === 1 && !("noFlaggedWorkInThatSection" in lo), JSON.stringify(lo));
}

console.log("\n-- Senior academics: list and popup --");
{
  const sa = load("./seniorAcademics.ts", {
    "./_generated/server": wrappers, "convex/values": { v: vStub },
    "./identity": { requireAdmin: async () => ({ role: "admin", email: "a@example.org" }) },
    "./seniorEligibility": seniorEligibility,
    "./gradeProjection": gradeProjection,
    "./missingWorkRules": rules,
  });
  const tables = {
    psRoster: [{ studentNumber: SN, gradeLevel: "12", sectionId: "S1", period: "1", teacherEmail: "t@example.org" }],
    psGrades: [{ studentNumber: SN, sectionId: "S1", courseName: "English", currentGrade: "F", currentPercent: 40, syncedAt: "2026-10-05T13:00:00.000Z" }],
    psMissingWork: ROWS,
    psSectionPoints: [],
    students: [{ studentNumber: SN, firstName: "Test", lastName: "Senior" }],
    syncRuns: [{ at: "2026-10-05T13:05:00.000Z" }],
  };
  const list = await sa.failingList.handler(makeDb(tables).ctx, {});
  const s = list.students[0];
  check("the list counts every missing row as not handed in", s.notHandedIn === MISSING.length, String(s.notHandedIn));
  check("and nothing as a separate 'scored zero' kind", s.scoredZero === 0, String(s.scoredZero));
  check("freshness still reads the feed", list.asOf.gradesSyncedAt === "2026-10-05T13:00:00.000Z");

  const d = await sa.detail.handler(makeDb(tables).ctx, { studentNumber: SN });
  const c = d.failing[0];
  const workIds = c ? c.work.map((w) => w.assignmentName.slice(-1)).sort().join("") : "";
  check("the popup shows the same items as the student's card", workIds === MISSING, workIds);
  check("every one reads 'not handed in', the unticked zero included",
    c.work.every((w) => w.flaggedMissing === true) && c.notHandedIn === MISSING.length && c.scoredZero === 0,
    `notHandedIn ${c.notHandedIn} scoredZero ${c.scoredZero}`);
  // The deployed screen marks these "a score is recorded -- the flag may be
  // out of date": the rows a teacher can clear in PowerSchool.
  check("ticked rows carrying a score are named, and only those",
    c.flaggedButScored === MARKED_BUT_SCORED.length &&
    c.work.filter((w) => w.markedMissingButScored).map((w) => w.assignmentName.slice(-1)).sort().join("") === MARKED_BUT_SCORED,
    String(c.flaggedButScored));
  check("the points on the table are the missing work's", c.pointsAvailable === POINTS_ON_TABLE, String(c.pointsAvailable));
  check("nothing that is not missing is shown as orphan work either", d.orphanWork.length === 0);
  check("missing-work freshness still reads every row", d.asOf.missingSyncedAt === "2026-10-05T13:00:00.000Z");
  // Same order as the student's card: every row is missing, so due date alone.
  check("ordered by due date alone, as on the card",
    c.work.map((w) => w.dueDate).every((x, i, a) => i === 0 || a[i - 1] <= x));

  // RENDERED, NOT MATCHED: the REAL renderSeniorAcademics and openSeniorDetail
  // lifted from script.js, run over this list and this popup. scoredZero is 0
  // by construction now, so the old wording printed "(8 not in, 0 scored
  // zero)" and "8 not handed in · 0 scored zero", and called the 0 the teacher
  // typed in for E "not handed in" right beside "scored 0 of 5".
  const els = {};
  const el = (id) => (els[id] = els[id] || { innerHTML: "", textContent: "" });
  const staff = new Function("detailOut", "__el", `
    const document = { getElementById: (id) => (/^(acadSenior|seniorDetail)/.test(id) ? __el(id) : null) };
    const window = { WildcatAuth: { getSession: () => ({ idToken: "t" }), convexQuery: async () => detailOut } };
    const openRefModal = () => {};
    let _seniorData = null, _seniorError = null;
    ${between("function escapeHtml(s) {", "function renderHallOfFame(")}
    ${between("function renderSeniorAcademics() {", "async function openSeniorDetail(")}
    ${between("async function openSeniorDetail(studentNumber) {", "function switchSystemMode(")}
    return { renderSeniorAcademics, openSeniorDetail, setList: (x) => { _seniorData = x; } };
  `);
  const ui = staff(d, el);
  ui.setList(list);
  ui.renderSeniorAcademics();
  const listHtml = el("acadSeniorRows").innerHTML;
  check("the senior list renders this student", /Senior, Test/.test(listHtml), listHtml.slice(0, 200));
  check("the list says how much is outstanding", /8 outstanding/.test(listHtml), listHtml);
  check("and never '0 scored zero' or 'not in' over work that includes an entered 0",
    !/0 scored zero/.test(listHtml) && !/not in,/.test(listHtml), listHtml);

  await ui.openSeniorDetail(SN);
  const pop = el("seniorDetailBody").innerHTML;
  const itemE = (/Assignment E[\s\S]*?<\/div>/.exec(pop) || [""])[0];
  check("the popup renders this student's failing class", /wc-sr-class-name">English</.test(pop), pop.slice(0, 200));
  check("its tally counts all eight and denies no zero",
    /wc-sr-tally">8 outstanding/.test(pop) && !/0 scored zero/.test(pop), (/wc-sr-tally">[^<]*/.exec(pop) || [""])[0]);
  check("its work is headed 'Missing', the rule's own word", /<h5>Missing · 8<\/h5>/.test(pop),
    (/<h5>[^<]*/.exec(pop) || [""])[0]);
  check("the entered 0 reads 'missing' beside its 'scored 0 of 5', never 'not handed in'",
    /· missing</.test(itemE) && /scored 0 of 5/.test(itemE) && !/not handed in/i.test(itemE), itemE);
  check("nothing in the popup calls any of it 'not handed in'", !/not handed in/i.test(pop));
  check("the rows still carrying a score keep their 'flag may be out of date' warning",
    (pop.match(/a score is recorded — the flag may be out of date/g) || []).length === MARKED_BUT_SCORED.length,
    String((pop.match(/a score is recorded — the flag may be out of date/g) || []).length));
}

// The PowerSchool shape of the fixture: every column a STRING, as the API sends
// it, and no is_missing column at all for the two 1.3.x rows (G, H).
const psRaw = (r) => ({
  student_number: r.studentNumber, assignment_section_id: r.assignmentSectionId,
  assignment_name: r.assignmentName, due_date: r.dueDate, section_id: r.sectionId,
  course_name: r.courseName,
  points_possible: r.pointsPossible === undefined ? undefined : String(r.pointsPossible),
  score_points: r.scorePoints === undefined ? undefined : String(r.scorePoints),
  ...(r.isMissing === undefined ? {} : { is_missing: r.isMissing ? "1" : "0" }),
});
// What the sync stores for a row: 1.3.x rows (no column) land as ticked.
const stored = (r) => (r.isMissing === undefined ? true : r.isMissing);

console.log("\n-- the cron writes every row it fetched, flag and score as given --");
{
  // RUN, NOT READ. The real action is invoked with PowerSchool and Convex
  // stubbed at their edges.
  const sisAction = load("./sisAction.ts", {
    "./_generated/server": wrappers,
    "./_generated/api": { internal: new Proxy({}, { get: (_, m) => new Proxy({}, { get: (_, f) => `${String(m)}.${String(f)}` }) }) },
    "convex/values": { v: vStub },
    "./identityRules": identityRules,
    "./rosterEmail": rosterEmail,
    "./missingWorkRules": rules,
  });
  const run = async (missingWork) => {
    const calls = [];
    const env = { PS_HOST: "ps.example.org", PS_SCHOOL_ID: "1", PS_TERM_ID: "2", PS_YEAR_TERM_ID: "3",
      PS_CLIENT_ID: "id", PS_CLIENT_SECRET: "secret", PS_YEAR_ID: "4", PS_FINAL_GRADE_NAME: "F1", PS_STORE_CODE: "Q1" };
    const savedEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    const savedFetch = globalThis.fetch;
    Object.assign(process.env, env);
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "t" }) };
      const name = u.split("/ws/schema/query/")[1].split("?")[0];
      if (name.endsWith(".missing_work")) return missingWork();
      return { ok: true, status: 200, json: async () => ({ record: [] }) };
    };
    const ctx = {
      runQuery: async () => { throw new Error("the sync is not expected to run a query"); },
      runMutation: async (ref, args) => {
        calls.push({ ref, args });
        if (ref === "psSync.clearRoster") return { deleted: 0, remaining: "none" };
        if (ref === "sisStats.replaceMissingWork") return { inserted: args.rows.length, deleted: 0, remaining: "none" };
        if (ref === "sisStats.replaceSectionPoints" || ref === "sisStats.replaceAttendanceBySection") return { moreToClear: false };
        return null;
      },
    };
    try {
      const summary = await sisAction.syncFromPowerSchool.handler(ctx, { reason: "test" });
      return { summary, mw: calls.filter((c) => c.ref === "sisStats.replaceMissingWork").map((c) => c.args) };
    } finally {
      globalThis.fetch = savedFetch;
      for (const [k, val] of Object.entries(savedEnv)) val === undefined ? delete process.env[k] : (process.env[k] = val);
    }
  };

  const full = await run(() => ({ ok: true, status: 200, json: async () => ({ record: ROWS.map(psRaw) }) }));
  const sent = full.mw.flatMap((a) => a.rows);
  check("every fetched row is sent to be written, scored or not", ids(sent) === "ABCDEFGHIJKL", ids(sent));
  check("the score arrives as a number, as given", sent.every((r, i) => r.scorePoints === ROWS[i].scorePoints),
    JSON.stringify(sent.map((r) => r.scorePoints)));
  check("the flag arrives as given, \"0\" read as false and an absent column as ticked",
    sent.every((r, i) => r.isMissing === stored(ROWS[i])), JSON.stringify(sent.map((r) => r.isMissing)));
  check("the run summary counts every row", full.summary.missingWorkRows === 12, String(full.summary.missingWorkRows));
  check("and how many are ticked missing on work that carries a score",
    full.summary.missingWorkMarkedButScored === MARKED_BUT_SCORED.length, String(full.summary.missingWorkMarkedButScored));

  // A fetch of nothing must still empty the table, or every student keeps the
  // last sync's list on the one day it should have gone away.
  const none = await run(() => ({ ok: true, status: 200, json: async () => ({ record: [] }) }));
  check("an empty fetch still clears the table",
    none.mw.some((a) => a.clearFirst === true && a.rows.length === 0) && none.summary.missingWorkMarkedButScored === 0);
  // And a REFUSED fetch keeps the last good list.
  const refused = await run(() => ({ ok: false, status: 403, json: async () => ({}) }));
  check("a refused fetch is reported and clears nothing",
    /HTTP 403/.test(String(refused.summary.missingWorkError)) && refused.mw.length === 0,
    `${refused.summary.missingWorkError} / ${refused.mw.length} calls`);
}

console.log("\n-- npm run sync sends the flag and the score too --");
{
  // The other writer. Without these fields every row it writes lands with no
  // flag and no score. The script is run top to bottom with PowerSchool and
  // `npx convex run` stubbed.
  const src = read("../powerschool/sync/src/sync-to-app.ts").replace(/import\.meta\.url/g, "__metaUrl");
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const sent = [];
  const execFileSync = (_cmd, argv) => {
    const [, , fn, json] = argv;
    const args = JSON.parse(json);
    if (fn === "psSync:clearRoster") return JSON.stringify({ deleted: 0, remaining: "none" });
    if (fn === "sisStats:replaceMissingWork") {
      sent.push(args);
      return JSON.stringify({ inserted: args.rows.length, deleted: 0, remaining: "none" });
    }
    return JSON.stringify({});
  };
  class PowerSchoolClient {
    async namedQuery(name) { return { rows: name.endsWith(".missing_work") ? ROWS.map(psRaw) : [], ms: 0 }; }
    summary() { return { requests: 0 }; }
  }
  const map = {
    "node:child_process": { execFileSync },
    "node:url": { fileURLToPath: (u) => String(u) },
    "./config.ts": { loadConfig: async () => ({ schoolId: 1, termId: 2, yearTermId: 3, yearId: 4, hourlyRequestCeiling: 1 }),
      redactedConfig: () => ({ host: "ps.example.org" }) },
    "./client.ts": { PowerSchoolClient },
    "./manifest.ts": { QUERY_PREFIX: "p" },
  };
  const req = (id) => {
    if (!(id in map)) throw new Error(`sync-to-app.ts imports ${id}, which this harness does not map`);
    return map[id];
  };
  const AsyncFunction = (async () => {}).constructor;
  const logged = [];
  const savedLog = console.log;
  console.log = (...a) => logged.push(a.join(" "));
  try {
    await new AsyncFunction("exports", "require", "module", "__metaUrl", js)({}, req, { exports: {} }, "file:///x/sync-to-app.ts");
  } finally {
    console.log = savedLog;
  }
  const rows = sent.flatMap((a) => a.rows);
  check("all twelve rows are sent", rows.length === 12, String(rows.length));
  check("with the score as a number", rows.every((r, i) => r.scorePoints === ROWS[i].scorePoints),
    JSON.stringify(rows.map((r) => r.scorePoints)));
  check("and the flag, with the string trap handled",
    rows.every((r, i) => r.isMissing === stored(ROWS[i])), JSON.stringify(rows.map((r) => r.isMissing)));
  const line = logged.find((l) => /psMissingWork/.test(l)) ?? "";
  check("the log reports the rows written", /psMissingWork\s+12 rows/.test(line), line.trim());
}

console.log("\n-- every reader of psMissingWork is accounted for --");
{
  // A NEW READER FAILS HERE UNTIL SOMEBODY DECIDES. The ones that show or count
  // work for a student or for staff must ask the rule; the rest are CLI-only
  // diagnostics (internalQuery) that describe the table as stored, or the
  // write path itself.
  const GUARDED = {
    "views_app.ts": "onlyMissingWork(",
    "seniorAcademics.ts": "isMissingWork(",
    "earlyWarning.ts": "isMissingWork(",
    "earlyWarningProfile.ts": "isMissingWork",
  };
  const DIAGNOSTIC = new Set(["legacyPurge.ts", "sisStats.ts"]);
  const readers = readdirSync(new URL(".", import.meta.url))
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .filter((f) => /query\("psMissingWork"\)/.test(code(read("./" + f))));
  const unaccounted = readers.filter((f) => !(f in GUARDED) && !DIAGNOSTIC.has(f));
  check("no reader nobody has decided about", unaccounted.length === 0, unaccounted.join(", "));
  for (const [f, call] of Object.entries(GUARDED)) {
    const src = code(read("./" + f));
    check(`${f} reads psMissingWork and asks the rule`, /query\("psMissingWork"\)/.test(src) && src.includes(call));
    // Deciding on the raw box in a guarded file is how a second rule creeps in.
    check(`${f} never decides on the raw Missing box itself`,
      !/\.isMissing\s*[!=]==?/.test(src) && !/\.isMissing\s*\?/.test(src));
  }
  for (const f of DIAGNOSTIC) {
    const src = code(read("./" + f));
    check(`${f} has no public query or mutation`,
      !/export const \w+ = (query|mutation)\(/.test(src));
  }
}

console.log("\n-- the comments say the rule that is running --");
{
  const server = ["sisAction.ts", "sisStats.ts", "views_app.ts", "schema.ts", "earlyWarning.ts", "seniorAcademics.ts", "earlyWarningProfile.ts"]
    .map((f) => read("./" + f)).join("\n");
  check("no server file still states 'the flag decides, not the score'", !/THE FLAG DECIDES, NOT THE SCORE/i.test(server));
  check("nor the never-deployed 'above 0% is turned in' draft", !/higher than 0% as turned in/i.test(server));
  check("schema.ts no longer says only ISMISSING = 1 lands in the table",
    !/Only AssignmentScore\.ISMISSING = 1 lands/.test(read("./schema.ts")));
  check("schema.ts no longer promises an unticked zero is a retake",
    !/so the question is a retake/.test(read("./schema.ts")));
  // JSDoc continuation stars out and whitespace collapsed, so prose that wraps
  // across lines still matches.
  const flat = (s) => s.replace(/^\s*\*[ \t]?/gm, "").replace(/\s+/g, " ");
  check("the rule file quotes the owner's final words",
    /0% and no missing designation = missing/.test(flat(read("./missingWorkRules.ts"))) &&
    /until the teacher removes the designation/.test(flat(read("./missingWorkRules.ts"))));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
