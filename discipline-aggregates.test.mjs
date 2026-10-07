// The race breakdown counts the referrals the SERVER holds, never a list a
// browser sends. Run: npm test
//
// WHY (2026-10-07). disciplineAggregates:byRace took its referred students
// from the caller. PBIS could send [one child, 'x1'..'x9']: ten distinct
// strings passed the ten-student guard, nine matched nobody, and the single
// row with a count of 1 was that child's race. Now:
//   - every caller's breakdown is built from legacyMirror's referrals; the
//     studentNumbers argument is still ACCEPTED (open tabs send it) and ignored;
//   - an admin's breakdown is today's, fed the same list today's browser
//     built -- proved below against the old code, kept here verbatim;
//   - sinceIso is honoured for admins by the day of the INCIDENT;
//   - PBIS sees the whole year as of a frozen snapshot that moves only when
//     ten more students have been referred, with every cell of fewer than ten
//     referred students withheld (zero included), and complementary
//     suppression so no withheld cell is the total minus the others.
//
// Runs the SHIPPED disciplineAggregates.ts with the real raceRollup and the
// real convex/values validators. The teeth block re-breaks each rule.
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as convexValues from "convex/values";

process.env.TZ = "America/Los_Angeles";
let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const SRC = {
  disciplineAggregates: read("./convex/disciplineAggregates.ts"),
  raceRollup: read("./convex/raceRollup.ts"),
  referralMailRules: read("./convex/referralMailRules.ts"),
};

function load(overrides = {}) {
  const cache = {};
  const stubs = {
    "./_generated/server": { query: (d) => d, internalQuery: (d) => d, mutation: (d) => d, internalMutation: (d) => d },
    "convex/values": convexValues,
    "./identity": {
      requireStaff: async (ctx) => { if (!ctx.staff) throw new convexValues.ConvexError("Staff only."); return ctx.staff; },
      requireAdmin: async (ctx) => {
        if (!ctx.staff || !["admin", "superadmin"].includes(ctx.staff.role)) throw new convexValues.ConvexError("Admins only.");
        return ctx.staff;
      },
    },
  };
  const req = (name) => {
    if (stubs[name]) return stubs[name];
    const key = name.replace(/^\.\//, "");
    if (cache[key]) return cache[key];
    let src = SRC[key];
    if (!src) throw new Error("no module " + name);
    if (overrides[key]) src = overrides[key](src);
    const js = ts.transpileModule(src, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const module = { exports: {} };
    cache[key] = module.exports;
    new Function("require", "module", "exports", js)(req, module, module.exports);
    cache[key] = module.exports;
    return module.exports;
  };
  return { agg: req("./disciplineAggregates"), rollup: req("./raceRollup") };
}

function makeDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed || {}));
  let n = 0;
  for (const t of Object.keys(tables)) tables[t].forEach((r) => { r._id ??= `${t}:${n++}`; r._creationTime ??= n; });
  const reads = [];
  const q = (name) => {
    let rows = (tables[name] || []).slice().sort((a, b) => a._creationTime - b._creationTime);
    const done = (out) => { reads.push(name); return out; };
    const api = {
      withIndex(_i, fn) {
        if (fn) {
          const eqs = {};
          const chain = { eq: (c, v) => { eqs[c] = v; return chain; } };
          fn(chain);
          rows = rows.filter((r) => Object.entries(eqs).every(([c, v]) => r[c] === v));
        }
        return api;
      },
      async first() { return done(rows[0] ?? null); },
      async take(k) { return done(rows.slice(0, k)); },
      async collect() { return done(rows); },
    };
    return api;
  };
  return { tables, reads, db: { query: q } };
}

