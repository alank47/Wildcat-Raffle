// Chronic absence by student group. Run: npm test
//
// THE QUESTION, 2026-09-22: chronic absenteeism for Hispanic/Latino, African
// American, English Learner and socioeconomically disadvantaged students. This
// is the equity report every state dashboard carries, and the one legitimate
// use of protected characteristics in this app: it describes how the SCHOOL is
// doing by group and never says anything about a named child.
//
// THE THREE WAYS IT GOES WRONG, and every assertion is about one of them:
//
//   1. A SMALL CELL NAMES A CHILD. Westbrook has 2 Pacific Islander students
//      and 3 Asian students. "50% of Pacific Islander students are chronically
//      absent" is a sentence about one specific child. Suppression therefore
//      happens on the SERVER: a guarantee enforced in the browser is one that
//      already crossed the network.
//   2. THE CALIFORNIA RULE IS IGNORED. Federal reporting asks ethnicity first
//      and Hispanic collapses to one category; the race question is still
//      answered, very commonly 700 (White). A breakdown reading race codes
//      alone reported this predominantly Hispanic school as White, and the
//      school's admin caught it on sight: "I am fairly certain that my school
//      has no white students."
//   3. THE NUMBERS READ AS FINDINGS WHEN THEY ARE NOISE. Measured the same
//      day: 52.4% of the whole school is chronically absent, so every subgroup
//      row is roughly half the students in it. Black or African American is 47
//      students, where one child moves the rate two points. The baseline and
//      the fragility warning are load-bearing, not decoration.
//   4. SUBTRACTION BRINGS A HIDDEN GROUP BACK (found live, 2026-10-11). The
//      whole school minus Hispanic minus Black was the 5 students the floor
//      hid. For PBIS no sum or difference of the answer may describe 1 to 9
//      students; a brute-force reader below tries every one.
//
// A GROUP THAT CANNOT BE ANSWERED MUST SAY SO. Socioeconomic status is absent
// -- the meal field answers HTTP 403 -- and a group missing from an equity
// breakdown reads as a group with no disparity, which is the most misleading
// way for data to be absent.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";

const subSrc = readFileSync(new URL("./convex/attendanceSubgroups.ts", import.meta.url), "utf8");
const rollupSrc = readFileSync(new URL("./convex/raceRollup.ts", import.meta.url), "utf8");
const rosterSrc = readFileSync(new URL("./wildcat-roster.js", import.meta.url), "utf8");
const htmlSrc = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const scriptSrc = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const cssSrc = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

