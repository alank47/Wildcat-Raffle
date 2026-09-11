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
  check("and hides every mode container, from the table",
    /Object\.values\(MODE_CONTAINERS\)\.forEach/.test(script));
  check("entering a mode hides the shared panes inline",
    /contentContainer\.querySelectorAll\('\.tab-content'\)\.forEach\(el => el\.style\.display = 'none'\)/.test(script));
  check("returning to a mode subtab restores its container",
    /if \(container\) container\.style\.display = 'block';/.test(script));
}

console.log("\nEvery mode, not just the two that were named");
{
  // THE SECOND VERSION OF THIS BUG, found 2026-09-11 and reported as
  // "settings for admin only exist in raffle mode". The CSS was fixed for
  // Discipline in the round above; the JAVASCRIPT still named two modes:
  //
  //   bodyCls.contains('hallpass-mode') || bodyCls.contains('discipline-mode')
  //
  // So in Academics the restore never ran. #academicsContent stayed up, the
  // chosen pane never appeared, and clicking Settings, Students or Teachers
  // did NOTHING -- no error, no hint, the button simply did not work. The
  // third hardcoded two-mode conditional to break a third mode in one day.
  const code = script.replace(/\/\*[\s\S]*?\*\//g, "")
                     .replace(/^\s*\/\/[^\n]*$/gm, "");
  check("the restore asks a table which modes take over the screen",
    /Object\.keys\(MODE_CONTAINERS\)\s*\n?\s*\.some\(\(m\) => bodyCls\.contains\(m \+ '-mode'\)\)/
      .test(code.replace(/\s+/g, " ")) ||
    /MODE_CONTAINERS[\s\S]{0,80}bodyCls\.contains\(m \+ '-mode'\)/.test(code));
  check("and no surviving code names two modes to decide it",
    !/contains\('(hallpass|discipline|academics)-mode'\)\s*\|\|\s*bodyCls\.contains\('/.test(code));

  // THE ASSERTION THAT WOULD HAVE CAUGHT ALL THREE. Every mode that takes
  // over the screen must appear in the one table the restore consults.
  const modes = [...(readFileSync(new URL("./wildcat-modes.js", import.meta.url), "utf8")
    .match(/var ALL_MODES = \[([^\]]+)\]/)?.[1] ?? "")
    .matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const table = (code.match(/const MODE_CONTAINERS = \{([\s\S]*?)\};/) || [])[1] || "";
  check("ALL_MODES was found", modes.length >= 5);
  // raffle and cash have no container of their own -- they ARE the shell.
  const takeOver = modes.filter((m) => m !== "raffle" && m !== "cash");
  takeOver.forEach((m) =>
    check(`'${m}' is in MODE_CONTAINERS, so a shared tab can escape it`,
      new RegExp(`\\b${m}:`).test(table)));
  check("and every container in the table exists in the markup",
    [...table.matchAll(/'(\w+)'/g)].map((x) => x[1])
      .every((id) => html.includes(`id="${id}"`)));
}

console.log("\nThe superadmin gate was a typo, and typos do not gate");
{
  // FOUND 2026-09-11 while answering a different question. Three settings
  // panes and their three chips carried class="superadmin-only". The gate is
  // applied by querySelectorAll('.super-admin-only') -- with a hyphen -- so
  // the misspelling matched nothing and was never disabled for anyone.
  //
  // Backup & Security, School Branding and School Year Rollover were therefore
  // reachable by all four admins rather than the two superadmins. School Year
  // Rollover is destructive. Not open to teachers, because #settingsTab is
  // correctly .admin-only, so the exposure was admin-versus-superadmin.
  check("no element carries the inert spelling",
    !/class="[^"]*(?<!-)\bsuperadmin-only\b/.test(html));
  ["backupSettingsSubtab", "brandingSettingsSubtab", "schoolyearSettingsSubtab",
   "backupSettingsContent", "brandingSettingsContent", "schoolyearSettingsContent"]
    .forEach((id) => {
      const tag = (html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`)) || [])[0] || "";
      check(`#${id} carries the gate that actually works`,
        /\bsuper-admin-only\b/.test(tag));
    });
  // And the gate has to be a class the JS really looks for.
  check("the JS disables exactly that class",
    /querySelectorAll\('\.super-admin-only'\)/.test(script));
  check("and .disabled really hides it", /\.super-admin-only\.disabled \{[^}]*display: none/.test(cssRaw));
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
