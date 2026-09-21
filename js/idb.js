/* IndexedDB 极简 Promise 封装：队列 / 实体快照 / 元信息全部持久化在这里 */
(function (global) {
  const DB_NAME = 'offline-forms-db';
  const DB_VERSION = 1;

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('ops')) {
          const ops = db.createObjectStore('ops', { keyPath: 'id' });
          ops.createIndex('entityId', 'entityId', { unique: false });
          ops.createIndex('status', 'status', { unique: false });
          ops.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('entities')) {
          db.createObjectStore('entities', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(storeName, mode) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(storeName, mode);
          const store = t.objectStore(storeName);
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error || new Error('transaction aborted'));
          resolve({ t, store });
        })
    );
  }

  async function put(storeName, value) {
    const { store } = await tx(storeName, 'readwrite');
    store.put(value);
  }

  async function putMany(storeName, values) {
    const { store } = await tx(storeName, 'readwrite');
    values.forEach((value) => store.put(value));
  }

  async function get(storeName, key) {
    const { store } = await tx(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function del(storeName, key) {
    const { store } = await tx(storeName, 'readwrite');
    store.delete(key);
  }

  async function getAll(storeName) {
    const { store } = await tx(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllByIndex(storeName, indexName, value) {
    const { store } = await tx(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.index(indexName).getAll(value);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function clearAll() {
    const db = await openDB();
    await Promise.all(
      ['ops', 'entities', 'meta'].map(
        (name) =>
          new Promise((resolve, reject) => {
            const t = db.transaction(name, 'readwrite');
            t.objectStore(name).clear();
            t.oncomplete = resolve;
            t.onerror = () => reject(t.error);
          })
      )
    );
  }

  global.IDB = { openDB, put, putMany, get, del, getAll, getAllByIndex, clearAll };
})(window);
