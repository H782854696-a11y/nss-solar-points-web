'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const initialPassword = 'LocalOnlyInitialPassword2026!';
const changedPassword = 'LocalOnlyChangedPassword2026!';
const userPassword = 'LocalOnlyUserPassword2026!';
const userChangedPassword = 'LocalOnlyUserChangedPassword2026!';

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

test('store remediation creation and stocktake upload work in the isolated V2 flow', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-v2-remediation-'));
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
  async function request(method, url, body, cookie = '') {
    const response = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
  }
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    try { if ((await request('GET', '/api/health')).status === 200) { ready = true; break; } } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, `isolated server did not start: ${output}`);

  async function loginAndChange(username, oldPassword, newPassword) {
    const login = await request('POST', '/api/auth/login', { username, password: oldPassword });
    assert.equal(login.status, 200, `${username} login: ${JSON.stringify(login.data)}`);
    const changed = await request('POST', '/api/auth/change-password', { currentPassword: oldPassword, newPassword }, login.cookie);
    assert.equal(changed.status, 200, `${username} change password: ${JSON.stringify(changed.data)}`);
    return changed.cookie;
  }
  const admin = await loginAndChange('admin', initialPassword, changedPassword);
  const stores = await request('GET', '/api/stores', null, admin);
  assert.equal(stores.status, 200);
  const storeId = stores.data.items[0].id;
  const organizations = await request('GET', '/api/v2/organizations', null, admin);
  assert.equal(organizations.status, 200);
  assert.equal(organizations.data.items.length > 0, true, 'administrator can see seeded organizations');
  const newTask = await request('POST', '/api/v2/tasks', { title: 'Isolated task list check', storeId }, admin);
  assert.equal(newTask.status, 201, JSON.stringify(newTask.data));
  const taskList = await request('GET', '/api/v2/tasks', null, admin);
  assert.equal(taskList.status, 200);
  assert.equal(taskList.data.items.some(item => item.id === newTask.data.item.id), true, 'administrator can see a newly created task');
  const accounts = [];
  for (const [username, role] of [['v2_ph_reviewer', 'philippines_manager'], ['v2_sales_a', 'sales'], ['v2_sales_b', 'sales']]) {
    const created = await request('POST', '/api/v2/users', { username, name: username, role, storeId: role === 'sales' ? storeId : null, password: userPassword }, admin);
    assert.equal(created.status, 201, `create ${username}: ${JSON.stringify(created.data)}`);
    accounts.push({ id: created.data.item.id, username, cookie: await loginAndChange(username, userPassword, userChangedPassword) });
  }
  const [reviewer, salesA, salesB] = accounts;
  const adminTaskAssignees = await request('GET', '/api/v2/task-assignees', null, admin);
  assert.equal(adminTaskAssignees.status, 200);
  assert.equal(adminTaskAssignees.data.items.length, 0, 'system administrator cannot assign business tasks');
  const reviewerTaskAssignees = await request('GET', '/api/v2/task-assignees', null, reviewer.cookie);
  assert.equal(reviewerTaskAssignees.status, 200);
  assert.equal(reviewerTaskAssignees.data.items.some(item => item.id === salesA.id), true, 'Philippines manager sees an eligible sales assignee');
  const managerAccount = await request('POST', '/api/v2/users', { username: 'v2_store_manager', name: 'v2_store_manager', role: 'manager', storeId, password: userPassword }, admin);
  assert.equal(managerAccount.status, 201, JSON.stringify(managerAccount.data));
  const managerCookie = await loginAndChange('v2_store_manager', userPassword, userChangedPassword);
  const managerStocktake = await request('POST', '/api/v2/workflows', {
    type: 'stocktake', title: 'Store scoped stocktake',
    form: { warehouseName: 'Local count location', countDate: '2026-10-04', reason: 'Isolated scope check', items: [{ itemCode: 'SCOPE-001', countedQuantity: 0 }] },
  }, managerCookie);
  assert.equal(managerStocktake.status, 201, JSON.stringify(managerStocktake.data));
  assert.equal(managerStocktake.data.item.storeId, storeId, 'store manager request is bound to their store');
  const managerWorkflows = await request('GET', '/api/v2/workflows', null, managerCookie);
  assert.equal(managerWorkflows.data.items.some(item => item.id === managerStocktake.data.item.id), true);
  assert.equal(managerWorkflows.data.pendingForMe, 0, 'own application is not a pending approval for the store manager');
  assert.equal(managerWorkflows.data.items.find(item => item.id === managerStocktake.data.item.id).actionableForMe, false);
  const managerTask = await request('POST', '/api/v2/tasks', { title: 'Store scoped task' }, managerCookie);
  assert.equal(managerTask.status, 201, JSON.stringify(managerTask.data));
  assert.equal(managerTask.data.item.storeId, storeId, 'store manager task is bound to their store');
  const managerTasks = await request('GET', '/api/v2/tasks', null, managerCookie);
  assert.equal(managerTasks.data.items.some(item => item.id === managerTask.data.item.id), true);
  const remediation = await request('POST', '/api/v2/workflows', {
    type: 'store_remediation', title: 'Isolated remediation check',
    form: { storeName: 'Test location', issue: 'Broken safety sign', dueDate: '2026-12-31' },
  }, admin);
  assert.equal(remediation.status, 201, JSON.stringify(remediation.data));
  const incomplete = await request('POST', '/api/v2/workflows', {
    type: 'store_remediation', title: 'Missing fields', form: {},
  }, admin);
  assert.equal(incomplete.status, 400, 'required remediation fields remain validated');
  const remediationList = await request('GET', '/api/v2/workflows', null, admin);
  assert.equal(remediationList.data.items.some(item => item.id === remediation.data.item.id), true, 'remediation is visible in the list');

  // 盘点申请不受影响：仍可正常新建并出现在列表中
  // （盘点要求 1–2,000 行明细或上传 Excel，故给一条明细，不能用空 items）
  const stocktakeStillWorks = await request('POST', '/api/v2/workflows', {
    type: 'stocktake', title: 'Stocktake still accepted',
    form: { warehouseName: 'Manila', countDate: '2026-10-05', reason: 'regression', items: [{ itemCode: 'REGRESSION-001', countedQuantity: 0 }] },
  }, admin);
  assert.equal(stocktakeStillWorks.status, 201, JSON.stringify(stocktakeStillWorks.data));
  const afterBlockList = await request('GET', '/api/v2/workflows', null, admin);
  assert.equal(afterBlockList.data.items.some(item => item.id === stocktakeStillWorks.data.item.id), true, 'stocktake remains visible in the list');

  const XLSX = require('../public/xlsx.full.min.js');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['任意列', '自定义标题'], ['逆变器', '货物异常']]), '自定义盘点');
  const spreadsheet = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  const sourceFile = { fileName: '自定义盘点.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${spreadsheet.toString('base64')}` };
  const fileOnly = await request('POST', '/api/v2/workflows', { type: 'stocktake', title: 'Custom sheet without item columns', form: { warehouseName: 'Manila', countDate: '2026-10-05', reason: 'Arbitrary Excel layout', items: [] }, sourceFile }, managerCookie);
  assert.equal(fileOnly.status, 201, JSON.stringify(fileOnly.data));
  assert.deepEqual(fileOnly.data.item.form.items, []);
  assert.equal(fileOnly.data.item.attachments.length, 1);
  assert.equal(fileOnly.data.item.attachments[0].name, sourceFile.fileName);
  const downloaded = await fetch(`${base}/api/v2/workflows/${fileOnly.data.item.id}/attachments/${fileOnly.data.item.attachments[0].id}/download`, { headers: { cookie: managerCookie } });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), spreadsheet);
  for (const [extension, mimeType] of [
    ['xls', 'application/vnd.ms-excel'],
    ['xlsm', 'application/vnd.ms-excel.sheet.macroenabled.12'],
    ['xlsb', 'application/vnd.ms-excel.sheet.binary.macroenabled.12'],
  ]) {
    const file = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: extension }));
    const result = await request('POST', '/api/v2/workflows', {
      type: 'stocktake', title: `Custom ${extension} workbook`,
      form: { warehouseName: 'Manila', countDate: '2026-10-05', reason: 'Arbitrary Excel layout', items: [] },
      sourceFile: { fileName: `自定义盘点.${extension}`, mimeType, data: `data:${mimeType};base64,${file.toString('base64')}` },
    }, managerCookie);
    assert.equal(result.status, 201, `${extension}: ${JSON.stringify(result.data)}`);
    assert.equal(result.data.item.attachments[0].name, `自定义盘点.${extension}`);
  }
  const missingFile = await request('POST', '/api/v2/workflows', { type: 'stocktake', form: { warehouseName: 'Manila', countDate: '2026-10-05', reason: 'No data', items: [] } }, managerCookie);
  assert.equal(missingFile.status, 400);
  const falseExcel = await request('POST', '/api/v2/workflows', { type: 'stocktake', form: { warehouseName: 'Manila', countDate: '2026-10-05', reason: 'Invalid file', items: [] }, sourceFile: { ...sourceFile, data: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,ZXhl' } }, managerCookie);
  assert.equal(falseExcel.status, 400);
});
