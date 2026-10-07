// Who may see and who may close a discipline referral: the server's rules.
// Run: npm test (node --experimental-strip-types)
//
// WHY THESE EXIST (2026-10-07). "A teacher sees only their own referrals" was
// enforced only in the browser. The server handed every staff member the whole
// school's referrals and accepted any staff member's copy of any referral, so
// a teacher could read every child's discipline record from the console, close
// a colleague's referral, or claim one. convex/referralAccessRules.ts is the
// pure half of the fix; legacyData.ts wires it in behind two switches.
//
// The module is imported directly under strip-types, which is itself one of
// the checks: it must import nothing, or this file would not even load.
//
// The last block re-breaks the shipped rules one at a time and proves a check
// here fails each time (TEETH).
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as Shipped from "./convex/referralAccessRules.ts";
import { normalizeEmail as identityNormalizeEmail } from "./convex/identityRules.ts";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const rulesSrc = read("./convex/referralAccessRules.ts");
const legacySrc = read("./convex/legacyData.ts");
const script = read("./script.js");
const disc = read("./wildcat-discipline.js");
new Function(disc)();
const WD = globalThis.WildcatDiscipline;

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

/** Load a (possibly re-broken) copy of the rules. They import nothing, so no shim. */
function loadRules(src) {
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const m = { exports: {} };
  new Function("module", "exports", "require", js)(m, m.exports, (p) => { throw new Error("unexpected import " + p); });
  return m.exports;
}

