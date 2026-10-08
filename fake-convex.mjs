// A fake Convex, for running the SHIPPED server functions in tests.
//
// WHY (2026-10-08). The Reflection Room's reader, tick and roster guard make
// their decisions inside Convex mutations: which tardies a read adds, whether
// a stale run is fenced out, whether a list is made. A test of the pure rules
// alone would pass while the mutation that calls them looked a row up on the
// wrong index, forgot to release the lease, or wrote half a freeze. So the
// shipped .ts files are transpiled as they are and run here against:
//
//   makeDb(schemaSrc)   an in-memory database that knows every index the real
//                       schema declares, keeps index order, refuses an index
//                       the table does not have and an eq/range out of field
//                       order (the real one throws on both), returns copies
//                       (a handler editing a row it read changes nothing),
//                       treats a patch to undefined as removing the field, and
//                       rolls a mutation's writes back if it throws;
//   loadConvex()        the .ts modules, transpiled into a scratch folder with
//                       Convex's generated wrappers stubbed (a function is its
//                       own definition object, so `.handler` is callable) and
//                       `internal.x.y` a reference that names its path;
//   runtime()           runQuery / runMutation / runAction by that path, and
//                       a scheduler that records what was booked, for the test
//                       to run when it chooses;
//   clock               a settable "now" for Date.now() and new Date(), so a
//                       test of 11:45 on a Tuesday does not depend on today.
//
// Nothing here talks to a real deployment. The scratch folder is removed by
// cleanup(), which every test calls in a finally.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// ------------------------------------------------------------------- clock
const RealDate = Date;
let fakeNow = null;
class FakeDate extends RealDate {
  constructor(...a) {
    if (a.length === 0 && fakeNow !== null) super(fakeNow);
    else super(...a);
  }
  static now() { return fakeNow === null ? RealDate.now() : fakeNow; }
}
globalThis.Date = FakeDate;
export const clock = {
  set(iso) { fakeNow = typeof iso === "number" ? iso : RealDate.parse(iso); return new RealDate(fakeNow).toISOString(); },
  advance(ms) { fakeNow = (fakeNow === null ? RealDate.now() : fakeNow) + ms; return new RealDate(fakeNow).toISOString(); },
  real() { fakeNow = null; },
  get iso() { return new RealDate(FakeDate.now()).toISOString(); },
};

// ------------------------------------------------------------------- schema
/** table -> { indexName: [fields] }, read from the real schema.ts. */
export function parseIndexes(schemaSrc) {
  const out = {};
  const starts = [...schemaSrc.matchAll(/^ {2}(\w+): defineTable\(/gm)];
  for (let i = 0; i < starts.length; i++) {
    const seg = schemaSrc.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : undefined);
    const idx = {};
    for (const m of seg.matchAll(/\.index\(\s*"(\w+)",\s*\[([^\]]*)\]\s*\)/g)) {
      idx[m[1]] = [...m[2].matchAll(/"(\w+)"/g)].map((x) => x[1]);
    }
    out[starts[i][1]] = idx;
  }
  return out;
}

// Convex's order of values: undefined < null < number < boolean < string < array < object.
const rank = (x) => (x === undefined ? 0 : x === null ? 1 : typeof x === "number" ? 3 : typeof x === "boolean" ? 4
  : typeof x === "string" ? 5 : Array.isArray(x) ? 7 : 8);
export function compareValues(a, b) {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 3) return a - b;
  if (ra === 4) return Number(a) - Number(b);
  if (ra === 5) return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

const clone = (x) => (x === undefined ? undefined : structuredClone(x));
const stripUndefined = (doc) => {
  const out = {};
  for (const [k, val] of Object.entries(doc)) if (val !== undefined) out[k] = clone(val);
  return out;
};

