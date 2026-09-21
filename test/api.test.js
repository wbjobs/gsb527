/* 服务器语义测试（进程内构造 req/res，无需监听端口）：
 * 乐观锁冲突、字段级自动合并、补偿覆盖、参数校验、重置。 */
const assert = require('assert');
const { requestHandler } = require('../server');

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ✓ ${message}`);
}

function callApi(method, urlPath, body) {
  const chunks = [];
  const req = {
    method,
    url: urlPath,
    headers: { host: 'localhost' },
    on(event, cb) {
      if (event === 'end') setImmediate(cb);
      if (event === 'data' && body) setImmediate(() => cb(Buffer.from(JSON.stringify(body))));
    },
  };
  const res = {
    statusCode: 200,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
    },
  };
  return new Promise((resolve) => {
    res.end = ((original) =>
      function (...args) {
        original.apply(this, args);
        resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
      })(res.end);
    requestHandler(req, res);
  });
}

async function main() {
  console.log('乐观锁：版本落后返回 409');
  let profile = (await callApi('GET', '/api/entities/profile')).json;
  const stale = await callApi('PATCH', '/api/entities/profile', {
    userId: 'user-a',
    baseVersion: profile.version - 1,
    fullData: { ...profile.data, displayName: '过期版本' },
  });
  check(stale.status === 409, '旧版本提交被拒绝 (409)');
  check(stale.json.server && stale.json.server.version === profile.version, '409 响应携带服务器当前实体');

  console.log('正常提交：版本 +1');
  const ok = await callApi('PATCH', '/api/entities/profile', {
    userId: 'user-a',
    baseVersion: profile.version,
    fullData: { ...profile.data, displayName: '新名字' },
  });
  check(ok.status === 200 && ok.json.version === profile.version + 1, '提交成功后版本递增');
  check(ok.json.data.displayName === '新名字', '数据已更新');
  check(ok.json.updatedBy === 'user-a', '记录提交用户');

  console.log('字段级自动合并：不同字段无冲突');
  let settings = (await callApi('GET', '/api/entities/settings')).json;
  const base = settings.data;
  const serverFirst = await callApi('PATCH', '/api/entities/settings', {
    userId: 'other',
    baseVersion: settings.version,
    mergeStrategy: 'merge',
    baseData: base,
    patch: { theme: 'dark' },
  });
  check(serverFirst.status === 200, '他人先提交 theme=dark 成功');
  const merged = await callApi('PATCH', '/api/entities/settings', {
    userId: 'user-b',
    baseVersion: settings.version,
    mergeStrategy: 'merge',
    baseData: base,
    patch: { pageSize: 50 },
  });
  check(merged.status === 200, '不同字段的并发修改自动合并成功');
  check(merged.json.data.theme === 'dark' && merged.json.data.pageSize === 50, '合并同时保留双方修改');

  console.log('字段级自动合并：同字段冲突返回 409 并指出冲突字段');
  settings = (await callApi('GET', '/api/entities/settings')).json;
  const clash = await callApi('PATCH', '/api/entities/settings', {
    userId: 'user-b',
    baseVersion: settings.version - 1,
    mergeStrategy: 'merge',
    baseData: { ...settings.data, theme: 'light' },
    patch: { theme: 'system' },
  });
  check(clash.status === 409, '同字段冲突被拒绝');
  check((clash.json.conflictFields || []).includes('theme'), '响应指出冲突字段 theme');

  console.log('强制覆盖（补偿写）：基于最新版本提交 fullData');
  const forced = await callApi('PATCH', '/api/entities/settings', {
    userId: 'user-b',
    baseVersion: settings.version,
    fullData: { ...settings.data, theme: 'system' },
  });
  check(forced.status === 200 && forced.json.data.theme === 'system', '强制覆盖成功');

  console.log('校验与重置');
  const bad = await callApi('PATCH', '/api/entities/timesheet', { userId: 'u', patch: { hours: 3 } });
  check(bad.status === 400, '缺少 baseVersion 被拦截');
  const missing = await callApi('GET', '/api/entities/nope');
  check(missing.status === 404, '未知实体返回 404');
  await callApi('POST', '/api/reset');
  profile = (await callApi('GET', '/api/entities/profile')).json;
  check(profile.data.displayName === '张三' && profile.version === 1, '重置后种子数据还原');

  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
