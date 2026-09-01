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
  { courseName: 'Algebra I', courseNumber: 'MAT-101', currentGrade: 'B', currentPercent: 86, sectionId: '5989' },
  { courseName: 'Biology', courseNumber: 'SCI-140', currentGrade: 'A', currentPercent: 94, sectionId: '6055' },
  { courseName: 'World History', courseNumber: 'HIS-120', currentGrade: 'C', currentPercent: 74, sectionId: '6100' },
  { courseName: 'Spanish I', courseNumber: 'SPA-101', currentGrade: 'D', currentPercent: 63, sectionId: '6101' },
  { courseName: 'Geometry', courseNumber: 'MAT-140', currentGrade: 'F', currentPercent: 41, sectionId: '6102' },
  // Not posted must stay ordinary ink. It is the reason the band set exists.
  { courseName: 'English 9', courseNumber: 'ENG-109', currentGrade: null, currentPercent: null, sectionId: '6067' },
];

/**
 * Missing work, shaped as views_app returns it.
 *
 * The three courses are chosen to be the states that are easy to get wrong:
 * one with several pieces missing including one with NO point value (which
 * must never render as "0 pts"), one with nothing missing (which must say so
 * rather than look broken), and one whose grade is not posted at all (a
 * student can owe work in a class that has no grade yet, and the two facts are
 * unrelated).
 */
const MISSING = {
  available: true,
  total: 4,
  bySection: {
    '5989': [
      { assignmentSectionId: '125692', name: 'Unit 3 Problem Set', dueDate: '2026-08-21',
        pointsPossible: 20, courseName: 'Algebra I', categoryName: 'Homework', isLate: false },
      { assignmentSectionId: '125693', name: 'Chapter 4 Quiz Corrections', dueDate: '2026-08-28',
        pointsPossible: 15, courseName: 'Algebra I', categoryName: 'Assessment', isLate: true },
      { assignmentSectionId: '125694', name: 'Warm-up journal', dueDate: null,
        pointsPossible: null, courseName: 'Algebra I', categoryName: 'Practice', isLate: false },
    ],
    '6067': [
      { assignmentSectionId: '125791', name: 'Reading response 2', dueDate: '2026-08-26',
        pointsPossible: 10, courseName: 'English 9', categoryName: 'Writing', isLate: false },
    ],
  },
};

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
    sched: { rows: SCHEDULE, available: true },
    grades: { rows: GRADES, available: true, missingWork: MISSING },
  },
  {
    title: 'Chromebook, a course row opened',
    why: 'The open state is rendered here rather than clicked. The harness posts ' +
         'MARKUP into an iframe, so no script runs inside one and a click cannot ' +
         'be tested. What can be tested is what the open row LOOKS like, which is ' +
         'where the mistakes are: an assignment with no point value must not read ' +
         '"0 pts", and a course with nothing missing must say so rather than ' +
         'render an empty box.',
    w: 1440, h: 940, wide: true, openSection: '5989',
    mine: {
      points: { pbis: 12, attendance: 4, academic: 7, total: 23, weeksQualified: 5, bigRaffleEntries: 5 },
      wildcatCash: { balance: 14.5, earned: 40, spent: 25.5 },
      attendance: { available: true, daysAbsentTerm: 2, daysAbsentYtd: 6, daysTardyTerm: 1 },
    },
    sched: { rows: SCHEDULE, available: true },
    grades: { rows: GRADES, available: true, missingWork: MISSING },
    pass: {
      // No pass running. This is the state the panel most has to work in: a
      // student who wants one and has not got one.
      //
      // AND THIS IS THE PAYLOAD THE SERVER ACTUALLY SENDS. It used to read
      // `available: true, state: 'none'`, which passCard:mine has never
      // returned: its hall pass block ends `live ? { available: true, ... } :
      // { available: false, state: "none" }`. The invented shape is why the
      // harness looked right for weeks while every real Chromebook printed
      // "Unavailable / Your pass could not be looked up just now" and hid the
      // Request button. A fixture that does not match the server is a mock,
      // whatever else it lifts from the shipped code.
      hallPass: { available: false, state: 'none' },
      studentId: { available: true, value: '12217' },
    },
  },
  {
    title: 'Chromebook, a pass is running',
    why: 'The other half of the same panel: once a pass exists the detail ' +
         'replaces the button, and there must not be two ways to ask at once.',
    w: 1440, h: 940, wide: true,
    mine: {
      points: { pbis: 12, attendance: 4, academic: 7, total: 23, weeksQualified: 5, bigRaffleEntries: 5 },
      wildcatCash: { balance: 14.5, earned: 40, spent: 25.5 },
      attendance: { available: true, daysAbsentTerm: 2, daysAbsentYtd: 6, daysTardyTerm: 1 },
    },
    sched: { rows: SCHEDULE, available: true },
    grades: { rows: GRADES, available: true },
    pass: {
      hallPass: {
        available: true, state: 'approved', sentTo: 'Front Office',
        clockStartAt: Date.now() - 4 * 60000, clockLimitMinutes: 8,
      },
      studentId: { available: true, value: '12217' },
    },
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

/*
 * The portal header, LIFTED out of index.html rather than written here.
 *
 * It used to be three hand-written tags: an avatar, a name, a meta line. That
 * is a mock, and it hid exactly the kind of change this harness exists to
 * show. The real header carries the school mark and a sign out button, and a
 * restyle that turns it into an identity card touches markup in index.html
 * that a hand-written stand-in does not have, so the harness rendered the old
 * header and the change looked like it had not happened.
 *
 * The ids are stripped because nothing in here runs the code that fills them,
 * and the sample name and initials are written into the empty elements so the
 * shot is of a student rather than of two blank boxes.
 */
function liftHeader() {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const a = html.indexOf('<header class="wp-top"');
  const b = html.indexOf('</header>', a);
  if (a === -1 || b === -1) throw new Error('index.html has no .wp-top header to lift');
  return html.slice(a, b + '</header>'.length)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\?v=[0-9a-z]+/g, '')
    .replace(/id="wpAvatar"([^>]*)>/, 'id="wpAvatar"$1>JR')
    .replace(/id="wpName"([^>]*)><\/h1>/, 'id="wpName"$1>Jordan Rivera</h1>')
    .replace(/id="wpMeta"([^>]*)><\/p>/, 'id="wpMeta"$1>Grade 9  &middot;  12217</p>');
}
const header = liftHeader();

