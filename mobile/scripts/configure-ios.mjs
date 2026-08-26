// Applies the native iOS configuration Capacitor cannot generate for us.
//
// WHY THIS FILE EXISTS. `mobile/ios/` is gitignored and regenerated per machine
// with `npx cap add ios`, so every one of these settings is created empty on a
// fresh clone. Done by hand in Xcode they are invisible to the repo: an NFC
// entitlement that is missing crashes the app the moment a scan session starts,
// and an associated domain that is missing makes every tag in the school open
// Safari instead of the app, silently, with no error anywhere. Nobody would know
// until a student stood at a doorway. So the config lives here as code, runs
// after `cap add ios`, and is idempotent.
//
// Zero dependencies on purpose, like sync-web.mjs and powerschool/sync: this has
// to run on a fresh clone before anything is installed.
//
// Run: npm run configure:ios   (or it runs inside `npm run prepare-native`)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const iosApp = join(mobile, 'ios', 'App');
const appDir = join(iosApp, 'App');
const plist = join(appDir, 'Info.plist');
const entitlements = join(appDir, 'App.entitlements');
const pbxproj = join(iosApp, 'App.xcodeproj', 'project.pbxproj');

// Apple Team ID for the Myind Media account. Not a secret: it ships publicly in
// .well-known/apple-app-site-association, which is how Apple matches the app.
const TEAM_ID = 'SCFGWPBXMF';
// Apex only. www.wildcatraffle.com 301-redirects and Apple forbids redirects on
// the association file, so a www entry fails silently. See docs/universal-links.md.
const ASSOCIATED_DOMAIN = 'applinks:wildcatraffle.com';

if (!existsSync(iosApp)) {
  console.error(
    '[configure-ios] no ios/App yet. Run `npx cap add ios` first (see mobile/SETUP.md).',
  );
  process.exit(1);
}

const PB = '/usr/libexec/PlistBuddy';

/** PlistBuddy, with "already set" treated as success rather than an error. */
function plistSet(file, entry, type, value) {
  try {
    execFileSync(PB, ['-c', `Add :${entry} ${type} ${value}`, file], { stdio: 'pipe' });
    return 'added';
  } catch {
    execFileSync(PB, ['-c', `Set :${entry} ${value}`, file], { stdio: 'pipe' });
    return 'updated';
  }
}

