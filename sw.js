const CACHE_NAME = 'offline-forms-v1';
const SERVER_DB_NAME = 'offline-forms-server';
const SERVER_DB_VERSION = 1;
const SERVER_STORE = 'server';
const IDEMPOTENCY_STORE = 'idempotency';

const INITIAL_FORM_DATA = {
  announcement: { title: '版本发布计划', content: '请在此填写发布说明' },
  inventory: { product: '机械键盘', quantity: 12, available: true },
  handoff: { owner: '王芳', shift: '早班', note: '例行巡检' }
};

const INITIAL_FORMS = Object.fromEntries(
  Object.entries(INITIAL_FORM_DATA).map(([formId, data]) => [
    formId,
    { formId, version: 1, data, updatedBy: 'system', updatedAt: Date.now() }
  ])
);

const APP_SHELL = ['/', '/index.html', '/src/app.js', '/src/forms.js', '/src/db.js', '/src/api.js', '/src/sync.js', '/src/merge.js', '/styles.css'];

function openServerDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SERVER_DB_NAME, SERVER_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SERVER_STORE)) db.createObjectStore(SERVER_STORE, { keyPath: 'formId' });
      if (!db.objectStoreNames.contains(IDEMPOTENCY_STORE)) db.createObjectStore(IDEMPOTENCY_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getServerState(db, formId) {
  const transaction = db.transaction(SERVER_STORE, 'readonly');
  let state = await idbRequest(transaction.objectStore(SERVER_STORE).get(formId));
  if (!state) {
    state = structuredClone(INITIAL_FORMS[formId]);
    if (!state) return null;
    const writeTransaction = db.transaction(SERVER_STORE, 'readwrite');
    writeTransaction.objectStore(SERVER_STORE).put(state);
  }
  return structuredClone(state);
}

async function getAllServerStates(db) {
  const transaction = db.transaction(SERVER_STORE, 'readwrite');
  const store = transaction.objectStore(SERVER_STORE);
  const count = await idbRequest(store.count());
  if (count === 0) {
    for (const state of Object.values(INITIAL_FORMS)) store.put(structuredClone(state));
  }
  const all = await idbRequest(store.getAll());
  return all.sort((left, right) => left.formId.localeCompare(right.formId));
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function errorResponse(status, code, message, extra = {}) {
  return jsonResponse(status, { error: { code, message, ...extra } });
}

async function handlePatchForm(event, request, formId, db) {
  if (!INITIAL_FORMS[formId]) return errorResponse(404, 'FORM_NOT_FOUND', `表单 ${formId} 不存在`);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, 'INVALID_JSON', '请求体不是有效 JSON');
  }

  const failure = request.headers.get('X-Demo-Failure');
  if (failure === 'bad-request') return errorResponse(400, 'VALIDATION_FAILED', '服务端拒绝了该数据：演示的永久性业务异常');
  if (failure === 'server-error') return errorResponse(500, 'HTTP_500', '模拟服务端临时异常，可安全重试');

  const { expectedVersion, changes, idempotencyKey, actor = '匿名用户' } = payload;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return errorResponse(400, 'INVALID_VERSION', 'expectedVersion 必须是非负整数');
  }
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return errorResponse(400, 'INVALID_CHANGES', 'changes 必须是对象');
  }
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    return errorResponse(400, 'MISSING_IDEMPOTENCY_KEY', '缺少 idempotencyKey');
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([SERVER_STORE, IDEMPOTENCY_STORE], 'readwrite');
    const serverStore = transaction.objectStore(SERVER_STORE);
    const idempotencyStore = transaction.objectStore(IDEMPOTENCY_STORE);
    const key = `${formId}:${idempotencyKey}`;
    const serverRequest = serverStore.get(formId);
    const idempotentRequest = idempotencyStore.get(key);
    let nextState = null;
    let serverResult;
    let idempotencyResult;
    let pending = 2;

    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    transaction.oncomplete = () => {
      if (nextState) resolve(jsonResponse(200, { data: nextState }));
    };

    idempotentRequest.onsuccess = () => {
      if (--pending) return;
      const previous = idempotencyResult;
      if (previous) {
        resolve(jsonResponse(200, { data: previous.response }));
        return;
      }

      const current = serverResult ?? structuredClone(INITIAL_FORMS[formId]);
      if (current.version !== expectedVersion) {
        resolve(
          errorResponse(409, 'VERSION_CONFLICT', `版本冲突：本地 ${expectedVersion}，服务端 ${current.version}`, {
            data: current,
            conflict: { expected: expectedVersion, actual: current.version }
          })
        );
        return;
      }

      const next = {
        ...current,
        version: current.version + 1,
        data: { ...current.data, ...changes },
        updatedBy: actor,
        updatedAt: Date.now()
      };
      serverStore.put(next);
      idempotencyStore.put({ key, response: next, createdAt: Date.now() });
      nextState = next;
    };
    serverRequest.onsuccess = () => {
      serverResult = serverRequest.result;
      idempotencyResult = idempotentRequest.result;
      if (--pending === 0) idempotentRequest.onsuccess();
    };
  });
}

async function handleRemoteEdit(event, request, formId, db) {
  if (!INITIAL_FORMS[formId]) return errorResponse(404, 'FORM_NOT_FOUND', `表单 ${formId} 不存在`);
  const payload = await request.json().catch(() => ({}));
  const current = await getServerState(db, formId);
  const next = {
    ...current,
    version: current.version + 1,
    data: { ...current.data, ...(payload.changes ?? {}) },
    updatedBy: payload.actor ?? '其他用户',
    updatedAt: Date.now()
  };

  const transaction = db.transaction(SERVER_STORE, 'readwrite');
  transaction.objectStore(SERVER_STORE).put(next);
  return jsonResponse(200, { data: next });
}

async function handleApiRequest(event, request, db) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);

  if (request.method === 'GET' && url.pathname === '/api/forms') {
    if (!navigator.onLine || request.headers.get('X-Simulate-Offline') === 'true') {
      return errorResponse(503, 'OFFLINE', '当前处于离线模式');
    }
    return jsonResponse(200, { data: await getAllServerStates(db) });
  }

  if (request.method === 'PATCH' && parts.length === 3 && parts[0] === 'api' && parts[1] === 'forms') {
    if (!navigator.onLine || request.headers.get('X-Simulate-Offline') === 'true') {
      return errorResponse(503, 'OFFLINE', '当前处于离线模式，请求应由客户端写入离线队列');
    }
    return handlePatchForm(event, request, decodeURIComponent(parts[2]), db);
  }

  if (request.method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'forms' && parts[3] === 'remote-edit') {
    return handleRemoteEdit(event, request, decodeURIComponent(parts[2]), db);
  }

  return errorResponse(404, 'API_NOT_FOUND', `未知接口：${url.pathname}`);
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(openServerDb().then((db) => handleApiRequest(event, request, db)));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok && request.method === 'GET') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match('/index.html'));
    })
  );
});
