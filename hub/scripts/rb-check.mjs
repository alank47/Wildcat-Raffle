#!/usr/bin/env node
/**
 * Does the React Bits Pro registry actually answer for us?
 *
 *   npm run rb:check                 # checks auth-5
 *   npm run rb:check -- hero-3       # checks something else
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

const base = (env.REACTBITS_PRO_REGISTRY || '').replace(/\/+$/, '');
const token = env.REACTBITS_PRO_TOKEN || '';
const item = process.argv.slice(2).find((a) => !a.startsWith('-')) || 'auth-5';

const missing = [
  !base && 'REACTBITS_PRO_REGISTRY',
  !token && 'REACTBITS_PRO_TOKEN',
].filter(Boolean);

if (missing.length) {
  console.error(`\nNot configured. Missing in hub/.env.local: ${missing.join(', ')}`);
  console.error('\n  cp env.local.example .env.local');
  console.error('  # then paste both values from https://pro.reactbits.dev dashboard\n');
  console.error('Never put either value in components.json — this repo is public.\n');
  process.exit(1);
}

const url = `${base}/${item}.json`;
console.log(`\nGET ${url}`);
console.log(`Authorization: Bearer ${'*'.repeat(8)}${token.length > 4 ? token.slice(-4) : ''}  (${token.length} chars)\n`);

let res;
try {
  res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
} catch (err) {
  console.error(`Could not reach the host at all: ${err.message}`);
  console.error('Check REACTBITS_PRO_REGISTRY is a URL, with no trailing slash.\n');
  process.exit(1);
}

const body = await res.text();
const looksJson = body.trimStart().startsWith('{');

if (res.ok && looksJson) {
  const item_ = JSON.parse(body);
  console.log(`OK — "${item_.title || item_.name}" is reachable.`);
  if (item_.dependencies?.length) console.log(`   pulls: ${item_.dependencies.join(', ')}`);
  console.log(`   files: ${(item_.files || []).map((f) => f.path).join(', ') || '(none listed)'}`);
  console.log(`\nInstall it:\n  npm run rb -- @reactbits-pro/${item}\n`);
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
  console.error(`Reached the registry, but "${item}" is not there.`);
  console.error('Either the base URL is wrong, or that item name does not exist in your plan.');
  console.error('Check the exact name on the component page in the Pro dashboard.\n');
}
console.error(`First 200 chars of the response:\n${body.slice(0, 200)}\n`);
process.exit(1);