function plistHasArrayValue(file, entry, value) {
  try {
    const out = execFileSync(PB, ['-c', `Print :${entry}`, file], { encoding: 'utf8' });
    return out.includes(value);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------
// 1. Info.plist usage strings.
//
// NFCReaderUsageDescription is not optional and not cosmetic: without it iOS
// terminates the app the instant a reader session begins. The camera string is
// the same deal for the barcode fallback.
// ---------------------------------------------------------------
console.log(
  '[configure-ios] Info.plist NFCReaderUsageDescription:',
  plistSet(
    plist,
    'NFCReaderUsageDescription',
    'string',
    "'Wildcat Hub reads the tag at the doorway to start and end your hall pass.'",
  ),
);
console.log(
  '[configure-ios] Info.plist NSCameraUsageDescription:',
  plistSet(
    plist,
    'NSCameraUsageDescription',
    'string',
    "'Wildcat Hub uses the camera to scan a pass code when a tag cannot be read.'",
  ),
);

// ---------------------------------------------------------------
// 1b. The name iOS puts in system dialogs.
//
// Capacitor sets CFBundleDisplayName from appName, which is the Home Screen
// label, and leaves CFBundleName as $(PRODUCT_NAME) — "App". Several SYSTEM
// prompts use CFBundleName rather than the display name, most visibly the
// sign-in consent sheet, which without this reads:
//
//   "App" Wants to Use "google.com" to Sign In
//
// A child being asked that by something called "App" has every reason to be
// suspicious, and should be. It is the school's app; it should say so.
// ---------------------------------------------------------------
console.log(
  '[configure-ios] Info.plist CFBundleName:',
  plistSet(plist, 'CFBundleName', 'string', "'Wildcat Hub'"),
);

// ---------------------------------------------------------------
// 2. Entitlements.
//
// NDEF alone covers NFCNDEFReaderSession. TAG is included because the NFC plugin
// defaults to the richer tag session and silently downgrades without it, which
// surfaces as a mysterious "fallback" flag rather than an error.
//
// The associated domain is what makes an NFC tag open the app instead of Safari.
// Adding it here is only half the job: the capability must also be enabled on the
// App ID in the developer portal, and the provisioning profile regenerated after.
// Xcode does that when you tick Associated Domains; this file keeps the value
// correct once it has.
// ---------------------------------------------------------------
if (!existsSync(entitlements)) {
  writeFileSync(
    entitlements,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
</dict>
</plist>
`,
  );
  console.log('[configure-ios] created App.entitlements');
}

for (const format of ['NDEF', 'TAG']) {
  const key = 'com.apple.developer.nfc.readersession.formats';
  try {
    execFileSync(PB, ['-c', `Print :${key}`, entitlements], { stdio: 'pipe' });
  } catch {
    execFileSync(PB, ['-c', `Add :${key} array`, entitlements], { stdio: 'pipe' });
  }
  if (!plistHasArrayValue(entitlements, key, format)) {
    execFileSync(PB, ['-c', `Add :${key}: string ${format}`, entitlements], { stdio: 'pipe' });
    console.log(`[configure-ios] entitlement NFC format ${format}: added`);
  } else {
    console.log(`[configure-ios] entitlement NFC format ${format}: already present`);
  }
}

{
  const key = 'com.apple.developer.associated-domains';
  try {
    execFileSync(PB, ['-c', `Print :${key}`, entitlements], { stdio: 'pipe' });
  } catch {
    execFileSync(PB, ['-c', `Add :${key} array`, entitlements], { stdio: 'pipe' });
  }
  if (!plistHasArrayValue(entitlements, key, ASSOCIATED_DOMAIN)) {
    execFileSync(PB, ['-c', `Add :${key}: string ${ASSOCIATED_DOMAIN}`, entitlements], {
      stdio: 'pipe',
    });
    console.log(`[configure-ios] entitlement ${ASSOCIATED_DOMAIN}: added`);
  } else {
    console.log(`[configure-ios] entitlement ${ASSOCIATED_DOMAIN}: already present`);
  }
}

// ---------------------------------------------------------------
// 2b. The Google sign-in callback URL scheme.
//
// Google's iOS SDK returns the student to the app through a custom URL scheme
// that is the CLIENT ID WITH ITS DOTTED PARTS REVERSED. Without it registered
// here, the sign-in sheet opens, the student authenticates, and then nothing
// happens: iOS has nowhere to deliver the result and the app sits on the
// sign-in screen looking broken. It is the single most common way native Google
// sign-in "silently fails".
//
// Derived from the client id rather than pasted separately, so the two cannot
// drift apart. Google's own downloaded plist calls it REVERSED_CLIENT_ID and it
// is exactly this transformation.
// ---------------------------------------------------------------
const GOOGLE_IOS_CLIENT_ID =
  '718452352756-9gvjcrk7t7qd8k27d4fpp76qabhvko1r.apps.googleusercontent.com';
const reversedClientId = GOOGLE_IOS_CLIENT_ID.split('.').reverse().join('.');

try {
  execFileSync(PB, ['-c', 'Print :CFBundleURLTypes', plist], { stdio: 'pipe' });
} catch {
  execFileSync(PB, ['-c', 'Add :CFBundleURLTypes array', plist], { stdio: 'pipe' });
}
if (!plistHasArrayValue(plist, 'CFBundleURLTypes', reversedClientId)) {
  execFileSync(PB, ['-c', 'Add :CFBundleURLTypes: dict', plist], { stdio: 'pipe' });
  const idx = execFileSync(PB, ['-c', 'Print :CFBundleURLTypes', plist], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.trim() === 'Dict {').length - 1;
  execFileSync(PB, ['-c', `Add :CFBundleURLTypes:${idx}:CFBundleURLSchemes array`, plist], {
    stdio: 'pipe',
  });
  execFileSync(
    PB,
    ['-c', `Add :CFBundleURLTypes:${idx}:CFBundleURLSchemes: string ${reversedClientId}`, plist],
    { stdio: 'pipe' },
  );
  console.log(`[configure-ios] Google callback URL scheme added: ${reversedClientId}`);
} else {
  console.log('[configure-ios] Google callback URL scheme: already present');
}

// The Microsoft (Entra) callback scheme, for STAFF sign-in in the app.
//
// Same job as the Google one above and the same silent failure if missing: the
// sheet opens, the teacher authenticates, and iOS has nowhere to deliver the
// result. This is what lets a teacher on an iPhone sign in and therefore
// PROGRAM A TAG, which is the one thing no browser can do on iOS.
//
// The matching reply URL, `msauth.org.westbrookacademy.wildcat://auth`, must
// also exist on the Wildcat Hub app registration in Entra. Both halves are
// required; neither works alone.
const entraScheme = 'msauth.org.westbrookacademy.wildcat';
if (!plistHasArrayValue(plist, 'CFBundleURLTypes', entraScheme)) {
  execFileSync(PB, ['-c', 'Add :CFBundleURLTypes: dict', plist], { stdio: 'pipe' });
  const eIdx = execFileSync(PB, ['-c', 'Print :CFBundleURLTypes', plist], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.trim() === 'Dict {').length - 1;
  execFileSync(PB, ['-c', `Add :CFBundleURLTypes:${eIdx}:CFBundleURLSchemes array`, plist], {
    stdio: 'pipe',
  });
  execFileSync(
    PB,
    ['-c', `Add :CFBundleURLTypes:${eIdx}:CFBundleURLSchemes: string ${entraScheme}`, plist],
    { stdio: 'pipe' },
  );
  console.log(`[configure-ios] Microsoft callback URL scheme added: ${entraScheme}`);
} else {
  console.log('[configure-ios] Microsoft callback URL scheme: already present');
}

// ---------------------------------------------------------------
// 3. The Xcode project: team, and the entitlements file it signs with.
//
// CODE_SIGN_ENTITLEMENTS is the line people forget. The file above can be
// perfect and unused: without this the target signs with no entitlements, the
// NFC session fails and the universal link never fires, and the only symptom is
// that nothing happens.
// ---------------------------------------------------------------
let proj = readFileSync(pbxproj, 'utf8');
const before = proj;

if (/DEVELOPMENT_TEAM = /.test(proj)) {
  proj = proj.replace(/DEVELOPMENT_TEAM = [^;]*;/g, `DEVELOPMENT_TEAM = ${TEAM_ID};`);
} else {
  proj = proj.replace(
    /(PRODUCT_BUNDLE_IDENTIFIER = [^;]*;)/g,
    `$1\n\t\t\t\tDEVELOPMENT_TEAM = ${TEAM_ID};`,
  );
}

if (!/CODE_SIGN_ENTITLEMENTS = /.test(proj)) {
  proj = proj.replace(
    /(PRODUCT_BUNDLE_IDENTIFIER = [^;]*;)/g,
    `$1\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = App/App.entitlements;`,
  );
}

if (proj !== before) {
  writeFileSync(pbxproj, proj);
  console.log(`[configure-ios] project.pbxproj: DEVELOPMENT_TEAM=${TEAM_ID}, entitlements wired`);
} else {
  console.log('[configure-ios] project.pbxproj: already correct');
}

// ---------------------------------------------------------------
// 4. Repair SPM product names Capacitor guessed wrong.
//
// Capacitor 8 builds iOS through Swift Package Manager and generates
// ios/App/CapApp-SPM/Package.swift by deriving each product name from the NPM
// PACKAGE NAME: `@exxili/capacitor-nfc` becomes `ExxiliCapacitorNfc`. A plugin
// whose Package.swift names its library something else does not match, and the
// build dies before compiling a single file:
//
//   xcodebuild: error: Could not resolve package dependencies:
//     product 'ExxiliCapacitorNfc' required by package 'capapp-spm'
//     target 'CapApp-SPM' not found in package 'ExxiliCapacitorNfc'
//
// @exxili/capacitor-nfc@0.0.13 declares `.library(name: "CapacitorNfc")`, so it
// trips this. The package REFERENCE stays as Capacitor wrote it; only the
// product name is corrected, which is the half Capacitor got wrong.
//
// Done generically rather than hard-coding one plugin, because the next plugin
// added to this app can hit the same thing and the failure message points at
// Capacitor rather than at the plugin, which sends you the wrong way.
// ---------------------------------------------------------------
const spmPackage = join(iosApp, 'CapApp-SPM', 'Package.swift');
if (existsSync(spmPackage)) {
  let spm = readFileSync(spmPackage, 'utf8');
  const original = spm;
  const refs = [...spm.matchAll(/\.package\(name: "([^"]+)", path: "([^"]+)"\)/g)];
  for (const [, pkgName, relPath] of refs) {
    const pkgSwift = resolve(join(iosApp, 'CapApp-SPM'), relPath, 'Package.swift');
    if (!existsSync(pkgSwift)) continue;
    const declared = readFileSync(pkgSwift, 'utf8').match(/\.library\(\s*name: "([^"]+)"/);
    if (!declared) continue;
    const realProduct = declared[1];
    if (realProduct === pkgName) continue;
    const wrong = `.product(name: "${pkgName}", package: "${pkgName}")`;
    const right = `.product(name: "${realProduct}", package: "${pkgName}")`;
    if (spm.includes(wrong)) {
      spm = spm.split(wrong).join(right);
      console.log(`[configure-ios] SPM product for ${pkgName}: "${pkgName}" -> "${realProduct}"`);
    }
  }
  if (spm !== original) {
    writeFileSync(spmPackage, spm);
    console.log('[configure-ios] CapApp-SPM/Package.swift repaired');
  } else {
    console.log('[configure-ios] CapApp-SPM/Package.swift: all product names already correct');
  }
}

// 5. THE APP ICON, from the one source file the repo keeps.
//
// ios/ is regenerated per machine, so an icon dropped into the asset catalog by
// hand is gone on the next clone, and Capacitor's placeholder ships instead. The
// source is assets/app-icon-source.png in the repo (the Westbrook mark on black,
// as supplied 2026-08-26). Apple requires exactly 1024x1024 with NO alpha
// channel, so it is flattened onto black on the way in: ImageMagick if it is
// installed, otherwise sips through a JPEG round-trip, which drops alpha for
// free on a flat two-colour mark.
{
  const rootPointer = join(mobile, '.wildcat-repo-root');
  const root = existsSync(rootPointer) ? readFileSync(rootPointer, 'utf8').trim() : resolve(mobile, '..');
  const source = join(root, 'assets', 'app-icon-source.png');
  const iconset = join(appDir, 'Assets.xcassets', 'AppIcon.appiconset');
  const target = join(iconset, 'AppIcon-512@2x.png');
  if (!existsSync(source)) {
    console.warn('[configure-ios] app icon: assets/app-icon-source.png missing, placeholder kept');
  } else if (!existsSync(iconset)) {
    console.warn('[configure-ios] app icon: no AppIcon.appiconset in ios/App/App/Assets.xcassets');
  } else {
    let done = false;
    try {
      execFileSync('magick', [source, '-background', 'black', '-alpha', 'remove', '-alpha', 'off',
        '-resize', '1024x1024!', '-strip', target], { stdio: 'pipe' });
      done = true;
    } catch (e) { /* no ImageMagick here */ }
    if (!done) {
      const tmp = join(iconset, 'AppIcon-tmp.jpg');
      execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '100', source, '--out', tmp], { stdio: 'pipe' });
      execFileSync('sips', ['-s', 'format', 'png', '-z', '1024', '1024', tmp, '--out', target], { stdio: 'pipe' });
      execFileSync('rm', ['-f', tmp]);
    }
    const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', target], { encoding: 'utf8' });
    const w = /pixelWidth: (\d+)/.exec(info)?.[1], h = /pixelHeight: (\d+)/.exec(info)?.[1], a = /hasAlpha: (\w+)/.exec(info)?.[1];
    if (w !== '1024' || h !== '1024' || a !== 'no') {
      console.error(`[configure-ios] app icon came out ${w}x${h} alpha=${a}; Apple needs 1024x1024 with no alpha`);
      process.exit(1);
    }
    console.log('[configure-ios] app icon: 1024x1024, no alpha, from assets/app-icon-source.png');
  }
}

console.log('[configure-ios] done. Verify in Xcode: Signing & Capabilities should list');
console.log('[configure-ios]   "Near Field Communication Tag Reading" and "Associated Domains".');
console.log('[configure-ios] If Associated Domains is absent, add it once in Xcode so the');
console.log('[configure-ios] capability is enabled on the App ID, then re-run this script.');
