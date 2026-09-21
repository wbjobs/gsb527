/* 应用装配：渲染、事件、Service Worker 注册、离线开关、冲突操作代理 */
(function () {
  const els = {};
  let views = new Map();

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function currentUser() {
    const id = localStorage.getItem('currentUserId') || UI.USERS[0].id;
    return UI.USERS.find((user) => user.id === id) || UI.USERS[0];
  }

  async function refreshViews() {
    for (const form of UI.FORMS) {
      views.set(form.entityId, await Engine.getView(form.entityId));
    }
  }

  function renderHeader() {
    const online = Engine.isEffectiveOnline();
    els.netDot.className = `dot ${online ? 'dot-on' : 'dot-off'}`;
    els.netText.textContent = online ? '在线（自动同步）' : '离线（本地持久化）';
    els.leaderText.textContent = Engine.isLeader() ? '本标签页负责重放' : '其他标签页负责重放';
    const counts = [...views.values()].reduce(
      (acc, view) => {
        acc.pending += view.pendingCount;
        acc.conflict += view.conflictCount;
        return acc;
      },
      { pending: 0, conflict: 0 }
    );
    els.queueSummary.textContent = `待同步 ${counts.pending} · 冲突 ${counts.conflict}`;
    els.queueSummary.className = counts.conflict ? 'summary summary-danger' : 'summary';
    els.offlineToggle.checked = !online;
  }

  // 输入框只在外部数据变化（服务器/其他标签页）时回填，避免打断正在输入
  function syncInputs(card, form, view) {
    const data = view.data || {};
    card.querySelectorAll('[data-key]').forEach((input) => {
      if (document.activeElement === input) return;
      const key = input.dataset.key;
      if (input.type === 'checkbox') input.checked = Boolean(data[key]);
      else if (document.activeElement !== input) input.value = data[key] ?? '';
    });
    card.querySelector('.card-side').innerHTML = badgeHtml(view);
    card.querySelector('[data-role="mini-queue"]').innerHTML = UI.renderMiniQueue(view);
  }

  function badgeHtml(view) {
    const badge =
      view.conflictCount > 0
        ? '<span class="badge badge-danger">冲突待处理</span>'
        : view.pendingCount > 0
          ? `<span class="badge badge-warn">${view.pendingCount} 条待同步</span>`
          : '<span class="badge badge-ok">已同步</span>';
    const ver = view.serverVersion === null ? '—' : `v${view.serverVersion}`;
    return `${badge}<span class="version">服务器版本 ${ver}</span>`;
  }

  async function renderAll() {
    await refreshViews();
    renderHeader();
    for (const form of UI.FORMS) {
      const view = views.get(form.entityId);
      const card = $(`#card-${form.entityId}`);
      if (card) syncInputs(card, form, view);
    }
    const groups = await Promise.all(UI.FORMS.map((form) => Store.getOpsByEntity(form.entityId)));
    els.queueBody.innerHTML = UI.renderQueuePanel(groups);
  }

  function setHint(formEl, message, ok) {
    const hint = formEl.querySelector('[data-role="hint"]');
    hint.textContent = message || '';
    hint.className = `form-hint ${ok ? 'hint-ok' : 'hint-err'}`;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const formEl = event.target;
    const entityId = formEl.dataset.entity;
    const form = UI.FORMS.find((item) => item.entityId === entityId);
    const values = UI.readFormValues(formEl);
    const error = UI.validate(form, values);
    if (error) {
      setHint(formEl, error, false);
      return;
    }
    const user = currentUser();
    setHint(formEl, Engine.isEffectiveOnline() ? '提交中…' : '离线已保存，恢复后自动重放', true);
    let patch = null;
    if (form.kind === 'patch') {
      const baseline = (views.get(entityId)?.data) || {};
      patch = {};
      form.fields.forEach((field) => {
        const next = values[field.key];
        if (JSON.stringify(next) !== JSON.stringify(baseline[field.key])) {
          patch[field.key] = next;
        }
      });
      if (Object.keys(patch).length === 0) {
        setHint(formEl, '没有检测到字段变更', false);
        return;
      }
    }
    try {
      await Engine.submit({
        entityId,
        formId: form.title.split('·')[1].trim(),
        formLabel: form.title,
        kind: form.kind,
        patch,
        fullData: form.kind === 'full' ? values : null,
        userId: user.id,
        userName: user.name,
      });
      await renderAll();
    } catch (err) {
      if (err.code === 'missing_baseline') {
        setHint(formEl, '缺少服务器基线，请先在线加载一次', false);
      } else {
        setHint(formEl, `提交失败：${err.message || err}`, false);
      }
    }
  }

  function setSimOffline(offline) {
    localStorage.setItem('simOffline', offline ? '1' : '0');
    Bus.emit('SIM_OFFLINE', { offline });
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'OFFLINE_MODE', offline });
    }
  }

  // 演示辅助：以“其他用户”身份直接改服务器数据，制造版本冲突
  async function injectRemoteChange() {
    const entityId = els.injectEntity.value;
    if (!Engine.isEffectiveOnline()) {
      UI.showToast({
        type: 'warning',
        title: '当前处于离线状态',
        detail: '「制造冲突」需要服务器参与：请先恢复在线，或先离线提交、再点此按钮，然后恢复网络观察冲突。',
      });
      return;
    }
    try {
      const current = await (await fetch(`/api/entities/${entityId}`)).json();
      const patch =
        entityId === 'profile'
          ? { bio: `服务器侧修改 @ ${new Date().toLocaleTimeString()}（他人已更新简介）` }
          : entityId === 'settings'
            ? { theme: current.data.theme === 'dark' ? 'light' : 'dark' }
            : { hours: (Number(current.data.hours) % 8) + 1, note: '管理员代填修改' };
      const r = await fetch(`/api/entities/${entityId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'other-user',
          baseVersion: current.version,
          mergeStrategy: 'merge',
          patch,
          baseData: current.data,
        }),
      });
      if (r.ok) {
        const entity = await r.json();
        await Store.saveEntity(entity);
        Bus.emit('ENTITY_UPDATED', { entityId, entity, reason: 'inject' });
        UI.showToast({ type: 'info', title: '已注入他人修改', detail: `${entityId} 服务器版本推进到 v${entity.version}` });
        await renderAll();
      } else {
        UI.showToast({ type: 'error', title: '注入失败', detail: `HTTP ${r.status}` });
      }
    } catch (err) {
      UI.showToast({ type: 'error', title: '注入异常', detail: String(err.message || err) });
    }
  }

  async function handleConflictAction(action, opId) {
    await Engine.resolveConflict(opId, action);
    await renderAll();
  }

  function bindEvents() {
    $('#forms').addEventListener('submit', handleSubmit);

    els.offlineToggle.addEventListener('change', () => setSimOffline(els.offlineToggle.checked));

    els.userSelect.addEventListener('change', () => {
      localStorage.setItem('currentUserId', els.userSelect.value);
      renderAll();
    });

    els.injectBtn.addEventListener('click', injectRemoteChange);

    els.resetBtn.addEventListener('click', async () => {
      await Engine.resetAll();
      await renderAll();
      UI.showToast({ type: 'success', title: '已重置演示数据', detail: '服务器实体与本地队列均已清空重建' });
    });

    // 队列面板 & Toast 中的冲突按钮（事件委托）
    document.addEventListener('click', async (event) => {
      const conflictBtn = event.target.closest('[data-conflict-action]');
      if (conflictBtn) {
        event.preventDefault();
        return handleConflictAction(conflictBtn.dataset.conflictAction, conflictBtn.dataset.op);
      }
      const toastBtn = event.target.closest('[data-toast-action]');
      if (toastBtn) {
        await handleConflictAction(toastBtn.dataset.toastAction, toastBtn.dataset.op);
        toastBtn.closest('.toast').remove();
      }
    });

    // 任何引擎/总线变化都触发渲染（轻量，足够演示用）
    Engine.subscribe(() => renderAll());
    Bus.on('TOAST', (payload) => UI.showToast(payload));
    Bus.on('SIM_OFFLINE', () => renderHeader());

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) renderAll();
    });
  }

  function bootstrapDom() {
    els.netDot = $('#net-dot');
    els.netText = $('#net-text');
    els.leaderText = $('#leader-text');
    els.queueSummary = $('#queue-summary');
    els.offlineToggle = $('#offline-toggle');
    els.userSelect = $('#user-select');
    els.injectEntity = $('#inject-entity');
    els.injectBtn = $('#inject-btn');
    els.resetBtn = $('#reset-btn');
    els.queueBody = $('#queue-body');

    UI.USERS.forEach((user) => {
      const opt = document.createElement('option');
      opt.value = user.id;
      opt.textContent = user.name;
      els.userSelect.appendChild(opt);
    });
    els.userSelect.value = currentUser().id;

    UI.FORMS.forEach((form) => {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = UI.renderFormCard(form, { data: {}, pending: [], conflict: [], pendingCount: 0, conflictCount: 0, serverVersion: null });
      $('#forms').appendChild(wrapper.firstElementChild);
      const entityOpt = document.createElement('option');
      entityOpt.value = form.entityId;
      entityOpt.textContent = form.title.split('·')[1].trim();
      els.injectEntity.appendChild(entityOpt);
    });
  }

  async function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    try {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const simOffline = localStorage.getItem('simOffline') === '1';
      if (simOffline) {
        els.offlineToggle.checked = true;
        Bus.emit('SIM_OFFLINE', { offline: true });
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: 'OFFLINE_MODE', offline: true });
        }
      }
    } catch (err) {
      console.warn('SW 注册失败（不影响 IndexedDB 持久化）', err);
    }
  }

  async function main() {
    bootstrapDom();
    bindEvents();
    await registerSW();
    await Engine.start();
    await renderAll();
  }

  document.addEventListener('DOMContentLoaded', main);
})();
