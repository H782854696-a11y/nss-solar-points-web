'use strict';

// 采购跟单 API 回归（2026-10-07 新功能）
// 覆盖：角色权限隔离、七阶段状态机、阶段不可倒退、校验与附件。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const initialPassword = 'LocalOnlyInitialPassword2026!';
const changedPassword = 'LocalOnlyChangedPassword2026!';
const purchaserPassword = 'LocalOnlyPurchaserPassword2026!';
const purchaserChanged = 'LocalOnlyPurchaserChanged2026!';
const storeManagerPassword = 'LocalOnlyStoreManagerPass26!';
const storeManagerChanged = 'LocalOnlyStoreManagerChg26!';
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=';

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

test('purchaser role, shipping stage machine and stock are correctly scoped', { timeout: 40000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-v2-purchase-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SP_DATA_DIR: dataDir, SP_ADMIN_PASSWORD: initialPassword, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  t.after(() => { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  async function raw(method, url, body, cookie = '') {
    const response = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
  }
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { const r = await fetch(base + '/'); if (r.ok) ready = true; } catch (e) { /* 还没起来 */ }
    if (!ready) await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(ready, true, `server did not start: ${output.slice(-400)}`);

  const adminLogin = await raw('POST', '/api/auth/login', { username: 'admin', password: initialPassword });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.data));
  assert.equal(adminLogin.data.user?.mustChangePassword, true, 'a fresh administrator must change the temporary password');
  // 首次登录必须先改密，否则后续管理操作都会被拒（会话在改密前不具备管理能力）
  const adminRotated = await raw('POST', '/api/auth/change-password', { currentPassword: initialPassword, newPassword: changedPassword, confirmPassword: changedPassword }, adminLogin.cookie);
  assert.equal(adminRotated.status, 200, JSON.stringify(adminRotated.data));
  const adminReLogin = await raw('POST', '/api/auth/login', { username: 'admin', password: changedPassword });
  const admin = adminReLogin.cookie;
  const adminMe = await raw('GET', '/api/auth/me', null, admin);
  assert.ok(adminMe.data.grants.some(g => g.p === 'purchase.view'), 'administrator can view shipments');
  assert.ok(adminMe.data.grants.some(g => g.p === 'purchase.edit'), 'administrator can edit shipments');
  // 采购角色必须在服务端白名单里，否则建不出采购员账号
  const stores = await raw('GET', '/api/stores', null, admin);
  const storeId = stores.data.items?.[0]?.id || null;

  // ── 建立采购员与店长两个账号，验证权限隔离 ──
  const purchaser = await raw('POST', '/api/v2/users', { username: 'buyer1', password: purchaserPassword, name: '采购员', role: 'purchaser' }, admin);
  assert.equal(purchaser.status, 201, JSON.stringify(purchaser.data));
  const storeManager = await raw('POST', '/api/v2/users', { username: 'smgr_p', password: storeManagerPassword, name: '店长', role: 'manager', storeId }, admin);
  assert.equal(storeManager.status, 201, JSON.stringify(storeManager.data));

  async function loginAndRotate(username, password, next) {
    const first = await raw('POST', '/api/auth/login', { username, password });
    assert.equal(first.status, 200, `${username} login: ${JSON.stringify(first.data)}`);
    let cookie = first.cookie;
    if (first.data.user?.mustChangePassword) {
      const changed = await raw('POST', '/api/auth/change-password', { currentPassword: password, newPassword: next, confirmPassword: next }, cookie);
      assert.equal(changed.status, 200, `${username} change password: ${JSON.stringify(changed.data)}`);
      const again = await raw('POST', '/api/auth/login', { username, password: next });
      cookie = again.cookie;
    }
    return cookie;
  }
  const buyerCookie = await loginAndRotate('buyer1', purchaserPassword, purchaserChanged);
  const managerCookie = await loginAndRotate('smgr_p', storeManagerPassword, storeManagerChanged);

  // 采购员持有三项采购权限
  const buyerMe = await raw('GET', '/api/auth/me', null, buyerCookie);
  const buyerGrants = (buyerMe.data.grants || []).map(g => g.p);
  assert.ok(buyerGrants.includes('purchase.view') && buyerGrants.includes('purchase.create') && buyerGrants.includes('purchase.edit'), 'purchaser holds view/create/edit');
  // 采购员不得因此获得审批、审计、门店等能力
  for (const forbidden of ['workflow.create', 'workflow.approve', 'system.audit.view', 'store.create', 'store.delete']) {
    assert.equal(buyerGrants.includes(forbidden), false, `purchaser must not gain ${forbidden}`);
  }
  // 店长看不到采购
  const managerMe = await raw('GET', '/api/auth/me', null, managerCookie);
  assert.equal((managerMe.data.grants || []).some(g => g.p.startsWith('purchase')), false, 'store manager has no purchase permission');

  // ── 新建批次：必填与阶段校验 ──
  assert.equal((await raw('POST', '/api/v2/purchase-shipments', { supplier: 'X' }, buyerCookie)).status, 400, 'order number is required');
  assert.equal((await raw('POST', '/api/v2/purchase-shipments', { orderNo: 'PO-1' }, buyerCookie)).status, 400, 'supplier is required');
  assert.equal((await raw('POST', '/api/v2/purchase-shipments', { orderNo: 'PO-1', supplier: 'S', stage: 'not_a_stage' }, buyerCookie)).status, 400, 'unknown stage rejected');
  assert.equal((await raw('POST', '/api/v2/purchase-shipments', { orderNo: 'PO-1', supplier: 'S', etd: '2026-13-45' }, buyerCookie)).status, 400, 'invalid calendar date rejected');
  assert.equal((await raw('POST', '/api/v2/purchase-shipments', { orderNo: 'PO-1', supplier: 'S', amount: -5 }, buyerCookie)).status, 400, 'negative amount rejected');

  const created = await raw('POST', '/api/v2/purchase-shipments', {
    type: 'purchase', orderNo: 'PO-2026-001', supplier: '隆基绿能', productName: 'PV module 550W',
    quantity: '500 pcs', amount: 186000, stage: 'ordered', etd: '2026-10-20', eta: '2026-11-05',
    vessel: 'COSCO ARIES', blNo: 'COSU6638291', containerNo: 'CSNU7742100',
    portOfLoading: '厦门', portOfDischarge: '马尼拉', note: 'first batch',
  }, buyerCookie);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.item.id;
  assert.equal(created.data.item.stage, 'ordered');
  assert.equal(created.data.item.stageHistory.length, 1, 'creation is recorded in the stage history');

  // 同订单号在途重复建单应冲突（分批需换后缀）
  assert.equal((await raw('POST', '/api/v2/purchase-shipments', { orderNo: 'PO-2026-001', supplier: 'S' }, buyerCookie)).status, 409, 'duplicate in-flight order number rejected');

  // ── 七阶段按序推进，每一步留痕 ──
  for (const stage of ['preparing', 'loaded', 'in_transit', 'arrived', 'customs', 'warehoused']) {
    const step = await raw('POST', `/api/v2/purchase-shipments/${id}`, { stage, stageNote: `moved to ${stage}` }, buyerCookie);
    assert.equal(step.status, 200, `${stage}: ${JSON.stringify(step.data)}`);
    assert.equal(step.data.item.stage, stage);
  }
  const afterAll = await raw('GET', '/api/v2/purchase-shipments', null, buyerCookie);
  assert.equal(afterAll.data.items.find(x => x.id === id).stageHistory.length, 7, 'every stage change is recorded (7 entries)');

  // 阶段不可倒退：已入库的批次不能改回在途
  const back = await raw('POST', `/api/v2/purchase-shipments/${id}`, { stage: 'in_transit' }, buyerCookie);
  assert.equal(back.status, 400, 'stage must not move backwards');
  // 同阶段重复提交允许（用于只改备注）
  assert.equal((await raw('POST', `/api/v2/purchase-shipments/${id}`, { note: 'signed off' }, buyerCookie)).status, 200, 'note-only update allowed');

  // ── 统计与筛选 ──
  const warehoused = await raw('GET', '/api/v2/purchase-shipments?stage=warehoused', null, buyerCookie);
  assert.equal(warehoused.data.total, 1, 'stage filter narrows the list');
  assert.equal(warehoused.data.countsByStage.warehoused, 1);
  assert.equal(warehoused.data.inTransitTotal, 0, 'warehoused batches are no longer in transit');
  const bySupplier = await raw('GET', '/api/v2/purchase-shipments?q=' + encodeURIComponent('隆基'), null, buyerCookie);
  assert.equal(bySupplier.data.total, 1, 'free-text search matches supplier');
  assert.equal((await raw('GET', '/api/v2/purchase-shipments?q=nothing-here', null, buyerCookie)).data.total, 0, 'search excludes non-matches');

  // ── 附件：真实 PNG 可存，伪造类型被拒 ──
  const upload = await raw('POST', `/api/v2/purchase-shipments/${id}/attachments`, { fileName: 'bl.png', mimeType: 'image/png', data: tinyPng }, buyerCookie);
  assert.equal(upload.status, 201, JSON.stringify(upload.data));
  const forged = await raw('POST', `/api/v2/purchase-shipments/${id}/attachments`, { fileName: 'fake.png', mimeType: 'image/png', data: 'data:image/png;base64,ZXhl' }, buyerCookie);
  assert.equal(forged.status, 400, 'attachment content must match its declared type');

  // ── 店长既不能读也不能写 ──
  assert.equal((await raw('GET', '/api/v2/purchase-shipments', null, managerCookie)).status, 403, 'store manager cannot list shipments');
  assert.equal((await raw('POST', '/api/v2/purchase-shipments', { orderNo: 'X', supplier: 'Y' }, managerCookie)).status, 403, 'store manager cannot create shipments');

  // 未登录一律拒绝
  assert.equal((await raw('GET', '/api/v2/purchase-shipments')).status, 401, 'anonymous cannot list shipments');
  assert.equal((await raw('POST', '/api/v2/purchase-shipments', { orderNo: 'X', supplier: 'Y' })).status, 401, 'anonymous cannot create shipments');
});
