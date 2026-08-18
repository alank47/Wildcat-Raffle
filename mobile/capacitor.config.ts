import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native shell config for the Wildcat student app.
 *
 * webDir is `www`, populated by scripts/sync-web.mjs from the student-facing
 * files at the repo root, so the app ships the SAME portal the browser serves.
 * appId is the school's reverse-DNS id; keep it stable once it is in App Store
 * Connect / Play Console, because changing it creates a new app.
 */
const config: CapacitorConfig = {
  appId: 'org.westbrookacademy.wildcat',
  appName: 'Wildcat Hub',
  webDir: 'www',
  ios: {
    // A student holds this at a doorway; let the webview own the safe area so the
    // pass card and the tap button are never under the notch or the home bar.
    contentInset: 'always',
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
