// No NEW browser-reachable read of a whole growing table. Run: npm test
//
// THE WALL THIS GUARDS (measured 2026-10-05). Convex stops one query or
// mutation at 16 MiB of data read. Two tables grow with the cash ledger:
// `legacyMirror` holds it as whole week documents (~1.3 MiB a school week,
// no per-row index), and `students` carries every child's whole cash-history
// copy on its row (3.2 MiB by Convex's count, +0.86 MiB a school week). Any
// read of either table that is not narrowed by an index range therefore gets
// heavier every school day, and on the day it crosses the line the screen
// behind it fails -- for the staff page load, SILENTLY. The interim fix took
// two of those reads off the browser's path (the reversal panel's whole
// students read, and the page load's whole roster read); this test is what
// stops the next one arriving unnoticed.
//
// WHAT COUNTS AS UNBOUNDED, in a function a browser can reach (a public
// query/mutation/action, or a helper or internal function one of them calls
// directly): a `.query("students")` or `.query("legacyMirror")` chain with no
// `withIndex(..., q => q.eq(...))`, ending in collect(), paginate(), a take()
// of more than 100, or nothing recognisable. `withIndex("by_doc")` with no eq
// is the whole mirror and counts too. One week by `by_doc_collection` eq doc
// is bounded: a single week only fails at ~28,000 rows.
//
// A `.filter(` WITH NO eq RANGE IS UNBOUNDED, WHATEVER IT ENDS IN. first(),
// unique() and a small take() stop after that many MATCHES, not that many
// rows read: a filter that matches nothing reads the whole table to say so.
//
// Deploy-key functions (internal*) are out of scope unless a browser-reachable
// function runs them: they fail loudly in a terminal, not on a screen. Crons
// and scheduled functions are also out of scope -- the headroom check measures
// those nightly instead (readHeadroom.ts).
//
// THE ALLOWLIST is today's known readers, each with why it is tolerated and
// what replaces it. A new reader fails until it is narrowed or written down
// here; a listed reader that disappears fails too, so the list cannot rot.
import { readFileSync, readdirSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "\n        " + why : ""}`));
};

const ALLOWED = {
  "appData.ts:load:students": "every staff page load needs every student row; the cash-history copy riding on " +
    "each row is moved off it in step 3 (2026-10-05 plan). Measured nightly as appData:load.",
  "leaderboard.ts:cash:students": "ranks every student; same step 3. Measured nightly as leaderboard:cash.",
  // Reached from the browser through the admin's "Sync now" (sisManual:runNow
  // runs sisAction.syncFromPowerSchool, which runs these), as well as the cron.
  "sisSync.ts:syncStudents:students": "the PowerSchool sync matches every incoming student against every " +
    "stored one; shrinks with step 3, or moves to one indexed lookup per incoming row. Measured nightly as sisSync:syncStudents.",
  "studentEmail.ts:setStudentEmails:students": "the email sync's closing count of every student; same as the " +
    "sync above (same students bytes, same date).",
};

const KINDS = "query|mutation|action|internalQuery|internalMutation|internalAction|httpAction";
const PUBLIC = new Set(["query", "mutation", "action", "httpAction"]);

// Comments become spaces, so offsets and line numbers survive and prose that
// quotes a read is never mistaken for one.
export function blankComments(src) {
  let out = "", i = 0, str = null;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (str) {
      out += c;
      if (c === "\\") { out += d ?? ""; i += 2; continue; }
      if (c === str) str = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") { str = c; out += c; i++; continue; }
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2); const end = e < 0 ? n : e + 2;
      out += src.slice(i, end).replace(/[^\n]/g, " "); i = end; continue;
    }
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i); const end = e < 0 ? n : e;
      out += " ".repeat(end - i); i = end; continue;
    }
    out += c; i++;
  }
  return out;
}

function closeParen(src, open) {
  let depth = 0, str = null;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (str) { if (c === "\\") { j++; continue; } if (c === str) str = null; continue; }
    if (c === '"' || c === "'" || c === "`") { str = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return j + 1; }
  }
  return src.length;
}

