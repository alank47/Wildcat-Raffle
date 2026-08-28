/*
 * Build dashboard-harness.html: the student's desk dashboard, in real
 * viewports, against the real stylesheet.
 *
 * Same reasoning as build-pass-harness.mjs, and the same trick. A hand written
 * mock proves somebody can draw panels, not that the shipped code draws them,
 * so this file contains no copy of the dashboard: it LIFTS wpDashboard and the
 * helpers it uses straight out of script.js by brace matching and runs them.
 * If the dashboard regresses, the harness regresses with it.
 *
 * WHY IFRAMES. The whole point of this screen is that it is off on a phone and
 * on at a desk, and the switch is .wp-wide, which wpSyncWide sets from the
 * view's own clientWidth at 1000px. A 390px column inside a 1400px window is
 * still a 1400px window as far as that measurement is concerned, so a one-page
 * harness would be lying about the exact thing it exists to check. Each state
 * renders in its own iframe at a real device size.
 *
 * The states are chosen to be the ones that are easy to get wrong rather than
 * the one that looks best: a complete student, a student the sync has dropped
 * fields for (where a 0 would be a lie), a student with genuine zeroes (where
 * "not on file" would be a different lie), and a student whose services are
 * down.
 *
 *   node scripts/build-dashboard-harness.mjs
 *
 * No dependencies and no build step, like every other script in here.
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = join(root, 'script.js');
const src = readFileSync(srcPath, 'utf8');
const stat = statSync(srcPath);

function block(marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`marker not found in script.js: ${marker}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced block after ${marker}`);
}
function between(a, b) {
  const s = src.indexOf(a);
  const e = src.indexOf(b, s + a.length);
  if (s === -1 || e === -1) throw new Error(`markers not found: ${a}`);
  return src.slice(s, e);
}

const PIECES = [
  block('function wpEsc('),
  block('function wpEmpty('),
  block('function wpFoot('),
  block('function wpPeriodRank('),
  between('/* ---- the desk dashboard ---', '/* ---- end desk dashboard ---- */'),
].join('\n\n');

/* ---- the states, and why each one is here ------------------------------- */
const SCHEDULE = [
  { courseName: 'Biology', period: '2', teacher: 'Ms Okafor', term: 'S1' },
  { courseName: 'English 9', period: '1', teacher: 'Mr Alvarez', term: 'S1' },
  { courseName: 'Nutrition', period: 'Nutrition' },
  { courseName: 'Algebra I', period: '4', teacher: 'Ms Reyes', term: 'S1' },
  { courseName: 'PE', period: '6', teacher: 'Coach Diaz', term: 'S1' },
];
const GRADES = [
  { courseName: 'Algebra I', courseNumber: 'MAT-101', currentGrade: 'B', currentPercent: 86 },
  { courseName: 'Biology', courseNumber: 'SCI-140', currentGrade: 'A', currentPercent: 94 },
  { courseName: 'English 9', courseNumber: 'ENG-109', currentGrade: null, currentPercent: null },
];

const STATES = [
  {
    title: 'Chromebook, complete',
    why: 'What most students see. Every figure present.',
    w: 1440, h: 940, wide: true,
    mine: {
      points: { pbis: 12, attendance: 4, academic: 7, total: 23, weeksQualified: 5, bigRaffleEntries: 5 },
      wildcatCash: { balance: 14.5, earned: 40, spent: 25.5 },
      attendance: { available: true, daysAbsentTerm: 2, daysAbsentYtd: 6, daysTardyTerm: 1 },
    },
    sched: { rows: SCHEDULE, available: true }, grades: { rows: GRADES, available: true },
  },
  {
    title: 'Chromebook, fields the sync dropped',
    why: 'NOT ON FILE, never 0. A dropped balance must not read as spent.',
    w: 1440, h: 940, wide: true,
    mine: {
      points: { pbis: 3, attendance: 1, academic: 0, total: 4, weeksQualified: null, bigRaffleEntries: 0 },
      wildcatCash: { balance: null, earned: null, spent: null },
      attendance: { available: true, daysAbsentTerm: null, daysAbsentYtd: null, daysTardyTerm: null },
    },
    sched: { rows: SCHEDULE, available: true }, grades: { rows: [], available: true },
  },
  {
    title: 'Chromebook, genuine zeroes',
    why: 'The other side of the same rule: a real 0 must look like a number.',
    w: 1440, h: 940, wide: true,
    mine: {
      points: { pbis: 0, attendance: 0, academic: 0, total: 0, weeksQualified: 0, bigRaffleEntries: 0 },
      wildcatCash: { balance: 0, earned: 0, spent: 0 },
      attendance: { available: true, daysAbsentTerm: 0, daysAbsentYtd: 0, daysTardyTerm: 0 },
    },
    sched: { rows: SCHEDULE, available: true }, grades: { rows: GRADES, available: true },
  },
  {
    title: 'Chromebook, services down',
    why: 'Unavailable is not empty. Each panel prints its own reason.',
    w: 1440, h: 940, wide: true,
    mine: {
      points: { pbis: 12, attendance: 4, academic: 7, total: 23, weeksQualified: 5, bigRaffleEntries: 5 },
      wildcatCash: { balance: 14.5, earned: 40, spent: 25.5 },
      attendance: { available: false, reason: 'No student number on file, so attendance cannot be looked up.' },
    },
    sched: { rows: [], available: false, reason: 'The schedule service did not answer.' },
    grades: { rows: [], available: false, reason: 'Grades are not published for this term yet.' },
  },
  {
    title: 'Phone',
    why: 'The dashboard must be COMPLETELY absent. The wallet is the product here.',
    w: 390, h: 844, wide: false,
    mine: {
      points: { pbis: 12, attendance: 4, academic: 7, total: 23, weeksQualified: 5, bigRaffleEntries: 5 },
      wildcatCash: { balance: 14.5, earned: 40, spent: 25.5 },
      attendance: { available: true, daysAbsentTerm: 2, daysAbsentYtd: 6, daysTardyTerm: 1 },
    },
    sched: { rows: SCHEDULE, available: true }, grades: { rows: GRADES, available: true },
  },
];

