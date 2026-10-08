// The Uniform Violations log. Run: npm test
//
// WHAT THIS PINS, and why each one is here rather than assumed:
//
//   - THE OWNER'S LADDER. "1's an accident, 2 is concerning, 3 is a habit."
//   - THE ROLLING WINDOW, which is his correction and not the first design.
//     The obvious rule was "three in a school week" and he asked the question
//     that killed it: "if it resets weekly, does that mean the previous week
//     isn't getting considered when punishment is taken into account?" A
//     resetting week also never flags a student who is out of uniform twice
//     every week forever, because they never reach three in one of them. So
//     the flag runs off a rolling count and the term total is carried beside
//     it, and there is an assertion below for exactly that student.
//   - ONE VIOLATION PER STUDENT PER DAY, and that a VOIDED one does not block
//     the day — undoing a mistake has to leave the child loggable again.
//   - THE SCHOOL DAY IS THE SERVER'S (2026-10-08, the Reflection Room build,
//     step 5). The shipped `log` mutation is RUN against an in-memory Convex
//     (fake-convex.mjs): it files an entry under the Los Angeles day of the
//     moment Enter was pressed (`observedAt`), ignores and counts the day a
//     browser sends, and refuses to believe a time outside [now - 72 h,
//     now + 5 min]. The old one-day "slack" that accepted tomorrow is gone.
//   - THE SEND QUEUE: a second Enter during a save is queued, never dropped;
//     a failed send retries itself under the same attemptId; the queue
//     survives a reload; and it goes with the person at sign-out.
//   - THE SCHOOL'S CLOCK on every time shown -- this whole file runs with the
//     machine in Tokyo, so a time read off the machine's zone is caught.
//   - THAT ABSENT DATA IS NEVER RENDERED AS A GOOD RESULT, the refusal
//     attendanceRanking already makes.
//
// TEETH: scripts/reflection-teeth.mjs puts back the busy early return, the
// trusted client day and the ignored observedAt, one at a time, and requires
// the check named for each to FAIL.
process.env.TZ = "Asia/Tokyo";

import { readFileSync } from "node:fs";
import ts from "typescript";
import { clock, loadConvex, makeDb, runtime } from "./fake-convex.mjs";

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

// ---- the client rules: execute the real shipped file -------------------
const discSrc = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");
new Function(discSrc)();
const D = globalThis.WildcatDiscipline;

