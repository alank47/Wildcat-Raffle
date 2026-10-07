// A teacher's browser is served their own referrals, not the school's.
// Run: npm test
//
// WHY (2026-10-07). legacyData:loadDoc('referrals') handed every staff member
// every referral -- named children, descriptions, administrator notes -- and
// the page drew only the viewer's own. The rows are now filtered on the
// server by the signed-in email, behind the appState switch 'referralScope'
// (absent = off = today's read, byte for byte). Detentions in 'secondary',
// which carry the same child and behaviour, go the same way.
//
// THE OLD-TAB CONTRACT this file holds: in scoped mode loadDoc never returns
// null and never throws, because every tab already open runs the old
// script.js -- a null sends it to a legacy list, a throw blocks every save it
// makes and stops that teacher filing a referral.
//
// Runs the SHIPPED legacyData.ts and referralAccess.ts against an in-memory
// database, with the real rules module. The teeth block re-breaks the read.
import { readFileSync } from "node:fs";
import ts from "typescript";

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const SRC = {
  legacyData: read("./convex/legacyData.ts"),
  referralAccess: read("./convex/referralAccess.ts"),
  referralAccessRules: read("./convex/referralAccessRules.ts"),
};

class ConvexError extends Error {}
function load(overrides = {}) {
  const cache = {};
  const stubs = {
    "./_generated/server": { query: (d) => d, mutation: (d) => d, internalQuery: (d) => d, internalMutation: (d) => d },
    "convex/values": { v: new Proxy({}, { get: () => (...a) => ({ _v: true, a }) }), ConvexError },
    // The real requireStaff refuses anything that is not a staff token
    // (identityRules.test.mjs proves that); here a ctx with no staff row is
    // that refusal.
    "./identity": { requireStaff: async (ctx) => { if (!ctx.staff) throw new ConvexError("Staff only."); return ctx.staff; } },
    "./referralMail": { notifyNewReferrals: async () => {} },
    "./cashArrival": { noteArrivedCash: async () => null },
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
  return { legacy: req("./legacyData"), access: req("./referralAccess") };
}

/** In-memory Convex: index eq filters, every read logged by table. */
function makeDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed || {}));
  let n = 0;
  for (const t of Object.keys(tables)) tables[t].forEach((r) => { r._id ??= `${t}:${n++}`; r._creationTime ??= n; });
  const reads = [];
  const q = (name) => {
    let rows = (tables[name] || []).slice();
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
      async unique() { if (rows.length > 1) throw new Error("unique() found two"); return done(rows[0] ?? null); },
      async take(k) { return done(rows.slice(0, k)); },
      async collect() { return done(rows); },
    };
    return api;
  };
  const db = {
    query: q,
    async insert(name, doc) { (tables[name] ||= []).push({ ...doc, _id: `${name}:new${n++}`, _creationTime: 1e12 + n }); },
    async patch(id, f) { for (const t of Object.values(tables)) { const r = t.find((x) => x._id === id); if (r) Object.assign(r, f); } },
    async delete(id) { for (const t of Object.keys(tables)) tables[t] = tables[t].filter((x) => x._id !== id); },
  };
  return { tables, reads, db };
}

// ---------------------------------------------------------------- fixtures
// Synthetic people and children. No real names anywhere.
const T1 = { _id: "t1", email: "teacher.one@school.org", name: "Teacher One", role: "teacher" };
const T2 = { _id: "t2", email: "teacher.two@school.org", name: "Teacher Two", role: "teacher" };
const NONE = { _id: "t3", email: "new.teacher@school.org", name: "New Teacher", role: "teacher" };
const AIDE = { _id: "t4", email: "aide@school.org", name: "An Aide", role: "campusaide" };
const WATCH = { _id: "t5", email: "watch@school.org", name: "Watch Aide", role: "campusaide", attendanceWatch: true };
const MIDDLE = { _id: "t6", email: "middle@school.org", name: "Middle Teacher", role: "teacher", gradeScope: "middle" };
const PBIS = { _id: "t7", email: "pbis@school.org", name: "Pbis Lead", role: "pbis" };
const ADMIN = { _id: "t8", email: "admin@school.org", name: "An Admin", role: "admin" };
const SUPER = { _id: "t9", email: "owner@school.org", name: "The Owner", role: "superadmin" };
const STAFF = [T1, T2, NONE, AIDE, WATCH, MIDDLE, PBIS, ADMIN, SUPER];

