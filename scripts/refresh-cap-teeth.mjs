// TEETH for the idle-refresh cap and the Cash Settings lock: every guard's test must FAIL when the guard is broken. Run: npm test
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
// (The same runner as scripts/perfect-day-teeth.mjs.)
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "script.js";
const SHAPE = "convex/appDataShape.ts";
const LEGACY = "convex/legacyData.ts";
const APPDATA = "convex/appData.ts";
const CAP = "refresh-cap.test.mjs";
const GATE = "cash-settings-gate.test.mjs";
const SERVER = "cash-settings-server.test.mjs";

const CASES = [
  // ---- part A: the idle refresh (cap-verdict.md section 5)
  { guard: "a background tab is skipped (the hidden-tab rule the verdict removed)", file: SITE, test: CAP,
    from: "            try { pullCashBehaviors(); }", to: "            if (document.hidden) return;\n            try { pullCashBehaviors(); }",
    mustFail: "A HIDDEN TAB STILL PULLS PRICES on every idle tick (5:30 and 6:00)" },
  { guard: "a background tab pulls prices but never reloads", file: SITE, test: CAP,
    from: "            if (!idleReloadDue(now)) return;\n", to: "            if (!idleReloadDue(now) || document.hidden) return;\n",
    mustFail: "A HIDDEN TAB RELOADS AFTER THE CAP, exactly as a visible one does" },
  { guard: "the price pull and the cache drops sit behind the cap", file: SITE, test: CAP,
    from: "            try { dropSisCaches(); } catch (error) { console.error('Auto-refresh cache drop failed:', error); }\n\n            if (!idleReloadDue(now)) return;\n",
    to: "            if (!idleReloadDue(now)) return;\n            try { dropSisCaches(); } catch (error) { console.error('Auto-refresh cache drop failed:', error); }\n",
    mustFail: "...and drops the attendance caches on every idle tick, before the cap" },
  { guard: "no cap: the roster is re-read on every idle tick (the bug)", file: SITE, test: CAP,
    from: "            return now - Math.max(_lastRosterLoadAt, _lastIdleReloadAttemptAt) >= capMs - IDLE_TICK_SLACK_MS;", to: "            return true;",
    mustFail: "NO RELOAD BEFORE THE CAP: idle 5-9.5 minutes, still only the boot load" },
  { guard: "the interval is measured strictly, so every one comes out a tick long", file: SITE, test: CAP,
    from: ">= capMs - IDLE_TICK_SLACK_MS;", to: ">= capMs;",
    mustFail: "...and set to 0.5, at every check (it behaved as 1)" },
  { guard: "a failed attempt does not count", file: SITE, test: CAP,
    from: "            _lastIdleReloadAttemptAt = now;\n", to: "",
    mustFail: "A FAILED ATTEMPT COUNTS: three tries in the idle stretch (10, 20, 30 minutes), not one per tick" },
  { guard: "a sign-in load is not recorded", file: SITE, test: CAP,
    from: "                const rows = fresh.install();\n                noteRosterLoaded();\n", to: "                const rows = fresh.install();\n",
    mustFail: "a sign-in load counts: the idle reload waits ten minutes from it, not from the boot" },
  { guard: "loadData's own load is not recorded", file: SITE, test: CAP,
    from: "                            // (typeof: the merge tests run this block on its own.)\n                            if (typeof noteRosterLoaded === 'function') noteRosterLoaded();\n",
    to: "                            // (typeof: the merge tests run this block on its own.)\n",
    mustFail: "A loadData LOAD COUNTS: it records the moment the roster went on screen" },
  { guard: "the cash-only re-read is not recorded", file: SITE, test: CAP,
    from: "                // need not pay for another one straight after it.\n                if (typeof noteRosterLoaded === 'function') noteRosterLoaded();\n",
    to: "                // need not pay for another one straight after it.\n",
    mustFail: "refreshCashFromServer records that it loaded" },
  { guard: "no collapse guard", file: SITE, test: CAP,
    from: "                if (!Number.isFinite(got) || got >= held * (1 - IDLE_COLLAPSE_FALL)) return true;", to: "                return true;",
    mustFail: "A COLLAPSED LOAD IS RELEASED, NOT INSTALLED: 100 enrolled stay on screen, the same records" },
  { guard: "a declined load is not released (holds the cash journal open)", file: SITE, test: CAP,
    from: "                if (!wanted) {\n                    fresh.release();\n", to: "                if (!wanted) {\n",
    mustFail: "...and released in the cash journal, so it holds nothing open" },
  { guard: "the retry is guarded again, so a real drop is refused for ever", file: SITE, test: CAP,
    from: "            const accept = isRetry ? null : (fresh) => {", to: "            const accept = (fresh) => {",
    mustFail: "THE RETRY'S ANSWER IS BELIEVED: a minute later, still 40, it is installed" },
  { guard: "no retry after a collapse (the short list waits a whole interval)", file: SITE, test: CAP,
    from: "                _idleCollapseRetryAt = Date.now() + IDLE_COLLAPSE_RETRY_MS;\n", to: "",
    mustFail: "a retry after the sync has finished installs the full roster" },
  { guard: "a collapse retry never expires (fires unguarded hours later)", file: SITE, test: CAP,
    from: "            if (_idleCollapseRetryAt > 0 && now - _idleCollapseRetryAt > IDLE_COLLAPSE_RETRY_MS) _idleCollapseRetryAt = 0;\n", to: "",
    mustFail: "A LATE RETRY IS GUARDED: idle again 45 minutes on, a short read is released, not installed unchecked" },
  { guard: "a newer roster leaves the collapse retry pending", file: SITE, test: CAP,
    from: "            // has nothing left to re-check (a released load never gets here).\n            _idleCollapseRetryAt = 0;\n",
    to: "            // has nothing left to re-check (a released load never gets here).\n",
    mustFail: "A NEWER ROSTER CANCELS A PENDING RETRY: after a sign-in load, nothing is read again a minute later" },
  { guard: "the server's dial is ignored", file: SITE, test: CAP,
    from: "            _idleReloadMinutes = idleReloadMinutesFrom(value);", to: "            void value;",
    mustFail: "THE SERVER DIAL CHANGES THE INTERVAL: at 2 minutes, 13 reloads in the idle stretch" },
  { guard: "the dial is not held to 0.5-60 minutes", file: SITE, test: CAP,
    from: "            return Math.min(IDLE_RELOAD_MAX_MINUTES, Math.max(IDLE_RELOAD_MIN_MINUTES, value));", to: "            return value;",
    mustFail: "a real number is held to 0.5-60 minutes" },
  { guard: "a nonsense dial is believed", file: SITE, test: CAP,
    from: "            if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return IDLE_RELOAD_DEFAULT_MINUTES;",
    to: "            if (value === null || value === undefined) return IDLE_RELOAD_DEFAULT_MINUTES;",
    mustFail: "nonsense is the default, never 'every tick'" },
  { guard: "student tabs run the idle refresh", file: SITE, test: CAP,
    from: "            if (!binId || isSyncing || !currentUser || timeSinceActivity", to: "            if (!binId || isSyncing || !(currentUser || currentStudent) || timeSinceActivity",
    mustFail: "STUDENT TABS NEVER CALL FRESHNESS, or the roster read, or the price pull" },
  { guard: "a failed roster load reports success", file: SITE, test: CAP,
    from: "                console.error(`[roster] Convex refresh after ${reason} failed:`, err.message);\n                return false;",
    to: "                console.error(`[roster] Convex refresh after ${reason} failed:`, err.message);\n                return true;",
    mustFail: "THE RESET REFUSES WHEN THE FRESH LOAD FAILS: no movement, no save, no audit entry" },
  { guard: "the reset charges the balances the tab holds", file: SITE, test: CAP,
    from: "            if (!(await refreshRosterFromConvex('reset', { redraw: false }))) {", to: "            if (false) {",
    mustFail: "THE RESET READS FRESH: each child is charged the server's $600, not the tab's $500" },

  // ---- part B: the screens
  { guard: "anyone may press Reset All", file: SITE, test: CAP,
    from: "            if (!canOpenSettings()) {\n                throw new Error('Only an administrator can reset every balance.');\n            }\n", to: "",
    mustFail: "A TEACHER CANNOT RESET: refused before the prompt, nothing read, moved or saved" },
  { guard: "anyone may close the year", file: SITE, test: GATE,
    from: "                throw new Error('Only an administrator can close the school year.');", to: "                void 0;",
    mustFail: "A TEACHER CANNOT CLOSE THE YEAR: refused before anything is worked out" },
  { guard: "the Cash nav is not gated as it is built (the bug as found)", file: SITE, test: GATE,
    from: "                        applyRoleGates(modeNavEl);\n", to: "",
    mustFail: "a reload (session restore): a teacher does NOT see Cash Settings or Sync PowerSchool" },
  { guard: "...nor when Cash is entered again after another mode", file: SITE, test: GATE,
    from: "                        applyRoleGates(modeNavEl);\n", to: "",
    mustFail: "a sign-in, then Discipline and back to Cash: a teacher does NOT see Cash Settings or Sync PowerSchool" },
  { guard: "a role change does not re-run the gates", file: SITE, test: GATE,
    from: "                            if (typeof applyRoleGates === 'function') applyRoleGates();\n", to: "",
    mustFail: "A DEMOTED ADMIN LOSES CASH SETTINGS at the next roster refresh" },
  { guard: "PBIS counted as an admin", file: SITE, test: GATE,
    from: "            return role === 'admin' || role === 'superadmin';", to: "            return role === 'admin' || role === 'superadmin' || role === 'pbis';",
    mustFail: "a reload (session restore): a pbis does NOT see Cash Settings or Sync PowerSchool" },
  { guard: "Settings opens for anyone who calls it", file: SITE, test: GATE,
    from: "            if (tabName === 'settings' && !canOpenSettings()) {", to: "            if (false) {",
    mustFail: "switchTab('settings') refuses a teacher, before anything moves" },
  { guard: "openCashSettings does not ask", file: SITE, test: GATE,
    from: "            if (!canOpenSettings()) {\n                console.warn('[settings] Cash Settings are for administrators; not opened for role ' +",
    to: "            if (false) {\n                console.warn('[settings] Cash Settings are for administrators; not opened for role ' +",
    mustFail: "a teacher calling openCashSettings or openSisSyncPanel opens nothing" },
  { guard: "the behaviour actions do not ask", file: SITE, test: GATE,
    from: "            if (canOpenSettings()) return true;\n", to: "            return true;\n",
    mustFail: "A TEACHER CANNOT CHANGE BEHAVIOURS: add, remove and Save Settings refuse, and nothing is saved" },
  { guard: "the drift panel builds Re-check for everyone", file: SITE, test: GATE,
    from: "            const recheck = canOpenSettings()", to: "            const recheck = true",
    mustFail: "the drift panel offers a teacher no Re-check button (the server refuses it)" },

  // ---- part B: the server
  { guard: "appData:save lets every role reset", file: APPDATA, test: SERVER,
    from: "historyCutoff, { mayReset: canChangeCashSettings((me as any)?.role) });", to: "historyCutoff, { mayReset: true });",
    mustFail: "A TEACHER'S RESET IS REFUSED: the balance stays $600, the movement is held as reserved_kind" },
  { guard: "the reset is told apart only by a behaviour on the movement (which the browser never sends)", file: SHAPE, test: SERVER,
    from: "    if (resetBarred && (resetIds.has(id) || isCashResetRow(m) ||", to: "    if (resetBarred && (isCashResetRow(m) ||",
    mustFail: "A CAMPUSAIDE'S RESET IS REFUSED: the balance stays $600, the movement is held as reserved_kind" },
  { guard: "the reset movement is never refused", file: SHAPE, test: SERVER,
    from: "    if (resetBarred && (resetIds.has(id) || isCashResetRow(m) || (pinnedAtZero && String(m.kind) === \"deduct\" && amount !== 0))) {\n      refused.push({ id, why: \"reserved_kind\" });\n      continue;\n    }\n", to: "",
    mustFail: "...a reset movement that names system_reset with no history row is refused just the same" },
  { guard: "a reset with no history row beside it (a former student) passes as a plain deduction", file: SHAPE, test: SERVER,
    from: " || (pinnedAtZero && String(m.kind) === \"deduct\" && amount !== 0)", to: "",
    mustFail: "A TEACHER'S RESET OF A FORMER STUDENT (NO HISTORY ROW) IS REFUSED: $300 stays, held as reserved_kind" },
  { guard: "one total at zero is taken for a reset (refuses a teacher's ordinary deduction)", file: SHAPE, test: SERVER,
    from: "[\"wildcatCashEarned\", \"wildcatCashSpent\", \"wildcatCashDeducted\"].every((f) => record?.[f] === 0);",
    to: "[\"wildcatCashEarned\", \"wildcatCashSpent\", \"wildcatCashDeducted\"].some((f) => record?.[f] === 0);",
    mustFail: "a teacher's deduction from a student whose totals were all zero still lands ($200 to $150)" },
  { guard: "the money path is not told the caller's role", file: SHAPE, test: SERVER,
    from: "    mayReset: !resetBarred,\n", to: "",
    mustFail: "A PBIS'S RESET IS REFUSED: the balance stays $600, the movement is held as reserved_kind" },
  { guard: "a refused reset's row is still added to the history", file: SHAPE, test: SERVER,
    from: "    const kept = resetBarred ? pruned.filter((r) => !isCashResetRow(r)) : pruned;", to: "    const kept = pruned;",
    mustFail: "...and a teacher's reset row is not added to the student's history" },
  { guard: "PBIS may reset", file: SHAPE, test: SERVER,
    from: "export const CASH_SETTINGS_ROLES = [\"admin\", \"superadmin\"] as const;", to: "export const CASH_SETTINGS_ROLES = [\"admin\", \"superadmin\", \"pbis\"] as const;",
    mustFail: "A PBIS'S RESET IS REFUSED: the balance stays $600, the movement is held as reserved_kind" },
  { guard: "mergeSlice inserts a teacher's reset row", file: LEGACY, test: SERVER,
    from: "      if (resetBarred && isCashResetRow(accepted.payload)) {", to: "      if (false) {",
    mustFail: "MERGESLICE REFUSES A TEACHER'S RESET ROW, and still takes the award beside it" },
  { guard: "mergeSlice lets a teacher's copy rewrite a stored reset row", file: LEGACY, test: SERVER,
    from: "        if (stored && resetBarred && (isCashResetRow(stored.payload) || isCashResetRow(r.payload))) {", to: "        if (false) {",
    mustFail: "...and never lets a teacher's newer copy rewrite an admin's stored reset row" },
  { guard: "mergeSlice adds a teacher's behaviour", file: LEGACY, test: SERVER,
    from: "      if (behaviorsBarred) {\n        refusedBehaviorEdits++;", to: "      if (false) {\n        refusedBehaviorEdits++;",
    mustFail: "A TEACHER CANNOT REPRICE OR ADD A BEHAVIOUR: both rows skipped and counted, nothing thrown" },
  { guard: "mergeSlice lets a teacher reprice a behaviour", file: LEGACY, test: SERVER,
    from: "        if (stored && behaviorsBarred) {", to: "        if (false) {",
    mustFail: "A TEACHER CANNOT REPRICE OR ADD A BEHAVIOUR: both rows skipped and counted, nothing thrown" },
  { guard: "the behaviour lock catches admins too", file: LEGACY, test: SERVER,
    from: "const behaviorsBarred = doc === \"secondary\" && collection === \"wildcatCashBehaviors\" && !mayChangeCash;",
    to: "const behaviorsBarred = doc === \"secondary\" && collection === \"wildcatCashBehaviors\";",
    mustFail: "an admin reprices and adds behaviours" },
  { guard: "saveSlice lets a teacher replace the behaviour list", file: LEGACY, test: SERVER,
    from: "    if (doc === \"secondary\" && collection === \"wildcatCashBehaviors\" && !canChangeCashSettings((me as any)?.role)) {", to: "    if (false) {",
    mustFail: "SAVESLICE WILL NOT LET A TEACHER REPLACE THE LIST (one call would delete every behaviour)" },
  { guard: "saveSlice inserts a teacher's reset row", file: LEGACY, test: SERVER,
    from: "      if (!canChangeCashSettings((me as any)?.role)) {\n        for (let i = fresh.length - 1;", to: "      if (false) {\n        for (let i = fresh.length - 1;",
    mustFail: "SAVESLICE REFUSES A TEACHER'S RESET ROW too, and takes the award" },
  { guard: "appData:load does not hand out the dial", file: APPDATA, test: SERVER,
    from: "      idleRefreshMinutes: idleRefreshMinutesOf(idleRow?.value),", to: "      idleRefreshMinutes: null,",
    mustFail: "setIdleRefresh sets it, and appData:load returns it" },
  { guard: "the setter stores any number", file: APPDATA, test: SERVER,
    from: "    const minutes = Math.min(IDLE_REFRESH_MAX, Math.max(IDLE_REFRESH_MIN, a.minutes));", to: "    const minutes = a.minutes;",
    mustFail: "held to 0.5 minutes at the fast end, as stored and as loaded" },
  { guard: "a stored typo is read as minutes", file: APPDATA, test: SERVER,
    from: "  if (typeof n !== \"number\" || !Number.isFinite(n) || n <= 0) return null;", to: "  if (n === undefined || n === null) return null;",
    mustFail: "a stored value that is not a number reads as unset, never as 'every tick'" },
  { guard: "appData:load reads the dial with .unique() (a second row stops every roster load)", file: APPDATA, test: SERVER,
    from: "        .withIndex(\"by_key\", (q) => q.eq(\"key\", IDLE_REFRESH_KEY))\n        .first(),\n    ]);",
    to: "        .withIndex(\"by_key\", (q) => q.eq(\"key\", IDLE_REFRESH_KEY))\n        .unique(),\n    ]);",
    mustFail: "A DUPLICATE DIAL ROW DOES NOT STOP THE ROSTER: appData:load still answers, with the first row's number" },
  { guard: "setIdleRefresh leaves a duplicate dial row in place", file: APPDATA, test: SERVER,
    from: "    for (const extra of rows.slice(1)) await ctx.db.delete(extra._id);\n", to: "",
    mustFail: "...and setIdleRefresh repairs it: one row left, holding the new number" },
  { guard: "the dial is a public mutation any browser could call", file: APPDATA, test: SERVER,
    from: "export const setIdleRefresh = internalMutation({", to: "export const setIdleRefresh = mutation({",
    mustFail: "THE DIAL IS AN ADMIN'S: setIdleRefresh is an internalMutation (deploy key only, no browser can reach it)" },
];

// A builder's shortcut, never set in npm test: REFRESH_CAP_TEETH_ONLY=<text>
const ONLY = process.env.REFRESH_CAP_TEETH_ONLY || "";
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

const scratch = mkdtempSync(join(process.env.REFRESH_CAP_TEETH_DIR || tmpdir(), "refresh-cap-teeth-"));
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
