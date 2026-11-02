/* SenkuAPI — service worker (Run 27, installability + offline shell).
 *
 * Install criteria: Chrome (desktop + Android) requires an active
 * worker with a fetch handler before it will offer "Install App".
 *
 * Strategy — deliberately boring and honest:
 *   • install:  pre-cache the PWA identity files (manifest + every
 *     icon variant). The app shell ("/") is cached opportunistically
 *     by the network-first pass below, never fabricated.
 *   • activate: purge every cache this version doesn't own, then
 *     claim all clients so an updated worker takes effect instantly.
 *   • fetch:    NETWORK-FIRST for same-origin GETs, with the cache as
 *     the offline fallback. Fresh successful responses that are
 *     actually cacheable (basic, ok, no no-store) refresh the cache.
 *
 * NEVER INTERCEPTED:
 *   • /api/*            — the gateway's own routes, including the SSE
 *     streaming endpoint (/api/chat/send). Buffering a token stream
 *     would stall live output; REST calls must always hit the server.
 *   • non-GET requests  — mutations are never served from a cache.
 *   • cross-origin      — not ours, not our business.
 *   • /_next/webpack-hmr — dev hot-reload passthrough.
 */

const CACHE = "senku-pwa-v1";

const PRECACHE = [
  "/manifest.json",
  "/senku-sparkle.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.method !== "GET") return; // mutations always hit the network
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // third parties pass through
  if (url.pathname.startsWith("/api/")) return; // SSE + REST: never buffered
  if (url.pathname.startsWith("/_next/webpack-hmr")) return; // dev HMR

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(req);
        const cc = fresh.headers.get("cache-control") ?? "";
        if (fresh.ok && fresh.type === "basic" && !cc.includes("no-store")) {
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        // network failed — fall back to whatever we cached before
        const cached = await caches.match(req, { ignoreSearch: true });
        if (cached) return cached;
        if (req.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        throw err; // genuinely offline and uncached — let the browser say so
      }
    })()
  );
});
