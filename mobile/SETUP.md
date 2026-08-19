# Wildcat student app (iOS + Android) setup

A Capacitor wrapper of the existing student portal. One web codebase, native
Core NFC + camera + push. Distribution is private (TestFlight / Apple School
Manager), not the public App Store.

## Prerequisites

- Node 22 (`/opt/homebrew/opt/node@22/bin`)
- iOS: Xcode + CocoaPods (`sudo gem install cocoapods`)
- Android: Android Studio (+ an SDK + a device/emulator)
- Real-device NFC + TestFlight: an Apple Developer account ($99/yr). Scaffold and
  the iOS simulator do NOT need it. NFC does NOT work in the simulator; test taps
  on a real iPhone (XS or newer).

## First-time generation

Run from `mobile/`. `node_modules`, `www`, `ios`, `android` are gitignored, so
this is regenerated per machine (and is heavy, so prefer a real terminal over an
editor task):

```
cd mobile
npm install
npm run sync-web            # copy the student portal into www/
npx cap add ios
npx cap add android
npm run configure:ios       # entitlements, usage strings, signing team
```

### Why Capacitor 8 and not the 6 this project started on

Because students could not sign in. Google Identity Services refuses to load
under a `capacitor://` origin, and iOS cannot give a locally served webview an
`https://` origin: `iosScheme: 'https'` is ignored, because WKWebView reserves
http and https for real network loads. Measured in the simulator, not assumed:

```
origin: capacitor://wildcatraffle.com
XHR https://accounts.google.com/gsi/client -> status 0 (CORS)
script tag -> onerror        (this is the "Failed to load" the student sees)
```

The fix is native Google sign-in, and the only maintained Capacitor plugin for it
(`@capgo/capacitor-social-login`) requires Capacitor >= 8. Going to 8 was the
smaller debt: Capacitor 6 was two majors old and its no-bundler escape hatch
`bundledWebRuntime` is already deprecated and slated for removal.

`@capacitor-community/barcode-scanner` was **dropped**, not upgraded. Its peer
range is `^5.0.0`, so it was incompatible with Capacitor 6 as well and had never
loaded: `cap add ios` on 6 reported five plugins, not six. Nothing referenced it.
The maintained replacement is `@capacitor-mlkit/barcode-scanning`, and it should
be added only once open question 20 in `Grilled.md` says what the student camera
is actually for.

The backend needs no change. `convex/auth.config.ts` validates a token's `aud`
against a specific Google client ID, and the native plugin's `serverClientId`
option requests an ID token audienced to that same existing web client.

Verified working on 2026-08-18: **Capacitor 8.5.0**, Xcode 26.3, Node 22 from the
keg at `/opt/homebrew/opt/node@22/bin`. Capacitor found all six native plugins
including `@exxili/capacitor-nfc@0.0.13`, which is the proof the swap away from
the paid plugin works: `npm install` completes, where the old dependency 404s for
anyone without a licence key.

**CocoaPods is NOT required.** Capacitor 8 builds iOS through Swift Package
Manager: `cap add ios` reports "All Capacitor plugins have a Package.swift file"
and writes `ios/App/CapApp-SPM`. There is no `.xcworkspace` any more, only
`App.xcodeproj`, which changes every `xcodebuild` invocation you may have
copied from an older guide:

```
# Capacitor 8 (this project)
xcodebuild -project ios/App/App.xcodeproj -scheme App ...

# Capacitor 6 and earlier, WRONG here
xcodebuild -workspace ios/App/App.xcworkspace -scheme App ...
```

CocoaPods was installed during this session while the project was still on
Capacitor 6. It is harmless to keep and no longer used.

### 🚨 THE NATIVE BUILD DOES NOT HAPPEN IN THIS FOLDER

Run every native command from the STAGING directory, not from the repo:

```
cd mobile
npm run stage            # copies config + scripts + the portal to ~/.wildcat-build/mobile
cd ~/.wildcat-build/mobile
npm install              # first time
npx cap add ios          # first time
npm run configure:ios
npm run sync-web         # after any change to the web portal
```

`npm run stage` reads the repo and writes the staging copy; a
`.wildcat-repo-root` pointer tells the staged `sync-web` where the real portal
lives, so the app always ships the same files the website serves. Nothing in the
staging directory is edited by hand and nothing there is precious: delete it and
re-stage.

