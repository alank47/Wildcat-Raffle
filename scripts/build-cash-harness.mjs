/*
 * Build cash-harness.html: every Wildcat Cash screen, at once, against the
 * real stylesheets and the real sprite.
 *
 * Same reasoning as build-pass-harness.mjs and build-dashboard-harness.mjs,
 * and the same trick. The Cash screens are static markup rather than rendered
 * JavaScript, so there is nothing to lift by brace matching: the harness
 * SLICES the shipped slab out of index.html between its own two landmarks and
 * drops it in verbatim. It contains no copy of the markup, so it cannot drift
 * from what ships. Change a panel in index.html and the harness changes with it.
 *
 * WHY IT EXISTS. Replacing an emoji with <svg><use> is the one edit that fails
 * silently in both directions: a name the sprite lacks draws nothing, and a
 * name it has draws at whatever size the container was written for, which for
 * a span set to font-size:30px is not the size anybody wanted. Neither shows
 * up in a diff and neither throws. Only looking at it does.
 *
 * The tabs are shown all at once on purpose. In the app they are one at a
 * time, so the alignment of an icon in a table head is never seen next to the
 * same icon in a panel head, which is exactly where inconsistency hides.
 *
 *   node scripts/build-cash-harness.mjs
 *
 * No dependencies and no build step, like every other script in here.
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = join(root, 'index.html');
const html = readFileSync(htmlPath, 'utf8');
const stat = statSync(htmlPath);

/** The shipped slab, between two landmarks that are unique in the file. */
function slice(from, to) {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  if (a === -1) throw new Error(`landmark not found in index.html: ${from}`);
  if (b === -1) throw new Error(`landmark not found in index.html: ${to}`);
  return html.slice(a, b);
}

// Start after the banner comment closes, or its tail renders as body text.
const cash = slice('<!-- Award Cash Tab -->', '<div id="clawPassContent"');
const icons = readFileSync(join(root, 'wildcat-icons.js'), 'utf8');

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Wildcat Cash harness</title>
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="wildcat-ui.css">
<link rel="stylesheet" href="wildcat-motion.css">
<style>
  /* The app shows one tab at a time. The harness shows all of them, so the
     same icon can be compared across a page title, a panel head and a table
     head without clicking between three screens. */
  .tab-content { display: block !important; }
  #cashClassHeader { display: flex !important; }
  body { margin: 0; background: #EEF2F7; }
  .harness-note {
    position: sticky; top: 0; z-index: 9; padding: 10px 18px;
    background: #0C447C; color: #fff; font: 600 13px/1.4 system-ui, sans-serif;
  }
  .harness-note code { background: rgba(255,255,255,.16); padding: 1px 5px; border-radius: 4px; }
  .harness-page { padding: 18px; }
</style>
</head>
<body>
<p class="harness-note">
  GENERATED from index.html at ${stat.mtime.toISOString()} &mdash; do not edit.
  Rebuild with <code>node scripts/build-cash-harness.mjs</code>.
</p>
<div class="harness-page container">
  <div class="content">
${cash}
  </div>
</div>
<script>${icons}<\/script>
</body>
</html>
`;

writeFileSync(join(root, 'cash-harness.html'), page);
console.log(`wrote cash-harness.html: ${(page.length / 1024).toFixed(0)}KB from index.html`);
