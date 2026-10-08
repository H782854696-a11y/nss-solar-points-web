'use strict';

// 2026-10-08 审计 M-2：积分系统死代码已物理删除（约 1050 行退役路由 + 8 个 lib 模块）。
// 本文件钉死「退役」这件事本身：退役端点必须返回 410（而不是 404 或意外复活），
// 且活接口不受影响。若有人误删 410 中间件或误加回路由，这里会立刻变红。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const initialPassword = 'RetiredProbePass2026!!';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

test('retired points endpoints stay retired (410) and live endpoints unaffected', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-retired-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SP_DATA_DIR: dataDir, SP_ADMIN_PASSWORD: initialPassword, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', c => { output += String(c); });
  child.stderr.on('data', c => { output += String(c); });
  t.after(() => { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { const r = await fetch(base + '/'); if (r.ok) ready = true; } catch (e) { /* 未就绪 */ }
    if (!ready) await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(ready, true, `server did not start: ${output.slice(-300)}`);

  const retired = [
    ['GET', '/api/members'],
    ['GET', '/api/members/anything'],
    ['POST', '/api/members'],
    ['GET', '/api/pending'],
    ['GET', '/api/products'],
    ['GET', '/api/redemptions'],
    ['GET', '/api/rules'],
    ['PUT', '/api/rules'],
    ['GET', '/api/dashboard'],
    ['GET', '/api/reports/overview'],
    ['GET', '/api/transactions'],
    ['GET', '/api/sheets/status'],
    ['POST', '/api/public/points-lookup'],
    ['GET', '/check'],
  ];
  for (const [method, url] of retired) {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    const body = await r.json().catch(() => null);
    assert.equal(r.status, 410, `${method} ${url} must stay retired (410), got ${r.status}`);
    assert.match(body && body.error || '', /已下线/, `${method} ${url} should explain retirement`);
  }

  // 活接口不受影响：未登录 401（而不是 410/404），登录页可访问
  const live = await fetch(base + '/api/v2/tasks');
  assert.equal(live.status, 401, 'live API must still be gated by auth (401), got ' + live.status);
  const home = await fetch(base + '/');
  assert.equal(home.status, 200, 'home page must still serve');
});
