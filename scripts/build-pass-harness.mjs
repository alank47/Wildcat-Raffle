/*
 * Build pass-card-harness.html: every state of the student hall pass card, side
 * by side, in real phone-sized viewports, against the real stylesheet.
 *
 * WHY A GENERATOR AND NOT A HAND WRITTEN PAGE. A hand written mock of this card
 * is worth nothing: it proves somebody can draw a ring, not that the shipped
 * card draws one. So the harness contains no copy of the card. It LIFTS
 * wpHallPassCard, the pass clock arithmetic, the ticker AND the stack layout
 * straight out of script.js by brace matching, the same trick
 * pass-clock.test.mjs uses, and runs them. If the card regresses, the harness
 * regresses with it.
 *
 * WHY IFRAMES. Every geometry token on this screen is a clamp against the
 * VIEWPORT (svh) or a media query against the viewport WIDTH. A 414px column
 * inside a 1400px window resolves the desk tokens, not the phone ones, so a
 * one-page harness would be lying about the exact thing it exists to check.
 * Each state therefore renders in its own iframe at a real device size, and the
 * page is one file: ?state=N is a phone, no query is the index.
 *
 * It cannot fetch script.js at runtime because file:// blocks XHR and a critic
 * has to be able to double click the file. So the slices are inlined at build
 * time, and the header prints script.js's size and mtime so a stale harness
 * announces itself.
 *
 *   node scripts/build-pass-harness.mjs
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

/** A top-level function or const declaration, by brace matching. */
function block(marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`marker not found in script.js: ${marker}`);
  const open = src.indexOf('{', start);
  if (open === -1) throw new Error(`no brace after ${marker}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced block after ${marker}`);
}

/** A one-statement declaration: from the marker to the first semicolon. */
function line(marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`marker not found in script.js: ${marker}`);
  const end = src.indexOf(';', start);
  if (end === -1) throw new Error(`no semicolon after ${marker}`);
  return src.slice(start, end + 1);
}

/** The source between two markers. */
function between(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) throw new Error(`markers not found: ${startMarker}`);
  return src.slice(start, end);
}

// The whole live path from a payload to a laid out stack. Order matters only in
// that consts must be declared before they run, and nothing here runs on load.
const PIECES = [
  'let wpCards = []; let wpSelected = 0; let wpDragged = false; let wpWired = false;' +
    ' let wpLastOrigin = ""; let wpFitObserver = null;',
  block('function wpById('),
  block('function wpEsc('),
  block('function wpEmpty('),
  block('function wpFoot('),
  block('function wpTripHtml('),
  block('function wpTitleCase('),
  block('function wpOriginLabel('),
  block('function wpReasonCard('),
  block('const WP_FACE = {'),
  between('/* ---- pass clock arithmetic ---- */', '/* ---- end pass clock arithmetic ---- */'),
  block('const WP_RING_RAMP = {'),
  line('const WP_RING_TRACK ='),
  block('function wpTickClocks('),
  block('function wpHallPassCard('),
  block('function wpMetrics('),
  block('function wpLayout('),
  block('function wpSyncWide('),
  block('function wpMeasureFit('),
  block('function wpWatchFit('),
  block('function wpSelect('),
  block('function wpWireStack('),
  block('function wpRender('),
  block('function wpDecorate('),
];

const lifted = PIECES.join('\n\n');
if (lifted.includes('</script')) throw new Error('a lifted slice would close the script tag');

