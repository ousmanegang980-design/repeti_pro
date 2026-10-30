/* RépétiPro — Service Worker : mise en cache de l'application pour un vrai mode hors ligne. */
const CACHE = "repetipro-v8";
const FICHIERS = ["./", "./index.html", "./styles.css", "./logic.js", "./app.js", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./maskable-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FICHIERS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
    const copie = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copie)).catch(() => {});
    return res;
  }).catch(() => caches.match("./index.html"))));
});
