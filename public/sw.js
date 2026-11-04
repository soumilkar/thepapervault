const CACHE_NAME = "papervault-core-v2";
const FONT_CACHE = "papervault-fonts-v2";

const STATIC_PRECACHE = [
  "/",
  "/manifest.webmanifest",
  "/manifest.json",
  "/icon.svg",
  "/pwa-192x192.png",
  "/pwa-512x512.png",
  "/pwa-maskable-512x512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(
        STATIC_PRECACHE.map((url) =>
          fetch(url, { credentials: "same-origin" }).then((res) => {
            if (res.ok) return cache.put(url, res);
          }),
        ),
      ),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME && k !== FONT_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never intercept AI companion stream or live API routes
  if (url.pathname.startsWith("/api/")) return;

  // Cache Google Fonts
  if (
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com"
  ) {
    event.respondWith(
      caches.open(FONT_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const res = await fetch(request);
          if (res.ok || res.type === "opaque") {
            cache.put(request, res.clone());
          }
          return res;
        } catch {
          return cached || new Response("", { status: 504 });
        }
      }),
    );
    return;
  }

  // Same origin requests
  if (url.origin !== self.location.origin) return;

  // HTML page navigations: NetworkFirst with cache fallback
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          const res = await fetch(request);
          if (res.ok) {
            cache.put(request, res.clone());
            cache.put("/", res.clone());
          }
          return res;
        } catch {
          const exact = await cache.match(request);
          if (exact) return exact;
          const fallback = (await cache.match("/app")) || (await cache.match("/"));
          if (fallback) return fallback;
          return new Response(
            "<!doctype html><html><head><meta charset='utf-8'><title>The PaperVault</title></head><body style='font-family:serif;background:#f6ede0;color:#4e2412;padding:2rem;text-align:center'><h1>The PaperVault</h1><p>Please connect to the internet to load newly added content.</p></body></html>",
            { headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }
      })(),
    );
    return;
  }

  // Static assets (CSS, JS, images)
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      const fetchPromise = fetch(request)
        .then((res) => {
          if (res.ok) {
            cache.put(request, res.clone());
          }
          return res;
        })
        .catch(() => null);

      if (cached) return cached;
      const networkRes = await fetchPromise;
      if (networkRes) return networkRes;
      return new Response("", { status: 504 });
    })(),
  );
});