const DRIVER = `
/* ---- the states, as payloads convex/passCard.ts actually sends ---- */
var NOW = Date.now();
var iso = function (ms) { return new Date(ms).toISOString(); };

function live(over) {
    var base = {
        available: true,
        id: 'pass_demo',
        state: over.state || 'out',
        elapsedMinutes: (over.agoSec || 0) / 60,
        overdue: false,
        clockStartAt: iso(NOW - (over.agoSec || 0) * 1000),
        clockLimitMinutes: over.limit === undefined ? 10 : over.limit,
        expiresAfterMinutes: 10,
        timerCleared: over.limit === null,
        serverTime: iso(NOW),
        approvedAt: iso(NOW - (over.approvedAgoSec || 900) * 1000),
        origin: 'Room 16',
        teacherName: 'Mr. Berment',
        period: '3',
        courseName: 'Biology',
        sentTo: 'Restroom',
    };
    for (var k in over) {
        if (k !== 'agoSec' && k !== 'limit' && k !== 'approvedAgoSec') base[k] = over[k];
    }
    return base;
}

var STATES = [
    {
        title: 'The bar: out, heading back',
        note: 'The target. 7:32 of a ten minute return leg, Restroom to Room 16, approved at the hour it says.',
        hp: live({ state: 'out', agoSec: 148, approvedAgoSec: 900 }),
    },
    {
        title: 'Approved, heading there',
        note: 'The reach leg, five minutes. The clock starts at APPROVAL, not at the tag, so it is already running.',
        hp: live({ state: 'active', agoSec: 46, limit: 5, approvedAgoSec: 46 }),
    },
    {
        title: 'Nearly out of time',
        note: 'Inside the warning lead (two minutes, or a quarter of the leg). The ring changes ramp and breathes, and the flag appears.',
        hp: live({ state: 'out', agoSec: 505, approvedAgoSec: 1200 }),
    },
    {
        title: 'Overtime',
        note: 'Past the deadline. The digits reversed and are signed, the ring FILLS rather than emptying, the card turns, the trip turns with it.',
        hp: live({ state: 'out', agoSec: 734, overdue: true, approvedAgoSec: 1500 }),
    },
    {
        title: 'The trap: no time limit',
        note: 'Staff lifted the limit. This pass can never be overdue, so it must never be drawn as a countdown: the digits count UP, the ring stays whole, and the card says so in words instead of printing a deadline nobody set.',
        hp: live({ state: 'out', agoSec: 396, limit: null, approvedAgoSec: 1800 }),
    },
    {
        title: 'No pass',
        note: 'What 623 students see all day. Untouched by this work, and the card is a card again: name at reading size, one value.',
        hp: { available: false, state: 'none' },
    },
    {
        title: 'Waiting on a teacher',
        note: 'A request nobody has answered yet. Cancel is a first class control here, because a teacher who never answers otherwise strands the student.',
        hp: {
            available: true, id: 'pass_req', state: 'requested',
            teacherName: 'Ms. Vega', courseName: 'Biology', period: '3', origin: 'Room 16',
            elapsedMinutes: null, serverTime: iso(NOW),
        },
    },
    {
        title: 'Collapsed, with the ID card open',
        note: 'The same live pass, not the open card. The strip still carries mm:ss, which is the only line a student reads without opening anything, and the gold bar under the wallet still ends the pass.',
        hp: live({ state: 'out', agoSec: 148, approvedAgoSec: 900 }),
        sel: 3,
    },
    {
        title: 'Nothing to say it with',
        note: 'An older pass carrying neither a teacher name nor a destination tag. Nothing is invented: the route falls back to the room, and the approver line does not render at all.',
        hp: live({ state: 'out', agoSec: 300, teacherName: null, sentTo: null, approvedAt: null }),
    },
];

/* ---- phone mode: one state, in a real portal ---- */
function paintPhone(idx, sel) {
    var s = STATES[idx] || STATES[0];
    // The same four cards a student gets on a phone, built by the same
    // functions: three ordinary wallet cards and the pass.
    var cards = [
        wpReasonCard('Meal', { available: false, reason: 'No meal right now.' }, WP_FACE.lunch, WP_FACE.lunchOff),
        wpReasonCard('Clever', { available: false, reason: 'Clever badge sign in is not connected yet.' }, WP_FACE.clever, WP_FACE.cleverOff),
        wpHallPassCard(s.hp),
        wpReasonCard('Student ID', { available: true, value: '12217' }, WP_FACE.id, WP_FACE.idOff),
    ];
    document.getElementById('wpName').textContent = 'Test Student';
    document.getElementById('wpMeta').textContent = 'Grade 9 \\u00B7 12217';
    document.getElementById('wpAvatar').textContent = 'TS';
    document.getElementById('wpAsOf').textContent = 'PowerSchool data as of Aug 17 at 6:00 AM';
    wpRender(cards, sel === null ? 2 : sel);
    wpTickClocks();
    setInterval(wpTickClocks, 1000);
    // Two frames, so the clamps have resolved and the barcode-less stack has
    // settled, then hand the numbers up. See reportGeometry.
    requestAnimationFrame(function () { requestAnimationFrame(reportGeometry); });
}

/* ---- the numbers, measured rather than asserted ----
   THE WHOLE ARGUMENT ABOUT THIS CARD IS A SET OF RATIOS, and every one of them
   was previously settled by somebody opening a screenshot in a picture viewer
   and estimating. That is how a ring at 0.39 of the card's width shipped while
   the note beside it said 0.61: nobody measured the thing they were arguing
   about. So the harness measures itself and prints it, in the units the
   argument is actually in, which are shares of the card's width and not pixels.

   Posted to the index page rather than drawn in the phone, because anything
   drawn inside the frame would be a thing on the card that is not the card. */
function reportGeometry() {
    try {
        var card = document.querySelector('.wp-card[data-tall="1"]');
        var ring = document.querySelector('.wp-ring');
        var view = document.getElementById('studentPassView');
        if (!card || !view) return;
        var cw = card.getBoundingClientRect().width;
        var passH = parseFloat(getComputedStyle(document.getElementById('wpMetricPass')).height) || 0;
        var out = { w: Math.round(cw), h: Math.round(passH) };
        out.hOverW = (passH / cw).toFixed(3);
        if (ring) {
            var rr = ring.getBoundingClientRect();
            out.ring = Math.round(rr.width);
            out.ringOverCard = (rr.width / cw).toFixed(3);
            out.roundness = (rr.height / rr.width).toFixed(3);
            var digits = ring.querySelector('.wp-clock-value');
            if (digits) {
                out.clockPx = Math.round(parseFloat(getComputedStyle(digits).fontSize) * 10) / 10;
                out.capOverCard = (parseFloat(getComputedStyle(digits).fontSize) * 0.71 / cw).toFixed(3);
                out.digits = digits.textContent;
            }
            var hole = parseFloat(getComputedStyle(ring, '::before').width) || 0;
            if (hole) out.strokeOverRing = (((rr.width - hole) / 2) / rr.width).toFixed(3);
        }
        var trip = document.querySelector('.wp-trip');
        var appby = document.querySelector('.wp-appby');
        if (trip && appby) {
            out.tripToAppby = Math.round(appby.getBoundingClientRect().top - trip.getBoundingClientRect().bottom);
            out.emptyBelow = Math.round(
                (card.getBoundingClientRect().top + passH) - appby.getBoundingClientRect().bottom,
            );
        }
        out.fits = view.scrollHeight <= view.clientHeight + 2;
        out.overflowPx = Math.max(0, view.scrollHeight - view.clientHeight);
        parent.postMessage({ wpGeom: out, state: location.search }, '*');
    } catch (e) { /* a harness that cannot measure still has to render */ }
}

/* ---- index mode: one iframe per state, at real device sizes ---- */
function paintIndex() {
    var here = location.href.split('?')[0];
    var panels = [];
    STATES.forEach(function (s, i) {
        panels.push({ title: s.title, note: s.note, i: i, sel: s.sel, w: 414, h: 852, tag: 'iPhone 414x852' });
    });
    // The two sizes the phone layout has to survive at the ends of its range,
    // both showing the bar state, because a card that only works at one
    // viewport height is a card that does not work.
    panels.push({
        title: 'Short phone (SE)', i: 0, w: 375, h: 667, tag: '375x667',
        note: 'The tightest screen in the building. The pass card keeps every line; what it loses is air between them, and the stack scrolls rather than clipping.',
    });
    panels.push({
        title: 'The desk composition', i: 0, w: 1180, h: 820, tag: '1180x820',
        note: 'From 1000px the open card body MOVES into the detail panel and the card goes back to card height, so nothing here is a tall empty box. The gold bar stays under the stack column.',
    });

    document.getElementById('hGrid').innerHTML = panels.map(function (p, n) {
        var q = '?state=' + p.i + (p.sel === undefined ? '' : '&sel=' + p.sel);
        return '<section class="h-panel" style="width:' + p.w + 'px">' +
            '<h2 class="h-title">' + p.title + '<span class="h-tag">' + p.tag + '</span></h2>' +
            '<p class="h-note">' + p.note + '</p>' +
            '<iframe class="h-frame" src="' + here + q + '" width="' + p.w + '" height="' + p.h +
              '" loading="eager" title="' + p.title + '" data-n="' + n + '"></iframe>' +
            '<pre class="h-meas" id="hMeas' + n + '">measuring</pre>' +
            '</section>';
    }).join('');

    // THE RATIOS, FROM THE RUNNING CARD, under the frame that produced them.
    // A panel with no numbers under it is a panel nobody has measured, and
    // that is the state every previous argument about this card was settled in.
    window.addEventListener('message', function (ev) {
        var g = ev.data && ev.data.wpGeom;
        if (!g) return;
        var frames = document.querySelectorAll('.h-frame');
        for (var i = 0; i < frames.length; i++) {
            if (frames[i].contentWindow !== ev.source) continue;
            var el = document.getElementById('hMeas' + frames[i].getAttribute('data-n'));
            if (!el) return;
            var pad = function (s, n) { s = String(s); while (s.length < n) s += ' '; return s; };
            var row = function (label, got, bar) {
                return pad(label, 12) + pad(got, 20) + (bar ? 'bar ' + bar : '');
            };
            var lines = [row('card', g.w + ' x ' + g.h), row('  h/w', g.hOverW, '1.121')];
            if (g.ring !== undefined) {
                lines.push(row('ring', g.ring + 'px'));
                lines.push(row('  /card', g.ringOverCard, '0.611'));
                if (g.strokeOverRing) lines.push(row('  arc/ring', g.strokeOverRing, '0.075'));
                lines.push(row('  circle', g.roundness, '1.000'));
            }
            if (g.clockPx !== undefined) {
                lines.push(row('digits', '"' + g.digits + '" ' + g.clockPx + 'px'));
                lines.push(row('  cap/card', g.capOverCard, '0.114'));
            }
            if (g.tripToAppby !== undefined) {
                lines.push(row('gap trip', g.tripToAppby + 'px to approver'));
                lines.push(row('empty', g.emptyBelow + 'px below card'));
            }
            lines.push(row('page', g.fits ? 'fits' : 'scrolls ' + g.overflowPx + 'px'));
            el.textContent = lines.join('\\n');
            el.className = 'h-meas' + (g.fits ? '' : ' h-meas-warn');
            return;
        }
    });
}

var qs = {};
location.search.replace(/^\\?/, '').split('&').forEach(function (kv) {
    if (!kv) return;
    var bits = kv.split('=');
    qs[bits[0]] = bits[1];
});

if (qs.state !== undefined) {
    document.body.className = 'is-phone';
    paintPhone(parseInt(qs.state, 10) || 0, qs.sel === undefined ? null : parseInt(qs.sel, 10));
} else {
    document.body.className = 'is-index';
    paintIndex();
}
`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wildcat hall pass card, every state</title>
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="wildcat-motion.css">
<style>
    /* The harness owns nothing the card can see. Everything here is either
       outside the portal (the index page's labels and frames) or the plain
       page reset the real app already gets. No .wp-* rule is redefined; if
       the card looks wrong in here, it is wrong. */
    html, body { margin: 0; background: #08080B; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #F6F4EF;
        -webkit-font-smoothing: antialiased;
    }
    /* Phone mode: the portal is the page, exactly as it is in the app. */
    body.is-phone { background: #0B0B0E; }
    body.is-index .wp-root { display: none; }

    .h-head { padding: 26px 26px 4px; }
    .h-head h1 { margin: 0; font-size: 19px; letter-spacing: -0.02em; }
    .h-head p { margin: 8px 0 0; max-width: 100ch; font-size: 13px; line-height: 1.55; color: #8E9199; }
    .h-geom { margin-top: 10px; font: 600 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #F5A623; }
    .h-grid { display: flex; flex-wrap: wrap; gap: 34px 26px; padding: 22px 26px 70px; align-items: flex-start; }
    .h-title {
        margin: 0 0 5px; font: 800 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: .06em; color: #F5A623; text-transform: uppercase;
        display: flex; justify-content: space-between; gap: 12px; align-items: baseline;
    }
    .h-tag { color: #55585F; font-weight: 600; letter-spacing: .04em; }
    .h-note { margin: 0 0 12px; font-size: 12.5px; line-height: 1.5; color: #8E9199; min-height: 72px; }
    .h-frame {
        display: block; border: 0; border-radius: 26px; background: #0B0B0E;
        box-shadow: 0 0 0 1px rgba(255,255,255,.09), 0 26px 60px -30px #000;
    }
    /* The ratios, measured off the running card, printed beside the ratios the
       reference sets. Outside every frame, so nothing here can touch the card. */
    .h-meas {
        margin: 12px 0 0; padding: 10px 12px; border-radius: 10px;
        background: #101216; color: #9FA6B2;
        font: 500 11px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre; overflow-x: auto;
    }
    .h-meas-warn { color: #E3B27A; }
</style>
</head>
<body>
<div class="h-head">
    <h1>Wildcat hall pass card, every state the code supports</h1>
    <p>
        Lifted from script.js at build time, not rebuilt here: wpHallPassCard, the pass clock
        arithmetic, wpTickClocks and the whole stack layout are the shipped functions,
        running live against payloads convex/passCard.ts can actually send. Styles are
        styles.css and wildcat-motion.css as served. Each panel is its own iframe at a real
        device size, because every height on this screen is a clamp against the viewport and
        every breakpoint is a query against its width: a 414px column inside a desktop window
        would resolve the desk tokens and quietly lie. Regenerate with
        <code>node scripts/build-pass-harness.mjs</code>.
    </p>
    <p class="h-geom" id="hGeom">script.js ${(stat.size / 1024).toFixed(0)}KB, modified ${stat.mtime.toISOString()}</p>
</div>
<div class="h-grid" id="hGrid"></div>

<!-- Phone mode renders into this. It is the student portal's own markup: the
     same ids wpMetrics measures, the same stack wpLayout writes into, the same
     bar wpRender fills. -->
<div id="studentPassView" class="wp-root">
    <div class="wp-shell">
        <header class="wp-top">
            <span class="wp-avatar" id="wpAvatar" aria-hidden="true"></span>
            <div class="wp-who">
                <h1 class="wp-name" id="wpName"></h1>
                <p class="wp-meta" id="wpMeta"></p>
            </div>
        </header>
        <div class="wp-stage">
            <div class="wp-metric wp-metric-strip" id="wpMetricStrip" aria-hidden="true"></div>
            <div class="wp-metric wp-metric-card" id="wpMetricCard" aria-hidden="true"></div>
            <div class="wp-metric wp-metric-pass" id="wpMetricPass" aria-hidden="true"></div>
            <div class="wp-stack" id="wpStack" role="tablist" aria-label="Your passes"></div>
        </div>
        <div class="wp-passbar" id="wpPassBar"></div>
        <aside class="wp-detail" id="wpDetail">
            <div class="wp-detail-head">
                <h2 class="wp-detail-label" id="wpDetailLabel"></h2>
                <span class="wp-detail-lead" id="wpDetailLead"></span>
            </div>
        </aside>
        <p class="wp-asof" id="wpAsOf"></p>
        <div class="wp-note" id="wpError"></div>
    </div>
</div>

<script>
/* A HARNESS THAT BREAKS MUST LOOK BROKEN. The lifted code can reference a
   symbol this file did not slice, and the failure mode is quiet: the digits
   still tick from the deal, the ring keeps whatever the stylesheet gave it, and
   the page looks nearly right while showing the wrong thing. That is exactly
   the class of bug this harness exists to catch, so it is not allowed to have
   it. Any error paints a band across the top and says what it was. */
window.addEventListener('error', function (e) {
    var band = document.createElement('pre');
    band.style.cssText = 'position:fixed;z-index:99999;inset:0 0 auto 0;margin:0;padding:10px 14px;' +
        'background:#B3241A;color:#fff;font:700 12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap';
    band.textContent = 'HARNESS BROKEN: ' + (e.message || e) +
        '\\nRegenerate with node scripts/build-pass-harness.mjs, and add the missing slice to PIECES.';
    (document.body || document.documentElement).appendChild(band);
});

/* ---- stubs: everything the card calls that is not the card ---- */
function wcNativeNfcAvailable() { return true; }
function wcNativeHaptic() {}
function openHallPassSheet() {}
function cancelHallPassRequest() {}
function wcStudentNfcScan() {}

/* ---- lifted verbatim from script.js ---- */
${lifted}

/* ---- the harness itself ---- */
${DRIVER}
</script>
</body>
</html>
`;

const out = join(root, 'pass-card-harness.html');
writeFileSync(out, page);
console.log(`wrote ${out} (${(page.length / 1024).toFixed(0)}KB, ${PIECES.length} slices lifted)`);
