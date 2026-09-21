const DB_NAME = 'offline-forms-db';
const DB_VERSION = 1;

export const STORES = {
  state: 'serverState',
  queue: 'outbox',
  compensations: 'compensations',
  events: 'events'
};

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.state)) {
        db.createObjectStore(STORES.state, { keyPath: 'formId' });
      }
      if (!db.objectStoreNames.contains(STORES.queue)) {
        const queue = db.createObjectStore(STORES.queue, { keyPath: 'id' });
        queue.createIndex('formId', 'formId', { unique: false });
        queue.createIndex('status', 'status', { unique: false });
        queue.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.compensations)) {
        const compensations = db.createObjectStore(STORES.compensations, { keyPath: 'id' });
        compensations.createIndex('formId', 'formId', { unique: false });
        compensations.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.events)) {
        const events = db.createObjectStore(STORES.events, { keyPath: 'id' });
        events.createIndex('formId', 'formId', { unique: false });
        events.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let databasePromise;

export function db() {
  databasePromise ??= openDatabase();
  return databasePromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function tx(storeNames, mode, callback) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeNames, mode);
    const stores = Object.fromEntries(
      (Array.isArray(storeNames) ? storeNames : [storeNames]).map((name) => [name, transaction.objectStore(name)])
    );

    let result;
    Promise.resolve(callback(stores, transaction))
      .then((value) => {
        result = value;
      })
      .catch(reject);

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function getAll(storeName, indexName = null, range = null) {
  return tx(storeName, 'readonly', (stores) => {
    const source = indexName ? stores[storeName].index(indexName) : stores[storeName];
    return requestToPromise(source.getAll(range));
  });
}

export async function getOne(storeName, key) {
  return tx(storeName, 'readonly', (stores) => requestToPromise(stores[storeName].get(key)));
}

export async function putOne(storeName, value) {
  await tx(storeName, 'readwrite', (stores) => {
    stores[storeName].put(value);
  });
  return value;
}

export async function deleteOne(storeName, key) {
  await tx(storeName, 'readwrite', (stores) => {
    stores[storeName].delete(key);
  });
}

export function createId(prefix) {
  if (crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export async function clearStaleTerminalItems(now = Date.now()) {
  const oneDay = 24 * 60 * 60 * 1000;
  const stale = (await getAll(STORES.queue)).filter(
    (item) => ['succeeded', 'failed'].includes(item.status) && now - item.updatedAt > oneDay
  );

  await tx(STORES.queue, 'readwrite', (stores) => {
    for (const item of stale) stores[STORES.queue].delete(item.id);
  });

  return stale.length;
}
