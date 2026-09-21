/* 端到端冒烟（无浏览器）：内存版 IndexedDB + BroadcastChannel + fetch 桩，
 * 加载全部前端脚本，验证 离线提交 -> 刷新持久化 -> 在线重放 -> 冲突 -> 回滚 全链路。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ✓ ${message}`);
}

const ROOT = path.join(__dirname, '..');
function load(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* ---------- 内存 IndexedDB ---------- */
function createMemIDB() {
  const tables = { ops: new Map(), entities: new Map(), meta: new Map() };
  function makeStore(name) {
    return {
      put(value) {
        const key = name === 'ops' ? value.id : name === 'entities' ? value.id : value.key;
        tables[name].set(key, structuredClone(value));
      },
      get(key) {
        const req = {};
        queueMicrotask(() => {
          req.result = tables[name].has(key) ? structuredClone(tables[name].get(key)) : undefined;
          req.onsuccess && req.onsuccess();
        });
        return req;
      },
      getAll() {
        const req = {};
        queueMicrotask(() => {
          req.result = [...tables[name].values()].map((v) => structuredClone(v));
          req.onsuccess && req.onsuccess();
        });
        return req;
      },
      delete(key) {
        tables[name].delete(key);
      },
      clear() {
        tables[name].clear();
      },
      index(indexName) {
        return {
          getAll(value) {
            const req = {};
            queueMicrotask(() => {
              req.result = [...tables[name].values()]
                .filter((row) => row[indexName] === value)
                .map((v) => structuredClone(v));
              req.onsuccess && req.onsuccess();
            });
            return req;
          },
        };
      },
    };
  }
  return {
    tables,
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = {
          transaction(name) {
            const t = { onerror: null, onabort: null, oncomplete: null, error: null, objectStore: () => makeStore(name) };
            queueMicrotask(() => t.oncomplete && t.oncomplete());
            return t;
          },
        };
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
  };
}

/* ---------- 简易 BroadcastChannel ---------- */
const channels = [];
class FakeBroadcastChannel {
  constructor(name) {
    this.name = name;
    this.onmessage = null;
    channels.push(this);
  }
  postMessage(msg) {
    queueMicrotask(() => {
      channels
        .filter((c) => c !== this && c.name === this.name)
        .forEach((c) => c.onmessage && c.onmessage({ data: structuredClone(msg) }));
    });
  }
}

/* ---------- 服务器桩（直接内嵌与 server.js 相同的乐观锁语义） ---------- */
function createServerState() {
  const seed = {
    profile: { id: 'profile', version: 1, data: { displayName: '张三', email: 'a@b.c', bio: '' } },
    settings: { id: 'settings', version: 3, data: { theme: 'light', locale: 'zh-CN', notifications: true, pageSize: 20 } },
    timesheet: { id: 'timesheet', version: 2, data: { date: '2026-09-22', hours: 8, project: 'P', note: '' } },
  };
  const server = { entities: structuredClone(seed) };
  return {
    server,
    async handler(url, options = {}) {
      const body = options.body ? JSON.parse(options.body) : null;
      const matchGet = url.match(/^\/api\/entities\/(\w+)$/);
      if (matchGet && !options.method) {
        return { ok: true, status: 200, json: () => Promise.resolve(structuredClone(server.entities[matchGet[1]])) };
      }
      const matchPatch = url.match(/^\/api\/entities\/(\w+)$/);
      if (matchPatch && options.method === 'PATCH') {
        const entity = server.entities[matchPatch[1]];
        if (body.baseVersion !== entity.version) {
          const local = { ...body.baseData, ...body.patch };
          const serverChanged = Object.keys(entity.data).filter(
            (k) => JSON.stringify(body.baseData[k]) !== JSON.stringify(entity.data[k])
          );
          const localChanged = Object.keys(entity.data).filter(
            (k) => JSON.stringify(body.baseData[k]) !== JSON.stringify(local[k])
          );
          const overlap = serverChanged.filter((k) => localChanged.includes(k));
          if (overlap.length === 0) {
            entity.data = { ...entity.data, ...body.patch };
            entity.version += 1;
            return { ok: true, status: 200, json: () => Promise.resolve(structuredClone(entity)) };
          }
          return {
            ok: false,
            status: 409,
            json: () => Promise.resolve({ message: 'conflict', server: structuredClone(entity), conflictFields: overlap }),
          };
        }
        entity.data = { ...entity.data, ...body.patch };
        entity.version += 1;
        return { ok: true, status: 200, json: () => Promise.resolve(structuredClone(entity)) };
      }
      throw new Error(`unexpected fetch ${options.method || 'GET'} ${url}`);
    },
  };
}

