const CACHE_NAME = "papervault-core-v3";
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
          keys.filter((k) => k !== CACHE_NAME && k !== FONT_CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never intercept API routes, Vite module requests, or query-string requests
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/src/") ||
    url.pathname.startsWith("/node_modules/") ||
    url.pathname.startsWith("/@") ||
    url.pathname.startsWith("/__vite") ||
    url.search.length > 0
  ) {
    return;
  }

  // Cache Google Fonts
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
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

  // HTML page navigations: NetworkFirst with app-shell fallback
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          const res = await fetch(request);
          if (res.ok && (url.pathname === "/" || url.pathname === "/app")) {
            cache.put(url.pathname, res.clone());
          }
          return res;
        } catch {
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

  // Only cache static production build assets, icons, and manifests
  const isStaticAsset =
    url.pathname.startsWith("/assets/") ||
    STATIC_PRECACHE.includes(url.pathname) ||
    /\.(?:png|svg|ico|webp|woff2?)$/i.test(url.pathname);

  if (!isStaticAsset) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const res = await fetch(request);
        if (res.ok) {
          cache.put(request, res.clone());
        }
        return res;
      } catch {
        return new Response("", { status: 504 });
      }
    })(),
  );
});
