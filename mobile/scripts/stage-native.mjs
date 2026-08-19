// Stages the native build OUTSIDE Dropbox, and tells you where it went.
//
// WHY. This repo lives under ~/Library/CloudStorage/Dropbox-MyindSound/, and
// Dropbox in FileProvider mode cannot be told to leave a build directory alone:
//
//   - `xattr -w com.dropbox.ignored 1` on a populated folder makes Dropbox
//     DELETE the local copy. A freshly generated ios/ became an empty directory
//     plus an "ios 2" conflict folder within a minute.
//   - The same xattr set on an EMPTY folder before `npm install` did not stop it
//     either: 269 conflicted copies appeared inside node_modules during a single
//     install.
//   - A committed `.dropboxignore` listing node_modules did not stop it.
//   - Replacing node_modules with a SYMLINK to a folder outside Dropbox lasted
//     minutes: Dropbox treated the symlink as a deletion and restored its own
//     directory over it, conflicted copies and all.
//
// The failures are silent and they do not look like Dropbox. A conflicted
// `.swift` file gets compiled beside the real one and Swift reports
// `invalid redeclaration of 'AppPlugin'` or `Unable to find module dependency:
// 'IONCameraLib'`, which reads like a broken dependency and sends you into npm.
//
// So the native project is not built in Dropbox at all. The repo keeps the
// SOURCE (config, scripts, the web portal); this script copies that source to a
// staging directory on the local disk, and every native command runs there.
//
// Zero dependencies, like sync-web.mjs, so it runs on a fresh clone.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const root = resolve(mobile, '..');

// Overridable so CI or another machine can put it somewhere else.
export const STAGE = process.env.WILDCAT_NATIVE_DIR
  ? resolve(process.env.WILDCAT_NATIVE_DIR)
  : join(homedir(), '.wildcat-build', 'mobile');

if (STAGE.includes('CloudStorage') || STAGE.includes('Dropbox')) {
  console.error(
    `[stage-native] refusing to stage inside Dropbox: ${STAGE}\n` +
      '  That is the entire problem this script exists to avoid.',
  );
  process.exit(1);
}

// The tracked sources. node_modules, ios, android and www are NOT copied: they
// are generated in the staging directory and never travel.
const COPY = ['package.json', 'capacitor.config.ts', 'scripts'];

await mkdir(STAGE, { recursive: true });

for (const entry of COPY) {
  const src = join(mobile, entry);
  if (!existsSync(src)) {
    console.warn(`[stage-native] skip missing ${entry}`);
    continue;
  }
  await rm(join(STAGE, entry), { recursive: true, force: true });
  await cp(src, join(STAGE, entry), { recursive: true });
}

// The web portal, copied straight from the repo root into the staging www/.
// This is sync-web's job, so it is reused rather than duplicated: run it with
// its output redirected at the staging directory.
const syncWeb = await readFile(join(mobile, 'scripts', 'sync-web.mjs'), 'utf8');
await writeFile(join(STAGE, 'scripts', 'sync-web.mjs'), syncWeb);

// sync-web resolves the repo root as `../..` from its own location, which is
// wrong once it lives outside the repo. A tiny pointer file tells it where the
// real repo is; sync-web reads it when present.
await writeFile(join(STAGE, '.wildcat-repo-root'), root + '\n');

console.log(`[stage-native] staged to ${STAGE}`);
console.log('[stage-native] next, from THAT directory:');
console.log('    npm install');
console.log('    npx cap add ios          # first time only');
console.log('    npm run configure:ios');
console.log('');
console.log('[stage-native] never run npm install or cap add inside the repo copy.');
console.log('[stage-native] see mobile/SETUP.md for why.');