/* ---------- 构建沙箱并加载脚本 ---------- */
function buildSandbox(memIDB, serverHandler, online, persistentLocalStorage) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    queueMicrotask,
    Promise,
    JSON,
    Object,
    Array,
    Number,
    String,
    Math,
    structuredClone,
    Date,
    Map,
    Set,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.windowListeners = {};
  sandbox.addEventListener = (event, cb) => {
    (sandbox.windowListeners[event] = sandbox.windowListeners[event] || []).push(cb);
  };
  sandbox.dispatchWindow = (event) => {
    (sandbox.windowListeners[event] || []).forEach((cb) => cb());
  };
  sandbox.navigator = { onLine: online, serviceWorker: undefined };
  sandbox.localStorage = persistentLocalStorage;
  sandbox.indexedDB = { open: () => memIDB.open() };
  sandbox.BroadcastChannel = FakeBroadcastChannel;
  sandbox.crypto = { randomUUID: () => `id-${Math.random().toString(36).slice(2)}-${Date.now()}` };
  sandbox.AbortController = class {
    constructor() {
      this.signal = {};
    }
    abort() {}
  };
  sandbox.fetch = (url, options) => serverHandler(String(url).replace('http://localhost', ''), options);
  vm.createContext(sandbox);
  ['js/idb.js', 'js/bus.js', 'js/store.js', 'js/engine.js'].forEach((rel) => {
    vm.runInContext(load(rel), sandbox, { filename: rel });
  });
  return sandbox;
}

const flush = (times = 1) => Array.from({ length: times }).reduce((p) => p.then(() => new Promise((r) => setTimeout(r, 50))), Promise.resolve());

const persistentLocalStorage = { _data: {}, getItem(k) { return this._data[k] ?? null; }, setItem(k, v) { this._data[k] = String(v); } };

