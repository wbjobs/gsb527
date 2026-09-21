import { diffChanges, formMap, forms, normalizeValue, readFormData } from './forms.js';
import {
  discardQueueItem,
  getState,
  initializeSync,
  listCompensations,
  listEvents,
  resolveConflict,
  retryQueueItem,
  simulateRemoteEdit,
  setSimulatedOffline,
  isOnline,
  subscribe,
  enqueueSubmission
  ,
  getFormProjection
} from './sync.js';

const elements = {
  forms: document.querySelector('#forms'),
  queue: document.querySelector('#queueList'),
  events: document.querySelector('#eventList'),
  compensations: document.querySelector('#compensationList'),
  toasts: document.querySelector('#toastHost'),
  user: document.querySelector('#currentUser'),
  networkDot: document.querySelector('#networkDot'),
  networkText: document.querySelector('#networkText'),
  toggleOffline: document.querySelector('#toggleOffline'),
  failureMode: document.querySelector('#failureMode'),
  clearEvents: document.querySelector('#clearEvents')
};

const simulation = { seenEvents: new Set() };
const drafts = new Map();

const fieldRenderers = {
  text: renderTextInput,
  textarea: renderTextarea,
  number: renderNumberInput,
  checkbox: renderCheckbox,
  select: renderSelect
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
}

function renderField(form, field, value, disabled) {
  return fieldRenderers[field.type](form, field, value, disabled);
}

function renderTextInput(form, field, value, disabled) {
  return `<input name="${field.name}" type="text" value="${escapeHtml(value)}" placeholder="${escapeHtml(field.placeholder ?? '')}" ${disabled} />`;
}

function renderNumberInput(form, field, value, disabled) {
  return `<input name="${field.name}" type="number" value="${escapeHtml(value)}" placeholder="${escapeHtml(field.placeholder ?? '')}" ${disabled} />`;
}

function renderTextarea(form, field, value, disabled) {
  return `<textarea name="${field.name}" rows="3" placeholder="${escapeHtml(field.placeholder ?? '')}" ${disabled}>${escapeHtml(value)}</textarea>`;
}

function renderCheckbox(form, field, value, disabled) {
  return `<input name="${field.name}" type="checkbox" value="true" ${value ? 'checked' : ''} ${disabled} />`;
}

function renderSelect(form, field, value, disabled) {
  return `<select name="${field.name}" ${disabled}>${field.options
    .map((option) => `<option value="${escapeHtml(option)}" ${option === value ? 'selected' : ''}>${escapeHtml(option)}</option>`)
    .join('')}</select>`;
}

function statusMeta(status) {
  return {
    queued: { label: '等待重放', className: 'queued' },
    flushing: { label: '提交中', className: 'flushing' },
    conflict: { label: '冲突待处理', className: 'conflict' },
    failed: { label: '永久失败', className: 'failed' },
    succeeded: { label: '已成功', className: 'succeeded' }
  }[status] ?? { label: status, className: 'queued' };
}

function renderFormCard(form) {
  const projection = getFormProjection(form.id);
  const data = projection.data;
  const remote = getState().forms.get(form.id);
  const blocked = Boolean(projection.conflict);
  const status = projection.conflict
    ? '存在冲突'
    : projection.failed
      ? '失败，可直接修正重提'
      : projection.active.length
        ? `${projection.active.length} 项队列`
        : '已同步';
  const draft = drafts.get(form.id);

  return `
    <article class="form-card ${blocked ? 'blocked' : ''}" data-form-id="${form.id}">
      <div class="card-head">
        <div>
          <h2>${escapeHtml(form.title)}</h2>
          <p>${escapeHtml(form.description)}</p>
        </div>
        <span class="pill ${projection.conflict ? 'danger' : projection.failed ? 'danger' : projection.active.length ? 'warning' : 'ok'}">${status}</span>
      </div>
      <div class="server-meta">
        <span>服务端版本 <strong>#${remote?.version ?? projection.version}</strong></span>
        <span>最近更新：${remote ? escapeHtml(remote.updatedBy || 'system') : '未连接'}</span>
      </div>
      <form class="data-form">
        ${form.fields
          .map((field) => `
            <label class="field">
              <span>${escapeHtml(field.label)}</span>
              ${renderField(form, field, draft?.[field.name] ?? data[field.name] ?? form.initial[field.name], disabled)}
            </label>
          `)
          .join('')}
        <div class="card-actions">
          <button type="submit" ${disabled}>提交修改</button>
          <button type="button" class="secondary remote-edit">模拟其他用户编辑</button>
        </div>
      </form>
      <details class="server-view">
        <summary>查看当前服务端数据 / 本地基线</summary>
        <pre>${escapeHtml(JSON.stringify({ server: remote, projected: projection.data }, null, 2))}</pre>
      </details>
    </article>
  `;
}

