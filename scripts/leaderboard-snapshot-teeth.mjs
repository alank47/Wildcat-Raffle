// TEETH for the leaderboard's stored copy: every guard's test must FAIL when the guard is broken. Run: npm test
//
// A test that still passes with its guard taken out proves nothing. So this
// copies the code and the tests into a scratch folder (never touching the
// repo), breaks ONE guard at a time -- each break below is the plausible
// mistake, written out -- runs the test that is meant to catch it, and
// requires that exact named check to print FAIL. Before any break, every
// named check must PASS on the unbroken copy, so a renamed or deleted check
// cannot make a break look caught.
//
// An anchor must appear exactly once in its file. If the code moves and an
// anchor no longer matches, this fails loudly rather than skipping the case.
// (The same runner as scripts/perfect-day-teeth.mjs and reflection-teeth.mjs.)
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOARD = "convex/leaderboard.ts";
const RANK = "convex/leaderboardRules.ts";
const SNAP = "convex/leaderboardSnapshot.ts";
const RULES = "convex/leaderboardSnapshotRules.ts";
const RANK_TEST = "convex/leaderboardRules.test.mjs";
const RULES_TEST = "convex/leaderboardSnapshotRules.test.mjs";
const E2E = "leaderboard-snapshot.test.mjs";

const CASES = [
  // ---- the read path
  { guard: "the handler always goes live", file: BOARD, test: E2E,
    from: "const rows = (await snapshotRows(ctx, me)) ?? (await liveBoardRows(ctx));",
    to: "const rows = await liveBoardRows(ctx);",
    mustFail: "WITH THE COPY SERVED, A PORTAL OPEN READS ONE DOCUMENT AND ONE ROSTER ROW, NO STUDENTS" },
  { guard: "the overlay keeps the stored figure for the viewer", file: RANK, test: RANK_TEST,
    from: "    students[at] = viewer.row;", to: "    students[at] = snap.rows[at];",
    mustFail: "the viewer's own changes since the build give the live answer (earned, zeroed, left, regraded, renamed)" },
  { guard: "Date.now() in leaderboard.ts (a clock inside a cached query)", file: BOARD, test: E2E,
    from: "    const me = await requireStudentSelf(ctx);\n", to: "    const me = await requireStudentSelf(ctx);\n    const asOf = Date.now();\n",
    mustFail: "leaderboard.ts has no clock" },

  // ---- what the copy holds
  { guard: "compactStudent drops grade", file: RANK, test: RANK_TEST,
    from: '  if (typeof raw.grade === "string") row.grade = raw.grade;\n', to: "",
    mustFail: "THE COPY RANKS EVERY VIEWER EXACTLY AS THE LIVE READ: every band and topN" },
  { guard: "names are kept on zero and unknown rows", file: RANK, test: RANK_TEST,
    from: "  if (amount !== null && amount > 0) {\n", to: "  if (true) {\n",
    mustFail: "rows with zero or unknown earnings hold no names" },
  { guard: "compactStudent changes and the version does not", file: RANK, test: RANK_TEST,
    from: "  const id = studentIdOf(raw);\n  if (!enrolled) return { id, enrolled: false };",
    to: "  const id = String(studentIdOf(raw));\n  if (!enrolled) return { id, enrolled: false };",
    mustFail: "the copy's version is pinned to compactStudent: change one, change both" },

  // ---- the build
  { guard: "compactPage reads every student in one collect", file: SNAP, test: E2E,
    from: 'const page = await ctx.db.query("students").paginate({ cursor: cursor ?? null, numItems: 50 });\n    const rows: SnapRow[] = [];',
    to: 'const page = { page: await ctx.db.query("students").collect(), continueCursor: "", isDone: true };\n    const rows: SnapRow[] = [];',
    mustFail: "a build reads students only in pages of 50, never one collect" },
  { guard: "write skips the lease check", file: SNAP, test: E2E,
    from: 'if (!lease || lease.runId !== a.runId) return { ok: false, why: "not-the-lease" };',
    to: 'if (!lease) return { ok: false, why: "not-the-lease" };',
    mustFail: "write refuses a run that does not hold the lease, and writes nothing" },
  { guard: "write keeps rows whatever version of compactStudent made them", file: SNAP, test: E2E,
    from: "if (!(pv.length > 0 && pv.every((x) => x === LEADERBOARD_SNAPSHOT_VERSION))) {",
    to: "if (false) {",
    mustFail: "a build whose pages were made by another version of compactStudent is not kept (a deploy landed mid-build)" },
  { guard: "the roster fingerprint is ignored", file: SNAP, test: E2E,
    from: "const rosterSteady = fp0.oldest === fp1.oldest && fp0.newest === fp1.newest && fp0.syncAt === fp1.syncAt;",
    to: "const rosterSteady = true;",
    mustFail: "a roster replace during the build: refused, the previous copy keeps serving" },
  { guard: "the fingerprint takes any syncRuns row as the last sync", file: SNAP, test: E2E,
    from: "    const run = runs.find((r) => {", to: "    const run = runs[0];\n    const unused = runs.find((r) => {",
    mustFail: "a hall-pass row or a kept-roster sync in syncRuns is not a newer sync: a half-cleared roster is still held" },
  { guard: "a public query is added to leaderboardSnapshot.ts", file: SNAP, test: E2E,
    from: 'import { internalAction, internalMutation, internalQuery } from "./_generated/server";',
    to: 'import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";\n' +
      'export const peek = query({ args: {}, handler: async (ctx: any) => await ctx.db.query("leaderboardSnapshots").first() });',
    mustFail: "leaderboardSnapshot.ts exports only internal functions" },
  // ---- the kill switch finds the copy by name (review, 2026-10-13)
  { guard: "configure patches only the copy the state row remembers", file: SNAP, test: E2E,
    from: "(relinkCopy says why).\n    const docs = await relinkCopy(ctx, state);",
    to: "(relinkCopy says why).\n    const docs = (await relinkCopy(ctx, { ...state })).filter((d) => String(d._id) === state.snapshotId);",
    mustFail: "configure off stops serving the copy even when the state row lost track of it" },
  { guard: "the tick never looks for a copy the state row lost", file: SNAP, test: E2E,
    from: "  if (!state.snapshotId) {\n    const docs = await relinkCopy(ctx, state);",
    to: "  if (false) {\n    const docs = await relinkCopy(ctx, state);",
    mustFail: "with both appState rows deleted (which reads as off), the next tick finds the copy and stops serving it" },
  { guard: "live without a clean compare", file: SNAP, test: E2E,
    from: 'if (next.mode === "live" && prev.mode !== "live" && a.acceptWithoutCompare !== true) {',
    to: "if (false) {",
    mustFail: "configure live is refused without a clean compare on record" },
  { guard: "the live gate reads the last compare of any kind (a fresh one hides the logic one)", file: SNAP, test: E2E,
    from: "R.liveRefusal(state.lastLogicCompare, nowIso)", to: "R.liveRefusal(state.lastCompare, nowIso)",
    mustFail: "  ...after which live is allowed, even with a fresh compare run since (the runbook's order)" },

  // ---- the rules
  { guard: "a logic compare of an older copy format unlocks live", file: RULES, test: RULES_TEST,
    from: "  if (c.version !== LEADERBOARD_SNAPSHOT_VERSION) {", to: "  if (false) {",
    mustFail: "  ...but not on a logic compare made by another version of the copy (a deploy changed it since)" },
  { guard: "13:03 UTC is allowed (a build during the roster replace)", file: RULES, test: RULES_TEST,
    from: "  return inside(13 * 60, 13 * 60 + 15) || inside(13 * 60 + 25, 14 * 60) ||",
    to: "  return inside(13 * 60 + 25, 14 * 60) ||",
    mustFail: "UTC 13:03 and 19:03: no build" },
  { guard: "the drop guard is removed", file: RULES, test: RULES_TEST,
    from: '  if (drop <= Math.max(15, 0.03 * prev.enrolled)) return { verdict: "accept", why: "steady" };',
    to: '  return { verdict: "accept", why: "steady" };',
    mustFail: "a big enrolment drop with no new sync is held, not kept" },
  { guard: "a fall in the row count is refused for good (one hand-deleted student wedges the copy)", file: RULES, test: E2E,
    from: "  if (rows < prev.rows) {\n    if (p && p.rows === rows",
    to: '  if (rows < prev.rows) return { verdict: "refuse", code: "fewer-rows" } as any;\n  if (false) {\n    if (p && p.rows === rows',
    mustFail: "a student row deleted by hand: the build is held, and one 20 minutes on that agrees is kept" },
  { guard: "rows changed since the build compared by JSON.stringify (key order counts)", file: RULES, test: RULES_TEST,
    from: "snapRowKey(row) !== snapRowKey(stored.rows[i])", to: "JSON.stringify(row) !== JSON.stringify(stored.rows[i])",
    mustFail: "rowsChangedSinceBuild ignores key order: 0 right after a build, 1 after one award" },
  { guard: "a failing copy is never stopped", file: RULES, test: RULES_TEST,
    from: '  if (failing !== null && failing >= config.failGraceMinutes) return "failing";\n', to: "",
    mustFail: "in live, a failure 60 minutes old marks it failing" },
];