// ---------------------------------------------------------------- fixtures
// 300 synthetic students, numbers 1001-1300. No real children.
const CATS = [
  ["1", ["700"], 200],   // Hispanic or Latino (ethnicity wins over the 700)
  ["0", ["600"], 60],    // Black or African American
  ["0", ["700"], 30],    // White
  ["0", ["201"], 6],     // Asian: 6 enrolled, under ten -> withheld for everyone
  ["0", ["400"], 4],     // Filipino: 4 enrolled
  ["0", ["100"], 12],    // American Indian or Alaska Native: 12 enrolled, never referred below
];
const RESTRICTED = [], ROSTER = [];
const NUMS = { hisp: [], black: [], white: [], asian: [], fil: [], amind: [] };
{
  let n = 1001;
  const keys = Object.keys(NUMS);
  CATS.forEach(([eth, codes, count], i) => {
    for (let k = 0; k < count; k++, n++) {
      RESTRICTED.push({ studentNumber: String(n), fedEthnicity: eth, raceCodes: codes, syncedAt: "x" });
      ROSTER.push({ studentNumber: String(n) });
      NUMS[keys[i]].push(String(n));
    }
  });
}
let clock = 1000;
const referral = (num, extra = {}) => ({
  doc: "referrals", collection: "behaviorReferrals", mirroredAt: "x", _creationTime: clock += 10,
  payload: { id: "R" + clock, studentNumber: num, date: "2026-09-21", submittedAt: "2026-09-21T16:00:00.000Z", ...extra },
});
/** One referral each for: 24 Hispanic, 10 Black, 6 White students = 40 distinct. */
const forty = () => [
  ...NUMS.hisp.slice(0, 24).map((n) => referral(n)),
  ...NUMS.black.slice(0, 10).map((n) => referral(n)),
  ...NUMS.white.slice(0, 6).map((n) => referral(n)),
];
const BASE = forty();
/** Another 40: Hispanic 29, Black 5, White 6 -- two small cells already hold 11. */
const FORTY_B = () => [
  ...NUMS.hisp.slice(0, 29).map((n) => referral(n)),
  ...NUMS.black.slice(0, 5).map((n) => referral(n)),
  ...NUMS.white.slice(0, 6).map((n) => referral(n)),
];
const seedWith = (refs, extra = {}) => ({ legacyMirror: refs, psRestricted: RESTRICTED, psRoster: ROSTER, ...extra });

const ADMIN = { email: "admin@school.org", role: "admin" };
const SUPER = { email: "owner@school.org", role: "superadmin" };
const PBIS = { email: "pbis@school.org", role: "pbis" };
const M = load();
const call = async (staff, args, seed, mod = M) => {
  const d = makeDb(seed);
  const res = await mod.agg.byRace.handler({ db: d.db, staff }, args);
  return { res, reads: d.reads };
};
const J = (x) => JSON.stringify(x);

// ------------------------------------------------- today's code, verbatim
// The browser's list, as script.js built it before this change (old tabs
// still do): each referral's own number, else its student's on the roster.
const browserNumbers = (referrals, students = []) => {
  function referralStudentNumber(r) {
    if (r && r.studentNumber) return String(r.studentNumber);
    const s = (students || []).find(x => String(x.id) === String(r && r.studentId));
    return s && s.studentNumber ? String(s.studentNumber) : '';
  }
  return (referrals || []).map(referralStudentNumber).filter(Boolean);
};
/** byRace's handler body at 689f3fe, after the role gate, types stripped. */
function referenceByRace(restricted, roster, studentNumbers, staff) {
  const { reportedCategories, HISPANIC_LABEL } = M.rollup;
  const SMALL_GROUP = 10, MIN_REFERRALS_FOR_INDEX = 10;
  const distinct = new Set(studentNumbers.filter(Boolean));
  if (staff.role === "pbis" && distinct.size > 0 && distinct.size < SMALL_GROUP) {
    return { allowed: true, loaded: true, tooFew: true, reason: "(old)", rows: [] };
  }
  if (!restricted.length) return { allowed: true, loaded: false, reason: "(old)", rows: [] };
  const catsByNumber = new Map();
  const unmappedCodes = new Set();
  let unknownEthnicity = 0;
  for (const r of restricted) {
    const rep = reportedCategories(r);
    for (const c of rep.unmapped) unmappedCodes.add(c);
    if (rep.ethnicity === "unknown") unknownEthnicity += 1;
    if (rep.categories.length) catsByNumber.set(r.studentNumber, rep.categories);
  }
  const enrolledNumbers = new Set(roster.map((r) => r.studentNumber));
  const enrolledBy = {};
  for (const num of enrolledNumbers) for (const code of catsByNumber.get(num) ?? []) enrolledBy[code] = (enrolledBy[code] ?? 0) + 1;
  const referralsBy = {};
  let counted = 0, unmatched = 0;
  for (const num of studentNumbers) {
    const codes = catsByNumber.get(String(num ?? ""));
    if (!codes || !codes.length) { unmatched += 1; continue; }
    counted += 1;
    for (const code of codes) referralsBy[code] = (referralsBy[code] ?? 0) + 1;
  }
  let enrolTotal = 0;
  for (const k of Object.keys(enrolledBy)) enrolTotal += enrolledBy[k];
  let withheld = 0;
  const rows = Object.keys({ ...enrolledBy, ...referralsBy }).map((code) => {
    const enrolled = enrolledBy[code] ?? 0;
    const count = referralsBy[code] ?? 0;
    const suppressed = enrolled > 0 && enrolled < SMALL_GROUP;
    if (suppressed) withheld += 1;
    const tooFewReferrals = count < MIN_REFERRALS_FOR_INDEX;
    const shareOfReferrals = counted ? count / counted : 0;
    const shareOfEnrollment = enrolTotal ? enrolled / enrolTotal : 0;
    return {
      code, count: suppressed ? null : count, enrolled: suppressed ? null : enrolled,
      shareOfReferrals: suppressed ? null : shareOfReferrals, shareOfEnrollment: suppressed ? null : shareOfEnrollment,
      index: suppressed || tooFewReferrals || !shareOfEnrollment ? null : shareOfReferrals / shareOfEnrollment,
      suppressed, tooFewReferrals: suppressed ? false : tooFewReferrals,
    };
  }).sort((a, b) => (b.count ?? -1) - (a.count ?? -1));
  return {
    allowed: true, loaded: true, rows, counted, unmatched, groupsWithheld: withheld, unknownEthnicity,
    unmappedCodes: [...unmappedCodes],
    unmappedStudents: restricted.filter((r) => reportedCategories(r).unmapped.length > 0).length,
    smallGroupThreshold: SMALL_GROUP, minReferralsForIndex: MIN_REFERRALS_FOR_INDEX,
    hispanicLabel: HISPANIC_LABEL, viewedAs: { role: staff.role },
  };
}