export function makeDb(schemaSrc) {
  const indexes = parseIndexes(schemaSrc);
  const tables = {};
  let seq = 0;
  const rowsOf = (t) => {
    if (!indexes[t]) throw new Error(`fake Convex: no table "${t}" in schema.ts`);
    return tables[t] || (tables[t] = []);
  };
  const find = (id) => {
    for (const [t, rows] of Object.entries(tables)) {
      const i = rows.findIndex((r) => r._id === id);
      if (i >= 0) return { t, rows, i };
    }
    return null;
  };

  function query(t) {
    rowsOf(t);
    let fields = [];
    const conds = [];
    let order = "asc";
    const rows = () => {
      const got = rowsOf(t).filter((r) => conds.every((c) => c(r)));
      got.sort((a, b) => {
        for (const f of fields) {
          const c = compareValues(a[f], b[f]);
          if (c) return c;
        }
        return a._creationTime - b._creationTime;
      });
      if (order === "desc") got.reverse();
      return got.map(clone);
    };
    const b = {
      withIndex(name, f) {
        if (name === "by_creation_time") fields = [];
        else if (!indexes[t][name]) throw new Error(`fake Convex: table "${t}" has no index "${name}"`);
        else fields = indexes[t][name];
        let at = 0;
        let rangeField = null;
        const range = (op) => (k, val) => {
          if (rangeField === null) {
            if (fields[at] !== k) throw new Error(`fake Convex: ${t}.${name} range on "${k}", expected "${fields[at]}"`);
            rangeField = k;
          } else if (rangeField !== k) {
            throw new Error(`fake Convex: ${t}.${name} second range on "${k}", after "${rangeField}"`);
          }
          conds.push((r) => {
            const c = compareValues(r[k], val);
            return op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0;
          });
          return q;
        };
        const q = {
          eq(k, val) {
            if (rangeField !== null || fields[at] !== k) {
              throw new Error(`fake Convex: ${t}.${name} eq on "${k}" out of index order (${fields.join(", ")})`);
            }
            at++;
            conds.push((r) => compareValues(r[k], val) === 0);
            return q;
          },
          gt: range("gt"), gte: range("gte"), lt: range("lt"), lte: range("lte"),
        };
        if (f) f(q);
        return b;
      },
      order(o) { order = o; return b; },
      filter() { throw new Error("fake Convex: .filter() is not supported here; read by an index"); },
      async take(n) { return rows().slice(0, n); },
      async collect() { return rows(); },
      async first() { return rows()[0] ?? null; },
      async unique() {
        const r = rows();
        if (r.length > 1) throw new Error(`fake Convex: unique() on ${t} found ${r.length}`);
        return r[0] ?? null;
      },
      async paginate({ numItems, cursor }) {
        const all = rows();
        const from = cursor ? Number(cursor) : 0;
        const page = all.slice(from, from + numItems);
        const next = from + page.length;
        return { page, isDone: next >= all.length, continueCursor: String(next) };
      },
    };
    return b;
  }

  const db = {
    query,
    async get(id) { const f = find(id); return f ? clone(f.rows[f.i]) : null; },
    async insert(t, doc) {
      const _id = `${t}:${++seq}`;
      rowsOf(t).push({ ...stripUndefined(doc), _id, _creationTime: seq });
      return _id;
    },
    async patch(id, fields) {
      const f = find(id);
      if (!f) throw new Error("fake Convex: patch of a missing document " + id);
      const row = f.rows[f.i];
      for (const [k, val] of Object.entries(fields)) {
        if (k === "_id" || k === "_creationTime") continue;
        if (val === undefined) delete row[k];
        else row[k] = clone(val);
      }
    },
    async replace(id, doc) {
      const f = find(id);
      if (!f) throw new Error("fake Convex: replace of a missing document " + id);
      const { _id, _creationTime } = f.rows[f.i];
      f.rows[f.i] = { ...stripUndefined(doc), _id, _creationTime };
    },
    async delete(id) {
      const f = find(id);
      if (f) f.rows.splice(f.i, 1);
    },
  };
  return {
    db, tables, indexes,
    rows: (t) => (tables[t] || []).map(clone),
    snapshot: () => structuredClone(tables),
    restore: (snap) => { for (const k of Object.keys(tables)) delete tables[k]; Object.assign(tables, structuredClone(snap)); },
  };
}