// A builder's shortcut, never set in npm test: LEADERBOARD_TEETH_ONLY=<text>
const ONLY = process.env.LEADERBOARD_TEETH_ONLY || "";
const RUN = ONLY ? CASES.filter((c) => c.test.includes(ONLY) || c.guard.includes(ONLY)) : CASES;

const COPY_EXT = /\.(mjs|js|ts|json|html|css|md)$/;
function copyTree(from, to, top = true) {
  for (const name of readdirSync(from)) {
    if (name === "node_modules" || name === ".git" || name === ".claude" || name.startsWith(".")) continue;
    const src = join(from, name);
    const st = statSync(src);
    if (st.isDirectory()) {
      if (top && !["convex", "scripts", "docs"].includes(name)) continue;
      copyTree(src, join(to, name), false);
    } else if (COPY_EXT.test(name)) {
      cpSync(src, join(to, name));
    }
  }
}

const scratch = mkdtempSync(join(process.env.LEADERBOARD_TEETH_DIR || tmpdir(), "leaderboard-teeth-"));
let bad = 0;
const say = (s) => console.log(s);
try {
  copyTree(ROOT, scratch);
  symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"), "dir");
  const run = (test) => spawnSync(process.execPath, [join(scratch, test)], { cwd: scratch, encoding: "utf8", timeout: 120_000 });
  const lines = (r) => String(r.stdout || "").split("\n");
  const has = (r, verdict, name) => lines(r).some((l) => l === `  ${verdict}  ${name}` || l.startsWith(`  ${verdict}  ${name}  (`));

  say("\nTHE UNBROKEN COPY: every named check passes\n");
  for (const test of [...new Set(RUN.map((c) => c.test))]) {
    const r = run(test);
    const missing = RUN.filter((c) => c.test === test && !has(r, "PASS", c.mustFail));
    if (r.status !== 0 || missing.length) {
      bad++;
      say(`  FAIL  ${test} unbroken: exit ${r.status}; checks not passing: ${missing.map((c) => JSON.stringify(c.mustFail)).join(", ") || "none"}`);
      if (r.stderr) say(String(r.stderr).slice(0, 800));
    } else {
      say(`  PASS  ${test} passes unbroken`);
    }
  }

  say("\nEACH GUARD BROKEN IN TURN: its check must fail\n");
  for (const c of RUN) {
    const path = join(scratch, c.file);
    const original = readFileSync(path, "utf8");
    const at = original.indexOf(c.from);
    if (at < 0 || original.indexOf(c.from, at + 1) >= 0) {
      bad++;
      say(`  FAIL  ${c.guard}: anchor not found exactly once in ${c.file}`);
      continue;
    }
    writeFileSync(path, original.slice(0, at) + c.to + original.slice(at + c.from.length));
    try {
      const r = run(c.test);
      if (r.status !== 0 && has(r, "FAIL", c.mustFail)) {
        say(`  PASS  ${c.guard}  ->  "${c.mustFail}" fails`);
      } else {
        bad++;
        say(`  FAIL  ${c.guard}: "${c.mustFail}" did not fail (exit ${r.status})`);
        if (r.status !== 0 && !has(r, "FAIL", c.mustFail)) say(String(r.stderr || "").slice(0, 400));
      }
    } finally {
      writeFileSync(path, original);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${RUN.length - Math.min(bad, RUN.length)} of ${RUN.length} breaks caught${ONLY ? ` (only "${ONLY}")` : ""}${bad ? `; ${bad} problem(s)` : ""}\n`);
if (bad) process.exit(1);
