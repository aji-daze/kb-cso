// 最小のService Worker（PWAインストール用・ネットワーク優先）
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