/** An independent incident-day rule for the window checks. */
const laDayOf = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const realDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const incident = (p) => (realDate(p.date) ? p.date : laDayOf(p.submittedAt));

// ------------------------------------------------------------- the suite
// Behaviours as named predicates, so the teeth block can rerun them broken.
async function suite(mod) {
  const out = {};
  const pb = (args, refs = BASE) => call(PBIS, args, seedWith(refs), mod).then((x) => x.res);
  {
    // THE ATTACK.
    const target = NUMS.asian[0];
    const attack = await pb({ studentNumbers: [target, "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9"] });
    const plain = await pb({});
    out.attackDead = J(attack) === J(plain);
    const nine = BASE.slice(0, 9);
    const fewAttack = await pb({ studentNumbers: [target, ...Array.from({ length: 12 }, (_, i) => "y" + i)] }, nine);
    out.tooFewStaysTooFew = fewAttack.tooFew === true && fewAttack.rows.length === 0;
  }
  {
    // PBIS SUPPRESSION on the 40-student snapshot: Hispanic 24, Black 10, White 6.
    const r = await pb({});
    const byCode = Object.fromEntries(r.rows.map((x) => [x.code, x]));
    out.smallCellWithheld = byCode["White"]?.suppressed === true && byCode["White"].count === null;
    // A category with 12 enrolled and nobody referred. Where two small cells
    // already hold 11 students, nothing else would withhold it, so this is
    // the zero rule alone.
    const b = await pb({}, FORTY_B());
    const zero = b.rows.find((x) => x.code === "American Indian or Alaska Native");
    out.zeroCellWithheld = !!zero && zero.count === null && zero.countSuppressed === true
      && b.rows.find((x) => x.code === "Hispanic or Latino").count === 29;
    // Black has exactly ten students, but White (6) alone could be read off
    // the total, so Black is withheld with it.
    out.complementary = byCode["Black or African American"]?.count === null && byCode["Black or African American"].countSuppressed === true;
    out.bigCellShown = byCode["Hispanic or Latino"]?.count === 24 && byCode["Hispanic or Latino"].countSuppressed === false;
    const hidden = r.rows.filter((x) => x.countSuppressed);
    out.withheldLookAlike = hidden.every((x) => J(Object.keys(x)) === J(Object.keys(hidden[0]))
      && x.count === null && x.enrolled === null && x.index === null && x.suppressed === true && x.tooFewReferrals === false);
    out.withheldInNameOrder = J(hidden.map((x) => x.code)) === J(hidden.map((x) => x.code).slice().sort())
      && r.rows.findIndex((x) => x.countSuppressed) === r.rows.length - hidden.length;
    // No leak through `counted`: what the total minus the shown cells leaves
    // is spread over at least two withheld cells holding at least ten students.
    const shownSum = r.rows.filter((x) => !x.countSuppressed).reduce((a, x) => a + x.count, 0);
    out.noLeakThroughCounted = r.counted - shownSum === 16 && hidden.filter((x) => ["White", "Black or African American"].includes(x.code)).length === 2;
    out.groupsWithheldMatches = r.groupsWithheld === hidden.length;
    out.wholeYearOnly = r.windowApplied === false && J(await pb({ sinceIso: "2026-10-01" })) === J(r);
  }
  {
    // THE FROZEN SNAPSHOT.
    const before = await pb({});
    const plusOne = await pb({}, [...BASE, referral(NUMS.black[20])]);
    const plusRepeat = await pb({}, [...BASE, referral(NUMS.white[0])]);
    const backdated = await pb({}, [...BASE, referral(NUMS.asian[1], { date: "2026-08-01", submittedAt: "2026-08-01T16:00:00.000Z" })]);
    out.oneNewReferralMovesNothing = J(before) === J(plusOne) && J(before) === J(plusRepeat);
    out.backdatedWaits = J(before) === J(backdated);
    const tenMore = [...BASE, ...NUMS.black.slice(20, 30).map((n) => referral(n))];
    const after = await pb({}, tenMore);
    out.tenNewStudentsMoveIt = after.snapshotStudents === 50 && J(after) !== J(before) && before.snapshotStudents === 40;
  }
  {
    // ADMINS: today's answer, fed today's browser list.
    const payloads = BASE.map((r) => r.payload);
    const want = referenceByRace(RESTRICTED, ROSTER, browserNumbers(payloads), ADMIN);
    const got = (await call(ADMIN, {}, seedWith(BASE), mod)).res;
    out.adminIdentical = J(got) === J(want);
    const gotOldTab = (await call(ADMIN, { studentNumbers: ["1001"] }, seedWith(BASE), mod)).res;
    out.adminIgnoresSentList = J(gotOldTab) === J(want);
    const sup = (await call(SUPER, {}, seedWith(BASE), mod)).res;
    out.superIdentical = J(sup) === J({ ...want, viewedAs: { role: "superadmin" } });
    // Small cells stay visible to admins (approved for individual race).
    out.adminSeesSmallCells = got.rows.find((x) => x.code === "White").count === 6;
  }
  {
    // THE WINDOW: an incident on 9/30 filed on 10/2 is a 9/30 incident.
    const refs = [
      referral(NUMS.hisp[0], { date: "2026-09-30", submittedAt: "2026-10-02T16:00:00.000Z" }),
      referral(NUMS.hisp[1], { date: "2026-10-02", submittedAt: "2026-10-02T16:00:00.000Z" }),
      // No usable date: the LA day it was filed (22:30 on 9/30 in LA).
      referral(NUMS.black[0], { date: "", submittedAt: "2026-10-01T05:30:00.000Z" }),
      referral(NUMS.black[1], { date: "2026-02-30", submittedAt: "2026-10-03T16:00:00.000Z" }),
    ];
    const winFor = (since) => {
      const ps = refs.map((r) => r.payload).filter((p) => incident(p) >= since);
      return referenceByRace(RESTRICTED, ROSTER, browserNumbers(ps), ADMIN);
    };
    const oct1 = (await call(ADMIN, { sinceIso: "2026-10-01" }, seedWith(refs), mod)).res;
    out.windowByIncidentDay = J(oct1) === J(winFor("2026-10-01")) && oct1.counted === 2;
    const instant = (await call(ADMIN, { sinceIso: "2026-10-01T07:00:00.000Z" }, seedWith(refs), mod)).res;
    out.windowInstantIsLaDay = J(instant) === J(oct1);
    const sep30 = (await call(ADMIN, { sinceIso: "2026-09-30" }, seedWith(refs), mod)).res;
    out.windowInclusive = sep30.counted === 4;
  }
  return out;
}