// ---------------------------------------------------------------- the harness
// The shipped query, with the real raceRollup compiled into the same scope so
// the California rule under test is the one that ships. Nothing is copied.
function loadQuery(transform) {
  const strip = (x) => x
    .replace(/^import\b[\s\S]*?from\s*"[^"]*";[ \t]*\n/gm, "")
    .replace(/^export (const|function|type|interface) /gm, "$1 ");
  let body = strip(rollupSrc) + "\n" + strip(subSrc);
  if (transform) body = transform(body);
  const stubs = `
    const query = (d) => d;
    const v = new Proxy({}, { get: () => (...a) => ({ _v: true, a }) });
    let __me = { role: "admin", email: "a@b.org" };
    const requireStaff = async () => __me;
    const setMe = (m) => { __me = m; };
  `;
  const js = ts.transpileModule(stubs + body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(
    `${js}\nreturn { chronicBySubgroup, setMe, SMALL_GROUP, CHRONIC, SEVERE, FRAGILE_GROUP, reportedCategories,
      ELA_LABELS, rankOf, exposesSmallPool, withholdResiduals };`)();
}

function makeCtx(restricted, attendance) {
  return {
    db: {
      query: (name) => ({
        take: async () => (name === "psRestricted" ? restricted.slice() : attendance.slice()),
      }),
    },
  };
}

/** n students in a group, `absent` of them chronically absent over 28 days. */
function cohort(prefix, n, opts) {
  const o = opts || {};
  const restricted = [], attendance = [];
  for (let i = 0; i < n; i++) {
    const num = `${prefix}-${i}`;
    restricted.push({
      studentNumber: num, fedEthnicity: o.fedEthnicity, raceCodes: o.raceCodes,
      elaStatus: o.elaStatus, syncedAt: "2026-09-22T19:00:00Z",
    });
    if (o.noAttendance) continue;
    // 3 of 28 days is 10.7%, chronic. 1 of 28 is 3.6%, not.
    attendance.push({ studentNumber: num, daysAbsentYtd: i < (o.chronic ?? 0) ? 3 : 1 });
  }
  return { restricted, attendance };
}

const merge = (...cs) => ({
  restricted: cs.flatMap((c) => c.restricted),
  attendance: cs.flatMap((c) => c.attendance),
});

const Q = loadQuery();
const run = (data, args) =>
  Q.chronicBySubgroup.handler(makeCtx(data.restricted, data.attendance), args || { schoolDays: 28 });

console.log("\nSMALL GROUPS NEVER BECOME ROWS\n");
{
  // Westbrook's real shape: a very large Hispanic group, a reportable Black
  // group, and four groups of single digits.
  const data = merge(
    cohort("h", 40, { fedEthnicity: "1", chronic: 20 }),
    cohort("b", 12, { fedEthnicity: "0", raceCodes: ["600"], chronic: 6 }),
    cohort("w", 7, { fedEthnicity: "0", raceCodes: ["700"], chronic: 4 }),
    cohort("a", 3, { fedEthnicity: "0", raceCodes: ["201"], chronic: 3 }),
  );
  const res = await run(data);
  const groups = res.rows.filter((r) => r.axis === "race").map((r) => r.group);

  check("the floor is ten enrolled students", Q.SMALL_GROUP === 10);
  check("a group of 7 is not a row", !groups.some((g) => /White/.test(g)), groups.join(","));
  check("a group of 3 is not a row", !groups.some((g) => /Asian/.test(g)));
  check("a group of 12 IS a row", groups.some((g) => /African American/.test(g)), groups.join(","));
  check("the suppressed groups are COUNTED, so the screen can say they exist",
    res.suppressedGroups === 2, String(res.suppressedGroups));

  // The whole point: the suppressed numbers must not be recoverable from the
  // response at all, not merely hidden by the renderer.
  const json = JSON.stringify(res);
  check("no suppressed group's NAME crosses the wire",
    !/White|Asian/.test(json), "a name plus a count is the identification");
  check("...and neither does its rate",
    res.rows.every((r) => r.enrolled >= Q.SMALL_GROUP));
  check("the floor is published so the screen can explain itself",
    res.smallGroupFloor === 10);
}

console.log("\nTHE CALIFORNIA RULE\n");
{
  // A Hispanic student who answered the race question 700 (White), which is
  // the common case and the one that produced a wrong chart.
  const data = merge(
    cohort("h", 30, { fedEthnicity: "1", raceCodes: ["700"], chronic: 15 }),
    cohort("b", 15, { fedEthnicity: "0", raceCodes: ["600"], chronic: 5 }),
  );
  const res = await run(data);
  const race = res.rows.filter((r) => r.axis === "race");

  check("a Hispanic student who ticked White is reported Hispanic, not White",
    race.some((r) => r.group === "Hispanic or Latino" && r.enrolled === 30) &&
    !race.some((r) => r.group === "White"),
    race.map((r) => r.group + ":" + r.enrolled).join(","));
  check("...so the school is not reported as White at all",
    !JSON.stringify(res.rows).includes("White"));
  check("a non-Hispanic student IS counted by race code",
    race.some((r) => r.group === "Black or African American" && r.enrolled === 15));
  check("Hispanic or Latino is listed first, as the question named it",
    race[0]?.group === "Hispanic or Latino", race[0]?.group);

  // UNKNOWN IS NOT "NOT HISPANIC". Assuming no is what reproduces the bug for
  // any student whose ethnicity failed to sync.
  const gap = merge(
    cohort("h", 30, { fedEthnicity: "1", chronic: 10 }),
    cohort("u", 12, { fedEthnicity: "", raceCodes: ["700"], chronic: 4 }),
  );
  const g = await run(gap);
  check("students with no ethnicity recorded are counted and surfaced",
    g.unknownEthnicity === 12, String(g.unknownEthnicity));
  check("...so a sync gap looks like a sync gap, not a demographic finding",
    /unknownEthnicity/.test(subSrc) && /no ethnicity recorded/.test(scriptSrc));
}

console.log("\nABSENCE IS NOT ZERO\n");
{
  // A student with no attendance row has not been MEASURED. Counting them as
  // present would dilute every rate with children nobody has data for.
  const data = merge(
    cohort("m", 20, { fedEthnicity: "1", chronic: 10 }),
    cohort("n", 20, { fedEthnicity: "1", noAttendance: true }),
  );
  const res = await run(data);
  const row = res.rows.find((r) => r.group === "Hispanic or Latino");
  check("unmeasured students are enrolled but not counted in the rate",
    row.enrolled === 40 && row.withAttendance === 20, JSON.stringify(row));
  check("...so the rate is 10 of 20, not 10 of 40",
    row.chronicPct === 50, String(row.chronicPct));
  check("the baseline does the same", res.baseline.enrolled === 40 && res.baseline.withAttendance === 20);
}

console.log("\nTHE THRESHOLD, AND THE DENOMINATOR\n");
{
  check("chronic is 10% of days in session", Q.CHRONIC === 0.10);
  check("severe is 20%", Q.SEVERE === 0.20);

  // IT MUST AGREE WITH ATTENDANCE WATCH. Two thresholds would let one child be
  // chronic on the ranking and fine on this breakdown.
  const tiers = rosterSrc.slice(rosterSrc.indexOf("var ATTENDANCE_TIERS = ["));
  const chronicMin = Number((tiers.match(/key: 'chronic',\s*label: '[^']*',\s*min: ([\d.]+)/) || [])[1]);
  const severeMin = Number((tiers.match(/key: 'severe',\s*label: '[^']*',\s*min: ([\d.]+)/) || [])[1]);
  check("...and it does, against WildcatRoster.ATTENDANCE_TIERS",
    chronicMin === Q.CHRONIC && severeMin === Q.SEVERE,
    `roster chronic ${chronicMin} severe ${severeMin} vs server ${Q.CHRONIC}/${Q.SEVERE}`);

  // The divisor is an ARGUMENT, so the two screens cannot disagree about it.
  check("the denominator comes from the caller, not a server constant",
    /schoolDays: v\.number\(\)/.test(subSrc));
  const none = await run(merge(cohort("h", 20, { fedEthnicity: "1", chronic: 10 })), { schoolDays: 0 });
  check("zero school days refuses rather than dividing by it",
    none.notYet === true && none.rows.length === 0);
  check("...and says why", /no rate can be worked out/i.test(String(none.reason)));

  // EXACTLY ON THE LINE. 3 of 30 days is 10% and must count; 2 of 30 is 6.7%
  // and must not. Integers on purpose: measured against production the same
  // day, all 679 absence figures are whole numbers, and 3/30 is already the
  // nearest double to 0.1 so it compares equal without any epsilon. A
  // fractional value like 2.8 of 28 would come out 0.09999999999999999 and
  // fall the wrong side -- but that shape does not occur in this data, and
  // changing a live ranking for a case that never happens is how a ranking
  // starts disagreeing with itself.
  const edge = {
    restricted: Array.from({ length: 12 }, (_, i) => ({
      studentNumber: "p" + i, fedEthnicity: "1", syncedAt: "s",
    })),
    attendance: Array.from({ length: 12 }, (_, i) => ({
      studentNumber: "p" + i, daysAbsentYtd: i === 0 ? 3 : i === 1 ? 2 : 0,
    })),
  };
  const e = await run(edge, { schoolDays: 30 });
  check("exactly 10% counts as chronic, just under does not",
    e.baseline.chronic === 1, String(e.baseline.chronic));
  const sevData = {
    restricted: Array.from({ length: 12 }, (_, i) => ({
      studentNumber: "s" + i, fedEthnicity: "1", syncedAt: "s",
    })),
    attendance: Array.from({ length: 12 }, (_, i) => ({
      studentNumber: "s" + i, daysAbsentYtd: i === 0 ? 6 : i === 1 ? 5 : 0,
    })),
  };
  const sev = await run(sevData, { schoolDays: 30 });
  check("6 of 30 is severe and 5 is not", sev.baseline.severe === 1, String(sev.baseline.severe));
  check("...and both still count as chronic", sev.baseline.chronic === 2, String(sev.baseline.chronic));
}

console.log("\nENGLISH LEARNERS\n");
{
  const data = merge(
    cohort("el", 20, { fedEthnicity: "1", elaStatus: "EL", chronic: 12 }),
    cohort("rf", 20, { fedEthnicity: "1", elaStatus: "RFEP", chronic: 6 }),
    cohort("eo", 20, { fedEthnicity: "1", elaStatus: "EO", chronic: 10 }),
  );
  const res = await run(data);
  const el = res.rows.filter((r) => r.axis === "el");
  const ela = res.rows.filter((r) => r.axis === "ela");

  check("current English Learners are one group", el.some((r) => /Current English Learner/.test(r.group) && r.enrolled === 20),
    el.map((r) => r.group + ":" + r.enrolled).join(","));
  check("...and everyone else the other, which is what a school acts on",
    el.some((r) => /Not currently/.test(r.group) && r.enrolled === 40));
  check("the full classification is also broken out, because RFEP is the interesting one",
    ela.length === 3 && ela.some((r) => /RFEP/.test(r.group)),
    ela.map((r) => r.group).join(","));
  check("RFEP's rate is computed separately from EL's",
    ela.find((r) => /RFEP/.test(r.group)).chronicPct === 30 &&
    ela.find((r) => /^English Learner$/.test(r.group)).chronicPct === 60);
  check("a blank classification is labelled, not dropped silently",
    /Not recorded/.test(subSrc));
}

console.log("\nEVERY ROW IS READ AGAINST THE SCHOOL\n");
{
  // 52% school-wide is the measured reality. A 55% group is ordinary against
  // it and a 43% group is the actual finding, so the comparison is the point.
  const data = merge(
    cohort("h", 80, { fedEthnicity: "1", elaStatus: "EO", chronic: 40 }),   // 50%
    cohort("b", 20, { fedEthnicity: "0", raceCodes: ["600"], elaStatus: "EO", chronic: 14 }), // 70%
  );
  const res = await run(data);
  check("the baseline is returned, not left for the browser to derive",
    res.baseline && res.baseline.chronicPct !== null, JSON.stringify(res.baseline));
  const b = res.rows.find((r) => r.group === "Black or African American");
  const h = res.rows.find((r) => r.group === "Hispanic or Latino");
  check("each row carries its distance from the school's own rate",
    typeof b.vsSchool === "number" && typeof h.vsSchool === "number");
  check("...positive when worse than the school",
    b.chronicPct === 70 && b.vsSchool > 0, `${b.chronicPct} / ${b.vsSchool}`);
  check("...and negative when better", h.vsSchool < 0, String(h.vsSchool));
  check("the arithmetic is right",
    Math.abs(b.vsSchool - (b.chronicPct - res.baseline.chronicPct)) < 0.11,
    `${b.vsSchool} vs ${b.chronicPct - res.baseline.chronicPct}`);

  // A GROUP BIG ENOUGH TO REPORT CAN STILL BE TOO SMALL TO READ A GAP INTO.
  check("a small-but-reportable group is flagged fragile", b.fragile === true,
    "47 real students means one child moves the rate two points");
  check("...and a large one is not", h.fragile === false);
  check("the fragility floor is published", res.fragileFloor === Q.FRAGILE_GROUP);
  check("the screen explains what fragile means in points",
    /one student moves this by/.test(scriptSrc));
}

console.log("\nWHAT IS MISSING SAYS SO\n");
{
  const res = await run(merge(cohort("h", 20, { fedEthnicity: "1", chronic: 10 })));
  const names = (res.unavailable || []).map((u) => u.group).join(" | ");
  check("socioeconomically disadvantaged is named as unavailable",
    /Socioeconomically disadvantaged/.test(names), names);
  check("...with the real reason, not a shrug",
    res.unavailable.some((u) => /403/.test(u.reason)),
    "the field exists in PowerSchool; the plugin does not request it");
  check("...and the fix, which needs the SIS administrator",
    res.unavailable.some((u) => /plugin/i.test(u.fix) && /re-install/i.test(u.fix)));
  check("IEP and 504 are named too, with their own different reason",
    /IEP/.test(names) && res.unavailable.some((u) => /unconfirmed/i.test(u.reason)));
  // Since 2026-10-07 inside the "About these numbers" fold, named for what it holds.
  check("the screen renders the gaps rather than dropping them",
    /Groups the school asked about that cannot be shown yet/.test(scriptSrc) && /What would fix it/.test(scriptSrc)
    && /cashFoldHtml\('att-sg-about', 'About these numbers'/.test(scriptSrc),
    "a group missing from an equity report reads as a group with no disparity");
}

console.log("\nWHO MAY ASK\n");
{
  const data = merge(cohort("h", 20, { fedEthnicity: "1", chronic: 10 }));
  for (const role of ["admin", "superadmin", "pbis"]) {
    Q.setMe({ role });
    check(`${role} may read it`, (await run(data)).allowed === true);
  }
  for (const role of ["teacher", "campusaide"]) {
    Q.setMe({ role });
    const res = await run(data);
    check(`${role} may NOT`, res.allowed === false);
    check(`...and no row leaks with the refusal`, res.rows.length === 0 && res.baseline === null);
    check(`...and ${role} is told how to get access`, /access level/i.test(String(res.reason)));
  }
  Q.setMe({ role: "admin" });
  check("the gate is the same three roles the attendance ranking uses",
    /const SUBGROUP_ROLES = \["admin", "superadmin", "pbis"\]/.test(subSrc));
  check("no individual's group ever crosses the wire",
    !/studentNumber:/.test(subSrc.slice(subSrc.indexOf("return {\n      allowed: true"))),
    "this returns counts; the row identity is a group, never a child");
}

// ===================================================== THE RESIDUAL TEST
// 2026-10-11, the owner's decision. The ten-student floor hid the 5 students
// who are neither Hispanic nor Black, and the whole-school figure handed them
// straight back: 607 - 555 - 47 = 5, with their chronic and severe counts.
// For PBIS no sum or difference of what the answer holds may describe 1 to 9
// students; admins keep exactly what they had.

/**
 * A top-level function's text: script.js indents them by eight spaces, so a
 * function runs from its line to the first line that is eight spaces and "}".
 * (The same rule attendance-nav.test.mjs lifts by.)
 */
function liftFn(src, name) {
  const m = new RegExp("\\n        (?:async )?function " + name + "\\(").exec(src);
  if (!m) throw new Error("missing function " + name);
  const start = m.index + 1;
  const end = src.indexOf("\n        }\n", start);
  if (end < 0) throw new Error("unterminated function " + name);
  return src.slice(start, end + 10);
}

function breakOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`teeth "${label}": anchor not found exactly once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}

/** The shipped renderer, drawing one answer into a fake panel. */
async function drawGroups(src, res) {
  const body = { innerHTML: "" };
  const make = new Function("body", "res", `
    const document = { getElementById: (id) => (id === "attSubgroupBody" ? body : null) };
    const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const attendanceSchoolDays = () => ({ known: true, days: 28 });
    const loadAttendanceRows = async () => {};
    const attDaysRange = () => "Aug 12 to today";
    const cashChipsHtml = (...a) => a.join(" | ");
    const cashFoldHtml = (id, label, inner) => "<details>" + inner + "</details>";
    const wcClockAt = (s) => String(s);
    const SG_DEAD_BAND = 1.5;
    let _sgBusy = false;
    let _sgCache = { forDays: 28, res };
    async function loadAttendanceSubgroups() { return res; }
    ${liftFn(src, "renderAttendanceSubgroups")}
    return renderAttendanceSubgroups;
  `);
  await make(body, res)(false);
  return body.innerHTML;
}

// ---- residual datasets (the golden hashes below were made from these)
/** [prefix, count, cohort options] for each block of students. */
const build = (...specs) => merge(...specs.map(([p, n, o]) => cohort(p, n, o)));
const HISP = { fedEthnicity: "1", raceCodes: ["700"] };

/** Westbrook as measured 2026-10-11: 555 Hispanic, 47 Black (4 also White), 5 in no shown race. */
const westbrook = () => build(
  ["hEL", 100, { ...HISP, elaStatus: "EL", chronic: 60 }],
  ["hEO", 200, { ...HISP, elaStatus: "EO", chronic: 100 }],
  ["hRF", 185, { ...HISP, elaStatus: "RFEP", chronic: 90 }],
  ["hIF", 70, { fedEthnicity: "1", elaStatus: "IFEP", chronic: 30 }],
  ["b", 43, { fedEthnicity: "0", raceCodes: ["600"], elaStatus: "EO", chronic: 25 }],
  ["bw", 4, { fedEthnicity: "0", raceCodes: ["600", "700"], elaStatus: "EO", chronic: 2 }],
  ["w", 3, { fedEthnicity: "0", raceCodes: ["700"], elaStatus: "EO", chronic: 2 }],
  ["a", 1, { fedEthnicity: "0", raceCodes: ["201"], elaStatus: "EO", chronic: 1 }],
  ["p", 1, { fedEthnicity: "0", raceCodes: ["301"], elaStatus: "EO" }],
);
/** A classification with a pool of 5 in groups under ten: 3 assessment pending, 2 not recorded. */
const elaPool = () => build(
  ["o", 60, { ...HISP, elaStatus: "EO", chronic: 30 }],
  ["r", 40, { ...HISP, elaStatus: "RFEP", chronic: 12 }],
  ["e", 25, { ...HISP, elaStatus: "EL", chronic: 15 }],
  ["i", 15, { ...HISP, elaStatus: "IFEP", chronic: 5 }],
  ["t", 3, { ...HISP, elaStatus: "TBD", chronic: 2 }],
  ["n", 2, { ...HISP, elaStatus: "", chronic: 1 }],
);
/** Non-Hispanic multi-race: 5 students are in both the Black and the White row; 12 are in no race row. */
const multiRace = () => build(
  ["h", 100, { ...HISP, elaStatus: "EO", chronic: 50 }],
  ["b", 30, { fedEthnicity: "0", raceCodes: ["600"], elaStatus: "EO", chronic: 15 }],
  ["w", 25, { fedEthnicity: "0", raceCodes: ["700"], elaStatus: "EO", chronic: 10 }],
  ["bw", 5, { fedEthnicity: "0", raceCodes: ["600", "700"], elaStatus: "EO", chronic: 3 }],
  ["u", 12, { fedEthnicity: "0", elaStatus: "EO", chronic: 6 }],
);
// ---- end residual datasets

/**
 * The admin answer for each dataset, hashed, as the code before 2026-10-11
 * gave it: made by running these datasets through this same harness against
 * `git show 668e785:convex/attendanceSubgroups.ts`. A change that moves an
 * admin's answer by one byte has to come back here and say so.
 */
const GOLDEN = {
  westbrook: "0cf9b7463f50707df000c0a97be0b1550a77848dacb3cc2f66c79b192b09a504",
  elaPool: "d45351f0f42fa22110627d11dc3569ff1acf3ee729d878f3b39b5267ee2c3920",
  multiRace: "af22793202535b2e7bc07b37e4c1e628f58e450ab52e489a83ea6aecc0e3eb36",
};
const sha = (res) => createHash("sha256").update(JSON.stringify(res)).digest("hex");

/** One answer for one role. The role is put back to admin afterwards. */
async function as(role, data, Qx) {
  const q = Qx || Q;
  q.setMe({ role });
  try { return await q.chronicBySubgroup.handler(makeCtx(data.restricted, data.attendance), { schoolDays: 28 }); }
  finally { q.setMe({ role: "admin" }); }
}

/**
 * A BRUTE-FORCE READER, written apart from the server's rank arithmetic: every
 * way of adding, taking away or leaving out each figure in the answer (the
 * whole school and every row), and how many students each one ends up
 * counting. The smallest pool of 1 to 9 is the leak; null means none.
 */
function smallestPool(data, res) {
  const inRow = (r, s) => {
    if (r.axis === "race") return Q.reportedCategories(s).categories.includes(r.group);
    const e = String(s.elaStatus || "").trim().toUpperCase();
    if (r.axis === "el") return (e === "EL" ? "Current English Learner" : "Not currently an English Learner") === r.group;
    if (r.axis === "ela") return (Q.ELA_LABELS[e] ?? (e ? e : "Not recorded")) === r.group;
    throw new Error("unknown axis " + r.axis);
  };
  const figures = [null, ...res.rows];
  for (const r of res.rows) {
    const n = data.restricted.filter((s) => inRow(r, s)).length;
    if (n !== r.enrolled) throw new Error(`reader's ${r.group} has ${n}, the answer ${r.enrolled}`);
  }
  const cells = new Map();
  for (const s of data.restricted) {
    const sig = figures.map((r) => (r === null || inRow(r, s) ? 1 : 0)).join("");
    cells.set(sig, (cells.get(sig) || 0) + 1);
  }
  const list = [...cells.entries()].map(([sig, n]) => ({ v: [...sig].map(Number), n }));
  let best = null;
  const coef = new Array(figures.length).fill(0);
  for (let t = 1; t < 3 ** figures.length; t++) {
    let x = t;
    for (let j = 0; j < figures.length; j++) { coef[j] = (x % 3) - 1; x = Math.floor(x / 3); }
    let pool = 0;
    for (const c of list) {
      let sum = 0;
      for (let j = 0; j < coef.length; j++) sum += coef[j] * c.v[j];
      if (sum !== 0) pool += c.n;
    }
    if (pool > 0 && pool < 10 && (!best || pool < best.pool)) {
      best = { pool, using: figures.map((f, j) => coef[j] ? (coef[j] > 0 ? "+" : "-") + (f ? f.group : "Every student") : "").filter(Boolean).join(" ") };
    }
  }
  return best;
}

const RACE_H = "Hispanic or Latino", RACE_B = "Black or African American";
const groupsOf = (res, axis) => res.rows.filter((r) => r.axis === axis).map((r) => r.group);
const minus = (rows, ...gone) => rows.filter((r) => !gone.includes(r.group));
/** What the answer says it withheld; an answer from before 10/11 has no such field. */
const heldOf = (res) => res.withheld || [];

console.log("\nTHE RESIDUAL TEST: SUBTRACTION CANNOT NAME FEWER THAN TEN (2026-10-11)\n");
{
  const data = westbrook();
  const admin = await as("admin", data);
  const pbis = await as("pbis", data);

  check("the measured shape: 607 enrolled, 555 Hispanic, 47 Black",
    admin.baseline.enrolled === 607 && admin.rows.find((r) => r.group === RACE_H)?.enrolled === 555
    && admin.rows.find((r) => r.group === RACE_B)?.enrolled === 47);
  const leak = smallestPool(data, admin);
  check("THE LEAK, as it was: the whole school minus both rows is 5 students",
    leak && leak.pool === 5, JSON.stringify(leak));

  check("PBIS cannot have the Hispanic row, the Black row AND the whole school",
    !(groupsOf(pbis, "race").includes(RACE_H) && groupsOf(pbis, "race").includes(RACE_B) && pbis.baseline),
    groupsOf(pbis, "race").join(","));
  check("...the Black row is the one withheld, as the smaller of the two",
    groupsOf(pbis, "race").join() === RACE_H, groupsOf(pbis, "race").join(","));
  check("...and no sum or difference of anything PBIS holds counts 1 to 9 students",
    smallestPool(data, pbis) === null, JSON.stringify(smallestPool(data, pbis)));
  const w = heldOf(pbis);
  check("the withheld row leaves as a count per type and a sentence",
    pbis.withheldGroups === 1 && w.length === 1 && w[0].axis === "race" && w[0].groups === 1
    && /^1 more group of 10 or more students is not shown at your access level/.test(w[0].reason)
    && /fewer than 10 students/.test(w[0].reason), JSON.stringify(w));
  check("...never its name", !/Black|African/.test(JSON.stringify(pbis)));
  check("...each withheld entry is a type, a count and a sentence, nothing more",
    w.every((x) => Object.keys(x).join() === "axis,groups,reason"));
  check("which students are in a group never crosses the wire, for anyone",
    !/members/.test(JSON.stringify(pbis)) && !/members/.test(JSON.stringify(admin)));
  check("...never its figures: the only numbers in the sentence are the count and the floor",
    (w[0]?.reason.match(/\d+/g) || []).every((n) => n === "1" || n === "10"), w[0]?.reason);
  check("every row PBIS does get is the admin's, to the byte",
    JSON.stringify(pbis.rows) === JSON.stringify(minus(admin.rows, RACE_B)));
  check("...and so is the whole-school figure, and the small-group count",
    JSON.stringify(pbis.baseline) === JSON.stringify(admin.baseline) && pbis.suppressedGroups === admin.suppressedGroups);
  check("the English Learner rows reach PBIS untouched (both are 10 or more, and they cover everyone)",
    JSON.stringify(pbis.rows.filter((r) => r.axis !== "race")) === JSON.stringify(admin.rows.filter((r) => r.axis !== "race")));
  check("admins still get both race rows: they are approved for an individual's race (2026-08-19)",
    groupsOf(admin, "race").join() === RACE_H + "," + RACE_B);

  // AN OPEN TAB FROM BEFORE 10/11 reads only the fields it always read. Every
  // one of them is still there, the same type; the new ones only add.
  const sameShape = Object.keys(admin).every((k) => k in pbis && typeof pbis[k] === typeof admin[k]
    && Array.isArray(pbis[k]) === Array.isArray(admin[k]));
  check("an open tab's fields are all still there, the same type", sameShape);
  check("...and the two new ones come last, for PBIS only",
    Object.keys(pbis).slice(-2).join() === "withheldGroups,withheld" && !("withheld" in admin) && !("withheldGroups" in admin));
}
{
  // ENGLISH LEARNER YES/NO ALWAYS COVERS EVERYONE: its residual is 0, which is
  // nobody, not a pool. Both rows at 10 or more must reach PBIS as they are.
  for (const [label, el] of [["30 of 100", 30], ["exactly 10 of 100", 10]]) {
    const data = build(
      ["e", el, { ...HISP, elaStatus: "EL", chronic: Math.floor(el / 2) }],
      ["o", 100 - el - 30, { ...HISP, elaStatus: "EO", chronic: 20 }],
      ["r", 30, { ...HISP, elaStatus: "RFEP", chronic: 9 }],
    );
    const admin = await as("admin", data);
    const pbis = await as("pbis", data);
    check(`English Learner yes/no (${label}): PBIS gets both rows, exactly as an admin does`,
      groupsOf(pbis, "el").length === 2 && JSON.stringify(pbis.rows) === JSON.stringify(admin.rows),
      groupsOf(pbis, "el").join(","));
    check(`...and nothing is withheld (${label})`, pbis.withheldGroups === 0 && heldOf(pbis).length === 0,
      JSON.stringify(pbis.withheld));
  }
}
{
  // A CLASSIFICATION WITH A POOL UNDER TEN: assessment pending 3 and not
  // recorded 2 are each hidden by the floor, and together they are the whole
  // school minus the four rows shown.
  const data = elaPool();
  const admin = await as("admin", data);
  const pbis = await as("pbis", data);
  check("the pool is there for the reading, as it was: 145 - 60 - 40 - 25 - 15 = 5",
    smallestPool(data, admin)?.pool === 5 && admin.suppressedGroups === 2, JSON.stringify(smallestPool(data, admin)));
  check("for PBIS the SMALLEST shown classification row is withheld (IFEP, 15)",
    groupsOf(pbis, "ela").join() === "English Only,Reclassified fluent (RFEP),English Learner"
    && groupsOf(admin, "ela").includes("Initially fluent (IFEP)"), groupsOf(pbis, "ela").join(","));
  check("...said as one classification group, with a reason",
    pbis.withheldGroups === 1 && heldOf(pbis).length === 1 && heldOf(pbis)[0].axis === "ela" && heldOf(pbis)[0].groups === 1);
  check("...which leaves a pool of 20, and nothing PBIS holds counts 1 to 9 students",
    smallestPool(data, pbis) === null, JSON.stringify(smallestPool(data, pbis)));
  check("English Learner yes/no is not touched by it",
    JSON.stringify(pbis.rows.filter((r) => r.axis === "el")) === JSON.stringify(admin.rows.filter((r) => r.axis === "el")));
}
{
  // ONE TYPE HANDS ANOTHER'S ROW BACK. "Current English Learner" is the same
  // students as the classification's "English Learner". Here the classification
  // withholds its EL row (12, the smallest) to cover a pool of 4 -- and the
  // yes/no row would put it straight back. The test across types catches it.
  const data = build(
    ["o", 60, { ...HISP, elaStatus: "EO", chronic: 30 }],
    ["r", 40, { ...HISP, elaStatus: "RFEP", chronic: 12 }],
    ["e", 12, { ...HISP, elaStatus: "EL", chronic: 6 }],
    ["t", 4, { ...HISP, elaStatus: "TBD", chronic: 2 }],
  );
  const pbis = await as("pbis", data);
  check("a row withheld from one type cannot come back through another",
    smallestPool(data, pbis) === null, JSON.stringify(smallestPool(data, pbis)));
  check("...and every withheld row is counted under its own type",
    pbis.withheldGroups === heldOf(pbis).reduce((n, x) => n + x.groups, 0) && pbis.withheldGroups >= 2,
    JSON.stringify(pbis.withheld));
}
{
  // TWO TYPES THAT NEARLY COINCIDE: 27 of the 30 Black students are English
  // Learners and so are 3 Hispanic students, so Black minus Current English
  // Learner is 3 students against 3. No single type has a residual at all.
  const data = build(
    ["bE", 27, { fedEthnicity: "0", raceCodes: ["600"], elaStatus: "EL", chronic: 14 }],
    ["bO", 3, { fedEthnicity: "0", raceCodes: ["600"], elaStatus: "EO", chronic: 2 }],
    ["hE", 3, { ...HISP, elaStatus: "EL", chronic: 1 }],
    ["hO", 67, { ...HISP, elaStatus: "EO", chronic: 30 }],
  );
  const admin = await as("admin", data);
  const pbis = await as("pbis", data);
  check("two near-identical groups of different types expose 6 students to an admin's reading",
    smallestPool(data, admin)?.pool === 6, JSON.stringify(smallestPool(data, admin)));
  check("...and to nobody reading PBIS's answer", smallestPool(data, pbis) === null,
    JSON.stringify(smallestPool(data, pbis)));
  // NO SINGLE ROW CLOSES IT: Black is the whole school minus Hispanic, and the
  // EL set is in three rows. So one whole type goes for this answer, as the
  // owner allowed -- fewest rows first, then name -- and the others stay whole.
  check("...by withholding one whole type for this answer (race), not half of each",
    groupsOf(pbis, "race").length === 0 && heldOf(pbis).length === 1 && heldOf(pbis)[0].axis === "race"
    && heldOf(pbis)[0].groups === 2, JSON.stringify(pbis.withheld));
  check("...so both English Learner types reach PBIS as an admin sees them",
    JSON.stringify(pbis.rows) === JSON.stringify(admin.rows.filter((r) => r.axis !== "race")));
}
{
  // MULTI-RACE ERRS TOWARD WITHHOLDING. 5 students are in both the Black and
  // the White row; the whole school minus every race row takes them out twice.
  // Here 12 more are in no race row, so no single sum or difference isolates
  // the 5 -- and the owner's rule withholds a row anyway.
  const data = multiRace();
  const admin = await as("admin", data);
  const pbis = await as("pbis", data);
  check("admins see Hispanic, Black (35) and White (30)",
    groupsOf(admin, "race").join() === [RACE_H, RACE_B, "White"].join());
  check("no sum or difference isolates the 5 counted twice: the withholding below is the rule erring, not arithmetic",
    smallestPool(data, admin) === null, JSON.stringify(smallestPool(data, admin)));
  check("PBIS does not get both rows that share 1 to 9 students: the smaller (White) is withheld",
    groupsOf(pbis, "race").join() === [RACE_H, RACE_B].join() && heldOf(pbis)[0]?.axis === "race",
    groupsOf(pbis, "race").join(","));
}
{
  // ADMINS: THE SAME BYTES AS BEFORE THE TEST EXISTED. GOLDEN holds the hash of
  // the answer the code at 668e785 gave each dataset.
  for (const [name, make] of [["westbrook", westbrook], ["elaPool", elaPool], ["multiRace", multiRace]]) {
    for (const role of ["admin", "superadmin"]) {
      const res = await as(role, make());
      check(`${role}: the ${name} answer is byte-identical to 668e785's`, sha(res) === GOLDEN[name], sha(res));
    }
  }
}
{
  // THE ARITHMETIC THE TEST STANDS ON. rankOf is exact on whole numbers; check
  // it against an independent rank, worked modulo two large primes, on
  // matrices the shape this screen makes.
  const modRank = (m, p) => {
    const a = m.map((r) => r.map((x) => BigInt(x) % p));
    let rank = 0;
    for (let c = 0; c < (a[0] || []).length && rank < a.length; c++) {
      let piv = a.findIndex((r, i) => i >= rank && r[c] !== 0n);
      if (piv < 0) continue;
      [a[piv], a[rank]] = [a[rank], a[piv]];
      const inv = (() => { let b = a[rank][c], e = p - 2n, out = 1n; while (e) { if (e & 1n) out = out * b % p; b = b * b % p; e >>= 1n; } return out; })();
      for (let r = 0; r < a.length; r++) {
        if (r === rank || a[r][c] === 0n) continue;
        const f = a[r][c] * inv % p;
        for (let k = c; k < a[r].length; k++) a[r][k] = ((a[r][k] - f * a[rank][k]) % p + p) % p;
      }
      rank++;
    }
    return rank;
  };
  let seed = 20261011;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let agree = 0, tried = 0;
  for (let t = 0; t < 400; t++) {
    const h = 1 + Math.floor(rnd() * 9), wdt = 1 + Math.floor(rnd() * 12), dense = rnd();
    const m = Array.from({ length: h }, () => Array.from({ length: wdt }, () => (rnd() < dense ? 1 : 0)));
    if (t % 3 === 0 && h > 2) m[h - 1] = m[0].slice();   // a repeated row, so a third are rank-deficient
    tried++;
    const want = Math.max(modRank(m, 1000000007n), modRank(m, 998244353n));
    if (Q.rankOf(m, m[0].map((_, k) => k)) === want) agree++;
  }
  check("rankOf agrees with an independent rank on 400 random 0/1 matrices", agree === tried, `${agree}/${tried}`);
  check("rank of the whole school and two rows that split it is 2",
    Q.rankOf([[1, 1], [1, 0], [0, 1]], [0, 1]) === 2);

  // A CEILING ON THE ARITHMETIC: groups that overlap beyond measuring withhold
  // everything rather than ship what the test did not finish.
  let s2 = 7;
  const r2 = () => ((s2 = (s2 * 1103515245 + 12345) % 2147483648) / 2147483648);
  const tangled = Array.from({ length: 40 }, (_, j) => {
    const members = [];
    for (let i = 0; i < 900; i++) if (r2() < 0.5) members.push(i);
    return { axis: "race", group: "g" + j, enrolled: members.length, members };
  });
  const out = Q.withholdResiduals(tangled, 900);
  check("an answer the test could not finish checking shows no row at all",
    out.shown.length === 0 && out.withheldGroups === 40 && /could not finish/.test(out.withheld[0].reason),
    `${out.shown.length} shown, ${out.withheldGroups} withheld`);
}
{
  // THE SCREEN SAYS IT, UNDER THE TYPE. A type with every row withheld still
  // shows its heading, so a missing group never reads as no gap.
  const pbis = await as("pbis", westbrook());
  const html = await drawGroups(scriptSrc, pbis);
  const reason = pbis.withheld[0].reason;
  check("the reason is drawn under 'By race and ethnicity'",
    html.indexOf("By race and ethnicity") >= 0 && html.indexOf(reason) > html.indexOf("By race and ethnicity")
    && html.indexOf(reason) < html.indexOf("By English Learner status"), html.slice(0, 400));
  const allHeld = { ...pbis, rows: pbis.rows.filter((r) => r.axis !== "race") };
  const html2 = await drawGroups(scriptSrc, allHeld);
  check("...and a type with every row withheld keeps its heading and its reason",
    /By race and ethnicity/.test(html2) && html2.includes(reason));
  const before = { ...pbis };
  delete before.withheld; delete before.withheldGroups;
  const html3 = await drawGroups(scriptSrc, before);
  check("an answer from a server before 10/11 (no withheld field) still draws",
    /By race and ethnicity/.test(html3) && !/not shown at your access level/.test(html3));
}

console.log("\nTHE SCREEN\n");
{
  check("it is a third view on the switch, not another thing to scroll past",
    /data-attview="subgroup"/.test(htmlSrc) && /id="attSubgroupView" hidden/.test(htmlSrc));
  // THE FIVE TABS (2026-10-07): "By student group" is "Student groups", last
  // in the bar, and still hidden from anyone outside the three roles.
  check("the switch button says what it shows",
    /setAttendanceView\('subgroup'\)"><svg[^>]*><use href="#wci-group"><\/use><\/svg> Student groups</.test(htmlSrc));
  check("...and it starts hidden, so a grant holder never sees it flash",
    /data-attview="subgroup" aria-pressed="false" hidden/.test(htmlSrc));
  check("every view is known to the switch, Student groups last",
    /ATT_VIEWS = \['watch', 'window', 'rate', 'perfect', 'subgroup'\]/.test(scriptSrc));
  check("an unknown view still falls back to the absence list",
    /return ATT_VIEWS\.indexOf\(k\) === -1 \? 'watch' : k;/.test(scriptSrc));
  check("every pane is toggled, so two cannot show at once",
    ["perfectEl", "subgroupEl", "rateEl"].every((n) =>
      new RegExp(n + "\\.hidden = \\(_attView !== ").test(scriptSrc)) && /watchEl\.hidden = !listView;/.test(scriptSrc));
  check("the wrapper carries no class that could defeat `hidden`",
    !/<div id="attSubgroupView"[^>]*class=/.test(htmlSrc));
  check("it asks its own question at the top of the tab",
    /Is chronic absence higher for some groups than for the school as a whole\?/.test(htmlSrc));
  check("its cache is dropped on the idle refresh", /_sgCache = null/.test(scriptSrc));
  check("the cache is keyed on the denominator, so correcting holidays re-asks",
    /_sgCache\.forDays === (schoolDays|basis\.days)/.test(scriptSrc),
    "otherwise the old divisor's rates stay on screen");
  check("the header Refresh reaches this view",
    /function refreshAttendanceView\(\) \{\s*return drawAttendanceView\(true\);/.test(scriptSrc)
    && /else if \(view === 'subgroup'\) await renderAttendanceSubgroups\(force === true\);/.test(scriptSrc));
  check("every class the panel uses is in the stylesheet",
    ["wc-sg-card", "wc-sg-baseline", "wc-sg-base-n", "wc-sg-axis", "wc-sg-row",
     "wc-sg-figs", "wc-sg-pct", "wc-sg-delta", "wc-sg-fragile", "wc-sg-gap", "wc-sg-fix",
     "wc-sg-worse", "wc-sg-better", "wc-sg-same"].every((c) => cssSrc.includes("." + c)),
    ["wc-sg-card", "wc-sg-baseline", "wc-sg-base-n", "wc-sg-axis", "wc-sg-row",
     "wc-sg-figs", "wc-sg-pct", "wc-sg-delta", "wc-sg-fragile", "wc-sg-gap", "wc-sg-fix",
     "wc-sg-worse", "wc-sg-better", "wc-sg-same"].filter((c) => !cssSrc.includes("." + c)).join(","));
  // COLOUR MUST NOT CLAIM MORE THAN THE TEXT DOES. The first draft tinted a
  // group green for being 0.1 points below a 52% average, and tinted another
  // amber for 2.9 points while printing "one student moves this by 2.1
  // points" underneath it.
  check("a fragile group is never coloured as a direction",
    /\(d === null \|\| r\.fragile\) \? 'wc-sg-same'/.test(scriptSrc),
    "saying a gap is uncertain in words and certain in colour is worse than silence");
  check("...and a small difference has to clear a dead band first",
    /d > SG_DEAD_BAND \? 'wc-sg-worse'/.test(scriptSrc) &&
    /d < -SG_DEAD_BAND \? 'wc-sg-better'/.test(scriptSrc));
  check("...which is about one student in the smallest reportable group",
    /const SG_DEAD_BAND = 1\.5;/.test(scriptSrc));
  check("colour marks DIRECTION, never the group itself",
    /wc-sg-worse[\s\S]{0,60}border-left-color/.test(cssSrc) &&
    /Colour marks DIRECTION ONLY, never the group/.test(cssSrc),
    "tinting a race row red on 47 students is a claim the data cannot support");
  check("still no partial dark-mode rule anywhere",
    (cssSrc.match(/@media \(prefers-color-scheme/g) || []).length === 0);
}

console.log("\nDO THE ASSERTIONS HAVE TEETH?\n");
{
  // 1. Let small groups through.
  const broken = loadQuery((body) => {
    const before = body;
    body = body.replace("const kept = all.filter((c) => c.enrolled >= SMALL_GROUP);", "const kept = all;");
    if (body === before) throw new Error("teeth 1: anchor moved");
    return body;
  });
  const data = merge(
    cohort("h", 40, { fedEthnicity: "1", chronic: 20 }),
    cohort("a", 3, { fedEthnicity: "0", raceCodes: ["201"], chronic: 3 }),
  );
  const res = await broken.chronicBySubgroup.handler(makeCtx(data.restricted, data.attendance), { schoolDays: 28 });
  check("TEETH: a three-student group reaching the browser is caught",
    JSON.stringify(res.rows).includes("Asian"));
}
{
  // 2. Read race codes alone, ignoring ethnicity -- the original wrong chart.
  const broken = loadQuery((body) => {
    const before = body;
    body = body.replace(
      "if (ethnicity === \"hispanic\") {\n    return { categories: [HISPANIC_LABEL], basis: \"ethnicity\", ethnicity, unmapped, raceLabels };\n  }",
      "");
    if (body === before) throw new Error("teeth 2: anchor moved");
    return body;
  });
  const data = merge(cohort("h", 30, { fedEthnicity: "1", raceCodes: ["700"], chronic: 15 }));
  const res = await broken.chronicBySubgroup.handler(makeCtx(data.restricted, data.attendance), { schoolDays: 28 });
  check("TEETH: reporting a Hispanic school as White is caught",
    JSON.stringify(res.rows).includes("White"));
}
{
  // 3. Count unmeasured students as present.
  const broken = loadQuery((body) => {
    const before = body;
    body = body.replace("      if (absent === undefined) return;\n      c.withAttendance++;",
      "      c.withAttendance++;");
    if (body === before) throw new Error("teeth 3: anchor moved");
    return body;
  });
  const data = merge(
    cohort("m", 20, { fedEthnicity: "1", chronic: 10 }),
    cohort("n", 20, { fedEthnicity: "1", noAttendance: true }),
  );
  const res = await broken.chronicBySubgroup.handler(makeCtx(data.restricted, data.attendance), { schoolDays: 28 });
  const row = res.rows.find((r) => r.group === "Hispanic or Latino");
  check("TEETH: diluting a rate with unmeasured students is caught",
    row.withAttendance === 40 && row.chronicPct === 25);
}
{
  // 4. Drop the fragility flag.
  const broken = loadQuery((body) => {
    const before = body;
    body = body.replace("fragile: c.withAttendance < FRAGILE_GROUP,", "fragile: false,");
    if (body === before) throw new Error("teeth 4: anchor moved");
    return body;
  });
  const data = merge(cohort("b", 20, { fedEthnicity: "0", raceCodes: ["600"], chronic: 14 }));
  const res = await broken.chronicBySubgroup.handler(makeCtx(data.restricted, data.attendance), { schoolDays: 28 });
  check("TEETH: a 20-student group presented as solid is caught",
    res.rows.every((r) => r.fragile === false));
}

// ------------------------------------------------ the residual test's teeth
/** The shipped query with one line changed; the anchor must be there exactly once. */
const breakQuery = (label, from, to) => loadQuery((body) => {
  const at = body.indexOf(from);
  if (at < 0 || body.indexOf(from, at + 1) >= 0) throw new Error(`teeth "${label}": anchor not found exactly once`);
  return body.slice(0, at) + to + body.slice(at + from.length);
});
{
  // 5. The residual test switched off: the live leak comes straight back.
  const broken = breakQuery("test off",
    "function exposesSmallPool(rows: Pooled[], everyone: number, work?: { left: number }): boolean {",
    "function exposesSmallPool(rows: Pooled[], everyone: number, work?: { left: number }): boolean { return false;");
  const data = westbrook();
  const res = await as("pbis", data, broken);
  check("TEETH: with the test off, PBIS gets Hispanic, Black and the whole school -- the 5 again",
    groupsOf(res, "race").join() === RACE_H + "," + RACE_B && smallestPool(data, res)?.pool === 5,
    groupsOf(res, "race").join(","));
}
{
  // 6. Each type checked only on its own: a row comes back through another type.
  const broken = breakQuery("types alone",
    "    while (shown.length && exposesSmallPool(shown, everyone, work)) drop(settle(shown));", "");
  const coupled = build(
    ["o", 60, { ...HISP, elaStatus: "EO", chronic: 30 }],
    ["r", 40, { ...HISP, elaStatus: "RFEP", chronic: 12 }],
    ["e", 12, { ...HISP, elaStatus: "EL", chronic: 6 }],
    ["t", 4, { ...HISP, elaStatus: "TBD", chronic: 2 }],
  );
  const res = await as("pbis", coupled, broken);
  check("TEETH: checking each type alone lets Current English Learner hand back the withheld EL row",
    smallestPool(coupled, res)?.pool === 4, JSON.stringify(smallestPool(coupled, res)));
}
{
  // 7. Largest first: IFEP stays and English Only goes.
  const broken = breakQuery("largest first",
    "  a.enrolled - b.enrolled || a.axis.localeCompare(b.axis)", "  b.enrolled - a.enrolled || a.axis.localeCompare(b.axis)");
  const res = await as("pbis", elaPool(), broken);
  check("TEETH: withholding the largest row instead of the smallest is caught",
    groupsOf(res, "ela").join() !== "English Only,Reclassified fluent (RFEP),English Learner", groupsOf(res, "ela").join(","));
}
{
  // 8. Nobody left over counted as a pool: English Learner yes/no, which always
  // covers everyone, would be withheld from PBIS on every school.
  const broken = breakQuery("zero is a pool",
    "  if (nowhere > 0) cells.set(", "  if (nowhere >= 0) cells.set(");
  const data = build(
    ["e", 30, { ...HISP, elaStatus: "EL", chronic: 15 }],
    ["o", 40, { ...HISP, elaStatus: "EO", chronic: 20 }],
    ["r", 30, { ...HISP, elaStatus: "RFEP", chronic: 9 }],
  );
  const res = await as("pbis", data, broken);
  check("TEETH: treating 'nobody left over' as a pool withholds English Learner yes/no, and is caught",
    groupsOf(res, "el").length < 2, groupsOf(res, "el").join(","));
  const twice = breakQuery("zero counted twice",
    "    if (twice > 0 && twice < SMALL_GROUP) return true;", "    if (twice < SMALL_GROUP) return true;");
  const res2 = await as("pbis", data, twice);
  check("TEETH: ...and so does treating 'nobody in two rows' as a pool",
    groupsOf(res2, "el").length < 2, groupsOf(res2, "el").join(","));
}
{
  // 8b. No whole-type step: two near-identical types lose a row from each.
  const broken = breakQuery("no whole type",
    "    return types.find((t) => closes(t)) ?? [order[0]];", "    return [order[0]];");
  const data = build(
    ["bE", 27, { fedEthnicity: "0", raceCodes: ["600"], elaStatus: "EL", chronic: 14 }],
    ["bO", 3, { fedEthnicity: "0", raceCodes: ["600"], elaStatus: "EO", chronic: 2 }],
    ["hE", 3, { ...HISP, elaStatus: "EL", chronic: 1 }],
    ["hO", 67, { ...HISP, elaStatus: "EO", chronic: 30 }],
  );
  const res = await as("pbis", data, broken);
  check("TEETH: without the whole-type step the English Learner rows are cut as well",
    heldOf(res).some((x) => x.axis !== "race"), JSON.stringify(heldOf(res).map((x) => x.axis + ":" + x.groups)));
}
{
  // 9. Multi-race no longer errs toward withholding.
  const broken = breakQuery("double counting",
    "    if (twice > 0 && twice < SMALL_GROUP) return true;", "");
  const res = await as("pbis", multiRace(), broken);
  check("TEETH: without the double-counting rule PBIS gets both rows that share 5 students",
    groupsOf(res, "race").join() === [RACE_H, RACE_B, "White"].join(), groupsOf(res, "race").join(","));
}
{
  // 10. Admins put through the test: their answer is no longer the old bytes.
  const broken = breakQuery("admins tested",
    'const SEES_EVERY_GROUP = ["admin", "superadmin"];', "const SEES_EVERY_GROUP: string[] = [];");
  const res = await as("admin", westbrook(), broken);
  check("TEETH: an admin answer that changed at all is caught by the golden hash",
    sha(res) !== GOLDEN.westbrook && groupsOf(res, "race").join() === RACE_H);
}
{
  // 11. Running out of arithmetic ships what was not checked.
  const broken = breakQuery("ran out, shipped anyway",
    "    held.push(...shown);\n    shown = [];\n", "");
  let s3 = 7;
  const r3 = () => ((s3 = (s3 * 1103515245 + 12345) % 2147483648) / 2147483648);
  const tangled = Array.from({ length: 40 }, (_, j) => {
    const members = [];
    for (let i = 0; i < 900; i++) if (r3() < 0.5) members.push(i);
    return { axis: "race", group: "g" + j, enrolled: members.length, members };
  });
  const out = broken.withholdResiduals(tangled, 900);
  check("TEETH: an unfinished check that still ships rows is caught", out.shown.length > 0, String(out.shown.length));
}
{
  // 12. A rank that stops at the first empty column undercounts.
  const broken = breakQuery("rank stops early", "    if (p === height) continue;", "    if (p === height) break;");
  let seed = 20261011, wrong = 0;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let t = 0; t < 400; t++) {
    const h = 1 + Math.floor(rnd() * 9), wdt = 1 + Math.floor(rnd() * 12), dense = rnd();
    const m = Array.from({ length: h }, () => Array.from({ length: wdt }, () => (rnd() < dense ? 1 : 0)));
    const cols = m[0].map((_, k) => k);
    if (broken.rankOf(m, cols) !== Q.rankOf(m, cols)) wrong++;
  }
  check("TEETH: a rank that stops early disagrees on the random matrices", wrong > 0, String(wrong));
}
{
  // 13. The screen drops the sentence, or the heading of a type with every row withheld.
  const pbis = await as("pbis", westbrook());
  const reason = heldOf(pbis)[0].reason;
  const noLine = breakOnce(scriptSrc,
    "                if (held) html += '<p class=\"wc-att-basis-note\">' + escapeHtml(held.reason) + '</p>';\n", "", "line");
  check("TEETH: a screen that drops the reason is caught", !(await drawGroups(noLine, pbis)).includes(reason));
  const noHead = breakOnce(scriptSrc, "                if (!rows.length && !held) return;\n", "                if (!rows.length) return;\n", "head");
  const allHeld = { ...pbis, rows: pbis.rows.filter((r) => r.axis !== "race") };
  check("TEETH: a screen that drops a fully withheld type's heading is caught",
    !/By race and ethnicity/.test(await drawGroups(noHead, allHeld)));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
