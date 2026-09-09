// An author `display` rule silently defeats the `hidden` attribute.
//
// SHIPPED 2026-09-08. `.wc-unsaved-bar { display: flex }` outranked the
// user-agent rule `[hidden] { display: none }`, because a UA declaration loses
// to any author declaration. The unsaved-referral bar was therefore visible to
// every user on every page load -- a fixed red bar announcing an unsaved
// referral that did not exist, offering a Retry for nothing, with no way to
// dismiss it. On launch morning.
//
// The element was correct, the JavaScript was correct (`el.hidden = true`),
// and the markup was correct. Only the stylesheet was wrong, which is why no
// existing test saw it.
//
// This checks EVERY element that carries a bare `hidden` attribute: if any
// class on it sets `display`, that class must also carry a `[hidden]` override.
//
// Run: npm test

import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const sheets = ["styles.css", "wildcat-ui.css", "wildcat-motion.css"]
  .map((f) => { try { return readFileSync(new URL("./" + f, import.meta.url), "utf8"); } catch { return ""; } })
  .join("\n");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

// Every element with a bare `hidden` attribute (not hidden="until-found" etc).
const hiddenEls = [...html.matchAll(/<[^>]*\shidden(?=[\s>])[^>]*>/g)].map((m) => m[0]);

console.log("\n-- the scan found something to check --");
check("at least one element uses the hidden attribute", hiddenEls.length > 0);

console.log("\n-- no hidden element is forced visible by its own CSS --");
{
  let offenders = [];
  for (const tag of hiddenEls) {
    const idM = tag.match(/\bid="([^"]+)"/);
    const clsM = tag.match(/\bclass="([^"]*)"/);
    if (!clsM) continue;
    for (const cls of clsM[1].split(/\s+/).filter(Boolean)) {
      // Rule blocks for this class on its own (not compound selectors, which
      // would need the same treatment but are matched by their own class).
      const blocks = [...sheets.matchAll(
        new RegExp("(^|[,}\\s])\\." + cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g")
      )].map((m) => m[2]);
      const setsDisplay = blocks.some((b) => /(^|;)\s*display\s*:/.test(b));
      if (!setsDisplay) continue;
      const hasOverride =
        sheets.includes("." + cls + "[hidden]") ||
        sheets.includes("[hidden]." + cls);
      if (!hasOverride) offenders.push(`#${idM ? idM[1] : "?"} .${cls}`);
    }
  }
  check(
    offenders.length === 0
      ? "every hidden element's display rule is overridden"
      : `these set display without a [hidden] override: ${offenders.join(", ")}`,
    offenders.length === 0
  );
}

console.log("\n-- the bar that caused this --");
{
  check("the unsaved bar has its [hidden] override",
    /\.wc-unsaved-bar\[hidden\]\s*\{[^}]*display:\s*none/.test(sheets));
  check("the override is !important, so nothing later re-shows it",
    /\.wc-unsaved-bar\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(sheets));
  check("the override is declared BEFORE the display:flex rule it guards",
    sheets.indexOf(".wc-unsaved-bar[hidden]") < sheets.indexOf(".wc-unsaved-bar {"));
  check("the bar still starts hidden in the markup",
    /id="unsavedReferralBar"[^>]*\shidden(\s|>)/.test(html));
  check("it is still toggled with el.hidden, not a style change",
    readFileSync(new URL("./script.js", import.meta.url), "utf8").includes("bar.hidden = true"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
