'use strict';

// The compatible rollback candidate must continue to operate on records that
// the review workflow has already written.  This test deliberately uses only
// a disposable SP_DATA_DIR and does not depend on production data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const initialPassword = 'RollbackInitial2026!';
const adminPassword = 'RollbackAdmin2026!';
const managerPassword = 'RollbackManager2026!';
const resetManagerPassword = 'RollbackManagerReset2026!';
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('rollback candidate preserves legacy and review-workflow deposit continuity', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-rollback-compat-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SP_DATA_DIR: dataDir, SP_ADMIN_PASSWORD: initialPassword, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  t.after(() => { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  async function request(method, endpoint, body, cookie = '') {
    const response = await fetch(base + endpoint, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const contentType = response.headers.get('content-type') || '';
    return {
      status: response.status,
      data: contentType.includes('application/json') ? await response.json() : null,
      bytes: contentType.startsWith('image/') ? (await response.arrayBuffer()).byteLength : 0,
      cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
    };
  }
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt += 1) {
    try { ready = (await fetch(base + '/')).ok; } catch {}
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, `server did not start: ${output.slice(-400)}`);

  const initialLogin = await request('POST', '/api/auth/login', { username: 'admin', password: initialPassword });
  assert.equal(initialLogin.status, 200);
  assert.equal(initialLogin.data.user.mustChangePassword, true);
  assert.equal((await request('POST', '/api/auth/change-password', { currentPassword: initialPassword, newPassword: adminPassword, confirmPassword: adminPassword }, initialLogin.cookie)).status, 200);
  const admin = (await request('POST', '/api/auth/login', { username: 'admin', password: adminPassword })).cookie;
  const storeId = (await request('GET', '/api/stores', null, admin)).data.items[0].id;
  const created = await request('POST', '/api/v2/users', { username: 'rollback_manager', password: managerPassword, name: 'Rollback manager', role: 'manager', storeId }, admin);
  assert.equal(created.status, 201);
  const managerId = created.data.item.id;
  const manager = (await request('POST', '/api/auth/login', { username: 'rollback_manager', password: managerPassword })).cookie;

  const firstSubmission = await request('POST', `/api/v2/daily-deposits/${storeId}/confirm`, { receipt: { fileName: 'receipt-one.png', mimeType: 'image/png', data: tinyPng } }, manager);
  assert.equal(firstSubmission.status, 201);
  assert.equal(firstSubmission.data.item.status, 'pending_review');
  assert.equal((await request('POST', `/api/v2/daily-deposits/${storeId}/confirm`, { receipt: { fileName: 'duplicate.png', mimeType: 'image/png', data: tinyPng } }, manager)).status, 409);
  assert.equal((await request('POST', `/api/v2/daily-deposits/${storeId}/review`, { decision: 'confirmed' }, manager)).status, 403);
  assert.equal((await request('GET', `/api/v2/daily-deposits/${storeId}/receipt`, null, admin)).status, 200);

  const rejected = await request('POST', `/api/v2/daily-deposits/${storeId}/review`, { decision: 'rejected', reason: 'offline regression test' }, admin);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.item.status, 'rejected');
  const resubmitted = await request('POST', `/api/v2/daily-deposits/${storeId}/confirm`, { receipt: { fileName: 'receipt-two.png', mimeType: 'image/png', data: tinyPng } }, manager);
  assert.equal(resubmitted.status, 201);
  assert.equal(resubmitted.data.item.status, 'pending_review');
  assert.equal(resubmitted.data.item.submissionCount, 2);
  const confirmed = await request('POST', `/api/v2/daily-deposits/${storeId}/review`, { decision: 'confirmed' }, admin);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.item.status, 'confirmed');
  assert.equal((await request('GET', `/api/v2/daily-deposits/${storeId}/receipt`, null, admin)).status, 200);

  // A legacy persisted record is read as confirmed, without a data migration.
  const depositsPath = path.join(dataDir, 'dailyDeposits.json');
  const persisted = JSON.parse(fs.readFileSync(depositsPath, 'utf8'));
  assert.equal(persisted[0].receiptHistory.length, 1);
  persisted[0].status = 'reported';
  fs.writeFileSync(depositsPath, JSON.stringify(persisted, null, 2));
  const listed = await request('GET', '/api/v2/daily-deposits', null, admin);
  assert.equal(listed.data.items.find(item => item.storeId === storeId).status, 'confirmed');

  const reset = await request('POST', `/api/users/${managerId}/reset-password`, { newPassword: resetManagerPassword }, admin);
  assert.equal(reset.status, 200);
  const resetLogin = await request('POST', '/api/auth/login', { username: 'rollback_manager', password: resetManagerPassword });
  assert.equal(resetLogin.status, 200);
  assert.equal(resetLogin.data.user.mustChangePassword, true);
});