/** The method calls chained onto a `.query("t")`, across lines. */
function chainAfter(src, i) {
  const calls = [];
  for (;;) {
    const m = /^\s*\.\s*(\w+)\s*\(/.exec(src.slice(i, i + 300));
    if (!m) break;
    const open = i + m[0].length - 1;
    const close = closeParen(src, open);
    calls.push({ name: m[1], args: src.slice(open + 1, close - 1) });
    i = close;
  }
  return calls;
}

/** Every read of students / legacyMirror, classified, in the given files. */
export function scan(files) {
  const decls = {};
  for (const [f, raw] of Object.entries(files)) {
    const src = blankComments(raw);
    const list = [];
    for (const m of src.matchAll(/^(export\s+)?(?:const|let|(?:async\s+)?function)\s+(\w+)/gm)) {
      const k = new RegExp(`^export\\s+const\\s+\\w+\\s*=\\s*(${KINDS})\\s*\\(`).exec(src.slice(m.index, m.index + 300));
      list.push({ file: f, name: m[2], at: m.index, kind: k ? k[1] : "helper", exported: Boolean(m[1]) });
    }
    list.forEach((d, i) => { d.body = src.slice(d.at, i + 1 < list.length ? list[i + 1].at : src.length); });
    decls[f] = { src, list };
  }
  // Reachability: public functions, then whatever they call directly -- a
  // helper by name in the same file, an exported helper by name from another
  // file, an internal function through ctx.runQuery/runMutation/runAction.
  const key = (d) => `${d.file}:${d.name}`;
  const reach = new Set();
  for (const { list } of Object.values(decls)) for (const d of list) if (PUBLIC.has(d.kind)) reach.add(key(d));
  const all = Object.values(decls).flatMap((x) => x.list);
  const byKey = new Map(all.map((d) => [key(d), d]));
  for (let grew = true; grew;) {
    grew = false;
    const live = [...reach].map((k) => byKey.get(k)).filter(Boolean);
    for (const d of all) {
      if (reach.has(key(d))) continue;
      const re = new RegExp(`\\b${d.name}\\b`);
      let hit = false;
      if (d.kind === "helper") {
        hit = live.some((o) => o !== d && (o.file === d.file || d.exported) && re.test(o.body));
      } else if (/^internal/.test(d.kind)) {
        const mod = d.file.replace(/\.ts$/, "");
        const call = new RegExp(`run(?:Query|Mutation|Action)\\(\\s*internal\\.${mod}\\.${d.name}\\b`);
        hit = live.some((o) => call.test(o.body));
      }
      if (hit) { reach.add(key(d)); grew = true; }
    }
  }
  const sites = [];
  for (const [f, { src, list }] of Object.entries(decls)) {
    for (const m of src.matchAll(/\.query\(\s*["'](students|legacyMirror)["']\s*\)/g)) {
      const calls = chainAfter(src, m.index + m[0].length);
      const d = [...list].reverse().find((x) => x.at <= m.index) || { file: f, name: "(top level)", kind: "helper" };
      const ix = calls.find((c) => c.name === "withIndex");
      const hasEq = Boolean(ix && /\.eq\(/.test(ix.args));
      const term = calls.find((c) => ["collect", "take", "first", "unique", "paginate"].includes(c.name));
      const n = term && term.name === "take" ? Number(term.args.trim()) : NaN;
      const filtered = calls.some((c) => c.name === "filter");
      const bounded = hasEq || (!filtered && (
        (term && (term.name === "first" || term.name === "unique")) ||
        (term && term.name === "take" && Number.isFinite(n) && n <= 100)));
      sites.push({
        file: f, decl: d.name, kind: d.kind, table: m[1],
        line: src.slice(0, m.index).split("\n").length,
        reachable: reach.has(key(d)),
        how: (ix ? `withIndex(${ix.args.split(",")[0].trim()}${hasEq ? ", eq" : ""}).` : "") +
             (filtered ? "filter()." : "") +
             (term ? `${term.name}(${term.name === "take" ? term.args.trim() : ""})` : "(no terminal)"),
        bounded,
      });
    }
  }
  return sites;
}

const readConvex = () => {
  const out = {};
  for (const f of readdirSync("convex")) {
    if (!f.endsWith(".ts") || f.endsWith(".d.ts") || f.includes(".test.")) continue;
    out[f] = readFileSync(`convex/${f}`, "utf8");
  }
  return out;
};
const sigOf = (s) => `${s.file}:${s.decl}:${s.table}`;

console.log("\n1. No new browser-reachable read of a whole students or legacyMirror table");
const files = readConvex();
const sites = scan(files);
const flagged = sites.filter((s) => s.reachable && !s.bounded);
const unlisted = flagged.filter((s) => !ALLOWED[sigOf(s)]);
check("every unbounded read a browser can reach is on the allowlist",
  unlisted.length === 0,
  unlisted.map((s) => `${s.file}:${s.line} ${s.decl} [${s.kind}] reads ${s.table} via ${s.how}`).join("\n        ") +
  (unlisted.length ? "\n        Narrow it with an index range, page it, or add it to ALLOWED with why and what replaces it." : ""));
const perSig = new Map();
for (const s of flagged) perSig.set(sigOf(s), (perSig.get(sigOf(s)) || 0) + 1);
check("and each listed function still holds exactly one such read (a second one is new)",
  [...perSig].every(([, n]) => n === 1), [...perSig].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`).join(", "));
const stale = Object.keys(ALLOWED).filter((k) => !perSig.has(k));
check("no allowlist entry is stale (a reader that was fixed must leave the list)",
  stale.length === 0, stale.join(", "));
check("the scan actually sees reads (it found the known internal whole-table tools too)",
  sites.length > 100 && sites.some((s) => !s.reachable && !s.bounded && s.file === "legacyPurge.ts"),
  String(sites.length));

console.log("\n2. The two reads this step removed stay removed");
{
  const rev = sites.filter((s) => s.file === "cashReversal.ts" && s.reachable);
  check("the reversal panel and the Reverse button read no student or ledger table unbounded",
    rev.length >= 3 && rev.every((s) => s.bounded), rev.map((s) => `${s.decl} ${s.table} ${s.how}`).join("; "));
  const load = blankComments(files["appData.ts"]);
  const body = load.slice(load.indexOf("export const load = query("), load.indexOf("export const freshness"));
  check("appData:load reads no whole roster: enrolment is one indexed lookup per student",
    !/query\(\s*"psRoster"\s*\)\s*\.collect\(/.test(body) && /enrolledByIndex\(ctx, studentRows\)/.test(body));
  const helper = load.slice(load.indexOf("export async function enrolledByIndex"), load.indexOf("export const load"));
  check("  ...by_studentNumber, first(): the same lookup leaderboard.ts makes",
    /withIndex\("by_studentNumber"[\s\S]*?\.first\(\)/.test(helper));
}

console.log("\n3. The scan has teeth");
{
  const planted = { ...files, "appData.ts": files["appData.ts"].replace(
    "export const load = query({\n  args: {},\n  handler: async (ctx) => {\n",
    "export const load = query({\n  args: {},\n  handler: async (ctx) => {\n    const extra = await ctx.db.query(\"legacyMirror\").withIndex(\"by_doc\").collect();\n") };
  const caught = scan(planted).filter((s) => s.reachable && !s.bounded && !ALLOWED[sigOf(s)]);
  check("a whole-mirror read planted in appData:load is caught",
    caught.some((s) => s.file === "appData.ts" && s.table === "legacyMirror"));

  const viaHelper = { ...files, "cashReversal.ts": files["cashReversal.ts"].replace(
    /async function findStudent\(\n/, "async function findStudentOld(ctx: any) { return await ctx.db.query(\"students\").take(2000); }\nasync function findStudent(\n")
    .replace("const { student, ambiguous } = await findStudent(ctx, studentId);", "await findStudentOld(ctx); const { student, ambiguous } = await findStudent(ctx, studentId);") };
  const caught2 = scan(viaHelper).filter((s) => s.reachable && !s.bounded && !ALLOWED[sigOf(s)]);
  check("a whole-students take(2000) in a helper the reversal list calls is caught",
    caught2.some((s) => s.decl === "findStudentOld"), JSON.stringify(caught2.map((s) => s.decl)));

  const viaInternal = { ...files, "leaderboard.ts": files["leaderboard.ts"] +
    "\nexport const sneaky = internalQuery({ args: {}, handler: async (ctx) => await ctx.db.query(\"students\").collect() });\n" +
    "export const front = action({ args: {}, handler: async (ctx) => await ctx.runQuery(internal.leaderboard.sneaky, {}) });\n" };
  const caught3 = scan(viaInternal).filter((s) => s.reachable && !s.bounded && !ALLOWED[sigOf(s)]);
  check("an internal whole-table read that a public action runs is caught",
    caught3.some((s) => s.decl === "sneaky"), JSON.stringify(caught3.map((s) => s.decl)));

  // A filter with no index range reads until it matches: on no match, the
  // whole table. first(), unique() and take(1) must not launder it.
  const filtered = { ...files,
    "appData.ts": files["appData.ts"].replace(
      "export const load = query({\n  args: {},\n  handler: async (ctx) => {\n",
      "export const load = query({\n  args: {},\n  handler: async (ctx) => {\n    const nobody = await ctx.db.query(\"students\").filter((q) => q.eq(q.field(\"legacyId\"), \"nobody\")).first();\n"),
    "leaderboard.ts": files["leaderboard.ts"] +
      "\nexport const sneakyTake = query({ args: {}, handler: async (ctx) => await ctx.db.query(\"legacyMirror\").filter((q) => q.eq(q.field(\"doc\"), \"x\")).take(1) });\n" +
      "export const sneakyUnique = query({ args: {}, handler: async (ctx) => await ctx.db.query(\"students\").withIndex(\"by_legacyId\").filter((q) => q.eq(q.field(\"grade\"), \"9\")).unique() });\n" };
  const scannedF = scan(filtered);
  const caughtF = scannedF.filter((s) => s.reachable && !s.bounded && !ALLOWED[sigOf(s)]);
  // appData:load already holds its one allowed students read, so the planted
  // one shows as a second unbounded read there (check 1's "exactly one").
  const inLoad = scannedF.filter((s) => s.file === "appData.ts" && s.decl === "load" &&
    s.table === "students" && s.reachable && !s.bounded);
  check("a whole-table filter() ending in first(), take(1) or unique() is caught",
    inLoad.length === 2 && inLoad.some((s) => /filter\(\)\.first/.test(s.how)) &&
    caughtF.some((s) => s.decl === "sneakyTake") && caughtF.some((s) => s.decl === "sneakyUnique"),
    JSON.stringify(caughtF.concat(inLoad).map((s) => `${s.decl} ${s.how}`)));
  const narrowedF = { ...files, "leaderboard.ts": files["leaderboard.ts"] +
    "\nexport const oneWeek = query({ args: {}, handler: async (ctx) => await ctx.db.query(\"legacyMirror\").withIndex(\"by_doc_collection\", (q) => q.eq(\"doc\", \"x\").eq(\"collection\", \"y\")).filter((q) => q.eq(q.field(\"key\"), \"k\")).first() });\n" };
  const okF = scan(narrowedF).filter((s) => s.decl === "oneWeek");
  check("  ...while a filter inside an eq index range stays bounded",
    okF.length === 1 && okF[0].reachable && okF[0].bounded, JSON.stringify(okF));

  const commented = { ...files, "leaderboard.ts": files["leaderboard.ts"] +
    "\n// const x = await ctx.db.query(\"students\").collect();\n/* await ctx.db.query(\"legacyMirror\").collect(); */\n" };
  check("a read written in a comment is not a read",
    scan(commented).filter((s) => s.file === "leaderboard.ts").length === sites.filter((s) => s.file === "leaderboard.ts").length);

  const narrowed = { ...files, "appData.ts": files["appData.ts"].replace(
    "export const load = query({\n  args: {},\n  handler: async (ctx) => {\n",
    "export const load = query({\n  args: {},\n  handler: async (ctx) => {\n    const one = await ctx.db.query(\"legacyMirror\").withIndex(\"by_doc_collection\", (q) => q.eq(\"doc\", \"x\").eq(\"collection\", \"y\")).collect();\n") };
  const planted2 = scan(narrowed).filter((s) => s.file === "appData.ts" && s.table === "legacyMirror");
  check("one week by index is bounded and passes",
    planted2.length === 1 && planted2[0].reachable && planted2[0].bounded, JSON.stringify(planted2));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
