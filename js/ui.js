/* UI 渲染：三个表单、全局队列、状态头部、可操作 Toast */
(function (global) {
  const USERS = [
    { id: 'user-a', name: '张三（用户 A）' },
    { id: 'user-b', name: '李四（用户 B）' },
  ];

  const FORMS = [
    {
      entityId: 'profile',
      title: '表单 1 · 个人资料',
      desc: '整体保存（冲突需手动选择回滚/强推）',
      kind: 'full',
      fields: [
        { key: 'displayName', label: '昵称', type: 'text', required: true },
        { key: 'email', label: '邮箱', type: 'email', required: true },
        { key: 'bio', label: '简介', type: 'textarea' },
      ],
    },
    {
      entityId: 'settings',
      title: '表单 2 · 偏好设置',
      desc: '字段级补丁（修改不同字段可自动合并冲突）',
      kind: 'patch',
      fields: [
        { key: 'theme', label: '主题', type: 'select', options: ['light', 'dark', 'system'] },
        { key: 'locale', label: '语言', type: 'select', options: ['zh-CN', 'en-US', 'ja-JP'] },
        { key: 'notifications', label: '邮件通知', type: 'checkbox' },
        { key: 'pageSize', label: '每页条数', type: 'number', min: 5, max: 100 },
      ],
    },
    {
      entityId: 'timesheet',
      title: '表单 3 · 工时填报',
      desc: '字段级补丁（高频提交，演示队列链式重放）',
      kind: 'patch',
      fields: [
        { key: 'date', label: '日期', type: 'date', required: true },
        { key: 'hours', label: '工时（小时）', type: 'number', min: 0, max: 24, step: 0.5, required: true },
        { key: 'project', label: '项目', type: 'text', required: true },
        { key: 'note', label: '备注', type: 'textarea' },
      ],
    },
  ];

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
    );
  }

  function statusBadge(view) {
    if (view.conflictCount > 0) return '<span class="badge badge-danger">冲突待处理</span>';
    if (view.pendingCount > 0) return `<span class="badge badge-warn">${view.pendingCount} 条待同步</span>`;
    return '<span class="badge badge-ok">已同步</span>';
  }

  function renderField(form, field, value) {
    const name = `${form.entityId}-${field.key}`;
    const safeVal = escapeHtml(value ?? '');
    const required = field.required ? 'required' : '';
    if (field.type === 'textarea') {
      return `<label>${field.label}<textarea name="${name}" data-key="${field.key}" rows="2">${safeVal}</textarea></label>`;
    }
    if (field.type === 'select') {
      const options = field.options
        .map((opt) => `<option value="${opt}" ${String(value) === opt ? 'selected' : ''}>${opt}</option>`)
        .join('');
      return `<label>${field.label}<select name="${name}" data-key="${field.key}">${options}</select></label>`;
    }
    if (field.type === 'checkbox') {
      return `<label class="checkbox"><input type="checkbox" name="${name}" data-key="${field.key}" ${
        value ? 'checked' : ''
      }> ${field.label}</label>`;
    }
    const attrs = [`name="${name}"`, `data-key="${field.key}"`, `value="${safeVal}"`, required];
    if (field.min !== undefined) attrs.push(`min="${field.min}"`);
    if (field.max !== undefined) attrs.push(`max="${field.max}"`);
    if (field.step !== undefined) attrs.push(`step="${field.step}"`);
    return `<label>${field.label}<input type="${field.type}" ${attrs.join(' ')}></label>`;
  }

  function renderFormCard(form, view) {
    const data = view.data || {};
    const fields = form.fields.map((field) => renderField(form, field, data[field.key])).join('');
    const ver = view.serverVersion === null ? '—' : `v${view.serverVersion}`;
    return `
      <section class="card form-card" id="card-${form.entityId}" data-entity="${form.entityId}">
        <header class="card-head">
          <div>
            <h2>${form.title}</h2>
            <p class="desc">${form.desc}</p>
          </div>
          <div class="card-side">
            ${statusBadge(view)}
            <span class="version">服务器版本 ${ver}</span>
          </div>
        </header>
        <form class="form-grid" data-entity="${form.entityId}">
          ${fields}
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">提交</button>
            <span class="form-hint" data-role="hint"></span>
          </div>
        </form>
        <div class="mini-queue" data-role="mini-queue"></div>
      </section>`;
  }

  function renderMiniQueue(view) {
    const ops = [...view.pending, ...view.conflict];
    if (ops.length === 0) return '<p class="empty">无待处理操作</p>';
    return ops
      .map((op) => {
        const cls = op.status === 'conflict' ? 'op-item op-danger' : 'op-item';
        const meta =
          op.status === 'conflict'
            ? `冲突：${escapeHtml(op.lastError?.message || '版本不一致')}`
            : op.status === 'sending'
              ? '同步中…'
              : op.lastError
                ? `等待重试（${escapeHtml(op.lastError.stage)}）`
                : '排队中';
        return `<div class="${cls}">
          <span class="op-title">${escapeHtml(op.userName || op.userId)} 的提交</span>
          <span class="op-meta">${meta}</span>
        </div>`;
      })
      .join('');
  }

  function readFormValues(formEl) {
    const values = {};
    formEl.querySelectorAll('[data-key]').forEach((input) => {
      const key = input.dataset.key;
      if (input.type === 'checkbox') values[key] = input.checked;
      else if (input.type === 'number') values[key] = input.value === '' ? '' : Number(input.value);
      else values[key] = input.value;
    });
    return values;
  }

  function validate(form, values) {
    for (const field of form.fields) {
      if (!field.required) continue;
      const value = values[field.key];
      if (value === '' || value === undefined || value === null) {
        return `字段「${field.label}」不能为空`;
      }
      if (field.type === 'number' && field.min !== undefined && Number(value) < field.min) {
        return `字段「${field.label}」不能小于 ${field.min}`;
      }
    }
    return null;
  }

  /* ---------- 全局队列面板 ---------- */

  const STATUS_TEXT = {
    queued: '排队中',
    sending: '同步中',
    conflict: '冲突',
    done: '已完成',
  };

  function renderQueuePanel(groups) {
    const all = groups.flat();
    if (all.length === 0) {
      return '<p class="empty">队列已清空 —— 所有表单均已与服务器一致</p>';
    }
    return all
      .map((op) => {
        const isConflict = op.status === 'conflict';
        const actions = isConflict
          ? `<span class="queue-actions">
              <button class="btn btn-mini" data-conflict-action="rollback" data-op="${op.id}">回滚</button>
              <button class="btn btn-mini" data-conflict-action="retry" data-op="${op.id}">重试</button>
              <button class="btn btn-mini btn-warn" data-conflict-action="force" data-op="${op.id}">强制覆盖</button>
            </span>`
          : '';
        return `<div class="queue-row ${isConflict ? 'row-danger' : ''}">
          <span class="q-form">${escapeHtml(op.formId)}</span>
          <span class="q-user">${escapeHtml(op.userName || op.userId)}</span>
          <span class="q-status q-${op.status}">${STATUS_TEXT[op.status] || op.status}${
            op.attempts ? ` ×${op.attempts}` : ''
          }</span>
          <span class="q-err">${escapeHtml(op.lastError?.message || '')}</span>
          ${actions}
        </div>`;
      })
      .join('');
  }

  /* ---------- Toast ---------- */

  function showToast(toast) {
    const container = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = `toast toast-${toast.type}`;
    const actions = (toast.actions || [])
      .map(
        (action) =>
          `<button class="btn btn-mini" data-toast-action="${action.action}" data-op="${action.opId}">${action.label}</button>`
      )
      .join('');
    el.innerHTML = `
      <div class="toast-body">
        <strong>${escapeHtml(toast.title)}</strong>
        <p>${escapeHtml(toast.detail || '')}</p>
      </div>
      <div class="toast-actions">${actions}<button class="btn btn-mini btn-ghost" data-toast-close>×</button></div>`;
    container.appendChild(el);
    const ttl = toast.type === 'error' ? 12000 : 5000;
    const timer = setTimeout(() => el.remove(), ttl);
    el.querySelector('[data-toast-close]').addEventListener('click', () => {
      clearTimeout(timer);
      el.remove();
    });
  }

  global.UI = {
    USERS,
    FORMS,
    renderFormCard,
    renderMiniQueue,
    renderQueuePanel,
    readFormValues,
    validate,
    showToast,
    escapeHtml,
  };
})(window);