console.log("\nThe shipped breakdown");
const S = await suite(M);
check("PBIS: sending [one child, 'x1'..'x9'] returns exactly what sending nothing returns", S.attackDead);
check("PBIS: under ten referred students stays 'too few', whatever list is sent", S.tooFewStaysTooFew);
check("PBIS: a cell of 6 referred students is withheld", S.smallCellWithheld);
check("PBIS: a cell of ZERO referred students is withheld too (so a 0 cannot vouch for its neighbour)", S.zeroCellWithheld);
check("PBIS: complementary suppression withholds the next-smallest cell (Black, 10) beside White (6)", S.complementary);
check("PBIS: a cell of 24 is shown", S.bigCellShown);
check("PBIS: every withheld row is identical in shape and values", S.withheldLookAlike);
check("PBIS: withheld rows come last, in name order (position says nothing about size)", S.withheldInNameOrder);
check("PBIS: the total minus the shown cells is spread over two withheld cells, 16 students", S.noLeakThroughCounted);
check("PBIS: groupsWithheld counts the withheld rows", S.groupsWithheldMatches);
check("PBIS: whole year only; sinceIso is ignored and windowApplied is false", S.wholeYearOnly);
check("PBIS: one new referral between two calls changes no figure (new student or repeat)", S.oneNewReferralMovesNothing);
check("PBIS: a referral backdated into the year waits for the next snapshot", S.backdatedWaits);
check("PBIS: ten new students move the snapshot (40 -> 50)", S.tenNewStudentsMoveIt);
check("ADMIN CONTROL: the server-derived breakdown deep-equals today's code fed today's browser list", S.adminIdentical);
check("ADMIN: a list an old tab still sends is ignored", S.adminIgnoresSentList);
check("SUPERADMIN: the same", S.superIdentical);
check("ADMIN: small cells stay visible (approved 2026-08-19)", S.adminSeesSmallCells);
check("ADMIN: sinceIso counts by the INCIDENT day (9/30 incident filed 10/2 is out of 'since 10/1')", S.windowByIncidentDay);
check("ADMIN: a sinceIso instant is read as its Los Angeles day", S.windowInstantIsLaDay);
check("ADMIN: the window includes its first day", S.windowInclusive);

