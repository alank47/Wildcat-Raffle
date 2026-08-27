// styles.css must actually parse to the end.
//
// THE BUG THIS CATCHES. Resolving a rebase conflict in styles.css joined two
// appended blocks, and the incoming side ended INSIDE an unclosed
// `@media (max-width: 560px)`. Its closing brace had been on the other side of
// the conflict marker and was dropped. Every rule appended afterwards — the
// whole student-wallet accordion — fell inside that media query, so on any
// screen wider than 560px it simply did not apply.
//
// Nothing caught it. The file was byte-for-byte correct as text, curl found
// the rules, and the brace TOTAL balanced because a separate stray `}`
// elsewhere cancelled the missing one out. Only a real CSS parser could see
// it, and only by noticing the rules were nested rather than absent.
//
// Run: npm test

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

/** Walk the stylesheet, skipping comments, tracking nesting depth. */
function scan(css) {
  let depth = 0, line = 1, i = 0;
  const strays = [];
  const topLevel = [];
  let atRuleDepth = null;
  while (i < css.length) {
    if (css[i] === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const seg = css.slice(i, end < 0 ? css.length : end + 2);
      line += (seg.match(/\n/g) || []).length;
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    const ch = css[i];
    if (ch === "\n") line++;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth < 0) { strays.push(line); depth = 0; } }
    i++;
  }
  return { depth, strays };
}

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const { depth, strays } = scan(css);

console.log("\nThe stylesheet closes everything it opens");
{
  // Unclosed is the dangerous direction: it swallows every rule after it.
  check(`nothing is left open at the end (depth ${depth})`, depth === 0);
}

console.log("\nNo rule is stranded inside a media query by accident");
{
  // The specific shape of the bug: an appended top-level block that ends up
  // nested. Selectors added at the end of the file are top-level by intent, so
  // if the parser is still inside a block when it reaches them, something
  // upstream never closed.
  const lastBlock = css.slice(css.lastIndexOf("/* ---- Student wallet: the rewards accordion"));
  check("the accordion block was found", lastBlock.length > 200);
  const before = scan(css.slice(0, css.lastIndexOf("/* ---- Student wallet: the rewards accordion")));
  check("the accordion starts at top level, not inside a media query",
    before.depth === 0);
}

console.log("\nKnown pre-existing damage is recorded, not silently tolerated");
{
  // One stray `}` in the old mobile CSS. Browsers ignore it at top level, and
  // it is NOT what broke the wallet — but it masked the real fault by making
  // the brace total balance. Pinned so it cannot grow.
  check(`at most one stray closing brace (found ${strays.length} at ${strays.join(", ") || "none"})`,
    strays.length <= 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
