'use strict';

// 当日存款凭证：店长必须上传真实 JPG/PNG，管理人员可安全查看。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const initialPassword = 'DailyDepositInitial2026!';
const changedPassword = 'DailyDepositChanged2026!';
const managerPassword = 'DailyDepositManager2026!';
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

test('daily deposit receipt is reviewed in a confirm/reject flow and rejected receipts can be resubmitted', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-daily-deposit-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SP_DATA_DIR: dataDir, SP_ADMIN_PASSWORD: initialPassword, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
  t.after(() => { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  async function request(method, url, body, cookie = '') {
    const response = await fetch(base + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const contentType = response.headers.get('content-type') || '';
    return { status: response.status, data: contentType.includes('application/json') ? await response.json() : null, body: contentType.startsWith('image/') ? Buffer.from(await response.arrayBuffer()) : null, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
  }
  let ready = false;
  for (let i = 0; i < 50 && !ready; i += 1) { try { ready = (await fetch(base + '/')).ok; } catch {} if (!ready) await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(ready, true, `server did not start: ${output.slice(-400)}`);

  const firstLogin = await request('POST', '/api/auth/login', { username: 'admin', password: initialPassword });
  assert.equal(firstLogin.status, 200);
  assert.equal((await request('POST', '/api/auth/change-password', { currentPassword: initialPassword, newPassword: changedPassword, confirmPassword: changedPassword }, firstLogin.cookie)).status, 200);
  const admin = (await request('POST', '/api/auth/login', { username: 'admin', password: changedPassword })).cookie;
  const stores = await request('GET', '/api/stores', null, admin);
  const storeId = stores.data.items[0].id;
  const createdManager = await request('POST', '/api/v2/users', { username: 'deposit_manager', password: managerPassword, name: '存款店长', role: 'manager', storeId }, admin);
  assert.equal(createdManager.status, 201, JSON.stringify(createdManager.data));
  const manager = (await request('POST', '/api/auth/login', { username: 'deposit_manager', password: managerPassword })).cookie;

  assert.equal((await request('POST', `/api/v2/daily-deposits/${storeId}/confirm`, {}, manager)).status, 400, 'receipt is required');
  assert.equal((await request('POST', `/api/v2/daily-deposits/${storeId}/confirm`, { receipt: { fileName: 'fake.png', mimeType: 'image/png', data: 'data:image/png;base64,ZXhl' } }, manager)).status, 400, 'fake PNG is rejected');
  const confirmed = await request('POST', `/api/v2/daily-deposits/${storeId}/confirm`, { receipt: { fileName: 'bank-receipt.png', mimeType: 'image/png', data: tinyPng } }, manager);
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.data));
  assert.equal(confirmed.data.item.status, 'pending_review');
  assert.equal(confirmed.data.item.receipt.name, 'bank-receipt.png');
  assert.equal(Object.hasOwn(confirmed.data.item.receipt, 'storedName'), false, 'internal storage name is never exposed');
  const list = await request('GET', '/api/v2/daily-deposits', null, admin);
  assert.equal(list.data.items.find(x => x.storeId === storeId).status, 'pending_review');
  assert.equal(list.data.items.find(x => x.storeId === storeId).receipt.mimeType, 'image/png');
  const receipt = await request('GET', `/api/v2/daily-deposits/${storeId}/receipt`, null, admin);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), true, 'viewer receives the stored PNG');
  assert.equal((await request('POST', `/api/v2/daily-deposits/${storeId}/review`, { decision: 'confirmed' }, manager)).status, 403, 'store manager cannot review own receipt');
  assert.equal((await request('POST', `/api/v2/daily-deposits/${storeId}/review`, { decision: 'rejected' }, admin)).status, 400, 'a rejection reason is required');
  const rejected = await request('POST', `/api/v2/daily-deposits/${storeId}/review`, { decision: 'rejected', reason: 'Receipt is incomplete' }, admin);
  assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
  assert.equal(rejected.data.item.status, 'rejected');
  assert.equal(rejected.data.item.rejectionReason, 'Receipt is incomplete');
  const resubmitted = await request('POST', `/api/v2/daily-deposits/${storeId}/confirm`, { receipt: { fileName: 'corrected-receipt.png', mimeType: 'image/png', data: tinyPng } }, manager);
  assert.equal(resubmitted.status, 201, JSON.stringify(resubmitted.data));
  assert.equal(resubmitted.data.item.status, 'pending_review');
  assert.equal(resubmitted.data.item.submissionCount, 2);
  const reviewed = await request('POST', `/api/v2/daily-deposits/${storeId}/review`, { decision: 'confirmed' }, admin);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
  assert.equal(reviewed.data.item.status, 'confirmed');
  assert.ok(reviewed.data.item.reviewedByName, 'the reviewer identity is recorded');
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'dailyDeposits.json'), 'utf8'))[0];
  assert.equal(persisted.receiptHistory.length, 1, 'old receipt metadata is retained instead of deleting uploaded evidence');
});