function renderForms() {
  elements.forms.innerHTML = forms.map(renderFormCard).join('');
}

function updateDraft(form, formElement) {
  drafts.set(form.id, readFormData(form, formElement));
}

function renderJsonChanges(changes) {
  return Object.entries(changes).map(([name, value]) => `<span class="change-chip">${escapeHtml(name)}: ${escapeHtml(value)}</span>`).join('');
}

function renderConflictResolution(item) {
  const fields = item.conflict?.fields ?? [];
  return `
    <div class="conflict-box">
      <strong>字段冲突</strong>
      ${fields
        .map(
          (conflict) => `
          <div class="conflict-row">
            <span>${escapeHtml(conflict.name)}</span>
            <em>基线 ${escapeHtml(conflict.base)}</em>
            <b>本地 ${escapeHtml(conflict.local)}</b>
            <b>服务端 ${escapeHtml(conflict.remote)}</b>
            <input data-conflict-field="${escapeHtml(conflict.name)}" value="${escapeHtml(conflict.local)}" aria-label="自定义 ${escapeHtml(conflict.name)}" />
          </div>`
        )
        .join('')}
      ${item.conflict?.autoMerged?.length ? `<p class="hint">非重叠字段已自动合并：${escapeHtml(item.conflict.autoMerged.join('、'))}</p>` : ''}
      <div class="inline-actions">
        <button data-action="resolve-local" data-id="${item.id}">保留本地</button>
        <button class="secondary" data-action="resolve-remote" data-id="${item.id}">采用服务端</button>
        <button class="secondary" data-action="resolve-custom" data-id="${item.id}">用自定义值重放</button>
        <button class="danger" data-action="discard" data-id="${item.id}">丢弃并回滚</button>
      </div>
    </div>
  `;
}

function renderQueueItem(item) {
  const form = formMap.get(item.formId);
  const meta = statusMeta(item.status);
  return `
    <article class="queue-item ${meta.className}" data-queue-id="${item.id}">
      <div class="queue-head">
        <div>
          <strong>${escapeHtml(form?.title ?? item.formId)}</strong>
          <span>${formatTime(item.createdAt)} · ${escapeHtml(item.user)}</span>
        </div>
        <span class="pill ${meta.className}">${meta.label}</span>
      </div>
      <div class="chips">${renderJsonChanges(item.changes)}</div>
      <p class="hint">基线版本 #${item.baseVersion} · 尝试 ${item.attempts} 次 · 幂等键 ${escapeHtml(item.id)}</p>
      ${item.lastError ? `<p class="error-text">${escapeHtml(item.lastError.message)}</p>` : ''}
      ${item.status === 'conflict' ? renderConflictResolution(item) : ''}
      ${item.status === 'failed' ? `
        <div class="inline-actions">
          <button class="danger" data-action="discard" data-id="${item.id}">丢弃并回滚</button>
        </div>` : ''}
      ${item.status === 'queued' ? `
        <div class="inline-actions">
          <button class="secondary" data-action="discard" data-id="${item.id}">取消排队</button>
        </div>` : ''}
    </article>
  `;
}

