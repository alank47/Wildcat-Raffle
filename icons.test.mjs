// The icon sprite, and the shell that no longer speaks in emoji. Run: npm test
//
// wildcat-icons.js is generated from @untitledui/icons by scripts/build-icons.mjs.
// Two things can go wrong silently: a name referenced in markup that the sprite
// does not carry draws NOTHING (an <svg><use> to a missing id is blank, not an
// error), and an emoji creeping back into the shell or the Claw Pass tabs looks
// fine on one machine and like a tofu box on another. Both are pinned here.
//
// Section 3 grows one mode at a time, in the order the overhaul takes them
// (Grilled.md decision 4): the shell and Claw Pass first, Wildcat Cash next.

import assert from "node:assert";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL("./" + f, import.meta.url), "utf8");
const icons = read("wildcat-icons.js");
const html = read("index.html");
const js = read("script.js");

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? "  (" + detail + ")" : ""}`); }
}

console.log("\n1. The sprite");
const spriteMatch = icons.match(/var SPRITE = ("(?:[^"\\]|\\.)*");/);
check("carries an inline sprite", !!spriteMatch);
const sprite = spriteMatch ? JSON.parse(spriteMatch[1]) : "";
const ids = new Set([...sprite.matchAll(/id="wci-([a-z0-9-]+)"/g)].map((m) => m[1]));
check("has at least fifty icons", ids.size >= 50, String(ids.size));
const empty = [...ids].filter((id) => {
  const i = sprite.indexOf(`id="wci-${id}"`);
  const body = sprite.slice(i, sprite.indexOf("</symbol>", i));
  return !/<(path|circle|rect|line|polyline|polygon|ellipse)\b/.test(body);
});
check("every symbol draws something", empty.length === 0, empty.join(","));
check("exposes wcIcon", /window\.wcIcon = wcIcon/.test(icons));
check("hides the sprite from layout and readers", /width:0;height:0/.test(sprite) && /aria-hidden="true"/.test(sprite));

console.log("\n2. Every reference resolves");
const refs = new Set([
  ...[...html.matchAll(/#wci-([a-z0-9-]+)/g)].map((m) => m[1]),
  ...[...js.matchAll(/wcIcon\('([a-z0-9-]+)'/g)].map((m) => m[1]),
]);
check("markup and script reference icons at all", refs.size >= 30, String(refs.size));
const missing = [...refs].filter((r) => !ids.has(r));
check("none point at a name the sprite lacks", missing.length === 0, missing.join(","));

console.log("\n3. The shell and the Claw Pass tabs speak in icons, not emoji");
const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const between = (src, a, b) => {
  const i = src.indexOf(a); const j = src.indexOf(b, i);
  assert.ok(i !== -1 && j !== -1, `${a} .. ${b}`);
  return src.slice(i, j);
};
const shell = between(html, 'id="mainApp"', 'id="modeEmptyState"');
check("no emoji in the app shell (topbar, sidebar)", !emoji.test(shell));
const tabs = between(html, "<!-- Hall Pass Tabs -->", 'id="myClassTab"');
check("no emoji in the Claw Pass tab bar", !emoji.test(tabs));
const cash = between(html, "WILDCAT CASH MODE TABS", 'id="clawPassContent"');
check("no emoji anywhere in Wildcat Cash mode", !emoji.test(cash));
// Panel heads and the class header are containers sized for a 30px glyph, so an
// icon dropped in without its own size rule renders wrong rather than missing.
check("the class header carries an icon, not a glyph", /class-header-icon"><svg class="wc-icon"/.test(cash));
check("and the stylesheet sizes it", /\.class-header-icon \.wc-icon\s*\{/.test(read("wildcat-ui.css")));
const modes = between(js, "const MODE_META = {", "};");
check("no emoji in the mode table", !emoji.test(modes));
const subtabs = between(js, "const MODE_SUBTABS = {", "};");
check("no emoji in the sub-nav table", !emoji.test(subtabs));
check("the sprite loads before script.js", html.indexOf("wildcat-icons.js") < html.indexOf('src="script.js'));
check("the sprite loads before wildcat-motion.js", html.indexOf("wildcat-icons.js") < html.indexOf("wildcat-motion.js"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