console.log("\nWho may call it, and what it accepts");
{
  const A = M.agg.byRace.args;
  check("old tabs' { studentNumbers: [...] } still validates (the argument is optional, not removed)",
    A.studentNumbers && A.studentNumbers.isOptional === "optional" && A.studentNumbers.kind === "array");
  check("{} validates too", A.sinceIso.isOptional === "optional" && J(Object.keys(A).sort()) === J(["sinceIso", "studentNumbers"]));
  for (const role of ["teacher", "campusaide"]) {
    const { res, reads } = await call({ email: role + "@school.org", role }, { studentNumbers: ["1001"] }, seedWith(BASE));
    check(`${role}: allowed false, and not one table read`, res.allowed === false && res.rows.length === 0 && reads.length === 0);
  }
  const { res: noRace } = await call(ADMIN, {}, seedWith(BASE, { psRestricted: [] }));
  check("an unloaded psRestricted still says so (loaded: false)", noRace.allowed === true && noRace.loaded === false);
  const { res: earlyPbis, reads } = await call(PBIS, {}, seedWith(BASE.slice(0, 5), { psRestricted: [] }));
  check("PBIS under ten students is told 'too few' before race data is even read",
    earlyPbis.tooFew === true && !reads.includes("psRestricted"));
}

console.log("\nThe pure helpers");
{
  const A = M.agg;
  check("isoDay accepts a real date and refuses 2026-02-30 and junk",
    A.isoDay("2026-10-05") === "2026-10-05" && A.isoDay("2026-02-30") === null && A.isoDay("10/05/2026") === null && A.isoDay(5) === null);
  check("laDay: 05:30 UTC on 10/8 is still 10/7 in Los Angeles", A.laDay("2026-10-08T05:30:00.000Z") === "2026-10-07");
  check("incidentDay prefers the entered date over the filing time",
    A.incidentDay({ date: "2026-09-30", submittedAt: "2026-10-02T16:00:00Z" }) === "2026-09-30"
    && A.incidentDay({ submittedAt: "2026-10-01T05:30:00Z" }) === "2026-09-30" && A.incidentDay(null) === null);
  check("pbisSnapshot is null under ten students", A.pbisSnapshot(BASE.slice(0, 9)) === null);
  check("pbisSnapshot orders by the server's creation time, not the order given",
    A.pbisSnapshot(BASE.slice().reverse()).students === 40);
}

