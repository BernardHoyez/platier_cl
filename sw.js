/* PLATIER_CL — Service Worker v2.0.0
   Stratégie : NETWORK FIRST sur tout — aucun cache applicatif.
   Le cache navigateur standard gère les assets statiques.
   Cela évite tout conflit de version pendant le développement. */

const CACHE = 'platier-v2.0.0';
const PRECACHE = ['./','./index.html','./app.js','./manifest.json','./icon192.png','./icon512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// NETWORK FIRST : on tente le réseau, fallback cache uniquement si offline
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API externes : réseau pur, pas de cache
  if(['data.geopf.fr','cdnjs.cloudflare.com','services.data.shom.fr']
      .some(h => url.hostname.includes(h))) {
    e.respondWith(fetch(e.request));
    return;
  }
  // Assets locaux : network-first
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if(r && r.status===200) {
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});

self.addEventListener('message', e => {
  if(e.data?.action==='skipWaiting') self.skipWaiting();
});