const ref = (id, extra) => ({ id, studentName: "Student " + id, description: "what happened", status: "open",
  adminNotes: "", submittedAt: "2026-10-01T15:00:00.000Z", updatedAt: "2026-10-01T15:00:00.000Z", ...extra });
const by = (t) => ({ filedByEmail: t.email, referredByEmail: t.email, referredBy: t.name });
const m = (doc, collection, payload, key) => ({ doc, collection, payload, mirroredAt: "x", ...(key ? { key } : {}) });
const REFERRALS = [
  m("referrals", "behaviorReferrals", ref("R1", by(T1))),
  m("referrals", "behaviorReferrals", ref("R2", { ...by(T2), status: "closed", adminNotes: "met parent" })),
  m("referrals", "behaviorReferrals", ref("R3", { ...by(T1), filedByEmail: "Teacher.One@School.org " })),
  // Today's browser shows this one to Teacher One by NAME. The server must not.
  m("referrals", "behaviorReferrals", ref("R4", { referredBy: T1.name })),
  m("referrals", "behaviorReferrals", ref("R5", by(AIDE))),
  m("referrals", "behaviorReferrals", ref("R6", by(MIDDLE))),
];
const SECONDARY = [
  m("secondary", "detentions", { id: "detention_1", studentName: "Student R2", reason: "Referral R2: Defiance", sourceReferralId: "R2" }),
  m("secondary", "hallPasses", { id: "p1" }),
  m("secondary", "loginHistory", { at: "2026-10-01" }),
  m("secondary", "cashReceipts", { id: "WC-1" }),
];
const OTHER = [m("main", "settings", { a: 1 }), m("schedules", "sections", { id: "s1" })];
const SW = (value) => ({ key: "referralScope", value, mirroredAt: "x" });
const seed = (extra = {}) => ({
  legacyMirror: [...REFERRALS, ...SECONDARY, ...OTHER, ...(extra.mirror || [])],
  appState: extra.appState || [],
  teachers: STAFF,
});

/**
 * TODAY'S loadDoc, verbatim (689f3fe), types stripped. The OFF path must stay
 * byte-identical to this, and admins' ON path must too.
 */
function referenceLoadDoc(allRows, doc) {
  const rows = allRows.filter((r) => r.doc === doc);
  if (rows.length === 0) return null;
  const collections = {};
  for (const r of rows) (collections[r.collection] ??= []).push({ key: r.key, payload: r.payload });
  const out = {};
  for (const [collection, slice] of Object.entries(collections)) {
    const keyed = slice.some((r) => typeof r.key === "string");
    if (keyed) {
      const map = {};
      for (const r of slice) if (typeof r.key === "string") map[r.key] = r.payload;
      out[collection] = map;
    } else {
      out[collection] = slice.map((r) => r.payload);
    }
  }
  return out;
}

const M = load();
const J = (x) => JSON.stringify(x);
async function loadAs(staff, doc, s = seed(), mod = M) {
  const d = makeDb(s);
  const out = await mod.legacy.loadDoc.handler({ db: d.db, staff }, { doc });
  return { out, reads: d.reads, tables: d.tables };
}
const idsOf = (out) => (out && Array.isArray(out.behaviorReferrals) ? out.behaviorReferrals.map((p) => p.id).join(",") : String(out));

console.log("\nSwitch absent: every role reads exactly what it read before");
{
  const s = seed();
  for (const who of [T1, AIDE, PBIS, ADMIN, SUPER, NONE]) {
    for (const doc of ["referrals", "secondary", "main", "schedules"]) {
      const { out } = await loadAs(who, doc, s);
      check(`${who.role} ${who === NONE ? "(no referrals) " : ""}${doc}: byte-identical to today's loadDoc`,
        J(out) === J(referenceLoadDoc(s.legacyMirror, doc)));
    }
  }
  const { out } = await loadAs(T1, "nothing_here");
  check("a doc with no rows is still null (callers branch on absence)", out === null);
  const err = await M.legacy.loadDoc.handler({ db: makeDb(seed()).db, staff: null }, { doc: "referrals" }).then(() => null, (e) => e);
  check("a non-staff caller (a student token) is still refused", err instanceof ConvexError);
  for (const value of [{ enabled: false }, { enabled: "true" }, { enabled: true, pilotEmails: "teacher.one@school.org" }, null]) {
    const r = await loadAs(T1, "referrals", seed({ appState: [SW(value)] }));
    check(`a switch row of ${J(value)} reads as OFF`, J(r.out) === J(referenceLoadDoc(seed().legacyMirror, "referrals")));
  }
}

