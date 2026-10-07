// The only referral write the app makes still works; the hand-made ones that
// could wipe, hide or claim the school's referrals are refused.
// Run: npm test
//
// WHY (2026-10-07). legacyData:saveSlice and :mergeSlice took any doc, any
// collection and any dedupe field from any signed-in staff member. From the
// browser console, a teacher could:
//   - saveSlice('referrals', 'behaviorReferrals', [])      -> every referral gone
//   - mergeSlice(..., dedupeField 'status')                -> 16 of 18 gone
//   - mergeSlice with one keyed row                        -> every screen shows 0
//   - mergeSlice a newer copy naming themselves the filer  -> a colleague's
//     referral becomes theirs, and the email scoping then serves it to them.
// The app never sends any of those. Its one referral write is
// mergeLegacySlice('referrals', 'behaviorReferrals', behaviorReferrals, 'id').
//
// Runs the SHIPPED legacyData.ts (transpiled, wired by a require shim, against
// an in-memory database). The last block removes each refusal and proves a
// check here fails.
import { readFileSync } from "node:fs";
import ts from "typescript";

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const SRC = {
  legacyData: read("./convex/legacyData.ts"),
  referralAccessRules: read("./convex/referralAccessRules.ts"),
};
const script = read("./script.js");
/** Comments stripped, so prose describing a call is never mistaken for one. */
const code = script.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

class ConvexError extends Error {}
const TEACHER = { _id: "t1", email: "teacher.one@school.org", name: "Teacher One", role: "teacher" };

function load(overrides = {}) {
  const cache = {};
  const stubs = {
    "./_generated/server": { query: (d) => d, mutation: (d) => d, internalQuery: (d) => d, internalMutation: (d) => d },
    "convex/values": { v: new Proxy({}, { get: () => (...a) => ({ _v: true, a }) }), ConvexError },
    "./identity": { requireStaff: async (ctx) => ctx.__me ?? TEACHER },
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
  return req("./legacyData");
}

function makeDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed || {}));
  let n = 0;
  for (const t of Object.keys(tables)) tables[t].forEach((r) => { r._id ??= `${t}:${n++}`; r._creationTime ??= n; });
  const q = (name) => {
    let rows = (tables[name] || []).slice();
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
      async first() { return rows[0] ?? null; },
      async unique() { if (rows.length > 1) throw new Error("unique: many"); return rows[0] ?? null; },
      async take(k) { return rows.slice(0, k); },
      async collect() { return rows; },
    };
    return api;
  };
  const db = {
    query: q,
    async insert(name, doc) { (tables[name] ||= []).push({ ...doc, _id: `${name}:new${n++}`, _creationTime: 1e12 + n }); },
    async patch(id, f) { for (const t of Object.values(tables)) { const r = t.find((x) => x._id === id); if (r) Object.assign(r, f); } },
    async delete(id) { for (const t of Object.keys(tables)) tables[t] = tables[t].filter((x) => x._id !== id); },
  };
  return { tables, ctx: { db, scheduler: { runAfter: async () => {} } } };
}

const mirror = (doc, collection, payload, key) => ({ doc, collection, payload, mirroredAt: "x", ...(key ? { key } : {}) });
const seed = () => ({
  legacyMirror: [
    mirror("referrals", "behaviorReferrals", { id: "R1", status: "open", filedByEmail: TEACHER.email }),
    mirror("referrals", "behaviorReferrals", { id: "R2", status: "open", filedByEmail: "other@school.org" }),
    mirror("referrals", "behaviorReferrals", { id: "R3", status: "closed", filedByEmail: "other@school.org" }),
    mirror("secondary", "loginHistory", { at: "x" }),
  ],
});
const referralCount = (d) => d.tables.legacyMirror.filter((r) => r.doc === "referrals").length;
const attempt = (fn) => fn().then(() => null, (e) => e);

