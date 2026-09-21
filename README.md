# 离线表单提交、队列重放与冲突补偿 Demo

一个无框架前端演示，使用 IndexedDB、Service Worker 和 BroadcastChannel 实现多表单离线提交、恢复后自动重放、多用户版本冲突检测，以及乐观更新回滚与补偿记录。

## 运行

```bash
npm start
```

打开 `http://localhost:8123`。运行测试：

```bash
npm test
```

Service Worker 只能在 `localhost` 或 HTTPS 下注册，不要直接双击打开 `index.html`。

## 验收路径

1. 点击“模拟离线”。
2. 在任意表单修改字段并提交，队列会立即显示乐观状态。
3. 刷新页面，IndexedDB 中的队列仍在。
4. 离线状态点击“模拟其他用户编辑”，让本地缓存仍停留在旧版本而服务端版本前进。
5. 点击“恢复在线”，队列自动重放。
6. 不同字段被修改时自动三方合并；同一字段被双方修改时回滚乐观更新并显示解决方案。
7. 选择“保留本地”“采用服务端”或输入自定义值后继续重放；也可丢弃并回滚。
8. 在“全局异常注入”中选择 500 或 400；500 自动退避重试，400 会回滚并允许直接修正表单后重新提交。

## 核心设计

- 页面持久化数据库：`offline-forms-db`
  - `outbox`：离线队列，状态包括 `queued`、`flushing`、`conflict`、`failed`。
  - `serverState`：最近一次拉取到的服务端快照。
  - `compensations`：冲突或永久失败时的回滚补偿记录。
  - `events`：异常链路和用户可见提示。
- Service Worker 模拟服务端数据库：`offline-forms-server`
  - 保存服务端版本和当前数据。
  - PATCH 使用 `expectedVersion` 做乐观锁。
  - 使用 `idempotencyKey` 防止刷新、重试或网络不确定时重复提交。
  - 拦截静态资源并缓存 App Shell，离线刷新仍可打开页面。
- 队列重放
  - 每个表单独立队列、独立锁，表单 A 阻塞不会影响表单 B。
  - 同一表单严格按创建时间提交。
  - 页面刷新时将残留 `flushing` 恢复为 `queued`，由幂等键保证安全。
  - 5xx/网络错误保留队列并指数退避；4xx 永久错误触发失败与回滚，修正后用同一队列位置安全重提。
- 冲突合并
  - 基于 `baseSnapshot`、本地 `changes`、服务端当前值做三方比较。
  - 非重叠字段自动合并；同字段双方修改进入 `conflict`。
  - 冲突后 UI 立即回到服务端值，后续同表单队列暂停，避免错误状态继续传播。
- 多标签页反馈
  - BroadcastChannel 广播队列、冲突、回滚和网络状态。
  - Web Locks 保证同一表单在多个标签页中只有一个重放执行者。

## 关键文件

- `sw.js`：App Shell 缓存和模拟 REST 服务端。
- `src/db.js`：IndexedDB 封装和队列存储。
- `src/sync.js`：入队、重放、退避、冲突处理、补偿和广播。
- `src/merge.js`：纯函数三方合并与乐观数据投影。
- `src/app.js`：表单、队列、异常链路和冲突解决 UI。
- `test/merge.test.js`：字段合并、冲突阻断和投影测试。

## 重置演示数据

浏览器 DevTools 的 Application 中删除：

- IndexedDB `offline-forms-db`
- IndexedDB `offline-forms-server`
- Service Worker 与 Cache Storage `offline-forms-v1`

然后刷新页面即可恢复初始数据。
