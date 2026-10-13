'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startLocalApp } = require('./helpers/local-app');

test('administrator assigns tasks through active employee records without widening task visibility', { timeout: 30000 }, async t => {
  const app = await startLocalApp(); t.after(app.close);
  const admin = await app.login('admin');
  const stores = (await app.request('GET', '/api/stores', null, admin)).data.items;
  const storeId = stores[0].id, employeeStoreId = stores[1]?.id || storeId;
  const createEmployee = name => app.request('POST', '/api/v2/employees', { name, storeId: employeeStoreId }, admin);

  const employee = await createEmployee('All-company task employee');
  assert.equal(employee.status, 201, JSON.stringify(employee.data));
  const account = await app.createPendingThenGrant(admin, {
    username: 'all_company_task_employee', name: 'All-company task employee', employeeId: employee.data.item.id,
    storeId: employeeStoreId, country: 'PH', role: 'sales', password: app.password,
  });
  assert.equal(account.status, 201, JSON.stringify(account.data));

  const unlinked = await createEmployee('Task unlinked');
  const pendingEmployee = await createEmployee('Task pending');
  const pending = await app.request('POST', '/api/v2/users', { username: 'task_pending_employee', name: 'Task pending', employeeId: pendingEmployee.data.item.id, storeId: employeeStoreId, country: 'PH', password: app.password }, admin);
  assert.equal(pending.status, 201, JSON.stringify(pending.data));
  const disabledEmployee = await createEmployee('Task disabled');
  const disabled = await app.createPendingThenGrant(admin, { username: 'task_disabled_employee', name: 'Task disabled', employeeId: disabledEmployee.data.item.id, storeId: employeeStoreId, country: 'PH', role: 'sales', password: app.password });
  assert.equal((await app.request('PUT', `/api/users/${disabled.data.item.id}/status`, { disabled: true }, admin)).status, 200);
  const archivedEmployee = await createEmployee('Task archived');
  assert.equal((await app.request('POST', `/api/v2/employees/${archivedEmployee.data.item.id}/archive`, {}, admin)).status, 200);

  const candidates = await app.request('GET', '/api/v2/task-assignees', null, admin);
  assert.equal(candidates.status, 200);
  const byEmployee = id => candidates.data.items.find(item => item.employeeId === id);
  assert.deepEqual(byEmployee(employee.data.item.id), {
    employeeId: employee.data.item.id, name: 'All-company task employee', departmentName: '', accountId: account.data.item.id, selectable: true, reason: null,
  });
  assert.equal(byEmployee(unlinked.data.item.id).reason, '未关联登录账号');
  assert.equal(byEmployee(pendingEmployee.data.item.id).reason, '关联账号尚未授权');
  assert.equal(byEmployee(disabledEmployee.data.item.id).reason, '关联账号已停用');
  assert.equal(byEmployee(archivedEmployee.data.item.id), undefined, 'archived people are not task candidates');

  const badAccountId = await app.request('POST', '/api/v2/tasks', { title: 'Reject account id', storeId, assigneeId: account.data.item.id }, admin);
  assert.equal(badAccountId.status, 400, 'administrator must submit an employee id, never a login account id');
  const created = await app.request('POST', '/api/v2/tasks', { title: 'Cross-store employee task', storeId, assigneeEmployeeId: employee.data.item.id }, admin);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.item.assigneeId, account.data.item.id);
  const other = await app.request('POST', '/api/v2/tasks', { title: 'Other task stays hidden', storeId }, admin);
  assert.equal(other.status, 201);

  const employeeCookie = await app.login('all_company_task_employee');
  const visible = await app.request('GET', '/api/v2/tasks?limit=50', null, employeeCookie);
  assert.equal(visible.status, 200);
  assert.deepEqual(visible.data.items.map(item => item.id), [created.data.item.id], 'self-scoped assignee sees only the addressed task');
  assert.equal((await app.request('POST', `/api/v2/tasks/${created.data.item.id}/complete`, {}, employeeCookie)).status, 200, 'assignee can complete their own task');
  assert.equal((await app.request('POST', `/api/v2/tasks/${other.data.item.id}/complete`, {}, employeeCookie)).status, 403, 'assignee cannot complete another task');
  const notices = await app.request('GET', '/api/v2/notifications?limit=50', null, employeeCookie);
  assert.equal(notices.data.items.some(item => item.type === 'task.assigned' && item.resourceId === created.data.item.id), true, 'only the linked account receives the in-app task notification');

  const usersFile = path.join(app.dataDir, 'users.json');
  const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  users.push({ ...users.find(user => user.id === account.data.item.id), id: 'duplicate-task-account', username: 'duplicate_task_account' });
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
  const duplicateCandidates = await app.request('GET', '/api/v2/task-assignees', null, admin);
  assert.equal(duplicateCandidates.data.items.find(item => item.employeeId === employee.data.item.id).reason, '关联登录账号不唯一');
  assert.equal((await app.request('POST', '/api/v2/tasks', { title: 'Reject ambiguous employee', storeId, assigneeEmployeeId: employee.data.item.id }, admin)).status, 400);
});
