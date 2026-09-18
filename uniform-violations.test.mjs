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
//   - THE LOCAL SCHOOL DAY. A server-side UTC date rolls over at 5pm Pacific,
//     so an after-school entry would be filed against tomorrow.
//   - THAT ABSENT DATA IS NEVER RENDERED AS A GOOD RESULT, the refusal
//     attendanceRanking already makes.
import { readFileSync } from "node:fs";
import ts from "typescript";

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
  ["dayToEpoch", "dayMinus", "dayVerdict", "windowStart", "duplicateVerdict",
   "mayLogUniform", "mayReadUniform"].map(lift).join("\n") +
  // The module-level constants the lifted functions close over. Taken from
  // the shipped source by regex rather than retyped, so a change to either
  // the role list or the day pattern fails here instead of drifting.
  "\n" + ruleSrc.match(/^export const UNIFORM_LOG_ROLES = .*$/m)[0].replace("export ", "").replace(" as const", "") +
  "\n" + ruleSrc.match(/^export const UNIFORM_READ_ROLES = .*$/m)[0].replace("export ", "").replace(" as const", "") +
  "\n" + ruleSrc.match(/^export const MAX_WINDOW_DAYS = .*$/m)[0].replace("export ", "") +
  "\n" + ruleSrc.match(/^export const DAY_SLACK = .*$/m)[0].replace("export ", "") +
  "\n" + ruleSrc.match(/^const DAY_RE = .*$/m)[0],
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText;
const [dayToEpoch, dayMinus, dayVerdict, windowStart, duplicateVerdict, mayLogUniform, mayReadUniform] =
  new Function(js + "\nreturn [dayToEpoch, dayMinus, dayVerdict, windowStart, duplicateVerdict, mayLogUniform, mayReadUniform];")();

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

console.log("\nThe day of a violation is the LOCAL school day, validated and clamped");
{
  // A server-side UTC date rolls over at 5pm Pacific: an after-school entry
  // would land on tomorrow's list.
  const now = "2026-09-18T20:00:00.000Z";   // 1pm Pacific
  check("today is accepted", dayVerdict("2026-09-18", now).ok === true);
  check("yesterday is accepted, for a timezone behind UTC", dayVerdict("2026-09-17", now).ok === true);
  check("tomorrow is accepted, for one ahead", dayVerdict("2026-09-19", now).ok === true);
  check("last week is refused", dayVerdict("2026-09-10", now).ok === false);
  check("and the refusal says how far off it is", /8 days from the server's date/.test(dayVerdict("2026-09-10", now).reason));
  check("a non-day is refused", dayVerdict("yesterday", now).ok === false);
  check("an empty day is refused", dayVerdict("", now).ok === false);
  check("a date that does not exist is refused", dayToEpoch("2026-02-31") === null);
  check("a real leap day is not", dayToEpoch("2028-02-29") !== null);
  check("month 13 is refused", dayToEpoch("2026-13-01") === null);
  check("a timestamp is not a day", dayToEpoch("2026-09-18T10:00:00Z") === null);
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
    let _uvTruncated = false, _uvBusy = false, _uvPick = null, _uvMatches = [], _uvHighlight = -1;
    let _uvPickSummary = null;
    const _uvUnsaved = new Map();
    let renderCalls = 0;
    function renderUniformViolations() { renderCalls++; }
    ${["wcIsoDay", "uniformSettingsNow", "uniformWindowStart", "refreshUniformData",
       "uniformPickerMatches", "uniformCountFor", "wcOrdinalSuffix", "wcDaysAgoLabel"].map(liftFn).join("\n")}
    return {
      refreshUniformData, uniformWindowStart, uniformSettingsNow,
      uniformPickerMatches, uniformCountFor, wcOrdinalSuffix, wcDaysAgoLabel, wcIsoDay,
      state: () => ({ today: _uvToday, counts: _uvCounts, loaners: _uvLoaners, truncated: _uvTruncated, renderCalls }),
    };
  `;
  return { api: new Function("stubs", "D", body)(stubs, D), calls, el };
}

/** The day, formatted as the app formats it, from the real clock. */
const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const TODAY = dayOf(new Date());
const daysBack = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return dayOf(d); };

console.log("\nThe refresh actually runs, and asks for the right day");
{
  const { api, calls } = harness({});
  let threw = null;
  await api.refreshUniformData().catch((e) => { threw = e; });
  // THE ASSERTION THAT WAS MISSING. It fails on the shipped bug with
  // "Cannot access 'day' before initialization".
  check("it does not throw", threw === null, threw && threw.message);
  check("it asked all three queries", calls.length === 3);

  const forDay = calls.find((c) => c.path === "uniformViolations:forDay");
  check("forDay was called", Boolean(forDay));
  check("and it was given a REAL day, not undefined",
    Boolean(forDay) && forDay.args.day === TODAY,
    forDay ? JSON.stringify(forDay.args) : "no call");

  const counts = calls.find((c) => c.path === "uniformViolations:counts");
  check("counts was given today", Boolean(counts) && counts.args.today === TODAY);
  check("and a window start 13 days earlier, so today is the 14th day",
    Boolean(counts) && counts.args.sinceDay === daysBack(13),
    counts ? String(counts.args.sinceDay) + " wanted " + daysBack(13) : "no call");
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

console.log("\nThe window is the settings window, counted back from today");
{
  const wide = harness({ settings: { windowDays: 30, concerningAt: 2, habitAt: 3 } });
  check("a 30-day window starts 29 days ago", wide.api.uniformWindowStart() === daysBack(29));
  const one = harness({ settings: { windowDays: 1, concerningAt: 1, habitAt: 1 } });
  check("a one-day window is today itself", one.api.uniformWindowStart() === TODAY);
  const junk = harness({ settings: { windowDays: "lots" } });
  check("a junk window falls back to the 14-day default", junk.api.uniformWindowStart() === daysBack(13));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
