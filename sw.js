/*
 * Wildcat Hub service worker.
 *
 * Phase 1 — it exists so the app is installable ("Add to Home Screen"). It does
 * NOT cache app code: this app is highly dynamic (Convex + Firestore) and a
 * stale index.html/script.js is exactly the bug that has cost hours before.
 * Freshness stays owned by the ?v= cache stamps and the normal browser cache;
 * the fetch handler is a pure passthrough that only exists to meet the
 * installability bar.
 *
 * Phase 2 — push + notificationclick, so a hall-pass request reaches a teacher's
 * device even when the app is closed. The handlers are harmless until a client
 * actually subscribes, so they ship now and the subscription side is wired up
 * separately.
 */

const SW_VERSION = "wildcat-hub-sw-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Pure passthrough — never serves cached app code.
self.addEventListener("fetch", () => {
  /* let the browser handle it */
});

// ---- Push -----------------------------------------------------------------
// A pass request arrives as a push message carrying a small JSON body. Show it
// as a device notification. Defensive: a bodyless or malformed push still shows
// something rather than throwing and dropping the alert.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || "Wildcat Hub";
  const options = {
    body: data.body || "A student is requesting a hall pass.",
    icon: data.icon || "/assets/icon-192.png?v=1",
    badge: "/assets/icon-192.png?v=1",
    tag: data.tag || "hall-pass",
    renotify: true,
    requireInteraction: true, // stay up until the teacher acts on it
    data: { url: data.url || "/?source=push" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification focuses an open Wildcat Hub window, or opens one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target =
    (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of all) {
        if ("focus" in client) {
          try {
            await client.focus();
            return;
          } catch (e) {
            /* try the next one */
          }
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});