// ---- the server rules: lift them from the shipped TypeScript ----------
const ruleSrc = readFileSync(new URL("./convex/uniformRules.ts", import.meta.url), "utf8");
function lift(name) {
  const start = ruleSrc.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} is not exported from convex/uniformRules.ts`);
  const end = ruleSrc.indexOf("\n}\n", start) + 3;
  return ruleSrc.slice(start, end).replace("export function", "function");
}
const js = ts.transpileModule(
  ["dayToEpoch", "dayMinus", "windowStart", "duplicateVerdict",
   "mayLogUniform", "mayReadUniform"].map(lift).join("\n") +
  // The module-level constants the lifted functions close over. Taken from
  // the shipped source by regex rather than retyped, so a change to either
  // the role list or the day pattern fails here instead of drifting.
  "\n" + ruleSrc.match(/^export const UNIFORM_LOG_ROLES = .*$/m)[0].replace("export ", "").replace(" as const", "") +
  "\n" + ruleSrc.match(/^export const UNIFORM_READ_ROLES = .*$/m)[0].replace("export ", "").replace(" as const", "") +
  "\n" + ruleSrc.match(/^export const MAX_WINDOW_DAYS = .*$/m)[0].replace("export ", "") +
  "\n" + ruleSrc.match(/^const DAY_RE = .*$/m)[0],
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText;
const [dayToEpoch, dayMinus, windowStart, duplicateVerdict, mayLogUniform, mayReadUniform] =
  new Function(js + "\nreturn [dayToEpoch, dayMinus, windowStart, duplicateVerdict, mayLogUniform, mayReadUniform];")();

console.log("\nThe owner's ladder: 1 is an accident, 2 is concerning, 3 is a habit");
{
  const s = D.uniformSettingsOrDefault(null);
  check("it ships on a 14-day rolling window", s.windowDays === 14);
  check("0 is clear", D.uniformTier(0, s).key === "clean");
  check("1 is a one-off, not a flag", D.uniformTier(1, s).key === "accident");
  check("2 is concerning", D.uniformTier(2, s).key === "concerning");
  check("3 is a habit", D.uniformTier(3, s).key === "habit");
  check("and so is 40", D.uniformTier(40, s).key === "habit");
  check("a count that cannot be read is not a tier", D.uniformTier(null, s) === null);
}

console.log("\nThe rolling window keeps the history, which is the whole point");
{
  // The owner's question: "if it resets weekly, does that mean the previous
  // week isn't getting considered when punishment is taken into account?"
  const s = D.uniformSettingsOrDefault(null);
  const improved = D.uniformRanking(
    [{ studentNumber: "1", studentName: "Improved", count: 0, total: 4, lastDay: "2026-08-20" }], s);
  check("a student who has stopped shows no flag", improved.ranked[0].tier.key === "clean");
  check("but their term total is still on the row", improved.ranked[0].total === 4);

  // The student a resetting week would never catch: two a week, forever.
  const twicePerWeek = D.uniformRanking(
    [{ studentNumber: "2", studentName: "Every Week", count: 4, total: 40, lastDay: "2026-09-18" }], s);
  check("two a week for months reaches Habit on a 14-day window",
    twicePerWeek.ranked[0].tier.key === "habit");
  check("which a resetting 3-per-week rule would never have flagged",
    twicePerWeek.ranked[0].count >= s.habitAt && 2 < 3);
}

console.log("\nThresholds are arguments, never globals, so the owner can change them");
{
  const strict = D.uniformSettingsOrDefault({ windowDays: 30, concerningAt: 3, habitAt: 5 });
  check("a stricter set is honoured", strict.concerningAt === 3 && strict.habitAt === 5 && strict.windowDays === 30);
  check("2 is no longer concerning under it", D.uniformTier(2, strict).key === "accident");
  check("5 is a habit under it", D.uniformTier(5, strict).key === "habit");
  check("the same count tiers differently under different settings",
    D.uniformTier(3, strict).key !== D.uniformTier(3, D.DEFAULT_UNIFORM_SETTINGS).key);
}

console.log("\nA settings blob that cannot be trusted falls back rather than breaking");
{
  const d = D.DEFAULT_UNIFORM_SETTINGS;
  check("a string is refused", D.uniformSettingsOrDefault({ habitAt: "3" }).habitAt === d.habitAt);
  check("a negative is refused", D.uniformSettingsOrDefault({ windowDays: -5 }).windowDays === d.windowDays);
  check("zero days is refused (a window must contain something)",
    D.uniformSettingsOrDefault({ windowDays: 0 }).windowDays === d.windowDays);
  check("NaN is refused", D.uniformSettingsOrDefault({ habitAt: NaN }).habitAt === d.habitAt);
  check("a non-object is refused whole", D.uniformSettingsOrDefault("nope").windowDays === d.windowDays);
  // Inverted thresholds would make the tiers silently overlap.
  const inverted = D.uniformSettingsOrDefault({ concerningAt: 5, habitAt: 2 });
  check("a habit cannot be easier to reach than a concern", inverted.habitAt >= inverted.concerningAt);
}

console.log("\nThe repeat list is a queue, worst first, and absent data is not 'clean'");
{
  const s = D.DEFAULT_UNIFORM_SETTINGS;
  const r = D.uniformRanking([
    { studentNumber: "a", studentName: "Mild", count: 1, lastDay: "2026-09-10" },
    { studentNumber: "b", studentName: "Worst", count: 6, lastDay: "2026-09-18" },
    { studentNumber: "c", studentName: "Unreadable", count: null },
    { studentNumber: "d", studentName: "Middle", count: 3, lastDay: "2026-09-17" },
  ], s);
  check("worst first", r.ranked.map((x) => x.studentName).join(",") === "Worst,Middle,Mild");
  check("a row whose count cannot be read is held out", r.noData.length === 1);
  check("and is NOT sorted in as though it were clean",
    !r.ranked.some((x) => x.studentName === "Unreadable"));
  check("each tier is counted for the filter chips",
    r.counts.habit === 2 && r.counts.accident === 1);
  check("the settings used are reported back", r.settings.habitAt === s.habitAt);

  // A still-running habit outranks one that has stopped, at the same count.
  const tie = D.uniformRanking([
    { studentNumber: "x", studentName: "Stopped", count: 3, lastDay: "2026-08-01" },
    { studentNumber: "y", studentName: "Ongoing", count: 3, lastDay: "2026-09-18" },
  ], s);
  check("at the same count, the more recent comes first",
    tie.ranked[0].studentName === "Ongoing");
}

console.log("\nA day is a real day");
{
  check("a date that does not exist is refused", dayToEpoch("2026-02-31") === null);
  check("a real leap day is not", dayToEpoch("2028-02-29") !== null);
  check("month 13 is refused", dayToEpoch("2026-13-01") === null);
  check("a timestamp is not a day", dayToEpoch("2026-09-18T10:00:00Z") === null);
  check("the one-day slack that accepted tomorrow is gone from the rules",
    !/DAY_SLACK|function dayVerdict/.test(ruleSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")));
}

console.log("\nA count window cannot be widened without limit by a stale client");
{
  check("a sane window passes through", windowStart("2026-09-04", "2026-09-18") === "2026-09-04");
  check("a year and a half is clamped to the ceiling",
    windowStart("2020-01-01", "2026-09-18") === dayMinus("2026-09-18", 400));
  check("an absent window falls back to the ceiling",
    windowStart(null, "2026-09-18") === dayMinus("2026-09-18", 400));
  check("14 days back is what it says", dayMinus("2026-09-18", 14) === "2026-09-04");
  check("it crosses a month boundary correctly", dayMinus("2026-03-01", 1) === "2026-02-28");
}

console.log("\nOne violation per student per day");
{
  const existing = { at: "2026-09-18T14:50:00Z", loanerProvided: false, voidedAt: null };
  const v = duplicateVerdict(existing);
  check("a second sighting is a duplicate, not a second row", v.duplicate === true);
  check("and it offers to add the loaner to the entry that exists", v.canAddLoaner === true);
  check("no existing entry is not a duplicate", duplicateVerdict(null).duplicate === false);
  check("an entry that already has a loaner cannot take another",
    duplicateVerdict({ ...existing, loanerProvided: true }).canAddLoaner === false);
  // Undo has to leave the child loggable again, or an interventionist is stuck
  // with a wrong record for the rest of the day.
  check("a VOIDED entry does not block the day",
    duplicateVerdict({ ...existing, voidedAt: "2026-09-18T14:51:00Z" }).duplicate === false);
}

console.log("\nWho can log a violation");
{
  check("the PBIS team can", mayLogUniform("pbis") === true);
  check("admins can", mayLogUniform("admin") === true && mayLogUniform("superadmin") === true);
  check("a classroom teacher cannot", mayLogUniform("teacher") === false);
  check("a campus aide cannot", mayLogUniform("campusaide") === false);
  check("an absent role cannot", mayLogUniform(undefined) === false && mayLogUniform(null) === false);
  check("reading is gated the same way", mayReadUniform("teacher") === false && mayReadUniform("pbis") === true);
}

console.log("\nThe subtab is on the privileged side of Discipline, with the other whole-school records");
{
  const tabs = D.disciplineTabsFor("pbis");
  check("PBIS can open it", tabs.includes("uniform"));
  check("so can an admin", D.disciplineTabsFor("admin").includes("uniform"));
  check("a teacher cannot", !D.disciplineTabsFor("teacher").includes("uniform"));
  check("nor a campus aide", !D.disciplineTabsFor("campusaide").includes("uniform"));
  check("canOpenDisciplineTab agrees", D.canOpenDisciplineTab("pbis", "uniform") === true);
  check("and refuses a teacher", D.canOpenDisciplineTab("teacher", "uniform") === false);
  // The teacher set is pinned elsewhere as an exact string; adding a
  // privileged tab must not have disturbed it.
  check("the teacher set is untouched",
    D.disciplineTabsFor("teacher").join(",") === "submit,review,closed");
}

console.log("\nThe word 'severe' is deliberately not reused");
{
  // severeBypass already means one incident too serious for the intervention
  // ladder, with its own test and its own export column. Two different
  // severes in one mode is how a screen counts the wrong thing.
  check("no tier is called severe",
    !D.UNIFORM_TIERS.some((t) => /severe/i.test(t.key) || /severe/i.test(t.label)));
  check("the tiers are the owner's words",
    D.UNIFORM_TIERS.map((t) => t.key).join(",") === "habit,concerning,accident,clean");
}

// ---- the wiring, because a feature can be complete on both sides and
// ---- joined on neither, and that looks exactly like a working feature.
const js2 = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

console.log("\nThe subtab is actually reachable");
{
  check("it is in the Discipline sub-nav table",
    /\{ id: 'uniform',\s+fn: 'switchDisciplineTab', label: wcIcon\('identity'\)/.test(js2));
  check("the label is an icon, not an emoji (icons.test.mjs forbids one here)",
    !/id: 'uniform'[^}]*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(js2));
  check("switchDisciplineTab knows its pane",
    /uniform:\s+\{ pane: 'behaviorUniform',\s+btn: null \}/.test(js2));
  check("and dispatches to the renderer",
    /subtab === 'uniform'\)\s*\{\s*openUniformViolations\(\);/.test(js2));
  check("the pane exists in the markup, hidden by default",
    /<div id="behaviorUniform" class="discipline-subtab hidden">/.test(html));
  check("it does NOT use .subtab-button, which is hidden inside #disciplineContent",
    !/id="behaviorUniform"[\s\S]{0,4000}?subtab-button/.test(html));
  check("no modal inside the pane, which could never be shown",
    !/id="behaviorUniform"[\s\S]{0,6000}?class="[^"]*modal/.test(html));
}

console.log("\nEvery id the renderer reaches for exists in the markup");
{
  // dom-refs.test.mjs cites three shipped outages from exactly this.
  const block = js2.slice(js2.indexOf("// UNIFORM VIOLATIONS"), js2.indexOf("function wcDaysAgoLabel"));
  check("the uniform block was found", block.length > 3000);
  const ids = [...new Set([...block.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))];
  check(`it reaches for ${ids.length} ids`, ids.length >= 8);
  const missing = ids.filter((id) => !new RegExp(`id="${id}"`).test(html));
  check("every one of them is in index.html", missing.length === 0, missing.join(", "));
  const qs = [...new Set([...block.matchAll(/querySelectorAll\('#([A-Za-z]+)/g)].map((m) => m[1]))];
  const missingQs = qs.filter((id) => !new RegExp(`id="${id}"`).test(html));
  check("and so is every container it queries", missingQs.length === 0, missingQs.join(", "));
}

console.log("\nEvery onclick in the pane names a function that exists");
{
  const pane = html.slice(html.indexOf('id="behaviorUniform"'), html.indexOf('<!-- Student History Subtab -->'));
  check("the pane markup was found", pane.length > 1000);
  const fns = [...new Set([...pane.matchAll(/on(?:click|input|keydown)="([A-Za-z_]+)\(/g)].map((m) => m[1]))];
  check(`the pane calls ${fns.length} functions`, fns.length >= 6);
  const undefined_ = fns.filter((f) => !new RegExp(`function ${f}\\s*\\(`).test(js2));
  check("all of them are defined in script.js", undefined_.length === 0, undefined_.join(", "));
}

console.log("\nThe client calls the server functions it needs, by their real names");
{
  const server = readFileSync(new URL("./convex/uniformViolations.ts", import.meta.url), "utf8");
  const exported = [...server.matchAll(/^export const (\w+) = (query|mutation)\(/gm)].map((m) => m[1]);
  check(`the module exports ${exported.length} functions`, exported.length === 8);
  const uncalled = exported.filter((n) => !js2.includes(`'uniformViolations:${n}'`));
  // convex-wiring.test.mjs asserts this globally; asserted here too so the
  // failure names the feature rather than a list of strings.
  check("every one has a caller in script.js", uncalled.length === 0, uncalled.join(", "));
  const called = [...new Set([...js2.matchAll(/'uniformViolations:(\w+)'/g)].map((m) => m[1]))];
  const bogus = called.filter((n) => !exported.includes(n));
  check("and every call names a real export", bogus.length === 0, bogus.join(", "));
}

console.log("\nThe threshold setting survives a save");
{
  // appData:save replaces the settings blob whole, so a key that is read but
  // never sent is destroyed by the next save from any tab.
  check("it is declared", /let uniformSettings = \{ windowDays: 14/.test(js2));
  check("read on the server path", /uniformSettings = mainData\.uniformSettings \|\| uniformSettings;/.test(js2));
  check("read on the localStorage fallback path", /uniformSettings = data\.uniformSettings \|\| uniformSettings;/.test(js2));
  check("SENT to the server, which is the one that destroys data if missed",
    /uniformSettings,\s*$/m.test(js2) && /schoolBranding,\s*\n\s*uniformSettings,/.test(js2));
  check("written into both local cache blobs",
    (js2.match(/kickboardSettings,\n\s+uniformSettings,/g) || []).length === 3);
  check("the editor is admin-only, so a doorway cannot fire a whole-app save",
    /admin-only[\s\S]{0,400}?Repeat-list thresholds/.test(html));
}

console.log("\nThe tier styles exist, under their own names");
{
  ["wc-uv-habit", "wc-uv-concerning", "wc-uv-accident", "wc-uv-clean", "wc-uv-loaner"]
    .forEach((c) => check(`.${c} is styled`, new RegExp("\\." + c).test(css)));
  check("the picker CSS it reuses is unscoped and already present",
    /\.student-picker-results\s*\{/.test(css) && /\.student-picker-option\s*\{/.test(css));
  check("the row furniture it reuses is present", /\.wc-att-row\s*\{/.test(css));
}

console.log("\nThe search matches all three number spaces, so any ID card scans");
{
  const block = js2.slice(js2.indexOf("function uniformPickerMatches"), js2.indexOf("function uniformCountFor"));
  check("it matches the 5-digit student number", /s\.studentNumber/.test(block));
  check("it matches the 4-digit meal-card number", /s\.mealPin/.test(block));
  check("and it still matches a typed name", /firstName/.test(block) && /lastName/.test(block));
  check("a one-character query is refused, so it cannot offer the school",
    /needle\.length < 2/.test(block));
  check("Enter refuses an ambiguous NAME match",
    /\/\^\\d\+\$\/\.test\(box\.value\.trim\(\)\) && _uvMatches\.length === 1/.test(js2));
}

// ---------------------------------------------------------------------------
// THE CLIENT FUNCTIONS, ACTUALLY EXECUTED.
//
// Everything above this point reads script.js as text, and that is how a
// one-word bug reached production on the day this shipped:
//
//     const [day, counts, loaners] = await Promise.all([
//         auth.convexQuery('uniformViolations:forDay', { day }, ...)
//
// The shorthand `{ day }` refers to the const being declared by that very
// statement, so every refresh threw "Cannot access 'day' before
// initialization". Every regex assertion passed: the call was there, the
// function existed, the id existed, the name was right. The violation SAVED
// and then the screen stayed empty, which is the worst shape a bug can take
// here -- it looks like lost data.
//
// A regex cannot catch that. Running the function can. So the functions are
// lifted out of the shipped source and executed against stubs that RECORD
// what they were called with, and the arguments are asserted, not just the
// call.
// ---------------------------------------------------------------------------
function liftFn(name) {
  const re = new RegExp(`^        (?:async )?function ${name}\\(`, "m");
  const m = js2.match(re);
  if (!m) throw new Error(`${name} is not a top-level function in script.js`);
  const start = m.index;
  const end = js2.indexOf("\n        }\n", start) + "\n        }\n".length;
  return js2.slice(start, end);
}

/** Run the lifted client functions in a scope of stubs, and report the calls. */
function harness(opts) {
  const o = opts || {};
  const calls = [];
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, value: "", textContent: "", innerHTML: "", hidden: false, className: "", focus() {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} } });
    return els.get(id);
  };
  const stubs = {
    calls, els, el,
    document: {
      getElementById: el,
      querySelectorAll: () => [],
    },
    windowStub: {
      WildcatAuth: {
        getSession: () => (o.signedOut ? null : { idToken: "t" }),
        convexQuery: async (path, args) => {
          calls.push({ path, args });
          if (o.answers && o.answers[path] !== undefined) {
            if (o.answers[path] instanceof Error) throw o.answers[path];
            return o.answers[path];
          }
          return { allowed: true, rows: [], truncated: false };
        },
      },
      WildcatDiscipline: D,
    },
    enrolled: o.students || [],
    now: o.now || "2026-09-18",
  };
  const body = `
    const window = stubs.windowStub;
    const document = stubs.document;
    const console = { warn() {}, error() {}, log() {} };
    const escapeHtml = (s) => String(s == null ? "" : s);
    const enrolledStudents = () => stubs.enrolled;
    let uniformSettings = ${JSON.stringify(o.settings || null)};
    let _uvToday = [], _uvCounts = ${JSON.stringify(o.counts || [])}, _uvLoaners = [];
    let _uvTruncated = false, _uvPick = null, _uvMatches = [], _uvHighlight = -1;
    let _uvPickSummary = null;
    let _uvDay = ${JSON.stringify(o.day || "")};
    let renderCalls = 0;
    function renderUniformViolations() { renderCalls++; }
    ${["wcIsoDay", "uniformSettingsNow", "uvSchoolDay", "uvDayLabel", "uniformWindowStart", "updateUniformDayNote",
       "refreshUniformData", "uniformPickerMatches", "uniformCountFor", "wcOrdinalSuffix", "wcDaysAgoLabel"].map(liftFn).join("\n")}
    return {
      refreshUniformData, uniformWindowStart, uniformSettingsNow,
      uniformPickerMatches, uniformCountFor, wcOrdinalSuffix, wcDaysAgoLabel, wcIsoDay,
      state: () => ({ today: _uvToday, counts: _uvCounts, loaners: _uvLoaners, truncated: _uvTruncated, renderCalls, day: _uvDay }),
    };
  `;
  return { api: new Function("stubs", "D", body)(stubs, D), calls, el };
}

/** The school day in Los Angeles: what the screen falls back to before the server has said. */
const laDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const TODAY = dayOf(new Date());
const daysBack = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return dayOf(d); };

console.log("\nThe refresh actually runs, and lets the SERVER say which day it is");
{
  const { api, calls, el } = harness({
    answers: { "uniformViolations:forDay": { allowed: true, rows: [], truncated: false, day: "2026-10-13" } },
  });
  let threw = null;
  await api.refreshUniformData().catch((e) => { threw = e; });
  // THE ASSERTION THAT WAS MISSING. It fails on the shipped bug with
  // "Cannot access 'day' before initialization".
  check("it does not throw", threw === null, threw && threw.message);
  check("it asked all three queries", calls.length === 3);

  const forDay = calls.find((c) => c.path === "uniformViolations:forDay");
  check("forDay was called", Boolean(forDay));
  check("and it was sent NO day: the server answers with its own school day (step 5)",
    Boolean(forDay) && Object.keys(forDay.args).length === 0, forDay ? JSON.stringify(forDay.args) : "no call");
  check("the screen keeps the server's day, and says 'Logging for' it",
    api.state().day === "2026-10-13" && /^Logging for Tue 10\/13\./.test(el("uvDayNote").textContent), el("uvDayNote").textContent);

  const counts = calls.find((c) => c.path === "uniformViolations:counts");
  check("counts is sent the window's length, never this Chromebook's date",
    Boolean(counts) && counts.args.windowDays === 14 && !("today" in counts.args) && !("sinceDay" in counts.args),
    counts ? JSON.stringify(counts.args) : "no call");
  check("every argument is defined",
    calls.every((c) => Object.values(c.args).every((v) => v !== undefined)),
    JSON.stringify(calls.map((c) => c.args)));
}

console.log("\nThe refresh degrades rather than throwing");
{
  const refused = harness({
    answers: { "uniformViolations:forDay": { allowed: false, reason: "Ask an administrator." } },
  });
  let threw = null;
  await refused.api.refreshUniformData().catch((e) => { threw = e; });
  check("a refusal does not throw", threw === null);
  check("and the reason is put on screen",
    /Ask an administrator/.test(refused.el("uniformList").innerHTML));

  const broken = harness({ answers: { "uniformViolations:counts": new Error("network down") } });
  let threw2 = null;
  await broken.api.refreshUniformData().catch((e) => { threw2 = e; });
  check("a failed query is caught, not thrown at the caller", threw2 === null);
  check("and the screen is still redrawn", broken.api.state().renderCalls >= 1);

  const out = harness({ signedOut: true });
  let threw3 = null;
  await out.api.refreshUniformData().catch((e) => { threw3 = e; });
  check("signed out asks for nothing and does not throw", threw3 === null && out.calls.length === 0);
}

console.log("\nThe window is the settings window, counted back from the server's day");
{
  const wide = harness({ settings: { windowDays: 30, concerningAt: 2, habitAt: 3 }, day: "2026-10-13" });
  check("a 30-day window starts 29 days before the server's day", wide.api.uniformWindowStart() === "2026-09-14", wide.api.uniformWindowStart());
  const one = harness({ settings: { windowDays: 1, concerningAt: 1, habitAt: 1 }, day: "2026-10-13" });
  check("a one-day window is that day itself", one.api.uniformWindowStart() === "2026-10-13");
  const junk = harness({ settings: { windowDays: "lots" }, day: "2026-11-02" });
  check("a junk window falls back to the 14-day default, across the clock change", junk.api.uniformWindowStart() === "2026-10-20", junk.api.uniformWindowStart());
  const early = harness({});
  const want = new Date(Date.parse(laDay(Date.now()) + "T12:00:00Z") - 13 * 86400000).toISOString().slice(0, 10);
  check("before the server has said, it counts from the LOS ANGELES day, not this (Tokyo) machine's",
    early.api.uniformWindowStart() === want, early.api.uniformWindowStart() + " wanted " + want);
  check("the lifted formatter is the shipped one", wide.api.wcIsoDay(new Date()) === TODAY);
}

console.log("\nThe search runs, and a scanner's digits resolve to one student");
{
  const roster = [
    { id: "1", studentNumber: "11890", mealPin: "4021", firstName: "Owen", lastName: "Velasquez", grade: "11" },
    { id: "2", studentNumber: "11654", mealPin: "", firstName: "Leo-Andrew", lastName: "Avelar", grade: "10" },
    { id: "3", studentNumber: "12001", mealPin: "4022", firstName: "Rosa", lastName: "Rodriguez", grade: "9" },
    { id: "4", studentNumber: "12002", mealPin: "4023", firstName: "Rosa", lastName: "Romero", grade: "9" },
  ];
  const { api } = harness({ students: roster });
  check("a full student number finds exactly one",
    api.uniformPickerMatches("11890").length === 1);
  check("and it is the right child",
    api.uniformPickerMatches("11890")[0].lastName === "Velasquez");
  check("a cafeteria number also finds exactly one",
    api.uniformPickerMatches("4021").length === 1 &&
    api.uniformPickerMatches("4021")[0].studentNumber === "11890");
  check("a name finds by first or last", api.uniformPickerMatches("avelar").length === 1);
  check("lastname-firstname order also matches", api.uniformPickerMatches("velasquez owen").length === 1);
  check("an ambiguous name returns BOTH, so Enter cannot guess",
    api.uniformPickerMatches("rosa").length === 2);
  check("one character finds nothing", api.uniformPickerMatches("r").length === 0);
  check("a partial number still offers candidates while typing",
    api.uniformPickerMatches("120").length === 2);
  check("nothing matching is an empty list, not a throw",
    api.uniformPickerMatches("zzzz").length === 0);
  check("a student with no meal number on file is still findable by name",
    api.uniformPickerMatches("leo").length === 1);
}

console.log("\nThe small display helpers run");
{
  const { api } = harness({ counts: [{ studentNumber: "11890", count: 3 }] });
  check("a count is read off the loaded window", api.uniformCountFor("11890") === 3);
  check("an unlogged student is 0, not undefined", api.uniformCountFor("99999") === 0);
  check("1st", api.wcOrdinalSuffix(1) === "st");
  check("2nd", api.wcOrdinalSuffix(2) === "nd");
  check("3rd", api.wcOrdinalSuffix(3) === "rd");
  check("4th", api.wcOrdinalSuffix(4) === "th");
  check("11th, not 11st", api.wcOrdinalSuffix(11) === "th");
  check("12th, not 12nd", api.wcOrdinalSuffix(12) === "th");
  check("13th, not 13rd", api.wcOrdinalSuffix(13) === "th");
  check("21st", api.wcOrdinalSuffix(21) === "st");
  check("a loaner given today reads 'today'", api.wcDaysAgoLabel(TODAY) === "today");
  check("yesterday reads 'yesterday'", api.wcDaysAgoLabel(daysBack(1)) === "yesterday");
  check("older reads in days", api.wcDaysAgoLabel(daysBack(4)) === "4 days ago");
  check("junk reads empty, not NaN", api.wcDaysAgoLabel("nope") === "");
}

// ---------------------------------------------------------------------------
// THE SERVER SETS THE DAY (step 5): the SHIPPED log, voidEntry and forDay,
// run against an in-memory Convex with the real schema's indexes.
// ---------------------------------------------------------------------------
Object.assign(process.env, { STAFF_DOMAIN: "school.test", ENTRA_TENANT_ID: "tenant-1" });
const STAFF_ISSUER = "https://login.microsoftonline.com/tenant-1/v2.0";
const convex = await loadConvex(new URL("./", import.meta.url), ["uniformViolations", "reflectionRules"]);
try {
  const U = convex.mods.uniformViolations;
  const RR = convex.mods.reflectionRules;
  const la = (date, hhmm) => { const [h, m] = hhmm.split(":").map(Number); return RR.laWallToUtc(date, h * 60 + m, "America/Los_Angeles"); };
  const TUE = "2026-10-13", WED = "2026-10-14";
  async function server() {
    const store = makeDb(readFileSync(new URL("./convex/schema.ts", import.meta.url), "utf8"));
    await store.db.insert("bellSettings", { key: "bell", timeZone: "America/Los_Angeles", updatedAt: "2026-08-17T00:00:00Z" });
    await store.db.insert("teachers", { name: "Pat PBIS", email: "pbis@school.test", role: "pbis", ticketsAwarded: 0 });
    for (const [sn, first] of [["12001", "Rosa"], ["12002", "Owen"], ["12003", "Leo"]]) {
      await store.db.insert("students", { studentNumber: sn, firstName: first, lastName: "Test", grade: "9" });
    }
    const rt = runtime(store, convex.mods);
    rt.signIn({ issuer: STAFF_ISSUER, email: "pbis@school.test" });
    const log = (sn, extra) => rt.run("uniformViolations.log", { studentNumber: sn, loanerProvided: false, attemptId: "a" + Math.random(), ...extra });
    return { store, rt, log };
  }

  console.log("\nThe server files each entry under the school day of the moment Enter was pressed");
  {
    const w = await server();
    clock.set(la(TUE, "07:52"));
    const r = await w.log("12001", { observedAt: Date.parse(la(TUE, "07:52")) });
    check("the server sets the day: pressed and sent Tue 7:52 is a Tuesday entry, at the moment it was seen",
      r.ok && r.row.day === TUE && r.row.at === la(TUE, "07:52") && !r.row.savedAt, JSON.stringify(r.row));
    clock.set(la(TUE, "16:30"));          // after 4:30 PM Pacific: the UTC date is already Wednesday
    const late = await w.log("12002", { observedAt: Date.parse(la(TUE, "16:30")) });
    check("after school is still today, though the UTC date has rolled over", late.row.day === TUE, late.row.day);

    clock.set(la(TUE, "13:00"));
    const old = await w.log("12003", { day: WED });       // a tab on older code: no observedAt
    const mismatch = w.store.rows("appState").find((x) => x.key === "uniform:dayMismatch")?.value;
    check("a client day of tomorrow is ignored and counted",
      old.row.day === TUE && mismatch?.clientDay === 1 && mismatch?.outOfWindow === 0, JSON.stringify({ day: old.row.day, mismatch }));

    clock.set(la(TUE, "13:05"));
    const forDay = await w.rt.run("uniformViolations.forDay", {});
    check("forDay with no day answers with the server's school day and its rows",
      forDay.day === TUE && forDay.rows.length === 3, JSON.stringify({ day: forDay.day, n: forDay.rows.length }));
    const counts = await w.rt.run("uniformViolations.counts", { windowDays: 14 });
    check("counts counts back from the server's day when sent only the window's length",
      counts.today === TUE && counts.sinceDay === "2026-09-30" && counts.rows.length === 3, JSON.stringify({ today: counts.today, since: counts.sinceDay }));
  }

  console.log("\nA queued entry is filed under the day it was SEEN, however late it is sent");
  {
    const w = await server();
    clock.set(la(WED, "08:10"));
    const queued = await w.log("12001", { observedAt: Date.parse(la(TUE, "07:52")) });
    const fresh = await w.log("12001", { observedAt: Date.parse(la(WED, "08:09")) });
    check("an item queued Tue 07:52 and sent Wed 08:10 is filed under Tue and does not block a Wed entry",
      queued.ok && queued.row.day === TUE && queued.row.at === la(TUE, "07:52")
        && fresh.ok && fresh.duplicate === false && fresh.row.day === WED,
      JSON.stringify({ q: queued.row && queued.row.day, f: fresh.row && fresh.row.day, dup: fresh.duplicate }));
    check("...and it records when it was saved, so the list can say 'Saved late (observed Tue 7:52)'",
      queued.row.savedAt === la(WED, "08:10") && fresh.row.savedAt === null, JSON.stringify([queued.row.savedAt, fresh.row.savedAt]));
    const row = w.store.rows("uniformViolations").find((x) => x.day === TUE);
    check("...the row keeps observedAt (epoch ms) and savedAt for the list's tag",
      row.observedAt === Date.parse(la(TUE, "07:52")) && row.savedAt === la(WED, "08:10"));
    const wedRow = w.store.rows("uniformViolations").find((x) => x.day === WED);
    check("...and EVERY row keeps when the server saved it (recordedAt), the time a list's claim is judged by, even one saved a minute after it was seen",
      row.recordedAt === la(WED, "08:10") && wedRow.recordedAt === la(WED, "08:10") && wedRow.at === la(WED, "08:09") && !wedRow.savedAt,
      JSON.stringify([row.recordedAt, wedRow.recordedAt]));
    const again = await w.log("12001", { observedAt: Date.parse(la(TUE, "07:55")) });
    check("one entry per student per SERVER day still holds: a second Tuesday sighting is a duplicate", again.duplicate === true);

    const stale = await w.log("12002", { observedAt: Date.parse(la(WED, "08:10")) - 73 * 3600e3 });
    const mm = w.store.rows("appState").find((x) => x.key === "uniform:dayMismatch")?.value;
    check("an observedAt older than 72 h falls back to now and is counted",
      stale.row.day === WED && stale.row.at === la(WED, "08:10") && mm?.outOfWindow === 1, JSON.stringify({ day: stale.row.day, mm }));
    const ahead = await w.log("12003", { observedAt: Date.parse(la(WED, "08:10")) + 6 * 60e3 });
    check("one more than 5 minutes ahead is not believed either", ahead.row.at === la(WED, "08:10"));
  }

  console.log("\nA press that can never land is answered, not retried for ever");
  {
    const w = await server();
    clock.set(la(TUE, "08:00"));
    const fromQueue = await w.log("99999", { observedAt: Date.parse(la(TUE, "08:00")) });
    check("from the send queue: no such student is a refusal the queue can read",
      fromQueue.ok === false && fromQueue.refused === true && /No student has number 99999/.test(fromQueue.reason), JSON.stringify(fromQueue));
    const oldTab = await w.log("99999", {}).then(() => "saved", (e) => String(e.message || e));
    check("from a tab on older code it is still the error it understands", /No student has number 99999/.test(oldTab), oldTab);
    const same = "press-1";
    const one = await w.log("12001", { attemptId: same, observedAt: Date.parse(la(TUE, "08:00")) });
    const retry = await w.log("12001", { attemptId: same, observedAt: Date.parse(la(TUE, "08:00")) });
    check("a retry of the same press is answered with the row it made, never a second one",
      one.ok && retry.deduped === true && retry.row.id === one.row.id && w.store.rows("uniformViolations").length === 1);
  }

  console.log("\nUndo: one tap before the list is made, a reason after");
  {
    const w = await server();
    clock.set(la(TUE, "08:00"));
    const a = await w.log("12001", { observedAt: Date.parse(la(TUE, "08:00")) });
    const b = await w.log("12002", { observedAt: Date.parse(la(TUE, "08:01")) });
    const undo = await w.rt.run("uniformViolations.voidEntry", { id: a.row.id });
    check("before its list is made, Undo needs no reason, and says who undid it",
      undo.ok && undo.row.voidReason === "Undone by Pat PBIS", undo.row.voidReason);
    // The 11:45 freeze puts B's entry on a detention.
    const unit = await w.store.db.insert("reflectionUnits", {
      studentNumber: "12002", division: "hs", kind: "new", tardyIds: [], uniformIds: [b.row.id], lines: ["Tue 10/13: Uniform 8:01 AM"],
      recordedAt: la(TUE, "11:45"), state: "listed", serveDay: TUE, mode: "shadow", carryCount: 0, tags: [],
    });
    await w.store.db.patch(b.row.id, { unitId: unit, reflectionState: "listed" });
    clock.set(la(TUE, "12:05"));
    const shown = (await w.rt.run("uniformViolations.forDay", {})).rows;
    check("forDay says which entries are on a list already made, so Undo knows to ask why",
      shown.length === 1 && shown[0].id === b.row.id && shown[0].onList === true, JSON.stringify(shown));
    const noReason = await w.rt.run("uniformViolations.voidEntry", { id: b.row.id }).then(() => "voided", (e) => String(e.message || e));
    check("a void after the list is made needs a reason",
      /already been made\. Give a reason/.test(noReason) && !w.store.rows("uniformViolations").find((x) => x._id === b.row.id).voidedAt, noReason);
    const withReason = await w.rt.run("uniformViolations.voidEntry", { id: b.row.id, reason: "Had a PE uniform pass" });
    const u = w.store.rows("reflectionUnits")[0];
    // The reason typed stays on the uniform row, which only the uniform roles
    // read; the release says only what happened, because every viewer of the
    // list sees it and it prints (review, 2026-10-08).
    check("...with one it is removed, and its detention, now empty, is released ('release this student')",
      withReason.ok && withReason.row.voidReason === "Had a PE uniform pass" && u.state === "released"
        && u.releaseReason === "uniform entry removed after the list was made", JSON.stringify({ s: u.state, r: u.releaseReason }));
  }
} finally {
  clock.real();
  convex.cleanup();
}

// ---------------------------------------------------------------------------
// THE SEND QUEUE, ACTUALLY RUN: the shipped queue functions lifted out of
// script.js, against a server whose answers the test controls, a fake device
// storage and timers the test fires by hand.
// ---------------------------------------------------------------------------
const QUEUE_FNS = ["uniformSettingsNow", "uvSchoolDay", "uvClock", "uniformWindowStart", "commitUniformViolation",
  "uvSessionEmail", "enqueueUniform", "storeUniformQueue", "resumeUniformQueue", "forgetUniformQueue",
  "armUniformPump", "pumpUniformQueue", "uvNameOf", "uniformSaved", "scheduleUniformRefresh",
  "uniformQueueLength", "oldestUniformQueuedAgeMs", "uniformQueueWords", "undoUniformViolation", "wcOrdinalSuffix"];
function queueWorld(o) {
  const calls = [], toasts = [], timers = [];
  let seq = 0;
  const pending = [];
  const storage = o.storage || new Map();
  const box = { value: "", focus() {} };
  const stubs = {
    calls, toasts, timers, storage,
    document: { getElementById: (id) => (id === "uvPickerInput" ? box : { hidden: false, innerHTML: "" }) },
    localStorage: o.noStorage
      ? { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } }
      : { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    setTimeout: (f, ms) => { const id = ++seq; timers.push({ id, f, ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    session: { idToken: "t", me: { email: o.email || "pbis@school.test" } },
    answer: o.answer,
    prompt: o.prompt || (async () => null),
  };
  stubs.window = {
    WildcatAuth: {
      getSession: () => stubs.session,
      convexMutation: (path, args) => {
        calls.push({ path, args: JSON.parse(JSON.stringify(args)) });
        if (o.hold) return new Promise((resolve, reject) => pending.push({ resolve, reject, args }));
        return Promise.resolve().then(() => stubs.answer(path, args, calls.length));
      },
    },
    WildcatDiscipline: D,
  };
  const api = new Function("stubs", `
    const window = stubs.window, document = stubs.document, localStorage = stubs.localStorage;
    const setTimeout = stubs.setTimeout, clearTimeout = stubs.clearTimeout;
    const console = { warn() {}, error() {}, log() {} };
    const showToast = (m, kind) => stubs.toasts.push({ m: String(m), kind });
    const showPrompt = (...a) => stubs.prompt(...a);
    const enrolledStudents = () => ${JSON.stringify(o.students || [])};
    let uniformSettings = null;
    let _uvPick = null, _uvMatches = [], _uvHighlight = -1, _uvPickSummary = null, _uvToday = ${JSON.stringify(o.today || [])};
    let _uvDay = "2026-10-13";
    let _uvQueue = [], _uvQueueOwner = '', _uvQueueStored = true, _uvPumping = false, _uvPumpTimer = null, _uvPumpGen = 0, _uvBurstTimer = null;
    const UV_QUEUE_PREFIX = 'wcUniformQueue:';
    const UV_RETRY_MS = [2000, 5000, 10000, 20000, 30000];
    const UV_BURST_MS = 1500;
    let renders = 0, refreshes = 0;
    function renderUniformViolations() { renders++; }
    function updateUniformPicked() {}
    async function refreshUniformData() { refreshes++; }
    ${QUEUE_FNS.map(liftFn).join("\n")}
    return {
      pick(st) { _uvPick = st; }, commitUniformViolation, resumeUniformQueue, forgetUniformQueue, pumpUniformQueue,
      undoUniformViolation, uniformQueueWords, uniformQueueLength, oldestUniformQueuedAgeMs, uvClock,
      queue: () => _uvQueue.map((q) => ({ ...q })), owner: () => _uvQueueOwner, stored: () => _uvQueueStored,
      counts: () => ({ renders, refreshes }),
    };
  `)(stubs);
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
  const fire = async (pred) => {
    const t = timers.find(pred || (() => true));
    if (!t) return false;
    timers.splice(timers.indexOf(t), 1);
    clock.set(Date.now() + t.ms);      // the pause has passed
    t.f();
    await settle();
    return true;
  };
  return { api, stubs, calls, toasts, timers, storage, pending, settle, fire };
}
const ROSA = { studentNumber: "12001", firstName: "Rosa", lastName: "Rodriguez", grade: "9" };
const OWEN = { studentNumber: "11890", firstName: "Owen", lastName: "Velasquez", grade: "11" };
const okAnswer = (path, args) => ({ ok: true, deduped: false, duplicate: false, row: { id: "r_" + args.attemptId, day: "2026-10-13", at: "2026-10-13T14:52:00.000Z" }, summary: { countInWindow: 1 } });

console.log("\nA second Enter during a save is queued, never dropped");
{
  const w = queueWorld({ hold: true, students: [ROSA, OWEN] });
  w.api.pick(ROSA); w.api.commitUniformViolation(false);
  await w.settle();
  w.api.pick(OWEN); w.api.commitUniformViolation(true);       // Enter again while Rosa is still saving
  await w.settle();
  const sentWhileBusy = w.calls.length;
  w.pending.shift().resolve(okAnswer("", w.pending.length ? w.calls[0].args : w.calls[0].args));
  await w.settle();
  w.pending.shift()?.resolve(okAnswer("", w.calls[1]?.args || {}));
  await w.settle();
  const sent = w.calls.filter((c) => c.path === "uniformViolations:log").map((c) => c.args);
  check("a second Enter during a save is queued, not dropped: both are sent, in the order typed",
    sentWhileBusy === 1 && sent.length === 2 && sent[0].studentNumber === "12001" && sent[1].studentNumber === "11890"
      && sent[1].loanerProvided === true && sent[0].attemptId !== sent[1].attemptId && w.api.uniformQueueLength() === 0,
    JSON.stringify({ sentWhileBusy, sent: sent.map((a) => a.studentNumber) }));
  check("each send carries the moment Enter was pressed, and no day of this Chromebook's",
    sent.every((a) => Number.isFinite(a.observedAt) && !("day" in a)), JSON.stringify(sent[0]));
  check("the list is read again once, after the burst, not after every save",
    w.timers.filter((t) => t.ms === 1500).length === 1 && w.api.counts().refreshes === 0);
  await w.fire((t) => t.ms === 1500);
  check("...1.5 seconds after the last save", w.api.counts().refreshes === 1);
}

console.log("\nA failed send is tried again by itself, under the same press");
{
  let n = 0;
  const w = queueWorld({ students: [ROSA], answer: (p, a) => { n++; if (n <= 3) throw new Error("Convex HTTP 503"); return okAnswer(p, a); } });
  w.api.pick(ROSA); w.api.commitUniformViolation(false);
  await w.settle();
  check("after one failure the footer says it is saving, never 'log them again'",
    w.api.uniformQueueWords() === "Saving 1…" && w.timers.some((t) => t.ms === 2000), w.api.uniformQueueWords());
  await w.fire((t) => t.ms === 2000);
  await w.fire((t) => t.ms === 5000);
  check("after 3 failures: '1 not saved yet. Still trying.'", w.api.uniformQueueWords() === "1 not saved yet. Still trying.", w.api.uniformQueueWords());
  await w.fire((t) => t.ms === 10000);
  const ids = [...new Set(w.calls.filter((c) => c.path === "uniformViolations:log").map((c) => c.args.attemptId))];
  check("the fourth try lands, with the SAME attemptId every time, and the queue is empty",
    w.calls.length === 4 && ids.length === 1 && w.api.uniformQueueLength() === 0 && w.api.uniformQueueWords() === "", JSON.stringify({ calls: w.calls.length, ids }));
  check("no toast ever asks anyone to log a student again", !w.toasts.some((t) => /log (them|it) again|log again/i.test(t.m)));
}

console.log("\nThe queue survives a reload, and goes with the person at sign-out");
{
  const storage = new Map();
  const down = queueWorld({ storage, students: [ROSA], answer: () => { throw new Error("Failed to fetch"); } });
  down.api.pick(ROSA); down.api.commitUniformViolation(true);
  await down.settle();
  const kept = JSON.parse(storage.get("wcUniformQueue:pbis@school.test") || "[]");
  const pressed = down.calls[0].args;
  check("the unsent entry is kept on this device under the signed-in person's email, student number only",
    kept.length === 1 && kept[0].studentNumber === "12001" && kept[0].attemptId === pressed.attemptId
      && !/Rosa|Rodriguez/.test(JSON.stringify(kept)), JSON.stringify(kept));
  check("Logout is told about it", down.api.uniformQueueLength() === 1 && down.api.oldestUniformQueuedAgeMs() >= 0);

  // The page reloads (an update, a crash, a closed lid): a fresh tab, same device.
  const back = queueWorld({ storage, students: [ROSA], answer: okAnswer });
  back.api.resumeUniformQueue("PBIS@school.test");
  await back.settle();
  const resent = back.calls.find((c) => c.path === "uniformViolations:log")?.args;
  check("the queue survives a reload (simulated localStorage): it is sent again on sign-in, the same press, the same moment",
    !!resent && resent.attemptId === pressed.attemptId && resent.observedAt === pressed.observedAt && resent.loanerProvided === true
      && !storage.has("wcUniformQueue:pbis@school.test") && back.api.uniformQueueLength() === 0, JSON.stringify(resent));

  const leave = queueWorld({ storage, students: [ROSA], answer: () => { throw new Error("offline"); } });
  leave.api.pick(ROSA); leave.api.commitUniformViolation(false);
  await leave.settle();
  leave.api.forgetUniformQueue();
  leave.stubs.session = { idToken: "t2", me: { email: "aide@school.test" } };
  const before = leave.calls.length;
  await leave.fire();
  check("at sign-out it goes with the person: nothing more is sent, and this device keeps it for their next sign-in",
    leave.api.uniformQueueLength() === 0 && leave.calls.length === before && storage.has("wcUniformQueue:pbis@school.test"));
  leave.api.resumeUniformQueue("aide@school.test");
  await leave.settle();
  check("...and the next person's sign-in never sends it", leave.calls.length === before && leave.api.uniformQueueLength() === 0);

  const priv = queueWorld({ noStorage: true, students: [ROSA], answer: () => { throw new Error("offline"); } });
  priv.api.pick(ROSA); priv.api.commitUniformViolation(false);
  await priv.settle();
  check("a device that cannot store it says so, so Logout can warn it would be lost", priv.api.stored() === false && priv.api.uniformQueueLength() === 1);
}

console.log("\nTwo tabs of one person: one tab's sends never erase what only the other holds");
{
  // Same staff member, two tabs on one Chromebook, a flaky network (second
  // review, 2026-10-08). Tab B resumes A's stored queue and sends it; while
  // it does, the adult presses Enter in A. B's last success used to write
  // its own (empty) queue over the shared copy, erasing the entry only A
  // held -- and A's Logout then promised it "waits on this device".
  const storage = new Map();
  const KEY = "wcUniformQueue:pbis@school.test";
  const LEO = { studentNumber: "12003", firstName: "Leo", lastName: "Test", grade: "9" };
  const offline = () => { throw new Error("Failed to fetch"); };
  const a = queueWorld({ storage, students: [ROSA, OWEN, LEO], answer: offline });
  a.api.pick(ROSA); a.api.commitUniformViolation(false);
  await a.settle();
  a.api.pick(OWEN); a.api.commitUniformViolation(false);
  await a.settle();
  const b = queueWorld({ storage, hold: true, students: [ROSA, OWEN, LEO] });
  b.api.resumeUniformQueue("pbis@school.test");
  await b.settle();
  a.api.pick(LEO); a.api.commitUniformViolation(false);        // A's retry of Rosa is still waiting
  await a.settle();
  const leo = a.api.queue().find((q) => q.studentNumber === "12003");
  b.pending.shift().resolve(okAnswer("", b.calls[0].args));
  await b.settle();
  b.pending.shift()?.resolve(okAnswer("", b.calls[1]?.args || {}));
  await b.settle();
  const ids = () => JSON.parse(storage.get(KEY) || "[]").map((q) => q.attemptId);
  const afterB = ids();
  const warned = a.api.uniformQueueLength() === 3 && a.api.stored() === true;   // what Logout in A says "waits on this device"
  a.api.forgetUniformQueue();                                   // Logout in A
  const afterLogout = ids();
  const c = queueWorld({ storage, students: [ROSA, OWEN, LEO], answer: okAnswer });
  c.api.resumeUniformQueue("pbis@school.test");
  await c.settle();
  check("two tabs of one person: the other tab's sends never erase an entry only this tab holds, so it waits on this device as Logout says",
    b.calls.length === 2 && !!leo && afterB.includes(leo.attemptId) && warned && afterLogout.includes(leo.attemptId),
    JSON.stringify({ sent: b.calls.length, afterB, afterLogout, leo: leo && leo.attemptId }));
  check("...and it is sent at the next sign-in on this device, under the same press",
    c.calls.some((x) => x.args.attemptId === leo.attemptId && x.args.studentNumber === "12003") && !storage.has(KEY),
    JSON.stringify({ c: c.calls.map((x) => x.args.studentNumber), left: ids() }));
  check("...while the entries the other tab saw land are dropped from this device's copy",
    JSON.stringify(afterB) === JSON.stringify([leo.attemptId]), JSON.stringify(afterB));
  // A tab still on the code before this fix (open across the deploy)
  // removes the key once its own queue is empty. Logout writes this tab's
  // queue once more as it leaves, so "it waits on this device" is true.
  const d = queueWorld({ storage, students: [ROSA], answer: offline });
  d.api.pick(ROSA); d.api.commitUniformViolation(false);
  await d.settle();
  const rosaId = d.api.queue()[0]?.attemptId;
  storage.delete(KEY);
  d.api.forgetUniformQueue();
  check("...and Logout writes this tab's queue once more as it leaves, whatever another tab removed meanwhile",
    !!rosaId && ids().includes(rosaId), JSON.stringify(ids()));
}

console.log("\nSigned out and back in while a send is out: the queue still goes");
{
  // Logout empties the queue and steps the pump's generation; the same
  // person signs straight back in (the native app does not reload) while the
  // first send is still out. The resumed queue must not wait for ever behind
  // a pump that is only finishing (review, 2026-10-08).
  const w = queueWorld({ hold: true, students: [ROSA] });
  w.api.pick(ROSA); w.api.commitUniformViolation(false);
  await w.settle();
  w.api.forgetUniformQueue();
  w.api.resumeUniformQueue("pbis@school.test");
  await w.settle();
  const whileOut = w.calls.length;
  w.pending.shift().reject(new Error("Failed to fetch"));       // the old send comes back
  await w.settle();
  await w.fire((t) => t.ms === 0);
  const resent = w.calls.length;
  w.pending.shift()?.resolve(okAnswer("", w.calls[1]?.args || {}));
  await w.settle();
  check("a sign-out and sign-in while a send is out: the resumed queue is sent once that send returns, never stalled",
    whileOut === 1 && resent === 2 && w.calls[1].args.attemptId === w.calls[0].args.attemptId && w.api.uniformQueueLength() === 0,
    JSON.stringify({ whileOut, resent, left: w.api.uniformQueueLength(), timers: w.timers.map((t) => t.ms) }));
}

console.log("\nLogout names a save still out, even with uniform entries waiting");
{
  const fn = new Function("G", `
    const _unsavedReferrals = new Map(Array.from({ length: G.referrals || 0 }, (_, i) => ["REF-" + i, {}]));
    let isSyncing = G.isSyncing;
    const _saveQueue = { isPending: () => false };
    const uniformQueueLength = () => G.uniform;
    let _uvQueueStored = G.stored;
    ${liftFn("unsavedWorkAtLogout")}
    return unsavedWorkAtLogout();
  `);
  const both = fn({ isSyncing: true, uniform: 1, stored: true });
  check("a save still being sent is named as lost even when a uniform entry waits on this device",
    /changes this tab is still sending to the server/.test(both) && /the changes will be lost from this device/.test(both)
      && /uniform entry waits on this device/.test(both), both);
  check("...with no save out, the uniform entry alone is said to wait",
    fn({ isSyncing: false, uniform: 1, stored: true }) === "Not saved yet: 1 uniform entry. If you log out now, it waits on this device and will be sent the next time you sign in here.");
  check("...and a device that cannot keep it says everything will be lost",
    /will be lost from this device, and so will the uniform entry\.$/.test(fn({ isSyncing: true, uniform: 1, stored: false })));
  // A REFERRAL ON THE BAR NO LONGER HIDES THE REST (second review,
  // 2026-10-08): it returned first, and uniform entries this device could
  // not keep were lost at sign-out unmentioned.
  const refLost = fn({ isSyncing: false, uniform: 2, stored: false, referrals: 1 });
  check("a referral and uniform entries this device could not keep are both named as lost",
    refLost === "Not saved yet: 1 referral, and 2 uniform entries. If you log out now, the referral will be lost from this device, and so will the uniform entries.",
    refLost);
  const refKept = fn({ isSyncing: true, uniform: 1, stored: true, referrals: 2 });
  check("...and with the entries kept on this device, the referrals are lost and the entry is said to wait",
    refKept === "Not saved yet: 2 referrals, and 1 uniform entry. If you log out now, the referrals will be lost from this device; "
      + "the uniform entry waits on this device and will be sent the next time you sign in here.", refKept);
  check("...a referral alone reads as before",
    fn({ isSyncing: true, uniform: 0, stored: true, referrals: 1 }) === "Not saved yet: 1 referral. If you log out now, it will be lost from this device.");
}

console.log("\nA refused press stops, and says why");
{
  const w = queueWorld({ students: [ROSA], answer: () => ({ ok: false, refused: true, reason: "No student has number 12001." }) });
  w.api.pick(ROSA); w.api.commitUniformViolation(false);
  await w.settle();
  check("a press the server will never take leaves the queue and is named in a toast",
    w.api.uniformQueueLength() === 0 && w.toasts.some((t) => t.kind === "error" && /NOT logged: Rosa Rodriguez\. No student has number 12001\./.test(t.m)));
}

console.log("\nTimes are the school's, and Undo after the list asks why");
{
  const w = queueWorld({ students: [ROSA], answer: okAnswer });
  check("the LA time format: 14:52 UTC on 10/13 reads 7:52 AM (this machine is in Tokyo)",
    w.api.uvClock("2026-10-13T14:52:00.000Z") === "7:52 AM" && w.api.uvClock("2026-11-02T15:52:00.000Z") === "7:52 AM"
      && w.api.uvClock("nope") === "", w.api.uvClock("2026-10-13T14:52:00.000Z"));
  const block = js2.slice(js2.indexOf("// UNIFORM VIOLATIONS"), js2.indexOf("function wcDaysAgoLabel"))
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no uniform time is read as the UTC hour any more (both old call sites)", !/\.slice\(11,\s*16\)/.test(block));

  const asked = [];
  const onList = queueWorld({ students: [ROSA], answer: okAnswer, today: [{ id: "uv1", onList: true }, { id: "uv2", onList: false }],
    prompt: async (m) => { asked.push(m); return asked.length === 1 ? "" : "Logged by mistake"; } });
  await onList.api.undoUniformViolation("uv1");
  check("a void after the list is made needs a reason: a blank one sends nothing", asked.length === 1 && onList.calls.length === 0);
  await onList.api.undoUniformViolation("uv1");
  const sentVoid = onList.calls.find((c) => c.path === "uniformViolations:voidEntry")?.args;
  check("...and the reason typed is what the server is sent", sentVoid && sentVoid.id === "uv1" && sentVoid.reason === "Logged by mistake", JSON.stringify(sentVoid));
  await onList.api.undoUniformViolation("uv2");
  const quick = onList.calls.filter((c) => c.path === "uniformViolations:voidEntry")[1]?.args;
  check("before the list is made, Undo is still one tap", asked.length === 2 && quick && quick.id === "uv2" && !("reason" in quick));
}

clock.real();

console.log("\nThe queue is wired into the page");
{
  const code = js2.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const busy = code.slice(code.indexOf("function screenHasUnfinishedWork()"), code.indexOf("function screenHasUnfinishedWork()") + 900);
  check("an unsent queue counts as unfinished work on screen", /if \(_uvQueue\.length\) return true;/.test(busy));
  check("and holds an update reload, past the busy deadline (wildcat-update.js)",
    /unconfirmedUniform: uniformQueueLength\(\) > 0,/.test(code) && /unconfirmedUniformAgeMs: oldestUniformQueuedAgeMs\(\),/.test(code));
  check("a staff sign-in sends what this person left unsent", /resumeUniformQueue\(me\.email\)/.test(code));
  check("sign-out (and any session end) takes it off this tab", /forgetUniformQueue\(\);/.test(code.slice(code.indexOf("async function logout("))) && /'wildcat-auth-signout', async function \(\) \{\s*if \(typeof forgetUniformQueue === 'function'\) forgetUniformQueue\(\);/.test(code));
  check("Logout names unsent uniform entries before anyone signs out", /uniform entr/.test(code.slice(code.indexOf("function unsavedWorkAtLogout()"), code.indexOf("function unsavedWorkAtLogout()") + 1600)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