console.log("\nSwitch on for everyone: teachers and aides get their own");
{
  const on = seed({ appState: [SW({ enabled: true })] });
  const today = (doc) => J(referenceLoadDoc(on.legacyMirror, doc));
  for (const who of [ADMIN, SUPER, PBIS]) {
    check(`${who.role}: referrals byte-identical to the switch being off`, J((await loadAs(who, "referrals", on)).out) === today("referrals"));
    check(`${who.role}: secondary byte-identical too (detentions included)`, J((await loadAs(who, "secondary", on)).out) === today("secondary"));
  }
  check("a teacher gets only the rows filed under their email, in stored order",
    idsOf((await loadAs(T1, "referrals", on)).out) === "R1,R3");
  check("...the name-only row today's browser would show them is NOT served",
    !idsOf((await loadAs(T1, "referrals", on)).out).includes("R4"));
  check("...and the shape is the one old tabs expect: { behaviorReferrals: [...] } and nothing else",
    J(Object.keys((await loadAs(T1, "referrals", on)).out)) === J(["behaviorReferrals"]));
  check("another teacher gets theirs, with its own admin notes intact",
    J((await loadAs(T2, "referrals", on)).out.behaviorReferrals) === J([REFERRALS[1].payload]));
  check("a campus aide is own-only", idsOf((await loadAs(AIDE, "referrals", on)).out) === "R5");
  check("an Attendance Watch grant does not widen it", idsOf((await loadAs(WATCH, "referrals", on)).out) === "");
  check("a middle-school grade scope does not widen it", idsOf((await loadAs(MIDDLE, "referrals", on)).out) === "R6");
  {
    const { out } = await loadAs(NONE, "referrals", on);
    check("a teacher with NO referrals gets { behaviorReferrals: [] }, never null",
      out !== null && Array.isArray(out.behaviorReferrals) && out.behaviorReferrals.length === 0);
  }
  {
    const empty = { ...on, legacyMirror: on.legacyMirror.filter((r) => r.doc !== "referrals") };
    const { out } = await loadAs(T1, "referrals", empty);
    check("...even when the doc has no rows at all", J(out) === J({ behaviorReferrals: [] }));
    const adm = await loadAs(ADMIN, "referrals", empty);
    check("...and so does an admin then (an old tab treats null and [] alike for them)", J(adm.out) === J({ behaviorReferrals: [] }));
  }
  {
    const planted = seed({ appState: [SW({ enabled: true })], mirror: [
      m("referrals", "behaviorReferrals", ref("K1", by(T1)), "k1"),
      m("referrals", "elsewhere", ref("E1", by(T1))),
    ] });
    const t = await loadAs(T1, "referrals", planted);
    const a = await loadAs(ADMIN, "referrals", planted);
    check("a keyed row planted in 'referrals' is not served, and does not turn the list into a map",
      idsOf(t.out) === "R1,R3" && idsOf(a.out) === "R1,R2,R3,R4,R5,R6");
    check("a stray collection in the doc is not served", !("elsewhere" in t.out) && !("elsewhere" in a.out));
  }
  {
    const weird = seed({ appState: [SW({ enabled: true })], mirror: [
      m("referrals", "behaviorReferrals", "not an object"), m("referrals", "behaviorReferrals", null),
    ] });
    const r = await loadAs(T1, "referrals", weird).then((x) => x, (e) => ({ err: e }));
    check("malformed stored rows neither throw nor leak", !r.err && idsOf(r.out) === "R1,R3");
  }
  {
    const twice = seed({ appState: [SW({ enabled: true }), SW({ enabled: true })] });
    const r = await loadAs(T1, "referrals", twice).then((x) => x, (e) => ({ err: e }));
    check("a DUPLICATED switch row does not throw (.first(), not .unique())", !r.err && idsOf(r.out) === "R1,R3");
  }
}

