/* 持久化数据访问层：操作队列（状态机）、服务器实体快照、元信息 */
(function (global) {
  const STATUS = {
    QUEUED: 'queued',     // 等待重放（含网络错误退避中）
    SENDING: 'sending',   // 正在与服务器同步
    CONFLICT: 'conflict', // 服务器返回 409，等待用户决策
    DONE: 'done',         // 同步成功（短暂保留用于 UI 反馈）
  };
  const PENDING_STATUSES = [STATUS.QUEUED, STATUS.SENDING, STATUS.CONFLICT];
  const DONE_TTL_MS = 15_000;

  function genId() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  async function saveOp(op) {
    op.updatedAt = Date.now();
    await IDB.put('ops', op);
    return op;
  }

  async function createOp(input) {
    const op = {
      id: genId(),
      entityId: input.entityId,
      formId: input.formId || input.entityId,
      userId: input.userId || 'anonymous',
      userName: input.userName || '',
      kind: input.kind || 'patch', // patch（可字段合并）| full（整体覆盖）
      patch: input.patch || null,
      fullData: input.fullData || null,
      baseVersion: input.baseVersion,
      baseData: input.baseData || null,
      status: STATUS.QUEUED,
      attempts: 0,
      lastError: null,
      conflictFields: null,
      nextAttemptAt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveOp(op);
    return op;
  }

  async function getAllOps() {
    const ops = await IDB.getAll('ops');
    return ops.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function getOpsByEntity(entityId) {
    const ops = await IDB.getAllByIndex('ops', 'entityId', entityId);
    return ops.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function getOp(id) {
    return IDB.get('ops', id);
  }

  async function deleteOp(id) {
    await IDB.del('ops', id);
  }

  async function getPendingOps() {
    const ops = await getAllOps();
    return ops.filter((op) => PENDING_STATUSES.includes(op.status));
  }

  // 崩溃恢复：上次发送到一半的操作重新置回队列
  async function recoverSendingOps() {
    const ops = await getAllOps();
    let recovered = 0;
    await Promise.all(
      ops
        .filter((op) => op.status === STATUS.SENDING)
        .map((op) => {
          recovered += 1;
          return saveOp({ ...op, status: STATUS.QUEUED, lastError: '发送中断，已重新入队' });
        })
    );
    return recovered;
  }

  async function purgeDoneOps() {
    const ops = await getAllOps();
    const cutoff = Date.now() - DONE_TTL_MS;
    await Promise.all(
      ops.filter((op) => op.status === STATUS.DONE && op.updatedAt < cutoff).map((op) => deleteOp(op.id))
    );
  }

  async function saveEntity(entity) {
    await IDB.put('entities', { ...entity, cachedAt: Date.now() });
  }

  async function getEntity(entityId) {
    return IDB.get('entities', entityId);
  }

  async function setMeta(key, value) {
    await IDB.put('meta', { key, value });
  }
  async function getMeta(key, fallback = null) {
    const row = await IDB.get('meta', key);
    return row ? row.value : fallback;
  }

  function applyOp(data, op) {
    if (op.kind === 'full' && op.fullData) return structuredClone(op.fullData);
    if (op.kind === 'patch' && op.patch) return { ...data, ...op.patch };
    return data;
  }

  /**
   * 派生视图 = 最近服务器快照 ＋ 仍未提交的本地操作（queued/sending/error）。
   * conflict 操作已被服务器拒绝，不再覆盖 UI；回滚/丢弃即等价于删除该操作。
   */
  function deriveView(entity, ops) {
    const pending = ops.filter(
      (op) => op.status === STATUS.QUEUED || op.status === STATUS.SENDING
    );
    const conflict = ops.filter((op) => op.status === STATUS.CONFLICT);
    let data = entity ? structuredClone(entity.data) : null;
    let version = entity ? entity.version : null;
    pending.forEach((op) => {
      data = applyOp(data, op);
    });
    return {
      entityId: entity ? entity.id : null,
      serverVersion: version,
      data,
      pendingCount: pending.length,
      conflictCount: conflict.length,
      pending,
      conflict,
    };
  }

  global.Store = {
    STATUS,
    PENDING_STATUSES,
    createOp,
    saveOp,
    getAllOps,
    getOpsByEntity,
    getOp,
    deleteOp,
    getPendingOps,
    recoverSendingOps,
    purgeDoneOps,
    saveEntity,
    getEntity,
    setMeta,
    getMeta,
    deriveView,
    applyOp,
  };
})(window);
