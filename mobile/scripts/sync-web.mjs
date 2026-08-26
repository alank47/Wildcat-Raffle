// Copies the student-facing web files from the repo root into mobile/www/, which
// is what Capacitor bundles. The app ships the SAME portal the browser serves;
// there is no second copy of the UI to drift. Run by `npm run sync-web` and by
// `prepare-native` before every native build.
//
// Zero dependencies on purpose, like powerschool/sync: this must run with no
// install step so a fresh clone can prepare a build immediately.
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
// Normally the repo is one level up. When this script has been staged OUTSIDE
// the repo (see stage-native.mjs, which exists because Dropbox corrupts native
// builds), a .wildcat-repo-root pointer says where the real repo is.
const rootPointer = join(mobile, '.wildcat-repo-root');
const root = existsSync(rootPointer)
  ? readFileSync(rootPointer, 'utf8').trim()
  : resolve(mobile, '..');
const www = join(mobile, 'www');

// THE PORTAL'S FILES, READ OFF index.html RATHER THAN LISTED HERE.
//
// This used to be a hand-kept list, and it was six scripts behind the page it
// shipped: main had grown wildcat-roster.js, wildcat-store.js, wildcat-merge.js,
// wildcat-savequeue.js, wildcat-discipline.js and wildcat-icons.js, none of
// which the app copied, so a staff member opening the native shell would have
// got a page whose <script> tags 404 inside the bundle. index.html is the one
// place that already knows every local file it needs, so it is the source: every
// same-origin <script src> and stylesheet <link href> is copied, plus the few
// files the page reaches for by other means (the manifest, the service worker,
// the favicon, the assets folder). Both sign-ins live in this one page, so this
// is the staff app and the student app alike.
const indexSrc = readFileSync(join(root, 'index.html'), 'utf8');
const local = (url) => /^(?!https?:|\/\/|data:)[^\s"'?#]+/.test(url) ? url.split('?')[0].split('#')[0] : null;
const referenced = new Set();
for (const m of indexSrc.matchAll(/<script[^>]+src="([^"]+)"/g)) { const f = local(m[1]); if (f) referenced.add(f); }
for (const m of indexSrc.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)) { const f = local(m[1]); if (f) referenced.add(f); }
const FILES = ['index.html', ...referenced, 'manifest.json', 'sw.js', 'favicon.ico']
  .filter((f, i, a) => a.indexOf(f) === i && !f.startsWith('assets/'));
const DIRS = ['assets'];

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });

let copied = 0;
for (const f of FILES) {
  const src = join(root, f);
  if (!existsSync(src)) {
    console.warn(`[sync-web] skip missing ${f}`);
    continue;
  }
  await cp(src, join(www, f));
  copied++;
}
for (const d of DIRS) {
  const src = join(root, d);
  if (existsSync(src)) {
    await cp(src, join(www, d), { recursive: true });
    copied++;
  }
}

// The native bridge. Loaded by index.html AFTER capacitor.js injects
// window.Capacitor, it flips a flag the portal reads to route NFC through the
// plugin instead of Web NFC. Kept as its own file so the web build never ships
// it and the app never has to be rebuilt to change it.
const bridge = `// Injected into the native build only, by sync-web.mjs.
(function () {
  try {
    var C = window.Capacitor;
    window.WC_NATIVE = !!(C && C.isNativePlatform && C.isNativePlatform());
    window.WC_NATIVE_PLATFORM = (C && C.getPlatform && C.getPlatform()) || 'web';
    document.documentElement.classList.toggle('wc-native', window.WC_NATIVE);
  } catch (e) { window.WC_NATIVE = false; }
})();
`;
await writeFile(join(www, 'native-bridge.js'), bridge);

// Inject the bridge into the COPIED index.html only, so the web build served
// from GitHub Pages never references a file it does not ship (a 404 that would
// otherwise show on every page load). Idempotent: skip if already present.
const indexPath = join(www, 'index.html');
if (existsSync(indexPath)) {
  const { readFile } = await import('node:fs/promises');
  let html = await readFile(indexPath, 'utf8');
  if (!html.includes('native-bridge.js')) {
    const tag = '    <script src="native-bridge.js"></script>\n';
    html = html.includes('</head>')
      ? html.replace('</head>', tag + '</head>')
      : tag + html;
    await writeFile(indexPath, html);
  }
}

console.log(`[sync-web] www ready: ${copied} entries + native-bridge.js`);