**Why this is not optional.** Dropbox in FileProvider mode cannot be told to
leave a build directory alone, and every escape hatch was tried and failed:

| Attempt | Outcome |
|---|---|
| `xattr com.dropbox.ignored` on a populated `ios/` | Dropbox **deleted** it into an `ios 2` conflict folder within a minute |
| Same xattr on an EMPTY `node_modules` before install | 269 conflicted copies appeared during the install anyway |
| Committed `.dropboxignore` listing `node_modules` | ignored |
| `node_modules` as a symlink to a folder outside Dropbox | Dropbox replaced the symlink with its own restored directory, 314 conflicted copies |

The failures never look like Dropbox. A conflicted `.swift` file gets compiled
beside the real one and Swift says:

```
error: invalid redeclaration of 'AppPlugin'
error: Unable to find module dependency: 'IONCameraLib'
```

which reads like a broken dependency and sends you into npm for an hour. First
diagnostic for any inexplicable native build failure:

```
find -L . -name "*conflicted copy*" | wc -l
```

`mobile/package.json` declares `typescript` for the same reason: outside the repo
there is no parent `node_modules` to borrow it from, and the Capacitor CLI needs
it to read `capacitor.config.ts`.

### The symlink attempt, kept as a record of what does NOT work

`.dropboxignore` and the `com.dropbox.ignored` xattr were both in place and
Dropbox still produced **269 conflicted copies** inside `mobile/node_modules`
during a single install, including
`CameraPlugin (Myind Sound's conflicted copy 2026-08-18).swift`, which Swift
Package Manager then tried to compile:

```
error: Unable to find module dependency: 'IONCameraLib'
```

That error names a module, so it reads like a broken dependency. It is not. It is
Dropbox. The fix that actually holds:

```
rm -rf mobile/node_modules mobile/package-lock.json
mkdir -p ~/.wildcat-build/mobile-node-modules
ln -s ~/.wildcat-build/mobile-node-modules mobile/node_modules
cd mobile && npm install
```

Zero conflicts after that. If a native build ever fails with a missing module or
a syntax error in a file you have never edited, run
`find -L mobile/node_modules mobile/ios -name "*conflicted copy*"` before
debugging anything else.

### ⚠️ Capacitor 8 guesses SPM product names, and guesses wrong

`cap add ios` derives each Swift package product name from the NPM package name,
so `@exxili/capacitor-nfc` becomes `ExxiliCapacitorNfc`. That plugin's own
`Package.swift` declares `.library(name: "CapacitorNfc")`, so resolution fails
before a single file compiles:

```
xcodebuild: error: Could not resolve package dependencies:
  product 'ExxiliCapacitorNfc' required by package 'capapp-spm'
  target 'CapApp-SPM' not found in package 'ExxiliCapacitorNfc'
```

`npm run configure:ios` repairs this automatically and generically: it reads each
referenced package's real `.library(name:)` and corrects the product name in the
generated `CapApp-SPM/Package.swift`. It runs inside `prepare-native`, and it has
to run after every `cap sync`, because the file is regenerated each time.

### ⚠️ This repo lives in Dropbox, and Dropbox will eat the native build

`ios/`, `android/` and `node_modules/` are thousands of generated files that are
already gitignored. Dropbox syncing them is pure cost, and this repo has a
history of Dropbox evicting or conflict-renaming heavy folders mid-write.

**`mobile/.dropboxignore` exists for exactly this and is committed.** Leave it
alone. It declares the rule BEFORE the folders are created, which is the only
ordering that works.

Do **not** try to fix this after the fact with
`xattr -w com.dropbox.ignored 1 ios`. Marking a folder Dropbox has already begun
syncing tells it to un-sync, and it removes the local copy: during this session
that turned a freshly generated `ios/` into an empty directory plus an `ios 2`
conflict folder, thirty seconds after `cap add ios` reported success. The xattr
is only safe on a directory that is still empty.

## iOS native config: run the script, do not do it by hand

```
npm run configure:ios
```

`mobile/ios/` is gitignored and regenerated per machine, so every native setting
is born empty on a fresh clone. Done by hand in Xcode they are invisible to the
repo, and both failure modes are silent: a missing NFC entitlement crashes the
app the instant a scan session starts, and a missing associated domain sends
every tag in the school to Safari with no error anywhere. So they live in
`scripts/configure-ios.mjs`, they are idempotent, and `prepare-native` runs them
after every `cap sync`, because `pod install` rewrites parts of `project.pbxproj`.

