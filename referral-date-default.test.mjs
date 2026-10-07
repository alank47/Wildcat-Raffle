// The referral form's default date and time. Run: npm test
//
// TWO BUGS AND ONE THAT A FIX WOULD HAVE ADDED.
//
//   1. The default date was toISOString().split('T')[0], which is UTC. From
//      5pm in Los Angeles (4pm in winter) that is already tomorrow, so a
//      referral written after school defaulted to a day that had not happened.
//   2. A default was only ever filled into an EMPTY field. The Submit tab
//      stays open all day; a tab left open overnight filed the next morning's
//      referral under yesterday's date.
//   3. The obvious fix, refilling the time when the form clears after a
//      submit, would stamp that moment's time on the NEXT referral, written
//      however much later, because the tab stays on the form.
//
// So defaults carry a mark (data-auto="1"), are refreshed when the tab opens
// and when a student is picked, and a value the teacher typed is never
// overwritten.
//
// THE SHIPPED CODE RUNS: clearReferralForm, applyReferralWhenDefaults,
// referralWhenTyped and the event wiring are lifted out of script.js and run
// against a fake DOM with a fake clock. Every "TEETH" check breaks the code on
// purpose and shows the assertion catches it.

process.env.TZ = "America/Los_Angeles";

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const discSrc = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");
const D = (() => { const sb = {}; new Function("globalThis", discSrc).call(sb, sb); return sb.WildcatDiscipline; })();

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