const stamp = `script.js ${(stat.size / 1024).toFixed(0)}KB, modified ${stat.mtime.toISOString()}`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Student dashboard harness</title>
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="wildcat-motion.css">
<link rel="stylesheet" href="wildcat-ui.css">
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
    // ALL THREE SHEETS, IN THE ORDER index.html LOADS THEM. The harness used
    // to link styles.css alone, which is not what the app serves: index.html
    // also loads wildcat-motion.css and wildcat-ui.css, and wildcat-ui.css is
    // where every --wu-* token lives. A rule written as var(--wu-blue) with no
    // fallback therefore resolved to NOTHING in here while rendering correctly
    // in the app, so the harness showed unstyled panels and a white button on a
    // white card for CSS that was fine. A harness that loads a different
    // stylesheet than the page is testing a page that does not exist.
    '<link rel="stylesheet" href="styles.css">' +
    '<link rel="stylesheet" href="wildcat-motion.css">' +
    '<link rel="stylesheet" href="wildcat-ui.css"></head>' +
    '<body><div id="studentPassView" class="wp-root' + (s.wide ? ' wp-wide' : '') + '">' +
      '<div class="wp-shell">' +
        ${JSON.stringify(header)} +
        '<p style="color:#8E9199;font:12px system-ui;margin:0 0 6px">' +
          (s.wide ? 'the wallet sits here' : 'the wallet is the whole screen here') + '</p>' +
        '<section class="wp-dash" id="wpDash"></section>' +
      '</div></div>' +
    '<script>window.addEventListener("message",function(e){' +
      'document.getElementById("wpDash").innerHTML=e.data;});<\\/script>' +
    '</body></html>';

  f.addEventListener('load', function () {
    // Set the open row BEFORE rendering. wpGradeToggle cannot run inside the
    // iframe (it receives markup, not script), so the only way to see the open
    // state is to render it open.
    f.contentWindow.postMessage(wpDashboard(s.mine, s.sched, s.grades, s.pass), '*');
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