console.log("\nDetentions follow the referrals");
{
  const on = seed({ appState: [SW({ enabled: true })] });
  const today = referenceLoadDoc(on.legacyMirror, "secondary");
  for (const who of [T1, AIDE, NONE]) {
    const { out } = await loadAs(who, "secondary", on);
    check(`${who.role}${who === NONE ? " (none)" : ""}: detentions is an empty array`,
      Array.isArray(out.detentions) && out.detentions.length === 0);
    const rest = { ...out }; delete rest.detentions;
    const want = { ...today }; delete want.detentions;
    check(`${who.role}${who === NONE ? " (none)" : ""}: every other secondary list is unchanged`, J(rest) === J(want));
  }
  const empty = { ...on, legacyMirror: on.legacyMirror.filter((r) => r.doc !== "secondary") };
  check("an empty secondary doc is still null for a teacher (absent stays absent)",
    (await loadAs(T1, "secondary", empty)).out === null);
  const onlyDet = { ...on, legacyMirror: [SECONDARY[0]] };
  check("a secondary holding only detentions gives a teacher { detentions: [] }",
    J((await loadAs(T1, "secondary", onlyDet)).out) === J({ detentions: [] }));
}

console.log("\nA pilot list touches only the people on it");
{
  const pilot = seed({ appState: [SW({ enabled: true, pilotEmails: [" Teacher.One@school.org ", PBIS.email] })] });
  const all = J(referenceLoadDoc(pilot.legacyMirror, "referrals"));
  check("a listed teacher is scoped", idsOf((await loadAs(T1, "referrals", pilot)).out) === "R1,R3");
  check("an unlisted teacher still reads everything (the control)", J((await loadAs(T2, "referrals", pilot)).out) === all);
  check("an unlisted teacher still gets detentions", (await loadAs(T2, "secondary", pilot)).out.detentions.length === 1);
  check("the listed teacher's detentions are withheld", (await loadAs(T1, "secondary", pilot)).out.detentions.length === 0);
  check("a listed PBIS member reads everything, as before", J((await loadAs(PBIS, "referrals", pilot)).out) === all);
  check("the owner, unlisted, reads everything", J((await loadAs(SUPER, "referrals", pilot)).out) === all);
}

console.log("\nWhat it costs: one point read of the switch, and only where it can matter");
{
  const s = seed({ appState: [SW({ enabled: true })] });
  const sw = async (who, doc) => (await loadAs(who, doc, s)).reads.filter((t) => t === "appState").length;
  check("'referrals': one switch read, for anyone", (await sw(T1, "referrals")) === 1 && (await sw(ADMIN, "referrals")) === 1);
  check("'secondary': one for a teacher, none for an admin or PBIS",
    (await sw(T1, "secondary")) === 1 && (await sw(ADMIN, "secondary")) === 0 && (await sw(PBIS, "secondary")) === 0);
  check("'main' and 'schedules': none, for anyone",
    (await sw(T1, "main")) + (await sw(T1, "schedules")) + (await sw(ADMIN, "main")) === 0);
  const r = await loadAs(T1, "referrals", s);
  check("and the referrals doc itself is still read once, through the index", r.reads.filter((t) => t === "legacyMirror").length === 1);
}

