// ─────────────────────────────────────────────────────────────────────────────
//  sw.js — Service worker de CARRONA: precache explícito y versionado.
//
//  Los dos marcadores de abajo (versión y lista de precache) los reemplaza
//  tools/build.mjs al armar dist/. En el repo quedan tal cual y el SW no se
//  registra nunca (ver src/core/pwa.js): el código de desarrollo no se cachea.
//
//  install   baja todo el precache y activa sin esperar (skipWaiting)
//  activate  borra las cachés de otras versiones y toma las pestañas (clients.claim)
//  fetch     sólo GET del mismo origen; lo precacheado sale de la caché, el resto va
//            a la red con la caché de respaldo; una navegación sin red devuelve el
//            index.html cacheado. /__carrona y /__bye hablan con el servidor, no con
//            el SW.
// ─────────────────────────────────────────────────────────────────────────────

const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = 'carrona-' + VERSION;
const RUNTIME = 'carrona-rt-' + VERSION;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' saltea la caché HTTP del navegador: después de una actualización
    // no queremos que el precache nuevo se llene con archivos de la versión anterior
    await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('carrona-') && k !== CACHE && k !== RUNTIME)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/__')) return;   // /__carrona, /__bye: siempre al servidor
  e.respondWith(handle(req));
});

async function handle(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;                          // precacheado: cache-first
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const rt = await caches.open(RUNTIME);
      rt.put(req, res.clone()).catch(() => { /* sin lugar: no importa */ });
    }
    return res;
  } catch (err) {
    const rt = await caches.open(RUNTIME);
    const fallback = await rt.match(req, { ignoreSearch: true });
    if (fallback) return fallback;
    if (req.mode === 'navigate') {
      const index = await cache.match('./index.html');
      if (index) return index;
    }
    throw err;
  }
}