It sets: `NFCReaderUsageDescription` and `NSCameraUsageDescription`; the
`com.apple.developer.nfc.readersession.formats` entitlement with **both** `NDEF`
and `TAG` (the NFC plugin defaults to the richer tag session and silently
downgrades without `TAG`, surfacing as a mysterious fallback flag rather than an
error); `com.apple.developer.associated-domains` with `applinks:wildcatraffle.com`;
`DEVELOPMENT_TEAM = SCFGWPBXMF`; and `CODE_SIGN_ENTITLEMENTS`, which is the line
people forget and which makes the entitlements file above actually get used
rather than sit on disk being perfect and ignored.

The one thing it cannot do is enable the **Associated Domains capability on the
App ID** in the developer portal. That needs ticking once in Xcode's Signing &
Capabilities, after which the provisioning profile must be regenerated. Re-run
the script afterwards.

### The old manual steps, kept only so nobody re-does them by hand

## iOS native config (once, after `cap add ios`)

In Xcode (`npm run open:ios`):

1. Signing & Capabilities → add **Near Field Communication Tag Reading**.
2. Signing & Capabilities → add **Associated Domains**, entry
   `applinks:wildcatraffle.com`. Required for the background-tag-read path (see
   `@capacitor/app` below). Never use `www.wildcatraffle.com`: it 301-redirects
   and Apple refuses redirects.