// legacyData.ts's own touchedAt, lifted and transpiled, so the copy in the
// rules module is compared with the SHIPPED one rather than with a third copy.
const touchedAtSrc = (() => {
  const a = legacySrc.indexOf("function touchedAt(");
  return legacySrc.slice(a, legacySrc.indexOf("\n}\n", a) + 3);
})();
const legacyTouchedAt = new Function(ts.transpileModule(touchedAtSrc, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText + "\nreturn touchedAt;")();

// ---------------------------------------------------------------- fixtures
// Synthetic people and children only. No real names.
const T1 = { email: "teacher.one@school.org", name: "Teacher One", role: "teacher" };
const T2 = { email: "teacher.two@school.org", name: "Teacher Two", role: "teacher" };
const AIDE = { email: "aide@school.org", name: "An Aide", role: "campusaide" };
const PBIS = { email: "pbis@school.org", name: "Pbis Lead", role: "pbis" };
const ADMIN = { email: "admin@school.org", name: "An Admin", role: "admin" };
const SUPER = { email: "owner@school.org", name: "The Owner", role: "superadmin" };
const MIDDLE = { ...T1, gradeScope: "middle" };
const WATCH = { ...AIDE, attendanceWatch: true };
const STUDENT_LIKE = { email: "kid@students.org" };   // no role at all

const NOW = Date.parse("2026-10-07T17:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const base = (id, extra) => ({
  id, studentName: "Student " + id, studentNumber: "9000" + id.slice(-1), description: "d",
  status: "open", resolutionType: "", closingActions: [], adminNotes: "", closedBy: "", closedAt: "",
  loopClosed: false, loopClosedBy: "", loopClosedAt: "", forwardedTo: [],
  submittedAt: iso(NOW - 3 * 86400e3), updatedAt: iso(NOW - 3 * 86400e3), ...extra,
});
const R_T1 = base("R1", { filedByEmail: T1.email, referredByEmail: T1.email, referredBy: T1.name });
const R_NAME_ONLY = base("R2", { referredBy: T1.name });   // the browser counts it as T1's; the server must not
const R_T2 = base("R3", { filedByEmail: T2.email, referredByEmail: T2.email, referredBy: T2.name });
const R_CASE = base("R6", { filedByEmail: "  Teacher.One@School.ORG ", referredByEmail: "" });
const rowsFor = () => [
  { collection: "behaviorReferrals", payload: R_T1 },
  { collection: "behaviorReferrals", payload: R_NAME_ONLY },
  { collection: "behaviorReferrals", payload: R_T2 },
  { collection: "behaviorReferrals", payload: R_CASE },
  { collection: "behaviorReferrals", key: "k1", payload: base("R4", { filedByEmail: T1.email }) },
  { collection: "otherThing", payload: base("R5", { filedByEmail: T1.email }) },
];
const ids = (rows) => rows.map((r) => r.payload.id).join(",");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --------------------------------------------------------------- the suite
// Every behavioural check is a named predicate over a rules module, so the
// teeth block below can run the same suite against a re-broken copy.
function suite(R) {
  const out = [];
  const t = (name, fn) => { let ok = false, why = ""; try { ok = !!fn(); } catch (e) { why = e.message; } out.push({ name, ok, why }); };

  // ---- roles
  t("roles: teacher and campus aide see only their own, and cannot close",
    () => ["teacher", "campusaide"].every((r) => !R.seesAllReferrals(r) && !R.canCloseReferrals(r)));
  t("roles: admin, superadmin and PBIS see everything and can close",
    () => ["admin", "superadmin", "pbis"].every((r) => R.seesAllReferrals(r) && R.canCloseReferrals(r)));
  t("roles: case and whitespace are ignored", () => R.seesAllReferrals(" Admin ") && R.canCloseReferrals("PBIS"));
  t("roles: no role, a made-up role, or a non-string sees nothing extra",
    () => [undefined, null, "", "student", "teacherx", 7, {}].every((r) => !R.seesAllReferrals(r) && !R.canCloseReferrals(r)));

  // ---- ownership
  t("owner: a row filed under the viewer's email is theirs", () => R.ownsReferral(R_T1, T1.email));
  t("owner: email case and surrounding spaces are ignored", () => R.ownsReferral(R_CASE, "TEACHER.ONE@school.org "));
  t("owner: a NAME-ONLY row is NOT owned (the browser's rule matches it; the server must not)",
    () => !R.ownsReferral(R_NAME_ONLY, T1.email) && WD.ownsReferral(R_NAME_ONLY, T1));
  t("owner: someone else's row is not theirs", () => !R.ownsReferral(R_T2, T1.email));
  t("owner: an empty email owns nothing, not even a row with an empty email",
    () => !R.ownsReferral(R_T1, "") && !R.ownsReferral({ filedByEmail: "", referredByEmail: "" }, "") && !R.ownsReferral(R_T1, null));
  t("owner: referredByEmail alone is enough", () => R.ownsReferral({ referredByEmail: T2.email }, T2.email));
  t("owner: a payload that is not an object is nobody's", () => !R.ownsReferral("R1", T1.email) && !R.ownsReferral(null, T1.email));

  // ---- scoping
  t("scope: a teacher gets their own rows, including the differently-cased one",
    () => ids(R.scopeReferralRows(rowsFor(), T1)) === "R1,R6");
  t("scope: another teacher gets only theirs", () => ids(R.scopeReferralRows(rowsFor(), T2)) === "R3");
  t("scope: a campus aide with no referrals gets an empty list", () => R.scopeReferralRows(rowsFor(), AIDE).length === 0);
  t("scope: a gradeScope teacher is still own-only", () => ids(R.scopeReferralRows(rowsFor(), MIDDLE)) === "R1,R6");
  t("scope: an Attendance Watch grant is still own-only", () => R.scopeReferralRows(rowsFor(), WATCH).length === 0);
  t("scope: a student-shaped viewer (no role) gets nothing", () => R.scopeReferralRows(rowsFor(), STUDENT_LIKE).length === 0);
  t("scope: a viewer with no email gets nothing, never everything", () => R.scopeReferralRows(rowsFor(), { role: "teacher" }).length === 0);
  t("scope: admin, superadmin and PBIS get every unkeyed behaviorReferrals row",
    () => [ADMIN, SUPER, PBIS].every((v) => ids(R.scopeReferralRows(rowsFor(), v)) === "R1,R2,R3,R6"));
  t("scope: a keyed row is never served, to anyone", () =>
    [T1, ADMIN].every((v) => !R.scopeReferralRows(rowsFor(), v).some((r) => r.payload.id === "R4")));
  t("scope: another collection in the doc is never served", () =>
    [T1, ADMIN].every((v) => !R.scopeReferralRows(rowsFor(), v).some((r) => r.payload.id === "R5")));

  // ---- the owner pin (always on)
  t("pin: a copy naming a different filer keeps the stored filer", () => {
    const p = R.pinOwnerFields(R_T1, { ...R_T1, filedByEmail: T2.email, referredByEmail: T2.email, description: "x" });
    return p.filedByEmail === T1.email && p.referredByEmail === T1.email && p.description === "x";
  });
  t("pin: id and submittedAt are kept too", () => {
    const p = R.pinOwnerFields(R_T1, { ...R_T1, id: "R9", submittedAt: iso(NOW) });
    return p.id === "R1" && p.submittedAt === R_T1.submittedAt;
  });
  t("pin: an owner field the stored row lacks is removed, not taken from the copy", () => {
    const p = R.pinOwnerFields(R_NAME_ONLY, { ...R_NAME_ONLY, filedByEmail: T2.email });
    return !("filedByEmail" in p) && p.referredBy === T1.name;
  });
  t("pin: non-objects pass straight through", () => R.pinOwnerFields("a", "b") === "b" && R.pinOwnerFields(null, R_T1) === R_T1);
  // Which child a referral is about is written once, for EVERY caller (review,
  // 2026-10-07): PBIS is never guarded, and re-pointing a stored referral at a
  // chosen child moved that child in and out of PBIS's race picture.
  t("pin: which child a referral is about is kept (studentNumber, studentId, studentName)", () => {
    const p = R.pinOwnerFields({ ...R_T1, studentId: "S1" },
      { ...R_T1, studentId: "S2", studentNumber: "1234", studentName: "Someone Else", description: "x" });
    return p.studentId === "S1" && p.studentNumber === R_T1.studentNumber && p.studentName === R_T1.studentName
      && p.description === "x";
  });
  t("pin: a student field the stored row lacks is removed, not taken from the copy", () => {
    const { studentNumber, ...noNumber } = R_T1;
    return !("studentNumber" in R.pinOwnerFields(noNumber, { ...noNumber, studentNumber: "1234" }));
  });

  // ---- updates, guard ON for a non-closer
  const G = { guard: true, nowMs: NOW };
  const later = iso(NOW - 60e3);
  t("update: a teacher closing their OWN referral keeps every close field (keptCloseFields)", () => {
    const p = R.planReferralUpdate(R_T1, { ...R_T1, status: "closed", closedAt: later, closedBy: T1.name,
      adminNotes: "mine", resolutionType: "action_taken", closingActions: ["x"], consequence: "x",
      loopClosed: true, loopClosedAt: later, forwardedTo: ["y"], updatedAt: later }, T1, G);
    return p.write === false && p.reason === "keptCloseFields";
  });
  t("update: a teacher's own edit (description) lands, close fields untouched", () => {
    const p = R.planReferralUpdate(R_T1, { ...R_T1, description: "better", status: "closed", adminNotes: "n", updatedAt: later }, T1, G);
    return p.write === true && p.payload.description === "better" && p.payload.status === "open"
      && p.payload.adminNotes === "" && p.payload.updatedAt === later && p.keptCloseFields === true;
  });
  t("update: a plain own edit is not counted as a close attempt", () => {
    const p = R.planReferralUpdate(R_T1, { ...R_T1, description: "better", updatedAt: later }, T1, G);
    return p.write === true && p.keptCloseFields === false;
  });
  t("update: a teacher editing someone else's referral is notYours", () => {
    const p = R.planReferralUpdate(R_T2, { ...R_T2, description: "mine now", updatedAt: later }, T1, G);
    return p.write === false && p.reason === "notYours";
  });
  t("update: a name-only row is notYours on the server", () =>
    R.planReferralUpdate(R_NAME_ONLY, { ...R_NAME_ONLY, description: "x", updatedAt: later }, T1, G).reason === "notYours");
  t("update: claiming filedByEmail on your own row is pinned while the real edit lands", () => {
    const p = R.planReferralUpdate(R_T1, { ...R_T1, filedByEmail: T2.email, referredByEmail: T2.email,
      submittedAt: later, id: "R99", description: "edit", updatedAt: later }, T1, G);
    return p.write === true && p.payload.filedByEmail === T1.email && p.payload.referredByEmail === T1.email
      && p.payload.submittedAt === R_T1.submittedAt && p.payload.id === "R1" && p.payload.description === "edit";
  });
  t("update: a teacher's own edit cannot re-point the referral at another child", () => {
    const p = R.planReferralUpdate(R_T1, { ...R_T1, studentNumber: "1234", studentName: "Someone Else",
      description: "edit", updatedAt: later }, T1, G);
    return p.write === true && p.payload.studentNumber === R_T1.studentNumber
      && p.payload.studentName === R_T1.studentName && p.payload.description === "edit";
  });
  t("update: a 9999 updatedAt is clamped to the server's clock", () => {
    const p = R.planReferralUpdate(R_T1, { ...R_T1, description: "edit", updatedAt: "9999-01-01T00:00:00.000Z" }, T1, G);
    return p.write === true && p.payload.updatedAt === iso(NOW) && p.clamped === 1;
  });
  t("update: a stamp a few minutes fast (within the slack) is believed", () => {
    const p = R.planReferralUpdate(R_T1, { ...R_T1, description: "edit", updatedAt: iso(NOW + 2 * 60e3) }, T1, G);
    return p.write === true && p.payload.updatedAt === iso(NOW + 2 * 60e3) && p.clamped === 0;
  });
  t("update: a far-future stamp with no other change is noChange once clamped", () => {
    const p = R.planReferralUpdate(R_T1, { ...R_T1, updatedAt: "9999-01-01T00:00:00.000Z" }, T1, G);
    return p.write === false && p.reason === "noChange" && p.clamped === 1;
  });
  t("update: re-sending the unchanged row with a newer stamp is noChange", () =>
    R.planReferralUpdate(R_T1, { ...R_T1, updatedAt: later }, T1, G).reason === "noChange");
  t("update: re-sending the identical row is stale, not a close attempt", () =>
    R.planReferralUpdate(R_T1, { ...R_T1 }, T1, G).reason === "stale");
  t("update: an old open copy of a referral an admin has since closed is STALE, not keptCloseFields", () => {
    const closed = { ...R_T1, status: "closed", closedAt: later, closedBy: ADMIN.name, adminNotes: "done", updatedAt: later };
    const p = R.planReferralUpdate(closed, { ...R_T1 }, T1, G);
    return p.write === false && p.reason === "stale";
  });

  // ---- closers, and everyone while the guard is off
  const OFF = { guard: false, nowMs: NOW };
  t("closers: an admin's close lands (legacyData passes guard=false for closers)", () => {
    const p = R.planReferralUpdate(R_T1, { ...R_T1, status: "closed", closedAt: later, adminNotes: "a", updatedAt: later }, ADMIN, OFF);
    return p.write === true && p.payload.status === "closed" && p.payload.adminNotes === "a";
  });
  t("closers: a PBIS close lands, on anyone's referral", () => {
    const p = R.planReferralUpdate(R_T2, { ...R_T2, status: "closed", closedAt: later, updatedAt: later }, PBIS, OFF);
    return p.write === true && p.payload.status === "closed";
  });
  t("closers: an admin cannot rewrite who filed it either", () =>
    R.planReferralUpdate(R_T1, { ...R_T1, filedByEmail: ADMIN.email, updatedAt: later }, ADMIN, OFF).payload.filedByEmail === T1.email);

  // ---- inserts, guard ON
  t("insert: a teacher insert claiming status 'closed' is filed open, every close field reset", () => {
    const p = R.planReferralInsert({ ...base("N1", { filedByEmail: T1.email, referredByEmail: T1.email }),
      status: "closed", closedAt: later, closedBy: T1.name, adminNotes: "n", loopClosed: true,
      closingActions: ["x"], consequence: "x", detentionDays: 2, forwardedTo: ["y"] }, T1, G);
    const d = R.filingDefaults();
    return p.write === true && p.keptCloseFields === true
      && Object.keys(d).every((k) => same(p.payload[k], d[k]))
      && !("consequence" in p.payload) && !("detentionDays" in p.payload);
  });
  t("insert: someone else's filedByEmail is refused (an old tab re-filing a deleted colleague's referral)", () => {
    const p = R.planReferralInsert(base("N2", { filedByEmail: T2.email, referredByEmail: T2.email }), T1, G);
    return p.write === false && p.reason === "notYours";
  });
  t("insert: someone else's referredByEmail alone is refused too", () =>
    R.planReferralInsert(base("N3", { filedByEmail: T1.email, referredByEmail: T2.email }), T1, G).write === false);
  t("insert: a genuine filing is stamped with the caller's email and otherwise kept", () => {
    const p = R.planReferralInsert(base("N4", { filedByEmail: "Teacher.One@School.org", referredByEmail: "" }), T1, G);
    return p.write === true && p.payload.filedByEmail === T1.email && p.payload.referredByEmail === T1.email
      && p.payload.description === "d" && p.keptCloseFields === false;
  });
  t("insert: a copy carrying no email at all (a deleted pre-email referral) is refused, not re-filed as mine", () => {
    const p = R.planReferralInsert(base("N7", { referredBy: T2.name }), T1, G);
    return p.write === false && p.reason === "notYours";
  });
  t("insert: a future submittedAt is clamped", () => {
    const p = R.planReferralInsert(base("N5", { filedByEmail: T1.email, submittedAt: "9999-01-01T00:00:00.000Z" }), T1, G);
    return p.write === true && p.payload.submittedAt === iso(NOW) && p.clamped === 1;
  });
  t("insert: guard off files the row exactly as sent", () => {
    const row = base("N6", { filedByEmail: T2.email, status: "closed" });
    const p = R.planReferralInsert(row, T1, OFF);
    return p.write === true && p.payload === row;
  });

  // ---- switches
  t("switch: a missing row is OFF", () => !R.normalizeSwitch(undefined).enabled && !R.switchAllows(R.normalizeSwitch(null), T1.email));
  t("switch: only a real true turns it on", () =>
    [{ enabled: "true" }, { enabled: 1 }, { enabled: {} }, "on", true].every((v) => !R.normalizeSwitch(v).enabled)
    && R.normalizeSwitch({ enabled: true }).enabled);
  t("switch: on with no pilot list means everyone", () => R.switchAllows(R.normalizeSwitch({ enabled: true }), T2.email));
  t("switch: a pilot list names people, case-insensitively", () => {
    const sw = R.normalizeSwitch({ enabled: true, pilotEmails: [" Teacher.One@School.org ", 7, null, ""] });
    return sw.pilotEmails.length === 1 && R.switchAllows(sw, T1.email) && !R.switchAllows(sw, T2.email) && !R.switchAllows(sw, "");
  });
  t("switch: a pilotEmails that is not a list reads as OFF, never as everyone", () =>
    !R.normalizeSwitch({ enabled: true, pilotEmails: T1.email }).enabled);
  // A pilot list that NAMED people but holds no usable email (an unset shell
  // variable in the pilot command gives [""]) is not "everyone" (review,
  // 2026-10-07).
  t("switch: a pilot list of blanks or non-emails reads as OFF, never as everyone", () =>
    [[""], ["   "], [7, null], ["", " "]].every((pilotEmails) => {
      const sw = R.normalizeSwitch({ enabled: true, pilotEmails });
      return sw.enabled === false && !R.switchAllows(sw, T1.email);
    }));
  t("switch: an EMPTY list is still everyone (how the switch is opened to the school)", () =>
    R.switchAllows(R.normalizeSwitch({ enabled: true, pilotEmails: [] }), T2.email));
  t("switch: off with a pilot list is still off", () => !R.switchAllows(R.normalizeSwitch({ enabled: false, pilotEmails: [T1.email] }), T1.email));
  t("switch: a null switch allows nobody", () => !R.switchAllows(null, T1.email) && !R.switchAllows(undefined, T1.email));
  return out;
}