function liftFn(src, name) {
  const m = new RegExp("\\n        (?:async )?function " + name + "\\(").exec(src);
  if (!m) throw new Error("missing function " + name);
  const start = m.index + 1;
  const end = src.indexOf("\n        }\n", start);
  if (end < 0) throw new Error("unterminated function " + name);
  return src.slice(start, end + 10);
}
function breakOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`teeth "${label}": anchor not found exactly once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}
/** The top-level listener wiring for the date and time, as shipped. */
function liftWiring(src) {
  const from = src.indexOf("        document.addEventListener('input', referralWhenTyped);");
  if (from < 0) throw new Error("missing the input listener");
  const end = src.indexOf("\n        });\n", from);
  return src.slice(from, end + 13);
}
const codeOnly = (fn) => fn.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const FORM = ["referralStudentSelect", "referralStudentScope", "referralStudentSearch", "referralDate", "referralTime",
  "referralLocation", "referralBehaviorType", "referralDescription", "referralAdditionalActions", "referralSevereBypass"];

/**
 * The referral form, lifted. `at(iso)` sets the clock; `open()` is what the
 * Submit tab does on opening; `clear()` is what a submit does after saving;
 * `pick()`, `type()` are the teacher.
 */
function makeForm(src = script) {
  const clock = { now: 0 };
  const els = {};
  FORM.forEach((id) => { els[id] = { id, value: "", checked: false, dataset: {} }; });
  const handlers = { input: [], change: [] };
  const document = {
    getElementById: (id) => els[id] || null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
  };
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.now); }
    static now() { return clock.now; }
  }
  const body = `
    function populateReferralStudentDropdown() {}
    function updateInterventionCount() {}
    function populateReferringStaffDropdown() {}
    ${liftFn(src, "clearReferralForm")}
    ${liftFn(src, "applyReferralWhenDefaults")}
    ${liftFn(src, "referralWhenTyped")}
    ${liftWiring(src)}
    return { clearReferralForm, applyReferralWhenDefaults };
  `;
  const fns = new Function("document", "window", "Date", body)(document, { WildcatDiscipline: D }, FakeDate);
  const fire = (type, el) => (handlers[type] || []).forEach((h) => h({ target: el, type }));
  return {
    els,
    at(iso) { clock.now = Date.parse(iso); return this; },
    // switchDisciplineTab('submit') calls exactly this; checked statically below.
    open() { fns.applyReferralWhenDefaults(new FakeDate()); return this; },
    clear() { fns.clearReferralForm(); return this; },
    pick() { els.referralStudentSelect.value = "S1"; fire("input", els.referralStudentSelect); fire("change", els.referralStudentSelect); return this; },
    type(id, value) { els[id].value = value; fire("input", els[id]); fire("change", els[id]); return this; },
    get date() { return els.referralDate.value; },
    get time() { return els.referralTime.value; },
  };
}

console.log("\n-- the default is the Los Angeles day --");
{
  const f = makeForm().at("2026-10-07T18:30:00-07:00").open();
  check("opening the form at 6:30pm gives the 7th, though UTC is on the 8th", f.date === "2026-10-07", f.date);
  check("and the time on the Los Angeles clock", f.time === "18:30", f.time);
  check("both are marked as defaults", f.els.referralDate.dataset.auto === "1" && f.els.referralTime.dataset.auto === "1");
  const g = makeForm().at("2026-10-07T18:30:00-07:00").clear();
  check("clearing after a submit at 6:30pm also gives the 7th", g.date === "2026-10-07", g.date);
}

console.log("\n-- a second referral gets its own time, not the last one's --");
{
  const f = makeForm().at("2026-10-07T07:50:00-07:00").open();
  f.at("2026-10-07T07:52:00-07:00").pick();
  check("picking the first student brings the time up to that moment", f.time === "07:52", f.time);
  f.at("2026-10-07T08:00:00-07:00").clear();
  check("the clear after submitting does NOT refill the time", f.time === "", f.time);
  check("but leaves today's date in place", f.date === "2026-10-07");
  f.at("2026-10-07T09:30:00-07:00").pick();
  check("the next referral, started at 9:30 without touching the fields, says 9:30, not 8:00",
    f.time === "09:30", f.time);

  // The first referral's time was TYPED (so it lost its mark). The clear must
  // still hand the next referral a default, not the typed value or a blank
  // that nothing refills.
  const g = makeForm().at("2026-10-07T07:50:00-07:00").open();
  g.type("referralTime", "07:40");
  g.at("2026-10-07T08:00:00-07:00").clear().at("2026-10-07T09:30:00-07:00").pick();
  check("a time typed on the first referral does not carry to the second", g.time === "09:30", g.time);
}

console.log("\n-- what the teacher typed is theirs --");
{
  const f = makeForm().at("2026-10-07T09:00:00-07:00").open();
  f.type("referralDate", "2026-10-06");
  check("typing removes the default mark", f.els.referralDate.dataset.auto === undefined);
  f.at("2026-10-07T09:45:00-07:00").pick();
  check("picking a student later keeps the typed date", f.date === "2026-10-06", f.date);
  check("while the untouched time still moves to now", f.time === "09:45", f.time);
  f.type("referralTime", "08:15");
  f.at("2026-10-07T10:00:00-07:00").pick();
  check("and a typed time is kept too", f.time === "08:15", f.time);
  f.at("2026-10-07T10:05:00-07:00").open();
  check("reopening the tab does not overwrite either",
    f.date === "2026-10-06" && f.time === "08:15", `${f.date} ${f.time}`);
}

console.log("\n-- a default rolls over at Los Angeles midnight --");
{
  const f = makeForm().at("2026-10-07T23:50:00-07:00").open();
  check("late on the 7th it is the 7th", f.date === "2026-10-07");
  f.at("2026-10-08T00:10:00-07:00").pick();
  check("ten minutes after midnight the default is the 8th", f.date === "2026-10-08", f.date);
  check("and the time is now", f.time === "00:10", f.time);
  f.at("2026-10-09T07:30:00-07:00").open();
  check("a tab left open overnight shows the new day when the form is opened", f.date === "2026-10-09", f.date);
}

console.log("\n-- the wiring --");
{
  const tab = script.slice(script.indexOf("        function switchDisciplineTab("), script.indexOf("            } else if (subtab === 'review') {"));
  check("opening the Submit tab applies the defaults", /applyReferralWhenDefaults\(new Date\(\)\)/.test(tab));
  check("neither the tab nor the clear reads a UTC day",
    !/toISOString\(\)\.split\('T'\)\[0\]/.test(codeOnly(tab)) &&
    !/toISOString\(\)\.split\('T'\)\[0\]/.test(codeOnly(liftFn(script, "clearReferralForm"))));
  check("severe-bypass.test.mjs still finds the end of its slice",
    script.split("function clearReferralForm").length === 2 &&
    script.indexOf("function updateInterventionCount") < script.indexOf("function clearReferralForm"));
}

console.log("\n-- TEETH --");
{
  const refill = breakOnce(script, "            if (t) t.dataset.auto = '1';\n",
    "            if (t) t.value = new Date().toTimeString().slice(0, 5);\n", "refill at clear");
  const a = makeForm(refill).at("2026-10-07T07:50:00-07:00").open();
  a.type("referralTime", "07:40");
  a.at("2026-10-07T08:00:00-07:00").clear().at("2026-10-07T09:30:00-07:00").pick();
  check("TEETH: refilling the time at clear stamps 8:00 on the 9:30 referral", a.time !== "09:30", a.time);

  const sticky = breakOnce(script, "if (el.id === 'referralDate' || el.id === 'referralTime') delete el.dataset.auto;",
    "", "typing keeps the mark");
  const b = makeForm(sticky).at("2026-10-07T09:00:00-07:00").open();
  b.type("referralDate", "2026-10-06").at("2026-10-07T09:45:00-07:00").pick();
  check("TEETH: if typing does not clear the mark, the typed date is overwritten", b.date !== "2026-10-06");

  const emptyOnly = breakOnce(script, "if (el.value && el.dataset.auto !== '1') return;", "if (el.value) return;", "empty only");
  const c = makeForm(emptyOnly).at("2026-10-07T23:50:00-07:00").open();
  c.at("2026-10-08T00:10:00-07:00").pick();
  check("TEETH: filling only empty fields keeps yesterday's date after midnight", c.date !== "2026-10-08");

  const utc = breakOnce(script, "fill('referralDate', D.schoolToday(at));",
    "fill('referralDate', at.toISOString().split('T')[0]);", "utc");
  check("TEETH: a UTC default gives tomorrow at 6:30pm",
    makeForm(utc).at("2026-10-07T18:30:00-07:00").open().date !== "2026-10-07");

  const noPick = breakOnce(script, "if (e.target && e.target.id === 'referralStudentSelect') applyReferralWhenDefaults(new Date());",
    "", "pick");
  const d = makeForm(noPick).at("2026-10-07T07:50:00-07:00").open();
  d.at("2026-10-07T08:00:00-07:00").clear().at("2026-10-07T09:30:00-07:00").pick();
  check("TEETH: without the refresh on picking a student the second referral has no time", d.time !== "09:30");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
