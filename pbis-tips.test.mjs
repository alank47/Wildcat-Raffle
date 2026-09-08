// The PBIS tips carousel, in the space the cycle notice used to hold.
//
// The banner announced which cycle and week the school was in and that ticket
// counts reset at the end of it. That is Raffle vocabulary, and Raffle is not
// what the school launched on -- so the one permanent fixture in the sidebar
// was explaining a system nobody was using.
//
// THE FAILURE WORTH TESTING is the timer. wcRenderSidebarBanner is called from
// updateAllDisplays, which runs on every repaint: every tab switch, every
// award, every save. An interval started there without clearing the last one
// leaves a timer per repaint, all writing to the same element, and the card
// flicks faster the longer somebody uses the app.
//
// Run: npm test

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

const raw = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const code = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

// Run the real rotation logic against a fake clock and DOM.
const slice = code.slice(code.indexOf("const PBIS_TIPS = ["),
                         code.indexOf("function wcRenderSidebarBanner()"));
const harness = () => {
  const state = { intervals: 0, cleared: 0, live: new Set(), nextId: 1 };
  const fn = new Function("state", `
    const escapeHtml = (s) => String(s);
    const document = { getElementById: () => null };
    const setInterval = (f, ms) => { state.intervals++; const id = state.nextId++; state.live.add(id); return id; };
    const clearInterval = (id) => { if (state.live.delete(id)) state.cleared++; };
    const setTimeout = (f) => f();
    // The module exports wcShowTip onto window for the dot handlers. Stubbed
    // rather than stripped, so the test runs the shipped body unaltered.
    const window = {};
    ${slice}
    return { PBIS_TIPS, wcTipStartIndex, wcAdvanceTip, wcStartTipTimer, wcShowTip,
             idx: () => _pbisTipIndex, setIdx: (v) => { _pbisTipIndex = v; },
             PBIS_TIP_MS };
  `);
  return { api: fn(state), state };
};

console.log("\nThe tips themselves");
{
  const { api } = harness();
  check("there are enough not to repeat within a fortnight", api.PBIS_TIPS.length >= 10);
  check("every one has a title and a body",
    api.PBIS_TIPS.every((t) => t.title && t.body));
  check("titles are short enough for a narrow sidebar",
    api.PBIS_TIPS.every((t) => t.title.length <= 34));
  check("none is longer than somebody will read in a sidebar",
    api.PBIS_TIPS.every((t) => t.body.length <= 190));
  check("they are all distinct",
    new Set(api.PBIS_TIPS.map((t) => t.title)).size === api.PBIS_TIPS.length);

  // Written for THIS school: the four expectations are the four buttons in
  // Award Cash, so a tip naming one is naming what the teacher is about to click.
  const all = api.PBIS_TIPS.map((t) => `${t.title} ${t.body}`).join(" ");
  check("they use the school's own expectations, not generic advice",
    /Be Safe/.test(all) && /Be Responsible/.test(all) && /Be Respectful/.test(all));
  check("and reference the app's own controls", /notes field/i.test(all));
}

console.log("\nOne timer, however many repaints");
{
  const { api, state } = harness();
  for (let i = 0; i < 25; i++) api.wcStartTipTimer();
  check("25 repaints leave exactly one live timer", state.live.size === 1);
  check("and each start cleared the one before", state.cleared === 24);
  check("the handle is held outside the render function",
    /let _pbisTipTimer = null;/.test(code));
  check("and cleared before every start",
    /if \(_pbisTipTimer !== null\) clearInterval\(_pbisTipTimer\);/.test(code));
}

console.log("\nRotation wraps and holds its place");
{
  const { api } = harness();
  api.setIdx(0);
  for (let i = 0; i < api.PBIS_TIPS.length; i++) api.wcAdvanceTip(1);
  check("a full lap returns to the first tip", api.idx() === 0);
  api.wcAdvanceTip(-1);
  check("and it wraps backwards without going negative",
    api.idx() === api.PBIS_TIPS.length - 1);
  api.wcShowTip(3);
  check("clicking a dot jumps to that tip", api.idx() === 3);
  check("and restarts the clock, so a click is not cut short",
    /function wcShowTip[\s\S]{0,260}wcStartTipTimer\(\)/.test(code));
}

console.log("\nEverybody sees the same tip at the same moment");
{
  const { api } = harness();
  const a = api.wcTipStartIndex(), b = api.wcTipStartIndex();
  check("the starting tip is stable within a day", a === b);
  check("it is in range", a >= 0 && a < api.PBIS_TIPS.length);
  check("and derived from the date, not from random",
    /Math\.floor\(Date\.now\(\) \/ 86400000\)/.test(code) &&
    !/Math\.random\(\)/.test(code.slice(code.indexOf("function wcTipStartIndex"),
                                       code.indexOf("function wcPaintTip"))));
}

console.log("\nIt does not rebuild itself out from under the reader");
{
  check("the markup is built once, then only the timer is kept alive",
    /if \(!el\.querySelector\('\.pbis-tip'\)\)/.test(code));
  check("hovering pauses it", /mouseenter[\s\S]{0,140}clearInterval/.test(code));
  check("and leaving resumes", /mouseleave', wcStartTipTimer/.test(code));
  check("keyboard focus pauses it too", /focusin[\s\S]{0,140}clearInterval/.test(code));
}

console.log("\nPresentation");
{
  check("the body has a fixed floor, so the sidebar does not jump between tips",
    /\.pbis-tip-body \{[^}]*min-height/.test(css));
  check("the fade is a class, so CSS can switch it off",
    /\.pbis-tip-body\.is-out \{ opacity: 0; \}/.test(css));
  check("reduced motion gets the tips without the fade",
    /prefers-reduced-motion[\s\S]{0,220}\.pbis-tip-body\.is-out \{ opacity: 1; \}/.test(css));
  check("dots are reachable by keyboard", /\.pbis-dot:focus-visible/.test(css));
  check("each dot names its tip for a screen reader",
    /aria-label="' \+ escapeHtml\(t\.title\)/.test(code));
}

console.log("\nThe cycle system itself is untouched");
{
  // "not right away" is not "never" -- when Raffle starts this is a decision to
  // revisit, not damage to repair.
  check("currentCycle still drives the app", (code.match(/currentCycle/g) || []).length > 20);
  check("cycleDuration too", (code.match(/cycleDuration/g) || []).length > 20);
  check("the topbar cycle badge still renders", /function updateCycleBadge\(/.test(code));
  check("and the banner no longer talks about ticket resets",
    !/Every ticket count resets/.test(code));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