function report(results) { for (const r of results) check(r.name, r.ok, r.why); }

console.log("\nThe shipped rules");
report(suite(Shipped));

console.log("\nIt imports nothing (strip-types cannot resolve an import)");
check("no import or require in referralAccessRules.ts",
  !/^\s*import\s/m.test(rulesSrc) && !/\brequire\(/.test(rulesSrc));

console.log("\nCopies that must stay identical to their originals");
{
  const inputs = [" A@B.org ", "x", "", null, undefined, "MiXeD@Case.ORG\t", "\n teacher.one@school.org"];
  check("normalizeEmail matches identityRules.ts on every input",
    inputs.every((e) => Shipped.normalizeEmail(e) === identityNormalizeEmail(e)));
  const stamps = [
    {}, null, "x", { updatedAt: "2026-10-01T00:00:00Z" }, { submittedAt: 5, closedAt: "nope" },
    { updatedAt: "2026-10-01T00:00:00Z", loopClosedAt: "2026-10-03T00:00:00Z", closedAt: "2026-10-02T00:00:00Z" },
    { updatedAt: "9999-01-01T00:00:00Z" }, { closedAt: "" },
  ];
  check("referralTouchedAt matches legacyData.ts touchedAt on every row",
    stamps.every((p) => Shipped.referralTouchedAt(p) === legacyTouchedAt(p)));
  check("REFERRAL_ALL_ROLES equals wildcat-discipline.js DISCIPLINE_ALL_ROLES",
    same([...Shipped.REFERRAL_ALL_ROLES], [...WD.DISCIPLINE_ALL_ROLES]));
  check("the closers are the same three today", same([...Shipped.REFERRAL_CLOSE_ROLES], ["admin", "superadmin", "pbis"]));
  const viewers = [T1, T2, ADMIN, { name: "Teacher One" }, { username: "tone" }, {}];
  const payloads = [R_T1, R_NAME_ONLY, R_T2, R_CASE, { filedByUsername: "tone" }, {}];
  check("browserRuleOwns is today's browser rule (wildcat-discipline.js ownsReferral)",
    viewers.every((v) => payloads.every((p) => Shipped.browserRuleOwns(p, v) === WD.ownsReferral(p, v))));
}

console.log("\nGuard off is today's newer-wins merge exactly");
{
  // The reference: what legacyData's collision branch did before this
  // change, with the shipped touchedAt. Only the owner pin may differ.
  const today = (s, i) => (legacyTouchedAt(i) > legacyTouchedAt(s) ? { write: true, payload: { ...s, ...i } } : { write: false });
  const t1 = "2026-09-08T10:00:00.000Z", t2 = "2026-09-08T11:00:00.000Z";
  const cases = [
    [{ id: "R1", status: "open", updatedAt: t1 }, { id: "R1", status: "closed", updatedAt: t2 }],
    [{ id: "R1", status: "closed", updatedAt: t2 }, { id: "R1", status: "open", updatedAt: t1 }],
    [{ id: "R1", status: "closed", updatedAt: t1 }, { id: "R1", status: "open", updatedAt: t1 }],
    [{ id: "R1", status: "closed" }, { id: "R1", status: "open" }],
    [{ id: "R1", status: "open", submittedAt: t1 }, { id: "R1", status: "closed", submittedAt: t1, loopClosedAt: t2 }],
    [{ id: "R1", keep: 1, updatedAt: t1 }, { id: "R1", updatedAt: t2 }],
    [R_T1, { ...R_T1, status: "closed", closedAt: t2, updatedAt: "2026-10-06T00:00:00.000Z" }],
  ];
  check("every pre-existing collision case decides and merges as before", cases.every(([s, i]) => {
    const want = today(s, i);
    const got = Shipped.planReferralUpdate(s, i, T1, { guard: false, nowMs: NOW });
    return got.write === want.write && (!want.write || same(got.payload, want.payload));
  }));
}

console.log("\nEvery field a close writes is a close field");
{
  // A FUTURE CLOSE FIELD MUST NOT SLIP PAST THE GUARD. If confirmCloseReferral
  // or confirmCloseLoop starts writing a field CLOSE_FIELDS does not list, a
  // teacher's old tab could set it on their own referral under the guard.
  const fnBody = (name) => {
    const a = script.indexOf(`async function ${name}(`);
    if (a < 0) return "";
    return script.slice(a, script.indexOf("\n        }\n", a));
  };
  const written = new Set();
  for (const name of ["confirmCloseReferral", "confirmCloseLoop"]) {
    for (const m of fnBody(name).matchAll(/\br\.(\w+)\s*=(?!=)/g)) written.add(m[1]);
  }
  const allowed = new Set([...Shipped.CLOSE_FIELDS, "updatedAt"]);
  const stray = [...written].filter((f) => !allowed.has(f));
  check("the two close functions were found and write fields (not a vacuous pass)", written.size >= 10, [...written].join(","));
  check("each field they write is in CLOSE_FIELDS (or is updatedAt)", stray.length === 0, stray.join(","));
  check("and status, adminNotes and loopClosed are among them", ["status", "adminNotes", "loopClosed"].every((f) => written.has(f)));
}

console.log("\nTEETH: each rule, broken once, fails a check above");
{
  const breaks = [
    ["campus aides widened to see everything", 'export const REFERRAL_ALL_ROLES: readonly string[] = ["admin", "superadmin", "pbis"];',
      'export const REFERRAL_ALL_ROLES: readonly string[] = ["admin", "superadmin", "pbis", "campusaide"];',
      "roles: teacher and campus aide see only their own, and cannot close"],
    ["ownership compared raw, without normalising", "return emailOf(payload.filedByEmail) === me || emailOf(payload.referredByEmail) === me;",
      "return payload.filedByEmail === email || payload.referredByEmail === email;",
      "owner: email case and surrounding spaces are ignored"],
    ["keyed rows served", 'r.collection === "behaviorReferrals" && typeof r.key !== "string"', 'r.collection === "behaviorReferrals"',
      "scope: a keyed row is never served, to anyone"],
    ["other collections served", 'r.collection === "behaviorReferrals" && typeof r.key !== "string"', 'typeof r.key !== "string"',
      "scope: another collection in the doc is never served"],
    ["the owner pin removed", "if (hasOwn(stored, k)) out[k] = stored[k];\n    else delete out[k];", "",
      "pin: a copy naming a different filer keeps the stored filer"],
    ["no clamp", "export const FUTURE_SLACK_MS = 5 * 60 * 1000;", "export const FUTURE_SLACK_MS = 1e15;",
      "update: a 9999 updatedAt is clamped to the server's clock"],
    ["close fields accepted from a teacher", "for (const k of CLOSE_FIELDS) delete editable[k];", "",
      "update: a teacher closing their OWN referral keeps every close field (keptCloseFields)"],
    ["any teacher may edit any referral", 'if (!ownsReferral(stored, viewer.email)) return { write: false, reason: "notYours", clamped: 0 };', "",
      "update: a teacher editing someone else's referral is notYours"],
    ["a stale copy counted as a close attempt", 'return { write: false, reason: "stale", clamped };', "",
      "update: an old open copy of a referral an admin has since closed is STALE, not keptCloseFields"],
    ["an insert keeps its close fields", "const filing: Record<string, unknown> = { ...incoming, ...defaults, filedByEmail: me, referredByEmail: me };",
      "const filing: Record<string, unknown> = { ...incoming, filedByEmail: me, referredByEmail: me };",
      "insert: a teacher insert claiming status 'closed' is filed open, every close field reset"],
    ["a colleague's referral re-filed under my name", "if ((filed && filed !== me) || (referred && referred !== me) || (filed !== me && referred !== me)) {", "if (false) {",
      "insert: someone else's filedByEmail is refused (an old tab re-filing a deleted colleague's referral)"],
    ["an email-less referral re-filed under my name", " || (filed !== me && referred !== me)) {", ") {",
      "insert: a copy carrying no email at all (a deleted pre-email referral) is refused, not re-filed as mine"],
    ["a truthy enabled turns the switch on", "enabled: value.enabled === true", "enabled: !!value.enabled",
      "switch: only a real true turns it on"],
    ["the student fields not pinned", "export const WRITE_ONCE_FIELDS: readonly string[] = [...OWNER_FIELDS, ...SUBJECT_FIELDS];",
      "export const WRITE_ONCE_FIELDS: readonly string[] = [...OWNER_FIELDS];",
      "pin: which child a referral is about is kept (studentNumber, studentId, studentName)"],
    ["the student fields editable under the guard", "for (const k of WRITE_ONCE_FIELDS) delete editable[k];",
      "for (const k of OWNER_FIELDS) delete editable[k];",
      "update: a teacher's own edit cannot re-point the referral at another child"],
    ["a pilot list of blanks reads as everyone",
      "  if (Array.isArray(raw) && raw.length > 0 && pilotEmails.length === 0) return { enabled: false, pilotEmails: [] };\n", "",
      "switch: a pilot list of blanks or non-emails reads as OFF, never as everyone"],
    ["a malformed pilot list reads as everyone", "if (raw !== undefined && raw !== null && !Array.isArray(raw)) return { enabled: false, pilotEmails: [] };", "",
      "switch: a pilotEmails that is not a list reads as OFF, never as everyone"],
  ];
  for (const [what, from, to, mustFail] of breaks) {
    const broken = rulesSrc.replace(from, to);
    if (broken === rulesSrc) { check(`TEETH (${what}): the break applied`, false, "pattern not found"); continue; }
    const res = suite(loadRules(broken)).find((r) => r.name === mustFail);
    check(`TEETH: ${what} -> "${mustFail}" fails`, res && res.ok === false);
  }
  // The suite really is the suite: the unbroken source passes it in this loader too.
  check("TEETH control: the unbroken source passes every check in the same loader",
    suite(loadRules(rulesSrc)).every((r) => r.ok));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