console.log("\nThe CLI: switches, the side-by-side compare, and the write preview");
{
  const d = makeDb(seed());
  const A = M.access;
  let st = await A.status.handler({ db: d.db }, {});
  check("status: both switches OFF when no row exists",
    J(st) === J({ referralScope: { enabled: false, pilotEmails: [] }, referralCloseGuard: { enabled: false, pilotEmails: [] } }));
  await A.configureScope.handler({ db: d.db }, { enabled: true, pilotEmails: [" Teacher.One@School.org", ""] });
  await A.configureScope.handler({ db: d.db }, { pilotEmails: ["teacher.one@school.org", PBIS.email] });
  st = await A.status.handler({ db: d.db }, {});
  check("configureScope overlays: narrowing the pilot keeps it on, emails normalised",
    st.referralScope.enabled === true && J(st.referralScope.pilotEmails) === J(["teacher.one@school.org", PBIS.email]));
  check("...and leaves the close guard alone", st.referralCloseGuard.enabled === false);
  await A.configureScope.handler({ db: d.db }, { enabled: false });
  st = await A.status.handler({ db: d.db }, {});
  check("switching off keeps the pilot list for next time", st.referralScope.enabled === false && st.referralScope.pilotEmails.length === 2);
  await A.configureCloseGuard.handler({ db: d.db }, { enabled: true });
  st = await A.status.handler({ db: d.db }, {});
  check("configureCloseGuard sets its own row only", st.referralCloseGuard.enabled === true && st.referralScope.enabled === false);
  check("one row per switch, never a duplicate", d.tables.appState.filter((r) => r.key === "referralScope").length === 1);

  // A PILOT LIST OF BLANKS (review, 2026-10-07): `'{"pilotEmails":["'$T1'"]}'`
  // with T1 unset sends [""]. Normalised that was [], which means everyone.
  const blank = makeDb(seed());
  await A.configureScope.handler({ db: blank.db }, { enabled: true, pilotEmails: ["teacher.one@school.org"] });
  const before = J(await A.status.handler({ db: blank.db }, {}));
  let refused = null;
  try { await A.configureScope.handler({ db: blank.db }, { pilotEmails: [""] }); } catch (e) { refused = e; }
  check("configureScope refuses a pilot list that names no email, rather than opening it to everyone",
    !!refused && /none is an email/.test(refused.message), refused && refused.message);
  check("...and changes nothing", J(await A.status.handler({ db: blank.db }, {})) === before);
  refused = null;
  try { await A.configureCloseGuard.handler({ db: makeDb(seed()).db }, { enabled: true, pilotEmails: ["  ", ""] }); } catch (e) { refused = e; }
  check("configureCloseGuard refuses it too", !!refused);
  await A.configureScope.handler({ db: blank.db }, { pilotEmails: [] });
  check("an empty list typed on purpose still opens the switch to everyone",
    J((await A.status.handler({ db: blank.db }, {})).referralScope) === J({ enabled: true, pilotEmails: [] }));

  const cmp = await A.compareScope.handler({ db: makeDb(seed()).db }, { emails: [ADMIN.email, PBIS.email, T1.email, NONE.email, "nobody@school.org"] });
  const [adm, pb, t1, none, nobody] = cmp.people;
  check("compare: admin and PBIS are identical to the current read", adm.identicalToCurrent && pb.identicalToCurrent && adm.scoped === 6 && adm.current === 6);
  check("compare: the teacher's scoped rows are all theirs and none of theirs is missing",
    t1.everyScopedRowOwned === true && t1.ownedButMissing === 0 && t1.scoped === 2 && t1.identicalToCurrent === false);
  check("compare: today's browser would show them 3 (the name-only row), so nameOnlyMatches is 1",
    t1.clientRuleWouldShow === 3 && t1.nameOnlyMatches === 1);
  check("compare: a teacher with none scopes to 0", none.scoped === 0 && none.ownedButMissing === 0);
  check("compare: an unknown email is reported as not found", nobody.found === false);
  check("compare: closed and loop counts", cmp.rows === 6 && cmp.closed === 1 && cmp.closedByNonCloserRole === 0);

  const pv = await A.previewWrites.handler({ db: makeDb(seed()).db }, { email: T1.email });
  check("preview (teacher): every outcome is what the rules predict", pv.matchesExpected === true, J(pv.attempts));
  check("preview (teacher): Close is kept on both own rows and skipped on the other four",
    pv.attempts.close.keptCloseFields === 2 && pv.attempts.close.notYours === 4 && pv.attempts.close.written === 0);
  check("preview (teacher): own edits land, claims are pinned, 9999 is clamped",
    pv.attempts.edit.written === 2 && pv.attempts.claim.ownerKept === 2 && pv.attempts.future.clamped === 2);
  check("preview (teacher): their own referral sent closed is filed open; colleagues' are refused",
    pv.inserts.ownClosedFiledOpen === true && pv.inserts.colleaguesRefused === 4 && pv.inserts.colleaguesRefiled === 0);
  const pa = await A.previewWrites.handler({ db: makeDb(seed()).db }, { email: ADMIN.email });
  check("preview (admin): the guard does not apply and every close lands",
    pa.guardApplies === false && pa.attempts.close.closeLanded === 6 && pa.matchesExpected === true);

  // NO PII. Nothing these return is longer than a role name, and every key
  // is one of the known counters.
  const strings = [];
  const walk = (x) => { if (typeof x === "string") strings.push(x); else if (x && typeof x === "object") Object.values(x).forEach(walk); };
  walk(cmp); walk(pv); walk(pa);
  check("compareScope and previewWrites return no string longer than a role name",
    strings.every((s) => s.length <= "superadmin".length), strings.filter((s) => s.length > 10).join(" | "));
  check("...and the strings they do return are role names",
    strings.every((s) => ["teacher", "campusaide", "pbis", "admin", "superadmin"].includes(s)));
  const keys = new Set(); const walkKeys = (x) => { if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { if (!Array.isArray(x)) keys.add(k); walkKeys(v); } };
  walkKeys(cmp); walkKeys(pv);
  check("...and no key names a person, a child or a referral",
    [...keys].every((k) => /^(rows|keyedOrOtherRows|people|closed|closedByNonCloserRole|loopClosed|loopClosedByNonCloserRole|found|role|seesAll|current|scoped|identicalToCurrent|everyScopedRowOwned|ownedButMissing|clientRuleWouldShow|nameOnlyMatches|guardApplies|owned|attempts|expected|inserts|matchesExpected|close|edit|claim|future|written|notYours|stale|keptCloseFields|noChange|closeLanded|ownerKept|clamped|futureStored|ownClosedFiledOpen|colleaguesRefiled|colleaguesRefused)$/.test(k)),
    [...keys].join(","));
}

