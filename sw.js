/* ═══════════════════════════════════════════════════════
   Translucent - Service Worker
   Stale-while-revalidate for app shell; network-only for APIs.
   ═══════════════════════════════════════════════════════ */

// Bumped when PRECACHE changes: the activate handler deletes every cache whose
// name is not this one, which is what makes a new shell take effect.
const CACHE = "translucent-v3";
const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.json",
  // The crypto engine used to be inline in index.html. It has to be listed
  // here too, or an offline load gets the cached shell and then fails to
  // find Crypt.
  "./src/crypto.js",
  "./src/board.js",
];

/* ── Install: precache app shell ── */
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

/* ── Activate: remove old caches ── */
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/* ── Fetch ── */
self.addEventListener("fetch", (e) => {
  const { url, method } = e.request;

  // Always go network-only for third-party APIs and auth
  const isExternal =
    url.includes("googleapis.com") ||
    url.includes("accounts.google.com") ||
    url.includes("fonts.googleapis.com") ||
    url.includes("fonts.gstatic.com") ||
    url.includes("unpkg.com") ||
    method !== "GET";
  if (isExternal) return; // let browser handle

  // Stale-while-revalidate for local assets
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request);
      const networkFetch = fetch(e.request)
        .then((res) => {
          if (res && res.status === 200) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached); // offline: fall back to cache

      return cached || networkFetch;
    }),
  );
});

/* ── Background Sync placeholder ── */
self.addEventListener("sync", (e) => {
  // Future: queue failed Drive writes and retry here
  console.log("[SW] sync:", e.tag);
});
