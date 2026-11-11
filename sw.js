const CACHE_NAME = 'delta-journal-v3.3.2';

self.addEventListener('install', (e) => {
  console.log('[Service Worker] Installed v3.3.2');
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  console.log('[Service Worker] Activated v3.3.2');
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Pass-through fetch for PWA compliance
});
