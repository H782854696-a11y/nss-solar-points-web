const CACHE_PREFIX = 'nss-control-shell-v';
const CACHE = `${CACHE_PREFIX}22`;
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/i18n.js', '/manifest.webmanifest', '/logo-brand.png', '/pwa-icon.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && SHELL.includes(url.pathname)) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
      }
      return response;
    } catch (error) {
      const appCache = await caches.open(CACHE);
      const cached = await appCache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await appCache.match('/');
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
