/* 同步引擎：在线探测、Leader 选举、队列重放、冲突处理、回滚补偿 */
(function (global) {
  const ENTITY_IDS = ['profile', 'settings', 'timesheet'];
  const LEASE_MS = 5000;
  const HEARTBEAT_MS = 1500;
  const TICK_MS = 2500;
  const FETCH_TIMEOUT_MS = 10000;

  const tabId = crypto.randomUUID ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random()}`;
  const state = {
    online: navigator.onLine,
    simOffline: false,
    isLeader: false,
    entities: new Map(), // 最近一次服务器快照
    sending: new Set(),   // 正在发送的 entityId（内存锁，防同链并发）
    started: false,
  };

  const listeners = new Set();
  function onChange(reason) {
    listeners.forEach((fn) => fn(reason));
  }
  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function toast(type, title, detail, actions) {
    Bus.emit('TOAST', { type, title, detail, actions, at: Date.now() });
  }

  function effectiveOnline() {
    return state.online && !state.simOffline;
  }

  async function apiFetch(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(path, {
        ...options,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      });
      const body = await resp.json().catch(() => ({}));
      return { ok: resp.ok, status: resp.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- 实体快照 ---------- */

  async function loadEntities() {
    const results = await Promise.all(
      ENTITY_IDS.map(async (id) => {
        if (!effectiveOnline()) return null;
        const r = await apiFetch(`/api/entities/${id}`);
        if (r.ok) {
          await Store.saveEntity(r.body);
          return r.body;
        }
        return null;
      })
    );
    for (const id of ENTITY_IDS) {
      const fresh = results[ENTITY_IDS.indexOf(id)];
      const entity = fresh || (await Store.getEntity(id));
      if (entity) state.entities.set(id, entity);
    }
  }

  function getSnapshot(entityId) {
    return state.entities.get(entityId) || null;
  }

  async function getView(entityId) {
    const entity = getSnapshot(entityId) || (await Store.getEntity(entityId));
    const ops = await Store.getOpsByEntity(entityId);
    return Store.deriveView(entity, ops);
  }

  /* ---------- Leader 选举（IDB 租约锁，崩溃自动失效） ---------- */

  async function tryBecomeLeader() {
    const now = Date.now();
    const lock = await Store.getMeta('leaderLock', null);
    if (lock && lock.tabId !== tabId && now - lock.at < LEASE_MS) {
      if (state.isLeader) {
        state.isLeader = false;
        onChange('leader-lost');
      }
      return false;
    }
    await Store.setMeta('leaderLock', { tabId, at: now });
    // 双检：极端并发下确认写入者仍是自己
    const confirm = await Store.getMeta('leaderLock', null);
    const won = confirm && confirm.tabId === tabId;
    if (won && !state.isLeader) {
      state.isLeader = true;
      onChange('leader-won');
      triggerDrain('leader-won');
    } else if (!won && state.isLeader) {
      state.isLeader = false;
      onChange('leader-lost');
    }
    return won;
  }

  /* ---------- 提交：先持久化，再乐观反馈 ---------- */

  async function submit(input) {
    const view = await getView(input.entityId);
    if (view.serverVersion === null) {
      toast(
        'error',
        '暂无法提交：缺少服务器基线',
        '首次使用需在线加载一次数据后才能离线提交（请检查网络后重试）'
      );
      const err = new Error('missing_baseline');
      err.code = 'missing_baseline';
      throw err;
    }
    const op = await Store.createOp({
      ...input,
      baseVersion: view.serverVersion,
      // 基线取提交时的派生视图（含同实体已排队但未同步的前序补丁），保证链式重放时三方合并正确
      baseData: view.data ? structuredClone(view.data) : null,
    });
    Bus.emit('OPS_CHANGED', { entityId: input.entityId, reason: 'submit', opId: op.id });
    toast(
      effectiveOnline() ? 'info' : 'offline',
      effectiveOnline() ? '已提交，正在同步…' : '离线提交已保存',
      effectiveOnline()
        ? `表单「${input.formLabel || input.entityId}」同步中`
        : `断网状态，操作已写入 IndexedDB，恢复网络后自动重放`,
      null
    );
    triggerDrain('submit');
    return op;
  }

  /* ---------- 冲突决策：回滚 / 重试 / 强制覆盖（补偿） ---------- */

  async function resolveConflict(opId, action) {
    const op = await Store.getOp(opId);
    if (!op || op.status !== Store.STATUS.CONFLICT) return;

    if (action === 'rollback') {
      // 补偿动作：撤销未生效的本地操作，视图回到服务器真相
      await Store.deleteOp(opId);
      Bus.emit('OPS_CHANGED', { entityId: op.entityId, reason: 'rollback', opId });
      toast('warning', '已回滚本地提交', `表单「${op.formId}」恢复为服务器最新数据，未写入任何脏数据`);
      triggerDrain('rollback');
      return;
    }

    if (action === 'force') {
      // 强制覆盖：以用户版本整体提交（补偿写），baseVersion 用最新服务器版本
      const snapshot = getSnapshot(op.entityId);
      const intended =
        op.kind === 'full' && op.fullData
          ? structuredClone(op.fullData)
          : { ...(op.baseData || {}), ...(op.patch || {}) };
      const forced = await Store.saveOp({
        ...op,
        kind: 'full',
        fullData: intended,
        patch: null,
        baseVersion: snapshot ? snapshot.version : op.baseVersion,
        baseData: snapshot ? structuredClone(snapshot.data) : op.baseData,
        status: Store.STATUS.QUEUED,
        attempts: 0,
        lastError: null,
        nextAttemptAt: 0,
      });
      Bus.emit('OPS_CHANGED', { entityId: op.entityId, reason: 'force', opId });
      toast('info', '已改为强制覆盖', '将以你的版本覆盖服务器数据');
      triggerDrain('force');
      return;
    }

    if (action === 'retry') {
      await Store.saveOp({ ...op, status: Store.STATUS.QUEUED, nextAttemptAt: 0, lastError: null });
      Bus.emit('OPS_CHANGED', { entityId: op.entityId, reason: 'retry', opId });
      triggerDrain('retry');
    }
  }

  /* ---------- 重放 ---------- */

  let drainScheduled = false;
  function triggerDrain() {
    if (!state.started) return;
    if (drainScheduled) return;
    drainScheduled = true;
    setTimeout(() => {
      drainScheduled = false;
      drainQueue();
    }, 80);
  }

  async function drainQueue() {
    if (!state.isLeader || !effectiveOnline()) return;
    const pending = await Store.getPendingOps();
    const queued = pending.filter((op) => op.status === Store.STATUS.QUEUED);
    // 每个实体取链头一个；不同表单（实体）互不阻塞
    const heads = new Map();
    for (const op of queued) {
      if (!heads.has(op.entityId)) heads.set(op.entityId, op);
    }
    await Promise.all(
      [...heads.values()].map((op) => replayOne(op))
    );
  }

  async function replayOne(op) {
    if (state.sending.has(op.entityId)) return;
    if (op.nextAttemptAt && op.nextAttemptAt > Date.now()) return;

    state.sending.add(op.entityId);
    const sending = { ...op, status: Store.STATUS.SENDING, attempts: op.attempts + 1, lastError: null };
    await Store.saveOp(sending);
    Bus.emit('OPS_CHANGED', { entityId: op.entityId, reason: 'sending', opId: op.id });

    try {
      const payload = {
        userId: op.userId,
        baseVersion: op.baseVersion,
      };
      if (op.kind === 'full') payload.fullData = op.fullData;
      else {
        payload.patch = op.patch;
        payload.baseData = op.baseData;
        payload.mergeStrategy = 'merge'; // patch 类表单允许字段级自动合并
      }

      const r = await apiFetch(`/api/entities/${op.entityId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });

      if (r.ok) {
        state.entities.set(op.entityId, r.body);
        await Store.saveEntity(r.body);
        await Store.saveOp({ ...sending, status: Store.STATUS.DONE, lastError: null });
        Bus.emit('ENTITY_UPDATED', { entityId: op.entityId, entity: r.body, opId: op.id });
        Bus.emit('OPS_CHANGED', { entityId: op.entityId, reason: 'synced', opId: op.id });
        toast('success', '同步成功', `表单「${op.formId}」已提交，服务器版本 v${r.body.version}`);
        // 链上后续操作立即重放
        setTimeout(() => triggerDrain('chain'), 0);
      } else if (r.status === 409) {
        if (r.body && r.body.server) {
          state.entities.set(op.entityId, r.body.server);
          await Store.saveEntity(r.body.server);
          Bus.emit('ENTITY_UPDATED', { entityId: op.entityId, entity: r.body.server, opId: op.id });
        }
        const conflictOp = await Store.saveOp({
          ...sending,
          status: Store.STATUS.CONFLICT,
          lastError: { stage: 'server-conflict', message: r.body.message || '版本冲突', at: Date.now() },
          conflictFields: r.body.conflictFields || null,
        });
        Bus.emit('OPS_CHANGED', { entityId: op.entityId, reason: 'conflict', opId: op.id });
        toast(
          'error',
          '提交冲突，已暂停该表单队列',
          `${r.body.message || '服务器数据已被他人修改'}。可选择回滚、重试或强制覆盖。`,
          [
            { label: '回滚', action: 'rollback', opId: op.id },
            { label: '重试', action: 'retry', opId: op.id },
            { label: '强制覆盖', action: 'force', opId: op.id },
          ]
        );
        void conflictOp;
      } else {
        await backoff(sending, {
          stage: `http-${r.status}`,
          message: (r.body && r.body.message) || `服务器返回 ${r.status}`,
        });
      }
    } catch (err) {
      await backoff(sending, { stage: 'network', message: err.name === 'AbortError' ? '请求超时' : String(err.message || err) });
    } finally {
      state.sending.delete(op.entityId);
    }
  }

  async function backoff(op, error) {
    const delay = Math.min(1000 * 2 ** Math.min(op.attempts, 5), 30000);
    await Store.saveOp({
      ...op,
      status: Store.STATUS.QUEUED,
      lastError: { ...error, at: Date.now() },
      nextAttemptAt: Date.now() + delay,
    });
    Bus.emit('OPS_CHANGED', { entityId: op.entityId, reason: 'retry-scheduled', opId: op.id });
    toast(
      'warning',
      '同步失败，已自动排队重试',
      `阶段：${error.stage}；原因：${error.message}；${Math.round(delay / 1000)}s 后重试`,
      null
    );
  }

  /* ---------- 生命周期 ---------- */

  function handleOnline() {
    state.online = true;
    onChange('online');
    if (effectiveOnline()) {
      toast('success', '网络已恢复', '开始自动重放离线队列…');
    }
    triggerDrain('online');
  }
  function handleOffline() {
    state.online = false;
    onChange('offline');
    toast('offline', '已进入离线模式', '提交将保存在本地，刷新页面也不会丢失');
  }

  // 其他标签页改动了队列/实体（非 Leader 标签也会收到）
  Bus.on('OPS_CHANGED', () => onChange('remote-ops'));
  Bus.on('ENTITY_UPDATED', () => onChange('remote-entity'));
  Bus.on('SIM_OFFLINE', (payload) => {
    const wasOffline = !effectiveOnline();
    state.simOffline = Boolean(payload.offline);
    const nowOffline = !effectiveOnline();
    onChange('sim-offline');
    if (wasOffline && !nowOffline) {
      toast('success', '网络已恢复', '开始自动重放离线队列…');
      triggerDrain('sim-online');
    } else if (nowOffline) {
      toast('offline', '已进入离线模式', '提交将保存在本地，刷新页面也不会丢失');
    }
  });

  async function resetAll() {
    const all = await Store.getAllOps();
    await Promise.all(all.map((op) => Store.deleteOp(op.id)));
    state.entities.clear();
    if (state.online) {
      if (effectiveOnline()) await apiFetch('/api/reset', { method: 'POST' });
      await loadEntities();
    }
    Bus.emit('OPS_CHANGED', { entityId: 'all', reason: 'reset' });
    onChange('reset');
  }

  async function start() {
    if (state.started) return;
    state.started = true;
    await Store.recoverSendingOps();
    state.simOffline = localStorage.getItem('simOffline') === '1';
    await loadEntities();

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    setInterval(() => tryBecomeLeader(), HEARTBEAT_MS);
    setInterval(() => triggerDrain('tick'), TICK_MS);
    setInterval(() => {
      Store.purgeDoneOps().then(() => triggerDrain('purge'));
    }, 5000);
    tryBecomeLeader();
    onChange('start');
  }

  global.Engine = {
    start,
    submit,
    resolveConflict,
    resetAll,
    getView,
    getSnapshot,
    subscribe,
    triggerDrain,
    isLeader: () => state.isLeader,
    isOnline: () => state.online,
    isEffectiveOnline: effectiveOnline,
    tabId: () => tabId,
    ENTITY_IDS,
  };
})(window);
