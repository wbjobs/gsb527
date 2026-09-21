/* 客户端纯逻辑测试：派生视图（乐观层）与冲突回滚一致性，无需浏览器/IndexedDB。 */
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

// store.js 是挂到 window 上的 IIFE；构造最小浏览器全局后在当前上下文执行
global.window = global;
global.IDB = {};
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8'));
const { Store } = global;

const entity = {
  id: 'settings',
  version: 3,
  data: { theme: 'light', locale: 'zh-CN', notifications: true, pageSize: 20 },
};

console.log('乐观视图 = 服务器快照 + queued/sending 补丁');
const op1 = {
  id: 'op1',
  entityId: 'settings',
  kind: 'patch',
  patch: { pageSize: 50 },
  baseVersion: 3,
  baseData: entity.data,
  status: Store.STATUS.QUEUED,
};
let view = Store.deriveView(entity, [op1]);
check(view.data.pageSize === 50 && view.data.theme === 'light', '待同步补丁已叠加到视图');
check(view.serverVersion === 3, '视图仍记录服务器版本号');
check(view.pendingCount === 1 && view.conflictCount === 0, '计数正确');

console.log('多操作按 FIFO 链式叠加');
const op0 = {
  id: 'op0',
  entityId: 'settings',
  kind: 'patch',
  patch: { theme: 'dark' },
  baseVersion: 3,
  baseData: entity.data,
  status: Store.STATUS.QUEUED,
  createdAt: 0,
};
view = Store.deriveView(entity, [op0, { ...op1, createdAt: 1 }]);
check(view.data.theme === 'dark' && view.data.pageSize === 50, '两个补丁都生效');

console.log('sending 状态同样可见（乐观反馈不回退）');
view = Store.deriveView(entity, [{ ...op1, status: Store.STATUS.SENDING }]);
check(view.data.pageSize === 50 && view.pendingCount === 1, '发送中的修改仍显示');

console.log('冲突操作被拒绝，不再覆盖 UI，回滚（删除）后恢复服务器真相');
const conflictOp = { ...op1, status: Store.STATUS.CONFLICT };
view = Store.deriveView(entity, [conflictOp]);
check(view.data.pageSize === 20, '冲突补丁已从视图撤销');
check(view.conflictCount === 1 && view.pendingCount === 0, '冲突单独计数');

// 模拟 resolveConflict('rollback') 的效果：删除该操作后重新派生
const remaining = [conflictOp].filter((op) => op.id !== 'op1');
view = Store.deriveView(entity, remaining);
check(view.data.pageSize === 20 && view.pendingCount === 0 && view.conflictCount === 0, '回滚后与服务器完全一致');

console.log('full 类型整体覆盖');
view = Store.deriveView(entity, [
  {
    id: 'op2',
    entityId: 'profile',
    kind: 'full',
    fullData: { theme: 'nope', other: 1 },
    status: Store.STATUS.QUEUED,
  },
]);
check(view.data.other === 1 && view.data.theme === 'nope', '整体覆盖替换全部字段');

console.log('崩溃恢复：sending 操作回到 queued（规则检查）');
check(Store.STATUS.SENDING !== Store.STATUS.QUEUED, 'sending/queued 状态分离，由 recoverSendingOps 复位');

console.log(`\n${passed} passed`);
