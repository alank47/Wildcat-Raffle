/*
 * Build wildcat-icons.js: the teacher portal's icon sprite, from Untitled UI.
 *
 * WHY A SPRITE AND NOT THE PACKAGE. @untitledui/icons ships React components,
 * and the teacher portal is a static page with no build step: it cannot import
 * React and never will for the sake of an icon. But the drawings inside those
 * components are plain SVG paths, and a path does not care what framework
 * drew it. So this reads the component files out of hub/node_modules (the one
 * place the package is installed), lifts the paths, and writes them as
 * <symbol>s into one script that injects a hidden sprite at load and exposes
 * wcIcon(name) for anything that builds markup in script.js.
 *
 * WHY A CURATED MAP AND NOT ALL 1,180. An icon set is a vocabulary; a page that
 * can reach for any of 1,180 glyphs ends up speaking in 200 of them. The names
 * on the left are the words the portal uses (what a thing IS, not what it looks
 * like), and each maps to exactly one Untitled icon. Add a word here when the
 * UI needs one; do not reach past the map.
 *
 *   node scripts/build-icons.mjs
 *
 * icons.test.mjs checks every #wci- reference in index.html and script.js is in
 * the sprite, so a typo in a name fails the suite rather than drawing nothing.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'hub', 'node_modules', '@untitledui', 'icons', 'dist');
if (!existsSync(dist)) {
  console.error('Untitled UI icons are not installed. Run: cd hub && npm install');
  process.exit(1);
}

/** word the portal uses -> Untitled UI component name */
export const ICONS = {
  // shell
  menu: 'Menu01', 'chevron-down': 'ChevronDown', 'chevron-right': 'ChevronRight',
  compass: 'Compass03', logout: 'LogOut01', key: 'Key01', bell: 'Bell01',
  // modes and top-level nav
  dashboard: 'Home02', ticket: 'Ticket01', cash: 'Coins03', pass: 'Ticket02',
  discipline: 'ClipboardCheck', activity: 'Edit05', leaderboard: 'Trophy01',
  dice: 'Dice5', jackpot: 'Gift01', analytics: 'BarChart10', audit: 'Clipboard',
  students: 'Users01', teachers: 'GraduationHat02', settings: 'Settings02',
  lock: 'Lock01', shield: 'Shield01',
  // claw pass
  class: 'Users02', walk: 'Route', monitor: 'Eye', snapshot: 'PieChart01',
  alert: 'AlertOctagon', history: 'ClockRewind', sliders: 'Settings01',
  campus: 'Building07', office: 'Building02', book: 'BookOpen01', heart: 'Heart',
  calendar: 'Calendar', clock: 'Clock', stopwatch: 'ClockStopwatch', pin: 'MarkerPin01',
  mic: 'Microphone01', flask: 'Beaker02', wind: 'Wind02', hand: 'Hand', globe: 'Globe02',
  limit: 'Signal02', group: 'Users01', user: 'UserSquare', identity: 'Passport',
  // actions and states
  save: 'Save01', trash: 'Trash01', plus: 'Plus', refresh: 'RefreshCw01',
  search: 'SearchMd', edit: 'Edit02', check: 'Check', x: 'XClose',
  warning: 'AlertTriangle', info: 'InfoCircle', bulb: 'Lightbulb02', note: 'File06',
  send: 'Send01', star: 'Star06', sparkles: 'Stars01', flag: 'Flag01', target: 'Target04',
  zap: 'Zap', 'check-circle': 'CheckCircle', 'x-circle': 'XCircle', 'alert-circle': 'AlertCircle',
  download: 'Download01', upload: 'Upload01', mail: 'Mail01', list: 'List', filter: 'FilterFunnel01',
  'arrow-right': 'ArrowRight', 'arrow-up-right': 'ArrowUpRight', copy: 'Copy01', printer: 'Printer',
  play: 'Zap', bus: 'Bus', award: 'Award01', banknote: 'BankNote01', tag: 'Tag01',
  // wildcat cash: the words the money screens need and no more. 'shopping' is
  // what a student spends, 'store' is where they spend it, 'grade' is the year
  // they are in (the hat, not the teacher), and the two trends are the pair the
  // analytics tabs read as opposites.
  grade: 'GraduationHat01', store: 'Building05', shopping: 'ShoppingBag01',
  receipt: 'Receipt', card: 'CreditCard01', archive: 'Archive', minus: 'Minus',
  'trending-up': 'TrendUp01', 'trending-down': 'TrendDown01',
};

const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

/** Lift the SVG children out of one compiled component file. */
function symbolFor(word, component) {
  const file = join(dist, component + '.mjs');
  if (!existsSync(file)) throw new Error(`${word}: no Untitled icon named ${component}`);
  const src = readFileSync(file, 'utf8');
  const view = /viewBox:"([^"]+)"/.exec(src)?.[1] || '0 0 24 24';
  // Every child element: o.createElement("path",{d:"..."}) and friends. The
  // <svg> call itself carries a spread (`...t}`) so it never matches this
  // shape; filtered by tag anyway, so a future build that drops the spread
  // cannot smuggle the root in as a child.
  const calls = [...src.matchAll(/createElement\("(\w+)",\{([^}]*)\}\)/g)].filter((m) => m[1] !== 'svg');
  if (!calls.length) throw new Error(`${word}: ${component} has no drawable children`);
  const children = calls.map(([, tag, attrs]) => {
    const pairs = [...attrs.matchAll(/(\w+):"([^"]*)"/g)]
      .map(([, k, v]) => `${kebab(k)}="${v}"`)
      .join(' ');
    return `<${tag} ${pairs}/>`;
  }).join('');
  return `<symbol id="wci-${word}" viewBox="${view}">` +
    `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${children}</g>` +
    `</symbol>`;
}

const symbols = Object.entries(ICONS).map(([w, c]) => symbolFor(w, c)).join('');
const sprite = `<svg xmlns="http://www.w3.org/2000/svg" id="wcIconSprite" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true" focusable="false">${symbols}</svg>`;

const out = `/* GENERATED by scripts/build-icons.mjs from @untitledui/icons (MIT). Do not edit;
 * add a word to ICONS in the script and rebuild. ${Object.keys(ICONS).length} icons. */
(function () {
    'use strict';
    var SPRITE = ${JSON.stringify(sprite)};
    var NAMES = ${JSON.stringify(Object.keys(ICONS))};

    /** The markup for one icon, for code that builds HTML as strings. */
    function wcIcon(name, cls) {
        return '<svg class="wc-icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true" focusable="false">' +
            '<use href="#wci-' + name + '"></use></svg>';
    }

    function mount() {
        if (document.getElementById('wcIconSprite')) return;
        var host = document.body || document.documentElement;
        host.insertAdjacentHTML('afterbegin', SPRITE);
    }
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);

    window.wcIcon = wcIcon;
    window.WC_ICONS = NAMES;
})();
`;
writeFileSync(join(root, 'wildcat-icons.js'), out);
console.log(`wrote wildcat-icons.js: ${Object.keys(ICONS).length} icons, ${(out.length / 1024).toFixed(0)}KB`);