function renderEmpty(title) {
  return `<div class="empty">${title}</div>`;
}

function renderQueue() {
  const queue = getState().queue;
  elements.queue.innerHTML = queue.length ? queue.map(renderQueueItem).join('') : renderEmpty('当前没有待处理队列');
}

function severityClass(severity) {
  return { success: 'ok', warning: 'warning', danger: 'danger', info: 'info' }[severity] ?? 'info';
}

function renderEvent(event) {
  return `
    <article class="event ${severityClass(event.severity)}">
      <div><strong>${escapeHtml(event.title)}</strong><time>${formatTime(event.createdAt)}</time></div>
      <p>${escapeHtml(event.message)}</p>
    </article>
  `;
}

async function renderEvents() {
  const events = await listEvents();
  elements.events.innerHTML = events.length ? events.slice(0, 30).map(renderEvent).join('') : renderEmpty('暂无异常链路');
}

function renderCompensation(item) {
  return `
    <article class="compensation">
      <div><strong>${escapeHtml(item.strategy)}</strong><time>${formatTime(item.createdAt)}</time></div>
      <p>${escapeHtml(item.reason)} · ${escapeHtml(item.formId)}</p>
      <details>
        <summary>回滚快照</summary>
        <pre>${escapeHtml(JSON.stringify(item.remoteSnapshot ?? item.after, null, 2))}</pre>
      </details>
    </article>
  `;
}

async function renderCompensations() {
  const items = await listCompensations();
  elements.compensations.innerHTML = items.length ? items.slice(0, 20).map(renderCompensation).join('') : renderEmpty('暂无补偿记录');
}

function showToast(event) {
  const toast = document.createElement('div');
  toast.className = `toast ${severityClass(event.severity)}`;
  toast.innerHTML = `<strong>${escapeHtml(event.title)}</strong><p>${escapeHtml(event.message)}</p>`;
  elements.toasts.append(toast);
  setTimeout(() => {
    toast.classList.add('leave');
    setTimeout(() => toast.remove(), 220);
  }, 4200);
}

async function renderAll(event = {}) {
  renderForms();
  renderQueue();
  await Promise.all([renderEvents(), renderCompensations()]);
  updateNetworkUI();

  if (event.id && event.severity && !event.silent && !simulation.seenEvents.has(event.id)) {
    simulation.seenEvents.add(event.id);
    showToast(event);
  }
}

function updateNetworkUI() {
  const online = isOnline();
  elements.networkText.textContent = online ? '在线' : '离线';
  elements.networkDot.className = `dot ${online ? 'online' : 'offline'}`;
  elements.toggleOffline.textContent = online ? '模拟离线' : '恢复在线';
}

function readFailureMode() {
  const mode = elements.failureMode.value;
  if (mode) elements.failureMode.value = '';
  return mode || null;
}

async function handleFormSubmit(event) {
  event.preventDefault();
  const card = event.target.closest('.form-card');
  const form = formMap.get(card.dataset.formId);
  const nextData = readFormData(form, event.target);
  const projection = getFormProjection(form.id);
  const changes = diffChanges(form, projection.data, nextData);

  try {
    await enqueueSubmission({
      formId: form.id,
      changes,
      user: elements.user.value,
      failureMode: readFailureMode()
    });
    drafts.delete(form.id);
  } catch (error) {
    showToast({
      id: `local_${Date.now()}`,
      severity: 'warning',
      title: '未创建提交',
      message: error.message
    });
  }
}

