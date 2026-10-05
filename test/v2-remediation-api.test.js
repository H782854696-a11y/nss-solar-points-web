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

test('remediation assignment, reassignment, evidence rounds and review remain scoped', { timeout: 30000 }, async t => {
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
  const created = await request('POST', '/api/v2/workflows', {
    type: 'store_remediation', title: 'Isolated remediation check',
    form: { storeName: 'Test location', issue: 'Broken safety sign', dueDate: '2026-12-31' },
  }, admin);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.item.id;
  assert.equal(created.data.item.assigneeId, null);
  const adminList = await request('GET', '/api/v2/workflows', null, admin);
  assert.equal(adminList.status, 200);
  assert.equal(adminList.data.items.some(item => item.id === id), true, 'administrator can see a newly submitted request');
  assert.equal(adminList.data.pendingForMe, 1, 'administrator can approve the manager request, but not their own request');
  assert.equal(adminList.data.items.find(item => item.id === id).actionableForMe, false, 'own request has no approval action');
  assert.equal(adminList.data.items.find(item => item.id === managerStocktake.data.item.id).actionableForMe, true);
  const adminActionable = await request('GET', '/api/v2/workflows?actionable=1', null, admin);
  assert.equal(adminActionable.status, 200);
  assert.equal(adminActionable.data.total, 1, 'actionable filter excludes the administrator’s own request');
  assert.equal(adminActionable.data.items[0].id, managerStocktake.data.item.id);
  const reviewerList = await request('GET', '/api/v2/workflows', null, reviewer.cookie);
  assert.equal(reviewerList.status, 200);
  assert.equal(reviewerList.data.items.some(item => item.id === id), true, 'Philippines reviewer can see a request in scope');
  assert.equal(reviewerList.data.pendingForMe, 2, 'reviewer has two actionable requests');
  const reviewerActionable = await request('GET', '/api/v2/workflows?actionable=1&limit=1', null, reviewer.cookie);
  assert.equal(reviewerActionable.data.total, 2, 'actionable filter count precedes pagination');
  assert.equal(reviewerActionable.data.items.length, 1);
  assert.equal(reviewerActionable.data.items[0].actionableForMe, true);
  const unassignedSalesList = await request('GET', '/api/v2/workflows', null, salesA.cookie);
  assert.equal(unassignedSalesList.status, 200);
  assert.equal(unassignedSalesList.data.items.some(item => item.id === id), false, 'unassigned store user cannot see a freeform remediation request');
  assert.equal(unassignedSalesList.data.pendingForMe, 0, 'frontline user has no approval permission');
  const approved = await request('POST', `/api/v2/workflows/${id}/actions`, { action: 'approve' }, reviewer.cookie);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.item.status, 'approved');
  const unassignedExecution = await request('POST', `/api/v2/workflows/${id}/actions`, { action: 'execution', executionStatus: 'completed' }, admin);
  assert.equal(unassignedExecution.status, 409);

  const candidates = await request('GET', `/api/v2/workflows/${id}/assignees`, null, reviewer.cookie);
  assert.equal(candidates.status, 200);
  assert.equal(candidates.data.items.some(item => item.id === salesA.id), true);
  const assigned = await request('POST', `/api/v2/workflows/${id}/actions`, { action: 'assign', assigneeId: salesA.id }, reviewer.cookie);
  assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
  assert.equal(assigned.data.item.assigneeId, salesA.id);
  assert.equal(assigned.data.item.executionRound, 1);
  const visible = await request('GET', '/api/v2/workflows', null, salesA.cookie);
  assert.equal(visible.status, 200);
  assert.equal(visible.data.items.some(item => item.id === id), true);
  const upload = async (cookie, evidenceType) => request('POST', `/api/v2/workflows/${id}/attachments`, { fileName: `${evidenceType}.png`, mimeType: 'image/png', data: tinyPng, evidenceType }, cookie);
  assert.equal((await upload(salesA.cookie, 'before')).status, 201);
  assert.equal((await upload(salesA.cookie, 'after')).status, 201);

  const reassigned = await request('POST', `/api/v2/workflows/${id}/actions`, { action: 'assign', assigneeId: salesB.id }, reviewer.cookie);
  assert.equal(reassigned.status, 200, JSON.stringify(reassigned.data));
  assert.equal(reassigned.data.item.executionRound, 2);
  const formerAssigneeList = await request('GET', '/api/v2/workflows', null, salesA.cookie);
  assert.equal(formerAssigneeList.data.items.some(item => item.id === id), false, 'former assignee loses list visibility');
  assert.equal((await upload(salesA.cookie, 'before')).status, 403);
  const staleEvidence = await request('POST', `/api/v2/workflows/${id}/actions`, { action: 'execution', executionStatus: 'completed' }, salesB.cookie);
  assert.equal(staleEvidence.status, 409);
  assert.equal((await upload(salesB.cookie, 'before')).status, 201);
  assert.equal((await upload(salesB.cookie, 'after')).status, 201);
  const executed = await request('POST', `/api/v2/workflows/${id}/actions`, { action: 'execution', executionStatus: 'completed' }, salesB.cookie);
  assert.equal(executed.status, 200, JSON.stringify(executed.data));
  assert.equal(executed.data.item.status, 'awaiting_review');
  const reviewed = await request('POST', `/api/v2/workflows/${id}/actions`, { action: 'review_pass' }, reviewer.cookie);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
  assert.equal(reviewed.data.item.status, 'completed');
});
