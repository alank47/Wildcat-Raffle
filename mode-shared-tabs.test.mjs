// Shared sidebar tabs must stay reachable while a mode is selected.
//
// THE BUG. Discipline Mode carried two stylesheet rules:
//
//   body.discipline-mode .content > .tab-content { display: none !important; }
//   body.discipline-mode #disciplineContent      { display: block !important; }
//
// switchTab() clears those inline so a shared tab can open while a mode is on.
// An !important stylesheet rule beats an inline style, so every Insights and
// Admin item ran its JavaScript, marked its pane active, and stayed invisible:
// Data & Analytics, Audit Log, Students, Teachers, Settings and System Admin
// were all unreachable from Discipline Mode with no error to explain it.
//
// Claw Pass never had these rules and never had the bug, which is the evidence
// they were redundant rather than load-bearing.
//
// Run: npm test

import { readFileSync } from "node:fs";

// Comments are STRIPPED before matching. The fix's own comment quotes the two
// rules it deleted, so a plain text search reports them as still present — the
// assertion has to be about CSS, not about the file's characters.
const cssRaw = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\nNo stylesheet rule blanket-hides the shared panes");
{
  check("discipline mode does not force .tab-content hidden",
    !/body\.discipline-mode\s+\.content\s*>\s*\.tab-content/.test(css));
  // Guard the stripper itself: if it silently stopped working, every
  // assertion above it would pass for the wrong reason.
  check("comment stripping actually removed something",
    cssRaw.length > css.length && /\/\*/.test(cssRaw));
  check("nor force its own container visible with !important",
    !/body\.discipline-mode\s+#disciplineContent\s*\{[^}]*!important/.test(css));
  // No other mode may grow the same rule.
  check("no mode blanket-hides .content > .tab-content",
    !/\.content\s*>\s*\.tab-content\s*\{\s*display:\s*none\s*!important/.test(css));
}

console.log("\nThe raffle nav is still hidden, which is what the rule was for");
{
  check("discipline mode still hides .tabs",
    /body\.discipline-mode\s+\.tabs\s*\{\s*display:\s*none\s*!important/.test(css));
  // #modeNav carries .tabs; the shared sidebar navs deliberately do not, so
  // hiding .tabs must not take Insights and Admin with it.
  check("#modeNav carries .tabs, so it is covered",
    /<nav class="tabs sidebar-nav" id="modeNav">/.test(html));
  check("the Insights nav does NOT carry .tabs, so it survives",
    /<div class="sidebar-label">Insights<\/div>\s*<nav class="sidebar-nav">/.test(html));
  check("neither does the Admin nav",
    /<div class="sidebar-label admin-only">Admin<\/div>\s*<nav class="sidebar-nav">/.test(html));
}

console.log("\nThe JavaScript that actually does the hiding is still there");
{
  // With the CSS gone, these inline styles are the only mechanism, so their
  // removal would silently reintroduce overlapping panes.
  check("switchTab restores pane visibility when leaving a mode view",
    /document\.querySelectorAll\('#mainApp \.content \.tab-content'\)\.forEach\(el => el\.style\.display = ''\)/.test(script));
  check("and hides the mode container",
    /if \(dc\) dc\.style\.display = 'none';/.test(script));
  check("entering a mode hides the shared panes inline",
    /contentContainer\.querySelectorAll\('\.tab-content'\)\.forEach\(el => el\.style\.display = 'none'\)/.test(script));
  check("returning to a mode subtab restores its container",
    /if \(container\) container\.style\.display = 'block';/.test(script));
}

console.log("\nThe shared tabs the user could not reach");
{
  // Named individually: these are the ones that were dead, and a regression
  // here is invisible until somebody clicks.
  ["data", "audit", "students", "teachers", "settings", "loginActivity", "system"]
    .forEach((tab) => {
      check(`'${tab}' is wired to switchTab`,
        new RegExp(`onclick="switchTab\\('${tab}'\\)"`).test(html));
    });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
