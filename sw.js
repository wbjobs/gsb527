/* Service Worker：App Shell 缓存 + 可注入的离线网络故障 */
const CACHE_VERSION = 'offline-forms-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/idb.js',
  '/js/bus.js',
  '/js/store.js',
  '/js/engine.js',
  '/js/ui.js',
  '/js/app.js',
];

// 页面通过 postMessage 同步离线开关；SW 重启后页面加载时会重新同步。
let offlineMode = false;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'OFFLINE_MODE') {
    offlineMode = Boolean(msg.offline);
    event.source && event.source.postMessage({ type: 'OFFLINE_MODE_ACK', offline: offlineMode });
  }
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function networkFirstOrError(request) {
  if (offlineMode) {
    // 模拟真实断网：API 一律失败（503 语义上代表服务不可达，页面按网络错误处理）
    return jsonResponse(503, { error: 'network_unavailable', simulated: true });
  }
  try {
    return await fetch(request);
  } catch (err) {
    return jsonResponse(503, { error: 'network_unavailable', reason: String(err) });
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url, self.location.href);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstOrError(event.request));
    return;
  }

  // 静态资源：缓存优先，回退网络并回填缓存
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(
      (cached) =>
        cached ||
        fetch(event.request)
          .then((resp) => {
            if (resp.ok && event.request.method === 'GET') {
              const copy = resp.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
            }
            return resp;
          })
          .catch(() => caches.match('/index.html'))
    )
  );
});
