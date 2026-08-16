#!/usr/bin/env node
/**
 * Does the React Bits Pro registry actually answer for us?
 *
 *   npm run rb:check                    # checks auth-5 in the pro namespace
 *   npm run rb:check -- hero-3          # a different block
 *   npm run rb:check -- CountUp starter # the starter namespace
 *
 * Exists because every failure here looks the same from the shadcn CLI: "not
 * found". A wrong base URL, a missing key, an expired licence and a component
 * that genuinely is not in your plan all produce that one sentence, and you
 * cannot tell which you are looking at. This separates them by reading the
 * status code before anything interprets the body.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '.env.local');

// Minimal .env reader: no dependency, and the value never gets logged.
const env = { ...process.env };
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
  }
}

// Endpoints are public knowledge — the registry's own 401 body documents them.
// Only the key is secret, so only the key comes from the environment.
const NAMESPACE = {
  pro: 'https://pro.reactbits.dev/api/r/pro',
  starter: 'https://pro.reactbits.dev/api/r/starter',
};

const token = env.REACTBITS_LICENSE_KEY || '';
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const item = args[0] || 'auth-5';
const ns = args[1] === 'starter' ? 'starter' : 'pro';

if (!token) {
  console.error('\nNo licence key. Add it to hub/.env.local:\n');
  console.error('  cp env.local.example .env.local');
  console.error('  # REACTBITS_LICENSE_KEY=<your key from pro.reactbits.dev>\n');
  console.error('Never put it in components.json — this repo is public.\n');
  process.exit(1);
}

const url = `${NAMESPACE[ns]}/${item}.json`;
console.log(`\nGET ${url}`);
console.log(`Authorization: Bearer ${'*'.repeat(8)}${token.length > 4 ? token.slice(-4) : ''}  (${token.length} chars)\n`);

let res;
try {
  res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
} catch (err) {
  console.error(`Could not reach the host at all: ${err.message}`);
  console.error('That is a network problem, not a configuration one.\n');
  process.exit(1);
}

const body = await res.text();
const looksJson = body.trimStart().startsWith('{');

if (res.ok && looksJson) {
  const item_ = JSON.parse(body);
  console.log(`OK — "${item_.title || item_.name}" is reachable.`);
  if (item_.dependencies?.length) console.log(`   pulls: ${item_.dependencies.join(', ')}`);
  console.log(`   files: ${(item_.files || []).map((f) => f.path).join(', ') || '(none listed)'}`);
  console.log(`\nInstall it:\n  npm run rb -- @reactbits-${ns}/${item}\n`);
  process.exit(0);
}

console.error(`FAILED — HTTP ${res.status}${looksJson ? '' : ' (response was not JSON)'}\n`);
// Order matters: HTML is checked FIRST. A SPA catch-all answers every unknown
// path with a styled 404 page, so the status code says "not found" while the
// actual fault is that the base URL points at the website, not the registry.
// Reading the status first sends you hunting for the wrong thing.
if (!looksJson) {
  console.error('Got HTML rather than JSON — that is a login page or a single-page-app');
  console.error('catch-all, which means REACTBITS_PRO_REGISTRY points at the website');
  console.error('rather than the registry endpoint. The item name is probably fine.\n');
} else if (res.status === 401 || res.status === 403) {
  console.error('The key was rejected. Wrong key, or the licence does not cover this namespace:');
  console.error('  @reactbits-starter = components + setup skill (all plans)');
  console.error('  @reactbits-pro     = blocks + Application UI + Agent Kit (Pro & Ultimate)\n');
} else if (res.status === 404) {
  console.error(`The registry answered, but "${item}" is not in the ${ns} namespace.`);
  console.error('Check the exact name in the dashboard catalogue, or try the other namespace:');
  console.error(`  npm run rb:check -- ${item} ${ns === 'pro' ? 'starter' : 'pro'}\n`);
}
console.error(`First 200 chars of the response:\n${body.slice(0, 200)}\n`);
process.exit(1);