async function handleRemoteEdit(event) {
  const card = event.target.closest('.form-card');
  const form = formMap.get(card.dataset.formId);
  const projection = getFormProjection(form.id);
  const editable = form.fields.filter((field) => field.type !== 'checkbox');
  const fieldLabel = window.prompt(
    `要让其他用户修改哪个字段？\n${editable.map((field, index) => `${index + 1}. ${field.label}`).join('\n')}\n\n输入 1-${editable.length}，默认 1`,
    '1'
  );
  if (fieldLabel === null) return;
  const fieldIndex = Math.max(1, Number(fieldLabel) || 1) - 1;
  const field = editable[Math.min(fieldIndex, editable.length - 1)] ?? form.fields[0];
  const currentValue = projection.remote?.data?.[field.name] ?? (field.type === 'checkbox' ? false : '');
  const rawValue = window.prompt(`模拟其他用户修改「${field.label}」。该修改会直接提升服务端版本：`, String(currentValue));
  if (rawValue === null) return;

  const changes = { [field.name]: normalizeValue(field, rawValue) };
  try {
    await simulateRemoteEdit(form.id, changes, '其他用户（远程）');
  } catch (error) {
    showToast({
      id: `remote_${Date.now()}`,
      severity: 'danger',
      title: '远程编辑失败',
      message: error.message
    });
  }
}

async function handleQueueClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const { action, id } = button.dataset;
  try {
    if (action === 'retry') await retryQueueItem(id);
    if (action === 'discard') await discardQueueItem(id);
    if (action === 'resolve-local') await resolveConflict(id, 'local');
    if (action === 'resolve-remote') await resolveConflict(id, 'remote');
    if (action === 'resolve-custom') {
      const card = button.closest('.queue-item');
      const customChanges = {};
      for (const input of card.querySelectorAll('[data-conflict-field]')) {
        const conflictItem = getState().queue.find((item) => item.id === id);
        const conflict = conflictItem.conflict.fields.find((field) => field.name === input.dataset.conflictField);
        const fieldForm = formMap.get(conflictItem.formId);
        const field = fieldForm.fields.find((candidate) => candidate.name === conflict.name);
        customChanges[conflict.name] = normalizeValue(field, input.value);
      }
      await resolveConflict(id, 'custom', customChanges);
    }
  } catch (error) {
    showToast({
      id: `action_${Date.now()}`,
      severity: 'warning',
      title: '操作未完成',
      message: error.message
    });
  }
}

function bindEvents() {
  elements.forms.addEventListener('submit', handleFormSubmit);
  elements.forms.addEventListener('input', (event) => {
    const formElement = event.target.closest('form');
    const card = event.target.closest('.form-card');
    if (!formElement || !card) return;
    updateDraft(formMap.get(card.dataset.formId), formElement);
  });
  elements.forms.addEventListener('change', (event) => {
    const formElement = event.target.closest('form');
    const card = event.target.closest('.form-card');
    if (!formElement || !card) return;
    updateDraft(formMap.get(card.dataset.formId), formElement);
  });
  elements.forms.addEventListener('click', (event) => {
    if (event.target.matches('.remote-edit')) handleRemoteEdit(event);
  });
  elements.queue.addEventListener('click', handleQueueClick);
  elements.toggleOffline.addEventListener('click', () => {
    setSimulatedOffline(isOnline());
  });
  elements.clearEvents.addEventListener('click', () => {
    elements.events.innerHTML = renderEmpty('当前提示已清空');
    elements.toasts.innerHTML = '';
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !('BroadcastChannel' in window) || !('indexedDB' in window)) {
    showToast({
      id: 'unsupported',
      severity: 'danger',
      title: '浏览器能力不足',
      message: '该演示需要 IndexedDB、Service Worker 和 BroadcastChannel'
    });
    return;
  }
  await navigator.serviceWorker.register('/sw.js');
}

async function bootstrap() {
  bindEvents();
  await registerServiceWorker();
  await initializeSync();
  const existingEvents = await listEvents();
  existingEvents.forEach((event) => simulation.seenEvents.add(event.id));
  subscribe(renderAll);
  await renderAll();
}

bootstrap().catch((error) => {
  console.error(error);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="fatal">初始化失败：${escapeHtml(error.message)}</div>`
  );
});
