/**
 * 零依赖 Node 静态服务器 + 模拟表单 API。
 * 实体带 version（乐观锁），PATCH 携带 expectedVersion：
 *   - 版本一致：合并补丁，version+1
 *   - 版本落后：409 conflict，并返回服务器当前实体
 * /api/_sim/offline?on=1 可让 Service Worker 之外的直连请求模拟网络故障。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const now = () => new Date().toISOString();

function seedData() {
  return {
    profile: {
      id: 'profile',
      version: 1,
      data: { displayName: '张三', email: 'zhangsan@example.com', bio: '前端工程师，关注离线优先应用。' },
      updatedAt: now(),
      updatedBy: 'server',
    },
    settings: {
      id: 'settings',
      version: 3,
      data: { theme: 'light', locale: 'zh-CN', notifications: true, pageSize: 20 },
      updatedAt: now(),
      updatedBy: 'server',
    },
    timesheet: {
      id: 'timesheet',
      version: 2,
      data: { date: now().slice(0, 10), hours: 8, project: '离线队列重构', note: '' },
      updatedAt: now(),
      updatedBy: 'server',
    },
  };
}

const db = seedData();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// 字段级三方合并：settings 使用。仅当本地修改的字段与服务端改动的字段不相交时可自动合并。
function threeWayMerge(baseData, serverData, localData) {
  const changedByServer = Object.keys(serverData).filter(
    (key) => JSON.stringify(baseData[key]) !== JSON.stringify(serverData[key])
  );
  const changedLocally = Object.keys(localData).filter(
    (key) => JSON.stringify(baseData[key]) !== JSON.stringify(localData[key])
  );
  const overlap = changedByServer.filter((key) => changedLocally.includes(key));
  if (overlap.length > 0) {
    return { merged: null, conflictFields: overlap };
  }
  return {
    merged: { ...serverData, ...Object.fromEntries(changedLocally.map((key) => [key, localData[key]])) },
    conflictFields: [],
  };
}

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // 故障注入：供测试脚本使用（页面自身的离线开关由 SW 处理）
  if (url.pathname === '/api/_sim/offline') {
    const on = url.searchParams.get('on') === '1';
    simOffline = on;
    return sendJson(res, 200, { simOffline });
  }

  if (url.pathname === '/api/reset' && req.method === 'POST') {
    Object.assign(db, seedData());
    return sendJson(res, 200, { ok: true });
  }

  if (seg[1] === 'entities' && seg[2]) {
    const entity = db[seg[2]];
    if (!entity) return sendJson(res, 404, { error: 'not_found' });
    if (req.method === 'GET') return sendJson(res, 200, entity);

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const expectedVersion = Number(body.baseVersion);
      if (!Number.isInteger(expectedVersion)) {
        return sendJson(res, 400, { error: 'bad_request', message: 'baseVersion 必填' });
      }
      const wantsMerge = body.mergeStrategy === 'merge' && body.baseData && body.patch && typeof body.patch === 'object';

      let mergedData = null;
      if (entity.version === expectedVersion) {
        if (body.fullData && typeof body.fullData === 'object') mergedData = body.fullData;
        else if (body.patch && typeof body.patch === 'object') mergedData = { ...entity.data, ...body.patch };
        else mergedData = entity.data;
      } else if (wantsMerge) {
        // 版本落后但请求字段级合并：对「共同基线 / 服务器最新 / 本地最新」做三方合并
        const localData = { ...body.baseData, ...body.patch };
        const result = threeWayMerge(body.baseData, entity.data, localData);
        if (!result.merged) {
          return sendJson(res, 409, {
            error: 'conflict',
            message: `字段冲突，无法自动合并：${result.conflictFields.join(', ')}（本地基于 v${expectedVersion}，服务器当前 v${entity.version}）`,
            server: entity,
            conflictFields: result.conflictFields,
          });
        }
        mergedData = result.merged;
      } else {
        return sendJson(res, 409, {
          error: 'conflict',
          message: `版本冲突：本地基于 v${expectedVersion}，服务器当前 v${entity.version}`,
          server: entity,
        });
      }
      entity.data = mergedData;
      entity.version += 1;
      entity.updatedAt = now();
      entity.updatedBy = body.userId || 'anonymous';
      return sendJson(res, 200, entity);
    }
  }

  sendJson(res, 404, { error: 'not_found' });
}

let simOffline = false;

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    });
    res.end(content);
  });
}

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (simOffline) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'network_unavailable' }));
      }
      return await handleApi(req, res, url);
    }
    serveStatic(req, res, url);
  } catch (err) {
    sendJson(res, 500, { error: 'server_error', message: err.message });
  }
}

const server = http.createServer(requestHandler);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`offline-forms demo: http://localhost:${PORT}`);
  });
}

module.exports = { requestHandler };