// ------------------------------------------------------------------- modules
const SERVER_STUB = `
const def = (kind) => (d) => ({ ...(typeof d === "function" ? { handler: d } : d), _kind: kind });
export const query = def("query");
export const mutation = def("mutation");
export const action = def("action");
export const internalQuery = def("internalQuery");
export const internalMutation = def("internalMutation");
export const internalAction = def("internalAction");
export const httpAction = def("httpAction");
`;
const API_STUB = `
const ref = (path) => new Proxy({}, {
  get: (_, k) => (k === "__path" ? path : typeof k === "symbol" || k === "then" ? undefined : ref(path ? path + "." + String(k) : String(k))),
});
export const internal = ref("");
export const api = ref("");
export const components = {};
`;

/**
 * Transpile convex/<name>.ts (and every relative import it pulls in) into a
 * scratch folder and import them. `baseUrl` is the repo root (the test's own
 * folder), so the teeth script's broken copy loads its own broken files.
 */
export async function loadConvex(baseUrl, names) {
  const dir = mkdtempSync(join(tmpdir(), "wc-fake-convex-"));
  mkdirSync(join(dir, "_generated"));
  writeFileSync(join(dir, "_generated", "server.mjs"), SERVER_STUB);
  writeFileSync(join(dir, "_generated", "api.mjs"), API_STUB);
  const valuesUrl = import.meta.resolve("convex/values");
  const built = new Set();
  const build = (name) => {
    if (built.has(name)) return;
    built.add(name);
    const src = readFileSync(new URL(`./convex/${name}.ts`, baseUrl), "utf8");
    let js = ts.transpileModule(src, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false },
    }).outputText;
    js = js
      .replace(/from\s+"convex\/values"/g, `from "${valuesUrl}"`)
      .replace(/from\s+"\.\/_generated\/(server|api)"/g, 'from "./_generated/$1.mjs"')
      .replace(/from\s+"\.\/(\w+)"/g, (_, n) => { build(n); return `from "./${n}.mjs"`; });
    writeFileSync(join(dir, `${name}.mjs`), js);
  };
  for (const n of names) build(n);
  const mods = {};
  for (const n of names) mods[n] = await import(pathToFileURL(join(dir, `${n}.mjs`)).href);
  return { mods, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ------------------------------------------------------------------- runtime
/**
 * ctx objects over one database, dispatching `internal.module.fn` by path.
 * Mutations are all-or-nothing, as Convex's are: a throw restores the tables.
 */
export function runtime(store, mods) {
  const jobs = [];
  let jobSeq = 0;
  const fnOf = (ref) => {
    const path = typeof ref === "string" ? ref : ref?.__path;
    const [mod, name] = String(path).split(".");
    const f = mods[mod]?.[name];
    if (!f?.handler) throw new Error(`fake Convex: no function ${path}`);
    return { f, path };
  };
  const scheduler = {
    async runAfter(ms, ref, args) {
      const id = `job:${++jobSeq}`;
      jobs.push({ id, at: Date.now() + ms, path: fnOf(ref).path, args: structuredClone(args ?? {}) });
      return id;
    },
    async runAt(at, ref, args) {
      const id = `job:${++jobSeq}`;
      jobs.push({ id, at: typeof at === "number" ? at : Date.parse(at), path: fnOf(ref).path, args: structuredClone(args ?? {}) });
      return id;
    },
    async cancel(id) { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); },
  };
  const qctx = { db: store.db };
  const mctx = { db: store.db, scheduler };
  const run = async (ref, args) => {
    const { f, path } = fnOf(ref);
    const a = structuredClone(args ?? {});
    if (/Mutation$|^mutation$/i.test(f._kind)) {
      const snap = store.snapshot();
      try { return structuredClone(await f.handler(mctx, a)); } catch (e) { store.restore(snap); throw e; }
    }
    if (/Query$|^query$/i.test(f._kind)) return structuredClone(await f.handler(qctx, a));
    if (/Action$|^action$/i.test(f._kind)) return f.handler(actx, a);
    throw new Error(`fake Convex: ${path} has no kind`);
  };
  const actx = { runQuery: run, runMutation: run, runAction: run, scheduler };
  return {
    run, jobs, scheduler, qctx, mctx, actx,
    /** Take (and remove) the booked jobs, optionally only those for one function. */
    take(path) {
      const out = [];
      for (let i = jobs.length - 1; i >= 0; i--) if (!path || jobs[i].path === path) out.unshift(...jobs.splice(i, 1));
      return out;
    },
  };
}
