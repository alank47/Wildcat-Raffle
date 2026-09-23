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
//
// A GROUP THAT CANNOT BE ANSWERED MUST SAY SO. Socioeconomic status is absent
// -- the meal field answers HTTP 403 -- and a group missing from an equity
// breakdown reads as a group with no disparity, which is the most misleading
// way for data to be absent.
import { readFileSync } from "node:fs";
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
    `${js}\nreturn { chronicBySubgroup, setMe, SMALL_GROUP, CHRONIC, SEVERE, FRAGILE_GROUP, reportedCategories };`)();
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
  check("the screen renders the gaps rather than dropping them",
    /Not available yet/.test(scriptSrc) && /What would fix it/.test(scriptSrc),
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

console.log("\nTHE SCREEN\n");
{
  check("it is a third view on the switch, not another thing to scroll past",
    /data-attview="subgroup"/.test(htmlSrc) && /id="attSubgroupView" hidden/.test(htmlSrc));
  check("the switch button says what it shows",
    /setAttendanceView\('subgroup'\)">By student group</.test(htmlSrc));
  check("all three views are known to the switch",
    /ATT_VIEWS = \['watch', 'perfect', 'subgroup'\]/.test(scriptSrc));
  check("an unknown view still falls back to the absence list",
    /ATT_VIEWS\.indexOf\(view\) === -1 \? 'watch' : view/.test(scriptSrc));
  check("all three halves are toggled, so two cannot show at once",
    ["watchEl", "perfectEl", "subgroupEl"].every((n) =>
      new RegExp(n + "\\.hidden = \\(_attView !== ").test(scriptSrc)));
  check("the wrapper carries no class that could defeat `hidden`",
    !/<div id="attSubgroupView"[^>]*class=/.test(htmlSrc));
  check("the subtitle changes for it too", /subgroup: 'Chronic absence by student group/.test(scriptSrc));
  check("its cache is dropped on the idle refresh", /_sgCache = null/.test(scriptSrc));
  check("the cache is keyed on the denominator, so correcting holidays re-asks",
    /_sgCache\.forDays === (schoolDays|basis\.days)/.test(scriptSrc),
    "otherwise the old divisor's rates stay on screen");
  check("the header Refresh reaches this view", /renderAttendanceSubgroups\(true\)/.test(scriptSrc));
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
