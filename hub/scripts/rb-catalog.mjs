#!/usr/bin/env node
/**
 * Browse the React Bits catalogue without leaving the terminal, and print the
 * exact command to install anything in it.
 *
 * The catalogue is a local snapshot (scripts/rb-catalog.json) rather than a
 * live fetch, on purpose: reactbits.dev is a single-page app, so every
 * directory-ish URL returns the marketing HTML with a 200. A "list" built on
 * that silently returns nothing useful, which is how the older jsrepo path
 * fails today. Refresh the snapshot with --refresh when you want the newest.
 *
 *   npm run rb:catalog              every component, by category
 *   npm run rb:catalog -- text      only names matching "text"
 *   npm run rb:catalog -- --refresh re-read the catalogue from GitHub
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CATALOG = join(here, 'rb-catalog.json');
const TREE = 'https://api.github.com/repos/DavidHDev/react-bits/git/trees/main?recursive=1';

async function refresh() {
  const res = await fetch(TREE);
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const { tree = [] } = await res.json();
  const found = {};
  for (const { path } of tree) {
    const m = /^src\/content\/(TextAnimations|Animations|Components|Backgrounds)\/([^/]+)\//.exec(path);
    if (m) (found[m[1]] ??= new Set()).add(m[2]);
  }
  const out = Object.fromEntries(
    Object.entries(found).sort().map(([k, v]) => [k, [...v].sort()]),
  );
  writeFileSync(CATALOG, JSON.stringify(out, null, 2) + '\n');
  return out;
}

const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--'));
const catalog = args.includes('--refresh')
  ? await refresh()
  : JSON.parse(readFileSync(CATALOG, 'utf8'));

let shown = 0;
for (const [category, names] of Object.entries(catalog)) {
  const hits = filter
    ? names.filter((n) => n.toLowerCase().includes(filter.toLowerCase()))
    : names;
  if (!hits.length) continue;
  console.log(`\n${category} (${hits.length}${filter ? ` of ${names.length}` : ''})`);
  console.log('  ' + hits.join(', '));
  shown += hits.length;
}

const total = Object.values(catalog).reduce((n, v) => n + v.length, 0);
console.log(`\n${shown} of ${total} components${filter ? ` matching "${filter}"` : ''}\n`);
console.log('Install one:');
console.log('  npm run rb -- @react-bits/<Name>-TS-TW    # TypeScript + Tailwind, what hub/ uses');
console.log('  npm run rb -- @react-bits/<Name>-JS-CSS   # JavaScript + plain CSS');
console.log('\nRead one before installing:');
console.log('  curl -s https://reactbits.dev/r/<Name>-TS-TW.json | python3 -m json.tool\n');