async function main() {
  const memIDB = createMemIDB();
  const { handler } = createServerState();
  console.log('阶段 A：离线提交并持久化');
  let ctx = buildSandbox(memIDB, handler, true, persistentLocalStorage);
  await ctx.Engine.start(); // 首次在线冷启动：拉取实体快照，建立离线可用缓存
  await flush();
  ctx.Bus.emit('SIM_OFFLINE', { offline: true }); // 模拟断网（缓存已就绪）
  await ctx.Engine.submit({
    entityId: 'settings',
    formId: '偏好设置',
    kind: 'patch',
    patch: { pageSize: 50 },
    userId: 'user-a',
    userName: '张三',
  });
  await flush();
  check(memIDB.tables.ops.size === 1, 'IndexedDB 中有 1 条排队操作');
  const stored = [...memIDB.tables.ops.values()][0];
  check(stored.status === 'queued' && stored.patch.pageSize === 50, '操作以 queued 状态持久化');

  console.log('阶段 B：“刷新页面”——重建沙箱（内存状态全丢，仅 IDB 保留）');
  channels.length = 0;
  memIDB.tables.meta.clear(); // 旧标签页已死，等待租约到期（等效于超过 LEASE_MS）
  persistentLocalStorage.setItem('simOffline', '1');
  ctx = buildSandbox(memIDB, handler, false, persistentLocalStorage);
  await ctx.Engine.start(); // start 时读取 simOffline 持久化状态
  await flush();
  const viewAfterRefresh = await ctx.Engine.getView('settings');
  check(viewAfterRefresh.pendingCount === 1, '刷新后队列不丢，仍有 1 条待同步');
  check(viewAfterRefresh.data.pageSize === 50, '刷新后乐观视图仍显示本地修改');

  console.log('阶段 C：恢复在线，自动重放成功');
  persistentLocalStorage.setItem('simOffline', '0');
  ctx.navigator.onLine = true;
  ctx.dispatchWindow('online');
  persistentLocalStorage.setItem('simOffline', '0');
  ctx.Bus.emit('SIM_OFFLINE', { offline: false });
  await flush(5);
  const viewSynced = await ctx.Engine.getView('settings');
  check(viewSynced.pendingCount === 0, '队列清空');
  check(viewSynced.serverVersion === 4, '服务器版本前进到 v4');
  check(viewSynced.data.pageSize === 50, '服务器数据包含本地修改');
  check([...memIDB.tables.ops.values()].every((op) => op.status === 'done'), '操作标记为 done');

  console.log('阶段 D：再次离线提交，期间他人改了同字段 -> 冲突 -> 回滚一致');
  persistentLocalStorage.setItem('simOffline', '1');
  ctx.Bus.emit('SIM_OFFLINE', { offline: true });
  await ctx.Engine.submit({
    entityId: 'settings',
    formId: '偏好设置',
    kind: 'patch',
    patch: { theme: 'dark' },
    userId: 'user-a',
    userName: '张三',
  });
  // submit 内部自己取基线；为制造冲突，先让“他人”直接把服务器 theme 改掉
  await handler('/api/entities/settings', {
    method: 'PATCH',
    body: JSON.stringify({ userId: 'other', baseVersion: 4, mergeStrategy: 'merge', baseData: { ...viewSynced.data }, patch: { theme: 'system' } }),
  });
  await flush();
  ctx.Bus.emit('SIM_OFFLINE', { offline: false });
  await flush(5);
  let viewConflict = await ctx.Engine.getView('settings');
  check(viewConflict.conflictCount === 1, '产生 1 条冲突操作');
  check(viewConflict.data.theme === 'system', '视图回退为服务器真相（theme=system），脏数据未生效');
  const conflictOp = viewConflict.conflict[0];
  check(conflictOp.status === 'conflict', '操作状态为 conflict，队列被阻断');

  await ctx.Engine.resolveConflict(conflictOp.id, 'rollback');
  await flush();
  const viewRolledBack = await ctx.Engine.getView('settings');
  check(viewRolledBack.conflictCount === 0 && viewRolledBack.pendingCount === 0, '回滚后无待处理操作');
  check(viewRolledBack.data.theme === 'system' && viewRolledBack.data.pageSize === 50, '回滚后数据与服务器完全一致');
  check(memIDB.tables.ops.size === 1, '冲突操作已从持久化队列删除（仅剩此前 done 记录）');

  console.log('阶段 E：多表单互不干扰 —— settings 冲突时 timesheet 照常同步');
  persistentLocalStorage.setItem('simOffline', '1');
  ctx.Bus.emit('SIM_OFFLINE', { offline: true });
  await ctx.Engine.submit({
    entityId: 'settings', formId: '偏好设置', kind: 'patch', patch: { locale: 'en-US' },
    userId: 'user-b', userName: '李四',
  });
  await ctx.Engine.submit({
    entityId: 'timesheet', formId: '工时填报', kind: 'patch', patch: { hours: 4 },
    userId: 'user-b', userName: '李四',
  });
  await flush(2);
  // 他人抢先把 settings.theme 改成 system（与李四冲突）
  const sEntity = await (await Promise.resolve(handler('/api/entities/settings'))).json();
  await handler('/api/entities/settings', {
    method: 'PATCH',
    body: JSON.stringify({ userId: 'other', baseVersion: sEntity.version, mergeStrategy: 'merge', baseData: sEntity.data, patch: { locale: 'ja-JP' } }),
  });
  ctx.navigator.onLine = true;
  ctx.dispatchWindow('online');
  persistentLocalStorage.setItem('simOffline', '0');
  ctx.Bus.emit('SIM_OFFLINE', { offline: false });
  await flush(5);
  const settingsView = await ctx.Engine.getView('settings');
  const timesheetView = await ctx.Engine.getView('timesheet');
  check(settingsView.conflictCount === 1, 'settings 停在冲突，等待人工处理');
  check(timesheetView.pendingCount === 0 && timesheetView.conflictCount === 0, 'timesheet 未被阻塞，已同步');
  check(timesheetView.data.hours === 4, 'timesheet 的修改已落库');
  await ctx.Engine.resolveConflict(settingsView.conflict[0].id, 'rollback');
  await flush(2);


  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
