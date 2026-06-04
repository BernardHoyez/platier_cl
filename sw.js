/* ═══════════════════════════════════════════════════════════════
   PLATIER_CL — Service Worker « brise-caches »
   Incrémentez CACHE_VERSION à chaque déploiement pour forcer
   la mise à jour de tous les clients.
   ═══════════════════════════════════════════════════════════════ */

const CACHE_VERSION = 'platier-v1.0.0';

// Ressources à mettre en cache lors de l'installation
const PRECACHE = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon192.png',
  './icon512.png',
];

// ─── INSTALL ──────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log(`[SW] Install — cache ${CACHE_VERSION}`);
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      return cache.addAll(PRECACHE);
    }).then(() => {
      // Force l'activation immédiate sans attendre la fermeture des onglets
      return self.skipWaiting();
    })
  );
});

// ─── ACTIVATE — brise-caches ──────────────────────────────────────
self.addEventListener('activate', event => {
  console.log(`[SW] Activate — purge des anciens caches`);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION)
          .map(k => {
            console.log(`[SW] Suppression cache obsolète : ${k}`);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ─── FETCH — stratégie Cache-First avec fallback réseau ───────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Les requêtes vers les API IGN/SHOM ne sont PAS mises en cache
  // (données volumineuses, dynamiques)
  const BYPASS_ORIGINS = [
    'data.geopf.fr',
    'services.data.shom.fr',
    'cdnjs.cloudflare.com',
  ];
  if (BYPASS_ORIGINS.some(o => url.hostname.includes(o))) {
    // Toujours réseau pour les API externes
    event.respondWith(fetch(request).catch(() =>
      new Response('Réseau indisponible', { status: 503 })
    ));
    return;
  }

  // Pour les ressources locales : Cache-First
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        // Ne mettre en cache que les réponses valides
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(request, clone));
        return response;
      }).catch(() =>
        // Fallback sur index.html pour la navigation offline
        caches.match('./index.html')
      );
    })
  );
});

// ─── MESSAGE — forcer la mise à jour depuis l'UI ──────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
});
