import { ApiError, applyRemoteEdit, getForms, patchForm } from './api.js';
import { clearStaleTerminalItems, createId, deleteOne, getAll, getOne, putOne, STORES, tx } from './db.js';
import { formMap } from './forms.js';
import { applyChanges, mergeChanges, projectionFromQueue } from './merge.js';

export const channel = new BroadcastChannel('offline-forms');
export const OFFLINE_STORAGE_KEY = 'offline-forms-demo-offline';

const RETRYABLE_CODES = new Set(['NETWORK_ERROR', 'OFFLINE', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504']);
let stateCache = { forms: new Map(), queue: [], initialized: false };

const listeners = new Set();

export function isOnline() {
  return navigator.onLine && localStorage.getItem(OFFLINE_STORAGE_KEY) !== '1';
}

export function setSimulatedOffline(value) {
  if (value) localStorage.setItem(OFFLINE_STORAGE_KEY, '1');
  else localStorage.removeItem(OFFLINE_STORAGE_KEY);
  const event = {
    id: createId('evt'),
    formId: 'global',
    type: value ? 'simulated-offline' : 'simulated-online',
    severity: value ? 'warning' : 'success',
    title: value ? '已切换为模拟离线' : '已恢复在线',
    message: value ? '提交将仅写入 IndexedDB' : '开始自动重放持久化队列',
    createdAt: Date.now()
  };
  channel.postMessage(event);
  emit(event);
  if (!value) scheduleFlush(null, 100);
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState() {
  return stateCache;
}

function emit(event = {}) {
  for (const listener of listeners) listener(event);
}

function broadcast(event) {
  channel.postMessage(event);
  emit(event);
}

async function saveEvent(event) {
  await putOne(STORES.events, event);
}

async function pruneEvents() {
  const events = await getAll(STORES.events);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const stale = events.filter((event) => event.createdAt < cutoff);
  if (!stale.length) return;
  await tx(STORES.events, 'readwrite', (stores) => {
    for (const event of stale) stores[STORES.events].delete(event.id);
  });
}

async function recordEvent({ formId, type, severity = 'info', title, message, details = {}, broadcasted = true }) {
  const event = {
    id: createId('evt'),
    formId,
    type,
    severity,
    title,
    message,
    details,
    createdAt: Date.now()
  };
  await saveEvent(event);
  if (broadcasted) broadcast(event);
  return event;
}

async function recordCompensation({ formId, queueItem, reason, rolledBackTo, remoteSnapshot, strategy = 'rollback' }) {
  const compensation = buildCompensation({ formId, queueItem, reason, rolledBackTo, remoteSnapshot, strategy });
  await putOne(STORES.compensations, compensation);
  return compensation;
}

export async function listCompensations(formId = null) {
  const items = await getAll(STORES.compensations);
  return items
    .filter((item) => !formId || item.formId === formId)
    .sort((left, right) => right.createdAt - left.createdAt);
}

export async function listEvents(formId = null) {
  const items = await getAll(STORES.events);
  return items
    .filter((item) => !formId || item.formId === formId || item.formId === 'global')
    .sort((left, right) => right.createdAt - left.createdAt);
}

async function refreshCache() {
  const [serverStates, queue] = await Promise.all([getAll(STORES.state), getAll(STORES.queue)]);
  stateCache = {
    forms: new Map(serverStates.map((state) => [state.formId, state])),
    queue: queue.sort((left, right) => left.createdAt - right.createdAt),
    initialized: true
  };
  emit({ type: 'state-updated', silent: true });
  return stateCache;
}

export function getFormProjection(formId) {
  const remote = stateCache.forms.get(formId);
  const queue = stateCache.queue.filter((item) => item.formId === formId);
  return projectionFromQueue({ remote, queue });
}

export async function refreshFromServer({ showError = true } = {}) {
  if (!isOnline()) return getState();

  try {
    const body = await getForms();
    await tx(STORES.state, 'readwrite', (stores) => {
      for (const form of body.data) stores[STORES.state].put(form);
    });
    await refreshCache();
    return getState();
  } catch (error) {
    if (showError) {
      await recordEvent({
        formId: 'global',
        type: 'fetch-failed',
        severity: 'warning',
        title: '服务器状态刷新失败',
        message: error.message,
        details: { stack: error.stack }
      });
    }
    await refreshCache();
    return getState();
  }
}

export async function simulateRemoteEdit(formId, changes, actor) {
  const body = await applyRemoteEdit(formId, changes, actor);
  await putOne(STORES.state, body.data);
  await refreshCache();
  await recordEvent({
    formId,
    type: 'remote-edit',
    severity: 'info',
    title: '远程用户已修改',
    message: `${actor} 修改了 ${Object.keys(changes).join('、') || '空字段'}`,
    details: { changes, server: body.data }
  });
  return body;
}

export async function enqueueSubmission({ formId, changes, user, failureMode = null }) {
  const form = formMap.get(formId);
  if (!form) throw new Error(`未知表单：${formId}`);
  if (!Object.keys(changes).length) throw new Error('没有字段变化，无需提交');

  const current = getFormProjection(formId);
  const orderedQueue = getState()
    .queue
    .filter((queueItem) => queueItem.formId === formId && ['conflict', 'failed'].includes(queueItem.status))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const blockedItem = orderedQueue[0];
  if (blockedItem?.status === 'conflict') {
    throw new Error('该表单存在待处理冲突，请先在离线队列中选择合并方式');
  }

  const item = {
    id: blockedItem?.id ?? createId('out'),
    formId,
    user,
    changes,
    baseSnapshot: current.data,
    baseVersion: current.version,
    failureMode,
    status: 'queued',
    attempts: 0,
    lastError: null,
    createdAt: blockedItem?.createdAt ?? Date.now(),
    updatedAt: Date.now()
  };

  if (blockedItem?.status === 'failed') {
    await tx(STORES.queue, 'readwrite', (stores) => {
      stores[STORES.queue].put(item);
    });
  } else {
    await putOne(STORES.queue, item);
  }
  await refreshCache();
  await recordEvent({
    formId,
    type: blockedItem ? 'failed-submission-replaced' : 'submission-enqueued',
    severity: 'success',
    title: blockedItem ? '已用修正数据替换失败项' : isOnline() ? '已加入同步队列' : '离线提交已保存',
    message: blockedItem ? '失败队列项重新进入重放流程' : isOnline() ? '正在尝试提交' : '刷新页面也不会丢失，恢复网络后自动重放',
    details: { id: item.id, changes, user, replaced: Boolean(blockedItem) }
  });

  scheduleFlush();
  return item;
}

function isRetryableError(error) {
  if (!(error instanceof ApiError)) return true;
  if (error.status >= 500) return true;
  return RETRYABLE_CODES.has(error.code);
}

function findReplayItem(queue, formId) {
  return queue
    .filter((item) => item.formId === formId && item.status === 'queued')
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
}

async function markQueueItem(id, patch) {
  const current = await getOne(STORES.queue, id);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await putOne(STORES.queue, next);
  return next;
}

function buildCompensation({ formId, queueItem, reason, rolledBackTo, remoteSnapshot, strategy = 'rollback' }) {
  return {
    id: createId('cmp'),
    formId,
    queueItemId: queueItem.id,
    reason,
    strategy,
    before: {
      changes: queueItem.changes,
      baseVersion: queueItem.baseVersion,
      expectedVersion: queueItem.expectedVersion
    },
    after: rolledBackTo,
    remoteSnapshot,
    createdAt: Date.now()
  };
}

async function resetInterruptedFlushes(formId = null) {
  const interrupted = (await getAll(STORES.queue)).filter(
    (item) => item.status === 'flushing' && (!formId || item.formId === formId)
  );
  if (!interrupted.length) return;
  await tx(STORES.queue, 'readwrite', (stores) => {
    for (const item of interrupted) {
      stores[STORES.queue].put({
        ...item,
        status: 'queued',
        lastError: { status: 0, code: 'INTERRUPTED', message: '页面刷新或中断，已恢复为待重放' },
        updatedAt: Date.now()
      });
    }
  });
}

async function flushForm(formId) {
  if (!navigator.locks?.request) return flushFormWithoutLock(formId);

  await navigator.locks.request(`offline-form-flush:${formId}`, { ifAvailable: true }, async (granted) => {
    if (granted) await flushFormWithoutLock(formId);
  });
}

async function flushFormWithoutLock(formId) {
  if (!isOnline()) return;
  await resetInterruptedFlushes(formId);

  while (isOnline()) {
    await refreshCache();
    const queue = getState().queue;
    const blocking = queue
      .filter((item) => item.formId === formId && ['conflict', 'failed'].includes(item.status))
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (blocking) return;

    const item = findReplayItem(queue, formId);
    if (!item) return;

    const serverBefore = getState().forms.get(formId);
    await markQueueItem(item.id, { status: 'flushing' });
    await refreshCache();

    try {
      const body = await patchForm(
        formId,
        {
          expectedVersion: serverBefore?.version ?? item.baseVersion,
          changes: item.changes,
          idempotencyKey: item.id,
          actor: item.user
        },
        item.failureMode
      );

      await tx([STORES.state, STORES.queue], 'readwrite', (stores) => {
        stores[STORES.state].put(body.data);
        stores[STORES.queue].delete(item.id);
      });
      await refreshCache();
      await recordEvent({
        formId,
        type: 'submission-succeeded',
        severity: 'success',
        title: '表单同步成功',
        message: `${item.user} 的修改已提交到服务端版本 ${body.data.version}`,
        details: { id: item.id, changes: item.changes, server: body.data }
      });
      broadcast({ type: 'state-sync-needed', reason: 'submission-succeeded', formId });
    } catch (error) {
      await handleFlushError({ error, item, serverBefore });
      return;
    }
  }
}

async function handleFlushError({ error, item, serverBefore }) {
  const remoteSnapshot = error.body?.data ?? serverBefore ?? null;

  if (error instanceof ApiError && error.status === 409 && remoteSnapshot) {
    const form = formMap.get(item.formId);
    const mergeResult = mergeChanges({
      base: item.baseSnapshot,
      localChanges: item.changes,
      remoteData: remoteSnapshot.data,
      allowedNames: form.fields.map((field) => field.name)
    });

    if (!mergeResult.conflicts.length) {
      if (!Object.keys(mergeResult.mergedChanges).length) {
        await deleteOne(STORES.queue, item.id);
        await refreshCache();
        await recordEvent({
          formId: item.formId,
          type: 'conflict-already-resolved',
          severity: 'info',
          title: '冲突已自动一致',
          message: '本地修改与服务端最终值相同，队列项已完成',
          details: { id: item.id, autoMerged: mergeResult.autoMerged }
        });
        return;
      }

      const nextItem = {
        ...item,
        status: 'queued',
        changes: mergeResult.mergedChanges,
        baseSnapshot: remoteSnapshot.data,
        baseVersion: remoteSnapshot.version,
        failureMode: null,
        attempts: item.attempts + 1,
        lastError: null,
        updatedAt: Date.now()
      };
      await tx([STORES.state, STORES.queue], 'readwrite', (stores) => {
        stores[STORES.state].put(remoteSnapshot);
        stores[STORES.queue].put(nextItem);
      });
      await refreshCache();
      await recordEvent({
        formId: item.formId,
        type: 'conflict-auto-merged',
        severity: 'warning',
        title: '检测到冲突，已自动合并非重叠字段',
        message: `自动保留字段：${mergeResult.autoMerged.join('、')}，准备重放`,
        details: { id: item.id, merge: mergeResult, remote: remoteSnapshot }
      });
      scheduleFlush(item.formId);
      return;
    }

    const conflictState = {
      status: 'conflict',
      attempts: item.attempts + 1,
      lastError: {
        status: error.status,
        code: error.code,
        message: error.message,
        conflict: error.body?.error?.conflict
      },
      conflict: {
        fields: mergeResult.conflicts,
        autoMerged: mergeResult.autoMerged,
        mergedChanges: mergeResult.mergedChanges,
        remoteSnapshot
      }
    };
    const compensation = buildCompensation({
      formId: item.formId,
      queueItem: item,
      reason: 'VERSION_CONFLICT',
      rolledBackTo: remoteSnapshot,
      remoteSnapshot,
      strategy: 'rollback-to-server-pending-resolution'
    });
    await tx([STORES.state, STORES.queue], 'readwrite', (stores) => {
      stores[STORES.state].put(remoteSnapshot);
      stores[STORES.queue].put({ ...item, ...conflictState, updatedAt: Date.now() });
      stores[STORES.compensations].put(compensation);
    });
    await refreshCache();
    await recordEvent({
      formId: item.formId,
      type: 'conflict-detected',
      severity: 'danger',
      title: '检测到多用户冲突，乐观更新已回滚',
      message: `冲突字段：${mergeResult.conflicts.map((conflict) => conflict.name).join('、')}。请选择保留本地、采用服务端或自定义合并后重放`,
      details: { id: item.id, merge: mergeResult, remote: remoteSnapshot }
    });
    return;
  }

  if (isRetryableError(error)) {
    await markQueueItem(item.id, {
      status: 'queued',
      attempts: item.attempts + 1,
      failureMode: null,
      lastError: { status: error.status ?? 0, code: error.code || 'NETWORK_ERROR', message: error.message }
    });
    await refreshCache();
    await recordEvent({
      formId: item.formId,
      type: 'submission-retryable',
      severity: 'warning',
      title: '提交暂未完成',
      message: `${error.message}。队列已持久化，将继续自动重放`,
      details: { id: item.id, attempts: item.attempts + 1 }
    });
    scheduleFlush(item.formId, Math.min(30000, 500 * 2 ** Math.min(item.attempts, 5)));
    return;
  }

  const failedItem = {
    ...item,
    status: 'failed',
    attempts: item.attempts + 1,
    lastError: { status: error.status, code: error.code, message: error.message, body: error.body },
    updatedAt: Date.now()
  };
  const compensation = buildCompensation({
    formId: item.formId,
    queueItem: item,
    reason: error.code || `HTTP_${error.status}`,
    rolledBackTo: remoteSnapshot,
    remoteSnapshot,
    strategy: 'rollback-permanent-error'
  });
  if (remoteSnapshot) {
    await tx([STORES.state, STORES.queue, STORES.compensations], 'readwrite', (stores) => {
      stores[STORES.state].put(remoteSnapshot);
      stores[STORES.queue].put(failedItem);
      stores[STORES.compensations].put(compensation);
    });
  } else {
    await putOne(STORES.queue, failedItem);
    await putOne(STORES.compensations, compensation);
  }
  await refreshCache();
  await recordEvent({
    formId: item.formId,
    type: 'submission-failed',
    severity: 'danger',
    title: '提交失败，已回滚该表单乐观更新',
    message: `${error.message}。可修正数据后重试，或丢弃该队列项`,
    details: { id: item.id, error: error.body ?? error.message }
  });
}

const flushTimers = new Map();

export function scheduleFlush(formId = null, delay = navigator.onLine ? 120 : 1000) {
  const formIds = formId ? [formId] : [...formMap.keys()];
  for (const id of formIds) {
    clearTimeout(flushTimers.get(id));
    flushTimers.set(id, setTimeout(() => {
      flushTimers.delete(id);
      flushForm(id);
    }, delay));
  }
}

export async function retryQueueItem(id) {
  const item = await getOne(STORES.queue, id);
  if (!item) throw new Error('队列项不存在');
  if (!['queued', 'failed', 'conflict'].includes(item.status)) return item;

  const patch = {
    status: 'queued',
    lastError: null,
    failureMode: null
  };
  if (item.status === 'failed') {
    const current = getFormProjection(item.formId);
    patch.baseSnapshot = current.remote?.data ?? item.baseSnapshot;
    patch.baseVersion = current.remote?.version ?? item.baseVersion;
  }
  const next = await markQueueItem(id, patch);
  await refreshCache();
  await recordEvent({
    formId: item.formId,
    type: 'manual-retry',
    severity: 'info',
    title: '已手动重试',
    message: '队列项重新进入重放流程',
    details: { id, previousStatus: item.status }
  });
  scheduleFlush(item.formId, 50);
  return next;
}

export async function discardQueueItem(id, reason = 'manual-discard') {
  const item = await getOne(STORES.queue, id);
  if (!item) return null;

  let remoteSnapshot = null;
  try {
    await refreshFromServer({ showError: false });
    remoteSnapshot = getState().forms.get(item.formId) ?? null;
  } catch {
    remoteSnapshot = item.conflict?.remoteSnapshot ?? null;
  }

  await deleteOne(STORES.queue, id);
  await recordCompensation({
    formId: item.formId,
    queueItem: item,
    reason,
    rolledBackTo: remoteSnapshot,
    remoteSnapshot,
    strategy: 'discard-local-change'
  });
  await refreshCache();
  await recordEvent({
    formId: item.formId,
    type: 'queue-item-discarded',
    severity: 'warning',
    title: '本地队列项已丢弃',
    message: '表单已回滚到服务端状态，后续队列继续处理',
    details: { id, reason }
  });
  scheduleFlush(item.formId, 50);
  return item;
}

export async function resolveConflict(id, mode, customChanges = null) {
  const item = await getOne(STORES.queue, id);
  if (!item || item.status !== 'conflict') throw new Error('该队列项不是冲突状态');

  const conflict = item.conflict;
  const remoteData = conflict.remoteSnapshot.data;
  const names = conflict.fields.map((field) => field.name);
  let changes = { ...conflict.mergedChanges };
  let strategy = mode;

  if (mode === 'local') {
    for (const field of conflict.fields) changes[field.name] = field.local;
  } else if (mode === 'remote') {
    for (const field of conflict.fields) {
      if (Object.prototype.hasOwnProperty.call(remoteData, field.name)) changes[field.name] = remoteData[field.name];
    }
  } else if (mode === 'custom') {
    if (!customChanges || !Object.keys(customChanges).length) throw new Error('请填写自定义冲突值');
    for (const name of names) {
      if (!Object.prototype.hasOwnProperty.call(customChanges, name)) {
        throw new Error(`冲突字段 ${name} 缺少自定义值`);
      }
      changes[name] = customChanges[name];
    }
  } else {
    throw new Error(`未知冲突解决方式：${mode}`);
  }

  if (!Object.keys(changes).length) {
    await deleteOne(STORES.queue, id);
    await refreshCache();
    await recordEvent({
      formId: item.formId,
      type: 'conflict-no-local-change',
      severity: 'info',
      title: '冲突已按服务端值消除',
      message: '本地没有需要继续重放的字段，队列项已完成',
      details: { id, mode }
    });
    scheduleFlush(item.formId, 50);
    return;
  }

  await markQueueItem(id, {
    status: 'queued',
    changes,
    baseSnapshot: remoteData,
    baseVersion: conflict.remoteSnapshot.version,
    conflict: { ...conflict, resolved: true, resolution: mode, resolvedAt: Date.now() },
    lastError: null
  });
  await refreshCache();
  await recordEvent({
    formId: item.formId,
    type: 'conflict-resolved',
    severity: 'success',
    title: '冲突已解决',
    message: `将按“${mode === 'local' ? '保留本地' : mode === 'remote' ? '采用服务端' : '自定义合并'}”重放`,
    details: { id, mode, changes, conflictFields: names, strategy }
  });
  scheduleFlush(item.formId, 50);
}

let initialized = false;

export async function initializeSync() {
  if (initialized) return getState();
  initialized = true;

  await clearStaleTerminalItems();
  await resetInterruptedFlushes();
  await refreshCache();
  await pruneEvents();
  await refreshFromServer({ showError: false });

  window.addEventListener('online', async () => {
    if (!isOnline()) return;
    await recordEvent({
      formId: 'global',
      type: 'network-online',
      severity: 'success',
      title: '网络已恢复',
      message: '开始自动重放所有表单的持久化队列'
    });
    scheduleFlush(null, 200);
  });

  window.addEventListener('offline', () => {
    broadcast({
      id: createId('evt'),
      formId: 'global',
      type: 'network-offline',
      severity: 'warning',
      title: '已进入离线模式',
      message: '提交会保存到 IndexedDB，刷新页面也不会丢失',
      createdAt: Date.now()
    });
  });

  channel.onmessage = async (message) => {
    const event = message.data;
    if (!event) return;
    if (['state-sync-needed', 'remote-edit'].includes(event.type)) {
      await refreshFromServer({ showError: false });
      emit(event);
    } else if (['simulated-online', 'simulated-offline'].includes(event.type)) {
      emit(event);
      if (event.type === 'simulated-online') scheduleFlush(null, 100);
    } else {
      emit(event);
    }
  };

  scheduleFlush(null, 500);
  return getState();
}