// The checks, as a function of a loaded module, so the teeth block can run
// them against a copy with a refusal removed.
async function behaviour(L) {
  const out = {};
  {
    const d = makeDb(seed());
    const err = await attempt(() => L.saveSlice.handler(d.ctx, { doc: "referrals", collection: "behaviorReferrals", rows: [] }));
    out.saveSliceRefused = err instanceof ConvexError && /never replaced/.test(err.message);
    out.saveSliceKeptAll = referralCount(d) === 3;
  }
  {
    const d = makeDb(seed());
    const err = await attempt(() => L.mergeSlice.handler(d.ctx, { doc: "referrals", collection: "behaviorReferrals", rows: [], dedupeField: "status" }));
    out.statusRefused = err instanceof ConvexError && /by id only/.test(err.message);
    out.statusKeptAll = referralCount(d) === 3;
  }
  {
    const d = makeDb(seed());
    const err = await attempt(() => L.mergeSlice.handler(d.ctx, { doc: "referrals", collection: "behaviorReferrals",
      rows: [{ key: "k", payload: { id: "R9" } }], dedupeField: "id" }));
    out.keyedRefused = err instanceof ConvexError;
    out.keyedNoInsert = referralCount(d) === 3;
  }
  return out;
}

console.log("\nThe app's referral writes, as script.js makes them");
{
  const merges = [...code.matchAll(/mergeLegacySlice\(\s*'referrals'[^)]*\)/g)].map((m) => m[0]);
  check("exactly one mergeLegacySlice('referrals', ...) call", merges.length === 1, merges.join(" | "));
  check("...and it is ('referrals', 'behaviorReferrals', behaviorReferrals, 'id')",
    merges[0] === "mergeLegacySlice('referrals', 'behaviorReferrals', behaviorReferrals, 'id')");
  check("script.js never replaces referrals through saveLegacySlice",
    !/saveLegacySlice\(\s*['"`]referrals/.test(code));
  check("nothing in script.js calls legacyData:saveSlice except saveLegacySlice itself",
    (code.match(/'legacyData:saveSlice'/g) || []).length === 1);
  check("mergeLegacySlice sends an array as UNKEYED rows (so the keyed refusal never fires on a real tab)",
    /async function mergeLegacySlice[\s\S]{0,900}Array\.isArray\(value\)\s*\?\s*\(value \|\| \[\]\)\.map\(payload => \(\{ payload \}\)\)/.test(code));
}

console.log("\nWhere the refusals sit in the shipped source");
{
  const src = SRC.legacyData;
  const save = src.slice(src.indexOf("export const saveSlice"));
  const refuse = save.indexOf('if (doc === "referrals") throw new ConvexError');
  check("saveSlice refuses doc 'referrals'", refuse > 0);
  check("...after the staff check", refuse > save.indexOf("await requireStaff(ctx);"));
  const firstDb = save.search(/ctx\.db\s*\./);
  const firstDelete = save.search(/ctx\.db\s*\.delete\(/);
  check("...and before its first read, and before its first delete",
    firstDb > 0 && firstDelete > 0 && refuse < firstDb && refuse < firstDelete);
  const merge = src.slice(src.indexOf("export const mergeSlice"), src.indexOf("export const saveSlice"));
  const mRefuse = merge.indexOf('throw new ConvexError("Referrals merge into behaviorReferrals by id only.")');
  check("mergeSlice refuses the forged shapes after the staff check, before any read",
    mRefuse > merge.indexOf("const me = await requireStaff(ctx);") && mRefuse < merge.indexOf("ctx.db"));
  check("the owner pin is applied to referral updates",
    /payload: doc === "referrals" \? pinOwnerFields\(stored\.payload, merged\) : merged/.test(merge));
}

console.log("\nThe shipped module, run");
const L = load();
{
  const b = await behaviour(L);
  check("saveSlice('referrals', ...) is refused with a readable reason", b.saveSliceRefused);
  check("...and every referral survives it", b.saveSliceKeptAll);
  check("mergeSlice with dedupeField 'status' is refused", b.statusRefused);
  check("...and every referral survives it", b.statusKeptAll);
  check("a keyed referral row is refused and not inserted", b.keyedRefused && b.keyedNoInsert);

  // CONTROL: saveSlice is still a replace for the slices that use it.
  const d = makeDb(seed());
  await L.saveSlice.handler(d.ctx, { doc: "secondary", collection: "loginHistory", rows: [{ payload: { at: "y" } }, { payload: { at: "z" } }] });
  const lh = d.tables.legacyMirror.filter((r) => r.collection === "loginHistory").map((r) => r.payload.at).join(",");
  check("control: saveSlice still replaces a whole-value slice (loginHistory)", lh === "y,z");
  check("control: ...and leaves the referrals alone", referralCount(d) === 3);

  // The app's own call still files a referral.
  const d2 = makeDb(seed());
  const res = await L.mergeSlice.handler(d2.ctx, { doc: "referrals", collection: "behaviorReferrals",
    rows: [{ payload: { id: "R1", status: "open", filedByEmail: TEACHER.email } }, { payload: { id: "R7", status: "open", filedByEmail: TEACHER.email } }],
    dedupeField: "id" });
  check("the app's real call inserts the new referral and keeps every other", res.inserted === 1 && referralCount(d2) === 4);
}

// THE CLOSE GUARD (1D), through the real handler and its real return value.
const ADMIN = { _id: "a1", email: "admin@school.org", name: "An Admin", role: "admin" };
const GUARD_ON = [{ key: "referralCloseGuard", value: { enabled: true }, mirroredAt: "x" }];
const recent = () => new Date(Date.now() - 60e3).toISOString();
async function guardBehaviour(L) {
  const out = {};
  const mk = () => makeDb({ ...seed(), appState: GUARD_ON });
  {
    const d = mk();
    const res = await L.mergeSlice.handler({ ...d.ctx, __me: TEACHER }, { doc: "referrals", collection: "behaviorReferrals",
      rows: [{ payload: { id: "R1", status: "closed", closedAt: recent(), filedByEmail: TEACHER.email, updatedAt: recent() } }], dedupeField: "id" });
    const r1 = d.tables.legacyMirror.find((r) => r.payload.id === "R1").payload;
    out.teacherCloseKeptOpen = r1.status === "open" && res.keptCloseFields === 1;
    out.teacherSeesNoSchoolTotal = !("stored" in res);
    out.countersReturned = ["refusedNotYours", "keptCloseFields", "clampedStamps", "refusedReferralDetentions"].every((k) => typeof res[k] === "number");
  }
  {
    const d = mk();
    const res = await L.mergeSlice.handler({ ...d.ctx, __me: TEACHER }, { doc: "referrals", collection: "behaviorReferrals",
      rows: [{ payload: { id: "R8", status: "open", filedByEmail: "other@school.org", referredByEmail: "other@school.org" } }], dedupeField: "id" });
    out.colleagueRefiledRefused = res.inserted === 0 && res.refusedNotYours === 1 && referralCount(d) === 3;
  }
  {
    const d = mk();
    const res = await L.mergeSlice.handler({ ...d.ctx, __me: TEACHER }, { doc: "secondary", collection: "detentions",
      rows: [{ payload: { id: "detention_1", sourceReferralId: "R1" } }], dedupeField: "id" });
    out.referralDetentionRefused = res.inserted === 0 && res.refusedReferralDetentions === 1;
  }
  {
    const d = mk();
    const res = await L.mergeSlice.handler({ ...d.ctx, __me: ADMIN }, { doc: "referrals", collection: "behaviorReferrals",
      rows: [{ payload: { id: "R2", status: "closed", closedAt: recent(), updatedAt: recent() } }], dedupeField: "id" });
    out.adminCloseLands = d.tables.legacyMirror.find((r) => r.payload.id === "R2").payload.status === "closed";
    out.adminSeesSchoolTotal = res.stored === 3;
  }
  {
    // Switch row absent: a teacher's close lands exactly as today.
    const d = makeDb(seed());
    await L.mergeSlice.handler({ ...d.ctx, __me: TEACHER }, { doc: "referrals", collection: "behaviorReferrals",
      rows: [{ payload: { id: "R1", status: "closed", closedAt: recent(), filedByEmail: TEACHER.email, updatedAt: recent() } }], dedupeField: "id" });
    out.offIsToday = d.tables.legacyMirror.find((r) => r.payload.id === "R1").payload.status === "closed";
  }
  return out;
}

console.log("\nThe close guard, through the real handler (switch 'referralCloseGuard')");
{
  const g = await guardBehaviour(L);
  check("guard on: a teacher's Close on their own referral is kept open, and counted", g.teacherCloseKeptOpen);
  check("guard on: a teacher cannot re-file a colleague's referral", g.colleagueRefiledRefused);
  check("guard on: a teacher's detention made from a referral is not inserted", g.referralDetentionRefused);
  check("guard on: an admin's close lands", g.adminCloseLands);
  check("switch absent: a teacher's close lands exactly as today", g.offIsToday);
  check("a teacher's referral save no longer reports the school's referral total", g.teacherSeesNoSchoolTotal);
  check("...an admin's still does", g.adminSeesSchoolTotal);
  check("the guard's four counters are in the return", g.countersReturned);
  // Any other slice keeps `stored`, for anyone.
  const d = makeDb(seed());
  const res = await L.mergeSlice.handler({ ...d.ctx, __me: TEACHER }, { doc: "secondary", collection: "hallPasses",
    rows: [{ payload: { id: "p1" } }], dedupeField: "id" });
  check("...and a teacher's save of any other slice still reports `stored`", res.stored === 1);
}

console.log("\nTEETH: each refusal, removed, fails a check above");
{
  const breaks = [
    ["saveSlice refusal removed", 'if (doc === "referrals") throw new ConvexError("Referrals are merged, never replaced.");', "", "saveSliceKeptAll"],
    ["dedupeField no longer pinned", 'collection !== "behaviorReferrals" || dedupeField !== "id"', 'collection !== "behaviorReferrals"', "statusKeptAll"],
    ["keyed rows no longer refused", '\n        || rows.some((r) => r.key !== undefined)', "", "keyedNoInsert"],
  ];
  for (const [what, from, to, key] of breaks) {
    if (!SRC.legacyData.includes(from)) { check(`TEETH (${what}): the break applied`, false, "pattern not found"); continue; }
    const B = load({ legacyData: (s) => s.replace(from, to) });
    const b = await behaviour(B);
    check(`TEETH: ${what} -> "${key}" fails`, b[key] === false);
  }
  const guardBreaks = [
    ["the update guard removed", "if (stored && closeGuard && doc === \"referrals\") {", "if (false) {", "teacherCloseKeptOpen"],
    ["the insert guard removed", "if (closeGuard && doc === \"referrals\") {\n        const plan = planReferralInsert", "if (false) {\n        const plan = planReferralInsert", "colleagueRefiledRefused"],
    ["the referral-detention guard removed", "if (closeGuard && doc === \"secondary\" && madeFromReferral(r.payload)) {", "if (false) {", "referralDetentionRefused"],
    ["closers guarded too", "&& !canCloseReferrals(me.role)\n", "\n", "adminCloseLands"],
    ["the school total returned to everyone", "...(doc === \"referrals\" && !seesAllReferrals(me.role)", "...(false", "teacherSeesNoSchoolTotal"],
    ["the switch ignored (always on)", "&& switchAllows(await readReferralSwitch(ctx, REFERRAL_CLOSE_GUARD_KEY), me.email);", ";", "offIsToday"],
  ];
  for (const [what, from, to, key] of guardBreaks) {
    if (!SRC.legacyData.includes(from)) { check(`TEETH (${what}): the break applied`, false, "pattern not found"); continue; }
    const B = load({ legacyData: (s) => s.replace(from, to) });
    const g = await guardBehaviour(B).catch((e) => ({ error: e.message }));
    check(`TEETH: ${what} -> "${key}" fails`, g[key] === false, g.error);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
