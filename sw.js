const CACHE = "voltpanel-22";
const FILES = ["/", "/index.html", "/css/app.css?v=14", "/js/app.js?v=17", "/js/gauges.js?v=7", "/js/protocol.js?v=16", "/manifest.webmanifest", "/icon.svg", "/brand/volt.png?v=7", "/fonts/Staatliches-Regular.woff2?v=8"];

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

function fromNetwork(request) {
  return fetch(request).then((response) => {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  });
}

function fromCache(request) {
  return caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(request);
    if (hit) return hit;
    if (request.mode === "navigate") return (await cache.match("/index.html")) || Response.error();
    return Response.error();
  });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const navigation = event.request.mode === "navigate" || event.request.destination === "document";
  const script = event.request.destination === "script" || url.pathname.endsWith(".js");
  if (navigation || script) {
    event.respondWith(fromNetwork(event.request).catch(() => fromCache(event.request)));
    return;
  }
  const updating = fromNetwork(event.request).catch(() => null);
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
