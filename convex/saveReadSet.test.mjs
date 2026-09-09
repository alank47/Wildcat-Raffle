// A save reads only the rows it is sent. Run: npm test
//
// WHY THIS FILE EXISTS. appData:save used to collect() the whole students
// table (734 rows) inside the mutation before patching a handful. A Convex
// mutation is retried if any row it READ was written by a mutation that
// committed first, so every teacher's save conflicted with every other
// teacher's save by construction. On 2026-09-08, with forty staff about to
// start, saves were "slow, or never landed". Reading only the sent rows is
// the fix, and this file pins that the lookups are the only reads.
//
// The lookup helpers are transpiled out of the shipped appData.ts with the
// real TypeScript compiler and run against a fake db that counts what it is
// asked for, the same technique as mergeSlice.test.mjs.
import { readFileSync } from "node:fs";
import ts from "typescript";

const src = readFileSync(new URL("./appData.ts", import.meta.url), "utf8");
let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

function lift(name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in appData.ts`);
  const end = src.indexOf("\n}\n", start) + 3;
  return ts.transpileModule(src.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}
const lookupStudents = new Function(lift("lookupStudents") + "\nreturn lookupStudents;")();
const lookupTeachers = new Function(lift("lookupTeachers") + "\nreturn lookupTeachers;")();

/** A db that answers index lookups from a table and counts every read. */
function fakeDb(tables) {
  const stats = { indexLookups: 0, gets: 0, collects: 0 };
  const eqOf = (fn) => {
    const calls = [];
    fn({ eq: (field, value) => { calls.push([field, value]); return { eq: (f2, v2) => { calls.push([f2, v2]); return {}; } }; } });
    return calls;
  };
  const db = {
    query: (table) => ({
      withIndex: (_name, fn) => {
        const eqs = eqOf(fn);
        return {
          first: async () => {
            stats.indexLookups++;
            return (tables[table] || []).find((r) => eqs.every(([f, v]) => r[f] === v)) ?? null;
          },
          collect: async () => { stats.collects++; return (tables[table] || []).slice(); },
        };
      },
      collect: async () => { stats.collects++; return (tables[table] || []).slice(); },
    }),
    normalizeId: (table, key) =>
      (tables[table] || []).some((r) => r._id === key) ? key : null,
    get: async (id) => {
      stats.gets++;
      for (const rows of Object.values(tables)) {
        const r = rows.find((x) => x._id === id);
        if (r) return r;
      }
      return null;
    },
  };
  return { ctx: { db }, stats };
}

const students = [
  { _id: "s1", legacyId: "12217", studentNumber: "12217", firstName: "Test" },
  { _id: "s2", studentNumber: "10005", firstName: "NoLegacy" },
  { _id: "s3", legacyId: "L3", studentNumber: "30003", firstName: "Both" },
];
const teachers = [
  { _id: "t1", legacyId: "T007", name: "Leo" },
  { _id: "t2", name: "Laura" },
];

console.log("\nThe save reads the rows it was sent and nothing else");
{
  const { ctx, stats } = fakeDb({ students, teachers });
  const rows = await lookupStudents(ctx, [{ id: "12217" }, { id: "L3" }]);
  check("both sent students are found", rows.length === 2 && rows.map((r) => r._id).sort().join() === "s1,s3");
  check("with one index lookup each when legacyId matches", stats.indexLookups === 2, String(stats.indexLookups));
  check("and no collect() of the table", stats.collects === 0);
}
{
  const { ctx, stats } = fakeDb({ students, teachers });
  const rows = await lookupStudents(ctx, [{ studentNumber: "10005" }]);
  check("a student with no legacyId is still found by studentNumber", rows.length === 1 && rows[0]._id === "s2");
  check("at the cost of two lookups, not a table scan", stats.indexLookups === 2 && stats.collects === 0);
}
{
  const { ctx } = fakeDb({ students, teachers });
  const rows = await lookupStudents(ctx, [{ id: "nobody" }, { id: "" }, {}]);
  check("unknown, blank and missing keys find nothing, and do not throw", rows.length === 0);
}
{
  const { ctx } = fakeDb({ students, teachers });
  const rows = await lookupStudents(ctx, [{ id: "12217" }, { studentNumber: "12217" }]);
  check("the same row reached by two keys is returned once", rows.length === 1);
}
{
  const { ctx, stats } = fakeDb({ students, teachers });
  const rows = await lookupTeachers(ctx, [{ id: "t2" }, { id: "T007" }]);
  check("staff are found by row id or by Firestore-era id", rows.length === 2 && rows.map((r) => r._id).sort().join() === "t1,t2");
  check("without a table scan", stats.collects === 0);
}

console.log("\nThe handler itself no longer scans either table");
{
  const handler = src.slice(src.indexOf("export const save = mutation({"));
  check("no collect() on students in save", !/query\("students"\)\s*\.collect\(\)/.test(handler));
  check("no collect() on teachers in save", !/query\("teachers"\)\s*\.collect\(\)/.test(handler));
  check("students go through lookupStudents", /await lookupStudents\(ctx, args\.students\)/.test(handler));
  check("teachers go through lookupTeachers", /await lookupTeachers\(ctx, args\.teachers\)/.test(handler));
  check("planSave is still the planner, unchanged", /planSave\(rows, args\.students, STUDENT_WRITABLE/.test(handler));
  const schema = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
  check("students has the by_legacyId index the lookup relies on",
    /\.index\("by_studentNumber", \["studentNumber"\]\)[\s\S]{0,300}\.index\("by_legacyId", \["legacyId"\]\)/.test(schema));
  check("and so does teachers",
    (schema.match(/\.index\("by_legacyId", \["legacyId"\]\)/g) || []).length === 2);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
