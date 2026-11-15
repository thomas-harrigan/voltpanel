const CACHE = "voltpanel-12";
const FILES = ["/", "/index.html", "/css/app.css?v=10", "/js/app.js?v=9", "/js/gauges.js?v=6", "/js/protocol.js?v=9", "/manifest.webmanifest", "/icon.svg", "/brand/volt.png?v=7", "/fonts/Staatliches-Regular.woff2?v=8"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const updating = fetch(event.request).then((response) => {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
    }
    return response;
  }).catch(() => null);
  event.waitUntil(updating);
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const fresh = await updating;
      if (fresh) return fresh;
      return (await cache.match("/index.html")) || Response.error();
    })
  );
});