const stamp = `script.js ${(stat.size / 1024).toFixed(0)}KB, modified ${stat.mtime.toISOString()}`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Student dashboard harness</title>
<link rel="stylesheet" href="styles.css">
<style>
  body { margin: 0; background: #14151a; color: #e9e6df; font: 14px/1.5 system-ui, sans-serif; }
  .h-head { padding: 20px 24px 8px; }
  .h-head h1 { margin: 0 0 4px; font-size: 18px; }
  .h-head p { margin: 0; color: #8E9199; font-size: 12.5px; }
  .h-grid { display: flex; flex-wrap: wrap; gap: 26px; padding: 18px 24px 60px; }
  .h-cell { }
  .h-cap { font-size: 12.5px; font-weight: 650; margin: 0 0 2px; }
  .h-why { font-size: 12px; color: #8E9199; margin: 0 0 8px; max-width: 44ch; }
  iframe { border: 1px solid #2a2c34; border-radius: 12px; background: #0B0B0E; display: block; }
</style>
</head>
<body>
<div class="h-head">
  <h1>Student dashboard, every state that is easy to get wrong</h1>
  <p>Lifted from ${stamp}. Rebuild: <code>node scripts/build-dashboard-harness.mjs</code></p>
</div>
<div class="h-grid" id="grid"></div>
<script>
const STATES = ${JSON.stringify(STATES)};
${PIECES}

const grid = document.getElementById('grid');
STATES.forEach(function (s, i) {
  const cell = document.createElement('div');
  cell.className = 'h-cell';
  cell.innerHTML = '<p class="h-cap">' + s.title + '</p><p class="h-why">' + s.why + '</p>';
  const f = document.createElement('iframe');
  f.width = s.w; f.height = s.h;
  cell.appendChild(f);
  grid.appendChild(cell);

  f.srcdoc = '<!doctype html><html><head><meta charset="utf-8">' +
    '<link rel="stylesheet" href="styles.css"></head>' +
    '<body><div id="studentPassView" class="wp-root' + (s.wide ? ' wp-wide' : '') + '">' +
      '<div class="wp-shell">' +
        '<header class="wp-top"><span class="wp-avatar">JR</span>' +
        '<div class="wp-who"><h1 class="wp-name">Jordan Rivera</h1>' +
        '<p class="wp-meta">Grade 9  &middot;  12217</p></div></header>' +
        '<p style="color:#8E9199;font:12px system-ui;margin:0 0 6px">' +
          (s.wide ? 'the wallet sits here' : 'the wallet is the whole screen here') + '</p>' +
        '<section class="wp-dash" id="wpDash"></section>' +
      '</div></div>' +
    '<script>window.addEventListener("message",function(e){' +
      'document.getElementById("wpDash").innerHTML=e.data;});<\\/script>' +
    '</body></html>';

  f.addEventListener('load', function () {
    f.contentWindow.postMessage(wpDashboard(s.mine, s.sched, s.grades), '*');
  });
});
<\/script>
</body>
</html>
`;

const out = join(root, 'dashboard-harness.html');
writeFileSync(out, page);
console.log(`wrote ${out}`);
console.log(`  ${STATES.length} states, lifted from ${stamp}`);
