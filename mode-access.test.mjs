// Who may enter which mode.
//
// A teacher logged in, opened the sidebar mode dropdown, picked Wildcat Cash,
// and landed on Award Cash with no students and "Wildcat Cash is limited to
// super admins" where the roster should be. The choice was then saved per user
// and restored on every later sign-in, overruling the Raffle forcing that runs
// at sign-in. These assertions are that trap, taken apart.
//
// Run: npm test

import { readFileSync } from "node:fs";

const modesSrc = readFileSync(new URL("./wildcat-modes.js", import.meta.url), "utf8");
new Function(modesSrc)();
const M = globalThis.WildcatModes;

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

// Comment text is not behaviour; strip it so a rewritten explanation cannot
// pass an assertion about code.
const code = script
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\nThe launch policy: Cash and Discipline for staff");
{
  // Westbrook opens 2026-09-09 on Wildcat Cash and Discipline. Raffle and Claw
  // Pass work; they are not what the school is running, and a teacher handed
  // four modes on day one picks the wrong one in front of a class.
  for (const role of ["teacher", "campusaide", "pbis"]) {
    check(`${role} gets Wildcat Cash`, M.canUseMode(role, "cash") === true);
    check(`${role} gets Discipline`, M.canUseMode(role, "discipline") === true);
    check(`${role} does NOT get Raffle`, M.canUseMode(role, "raffle") === false);
    check(`${role} does NOT get Claw Pass`, M.canUseMode(role, "hallpass") === false);
    check(`${role} is offered exactly those two, in dropdown order`,
      M.modesFor(role).join(",") === "cash,discipline");
  }

  // Admins keep everything: they are the ones testing what staff cannot see.
  for (const role of ["admin", "superadmin"]) {
    check(`${role} keeps all four modes`,
      M.modesFor(role).join(",") === "raffle,cash,hallpass,discipline");
  }

  check("Cash is no longer superadmin-only, which is the reversal from 2026-09-04",
    M.canUseMode("teacher", "cash") === true && M.canUseMode("admin", "cash") === true);
  check("modesFor returns dropdown order, not storage order",
    M.ALL_MODES[0] === "raffle");
  check("the launch set is named rather than implied",
    Array.isArray(M.LAUNCH_MODES) && M.LAUNCH_MODES.join(",") === "cash,discipline");
}

console.log("\nWhere somebody lands with no saved preference");
{
  // Launch day is Cash, so that is where everyone starts -- including admins,
  // who can switch. A hardcoded landing mode in script.js is what this
  // replaces, and it named Raffle.
  for (const role of ["teacher", "campusaide", "pbis", "admin", "superadmin"]) {
    check(`${role} lands on Wildcat Cash`, M.defaultModeFor(role) === "cash");
    check(`and it is a mode ${role} may actually open`,
      M.canUseMode(role, M.defaultModeFor(role)));
  }
  check("an unknown role also lands somewhere it is allowed",
    M.canUseMode("registrar", M.defaultModeFor("registrar")));
}

console.log("\nRole is read tolerantly, because it comes from stored records");
{
  check("case does not matter", M.canUseMode("SuperAdmin", "raffle") === true);
  check("stray whitespace does not matter", M.canUseMode(" admin ", "hallpass") === true);
  check("a missing role is not an admin", M.canUseMode(undefined, "raffle") === false);
  check("nor is an empty one", M.canUseMode("", "hallpass") === false);
  check("an unknown role gets the launch set, not everything",
    M.modesFor("registrar").join(",") === "cash,discipline");
  check("an unknown MODE is refused rather than allowed",
    M.canUseMode("superadmin", "bank") === false);
}

console.log("\nA saved preference is not an entitlement");
{
  // THE TRAP. getSavedTeacherMode fed initSidebarShell, which restored the
  // stored mode on every sign-in, after establishTeacherSessionCore had forced
  // the account back to Raffle. Without this filter one click is permanent.
  const fn = code.slice(code.indexOf("function getSavedTeacherMode()"));
  const body = fn.slice(0, fn.indexOf("\n        }"));
  check("getSavedTeacherMode filters the stored value through the rule",
    /modeAllowed\(val\)/.test(body));
  check("and returns null rather than the disallowed mode",
    /if\s*\(!modeAllowed\(val\)\)[\s\S]{0,220}return null;/.test(body));
}

console.log("\nThe mode is not offered in the first place");
{
  const fn = code.slice(code.indexOf("function updateSidebarModeUI()"));
  const body = fn.slice(0, fn.indexOf("\n        }\n"));
  check("the dropdown filters MODE_META by the rule",
    /Object\.entries\(MODE_META\)\s*\.?\s*\n?\s*\.filter\(\(\[key\]\)\s*=>\s*modeAllowed\(key\)\)/.test(body)
    || /Object\.entries\(MODE_META\)\.filter\(\(\[key\]\) => modeAllowed\(key\)\)/.test(body));

  const sel = code.slice(code.indexOf("function selectMode(mode)"));
  const selBody = sel.slice(0, sel.indexOf("\n        }"));
  check("selectMode refuses a disallowed mode even if a button reaches it",
    /if\s*\(!modeAllowed\(mode\)\)/.test(selBody));
  check("and refuses BEFORE switchSystemMode persists it",
    selBody.indexOf("modeAllowed(mode)") < selBody.indexOf("switchSystemMode(mode)"));
}

console.log("\nThe tab gate shares the rule instead of restating it");
{
  check("switchTab no longer hardcodes its own superadmin comparison for cash",
    /cashTabs\.includes\(tabName\)[^\n]*!modeAllowed\('cash'\)/.test(code));
  check("role !== 'superadmin' is gone from the cash gate",
    !/cashTabs\.includes\(tabName\)[^\n]*role !== 'superadmin'/.test(code));
  check("and reaching it recovers to a mode the person may open, not a hardcoded one",
    /\[cash\][\s\S]{0,400}switchSystemMode\(allowedModeOrDefault\(\)\)/.test(code));
  check("no landing decision in the app hardcodes a mode name",
    !/selectMode\('raffle'\)/.test(code) && !/switchSystemMode\('raffle'\)/.test(code));
  check("the sign-in path asks the rules where to land",
    /switchSystemMode\(getSavedTeacherMode\(\) \|\| allowedModeOrDefault\(\)\)/.test(code));
  check("allowedModeOrDefault falls back only when the rules module is absent",
    /function allowedModeOrDefault\(\)[\s\S]{0,300}return 'raffle';[\s\S]{0,200}defaultModeFor/.test(code));
}

console.log("\nThe rules module cannot lock anyone out by failing to load");
{
  // Fail OPEN. This is navigation courtesy; enforcement is switchTab and
  // Convex. A script that 404s must cost a stale menu entry, not the app.
  const fn = code.slice(code.indexOf("function modeAllowed(mode)"));
  const body = fn.slice(0, fn.indexOf("\n        }"));
  check("modeAllowed returns true when WildcatModes is absent",
    /if\s*\(!M\s*\|\|\s*typeof M\.canUseMode\s*!==\s*'function'\)\s*return true;/.test(body));
}

console.log("\nThe module is actually served");
{
  check("index.html loads wildcat-modes.js", /<script src="wildcat-modes\.js\?v=/.test(html));
  check("before script.js, which calls into it",
    html.indexOf("wildcat-modes.js") < html.indexOf("script.js?v="));
  const v = (html.match(/wildcat-modes\.js\?v=([^"]+)/) || [])[1];
  const sv = (html.match(/script\.js\?v=([^"]+)/) || [])[1];
  check("on the same cache-busting version as script.js", v && v === sv);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
