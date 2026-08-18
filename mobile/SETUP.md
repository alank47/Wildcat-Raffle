# Wildcat student app (iOS + Android) — setup

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
this is regenerated per machine (and is heavy — prefer a real terminal over an
editor task):

```
cd mobile
npm install
npm run sync-web            # copy the student portal into www/
npx cap add ios
npx cap add android
npx cap sync
```

## iOS native config (once, after `cap add ios`)

In Xcode (`npm run open:ios`):

1. Signing & Capabilities → add **Near Field Communication Tag Reading**.
2. `Info.plist` → add `NFCReaderUsageDescription` ("Wildcat uses NFC to check you
   in at hall-pass tags."), `NSCameraUsageDescription`, and for writing tags the
   `com.apple.developer.nfc.readersession.formats` entitlement includes `NDEF`.
3. Set the Team to your Apple Developer account for device builds.

## Android native config (once, after `cap add android`)

`android/app/src/main/AndroidManifest.xml`:

- `<uses-permission android:name="android.permission.NFC" />`
- `<uses-feature android:name="android.hardware.nfc" android:required="false" />`
  (false so no-NFC devices can still install and use the rest of the app)
- Camera permission is added by the camera plugin.

## Everyday build

```
npm run run:ios       # sync web + build + launch (simulator or device)
npm run run:android
```

`npm run sync-web` re-copies the portal after any change to the root web files.

## NFC plugin

`@capawesome-team/capacitor-nfc` — reads and writes NDEF on both platforms. The
JS bridge lives in `script.js` (`wcNativeNfcTap` / `wcNativeNfcWrite`, guarded by
`window.WC_NATIVE`). The exact plugin call shapes are marked TODO-VERIFY there
and must be confirmed on a real device, since NFC cannot run in a simulator.

## Distribution (private)

- **TestFlight**: Archive in Xcode → upload to App Store Connect → add internal/
  external testers. ~1-day review, builds expire every 90 days.
- **Apple School Manager**: custom app, unlisted, pushed to managed devices.
- **Android**: Play Console internal testing, or a signed APK handed to the school.