console.log("\nThe shipped source says what it does");
{
  const src = SRC.legacyData;
  const load = src.slice(src.indexOf("export const loadDoc"), src.indexOf("/**", src.indexOf("export const loadDoc")));
  check("loadDoc keeps the staff check as its first statement", /handler: async \(ctx, \{ doc \}\) => \{\s*const me = await requireStaff\(ctx\);/.test(load));
  check("the switch is read with .first()", /readReferralSwitch[\s\S]{0,300}\.first\(\)/.test(src) && !/key", key\)\)\.unique\(\)/.test(src));
  check("the scoped branch falls back to an empty list, never null",
    /rebuildDoc\(scopeReferralRows\(rows, me\)\) \?\? \{ behaviorReferrals: \[\] \}/.test(load));
  check("the unscoped path is the same rebuildDoc everyone used", /return rebuildDoc\(rows\);\s*\},\s*\}\);/.test(load));
}

console.log("\nTEETH: the read, re-broken, fails a check above");
{
  const breaks = [
    ["the scope ignored", "return rebuildDoc(scopeReferralRows(rows, me)) ?? { behaviorReferrals: [] };",
      "return rebuildDoc(rows) ?? { behaviorReferrals: [] };",
      async (B) => idsOf((await loadAs(T1, "referrals", seed({ appState: [SW({ enabled: true })] }), B)).out) === "R1,R3"],
    ["null for a teacher with none", "return rebuildDoc(scopeReferralRows(rows, me)) ?? { behaviorReferrals: [] };",
      "return rebuildDoc(scopeReferralRows(rows, me));",
      async (B) => (await loadAs(NONE, "referrals", seed({ appState: [SW({ enabled: true })] }), B)).out !== null],
    ["detentions still sent", '{ ...(rebuildDoc(rows.filter((r) => r.collection !== "detentions")) ?? {}), detentions: [] }', "rebuildDoc(rows)",
      async (B) => {
        const out = (await loadAs(T1, "secondary", seed({ appState: [SW({ enabled: true })] }), B)).out;
        return Array.isArray(out.detentions) && out.detentions.length === 0;
      }],
    ["the switch read with .unique()", '.withIndex("by_key", (q) => q.eq("key", key)).first();',
      '.withIndex("by_key", (q) => q.eq("key", key)).unique();',
      async (B) => !!(await loadAs(T1, "referrals", seed({ appState: [SW({ enabled: true }), SW({ enabled: true })] }), B)
        .then((x) => x.out, () => null))],
  ];
  for (const [what, from, to, holds] of breaks) {
    if (!SRC.legacyData.includes(from)) { check(`TEETH (${what}): the break applied`, false, "pattern not found"); continue; }
    const B = load({ legacyData: (s) => s.replace(from, to) });
    check(`TEETH: ${what} -> its check fails`, (await holds(B)) === false);
    check(`TEETH control: ${what} -> the same check passes on the shipped code`, (await holds(M)) === true);
  }
}

{
  // The pilot-list refusal, removed.
  const from = "  if (a.pilotEmails !== undefined && a.pilotEmails.length > 0 && listed!.length === 0) {";
  if (!SRC.referralAccess.includes(from)) check("TEETH (blank pilot list): the break applied", false, "pattern not found");
  else {
    const B = load({ referralAccess: (s) => s.replace(from, "  if (false) {") });
    const d = makeDb(seed());
    let threw = false;
    try { await B.access.configureScope.handler({ db: d.db }, { enabled: true, pilotEmails: [""] }); } catch (e) { threw = true; }
    const st = await B.access.status.handler({ db: d.db }, {});
    // Stored normalised it is [], which the reader cannot tell from "everyone".
    check("TEETH: without the refusal a blank pilot list opens the switch to the whole school",
      !threw && st.referralScope.enabled === true && st.referralScope.pilotEmails.length === 0);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