3. `Info.plist` → add `NFCReaderUsageDescription` ("Wildcat uses NFC to check you
   in at hall-pass tags."), `NSCameraUsageDescription`, and for writing tags the
   `com.apple.developer.nfc.readersession.formats` entitlement includes `NDEF`.
4. Set the Team to your Apple Developer account for device builds.
5. Do **not** hand-edit `ios/App/App/AppDelegate.swift`. The Capacitor template
   already wires `application(_:continue:restorationHandler:)`, and that method
   is the only thing that feeds `appUrlOpen` and `getLaunchUrl()`. Deleting it
   while pasting in a third-party SDK's AppDelegate kills universal links with
   no error anywhere.

## Android native config (once, after `cap add android`)

`android/app/src/main/AndroidManifest.xml`:

- `<uses-permission android:name="android.permission.NFC" />`
- `<uses-feature android:name="android.hardware.nfc" android:required="false" />`
  (false so no-NFC devices can still install and use the rest of the app)
- Camera permission is added by the camera plugin.

**`.well-known/assetlinks.json` still says `SHA256_FINGERPRINT_PENDING`, and
Android App Links cannot verify until it does not.** Until then no Android device
claims `https://wildcatraffle.com/tap/...`, the link opens the browser, and
nothing anywhere errors. The fingerprint cannot be written before a signing key
exists, which is why it is a placeholder and not a value. Once `cap add android`
has run and the release key is chosen:

```
# debug key, for testing on a device
keytool -list -v -keystore ~/.android/debug.keystore \
  -alias androiddebugkey -storepass android -keypass android | grep SHA256

# the release key that Play actually signs with (App Signing -> App signing key certificate)
# Play Console > Release > Setup > App integrity
```

Paste the colon-separated SHA-256 into `sha256_cert_fingerprints` in
`.well-known/assetlinks.json`, merge to `main` (that publishes it), then verify
with `adb shell pm verify-app-links --re-verify org.westbrookacademy.wildcat` and
`adb shell pm get-app-links org.westbrookacademy.wildcat`. Both the debug and the
release fingerprint can be listed at once, and during testing you want both.

## Everyday build

```
npm run run:ios       # sync web + build + launch (simulator or device)
npm run run:android
```

`npm run sync-web` re-copies the portal after any change to the root web files.

## Plugins behind the tap flow

Three of them, all declared in `package.json` and installed by `npm install`;
`npx cap sync` is what registers them with the native projects. The JS that
drives all three lives in `script.js`, in the block starting at
`---- Native NFC bridge ----`, and every entry point is gated on
`window.WC_NATIVE` so the same file still runs unchanged in the browser portal.

### How a plugin reaches `window.Capacitor.Plugins`, and why this app calls no `registerPlugin`

Two reviewers have now independently concluded that this app is broken because
nothing calls `Capacitor.registerPlugin()`, and that `window.Capacitor.Plugins`
must therefore be `{}` on a real device. It is not, and the reason is worth
writing down once so nobody spends a third afternoon on it.

`registerPlugin()` lives in `@capacitor/core/dist/capacitor.js`. That file is a
**browser** bundle. It is never loaded inside the WKWebView or the Android
WebView. What the native runtime loads instead, at document start, before any
script the page itself declares:

- **iOS** - `@capacitor/ios` `Capacitor/Capacitor/JSExport.swift`.
  `exportCapacitorGlobalJS` injects `window.Capacitor = { ..., Plugins: {} }` as
  a `WKUserScript` at `.atDocumentStart`, and `exportJS(for:)` injects, for every
  registered plugin, `var p = (a.Plugins = a.Plugins || {}); var t = (p['NFC'] =
  {}); t.addListener = ...` plus one generated function per entry in that
  plugin's `pluginMethods`, plus a `Capacitor.PluginHeaders` entry. It is called
  from `CapacitorBridge.registerPluginInstance`.
- **Android** - `@capacitor/android` `JSExport.getPluginJS()` builds the same
  `p['<id>'] = {}` block, and `JSInjector` splices it into the `<head>` of every
  HTML response the WebView is served.

So `Capacitor.Plugins.NFC`, `.App` and `.Haptics` are populated natively, by the
bridge, before `native-bridge.js` or `script.js` run. `registerPlugin` is for the
web/ESM path: it is what an `import { NFC } from '@exxili/capacitor-nfc'` runs
through a bundler. This app has no bundler, so it talks to the native-generated
objects directly - which is also why `window.Capacitor.registerPlugin` is
**undefined** on device (`grep -c registerPlugin` over the iOS
`assets/native-bridge.js` returns 0). Adding the calls would not help and, unguarded,
would throw.

### Settled by running it, 2026-08-18

The argument above is no longer an argument. The app was built for the simulator,
a probe was injected into the built bundle, and this is what the running app
reported:

```
Capacitor: true
isNative: true
registerPlugin: undefined
PluginHeaders: 9
Plugins keys: CapacitorHttp, Console, WebView, ...
NFC: object          NFC.startScan: function
App: object          Haptics: object
WC_NATIVE: true
```

Both halves confirmed at once. `Capacitor.registerPlugin` really is **undefined**
on device, because `capacitor.js` is never loaded and `bundledWebRuntime` is not
set. And the plugin objects are **populated anyway**, by the native bridge, with
real callable methods. So no `registerPlugin` call is needed or possible, and any
review that reasons from a bundled-app mental model will reach the wrong answer
here. Two independent reviewers already did.

Note also `Console` in that key list: the bridge does register a Console plugin,
but webview `console.log` did not reach `xcrun simctl spawn booted log stream` in
this configuration, which is why the probe had to paint to the screen and be
screenshotted. Do not expect `console.log` to be your debugging channel on
device; use Safari's Web Inspector, or render it.

The one real cost of having no bundler is that the plugin's friendly `NFC`
wrapper in `src/index.ts` is unreachable, and that wrapper is where the URI
record framing lives. `script.js` builds those bytes itself in
`wcNativeUriPayload()`. See the write notes below.

(The camera and push plugins are unrelated to tapping and are left alone here.)

> `@capacitor-community/barcode-scanner` was **removed**, and it was the second
> reason `npm install` failed. It has no Capacitor 6 release at all: its newest
> published version peer-depends on `@capacitor/core@^5.0.0`, so npm refused the
> whole tree with ERESOLVE. Nothing in `script.js` ever referenced it. If a
> barcode reader is wanted later, `@capacitor-mlkit/barcode-scanning` is the
> maintained successor, but check its peer range against the Capacitor major
> this project is on before adding it.

### `@exxili/capacitor-nfc` (NDEF read + write, both platforms)

MIT, on the public npm registry, peer `@capacitor/core >=6.0.0 <9.0.0`.

It replaced `@capawesome-team/capacitor-nfc`, which is **paid sponsorware and
404s on the public registry**. That package was never installable here, so
`npm install` in `mobile/` could not have completed and none of the code written
against it had ever run. Do not put it back without a licence and an `.npmrc`.

Two things about it will waste an afternoon if you do not know them:

- **The plugin key is `NFC`, all capitals** (`window.Capacitor.Plugins.NFC`). The
  capawesome key was `Nfc`. A lowercase check returns false forever and the app
  quietly tells every student their phone cannot scan.
- **`startScan()` and `cancelScan()` are iOS only, and `startScan()` REJECTS on
  Android.** `NFCPlugin.kt` answers `call.reject("Android NFC scanning does not
  require 'startScan' method.")`. It is not a harmless no-op: called inside a
  `try`, it painted a refusal card and an error haptic on every Android scan the
  app attempted. Android is always in reading mode while the activity is
  foregrounded, so the `nfcTag` listener is the whole mechanism there and
  `startScan()` is gated to iOS. `cancelScan()` genuinely is a no-op on Android.
  `cancelWriteAndroid()` **rejects on iOS** with "Function not implemented for
  iOS", so it is only ever called on Android.
- **`writeNDEF()` wants `payload` as an array of BYTES, not a string.** The
  string form only works through the plugin's ESM wrapper, which frames the URI
  record for you and which a no-build app cannot reach. Handed a string, iOS
  fails the `payload as? [NSNumber]` cast, `continue`s past the record, writes an
  EMPTY NDEF message and resolves anyway - every sticker reported as programmed,
  none of them holding a URL. Android calls `getJSONArray("payload")` on the
  string and throws. `wcNativeUriPayload()` in `script.js` emits
  `[0x00, ...utf8]`: identifier code 0, no prefix compression, the URL stored
  literally.

**Neither platform's `writeNDEF()` promise reports the outcome.** On Android it
only *arms* the write and the tag is written on the next intent. On iOS,
`NFCPlugin.swift` calls `writer.startWriting(message:)` and then `call.resolve()`
on the very next line, so the promise resolves the moment Apple's sheet is
*raised*. Both platforms report the truth on the `nfcWriteSuccess` / `nfcError`
events, and `script.js` waits on those on both. Two traps behind the deadline it
also sets: an armed Android write left running silently overwrites the next tag
anybody holds to the phone, so it is always cancelled on the way out; and the
plugin swallows `readerSessionInvalidationErrorUserCanceled`, so an admin who
taps Cancel on Apple's sheet produces **no event at all** and a write with no
timeout would hang for the life of the page.

It has no custom iOS scan-sheet text, so students see the generic system prompt.

### `@capacitor/app` (universal links + resume)

Pin the 6.x line. Two listeners:

- **`appUrlOpen`** is how a **background NFC read reaches the app on iPhone**.
  The system reads the tag, shows a notification, and only when the student taps
  it does iOS hand the URL over as a universal link. There is no NFC session in
  that path at all. `getLaunchUrl()` covers the cold start, and the two are
  deduped on the URL because `getLaunchUrl` returns the last URL the app ever saw
  and is never cleared.
- **`resume`** re-syncs the pass card the instant the student comes back, because
  the poll skips itself while the webview is hidden.

That path needs the **Associated Domains** capability plus
`https://wildcatraffle.com/.well-known/apple-app-site-association`. Without both,
tapping the notification opens Safari instead of the app and nothing errors.

> The URL path carries **no proof of presence**. A student can forward the link.
> That is why `appUrlOpen` only ever opens the confirm screen and never taps: the
> mutation stays behind the press in `confirmTapCheckIn`. Do not "optimise" that
> away.

### `@capacitor/haptics` (the confirmation beat)

Pin the 6.x line. `Haptics.notification({ type: 'SUCCESS' })` on a confirmed
check-in, `'ERROR'` on a refusal.

**It throws on the web.** Its browser implementation calls `navigator.vibrate`,
which does not exist in Safari on any iPhone or Mac, so every call is gated on
native and wrapped in try/catch. `script.js` is shared with the browser portal;
an ungated call breaks the student portal in Safari.

Android needs no manifest change: the plugin declares `VIBRATE` itself.

### Testing

`npm test` at the **repo root** runs `nfc-tag-decode.test.mjs`, which drives the
tag-decoding functions straight out of the shipped `script.js` (prefix table,
non-URI records, malformed payloads, URLs with no slug). It needs no device and
no install.

Everything past the decode needs real hardware: **NFC does not work in the iOS
simulator**, and neither do haptics.

## Distribution (private)

- **TestFlight**: Archive in Xcode → upload to App Store Connect → add internal/
  external testers. ~1-day review, builds expire every 90 days.
- **Apple School Manager**: custom app, unlisted, pushed to managed devices.
- **Android**: Play Console internal testing, or a signed APK handed to the school.