console.log("\nThe production comparison (CLI) returns counts and booleans only");
{
  const d = makeDb(seedWith(BASE, { students: [] }));
  const c = await M.agg.compareByRace.handler({ db: d.db }, {});
  check("on rows that all carry a number, the lists and the results are identical",
    c.listsIdentical === true && c.resultsIdentical === true && c.withoutNumber === 0 && c.referrals === 40);
  check("...and it reports the PBIS snapshot and cells", c.pbisSnapshotStudents === 40 && c.pbisCellsShown === 1 && c.pbisCellsWithheld >= 2);
  const strings = []; const walk = (x) => { if (typeof x === "string") strings.push(x); else if (x && typeof x === "object") Object.values(x).forEach(walk); };
  walk(c);
  check("...and not one string", strings.length === 0, strings.join(","));
  const blank = [...BASE, referral("", { studentId: "L1" })];
  const d2 = makeDb(seedWith(blank, { students: [{ legacyId: "L1", studentNumber: NUMS.hisp[100] }] }));
  const c2 = await M.agg.compareByRace.handler({ db: d2.db }, {});
  check("a referral with no number is counted, and shows the lists would differ", c2.withoutNumber === 1 && c2.resolvedByLookup === 1 && c2.listsIdentical === false);
}

console.log("\nThe source");
{
  const src = SRC.disciplineAggregates;
  check("the stale 'referrals are still in Firestore' justification is gone", !/still in Firestore/.test(src));
  const handler = src.slice(src.indexOf("export const byRace"), src.indexOf("export const compareByRace"));
  check("byRace's handler does not read the studentNumbers it is sent", /handler: async \(ctx, \{ sinceIso \}\) =>/.test(handler));
  check("raceVerification is untouched: still requireAdmin", /export const raceVerification[\s\S]*?requireAdmin\(ctx\)/.test(src));
}

console.log("\nTEETH: each rule, broken, fails a check above");
{
  const breaks = [
    ["the browser's list trusted again", [["handler: async (ctx, { sinceIso }) => {", "handler: async (ctx, { sinceIso, studentNumbers: sent }) => {"],
      ["studentNumbers = numbersSince(snap.rows).numbers;", "studentNumbers = sent ?? numbersSince(snap.rows).numbers;"]], "attackDead"],
    ["no PBIS cell suppression", [["({ rows, withheld } = suppressSmallCells(rows, studentsBy));", ";"]], "smallCellWithheld"],
    ["zero cells shown", [["r.suppressed || size(r.code) < SMALL_GROUP", "r.suppressed || (size(r.code) > 0 && size(r.code) < SMALL_GROUP)"]], "zeroCellWithheld"],
    ["no complementary suppression", [["if (withheld.size >= 2 && studentsIn() >= SMALL_GROUP) break;", "break;"]], "complementary"],
    ["withheld rows left in size order", [["return { rows: [...shownRows, ...hiddenRows], withheld: hiddenRows.length };",
      "return { rows: rows.map((r) => (withheld.has(r.code) ? hiddenRows.find((h) => h.code === r.code) : { ...r, countSuppressed: false })), withheld: hiddenRows.length };"]], "withheldInNameOrder"],
    ["a live picture instead of a snapshot", [["return { rows: ordered.filter((r) => r._creationTime <= at), students };", "return { rows: ordered, students };"]], "oneNewReferralMovesNothing"],
    ["the window keyed on the filing time", [["return isoDay(p.date) ?? laDay(p.submittedAt);", "return laDay(p.submittedAt);"]], "windowByIncidentDay"],
    ["PBIS given the chosen window", [["studentNumbers = numbersSince(snap.rows).numbers;", "studentNumbers = numbersSince(snap.rows, sinceIso).numbers;"]], "wholeYearOnly"],
  ];
  for (const [what, edits, key] of breaks) {
    const missing = edits.find(([from]) => !SRC.disciplineAggregates.includes(from));
    if (missing) { check(`TEETH (${what}): the break applied`, false, "pattern not found: " + missing[0]); continue; }
    const B = load({ disciplineAggregates: (s) => edits.reduce((acc, [from, to]) => acc.replace(from, to), s) });
    const b = await suite(B).catch((e) => ({ error: e.message }));
    check(`TEETH: ${what} -> "${key}" fails`, b[key] === false, b.error);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
