export const forms = [
  {
    id: 'announcement',
    title: '公告表单',
    description: '多个用户协同维护同一份公告',
    entity: { type: 'form', id: 'announcement' },
    fields: [
      { name: 'title', label: '标题', type: 'text', placeholder: '公告标题' },
      { name: 'content', label: '内容', type: 'textarea', placeholder: '公告内容' }
    ],
    initial: { title: '版本发布计划', content: '请在此填写发布说明' }
  },
  {
    id: 'inventory',
    title: '库存表单',
    description: '验证不同表单的队列、失败和重试互不干扰',
    entity: { type: 'form', id: 'inventory' },
    fields: [
      { name: 'product', label: '商品', type: 'text', placeholder: '商品名称' },
      { name: 'quantity', label: '数量', type: 'number', placeholder: '0' },
      { name: 'available', label: '可售', type: 'checkbox' }
    ],
    initial: { product: '机械键盘', quantity: 12, available: true }
  },
  {
    id: 'handoff',
    title: '交接表单',
    description: '字段级合并；不同字段可自动合并',
    entity: { type: 'form', id: 'handoff' },
    fields: [
      { name: 'owner', label: '负责人', type: 'text', placeholder: '负责人' },
      { name: 'shift', label: '班次', type: 'select', options: ['早班', '中班', '晚班'] },
      { name: 'note', label: '备注', type: 'textarea', placeholder: '交接备注' }
    ],
    initial: { owner: '王芳', shift: '早班', note: '例行巡检' }
  }
];

export const formMap = new Map(forms.map((form) => [form.id, form]));

export function normalizeValue(field, value) {
  if (field.type === 'checkbox') return Boolean(value);
  if (field.type === 'number') return value === '' ? '' : Number(value);
  return String(value ?? '');
}

export function readFormData(form, formElement) {
  return Object.fromEntries(
    form.fields.map((field) => {
      const input = formElement.elements[field.name];
      if (field.type === 'checkbox') return [field.name, input.checked];
      return [field.name, normalizeValue(field, input.value)];
    })
  );
}

export function diffChanges(form, previous, next) {
  const changes = {};
  for (const field of form.fields) {
    const previousValue = normalizeValue(field, previous[field.name]);
    const nextValue = normalizeValue(field, next[field.name]);
    if (previousValue !== nextValue) changes[field.name] = nextValue;
  }
  return changes;
}
